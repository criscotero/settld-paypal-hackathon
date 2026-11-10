// JobScheduler on pg-boss (constitution: Core API jobs and timers; ADR-0007). Its job rows live
// in Postgres, so a job sent through `send(tx, ...)` is part of our transaction: it commits
// with the state change or disappears with it. A crash right after the commit loses nothing,
// because the job is already a row; a crash before it leaves neither a state change nor a job.
//
// Queues use the `exclusive` policy: one job per singleton key while it is waiting or running,
// so sending the same timer twice is a no-op (events.md, section 3).
import { Logger } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import type { Tx } from "../db/database.js";
import type { JobRequest, JobScheduler } from "./job-scheduler.js";

const log = new Logger("Jobs");

export const PG_BOSS_SCHEMA = "pgboss";

// Every queue Core API writes to (events.md, section 3.1). Retries follow the same table.
export const QUEUES: Record<string, { retryLimit: number }> = {
  "payments.capture": { retryLimit: 8 },
  "payments.capture.check": { retryLimit: 12 },
  "payments.authorization.void-orphan": { retryLimit: 8 },
  "payments.void": { retryLimit: 8 },
  "payments.authorization.expiry-warning": { retryLimit: 3 },
  "payments.authorization.lapse": { retryLimit: 3 },
  "verification.run.dispatch": { retryLimit: 8 },
  "verification.run.watchdog": { retryLimit: 3 },
  "engine.event.process": { retryLimit: 5 },
  "objections.window.expire": { retryLimit: 5 },
  "objections.escalate": { retryLimit: 5 },
  "notifications.send": { retryLimit: 5 },
};

// pg-boss runs its SQL through whatever has an executeSql. Giving it our transaction is what
// puts the job row inside it. Positional parameters ($1, $2) are rebuilt as Drizzle params,
// in order, so the values are still sent separately and never spliced into the text.
function inTransaction(tx: Tx) {
  return {
    async executeSql(text: string, values: unknown[] = []) {
      const parts = text.split(/\$(\d+)/);
      const chunks: SQL[] = [];
      parts.forEach((part, i) => chunks.push(i % 2 === 0 ? sql.raw(part) : sql`${values[Number(part) - 1]}`));
      const result = await tx.execute(sql.join(chunks));
      return { rows: result.rows };
    },
  };
}

// migrate: false, because migration 0006 installs pg-boss: the library would otherwise run
// CREATE SCHEMA, which core_app is deliberately not allowed to do (SB-3).
export function createBoss(connectionString: string): PgBoss {
  const boss = new PgBoss({ connectionString, schema: PG_BOSS_SCHEMA, application_name: "settld-core-jobs", migrate: false });
  // Required, not just logging. pg-boss reports a failed poll with an "error" event and keeps
  // polling; with no listener Node throws it and the process dies, taking the API with it, over
  // something as passing as one slow database connection. Jobs are rows, so none is lost.
  boss.on("error", (error) => {
    log.error(`pg-boss: ${error.message}`);
  });
  return boss;
}

// Creates the queues once at startup (pg-boss needs a queue before its first job).
export async function ensureQueues(boss: PgBoss): Promise<void> {
  for (const [name, q] of Object.entries(QUEUES)) {
    if ((await boss.getQueue(name)) === null) await boss.createQueue(name, { policy: "exclusive", retryLimit: q.retryLimit, retryBackoff: true, retryDelay: 2 });
  }
}

export class PgBossJobScheduler implements JobScheduler {
  constructor(private readonly boss: PgBoss) {}

  async send(tx: Tx, job: JobRequest): Promise<void> {
    await this.boss.send(job.queue, job.data, {
      singletonKey: job.singletonKey,
      ...(job.startAfter === undefined ? {} : { startAfter: job.startAfter }),
      db: inTransaction(tx),
    });
  }

  // A timer that has not started yet is cancelled by its singleton key. A job already running
  // is left alone: each handler re-reads the milestone and does nothing when it is stale.
  async cancel(tx: Tx, queue: string, singletonKey: string): Promise<void> {
    await tx.execute(
      sql`UPDATE ${sql.raw(PG_BOSS_SCHEMA)}.job SET state = 'cancelled', completed_on = now() WHERE name = ${queue} AND singleton_key = ${singletonKey} AND state IN ('created', 'retry')`,
    );
  }
}
