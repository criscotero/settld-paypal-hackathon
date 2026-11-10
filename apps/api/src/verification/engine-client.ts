// Core API's side of internal-api.yaml (createRun, getRun). Only the verification module calls
// the Engine, and every call carries a fresh service token (SB-7).
import type { CriterionVerdict } from "../db/schema.js";
import { signServiceToken } from "./service-token.js";
import type { ServiceKeys } from "./service-token.js";

// internal-api.yaml#/components/schemas/RunRequest
export interface RunRequest {
  readonly runId: string;
  readonly submissionId: string;
  readonly milestoneId: string;
  readonly contractId: string;
  readonly lockedVersion: { readonly versionId: string; readonly snapshotHash: string };
  readonly attempt: number;
  readonly locale: "en" | "es";
  readonly deadlineAt: string;
  readonly criteria: readonly {
    readonly criterionId: string;
    readonly text: string;
    readonly level: "AUTOMATIC" | "AI_EVALUATED" | "HUMAN";
    readonly required: boolean;
    readonly checkType: string | null;
    readonly checkConfig: Record<string, unknown> | null;
  }[];
  // commitSha and fileHash travel as Core fixed them on delivery (ADR-0020): the Engine reads only those.
  readonly evidenceLinks: readonly { readonly kind: string; readonly url: string; readonly label?: string; readonly commitSha?: string; readonly fileHash?: string }[];
  readonly notes?: string;
}

// What the watchdog needs from getRun's Evidence Report (openapi.yaml, EvidenceReport).
export interface RunReport {
  readonly runId: string;
  readonly status: "QUEUED" | "RUNNING" | "COMPLETED" | "TIMED_OUT";
  readonly results: readonly { readonly criterionId: string; readonly verdict: CriterionVerdict["verdict"] | "PENDING"; readonly evidence: readonly unknown[]; readonly reason?: string; readonly injectionFlagged?: boolean; readonly checks?: readonly unknown[] }[];
  readonly reportHash: string | null;
}

// internal-api.yaml, suggestCriteria.
export interface SuggestCriteriaRequest {
  readonly title: string;
  readonly description: string;
  readonly contractTitle: string | null;
  readonly locale: "en" | "es";
  readonly requestedBy: string;
}

export interface EngineClient {
  // Resolves on 200 (already there) and 202 (created); the Engine treats both as success.
  createRun(request: RunRequest): Promise<void>;
  // null when the Engine has no such run (the dispatch never landed).
  getRun(runId: string): Promise<RunReport | null>;
  // What the Engine answers, unchecked: the caller validates it against the contract.
  suggestCriteria(request: SuggestCriteriaRequest): Promise<unknown>;
}

export const ENGINE_CLIENT = Symbol("ENGINE_CLIENT");

// The Engine did not answer, or answered 5xx: the call may or may not have happened. The only
// safe retry is the same request, and createRun is idempotent on runId, so the job retries.
export class EngineUnavailableError extends Error {
  // True only when the request never got through (connection refused, DNS). A timeout is false:
  // the Engine may have started working, and for a suggestion may have called the model.
  constructor(
    message: string,
    readonly neverReached = false,
  ) {
    super(message);
    this.name = "EngineUnavailableError";
  }
}

// The Engine answered and refused (4xx). The same request gets the same answer: an incident.
export class EngineRejectedError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "EngineRejectedError";
  }
}

const TIMEOUT_MS = 10_000;
// A model call, not a queue hand-off. Over the Engine's 50 s and under the web function's 60 s, so
// each layer gives up before the one above it and the person gets an answer, not a cut connection.
const SUGGEST_TIMEOUT_MS = 55_000;

export class HttpEngineClient implements EngineClient {
  constructor(
    private readonly baseUrl: string,
    private readonly keys: ServiceKeys,
  ) {}

  async createRun(request: RunRequest): Promise<void> {
    await this.call("PUT", `/internal/v1/runs/${request.runId}`, request);
  }

  async getRun(runId: string): Promise<RunReport | null> {
    const res = await this.call("GET", `/internal/v1/runs/${runId}`, undefined, [404]);
    return res.status === 404 ? null : ((await res.json()) as RunReport);
  }

  async suggestCriteria(request: SuggestCriteriaRequest): Promise<unknown> {
    const res = await this.call("POST", "/internal/v1/ai/criteria:suggest", request, [], SUGGEST_TIMEOUT_MS);
    return res.json();
  }

  private async call(method: string, path: string, body: unknown, allowed: number[] = [], timeoutMs = TIMEOUT_MS): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${await signServiceToken(this.keys)}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "TimeoutError";
      throw new EngineUnavailableError(`${method} ${path}: ${error instanceof Error ? error.message : String(error)}`, !timedOut);
    }
    if (res.ok || allowed.includes(res.status)) return res;
    const detail = await res.text().catch(() => "");
    if (res.status >= 500) throw new EngineUnavailableError(`${method} ${path}: ${String(res.status)} ${detail}`);
    throw new EngineRejectedError(`${method} ${path}: ${String(res.status)} ${detail}`, res.status);
  }
}
