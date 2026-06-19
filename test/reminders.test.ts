import { describe, expect, it } from "vitest";
import {
  findAppointmentsNeedingReminders,
  formatReminder,
  recordReminderSent,
  reminderKeyboard,
  type ReminderAppointment,
} from "../src/reminders";
import { __setPoolForTests } from "../src/db";
import type { DbPool } from "../src/db";

// E2T2 — reminders tests. The query + formatting live in reminders.ts;
// the cron ticker (cron.ts) just calls into here every minute.

class FakePool implements DbPool {
  rows: unknown[] = [];
  lastQuery: { text: string; params: ReadonlyArray<unknown> } | undefined;
  async query(text: string, params?: ReadonlyArray<unknown>) {
    this.lastQuery = { text, params: params ?? [] };
    return { rows: this.rows };
  }
  async end() { /* noop */ }
}

function makeAppt(overrides: Partial<ReminderAppointment> = {}): ReminderAppointment {
  return {
    id: "appt-1",
    client_name: "Jane Doe",
    client_phone: "555-123-4567",
    client_telegram_id: "4242",
    service_id: "haircut",
    service_name: "Haircut",
    barber_id: "mustafa",
    barber_name: "Mustafa",
    start_datetime: "2026-06-20T18:30:00.000Z", // 14:30 EDT
    end_datetime:   "2026-06-20T19:00:00.000Z",
    status: "booked",
    ...overrides,
  };
}

describe("findAppointmentsNeedingReminders", () => {
  it("queries with a [now+115min, now+125min] window and filters already-reminded", async () => {
    const pool = new FakePool();
    pool.rows = [makeAppt()];
    const restore = __setPoolForTests(pool);
    try {
      const now = new Date("2026-06-20T16:30:00Z");
      const appts = await findAppointmentsNeedingReminders(now);
      expect(appts).toHaveLength(1);
      expect(pool.lastQuery?.text).toMatch(/LEFT JOIN reminder_jobs r/);
      expect(pool.lastQuery?.text).toMatch(/r\.type = '2h'/);
      expect(pool.lastQuery?.text).toMatch(/r\.id IS NULL/);
      // Window params: [start, end] ISO strings.
      expect(pool.lastQuery?.params).toHaveLength(2);
      const [startStr, endStr] = pool.lastQuery?.params as [string, string];
      const start = new Date(startStr);
      const end = new Date(endStr);
      // start = now + 115min, end = now + 125min
      expect(end.getTime() - start.getTime()).toBe(10 * 60_000);
    } finally {
      restore();
    }
  });

  it("returns [] when no pool is configured", async () => {
    const restore = __setPoolForTests(undefined);
    try {
      const appts = await findAppointmentsNeedingReminders();
      expect(appts).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("recordReminderSent", () => {
  it("inserts a row with the '2h' type literal in the SQL", async () => {
    const pool = new FakePool();
    const restore = __setPoolForTests(pool);
    try {
      await recordReminderSent("appt-1");
      expect(pool.lastQuery?.text).toMatch(/INSERT INTO reminder_jobs/);
      expect(pool.lastQuery?.text).toMatch(/'2h'/);
      expect(pool.lastQuery?.params).toEqual(["appt-1"]);
    } finally {
      restore();
    }
  });
});

describe("formatReminder", () => {
  it("includes service, barber, time, client name, phone, and telegram id", () => {
    const text = formatReminder(makeAppt());
    expect(text).toMatch(/⏰ 2-hour heads-up/);
    expect(text).toMatch(/Haircut with Mustafa/);
    // toLocaleTimeString is locale + timezone dependent. Just assert the
    // rendered string has the expected shape "H:MM AM/PM" or "HH:MM".
    expect(text).toMatch(/at \d{1,2}:\d{2}\s?(AM|PM)?/);
    expect(text).toMatch(/Jane Doe/);
    expect(text).toMatch(/555-123-4567/);
    expect(text).toMatch(/4242/);
  });
});

describe("reminderKeyboard", () => {
  it("exposes Message / No-show / Cancel with the appointment id in callbacks", () => {
    const kb = reminderKeyboard(makeAppt({ id: "abc-123" }));
    const row = kb.inline_keyboard[0];
    expect(row).toBeDefined();
    expect(row?.[0]?.url).toBe("tg://user?id=4242");
    expect(row?.[1]?.callback_data).toBe("noshow:abc-123");
    expect(row?.[2]?.callback_data).toBe("cancel_appt:abc-123");
  });
});
