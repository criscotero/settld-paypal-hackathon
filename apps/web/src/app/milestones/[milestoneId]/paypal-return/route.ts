import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { api } from "@/lib/api";
import { publicUrl } from "@/lib/public-url";
import { signInPath } from "@/lib/sign-in-path";

// Where PayPal sends the buyer after approving the hold (?token=<orderId>&PayerID=...).
// The order id is only a hint: Core API authorizes it and checks the authorization against
// the milestone (G-AUTH-MATCHES) before anything counts as funded.
export async function GET(req: NextRequest, { params }: { params: Promise<{ milestoneId: string }> }) {
  const { milestoneId } = await params;
  const client = await api();
  const milestone = await client.GET("/milestones/{milestoneId}", { params: { path: { milestoneId } } });
  // The session ended during the trip to PayPal. The buyer approved the hold there and nothing
  // confirmed it here: come back to this same URL after signing in, so it still gets confirmed.
  if (milestone.response.status === 401) return NextResponse.redirect(publicUrl(req, signInPath(`${req.nextUrl.pathname}${req.nextUrl.search}`)));
  if (milestone.data === undefined) return NextResponse.redirect(publicUrl(req, "/contracts"));
  const back = (outcome: string) => NextResponse.redirect(publicUrl(req, `/contracts/${milestone.data.contractId}?paypal=${outcome}#milestone-${milestoneId}`));

  const orderId = req.nextUrl.searchParams.get("token");
  if (orderId === null) return back("cancelled");
  // One key per order: a reload of this page confirms the same order again, and Core API
  // replays the first answer instead of authorizing twice.
  const r = await client.POST("/milestones/{milestoneId}/fund:confirm", {
    params: { path: { milestoneId }, header: { "Idempotency-Key": await keyFor(milestoneId, orderId) } },
    body: { paypalOrderId: orderId },
  });
  if (r.data === undefined) return back("fund-failed");
  if (r.data.state !== "APPROVED") return back("funded");

  // ADR-0009: one order per team member. This one is reserved but someone else's is not yet,
  // so the buyer goes straight on to approve the next one. Asking /fund again is safe: Core API
  // replays the same orders. A fresh key, because the answer changes as orders get approved.
  const next = await client.POST("/milestones/{milestoneId}/fund", { params: { path: { milestoneId }, header: { "Idempotency-Key": crypto.randomUUID() } } });
  const pending = next.data?.orders.find((o) => o.holdStatus !== "AUTHORIZED");
  return pending === undefined ? back("fund-failed") : NextResponse.redirect(pending.approveUrl);
}

// A UUID derived from (milestone, order): the same pair always gives the same key.
async function keyFor(milestoneId: string, orderId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`fund-confirm:${milestoneId}:${orderId}`)));
  const hex = [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
