import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createBlock, deleteBlock, isOwner, listActiveBlocks } from "../src/blocks";
import { __setPoolForTests } from "../src/db";
import type { DbPool } from "../src/db";

// E2T3 — blocks tests. The data layer goes through getPool(); a tiny
// in-memory fake is enough to prove the SQL + the formatting.

class FakePool implements DbPool {
  rows: unknown[][] = [];
  lastQuery: { text: string; params: ReadonlyArray<unknown> } | undefined;
  /** Per-query row overrides: callers push a rows array per query they want
   *  to mock. Falls back to the latest `rows[0]` for any unmocked query. */
  scriptedRows: unknown[][] = [];

  async query(text: string, params?: ReadonlyArray<unknown>) {
    this.lastQuery = { text, params: params ?? [] };
    if (text.trim().toUpperCase().startsWith("INSERT")) {
      return { rows: [{ id: "block-1", barber_id: params?.[0] }] };
    }
    if (text.trim().toUpperCase().startsWith("DELETE")) {
      const scripted = this.scriptedRows.shift();
      return { rows: scripted ?? [{ id: params?.[0] }] };
    }
    return { rows: this.rows[0] ?? [] };
  }
  async end() { /* noop */ }
}

describe("isOwner", () => {
  const prevOwner = process.env.OWNER_TELEGRAM_ID;
  beforeEach(() => {
    delete process.env.OWNER_TELEGRAM_ID;
  });
  afterEach(() => {
    if (prevOwner === undefined) delete process.env.OWNER_TELEGRAM_ID;
    else process.env.OWNER_TELEGRAM_ID = prevOwner;
  });

  it("refuses everyone when OWNER_TELEGRAM_ID is unset (closed-by-default)", () => {
    expect(isOwner(123)).toBe(false);
    expect(isOwner(undefined)).toBe(false);
  });

  it("matches only the configured id", () => {
    process.env.OWNER_TELEGRAM_ID = "4242";
    expect(isOwner(4242)).toBe(true);
    expect(isOwner(9999)).toBe(false);
    expect(isOwner(undefined)).toBe(false);
  });
});

describe("createBlock", () => {
  it("inserts a row with the right shape and returns it", async () => {
    const pool = new FakePool();
    const restore = __setPoolForTests(pool);
    try {
      const start = new Date("2026-06-20T14:00:00Z");
      const end = new Date("2026-06-20T14:30:00Z");
      const block = await createBlock("mustafa", start, end, "4242", "30-min break");
      expect(block).toBeDefined();
      expect(block?.barber_id).toBe("mustafa");
      expect(pool.lastQuery?.text).toMatch(/INSERT INTO blocked_slots/);
      expect(pool.lastQuery?.params).toEqual([
        "mustafa",
        "2026-06-20T14:00:00.000Z",
        "2026-06-20T14:30:00.000Z",
        "30-min break",
        "4242",
      ]);
    } finally {
      restore();
    }
  });

  it("returns undefined when the pool is not configured", async () => {
    const restore = __setPoolForTests(undefined);
    try {
      const result = await createBlock("mustafa", new Date(), new Date(), "4242");
      expect(result).toBeUndefined();
    } finally {
      restore();
    }
  });
});

describe("listActiveBlocks", () => {
  it("queries with a future-end filter", async () => {
    const pool = new FakePool();
    pool.rows = [[
      { id: "b1", barber_id: "mustafa", start_datetime: "2026-06-20T14:00:00.000Z", end_datetime: "2026-06-20T14:30:00.000Z", reason: "break", created_by: "4242" },
    ]];
    const restore = __setPoolForTests(pool);
    try {
      const blocks = await listActiveBlocks(new Date("2026-06-20T13:00:00Z"));
      expect(blocks).toHaveLength(1);
      expect(pool.lastQuery?.text).toMatch(/WHERE end_datetime > \$1/);
      expect(pool.lastQuery?.text).toMatch(/ORDER BY start_datetime/);
      expect(blocks[0]?.barber_id).toBe("mustafa");
    } finally {
      restore();
    }
  });
});

describe("deleteBlock", () => {
  it("returns true when a row was removed", async () => {
    const pool = new FakePool();
    const restore = __setPoolForTests(pool);
    try {
      const ok = await deleteBlock("block-1");
      expect(ok).toBe(true);
      expect(pool.lastQuery?.params).toEqual(["block-1"]);
    } finally {
      restore();
    }
  });

  it("returns false when no row was removed", async () => {
    const pool = new FakePool();
    // Script the next DELETE to return 0 rows.
    pool.scriptedRows.push([]);
    const restore = __setPoolForTests(pool);
    try {
      const ok = await deleteBlock("block-missing");
      expect(ok).toBe(false);
    } finally {
      restore();
    }
  });
});
