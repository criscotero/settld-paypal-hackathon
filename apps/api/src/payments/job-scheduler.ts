// Port for durable jobs and timers (events.md, section 3.1). The state machine writes a job
// in the SAME transaction as the state change it belongs to (constitution IV): if the
// transaction rolls back, the job never existed; if it commits, the job will run even if the
// process dies a millisecond later. That is why `send` takes the transaction.
import type { Tx } from "../db/database.js";

export interface JobRequest {
  readonly queue: string;
  readonly data: Record<string, unknown>;
  // Singleton key from events.md: scheduling the same job twice is a no-op, and a timer can
  // be cancelled by its key without knowing the job id.
  readonly singletonKey: string;
  readonly startAfter?: Date;
}

export interface JobScheduler {
  send(tx: Tx, job: JobRequest): Promise<void>;
  cancel(tx: Tx, queue: string, singletonKey: string): Promise<void>;
}

export const JOB_SCHEDULER = Symbol("JOB_SCHEDULER");
