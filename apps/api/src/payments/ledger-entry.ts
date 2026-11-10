// What a row of the payments ledger means (ADR-0017). Pure, so every rule can be tested alone, and
// in the server so the grid never learns event types: it adds up what this file marked. If the
// browser decided, a new event type could change a total without any test noticing.
import type { PaymentEventType, ReleaseStatus } from "../db/schema.js";

export type LedgerEffect = "PAID" | "RETURNED" | "NONE";

export interface LedgerFact {
  readonly type: PaymentEventType;
  readonly releasePartId: string | null;
  readonly holdId: string | null;
  readonly paypal: Readonly<Record<string, string>>;
}

export function ledgerEffect(fact: LedgerFact): LedgerEffect {
  // An orphan is a second authorization for a hold already funded (constitution V): it never paid
  // for this milestone, so neither it nor undoing it can move a total.
  if (fact.paypal.orphan === "true") return "NONE";
  switch (fact.type) {
    case "CAPTURED":
      // A return after a partial release captures the rest and refunds it at once (PP-T16). That
      // capture really happened in PayPal, so the row stays, but counting it as paid would report
      // money the seller never kept. The REFUNDED fact next to it is the one that counts.
      return fact.paypal.return !== "true" && fact.releasePartId !== null ? "PAID" : "NONE";
    case "REFUNDED":
      return "RETURNED";
    case "VOIDED":
      return fact.holdId === null ? "NONE" : "RETURNED";
    default:
      return "NONE";
  }
}

// A VOIDED fact carries no amount. Reading it from the hold is safe because returned_minor is set
// once, by the return transition, to exactly what was still held. Anything else keeps its own
// amount, or stays null: this is an audit view and must not invent a number.
export function ledgerAmountMinor(input: { readonly effect: LedgerEffect; readonly type: PaymentEventType; readonly amountMinor: number | null; readonly holdReturnedMinor: number | null }): number | null {
  if (input.effect === "RETURNED" && input.type === "VOIDED") return input.holdReturnedMinor;
  return input.amountMinor;
}

export type PaypalIdKind = "CAPTURE" | "AUTHORIZATION" | "ORDER";

// The most specific id wins, since that is the one to look for in PayPal. A REFUNDED fact shows the
// capture it returned: PaymentProvider.refund does not hand back a refund id (ADR-0017).
export function paypalReference(paypal: Readonly<Record<string, string>>): { paypalId: string | null; paypalIdKind: PaypalIdKind | null } {
  // `||`, not `??`: AUTHORIZED records orderId as "" when the hold has no order id yet.
  if (paypal.captureId) return { paypalId: paypal.captureId, paypalIdKind: "CAPTURE" };
  if (paypal.authorizationId) return { paypalId: paypal.authorizationId, paypalIdKind: "AUTHORIZATION" };
  if (paypal.orderId) return { paypalId: paypal.orderId, paypalIdKind: "ORDER" };
  return { paypalId: null, paypalIdKind: null };
}

export interface ReleaseCounted {
  readonly seq: number;
  readonly status: ReleaseStatus;
  readonly countedCriterionIds: readonly string[];
}

// countedCriterionIds is cumulative, so a row showing it as is would claim the second payment was
// also for what the first one paid. FAILED releases are skipped: PayPal declined them, so their
// criteria were never paid and count again in the next round (the same rule as paidFor in
// milestones.service.ts).
export function criteriaPaidBy(release: ReleaseCounted, all: readonly ReleaseCounted[]): string[] {
  const earlier = new Set(all.filter((r) => r.seq < release.seq && r.status !== "FAILED").flatMap((r) => r.countedCriterionIds));
  return release.countedCriterionIds.filter((id) => !earlier.has(id));
}
