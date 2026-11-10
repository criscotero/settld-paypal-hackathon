"use server";
// Milestone writes (002, ADR-0007). Same rule as actions.ts: one Core API call each, no domain
// rules here. Core API decides; the form only shows its answer.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import { field, isFailure, strings } from "@/lib/form";
import { toActionError } from "@/lib/problem";
import { reach } from "@/lib/reach";
import type { ActionError, ActionResult } from "@/lib/problem";




// Every form posts its contract and milestone ids, its key, and the stateVersion it was
// rendered with (If-Match): a decision made on an outdated screen gets STALE_STATE.
function common(fd: FormData) {
  return { contractId: field(fd, "contractId"), milestoneId: field(fd, "milestoneId"), key: field(fd, "idempotencyKey"), ifMatch: field(fd, "stateVersion") };
}

function done(r: { data?: unknown; error?: unknown } | ActionError, contractId: string): ActionResult {
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath(`/contracts/${contractId}`);
  return null;
}

// The buyer leaves for PayPal to approve the hold; PayPal brings them back to
// /milestones/{id}/paypal-return, which confirms the funding.
export async function fundMilestone(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { milestoneId, key } = common(fd);
  const client = await api();
  const r = await reach(() => client.POST("/milestones/{milestoneId}/fund", { params: { path: { milestoneId }, header: { "Idempotency-Key": key } } }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  redirect(r.data.approveUrl);
}

export async function startWork(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, milestoneId, key, ifMatch } = common(fd);
  const client = await api();
  return done(await reach(() => client.POST("/milestones/{milestoneId}:start", { params: { path: { milestoneId }, header: { "Idempotency-Key": key, "If-Match": ifMatch } } })), contractId);
}

type DeliveredLink = { kind: "URL" | "REPOSITORY" | "FILE"; url: string; label?: string; fileHash?: string };

function optional(fd: FormData, name: string): string | null {
  const value = fd.get(name);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

// A delivery can be a link, a public repository and a .zip (ADR-0019, ADR-0020). The one place
// with two Core API calls: the .zip is uploaded first, then named in the delivery by its hash.
// Both are safe to repeat: the same bytes are the same file, and the delivery has its key.
// Through this server, never from the browser: the session token stays here (ADR-0005).
export async function submitDelivery(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, milestoneId, key, ifMatch } = common(fd);
  const notes = fd.get("notes");
  const client = await api();
  const evidenceLinks: DeliveredLink[] = [];
  const url = optional(fd, "url");
  if (url !== null) evidenceLinks.push({ kind: "URL", url });
  const repository = optional(fd, "repository");
  if (repository !== null) evidenceLinks.push({ kind: "REPOSITORY", url: repository });
  const file = fd.get("file");
  if (file instanceof File && file.size > 0) {
    const upload = new FormData();
    upload.append("file", file, file.name);
    const uploaded = await reach(() =>
      client.POST("/milestones/{milestoneId}/delivery-files", {
        params: { path: { milestoneId } },
        body: upload as never,
        bodySerializer: (body: unknown) => body as FormData,
      }),
    );
    if (isFailure(uploaded)) return uploaded;
    if (uploaded.data === undefined) return toActionError(uploaded.error);
    evidenceLinks.push({ kind: "FILE", url: uploaded.data.url, fileHash: uploaded.data.fileHash, label: uploaded.data.name });
  }
  if (evidenceLinks.length === 0) {
    return { code: "VALIDATION_FAILED", message: "Add a link, a repository or a .zip with the work.", issues: [], requestId: null };
  }
  return done(
    await reach(() =>
      client.POST("/milestones/{milestoneId}/submissions", {
        params: { path: { milestoneId }, header: { "Idempotency-Key": key, "If-Match": ifMatch } },
        body: { evidenceLinks, notes: typeof notes === "string" ? notes : "" },
      }),
    ),
    contractId,
  );
}

// The checked boxes are the buyer's approvals of what a check cannot prove (constitution VI).
export async function approveRelease(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, milestoneId, key, ifMatch } = common(fd);
  const humanDecisions = strings(fd, "approve").map((criterionId) => ({ criterionId, decision: "APPROVED" as const }));
  const client = await api();
  return done(
    await reach(() => client.POST("/milestones/{milestoneId}/approve", { params: { path: { milestoneId }, header: { "Idempotency-Key": key, "If-Match": ifMatch } }, body: { humanDecisions } })),
    contractId,
  );
}

export async function raiseObjection(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, milestoneId, key, ifMatch } = common(fd);
  const client = await api();
  return done(
    await reach(() =>
      client.POST("/milestones/{milestoneId}/objections", {
        params: { path: { milestoneId }, header: { "Idempotency-Key": key, "If-Match": ifMatch } },
        body: { criterionIds: strings(fd, "criterionId"), reason: field(fd, "reason") },
      }),
    ),
    contractId,
  );
}

export async function withdrawObjection(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, key } = common(fd);
  const humanDecisions = strings(fd, "approve").map((criterionId) => ({ criterionId, decision: "APPROVED" as const }));
  const client = await api();
  return done(
    await reach(() =>
      client.POST("/objections/{objectionId}:withdraw", { params: { path: { objectionId: field(fd, "objectionId") }, header: { "Idempotency-Key": key } }, body: { humanDecisions } }),
    ),
    contractId,
  );
}

export async function acceptPartial(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, milestoneId, key, ifMatch } = common(fd);
  const client = await api();
  return done(await reach(() => client.POST("/milestones/{milestoneId}:accept-partial", { params: { path: { milestoneId }, header: { "Idempotency-Key": key, "If-Match": ifMatch } } })), contractId);
}

export async function cancelMilestone(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, milestoneId, key, ifMatch } = common(fd);
  const client = await api();
  return done(
    await reach(() =>
      client.POST("/milestones/{milestoneId}:cancel", { params: { path: { milestoneId }, header: { "Idempotency-Key": key, "If-Match": ifMatch } }, body: { reason: field(fd, "reason") } }),
    ),
    contractId,
  );
}

// The seller's side of an objection, for the reviewer (ADR-0014). The buyer can read it too.
export async function contestObjection(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, key } = common(fd);
  const client = await api();
  return done(await reach(() => client.POST("/objections/{objectionId}:contest", { params: { path: { objectionId: field(fd, "objectionId") }, header: { "Idempotency-Key": key } }, body: { reason: field(fd, "reason") } })), contractId);
}

export async function surrenderMilestone(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const { contractId, milestoneId, key, ifMatch } = common(fd);
  const client = await api();
  return done(await reach(() => client.POST("/milestones/{milestoneId}:surrender", { params: { path: { milestoneId }, header: { "Idempotency-Key": key, "If-Match": ifMatch } } })), contractId);
}

export async function ruleOnObjection(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const decision = field(fd, "decision") === "RELEASE" ? "RELEASE" : "VOID";
  const client = await api();
  const r = await reach(() => client.POST("/objections/{objectionId}:rule", { params: { path: { objectionId: field(fd, "objectionId") }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } }, body: { decision, reason: field(fd, "reason") } }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath("/review");
  redirect("/review");
}
