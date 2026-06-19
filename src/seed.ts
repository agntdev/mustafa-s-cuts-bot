import type { DbPool } from "./db.js";

// E3T2 — database seeding. Inserts the spec's default services and barbers
// when the corresponding tables are empty. Idempotent: re-running on a
// populated DB is a no-op (uses ON CONFLICT DO NOTHING). The "any" barber
// is a virtual id resolved at confirm time and is NOT seeded as a row —
// getBarbers() synthesises it on read so the client picker always shows it.

/** Default services (id, name, duration_minutes). Prices stay NULL until the
 *  owner sets them via an admin flow (post-E3T2). */
export const DEFAULT_SERVICES: ReadonlyArray<{
  id: string;
  name: string;
  duration_minutes: number;
}> = [
  { id: "haircut",      name: "Haircut",         duration_minutes: 30 },
  { id: "beard_trim",   name: "Beard trim",      duration_minutes: 15 },
  { id: "haircut_beard",name: "Haircut + Beard", duration_minutes: 45 },
  { id: "kids",         name: "Kids cut",        duration_minutes: 30 },
  { id: "hot_towel",    name: "Hot towel shave", duration_minutes: 40 },
];

/** Default barbers (Mustafa + Alex from docs/spec.md). */
export const DEFAULT_BARBERS: ReadonlyArray<{ id: string; name: string }> = [
  { id: "mustafa", name: "Mustafa" },
  { id: "alex",    name: "Alex"    },
];

/** Apply the seed to a given pool. Returns counts of rows actually
 *  inserted (0 when the rows already exist). */
export async function seed(
  pool: DbPool,
  services: ReadonlyArray<{ id: string; name: string; duration_minutes: number }> = DEFAULT_SERVICES,
  barbers: ReadonlyArray<{ id: string; name: string }> = DEFAULT_BARBERS,
): Promise<{ servicesInserted: number; barbersInserted: number }> {
  let servicesInserted = 0;
  for (const s of services) {
    const { rows } = await pool.query(
      `INSERT INTO services (id, name, duration_minutes)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [s.id, s.name, s.duration_minutes],
    );
    if (Array.isArray(rows) && rows.length > 0) servicesInserted++;
  }

  let barbersInserted = 0;
  for (const b of barbers) {
    const { rows } = await pool.query(
      `INSERT INTO barbers (id, name)
       VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [b.id, b.name],
    );
    if (Array.isArray(rows) && rows.length > 0) barbersInserted++;
  }

  return { servicesInserted, barbersInserted };
}
