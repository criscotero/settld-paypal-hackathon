// ADR-0022, view 5: the escalated objections as rows for the reviewer's grid. Pure and tested; the
// grid only shows what this file built.
//
// The money in each case stays reserved in PayPal until someone rules (ADR-0014), and a PayPal
// authorization lasts 29 days. So the time a case has waited is what the reviewer sorts by.
import type { Schemas } from "./api-types";

export type EscalatedObjection = Schemas["EscalatedObjection"];
type Money = Schemas["Money"];

export interface ReviewRow {
  id: string;
  // The case's short reference: the start of the objection id, enough to tell cases apart when two
  // reviewers talk about one. The full id stays in the row's tooltip and the case page.
  caseRef: string;
  href: string;
  milestone: string;
  contract: string;
  buyer: string;
  seller: string;
  reason: string;
  amount: Money;
  waitingMs: number;
}

const HOUR = 3_600_000;

export function reviewRows(items: readonly EscalatedObjection[], now: Date): ReviewRow[] {
  return items.map((i) => ({
    id: i.objection.id,
    caseRef: i.objection.id.slice(0, 8),
    href: `/review/${i.objection.id}`,
    milestone: i.milestoneTitle,
    contract: i.contractTitle,
    buyer: i.buyerName,
    seller: i.sellerName,
    reason: i.objection.reason,
    amount: i.amount,
    // A server clock a little ahead of Core's would give a negative wait for a case that just arrived.
    waitingMs: Math.max(0, now.getTime() - new Date(i.objection.escalateAt).getTime()),
  }));
}

export function waitingTone(ms: number): "neutral" | "warn" | "bad" {
  if (ms >= 72 * HOUR) return "bad";
  if (ms >= 48 * HOUR) return "warn";
  return "neutral";
}

export function waitingText(ms: number): string {
  const hours = Math.floor(ms / HOUR);
  if (hours < 1) return "Under 1 h";
  if (hours < 24) return `${String(hours)} h`;
  return `${String(Math.floor(hours / 24))} d ${String(hours % 24)} h`;
}

// One total per currency, in a stable order, for the pinned row under the grid.
export function heldTotals(rows: readonly Pick<ReviewRow, "amount">[]): Money[] {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.amount.currency, (sums.get(r.amount.currency) ?? 0) + r.amount.amountMinor);
  return [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amountMinor]) => ({ amountMinor, currency }));
}
