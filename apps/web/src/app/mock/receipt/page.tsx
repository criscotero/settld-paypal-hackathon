"use client";
// The Settlement Receipt (constitution IX): one page that says what was verified, what was
// paid to whom, what is still held, and why. Printable. In the real app it is built from the
// ledger and the run outcomes, and carries their hashes.
import { CheckCircle2, Printer, XCircle } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import { splitLargestRemainder } from "@/lib/split";
import { formatWeight } from "@/lib/weights";
import { DIRECTORY, MILESTONE } from "../mock-data";
import { useMock } from "../store";

const money = (amountMinor: number) => formatMoney({ amountMinor, currency: MILESTONE.currency });

export default function ReceiptMock() {
  const { state } = useMock();
  const { flow } = state;
  const team = state.team.map((m) => ({ ...m, name: m.personId === "me" ? state.profile.name : (DIRECTORY.find((p) => p.id === m.personId)?.name ?? "?") }));
  const released = flow.releases.reduce((a, r) => a + r.amountMinor, 0);
  const returned = flow.stage === "CLOSED" ? MILESTONE.amountMinor - released : 0;
  const held = (flow.stage === "APPROVED" ? 0 : MILESTONE.amountMinor) - released - returned;
  const perPerson = team.map((_, i) => flow.releases.reduce((sum, r) => sum + (splitLargestRemainder(r.amountMinor, team.map((t) => t.shareBps))[i] ?? 0), 0));

  if (flow.releases.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="font-semibold">No release yet</p>
        <p className="mt-1 text-sm text-slate-500">The receipt appears after the first release.</p>
        <Link href="/mock/contract" className={`${buttonVariants({ variant: "primary" })} mt-4`}>
          Go to the live contract
        </Link>
      </Card>
    );
  }

  return (
    <Card className="mx-auto max-w-3xl space-y-6 p-8 print:border-0 print:shadow-none">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xl font-extrabold tracking-tight">
            <span className="text-primary">$</span>ettld <span className="text-sm font-normal text-slate-500">Settlement receipt</span>
          </p>
          <h1 className="mt-2 text-lg font-bold">
            {MILESTONE.contract} · {MILESTONE.title}
          </h1>
          <p className="text-sm text-slate-500">Buyer {MILESTONE.buyer} · Contract version 2 · Mock receipt</p>
        </div>
        <Button variant="outline" size="sm" className="print:hidden" onClick={() => { window.print(); }}>
          <Printer aria-hidden /> Print
        </Button>
      </div>

      <dl className="grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-sm sm:grid-cols-4">
        {[
          ["Funded", MILESTONE.amountMinor],
          ["Paid", released],
          ["Still held", held],
          ["Returned", returned],
        ].map(([k, v]) => (
          <div key={k} className="bg-white p-3">
            <dt className="text-xs text-slate-500">{k}</dt>
            <dd className="font-mono font-semibold">{money(v as number)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-slate-500">Paid + still held + returned = funded, to the cent.</p>

      <section className="space-y-2">
        <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">Criteria</h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {MILESTONE.criteria.map((c) => {
              const paidIn = flow.releases.find((r) => r.countedIds.includes(c.id));
              return (
                <tr key={c.id}>
                  <td className="py-2 pr-2">{paidIn ? <CheckCircle2 className="size-4 text-emerald-600" aria-label="Counted" /> : <XCircle className="size-4 text-slate-400" aria-label="Did not count" />}</td>
                  <td className="py-2">
                    {c.text}
                    <span className="block text-xs text-slate-500">{paidIn ? (c.level === "HUMAN" ? "Approved by the buyer" : "Passed an automatic check") + ` · paid in release ${String(paidIn.seq)}` : "Did not count: its share is held"}</span>
                  </td>
                  <td className="py-2 text-right font-mono text-slate-500">{formatWeight(c.weightBps)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">Releases</h2>
        <ul className="space-y-1 text-sm">
          {flow.releases.map((r) => (
            <li key={r.seq} className="flex justify-between gap-3">
              <span>
                Release {r.seq} · {new Date(r.at).toLocaleString()} · {formatWeight(r.countedBps)}% of criteria {r.final && <Badge tone="good">final</Badge>}
              </span>
              <span className="font-mono">{money(r.amountMinor)}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">Paid to</h2>
        <ul className="space-y-1 text-sm">
          {team.map((t, i) => (
            <li key={t.personId} className="flex justify-between gap-3">
              <span>
                {t.name} · {t.role} · {formatWeight(t.shareBps)}%
              </span>
              <span className="font-mono">{money(perPerson[i] ?? 0)}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-slate-500">PayPal paid each person directly. Settld never held the money. Platform fee: {money(0)}.</p>
      </section>

      <footer className="space-y-1 border-t border-slate-200 pt-4 text-xs text-slate-400">
        <p>Contract version hash: sha256:3f9a…c21e (mock) · Evidence report hash: sha256:7b10…9ad4 (mock)</p>
        <p>Settld is not a law firm and this receipt is not legal advice.</p>
      </footer>
    </Card>
  );
}
