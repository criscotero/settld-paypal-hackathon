import { describe, expect, it } from "vitest";
import { CHECK_CHOICES, checkChoiceOf, pageToReadOf, patchForChoice, patchForPageToRead, patchForSetting, rowIssues, settingLabel, settingOf, submitWhenSettled, updateCriterion } from "./criteria-grid";
import type { CriterionFields } from "./criteria-grid";

const row = (over: Partial<CriterionFields> = {}): CriterionFields => ({ key: 1, text: "The page answers 200", level: "AUTOMATIC", checkType: "HTTP_PROBE", probeUrl: "https://acme.dev", guidance: "", weight: "70", required: true, ...over });

describe("check choices (ADR-0022, view 2)", () => {
  it("offers only checks Settld can run today, with the form's own names", () => {
    expect(CHECK_CHOICES.map((c) => c.label)).toEqual(["Human review", "A URL answers (HTTP probe)", "AI: feature is present", "AI: requirement is met"]);
  });

  it("names the check a row has, including one that is no longer offered", () => {
    expect(checkChoiceOf(row())).toBe("A URL answers (HTTP probe)");
    expect(checkChoiceOf(row({ level: "HUMAN", checkType: "" }))).toBe("Human review");
    expect(checkChoiceOf(row({ checkType: "CI_STATUS_GREEN" }))).toBe("CI is green (not available yet)");
  });

  it("turns a choice into the level and check the form stores", () => {
    expect(patchForChoice("AI: requirement is met")).toEqual({ level: "AI_EVALUATED", checkType: "AI_REQUIREMENT_MET" });
    expect(patchForChoice("Human review")).toEqual({ level: "HUMAN", checkType: "" });
    expect(patchForChoice("Not a choice")).toBeNull();
  });
});

describe("the settings cell", () => {
  it("is the URL for an HTTP probe and the guidance for an AI check", () => {
    expect([settingOf(row()), settingLabel(row())]).toEqual(["https://acme.dev", "URL"]);
    const ai = row({ level: "AI_EVALUATED", checkType: "AI_REQUIREMENT_MET", guidance: "Three plans with prices", probeUrl: "" });
    expect([settingOf(ai), settingLabel(ai)]).toEqual(["Three plans with prices", "What the AI should look for"]);
  });

  it("has nothing to set for a human review", () => {
    const human = row({ level: "HUMAN", checkType: "" });
    expect([settingOf(human), settingLabel(human)]).toEqual(["", null]);
    expect(patchForSetting(human, "anything")).toEqual({});
  });

  it("writes back to the field the form submits, and only that one", () => {
    expect(patchForSetting(row(), "https://acme.dev/health")).toEqual({ probeUrl: "https://acme.dev/health" });
    expect(patchForSetting(row({ level: "AI_EVALUATED", checkType: "AI_FEATURE_PRESENT" }), "A contact form")).toEqual({ guidance: "A contact form" });
  });
});

describe("the page-to-read cell (shown in the cards, so in the grid too)", () => {
  it("is the AI check's optional page, and nothing for the other checks", () => {
    const ai = row({ level: "AI_EVALUATED", checkType: "AI_FEATURE_PRESENT", probeUrl: "https://acme.dev/pricing" });
    expect(pageToReadOf(ai)).toBe("https://acme.dev/pricing");
    // An HTTP probe's URL is its setting, not a page for the AI: it must not show twice.
    expect(pageToReadOf(row())).toBeNull();
    expect(pageToReadOf(row({ level: "HUMAN", checkType: "" }))).toBeNull();
  });

  it("writes the probe URL only for an AI check", () => {
    const ai = row({ level: "AI_EVALUATED", checkType: "AI_FEATURE_PRESENT", probeUrl: "" });
    expect(patchForPageToRead(ai, "https://acme.dev/plans")).toEqual({ probeUrl: "https://acme.dev/plans" });
    expect(patchForPageToRead(row(), "https://other.dev")).toEqual({});
  });
});

describe("rowIssues", () => {
  it("is empty for a complete row", () => {
    expect(rowIssues(row())).toEqual([]);
  });

  it("says what is missing, in the words the form uses", () => {
    expect(rowIssues(row({ text: " ", probeUrl: "", weight: "abc" }))).toEqual(["Describe what counts as done", "Add the URL", "The weight is not a number"]);
    expect(rowIssues(row({ level: "AI_EVALUATED", checkType: "AI_REQUIREMENT_MET", guidance: "short" }))).toEqual(["Tell the AI what to look for (10 characters or more)"]);
  });
});

describe("rows ↔ m.criteria round trip", () => {
  const full = (over: Partial<CriterionFields> = {}) => ({ ...row(over), origin: "AI_SUGGESTED" as const, rationale: "why" });

  it("what a cell shows is what it last wrote, for every editable setting", () => {
    for (const c of [row(), row({ level: "AI_EVALUATED", checkType: "AI_REQUIREMENT_MET" }), row({ level: "AI_EVALUATED", checkType: "AI_FEATURE_PRESENT" })]) {
      expect(settingOf({ ...c, ...patchForSetting(c, "written in the grid") })).toBe("written in the grid");
    }
  });

  it("every offered check choice reads back as itself", () => {
    for (const choice of CHECK_CHOICES) expect(checkChoiceOf({ ...row(), ...patchForChoice(choice.label) })).toBe(choice.label);
  });

  it("changing the check and back keeps what the buyer typed in the other fields", () => {
    const start = row({ level: "AI_EVALUATED", checkType: "AI_REQUIREMENT_MET", guidance: "Three plans", probeUrl: "https://acme.dev/pricing" });
    const there = { ...start, ...patchForChoice("Human review") };
    const back = { ...there, ...patchForChoice("AI: requirement is met") };
    expect(back).toEqual(start);
  });

  it("updates only the criterion with that key, and leaves the others as the same objects", () => {
    const list = [full({ key: 1 }), full({ key: 2 })];
    const next = updateCriterion(list, 2, { weight: "40" });
    expect(next[0]).toBe(list[0]);
    expect(next[1]).toMatchObject({ key: 2, weight: "40" });
    expect(list[1]?.weight).toBe("70");
  });

  it("an edit makes an AI suggestion the buyer's own and drops the compiler's reason", () => {
    const [edited] = updateCriterion([full()], 1, { text: "Changed" });
    expect(edited).toMatchObject({ origin: "AI_SUGGESTED_EDITED", rationale: undefined, text: "Changed" });
  });
});

describe("submitWhenSettled: edit, then save without leaving the cell", () => {
  it("submits now when no cell is being edited", () => {
    const calls: string[] = [];
    submitWhenSettled([() => false], () => calls.push("submit"), () => calls.push("deferred"));
    expect(calls).toEqual(["submit"]);
  });

  it("finishes every open edit first, then submits on the next turn so the form has the last value", () => {
    const calls: string[] = [];
    let queued: (() => void) | null = null;
    submitWhenSettled(
      [() => (calls.push("flush grid 1"), false), () => (calls.push("flush grid 2"), true)],
      () => calls.push("submit"),
      (run) => {
        queued = run;
      },
    );
    expect(calls).toEqual(["flush grid 1", "flush grid 2"]);
    (queued as (() => void) | null)?.();
    expect(calls).toEqual(["flush grid 1", "flush grid 2", "submit"]);
  });
});
