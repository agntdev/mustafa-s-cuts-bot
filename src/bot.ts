import { createBot } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";

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

const BOOK_TEXT =
  "📅 Book an appointment\n\n" +
  "Our services:\n" +
  "• Haircut — 30 min\n" +
  "• Beard trim — 15 min\n" +
  "• Haircut + Beard — 45 min\n" +
  "• Kids cut — 30 min\n" +
  "• Hot towel shave — 40 min\n\n" +
  "DM us with the service you'd like, your preferred barber " +
  "(Mustafa, Alex, or no preference), and a date/time. " +
  "We'll confirm in a reply.";

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
// only intercept "/foo" and let /start, /help through to their handlers.
const KNOWN_COMMANDS = new Set(["start", "help"]);

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
      // Pull the command token: "/foo@Bot args" → "foo". Case-preserved so
      // "/HELP" still routes to the /help handler (grammY matches case-
      // sensitively).
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

  // Main-menu routing (T02). Each handler clears the loading spinner, then
  // edits the welcome message in place to that feature's view. A "back" button
  // restores the welcome. The actual booking guided dialog (E1T1+) builds on
  // top of this routing by replacing BOOK_TEXT with a real service picker.
  bot.callbackQuery(MENU_BOOK, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(BOOK_TEXT, { reply_markup: backButton() });
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

  return bot;
}
