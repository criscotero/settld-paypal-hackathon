import { defineConfig } from "drizzle-kit";

// drizzle-kit only generates SQL here; src/db/migrate.ts applies it (see why there).
process.loadEnvFile("../../.env");
const url = process.env.CORE_DATABASE_URL;
if (url === undefined) throw new Error("CORE_DATABASE_URL is not set (see .env.example)");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  schemaFilter: ["core"],
  dbCredentials: { url },
  strict: true,
});
