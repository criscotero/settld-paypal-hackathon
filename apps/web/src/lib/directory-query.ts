import { PROFESSIONS } from "./professions";
import type { Profession } from "./professions";

// openapi.yaml, searchDirectory: q is at most 80 characters. Core API enforces the cursor's 200.
const MAX_QUERY = 80;
const MAX_CURSOR = 200;

type Raw = string | string[] | undefined;

export type DirectoryQuery = { q: string; profession: Profession | ""; cursor: string | undefined };

function first(value: Raw): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

// The URL is the page's state, so anyone can edit it. Core API answers a bad value with a 400, which
// would show the error page; a link that is merely stale should open the directory instead.
export function parseDirectoryQuery(raw: { q?: Raw; profession?: Raw; cursor?: Raw }): DirectoryQuery {
  const profession = first(raw.profession);
  const cursor = first(raw.cursor);
  return {
    q: first(raw.q).trim().slice(0, MAX_QUERY),
    profession: PROFESSIONS.includes(profession as Profession) ? (profession as Profession) : "",
    cursor: cursor === "" || cursor.length > MAX_CURSOR ? undefined : cursor,
  };
}

// A cursor only means something with the filters that produced it, so the link carries all three.
export function directoryHref(filters: Pick<DirectoryQuery, "q" | "profession">, cursor?: string): string {
  const params = new URLSearchParams();
  if (filters.q !== "") params.set("q", filters.q);
  if (filters.profession !== "") params.set("profession", filters.profession);
  if (cursor !== undefined) params.set("cursor", cursor);
  const query = params.toString();
  return query === "" ? "/directory" : `/directory?${query}`;
}
