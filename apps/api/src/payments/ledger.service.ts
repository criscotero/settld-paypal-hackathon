// GET /payments (ADR-0017): every money fact of the caller's contracts, across contracts.
//
// Read only: no locks, no transaction, no PayPal. A read that lands right after a decision shows
// the facts recorded so far and the next refresh shows the rest; nothing here decides anything, so
// holding locks would only slow down the writers that do.
import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, exists, gte, inArray, lt, or } from "drizzle-orm";
import type { ContractSnapshot } from "../contracts/snapshot.js";
import { DB } from "../db/database.js";
import type { Db } from "../db/database.js";
import { contractParties, contracts, contractVersions, holds, humanCriterionDecisions, milestones, paymentEvents, releases, runOutcomes, users } from "../db/schema.js";
import type { Clock } from "./clock.js";
import { CLOCK } from "./clock.js";
import { criteriaPaidBy, ledgerAmountMinor, ledgerEffect, paypalReference } from "./ledger-entry.js";
import { PAYPAL_WEB_BASE } from "./paypal-config.js";
import { paypalUrl } from "./paypal-links.js";

// Past this the query is slow and any total would be partial. The answer says so (`truncated`)
// instead of paging, because the screen adds up what it has: a page would look like a full total.
export const LEDGER_ROW_LIMIT = 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
// E-CAPTURE for SM-T13: a reviewer ruled for release, so every criterion counts by a person's decision.
const REVIEWER_RELEASE = "SM-T13";

type Role = "BUYER" | "SELLER" | "COLLABORATOR";

@Injectable()
export class LedgerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYPAL_WEB_BASE) private readonly paypalWebBase: string | null,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // `from` and `to` are whole UTC days, both included, as validated `YYYY-MM-DD` strings.
  async list(userId: string, from: string, to: string) {
    const start = new Date(`${from}T00:00:00.000Z`);
    const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS);

    // The scope is in the SQL, so nothing another party should not see ever leaves the database.
    // It has to agree with MilestonesService.paymentEvents: buyer and seller see the whole contract,
    // a collaborator only facts of their own hold, and only while they are a party. Facts with no
    // hold (an orphan's VOIDED) fail the holds condition, so they stay out of a collaborator's view.
    const isCollaborator = exists(this.db.select({ one: contractParties.userId }).from(contractParties).where(and(eq(contractParties.contractId, contracts.id), eq(contractParties.userId, userId))));
    const rows = await this.db
      .select({ event: paymentEvents, contractId: contracts.id, buyerId: contracts.buyerId, sellerId: contracts.sellerId, snapshot: contractVersions.snapshot, holdPayee: holds.payeeUserId, holdReturnedMinor: holds.returnedMinor })
      .from(paymentEvents)
      .innerJoin(milestones, eq(milestones.id, paymentEvents.milestoneId))
      .innerJoin(contracts, eq(contracts.id, milestones.contractId))
      // The milestone's locked version, not the contract's current one: a later amendment must not
      // rename what an old payment paid for (DM-INV-2).
      .innerJoin(contractVersions, eq(contractVersions.id, milestones.lockedVersionId))
      .leftJoin(holds, eq(holds.id, paymentEvents.holdId))
      .where(and(gte(paymentEvents.occurredAt, start), lt(paymentEvents.occurredAt, end), or(eq(contracts.buyerId, userId), eq(contracts.sellerId, userId), and(eq(holds.payeeUserId, userId), isCollaborator))))
      // id breaks ties: several facts share an instant, and without it the order would change between
      // refreshes and the grid would reshuffle rows under the person reading them.
      .orderBy(desc(paymentEvents.occurredAt), desc(paymentEvents.id))
      // One more than the limit is the cheapest honest way to learn there are more.
      .limit(LEDGER_ROW_LIMIT + 1);

    const truncated = rows.length > LEDGER_ROW_LIMIT;
    const page = rows.slice(0, LEDGER_ROW_LIMIT);

    const names = await this.namesOf(page.flatMap((r) => [r.buyerId, r.sellerId, r.holdPayee]));
    const why = await this.releaseContext(page.flatMap((r) => (r.event.releaseId === null ? [] : [r.event.milestoneId])));

    const now = this.clock.now();
    const items = page.map((r) => {
      const e = r.event;
      const snapshot = r.snapshot as ContractSnapshot;
      const def = snapshot.milestones.find((m) => m.id === e.milestoneId);
      if (def === undefined) throw new Error(`Milestone ${e.milestoneId} is missing from its locked version`);
      const myRole: Role = r.buyerId === userId ? "BUYER" : r.sellerId === userId ? "SELLER" : "COLLABORATOR";
      const effect = ledgerEffect(e);
      const amountMinor = ledgerAmountMinor({ effect, type: e.type, amountMinor: e.amountMinor, holdReturnedMinor: r.holdReturnedMinor });
      // A void has no currency of its own; a milestone is in one currency, the snapshot's.
      const currency = e.currency ?? def.amount.currency;
      const release = e.releaseId === null ? undefined : why.releases.get(e.releaseId);
      const peers = why.byMilestone.get(e.milestoneId) ?? [];
      const outcome = release?.runId == null ? undefined : why.outcomes.get(release.runId);
      const verdicts = new Map((outcome?.results ?? []).map((c) => [c.criterionId, c.verdict]));
      const paidIds = new Set(release === undefined ? [] : criteriaPaidBy(release, peers));
      const approved = release?.runId == null ? undefined : why.approvals.get(release.runId);
      const reference = paypalReference(e.paypal);
      // The buyer paid every hold, so every fact is in their PayPal. Anyone else only has the facts of
      // the hold that pays them: a seller has no record of a collaborator's capture.
      const viewer = myRole === "BUYER" ? "PAYER" : r.holdPayee === userId ? "PAYEE" : "NONE";
      return {
        id: e.id,
        type: e.type,
        occurredAt: e.occurredAt.toISOString(),
        source: e.source,
        milestoneId: e.milestoneId,
        milestoneTitle: def.title,
        contractId: r.contractId,
        contractTitle: snapshot.title,
        myRole,
        counterpartyName: (myRole === "BUYER" ? names.get(r.holdPayee ?? r.sellerId ?? "") : names.get(r.buyerId)) ?? null,
        amount: amountMinor === null ? null : { amountMinor, currency },
        platformFee: e.platformFeeMinor === null ? null : { amountMinor: e.platformFeeMinor, currency },
        ledgerEffect: effect,
        ...reference,
        paypalUrl: paypalUrl({ webBase: this.paypalWebBase, viewer, ...reference, occurredAt: e.occurredAt, now }),
        releaseId: e.releaseId,
        // In the order of the agreement, which is how the receipt shows them.
        criteria: def.criteria
          .filter((c) => paidIds.has(c.id))
          .map((c) => ({ criterionId: c.id, title: c.text, weightBps: c.weightBps, verdict: verdicts.get(c.id) ?? null, humanApproved: release?.transitionId === REVIEWER_RELEASE || approved?.has(c.id) === true })),
        reportHash: outcome?.reportHash ?? null,
      };
    });
    return { items, truncated };
  }

  private async namesOf(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const wanted = [...new Set(ids.filter((id) => id !== null))];
    if (wanted.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, wanted));
    return new Map(rows.map((u) => [u.id, u.name]));
  }

  // Loaded in bulk, once for the whole page: one query per row would be a thousand queries.
  private async releaseContext(milestoneIds: readonly string[]) {
    const wanted = [...new Set(milestoneIds)];
    if (wanted.length === 0) return { releases: new Map<string, typeof releases.$inferSelect>(), byMilestone: new Map<string, (typeof releases.$inferSelect)[]>(), outcomes: new Map<string, typeof runOutcomes.$inferSelect>(), approvals: new Map<string, Set<string>>() };
    // Every release of each milestone, even outside the date range or the page: what a release added
    // depends on the ones before it, and a filter must not change what a payment paid for.
    const rows = await this.db.select().from(releases).where(inArray(releases.milestoneId, wanted));
    const byMilestone = new Map<string, (typeof releases.$inferSelect)[]>();
    for (const r of rows) byMilestone.set(r.milestoneId, [...(byMilestone.get(r.milestoneId) ?? []), r]);
    const runIds = [...new Set(rows.flatMap((r) => (r.runId === null ? [] : [r.runId])))];
    const outcomes = runIds.length === 0 ? [] : await this.db.select().from(runOutcomes).where(inArray(runOutcomes.runId, runIds));
    const decisions = runIds.length === 0 ? [] : await this.db.select({ runId: humanCriterionDecisions.runId, criterionId: humanCriterionDecisions.criterionId }).from(humanCriterionDecisions).where(inArray(humanCriterionDecisions.runId, runIds));
    const approvals = new Map<string, Set<string>>();
    for (const d of decisions) approvals.set(d.runId, new Set([...(approvals.get(d.runId) ?? []), d.criterionId]));
    return { releases: new Map(rows.map((r) => [r.id, r])), byMilestone, outcomes: new Map(outcomes.map((o) => [o.runId, o])), approvals };
  }
}
