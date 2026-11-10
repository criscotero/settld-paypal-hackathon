// The pg-boss workers for H2's jobs (events.md, section 3.1). Each handler is a thin call into
// MilestonesService, which re-reads the row and does nothing when the job is stale, so a job
// delivered twice, late or after a crash is harmless. A handler that throws (PayPal 5xx, a
// lost answer) makes pg-boss retry later with the same data, and therefore the same requestId.
//
// A queue without a worker yet (the expiry warning, the reminder) keeps its jobs until one exists;
// nothing is lost in the meantime.
import { Logger } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import type { MilestonesService } from "./milestones.service.js";

interface CaptureJob {
  releasePartId: string;
}
interface VoidJob {
  holdId: string;
}
interface OrphanJob {
  milestoneId: string;
  authorizationId: string;
  requestId: string;
}
interface EscalationJob {
  objectionId: string;
}
interface LapseJob {
  milestoneId: string;
  authorizationId: string;
}
interface WindowJob {
  milestoneId: string;
  runId: string;
}

// pollingIntervalSeconds: how often an idle worker looks for new jobs (pg-boss default 2 s).
export async function startPaymentWorkers(boss: PgBoss, milestones: MilestonesService, pollingIntervalSeconds = 2): Promise<void> {
  const log = new Logger("PaymentWorkers");
  const opts = { pollingIntervalSeconds };
  await boss.work<CaptureJob>("payments.capture", opts, async ([job]) => {
    if (job !== undefined) log.log(`capture ${job.data.releasePartId}: ${await milestones.processCapture(job.data.releasePartId, job.id)}`);
  });
  // Throws while PayPal still says PENDING, so pg-boss asks again later with backoff.
  await boss.work<CaptureJob>("payments.capture.check", opts, async ([job]) => {
    if (job !== undefined) log.log(`capture check ${job.data.releasePartId}: ${await milestones.processCaptureCheck(job.data.releasePartId, job.id)}`);
  });
  await boss.work<OrphanJob>("payments.authorization.void-orphan", opts, async ([job]) => {
    if (job !== undefined) log.log(`orphan void ${job.data.authorizationId}: ${await milestones.processVoidOrphan(job.data.milestoneId, job.data.authorizationId, job.data.requestId)}`);
  });
  await boss.work<VoidJob>("payments.void", opts, async ([job]) => {
    if (job !== undefined) log.log(`void ${job.data.holdId}: ${await milestones.processVoid(job.data.holdId, job.id)}`);
  });
  await boss.work<EscalationJob>("objections.escalate", opts, async ([job]) => {
    if (job !== undefined) log.log(`escalate ${job.data.objectionId}: ${await milestones.processEscalation(job.data.objectionId, job.id)}`);
  });
  // Throws while PayPal does not answer, so pg-boss asks again with the same data.
  await boss.work<LapseJob>("payments.authorization.lapse", opts, async ([job]) => {
    if (job !== undefined) log.log(`lapse ${job.data.authorizationId}: ${await milestones.processLapse(job.data.milestoneId, job.data.authorizationId, job.id)}`);
  });
  // The countdown timer (E-OPEN-WINDOW). H5 owns its reminders.
  await boss.work<WindowJob>("objections.window.expire", opts, async ([job]) => {
    if (job !== undefined) {
      const { applied } = await milestones.expireWindow(job.data.milestoneId, job.data.runId, job.id);
      log.log(`window ${job.data.milestoneId}: ${applied ?? "nothing to do"}`);
    }
  });
}
