// The only door to Core API (ADR-0005). "server-only" makes the build fail if a
// client component imports this: session tokens and the API URL never reach the browser.
import "server-only";
import { auth } from "@clerk/nextjs/server";
import createClient from "openapi-fetch";
import { notFound, redirect } from "next/navigation";
import type { paths } from "./api-schema";
import { toActionError } from "./problem";
import { onboardingEntry, signInPath } from "./sign-in-path";
import type { ActionError } from "./problem";

const baseUrl = process.env.SETTLD_API_URL ?? "http://localhost:4000/v1";

// The web app acts only as the person signed in with Clerk (ADR-0006). The dev header
// (ADR-0001, ADR-0003) is still accepted by Core API for e2e tests and curl, but the
// web app no longer sends it: there is no way to pick a dev user here.
async function identityHeaders(): Promise<Record<string, string>> {
  const token = await (await auth()).getToken();
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}

// A new client per request: the identity comes from this request's session, and a
// module-level client would leak one user's identity into another user's request.
export async function api() {
  return createClient<paths>({ baseUrl, headers: await identityHeaders() });
}

export class ApiError extends Error {
  constructor(readonly error: ActionError, readonly status: number) {
    super(error.message);
    this.name = "ApiError";
  }
}

// For reads in Server Components: 401 sends you to sign in, an
// unfinished onboarding sends you to finish it (DM-INV-8), 404 becomes the not-found page
// (Core API also answers 404 to non-parties, so we never reveal that a contract exists),
// anything else goes to error.tsx.
export function dataOrThrow<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.data !== undefined) return result.data;
  if (result.response.status === 401) redirect("/sign-in");
  if (result.response.status === 403 && toActionError(result.error).code === "ONBOARDING_INCOMPLETE") redirect("/onboarding");
  if (result.response.status === 404) notFound();
  throw new ApiError(toActionError(result.error), result.response.status);
}

// App pages start here: the current user, or a redirect to finish onboarding first
// (DM-INV-8). Core API also refuses contract writes until then; this only spares the
// user a screen full of buttons that would all answer 403.
//
// returnTo: where this person was going. A page reached from a link passes its own path, so the
// link survives signing in or finishing onboarding. Next.js does not tell a Server Component its
// own URL, which is why it is an argument and not read here.
export async function requireOnboardedMe(returnTo?: string) {
  const result = await (await api()).GET("/me");
  if (result.response.status === 401 && returnTo !== undefined) redirect(signInPath(returnTo));
  const me = dataOrThrow(result);
  if (!me.onboarding.completed) redirect(onboardingEntry(returnTo));
  return me;
}
