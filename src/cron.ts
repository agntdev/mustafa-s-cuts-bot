import type { Bot } from "grammy";
import { buildSchedule, formatSchedule, getTomorrowAppointments } from "./schedule.js";
import {
  findAppointmentsNeedingReminders,
  formatReminder,
  recordReminderSent,
  reminderKeyboard,
} from "./reminders.js";

// E4T1 — background scheduler / worker. Runs two jobs:
//   1. Daily 08:00 schedule (E2T1): fetch tomorrow's appointments and
//      send the owner a formatted briefing.
//   2. Every-minute 2-hour reminder tick (E2T2): find appointments whose
//      start is in [now+115min, now+125min] with no prior '2h' reminder
//      and send the owner a heads-up with quick actions.
//
// The worker is a thin wrapper around the two job functions — each one
// is independently unit-testable, and the worker just orchestrates the
// tick. On any error inside a job, the error is logged and the next
// tick proceeds (the worker never crashes the bot).

/** The hour / minute (in the shop's local timezone) at which the daily
 *  schedule is sent. */
export const SCHEDULE_HOUR = 8;
export const SCHEDULE_MINUTE = 0;
const SHOP_TZ_OFFSET_HOURS = -4; // mirror schedule.ts; E4T1+ adds proper TZ config.

/** Local-time hour / minute from a Date, in the shop's timezone. */
function localHourMinute(d: Date): { h: number; m: number } {
  const local = new Date(d.getTime() + SHOP_TZ_OFFSET_HOURS * 3600_000);
  return { h: local.getUTCHours(), m: local.getUTCMinutes() };
}

/** E2T2 — 2-hour reminder ticker. For each eligible appointment (start
 *  time in [now+115min, now+125min], no prior '2h' reminder) it sends
 *  the owner a heads-up with quick actions and records the send. */
export async function tickReminders(
  bot: Bot<any>,
  ownerTelegramId: string,
  now: Date = new Date(),
): Promise<number> {
  const due = await findAppointmentsNeedingReminders(now);
  if (due.length === 0) return 0;
  let sent = 0;
  for (const a of due) {
    try {
      await bot.api.sendMessage(Number(ownerTelegramId), formatReminder(a), {
        reply_markup: reminderKeyboard(a),
      });
      await recordReminderSent(a.id);
      sent++;
    } catch (err) {
      console.error(`[mustafa-cuts] reminder send failed for ${a.id}:`, err);
    }
  }
  return sent;
}

/** E2T1 — daily 08:00 schedule ticker. Returns true when a schedule was
 *  sent on this tick, false otherwise (including when the date-guard
 *  skipped a duplicate). */
export async function tickDailySchedule(
  bot: Bot<any>,
  ownerTelegramId: string,
  now: Date = new Date(),
  lastSentDate?: string,
): Promise<{ sent: boolean; lastSentDate: string | undefined }> {
  const { h, m } = localHourMinute(now);
  if (h !== SCHEDULE_HOUR || m !== SCHEDULE_MINUTE) {
    return { sent: false, lastSentDate };
  }
  // The ISO date in the SHOP timezone (approximate — UTC midnight is
  // close enough for the dedupe guard).
  const localDay = now.toISOString().slice(0, 10);
  if (lastSentDate === localDay) return { sent: false, lastSentDate };
  try {
    const appointments = await getTomorrowAppointments(now);
    const schedule = buildSchedule(appointments, now);
    const text = formatSchedule(schedule);
    await bot.api.sendMessage(Number(ownerTelegramId), text);
    console.log(`[mustafa-cuts] sent daily schedule (${schedule.totalCount} appointments)`);
    return { sent: true, lastSentDate: localDay };
  } catch (err) {
    console.error("[mustafa-cuts] daily schedule send failed:", err);
    return { sent: false, lastSentDate };
  }
}

/** A single worker iteration: runs both jobs against the current time.
 *  Exported for testing (no real timer needed) and so the runtime can
 *  trigger a manual tick on startup. */
export async function runOnce(
  bot: Bot<any>,
  ownerTelegramId: string,
  now: Date,
  lastSentDate?: string,
): Promise<{ reminders: number; dailySchedule: boolean; lastSentDate: string | undefined }> {
  const daily = await tickDailySchedule(bot, ownerTelegramId, now, lastSentDate);
  const reminders = await tickReminders(bot, ownerTelegramId, now);
  return {
    reminders,
    dailySchedule: daily.sent,
    lastSentDate: daily.lastSentDate,
  };
}

/** Start the background worker. Returns a `stop` function that clears
 *  the interval and releases resources. The worker runs once at startup
 *  (so a fresh container that boots after 08:00 still tries to send the
 *  briefing) and then ticks every 60s. */
export function startWorker(
  bot: Bot<any>,
  ownerTelegramId: string,
  options: { intervalMs?: number; now?: () => Date; onError?: (err: unknown) => void } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((err) => console.error("[mustafa-cuts] worker error:", err));
  let lastSentDate: string | undefined;

  const tick = async () => {
    try {
      const result = await runOnce(bot, ownerTelegramId, now(), lastSentDate);
      lastSentDate = result.lastSentDate;
      if (result.reminders > 0) {
        console.log(`[mustafa-cuts] sent ${result.reminders} 2-hour reminder(s)`);
      }
    } catch (err) {
      onError(err);
    }
  };

  console.log(
    `[mustafa-cuts] worker started (interval ${intervalMs}ms, owner ${ownerTelegramId})`,
  );
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Run once immediately on startup.
  void tick();
  return () => {
    clearInterval(handle);
    console.log("[mustafa-cuts] worker stopped");
  };
}

/** Backwards-compatible alias used by the runtime entry (index.ts). */
export function startDailySchedule(
  bot: Bot<any>,
  ownerTelegramId: string,
  now: () => Date = () => new Date(),
): () => void {
  return startWorker(bot, ownerTelegramId, { now });
}
