import { describe, expect, it } from "vitest";
import { seed } from "../src/seed";
import type { DbPool } from "../src/db";

// E3T2 — seed tests. The seed function takes a pool and writes the
// default services + barbers. The fake pool below records every query so
// we can assert on both the SQL and the parameters.

class FakePool implements DbPool {
  /** Per-query log of (text, params) — used to assert on shape. */
  log: Array<{ text: string; params: ReadonlyArray<unknown> }> = [];
  /** Set of ids to make `RETURNING id` non-empty for; others return 0 rows. */
  returnRowFor = new Set<string>();

  async query(text: string, params?: ReadonlyArray<unknown>) {
    this.log.push({ text, params: params ?? [] });
    // RETURNING id is used by the seed to count actual inserts — return a
    // row when the caller asked for one, otherwise an empty result.
    if (/RETURNING id/.test(text) && params && params[0] != null) {
      const key = String(params[0]);
      if (this.returnRowFor.has(key)) return { rows: [{ id: key }] };
    }
    return { rows: [] };
  }
  async end() { /* noop */ }
}

describe("seed", () => {
  it("inserts every default service and barber exactly once on a fresh DB", async () => {
    const pool = new FakePool();
    pool.returnRowFor = new Set([
      "haircut", "beard_trim", "haircut_beard", "kids", "hot_towel",
      "mustafa", "alex",
    ]);
    const result = await seed(pool);
    expect(result.servicesInserted).toBe(5);
    expect(result.barbersInserted).toBe(2);
    // 5 services + 2 barbers = 7 INSERTs.
    const inserts = pool.log.filter((q) => /^INSERT INTO/i.test(q.text.trim()));
    expect(inserts).toHaveLength(7);
  });

  it("uses ON CONFLICT DO NOTHING so a populated DB is a no-op", async () => {
    const pool = new FakePool();
    // No ids in returnRowFor → every INSERT returns 0 rows → counts are 0.
    const result = await seed(pool);
    expect(result.servicesInserted).toBe(0);
    expect(result.barbersInserted).toBe(0);
    const allConflict = pool.log.every((q) => /ON CONFLICT \(id\) DO NOTHING/i.test(q.text));
    expect(allConflict).toBe(true);
  });

  it("binds parameters in id / name / duration_minutes order", async () => {
    const pool = new FakePool();
    await seed(pool);
    const firstServiceInsert = pool.log.find(
      (q) => /^INSERT INTO services/i.test(q.text.trim()),
    );
    expect(firstServiceInsert).toBeDefined();
    expect(firstServiceInsert?.params).toEqual(["haircut", "Haircut", 30]);
  });
});
