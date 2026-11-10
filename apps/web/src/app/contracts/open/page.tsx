import { ChevronRight, FolderOpen, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { openProjectsHref, parseOpenProjectsCursor } from "@/lib/open-project";

export const metadata: Metadata = { title: "Open projects" };

// ADR-0018. Core API decides what is listed; the page only shows it.
export default async function OpenProjectsPage({ searchParams }: { searchParams: Promise<{ cursor?: string | string[] }> }) {
  const cursor = parseOpenProjectsCursor((await searchParams).cursor);
  const me = await requireOnboardedMe("/contracts/open");
  const { items, nextCursor } = dataOrThrow(await (await api()).GET("/open-projects", { params: { query: { cursor } } }));
  const isBuyer = me.roles.includes("BUYER");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Open projects"
        description="Work buyers published with a price and clear criteria. The first seller who accepts the terms gets the project."
        actions={
          isBuyer && (
            <Link href="/contracts/new" className={buttonVariants({ variant: "primary" })}>
              <Plus aria-hidden /> New contract
            </Link>
          )
        }
      />

      {items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <FolderOpen className="size-6 text-slate-400" aria-hidden />
          <p className="text-sm text-slate-600">{nextCursor === null && cursor === undefined ? "No projects are open right now." : "Nothing to show on this page."}</p>
          {cursor !== undefined && (
            <Link href="/contracts/open" className={buttonVariants({ variant: "outline" })}>
              Back to the first page
            </Link>
          )}
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-slate-100">
            {items.map((p) => (
              <li key={p.contractId}>
                <Link href={`/contracts/open/${p.contractId}`} className="group flex items-center gap-4 px-5 py-4 transition-colors hover:bg-slate-50">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 font-medium">
                      <span className="truncate">{p.title}</span>
                      {p.isMine && <Badge>Yours</Badge>}
                    </p>
                    <p className="truncate text-sm text-slate-500">
                      {p.buyerName} · {p.milestoneCount} milestone{p.milestoneCount === 1 ? "" : "s"}
                    </p>
                    <p className="text-xs text-slate-500">Open until {formatDate(p.publishedUntil.slice(0, 10))}</p>
                  </div>
                  <span className="font-mono text-sm font-semibold">{formatMoney(p.total)}</span>
                  <ChevronRight className="size-4 text-slate-300 group-hover:text-slate-500" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {nextCursor !== null && (
        <div className="flex justify-center">
          <Link href={openProjectsHref(nextCursor)} className={buttonVariants({ variant: "outline" })}>
            Next page <ChevronRight aria-hidden />
          </Link>
        </div>
      )}
    </div>
  );
}
