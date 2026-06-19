import { describe, expect, it } from "vitest";
import {
  buildSchedule,
  formatSchedule,
  getTomorrowAppointments,
  groupByBarber,
  tomorrowLocal,
  type ScheduleAppointment,
} from "../src/schedule";
import type { DbPool } from "../src/db";

// E2T1 — schedule tests. The DB read goes through getPool(); with a fake
// pool that returns canned rows we can assert the SQL + the formatting
// without standing up Postgres.

class FakePool implements DbPool {
  rows: unknown[] = [];
  lastQuery: { text: string; params: ReadonlyArray<unknown> } | undefined;
  async query(text: string, params?: ReadonlyArray<unknown>) {
    this.lastQuery = { text, params: params ?? [] };
    return { rows: this.rows };
  }
  async end() { /* noop */ }
}

function makeAppt(overrides: Partial<ScheduleAppointment> = {}): ScheduleAppointment {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    client_name: "Jane Doe",
    client_phone: "555-123-4567",
    client_telegram_id: "4242",
    service_id: "haircut",
    barber_id: "mustafa",
    start_datetime: new Date("2026-06-20T14:30:00Z"),
    end_datetime: new Date("2026-06-20T15:00:00Z"),
    status: "booked",
    service_name: "Haircut",
    barber_name: "Mustafa",
    ...overrides,
  };
}

describe("getTomorrowAppointments", () => {
  it("queries with a local-day window in the shop timezone", async () => {
    const pool = new FakePool();
    pool.rows = [makeAppt()];
    // Inject the pool by stubbing the lazy getPool() — we re-implement by
    // monkey-patching the module's getPool export via a manual import.
    const mod = await import("../src/db");
    const restore = mod.__setPoolForTests(pool);
    try {
      const appts = await getTomorrowAppointments(new Date("2026-06-19T22:00:00Z"));
      expect(appts).toHaveLength(1);
      expect(pool.lastQuery?.text).toMatch(/FROM appointments a/);
      expect(pool.lastQuery?.text).toMatch(/JOIN services s/);
      expect(pool.lastQuery?.text).toMatch(/LEFT JOIN barbers b/);
      expect(pool.lastQuery?.params).toHaveLength(2);
    } finally {
      restore();
    }
  });

  it("returns [] when the pool is not configured (no DATABASE_URL)", async () => {
    // getPool() returns undefined when DATABASE_URL is not set; the
    // function short-circuits to [].
    const appts = await getTomorrowAppointments();
    expect(appts).toEqual([]);
  });
});

describe("groupByBarber", () => {
  it("buckets appointments by barber and sorts groups by first start time", () => {
    // All times are UTC; the shop is EDT (UTC-4), so local display times
    // are 4 hours earlier than the UTC value.
    const groups = groupByBarber([
      // mustafa 15:00 UTC = 11:00 local
      makeAppt({ id: "a1", barber_id: "mustafa", start_datetime: new Date("2026-06-20T15:00:00Z") }),
      // alex 14:00 UTC = 10:00 local
      makeAppt({ id: "a2", barber_id: "alex",    start_datetime: new Date("2026-06-20T14:00:00Z") }),
      // mustafa 18:00 UTC = 14:00 local
      makeAppt({ id: "a3", barber_id: "mustafa", start_datetime: new Date("2026-06-20T18:00:00Z") }),
    ]);
    // alex's first slot (10:00 local) is earliest, so alex is first.
    expect(groups.map((g) => g.barberId)).toEqual(["alex", "mustafa"]);
    expect(groups[0]?.appointments.map((a) => a.id)).toEqual(["a2"]);
    expect(groups[1]?.appointments.map((a) => a.id)).toEqual(["a1", "a3"]);
  });
});

describe("buildSchedule + formatSchedule", () => {
  it("renders an empty-day message when there are no appointments", () => {
    const schedule = buildSchedule([], new Date("2026-06-19T22:00:00Z"));
    expect(schedule.totalCount).toBe(0);
    const text = formatSchedule(schedule);
    expect(text).toMatch(/Schedule for 2026-06-20/);
    expect(text).toMatch(/No appointments tomorrow/);
  });

  it("groups and renders a multi-barber day in chronological order", () => {
    // All times are UTC; the shop is EDT (UTC-4), so the rendered local
    // times are 4 hours earlier than the UTC value.
    const schedule = buildSchedule([
      // mustafa 18:30 UTC = 14:30 local
      makeAppt({ id: "a1", barber_id: "mustafa", barber_name: "Mustafa", service_name: "Haircut", client_name: "Jane", start_datetime: new Date("2026-06-20T18:30:00Z") }),
      // alex 14:30 UTC = 10:30 local
      makeAppt({ id: "a2", barber_id: "alex",    barber_name: "Alex",    service_name: "Beard trim", client_name: "Bob", start_datetime: new Date("2026-06-20T14:30:00Z") }),
    ]);
    expect(schedule.totalCount).toBe(2);
    const text = formatSchedule(schedule);
    expect(text).toMatch(/Schedule for 2026-06-20/);
    expect(text).toMatch(/✂️ Alex \(1\)/);
    expect(text).toMatch(/10:30 — Beard trim — Bob/);
    expect(text).toMatch(/✂️ Mustafa \(1\)/);
    expect(text).toMatch(/14:30 — Haircut — Jane/);
  });
});

describe("tomorrowLocal", () => {
  it("returns the next calendar day in the shop timezone", () => {
    // 2026-06-19 22:00 UTC = 2026-06-19 18:00 EDT → tomorrow is 2026-06-20.
    const t = tomorrowLocal(new Date("2026-06-19T22:00:00Z"));
    expect(t).toEqual({ year: 2026, month: 5, day: 20 });
  });
});
