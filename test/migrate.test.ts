import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planMigrations, migrate } from "../src/migrate";
import type { DbPool } from "../src/db";

// E3T1 — migration runner tests. The runner talks to whatever pool you
// pass in, so a tiny in-memory fake is enough to prove ordering,
// idempotency, and the per-migration transaction boundary.

class FakePool implements DbPool {
  applied = new Set<string>();
  /** Track statements so tests can assert on the BEGIN / COMMIT shape. */
  statements: string[] = [];
  /** Optional throw-on-query for the rollback path test. */
  failOn: string | undefined;

  async query(text: string, params?: ReadonlyArray<unknown>) {
    this.statements.push(text.trim().split("\n")[0] ?? text.trim());
    if (this.failOn && text.includes(this.failOn)) {
      throw new Error(`boom: ${this.failOn}`);
    }
    if (text.includes("CREATE TABLE") && text.includes("schema_migrations")) {
      return { rows: [] };
    }
    if (/SELECT version FROM schema_migrations/.test(text)) {
      return { rows: [...this.applied].map((v) => ({ version: v })) };
    }
    if (text.trim().toUpperCase() === "BEGIN") return { rows: [] };
    if (text.trim().toUpperCase() === "COMMIT") return { rows: [] };
    if (text.trim().toUpperCase() === "ROLLBACK") return { rows: [] };
    if (/INSERT INTO schema_migrations/.test(text)) {
      const v = String(params?.[0] ?? "");
      this.applied.add(v);
      return { rows: [] };
    }
    return { rows: [] };
  }
  async end() { /* noop */ }
}

function makeTempDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "mcuts-mig-"));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe("planMigrations", () => {
  it("returns every .sql file in sorted order on a fresh DB", async () => {
    const dir = makeTempDir({
      "001_init.sql": "CREATE TABLE x (id int);",
      "002_seed.sql": "CREATE TABLE y (id int);",
    });
    try {
      const pool = new FakePool();
      const plan = await planMigrations(pool, dir);
      expect(plan.map((p) => p.version)).toEqual(["001_init", "002_seed"]);
      expect(plan[0]?.sql).toContain("CREATE TABLE x");
      expect(plan[1]?.sql).toContain("CREATE TABLE y");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips versions that are already in schema_migrations", async () => {
    const dir = makeTempDir({
      "001_init.sql": "CREATE TABLE x (id int);",
      "002_seed.sql": "CREATE TABLE y (id int);",
    });
    try {
      const pool = new FakePool();
      pool.applied.add("001_init");
      const plan = await planMigrations(pool, dir);
      expect(plan.map((p) => p.version)).toEqual(["002_seed"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns [] when the migrations directory is missing", async () => {
    const pool = new FakePool();
    const plan = await planMigrations(pool, "/nonexistent/path");
    expect(plan).toEqual([]);
  });
});

describe("migrate", () => {
  it("applies every pending migration and records it", async () => {
    const dir = makeTempDir({
      "001_init.sql": "CREATE TABLE x (id int);",
      "002_seed.sql": "CREATE TABLE y (id int);",
    });
    try {
      const pool = new FakePool();
      const applied = await migrate(pool, dir);
      expect(applied).toEqual(["001_init", "002_seed"]);
      expect(pool.applied.has("001_init")).toBe(true);
      expect(pool.applied.has("002_seed")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wraps each migration in BEGIN / COMMIT", async () => {
    const dir = makeTempDir({
      "001_init.sql": "CREATE TABLE x (id int);",
    });
    try {
      const pool = new FakePool();
      await migrate(pool, dir);
      // Expect at least one BEGIN and one COMMIT, with the migration SQL
      // sandwiched between them.
      const beginIdx = pool.statements.findIndex((s) => s === "BEGIN");
      const commitIdx = pool.statements.findIndex((s) => s === "COMMIT");
      expect(beginIdx).toBeGreaterThanOrEqual(0);
      expect(commitIdx).toBeGreaterThan(beginIdx);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back when a migration SQL throws", async () => {
    const dir = makeTempDir({
      "001_init.sql": "CREATE TABLE x (id int);",
      "002_bad.sql": "SELECT 1;",
    });
    try {
      const pool = new FakePool();
      pool.failOn = "SELECT 1";
      await expect(migrate(pool, dir)).rejects.toThrow(/migration 002_bad failed/);
      // 001_init was applied and committed; 002_bad was rolled back so it
      // must NOT be in the applied set.
      expect(pool.applied.has("001_init")).toBe(true);
      expect(pool.applied.has("002_bad")).toBe(false);
      expect(pool.statements).toContain("ROLLBACK");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
