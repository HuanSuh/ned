/**
 * Per-source agenda refresh: config.agenda_source_minutes, the scheduler's due calculation (src/schedule.ts),
 * refreshAgenda({ sources }) filtering (NED_NO_LLM fixtures), and POST /api/agenda/refresh (sources body, 409).
 * No port is bound (serve is mocked), never claude (NED_NO_LLM=1), temp NED_HOME (test/setup.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { DEFAULT_CONFIG, loadConfig, normalizeAgendaSourceMinutes, sourceRefreshMinutes } = await import("../src/config.js");
const { CONFIG_PATH, NED_HOME } = await import("../src/paths.js");
const { listCalls, readAgenda, refreshAgenda, runningSources, startAgendaRefresh } = await import("../src/agenda.js");
const { DUE_SLACK_MS, dueSources, lastRuns, nextDueAt } = await import("../src/schedule.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const post = (body?: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const OFF = { gmail: false, slack: false, sentry: false };
const writeCfg = (extra: Record<string, unknown> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { ...OFF, calendar: true, jira: true, github: true }, ...extra }));
const fixture = (data: Record<string, unknown>) => {
  const f = path.join(NED_HOME, `fx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(data));
  process.env.NED_NO_LLM_AGENDA = f;
};
const jira = (key: string) => ({ key, title: key, status: "To Do", priority: "", due: null, url: `https://x/${key}`, updated: "" });
const gh = (n: number) => ({ repo: "o/r", number: n, title: `pr${n}`, url: `https://github.com/o/r/pull/${n}`, author: "a", updated: "", reason: "review_requested" });
const cal = (id: string) => ({ id, title: id, start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString(), all_day: false, rsvp: "accepted" });

beforeAll(() => {
  startServer(() => loadConfig());
  expect(captured.fetch).toBeTypeOf("function");
});
afterEach(() => {
  delete process.env.NED_NO_LLM_AGENDA;
  delete process.env.NED_NO_LLM_DELAY_MS;
});

describe("config.agenda_source_minutes", () => {
  it("defaults to all null (= agenda_refresh_minutes)", () => {
    expect(DEFAULT_CONFIG.agenda_source_minutes).toEqual({ slack: null, mail: null, calendar: null, jira: null, github: null });
    writeCfg();
    const c = loadConfig();
    expect(c.agenda_source_minutes).toEqual({ slack: null, mail: null, calendar: null, jira: null, github: null });
    expect(sourceRefreshMinutes(c, "slack")).toBe(60);
  });

  it("clamps numbers to 1..1440, bad values → null, missing keys keep base", () => {
    expect(normalizeAgendaSourceMinutes({ slack: 0, mail: 5000, calendar: "15", jira: "abc", github: -3 })).toEqual({ slack: null, mail: 1440, calendar: 15, jira: null, github: null });
    expect(normalizeAgendaSourceMinutes({ slack: 0.4 })).toMatchObject({ slack: 1 });
    expect(normalizeAgendaSourceMinutes({ slack: 1.2 })).toMatchObject({ slack: 1 });
    expect(normalizeAgendaSourceMinutes({ slack: true, mail: [], calendar: {} })).toMatchObject({ slack: null, mail: null, calendar: null });
    expect(normalizeAgendaSourceMinutes("nope")).toEqual(DEFAULT_CONFIG.agenda_source_minutes);
    const base = { slack: 10, mail: 20, calendar: null, jira: null, github: 30 };
    expect(normalizeAgendaSourceMinutes({ mail: null }, base)).toEqual({ ...base, mail: null });
  });

  it("loadConfig normalizes a hand-edited file; the effective interval falls back per source", () => {
    writeCfg({ agenda_refresh_minutes: 45, agenda_source_minutes: { slack: 5, mail: "x", jira: 99999 } });
    const c = loadConfig();
    expect(c.agenda_source_minutes).toEqual({ slack: 5, mail: null, calendar: null, jira: 1440, github: null });
    expect(sourceRefreshMinutes(c, "slack")).toBe(5);
    expect(sourceRefreshMinutes(c, "mail")).toBe(45);
    expect(sourceRefreshMinutes(c, "jira")).toBe(1440);
  });

  it("PUT /api/config saves, normalizes and merges per key", async () => {
    writeCfg({ agenda_source_minutes: { github: 30 } });
    let r = await request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ agenda_source_minutes: { slack: 10, mail: 0, calendar: 2000 } }) });
    expect(r.status).toBe(200);
    expect((await r.json()).agenda_source_minutes).toEqual({ slack: 10, mail: null, calendar: 1440, jira: null, github: 30 });
    expect(YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")).agenda_source_minutes).toEqual({ slack: 10, mail: null, calendar: 1440, jira: null, github: 30 });
    // A PUT without the key keeps it.
    r = await request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ reply_tone: "짧게" }) });
    expect((await r.json()).agenda_source_minutes.slack).toBe(10);
    expect(loadConfig().agenda_source_minutes.github).toBe(30);
  });
});

describe("scheduler due calculation (schedule.ts)", () => {
  const cfg = { agenda_refresh_minutes: 60, agenda_source_minutes: { slack: 5, mail: null, calendar: 30, jira: null, github: null } };
  const all = ["slack", "mail", "calendar", "jira", "github"] as const;
  const T = 1_700_000_000_000;
  const min = 60_000;

  it("a source never run is due", () => {
    expect(dueSources(cfg, all, {}, T)).toEqual([...all]);
  });

  it("each source follows its own interval (null → agenda_refresh_minutes)", () => {
    const last = { slack: T, mail: T, calendar: T, jira: T, github: T };
    expect(dueSources(cfg, all, last, T + 4 * min)).toEqual([]);
    expect(dueSources(cfg, all, last, T + 5 * min)).toEqual(["slack"]);
    expect(dueSources(cfg, all, last, T + 30 * min)).toEqual(["slack", "calendar"]);
    expect(dueSources(cfg, all, last, T + 60 * min)).toEqual([...all]);
    expect(nextDueAt(cfg, ["slack", "mail"], last, T)).toEqual({ slack: T + 5 * min, mail: T + 60 * min });
  });

  it("a tick a few seconds early still counts; running sources are skipped", () => {
    const last = { slack: T };
    expect(dueSources(cfg, ["slack"], last, T + 5 * min - DUE_SLACK_MS)).toEqual(["slack"]);
    expect(dueSources(cfg, ["slack"], last, T + 5 * min - DUE_SLACK_MS - 1)).toEqual([]);
    expect(dueSources(cfg, ["slack", "mail"], {}, T, ["slack"])).toEqual(["mail"]);
  });

  it("last run = later of the scheduler's start and agenda sources_status.started_at (manual refresh counts)", () => {
    const last = lastRuns({ slack: T, mail: T }, { slack: { started_at: T + 3 * min }, calendar: { started_at: T - min } }, all);
    expect(last).toEqual({ slack: T + 3 * min, mail: T, calendar: T - min });
    // Manual slack refresh at +3m pushes the next automatic slack run to +8m.
    expect(dueSources(cfg, ["slack"], last, T + 6 * min)).toEqual([]);
    expect(dueSources(cfg, ["slack"], last, T + 8 * min)).toEqual(["slack"]);
  });

  it("only disabled-or-not, in enabled order", () => {
    expect(dueSources(cfg, ["calendar", "slack"], {}, T)).toEqual(["calendar", "slack"]);
  });
});

describe("refreshAgenda({ sources })", () => {
  it("listCalls keeps only requested keys (jira+github call carries just the requested one)", () => {
    writeCfg();
    const c = loadConfig();
    expect(listCalls(c, false, ["github"]).map((x) => [x.id, x.keys])).toEqual([["jira", ["github"]]]);
    expect(listCalls(c, false, ["jira"]).map((x) => [x.id, x.keys])).toEqual([["jira", ["jira"]]]);
    expect(listCalls(c, false).map((x) => [x.id, x.keys])).toEqual([["jira", ["jira", "github"]], ["calendar", ["calendar"]]]);
    expect(listCalls(c, true, ["github"])).toEqual([]);
  });

  it("refreshes only the requested sources; others keep their lists and status", async () => {
    writeCfg();
    fixture({ calendar: [cal("e1")], jira: [jira("A-1")], github: [gh(1)] });
    await refreshAgenda(loadConfig());
    let a = readAgenda();
    expect(a.jira.map((j) => j.key)).toEqual(["A-1"]);
    expect(a.github.map((g) => g.number)).toEqual([1]);
    expect(a.calendar.map((e) => e.id)).toEqual(["e1"]);
    const before = a.sources_status!;

    fixture({ calendar: [cal("e2")], jira: [jira("B-2")], github: [gh(2)] });
    await new Promise((r) => setTimeout(r, 5));
    await refreshAgenda(loadConfig(), { sources: ["jira"] });
    a = readAgenda();
    expect(a.jira.map((j) => j.key)).toEqual(["B-2"]);
    expect(a.github.map((g) => g.number)).toEqual([1]);
    expect(a.calendar.map((e) => e.id)).toEqual(["e1"]);
    expect(a.sources_status!.calendar).toEqual(before.calendar);
    expect(a.sources_status!.github).toEqual(before.github);
    expect(a.sources_status!.jira!.updated_at).toBeGreaterThan(before.jira!.updated_at);

    await refreshAgenda(loadConfig(), { sources: ["github", "calendar"] });
    a = readAgenda();
    expect(a.github.map((g) => g.number)).toEqual([2]);
    expect(a.calendar.map((e) => e.id)).toEqual(["e2"]);
  });

  it("a disabled source in `sources` is ignored", async () => {
    writeCfg({ sources: { ...OFF, calendar: false, jira: true, github: false } });
    fixture({ calendar: [cal("zz")], jira: [jira("C-3")] });
    const run = startAgendaRefresh(loadConfig(), { sources: ["calendar", "jira"] });
    expect(run.started).toEqual(["jira"]);
    await run.done;
    expect(readAgenda().jira.map((j) => j.key)).toEqual(["C-3"]);
  });

  it("per-source concurrency: a running source is joined, others start", async () => {
    writeCfg();
    fixture({ calendar: [cal("e3")], jira: [jira("D-4")], github: [gh(3)] });
    process.env.NED_NO_LLM_DELAY_MS = "80";
    const r1 = startAgendaRefresh(loadConfig(), { sources: ["jira"] });
    expect(r1.started).toEqual(["jira"]);
    expect(runningSources()).toEqual(["jira"]);
    const r2 = startAgendaRefresh(loadConfig(), { sources: ["jira", "calendar"] });
    expect(r2.started).toEqual(["calendar"]);
    expect(r2.busy).toEqual(["jira"]);
    expect(runningSources()).toEqual(["calendar", "jira"]);
    await Promise.all([r1.done, r2.done]);
    expect(runningSources()).toEqual([]);
    const a = readAgenda();
    expect(a.jira[0].key).toBe("D-4");
    expect(a.calendar[0].id).toBe("e3");
  });
});

describe("POST /api/agenda/refresh", () => {
  it("no body → every enabled source; body.sources → only those; response lists started", async () => {
    writeCfg();
    fixture({ calendar: [cal("e4")], jira: [jira("E-5")], github: [gh(4)] });
    let r = await request("/api/agenda/refresh", post());
    expect(r.status).toBe(200);
    let j = await r.json();
    expect(j.started).toEqual(["calendar", "jira", "github"]);
    expect(j.busy).toEqual([]);
    r = await request("/api/agenda/refresh", post({ sources: ["github"] }));
    j = await r.json();
    expect(j.started).toEqual(["github"]);
    expect(j.github[0].number).toBe(4);
  });

  it("400 on unknown source", async () => {
    const r = await request("/api/agenda/refresh", post({ sources: ["slack", "nope"] }));
    expect(r.status).toBe(400);
  });

  it("409 { busy } when the requested source is already running; another source can still start", async () => {
    writeCfg();
    fixture({ calendar: [cal("e5")], jira: [jira("F-6")], github: [gh(5)] });
    process.env.NED_NO_LLM_DELAY_MS = "120";
    const first = request("/api/agenda/refresh", post({ sources: ["jira"] }));
    await new Promise((res) => setTimeout(res, 10));
    expect(runningSources()).toContain("jira");
    const busy = await request("/api/agenda/refresh", post({ sources: ["jira"] }));
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ busy: ["jira"] });
    // GET shows jira running (not 'interrupted') while it is live, plus the effective per-source intervals.
    const g = await (await request("/api/agenda")).json();
    expect(g.sources_status.jira.status).toBe("running");
    expect(g.running_sources).toEqual(["jira"]);
    expect(g.refresh_minutes).toMatchObject({ jira: 60, calendar: 60 });
    const other = await request("/api/agenda/refresh", post({ sources: ["calendar"] }));
    expect(other.status).toBe(200);
    expect((await other.json()).started).toEqual(["calendar"]);
    expect((await first).status).toBe(200);
    expect(runningSources()).toEqual([]);
  });
});
