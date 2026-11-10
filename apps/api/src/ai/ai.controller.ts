// POST /ai/criteria:suggest (openapi.yaml, ADR-0016). Thin on purpose: the model and its validation
// live in the Engine (service-boundaries.md), and nothing here is saved to a contract.
//
// No Idempotency-Key, unlike other POSTs: IdempotencyService keeps a transaction open around its
// effect, and here that would hold a database connection for the whole model call. Enough clicks
// would leave the payment routes without connections, to protect against one extra suggestion.
import { Body, Controller, HttpCode, Inject, Logger, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser } from "../auth/current-user.decorator.js";
import { OnboardedGuard } from "../auth/onboarded.guard.js";
import type { AuthenticatedUser } from "../auth/user-directory.js";
import { verifiabilityScore } from "../contracts/snapshot.js";
import { ProblemException } from "../errors/problem.js";
import { parsedOrThrow } from "../http/validation.js";
import { ENGINE_CLIENT, EngineUnavailableError } from "../verification/engine-client.js";
import type { EngineClient } from "../verification/engine-client.js";
import { AiUsageService } from "./ai-usage.service.js";

const suggestBody = z.object({
  title: z.string().min(1).max(140),
  description: z.string().max(5000).default(""),
  contractTitle: z.string().max(140).optional(),
  locale: z.enum(["en", "es"]).default("en"),
});

// The Engine is ours, but it relays a model: its answer is checked before a person sees it.
const engineAnswer = z.object({
  suggestionId: z.uuid(),
  criteria: z
    .array(
      z.object({
        text: z.string(),
        level: z.enum(["AUTOMATIC", "AI_EVALUATED", "HUMAN"]),
        checkType: z.enum(["HTTP_PROBE", "AI_FEATURE_PRESENT", "AI_REQUIREMENT_MET"]).nullable(),
        checkConfig: z.record(z.string(), z.unknown()).nullable(),
        required: z.boolean(),
        weightBps: z.int().min(1).max(10_000),
        rationale: z.string(),
      }),
    )
    .min(1),
  ambiguities: z.array(z.object({ term: z.string(), excerpt: z.string(), problem: z.string(), alternatives: z.array(z.string()) })),
  notes: z.string(),
});

const unavailable = () => new ProblemException("AI_UNAVAILABLE", 503, "Suggestions are unavailable right now", "You can write the criteria yourself, or try again in a moment.", { retryAfterSeconds: 30 });

@Controller()
export class AiController {
  private readonly log = new Logger(AiController.name);

  constructor(
    @Inject(ENGINE_CLIENT) private readonly engine: EngineClient,
    private readonly usage: AiUsageService,
  ) {}

  @UseGuards(OnboardedGuard)
  @Post("ai/criteria\\:suggest")
  @HttpCode(200)
  async suggestCriteria(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = parsedOrThrow(suggestBody.safeParse(body));
    const day = await this.usage.reserve(user.id);

    let raw: unknown;
    try {
      raw = await this.engine.suggestCriteria({ title: input.title, description: input.description, contractTitle: input.contractTitle ?? null, locale: input.locale, requestedBy: user.id });
    } catch (error) {
      this.log.warn(`suggestCriteria failed: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof EngineUnavailableError && error.neverReached) await this.usage.release(user.id, day);
      throw unavailable();
    }
    const parsed = engineAnswer.safeParse(raw);
    if (!parsed.success) {
      this.log.error(`suggestCriteria answered off contract: ${parsed.error.message}`);
      throw unavailable();
    }
    const answer = parsed.data;
    return {
      suggestionId: answer.suggestionId,
      criteria: answer.criteria.map((c) => ({ ...c, origin: "AI_SUGGESTED" as const, aiSuggestionId: answer.suggestionId })),
      ambiguities: answer.ambiguities,
      notes: answer.notes,
      verifiabilityScore: verifiabilityScore(answer),
    };
  }
}
