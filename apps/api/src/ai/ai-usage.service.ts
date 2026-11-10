import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import { DB } from "../db/database.js";
import type { Db, Tx } from "../db/database.js";
import { aiSuggestionUsage } from "../db/schema.js";
import { ProblemException } from "../errors/problem.js";
import { CLOCK } from "../payments/clock.js";
import type { Clock } from "../payments/clock.js";

// ADR-0016, decision 4. The public demo stays up until 2026-12-15 with a paid key and no one
// watching. Without these, one person or a bot could spend the budget before anyone judges it.
export const AI_SUGGESTIONS_PER_USER_PER_DAY = 20;
export const AI_SUGGESTIONS_PER_DAY = 200;

const GLOBAL = "global";
const DAY_MS = 86_400_000;

class CapReached extends Error {}

@Injectable()
export class AiUsageService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Takes one suggestion from both caps, or throws RATE_LIMITED having taken none.
  //
  // Reserved in its own short transaction that commits BEFORE the model is called. Inside one
  // transaction with the call, the row lock on "global" would make every suggestion in the system
  // wait for the one in flight. The price is that a call that then fails still counts, which errs
  // on the side the caps exist for: a failed call may have been billed too. `release` undoes it
  // when the request provably never got through.
  //
  // Returns the day it was counted on, because release has to undo that day even past midnight.
  async reserve(userId: string): Promise<string> {
    const now = this.clock.now();
    const day = now.toISOString().slice(0, 10);
    try {
      await this.db.transaction(async (tx) => {
        // Yours first, so that someone at their own cap never touches the row everyone shares.
        await this.take(tx, day, userId, AI_SUGGESTIONS_PER_USER_PER_DAY);
        // A throw here rolls back the line above: a refused request costs the person nothing.
        await this.take(tx, day, GLOBAL, AI_SUGGESTIONS_PER_DAY);
      });
      return day;
    } catch (error) {
      if (!(error instanceof CapReached)) throw error;
      const retryAfterSeconds = Math.ceil((DAY_MS - (now.getTime() % DAY_MS)) / 1000);
      throw new ProblemException("RATE_LIMITED", 429, "Suggestions are used up for today", "You can still write the criteria yourself, or ask again tomorrow.", { retryAfterSeconds });
    }
  }

  // An outage must not spend the budget: a few people retrying while the Engine is down would use
  // up the day's cap with nothing billed, and everyone would be refused after it recovers.
  async release(userId: string, day: string): Promise<void> {
    await this.db
      .update(aiSuggestionUsage)
      .set({ count: sql`greatest(${aiSuggestionUsage.count} - 1, 0)` })
      .where(and(eq(aiSuggestionUsage.day, day), inArray(aiSuggestionUsage.scope, [userId, GLOBAL])));
  }

  // One statement, so two requests cannot both read 19 and both write 20. The WHERE on the conflict
  // branch makes a full row return nothing instead of counting past the cap.
  private async take(tx: Tx, day: string, scope: string, cap: number): Promise<void> {
    const taken = await tx
      .insert(aiSuggestionUsage)
      .values({ day, scope, count: 1 })
      .onConflictDoUpdate({
        target: [aiSuggestionUsage.day, aiSuggestionUsage.scope],
        set: { count: sql`${aiSuggestionUsage.count} + 1` },
        where: sql`${aiSuggestionUsage.count} < ${cap}`,
      })
      .returning({ count: aiSuggestionUsage.count });
    if (taken.length === 0) throw new CapReached();
  }
}
