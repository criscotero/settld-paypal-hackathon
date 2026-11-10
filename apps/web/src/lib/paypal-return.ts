// PayPal opens in its own tab (onboarding wizard), so the Settld tab is never lost. When PayPal
// sends that tab back, the return route lands it on /onboarding/paypal/done, which tells the
// waiting Settld tab the outcome over a BroadcastChannel and closes itself.
//
// BroadcastChannel and not window.opener: the wizard cuts the opener (see goToPaypal), so a page
// PayPal shows in that tab cannot navigate the Settld tab. The channel is same-origin only, so
// nothing outside localhost:3000 can post to it.

export const PAYPAL_CHANNEL = "settld-paypal";

// The keys of the onboarding page's notices. Only these travel in the URL and over the
// channel; anything else is dropped, so a crafted ?paypal= cannot put text on the page.
export const PAYPAL_OUTCOMES = ["linked", "seller-connected", "seller-pending", "seller-limited", "cancelled", "state-mismatch", "link-failed", "done"] as const;
export type PaypalOutcome = (typeof PAYPAL_OUTCOMES)[number];

export function isPaypalOutcome(value: unknown): value is PaypalOutcome {
  return typeof value === "string" && (PAYPAL_OUTCOMES as readonly string[]).includes(value);
}

// What POST /me/connections/paypal:onboard-complete means for the seller. 409 is PayPal not
// having confirmed the merchant yet; any other failure is a failed link.
export function sellerOutcome(status: number, data: { onboarding: { completed: boolean }; paypalReady: boolean } | undefined): PaypalOutcome {
  if (data === undefined) return status === 409 ? "seller-pending" : "link-failed";
  if (data.onboarding.completed) return "done";
  return data.paypalReady ? "seller-connected" : "seller-limited";
}

export const donePath = (outcome: PaypalOutcome) => `/onboarding/paypal/done?paypal=${outcome}`;
export const onboardingPath = (outcome: PaypalOutcome, next?: string) => `/onboarding?paypal=${outcome}${next === undefined ? "" : `&next=${encodeURIComponent(next)}`}`;
