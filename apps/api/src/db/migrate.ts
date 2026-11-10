// Applies drizzle/ migrations as core_app. Used by `pnpm db:migrate` and by the integration tests.
//
// Why not drizzle-orm's migrate(): it always runs CREATE SCHEMA IF NOT EXISTS, which needs
// CREATE on the database. core_app deliberately lacks it (SB-3: it owns `core` and nothing
// else), and granting it would let the app role create schemas. This reads the same files
// drizzle-kit generates (meta/_journal.json + NNNN_name.sql), so drizzle-kit stays the generator.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";

const FOLDER = new URL("../../drizzle/", import.meta.url).pathname;
// Any fixed number: all migrators agree on it, so only one runs at a time.
const MIGRATION_LOCK = 4_242_001;

interface Journal {
  entries: { idx: number; tag: string }[];
}

export async function runMigrations(url: string): Promise<string[]> {
  const journal = JSON.parse(await readFile(join(FOLDER, "meta/_journal.json"), "utf8")) as Journal;
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const applied: string[] = [];
  try {
    // Two processes starting at once (two containers, or two test workers) would both see
    // "not applied" and run the same DDL. The advisory lock makes the second one wait.
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS core.__migrations (
         tag text PRIMARY KEY,
         hash text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const done = await client.query<{ tag: string; hash: string }>("SELECT tag, hash FROM core.__migrations");
    const doneByTag = new Map(done.rows.map((r) => [r.tag, r.hash]));

    for (const { tag } of journal.entries.sort((a, b) => a.idx - b.idx)) {
      const sql = await readFile(join(FOLDER, `${tag}.sql`), "utf8");
      const hash = createHash("sha256").update(sql).digest("hex");
      const previous = doneByTag.get(tag);
      if (previous !== undefined) {
        // Editing an applied migration means dev and prod databases silently differ.
        if (previous !== hash) throw new Error(`Migration ${tag} changed after it was applied`);
        continue;
      }
      // One transaction per migration: Postgres DDL is transactional, so a failure leaves
      // nothing half-applied and the migration can simply be retried.
      await client.query("BEGIN");
      try {
        for (const statement of sql.split("--> statement-breakpoint")) {
          if (statement.trim() !== "") await client.query(statement);
        }
        await client.query("INSERT INTO core.__migrations (tag, hash) VALUES ($1, $2)", [tag, hash]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
      applied.push(tag);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]);
    await client.end();
  }
}
