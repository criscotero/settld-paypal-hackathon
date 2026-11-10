import fc from "fast-check";
import { aggregateHoldStatus, rollup, splitFunding } from "./holds.js";

describe("splitFunding (ADR-0009, rule 1)", () => {
  it("ADR-0009 example: USD 500 at 70/30 is 350 and 150", () => {
    expect(splitFunding(50_000, [{ shareBps: 7_000, isSeller: true }, { shareBps: 3_000, isSeller: false }])).toEqual([35_000, 15_000]);
  });

  it("gives the remainder to the seller, wherever the seller is in the team", () => {
    // 1 cent at 50/50: floor gives 0 and 0, the cent goes to the seller.
    expect(splitFunding(1, [{ shareBps: 5_000, isSeller: false }, { shareBps: 5_000, isSeller: true }])).toEqual([0, 1]);
  });

  it("always adds up to the amount exactly", () => {
    const shares = fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 5 }).map((raw) => {
      const total = raw.reduce((a, b) => a + b, 0);
      const bps = raw.map((r) => Math.max(1, Math.floor((r * 10_000) / total)));
      bps[0] = (bps[0] ?? 0) + 10_000 - bps.reduce((a, b) => a + b, 0);
      return bps;
    });
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), shares, (amount, bps) => {
        fc.pre(bps.every((b) => b >= 1));
        const parts = splitFunding(amount, bps.map((shareBps, i) => ({ shareBps, isSeller: i === 0 })));
        expect(parts.reduce((a, b) => a + b, 0)).toBe(amount);
      }),
      { numRuns: 2_000 },
    );
  });
});

describe("aggregateHoldStatus", () => {
  it("one order still waiting for the buyer means the milestone is not funded yet", () => {
    expect(aggregateHoldStatus(["AUTHORIZED", "ORDER_CREATED"])).toBe("ORDER_CREATED");
  });

  it("one expired hold is an incident even if the others are fine", () => {
    expect(aggregateHoldStatus(["AUTHORIZED", "EXPIRED", "AUTHORIZED"])).toBe("EXPIRED");
  });

  it("is the shared status when they agree, and refuses a mix no transition can produce", () => {
    expect(aggregateHoldStatus(["CAPTURED", "CAPTURED"])).toBe("CAPTURED");
    expect(() => aggregateHoldStatus(["AUTHORIZED", "CAPTURED"])).toThrow(/disagree/);
  });
});

describe("rollup", () => {
  it("sums the money and takes the earliest expiry", () => {
    const early = new Date("2026-11-20T00:00:00Z");
    const late = new Date("2026-11-25T00:00:00Z");
    expect(
      rollup([
        { fundedMinor: 35_000, releasedMinor: 31_500, returnedMinor: 0, holdStatus: "AUTHORIZED", authorizationExpiresAt: late },
        { fundedMinor: 15_000, releasedMinor: 13_500, returnedMinor: 0, holdStatus: "AUTHORIZED", authorizationExpiresAt: early },
      ]),
    ).toEqual({ fundedMinor: 50_000, releasedMinor: 45_000, returnedMinor: 0, holdStatus: "AUTHORIZED", authorizationExpiresAt: early });
  });
});
