import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import canonicalize from "canonicalize";
import { and, eq } from "drizzle-orm";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import { idempotencyKeys } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";

export interface IdempotentRequest {
  readonly userId: string;
  readonly key: string | undefined;
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

export interface StoredResponse {
  readonly status: number;
  readonly body: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// errors.md: every POST that creates something or requests a transition carries an
// Idempotency-Key, and a replay returns the original response.
@Injectable()
export class IdempotencyService {
  constructor(@Inject(DB) private readonly db: Db) {}

  // For writes that are safe to retry without a key (If-Match, natural idempotency).
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  // Runs `effect` at most once per (user, key), inside ONE transaction that also holds the key.
  //
  // Why the same transaction: if the key were saved after the effect committed, a crash in
  // between would leave the effect done and the key missing, and the retry would do it twice.
  // If it were saved before, in its own transaction, a crash would leave the key and no effect,
  // and every retry would replay "nothing". Here both commit together or neither does.
  async run(req: IdempotentRequest, effect: (tx: Tx) => Promise<StoredResponse>): Promise<StoredResponse> {
    const key = req.key;
    if (key === undefined || !UUID.test(key)) {
      throw new ProblemException("VALIDATION_FAILED", 422, "Some fields need fixing", "Idempotency-Key must be a UUID", {
        issues: [{ path: "header.Idempotency-Key", message: "Required UUID" }],
      });
    }
    // The key alone is not enough: a client bug that reuses a key for a different request
    // must fail loudly instead of silently getting the first request's response.
    const requestHash = createHash("sha256")
      .update(canonicalize({ method: req.method, path: req.path, body: req.body ?? null }) ?? "")
      .digest("hex");

    return this.db.transaction(async (tx) => {
      // If another transaction holds the same key uncommitted, this INSERT waits on the
      // primary key until it commits or rolls back. Commit: we see the conflict and replay.
      // Rollback: our insert wins and we run the effect. No double execution either way.
      const inserted = await tx
        .insert(idempotencyKeys)
        .values({ userId: req.userId, key, requestHash })
        .onConflictDoNothing()
        .returning({ key: idempotencyKeys.key });

      if (inserted.length === 0) {
        const [existing] = await tx
          .select()
          .from(idempotencyKeys)
          .where(and(eq(idempotencyKeys.userId, req.userId), eq(idempotencyKeys.key, key)));
        if (existing === undefined || existing.responseStatus === null) {
          // Unreachable while the key and response are written in one transaction.
          throw new Error("Idempotency key without a stored response");
        }
        if (existing.requestHash !== requestHash) {
          throw new ProblemException(
            "IDEMPOTENCY_KEY_REUSED",
            409,
            "This request key was already used",
            "The same Idempotency-Key was sent with a different request. Use a new key for a new request.",
          );
        }
        return { status: existing.responseStatus, body: existing.responseBody };
      }

      const response = await effect(tx);
      await tx
        .update(idempotencyKeys)
        .set({ responseStatus: response.status, responseBody: response.body })
        .where(and(eq(idempotencyKeys.userId, req.userId), eq(idempotencyKeys.key, key)));
      return response;
    });
  }
}
