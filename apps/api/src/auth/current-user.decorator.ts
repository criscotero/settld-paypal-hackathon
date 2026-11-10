import { createParamDecorator } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "./auth.guard.js";
import type { AuthenticatedUser } from "./user-directory.js";

// Reads the user that AuthGuard attached. Using it on a route without the guard
// is a programming error, so it fails loudly instead of returning undefined.
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  if (req.user === undefined) {
    throw new Error("CurrentUser used on a route without AuthGuard");
  }
  return req.user;
});
