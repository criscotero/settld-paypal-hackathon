import { ArrowRight, Bot, CalendarDays, CheckCircle2, ChevronRight, TriangleAlert, User, Wallet, Zap } from "lucide-react";
import type { Metadata } from "next";
import { PARTY_ROLE_LABEL } from "@/lib/dashboard";
import { ServerClock } from "@/components/server-clock";
import Link from "next/link";
import { approveVersion, inviteSeller, submitDraft } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { CopyButton } from "@/components/copy-button";
import { AutoRefresh } from "@/components/auto-refresh";
import { MilestoneActions, MoneyBreakdown } from "@/components/milestone-actions";
import { TeamCard } from "@/components/team-card";
import { MilestoneHistory } from "@/components/milestone-history";
import { ProgressSteps } from "@/components/progress-steps";
import { PublishSection } from "@/components/publish-section";
import { ContractStatus, MilestoneState, YourTurn } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { CriterionVerdict } from "@/components/criterion-verdict";
import { AiAuditLoader } from "@/components/grid/ai-audit-loader";
import { TeamSplitLoader } from "@/components/grid/team-split-loader";
import { LatestDelivery, ObjectionRuling, OpenObjection } from "@/components/delivery-card";
import { signInPath } from "@/lib/sign-in-path";
import type { Contract, Milestone, PartyRole, Schemas } from "@/lib/api-types";
import { auditPending, auditRows } from "@/lib/ai-audit";
import { teamSplit } from "@/lib/team-split";
import type { CriterionResult } from "@/lib/verdict";
import { isListed, listingState } from "@/lib/open-project";
import { beforeAgreementText, contractOverview, myStep } from "@/lib/contract-status";
import { checkLabel, eventText, humanize, moneyText, nextStepText, returnNotice } from "@/lib/copy";
import { formatMoney } from "@/lib/money";
import { contractSteps } from "@/lib/progress";
import type { Step } from "@/lib/progress";
import { formatDate, relativeDays } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { formatCountdown, formatWeight } from "@/lib/weights";

export const metadata: Metadata = { title: "Contract" };

const PAYPAL_OUTCOME: Record<string, { tone: "good" | "bad"; text: string }> = {
  funded: { tone: "good", text: "PayPal reserved the money. The seller can start." },
  cancelled: { tone: "bad", text: "PayPal approval was cancelled. Nothing was reserved." },
  "fund-failed": { tone: "bad", text: "PayPal did not confirm the reservation. Try funding again." },
};

// New contract created the draft but its invitation failed (lib/after-create.ts). Only the code
// comes in the URL; anything unknown gets the general sentence.
const INVITE_FAILED: Record<string, string> = {
  RATE_LIMITED: "You reached today's limit of invitations. Try again tomorrow.",
  VALIDATION_FAILED: "That email address was not accepted. Check it and send the invitation again below.",
};

export default async function ContractPage({ params, searchParams }: { params: Promise<{ contractId: string }>; searchParams: Promise<{ invited?: string; inviteFailed?: string; next?: string; taken?: string; paypal?: string; milestone?: string }> }) {
  const { contractId } = await params;
  const { invited, inviteFailed, next, taken, paypal, milestone } = await searchParams;
  const paypalOutcome = paypal === undefined ? undefined : PAYPAL_OUTCOME[paypal];
  // The target of the decision mail (ADR-0011): after signing in, come back here, to the same
  // milestone. First, because requireOnboardedMe would otherwise send them to a bare /sign-in.
  const { userId } = await auth();
  if (userId === null) redirect(signInPath(`/contracts/${contractId}${milestone === undefined ? "" : `#milestone-${encodeURIComponent(milestone)}`}`));
  const me = await requireOnboardedMe(`/contracts/${contractId}`);
  const client = await api();
  const contract = dataOrThrow(await client.GET("/contracts/{contractId}", { params: { path: { contractId } } }));
  const reports = new Map(await Promise.all(contract.milestones.map(async (m): Promise<[string, ReportState]> => [m.id, await loadReport(client, m)])));
  const split = teamSplit(contract, me.id);
  const context = new Map(await Promise.all(contract.milestones.map(async (m): Promise<[string, DecisionContext]> => [m.id, await loadDecisionContext(client, m)])));
  const steps = contractSteps(contract.status, contract.milestones);
  const stepOf = new Map(steps.map((s) => [s.id, s]));

  // The server's time as this page renders, for its countdowns.
  const serverNow = Date.now();
  return (
    // Every countdown on the page counts from this server time, not the browser clock (server-clock.tsx).
    <ServerClock serverNow={serverNow}>
    <div className="space-y-6">
      <AutoRefresh />

      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-slate-500">
        <Link href="/contracts" className="hover:text-ink">
          Contracts
        </Link>
        <ChevronRight className="size-4 text-slate-300" aria-hidden />
        <span className="truncate font-medium text-ink" aria-current="page">
          {contract.title}
        </span>
      </nav>

      {invited === "1" && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
          <div>
            <p className="font-semibold">Invitation sent</p>
            <p className="text-emerald-800">We emailed that address. They have to enter Settld with that same address to see it.</p>
          </div>
        </div>
      )}

      {inviteFailed !== undefined && (
        <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <span className="font-semibold">The contract was created, but the invitation was not sent.</span> {INVITE_FAILED[inviteFailed] ?? "Try sending it again below."}
        </p>
      )}

      {next === "publish" && contract.sellerId == null && (
        <p role="status" className="rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
          <span className="font-semibold">Contract created.</span> Review it, then select <span className="font-semibold">Publish project</span> below so sellers can find it.
        </p>
      )}

      {taken === "1" && (
        <div role="status" className="flex items-start gap-3 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-emerald-600" aria-hidden />
          <div>
            <p className="font-semibold">The project is yours</p>
            <p className="text-emerald-800">You and the buyer agreed on these terms. No money has moved yet. Wait for the buyer to fund the milestone before you start.</p>
          </div>
        </div>
      )}

      {paypalOutcome && (
        <p role="status" className={cn("rounded-xl border p-4 text-sm font-medium", paypalOutcome.tone === "good" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900")}>
          {paypalOutcome.text}
        </p>
      )}

      <TrackingSummary contract={contract} steps={steps} viewerId={me.id} />

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section className="space-y-4" aria-labelledby="milestones-heading">
          <h2 id="milestones-heading" className="text-lg font-semibold">
            Milestones <span className="font-normal text-slate-400">· {contract.milestones.length}</span>
          </h2>
          {contract.milestones.map((m, i) => (
            <MilestoneSection key={m.id} milestone={m} number={i + 1} viewer={contract.myRole} team={contract.team} beforeAgreement={m.state === "DRAFT" ? beforeAgreementText(contract, me.id) : null} report={reports.get(m.id) ?? null} context={context.get(m.id) ?? NO_CONTEXT} step={stepOf.get(m.id)} />
          ))}
        </section>
        <aside className="space-y-4">
          <AgreementCard contract={contract} meId={me.id} />
          <TeamCard contract={contract} />
          <DetailsCard contract={contract} />
        </aside>
      </div>
      {/* ADR-0024. Full width, under the milestones and the Team card: a column per milestone does not
          fit in the side column. Only for a team, or a collaborator's own share: one person alone
          already sees their money in each milestone. */}
      {split.rows.length > 0 && (split.ownOnly || split.rows.length > 1) && <TeamSplitLoader split={split} />}
    </div>
    </ServerClock>
  );
}

// The top of a tracking page: what this is, one sentence of where it stands, and
// the progress bar. Constitution XII: answers "what happens next" before anything else.
function TrackingSummary({ contract, steps, viewerId }: { contract: Contract; steps: Step[]; viewerId: string }) {
  const current = steps.find((s) => s.status === "current" || s.status === "problem");
  const currentMilestone = contract.milestones.find((m) => m.id === current?.id);
  const headline =
    current === undefined
      ? "All milestones are settled"
      : currentMilestone === undefined
        ? AGREEMENT_HEADLINE[contract.currentVersion.status]
        : `${currentMilestone.title}: ${eventText(currentMilestone.state)}`;
  const next = currentMilestone === undefined ? null : nextStepText(currentMilestone.nextStep, contract.myRole);
  const turn = myStep(contract, viewerId);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-6 p-6">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <ContractStatus status={contractOverview(contract)} />
            {turn !== null && <YourTurn label={turn.label} urgent={turn.urgent} />}
            <span className="flex items-center font-mono text-xs text-slate-400">
              {contract.id}
              <CopyButton value={contract.id} label="Copy contract ID" />
            </span>
          </div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{contract.title}</h1>
          <p className="pt-2 text-base font-semibold text-primary">{headline}</p>
          {next !== null && (
            <p className={cn("flex items-center gap-1.5 text-sm", next.mine ? "font-semibold text-ink" : "text-slate-600")}>
              <ArrowRight className="size-4" aria-hidden /> {next.text}
            </p>
          )}
        </div>
        <div className="rounded-lg bg-slate-50 px-5 py-3 sm:text-right">
          <p className="text-xs font-medium text-slate-500">Contract total</p>
          <p className="font-mono text-2xl font-semibold tracking-tight">{formatMoney(contract.total)}</p>
          <p className="text-xs text-slate-400">
            {contract.milestones.length} milestone{contract.milestones.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>
      <div className="border-t border-slate-100 bg-slate-50/50 px-6 pt-5 pb-6">
        <ProgressSteps steps={steps} />
      </div>
    </Card>
  );
}

const AGREEMENT_HEADLINE: Record<Contract["currentVersion"]["status"], string> = {
  DRAFT: "Agreement: terms being written",
  PENDING_APPROVAL: "Agreement: waiting for both parties to approve",
  SUPERSEDED: "Agreement: terms being written",
  LOCKED: "Agreement: agreed",
};

// null: nothing to show yet. A Map: the report, by criterion. "UNAVAILABLE": the verifier did not answer.
type ReportState = Map<string, CriterionResult> | "UNAVAILABLE" | null;

// Short enough that a verifier that is down does not hold back the page: during a countdown of a
// minute the buyer's buttons matter more than the report.
const REPORT_TIMEOUT_MS = 2_500;

async function loadReport(client: Awaited<ReturnType<typeof api>>, m: Milestone): Promise<ReportState> {
  if (m.latestRunId == null) return null;
  try {
    const { data, response } = await client.GET("/verification-runs/{runId}", { params: { path: { runId: m.latestRunId } }, signal: AbortSignal.timeout(REPORT_TIMEOUT_MS) });
    if (data !== undefined) return new Map(data.results.map((r) => [r.criterionId, r]));
    // 404 is normal for a moment after delivering: the run has not reached the Engine yet.
    return response.status === 404 ? null : "UNAVAILABLE";
  } catch {
    return "UNAVAILABLE";
  }
}

// The report as audit rows, in the agreement's order. Built here, on the server, so the grid gets
// plain data and the rules stay in lib/ai-audit.ts, where they are tested.
// The audit grid, or "Checking…" while the AI has not answered yet (ADR-0022, failure modes).
function AiAudit({ report, m, number }: { report: Map<string, CriterionResult> | null; m: Milestone; number: number }) {
  const rows = report === null ? [] : auditOf(report, m, number);
  const checking = auditPending(m.state, m.criteria ?? [], report);
  if (rows.length > 0) return <AiAuditLoader rows={rows} checking={checking} />;
  if (!checking) return null;
  return (
    <section aria-label="What the AI checked" className="rounded-xl border border-slate-200 p-4">
      <h4 className="text-sm font-semibold">What the AI checked</h4>
      <p role="status" className="text-sm text-slate-500">
        Checking… The AI is reading the delivery. This page updates by itself.
      </p>
    </section>
  );
}

function auditOf(report: Map<string, CriterionResult>, m: Milestone, number: number) {
  return auditRows([...report.values()], (m.criteria ?? []).map((c) => ({ id: c.id, text: c.text })), number - 1, m.latestRunId ?? "");
}

// What a decision is about: the work handed in and, if there is one, what the buyer asked to fix.
// Without these the buyer approves money for a delivery they cannot open, and the seller fixes
// something nobody told them. A failed read leaves the page and the money actions working.
type DecisionContext = { delivery: Schemas["Submission"] | null; objection: Schemas["Objection"] | null };
const NO_CONTEXT: DecisionContext = { delivery: null, objection: null };

async function loadDecisionContext(client: Awaited<ReturnType<typeof api>>, m: Milestone): Promise<DecisionContext> {
  const [submissions, objection] = await Promise.all([
    m.latestRunId == null ? null : client.GET("/milestones/{milestoneId}/submissions", { params: { path: { milestoneId: m.id } } }).catch(() => null),
    m.latestObjectionId == null ? null : client.GET("/objections/{objectionId}", { params: { path: { objectionId: m.latestObjectionId } } }).catch(() => null),
  ]);
  return { delivery: submissions?.data?.at(-1) ?? null, objection: objection?.data ?? null };
}

// One step of the progress bar, opened up: where the money is, what happens next,
// the event history and the criteria the delivery is checked against.
function MilestoneSection({ milestone: m, number, viewer, team, beforeAgreement, report, context, step }: { milestone: Milestone; number: number; viewer: PartyRole; team: Contract["team"]; beforeAgreement: { mine: boolean; text: string } | null; report: ReportState; context: DecisionContext; step: Step | undefined }) {
  const next = beforeAgreement ?? nextStepText(m.nextStep, viewer);
  const active = step?.status === "current" || step?.status === "problem";
  const returned = returnNotice(m, viewer);
  return (
    <Card id={`milestone-${m.id}`} className={cn("scroll-mt-24 overflow-hidden", active && "ring-1 ring-primary/30")}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-5 pb-3">
        <div className="flex items-start gap-3">
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold", active ? "bg-primary text-white" : "bg-slate-100 text-slate-500")}>
            {number}
          </span>
          <div>
            <h3 className="font-semibold">{m.title}</h3>
            <p className="flex items-center gap-1.5 text-sm text-slate-500">
              <CalendarDays className="size-3.5" aria-hidden />
              Due {formatDate(m.dueDate)}
              {m.state !== "RELEASED" && m.state !== "CLOSED" && m.state !== "VOIDED" && <span className="text-slate-400">· {relativeDays(m.dueDate)}</span>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono font-semibold">{formatMoney(m.amount)}</span>
          <MilestoneState state={m.state} />
        </div>
      </div>
      <CardContent className="space-y-5">
        <dl className="grid gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-sm sm:grid-cols-2">
          <div className="flex gap-3 bg-white p-3">
            <Wallet className="mt-0.5 size-4 shrink-0 text-slate-400" aria-hidden />
            <div>
              <dt className="text-xs font-medium text-slate-500">Where is the money</dt>
              <dd className="font-medium">{moneyText(m, (team?.length ?? 0) > 1)}</dd>
            </div>
          </div>
          <div className={cn("flex gap-3 p-3", next.mine ? "bg-accent-soft" : "bg-white")}>
            <ArrowRight className={cn("mt-0.5 size-4 shrink-0", next.mine ? "text-primary" : "text-slate-400")} aria-hidden />
            <div>
              <dt className="text-xs font-medium text-slate-500">What happens next</dt>
              <dd className={cn("font-medium", next.mine && "text-primary")}>{next.text}</dd>
            </div>
          </div>
        </dl>
        {returned !== null && (
          <div role="status" className="flex items-start gap-3 rounded-lg border border-orange-300 bg-orange-50 p-3 text-sm text-orange-950">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-orange-700" aria-hidden />
            <div>
              <p className="font-semibold">{returned.title}</p>
              <p>{returned.text}</p>
            </div>
          </div>
        )}
        <MoneyBreakdown m={m} />
        {(m.releases ?? []).length > 0 && (
          <Link href={`/milestones/${m.id}/receipt`} className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline">
            Settlement receipt <ChevronRight className="size-4" aria-hidden />
          </Link>
        )}
        {report === "UNAVAILABLE" && <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-600">The verification report is not available right now. The delivery and the money are not affected.</p>}
        {context.objection !== null && m.openObjectionId === context.objection.id && <OpenObjection objection={context.objection} criteria={m.criteria ?? []} viewer={viewer} />}
        {context.objection !== null && <ObjectionRuling objection={context.objection} />}
        {context.delivery !== null && <LatestDelivery delivery={context.delivery} />}
        {/* ADR-0022, view 1: before the buttons, so the buyer reads why before deciding. Only AI criteria have checks. */}
        {report !== "UNAVAILABLE" && <AiAudit report={report} m={m} number={number} />}
        <MilestoneActions m={m} viewer={viewer} team={team} results={report === "UNAVAILABLE" ? null : report} objection={context.objection} />
        {/* Open for the step that needs attention; others stay one click away so the
            page reads like a tracking page, not a wall of identical lists. */}
        <details open={active} className="group">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-slate-500 select-none hover:text-ink [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" aria-hidden />
            History and acceptance criteria
          </summary>
          <div className="mt-4">
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <h4 className="mb-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">History</h4>
                <MilestoneHistory state={m.state} />
              </div>
              <div>
                <h4 className="mb-3 text-xs font-semibold tracking-wide text-slate-500 uppercase">Checked against</h4>
                {m.description && <p className="mb-2 text-sm whitespace-pre-line text-slate-600">{m.description}</p>}
                <ul className="space-y-1.5 text-sm">
                  {(m.criteria ?? []).map((c) => (
                    <li key={c.id} className="flex items-start gap-2.5">
                      <CriterionIcon level={c.level} />
                      <span className="min-w-0">
                        <span className="mr-1.5 text-xs font-medium text-slate-500">{c.level === "HUMAN" ? "Human review" : checkLabel(c.checkType ?? c.level)}</span>
                        <br />
                        {c.text}
                        <span className="text-slate-400"> · {formatWeight(c.weightBps)}%{c.required ? "" : ", optional"}</span>
                        {report !== null && report !== "UNAVAILABLE" && report.has(c.id) && <CriterionVerdict result={report.get(c.id) as CriterionResult} />}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

// Where the two parties stand on the current version. Every button maps to one
// operationId, and Core API decides whether it is allowed; the conditions here
// only hide buttons that would certainly fail.
function AgreementCard({ contract, meId }: { contract: Contract; meId: string }) {
  const v = contract.currentVersion;
  const approvedBy = new Set(v.approvals.filter((a) => a.snapshotHash === v.snapshotHash).map((a) => a.partyRole));
  // Per person since ADR-0009: a version may have several collaborator approvals.
  const iApproved = v.approvals.some((a) => a.userId === meId && a.snapshotHash === v.snapshotHash);
  const lowVerifiability = (v.verifiability ?? []).filter((x) => x.belowThreshold);
  const listing = listingState(contract.publishedUntil, new Date(), contract.milestones.map((m) => m.dueDate));
  const isOpen = isListed(listing);

  return (
    <Card id="agreement" className="scroll-mt-6">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          Agreement · v{v.version} <Badge>{humanize(v.status)}</Badge>
        </CardTitle>
        <p className="text-sm text-slate-500">
          {v.status === "DRAFT" && "Still being written. Submit it when both of you can review the final text."}
          {v.status === "PENDING_APPROVAL" && "Frozen for review. It is agreed when both parties approve this exact content."}
          {v.status === "LOCKED" && "Agreed by both parties. This version can no longer change."}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {v.status !== "DRAFT" && (
          <div className="flex flex-wrap gap-2">
            {(["BUYER", "SELLER"] as const).map((role) => (
              <Badge key={role} tone={approvedBy.has(role) ? "good" : "neutral"}>
                {role === "BUYER" ? "Buyer" : "Seller"}: {approvedBy.has(role) ? "approved" : "pending"}
              </Badge>
            ))}
            {/* Collaborators approve too (ADR-0009); their names are in the Team card. */}
            {(contract.team ?? [])
              .filter((t) => !t.isSeller)
              .map((t) => (
                <Badge key={t.userId ?? t.displayName} tone={t.approvedCurrentVersion ? "good" : "neutral"}>
                  {t.displayName}: {t.approvedCurrentVersion ? "approved" : "pending"}
                </Badge>
              ))}
          </div>
        )}

        <div className="flex flex-wrap items-start gap-3">
          {v.status !== "LOCKED" && contract.myRole !== "COLLABORATOR" && !isOpen && (
            <Link href={`/contracts/${contract.id}/edit`} className={cn(buttonVariants({ variant: "outline" }), "mt-3")}>
              Edit draft
            </Link>
          )}

          {v.status === "DRAFT" && contract.myRole !== "COLLABORATOR" && (
            <ActionForm action={submitDraft} submitLabel="Submit for approval" variant="primary">
              <input type="hidden" name="contractId" value={contract.id} />
            </ActionForm>
          )}

          {v.status === "PENDING_APPROVAL" && !iApproved && v.snapshotHash && (
            <ActionForm action={approveVersion} submitLabel={`Approve version ${String(v.version)}`} variant="primary">
              <input type="hidden" name="contractId" value={contract.id} />
              <input type="hidden" name="version" value={v.version} />
              {/* The hash on screen is what gets approved (DM-INV-2). If the other party
                  edits first, Core API answers STALE_STATE or VERSION_HASH_MISMATCH. */}
              <input type="hidden" name="snapshotHash" value={v.snapshotHash} />
              {lowVerifiability.length > 0 && (
                <label className="flex items-start gap-2 text-sm text-amber-900">
                  <input type="checkbox" name="acknowledgeLowVerifiability" required className="mt-1" />
                  {lowVerifiability.length} milestone(s) depend mostly on human review. I accept that they cannot be verified automatically.
                </label>
              )}
            </ActionForm>
          )}
        </div>

        {v.status === "PENDING_APPROVAL" && contract.sellerId == null && !isOpen && (
          <p className="text-sm text-slate-500">The seller can approve only after accepting the invitation.</p>
        )}

        {contract.myRole === "BUYER" && contract.sellerId == null && !isOpen && (
          <ActionForm action={inviteSeller} submitLabel={contract.pendingInvitation ? "Send" : "Send invitation"} variant="outline" className="border-t border-slate-100 pt-4">
            <input type="hidden" name="contractId" value={contract.id} />
            {/* Live test, 2026-11-07: with nothing on screen saying it went out, the buyer sent it
                three times. The email, never a name: before accepting, the invitee is only an address. */}
            {contract.pendingInvitation && (
              <p className="mb-3 flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900">
                <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden />
                <span>
                  Invitation sent to <span className="font-semibold break-all">{contract.pendingInvitation.email}</span>, waiting for them to accept. It expires on {formatDate(contract.pendingInvitation.expiresAt.slice(0, 10))}. Sending it again to the same address renews it and emails them again.
                </span>
              </p>
            )}
            <Label htmlFor="email">{contract.pendingInvitation ? "Send it again, or invite someone else" : "Invite the seller"}</Label>
            <Input id="email" name="email" type="email" required placeholder="seller@example.com" className="mt-1.5" />
            {/* Accepting needs no token: the verified address is the proof (ADR-0013). */}
            <p className="mt-1.5 text-xs text-slate-500">Use the address they will enter Settld with. The invitation only opens with that address.</p>
          </ActionForm>
        )}

        {contract.myRole === "BUYER" && contract.sellerId == null && v.status !== "LOCKED" && (
          // id: New contract's "Publish as an open project" lands here (lib/after-create.ts).
          <div id="publish" className="scroll-mt-6">
            <PublishSection contractId={contract.id} version={v.version} state={listing} publishedUntil={contract.publishedUntil} lowVerifiabilityCount={lowVerifiability.length} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DetailsCard({ contract }: { contract: Contract }) {
  const v = contract.currentVersion;
  const rows: [string, string][] = [
    ["You are", PARTY_ROLE_LABEL[contract.myRole]],
    [contract.myRole === "BUYER" ? "Seller" : "Buyer", contract.counterpartyName ?? (contract.pendingInvitation ? "Invited, not joined yet" : "Not joined yet")],
    ["Milestones", String(contract.milestones.length)],
    ["Release countdown", formatCountdown(v.snapshot.terms.releaseCountdownSeconds)],
    ["Silence counts as approval", v.snapshot.terms.silenceIsApproval ? "Yes" : "No"],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Contract details</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-slate-100 text-sm">
          {rows.map(([k, val]) => (
            <div key={k} className="flex justify-between gap-4 py-2">
              <dt className="text-slate-500">{k}</dt>
              <dd className="text-right font-semibold">{val}</dd>
            </div>
          ))}
        </dl>
        {v.snapshotHash && (
          <p className="mt-3 text-xs text-slate-400">
            Content fingerprint: <code className="break-all">{v.snapshotHash}</code>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const LEVEL_ICON = { AUTOMATIC: Zap, AI_EVALUATED: Bot, HUMAN: User } as const;

function CriterionIcon({ level }: { level: keyof typeof LEVEL_ICON }) {
  const Icon = LEVEL_ICON[level];
  return (
    <span
      className={cn("mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md", level === "HUMAN" ? "bg-amber-50 text-amber-600" : "bg-sky-50 text-sky-600")}
      title={level === "HUMAN" ? "Human review" : level === "AUTOMATIC" ? "Checked automatically" : "Checked by AI"}
    >
      <Icon className="size-3.5" aria-hidden />
    </span>
  );
}
