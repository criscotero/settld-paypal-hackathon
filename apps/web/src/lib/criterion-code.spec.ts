import { describe, expect, it } from "vitest";
import { codeMap, criterionCode } from "./criterion-code";

const draft = (...milestones: string[][]) => milestones.map((criteria) => ({ criteria: criteria.map((key) => ({ key })) }));
const codes = (ms: ReturnType<typeof draft>) => [...codeMap(ms, (c) => c.key)];

describe("criterionCode", () => {
  it("is the milestone's place, then the criterion's place, counting from 1", () => {
    expect(criterionCode(0, 0)).toBe("M1-C1");
    expect(criterionCode(2, 4)).toBe("M3-C5");
  });
});

describe("codeMap", () => {
  it("numbers criteria in the order of the agreement, milestone by milestone", () => {
    expect(codes(draft(["a", "b"], ["c"]))).toEqual([
      ["a", "M1-C1"],
      ["b", "M1-C2"],
      ["c", "M2-C1"],
    ]);
  });

  it("gives a single milestone M1 codes", () => {
    expect(codes(draft(["a", "b", "c"]))).toEqual([
      ["a", "M1-C1"],
      ["b", "M1-C2"],
      ["c", "M1-C3"],
    ]);
  });

  it("renumbers a draft when a criterion is added at the end", () => {
    expect(codes(draft(["a", "b", "new"])).at(-1)).toEqual(["new", "M1-C3"]);
  });

  it("renumbers a draft when a criterion is deleted: the ones after it move up", () => {
    expect(codes(draft(["a", "c"]))).toEqual([
      ["a", "M1-C1"],
      ["c", "M1-C2"],
    ]);
  });

  it("renumbers a draft when criteria or milestones are reordered", () => {
    expect(codes(draft(["b", "a"]))).toEqual([
      ["b", "M1-C1"],
      ["a", "M1-C2"],
    ]);
    expect(codes(draft(["c"], ["a", "b"]))).toEqual([
      ["c", "M1-C1"],
      ["a", "M2-C1"],
      ["b", "M2-C2"],
    ]);
  });
});
