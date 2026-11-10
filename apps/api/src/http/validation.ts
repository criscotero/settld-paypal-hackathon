import type { ZodSafeParseResult } from "zod";
import { ProblemException } from "../errors/problem.js";

// errors.md: VALIDATION_FAILED lists field paths in context.issues[].
export function parsedOrThrow<T>(result: ZodSafeParseResult<T>): T {
  if (result.success) return result.data;
  throw new ProblemException("VALIDATION_FAILED", 422, "Some fields need fixing", "The request body does not match the contract.", {
    issues: result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}
