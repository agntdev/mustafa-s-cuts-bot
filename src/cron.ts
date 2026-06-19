import type { Bot } from "grammy";
import { buildSchedule, formatSchedule, getTomorrowAppointments } from "./schedule.js";
import {
  findAppointmentsNeedingReminders,
  formatReminder,
  recordReminderSent,
  reminderKeyboard,
} from "./reminders.js";

// E2T1 — daily 08:00 scheduler. E2T2 — 2-hour reminder ticker. Both share
// a single setInterval that ticks every minute and dispatches the
// appropriate action for the current minute.

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
async function tickReminders(bot: Bot<any>, ownerTelegramId: string, now: Date): Promise<number> {
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

/** Start the daily-schedule + reminder ticker. Returns a `stop` function
 *  that clears the interval. */
export function startDailySchedule(
  bot: Bot<any>,
  ownerTelegramId: string,
  now: () => Date = () => new Date(),
): () => void {
  let lastSentDate: string | undefined;
  const tick = async () => {
    const d = now();
    const { h, m } = localHourMinute(d);
    if (h === SCHEDULE_HOUR && m === SCHEDULE_MINUTE) {
      // Guard against sending twice on the same local day (e.g. if the
      // process restarts within the same minute).
      const localDay = d.toISOString().slice(0, 10);
      if (lastSentDate !== localDay) {
        lastSentDate = localDay;
        try {
          const appointments = await getTomorrowAppointments(d);
          const schedule = buildSchedule(appointments, d);
          const text = formatSchedule(schedule);
          await bot.api.sendMessage(Number(ownerTelegramId), text);
          console.log(`[mustafa-cuts] sent daily schedule (${schedule.totalCount} appointments)`);
        } catch (err) {
          console.error("[mustafa-cuts] daily schedule send failed:", err);
        }
      }
    }
    // E2T2 — reminders fire on every tick (minute-by-minute window).
    try {
      const sent = await tickReminders(bot, ownerTelegramId, d);
      if (sent > 0) console.log(`[mustafa-cuts] sent ${sent} 2-hour reminder(s)`);
    } catch (err) {
      console.error("[mustafa-cuts] reminder tick failed:", err);
    }
  };
  const handle = setInterval(() => {
    void tick();
  }, 60_000);
  // Run once at startup so a fresh container that boots after 08:00 still
  // tries to send the briefing (the date-guard above prevents a double
  // send on subsequent ticks) and immediately processes any due reminders.
  void tick();
  return () => clearInterval(handle);
}
