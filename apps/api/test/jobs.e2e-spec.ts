// pg-boss as the JobScheduler (ADR-0007, step 6): jobs are rows in our transaction, so a
// crash can lose neither a job nor a state change, and never leaves one without the other.
// The service here is built by hand with the real pg-boss scheduler; the app (bootTestApp)
// only sets up a delivered milestone through the HTTP API.
import { eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { releaseParts, releases } from "../src/db/schema.js";
import type { CriterionVerdict } from "../src/db/schema.js";
import { FakePaymentProvider } from "../src/payments/fake-payment-provider.js";
import { MilestonesService } from "../src/payments/milestones.service.js";
import { startPaymentWorkers } from "../src/payments/payment-workers.js";
import { createBoss, ensureQueues, PgBossJobScheduler } from "../src/payments/pg-boss-job-scheduler.js";
import { approvedContract, as, bootTestApp, createUser, draftBody, testDatabaseUrl } from "./support/app.js";
import type { TestContext } from "./support/app.js";

const http = (url: string) => ({ checkType: "HTTP_PROBE", checkConfig: { url } });
const body = () =>
  draftBody({
    terms: { releaseCountdownSeconds: 60, silenceIsApproval: true, fundingMode: "ONE_AT_A_TIME" },
    milestones: [
      {
        title: "Checkout",
        amount: { amountMinor: 50_000, currency: "USD" },
        dueDate: "2099-01-31",
        criteria: [
          { text: "Checkout answers", level: "AUTOMATIC", required: true, weightBps: 9_000, ...http("https://example.com/a") },
          { text: "Docs answer", level: "AUTOMATIC", required: false, weightBps: 1_000, ...http("https://example.com/b") },
        ],
      },
    ],
  });

async function until(check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out waiting");
}

describe("Jobs on pg-boss", () => {
  let ctx: TestContext;
  let boss: PgBoss;
  let provider: FakePaymentProvider;
  let service: MilestonesService;
  let scheduler: PgBossJobScheduler;

  beforeAll(async () => {
    ctx = await bootTestApp();
    boss = createBoss(testDatabaseUrl());
    await boss.start(); // installs pg-boss in the `pgboss` schema on first run
    await ensureQueues(boss);
    provider = ctx.payments; // same fake PayPal as the app, so funding and capture agree
    scheduler = new PgBossJobScheduler(boss);
    service = new MilestonesService(ctx.db, provider, scheduler, ctx.clock, "http://localhost:3000");
  });
  afterAll(async () => {
    await boss.stop({ graceful: false });
    await ctx.close();
  });

  const jobRows = (queue: string, key: string) =>
    ctx.db.execute(sql`SELECT state FROM pgboss.job WHERE name = ${queue} AND singleton_key = ${key}`).then((r) => r.rows as { state: string }[]);

  // A milestone whose countdown is over, with the 10% criterion failed.
  async function countdownOver() {
    const buyer = await createUser(ctx.db, ["BUYER"]);
    const seller = await createUser(ctx.db, ["SELLER"]);
    const { milestoneIds } = await approvedContract(ctx, buyer, seller, body());
    const id = milestoneIds[0] ?? "";
    const { paypalOrderId } = (await as(ctx, buyer).post(`/milestones/${id}/fund`).expect(200)).body as { paypalOrderId: string };
    await as(ctx, buyer).post(`/milestones/${id}/fund:confirm`, { paypalOrderId }).expect(200);
    await as(ctx, seller).post(`/milestones/${id}:start`).expect(200);
    const { runId } = (await as(ctx, seller).post(`/milestones/${id}/submissions`, { evidenceLinks: [{ kind: "URL", url: "https://example.com" }] }).expect(201)).body as { runId: string };
    const m = (await as(ctx, buyer).get(`/milestones/${id}`).expect(200)).body as { criteria: { id: string }[] };
    const results: CriterionVerdict[] = m.criteria.map((c, i) => ({ criterionId: c.id, verdict: i === 1 ? "FAIL" : "PASS", evidenceRefCount: i === 1 ? 0 : 1 }));
    await service.applyRunCompleted({ runId, status: "COMPLETED", results });
    ctx.clock.advance(61_000);
    return { id, runId };
  }

  it("kill -9 between the commit and the capture: the job is already a row, and a fresh worker captures once", async () => {
    const { id, runId } = await countdownOver();
    // The release commits with its capture job. No worker is running: the process "died" here.
    expect(await service.expireWindow(id, runId)).toEqual({ applied: "SM-T19" });
    const [part] = await ctx.db.select({ id: releaseParts.id }).from(releaseParts).innerJoin(releases, eq(releases.id, releaseParts.releaseId)).where(eq(releases.milestoneId, id));
    expect(await jobRows("payments.capture", `capture:${part?.id ?? ""}`)).toEqual([{ state: "created" }]);

    // The process comes back.
    await startPaymentWorkers(boss, service, 0.5);
    await until(async () => (await ctx.db.select().from(releases).where(eq(releases.milestoneId, id)))[0]?.status === "CAPTURED");
    expect(provider.captures.filter((c) => c.requestId.startsWith(`capture-${id}-1-`))).toHaveLength(1);
  });

  it("a rolled-back transaction leaves no job behind", async () => {
    const key = `rollback-${String(Date.now())}`;
    await expect(
      ctx.db.transaction(async (tx) => {
        await scheduler.send(tx, { queue: "notifications.send", singletonKey: key, data: {} });
        throw new Error("the state change failed after the job was written");
      }),
    ).rejects.toThrow(/state change failed/);
    expect(await jobRows("notifications.send", key)).toEqual([]);
  });

  it("the same singleton key twice is one job, and cancel stops a timer that has not run", async () => {
    const key = `timer-${String(Date.now())}`;
    const later = new Date(Date.now() + 3_600_000);
    await ctx.db.transaction(async (tx) => {
      await scheduler.send(tx, { queue: "objections.escalate", singletonKey: key, startAfter: later, data: {} });
      await scheduler.send(tx, { queue: "objections.escalate", singletonKey: key, startAfter: later, data: {} });
    });
    expect(await jobRows("objections.escalate", key)).toEqual([{ state: "created" }]);
    await ctx.db.transaction((tx) => scheduler.cancel(tx, "objections.escalate", key));
    expect(await jobRows("objections.escalate", key)).toEqual([{ state: "cancelled" }]);
  });

  it("PayPal captured but the answer was lost: pg-boss retries with the same key and the money moves once", async () => {
    const { id, runId } = await countdownOver();
    provider.failNext("capture", "timeoutAfterApply");
    await service.expireWindow(id, runId);
    await until(async () => (await ctx.db.select().from(releases).where(eq(releases.milestoneId, id)))[0]?.status === "CAPTURED", 20_000);
    expect(provider.calls.filter((c) => c.requestId.startsWith(`capture-${id}-1-`)).length).toBeGreaterThanOrEqual(2);
    expect(provider.captures.filter((c) => c.requestId.startsWith(`capture-${id}-1-`))).toHaveLength(1);
  }, 30_000);
});
