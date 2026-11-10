// A person's way to become a reviewer, on their profile. "Settler" is the word people see; the
// contract's word stays REVIEWER (ADR-0015). This card asks and reports: Core API grants nothing here.
import { applyAsReviewer } from "@/app/reviewer-actions";
import { ActionForm } from "@/components/action-form";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Label, Textarea } from "@/components/ui/input";
import type { Schemas } from "@/lib/api-types";
import { formatDate } from "@/lib/dates";
import { SETTLER_BODY, SETTLER_NOTE, SETTLER_TITLE } from "./reviewer-copy";

const STATUS: Record<Schemas["ReviewerApplicationState"], { label: string; tone: "neutral" | "good" | "bad" | "warn"; text: string }> = {
  PENDING: { label: "Pending", tone: "warn", text: "Settld is reviewing your application. You have no reviewer permissions until it is approved." },
  APPROVED: { label: "Approved", tone: "good", text: "You are a Settler. To be paid for a review you need PayPal connected." },
  REJECTED: { label: "Rejected", tone: "bad", text: "Your application was not approved." },
  SUSPENDED: { label: "Suspended", tone: "bad", text: "You cannot review cases while your account is suspended. Contact Settld." },
};

export function ReviewerApplicationCard({ application, hasRole }: { application: Schemas["ReviewerApplicationStatus"] | null | undefined; hasRole: boolean }) {
  const againAt = application?.canApplyAgainAt ?? null;
  const canApply = !hasRole && (application == null || (application.status === "REJECTED" && againAt !== null && new Date(againAt).getTime() <= Date.now()));
  const status = application == null ? null : STATUS[application.status];
  return (
    <Card className="space-y-3 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{SETTLER_TITLE}</h2>
        {status !== null && <Badge tone={status.tone}>{status.label}</Badge>}
      </div>
      <p className="text-sm text-slate-600">{SETTLER_BODY}</p>
      {status !== null && <p className="text-sm font-medium">{status.text}</p>}
      {application?.decisionReason != null && <p className="text-sm break-words whitespace-pre-line text-slate-600">Reason: {application.decisionReason}</p>}
      {againAt !== null && !canApply && <p className="text-sm text-slate-500">You can apply again from {formatDate(againAt.slice(0, 10))}.</p>}
      {hasRole && application == null && <p className="text-sm font-medium">Settld made you a reviewer directly.</p>}
      {canApply && (
        <ActionForm action={applyAsReviewer} submitLabel="Apply to be a Settler" variant="primary">
          <p className="text-sm text-slate-500">{SETTLER_NOTE}</p>
          <Label htmlFor="motivation" className="mt-3 block">
            Why you (optional)
          </Label>
          <Textarea id="motivation" name="motivation" maxLength={1000} className="mt-1.5 min-h-14" />
        </ActionForm>
      )}
    </Card>
  );
}
