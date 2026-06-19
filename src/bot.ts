import { createBot } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";
import { formatPrice, getServiceById, getServices, type Service } from "./data.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
}

// Main-menu callback_data keys. /start surfaces three quick options for the
// client. T02 wires the routing: each button edits the welcome message in
// place to that feature's view, and a "back" button returns to the main menu.
// The full guided booking flow (service selection → barber → date → time →
// confirm) lives in E1T1+; for now, /book and /services routes guide the user
// to DM the shop, which always works.
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

// Callback prefix for service-selection buttons. E1T2+ routes the chosen
// service id into the barber picker; for now the handler just acknowledges
// the tap and confirms the selection so the user isn't left hanging.
const SERVICE_PREFIX = "service:";

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
  // layer (Redis in production, spec defaults in dev/tests). E1T2+ will route
  // the chosen service into barber / date / time pickers.
  bot.command("book", async (ctx) => {
    await showServicePicker(ctx);
  });

  // Main-menu routing (T02). Each handler clears the loading spinner, then
  // edits the welcome message in place to that feature's view. A "back" button
  // restores the welcome. menu:book now reuses the /book picker (E1T1).
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

  // E1T1 — service selection callback. The next step (barber picker) is wired
  // by E1T2; for now we acknowledge the tap with a friendly confirmation so
  // the loading spinner clears and the user sees their choice was registered.
  bot.callbackQuery(/^service:/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const id = data.slice(SERVICE_PREFIX.length);
    const service = await getServiceById(id);
    if (!service) {
      await ctx.answerCallbackQuery({ text: "Unknown service — pick one from the list." });
      return;
    }
    await ctx.answerCallbackQuery({
      text: `${service.name} selected — booking flow continues next.`,
    });
  });

  return bot;
}

// Re-export for tests that want to introspect the data layer directly.
export { formatPrice, getServiceById, getServices } from "./data.js";
