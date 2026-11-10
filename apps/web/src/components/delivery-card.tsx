// What the decision on a milestone is about. The seller's links and notes are outside content:
// rendered as text only, and labeled as theirs, so nothing here reads as something Settld checked.
import { ExternalLink, FileText, MessageSquareWarning, Scale } from "lucide-react";
import type { Milestone, PartyRole, Schemas } from "@/lib/api-types";
import { formatDate } from "@/lib/dates";
import { safeHref } from "@/lib/safe-href";

export function EvidenceLink({ link }: { link: Schemas["EvidenceLink"] }) {
  const href = safeHref(link.url);
  if (href === null) return <span className="break-all text-slate-600">{link.label ?? link.url}</span>;
  return (
    <a href={href} className="inline-flex items-center gap-1 font-medium break-all text-primary underline print:no-underline" rel="noreferrer noopener" target="_blank">
      {link.label ?? link.url} <ExternalLink className="size-3.5 shrink-0 print:hidden" aria-hidden />
    </a>
  );
}

export function LatestDelivery({ delivery }: { delivery: Schemas["Submission"] }) {
  return (
    <section aria-label="Latest delivery" className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <h4 className="flex items-center gap-1.5 font-semibold">
        <FileText className="size-4 text-slate-400" aria-hidden /> What the seller delivered
        <span className="font-normal text-slate-500">· delivery {delivery.attempt}, {formatDate(delivery.submittedAt.slice(0, 10))}</span>
      </h4>
      <ul className="space-y-1">
        {delivery.evidenceLinks.map((l) => (
          <li key={l.url}>
            <EvidenceLink link={l} />
          </li>
        ))}
      </ul>
      {delivery.notes !== undefined && delivery.notes !== "" && (
        <div>
          <p className="text-xs font-medium text-slate-500">Notes from the seller</p>
          <p className="break-words whitespace-pre-line text-slate-700">{delivery.notes}</p>
        </div>
      )}
    </section>
  );
}

export function OpenObjection({ objection, criteria, viewer }: { objection: Schemas["Objection"]; criteria: NonNullable<Milestone["criteria"]>; viewer: PartyRole }) {
  const named = criteria.filter((c) => objection.criterionIds.includes(c.id));
  return (
    <section aria-label="What to fix" className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <h4 className="flex items-center gap-1.5 font-semibold">
        <MessageSquareWarning className="size-4 text-amber-600" aria-hidden />
        {viewer === "BUYER" ? "What you asked the seller to fix" : "What the buyer asked to fix"}
        <span className="font-normal text-amber-800">· {formatDate(objection.raisedAt.slice(0, 10))}</span>
      </h4>
      <p className="break-words whitespace-pre-line">{objection.reason}</p>
      {named.length > 0 && (
        <ul className="list-inside list-disc text-amber-900">
          {named.map((c) => (
            <li key={c.id}>{c.text}</li>
          ))}
        </ul>
      )}
      <ObjectionMessages objection={objection} />
      <p className="font-medium">
        {objection.status === "ESCALATED" ? "A neutral reviewer will decide this. The money stays reserved until then." : `If this is not settled by ${formatDate(objection.escalateAt.slice(0, 10))}, a neutral reviewer decides.`}
      </p>
    </section>
  );
}

// The seller's answer. Written by a party: shown as text and labeled as theirs.
export function ObjectionMessages({ objection }: { objection: Schemas["Objection"] }) {
  const messages = objection.messages ?? [];
  if (messages.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium opacity-80">The seller&apos;s side</p>
      {messages.map((m) => (
        <p key={m.id} className="break-words whitespace-pre-line">
          {m.body}
        </p>
      ))}
    </div>
  );
}

// After the objection ends the parties still need to know who decided, what and why.
export function ObjectionRuling({ objection }: { objection: Schemas["Objection"] }) {
  if (objection.status !== "RULED_RELEASE" && objection.status !== "RULED_VOID") return null;
  return (
    <section aria-label="The reviewer's decision" className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
      <h4 className="flex items-center gap-1.5 font-semibold">
        <Scale className="size-4 text-slate-500" aria-hidden /> A neutral reviewer decided: {objection.status === "RULED_RELEASE" ? "what was reserved is paid to the seller" : "what was reserved goes back to the buyer"}
      </h4>
      {objection.resolution?.reason !== undefined && <p className="break-words whitespace-pre-line text-slate-700">{objection.resolution.reason}</p>}
    </section>
  );
}
