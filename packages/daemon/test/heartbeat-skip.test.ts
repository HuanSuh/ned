/**
 * Heartbeat skip-unchanged (src/scheduler.ts, config.heartbeat_skip_unchanged): an automatic, non-daily heartbeat with
 * nothing new since the last one that judged (list signatures, heartbeat watch key, session news) makes no claude call,
 * but next_heartbeat_at still advances. Fake clock, fake deps — no claude, no port, temp NED_HOME (test/setup.ts).
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import type { Agenda, AgendaSourceKey } from "../src/agenda.js";
import { DEFAULT_CONFIG, loadConfig, type NedConfig } from "../src/config.js";
import { CONFIG_PATH } from "../src/paths.js";
import { heartbeatWatchKey } from "../src/heartbeat.js";
import { HEARTBEAT_SKIP_MAX_MINUTES, createScheduler, heartbeatFingerprint } from "../src/scheduler.js";

const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const MIN = 60_000;
const SKIP_LOG = "heartbeat: skipped — unchanged";

function harness(o: Partial<NedConfig> = {}) {
  let t = at(7, 12, 0);
  const cfg: NedConfig = { ...DEFAULT_CONFIG, heartbeat_minutes: 10, agenda_refresh_minutes: 600, briefing_time: "09:00", quiet_hours: null, sources: { ...DEFAULT_CONFIG.sources, sentry: false }, ...o };
  const hb: { daily: boolean; at: number }[] = [];
  const next: number[] = [];
  const logs: string[] = [];
  const sig: Record<string, string> = { slack: "s1", jira: "j1" };
  const env = { events: 0, watch: "w0", silent: false };
  const sched = createScheduler({
    now: () => t,
    loadConfig: () => cfg,
    overBudget: () => false,
    enabledSources: () => ["slack", "jira"],
    runningSources: () => [],
    sourcesStatus: () => Object.fromEntries(Object.entries(sig).map(([k, v]) => [k, { started_at: t, signature: v }])) as Partial<Record<AgendaSourceKey, { signature: string }>>,
    refreshAgenda: async () => {},
    heartbeat: async (_c, x) => {
      hb.push({ daily: x.daily, at: t });
      env.events = 0; // a judged heartbeat commits the event cursor
      return env.silent ? null : { status: "NED_OK" };
    },
    pendingEvents: () => env.events,
    heartbeatWatchKey: () => env.watch,
    activityAt: () => t,
    dailyDoneToday: true,
    onHeartbeat: (n) => void next.push(n),
    log: (m) => void logs.push(m),
  });
  const step = async (to: number) => {
    t = to;
    await sched.tick();
    await sched.idle();
  };
  return { hb, next, logs, sig, env, step, cfg };
}

describe("heartbeat skip-unchanged (scheduler)", () => {
  it("unchanged lists + no session news → no heartbeat call, next_heartbeat_at still advances", async () => {
    const h = harness();
    await h.step(at(7, 12, 0)); // startup: runs
    expect(h.hb).toHaveLength(1);
    await h.step(at(7, 12, 10));
    await h.step(at(7, 12, 20));
    expect(h.hb).toHaveLength(1);
    expect(h.logs.filter((l) => l.startsWith(SKIP_LOG))).toHaveLength(2);
    expect(h.next).toEqual([at(7, 12, 10), at(7, 12, 20), at(7, 12, 30)]);
  });

  it("a changed signature, a new session-news event or a moved watch key runs it again", async () => {
    const h = harness();
    await h.step(at(7, 12, 0));
    h.sig.slack = "s2";
    await h.step(at(7, 12, 10));
    expect(h.hb).toHaveLength(2);
    await h.step(at(7, 12, 20));
    expect(h.hb).toHaveLength(2); // the new signature is now the baseline
    h.env.events = 1;
    await h.step(at(7, 12, 30));
    expect(h.hb).toHaveLength(3);
    h.env.watch = "w1"; // e.g. a meeting entered the 2h window
    await h.step(at(7, 12, 40));
    expect(h.hb).toHaveLength(4);
    await h.step(at(7, 12, 50));
    expect(h.hb).toHaveLength(4);
  });

  it("daily briefing never skips", async () => {
    const h = harness({ briefing_time: "12:05" });
    await h.step(at(7, 12, 0)); // dailyDoneToday covers day 7 → plain heartbeat, becomes the baseline
    await h.step(at(7, 12, 10));
    expect(h.hb).toHaveLength(1); // unchanged → skipped
    await h.step(at(8, 12, 5)); // nothing changed, but tomorrow's briefing is due
    expect(h.hb).toHaveLength(2);
    expect(h.hb.at(-1)).toMatchObject({ daily: true, at: at(8, 12, 5) });
  });

  it("a silent heartbeat (null: heartbeat.ts didn't judge) doesn't become the baseline", async () => {
    const h = harness();
    h.env.silent = true;
    await h.step(at(7, 12, 0));
    await h.step(at(7, 12, 10));
    expect(h.hb).toHaveLength(2); // never judged → nothing to compare against → runs
    h.env.silent = false;
    await h.step(at(7, 12, 20));
    await h.step(at(7, 12, 30));
    expect(h.hb).toHaveLength(3);
  });

  it("heartbeat_skip_unchanged: false → every due heartbeat runs", async () => {
    const h = harness({ heartbeat_skip_unchanged: false });
    for (const m of [0, 10, 20, 30]) await h.step(at(7, 12, m));
    expect(h.hb).toHaveLength(4);
    expect(h.logs.some((l) => l.startsWith(SKIP_LOG))).toBe(false);
  });

  it("Sentry on: a real run at least every HEARTBEAT_SKIP_MAX_MINUTES even when unchanged", async () => {
    const h = harness({ sources: { ...DEFAULT_CONFIG.sources, sentry: true } });
    await h.step(at(7, 12, 0));
    for (let m = 10; m < HEARTBEAT_SKIP_MAX_MINUTES; m += 10) await h.step(at(7, 12, 0) + m * MIN);
    expect(h.hb).toHaveLength(1);
    await h.step(at(7, 12, 0) + HEARTBEAT_SKIP_MAX_MINUTES * MIN);
    expect(h.hb).toHaveLength(2);
  });
});

describe("config heartbeat_skip_unchanged", () => {
  it("default true; only an explicit false turns it off (yaml + PUT merge)", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
    expect(loadConfig().heartbeat_skip_unchanged).toBe(true);
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", heartbeat_skip_unchanged: false }));
    const off = loadConfig();
    expect(off.heartbeat_skip_unchanged).toBe(false);
    const { mergeConfigPatch } = await import("../src/server.js");
    expect(mergeConfigPatch(off, { heartbeat_minutes: 5 }).heartbeat_skip_unchanged).toBe(false);
    expect(mergeConfigPatch(off, { heartbeat_skip_unchanged: true }).heartbeat_skip_unchanged).toBe(true);
    expect(mergeConfigPatch({ ...off, heartbeat_skip_unchanged: true }, { heartbeat_skip_unchanged: "x" as unknown as boolean }).heartbeat_skip_unchanged).toBe(true);
  });
});

describe("fingerprint / watch key", () => {
  it("heartbeatFingerprint: enabled sources' signatures (order-free) + watch key", () => {
    const a = heartbeatFingerprint(["slack", "jira"], { slack: { signature: "x" }, jira: { signature: "y" } }, "w");
    expect(heartbeatFingerprint(["jira", "slack"], { jira: { signature: "y" }, slack: { signature: "x" } }, "w")).toBe(a);
    expect(heartbeatFingerprint(["slack", "jira"], { slack: { signature: "x" }, jira: { signature: "z" } }, "w")).not.toBe(a);
    expect(heartbeatFingerprint(["slack", "jira"], { slack: { signature: "x" }, jira: { signature: "y" } }, "w2")).not.toBe(a);
  });

  it("heartbeatWatchKey: a calendar event entering the 2h window changes it, a far one doesn't", () => {
    const now = Date.parse("2026-11-07T03:00:00.000Z");
    const ev = (id: string, startH: number) => ({ id, title: id, start: new Date(now + startH * 3600_000).toISOString(), end: new Date(now + (startH + 1) * 3600_000).toISOString(), all_day: false, location: "", url: "", meet_url: "", rsvp: "accepted" as const, attendees: 2 });
    const ag = (cal: ReturnType<typeof ev>[]): Agenda => ({ updated_at: now, cost_usd: 0, calendar: cal, jira: [], github: [], mail: null, slack: null });
    const cfg = { ...DEFAULT_CONFIG };
    const base = heartbeatWatchKey(cfg, ag([ev("far", 5)]), now);
    expect(heartbeatWatchKey(cfg, ag([ev("far", 5)]), now + 30 * MIN)).toBe(base);
    expect(heartbeatWatchKey(cfg, ag([ev("far", 5)]), now + 3.5 * 3600_000)).not.toBe(base); // now ≤ 2h out
  });
});
