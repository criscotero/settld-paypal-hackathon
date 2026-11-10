import { randomUUID, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { api } from "@/lib/api";
import { donePath } from "@/lib/paypal-return";
import { publicUrl } from "@/lib/public-url";
import type { PaypalOutcome } from "@/lib/paypal-return";
import { PAYPAL_STATE_COOKIE } from "@/lib/paypal-state";

function equal(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// Where Log in with PayPal sends the buyer back (?code=…&state=…). The code is handed to
// Core API, which exchanges it with PayPal; this route never talks to PayPal itself (SB-2).
// It runs in the tab the wizard opened for PayPal, so it ends on the page that reports back.
export async function GET(req: NextRequest) {
  const back = (outcome: PaypalOutcome) => NextResponse.redirect(publicUrl(req, donePath(outcome)));
  const jar = await cookies();
  const expected = jar.get(PAYPAL_STATE_COOKIE)?.value;
  jar.delete({ name: PAYPAL_STATE_COOKIE, path: "/onboarding" });

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state") ?? "";
  if (code === null) return back("cancelled");
  // A missing or different state means this redirect did not start in this browser.
  if (expected === undefined || !equal(state, expected)) return back("state-mismatch");

  const client = await api();
  const r = await client.POST("/me/connections/paypal-login:complete", { params: { header: { "Idempotency-Key": randomUUID() } }, body: { code } });
  if (r.data === undefined) return back("link-failed");
  return back(r.data.onboarding.completed ? "done" : "linked");
}
