// Where New contract lands once the draft exists, from what the buyer chose under "Who will do the
// work?" (docs/mejoras-pendientes.md, 3). The contract always exists by then, so every path lands
// on it, including a failed invitation: the buyer sees why and retries there instead of losing
// the draft. Only the error code travels in the URL, never the address.
export type WhoWillWork = { kind: "LATER" } | { kind: "INVITE"; email: string } | { kind: "PUBLISH" };

export function afterCreatePath(contractId: string, who: WhoWillWork, inviteError: { code: string } | null = null): string {
  const base = `/contracts/${contractId}`;
  if (who.kind === "PUBLISH") return `${base}?next=publish#publish`;
  if (who.kind === "INVITE") return inviteError === null ? `${base}?invited=1` : `${base}?inviteFailed=${encodeURIComponent(inviteError.code)}`;
  return base;
}
