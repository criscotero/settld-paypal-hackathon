// A short label for a criterion, "M1-C2": milestone 1, criterion 2. Display only (ADR-0022).
//
// It lets a buyer, a seller and a reviewer point at the same criterion in the editor, the AI audit
// and, later, the receipt and objections ("M1-C2 failed") without reading a UUID aloud. It is
// derived here, on the client, from the order of the agreement: never stored, never sent to Core,
// never part of CriterionInput, and not in docs/contracts/. A stored code would be a contract change.
//
// Stable only once the contract is approved: the locked version's order does not change, so every
// view of that version gives the same code. While a draft is being edited the codes renumber on
// purpose, when a criterion or milestone is added, deleted or moved. Anything that must survive
// edits (a row id, a link) uses the criterion's id, or the form's local key before it has one.
export function criterionCode(milestoneIndex: number, criterionIndex: number): string {
  return `M${String(milestoneIndex + 1)}-C${String(criterionIndex + 1)}`;
}

// Every criterion's code, by whatever identifies it in the caller: the id of an agreed criterion,
// or the form's key in the editor, where a new criterion has no id yet.
export function codeMap<C, K>(milestones: readonly { criteria: readonly C[] }[], idOf: (criterion: C) => K): Map<K, string> {
  const codes = new Map<K, string>();
  milestones.forEach((m, mi) => {
    m.criteria.forEach((c, ci) => codes.set(idOf(c), criterionCode(mi, ci)));
  });
  return codes;
}
