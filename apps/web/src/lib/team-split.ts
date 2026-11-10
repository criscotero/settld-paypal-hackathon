// ADR-0024: who gets what in each milestone, as rows (members) by columns (milestones). Pure and
// tested; the grid only shows what this file built. Read only: the split changes with Edit team.
//
// Where each amount comes from, in this order:
//   1. A funded milestone: its hold, which is what PayPal authorized for that person.
//   2. Otherwise, the planned split with Core API's rule (splitRemainderToSeller: everyone gets the
//      floor of their share and the leftover cents go to the seller), the same function the funding
//      checklist uses, so the plan here and what PayPal is asked for later cannot differ.
// A collaborator receives only their own shareBps (ADR-0009, decision 6). Their view has one row,
// theirs, and never computes anyone else's part.
import type { Contract, Milestone, Schemas } from "./api-types";
import { releaseTotals } from "./released";
import { splitRemainderToSeller } from "./split";

// Core's rule (floor each share, leftover cents to the seller) when the seller is in the list. A
// collaborator's list has only themselves: there the leftover is someone else's, so it is left out
// instead of being handed to them as if they were the seller.
function splitParts(amountMinor: number, shares: readonly { bps: number; isSeller: boolean }[]): number[] {
  const seller = shares.findIndex((s) => s.isSeller);
  if (seller < 0) return shares.map((s) => Math.floor((amountMinor * s.bps) / 10_000));
  const order = [seller, ...shares.map((_, i) => i).filter((i) => i !== seller)];
  const split = splitRemainderToSeller(amountMinor, order.map((i) => shares[i]?.bps ?? 0));
  const out = shares.map(() => 0);
  order.forEach((i, k) => {
    out[i] = split[k] ?? 0;
  });
  return out;
}

type Money = Schemas["Money"];

export interface SplitColumn {
  id: string;
  // "M1": the milestone's place, as in the criterion codes (lib/criterion-code.ts).
  code: string;
  title: string;
  amount: Money;
}

export interface SplitCell {
  amountMinor: number;
  paidMinor: number;
  // True before PayPal authorized this person's part: a plan, not money reserved.
  planned: boolean;
}

export interface SplitRow {
  id: string;
  name: string;
  role: string;
  shareBps: number | null;
  isSeller: boolean;
  cells: Record<string, SplitCell>;
  totalMinor: number;
  paidMinor: number;
}

export interface TeamSplit {
  currency: string;
  columns: SplitColumn[];
  rows: SplitRow[];
  // Only the viewer's own row: a collaborator (decision 6).
  ownOnly: boolean;
  // Per milestone, the sum of the rows; null when ownOnly, because one row is not a total.
  sums: Record<string, number> | null;
  // Milestones whose rows do not add up to the milestone's amount: shown, never adjusted.
  mismatched: string[];
}

// The seller's slot has no user id until a seller accepts; it still needs a stable row id.
const SELLER_SLOT = "seller";

type Team = NonNullable<Contract["team"]>;

export function teamSplit(contract: Pick<Contract, "team" | "milestones" | "myRole">, viewerId: string): TeamSplit {
  const ownOnly = contract.myRole === "COLLABORATOR";
  // Seller first, the way the Team card lists people.
  const team: Team = [...(contract.team ?? [])].sort((a, b) => Number(b.isSeller) - Number(a.isSeller));
  const rowId = (userId: string | null, isSeller: boolean) => userId ?? (isSeller ? SELLER_SLOT : "unknown");

  const rows = new Map<string, SplitRow>();
  const rowFor = (id: string, name: string, role: string, shareBps: number | null, isSeller: boolean): SplitRow => {
    const existing = rows.get(id);
    if (existing !== undefined) return existing;
    const row: SplitRow = { id, name, role, shareBps, isSeller, cells: {}, totalMinor: 0, paidMinor: 0 };
    rows.set(id, row);
    return row;
  };
  // Team order first, so the grid lists people the way the Team card does.
  for (const t of team) rowFor(rowId(t.userId, t.isSeller), t.displayName, t.role, t.shareBps, t.isSeller);

  const columns = contract.milestones.map((m, i): SplitColumn => ({ id: m.id, code: `M${String(i + 1)}`, title: m.title, amount: m.amount }));

  for (const m of contract.milestones) {
    for (const part of partsOf(m, team)) {
      const member = team.find((t) => rowId(t.userId, t.isSeller) === part.id);
      // A payee who left the team in a later version still has this milestone's hold: the hold wins.
      const row = rowFor(part.id, member?.displayName ?? part.name, member?.role ?? "", member?.shareBps ?? part.shareBps, member?.isSeller ?? false);
      const paid = part.userId === null ? 0 : releaseTotals(m, part.userId).captured;
      row.cells[m.id] = { amountMinor: part.amountMinor, paidMinor: paid, planned: part.planned };
      row.totalMinor += part.amountMinor;
      row.paidMinor += paid;
    }
  }

  // A collaborator's view: their row only. Core sends only their own hold and shareBps, and nothing
  // here may fill in someone else's part.
  const shown = ownOnly ? [...rows.values()].filter((r) => r.id === viewerId) : [...rows.values()];
  const sums = ownOnly ? null : Object.fromEntries(columns.map((c) => [c.id, shown.reduce((sum, r) => sum + (r.cells[c.id]?.amountMinor ?? 0), 0)]));
  return {
    currency: contract.milestones[0]?.amount.currency ?? "USD",
    columns,
    rows: shown,
    ownOnly,
    sums,
    mismatched: sums === null ? [] : columns.filter((c) => sums[c.id] !== c.amount.amountMinor).map((c) => c.id),
  };
}

interface Part {
  id: string;
  userId: string | null;
  name: string;
  shareBps: number | null;
  amountMinor: number;
  planned: boolean;
}

// One milestone's parts. With holds (funded at least once), from the holds; without, from the
// current team's shares. A share Core did not send (another member, for a collaborator) counts as 0:
// the leftover cents still go to the seller's entry, so the viewer's own part is exact.
function partsOf(m: Milestone, team: Team): Part[] {
  const holds = m.holds ?? [];
  if (holds.length > 0) {
    const sellerId = team.find((t) => t.isSeller)?.userId ?? null;
    const planned = splitParts(m.amount.amountMinor, holds.map((h) => ({ bps: h.shareBps, isSeller: h.payeeUserId === sellerId })));
    return holds.map((h, i) => {
      const funded = h.funded.amountMinor > 0;
      return { id: h.payeeUserId, userId: h.payeeUserId, name: h.payeeName, shareBps: h.shareBps, amountMinor: funded ? h.funded.amountMinor : (planned[i] ?? 0), planned: !funded };
    });
  }
  const amounts = splitParts(m.amount.amountMinor, team.map((t) => ({ bps: t.shareBps ?? 0, isSeller: t.isSeller })));
  return team.map((t, i) => ({ id: t.userId ?? (t.isSeller ? SELLER_SLOT : "unknown"), userId: t.userId, name: t.displayName, shareBps: t.shareBps, amountMinor: amounts[i] ?? 0, planned: true }));
}
