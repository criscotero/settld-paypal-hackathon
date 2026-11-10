// Port between authentication and wherever users live. H1 binds it to the
// `User` table with Drizzle; tests bind an in-memory list.
import type { IdentityProfile } from "./identity-provider.js";

export type Role = "BUYER" | "SELLER" | "REVIEWER" | "ADMIN"; // domain-model.md: User.roles

// Only what authorization needs. The full User (email, locale, PayPal) is read
// by the accounts module, not carried on every request.
export interface AuthenticatedUser {
  readonly id: string;
  readonly roles: readonly Role[];
  // DM-INV-8: contract writes refuse users who have not finished onboarding.
  readonly onboarded: boolean;
}

export interface UserDirectory {
  findById(id: string): Promise<AuthenticatedUser | null>;
  // ADR-0006: the user behind a Clerk subject, created on its first request. Must stay a
  // single row when two first requests race.
  findOrProvision(subject: string, loadProfile: () => Promise<IdentityProfile>): Promise<AuthenticatedUser>;
}

// Interfaces vanish at runtime, so Nest needs a value to inject by.
export const USER_DIRECTORY = Symbol("USER_DIRECTORY");
