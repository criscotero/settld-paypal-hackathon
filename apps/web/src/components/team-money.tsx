// Where every team member's money is (ADR-0009). Each person has their own PayPal authorization,
// so "where is my money" is answered per person: reserved, paid, returned. Before the milestone
// is funded it is the funding checklist the buyer works through, one PayPal approval each.
// A collaborator gets only their own row from Core API (decision 6); nothing is hidden here.
import { CheckCircle2, Circle } from "lucide-react";
import type { Contract, Milestone } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { releaseTotals } from "@/lib/released";
import { splitRemainderToSeller } from "@/lib/split";
import { formatWeight } from "@/lib/weights";
import { cn } from "@/lib/utils";

type Hold = NonNullable<Milestone["holds"]>[number];

// The amount each order asks PayPal for. Authorized holds report it; the others are computed
// with Core API's rule. Holds come in team order, so the seller is first.
export function plannedAmounts(m: Milestone): number[] {
  const holds = m.holds ?? [];
  const planned = splitRemainderToSeller(m.amount.amountMinor, holds.map((h) => h.shareBps));
  return holds.map((h, i) => (h.holdStatus === "AUTHORIZED" ? h.funded.amountMinor : (planned[i] ?? 0)));
}

// Only an active authorization: one that expired has to be approved again (SM-T17).
const reserved = (h: Hold) => h.holdStatus === "AUTHORIZED";

// The checklist "Fede ✓, Ana: to reserve" (ADR-0009, decision 3). Only while the milestone waits
// for its funding, and only for a team: one person needs no checklist.
export function FundingChecklist({ m }: { m: Milestone }) {
  const holds = m.holds ?? [];
  if (m.state !== "APPROVED" || holds.length < 2) return null;
  const amounts = plannedAmounts(m);
  return (
    <ol className="space-y-1.5 rounded-lg border border-slate-200 p-3 text-sm" aria-label="PayPal reservations, one per team member">
      {holds.map((h, i) => (
        <li key={h.payeeUserId} className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2">
            {reserved(h) ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Reserved" /> : <Circle className="size-4 text-slate-300" aria-label="Not reserved yet" />}
            {h.payeeName} <span className="text-slate-400">· {formatWeight(h.shareBps)}%</span>
          </span>
          <span className={cn("font-mono", reserved(h) ? "font-semibold text-emerald-700" : "text-slate-500")}>
            {formatMoney({ amountMinor: amounts[i] ?? 0, currency: m.amount.currency })} {reserved(h) ? "reserved" : "to reserve"}
          </span>
        </li>
      ))}
    </ol>
  );
}

// The orders the buyer still has to approve, in the order PayPal will show them, for the fund
// button. One click covers them all: after each approval the return route sends the buyer straight
// on to the next order without stopping in Settld. So the button names the total left, and the
// text lists each person, because PayPal shows one amount per page (live tests 2026-11-05 and
// 2026-11-07: a label with only the total, or only the first person, both misled). Null for one person.
export function ordersToReserve(m: Milestone, team: Contract["team"] = []): { name: string; amountMinor: number }[] | null {
  const holds = m.holds ?? [];
  // Holds are created on the first /fund. Until then the team says who is in it, seller first.
  if (holds.length === 0) {
    if (team.length < 2) return null;
    const planned = splitRemainderToSeller(m.amount.amountMinor, team.map((t) => t.shareBps ?? 0));
    return team.map((t, i) => ({ name: t.displayName, amountMinor: planned[i] ?? 0 }));
  }
  if (holds.length < 2) return null;
  const amounts = plannedAmounts(m);
  return holds.flatMap((h, i) => (reserved(h) ? [] : [{ name: h.payeeName, amountMinor: amounts[i] ?? 0 }]));
}

// The fund button's label and the line under it. "Remaining" once part is reserved (the buyer
// stopped halfway, or one authorization expired), so the label never asks for money already held.
export function reserveCopy(m: Milestone, orders: { name: string; amountMinor: number }[] | null): { label: string; text: string } {
  const money = (amountMinor: number) => formatMoney({ amountMinor, currency: m.amount.currency });
  const later = "Nothing is charged until the work is verified and the countdown ends.";
  if (orders === null || orders.length === 0) return { label: `Reserve ${formatMoney(m.amount)} with PayPal`, text: `PayPal reserves the money on your account. ${later}` };
  const left = orders.reduce((sum, o) => sum + o.amountMinor, 0);
  const partly = left < m.amount.amountMinor;
  const list = orders.map((o) => `${o.name} ${money(o.amountMinor)}`).join(", ");
  const steps = orders.length === 1 ? "You approve 1 payment in PayPal" : `You approve ${String(orders.length)} payments in PayPal, one after the other`;
  return {
    label: partly ? `Reserve the remaining ${money(left)} with PayPal` : `Reserve ${money(left)} with PayPal`,
    text: `${steps}: ${list}. PayPal pays each team member directly. ${later}`,
  };
}

// After funding: one row per person with what PayPal holds for them, has paid them, and gave back.
export function TeamMoney({ m }: { m: Milestone }) {
  const holds = m.holds ?? [];
  // One person: MoneyBreakdown already says it all. Before funding: the checklist does.
  if (holds.length < 2 || m.state === "APPROVED" || holds.every((h) => h.funded.amountMinor === 0)) return null;
  const money = (amountMinor: number) => formatMoney({ amountMinor, currency: m.amount.currency });
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs text-slate-500">
          <th className="pb-1 font-medium">Paid directly by PayPal to</th>
          <th className="pb-1 text-right font-medium">Paid</th>
          <th className="pb-1 text-right font-medium">Reserved</th>
          <th className="pb-1 text-right font-medium">Returned</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {holds.map((h) => (
          <tr key={h.payeeUserId}>
            <td className="py-1.5">
              {h.payeeName} <span className="text-slate-400">· {formatWeight(h.shareBps)}%</span>
            </td>
            <td className="py-1.5 text-right font-mono font-semibold text-emerald-700">{money(releaseTotals(m, h.payeeUserId).captured)}</td>
            <td className="py-1.5 text-right font-mono text-sky-700">{money(h.funded.amountMinor - releaseTotals(m, h.payeeUserId).captured - h.returned.amountMinor)}</td>
            <td className="py-1.5 text-right font-mono text-slate-600">{money(h.returned.amountMinor)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// "315 to Fede, 135 to Ana" for one release, names from the holds.
export function partsText(m: Milestone, release: NonNullable<Milestone["releases"]>[number]): string {
  const names = new Map((m.holds ?? []).map((h) => [h.payeeUserId, h.payeeName]));
  return (release.parts ?? []).map((p) => `${formatMoney(p.amount)} to ${names.get(p.payeeUserId) ?? "a team member"}`).join(", ");
}
