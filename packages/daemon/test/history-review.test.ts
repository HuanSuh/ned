/**
 * Review fixes on the 수집 이력: the window anchor only moves on a real collection (H1), acks on remembered records (H2),
 * a failed history write falls back to the run's list (M1), a corrupt file is moved aside (M2), phase 2 re-signs the list
 * (M4), an empty incremental answer keeps the summary (L1), excluded channels stay out of /api/history and search (L2).
 * Temp NED_HOME, NED_NO_LLM fixtures.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { readAgenda, refreshAgenda, sourceSignature, type SlackBlock } from "../src/agenda.js";
import { mergeThreads } from "../src/agenda-context.js";
import { DEFAULT_CONFIG, HISTORY_SOURCES, loadConfig, normalizeFilters, type NedConfig } from "../src/config.js";
import { HISTORY_DIR, HISTORY_META_PATH, collectWindow, historyFile, queryHistory, readHistory, readHistoryMeta, slackView, upsertSlack, writeHistory, type SlackRec } from "../src/history.js";
import { AGENDA_PATH, CONFIG_PATH, NED_HOME } from "../src/paths.js";
import { search } from "../src/search.js";

const H = 3600_000;
const iso = (t: number) => new Date(t).toISOString();
const url = (ch: string, t: number) => `https://x.slack.com/archives/${ch}/p${Math.floor(t / 1000)}000100`;
const cfg = (over: Partial<NedConfig> = {}): NedConfig => ({ ...DEFAULT_CONFIG, ...over });
const blank = (): SlackBlock => ({ summary: "", items: [], all: [], watch: [] });

function wipe(): void {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
  for (const f of [HISTORY_META_PATH, AGENDA_PATH]) fs.rmSync(f, { force: true });
  for (const f of fs.existsSync(HISTORY_DIR) ? fs.readdirSync(HISTORY_DIR) : []) if (/corrupt|ned-tmp/.test(f)) fs.rmSync(path.join(HISTORY_DIR, f), { recursive: true, force: true });
}
beforeEach(wipe);
afterEach(() => { delete process.env.NED_NO_LLM_AGENDA; delete process.env.NED_NO_LLM_THREADS; });

const fixture = (data: Record<string, unknown>) => {
  const f = path.join(NED_HOME, `fx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify(data));
  process.env.NED_NO_LLM_AGENDA = f;
};
const writeCfg = (extra: Record<string, unknown> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { gmail: true, slack: true, jira: false, github: false, sentry: false, calendar: false }, ...extra }));
const ask = (u: string, at: number) => ({ channel: "#a", from: "kim", text: "리뷰?", url: u, ts: iso(at), reason: "mention" });

describe("H1: the incremental anchor moves only on a real collection", () => {
  it("empty incremental answer / missing key keep last_ok_at; a missing key records nothing; rows move it", async () => {
    writeCfg();
    const at = Date.now() - H;
    fixture({ slack: { summary: "", items: [ask(url("C1", at), at)], all: [] }, mail: { summary: "", unread: 1, items: [], all: [{ id: "t1", from: "a", subject: "s", ts: iso(at), unread: true }] } });
    await refreshAgenda(loadConfig());
    const m0 = readHistoryMeta().collect;
    expect(m0.slack?.last_ok_at).toBeTruthy();

    fixture({ slack: { summary: "", items: [], all: [] }, mail: { summary: "", unread: 0, items: [], all: [] } }); // incremental, nothing
    await refreshAgenda(loadConfig());
    expect(readHistoryMeta().collect).toEqual(m0);
    expect(readHistory("mail")[0].state.unread).toBe(true); // an empty incremental answer doesn't mark mail read either

    fixture({}); // the answer had no slack / mail key at all (connector not attached yet)
    const before = fs.readFileSync(historyFile("slack"), "utf8");
    await refreshAgenda(loadConfig());
    expect(readHistoryMeta().collect).toEqual(m0);
    expect(fs.readFileSync(historyFile("slack"), "utf8")).toBe(before);
    expect(readAgenda().slack!.items).toHaveLength(1); // the card still shows the history

    const t2 = Date.now() - 60_000;
    fixture({ slack: { summary: "", items: [], all: [{ ...ask(url("C2", t2), t2), answered: false }] }, mail: { summary: "", unread: 0, items: [], all: [] } });
    await refreshAgenda(loadConfig());
    expect(readHistoryMeta().collect.slack!.last_ok_at).toBeGreaterThan(m0.slack!.last_ok_at);
    expect(readHistoryMeta().collect.mail).toEqual(m0.mail); // mail still empty
  });
});

describe("H2: ack emoji on a remembered record", () => {
  it("a channel / thread record outside this run's results gets acked", () => {
    const m = new Map<string, SlackRec>();
    const t = Date.now() - 3 * H, u = url("C7", t);
    upsertSlack(m, { ...blank(), items: [ask(u, t) as never] }, { now: t + H });
    upsertSlack(m, blank(), { now: Date.now(), acked: new Set([u.replace("https://", "")]) });
    expect([...m.values()][0].state).toMatchObject({ acked: true, need: true });
    expect(slackView(cfg(), blank(), null, { now: Date.now(), full: false }, [...m.values()]).items).toEqual([]);
  });
});

describe("M1: a failed history write falls back to the run's list", () => {
  it("agenda.json gets this run's list, the anchor stays", async () => {
    writeCfg();
    const at = Date.now() - H;
    fixture({ slack: { summary: "", items: [ask(url("C1", at), at)], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    const m0 = readHistoryMeta().collect.slack;
    const blocker = path.join(HISTORY_DIR, `.slack.json.ned-tmp-${process.pid}`);
    fs.mkdirSync(blocker, { recursive: true }); // the temp file can't be written
    try {
      const t2 = Date.now() - 60_000;
      fixture({ slack: { summary: "새 거", items: [ask(url("C2", t2), t2)], all: [] } });
      await refreshAgenda(loadConfig(), { sources: ["slack"] });
      expect(readAgenda().slack!.items.map((x) => x.url)).toEqual([url("C2", t2)]); // fresh list, not the view
      expect(readHistoryMeta().collect.slack).toEqual(m0);
    } finally {
      fs.rmSync(blocker, { recursive: true, force: true });
    }
  });
});

describe("M2: corrupt history file", () => {
  it("moved aside as <src>.json.corrupt-<ts>, read as empty, the next window is full (first)", () => {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.writeFileSync(historyFile("slack"), "{ not json");
    const now = Date.now();
    const meta = { v: 1 as const, last_prune_day: null, collect: { slack: { last_ok_at: now - 600_000, last_full_at: now - H } } };
    expect(collectWindow("slack", cfg(), now, meta)).toMatchObject({ full: true, reason: "first" });
    expect(fs.existsSync(historyFile("slack"))).toBe(false);
    expect(fs.readdirSync(HISTORY_DIR).some((f) => /^slack\.json\.corrupt-\d+$/.test(f))).toBe(true);
    expect(readHistory("slack")).toEqual([]);
  });
});

describe("M4: phase 2 answering re-signs the list", () => {
  it("the stored signature equals the view's after applyAnswered; the next empty run is unchanged", async () => {
    writeCfg();
    const at = Date.now() - 2 * H, u = url("C1", at);
    fixture({ slack: { summary: "", items: [ask(u, at)], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    const th = readAgenda().slack!.threads!.find((x) => x.channel_id === "C1")!;
    mergeThreads([{ key: th.key, messages: [{ from: "kim", ts: th.thread_ts, text: "리뷰?" }, { from: "나", ts: `${Math.floor(Date.now() / 1000)}.000500`, text: "봤어요" }] }]);
    const a = readAgenda();
    expect(a.slack!.items).toEqual([]);
    expect(a.sources_status!.slack!.signature).toBe(sourceSignature("slack", a));
    fixture({ slack: { summary: "", items: [], all: [] } });
    await refreshAgenda(loadConfig(), { sources: ["slack"] });
    expect(readAgenda().sources_status!.slack!.unchanged).toBe(true);
  });
});

describe("L1: an empty incremental answer keeps the summary", () => {
  it("'새 것 없음' with no rows doesn't replace the open items' summary; a full run's does", () => {
    const now = Date.now(), t = now - H;
    const recs = [{ key: "k", source: "slack" as const, first_seen: t, last_seen: t, ts: iso(t), state: { reason: "mention" as const, need: true, answered: false, acked: false, count: 1 }, item: { channel: "#a", from: "kim", text: "q", url: url("C1", t), ts: iso(t) } }];
    const prev: SlackBlock = { ...blank(), summary: "멘션 1건 기다려" };
    const fresh: SlackBlock = { ...blank(), summary: "새 것 없음" };
    expect(slackView(cfg(), fresh, prev, { now, full: false }, recs).summary).toBe("멘션 1건 기다려");
    expect(slackView(cfg(), fresh, prev, { now, full: true }, recs).summary).toBe("새 것 없음");
  });
});

describe("L2: excluded channels stay out of the history list and search", () => {
  it("/api/history (queryHistory) and search skip filters.slack.exclude_channels", () => {
    const now = Date.now(), t = now - 5 * 24 * H;
    const rec = (ch: string, text: string) => ({ key: `${ch}-${text}`, source: "slack" as const, first_seen: t, last_seen: t, ts: iso(t), state: { reason: "mention", need: false, answered: false, acked: false, count: 1 }, item: { channel: ch, from: "kim", text, url: "" } });
    writeHistory("slack", [rec("#random", "잡담 회고"), rec("#dev", "배포 회고")]);
    const c = cfg({ filters: normalizeFilters({ slack: { exclude_channels: ["random"] } }) });
    const agenda = { updated_at: now, cost_usd: 0, calendar: [], jira: [], github: [], mail: null, slack: null };
    expect(queryHistory(c, agenda, { source: "slack", days: 30 }).items.map((x) => x.channel)).toEqual(["#dev"]);
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", filters: { slack: { exclude_channels: ["random"] } } }));
    expect(search("회고").filter((h) => h.type === "slack").map((h) => h.title)).toEqual(["배포 회고"]);
  });
});
