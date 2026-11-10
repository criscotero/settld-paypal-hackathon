import { Module } from "@nestjs/common";
import { AiUsageService } from "./ai-usage.service.js";
import { AiController } from "./ai.controller.js";

// ENGINE_CLIENT comes from VerificationModule, CLOCK from PaymentsModule: both are global.
@Module({ controllers: [AiController], providers: [AiUsageService] })
export class AiModule {}
