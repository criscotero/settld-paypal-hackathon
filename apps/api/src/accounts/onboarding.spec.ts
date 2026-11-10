import { nextOnboardingStep } from "./onboarding.js";
import type { OnboardingFacts } from "./onboarding.js";

const fresh: OnboardingFacts = {
  roles: [],
  fullName: null,
  country: null,
  accountType: null,
  businessName: null,
  termsAcceptedAt: null,
  paypalPayerId: null,
  paypalMerchantId: null,
  paypalPaymentsReceivable: false,
};
const profile = { fullName: "Ana Ríos", country: "CO", accountType: "INDIVIDUAL", termsAcceptedAt: new Date() } as const;
const buyerLink = { paypalPayerId: "PAYER123" } as const;
const sellerLink = { paypalMerchantId: "MERCHANT1", paypalPaymentsReceivable: true } as const;

describe("nextOnboardingStep (DM-INV-8)", () => {
  it("starts with roles", () => {
    expect(nextOnboardingStep(fresh)).toBe("ROLES");
  });

  it("ignores REVIEWER and ADMIN: they are not marketplace roles", () => {
    expect(nextOnboardingStep({ ...fresh, roles: ["ADMIN"] })).toBe("ROLES");
  });

  it("asks for the profile once a role is chosen", () => {
    expect(nextOnboardingStep({ ...fresh, roles: ["BUYER"] })).toBe("PROFILE");
  });

  it("treats a business without a business name as an unfinished profile", () => {
    expect(nextOnboardingStep({ ...fresh, roles: ["BUYER"], ...profile, accountType: "BUSINESS" })).toBe("PROFILE");
    expect(nextOnboardingStep({ ...fresh, roles: ["BUYER"], ...profile, accountType: "BUSINESS", businessName: "Ríos SAS", ...buyerLink })).toBe("DONE");
  });

  it("requires the buyer link for buyers and the seller onboarding for sellers", () => {
    expect(nextOnboardingStep({ ...fresh, roles: ["BUYER"], ...profile })).toBe("PAYPAL");
    expect(nextOnboardingStep({ ...fresh, roles: ["BUYER"], ...profile, ...buyerLink })).toBe("DONE");
    expect(nextOnboardingStep({ ...fresh, roles: ["SELLER"], ...profile, ...sellerLink })).toBe("DONE");
  });

  it("does not accept a seller merchant id that PayPal says cannot receive payments", () => {
    expect(nextOnboardingStep({ ...fresh, roles: ["SELLER"], ...profile, paypalMerchantId: "M1", paypalPaymentsReceivable: false })).toBe("PAYPAL");
  });

  // ADR-0009: PayPal refuses to authorize for a payee who did not consent through partner
  // referrals (PAYEE_NOT_CONSENTED), so a collaborator needs the same link as a seller.
  it("treats a collaborator like a seller: partner onboarding with payments receivable", () => {
    expect(nextOnboardingStep({ ...fresh, roles: ["COLLABORATOR"] })).toBe("PROFILE");
    expect(nextOnboardingStep({ ...fresh, roles: ["COLLABORATOR"], ...profile })).toBe("PAYPAL");
    expect(nextOnboardingStep({ ...fresh, roles: ["COLLABORATOR"], ...profile, ...sellerLink })).toBe("DONE");
  });

  it("needs both links when the user has both roles", () => {
    const both = { ...fresh, roles: ["BUYER", "SELLER"], ...profile };
    expect(nextOnboardingStep({ ...both, ...buyerLink })).toBe("PAYPAL");
    expect(nextOnboardingStep({ ...both, ...sellerLink })).toBe("PAYPAL");
    expect(nextOnboardingStep({ ...both, ...buyerLink, ...sellerLink })).toBe("DONE");
  });
});
