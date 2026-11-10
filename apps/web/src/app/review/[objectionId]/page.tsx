import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { ruleOnObjection } from "@/app/milestone-actions";
import { ActionForm } from "@/components/action-form";
import { CriterionVerdict } from "@/components/criterion-verdict";
import { LatestDelivery, ObjectionMessages, ObjectionRuling } from "@/components/delivery-card";
import { MoneyBreakdown } from "@/components/milestone-actions";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";
import { formatWeight } from "@/lib/weights";

export const metadata: Metadata = { title: "Review an objection" };

// One decision (constitution XII): release what is held, or return it. Everything both parties wrote
// is shown as text and labeled as theirs: either of them may be trying to influence the reviewer.
export default async function ReviewCasePage({ params }: { params: Promise<{ objectionId: string }> }) {
  const { objectionId } = await params;
  await requireOnboardedMe(`/review/${objectionId}`);
  const client = await api();
  const c = dataOrThrow(await client.GET("/objections/{objectionId}/case", { params: { path: { objectionId } } }));
  const { objection, milestone: m } = c;
  // The run the objection is about. A verifier that is down must not block a ruling.
  const report = await client.GET("/verification-runs/{runId}", { params: { path: { runId: objection.runId } }, signal: AbortSignal.timeout(2_500) }).catch(() => null);
  const results = new Map((report?.data?.results ?? []).map((r) => [r.criterionId, r]));
  const open = objection.status === "ESCALATED";
  const held = m.held ?? { amountMinor: 0, currency: m.amount.currency };
  // PayPal gave it back already. Offering to pay it would only end in a refusal (G-AUTH-ACTIVE).
  const expired = m.holdStatus === "EXPIRED" || (m.authorizationExpiresAt != null && new Date(m.authorizationExpiresAt).getTime() <= Date.now());

  return (
    <div className="space-y-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-sm text-slate-500">
        <Link href="/review" className="hover:text-ink">
          Objections to review
        </Link>
        <ChevronRight className="size-4 text-slate-300" aria-hidden />
        <span className="truncate font-medium text-ink" aria-current="page">
          {m.title}
        </span>
      </nav>

      <header>
        <h1 className="text-2xl font-bold tracking-tight">{m.title}</h1>
        <p className="text-sm text-slate-500">
          {c.contractTitle} · buyer {c.buyerName}, seller {c.sellerName} · {formatMoney(m.amount)}
        </p>
      </header>

      <MoneyBreakdown m={m} />
      <ObjectionRuling objection={objection} />

      <Card className="space-y-3 p-5 text-sm">
        <h2 className="font-semibold">The buyer&apos;s objection · {formatDate(objection.raisedAt.slice(0, 10))}</h2>
        <p className="break-words whitespace-pre-line">{objection.reason}</p>
        <ObjectionMessages objection={objection} />
        {objection.contestedAt == null && <p className="text-slate-500">The seller did not answer.</p>}
      </Card>

      {c.submissions.map((s) => (
        <LatestDelivery key={s.id} delivery={s} />
      ))}
      {report?.data === undefined && <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-600">The verification report is not available right now.</p>}

      <Card className="space-y-3 p-5 text-sm">
        <h2 className="font-semibold">What was agreed, and what the checks said</h2>
        <ul className="space-y-3">
          {(m.criteria ?? []).map((criterion) => {
            const result = results.get(criterion.id);
            return (
              <li key={criterion.id}>
                {criterion.text}
                <span className="text-slate-400"> · {formatWeight(criterion.weightBps)}%{criterion.required ? ", required" : ", optional"}{objection.criterionIds.includes(criterion.id) ? ", objected" : ""}</span>
                {result !== undefined && <CriterionVerdict result={result} />}
              </li>
            );
          })}
        </ul>
      </Card>

      {open && (
        <Card className="p-5">
          <h2 className="font-semibold">Your ruling</h2>
          <p className="mt-1 text-sm text-slate-600">It cannot be undone. {expired ? `The PayPal reservation expired, so ${formatMoney(held)} can no longer be paid: returning is the only ruling left.` : `${formatMoney(held)} is still reserved.`}</p>
          <ActionForm action={ruleOnObjection} submitLabel="Record the ruling" variant="primary">
            <input type="hidden" name="objectionId" value={objection.id} />
            <fieldset className="mt-3 space-y-2 text-sm">
              <legend className="sr-only">Decision</legend>
              {!expired && (
                <label className="flex items-start gap-2">
                  <input type="radio" name="decision" value="RELEASE" required className="mt-1" /> Pay {formatMoney(held)} to the seller
                </label>
              )}
              <label className="flex items-start gap-2">
                <input type="radio" name="decision" value="VOID" required className="mt-1" /> Return {formatMoney(held)} to the buyer
              </label>
            </fieldset>
            <Textarea name="reason" required minLength={20} maxLength={5000} placeholder="At least 20 characters. Both parties will read this." className="mt-3 min-h-20" />
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
