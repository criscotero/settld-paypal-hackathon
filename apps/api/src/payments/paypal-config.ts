// PayPal settings, validated at startup. Missing credentials are allowed (tests, a local run
// without a sandbox app): PayPal-backed endpoints then answer 503 instead of the API not booting.

export interface PaypalConfig {
  readonly apiBase: string;
  readonly webBase: string;
  readonly clientId: string;
  readonly clientSecret: string;
  // Merchant id of the platform's own PayPal account: the partner in partner-referral lookups.
  readonly partnerMerchantId: string | undefined;
}

// The PayPal website for this environment, or null without credentials (the fake provider). Kept
// apart from PaypalConfig so the ledger can build links without holding the client secret.
export const PAYPAL_WEB_BASE = Symbol("PAYPAL_WEB_BASE");

type Env = Readonly<Record<string, string | undefined>>;

const ENVIRONMENTS = {
  sandbox: { apiBase: "https://api-m.sandbox.paypal.com", webBase: "https://www.sandbox.paypal.com" },
  live: { apiBase: "https://api-m.paypal.com", webBase: "https://www.paypal.com" },
} as const;

export function loadPaypalConfig(env: Env): PaypalConfig | null {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  if (clientId === undefined || clientId === "" || clientSecret === undefined || clientSecret === "") return null;
  const name = env.PAYPAL_ENV ?? "sandbox";
  if (name !== "sandbox" && name !== "live") throw new Error(`PAYPAL_ENV must be "sandbox" or "live", got ${JSON.stringify(name)}`);
  const partner = env.PAYPAL_PARTNER_MERCHANT_ID;
  return { ...ENVIRONMENTS[name], clientId, clientSecret, partnerMerchantId: partner === undefined || partner === "" ? undefined : partner };
}
