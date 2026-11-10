// ADR-0009, steps 3 and 4: a team's milestone is funded with one PayPal order per member, and
// every release and return is split hold by hold. The ADR's example: USD 500 with the seller at
// 70% and Ana at 30%, criteria weighted 40/30/20/10 (the 40% one required).
import { eq } from "drizzle-orm";
import { holds, users } from "../src/db/schema.js";
import type { CriterionVerdict } from "../src/db/schema.js";
import { as, bootTestApp, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface Money {
  amountMinor: number;
}
interface HoldView {
  payeeUserId: string;
  shareBps: number;
  funded: Money;
  released: Money;
  returned: Money;
  holdStatus: string;
}
interface MilestoneBody {
  state: string;
  holdStatus: string;
  authorizationExpiresAt: string | null;
  funded: Money;
  released: Money;
  returned: Money;
  holds: HoldView[];
  releases: { seq: number; amount: Money; status: string; parts: { payeeUserId: string; amount: Money; status: string }[] }[];
  criteria: { id: string }[];
}
interface FundingBody {
  paypalOrderId: string;
  orders: { holdId: string; payeeUserId: string; amount: Money; paypalOrderId: string; holdStatus: string }[];
}

const COUNTDOWN_SECONDS = 60;
const probe = (path: string) => ({ checkType: "HTTP_PROBE", checkConfig: { url: `https://example.com/${path}` } });

describe("Holds: one PayPal authorization per team member (ADR-0009)", () => {
  let ctx: TestContext;
  let buyer: string;
  let seller: string;
  let ana: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    buyer = await createUser(ctx.db, ["BUYER"]);
    seller = await createUser(ctx.db, ["SELLER"]);
    ana = await createUser(ctx.db, ["COLLABORATOR"]);
  });

  // A locked contract whose team is the seller at 70% and Ana at 30%. Returns the milestone id.
  async function teamMilestone(): Promise<string> {
    const body = draftBody({
      terms: { releaseCountdownSeconds: COUNTDOWN_SECONDS, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
      milestones: [
        {
          title: "Checkout",
          amount: { amountMinor: 50_000, currency: "USD" },
          dueDate: "2099-01-31",
          criteria: [
            { text: "Checkout answers", level: "AUTOMATIC", required: true, weightBps: 4_000, ...probe("checkout") },
            { text: "Cart answers", level: "AUTOMATIC", required: false, weightBps: 3_000, ...probe("cart") },
            { text: "Search answers", level: "AUTOMATIC", required: false, weightBps: 2_000, ...probe("search") },
            { text: "Docs answer", level: "AUTOMATIC", required: false, weightBps: 1_000, ...probe("docs") },
          ],
        },
      ],
    });
    const created = await as(ctx, buyer).post("/contracts", body).expect(201);
    const id = (created.body as { id: string }).id;
    await as(ctx, buyer).post(`/contracts/${id}/invitations`, { email: "s@example.com" }).expect(202);
    await as(ctx, seller).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
    await as(ctx, seller).post(`/contracts/${id}/team`, { userId: ana }).expect(201);
    const team = [
      { userId: null, role: "Lead developer", shareBps: 7_000 },
      { userId: ana, role: "Designer", shareBps: 3_000 },
    ];
    const current = (await as(ctx, seller).get(`/contracts/${id}`).expect(200)).body as { currentVersion: { version: number } };
    await as(ctx, seller).put(`/contracts/${id}/draft`, { ...body, team }, String(current.currentVersion.version)).expect(200);
    const submitted = (await as(ctx, seller).post(`/contracts/${id}/draft:submit`).expect(200)).body as { version: number; snapshotHash: string };
    for (const who of [buyer, seller, ana]) {
      await as(ctx, who).post(`/contracts/${id}/versions/${String(submitted.version)}:approve`, { snapshotHash: submitted.snapshotHash, acknowledgeLowVerifiability: true }).expect(200);
    }
    const view = (await as(ctx, buyer).get(`/contracts/${id}`).expect(200)).body as { milestones: { id: string; state: string }[] };
    expect(view.milestones[0]?.state).toBe("APPROVED");
    return view.milestones[0]?.id ?? "";
  }

  const get = async (id: string, who = buyer) => (await as(ctx, who).get(`/milestones/${id}`).expect(200)).body as MilestoneBody;
  const fund = async (id: string) => (await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200)).body as FundingBody;
  const confirm = (id: string, paypalOrderId: string) => as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId });
  const merchantOf = async (userId: string) => (await ctx.db.select({ m: users.paypalMerchantId }).from(users).where(eq(users.id, userId)))[0]?.m;

  async function funded(): Promise<string> {
    const id = await teamMilestone();
    for (const o of (await fund(id)).orders) await confirm(id, o.paypalOrderId).expect(200);
    return id;
  }

  // Delivered, verified with the 10% criterion failing, and the countdown over: SM-T19 releases 90%.
  async function releasedNinety(): Promise<string> {
    const id = await funded();
    await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
    const runId = await submit(id);
    await verdicts(id, runId, { 3: "FAIL" });
    ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
    expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T19" });
    return id;
  }

  async function submit(id: string): Promise<string> {
    const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/notes" }] }).expect(201);
    return (res.body as { runId: string }).runId;
  }

  async function verdicts(id: string, runId: string, override: Record<number, CriterionVerdict["verdict"]> = {}) {
    const results = (await get(id)).criteria.map((c, i): CriterionVerdict => {
      const verdict = override[i] ?? "PASS";
      return { criterionId: c.id, verdict, evidenceRefCount: verdict === "PASS" ? 1 : 0 };
    });
    await ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results });
  }

  const captureJobs = (id: string) => ctx.jobs.of("payments.capture").filter((j) => j.data.milestoneId === id);
  async function captureAll(id: string) {
    for (const job of captureJobs(id)) await ctx.milestones.processCapture(job.data.releasePartId as string);
  }

  describe("funding with one order per member (step 3)", () => {
    it("creates one order per member, each for their share and paid to their own PayPal account", async () => {
      const id = await teamMilestone();
      const body = await fund(id);
      expect(body.orders.map((o) => [o.payeeUserId, o.amount.amountMinor, o.holdStatus])).toEqual([
        [seller, 35_000, "ORDER_CREATED"],
        [ana, 15_000, "ORDER_CREATED"],
      ]);
      // The top-level fields point at the next order to approve: the first one.
      expect(body.paypalOrderId).toBe(body.orders[0]?.paypalOrderId);
      const payees = body.orders.map((o) => ctx.payments.orders.get(o.paypalOrderId)?.payeeMerchantId);
      expect(payees).toEqual([await merchantOf(seller), await merchantOf(ana)]);
    });

    it("stays APPROVED until the last order is authorized, then SM-T03 funds the whole milestone", async () => {
      const id = await teamMilestone();
      const [first, second] = (await fund(id)).orders;
      if (first === undefined || second === undefined) throw new Error("two orders expected");

      const afterFirst = (await confirm(id, first.paypalOrderId).expect(200)).body as MilestoneBody;
      // Never FUNDED with part of the team's money unreserved (decision 3).
      expect(afterFirst).toMatchObject({ state: "APPROVED", holdStatus: "ORDER_CREATED", funded: { amountMinor: 35_000 } });
      const next = await fund(id);
      expect(next.paypalOrderId).toBe(second.paypalOrderId);
      expect(next.orders.map((o) => o.holdStatus)).toEqual(["AUTHORIZED", "ORDER_CREATED"]);

      const afterSecond = (await confirm(id, second.paypalOrderId).expect(200)).body as MilestoneBody;
      expect(afterSecond).toMatchObject({ state: "FUNDED", holdStatus: "AUTHORIZED", funded: { amountMinor: 50_000 } });
      expect(afterSecond.holds.map((h) => [h.payeeUserId, h.shareBps, h.funded.amountMinor, h.holdStatus])).toEqual([
        [seller, 7_000, 35_000, "AUTHORIZED"],
        [ana, 3_000, 15_000, "AUTHORIZED"],
      ]);
    });

    it("asking for the orders again creates none: PayPal replays the same ones", async () => {
      const id = await teamMilestone();
      const first = await fund(id);
      const ordersBefore = ctx.payments.orders.size;
      const again = await fund(id);
      expect(again.orders.map((o) => o.paypalOrderId)).toEqual(first.orders.map((o) => o.paypalOrderId));
      expect(ctx.payments.orders.size).toBe(ordersBefore);
    });

    it("the milestone's authorization expiry is the earliest of its holds", async () => {
      const id = await teamMilestone();
      const [first, second] = (await fund(id)).orders;
      ctx.payments.now = () => ctx.clock.now();
      await confirm(id, first?.paypalOrderId ?? "").expect(200);
      const earliest = (await ctx.db.select().from(holds).where(eq(holds.milestoneId, id)))[0]?.authorizationExpiresAt;
      ctx.clock.advance(2 * 3_600_000);
      await confirm(id, second?.paypalOrderId ?? "").expect(200);
      expect((await get(id)).authorizationExpiresAt).toBe(earliest?.toISOString());
    });

    // ADR-0009, failure modes: the buyer approves the seller's order and leaves. SM-T16 voids
    // what is already authorized (state machine 2.1.0); without it the buyer's 350 would stay
    // reserved until PayPal lets the authorization expire, 29 days later.
    it("cancelling a milestone funded only in part voids the authorization already made, at the seller's account", async () => {
      const id = await teamMilestone();
      const [first] = (await fund(id)).orders;
      await confirm(id, first?.paypalOrderId ?? "").expect(200);

      const res = await as(ctx, buyer).post(`/milestones/${id}:cancel`, { reason: "Changed my mind" }).expect(200);
      expect(res.body).toMatchObject({ state: "VOIDED", holdStatus: "VOID_PENDING", funded: { amountMinor: 35_000 }, returned: { amountMinor: 35_000 } });
      // Ana's order was never approved: no money behind it, so it is just abandoned.
      expect((res.body as MilestoneBody).holds.map((h) => [h.payeeUserId, h.holdStatus])).toEqual([
        [seller, "VOID_PENDING"],
        [ana, "NONE"],
      ]);

      const voids = ctx.jobs.of("payments.void").filter((j) => j.data.milestoneId === id);
      expect(voids).toHaveLength(1);
      for (const j of voids) expect(await ctx.milestones.processVoid(j.data.holdId as string)).toBe("VOIDED");
      const sellersAuth = (await ctx.db.select().from(holds).where(eq(holds.milestoneId, id))).find((h) => h.payeeUserId === seller)?.authorizationId;
      expect(ctx.payments.voids.map((v) => v.authorizationId)).toContain(sellersAuth);
      // The milestone's holdStatus is the aggregate rule's (domain-model.md, Hold): NONE comes
      // before VOIDED, so it reads NONE. Each hold says what happened to its own money.
      const after = await get(id);
      expect(after).toMatchObject({ state: "VOIDED", holdStatus: "NONE", returned: { amountMinor: 35_000 } });
      expect(after.holds.map((h) => h.holdStatus)).toEqual(["VOIDED", "NONE"]);
    });

    // The abandoned order can still be approved at PayPal after the cancel. fund:confirm then
    // refuses before asking PayPal to authorize it, so no money is ever reserved for it.
    it("an order approved after the cancel is not authorized", async () => {
      const id = await teamMilestone();
      const [first] = (await fund(id)).orders;
      await as(ctx, buyer).post(`/milestones/${id}:cancel`, { reason: "Changed my mind" }).expect(200);
      expect((await get(id)).holdStatus).toBe("NONE");
      await confirm(id, first?.paypalOrderId ?? "").expect(409);
      expect(ctx.payments.orders.get(first?.paypalOrderId ?? "")?.authorizationId).toBeNull();
    });

    it("refuses an order of another milestone's hold, and an authorization for the wrong amount", async () => {
      const id = await teamMilestone();
      const other = await teamMilestone();
      const [foreign] = (await fund(other)).orders;
      expect((await confirm(id, foreign?.paypalOrderId ?? "").expect(409)).body).toMatchObject({ context: { guard: "G-AUTH-MATCHES" } });

      const [, anas] = (await fund(id)).orders;
      ctx.payments.tamperOrderAmount(anas?.paypalOrderId ?? "", 14_999);
      expect((await confirm(id, anas?.paypalOrderId ?? "").expect(409)).body).toMatchObject({ context: { guard: "G-AUTH-MATCHES" } });
      // The authorization PayPal made anyway is recorded and voided, at Ana's account.
      const job = ctx.jobs.of("payments.authorization.void-orphan").find((j) => j.data.milestoneId === id);
      expect(await ctx.milestones.processVoidOrphan(id, job?.data.authorizationId as string, job?.data.requestId as string)).toBe("VOIDED");
    });
  });

  describe("release by parts (step 4)", () => {
    it("ADR-0009 example: 90% releases 315 to the seller and 135 to Ana, one capture each on their own authorization", async () => {
      const id = await releasedNinety();
      const m = await get(id);
      expect(m).toMatchObject({ state: "PARTIALLY_RELEASED", released: { amountMinor: 45_000 } });
      expect(m.releases[0]?.parts.map((p) => [p.payeeUserId, p.amount.amountMinor, p.status])).toEqual([
        [seller, 31_500, "PENDING"],
        [ana, 13_500, "PENDING"],
      ]);
      expect(captureJobs(id)).toHaveLength(2);
      await captureAll(id);

      const rows = await ctx.db.select().from(holds).where(eq(holds.milestoneId, id));
      const capturedAt = (userId: string) => {
        const auth = rows.find((h) => h.payeeUserId === userId)?.authorizationId;
        return ctx.payments.captures.filter((c) => c.authorizationId === auth).map((c) => c.amountMinor);
      };
      expect(capturedAt(seller)).toEqual([31_500]);
      expect(capturedAt(ana)).toEqual([13_500]);
      expect((await get(id)).releases[0]?.status).toBe("CAPTURED");
    });

    it("once everything counts, each hold has released exactly its funded amount", async () => {
      const id = await releasedNinety();
      await captureAll(id);
      const runId = await submit(id);
      await verdicts(id, runId);
      ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
      expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T09" });
      await captureAll(id);
      const m = await get(id);
      expect(m).toMatchObject({ state: "RELEASED", holdStatus: "CAPTURED", released: { amountMinor: 50_000 } });
      expect(m.holds.map((h) => [h.released.amountMinor, h.holdStatus])).toEqual([
        [35_000, "CAPTURED"],
        [15_000, "CAPTURED"],
      ]);
    });

    // ADR-0009, rule 3: Ana's capture is declined, the seller's goes through.
    it("a declined part is taken back from its own hold only, and the next round pays it again", async () => {
      const id = await releasedNinety();
      const [sellerJob, anaJob] = captureJobs(id);
      await ctx.milestones.processCapture(sellerJob?.data.releasePartId as string);
      ctx.payments.failNext("capture", "declined");
      expect(await ctx.milestones.processCapture(anaJob?.data.releasePartId as string)).toBe("FAILED");

      let m = await get(id);
      // Something stays released (the seller's part), so there is no SM-T26.
      expect(m).toMatchObject({ state: "PARTIALLY_RELEASED", released: { amountMinor: 31_500 } });
      expect(m.holds.map((h) => h.released.amountMinor)).toEqual([31_500, 0]);
      expect(m.releases[0]).toMatchObject({ status: "CAPTURED", parts: [{ status: "CAPTURED" }, { status: "FAILED" }] });

      // Same verdicts again: only Ana's 135 is new.
      const runId = await submit(id);
      await verdicts(id, runId, { 3: "FAIL" });
      ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
      expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T19" });
      m = await get(id);
      expect(m.releases[1]?.parts.map((p) => [p.payeeUserId, p.amount.amountMinor])).toEqual([[ana, 13_500]]);
    });

    it("closing returns each hold's rest by capture and refund at that payee's own authorization", async () => {
      const id = await releasedNinety();
      await captureAll(id);
      const closed = (await as(ctx, seller).post(`/milestones/${id}:accept-partial`).expect(200)).body as MilestoneBody;
      expect(closed).toMatchObject({ state: "CLOSED", holdStatus: "VOID_PENDING", returned: { amountMinor: 5_000 } });
      const voids = ctx.jobs.of("payments.void").filter((j) => j.data.milestoneId === id);
      expect(voids).toHaveLength(2);
      for (const j of voids) expect(await ctx.milestones.processVoid(j.data.holdId as string)).toBe("VOIDED");
      const m = await get(id);
      expect(m).toMatchObject({ holdStatus: "VOIDED" });
      expect(m.holds.map((h) => h.returned.amountMinor)).toEqual([3_500, 1_500]);
      const returned = ctx.payments.refunds.filter((r) => voids.some((j) => r.requestId === `return-refund-${j.data.holdId as string}`));
      expect(returned.map((r) => r.amountMinor).sort()).toEqual([1_500, 3_500]);
    });

    it("cancelling a funded team milestone voids every hold (SM-T15)", async () => {
      const id = await funded();
      await as(ctx, buyer).post(`/milestones/${id}:cancel`, { reason: "Project cancelled" }).expect(200);
      const voids = ctx.jobs.of("payments.void").filter((j) => j.data.milestoneId === id);
      for (const j of voids) expect(await ctx.milestones.processVoid(j.data.holdId as string)).toBe("VOIDED");
      expect(ctx.payments.voids.filter((v) => voids.some((j) => v.requestId.startsWith(`void-${j.data.holdId as string}-`)))).toHaveLength(2);
      expect(await get(id)).toMatchObject({ state: "VOIDED", holdStatus: "VOIDED", returned: { amountMinor: 50_000 } });
    });
  });

  // Decision 6: a collaborator sees their own money, never the other members' parts.
  it("a collaborator sees only their own hold and their own parts", async () => {
    const id = await releasedNinety();
    const asAna = await get(id, ana);
    expect(asAna.holds.map((h) => h.payeeUserId)).toEqual([ana]);
    expect(asAna.releases[0]?.parts.map((p) => p.payeeUserId)).toEqual([ana]);
    expect((await get(id)).holds).toHaveLength(2);
  });

  // The ledger is the same money seen from PayPal's side: the seller's authorization and
  // capture amounts would tell Ana the other members' parts.
  it("a collaborator's payment events are only those of their own hold", async () => {
    const id = await releasedNinety();
    await captureAll(id);
    type Event = { type: string; amount: Money | null };
    const asAna = (await as(ctx, ana).get(`/milestones/${id}/payment-events`).expect(200)).body as Event[];
    expect(asAna.filter((e) => e.type === "AUTHORIZED").map((e) => e.amount?.amountMinor)).toEqual([15_000]);
    expect(asAna.filter((e) => e.type === "CAPTURED").map((e) => e.amount?.amountMinor)).toEqual([13_500]);
    const asBuyer = (await as(ctx, buyer).get(`/milestones/${id}/payment-events`).expect(200)).body as Event[];
    expect(asBuyer.filter((e) => e.type === "CAPTURED")).toHaveLength(2);
  });
});
