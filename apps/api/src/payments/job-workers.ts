// Where other modules hand in their pg-boss workers. There is one pg-boss per process, owned by
// the payments module's lifecycle; a second instance would poll the same tables twice and
// double the connections. A module adds its starter in onModuleInit, which Nest runs for every
// module before any onApplicationBootstrap, so the list is complete when pg-boss starts.
import type { PgBoss } from "pg-boss";

export type WorkerStarter = (boss: PgBoss) => Promise<void>;

export class JobWorkers {
  private readonly starters: WorkerStarter[] = [];

  add(starter: WorkerStarter): void {
    this.starters.push(starter);
  }

  async startAll(boss: PgBoss): Promise<void> {
    for (const start of this.starters) await start(boss);
  }
}

export const JOB_WORKERS = Symbol("JOB_WORKERS");
