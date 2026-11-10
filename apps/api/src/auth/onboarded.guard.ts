import { Injectable } from "@nestjs/common";
import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { ProblemException } from "../errors/problem.js";
import type { AuthenticatedRequest } from "./auth.guard.js";

// DM-INV-8, enforced on the server and not only by redirects in the web app: an agent or a
// curl call cannot skip onboarding by not loading the page. Runs after the global AuthGuard,
// so req.user is always set here.
@Injectable()
export class OnboardedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (user === undefined) throw new Error("OnboardedGuard needs AuthGuard to run first");
    if (!user.onboarded) {
      throw new ProblemException("ONBOARDING_INCOMPLETE", 403, "Finish setting up your account", "Complete your profile and connect PayPal first.");
    }
    return true;
  }
}
