-- E3T1 — Mustafa's Cuts Bot initial schema.
-- Entities match docs/spec.md "Core entities". Text ids on services / barbers
-- match the data layer (data.ts) so existing code keeps working; appointments
-- and other high-cardinality tables use UUIDs.
--
-- All times are stored as TIMESTAMPTZ and rendered in the shop's local zone
-- (America/New_York) at the application layer.

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  -- Price in USD cents. NULL means "not set yet" (owner hasn't priced it).
  price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0)
);

CREATE TABLE IF NOT EXISTS barbers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  display_avatar TEXT,
  -- Per-barber work-hour override as a JSON map: { "tue": "10:00-19:00", ... }.
  -- NULL means "use the shop's default hours".
  work_hours_override JSONB
);

CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL,
  client_telegram_id BIGINT NOT NULL,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  -- "any" means "first available barber" (resolved at confirm time).
  -- FK to barbers(id) is enforced at the application layer (barber_id can
  -- also be the literal string "any" so we don't add a hard FK here).
  barber_id TEXT NOT NULL,
  start_datetime TIMESTAMPTZ NOT NULL,
  end_datetime TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked'
    CHECK (status IN ('booked', 'confirmed', 'cancelled', 'no_show', 'completed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_datetime > start_datetime)
);

CREATE INDEX IF NOT EXISTS idx_appointments_barber_start
  ON appointments(barber_id, start_datetime);
CREATE INDEX IF NOT EXISTS idx_appointments_telegram
  ON appointments(client_telegram_id);
CREATE INDEX IF NOT EXISTS idx_appointments_start
  ON appointments(start_datetime);

CREATE TABLE IF NOT EXISTS blocked_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- "both" means the block applies to every barber. Otherwise it's a FK to
  -- barbers(id) — enforced at the application layer for the same reason as
  -- appointments.barber_id.
  barber_id TEXT NOT NULL,
  start_datetime TIMESTAMPTZ NOT NULL,
  end_datetime TIMESTAMPTZ NOT NULL,
  reason TEXT,
  -- Telegram id of the owner who created the block.
  created_by BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_datetime > start_datetime)
);

CREATE INDEX IF NOT EXISTS idx_blocked_barber_start
  ON blocked_slots(barber_id, start_datetime);

CREATE TABLE IF NOT EXISTS users (
  telegram_id BIGINT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'client'
    CHECK (role IN ('client', 'staff', 'owner')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reminder_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('2h', 'morning_schedule')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reminder_appointment
  ON reminder_jobs(appointment_id);

-- Migration tracking (E3T1). The runner inserts a row per applied file so
-- re-running on a populated DB is a no-op.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
