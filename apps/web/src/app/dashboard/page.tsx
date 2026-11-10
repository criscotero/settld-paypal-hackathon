import { ArrowRight, CalendarClock, CheckCircle2, Clock, FileSignature, Handshake, Hourglass, Inbox, Plus, Send, ShieldAlert, UserPlus, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import { ServerClock } from "@/components/server-clock";
import Link from "next/link";
import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { Countdown } from "@/components/countdown";
import { CountdownLoader } from "@/components/grid/countdown-loader";
import { MoneyBar } from "@/components/money-bar";
import { PaidCharts } from "@/components/paid-charts";
import type { ChartLabels } from "@/components/paid-charts";
import type { SegmentLabels } from "@/components/money-bar";
import { PageHeader } from "@/components/page-header";
import { MilestoneState, YourTurn } from "@/components/status";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, requireOnboardedMe } from "@/lib/api";
import type { Contract, PartyRole, Schemas } from "@/lib/api-types";
import { countdownRows } from "@/lib/countdown";
import { milestoneTurnLabel } from "@/lib/contract-status";
import { nextStepText } from "@/lib/copy";
import { DELIVERED_STATES, actionCount, availableViews, buildDashboard, greetingRole, paidHistory, sumBy } from "@/lib/dashboard";
import type { ApprovalRef, Dashboard, DraftStep, MilestoneRef, WaitingAgreement } from "@/lib/dashboard";
import { formatDate, relativeDays } from "@/lib/dates";
import { loadAllContracts } from "@/lib/load-contracts";
import { formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Dashboard" };

// Same data, two readings. A buyer asks "what do I owe and what must I approve?"; a
// seller asks "what do I deliver next and when do I get paid?" (constitution XII).
const COPY: Record<PartyRole, { greeting: string; money: string; segments: SegmentLabels; kpis: { paid: string; reserved: string; unfunded: string }; charts: ChartLabels }> = {
  BUYER: {
    greeting: "Here is what needs you and where your money is.",
    money: "Where your money is",
    segments: { paid: "Paid to sellers", reserved: "Reserved in your PayPal", unfunded: "Agreed, not funded yet" },
    kpis: { paid: "Paid to sellers", reserved: "Reserved in PayPal", unfunded: "Still to fund" },
    charts: { months: "Paid to sellers by month", parties: "Paid by seller", noun: "paid out" },
  },
  SELLER: {
    greeting: "Here is what to deliver next and when you get paid.",
    money: "Your earnings",
    segments: { paid: "Paid to you", reserved: "Secured in the buyer's PayPal", unfunded: "Agreed, awaiting funding" },
    kpis: { paid: "Earned", reserved: "Secured", unfunded: "Pipeline" },
    charts: { months: "Earnings by month", parties: "Earnings by client", noun: "earned" },
  },
  // ADR-0009: a collaborator's share of the seller's contracts.
  COLLABORATOR: {
    greeting: "Here is what your teams deliver next and your share of each payment.",
    money: "Your share",
    segments: { paid: "Paid to you", reserved: "Secured in the buyer's PayPal", unfunded: "Agreed, awaiting funding" },
    kpis: { paid: "Earned", reserved: "Secured", unfunded: "Pipeline" },
    charts: { months: "Your share by month", parties: "Your share by client", noun: "earned" },
  },
};

const VIEW_PARAM: Record<PartyRole, string> = { BUYER: "buyer", SELLER: "seller", COLLABORATOR: "collaborator" };
const VIEW_NAME: Record<PartyRole, string> = { BUYER: "buyer", SELLER: "seller", COLLABORATOR: "collaborator" };

function viewFor(views: PartyRole[], requested: string | undefined): PartyRole | null {
  return views.find((v) => VIEW_PARAM[v] === requested) ?? views[0] ?? null;
}

// Each contract's release countdown, for the countdown grid's progress bars.
function windowSeconds(contracts: readonly Contract[]): Map<string, number> {
  return new Map(contracts.flatMap((c) => {
    const seconds = c.currentVersion.snapshot.terms.releaseCountdownSeconds;
    return typeof seconds === "number" ? [[c.id, seconds] as const] : [];
  }));
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  const { as } = await searchParams;
  const me = await requireOnboardedMe();
  const all = await loadAllContracts();
  const views = availableViews(me.roles, all);
  const role = viewFor(views, as);
  const firstName = me.displayName.split(" ")[0] ?? me.displayName;

  // Set apart from the party views: a reviewer's work is on contracts they are not in.
  const reviews = me.roles.includes("REVIEWER") || me.roles.includes("ADMIN");
  if (role === null) return <AdminNotice name={firstName} />;

  const d = buildDashboard(all, role, me.id);
  const history = paidHistory(all, role, me.id);
  const copy = COPY[role];
  // Steps in the dashboards this page is not showing. "You are all caught up" while a seller's
  // delivery waits, because this person is looking at their buyer side, would be false.
  const elsewhere = views.filter((v) => v !== role).map((v) => ({ view: v, count: actionCount(buildDashboard(all, v, me.id)) }));
  // The person's, whichever dashboard they are on. A failed read only hides this list.
  const invitations = (await (await api()).GET("/me/invitations").catch(() => null))?.data?.items ?? [];
  const canBeSeller = me.roles.includes("SELLER");

  // The server's time as this page renders, for its countdowns.
  const serverNow = Date.now();
  return (
    // Every countdown on the page counts from this server time, not the browser clock (server-clock.tsx).
    <ServerClock serverNow={serverNow}>
    <div className="space-y-8">
      <AutoRefresh everyMs={15000} />
      <PageHeader
        eyebrow={<p className="text-xs font-semibold tracking-wider text-primary uppercase">{role === "BUYER" ? "Buyer dashboard" : role === "SELLER" ? "Seller dashboard" : "Collaborator dashboard"}</p>}
        title={`Hi ${firstName} (Role: ${greetingRole(me.roles, role)})`}
        description={copy.greeting}
        actions={
          <>
            {elsewhere.map((e) => (
              <Link key={e.view} href={`/dashboard?as=${VIEW_PARAM[e.view]}`} className={buttonVariants({ variant: "outline" })}>
                View as {VIEW_NAME[e.view]}
                {e.count > 0 && <span className="ml-1.5 rounded-full bg-primary px-1.5 text-xs font-semibold text-white">{e.count}</span>}
              </Link>
            ))}
            {reviews && (
              <Link href="/review" className={buttonVariants({ variant: "outline" })}>
                Objections to review
              </Link>
            )}
            {me.roles.includes("ADMIN") && (
              <Link href="/admin/reviewers" className={buttonVariants({ variant: "outline" })}>
                Reviewer applications
              </Link>
            )}
            {role === "BUYER" && (
              <Link href="/contracts/new" className={buttonVariants({ variant: "primary" })}>
                <Plus aria-hidden /> New contract
              </Link>
            )}
          </>
        }
      />

      <Kpis d={d} labels={copy.kpis} invitations={invitations.length} />

      {history !== null && <PaidCharts history={history} labels={copy.charts} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <ActionCenter d={d} invitations={invitations} canBeSeller={canBeSeller} elsewhere={elsewhere.reduce((sum, e) => sum + e.count, 0)} />
          {/* ADR-0022, view 4: only while some money is inside an objection window. */}
          {d.inWindow.length > 0 && <CountdownLoader rows={countdownRows(d.inWindow, windowSeconds(d.contracts))} viewerIsBuyer={role === "BUYER"} />}
          {role !== "BUYER" && (
            <Section icon={Hourglass} title="Payments on the way" hint="Delivered work being verified or inside the objection window." empty="Nothing delivered right now.">
              {d.incoming.map((r) => (
                <MilestoneRow key={r.milestone.id} r={r} role={role} />
              ))}
            </Section>
          )}
          <Section icon={Clock} title="Waiting on others" hint="Someone else, or Settld, acts next." empty="Nobody else has a step pending.">
            {[
              ...d.waitingAgreements.map((w) => <WaitingAgreementRow key={w.contract.id} w={w} />),
              ...d.waiting.map((r) => <MilestoneRow key={r.milestone.id} r={r} role={role} />),
            ]}
          </Section>
        </div>

        <aside className="space-y-6">
          <Card className="p-5">
            <h2 className="flex items-center gap-2 font-semibold">
              <Wallet className="size-4 text-slate-400" aria-hidden /> {copy.money}
            </h2>
            <div className="mt-4 space-y-6">
              {d.money.length === 0 ? <p className="text-sm text-slate-500">No agreed milestones yet.</p> : d.money.map((b) => <MoneyBar key={b.currency} buckets={b} labels={copy.segments} />)}
            </div>
          </Card>
          <UpcomingCard d={d} />
          {d.recentlyPaid.length > 0 && <RecentlyPaid d={d} />}
        </aside>
      </div>
    </div>
    </ServerClock>
  );
}

function Kpis({ d, labels, invitations }: { d: Dashboard; labels: { paid: string; reserved: string; unfunded: string }; invitations: number }) {
  // Main currency (the largest book) in big type; any other currency on its own line
  // below, so two currencies never truncate each other or get added together.
  const main = d.money[0]?.currency ?? "USD";
  const fmt = (key: "paid" | "reserved" | "unfunded") => {
    const sums = sumBy(d.money, key);
    const first = sums.find((m) => m.currency === main) ?? { amountMinor: 0, currency: main };
    const rest = sums.filter((m) => m.currency !== main);
    return { value: formatMoney(first), extra: rest.map((m) => `+ ${formatMoney(m)}`).join("  ") };
  };
  const todo = actionCount(d) + invitations;
  const tiles = [
    { label: "Needs your action", value: String(todo), extra: "", hint: todo === 0 ? "You are all caught up" : "Steps only you can take", highlight: todo > 0 },
    { label: labels.paid, ...fmt("paid"), hint: "Captured in PayPal" },
    { label: labels.reserved, ...fmt("reserved"), hint: "Authorized, not charged yet" },
    { label: labels.unfunded, ...fmt("unfunded"), hint: `${String(d.activeContracts)} active contract${d.activeContracts === 1 ? "" : "s"}` },
  ];
  return (
    <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {tiles.map((t) => (
        <Card key={t.label} className={cn("p-4 sm:p-5", t.highlight && "border-primary/40 bg-accent-soft/60")}>
          <dt className="text-sm font-medium text-slate-500">{t.label}</dt>
          <dd className={cn("mt-2 truncate font-mono text-xl font-semibold tracking-tight sm:text-2xl", t.highlight && "text-primary")}>{t.value}</dd>
          {t.extra === "" ? null : <dd className="font-mono text-xs font-medium text-slate-600">{t.extra}</dd>}
          <dd className="mt-1 text-xs text-slate-400">{t.hint}</dd>
        </Card>
      ))}
    </dl>
  );
}

type PendingInvitation = Schemas["PendingInvitation"];

function ActionCenter({ d, invitations, canBeSeller, elsewhere }: { d: Dashboard; invitations: PendingInvitation[]; canBeSeller: boolean; elsewhere: number }) {
  const count = actionCount(d) + invitations.length;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <Inbox className="size-4 text-primary" aria-hidden /> Needs your action
        </h2>
        <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", count > 0 ? "bg-primary text-white" : "bg-slate-100 text-slate-500")}>{count}</span>
      </div>
      {count === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <CheckCircle2 className="size-8 text-emerald-500" aria-hidden />
          <p className="mt-2 font-medium">{elsewhere === 0 ? "You are all caught up" : "Nothing here"}</p>
          <p className="text-sm text-slate-500">{elsewhere === 0 ? "New steps appear here as soon as they are yours." : `You have ${String(elsewhere)} step${elsewhere === 1 ? "" : "s"} in your other view. Switch above.`}</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {invitations.map((i) => (
            <InvitationRow key={i.id} i={i} canBeSeller={canBeSeller} />
          ))}
          {d.myApprovals.map((a) => (
            <ApprovalRow key={a.contract.id} a={a} />
          ))}
          {d.myDraftSteps.map((s) => (
            <DraftStepRow key={s.contract.id} s={s} />
          ))}
          {d.myMilestones.map((r) => (
            <MilestoneRow key={r.milestone.id} r={r} role={d.role} actionable />
          ))}
        </ul>
      )}
    </Card>
  );
}

function StepRow({ href, icon: Icon, title, detail, cta, turn }: { href: string; icon: LucideIcon; title: string; detail: string; cta: string; turn: string }) {
  return (
    <li>
      <Link href={href} className="group flex items-center gap-4 border-l-4 border-l-orange-600 px-5 py-4 transition-colors hover:bg-slate-50">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{title}</p>
          <p className="truncate text-sm text-slate-500">{detail}</p>
          <p className="mt-1">
            <YourTurn label={turn} />
          </p>
        </div>
        <span className="hidden items-center gap-1 text-sm font-semibold text-primary sm:flex">
          {cta} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

function InvitationRow({ i, canBeSeller }: { i: PendingInvitation; canBeSeller: boolean }) {
  // Roles are chosen once (onboarding): without SELLER, accepting is refused. Better said here.
  const detail = canBeSeller ? `From ${i.buyerName} · ${formatMoney(i.total)}` : `From ${i.buyerName} · your account was set up without the seller role, so accepting will be refused`;
  return <StepRow href={`/invitations/pending/${i.id}`} icon={Handshake} title={i.contractTitle} detail={detail} cta="See it" turn="Your turn to answer the invitation" />;
}

function DraftStepRow({ s }: { s: DraftStep }) {
  return s.kind === "INVITE" ? (
    <StepRow href={`/contracts/${s.contract.id}#agreement`} icon={UserPlus} title={s.contract.title} detail="No seller has joined yet. Nothing can be agreed without one." cta="Invite" turn="Your turn to invite the seller" />
  ) : (
    <StepRow href={`/contracts/${s.contract.id}#agreement`} icon={Send} turn="Your turn to send for approval" title={s.contract.title} detail={`Version ${String(s.version)} is still a draft${s.contract.counterpartyName ? `, with ${s.contract.counterpartyName}` : ""}.`} cta="Review" />
  );
}

function WaitingAgreementRow({ w }: { w: WaitingAgreement }) {
  return (
    <li className="list-none">
      <Link href={`/contracts/${w.contract.id}#agreement`} className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-slate-50">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <FileSignature className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{w.contract.title}, version {w.version}</p>
          <p className="truncate text-sm text-slate-600">{w.waitingFor.length === 0 ? "Waiting for the approvals to settle" : `Waiting for approval from ${w.waitingFor.join(", ")}`}</p>
        </div>
      </Link>
    </li>
  );
}

function ApprovalRow({ a }: { a: ApprovalRef }) {
  return (
    <li>
      <Link href={`/contracts/${a.contract.id}#agreement`} className="group flex items-center gap-4 border-l-4 border-l-orange-600 px-5 py-4 transition-colors hover:bg-slate-50">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600">
          <FileSignature className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{a.contract.title}</p>
          <p className="truncate text-sm text-slate-500">
            Version {a.version} · with {a.contract.counterpartyName ?? "the other party"} · {formatMoney(a.contract.total)}
          </p>
          <p className="mt-1">
            <YourTurn label="Your turn to approve the terms" />
          </p>
        </div>
        <span className="hidden items-center gap-1 text-sm font-semibold text-primary sm:flex">
          Review <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </span>
      </Link>
    </li>
  );
}

function MilestoneRow({ r, role, actionable = false }: { r: MilestoneRef; role: PartyRole; actionable?: boolean }) {
  const m = r.milestone;
  const next = nextStepText(m.nextStep, role);
  const delivered = DELIVERED_STATES.has(m.state);
  const rel = relativeDays(m.dueDate);
  const overdue = !delivered && rel.endsWith("overdue");
  const attention = m.state === "OBJECTED";
  return (
    <li className="list-none">
      <Link href={`/contracts/${r.contract.id}#milestone-${m.id}`} className={cn("group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-slate-50", actionable && "border-l-4", actionable && (m.state === "OBJECTION_WINDOW" ? "border-l-red-700" : "border-l-orange-600"))}>
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            attention ? "bg-amber-50 text-amber-600" : actionable ? "bg-accent-soft text-primary" : "bg-slate-100 text-slate-500",
          )}
        >
          {attention ? <ShieldAlert className="size-4" aria-hidden /> : actionable ? <ArrowRight className="size-4" aria-hidden /> : <Clock className="size-4" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          {/* By contract first: it is the name the contract list and the page use. */}
          <p className="truncate font-medium">{r.contract.title}</p>
          <p className="truncate text-sm text-slate-500">
            {m.title} · {r.contract.counterpartyName ?? "—"}
          </p>
          {actionable ? (
            <p className="mt-1">
              <YourTurn label={milestoneTurnLabel(m)} urgent={m.state === "OBJECTION_WINDOW"} />
            </p>
          ) : (
            <p className="mt-0.5 truncate text-sm text-slate-600">{next.text}</p>
          )}
          {/* The deadline that matters while it runs: what nobody decides by then is not paid. */}
          {m.state === "OBJECTION_WINDOW" && m.windowEndsAt != null && (
            <p className="mt-0.5 text-sm font-medium text-amber-800">
              Countdown: <Countdown until={m.windowEndsAt} />
            </p>
          )}
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-1 sm:flex">
          <span className="font-mono text-sm font-semibold">{formatMoney(r.myAmount)}</span>
          <MilestoneState state={m.state} />
          <span className={cn("text-xs", overdue ? "font-medium text-red-600" : "text-slate-400")}>{delivered ? "Delivered" : overdue ? rel : `Due ${rel}`}</span>
        </div>
      </Link>
    </li>
  );
}

function Section({ icon: Icon, title, hint, empty, children }: { icon: LucideIcon; title: string; hint: string; empty: string; children: ReactNode[] }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-slate-100 px-5 py-4">
        <h2 className="flex items-center gap-2 font-semibold">
          <Icon className="size-4 text-slate-400" aria-hidden /> {title}
        </h2>
        <p className="text-sm text-slate-500">{hint}</p>
      </div>
      {children.length === 0 ? <p className="px-5 py-6 text-sm text-slate-500">{empty}</p> : <ul className="divide-y divide-slate-100">{children}</ul>}
    </Card>
  );
}

function UpcomingCard({ d }: { d: Dashboard }) {
  const items = d.upcoming.slice(0, 5);
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <CalendarClock className="size-4 text-slate-400" aria-hidden /> Due dates
      </h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No open milestones.</p>
      ) : (
        <ol className="mt-3 space-y-3">
          {items.map((r) => {
            const rel = relativeDays(r.milestone.dueDate);
            return (
              <li key={r.milestone.id}>
                <Link href={`/contracts/${r.contract.id}#milestone-${r.milestone.id}`} className="group flex items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium group-hover:text-primary">{r.contract.title}</span>
                    <span className="block truncate text-xs text-slate-500">{r.milestone.title}</span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block text-xs font-medium">{formatDate(r.milestone.dueDate)}</span>
                    <span className={cn("block text-xs", rel.endsWith("overdue") ? "text-red-600" : "text-slate-400")}>{rel}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function RecentlyPaid({ d }: { d: Dashboard }) {
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <CheckCircle2 className="size-4 text-emerald-500" aria-hidden /> {d.role === "BUYER" ? "Recently paid out" : "Recently paid to you"}
      </h2>
      <ul className="mt-3 space-y-2.5">
        {d.recentlyPaid.slice(0, 5).map((r) => (
          <li key={r.milestone.id} className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">
              {r.contract.title} <span className="text-slate-400">· {r.milestone.title}</span>
            </span>
            <span className="shrink-0 font-mono font-semibold">{formatMoney(r.paid)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Staff are a party to nothing (G-ACTOR-NEUTRAL): what they have is the objections to review.
function AdminNotice({ name }: { name: string }) {
  return (
    <Card className="mx-auto max-w-xl p-8 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <ShieldAlert className="size-6" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold">Hi, {name}</h1>
      <p className="mt-1 text-sm text-slate-500">You are not a party to any contract. Your work here is the objections that reached a neutral reviewer.</p>
      <div className="mt-4 flex flex-wrap justify-center gap-3">
        <Link href="/review" className={buttonVariants({ variant: "primary" })}>
          Objections to review
        </Link>
        <Link href="/admin/reviewers" className={buttonVariants({ variant: "outline" })}>
          Reviewer applications
        </Link>
      </div>
    </Card>
  );
}
