/**
 * 수집 이력 store (src/history.ts): config normalize, upsert + state transitions, prune, collect window.
 * Runs in the temp NED_HOME from test/setup.ts.
 */
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AgendaPayload, SlackBlock } from "../src/agenda.js";
import { DEFAULT_CONFIG, DEFAULT_HISTORY, HISTORY_SOURCES, normalizeHistory, type NedConfig } from "../src/config.js";
import {
  HISTORY_DIR,
  HISTORY_META_PATH,
  collectWindow,
  gmailAfter,
  historyFile,
  historyFromThreads,
  historyUpsert,
  noteCollected,
  pruneHistory,
  readHistory,
  readHistoryMeta,
  upsertSlack,
  writeHistory,
  type SlackRec,
} from "../src/history.js";

const H = 3600_000, D = 24 * H;
const NOW = Date.parse("2026-11-08T03:00:00.000Z");
const cfg = (over: Partial<NedConfig> = {}): NedConfig => ({ ...DEFAULT_CONFIG, ...over });
const iso = (t: number) => new Date(t).toISOString();
/** Slack permalink for channel + epoch-ms message time (Slack p<10 digits><6 digits>). */
const sl = (ch: string, t: number, thread?: number) => `https://x.slack.com/archives/${ch}/p${Math.floor(t / 1000)}000100${thread ? `?thread_ts=${Math.floor(thread / 1000)}.000100` : ""}`;
const empty = (): AgendaPayload => ({ calendar: [], jira: [], github: [], mail: null, slack: null });
const slackBlock = (over: Partial<SlackBlock> = {}): SlackBlock => ({ summary: "", items: [], all: [], watch: [], ...over });

function wipe(): void {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
  fs.rmSync(HISTORY_META_PATH, { force: true });
}
beforeEach(wipe);

describe("normalizeHistory", () => {
  it("defaults", () => {
    expect(normalizeHistory(undefined)).toEqual(DEFAULT_HISTORY);
    expect(DEFAULT_CONFIG.history).toEqual({ enabled: true, display: { slack_hours: 24, mail_days: 3 }, keep_days: { slack: 30, mail: 30, jira: 90, github: 90, calendar: 90 } });
  });
  it("clamps ranges, keeps 0 (off), raises keep below the display window", () => {
    const h = normalizeHistory({ enabled: false, display: { slack_hours: 500, mail_days: 0 }, keep_days: { slack: 0, mail: -3, jira: 1000, github: "12", calendar: null } });
    expect(h.enabled).toBe(false);
    expect(h.display).toEqual({ slack_hours: 168, mail_days: 1 });
    expect(h.keep_days).toEqual({ slack: 0, mail: 0, jira: 365, github: 12, calendar: 90 }); // -3 clamps to 0 = off
    // 72 h shown → 3 days kept at least; mail 7 days shown → 7 kept
    const r = normalizeHistory({ display: { slack_hours: 72, mail_days: 7 }, keep_days: { slack: 1, mail: 2 } });
    expect(r.keep_days.slack).toBe(3);
    expect(r.keep_days.mail).toBe(7);
  });
  it("a partial patch keeps the base (PUT /api/config deep merge)", () => {
    const base = normalizeHistory({ display: { slack_hours: 48 } });
    const next = normalizeHistory({ keep_days: { jira: 10 } }, base);
    expect(next.display.slack_hours).toBe(48);
    expect(next.keep_days.jira).toBe(10);
    expect(next.keep_days.slack).toBe(30);
  });
});

describe("historyUpsert — list sources", () => {
  const j = (key: string) => ({ key, title: `t ${key}`, status: "진행", priority: "", due: null, url: `https://x.atlassian.net/browse/${key}`, updated: iso(NOW - H) });
  it("jira: open → false when it leaves the list → true when it comes back; first_seen kept", () => {
    historyUpsert({ ...empty(), jira: [j("A-1"), j("A-2")] }, ["jira"], cfg(), { now: NOW });
    let recs = readHistory("jira");
    expect(recs.map((r) => [r.key, r.state.open]).sort()).toEqual([["A-1", true], ["A-2", true]]);
    historyUpsert({ ...empty(), jira: [j("A-1")] }, ["jira"], cfg(), { now: NOW + H });
    recs = readHistory("jira");
    expect(recs.find((r) => r.key === "A-2")!.state.open).toBe(false);
    historyUpsert({ ...empty(), jira: [j("A-1"), j("A-2")] }, ["jira"], cfg(), { now: NOW + 2 * H });
    const a2 = readHistory("jira").find((r) => r.key === "A-2")!;
    expect(a2.state.open).toBe(true);
    expect(a2.first_seen).toBe(NOW);
    expect(a2.last_seen).toBe(NOW + 2 * H);
  });
  it("github keyed by PR url, calendar by event id (else url|start) with rsvp", () => {
    const g = { repo: "o/r", number: 7, title: "PR", url: "https://github.com/o/r/pull/7", author: "a", updated: iso(NOW), reason: "review_requested" as const };
    const ev = { id: "", title: "회의", start: iso(NOW + H), end: iso(NOW + 2 * H), all_day: false, location: "", url: "https://cal/x", meet_url: "", rsvp: "needsAction" as const, attendees: 3 };
    historyUpsert({ ...empty(), github: [g], calendar: [ev] }, ["github", "calendar"], cfg(), { now: NOW });
    expect(readHistory("github")[0].key).toBe(g.url);
    expect(readHistory("calendar")[0]).toMatchObject({ key: `https://cal/x|${ev.start}`, state: { rsvp: "needsAction" } });
  });
  it("keep_days 0 = that source is not recorded; history off = nothing at all", () => {
    historyUpsert({ ...empty(), jira: [j("A-1")] }, ["jira"], cfg({ history: normalizeHistory({ keep_days: { jira: 0 } }) }), { now: NOW });
    expect(fs.existsSync(historyFile("jira"))).toBe(false);
    fs.rmSync(HISTORY_META_PATH, { force: true });
    historyUpsert({ ...empty(), jira: [j("A-1")] }, ["jira"], cfg({ history: normalizeHistory({ enabled: false }) }), { now: NOW });
    expect(fs.existsSync(historyFile("jira"))).toBe(false);
    expect(fs.existsSync(HISTORY_META_PATH)).toBe(false);
  });
  it("writes compact JSON atomically (no temp file left)", () => {
    historyUpsert({ ...empty(), jira: [j("A-1")] }, ["jira"], cfg(), { now: NOW });
    expect(fs.readdirSync(HISTORY_DIR).filter((f) => f.includes("ned-tmp"))).toEqual([]);
    expect(fs.readFileSync(historyFile("jira"), "utf8")).not.toContain("\n");
  });
});

describe("upsertSlack", () => {
  const map = () => new Map<string, SlackRec>();
  it("need = picked into items; answered / acked from the list; reason upgraded", () => {
    const m = map();
    const u1 = sl("C1", NOW - H), u2 = sl("C1", NOW - 2 * H);
    upsertSlack(m, slackBlock({
      items: [{ channel: "#a", from: "kim", text: "리뷰 부탁", url: u1, ts: iso(NOW - H), reason: "thread" }],
      all: [
        { channel: "#a", from: "kim", text: "@me 이거 리뷰 좀", url: u1, ts: iso(NOW - H), reason: "mention", answered: false },
        { channel: "#a", from: "lee", text: "감사", url: u2, ts: iso(NOW - 2 * H), reason: "mention", answered: true },
      ],
    }), { now: NOW });
    const r1 = [...m.values()].find((r) => r.item.url === u1)!;
    expect(r1.state).toMatchObject({ need: true, answered: false, reason: "mention", rank: 0 });
    expect(r1.item).toMatchObject({ text: "@me 이거 리뷰 좀", ask: "리뷰 부탁" });
    expect([...m.values()].find((r) => r.item.url === u2)!.state).toMatchObject({ need: false, answered: true });
  });
  it("a newer DM ask supersedes older open ones in the conversation (count rolls up)", () => {
    const m = map();
    const old = sl("D1", NOW - 3 * H), nu = sl("D1", NOW - H);
    upsertSlack(m, slackBlock({ items: [{ channel: "DM", from: "kim", text: "a", url: old, ts: iso(NOW - 3 * H), reason: "dm" }] }), { now: NOW - 2 * H });
    upsertSlack(m, slackBlock({ items: [{ channel: "DM", from: "kim", text: "b", url: nu, ts: iso(NOW - H), reason: "dm" }] }), { now: NOW });
    const recs = [...m.values()];
    expect(recs.find((r) => r.item.url === old)!.state.need).toBe(false);
    expect(recs.find((r) => r.item.url === nu)!.state).toMatchObject({ need: true, count: 2 });
  });
  it("my own message answers older records in the same DM / thread, not other threads", () => {
    const m = map();
    const dm = sl("D1", NOW - 3 * H), th = sl("C1", NOW - 3 * H), other = sl("C1", NOW - 2 * H);
    upsertSlack(m, slackBlock({ items: [
      { channel: "DM", from: "kim", text: "a", url: dm, ts: iso(NOW - 3 * H), reason: "dm" },
      { channel: "#c", from: "lee", text: "b", url: th, ts: iso(NOW - 3 * H), reason: "mention" },
      { channel: "#c", from: "park", text: "c", url: other, ts: iso(NOW - 2 * H), reason: "mention" },
    ] }), { now: NOW - 2 * H });
    upsertSlack(m, slackBlock(), { now: NOW, mine: [sl("D1", NOW - H), sl("C1", NOW - H, NOW - 3 * H)] });
    const st = (u: string) => [...m.values()].find((r) => r.item.url === u)!.state.answered;
    expect([st(dm), st(th), st(other)]).toEqual([true, true, false]);
  });
  it("a full search no longer listing an ask closes it (only rows newer than the oldest returned); incremental never does", () => {
    const m = map();
    const a = sl("C1", NOW - 10 * H), b = sl("C1", NOW - 5 * H), c = sl("C1", NOW - 2 * H);
    const it = (u: string, t: number) => ({ channel: "#c", from: "x", text: "q", url: u, ts: iso(t), reason: "mention" as const });
    upsertSlack(m, slackBlock({ items: [it(a, NOW - 10 * H), it(b, NOW - 5 * H), it(c, NOW - 2 * H)] }), { now: NOW - H });
    upsertSlack(m, slackBlock({ all: [{ ...it(c, NOW - 2 * H), answered: false }] }), { now: NOW, win: { slack: { full: false, since: NOW - 3 * H, reason: "incremental" } } });
    const need = (u: string) => [...m.values()].find((r) => r.item.url === u)!.state.need;
    expect([need(a), need(b), need(c)]).toEqual([true, true, false]);
    upsertSlack(m, slackBlock({ all: [{ ...it(b, NOW - 5 * H), answered: false }] }), { now: NOW, win: { slack: { full: true, since: NOW - 24 * H, reason: "rescan" } } });
    // a is older than the oldest row returned (b): untouched
    expect([need(a), need(b)]).toEqual([true, false]);
  });
  it("phase-2 thread / DM reads answer older records (historyFromThreads)", () => {
    const u = sl("C9", NOW - 3 * H);
    historyUpsert({ ...empty(), slack: slackBlock({ items: [{ channel: "#c", from: "x", text: "q", url: u, ts: iso(NOW - 3 * H), reason: "mention" }] }) }, ["slack"], cfg(), { now: NOW });
    const ts = `${Math.floor((NOW - 3 * H) / 1000)}.000100`, mine = `${Math.floor((NOW - H) / 1000)}.000200`;
    const t = { key: `C9:${ts}`, channel_id: "C9", thread_ts: ts, my_last_reply_ts: mine } as never;
    const keys = historyFromThreads({ threads: [t], dms: [] }, cfg());
    expect(keys.size).toBe(1);
    expect(readHistory<SlackRec>("slack")[0].state.answered).toBe(true);
  });
});

describe("pruneHistory", () => {
  const j = (key: string, updated: number) => ({ key, title: key, status: "", priority: "", due: null, url: "", updated: iso(updated) });
  it("drops records not seen within keep_days, once a day; keep 0 deletes the file; other files untouched", () => {
    const long = cfg({ history: normalizeHistory({ keep_days: { jira: 365 } }) });
    historyUpsert({ ...empty(), jira: [j("OLD-1", NOW - 100 * D)] }, ["jira"], long, { now: NOW - 100 * D });
    historyUpsert({ ...empty(), jira: [j("NEW-1", NOW - D)] }, ["jira"], long, { now: NOW - D }); // OLD-1 open → false, last_seen stays old
    historyUpsert({ ...empty(), github: [{ repo: "o/r", number: 1, title: "x", url: "https://github.com/o/r/pull/1", author: "", updated: iso(NOW), reason: "review_requested" }] }, ["github"], long, { now: NOW });
    const foreign = path.join(HISTORY_DIR, "notes.txt"), foreignJson = path.join(HISTORY_DIR, "custom.json");
    fs.writeFileSync(foreign, "mine");
    fs.writeFileSync(foreignJson, "{}");
    fs.rmSync(HISTORY_META_PATH, { force: true });
    const c = cfg({ history: normalizeHistory({ keep_days: { github: 0 } }) });
    const removed = pruneHistory(c, NOW);
    expect(removed).toEqual({ jira: 1, github: 1 });
    expect(readHistory("jira").map((r) => r.key)).toEqual(["NEW-1"]);
    expect(fs.existsSync(historyFile("github"))).toBe(false);
    expect(fs.readFileSync(foreign, "utf8")).toBe("mine");
    expect(fs.existsSync(foreignJson)).toBe(true);
    expect(readHistoryMeta().last_prune_day).toBeTruthy();
    // same day again: no work
    writeHistory("jira", [...readHistory("jira"), { key: "X-1", source: "jira", first_seen: NOW - 200 * D, last_seen: NOW - 200 * D, ts: iso(NOW - 200 * D), state: {}, item: {} }]);
    expect(pruneHistory(c, NOW + H)).toEqual({});
    expect(pruneHistory(c, NOW + H, true)).toEqual({ jira: 1 });
  });
  it("history off: never deletes", () => {
    historyUpsert({ ...empty(), jira: [j("A-1", NOW - 400 * D)] }, ["jira"], cfg(), { now: NOW - 400 * D });
    fs.rmSync(HISTORY_META_PATH, { force: true });
    expect(pruneHistory(cfg({ history: normalizeHistory({ enabled: false }) }), NOW)).toEqual({});
    expect(readHistory("jira")).toHaveLength(1);
  });
});

describe("collectWindow", () => {
  it("first run (no file / no mark) = full 24 h; then incremental from the last success − 30 min; full again after 6 h", () => {
    const c = cfg();
    expect(collectWindow("slack", c, NOW)).toEqual({ full: true, since: NOW - 24 * H, reason: "first" });
    historyUpsert({ ...empty(), slack: slackBlock() }, ["slack"], c, { now: NOW }); // creates the file
    noteCollected("slack", NOW, true);
    const w = collectWindow("slack", c, NOW + 10 * 60_000);
    expect(w).toEqual({ full: false, since: NOW - 30 * 60_000, reason: "incremental" });
    noteCollected("slack", NOW + 10 * 60_000, false);
    expect(collectWindow("slack", c, NOW + 20 * 60_000).since).toBe(NOW + 10 * 60_000 - 30 * 60_000);
    expect(collectWindow("slack", c, NOW + 6 * H)).toMatchObject({ full: true, reason: "rescan", since: NOW + 6 * H - 24 * H });
  });
  it("never reaches back past the full window; history off / keep 0 = always full", () => {
    historyUpsert({ ...empty(), slack: slackBlock() }, ["slack"], cfg(), { now: NOW });
    noteCollected("slack", NOW - 30 * H, true);
    // last success 30h ago but the full search was also 30h ago → rescan
    expect(collectWindow("slack", cfg(), NOW).full).toBe(true);
    const meta = { v: 1 as const, last_prune_day: null, collect: { slack: { last_ok_at: NOW - 30 * H, last_full_at: NOW - H } } };
    expect(collectWindow("slack", cfg(), NOW, meta, true)).toEqual({ full: false, since: NOW - 24 * H, reason: "incremental" });
    expect(collectWindow("slack", cfg({ history: normalizeHistory({ enabled: false }) }), NOW, meta, true).reason).toBe("off");
    expect(collectWindow("mail", cfg({ history: normalizeHistory({ keep_days: { mail: 0 } }) }), NOW, meta, true)).toEqual({ full: true, since: NOW - 3 * D, reason: "off" });
  });
  it("gmailAfter: the date at UTC−8, never after `since`", () => {
    expect(gmailAfter(Date.parse("2026-11-08T03:00:00Z"))).toBe("2026/11/07");
    expect(gmailAfter(Date.parse("2026-11-08T09:00:00Z"))).toBe("2026/11/08");
  });
});
