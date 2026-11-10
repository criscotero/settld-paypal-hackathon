import { CheckCircle2, Handshake, MailOpen, TriangleAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { acceptMyInvitation, openInvitation } from "@/app/actions";
import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { api, dataOrThrow, requireOnboardedMe } from "@/lib/api";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Invitations" };

// The seller's invitations (listMyInvitations): the ones sent to the email they signed up
// with, accepted right here. The mail links to this list (ADR-0013). The link form stays for an
// invitation sent to another address.
export default async function InvitationsPage() {
  const me = await requireOnboardedMe("/invitations");
  const { items } = dataOrThrow(await (await api()).GET("/me/invitations"));
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <header>
        <h1 className="text-2xl font-bold text-navy">Invitations</h1>
        <p className="mt-1 text-sm text-slate-500">Contracts that buyers invited you to as the seller, sent to {me.email}.</p>
      </header>

      <div className={`flex items-start gap-3 rounded-lg p-3 text-sm ${me.paypalReady ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`}>
        {me.paypalReady ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
        {me.paypalReady ? "Your PayPal account can receive payments." : "Connect a PayPal account that can receive payments before accepting; Settld will refuse otherwise."}
      </div>

      {items.length === 0 ? (
        <Card className="p-8 text-center text-sm text-slate-500">No invitations waiting for you.</Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((inv) => (
            <li key={inv.id}>
              <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-primary">
                  <Handshake className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-semibold text-ink">
                    <Link href={`/invitations/pending/${inv.id}`} className="hover:underline">
                      {inv.contractTitle}
                    </Link>
                  </h2>
                  <p className="text-sm text-slate-600">
                    {inv.buyerName} · {formatMoney(inv.total)} · invited {formatDate(inv.invitedAt.slice(0, 10))}
                  </p>
                  <Link href={`/invitations/pending/${inv.id}`} className="text-xs font-semibold text-primary underline">
                    See milestones and criteria
                  </Link>
                </div>
                <ActionForm action={acceptMyInvitation} submitLabel="Accept" variant="primary" className="shrink-0 [&>button]:mt-0">
                  <input type="hidden" name="invitationId" value={inv.id} />
                </ActionForm>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <details className="rounded-lg border border-slate-200 bg-white p-4 text-sm">
        <summary className="flex cursor-pointer items-center gap-2 font-medium text-slate-700">
          <MailOpen className="size-4" aria-hidden /> Have an invitation link instead?
        </summary>
        <form action={openInvitation} className="mt-4 space-y-2">
          <Label htmlFor="token">Invitation link</Label>
          <div className="flex gap-2">
            <Input id="token" name="token" required placeholder="https://…/invitations/…" />
            <Button type="submit" variant="primary">
              Open
            </Button>
          </div>
        </form>
      </details>
    </div>
  );
}
