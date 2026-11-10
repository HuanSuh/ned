/**
 * packages/hook/install-hooks.mjs against a temp settings file (--settings) — the real ~/.claude/settings.json is
 * never touched. Plugin installs run `--uninstall` to migrate away from the old absolute-path hooks, so that path
 * must remove only Ned entries and must not create or rewrite a file when there is nothing to remove.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../hook/install-hooks.mjs");
const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ned-hooks-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};
const OLD = { hooks: [{ type: "command", command: '/bin/sh "/Users/x/ned/packages/hook/ned-hook.sh"', timeout: 5 }] };
const ORCA = { hooks: [{ type: "command", command: "/usr/local/bin/orca-hook" }] };

describe("install-hooks.mjs --settings", () => {
  it("--uninstall removes only Ned entries and keeps other hooks and keys", () => {
    const f = path.join(tmp(), "settings.json");
    fs.writeFileSync(f, JSON.stringify({ model: "opus", hooks: { Stop: [ORCA, OLD], SessionStart: [OLD], PreToolUse: [ORCA] } }));
    const r = run("--uninstall", "--settings", f);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Removed 2 Ned hook entries/);
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(s).toEqual({ model: "opus", hooks: { Stop: [ORCA], PreToolUse: [ORCA] } });
    expect(fs.existsSync(f + ".ned-backup")).toBe(true);
  });

  it("--uninstall with no Ned entries leaves the file byte-identical and writes no backup", () => {
    const f = path.join(tmp(), "settings.json");
    const body = JSON.stringify({ hooks: { Stop: [ORCA] } });
    fs.writeFileSync(f, body);
    const r = run("--uninstall", "--settings", f);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/No Ned hooks to remove/);
    expect(fs.readFileSync(f, "utf8")).toBe(body);
    expect(fs.existsSync(f + ".ned-backup")).toBe(false);
  });

  it("--uninstall on a missing file creates nothing", () => {
    const f = path.join(tmp(), "nope", "settings.json");
    expect(run("--uninstall", "--settings", f).code).toBe(0);
    expect(fs.existsSync(f)).toBe(false);
  });

  it("install (direct, non-plugin) is idempotent: one Ned entry per event, pointing at this checkout", () => {
    const f = path.join(tmp(), "settings.json");
    fs.writeFileSync(f, JSON.stringify({ hooks: { Stop: [ORCA, OLD] } }));
    expect(run("--settings", f).code).toBe(0);
    expect(run("--settings", f).code).toBe(0);
    const s = JSON.parse(fs.readFileSync(f, "utf8"));
    expect(Object.keys(s.hooks)).toHaveLength(8);
    expect(s.hooks.Stop[0]).toEqual(ORCA);
    for (const groups of Object.values(s.hooks) as { hooks: { command: string }[] }[][]) {
      const ned = groups.filter((g) => g.hooks.some((h) => h.command.includes("ned-hook.sh")));
      expect(ned).toHaveLength(1);
      expect(ned[0].hooks[0].command).toBe(`/bin/sh "${path.resolve(here, "../../hook/ned-hook.sh")}"`);
    }
  });
});
