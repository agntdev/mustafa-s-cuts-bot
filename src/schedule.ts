import { getPool } from "./db.js";

// E2T1 — daily schedule queries. Reads tomorrow's appointments from
// Postgres and groups them by barber for the owner's 08:00 morning
// briefing. The scheduler (src/cron.ts) calls into here; the owner
// identity comes from OWNER_TELEGRAM_ID so the deployment wires it once.

export interface AppointmentRow {
  id: string;
  client_name: string;
  client_phone: string;
  client_telegram_id: string;
  service_id: string;
  barber_id: string;
  start_datetime: Date;
  end_datetime: Date;
  status: string;
}

export interface ScheduleAppointment extends AppointmentRow {
  service_name: string;
  barber_name: string;
}

export interface Schedule {
  /** Date string (YYYY-MM-DD) for the day this schedule covers. */
  date: string;
  /** Grouped by barber id, in chronological order. */
  byBarber: Array<{
    barberId: string;
    barberName: string;
    appointments: ScheduleAppointment[];
  }>;
  /** Total count across all barbers. */
  totalCount: number;
}

/** A day's local-time window as [start, end) UTC instants. The bot is
 *  deployed in America/New_York; the offset is hard-coded for now —
 *  the owner can override via env later (E2T1 ships the read path, the
 *  timezone config is E4T1+). */
const SHOP_TZ_OFFSET_HOURS = -4; // EDT (Mar–Nov). E2T1 ships a single
                                  // fixed offset; DST handling is E4T1.

function startOfDayUtc(year: number, month: number, day: number): Date {
  // Local midnight in shop TZ = UTC midnight - offset
  return new Date(Date.UTC(year, month, day, -SHOP_TZ_OFFSET_HOURS, 0, 0));
}
function endOfDayUtc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month, day, 24 - SHOP_TZ_OFFSET_HOURS, 0, 0));
}

/** Tomorrow's date in the shop's local timezone, as { year, month, day }. */
export function tomorrowLocal(now: Date = new Date()): { year: number; month: number; day: number } {
  // Convert "now" to shop-local Y-M-D by adding the offset.
  const local = new Date(now.getTime() + SHOP_TZ_OFFSET_HOURS * 3600_000);
  const tomorrow = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1));
  return {
    year: tomorrow.getUTCFullYear(),
    month: tomorrow.getUTCMonth(),
    day: tomorrow.getUTCDate(),
  };
}

/** Fetch tomorrow's appointments from Postgres. Returns [] when the pool
 *  isn't configured (dev / test) so callers can render a friendly
 *  "no appointments" message instead of crashing. */
export async function getTomorrowAppointments(
  now: Date = new Date(),
): Promise<ScheduleAppointment[]> {
  const pool = getPool();
  if (!pool) return [];
  const { year, month, day } = tomorrowLocal(now);
  const start = startOfDayUtc(year, month, day);
  const end = endOfDayUtc(year, month, day);
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.client_name, a.client_phone, a.client_telegram_id,
              a.service_id, a.barber_id, a.start_datetime, a.end_datetime, a.status,
              s.name AS service_name,
              COALESCE(b.name, a.barber_id) AS barber_name
         FROM appointments a
         JOIN services s ON s.id = a.service_id
         LEFT JOIN barbers b ON b.id = a.barber_id
        WHERE a.start_datetime >= $1 AND a.start_datetime < $2
          AND a.status NOT IN ('cancelled', 'no_show')
        ORDER BY a.barber_id, a.start_datetime`,
      [start.toISOString(), end.toISOString()],
    );
    return (rows as ReadonlyArray<ScheduleAppointment>).map((r) => ({
      ...r,
      // pg returns timestamps as Date objects already; keep the type.
    }));
  } catch (err) {
    console.error("[mustafa-cuts] could not fetch tomorrow's appointments:", err);
    return [];
  }
}

/** Group a flat appointment list by barber in chronological order. */
export function groupByBarber(
  appointments: ReadonlyArray<ScheduleAppointment>,
): Schedule["byBarber"] {
  const byId = new Map<string, Schedule["byBarber"][number]>();
  for (const a of appointments) {
    let entry = byId.get(a.barber_id);
    if (!entry) {
      entry = {
        barberId: a.barber_id,
        barberName: a.barber_name ?? a.barber_id,
        appointments: [],
      };
      byId.set(a.barber_id, entry);
    }
    entry.appointments.push(a);
  }
  return [...byId.values()].sort((a, b) =>
    a.appointments[0]!.start_datetime.getTime() - b.appointments[0]!.start_datetime.getTime(),
  );
}

/** Render the schedule as a Telegram-friendly message. */
export function formatSchedule(
  schedule: Schedule,
): string {
  if (schedule.totalCount === 0) {
    return `📅 Schedule for ${schedule.date}\n\nNo appointments tomorrow — go easy!`;
  }
  const lines: string[] = [`📅 Schedule for ${schedule.date}`, ""];
  for (const group of schedule.byBarber) {
    lines.push(`✂️ ${group.barberName} (${group.appointments.length})`);
    for (const a of group.appointments) {
      const time = formatTime(a.start_datetime);
      lines.push(`  ${time} — ${a.service_name} — ${a.client_name} (${a.client_phone})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Format a Date as "HH:MM" in the shop's local timezone. */
function formatTime(d: Date): string {
  const local = new Date(d.getTime() + SHOP_TZ_OFFSET_HOURS * 3600_000);
  const h = String(local.getUTCHours()).padStart(2, "0");
  const m = String(local.getUTCMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

/** Build a Schedule from a flat appointment list. */
export function buildSchedule(
  appointments: ReadonlyArray<ScheduleAppointment>,
  now: Date = new Date(),
): Schedule {
  const { year, month, day } = tomorrowLocal(now);
  const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return {
    date,
    byBarber: groupByBarber(appointments),
    totalCount: appointments.length,
  };
}
