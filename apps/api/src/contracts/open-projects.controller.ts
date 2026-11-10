// Thin HTTP layer for open projects (ADR-0018). Paths and operationIds: openapi.yaml, Contracts (001).
import { Body, Controller, Get, Headers, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { OnboardedGuard } from "../auth/onboarded.guard.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { uuidParam } from "../http/params.js";
import { requestIdOf } from "../http/request-id.js";
import { parsedOrThrow } from "../http/validation.js";
import { IdempotencyService } from "../idempotency/idempotency.service.js";
import { OpenProjectsService } from "./open-projects.service.js";

const publishBody = z.object({ version: z.number().int().min(1), acknowledgeLowVerifiability: z.boolean().default(false) });
const takeBody = z.object({
  version: z.number().int().min(1),
  snapshotHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  acknowledgeLowVerifiability: z.boolean().default(false),
});
const listQuery = z.object({ cursor: z.string().max(200).optional() });

// OnboardedGuard on the reads too, unlike other reads: decision 3 limits who sees these terms.
@UseGuards(OnboardedGuard)
@Controller()
export class OpenProjectsController {
  constructor(
    private readonly openProjects: OpenProjectsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get("open-projects")
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: unknown) {
    return this.openProjects.list(user.id, parsedOrThrow(listQuery.safeParse(query)).cursor);
  }

  @Get("open-projects/:contractId")
  get(@CurrentUser() user: AuthenticatedUser, @Param("contractId") id: string) {
    return this.openProjects.get(user.id, uuidParam(id));
  }

  @Post("contracts/:contractId\\:publish")
  async publish(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("contractId") id: string,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(publishBody.safeParse(body));
    const contractId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body }, async (tx) => ({
      status: 200,
      body: await this.openProjects.publish(tx, { user, requestId: requestIdOf(req) }, contractId, input.version, input.acknowledgeLowVerifiability),
    }));
    res.status(out.status);
    return out.body;
  }

  @Post("contracts/:contractId\\:unpublish")
  async unpublish(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("contractId") id: string,
  ) {
    const contractId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body: null }, async (tx) => ({
      status: 200,
      body: await this.openProjects.unpublish(tx, { user, requestId: requestIdOf(req) }, contractId),
    }));
    res.status(out.status);
    return out.body;
  }

  @Post("contracts/:contractId\\:take")
  async take(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key: string | undefined,
    @Param("contractId") id: string,
    @Body() body: unknown,
  ) {
    const input = parsedOrThrow(takeBody.safeParse(body));
    const contractId = uuidParam(id);
    const out = await this.idempotency.run({ userId: user.id, key, method: "POST", path: req.path, body }, async (tx) => ({
      status: 200,
      body: await this.openProjects.take(tx, { user, requestId: requestIdOf(req) }, contractId, input.version, input.snapshotHash, input.acknowledgeLowVerifiability),
    }));
    res.status(out.status);
    return out.body;
  }
}
