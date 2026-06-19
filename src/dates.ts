// Date helpers for the booking flow (E1T3+). Pure functions — no I/O — so the
// test harness can replay them deterministically (the harness uses the real
// wall clock for `new Date()`, but the picker logic only depends on the
// returned shapes, not on time).

/** ISO weekday: 0 = Sunday, 1 = Monday, ..., 6 = Saturday. */
export function weekday(date: Date): number {
  return date.getDay();
}

/** True for days the shop is open (Tue=2 ... Sat=6). Sun (0) and Mon (1) are closed. */
export function isShopOpen(date: Date): boolean {
  const wd = weekday(date);
  return wd >= 2 && wd <= 6;
}

/** Format a Date as YYYY-MM-DD in the server's local timezone. Used as the
 *  stable key in callback_data so E1T4+ can match the same date string. */
export function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Parse a YYYY-MM-DD string (as produced by `isoDate`) into a local Date. */
export function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!y || !mo || !d) return null;
  return new Date(y, mo - 1, d);
}

/** A short, human-friendly label for the day cell button, e.g. "Tue 3". */
export function shortDayLabel(date: Date): string {
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(date)] ?? "";
  return `${wd} ${date.getDate()}`;
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthName(date: Date): string {
  return MONTH_NAMES[date.getMonth()] ?? "";
}

/** All available (open and not-in-the-past) days within a month view, as
 *  Date objects in local time. Past days in the current month are excluded. */
export function availableDaysInMonth(year: number, month: number, today: Date): Date[] {
  const out: Date[] = [];
  const last = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const day = new Date(year, month, d);
    if (!isShopOpen(day)) continue;
    // Skip days before today (compare local-date components, not timestamps).
    const dayKey = isoDate(day);
    const todayKey = isoDate(today);
    if (dayKey < todayKey) continue;
    out.push(day);
  }
  return out;
}

/** ISO month key (YYYY-MM) for callback_data. */
export function monthKey(date: Date): string {
  return isoDate(date).slice(0, 7);
}

/** Parse a YYYY-MM month key into { year, month } (0-indexed). */
export function parseMonthKey(key: string): { year: number; month: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]) - 1 };
}
