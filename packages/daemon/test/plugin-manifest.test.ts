/**
 * Claude Code plugin packaging (.claude-plugin/plugin.json + marketplace.json at the repo root, hooks/hooks.json,
 * commands/*.md). `claude plugin validate .` is the authoritative check (docs/RELEASE.md runs it before a release);
 * this test keeps the shape from drifting in CI where the claude CLI isn't installed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "../../..");
const readJson = (p: string) => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
const SEMVER = /^\d+\.\d+\.\d+$/;

describe("plugin manifests", () => {
  const plugin = readJson(".claude-plugin/plugin.json");
  const market = readJson(".claude-plugin/marketplace.json");

  it("plugin.json has name ned, a semver version and metadata", () => {
    expect(plugin.name).toBe("ned");
    expect(plugin.version).toMatch(SEMVER);
    expect(typeof plugin.description).toBe("string");
    expect(plugin.author?.name).toBeTruthy();
    expect(() => new URL(plugin.homepage)).not.toThrow();
  });

  it("marketplace.json lists this repo's root as the one plugin, with no version of its own (plugin.json wins)", () => {
    expect(market.name).toBe("ned");
    expect(market.owner?.name).toBeTruthy();
    expect(market.plugins).toHaveLength(1);
    const [entry] = market.plugins;
    expect(entry.name).toBe(plugin.name);
    expect(entry.source).toBe("./");
    expect(entry.version).toBeUndefined();
  });

  it("CHANGELOG.md has an entry for the current version (docs/RELEASE.md)", () => {
    const log = fs.readFileSync(path.join(ROOT, "CHANGELOG.md"), "utf8");
    expect(log).toMatch(new RegExp(`^## ${plugin.version.replace(/\./g, "\\.")}\\b`, "m"));
  });
});

describe("plugin hooks (hooks/hooks.json)", () => {
  const hooks = readJson("hooks/hooks.json").hooks as Record<string, { hooks: { type: string; command: string; timeout: number }[] }[]>;
  // install-hooks.mjs is a script with side effects — read its EVENTS list as text.
  const src = fs.readFileSync(path.join(ROOT, "packages/hook/install-hooks.mjs"), "utf8");
  const EVENTS = JSON.parse(/EVENTS = (\[[^\]]*\])/.exec(src)![1]) as string[];

  it("registers ned-hook.sh for exactly the events install-hooks.mjs registers", () => {
    expect(EVENTS).toHaveLength(8);
    expect(Object.keys(hooks).sort()).toEqual([...EVENTS].sort());
  });

  it("each command runs the bundled hook through ${CLAUDE_PLUGIN_ROOT}, quoted, timeout 5", () => {
    for (const ev of EVENTS) {
      expect(hooks[ev]).toHaveLength(1);
      const [h] = hooks[ev][0].hooks;
      expect(h).toEqual({ type: "command", command: '/bin/sh "${CLAUDE_PLUGIN_ROOT}/packages/hook/ned-hook.sh"', timeout: 5 });
    }
  });

  it("the referenced script exists and is executable", () => {
    const p = path.join(ROOT, "packages/hook/ned-hook.sh");
    expect(fs.statSync(p).mode & 0o111).not.toBe(0);
  });
});

describe("plugin commands (/ned:install · /ned:status · /ned:uninstall)", () => {
  const frontmatter = (md: string) => {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
    return m ? Object.fromEntries(m[1].split("\n").map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()])) : null;
  };
  const cases: [string, string, boolean][] = [
    ["install", "scripts/install.sh", true],
    ["status", "scripts/status.sh", false],
    ["uninstall", "scripts/uninstall.sh", true],
  ];
  for (const [name, script, manualOnly] of cases) {
    it(`commands/${name}.md has a description and runs ${script} through \${CLAUDE_PLUGIN_ROOT}`, () => {
      const md = fs.readFileSync(path.join(ROOT, "commands", `${name}.md`), "utf8");
      const fm = frontmatter(md);
      expect(fm?.description).toBeTruthy();
      // No pre-approved Bash: the permission prompt is the second gate before a script that deletes/installs runs
      // (an env-prefixed command can't be matched by a narrow allow rule anyway — permissions docs).
      expect(fm?.["allowed-tools"] ?? "").not.toMatch(/\bBash\b/);
      // Installing/removing software only when the user types it — Claude must not run these on its own.
      expect(fm?.["disable-model-invocation"] === "true").toBe(manualOnly);
      expect(md).toContain(`"\${CLAUDE_PLUGIN_ROOT}/${script}"`);
      expect(fs.statSync(path.join(ROOT, script)).mode & 0o111).not.toBe(0);
    });
  }
  it("install/uninstall run in plugin mode", () => {
    for (const n of ["install", "uninstall"]) expect(fs.readFileSync(path.join(ROOT, "commands", `${n}.md`), "utf8")).toContain("NED_PLUGIN_MODE=1 bash");
  });
  it("install runs in the background and tells the update order: update → /reload-plugins → /ned:install", () => {
    const md = fs.readFileSync(path.join(ROOT, "commands", "install.md"), "utf8");
    expect(md).toContain("run_in_background");
    expect(md).toMatch(/\/plugin update ned` → `\/reload-plugins`.*→ `\/ned:install`/);
  });
});
