// What the viewer can do with one milestone right now, and where every cent is. Each form
// maps to one operationId; Core API decides whether it is allowed (409 explains why not).
// The state checks here only hide buttons that would certainly fail.
import { acceptPartial, approveRelease, cancelMilestone, contestObjection, fundMilestone, raiseObjection, startWork, submitDelivery, surrenderMilestone, withdrawObjection } from "@/app/milestone-actions";
import { ActionForm } from "@/components/action-form";
import { Countdown } from "@/components/countdown";
import { CriterionVerdict } from "@/components/criterion-verdict";
import { decidableCriteria } from "@/lib/verdict";
import type { CriterionResult } from "@/lib/verdict";
import { FundingChecklist, TeamMoney, ordersToReserve, partsText, reserveCopy } from "@/components/team-money";
import { buttonVariants } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import type { Contract, Milestone, PartyRole, Schemas } from "@/lib/api-types";
import { formatMoney } from "@/lib/money";
import { releaseTotals } from "@/lib/released";
import { cn } from "@/lib/utils";
import { formatWeight } from "@/lib/weights";

function Hidden({ m }: { m: Milestone }) {
  return (
    <>
      <input type="hidden" name="contractId" value={m.contractId} />
      <input type="hidden" name="milestoneId" value={m.id} />
      <input type="hidden" name="stateVersion" value={m.stateVersion} />
    </>
  );
}

// Constitution XII: "Where is my money?" Every funded cent is in exactly one of these boxes.
export function MoneyBreakdown({ m }: { m: Milestone }) {
  if (m.funded === undefined || m.funded.amountMinor === 0 || m.state === "APPROVED") return null;
  const team = (m.holds ?? []).length > 1;
  const totals = releaseTotals(m);
  const amount = (amountMinor: number) => ({ amountMinor, currency: m.amount.currency });
  const rows = [
    { label: team ? "Paid to the team" : "Paid to the seller", value: amount(totals.captured), tone: "text-emerald-700" },
    { label: "PayPal is paying", value: amount(totals.pending), tone: "text-emerald-700" },
    { label: "PayPal declined", value: amount(totals.declined), tone: "text-red-700" },
    { label: "Reserved in PayPal", value: m.held, tone: "text-sky-700" },
    { label: "Returned to the buyer", value: m.returned, tone: "text-slate-600" },
  ].filter((r) => r.value !== undefined && r.value.amountMinor > 0);
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap gap-x-6 gap-y-1">
        {rows.map((r) => (
          <p key={r.label}>
            <span className="text-slate-500">{r.label}: </span>
            <span className={`font-mono font-semibold ${r.tone}`}>{r.value ? formatMoney(r.value) : ""}</span>
          </p>
        ))}
      </div>
      <TeamMoney m={m} />
      {(m.releases ?? []).length > 0 && (
        <ol className="space-y-0.5 text-xs text-slate-500">
          {(m.releases ?? []).map((r) => (
            <li key={r.id}>
              Release {r.seq}: <span className="font-mono">{formatMoney(r.amount)}</span> for {formatWeight(r.countedBps)}% of the criteria ·{" "}
              {r.status === "CAPTURED" ? "captured by PayPal" : r.status === "PENDING" ? "PayPal is capturing it" : r.final ? "PayPal declined it; Settld has to review it" : "PayPal declined it; it can be released again in the next round"}
              {team && (r.parts ?? []).length > 0 && <span className="block pl-4">{partsText(m, r)}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function MilestoneActions({ m, viewer, team, results = null, objection = null }: { m: Milestone; viewer: PartyRole; team: Contract["team"]; results?: Map<string, CriterionResult> | null; objection?: Schemas["Objection"] | null }) {
  const buyer = viewer === "BUYER";
  const seller = viewer === "SELLER";
  const undecided = decidableCriteria(m.criteria ?? [], results);
  const reserve = reserveCopy(m, ordersToReserve(m, team));
  // SM-T16 since state machine 2.1.0: a milestone funded only in part can be cancelled, and
  // what was already reserved goes back to the buyer.
  // G-NOT-ESCALATED: once it reached a reviewer, delivering again is refused.
  const liveObjection = objection !== null && m.openObjectionId === objection.id ? objection : null;
  // From nextStep, not the objection: that read can fail, and then the form would only get a 409.
  const withReviewer = m.state === "OBJECTED" && m.nextStep.actor === "REVIEWER";
  const partlyReserved = m.state === "APPROVED" && (m.holds ?? []).some((h) => h.holdStatus === "AUTHORIZED");

  return (
    <div className="space-y-4">
      {m.state === "APPROVED" && buyer && (
        <ActionForm
          action={fundMilestone}
          submitLabel={reserve.label}
          variant="primary"
        >
          <Hidden m={m} />
          <FundingChecklist m={m} />
          <p className="text-sm text-slate-600">{reserve.text}</p>
        </ActionForm>
      )}

      {m.state === "FUNDED" && seller && (
        <ActionForm action={startWork} submitLabel="Start work" variant="primary">
          <Hidden m={m} />
        </ActionForm>
      )}

      {(m.state === "IN_PROGRESS" || (m.state === "OBJECTED" && !withReviewer) || m.state === "PARTIALLY_RELEASED") && seller && (
        <ActionForm action={submitDelivery} submitLabel={m.state === "IN_PROGRESS" ? "Deliver" : "Deliver the fix"} variant="primary">
          <Hidden m={m} />
          <p className="text-sm text-slate-600">Deliver at least one: a link, a public GitHub repository, or a .zip of the files. The verifier reads only what is delivered here.</p>
          <Label htmlFor={`url-${m.id}`} className="mt-3 block">
            Link to the delivered work
          </Label>
          <Input id={`url-${m.id}`} name="url" type="url" placeholder="https://staging.example.com" className="mt-1.5" />
          <Label htmlFor={`repository-${m.id}`} className="mt-3 block">
            Public GitHub repository
          </Label>
          <Input id={`repository-${m.id}`} name="repository" type="url" pattern="https://github\.com/.+/.+" placeholder="https://github.com/you/project" className="mt-1.5" />
          <p className="mt-1 text-xs text-slate-500">Settld reads the commit that is there when you deliver. Pushing later does not change what is checked.</p>
          <Label htmlFor={`file-${m.id}`} className="mt-3 block">
            Files (.zip, up to 25 MB)
          </Label>
          <Input id={`file-${m.id}`} name="file" type="file" accept=".zip,application/zip" className="mt-1.5" />
          <Label htmlFor={`notes-${m.id}`} className="mt-3 block">
            Notes for the buyer
          </Label>
          <Textarea id={`notes-${m.id}`} name="notes" maxLength={5000} className="mt-1.5 min-h-14" />
        </ActionForm>
      )}

      {m.state === "VERIFYING" && <p className="text-sm text-slate-600">Settld is checking the delivery against each criterion.</p>}

      {m.state === "OBJECTION_WINDOW" && m.windowEndsAt && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          What counts is released in <Countdown until={m.windowEndsAt} /> unless the buyer objects. Human and AI criteria count only if the buyer approves them.
        </p>
      )}

      {m.state === "OBJECTION_WINDOW" && buyer && (
        <div className="grid gap-4 sm:grid-cols-2">
          <ActionForm action={approveRelease} submitLabel="Approve and release now" variant="primary">
            <Hidden m={m} />
            {undecided.length > 0 && <p className="text-sm font-medium">Criteria only you can approve:</p>}
            {undecided.map((c) => {
              const result = results?.get(c.id);
              return (
                <label key={c.id} className="mt-1 flex items-start gap-2 text-sm">
                  <input type="checkbox" name="approve" value={c.id} className="mt-1" />
                  <span>
                    {c.text} <span className="text-slate-400">· {formatWeight(c.weightBps)}%{c.required ? ", required" : ""}</span>
                    {result !== undefined && <CriterionVerdict result={result} />}
                  </span>
                </label>
              );
            })}
          </ActionForm>
          <ActionForm action={raiseObjection} submitLabel="Ask the seller to fix it" variant="outline">
            <Hidden m={m} />
            <p className="text-sm font-medium">What should the seller fix?</p>
            {(m.criteria ?? []).map((c) => (
              <label key={c.id} className="mt-1 flex items-start gap-2 text-sm">
                <input type="checkbox" name="criterionId" value={c.id} className="mt-1" />
                {c.text}
              </label>
            ))}
            <Textarea name="reason" required minLength={20} maxLength={5000} placeholder="At least 20 characters: what fails and how to see it." className="mt-2 min-h-14" />
          </ActionForm>
        </div>
      )}

      {m.state === "OBJECTED" && buyer && m.openObjectionId && (
        <ActionForm action={withdrawObjection} submitLabel="Withdraw the objection and release" variant="outline">
          <Hidden m={m} />
          <input type="hidden" name="objectionId" value={m.openObjectionId} />
          {undecided.map((c) => {
            const result = results?.get(c.id);
            return (
              <label key={c.id} className="mt-1 flex items-start gap-2 text-sm">
                <input type="checkbox" name="approve" value={c.id} className="mt-1" />
                <span>
                  Approve: {c.text} <span className="text-slate-400">· {formatWeight(c.weightBps)}%{c.required ? ", required" : ""}</span>
                  {result !== undefined && <CriterionVerdict result={result} />}
                </span>
              </label>
            );
          })}
        </ActionForm>
      )}

      {m.state === "OBJECTED" && seller && liveObjection !== null && liveObjection.contestedAt == null && (
        <details open={withReviewer}>
          <summary className="cursor-pointer text-sm font-medium text-slate-600">Disagree? Explain your side to the reviewer</summary>
          <ActionForm action={contestObjection} submitLabel="Send to the reviewer" variant="outline">
            <Hidden m={m} />
            <input type="hidden" name="objectionId" value={liveObjection.id} />
            <p className="mt-2 text-sm text-slate-600">You can do this once. The buyer can read it too. It does not delay the reviewer.</p>
            <Textarea name="reason" required minLength={20} maxLength={5000} placeholder="At least 20 characters: why the delivery meets what was agreed." className="mt-2 min-h-14" />
          </ActionForm>
        </details>
      )}

      {m.state === "OBJECTED" && seller && (
        <details>
          <summary className="cursor-pointer text-sm text-slate-500">Give up and return the money</summary>
          <ActionForm action={surrenderMilestone} submitLabel={(m.released?.amountMinor ?? 0) > 0 ? "Keep what was paid and return the rest" : "Return everything to the buyer"} variant="outline">
            <Hidden m={m} />
            <p className="mt-2 text-sm text-slate-600">This ends the milestone and cannot be undone.</p>
          </ActionForm>
        </details>
      )}

      {m.state === "PARTIALLY_RELEASED" && seller && (
        <ActionForm action={acceptPartial} submitLabel={`Accept ${m.released ? formatMoney(m.released) : ""} and return the rest`} variant="outline">
          <Hidden m={m} />
          <p className="text-sm text-slate-600">Closes the milestone. What is still reserved goes back to the buyer.</p>
        </ActionForm>
      )}

      {(m.state === "FUNDED" || m.state === "IN_PROGRESS" || (partlyReserved && viewer !== "COLLABORATOR")) && (
        // A button, not a grey link: after a failed check this is how the buyer gets the money
        // back, and in a live test (2026-11-07) the old link was hard to find. The reason and the
        // confirm stay one click away, because cancelling cannot be undone.
        <details>
          <summary className={cn(buttonVariants({ variant: "outline" }), "cursor-pointer list-none border-red-300 text-red-700 hover:bg-red-50 [&::-webkit-details-marker]:hidden")}>Cancel milestone</summary>
          <ActionForm action={cancelMilestone} submitLabel="Cancel and return the money" variant="destructive" className="mt-3 rounded-lg border border-red-200 bg-red-50/40 p-3">
            <Hidden m={m} />
            <p className="text-sm text-slate-600">
              {m.state === "IN_PROGRESS" ? "If the check failed, you can also wait for the seller to fix it and deliver again. " : ""}
              Cancelling ends this milestone and PayPal gives every reservation back to the buyer. It cannot be undone.
            </p>
            <Input name="reason" required maxLength={2000} placeholder="Why" aria-label="Why you cancel" className="mt-2" />
          </ActionForm>
        </details>
      )}
    </div>
  );
}
