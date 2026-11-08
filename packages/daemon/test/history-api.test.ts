/**
 * GET /api/history (source / days / q / channel filters, newest first, `current`) and GET /api/history/status, plus the
 * dashboard's history rows (public/app/features/histrows.js). No port is bound (serve is mocked), temp NED_HOME.
 */
import fs from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { HISTORY_SOURCES, loadConfig } = await import("../src/config.js");
const { AGENDA_PATH, CONFIG_PATH } = await import("../src/paths.js");
const { HISTORY_META_PATH, historyFile, writeHistory } = await import("../src/history.js");
const { writeJsonAtomic } = await import("../src/paths.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { dayHead, histHtml } = await import("../public/app/features/histrows.js");

const H = 3600_000, D = 24 * H;
const get = async (p: string) => {
  const r = await Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`)));
  return { status: r.status, body: (await r.json()) as any };
};
const iso = (t: number) => new Date(t).toISOString();
const rec = (source: string, key: string, t: number, state: Record<string, unknown>, item: Record<string, unknown>) => ({ key, source, first_seen: t, last_seen: t, ts: iso(t), state, item });

beforeAll(() => {
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
  startServer(() => loadConfig());
});
beforeEach(() => {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
  fs.rmSync(HISTORY_META_PATH, { force: true });
  fs.rmSync(AGENDA_PATH, { force: true });
});

describe("GET /api/history", () => {
  it("400 without a known source", async () => {
    expect((await get("/api/history")).status).toBe(400);
    expect((await get("/api/history?source=sentry")).status).toBe(400);
  });
  it("slack: days window, newest first, current = inside the display window (24 h), q and channel filters", async () => {
    const now = Date.now();
    writeHistory("slack", [
      rec("slack", "a", now - H, { reason: "mention", need: true, answered: false, acked: false, count: 1 }, { channel: "#dev", from: "kim", text: "배포 리뷰 부탁", url: "https://x.slack.com/archives/C1/p1" }),
      rec("slack", "b", now - 3 * D, { reason: "dm", need: false, answered: true, acked: false, count: 1 }, { channel: "DM", from: "lee", text: "점심?", url: "https://x.slack.com/archives/D1/p2" }),
      rec("slack", "c", now - 10 * D, { reason: "mention", need: false, answered: false, acked: false, count: 1 }, { channel: "#dev", from: "park", text: "오래된 것", url: "" }),
      rec("slack", "w", now - 2 * H, { need: false, answered: false, acked: false, count: 1 }, { channel: "#ops", from: "choi", text: "장애 공지", url: "", watch: { channel: "#ops", hl: true, needs_me: false, why: "", text: "장애" } }),
    ]);
    const r = await get("/api/history?source=slack&days=7");
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => [x.key, x.current])).toEqual([["a", true], ["w", true], ["b", false]]);
    expect(r.body.items[0]).toMatchObject({ title: "배포 리뷰 부탁", detail: "#dev · kim", url: "https://x.slack.com/archives/C1/p1" });
    expect((await get("/api/history?source=slack&days=30")).body.items).toHaveLength(4);
    expect((await get(`/api/history?source=slack&days=30&q=${encodeURIComponent("배포 kim")}`)).body.items.map((x: any) => x.key)).toEqual(["a"]);
    expect((await get("/api/history?source=slack&days=30&channel=%23ops")).body.items.map((x: any) => x.key)).toEqual(["w"]);
  });
  it("jira: current = still open and in the agenda's list", async () => {
    const now = Date.now();
    writeHistory("jira", [rec("jira", "A-1", now - H, { open: true }, { key: "A-1", title: "열림", url: "" }), rec("jira", "A-2", now - 2 * H, { open: false }, { key: "A-2", title: "빠짐", url: "" })]);
    writeJsonAtomic(AGENDA_PATH, { updated_at: now, cost_usd: 0, calendar: [], github: [], mail: null, slack: null, jira: [{ key: "A-1", title: "열림", status: "", priority: "", due: null, url: "", updated: "" }] });
    const r = await get("/api/history?source=jira");
    expect(r.body.days).toBe(7);
    expect(r.body.items.map((x: any) => [x.key, x.current, x.detail])).toEqual([["A-1", true, "A-1"], ["A-2", false, "A-2 · 목록에서 빠짐"]]);
  });
  it("status: per source count / days / bytes, the collect anchors and the next window", async () => {
    writeHistory("mail", [rec("mail", "t1", Date.now() - D, { unread: true, needs_action: false }, { id: "t1", subject: "s" })]);
    const r = await get("/api/history/status");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.sources.mail).toMatchObject({ count: 1, recording: true, keep_days: 30 });
    expect(r.body.sources.mail.bytes).toBeGreaterThan(0);
    expect(r.body.sources.slack.count).toBe(0);
    expect(r.body.collect.slack.next).toMatchObject({ full: true, reason: "first" });
  });
});

describe("history rows (histrows.js)", () => {
  const today = new Date(2026, 10, 8).getTime();
  it("day separators, current mark, state chips", () => {
    const at = (d: number, h: number) => iso(new Date(2026, 10, d, h).getTime());
    const html = histHtml([
      { source: "slack", ts: at(8, 9), title: "a", detail: "#dev · kim", url: "https://x/1", current: true, state: { need: true }, item: {} },
      { source: "slack", ts: at(7, 9), title: "b <x>", detail: "", url: "", current: false, state: { answered: true }, item: {} },
      { source: "jira", ts: at(4, 9), title: "c", detail: "", url: "", current: false, state: { open: false }, item: {} },
    ], 5, today);
    expect(html.match(/class="hday"/g)).toHaveLength(3);
    expect(html).toContain(">오늘<");
    expect(html).toContain(">어제<");
    expect(html).toContain("11/4 (수)");
    expect(html).toContain('class="ti hist cur"');
    expect(html).toContain("답 필요");
    expect(html).toContain("답함");
    expect(html).toContain("목록에서 빠짐");
    expect(html).toContain("b &lt;x&gt;");
    expect(html).toContain("전체 5건");
    expect(histHtml([], 0, today)).toContain("이 기간에 모은 항목 없음");
    expect(dayHead(new Date(2026, 10, 8, 23).getTime(), today)).toBe("오늘");
  });
});

afterAll(() => {
  for (const s of HISTORY_SOURCES) fs.rmSync(historyFile(s), { force: true });
});
