// JobScheduler without a queue: remembers what was scheduled and runs nothing. The tests use
// it to assert which jobs a transition wrote and then run the work themselves (processCapture,
// expireWindow), so every step is visible. It is NOT transactional: a job sent inside a
// transaction that later rolls back stays in the list. The pg-boss scheduler does not have
// that gap, because its job rows live in the same transaction.
import type { Tx } from "../db/database.js";
import type { JobRequest, JobScheduler } from "./job-scheduler.js";

export class MemoryJobScheduler implements JobScheduler {
  readonly sent: JobRequest[] = [];
  readonly cancelled: { queue: string; singletonKey: string }[] = [];

  send(_tx: Tx, job: JobRequest): Promise<void> {
    // Same singleton key, same job: scheduling twice is a no-op (events.md, section 3).
    if (!this.sent.some((j) => j.queue === job.queue && j.singletonKey === job.singletonKey)) this.sent.push(job);
    return Promise.resolve();
  }

  cancel(_tx: Tx, queue: string, singletonKey: string): Promise<void> {
    this.cancelled.push({ queue, singletonKey });
    return Promise.resolve();
  }

  of(queue: string): JobRequest[] {
    return this.sent.filter((j) => j.queue === queue);
  }
}
