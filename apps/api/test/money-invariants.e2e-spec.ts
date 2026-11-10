// The money invariants Postgres enforces by itself (migrations 0004, 0005 and 0012; ADR-0007, ADR-0009).
// These tests write rows directly, as a buggy code path or a manual psql session would,
// and expect the database to refuse. The service never relies on these to behave.
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { holds, milestones, paymentEvents, releaseParts, releases } from "../src/db/schema.js";
import { approvedContract, bootTestApp, createUser } from "./support/app.js";
import type { TestContext } from "./support/app.js";

// Drizzle wraps driver errors; the Postgres message is on the cause.
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error("expected the database to refuse");
}

describe("Money invariants in the database", () => {
  let ctx: TestContext;
  let milestoneId: string;
  let holdId: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
  });
  afterAll(async () => {
    await ctx.close();
  });

  // A milestone funded with USD 500.00 by the seller's hold alone, written directly (H2
  // transitions are tested elsewhere). Hold and milestone in one transaction: 0012 checks at
  // commit that they agree.
  beforeEach(async () => {
    const seller = await createUser(ctx.db, ["SELLER"]);
    const { milestoneIds } = await approvedContract(ctx, await createUser(ctx.db, ["BUYER"]), seller);
    milestoneId = milestoneIds[0] ?? "";
    holdId = await ctx.db.transaction(async (tx) => {
      const [h] = await tx
        .insert(holds)
        .values({ milestoneId, payeeUserId: seller, payeeMerchantId: "MERCHANT-1", position: 0, shareBps: 10_000, fundedMinor: 50_000, holdStatus: "AUTHORIZED", authorizationId: "AUTH-1" })
        .returning();
      await tx.update(milestones).set({ state: "FUNDED", holdStatus: "AUTHORIZED", fundedMinor: 50_000 }).where(eq(milestones.id, milestoneId));
      return h?.id ?? "";
    });
  });

  // Releases 45 000 the way the service does: the hold and the milestone together.
  const releaseOnBoth = (amountMinor: number) =>
    ctx.db.transaction(async (tx) => {
      await tx.update(holds).set({ releasedMinor: amountMinor }).where(eq(holds.id, holdId));
      await tx.update(milestones).set({ releasedMinor: amountMinor }).where(eq(milestones.id, milestoneId));
    });

  const release = (seq: number, status: "PENDING" | "CAPTURED" = "PENDING") =>
    ctx.db.insert(releases).values({ milestoneId, seq, transitionId: "SM-T18", amountMinor: 100, currency: "USD", platformFeeMinor: 0, countedBps: 100, final: false, status }).returning();

  it("SM-INV-9: refuses releasing more than was funded", async () => {
    const msg = await refusal(ctx.db.update(milestones).set({ releasedMinor: 50_001 }).where(eq(milestones.id, milestoneId)));
    expect(msg).toContain("milestones_conservation_ck");
  });

  it("SM-INV-9: refuses a terminal state whose money is not fully settled", async () => {
    const msg = await refusal(
      ctx.db.update(milestones).set({ state: "RELEASED", holdStatus: "CAPTURE_PENDING", releasedMinor: 45_000 }).where(eq(milestones.id, milestoneId)),
    );
    expect(msg).toContain("milestones_terminal_settled_ck");
  });

  it("refuses a holdStatus the state does not allow", async () => {
    const msg = await refusal(ctx.db.update(milestones).set({ holdStatus: "CAPTURED" }).where(eq(milestones.id, milestoneId)));
    expect(msg).toContain("milestones_state_hold_ck");
  });

  it("SM-INV-10: released_minor never decreases, on the milestone or on a hold", async () => {
    await releaseOnBoth(45_000);
    expect(await refusal(ctx.db.update(milestones).set({ releasedMinor: 44_999 }).where(eq(milestones.id, milestoneId)))).toContain("SM-INV-10");
    expect(await refusal(ctx.db.update(holds).set({ releasedMinor: 44_999 }).where(eq(holds.id, holdId)))).toContain("SM-INV-10");
  });

  // ADR-0009: a bug that moves the milestone's money without its holds (or the other way round)
  // is refused at commit, whichever side it forgot.
  it("SM-INV-9 across tables: the milestone's money must equal the sum of its holds", async () => {
    expect(await refusal(ctx.db.update(milestones).set({ releasedMinor: 45_000 }).where(eq(milestones.id, milestoneId)))).toContain("SM-INV-9");
    expect(await refusal(ctx.db.update(holds).set({ releasedMinor: 45_000 }).where(eq(holds.id, holdId)))).toContain("SM-INV-9");
    await expect(releaseOnBoth(45_000)).resolves.toBeUndefined();
  });

  it("SM-INV-9 per hold: a hold never releases more than it was funded with", async () => {
    expect(await refusal(ctx.db.update(holds).set({ releasedMinor: 50_001 }).where(eq(holds.id, holdId)))).toContain("holds_conservation_ck");
  });

  it("SM-INV-11: at most one capture in flight per milestone", async () => {
    await release(1);
    expect(await refusal(release(2))).toContain("releases_one_pending_uq");
  });

  it("allows the next release once the previous one was captured", async () => {
    await release(1, "CAPTURED");
    await expect(release(2)).resolves.toHaveLength(1);
  });

  it("SM-INV-1: one CAPTURED fact per release part", async () => {
    const [r] = await release(1);
    if (r === undefined) throw new Error("fixture");
    const [part] = await ctx.db.insert(releaseParts).values({ releaseId: r.id, holdId, amountMinor: 100, platformFeeMinor: 0 }).returning();
    if (part === undefined) throw new Error("fixture");
    const captured = () =>
      ctx.db.insert(paymentEvents).values({ milestoneId, releaseId: r.id, holdId, releasePartId: part.id, type: "CAPTURED", idempotencyKey: randomUUID(), source: "API_RESPONSE", occurredAt: new Date() });
    await captured();
    expect(await refusal(captured())).toContain("payment_events_one_capture_uq");
  });

  it("DM-INV-5: the payment ledger is append-only", async () => {
    const [e] = await ctx.db
      .insert(paymentEvents)
      .values({ milestoneId, type: "AUTHORIZED", idempotencyKey: randomUUID(), source: "API_RESPONSE", occurredAt: new Date() })
      .returning();
    if (e === undefined) throw new Error("fixture");
    expect(await refusal(ctx.db.update(paymentEvents).set({ source: "WEBHOOK" }).where(eq(paymentEvents.id, e.id)))).toContain("DM-INV-5");
    expect(await refusal(ctx.db.delete(paymentEvents).where(eq(paymentEvents.id, e.id)))).toContain("DM-INV-5");
    expect(await refusal(ctx.db.execute(sql`TRUNCATE core.payment_events`))).toContain("DM-INV-5");
  });
});
