import { getPool } from "./db.js";

// E2T3 — blocked-slot management. The owner can pause a barber for 30
// minutes (or longer) so no new bookings land in that window. The bot
// surfaces this through /block (pick a barber, create immediately) and
// /blocks (list active blocks with a delete button per row).
//
// All persistence goes through Postgres (E3T1's blocked_slots table). The
// data layer returns [] / false when the pool isn't configured so the
// owner-facing handlers degrade gracefully in dev / test.

export interface BlockedSlot {
  id: string;
  barber_id: string;
  start_datetime: string; // ISO
  end_datetime: string;   // ISO
  reason: string | null;
  created_by: string;
}

/** Insert a new blocked slot. Returns the inserted row, or undefined if
 *  the DB is not configured. */
export async function createBlock(
  barberId: string,
  startDatetime: Date,
  endDatetime: Date,
  createdBy: string,
  reason: string | null = null,
): Promise<BlockedSlot | undefined> {
  const pool = getPool();
  if (!pool) return undefined;
  const { rows } = await pool.query(
    `INSERT INTO blocked_slots (barber_id, start_datetime, end_datetime, reason, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, barber_id, start_datetime, end_datetime, reason, created_by`,
    [barberId, startDatetime.toISOString(), endDatetime.toISOString(), reason, createdBy],
  );
  const row = (rows as ReadonlyArray<BlockedSlot>)[0];
  return row ? { ...row } : undefined;
}

/** List blocks whose end is still in the future, ordered by start. */
export async function listActiveBlocks(now: Date = new Date()): Promise<BlockedSlot[]> {
  const pool = getPool();
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT id, barber_id, start_datetime, end_datetime, reason, created_by
       FROM blocked_slots
      WHERE end_datetime > $1
      ORDER BY start_datetime ASC`,
    [now.toISOString()],
  );
  return (rows as ReadonlyArray<BlockedSlot>).map((r) => ({ ...r }));
}

/** Delete a block by id. Returns true when a row was removed. */
export async function deleteBlock(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const { rows } = await pool.query(
    "DELETE FROM blocked_slots WHERE id = $1 RETURNING id",
    [id],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** Owner check used by the /block and /blocks commands. The owner is
 *  identified by OWNER_TELEGRAM_ID at deploy time; when the env var is
 *  unset, EVERYONE is refused (defence in depth — the default is
 *  "closed", not "open"). */
export function isOwner(userId: number | undefined): boolean {
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (!ownerId) return false;
  if (userId == null) return false;
  return Number(ownerId) === userId;
}
