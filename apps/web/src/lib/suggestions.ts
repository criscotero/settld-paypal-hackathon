// The form's side of the contract compiler (ADR-0016). A suggestion is a proposal the person edits,
// and these two rules keep that honest: it never overwrites work without asking, and an edited
// suggestion stops claiming to be the AI's.
import type { Schemas } from "./api-types";

type Origin = Schemas["CriterionInput"]["origin"];

export function originAfterEdit(origin: Origin): Origin {
  return origin === "AI_SUGGESTED" ? "AI_SUGGESTED_EDITED" : origin;
}

// A blank criterion row is not work: the form starts with one.
export function wouldReplaceWork(criteria: readonly { readonly text: string }[]): boolean {
  return criteria.some((c) => c.text.trim() !== "");
}
