export type ListingState = "NOT_LISTED" | "OPEN" | "OVERDUE" | "EXPIRED";

// Only decides what to show. Core API re-checks at the moment of publishing or taking, so a page left
// open past the deadline gets a clear refusal, never a stale success.
//
// OVERDUE: still listed and frozen, but a due date passed, so Core API hides it from sellers. The
// buyer must not go on waiting for someone who can no longer see it.
export function listingState(publishedUntil: string | null, now: Date, dueDates: readonly string[] = []): ListingState {
  if (publishedUntil === null) return "NOT_LISTED";
  if (new Date(publishedUntil) <= now) return "EXPIRED";
  const today = now.toISOString().slice(0, 10);
  return dueDates.some((d) => d <= today) ? "OVERDUE" : "OPEN";
}

// While listed, nobody can be invited and nothing can be edited (DM-INV-10).
export function isListed(state: ListingState): boolean {
  return state === "OPEN" || state === "OVERDUE";
}

const MAX_CURSOR = 200; // openapi.yaml: Cursor

// The URL can be edited. A bad value would be a 422 and the error page; a stale link should open the list.
export function parseOpenProjectsCursor(raw: string | string[] | undefined): string | undefined {
  const cursor = Array.isArray(raw) ? raw[0] : raw;
  return cursor === undefined || cursor === "" || cursor.length > MAX_CURSOR ? undefined : cursor;
}

export function openProjectsHref(cursor?: string): string {
  return cursor === undefined ? "/contracts/open" : `/contracts/open?cursor=${encodeURIComponent(cursor)}`;
}
