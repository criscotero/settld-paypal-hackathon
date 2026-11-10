"use server";
// Reviewer applications (ADR-0015). One Core API call each, no rules here: Core API decides who may
// apply and who may decide.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import { field, isFailure } from "@/lib/form";
import { toActionError } from "@/lib/problem";
import type { ActionResult } from "@/lib/problem";
import { reach } from "@/lib/reach";

// From the onboarding wizard, which is not a form of its own for this. Applying twice is a no-op.
export async function applyDuringOnboarding(): Promise<ActionResult> {
  const client = await api();
  const r = await reach(() => client.POST("/me/reviewer-application", { params: { header: { "Idempotency-Key": randomUUID() } }, body: {} }));
  if (isFailure(r)) return r;
  return r.data === undefined ? toActionError(r.error) : null;
}

export async function applyAsReviewer(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const motivation = fd.get("motivation");
  const client = await api();
  const r = await reach(() => client.POST("/me/reviewer-application", { params: { header: { "Idempotency-Key": field(fd, "idempotencyKey") } }, body: typeof motivation === "string" && motivation !== "" ? { motivation } : {} }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath("/profile");
  return null;
}

const DECISIONS = ["APPROVE", "REJECT", "SUSPEND", "REACTIVATE"] as const;

export async function decideApplication(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const decision = DECISIONS.find((d) => d === fd.get("decision"));
  if (decision === undefined) throw new Error("Missing decision");
  const client = await api();
  const r = await reach(() =>
    client.POST("/reviewer-applications/{applicationId}:decide", { params: { path: { applicationId: field(fd, "applicationId") }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } }, body: { decision, reason: field(fd, "reason") } }),
  );
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath("/admin/reviewers");
  return null;
}
