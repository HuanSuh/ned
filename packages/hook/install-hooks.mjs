#!/usr/bin/env node
// Registers ned-hook.sh in ~/.claude/settings.json for the events Ned cares about.
// Idempotent: existing hooks (e.g. Orca's) are left untouched; a Ned entry is added once per event.
// Usage: node install-hooks.mjs [--uninstall]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "SubagentStart", "SubagentStop", "SessionEnd"];
const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, "ned-hook.sh");
const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
const uninstall = process.argv.includes("--uninstall");

const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
settings.hooks ??= {};

const isNed = (h) => typeof h?.command === "string" && h.command.includes("ned-hook.sh");

let changed = 0;
for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] ??= []);
  // Remove previous Ned groups (path may have moved).
  const before = groups.length;
  settings.hooks[ev] = groups.filter((g) => !(g.hooks ?? []).some(isNed));
  if (settings.hooks[ev].length !== before) changed++;
  if (!uninstall) {
    settings.hooks[ev].push({ hooks: [{ type: "command", command: `/bin/sh "${hookPath}"`, timeout: 5 }] });
    changed++;
  }
  if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
}

fs.chmodSync(hookPath, 0o755);
fs.copyFileSync(settingsPath, settingsPath + ".ned-backup");
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`${uninstall ? "Removed" : "Installed"} Ned hooks (${EVENTS.join(", ")}). Backup: ${settingsPath}.ned-backup`);
