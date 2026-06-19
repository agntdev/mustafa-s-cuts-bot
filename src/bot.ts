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

  const mainMenu = inlineKeyboard([
    [inlineButton("📅 Book appointment", MENU_BOOK)],
    [inlineButton("💇 View services", MENU_SERVICES)],
    [inlineButton("📞 Contact shop", MENU_CONTACT)],
  ]);

  const backButton = (): ReturnType<typeof inlineKeyboard> =>
    inlineKeyboard([[inlineButton("🔙 Main menu", MENU_BACK)]]);

  bot.command("start", async (ctx) => {
    await ctx.reply(WELCOME_TEXT, { reply_markup: mainMenu });
  });

  // Main-menu routing. Each handler clears the loading spinner (answerCallbackQuery),
  // then edits the welcome message in place to that feature's view. A "back" button
  // restores the welcome. The actual booking guided dialog (E1T1+) builds on top of
  // this routing by replacing BOOK_TEXT with a real service picker.
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
