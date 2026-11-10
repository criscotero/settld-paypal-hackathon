// The Core API half of the bridge to the Engine (ADR-0008, steps 4 and 5; SB-1, SB-5, SB-6).
//
//   submit (SM-T05/T11/T21) ─ job verification.run.dispatch ─► dispatch() ─ PUT /runs ─► Engine
//   Engine outbox ─ POST /internal/v1/events ─► receiveEvent(): inbox row + job, one transaction
//   job engine.event.process ─► processEvent() ─► MilestonesService.applyRunCompleted
//   job verification.run.watchdog (deadline + 10 min) ─► watchdog() ─ GET /runs ─► same apply
//
// The Engine never changes a milestone (SB-1): it reports, and only applyRunCompleted decides.
// Every step can run twice: createRun is idempotent on runId, the inbox on the event id, and
// applyRunCompleted on the runId, so a retry, a redelivery or a watchdog racing the event all
// end in the same single transition.
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Caller } from "../contracts/contracts.service.js";
import type { ContractSnapshot } from "../contracts/snapshot.js";
import { DB } from "../db/database.js";
import type { Db } from "../db/database.js";
import { contracts, contractVersions, inbox, milestones, runOutcomes, submissions } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { notFound } from "../http/params.js";
import { JOB_SCHEDULER } from "../payments/job-scheduler.js";
import type { JobScheduler } from "../payments/job-scheduler.js";
import { MilestonesService } from "../payments/milestones.service.js";
import { ENGINE_CLIENT, EngineRejectedError } from "./engine-client.js";
import type { EngineClient, RunReport, RunRequest } from "./engine-client.js";
import { RUN_DEADLINE_MS } from "./timing.js";

// internal-api.yaml, EngineEvent. Only the envelope is checked here; each type's payload is
// parsed when it is processed, so an unknown future field never blocks storing the fact.
const ENGINE_EVENT_TYPES = [
  "verification.run.started",
  "verification.criterion.evaluated",
  "verification.run.completed",
  "verification.injection.flagged",
  "payments.reconciliation.completed",
  "payments.reconciliation.mismatch",
] as const;
export const engineEvent = z.object({
  id: z.uuid(),
  type: z.enum(ENGINE_EVENT_TYPES),
  schemaVersion: z.number().int().min(1),
  occurredAt: z.string(),
  actor: z.object({ type: z.literal("SYSTEM"), id: z.string() }),
  contractId: z.uuid().nullish(),
  milestoneId: z.uuid().nullish(),
  correlationId: z.string(),
  causationId: z.string().nullish(),
  payload: z.record(z.string(), z.unknown()),
});
export type EngineEvent = z.infer<typeof engineEvent>;

// internal-api.yaml, RunCompletedPayload.
const runCompleted = z.object({
  runId: z.uuid(),
  submissionId: z.uuid(),
  seq: z.number().int().min(1),
  status: z.enum(["COMPLETED", "TIMED_OUT"]),
  outcome: z.enum(["PASSED", "FAILED"]),
  results: z.array(z.object({ criterionId: z.uuid(), verdict: z.enum(["PASS", "FAIL", "UNCERTAIN", "NEEDS_HUMAN"]), evidenceRefCount: z.number().int().min(0) })),
  reportHash: z.string(),
});

@Injectable()
export class VerificationService {
  private readonly log = new Logger(VerificationService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(JOB_SCHEDULER) private readonly jobs: JobScheduler,
    @Inject(ENGINE_CLIENT) private readonly engine: EngineClient,
    private readonly milestones: MilestonesService,
  ) {}

  // GET /verification-runs/{runId} (getEvidenceReport). Core checks the caller is a party and
  // proxies the Engine, which owns the report (SB-3, SB-7). Same 404 for "missing" and "not
  // yours", and an Engine that is down is a 503: it must never look like an empty report.
  async evidenceReport(runId: string, caller: Caller): Promise<RunReport> {
    const [submission] = await this.db.select({ milestoneId: submissions.milestoneId }).from(submissions).where(eq(submissions.runId, runId));
    if (submission === undefined) throw notFound();
    // A Reviewer rules on evidence, and is no party (ADR-0014). Anyone else: NOT_FOUND for a stranger.
    if (!(await this.milestones.reviewerMayRead(submission.milestoneId, caller))) await this.milestones.get(submission.milestoneId, caller);
    let report: RunReport | null;
    try {
      report = await this.engine.getRun(runId);
    } catch (error) {
      this.log.warn(`getEvidenceReport ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      throw new ProblemException("ENGINE_UNAVAILABLE", 503, "The verification report is not available", "The verifier is not answering. The delivery and the money are not affected. Try again in a moment.");
    }
    if (report === null) throw notFound();
    return report;
  }

  // verification.run.dispatch. Throws EngineUnavailableError so pg-boss retries with the same
  // runId; an EngineRejectedError (a 409 for a different body, a 422) is an incident.
  async dispatch(runId: string): Promise<"DISPATCHED" | "STALE"> {
    const request = await this.runRequest(runId);
    if (request === null) return "STALE";
    try {
      await this.engine.createRun(request);
    } catch (error) {
      if (error instanceof EngineRejectedError) this.log.error(`Run ${runId} refused by the Engine (${String(error.status)}); admin alert: ${error.message}`);
      throw error;
    }
    return "DISPATCHED";
  }

  // SB-4: everything the Engine needs, rebuilt from the locked version and the submission on
  // every try. Nothing in it depends on when the try happens, so a retry sends the same body
  // and the Engine answers 200 instead of 409.
  async runRequest(runId: string): Promise<RunRequest | null> {
    const [row] = await this.db
      .select({ sub: submissions, milestone: milestones, version: contractVersions, contract: contracts })
      .from(submissions)
      .innerJoin(milestones, eq(milestones.id, submissions.milestoneId))
      .innerJoin(contracts, eq(contracts.id, milestones.contractId))
      .innerJoin(contractVersions, eq(contractVersions.id, milestones.lockedVersionId))
      .where(eq(submissions.runId, runId));
    if (row === undefined) throw new Error(`No submission for run ${runId}`);
    const { sub, milestone, version, contract } = row;
    // A delivery that a newer one replaced, or a milestone that moved on, needs no verdict.
    if (milestone.state !== "VERIFYING" || milestone.latestRunId !== runId) return null;
    const def = (version.snapshot as ContractSnapshot).milestones.find((m) => m.id === milestone.id);
    if (def === undefined || version.snapshotHash === null) throw new Error(`Milestone ${milestone.id} is missing from its locked version`);
    return {
      runId,
      submissionId: sub.id,
      milestoneId: milestone.id,
      contractId: contract.id,
      lockedVersion: { versionId: version.id, snapshotHash: version.snapshotHash },
      attempt: sub.attempt,
      locale: "en",
      // NFR-10: five minutes to verify, counted from the delivery. From the delivery and not
      // from this try, so the body is the same on every retry (see above). The cost: if the
      // Engine was down most of that time, the run ends TIMED_OUT and the seller delivers again.
      deadlineAt: new Date(sub.submittedAt.getTime() + RUN_DEADLINE_MS).toISOString(),
      criteria: def.criteria.map((c) => ({ criterionId: c.id, text: c.text, level: c.level, required: c.required, checkType: c.checkType, checkConfig: c.checkConfig })),
      evidenceLinks: sub.evidenceLinks,
      ...(sub.notes === "" ? {} : { notes: sub.notes }),
    };
  }

  // POST /internal/v1/events, after the service token was checked. The fact and the job that
  // processes it commit together: the Engine gets its 200 only when both are durable, and a
  // crash right after loses nothing. A redelivery hits the unique index and does nothing.
  async receiveEvent(event: EngineEvent): Promise<"STORED" | "DUPLICATE"> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(inbox)
        .values({ provider: "ENGINE", externalEventId: event.id, eventType: event.type, signatureVerified: true, payload: event })
        .onConflictDoNothing()
        .returning({ id: inbox.id });
      if (row === undefined) return "DUPLICATE";
      await this.jobs.send(tx, { queue: "engine.event.process", singletonKey: `inbox:${row.id}`, data: { inboxEventId: row.id } });
      return "STORED";
    });
  }

  // engine.event.process. A throw makes pg-boss retry (5, then an alert); the error is kept on
  // the row so whoever looks at the alert sees why.
  async processEvent(inboxEventId: string): Promise<"APPLIED" | "IGNORED" | "SKIPPED"> {
    const [row] = await this.db.select().from(inbox).where(eq(inbox.id, inboxEventId));
    if (row === undefined || row.processedAt !== null) return "SKIPPED";
    const event = row.payload as EngineEvent;
    try {
      // Only the completed run moves a milestone in H4. The other types are stored for when
      // their consumers exist (the live checklist, reconciliation), and marked done.
      if (event.type === "verification.run.completed") {
        const p = runCompleted.parse(event.payload);
        await this.milestones.applyRunCompleted({ runId: p.runId, status: p.status, results: p.results, reportHash: p.reportHash }, event.correlationId);
      }
    } catch (error) {
      await this.db
        .update(inbox)
        .set({ attempts: sql`${inbox.attempts} + 1`, lastError: error instanceof Error ? error.message : String(error) })
        .where(eq(inbox.id, inboxEventId));
      throw error;
    }
    await this.db.update(inbox).set({ processedAt: new Date(), attempts: sql`${inbox.attempts} + 1` }).where(and(eq(inbox.id, inboxEventId), isNull(inbox.processedAt)));
    return event.type === "verification.run.completed" ? "APPLIED" : "IGNORED";
  }

  // verification.run.watchdog, at the run deadline plus 10 minutes. The completion event may be
  // lost (an outbox bug, a network partition longer than its retries); then the milestone would
  // wait in VERIFYING forever. The watchdog asks the Engine directly. Throws while the run is
  // not finished, so pg-boss asks again later.
  async watchdog(runId: string): Promise<"ALREADY_APPLIED" | "APPLIED" | "STALE"> {
    const [seen] = await this.db.select({ runId: runOutcomes.runId }).from(runOutcomes).where(eq(runOutcomes.runId, runId));
    if (seen !== undefined) return "ALREADY_APPLIED";
    if ((await this.runRequest(runId)) === null) return "STALE";
    const report = await this.engine.getRun(runId);
    if (report === null) throw new Error(`The Engine has no run ${runId}: the dispatch never landed`);
    if (report.status !== "COMPLETED" && report.status !== "TIMED_OUT") throw new Error(`Run ${runId} is still ${report.status}`);
    const results = report.results.map((r) => {
      if (r.verdict === "PENDING") throw new Error(`Run ${runId} finished with a PENDING verdict`);
      return { criterionId: r.criterionId, verdict: r.verdict, evidenceRefCount: r.evidence.length };
    });
    await this.milestones.applyRunCompleted({ runId, status: report.status, results, reportHash: report.reportHash ?? undefined });
    return "APPLIED";
  }
}
