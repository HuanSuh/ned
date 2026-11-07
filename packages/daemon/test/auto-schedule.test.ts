/**
 * Quiet-hours / idle throttling of automatic work (src/scheduler.ts, config.quiet_schedule / idle_schedule):
 * pure due / verdict helpers, the scheduler tick with a fake clock (slow, pause, quiet end → one full refresh,
 * idle start / end), manual endpoints unaffected, status on /api/state + /api/agenda, config normalize.
 * No port is bound (serve is mocked), never claude (NED_NO_LLM=1), temp NED_HOME (test/setup.ts).
 */
import fs from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { DEFAULT_CONFIG, loadConfig, normalizeIdleSchedule, normalizeQuietSchedule } = await import("../src/config.js");
type NedConfig = import("../src/config.js").NedConfig;
type AgendaSourceKey = import("../src/agenda.js").AgendaSourceKey;
const { CONFIG_PATH } = await import("../src/paths.js");
const { dueSources, nextDueAt } = await import("../src/schedule.js");
const S = await import("../src/scheduler.js");
const { autoSchedChip, normIdle, normQuiet } = await import("../public/app/features/autosched.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const MIN = 60_000;
const cfgWith = (o: Partial<NedConfig> = {}): NedConfig => ({ ...DEFAULT_CONFIG, ...o });

beforeAll(() => {
  startServer(() => loadConfig());
  expect(captured.fetch).toBeTypeOf("function");
});

describe("config normalize", () => {
  it("quiet_schedule: defaults slow ×6, factor clamps 2..24, bad mode keeps base", () => {
    expect(DEFAULT_CONFIG.quiet_schedule).toEqual({ mode: "slow", slow_factor: 6 });
    expect(normalizeQuietSchedule({ mode: "pause", slow_factor: 1 })).toEqual({ mode: "pause", slow_factor: 2 });
    expect(normalizeQuietSchedule({ mode: "nope", slow_factor: 99 })).toEqual({ mode: "slow", slow_factor: 24 });
    expect(normalizeQuietSchedule({ slow_factor: "abc" }, { mode: "normal", slow_factor: 3 })).toEqual({ mode: "normal", slow_factor: 3 });
    expect(normalizeQuietSchedule(null)).toEqual({ mode: "slow", slow_factor: 6 });
  });

  it("idle_schedule: defaults on / 120m / 6 runs / slow ×6, clamps, partial keeps base", () => {
    expect(DEFAULT_CONFIG.idle_schedule).toEqual({ enabled: true, after_minutes: 120, unchanged_runs: 6, mode: "slow", slow_factor: 6 });
    expect(normalizeIdleSchedule({ enabled: false, after_minutes: 1, unchanged_runs: 0, mode: "pause", slow_factor: 100 })).toEqual({ enabled: false, after_minutes: 10, unchanged_runs: 1, mode: "pause", slow_factor: 24 });
    expect(normalizeIdleSchedule({ enabled: "yes", mode: "normal", after_minutes: true })).toEqual(DEFAULT_CONFIG.idle_schedule);
    expect(normalizeIdleSchedule({ unchanged_runs: 3 }, { ...DEFAULT_CONFIG.idle_schedule, enabled: false })).toMatchObject({ enabled: false, unchanged_runs: 3 });
  });

  it("loadConfig reads both blocks; PUT /api/config merges partial blocks", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", quiet_schedule: { mode: "pause" }, idle_schedule: { after_minutes: 30 } }));
    const c = loadConfig();
    expect(c.quiet_schedule).toEqual({ mode: "pause", slow_factor: 6 });
    expect(c.idle_schedule).toMatchObject({ enabled: true, after_minutes: 30, unchanged_runs: 6 });
    const r = await request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ quiet_schedule: { slow_factor: 4 }, idle_schedule: { mode: "pause" } }) });
    expect(r.status).toBe(200);
    expect(loadConfig().quiet_schedule).toEqual({ mode: "pause", slow_factor: 4 });
    expect(loadConfig().idle_schedule).toMatchObject({ after_minutes: 30, mode: "pause" });
  });

  it("dashboard normalizers match the daemon's", () => {
    expect(normQuiet({ mode: "x", slow_factor: 50 })).toEqual(normalizeQuietSchedule({ mode: "x", slow_factor: 50 }));
    expect(normIdle({ after_minutes: 5, unchanged_runs: 99 })).toEqual(normalizeIdleSchedule({ after_minutes: 5, unchanged_runs: 99 }));
  });
});

describe("pure due calculation", () => {
  const c = cfgWith({ agenda_refresh_minutes: 60, agenda_source_minutes: { ...DEFAULT_CONFIG.agenda_source_minutes, slack: 10 } });
  const keys: AgendaSourceKey[] = ["slack", "jira"];

  it("factor stretches every source interval (normal = 1)", () => {
    const t0 = at(6, 12);
    expect(nextDueAt(c, keys, { slack: t0, jira: t0 }, t0)).toEqual({ slack: t0 + 10 * MIN, jira: t0 + 60 * MIN });
    expect(nextDueAt(c, keys, { slack: t0, jira: t0 }, t0, 6)).toEqual({ slack: t0 + 60 * MIN, jira: t0 + 360 * MIN });
    expect(dueSources(c, keys, { slack: t0, jira: t0 }, t0 + 15 * MIN)).toEqual(["slack"]);
    expect(dueSources(c, keys, { slack: t0, jira: t0 }, t0 + 15 * MIN, [], 6)).toEqual([]);
    expect(dueSources(c, keys, { slack: t0, jira: t0 }, t0 + 60 * MIN, [], 6)).toEqual(["slack"]); // jira: 60m × 6
  });

  it("heartbeatDue: never run → due; × factor; slack seconds count", () => {
    const t0 = at(6, 12);
    expect(S.heartbeatDue(null, 10, 1, t0)).toBe(true);
    expect(S.heartbeatDue(t0, 10, 1, t0 + 10 * MIN - 3_000)).toBe(true);
    expect(S.heartbeatDue(t0, 10, 6, t0 + 30 * MIN)).toBe(false);
    expect(S.heartbeatDue(t0, 10, 6, t0 + 60 * MIN)).toBe(true);
  });

  it("quietStatus: boundaries and midnight crossing", () => {
    const c2 = cfgWith({ quiet_hours: { start: "23:00", end: "08:00" }, quiet_schedule: { mode: "slow", slow_factor: 6 } });
    expect(S.quietStatus(c2, new Date(at(6, 22, 59))).active).toBe(false);
    expect(S.quietStatus(c2, new Date(at(6, 23, 0)))).toEqual({ active: true, mode: "slow", until: "08:00", factor: 6 });
    expect(S.quietStatus(c2, new Date(at(7, 0, 30))).active).toBe(true);
    expect(S.quietStatus(c2, new Date(at(7, 7, 59))).active).toBe(true);
    expect(S.quietStatus(c2, new Date(at(7, 8, 0))).active).toBe(false);
    expect(S.quietStatus(cfgWith({ quiet_schedule: { mode: "pause", slow_factor: 6 } }), new Date(at(7, 1))).factor).toBe(1);
    expect(S.quietStatus(cfgWith({ quiet_hours: null }), new Date(at(7, 1)))).toMatchObject({ active: false, until: null });
    // same-day window
    const day = cfgWith({ quiet_hours: { start: "12:00", end: "13:00" } });
    expect(S.quietStatus(day, new Date(at(6, 12, 30))).active).toBe(true);
    expect(S.quietStatus(day, new Date(at(6, 13, 0))).active).toBe(false);
  });

  it("combineThrottle: pause beats slow, larger factor wins, nothing → ×1", () => {
    const off = { active: false, mode: "slow" as const, factor: 6 };
    expect(S.combineThrottle(off, off)).toEqual({ pause: false, factor: 1, by: null });
    expect(S.combineThrottle({ active: true, mode: "normal", factor: 1 }, off)).toEqual({ pause: false, factor: 1, by: null });
    expect(S.combineThrottle({ active: true, mode: "slow", factor: 6 }, off)).toEqual({ pause: false, factor: 6, by: "quiet" });
    expect(S.combineThrottle({ active: true, mode: "slow", factor: 4 }, { active: true, mode: "slow", factor: 8 })).toEqual({ pause: false, factor: 8, by: "idle" });
    expect(S.combineThrottle({ active: true, mode: "slow", factor: 24 }, { active: true, mode: "pause", factor: 1 })).toMatchObject({ pause: true, by: "idle" });
    expect(S.combineThrottle({ active: true, mode: "pause", factor: 1 }, { active: true, mode: "slow", factor: 6 })).toMatchObject({ pause: true, by: "quiet" });
  });
});

describe("idleVerdict (both signals required)", () => {
  const sched = { ...DEFAULT_CONFIG.idle_schedule, after_minutes: 120, unchanged_runs: 3 };
  const now = at(6, 15);
  const old = now - 121 * MIN, recent = now - 30 * MIN;

  it.each([
    ["no activity + all unchanged", old, [false, true, true, true], true],
    ["no activity + a changed run", old, [true, true, false], false],
    ["no activity + too few runs", old, [true, true], false],
    ["recent activity + all unchanged", recent, [true, true, true], false],
    ["recent activity + changed", recent, [false], false],
    ["exactly after_minutes", now - 120 * MIN, [true, true, true], true],
  ])("%s", (_name, act, runs, idle) => {
    expect(S.idleVerdict(sched, act, runs, now).idle).toBe(idle);
  });

  it("disabled → never idle; reason explains the signals", () => {
    expect(S.idleVerdict({ ...sched, enabled: false }, old, [true, true, true], now)).toEqual({ idle: false, reason: "disabled" });
    expect(S.idleVerdict(sched, old, [true, true, true], now).reason).toBe("활동 없음 121분 · 연속 무변경 3회");
    expect(S.idleVerdict(sched, old, [true, false, true], now).reason).toBe("활동 없음 121분 · 무변경 1/3회");
  });

  it("parseHidIdle: ns → ms, absent → null", () => {
    expect(S.parseHidIdle(`| |   "HIDIdleTime" = 5123456789\n`)).toBe(5123);
    expect(S.parseHidIdle("nothing here")).toBeNull();
  });
});

describe("scheduler tick", () => {
  type Call = { kind: "agenda"; sources: AgendaSourceKey[]; at: number } | { kind: "heartbeat"; daily: boolean; at: number };

  function harness(cfgO: Partial<NedConfig>, start: number, opts: { activityAt?: () => number; unchanged?: boolean } = {}) {
    let t = start;
    const calls: Call[] = [];
    const logs: string[] = [];
    const status: Partial<Record<AgendaSourceKey, { started_at?: number; unchanged?: boolean }>> = {};
    // Timing tests: every due heartbeat must reach d.heartbeat (skip-unchanged has its own file, heartbeat-skip.test.ts).
    let cfg = cfgWith({ heartbeat_skip_unchanged: false, heartbeat_minutes: 10, agenda_refresh_minutes: 60, briefing_time: "09:00", quiet_hours: { start: "23:00", end: "08:00" }, ...cfgO });
    const unchanged = { v: opts.unchanged ?? false };
    const sched = S.createScheduler({
      now: () => t,
      loadConfig: () => cfg,
      overBudget: () => false,
      enabledSources: () => ["slack", "jira"],
      runningSources: () => [],
      sourcesStatus: () => status,
      refreshAgenda: async (_c, sources) => {
        calls.push({ kind: "agenda", sources: [...sources], at: t });
        for (const k of sources) status[k] = { started_at: t, unchanged: unchanged.v };
      },
      heartbeat: async (_c, o) => void calls.push({ kind: "heartbeat", daily: o.daily, at: t }),
      activityAt: opts.activityAt ?? (() => 0),
      dailyDoneToday: true,
      log: (m) => void logs.push(m),
    });
    const step = async (to: number) => {
      t = to;
      await sched.tick();
      await sched.idle();
    };
    /** Tick every minute from now up to `to` (inclusive). */
    const run = async (to: number) => {
      while (t < to) await step(Math.min(to, t + MIN));
    };
    return { calls, logs, sched, step, run, unchanged, setCfg: (o: Partial<NedConfig>) => (cfg = { ...cfg, ...o }), now: () => t };
  }
  const agendas = (calls: Call[]) => calls.filter((c) => c.kind === "agenda");
  const hbs = (calls: Call[]) => calls.filter((c) => c.kind === "heartbeat");

  it("normal hours: startup refreshes everything + heartbeat, then base intervals", async () => {
    const h = harness({}, at(6, 12));
    await h.step(at(6, 12));
    expect(agendas(h.calls)).toHaveLength(1);
    expect(hbs(h.calls)).toHaveLength(1);
    await h.run(at(6, 13, 0));
    expect(agendas(h.calls).map((c) => c.sources)).toEqual([["slack", "jira"], ["slack", "jira"]]);
    expect(hbs(h.calls)).toHaveLength(7); // 12:00, :10 … 13:00
  });

  it("quiet slow ×6: heartbeat every 60m, agenda every 6h", async () => {
    const h = harness({ quiet_schedule: { mode: "slow", slow_factor: 6 } }, at(6, 23, 0));
    await h.step(at(6, 23, 0)); // startup
    await h.run(at(7, 2, 0));
    expect(hbs(h.calls).map((c) => new Date(c.at).getHours())).toEqual([23, 0, 1, 2]);
    expect(agendas(h.calls)).toHaveLength(1);
    await h.run(at(7, 5, 0));
    expect(agendas(h.calls)).toHaveLength(2); // 23:00 + 6h
  });

  it("quiet pause: nothing automatic, 'quiet: paused' at most hourly", async () => {
    const h = harness({ quiet_schedule: { mode: "pause", slow_factor: 6 } }, at(6, 23, 30));
    await h.run(at(7, 2, 0));
    expect(h.calls).toHaveLength(0);
    expect(h.logs.filter((l) => l.startsWith("quiet: paused"))).toHaveLength(3); // 23:31, 00:31, 01:31
  });

  it("quiet end: one full refresh, agenda before heartbeat, briefing already due runs daily on fresh lists", async () => {
    // Started the night before (dailyDoneToday covers day 6), briefing 07:30 falls inside quiet hours.
    const h2 = harness({ quiet_schedule: { mode: "pause", slow_factor: 6 }, briefing_time: "07:30" }, at(6, 23, 50));
    await h2.run(at(7, 7, 59));
    expect(h2.calls).toHaveLength(0);
    await h2.step(at(7, 8, 0));
    expect(h2.logs).toContain("quiet: ended — full refresh");
    expect(h2.calls.map((c) => c.kind)).toEqual(["agenda", "heartbeat"]);
    expect(h2.calls[0]).toMatchObject({ sources: ["slack", "jira"] });
    expect(h2.calls[1]).toMatchObject({ daily: true });
    await h2.step(at(7, 8, 1));
    expect(h2.calls).toHaveLength(2); // once only
    expect(h2.logs.filter((l) => l.startsWith("quiet: ended"))).toHaveLength(1);
  });

  it("quiet mode normal: no throttling and no end refresh", async () => {
    const h = harness({ quiet_schedule: { mode: "normal", slow_factor: 6 } }, at(7, 7, 0));
    await h.run(at(7, 8, 1));
    expect(h.logs.some((l) => l.includes("quiet: ended"))).toBe(false);
    expect(hbs(h.calls).length).toBeGreaterThanOrEqual(6);
  });

  it("idle: starts after both signals, slows down, activity ends it with one full refresh", async () => {
    let act = at(6, 9, 0);
    const h = harness({ quiet_hours: null, agenda_refresh_minutes: 10, idle_schedule: { enabled: true, after_minutes: 120, unchanged_runs: 3, mode: "slow", slow_factor: 6 } }, at(6, 9, 0), { activityAt: () => act, unchanged: true });
    await h.run(at(6, 10, 59));
    expect(h.sched.status().idle.active).toBe(false); // runs unchanged, but the last activity is only 119m old
    await h.run(at(6, 11, 0));
    const st = h.sched.status().idle;
    expect(st.active).toBe(true);
    expect(st).toMatchObject({ mode: "slow", factor: 6 });
    expect(h.logs.some((l) => l.startsWith("idle: started"))).toBe(true);
    expect(S.schedulerStatus(cfgWith()).idle.active).toBe(true);
    const n = h.calls.length;
    await h.run(at(6, 11, 50));
    expect(agendas(h.calls.slice(n))).toHaveLength(0); // 10m × 6 = 60m
    // Activity comes back (session event / HID)
    act = at(6, 11, 51);
    await h.step(at(6, 11, 51));
    expect(h.logs).toContain("idle: ended — full refresh");
    expect(h.sched.status().idle.active).toBe(false);
    const after = h.calls.filter((c) => c.at === at(6, 11, 51));
    expect(after.map((c) => c.kind)).toEqual(["agenda", "heartbeat"]);
    expect(after[0]).toMatchObject({ sources: ["slack", "jira"] });
    expect(h.sched.status().recentRuns).toEqual([true]); // reset at the end, then the full refresh
  });

  it("idle needs unchanged runs: changing data keeps it awake", async () => {
    const h = harness({ quiet_hours: null, agenda_refresh_minutes: 10, idle_schedule: { enabled: true, after_minutes: 10, unchanged_runs: 3, mode: "pause", slow_factor: 6 } }, at(6, 9, 0), { unchanged: false });
    await h.run(at(6, 12, 0));
    expect(h.sched.status().idle.active).toBe(false);
    h.unchanged.v = true;
    await h.run(at(6, 12, 40));
    expect(h.sched.status().idle).toMatchObject({ active: true, mode: "pause" });
    const n = h.calls.length;
    await h.run(at(6, 14, 0));
    expect(h.calls.length).toBe(n); // paused
    expect(h.logs.some((l) => l.startsWith("idle: paused"))).toBe(true);
    // A dashboard ping ends it right away (noteActivity wakes the scheduler).
    S.noteActivity(h.now());
    await new Promise((r) => setTimeout(r, 0));
    await h.sched.idle();
    expect(h.sched.status().idle.active).toBe(false);
    expect(h.logs).toContain("idle: ended — full refresh");
    h.sched.stop();
  });

  it("quiet + idle overlapping: the slower one wins", async () => {
    const h = harness({ quiet_schedule: { mode: "slow", slow_factor: 2 }, idle_schedule: { enabled: true, after_minutes: 10, unchanged_runs: 1, mode: "slow", slow_factor: 6 }, agenda_refresh_minutes: 10 }, at(6, 23, 0), { unchanged: true });
    await h.run(at(6, 23, 30));
    expect(h.sched.status().idle.active).toBe(true);
    const n = hbs(h.calls).length;
    await h.run(at(7, 1, 30));
    // heartbeat 10m × 6 = 60m (idle) rather than × 2 (quiet)
    expect(hbs(h.calls).length - n).toBe(2);
    h.sched.stop();
  });
});

describe("server: status + manual endpoints", () => {
  it("GET /api/state keeps quiet boolean and adds quiet_schedule / idle; visible=1 and POST /api/activity count as activity", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", quiet_schedule: { mode: "pause" } }));
    const before = S.lastPingAt();
    const s = (await (await request("/api/state")).json()) as Record<string, unknown>;
    expect(typeof s.quiet).toBe("boolean");
    expect(s.quiet_schedule).toMatchObject({ mode: "pause", until: "08:00", factor: 1 });
    expect(s.idle).toMatchObject({ active: false });
    expect(S.lastPingAt()).toBe(before);
    await request("/api/state?visible=1");
    expect(S.lastPingAt()).toBeGreaterThanOrEqual(before);
    const r = await request("/api/activity", { method: "POST" });
    expect(await r.json()).toEqual({ ok: true });
    expect(Date.now() - S.lastPingAt()).toBeLessThan(5_000);
  });

  it("GET /api/agenda carries quiet + idle", async () => {
    const a = (await (await request("/api/agenda")).json()) as Record<string, unknown>;
    expect(a.quiet).toMatchObject({ mode: "pause", until: "08:00" });
    expect(a.idle).toMatchObject({ active: false });
  });

  it("manual POST /api/agenda/refresh runs during quiet pause (scheduler not involved)", async () => {
    // Quiet hours covering every minute of the day → always active, mode pause.
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", quiet_hours: { start: "00:00", end: "23:59" }, quiet_schedule: { mode: "pause" }, sources: { gmail: false, slack: false, sentry: false, calendar: false, jira: true, github: false } }));
    const r = await request("/api/agenda/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sources: ["jira"] }) });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { started: string[] }).started).toEqual(["jira"]);
  });
});

describe("dashboard chip", () => {
  it("야간 / 유휴 text, idle wins, normal / inactive → empty", () => {
    expect(autoSchedChip({ quiet: { active: true, mode: "slow", factor: 6, until: "08:00" }, idle: { active: false } })).toBe("야간 모드 · 느리게 ×6 · 08:00 재개");
    expect(autoSchedChip({ quiet: { active: true, mode: "pause", factor: 1, until: "08:00" } })).toBe("야간 모드 · 멈춤 · 08:00 재개");
    expect(autoSchedChip({ quiet: { active: true, mode: "normal", factor: 1, until: "08:00" } })).toBe("");
    expect(autoSchedChip({ quiet: { active: false, mode: "slow" }, idle: { active: true, mode: "slow", factor: 6 } })).toBe("유휴 모드 · 느리게 ×6 · 활동 시 재개");
    expect(autoSchedChip({ idle: { active: true, mode: "pause" } })).toBe("유휴 모드 · 멈춤 · 활동 시 재개");
    expect(autoSchedChip(undefined)).toBe("");
  });
});
