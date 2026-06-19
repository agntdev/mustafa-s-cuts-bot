import { getPool } from "./db.js";

// E2T2 — 2-hour pre-appointment reminders. The cron ticker (cron.ts) calls
// `findAppointmentsNeedingReminders` every minute to find appointments
// whose start time falls in a small window around "now + 2h" and that
// haven't been reminded yet, then sends the owner a heads-up with quick
// actions.

export interface ReminderAppointment {
  id: string;
  client_name: string;
  client_phone: string;
  client_telegram_id: string;
  service_id: string;
  service_name: string;
  barber_id: string;
  barber_name: string;
  start_datetime: string; // ISO
  end_datetime: string;   // ISO
  status: string;
}

/** The "2 hours before" window. Default: appointments starting between
 *  now+115min and now+125min are eligible. The 10-minute window lets the
 *  cron ticker run once a minute and still catch every appointment. */
const WINDOW_BEFORE_MIN = 125;
const WINDOW_AFTER_MIN = 115;

/** Return appointments that need a 2-hour reminder right now. */
export async function findAppointmentsNeedingReminders(
  now: Date = new Date(),
): Promise<ReminderAppointment[]> {
  const pool = getPool();
  if (!pool) return [];
  const start = new Date(now.getTime() + WINDOW_AFTER_MIN * 60_000);
  const end = new Date(now.getTime() + WINDOW_BEFORE_MIN * 60_000);
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.client_name, a.client_phone, a.client_telegram_id,
              a.service_id, s.name AS service_name,
              a.barber_id, COALESCE(b.name, a.barber_id) AS barber_name,
              a.start_datetime, a.end_datetime, a.status
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         LEFT JOIN barbers b ON b.id = a.barber_id
         LEFT JOIN reminder_jobs r
           ON r.appointment_id = a.id AND r.type = '2h'
        WHERE a.start_datetime >= $1 AND a.start_datetime <= $2
          AND a.status IN ('booked', 'confirmed')
          AND r.id IS NULL
        ORDER BY a.start_datetime`,
      [start.toISOString(), end.toISOString()],
    );
    return (rows as ReadonlyArray<ReminderAppointment>).map((r) => ({ ...r }));
  } catch (err) {
    console.error("[mustafa-cuts] could not find appointments needing reminders:", err);
    return [];
  }
}

/** Record that a reminder was sent for an appointment. The query above
 *  filters by reminder_jobs so re-recording is safe (the unique index on
 *  (appointment_id, type) would also block duplicates). */
export async function recordReminderSent(appointmentId: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      "INSERT INTO reminder_jobs (appointment_id, type) VALUES ($1, '2h') ON CONFLICT DO NOTHING",
      [appointmentId],
    );
  } catch (err) {
    console.error("[mustafa-cuts] could not record reminder:", err);
  }
}

/** Format a reminder message for the owner. */
export function formatReminder(a: ReminderAppointment): string {
  const start = new Date(a.start_datetime);
  const time = start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  return (
    `⏰ 2-hour heads-up\n\n` +
    `${a.service_name} with ${a.barber_name} at ${time}\n` +
    `Client: ${a.client_name} (${a.client_phone})\n` +
    `Telegram: ${a.client_telegram_id}\n\n` +
    `Quick actions below.`
  );
}

/** Build the inline keyboard for the reminder message. The "Message client"
 *  button uses Telegram's tg://user?id=… deep link so the owner can
 *  tap straight into a chat with the client. */
export function reminderKeyboard(a: ReminderAppointment) {
  return {
    inline_keyboard: [
      [
        { text: "✉️ Message client", url: `tg://user?id=${a.client_telegram_id}` },
        { text: "🚫 No-show", callback_data: `noshow:${a.id}` },
        { text: "❌ Cancel", callback_data: `cancel_appt:${a.id}` },
      ],
    ],
  };
}
