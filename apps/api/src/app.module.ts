import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AccountsModule } from "./accounts/accounts.module.js";
import { AiModule } from "./ai/ai.module.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthModule } from "./auth/auth.module.js";
import { APP_CONFIG, loadConfig } from "./config.js";
import { ContractsModule } from "./contracts/contracts.module.js";
import { DatabaseModule } from "./db/database.module.js";
import { IdempotencyModule } from "./idempotency/idempotency.module.js";
import { NotificationsModule } from "./notifications/notifications.module.js";
import { PaymentsModule } from "./payments/payments.module.js";
import { VerificationModule } from "./verification/verification.module.js";

// Modules from the constitution (accounts, contracts, payments, verification,
// objections, notifications, audit) are added here milestone by milestone.
@Module({})
export class AppModule {
  // `env` as a parameter for the same reason as AuthModule.forRoot: tests pass their own.
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    const config = loadConfig(env);
    return {
      module: AppModule,
      imports: [
        { module: ConfigHolder, global: true, providers: [{ provide: APP_CONFIG, useValue: config }], exports: [APP_CONFIG] },
        DatabaseModule,
        IdempotencyModule,
        AuthModule.forRoot(env),
        AccountsModule,
        ContractsModule,
        PaymentsModule.forRoot(env),
        VerificationModule.forRoot(env),
        AiModule,
        NotificationsModule.forRoot(env),
      ],
      // Authenticated by default: a new route is protected unless someone opts it out.
      providers: [{ provide: APP_GUARD, useExisting: AuthGuard }],
    };
  }
}

@Module({})
class ConfigHolder {}
