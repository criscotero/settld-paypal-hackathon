// ADR-0011: the mail to the buyer when a milestone waits for their decision. The mail server and
// the Engine are fakes; each job is run by hand, so every step is visible.
import { eq } from "drizzle-orm";
import { MAX_INVITATIONS_PER_DAY } from "../src/contracts/invitations.service.js";
import { invitations, notifications, users } from "../src/db/schema.js";
import type { DecisionNeededJob } from "../src/notifications/notifications.service.js";
import { approvedContract, as, bootTestApp, createUser, draftBody } from "./support/app.js";
import type { TestContext } from "./support/app.js";

const COUNTDOWN_SECONDS = 3_600;
const probe = { checkType: "HTTP_PROBE", checkConfig: { url: "https://example.com/", method: "GET", expectStatus: 200 } };
const ai = { checkType: "AI_REQUIREMENT_MET", checkConfig: { sources: ["HTTP_RESPONSE"], guidance: "All three plans are listed" } };

function body(withAi = true) {
  return draftBody({
    terms: { releaseCountdownSeconds: COUNTDOWN_SECONDS, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
    milestones: [
      {
        title: "Published page",
        amount: { amountMinor: 10_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: withAi
          ? [
              { text: "The page answers", level: "AUTOMATIC", required: true, weightBps: 7_000, ...probe },
              { text: "It lists the three plans", level: "AI_EVALUATED", required: true, weightBps: 3_000, ...ai },
            ]
          : [{ text: "The page answers", level: "AUTOMATIC", required: true, weightBps: 10_000, ...probe }],
      },
    ],
  });
}

interface MilestoneBody {
  state: string;
  criteria: { id: string }[];
}

describe("the decision.needed mail (ADR-0011)", () => {
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
    ctx.emails.sent.length = 0;
    ctx.emails.failNext = false;
    ctx.engine.down = false;
  });

  const get = async (id: string) => (await as(ctx, buyer).get(`/milestones/${id}`).expect(200)).body as MilestoneBody;

  async function delivered(withAi = true) {
    const { milestoneIds } = await approvedContract(ctx, buyer, seller, body(withAi));
    const id = milestoneIds[0] ?? "";
    const order = await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200);
    await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId: (order.body as { paypalOrderId: string }).paypalOrderId }).expect(200);
    await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
    const res = await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com/" }] }).expect(201);
    return { id, runId: (res.body as { runId: string }).runId };
  }

  async function verified(withAi = true, aiVerdict: "PASS" | "FAIL" | "UNCERTAIN" = "FAIL") {
    const { id, runId } = await delivered(withAi);
    const m = await get(id);
    const results = m.criteria.map((c, i) => {
      const verdict = i === 0 ? ("PASS" as const) : aiVerdict;
      return { criterionId: c.id, verdict, evidenceRefCount: verdict === "PASS" ? 1 : 0 };
    });
    await ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results });
    ctx.engine.reports.set(runId, {
      runId,
      status: "COMPLETED",
      reportHash: "sha256:abc",
      results: results.map((r) => ({ ...r, evidence: [], reason: r.verdict === "FAIL" ? "Only two plans appear on the page." : "It answers 200." })),
    });
    return { id, runId, m: await get(id) };
  }

  const job = (runId: string) => ctx.jobs.of("notifications.send").find((j) => j.data.templateKey === "decision.needed" && (j.data.params as { runId: string }).runId === runId);
  const run = async (runId: string) => {
    const j = job(runId);
    if (j === undefined) throw new Error("no decision.needed job");
    return ctx.notifications.process(j.data as unknown as DecisionNeededJob);
  };

  it("when the AI says FAIL, the buyer gets the report and the direct link", async () => {
    const { id, runId } = await verified();
    expect(await run(runId)).toBe("SENT");

    const [buyerRow] = await ctx.db.select().from(users).where(eq(users.id, buyer));
    const [mail] = ctx.emails.sent;
    expect(mail?.to).toBe(buyerRow?.email);
    expect(mail?.subject).toMatch(/problem/i);
    expect(mail?.text).toContain("Only two plans appear on the page.");
    expect(mail?.text).toContain(`#milestone-${id}`);
    expect(ctx.emails.sent).toHaveLength(1);
  });

  it("also when the AI is not sure: that part is not paid either if nobody decides", async () => {
    const { runId } = await verified(true, "UNCERTAIN");
    expect(await run(runId)).toBe("SENT");
  });

  it("a contract with nothing to decide sends no such mail", async () => {
    const { runId } = await verified(false);
    expect(job(runId)).toBeUndefined();
  });

  // Audit finding 1: a required automatic check that could not answer held back the whole round.
  it("an automatic check that could not answer waits for the buyer, who can approve it", async () => {
    const { id, runId } = await delivered(false);
    const criterionId = (await get(id)).criteria[0]?.id ?? "";
    await ctx.milestones.applyRunCompleted({ runId, status: "COMPLETED", results: [{ criterionId, verdict: "UNCERTAIN", evidenceRefCount: 0 }] });
    expect((await get(id)).state).toBe("OBJECTION_WINDOW");
    expect((job(runId)?.data.params as { pendingCriterionIds: string[] }).pendingCriterionIds).toEqual([criterionId]);

    await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [{ criterionId, decision: "APPROVED" }] }).expect(200);
    expect((await get(id)).state).toBe("RELEASED");
  });

  it("the job is written with the transition that opened the countdown", async () => {
    const { runId, m } = await verified();
    expect(m.state).toBe("OBJECTION_WINDOW");
    expect(job(runId)?.singletonKey).toBe(`notify:decision.needed:${runId}`);
  });

  // Attack 2 of ADR-0011.
  it("the same job delivered twice sends one mail", async () => {
    const { runId } = await verified();
    expect(await run(runId)).toBe("SENT");
    expect(await run(runId)).toBe("ALREADY_SENT");
    expect(ctx.emails.sent).toHaveLength(1);
  });

  // Attack 1 of ADR-0011.
  it("does not ask for a decision the buyer already took", async () => {
    const { id, runId, m } = await verified();
    await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [{ criterionId: m.criteria[1]?.id, decision: "APPROVED" }] }).expect(200);

    expect(await run(runId)).toBe("SUPPRESSED");
    expect(ctx.emails.sent).toEqual([]);
    const [row] = await ctx.db.select().from(notifications).where(eq(notifications.dedupeKey, `decision-needed:${runId}`));
    expect(row?.status).toBe("SUPPRESSED");
  });

  it("does not ask once the countdown is over", async () => {
    const { runId } = await verified();
    ctx.clock.advance((COUNTDOWN_SECONDS + 1) * 1000);
    expect(await run(runId)).toBe("SUPPRESSED");
    expect(ctx.emails.sent).toEqual([]);
  });

  // Attack 3 of ADR-0011: dying between sending and recording is the same as a failed attempt.
  it("a mail server that fails leaves it PENDING, and the retry sends it", async () => {
    const { runId } = await verified();
    ctx.emails.failNext = true;
    await expect(run(runId)).rejects.toThrow("mail server down");
    const [row] = await ctx.db.select().from(notifications).where(eq(notifications.dedupeKey, `decision-needed:${runId}`));
    expect(row?.status).toBe("PENDING");
    expect(row?.reason).toBe("mail server down"); // why it is stuck, for whoever goes looking

    expect(await run(runId)).toBe("SENT");
    expect(ctx.emails.sent).toHaveLength(1);
  });

  it("an Engine that is down does not stop the warning: it just has no reasons", async () => {
    const { runId } = await verified();
    ctx.engine.down = true;
    expect(await run(runId)).toBe("SENT");
    expect(ctx.emails.sent[0]?.text).toMatch(/open settld/i);
    expect(ctx.emails.sent[0]?.text).not.toContain("Only two plans");
  });

  it("the money does not depend on the mail: failing to send changes no state", async () => {
    const { id, runId } = await verified();
    ctx.emails.failNext = true;
    await expect(run(runId)).rejects.toThrow();
    expect((await get(id)).state).toBe("OBJECTION_WINDOW");
  });

  it("other templates are not sent yet", async () => {
    await expect(ctx.notifications.process({ templateKey: "milestone.funded", recipientIds: [buyer], deepLink: "/contracts/x", params: {} })).resolves.toBe("IGNORED");
    expect(ctx.emails.sent).toEqual([]);
  });

  // ADR-0013: the silences that decide about money or block the flow.
  describe("window.opened", () => {
    const opened = (runId: string) => ctx.jobs.of("notifications.send").find((j) => j.singletonKey === `notify:window.opened:${runId}`);
    const runOpened = async (runId: string) => {
      const j = opened(runId);
      if (j === undefined) throw new Error("no window.opened job");
      return ctx.notifications.process(j.data as never);
    };
    const emailOf = async (id: string) => (await ctx.db.select().from(users).where(eq(users.id, id)))[0]?.email;

    it("with nothing to decide, the buyer is told money moves when the countdown ends", async () => {
      const { runId } = await verified(false);
      expect(await runOpened(runId)).toBe("SENT");
      expect(ctx.emails.sent.map((m) => m.to).sort()).toEqual([await emailOf(buyer), await emailOf(seller)].sort());
      const toBuyer = ctx.emails.sent.find((m) => m.text.includes("ask the seller to fix"));
      expect(toBuyer?.to).toBe(await emailOf(buyer));
    });

    it("with something to decide, the buyer gets one mail and the seller still hears", async () => {
      const { runId } = await verified();
      await runOpened(runId);
      expect(ctx.emails.sent.map((m) => m.to)).toEqual([await emailOf(seller)]);
      await run(runId);
      expect(ctx.emails.sent.map((m) => m.to)).toEqual([await emailOf(seller), await emailOf(buyer)]);
    });

    it("a repeated job sends nothing new, and a retry only finishes who is missing", async () => {
      const { runId } = await verified(false);
      await runOpened(runId);
      await runOpened(runId);
      expect(ctx.emails.sent).toHaveLength(2);
    });

    it("does not announce a countdown that already ended", async () => {
      const { runId, id } = await verified(false);
      await as(ctx, buyer).post(`/milestones/${id}/approve`, { humanDecisions: [] }).expect(200);
      expect(await runOpened(runId)).toBe("SUPPRESSED");
      expect(ctx.emails.sent).toEqual([]);
    });
  });

  describe("objection.raised", () => {
    const objected = async () => {
      const { id, m } = await verified();
      const reason = "Only two plans appear, see https://evil.example/login for proof.";
      await as(ctx, buyer).post(`/milestones/${id}/objections`, { criterionIds: [m.criteria[1]?.id], reason }).expect(201);
      const job = ctx.jobs.of("notifications.send").find((j) => j.data.templateKey === "objection.raised" && (j.data.params as { milestoneId: string }).milestoneId === id);
      if (job === undefined) throw new Error("no objection.raised job");
      return { id, job };
    };

    it("tells the seller what to fix, without the buyer's links", async () => {
      const { id, job } = await objected();
      expect(await ctx.notifications.process(job.data as never)).toBe("SENT");
      const [mail] = ctx.emails.sent;
      expect(mail?.text).toContain("Only two plans appear");
      expect(mail?.text).not.toContain("evil.example");
      expect(mail?.text).toContain(`#milestone-${id}`);
    });

    it("says nothing once the objection is withdrawn", async () => {
      const { id, job } = await objected();
      const m = await as(ctx, buyer).get(`/milestones/${id}`).expect(200);
      const b = m.body as { openObjectionId: string; criteria: { id: string }[] };
      await as(ctx, buyer).post(`/objections/${b.openObjectionId}:withdraw`, { humanDecisions: [{ criterionId: b.criteria[1]?.id, decision: "APPROVED" }] }).expect(200);
      expect(await ctx.notifications.process(job.data as never)).toBe("SUPPRESSED");
      expect(ctx.emails.sent).toEqual([]);
    });
  });

  describe("invitation.sent", () => {
    const invite = async (email: string) => {
      const created = await as(ctx, buyer).post("/contracts", body(false)).expect(201);
      const contractId = (created.body as { id: string }).id;
      await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email }).expect(202);
      const job = ctx.jobs.of("notifications.send").filter((j) => j.data.templateKey === "invitation.sent").at(-1);
      if (job === undefined) throw new Error("no invitation.sent job");
      return { contractId, job };
    };

    it("reaches someone with no account, and never carries the token", async () => {
      const { job } = await invite("new.person@example.com");
      const token = ctx.invitations.lastToken();
      expect(JSON.stringify(job.data)).not.toContain(token);
      expect(await ctx.notifications.process(job.data as never)).toBe("SENT");
      const [mail] = ctx.emails.sent;
      expect(mail?.to).toBe("new.person@example.com");
      expect(mail?.text).toContain("new.person@example.com");
      expect(mail?.text).toContain("/invitations");
      expect(`${mail?.text ?? ""}${mail?.html ?? ""}`).not.toContain(token);
    });

    it("the same job delivered twice sends one mail", async () => {
      const { job } = await invite("twice@example.com");
      await ctx.notifications.process(job.data as never);
      expect(await ctx.notifications.process(job.data as never)).toBe("ALREADY_SENT");
      expect(ctx.emails.sent).toHaveLength(1);
    });

    it("does not invite someone who already accepted", async () => {
      const { job } = await invite("accepted@example.com");
      await as(ctx, seller).post(`/invitations/${ctx.invitations.lastToken()}:accept`).expect(200);
      expect(await ctx.notifications.process(job.data as never)).toBe("SUPPRESSED");
    });

    // Live test, 2026-11-07: a buyer unsure the first invitation went out sent it three times.
    it("inviting the same address again renews the one invitation and mails it again", async () => {
      const { contractId, job: first } = await invite("again@example.com");
      await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email: "AGAIN@example.com" }).expect(202);
      const rows = await ctx.db.select().from(invitations).where(eq(invitations.contractId, contractId));
      expect(rows).toHaveLength(1);
      const second = ctx.jobs.of("notifications.send").filter((j) => j.data.templateKey === "invitation.sent").at(-1);
      expect(second?.singletonKey).not.toBe(first.singletonKey);
      expect(await ctx.notifications.process(first.data as never)).toBe("SENT");
      expect(await ctx.notifications.process(second?.data as never)).toBe("SENT");
      expect(ctx.emails.sent).toHaveLength(2);
    });

    // 2026-11-06: a mail to the seeded admin bounced back to the sender's inbox.
    it("records a mail to a seeded address as SUPPRESSED and sends nothing", async () => {
      const { job } = await invite("admin@dev.settld.app");
      expect(await ctx.notifications.process(job.data as never)).toBe("SUPPRESSED");
      expect(ctx.emails.sent).toEqual([]);
    });

    it("counts a resend toward the daily limit, so renewing cannot mail without limit", async () => {
      const created = await as(ctx, buyer).post("/contracts", body(false)).expect(201);
      const contractId = (created.body as { id: string }).id;
      for (let i = 0; i < MAX_INVITATIONS_PER_DAY; i++) await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email: "same@example.com" }).expect(202);
      const refused = await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email: "same@example.com" }).expect(429);
      expect((refused.body as { code: string }).code).toBe("RATE_LIMITED");
    });

    it("stops at the daily limit, and says when to come back", async () => {
      const created = await as(ctx, buyer).post("/contracts", body(false)).expect(201);
      const contractId = (created.body as { id: string }).id;
      for (let i = 0; i < MAX_INVITATIONS_PER_DAY; i++) await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email: `p${String(i)}@example.com` }).expect(202);
      const refused = await as(ctx, buyer).post(`/contracts/${contractId}/invitations`, { email: "one.more@example.com" }).expect(429);
      expect((refused.body as { code: string }).code).toBe("RATE_LIMITED");
      expect(refused.headers["retry-after"]).toBe("86400");
    });
  });
});
