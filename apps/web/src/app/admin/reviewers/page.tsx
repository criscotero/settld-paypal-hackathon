import { CheckCircle2, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { decideApplication } from "@/app/reviewer-actions";
import { ActionForm } from "@/components/action-form";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import type { Schemas } from "@/lib/api-types";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Reviewer applications" };

type State = Schemas["ReviewerApplicationState"];
const STATES: readonly State[] = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED"];
const LABEL: Record<State, string> = { PENDING: "Pending", APPROVED: "Approved", REJECTED: "Rejected", SUSPENDED: "Suspended" };

// What can be decided from each status. Core API enforces it; this only hides what would be refused.
const OPTIONS: Record<State, { value: string; label: string }[]> = {
  PENDING: [{ value: "APPROVE", label: "Approve: gives them the reviewer role" }, { value: "REJECT", label: "Reject: they can apply again in 30 days" }],
  APPROVED: [{ value: "SUSPEND", label: "Suspend: removes the reviewer role at once" }],
  REJECTED: [],
  SUSPENDED: [{ value: "REACTIVATE", label: "Reactivate: gives the reviewer role back" }],
};

// The only door to the reviewer role (ADR-0015). A reviewer's ruling moves money, so this is where a
// person earns that trust. For anyone but an administrator, the page does not exist.
export default async function ReviewerApplicationsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: raw } = await searchParams;
  const status = STATES.find((s) => s === raw) ?? "PENDING";
  const me = await requireOnboardedMe("/admin/reviewers");
  const result = await (await api()).GET("/reviewer-applications", { params: { query: { status } } });
  if (result.response.status === 403) notFound();
  const { items } = dataOrThrow(result);
  return (
    <div className="space-y-6">
      <PageHeader title="Reviewer applications" description="Approving lets this person rule on disputes that move money. Each decision needs a written reason, and they can read it." />
      <nav aria-label="Filter by status" className="inline-flex rounded-lg bg-slate-100 p-1">
        {STATES.map((s) => (
          <Link key={s} href={`/admin/reviewers?status=${s}`} aria-current={s === status ? "page" : undefined} className={cn("rounded-md px-3 py-1.5 text-sm font-medium", s === status ? "bg-white text-ink shadow-sm" : "text-slate-600 hover:text-ink")}>
            {LABEL[s]}
          </Link>
        ))}
      </nav>
      {items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500">Nothing here.</Card>
      ) : (
        <ul className="space-y-4">
          {items.map((a) => (
            <li key={a.id}>
              <Card className="space-y-3 p-5 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="font-semibold">{a.displayName}</p>
                    <p className="text-slate-500">
                      {a.email} · applied {formatDate(a.createdAt.slice(0, 10))}
                    </p>
                  </div>
                  <Badge tone={a.status === "APPROVED" ? "good" : a.status === "PENDING" ? "warn" : "bad"}>{LABEL[a.status]}</Badge>
                </div>
                <p className={cn("flex items-center gap-1.5", a.paypalReady ? "text-emerald-700" : "text-amber-800")}>
                  {a.paypalReady ? <CheckCircle2 className="size-4" aria-hidden /> : <TriangleAlert className="size-4" aria-hidden />}
                  {a.paypalReady ? "PayPal can pay them." : "PayPal cannot pay them yet."}
                </p>
                {a.motivation != null && (
                  <div>
                    <p className="text-xs font-medium text-slate-500">Written by the applicant</p>
                    <p className="break-words whitespace-pre-line">{a.motivation}</p>
                  </div>
                )}
                {a.decisionReason != null && <p className="break-words whitespace-pre-line text-slate-600">Last decision: {a.decisionReason}</p>}
                {a.userId === me.id ? (
                  <p className="text-slate-500">This is your own application: another administrator has to decide it.</p>
                ) : (
                  OPTIONS[a.status].length > 0 && (
                    <ActionForm action={decideApplication} submitLabel="Record the decision" variant="primary">
                      <input type="hidden" name="applicationId" value={a.id} />
                      <fieldset className="space-y-1.5">
                        <legend className="sr-only">Decision</legend>
                        {OPTIONS[a.status].map((o) => (
                          <label key={o.value} className="flex items-start gap-2">
                            <input type="radio" name="decision" value={o.value} required className="mt-1" /> {o.label}
                          </label>
                        ))}
                      </fieldset>
                      <Textarea name="reason" required minLength={10} maxLength={2000} placeholder="At least 10 characters. They can read this." className="mt-2 min-h-14" />
                    </ActionForm>
                  )
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
