/**
 * scripts/status.sh (what /ned:status runs) against throwaway state: a port nothing listens on, a temp NED_HOME,
 * a defaults domain that doesn't exist and a temp Claude settings file. Read-only by design — the test also checks
 * that it wrote nothing. install.sh/uninstall.sh build and copy an app, so they are smoke-tested by hand
 * (docs/RELEASE.md); here only their syntax is checked.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("scripts", () => {
  it.each(["install.sh", "uninstall.sh", "status.sh"])("%s parses (bash -n)", (s) => {
    const r = spawnSync("bash", ["-n", path.join(ROOT, "scripts", s)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("status.sh reports daemon down, unset nedRepoPath, log tail and leftover Ned hooks — and writes nothing", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ned-status-"));
    dirs.push(d);
    const home = path.join(d, "home");
    fs.mkdirSync(path.join(home, "logs"), { recursive: true });
    fs.writeFileSync(path.join(home, "logs", "app-daemon.log"), Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const settings = path.join(d, "settings.json");
    const body = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '/bin/sh "/x/packages/hook/ned-hook.sh"' }] }] } });
    fs.writeFileSync(settings, body);
    const r = spawnSync("bash", [path.join(ROOT, "scripts", "status.sh"), ROOT], {
      encoding: "utf8",
      env: { ...process.env, NED_HOME: home, NED_PORT: "1", NED_DEFAULTS_DOMAIN: `com.ned.menubar.test-${process.pid}`, NED_CLAUDE_SETTINGS: settings },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("down — no answer");
    expect(r.stdout).toMatch(/plugin\s+: \d+\.\d+\.\d+/);
    expect(r.stdout).toContain("nedRepoPath: (unset");
    expect(r.stdout).toContain("line 15");
    expect(r.stdout).not.toContain("line 5\n");
    expect(r.stdout).toContain("1 Ned hook entry left");
    expect(fs.readFileSync(settings, "utf8")).toBe(body);
    expect(fs.readdirSync(d).sort()).toEqual(["home", "settings.json"]);
  });
});
