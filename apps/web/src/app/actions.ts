"use server";
// Every write goes through here (ADR-0005). Each action does one Core API call and
// nothing else: no domain rules, so there is nothing here that can disagree with
// Core API. On success it redirects or revalidates; on a problem it returns it.
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import type { CriteriaSuggestion, DraftInput } from "@/lib/api-types";
import { field, isFailure } from "@/lib/form";
import { toActionError } from "@/lib/problem";
import { reach } from "@/lib/reach";
import type { ActionError, ActionResult } from "@/lib/problem";



// Called from DraftForm with a typed object rather than FormData: a nested draft
// (milestones with criteria) does not fit flat form fields.
// Returns the id instead of redirecting: New contract may still send the invitation, as a second
// action, before it navigates. Each action stays one Core API call (ADR-0005).
export async function createContract(idempotencyKey: string, draft: DraftInput): Promise<{ id: string } | ActionError> {
  const client = await api();
  const r = await reach(() => client.POST("/contracts", { params: { header: { "Idempotency-Key": idempotencyKey } }, body: draft }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  return { id: r.data.id };
}

// The invitation New contract sends right after creating the draft. Typed, not FormData, and it
// does not redirect: the form decides where to go, also when this fails, because by then the
// contract exists and the buyer must land on it rather than lose it.
export async function sendInvitation(contractId: string, email: string, idempotencyKey: string): Promise<ActionError | null> {
  const client = await api();
  const r = await reach(() => client.POST("/contracts/{contractId}/invitations", { params: { path: { contractId }, header: { "Idempotency-Key": idempotencyKey } }, body: { email } }));
  if (isFailure(r)) return r;
  // 202 has no body, so success is read from the status, not from data.
  if (!r.response.ok) return toActionError(r.error);
  return null;
}

// Nothing is saved: what comes back only fills the form, and the person decides (ADR-0016).
export async function suggestCriteria(input: { title: string; description: string; contractTitle: string }): Promise<{ ok: true; suggestion: CriteriaSuggestion } | { ok: false; error: ActionError }> {
  const client = await api();
  const r = await reach(() =>
    client.POST("/ai/criteria:suggest", { body: { title: input.title, description: input.description, locale: "en", ...(input.contractTitle === "" ? {} : { contractTitle: input.contractTitle }) } }),
  );
  if (isFailure(r)) return { ok: false, error: r };
  if (r.data === undefined) return { ok: false, error: toActionError(r.error) };
  return { ok: true, suggestion: r.data };
}

export async function replaceDraft(contractId: string, ifMatchVersion: number, draft: DraftInput): Promise<ActionResult> {
  const client = await api();
  // If-Match is the version this form was rendered from, not "the latest": if the
  // version moved on (PENDING_APPROVAL edited into N+1), Core API answers STALE_STATE.
  // It does NOT catch two saves of the same DRAFT, whose number never changes: the
  // last save wins (ADR-0005, gap UI-G1, owner to decide).
  const r = await reach(() =>
    client.PUT("/contracts/{contractId}/draft", { params: { path: { contractId }, header: { "If-Match": String(ifMatchVersion) } }, body: draft }),
  );
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  redirect(`/contracts/${contractId}`);
}

export async function submitDraft(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const contractId = field(fd, "contractId");
  const client = await api();
  const r = await reach(() =>
    client.POST("/contracts/{contractId}/draft:submit", { params: { path: { contractId }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } } }),
  );
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath(`/contracts/${contractId}`);
  return null;
}

export async function inviteSeller(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const contractId = field(fd, "contractId");
  const client = await api();
  const r = await reach(() =>
    client.POST("/contracts/{contractId}/invitations", {
      params: { path: { contractId }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } },
      body: { email: field(fd, "email") },
    }),
  );
  if (isFailure(r)) return r;
  // 202 has no body, so success is read from the status, not from data.
  if (!r.response.ok) return toActionError(r.error);
  redirect(`/contracts/${contractId}?invited=1`);
}

export async function approveVersion(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const contractId = field(fd, "contractId");
  const client = await api();
  const r = await reach(() =>
    client.POST("/contracts/{contractId}/versions/{version}:approve", {
      params: { path: { contractId, version: Number(field(fd, "version")) }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } },
      // The hash that was on screen, never one fetched now: approving "whatever is
      // current" would let a last-second edit be approved unseen (DM-INV-2).
      body: { snapshotHash: field(fd, "snapshotHash"), acknowledgeLowVerifiability: fd.get("acknowledgeLowVerifiability") === "on" },
    }),
  );
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath(`/contracts/${contractId}`);
  return null;
}

// ADR-0018. The version that was on screen, so a publish cannot list something the buyer did not see.
export async function publishContract(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const contractId = field(fd, "contractId");
  const client = await api();
  const r = await reach(() =>
    client.POST("/contracts/{contractId}:publish", {
      params: { path: { contractId }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } },
      body: { version: Number(field(fd, "version")), acknowledgeLowVerifiability: fd.get("acknowledgeLowVerifiability") === "on" },
    }),
  );
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath(`/contracts/${contractId}`);
  return null;
}

export async function unpublishContract(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const contractId = field(fd, "contractId");
  const client = await api();
  const r = await reach(() => client.POST("/contracts/{contractId}:unpublish", { params: { path: { contractId }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } } }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath(`/contracts/${contractId}`);
  return null;
}

export async function takeContract(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const contractId = field(fd, "contractId");
  const client = await api();
  const r = await reach(() =>
    client.POST("/contracts/{contractId}:take", {
      params: { path: { contractId }, header: { "Idempotency-Key": field(fd, "idempotencyKey") } },
      // The hash that was on screen, never one fetched now (DM-INV-2).
      body: { version: Number(field(fd, "version")), snapshotHash: field(fd, "snapshotHash"), acknowledgeLowVerifiability: fd.get("acknowledgeLowVerifiability") === "on" },
    }),
  );
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  redirect(`/contracts/${r.data.id}?taken=1`);
}

export async function acceptInvitation(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const client = await api();
  const r = await reach(() => client.POST("/invitations/{token}:accept", { params: { path: { token: field(fd, "token") } } }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  redirect(`/contracts/${r.data.id}`);
}

// acceptMyInvitation: one of the seller's own invitations, proven by their verified email.
// Like acceptInvitation, no Idempotency-Key: a repeat by the same seller is a no-op.
export async function acceptMyInvitation(_prev: ActionResult, fd: FormData): Promise<ActionResult> {
  const client = await api();
  const r = await reach(() => client.POST("/me/invitations/{invitationId}:accept", { params: { path: { invitationId: field(fd, "invitationId") } } }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  redirect(`/contracts/${r.data.id}`);
}

// Accepts the bare token or the whole link from the Core API log.
// eslint-disable-next-line @typescript-eslint/require-await -- every "use server" export must be async
export async function openInvitation(fd: FormData): Promise<void> {
  const raw = field(fd, "token").trim();
  const token = (raw.split("/").pop() ?? raw).replace(/:accept$/, "");
  redirect(`/invitations/${encodeURIComponent(token)}`);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Track" box: accepts a contract id or a pasted contract URL.
// eslint-disable-next-line @typescript-eslint/require-await -- every "use server" export must be async
export async function trackContract(fd: FormData): Promise<void> {
  const raw = field(fd, "contractId").trim().replace(/\/+$/, "");
  const id = raw.split("/").pop() ?? raw;
  redirect(UUID.test(id) ? `/contracts/${id}` : "/contracts?track=invalid");
}
