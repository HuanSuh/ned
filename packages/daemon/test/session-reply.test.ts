/**
 * 세션에 답하기 (server side): can_reply on the session view, POST /api/send source "session" text checks, the mocked Orca
 * send (never a real `orca terminal send`), the "입력 대기" alert suppressed after a reply, dashboard.session_quick_replies
 * normalize / PUT 400, and GET /api/feed quick_replies for the pet. serve is mocked (no port).
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
const { DEFAULT_DASHBOARD, loadConfig, normalizeDashboard, normalizeQuickReplies, quickRepliesError } = await import("../src/config.js");
const { CONFIG_PATH, DISMISSED_PATH, EVENTS_DIR, localDay } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG, SESSION_TEXT_MAX, _setSessionOrca, parseSendRequest, readActionLog } = await import("../src/actions.js");
const { reduceSessions } = await import("../src/sessions.js");
const { refreshSessions } = await import("../src/heartbeat.js");
const { readState } = await import("../src/state.js");
const { _resetSendJobs } = await import("../src/send-jobs.js");

const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function waitJob(id: string) {
  for (let i = 0; i < 100; i++) {
    const j = await (await request(`/api/send/${id}`)).json();
    if (j.state === "done") return j;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error(`job ${id} never finished`);
}

const T0 = Date.now() - 60_000;
const ev = (event: string, ts: number, extra: Record<string, unknown> = {}) => ({ event, ts, session_id: "sess-1", cwd: "/w/fb-74", ...extra });
function writeEvents(evs: object[]) {
  fs.writeFileSync(path.join(EVENTS_DIR, `${localDay(new Date())}.jsonl`), evs.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
/** A scripted orca: `terminal list` returns `terms`, `terminal send` answers `sendOk`. Records every call. */
function mockOrca(terms: object[], sendOk = true) {
  const calls: string[][] = [];
  const fn = async (args: string[]) => {
    calls.push(args);
    if (args[1] === "list") return { ok: true, json: { result: { terminals: terms } }, err: "" };
    if (args[1] === "send") return sendOk ? { ok: true, json: { ok: true }, err: "" } : { ok: false, json: null, err: "boom" };
    return { ok: false, json: null, err: "unexpected" };
  };
  return { fn, calls };
}

beforeAll(() => {
  startServer(() => loadConfig());
});
beforeEach(() => {
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  fs.rmSync(DISMISSED_PATH, { force: true });
  fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off" }));
  _setSessionOrca();
  _resetSendJobs();
});

describe("can_reply", () => {
  it("true once any event of the session carried orca_pane / orca_tab, false without", () => {
    const [a] = reduceSessions([ev("SessionStart", T0), ev("Notification", T0 + 1, { message: "Claude needs your permission" })], 180, T0 + 10);
    expect(a.can_reply).toBe(false);
    const [b] = reduceSessions([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1)], 180, T0 + 10);
    expect(b.can_reply).toBe(true);
    const [c] = reduceSessions([ev("UserPromptSubmit", T0, { orca_tab: "tab1" })], 180, T0 + 10);
    expect(c.can_reply).toBe(true);
  });

  it("is on the session view in GET /api/state", async () => {
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1, { message: "허락해 줘" })]);
    refreshSessions(loadConfig());
    const st = await (await request("/api/state")).json();
    expect(st.sessions[0]).toMatchObject({ id: "sess-1", status: "waiting", can_reply: true });
  });
});

describe("notification_type (권한·선택 대화상자)", () => {
  it("the waiting Notification's type is on the session view, cleared once the session moves on", async () => {
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1, { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })]);
    refreshSessions(loadConfig());
    const st = await (await request("/api/state")).json();
    expect(st.sessions[0]).toMatchObject({ status: "waiting", notification_type: "permission_prompt" });
    const [after] = reduceSessions([ev("Notification", T0, { notification_type: "permission_prompt" }), ev("UserPromptSubmit", T0 + 1)], 180, T0 + 10);
    expect(after.notification_type).toBeNull();
    const [idle] = reduceSessions([ev("Notification", T0, { notification_type: "idle_prompt" })], 180, T0 + 10);
    expect(idle.notification_type).toBe("idle_prompt");
  });

  it("POST /api/send to a session showing a permission prompt → 409 without touching orca (Enter would confirm the highlighted option)", async () => {
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1, { notification_type: "permission_prompt" })]);
    refreshSessions(loadConfig());
    const m = mockOrca([{ handle: "term_x", tabId: "tab1", leafId: "leaf1" }]);
    _setSessionOrca(m.fn);
    const r = await request("/api/send", json("POST", { source: "session", mode: "session", text: "거절", ref: { session_id: "sess-1" } }));
    const done = await waitJob((await r.json()).job_id);
    expect(done.result).toMatchObject({ ok: false, http_status: 409 });
    expect(done.result.error).toContain("permission_prompt");
    expect(m.calls).toEqual([]);
    expect(readState().attention.map((a) => a.id)).toContain("session:sess-1");
  });

  it("an idle_prompt wait is answerable as usual", async () => {
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1, { notification_type: "idle_prompt" })]);
    refreshSessions(loadConfig());
    _setSessionOrca(mockOrca([{ handle: "term_x", tabId: "tab1", leafId: "leaf1" }]).fn);
    const r = await request("/api/send", json("POST", { source: "session", mode: "session", text: "계속", ref: { session_id: "sess-1" } }));
    expect((await waitJob((await r.json()).job_id)).result).toMatchObject({ ok: true, http_status: 200 });
  });
});

describe("POST /api/send — session text", () => {
  it("parseSendRequest: empty / whitespace → text required; > 2,000 chars → 400; trailing newlines dropped, inner kept", () => {
    expect(parseSendRequest({ source: "session", mode: "session", text: "  \n ", ref: { session_id: "s" } })).toBe("text required");
    expect(parseSendRequest({ source: "session", mode: "session", text: "x".repeat(SESSION_TEXT_MAX + 1), ref: { session_id: "s" } })).toBe(`text longer than ${SESSION_TEXT_MAX} chars`);
    expect(parseSendRequest({ source: "session", mode: "session", text: "x".repeat(SESSION_TEXT_MAX), ref: { session_id: "s" } })).toMatchObject({ text: "x".repeat(SESSION_TEXT_MAX) });
    expect(parseSendRequest({ source: "session", mode: "session", text: "첫 줄\r\n둘째 줄\n\n", ref: { session_id: "s" } })).toMatchObject({ text: "첫 줄\n둘째 줄" });
    // other sources keep the 4,000 limit
    expect(parseSendRequest({ source: "slack", mode: "send", text: "x".repeat(3000), ref: { channel: "C1" } })).toMatchObject({ source: "slack" });
  });

  it("400 over HTTP for empty and over-long session text", async () => {
    expect((await request("/api/send", json("POST", { source: "session", mode: "session", text: "", ref: { session_id: "sess-1" } }))).status).toBe(400);
    expect((await request("/api/send", json("POST", { source: "session", mode: "session", text: "y".repeat(2001), ref: { session_id: "sess-1" } }))).status).toBe(400);
  });

  it("sends to the matched terminal once (text + --enter), logs origin, and clears the session's 입력 대기 alert", async () => {
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1, { message: "허락해 줘" })]);
    refreshSessions(loadConfig());
    expect(readState().attention.map((a) => a.id)).toContain("session:sess-1");
    const m = mockOrca([{ handle: "term_x", tabId: "tab1", leafId: "leaf1", title: "fb-74", worktreePath: "/w/fb-74" }]);
    _setSessionOrca(m.fn);
    const r = await request("/api/send", json("POST", { source: "session", mode: "session", text: "ㄱㄱ", ref: { session_id: "sess-1" }, origin: "session" }));
    expect(r.status).toBe(202);
    const done = await waitJob((await r.json()).job_id);
    expect(done.result).toMatchObject({ ok: true, http_status: 200, action: "orca_terminal_send term_x" });
    const sends = m.calls.filter((a) => a[1] === "send");
    expect(sends).toEqual([["terminal", "send", "--terminal", "term_x", "--text", "ㄱㄱ", "--enter", "--json"]]);
    expect(readActionLog(5)[0]).toMatchObject({ source: "session", mode: "session", ok: true, text: "ㄱㄱ", origin: "session", ref: { session_id: "sess-1" } });
    // answered: gone from attention now, and the next refresh (same Notification) doesn't bring it back
    expect(readState().attention.map((a) => a.id)).not.toContain("session:sess-1");
    refreshSessions(loadConfig());
    expect(readState().attention.map((a) => a.id)).not.toContain("session:sess-1");
    // the session asks again (new Notification) → the alert is back
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1), ev("UserPromptSubmit", T0 + 2, { prompt: "ㄱㄱ" }), ev("Notification", T0 + 3, { message: "또 허락해 줘" })]);
    refreshSessions(loadConfig());
    expect(readState().attention.map((a) => a.id)).toContain("session:sess-1");
  });

  it("a running session takes a message too (추가 지시)", async () => {
    writeEvents([ev("UserPromptSubmit", T0, { orca_pane: "tab1:leaf1", prompt: "go" })]);
    refreshSessions(loadConfig());
    expect(readState().sessions[0].status).toBe("running");
    _setSessionOrca(mockOrca([{ handle: "term_x", tabId: "tab1", leafId: "leaf1" }]).fn);
    const r = await request("/api/send", json("POST", { source: "session", mode: "session", text: "테스트도 돌려 줘", ref: { session_id: "sess-1" } }));
    expect((await waitJob((await r.json()).job_id)).result).toMatchObject({ ok: true, http_status: 200 });
  });

  it("409 when the recorded terminal isn't open; the alert stays", async () => {
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1)]);
    refreshSessions(loadConfig());
    const m = mockOrca([{ handle: "term_other", tabId: "tab9", leafId: "leaf9" }]);
    _setSessionOrca(m.fn);
    const r = await request("/api/send", json("POST", { source: "session", mode: "session", text: "승인", ref: { session_id: "sess-1" } }));
    const done = await waitJob((await r.json()).job_id);
    expect(done.result).toMatchObject({ ok: false, http_status: 409 });
    expect(m.calls.some((a) => a[1] === "send")).toBe(false);
    expect(readState().attention.map((a) => a.id)).toContain("session:sess-1");
  });

  it("502 when orca terminal send fails; the alert stays", async () => {
    writeEvents([ev("SessionStart", T0, { orca_pane: "tab1:leaf1" }), ev("Notification", T0 + 1)]);
    refreshSessions(loadConfig());
    _setSessionOrca(mockOrca([{ handle: "term_x", tabId: "tab1", leafId: "leaf1" }], false).fn);
    const r = await request("/api/send", json("POST", { source: "session", mode: "session", text: "계속", ref: { session_id: "sess-1" } }));
    expect((await waitJob((await r.json()).job_id)).result).toMatchObject({ ok: false, http_status: 502 });
    expect(readState().attention.map((a) => a.id)).toContain("session:sess-1");
  });
});

describe("dashboard.session_quick_replies", () => {
  it("defaults to ㄱㄱ · 승인 · 계속", () => {
    expect(DEFAULT_DASHBOARD.session_quick_replies).toEqual(["ㄱㄱ", "승인", "계속"]);
    expect(normalizeDashboard({}).session_quick_replies).toEqual(["ㄱㄱ", "승인", "계속"]);
  });

  it("normalize: trims, drops empty / duplicate, ≤ 20 chars, ≤ 5; absent keeps base; [] allowed; comma string accepted", () => {
    expect(normalizeQuickReplies([" 좋아 ", "", "좋아", "a\nb", "x".repeat(25), "1", "2", "3", "4"])).toEqual(["좋아", "a b", "x".repeat(20), "1", "2"]);
    expect(normalizeQuickReplies(undefined, ["keep"])).toEqual(["keep"]);
    expect(normalizeQuickReplies([])).toEqual([]);
    expect(normalizeQuickReplies("ㄱㄱ, 승인 ,")).toEqual(["ㄱㄱ", "승인"]);
    expect(normalizeQuickReplies(42, ["keep"])).toEqual(["keep"]);
    expect(normalizeDashboard({ theme: "dark" }, { ...DEFAULT_DASHBOARD, session_quick_replies: ["mine"] }).session_quick_replies).toEqual(["mine"]);
  });

  it("quickRepliesError: too many / too long / not a list → message; fine → null", () => {
    expect(quickRepliesError({})).toBeNull();
    expect(quickRepliesError({ session_quick_replies: ["a", "b"] })).toBeNull();
    expect(quickRepliesError({ session_quick_replies: ["1", "2", "3", "4", "5", "6"] })).toContain("5개");
    expect(quickRepliesError({ session_quick_replies: ["x".repeat(21)] })).toContain("20자");
    expect(quickRepliesError({ session_quick_replies: "a,b" })).toContain("목록");
  });

  it("PUT /api/config: 400 with the field for a bad list, saves a good one, and GET /api/feed hands it to the pet", async () => {
    const bad = await request("/api/config", json("PUT", { dashboard: { session_quick_replies: ["1", "2", "3", "4", "5", "6"] } }));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ field: "dashboard.session_quick_replies" });
    const ok = await request("/api/config", json("PUT", { dashboard: { session_quick_replies: ["진행해", "아니"] } }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).dashboard.session_quick_replies).toEqual(["진행해", "아니"]);
    expect(loadConfig().dashboard.session_quick_replies).toEqual(["진행해", "아니"]);
    // a dashboard PUT that doesn't name it keeps it
    await request("/api/config", json("PUT", { dashboard: { theme: "dark" } }));
    expect(loadConfig().dashboard.session_quick_replies).toEqual(["진행해", "아니"]);
    const feed = await (await request("/api/feed")).json();
    expect(feed).toMatchObject({ quick_replies: ["진행해", "아니"], session_send: true });
  });
});
