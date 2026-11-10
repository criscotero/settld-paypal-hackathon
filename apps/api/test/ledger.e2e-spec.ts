// ADR-0017: GET /payments. The same team contract as holds.e2e-spec.ts: USD 500, the seller at 70%
// and Ana at 30%, criteria weighted 40/30/20/10.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { contractParties, contracts, contractVersions, milestones, paymentEvents, releases } from "../src/db/schema.js";
import type { ContractSnapshot } from "../src/contracts/snapshot.js";
import type { CriterionVerdict } from "../src/db/schema.js";
import { as, bootTestApp, createUser, draftBody, TEST_PAYPAL_WEB_BASE } from "./support/app.js";
import type { TestContext } from "./support/app.js";

interface Money {
  amountMinor: number;
  currency: string;
}
interface Entry {
  id: string;
  type: string;
  occurredAt: string;
  milestoneId: string;
  milestoneTitle: string;
  contractTitle: string;
  myRole: string;
  counterpartyName: string | null;
  amount: Money | null;
  platformFee: Money | null;
  ledgerEffect: "PAID" | "RETURNED" | "NONE";
  paypalId: string | null;
  paypalIdKind: string | null;
  paypalUrl: string | null;
  releaseId: string | null;
  criteria: { criterionId: string; title: string; weightBps: number; verdict: string | null; humanApproved: boolean }[];
  reportHash: string | null;
}
interface Page {
  items: Entry[];
  truncated: boolean;
}

const COUNTDOWN_SECONDS = 60;
const WIDE = "from=2000-01-01&to=2100-01-01";
const probe = (path: string) => ({ checkType: "HTTP_PROBE", checkConfig: { url: `https://example.com/${path}` } });

describe("Payments ledger (ADR-0017)", () => {
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
    const view = (await as(ctx, buyer).get(`/contracts/${id}`).expect(200)).body as { milestones: { id: string }[] };
    return view.milestones[0]?.id ?? "";
  }

  const criteriaOf = async (id: string) => ((await as(ctx, buyer).get(`/milestones/${id}`).expect(200)).body as { criteria: { id: string }[] }).criteria;
  const fund = async (id: string) => ((await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200)).body as { orders: { paypalOrderId: string }[] }).orders;

  async function funded(): Promise<string> {
    const id = await teamMilestone();
    for (const o of await fund(id)) await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: o.paypalOrderId }).expect(200);
    return id;
  }

  async function submit(id: string): Promise<string> {
    const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/notes" }] }).expect(201);
    return (res.body as { runId: string }).runId;
  }

  async function verdicts(id: string, runId: string, override: Record<number, CriterionVerdict["verdict"]> = {}) {
    const results = (await criteriaOf(id)).map((c, i): CriterionVerdict => {
      const verdict = override[i] ?? "PASS";
      return { criterionId: c.id, verdict, evidenceRefCount: verdict === "PASS" ? 1 : 0 };
    });
    await ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results, reportHash: `hash-${runId}` });
  }

  async function captureAll(id: string) {
    for (const job of ctx.jobs.of("payments.capture").filter((j) => j.data.milestoneId === id)) await ctx.milestones.processCapture(job.data.releasePartId as string);
  }

  // Delivered, the 10% criterion failing, the countdown over and PayPal captured: 90% paid.
  async function paidNinety(): Promise<{ id: string; runId: string }> {
    const id = await funded();
    await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
    const runId = await submit(id);
    await verdicts(id, runId, { 3: "FAIL" });
    ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
    expect(await ctx.milestones.expireWindow(id, runId)).toEqual({ applied: "SM-T19" });
    await captureAll(id);
    return { id, runId };
  }

  const ledger = async (who: string, query = WIDE) => (await as(ctx, who).get(`/payments?${query}`).expect(200)).body as Page;
  const sum = (items: Entry[], effect: Entry["ledgerEffect"]) => items.filter((e) => e.ledgerEffect === effect).reduce((total, e) => total + (e.amount?.amountMinor ?? 0), 0);
  const processVoids = async (id: string) => {
    for (const j of ctx.jobs.of("payments.void").filter((x) => x.data.milestoneId === id)) expect(await ctx.milestones.processVoid(j.data.holdId as string)).toBe("VOIDED");
  };

  describe("what counts as money", () => {
    it("paid is what the release parts captured, and each row names its PayPal capture", async () => {
      await paidNinety();
      const { items, truncated } = await ledger(buyer);
      expect(truncated).toBe(false);
      expect(sum(items, "PAID")).toBe(45_000);
      expect(sum(items, "RETURNED")).toBe(0);
      const paid = items.filter((e) => e.ledgerEffect === "PAID");
      expect(paid.map((e) => e.amount?.amountMinor).sort()).toEqual([13_500, 31_500]);
      for (const e of paid) {
        expect(e).toMatchObject({ type: "CAPTURED", paypalIdKind: "CAPTURE", contractTitle: "Checkout redesign", milestoneTitle: "Checkout", myRole: "BUYER" });
        expect(e.paypalId).toBeTruthy();
      }
    });

    it("a return after a partial release shows both facts and counts only the refund", async () => {
      const { id } = await paidNinety();
      await as(ctx, seller).post(`/milestones/${id}:accept-partial`).expect(200);
      await processVoids(id);
      const { items } = await ledger(buyer);
      // Conservation: paid plus returned is everything the buyer funded.
      expect(sum(items, "PAID")).toBe(45_000);
      expect(sum(items, "RETURNED")).toBe(5_000);
      const returnCaptures = items.filter((e) => e.type === "CAPTURED" && e.ledgerEffect === "NONE");
      expect(returnCaptures.map((e) => e.amount?.amountMinor).sort()).toEqual([1_500, 3_500]);
      expect(items.filter((e) => e.type === "REFUNDED").map((e) => e.ledgerEffect)).toEqual(["RETURNED", "RETURNED"]);
    });

    it("a void shows the amount from the hold, because the fact has none", async () => {
      const id = await funded();
      await as(ctx, buyer).post(`/milestones/${id}:cancel`, { reason: "Project cancelled" }).expect(200);
      await processVoids(id);
      const voided = (await ledger(buyer)).items.filter((e) => e.type === "VOIDED");
      expect(voided.map((e) => [e.ledgerEffect, e.amount])).toEqual(
        expect.arrayContaining([
          ["RETURNED", { amountMinor: 35_000, currency: "USD" }],
          ["RETURNED", { amountMinor: 15_000, currency: "USD" }],
        ]),
      );
    });

    it("an orphan authorization and its void never reach a total", async () => {
      const id = await teamMilestone();
      const [, anas] = await fund(id);
      ctx.payments.tamperOrderAmount(anas?.paypalOrderId ?? "", 14_999);
      await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: anas?.paypalOrderId }).expect(409);
      const job = ctx.jobs.of("payments.authorization.void-orphan").find((j) => j.data.milestoneId === id);
      expect(await ctx.milestones.processVoidOrphan(id, job?.data.authorizationId as string, job?.data.requestId as string)).toBe("VOIDED");
      const { items } = await ledger(buyer);
      expect(items.filter((e) => e.type === "VOIDED").map((e) => e.ledgerEffect)).toEqual(["NONE"]);
      expect(sum(items, "PAID") + sum(items, "RETURNED")).toBe(0);
    });
  });

  describe("breaking it (ADR-0017)", () => {
    it("a release in flight counts for nothing until PayPal confirms: a crash here leaves no false total", async () => {
      const id = await funded();
      await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
      const runId = await submit(id);
      await verdicts(id, runId, { 3: "FAIL" });
      ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
      await ctx.milestones.expireWindow(id, runId);
      // The worker never ran, as after a kill -9 between the decision and the capture.
      const { items } = await ledger(buyer);
      expect(items.filter((e) => e.type === "CAPTURE_REQUESTED").map((e) => e.ledgerEffect)).toEqual(["NONE", "NONE"]);
      expect(sum(items, "PAID")).toBe(0);
      // The retried job finishes it, and only then the money counts.
      await captureAll(id);
      expect(sum((await ledger(buyer)).items, "PAID")).toBe(45_000);
    });

    it("a capture job delivered twice adds one row and one amount", async () => {
      const { id } = await paidNinety();
      await captureAll(id);
      const { items } = await ledger(buyer);
      expect(items.filter((e) => e.type === "CAPTURED")).toHaveLength(2);
      expect(sum(items, "PAID")).toBe(45_000);
    });

    it("reads racing a release always see a whole number of facts, and never more than was funded", async () => {
      const id = await funded();
      await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
      const runId = await submit(id);
      await verdicts(id, runId, { 3: "FAIL" });
      ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
      await ctx.milestones.expireWindow(id, runId);
      const reads = Array.from({ length: 8 }, () => ledger(buyer));
      await captureAll(id);
      for (const page of await Promise.all(reads)) expect([0, 13_500, 31_500, 45_000]).toContain(sum(page.items, "PAID"));
    });
  });

  describe("why it was paid", () => {
    it("records the run on the release and shows its verdicts and report hash", async () => {
      const { id, runId } = await paidNinety();
      const [release] = await ctx.db.select().from(releases).where(eq(releases.milestoneId, id));
      expect(release?.runId).toBe(runId);
      const paid = (await ledger(buyer)).items.find((e) => e.ledgerEffect === "PAID");
      expect(paid?.reportHash).toBe(`hash-${runId}`);
      expect(paid?.criteria.map((c) => [c.title, c.weightBps, c.verdict, c.humanApproved])).toEqual([
        ["Checkout answers", 4_000, "PASS", false],
        ["Cart answers", 3_000, "PASS", false],
        ["Search answers", 2_000, "PASS", false],
      ]);
    });

    it("the second release shows only what it added, with the verdict of its own run", async () => {
      const { id } = await paidNinety();
      const secondRun = await submit(id);
      await verdicts(id, secondRun);
      ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
      expect((await ctx.milestones.expireWindow(id, secondRun)).applied).toBeTruthy();
      await captureAll(id);
      const paid = (await ledger(buyer)).items.filter((e) => e.ledgerEffect === "PAID");
      expect(sum(paid, "PAID")).toBe(50_000);
      const [second] = await ctx.db.select({ id: releases.id }).from(releases).where(eq(releases.runId, secondRun));
      const rows = paid.filter((e) => e.releaseId === second?.id);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(row.criteria.map((c) => [c.title, c.verdict])).toEqual([["Docs answer", "PASS"]]);
    });

    it("a later version of the contract does not rename what an old payment paid for (DM-INV-2)", async () => {
      const { id } = await paidNinety();
      const [row] = await ctx.db.select({ contractId: milestones.contractId, locked: milestones.lockedVersionId }).from(milestones).where(eq(milestones.id, id));
      const [locked] = await ctx.db.select().from(contractVersions).where(eq(contractVersions.id, row?.locked ?? ""));
      const old = locked?.snapshot as ContractSnapshot;
      const renamed: ContractSnapshot = { ...old, title: "Renamed", milestones: old.milestones.map((m) => ({ ...m, title: "Renamed", criteria: m.criteria.map((c) => ({ ...c, text: "Renamed" })) })) };
      const [next] = await ctx.db.insert(contractVersions).values({ contractId: row?.contractId ?? "", version: 2, status: "DRAFT", snapshot: renamed, createdBy: { type: "USER", id: buyer } }).returning({ id: contractVersions.id });
      await ctx.db.update(contracts).set({ currentVersionId: next?.id }).where(eq(contracts.id, row?.contractId ?? ""));
      const paid = (await ledger(buyer)).items.find((e) => e.ledgerEffect === "PAID");
      expect(paid).toMatchObject({ contractTitle: "Checkout redesign", milestoneTitle: "Checkout" });
      expect(paid?.criteria[0]?.title).toBe("Checkout answers");
    });

    it("a release from before this column shows the criteria without inventing a verdict", async () => {
      const { id } = await paidNinety();
      await ctx.db.update(releases).set({ runId: null }).where(eq(releases.milestoneId, id));
      const paid = (await ledger(buyer)).items.find((e) => e.ledgerEffect === "PAID");
      expect(paid?.criteria.map((c) => c.verdict)).toEqual([null, null, null]);
      expect(paid?.reportHash).toBeNull();
    });
  });

  describe("who sees what (ADR-0009, decision 6)", () => {
    it("every role gets exactly the facts of /payment-events, so the two reads never drift", async () => {
      const { id } = await paidNinety();
      for (const who of [buyer, seller, ana]) {
        const single = (await as(ctx, who).get(`/milestones/${id}/payment-events`).expect(200)).body as { id: string }[];
        const all = (await ledger(who)).items.map((e) => e.id);
        expect(all.sort()).toEqual(single.map((e) => e.id).sort());
      }
    });

    it("a collaborator sees only their own money, and the buyer's name beside it", async () => {
      await paidNinety();
      const { items } = await ledger(ana);
      expect(items.length).toBeGreaterThan(0);
      expect(sum(items, "PAID")).toBe(13_500);
      for (const e of items) expect(e.myRole).toBe("COLLABORATOR");
      expect(items[0]?.counterpartyName).toBe("BUYER");
    });

    it("the buyer sees who each part paid, not only the seller", async () => {
      await paidNinety();
      const paid = (await ledger(buyer)).items.filter((e) => e.ledgerEffect === "PAID");
      expect(paid.map((e) => e.counterpartyName).sort()).toEqual(["COLLABORATOR", "SELLER"]);
    });

    it("a reviewer or an admin who is no party sees nothing", async () => {
      await paidNinety();
      for (const roles of [["REVIEWER"], ["ADMIN"]] as const) {
        const outsider = await createUser(ctx.db, [...roles]);
        expect((await ledger(outsider)).items).toEqual([]);
      }
    });

    it("someone with a hold who is no longer a party sees nothing of it, like /payment-events", async () => {
      await paidNinety();
      await ctx.db.delete(contractParties).where(eq(contractParties.userId, ana));
      expect((await ledger(ana)).items).toEqual([]);
    });
  });

  describe("the PayPal link (paypalUrl)", () => {
    const captures = (items: Entry[]) => items.filter((e) => e.type === "CAPTURED");

    it("the buyer gets every capture searched in their own activity, because PayPal gives them another id", async () => {
      await paidNinety();
      const mine = captures((await ledger(buyer)).items);
      expect(mine).toHaveLength(2);
      for (const e of mine) expect(e.paypalUrl).toMatch(new RegExp(`^${TEST_PAYPAL_WEB_BASE}/myaccount/activities/\\?free_text_search=${e.paypalId ?? ""}&start_date=\\d{4}-\\d{2}-\\d{2}&end_date=\\d{4}-\\d{2}-\\d{2}$`));
    });

    it("each payee gets their own capture directly, and no link to the other member's", async () => {
      await paidNinety();
      const sellerSide = captures((await ledger(seller)).items);
      const anaSide = captures((await ledger(ana)).items);
      expect(anaSide).toHaveLength(1);
      const anaCapture = anaSide[0];
      expect(anaCapture?.paypalUrl).toBe(`${TEST_PAYPAL_WEB_BASE}/activity/payment/${anaCapture?.paypalId ?? ""}`);
      // The seller sees both captures, but Ana's is not in the seller's PayPal.
      const own = sellerSide.filter((e) => e.counterpartyName === "BUYER" && e.paypalId !== anaCapture?.paypalId);
      expect(own).toHaveLength(1);
      expect(own[0]?.paypalUrl).toBe(`${TEST_PAYPAL_WEB_BASE}/activity/payment/${own[0]?.paypalId ?? ""}`);
      expect(sellerSide.find((e) => e.paypalId === anaCapture?.paypalId)?.paypalUrl).toBeNull();
    });

    it("an order id gets no link: the buyer's search does not find it", async () => {
      await paidNinety();
      for (const e of (await ledger(buyer)).items.filter((x) => x.paypalIdKind === "ORDER")) expect(e.paypalUrl).toBeNull();
    });

    it("/payment-events gives every role the same link as the ledger, so the receipt and the grid agree", async () => {
      const { id } = await paidNinety();
      for (const who of [buyer, seller, ana]) {
        const single = (await as(ctx, who).get(`/milestones/${id}/payment-events`).expect(200)).body as { id: string; paypalUrl: string | null }[];
        const byId = new Map((await ledger(who)).items.map((e) => [e.id, e.paypalUrl]));
        for (const e of single) expect(e.paypalUrl).toBe(byId.get(e.id));
      }
    });
  });

  describe("the range", () => {
    const dayOf = (iso: string) => iso.slice(0, 10);

    it("includes both ends and leaves out what is outside", async () => {
      await paidNinety();
      const { items } = await ledger(buyer);
      const day = dayOf(items[0]?.occurredAt ?? "");
      expect((await ledger(buyer, `from=${day}&to=${day}`)).items.length).toBeGreaterThan(0);
      expect((await ledger(buyer, "from=2000-01-01&to=2000-01-02")).items).toEqual([]);
    });

    it("answers newest first, with a stable order inside one instant", async () => {
      await paidNinety();
      const { items } = await ledger(buyer);
      const times = items.map((e) => e.occurredAt);
      expect(times).toEqual([...times].sort().reverse());
      expect((await ledger(buyer)).items.map((e) => e.id)).toEqual(items.map((e) => e.id));
    });

    it.each(["from=2026-02-01&to=2026-01-01", "from=nope&to=2026-01-01", "from=2026-02-31&to=2026-03-01", "to=2026-01-01", "", "from=0000-01-01&to=2026-01-01", "from=2026-01-01&to=9999-12-31"])("refuses %j", async (query) => {
      const res = await as(ctx, buyer).get(`/payments?${query}`).expect(422);
      expect(res.body).toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("says it is truncated past the limit, so a partial total never looks complete", async () => {
      const { id } = await paidNinety();
      await ctx.db.insert(paymentEvents).values(
        Array.from({ length: 1_000 }, () => ({ milestoneId: id, type: "DISPUTE_OPENED" as const, idempotencyKey: `truncation-${randomUUID()}`, source: "WEBHOOK" as const, occurredAt: new Date() })),
      );
      const page = await ledger(buyer);
      expect(page.truncated).toBe(true);
      expect(page.items).toHaveLength(1_000);
    });
  });

  it("needs a signed-in caller", async () => {
    const { default: request } = await import("supertest");
    await request(ctx.app.getHttpServer()).get(`/v1/payments?${WIDE}`).expect(401);
  });

  it("reads only: asking twice moves nothing", async () => {
    const { id } = await paidNinety();
    const before = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.milestoneId, id));
    await ledger(buyer);
    await ledger(buyer);
    const after = await ctx.db.select().from(paymentEvents).where(eq(paymentEvents.milestoneId, id));
    expect(after).toEqual(before);
  });
});
