// Development users. Fixed ids so curl examples and e2e tests can use them directly with
// X-Settld-Dev-User. The web app cannot act as them; signing up with Clerk using the same
// email links the account to the seeded row (ADR-0006).
export const DEV_USERS = [
  { id: "00000000-0000-7000-8000-00000000c11e", email: "buyer@dev.settld.app", displayName: "Carla Buyer", roles: ["BUYER"], paypalMerchantId: null },
  // H1-G2: a seller must have PayPal connected to accept. With PAYPAL_SANDBOX_SELLER_MERCHANT_ID
  // set, Fede is the spike's sandbox Business account, so funding his milestones works on the
  // real sandbox (ADR-0007); without it, a placeholder that only the fake PayPal accepts.
  { id: "00000000-0000-7000-8000-0000000f7ee1", email: "seller@dev.settld.app", displayName: "Fede Seller", roles: ["SELLER"], paypalMerchantId: process.env.PAYPAL_SANDBOX_SELLER_MERCHANT_ID ?? "SANDBOX-PLACEHOLDER" },
  { id: "00000000-0000-7000-8000-00000000ad31", email: "admin@dev.settld.app", displayName: "Ada Admin", roles: ["ADMIN"], paypalMerchantId: null },
];

// Seeded users skip onboarding (DM-INV-8): they stand in for people who already finished it,
// so curl examples and the demo work without clicking through PayPal.
export function asOnboarded<T extends { paypalMerchantId: string | null }>(u: T) {
  return { ...u, onboardingCompletedAt: new Date(), paypalPaymentsReceivable: u.paypalMerchantId !== null };
}
