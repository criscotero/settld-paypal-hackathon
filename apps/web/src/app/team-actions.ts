"use server";
// Team writes and the directory search (ADR-0009). One Core API call per step, no domain rules:
// Core API decides who can join and whether the shares add up.
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { api } from "@/lib/api";
import type { DraftInput, Schemas } from "@/lib/api-types";
import { isFailure } from "@/lib/form";
import { toActionError } from "@/lib/problem";
import type { ActionError, ActionResult } from "@/lib/problem";
import { reach } from "@/lib/reach";

export async function searchDirectory(q: string, profession: Schemas["Profession"] | ""): Promise<Schemas["DirectoryEntry"][] | ActionError> {
  const client = await api();
  const r = await reach(() => client.GET("/directory", { params: { query: { q: q === "" ? undefined : q, profession: profession === "" ? undefined : profession } } }));
  if (isFailure(r)) return r;
  return r.data?.items ?? toActionError(r.error);
}

// Saves the team as a new draft: first makes every new member a party of the contract (Core API
// only accepts parties in a team), then replaces the draft with the same content and the new team.
// If-Match is the version the page showed, so an edit made meanwhile is not overwritten.
export async function saveTeam(contractId: string, version: number, draft: DraftInput, team: Schemas["TeamMember"][], newMembers: string[]): Promise<ActionResult> {
  const client = await api();
  for (const userId of newMembers) {
    const added = await reach(() => client.POST("/contracts/{contractId}/team", { params: { path: { contractId }, header: { "Idempotency-Key": randomUUID() } }, body: { userId } }));
    if (isFailure(added)) return added;
    if (added.data === undefined) return toActionError(added.error);
  }
  const r = await reach(() => client.PUT("/contracts/{contractId}/draft", { params: { path: { contractId }, header: { "If-Match": String(version) } }, body: { ...draft, team } }));
  if (isFailure(r)) return r;
  if (r.data === undefined) return toActionError(r.error);
  revalidatePath(`/contracts/${contractId}`);
  return null;
}
