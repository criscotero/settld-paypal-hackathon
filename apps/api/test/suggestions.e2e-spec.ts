// POST /ai/criteria:suggest (ADR-0016): the person's side of the compiler. The Engine is a fake here;
// what the model answers and how it is validated is tested in apps/engine/tests/test_suggestions.py.
import { eq, sql } from "drizzle-orm";
import { aiSuggestionUsage, contracts, users } from "../src/db/schema.js";
import { AI_SUGGESTIONS_PER_DAY, AI_SUGGESTIONS_PER_USER_PER_DAY } from "../src/ai/ai-usage.service.js";
import { as, bootTestApp, createUser } from "./support/app.js";
import type { TestContext } from "./support/app.js";

const body = { title: "Landing page", description: "A landing page at https://acme.example", locale: "en" };

describe("Criteria suggestions (ADR-0016)", () => {
  let ctx: TestContext;
  let user: string;

  beforeAll(async () => {
    ctx = await bootTestApp();
    // A stretch of days of its own: settld_test outlives each run, and the global cap is per day.
    ctx.clock.advance(Math.ceil(Math.random() * 1_000_000) * 86_400_000);
  });
  afterAll(async () => {
    await ctx.close();
  });
  beforeEach(async () => {
    ctx.clock.advance(2 * 86_400_000);
    ctx.engine.down = false;
    ctx.engine.suggestionTimesOut = false;
    ctx.engine.suggestions.length = 0;
    user = await createUser(ctx.db, ["BUYER"]);
  });

  it("answers the proposal, marked as AI-suggested, with its verifiability score", async () => {
    const res = await as(ctx, user).post("/ai/criteria:suggest", body);
    expect(res.status).toBe(200);
    const out = res.body as { suggestionId: string; criteria: { origin: string; aiSuggestionId: string; rationale: string }[]; verifiabilityScore: number; ambiguities: unknown[]; notes: string };
    expect(out.criteria).toHaveLength(2);
    for (const c of out.criteria) {
      expect(c.origin).toBe("AI_SUGGESTED");
      expect(c.aiSuggestionId).toBe(out.suggestionId);
    }
    expect(out.verifiabilityScore).toBe(0.5);
    expect(out.ambiguities).toHaveLength(1);
  });

  it("tells the Engine who asked, and sends only what the person wrote", async () => {
    await as(ctx, user).post("/ai/criteria:suggest", { ...body, contractTitle: "Launch" });
    expect(ctx.engine.suggestions[0]).toEqual({ title: "Landing page", description: body.description, contractTitle: "Launch", locale: "en", requestedBy: user });
  });

  it("works with only a title, in English by default", async () => {
    const res = await as(ctx, user).post("/ai/criteria:suggest", { title: "Landing page" });
    expect(res.status).toBe(200);
    expect(ctx.engine.suggestions[0]).toMatchObject({ description: "", locale: "en" });
  });

  it("saves nothing to any contract", async () => {
    const before = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(contracts);
    await as(ctx, user).post("/ai/criteria:suggest", body);
    const after = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(contracts);
    expect(after).toEqual(before);
  });

  it("rejects a request with no title", async () => {
    const res = await as(ctx, user).post("/ai/criteria:suggest", { description: "x" });
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe("VALIDATION_FAILED");
    expect(ctx.engine.suggestions).toHaveLength(0);
  });

  it("needs a finished onboarding", async () => {
    await ctx.db.update(users).set({ onboardingCompletedAt: null }).where(eq(users.id, user));
    const res = await as(ctx, user).post("/ai/criteria:suggest", body);
    expect(res.status).toBe(403);
    expect(ctx.engine.suggestions).toHaveLength(0);
  });

  it("says AI_UNAVAILABLE when the Engine cannot answer, and manual editing depends on nothing here", async () => {
    ctx.engine.down = true;
    const res = await as(ctx, user).post("/ai/criteria:suggest", body);
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe("AI_UNAVAILABLE");
  });

  it("says AI_UNAVAILABLE when the Engine answers something off contract", async () => {
    ctx.engine.nextSuggestion = { nonsense: true };
    const res = await as(ctx, user).post("/ai/criteria:suggest", body);
    expect(res.status).toBe(503);
    expect((res.body as { code: string }).code).toBe("AI_UNAVAILABLE");
  });

  describe("usage caps (ADR-0016, decision 4)", () => {
    it("stops a person at the daily cap, with when to come back, and without calling the Engine", async () => {
      for (let i = 0; i < AI_SUGGESTIONS_PER_USER_PER_DAY; i++) {
        expect((await as(ctx, user).post("/ai/criteria:suggest", body)).status).toBe(200);
      }
      const res = await as(ctx, user).post("/ai/criteria:suggest", body);
      expect(res.status).toBe(429);
      expect((res.body as { code: string }).code).toBe("RATE_LIMITED");
      const retryAfter = Number(res.headers["retry-after"]);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(86_400);
      expect(ctx.engine.suggestions).toHaveLength(AI_SUGGESTIONS_PER_USER_PER_DAY);
    });

    it("holds under concurrency: a burst cannot slip past the cap", async () => {
      const results = await Promise.all(Array.from({ length: AI_SUGGESTIONS_PER_USER_PER_DAY + 10 }, () => as(ctx, user).post("/ai/criteria:suggest", body)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(AI_SUGGESTIONS_PER_USER_PER_DAY);
      expect(results.filter((r) => r.status === 429)).toHaveLength(10);
      expect(ctx.engine.suggestions).toHaveLength(AI_SUGGESTIONS_PER_USER_PER_DAY);
    });

    it("stops everyone at the global cap, however many accounts exist", async () => {
      const day = ctx.clock.now().toISOString().slice(0, 10);
      await ctx.db.insert(aiSuggestionUsage).values({ day, scope: "global", count: AI_SUGGESTIONS_PER_DAY });
      const res = await as(ctx, user).post("/ai/criteria:suggest", body);
      expect(res.status).toBe(429);
      expect(ctx.engine.suggestions).toHaveLength(0);
    });

    it("a request refused by the global cap does not spend the person's own", async () => {
      const day = ctx.clock.now().toISOString().slice(0, 10);
      await ctx.db.insert(aiSuggestionUsage).values({ day, scope: "global", count: AI_SUGGESTIONS_PER_DAY });
      await as(ctx, user).post("/ai/criteria:suggest", body);
      const mine = await ctx.db.select().from(aiSuggestionUsage).where(eq(aiSuggestionUsage.scope, user));
      expect(mine).toHaveLength(0);
    });

    it("an outage spends nothing: the request never got through", async () => {
      ctx.engine.down = true;
      for (let i = 0; i < AI_SUGGESTIONS_PER_USER_PER_DAY + 5; i++) {
        expect((await as(ctx, user).post("/ai/criteria:suggest", body)).status).toBe(503);
      }
      ctx.engine.down = false;
      expect((await as(ctx, user).post("/ai/criteria:suggest", body)).status).toBe(200);
    });

    it("a timeout does count: the model may have been called and billed", async () => {
      ctx.engine.suggestionTimesOut = true;
      for (let i = 0; i < AI_SUGGESTIONS_PER_USER_PER_DAY; i++) {
        expect((await as(ctx, user).post("/ai/criteria:suggest", body)).status).toBe(503);
      }
      expect((await as(ctx, user).post("/ai/criteria:suggest", body)).status).toBe(429);
    });

    it("a new day starts over", async () => {
      for (let i = 0; i < AI_SUGGESTIONS_PER_USER_PER_DAY; i++) await as(ctx, user).post("/ai/criteria:suggest", body);
      ctx.clock.advance(86_400_000);
      expect((await as(ctx, user).post("/ai/criteria:suggest", body)).status).toBe(200);
    });
  });
});
