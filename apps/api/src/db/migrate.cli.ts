import { runMigrations } from "./migrate.js";

const url = process.env.CORE_DATABASE_URL;
if (url === undefined) throw new Error("CORE_DATABASE_URL is not set (see .env.example)");
const applied = await runMigrations(url);
console.log(applied.length === 0 ? "No pending migrations" : `Applied: ${applied.join(", ")}`);
