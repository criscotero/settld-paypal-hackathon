// ADR-0022, view 2: the criteria editor's grid, as a view over the same form state the cards edit
// (draft-form.tsx). Every cell reads from a criterion and writes back a patch that goes through the
// form's own setCriterion, so the grid never keeps a copy that could drift from what is submitted.
//
// Pure and tested. Nothing here validates domain rules: Core API checks them on submit
// (G-MILESTONE-VALID), as it does for the cards. rowIssues only marks what is visibly incomplete.
import type { Schemas } from "./api-types";
import { originAfterEdit } from "./suggestions";
import { parseWeightPercent } from "./weights";

type Level = Schemas["CriterionInput"]["level"];
type CheckType = Schemas["CheckType"];

export interface CriterionFields {
  key: number;
  text: string;
  level: Level;
  checkType: CheckType | "";
  probeUrl: string;
  guidance: string;
  weight: string;
  required: boolean;
}

// One choice joins the form's two (level, then check), because a cell holds one value. Only checks
// Settld runs today: GitHub, CI and tests always answer UNCERTAIN (ADR-0008, decision 4).
export const CHECK_CHOICES: readonly { label: string; level: Level; checkType: CheckType | "" }[] = [
  { label: "Human review", level: "HUMAN", checkType: "" },
  { label: "A URL answers (HTTP probe)", level: "AUTOMATIC", checkType: "HTTP_PROBE" },
  { label: "AI: feature is present", level: "AI_EVALUATED", checkType: "AI_FEATURE_PRESENT" },
  { label: "AI: requirement is met", level: "AI_EVALUATED", checkType: "AI_REQUIREMENT_MET" },
];

// Readable on a draft that already uses one, never offered for a new choice.
const UNAVAILABLE: Partial<Record<CheckType, string>> = {
  GITHUB_PR_MERGED: "GitHub pull request merged (not available yet)",
  CI_STATUS_GREEN: "CI is green (not available yet)",
  TESTS_PASSED: "Tests passed (not available yet)",
};

export function checkChoiceOf(c: Pick<CriterionFields, "level" | "checkType">): string {
  if (c.level === "HUMAN") return "Human review";
  const offered = CHECK_CHOICES.find((x) => x.level === c.level && x.checkType === c.checkType);
  if (offered !== undefined) return offered.label;
  return (c.checkType === "" ? undefined : UNAVAILABLE[c.checkType]) ?? "Choose a check";
}

export function patchForChoice(label: string): Pick<CriterionFields, "level" | "checkType"> | null {
  const choice = CHECK_CHOICES.find((x) => x.label === label);
  return choice === undefined ? null : { level: choice.level, checkType: choice.checkType };
}

// The one setting a check needs, in the field toDraftInput sends: the probe's URL, or the guidance
// for the AI. An AI check's optional "page to read" stays in the cards, where it has room to explain.
export function settingLabel(c: Pick<CriterionFields, "level" | "checkType">): string | null {
  if (c.level === "AI_EVALUATED") return "What the AI should look for";
  if (c.checkType === "HTTP_PROBE") return "URL";
  return null;
}

export function settingOf(c: CriterionFields): string {
  if (c.level === "AI_EVALUATED") return c.guidance;
  if (c.checkType === "HTTP_PROBE") return c.probeUrl;
  return "";
}

export function patchForSetting(c: CriterionFields, value: string): Partial<Pick<CriterionFields, "probeUrl" | "guidance">> {
  if (c.level === "AI_EVALUATED") return { guidance: value };
  if (c.checkType === "HTTP_PROBE") return { probeUrl: value };
  return {};
}

// The same limits the cards put on their inputs (required, minLength 10 for the guidance).
export function rowIssues(c: CriterionFields): string[] {
  const issues: string[] = [];
  if (c.text.trim() === "") issues.push("Describe what counts as done");
  if (c.checkType === "HTTP_PROBE" && c.level === "AUTOMATIC" && c.probeUrl.trim() === "") issues.push("Add the URL");
  if (c.level === "AI_EVALUATED" && c.guidance.trim().length < 10) issues.push("Tell the AI what to look for (10 characters or more)");
  if (c.weight.trim() === "" || !parseWeightPercent(c.weight).ok) issues.push("The weight is not a number");
  return issues;
}

// The one way a criterion changes, from the cards or from the grid (draft-form.tsx's setCriterion).
// An edit makes an AI suggestion the buyer's own (ADR-0016) and drops the compiler's reason, which
// no longer describes the edited text. Only the criterion with that key changes; the list and every
// other criterion keep their identity, which is what lets the grid update one row in place.
type Origin = Schemas["CriterionInput"]["origin"];
export function updateCriterion<C extends { key: number; origin: Origin; rationale?: string | undefined }>(criteria: readonly C[], key: number, patch: Partial<C>): C[] {
  return criteria.map((c) => (c.key === key ? { ...c, ...patch, origin: originAfterEdit(c.origin), rationale: undefined } : c));
}

// Before a submit, every grid finishes the edit it has open (ADR-0022, failure modes: "una celda
// queda en edición al guardar"). Each flush returns whether a cell was being edited. If one was, its
// value reaches the form only on the next render, so the submit runs again then instead of now,
// with state that would still miss the last edit.
export function submitWhenSettled(flushes: Iterable<() => boolean>, submit: () => void, later: (run: () => void) => void): void {
  let pending = false;
  for (const flush of flushes) pending = flush() || pending;
  if (pending) later(submit);
  else submit();
}
