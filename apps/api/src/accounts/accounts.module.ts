import { Module } from "@nestjs/common";
import { DirectoryController, DirectoryService } from "./directory.js";
import { MeController } from "./me.controller.js";
import { OnboardingService } from "./onboarding.service.js";
import { ReviewerApplicationsController, ReviewerApplicationsService } from "./reviewer-applications.js";

// PAYPAL_ACCOUNTS comes from PaymentsModule, which AppModule registers globally.
@Module({ controllers: [MeController, DirectoryController, ReviewerApplicationsController], providers: [OnboardingService, DirectoryService, ReviewerApplicationsService] })
export class AccountsModule {}
