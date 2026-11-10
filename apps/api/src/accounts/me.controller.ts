// Thin HTTP layer for the current user and onboarding (openapi.yaml: Accounts). Parses, then
// hands off to OnboardingService.
import { Body, Controller, Get, Headers, HttpCode, Post, Put, Req } from "@nestjs/common";
import type { Request } from "express";
import { z } from "zod";
import { CurrentUser } from "../auth/current-user.decorator.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { PROFESSIONS } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { requestIdOf } from "../http/request-id.js";
import { parsedOrThrow } from "../http/validation.js";
import { OnboardingService } from "./onboarding.service.js";
import type { OnboardingCaller } from "./onboarding.service.js";

const rolesBody = z.object({ roles: z.array(z.enum(["BUYER", "SELLER", "COLLABORATOR"])).min(1) });

// openapi.yaml: ProfessionalProfile (ADR-0009)
const professionalBody = z.object({
  headline: z.string().trim().max(80).nullable(),
  professions: z.array(z.enum(PROFESSIONS)).max(5).refine((a) => new Set(a).size === a.length, "Repeated profession"),
  skills: z.array(z.string().trim().min(1).max(40)).max(12).refine((a) => new Set(a).size === a.length, "Repeated skill"),
  bio: z.string().trim().max(400).nullable(),
  link: z.url().startsWith("https://").nullable(),
  inDirectory: z.boolean().default(false),
});

// openapi.yaml: ProfileInput
const profileBody = z
  .object({
    fullName: z.string().trim().min(2).max(120),
    displayName: z.string().trim().min(2).max(60),
    country: z.string().regex(/^[A-Z]{2}$/),
    locale: z.enum(["en", "es"]),
    accountType: z.enum(["INDIVIDUAL", "BUSINESS"]),
    businessName: z.string().trim().min(2).max(120).nullable().optional(),
    acceptTerms: z.literal(true),
  })
  .refine((p) => p.accountType === "INDIVIDUAL" || (p.businessName ?? null) !== null, { path: ["businessName"], message: "Required for a business account" });

const stateBody = z.object({ state: z.string().min(16) });
const codeBody = z.object({ code: z.string().min(1) });
const UUID = z.uuid();

@Controller("me")
export class MeController {
  constructor(private readonly onboarding: OnboardingService) {}

  private caller(user: AuthenticatedUser, req: Request): OnboardingCaller {
    return { userId: user.id, requestId: requestIdOf(req) };
  }

  // openapi.yaml: getMe -> User
  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.onboarding.me(user.id);
  }

  @Put("roles")
  setRoles(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Body() body: unknown) {
    return this.onboarding.setRoles(this.caller(user, req), parsedOrThrow(rolesBody.safeParse(body)).roles);
  }

  @Put("profile")
  setProfile(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Body() body: unknown) {
    const p = parsedOrThrow(profileBody.safeParse(body));
    return this.onboarding.setProfile(this.caller(user, req), { ...p, businessName: p.businessName ?? null });
  }

  @Put("professional-profile")
  setProfessional(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Body() body: unknown) {
    return this.onboarding.setProfessional(this.caller(user, req), parsedOrThrow(professionalBody.safeParse(body)));
  }

  @Post("connections/paypal\\:onboard")
  @HttpCode(200)
  startSeller(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Headers("idempotency-key") key: string | undefined) {
    // The key becomes part of PayPal-Request-Id, so a retried click returns the same link.
    if (key === undefined || !UUID.safeParse(key).success) {
      throw new ProblemException("VALIDATION_FAILED", 422, "Idempotency-Key is required", "Send a UUID in the Idempotency-Key header.");
    }
    return this.onboarding.startSellerOnboarding(this.caller(user, req), key);
  }

  @Post("connections/paypal\\:onboard-complete")
  @HttpCode(200)
  completeSeller(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.onboarding.completeSellerOnboarding(this.caller(user, req));
  }

  @Post("connections/paypal-login\\:start")
  @HttpCode(200)
  startLogin(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Body() body: unknown) {
    return this.onboarding.startPaypalLogin(this.caller(user, req), parsedOrThrow(stateBody.safeParse(body)).state);
  }

  @Post("connections/paypal-login\\:complete")
  @HttpCode(200)
  completeLogin(@CurrentUser() user: AuthenticatedUser, @Req() req: Request, @Body() body: unknown) {
    return this.onboarding.completePaypalLogin(this.caller(user, req), parsedOrThrow(codeBody.safeParse(body)).code);
  }
}
