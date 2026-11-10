import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
// The handle a use case receives inside a transaction. Every query that must see the
// locked rows has to go through it: a query on the global `Db` runs on another
// connection, outside the transaction and outside the lock, and nothing warns you.
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export const DB = Symbol("DB");
export const PG_POOL = Symbol("PG_POOL");

export function createPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 10 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle(pool, { schema });
}
