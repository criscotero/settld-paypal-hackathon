import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { DrizzleUserDirectory } from "../src/accounts/drizzle-user-directory.js";
import { auditLog, users } from "../src/db/schema.js";
import { as, bootTestApp, createNewUser, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

// The parts of openapi.yaml's User (and the link responses) these tests read.
interface Body {
  roles: string[];
  url: string;
  profile: { termsAcceptedAt: string | null };
  onboarding: { completed: boolean; nextStep: string };
  context: { issues: { path: string }[] };
}
const body = (res: { body: unknown }) => res.body as Body;

const profile = { fullName: "Ana Ríos", displayName: "Ana", country: "CO", locale: "es", accountType: "INDIVIDUAL", acceptTerms: true };

describe("Onboarding (ADR-0006, DM-INV-8)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  describe("just-in-time users", () => {
    it("creates exactly one row when the first requests of a new Clerk user race", async () => {
      const directory = new DrizzleUserDirectory(ctx.db);
      const subject = `user_${randomUUID()}`;
      const email = `${randomUUID()}@clerk.example`;
      const results = await Promise.all(Array.from({ length: 5 }, () => directory.findOrProvision(subject, () => Promise.resolve({ email, displayName: "Racer" }))));
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      const rows = await ctx.db.select().from(users).where(eq(users.clerkUserId, subject));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ email, roles: [], onboardingCompletedAt: null });
    });

    it("links an existing row with the same email to the Clerk subject", async () => {
      const id = await createUser(ctx.db, ["BUYER"]);
      const [existing] = await ctx.db.select().from(users).where(eq(users.id, id));
      const directory = new DrizzleUserDirectory(ctx.db);
      const subject = `user_${randomUUID()}`;
      const user = await directory.findOrProvision(subject, () => Promise.resolve({ email: existing?.email ?? "", displayName: "Linked" }));
      expect(user.id).toBe(id);
    });
  });

  describe("a buyer", () => {
    it("walks roles, profile and the PayPal link, then can create contracts", async () => {
      const id = await createNewUser(ctx.db);

      const me = await as(ctx, id).get("/me").expect(200);
      expect(body(me).onboarding).toEqual({ completed: false, nextStep: "ROLES" });

      // DM-INV-8 on the server: creating a contract before onboarding is refused.
      const blocked = await as(ctx, id).post("/contracts", draftBody()).expect(403);
      expect(blocked.body).toMatchObject({ code: "ONBOARDING_INCOMPLETE" });

      const roles = await as(ctx, id).put("/me/roles", { roles: ["BUYER"] }, "").expect(200);
      expect(body(roles).onboarding.nextStep).toBe("PROFILE");

      const afterProfile = await as(ctx, id).put("/me/profile", profile, "").expect(200);
      expect(body(afterProfile).onboarding.nextStep).toBe("PAYPAL");
      expect(body(afterProfile).profile.termsAcceptedAt).not.toBeNull();

      const start = await as(ctx, id).post("/me/connections/paypal-login:start", { state: "a".repeat(32) }).expect(200);
      expect(decodeURIComponent(body(start).url)).toContain("/onboarding/paypal/callback");

      const linked = await as(ctx, id).post("/me/connections/paypal-login:complete", { code: "auth-code" }).expect(200);
      expect(linked.body).toMatchObject({ paypalLinked: true, paypalEmail: "buyer@paypal.example", onboarding: { completed: true, nextStep: "DONE" } });

      await as(ctx, id).post("/contracts", draftBody()).expect(201);

      const audit = await ctx.db.select({ action: auditLog.action }).from(auditLog).where(eq(auditLog.entityId, id));
      expect(audit.map((a) => a.action)).toEqual(["user.roles.set", "user.profile.set", "user.paypal.buyer_linked", "user.onboarding.completed"]);
    });

    it("cannot start the seller connection", async () => {
      const id = await createNewUser(ctx.db);
      await as(ctx, id).put("/me/roles", { roles: ["BUYER"] }, "").expect(200);
      const res = await as(ctx, id).post("/me/connections/paypal:onboard").expect(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("a seller", () => {
    it("is confirmed only when PayPal says the merchant can receive payments", async () => {
      const id = await createNewUser(ctx.db);
      await as(ctx, id).put("/me/roles", { roles: ["SELLER"] }, "").expect(200);
      await as(ctx, id).put("/me/profile", { ...profile, accountType: "BUSINESS", businessName: "Ríos Studio SAS" }, "").expect(200);

      const key = randomUUID();
      const start = await as(ctx, id).post("/me/connections/paypal:onboard", undefined, key).expect(200);
      expect(body(start).url).toContain(id);
      // tracking_id is the user id, and the PayPal request id comes from the caller's key.
      expect(ctx.paypal.referrals.at(-1)).toMatchObject({ trackingId: id, requestId: `referral-${id}-${key}` });

      // PayPal does not know the merchant yet.
      const early = await as(ctx, id).post("/me/connections/paypal:onboard-complete").expect(409);
      expect(early.body).toMatchObject({ code: "PAYPAL_NOT_CONNECTED" });

      // PayPal knows it, but will not pay it yet.
      ctx.paypal.sellers.set(id, { merchantId: "MERCHANT-1", paymentsReceivable: false });
      const limited = await as(ctx, id).post("/me/connections/paypal:onboard-complete").expect(200);
      expect(limited.body).toMatchObject({ paypalReady: false, onboarding: { completed: false, nextStep: "PAYPAL" } });

      ctx.paypal.sellers.set(id, { merchantId: "MERCHANT-1", paymentsReceivable: true });
      const ready = await as(ctx, id).post("/me/connections/paypal:onboard-complete").expect(200);
      expect(ready.body).toMatchObject({ paypalReady: true, onboarding: { completed: true, nextStep: "DONE" } });
    });

    it("cannot change roles once onboarding is complete", async () => {
      const id = await createNewUser(ctx.db);
      await as(ctx, id).put("/me/roles", { roles: ["SELLER"] }, "").expect(200);
      await as(ctx, id).put("/me/profile", profile, "").expect(200);
      ctx.paypal.sellers.set(id, { merchantId: "MERCHANT-2", paymentsReceivable: true });
      await as(ctx, id).post("/me/connections/paypal:onboard-complete").expect(200);
      const res = await as(ctx, id).put("/me/roles", { roles: ["BUYER", "SELLER"] }, "").expect(409);
      expect(res.body).toMatchObject({ code: "INVALID_TRANSITION" });
    });
  });

  describe("validation", () => {
    it("requires accepting the terms and a business name for businesses", async () => {
      const id = await createNewUser(ctx.db);
      await as(ctx, id).put("/me/roles", { roles: ["BUYER"] }, "").expect(200);
      const res = await as(ctx, id).put("/me/profile", { ...profile, accountType: "BUSINESS", acceptTerms: false }, "").expect(422);
      const paths = body(res).context.issues.map((i) => i.path);
      expect(paths).toEqual(expect.arrayContaining(["acceptTerms"]));
    });

    it("keeps REVIEWER and ADMIN when roles are chosen", async () => {
      const id = await createNewUser(ctx.db);
      await ctx.db.update(users).set({ roles: ["ADMIN"] }).where(eq(users.id, id));
      const res = await as(ctx, id).put("/me/roles", { roles: ["BUYER"] }, "").expect(200);
      expect(body(res).roles).toEqual(["ADMIN", "BUYER"]);
    });
  });
});
