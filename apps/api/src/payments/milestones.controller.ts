// Thin HTTP layer for 002 (milestones) and the objection paths of 004 that H2 implements.
// Paths and operationIds: openapi.yaml. Writes run inside IdempotencyService.run; the two
// funding calls talk to PayPal first and only then open the idempotent transaction.
import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { OnboardedGuard } from "../auth/onboarded.guard.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import type { Caller } from "../contracts/contracts.service.js";
import type { Tx } from "../db/database.js";
import { ProblemException } from "../errors/problem.js";
import { uuidParam } from "../http/params.js";
import { requestIdOf } from "../http/request-id.js";
import { parsedOrThrow } from "../http/validation.js";
import { IdempotencyService } from "../idempotency/idempotency.service.js";
import type { EvidenceLink } from "../db/schema.js";
import { DeliveryFilesService } from "../verification/delivery-files.service.js";
import { REPOSITORY_RESOLVER } from "../verification/repository-resolver.js";
import type { RepositoryResolver } from "../verification/repository-resolver.js";
import { MilestonesService } from "./milestones.service.js";

const humanDecisions = z.array(z.object({ criterionId: z.uuid(), decision: z.literal("APPROVED") })).default([]);
const approveBody = z.object({ humanDecisions });
const withdrawBody = z.object({ humanDecisions }).default({ humanDecisions: [] });
const confirmBody = z.object({ paypalOrderId: z.string().min(1).max(64) });
const cancelBody = z.object({ reason: z.string().min(1).max(2000) });
// trim: twenty spaces are not a written reason (constitution IX).
const contestBody = z.object({ reason: z.string().trim().min(20).max(5000) });
const ruleBody = z.object({ decision: z.enum(["RELEASE", "VOID"]), reason: z.string().trim().min(20).max(5000) });
const objectionBody = z.object({ criterionIds: z.array(z.uuid()).min(1), reason: z.string().min(20).max(5000) });
const submitBody = z.object({
  evidenceLinks: z
    .array(
      z.object({
        kind: z.enum(["PULL_REQUEST", "COMMIT", "CI_RUN", "URL", "OTHER", "REPOSITORY", "FILE"]),
        url: z.url(),
        label: z.string().max(140).optional(),
        commitSha: z.string().regex(/^[0-9a-f]{40}$/).nullish(),
        fileHash: z.string().regex(/^sha256:[0-9a-f]{64}$/).nullish(),
      }),
    )
    .min(1)
    .max(20),
  notes: z.string().max(5000).default(""),
});
type SubmittedLink = z.infer<typeof submitBody>["evidenceLinks"][number];

@Controller()
export class MilestonesController {
  constructor(
    private readonly milestones: MilestonesService,
    private readonly idempotency: IdempotencyService,
    private readonly deliveryFiles: DeliveryFilesService,
    @Inject(REPOSITORY_RESOLVER) private readonly repositories: RepositoryResolver,
  ) {}

  // ADR-0020 decision 1A, "copy on delivery": a repository is fixed at a commit and a file is
  // checked to belong to this milestone before the delivery exists. Outside the transaction on
  // purpose: GitHub can take seconds, and the milestone's row lock must not wait for it. Safe,
  // because delivery files are insert-only and a commit never changes.
  private async deliveredLinks(milestoneId: string, links: readonly SubmittedLink[]): Promise<EvidenceLink[]> {
    return Promise.all(
      links.map(async (link): Promise<EvidenceLink> => {
        const base = { kind: link.kind, url: link.url, ...(link.label === undefined ? {} : { label: link.label }) };
        if (link.kind === "REPOSITORY") {
          const repo = await this.repositories.resolve(link.url, link.commitSha);
          return { ...base, url: repo.url, commitSha: repo.commitSha };
        }
        if (link.kind === "FILE") {
          const row = link.fileHash ? await this.deliveryFiles.ofMilestone(milestoneId, link.fileHash) : undefined;
          if (row === undefined) throw new ProblemException("FILE_UNKNOWN", 422, "That file was not uploaded here", "Upload the .zip to this milestone, then deliver it.");
          return { ...base, url: this.deliveryFiles.view(row).url, fileHash: row.fileHash, label: link.label ?? row.name };
        }
        // commitSha and fileHash mean something only for their own kind: never stored elsewhere.
        return base;
      }),
    );
  }

  private caller(user: AuthenticatedUser, req: Request): Caller {
    return { user, requestId: requestIdOf(req) };
  }

  // Runs `effect` once per Idempotency-Key and replays the stored response on a retry.
  private async once(user: AuthenticatedUser, req: Request, res: Response, key: string | undefined, body: unknown, status: number, effect: (tx: Tx) => Promise<unknown>) {
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body: body ?? null }, async (tx) => ({ status, body: await effect(tx) }));
    res.status(out.status);
    return out.body;
  }

  @Get("milestones/:milestoneId")
  get(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Param("milestoneId") id: string) {
    return this.milestones.get(uuidParam(id), this.caller(user, req));
  }

  @Get("milestones/:milestoneId/payment-events")
  paymentEvents(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Param("milestoneId") id: string) {
    return this.milestones.paymentEvents(uuidParam(id), this.caller(user, req));
  }

  @Get("milestones/:milestoneId/submissions")
  listSubmissions(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Param("milestoneId") id: string) {
    return this.milestones.listSubmissions(uuidParam(id), this.caller(user, req));
  }

  @Get("objections")
  listEscalated(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.milestones.listEscalatedObjections(this.caller(user, req));
  }

  @Get("objections/:objectionId/case")
  objectionCase(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Param("objectionId") id: string) {
    return this.milestones.getObjectionCase(uuidParam(id), this.caller(user, req));
  }

  @UseGuards(OnboardedGuard)
  @Post("objections/:objectionId\\:contest")
  contest(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Param("objectionId") id: string, @Body() body: unknown) {
    const { reason } = parsedOrThrow(contestBody.safeParse(body));
    const objectionId = uuidParam(id);
    return this.once(user, req, res, key, body, 200, (tx) => this.milestones.contestObjection(tx, this.caller(user, req), objectionId, reason));
  }

  @UseGuards(OnboardedGuard)
  @Post("objections/:objectionId\\:rule")
  rule(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Param("objectionId") id: string, @Body() body: unknown) {
    const { decision, reason } = parsedOrThrow(ruleBody.safeParse(body));
    const objectionId = uuidParam(id);
    return this.once(user, req, res, key, body, 200, (tx) => this.milestones.ruleOnObjection(tx, this.caller(user, req), objectionId, decision, reason));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId\\:surrender")
  surrender(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Param("milestoneId") id: string) {
    const milestoneId = uuidParam(id);
    return this.once(user, req, res, key, null, 200, (tx) => this.milestones.surrender(tx, this.caller(user, req), milestoneId, ifMatch));
  }

  // Read by the seller, who has to know what to fix, and by the buyer, who wrote it.
  @Get("objections/:objectionId")
  getObjection(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Param("objectionId") id: string) {
    return this.milestones.getObjection(uuidParam(id), this.caller(user, req));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId/fund")
  async fund(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Param("milestoneId") id: string) {
    const milestoneId = uuidParam(id);
    const caller = this.caller(user, req);
    const order = await this.milestones.createOrder(caller, milestoneId);
    return this.once(user, req, res, key, null, 200, (tx) => this.milestones.recordOrder(tx, caller, milestoneId, order));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId/fund\\:confirm")
  async confirmFunding(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("milestoneId") id: string,
    @Body() body: unknown,
  ) {
    const { paypalOrderId } = parsedOrThrow(confirmBody.safeParse(body));
    const milestoneId = uuidParam(id);
    const caller = this.caller(user, req);
    const authorized = await this.milestones.authorize(caller, milestoneId, paypalOrderId);
    try {
      return await this.once(user, req, res, key, body, 200, (tx) => this.milestones.confirmFunding(tx, caller, milestoneId, authorized));
    } catch (error) {
      // PayPal already holds the buyer's money for this authorization. If it cannot fund the
      // milestone, it is recorded and voided before the error goes back (H2 review, finding 6).
      if (authorized !== null && error instanceof ProblemException) await this.milestones.voidOrphan(milestoneId, authorized, caller.requestId);
      throw error;
    }
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId\\:start")
  start(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Param("milestoneId") id: string) {
    const milestoneId = uuidParam(id);
    return this.once(user, req, res, key, null, 200, (tx) => this.milestones.start(tx, this.caller(user, req), milestoneId, ifMatch));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId/submissions")
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Param("milestoneId") id: string,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(submitBody.safeParse(body));
    const milestoneId = uuidParam(id);
    // A stranger learns nothing and costs nothing: the same NOT_FOUND as any read, before any
    // call to GitHub or lookup of a file. submit() checks SELLER again under the row lock.
    await this.milestones.partyRoleOf(milestoneId, this.caller(user, req));
    const links = await this.deliveredLinks(milestoneId, input.evidenceLinks);
    return this.once(user, req, res, key, body, 201, (tx) => this.milestones.submit(tx, this.caller(user, req), milestoneId, ifMatch, links, input.notes));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId/approve")
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Param("milestoneId") id: string,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(approveBody.safeParse(body));
    const milestoneId = uuidParam(id);
    const ids = input.humanDecisions.map((d) => d.criterionId);
    return this.once(user, req, res, key, body, 200, (tx) => this.milestones.approve(tx, this.caller(user, req), milestoneId, ifMatch, ids));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId/objections")
  raiseObjection(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Param("milestoneId") id: string,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(objectionBody.safeParse(body));
    const milestoneId = uuidParam(id);
    return this.once(user, req, res, key, body, 201, (tx) => this.milestones.raiseObjection(tx, this.caller(user, req), milestoneId, ifMatch, input.criterionIds, input.reason));
  }

  @UseGuards(OnboardedGuard)
  @Post("objections/:objectionId\\:withdraw")
  withdraw(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Param("objectionId") id: string, @Body() body: unknown) {
    const input = parsedOrThrow(withdrawBody.safeParse(body ?? undefined));
    const objectionId = uuidParam(id);
    const ids = input.humanDecisions.map((d) => d.criterionId);
    return this.once(user, req, res, key, body, 200, (tx) => this.milestones.withdrawObjection(tx, this.caller(user, req), objectionId, ids));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId\\:accept-partial")
  acceptPartial(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Headers("idempotency-key") key: string | undefined, @Headers("if-match") ifMatch: string | undefined, @Param("milestoneId") id: string) {
    const milestoneId = uuidParam(id);
    return this.once(user, req, res, key, null, 200, (tx) => this.milestones.acceptPartial(tx, this.caller(user, req), milestoneId, ifMatch));
  }

  @UseGuards(OnboardedGuard)
  @Post("milestones/:milestoneId\\:cancel")
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("if-match") ifMatch: string | undefined,
    @Param("milestoneId") id: string,
    @Body() body: unknown,
  ) {
    const { reason } = parsedOrThrow(cancelBody.safeParse(body));
    const milestoneId = uuidParam(id);
    return this.once(user, req, res, key, body, 200, (tx) => this.milestones.cancel(tx, this.caller(user, req), milestoneId, ifMatch, reason));
  }
}
