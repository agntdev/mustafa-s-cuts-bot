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
import {
  createBlock,
  deleteBlock,
  isOwner,
  listActiveBlocks,
} from "./blocks.js";

// Per-chat session shape. The `booking` field carries the in-progress
// selection through the E1T1→E1T6 flow (service → barber → date → time →
// client info → confirm). `awaitingInput` drives the free-text handler
// (E1T5) to know which field to fill next.
export interface Session {
  booking?: {
    serviceId?: string;
    barberId?: string;
    date?: string;
    time?: string;
    clientName?: string;
    clientPhone?: string;
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

// Commands the bot recognises today. Used by the unknown-command guard.
const KNOWN_COMMANDS = new Set(["start", "help", "book", "services", "block", "blocks"]);

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

function servicePickerText(): string {
  return "📅 Book an appointment\n\nChoose a service to see the time slots:";
}

function barberPickerKeyboard(barbers: ReadonlyArray<Barber>) {
  return inlineKeyboard([
    ...barbers.map((b) => [inlineButton(b.name, `${BARBER_PREFIX}${b.id}`)]),
    [inlineButton("🔙 Back to services", BOOKING_BACK_SERVICES)],
  ]);
}

function barberPickerText(): string {
  return "✂️ Choose a barber";
}

const MAX_LOOKAHEAD_DAYS = 30;

function isMonthInLookahead(monthKeyValue: string, today: Date): boolean {
  const parsed = parseMonthKey(monthKeyValue);
  if (!parsed) return false;
  const target = new Date(parsed.year, parsed.month, 1);
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() + MAX_LOOKAHEAD_DAYS);
  return target <= cutoff;
}

function datePickerKeyboard(
  year: number,
  month: number,
  today: Date,
): ReturnType<typeof inlineKeyboard> {
  const days = availableDaysInMonth(year, month, today);
  const rows: import("./toolkit/ui/keyboard.js").InlineButton[][] = days.map((d) => [
    inlineButton(`${d.getDate()}`, `${DATE_PREFIX}${isoDate(d)}`),
  ]);
  const navRow: import("./toolkit/ui/keyboard.js").InlineButton[] = [];
  const nextMonthDate = new Date(year, month + 1, 1);
  if (isMonthInLookahead(monthKey(nextMonthDate), today)) {
    navRow.push(
      inlineButton("Next month →", `${DATE_NAV_PREFIX}${monthKey(nextMonthDate)}`),
    );
  }
  if (navRow.length > 0) rows.push(navRow);
  rows.push([inlineButton("🔙 Back to barbers", BOOKING_BACK_BARBER)]);
  return { inline_keyboard: rows };
}

function datePickerText(year: number, month: number): string {
  const sample = new Date(year, month, 1);
  return `📅 Pick a date — ${monthName(sample)} ${year}\n\nClosed Sun & Mon.`;
}

function timePickerKeyboard(slots: ReadonlyArray<TimeSlot>): ReturnType<typeof inlineKeyboard> {
  const rows: import("./toolkit/ui/keyboard.js").InlineButton[][] = [];
  for (let i = 0; i < slots.length; i += 2) {
    const row = slots.slice(i, i + 2).map((s) => inlineButton(s.label, `${TIME_PREFIX}${s.label}`));
    rows.push(row);
  }
  rows.push([inlineButton("🔙 Back to calendar", BOOKING_BACK_DATE)]);
  return { inline_keyboard: rows };
}

function timePickerText(service: Service): string {
  return `🕐 Pick a time for ${service.name} (${service.duration_minutes} min)\n\n15-min slots between 10:00 and 19:00.`;
}

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

async function showServicePicker(ctx: { reply: (text: string, opts?: object) => Promise<unknown> }) {
  const services = await getServices();
  await ctx.reply(servicePickerText(), { reply_markup: servicePickerKeyboard(services) });
}

async function editToServicePicker(ctx: {
  editMessageText: (text: string, opts?: object) => Promise<unknown>;
}) {
  const services = await getServices();
  await ctx.editMessageText(servicePickerText(), {
    reply_markup: servicePickerKeyboard(services),
  });
}

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
 * (src/harness-entry.ts) so both exercise the exact same bot.
 */
export function buildBot(token: string) {
  const bot = createBot<Session>(token, {
    initial: () => ({}),
  });

  // Global error boundary (T03): catches any throw from a downstream handler
  // and replies with a friendly fallback instead of dropping the update.
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
        /* user may have blocked the bot — nothing more we can do */
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

  // Unknown-command guard (T03).
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
  // fills that field and advances. E1T6 shows the confirmation after
  // phone collection.
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
      const booking = c.session.booking ?? {};
      const service = booking.serviceId ? await getServiceById(booking.serviceId) : undefined;
      const barber = booking.barberId ? await getBarberById(booking.barberId) : undefined;
      if (!service || !barber || !booking.date || !booking.time) {
        await ctx.reply("I lost track of the booking. Tap /start to begin again.");
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

  // E1T1 — /book opens the service picker.
  bot.command("book", async (ctx) => {
    await showServicePicker(ctx);
  });

  // E2T3 — owner-only block commands.
  bot.command("block", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("This command is only available to the shop owner.");
      return;
    }
    const keyboard = {
      inline_keyboard: [
        [inlineButton("⏸ Block Mustafa (30 min)", "block:mustafa")],
        [inlineButton("⏸ Block Alex (30 min)", "block:alex")],
        [inlineButton("⏸ Block Both (30 min)", "block:both")],
      ],
    };
    await ctx.reply("Pick who to block for the next 30 minutes:", { reply_markup: keyboard });
  });

  bot.command("blocks", async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.reply("This command is only available to the shop owner.");
      return;
    }
    const blocks = await listActiveBlocks();
    if (blocks.length === 0) {
      await ctx.reply("No active blocks right now. Use /block to add one.");
      return;
    }
    const lines: string[] = ["⏸ Active blocks:", ""];
    const rows: import("./toolkit/ui/keyboard.js").InlineButton[][] = [];
    for (const b of blocks) {
      const start = new Date(b.start_datetime);
      const end = new Date(b.end_datetime);
      lines.push(
        `• ${b.barber_id} — ${start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` +
          ` to ${end.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` +
          (b.reason ? ` (${b.reason})` : ""),
      );
      rows.push([inlineButton(`🗑 Remove ${b.barber_id} block`, `delete_block:${b.id}`)]);
    }
    await ctx.reply(lines.join("\n"), { reply_markup: { inline_keyboard: rows } });
  });

  // Main-menu routing (T02).
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

  // E1T1 → E1T2 — service selection.
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

  // E1T2 → E1T3 — barber selection.
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

  bot.callbackQuery(BOOKING_BACK_SERVICES, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editToServicePicker(ctx);
  });

  bot.callbackQuery(BOOKING_BACK_BARBER, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editToBarberPicker(ctx);
  });

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
    const service = booking.serviceId ? await getServiceById(booking.serviceId) : undefined;
    if (!service) {
      await ctx.editMessageText("I lost track of the service you picked. Tap /start to start over.");
      return;
    }
    const slots = getAvailableSlots(service);
    await ctx.editMessageText(timePickerText(service), {
      reply_markup: timePickerKeyboard(slots),
    });
  });

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
      suggestRow.push(inlineButton(`Use my Telegram name (${tgFirst})`, "name:use_telegram"));
    }
    const keyboard = {
      inline_keyboard: [
        ...(suggestRow.length ? [suggestRow] : []),
        [inlineButton("🔙 Back to time slots", BOOKING_BACK_TIME)],
      ],
    };
    await ctx.answerCallbackQuery({ text: `${label} selected` });
    await ctx.editMessageText(
      `🕐 ${label} — now I just need a couple of details.\n\n` +
        `What's your name? ${
          tgFirst ? `(Tap below to use "${tgFirst}", or type a different name.)` : "Type your name."
        }`,
      { reply_markup: keyboard },
    );
  });

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

  // E1T6 — confirm / reschedule / cancel.
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

  bot.callbackQuery("confirm:cancel", async (ctx) => {
    // E5T2 — confirm before destructive action. Replaces the immediate
    // "Booking cancelled" with a Yes/No confirmation so a mis-tap on the
    // Cancel button doesn't blow away the in-flight booking.
    await ctx.answerCallbackQuery({ text: "Are you sure?" });
    await ctx.editMessageText(
      "Cancel this booking?\n\nYour selections will be cleared and you'll be back at the main menu.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              inlineButton("✅ Yes, cancel", "confirm:cancel:yes"),
              inlineButton("↩️ Keep booking", "confirm:cancel:no"),
            ],
          ],
        },
      },
    );
  });

  // E5T2 — Yes branch of the cancellation confirmation. Clears the
  // session and shows the friendly "tap /start to book again" message.
  bot.callbackQuery("confirm:cancel:yes", async (ctx) => {
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

  // E5T2 — No branch of the cancellation confirmation. Restores the
  // confirmation dialog with confirm / reschedule / cancel buttons so the
  // user can pick again.
  bot.callbackQuery("confirm:cancel:no", async (ctx) => {
    const c = ctx as unknown as BotContext<Session>;
    const booking = c.session.booking ?? {};
    const service = booking.serviceId ? await getServiceById(booking.serviceId) : undefined;
    const barber = booking.barberId ? await getBarberById(booking.barberId) : undefined;
    if (!service || !barber || !booking.date || !booking.time || !booking.clientName || !booking.clientPhone) {
      await ctx.answerCallbackQuery({ text: "Booking state lost — start over with /start" });
      await ctx.editMessageText("I lost track of the booking. Tap /start to begin again.");
      return;
    }
    await ctx.answerCallbackQuery({ text: "Kept your booking" });
    const confirmText =
      `✅ Confirm your booking\n\n` +
      `Service: ${service.name} (${service.duration_minutes} min)\n` +
      `Barber: ${barber.name}\n` +
      `Date: ${booking.date}\n` +
      `Time: ${booking.time}\n` +
      `Name: ${booking.clientName}\n` +
      `Phone: ${booking.clientPhone}\n\n` +
      `Tap confirm to lock it in, reschedule to pick a new time, or cancel.`;
    await ctx.editMessageText(confirmText, {
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
  });

  // E2T3 — create a 30-minute block starting now. Owner-only.
  bot.callbackQuery(/^block:(mustafa|alex|both)$/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: "Owner-only action." });
      return;
    }
    const data = ctx.callbackQuery.data ?? "";
    const barberId = data.slice("block:".length);
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 60_000);
    const ownerId = String(ctx.from!.id);
    try {
      const block = await createBlock(barberId, now, end, ownerId, "30-min break");
      if (!block) {
        await ctx.answerCallbackQuery({ text: "Database not configured" });
        await ctx.reply("Block couldn't be created — the database isn't reachable. Check DATABASE_URL.");
        return;
      }
      await ctx.answerCallbackQuery({ text: `Blocked ${barberId} for 30 min` });
      await ctx.editMessageText(
        `⏸ Blocked ${barberId} for 30 minutes (until ${end.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}).`,
        {
          reply_markup: {
            inline_keyboard: [[inlineButton("🏠 Main menu", MENU_BACK)]],
          },
        },
      );
    } catch (err) {
      console.error("[mustafa-cuts] block create failed:", err);
      await ctx.answerCallbackQuery({ text: "Failed to create block" });
      await ctx.reply("Something went wrong creating the block. Try again or check the server logs.");
    }
  });

  // E2T3 — remove a block. Owner-only. E5T2 wraps the actual delete in a
  // Yes/No confirmation so a mis-tap on the trash button doesn't
  // immediately remove the block.
  bot.callbackQuery(/^delete_block:/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: "Owner-only action." });
      return;
    }
    const data = ctx.callbackQuery.data ?? "";
    const id = data.slice("delete_block:".length);
    await ctx.answerCallbackQuery({ text: "Confirm removal?" });
    await ctx.editMessageText(
      "Remove this block?\n\nThe barber will be open for bookings in that window again.",
      {
        reply_markup: {
          inline_keyboard: [
            [
              inlineButton("✅ Yes, remove", `delete_block:yes:${id}`),
              inlineButton("↩️ Keep", `delete_block:no:${id}`),
            ],
          ],
        },
      },
    );
  });

  // E5T2 — Yes branch of the block-deletion confirmation. Performs the
  // actual delete and refreshes the list.
  bot.callbackQuery(/^delete_block:yes:/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: "Owner-only action." });
      return;
    }
    const data = ctx.callbackQuery.data ?? "";
    const id = data.slice("delete_block:yes:".length);
    try {
      const removed = await deleteBlock(id);
      if (!removed) {
        await ctx.answerCallbackQuery({ text: "Block not found" });
        return;
      }
      const blocks = await listActiveBlocks();
      if (blocks.length === 0) {
        await ctx.answerCallbackQuery({ text: "Block removed" });
        await ctx.editMessageText("⏸ Block removed. No active blocks right now.");
        return;
      }
      const lines = ["⏸ Active blocks:", ""];
      const rows: import("./toolkit/ui/keyboard.js").InlineButton[][] = [];
      for (const b of blocks) {
        const start = new Date(b.start_datetime);
        const end = new Date(b.end_datetime);
        lines.push(
          `• ${b.barber_id} — ${start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` +
            ` to ${end.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` +
            (b.reason ? ` (${b.reason})` : ""),
        );
        rows.push([inlineButton(`🗑 Remove ${b.barber_id} block`, `delete_block:${b.id}`)]);
      }
      await ctx.answerCallbackQuery({ text: "Block removed" });
      await ctx.editMessageText(lines.join("\n"), { reply_markup: { inline_keyboard: rows } });
    } catch (err) {
      console.error("[mustafa-cuts] block delete failed:", err);
      await ctx.answerCallbackQuery({ text: "Failed to remove block" });
    }
  });

  // E5T2 — No branch of the block-deletion confirmation. Restores the
  // blocks list without removing anything.
  bot.callbackQuery(/^delete_block:no:/, async (ctx) => {
    if (!isOwner(ctx.from?.id)) {
      await ctx.answerCallbackQuery({ text: "Owner-only action." });
      return;
    }
    const blocks = await listActiveBlocks();
    if (blocks.length === 0) {
      await ctx.answerCallbackQuery({ text: "Kept the block" });
      await ctx.editMessageText("No active blocks right now. Use /block to add one.");
      return;
    }
    const lines = ["⏸ Active blocks:", ""];
    const rows: import("./toolkit/ui/keyboard.js").InlineButton[][] = [];
    for (const b of blocks) {
      const start = new Date(b.start_datetime);
      const end = new Date(b.end_datetime);
      lines.push(
        `• ${b.barber_id} — ${start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` +
          ` to ${end.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` +
          (b.reason ? ` (${b.reason})` : ""),
      );
      rows.push([inlineButton(`🗑 Remove ${b.barber_id} block`, `delete_block:${b.id}`)]);
    }
    await ctx.answerCallbackQuery({ text: "Kept the block" });
    await ctx.editMessageText(lines.join("\n"), { reply_markup: { inline_keyboard: rows } });
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
export { createBlock, deleteBlock, isOwner, listActiveBlocks } from "./blocks.js";
// Avoid the unused-var warning for shortDayLabel; it's exported for tests.
void shortDayLabel;
