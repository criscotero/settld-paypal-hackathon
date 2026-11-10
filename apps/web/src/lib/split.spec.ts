import { splitLargestRemainder, splitRemainderToSeller } from "./split";

describe("splitLargestRemainder", () => {
  it("splits exactly when the shares divide the amount", () => {
    expect(splitLargestRemainder(45_000, [7_000, 2_000, 1_000])).toEqual([31_500, 9_000, 4_500]);
  });

  it("never loses or invents a cent", () => {
    for (const amount of [1, 7, 100, 999, 10_001, 123_457]) {
      for (const shares of [[3_334, 3_333, 3_333], [5_000, 5_000], [1, 9_999], [7_000, 2_000, 1_000]]) {
        expect(splitLargestRemainder(amount, shares).reduce((a, b) => a + b, 0)).toBe(amount);
      }
    }
  });

  it("gives the leftover cent to the largest remainder, ties to the first", () => {
    expect(splitLargestRemainder(100, [3_334, 3_333, 3_333])).toEqual([34, 33, 33]);
    expect(splitLargestRemainder(1, [5_000, 5_000])).toEqual([1, 0]);
  });
});

describe("splitRemainderToSeller", () => {
  it("matches Core API on the ADR-0009 example", () => {
    expect(splitRemainderToSeller(50_000, [7_000, 3_000])).toEqual([35_000, 15_000]);
  });

  it("gives every leftover cent to the seller, never loses one", () => {
    expect(splitRemainderToSeller(100, [3_334, 3_333, 3_333])).toEqual([34, 33, 33]);
    expect(splitRemainderToSeller(101, [3_333, 3_333, 3_334])).toEqual([35, 33, 33]);
    for (const amount of [1, 7, 999, 123_457]) expect(splitRemainderToSeller(amount, [3_334, 3_333, 3_333]).reduce((a, b) => a + b, 0)).toBe(amount);
  });
});
