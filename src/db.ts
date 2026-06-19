import { createRequire } from "node:module";

// E3T1 — Postgres connection pool. `pg` is loaded lazily so a bot that never
// sets DATABASE_URL doesn't pull it in (mirrors the toolkit's lazy ioredis
// pattern in src/toolkit/session/redis.ts).

/** The minimal pg surface the rest of the app needs. Keeping it an
 *  interface lets tests inject a fake pool (see test/db.test.ts). */
export interface DbPool {
  query(text: string, params?: ReadonlyArray<unknown>): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

/** Lazy pg pool. Returns undefined when DATABASE_URL is not set, so callers
 *  can branch on "is a DB configured" without importing pg themselves. */
let cachedPool: DbPool | undefined;
export function getPool(): DbPool | undefined {
  if (cachedPool) return cachedPool;
  if (!process.env.DATABASE_URL) return undefined;
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pg: any = require("pg");
    const Pool = pg.Pool ?? pg.default?.Pool;
    cachedPool = new Pool({ connectionString: process.env.DATABASE_URL }) as DbPool;
    return cachedPool;
  } catch (err) {
    console.error("[mustafa-cuts] could not load pg:", err);
    return undefined;
  }
}

/** Test seam: swap the cached pool. Returns a function that restores the
 *  previous pool so tests can run in isolation. */
export function __setPoolForTests(pool: DbPool | undefined): () => void {
  const prev = cachedPool;
  cachedPool = pool;
  return () => {
    cachedPool = prev;
  };
}
