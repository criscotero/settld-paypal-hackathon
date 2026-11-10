// Onboarding (ADR-0006, DM-INV-8): roles, identification data and the PayPal links.
//
// Every write locks the user row, applies the change, and recomputes the next step in the same
// transaction, so "onboarding completed" is set exactly once even if two steps finish at the
// same moment (two tabs, a double click). PayPal is always called before the transaction opens:
// a row lock held across a 15-second network call would block every other request of that user.
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Actor } from "../audit/actor.js";
import { recordAudit } from "../audit/audit.js";
import { APP_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import { reviewerApplications, users } from "../db/schema.js";
import type { AccountType, Profession } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { PAYPAL_ACCOUNTS } from "../payments/paypal-accounts.js";
import type { PaypalAccounts } from "../payments/paypal-accounts.js";
import { nextOnboardingStep, paypalLinked, paypalReady } from "./onboarding.js";
import { applicationStatusView } from "./reviewer-applications.js";

type UserRow = typeof users.$inferSelect;

export interface ProfileInput {
  readonly fullName: string;
  readonly displayName: string;
  readonly country: string;
  readonly locale: "en" | "es";
  readonly accountType: AccountType;
  readonly businessName: string | null;
}

// openapi.yaml: ProfessionalProfile (ADR-0009)
export interface ProfessionalInput {
  readonly headline: string | null;
  readonly professions: readonly Profession[];
  readonly skills: readonly string[];
  readonly bio: string | null;
  readonly link: string | null;
  readonly inDirectory: boolean;
}

export interface OnboardingCaller {
  readonly userId: string;
  readonly requestId: string;
}

const actorOf = (c: OnboardingCaller): Actor => ({ type: "USER", id: c.userId });

// openapi.yaml: components.schemas.User
export function userView(u: UserRow) {
  const completed = u.onboardingCompletedAt !== null;
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    roles: u.roles,
    locale: u.locale,
    paypalReady: paypalReady(u),
    paypalLinked: paypalLinked(u),
    paypalEmail: u.paypalEmail,
    githubConnected: false, // GitHub connection arrives in Phase 3
    profile: {
      fullName: u.fullName,
      country: u.country,
      accountType: u.accountType,
      businessName: u.businessName,
      termsAcceptedAt: u.termsAcceptedAt?.toISOString() ?? null,
    },
    professional: { headline: u.headline, professions: u.professions, skills: u.skills, bio: u.bio, link: u.link, inDirectory: u.inDirectory },
    // Grandfathered users (DM-INV-8) are complete even if some facts are missing.
    onboarding: { completed, nextStep: completed ? "DONE" : nextOnboardingStep(u) },
  };
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYPAL_ACCOUNTS) private readonly paypal: PaypalAccounts,
  ) {}

  async me(userId: string) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (u === undefined) throw new Error(`User ${userId} vanished after authentication`);
    const [application] = await this.db.select().from(reviewerApplications).where(eq(reviewerApplications.userId, userId));
    return { ...userView(u), reviewerApplication: application === undefined ? null : applicationStatusView(application) };
  }

  setRoles(caller: OnboardingCaller, chosen: readonly ("BUYER" | "SELLER" | "COLLABORATOR")[]) {
    return this.mutate(caller, "user.roles.set", (u) => {
      // Roles decide which PayPal links are required; changing them after onboarding would
      // silently reopen it. MVP: chosen once, during onboarding.
      if (u.onboardingCompletedAt !== null) {
        throw new ProblemException("INVALID_TRANSITION", 409, "Roles are already set", "Roles can only be chosen during onboarding.");
      }
      // REVIEWER and ADMIN are granted by Settld, never self-assigned, and survive this call.
      const staff = u.roles.filter((r) => r === "REVIEWER" || r === "ADMIN");
      return { roles: [...staff, ...new Set(chosen)] };
    });
  }

  setProfile(caller: OnboardingCaller, p: ProfileInput) {
    return this.mutate(caller, "user.profile.set", (u) => ({
      fullName: p.fullName,
      displayName: p.displayName,
      country: p.country,
      locale: p.locale,
      accountType: p.accountType,
      businessName: p.accountType === "BUSINESS" ? p.businessName : null,
      // Constitution XIII: the first acceptance is the one on record; editing the profile
      // later does not move it.
      termsAcceptedAt: u.termsAcceptedAt ?? new Date(),
    }));
  }

  // Optional and editable any time, not part of DM-INV-8: what a seller or collaborator does
  // and whether they can be found (ADR-0009).
  setProfessional(caller: OnboardingCaller, p: ProfessionalInput) {
    return this.mutate(caller, "user.professional.set", () => ({
      headline: p.headline,
      professions: [...p.professions],
      skills: [...p.skills],
      bio: p.bio,
      link: p.link,
      inDirectory: p.inDirectory,
      professionalUpdatedAt: new Date(),
    }));
  }

  async startSellerOnboarding(caller: OnboardingCaller, idempotencyKey: string) {
    await this.requireRole(caller.userId, "SELLER", "Only sellers and collaborators connect PayPal to receive payments.");
    const url = await this.paypal.createSellerReferral(caller.userId, `${this.config.webUrl}/onboarding/paypal/seller-return`, `referral-${caller.userId}-${idempotencyKey}`);
    return { url };
  }

  async completeSellerOnboarding(caller: OnboardingCaller) {
    await this.requireRole(caller.userId, "SELLER", "Only sellers and collaborators connect PayPal to receive payments.");
    // Asked by tracking_id = our user id: the merchant id PayPal put in the return URL could
    // have been typed by anyone, so it is never read.
    const seller = await this.paypal.findSeller(caller.userId);
    if (seller === null) {
      throw new ProblemException("PAYPAL_NOT_CONNECTED", 409, "PayPal has not confirmed your account yet", "Finish the steps on PayPal, then come back. It can take a minute.");
    }
    return this.mutate(caller, "user.paypal.seller_connected", () => ({ paypalMerchantId: seller.merchantId, paypalPaymentsReceivable: seller.paymentsReceivable }));
  }

  async startPaypalLogin(caller: OnboardingCaller, state: string) {
    await this.requireRole(caller.userId, "BUYER", "Only buyers link a PayPal account this way.");
    return { url: this.paypal.loginUrl(state, `${this.config.webUrl}/onboarding/paypal/callback`) };
  }

  async completePaypalLogin(caller: OnboardingCaller, code: string) {
    await this.requireRole(caller.userId, "BUYER", "Only buyers link a PayPal account this way.");
    const account = await this.paypal.exchangeLoginCode(code);
    return this.mutate(caller, "user.paypal.buyer_linked", () => ({ paypalPayerId: account.payerId, paypalEmail: account.email }));
  }

  // ---------------------------------------------------------------- internals

  // "SELLER" means "is paid by PayPal": a collaborator connects PayPal exactly like a seller.
  private async requireRole(userId: string, role: "BUYER" | "SELLER", detail: string) {
    const [u] = await this.db.select({ roles: users.roles }).from(users).where(eq(users.id, userId));
    const allowed = role === "SELLER" ? ["SELLER", "COLLABORATOR"] : [role];
    if (u === undefined || !u.roles.some((r) => allowed.includes(r))) throw new ProblemException("FORBIDDEN", 403, "Not available for your role", detail);
  }

  private mutate(caller: OnboardingCaller, action: string, change: (u: UserRow) => Partial<typeof users.$inferInsert>) {
    return this.db.transaction(async (tx) => {
      const before = await this.lock(tx, caller.userId);
      const patch = change(before);
      const [after] = await tx.update(users).set(patch).where(eq(users.id, caller.userId)).returning();
      if (after === undefined) throw new Error("update returned nothing");
      await recordAudit(tx, { actor: actorOf(caller), action, entityType: "User", entityId: caller.userId, after: patch, requestId: caller.requestId });

      if (after.onboardingCompletedAt === null && nextOnboardingStep(after) === "DONE") {
        const [done] = await tx.update(users).set({ onboardingCompletedAt: new Date() }).where(eq(users.id, caller.userId)).returning();
        if (done === undefined) throw new Error("update returned nothing");
        await recordAudit(tx, { actor: actorOf(caller), action: "user.onboarding.completed", entityType: "User", entityId: caller.userId, requestId: caller.requestId });
        return userView(done);
      }
      return userView(after);
    });
  }

  private async lock(tx: Tx, userId: string): Promise<UserRow> {
    const [u] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (u === undefined) throw new Error(`User ${userId} vanished after authentication`);
    return u;
  }
}
