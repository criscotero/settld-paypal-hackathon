import { ArrowLeft, CheckCircle2, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { acceptMyInvitation } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { ContractTermsPreview } from "@/components/contract-terms-preview";
import { Card } from "@/components/ui/card";
import { api, requireOnboardedMe } from "@/lib/api";
import { formatDate } from "@/lib/dates";

export const metadata: Metadata = { title: "Invitation" };

// getMyInvitation: the contract an invited seller would join, read before accepting. Read-only
// on purpose; the seller changes terms by accepting and editing the draft with the buyer. Core
// API answers NOT_FOUND for anything but the caller's own pending invitation.
export default async function InvitationPreviewPage({ params }: { params: Promise<{ invitationId: string }> }) {
  const { invitationId } = await params;
  const me = await requireOnboardedMe(`/invitations/pending/${invitationId}`);
  const { data: inv } = await (await api()).GET("/me/invitations/{invitationId}", { params: { path: { invitationId } } });
  if (inv === undefined) notFound();
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <Link href="/invitations" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-ink">
        <ArrowLeft className="size-4" aria-hidden /> All invitations
      </Link>

      <header>
        <p className="text-sm font-semibold tracking-wide text-primary uppercase">Invitation from {inv.buyerName}</p>
        <h1 className="mt-1 text-2xl font-bold text-navy">{inv.contractTitle}</h1>
        {inv.description !== "" && <p className="mt-2 text-sm whitespace-pre-line text-slate-600">{inv.description}</p>}
        <p className="mt-2 text-xs text-slate-500">
          Invited {formatDate(inv.invitedAt.slice(0, 10))} · expires {formatDate(inv.expiresAt.slice(0, 10))}
        </p>
      </header>

      <ContractTermsPreview total={inv.total} terms={inv.terms} milestones={inv.milestones} />

      <Card className="p-5">
        <div className={`flex items-start gap-3 rounded-lg p-3 text-sm ${me.paypalReady ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
          {me.paypalReady ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
          {me.paypalReady ? "Your PayPal account can receive payments." : "Connect a PayPal account that can receive payments before accepting."}
        </div>
        <p className="mt-3 text-sm text-slate-600">Accepting makes you the seller. Nothing is binding yet: you add your team and approve the terms next, and the buyer approves too.</p>
        <ActionForm action={acceptMyInvitation} submitLabel="Accept invitation" variant="primary">
          <input type="hidden" name="invitationId" value={inv.id} />
        </ActionForm>
      </Card>
    </div>
  );
}
