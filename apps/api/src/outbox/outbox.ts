import type { Actor } from "../audit/actor.js";
import type { Tx } from "../db/database.js";
import { outbox } from "../db/schema.js";

export interface DomainEvent {
  // events.md: <module>.<entity>.<past-tense-verb>
  readonly type: string;
  readonly actor: Actor;
  readonly contractId?: string;
  readonly milestoneId?: string;
  readonly correlationId: string;
  readonly payload: Record<string, unknown>;
}

// Transactional outbox (constitution IV): the event is a row in the same transaction as the
// state change. Either both commit or neither does, so there is never a state change without
// its event, or an event for a change that rolled back. H4 adds the process that sends them.
export async function enqueueEvent(tx: Tx, event: DomainEvent): Promise<void> {
  await tx.insert(outbox).values({
    type: event.type,
    actor: event.actor,
    contractId: event.contractId ?? null,
    milestoneId: event.milestoneId ?? null,
    correlationId: event.correlationId,
    payload: event.payload,
  });
}
