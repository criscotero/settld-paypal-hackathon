// Port for the PayPal calls onboarding needs (ADR-0006). The payments module owns PayPal
// credentials (paypal-integration.md, SM-INV-4); accounts only sees this interface, and tests
// bind a fake so no test talks to PayPal.

export interface SellerStatus {
  readonly merchantId: string;
  // PayPal's payments_receivable: false means PayPal knows the merchant but will not pay it yet.
  readonly paymentsReceivable: boolean;
}

export interface LinkedPaypalAccount {
  readonly payerId: string;
  readonly email: string | null;
}

export interface PaypalAccounts {
  // Partner referral (FR-101). trackingId is our User.id, so PayPal can tell us later which
  // merchant finished onboarding for which user without trusting anything in the return URL.
  createSellerReferral(trackingId: string, returnUrl: string, requestId: string): Promise<string>;
  findSeller(trackingId: string): Promise<SellerStatus | null>;
  // Log in with PayPal (OpenID Connect, authorization code flow).
  loginUrl(state: string, redirectUri: string): string;
  exchangeLoginCode(code: string): Promise<LinkedPaypalAccount>;
}

export const PAYPAL_ACCOUNTS = Symbol("PAYPAL_ACCOUNTS");
