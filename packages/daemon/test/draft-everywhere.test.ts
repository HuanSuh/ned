/**
 * 답장 초안 확대 (daemon side): action / draft origin (card · history · watch · chat), the forced "read the thread first"
 * rule for Slack drafts with no / stale (> DRAFT_CTX_FRESH_HOURS) excerpt, and the unchanged send rules
 * (slack_send off → 403, thread_ts → thread reply) — now carrying origin into the action log.
 */
import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { Agenda } from "../src/agenda.js";
import { DEFAULT_CONFIG, type NedConfig } from "../src/config.js";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { loadConfig } = await import("../src/config.js");
const { AGENDA_PATH, CONFIG_PATH } = await import("../src/paths.js");
const { ACTION_ORIGINS, SENT_ACTIONS_LOG, buildActionPrompt, gate, parseOrigin, parseSendRequest } = await import("../src/actions.js");
const { DRAFT_CTX_FRESH_HOURS, agendaContext, buildDraftPrompt, contextRule, draftIdOf, generateDraft, parseDraftRequest, pregenCandidates, refKey } = await import("../src/drafts.js");

const cfg: NedConfig = { ...DEFAULT_CONFIG, draft_context_max_age_minutes: 180 };
const URL1 = "https://x.slack.com/archives/C111/p1700000000000100";
const DM_URL = "https://x.slack.com/archives/D222/p1700000000000200";
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const RULE = "먼저 맥락을 읽는다";

function agendaWith(slackAgeMin: number): Agenda {
  return {
    updated_at: Date.now(), cost_usd: 0, calendar: [], jira: [], github: [],
    slack: { summary: "", items: [{ channel: "dev", from: "kim", text: "can you review?", url: URL1, ts: minsAgo(30), reason: "mention", context: { participants: ["kim"], messages: [{ from: "kim", ts: minsAgo(30), text: "can you review?" }], collected_at: minsAgo(slackAgeMin) } }], all: [], watch: [] },
    mail: { summary: "", unread: 0, unread_capped: false, items: [], all: [] },
  } as Agenda;
}
const writeAgenda = (a: Agenda) => fs.writeFileSync(AGENDA_PATH, JSON.stringify(a));
const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const setActions = (actions: Record<string, boolean>) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions }));
const logLines = () => (fs.existsSync(SENT_ACTIONS_LOG) ? fs.readFileSync(SENT_ACTIONS_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
async function waitJob(id: string) {
  for (let i = 0; i < 100; i++) {
    const j = await (await request(`/api/send/${id}`)).json();
    if (j.state === "done") return j;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`job ${id} never finished`);
}

beforeAll(() => {
  startServer(() => loadConfig());
});

describe("origin", () => {
  it("parseOrigin keeps the known origins and ignores anything else", () => {
    expect([...ACTION_ORIGINS]).toEqual(["chat", "card", "history", "watch", "session", "pet"]);
    for (const o of ACTION_ORIGINS) expect(parseOrigin(o)).toBe(o);
    for (const bad of ["", "CARD", "inbox", 1, null, undefined, {}]) expect(parseOrigin(bad)).toBeUndefined();
  });
  it("parseDraftRequest / parseSendRequest carry a valid origin, drop a bad one", () => {
    for (const o of ACTION_ORIGINS) expect(parseDraftRequest({ source: "slack", ref: { url: URL1 }, origin: o }).origin).toBe(o);
    expect(parseDraftRequest({ source: "slack", ref: { url: URL1 }, origin: "evil" })).not.toHaveProperty("origin");
    expect(parseSendRequest({ source: "slack", mode: "send", text: "x", ref: { url: URL1 }, origin: "history" })).toMatchObject({ origin: "history" });
    expect(parseSendRequest({ source: "slack", mode: "send", text: "x", ref: { url: URL1 }, origin: "nope" })).not.toHaveProperty("origin");
  });
  it("chat_write gates only origin chat", () => {
    const c = { ...DEFAULT_CONFIG, actions: { ...DEFAULT_CONFIG.actions, slack_send: true, chat_write: false } };
    expect(gate({ source: "slack", mode: "send", origin: "chat" }, c)).toEqual({ key: "chat_write", on: false });
    for (const o of ["card", "history", "watch"] as const) expect(gate({ source: "slack", mode: "send", origin: o }, c).on).toBe(true);
  });
  it("draft generation accepts an origin (NED_NO_LLM stub)", async () => {
    writeAgenda(agendaWith(10));
    const r = await generateDraft(parseDraftRequest({ source: "slack", ref: { url: URL1 }, origin: "watch", force: true }), cfg);
    expect(r.drafts).toHaveLength(3);
  });
});

describe("Slack context rule (DRAFT_CTX_FRESH_HOURS)", () => {
  const req = { source: "slack" as const, ref: { url: URL1, thread_ts: "1700000000.000100" } };
  it("is 6 hours", () => expect(DRAFT_CTX_FRESH_HOURS).toBe(6));

  it("fresh excerpt within 6h (but past the fast-path cutoff) → full path without the forced read", () => {
    writeAgenda(agendaWith(4 * 60));
    const ctx = agendaContext(req);
    expect(ctx?.age).toBeGreaterThan(cfg.draft_context_max_age_minutes);
    expect(contextRule(req, null, ctx)).toBe("");
    const { prompt } = buildDraftPrompt(req, cfg, null);
    expect(prompt).not.toContain(RULE);
    expect(prompt).not.toContain("{{CONTEXT_RULE}}");
  });

  it("fast path (fresh excerpt) → no rule, no tools", () => {
    writeAgenda(agendaWith(10));
    const fast = agendaContext(req);
    const { prompt } = buildDraftPrompt(req, cfg, fast);
    expect(prompt).not.toContain(RULE);
    expect(prompt).toContain("도구는 없다");
  });

  it("stale excerpt (> 6h) → read the whole thread (limit 50) first", () => {
    writeAgenda(agendaWith(7 * 60));
    const { prompt } = buildDraftPrompt(req, cfg, null);
    expect(prompt).toContain(RULE);
    expect(prompt).toContain("7시간 전");
    expect(prompt).toMatch(/slack_read_thread` 로 channel_id=`C111`, message_ts=`1700000000\.000100`, limit=50/);
  });

  it("no excerpt at all → forced read too", () => {
    writeAgenda({ ...agendaWith(10), slack: { summary: "", items: [], all: [], watch: [] } } as Agenda);
    const { prompt } = buildDraftPrompt({ source: "slack", ref: { url: "https://x.slack.com/archives/C333/p1700000000000300" } }, cfg, null);
    expect(prompt).toContain("수집된 발췌가 없다");
    expect(prompt).toMatch(/slack_read_thread` 로 channel_id=`C333`, message_ts=`1700000000\.000300`, limit=50/);
  });

  it("DM without a thread → slack_read_channel (limit 50)", () => {
    expect(contextRule({ source: "slack", ref: { url: DM_URL } }, null, null)).toMatch(/slack_read_channel` 로 channel_id=`D222`, limit=50/);
  });

  it("DM without a thread: the whole prompt says read_channel only — guide and rule agree", () => {
    writeAgenda({ ...agendaWith(10), slack: { summary: "", items: [], all: [], watch: [] } } as Agenda);
    const { prompt } = buildDraftPrompt({ source: "slack", ref: { url: DM_URL } }, cfg, null);
    expect(prompt).toContain(RULE);
    expect(prompt).not.toContain("slack_read_thread");
    expect(prompt.match(/slack_read_channel` 로 channel_id=`D222`/g)).toHaveLength(2);
    // a DM reply inside a thread still reads that thread
    const threaded = buildDraftPrompt({ source: "slack", ref: { url: DM_URL, thread_ts: "1699999999.000001" } }, cfg, null).prompt;
    expect(threaded).toContain("slack_read_thread` 로 channel_id=`D222`, message_ts=`1699999999.000001`");
    expect(threaded).not.toContain("slack_read_channel");
  });

  it("other sources never get the rule", () => {
    expect(contextRule({ source: "email", ref: { thread_id: "t" } }, null, null)).toBe("");
    expect(buildDraftPrompt({ source: "jira", ref: { url: "https://a.atlassian.net/browse/AB-1" } }, cfg, null).prompt).not.toContain(RULE);
  });
});

describe("one draft per message, wherever ✎ was pressed (refKey)", () => {
  const watchRef = { url: URL1, channel: "C111", ts: "1700000000.000100", thread_ts: "1700000000.000100", title: "#dev · kim" }; // 팔로업 ✎ (draftref slackRef thread:true)
  const cardRef = { url: URL1, channel: "C111", ts: "1700000000.000100", title: "dev · kim" }; // card / 이력 ✎

  it("팔로업 (thread_ts = ts spelled out) and card / 이력 (none) share the draft id", () => {
    expect(refKey("slack", watchRef)).toBe(refKey("slack", cardRef));
    expect(draftIdOf(refKey("slack", watchRef))).toBe(draftIdOf(refKey("slack", { url: URL1 })));
  });

  it("a pregenerated draft (pregenCandidates ref) is the one a needs_me 팔로업 ✎ opens", () => {
    const [cand] = pregenCandidates(agendaWith(10));
    expect(cand.source).toBe("slack");
    expect(draftIdOf(refKey("slack", watchRef))).toBe(draftIdOf(refKey(cand.source, cand.ref)));
  });

  it("a real thread reply keeps its own key; DMs never get ts as thread", () => {
    expect(refKey("slack", { ...cardRef, thread_ts: "1699999999.000001" })).not.toBe(refKey("slack", cardRef));
    expect(refKey("slack", { url: DM_URL })).toBe("slack:D222::1700000000.000200:");
  });
});

describe("send rules unchanged + origin in the action log", () => {
  beforeEach(() => fs.rmSync(SENT_ACTIONS_LOG, { force: true }));

  it("slack_send off → 403, refusal logged with its origin", async () => {
    setActions({ slack_send: false });
    const r = await request("/api/send", json("POST", { source: "slack", mode: "send", text: "hi", ref: { url: URL1 }, origin: "watch" }));
    expect(r.status).toBe(403);
    expect(logLines()[0]).toMatchObject({ source: "slack", action: "refused", origin: "watch" });
  });

  it("slack_send on → thread reply on thread_ts (dry run), origin kept; /api/actions returns it", async () => {
    setActions({ slack_send: true });
    const r = await request("/api/send", json("POST", { source: "slack", mode: "send", text: "on it", ref: { url: URL1, thread_ts: "1699999999.000001" }, origin: "history" }));
    expect(r.status).toBe(202);
    await waitJob((await r.json()).job_id);
    const e = logLines().at(-1);
    expect(e).toMatchObject({ source: "slack", origin: "history", action: "dry_run:slack_thread_reply C111/1699999999.000001" });
    const built = buildActionPrompt({ source: "slack", mode: "send", text: "on it", ref: { url: URL1, thread_ts: "1699999999.000001" } }, {});
    expect(typeof built === "string" ? built : built.prompt).toContain("thread_ts=`1699999999.000001` (스레드 답글");
    const list = await (await request("/api/actions")).json();
    expect(list.some((x: { origin?: string }) => x.origin === "history")).toBe(true);
  });

  it("a permalink without thread_ts still replies in the message's thread (channel, not DM)", async () => {
    setActions({ slack_send: true });
    const r = await request("/api/send", json("POST", { source: "slack", mode: "send", text: "ok", ref: { url: URL1 }, origin: "card" }));
    await waitJob((await r.json()).job_id);
    expect(logLines().at(-1)).toMatchObject({ origin: "card", action: "dry_run:slack_thread_reply C111/1700000000.000100" });
  });

  it("older entries without origin stay as they are", async () => {
    setActions({ slack_send: false });
    await request("/api/send", json("POST", { source: "slack", mode: "send", text: "hi", ref: { url: URL1 } }));
    expect(logLines()[0]).not.toHaveProperty("origin");
  });

  it("/api/todos: only origin chat takes the chat_write path", async () => {
    setActions({ chat_write: false });
    expect((await request("/api/todos", json("POST", { title: "카드에서", origin: "card" }))).status).toBe(201);
    expect((await request("/api/todos", json("POST", { title: "대화창에서", origin: "chat" }))).status).toBe(403);
  });
});
