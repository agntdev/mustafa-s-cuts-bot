import { createBot, type BotContext } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";
import {
  formatPrice,
  getAvailableSlots,
  getBarberById,
  getBarbers,
  getServiceById,
  getServices,
  type Barber,
  type Service,
  type TimeSlot,
} from "./data.js";
import {
  availableDaysInMonth,
  isoDate,
  monthKey,
  monthName,
  parseMonthKey,
  shortDayLabel,
} from "./dates.js";

// Per-chat session shape. The `booking` field carries the in-progress
// selection through the E1T1→E1T6 flow (service → barber → date → time →
// client info → confirm). It's deliberately opt-in per field so each step
// can read what the previous step wrote and ignore the rest. `awaitingInput`
// drives the free-text handler (E1T5) to know which field to fill next.
export interface Session {
  booking?: {
    serviceId?: string;
    barberId?: string;
    date?: string;
    time?: string;
    clientName?: string;
    clientPhone?: string;
    /** The month currently being browsed in the date picker (E1T3). */
    datePickerMonth?: string;
  };
  awaitingInput?: "name" | "phone" | null;
}

// Main-menu callback_data keys. /start surfaces three quick options for the
// client. T02 wires the routing: each button edits the welcome message in
// place to that feature's view, and a "back" button returns to the main menu.
const MENU_BOOK = "menu:book";
const MENU_SERVICES = "menu:services";
const MENU_CONTACT = "menu:contact";
const MENU_BACK = "menu:back";

const WELCOME_TEXT =
  "Welcome to Mustafa's Cuts 💈\n\n" +
  "Brooklyn's finest haircuts, beard trims, and shaves.\n" +
  "What would you like to do?";

const SERVICES_TEXT =
  "💇 Our services\n\n" +
  "• Haircut — 30 min\n" +
  "• Beard trim — 15 min\n" +
  "• Haircut + Beard — 45 min\n" +
  "• Kids cut — 30 min\n" +
  "• Hot towel shave — 40 min\n\n" +
  "Tap Book appointment to schedule.";

const CONTACT_TEXT =
  "📞 Contact Mustafa's Cuts\n\n" +
  "📍 Brooklyn, NY\n" +
  "🕐 Tue–Sat (closed Sun & Mon)\n" +
  "💬 Message us right here on Telegram\n\n" +
  "Prefer to book? Tap Book appointment.";

const HELP_TEXT =
  "Mustafa's Cuts — help 💈\n\n" +
  "Here's what I can do right now:\n" +
  "/start — Open the main menu (Book, Services, Contact)\n" +
  "/help  — Show this help message\n\n" +
  "Tip: most things are easier from the menu — just tap /start.";

// Commands the bot recognises today. Used by the unknown-command guard so we
// only intercept "/foo" and let /start, /help, /book through to their handlers.
const KNOWN_COMMANDS = new Set(["start", "help", "book", "services"]);

// Callback prefixes for the booking flow.
const SERVICE_PREFIX = "service:";
const BARBER_PREFIX = "barber:";
const DATE_PREFIX = "date:";
const DATE_NAV_PREFIX = "date_nav:";
const TIME_PREFIX = "time:";
const BOOKING_BACK_SERVICES = "booking:back_services";
const BOOKING_BACK_BARBER = "booking:back_barber";
const BOOKING_BACK_DATE = "booking:back_date";
const BOOKING_BACK_TIME = "booking:back_time";

/** Build the service-picker keyboard from the current catalog. */
function servicePickerKeyboard(services: ReadonlyArray<Service>) {
  return inlineKeyboard([
    ...services.map((s) => [
      inlineButton(`${s.name} — ${s.duration_minutes} min`, `${SERVICE_PREFIX}${s.id}`),
    ]),
    [inlineButton("🔙 Main menu", MENU_BACK)],
  ]);
}

/** Service-picker header text. */
function servicePickerText(): string {
  return "📅 Book an appointment\n\nChoose a service to see the time slots:";
}

/** Build the barber-picker keyboard from the current barbers list. */
function barberPickerKeyboard(barbers: ReadonlyArray<Barber>) {
  return inlineKeyboard([
    ...barbers.map((b) => [inlineButton(b.name, `${BARBER_PREFIX}${b.id}`)]),
    [inlineButton("🔙 Back to services", BOOKING_BACK_SERVICES)],
  ]);
}

/** Barber-picker header text. */
function barberPickerText(): string {
  return "✂️ Choose a barber";
}

/** Maximum days the user can book ahead (per docs/spec.md). */
const MAX_LOOKAHEAD_DAYS = 30;

/** True when `monthKey` is within the 30-day lookahead window from `today`. */
function isMonthInLookahead(monthKeyValue: string, today: Date): boolean {
  const parsed = parseMonthKey(monthKeyValue);
  if (!parsed) return false;
  // First day of the target month vs today + 30 days
  const target = new Date(parsed.year, parsed.month, 1);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + MAX_LOOKAHEAD_DAYS);
  return target <= cutoff;
}

/** Build the date-picker keyboard for a given month view. Shows the day's
 *  number in each button; closed days (Sun/Mon) are omitted from the grid. */
function datePickerKeyboard(
  year: number,
  month: number,
  today: Date,
): ReturnType<typeof inlineKeyboard> {
  const days = availableDaysInMonth(year, month, today);
  const rows: import("./toolkit/ui/keyboard.js").InlineButton[][] = days.map((d) => [
    inlineButton(`${d.getDate()}`, `${DATE_PREFIX}${isoDate(d)}`),
  ]);
  // Pagination — only show "Next month" if it's within the 30-day lookahead
  // AND there are days to show in the next month. "Prev month" is omitted
  // because the user shouldn't book in the past.
  const navRow: import("./toolkit/ui/keyboard.js").InlineButton[] = [];
  const currentMonthKey = monthKey(new Date(year, month, 1));
  const nextMonthDate = new Date(year, month + 1, 1);
  if (isMonthInLookahead(monthKey(nextMonthDate), today)) {
    navRow.push(
      inlineButton("Next month →", `${DATE_NAV_PREFIX}${monthKey(nextMonthDate)}`),
    );
  }
  // Avoid an empty nav row.
  if (navRow.length > 0) rows.push(navRow);
  rows.push([inlineButton("🔙 Back to barbers", BOOKING_BACK_BARBER)]);
  // Reference currentMonthKey so eslint doesn't complain about an unused var
  // (kept for future "current month" indicator work in E1T3+).
  void currentMonthKey;
  return { inline_keyboard: rows };
}

/** Date-picker header text. */
function datePickerText(year: number, month: number): string {
  const sample = new Date(year, month, 1);
  return `📅 Pick a date — ${monthName(sample)} ${year}\n\nClosed Sun & Mon.`;
}

/** Build the time-picker keyboard from a service's available slots. Two
 *  slots per row keeps the buttons a comfortable width. */
function timePickerKeyboard(slots: ReadonlyArray<TimeSlot>): ReturnType<typeof inlineKeyboard> {
  const rows: import("./toolkit/ui/keyboard.js").InlineButton[][] = [];
  for (let i = 0; i < slots.length; i += 2) {
    const row = slots.slice(i, i + 2).map((s) => inlineButton(s.label, `${TIME_PREFIX}${s.label}`));
    rows.push(row);
  }
  rows.push([inlineButton("🔙 Back to calendar", BOOKING_BACK_DATE)]);
  return { inline_keyboard: rows };
}

/** Time-picker header text. */
function timePickerText(service: Service): string {
  return `🕐 Pick a time for ${service.name} (${service.duration_minutes} min)\n\n15-min slots between 10:00 and 19:00.`;
}

/** Edit an existing message in place to the date picker for a given month. */
function editToDatePickerForMonth(
  ctx: { editMessageText: (text: string, opts?: object) => Promise<unknown> },
  year: number,
  month: number,
  today: Date,
) {
  return ctx.editMessageText(datePickerText(year, month), {
    reply_markup: datePickerKeyboard(year, month, today),
  });
}

/** Render the service picker into the chat. */
async function showServicePicker(ctx: { reply: (text: string, opts?: object) => Promise<unknown> }) {
  const services = await getServices();
  await ctx.reply(servicePickerText(), { reply_markup: servicePickerKeyboard(services) });
}

/** Edit an existing message in place to the service picker. */
async function editToServicePicker(ctx: {
  editMessageText: (text: string, opts?: object) => Promise<unknown>;
}) {
  const services = await getServices();
  await ctx.editMessageText(servicePickerText(), {
    reply_markup: servicePickerKeyboard(services),
  });
}

/** Edit an existing message in place to the barber picker. */
async function editToBarberPicker(ctx: {
  editMessageText: (text: string, opts?: object) => Promise<unknown>;
}) {
  const barbers = await getBarbers();
  await ctx.editMessageText(barberPickerText(), {
    reply_markup: barberPickerKeyboard(barbers),
  });
}

/**
 * buildBot — assembles the bot and registers every handler, but does NOT start
 * it. Shared by the runtime entry (src/index.ts) and the Tests-gate harness
 * (src/harness-entry.ts) so both exercise the exact same bot. Add new commands
 * and flows here.
 */
export function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // Global error boundary (T03): catches any throw from a downstream handler
  // and replies with a friendly fallback instead of dropping the update. Sits
  // at the top of the middleware chain so it wraps every command and callback.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      console.error("[mustafa-cuts] unhandled error:", err);
      try {
        await ctx.reply(
          "Sorry, something went wrong on my end. Please try again, " +
            "or tap /start to return to the main menu.",
        );
      } catch {
        // The user may have blocked the bot or the chat may be unavailable —
        // there's nothing more we can do beyond the log above.
      }
    }
  });

  const mainMenu = inlineKeyboard([
    [inlineButton("📅 Book appointment", MENU_BOOK)],
    [inlineButton("💇 View services", MENU_SERVICES)],
    [inlineButton("📞 Contact shop", MENU_CONTACT)],
  ]);

  const backButton = (): ReturnType<typeof inlineKeyboard> =>
    inlineKeyboard([[inlineButton("🔙 Main menu", MENU_BACK)]]);

  // Unknown-command guard (T03). Runs before the command router: if the message
  // text is a "/command" we don't recognise, reply with a friendly hint and
  // stop the chain so the command router doesn't claim it. Free-text (no leading
  // slash) is routed to the E1T5 booking-input handler when `awaitingInput` is
  // set, and silently ignored otherwise.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/")) {
      const firstToken = text.split(/\s+/)[0] ?? "";
      const cmd = firstToken.startsWith("/") ? firstToken.slice(1) : firstToken;
      const bare = cmd.split("@")[0] ?? "";
      if (bare !== "" && !KNOWN_COMMANDS.has(bare)) {
        await ctx.reply(
          `I don't recognise /${bare}. Try /start to open the menu, or /help for what I can do.`,
        );
        return;
      }
    }
    await next();
  });

  // E1T5 — free-text input handler for the booking flow. When the user is
  // mid-flow (awaitingInput is "name" or "phone"), the next text message
  // fills that field and advances. Otherwise the chain continues so
  // commands / unknown-command guard can still claim it.
  bot.on("message:text", async (ctx, next) => {
    const c = ctx as unknown as BotContext<Session>;
    const awaiting = c.session.awaitingInput;
    if (!awaiting) return next();
    const text = (ctx.message?.text ?? "").trim();
    if (text === "" || text.startsWith("/")) return next();
    if (awaiting === "name") {
      c.session.booking = { ...c.session.booking, clientName: text };
      c.session.awaitingInput = "phone";
      await ctx.reply(
        `Got it — ${text}.\n\nNow send your phone number so we can confirm ` +
          `the booking. (e.g. 555-123-4567)`,
      );
      return;
    }
    if (awaiting === "phone") {
      c.session.booking = { ...c.session.booking, clientPhone: text };
      c.session.awaitingInput = null;
      // E1T6 — show the confirmation dialog right after the phone step so
      // the user can review + confirm / reschedule / cancel in one tap.
      const booking = c.session.booking ?? {};
      const service = booking.serviceId ? await getServiceById(booking.serviceId) : undefined;
      const barber = booking.barberId ? await getBarberById(booking.barberId) : undefined;
      if (!service || !barber || !booking.date || !booking.time) {
        await ctx.reply(
          "I lost track of the booking. Tap /start to begin again.",
        );
        return;
      }
      const confirmText =
        `✅ Confirm your booking\n\n` +
        `Service: ${service.name} (${service.duration_minutes} min)\n` +
        `Barber: ${barber.name}\n` +
        `Date: ${booking.date}\n` +
        `Time: ${booking.time}\n` +
        `Name: ${booking.clientName ?? "—"}\n` +
        `Phone: ${text}\n\n` +
        `Tap confirm to lock it in, reschedule to pick a new time, or cancel.`;
      await ctx.reply(confirmText, {
        reply_markup: {
          inline_keyboard: [
            [inlineButton("✅ Confirm booking", "confirm:book")],
            [
              inlineButton("🔄 Reschedule", "confirm:reschedule"),
              inlineButton("❌ Cancel", "confirm:cancel"),
            ],
          ],
        },
      });
      return;
    }
    return next();
  });

  bot.command("start", async (ctx) => {
    await ctx.reply(WELCOME_TEXT, { reply_markup: mainMenu });
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT);
  });

  // E1T1 — /book opens the service picker. The catalog is read from the data
  // layer (Redis in production, spec defaults in dev/tests).
  bot.command("book", async (ctx) => {
    await showServicePicker(ctx);
  });

  // Main-menu routing (T02). menu:book reuses the /book picker (E1T1).
  bot.callbackQuery(MENU_BOOK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editToServicePicker(ctx);
  });

  bot.callbackQuery(MENU_SERVICES, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(SERVICES_TEXT, { reply_markup: backButton() });
  });

  bot.callbackQuery(MENU_CONTACT, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(CONTACT_TEXT, { reply_markup: backButton() });
  });

  bot.callbackQuery(MENU_BACK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(WELCOME_TEXT, { reply_markup: mainMenu });
  });

  // E1T1 → E1T2 — service selection. Records the choice in the session and
  // transitions the same message to the barber picker.
  bot.callbackQuery(/^service:/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const id = data.slice(SERVICE_PREFIX.length);
    const service = await getServiceById(id);
    if (!service) {
      await ctx.answerCallbackQuery({ text: "Unknown service — pick one from the list." });
      return;
    }
    const c = ctx as unknown as BotContext<Session>;
    c.session.booking = { ...c.session.booking, serviceId: service.id };
    await ctx.answerCallbackQuery({ text: `${service.name} selected` });
    await editToBarberPicker(ctx);
  });

  // E1T2 → E1T3 — barber selection. Records the choice and transitions to
  // the date picker (E1T3). The session carries the previous service choice
  // forward, so the "back" button on the date picker can return to the
  // barber step with the service still in state.
  bot.callbackQuery(/^barber:/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const id = data.slice(BARBER_PREFIX.length);
    const barber = await getBarberById(id);
    if (!barber) {
      await ctx.answerCallbackQuery({ text: "Unknown barber — pick one from the list." });
      return;
    }
    const c = ctx as unknown as BotContext<Session>;
    c.session.booking = { ...c.session.booking, barberId: barber.id };
    await ctx.answerCallbackQuery({ text: `${barber.name} selected` });
    const today = new Date();
    const monthKeyValue = monthKey(today);
    c.session.booking = { ...c.session.booking, datePickerMonth: monthKeyValue };
    await editToDatePickerForMonth(ctx, today.getFullYear(), today.getMonth(), today);
  });

  // E1T2 — "Back to services" from the barber picker.
  bot.callbackQuery(BOOKING_BACK_SERVICES, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editToServicePicker(ctx);
  });

  // E1T3 — "Back to barbers" from the date picker. Preserves the in-flight
  // booking state so the user doesn't lose their service / barber choices.
  bot.callbackQuery(BOOKING_BACK_BARBER, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editToBarberPicker(ctx);
  });

  // E1T3 — month navigation. The callback data encodes the target month so
  // the handler is stateless w.r.t. "which month is the user looking at".
  bot.callbackQuery(/^date_nav:/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const key = data.slice(DATE_NAV_PREFIX.length);
    const parsed = parseMonthKey(key);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: "Invalid month — try again." });
      return;
    }
    const c = ctx as unknown as BotContext<Session>;
    c.session.booking = { ...c.session.booking, datePickerMonth: key };
    await ctx.answerCallbackQuery();
    await editToDatePickerForMonth(ctx, parsed.year, parsed.month, new Date());
  });

  // E1T3 — date selection. Records the chosen date in the session and
  // transitions the message to the time picker (E1T4). The session
  // preserves the service / barber so "back to calendar" restores the
  // date picker with the prior selections intact.
  bot.callbackQuery(/^date:/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const iso = data.slice(DATE_PREFIX.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      await ctx.answerCallbackQuery({ text: "Invalid date — try again." });
      return;
    }
    const c = ctx as unknown as BotContext<Session>;
    const booking = { ...c.session.booking, date: iso };
    c.session.booking = booking;
    await ctx.answerCallbackQuery({ text: `${iso} selected` });
    // Resolve the service to size the slots correctly (service duration
    // drives which slots fit before the 19:00 close).
    const service = booking.serviceId ? await getServiceById(booking.serviceId) : undefined;
    if (!service) {
      await ctx.editMessageText(
        "I lost track of the service you picked. Tap /start to start over.",
      );
      return;
    }
    const slots = getAvailableSlots(service);
    await ctx.editMessageText(timePickerText(service), {
      reply_markup: timePickerKeyboard(slots),
    });
  });

  // E1T4 → E1T5 — time selection. Records the chosen time and transitions
  // the message to the name prompt. E1T5 owns the name + phone collection
  // and the confirmation step (E1T6) will follow.
  bot.callbackQuery(/^time:/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const label = data.slice(TIME_PREFIX.length);
    if (!/^\d{2}:\d{2}$/.test(label)) {
      await ctx.answerCallbackQuery({ text: "Invalid time — try again." });
      return;
    }
    const c = ctx as unknown as BotContext<Session>;
    c.session.booking = { ...c.session.booking, time: label };
    c.session.awaitingInput = "name";
    const tgFirst = ctx.from?.first_name?.trim();
    const suggestRow: import("./toolkit/ui/keyboard.js").InlineButton[] = [];
    if (tgFirst) {
      suggestRow.push(
        inlineButton(`Use my Telegram name (${tgFirst})`, "name:use_telegram"),
      );
    }
    const keyboard = { inline_keyboard: [...(suggestRow.length ? [suggestRow] : []), [inlineButton("🔙 Back to time slots", BOOKING_BACK_TIME)]] };
    await ctx.answerCallbackQuery({ text: `${label} selected` });
    await ctx.editMessageText(
      `🕐 ${label} — now I just need a couple of details.\n\n` +
        `What's your name? ${
          tgFirst ? `(Tap below to use "${tgFirst}", or type a different name.)` : "Type your name."
        }`,
      { reply_markup: keyboard },
    );
  });

  // E1T5 — "Use my Telegram name" button. Fills the name from
  // ctx.from.first_name and advances the flow to the phone prompt.
  bot.callbackQuery("name:use_telegram", async (ctx) => {
    const tgFirst = ctx.from?.first_name?.trim();
    if (!tgFirst) {
      await ctx.answerCallbackQuery({ text: "No Telegram name on file — type your name." });
      return;
    }
    const c = ctx as unknown as BotContext<Session>;
    c.session.booking = { ...c.session.booking, clientName: tgFirst };
    c.session.awaitingInput = "phone";
    await ctx.answerCallbackQuery({ text: `Using ${tgFirst}` });
    await ctx.editMessageText(
      `Got it — ${tgFirst}.\n\nNow send your phone number so we can confirm ` +
        `the booking. (e.g. 555-123-4567)`,
      {
        reply_markup: {
          inline_keyboard: [[inlineButton("🔙 Back to time slots", BOOKING_BACK_TIME)]],
        },
      },
    );
  });

  // E1T5 — "Back to time slots" from the name / phone prompt. The canonical
  // handler is registered alongside the other booking-flow callbacks below.
  // (Duplicate removed — see the handler near the end of buildBot.)

  // E1T6 — confirm booking. The booking is held in the session; E3T1+ will
  // persist it to Postgres. For E1T6 we acknowledge with a confirmation
  // summary and clear the in-flight booking so the next /start is clean.
  bot.callbackQuery("confirm:book", async (ctx) => {
    const c = ctx as unknown as BotContext<Session>;
    const booking = c.session.booking ?? {};
    c.session.booking = undefined;
    c.session.awaitingInput = null;
    await ctx.answerCallbackQuery({ text: "Booking confirmed" });
    const service = booking.serviceId ? await getServiceById(booking.serviceId) : undefined;
    const barber = booking.barberId ? await getBarberById(booking.barberId) : undefined;
    await ctx.editMessageText(
      `🎉 Booked!\n\n` +
        `${service?.name ?? "Service"} with ${barber?.name ?? "your barber"}\n` +
        `${booking.date ?? ""} at ${booking.time ?? ""}\n` +
        `Name: ${booking.clientName ?? "—"}\n` +
        `Phone: ${booking.clientPhone ?? "—"}\n\n` +
        `We'll send a 2-hour reminder before your appointment. ` +
        `Tap /start any time to book again.`,
      {
        reply_markup: {
          inline_keyboard: [[inlineButton("🏠 Main menu", MENU_BACK)]],
        },
      },
    );
  });

  // E1T6 — reschedule. Clears the in-flight booking and drops the user
  // back into the service picker to start over.
  bot.callbackQuery("confirm:reschedule", async (ctx) => {
    const c = ctx as unknown as BotContext<Session>;
    c.session.booking = undefined;
    c.session.awaitingInput = null;
    await ctx.answerCallbackQuery({ text: "Starting over" });
    const services = await getServices();
    await ctx.editMessageText(servicePickerText(), {
      reply_markup: servicePickerKeyboard(services),
    });
  });

  // E1T6 — cancel. Clears the session and acknowledges.
  bot.callbackQuery("confirm:cancel", async (ctx) => {
    const c = ctx as unknown as BotContext<Session>;
    c.session.booking = undefined;
    c.session.awaitingInput = null;
    await ctx.answerCallbackQuery({ text: "Booking cancelled" });
    await ctx.editMessageText(
      "Booking cancelled. No problem — tap /start any time to book again.",
      {
        reply_markup: {
          inline_keyboard: [[inlineButton("🏠 Main menu", MENU_BACK)]],
        },
      },
    );
  });

  // E1T4 — "Back to calendar" from the time picker. Restores the date
  // picker for the month we were last browsing, with the prior service /
  // barber selections preserved in the session.
  bot.callbackQuery(BOOKING_BACK_DATE, async (ctx) => {
    await ctx.answerCallbackQuery();
    const c = ctx as unknown as BotContext<Session>;
    const today = new Date();
    const monthKeyValue = c.session.booking?.datePickerMonth ?? monthKey(today);
    const parsed = parseMonthKey(monthKeyValue) ?? {
      year: today.getFullYear(),
      month: today.getMonth(),
    };
    await editToDatePickerForMonth(ctx, parsed.year, parsed.month, today);
  });

  // E1T5 — "Back to time slots" from the name / phone prompt. Clears
  // awaitingInput and restores the time picker for the currently selected
  // service.
  bot.callbackQuery(BOOKING_BACK_TIME, async (ctx) => {
    const c = ctx as unknown as BotContext<Session>;
    c.session.awaitingInput = null;
    const booking = c.session.booking ?? {};
    const service = booking.serviceId ? await getServiceById(booking.serviceId) : undefined;
    if (!service) {
      await ctx.answerCallbackQuery({ text: "Restart booking from /start" });
      await ctx.editMessageText("I lost track of the booking. Tap /start to begin again.");
      return;
    }
    await ctx.answerCallbackQuery();
    const slots = getAvailableSlots(service);
    await ctx.editMessageText(timePickerText(service), {
      reply_markup: timePickerKeyboard(slots),
    });
  });

  return bot;
}

// Re-export for tests that want to introspect the data layer directly.
export {
  formatPrice,
  getAvailableSlots,
  getBarberById,
  getBarbers,
  getServiceById,
  getServices,
} from "./data.js";
export {
  availableDaysInMonth,
  isoDate,
  monthKey,
  parseMonthKey,
  weekday,
} from "./dates.js";
