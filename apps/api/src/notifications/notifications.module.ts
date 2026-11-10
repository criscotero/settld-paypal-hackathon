import { Inject, Logger, Module } from "@nestjs/common";
import type { DynamicModule, OnModuleInit } from "@nestjs/common";
import { JOB_WORKERS } from "../payments/job-workers.js";
import type { JobWorkers } from "../payments/job-workers.js";
import { EMAIL_SENDER, loadSmtpConfig, SmtpEmailSender } from "./email-sender.js";
import { NotificationsService } from "./notifications.service.js";
import type { NotificationJob } from "./notifications.service.js";

class NotificationWorkers implements OnModuleInit {
  constructor(
    @Inject(JOB_WORKERS) private readonly workers: JobWorkers,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    const log = new Logger("NotificationWorkers");
    this.workers.add(async (boss) => {
      await boss.work<NotificationJob>("notifications.send", { pollingIntervalSeconds: 2 }, async ([job]) => {
        if (job !== undefined) log.log(`${job.data.templateKey}: ${await this.notifications.process(job.data)}`);
      });
    });
  }
}

@Module({})
export class NotificationsModule {
  static forRoot(env: NodeJS.ProcessEnv): DynamicModule {
    const smtp = loadSmtpConfig(env);
    return {
      module: NotificationsModule,
      providers: [{ provide: EMAIL_SENDER, useValue: smtp === null ? null : new SmtpEmailSender(smtp) }, NotificationsService, NotificationWorkers],
    };
  }
}
