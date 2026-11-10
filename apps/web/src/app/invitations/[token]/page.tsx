import { CheckCircle2, Handshake, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import { acceptInvitation } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Card } from "@/components/ui/card";
import { requireOnboardedMe } from "@/lib/api";

export const metadata: Metadata = { title: "Invitation" };

export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const me = await requireOnboardedMe(`/invitations/${token}`);
  return (
    <Card className="mx-auto max-w-lg p-8">
      <div className="flex size-12 items-center justify-center rounded-full bg-accent-soft text-primary">
        <Handshake className="size-6" aria-hidden />
      </div>
      <h1 className="mt-4 text-xl font-semibold">You were invited to a contract</h1>
      <p className="mt-1 text-sm text-slate-500">Accepting makes you, {me.displayName}, the seller on it. You will review and approve the terms next.</p>
      <div className={`mt-5 flex items-start gap-3 rounded-lg p-3 text-sm ${me.paypalReady ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
        {me.paypalReady ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
        {me.paypalReady ? "Your PayPal account can receive payments." : "Connect a PayPal account that can receive payments first; Core API will refuse otherwise."}
      </div>
      {/* acceptInvitation has no Idempotency-Key in the contract: Core API treats a repeat
          by the same seller as a no-op. ActionForm's key is simply not sent. */}
      <ActionForm action={acceptInvitation} submitLabel="Accept invitation" variant="primary" className="mt-2">
        <input type="hidden" name="token" value={decodeURIComponent(token)} />
      </ActionForm>
    </Card>
  );
}
