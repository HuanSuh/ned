/**
 * 대화창에서 세션 만들기 × ned-action: kind `session_create` is offered only with chat_write + chat_session_create,
 * validateChatAction builds the POST /api/sessions/create payload (repo · worktree · model fixed, prompt = card text),
 * and POST /api/chat/actions/validate also runs the Orca checks (registered repo · cap) — Orca mocked, nothing created.
 */
import fs from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import type { OrcaExec, OrcaResult } from "../src/actions.js";

const captured: { fetch?: (req: Request) => Response | Promise<Response> } = {};
vi.mock("@hono/node-server", () => ({
  serve: (opts: { fetch: (req: Request) => Response | Promise<Response> }) => {
    captured.fetch = opts.fetch;
    return { close() {} };
  },
}));

const { startServer } = await import("../src/server.js");
const { DEFAULT_CONFIG, loadConfig } = await import("../src/config.js");
const { CONFIG_PATH } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG } = await import("../src/actions.js");
const { _resetSendJobs } = await import("../src/send-jobs.js");
const ca = await import("../src/chat-actions.js");
const sc = await import("../src/session-create.js");

const REPO = "/repos/alpha";
const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
const post = (p: string, body: unknown) => request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const setActions = (actions: Record<string, boolean>) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions }));
const cfg = (a: Record<string, boolean>) => ({ ...DEFAULT_CONFIG, actions: { ...DEFAULT_CONFIG.actions, ...a } });
const ON = { chat_write: true, chat_session_create: true };
const known = { agenda: { updated_at: 0 }, state: { sessions: [], attention: [] } } as never;
const BLOCK = { kind: "session_create", target: { repo: REPO, worktree: { mode: "new", name: "login-fix" }, model: "opus" }, text: "로그인 버그를 고쳐줘", summary: "로그인 버그 세션" };

const ok = (result: unknown): OrcaResult => ({ ok: true, json: { ok: true, result }, err: "" });
function mockOrca(terminals: { handle: string }[] = []) {
  const calls: string[][] = [];
  const fn: OrcaExec = async (args) => {
    calls.push(args);
    if (args[0] === "repo") return ok({ repos: [{ id: "r1", path: REPO, kind: "git" }] });
    if (args[0] === "worktree" && args[1] === "list") return ok({ worktrees: [] });
    if (args[0] === "terminal" && args[1] === "list") return ok({ terminals });
    return { ok: false, json: null, err: `unexpected ${args.join(" ")}` };
  };
  return { fn, calls };
}

beforeEach(() => {
  _resetSendJobs();
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  fs.rmSync(sc.CHAT_SESSIONS_PATH, { force: true });
});
afterEach(() => sc._setSessionCreateDeps(null));

describe("prompt: session_create only with both switches", () => {
  it("allowedChatKinds / chatWriteBlock", () => {
    expect(ca.allowedChatKinds(cfg({ chat_session_create: true }))).not.toContain("session_create"); // chat_write off → no block at all
    expect(ca.allowedChatKinds(cfg({ chat_write: true }))).not.toContain("session_create");
    expect(ca.allowedChatKinds(cfg(ON))).toContain("session_create");
    expect(ca.chatWriteBlock(cfg({ chat_write: true }))).not.toContain("session_create");

    sc._setRepoCache([REPO, "/repos/beta"]);
    const block = ca.chatWriteBlock(cfg(ON));
    expect(block).toContain("`session_create`");
    expect(block).toContain(sc.PLAN_FIRST);
    expect(block).toContain("`/repos/alpha`");
    expect(block).toContain("2개까지");
  });
});

describe("validateChatAction session_create", () => {
  const v = (block: unknown, a = ON, text?: string) => ca.validateChatAction(cfg(a), block, known, text);

  it("builds the /api/sessions/create payload; repo/worktree/model come from the block, the prompt from the card", () => {
    const r = v(BLOCK, ON, "  고친 프롬프트  ");
    expect(r).toMatchObject({ ok: true, kind: "session_create", endpoint: "/api/sessions/create", text: "고친 프롬프트", max_wait_ms: 8 * 60_000 });
    if (!r.ok) return;
    expect(r.payload).toEqual({ repo: REPO, worktree: { mode: "new", name: "login-fix" }, model: "opus", prompt: `${sc.PLAN_FIRST}\n\n고친 프롬프트`, origin: "chat" });
    expect(r.target_label).toContain("레포 alpha (/repos/alpha)");
    expect(r.target_label).toContain("새 워크트리 login-fix");
    expect(r.target_label).toContain("모델 opus");
    expect(r.target_label).toContain("자동 포함");
    expect(r.match).toEqual({ source: "session", mode: "create", ref: { title: "alpha · 새 login-fix", repo: REPO }, text: `${sc.PLAN_FIRST}\n\n고친 프롬프트` });
    // already starts with the sentence → no note
    const r2 = v(BLOCK, ON, `${sc.PLAN_FIRST} 그다음 X`);
    expect(r2.ok && r2.target_label).not.toContain("자동 포함");
  });

  it("flat block form {repo, worktree, model, prompt}; model defaults to opus", () => {
    const r = v({ kind: "session_create", repo: REPO, worktree: { mode: "existing", name: "feat" }, prompt: "이어서 해줘" });
    expect(r).toMatchObject({ ok: true, payload: { model: "opus", worktree: { mode: "existing", name: "feat" } } });
    expect(r.ok && r.target_label).toContain("기존 워크트리 feat");
  });

  it("refusals: switches, bad fields, long prompt", () => {
    expect(v(BLOCK, { chat_write: true })).toMatchObject({ ok: false, status: 403 });
    expect(v(BLOCK, { chat_session_create: true })).toMatchObject({ ok: false, status: 403 });
    expect(v({ ...BLOCK, target: { ...BLOCK.target, model: "haiku" } })).toMatchObject({ ok: false, status: 400 });
    expect(v({ ...BLOCK, target: { ...BLOCK.target, repo: "relative" } })).toMatchObject({ ok: false, status: 400 });
    expect(v({ ...BLOCK, text: "" })).toMatchObject({ ok: false, status: 400 });
    expect(v(BLOCK, ON, "x".repeat(5000))).toMatchObject({ ok: true }); // > 4000 is fine for a prompt
    expect(v(BLOCK, ON, "x".repeat(8001))).toMatchObject({ ok: false, status: 400 });
  });
});

describe("routes", () => {
  beforeAll(() => {
    startServer(() => loadConfig());
  });

  it("POST /api/chat/actions/validate runs the Orca checks: unregistered repo 400, cap 409, else 200 + payload", async () => {
    setActions(ON);
    sc._setSessionCreateDeps({ orca: mockOrca().fn });
    let r = await post("/api/chat/actions/validate", { block: { ...BLOCK, target: { ...BLOCK.target, repo: "/repos/gamma" } } });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("등록된 레포가 아니야");

    r = await post("/api/chat/actions/validate", { block: BLOCK, text: "고쳐줘" });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ ok: true, endpoint: "/api/sessions/create", payload: { repo: REPO, origin: "chat" } });

    fs.writeFileSync(sc.CHAT_SESSIONS_PATH, JSON.stringify(["a", "b"].map((n) => ({ job_id: n, created_at: Date.now(), repo: REPO, mode: "new", name: n, model: "opus", worktree_path: `/wt/${n}`, handle: `term_${n}` }))));
    sc._setSessionCreateDeps({ orca: mockOrca([{ handle: "term_a" }, { handle: "term_b" }]).fn });
    r = await post("/api/chat/actions/validate", { block: BLOCK });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toContain("최대 2");
    expect(fs.existsSync(SENT_ACTIONS_LOG)).toBe(false); // validate never logs or writes
  });

  it("POST /api/sessions/create with origin chat also needs chat_write (403, logged)", async () => {
    setActions({ chat_session_create: true, chat_write: false });
    const m = mockOrca();
    sc._setSessionCreateDeps({ orca: m.fn, sleep: async () => {}, allowWrites: true });
    const r = await post("/api/sessions/create", { repo: REPO, worktree: { mode: "new", name: "x" }, prompt: "p", origin: "chat" });
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain("chat_write");
    expect(m.calls.some((c) => c[1] === "create")).toBe(false);
  });
});
