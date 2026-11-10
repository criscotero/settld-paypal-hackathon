// ADR-0022, view 4: milestones in their objection window, as rows for the countdown grid. Pure and
// tested; the grid ticks every second and asks these functions what to show.
//
// Display only (constitution XII). The server-side timer releases the money; at zero this page
// says "Confirming…", never "Releasing…" or "Paid": only the server can say the window closed, and the
// page asks it (components/server-clock.tsx). Once it has, the milestone leaves this list.
import type { Schemas } from "./api-types";
import type { MilestoneRef } from "./dashboard";

type Money = Schemas["Money"];

export interface CountdownRow {
  id: string;
  href: string;
  contract: string;
  milestone: string;
  // Who this money goes to: for the buyer, each payee of the milestone; for a payee, themselves.
  paidTo: string;
  // What the milestone is worth to the viewer: the whole of it for a buyer, their part for a team member.
  amount: Money;
  endsAt: number;
  // The contract's release countdown, to draw how much of the window has passed. Null when the
  // terms are unknown: no bar beats a bar drawn against a guessed length.
  windowSeconds: number | null;
}

// windowSecondsByContract: Terms.releaseCountdownSeconds of each contract's current version. A
// later amendment could change it, so the bar is an approximation; the time left never is.
export function countdownRows(refs: readonly MilestoneRef[], windowSecondsByContract: ReadonlyMap<string, number>): CountdownRow[] {
  return refs.flatMap((r) => {
    const end = r.milestone.windowEndsAt;
    if (end == null) return [];
    return [
      {
        id: r.milestone.id,
        href: `/contracts/${r.contract.id}#milestone-${r.milestone.id}`,
        contract: r.contract.title,
        milestone: r.milestone.title,
        // The holds name every team member who is paid (ADR-0009). Before the first funding there are
        // none, and the seller is the one the contract names.
        paidTo: r.contract.myRole === "BUYER" ? (r.milestone.holds ?? []).map((h) => h.payeeName).join(", ") || (r.contract.counterpartyName ?? "") : "You",
        amount: r.myAmount,
        endsAt: new Date(end).getTime(),
        windowSeconds: windowSecondsByContract.get(r.contract.id) ?? null,
      },
    ];
  });
}

export const secondsLeft = (row: Pick<CountdownRow, "endsAt">, now: number): number => Math.max(0, Math.floor((row.endsAt - now) / 1000));

// The same format as components/countdown.tsx, so the grid and the list never read differently.
export function clockText(seconds: number): string {
  if (seconds === 0) return "Confirming…";
  const d = Math.floor(seconds / 86_400);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(Math.floor((seconds % 86_400) / 3_600))}:${pad(Math.floor((seconds % 3_600) / 60))}:${pad(seconds % 60)}`;
  return d > 0 ? `${String(d)}d ${time}` : time;
}

export function elapsedShare(row: Pick<CountdownRow, "endsAt" | "windowSeconds">, now: number): number | null {
  if (row.windowSeconds === null || row.windowSeconds <= 0) return null;
  return Math.min(1, Math.max(0, 1 - secondsLeft(row, now) / row.windowSeconds));
}

const perCurrency = (rows: readonly CountdownRow[]): Money[] => {
  const sums = new Map<string, number>();
  for (const r of rows) sums.set(r.amount.currency, (sums.get(r.amount.currency) ?? 0) + r.amount.amountMinor);
  return [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([currency, amountMinor]) => ({ amountMinor, currency }));
};

// open: still inside a window. releasing: reached zero and waiting for the server to release it.
export function windowTotals(rows: readonly CountdownRow[], now: number): { open: Money[]; releasing: Money[]; nextEndsIn: number | null } {
  const open = rows.filter((r) => secondsLeft(r, now) > 0);
  return {
    open: perCurrency(open),
    releasing: perCurrency(rows.filter((r) => secondsLeft(r, now) === 0)),
    nextEndsIn: open.length === 0 ? null : Math.min(...open.map((r) => secondsLeft(r, now))),
  };
}

// Which windows just ended, given the ones seen open before this tick, and the new set of open ones.
// Only a window seen open can "just end": one that was already at zero when it arrived (after a
// refresh, say) is not news. A window that arrives later is seen open on its first tick.
export function newlyEnded(rows: readonly { id: string; left: number }[], seenOpen: ReadonlySet<string>): { ended: string[]; seenOpen: Set<string> } {
  return {
    ended: rows.filter((r) => r.left === 0 && seenOpen.has(r.id)).map((r) => r.id),
    seenOpen: new Set(rows.filter((r) => r.left > 0).map((r) => r.id)),
  };
}
