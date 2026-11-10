#!/usr/bin/env node
// Registers ned-hook.sh in ~/.claude/settings.json for the events Ned cares about.
// Idempotent: existing hooks (e.g. Orca's) are left untouched; a Ned entry is added once per event.
//
// ⚠ Installed Ned as a Claude Code plugin (/plugin install ned@ned)? Then don't use the install path:
//   the plugin's hooks/hooks.json already registers the same hook, and an entry here would log every
//   event twice. scripts/install.sh in plugin mode (NED_PLUGIN_MODE=1) runs `--uninstall` to remove it.
//
// Usage: node install-hooks.mjs [--uninstall] [--settings <path>]
//   --uninstall        remove Ned entries only (anything whose command mentions ned-hook.sh); no file is
//                      created or rewritten when there is nothing to remove
//   --settings <path>  settings file to edit (default ~/.claude/settings.json) — tests pass a temp file

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "Notification", "SubagentStart", "SubagentStop", "SessionEnd"];
const here = path.dirname(fileURLToPath(import.meta.url));
const hookPath = path.join(here, "ned-hook.sh");
const argv = process.argv.slice(2);
const uninstall = argv.includes("--uninstall");
const si = argv.indexOf("--settings");
if (si >= 0 && !argv[si + 1]) {
  console.error("install-hooks: --settings needs a path");
  process.exit(2);
}
const settingsPath = si >= 0 ? path.resolve(argv[si + 1]) : path.join(os.homedir(), ".claude", "settings.json");

const exists = fs.existsSync(settingsPath);
if (uninstall && !exists) {
  console.log(`No Ned hooks to remove (${settingsPath} does not exist).`);
  process.exit(0);
}
const settings = exists ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
const hadHooks = settings.hooks !== undefined;
settings.hooks ??= {};

const isNed = (h) => typeof h?.command === "string" && h.command.includes("ned-hook.sh");

let removed = 0;
for (const ev of EVENTS) {
  const groups = settings.hooks[ev] ?? [];
  // Remove previous Ned hooks (path may have moved) one by one — another tool's hook that shares the group
  // stays; a group left empty goes.
  const kept = [];
  for (const g of groups) {
    const hs = Array.isArray(g?.hooks) ? g.hooks : null;
    const n = hs ? hs.filter(isNed).length : 0;
    if (!n) {
      kept.push(g);
      continue;
    }
    removed += n;
    if (hs.length > n) kept.push({ ...g, hooks: hs.filter((h) => !isNed(h)) });
  }
  if (!uninstall) kept.push({ hooks: [{ type: "command", command: `/bin/sh "${hookPath}"`, timeout: 5 }] });
  if (kept.length) settings.hooks[ev] = kept;
  else delete settings.hooks[ev];
}
if (!hadHooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

if (uninstall && removed === 0) {
  console.log(`No Ned hooks to remove in ${settingsPath}.`);
  process.exit(0);
}

fs.chmodSync(hookPath, 0o755);
if (exists) fs.copyFileSync(settingsPath, settingsPath + ".ned-backup");
else fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
const backup = exists ? ` Backup: ${settingsPath}.ned-backup` : "";
console.log(
  uninstall
    ? `Removed ${removed} Ned hook entr${removed === 1 ? "y" : "ies"} from ${settingsPath}.${backup}`
    : `Installed Ned hooks (${EVENTS.join(", ")}) in ${settingsPath}.${backup}`,
);
