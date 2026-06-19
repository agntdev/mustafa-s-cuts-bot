import { buildBot } from "./bot.js";
import { getPool } from "./db.js";
import { migrate } from "./migrate.js";
import { seed } from "./seed.js";

// Runtime entry (dist/index.js). BOT_TOKEN is injected at runtime as a secret.
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("BOT_TOKEN is required");
  process.exit(1);
}

// Run any pending migrations before the bot accepts traffic, then seed the
// default services + barbers when the tables are empty. Both steps are
// no-ops when DATABASE_URL is not set (dev / test) so the bot stays
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
    const seeded = await seed(pool);
    if (seeded.servicesInserted > 0 || seeded.barbersInserted > 0) {
      console.log(
        `[mustafa-cuts] seeded ${seeded.servicesInserted} services, ${seeded.barbersInserted} barbers`,
      );
    } else {
      console.log("[mustafa-cuts] data is already seeded");
    }
  } catch (err) {
    console.error("[mustafa-cuts] startup failed:", err);
    process.exit(1);
  }
}

const bot = buildBot(token);
bot.start();
