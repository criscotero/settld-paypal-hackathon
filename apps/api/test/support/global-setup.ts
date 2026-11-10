import { runMigrations } from "../../src/db/migrate.js";

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (url === undefined || !url.includes("settld_test")) {
    throw new Error("TEST_DATABASE_URL must point at settld_test (see vitest.config.e2e.ts)");
  }
  await runMigrations(url);
}
