import { buildBot } from "./bot.js";
import { getPool } from "./db.js";
import { migrate } from "./migrate.js";

// Runtime entry (dist/index.js). BOT_TOKEN is injected at runtime as a secret.
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

// Run any pending migrations before the bot accepts traffic. The runner is
// a no-op when DATABASE_URL is not set (dev / test) so the bot stays
// bootable in environments without Postgres.
const pool = getPool();
if (pool) {
  try {
    const applied = await migrate(pool);
    if (applied.length > 0) {
      console.log(`[mustafa-cuts] applied migrations: ${applied.join(", ")}`);
    } else {
      console.log("[mustafa-cuts] schema is up to date");
    }
  } catch (err) {
    console.error("[mustafa-cuts] migration failed:", err);
    process.exit(1);
  }
}

const bot = buildBot(token);
bot.start();
