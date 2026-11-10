// The adapter against a scripted fetch: what it sends to PayPal, and how it reads PayPal's
// answers. The live sandbox run is in scripts/ (it needs a person to approve the order).
import { fromPaypalValue, HttpPaymentProvider, toPaypalValue } from "./http-payment-provider.js";
import { ProviderDeclinedError, ProviderUnavailableError } from "./payment-provider.js";

const config = { apiBase: "https://api-m.sandbox.paypal.com", webBase: "https://www.sandbox.paypal.com", clientId: "id", clientSecret: "secret", partnerMerchantId: undefined };
const USD = (amountMinor: number) => ({ amountMinor, currency: "USD" });

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function scripted(...answers: (Response | Error)[]) {
  const sent: Sent[] = [];
  const queue = [new Response(JSON.stringify({ access_token: "T", expires_in: 32_400 }), { status: 200 }), ...answers];
  vi.stubGlobal("fetch", (url: URL, init: RequestInit) => {
    sent.push({ url: String(url), method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init.body });
    const next = queue.shift();
    if (next === undefined) throw new Error("unexpected fetch");
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return sent;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "paypal-debug-id": "dbg-1" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PayPal amounts (constitution V)", () => {
  it("formats and parses without floats", () => {
    expect(toPaypalValue(USD(45_000))).toBe("450.00");
    expect(toPaypalValue(USD(5))).toBe("0.05");
    expect(toPaypalValue({ amountMinor: 1_500, currency: "JPY" })).toBe("1500");
    expect(fromPaypalValue("450.00", "USD")).toBe(45_000);
    expect(fromPaypalValue("0.5", "USD")).toBe(50);
    expect(() => fromPaypalValue("1.005", "USD")).toThrow();
    expect(() => fromPaypalValue("1e3", "USD")).toThrow();
  });
});

describe("HttpPaymentProvider", () => {
  // Sandbox, 2026-10-22: a refund on a seller's capture is 403 PERMISSION_DENIED without this
  // header, and 201 with it.
  it("refunds and voids on behalf of the payee with PayPal-Auth-Assertion", async () => {
    const sent = scripted(json(201, { id: "REF-1", status: "COMPLETED" }));
    await new HttpPaymentProvider(config).refund({ captureId: "CAP-1", amount: USD(1_500), payeeMerchantId: "QNAQNCF87LSCY", requestId: "return-refund-m1" });
    const header = sent[1]?.headers["PayPal-Auth-Assertion"] ?? "";
    const [head, payload, signature] = header.split(".");
    expect(JSON.parse(Buffer.from(head ?? "", "base64url").toString())).toEqual({ alg: "none" });
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({ iss: "id", payer_id: "QNAQNCF87LSCY" });
    expect(signature).toBe("");
    expect(sent[1]?.body).toEqual({ amount: { currency_code: "USD", value: "15.00" } });
  });

  it("does not send PayPal-Auth-Assertion on a capture (the sandbox captures without it)", async () => {
    const sent = scripted(json(201, { id: "CAP-1", status: "COMPLETED" }));
    await new HttpPaymentProvider(config).capture({ authorizationId: "A", amount: USD(100), platformFee: USD(0), final: true, invoiceId: "i", requestId: "r" });
    expect(sent[1]?.headers["PayPal-Auth-Assertion"]).toBeUndefined();
  });

  it("creates an AUTHORIZE order paid to the seller, with our id in custom_id and the return URL", async () => {
    const sent = scripted(json(200, { id: "ORDER-1", links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" }] }));
    const out = await new HttpPaymentProvider(config).createOrder({ milestoneId: "m1", amount: USD(50_000), payeeMerchantId: "SELLER1", requestId: "order-m1-1", returnUrl: "http://web/back", cancelUrl: "http://web/cancel", description: "Shop · Checkout" });
    expect(out).toEqual({ orderId: "ORDER-1", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-1" });
    const call = sent[1];
    expect(call?.headers["PayPal-Request-Id"]).toBe("order-m1-1");
    expect(call?.body).toMatchObject({
      intent: "AUTHORIZE",
      purchase_units: [{ custom_id: "m1", amount: { currency_code: "USD", value: "500.00" }, payee: { merchant_id: "SELLER1" } }],
      payment_source: { paypal: { experience_context: { return_url: "http://web/back", cancel_url: "http://web/cancel" } } },
    });
  });

  it("reads the authorization: amount in minor units, custom_id and expiry", async () => {
    scripted(json(201, { purchase_units: [{ payments: { authorizations: [{ id: "AUTH-1", status: "CREATED", amount: { currency_code: "USD", value: "500.00" }, custom_id: "m1", create_time: "2026-10-18T10:00:00Z", expiration_time: "2026-11-16T10:00:00Z" }] } }] }));
    const auth = await new HttpPaymentProvider(config).authorizeOrder({ orderId: "ORDER-1", requestId: "authorize-m1-ORDER-1" });
    expect(auth).toMatchObject({ authorizationId: "AUTH-1", amount: { amountMinor: 50_000, currency: "USD" }, customId: "m1" });
    expect(auth.expiresAt.toISOString()).toBe("2026-11-16T10:00:00.000Z");
  });

  it("captures part of the authorization and sends the fee only when there is one", async () => {
    const sent = scripted(json(201, { id: "CAP-1", status: "COMPLETED" }), json(201, { id: "CAP-2", status: "COMPLETED" }));
    const p = new HttpPaymentProvider(config);
    await p.capture({ authorizationId: "AUTH-1", amount: USD(45_000), platformFee: USD(0), final: false, invoiceId: "settld-m1-capture-1", requestId: "capture-m1-1" });
    await p.capture({ authorizationId: "AUTH-1", amount: USD(5_000), platformFee: USD(250), final: true, invoiceId: "settld-m1-capture-2", requestId: "capture-m1-2" });
    expect(sent[1]?.body).toEqual({ amount: { currency_code: "USD", value: "450.00" }, final_capture: false, invoice_id: "settld-m1-capture-1" });
    expect(sent[2]?.body).toMatchObject({ final_capture: true, payment_instruction: { platform_fees: [{ amount: { value: "2.50" } }] } });
    expect(sent[2]?.headers["PayPal-Request-Id"]).toBe("capture-m1-2");
  });

  it("a 4xx is a decline with PayPal's issue code, so the job does not retry it", async () => {
    scripted(json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "AUTHORIZATION_ALREADY_CAPTURED" }] }));
    await expect(new HttpPaymentProvider(config).capture({ authorizationId: "A", amount: USD(1), platformFee: USD(0), final: true, invoiceId: "i", requestId: "r" })).rejects.toMatchObject({
      constructor: ProviderDeclinedError,
      reason: "AUTHORIZATION_ALREADY_CAPTURED",
    });
  });

  it("a DECLINED capture is a decline too", async () => {
    scripted(json(201, { id: "CAP-1", status: "DECLINED", status_details: { reason: "BUYER_COMPLAINT" } }));
    await expect(new HttpPaymentProvider(config).capture({ authorizationId: "A", amount: USD(1), platformFee: USD(0), final: true, invoiceId: "i", requestId: "r" })).rejects.toMatchObject({ reason: "BUYER_COMPLAINT" });
  });

  // Review attack 1: these used to be declines, so a capture was marked FAILED for good.
  it("429 and PREVIOUS_REQUEST_IN_PROGRESS are transient, not declines", async () => {
    scripted(json(429, { name: "RATE_LIMIT_REACHED" }));
    await expect(new HttpPaymentProvider(config).void({ authorizationId: "A", payeeMerchantId: "SELLER1", requestId: "r" })).rejects.toBeInstanceOf(ProviderUnavailableError);
    scripted(json(422, { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "PREVIOUS_REQUEST_IN_PROGRESS" }] }));
    await expect(new HttpPaymentProvider(config).void({ authorizationId: "A", payeeMerchantId: "SELLER1", requestId: "r" })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("a 401 refreshes the token once and repeats the request", async () => {
    const sent = scripted(json(401, { error: "invalid_token" }), new Response(JSON.stringify({ access_token: "T2", expires_in: 32_400 }), { status: 200 }), json(201, { id: "CAP-1", status: "COMPLETED" }));
    const out = await new HttpPaymentProvider(config).capture({ authorizationId: "A", amount: USD(100), platformFee: USD(0), final: true, invoiceId: "i", requestId: "capture-m1-1" });
    expect(out.status).toBe("COMPLETED");
    expect(sent.map((r) => r.url.split("/v")[1])).toEqual(["1/oauth2/token", "2/payments/authorizations/A/capture", "1/oauth2/token", "2/payments/authorizations/A/capture"]);
    expect(sent[3]?.headers.Authorization).toBe("Bearer T2");
  });

  it("a 5xx or a dropped connection is 'unavailable', so the job retries with the same key", async () => {
    scripted(json(503, {}));
    await expect(new HttpPaymentProvider(config).void({ authorizationId: "A", payeeMerchantId: "SELLER1", requestId: "void-m1-A" })).rejects.toBeInstanceOf(ProviderUnavailableError);
    scripted(new TypeError("fetch failed"));
    await expect(new HttpPaymentProvider(config).void({ authorizationId: "A", payeeMerchantId: "SELLER1", requestId: "void-m1-A" })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
