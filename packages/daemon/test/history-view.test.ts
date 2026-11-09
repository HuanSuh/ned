/**
 * 표시 원천 = 이력 (src/history.ts slackView / mailView / finalizeSlackView + agenda.ts mergeSources): the display
 * window, answered / acked / 확인 완료, DM collapse, the list signature computed from the view, phase-2 answers, and
 * history.enabled=false keeping the old snapshot behaviour. Temp NED_HOME, NED_NO_LLM fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildListsPrompt, listWindows, readAgenda, refreshAgenda, type SlackBlock } from "../src/agenda.js";
import { mergeThreads } from "../src/agenda-context.js";
import { DEFAULT_CONFIG, HISTORY_SOURCES, loadConfig, normalizeFilters, normalizeHistory, type NedConfig } from "../src/config.js";
import { HISTORY_META_PATH, finalizeSlackView, historyFile, mailView, openSlack, queryHistory, readHistory, slackView, type MailRec, type SlackRec } from "../src/history.js";
import { AGENDA_PATH, CONFIG_PATH, NED_HOME, REVIEWED_PATH } from "../src/paths.js";
import { threadCandidates } from "../src/slack-threads.js";

const H = 3600_000, D = 24 * H;
const NOW = Date.parse("2026-11-08T03:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
const cfg = (over: Partial<NedConfig> = {}): NedConfig => ({ ...DEFAULT_CONFIG, ...over });
const url = (ch: string, t: number) => `https://x.slack.com/archives/${ch}/p${Math.floor(t / 1000)}000100`;
const blank = (): SlackBlock => ({ summary: "", items: [], all: [], watch: [] });

const srec = (ch: string, t: number, state: Partial<SlackRec["state"]>, over: Partial<SlackRec["item"]> = {}): SlackRec => ({
  key: url(ch, t).replace("https://", ""), source: "slack", first_seen: t, last_seen: t, ts: iso(t),
  state: { need: false, answered: false, acked: false, count: 1, reason: "mention", ...state },
  item: { channel: ch.startsWith("D") ? "DM" : `#${ch.toLowerCase()}`, from: "kim", text: `msg ${ch}`, url: url(ch, t), ts: iso(t), ...over },
});

function wipe(): void {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
  for (const f of [HISTORY_META_PATH, AGENDA_PATH, REVIEWED_PATH]) fs.rmSync(f, { force: true });
}
beforeEach(wipe);
afterEach(() => { delete process.env.NED_NO_LLM_AGENDA; delete process.env.NED_NO_LLM_THREADS; });

describe("slackView", () => {
  it("display window, picked & open → items; all = every row (answered / acked marked); excluded channels dropped", () => {
    const recs = [
      srec("C1", NOW - H, { need: true, rank: 0, rank_at: NOW }),
      srec("C2", NOW - 2 * H, { need: true, answered: true }),
      srec("C3", NOW - 3 * H, { need: true, acked: true }),
      srec("C4", NOW - 30 * H, { need: true }), // outside 24 h
      srec("C5", NOW - 4 * H, { need: false }),
      srec("C6", NOW - H, { need: true }, { channel: "#random" }),
    ];
    const c = cfg({ filters: normalizeFilters({ slack: { exclude_channels: ["random"] } }) });
    const v = slackView(c, blank(), null, { now: NOW, full: false }, recs);
    // an open ask stays in items whatever its age (C4, 30 h) — all stays the display window
    expect(v.items.map((x) => x.url.split("/")[4])).toEqual(["C1", "C4"]);
    expect(v.all.map((x) => [x.url.split("/")[4], x.answered])).toEqual([["C1", false], ["C2", true], ["C3", true], ["C5", false]]);
    // a longer display window brings the 30 h one into all too
    const v48 = slackView(cfg({ history: normalizeHistory({ display: { slack_hours: 48 } }) }), blank(), null, { now: NOW, full: false }, recs);
    expect(v48.items.map((x) => x.url.split("/")[4])).toEqual(["C1", "C6", "C4"]); // the picked-this-run one first, then newest
    expect(v48.all.map((x) => x.url.split("/")[4])).toContain("C4");
  });
  it("DM asks collapse to one row per conversation with the summed count; items keep the model's order", () => {
    const recs = [
      srec("D1", NOW - H, { reason: "dm", need: true, count: 2, rank: 1, rank_at: NOW }),
      srec("D1", NOW - 5 * H, { reason: "dm", need: true, rank: 0, rank_at: NOW - D }),
      srec("C1", NOW - 3 * H, { need: true, rank: 0, rank_at: NOW }),
    ];
    const v = slackView(cfg(), blank(), null, { now: NOW, full: false }, recs);
    expect(v.items.map((x) => [x.url.split("/")[4], x.count])).toEqual([["C1", undefined], ["D1", 3]]);
  });
  it("incremental run: keeps the previous summaries (card / 팔로업) when the run had nothing new", () => {
    const c = cfg({ filters: normalizeFilters({ slack: { watch_channels: ["ops"] } }) });
    const prev: SlackBlock = { summary: "DM 1건", items: [], all: [], watch: [{ channel: "#ops", summary: "배포 확정", highlights: [], recent: [] }] };
    const recs = [srec("C1", NOW - H, { need: true }), srec("C9", NOW - 2 * H, {}, { channel: "#ops", watch: { channel: "#ops", hl: true, needs_me: true, why: "질문", text: "배포 언제?" } })];
    recs[1].state.reason = undefined;
    const fresh: SlackBlock = { ...blank(), watch: [{ channel: "#ops", summary: "", highlights: [], recent: [] }] };
    const v = slackView(c, fresh, prev, { now: NOW, full: false }, recs);
    expect(v.summary).toBe("DM 1건");
    expect(v.watch).toHaveLength(1);
    expect(v.watch[0]).toMatchObject({ channel: "#ops", summary: "배포 확정", highlights: [{ text: "배포 언제?", needs_me: true, reason: "질문" }] });
    expect(v.all.map((x) => x.url)).toEqual([url("C1", NOW - H)]); // a 팔로업-only row isn't a mention / DM row
    // a full run's empty summary means the channel went quiet
    expect(slackView(c, fresh, prev, { now: NOW, full: true }, recs).watch[0].summary).toBe("");
  });
  it("finalizeSlackView drops 확인 완료 rows (same rule as the dashboard, thread-aware key) and caps at 10", () => {
    const recs = Array.from({ length: 12 }, (_, i) => srec(`C${i}`, NOW - (i + 1) * 60_000, { need: true, rank: i, rank_at: NOW }));
    const v = slackView(cfg(), blank(), null, { now: NOW, full: false }, recs);
    const m = /archives\/(C0)\/p(\d{10})(\d{6})/.exec(v.items[0].url)!;
    const m1 = /archives\/(C1)\/p(\d{10})(\d{6})/.exec(v.items[1].url)!;
    (v.items[1] as { thread?: { last_reply_ts: string } }).thread = { last_reply_ts: "1999999999.000100" } as never;
    finalizeSlackView(v, { [`slack:C0:${m[2]}.${m[3]}`]: NOW, [`slack:C1:${m1[2]}.${m1[3]}`]: NOW });
    // C0 reviewed → out; C1's mark predates its newest reply (key carries @last_reply_ts) → stays
    expect(v.items.map((x) => x.url.split("/")[4])).toEqual(["C1", "C2", "C3", "C4", "C5", "C6", "C7", "C8", "C9", "C10"]);
  });
});

describe("open asks outside the display window (11/6 external mention case)", () => {
  const OLD = NOW - 3 * D;
  it("stay in items until ✓ / my reply / ack; all keeps the display window", () => {
    const recs = [srec("C7", OLD, { need: true, rank: 0, rank_at: OLD }), srec("C1", NOW - H, { need: true, rank: 0, rank_at: NOW })];
    const v = slackView(cfg(), blank(), null, { now: NOW, full: false }, recs);
    expect(v.items.map((x) => x.url.split("/")[4])).toEqual(["C1", "C7"]);
    expect(v.all.map((x) => x.url.split("/")[4])).toEqual(["C1"]);
    // ✓ 확인 완료 drops it
    const m = /archives\/C7\/p(\d{10})(\d{6})/.exec(url("C7", OLD))!;
    finalizeSlackView(v, { [`slack:C7:${m[1]}.${m[2]}`]: NOW });
    expect(v.items.map((x) => x.url.split("/")[4])).toEqual(["C1"]);
    // answered (my reply) / acked → gone
    for (const st of [{ answered: true }, { acked: true }]) {
      const r = [srec("C7", OLD, { need: true, ...st })];
      expect(slackView(cfg(), blank(), null, { now: NOW, full: false }, r).items).toEqual([]);
    }
    // an excluded channel stays out
    const ex = cfg({ filters: normalizeFilters({ slack: { exclude_channels: ["c7"] } }) });
    expect(slackView(ex, blank(), null, { now: NOW, full: false }, [srec("C7", OLD, { need: true })]).items).toEqual([]);
  });
  it("openSlack counts open asks of any age (oldest = the 3-day-old one), excluded channels left out", () => {
    const recs = [srec("C7", OLD, { need: true }), srec("C1", NOW - H, { need: true }), srec("C2", NOW - 5 * D, { need: true, answered: true }), srec("C3", NOW - 6 * D, { need: true }, { channel: "#random" })];
    const c = cfg({ filters: normalizeFilters({ slack: { exclude_channels: ["random"] } }) });
    expect(openSlack(c, NOW, { recs, marks: {} })).toEqual({ n: 2, oldest: OLD });
    expect(openSlack(cfg(), NOW, { recs: [], marks: {} })).toEqual({ n: 0, oldest: NOW });
    // within the ack lookback only: a 10-day-old open ask isn't counted (✓ / my reply release it)
    const ten = [srec("C8", NOW - 10 * D, { need: true })];
    expect(openSlack(cfg(), NOW, { recs: ten, marks: {} }).n).toBe(1);
    expect(openSlack(cfg(), NOW, { recs: ten, marks: {}, hours: 7 * 24 }).n).toBe(0);
  });
  it("all ⊇ in-window items by the record's time, not the item's raw ts", () => {
    const recs = [srec("C1", NOW - H, { need: true }, { ts: "어제쯤" }), srec("C2", NOW - 2 * H, { need: true })];
    const v = slackView(cfg({ agenda_all_limit: 1 }), blank(), null, { now: NOW, full: false }, recs);
    expect(v.all.map((x) => x.url.split("/")[4]).sort()).toEqual(["C1", "C2"]);
  });
  it("✓ 확인 완료 closes an old ask for openSlack too (base key or thread-aware key)", () => {
    const r = srec("C7", OLD, { need: true });
    const m = /archives\/C7\/p(\d{10})(\d{6})/.exec(r.item.url)!;
    const base = `slack:C7:${m[1]}.${m[2]}`;
    expect(openSlack(cfg(), NOW, { recs: [r], marks: {} }).n).toBe(1);
    expect(openSlack(cfg(), NOW, { recs: [r], marks: { [base]: NOW } }).n).toBe(0);
    expect(openSlack(cfg(), NOW, { recs: [r], marks: { [`${base}@1999999999.000100`]: NOW } }).n).toBe(0);
    expect(openSlack(cfg(), NOW, { recs: [r], marks: { [base]: OLD - D } }).n).toBe(1); // a mark older than the ask doesn't count
  });
});

describe("mailView", () => {
  const mrec = (id: string, t: number, state: Partial<MailRec["state"]>, reason?: "reply" | "approval"): MailRec => ({
    key: id, source: "mail", first_seen: t, last_seen: t, ts: iso(t),
    state: { unread: false, needs_action: false, ...state }, item: { id, from: "lee", subject: `s ${id}`, snippet: "", why: "", reason, url: `https://mail/${id}` },
  });
  it("needs_action & not 확인 완료 → items; all = display window newest first with unread; unread count from the run", () => {
    const recs = [mrec("a", NOW - H, { needs_action: true, unread: true }, "reply"), mrec("b", NOW - 2 * H, { needs_action: true }), mrec("c", NOW - 5 * D, { needs_action: true }), mrec("d", NOW - 3 * H, {})];
    const fresh = { summary: "", unread: 7, unread_capped: false, items: [], all: [] };
    const v = mailView(cfg(), fresh, null, { now: NOW, full: false }, { "mail:b": NOW }, recs);
    expect(v.items.map((x) => [x.id, x.reason])).toEqual([["a", "reply"]]);
    expect(v.all.map((x) => [x.id, x.unread])).toEqual([["a", true], ["b", false], ["d", false]]);
    expect(v.unread).toBe(7);
  });
});

describe("mergeSources → agenda.json from the history", () => {
  const fixture = (data: Record<string, unknown>) => {
    const f = path.join(NED_HOME, `fx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(data));
    process.env.NED_NO_LLM_AGENDA = f;
  };
  const writeCfg = (extra: Record<string, unknown> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { gmail: true, slack: true, jira: false, github: false, sentry: false, calendar: false }, ...extra }));
  const t = () => Date.now() - 2 * H;
  const ask = (u: string, at: number) => ({ channel: "#a", from: "kim", text: "리뷰?", url: u, ts: iso(at), reason: "mention" });

  it("an empty incremental run keeps the open ask on the card, and the signature (computed on the view) is unchanged", async () => {
    writeCfg();
    const at = t(), u = url("C1", at);
    fixture({ slack: { summary: "답할 거 1건", items: [ask(u, at)], all: [] }, mail: { summary: "", unread: 0, items: [{ id: "m1", from: "lee", subject: "결재", snippet: "", received: iso(at), reason: "approval", why: "결재 요청" }], all: [] } });
    await refreshAgenda(loadConfig());
    const a1 = readAgenda();
    expect(a1.slack!.items.map((x) => x.url)).toEqual([u]);
    expect(a1.mail!.items.map((x) => x.id)).toEqual(["m1"]);
    fixture({ slack: { summary: "", items: [], all: [] }, mail: { summary: "", unread: 0, items: [], all: [] } });
    await refreshAgenda(loadConfig()); // incremental now: nothing new
    const a2 = readAgenda();
    expect(a2.slack!.items.map((x) => x.url)).toEqual([u]);
    expect(a2.slack!.summary).toBe("답할 거 1건");
    expect(a2.mail!.items.map((x) => x.id)).toEqual(["m1"]);
    expect(a2.sources_status!.slack!.signature).toBe(a1.sources_status!.slack!.signature);
    expect(a2.sources_status!.slack!.unchanged).toBe(true);
    expect(a2.sources_status!.mail!.unchanged).toBe(true);
  });
  it("my reply in the next incremental run (mine) answers it: out of items, answered in all, signature changes", async () => {
    writeCfg();
    const at = t(), u = url("C1", at);
    fixture({ slack: { summary: "", items: [ask(u, at)], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    const sig = readAgenda().sources_status!.slack!.signature;
    fixture({ slack: { summary: "", items: [], all: [], mine: [`https://x.slack.com/archives/C1/p${Math.floor(Date.now() / 1000)}000100?thread_ts=${Math.floor(at / 1000)}.000100`] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    const a = readAgenda();
    expect(a.slack!.items).toEqual([]);
    expect(a.slack!.all.find((x) => x.url === u)?.answered).toBe(true);
    expect(a.sources_status!.slack!.signature).not.toBe(sig);
  });
  it("phase 2 seeing my thread reply answers the ask right away (mergeThreads hook)", async () => {
    writeCfg();
    const at = t(), u = url("C1", at);
    fixture({ slack: { summary: "", items: [ask(u, at)], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    const th = readAgenda().slack!.threads!.find((x) => x.channel_id === "C1")!;
    expect(th).toBeTruthy();
    const mine = `${Math.floor(Date.now() / 1000)}.000500`;
    mergeThreads([{ key: th.key, messages: [{ from: "kim", ts: th.thread_ts, text: "리뷰?" }, { from: "나", ts: mine, text: "봤어요" }] }]);
    expect(readAgenda().slack!.items).toEqual([]);
    expect(readHistory<SlackRec>("slack")[0].state.answered).toBe(true);
  });
  it("a 3-day-old open ask: kept on the card across runs, ack search reaches it, phase 2 still re-reads its thread, `mine` answers it", async () => {
    writeCfg();
    const old = Date.now() - 3 * D, u = url("C7", old);
    fixture({ slack: { summary: "", items: [{ ...ask(u, old), channel: "#project-x", from: "외부 김" }], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    fixture({ slack: { summary: "", items: [], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] }); // incremental, nothing new
    const a = readAgenda();
    expect(a.slack!.items.map((x) => x.url)).toEqual([u]);
    expect(a.slack!.all.map((x) => x.url)).not.toContain(u); // all = display window
    const w = listWindows(loadConfig(), ["slack"], Date.now());
    expect(w.openAsks).toBe(1);
    expect(w.ackSince).toBe(Date.parse(iso(old)));
    expect(buildListsPrompt(loadConfig(), ["slack"], new Date(), undefined, w)).toContain(`after: "${Math.floor(Date.parse(iso(old)) / 1000)}"`);
    // phase 2: the ask's thread is past THREAD_FOLLOW_HOURS but on the card → still a re-read candidate
    const th = a.slack!.threads!.find((x) => x.channel_id === "C7")!;
    expect(th.prio).toBe(0);
    const later = Date.now() + 7 * H; // past THREAD_RECHECK_MINUTES since any read the background pass did
    expect(threadCandidates(a.slack!.threads, 5, later).map((x) => x.key)).toContain(th.key);
    expect(threadCandidates([{ ...th, prio: 1 }], 5, later)).toEqual([]); // not on the card → past THREAD_FOLLOW_HOURS, dropped
    // my reply in that thread, seen by an incremental search (mine) → answered, off the card
    fixture({ slack: { summary: "", items: [], all: [], mine: [`https://x.slack.com/archives/C7/p${Math.floor(Date.now() / 1000)}000100?thread_ts=${Math.floor(old / 1000)}.000100`] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    expect(readAgenda().slack!.items).toEqual([]);
    expect(readHistory<SlackRec>("slack").find((r) => r.key === u.replace("https://", ""))!.state.answered).toBe(true);
  });
  it("✓ on a 3-day-old ask: off the card, openSlack 0, its thread no longer prio 0, /api/history current=false", async () => {
    writeCfg();
    const old = Date.now() - 3 * D, u = url("C7", old);
    fixture({ slack: { summary: "", items: [ask(u, old)], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    expect(readAgenda().slack!.threads!.find((x) => x.channel_id === "C7")!.prio).toBe(0);
    const m = /archives\/C7\/p(\d{10})(\d{6})/.exec(u)!;
    fs.writeFileSync(REVIEWED_PATH, JSON.stringify({ [`slack:C7:${m[1]}.${m[2]}`]: Date.now() }));
    fixture({ slack: { summary: "", items: [], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    const a = readAgenda();
    expect(a.slack!.items).toEqual([]);
    expect(openSlack(loadConfig(), Date.now()).n).toBe(0);
    expect(listWindows(loadConfig(), ["slack"], Date.now()).openAsks).toBeUndefined();
    const th = a.slack!.threads?.find((x) => x.channel_id === "C7");
    expect(th?.prio ?? 3).not.toBe(0);
    if (th) expect(threadCandidates([th], 5, Date.now() + 7 * H)).toEqual([]);
    const row = queryHistory(loadConfig(), a, { source: "slack", days: 30 }).items.find((x) => x.url === u)!;
    expect(row.current).toBe(false);
  });
  it("a 3-day-old open ask is answered when phase 2 sees my reply in its thread", async () => {
    writeCfg();
    const old = Date.now() - 3 * D, u = url("C7", old);
    fixture({ slack: { summary: "", items: [ask(u, old)], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    const th = readAgenda().slack!.threads!.find((x) => x.channel_id === "C7")!;
    mergeThreads([{ key: th.key, messages: [{ from: "kim", ts: th.thread_ts, text: "리뷰?" }, { from: "나", ts: `${Math.floor(Date.now() / 1000)}.000500`, text: "확인했어요" }] }]);
    expect(readAgenda().slack!.items).toEqual([]);
  });
  it("history.enabled=false: the card shows the latest list only (old behaviour)", async () => {
    writeCfg({ history: { enabled: false } });
    const at = t(), u = url("C1", at);
    fixture({ slack: { summary: "", items: [ask(u, at)], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    expect(readAgenda().slack!.items).toHaveLength(1);
    fixture({ slack: { summary: "", items: [], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    expect(readAgenda().slack!.items).toEqual([]);
  });
});
