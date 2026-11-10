import { evenWeights, formatCountdown, formatWeight, parseWeightPercent } from "./weights";

describe("parseWeightPercent", () => {
  it("turns percentages into basis points without floats", () => {
    expect(parseWeightPercent("25")).toEqual({ ok: true, bps: 2_500 });
    expect(parseWeightPercent("33.34")).toEqual({ ok: true, bps: 3_334 });
    expect(parseWeightPercent("0.5")).toEqual({ ok: true, bps: 50 });
    expect(parseWeightPercent("100")).toEqual({ ok: true, bps: 10_000 });
  });

  it("refuses what cannot be a weight", () => {
    for (const bad of ["", "0", "100.01", "-5", "12.345", "abc"]) expect(parseWeightPercent(bad).ok).toBe(false);
  });
});

describe("formatWeight", () => {
  it("round-trips with parseWeightPercent", () => {
    for (const bps of [1, 50, 2_500, 3_334, 10_000]) expect(parseWeightPercent(formatWeight(bps))).toEqual({ ok: true, bps });
  });
});

describe("evenWeights", () => {
  it("always adds up to 100%", () => {
    for (let n = 1; n <= 12; n++) expect(evenWeights(n).reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(evenWeights(3)).toEqual([3_334, 3_333, 3_333]);
  });
});

describe("formatCountdown", () => {
  it("uses the largest whole unit", () => {
    expect(formatCountdown(60)).toBe("1 minute");
    expect(formatCountdown(172_800)).toBe("2 days");
    expect(formatCountdown(3_600)).toBe("1 hour");
    expect(formatCountdown(90)).toBe("90 seconds");
  });
});
