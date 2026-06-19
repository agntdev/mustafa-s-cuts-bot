import { createBot, type BotContext } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";
import {
  formatPrice,
  getBarberById,
  getBarbers,
  getServiceById,
  getServices,
  type Barber,
  type Service,
} from "./data.js";

// Per-chat session shape. The `booking` field carries the in-progress
// selection through the E1T1→E1T6 flow (service → barber → date → time →
// client info → confirm). It's deliberately opt-in per field so each step
// can read what the previous step wrote and ignore the rest.
export interface Session {
  booking?: {
    serviceId?: string;
    barberId?: string;
    date?: string;
    time?: string;
    clientName?: string;
    clientPhone?: string;
  };
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

// Callback prefixes for the booking flow. E1T1 routes service:<id>; E1T2 adds
// barber:<id> and booking:back_services.
const SERVICE_PREFIX = "service:";
const BARBER_PREFIX = "barber:";
const BOOKING_BACK_SERVICES = "booking:back_services";

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
  // slash) falls through and is ignored — the booking flow (E1T1+) handles it.
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

  // E1T1 — service selection. Records the choice in the session and
  // transitions the same message to the barber picker (E1T2). The
  // session-keyed transition means the date / time pickers (E1T3+)
  // can read the prior selections without re-asking the user.
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

  // E1T2 — barber selection. Records the choice; the next step (date picker,
  // E1T3) will read it. E1T3 ships its own handler for the "next" transition.
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
    await ctx.answerCallbackQuery({
      text: `${barber.name} selected — date picker is up next.`,
    });
  });

  // E1T2 — "Back to services" from the barber picker. Restarts the booking
  // flow at the service step while preserving the session so the previous
  // selection isn't lost if the user goes forward again.
  bot.callbackQuery(BOOKING_BACK_SERVICES, async (ctx) => {
    await ctx.answerCallbackQuery();
    await editToServicePicker(ctx);
  });

  return bot;
}

// Re-export for tests that want to introspect the data layer directly.
export {
  formatPrice,
  getBarberById,
  getBarbers,
  getServiceById,
  getServices,
} from "./data.js";
