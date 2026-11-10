// ADR-0014: the way out of an objection nobody answers. Real Postgres and the fake PayPal; jobs are
// run by hand, like in the state machine tests. The money assertions are the point: every ending
// must add up, once.
import { eq } from "drizzle-orm";
import { auditLog, holds, objections, paymentEvents } from "../src/db/schema.js";
import { approvedContract, as, bootTestApp, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface Money {
  amountMinor: number;
}
interface MilestoneBody {
  id: string;
  state: string;
  holdStatus: string;
  stateVersion: number;
  openObjectionId: string | null;
  latestObjectionId: string | null;
  funded: Money;
  released: Money;
  returned: Money;
  held: Money;
  criteria: { id: string }[];
  nextStep: { actor: string; kind: string };
}

const REASON = "The cart loses its items on refresh, every time.";
const RULING = "The delivery does not meet the agreed criterion.";
const http = { checkType: "HTTP_PROBE", checkConfig: { url: "https://example.com/" } };
// 60% required and automatic, 40% optional and for the buyer: a round can pay part.
const body = () =>
  draftBody({
    terms: { releaseCountdownSeconds: 3_600, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
    milestones: [
      {
        title: "Checkout",
        amount: { amountMinor: 50_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: [
          { text: "Checkout answers", level: "AUTOMATIC", required: true, weightBps: 6_000, ...http },
          { text: "The copy reads well", level: "HUMAN", required: false, weightBps: 4_000 },
        ],
      },
    ],
  });

describe("Objections with no answer (ADR-0014)", () => {
  let ctx: TestContext;
  let buyer: string;
  let seller: string;
  let reviewer: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    buyer = await createUser(ctx.db, ["BUYER"]);
    seller = await createUser(ctx.db, ["SELLER"]);
    reviewer = await createUser(ctx.db, ["REVIEWER"]);
  });

  const get = async (id: string) => (await as(ctx, buyer).get(`/milestones/${id}`).expect(200)).body as MilestoneBody;

  async function deliver(id: string) {
    const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/" }] }).expect(201);
    const runId = (res.body as { runId: string }).runId;
    const m = await get(id);
    await ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results: m.criteria.map((c, i) => ({ criterionId: c.id, verdict: i === 0 ? "PASS" : "NEEDS_HUMAN", evidenceRefCount: i === 0 ? 1 : 0 })) });
  }

  async function object(id: string) {
    const m = await get(id);
    const res = await as(ctx, buyer).post(`/milestones/${id}/objections`, { criterionIds: [m.criteria[1]?.id], reason: REASON }).expect(201);
    return res.body as { id: string; status: string; escalateAt: string };
  }

  async function objected() {
    const { milestoneIds } = await approvedContract(ctx, buyer, seller, body());
    const id = milestoneIds[0] ?? "";
    const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
    await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: (order.body as { paypalOrderId: string }).paypalOrderId }).expect(200);
    await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
    await deliver(id);
    const objection = await object(id);
    return { id, objectionId: objection.id };
  }

  // The buyer pays the automatic 60%, then objects to the next round: part is already paid.
  async function objectedAfterPartial() {
    const { id, objectionId } = await objected();
    await as(ctx, buyer).post(`/objections/${objectionId}:withdraw`).expect(200);
    await captureAll(id);
    expect((await get(id)).state).toBe("PARTIALLY_RELEASED");
    await deliver(id);
    return { id, objectionId: (await object(id)).id };
  }

  async function captureAll(id: string) {
    for (const job of ctx.jobs.of("payments.capture").filter((j) => j.data.milestoneId === id)) await ctx.milestones.processCapture(job.data.releasePartId as string);
  }
  async function voidAll(id: string) {
    for (const job of ctx.jobs.of("payments.void").filter((j) => j.data.milestoneId === id)) await ctx.milestones.processVoid(job.data.holdId as string);
  }
  const escalated = async (objectionId: string) => {
    expect(await ctx.milestones.processEscalation(objectionId)).toBe("ESCALATED");
  };
  const rule = (objectionId: string, decision: "RELEASE" | "VOID", who = reviewer) => as(ctx, who).post(`/objections/${objectionId}:rule`, { decision, reason: RULING });

  describe("escalation", () => {
    it("the timer hands the objection to a reviewer, and no money moves", async () => {
      const { id, objectionId } = await objected();
      expect(ctx.jobs.of("objections.escalate").some((j) => j.singletonKey === `escalate:${objectionId}`)).toBe(true);
      await escalated(objectionId);
      const m = await get(id);
      expect(m).toMatchObject({ state: "OBJECTED", holdStatus: "AUTHORIZED", nextStep: { actor: "REVIEWER" } });
      expect(m.released.amountMinor).toBe(0);
      expect(ctx.jobs.of("notifications.send").some((j) => j.singletonKey === `notify:objection.escalated:${objectionId}`)).toBe(true);
    });

    it("a late timer does nothing once the objection ended", async () => {
      const { objectionId } = await objected();
      await as(ctx, buyer).post(`/objections/${objectionId}:withdraw`).expect(200);
      expect(await ctx.milestones.processEscalation(objectionId)).toBe("SKIPPED");
    });

    it("the seller cannot avoid the reviewer by delivering again (G-NOT-ESCALATED)", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      const refused = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/" }] }).expect(409);
      expect((refused.body as { context: { guard: string } }).context.guard).toBe("G-NOT-ESCALATED");
    });

    it("the third objection goes straight to a reviewer: nobody restarts the five days forever", async () => {
      const { id } = await objected();
      await deliver(id);
      const second = await object(id);
      expect(second.status).toBe("OPEN");
      await deliver(id);
      const third = await object(id);
      expect(third.status).toBe("ESCALATED");
      expect(ctx.jobs.of("objections.escalate").some((j) => j.singletonKey === `escalate:${third.id}`)).toBe(false);
    });
  });

  describe("the ruling", () => {
    it("RELEASE pays everything still held (SM-T13)", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      const ruled = await rule(objectionId, "RELEASE").expect(200);
      expect(ruled.body).toMatchObject({ status: "RULED_RELEASE", resolution: { reason: RULING, by: { id: reviewer } } });
      await captureAll(id);
      const m = await get(id);
      expect(m).toMatchObject({ state: "RELEASED", holdStatus: "CAPTURED", openObjectionId: null, latestObjectionId: objectionId });
      expect(m.released.amountMinor).toBe(50_000);
    });

    it("VOID with nothing paid returns everything (SM-T14)", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      await rule(objectionId, "VOID").expect(200);
      await voidAll(id);
      const m = await get(id);
      expect(m).toMatchObject({ state: "VOIDED", holdStatus: "VOIDED" });
      expect(m.returned.amountMinor).toBe(50_000);
    });

    it("VOID after a partial payment returns the rest and adds up (SM-T27)", async () => {
      const { id, objectionId } = await objectedAfterPartial();
      await escalated(objectionId);
      await rule(objectionId, "VOID").expect(200);
      await voidAll(id);
      const m = await get(id);
      expect(m.state).toBe("CLOSED");
      expect(m.released.amountMinor).toBe(30_000);
      expect(m.returned.amountMinor).toBe(20_000);
      expect(m.held.amountMinor).toBe(0);
    });

    it("the reason is in the audit log (constitution IX)", async () => {
      const { objectionId } = await objected();
      await escalated(objectionId);
      await rule(objectionId, "VOID").expect(200);
      const rows = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, objectionId));
      expect(rows.find((r) => r.action === "objection.ruled")?.reason).toBe(RULING);
    });

    it("refuses before the parties had their time (G-OBJECTION-ESCALATED)", async () => {
      const { objectionId } = await objected();
      const refused = await rule(objectionId, "VOID").expect(409);
      expect((refused.body as { context: { guard: string } }).context.guard).toBe("G-OBJECTION-ESCALATED");
    });

    it("refuses without the role, and refuses a reason that says nothing", async () => {
      const { objectionId } = await objected();
      await escalated(objectionId);
      await rule(objectionId, "VOID", buyer).expect(403);
      await as(ctx, reviewer).post(`/objections/${objectionId}:rule`, { decision: "VOID", reason: "Too short" }).expect(422);
      await as(ctx, reviewer).post(`/objections/${objectionId}:rule`, { decision: "VOID", reason: " ".repeat(30) }).expect(422);
    });

    it("asks only neutral people, and tells the buyer when the seller gives up", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      const job = ctx.jobs.of("notifications.send").find((j) => j.singletonKey === `notify:objection.escalated:${objectionId}`);
      const recipients = job?.data.recipientIds as string[];
      expect(recipients.slice(0, 2)).toEqual([buyer, seller]);
      expect(recipients).toContain(reviewer);

      await as(ctx, seller).post(`/milestones/${id}:surrender`).expect(200);
      const ended = ctx.jobs.of("notifications.send").find((j) => j.data.templateKey === "milestone.voided" && (j.data.params as { milestoneId: string }).milestoneId === id);
      if (ended === undefined) throw new Error("no milestone.voided job");
      ctx.emails.sent.length = 0;
      expect(await ctx.notifications.process(ended.data as never)).toBe("SENT");
      expect(ctx.emails.sent).toHaveLength(2);
    });

    it("a ruling does not also send the generic mail", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      await rule(objectionId, "VOID").expect(200);
      const ended = ctx.jobs.of("notifications.send").find((j) => j.data.templateKey === "milestone.voided" && (j.data.params as { milestoneId: string }).milestoneId === id);
      if (ended === undefined) throw new Error("no milestone.voided job");
      expect(await ctx.notifications.process(ended.data as never)).toBe("IGNORED");
    });

    it("an ADMIN who is a party cannot rule on their own contract (G-ACTOR-NEUTRAL)", async () => {
      const both = await createUser(ctx.db, ["BUYER", "ADMIN"]);
      buyer = both;
      const { objectionId } = await objected();
      await escalated(objectionId);
      const refused = await rule(objectionId, "RELEASE", both).expect(409);
      expect((refused.body as { context: { guard: string } }).context.guard).toBe("G-ACTOR-NEUTRAL");
      const list = await as(ctx, both).get("/objections").expect(200);
      expect((list.body as { items: { objection: { id: string } }[] }).items.map((i) => i.objection.id)).not.toContain(objectionId);
    });

    // Attack 1 of ADR-0014: exactly one wins, and the money moves once.
    it("a ruling, a withdrawal and a second ruling at once: one transition", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      const m = await get(id);
      const results = await Promise.all([
        rule(objectionId, "RELEASE"),
        rule(objectionId, "VOID"),
        as(ctx, buyer).post(`/objections/${objectionId}:withdraw`, { humanDecisions: [{ criterionId: m.criteria[1]?.id, decision: "APPROVED" }] }),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      const after = await get(id);
      expect(after.released.amountMinor + after.returned.amountMinor).toBe(50_000);
    });

    // Attack 2: the same key replays, a new key is refused, and no money moves twice.
    it("a repeated ruling replays, and a different one is refused", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      const key = "018f0000-0000-7000-8000-000000000001";
      const first = await as(ctx, reviewer).post(`/objections/${objectionId}:rule`, { decision: "VOID", reason: RULING }).set("Idempotency-Key", key).expect(200);
      const again = await as(ctx, reviewer).post(`/objections/${objectionId}:rule`, { decision: "VOID", reason: RULING }).set("Idempotency-Key", key).expect(200);
      expect(again.body).toEqual(first.body);
      await rule(objectionId, "RELEASE").expect(409);
      expect(ctx.jobs.of("payments.void").filter((j) => j.data.milestoneId === id)).toHaveLength(1);
    });

    // Attack 3: the process dies after the commit, so the job runs twice. The money returns once.
    it("a return job that runs again does not return twice", async () => {
      const { id, objectionId } = await objectedAfterPartial();
      await escalated(objectionId);
      await rule(objectionId, "VOID").expect(200);
      await voidAll(id);
      await voidAll(id);
      const events = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.milestoneId, id));
      expect(events.filter((e) => e.type === "REFUNDED")).toHaveLength(1);
    });

    it("a reviewer can read the case and its report, but not an unrelated milestone", async () => {
      const { id, objectionId } = await objected();
      await as(ctx, reviewer).get(`/objections/${objectionId}/case`).expect(404);
      await as(ctx, reviewer).get(`/milestones/${id}`).expect(404);
      // The list is the 100 oldest, and this database keeps what earlier runs escalated.
      await ctx.db.update(objections).set({ status: "WITHDRAWN" }).where(eq(objections.status, "ESCALATED"));
      await escalated(objectionId);
      const list = await as(ctx, reviewer).get("/objections").expect(200);
      expect((list.body as { items: { objection: { id: string } }[] }).items.map((i) => i.objection.id)).toContain(objectionId);
      const res = await as(ctx, reviewer).get(`/objections/${objectionId}/case`).expect(200);
      expect(res.body).toMatchObject({ objection: { id: objectionId, reason: REASON }, milestone: { id }, submissions: [{ attempt: 1 }] });
      await as(ctx, seller).get(`/objections/${objectionId}/case`).expect(404);
      await as(ctx, seller).get("/objections").expect(403);
    });
  });

  describe("why a round ended (Milestone.returnReason)", () => {
    it("a countdown nobody answered is told apart from a failed check", async () => {
      const { milestoneIds } = await approvedContract(ctx, buyer, seller, body());
      const id = milestoneIds[0] ?? "";
      const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
      await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: (order.body as { paypalOrderId: string }).paypalOrderId }).expect(200);
      await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
      expect(await get(id)).toMatchObject({ returnReason: null });

      const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/" }] }).expect(201);
      const runId = (res.body as { runId: string }).runId;
      const m = await get(id);
      await ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results: m.criteria.map((c) => ({ criterionId: c.id, verdict: "UNCERTAIN", evidenceRefCount: 0 })) });
      ctx.clock.advance(3_601_000);
      await ctx.milestones.expireWindow(id, runId);
      const after = await get(id);
      expect(after).toMatchObject({ state: "IN_PROGRESS", returnReason: "WINDOW_EXPIRED" });
      expect(after.held.amountMinor).toBe(50_000);

      const again = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/" }] }).expect(201);
      expect(await get(id)).toMatchObject({ state: "VERIFYING", returnReason: null });
      const run2 = (again.body as { runId: string }).runId;
      await ctx.milestones.applyRunCompleted({ runId: run2, status: "COMPLETED", results: m.criteria.map((c, i) => ({ criterionId: c.id, verdict: i === 0 ? "FAIL" : "NEEDS_HUMAN", evidenceRefCount: 0 })) });
      expect(await get(id)).toMatchObject({ state: "IN_PROGRESS", returnReason: "VERIFICATION_FAILED" });
    });
  });

  describe("the seller's way out", () => {
    it("explains their side once; the reviewer reads it, and the timer keeps running", async () => {
      const { objectionId } = await objected();
      const said = "I fixed this already, please reload the page and look again.";
      const res = await as(ctx, seller).post(`/objections/${objectionId}:contest`, { reason: said }).expect(200);
      expect(res.body).toMatchObject({ status: "CONTESTED", messages: [{ body: said, authorId: seller }] });
      await as(ctx, seller).post(`/objections/${objectionId}:contest`, { reason: said }).expect(409);
      await as(ctx, buyer).post(`/objections/${objectionId}:contest`, { reason: said }).expect(403);
      expect(await ctx.milestones.processEscalation(objectionId)).toBe("ESCALATED");
    });

    it("gives up with nothing paid: everything goes back (SM-T28)", async () => {
      const { id, objectionId } = await objected();
      await as(ctx, seller).post(`/milestones/${id}:surrender`).expect(200);
      await voidAll(id);
      const m = await get(id);
      expect(m).toMatchObject({ state: "VOIDED", holdStatus: "VOIDED", openObjectionId: null });
      expect(m.returned.amountMinor).toBe(50_000);
      expect(((await as(ctx, buyer).get(`/objections/${objectionId}`).expect(200)).body as { status: string }).status).toBe("SURRENDERED");
      expect(ctx.jobs.cancelled).toContainEqual({ queue: "objections.escalate", singletonKey: `escalate:${objectionId}` });
    });

    it("gives up after a partial payment: keeps what was paid, the rest goes back (SM-T29)", async () => {
      const { id } = await objectedAfterPartial();
      await as(ctx, seller).post(`/milestones/${id}:surrender`).expect(200);
      await voidAll(id);
      const m = await get(id);
      expect(m.state).toBe("CLOSED");
      expect(m.released.amountMinor).toBe(30_000);
      expect(m.returned.amountMinor).toBe(20_000);
    });

    it("the buyer cannot use it, and it needs an objection", async () => {
      const { id } = await objected();
      await as(ctx, buyer).post(`/milestones/${id}:surrender`).expect(403);
      await as(ctx, seller).post(`/milestones/${id}:surrender`).expect(200);
      await as(ctx, seller).post(`/milestones/${id}:surrender`).expect(409);
    });
  });

  describe("the reservation expires (SM-T17, SM-INV-6)", () => {
    async function inProgress() {
      const { milestoneIds } = await approvedContract(ctx, buyer, seller, body());
      const id = milestoneIds[0] ?? "";
      const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
      await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: (order.body as { paypalOrderId: string }).paypalOrderId }).expect(200);
      await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
      return id;
    }
    // Only this hold's date: moving the shared clock would expire what the next test funds.
    const pastExpiry = (id: string) => ctx.db.update(holds).set({ authorizationExpiresAt: new Date(0) }).where(eq(holds.milestoneId, id));
    const authorizationOf = async (id: string) => (await ctx.db.select().from(holds).where(eq(holds.milestoneId, id)))[0]?.authorizationId ?? "";

    it("before delivery, the buyer can fund again and the seller carries on", async () => {
      const id = await inProgress();
      expect(await ctx.milestones.processLapse(id, await authorizationOf(id))).toBe("LAPSED");
      const m = await get(id);
      expect(m).toMatchObject({ state: "APPROVED", holdStatus: "EXPIRED", nextStep: { actor: "BUYER", kind: "FUND" } });
      expect(m.funded.amountMinor).toBe(0);
      const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
      await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: (order.body as { paypalOrderId: string }).paypalOrderId }).expect(200);
      expect((await get(id)).state).toBe("FUNDED");
    });

    it("during a dispute it is an incident, and a return ruling still finishes it and adds up", async () => {
      const { id, objectionId } = await objected();
      await escalated(objectionId);
      expect(await ctx.milestones.processLapse(id, await authorizationOf(id))).toBe("INCIDENT");
      expect(await get(id)).toMatchObject({ state: "OBJECTED", holdStatus: "EXPIRED" });
      const refused = await rule(objectionId, "RELEASE").expect(409);
      expect((refused.body as { detail: string }).detail).toContain("returning");
      await rule(objectionId, "VOID").expect(200);
      const m = await get(id);
      expect(m).toMatchObject({ state: "VOIDED", holdStatus: "EXPIRED" });
      expect(m.returned.amountMinor).toBe(50_000);
    });

    it("a timer for an authorization that was replaced does nothing", async () => {
      const id = await inProgress();
      expect(await ctx.milestones.processLapse(id, "OLD-AUTHORIZATION")).toBe("SKIPPED");
      expect((await get(id)).state).toBe("IN_PROGRESS");
    });

    it("PayPal refusing to answer does not leave an expired hold looking active", async () => {
      const id = await inProgress();
      ctx.payments.authorizationStatus = "REFUSED";
      expect(await ctx.milestones.processLapse(id, await authorizationOf(id))).toBe("SKIPPED");
      await pastExpiry(id);
      expect(await ctx.milestones.processLapse(id, await authorizationOf(id))).toBe("LAPSED");
      ctx.payments.authorizationStatus = "EXPIRED";
      expect((await get(id)).state).toBe("APPROVED");
    });

    it("PayPal saying it was captured is an incident, not a lapse", async () => {
      const id = await inProgress();
      ctx.payments.authorizationStatus = "CAPTURED";
      expect(await ctx.milestones.processLapse(id, await authorizationOf(id))).toBe("SKIPPED");
      await pastExpiry(id);
      expect(await ctx.milestones.processLapse(id, await authorizationOf(id))).toBe("INCIDENT");
      ctx.payments.authorizationStatus = "EXPIRED";
      expect((await get(id)).state).toBe("IN_PROGRESS");
    });
  });
});
