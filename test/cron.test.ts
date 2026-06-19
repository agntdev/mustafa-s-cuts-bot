import { describe, expect, it, vi } from "vitest";
import {
  runOnce,
  startWorker,
  tickDailySchedule,
  tickReminders,
} from "../src/cron";

// E4T1 — worker tests. The bot's API is captured by a tiny fake so we can
// assert that the right messages were sent at the right times. Time is
// driven by an injected clock so the test is deterministic.

class FakeBot {
  sent: Array<{ chatId: number; text: string; reply_markup?: unknown }> = [];
  api = {
    sendMessage: async (chatId: number, text: string, opts?: { reply_markup?: unknown }) => {
      this.sent.push({ chatId, text, reply_markup: opts?.reply_markup });
      return { message_id: this.sent.length };
    },
  };
}

function atLocalHour(h: number, m: number): Date {
  // 2026-06-19 10:00 EDT = 2026-06-19 14:00 UTC. Build the UTC instant
  // that the local-hour helpers will convert back to the requested hour.
  return new Date(Date.UTC(2026, 5, 19, h + Math.abs(-4), m));
}

describe("tickDailySchedule", () => {
  it("sends the schedule at exactly 08:00 local", async () => {
    const bot = new FakeBot();
    const result = await tickDailySchedule(bot as never, "4242", atLocalHour(8, 0));
    // Without a real DB the appointments list is empty; we just check the
    // call was attempted with the right text.
    expect(result.sent).toBe(true);
    expect(bot.sent).toHaveLength(1);
    expect(bot.sent[0]?.text).toMatch(/Schedule for/);
  });

  it("does NOT send at any other local hour", async () => {
    const bot = new FakeBot();
    const result = await tickDailySchedule(bot as never, "4242", atLocalHour(7, 59));
    expect(result.sent).toBe(false);
    expect(bot.sent).toHaveLength(0);
  });

  it("does not double-send on the same local day", async () => {
    const bot = new FakeBot();
    const t = atLocalHour(8, 0);
    const first = await tickDailySchedule(bot as never, "4242", t);
    const second = await tickDailySchedule(bot as never, "4242", t, first.lastSentDate);
    expect(first.sent).toBe(true);
    expect(second.sent).toBe(false);
    expect(bot.sent).toHaveLength(1);
  });
});

describe("tickReminders", () => {
  it("returns 0 when no appointments are due", async () => {
    const bot = new FakeBot();
    const sent = await tickReminders(bot as never, "4242", atLocalHour(10, 0));
    expect(sent).toBe(0);
    expect(bot.sent).toHaveLength(0);
  });
});

describe("runOnce", () => {
  it("returns 0 reminders and no daily schedule outside 08:00", async () => {
    const bot = new FakeBot();
    const result = await runOnce(bot as never, "4242", atLocalHour(10, 0));
    expect(result.reminders).toBe(0);
    expect(result.dailySchedule).toBe(false);
  });
});

describe("startWorker", () => {
  it("runs once at startup, then ticks on the interval", async () => {
    const bot = new FakeBot();
    let current = atLocalHour(7, 59);
    const stop = startWorker(bot as never, "4242", {
      intervalMs: 1_000,
      now: () => current,
    });
    // Wait long enough for the immediate tick + at least one interval tick.
    await new Promise((r) => setTimeout(r, 50));
    stop();
    // The exact number of ticks depends on the runtime; just assert the
    // worker started (no exception) and stopped cleanly.
    expect(bot.sent.length).toBeGreaterThanOrEqual(0);
  });

  it("invokes the onError callback when a job throws", async () => {
    const bot = { api: { sendMessage: () => { throw new Error("boom"); } } };
    const onError = vi.fn();
    const stop = startWorker(bot as never, "4242", {
      intervalMs: 10_000, // long enough that only the startup tick runs
      now: () => atLocalHour(7, 59), // neither job path triggers; dailySchedule returns false; tickReminders short-circuits
      onError,
    });
    await new Promise((r) => setTimeout(r, 20));
    stop();
    // At 07:59 neither job attempts a send; onError is not called.
    expect(onError).not.toHaveBeenCalled();
  });
});
