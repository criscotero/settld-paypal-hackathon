// The Settlement Receipt (constitution IX): what was paid to whom, what is still held or was
// returned, and the PayPal ids that prove it. Built here from three Core API reads (decided by
// the owner on 2026-10-31: no receipt endpoint yet), so it shows only what those reads expose.
// A collaborator gets only their own hold, parts and ledger rows from Core API (ADR-0009,
// decision 6), so their receipt is only about their money.
//
// Not here yet: per-criterion verdicts and evidence hashes. They live in the Engine's run
// report (GET /verification-runs/{runId}), which Core API does not proxy yet.
import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { EvidenceLink } from "@/components/delivery-card";
import { BuyerPaypalNote, PaypalLink } from "@/components/payments/paypal-link";
import { PrintButton } from "@/components/print-button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { formatMoney } from "@/lib/money";
import { releaseTotals } from "@/lib/released";
import { formatWeight } from "@/lib/weights";

export const metadata: Metadata = { title: "Settlement receipt" };

export default async function ReceiptPage({ params }: { params: Promise<{ milestoneId: string }> }) {
  const { milestoneId } = await params;
  await requireOnboardedMe(`/milestones/${milestoneId}/receipt`);
  const client = await api();
  const path = { params: { path: { milestoneId } } };
  const m = dataOrThrow(await client.GET("/milestones/{milestoneId}", path));
  const [contract, events, submissions] = await Promise.all([
    client.GET("/contracts/{contractId}", { params: { path: { contractId: m.contractId } } }).then(dataOrThrow),
    client.GET("/milestones/{milestoneId}/payment-events", path).then(dataOrThrow),
    client.GET("/milestones/{milestoneId}/submissions", path).then(dataOrThrow),
  ]);
  const money = (amountMinor: number) => formatMoney({ amountMinor, currency: m.amount.currency });
  const holds = m.holds ?? [];
  const names = new Map(holds.map((h) => [h.payeeUserId, h.payeeName]));
  // Sums over the holds the viewer can see: for a collaborator, their own money only.
  const sum = (f: (h: (typeof holds)[number]) => number) => holds.reduce((a, h) => a + f(h), 0);
  const funded = sum((h) => h.funded.amountMinor);
  // What PayPal captured, not what was decided: a receipt must not say "Paid" next to "declined".
  const paidTo = (h: (typeof holds)[number]) => releaseTotals(m, h.payeeUserId).captured;
  const paid = sum(paidTo);
  const returned = sum((h) => h.returned.amountMinor);
  const releases = m.releases ?? [];
  const capturesOf = (releaseId: string) => events.flatMap((e) => (e.type === "CAPTURED" && e.releaseId === releaseId && e.paypal?.captureId !== undefined ? [{ id: e.paypal.captureId, url: e.paypalUrl }] : []));
  const authorizations = events.filter((e) => e.type === "AUTHORIZED" && e.paypal?.orphan !== "true").map((e) => e.paypal?.authorizationId).filter((id) => id !== undefined);
  const returns = events.filter((e) => e.type === "VOIDED" || e.type === "REFUNDED");

  return (
    <div className="space-y-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-slate-500 print:hidden">
        <Link href={`/contracts/${contract.id}#milestone-${m.id}`} className="hover:text-ink">
          {contract.title}
        </Link>
        <ChevronRight className="size-4 text-slate-300" aria-hidden />
        <span className="font-medium text-ink" aria-current="page">
          Receipt
        </span>
      </nav>

      <Card className="mx-auto max-w-3xl space-y-6 p-8 print:border-0 print:shadow-none">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xl font-extrabold tracking-tight">
              <span className="text-primary">$</span>ettld <span className="text-sm font-normal text-slate-500">Settlement receipt</span>
            </p>
            <h1 className="mt-2 text-lg font-bold">
              {contract.title} · {m.title}
            </h1>
            <p className="text-sm text-slate-500">
              Contract version {contract.currentVersion.version} · Milestone {m.state.toLowerCase().replaceAll("_", " ")}
              {contract.myRole === "COLLABORATOR" && " · Your share only"}
            </p>
          </div>
          <PrintButton />
        </div>

        <dl className="grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-sm sm:grid-cols-4">
          {(
            [
              ["Funded", funded],
              ["Paid", paid],
              ["Still held", funded - paid - returned],
              ["Returned", returned],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="bg-white p-3">
              <dt className="text-xs text-slate-500">{k}</dt>
              <dd className="font-mono font-semibold">{money(v)}</dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-slate-500">Paid + still held + returned = funded, to the cent (constitution V).</p>

        <section className="space-y-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">Paid to</h2>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-100">
              {holds.map((h) => (
                <tr key={h.payeeUserId}>
                  <td className="py-2">
                    {h.payeeName} <span className="text-slate-400">· {formatWeight(h.shareBps)}% of the milestone</span>
                  </td>
                  <td className="py-2 text-right font-mono font-semibold">{money(paidTo(h))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-slate-500">PayPal paid each person directly from the buyer&apos;s reservation. Settld never held the money.</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">Releases</h2>
          {releases.length === 0 && <p className="text-sm text-slate-500">Nothing released yet.</p>}
          <ul className="space-y-3 text-sm">
            {releases.map((r) => (
              <li key={r.id} className="space-y-1">
                <p className="flex justify-between gap-3">
                  <span>
                    Release {r.seq} · {new Date(r.decidedAt).toLocaleString("en")} · {formatWeight(r.countedBps)}% of the criteria counted {r.final && <Badge tone="good">final</Badge>}{" "}
                    {r.status !== "CAPTURED" && <Badge tone={r.status === "FAILED" ? "bad" : "neutral"}>{r.status === "FAILED" ? "declined by PayPal" : "PayPal is capturing it"}</Badge>}
                  </span>
                  <span className="font-mono">{formatMoney(r.amount)}</span>
                </p>
                {(r.parts ?? []).map((p) => (
                  <p key={p.payeeUserId} className="flex justify-between gap-3 pl-4 text-slate-500">
                    <span>
                      {names.get(p.payeeUserId) ?? "Team member"} · platform fee {formatMoney(p.platformFee)}
                    </span>
                    <span className="font-mono">{formatMoney(p.amount)}</span>
                  </p>
                ))}
                {capturesOf(r.id).map((c) => (
                  <p key={c.id} className="flex flex-wrap items-center gap-x-3 pl-4 text-xs">
                    <span className="font-mono break-all text-slate-400">PayPal capture {c.id}</span>
                    {/* A printed receipt keeps the id; a link cannot be clicked on paper. */}
                    <PaypalLink url={c.url} className="print:hidden" />
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {contract.myRole === "BUYER" && releases.some((r) => capturesOf(r.id).some((c) => c.url !== null && c.url !== undefined)) && <BuyerPaypalNote className="print:hidden" />}
        </section>

        <section className="space-y-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">Checked against</h2>
          <ul className="space-y-1 text-sm">
            {(m.criteria ?? []).map((c) => (
              <li key={c.id} className="flex justify-between gap-3">
                <span>
                  {c.text}
                  <span className="text-slate-400"> · {c.level === "HUMAN" ? "human review" : c.level === "AUTOMATIC" ? "automatic check" : "AI check"}{c.required ? ", required" : ""}</span>
                </span>
                <span className="font-mono text-slate-500">{formatWeight(c.weightBps)}%</span>
              </li>
            ))}
          </ul>
        </section>

        {submissions.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-sm font-bold tracking-wide text-slate-500 uppercase">Deliveries</h2>
            <ul className="space-y-1 text-sm">
              {submissions.map((s) => (
                <li key={s.id}>
                  Delivery {s.attempt} · {new Date(s.submittedAt).toLocaleString("en")} ·{" "}
                  {s.evidenceLinks.map((l) => (
                    <EvidenceLink key={l.url} link={l} />
                  ))}
                </li>
              ))}
            </ul>
          </section>
        )}

        <footer className="space-y-1 border-t border-slate-200 pt-4 text-xs break-all text-slate-400">
          {contract.currentVersion.snapshotHash && <p>Agreed contract fingerprint: {contract.currentVersion.snapshotHash}</p>}
          {authorizations.length > 0 && <p>PayPal authorizations: {authorizations.join(", ")}</p>}
          {returns.length > 0 && <p>Returned to the buyer by PayPal: {returns.map((e) => `${e.type === "VOIDED" ? "void" : "refund"} ${e.paypal?.authorizationId ?? e.paypal?.captureId ?? ""}`).join(", ")}</p>}
          <p>Settld is not a law firm and this receipt is not legal advice.</p>
        </footer>
      </Card>
    </div>
  );
}
