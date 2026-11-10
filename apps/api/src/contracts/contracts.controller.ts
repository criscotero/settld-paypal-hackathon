// Thin HTTP layer: parse, call the service inside an idempotent transaction, map the status.
// Paths and operationIds: openapi.yaml, Contracts (001).
import { Body, Controller, Get, Headers, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { OnboardedGuard } from "../auth/onboarded.guard.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { uuidParam } from "../http/params.js";
import { requestIdOf } from "../http/request-id.js";
import { parsedOrThrow } from "../http/validation.js";
import { IdempotencyService } from "../idempotency/idempotency.service.js";
import { ContractsService } from "./contracts.service.js";
import type { Caller } from "./contracts.service.js";
import { parseDraftInput } from "./draft-input.js";
import { InvitationsService } from "./invitations.service.js";

const approveBody = z.object({
  snapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  acknowledgeLowVerifiability: z.boolean().default(false),
});
const inviteBody = z.object({ email: z.email(), locale: z.enum(["en", "es"]).optional() });
const listQuery = z.object({ role: z.enum(["BUYER", "SELLER", "COLLABORATOR"]).optional(), cursor: z.uuid().optional() });
const teamBody = z.object({ userId: z.uuid() });

function versionParam(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return 0; // version 0 never exists -> NOT_FOUND downstream
  return n;
}

@Controller()
export class ContractsController {
  constructor(
    private readonly contracts: ContractsService,
    private readonly invitations: InvitationsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private caller(user: AuthenticatedUser, req: Request): Caller {
    return { user, requestId: requestIdOf(req) };
  }

  @Get("contracts")
  list(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Query() query: unknown) {
    const q = parsedOrThrow(listQuery.safeParse(query));
    return this.contracts.list(this.caller(user, req), q.role, q.cursor);
  }

  @UseGuards(OnboardedGuard) // DM-INV-8: reads stay open, writes need a finished onboarding
  @Post("contracts")
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(parseDraftInput(body));
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body }, async (tx) => ({
      status: 201,
      body: await this.contracts.create(tx, this.caller(user, req), input),
    }));
    res.status(out.status);
    return out.body;
  }

  @Get("contracts/:contractId")
  get(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Param("contractId") id: string) {
    return this.contracts.get(uuidParam(id), this.caller(user, req));
  }

  // No Idempotency-Key in the contract: If-Match already makes a retry safe (a replay with
  // the old version number gets STALE_STATE instead of applying twice).
  @UseGuards(OnboardedGuard)
  @Put("contracts/:contractId/draft")
  async replaceDraft(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Param("contractId") id: string,
    @Headers("if-match") ifMatch: string | undefined,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(parseDraftInput(body));
    const contractId = uuidParam(id);
    return this.idempotency.transaction((tx) => this.contracts.replaceDraft(tx, this.caller(user, req), contractId, ifMatch, input));
  }

  @UseGuards(OnboardedGuard)
  @Post("contracts/:contractId/draft\\:submit")
  async submit(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("contractId") id: string,
  ) {
    const contractId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body: null }, async (tx) => ({
      status: 200,
      body: await this.contracts.submit(tx, this.caller(user, req), contractId),
    }));
    res.status(out.status);
    return out.body;
  }

  @UseGuards(OnboardedGuard)
  @Post("contracts/:contractId/invitations")
  async invite(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("contractId") id: string,
    @Body() body: unknown,
  ) {
    const { email } = parsedOrThrow(inviteBody.safeParse(body));
    const contractId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body }, async (tx) => {
      await this.invitations.invite(tx, this.caller(user, req), contractId, email);
      return { status: 202, body: null };
    });
    res.status(out.status);
    return out.body ?? undefined;
  }

  // ADR-0009: the seller adds a directory user as a collaborator party.
  @UseGuards(OnboardedGuard)
  @Post("contracts/:contractId/team")
  async addTeamMember(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("contractId") id: string,
    @Body() body: unknown,
  ) {
    const { userId } = parsedOrThrow(teamBody.safeParse(body));
    const contractId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body }, async (tx) => ({
      status: 201,
      body: await this.contracts.addTeamMember(tx, this.caller(user, req), contractId, userId),
    }));
    res.status(out.status);
    return out.body;
  }

  @UseGuards(OnboardedGuard)
  @Post("invitations/:token\\:accept")
  async accept(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("token") token: string) {
    res.status(200);
    return this.invitations.accept(this.caller(user, req), token);
  }

  // listMyInvitations / acceptMyInvitation (openapi 0.8.0): the seller's own invitations, by
  // verified email instead of the link. Here and not in MeController because Invitation belongs
  // to 001 (contracts), and the accept rules live in InvitationsService.
  @UseGuards(OnboardedGuard)
  @Get("me/invitations")
  async myInvitations(@CurrentUser() user: AuthenticatedUser) {
    return this.invitations.listMine(user.id);
  }

  @UseGuards(OnboardedGuard)
  @Get("me/invitations/:invitationId")
  async previewMine(@CurrentUser() user: AuthenticatedUser, @Param("invitationId") id: string) {
    return this.invitations.previewMine(user.id, uuidParam(id));
  }

  @UseGuards(OnboardedGuard)
  @Post("me/invitations/:invitationId\\:accept")
  async acceptMine(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Res({ passthrough: true }) res: Response, @Param("invitationId") id: string) {
    const invitationId = uuidParam(id);
    res.status(200);
    return this.invitations.acceptMine(this.caller(user, req), invitationId);
  }

  @UseGuards(OnboardedGuard)
  @Post("contracts/:contractId/versions/:version\\:approve")
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("contractId") id: string,
    @Param("version") version: string,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(approveBody.safeParse(body));
    const contractId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body }, async (tx) => ({
      status: 200,
      body: await this.contracts.approve(tx, this.caller(user, req), contractId, versionParam(version), input.snapshotHash, input.acknowledgeLowVerifiability),
    }));
    res.status(out.status);
    return out.body;
  }
}
