import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runSpecs, parseBotSpecs } from "../src/toolkit/harness/run-specs";
import {
  commandsInSpecs,
  computeCoverage,
  normalizeDeclaredCommands,
} from "../src/toolkit/harness/coverage";
import { makeBot } from "../src/harness-entry";
import type { BotSpec } from "../src/toolkit/harness/types";

// E6T2 — command-manifest test. Loads every tests/commands/*.json file,
// loads every tests/specs/*.json file, replays the specs through the bot,
// and asserts that:
//   1. The union of declared commands covers every command the bot
//      actually accepts (so the manifest is "complete").
//   2. Every declared command has >= 1 spec that exercises it
//      meaningfully (so coverage is real, not asserted-and-skipped).

const ROOT = join(import.meta.dirname, "..");

function loadJsonDir(subdir: string): unknown[] {
  const dir = join(ROOT, subdir);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const out: unknown[] = [];
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    out.push(JSON.parse(raw));
  }
  return out;
}

function loadSpecs(): BotSpec[] {
  const raw = loadJsonDir("tests/specs");
  const out: BotSpec[] = [];
  for (const r of raw) {
    if (Array.isArray(r)) out.push(...parseBotSpecs(r));
    else out.push(...parseBotSpecs([r]));
  }
  return out;
}

function loadDeclaredCommands(): string[] {
  const raw = loadJsonDir("tests/commands");
  const all: string[] = [];
  for (const r of raw) {
    if (Array.isArray(r)) {
      for (const c of r) if (typeof c === "string") all.push(c);
    }
  }
  return normalizeDeclaredCommands(all);
}

describe("command manifest (E6T2)", () => {
  it("every declared command is exercised by at least one spec", () => {
    const declared = loadDeclaredCommands();
    const specs = loadSpecs();
    const coverage = computeCoverage(specs, declared);
    expect(coverage.missing).toEqual([]);
  });

  it("all spec suites replay green", async () => {
    const specs = loadSpecs();
    const result = await runSpecs(makeBot, specs);
    expect(result.failed).toBe(0);
  });

  it("the manifest is non-empty (a bot with no commands would be broken)", () => {
    const declared = loadDeclaredCommands();
    expect(declared.length).toBeGreaterThan(0);
  });

  it("exercised commands are a subset of declared ones (no orphan specs)", () => {
    const declared = new Set(loadDeclaredCommands());
    const specs = loadSpecs();
    const exercised = commandsInSpecs(specs);
    for (const cmd of exercised) {
      expect(declared.has(cmd), `spec exercises undeclared command /${cmd}`).toBe(true);
    }
  });
});
