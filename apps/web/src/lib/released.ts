// How much of what was released actually moved. Milestone.released is the decision (it includes
// captures PayPal is still processing and a final one it declined); the money is on each part.
// Reading "paid" from the decision told a seller "Captured in PayPal" for money that never arrived.
// Display only: Core API owns these statuses.
import type { Milestone } from "./api-types";

export interface ReleaseTotals {
  captured: number;
  pending: number;
  declined: number; // final captures only: a declined partial one is taken back, so it is not released
}

// payeeUserId: only that person's parts. A collaborator gets only theirs from Core API anyway.
export function releaseTotals(m: Pick<Milestone, "releases" | "released" | "holds" | "holdStatus" | "amount">, payeeUserId?: string): ReleaseTotals {
  const totals: ReleaseTotals = { captured: 0, pending: 0, declined: 0 };
  if (m.releases === undefined) {
    // `releases` is optional in the schema, and Core API always sends it. Without it, the decision
    // is all there is to read.
    const hold = payeeUserId === undefined ? undefined : m.holds?.find((h) => h.payeeUserId === payeeUserId);
    totals.captured = hold?.released.amountMinor ?? m.released?.amountMinor ?? (m.holdStatus === "CAPTURED" ? m.amount.amountMinor : 0);
    return totals;
  }
  for (const release of m.releases) {
    for (const part of release.parts ?? []) {
      if (payeeUserId !== undefined && part.payeeUserId !== payeeUserId) continue;
      if (part.status === "CAPTURED") totals.captured += part.amount.amountMinor;
      else if (part.status === "PENDING") totals.pending += part.amount.amountMinor;
      else if (release.final) totals.declined += part.amount.amountMinor;
    }
  }
  return totals;
}
