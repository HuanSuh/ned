/**
 * 대화창에서 세션 만들기 (src/session-create.ts + POST /api/sessions/create). Orca 는 전부 모킹 — 실제 워크트리
 * 생성·터미널 전송은 하지 않는다 (deps.orca 주입). serve 도 모킹(포트 없음).
 */
import fs from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
const { DEFAULT_CONFIG, DEFAULT_ACTIONS, loadConfig } = await import("../src/config.js");
const { CONFIG_PATH } = await import("../src/paths.js");
const { SENT_ACTIONS_LOG } = await import("../src/actions.js");
const { _resetSendJobs } = await import("../src/send-jobs.js");
const sc = await import("../src/session-create.js");
const { CHAT_SESSIONS_PATH, PLAN_FIRST, parseSessionCreate, validateSessionCreate, runSessionCreate, startSessionCreate, annotateChatOrigin, bootState, hasActivity, pickHandle, readChatSessions, _setSessionCreateDeps } = sc;

const REPO = "/repos/alpha";
const WT = "/wt/alpha-feat";
const cfgOn = { ...DEFAULT_CONFIG, actions: { ...DEFAULT_ACTIONS, chat_session_create: true } };
const logLines = () => (fs.existsSync(SENT_ACTIONS_LOG) ? fs.readFileSync(SENT_ACTIONS_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

const ok = (result: unknown): OrcaResult => ({ ok: true, json: { ok: true, result }, err: "" });
const READY_SCREEN = ["", "─────────", "❯ ", "─────────", "  ⏵⏵ auto mode on (shift+tab to cycle)"];
const BOOT_SCREEN = ["", " Claude Code starting…"];
const BUSY_SCREEN = ["⏺ 계획부터 세울게요.", "✻ Thinking… (3s · esc to interrupt)", "❯ "];

interface MockOpts {
  terminals?: { handle: string; connected?: boolean; status?: string }[];
  bootReads?: number;
  boot?: string[];
  after?: { tail: string[]; draft?: string };
  createFail?: boolean;
  sendReceipt?: unknown;
}
/** A scripted orca: records every call. Reads before the send show boot → ready; reads after show `after`. */
function mockOrca(o: MockOpts = {}) {
  const calls: string[][] = [];
  let reads = 0;
  let sent = false;
  const fn: OrcaExec = async (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === "repo" && b === "list") return ok({ repos: [{ id: "r1", path: REPO, kind: "git" }, { id: "r2", path: "/repos/beta", kind: "git" }] });
    if (a === "worktree" && b === "list") return ok({ worktrees: [{ id: `r1::${REPO}`, repoId: "r1", path: REPO, branch: "refs/heads/main", isMainWorktree: true }, { id: `r1::${WT}`, repoId: "r1", path: WT, branch: "refs/heads/huansuh/feat", displayName: "feat" }] });
    if (a === "terminal" && b === "list") return ok({ terminals: o.terminals ?? [] });
    if (a === "worktree" && b === "create") return o.createFail ? { ok: false, json: null, err: "boom" } : ok({ worktree: { id: `r1::${WT}`, path: WT }, launch: { outcome: { kind: "terminal", handle: "term_new" } } });
    if (a === "agent" && b === "launch") return ok({ outcome: { kind: "terminal", handle: "term_ex" } });
    if (a === "terminal" && b === "read") {
      reads++;
      if (sent) return ok({ terminal: { handle: "t", status: "running", tail: o.after?.tail ?? BUSY_SCREEN, draft: o.after?.draft ?? "" } });
      const booting = reads <= (o.bootReads ?? 1);
      return ok({ terminal: { handle: "t", status: "running", tail: booting ? BOOT_SCREEN : (o.boot ?? READY_SCREEN), draft: "" } });
    }
    if (a === "terminal" && b === "send") {
      sent = true;
      return ok(o.sendReceipt ?? { accepted: true, stages: ["input_accepted", "turn_started"] });
    }
    return { ok: false, json: null, err: `unexpected ${args.join(" ")}` };
  };
  return { fn, calls };
}
const deps = (m: ReturnType<typeof mockOrca>, extra: Partial<Parameters<typeof runSessionCreate>[3]> = {}) => ({ orca: m.fn, sleep: async () => {}, bootTimeoutMs: 50, activityTimeoutMs: 20, pollMs: 0, allowWrites: true, ...extra });
const input = (over: Record<string, unknown> = {}) => {
  const p = parseSessionCreate({ repo: REPO, worktree: { mode: "new", name: "alpha-feat" }, prompt: "로그인 버그 고쳐줘", ...over });
  if (typeof p === "string") throw new Error(p);
  return p;
};

beforeEach(() => {
  _resetSendJobs();
  fs.rmSync(SENT_ACTIONS_LOG, { force: true });
  fs.rmSync(CHAT_SESSIONS_PATH, { force: true });
});

describe("parseSessionCreate", () => {
  it("defaults model to opus and puts the plan-first sentence first", () => {
    const p = input();
    expect(p.model).toBe("opus");
    expect(p.prompt.startsWith(PLAN_FIRST)).toBe(true);
    expect(p.prompt).toContain("로그인 버그 고쳐줘");
    // already starts with it → unchanged (not doubled)
    const q = input({ prompt: `${PLAN_FIRST} 그 다음 X` });
    expect(q.prompt).toBe(`${PLAN_FIRST} 그 다음 X`);
  });
  it("rejects bad input", () => {
    expect(parseSessionCreate({ repo: "rel/path", worktree: { mode: "new", name: "a" }, prompt: "x" })).toMatch(/absolute/);
    expect(parseSessionCreate({ repo: REPO, worktree: { mode: "new", name: "bad name!" }, prompt: "x" })).toMatch(/worktree.name/);
    expect(parseSessionCreate({ repo: REPO, worktree: { mode: "weird", name: "a" }, prompt: "x" })).toMatch(/mode/);
    expect(parseSessionCreate({ repo: REPO, worktree: { mode: "new", name: "a" }, prompt: "x", model: "haiku" })).toMatch(/model/);
    expect(parseSessionCreate({ repo: REPO, worktree: { mode: "new", name: "a" }, prompt: " " })).toMatch(/prompt required/);
  });
});

describe("validateSessionCreate", () => {
  it("403 while the toggle is off (default)", async () => {
    expect(DEFAULT_ACTIONS.chat_session_create).toBe(false);
    const v = await validateSessionCreate(input(), DEFAULT_CONFIG, { orca: mockOrca().fn });
    expect(v).toMatchObject({ ok: false, status: 403 });
  });
  it("only Orca-registered repos", async () => {
    const v = await validateSessionCreate(input({ repo: "/repos/gamma" }), cfgOn, { orca: mockOrca().fn });
    expect(v).toMatchObject({ ok: false, status: 400 });
    expect((v as { detail: string }).detail).toContain("등록된 레포가 아니야");
    expect(await validateSessionCreate(input({ repo: "/repos/beta/" }), cfgOn, { orca: mockOrca().fn })).toMatchObject({ ok: true });
  });
  it("existing worktree must exist in that repo (by name / dir / branch)", async () => {
    const m = mockOrca();
    expect(await validateSessionCreate(input({ worktree: { mode: "existing", name: "feat" } }), cfgOn, { orca: m.fn })).toMatchObject({ ok: true, existing: { path: WT } });
    expect(await validateSessionCreate(input({ worktree: { mode: "existing", name: "alpha-feat" } }), cfgOn, { orca: m.fn })).toMatchObject({ ok: true, existing: { path: WT } });
    expect(await validateSessionCreate(input({ worktree: { mode: "existing", name: "nope" } }), cfgOn, { orca: m.fn })).toMatchObject({ ok: false, status: 400 });
  });
  it("cap: 2 chat-origin sessions still alive → 409; an exited one doesn't count", async () => {
    const recs = [
      { job_id: "j1", created_at: Date.now(), repo: REPO, mode: "new", name: "a", model: "opus", worktree_path: "/wt/a", handle: "term_a" },
      { job_id: "j2", created_at: Date.now(), repo: REPO, mode: "new", name: "b", model: "opus", worktree_path: "/wt/b", handle: "term_b" },
    ];
    fs.writeFileSync(CHAT_SESSIONS_PATH, JSON.stringify(recs));
    const both = mockOrca({ terminals: [{ handle: "term_a" }, { handle: "term_b", connected: true }] });
    const v = await validateSessionCreate(input(), cfgOn, { orca: both.fn });
    expect(v).toMatchObject({ ok: false, status: 409 });
    expect((v as { detail: string }).detail).toContain("최대 2");
    const one = mockOrca({ terminals: [{ handle: "term_a" }, { handle: "term_b", status: "exited" }] });
    expect(await validateSessionCreate(input(), cfgOn, { orca: one.fn })).toMatchObject({ ok: true, live: 1 });
  });
  it("cap fallback when orca terminal list fails: live state sessions in those worktrees", async () => {
    fs.writeFileSync(CHAT_SESSIONS_PATH, JSON.stringify([{ job_id: "j1", created_at: Date.now(), repo: REPO, mode: "new", name: "a", model: "opus", worktree_path: "/wt/a", handle: "term_a" }, { job_id: "j2", created_at: Date.now(), repo: REPO, mode: "new", name: "b", model: "opus", worktree_path: "/wt/b", handle: "term_b" }]));
    const m = mockOrca();
    const failing: OrcaExec = (args, t) => (args[0] === "terminal" && args[1] === "list" ? Promise.resolve({ ok: false, json: null, err: "down" }) : m.fn(args, t));
    const sessions = [{ cwd: "/wt/a/pkg", orca_worktree: null, status: "running" as const }, { cwd: "/wt/b", orca_worktree: null, status: "done" as const }];
    expect(await validateSessionCreate(input(), cfgOn, { orca: failing }, sessions as never)).toMatchObject({ ok: false, status: 409 });
  });
});

describe("runSessionCreate", () => {
  const run = async (m: ReturnType<typeof mockOrca>, inp = input(), extra = {}) => {
    const v = await validateSessionCreate(inp, cfgOn, { orca: m.fn });
    if (!v.ok) throw new Error(v.detail);
    const job: { id: string; stage?: string } = { id: "job-1" };
    return { res: await runSessionCreate(inp, v.repo, v.existing, deps(m, extra), job), job };
  };

  it("new worktree: create (no --prompt) → wait for boot → send with --wait-submit → confirm", async () => {
    const m = mockOrca({ bootReads: 2 });
    const { res, job } = await run(m);
    expect(res).toMatchObject({ ok: true, status: 200, action: "session_create", session: { handle: "term_new", worktree_path: WT, stage: "done" } });
    const create = m.calls.find((c) => c[0] === "worktree" && c[1] === "create")!;
    expect(create).toEqual(expect.arrayContaining(["--name", "alpha-feat", "--repo", `path:${REPO}`, "--parent-worktree", `path:${REPO}`, "--agent", "claude", "--model", "opus"]));
    expect(m.calls.flat()).not.toContain("--prompt");
    const send = m.calls.find((c) => c[0] === "terminal" && c[1] === "send")!;
    expect(send).toEqual(expect.arrayContaining(["--terminal", "term_new", "--enter", "--wait-submit", "15", "--text"]));
    expect(send[send.indexOf("--text") + 1].startsWith(PLAN_FIRST)).toBe(true);
    // boot polled until ready, before the send
    const firstSend = m.calls.findIndex((c) => c[1] === "send");
    expect(m.calls.slice(0, firstSend).filter((c) => c[1] === "read").length).toBe(3);
    expect(job.stage).toBe("submit_confirm");
    expect(readChatSessions()).toEqual([expect.objectContaining({ job_id: "job-1", handle: "term_new", worktree_path: WT, ok: true })]);
    const [entry] = logLines();
    expect(entry).toMatchObject({ source: "session", mode: "create", action: "session_create", origin: "chat", ok: true, session_create: { repo: REPO, worktree_mode: "new", model: "opus", handle: "term_new" } });
  });

  it("existing worktree: orca agent launch in that path", async () => {
    const m = mockOrca();
    const { res } = await run(m, input({ worktree: { mode: "existing", name: "feat" }, model: "sonnet" }));
    expect(res.ok).toBe(true);
    expect(m.calls.find((c) => c[0] === "agent")).toEqual(expect.arrayContaining(["launch", "--agent", "claude", "--worktree", `path:${WT}`, "--model", "sonnet"]));
    expect(m.calls.some((c) => c[1] === "create")).toBe(false);
  });

  it("failure reasons by stage", async () => {
    let r = (await run(mockOrca({ createFail: true }))).res;
    expect(r).toMatchObject({ ok: false, status: 502, session: { stage: "worktree_create" } });
    expect(r.detail).toContain("[워크트리 만들기]");
    expect(readChatSessions()).toHaveLength(0); // nothing was created → no record, no cap slot

    r = (await run(mockOrca({ bootReads: Number.MAX_SAFE_INTEGER }))).res;
    expect(r).toMatchObject({ ok: false, session: { stage: "agent_boot" } });
    expect(r.detail).toContain("에이전트가 뜨지 않았어");

    r = (await run(mockOrca({ boot: ["Do you trust the files in this folder?", "❯ 1. Yes, proceed"] }))).res;
    expect(r).toMatchObject({ ok: false, status: 409, session: { stage: "agent_boot" } });

    r = (await run(mockOrca({ after: { tail: READY_SCREEN, draft: "먼저 계획을…" } }))).res;
    expect(r).toMatchObject({ ok: false, session: { stage: "submit_confirm" } });
    expect(r.detail).toContain("초안으로 남아");

    r = (await run(mockOrca({ after: { tail: READY_SCREEN }, sendReceipt: { accepted: true, stages: ["input_accepted"] } }))).res;
    expect(r).toMatchObject({ ok: false, session: { stage: "submit_confirm" } });
    expect(r.detail).toContain("활동이 안 보여");
  });

  it("no activity on screen but the receipt proved turn_started → ok", async () => {
    const r = (await run(mockOrca({ after: { tail: READY_SCREEN } }))).res;
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("turn_started");
  });

  it("dry run (allowWrites false): no create / launch / send", async () => {
    const m = mockOrca();
    const r = (await run(m, input(), { allowWrites: false })).res;
    expect(r.action).toBe("dry_run:session_create");
    expect(m.calls.some((c) => ["create", "launch", "send"].includes(c[1]))).toBe(false);
  });
});

describe("submission / boot heuristics", () => {
  it("bootState + activity", () => {
    expect(bootState({ text: READY_SCREEN.join("\n") })).toBe("ready");
    expect(bootState({ text: BOOT_SCREEN.join("\n") })).toBe("booting");
    expect(bootState({ text: "x", status: "exited" })).toBe("exited");
    expect(hasActivity(BUSY_SCREEN.join("\n"))).toBe(true);
    expect(hasActivity(READY_SCREEN.join("\n"))).toBe(false);
  });
  it("pickHandle: launch.outcome / legacy agentTerminalHandle / nested", () => {
    expect(pickHandle({ result: { launch: { outcome: { handle: "term_a", kind: "terminal" } } } })).toEqual({ handle: "term_a", kind: "terminal" });
    expect(pickHandle({ result: { agentTerminalHandle: "term_b" } }).handle).toBe("term_b");
    expect(pickHandle({ result: { x: { y: { handle: "term_c" } } } }).handle).toBe("term_c");
  });
});

describe("state origin mapping", () => {
  it("sessions whose cwd / Orca worktree is a chat-started worktree get origin chat + the terminal handle", () => {
    const recs = [{ job_id: "j", created_at: Date.now(), repo: REPO, mode: "new" as const, name: "f", model: "opus", worktree_path: WT, handle: "term_new" }];
    const base = { status: "running", since: 0, last_event_ts: 0, last_prompt: null, last_summary: null, subagents_active: 0, alert_ts: null, is_worker: false, worktree: "w" };
    const out = annotateChatOrigin([
      { ...base, id: "s1", cwd: `${WT}/packages/x`, orca_worktree: null },
      { ...base, id: "s2", cwd: "", orca_worktree: `r1::${WT}` },
      { ...base, id: "s3", cwd: `${WT}-other`, orca_worktree: null },
    ] as never, recs);
    expect(out.map((s) => s.origin ?? null)).toEqual(["chat", "chat", null]);
    expect(out[0].origin_terminal).toBe("term_new");
  });
});

describe("POST /api/sessions/create", () => {
  const request = (p: string, init?: RequestInit) => Promise.resolve(captured.fetch!(new Request(`http://ned.test${p}`, init)));
  const post = (body: unknown) => request("/api/sessions/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const setActions = (actions: Record<string, boolean>) => fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", actions }));
  const body = { repo: REPO, worktree: { mode: "new", name: "alpha-feat" }, model: "opus", prompt: "고쳐줘" };
  beforeAll(() => {
    startServer(() => loadConfig());
  });

  it("400 bad input, 403 off (logged as refused with origin chat)", async () => {
    const m = mockOrca();
    _setSessionCreateDeps(deps(m));
    setActions({ chat_session_create: false });
    expect((await post({ ...body, prompt: "" })).status).toBe(400);
    const r = await post(body);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toContain("chat_session_create");
    expect(logLines()[0]).toMatchObject({ action: "refused", origin: "chat", mode: "create" });
    expect(m.calls.some((c) => c[1] === "create")).toBe(false);
    _setSessionCreateDeps(null);
  });

  it("202 + job; joins the same running request; GET shows the result", async () => {
    const m = mockOrca();
    _setSessionCreateDeps(deps(m));
    setActions({ chat_session_create: true });
    const r = await post(body);
    expect(r.status).toBe(202);
    const { job_id } = await r.json();
    let v: { state: string; result?: { ok: boolean; session?: { handle?: string } } } = { state: "running" };
    for (let i = 0; i < 50 && v.state === "running"; i++) {
      await new Promise((res) => setTimeout(res, 5));
      v = await (await request(`/api/sessions/create/${job_id}`)).json();
    }
    expect(v.state).toBe("done");
    expect(v.result).toMatchObject({ ok: true, session: { handle: "term_new" } });
    _setSessionCreateDeps(null);
  });

  it("cap is not raced: two concurrent requests (different worktrees) with 1 live → one starts, one 409", async () => {
    fs.writeFileSync(CHAT_SESSIONS_PATH, JSON.stringify([{ job_id: "old", created_at: Date.now(), repo: REPO, mode: "new", name: "old", model: "opus", worktree_path: "/wt/old", handle: "term_old" }]));
    const m = mockOrca({ terminals: [{ handle: "term_old" }] });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // every orca read yields to the event loop, so validate's awaits interleave unless serialized
    const slow: OrcaExec = async (args, t) => {
      await new Promise((r) => setTimeout(r, 1));
      if (args[1] === "create") await gate;
      return m.fn(args, t);
    };
    const d = deps({ ...m, fn: slow });
    const [a, b] = await Promise.all([startSessionCreate(input({ worktree: { mode: "new", name: "one" } }), cfgOn, [], d), startSessionCreate(input({ worktree: { mode: "new", name: "two" } }), cfgOn, [], d)]);
    expect([a.kind, b.kind].sort()).toEqual(["job", "refused"]);
    const refused = (a.kind === "refused" ? a : b) as { kind: "refused"; result: { status: number; detail: string } };
    expect(refused.result.status).toBe(409);
    expect(refused.result.detail).toContain("최대 2");
    release();
  });

  it("startSessionCreate joins a running job with the same repo + worktree", async () => {
    const m = mockOrca();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: OrcaExec = async (args, t) => {
      if (args[1] === "create") await gate;
      return m.fn(args, t);
    };
    const d = deps({ ...m, fn: slow });
    const a = await startSessionCreate(input(), cfgOn, [], d);
    const b = await startSessionCreate(input(), cfgOn, [], d);
    expect(a.kind).toBe("job");
    expect(b).toMatchObject({ kind: "job", reused: true });
    release();
  });
});
