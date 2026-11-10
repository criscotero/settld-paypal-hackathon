// The parties' window on verification (openapi.yaml, getEvidenceReport). The report itself stays
// in the Engine; see VerificationService.evidenceReport.
import { Controller, Get, Param, Req } from "@nestjs/common";
import type { Request } from "express";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { uuidParam } from "../http/params.js";
import { requestIdOf } from "../http/request-id.js";
import { VerificationService } from "./verification.service.js";

@Controller()
export class VerificationController {
  constructor(private readonly verification: VerificationService) {}

  @Get("verification-runs/:runId")
  report(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Param("runId") runId: string) {
    return this.verification.evidenceReport(uuidParam(runId), { user, requestId: requestIdOf(req) });
  }
}
