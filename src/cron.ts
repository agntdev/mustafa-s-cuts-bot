import type { Bot } from "grammy";
import { buildSchedule, formatSchedule, getTomorrowAppointments } from "./schedule.js";

// E2T1 — daily 08:00 scheduler. A setInterval ticks every minute; when the
// wall clock in the shop's timezone hits 08:00, the bot fetches
// tomorrow's appointments and sends the formatted schedule to the owner.
// The interval handle is returned so the runtime can clear it on shutdown.

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

/** Start the daily-schedule ticker. Returns a `stop` function that clears
 *  the interval. */
export function startDailySchedule(
  bot: Bot<any>,
  ownerTelegramId: string,
  now: () => Date = () => new Date(),
): () => void {
  let lastSentDate: string | undefined;
  const tick = async () => {
    const d = now();
    const { h, m } = localHourMinute(d);
    if (h !== SCHEDULE_HOUR || m !== SCHEDULE_MINUTE) return;
    // Guard against sending twice on the same local day (e.g. if the
    // process restarts within the same minute).
    const localDay = d.toISOString().slice(0, 10);
    if (lastSentDate === localDay) return;
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
  };
  const handle = setInterval(() => {
    void tick();
  }, 60_000);
  // Run once at startup so a fresh container that boots after 08:00 still
  // tries to send the briefing (the date-guard above prevents a double
  // send on subsequent ticks).
  void tick();
  return () => clearInterval(handle);
}
