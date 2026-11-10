import { describe, expect, it } from "vitest";
import { checkLines, checksSummary, decidableCriteria, verdictView } from "./verdict";
import type { CriterionResult } from "./verdict";

const result = (verdict: CriterionResult["verdict"], source: CriterionResult["source"], flags = 0): CriterionResult => ({
  criterionId: "c",
  verdict,
  source,
  reason: "r",
  evidence: [],
  injectionFlags: Array.from({ length: flags }, () => ({ evidenceSnapshotId: "s", excerpt: "x", kind: "OTHER" as const })),
});

describe("verdictView", () => {
  it("an AI pass is an opinion, and says it does not count alone", () => {
    const view = verdictView(result("PASS", "AI"));
    expect(view.label).toBe("AI: looks met");
    expect(view.note).toContain("only counts");
  });
  it("a deterministic pass is a fact", () => {
    expect(verdictView(result("PASS", "ADAPTER"))).toEqual({ label: "Passed", tone: "good", note: null });
  });
  it("an injection flag wins over any verdict", () => {
    expect(verdictView(result("PASS", "AI", 1)).tone).toBe("warning");
    expect(verdictView(result("FAIL", "AI", 1)).label).toBe("Possible manipulation");
  });
  it("uncertain never reads like a pass", () => {
    expect(verdictView(result("UNCERTAIN", "AI")).tone).toBe("neutral");
    expect(verdictView(result("UNCERTAIN", "ADAPTER")).label).toBe("Could not check");
  });
});

describe("decidableCriteria", () => {
  const auto = { id: "auto", level: "AUTOMATIC" };
  const ai = { id: "ai", level: "AI_EVALUATED" };
  const human = { id: "human", level: "HUMAN" };
  const report = (verdict: CriterionResult["verdict"]) => new Map([["auto", { verdict }]]);

  it("always offers what a check cannot prove", () => {
    expect(decidableCriteria([ai, human], null).map((c) => c.id)).toEqual(["ai", "human"]);
  });

  it.each(["UNCERTAIN", "NEEDS_HUMAN"] as const)("offers an automatic check that answered %s", (verdict) => {
    expect(decidableCriteria([auto], report(verdict))).toEqual([auto]);
  });

  it.each(["PASS", "FAIL", "PENDING"] as const)("does not offer an automatic check that answered %s", (verdict) => {
    expect(decidableCriteria([auto], report(verdict))).toEqual([]);
  });

  it("without the report, an automatic check is not offered", () => {
    expect(decidableCriteria([auto], null)).toEqual([]);
  });
});

describe("checkLines (ADR-0019)", () => {
  const check = (verdict: "PASS" | "FAIL" | "UNCERTAIN", fix: string | null = null, note: string | null = null) => ({
    requirement: `the ${verdict} one`,
    sourceExcerpt: "three plans",
    verdict,
    finding: "what the evidence shows",
    evidenceRefs: [],
    fix,
    note,
  });

  it("gives each check words, not only a color", () => {
    const lines = checkLines({ checks: [check("PASS"), check("FAIL", "Add the Team plan"), check("UNCERTAIN", null, "Marked uncertain")] });
    expect(lines.map((l) => [l.tone, l.label])).toEqual([
      ["met", "Met"],
      ["not-met", "Not met"],
      ["unsure", "Not sure"],
    ]);
    expect(lines[1]?.fix).toBe("Add the Team plan");
    expect(lines[2]?.note).toBe("Marked uncertain");
  });

  it("counts what is met", () => {
    expect(checksSummary(checkLines({ checks: [check("PASS"), check("FAIL")] }))).toBe("1 of 2 checks met");
  });

  it("has nothing to say for a criterion without checks", () => {
    expect(checkLines({})).toEqual([]);
    expect(checksSummary([])).toBeNull();
  });
});
