// H2 (ADR-0007): the milestone state machine end to end, against real Postgres, with the fake
// PayPal. Jobs are not run by a queue here: the tests read what was scheduled and run the
// work themselves (expireWindow, processCapture, processVoid), so every step is visible.
import { eq } from "drizzle-orm";
import { auditLog, milestones, paymentEvents } from "../src/db/schema.js";
import type { CriterionVerdict } from "../src/db/schema.js";
import { approvedContract, as, bootTestApp, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface Money {
  amountMinor: number;
  currency: string;
}
interface MilestoneBody {
  id: string;
  state: string;
  holdStatus: string;
  stateVersion: number;
  windowEndsAt: string | null;
  latestRunId: string | null;
  openObjectionId: string | null;
  funded: Money;
  released: Money;
  returned: Money;
  held: Money;
  releases: { seq: number; amount: Money; final: boolean; status: string; transitionId: string }[];
  criteria: { id: string; text: string }[];
  nextStep: { actor: string; kind: string; at: string | null };
}

const COUNTDOWN_SECONDS = 60;
const http = (url: string) => ({ checkType: "HTTP_PROBE", checkConfig: { url } });

// requirements v1, T1: USD 500 with weights 40/30/20/10. The 40% one is required.
function t1Body(extra: object[] = []) {
  return draftBody({
    terms: { releaseCountdownSeconds: COUNTDOWN_SECONDS, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
    milestones: [
      {
        title: "Checkout",
        amount: { amountMinor: 50_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: [
          { text: "Checkout answers", level: "AUTOMATIC", required: true, weightBps: 4_000, ...http("https://example.com/checkout") },
          { text: "Cart answers", level: "AUTOMATIC", required: false, weightBps: 3_000, ...http("https://example.com/cart") },
          { text: "Search answers", level: "AUTOMATIC", required: false, weightBps: 2_000, ...http("https://example.com/search") },
          { text: "Docs answer", level: "AUTOMATIC", required: false, weightBps: 1_000, ...http("https://example.com/docs") },
          ...extra,
        ],
      },
    ],
  });
}

describe("Milestone state machine (H2)", () => {
  let ctx: TestContext;
  let buyer: string;
  let seller: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    buyer = await createUser(ctx.db, ["BUYER"]);
    seller = await createUser(ctx.db, ["SELLER"]);
  });

  const get = async (id: string) => (await as(ctx, buyer).get(`/milestones/${id}`).expect(200)).body as MilestoneBody;

  async function funded(body: object = t1Body()) {
    const { milestoneIds } = await approvedContract(ctx, buyer, seller, body);
    const id = milestoneIds[0] ?? "";
    const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
    const { paypalOrderId } = order.body as { paypalOrderId: string };
    await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId }).expect(200);
    return id;
  }

  async function delivered(body?: object) {
    const id = await funded(body);
    await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
    return submit(id);
  }

  async function submit(id: string) {
    const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/release-notes" }] }).expect(201);
    return { id, runId: (res.body as { runId: string }).runId };
  }

  // The Engine's answer: every criterion PASS unless listed as FAIL (or another verdict).
  async function verdicts(id: string, runId: string, override: Record<number, CriterionVerdict["verdict"]> = {}) {
    const m = await get(id);
    const results = m.criteria.map((c, i): CriterionVerdict => {
      const verdict = override[i] ?? "PASS";
      return { criterionId: c.id, verdict, evidenceRefCount: verdict === "PASS" ? 1 : 0 };
    });
    await ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results });
    return get(id);
  }

  function pastCountdown() {
    ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
  }

  // Runs every capture job of the milestone (one per release part). Settled parts are skipped.
  async function captureAll(id: string) {
    for (const job of ctx.jobs.of("payments.capture").filter((j) => j.data.milestoneId === id)) await ctx.milestones.processCapture(job.data.releasePartId as string);
    return get(id);
  }

  // The payments.void jobs of a milestone, one per hold.
  const voidJobs = (id: string) => ctx.jobs.of("payments.void").filter((j) => j.data.milestoneId === id).map((j) => j.data.holdId as string);
  async function returnAll(id: string) {
    for (const holdId of voidJobs(id)) expect(await ctx.milestones.processVoid(holdId)).toBe("VOIDED");
  }

  describe("funding (SM-T03)", () => {
    it("authorizes the milestone amount and records it in the ledger", async () => {
      const id = await funded();
      const m = await get(id);
      expect(m).toMatchObject({ state: "FUNDED", holdStatus: "AUTHORIZED", funded: { amountMinor: 50_000 }, held: { amountMinor: 50_000 } });
      const ledger = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.milestoneId, id));
      expect(ledger.map((e) => e.type).sort()).toEqual(["AUTHORIZED", "ORDER_CREATED"]);
      expect(ctx.jobs.of("payments.authorization.lapse").some((j) => j.data.milestoneId === id)).toBe(true);
    });

    it("refuses funding by the seller", async () => {
      const { milestoneIds } = await approvedContract(ctx, buyer, seller, t1Body());
      const res = await as(ctx, seller).post(`/milestones/${milestoneIds[0] ?? ""}/fund`).expect(403);
      expect(res.body).toMatchObject({ code: "FORBIDDEN" });
    });

    it("confirming the same order twice funds once", async () => {
      const { milestoneIds } = await approvedContract(ctx, buyer, seller, t1Body());
      const id = milestoneIds[0] ?? "";
      const { paypalOrderId } = (await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200)).body as { paypalOrderId: string };
      await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId }).expect(200);
      await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId }).expect(200);
      expect((await get(id)).stateVersion).toBe(2); // SM-T01 + SM-T03, nothing more
    });
  });

  describe("T1 and T2: partial release, then the rest", () => {
    it("releases 450 of 500, holds 50, and releases the 50 after the fix", async () => {
      const { id, runId } = await delivered();
      let m = await verdicts(id, runId, { 3: "FAIL" });
      expect(m).toMatchObject({ state: "OBJECTION_WINDOW", nextStep: { actor: "BUYER", kind: "APPROVE_OR_OBJECT" } });
      expect(ctx.jobs.of("objections.window.expire").some((j) => j.singletonKey === `window:${id}:${runId}`)).toBe(true);

      // The countdown (constitution XII) is not over: the timer does nothing.
      expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: null });

      pastCountdown();
      expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T19" });
      m = await get(id);
      expect(m).toMatchObject({ state: "PARTIALLY_RELEASED", holdStatus: "AUTHORIZED", released: { amountMinor: 45_000 }, held: { amountMinor: 5_000 } });
      expect(m.releases).toMatchObject([{ seq: 1, amount: { amountMinor: 45_000 }, final: false, status: "PENDING" }]);

      m = await captureAll(id);
      expect(m.releases[0]?.status).toBe("CAPTURED");
      expect(ctx.payments.captures.filter((c) => c.requestId.startsWith(`capture-${id}`))).toEqual([expect.objectContaining({ amountMinor: 45_000, final: false })]);

      // T2: the seller fixes the docs and resubmits (SM-T21).
      const second = await submit(id);
      await verdicts(id, second.runId);
      pastCountdown();
      expect(await ctx.milestones.expireWindow(id, second.runId)).toEqual({ applied: "SM-T09" });
      m = await captureAll(id);
      expect(m).toMatchObject({ state: "RELEASED", holdStatus: "CAPTURED", released: { amountMinor: 50_000 }, held: { amountMinor: 0 } });
      expect(m.releases.map((r) => [r.seq, r.amount.amountMinor, r.final, r.status])).toEqual([
        [1, 45_000, false, "CAPTURED"],
        [2, 5_000, true, "CAPTURED"],
      ]);
    });

    it("a resubmission that fixes nothing new goes back to PARTIALLY_RELEASED (SM-T23)", async () => {
      const { id, runId } = await delivered();
      await verdicts(id, runId, { 3: "FAIL" });
      pastCountdown();
      await ctx.milestones.expireWindow(id, runId);
      await captureAll(id);
      const again = await submit(id);
      const m = await verdicts(id, again.runId, { 3: "FAIL" });
      expect(m).toMatchObject({ state: "PARTIALLY_RELEASED", released: { amountMinor: 45_000 } });
    });

    it("a required criterion that fails releases nothing (SM-T06)", async () => {
      const { id, runId } = await delivered();
      const m = await verdicts(id, runId, { 0: "FAIL" });
      expect(m).toMatchObject({ state: "IN_PROGRESS", released: { amountMinor: 0 } });
    });
  });

  describe("who decides (constitution VI)", () => {
    const humanRequired = { text: "Buyer likes the colors", level: "HUMAN", required: true, weightBps: 1_000 };
    const withHuman = () => t1Body([humanRequired]).milestones;

    function bodyWithHuman() {
      const body = t1Body();
      const [first] = withHuman();
      if (first === undefined) throw new Error("fixture");
      // 40/30/20/0 + 10: take the docs weight for the human criterion.
      first.criteria = first.criteria.filter((c) => c.text !== "Docs answer");
      return { ...body, milestones: [first] };
    }

    it("silence never approves a human criterion: the countdown ends and nothing is released (SM-T24)", async () => {
      const { id, runId } = await delivered(bodyWithHuman());
      await verdicts(id, runId, { 3: "NEEDS_HUMAN" });
      pastCountdown();
      expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T24" });
      expect(await get(id)).toMatchObject({ state: "IN_PROGRESS", released: { amountMinor: 0 } });
    });

    it("the buyer must approve the required human criterion to release early", async () => {
      const { id, runId } = await delivered(bodyWithHuman());
      const m = await verdicts(id, runId, { 3: "NEEDS_HUMAN" });
      const res = await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [] }).expect(409);
      expect(res.body).toMatchObject({ code: "GUARD_FAILED", context: { guard: "G-REQUIRED-COUNTED" } });

      const human = m.criteria[3]?.id ?? "";
      const ok = await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [{ criterionId: human, decision: "APPROVED" }] }).expect(200);
      expect(ok.body).toMatchObject({ state: "RELEASED", released: { amountMinor: 50_000 } });
    });

    describe("a required AI criterion the model says FAIL (the buyer decides)", () => {
      const ai = { text: "Copy reads well", level: "AI_EVALUATED", required: true, weightBps: 1_000, checkType: "AI_REQUIREMENT_MET", checkConfig: { sources: ["HTTP_RESPONSE"], guidance: "The copy reads well" } };
      const AI_INDEX = 3;

      async function failedByAi() {
        const body = t1Body();
        const [first] = t1Body([ai]).milestones;
        if (first === undefined) throw new Error("fixture");
        first.criteria = first.criteria.filter((c) => c.text !== "Docs answer");
        const { id, runId } = await delivered({ ...body, milestones: [first] });
        const m = await verdicts(id, runId, { [AI_INDEX]: "FAIL" });
        return { id, runId, m };
      }

      it("opens the countdown instead of sending the work back", async () => {
        const { m } = await failedByAi();
        expect(m.state).toBe("OBJECTION_WINDOW");
      });

      it("the buyer can overrule it and release everything", async () => {
        const { id, m } = await failedByAi();
        const criterionId = m.criteria[AI_INDEX]?.id ?? "";
        const ok = await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [{ criterionId, decision: "APPROVED" }] }).expect(200);
        expect(ok.body).toMatchObject({ state: "RELEASED", released: { amountMinor: 50_000 } });
      });

      it("the buyer can ask the seller to fix it, and the seller can deliver again", async () => {
        const { id, m } = await failedByAi();
        const criterionId = m.criteria[AI_INDEX]?.id ?? "";
        const objected = await as(ctx, buyer).post(`/milestones/${id}/objections`, { criterionIds: [criterionId], reason: "The AI is right, the copy has mistakes in it." }).expect(201);
        expect(objected.body).toBeDefined();
        expect((await get(id)).state).toBe("OBJECTED");
        await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/" }] }).expect(201);
        expect((await get(id)).state).toBe("VERIFYING");
      });

      it("if the buyer says nothing, no money moves and the work goes back", async () => {
        const { id, runId } = await failedByAi();
        pastCountdown();
        expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T24" });
        expect(await get(id)).toMatchObject({ state: "IN_PROGRESS", released: { amountMinor: 0 } });
      });
    });

    it("an AI PASS alone does not count when the countdown ends", async () => {
      const ai = { text: "Copy reads well", level: "AI_EVALUATED", required: false, weightBps: 1_000, checkType: "AI_REQUIREMENT_MET", checkConfig: { sources: ["HTTP_RESPONSE"], guidance: "The copy reads well" } };
      const body = t1Body();
      const [first] = t1Body([ai]).milestones;
      if (first === undefined) throw new Error("fixture");
      first.criteria = first.criteria.filter((c) => c.text !== "Docs answer");
      const { id, runId } = await delivered({ ...body, milestones: [first] });
      await verdicts(id, runId); // everything PASS, the AI criterion included
      pastCountdown();
      expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T19" });
      expect(await get(id)).toMatchObject({ released: { amountMinor: 45_000 }, held: { amountMinor: 5_000 } });
    });

    it("the seller cannot approve, and nobody can approve while verifying", async () => {
      const { id } = await delivered();
      expect((await as(ctx, seller).post(`/milestones/${id}/approve`, { humanDecisions: [] }).expect(403)).body).toMatchObject({ code: "FORBIDDEN" });
      expect((await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [] }).expect(409)).body).toMatchObject({ code: "INVALID_TRANSITION" });
    });
  });

  describe("concurrency (SM-INV-2)", () => {
    it("approve and the timer at the same moment produce one release, 10 rounds", async () => {
      for (let round = 0; round < 10; round++) {
        const { id, runId } = await delivered();
        await verdicts(id, runId, { 3: "FAIL" });
        pastCountdown();
        const [approve, timer] = await Promise.allSettled([
          as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [] }),
          ctx.milestones.expireWindow(id, runId),
        ]);
        // The loser must lose cleanly: the buyer gets 200 or a 409 that says why, and the timer
        // finds nothing to do. A 500 or a thrown timer means the race reached the database.
        expect(approve.status === "fulfilled" ? approve.value.status : 0).toSatisfy((s: number) => s === 200 || s === 409);
        expect(timer.status).toBe("fulfilled");
        const m = await get(id);
        expect(m.releases).toHaveLength(1);
        expect(m.released.amountMinor).toBe(45_000);
        const transitions = await ctx.db.select().from(auditLog).where(eq(auditLog.entityId, id));
        expect(transitions.filter((a) => a.action === "milestone.transition.SM-T18" || a.action === "milestone.transition.SM-T19")).toHaveLength(1);
      }
    });
  });

  describe("PayPal misbehaving", () => {
    async function partlyReleased() {
      const { id, runId } = await delivered();
      await verdicts(id, runId, { 3: "FAIL" });
      pastCountdown();
      await ctx.milestones.expireWindow(id, runId);
      const releaseId = ctx.jobs.of("payments.capture").find((j) => j.data.milestoneId === id)?.data.releasePartId as string;
      return { id, releaseId };
    }

    it("a capture whose answer was lost is retried with the same key and captured once", async () => {
      const { id, releaseId } = await partlyReleased();
      ctx.payments.failNext("capture", "timeoutAfterApply");
      await expect(ctx.milestones.processCapture(releaseId)).rejects.toThrow(/timed out/);
      expect((await get(id)).releases[0]?.status).toBe("PENDING");
      expect(await ctx.milestones.processCapture(releaseId)).toBe("CAPTURED");
      expect(ctx.payments.captures.filter((c) => c.requestId.startsWith(`capture-${id}-1-`))).toHaveLength(1);
      // A third run of the same job finds the release settled and does not call PayPal.
      expect(await ctx.milestones.processCapture(releaseId)).toBe("SKIPPED");
    });

    // Review attack 2: a declined partial capture used to stay counted in releasedMinor, so the
    // final capture (funded - released, final_capture: true) made PayPal return the declined
    // share to the buyer while the ledger said the seller had it.
    it("a declined partial capture is taken back, and the next round releases it again (SM-T26)", async () => {
      const { id, releaseId } = await partlyReleased();
      ctx.payments.failNext("capture", "declined");
      expect(await ctx.milestones.processCapture(releaseId)).toBe("FAILED");
      const ledger = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.milestoneId, id));
      expect(ledger.some((e) => e.type === "CAPTURE_DENIED")).toBe(true);
      let m = await get(id);
      expect(m).toMatchObject({ state: "IN_PROGRESS", released: { amountMinor: 0 }, held: { amountMinor: 50_000 } });
      expect(m.releases[0]?.status).toBe("FAILED");

      const again = await submit(id);
      await verdicts(id, again.runId);
      pastCountdown();
      expect(await ctx.milestones.expireWindow(id, again.runId)).toEqual({ applied: "SM-T09" });
      m = await captureAll(id);
      expect(m).toMatchObject({ state: "RELEASED", holdStatus: "CAPTURED", released: { amountMinor: 50_000 } });
      // What PayPal actually moved adds up to what Settld says was released.
      expect(ctx.payments.captures.filter((c) => c.requestId.startsWith(`capture-${id}-`)).reduce((sum, c) => sum + c.amountMinor, 0)).toBe(50_000);
    });

    // Review attack 3: resubmitting while a capture was in flight let a countdown open that its
    // timer could never settle (G-NO-RELEASE-IN-FLIGHT inside the job, retries exhausted).
    it("cannot resubmit while a capture is in flight (SM-T21)", async () => {
      const { id } = await partlyReleased();
      const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/fix" }] }).expect(409);
      expect(res.body).toMatchObject({ code: "GUARD_FAILED", context: { guard: "G-NO-RELEASE-IN-FLIGHT" } });
    });

    // Review finding 4: PENDING used to leave the release PENDING forever (no webhook yet).
    it("a PENDING capture is followed up until PayPal settles it", async () => {
      const { id, releaseId } = await partlyReleased();
      ctx.payments.failNext("capture", "pending");
      expect(await ctx.milestones.processCapture(releaseId)).toBe("PENDING");
      const check = ctx.jobs.of("payments.capture.check").find((j) => j.data.releasePartId === releaseId);
      expect(check).toBeDefined();
      // Still pending at PayPal: the check asks to be retried later.
      await expect(ctx.milestones.processCaptureCheck(releaseId)).rejects.toThrow(/still pending/);
      ctx.payments.settlePending("COMPLETED");
      expect(await ctx.milestones.processCaptureCheck(releaseId)).toBe("CAPTURED");
      expect((await get(id)).releases[0]?.status).toBe("CAPTURED");
    });

    it("a capture in flight blocks closing the milestone (G-NO-RELEASE-IN-FLIGHT)", async () => {
      const { id } = await partlyReleased();
      const res = await as(ctx, seller).post(`/milestones/${id}:accept-partial`).expect(409);
      expect(res.body).toMatchObject({ code: "GUARD_FAILED", context: { guard: "G-NO-RELEASE-IN-FLIGHT" } });
    });
  });

  describe("endings", () => {
    it("the seller accepts the partial payment and the rest returns to the buyer (SM-T22)", async () => {
      const { id, runId } = await delivered();
      await verdicts(id, runId, { 3: "FAIL" });
      pastCountdown();
      await ctx.milestones.expireWindow(id, runId);
      await captureAll(id);
      const closed = await as(ctx, seller).post(`/milestones/${id}:accept-partial`).expect(200);
      expect(closed.body).toMatchObject({ state: "CLOSED", holdStatus: "VOID_PENDING", released: { amountMinor: 45_000 }, returned: { amountMinor: 5_000 }, held: { amountMinor: 0 } });
      const [holdId] = voidJobs(id);
      expect(await ctx.milestones.processVoid(holdId ?? "")).toBe("VOIDED");
      expect(await get(id)).toMatchObject({ holdStatus: "VOIDED" });
      // PayPal refuses a void after a partial capture (PP-T16): the held 50 goes back by a
      // final capture and a refund of it, never by a void.
      expect(ctx.payments.voids.filter((v) => v.requestId.startsWith(`void-${holdId ?? ""}`))).toHaveLength(0);
      expect(ctx.payments.captures.filter((c) => c.requestId === `return-capture-${holdId ?? ""}`)).toEqual([expect.objectContaining({ amountMinor: 5_000, final: true })]);
      expect(ctx.payments.refunds.filter((r) => r.requestId === `return-refund-${holdId ?? ""}`)).toEqual([expect.objectContaining({ amountMinor: 5_000 })]);
      const ledger = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.milestoneId, id));
      expect(ledger.filter((e) => e.type === "REFUNDED").map((e) => e.amountMinor)).toEqual([5_000]);
    });

    it("a crash between the return capture and the refund: the retry refunds once and captures nothing twice", async () => {
      const { id, runId } = await delivered();
      await verdicts(id, runId, { 3: "FAIL" });
      pastCountdown();
      await ctx.milestones.expireWindow(id, runId);
      await captureAll(id);
      await as(ctx, seller).post(`/milestones/${id}:accept-partial`).expect(200);
      const [holdId = ""] = voidJobs(id);
      ctx.payments.failNext("refund", "unavailable");
      await expect(ctx.milestones.processVoid(holdId)).rejects.toThrow(/503/);
      expect((await get(id)).holdStatus).toBe("VOID_PENDING");
      expect(await ctx.milestones.processVoid(holdId)).toBe("VOIDED");
      expect(ctx.payments.captures.filter((c) => c.requestId === `return-capture-${holdId}`)).toHaveLength(1);
      expect(ctx.payments.refunds.filter((r) => r.requestId === `return-refund-${holdId}`)).toHaveLength(1);
    });

    it("cancelling a funded milestone voids the whole hold (SM-T15)", async () => {
      const id = await funded();
      const res = await as(ctx, buyer).post(`/milestones/${id}:cancel`, { reason: "Project cancelled" }).expect(200);
      expect(res.body).toMatchObject({ state: "VOIDED", returned: { amountMinor: 50_000 } });
      await returnAll(id);
    });

    it("cannot cancel after delivery: that goes through an objection", async () => {
      const { id } = await delivered();
      expect((await as(ctx, buyer).post(`/milestones/${id}:cancel`, { reason: "Changed my mind" }).expect(409)).body).toMatchObject({ code: "INVALID_TRANSITION" });
    });
  });

  describe("review findings", () => {
    // Finding 5: a criterion the buyer approved and was paid for in round 1 used to stop
    // counting in round 2, so fixing the rest released nothing.
    it("a criterion approved and paid in an earlier round keeps counting", async () => {
      const body = t1Body();
      const [first] = body.milestones as { criteria: object[] }[];
      if (first === undefined) throw new Error("fixture");
      first.criteria = [
        { text: "Buyer likes the design", level: "HUMAN", required: true, weightBps: 5_000 },
        { text: "Docs answer", level: "AUTOMATIC", required: false, weightBps: 5_000, ...http("https://example.com/docs") },
      ];
      const { id, runId } = await delivered(body);
      const m = await verdicts(id, runId, { 0: "NEEDS_HUMAN", 1: "FAIL" });
      const human = m.criteria[0]?.id ?? "";
      await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [{ criterionId: human, decision: "APPROVED" }] }).expect(200);
      await captureAll(id);

      const again = await submit(id);
      await verdicts(id, again.runId, { 0: "NEEDS_HUMAN" }); // docs fixed; nobody re-approves the design
      pastCountdown();
      expect(await ctx.milestones.expireWindow(id, again.runId)).toEqual({ applied: "SM-T09" });
      expect(await captureAll(id)).toMatchObject({ state: "RELEASED", released: { amountMinor: 50_000 } });
    });

    // Finding 7: near the end of the authorization the shortened countdown could already be
    // over, and money would move with no visible countdown (constitution XII).
    it("does not open a countdown that cannot fit before the authorization expires", async () => {
      const { id, runId } = await delivered();
      const soon = new Date(ctx.clock.now().getTime() + 24 * 3_600_000 + 30_000); // 30 s of usable hold
      await ctx.db.update(milestones).set({ authorizationExpiresAt: soon }).where(eq(milestones.id, id));
      const m = await verdicts(id, runId, { 3: "FAIL" });
      expect(m).toMatchObject({ state: "VERIFYING", windowEndsAt: null });
      expect(ctx.jobs.of("objections.window.expire").some((j) => j.data.milestoneId === id)).toBe(false);
    });

    // Finding 6: an authorization PayPal created but that cannot fund the milestone used to stay
    // on the buyer's account, unrecorded, for up to 29 days.
    it("an authorization that does not match the milestone is recorded and voided", async () => {
      const { milestoneIds } = await approvedContract(ctx, buyer, seller, t1Body());
      const id = milestoneIds[0] ?? "";
      const { paypalOrderId } = (await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200)).body as { paypalOrderId: string };
      ctx.payments.tamperOrderAmount(paypalOrderId, 40_000); // PayPal reserves a different amount
      const res = await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId }).expect(409);
      expect(res.body).toMatchObject({ code: "GUARD_FAILED", context: { guard: "G-AUTH-MATCHES" } });
      expect(await get(id)).toMatchObject({ state: "APPROVED", funded: { amountMinor: 0 } });

      const job = ctx.jobs.of("payments.authorization.void-orphan").find((j) => j.data.milestoneId === id);
      if (job === undefined) throw new Error("no void-orphan job");
      expect(await ctx.milestones.processVoidOrphan(job.data.milestoneId as string, job.data.authorizationId as string, job.data.requestId as string)).toBe("VOIDED");
      const ledger = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.milestoneId, id));
      expect(ledger.map((e) => e.type)).toEqual(expect.arrayContaining(["AUTHORIZED", "VOID_REQUESTED", "VOIDED"]));
    });
  });

  describe("objections (SM-T10, T11, T12)", () => {
    it("an objection stops the countdown; withdrawing it releases what counts", async () => {
      const { id, runId } = await delivered();
      const m = await verdicts(id, runId, { 3: "FAIL" });
      const raised = await as(ctx, buyer).post(`/milestones/${id}/objections`, { criterionIds: [m.criteria[1]?.id], reason: "The cart loses items on refresh." }).expect(201);
      const objectionId = (raised.body as { id: string }).id;
      expect(await get(id)).toMatchObject({ state: "OBJECTED", openObjectionId: objectionId, windowEndsAt: null });
      // The seller has to read what to fix, and a stranger must not learn it exists.
      const read = await as(ctx, seller).get(`/objections/${objectionId}`).expect(200);
      expect(read.body).toMatchObject({ id: objectionId, reason: "The cart loses items on refresh.", criterionIds: [m.criteria[1]?.id], status: "OPEN" });
      await as(ctx, buyer).get(`/objections/${objectionId}`).expect(200);
      await as(ctx, await createUser(ctx.db, ["BUYER"])).get(`/objections/${objectionId}`).expect(404);
      expect(ctx.jobs.cancelled).toContainEqual({ queue: "objections.window.expire", singletonKey: `window:${id}:${runId}` });

      // The old timer fires anyway: the milestone moved on, so it does nothing.
      pastCountdown();
      expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: null });

      const withdrawn = await as(ctx, buyer).post(`/objections/${objectionId}:withdraw`).expect(200);
      expect(withdrawn.body).toMatchObject({ status: "WITHDRAWN" });
      expect(await get(id)).toMatchObject({ state: "PARTIALLY_RELEASED", released: { amountMinor: 45_000 } });
    });

    it("a resubmission supersedes the objection (SM-T11)", async () => {
      const { id, runId } = await delivered();
      const m = await verdicts(id, runId, { 3: "FAIL" });
      await as(ctx, buyer).post(`/milestones/${id}/objections`, { criterionIds: [m.criteria[0]?.id], reason: "Checkout fails with a Visa card." }).expect(201);
      await submit(id);
      expect(await get(id)).toMatchObject({ state: "VERIFYING", openObjectionId: null });
    });

    it("refuses an objection without a real reason (G-OBJECTION-VALID)", async () => {
      const { id, runId } = await delivered();
      const m = await verdicts(id, runId, { 3: "FAIL" });
      expect((await as(ctx, buyer).post(`/milestones/${id}/objections`, { criterionIds: [m.criteria[0]?.id], reason: "bad" }).expect(422)).body).toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  describe("verification results", () => {
    it("the same result delivered twice changes nothing the second time", async () => {
      const { id, runId } = await delivered();
      const first = await verdicts(id, runId, { 3: "FAIL" });
      const again = await verdicts(id, runId, { 3: "FAIL" });
      expect(again.stateVersion).toBe(first.stateVersion);
    });

    it("refuses a PASS without evidence (G-PASS-HAS-EVIDENCE)", async () => {
      const { id, runId } = await delivered();
      const m = await get(id);
      const results = m.criteria.map((c): CriterionVerdict => ({ criterionId: c.id, verdict: "PASS", evidenceRefCount: 0 }));
      await expect(ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results })).rejects.toMatchObject({ code: "GUARD_FAILED" });
      expect((await get(id)).state).toBe("VERIFYING");
    });

    it("an older submission's result, delivered again, never decides the current one", async () => {
      const { id, runId } = await delivered();
      await verdicts(id, runId, { 0: "FAIL" }); // back to IN_PROGRESS
      const second = await submit(id);
      // Run 1 again, now all PASS: if it were applied it would open the countdown.
      await verdicts(id, runId);
      expect(await get(id)).toMatchObject({ state: "VERIFYING", latestRunId: second.runId });
    });
  });

  it("conservation holds in the database after every scenario above (SM-INV-9)", async () => {
    const rows = await ctx.db.select().from(milestones);
    for (const r of rows) {
      expect(r.releasedMinor + r.returnedMinor).toBeLessThanOrEqual(r.fundedMinor);
      if (["RELEASED", "CLOSED", "VOIDED"].includes(r.state)) expect(r.releasedMinor + r.returnedMinor).toBe(r.fundedMinor);
    }
  });
});
