import { createBot } from "./toolkit/index.js";
import { inlineButton, inlineKeyboard } from "./toolkit/ui/keyboard.js";

// The per-chat session shape (ephemeral conversation state only). Extend as the
// bot grows. Durable domain data must NOT live here — use the toolkit's
// persistent storage (see AGENTS.md).
export interface Session {
  // example: step?: "awaiting_amount";
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

  // Main-menu callback_data keys. /start surfaces three quick options for the
  // client. T02 wires the actual menu flows (booking, services list, contact)
  // — this PR only ships the project's entry point.
  const MENU_BOOK = "menu:book";
  const MENU_SERVICES = "menu:services";
  const MENU_CONTACT = "menu:contact";

  const mainMenu = inlineKeyboard([
    [inlineButton("📅 Book appointment", MENU_BOOK)],
    [inlineButton("💇 View services", MENU_SERVICES)],
    [inlineButton("📞 Contact shop", MENU_CONTACT)],
  ]);

  bot.command("start", async (ctx) => {
    await ctx.reply(
      "Welcome to Mustafa's Cuts 💈\n\n" +
        "Brooklyn's finest haircuts, beard trims, and shaves.\n" +
        "What would you like to do?",
      { reply_markup: mainMenu },
    );
  });

  return bot;
}
