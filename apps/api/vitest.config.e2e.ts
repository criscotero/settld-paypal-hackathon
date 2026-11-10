import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

// Integration tests run against `settld_test` (same server, separate database), never `settld`.
const env = loadEnv("", new URL("../..", import.meta.url).pathname, "");
const devUrl = env.CORE_DATABASE_URL ?? "";
const testUrl = devUrl.replace(/\/settld(\?|$)/, "/settld_test$1");
// globalSetup runs in this process, where `test.env` does not apply yet.
process.env.TEST_DATABASE_URL = testUrl;

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    include: ["test/**/*.e2e-spec.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    env: { TEST_DATABASE_URL: testUrl },
    // Concurrency tests open several connections and wait on row locks.
    testTimeout: 20_000,
  },
});
