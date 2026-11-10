// A PayPal stand-in with PayPal's money rules, used by the tests and by local runs without a
// sandbox app (ADR-0007, roadmap H2). It is strict on purpose: if the state machine asks it
// to capture more than is authorized, capture after a void, or reuse a request id for a
// different call, it refuses the way PayPal would, so those bugs fail in tests first.
//
// It can also misbehave on demand: slow answers, 5xx, declines, and the nastiest one, a lost
// answer after the money already moved ("timeout after apply").
import { randomUUID } from "node:crypto";
import type { Money } from "../contracts/snapshot.js";
import { ProviderDeclinedError, ProviderUnavailableError } from "./payment-provider.js";
import type { Authorization, Capture, PaymentProvider } from "./payment-provider.js";

export type Operation = "createOrder" | "authorizeOrder" | "capture" | "void" | "refund";
// pending: PayPal accepts the capture but answers PENDING; settlePending decides it later.
export type Fault = "unavailable" | "declined" | "timeoutAfterApply" | "pending";

// PayPal: an authorization is valid 29 days.
const AUTHORIZATION_DAYS = 29;

interface FakeAuthorization {
  readonly id: string;
  readonly amount: Money;
  readonly customId: string;
  captured: number;
  status: "CREATED" | "PARTIALLY_CAPTURED" | "CAPTURED" | "VOIDED";
}

interface Order {
  readonly id: string;
  readonly milestoneId: string;
  readonly amount: Money;
  readonly payeeMerchantId: string;
  authorizationId: string | null;
}

export class FakePaymentProvider implements PaymentProvider {
  readonly orders = new Map<string, Order>();
  readonly authorizations = new Map<string, FakeAuthorization>();
  // What actually happened at "PayPal": the tests count these, not the calls.
  readonly captures: { authorizationId: string; amountMinor: number; final: boolean; requestId: string }[] = [];
  readonly voids: { authorizationId: string; requestId: string }[] = [];
  readonly refunds: { captureId: string; amountMinor: number; requestId: string }[] = [];
  private readonly captureAmounts = new Map<string, { amountMinor: number; refunded: number }>();
  readonly calls: { op: Operation; requestId: string }[] = [];

  private readonly replies = new Map<string, { fingerprint: string; reply: unknown }>();
  private readonly pendingCaptures = new Map<string, "PENDING" | "COMPLETED" | "DECLINED">();
  private readonly faults: { op: Operation; fault: Fault }[] = [];
  latencyMs = 0;
  private pendingNext = false;
  now: () => Date = () => new Date();

  // The next call to `op` fails with `fault`. Queued in order; each one is used once.
  failNext(op: Operation, fault: Fault): void {
    this.faults.push({ op, fault });
  }

  // PayPal finally settles every capture it answered PENDING.
  settlePending(status: "COMPLETED" | "DECLINED"): void {
    for (const id of this.pendingCaptures.keys()) this.pendingCaptures.set(id, status);
  }

  // PayPal reserves a different amount than the order said (a bug, or a tampered order).
  tamperOrderAmount(orderId: string, amountMinor: number): void {
    const order = this.orders.get(orderId);
    if (order === undefined) throw new Error(`No order ${orderId}`);
    this.orders.set(orderId, { ...order, amount: { ...order.amount, amountMinor } });
  }

  refund(input: { captureId: string; amount: Money; payeeMerchantId: string; requestId: string }): Promise<void> {
    return this.call("refund", input.requestId, input, () => {
      const cap = this.captureAmounts.get(input.captureId);
      if (cap === undefined) throw new ProviderDeclinedError(`Capture ${input.captureId} not found`, "RESOURCE_NOT_FOUND");
      if (cap.refunded + input.amount.amountMinor > cap.amountMinor) throw new ProviderDeclinedError("Refund exceeds the captured amount", "REFUND_EXCEEDED");
      cap.refunded += input.amount.amountMinor;
      this.refunds.push({ captureId: input.captureId, amountMinor: input.amount.amountMinor, requestId: input.requestId });
      return undefined;
    });
  }

  // Tests set this to say what PayPal answers about an authorization.
  authorizationStatus = "EXPIRED";

  getAuthorizationStatus(): Promise<string> {
    if (this.authorizationStatus === "REFUSED") return Promise.reject(new ProviderDeclinedError("PayPal refused the read", "RESOURCE_NOT_FOUND"));
    return Promise.resolve(this.authorizationStatus);
  }

  getCapture(captureId: string): Promise<Capture> {
    const status = this.pendingCaptures.get(captureId) ?? "COMPLETED";
    if (status === "DECLINED") return Promise.reject(new ProviderDeclinedError(`Capture ${captureId} was declined`, "DECLINED"));
    return Promise.resolve({ captureId, status });
  }

  createOrder(input: { milestoneId: string; amount: Money; payeeMerchantId: string; requestId: string; returnUrl: string; cancelUrl: string; description: string }): Promise<{ orderId: string; approveUrl: string }> {
    return this.call("createOrder", input.requestId, input, () => {
      const order: Order = { id: `ORDER-${randomUUID().slice(0, 8)}`, milestoneId: input.milestoneId, amount: input.amount, payeeMerchantId: input.payeeMerchantId, authorizationId: null };
      this.orders.set(order.id, order);
      // No PayPal page to visit: the "approval" sends the buyer straight back, as PayPal would.
      return { orderId: order.id, approveUrl: `${input.returnUrl}?token=${order.id}&PayerID=FAKEPAYER` };
    });
  }

  authorizeOrder(input: { orderId: string; requestId: string }): Promise<Authorization> {
    return this.call("authorizeOrder", input.requestId, input, () => {
      const order = this.orders.get(input.orderId);
      if (order === undefined) throw new ProviderDeclinedError(`Order ${input.orderId} not found`, "RESOURCE_NOT_FOUND");
      if (order.authorizationId !== null) throw new ProviderDeclinedError(`Order ${input.orderId} already authorized`, "ORDER_ALREADY_AUTHORIZED");
      const auth: FakeAuthorization = { id: `AUTH-${randomUUID().slice(0, 8)}`, amount: order.amount, customId: order.milestoneId, captured: 0, status: "CREATED" };
      this.authorizations.set(auth.id, auth);
      order.authorizationId = auth.id;
      const now = this.now();
      return {
        authorizationId: auth.id,
        status: "CREATED" as const,
        amount: auth.amount,
        customId: auth.customId,
        payeeMerchantId: order.payeeMerchantId,
        authorizedAt: now,
        expiresAt: new Date(now.getTime() + AUTHORIZATION_DAYS * 86_400_000),
      };
    });
  }

  capture(input: { authorizationId: string; amount: Money; platformFee: Money; final: boolean; invoiceId: string; requestId: string }): Promise<Capture> {
    return this.call("capture", input.requestId, input, () => {
      const auth = this.authorizations.get(input.authorizationId);
      if (auth === undefined) throw new ProviderDeclinedError(`Authorization ${input.authorizationId} not found`, "RESOURCE_NOT_FOUND");
      if (auth.status === "CAPTURED" || auth.status === "VOIDED") throw new ProviderDeclinedError(`Authorization is ${auth.status}`, "AUTHORIZATION_ALREADY_COMPLETED");
      if (input.amount.currency !== auth.amount.currency) throw new ProviderDeclinedError("Currency mismatch", "CURRENCY_MISMATCH");
      if (auth.captured + input.amount.amountMinor > auth.amount.amountMinor) throw new ProviderDeclinedError("Capture exceeds the authorized amount", "MAX_CAPTURE_AMOUNT_EXCEEDED");
      auth.captured += input.amount.amountMinor;
      auth.status = input.final ? "CAPTURED" : "PARTIALLY_CAPTURED";
      this.captures.push({ authorizationId: auth.id, amountMinor: input.amount.amountMinor, final: input.final, requestId: input.requestId });
      const captureId = `CAPTURE-${randomUUID().slice(0, 8)}`;
      this.captureAmounts.set(captureId, { amountMinor: input.amount.amountMinor, refunded: 0 });
      if (this.pendingNext) {
        this.pendingCaptures.set(captureId, "PENDING");
        return { captureId, status: "PENDING" as const };
      }
      return { captureId, status: "COMPLETED" as const };
    });
  }

  void(input: { authorizationId: string; payeeMerchantId: string; requestId: string }): Promise<void> {
    return this.call("void", input.requestId, input, () => {
      const auth = this.authorizations.get(input.authorizationId);
      if (auth === undefined) throw new ProviderDeclinedError(`Authorization ${input.authorizationId} not found`, "RESOURCE_NOT_FOUND");
      if (auth.status === "CAPTURED" || auth.status === "VOIDED") throw new ProviderDeclinedError(`Authorization is ${auth.status}`, "AUTHORIZATION_ALREADY_COMPLETED");
      // What the sandbox answered on 2026-10-22 (PP-T16).
      if (auth.status === "PARTIALLY_CAPTURED") throw new ProviderDeclinedError("Void after a partial capture is not permitted", "PERMISSION_DENIED");
      auth.status = "VOIDED";
      this.voids.push({ authorizationId: auth.id, requestId: input.requestId });
      return undefined;
    });
  }

  // PayPal's idempotency: the same PayPal-Request-Id with the same body gets the first answer,
  // whether that answer was a success or a refusal. The same id with a different body is a
  // client bug, and PayPal refuses it.
  private async call<T>(op: Operation, requestId: string, body: unknown, apply: () => T): Promise<T> {
    this.calls.push({ op, requestId });
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const faultAt = this.faults.findIndex((f) => f.op === op);
    const fault = faultAt === -1 ? undefined : this.faults.splice(faultAt, 1)[0]?.fault;
    if (fault === "unavailable") throw new ProviderUnavailableError(`PayPal answered 503 to ${op}`);
    this.pendingNext = fault === "pending";
    if (fault === "declined") throw new ProviderDeclinedError(`PayPal declined ${op}`, "INSTRUMENT_DECLINED");

    const fingerprint = JSON.stringify([op, body]);
    const seen = this.replies.get(requestId);
    if (seen !== undefined) {
      if (seen.fingerprint !== fingerprint) throw new ProviderDeclinedError(`PayPal-Request-Id ${requestId} reused for a different request`, "DUPLICATE_REQUEST_ID");
      return replay(seen.reply) as T;
    }
    let reply: unknown;
    try {
      reply = { ok: apply() };
    } catch (error) {
      if (!(error instanceof ProviderDeclinedError)) throw error;
      reply = { declined: error };
    }
    this.replies.set(requestId, { fingerprint, reply });
    // The money moved, but the answer never reaches us.
    if (fault === "timeoutAfterApply") throw new ProviderUnavailableError(`${op} timed out after PayPal applied it`);
    return replay(reply) as T;
  }
}

function replay(reply: unknown): unknown {
  const r = reply as { ok?: unknown; declined?: ProviderDeclinedError };
  if (r.declined !== undefined) throw r.declined;
  return r.ok;
}
