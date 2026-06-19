Summary

Mustafa's Cuts Bot is a Telegram bot that lets clients view services, choose a barber (Mustafa or Alex), pick an available time and book appointments for the Brooklyn barbershop. The shop owner (Mustafa) receives booking notifications, a daily schedule at 8:00 AM local time, 2-hour appointment reminders, and can block a 30-minute slot with a single tap from the owner chat.

Audience

- Clients of Mustafa's Cuts who want to make appointments via Telegram.
- Shop staff (Mustafa and Alex) who need to view and manage bookings and temporary breaks.

Core entities

- Service (id, name, price, duration_minutes)
- Barber (id, name, display_avatar, work_hours_override)
- Appointment (id, client_name, client_phone, client_telegram_id, service_id, barber_id or "any", start_datetime, end_datetime, status: [booked, confirmed, cancelled, no_show, completed], created_at)
- BlockedSlot (id, barber_id or "both", start_datetime, end_datetime, reason, created_by)
- User (client or staff, telegram_id, role)
- ReminderJob (appointment_id, type: [2h, morning_schedule], sent_at)

Integrations & notification targets

- Telegram Bot API (client-facing chat flows and owner/staff notifications).
- Persistent DB (Postgres preferred) to store services, barbers, appointments, blocked slots, users.
- Background scheduler / worker (e.g., Redis + Sidekiq, Bull, or cron + worker) to dispatch reminders and the daily 8:00 AM schedule.

Notification targets and flows

- Owner (Mustafa) Telegram account: receives
  - immediate notification for each new booking / cancellation / reschedule,
  - daily schedule at 08:00 local time (tomorrow’s full list),
  - 2-hour pre-appointment heads-up for each appointment assigned to Mustafa or to "Any" (optionally to Alex if assigned to Alex),
  - one‑tap buttons in owner chat to block a 30-minute slot for Mustafa or Alex or both.
- Client: receives booking confirmation and a 2-hour reminder (with a Confirm button). Reminder also asks client to tap Confirm; confirmed flag is stored.

Interaction flows

Client flows (Telegram):
- /start — welcome message and quick options: Book appointment, View services, Contact shop.
- Book appointment:
  1. Choose service (list with price and duration).
  2. Choose barber: Mustafa, Alex, or Any barber.
  3. Choose date (calendar UI for next 30 days) — available days only (shop closed Sun/Mon).
  4. Choose time slot — available slots shown (15-minute increments), respecting barber availability, existing appointments, and blocked slots. Slots tied to service duration.
  5. Enter name (pre-fill from Telegram if available) and phone number (required).
  6. Confirm booking — client receives confirmation message with appointment details and a cancel/reschedule link/buttons.
  7. Bot sends owner immediate notification with Accept (no action needed), View, and Quick Cancel buttons.
- Reminders:
  - 2 hours before appointment: client gets reminder with Confirm and Cancel buttons; owner gets a 2-hour heads-up message in owner chat.
  - Optional 15-minute reminder for client (assumption default can be enabled/disabled).
- Cancel/reschedule: client can cancel or request reschedule via the same chat; owner receives notification.

Owner/staff flows (Telegram):
- Private owner chat with bot:
  - Morning schedule at 08:00 local time (tomorrow’s appointments by barber with phone numbers and client names).
  - 2-hour reminders for upcoming appointments with quick actions to Message client (opens client info), Mark as no-show, or Cancel.
  - Quick block: a persistent reply keyboard or inline button "Block 30 min" that creates a BlockedSlot for the selected barber (or both) starting now + a configurable offset (default: immediate start) and lasting 30 minutes.
  - /blocks to list and remove blocked slots.
  - /bookings to view today/tomorrow bookings.

Persistence

- Use Postgres to store all core entities and audit logs.
- Scheduler/worker keeps a queue of pending reminders; state persisted in DB so restarts don’t lose scheduled reminders.
- Store client Telegram ID when they book so reminders and messages reach them.

Payments

- No payments at booking time (owner did not request). System records prices in appointment records only.

No-goals

- No payment processing or deposit flow.
- No third-party calendar synchronization (e.g., Google Calendar) unless requested later.
- No automated charging or forcing cancellations for unconfirmed bookings without owner opt-in.

## Assumptions & defaults

- Timezone: America/New_York (Brooklyn). Rationale: owner located in Brooklyn.
- Service durations (default): Haircut 30m, Beard trim 15m, Haircut+Beard 45m, Kids cut 30m, Hot towel shave 40m — used to compute available slots.
- Slot granularity: 15-minute increments; 10-minute default buffer between bookings per barber to avoid immediate overlap.
- Appointment window: clients may book up to 30 days in advance; same‑day bookings allowed if slot free.
- Reminders: owner gets 2-hour pre-appointment heads-up; clients get 2-hour reminder with a Confirm button (confirmation stored). Rationale: helps reduce no-shows while keeping flow simple.
- Quick-block behavior: "Block 30 min" button creates a 30-minute blocked slot starting immediately (owner can pick start offset in settings later). Rationale: simplest rapid workflow for breaks.
- Owner identity & staff setup: Mustafa’s Telegram ID will be set during initial deployment; Alex is created as a barber account with no owner privileges. Rationale: secure owner controls.

Implementation notes for devs (concise)

- Bot commands: /start, /book, /services, /mybookings, /cancel, owner-only: /blocks, /bookings, /setowner.
- DB: services table seeded with given services and prices/durations; barbers table seeded with Mustafa and Alex.
- Scheduler: worker checks DB for upcoming reminders and daily schedule dispatches; resends if previously failed.
- UI: use Telegram inline keyboards for time slots, barber selection, and confirmation buttons.

This brief contains all decisions needed to start implementation; any change to assumptions (e.g., durations, timezone, requiring deposits) will be handled as a follow-up change request.