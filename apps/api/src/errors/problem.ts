// errors.md: every API error is RFC 9457 problem details with a stable `code`.

// errors.md: Codes. Add here only codes that exist in the contract.
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_TRANSITION"
  | "GUARD_FAILED"
  | "STALE_STATE"
  | "VERSION_HASH_MISMATCH"
  | "IDEMPOTENCY_KEY_REUSED"
  | "PAYPAL_NOT_CONNECTED"
  | "PAYPAL_UNAVAILABLE"
  | "ENGINE_UNAVAILABLE"
  | "AI_UNAVAILABLE"
  | "ONBOARDING_INCOMPLETE"
  | "RATE_LIMITED"
  // errors.md 0.3.0 (ADR-0019, ADR-0020): delivery files and repositories.
  | "FILE_TOO_LARGE"
  | "FILE_NOT_ZIP"
  | "FILE_UNSAFE"
  | "FILE_UNKNOWN"
  | "REPOSITORY_UNREADABLE"
  | "INTERNAL";

export class ProblemException extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
    readonly context?: Record<string, unknown>,
  ) {
    super(detail ?? title);
    this.name = "ProblemException";
  }
}

export function unauthenticated(detail: string): ProblemException {
  // Constitution XII: say what happened and what to do next.
  return new ProblemException("UNAUTHENTICATED", 401, "Sign in to continue", detail);
}
