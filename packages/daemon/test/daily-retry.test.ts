/**
 * Morning briefing retry + offline / wake guard for automatic runs (src/scheduler.ts, src/online.ts):
 * a failed daily isn't "done" (retry after DAILY_RETRY_MINUTES, give up after DAILY_MAX_RETRIES → state.daily_failed_at),
 * only a successful daily file counts on restart (hadGoodDailyOn), offline / just-woke ticks run nothing (cost 0),
 * manual endpoints never probe the network. Fake clock, temp NED_HOME (test/setup.ts), NED_NO_LLM=1, no port.
 */
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { DEFAULT_CONFIG, loadConfig } = await import("../src/config.js");
type NedConfig = import("../src/config.js").NedConfig;
const { BRIEFINGS_DIR, localDay } = await import("../src/paths.js");
const { DAILY_MAX_RETRIES, DAILY_RETRY_MINUTES, createScheduler } = await import("../src/scheduler.js");
const { createOnlineCheck } = await import("../src/online.js");
const { hadGoodDailyOn, heartbeat, listBriefings } = await import("../src/heartbeat.js");
const { briefingOk, readState, writeState } = await import("../src/state.js");
const { renderSections } = await import("../src/archive.js");
const { bfFailed, bfKind, dailyFailedLine } = await import("../public/app/features/dailyfail.js");
type Briefing = import("../src/state.js").Briefing;

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).getTime();
const MIN = 60_000;

beforeAll(() => {
  startServer(() => loadConfig());
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NED_NO_LLM_RESULT;
});

type HbResult = { ok?: boolean } | null | "throw";

function harness(o: { start?: number; results?: HbResult[]; online?: () => Promise<boolean>; wakeGapMs?: number; dailyDoneToday?: boolean; cost?: { usd: number } } = {}) {
  let t = o.start ?? at(9, 8, 58);
  const cfg: NedConfig = { ...DEFAULT_CONFIG, heartbeat_skip_unchanged: false, heartbeat_minutes: 30, agenda_refresh_minutes: 600, briefing_time: "09:00", quiet_hours: null };
  const hb: { daily: boolean; at: number }[] = [];
  const agenda: number[] = [];
  const logs: string[] = [];
  const failed: { at: number; attempts: number }[] = [];
  const results = [...(o.results ?? [])];
  const sched = createScheduler({
    now: () => t,
    loadConfig: () => cfg,
    overBudget: () => false,
    enabledSources: () => ["slack"],
    runningSources: () => [],
    sourcesStatus: () => ({ slack: { started_at: agenda.at(-1) ?? 0 } }),
    refreshAgenda: async () => {
      agenda.push(t);
      if (o.cost) o.cost.usd += 0.1;
    },
    heartbeat: async (_c, x) => {
      hb.push({ daily: x.daily, at: t });
      if (o.cost) o.cost.usd += 0.1;
      const r = x.daily ? results.shift() : undefined;
      if (r === "throw") throw new Error("spawn claude ENOTFOUND");
      return r === undefined ? { ok: true } : r;
    },
    activityAt: () => t,
    dailyDoneToday: o.dailyDoneToday ?? false,
    online: o.online,
    wakeGapMs: o.wakeGapMs,
    onDailyFailed: (a, n) => void failed.push({ at: a, attempts: n }),
    log: (m) => void logs.push(m),
  });
  const step = async (to: number) => {
    t = to;
    await sched.tick();
    await sched.idle();
  };
  const run = async (to: number) => {
    while (t < to) await step(Math.min(to, t + MIN));
  };
  const dailies = () => hb.filter((x) => x.daily);
  return { hb, agenda, logs, failed, step, run, dailies };
}

describe("scheduler: daily retry", () => {
  it("fails at 09:00 → retries 10m later → success counts as done (no more dailies that day)", async () => {
    const h = harness({ results: [{ ok: false }, { ok: true }] });
    await h.run(at(9, 9, 0));
    expect(h.dailies().map((x) => x.at)).toEqual([at(9, 9, 0)]);
    expect(h.logs.some((l) => l.startsWith("daily: failed") && l.includes(`retry 1/${DAILY_MAX_RETRIES} at 09:10`))).toBe(true);
    await h.run(at(9, 9, 9));
    expect(h.dailies()).toHaveLength(1); // waits the full retry interval
    await h.run(at(9, 9, 10));
    expect(h.dailies().map((x) => x.at)).toEqual([at(9, 9, 0), at(9, 9, DAILY_RETRY_MINUTES)]);
    expect(h.logs).toContain("daily: ok on attempt 2");
    await h.run(at(9, 12, 0));
    expect(h.dailies()).toHaveLength(2);
    expect(h.hb.filter((x) => !x.daily).length).toBeGreaterThan(0); // regular heartbeats go on
    expect(h.failed).toEqual([]);
  });

  it("a thrown heartbeat counts as a failure too", async () => {
    const h = harness({ results: ["throw", { ok: true }] });
    await h.run(at(9, 9, 10));
    expect(h.dailies()).toHaveLength(2);
    expect(h.logs.some((l) => l.includes("spawn claude ENOTFOUND") && l.startsWith("daily: failed"))).toBe(true);
  });

  it(`${DAILY_MAX_RETRIES} retries all fail → gives up for the day (onDailyFailed once), next day tries again`, async () => {
    const h = harness({ results: [{ ok: false }, { ok: false }, null, { ok: false }, { ok: true }] });
    await h.run(at(9, 12, 0));
    expect(h.dailies().map((x) => x.at)).toEqual([at(9, 9, 0), at(9, 9, 10), at(9, 9, 20), at(9, 9, 30)]);
    expect(h.failed).toEqual([{ at: at(9, 9, 30), attempts: DAILY_MAX_RETRIES + 1 }]);
    expect(h.logs.some((l) => l.includes("giving up until tomorrow"))).toBe(true);
    await h.step(at(10, 8, 59));
    await h.run(at(10, 9, 1));
    expect(h.dailies().at(-1)?.at).toBe(at(10, 9, 0));
    expect(h.dailies()).toHaveLength(5);
  });
});

describe("restart: only a successful daily counts", () => {
  const write = (b: Partial<Briefing> & { id: string; ts: number }) =>
    fs.writeFileSync(path.join(BRIEFINGS_DIR, `${b.id}.json`), JSON.stringify({ type: "daily", status: "NED_OK", action_items: [], updates: [], fyi: [], ...b }));

  it("failed (ok:false), legacy failed (raw, no ok) don't count; ok:true and legacy clean do", () => {
    const day = "2026-11-09";
    const t = at(9, 9, 0);
    write({ id: "2026-11-09T00-00-00-001Z", ts: t, ok: false, raw: "" });
    write({ id: "2026-11-09T00-00-00-002Z", ts: t + 1, raw: "Error: getaddrinfo ENOTFOUND" });
    write({ id: "2026-11-09T00-00-00-003Z", ts: t + 2, type: "heartbeat", ok: true });
    expect(hadGoodDailyOn(day, listBriefings(50))).toBe(false);
    write({ id: "2026-11-09T00-00-00-004Z", ts: t + 3 }); // legacy file without ok, no raw = judged fine
    expect(hadGoodDailyOn(day, listBriefings(50))).toBe(true);
    expect(hadGoodDailyOn("2026-11-10", listBriefings(50))).toBe(false);
    expect(briefingOk({ ok: true, raw: "x" })).toBe(true);
    expect(briefingOk({})).toBe(true);
  });

  it("a scheduler started without dailyDoneToday runs the daily on the first tick past briefing_time", async () => {
    const h = harness({ start: at(9, 11, 0) });
    await h.step(at(9, 11, 0));
    expect(h.dailies()).toHaveLength(1);
  });
});

describe("heartbeat(): success flag + daily_failed_at", () => {
  it("unparsable daily → ok:false, kept as raw, not counted; a good daily clears daily_failed_at", async () => {
    // The "restart" fixtures above are dated 2026-11-09 — on that day they would count as today's good daily.
    if (fs.existsSync(BRIEFINGS_DIR)) for (const f of fs.readdirSync(BRIEFINGS_DIR)) if (f.endsWith(".json")) fs.unlinkSync(path.join(BRIEFINGS_DIR, f));
    const cfg = { ...loadConfig(), sources: { ...DEFAULT_CONFIG.sources, slack: false, gmail: false, jira: false, github: false, calendar: false, sentry: false } };
    process.env.NED_NO_LLM_RESULT = "sorry, I couldn't reach the API";
    const bad = (await heartbeat(cfg, { force: true, daily: true }))!;
    expect(bad).toMatchObject({ type: "daily", ok: false, raw: "sorry, I couldn't reach the API" });
    expect(hadGoodDailyOn(localDay())).toBe(false);
    expect(readState().last_briefing).toMatchObject({ type: "daily", ok: false });

    const s = readState();
    s.daily_failed_at = Date.now();
    writeState(s);
    process.env.NED_NO_LLM_RESULT = JSON.stringify({ status: "NED_OK", headline: "좋은 아침" });
    const good = (await heartbeat(cfg, { force: true, daily: true }))!;
    expect(good).toMatchObject({ type: "daily", ok: true });
    expect(good.raw).toBeUndefined();
    expect(hadGoodDailyOn(localDay())).toBe(true);
    expect(readState().daily_failed_at).toBeNull();
  });

  it("archive 🌅: a failed daily isn't shown as a briefing", () => {
    const base = { ts: at(9, 9, 0), status: "NED_OK" as const, action_items: [{ title: "should not show" }], updates: [], fyi: [] };
    const d = { day: "2026-11-09", briefings: [{ ...base, id: "a", type: "daily" as const, ok: false, raw: "x" }], actions: [], outputs: [], sessions: [], costs: null, srcCounts: {} };
    const inc = { briefings: true, updates: true, actions: true, outputs: true, sessions: false };
    const secs = (x: typeof d) => Object.fromEntries(renderSections(x as never, inc).map((s) => [s.name, s.body]));
    expect(secs(d).briefing).toContain("아침 브리핑 실패 1회");
    expect(secs(d).briefing).not.toContain("should not show");
    expect(secs(d).today).toContain("아침 브리핑 실패");
    expect(secs(d).today).not.toContain("✓");
    const ok = { ...d, briefings: [...d.briefings, { ...base, id: "b", type: "daily" as const, ok: true, headline: "굿", action_items: [] }] };
    expect(secs(ok).briefing).toContain("굿");
    expect(secs(ok).today).toContain("아침 브리핑 ✓");
  });
});

describe("offline / wake grace (automatic runs only)", () => {
  it("offline → tick skipped: no agenda, no heartbeat, cost 0; logged once; back online resumes", async () => {
    let up = false;
    const cost = { usd: 0 };
    const h = harness({ start: at(9, 9, 0), online: async () => up, cost });
    await h.run(at(9, 9, 5));
    expect(h.hb).toHaveLength(0);
    expect(h.agenda).toHaveLength(0);
    expect(cost.usd).toBe(0);
    expect(h.logs.filter((l) => l.startsWith("offline"))).toHaveLength(1);
    up = true;
    await h.step(at(9, 9, 6));
    expect(h.logs).toContain("online again — automatic runs resume");
    expect(h.agenda).toEqual([at(9, 9, 6)]); // startup refresh, held back while offline
    expect(h.dailies().map((x) => x.at)).toEqual([at(9, 9, 6)]);
  });

  it("offline doesn't burn daily retries", async () => {
    let up = true;
    const h = harness({ start: at(9, 9, 0), online: async () => up, results: [{ ok: false }, { ok: true }] });
    await h.step(at(9, 9, 0));
    up = false;
    await h.run(at(9, 10, 0));
    expect(h.dailies()).toHaveLength(1);
    up = true;
    await h.step(at(9, 10, 1));
    expect(h.dailies()).toHaveLength(2);
    expect(h.logs).toContain("daily: ok on attempt 2");
  });

  it("wake grace: a tick ≥ wakeGapMs after the previous one runs nothing; the next tick does", async () => {
    const h = harness({ start: at(9, 7, 0), wakeGapMs: 3 * MIN, dailyDoneToday: false });
    await h.step(at(9, 7, 0)); // startup (before briefing_time)
    const n = h.hb.length;
    await h.step(at(9, 9, 30)); // slept 2.5h
    expect(h.hb.length).toBe(n);
    expect(h.logs.some((l) => l.startsWith("wake: 150m since the last tick"))).toBe(true);
    await h.step(at(9, 9, 31));
    expect(h.dailies().map((x) => x.at)).toEqual([at(9, 9, 31)]);
    await h.step(at(9, 9, 33)); // a 2-minute gap is not sleep
    expect(h.logs.filter((l) => l.startsWith("wake:"))).toHaveLength(1);
  });
});

describe("online probe (src/online.ts)", () => {
  it("lookup ok → true, cached 30s; failure → false; hang → false after the timeout", async () => {
    let t = 0;
    const calls: string[] = [];
    let mode: "ok" | "fail" | "hang" = "ok";
    const check = createOnlineCheck({
      now: () => t,
      timeoutMs: 20,
      lookup: async (h) => {
        calls.push(h);
        if (mode === "fail") throw new Error("ENOTFOUND");
        if (mode === "hang") await new Promise(() => {});
        return { address: "1.2.3.4" };
      },
    });
    expect(await check()).toBe(true);
    expect(calls).toEqual(["api.anthropic.com"]);
    mode = "fail";
    t = 29_000;
    expect(await check()).toBe(true); // cached
    expect(calls).toHaveLength(1);
    t = 30_000;
    expect(await check()).toBe(false);
    mode = "hang";
    t = 61_000;
    expect(await check()).toBe(false);
    expect(calls).toHaveLength(3);
  });

  it("manual POST /api/check · /api/heartbeat · /api/agenda/refresh never probe the network", async () => {
    const spy = vi.spyOn(dns.promises, "lookup").mockRejectedValue(new Error("ENOTFOUND"));
    for (const p of ["/api/check", "/api/heartbeat?daily=1", "/api/agenda/refresh"]) {
      const r = await request(p, { method: "POST" });
      expect(r.status, p).toBe(200);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("dashboard helpers (public/app/features/dailyfail.js)", () => {
  it("bfFailed / bfKind follow briefingOk; dailyFailedLine only for today", () => {
    for (const b of [{ ok: false }, { raw: "x" }, { ok: true, raw: "x" }, {}]) expect(bfFailed(b)).toBe(!briefingOk(b));
    expect(bfKind({ type: "daily", ok: false })).toBe("아침 실패");
    expect(bfKind({ type: "heartbeat" })).toBe("점검");
    const now = at(9, 10, 0);
    expect(dailyFailedLine({ daily_failed_at: at(9, 9, 30) }, now)).toContain("오늘 아침 브리핑 실패");
    expect(dailyFailedLine({ daily_failed_at: at(8, 9, 30) }, now)).toBe("");
    expect(dailyFailedLine({ daily_failed_at: null }, now)).toBe("");
    expect(dailyFailedLine(undefined, now)).toBe("");
  });
});
