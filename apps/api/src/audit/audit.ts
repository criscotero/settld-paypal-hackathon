import type { Tx } from "../db/database.js";
import { auditLog } from "../db/schema.js";
import type { Actor } from "./actor.js";

export interface AuditEntry {
  readonly actor: Actor;
  // Dotted (domain-model.md: AuditLog.action), e.g. contract.version.approved.
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly contractId?: string;
  readonly before?: unknown;
  readonly after?: unknown;
  // Constitution IX: an override carries a written reason.
  readonly reason?: string;
  readonly requestId: string;
}

// Takes `tx`, never the global Db: the audit row commits or rolls back with the change it
// records (constitution IX). An audit row for a change that rolled back would be a lie.
export async function recordAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    contractId: entry.contractId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    reason: entry.reason ?? null,
    requestId: entry.requestId,
  });
}
