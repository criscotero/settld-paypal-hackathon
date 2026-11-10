// The form's side of schemas/checks/ai-check.v2.json (ADR-0010 decision 1, ADR-0019).
//
// A new criterion reads what is fixed here, not chosen in the form: the sources the evaluator can
// read. Offering others would promise a check that can only be UNCERTAIN; the delivery decides
// which of these exist, and an absent one is simply not read.
export const AI_SOURCES = ["HTTP_RESPONSE", "REPOSITORY", "FILES", "NOTES"] as const;

type Source = (typeof AI_SOURCES)[number] | "DIFF" | "SCREENSHOT" | "TEST_REPORT";

// What the form does not show is kept as it was: editing a title must not silently change what a
// criterion checks in a draft that came from elsewhere with other sources.
export interface KeptFields {
  sources: Source[] | null;
  repository: string | null;
}

export function keptFieldsOf(config: unknown): KeptFields {
  const c = config as { sources?: Source[]; repository?: string | null } | null;
  return { sources: c?.sources ?? null, repository: c?.repository ?? null };
}

export function aiCheckConfig(guidance: string, url: string, kept: KeptFields = { sources: null, repository: null }) {
  return {
    sources: kept.sources ?? [...AI_SOURCES],
    ...(kept.repository === null ? {} : { repository: kept.repository }),
    guidance: guidance.trim(),
    url: url.trim() === "" ? null : url.trim(),
  };
}

export function guidanceOf(config: unknown): string {
  const guidance = (config as { guidance?: unknown } | null)?.guidance;
  return typeof guidance === "string" ? guidance : "";
}
