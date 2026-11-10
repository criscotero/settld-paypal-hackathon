// Port for the PayPal calls that move money (ADR-0007; paypal-integration.md, section 3).
// Only the payments module holds an implementation (SM-INV-4). H2 binds a fake; the real
// PayPal adapter comes later behind this same interface, so the state machine never changes.
//
// Every write takes a requestId: the PayPal-Request-Id. It is derived from what is being done
// (capture-{milestoneId}-{releaseSeq}), never from when, so a retry is the same request and
// PayPal answers it with the first result instead of moving money twice (constitution III).
import type { Money } from "../contracts/snapshot.js";

export interface Authorization {
  readonly authorizationId: string;
  readonly status: "CREATED";
  readonly amount: Money;
  // The order's custom_id: G-AUTH-MATCHES compares it with the milestone id.
  readonly customId: string;
  // The order's payee, when PayPal returns it: G-AUTH-MATCHES checks it against the hold's
  // payeeMerchantId (ADR-0009). null when the response omits it.
  readonly payeeMerchantId: string | null;
  readonly authorizedAt: Date;
  readonly expiresAt: Date;
}

export interface Capture {
  readonly captureId: string;
  // PENDING: PayPal accepted it but has not settled it; a webhook or reconciliation finishes it.
  readonly status: "COMPLETED" | "PENDING";
}

export interface PaymentProvider {
  // Intent AUTHORIZE, one purchase unit paid to the seller (constitution I: never to Settld).
  // approveUrl is where the buyer approves at PayPal; PayPal then sends them to returnUrl.
  createOrder(input: {
    milestoneId: string;
    amount: Money;
    payeeMerchantId: string;
    requestId: string;
    returnUrl: string;
    cancelUrl: string;
    description: string;
  }): Promise<{ orderId: string; approveUrl: string }>;
  authorizeOrder(input: { orderId: string; requestId: string }): Promise<Authorization>;
  // final=false keeps the rest of the authorization open for a later release.
  capture(input: { authorizationId: string; amount: Money; platformFee: Money; final: boolean; invoiceId: string; requestId: string }): Promise<Capture>;
  // Returns what is still authorized to the buyer. Irreversible. payeeMerchantId: the account
  // the money was authorized for; PayPal only lets the platform void or refund on behalf of a
  // payee that is named in a PayPal-Auth-Assertion header (sandbox, 2026-10-22, PP-T13).
  void(input: { authorizationId: string; payeeMerchantId: string; requestId: string }): Promise<void>;
  // Gives a capture back to the buyer. Used to return the held amount after a partial capture,
  // when PayPal refuses a void (PP-T16): capture the rest as final, then refund it.
  refund(input: { captureId: string; amount: Money; payeeMerchantId: string; requestId: string }): Promise<void>;
  // Follows up a capture PayPal answered PENDING (paypal-integration.md, 3.4). Throws
  // ProviderDeclinedError when PayPal declined it after all.
  getCapture(captureId: string): Promise<Capture>;
  // What PayPal says about an authorization. Read before calling one lapsed (SM-T17): the timer
  // knows the date, and only PayPal knows whether it was captured or voided meanwhile.
  getAuthorizationStatus(authorizationId: string): Promise<string>;
}

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");

// PayPal did not answer, answered 5xx, or the network dropped. The operation may or may not
// have happened, so the only safe retry is the same request with the same requestId.
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
  }
}

// PayPal answered and refused (4xx, DECLINED). Retrying the same request gets the same refusal;
// a person has to look (paypal-integration.md: CAPTURE_FAILED raises an admin alert).
export class ProviderDeclinedError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "ProviderDeclinedError";
  }
}
