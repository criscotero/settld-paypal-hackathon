// How a criterion's verdict reads to a person. An AI verdict must never look like a settled fact:
// it is an opinion the buyer can overrule, and it does not count until they approve it
// (constitution VI). So the labels differ by source, not only by verdict.
import type { Schemas } from "./api-types";

export type CriterionResult = Schemas["CriterionResult"];
export type VerdictTone = "good" | "bad" | "neutral" | "warning";

export interface VerdictView {
  label: string;
  tone: VerdictTone;
  // What this means for the money, when that is not obvious from the label.
  note: string | null;
}

const AI_NOTE = "This is the AI's opinion. It only counts toward the payment if the buyer approves it.";

export function verdictView(result: CriterionResult): VerdictView {
  const ai = result.source === "AI";
  if ((result.injectionFlags ?? []).length > 0) {
    return { label: "Possible manipulation", tone: "warning", note: "The evidence may be trying to influence the verifier. Read it yourself before approving." };
  }
  switch (result.verdict) {
    case "PASS":
      return ai ? { label: "AI: looks met", tone: "good", note: AI_NOTE } : { label: "Passed", tone: "good", note: null };
    case "FAIL":
      return ai ? { label: "AI: looks not met", tone: "bad", note: AI_NOTE } : { label: "Failed", tone: "bad", note: null };
    case "UNCERTAIN":
      return { label: ai ? "AI: not sure" : "Could not check", tone: "neutral", note: "It only counts toward the payment if the buyer approves it." };
    case "NEEDS_HUMAN":
      return { label: "Needs the buyer", tone: "neutral", note: null };
    case "PENDING":
      return { label: "Checking", tone: "neutral", note: null };
  }
}

// What only the buyer can settle (state machine, "Which criteria count": any level). A check that
// could not answer counts for nothing unless a person approves it; hiding its box left a required
// one impossible to pay, round after round. A proven FAIL is not here: that is a fact, not a doubt.
// Without the report (null) the automatic ones cannot be told apart, so only the others are offered.
const UNDECIDED: ReadonlySet<string> = new Set(["UNCERTAIN", "NEEDS_HUMAN"]);

export function decidableCriteria<C extends { id: string; level: string }>(criteria: readonly C[], results: ReadonlyMap<string, Pick<CriterionResult, "verdict">> | null): C[] {
  return criteria.filter((c) => c.level !== "AUTOMATIC" || UNDECIDED.has(results?.get(c.id)?.verdict ?? ""));
}

// ADR-0019: what the evaluator checked, one row per requirement. Words and an icon for every
// verdict, never color alone (constitution XII). The text comes from a model that read the
// seller's content, so the component renders it only as text.
export type CheckTone = "met" | "not-met" | "unsure";

export interface CheckLine {
  requirement: string;
  tone: CheckTone;
  label: string;
  finding: string;
  fix: string | null;
  note: string | null;
}

const CHECK_LABEL: Record<CheckTone, string> = { met: "Met", "not-met": "Not met", unsure: "Not sure" };

export function checkLines(result: Pick<CriterionResult, "checks">): CheckLine[] {
  return (result.checks ?? []).map((c) => {
    const tone: CheckTone = c.verdict === "PASS" ? "met" : c.verdict === "FAIL" ? "not-met" : "unsure";
    return { requirement: c.requirement, tone, label: CHECK_LABEL[tone], finding: c.finding, fix: c.fix ?? null, note: c.note ?? null };
  });
}

export function checksSummary(lines: readonly CheckLine[]): string | null {
  if (lines.length === 0) return null;
  const met = lines.filter((l) => l.tone === "met").length;
  return `${String(met)} of ${String(lines.length)} checks met`;
}
