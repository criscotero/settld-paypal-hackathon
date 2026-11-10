import { Logger } from "@nestjs/common";
import { ProblemException } from "../errors/problem.js";
import type { LinkedPaypalAccount, PaypalAccounts, SellerStatus } from "./paypal-accounts.js";
import type { PaypalConfig } from "./paypal-config.js";

const TIMEOUT_MS = 15_000;

type UserInfo = { payer_id?: string; user_id?: string; email?: string; emails?: { value: string; primary?: boolean }[] };

function idTokenClaims(idToken: string | undefined): UserInfo | null {
  const payload = idToken?.split(".")[1];
  if (payload === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown; email?: unknown };
    return { ...(typeof claims.sub === "string" ? { user_id: claims.sub } : {}), ...(typeof claims.email === "string" ? { email: claims.email } : {}) };
  } catch {
    return null;
  }
}

function unavailable(detail: string): ProblemException {
  return new ProblemException("PAYPAL_UNAVAILABLE", 503, "PayPal is not responding", detail);
}

// PayPal REST calls for onboarding. Every response's paypal-debug-id is logged: it is the
// only thing PayPal support can trace a failed call with (paypal-integration.md, section 1).
export class HttpPaypalAccounts implements PaypalAccounts {
  private readonly log = new Logger("PayPal");
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: PaypalConfig) {}

  async createSellerReferral(trackingId: string, returnUrl: string, requestId: string): Promise<string> {
    const body = {
      tracking_id: trackingId,
      partner_config_override: { return_url: returnUrl, return_url_description: "Back to Settld" },
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "PAYPAL",
              integration_type: "THIRD_PARTY",
              // PARTNER_FEE now, so the platform fee can be taken at capture later (Q-PP-4).
              third_party_details: { features: ["PAYMENT", "REFUND", "PARTNER_FEE"] },
            },
          },
        },
      ],
      products: ["EXPRESS_CHECKOUT"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
    };
    const res = await this.call<{ links?: { rel: string; href: string }[] }>("POST", "/v2/customer/partner-referrals", { body, requestId });
    const link = res?.links?.find((l) => l.rel === "action_url")?.href;
    if (link === undefined) throw new Error("PayPal partner referral returned no action_url");
    return link;
  }

  async findSeller(trackingId: string): Promise<SellerStatus | null> {
    const partner = this.config.partnerMerchantId;
    if (partner === undefined) throw unavailable("PAYPAL_PARTNER_MERCHANT_ID is not set, so seller onboarding cannot be confirmed.");
    const base = `/v1/customer/partners/${encodeURIComponent(partner)}/merchant-integrations`;
    const found = await this.call<{ merchant_id?: string }>("GET", `${base}?tracking_id=${encodeURIComponent(trackingId)}`, { notFoundIsNull: true });
    if (found === null || found.merchant_id === undefined) return null;
    const status = await this.call<{ payments_receivable?: boolean }>("GET", `${base}/${encodeURIComponent(found.merchant_id)}`);
    return { merchantId: found.merchant_id, paymentsReceivable: status?.payments_receivable === true };
  }

  loginUrl(state: string, redirectUri: string): string {
    const url = new URL("/signin/authorize", this.config.webBase);
    url.search = new URLSearchParams({ flowEntry: "static", client_id: this.config.clientId, response_type: "code", scope: "openid email", redirect_uri: redirectUri, state }).toString();
    return url.toString();
  }

  async exchangeLoginCode(code: string): Promise<LinkedPaypalAccount> {
    // The user's token is used once, right here, and never stored (DM-INV-6).
    const tokenRes = await this.fetchJson("/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${this.basic()}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code }).toString(),
    });
    if (tokenRes.status >= 400 && tokenRes.status < 500) {
      throw new ProblemException("VALIDATION_FAILED", 422, "PayPal did not accept the sign-in", "The PayPal sign-in expired or was already used. Try connecting again.");
    }
    const tokens = tokenRes.json as { access_token?: string; id_token?: string } | null;
    const userToken = tokens?.access_token;
    if (userToken === undefined) throw unavailable("PayPal returned no access token.");
    // Two userinfo shapes. paypalv1.1 carries payer_id and an emails list, but PayPal sandbox
    // answers it with 400 "Unable to fetch details" depending on which attributes the app has
    // enabled. The OpenID shape (user_id, email) always works with openid+email. Settld only
    // needs a stable id for "this PayPal account is linked" and the email for the receipt, so
    // payer_id is preferred and user_id, PayPal's subject id for the account, is the fallback.
    // Last, the id_token from the same token response: with the openid scope it carries sub (the
    // same id as user_id) and email. Its signature is not checked, and need not be: it came
    // straight from PayPal's token endpoint over TLS in this call, not through the browser
    // (OpenID Connect Core 1.0, section 3.1.3.7). userinfo can fail when the app asks for an
    // attribute the token does not cover; the id_token does not depend on those attributes.
    let body = await this.userinfo(userToken, "paypalv1.1");
    body ??= await this.userinfo(userToken, "openid");
    body ??= idTokenClaims(tokens?.id_token);
    const id = body?.payer_id ?? body?.user_id;
    if (id === undefined) {
      // Field names only, never values: they say what the PayPal app is not sharing.
      this.log.warn(`userinfo has no account id; fields: ${Object.keys(body ?? {}).join(", ") || "none"}; token response fields: ${Object.keys(tokens ?? {}).join(", ")}`);
      throw unavailable("PayPal returned no account id.");
    }
    const email = body?.emails?.find((e) => e.primary === true)?.value ?? body?.emails?.[0]?.value ?? body?.email ?? null;
    return { payerId: id, email };
  }

  private async userinfo(userToken: string, schema: "paypalv1.1" | "openid"): Promise<UserInfo | null> {
    const res = await this.fetchJson(`/v1/identity/oauth2/userinfo?schema=${schema}`, { method: "GET", headers: { Authorization: `Bearer ${userToken}` } });
    if (res.status < 400) return res.json as UserInfo | null;
    // An error body is PayPal's own words (error, error_description), never the user's data.
    this.log.warn(`userinfo (${schema}) -> ${String(res.status)} ${JSON.stringify(res.json)}`);
    return null;
  }

  // ---------------------------------------------------------------- plumbing

  private basic(): string {
    return Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
  }

  private async accessToken(): Promise<string> {
    // Cached until 60 s before expiry: one token call per ~9 hours instead of one per request.
    if (this.token !== null && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await this.fetchJson("/v1/oauth2/token", {
      method: "POST",
      headers: { Authorization: `Basic ${this.basic()}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const json = res.json as { access_token?: string; expires_in?: number } | null;
    if (res.status !== 200 || json?.access_token === undefined) throw unavailable(`PayPal token request failed (HTTP ${String(res.status)}).`);
    this.token = { value: json.access_token, expiresAt: Date.now() + ((json.expires_in ?? 600) - 60) * 1000 };
    return json.access_token;
  }

  private async call<T>(method: string, path: string, opts: { body?: unknown; requestId?: string; notFoundIsNull?: boolean } = {}): Promise<T | null> {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" };
    // Deterministic per caller attempt (constitution III): a retried request replays PayPal's answer.
    if (opts.requestId !== undefined) headers["PayPal-Request-Id"] = opts.requestId;
    const res = await this.fetchJson(path, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
    if (res.status === 404 && opts.notFoundIsNull === true) return null;
    if (res.status >= 400) {
      this.log.warn(`${method} ${path} -> ${String(res.status)} ${JSON.stringify(res.json)}`);
      throw unavailable(`PayPal answered HTTP ${String(res.status)} (debug id ${res.debugId ?? "none"}).`);
    }
    return res.json as T;
  }

  private async fetchJson(path: string, init: RequestInit): Promise<{ status: number; json: unknown; debugId: string | null }> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.config.apiBase), { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw unavailable("Could not reach PayPal.");
    }
    const debugId = res.headers.get("paypal-debug-id");
    this.log.debug(`${init.method ?? "GET"} ${path.split("?")[0] ?? path} -> ${String(res.status)} (debug id ${debugId ?? "none"})`);
    if (res.status >= 500) throw unavailable(`PayPal answered HTTP ${String(res.status)} (debug id ${debugId ?? "none"}).`);
    const text = await res.text();
    return { status: res.status, json: text === "" ? null : (JSON.parse(text) as unknown), debugId };
  }
}
