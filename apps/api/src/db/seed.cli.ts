// Seeds the development users (db/dev-users.ts). Safe to run repeatedly.
import { createDb, createPool } from "./database.js";
import { asOnboarded, DEV_USERS } from "./dev-users.js";
import { users } from "./schema.js";

const url = process.env.CORE_DATABASE_URL;
if (url === undefined) throw new Error("CORE_DATABASE_URL is not set (see .env.example)");
const pool = createPool(url);
try {
  const inserted = await createDb(pool).insert(users).values(DEV_USERS.map(asOnboarded)).onConflictDoNothing().returning({ email: users.email });
  console.log(inserted.length === 0 ? "Dev users already present" : `Seeded: ${inserted.map((u) => u.email).join(", ")}`);
  for (const u of DEV_USERS) console.log(`  ${u.roles.join(",").padEnd(10)} X-Settld-Dev-User: ${u.id}`);
} finally {
  await pool.end();
}
