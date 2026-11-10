import { isAbsolute } from "node:path";
import { Inject, Logger, Module } from "@nestjs/common";
import type { DynamicModule, OnModuleInit } from "@nestjs/common";
import { JOB_WORKERS } from "../payments/job-workers.js";
import type { JobWorkers } from "../payments/job-workers.js";
import { DeliveryFilesController } from "./delivery-files.controller.js";
import { DELIVERIES_DIR, DeliveryFilesService, PUBLIC_API_URL } from "./delivery-files.service.js";
import { EngineEventsController } from "./engine-events.controller.js";
import { ENGINE_CLIENT, HttpEngineClient } from "./engine-client.js";
import type { EngineClient } from "./engine-client.js";
import { GitHubRepositoryResolver, REPOSITORY_RESOLVER } from "./repository-resolver.js";
import { loadServiceKeys, SERVICE_KEYS } from "./service-token.js";
import { VerificationController } from "./verification.controller.js";
import { VerificationService } from "./verification.service.js";

interface RunJob {
  runId: string;
}
interface InboxJob {
  inboxEventId: string;
}

// Without keys the bridge cannot sign, so every dispatch fails loudly and pg-boss keeps the job
// for when the keys exist, instead of sending unsigned calls the Engine must refuse anyway.
const NOT_CONFIGURED: EngineClient = {
  createRun: () => Promise.reject(new Error("Engine bridge not configured: set CORE_SERVICE_PRIVATE_KEY and ENGINE_SERVICE_PUBLIC_KEY (see .env.example)")),
  getRun: () => Promise.reject(new Error("Engine bridge not configured")),
  suggestCriteria: () => Promise.reject(new Error("Engine bridge not configured")),
};

class VerificationWorkers implements OnModuleInit {
  constructor(
    @Inject(JOB_WORKERS) private readonly workers: JobWorkers,
    private readonly verification: VerificationService,
  ) {}

  onModuleInit(): void {
    const log = new Logger("VerificationWorkers");
    const opts = { pollingIntervalSeconds: 2 };
    // Thin handlers: each service method re-reads its rows and does nothing when stale, and a
    // throw makes pg-boss retry later with the same data (events.md 3.1).
    this.workers.add(async (boss) => {
      await boss.work<RunJob>("verification.run.dispatch", opts, async ([job]) => {
        if (job !== undefined) log.log(`dispatch ${job.data.runId}: ${await this.verification.dispatch(job.data.runId)}`);
      });
      await boss.work<InboxJob>("engine.event.process", opts, async ([job]) => {
        if (job !== undefined) log.log(`engine event ${job.data.inboxEventId}: ${await this.verification.processEvent(job.data.inboxEventId)}`);
      });
      await boss.work<RunJob>("verification.run.watchdog", opts, async ([job]) => {
        if (job !== undefined) log.log(`watchdog ${job.data.runId}: ${await this.verification.watchdog(job.data.runId)}`);
      });
    });
  }
}

// The verification module of the constitution, Core side: the bridge to the Engine (ADR-0008).
// It holds Core's service key and nothing of PayPal's (SB-8).
@Module({})
export class VerificationModule {
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    const keys = loadServiceKeys(env);
    const engineUrl = (env.ENGINE_URL ?? "http://localhost:8000").replace(/\/$/, "");
    // ADR-0020: the same folder the Engine reads (SETTLD_DELIVERIES_DIR in both env files).
    const deliveriesDir = env.SETTLD_DELIVERIES_DIR ?? "/var/lib/settld/deliveries";
    // Absolute, like the Engine's: relative paths resolve against each service's own folder, and
    // res.sendFile refuses them.
    if (!isAbsolute(deliveriesDir)) throw new Error(`SETTLD_DELIVERIES_DIR must be an absolute path, got ${deliveriesDir}`);
    const publicApiUrl = (env.SETTLD_PUBLIC_API_URL ?? "http://localhost:4000/v1").replace(/\/$/, "");
    return {
      module: VerificationModule,
      global: true,
      controllers: [EngineEventsController, VerificationController, DeliveryFilesController],
      providers: [
        { provide: SERVICE_KEYS, useValue: keys },
        { provide: ENGINE_CLIENT, useValue: keys === null ? NOT_CONFIGURED : new HttpEngineClient(engineUrl, keys) },
        { provide: DELIVERIES_DIR, useValue: deliveriesDir },
        { provide: PUBLIC_API_URL, useValue: publicApiUrl },
        { provide: REPOSITORY_RESOLVER, useValue: new GitHubRepositoryResolver(fetch, env.GITHUB_TOKEN || null) },
        DeliveryFilesService,
        VerificationService,
        VerificationWorkers,
      ],
      exports: [VerificationService, ENGINE_CLIENT, DeliveryFilesService, REPOSITORY_RESOLVER],
    };
  }
}
