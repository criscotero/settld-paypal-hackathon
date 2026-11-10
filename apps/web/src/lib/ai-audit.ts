// ADR-0022, view 1: the evaluator's checks as rows, for the AI audit grid. Pure, so every rule is
// tested without a browser, and the grid only shows what this file built.
//
// Everything here comes from the run report (GET /verification-runs/{runId}). The texts were
// written by a model that read the seller's content, so the grid renders them only as text.
import { criterionCode } from "./criterion-code";
import { checkLines } from "./verdict";
import type { CheckTone, CriterionResult } from "./verdict";

type Evidence = CriterionResult["evidence"][number];
type Flag = NonNullable<CriterionResult["injectionFlags"]>[number];

export interface AuditEvidence {
  snapshotId: string;
  kind: Evidence["kind"];
  sourceUrl: string | null;
  hash: string;
}

export interface AuditRow {
  id: string;
  criterionId: string;
  // "M1-C2" (lib/criterion-code.ts): the same label the editor showed for this criterion.
  code: string;
  criterionText: string;
  requirement: string;
  tone: CheckTone;
  label: string;
  sourceExcerpt: string;
  finding: string;
  fix: string | null;
  note: string | null;
  evidence: AuditEvidence[];
  injection: { excerpt: string; kind: Flag["kind"] }[];
}

const EVIDENCE_LABEL: Record<Evidence["kind"], string> = {
  HTTP_RESPONSE: "Web page",
  REPOSITORY_FILE: "Repository file",
  DELIVERED_FILE: "Delivered file",
  NOTES: "Seller's notes",
  SCREENSHOT: "Screenshot",
  PR_METADATA: "Pull request",
  CI_RUN: "CI run",
  TEST_REPORT: "Test report",
  DIFF: "Code changes",
};

// The contract names the kind of evidence, not the agent's tool (ADR-0022): the grid shows this.
export const evidenceLabel = (kind: Evidence["kind"]): string => EVIDENCE_LABEL[kind];

// milestoneIndex: the milestone's place in the contract (0 for the first), for the criterion codes.
// runId: the run these results come from, part of each row's id.
export function auditRows(results: readonly CriterionResult[], criteria: readonly { id: string; text: string }[], milestoneIndex: number, runId: string): AuditRow[] {
  // The agreement's order, which is how the list under "Checked against" shows them. A result for
  // a criterion that is not in this version still shows: hiding checks would hide why money moved.
  const order = new Map(criteria.map((c, i) => [c.id, i]));
  const texts = new Map(criteria.map((c) => [c.id, c.text]));
  const sorted = [...results].sort((a, b) => (order.get(a.criterionId) ?? Infinity) - (order.get(b.criterionId) ?? Infinity));

  return sorted.flatMap((result) => {
    const checks = result.checks ?? [];
    // Same labels and tones as CriterionVerdict, from the same function, so the grid and the list
    // under "Checked against" can never say different things about one check.
    const lines = checkLines(result);
    const evidence = new Map(result.evidence.map((e) => [e.snapshotId, e]));
    const flags = result.injectionFlags ?? [];
    // A flag on evidence that no check cites still matters: the AI read it. Shown on every row of
    // the criterion, so a filter or a sort can never hide it.
    const cited = new Set(checks.flatMap((c) => c.evidenceRefs));
    const loose = flags.filter((f) => !cited.has(f.evidenceSnapshotId));

    return checks.map((c, i): AuditRow => {
      const line = lines[i];
      if (line === undefined) throw new Error("checkLines returned fewer lines than checks");
      const refs = new Set(c.evidenceRefs);
      return {
        // Run, criterion and position: stable across refreshes of the same run, so a selection survives;
        // different for the next run, so a selection never jumps to another check after a new delivery.
        id: `${runId}:${result.criterionId}:${String(i)}`,
        criterionId: result.criterionId,
        // A criterion outside this version has no place in it, so no code: a made-up one would
        // point at a different criterion.
        code: order.has(result.criterionId) ? criterionCode(milestoneIndex, order.get(result.criterionId) ?? 0) : "—",
        criterionText: texts.get(result.criterionId) ?? "A criterion not in this version",
        requirement: c.requirement,
        tone: line.tone,
        label: line.label,
        sourceExcerpt: c.sourceExcerpt,
        finding: c.finding,
        fix: line.fix,
        note: line.note,
        // A reference to a snapshot the report does not carry is skipped: no row may show a hash
        // that is not in the report.
        evidence: c.evidenceRefs.flatMap((ref) => {
          const e = evidence.get(ref);
          return e === undefined ? [] : [{ snapshotId: e.snapshotId, kind: e.kind, sourceUrl: e.sourceUrl ?? null, hash: e.hash }];
        }),
        injection: [...flags.filter((f) => refs.has(f.evidenceSnapshotId)), ...loose].map((f) => ({ excerpt: f.excerpt, kind: f.kind })),
      };
    });
  });
}

export function auditCounts(rows: readonly AuditRow[]): { met: number; notMet: number; unsure: number; read: number } {
  return {
    met: rows.filter((r) => r.tone === "met").length,
    notMet: rows.filter((r) => r.tone === "not-met").length,
    unsure: rows.filter((r) => r.tone === "unsure").length,
    read: new Set(rows.flatMap((r) => r.evidence.map((e) => e.snapshotId))).size,
  };
}

// ADR-0022, view 1, failure modes: while the run is in progress the audit says "Checking…" instead
// of disappearing, so the buyer knows more checks are coming. Only while the milestone is VERIFYING
// and has AI criteria whose result is missing (the run has not reached the Engine, a 404) or PENDING.
export function auditPending(state: string, criteria: readonly { id: string; level: string }[], results: ReadonlyMap<string, Pick<CriterionResult, "verdict">> | null): boolean {
  if (state !== "VERIFYING") return false;
  const ai = criteria.filter((c) => c.level === "AI_EVALUATED");
  return ai.some((c) => {
    const verdict = results?.get(c.id)?.verdict;
    return verdict === undefined || verdict === "PENDING";
  });
}
