// How much a milestone releases (milestone-state-machine.md, section 1; ADR-0007).
// Pure functions: no database, no clock, no PayPal. The state machine calls them inside its
// transaction, and the property tests call them with thousands of random inputs. Integer
// arithmetic only (constitution V): amounts in minor units, weights in basis points.
import type { CriterionVerdict } from "../db/schema.js";

export const FULL_BPS = 10_000;

// floor(amount × bps / 10 000), exact. amount can be up to 2^53 cents (draft-input.ts), and
// amount × 10 000 is past the range where a JS number is exact, so the product is a BigInt.
// BigInt division truncates toward zero, which is floor for these non-negative values.
export function shareOf(amountMinor: number, bps: number): number {
  return Number((BigInt(amountMinor) * BigInt(bps)) / BigInt(FULL_BPS));
}

export interface WeightedCriterion {
  readonly id: string;
  readonly level: "AUTOMATIC" | "AI_EVALUATED" | "HUMAN";
  readonly required: boolean;
  readonly weightBps: number;
}

// Constitution VI and D7. A criterion counts when a deterministic check passed it, or when
// the buyer, as a person, approved it. An AI PASS alone never counts, and silence approves
// nothing: an undecided criterion's share stays held.
export function countedCriteria(
  criteria: readonly WeightedCriterion[],
  verdicts: readonly CriterionVerdict[],
  approvedByBuyer: ReadonlySet<string>,
): Set<string> {
  const verdictOf = new Map(verdicts.map((v) => [v.criterionId, v.verdict]));
  return new Set(
    criteria.filter((c) => approvedByBuyer.has(c.id) || (c.level === "AUTOMATIC" && verdictOf.get(c.id) === "PASS")).map((c) => c.id),
  );
}

// A FAIL that is a fact, not an opinion. A model's FAIL can be wrong and the buyer can overrule
// it, so only a deterministic check can end a round by itself (ADR-0010).
const provenFail = (c: WeightedCriterion, verdict: CriterionVerdict["verdict"] | undefined) => verdict === "FAIL" && c.level !== "AI_EVALUATED";

// What could still count in this round if the buyer approved everything open: any criterion
// without a proven FAIL. Used by G-RELEASABLE to decide whether the countdown is worth opening
// at all.
export function couldCount(criteria: readonly WeightedCriterion[], verdicts: readonly CriterionVerdict[]): Set<string> {
  const verdictOf = new Map(verdicts.map((v) => [v.criterionId, v.verdict]));
  return new Set(criteria.filter((c) => !provenFail(c, verdictOf.get(c.id))).map((c) => c.id));
}

// One team member's money in a milestone (a Hold row, ADR-0009). A milestone funded before
// ADR-0009 is a team of one: the seller's hold.
export interface HoldBalance {
  readonly fundedMinor: number;
  readonly releasedMinor: number;
}

export interface ReleaseDecision {
  readonly countedBps: number;
  // G-REQUIRED-COUNTED: the gate. When false, the amount is 0 whatever the weights say.
  readonly requiredCounted: boolean;
  // Total that should be released by the end of this round, released before included.
  readonly cumulativeMinor: number;
  // What this round releases: the sum of `parts`. Never negative: released money is never
  // taken back (SM-INV-10).
  readonly amountMinor: number;
  // One amount per hold, in the order given (ADR-0009, rule 2). 0 means that hold has
  // nothing new this round, and no ReleasePart is stored for it.
  readonly parts: readonly number[];
  // G-ALL-COUNTED: this release completes the milestone (final_capture: true).
  readonly final: boolean;
}

export function decideRelease(
  holds: readonly HoldBalance[],
  criteria: readonly WeightedCriterion[],
  counted: ReadonlySet<string>,
): ReleaseDecision {
  const countedBps = criteria.filter((c) => counted.has(c.id)).reduce((sum, c) => sum + c.weightBps, 0);
  const requiredCounted = criteria.every((c) => !c.required || counted.has(c.id));
  const final = countedBps === FULL_BPS;
  // Each hold rounds its own cumulative total, then subtracts what it already released.
  // Rounding each round's increment instead would lose up to a cent per round, and the losses
  // would add up. With every criterion counted, floor(funded × 10 000 / 10 000) is exactly
  // funded, so each hold ends with its whole share and no cent is left behind.
  //
  // Why per hold and not once for the milestone, then split: each hold is a separate PayPal
  // authorization. A milestone-level amount split afterwards could ask one authorization for
  // a cent more than its own floor, and in the last round that cent would be missing from
  // another one. Per hold, every capture is within its own authorization by construction.
  const cumulative = holds.map((h) => shareOf(h.fundedMinor, countedBps));
  const parts = holds.map((h, i) => (requiredCounted ? Math.max(0, (cumulative[i] ?? 0) - h.releasedMinor) : 0));
  return {
    countedBps,
    requiredCounted,
    cumulativeMinor: cumulative.reduce((a, b) => a + b, 0),
    amountMinor: parts.reduce((a, b) => a + b, 0),
    parts,
    final: final && requiredCounted,
  };
}

// G-RELEASABLE: no required criterion has a proven FAIL, and something would be released if the buyer
// approved everything that is still open. `alreadyCounted`: criteria paid for in earlier
// rounds, which keep counting (a later FAIL does not take back what was paid for them).
export function isReleasable(
  holds: readonly HoldBalance[],
  criteria: readonly WeightedCriterion[],
  verdicts: readonly CriterionVerdict[],
  alreadyCounted: ReadonlySet<string> = new Set(),
): boolean {
  const verdictOf = new Map(verdicts.map((v) => [v.criterionId, v.verdict]));
  if (criteria.some((c) => c.required && !alreadyCounted.has(c.id) && provenFail(c, verdictOf.get(c.id)))) return false;
  const possible = new Set([...couldCount(criteria, verdicts), ...alreadyCounted]);
  return decideRelease(holds, criteria, possible).amountMinor > 0;
}

// Platform fee per release (paypal-integration.md, section 3.4). Rounded down: the seller is
// never charged the fraction of a cent.
export function platformFee(amountMinor: number, platformFeeBps: number): number {
  return shareOf(amountMinor, platformFeeBps);
}
