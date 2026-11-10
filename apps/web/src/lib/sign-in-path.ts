// Where to send someone without a session who opened a direct link, so they come back to it after
// signing in. A link from a mail that ends on the dashboard would make them hunt for the decision
// while a countdown runs (ADR-0011). Only paths of this site: an absolute or protocol-relative
// value would make the sign-in page an open redirect. Callers pass a query rather than a fragment
// when the target matters: the server never sees a fragment.
export function isInternalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

export function signInPath(returnTo: string): string {
  return isInternalPath(returnTo) ? `/sign-in?redirect_url=${encodeURIComponent(returnTo)}` : "/sign-in";
}

// The same promise for someone who still has to finish setting up: the wizard ends at `next`.
export function onboardingEntry(next: string | undefined): string {
  return next !== undefined && isInternalPath(next) ? `/onboarding?next=${encodeURIComponent(next)}` : "/onboarding";
}
