// How a person becomes a Reviewer (ADR-0015, DM-INV-9). Applying grants nothing. The permission is
// the role, and only an ADMIN who is not the applicant can add it, in the same transaction as the
// status, so the two can never disagree.
//
// Why a Reviewer is not simply a role you choose: a ruling moves money and cannot be undone. A buyer
// with a second account could otherwise rule on their own dispute.
import { Body, Controller, Get, Headers, Inject, Injectable, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { and, asc, eq, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { z } from "zod";
import { recordAudit } from "../audit/audit.js";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { OnboardedGuard } from "../auth/onboarded.guard.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import { REVIEWER_APPLICATION_STATUSES, reviewerApplications, users } from "../db/schema.js";
import type { ReviewerApplicationStatus } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { notFound, uuidParam } from "../http/params.js";
import { requestIdOf } from "../http/request-id.js";
import { parsedOrThrow } from "../http/validation.js";
import { IdempotencyService } from "../idempotency/idempotency.service.js";
import { enqueueEvent } from "../outbox/outbox.js";
import { CLOCK } from "../payments/clock.js";
import type { Clock } from "../payments/clock.js";
import { JOB_SCHEDULER } from "../payments/job-scheduler.js";
import type { JobScheduler } from "../payments/job-scheduler.js";
import { paypalReady } from "./onboarding.js";

type ApplicationRow = typeof reviewerApplications.$inferSelect;
type Decision = "APPROVE" | "REJECT" | "SUSPEND" | "REACTIVATE";

const REAPPLY_AFTER_MS = 30 * 24 * 3_600_000;

// What each decision is allowed from, what it leads to, and what it does to the role.
const DECISIONS: Record<Decision, { from: ReviewerApplicationStatus; to: ReviewerApplicationStatus; role: "ADD" | "REMOVE" | "KEEP" }> = {
  APPROVE: { from: "PENDING", to: "APPROVED", role: "ADD" },
  REJECT: { from: "PENDING", to: "REJECTED", role: "KEEP" },
  SUSPEND: { from: "APPROVED", to: "SUSPENDED", role: "REMOVE" },
  REACTIVATE: { from: "SUSPENDED", to: "APPROVED", role: "ADD" },
};

function canApplyAgainAt(row: ApplicationRow): Date | null {
  return row.status === "REJECTED" && row.decidedAt !== null ? new Date(row.decidedAt.getTime() + REAPPLY_AFTER_MS) : null;
}

export function applicationStatusView(row: ApplicationRow) {
  return {
    id: row.id,
    status: row.status,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    canApplyAgainAt: canApplyAgainAt(row)?.toISOString() ?? null,
  };
}

@Injectable()
export class ReviewerApplicationsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(JOB_SCHEDULER) private readonly jobs: JobScheduler,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async apply(tx: Tx, userId: string, requestId: string, motivation: string | null) {
    // The user row is the lock: two tabs applying at once wait here, and the second finds the first.
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (user === undefined) throw new Error(`User ${userId} vanished after authentication`);
    const [existing] = await tx.select().from(reviewerApplications).where(eq(reviewerApplications.userId, userId));
    const now = this.clock.now();
    if (existing?.status === "PENDING" || existing?.status === "APPROVED") return applicationStatusView(existing);
    if (existing?.status === "SUSPENDED") throw new ProblemException("INVALID_TRANSITION", 409, "Your reviewer account is suspended", "Applying again does not lift a suspension. Contact Settld.");
    if (existing === undefined && user.roles.includes("REVIEWER")) throw new ProblemException("INVALID_TRANSITION", 409, "You are already a reviewer", "Settld granted you this role directly.");
    const again = existing === undefined ? null : canApplyAgainAt(existing);
    if (again !== null && now < again) throw new ProblemException("INVALID_TRANSITION", 409, "You can apply again later", `After a rejection you can apply again from ${again.toISOString().slice(0, 10)}.`, { canApplyAgainAt: again.toISOString() });

    const [row] =
      existing === undefined
        ? await tx.insert(reviewerApplications).values({ userId, motivation, createdAt: now, updatedAt: now }).returning()
        : await tx.update(reviewerApplications).set({ status: "PENDING", motivation, decidedBy: null, decidedAt: null, decisionReason: null, updatedAt: now }).where(eq(reviewerApplications.id, existing.id)).returning();
    if (row === undefined) throw new Error("write returned nothing");

    const actor = { type: "USER", id: userId } as const;
    await recordAudit(tx, { actor, action: "reviewer_application.submitted", entityType: "ReviewerApplication", entityId: row.id, before: existing === undefined ? null : { status: existing.status }, after: { status: "PENDING" }, requestId });
    await enqueueEvent(tx, { type: "accounts.reviewer_application.submitted", actor, correlationId: requestId, payload: { applicationId: row.id } });
    const admins = await tx.select({ id: users.id }).from(users).where(sql`'ADMIN' = ANY(${users.roles})`);
    const round = now.toISOString();
    await this.jobs.send(tx, {
      queue: "notifications.send",
      singletonKey: `notify:reviewer.application_submitted:${row.id}:${round}`,
      data: { templateKey: "reviewer.application_submitted", recipientIds: [userId, ...admins.map((a) => a.id).filter((id) => id !== userId)], deepLink: "/profile", params: { applicationId: row.id, round } },
    });
    return applicationStatusView(row);
  }

  async list(caller: AuthenticatedUser, status: ReviewerApplicationStatus | undefined) {
    requireAdmin(caller);
    const rows = await this.db
      .select({ row: reviewerApplications, user: users })
      .from(reviewerApplications)
      .innerJoin(users, eq(users.id, reviewerApplications.userId))
      .where(status === undefined ? undefined : and(eq(reviewerApplications.status, status)))
      .orderBy(asc(reviewerApplications.updatedAt))
      .limit(100);
    return { items: rows.map(({ row, user }) => adminView(row, user)) };
  }

  async decide(tx: Tx, caller: AuthenticatedUser, requestId: string, applicationId: string, decision: Decision, reason: string) {
    requireAdmin(caller);
    const [found] = await tx.select({ userId: reviewerApplications.userId }).from(reviewerApplications).where(eq(reviewerApplications.id, applicationId));
    if (found === undefined) throw notFound();
    // Nobody approves themselves, or the role would be self-assigned with one more click.
    if (found.userId === caller.id) throw new ProblemException("FORBIDDEN", 403, "This is your own application", "Another administrator has to decide it.");
    // User first, then application: the same order as apply, so the two can never deadlock.
    const [user] = await tx.select().from(users).where(eq(users.id, found.userId)).for("update");
    const [row] = await tx.select().from(reviewerApplications).where(eq(reviewerApplications.id, applicationId));
    if (user === undefined || row === undefined) throw notFound();
    const rule = DECISIONS[decision];
    if (row.status !== rule.from) throw new ProblemException("INVALID_TRANSITION", 409, "This application changed", `It is ${row.status}; ${decision} applies only from ${rule.from}.`, { status: row.status });

    const now = this.clock.now();
    const [updated] = await tx.update(reviewerApplications).set({ status: rule.to, decidedBy: caller.id, decidedAt: now, decisionReason: reason, updatedAt: now }).where(eq(reviewerApplications.id, applicationId)).returning();
    if (updated === undefined) throw new Error("update returned nothing");
    const roles = rule.role === "ADD" ? [...new Set([...user.roles, "REVIEWER"])] : rule.role === "REMOVE" ? user.roles.filter((r) => r !== "REVIEWER") : user.roles;
    const [changed] = await tx.update(users).set({ roles }).where(eq(users.id, user.id)).returning();
    if (changed === undefined) throw new Error("update returned nothing");

    const actor = { type: "USER", id: caller.id } as const;
    await recordAudit(tx, { actor, action: "reviewer_application.decided", entityType: "ReviewerApplication", entityId: row.id, before: { status: row.status, roles: user.roles }, after: { status: rule.to, roles }, reason, requestId });
    await enqueueEvent(tx, { type: "accounts.reviewer_application.decided", actor, correlationId: requestId, payload: { applicationId: row.id, status: rule.to, reason } });
    const round = now.toISOString();
    await this.jobs.send(tx, {
      queue: "notifications.send",
      singletonKey: `notify:reviewer.application_decided:${row.id}:${round}`,
      data: { templateKey: "reviewer.application_decided", recipientIds: [user.id], deepLink: "/profile", params: { applicationId: row.id, round } },
    });
    return adminView(updated, changed);
  }
}

function requireAdmin(caller: AuthenticatedUser) {
  if (!caller.roles.includes("ADMIN")) throw new ProblemException("FORBIDDEN", 403, "Only an administrator can do this", "Reviewer applications are decided by Settld.");
}

function adminView(row: ApplicationRow, user: typeof users.$inferSelect) {
  return { ...applicationStatusView(row), userId: user.id, email: user.email, displayName: user.displayName, paypalReady: paypalReady(user), motivation: row.motivation };
}

const applyBody = z.object({ motivation: z.string().trim().max(1000).optional() }).default({});
// trim: spaces are not a written reason (constitution IX).
const decideBody = z.object({ decision: z.enum(["APPROVE", "REJECT", "SUSPEND", "REACTIVATE"]), reason: z.string().trim().min(10).max(2000) });
const listQuery = z.object({ status: z.enum(REVIEWER_APPLICATION_STATUSES).optional() });

@Controller()
export class ReviewerApplicationsController {
  constructor(
    private readonly applications: ReviewerApplicationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  // No OnboardedGuard: this is an option of the onboarding itself (ADR-0015). It grants nothing.
  @Post("me/reviewer-application")
  async apply(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Body() body: unknown) {
    const { motivation } = parsedOrThrow(applyBody.safeParse(body ?? undefined));
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body: body ?? null }, async (tx) => ({
      status: 200,
      body: await this.applications.apply(tx, user.id, requestIdOf(req), motivation === undefined || motivation === "" ? null : motivation),
    }));
    res.status(out.status);
    return out.body;
  }

  @Get("reviewer-applications")
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.applications.list(user, parsedOrThrow(listQuery.safeParse(query)).status);
  }

  @UseGuards(OnboardedGuard)
  @Post("reviewer-applications/:applicationId\\:decide")
  async decide(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Param("applicationId") id: string, @Body() body: unknown) {
    const { decision, reason } = parsedOrThrow(decideBody.safeParse(body));
    const applicationId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body }, async (tx) => ({ status: 200, body: await this.applications.decide(tx, user, requestIdOf(req), applicationId, decision, reason) }));
    res.status(out.status);
    return out.body;
  }
}
