import { FakePaymentProvider } from "./fake-payment-provider.js";
import { ProviderDeclinedError, ProviderUnavailableError } from "./payment-provider.js";

const USD = (amountMinor: number) => ({ amountMinor, currency: "USD" });

async function authorized(p: FakePaymentProvider, amountMinor = 50_000) {
  const { orderId } = await p.createOrder({ milestoneId: "m1", amount: USD(amountMinor), payeeMerchantId: "SELLER", requestId: "order-m1-1", returnUrl: "http://web/back", cancelUrl: "http://web/cancel", description: "m1" });
  return p.authorizeOrder({ orderId, requestId: `authorize-m1-${orderId}` });
}

const capture = (p: FakePaymentProvider, authorizationId: string, amountMinor: number, final: boolean, seq: number) =>
  p.capture({ authorizationId, amount: USD(amountMinor), platformFee: USD(0), final, invoiceId: `settld-m1-capture-${String(seq)}`, requestId: `capture-m1-${String(seq)}` });

describe("FakePaymentProvider", () => {
  it("captures in parts on one authorization, like the sandbox spike (450 + 50)", async () => {
    const p = new FakePaymentProvider();
    const auth = await authorized(p);
    await capture(p, auth.authorizationId, 45_000, false, 1);
    await capture(p, auth.authorizationId, 5_000, true, 2);
    expect(p.captures.map((c) => c.amountMinor)).toEqual([45_000, 5_000]);
  });

  it("replays a retried request instead of capturing twice", async () => {
    const p = new FakePaymentProvider();
    const auth = await authorized(p);
    const first = await capture(p, auth.authorizationId, 45_000, false, 1);
    const again = await capture(p, auth.authorizationId, 45_000, false, 1);
    expect(again).toEqual(first);
    expect(p.captures).toHaveLength(1);
  });

  it("timeout after apply: the money moved, the answer was lost, and the retry gets the first answer", async () => {
    const p = new FakePaymentProvider();
    const auth = await authorized(p);
    p.failNext("capture", "timeoutAfterApply");
    await expect(capture(p, auth.authorizationId, 45_000, false, 1)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(p.captures).toHaveLength(1);
    await expect(capture(p, auth.authorizationId, 45_000, false, 1)).resolves.toMatchObject({ status: "COMPLETED" });
    expect(p.captures).toHaveLength(1);
  });

  it("a 503 changes nothing, so the retry captures once", async () => {
    const p = new FakePaymentProvider();
    const auth = await authorized(p);
    p.failNext("capture", "unavailable");
    await expect(capture(p, auth.authorizationId, 45_000, false, 1)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(p.captures).toHaveLength(0);
    await capture(p, auth.authorizationId, 45_000, false, 1);
    expect(p.captures).toHaveLength(1);
  });

  it("refuses to capture more than was authorized", async () => {
    const p = new FakePaymentProvider();
    const auth = await authorized(p);
    await capture(p, auth.authorizationId, 45_000, false, 1);
    await expect(capture(p, auth.authorizationId, 5_001, true, 2)).rejects.toMatchObject({ reason: "MAX_CAPTURE_AMOUNT_EXCEEDED" });
  });

  it("refuses to capture after a void, and to void after the final capture (SM-INV-3)", async () => {
    const p = new FakePaymentProvider();
    const a = await authorized(p);
    await p.void({ authorizationId: a.authorizationId, payeeMerchantId: "SELLER", requestId: "void-m1-a" });
    await expect(capture(p, a.authorizationId, 1, false, 1)).rejects.toBeInstanceOf(ProviderDeclinedError);

    const q = new FakePaymentProvider();
    const b = await authorized(q);
    await capture(q, b.authorizationId, 50_000, true, 1);
    await expect(q.void({ authorizationId: b.authorizationId, payeeMerchantId: "SELLER", requestId: "void-m1-b" })).rejects.toBeInstanceOf(ProviderDeclinedError);
  });

  // PayPal sandbox, 2026-10-22 (PP-T16): a void after a partial capture is refused.
  it("refuses a void after a partial capture, and refunds a capture instead", async () => {
    const p = new FakePaymentProvider();
    const a = await authorized(p);
    await capture(p, a.authorizationId, 45_000, false, 1);
    await expect(p.void({ authorizationId: a.authorizationId, payeeMerchantId: "SELLER", requestId: "void-m1-a" })).rejects.toMatchObject({ reason: "PERMISSION_DENIED" });
    const rest = await capture(p, a.authorizationId, 5_000, true, 2);
    await p.refund({ captureId: rest.captureId, amount: USD(5_000), payeeMerchantId: "SELLER", requestId: "return-refund-m1" });
    await p.refund({ captureId: rest.captureId, amount: USD(5_000), payeeMerchantId: "SELLER", requestId: "return-refund-m1" }); // a retry
    expect(p.refunds).toEqual([{ captureId: rest.captureId, amountMinor: 5_000, requestId: "return-refund-m1" }]);
    await expect(p.refund({ captureId: rest.captureId, amount: USD(1), payeeMerchantId: "SELLER", requestId: "return-refund-m1-again" })).rejects.toMatchObject({ reason: "REFUND_EXCEEDED" });
  });

  it("refuses a request id reused for a different request", async () => {
    const p = new FakePaymentProvider();
    const auth = await authorized(p);
    await capture(p, auth.authorizationId, 45_000, false, 1);
    await expect(
      p.capture({ authorizationId: auth.authorizationId, amount: USD(100), platformFee: USD(0), final: false, invoiceId: "x", requestId: "capture-m1-1" }),
    ).rejects.toMatchObject({ reason: "DUPLICATE_REQUEST_ID" });
  });

  it("answers a decline the same way every time it is retried", async () => {
    const p = new FakePaymentProvider();
    const auth = await authorized(p);
    await expect(capture(p, auth.authorizationId, 60_000, true, 1)).rejects.toMatchObject({ reason: "MAX_CAPTURE_AMOUNT_EXCEEDED" });
    await expect(capture(p, auth.authorizationId, 60_000, true, 1)).rejects.toMatchObject({ reason: "MAX_CAPTURE_AMOUNT_EXCEEDED" });
  });

  it("sets the authorization expiry 29 days out and carries the milestone id as custom_id", async () => {
    const p = new FakePaymentProvider();
    p.now = () => new Date("2026-10-18T00:00:00Z");
    const auth = await authorized(p);
    expect(auth.expiresAt.toISOString()).toBe("2026-11-16T00:00:00.000Z");
    expect(auth.customId).toBe("m1");
  });
});
