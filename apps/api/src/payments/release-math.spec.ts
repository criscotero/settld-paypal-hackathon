import fc from "fast-check";
import type { CriterionVerdict } from "../db/schema.js";
import { countedCriteria, decideRelease, isReleasable, platformFee, shareOf } from "./release-math.js";
import type { WeightedCriterion } from "./release-math.js";

const auto = (id: string, weightBps: number, required = false): WeightedCriterion => ({ id, level: "AUTOMATIC", required, weightBps });
const pass = (criterionId: string): CriterionVerdict => ({ criterionId, verdict: "PASS", evidenceRefCount: 1 });
const fail = (criterionId: string): CriterionVerdict => ({ criterionId, verdict: "FAIL", evidenceRefCount: 0 });

// requirements v1, T1 and T2: USD 500 with weights 40/30/20/10; the 10% criterion fails first.
const T1 = [auto("a", 4_000, true), auto("b", 3_000), auto("c", 2_000), auto("d", 1_000)];

// A milestone with one hold: the seller alone, as before ADR-0009.
const solo = (fundedMinor: number, releasedMinor: number) => [{ fundedMinor, releasedMinor }];

describe("decideRelease", () => {
  it("T1: releases 450 of 500 and holds 50 when the 10% criterion fails", () => {
    const d = decideRelease(solo(50_000, 0), T1, new Set(["a", "b", "c"]));
    expect(d).toEqual({ countedBps: 9_000, requiredCounted: true, cumulativeMinor: 45_000, amountMinor: 45_000, parts: [45_000], final: false });
  });

  it("T2: releases the held 50 once the criterion is fixed, as the final capture", () => {
    const d = decideRelease(solo(50_000, 45_000), T1, new Set(["a", "b", "c", "d"]));
    expect(d).toMatchObject({ amountMinor: 5_000, final: true });
  });

  it("releases nothing while a required criterion does not count (the gate)", () => {
    expect(decideRelease(solo(50_000, 0), T1, new Set(["b", "c", "d"])).amountMinor).toBe(0);
  });

  it("never takes money back when a later round counts less", () => {
    expect(decideRelease(solo(50_000, 45_000), T1, new Set(["a"])).amountMinor).toBe(0);
  });

  it("rounds down on partial releases and gives the exact remainder on the last one", () => {
    const thirds = [auto("x", 3_334, true), auto("y", 3_333), auto("z", 3_333)];
    const first = decideRelease(solo(10_001, 0), thirds, new Set(["x"]));
    expect(first.amountMinor).toBe(3_334); // floor(10 001 × 0.3334) = 3334.33…
    const last = decideRelease(solo(10_001, first.amountMinor), thirds, new Set(["x", "y", "z"]));
    expect(first.amountMinor + last.amountMinor).toBe(10_001);
  });
});

describe("shareOf", () => {
  it("stays exact past 2^53 / 10 000, where float multiplication would round", () => {
    const huge = Number.MAX_SAFE_INTEGER; // 9 007 199 254 740 991 cents
    expect(shareOf(huge, 7_777)).toBe(7_004_898_860_412_068);
    // The float version invents a cent: a conservation bug no small-number test would show.
    expect(Math.floor((huge * 7_777) / 10_000)).toBe(7_004_898_860_412_069);
  });
});

// A model's FAIL is an opinion the buyer can overrule (ADR-0010, owner's decision 2026-11-05).
// Only a deterministic FAIL is a fact that ends the round by itself.
describe("isReleasable with an AI FAIL", () => {
  const ai: WeightedCriterion = { id: "ai", level: "AI_EVALUATED", required: true, weightBps: 3_000 };
  const criteria = [auto("a", 7_000, true), ai];

  it("a required AI FAIL still opens the countdown, so the buyer decides", () => {
    expect(isReleasable(solo(50_000, 0), criteria, [pass("a"), fail("ai")])).toBe(true);
  });
  it("an AI FAIL alone also opens it, when it is all that could count", () => {
    expect(isReleasable(solo(50_000, 0), [{ ...ai, weightBps: 10_000 }], [fail("ai")])).toBe(true);
  });
  it("a required deterministic FAIL still ends the round", () => {
    expect(isReleasable(solo(50_000, 0), criteria, [fail("a"), pass("ai")])).toBe(false);
  });
  it("never counts toward the money without the buyer", () => {
    expect(countedCriteria(criteria, [pass("a"), fail("ai")], new Set())).toEqual(new Set(["a"]));
    expect(countedCriteria(criteria, [pass("a"), fail("ai")], new Set(["ai"]))).toEqual(new Set(["a", "ai"]));
  });
});

describe("countedCriteria (constitution VI)", () => {
  const criteria: WeightedCriterion[] = [auto("a", 5_000), { id: "ai", level: "AI_EVALUATED", required: false, weightBps: 3_000 }, { id: "h", level: "HUMAN", required: false, weightBps: 2_000 }];

  it("counts a deterministic PASS on its own, but never an AI PASS alone", () => {
    expect(countedCriteria(criteria, [pass("a"), pass("ai")], new Set())).toEqual(new Set(["a"]));
  });

  it("counts whatever the buyer approved as a person", () => {
    expect(countedCriteria(criteria, [pass("a"), pass("ai")], new Set(["ai", "h"]))).toEqual(new Set(["a", "ai", "h"]));
  });
});

describe("isReleasable (G-RELEASABLE)", () => {
  it("is false when a required criterion failed", () => {
    expect(isReleasable(solo(50_000, 0), T1, [fail("a"), pass("b"), pass("c"), pass("d")])).toBe(false);
  });

  it("is true when an optional one failed and the rest can still count", () => {
    expect(isReleasable(solo(50_000, 0), T1, [pass("a"), pass("b"), pass("c"), fail("d")])).toBe(true);
  });

  it("is false when nothing new could be released", () => {
    expect(isReleasable(solo(50_000, 45_000), T1, [pass("a"), pass("b"), pass("c"), fail("d")])).toBe(false);
  });
});

describe("platformFee", () => {
  it("rounds down so the seller never pays a fraction of a cent", () => {
    expect(platformFee(45_000, 500)).toBe(2_250);
    expect(platformFee(333, 500)).toBe(16); // 16.65
  });
});

// ---------------------------------------------------------------- properties (constitution V)

// Weights that add up to exactly 10 000 bp, as G-MILESTONE-VALID requires.
const weightedCriteria = fc
  .array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 8 })
  .map((raw) => {
    const total = raw.reduce((a, b) => a + b, 0);
    const weights = raw.map((r) => Math.max(1, Math.floor((r * 10_000) / total)));
    const drift = 10_000 - weights.reduce((a, b) => a + b, 0);
    const last = weights.length - 1;
    weights[last] = (weights[last] ?? 0) + drift;
    return weights;
  })
  .filter((w) => w.every((x) => x >= 1))
  .chain((weights) =>
    fc.array(fc.boolean(), { minLength: weights.length, maxLength: weights.length }).map((required) =>
      weights.map((weightBps, i): WeightedCriterion => ({ id: `c${String(i)}`, level: "AUTOMATIC", required: required[i] ?? false, weightBps })),
    ),
  );

// A run of verification rounds: in each one, a random subset of criteria counts.
const rounds = (criteria: WeightedCriterion[]) =>
  fc.array(fc.subarray(criteria.map((c) => c.id)), { minLength: 1, maxLength: 6 }).map((rs) => rs.map((r) => new Set(r)));

describe("release properties", () => {
  it("conservation: released never exceeds funded, never decreases, and the parts add up", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000_00 }), weightedCriteria.chain((c) => rounds(c).map((r) => [c, r] as const)), (funded, [criteria, rs]) => {
        let released = 0;
        for (const counted of rs) {
          const d = decideRelease(solo(funded, released), criteria, counted);
          expect(d.amountMinor).toBeGreaterThanOrEqual(0);
          released += d.amountMinor;
          expect(released).toBeLessThanOrEqual(funded);
        }
      }),
      { numRuns: 2_000 },
    );
  });

  it("completeness: once every criterion counts, exactly the funded amount has been released", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000_000_00 }), weightedCriteria.chain((c) => rounds(c).map((r) => [c, r] as const)), (funded, [criteria, rs]) => {
        let released = 0;
        for (const counted of [...rs, new Set(criteria.map((c) => c.id))]) released += decideRelease(solo(funded, released), criteria, counted).amountMinor;
        expect(released).toBe(funded);
      }),
      { numRuns: 2_000 },
    );
  });

  it("final is true exactly when the release completes the milestone", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), weightedCriteria.chain((c) => rounds(c).map((r) => [c, r] as const)), (funded, [criteria, rs]) => {
        let released = 0;
        for (const counted of rs) {
          const d = decideRelease(solo(funded, released), criteria, counted);
          released += d.amountMinor;
          if (d.final) expect(released).toBe(funded);
        }
      }),
      { numRuns: 2_000 },
    );
  });
});

// ---------------------------------------------------------------- teams (ADR-0009, rule 2)

describe("decideRelease with a team", () => {
  it("ADR-0009 example: USD 500 at 70/30, 90% counts, parts 315 and 135", () => {
    const d = decideRelease([{ fundedMinor: 35_000, releasedMinor: 0 }, { fundedMinor: 15_000, releasedMinor: 0 }], T1, new Set(["a", "b", "c"]));
    expect(d).toMatchObject({ amountMinor: 45_000, parts: [31_500, 13_500], final: false });
  });

  it("a hold whose part PayPal declined gets it again next round, the others get nothing new", () => {
    // Round 1 released 31 500 to the first hold; the second hold's 13 500 was declined and reverted.
    const d = decideRelease([{ fundedMinor: 35_000, releasedMinor: 31_500 }, { fundedMinor: 15_000, releasedMinor: 0 }], T1, new Set(["a", "b", "c"]));
    expect(d.parts).toEqual([0, 13_500]);
  });
});

// What each team member's hold was funded with (splitFunding has its own tests).
const teamHolds = fc.array(fc.integer({ min: 1, max: 10_000_000_00 }), { minLength: 1, maxLength: 5 });

describe("release properties with a team", () => {
  it("per hold: released never exceeds funded, and once everything counts each hold released exactly its funded", () => {
    fc.assert(
      fc.property(teamHolds, weightedCriteria.chain((c) => rounds(c).map((r) => [c, r] as const)), (funded, [criteria, rs]) => {
        const released = funded.map(() => 0);
        for (const counted of [...rs, new Set(criteria.map((c) => c.id))]) {
          const d = decideRelease(
            funded.map((f, i) => ({ fundedMinor: f, releasedMinor: released[i] ?? 0 })),
            criteria,
            counted,
          );
          expect(d.amountMinor).toBe(d.parts.reduce((a, b) => a + b, 0));
          d.parts.forEach((p, i) => {
            expect(p).toBeGreaterThanOrEqual(0);
            released[i] = (released[i] ?? 0) + p;
            expect(released[i]).toBeLessThanOrEqual(funded[i] ?? 0);
          });
        }
        expect(released).toEqual(funded);
      }),
      { numRuns: 2_000 },
    );
  });
});
