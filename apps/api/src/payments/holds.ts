// The money of a milestone, one Hold per team member (ADR-0009; domain-model.md, Hold). Pure
// functions: the state machine calls them under the milestone lock, the tests call them alone.
//
// The milestone row keeps fundedMinor, releasedMinor, returnedMinor, holdStatus and
// authorizationExpiresAt as a summary of its holds. They are never computed on their own: every
// write to a hold writes `rollup(holds)` to the milestone in the same transaction, and a
// deferred trigger (migration 0012) refuses the commit if the two ever disagree.
import type { HoldStatus } from "../db/schema.js";
import { FULL_BPS, shareOf } from "./release-math.js";

// ADR-0009, rule 1: each member gets floor(amount × shareBps / 10 000), and the seller also gets
// the remainder of those divisions. The parts add up to the amount exactly (constitution V).
// The seller takes the remainder (at most N−1 cents) because the seller is the one party every
// contract has; largest-remainder would be fairer by a cent but would make who gets it depend on
// the shares, which is harder to explain on a receipt.
export function splitFunding(amountMinor: number, team: readonly { readonly shareBps: number; readonly isSeller: boolean }[]): number[] {
  if (team.reduce((sum, t) => sum + t.shareBps, 0) !== FULL_BPS) throw new Error("Team shares must add up to 10 000 bps");
  const sellerAt = team.findIndex((t) => t.isSeller);
  if (sellerAt === -1) throw new Error("The team has no seller");
  const amounts = team.map((t) => shareOf(amountMinor, t.shareBps));
  // Remainder first, then add it. `seller + amount − sum` goes past 2^53 on the way for large
  // amounts and rounds off a cent (found by the property test in holds.spec.ts).
  const remainder = amountMinor - amounts.reduce((a, b) => a + b, 0);
  amounts[sellerAt] = (amounts[sellerAt] ?? 0) + remainder;
  return amounts;
}

// domain-model.md, Hold: the milestone's holdStatus is the first of these that any hold has,
// otherwise the status every hold shares. The order puts what needs a person first: an expired
// or failed hold is an incident even if the others are fine, and one order still waiting for
// the buyer means the milestone is not funded yet.
const WORST_FIRST: readonly HoldStatus[] = ["EXPIRED", "CAPTURE_FAILED", "VOID_PENDING", "CAPTURE_PENDING", "ORDER_CREATED", "NONE"];

export function aggregateHoldStatus(statuses: readonly HoldStatus[]): HoldStatus {
  if (statuses.length === 0) return "NONE";
  const worst = WORST_FIRST.find((s) => statuses.includes(s));
  if (worst !== undefined) return worst;
  const [first] = statuses;
  // AUTHORIZED next to CAPTURED or VOIDED: every release and every return touches all holds at
  // once, so this is a bug. Thrown, so the transaction that would write it rolls back.
  if (first === undefined || statuses.some((s) => s !== first)) throw new Error(`Holds disagree: ${statuses.join(", ")}`);
  return first;
}

export interface HoldMoney {
  readonly fundedMinor: number;
  readonly releasedMinor: number;
  readonly returnedMinor: number;
  readonly holdStatus: HoldStatus;
  readonly authorizationExpiresAt: Date | null;
}

// The milestone columns that summarize its holds.
export function rollup(holds: readonly HoldMoney[]) {
  const sum = (pick: (h: HoldMoney) => number) => holds.reduce((total, h) => total + pick(h), 0);
  const expiries = holds.flatMap((h) => (h.authorizationExpiresAt === null ? [] : [h.authorizationExpiresAt.getTime()]));
  return {
    fundedMinor: sum((h) => h.fundedMinor),
    releasedMinor: sum((h) => h.releasedMinor),
    returnedMinor: sum((h) => h.returnedMinor),
    holdStatus: aggregateHoldStatus(holds.map((h) => h.holdStatus)),
    // The earliest: G-AUTH-ACTIVE and the countdown (SM-INV-5) must fit the first one to expire.
    authorizationExpiresAt: expiries.length === 0 ? null : new Date(Math.min(...expiries)),
  };
}
