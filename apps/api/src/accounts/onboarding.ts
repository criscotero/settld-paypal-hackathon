// DM-INV-8: when is a user done with onboarding, and what is the first step still missing.
// Pure functions over the User row, so the rule is tested without a database.

export type OnboardingStep = "ROLES" | "PROFILE" | "PAYPAL" | "DONE";

export interface OnboardingFacts {
  readonly roles: readonly string[];
  readonly fullName: string | null;
  readonly country: string | null;
  readonly accountType: string | null;
  readonly businessName: string | null;
  readonly termsAcceptedAt: Date | null;
  readonly paypalPayerId: string | null;
  readonly paypalMerchantId: string | null;
  readonly paypalPaymentsReceivable: boolean;
}

export function paypalLinked(u: OnboardingFacts): boolean {
  return u.paypalPayerId !== null;
}

// A merchant id alone is not enough: PayPal can know the merchant but still refuse to pay it
// (email not confirmed, account limited). Only payments_receivable means money can arrive.
export function paypalReady(u: OnboardingFacts): boolean {
  return u.paypalMerchantId !== null && u.paypalPaymentsReceivable;
}

export function nextOnboardingStep(u: OnboardingFacts): OnboardingStep {
  const buyer = u.roles.includes("BUYER");
  // A collaborator is paid by PayPal like a seller, so it needs the same partner onboarding:
  // without it PayPal refuses to authorize in their name (PAYEE_NOT_CONSENTED, ADR-0009).
  const seller = u.roles.includes("SELLER") || u.roles.includes("COLLABORATOR");
  if (!buyer && !seller) return "ROLES";
  const profileDone =
    u.fullName !== null && u.country !== null && u.termsAcceptedAt !== null && (u.accountType === "INDIVIDUAL" || (u.accountType === "BUSINESS" && u.businessName !== null));
  if (!profileDone) return "PROFILE";
  // Each role brings its own PayPal requirement; a user with both roles needs both.
  if ((buyer && !paypalLinked(u)) || (seller && !paypalReady(u))) return "PAYPAL";
  return "DONE";
}
