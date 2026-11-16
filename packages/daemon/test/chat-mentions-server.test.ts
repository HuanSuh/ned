/**
 * 대화창 쓰기 보강 (WU-07) through the real routes: a chat turn saves seen_slack from tool-result fixtures (never the
 * text), validate accepts that thread as "Ned 가 찾은 대상" and resolves mentions (golden case), the daily cap answers
 * 429 on every chat write endpoint, and PUT /api/config refuses bad limits / group ids. Nothing is sent:
 * NED_NO_LLM + NED_SEND_DRY_RUN (test/setup.ts). Pseudonymous ids only (C0TEST…, U0TEST…, acme.slack.com).
 */
import fs from "node:fs";
import path from "node:path";
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
const { AGENDA_PATH, CONFIG_PATH, NED_HOME, SLACK_USERS_PATH, STATE_PATH } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG, appendActionLog } = await import("../src/actions.js");
const { _resetSendJobs } = await import("../src/send-jobs.js");
const chat = await import("../src/chat.js");
const ca = await import("../src/chat-actions.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const post = (p: string, body: unknown) => request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const put = (body: unknown) => request("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const setConfig = (actions: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions, ...extra }));

const PL = "https://acme.slack.com/archives/C0TESTADS01/p1794277961148039";
const agenda = { updated_at: Date.now(), calendar: [], jira: [], github: [], mail: null, slack: { summary: "", items: [], all: [], watch: [], threads: [], dms: [] } };
const state = { updated_at: 0, daemon_pid: 0, attention: [], last_briefing: null, last_heartbeat_at: null, next_heartbeat_at: null, quiet: false, persona: "ned", attention_open_count: 0, sessions: [] };

// ---- golden case (가명): the user's ask, the model's Slack search (fixture) and its proposal ----
const GOLDEN_ASK = "11/10 사람B님 광고 오류 현황 스레드에 사람A님·사람B님 멘션해서 보상 지급 지표 위치 물어봐줘";
const GOLDEN_EVENTS = [
  { type: "assistant", message: { content: [{ type: "tool_use", id: "tu_1", name: "mcp__claude_ai_Slack__slack_search_public_and_private", input: { query: "광고 오류 현황 from:사람B" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: [{ type: "text", text: `### Result 1\nChannel: #ads-ops (C0TESTADS01)\nFrom: 사람B (U0TESTPB01)\nText: 11/10 광고 오류 현황 공유드립니다…\nPermalink: ${PL}` }] }] } },
];
const GOLDEN_BLOCK = {
  kind: "slack_send",
  target: { url: PL, channel_name: "#ads-ops" },
  target_excerpt: "11/10 광고 오류 현황 공유드립니다…",
  mentions: [
    { text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A" }] },
    { text: "@사람B", candidates: [{ id: "U0TESTPB01", name: "사람B" }] },
  ],
  text: "@사람A님 @사람B님 보상 지급 지표는 어디서 볼 수 있을까요?",
  summary: "광고 오류 현황 스레드에 보상 지급 지표 위치 질문",
};
const GOLDEN_ANSWER = `그 스레드에 이렇게 물어볼게.\n\n\`\`\`ned-action\n${JSON.stringify(GOLDEN_BLOCK)}\n\`\`\``;

/** One chat turn through POST /api/chat with the fixture events + answer → the conversation id. */
async function goldenTurn(): Promise<string> {
  const evFile = path.join(NED_HOME, "golden-events.json");
  fs.writeFileSync(evFile, JSON.stringify(GOLDEN_EVENTS));
  process.env.NED_NO_LLM_CHAT = GOLDEN_ANSWER;
  process.env.NED_NO_LLM_CHAT_EVENTS = evFile;
  try {
    const r = await post("/api/chat", { text: GOLDEN_ASK });
    const sse = await r.text();
    return (JSON.parse(/event: done\ndata: (.*)\n/.exec(sse)![1]) as { conversation_id: string }).conversation_id;
  } finally {
    delete process.env.NED_NO_LLM_CHAT;
    delete process.env.NED_NO_LLM_CHAT_EVENTS;
  }
}

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
  fs.rmSync(SLACK_USERS_PATH, { force: true });
  _resetSendJobs();
});

describe("golden case: Ned 가 찾은 스레드에 두 사람 멘션", () => {
  it("the turn saves seen_slack (ids + permalink only); validate → found target, both mentions resolved, notify line data", async () => {
    setConfig({ chat_write: true, slack_send: true }, { dashboard: { slack_team_domain: "acme" } });
    const id = await goldenTurn();
    const saved = chat.readChat(id)!;
    const ned = saved.messages.at(-1)!;
    expect(ned.seen_slack).toEqual([{ channel: "C0TESTADS01", ts: "1794277961.148039", permalink: PL }]);
    expect(JSON.stringify(saved)).not.toContain("Channel: #ads-ops"); // the tool result text itself is not stored

    // without the conversation the target is unknown (409)
    expect((await post("/api/chat/actions/validate", { block: GOLDEN_BLOCK })).status).toBe(409);

    const r = await post("/api/chat/actions/validate", { block: GOLDEN_BLOCK, conversation_id: id });
    expect(r.status).toBe(200);
    const v = (await r.json()) as ca.ChatActionOk;
    expect(v.slack).toMatchObject({ target_source: "found", channel: "C0TESTADS01", thread_ts: "1794277961.148039", channel_name: "#ads-ops", target_excerpt: "11/10 광고 오류 현황 공유드립니다…", external: "unknown" });
    expect(v.payload).toMatchObject({ source: "slack", mode: "send", origin: "chat", ref: { channel: "C0TESTADS01", thread_ts: "1794277961.148039" } });
    expect(v.payload.text).toBe("<@U0TESTPA01>님 <@U0TESTPB01>님 보상 지급 지표는 어디서 볼 수 있을까요?");
    expect(v.target_label).toContain("Ned 가 찾은 대상");
    expect(v.slack!.mentions.resolved.map((m) => m.name)).toEqual(["사람A", "사람B"]);
    // confirmed candidates are cached (TTL 24h) for later turns
    expect(Object.keys(JSON.parse(fs.readFileSync(SLACK_USERS_PATH, "utf8")).users).sort()).toEqual(["U0TESTPA01", "U0TESTPB01"]);

    // another workspace configured → that link is refused
    setConfig({ chat_write: true, slack_send: true }, { dashboard: { slack_team_domain: "other" } });
    const other = await post("/api/chat/actions/validate", { block: GOLDEN_BLOCK, conversation_id: id });
    expect(other.status).toBe(409);
    expect(((await other.json()) as { error: string }).error).toContain("다른 워크스페이스");
  });

  it("a permalink the user pasted is a target too (붙인 링크); 동명이인 → 409 until mention_choices", async () => {
    setConfig({ chat_write: true, slack_send: true });
    process.env.NED_NO_LLM_CHAT = "ok";
    let id: string;
    try {
      const sse = await (await post("/api/chat", { text: `이 스레드 ${PL} 에 답해 줘` })).text();
      id = (JSON.parse(/event: done\ndata: (.*)\n/.exec(sse)![1]) as { conversation_id: string }).conversation_id;
    } finally {
      delete process.env.NED_NO_LLM_CHAT;
    }
    const block = { ...GOLDEN_BLOCK, mentions: [{ text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A" }, { id: "U0TESTPA02", name: "사람A", title: "디자인" }] }], text: "@사람A님 확인 부탁드려요" };
    let r = await post("/api/chat/actions/validate", { block, conversation_id: id });
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ need_choice: true, slack: { target_source: "pasted", mentions: { unresolved: [{ text: "@사람A" }] } } });
    r = await post("/api/chat/actions/validate", { block, conversation_id: id, mention_choices: { "@사람A": "U0TESTPA02" } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as ca.ChatActionOk).payload.text).toBe("<@U0TESTPA02>님 확인 부탁드려요");
    // an id typed into the card text that nobody vouched for → 400
    r = await post("/api/chat/actions/validate", { block, conversation_id: id, mention_choices: { "@사람A": "U0TESTPA02" }, text: "<@U0TESTZZ99> 확인" });
    expect(r.status).toBe(400);
  });

  it("group ids: filters.slack.group_ids turns @handle into <!subteam^…>; without it the handle stays text", async () => {
    const id = await (async () => {
      setConfig({ chat_write: true, slack_send: true });
      return goldenTurn();
    })();
    const block = { ...GOLDEN_BLOCK, mentions: [{ text: "@ads-team", group: true, candidates: [] }], text: "@ads-team 확인 부탁드려요" };
    let v = (await (await post("/api/chat/actions/validate", { block, conversation_id: id })).json()) as ca.ChatActionOk;
    expect(v.payload.text).toBe("@ads-team 확인 부탁드려요");
    expect(v.slack!.mentions.missing).toEqual([{ text: "@ads-team", kind: "group" }]);
    setConfig({ chat_write: true, slack_send: true }, { filters: { slack: { group_ids: { "ads-team": "S0TESTGRP1" } } } });
    v = (await (await post("/api/chat/actions/validate", { block, conversation_id: id })).json()) as ca.ChatActionOk;
    expect(v.payload.text).toBe("<!subteam^S0TESTGRP1> 확인 부탁드려요");
  });
});

describe("하루 상한 (actions.chat_write_daily_limit)", () => {
  const today = () => new Date().toISOString();
  const sent = (n: number, extra: Record<string, unknown> = {}) => {
    for (let i = 0; i < n; i++) appendActionLog({ ts: today(), source: "slack", mode: "send", action: "slack_thread_reply C0TESTADS01/1", ref: {}, text: "x", ok: true, result: "https://acme.slack.com/archives/C0TESTADS01/p1", origin: "chat", ...extra });
  };

  it("counts only ok chat sends of today (not refused / dry runs / other origins / yesterday / transitions)", () => {
    sent(2);
    sent(1, { ok: false, action: "refused" });
    sent(1, { action: "dry_run:slack_message C0TESTADS01" });
    sent(1, { origin: "card" });
    sent(1, { mode: "transitions", source: "jira" });
    sent(1, { ts: new Date(Date.now() - 2 * 86400_000).toISOString() });
    expect(ca.chatSentToday()).toBe(2);
    expect(ca.chatLimitReached({ actions: { ...DEFAULT_CONFIG.actions, chat_write_daily_limit: 3 } })).toBeNull();
    expect(ca.chatLimitReached({ actions: { ...DEFAULT_CONFIG.actions, chat_write_daily_limit: 2 } })).toMatchObject({ limit: 2, used: 2 });
    expect(ca.chatLimitReached({ actions: { ...DEFAULT_CONFIG.actions, chat_write_daily_limit: 0 } })).toBeNull(); // 0 = 무제한
  });

  it("over the cap: /api/send · /api/calendar/events · /api/todos (origin chat) and validate answer 429 {error, limit, used}", async () => {
    setConfig({ chat_write: true, slack_send: true, calendar_create: true, chat_write_daily_limit: 2 });
    sent(2);
    const send = await post("/api/send", { source: "slack", mode: "send", ref: { url: PL }, text: "x", origin: "chat" });
    expect(send.status).toBe(429);
    expect(await send.json()).toMatchObject({ ok: false, limit: 2, used: 2, error: expect.stringContaining("오늘 대화창 전송 상한(2) 도달") });
    expect((await post("/api/calendar/events", { title: "1:1", date: "2026-11-20", start_time: "15:00", end_time: "15:30", origin: "chat" })).status).toBe(429);
    expect((await post("/api/todos", { title: "x", origin: "chat" })).status).toBe(429);
    expect((await post("/api/chat/actions/validate", { block: { kind: "todo_add", text: "x" } })).status).toBe(429);
    // the dashboard's own sends are not capped
    expect((await post("/api/send", { source: "slack", mode: "send", ref: { url: PL }, text: "x" })).status).toBe(202);
    expect((await post("/api/todos", { title: "x" })).status).toBe(201);
    // raising the cap lets it through again
    setConfig({ chat_write: true, slack_send: true, chat_write_daily_limit: 3 });
    expect((await post("/api/send", { source: "slack", mode: "send", ref: { url: PL }, text: "y", origin: "chat" })).status).toBe(202);
  });
});

describe("PUT /api/config", () => {
  it("chat_write_daily_limit: 0..200 integers only (400 otherwise); default 20", async () => {
    expect(loadConfig().actions.chat_write_daily_limit).toBe(20);
    for (const bad of [-1, 201, 1.5, "10"]) expect((await put({ actions: { chat_write_daily_limit: bad } })).status).toBe(400);
    expect((await put({ actions: { chat_write_daily_limit: 0 } })).status).toBe(200);
    expect(loadConfig().actions.chat_write_daily_limit).toBe(0);
  });
  it("filters.slack.group_ids: handle=ID list or map, ≤ 20, bad entries → 400; kept other filters", async () => {
    expect((await put({ filters: { slack: { group_ids: ["@Ads-Team = s0testgrp1", "qa=S0TESTGRP2"] } } })).status).toBe(200);
    expect(loadConfig().filters.slack.group_ids).toEqual({ "ads-team": "S0TESTGRP1", qa: "S0TESTGRP2" });
    expect((await put({ filters: { slack: { group_ids: ["ads-team=U0TESTPA01"] } } })).status).toBe(400);
    expect((await put({ filters: { slack: { group_ids: ["Ads Team=S0TESTGRP1"] } } })).status).toBe(400);
    expect((await put({ filters: { slack: { group_ids: Array.from({ length: 21 }, (_, i) => `g${i}=S0TESTG${String(i).padStart(3, "0")}`) } } })).status).toBe(400);
  });
});

describe("chat_write off → read-only at once", () => {
  it("no ned-action section, and the chat tools never include a Slack (or any) write tool either way", () => {
    const off = { ...DEFAULT_CONFIG, actions: { ...DEFAULT_CONFIG.actions, slack_send: true, chat_write: false } };
    const on = { ...off, actions: { ...off.actions, chat_write: true } };
    expect(ca.chatWriteBlock(off)).toBe("");
    expect(chat.buildChatSystemPrompt(off, "ctx", new Date(), null)).not.toContain("ned-action");
    for (const cfg of [off, on]) {
      const tools = chat.chatTools({ sources: { ...DEFAULT_CONFIG.sources, slack: true } });
      expect(tools.some((t) => /send_message|schedule_message|create_canvas|update_canvas|draft/.test(t))).toBe(false);
      expect(chat.chatRunOptions(cfg, "s", null).permissionMode).toBe("plan");
    }
  });
});
