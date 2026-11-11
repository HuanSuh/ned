/**
 * MCP 도구 핸들러 (src/mcp-tools.ts) — 픽스처 state/agenda 로 출력 검증: limit · clip · source 필터 · ✓ 반영,
 * 세션·브리핑·이력·피드, ned_mark_reviewed 의 400/404/200 (POST /api/attention/:id/review 와 같은 reviewItem).
 * 포트는 열지 않는다(순수 함수 + 임시 NED_HOME).
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";

const { DEFAULT_CONFIG } = await import("../src/config.js");
const { REVIEWED_PATH, STATE_PATH } = await import("../src/paths.js");
const { readReviewed } = await import("../src/state.js");
const { historyFile, writeHistory } = await import("../src/history.js");
const { MAX_ATTENTION, attentionRows, toolAttention, toolBriefing, toolFeed, toolHistory, toolMarkReviewed, toolSessions } = await import("../src/mcp-tools.js");
type Ctx = import("../src/mcp-tools.js").ToolCtx;

const NOW = Date.parse("2026-11-11T09:00:00Z");
const H = 3600_000;
const iso = (t: number) => new Date(t).toISOString();

function ctx(over: Partial<Ctx> = {}): Ctx {
  const cfg = structuredClone(DEFAULT_CONFIG);
  return {
    cfg,
    now: NOW,
    marks: {},
    briefings: [],
    state: {
      updated_at: NOW, daemon_pid: 1, last_briefing: null, last_heartbeat_at: null, next_heartbeat_at: null, quiet: false,
      persona: "ned", notifications: cfg.notifications, attention_open_count: 1,
      sessions: [
        { id: "aaaaaaaa-1111", cwd: "/w/app", worktree: "app", status: "waiting", since: NOW - 2 * H, last_event_ts: NOW - H, last_prompt: "x".repeat(500), last_summary: "권한 필요", subagents_active: 0, orca_worktree: null, alert_ts: NOW - H, is_worker: false },
        { id: "bbbbbbbb-2222", cwd: "/orca/workspaces/w1", worktree: "w1", status: "running", since: NOW - 3 * H, last_event_ts: NOW - 2 * H, last_prompt: null, last_summary: null, subagents_active: 1, orca_worktree: null, alert_ts: null, is_worker: true },
      ],
      attention: [
        { id: "session:aaaaaaaa-1111", kind: "session", title: "app 입력 대기", detail: "권한 필요", ts: NOW - H, source: "sessions" },
        { id: "b1:0", kind: "slack", title: "배포 질문", url: "https://x.slack.com/archives/C1/p1794193000000100", ts: NOW - 5 * H, source: "b1", reviewed_at: NOW - 4 * H },
      ],
    },
    agenda: {
      updated_at: NOW, cost_usd: 0,
      calendar: [
        { id: "e1", title: "주간 회의", start: iso(NOW + 2 * H), end: iso(NOW + 3 * H), all_day: false, location: "", url: "https://calendar.google.com/e1", meet_url: "", rsvp: "needsAction", attendees: 5 },
        { id: "e2", title: "수락한 회의", start: iso(NOW + 2 * H), end: iso(NOW + 3 * H), all_day: false, location: "", url: "https://calendar.google.com/e2", meet_url: "", rsvp: "accepted", attendees: 2 },
      ],
      jira: [{ key: "AB-1", title: "버그 " + "y".repeat(400), status: "In Progress", priority: "High", due: null, url: "https://j.example/browse/AB-1", updated: iso(NOW - 2 * H) }],
      github: [{ repo: "o/r", number: 7, title: "PR 리뷰", url: "https://github.com/o/r/pull/7", author: "kim", updated: iso(NOW - 3 * H), reason: "review_requested" }],
      mail: { summary: "", unread: 1, unread_capped: false, all: [], items: [{ id: "th1", from: "Lee", subject: "승인 요청", snippet: "", received: iso(NOW - 30 * 60_000), url: "https://mail.google.com/#inbox/th1", reason: "approval", why: "금요일까지" }] },
      slack: {
        summary: "", all: [], watch: [],
        items: [
          // same URL as the reviewed attention item → deduped (the attention row wins)
          { channel: "#dev", from: "Kim", text: "배포 질문", url: "https://x.slack.com/archives/C1/p1794193000000100", ts: iso(NOW - 5 * H), reason: "mention" },
          { channel: "#ops", from: "Park", text: "장애 확인 부탁", url: "https://x.slack.com/archives/C2/p1794194000000200", ts: iso(NOW - 4 * H), reason: "mention" },
        ],
      },
    },
    ...over,
  };
}

describe("ned_attention", () => {
  it("merges attention + agenda items, dedupes by URL, newest first, review keys from review-keys.ts", () => {
    const rows = attentionRows(ctx());
    expect(rows.map((r) => [r.source, r.review_key, r.open])).toEqual([
      ["calendar", null, true], // future start
      ["mail", "mail:th1", true],
      ["session", "session:aaaaaaaa-1111", true],
      ["jira", "jira:AB-1", true],
      ["github", "github:o/r#7", true],
      ["slack", "slack:C2:1794194000.000200", true],
      ["slack", "b1:0", false],
    ]);
    expect(rows.find((r) => r.source === "jira")!.title.length).toBeLessThanOrEqual(200);
  });

  it("open only by default, source filter, limit, include_reviewed", () => {
    const all = toolAttention({}, ctx());
    expect((all.data as any).open).toBe(6);
    expect((all.data as any).items).toHaveLength(6);
    expect(all.summary).toMatch(/확인할 것 6건 열림 \(✓ 1건\)/);
    const slack = toolAttention({ source: "slack" }, ctx()).data as any;
    expect(slack.items.map((r: any) => r.review_key)).toEqual(["slack:C2:1794194000.000200"]);
    expect((toolAttention({ source: "slack", include_reviewed: true }, ctx()).data as any).items).toHaveLength(2);
    const lim = toolAttention({ limit: 2 }, ctx());
    expect((lim.data as any).items).toHaveLength(2);
    expect(lim.summary).toMatch(/4건 더 있음/);
    expect(toolAttention({ limit: 10_000 }, ctx()).data).toBeTruthy(); // bound to MAX_ATTENTION, no throw
    expect(MAX_ATTENTION).toBe(100);
  });

  it("a ✓ mark at/after the item's last change closes a source item; a later change reopens it", () => {
    const c = ctx({ marks: { "jira:AB-1": NOW - H } });
    expect(attentionRows(c).find((r) => r.review_key === "jira:AB-1")!.open).toBe(false);
    const c2 = ctx({ marks: { "jira:AB-1": NOW - 5 * H } }); // marked before the issue's update
    expect(attentionRows(c2).find((r) => r.review_key === "jira:AB-1")!.open).toBe(true);
  });

  it("a source switched off in config drops its agenda items", () => {
    const c = ctx();
    c.cfg.sources.jira = false;
    c.cfg.sources.calendar = false;
    expect(attentionRows(c).some((r) => r.source === "jira" || r.source === "calendar")).toBe(false);
  });
});

describe("ned_sessions", () => {
  it("8-char ids, waiting flag, clipped prompt, worker / status filters", () => {
    const r = toolSessions({}, ctx());
    const d = r.data as any;
    expect(d.sessions.map((s: any) => [s.id, s.status, s.waiting_for_input])).toEqual([["aaaaaaaa", "waiting", true], ["bbbbbbbb", "running", false]]);
    expect(d.sessions[0].last_prompt.length).toBeLessThanOrEqual(200);
    expect(r.summary).toBe("세션 2개 — 입력 대기 1, 실행 중 1, 완료 0, 오류 0");
    expect((toolSessions({ include_workers: false }, ctx()).data as any).sessions).toHaveLength(1);
    expect((toolSessions({ status: "running" }, ctx()).data as any).sessions.map((s: any) => s.worktree)).toEqual(["w1"]);
    expect((toolSessions({ limit: 1 }, ctx()).data as any).returned).toBe(1);
  });
});

describe("ned_briefing", () => {
  const b = (id: string, ts: number, extra: object = {}) => ({ id, ts, type: "heartbeat" as const, status: "UPDATE" as const, headline: `헤드 ${id}`, action_items: Array.from({ length: 30 }, (_, i) => ({ title: `할 일 ${i}`, detail: "d".repeat(900) })), updates: [], fyi: [], ...extra });

  it("latest by default, sections capped and clipped", () => {
    const r = toolBriefing({}, ctx({ briefings: [b("b2", NOW - H), b("b1", NOW - 5 * H)] }));
    const [only] = (r.data as any).briefings;
    expect((r.data as any).briefings).toHaveLength(1);
    expect(only.id).toBe("b2");
    expect(only.action_items).toHaveLength(15);
    expect(only.action_items[0].detail.length).toBeLessThanOrEqual(400);
    expect(r.summary).toMatch(/^순찰 .* · UPDATE — 헤드 b2 · 할 일 30건$/);
  });

  it("since → briefings after it (limit), bad since → error, none → empty", () => {
    const c = ctx({ briefings: [b("b3", NOW - H), b("b2", NOW - 2 * H), b("b1", NOW - 10 * H)] });
    expect((toolBriefing({ since: iso(NOW - 3 * H) }, c).data as any).briefings.map((x: any) => x.id)).toEqual(["b3", "b2"]);
    expect((toolBriefing({ since: iso(NOW - 30 * H), limit: 1 }, c).data as any).briefings).toHaveLength(1);
    expect(toolBriefing({ since: "어제" }, c).error).toBe(true);
    expect(toolBriefing({}, ctx()).summary).toMatch(/브리핑 없음/);
  });

  it("a failed briefing carries a clipped raw", () => {
    const r = toolBriefing({}, ctx({ briefings: [b("bx", NOW, { ok: false, raw: "r".repeat(2000) })] }));
    expect((r.data as any).briefings[0].raw.length).toBeLessThanOrEqual(500);
  });
});

describe("ned_history / ned_feed", () => {
  beforeEach(() => fs.rmSync(historyFile("jira"), { force: true }));

  it("history: default 1 day, limit, light rows (no raw state/item)", () => {
    const now = Date.now();
    const rec = (key: string, t: number) => ({ key, source: "jira", first_seen: t, last_seen: t, ts: iso(t), state: { open: true }, item: { key, title: `이슈 ${key}`, url: `https://j.example/browse/${key}` } });
    writeHistory("jira", [rec("AB-1", now - H), rec("AB-2", now - 2 * H), rec("AB-3", now - 3 * 24 * H)] as any);
    const c = ctx({ now });
    const r = toolHistory({ source: "jira" }, c);
    expect((r.data as any).items.map((x: any) => x.key)).toEqual(["AB-1", "AB-2"]);
    expect((r.data as any).items[0]).not.toHaveProperty("state");
    expect(r.summary).toBe("jira 이력 지난 1일 2건");
    expect((toolHistory({ source: "jira", days: 7, limit: 1 }, c).data as any)).toMatchObject({ total: 3, returned: 1 });
    expect(toolHistory({ source: "nope" as any }, c).error).toBe(true);
  });

  it("feed: open attention + recent UPDATE briefings, newest first, limit", () => {
    const c = ctx({ briefings: [{ id: "b9", ts: NOW - 10 * 60_000, type: "daily", status: "UPDATE", headline: "아침 소식", action_items: [], updates: [], fyi: [] }] });
    const r = toolFeed({}, c);
    expect((r.data as any).items.map((x: any) => x.key)).toEqual(["brief:b9", "att:session:aaaaaaaa-1111"]);
    expect((toolFeed({ limit: 1 }, c).data as any).items).toHaveLength(1);
  });
});

describe("ned_mark_reviewed (reviewItem — same rules as POST /api/attention/:id/review)", () => {
  beforeEach(() => {
    fs.rmSync(REVIEWED_PATH, { force: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...ctx().state, attention: [{ id: "b1:0", kind: "jira", title: "x", ts: Date.now() - 1000, source: "b1" }] }));
  });

  it("400 for a malformed source key, 404 for an unknown attention id", async () => {
    for (const k of ["slack:", "jira: x", " "]) {
      const r = await toolMarkReviewed({ review_key: k });
      expect(r.error, k).toBe(true);
      expect((r.data as any).status, k).toBe(400);
    }
    const nf = await toolMarkReviewed({ review_key: "nope:1" });
    expect((nf.data as any).status).toBe(404);
  });

  it("200: marks and unmarks a source key and an attention id", async () => {
    const r = await toolMarkReviewed({ review_key: "jira:AB-1" });
    expect(r.error).toBeUndefined();
    expect((r.data as any).ok).toBe(true);
    expect(readReviewed()["jira:AB-1"]).toBeGreaterThan(0);
    const a = await toolMarkReviewed({ review_key: "b1:0" });
    expect((a.data as any).attention_open_count).toBe(0);
    const un = await toolMarkReviewed({ review_key: "jira:AB-1", reviewed: false });
    expect(un.summary).toMatch(/해제/);
    expect(readReviewed()["jira:AB-1"]).toBeUndefined();
  });
});
