import { Inject, Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { unauthenticated } from "../errors/problem.js";
import type { AuthConfig } from "./auth-config.js";
import { SERVICE_ROUTE } from "./service-route.decorator.js";
import { AUTH_CONFIG } from "./auth.tokens.js";
import type { IdentityProvider } from "./identity-provider.js";
import { IDENTITY_PROVIDER } from "./identity-provider.js";
import type { AuthenticatedUser, UserDirectory } from "./user-directory.js";
import { USER_DIRECTORY } from "./user-directory.js";

export const DEV_USER_HEADER = "x-settld-dev-user"; // openapi.yaml: securitySchemes.devUser

// User.id is a UUID (domain-model.md). Rejecting anything else here means a
// malformed header never reaches the database as a cast error (500 instead of 401).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

export type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

// Answers one question: who is calling? Whether they may act on a contract
// (SB-7 party check) is authorization, and lives in each resource.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
    @Inject(USER_DIRECTORY) private readonly users: UserDirectory,
    @Inject(IDENTITY_PROVIDER) private readonly identity: IdentityProvider,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Service-to-service routes authenticate with a service token, checked by the route.
    if (this.reflector.getAllAndOverride<boolean>(SERVICE_ROUTE, [context.getHandler(), context.getClass()])) return true;
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    req.user = await this.authenticate(req);
    return true;
  }

  private async authenticate(req: Request): Promise<AuthenticatedUser> {
    const authorization = req.header("authorization");
    // A request that sends a Bearer token is judged by that token alone. Falling back to the
    // dev header after a bad token would let one request carry two identities.
    if (authorization !== undefined) return this.fromBearer(authorization);
    return this.fromDevHeader(req);
  }

  // ADR-0006: Clerk session token. Roles still come from our User row, never from the token.
  private async fromBearer(authorization: string): Promise<AuthenticatedUser> {
    const token = BEARER.exec(authorization)?.[1];
    if (token === undefined) throw unauthenticated("Send Authorization: Bearer <session token>.");
    const subject = await this.identity.verify(token);
    if (subject === null) throw unauthenticated("Invalid or expired session.");
    return this.users.findOrProvision(subject, () => this.identity.profile(subject));
  }

  private async fromDevHeader(req: Request): Promise<AuthenticatedUser> {
    if (!this.config.devAuthEnabled) {
      // With dev mode off the header is ignored, not rejected with a special error:
      // production must not even hint that it exists.
      throw unauthenticated("No valid session.");
    }
    const userId = req.header(DEV_USER_HEADER);
    if (userId === undefined || !UUID.test(userId)) {
      throw unauthenticated(`Send ${DEV_USER_HEADER} with a User id (dev mode).`);
    }
    // Roles come from the directory, never from the request (ADR-0001): the header
    // says who you are, not what you may do.
    const user = await this.users.findById(userId);
    if (user === null) {
      throw unauthenticated("No user with that id.");
    }
    return user;
  }
}
