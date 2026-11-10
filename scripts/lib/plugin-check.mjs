#!/usr/bin/env node
// Is <src> the plugin version Claude Code has installed right now? (read-only)
//
// A running Claude Code session keeps the plugin version it loaded, so right after `/plugin update ned`,
// `/ned:install` in the same session still expands ${CLAUDE_PLUGIN_ROOT} to the *previous* cache directory
// (docs: plugins/loading.md "Versions and updates", "Cleanup of previous versions"). Installing from there
// would put the old code back into the runtime. Two signals:
//   - <src>/.orphaned_at  — Claude Code marks a replaced version directory with it
//   - installed_plugins.json — the installPath recorded for ned@ned differs from <src>
// Only a cache-loaded plugin (<src> under <pluginsDir>/cache/) is compared; a plugin loaded in place
// (local-path marketplace, --plugin-dir, a dev checkout) is reported as "in-place".
//
// Usage: node plugin-check.mjs <pluginsDir> <src> [pluginId=ned@ned]
// Prints one line "<status> <detail>"; exit 0 = ok | in-place | unknown, 3 = stale, 4 = orphaned.
import fs from "node:fs";
import path from "node:path";

const [pluginsDir, src, id = "ned@ned"] = process.argv.slice(2);
if (!pluginsDir || !src) {
  console.error("usage: plugin-check.mjs <pluginsDir> <src> [pluginId]");
  process.exit(2);
}
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const SRC = real(src);

if (fs.existsSync(path.join(SRC, ".orphaned_at"))) {
  console.log(`orphaned ${SRC} is a replaced plugin version (.orphaned_at)`);
  process.exit(4);
}
const cache = real(path.join(pluginsDir, "cache")) + path.sep;
if (!(SRC + path.sep).startsWith(cache)) {
  console.log(`in-place ${SRC} is not in the plugin cache — not compared`);
  process.exit(0);
}
let entries = [];
try {
  const j = JSON.parse(fs.readFileSync(path.join(pluginsDir, "installed_plugins.json"), "utf8"));
  const v = (j.plugins ?? j)[id];
  entries = v == null ? [] : Array.isArray(v) ? v : [v];
} catch {
  console.log(`unknown cannot read ${path.join(pluginsDir, "installed_plugins.json")}`);
  process.exit(0);
}
const paths = entries.map((e) => e?.installPath).filter((p) => typeof p === "string");
if (!paths.length) {
  console.log(`unknown no ${id} entry in installed_plugins.json`);
  process.exit(0);
}
if (paths.some((p) => real(p) === SRC)) {
  console.log(`ok ${SRC}`);
  process.exit(0);
}
const vers = entries.map((e) => e?.version).filter(Boolean).join(", ");
console.log(`stale loaded ${SRC}, installed ${paths.map(real).join(", ")}${vers ? ` (version ${vers})` : ""}`);
process.exit(3);
