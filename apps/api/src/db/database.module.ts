import { Global, Inject, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import type pg from "pg";
import { APP_CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { createDb, createPool, DB, PG_POOL } from "./database.js";

@Global()
@Module({
  providers: [
    { provide: PG_POOL, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createPool(c.databaseUrl) },
    { provide: DB, inject: [PG_POOL], useFactory: createDb },
  ],
  exports: [DB],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  // Graceful shutdown (enableShutdownHooks): let in-flight queries finish, then close.
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
