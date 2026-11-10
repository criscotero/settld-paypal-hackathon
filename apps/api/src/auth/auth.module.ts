import { Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import { DrizzleUserDirectory } from "../accounts/drizzle-user-directory.js";
import { loadAuthConfig } from "./auth-config.js";
import type { AuthConfig } from "./auth-config.js";
import { AuthGuard } from "./auth.guard.js";
import { AUTH_CONFIG } from "./auth.tokens.js";
import { ClerkIdentityProvider } from "./clerk-identity-provider.js";
import { IDENTITY_PROVIDER, NoIdentityProvider } from "./identity-provider.js";
import { OnboardedGuard } from "./onboarded.guard.js";
import { USER_DIRECTORY } from "./user-directory.js";

@Module({})
export class AuthModule {
  // The `env` parameter (not read inside) lets tests boot any environment
  // without mutating process.env, which is shared by every test in the worker.
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    return {
      module: AuthModule,
      providers: [
        // A throwing factory aborts Nest's bootstrap: the app never listens.
        { provide: AUTH_CONFIG, useFactory: () => loadAuthConfig(env) },
        // Tests override this token with an in-memory directory, so they need no database.
        { provide: USER_DIRECTORY, useClass: DrizzleUserDirectory },
        // Tests override this one with a fake that accepts made-up tokens.
        {
          provide: IDENTITY_PROVIDER,
          inject: [AUTH_CONFIG],
          useFactory: (config: AuthConfig) => (config.clerk === null ? new NoIdentityProvider() : new ClerkIdentityProvider(config.clerk)),
        },
        AuthGuard,
        OnboardedGuard,
      ],
      exports: [AuthGuard, OnboardedGuard, AUTH_CONFIG, USER_DIRECTORY, IDENTITY_PROVIDER],
    };
  }
}
