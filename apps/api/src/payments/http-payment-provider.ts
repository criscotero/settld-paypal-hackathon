// PaymentProvider against PayPal's REST API (paypal-integration.md, sections 2 and 3; ADR-0007).
// The same calls the sandbox spike proved on 2026-10-17: an AUTHORIZE order paid to the
// seller's merchant id, then partial captures on its authorization, or a void.
//
// Error mapping is the whole point of this file:
//   - PayPal answered a 4xx that will not change, or DECLINED: ProviderDeclinedError. Retrying
//     the same request gets the same refusal, so the state machine records the decline.
//   - No answer, timeout, 5xx, 429, PREVIOUS_REQUEST_IN_PROGRESS, or a 401 that survives one
//     token refresh: ProviderUnavailableError. The operation may still happen, so the job
//     retries with the SAME PayPal-Request-Id and PayPal replays its first answer.
import { Logger } from "@nestjs/common";
import type { Money } from "../contracts/snapshot.js";
import { ProviderDeclinedError, ProviderUnavailableError } from "./payment-provider.js";
import type { Authorization, Capture, PaymentProvider } from "./payment-provider.js";
import type { PaypalConfig } from "./paypal-config.js";

const TIMEOUT_MS = 15_000;

// PayPal-Auth-Assertion: an unsigned JWT (alg "none") naming the app (iss) and the merchant the
// platform acts for (payer_id). Unsigned is what PayPal specifies; it is not a credential, the
// OAuth token is. It only says on whose behalf.
export function authAssertion(clientId: string, merchantId: string): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ iss: clientId, payer_id: merchantId })}.`;
}

// 4xx answers that mean "try again later", not "no" (H2 review, attack 1).
const TRANSIENT_ISSUES = new Set(["PREVIOUS_REQUEST_IN_PROGRESS", "RATE_LIMIT_REACHED"]);

// ISO 4217 minor-unit exponents PayPal cares about; everything else has two decimals.
const ZERO_DECIMAL = new Set(["JPY", "HUF", "TWD"]);

// 45000 USD minor units -> "450.00", with integer and string arithmetic only (constitution V).
export function toPaypalValue(money: Money): string {
  if (ZERO_DECIMAL.has(money.currency)) return String(money.amountMinor);
  const digits = String(money.amountMinor).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

// "450.00" -> 45000. Refuses anything that is not a plain decimal: a surprise format from
// PayPal must stop G-AUTH-MATCHES, not be rounded into agreement.
export function fromPaypalValue(value: string, currency: string): number {
  const decimals = ZERO_DECIMAL.has(currency) ? 0 : 2;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (m === null || (m[2] ?? "").length > decimals) throw new Error(`Unexpected PayPal amount ${JSON.stringify(value)} ${currency}`);
  return Number(m[1]) * 10 ** decimals + Number((m[2] ?? "").padEnd(decimals, "0") || "0");
}

interface PaypalLink {
  rel: string;
  href: string;
}
interface PaypalAmount {
  currency_code: string;
  value: string;
}
interface PaypalAuthorization {
  id: string;
  status: string;
  amount: PaypalAmount;
  custom_id?: string;
  create_time: string;
  expiration_time: string;
}

export class HttpPaymentProvider implements PaymentProvider {
  private readonly log = new Logger("PayPalPayments");
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: PaypalConfig) {}

  async createOrder(input: { milestoneId: string; amount: Money; payeeMerchantId: string; requestId: string; returnUrl: string; cancelUrl: string; description: string }) {
    const order = await this.call<{ id: string; links?: PaypalLink[] }>("POST", "/v2/checkout/orders", input.requestId, {
      intent: "AUTHORIZE",
      purchase_units: [
        {
          reference_id: input.milestoneId,
          // G-AUTH-MATCHES compares this with the milestone when the buyer comes back.
          custom_id: input.milestoneId,
          invoice_id: `settld-${input.requestId}`,
          description: input.description.slice(0, 127),
          amount: { currency_code: input.amount.currency, value: toPaypalValue(input.amount) },
          // Constitution I: paid to the seller, never to Settld.
          payee: { merchant_id: input.payeeMerchantId },
        },
      ],
      payment_source: { paypal: { experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: "CONTINUE", shipping_preference: "NO_SHIPPING" } } },
    });
    const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
    if (approveUrl === undefined) throw new ProviderUnavailableError("PayPal returned an order without an approval link");
    return { orderId: order.id, approveUrl };
  }

  async authorizeOrder(input: { orderId: string; requestId: string }): Promise<Authorization> {
    const order = await this.call<{ purchase_units?: { payee?: { merchant_id?: string }; payments?: { authorizations?: PaypalAuthorization[] } }[] }>(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(input.orderId)}/authorize`,
      input.requestId,
      {},
    );
    const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (auth === undefined) throw new ProviderUnavailableError("PayPal authorized the order but returned no authorization");
    if (auth.status !== "CREATED") throw new ProviderDeclinedError(`Authorization ${auth.id} is ${auth.status}`, `AUTHORIZATION_${auth.status}`);
    return {
      authorizationId: auth.id,
      status: "CREATED",
      amount: { amountMinor: fromPaypalValue(auth.amount.value, auth.amount.currency_code), currency: auth.amount.currency_code },
      customId: auth.custom_id ?? "",
      payeeMerchantId: order.purchase_units?.[0]?.payee?.merchant_id ?? null,
      authorizedAt: new Date(auth.create_time),
      expiresAt: new Date(auth.expiration_time),
    };
  }

  async capture(input: { authorizationId: string; amount: Money; platformFee: Money; final: boolean; invoiceId: string; requestId: string }): Promise<Capture> {
    const res = await this.call<{ id: string; status: string; status_details?: { reason?: string } }>(
      "POST",
      `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/capture`,
      input.requestId,
      {
        amount: { currency_code: input.amount.currency, value: toPaypalValue(input.amount) },
        final_capture: input.final,
        invoice_id: input.invoiceId,
        // Fee only on capture, and only when there is one (paypal-integration.md, 3.2).
        ...(input.platformFee.amountMinor > 0
          ? { payment_instruction: { platform_fees: [{ amount: { currency_code: input.platformFee.currency, value: toPaypalValue(input.platformFee) } }] } }
          : {}),
      },
    );
    if (res.status === "COMPLETED" || res.status === "PENDING") return { captureId: res.id, status: res.status };
    throw new ProviderDeclinedError(`Capture ${res.id} is ${res.status}`, res.status_details?.reason ?? res.status);
  }

  async void(input: { authorizationId: string; payeeMerchantId: string; requestId: string }): Promise<void> {
    await this.call("POST", `/v2/payments/authorizations/${encodeURIComponent(input.authorizationId)}/void`, input.requestId, undefined, false, input.payeeMerchantId);
  }

  async refund(input: { captureId: string; amount: Money; payeeMerchantId: string; requestId: string }): Promise<void> {
    await this.call(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(input.captureId)}/refund`,
      input.requestId,
      { amount: { currency_code: input.amount.currency, value: toPaypalValue(input.amount) } },
      false,
      input.payeeMerchantId,
    );
  }

  async getCapture(captureId: string): Promise<Capture> {
    const res = await this.call<{ id: string; status: string; status_details?: { reason?: string } }>("GET", `/v2/payments/captures/${encodeURIComponent(captureId)}`, null, undefined);
    if (res.status === "COMPLETED" || res.status === "PENDING") return { captureId: res.id, status: res.status };
    throw new ProviderDeclinedError(`Capture ${res.id} is ${res.status}`, res.status_details?.reason ?? res.status);
  }

  async getAuthorizationStatus(authorizationId: string): Promise<string> {
    const res = await this.call<{ status: string }>("GET", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}`, null, undefined);
    return res.status;
  }

  // ---------------------------------------------------------------- plumbing

  private async accessToken(): Promise<string> {
    // Cached until 60 s before expiry: one token call per ~9 hours, not one per request.
    if (this.token !== null && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.send("/v1/oauth2/token", { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    const json = res.json as { access_token?: string; expires_in?: number } | null;
    if (res.status !== 200 || json?.access_token === undefined) throw new ProviderUnavailableError(`PayPal token request failed (HTTP ${String(res.status)})`);
    this.token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 600) - 60) * 1000 };
    return json.access_token;
  }

  // requestId null for reads, which PayPal does not deduplicate and do not need it.
  // actingFor: the payee's merchant id, sent as PayPal-Auth-Assertion. Without it PayPal answers
  // 403 PERMISSION_DENIED to a refund on a seller's capture (sandbox, 2026-10-22).
  private async call<T>(method: string, path: string, requestId: string | null, body: unknown, tokenRefreshed = false, actingFor?: string): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      // Full resource in the answer, so a replayed request returns everything we read.
      Prefer: "return=representation",
      ...(requestId === null ? {} : { "PayPal-Request-Id": requestId }),
      ...(actingFor === undefined ? {} : { "PayPal-Auth-Assertion": authAssertion(this.config.clientId, actingFor) }),
    };
    const res = await this.send(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.status === 401 && !tokenRefreshed) {
      // The cached token was revoked or expired early. Same request, same requestId, new token.
      this.token = null;
      return this.call<T>(method, path, requestId, body, true, actingFor);
    }
    if (res.status >= 400) {
      const issue = (res.json as { details?: { issue?: string }[]; name?: string } | null)?.details?.[0]?.issue ?? (res.json as { name?: string } | null)?.name ?? `HTTP_${String(res.status)}`;
      this.log.warn(`${method} ${path} -> ${String(res.status)} ${issue} (debug id ${res.debugId ?? "none"})`);
      if (res.status === 401 || res.status === 429 || TRANSIENT_ISSUES.has(issue)) throw new ProviderUnavailableError(`PayPal asked to retry ${method} ${path} later: ${issue}`);
      throw new ProviderDeclinedError(`PayPal refused ${method} ${path}: ${issue}`, issue);
    }
    return res.json as T;
  }

  private async send(path: string, init: RequestInit): Promise<{ status: number; json: unknown; debugId: string | null }> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.config.apiBase), { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new ProviderUnavailableError(`Could not reach PayPal for ${path}`);
    }
    // paypal-debug-id is the only thing PayPal support can trace a call with.
    const debugId = res.headers.get("paypal-debug-id");
    this.log.debug(`${init.method ?? "GET"} ${path} -> ${String(res.status)} (debug id ${debugId ?? "none"})`);
    if (res.status >= 500) throw new ProviderUnavailableError(`PayPal answered HTTP ${String(res.status)} for ${path} (debug id ${debugId ?? "none"})`);
    const text = await res.text();
    return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown), debugId };
  }
}
