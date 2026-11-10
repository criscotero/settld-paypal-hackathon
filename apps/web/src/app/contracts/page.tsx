import { ChevronRight, FileText, Plus, Search } from "lucide-react";
import type { Metadata } from "next";
import { PARTY_ROLE_LABEL } from "@/lib/dashboard";
import { ServerClock } from "@/components/server-clock";
import Link from "next/link";
import { trackContract } from "@/app/actions";
import { PageHeader } from "@/components/page-header";
import { Countdown } from "@/components/countdown";
import { ContractStatus, YourTurn } from "@/components/status";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { requireOnboardedMe } from "@/lib/api";
import type { Contract } from "@/lib/api-types";
import { contractOverview, myStep, sortContracts, turnOfOthers } from "@/lib/contract-status";
import type { ContractOverview } from "@/lib/contract-status";
import { relativeDays } from "@/lib/dates";
import { loadAllContracts } from "@/lib/load-contracts";
import { formatMoney } from "@/lib/money";
import { totalsByCurrency } from "@/lib/totals";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Contracts" };

const FILTERS = [
  { role: undefined, label: "All" },
  { role: "BUYER", label: "As buyer" },
  { role: "SELLER", label: "As seller" },
] as const;

export default async function ContractsPage({ searchParams }: { searchParams: Promise<{ role?: string; track?: string }> }) {
  const { role: rawRole, track } = await searchParams;
  const role = rawRole === "BUYER" || rawRole === "SELLER" ? rawRole : undefined;
  const me = await requireOnboardedMe();
  // Every contract in full, like the dashboard: the order and the "your turn" come from its milestones.
  const all = sortContracts(await loadAllContracts(), me.id);
  const items = role === undefined ? all : all.filter((c) => c.myRole === role);
  const isBuyer = me.roles.includes("BUYER");

  // The server's time as this page renders, for its countdowns.
  const serverNow = Date.now();
  return (
    // Every countdown on the page counts from this server time, not the browser clock (server-clock.tsx).
    <ServerClock serverNow={serverNow}>
    <div className="space-y-8">
      <PageHeader
        title="Contracts"
        description={`Welcome back, ${me.displayName.split(" ")[0] ?? me.displayName}. Track every milestone and where its money is.`}
        actions={
          // Core API also refuses non-buyers (FORBIDDEN); hiding the button only spares a dead click.
          isBuyer && (
            <Link href="/contracts/new" className={buttonVariants({ variant: "primary" })}>
              <Plus aria-hidden /> New contract
            </Link>
          )
        }
      />

      <Stats items={items} />

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 p-4">
          <div role="tablist" aria-label="Filter by role" className="inline-flex rounded-lg bg-slate-100 p-1">
            {FILTERS.map((f) => (
              <Link
                key={f.label}
                role="tab"
                aria-selected={role === f.role}
                href={f.role === undefined ? "/contracts" : `/contracts?role=${f.role}`}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  role === f.role ? "bg-white text-ink shadow-sm" : "text-slate-600 hover:text-ink",
                )}
              >
                {f.label}
              </Link>
            ))}
          </div>
          {/* Track box: a contract id or a pasted link, like a tracking number. */}
          <form action={trackContract} className="flex w-full gap-2 sm:w-auto">
            <div className="relative flex-1 sm:w-80">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
              <Input name="contractId" required aria-label="Track a contract by ID or link" placeholder="Track by contract ID or link" className="pl-9" />
            </div>
            <Button type="submit" variant="outline">
              Track
            </Button>
          </form>
        </div>
        {track === "invalid" && <p className="border-b border-slate-200 bg-red-50 px-4 py-2 text-sm text-red-700">That is not a contract ID. It looks like 01a14163-8be4-7ab5-….</p>}

        {items.length === 0 ? <EmptyState isBuyer={isBuyer} filtered={role !== undefined} /> : <ContractTable items={items} viewerId={me.id} />}
      </Card>
    </div>
    </ServerClock>
  );
}

function Stats({ items }: { items: Contract[] }) {
  const count = (s: ContractOverview) => items.filter((c) => contractOverview(c) === s).length;
  const agreed = totalsByCurrency(items.filter((c) => c.status === "LOCKED").map((c) => c.total));
  const stats = [
    { label: "Agreed value", value: agreed.length === 0 ? "—" : agreed.map((m) => formatMoney(m)).join(" · "), hint: "Locked contracts" },
    { label: "Active", value: String(count("ACTIVE") + count("DISPUTE")), hint: "Work or money still moving" },
    { label: "Awaiting approval", value: String(count("AWAITING_APPROVAL")), hint: "Frozen for review" },
    { label: "Completed", value: String(count("COMPLETED")), hint: "Every milestone settled" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {stats.map((s) => (
        <Card key={s.label} className="p-4 sm:p-5">
          <dt className="text-sm font-medium text-slate-500">{s.label}</dt>
          <dd className="mt-2 truncate font-mono text-xl font-semibold tracking-tight sm:text-2xl">{s.value}</dd>
          <dd className="mt-1 text-xs text-slate-400">{s.hint}</dd>
        </Card>
      ))}
    </dl>
  );
}

function ContractTable({ items, viewerId }: { items: Contract[]; viewerId: string }) {
  return (
    <div role="table" aria-label="Contracts">
      <div role="row" className="hidden grid-cols-[minmax(0,1fr)_12rem_7rem_8rem_9rem_1.5rem] gap-4 bg-slate-50 px-5 py-2.5 text-xs font-semibold tracking-wide text-slate-500 uppercase md:grid">
        <span role="columnheader">Contract</span>
        <span role="columnheader">Counterparty</span>
        <span role="columnheader">Your role</span>
        <span role="columnheader" className="text-right">
          Total
        </span>
        <span role="columnheader">Status</span>
        <span />
      </div>
      <div className="divide-y divide-slate-100">
        {items.map((c) => {
          const turn = myStep(c, viewerId);
          return (
          <Link
            key={c.id}
            role="row"
            href={`/contracts/${c.id}`}
            className={cn("group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-4 transition-colors", turn !== null && "border-l-4", turn !== null && (turn.urgent ? "border-l-red-700" : "border-l-orange-600"), " hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none md:grid-cols-[minmax(0,1fr)_12rem_7rem_8rem_9rem_1.5rem]")}
          >
            <span role="cell" className="min-w-0">
              <span className="block truncate font-semibold group-hover:text-primary">{c.title}</span>
              {turn === null ? (
                <span className="block truncate text-xs text-slate-500">{turnOfOthers(c)}</span>
              ) : (
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  <YourTurn label={turn.label} urgent={turn.urgent} />
                  {turn.deadline !== null && (
                    <span className="text-xs font-medium text-slate-600">
                      {turn.urgent ? <>Ends in <Countdown until={turn.deadline} /></> : `Due ${relativeDays(turn.deadline.slice(0, 10))}`}
                    </span>
                  )}
                </span>
              )}
            </span>
            <span role="cell" className="hidden truncate text-sm text-slate-600 md:block">
              {c.counterpartyName ?? <span className="text-slate-400">{c.myRole === "BUYER" ? "Not invited yet" : "Unknown"}</span>}
            </span>
            <span role="cell" className="hidden text-sm text-slate-600 md:block">
              {PARTY_ROLE_LABEL[c.myRole]}
            </span>
            <span role="cell" className="text-right font-mono text-sm font-semibold">
              {formatMoney(c.total)}
            </span>
            <span role="cell" className="md:col-auto">
              <ContractStatus status={contractOverview(c)} />
            </span>
            <ChevronRight className="hidden size-4 text-slate-300 group-hover:text-slate-500 md:block" aria-hidden />
          </Link>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState({ isBuyer, filtered }: { isBuyer: boolean; filtered: boolean }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-primary">
        <FileText className="size-6" aria-hidden />
      </div>
      <h2 className="mt-4 font-semibold">{filtered ? "No contracts in this view" : "No contracts yet"}</h2>
      <p className="mt-1 max-w-sm text-sm text-slate-500">
        {isBuyer ? "Create a contract, split it into milestones, and invite your seller." : "When a buyer invites you, the contract appears here."}
      </p>
      {isBuyer && !filtered && (
        <Link href="/contracts/new" className={cn(buttonVariants({ variant: "primary" }), "mt-5")}>
          <Plus aria-hidden /> New contract
        </Link>
      )}
    </div>
  );
}
