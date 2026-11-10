// Core API errors are RFC 9457 problems (errors.md) whose title and detail are
// already written for people. The UI shows them as they are instead of keeping
// its own copy per code: two sets of messages drift, and Core API knows why it refused.
import type { Schemas } from "./api-types";
import { friendlyPath } from "./field-path";

export interface ActionError {
  code: string;
  message: string;
  issues: string[];
  requestId: string | null;
}

// What every Server Action returns: null on success (most redirect instead).
export type ActionResult = ActionError | null;

function isProblem(body: unknown): body is Schemas["Problem"] {
  return typeof body === "object" && body !== null && typeof (body as { code?: unknown }).code === "string" && typeof (body as { title?: unknown }).title === "string";
}

export function toActionError(body: unknown): ActionError {
  if (!isProblem(body)) return { code: "INTERNAL", message: "Core API returned an unexpected response.", issues: [], requestId: null };
  const rawIssues = (body.context as { issues?: unknown } | undefined)?.issues;
  const issues = Array.isArray(rawIssues)
    ? rawIssues.map((i: { path?: unknown; message?: unknown }) => {
        const message = typeof i.message === "string" ? i.message : "invalid";
        return typeof i.path === "string" && i.path !== "" ? `${friendlyPath(i.path)}: ${message}` : message;
      })
    : [];
  return {
    code: body.code,
    message: body.detail ? `${body.title}. ${body.detail}` : body.title,
    issues,
    requestId: body.requestId,
  };
}
