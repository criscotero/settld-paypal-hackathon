// ADR-0015, delivery 1: how a person becomes a Reviewer. The point of these tests is the negative
// side: nothing here may give someone the power to move money by themselves (DM-INV-9).
import { eq } from "drizzle-orm";
import { auditLog, reviewerApplications, users } from "../src/db/schema.js";
import { as, bootTestApp, createNewUser, createUser } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface Application {
  id: string;
  status: string;
  decisionReason: string | null;
  canApplyAgainAt: string | null;
}
const REASON = "Checked the applicant's background.";

describe("Reviewer applications (ADR-0015)", () => {
  let ctx: TestContext;
  let applicant: string;
  let admin: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    applicant = await createUser(ctx.db, ["SELLER"]);
    admin = await createUser(ctx.db, ["ADMIN"]);
    ctx.emails.sent.length = 0;
  });

  const apply = (user = applicant, body: object = {}) => as(ctx, user).post("/me/reviewer-application", body);
  const decide = (id: string, decision: string, who = admin, reason = REASON) => as(ctx, who).post(`/reviewer-applications/${id}:decide`, { decision, reason });
  const rolesOf = async (id: string) => (await ctx.db.select().from(users).where(eq(users.id, id)))[0]?.roles;
  const applied = async () => (await apply().expect(200)).body as Application;

  describe("applying grants nothing", () => {
    it("is PENDING, shows on /me, and adds no role", async () => {
      const app = await applied();
      expect(app.status).toBe("PENDING");
      expect(await rolesOf(applicant)).toEqual(["SELLER"]);
      const me = await as(ctx, applicant).get("/me").expect(200);
      expect(me.body).toMatchObject({ reviewerApplication: { id: app.id, status: "PENDING" } });
    });

    it("works during onboarding, and does not finish or skip it", async () => {
      const fresh = await createNewUser(ctx.db);
      await apply(fresh).expect(200);
      const me = await as(ctx, fresh).get("/me").expect(200);
      expect(me.body).toMatchObject({ onboarding: { completed: false, nextStep: "ROLES" }, reviewerApplication: { status: "PENDING" } });
    });

    it("the role cannot be chosen, not even by asking for it", async () => {
      await as(ctx, await createNewUser(ctx.db)).put("/me/roles", { roles: ["REVIEWER"] }, "0").expect(422);
    });

    it("an applicant cannot rule or see the list", async () => {
      await applied();
      await as(ctx, applicant).get("/objections").expect(403);
      await as(ctx, applicant).get("/reviewer-applications").expect(403);
    });

    it("applying twice is one application, even at the same time", async () => {
      const [a, b] = await Promise.all([apply().expect(200), apply().expect(200)]);
      expect((a.body as Application).id).toBe((b.body as Application).id);
      expect(await ctx.db.select().from(reviewerApplications).where(eq(reviewerApplications.userId, applicant))).toHaveLength(1);
    });
  });

  describe("deciding", () => {
    it("approving adds the role, keeps the others, and opens the reviewer's list", async () => {
      const app = await applied();
      const res = await decide(app.id, "APPROVE").expect(200);
      expect(res.body).toMatchObject({ status: "APPROVED", decisionReason: REASON, email: expect.any(String) as string });
      expect(await rolesOf(applicant)).toEqual(["SELLER", "REVIEWER"]);
      await as(ctx, applicant).get("/objections").expect(200);
    });

    it.each([["a seller"], ["a reviewer"]])("%s cannot approve", async (who) => {
      const other = await createUser(ctx.db, who === "a seller" ? ["SELLER"] : ["REVIEWER"]);
      const app = await applied();
      await decide(app.id, "APPROVE", other).expect(403);
      expect(await rolesOf(applicant)).toEqual(["SELLER"]);
    });

    it("an administrator cannot approve themselves", async () => {
      const app = (await apply(admin).expect(200)).body as Application;
      await decide(app.id, "APPROVE", admin).expect(403);
      expect(await rolesOf(admin)).toEqual(["ADMIN"]);
    });

    it("a decision needs a real reason, and it is audited", async () => {
      const app = await applied();
      await decide(app.id, "APPROVE", admin, " ".repeat(20)).expect(422);
      await decide(app.id, "APPROVE").expect(200);
      const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, app.id));
      expect(rows.find((r) => r.action === "reviewer_application.decided")).toMatchObject({ reason: REASON, after: { status: "APPROVED", roles: ["SELLER", "REVIEWER"] } });
    });

    it("two administrators at once: one decision", async () => {
      const app = await applied();
      const other = await createUser(ctx.db, ["ADMIN"]);
      const results = await Promise.all([decide(app.id, "APPROVE"), decide(app.id, "REJECT", other)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });

    it("a decision not allowed from the status is refused", async () => {
      const app = await applied();
      await decide(app.id, "SUSPEND").expect(409);
      await decide(app.id, "REACTIVATE").expect(409);
    });
  });

  describe("after a decision", () => {
    it("suspending removes the permission at once; applying does not lift it", async () => {
      const app = await applied();
      await decide(app.id, "APPROVE").expect(200);
      await decide(app.id, "SUSPEND").expect(200);
      expect(await rolesOf(applicant)).toEqual(["SELLER"]);
      await as(ctx, applicant).get("/objections").expect(403);
      await apply().expect(409);
      await decide(app.id, "REACTIVATE").expect(200);
      expect(await rolesOf(applicant)).toEqual(["SELLER", "REVIEWER"]);
    });

    it("a rejected applicant reads why, and can apply again only after 30 days", async () => {
      const app = await applied();
      const rejected = (await decide(app.id, "REJECT").expect(200)).body as Application;
      expect(rejected.canApplyAgainAt).not.toBeNull();
      await apply().expect(409);
      expect(await as(ctx, applicant).get("/me").expect(200).then((r) => r.body as object)).toMatchObject({ reviewerApplication: { status: "REJECTED", decisionReason: REASON } });
      ctx.clock.advance(31 * 24 * 3_600_000);
      expect(((await apply().expect(200)).body as Application).status).toBe("PENDING");
      expect(await rolesOf(applicant)).toEqual(["SELLER"]);
    });

    it("someone Settld already made a reviewer has nothing to apply for", async () => {
      await apply(await createUser(ctx.db, ["REVIEWER"])).expect(409);
    });
  });

  describe("the list", () => {
    it("filters by status, and only an administrator reads it", async () => {
      const app = await applied();
      // The list is the 100 that waited longest. The e2e database keeps rows between runs, so a new
      // application falls off the page once 100 older ones pile up; making it the oldest keeps this
      // test about the filter, whatever earlier runs left behind.
      await ctx.db.update(reviewerApplications).set({ updatedAt: new Date(0) }).where(eq(reviewerApplications.id, app.id));
      const res = await as(ctx, admin).get("/reviewer-applications?status=PENDING").expect(200);
      expect((res.body as { items: { id: string }[] }).items.map((i) => i.id)).toContain(app.id);
      const none = await as(ctx, admin).get("/reviewer-applications?status=SUSPENDED").expect(200);
      expect((none.body as { items: { id: string }[] }).items.map((i) => i.id)).not.toContain(app.id);
      await as(ctx, admin).get("/reviewer-applications?status=NOPE").expect(422);
    });
  });

  describe("the mails", () => {
    const jobs = (template: string) => ctx.jobs.of("notifications.send").filter((j) => j.data.templateKey === template);

    it("tell the applicant and the administrators, once", async () => {
      await applied();
      const job = jobs("reviewer.application_submitted").at(-1);
      if (job === undefined) throw new Error("no job");
      expect(job.data.recipientIds).toEqual(expect.arrayContaining([applicant, admin]));
      expect(await ctx.notifications.process(job.data as never)).toBe("SENT");
      const sent = ctx.emails.sent.length;
      expect(sent).toBeGreaterThanOrEqual(2);
      expect(await ctx.notifications.process(job.data as never)).toBe("ALREADY_SENT");
      expect(ctx.emails.sent).toHaveLength(sent);
    });

    it("tell the applicant the decision and why", async () => {
      const app = await applied();
      await decide(app.id, "REJECT").expect(200);
      const job = jobs("reviewer.application_decided").at(-1);
      if (job === undefined) throw new Error("no job");
      expect(await ctx.notifications.process(job.data as never)).toBe("SENT");
      expect(ctx.emails.sent.at(-1)?.text).toContain(REASON);
    });
  });
});
