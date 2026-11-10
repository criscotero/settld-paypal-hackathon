import { Inject, Module } from "@nestjs/common";
import type { DynamicModule, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { APP_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { ProblemException } from "../errors/problem.js";
import { CLOCK, systemClock, WEB_URL } from "./clock.js";
import { FakePaymentProvider } from "./fake-payment-provider.js";
import { HttpPaymentProvider } from "./http-payment-provider.js";
import { HttpPaypalAccounts } from "./http-paypal-accounts.js";
import { JOB_SCHEDULER } from "./job-scheduler.js";
import { JOB_WORKERS, JobWorkers } from "./job-workers.js";
import { startPaymentWorkers } from "./payment-workers.js";
import { createBoss, ensureQueues, PgBossJobScheduler } from "./pg-boss-job-scheduler.js";
import { LedgerController } from "./ledger.controller.js";
import { LedgerService } from "./ledger.service.js";
import { MilestonesController } from "./milestones.controller.js";
import { MilestonesService } from "./milestones.service.js";
import { PAYMENT_PROVIDER } from "./payment-provider.js";
import type { PaymentProvider } from "./payment-provider.js";
import type { PaypalAccounts } from "./paypal-accounts.js";
import { PAYPAL_ACCOUNTS } from "./paypal-accounts.js";
import { loadPaypalConfig, PAYPAL_WEB_BASE } from "./paypal-config.js";

// Without credentials every PayPal-backed call says so plainly instead of failing obscurely.
function notConfigured(): never {
  throw new ProblemException("PAYPAL_UNAVAILABLE", 503, "PayPal is not configured", "Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (see .env.example).");
}
const NOT_CONFIGURED: PaypalAccounts = {
  createSellerReferral: () => Promise.resolve(notConfigured()),
  findSeller: () => Promise.resolve(notConfigured()),
  loginUrl: () => notConfigured(),
  exchangeLoginCode: () => Promise.resolve(notConfigured()),
};

const NO_PAYMENTS: PaymentProvider = {
  createOrder: () => Promise.resolve(notConfigured()),
  authorizeOrder: () => Promise.resolve(notConfigured()),
  capture: () => Promise.resolve(notConfigured()),
  void: () => Promise.resolve(notConfigured()),
  refund: () => Promise.resolve(notConfigured()),
  getCapture: () => Promise.resolve(notConfigured()),
  getAuthorizationStatus: () => Promise.resolve(notConfigured()),
};

// Same allowlist as dev auth (ADR-0003): the fake PayPal exists only where nobody's money is.
const FAKE_PAYMENTS_ENVIRONMENTS: ReadonlySet<string> = new Set(["development", "test"]);

const PG_BOSS = Symbol("PG_BOSS");

// Starts pg-boss (installing its tables in the `pgboss` schema on first run) and the workers.
// Off in NODE_ENV=test: the e2e tests replace the scheduler and run each job by hand, and the
// pg-boss test builds its own instance.
class PaymentWorkersLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(PG_BOSS) private readonly boss: PgBoss,
    private readonly milestones: MilestonesService,
    private readonly workers: JobWorkers,
    private readonly enabled: boolean,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    await this.boss.start();
    await ensureQueues(this.boss);
    await startPaymentWorkers(this.boss, this.milestones);
    await this.workers.startAll(this.boss);
  }

  async onApplicationShutdown(): Promise<void> {
    // Graceful: running handlers finish, so a capture is never cut between PayPal and our record.
    if (this.enabled) await this.boss.stop({ graceful: true });
  }
}

// Constitution: the payments module is the only code that holds PayPal credentials.
// Global: accounts needs PAYPAL_ACCOUNTS, and importing a forRoot module twice would build two
// sets of providers.
@Module({})
export class PaymentsModule {
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    return {
      module: PaymentsModule,
      global: true,
      controllers: [MilestonesController, LedgerController],
      providers: [
        LedgerService,
        MilestonesService,
        { provide: CLOCK, useValue: systemClock },
        { provide: WEB_URL, inject: [APP_CONFIG], useFactory: (c: AppConfig) => c.webUrl },
        { provide: PAYPAL_WEB_BASE, useFactory: () => loadPaypalConfig(env)?.webBase ?? null },
        // With PayPal credentials, money moves through PayPal (the sandbox for the demo). Without
        // them, development and test use the fake; anywhere else money calls answer 503.
        {
          provide: PAYMENT_PROVIDER,
          useFactory: () => {
            const paypal = loadPaypalConfig(env);
            if (paypal !== null) return new HttpPaymentProvider(paypal);
            return FAKE_PAYMENTS_ENVIRONMENTS.has(env.NODE_ENV ?? "") ? new FakePaymentProvider() : NO_PAYMENTS;
          },
        },
        { provide: PG_BOSS, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createBoss(c.databaseUrl) },
        { provide: JOB_SCHEDULER, inject: [PG_BOSS], useFactory: (boss: PgBoss) => new PgBossJobScheduler(boss) },
        { provide: JOB_WORKERS, useValue: new JobWorkers() },
        {
          provide: PaymentWorkersLifecycle,
          inject: [PG_BOSS, MilestonesService, JOB_WORKERS],
          useFactory: (boss: PgBoss, milestones: MilestonesService, workers: JobWorkers) => new PaymentWorkersLifecycle(boss, milestones, workers, env.NODE_ENV !== "test"),
        },
        {
          provide: PAYPAL_ACCOUNTS,
          useFactory: () => {
            const config = loadPaypalConfig(env);
            return config === null ? NOT_CONFIGURED : new HttpPaypalAccounts(config);
          },
        },
      ],
      exports: [PAYPAL_ACCOUNTS, MilestonesService, JOB_SCHEDULER, JOB_WORKERS, CLOCK],
    };
  }
}
