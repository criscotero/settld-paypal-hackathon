import { describe, expect, it } from "vitest";
import { originAfterEdit, wouldReplaceWork } from "./suggestions";

describe("originAfterEdit", () => {
  it("marks an edited suggestion as edited", () => {
    expect(originAfterEdit("AI_SUGGESTED")).toBe("AI_SUGGESTED_EDITED");
  });
  it("leaves everything else as it was", () => {
    expect(originAfterEdit("AI_SUGGESTED_EDITED")).toBe("AI_SUGGESTED_EDITED");
    expect(originAfterEdit("USER_WRITTEN")).toBe("USER_WRITTEN");
    expect(originAfterEdit(undefined)).toBeUndefined();
  });
});

describe("wouldReplaceWork", () => {
  it("is false for no criteria and for blank rows", () => {
    expect(wouldReplaceWork([])).toBe(false);
    expect(wouldReplaceWork([{ text: "" }, { text: "   " }])).toBe(false);
  });
  it("is true as soon as one has text", () => {
    expect(wouldReplaceWork([{ text: "" }, { text: "The page answers" }])).toBe(true);
  });
});
