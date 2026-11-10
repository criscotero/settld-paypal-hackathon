// POST /internal/v1/events (internal-api.yaml, receiveEngineEvent): the Engine's outbox delivers
// here. Answers 200 once the event is durable in the inbox, new or a duplicate; the Engine
// keeps resending until it gets a 200, so anything else must mean "try again" or "never".
import { Body, Controller, Headers, HttpCode, Inject, Logger, Post } from "@nestjs/common";
import { ServiceRoute } from "../auth/service-route.decorator.js";
import { DB } from "../db/database.js";
import type { Db } from "../db/database.js";
import { ProblemException } from "../errors/problem.js";
import { parsedOrThrow } from "../http/validation.js";
import { checkServiceToken, recordJti, SERVICE_KEYS } from "./service-token.js";
import type { ServiceKeys } from "./service-token.js";
import { engineEvent, VerificationService } from "./verification.service.js";

@Controller("internal/v1")
export class EngineEventsController {
  private readonly log = new Logger(EngineEventsController.name);

  constructor(
    @Inject(SERVICE_KEYS) private readonly keys: ServiceKeys | null,
    @Inject(DB) private readonly db: Db,
    private readonly verification: VerificationService,
  ) {}

  @ServiceRoute()
  @Post("events")
  @HttpCode(200)
  async receive(@Headers("authorization") authorization: string | undefined, @Body() body: unknown) {
    // The token first: an unsigned caller learns nothing about the body's rules, not even a 422.
    await this.authenticate(authorization);
    // 422 is "never": the Engine stops resending and alerts (internal-api.yaml).
    const event = parsedOrThrow(engineEvent.safeParse(body));
    return { result: await this.verification.receiveEvent(event) };
  }

  private async authenticate(authorization: string | undefined): Promise<void> {
    const refuse = (why: string) => {
      // The reason goes to the log, not the answer: a prober gets no hint what to fix.
      this.log.warn(`Refused an Engine call: ${why}`);
      return new ProblemException("UNAUTHENTICATED", 401, "Unauthenticated", "A valid service token is required.");
    };
    if (this.keys === null) throw refuse("service keys not configured");
    let claims;
    try {
      claims = await checkServiceToken(this.keys, authorization);
    } catch (error) {
      throw refuse(error instanceof Error ? error.message : String(error));
    }
    if (!(await recordJti(this.db, claims))) throw refuse(`token ${claims.jti} already used`);
  }
}
