/**
 * Incremental collection (src/agenda.ts + src/history.ts): the phase-1 prompt's windows (Slack `after`, ack `after`,
 * mail `after:`), the extra list keys (mine / replied / acked_urls), and the NED_NO_LLM stub path recording history +
 * the window anchors. Temp NED_HOME (test/setup.ts), never claude.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { buildListsPrompt, listExtras, listWindows, refreshAgenda } from "../src/agenda.js";
import { DEFAULT_CONFIG, HISTORY_SOURCES, loadConfig, normalizeFilters, normalizeHistory, type NedConfig } from "../src/config.js";
import { HISTORY_META_PATH, collectWindow, historyFile, historyStatus, readHistory, readHistoryMeta } from "../src/history.js";
import { AGENDA_PATH, CONFIG_PATH, NED_HOME } from "../src/paths.js";

const H = 3600_000;
const NOW = new Date("2026-11-08T03:00:00.000Z");
const cfg = (over: Partial<NedConfig> = {}): NedConfig => ({ ...DEFAULT_CONFIG, ...over });
const sec = (ms: number) => String(Math.floor(ms / 1000));

function wipe(): void {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
  fs.rmSync(HISTORY_META_PATH, { force: true });
  fs.rmSync(AGENDA_PATH, { force: true });
}
beforeEach(wipe);
afterEach(() => { delete process.env.NED_NO_LLM_AGENDA; });

describe("buildListsPrompt windows", () => {
  it("no window = the full window, no placeholder left", () => {
    const p = buildListsPrompt(cfg(), ["slack", "mail"], NOW);
    expect(p).not.toMatch(/\{\{/);
    expect(p).toContain(`after: "${sec(NOW.getTime() - 24 * H)}"`);
    expect(p).toContain("## slack — 최근 24시간, 나에게 온 것");
    expect(p).toContain("in:inbox newer_than:3d -category:promotions");
    expect(p).toContain("in:inbox is:unread newer_than:2d");
    expect(p).not.toContain("증분");
    expect(p).toContain('"mine":[]');
    expect(p).toContain('"replied":[]');
  });
  it("incremental: Slack after = window start, ack after reaches the oldest open ask, mail after:date, notes", () => {
    const since = NOW.getTime() - 40 * 60_000, ack = NOW.getTime() - 20 * H;
    const c = cfg({ filters: normalizeFilters({ slack: { watch_channels: ["ops"] } }) });
    const p = buildListsPrompt(c, ["slack", "mail"], NOW, undefined, {
      slack: { full: false, since, reason: "incremental" },
      mail: { full: false, since: NOW.getTime() - 40 * 60_000, reason: "incremental" },
      ackSince: ack,
      openAsks: 2,
      watchPrev: { "#ops": "배포 3시로 확정" },
    });
    expect(p).not.toMatch(/\{\{/);
    expect(p).toContain(`after: "${sec(since)}"`);
    expect(p).toContain(`\`after: "${sec(ack)}"\``); // the ack-emoji search
    expect(p).toContain("지난 수집 이후 나에게 온 것 (증분)");
    expect(p).toContain('새 것이 없으면 `"items":[]`, `"all":[]` 로 바로 끝낸다');
    expect(p).toContain("열린 항목이 2건 있으니 후보가 없어도 한다");
    expect(p).toContain('#ops 이전 요약: "배포 3시로 확정"');
    expect(p).toContain("in:inbox after:2026/11/07 -category:promotions");
    expect(p).toContain("in:inbox is:unread newer_than:2d"); // the unread count stays whole
  });
  it("a full (rescan) window reads like the old prompt", () => {
    const p = buildListsPrompt(cfg(), ["slack", "mail"], NOW, undefined, { slack: { full: true, since: NOW.getTime() - 24 * H, reason: "rescan" }, mail: { full: true, since: 0, reason: "rescan" } });
    expect(p).toBe(buildListsPrompt(cfg(), ["slack", "mail"], NOW));
  });
});

describe("history.collect.slack_hours (전체 재검색 창)", () => {
  it("collectWindow's full window and the prompt follow the setting; history off too; status reports it", () => {
    const c96 = cfg({ history: normalizeHistory({ collect: { slack_hours: 96 } }) });
    const now = NOW.getTime();
    expect(collectWindow("slack", c96, now)).toEqual({ full: true, since: now - 96 * H, reason: "first" });
    expect(collectWindow("slack", cfg({ history: normalizeHistory({ enabled: false, collect: { slack_hours: 48 } }) }), now)).toMatchObject({ full: true, since: now - 48 * H, reason: "off" });
    expect(collectWindow("mail", c96, now).since).toBe(now - 72 * H); // mail unchanged (3 d)
    const p = buildListsPrompt(c96, ["slack"], NOW, undefined, listWindows(c96, ["slack"], now));
    expect(p).toContain("## slack — 최근 96시간, 나에게 온 것");
    expect(p).toContain(`after: "${sec(now - 96 * H)}"`);
    // no window passed → still the configured full window
    expect(buildListsPrompt(c96, ["slack"], NOW)).toContain(`after: "${sec(now - 96 * H)}"`);
    expect(historyStatus(c96, now).collect.slack).toMatchObject({ full_hours: 96, next: { full: true, since: now - 96 * H } });
  });
});

describe("listExtras", () => {
  it("mine / replied as strings, acked_urls → slackUrlKey set", () => {
    const x = listExtras({ slack: { mine: ["https://x.slack.com/archives/D1/p1730000000000100", 3, ""], acked_urls: ["https://X.slack.com/archives/C1/p1730000000000200?thread_ts=1.2"] }, mail: { replied: ["t1", null] } });
    expect(x.mine).toEqual(["https://x.slack.com/archives/D1/p1730000000000100"]);
    expect([...x.acked!]).toEqual(["x.slack.com/archives/C1/p1730000000000200"]);
    expect(x.replied).toEqual(["t1"]);
    expect(listExtras(null)).toEqual({ mine: [], acked: new Set(), replied: [] });
  });
});

describe("stub refresh records history + window anchors", () => {
  const fixture = (data: Record<string, unknown>) => {
    const f = path.join(NED_HOME, `fx-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(f, JSON.stringify(data));
    process.env.NED_NO_LLM_AGENDA = f;
  };
  const writeCfg = (extra: Record<string, unknown> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { gmail: true, slack: true, jira: true, github: false, sentry: false, calendar: false }, ...extra }));
  const url = (t: number) => `https://x.slack.com/archives/C1/p${Math.floor(t / 1000)}000100`;

  it("first run full → history + meta written; the next window is incremental from that run − 30 min", async () => {
    writeCfg();
    const t = Date.now() - H;
    fixture({
      slack: { summary: "", items: [{ channel: "#a", from: "kim", text: "리뷰?", url: url(t), ts: new Date(t).toISOString(), reason: "mention" }], all: [] },
      mail: { summary: "", unread: 1, items: [], all: [{ id: "th1", from: "lee", subject: "안녕", ts: new Date(t).toISOString(), unread: true }] },
      jira: [{ key: "A-1", title: "x", status: "To Do", priority: "", due: null, url: "", updated: "" }],
    });
    const before = Date.now();
    await refreshAgenda(loadConfig());
    expect(readHistory("slack").map((r) => r.key)).toEqual([url(t).replace("https://", "")]);
    expect(readHistory("mail")[0]).toMatchObject({ key: "th1", state: { unread: true, needs_action: false } });
    expect(readHistory("jira")[0]).toMatchObject({ key: "A-1", state: { open: true } });
    const m = readHistoryMeta().collect;
    expect(m.slack!.last_ok_at).toBeGreaterThanOrEqual(before);
    expect(m.slack!.last_full_at).toBe(m.slack!.last_ok_at);
    const w = listWindows(loadConfig(), ["slack", "mail"], Date.now());
    expect(w.slack).toMatchObject({ full: false, reason: "incremental", since: m.slack!.last_ok_at - 30 * 60_000 });
    expect(w.mail!.full).toBe(false);
    expect(w.openAsks).toBe(1);
  });
  it("history.enabled=false: nothing recorded, every window full (the old behaviour)", async () => {
    writeCfg({ history: { enabled: false } });
    fixture({ slack: { summary: "", items: [], all: [] }, mail: { summary: "", unread: 0, items: [], all: [] } });
    await refreshAgenda(loadConfig());
    await refreshAgenda(loadConfig());
    expect(fs.existsSync(historyFile("slack"))).toBe(false);
    expect(fs.existsSync(HISTORY_META_PATH)).toBe(false);
    expect(listWindows(loadConfig(), ["slack"], Date.now()).slack).toMatchObject({ full: true, reason: "off" });
  });
});
