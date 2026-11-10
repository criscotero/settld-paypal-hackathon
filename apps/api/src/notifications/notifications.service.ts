// notifications.send (events.md, ADR-0011, ADR-0013). decision.needed, invitation.sent, contract.locked,
// window.opened and objection.raised send mail; the other E-NOTIFY templates are finished as
// nothing to do, until EVAL-405.
import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { APP_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import type { ContractSnapshot } from "../contracts/snapshot.js";
import { DB } from "../db/database.js";
import type { Db } from "../db/database.js";
import { contracts, contractVersions, invitations, milestones, notifications, objections, reviewerApplications, users } from "../db/schema.js";
import { CLOCK } from "../payments/clock.js";
import type { Clock } from "../payments/clock.js";
import { ENGINE_CLIENT } from "../verification/engine-client.js";
import type { EngineClient, RunReport } from "../verification/engine-client.js";
import { buildDecisionEmail } from "./decision-email.js";
import type { DecisionItem } from "./decision-email.js";
import { EMAIL_SENDER } from "./email-sender.js";
import { isSeededAddress } from "./seeded-address.js";
import type { EmailMessage, EmailSender } from "./email-sender.js";
import { buildApplicationEmail, buildContractLockedEmail, buildEscalatedEmail, buildInvitationEmail, buildMilestoneEndedEmail, buildObjectionEmail, buildRuledEmail, buildWindowOpenedEmail } from "./flow-emails.js";

export const DECISION_NEEDED = "decision.needed";
const INVITATION_SENT = "invitation.sent";
const CONTRACT_LOCKED = "contract.locked";
const WINDOW_OPENED = "window.opened";
const OBJECTION_RAISED = "objection.raised";
const OBJECTION_ESCALATED = "objection.escalated";
const OBJECTION_RULED = "objection.ruled";
const APPLICATION_SUBMITTED = "reviewer.application_submitted";
const APPLICATION_DECIDED = "reviewer.application_decided";
const MILESTONE_VOIDED = "milestone.voided";
const MILESTONE_CLOSED = "milestone.closed";
// A ruling already has its own mail, with the reason: a second one would say less.
const RULINGS: ReadonlySet<string> = new Set(["SM-T14", "SM-T27"]);

export interface DecisionNeededJob {
  readonly templateKey: string;
  readonly recipientIds: readonly string[];
  readonly deepLink: string;
  readonly params: { readonly milestoneId: string; readonly runId: string; readonly pendingCriterionIds: readonly string[] };
}

// Every template the worker receives. Fields past the common ones depend on the template, and a
// template that is not built yet is finished without reading them.
export interface NotificationJob {
  readonly templateKey: string;
  readonly recipientIds: readonly string[];
  readonly recipientEmail?: string;
  readonly deepLink: string;
  readonly params: { readonly contractId?: string; readonly versionId?: string; readonly milestoneId?: string; readonly runId?: string; readonly invitationId?: string; readonly objectionId?: string; readonly transitionId?: string; readonly applicationId?: string; readonly round?: string; readonly pendingCriterionIds?: readonly string[] };
}

export type SendResult = "SENT" | "ALREADY_SENT" | "SUPPRESSED" | "IGNORED";

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENGINE_CLIENT) private readonly engine: EngineClient,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    // null: no mail server configured. Everything else keeps working.
    @Optional() @Inject(EMAIL_SENDER) private readonly sender: EmailSender | null,
  ) {}

  // Sending before recording means a crash between the two sends the mail again. That is the
  // right way round: a duplicate is an annoyance, a lost warning is money nobody decided on.
  async process(job: NotificationJob): Promise<SendResult> {
    switch (job.templateKey) {
      case DECISION_NEEDED:
        return this.decisionNeeded(job as DecisionNeededJob);
      case INVITATION_SENT:
        return this.invitationSent(job);
      case CONTRACT_LOCKED:
        return this.contractLocked(job);
      case WINDOW_OPENED:
        return this.windowOpened(job);
      case OBJECTION_RAISED:
        return this.objectionRaised(job);
      case OBJECTION_ESCALATED:
        return this.objectionEscalated(job);
      case OBJECTION_RULED:
        return this.objectionRuled(job);
      case APPLICATION_SUBMITTED:
      case APPLICATION_DECIDED:
        return this.reviewerApplication(job);
      case MILESTONE_VOIDED:
      case MILESTONE_CLOSED:
        return this.milestoneEnded(job);
      default:
        // Finished on purpose, and visibly: these are not built yet (EVAL-405) and are not replayed.
        this.log.log(`${job.templateKey}: not sent, this template does not exist yet`);
        return "IGNORED";
    }
  }

  // The steps every mail shares: a row per mail, so a repeated job does not send twice; still valid
  // when the job runs, because pg-boss may run it late; and sent before recorded (see above).
  private async once(dedupeKey: string, userId: string | null, template: string, payload: Record<string, unknown>, stale: string | null, build: () => Promise<EmailMessage>): Promise<SendResult> {
    await this.db.insert(notifications).values({ dedupeKey, userId, template, payload }).onConflictDoNothing({ target: notifications.dedupeKey });
    const [row] = await this.db.select().from(notifications).where(eq(notifications.dedupeKey, dedupeKey));
    if (row?.status === "SENT") return "ALREADY_SENT";
    if (stale !== null) return this.suppress(dedupeKey, stale);
    if (this.sender === null) return this.suppress(dedupeKey, "no mail server configured");
    const message = await build();
    if (isSeededAddress(message.to)) return this.suppress(dedupeKey, "seeded test address, nobody reads it");
    await this.sendAndRecordFailure(dedupeKey, message);
    await this.db.update(notifications).set({ status: "SENT", sentAt: this.clock.now(), reason: null }).where(and(eq(notifications.dedupeKey, dedupeKey), eq(notifications.status, "PENDING")));
    return "SENT";
  }

  // No token in this mail (ADR-0013): the link opens the invitations of the signed-in account, and
  // only the verified address it was sent to can see it there.
  private async invitationSent(job: NotificationJob): Promise<SendResult> {
    const { invitationId, round } = job.params;
    const to = job.recipientEmail;
    if (invitationId === undefined || to === undefined) throw new Error("invitation.sent job without invitation or address");
    const [found] = await this.db
      .select({ invitation: invitations, snapshot: contractVersions.snapshot, buyerName: users.displayName, locale: users.locale })
      .from(invitations)
      .innerJoin(contracts, eq(contracts.id, invitations.contractId))
      .innerJoin(contractVersions, eq(contractVersions.id, contracts.currentVersionId))
      .innerJoin(users, eq(users.id, contracts.buyerId))
      .where(eq(invitations.id, invitationId));
    if (found === undefined) throw new Error(`invitation.sent: invitation ${invitationId} not found`);
    const { invitation } = found;
    const stale = invitation.acceptedAt !== null ? "the invitation was already accepted" : invitation.expiresAt <= this.clock.now() ? "the invitation expired" : null;
    // A renewed invitation is mailed again, so each send has its own round. Jobs queued before
    // rounds existed have none and keep their old key, so they are not sent twice.
    return this.once(round === undefined ? `invitation-sent:${invitationId}` : `invitation-sent:${invitationId}:${round}`, null, INVITATION_SENT, { invitationId }, stale, () =>
      Promise.resolve({
        to,
        ...buildInvitationEmail({
          // The invitee has no locale of their own yet: the buyer's is the best guess (ADR-0013).
          locale: found.locale,
          buyerName: found.buyerName,
          contractTitle: (found.snapshot as ContractSnapshot).title,
          email: to,
          expiresAt: invitation.expiresAt,
          link: `${this.config.webUrl}${job.deepLink}`,
        }),
      }),
    );
  }

  private async windowOpened(job: NotificationJob): Promise<SendResult> {
    const { milestoneId, runId } = job.params;
    if (milestoneId === undefined || runId === undefined) throw new Error("window.opened job without milestone or run");
    const [m] = await this.db.select().from(milestones).where(eq(milestones.id, milestoneId));
    if (m === undefined) throw new Error(`window.opened: milestone ${milestoneId} not found`);
    const [contract] = await this.db.select({ buyerId: contracts.buyerId }).from(contracts).where(eq(contracts.id, m.contractId));
    const windowEndsAt = m.windowEndsAt;
    const stillOpen = m.state === "OBJECTION_WINDOW" && m.latestRunId === runId && windowEndsAt !== null && this.clock.now() < windowEndsAt;
    const titles = await this.titlesOf(m.lockedVersionId, milestoneId);
    return this.eachRecipient(job, `window-opened:${runId}`, WINDOW_OPENED, { milestoneId, runId }, stillOpen ? null : "the countdown is over", (userId, person) => ({
      to: person.email,
      ...buildWindowOpenedEmail({ locale: person.locale, viewer: userId === contract?.buyerId ? "BUYER" : "SELLER", ...titles, windowEndsAt: windowEndsAt ?? this.clock.now(), link: `${this.config.webUrl}${job.deepLink}` }),
    }));
  }

  private async objectionRaised(job: NotificationJob): Promise<SendResult> {
    const { milestoneId } = job.params;
    const [sellerId] = job.recipientIds;
    if (milestoneId === undefined || sellerId === undefined) throw new Error("objection.raised job without milestone or recipient");
    const [m] = await this.db.select().from(milestones).where(eq(milestones.id, milestoneId));
    if (m === undefined) throw new Error(`objection.raised: milestone ${milestoneId} not found`);
    const [objection] = await this.db.select().from(objections).where(and(eq(objections.milestoneId, milestoneId), inArray(objections.status, ["OPEN", "CONTESTED", "ESCALATED"]))).orderBy(desc(objections.raisedAt)).limit(1);
    // Withdrawn or answered before the job ran: nothing is left to ask the seller.
    if (objection === undefined) return "SUPPRESSED";
    const [seller] = await this.db.select({ email: users.email, locale: users.locale }).from(users).where(eq(users.id, sellerId));
    if (seller === undefined) throw new Error(`objection.raised: user ${sellerId} not found`);
    const titles = await this.titlesOf(m.lockedVersionId, milestoneId);
    return this.once(`objection-raised:${objection.id}`, sellerId, OBJECTION_RAISED, { milestoneId, objectionId: objection.id }, null, () =>
      Promise.resolve({ to: seller.email, ...buildObjectionEmail({ locale: seller.locale, ...titles, reason: objection.reason, link: `${this.config.webUrl}${job.deepLink}` }) }),
    );
  }

  // A reviewer's link goes to the case; a party's to their milestone. Only the parties are in the
  // contract, so whoever else is on this job is a reviewer.
  private async objectionEscalated(job: NotificationJob): Promise<SendResult> {
    const { milestoneId, objectionId } = job.params;
    if (milestoneId === undefined || objectionId === undefined) throw new Error("objection.escalated job without milestone or objection");
    const [m] = await this.db.select().from(milestones).where(eq(milestones.id, milestoneId));
    const [objection] = await this.db.select({ status: objections.status }).from(objections).where(eq(objections.id, objectionId));
    if (m === undefined || objection === undefined) throw new Error(`objection.escalated: ${objectionId} not found`);
    const [contract] = await this.db.select({ buyerId: contracts.buyerId, sellerId: contracts.sellerId }).from(contracts).where(eq(contracts.id, m.contractId));
    const titles = await this.titlesOf(m.lockedVersionId, milestoneId);
    const stale = objection.status === "ESCALATED" ? null : "the objection is no longer escalated";
    return this.eachRecipient(job, `objection-escalated:${objectionId}`, OBJECTION_ESCALATED, { milestoneId, objectionId }, stale, (userId, person) => {
      const party = userId === contract?.buyerId || userId === contract?.sellerId;
      return { to: person.email, ...buildEscalatedEmail({ locale: person.locale, viewer: party ? "PARTY" : "REVIEWER", ...titles, link: `${this.config.webUrl}${party ? job.deepLink : `/review/${objectionId}`}` }) };
    });
  }

  private async objectionRuled(job: NotificationJob): Promise<SendResult> {
    const { milestoneId, objectionId } = job.params;
    if (milestoneId === undefined || objectionId === undefined) throw new Error("objection.ruled job without milestone or objection");
    const [m] = await this.db.select().from(milestones).where(eq(milestones.id, milestoneId));
    const [objection] = await this.db.select().from(objections).where(eq(objections.id, objectionId));
    if (m === undefined || objection === undefined) throw new Error(`objection.ruled: ${objectionId} not found`);
    const titles = await this.titlesOf(m.lockedVersionId, milestoneId);
    return this.eachRecipient(job, `objection-ruled:${objectionId}`, OBJECTION_RULED, { milestoneId, objectionId }, null, (_userId, person) => ({
      to: person.email,
      ...buildRuledEmail({ locale: person.locale, decision: objection.status === "RULED_RELEASE" ? "RELEASE" : "VOID", ...titles, reason: objection.resolutionReason ?? "", link: `${this.config.webUrl}${job.deepLink}` }),
    }));
  }

  // `round` tells apart a second application from the first: same row, different mail.
  // The buyer learns here that a stranger took their project: nobody chose this seller, so without
  // this mail the buyer only finds out by opening Settld, and the agreement sits unfunded.
  private async contractLocked(job: NotificationJob): Promise<SendResult> {
    const { contractId, versionId } = job.params;
    if (contractId === undefined || versionId === undefined) throw new Error("contract.locked job without contract or version");
    const [contract] = await this.db.select().from(contracts).where(eq(contracts.id, contractId));
    const [version] = await this.db.select({ snapshot: contractVersions.snapshot }).from(contractVersions).where(eq(contractVersions.id, versionId));
    if (contract === undefined || version === undefined) throw new Error(`contract.locked: contract ${contractId} or version ${versionId} not found`);
    const sellerId = contract.sellerId;
    if (sellerId === null) throw new Error(`contract.locked: contract ${contractId} has no seller`);
    const names = await this.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, [contract.buyerId, sellerId]));
    const nameOf = (id: string) => names.find((n) => n.id === id)?.name ?? "";
    // pg-boss may run this late: "fund it now" after the buyer already funded would teach them to
    // ignore these mails, the same reason decision.needed reads its state when it runs.
    // Any milestone counts, not all: with several, the first one funded already answers this mail.
    const states = await this.db.select({ state: milestones.state }).from(milestones).where(eq(milestones.contractId, contractId));
    const stale = states.some((m) => m.state !== "APPROVED") ? "the contract already moved past its agreement" : null;
    return this.eachRecipient(job, `contract-locked:${versionId}`, CONTRACT_LOCKED, { contractId, versionId }, stale, (userId, person) => {
      const isBuyer = userId === contract.buyerId;
      return {
        to: person.email,
        ...buildContractLockedEmail({
          locale: person.locale,
          recipient: isBuyer ? "BUYER" : "SELLER",
          otherPartyName: nameOf(isBuyer ? sellerId : contract.buyerId),
          contractTitle: (version.snapshot as ContractSnapshot).title,
          link: `${this.config.webUrl}${job.deepLink}`,
        }),
      };
    });
  }

  private async reviewerApplication(job: NotificationJob): Promise<SendResult> {
    const { applicationId, round } = job.params;
    if (applicationId === undefined || round === undefined) throw new Error(`${job.templateKey} job without application`);
    const [application] = await this.db.select({ row: reviewerApplications, name: users.displayName }).from(reviewerApplications).innerJoin(users, eq(users.id, reviewerApplications.userId)).where(eq(reviewerApplications.id, applicationId));
    if (application === undefined) throw new Error(`${job.templateKey}: application ${applicationId} not found`);
    const { row, name } = application;
    const decided = row.status === "APPROVED" || row.status === "REJECTED" || row.status === "SUSPENDED";
    return this.eachRecipient(job, `${job.templateKey}:${applicationId}:${round}`, job.templateKey, { applicationId }, null, (userId, person) => {
      const toDecide = job.templateKey === APPLICATION_SUBMITTED && userId !== row.userId;
      const kind = toDecide ? "TO_DECIDE" : job.templateKey === APPLICATION_SUBMITTED || !decided ? "RECEIVED" : row.status === "APPROVED" ? "APPROVED" : row.status === "REJECTED" ? "REJECTED" : "SUSPENDED";
      return { to: person.email, ...buildApplicationEmail({ locale: person.locale, kind, displayName: name, reason: job.templateKey === APPLICATION_DECIDED ? row.decisionReason : null, link: `${this.config.webUrl}${toDecide ? "/admin/reviewers" : job.deepLink}` }) };
    });
  }

  private async milestoneEnded(job: NotificationJob): Promise<SendResult> {
    const { milestoneId, transitionId } = job.params;
    if (milestoneId === undefined) throw new Error(`${job.templateKey} job without milestone`);
    if (transitionId !== undefined && RULINGS.has(transitionId)) return "IGNORED";
    const [m] = await this.db.select().from(milestones).where(eq(milestones.id, milestoneId));
    if (m === undefined) throw new Error(`${job.templateKey}: milestone ${milestoneId} not found`);
    const titles = await this.titlesOf(m.lockedVersionId, milestoneId);
    return this.eachRecipient(job, `milestone-ended:${milestoneId}`, job.templateKey, { milestoneId, transitionId }, null, (_userId, person) => ({
      to: person.email,
      ...buildMilestoneEndedEmail({ locale: person.locale, partlyPaid: m.releasedMinor > 0, ...titles, link: `${this.config.webUrl}${job.deepLink}` }),
    }));
  }

  // One by one: a retry after a failure finds the ones already sent and skips them.
  private async eachRecipient(job: NotificationJob, prefix: string, template: string, payload: Record<string, unknown>, stale: string | null, build: (userId: string, person: { email: string; locale: string }) => EmailMessage): Promise<SendResult> {
    const results: SendResult[] = [];
    for (const userId of job.recipientIds) {
      const [person] = await this.db.select({ email: users.email, locale: users.locale }).from(users).where(eq(users.id, userId));
      if (person === undefined) throw new Error(`${template}: user ${userId} not found`);
      results.push(await this.once(`${prefix}:${userId}`, userId, template, payload, stale, () => Promise.resolve(build(userId, person))));
    }
    return results.includes("SENT") ? "SENT" : (results[0] ?? "SUPPRESSED");
  }

  private async titlesOf(versionId: string | null, milestoneId: string): Promise<{ contractTitle: string; milestoneTitle: string }> {
    if (versionId === null) throw new Error(`Milestone ${milestoneId} has no locked version`);
    const [version] = await this.db.select({ snapshot: contractVersions.snapshot }).from(contractVersions).where(eq(contractVersions.id, versionId));
    const snapshot = version?.snapshot as ContractSnapshot | undefined;
    const def = snapshot?.milestones.find((d) => d.id === milestoneId);
    if (snapshot === undefined || def === undefined) throw new Error(`Milestone ${milestoneId} is missing from its locked version`);
    return { contractTitle: snapshot.title, milestoneTitle: def.title };
  }

  private async decisionNeeded(job: DecisionNeededJob): Promise<SendResult> {
    const { milestoneId, runId, pendingCriterionIds } = job.params;
    const [buyerId] = job.recipientIds;
    if (buyerId === undefined) throw new Error(`decision.needed job for run ${runId} has no recipient`);
    const [m] = await this.db.select().from(milestones).where(eq(milestones.id, milestoneId));
    // Read now, not when the job was written: pg-boss may run it late, and asking for a decision
    // already taken would teach the buyer to ignore these mails.
    const windowEndsAt = m?.windowEndsAt ?? null;
    const stillOpen = m?.state === "OBJECTION_WINDOW" && m.latestRunId === runId && windowEndsAt !== null && this.clock.now() < windowEndsAt;
    return this.once(`decision-needed:${runId}`, buyerId, DECISION_NEEDED, { milestoneId, runId }, stillOpen ? null : "the decision is no longer pending", async () => {
      const [buyer] = await this.db.select({ email: users.email, locale: users.locale }).from(users).where(eq(users.id, buyerId));
      if (buyer === undefined || m === undefined || m.lockedVersionId === null || windowEndsAt === null) throw new Error(`decision.needed for run ${runId}: missing buyer or locked version`);
      const [version] = await this.db.select({ snapshot: contractVersions.snapshot }).from(contractVersions).where(eq(contractVersions.id, m.lockedVersionId));
      const snapshot = version?.snapshot as ContractSnapshot | undefined;
      const def = snapshot?.milestones.find((d) => d.id === milestoneId);
      if (snapshot === undefined || def === undefined) throw new Error(`decision.needed for run ${runId}: missing locked version`);

      const report = await this.readReport(runId);
      const items: DecisionItem[] =
        report === null
          ? []
          : def.criteria
              .filter((c) => pendingCriterionIds.includes(c.id))
              .map((c) => {
                const result = report.results.find((r) => r.criterionId === c.id);
                return { text: c.text, required: c.required, level: c.level, verdict: result?.verdict ?? "PENDING", reason: result?.reason ?? "", flagged: result?.injectionFlagged ?? false };
              });
      return {
        to: buyer.email,
        ...buildDecisionEmail({ locale: buyer.locale, contractTitle: snapshot.title, milestoneTitle: def.title, windowEndsAt, link: `${this.config.webUrl}${job.deepLink}`, items }),
      };
    });
  }

  // Rethrows so pg-boss retries. The error stays on the row: "still PENDING" and "PENDING because
  // the password is wrong" must not look the same to whoever finds out why nobody was warned.
  private async sendAndRecordFailure(dedupeKey: string, message: EmailMessage): Promise<void> {
    if (this.sender === null) return;
    try {
      await this.sender.send(message);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.log.error(`${dedupeKey}: could not send: ${reason}`);
      await this.db.update(notifications).set({ reason: reason.slice(0, 500) }).where(eq(notifications.dedupeKey, dedupeKey));
      throw error;
    }
  }

  private async suppress(dedupeKey: string, reason: string): Promise<SendResult> {
    this.log.log(`${dedupeKey}: not sent, ${reason}`);
    await this.db.update(notifications).set({ status: "SUPPRESSED", reason }).where(eq(notifications.dedupeKey, dedupeKey));
    return "SUPPRESSED";
  }

  // No retries here: while the countdown runs, a warning without reasons now beats a complete one
  // that arrives too late.
  private async readReport(runId: string): Promise<RunReport | null> {
    try {
      return await this.engine.getRun(runId);
    } catch (error) {
      this.log.warn(`decision.needed ${runId}: report not available: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
