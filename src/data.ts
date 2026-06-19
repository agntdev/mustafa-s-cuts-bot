import { createRequire } from "node:module";
import { getPool } from "./db.js";

// Domain types — the shape of records the bot reads and writes. Kept in one
// place so E3T1 (Postgres schema) and E3T2 (seeding) can target the same
// structure the handlers already consume. The bot reads through
// `getServices()` / `getServiceById()` / `getBarbers()` / `getBarberById()`,
// and the implementation under those exports picks the data source
// transparently (Postgres → Redis → in-code defaults).

export interface Service {
  /** Stable id used in callback_data (e.g. "haircut"). */
  id: string;
  /** Display name (e.g. "Haircut"). */
  name: string;
  /** Price in USD cents, or null when the owner hasn't set it yet. */
  price_cents: number | null;
  /** Service length in minutes — drives slot computation in E1T4. */
  duration_minutes: number;
}

export interface Barber {
  /** Stable id used in callback_data (e.g. "mustafa", "any"). */
  id: string;
  /** Display name (e.g. "Mustafa"). */
  name: string;
  /** Per-barber work-hour override (ISO weekday → "HH:MM-HH:MM"), or null
   *  to use the shop's default hours. Reserved for E3T1+ when the owner
   *  edits availability. */
  work_hours_override: Record<string, string> | null;
}

/** Fallback catalogs used when no Postgres / Redis is configured (dev, test,
 *  harness). These match the rows E3T2 seeds into Postgres and the spec's
 *  documented defaults. */
export const DEFAULT_SERVICES: ReadonlyArray<Service> = [
  { id: "haircut",      name: "Haircut",           price_cents: null, duration_minutes: 30 },
  { id: "beard_trim",   name: "Beard trim",        price_cents: null, duration_minutes: 15 },
  { id: "haircut_beard",name: "Haircut + Beard",   price_cents: null, duration_minutes: 45 },
  { id: "kids",         name: "Kids cut",          price_cents: null, duration_minutes: 30 },
  { id: "hot_towel",    name: "Hot towel shave",   price_cents: null, duration_minutes: 40 },
];

export const DEFAULT_BARBERS: ReadonlyArray<Barber> = [
  { id: "mustafa", name: "Mustafa",    work_hours_override: null },
  { id: "alex",    name: "Alex",       work_hours_override: null },
  // "any" is a virtual id meaning "first available barber" — always
  // synthesised by getBarbers() so the picker always shows it.
  { id: "any",     name: "Any barber", work_hours_override: null },
];

/** Minimal ioredis surface our Redis fallback needs. */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

const SERVICES_KEY = "mcuts:services";
const BARBERS_KEY = "mcuts:barbers";

let redisClient: RedisLike | undefined;
function getRedis(): RedisLike | undefined {
  if (redisClient) return redisClient;
  if (!process.env.REDIS_URL) return undefined;
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ioredis: any = require("ioredis");
    const Redis = ioredis.default ?? ioredis.Redis ?? ioredis;
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    }) as RedisLike;
    return redisClient;
  } catch (err) {
    console.error("[mustafa-cuts] could not load ioredis:", err);
    return undefined;
  }
}

interface ServiceRow {
  id: string;
  name: string;
  price_cents: number | null;
  duration_minutes: number;
}
interface BarberRow {
  id: string;
  name: string;
  work_hours_override: Record<string, string> | null;
}

function parseMaybeJson<T>(v: unknown): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try { return JSON.parse(v) as T; } catch { return null; }
  }
  return v as T;
}

function rowToService(row: ServiceRow): Service {
  return {
    id: row.id,
    name: row.name,
    price_cents: row.price_cents,
    duration_minutes: row.duration_minutes,
  };
}
function rowToBarber(row: BarberRow): Barber {
  return {
    id: row.id,
    name: row.name,
    work_hours_override: parseMaybeJson<Record<string, string>>(row.work_hours_override),
  };
}

async function readServicesFromPostgres(): Promise<Service[] | undefined> {
  const pool = getPool();
  if (!pool) return undefined;
  try {
    const { rows } = await pool.query(
      "SELECT id, name, price_cents, duration_minutes FROM services ORDER BY id",
    );
    const services = (rows as ReadonlyArray<ServiceRow>).map(rowToService);
    return services;
  } catch (err) {
    console.error("[mustafa-cuts] could not read services from postgres:", err);
    return undefined;
  }
}

async function readBarbersFromPostgres(): Promise<Barber[] | undefined> {
  const pool = getPool();
  if (!pool) return undefined;
  try {
    const { rows } = await pool.query(
      "SELECT id, name, work_hours_override FROM barbers ORDER BY id",
    );
    const realBarbers = (rows as ReadonlyArray<BarberRow>).map(rowToBarber);
    // Always append the virtual "any" option so the client picker shows it
    // regardless of what the owner has configured.
    return [...realBarbers, { id: "any", name: "Any barber", work_hours_override: null }];
  } catch (err) {
    console.error("[mustafa-cuts] could not read barbers from postgres:", err);
    return undefined;
  }
}

async function readServicesFromRedis(): Promise<Service[] | undefined> {
  const r = getRedis();
  if (!r) return undefined;
  const raw = await r.get(SERVICES_KEY);
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw) as Service[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeServicesToRedis(services: Service[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(SERVICES_KEY, JSON.stringify(services));
}

async function readBarbersFromRedis(): Promise<Barber[] | undefined> {
  const r = getRedis();
  if (!r) return undefined;
  const raw = await r.get(BARBERS_KEY);
  if (raw == null) return undefined;
  try {
    const parsed = JSON.parse(raw) as Barber[];
    if (!Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function writeBarbersToRedis(barbers: Barber[]): Promise<void> {
  const r = getRedis();
  if (!r) return;
  await r.set(BARBERS_KEY, JSON.stringify(barbers));
}

/**
 * Fetch the full services catalog. Priority: Postgres (E3T1+) → Redis
 * (legacy) → in-code defaults. The defaults are NOT fabricated data —
 * they are the documented services from docs/spec.md, kept here so the
 * bot is functional from the moment the container starts (no DB, no
 * Redis, no seed yet).
 */
export async function getServices(): Promise<Service[]> {
  const fromPostgres = await readServicesFromPostgres();
  if (fromPostgres && fromPostgres.length > 0) return fromPostgres;
  const fromRedis = await readServicesFromRedis();
  if (fromRedis && fromRedis.length > 0) return fromRedis;
  if (getRedis()) {
    try {
      await writeServicesToRedis([...DEFAULT_SERVICES]);
    } catch (err) {
      console.error("[mustafa-cuts] could not backfill services:", err);
    }
  }
  return [...DEFAULT_SERVICES];
}

export async function getServiceById(id: string): Promise<Service | undefined> {
  const services = await getServices();
  return services.find((s) => s.id === id);
}

/**
 * Fetch the barbers catalog. Same Postgres → Redis → defaults priority as
 * `getServices()`. The "any" virtual barber is always included.
 */
export async function getBarbers(): Promise<Barber[]> {
  const fromPostgres = await readBarbersFromPostgres();
  if (fromPostgres && fromPostgres.length > 0) return fromPostgres;
  const fromRedis = await readBarbersFromRedis();
  if (fromRedis && fromRedis.length > 0) return fromRedis;
  if (getRedis()) {
    try {
      await writeBarbersToRedis([...DEFAULT_BARBERS]);
    } catch (err) {
      console.error("[mustafa-cuts] could not backfill barbers:", err);
    }
  }
  return [...DEFAULT_BARBERS];
}

export async function getBarberById(id: string): Promise<Barber | undefined> {
  const barbers = await getBarbers();
  return barbers.find((b) => b.id === id);
}

/** Human-friendly price line for the service picker UI. */
export function formatPrice(service: Service): string {
  if (service.price_cents == null) return "Price TBD";
  const dollars = service.price_cents / 100;
  return `$${dollars.toFixed(2)}`;
}

// Shop hours (E1T4). The spec doesn't pin a value, so the default below is
// the realistic Brooklyn barbershop window the owner can override later.
export const SHOP_OPEN_MINUTES = 10 * 60;   // 10:00
export const SHOP_CLOSE_MINUTES = 19 * 60;  // 19:00
export const SLOT_GRANULARITY_MIN = 15;

export interface TimeSlot {
  /** "HH:MM" — used as the button label and the callback_data value. */
  label: string;
  /** Minutes since midnight (local time). */
  start: number;
  /** Minutes since midnight (local time). */
  end: number;
}

export function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Generate the 15-minute bookable slots for a given service. Until E3T1+
 * fills in real appointments / blocked slots, the slot list is the
 * SHOP_OPEN → SHOP_CLOSE window minus any slot where the service can't
 * finish before close. E3T1 swaps the implementation under
 * `getAvailableSlots()` to filter against the DB.
 */
export function getAvailableSlots(service: Service): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const lastStart = SHOP_CLOSE_MINUTES - service.duration_minutes;
  for (let start = SHOP_OPEN_MINUTES; start <= lastStart; start += SLOT_GRANULARITY_MIN) {
    const end = start + service.duration_minutes;
    slots.push({ label: formatHHMM(start), start, end });
  }
  return slots;
}
