import { ShieldCheck, UserCheck, X } from "lucide-react";
import { NewTabLink } from "@/components/new-tab-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { Schemas } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { EFFECT_VIEW, EVENT_LABELS, verdictLabel } from "./ledger-labels";
import { BuyerPaypalNote, PaypalLink } from "./paypal-link";

type Entry = Schemas["LedgerEntry"];

const percent = (bps: number) => `${String(bps / 100)}%`;

// Why this money moved: the part a payments screen usually cannot answer.
export function LedgerDetail({ entry, onClose }: { entry: Entry; onClose: () => void }) {
  const effect = EFFECT_VIEW[entry.ledgerEffect];
  return (
    <Card className="space-y-4 p-5" aria-label="Payment detail">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs text-slate-500">
            {entry.contractTitle} · {entry.milestoneTitle}
          </p>
          <p className="mt-1 font-mono text-2xl font-semibold">{entry.amount === null ? "No amount" : formatMoney(entry.amount)}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={effect.tone}>
              <effect.Icon className="size-3" aria-hidden />
              {effect.label}
            </Badge>
            <span className="text-xs text-slate-500">{EVENT_LABELS[entry.type]}</span>
          </div>
        </div>
        <Button variant="ghost" size="sm" aria-label="Close detail" onClick={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </div>

      <div>
        {/* A requested or denied capture names its release too, and it paid for nothing. */}
        <h2 className="text-sm font-semibold">{entry.ledgerEffect === "PAID" ? "What this paid for" : "Criteria of this release"}</h2>
        {entry.criteria.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{entry.ledgerEffect === "RETURNED" ? "This money went back to the buyer. No criterion paid for it." : "No criterion is tied to this fact."}</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100">
            {entry.criteria.map((c) => (
              <li key={c.criterionId} className="py-2 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="min-w-0 break-words">{c.title}</span>
                  <span className="shrink-0 font-mono text-xs text-slate-500">{percent(c.weightBps)}</span>
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck className="size-3" aria-hidden />
                    {verdictLabel(c.verdict)}
                  </span>
                  {c.humanApproved && (
                    <span className="inline-flex items-center gap-1">
                      <UserCheck className="size-3" aria-hidden />
                      Decided by a person
                    </span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold">PayPal id</h2>
        <p className="mt-1 font-mono text-xs break-all text-slate-600">{entry.paypalId ?? "None"}</p>
      </div>

      {entry.reportHash !== null && (
        <div>
          <h2 className="text-sm font-semibold">Evidence report</h2>
          <p className="mt-1 font-mono text-xs break-all text-slate-600">{entry.reportHash}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {/* New tabs: the ledger keeps its filters and the selected row while these are read. */}
        <NewTabLink href={`/contracts/${entry.contractId}`}>Open contract</NewTabLink>
        <NewTabLink href={`/milestones/${entry.milestoneId}/receipt`}>Open receipt</NewTabLink>
        <PaypalLink url={entry.paypalUrl} />
      </div>
      {entry.myRole === "BUYER" && entry.paypalUrl !== null && <BuyerPaypalNote />}
    </Card>
  );
}
