/**
 * 자동 업데이트 (src/self-update.ts + scripts/self-update.sh): the pure gates (checkDue, installVerdict, announceVerdict),
 * updateTick (check cadence, one announcement per version, quiet wait, auto-install gating), the detached spawn
 * (argv, detached + own stdio, unref, update-state "running"), the lock, the scheduler hook, POST /api/update/install —
 * and the shell script itself with a stub `claude` on PATH. No real claude, gh or install.sh runs.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const su = await import("../src/self-update.js");
const S = await import("../src/scheduler.js");
const { DEFAULT_CONFIG, loadConfig, normalizeUpdates } = await import("../src/config.js");
const { UPDATE_STATE_PATH, readState } = await import("../src/state.js");
const { startServer } = await import("../src/server.js");
const uc = await import("../src/update-check.js");
type Cfg = import("../src/config.js").NedConfig;
type Check = import("../src/update-check.js").UpdateCheck;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 11, 3, 0, 0);
const cfg = (u: Partial<Cfg["updates"]> = {}, n: Partial<Cfg["notifications"]> = {}): Cfg => ({
  ...DEFAULT_CONFIG,
  updates: { ...DEFAULT_CONFIG.updates, ...u },
  notifications: { ...DEFAULT_CONFIG.notifications, ...n },
});
const CHECK = (over: Partial<Check> = {}): Check => ({
  current: "0.2.0", latest: "0.3.0", source: "github", update_available: true, checked_at: T0, repo: "HuanSuh/ned",
  steps: ["/plugin update ned", "/reload-plugins", "/ned:install"], ...over,
});
const reset = () => fs.rmSync(UPDATE_STATE_PATH, { force: true });
const fileState = () => JSON.parse(fs.readFileSync(UPDATE_STATE_PATH, "utf8"));

describe("config.updates", () => {
  it("defaults: auto_check on every 24 h, auto_install off", () => {
    expect(DEFAULT_CONFIG.updates).toEqual({ auto_check: true, check_hours: 24, auto_install: false });
  });
  it("normalizeUpdates: booleans only, check_hours ≥ 1 (≤ 720), junk keeps the base", () => {
    expect(normalizeUpdates({ auto_install: true, check_hours: 0.2 })).toEqual({ auto_check: true, check_hours: 1, auto_install: true });
    expect(normalizeUpdates({ auto_check: "no", check_hours: "x" }, { auto_check: false, check_hours: 6, auto_install: false })).toEqual({ auto_check: false, check_hours: 6, auto_install: false });
    expect(normalizeUpdates({ check_hours: 9999 }).check_hours).toBe(720);
  });
});

describe("pure gates", () => {
  it("checkDue: never checked → due; then every check_hours (min 1)", () => {
    expect(su.checkDue(undefined, 24, T0)).toBe(true);
    expect(su.checkDue(T0, 24, T0 + 23 * HOUR)).toBe(false);
    expect(su.checkDue(T0, 24, T0 + 24 * HOUR)).toBe(true);
    expect(su.checkDue(T0, 0, T0 + HOUR)).toBe(true);
  });

  const base = { autoInstall: true, check: CHECK(), quiet: true, idle: false, sessions: [], state: {}, locked: false, now: T0 };
  it("installVerdict: ok only with a newer version, auto_install, quiet or idle, no live session, no recent failure", () => {
    expect(su.installVerdict(base).ok).toBe(true);
    expect(su.installVerdict({ ...base, quiet: false, idle: true }).ok).toBe(true);
    expect(su.installVerdict({ ...base, check: CHECK({ update_available: false }) }).reason).toBe("새 버전 없음");
    expect(su.installVerdict({ ...base, autoInstall: false }).reason).toContain("auto_install");
    expect(su.installVerdict({ ...base, quiet: false, idle: false }).reason).toContain("조용한 시간도 유휴도 아님");
    expect(su.installVerdict({ ...base, sessions: [{ status: "running" }] }).ok).toBe(false);
    expect(su.installVerdict({ ...base, sessions: [{ status: "waiting", worktree: "orca-worker" }] }).ok).toBe(false); // workers count
    expect(su.installVerdict({ ...base, sessions: [{ status: "done" }, { status: "idle" }] }).ok).toBe(true);
    expect(su.installVerdict({ ...base, locked: true }).reason).toBe("이미 업데이트 중");
  });
  it("installVerdict: a failure blocks automatic retries for 24 h; a stale 'running' counts as failed", () => {
    const failed = { last_attempt_at: T0 - 23 * HOUR, last_result: "fail" as const };
    expect(su.installVerdict({ ...base, state: failed }).reason).toContain("24시간");
    expect(su.installVerdict({ ...base, state: { ...failed, last_attempt_at: T0 - 25 * HOUR } }).ok).toBe(true);
    expect(su.installVerdict({ ...base, state: { last_attempt_at: T0 - HOUR, last_result: "running" } }).reason).toBe("이미 업데이트 중");
    expect(su.installVerdict({ ...base, state: { last_attempt_at: T0 - 3 * HOUR, last_result: "running" } }).reason).toContain("24시간");
  });
  it("installVerdict manual (지금 업데이트): skips the automatic gates, not the lock / nothing newer", () => {
    const m = { ...base, manual: true, autoInstall: false, quiet: false, idle: false, sessions: [{ status: "running" }], state: { last_attempt_at: T0 - HOUR, last_result: "fail" as const } };
    expect(su.installVerdict(m).ok).toBe(true);
    expect(su.installVerdict({ ...m, locked: true }).ok).toBe(false);
    expect(su.installVerdict({ ...m, check: CHECK({ update_available: false }) }).ok).toBe(false);
  });
  it("announceVerdict: once per version, waits out quiet hours (unless silent delivery), off when notifications are off", () => {
    expect(su.announceVerdict("0.3.0", {}, cfg(), false).now).toBe(true);
    expect(su.announceVerdict("0.3.0", { notified_version: "0.3.0" }, cfg(), false).now).toBe(false);
    expect(su.announceVerdict("0.4.0", { notified_version: "0.3.0" }, cfg(), false).now).toBe(true);
    expect(su.announceVerdict("0.3.0", {}, cfg(), true).now).toBe(false);
    expect(su.announceVerdict("0.3.0", {}, cfg({}, { quiet_delivery: "silent" }), true).now).toBe(true);
    expect(su.announceVerdict("0.3.0", {}, cfg({}, { enabled: false }), false).now).toBe(false);
  });
});

describe("updateTick", () => {
  beforeEach(reset);
  const mk = (check: () => Check = () => CHECK(), sessions: { status: string }[] = []) => {
    const calls = { check: 0, notify: [] as string[], start: [] as string[] };
    const d = {
      check: async () => { calls.check++; return check(); },
      notify: (_t: string, body: string) => void calls.notify.push(body),
      start: (c: { latest: string | null }) => { calls.start.push(String(c.latest)); return { started: true, reason: "ok" }; },
      locked: () => false,
      sessions: () => sessions,
    };
    return { d, calls };
  };

  it("checks when due, every check_hours; announces a version exactly once; state.json gets update_available", async () => {
    const { d, calls } = mk();
    await su.updateTick(cfg(), { quiet: false, idle: false, now: T0 }, d);
    expect(calls.check).toBe(1);
    expect(calls.notify).toHaveLength(1);
    expect(calls.notify[0]).toContain("0.3.0");
    expect(readState().update_available).toEqual({ current: "0.2.0", latest: "0.3.0", notified: true });
    await su.updateTick(cfg(), { quiet: false, idle: false, now: T0 + HOUR }, d);
    expect(calls.check).toBe(1); // not due yet
    await su.updateTick(cfg(), { quiet: false, idle: false, now: T0 + 25 * HOUR }, d);
    expect(calls.check).toBe(2);
    expect(calls.notify).toHaveLength(1); // same version: no second banner
    expect(calls.start).toHaveLength(0); // auto_install off
  });

  it("auto_check off → no check; quiet hours → the announcement waits for the first non-quiet tick", async () => {
    const off = mk();
    await su.updateTick(cfg({ auto_check: false }), { quiet: false, idle: false, now: T0 }, off.d);
    expect(off.calls.check).toBe(0);
    const { d, calls } = mk();
    await su.updateTick(cfg(), { quiet: true, idle: false, now: T0 }, d);
    expect(calls.notify).toHaveLength(0);
    expect(readState().update_available?.notified).toBe(false);
    await su.updateTick(cfg(), { quiet: false, idle: false, now: T0 + 60_000 }, d);
    expect(calls.notify).toHaveLength(1);
  });

  it("auto_install: starts only while quiet/idle with no running or waiting session", async () => {
    const busy = mk(undefined, [{ status: "running" }]);
    await su.updateTick(cfg({ auto_install: true }), { quiet: true, idle: false, now: T0 }, busy.d);
    expect(busy.calls.start).toHaveLength(0);
    reset();
    const day = mk();
    await su.updateTick(cfg({ auto_install: true }), { quiet: false, idle: false, now: T0 }, day.d);
    expect(day.calls.start).toHaveLength(0);
    await su.updateTick(cfg({ auto_install: true }), { quiet: false, idle: true, now: T0 + 60_000 }, day.d);
    expect(day.calls.start).toEqual(["0.3.0"]);
  });

  it("a failed check keeps the last known `available`; an up-to-date one clears it", async () => {
    const { d } = mk();
    await su.updateTick(cfg(), { quiet: false, idle: false, now: T0 }, d);
    const fail = mk(() => CHECK({ latest: null, update_available: false, error: "gh: boom" }));
    await su.updateTick(cfg(), { quiet: false, idle: false, now: T0 + 25 * HOUR }, fail.d);
    expect(fileState().available.latest).toBe("0.3.0");
    const same = mk(() => CHECK({ current: "0.3.0", update_available: false }));
    await su.updateTick(cfg(), { quiet: false, idle: false, now: T0 + 50 * HOUR }, same.d);
    expect(fileState().available).toBeNull();
    expect(readState().update_available).toBeNull();
  });
});

describe("startSelfUpdate (spawn injected)", () => {
  beforeEach(reset);
  it("spawns bash <script> --to --from --marketplace --plugin, detached with its own stdio, unref'd; records running", () => {
    const script = path.join(os.tmpdir(), `ned-su-${process.pid}.sh`);
    fs.writeFileSync(script, "#!/bin/sh\n");
    const seen: { cmd?: string; args?: string[]; opts?: import("node:child_process").SpawnOptions; unref: number; closed: number[] } = { unref: 0, closed: [] };
    const r = su.startSelfUpdate({ current: "0.2.0", latest: "0.3.0" }, {
      spawn: (cmd, args, opts) => { seen.cmd = cmd; seen.args = args; seen.opts = opts; return { pid: 4242, unref: () => void seen.unref++ }; },
      openLog: () => 99, closeLog: (fd) => void seen.closed.push(fd), now: () => T0, script,
    });
    fs.rmSync(script);
    expect(r).toMatchObject({ started: true, pid: 4242 });
    expect(seen.cmd).toBe("/bin/bash");
    expect(seen.args).toEqual([script, "--to", "0.3.0", "--from", "0.2.0", "--marketplace", "ned", "--plugin", "ned"]);
    expect(seen.opts?.detached).toBe(true);
    expect(seen.opts?.stdio).toEqual(["ignore", 99, 99]);
    expect(seen.unref).toBe(1);
    expect(seen.closed).toEqual([99]);
    expect(fileState()).toMatchObject({ last_attempt_at: T0, last_result: "running", from: "0.2.0", to: "0.3.0" });
  });
  it("missing script → not started; spawn throwing → recorded as a failure", () => {
    expect(su.startSelfUpdate({ current: "0.2.0", latest: "0.3.0" }, { spawn: () => { throw new Error("x"); }, openLog: () => 1, closeLog: () => {}, now: () => T0, script: "/nope.sh" }).started).toBe(false);
    const script = path.join(os.tmpdir(), `ned-su2-${process.pid}.sh`);
    fs.writeFileSync(script, "");
    const r = su.startSelfUpdate({ current: "0.2.0", latest: "0.3.0" }, { spawn: () => { throw new Error("EACCES"); }, openLog: () => 1, closeLog: () => {}, now: () => T0, script });
    fs.rmSync(script);
    expect(r.started).toBe(false);
    expect(fileState()).toMatchObject({ last_result: "fail", fail_line: "spawn: EACCES" });
  });
  it("lockHeld: pid file of a live process → held; dead owner / no lock → free", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ned-lock-"));
    const lock = path.join(dir, "self-update.lock");
    expect(su.lockHeld(lock)).toBe(false);
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, "pid"), String(process.pid));
    expect(su.lockHeld(lock)).toBe(true);
    expect(su.lockHeld(lock, () => false)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("scheduler hook", () => {
  it("calls updates(cfg, {quiet, idle, now}) on every tick, even while quiet hours pause the rest", async () => {
    const seen: { quiet: boolean; idle: boolean; now: number }[] = [];
    let t = Date.UTC(2026, 10, 11, 15, 0, 0); // 00:00 KST-ish: quiet depends on local tz, so pin quiet via config
    const c: Cfg = { ...DEFAULT_CONFIG, quiet_hours: { start: "00:00", end: "23:59" }, quiet_schedule: { ...DEFAULT_CONFIG.quiet_schedule, mode: "pause" } } as Cfg;
    const sched = S.createScheduler({
      now: () => t, loadConfig: () => c, overBudget: () => false, enabledSources: () => [], runningSources: () => [],
      sourcesStatus: () => ({}), refreshAgenda: async () => {}, heartbeat: async () => {}, activityAt: () => 0,
      dailyDoneToday: true, log: () => {},
      updates: async (_cfg, ctx) => void seen.push(ctx),
    });
    await sched.tick(); await sched.idle();
    t += 60_000;
    await sched.tick(); await sched.idle();
    expect(seen).toHaveLength(2);
    expect(seen[1].now).toBe(t);
    expect(typeof seen[0].quiet).toBe("boolean");
  });
});

describe("HTTP", () => {
  beforeAll(() => { startServer(() => loadConfig()); });
  beforeEach(() => {
    reset();
    const rt = uc.runtimeDir();
    uc.setUpdateDeps({
      readFile: (p) => (p === path.join(rt, ".claude-plugin", "plugin.json") ? JSON.stringify({ name: "ned", version: "0.3.0", repository: "https://github.com/HuanSuh/ned" }) : null),
      fetchText: async () => ({ status: 0, text: "", err: "offline" }),
      gh: async () => ({ code: 0, out: JSON.stringify({ version: "0.3.0" }), err: "", missing: false }),
    });
  });
  afterEach(() => uc.setUpdateDeps(null));

  it("auto-update uses the raw.githubusercontent.com result as is: updateTick → recordCheck → install of the raw version", async () => {
    const rt = uc.runtimeDir();
    uc.setUpdateDeps({
      readFile: (p) => (p === path.join(rt, ".claude-plugin", "plugin.json") ? JSON.stringify({ name: "ned", version: "0.3.0", repository: "https://github.com/HuanSuh/ned" }) : null),
      fetchText: async (url) => ({ status: url === "https://raw.githubusercontent.com/HuanSuh/ned/main/.claude-plugin/plugin.json" ? 200 : 404, text: JSON.stringify({ version: "0.5.0" }) }),
      gh: async () => { throw new Error("gh must not run when raw answers"); },
    });
    const started: (string | null)[] = [];
    const did = await su.updateTick(cfg({ auto_install: true }), { quiet: true, idle: false, now: T0 }, {
      check: (refresh) => uc.updateCheck({ refresh }), // the real check (deps injected above), as tickDeps() wires it
      notify: () => {},
      start: (c) => { started.push(c.latest); return { started: true, reason: "ok" }; },
      locked: () => false,
      sessions: () => [],
    });
    expect(did[0]).toBe("check: 0.3.0 / 0.5.0");
    expect(fileState().available).toMatchObject({ current: "0.3.0", latest: "0.5.0" });
    expect(started).toEqual(["0.5.0"]);
  });
  const req = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));

  it("GET /api/update-check?refresh=1 records the check and returns status (config.updates, next check)", async () => {
    const r = await (await req("/api/update-check?refresh=1")).json();
    expect(r.update_available).toBe(false);
    expect(r.status.auto).toEqual(DEFAULT_CONFIG.updates);
    expect(typeof r.status.next_check_at).toBe("number");
    expect(fileState().available).toBeNull();
  });
  it("POST /api/update/install with nothing newer → 409, nothing spawned", async () => {
    const res = await req("/api/update/install", { method: "POST" });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("새 버전 없음");
  });
});

// ---------------------------------------------------------------- scripts/self-update.sh (PATH stub for claude)

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(here, "../../../scripts/self-update.sh");
describe("scripts/self-update.sh", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
  function env(opts: { failAt?: string; installRc?: number; installedVersion?: string; noInstalledJson?: boolean } = {}) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ned-su-sh-")));
    dirs.push(base);
    const bin = path.join(base, "bin"), home = path.join(base, "ned"), cc = path.join(base, "claude");
    const cache = path.join(cc, "plugins", "cache", "ned", "ned", "0.3.0");
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.join(cache, "scripts"), { recursive: true }); fs.mkdirSync(path.join(cache, ".claude-plugin"), { recursive: true });
    const log = path.join(base, "calls.log");
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\necho "claude $*" >> "${log}"\n[ "$*" = "${opts.failAt ?? "-"}" ] && { echo "Error: marketplace not found"; exit 3; }\necho "ok $*"\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(cache, "scripts", "install.sh"), `#!/bin/sh\necho "install NED_PLUGIN_MODE=$NED_PLUGIN_MODE stdin=$( [ -t 0 ] && echo tty || echo redirected )" >> "${log}"\necho "✗ build failed"\nexit ${opts.installRc ?? 0}\n`);
    fs.writeFileSync(path.join(cache, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "ned", version: opts.installedVersion ?? "0.3.0" }));
    if (!opts.noInstalledJson) fs.writeFileSync(path.join(cc, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "ned@ned": [{ scope: "user", installPath: cache, version: "0.3.0" }] } }));
    const run = (args = ["--to", "0.3.0", "--from", "0.2.0"]) => spawnSync("/bin/bash", [SCRIPT, ...args], {
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: base, NED_HOME: home, CLAUDE_CONFIG_DIR: cc }, encoding: "utf8",
    });
    const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []);
    const state = () => JSON.parse(fs.readFileSync(path.join(home, "update-state.json"), "utf8"));
    return { run, calls, state, home };
  }

  it("runs marketplace update → plugin update → the new version's install.sh (plugin mode, stdin redirected); ok clears available", () => {
    const e = env();
    fs.mkdirSync(e.home, { recursive: true });
    fs.writeFileSync(path.join(e.home, "update-state.json"), JSON.stringify({ available: { latest: "0.3.0" }, notified_version: "0.3.0" }));
    const r = e.run();
    expect(r.status).toBe(0);
    expect(e.calls()).toEqual(["claude plugin marketplace update ned", "claude plugin update ned@ned", "install NED_PLUGIN_MODE=1 stdin=redirected"]);
    expect(e.state()).toMatchObject({ last_result: "ok", from: "0.2.0", to: "0.3.0", available: null, notified_version: "0.3.0" });
    expect(fs.readFileSync(path.join(e.home, "logs", "self-update.log"), "utf8")).toContain("✓ updated to 0.3.0");
    expect(fs.existsSync(path.join(e.home, "self-update.lock"))).toBe(false);
  });

  it("a failing step stops the run and records fail + its last output line", () => {
    const e = env({ failAt: "plugin marketplace update ned" });
    expect(e.run().status).toBe(1);
    expect(e.calls()).toEqual(["claude plugin marketplace update ned"]);
    expect(e.state()).toMatchObject({ last_result: "fail", fail_line: "marketplace update: Error: marketplace not found" });
  });

  it("install.sh failing → fail; plugin still on the old version → fail before install", () => {
    const a = env({ installRc: 1 });
    expect(a.run().status).toBe(1);
    expect(a.state()).toMatchObject({ last_result: "fail", fail_line: "install: ✗ build failed" });
    const b = env({ installedVersion: "0.2.0" });
    expect(b.run().status).toBe(1);
    expect(b.calls()).not.toContain("install NED_PLUGIN_MODE=1 stdin=redirected");
    expect(b.state().fail_line).toContain("0.2.0");
  });

  it("no installed_plugins.json → falls back to plugins/cache/<marketplace>/<plugin>/<to>", () => {
    const e = env({ noInstalledJson: true });
    expect(e.run().status).toBe(0);
  });

  it("a live lock → exit 75, nothing run; a dead owner's lock is taken over; bad usage → 2", () => {
    const e = env();
    fs.mkdirSync(path.join(e.home, "self-update.lock"), { recursive: true });
    fs.writeFileSync(path.join(e.home, "self-update.lock", "pid"), String(process.pid));
    expect(e.run().status).toBe(75);
    expect(e.calls()).toEqual([]);
    fs.writeFileSync(path.join(e.home, "self-update.lock", "pid"), "999999");
    expect(e.run().status).toBe(0);
    expect(e.run(["--from", "0.2.0"]).status).toBe(2);
    expect(e.run(["--to", "0.3.0; rm -rf /"]).status).toBe(2);
  });
});
