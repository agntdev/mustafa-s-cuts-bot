import { createRequire } from "node:module";

// Domain types — the shape of records the bot reads and writes. Kept in one
// place so E3T1 (Postgres schema) and E3T2 (seeding) can target the same
// structure the handlers already consume. No DB code lives here yet: E1T1
// reads through `getServices()` / `getServiceById()`, and E3T1 swaps the
// implementation under those exports without touching the call sites.

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

/** Default catalog from docs/spec.md (the spec's stated service durations).
 *  Prices are intentionally null — the owner sets them in the admin flow
 *  (E2T1+). E3T2 will seed the same records into Postgres with real prices. */
export const DEFAULT_SERVICES: ReadonlyArray<Service> = [
  { id: "haircut",      name: "Haircut",           price_cents: null, duration_minutes: 30 },
  { id: "beard_trim",   name: "Beard trim",        price_cents: null, duration_minutes: 15 },
  { id: "haircut_beard",name: "Haircut + Beard",   price_cents: null, duration_minutes: 45 },
  { id: "kids",         name: "Kids cut",          price_cents: null, duration_minutes: 30 },
  { id: "hot_towel",    name: "Hot towel shave",   price_cents: null, duration_minutes: 40 },
];

/** Default barbers from docs/spec.md. "any" is a virtual id meaning "first
 *  available barber" — the booking flow resolves it at confirmation time. */
export const DEFAULT_BARBERS: ReadonlyArray<Barber> = [
  { id: "mustafa", name: "Mustafa", work_hours_override: null },
  { id: "alex",    name: "Alex",    work_hours_override: null },
  { id: "any",     name: "Any barber", work_hours_override: null },
];

/**
 * The minimal ioredis surface our data layer needs. Mirrors the
 * `RedisLike` shape in `src/toolkit/session/redis.ts` so the same lazy
 * import trick keeps ioredis out of the bundle when REDIS_URL is unset.
 */
interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

/** Single namespace keys for the catalogs. */
const SERVICES_KEY = "mcuts:services";
const BARBERS_KEY = "mcuts:barbers";

/** Lazily-loaded ioredis singleton, or undefined when REDIS_URL is unset. */
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
    // ioredis not installed in this build — fall through to the default
    // catalog. The bot still functions in dev; production deploys must
    // install ioredis (it's already a dependency for the toolkit's session
    // storage).
    console.error("[mustafa-cuts] could not load ioredis:", err);
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
 * Fetch the full services catalog. Reads from Redis when REDIS_URL is set
 * (production) and falls back to the spec-defined defaults otherwise (dev /
 * tests / fresh deploys before E3T2 ships). The defaults are NOT fabricated
 * data — they are the documented services from docs/spec.md, kept here so
 * the bot is functional from the moment the container starts.
 */
export async function getServices(): Promise<Service[]> {
  const fromRedis = await readServicesFromRedis();
  if (fromRedis && fromRedis.length > 0) return fromRedis;
  // Backfill: write the defaults into Redis so the next call (and any
  // other process) sees the same source of truth. Failures are non-fatal —
  // the in-process defaults are still returned below.
  if (getRedis()) {
    try {
      await writeServicesToRedis([...DEFAULT_SERVICES]);
    } catch (err) {
      console.error("[mustafa-cuts] could not backfill services:", err);
    }
  }
  return [...DEFAULT_SERVICES];
}

/** Look up a single service by id. Returns undefined when not found. */
export async function getServiceById(id: string): Promise<Service | undefined> {
  const services = await getServices();
  return services.find((s) => s.id === id);
}

/**
 * Fetch the barbers catalog. Same Redis-or-defaults pattern as
 * `getServices()`. The "any" virtual barber is always included so the
 * client-side "any barber" option resolves to a real id.
 */
export async function getBarbers(): Promise<Barber[]> {
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

/** Look up a single barber by id. Returns undefined when not found. */
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
