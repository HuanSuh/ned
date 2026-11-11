/**
 * scripts/install.sh · uninstall.sh · status.sh against throwaway directories only.
 *
 * Every run gets a temp HOME, NED_HOME, runtime dir, app path, Claude settings file and plugins dir, and a PATH
 * whose first entry stubs the macOS tools (defaults, osascript, pkill, pgrep, launchctl, security, open) — the
 * stubs log their arguments and `defaults` keeps its values in files. With NED_SKIP_PREFLIGHT=1 and
 * NED_TEST_FAKE_BUILD=1 (stand-in build products) this runs on CI without swift/pnpm builds. The real
 * build is smoke-tested by hand (docs/RELEASE.md "스모크").
 *
 * The scripts are run from a copy of the repo's scripts in a temp "plugin" dir, so tests can put an .orphaned_at
 * next to them or place them under a fake plugin cache.
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
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ned-inst-")));
  dirs.push(d);
  return d;
};

const STUB = `#!/bin/sh
name=$(basename "$0")
echo "$name $*" >> "$NED_STUB_LOG"
if [ "$name" = defaults ]; then
  f="$NED_STUB_DIR/defaults.$2.$3"
  case "$1" in
    write) printf '%s' "$4" > "$f" ;;
    read) [ -f "$f" ] && cat "$f" && exit 0; exit 1 ;;
    delete) rm -f "$f" ;;
  esac
fi
[ "$name" = pgrep ] && exit 1
exit 0
`;

/** A plugin-shaped source tree (what install.sh syncs) at <base>/<rel>. */
function makeSrc(base: string, rel = "src"): string {
  const src = path.join(base, rel);
  for (const p of ["scripts", "packages/hook", ".claude-plugin", "package.json", "CHANGELOG.md"]) {
    fs.cpSync(path.join(ROOT, p), path.join(src, p), { recursive: true });
  }
  return src;
}

interface Env {
  base: string;
  src: string;
  home: string;
  nedHome: string;
  runtime: string;
  dest: string;
  settings: string;
  plugins: string;
  log: string;
  stubDir: string;
  env: Record<string, string>;
}
function setup(srcRel?: string): Env {
  const base = tmp();
  const stubDir = path.join(base, "stub");
  fs.mkdirSync(stubDir);
  for (const n of ["defaults", "osascript", "pkill", "pgrep", "launchctl", "security", "open"]) {
    fs.writeFileSync(path.join(stubDir, n), STUB, { mode: 0o755 });
  }
  const e = {
    base,
    src: makeSrc(base, srcRel),
    home: path.join(base, "home"),
    nedHome: path.join(base, "ned"),
    runtime: path.join(base, "runtime"),
    dest: path.join(base, "apps", "Ned.app"),
    settings: path.join(base, "settings.json"),
    plugins: path.join(base, "plugins"),
    log: path.join(base, "stub.log"),
    stubDir,
  } as Env;
  fs.mkdirSync(e.home);
  e.env = {
    PATH: `${stubDir}:${process.env.PATH}`,
    HOME: e.home,
    NED_HOME: e.nedHome,
    NED_RUNTIME_DIR: e.runtime,
    NED_APP_DEST: e.dest,
    NED_DEFAULTS_DOMAIN: "com.ned.menubar.test",
    NED_CLAUDE_SETTINGS: e.settings,
    NED_CLAUDE_PLUGINS_DIR: e.plugins,
    NED_SKIP_OPEN: "1",
    NED_PLUGIN_MODE: "1",
    NED_SKIP_PREFLIGHT: "1",
    NED_TEST_FAKE_BUILD: "1",
    NED_STUB_LOG: e.log,
    NED_STUB_DIR: stubDir,
    NED_NO_LLM: "1",
  };
  return e;
}
function run(e: Env, script: string, extra: Record<string, string | undefined> = {}, src = e.src) {
  const env: Record<string, string> = { ...e.env };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync("bash", [path.join(src, "scripts", script)], { encoding: "utf8", env, input: "" });
  return { code: r.status, out: r.stdout + r.stderr };
}
const defaultsValue = (e: Env, key = "nedRepoPath") => {
  const f = path.join(e.stubDir, `defaults.com.ned.menubar.test.${key}`);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
};
/** path → content for every file under dir (relative), to compare a tree byte for byte. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}
const siblings = (e: Env) => fs.readdirSync(e.base).filter((n) => n.startsWith("runtime")).sort();

describe("scripts parse", () => {
  it.each(["install.sh", "uninstall.sh", "status.sh", "lib/common.sh"])("%s (bash -n)", (s) => {
    const r = spawnSync("bash", ["-n", path.join(ROOT, "scripts", s)], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });
});

describe("install.sh (plugin mode, fake build)", () => {
  it("builds in runtime.next and swaps it in: runtime with marker, app copied, nedRepoPath set, log written", () => {
    const e = setup();
    const r = run(e, "install.sh");
    expect(r.out).toContain("✓ Ned installed.");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/runtime: build in .*runtime\.next/);
    expect(r.out).toMatch(/runtime\.next → .*runtime/);
    expect(siblings(e)).toEqual(["runtime"]);
    expect(fs.existsSync(path.join(e.runtime, ".ned-runtime"))).toBe(true);
    expect(fs.existsSync(path.join(e.runtime, "packages/daemon/dist/cli.js"))).toBe(true);
    expect(fs.existsSync(path.join(e.dest, "Contents/MacOS/Ned"))).toBe(true);
    expect(fs.existsSync(e.dest + ".next")).toBe(false);
    expect(defaultsValue(e)).toBe(e.runtime);
    expect(fs.readFileSync(path.join(e.nedHome, "logs/install.log"), "utf8")).toContain("✓ Ned installed.");
    const calls = fs.readFileSync(e.log, "utf8");
    expect(calls).not.toMatch(/^osascript/m); // isolated: never quits the real app by bundle id
    expect(calls).not.toMatch(/^launchctl/m);
  });

  it("an update is a fresh tree: build output an old version left behind is gone, .prev removed", () => {
    const e = setup();
    expect(run(e, "install.sh").code).toBe(0);
    fs.writeFileSync(path.join(e.runtime, "packages/daemon/dist/removed-module.js"), "old");
    const r = run(e, "install.sh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("removed runtime.prev");
    expect(fs.existsSync(path.join(e.runtime, "packages/daemon/dist/removed-module.js"))).toBe(false);
    expect(siblings(e)).toEqual(["runtime"]);
  });

  it.each(["sync", "build", "package"])("failing at %s leaves the installed runtime and app byte-identical, no .next", (step) => {
    const e = setup();
    expect(run(e, "install.sh").code).toBe(0);
    const before = snapshot(e.runtime);
    const app = snapshot(e.dest);
    const r = run(e, "install.sh", { NED_FAIL_AT: step });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("기존 설치는 유지됨");
    expect(snapshot(e.runtime)).toEqual(before);
    expect(snapshot(e.dest)).toEqual(app);
    expect(siblings(e)).toEqual(["runtime"]);
    expect(fs.existsSync(e.dest + ".next")).toBe(false);
  });

  it("failing right after the rename puts the previous runtime back", () => {
    const e = setup();
    expect(run(e, "install.sh").code).toBe(0);
    const before = snapshot(e.runtime);
    const r = run(e, "install.sh", { NED_FAIL_AT: "swap" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("런타임을 이전 것으로 되돌림");
    expect(snapshot(e.runtime)).toEqual(before);
    expect(siblings(e)).toEqual(["runtime"]);
  });

  it("refuses a non-empty runtime dir without the marker and leaves it alone", () => {
    const e = setup();
    fs.mkdirSync(e.runtime);
    fs.writeFileSync(path.join(e.runtime, "keep.txt"), "mine");
    const r = run(e, "install.sh");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(".ned-runtime");
    expect(fs.readdirSync(e.runtime)).toEqual(["keep.txt"]);
    expect(fs.existsSync(e.dest)).toBe(false);
  });

  it("refuses an unmarked non-empty runtime.next / runtime.prev too", () => {
    const e = setup();
    fs.mkdirSync(e.runtime + ".next");
    fs.writeFileSync(path.join(e.runtime + ".next", "x"), "x");
    expect(run(e, "install.sh").code).not.toBe(0);
    expect(fs.existsSync(path.join(e.runtime + ".next", "x"))).toBe(true);
  });

  it("refuses runtime dirs that are /, $HOME, the source, inside it, or relative", () => {
    const e = setup();
    for (const rt of ["/", e.home, e.src, path.join(e.src, "rt"), "rel/runtime"]) {
      const r = run(e, "install.sh", { NED_RUNTIME_DIR: rt });
      expect(r.code, rt).not.toBe(0);
      expect(r.out, rt).toMatch(/✗ (런타임|NED_RUNTIME_DIR|소스가)/);
    }
    expect(fs.existsSync(path.join(e.src, "rt"))).toBe(false);
  });

  it("refuses NED_APP_DEST that isn't an absolute *.app outside the source", () => {
    const e = setup();
    for (const d of ["Ned.app", e.home, "/", path.join(e.base, "Ned"), path.join(e.src, "Ned.app"), `${e.base}/x/../Ned.app`]) {
      const r = run(e, "install.sh", { NED_APP_DEST: d });
      expect(r.code, d).not.toBe(0);
      expect(r.out, d).toContain("✗ NED_APP_DEST");
    }
  });

  it("refuses an isolated run that changes only one of NED_APP_DEST / NED_DEFAULTS_DOMAIN", () => {
    const e = setup();
    const a = run(e, "install.sh", { NED_DEFAULTS_DOMAIN: undefined });
    const b = run(e, "install.sh", { NED_APP_DEST: undefined });
    for (const r of [a, b]) {
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("둘 다 바꿔야 함");
    }
    expect(fs.existsSync(e.log) ? fs.readFileSync(e.log, "utf8") : "").not.toMatch(/^(osascript|pkill|defaults)/m);
  });

  it("removes old Ned hooks from the settings file it is given (and only Ned's)", () => {
    const e = setup();
    const other = { type: "command", command: "/usr/local/bin/orca-hook" };
    fs.writeFileSync(e.settings, JSON.stringify({ hooks: { Stop: [{ hooks: [other, { type: "command", command: '/bin/sh "/x/ned-hook.sh"' }] }] } }));
    const r = run(e, "install.sh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed 1 Ned hook entry");
    expect(JSON.parse(fs.readFileSync(e.settings, "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [other] }] } });
  });
});

describe("install.sh plugin version check (H1)", () => {
  const CACHE = "plugins/cache/ned/ned/0.2.0";
  const installed = (e: Env, installPath: string) => {
    fs.mkdirSync(e.plugins, { recursive: true });
    fs.writeFileSync(
      path.join(e.plugins, "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "ned@ned": [{ scope: "user", installPath, version: "0.2.0" }] } }),
    );
  };

  it("refuses to install from a replaced version directory (.orphaned_at)", () => {
    const e = setup();
    fs.writeFileSync(path.join(e.src, ".orphaned_at"), "1");
    const r = run(e, "install.sh");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("/reload-plugins");
    expect(fs.existsSync(e.runtime)).toBe(false);
  });

  it("refuses when the session's plugin dir isn't the installPath Claude Code recorded", () => {
    const e = setup(CACHE);
    installed(e, path.join(e.base, "plugins/cache/ned/ned/0.3.0"));
    const r = run(e, "install.sh");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/stale .*version 0\.2\.0/);
    expect(r.out).toContain("/reload-plugins");
    expect(fs.existsSync(e.runtime)).toBe(false);
  });

  it("installs when the paths match", () => {
    const e = setup(CACHE);
    installed(e, e.src);
    const r = run(e, "install.sh");
    expect(r.out).toContain("ok ");
    expect(r.code).toBe(0);
  });

  it("status.sh warns about the same mismatch", () => {
    const e = setup(CACHE);
    installed(e, path.join(e.base, "plugins/cache/ned/ned/0.3.0"));
    const r = run(e, "status.sh", { NED_PORT: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("⚠ 로드된 플러그인이 설치본과 다름");
  });
});

describe("uninstall.sh", () => {
  it("plugin mode: removes app and marked runtime, clears nedRepoPath, leaves settings and data alone", () => {
    const e = setup();
    expect(run(e, "install.sh").code).toBe(0);
    const settings = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '/bin/sh "/x/ned-hook.sh"' }] }] } });
    fs.writeFileSync(e.settings, settings);
    const r = run(e, "uninstall.sh");
    expect(r.code).toBe(0);
    expect(fs.existsSync(e.dest)).toBe(false);
    expect(fs.existsSync(e.runtime)).toBe(false);
    expect(defaultsValue(e)).toBeNull();
    expect(fs.readFileSync(e.settings, "utf8")).toBe(settings);
    expect(fs.existsSync(path.join(e.nedHome, "logs/install.log"))).toBe(true);
  });

  it("keeps a runtime dir without the marker", () => {
    const e = setup();
    fs.mkdirSync(e.runtime);
    fs.writeFileSync(path.join(e.runtime, "keep.txt"), "mine");
    const r = run(e, "uninstall.sh");
    expect(r.code).toBe(0);
    expect(r.out).toContain("kept");
    expect(fs.readdirSync(e.runtime)).toEqual(["keep.txt"]);
  });

  it("refuses a bad NED_APP_DEST or a half-isolated run before deleting anything", () => {
    const e = setup();
    fs.mkdirSync(e.home + "/keep");
    for (const extra of [{ NED_APP_DEST: e.home }, { NED_APP_DEST: "relative.app" }, { NED_DEFAULTS_DOMAIN: undefined }]) {
      const r = run(e, "uninstall.sh", extra);
      expect(r.code).not.toBe(0);
    }
    expect(fs.existsSync(e.home + "/keep")).toBe(true);
  });
});

describe("status.sh", () => {
  it("reports daemon down, unset nedRepoPath, log tail and leftover Ned hooks — and writes nothing", () => {
    const e = setup();
    fs.mkdirSync(path.join(e.nedHome, "logs"), { recursive: true });
    fs.writeFileSync(path.join(e.nedHome, "logs", "app-daemon.log"), Array.from({ length: 15 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const body = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: '/bin/sh "/x/packages/hook/ned-hook.sh"' }] }] } });
    fs.writeFileSync(e.settings, body);
    const before = fs.readdirSync(e.base).sort();
    const r = run(e, "status.sh", { NED_PORT: "1" });
    expect(r.code).toBe(0);
    expect(r.out).toContain("down — no answer");
    expect(r.out).toContain("## MCP (http://127.0.0.1:1/mcp)\n  응답 없음");
    expect(r.out).toContain("/mcp 로 확인");
    expect(r.out).toMatch(/plugin\s+: \d+\.\d+\.\d+/);
    expect(r.out).toContain("plugin check: in-place");
    expect(r.out).toContain("nedRepoPath: (unset");
    expect(r.out).toContain("line 15");
    expect(r.out).not.toContain("line 5\n");
    expect(r.out).toContain("1 Ned hook entry left");
    expect(fs.readFileSync(e.settings, "utf8")).toBe(body);
    expect(fs.readdirSync(e.base).sort()).toEqual(before.includes("stub.log") ? before : [...before, "stub.log"].sort());
  });

  it("MCP line tells a 403 (Host/Origin guard) apart from a 404 (runtime without /mcp) and a good answer", () => {
    // spawnSync blocks this process, so no in-process server can answer — a curl stub prints body + "\n<code>" (-w).
    const e = setup();
    const curl = (mcpBody: string, mcpCode: string) =>
      fs.writeFileSync(path.join(e.stubDir, "curl"), `#!/bin/sh\ncase "$*" in *"/mcp"*) printf '%s\\n%s' '${mcpBody}' '${mcpCode}' ;; *) exit 7 ;; esac\n`, { mode: 0o755 });
    curl('{"error":{"message":"Forbidden"}}', "403");
    expect(run(e, "status.sh").out).toContain("403 Host/Origin 거부 — ");
    curl("Not found", "404");
    expect(run(e, "status.sh").out).toContain("MCP 가 아님 (런타임이 /mcp 이전 버전? → /ned:install): 404");
    curl('{"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"ned","version":"9.9.9"}}}', "200");
    expect(run(e, "status.sh").out).toContain("응답함 — ned 9.9.9 (protocol 2025-06-18)");
  });
});
