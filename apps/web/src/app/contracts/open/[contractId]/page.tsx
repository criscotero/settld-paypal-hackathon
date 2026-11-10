import { ArrowLeft, CheckCircle2, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { takeContract } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { ContractTermsPreview } from "@/components/contract-terms-preview";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Open project" };

// ADR-0018: the terms a seller accepts by taking the project. Core API answers NOT_FOUND once it is
// taken or withdrawn, so a stale link lands on the not-found page instead of a dead button.
export default async function OpenProjectPage({ params }: { params: Promise<{ contractId: string }> }) {
  const { contractId } = await params;
  const me = await requireOnboardedMe(`/contracts/open/${contractId}`);
  const project = dataOrThrow(await (await api()).GET("/open-projects/{contractId}", { params: { path: { contractId } } }));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href="/contracts/open" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> All open projects
      </Link>

      <header>
        <p className="text-sm font-semibold tracking-wide text-primary uppercase">Published by {project.buyerName}</p>
        <h1 className="mt-1 text-2xl font-bold text-navy">{project.title}</h1>
        {project.description !== "" && <p className="mt-2 text-sm whitespace-pre-line text-slate-600">{project.description}</p>}
        <p className="mt-2 text-xs text-slate-500">Open until {formatDate(project.publishedUntil.slice(0, 10))}</p>
      </header>

      <ContractTermsPreview total={project.total} terms={project.terms} milestones={project.milestones} />

      <Card className="p-5">
        {project.isMine ? (
          <>
            <p className="text-sm text-slate-600">This is your project. A seller has to take it.</p>
            <Link href={`/contracts/${contractId}`} className={`${buttonVariants({ variant: "outline" })} mt-3`}>
              Manage contract
            </Link>
          </>
        ) : !me.roles.includes("SELLER") ? (
          <p className="text-sm text-slate-600">Only accounts with the seller role can take a project.</p>
        ) : (
          <>
            <div className={`flex items-start gap-3 rounded-lg p-3 text-sm ${me.paypalReady ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
              {me.paypalReady ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
              {me.paypalReady ? (
                "Your PayPal account can receive payments."
              ) : (
                <span>
                  Connect a PayPal account that can receive payments before taking a project.{" "}
                  <Link href="/profile" className="underline underline-offset-2">
                    Go to your profile
                  </Link>
                </span>
              )}
            </div>
            <p className="mt-3 text-sm text-slate-600">
              Taking this project makes you the seller and agrees to these exact terms for {formatMoney(project.total)}. No money moves yet: the buyer funds next, and can still cancel before funding. You work alone on this project, because collaborators cannot be added after the agreement.
            </p>
            <ActionForm action={takeContract} submitLabel="Accept terms and take project" variant="primary">
              <input type="hidden" name="contractId" value={project.contractId} />
              <input type="hidden" name="version" value={project.version} />
              <input type="hidden" name="snapshotHash" value={project.snapshotHash} />
              {project.lowVerifiabilityCount > 0 && (
                <label className="mt-2 flex items-start gap-2 text-sm text-amber-900">
                  <input type="checkbox" name="acknowledgeLowVerifiability" required className="mt-1" />
                  {project.lowVerifiabilityCount} milestone(s) depend mostly on human review. I accept that they cannot be verified automatically.
                </label>
              )}
            </ActionForm>
          </>
        )}
      </Card>
    </div>
  );
}
