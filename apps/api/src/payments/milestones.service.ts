// The milestone state machine (002, ADR-0007): the only code in Settld that decides to move
// money. Every transition follows the same five steps, in one transaction:
//
//   1. SELECT the milestone row FOR UPDATE. Everyone else who wants to move this milestone
//      waits here until we commit; whatever we read after this line stays true until then.
//   2. assertAllowed: the contract (milestone-state-machine.yaml) allows this transition from
//      the current state, or 409 INVALID_TRANSITION.
//   3. Check the transition's guards, explicitly, by name (409 GUARD_FAILED with the guard id).
//   4. Write the new state with `WHERE state = <the state we read>` and stateVersion + 1.
//   5. Write the effects: audit row, outbox event, and jobs (capture, void, timers) through the
//      JobScheduler, all in the same transaction (constitution IV).
//
// PayPal is never called inside a transaction. Funding calls it before opening one (the buyer
// is waiting for the order id); captures and voids are jobs that call it after the commit and
// record the answer in a second transaction. A row lock held across a 15-second network call
// would make every other request on this milestone wait behind PayPal.
//
// Lock scope: one milestone row. H1's contract lock (ContractsService.lockContract) is taken
// only by contract-level writes, which never then lock a milestone FOR UPDATE, and nothing here
// ever locks the contract, so the two can never wait on each other in a cycle.
import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import type { Actor } from "../audit/actor.js";
import { recordAudit } from "../audit/audit.js";
import { LIVE_OBJECTION, milestoneDetail, partyRoleIn } from "../contracts/contract-view.js";
import type { Caller } from "../contracts/contracts.service.js";
import { teamOf, weightSum } from "../contracts/snapshot.js";
import type { ContractSnapshot, SnapshotMilestone } from "../contracts/snapshot.js";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import {
  contractParties,
  contracts,
  contractVersions,
  holds,
  humanCriterionDecisions,
  milestones,
  objectionMessages,
  objections,
  paymentEvents,
  releaseParts,
  releases,
  runOutcomes,
  submissions,
  users,
} from "../db/schema.js";
import type { CriterionVerdict, EvidenceLink, PartyRole } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { notFound } from "../http/params.js";
import { enqueueEvent } from "../outbox/outbox.js";
import { CLOCK, WEB_URL } from "./clock.js";
import type { Clock } from "./clock.js";
import { paypalReference } from "./ledger-entry.js";
import { PAYPAL_WEB_BASE } from "./paypal-config.js";
import { paypalUrl } from "./paypal-links.js";
import { WATCHDOG_AFTER_MS } from "../verification/timing.js";
import { JOB_SCHEDULER } from "./job-scheduler.js";
import type { JobScheduler } from "./job-scheduler.js";
import { rollup, splitFunding } from "./holds.js";
import { PAYMENT_PROVIDER, ProviderDeclinedError, ProviderUnavailableError } from "./payment-provider.js";
import type { Authorization, PaymentProvider } from "./payment-provider.js";
import { countedCriteria, decideRelease, FULL_BPS, isReleasable, platformFee } from "./release-math.js";
import type { ReleaseDecision } from "./release-math.js";
import { assertAllowed } from "./state-machine.js";

type MilestoneRow = typeof milestones.$inferSelect;
type HoldRow = typeof holds.$inferSelect;
type HoldPatch = Partial<typeof holds.$inferInsert>;

type CaptureResult = "CAPTURED" | "PENDING" | "FAILED" | "SKIPPED";
type CaptureOutcome = { kind: "answered"; captureId: string; status: "COMPLETED" | "PENDING" } | { kind: "declined"; reason: string };

// The first half of POST /fund: what PayPal answered for each hold, before anything is written.
// requestId is null for a hold already authorized: PayPal was not asked again.
export interface FundingOrder {
  readonly orders: readonly { holdId: string; requestId: string | null; paypalOrderId: string; approveUrl: string }[];
}

// What G-AUTH-MATCHES needs to know about one fund:confirm: the authorization and whose hold.
export interface Authorized {
  readonly auth: Authorization;
  readonly requestId: string;
  readonly holdId: string;
}

// Who did it, for the audit log and the outbox (constitution IX).
const userActor = (c: Caller): Actor => ({ type: "USER", id: c.user.id });
const systemActor = (job: string): Actor => ({ type: "SYSTEM", id: job });

// E-NOTIFY templates (events.md, section 4), keyed by transition.
const NOTIFY: Record<string, { template: string; to: "BOTH" | PartyRole }> = {
  "SM-T03": { template: "milestone.funded", to: "BOTH" },
  "SM-T05": { template: "milestone.submitted", to: "BUYER" },
  "SM-T11": { template: "milestone.submitted", to: "BUYER" },
  "SM-T21": { template: "milestone.submitted", to: "BUYER" },
  "SM-T06": { template: "verification.failed", to: "SELLER" },
  "SM-T23": { template: "verification.failed", to: "SELLER" },
  "SM-T08": { template: "milestone.released", to: "BOTH" },
  "SM-T09": { template: "milestone.released", to: "BOTH" },
  "SM-T12": { template: "milestone.released", to: "BOTH" },
  "SM-T13": { template: "milestone.released", to: "BOTH" },
  "SM-T18": { template: "milestone.partially_released", to: "BOTH" },
  "SM-T19": { template: "milestone.partially_released", to: "BOTH" },
  "SM-T20": { template: "milestone.partially_released", to: "BOTH" },
  "SM-T24": { template: "window.nothing_released", to: "BOTH" },
  "SM-T25": { template: "window.nothing_released", to: "BOTH" },
  "SM-T10": { template: "objection.raised", to: "SELLER" },
  "SM-T22": { template: "milestone.closed", to: "BOTH" },
  "SM-T26": { template: "verification.failed", to: "SELLER" },
  "SM-T14": { template: "milestone.voided", to: "BOTH" },
  "SM-T15": { template: "milestone.voided", to: "BOTH" },
  "SM-T17": { template: "authorization.lapsed", to: "BOTH" },
  "SM-T27": { template: "milestone.closed", to: "BOTH" },
  "SM-T28": { template: "milestone.voided", to: "BOTH" },
  "SM-T29": { template: "milestone.closed", to: "BOTH" },
};

const HOUR = 3_600_000;
// D6: the shortest release countdown a contract can have.
const MIN_COUNTDOWN_MS = 60_000;
// Two rounds of fixes did not settle it: more rounds will not either, and each one would restart
// the five days. Without this a seller can hold the buyer's money by delivering anything, and a
// buyer can avoid paying by objecting to everything (ADR-0014).
const OBJECTIONS_BEFORE_REVIEWER = 3;
const FIVE_DAYS_MS = 5 * 24 * HOUR;

function guardFailed(guard: string, title: string, detail: string, context: Record<string, unknown> = {}): ProblemException {
  return new ProblemException("GUARD_FAILED", 409, title, detail, { guard, ...context });
}

// Everything a transition needs to know about one milestone, read inside the transaction.
interface Locked {
  readonly row: MilestoneRow;
  readonly def: SnapshotMilestone;
  readonly snapshot: ContractSnapshot;
  readonly buyerId: string;
  readonly sellerId: string;
  readonly role: PartyRole | null;
  // One per team member, in team order (ADR-0009). Empty until the buyer first asks to fund.
  readonly holds: readonly HoldRow[];
}

@Injectable()
export class MilestonesService {
  private readonly log = new Logger("Milestones");

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    @Inject(JOB_SCHEDULER) private readonly jobs: JobScheduler,
    @Inject(CLOCK) private readonly clock: Clock,
    // Where PayPal sends the buyer back after approving (SETTLD_WEB_URL).
    @Inject(WEB_URL) private readonly webUrl: string,
    // The PayPal website, for the receipt's links. Null without PayPal, and by default for tests
    // that build the service by hand: no link beats a link to a fake id.
    @Inject(PAYPAL_WEB_BASE) private readonly paypalWebBase: string | null = null,
  ) {}

  // ---------------------------------------------------------------- locking and reading

  // Step 1. Locks the milestone row, then reads what the guards need. `forUpdate: false` is
  // for reads outside a transition (the funding pre-flight before calling PayPal).
  private async load(q: Db | Tx, milestoneId: string, forUpdate: boolean, viewerId: string | null): Promise<Locked> {
    const base = q.select().from(milestones).where(eq(milestones.id, milestoneId));
    const [row] = forUpdate ? await base.for("update") : await base;
    if (row === undefined) throw notFound();
    const [contract] = await q.select().from(contracts).where(eq(contracts.id, row.contractId));
    if (contract === undefined) throw new Error(`Milestone ${milestoneId} has no contract`);
    // Collaborators may read a milestone; every action below lists BUYER or SELLER explicitly.
    const role: PartyRole | null = viewerId === null ? null : await partyRoleIn(q, contract, viewerId);
    // Same answer for "missing" and "not yours" (errors.md). SYSTEM callers pass viewerId null.
    if (viewerId !== null && role === null) throw notFound();
    if (row.lockedVersionId === null || contract.sellerId === null) {
      throw new ProblemException("INVALID_TRANSITION", 409, "This milestone is not agreed yet", "Both parties must approve the contract first.", { state: row.state });
    }
    const [version] = await q.select().from(contractVersions).where(eq(contractVersions.id, row.lockedVersionId));
    const snapshot = version?.snapshot as ContractSnapshot | undefined;
    const def = snapshot?.milestones.find((m) => m.id === milestoneId);
    if (snapshot === undefined || def === undefined) throw new Error(`Milestone ${milestoneId} is missing from its locked version`);
    // Read after the milestone lock: holds are only written by someone holding it.
    const held = await q.select().from(holds).where(eq(holds.milestoneId, milestoneId)).orderBy(asc(holds.position));
    return { row, def, snapshot, buyerId: contract.buyerId, sellerId: contract.sellerId, role, holds: held };
  }

  private requireRole(m: Locked, caller: Caller, allowed: readonly (PartyRole | "ADMIN")[]) {
    const isAdmin = caller.user.roles.includes("ADMIN") && allowed.includes("ADMIN");
    if (isAdmin || (m.role !== null && allowed.includes(m.role))) return;
    throw new ProblemException("FORBIDDEN", 403, "Not your step", `Only the ${allowed.filter((r) => r !== "ADMIN").join(" or ").toLowerCase()} can do this.`);
  }

  private ifMatch(m: Locked, ifMatch: string | undefined) {
    // If-Match carries the stateVersion the person saw (errors.md, STALE_STATE). Optional in
    // the contract; when sent, a decision made on an outdated screen is refused.
    if (ifMatch !== undefined && ifMatch !== String(m.row.stateVersion)) {
      throw new ProblemException("STALE_STATE", 409, "This milestone changed since you opened it", "Reload to see where it is now.", { stateVersion: m.row.stateVersion });
    }
  }

  private authActive(row: MilestoneRow): boolean {
    // G-AUTH-ACTIVE: the hold exists and has not expired.
    return row.holdStatus === "AUTHORIZED" && row.authorizationExpiresAt !== null && this.clock.now() < row.authorizationExpiresAt;
  }

  private requireAuthActive(row: MilestoneRow) {
    if (!this.authActive(row)) {
      throw guardFailed("G-AUTH-ACTIVE", "The PayPal reservation is not active", "The money is no longer reserved in PayPal. The buyer has to fund this milestone again.");
    }
  }

  // ---------------------------------------------------------------- applying a transition

  // Steps 2, 4 and the common effects (E-AUDIT, E-EVENT, E-NOTIFY). The caller has already
  // checked the guards and writes the transition-specific effects.
  private async apply(tx: Tx, m: Locked, id: string, actor: Actor, correlationId: string, patch: Partial<typeof milestones.$inferInsert> = {}): Promise<MilestoneRow> {
    const tr = assertAllowed(id, m.row.state);
    // `WHERE state = <what we read>` is redundant under the lock, and that is the point: if a
    // future change ever forgets the lock, this turns a silent double transition into an error.
    const [after] = await tx
      .update(milestones)
      .set({ ...patch, state: tr.to, stateVersion: m.row.stateVersion + 1 })
      .where(and(eq(milestones.id, m.row.id), eq(milestones.state, m.row.state)))
      .returning();
    if (after === undefined) throw new Error(`${id}: milestone ${m.row.id} left ${m.row.state} under the lock`);

    const snap = (r: MilestoneRow) => ({ state: r.state, holdStatus: r.holdStatus, fundedMinor: r.fundedMinor, releasedMinor: r.releasedMinor, returnedMinor: r.returnedMinor });
    await recordAudit(tx, {
      actor,
      action: `milestone.transition.${id}`,
      entityType: "Milestone",
      entityId: m.row.id,
      contractId: m.row.contractId,
      before: snap(m.row),
      after: snap(after),
      requestId: correlationId,
    });
    await enqueueEvent(tx, {
      type: "payments.milestone.state_changed",
      actor,
      contractId: m.row.contractId,
      milestoneId: m.row.id,
      correlationId,
      payload: { transitionId: id, from: m.row.state, to: tr.to, event: tr.event, stateVersion: after.stateVersion },
    });
    const notify = NOTIFY[id];
    if (notify !== undefined && tr.effects.includes("E-NOTIFY")) {
      const recipientIds = notify.to === "BOTH" ? [m.buyerId, m.sellerId] : [notify.to === "BUYER" ? m.buyerId : m.sellerId];
      await this.jobs.send(tx, {
        queue: "notifications.send",
        singletonKey: `notify:${m.row.id}:${String(after.stateVersion)}:${notify.template}`,
        data: { templateKey: notify.template, recipientIds, deepLink: `/contracts/${m.row.contractId}?milestone=${m.row.id}#milestone-${m.row.id}`, params: { milestoneId: m.row.id, transitionId: id } },
      });
    }
    return after;
  }

  private async ledger(tx: Tx, entry: typeof paymentEvents.$inferInsert) {
    // Keyed by the PayPal-Request-Id (or webhook id): recording the same fact twice is a no-op.
    await tx.insert(paymentEvents).values(entry).onConflictDoNothing({ target: paymentEvents.idempotencyKey });
  }

  // Writes the changes to some holds and returns all of them as they are now, with the milestone
  // columns that summarize them. Every caller writes that summary to the milestone in the same
  // transaction (through apply, or a plain update when there is no transition): migration 0012
  // refuses the commit otherwise.
  private async writeHolds(tx: Tx, current: readonly HoldRow[], patches: ReadonlyMap<string, HoldPatch>) {
    const after: HoldRow[] = [];
    for (const h of current) {
      const patch = patches.get(h.id);
      if (patch === undefined) {
        after.push(h);
        continue;
      }
      const [row] = await tx.update(holds).set(patch).where(eq(holds.id, h.id)).returning();
      if (row === undefined) throw new Error(`Hold ${h.id} vanished`);
      after.push(row);
    }
    return { holds: after, summary: rollup(after) };
  }

  // E-CAPTURE. Decides the release (amount, sequence, final), splits it into one part per hold
  // (ADR-0009, rule 2), records it, and schedules one PayPal capture per part. Called only from
  // release transitions (state-machine.ts: moneyEffect).
  private async release(tx: Tx, m: Locked, id: string, decision: ReleaseDecision, counted: ReadonlySet<string>, actor: Actor, correlationId: string): Promise<MilestoneRow> {
    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(releases).where(eq(releases.milestoneId, m.row.id));
    const seq = n + 1;
    const currency = m.def.amount.currency;
    const feeBps = m.snapshot.terms.platformFeeBps;
    // Decision 5: the fee is charged per part, so each payee pays on what they receive.
    const parts = m.holds.flatMap((hold, i) => {
      const amountMinor = decision.parts[i] ?? 0;
      return amountMinor > 0 ? [{ hold, amountMinor, platformFeeMinor: platformFee(amountMinor, feeBps) }] : [];
    });
    const fee = parts.reduce((sum, p) => sum + p.platformFeeMinor, 0);
    const [rel] = await tx
      .insert(releases)
      .values({ milestoneId: m.row.id, seq, transitionId: id, amountMinor: decision.amountMinor, currency, platformFeeMinor: fee, countedBps: decision.countedBps, countedCriterionIds: [...counted], runId: m.row.latestRunId, final: decision.final })
      .returning();
    if (rel === undefined) throw new Error("insert returned nothing");
    const stored = await tx
      .insert(releaseParts)
      .values(parts.map((p) => ({ releaseId: rel.id, holdId: p.hold.id, amountMinor: p.amountMinor, platformFeeMinor: p.platformFeeMinor })))
      .returning();

    // Only the final release changes a hold's status: until then the rest is still AUTHORIZED.
    const patches = new Map(parts.map((p): [string, HoldPatch] => [p.hold.id, { releasedMinor: p.hold.releasedMinor + p.amountMinor, ...(decision.final ? { holdStatus: "CAPTURE_PENDING" } : {}) }]));
    const { summary } = await this.writeHolds(tx, m.holds, patches);
    const after = await this.apply(tx, m, id, actor, correlationId, { ...summary, windowEndsAt: null });
    await this.cancelWindowTimer(tx, m.row);

    // One job per part, each with its own PayPal-Request-Id: a crash between two captures
    // resumes the one that did not happen, and never repeats the one that did.
    for (const part of stored) {
      const requestId = `capture-${m.row.id}-${String(seq)}-${part.holdId}`;
      await this.ledger(tx, {
        milestoneId: m.row.id,
        releaseId: rel.id,
        holdId: part.holdId,
        releasePartId: part.id,
        type: "CAPTURE_REQUESTED",
        amountMinor: part.amountMinor,
        currency,
        platformFeeMinor: part.platformFeeMinor,
        idempotencyKey: `${requestId}:requested`,
        source: "API_RESPONSE",
        occurredAt: this.clock.now(),
      });
      await this.jobs.send(tx, { queue: "payments.capture", singletonKey: `capture:${part.id}`, data: { milestoneId: m.row.id, releaseId: rel.id, releasePartId: part.id, holdId: part.holdId, requestId } });
    }
    const money = (amountMinor: number) => ({ amountMinor, currency });
    await enqueueEvent(tx, {
      type: "payments.milestone.released",
      actor,
      contractId: m.row.contractId,
      milestoneId: m.row.id,
      correlationId,
      payload: {
        transitionId: id,
        releaseId: rel.id,
        releaseSeq: seq,
        amount: money(rel.amountMinor),
        platformFee: money(fee),
        heldAmount: money(after.fundedMinor - after.releasedMinor - after.returnedMinor),
        final: decision.final,
        parts: parts.map((p) => ({ payeeUserId: p.hold.payeeUserId, amount: money(p.amountMinor), platformFee: money(p.platformFeeMinor) })),
      },
    });
    return after;
  }

  // E-VOID. Everything still held goes back to the buyer, hold by hold: each one is its own
  // authorization, paid to its own payee, so each gets its own void (or capture and refund).
  private async returnHeld(tx: Tx, m: Locked, id: string, actor: Actor, correlationId: string): Promise<MilestoneRow> {
    const live = m.holds.filter((h) => h.holdStatus === "AUTHORIZED");
    const patches = new Map(live.map((h): [string, HoldPatch] => [h.id, { returnedMinor: h.fundedMinor - h.releasedMinor, holdStatus: "VOID_PENDING" }]));
    // An expired hold has nothing left to void: PayPal already gave it back. Recorded as returned,
    // or a terminal state would not add up (SM-INV-9). No job, because there is nothing to ask.
    for (const h of m.holds) if (h.holdStatus === "EXPIRED") patches.set(h.id, { returnedMinor: h.fundedMinor - h.releasedMinor });
    // SM-T16 on a milestone funded only in part: the orders the buyer never approved hold no
    // money, so there is nothing to give back; they are abandoned. Left ORDER_CREATED, a
    // VOIDED milestone would show a payment in progress forever (and the state/hold check
    // refuses it once the voids settle). An approval that arrives later is refused by
    // fund:confirm before PayPal is asked to authorize it.
    for (const h of m.holds) if (h.holdStatus === "ORDER_CREATED") patches.set(h.id, { holdStatus: "NONE" });
    const { summary } = await this.writeHolds(tx, m.holds, patches);
    const after = await this.apply(tx, m, id, actor, correlationId, { ...summary, windowEndsAt: null });
    await this.cancelWindowTimer(tx, m.row);
    for (const h of live) {
      const held = h.fundedMinor - h.releasedMinor - h.returnedMinor;
      await this.ledger(tx, { milestoneId: m.row.id, holdId: h.id, type: "VOID_REQUESTED", amountMinor: held, currency: m.def.amount.currency, idempotencyKey: `void-${h.id}-${h.authorizationId ?? ""}:requested`, source: "API_RESPONSE", occurredAt: this.clock.now() });
      await this.jobs.send(tx, { queue: "payments.void", singletonKey: `void:${h.id}`, data: { milestoneId: m.row.id, holdId: h.id } });
    }
    return after;
  }

  private async cancelWindowTimer(tx: Tx, row: MilestoneRow) {
    if (row.latestRunId !== null) await this.jobs.cancel(tx, "objections.window.expire", `window:${row.id}:${row.latestRunId}`);
  }

  // Criteria already paid for: what counted in every release PayPal did not decline. They keep
  // counting in later rounds (H2 review, finding 5). Without this, a criterion the buyer approved
  // in round 1 would be forgotten in round 2, and the cumulative total would not cover it.
  private async paidFor(tx: Tx, milestoneId: string): Promise<Set<string>> {
    const rows = await tx.select({ ids: releases.countedCriterionIds }).from(releases).where(and(eq(releases.milestoneId, milestoneId), inArray(releases.status, ["PENDING", "CAPTURED"])));
    return new Set(rows.flatMap((r) => r.ids));
  }

  // What counts in the current round: deterministic passes plus what the buyer approved, plus
  // what earlier releases already paid for.
  private async roundDecision(tx: Tx, m: Locked): Promise<{ decision: ReleaseDecision; counted: Set<string> }> {
    const runId = m.row.latestRunId;
    if (runId === null) throw new Error(`Milestone ${m.row.id} has no run`);
    const [outcome] = await tx.select().from(runOutcomes).where(eq(runOutcomes.runId, runId));
    const approved = await tx.select({ id: humanCriterionDecisions.criterionId }).from(humanCriterionDecisions).where(eq(humanCriterionDecisions.runId, runId));
    const now = countedCriteria(m.def.criteria, outcome?.results ?? [], new Set(approved.map((a) => a.id)));
    const counted = new Set([...now, ...(await this.paidFor(tx, m.row.id))]);
    return { decision: decideRelease(m.holds, m.def.criteria, counted), counted };
  }

  private async recordDecisions(tx: Tx, m: Locked, runId: string, criterionIds: readonly string[], caller: Caller) {
    const known = new Set(m.def.criteria.map((c) => c.id));
    const unknown = criterionIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ProblemException("VALIDATION_FAILED", 422, "Some fields need fixing", "Every decision must name a criterion of this milestone.", {
        issues: unknown.map((id) => ({ path: "humanDecisions", message: `${id} is not a criterion of this milestone` })),
      });
    }
    if (criterionIds.length === 0) return;
    // Constitution VI: approved by a person. Agent keys do not exist yet; when they do, this
    // is where they must be refused.
    await tx
      .insert(humanCriterionDecisions)
      .values(criterionIds.map((criterionId) => ({ milestoneId: m.row.id, runId, criterionId, decision: "APPROVED" as const, decidedBy: caller.user.id, decidedAt: this.clock.now() })))
      .onConflictDoNothing();
  }

  // Guards shared by every release transition: G-REQUIRED-COUNTED, G-RELEASE-POSITIVE,
  // G-NO-RELEASE-IN-FLIGHT and G-AUTH-ACTIVE. Returns which of the pair applies (G-ALL-COUNTED
  // or G-SOME-HELD), so the caller picks SM-T08 or SM-T18 and so on.
  private async releaseGuards(tx: Tx, m: Locked, decision: ReleaseDecision): Promise<"ALL" | "SOME"> {
    if (!decision.requiredCounted) {
      throw guardFailed("G-REQUIRED-COUNTED", "A required criterion is not approved yet", "Nothing is paid until every required criterion counts. Approve it, or object.");
    }
    if (decision.amountMinor <= 0) throw guardFailed("G-RELEASE-POSITIVE", "Nothing new to release", "The criteria that count were already paid.");
    await this.requireNoReleaseInFlight(tx, m.row.id);
    this.requireAuthActive(m.row);
    return decision.countedBps === FULL_BPS ? "ALL" : "SOME";
  }

  private async requireNoReleaseInFlight(tx: Tx, milestoneId: string) {
    const [pending] = await tx.select({ id: releases.id }).from(releases).where(and(eq(releases.milestoneId, milestoneId), eq(releases.status, "PENDING")));
    if (pending !== undefined) {
      throw guardFailed("G-NO-RELEASE-IN-FLIGHT", "A payment is still being processed", "Wait until PayPal confirms the previous release, then try again.");
    }
  }

  // ---------------------------------------------------------------- reads

  async get(milestoneId: string, caller: Caller) {
    const m = await this.load(this.db, milestoneId, false, caller.user.id);
    return milestoneDetail(this.db, m.row, m.role === "COLLABORATOR" ? caller.user.id : null);
  }

  // The caller's place in the milestone's contract, for modules that act on a milestone without
  // changing it (delivery files, ADR-0020). Same NOT_FOUND as every read for a stranger.
  async partyRoleOf(milestoneId: string, caller: Caller): Promise<PartyRole> {
    const m = await this.load(this.db, milestoneId, false, caller.user.id);
    if (m.role === null) throw notFound();
    return m.role;
  }

  async paymentEvents(milestoneId: string, caller: Caller) {
    const m = await this.load(this.db, milestoneId, false, caller.user.id);
    // ADR-0009, decision 6: a collaborator sees their own money only. The ledger carries every
    // member's authorization and capture amounts, so it is filtered to their hold; rows with no
    // hold (an orphan's VOIDED) are not theirs to see.
    const own = m.role === "COLLABORATOR" ? m.holds.filter((h) => h.payeeUserId === caller.user.id).map((h) => h.id) : null;
    // A collaborator added after this milestone's version was locked has no hold in it.
    if (own?.length === 0) return [];
    const scope = own === null ? eq(paymentEvents.milestoneId, milestoneId) : and(eq(paymentEvents.milestoneId, milestoneId), inArray(paymentEvents.holdId, own));
    const rows = await this.db.select().from(paymentEvents).where(scope).orderBy(asc(paymentEvents.recordedAt), asc(paymentEvents.id));
    const now = this.clock.now();
    const payeeOf = new Map(m.holds.map((h) => [h.id, h.payeeUserId]));
    // Same rule as the ledger: the buyer paid every hold; anyone else only has the hold that pays them.
    const viewerOf = (holdId: string | null) => (m.role === "BUYER" ? "PAYER" : holdId !== null && payeeOf.get(holdId) === caller.user.id ? "PAYEE" : "NONE");
    return rows.map((e) => ({
      id: e.id,
      type: e.type,
      amount: e.amountMinor === null || e.currency === null ? null : { amountMinor: e.amountMinor, currency: e.currency },
      platformFee: e.platformFeeMinor === null || e.currency === null ? null : { amountMinor: e.platformFeeMinor, currency: e.currency },
      releaseId: e.releaseId,
      paypal: e.paypal,
      paypalUrl: paypalUrl({ webBase: this.paypalWebBase, viewer: viewerOf(e.holdId), ...paypalReference(e.paypal), occurredAt: e.occurredAt, now }),
      source: e.source,
      occurredAt: e.occurredAt.toISOString(),
    }));
  }

  async listSubmissions(milestoneId: string, caller: Caller) {
    await this.load(this.db, milestoneId, false, caller.user.id);
    const rows = await this.db.select().from(submissions).where(eq(submissions.milestoneId, milestoneId)).orderBy(asc(submissions.attempt));
    return rows.map(submissionView);
  }

  // load() answers NOT_FOUND to anyone who is not a party, so an objection id tells a stranger
  // nothing. Without this read the seller got "respond to the objection" and no way to learn what
  // it said: the reason was stored and never reachable.
  async getObjection(objectionId: string, caller: Caller) {
    const [objection] = await this.db.select().from(objections).where(eq(objections.id, objectionId));
    if (objection === undefined) throw notFound();
    if (!(await this.reviewerMayRead(objection.milestoneId, caller))) await this.load(this.db, objection.milestoneId, false, caller.user.id);
    return objectionView(objection, await this.messagesOf(this.db, objectionId));
  }

  // ---------------------------------------------------------------- funding (SM-T03)

  // Funding is one PayPal order per team member (ADR-0009; PayPal refuses one AUTHORIZE order
  // with several payees, PP-T17). Each request is split in two halves: PayPal first (no
  // transaction open), then a transaction that records PayPal's answer. The PayPal requestIds
  // are deterministic (order-{milestoneId}-{holdId}-{attempt}, authorize-{milestoneId}-{orderId}),
  // so a retry of either half gets PayPal's first answer back instead of a second order or
  // authorization. The milestone becomes FUNDED (SM-T03) only when the last hold is authorized:
  // never "funded" with part of the team's money unreserved (decision 3).

  // What each member's hold must be funded with, by position in the locked team (rule 1).
  private plannedAmounts(m: Locked): number[] {
    return splitFunding(m.def.amount.amountMinor, teamOf(m.snapshot).map((t) => ({ shareBps: t.shareBps, isSeller: t.userId === null })));
  }

  // The holds of this milestone, created on the first /fund. They exist before PayPal is called
  // because their ids are part of the order requestIds. A short transaction of its own: it
  // writes no PayPal fact, only who is to be paid and where, so a retry finds the same rows.
  private async ensureHolds(milestoneId: string, viewerId: string): Promise<Locked> {
    return this.db.transaction(async (tx) => {
      const m = await this.load(tx, milestoneId, true, viewerId);
      assertAllowed("SM-T03", m.row.state);
      const team = teamOf(m.snapshot);
      const wanted = team.map((t, position) => ({ payeeUserId: t.userId ?? m.sellerId, position, shareBps: t.shareBps }));
      const same = m.holds.length === wanted.length && wanted.every((w, i) => m.holds[i]?.payeeUserId === w.payeeUserId && m.holds[i].shareBps === w.shareBps);
      if (same) return m;
      // Holds of an earlier locked version (the contract was amended in APPROVED): only ones that
      // never reached PayPal can be here, because an amendment needs no active order (G-NO-ACTIVE-ORDER).
      if (m.holds.some((h) => h.holdStatus !== "NONE")) throw new Error(`Milestone ${milestoneId} has holds of another team that reached PayPal`);
      if (m.holds.length > 0) await tx.delete(holds).where(eq(holds.milestoneId, milestoneId));

      const ids = wanted.map((w) => w.payeeUserId);
      const people = await tx.select({ id: users.id, merchantId: users.paypalMerchantId, receivable: users.paypalPaymentsReceivable, name: users.displayName }).from(users).where(inArray(users.id, ids));
      const byId = new Map(people.map((p) => [p.id, p]));
      // DM-INV-8 again, at the last moment: someone may have disconnected PayPal since the lock.
      const unpaid = wanted.filter((w) => byId.get(w.payeeUserId)?.merchantId == null || byId.get(w.payeeUserId)?.receivable !== true);
      if (unpaid.length > 0) {
        const names = unpaid.map((w) => byId.get(w.payeeUserId)?.name ?? "the seller").join(", ");
        throw new ProblemException("PAYPAL_NOT_CONNECTED", 409, "Someone on the team cannot be paid by PayPal", `${names} must connect PayPal before this milestone can be funded.`);
      }
      await tx.insert(holds).values(wanted.map((w) => ({ milestoneId, ...w, payeeMerchantId: byId.get(w.payeeUserId)?.merchantId ?? "" })));
      return this.load(tx, milestoneId, false, viewerId);
    });
  }

  // POST /milestones/{id}/fund, first half: one order per hold not authorized yet.
  // ADR-0007, "al implementar": a redirect, like onboarding and Log in with PayPal, instead of
  // the JS SDK buttons. PayPal sends the buyer back to the web app's paypal-return route, which
  // confirms that order and asks for the next one.
  async createOrder(caller: Caller, milestoneId: string): Promise<FundingOrder> {
    const pre = await this.load(this.db, milestoneId, false, caller.user.id);
    this.requireRole(pre, caller, ["BUYER"]);
    assertAllowed("SM-T03", pre.row.state);
    // ADR-0007, decision 5: a version written before weights existed cannot be funded.
    if (weightSum(pre.def) !== FULL_BPS) {
      throw guardFailed("G-MILESTONE-VALID", "This milestone has no valid weights", "It was agreed before criterion weights existed. Amend the contract and approve it again.");
    }
    // A share that rounds to 0 cents would need a PayPal order of 0, which PayPal refuses.
    if (this.plannedAmounts(pre).some((a) => a <= 0)) {
      throw guardFailed("G-MILESTONE-VALID", "A team share of this milestone is less than a cent", "Raise the milestone amount or that member's share, and approve the contract again.");
    }
    const m = await this.ensureHolds(milestoneId, caller.user.id);
    const planned = this.plannedAmounts(m);
    const orders: FundingOrder["orders"][number][] = [];
    for (const hold of m.holds) {
      if (hold.holdStatus === "AUTHORIZED") {
        orders.push({ holdId: hold.id, requestId: null, paypalOrderId: hold.paypalOrderId ?? "", approveUrl: hold.approveUrl ?? "" });
        continue;
      }
      const [{ attempts } = { attempts: 0 }] = await this.db
        .select({ attempts: count() })
        .from(paymentEvents)
        .where(and(eq(paymentEvents.holdId, hold.id), eq(paymentEvents.type, "ORDER_CREATED")));
      // An order the buyer has not approved yet is asked for again with the same requestId:
      // PayPal replays it, approval link included, instead of creating a second order.
      const attempt = hold.holdStatus === "ORDER_CREATED" ? attempts : attempts + 1;
      const requestId = `order-${milestoneId}-${hold.id}-${String(attempt)}`;
      const { orderId, approveUrl } = await this.provider.createOrder({
        milestoneId,
        amount: { amountMinor: planned[hold.position] ?? 0, currency: m.def.amount.currency },
        payeeMerchantId: hold.payeeMerchantId,
        requestId,
        returnUrl: `${this.webUrl}/milestones/${milestoneId}/paypal-return`,
        cancelUrl: `${this.webUrl}/contracts/${m.row.contractId}?paypal=cancelled`,
        description: `${m.snapshot.title} · ${m.def.title}`,
      });
      orders.push({ holdId: hold.id, requestId, paypalOrderId: orderId, approveUrl });
    }
    return { orders };
  }

  // Second half, inside the idempotent transaction.
  async recordOrder(tx: Tx, caller: Caller, milestoneId: string, order: FundingOrder) {
    const m = await this.load(tx, milestoneId, true, caller.user.id);
    assertAllowed("SM-T03", m.row.state);
    const planned = this.plannedAmounts(m);
    const created = new Map(order.orders.flatMap((o) => (o.requestId === null ? [] : [[o.holdId, { ...o, requestId: o.requestId }] as const])));
    // A hold authorized meanwhile (a fund:confirm that won the race) keeps its order.
    const fresh = m.holds.filter((h) => created.has(h.id) && h.holdStatus !== "AUTHORIZED");
    const patches = new Map(fresh.map((h): [string, HoldPatch] => [h.id, { paypalOrderId: created.get(h.id)?.paypalOrderId, approveUrl: created.get(h.id)?.approveUrl, holdStatus: "ORDER_CREATED" }]));
    const { holds: after, summary } = await this.writeHolds(tx, m.holds, patches);
    await tx.update(milestones).set(summary).where(eq(milestones.id, milestoneId));
    for (const h of fresh) {
      const o = created.get(h.id);
      if (o === undefined) continue;
      // Keyed by the requestId: asking for the same order again records nothing new.
      await this.ledger(tx, { milestoneId, holdId: h.id, type: "ORDER_CREATED", amountMinor: planned[h.position] ?? 0, currency: m.def.amount.currency, paypal: { orderId: o.paypalOrderId }, idempotencyKey: o.requestId, source: "API_RESPONSE", occurredAt: this.clock.now() });
    }
    return this.fundingView(tx, m, after);
  }

  // openapi.yaml, createFundingOrder: every order with its status, and at the top the next one
  // the buyer has to approve.
  private async fundingView(q: Db | Tx, m: Locked, current: readonly HoldRow[]) {
    const planned = this.plannedAmounts(m);
    const currency = m.def.amount.currency;
    const people = await q.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, current.map((h) => h.payeeUserId)));
    const names = new Map(people.map((u) => [u.id, u.name]));
    const orders = current.map((h) => ({
      holdId: h.id,
      payeeUserId: h.payeeUserId,
      payeeName: names.get(h.payeeUserId) ?? "",
      amount: { amountMinor: planned[h.position] ?? 0, currency },
      paypalOrderId: h.paypalOrderId ?? "",
      approveUrl: h.approveUrl ?? "",
      holdStatus: h.holdStatus,
    }));
    const next = orders.find((o) => o.holdStatus !== "AUTHORIZED") ?? orders[0];
    const fee = planned.reduce((sum, a) => sum + platformFee(a, m.snapshot.terms.platformFeeBps), 0);
    return {
      paypalOrderId: next?.paypalOrderId ?? "",
      approveUrl: next?.approveUrl ?? "",
      amount: m.def.amount,
      platformFee: { amountMinor: fee, currency },
      sellerReceives: { amountMinor: m.def.amount.amountMinor - fee, currency },
      orders,
    };
  }

  // POST /milestones/{id}/fund:confirm, first half: authorize the order the buyer approved.
  async authorize(caller: Caller, milestoneId: string, orderId: string): Promise<Authorized | null> {
    const pre = await this.load(this.db, milestoneId, false, caller.user.id);
    this.requireRole(pre, caller, ["BUYER"]);
    // The order id comes from the browser: it only picks which hold. Whether it funds it is
    // decided by PayPal's answer (confirmFunding).
    const hold = pre.holds.find((h) => h.paypalOrderId === orderId);
    if (hold === undefined) throw guardFailed("G-AUTH-MATCHES", "That PayPal order is not this milestone's", "Start funding again from this milestone.");
    if (hold.holdStatus === "AUTHORIZED") return null; // already authorized: a retry
    assertAllowed("SM-T03", pre.row.state);
    const requestId = `authorize-${milestoneId}-${orderId}`;
    try {
      return { auth: await this.provider.authorizeOrder({ orderId, requestId }), requestId, holdId: hold.id };
    } catch (error) {
      if (error instanceof ProviderDeclinedError) throw guardFailed("G-AUTH-MATCHES", "PayPal did not authorize the payment", error.reason);
      throw error;
    }
  }

  // Second half: the hold becomes AUTHORIZED, and with the last one, SM-T03. Checks PayPal's
  // answer against the hold first (G-AUTH-MATCHES): amount, currency, payee and our id in
  // custom_id. Trusting the order id from the browser alone would let anyone confirm funding
  // with somebody else's order.
  async confirmFunding(tx: Tx, caller: Caller, milestoneId: string, authorized: Authorized | null) {
    const m = await this.load(tx, milestoneId, true, caller.user.id);
    if (authorized === null) return milestoneDetail(tx, m.row);
    const { auth, requestId, holdId } = authorized;
    const hold = m.holds.find((h) => h.id === holdId);
    if (hold === undefined) throw new Error(`Hold ${holdId} is not milestone ${milestoneId}'s`);
    if (hold.authorizationId === auth.authorizationId) return milestoneDetail(tx, m.row); // a retry
    assertAllowed("SM-T03", m.row.state);
    // status CREATED is part of the port's type: an adapter that sees anything else throws.
    const planned = this.plannedAmounts(m)[hold.position];
    const payeeMatches = auth.payeeMerchantId === null || auth.payeeMerchantId === hold.payeeMerchantId;
    const matches = hold.holdStatus === "ORDER_CREATED" && auth.customId === milestoneId && auth.amount.amountMinor === planned && auth.amount.currency === m.def.amount.currency && payeeMatches;
    if (!matches) throw guardFailed("G-AUTH-MATCHES", "PayPal reserved a different amount", "The PayPal authorization does not match this milestone. Nothing was marked as funded.");
    if (auth.expiresAt <= this.clock.now()) throw guardFailed("G-AUTH-ACTIVE", "The PayPal reservation already expired", "Fund this milestone again.");

    const authorizedHold: HoldPatch = { holdStatus: "AUTHORIZED", authorizationId: auth.authorizationId, authorizedAt: auth.authorizedAt, authorizationExpiresAt: auth.expiresAt, fundedMinor: auth.amount.amountMinor };
    const { holds: after, summary } = await this.writeHolds(tx, m.holds, new Map([[hold.id, authorizedHold]]));
    await this.ledger(tx, { milestoneId, holdId: hold.id, type: "AUTHORIZED", amountMinor: auth.amount.amountMinor, currency: auth.amount.currency, paypal: { orderId: hold.paypalOrderId ?? "", authorizationId: auth.authorizationId }, idempotencyKey: requestId, source: "API_RESPONSE", occurredAt: auth.authorizedAt });
    // E-SCHEDULE-AUTH-TIMERS, per authorization. Their workers (expiry warning, SM-T17) arrive with H5.
    await this.jobs.send(tx, { queue: "payments.authorization.expiry-warning", singletonKey: `auth-warn:${milestoneId}:${auth.authorizationId}`, startAfter: new Date(auth.expiresAt.getTime() - 5 * 24 * HOUR), data: { milestoneId, authorizationId: auth.authorizationId } });
    await this.jobs.send(tx, { queue: "payments.authorization.lapse", singletonKey: `auth-lapse:${milestoneId}:${auth.authorizationId}`, startAfter: auth.expiresAt, data: { milestoneId, authorizationId: auth.authorizationId } });

    // Someone else on the team is still waiting for the buyer: the milestone stays APPROVED,
    // with its money columns showing what is already reserved.
    if (!after.every((h) => h.holdStatus === "AUTHORIZED")) {
      const [row] = await tx.update(milestones).set(summary).where(eq(milestones.id, milestoneId)).returning();
      return milestoneDetail(tx, row ?? m.row);
    }
    const funded = await this.apply(tx, m, "SM-T03", userActor(caller), caller.requestId, summary);
    const money = (amountMinor: number) => ({ amountMinor, currency: m.def.amount.currency });
    await enqueueEvent(tx, {
      type: "payments.milestone.funded",
      actor: userActor(caller),
      contractId: m.row.contractId,
      milestoneId,
      correlationId: caller.requestId,
      payload: {
        amount: money(funded.fundedMinor),
        platformFee: money(after.reduce((sum, h) => sum + platformFee(h.fundedMinor, m.snapshot.terms.platformFeeBps), 0)),
        // events.md names one authorization: the seller's, the hold every contract has.
        authorizationId: after.find((h) => h.payeeUserId === m.sellerId)?.authorizationId ?? auth.authorizationId,
        authorizationExpiresAt: funded.authorizationExpiresAt?.toISOString() ?? null,
      },
    });
    return milestoneDetail(tx, funded);
  }

  // ---------------------------------------------------------------- work (SM-T04, T05, T11, T21)

  async start(tx: Tx, caller: Caller, milestoneId: string, ifMatch: string | undefined) {
    const m = await this.load(tx, milestoneId, true, caller.user.id);
    this.requireRole(m, caller, ["SELLER"]);
    this.ifMatch(m, ifMatch);
    assertAllowed("SM-T04", m.row.state);
    this.requireAuthActive(m.row);
    return milestoneDetail(tx, await this.apply(tx, m, "SM-T04", userActor(caller), caller.requestId));
  }

  // SM-T05 from IN_PROGRESS, SM-T11 after an objection, SM-T21 after a partial release. Each
  // submission gets a new runId: the Engine's answer is matched to it, so a late answer for an
  // older submission can never decide this one.
  async submit(tx: Tx, caller: Caller, milestoneId: string, ifMatch: string | undefined, evidenceLinks: EvidenceLink[], notes: string) {
    const m = await this.load(tx, milestoneId, true, caller.user.id);
    this.requireRole(m, caller, ["SELLER"]);
    this.ifMatch(m, ifMatch);
    const id = m.row.state === "OBJECTED" ? "SM-T11" : m.row.state === "PARTIALLY_RELEASED" ? "SM-T21" : "SM-T05";
    assertAllowed(id, m.row.state);
    // SM-T21: a new round while PayPal is still capturing the last one would open a countdown
    // whose timer cannot release anything until that capture settles (H2 review, attack 3).
    if (id === "SM-T21") await this.requireNoReleaseInFlight(tx, milestoneId);
    this.requireAuthActive(m.row);
    if (evidenceLinks.length === 0) throw guardFailed("G-EVIDENCE-PRESENT", "Add at least one link", "A delivery needs at least one evidence link.");

    const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(submissions).where(eq(submissions.milestoneId, milestoneId));
    const runId = randomUUID();
    const [sub] = await tx.insert(submissions).values({ milestoneId, attempt: n + 1, evidenceLinks, notes, submittedBy: caller.user.id, runId, submittedAt: this.clock.now() }).returning();
    if (sub === undefined) throw new Error("insert returned nothing");

    if (id === "SM-T11") {
      // G-NOT-ESCALATED: otherwise a delivery takes the dispute away from the Reviewer, again and again.
      const [escalated] = await tx.select({ id: objections.id }).from(objections).where(and(eq(objections.milestoneId, milestoneId), eq(objections.status, "ESCALATED")));
      if (escalated !== undefined) throw guardFailed("G-NOT-ESCALATED", "A reviewer is deciding this", "Delivering again no longer answers this objection. You can still give up, or explain your side to the reviewer.");
      // E-SUPERSEDE-OBJECTION and E-CANCEL-ESCALATION: the new delivery answers the objection.
      const open = await tx.update(objections).set({ status: "SUPERSEDED_BY_RESUBMISSION", resolvedAt: this.clock.now() }).where(and(eq(objections.milestoneId, milestoneId), inArray(objections.status, [...LIVE_OBJECTION]))).returning({ id: objections.id });
      for (const o of open) await this.jobs.cancel(tx, "objections.escalate", `escalate:${o.id}`);
    }
    await this.apply(tx, m, id, userActor(caller), caller.requestId, { latestRunId: runId, windowEndsAt: null });
    // E-START-RUN: the dispatch to the Engine and its watchdog, in this transaction (SB-6). If
    // the delivery commits, both jobs exist; the verification module runs them (ADR-0008).
    await this.jobs.send(tx, { queue: "verification.run.dispatch", singletonKey: `dispatch:${runId}`, data: { runId } });
    await this.jobs.send(tx, { queue: "verification.run.watchdog", singletonKey: `watchdog:${runId}`, startAfter: new Date(sub.submittedAt.getTime() + WATCHDOG_AFTER_MS), data: { runId } });
    return submissionView(sub);
  }

  // ---------------------------------------------------------------- verification result

  // The Engine's verdicts (RunCompletedPayload). H4's inbox will call this once per event; in H2
  // the tests do. Safe to call twice with the same run: the second call changes nothing.
  async applyRunCompleted(input: { runId: string; status: "COMPLETED" | "TIMED_OUT"; results: CriterionVerdict[]; reportHash?: string }, correlationId: string = randomUUID()) {
    return this.db.transaction(async (tx) => {
      const [sub] = await tx.select().from(submissions).where(eq(submissions.runId, input.runId));
      if (sub === undefined) throw new Error(`Unknown run ${input.runId}`);
      const m = await this.load(tx, sub.milestoneId, true, null);
      const [seen] = await tx.select({ runId: runOutcomes.runId }).from(runOutcomes).where(eq(runOutcomes.runId, input.runId));
      if (seen !== undefined) return m.row; // duplicate delivery of the same event

      // G-RUN-COMPLETE: a verdict for every criterion of the locked version, no more, no less.
      const ids = new Set(m.def.criteria.map((c) => c.id));
      const complete = input.results.length === ids.size && input.results.every((r) => ids.has(r.criterionId));
      if (!complete) throw guardFailed("G-RUN-COMPLETE", "The verification result is incomplete", "It must have exactly one verdict per criterion.", { runId: input.runId });
      // G-PASS-HAS-EVIDENCE (constitution VII): a PASS that points at nothing is not a pass.
      const bare = input.results.filter((r) => r.verdict === "PASS" && r.evidenceRefCount < 1);
      if (bare.length > 0) throw guardFailed("G-PASS-HAS-EVIDENCE", "A PASS without evidence", "Every PASS verdict must reference evidence.", { criterionIds: bare.map((r) => r.criterionId) });

      await tx.insert(runOutcomes).values({ runId: input.runId, milestoneId: m.row.id, submissionId: sub.id, status: input.status, results: input.results, reportHash: input.reportHash ?? null, receivedAt: this.clock.now() });
      // A result for an older submission, or for a milestone that moved on, is history only.
      if (m.row.state !== "VERIFYING" || m.row.latestRunId !== input.runId) return m.row;

      const actor = systemActor("verification.run.completed");
      if (isReleasable(m.holds, m.def.criteria, input.results, await this.paidFor(tx, m.row.id))) {
        // SM-INV-6: verification passed but the hold is gone. An incident, never a silent move.
        if (!this.authActive(m.row)) {
          this.log.error(`SM-INV-6: milestone ${m.row.id} passed verification with holdStatus ${m.row.holdStatus}; admin alert, no transition`);
          return m.row;
        }
        return this.openWindow(tx, m, input.runId, input.results, actor, correlationId);
      }
      return this.apply(tx, m, m.row.releasedMinor === 0 ? "SM-T06" : "SM-T23", actor, correlationId, { windowEndsAt: null });
    });
  }

  // SM-T07 and E-OPEN-WINDOW: the countdown before any money moves (constitution XII).
  private async openWindow(tx: Tx, m: Locked, runId: string, results: readonly CriterionVerdict[], actor: Actor, correlationId: string) {
    const now = this.clock.now();
    const wanted = new Date(now.getTime() + m.snapshot.terms.releaseCountdownSeconds * 1000);
    // SM-INV-5: the capture must happen while the authorization is still valid, with a day of
    // margin. If the term does not fit, the countdown is shortened and the event says so.
    const latest = m.row.authorizationExpiresAt === null ? wanted : new Date(m.row.authorizationExpiresAt.getTime() - 24 * HOUR);
    const windowEndsAt = wanted <= latest ? wanted : latest;
    // Not even the minimum countdown fits: shortening further would move money with no visible
    // countdown, or with one already over (constitution XII; H2 review, finding 7). An incident.
    if (windowEndsAt.getTime() < now.getTime() + MIN_COUNTDOWN_MS) {
      this.log.error(`SM-INV-5: milestone ${m.row.id} passed verification but its authorization expires before a countdown can run; admin alert, no transition`);
      return m.row;
    }
    const after = await this.apply(tx, m, "SM-T07", actor, correlationId, { windowEndsAt });
    await this.jobs.send(tx, { queue: "objections.window.expire", singletonKey: `window:${m.row.id}:${runId}`, startAfter: windowEndsAt, data: { milestoneId: m.row.id, runId, windowEndsAt: windowEndsAt.toISOString() } });
    // Includes an automatic check that could not answer: it counts only if the buyer approves it,
    // like any other doubt. Left out, a required one held back the round with no warning at all.
    const verdictOf = new Map(results.map((r) => [r.criterionId, r.verdict]));
    const pendingHumanCriteriaIds = m.def.criteria.filter((c) => c.level !== "AUTOMATIC" || verdictOf.get(c.id) === "UNCERTAIN" || verdictOf.get(c.id) === "NEEDS_HUMAN").map((c) => c.id);
    // ADR-0011: without this mail the buyer may never learn there is something to decide, and
    // what nobody decides is not paid. In this transaction, so it cannot be lost after commit.
    const paid = await this.paidFor(tx, m.row.id);
    const pendingCriterionIds = pendingHumanCriteriaIds.filter((c) => !paid.has(c));
    // One mail per round for the buyer (ADR-0013): with nothing to decide, this is the only warning
    // that money moves when the countdown ends, and that they can still ask for a fix.
    await this.jobs.send(tx, {
      queue: "notifications.send",
      singletonKey: `notify:window.opened:${runId}`,
      data: {
        templateKey: "window.opened",
        recipientIds: pendingCriterionIds.length > 0 ? [m.sellerId] : [m.buyerId, m.sellerId],
        deepLink: `/contracts/${m.row.contractId}?milestone=${m.row.id}#milestone-${m.row.id}`,
        params: { milestoneId: m.row.id, runId },
      },
    });
    if (pendingCriterionIds.length > 0) {
      await this.jobs.send(tx, {
        queue: "notifications.send",
        singletonKey: `notify:decision.needed:${runId}`,
        data: {
          templateKey: "decision.needed",
          recipientIds: [m.buyerId],
          deepLink: `/contracts/${m.row.contractId}?milestone=${m.row.id}#milestone-${m.row.id}`,
          params: { milestoneId: m.row.id, runId, pendingCriterionIds },
        },
      });
    }
    await enqueueEvent(tx, {
      type: "objections.window.opened",
      actor,
      contractId: m.row.contractId,
      milestoneId: m.row.id,
      correlationId,
      payload: { windowEndsAt: windowEndsAt.toISOString(), pendingHumanCriteriaIds, shortened: windowEndsAt < wanted },
    });
    return after;
  }

  // ---------------------------------------------------------------- the countdown (T08..T25)

  // SM-T08 or SM-T18. The buyer approves early, deciding the criteria a check cannot prove.
  async approve(tx: Tx, caller: Caller, milestoneId: string, ifMatch: string | undefined, approvedCriterionIds: readonly string[]) {
    const m = await this.load(tx, milestoneId, true, caller.user.id);
    this.requireRole(m, caller, ["BUYER"]);
    this.ifMatch(m, ifMatch);
    assertAllowed("SM-T08", m.row.state);
    if (m.row.latestRunId === null) throw new Error(`Milestone ${milestoneId} in OBJECTION_WINDOW without a run`);
    await this.recordDecisions(tx, m, m.row.latestRunId, approvedCriterionIds, caller);
    const { decision, counted } = await this.roundDecision(tx, m);
    const which = await this.releaseGuards(tx, m, decision);
    const after = await this.release(tx, m, which === "ALL" ? "SM-T08" : "SM-T18", decision, counted, userActor(caller), caller.requestId);
    return milestoneDetail(tx, after);
  }

  // The window timer (objections.window.expire). Silence releases what already counts
  // (SM-T09 / T19) and approves nothing new (constitution VI); with nothing counting, the
  // milestone goes back to the seller (SM-T24 / T25). A stale or early timer does nothing.
  async expireWindow(milestoneId: string, runId: string, correlationId: string = randomUUID()) {
    return this.db.transaction(async (tx) => {
      const m = await this.load(tx, milestoneId, true, null);
      if (m.row.state !== "OBJECTION_WINDOW" || m.row.latestRunId !== runId) return { applied: null };
      if (m.row.windowEndsAt === null || this.clock.now() < m.row.windowEndsAt) return { applied: null }; // G-WINDOW-ELAPSED
      // G-SILENCE-IS-APPROVAL holds by type: the MVP snapshot fixes silenceIsApproval to true (Q-SM-2).

      const actor = systemActor("objections.window.expire");
      const { decision, counted } = await this.roundDecision(tx, m);
      if (decision.requiredCounted && decision.amountMinor > 0) {
        await this.requireNoReleaseInFlight(tx, milestoneId);
        if (!this.authActive(m.row)) {
          this.log.error(`SM-INV-6: milestone ${milestoneId} countdown ended with holdStatus ${m.row.holdStatus}; admin alert, no transition`);
          return { applied: null };
        }
        const id = decision.countedBps === FULL_BPS ? "SM-T09" : "SM-T19";
        await this.release(tx, m, id, decision, counted, actor, correlationId);
        return { applied: id };
      }
      const id = m.row.releasedMinor === 0 ? "SM-T24" : "SM-T25";
      await this.apply(tx, m, id, actor, correlationId, { windowEndsAt: null });
      return { applied: id };
    });
  }

  // SM-T10.
  async raiseObjection(tx: Tx, caller: Caller, milestoneId: string, ifMatch: string | undefined, criterionIds: readonly string[], reason: string) {
    const m = await this.load(tx, milestoneId, true, caller.user.id);
    this.requireRole(m, caller, ["BUYER"]);
    this.ifMatch(m, ifMatch);
    assertAllowed("SM-T10", m.row.state);
    if (m.row.windowEndsAt === null || this.clock.now() >= m.row.windowEndsAt) {
      throw guardFailed("G-WINDOW-OPEN", "The countdown already ended", "Objections are only possible before the countdown ends.");
    }
    const known = new Set(m.def.criteria.map((c) => c.id));
    if (criterionIds.length === 0 || !criterionIds.every((id) => known.has(id)) || reason.trim().length < 20) {
      throw guardFailed("G-OBJECTION-VALID", "Say what is wrong", "Name at least one criterion of this milestone and explain the problem in at least 20 characters.");
    }
    if (m.row.latestRunId === null) throw new Error(`Milestone ${milestoneId} in OBJECTION_WINDOW without a run`);
    const now = this.clock.now();
    const [{ earlier } = { earlier: 0 }] = await tx.select({ earlier: count() }).from(objections).where(eq(objections.milestoneId, milestoneId));
    const straightToReviewer = earlier + 1 >= OBJECTIONS_BEFORE_REVIEWER;
    const expiry = m.row.authorizationExpiresAt;
    const scheduled = new Date(expiry === null ? now.getTime() + FIVE_DAYS_MS : Math.min(now.getTime() + FIVE_DAYS_MS, expiry.getTime() - 72 * HOUR));
    const [objection] = await tx
      .insert(objections)
      .values({ milestoneId, runId: m.row.latestRunId, criterionIds: [...criterionIds], reason, raisedBy: caller.user.id, raisedAt: now, escalateAt: straightToReviewer ? now : scheduled, status: straightToReviewer ? "ESCALATED" : "OPEN" })
      .returning();
    if (objection === undefined) throw new Error("insert returned nothing");

    await this.apply(tx, m, "SM-T10", userActor(caller), caller.requestId, { windowEndsAt: null });
    await this.cancelWindowTimer(tx, m.row); // E-CANCEL-WINDOW-TIMER
    const view = objectionView(objection);
    // E-SCHEDULE-ESCALATION.
    if (straightToReviewer) await this.announceEscalation(tx, m, objection.id, caller.requestId);
    else await this.jobs.send(tx, { queue: "objections.escalate", singletonKey: `escalate:${objection.id}`, startAfter: objection.escalateAt, data: { objectionId: objection.id } });
    await enqueueEvent(tx, { type: "objections.objection.raised", actor: userActor(caller), contractId: m.row.contractId, milestoneId, correlationId: caller.requestId, payload: { objectionId: objection.id, criterionIds, reason } });
    return view;
  }

  // SM-T12 or SM-T20. The buyer withdraws and releases what counts, approving what a check
  // cannot prove in the same request (like approve).
  async withdrawObjection(tx: Tx, caller: Caller, objectionId: string, approvedCriterionIds: readonly string[]) {
    const [found] = await tx.select().from(objections).where(eq(objections.id, objectionId));
    if (found === undefined) throw notFound();
    const m = await this.load(tx, found.milestoneId, true, caller.user.id);
    this.requireRole(m, caller, ["BUYER"]);
    const [objection] = await tx.select().from(objections).where(eq(objections.id, objectionId));
    if (objection === undefined || !(LIVE_OBJECTION as readonly string[]).includes(objection.status)) {
      throw new ProblemException("INVALID_TRANSITION", 409, "This objection is already closed", `Its status is ${objection?.status ?? "unknown"}.`);
    }
    assertAllowed("SM-T12", m.row.state);
    await this.recordDecisions(tx, m, objection.runId, approvedCriterionIds, caller);
    const { decision, counted } = await this.roundDecision(tx, m);
    const which = await this.releaseGuards(tx, m, decision);
    const [closed] = await tx.update(objections).set({ status: "WITHDRAWN", resolvedAt: this.clock.now() }).where(eq(objections.id, objectionId)).returning();
    if (closed === undefined) throw new Error("update returned nothing");
    await this.jobs.cancel(tx, "objections.escalate", `escalate:${objectionId}`);
    await this.release(tx, m, which === "ALL" ? "SM-T12" : "SM-T20", decision, counted, userActor(caller), caller.requestId);
    await enqueueEvent(tx, { type: "objections.objection.resolved", actor: userActor(caller), contractId: m.row.contractId, milestoneId: m.row.id, correlationId: caller.requestId, payload: { objectionId, resolution: "WITHDRAWN" } });
    return objectionView(closed);
  }

  // ---------------------------------------------------------------- the way out of an objection (ADR-0014)

  private isReviewer(caller: Caller): boolean {
    return caller.user.roles.includes("REVIEWER") || caller.user.roles.includes("ADMIN");
  }

  // A Reviewer sees only what reached them: nothing about a contract with no dispute.
  async reviewerMayRead(milestoneId: string, caller: Caller): Promise<boolean> {
    if (!this.isReviewer(caller)) return false;
    const [found] = await this.db.select({ id: objections.id }).from(objections).where(and(eq(objections.milestoneId, milestoneId), inArray(objections.status, ["ESCALATED", "RULED_RELEASE", "RULED_VOID"])));
    return found !== undefined;
  }

  private async messagesOf(q: Db | Tx, objectionId: string) {
    return q.select().from(objectionMessages).where(eq(objectionMessages.objectionId, objectionId)).orderBy(asc(objectionMessages.createdAt));
  }

  // objections.escalate at escalateAt, and the third objection at once. Escalating is a fact about
  // the objection, not a transition: the milestone stays OBJECTED and no money moves.
  async processEscalation(objectionId: string, correlationId: string = randomUUID()): Promise<"ESCALATED" | "SKIPPED"> {
    return this.db.transaction(async (tx) => {
      const [found] = await tx.select().from(objections).where(eq(objections.id, objectionId));
      if (found === undefined) return "SKIPPED" as const;
      const m = await this.load(tx, found.milestoneId, true, null);
      // Re-read under the lock: a delivery or a withdrawal may have ended it while this job waited.
      const [objection] = await tx.select().from(objections).where(eq(objections.id, objectionId));
      if (objection?.status !== "OPEN" && objection?.status !== "CONTESTED") return "SKIPPED" as const;
      await tx.update(objections).set({ status: "ESCALATED" }).where(eq(objections.id, objectionId));
      await recordAudit(tx, { actor: systemActor("objections.escalate"), action: "objection.escalated", entityType: "Objection", entityId: objectionId, contractId: m.row.contractId, before: { status: objection.status }, after: { status: "ESCALATED" }, requestId: correlationId });
      await this.announceEscalation(tx, m, objectionId, correlationId);
      return "ESCALATED" as const;
    });
  }

  private async announceEscalation(tx: Tx, m: Locked, objectionId: string, correlationId: string) {
    await enqueueEvent(tx, { type: "objections.objection.escalated", actor: systemActor("objections.escalate"), contractId: m.row.contractId, milestoneId: m.row.id, correlationId, payload: { objectionId, reviewerId: null } });
    const staff = await tx.select({ id: users.id }).from(users).where(sql`${users.roles} && ARRAY['REVIEWER', 'ADMIN']::text[]`);
    const team = await tx.select({ id: contractParties.userId }).from(contractParties).where(eq(contractParties.contractId, m.row.contractId));
    // G-ACTOR-NEUTRAL: nobody is asked to rule on a contract they are part of.
    const parties = new Set([m.buyerId, m.sellerId, ...team.map((t) => t.id)]);
    const reviewers = staff.filter((r) => !parties.has(r.id));
    // Without a reviewer nobody can end this, and the parties were just told someone will.
    if (reviewers.length === 0) this.log.error(`Objection ${objectionId} escalated and there is no neutral reviewer; admin alert`);
    await this.jobs.send(tx, {
      queue: "notifications.send",
      singletonKey: `notify:objection.escalated:${objectionId}`,
      data: {
        templateKey: "objection.escalated",
        recipientIds: [m.buyerId, m.sellerId, ...reviewers.map((r) => r.id)],
        deepLink: `/contracts/${m.row.contractId}?milestone=${m.row.id}#milestone-${m.row.id}`,
        params: { milestoneId: m.row.id, objectionId },
      },
    });
  }

  // The seller's side, once. The timer keeps running: disputing is not a way to wait longer.
  async contestObjection(tx: Tx, caller: Caller, objectionId: string, reason: string) {
    const [found] = await tx.select().from(objections).where(eq(objections.id, objectionId));
    if (found === undefined) throw notFound();
    const m = await this.load(tx, found.milestoneId, true, caller.user.id);
    this.requireRole(m, caller, ["SELLER"]);
    const [objection] = await tx.select().from(objections).where(eq(objections.id, objectionId));
    if (objection === undefined || !(LIVE_OBJECTION as readonly string[]).includes(objection.status)) throw new ProblemException("INVALID_TRANSITION", 409, "This objection is already closed", `Its status is ${objection?.status ?? "unknown"}.`);
    if (objection.contestedAt !== null) throw new ProblemException("INVALID_TRANSITION", 409, "You already answered this objection", "The reviewer will read what you wrote.");
    const now = this.clock.now();
    const [updated] = await tx.update(objections).set({ contestedAt: now, status: objection.status === "ESCALATED" ? "ESCALATED" : "CONTESTED" }).where(eq(objections.id, objectionId)).returning();
    if (updated === undefined) throw new Error("update returned nothing");
    await tx.insert(objectionMessages).values({ objectionId, authorId: caller.user.id, body: reason, createdAt: now });
    await recordAudit(tx, { actor: userActor(caller), action: "objection.contested", entityType: "Objection", entityId: objectionId, contractId: m.row.contractId, before: { status: objection.status }, after: { status: updated.status }, requestId: caller.requestId });
    await enqueueEvent(tx, { type: "objections.objection.contested", actor: userActor(caller), contractId: m.row.contractId, milestoneId: m.row.id, correlationId: caller.requestId, payload: { objectionId } });
    return objectionView(updated, await this.messagesOf(tx, objectionId));
  }

  // SM-T13, SM-T14 or SM-T27. Irreversible, so everything is checked under the milestone lock.
  async ruleOnObjection(tx: Tx, caller: Caller, objectionId: string, decision: "RELEASE" | "VOID", reason: string) {
    if (!this.isReviewer(caller)) throw new ProblemException("FORBIDDEN", 403, "Only a reviewer can rule", "Rulings are made by a neutral reviewer.");
    const [found] = await tx.select().from(objections).where(eq(objections.id, objectionId));
    if (found === undefined) throw notFound();
    const m = await this.load(tx, found.milestoneId, true, null);
    const [objection] = await tx.select().from(objections).where(eq(objections.id, objectionId));
    if (objection === undefined || !(LIVE_OBJECTION as readonly string[]).includes(objection.status)) throw new ProblemException("INVALID_TRANSITION", 409, "This objection is already closed", `Its status is ${objection?.status ?? "unknown"}.`);
    if (objection.status !== "ESCALATED") throw guardFailed("G-OBJECTION-ESCALATED", "This objection has not reached a reviewer", "The buyer and the seller still have time to settle it.");
    // Not by role: ADMIN must not rule on a contract of their own, and load() above skipped the party check.
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, m.row.contractId));
    if (contract === undefined || (await partyRoleIn(tx, contract, caller.user.id)) !== null) throw guardFailed("G-ACTOR-NEUTRAL", "You are part of this contract", "Another reviewer has to decide this one.");

    const actor = userActor(caller);
    let id: string;
    if (decision === "RELEASE") {
      id = "SM-T13";
      assertAllowed(id, m.row.state);
      await this.requireNoReleaseInFlight(tx, m.row.id);
      // Not requireAuthActive: its message sends the buyer to fund again, impossible from OBJECTED.
      if (!this.authActive(m.row)) throw guardFailed("G-AUTH-ACTIVE", "The reservation is no longer active", "There is nothing left to pay from. Only returning to the buyer can finish this milestone.");
      // E-CAPTURE for SM-T13: the whole held amount. Every criterion counts for this release.
      const counted = new Set(m.def.criteria.map((c) => c.id));
      await this.release(tx, m, id, decideRelease(m.holds, m.def.criteria, counted), counted, actor, caller.requestId);
    } else {
      id = m.row.releasedMinor === 0 ? "SM-T14" : "SM-T27";
      assertAllowed(id, m.row.state);
      if (id === "SM-T27") await this.requireNoReleaseInFlight(tx, m.row.id);
      await this.endWithReturn(tx, m, id, actor, caller.requestId, reason);
    }

    const [ruled] = await tx.update(objections).set({ status: decision === "RELEASE" ? "RULED_RELEASE" : "RULED_VOID", resolvedAt: this.clock.now(), resolvedBy: caller.user.id, resolutionReason: reason }).where(eq(objections.id, objectionId)).returning();
    if (ruled === undefined) throw new Error("update returned nothing");
    await this.jobs.cancel(tx, "objections.escalate", `escalate:${objectionId}`);
    // Constitution IX: an override always carries its reason.
    await recordAudit(tx, { actor, action: "objection.ruled", entityType: "Objection", entityId: objectionId, contractId: m.row.contractId, before: { status: objection.status }, after: { status: ruled.status, transitionId: id }, reason, requestId: caller.requestId });
    await enqueueEvent(tx, { type: "objections.objection.resolved", actor, contractId: m.row.contractId, milestoneId: m.row.id, correlationId: caller.requestId, payload: { objectionId, status: ruled.status, resolvedBy: caller.user.id, reason } });
    await this.jobs.send(tx, {
      queue: "notifications.send",
      singletonKey: `notify:objection.ruled:${objectionId}`,
      data: { templateKey: "objection.ruled", recipientIds: [m.buyerId, m.sellerId], deepLink: `/contracts/${m.row.contractId}?milestone=${m.row.id}#milestone-${m.row.id}`, params: { milestoneId: m.row.id, objectionId } },
    });
    return objectionView(ruled, await this.messagesOf(tx, objectionId));
  }

  // SM-T28 or SM-T29. The seller accepts they will not fix it, without waiting for anyone.
  async surrender(tx: Tx, caller: Caller, milestoneId: string, ifMatch: string | undefined) {
    const m = await this.load(tx, milestoneId, true, caller.user.id);
    this.requireRole(m, caller, ["SELLER"]);
    this.ifMatch(m, ifMatch);
    const id = m.row.releasedMinor === 0 ? "SM-T28" : "SM-T29";
    assertAllowed(id, m.row.state);
    if (id === "SM-T29") await this.requireNoReleaseInFlight(tx, milestoneId);
    const open = await tx.update(objections).set({ status: "SURRENDERED", resolvedAt: this.clock.now(), resolvedBy: caller.user.id }).where(and(eq(objections.milestoneId, milestoneId), inArray(objections.status, [...LIVE_OBJECTION]))).returning({ id: objections.id });
    for (const o of open) {
      await this.jobs.cancel(tx, "objections.escalate", `escalate:${o.id}`);
      await enqueueEvent(tx, { type: "objections.objection.resolved", actor: userActor(caller), contractId: m.row.contractId, milestoneId, correlationId: caller.requestId, payload: { objectionId: o.id, status: "SURRENDERED", resolvedBy: caller.user.id } });
    }
    const after = await this.endWithReturn(tx, m, id, userActor(caller), caller.requestId, "The seller gave up");
    return milestoneDetail(tx, after);
  }

  // E-VOID and the domain event every return ends with: closed if part was paid, voided if not.
  private async endWithReturn(tx: Tx, m: Locked, id: string, actor: Actor, correlationId: string, reason: string): Promise<MilestoneRow> {
    const hadHold = m.holds.some((h) => h.holdStatus === "AUTHORIZED");
    const after = await this.returnHeld(tx, m, id, actor, correlationId);
    const money = (amountMinor: number) => ({ amountMinor, currency: m.def.amount.currency });
    if (after.state === "CLOSED") await enqueueEvent(tx, { type: "payments.milestone.closed", actor, contractId: m.row.contractId, milestoneId: m.row.id, correlationId, payload: { transitionId: id, releasedAmount: money(after.releasedMinor), returnedAmount: money(after.returnedMinor) } });
    else await enqueueEvent(tx, { type: "payments.milestone.voided", actor, contractId: m.row.contractId, milestoneId: m.row.id, correlationId, payload: { transitionId: id, hadHold, reason } });
    return after;
  }

  // payments.authorization.lapse. SM-T17 while no work was delivered: the buyer can fund again.
  // Later states have no automatic way back (SM-INV-6): the hold is marked, an admin is alerted,
  // and a return by the seller or a Reviewer still finishes the milestone.
  async processLapse(milestoneId: string, authorizationId: string, correlationId: string = randomUUID()): Promise<"LAPSED" | "INCIDENT" | "SKIPPED"> {
    // PayPal first, with no lock held (see the top of this file). A refusal says nothing about the
    // money, and the date alone proves expiry (G-AUTH-EXPIRED): it must not leave a dead hold
    // looking active. An outage does throw, so the job asks again.
    let paypalStatus = "UNKNOWN";
    try {
      paypalStatus = await this.provider.getAuthorizationStatus(authorizationId);
    } catch (error) {
      if (!(error instanceof ProviderDeclinedError)) throw error;
      this.log.warn(`Lapse of ${authorizationId}: PayPal refused the read (${error.reason}); going by the date`);
    }
    return this.db.transaction(async (tx) => {
      const m = await this.load(tx, milestoneId, true, null);
      const hold = m.holds.find((h) => h.authorizationId === authorizationId);
      // A replaced authorization, a hold already settled, or a timer that fired early: stale.
      if (hold?.holdStatus !== "AUTHORIZED") return "SKIPPED" as const;
      const elapsed = hold.authorizationExpiresAt !== null && this.clock.now() >= hold.authorizationExpiresAt;
      if (paypalStatus !== "EXPIRED" && !elapsed) return "SKIPPED" as const;
      // The date passed and PayPal says it settled. Calling it lapsed would contradict the money.
      if (paypalStatus === "CAPTURED" || paypalStatus === "VOIDED") {
        this.log.error(`Authorization ${authorizationId} of milestone ${milestoneId} reached its expiry as ${paypalStatus}, and hold ${hold.id} says AUTHORIZED; admin alert`);
        return "INCIDENT" as const;
      }
      const canFundAgain = m.row.state === "FUNDED" || m.row.state === "IN_PROGRESS" || m.row.state === "APPROVED";
      // Back to "not authorized": fundedMinor before SM-T03 is what is authorized right now.
      const patch: HoldPatch = canFundAgain ? { holdStatus: "EXPIRED", fundedMinor: 0 } : { holdStatus: "EXPIRED" };
      const { summary } = await this.writeHolds(tx, m.holds, new Map([[hold.id, patch]]));
      await this.ledger(tx, { milestoneId, holdId: hold.id, type: "AUTHORIZATION_EXPIRED", paypal: { authorizationId }, idempotencyKey: `expired-${authorizationId}`, source: "API_RESPONSE", occurredAt: this.clock.now() });
      if (m.row.state === "FUNDED" || m.row.state === "IN_PROGRESS") {
        await this.apply(tx, m, "SM-T17", systemActor("payments.authorization.lapse"), correlationId, summary);
        return "LAPSED" as const;
      }
      await tx.update(milestones).set(summary).where(eq(milestones.id, milestoneId));
      if (m.row.state === "APPROVED") return "LAPSED" as const;
      this.log.error(`SM-INV-6: authorization ${authorizationId} of milestone ${milestoneId} expired in ${m.row.state}; admin alert, no transition`);
      return "INCIDENT" as const;
    });
  }

  async listEscalatedObjections(caller: Caller) {
    if (!this.isReviewer(caller)) throw new ProblemException("FORBIDDEN", 403, "Only a reviewer can see this", "This list is for neutral reviewers.");
    // Oldest first, and bounded: each row reads its case, and an unbounded queue made this page time out.
    const rows = await this.db.select().from(objections).where(eq(objections.status, "ESCALATED")).orderBy(asc(objections.escalateAt)).limit(100);
    const items = [];
    for (const objection of rows) {
      const facts = await this.caseFacts(objection.milestoneId);
      // G-ACTOR-NEUTRAL: their own contracts are not theirs to rule on, so they are not offered.
      if ((await partyRoleIn(this.db, facts.contract, caller.user.id)) !== null) continue;
      items.push({ objection: objectionView(objection, await this.messagesOf(this.db, objection.id)), contractId: facts.contract.id, contractTitle: facts.m.snapshot.title, milestoneTitle: facts.m.def.title, amount: facts.m.def.amount, buyerName: facts.buyerName, sellerName: facts.sellerName });
    }
    return { items };
  }

  async getObjectionCase(objectionId: string, caller: Caller) {
    const [objection] = await this.db.select().from(objections).where(eq(objections.id, objectionId));
    if (objection === undefined || !(await this.reviewerMayRead(objection.milestoneId, caller)) || !["ESCALATED", "RULED_RELEASE", "RULED_VOID"].includes(objection.status)) throw notFound();
    const facts = await this.caseFacts(objection.milestoneId);
    const rows = await this.db.select().from(submissions).where(eq(submissions.milestoneId, objection.milestoneId)).orderBy(asc(submissions.attempt));
    return {
      objection: objectionView(objection, await this.messagesOf(this.db, objectionId)),
      contractId: facts.contract.id,
      contractTitle: facts.m.snapshot.title,
      milestone: await milestoneDetail(this.db, facts.m.row),
      buyerName: facts.buyerName,
      sellerName: facts.sellerName,
      submissions: rows.map(submissionView),
    };
  }

  private async caseFacts(milestoneId: string) {
    const m = await this.load(this.db, milestoneId, false, null);
    const [contract] = await this.db.select().from(contracts).where(eq(contracts.id, m.row.contractId));
    if (contract === undefined) throw new Error(`Milestone ${milestoneId} has no contract`);
    const people = await this.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [m.buyerId, m.sellerId]));
    const nameOf = (id: string) => people.find((p) => p.id === id)?.name ?? "";
    return { m, contract, buyerName: nameOf(m.buyerId), sellerName: nameOf(m.sellerId) };
  }

  // ---------------------------------------------------------------- endings (SM-T15, T16, T22)

  // SM-T22: the seller (or an admin) accepts what was released; the rest goes back to the buyer.
  async acceptPartial(tx: Tx, caller: Caller, milestoneId: string, ifMatch: string | undefined) {
    const m = await this.load(tx, milestoneId, true, caller.user.roles.includes("ADMIN") ? null : caller.user.id);
    this.requireRole(m, caller, ["SELLER", "ADMIN"]);
    this.ifMatch(m, ifMatch);
    assertAllowed("SM-T22", m.row.state);
    // G-NO-RELEASE-IN-FLIGHT: voiding while PayPal is still capturing could void money that is
    // being paid. Wait for the capture to settle first.
    await this.requireNoReleaseInFlight(tx, milestoneId);
    const after = await this.returnHeld(tx, m, "SM-T22", userActor(caller), caller.requestId);
    await enqueueEvent(tx, {
      type: "payments.milestone.closed",
      actor: userActor(caller),
      contractId: m.row.contractId,
      milestoneId,
      correlationId: caller.requestId,
      payload: { transitionId: "SM-T22", releasedAmount: { amountMinor: after.releasedMinor, currency: m.def.amount.currency }, returnedAmount: { amountMinor: after.returnedMinor, currency: m.def.amount.currency } },
    });
    return milestoneDetail(tx, after);
  }

  // SM-T15 (funded: every hold is voided) or SM-T16 (not funded yet: the holds already
  // authorized are voided, state machine 2.1.0).
  async cancel(tx: Tx, caller: Caller, milestoneId: string, ifMatch: string | undefined, reason: string) {
    const m = await this.load(tx, milestoneId, true, caller.user.roles.includes("ADMIN") ? null : caller.user.id);
    this.requireRole(m, caller, ["BUYER", "SELLER", "ADMIN"]);
    this.ifMatch(m, ifMatch);
    const id = m.row.state === "FUNDED" || m.row.state === "IN_PROGRESS" ? "SM-T15" : "SM-T16";
    assertAllowed(id, m.row.state);
    // No guard on SM-T16 since 2.1.0. Refusing while a hold was authorized left a buyer who
    // stopped halfway with money reserved and no way out but the 29-day expiry. A confirm
    // racing this cancel loses on the row lock, and its authorization is voided as an orphan.
    const hadHold = m.holds.some((h) => h.holdStatus === "AUTHORIZED");
    const after = await this.returnHeld(tx, m, id, userActor(caller), caller.requestId);
    await enqueueEvent(tx, { type: "payments.milestone.voided", actor: userActor(caller), contractId: m.row.contractId, milestoneId, correlationId: caller.requestId, payload: { transitionId: id, hadHold, reason } });
    return milestoneDetail(tx, after);
  }

  // ---------------------------------------------------------------- jobs: PayPal after commit

  // payments.capture, one per ReleasePart. Runs after the release committed, so the decision is
  // durable before any money moves. The requestId never changes across retries
  // (capture-{milestoneId}-{seq}-{holdId}): if PayPal captured but the answer was lost, the
  // retry gets the same capture back.
  async processCapture(releasePartId: string, correlationId: string = randomUUID()): Promise<CaptureResult> {
    const [part] = await this.db.select().from(releaseParts).where(eq(releaseParts.id, releasePartId));
    if (part?.status !== "PENDING") return "SKIPPED"; // already settled by an earlier try
    if (part.captureId !== null) return "PENDING"; // PayPal answered PENDING before; capture.check follows it
    const [rel] = await this.db.select().from(releases).where(eq(releases.id, part.releaseId));
    const [hold] = await this.db.select().from(holds).where(eq(holds.id, part.holdId));
    if (rel === undefined || hold?.authorizationId == null) throw new Error(`Release part ${releasePartId} has no authorization`);
    const money = (amountMinor: number) => ({ amountMinor, currency: rel.currency });
    let outcome: CaptureOutcome;
    try {
      outcome = {
        kind: "answered",
        ...(await this.provider.capture({
          authorizationId: hold.authorizationId,
          amount: money(part.amountMinor),
          platformFee: money(part.platformFeeMinor),
          final: rel.final,
          invoiceId: `settld-${rel.milestoneId}-capture-${String(rel.seq)}-${hold.id}`,
          requestId: `capture-${rel.milestoneId}-${String(rel.seq)}-${hold.id}`,
        })),
      };
    } catch (error) {
      // ProviderUnavailableError propagates: the job retries with the same requestId.
      if (!(error instanceof ProviderDeclinedError)) throw error;
      outcome = { kind: "declined", reason: error.reason };
    }
    return this.recordCapture(releasePartId, outcome, correlationId);
  }

  // payments.capture.check. PayPal answered PENDING (for example, a payment under review); until
  // webhooks exist, this job asks PayPal again with backoff until the capture settles (H2
  // review, finding 4). Still pending: it throws so pg-boss retries later.
  async processCaptureCheck(releasePartId: string, correlationId: string = randomUUID()): Promise<CaptureResult> {
    const [part] = await this.db.select().from(releaseParts).where(eq(releaseParts.id, releasePartId));
    if (part?.status !== "PENDING" || part.captureId === null) return "SKIPPED";
    let outcome: CaptureOutcome;
    try {
      outcome = { kind: "answered", ...(await this.provider.getCapture(part.captureId)) };
    } catch (error) {
      if (!(error instanceof ProviderDeclinedError)) throw error;
      outcome = { kind: "declined", reason: error.reason };
    }
    if (outcome.kind === "answered" && outcome.status === "PENDING") throw new ProviderUnavailableError(`Capture ${part.captureId} is still pending at PayPal`);
    return this.recordCapture(releasePartId, outcome, correlationId);
  }

  // Writes PayPal's answer about one part, under the milestone lock.
  private recordCapture(releasePartId: string, outcome: CaptureOutcome, correlationId: string): Promise<CaptureResult> {
    return this.db.transaction(async (tx) => {
      const [first] = await tx.select().from(releaseParts).where(eq(releaseParts.id, releasePartId));
      if (first === undefined) throw new Error(`Release part ${releasePartId} vanished`);
      const [rel] = await tx.select().from(releases).where(eq(releases.id, first.releaseId));
      if (rel === undefined) throw new Error(`Release ${first.releaseId} vanished`);
      const m = await this.load(tx, rel.milestoneId, true, null);
      // Re-read under the lock: two tries of the same job must not both record the answer.
      const [part] = await tx.select().from(releaseParts).where(eq(releaseParts.id, releasePartId));
      const hold = m.holds.find((h) => h.id === first.holdId);
      if (part?.status !== "PENDING" || hold === undefined) return "SKIPPED" as const;
      const actor = systemActor("payments.capture");
      const money = (amountMinor: number) => ({ amountMinor, currency: rel.currency });
      const requestId = `capture-${rel.milestoneId}-${String(rel.seq)}-${hold.id}`;
      const authorizationId = hold.authorizationId ?? "";
      const now = this.clock.now();

      if (outcome.kind === "answered" && outcome.status === "PENDING") {
        await tx.update(releaseParts).set({ captureId: outcome.captureId, updatedAt: now }).where(eq(releaseParts.id, part.id));
        // Keyed by the part, not the release: two parts of one release can both be PENDING.
        await this.jobs.send(tx, { queue: "payments.capture.check", singletonKey: `capture-check:${part.id}`, startAfter: new Date(now.getTime() + 60_000), data: { milestoneId: m.row.id, releaseId: rel.id, releasePartId: part.id, captureId: outcome.captureId } });
        return "PENDING" as const;
      }

      if (outcome.kind === "answered") {
        await tx.update(releaseParts).set({ status: "CAPTURED", captureId: outcome.captureId, updatedAt: now }).where(eq(releaseParts.id, part.id));
        if (rel.final) {
          const { summary } = await this.writeHolds(tx, m.holds, new Map([[hold.id, { holdStatus: "CAPTURED" } satisfies HoldPatch]]));
          await tx.update(milestones).set({ holdStatus: summary.holdStatus }).where(eq(milestones.id, m.row.id));
        }
        await this.ledger(tx, { milestoneId: m.row.id, releaseId: rel.id, holdId: hold.id, releasePartId: part.id, type: "CAPTURED", amountMinor: part.amountMinor, currency: rel.currency, platformFeeMinor: part.platformFeeMinor, paypal: { authorizationId, captureId: outcome.captureId }, idempotencyKey: requestId, source: "API_RESPONSE", occurredAt: now });
        await this.settleRelease(tx, rel.id);
        await enqueueEvent(tx, { type: "payments.capture.completed", actor, contractId: m.row.contractId, milestoneId: m.row.id, correlationId, payload: { releaseId: rel.id, releaseSeq: rel.seq, captureId: outcome.captureId, amount: money(part.amountMinor), platformFee: money(part.platformFeeMinor), netToSeller: money(part.amountMinor - part.platformFeeMinor) } });
        return "CAPTURED" as const;
      }

      // Declined: this part's money never moved. The other parts of the release are untouched:
      // each payee's capture stands or falls on its own (ADR-0009, rule 3).
      await tx.update(releaseParts).set({ status: "FAILED", updatedAt: now }).where(eq(releaseParts.id, part.id));
      await this.ledger(tx, { milestoneId: m.row.id, releaseId: rel.id, holdId: hold.id, releasePartId: part.id, type: "CAPTURE_DENIED", amountMinor: part.amountMinor, currency: rel.currency, paypal: { authorizationId, reason: outcome.reason }, idempotencyKey: `${requestId}:denied`, source: "API_RESPONSE", occurredAt: now });
      const reverted = !rel.final;
      if (rel.final) {
        // The authorization may already be closed, so the rest cannot be released again by a
        // later round. An admin resolves it (paypal-integration.md: never a new request id).
        const { summary } = await this.writeHolds(tx, m.holds, new Map([[hold.id, { holdStatus: "CAPTURE_FAILED" } satisfies HoldPatch]]));
        await tx.update(milestones).set({ holdStatus: summary.holdStatus }).where(eq(milestones.id, m.row.id));
        this.log.error(`Final capture ${requestId} declined (${outcome.reason}); admin alert`);
      } else {
        // A declined partial part is taken back out of its own hold's releasedMinor (SM-INV-10,
        // 1.1.0), so the next round releases it again to that payee. Leaving it counted made the
        // final capture (funded - released, final_capture: true) hand the declined share back to
        // the buyer while the ledger said the payee had it (H2 review, attack 2).
        await tx.execute(sql`SET LOCAL settld.release_revert = 'on'`);
        const { summary } = await this.writeHolds(tx, m.holds, new Map([[hold.id, { releasedMinor: hold.releasedMinor - part.amountMinor } satisfies HoldPatch]]));
        const [after] = await tx.update(milestones).set(summary).where(eq(milestones.id, m.row.id)).returning();
        if (after === undefined) throw new Error("update returned nothing");
        await recordAudit(tx, {
          actor,
          action: "milestone.release.reverted",
          entityType: "Milestone",
          entityId: m.row.id,
          contractId: m.row.contractId,
          before: { releasedMinor: m.row.releasedMinor },
          after: { releasedMinor: after.releasedMinor, releaseSeq: rel.seq, holdId: hold.id, reason: outcome.reason },
          requestId: correlationId,
        });
        // SM-T26: nothing remains released on any hold, so the state goes back to the seller.
        if (after.releasedMinor === 0 && after.state === "PARTIALLY_RELEASED") await this.apply(tx, { ...m, row: after }, "SM-T26", actor, correlationId);
      }
      await this.settleRelease(tx, rel.id);
      await enqueueEvent(tx, { type: "payments.capture.failed", actor, contractId: m.row.contractId, milestoneId: m.row.id, correlationId, payload: { releaseId: rel.id, releaseSeq: rel.seq, authorizationId, paypalDebugId: null, reason: outcome.reason, reverted } });
      return "FAILED" as const;
    });
  }

  // domain-model.md, Release: PENDING while any part is, FAILED when every part failed,
  // CAPTURED otherwise. G-NO-RELEASE-IN-FLIGHT and paidFor read this, not the parts.
  private async settleRelease(tx: Tx, releaseId: string) {
    const parts = await tx.select({ status: releaseParts.status }).from(releaseParts).where(eq(releaseParts.releaseId, releaseId));
    if (parts.some((p) => p.status === "PENDING")) return;
    const status = parts.every((p) => p.status === "FAILED") ? "FAILED" : "CAPTURED";
    await tx.update(releases).set({ status, updatedAt: this.clock.now() }).where(eq(releases.id, releaseId));
  }

  // ---------------------------------------------------------------- orphan authorizations

  // fund:confirm authorized an order at PayPal, and then the transaction that would record it
  // failed (G-AUTH-MATCHES, an expired hold, or the milestone moved on). The hold is real money
  // reserved on the buyer's account, so it is recorded and voided in a transaction that commits
  // before the error reaches the buyer (H2 review, finding 6).
  async voidOrphan(milestoneId: string, authorized: Authorized, correlationId: string = randomUUID()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update");
      const [hold] = await tx.select().from(holds).where(eq(holds.id, authorized.holdId));
      // The same authorization funding its hold is not an orphan: never void it.
      if (m === undefined || hold === undefined || hold.authorizationId === authorized.auth.authorizationId) return;
      const { auth } = authorized;
      const authorizationId = auth.authorizationId;
      const requestId = `void-orphan-${milestoneId}-${authorizationId}`;
      // The AUTHORIZED fact carries the hold id: the void job reads the payee from it.
      await this.ledger(tx, { milestoneId, holdId: hold.id, type: "AUTHORIZED", amountMinor: auth.amount.amountMinor, currency: auth.amount.currency, paypal: { authorizationId, orphan: "true" }, idempotencyKey: authorized.requestId, source: "API_RESPONSE", occurredAt: auth.authorizedAt });
      await this.ledger(tx, { milestoneId, holdId: hold.id, type: "VOID_REQUESTED", amountMinor: auth.amount.amountMinor, currency: auth.amount.currency, paypal: { authorizationId, orphan: "true" }, idempotencyKey: `${requestId}:requested`, source: "API_RESPONSE", occurredAt: this.clock.now() });
      await this.jobs.send(tx, { queue: "payments.authorization.void-orphan", singletonKey: `void-orphan:${authorizationId}`, data: { milestoneId, authorizationId, requestId } });
      await recordAudit(tx, { actor: systemActor("payments.fund-confirm"), action: "payments.authorization.orphaned", entityType: "Milestone", entityId: milestoneId, contractId: m.contractId, after: { authorizationId, holdId: hold.id }, requestId: correlationId });
    });
  }

  // payments.authorization.void-orphan. The payee comes from the hold the orphan was for, as the
  // ledger recorded it: each hold's authorization belongs to a different PayPal account, and the
  // job payload (events.md) names only the authorization.
  async processVoidOrphan(milestoneId: string, authorizationId: string, requestId: string): Promise<"VOIDED" | "FAILED"> {
    const [row] = await this.db
      .select({ payee: holds.payeeMerchantId })
      .from(paymentEvents)
      .innerJoin(holds, eq(holds.id, paymentEvents.holdId))
      .where(and(eq(paymentEvents.milestoneId, milestoneId), eq(paymentEvents.type, "AUTHORIZED"), sql`${paymentEvents.paypal}->>'authorizationId' = ${authorizationId}`));
    if (row === undefined) throw new Error(`Orphan ${authorizationId} has no recorded hold`);
    try {
      await this.provider.void({ authorizationId, payeeMerchantId: row.payee, requestId });
    } catch (error) {
      if (!(error instanceof ProviderDeclinedError)) throw error;
      this.log.error(`Orphan void ${requestId} declined (${error.reason}); admin alert`);
      return "FAILED";
    }
    await this.db.transaction((tx) => this.ledger(tx, { milestoneId, type: "VOIDED", paypal: { authorizationId, orphan: "true" }, idempotencyKey: requestId, source: "API_RESPONSE", occurredAt: this.clock.now() }));
    return "VOIDED";
  }

  // payments.void, one per hold: E-VOID, that hold's held amount back to the buyer. The job
  // re-reads the hold and only calls PayPal while it is still VOID_PENDING.
  //
  // Nothing captured on this hold: a void. Something already captured: PayPal refuses the void
  // on a partially captured authorization (sandbox, 2026-10-22, PP-T16), so the rest goes back
  // by a final capture of the held amount and a refund of that capture (constitution II allows
  // a return to be a void or a refund). Both requestIds are fixed per hold, so a retry after a
  // crash between the two replays the capture PayPal already made and refunds it once.
  async processVoid(holdId: string, correlationId: string = randomUUID()): Promise<"VOIDED" | "FAILED" | "SKIPPED"> {
    const [hold] = await this.db.select().from(holds).where(eq(holds.id, holdId));
    if (hold === undefined || hold.holdStatus !== "VOID_PENDING" || hold.authorizationId === null) return "SKIPPED";
    const { milestoneId, authorizationId } = hold;
    const m = await this.load(this.db, milestoneId, false, null);
    const returnedByRefund = hold.releasedMinor > 0;
    // returnedMinor is set once, by the return transition, to exactly what was still held.
    const held = { amountMinor: hold.returnedMinor, currency: m.def.amount.currency };
    const payee = hold.payeeMerchantId;
    const facts: (typeof paymentEvents.$inferInsert)[] = [];
    try {
      if (!returnedByRefund) {
        const requestId = `void-${holdId}-${authorizationId}`;
        await this.provider.void({ authorizationId, payeeMerchantId: payee, requestId });
        facts.push({ milestoneId, holdId, type: "VOIDED", paypal: { authorizationId }, idempotencyKey: requestId, source: "API_RESPONSE", occurredAt: this.clock.now() });
      } else {
        const captureRequest = `return-capture-${holdId}`;
        const refundRequest = `return-refund-${holdId}`;
        const capture = await this.provider.capture({ authorizationId, amount: held, platformFee: { ...held, amountMinor: 0 }, final: true, invoiceId: `settld-${holdId}-return`, requestId: captureRequest });
        await this.provider.refund({ captureId: capture.captureId, amount: held, payeeMerchantId: payee, requestId: refundRequest });
        const paypal = { authorizationId, captureId: capture.captureId, return: "true" };
        facts.push({ milestoneId, holdId, type: "CAPTURED", amountMinor: held.amountMinor, currency: held.currency, paypal, idempotencyKey: captureRequest, source: "API_RESPONSE", occurredAt: this.clock.now() });
        facts.push({ milestoneId, holdId, type: "REFUNDED", amountMinor: held.amountMinor, currency: held.currency, paypal, idempotencyKey: refundRequest, source: "API_RESPONSE", occurredAt: this.clock.now() });
      }
    } catch (error) {
      // Unavailable propagates and the job retries with the same ids. A refusal is an incident:
      // returnedMinor already says the money is the buyer's, so a person has to finish it.
      if (!(error instanceof ProviderDeclinedError)) throw error;
      this.log.error(`Return of hold ${holdId} declined (${error.reason}); admin alert`);
      return "FAILED";
    }
    return this.db.transaction(async (tx) => {
      const locked = await this.load(tx, milestoneId, true, null);
      if (locked.holds.find((h) => h.id === holdId)?.holdStatus !== "VOID_PENDING") return "SKIPPED" as const;
      const { summary } = await this.writeHolds(tx, locked.holds, new Map([[holdId, { holdStatus: "VOIDED" } satisfies HoldPatch]]));
      await tx.update(milestones).set({ holdStatus: summary.holdStatus }).where(eq(milestones.id, milestoneId));
      for (const fact of facts) await this.ledger(tx, fact);
      await enqueueEvent(tx, { type: "payments.void.completed", actor: systemActor("payments.void"), contractId: locked.row.contractId, milestoneId, correlationId, payload: { authorizationId, returnedBy: returnedByRefund ? "CAPTURE_AND_REFUND" : "VOID", amount: held } });
      return "VOIDED" as const;
    });
  }
}

// ---------------------------------------------------------------- views (openapi.yaml)

function submissionView(s: typeof submissions.$inferSelect) {
  return { id: s.id, milestoneId: s.milestoneId, attempt: s.attempt, evidenceLinks: s.evidenceLinks, notes: s.notes, submittedAt: s.submittedAt.toISOString(), runId: s.runId };
}

function objectionView(o: typeof objections.$inferSelect, messages: readonly (typeof objectionMessages.$inferSelect)[] = []) {
  return {
    id: o.id,
    milestoneId: o.milestoneId,
    runId: o.runId,
    criterionIds: o.criterionIds,
    reason: o.reason,
    status: o.status,
    raisedAt: o.raisedAt.toISOString(),
    contestedAt: o.contestedAt?.toISOString() ?? null,
    escalateAt: o.escalateAt.toISOString(),
    resolution: o.resolvedAt === null ? null : { by: { type: "USER" as const, id: o.resolvedBy ?? o.raisedBy }, at: o.resolvedAt.toISOString(), ...(o.resolutionReason === null ? {} : { reason: o.resolutionReason }) },
    messages: messages.map((x) => ({ id: x.id, authorId: x.authorId, body: x.body, createdAt: x.createdAt.toISOString() })),
  };
}
