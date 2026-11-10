"use server";
// Onboarding writes (ADR-0006). Like app/actions.ts: one Core API call each, no domain rules,
// so nothing here can disagree with Core API about what "onboarded" means.
import { randomBytes, randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { api } from "@/lib/api";
import type { Schemas } from "@/lib/api-types";
import { sellerOutcome } from "@/lib/paypal-return";
import type { PaypalOutcome } from "@/lib/paypal-return";
import { PAYPAL_STATE_COOKIE } from "@/lib/paypal-state";
import { toActionError } from "@/lib/problem";
import type { ActionError, ActionResult } from "@/lib/problem";
import { reach } from "@/lib/reach";

type LinkResult = { url: string } | ActionError;

export async function saveRoles(roles: ("BUYER" | "SELLER" | "COLLABORATOR")[]): Promise<ActionResult> {
  const client = await api();
  const r = await reach(() => client.PUT("/me/roles", { body: { roles } }));
  if ("code" in r) return r;
  if (r.error !== undefined) return toActionError(r.error);
  revalidatePath("/onboarding");
  return null;
}

export async function saveProfile(profile: Schemas["ProfileInput"]): Promise<ActionResult> {
  const client = await api();
  const r = await reach(() => client.PUT("/me/profile", { body: profile }));
  if ("code" in r) return r;
  if (r.error !== undefined) return toActionError(r.error);
  revalidatePath("/onboarding");
  return null;
}

// ADR-0009: what a seller or collaborator does, and whether they appear in the directory.
export async function saveProfessional(profile: Schemas["ProfessionalProfile"]): Promise<ActionResult> {
  const client = await api();
  const r = await reach(() => client.PUT("/me/professional-profile", { body: profile }));
  if ("code" in r) return r;
  if (r.error !== undefined) return toActionError(r.error);
  revalidatePath("/onboarding");
  revalidatePath("/profile");
  return null;
}

// Seller: PayPal partner onboarding. PayPal opens in its own tab and comes back to
// /onboarding/paypal/seller-return there.
export async function startSellerConnect(idempotencyKey: string): Promise<LinkResult> {
  const client = await api();
  const r = await reach(() => client.POST("/me/connections/paypal:onboard", { params: { header: { "Idempotency-Key": idempotencyKey } } }));
  if ("code" in r) return r;
  return r.data ?? toActionError(r.error);
}

// Asks Core API whether PayPal finished the seller's onboarding. The return route calls it, and
// so does the wizard's "check again": PayPal's sandbox does not always send the browser back
// (it can stop on its own "return to Settld" page), and the seller must not be stuck then.
// Safe to repeat: Core API asks PayPal by tracking id every time.
export async function checkSellerConnect(): Promise<PaypalOutcome> {
  const client = await api();
  const r = await reach(() => client.POST("/me/connections/paypal:onboard-complete", { params: { header: { "Idempotency-Key": randomUUID() } } }));
  if ("code" in r) return "link-failed";
  if (r.data !== undefined) revalidatePath("/onboarding");
  return sellerOutcome(r.response.status, r.data);
}

// Buyer: Log in with PayPal. `state` ties PayPal's redirect back to this browser: the callback
// refuses a code whose state does not match the cookie, so nobody can link their own PayPal
// account to your Settld user by sending you a crafted link (login CSRF).
export async function startBuyerLink(): Promise<LinkResult> {
  const state = randomBytes(24).toString("base64url");
  (await cookies()).set(PAYPAL_STATE_COOKIE, state, {
    httpOnly: true,
    // Lax, not Strict: PayPal's redirect back is a top-level navigation from another site,
    // and Strict would drop the cookie exactly then.
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/onboarding",
    maxAge: 600,
  });
  const client = await api();
  const r = await reach(() => client.POST("/me/connections/paypal-login:start", { body: { state } }));
  if ("code" in r) return r;
  return r.data ?? toActionError(r.error);
}
