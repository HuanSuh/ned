/**
 * 대화창 쓰기 보강 (WU-07) — the pure half: Slack permalinks, what a chat turn "saw" (seen_slack from tool-result
 * fixtures), mention resolution + the ID whitelist, and validateChatAction's three Slack target sources.
 * Pseudonymous ids only (C0TEST…, U0TEST…, S0TEST…, acme.slack.com) — never a real workspace.
 */
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { SLACK_USERS_PATH } from "../src/paths.js";
import {
  agendaSlackUsers,
  createSeenCollector,
  extractSeenGroups,
  extractSeenSlack,
  groupDirectory,
  knownGroupIds,
  parseMentions,
  parseSlackPermalink,
  readUsersCache,
  resolveMentions,
  updateUsersCache,
  USERS_TTL_MS,
  type SlackUsersCache,
} from "../src/slack-mentions.js";
import * as ca from "../src/chat-actions.js";

const PL = "https://acme.slack.com/archives/C0TESTADS01/p1794277961148039";
const ON = { actions: { ...DEFAULT_CONFIG.actions, chat_write: true, slack_send: true } };
const emptyCache: SlackUsersCache = { users: {}, groups: {} };
const noGroups = { dir: new Map<string, string>(), ids: new Set<string>(), handles: [] as string[] };
const known = { agenda: { slack: { summary: "", items: [], all: [], watch: [], threads: [], dms: [] } }, state: { attention: [], sessions: [] } } as never;
const ctx = (over: Partial<ca.ChatValidateCtx> = {}): ca.ChatValidateCtx => ({ team_domain: "", user_texts: [], seen: [], cache: emptyCache, groups: noGroups, choices: {}, ...over });

describe("parseSlackPermalink", () => {
  it("a message link → its own thread; ?thread_ts → the thread root", () => {
    expect(parseSlackPermalink(PL)).toMatchObject({ domain: "acme", channel: "C0TESTADS01", ts: "1794277961.148039", reply_to: "1794277961.148039" });
    expect(parseSlackPermalink(PL)).not.toHaveProperty("thread_ts");
    const reply = parseSlackPermalink("https://acme.slack.com/archives/C0TESTADS01/p1794278000000100?thread_ts=1794277961.148039&cid=C0TESTADS01");
    expect(reply).toMatchObject({ ts: "1794278000.000100", thread_ts: "1794277961.148039", reply_to: "1794277961.148039" });
    expect((reply as { url: string }).url).toBe("https://acme.slack.com/archives/C0TESTADS01/p1794278000000100?thread_ts=1794277961.148039");
  });
  it("DM (D…) and private / group (G…) channels", () => {
    expect(parseSlackPermalink("https://acme.slack.com/archives/D0TESTDM01/p1794277961148039")).toMatchObject({ channel: "D0TESTDM01", reply_to: "1794277961.148039" });
    expect(parseSlackPermalink("https://acme.slack.com/archives/G0TESTGRP1/p1794277961148039")).toMatchObject({ channel: "G0TESTGRP1" });
  });
  it("another workspace than dashboard.slack_team_domain → refused; junk → refused", () => {
    expect(typeof parseSlackPermalink(PL, "acme")).toBe("object");
    expect(parseSlackPermalink("https://other.slack.com/archives/C0TESTADS01/p1794277961148039", "acme")).toMatch(/다른 워크스페이스/);
    expect(typeof parseSlackPermalink("https://other.slack.com/archives/C0TESTADS01/p1794277961148039", "")).toBe("object"); // no domain set → any
    expect(parseSlackPermalink("https://example.com/archives/C0TESTADS01/p1794277961148039")).toMatch(/Slack 메시지 링크/);
    expect(parseSlackPermalink("see https://acme.slack.com/archives/C0TESTADS01/p1794277961148039")).toMatch(/Slack 메시지 링크/);
  });
});

describe("seen extraction (tool results → ids only)", () => {
  it("permalinks, JSON-ish channel/ts pairs and subteam tokens", () => {
    const out = extractSeenSlack(`Message: 광고 오류 현황\nPermalink: ${PL}\n{"channel":"C0TESTOPS02","ts":"1794200000.000200"}`);
    expect(out).toEqual([
      { channel: "C0TESTADS01", ts: "1794277961.148039", permalink: PL },
      { channel: "C0TESTOPS02", ts: "1794200000.000200" },
    ]);
    expect(extractSeenGroups("cc <!subteam^S0TESTGRP1|@mobile-dev> and <!subteam^S0TESTGRP2>")).toEqual([{ id: "S0TESTGRP1", handle: "mobile-dev" }, { id: "S0TESTGRP2" }]);
  });

  it("collector: only Slack tool results count; errors and other tools are ignored; read_thread input counts", () => {
    const c = createSeenCollector();
    c.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__claude_ai_Slack__slack_search_public_and_private", input: { query: "광고 오류" } }] } });
    c.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "mcp__claude_ai_Gmail__search_threads", input: {} }] } });
    c.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "mcp__claude_ai_Slack__slack_read_thread", input: { channel_id: "C0TESTOPS02", message_ts: "1794100000.000300" } }] } });
    c.onEvent({ type: "assistant", message: { content: [{ type: "tool_use", id: "t4", name: "mcp__claude_ai_Slack__slack_read_channel", input: {} }] } });
    c.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: `결과 1건 ${PL} <!subteam^S0TESTGRP1|@mobile-dev>` }] }] } });
    c.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "https://acme.slack.com/archives/C0TESTNOPE/p1794000000000001" }] } });
    c.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3", content: "thread text" }] } });
    c.onEvent({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t4", is_error: true, content: "https://acme.slack.com/archives/C0TESTERR/p1794000000000002" }] } });
    const r = c.result();
    expect(r.seen.map((x) => x.channel)).toEqual(["C0TESTADS01", "C0TESTOPS02"]);
    expect(r.groups).toEqual([{ id: "S0TESTGRP1", handle: "mobile-dev" }]);
  });
});

describe("resolveMentions", () => {
  const PA = { id: "U0TESTPA01", name: "사람A" };
  const PB = { id: "U0TESTPB01", name: "사람B" };
  it("one candidate → <@U…>, with Korean particles after the name", () => {
    const r = resolveMentions("@사람A님 @사람B님 확인 부탁드려요", parseMentions([{ text: "@사람A", candidates: [PA] }, { text: "@사람B", candidates: [PB] }]), emptyCache, noGroups);
    expect(r.text).toBe("<@U0TESTPA01>님 <@U0TESTPB01>님 확인 부탁드려요");
    expect(r.resolved.map((x) => x.id)).toEqual(["U0TESTPA01", "U0TESTPB01"]);
    expect(r.unresolved).toEqual([]);
    expect(r.bad_ids).toEqual([]);
  });
  it("동명이인 → unresolved until a choice; a choice outside the candidates does not count", () => {
    const m = parseMentions([{ text: "@사람A", candidates: [PA, { id: "U0TESTPA02", name: "사람A", title: "디자인" }] }]);
    expect(resolveMentions("@사람A 확인", m, emptyCache, noGroups).unresolved).toHaveLength(1);
    expect(resolveMentions("@사람A 확인", m, emptyCache, noGroups, { "@사람A": "U0TESTZZ99" }).unresolved).toHaveLength(1);
    const ok = resolveMentions("@사람A 확인", m, emptyCache, noGroups, { "@사람A": "U0TESTPA02" });
    expect(ok.text).toBe("<@U0TESTPA02> 확인");
    // edited out of the text → no choice needed
    expect(resolveMentions("확인 부탁드려요", m, emptyCache, noGroups).unresolved).toEqual([]);
  });
  it("no candidate → kept as text (missing), unless the cache knows exactly one person by that name", () => {
    const r = resolveMentions("@사람C 봐 줘", parseMentions([{ text: "@사람C", candidates: [] }]), emptyCache, noGroups);
    expect(r.text).toBe("@사람C 봐 줘");
    expect(r.missing).toEqual([{ text: "@사람C", kind: "user" }]);
    const cache = { users: { U0TESTPC01: { id: "U0TESTPC01", name: "사람C", at: Date.now() } }, groups: {} };
    expect(resolveMentions("@사람C 봐 줘", parseMentions([{ text: "@사람C", candidates: [] }]), cache, noGroups).text).toBe("<@U0TESTPC01> 봐 줘");
  });
  it("external candidates are marked", () => {
    const r = resolveMentions("@사람X", parseMentions([{ text: "@사람X", candidates: [{ id: "U0TESTEX01", name: "사람X", external: true }] }]), emptyCache, noGroups);
    expect(r.resolved[0]).toMatchObject({ id: "U0TESTEX01", external: true });
  });
  it("ID whitelist: a hand-typed <@U…> must be a candidate or cached; <!subteam^…> a known group", () => {
    const m = parseMentions([{ text: "@사람A", candidates: [PA] }]);
    expect(resolveMentions("@사람A <@U0TESTZZ99>", m, emptyCache, noGroups).bad_ids).toEqual(["U0TESTZZ99"]);
    const cache = { users: { U0TESTPC01: { id: "U0TESTPC01", name: "사람C", at: Date.now() } }, groups: {} };
    const typed = resolveMentions("@사람A <@U0TESTPC01>", m, cache, noGroups);
    expect(typed.bad_ids).toEqual([]);
    expect(typed.resolved.map((x) => x.name)).toEqual(["사람A", "사람C"]);
    expect(resolveMentions("<!subteam^S0TESTGRP9>", [], emptyCache, noGroups).bad_ids).toEqual(["S0TESTGRP9"]);
    expect(resolveMentions("<!subteam^S0TESTGRP9>", [], emptyCache, { ...noGroups, ids: new Set(["S0TESTGRP9"]) }).bad_ids).toEqual([]);
  });
  it("groups: configured id (whitelist) / group_ids map / seen token in the cache / unknown → text + hint", () => {
    const cacheGroups = { S0TESTGRP3: { id: "S0TESTGRP3", handle: "qa", at: Date.now() } };
    const opts = { group_mentions: ["S0TESTGRP1", "mobile-dev"], group_ids: { "design-team": "S0TESTGRP2" }, cache: cacheGroups };
    const groups = { dir: groupDirectory(opts), ids: knownGroupIds(opts), handles: ["mobile-dev"] };
    const m = parseMentions([{ text: "@design-team", group: true, candidates: [] }, { text: "@qa", group: true, candidates: [] }, { text: "@mobile-dev", group: true, candidates: [] }]);
    const r = resolveMentions("@design-team @qa @mobile-dev <!subteam^S0TESTGRP1> 확인", m, emptyCache, groups);
    expect(r.text).toBe("<!subteam^S0TESTGRP2> <!subteam^S0TESTGRP3> @mobile-dev <!subteam^S0TESTGRP1> 확인");
    expect(r.missing).toEqual([{ text: "@mobile-dev", kind: "group" }]);
    expect(r.bad_ids).toEqual([]);
  });
});

describe("users cache (~/.ned/slack-users.json via paths.ts)", () => {
  it("TTL 24h, confirmed candidates + agenda users with ids + seen groups", () => {
    fs.rmSync(SLACK_USERS_PATH, { force: true });
    const t0 = 1_800_000_000_000;
    updateUsersCache({ users: [{ id: "U0TESTPA01", name: "사람A", external: true }], groups: [{ id: "S0TESTGRP1", handle: "@Mobile-Dev" }] }, t0);
    expect(readUsersCache(t0 + 1000).users.U0TESTPA01).toMatchObject({ name: "사람A", external: true });
    expect(readUsersCache(t0 + 1000).groups.S0TESTGRP1.handle).toBe("mobile-dev");
    expect(readUsersCache(t0 + USERS_TTL_MS + 1).users).toEqual({});
    expect(agendaSlackUsers({ items: [{ from: "사람B", from_id: "U0TESTPB01" }, { from: "이름만" }] })).toEqual([{ id: "U0TESTPB01", name: "사람B" }]);
    fs.rmSync(SLACK_USERS_PATH, { force: true });
  });
});

describe("validateChatAction: slack_send targets (a) agenda (b) pasted (c) seen, else 409", () => {
  const block = (url: string, extra: Record<string, unknown> = {}) => ({ kind: "slack_send", target: { url }, text: "확인 부탁드려요", summary: "s", ...extra });
  it("(a) an agenda item → as before", () => {
    const k = { ...(known as object), agenda: { slack: { summary: "", items: [{ channel: "#dev", from: "kim", text: "", url: PL, ts: "", reason: "mention" }], all: [], watch: [], threads: [], dms: [] } } } as never;
    const r = ca.validateChatAction(ON, block(PL), k, undefined, ctx());
    expect(r).toMatchObject({ ok: true, slack: { target_source: "known" }, payload: { ref: { url: PL, title: "#dev · kim" } } });
  });
  it("(b) a permalink the user pasted in this conversation", () => {
    const r = ca.validateChatAction(ON, block(PL), known, undefined, ctx({ user_texts: [`이 스레드에 답해 줘 ${PL}`] }));
    expect(r).toMatchObject({ ok: true, slack: { target_source: "pasted", channel: "C0TESTADS01", thread_ts: "1794277961.148039" } });
    expect((r as ca.ChatActionOk).payload.ref).toMatchObject({ channel: "C0TESTADS01", ts: "1794277961.148039", thread_ts: "1794277961.148039" });
    expect((r as ca.ChatActionOk).target_label).toContain("붙인 링크");
  });
  it("(c) a message the model read (seen_slack), also a reply in a thread it read", () => {
    const seen = [{ channel: "C0TESTADS01", ts: "1794277961.148039", permalink: PL }];
    expect(ca.validateChatAction(ON, block(PL), known, undefined, ctx({ seen }))).toMatchObject({ ok: true, slack: { target_source: "found" } });
    const reply = "https://acme.slack.com/archives/C0TESTADS01/p1794278000000100?thread_ts=1794277961.148039";
    expect(ca.validateChatAction(ON, block(reply), known, undefined, ctx({ seen }))).toMatchObject({ ok: true, slack: { thread_ts: "1794277961.148039" } });
  });
  it("none of them → 409; another workspace → 409; a made-up channel in the same workspace → 409", () => {
    expect(ca.validateChatAction(ON, block(PL), known, undefined, ctx())).toMatchObject({ ok: false, status: 409 });
    expect(ca.validateChatAction(ON, block(PL), known, undefined, ctx({ team_domain: "other", user_texts: [PL] }))).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("다른 워크스페이스") });
    const seen = [{ channel: "C0TESTADS01", ts: "1794277961.148039" }];
    expect(ca.validateChatAction(ON, block("https://acme.slack.com/archives/C0TESTFAKE1/p1794277961148039"), known, undefined, ctx({ seen }))).toMatchObject({ ok: false, status: 409 });
  });
  it("mentions: 동명이인 → 409 멘션 선택 필요 (with the card info), chosen → payload text has the id; bad id → 400", () => {
    const m = [{ text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A" }, { id: "U0TESTPA02", name: "사람A", title: "디자인" }] }];
    const b = block(PL, { text: "@사람A님 확인 부탁드려요", mentions: m });
    const c0 = ctx({ user_texts: [PL] });
    const need = ca.validateChatAction(ON, b, known, undefined, c0);
    expect(need).toMatchObject({ ok: false, status: 409, need_choice: true, error: expect.stringContaining("멘션 선택 필요"), slack: { mentions: { unresolved: [{ text: "@사람A" }] } } });
    const ok = ca.validateChatAction(ON, b, known, undefined, ctx({ user_texts: [PL], choices: { "@사람A": "U0TESTPA02" } }));
    expect(ok).toMatchObject({ ok: true, payload: { text: "<@U0TESTPA02>님 확인 부탁드려요" }, text: "@사람A님 확인 부탁드려요" });
    // the user edits the card text and types an id that is neither a candidate nor cached
    expect(ca.validateChatAction(ON, b, known, "<@U0TESTZZ99> 확인", ctx({ user_texts: [PL], choices: { "@사람A": "U0TESTPA02" } }))).toMatchObject({ ok: false, status: 400, error: expect.stringContaining("U0TESTZZ99") });
    // …or a candidate's id, which is fine
    expect(ca.validateChatAction(ON, b, known, "<@U0TESTPA01> 확인", ctx({ user_texts: [PL], choices: { "@사람A": "U0TESTPA02" } }))).toMatchObject({ ok: true, payload: { text: "<@U0TESTPA01> 확인" } });
  });
  it("external badge: channel_external / an external candidate → external; nothing known → unknown", () => {
    const c0 = ctx({ user_texts: [PL] });
    expect((ca.validateChatAction(ON, block(PL), known, undefined, c0) as ca.ChatActionOk).slack?.external).toBe("unknown");
    expect((ca.validateChatAction(ON, block(PL, { target: { url: PL, channel_external: true } }), known, undefined, c0) as ca.ChatActionOk).slack?.external).toBe("external");
    expect((ca.validateChatAction(ON, block(PL, { channel_external: false }), known, undefined, c0) as ca.ChatActionOk).slack?.external).toBe("internal");
    const ext = block(PL, { text: "@사람X 확인", channel_external: false, mentions: [{ text: "@사람X", candidates: [{ id: "U0TESTEX01", name: "사람X", external: true }] }] });
    expect((ca.validateChatAction(ON, ext, known, undefined, c0) as ca.ChatActionOk).slack?.external).toBe("external");
  });
  it("하루 상한 reached → 429 before anything else is built (sessions excepted)", () => {
    const over = { ok: false as const, error: "오늘 대화창 전송 상한(2) 도달", limit: 2, used: 2 };
    expect(ca.validateChatAction(ON, block(PL), known, undefined, ctx({ user_texts: [PL], over }))).toMatchObject({ ok: false, status: 429, limit: 2, used: 2 });
  });
});

describe("prompt: slack_send rules only when allowed", () => {
  it("mentions / target rules are in the ned-action section with slack_send on, absent with chat_write off", () => {
    const on = ca.chatWriteBlock(ON);
    expect(on).toContain("mentions");
    expect(on).toContain("ID 는 넣지 않는다");
    expect(on).toContain("실제로 읽은");
    expect(ca.chatWriteBlock({ actions: { ...ON.actions, chat_write: false } })).toBe("");
    expect(ca.chatWriteBlock({ actions: { ...ON.actions, slack_send: false } })).not.toContain("slack_send");
  });
});
