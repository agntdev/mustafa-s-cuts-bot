import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool, type DbPool } from "./db.js";

// E3T1 — minimal forward-only migration runner. The bot runs `migrate()`
// on startup; new files land in `migrations/` with the next ordinal prefix
// (002_…, 003_…) and the runner picks them up by sorted filename.
//
// Why forward-only: the bot is short-lived (one process per container) and
// the data is recoverable (services / barbers are seeded by E3T2, the rest
// is user-entered). A down-migration step would add complexity without a
// real rollback story. New changes go in a new file.

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

/** The version string is the filename without the .sql extension. */
function versionOf(filename: string): string {
  return filename.replace(/\.sql$/i, "");
}

/** Return the list of (version, sql) pairs to apply, in order, skipping any
 *  whose version is already in schema_migrations. */
export async function planMigrations(
  pool: DbPool,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<Array<{ version: string; sql: string }>> {
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch {
    return [];
  }

  // Ensure schema_migrations exists so the first query doesn't fail on a
  // fresh database. The CREATE here is idempotent.
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);

  const { rows } = await pool.query(
    "SELECT version FROM schema_migrations",
  );
  const applied = new Set(
    (rows as ReadonlyArray<{ version: string }>).map((r) => r.version),
  );

  return files
    .filter((f) => !applied.has(versionOf(f)))
    .map((f) => ({ version: versionOf(f), sql: readFileSync(join(migrationsDir, f), "utf8") }));
}

/** Apply all pending migrations. Returns the list of versions applied. */
export async function migrate(
  pool: DbPool = getPool() as DbPool,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<string[]> {
  if (!pool) {
    // No DB configured (dev / test without Postgres). The bot can still run;
    // later tasks that need the DB will surface a clear error.
    return [];
  }
  const pending = await planMigrations(pool, migrationsDir);
  for (const { version, sql } of pending) {
    // Each migration runs in its own transaction so a failure mid-file
    // doesn't leave the schema half-applied.
    await pool.query("BEGIN");
    try {
      await pool.query(sql);
      await pool.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK").catch(() => {
        /* rollback failure is logged but we still surface the original error */
      });
      throw new Error(`migration ${version} failed: ${(err as Error).message}`);
    }
  }
  return pending.map((p) => p.version);
}
