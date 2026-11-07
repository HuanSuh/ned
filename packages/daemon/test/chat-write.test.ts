/**
 * Ned Net 대화창 쓰기 제안 (actions.chat_write): the prompt lists only the allowed kinds, POST /api/chat/actions/validate
 * checks switches + targets and builds the request for the EXISTING endpoints, origin "chat" is gated and logged, and the
 * 확인 카드 state is saved on the chat message. Nothing is ever sent: NED_NO_LLM + NED_SEND_DRY_RUN (test/setup.ts).
 */
import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { loadConfig, DEFAULT_CONFIG } = await import("../src/config.js");
const { AGENDA_PATH, CONFIG_PATH, NED_HOME, STATE_PATH, TODOS_PATH } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG, readActionLog } = await import("../src/actions.js");
const { _resetSendJobs } = await import("../src/send-jobs.js");
const ca = await import("../src/chat-actions.js");
const chat = await import("../src/chat.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const post = (p: string, body: unknown) => request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const setConfig = (actions: Record<string, boolean> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions }));
const ALL_ON = Object.fromEntries(Object.keys(DEFAULT_CONFIG.actions).map((k) => [k, true]));

const SLACK_URL = "https://acme.slack.com/archives/C0123ABC/p1730000000123456";
const MAIL_URL = "https://mail.google.com/mail/u/0/#inbox/18f00aa";
const JIRA_URL = "https://acme.atlassian.net/browse/NED-7";
const PR_URL = "https://github.com/acme/ned/pull/42";
const agenda = {
  updated_at: Date.now(),
  calendar: [
    { id: "ev1", title: "주간 회의", start: "2026-11-09T10:00:00+09:00", end: "2026-11-09T11:00:00+09:00", all_day: false, location: "", url: "https://calendar.google.com/event?eid=ev1", meet_url: "", rsvp: "needsAction", attendees: 4 },
    { id: "ev2", title: "내 일정", start: "2026-11-09T12:00:00+09:00", end: "2026-11-09T13:00:00+09:00", all_day: false, location: "", url: "https://calendar.google.com/event?eid=ev2", meet_url: "", rsvp: "organizer", attendees: 2 },
  ],
  jira: [{ key: "NED-7", title: "로그인 버그", status: "To Do", priority: "", due: null, url: JIRA_URL, updated: "" }],
  github: [{ repo: "acme/ned", number: 42, title: "채팅 쓰기", url: PR_URL, author: "lee", updated: "", reason: "review_requested" }],
  mail: {
    summary: "", unread: 2, unread_capped: false, all: [],
    items: [
      { id: "18f00aa", from: "boss", subject: "결재 요청", snippet: "", received: "", url: MAIL_URL, reason: "approval", why: "오늘까지", context: { from: "boss", to: "me", subject: "결재 요청", body_excerpt: "", attachments: [], message_id: "msg-1", collected_at: "" } },
      { id: "18f00bb", from: "hr", subject: "공지", snippet: "", received: "", url: "https://mail.google.com/mail/u/0/#inbox/18f00bb", reason: "request", why: "" },
    ],
  },
  slack: { summary: "", items: [{ channel: "#dev", from: "kim", text: "배포 언제?", url: SLACK_URL, ts: "", reason: "mention" }], all: [], watch: [], threads: [], dms: [] },
};
const state = {
  updated_at: 0, daemon_pid: 0, attention: [], last_briefing: null, last_heartbeat_at: null, next_heartbeat_at: null, quiet: false, persona: "ned", attention_open_count: 0,
  sessions: [
    { id: "sess-live", cwd: "/w/ned", worktree: "ned-chat", status: "running", since: 0, last_event_ts: 0, last_prompt: null, last_summary: null, subagents_active: 0, orca_worktree: null, alert_ts: null, is_worker: false },
    { id: "sess-gone", cwd: "/w/old", worktree: "old", status: "ended", since: 0, last_event_ts: 0, last_prompt: null, last_summary: null, subagents_active: 0, orca_worktree: null, alert_ts: null, is_worker: false },
  ],
};
const known = { agenda, state } as never;
const on = { actions: { ...DEFAULT_CONFIG.actions, ...ALL_ON } };
const off = { actions: { ...DEFAULT_CONFIG.actions } };

beforeAll(() => {
  console.log(`NED_HOME=${NED_HOME}`);
  fs.writeFileSync(AGENDA_PATH, JSON.stringify(agenda));
  fs.writeFileSync(STATE_PATH, JSON.stringify(state));
  setConfig();
  startServer(() => loadConfig());
});
beforeEach(() => {
  setConfig();
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  fs.rmSync(TODOS_PATH, { force: true });
  _resetSendJobs();
});

describe("prompt: allowed kinds only", () => {
  it("chat_write off → no proposal section; rule 3 points at the dashboard buttons", () => {
    expect(DEFAULT_CONFIG.actions.chat_write).toBe(false);
    expect(ca.allowedChatKinds(off)).toEqual([]);
    expect(ca.chatWriteBlock(off)).toBe("");
    const sys = chat.buildChatSystemPrompt(loadConfig(), "CTX", new Date(), null);
    expect(sys).not.toContain("ned-action");
    expect(sys).toContain("쓰기 도구는 절대 쓰지 않는다");
    expect(sys).toContain("**답장 초안** 버튼");
    expect(sys).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("chat_write on → only kinds whose own switch is on (todo_add needs nothing else)", () => {
    const cfg = { actions: { ...DEFAULT_CONFIG.actions, chat_write: true, slack_send: true } };
    // defaults: gmail_draft + session_send on
    expect(ca.allowedChatKinds(cfg)).toEqual(["todo_add", "slack_send", "gmail_draft", "session_send"]);
    const block = ca.chatWriteBlock(cfg);
    for (const k of ["`todo_add`", "`slack_send`", "`gmail_draft`", "`session_send`", "```ned-action"]) expect(block).toContain(k);
    for (const k of ["`gmail_send`", "`jira_comment`", "`calendar_create`", "`github_review`"]) expect(block).not.toContain(k);

    setConfig({ chat_write: true, slack_send: true });
    const sys = chat.buildChatSystemPrompt(loadConfig(), "CTX", new Date(), null);
    expect(sys).toContain("## 대화창 쓰기 제안 (ned-action)");
    expect(sys).toContain("`slack_send` (Slack 보내기)");
    expect(sys).not.toContain("`gmail_send`");
    expect(sys).toContain("쓰기 도구는 절대 쓰지 않는다"); // the model still never writes itself
    expect(sys).toContain("**제안만** 한다");
    expect(sys).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("the chat itself stays read-only whatever chat_write says", () => {
    setConfig(ALL_ON);
    const opts = chat.chatRunOptions(loadConfig(), "sys", null);
    expect(opts.permissionMode).toBe("plan");
    expect(opts.tools).toEqual(["ToolSearch", "Bash"]);
    expect(opts.allowedTools.some((t: string) => /send|create|reply|comment|transition|respond|review/i.test(t) && !t.startsWith("Bash(gh"))).toBe(false);
  });

  it("context carries the ids a proposal needs (session_id, event_id)", () => {
    const s = chat.buildChatContext({ cfg: { sources: { ...DEFAULT_CONFIG.sources } }, agenda: { ...agenda, calendar: [{ ...agenda.calendar[0], start: new Date().toISOString(), end: new Date(Date.now() + 3600_000).toISOString() }] }, state, briefings: [], todos: [] } as never);
    expect(s).toContain("session_id=sess-live");
    expect(s).toContain("event_id=ev1");
  });
});

describe("validateChatAction", () => {
  const v = (block: unknown, cfg = on, text?: string) => ca.validateChatAction(cfg, block, known, text);

  it("refuses when chat_write or the kind's own switch is off (403)", () => {
    expect(v({ kind: "todo_add", text: "보고서" }, off)).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("actions.chat_write") });
    const noSlack = { actions: { ...on.actions, slack_send: false } };
    expect(v({ kind: "slack_send", target: { url: SLACK_URL }, text: "곧" }, noSlack)).toMatchObject({ ok: false, status: 403, error: expect.stringContaining("actions.slack_send") });
  });

  it("malformed blocks → 400", () => {
    expect(v("{not json")).toMatchObject({ ok: false, status: 400 });
    expect(v({ kind: "rm_rf", text: "x" })).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("알 수 없는 kind") });
    expect(v({ kind: "slack_send", target: { url: SLACK_URL }, text: "  " })).toMatchObject({ ok: false, status: 400, error: "텍스트가 비어 있어" });
    expect(v({ kind: "todo_add", target: { due: "내일" }, text: "x" })).toMatchObject({ ok: false, status: 400 });
  });

  it("targets must be known items (url / id match) → else 409", () => {
    expect(v({ kind: "slack_send", target: { url: "https://acme.slack.com/archives/CEVIL/p1" }, text: "hi" })).toMatchObject({ ok: false, status: 409 });
    expect(v({ kind: "jira_comment", target: { url: "https://acme.atlassian.net/browse/OTHER-1" }, text: "hi" })).toMatchObject({ ok: false, status: 409 });
    expect(v({ kind: "github_review", target: { url: "https://github.com/evil/x/pull/1" }, text: "hi" })).toMatchObject({ ok: false, status: 409 });
    expect(v({ kind: "calendar_rsvp", target: { event_id: "nope", response: "accepted" } })).toMatchObject({ ok: false, status: 409 });
    expect(v({ kind: "calendar_rsvp", target: { event_id: "ev2", response: "accepted" } })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("주최") });
    expect(v({ kind: "session_send", target: { session_id: "sess-gone" }, text: "계속" })).toMatchObject({ ok: false, status: 409 });
    expect(v({ kind: "gmail_send", target: { url: "https://mail.google.com/mail/u/0/#inbox/18f00bb" }, text: "네" })).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("message_id") });
  });

  it("builds the existing /api/send payload with origin chat; the target comes from the known item, the text from the card", () => {
    const r = v({ kind: "slack_send", target: { url: `${SLACK_URL}/`, channel: "CEVIL" }, text: "원문", summary: "kim 에게 답" }, on, "고친 문장");
    expect(r).toMatchObject({ ok: true, endpoint: "/api/send", label: "Slack 보내기", summary: "kim 에게 답", text: "고친 문장", target_label: "Slack · #dev · kim" });
    if (!r.ok) throw new Error();
    expect(r.payload).toEqual({ source: "slack", mode: "send", ref: { url: SLACK_URL, title: "#dev · kim" }, text: "고친 문장", origin: "chat" }); // CEVIL dropped

    expect(v({ kind: "gmail_draft", target: { url: MAIL_URL }, text: "검토할게요" })).toMatchObject({ ok: true, payload: { source: "email", mode: "gmail_draft", ref: { message_id: "msg-1", thread_id: "18f00aa" }, origin: "chat" } });
    expect(v({ kind: "gmail_send", target: { url: MAIL_URL }, text: "네" })).toMatchObject({ ok: true, payload: { source: "email", mode: "send" } });
    expect(v({ kind: "jira_comment", target: { key: "ned-7" }, text: "확인 중" })).toMatchObject({ ok: true, payload: { source: "jira", mode: "comment", ref: { url: JIRA_URL, key: "NED-7" } } });
    expect(v({ kind: "github_review", target: { url: PR_URL, event: "approve" }, text: "" })).toMatchObject({ ok: true, text_optional: true, payload: { source: "github", mode: "approve", ref: { repo: "acme/ned", number: "42" } } });
    expect(v({ kind: "github_review", target: { url: PR_URL }, text: "LGTM" })).toMatchObject({ ok: true, payload: { mode: "comment" } });
    expect(v({ kind: "calendar_rsvp", target: { event_id: "ev1", response: "declined" }, text: "" })).toMatchObject({ ok: true, payload: { source: "calendar", mode: "rsvp", ref: { event_id: "ev1", response: "declined" } } });
    expect(v({ kind: "session_send", target: { session_id: "sess-live" }, text: "테스트 돌려" })).toMatchObject({ ok: true, payload: { source: "session", mode: "session", ref: { session_id: "sess-live", title: "ned-chat" } } });
  });

  it("jira_transition: transition looked up by the card text (lookup payload), never invented", () => {
    const r = v({ kind: "jira_transition", target: { url: JIRA_URL }, text: "진행 중" });
    expect(r).toMatchObject({ ok: true, payload: { source: "jira", mode: "transition", text: "", ref: { key: "NED-7", transition_name: "진행 중" } }, lookup: { source: "jira", mode: "transitions", origin: "chat" } });
    if (r.ok) expect((r.payload.ref as Record<string, unknown>).transition_id).toBeUndefined();
  });

  it("todo_add → /api/todos; calendar_create → /api/calendar/events (validated like the 새 일정 form, primary only)", () => {
    expect(v({ kind: "todo_add", target: { due: "2026-11-10" }, text: "보고서 쓰기" })).toMatchObject({ ok: true, endpoint: "/api/todos", payload: { title: "보고서 쓰기", due: "2026-11-10", origin: "chat" }, target_label: "개인 할 일 · 마감 2026-11-10" });
    const c = v({ kind: "calendar_create", target: { date: "2026-11-10", start_time: "15:00", end_time: "15:30", attendees: ["a@x.com"], calendar_id: "evil@x.com" }, text: "1:1" });
    expect(c).toMatchObject({ ok: true, endpoint: "/api/calendar/events", payload: { title: "1:1", date: "2026-11-10", start_time: "15:00", end_time: "15:30", attendees: ["a@x.com"], all_day: false, origin: "chat" }, target_label: "새 일정 · 2026-11-10 15:00 – 15:30 · 참석자 a@x.com" });
    if (c.ok) expect(c.payload.calendar_id).toBeUndefined();
    expect(v({ kind: "calendar_create", target: { date: "2026-11-10", start_time: "16:00", end_time: "15:00" }, text: "x" })).toMatchObject({ ok: false, status: 400 });
    expect(v({ kind: "calendar_create", target: { date: "2026-11-10", start_time: "15:00", end_time: "15:30", description: "안건: 배포" }, text: "1:1" })).toMatchObject({ ok: true, target_label: expect.stringContaining('설명 "안건: 배포"') });
  });
});

describe("routes", () => {
  it("POST /api/chat/actions/validate: 403 off, 409 unknown target, 200 payload", async () => {
    let r = await post("/api/chat/actions/validate", { block: { kind: "todo_add", text: "x" } });
    expect(r.status).toBe(403);
    setConfig({ chat_write: true, slack_send: true });
    r = await post("/api/chat/actions/validate", { block: { kind: "slack_send", target: { url: "https://acme.slack.com/archives/CX/p1" }, text: "x" } });
    expect(r.status).toBe(409);
    r = await post("/api/chat/actions/validate", { block: { kind: "slack_send", target: { url: SLACK_URL }, text: "원문" }, text: "새 문장" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, endpoint: "/api/send", payload: { text: "새 문장", origin: "chat" } });
  });

  it("POST /api/todos origin chat: needs chat_write (403 + refused log line), then 201 + a todo_add log line with origin", async () => {
    let r = await post("/api/todos", { title: "보고서", origin: "chat" });
    expect(r.status).toBe(403);
    expect(fs.existsSync(TODOS_PATH) ? JSON.parse(fs.readFileSync(TODOS_PATH, "utf8")) : []).toEqual([]);
    expect(readActionLog(5)[0]).toMatchObject({ source: "todo", mode: "add", action: "refused", ok: false, origin: "chat" });
    setConfig({ chat_write: true });
    r = await post("/api/todos", { title: "보고서", due: "2026-11-10", origin: "chat" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ title: "보고서", due: "2026-11-10" });
    expect(readActionLog(5)[0]).toMatchObject({ source: "todo", action: "todo_add", ok: true, origin: "chat" });
    // the dashboard's own todo add (no origin) is unchanged: no gate, no log line
    setConfig();
    r = await post("/api/todos", { title: "그냥 할 일" });
    expect(r.status).toBe(201);
    expect(readActionLog(10)).toHaveLength(2);
  });

  it("POST /api/send origin chat: refused unless chat_write too; then a job whose log line (and /api/actions) says origin chat", async () => {
    setConfig({ slack_send: true });
    const body = { source: "slack", mode: "send", ref: { url: SLACK_URL }, text: "곧 배포", origin: "chat" };
    let r = await post("/api/send", body);
    expect(r.status).toBe(403);
    expect(await r.json()).toMatchObject({ ok: false, action: "refused", detail: expect.stringContaining("config.actions.chat_write") });

    setConfig({ slack_send: true, chat_write: true });
    r = await post("/api/send", body);
    expect(r.status).toBe(202);
    const { job_id } = (await r.json()) as { job_id: string };
    let j: { state: string; result?: { action: string } } = { state: "running" };
    for (let i = 0; i < 50 && j.state !== "done"; i++) {
      await new Promise((res) => setTimeout(res, 10));
      j = (await (await request(`/api/send/${job_id}`)).json()) as typeof j;
    }
    expect(j.result?.action).toMatch(/^dry_run:slack_/); // NED_SEND_DRY_RUN: nothing sent
    const log = (await (await request("/api/actions")).json()) as { origin?: string; action: string }[];
    expect(log[0]).toMatchObject({ origin: "chat", action: expect.stringMatching(/^dry_run:/) });
    expect(log.find((e) => e.action === "refused")).toMatchObject({ origin: "chat" });

    // without origin the dashboard flow is unchanged (chat_write irrelevant)
    setConfig({ slack_send: true });
    r = await post("/api/send", { ...body, origin: undefined, text: "다른 글" });
    expect(r.status).toBe(202);
  });

  it("POST /api/calendar/events origin chat is gated by chat_write as well", async () => {
    setConfig({ calendar_create: true });
    const r = await post("/api/calendar/events", { title: "1:1", date: "2026-11-10", start_time: "15:00", end_time: "15:30", origin: "chat" });
    expect(r.status).toBe(403);
    expect(readActionLog(1)[0]).toMatchObject({ source: "calendar", mode: "create", action: "refused", origin: "chat" });
  });
});

describe("확인 카드 state on the chat message", () => {
  const seed = () => {
    const c = chat.newChat();
    c.messages.push({ role: "user", text: "보고서 할 일에 넣어 줘", ts: 1 }, { role: "ned", text: "넣을게.\n```ned-action\n{\"kind\":\"todo_add\",\"text\":\"보고서\"}\n```", ts: 2 });
    chat.saveChat(c);
    return c.id;
  };

  it("running → executed is saved; a second run or a cancel afterwards is 409", async () => {
    const id = seed();
    let r = await post(`/api/chat/${id}/action`, { ts: 2, state: "running", text: "보고서 v2" });
    expect(r.status).toBe(200);
    r = await post(`/api/chat/${id}/action`, { ts: 2, state: "running" });
    expect(r.status).toBe(409);
    r = await post(`/api/chat/${id}/action`, { ts: 2, state: "executed", result: { ok: true, detail: "할 일 추가됨", link: "javascript:alert(1)" } });
    expect(r.status).toBe(200);
    const saved = (await (await request(`/api/chat/${id}`)).json()) as { messages: { action?: unknown }[] };
    expect(saved.messages[1].action).toMatchObject({ state: "executed", text: "보고서 v2", result: { ok: true, detail: "할 일 추가됨" } });
    expect((saved.messages[1].action as { result: { link?: string } }).result.link).toBeUndefined();
    for (const state of ["running", "cancelled", "failed"]) expect((await post(`/api/chat/${id}/action`, { ts: 2, state })).status).toBe(409);
  });

  it("failed may be retried; cancelled is final; bad input 400 / 404", async () => {
    const id = seed();
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "executed" })).status).toBe(409); // must run first
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "running" })).status).toBe(200);
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "failed", result: { ok: false, detail: "x" } })).status).toBe(200);
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "running" })).status).toBe(200);
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "failed" })).status).toBe(200);
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "cancelled" })).status).toBe(200);
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "running" })).status).toBe(409);
    expect((await post(`/api/chat/${id}/action`, { ts: 2, state: "bogus" })).status).toBe(400);
    expect((await post(`/api/chat/${id}/action`, { ts: 1, state: "running" })).status).toBe(404); // user message
    expect((await post(`/api/chat/c-nope123/action`, { ts: 2, state: "running" })).status).toBe(404);
  });

  it("the SSE done event carries the saved message ts (the card's key)", async () => {
    process.env.NED_NO_LLM_CHAT = "넣을게.\n```ned-action\n{\"kind\":\"todo_add\",\"text\":\"보고서\"}\n```";
    try {
      const r = await post("/api/chat", { text: "보고서 할 일에 넣어 줘" });
      const text = await r.text();
      const done = JSON.parse(/event: done\ndata: (.*)\n/.exec(text)![1]) as { conversation_id: string; ts: number };
      const saved = chat.readChat(done.conversation_id)!;
      expect(saved.messages.at(-1)!.ts).toBe(done.ts);
      expect((await post(`/api/chat/${done.conversation_id}/action`, { ts: done.ts, state: "cancelled" })).status).toBe(200);
    } finally {
      delete process.env.NED_NO_LLM_CHAT;
    }
  });
});
