// @vitest-environment jsdom
/**
 * 확인 카드 × session_create (public/app/features/chat-action.js): repo · worktree · model are a read-only target line,
 * only the first prompt is editable (8000 chars); [실행] → validate → POST /api/sessions/create as a job with the long
 * wait + action-log match; the running card shows the job stage; a failure after the session exists is final (no retry).
 */
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { STAGE_KO, outcomeOf, parseActionBlock, renderActionCard, runChatAction, wireActionCards } from "../public/app/features/chat-action.js";

const REPO = "/repos/alpha";
const BLOCK = { kind: "session_create", target: { repo: REPO, worktree: { mode: "new", name: "login-fix" }, model: "opus" }, text: "먼저 계획을 제시하고 승인받은 뒤 구현한다.\n\n로그인 버그를 고쳐줘", summary: "로그인 버그 세션" };
const VALID = {
  ok: true, kind: "session_create", endpoint: "/api/sessions/create", label: "새 에이전트 세션 만들기", summary: "로그인 버그 세션",
  target_label: "레포 alpha (/repos/alpha) · 새 워크트리 login-fix · 모델 opus", text_optional: false, max_wait_ms: 480000,
  payload: { repo: REPO, worktree: { mode: "new", name: "login-fix" }, model: "opus", prompt: "P", origin: "chat" },
  match: { source: "session", mode: "create", ref: { title: "alpha · 새 login-fix", repo: REPO }, text: "P" },
};

describe("parse + render", () => {
  it("the flat block form becomes {target, text}", () => {
    const p = parseActionBlock('세션 하나 띄울게.\n```ned-action\n{"kind":"session_create","repo":"/repos/alpha","worktree":{"mode":"new","name":"login-fix"},"model":"sonnet","prompt":"고쳐줘"}\n```');
    expect(p.text).toBe("세션 하나 띄울게.");
    expect(p.block).toMatchObject({ kind: "session_create", target: { repo: REPO, worktree: { mode: "new", name: "login-fix" }, model: "sonnet" }, text: "고쳐줘" });
  });

  it("idle card: read-only target (repo · worktree · model), the full prompt editable up to 8000 chars", () => {
    const pre = renderActionCard(BLOCK, { status: "idle" }, { id: "1" });
    expect(pre).toContain("새 에이전트 세션 만들기");
    expect(pre).toContain("레포 alpha (/repos/alpha) · 새 워크트리 login-fix · 모델 opus"); // guess before validate
    const html = renderActionCard(BLOCK, { status: "idle", preview: { target_label: VALID.target_label, label: VALID.label } }, { id: "1" });
    const root = document.createElement("div");
    root.innerHTML = html;
    expect(root.querySelector(".ca-tg")!.textContent).toContain("새 워크트리 login-fix");
    expect(root.querySelectorAll("input, select")).toHaveLength(0); // repo / worktree / model not editable
    const ta = root.querySelector<HTMLTextAreaElement>("[data-ca-text]")!;
    expect(ta.maxLength).toBe(8000);
    expect(ta.value).toBe(BLOCK.text); // the whole prompt
    expect(ta.getAttribute("aria-label")).toBe("첫 프롬프트 (전문)");
  });
});

describe("runChatAction / outcomeOf", () => {
  it("validate → POST /api/sessions/create via the job poller with the long wait + the log match", async () => {
    const postJson = vi.fn(async () => ({ ok: true, status: 200, data: VALID }));
    const sendAndWait = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, detail: "started /wt/login-fix (term_1) · opus", session: { handle: "term_1" } } }));
    const r = await runChatAction(BLOCK, "고친 프롬프트", { postJson, sendAndWait });
    expect(postJson).toHaveBeenCalledWith("/api/chat/actions/validate", { block: BLOCK, text: "고친 프롬프트" });
    expect(sendAndWait).toHaveBeenCalledWith(VALID.payload, expect.objectContaining({ endpoint: "/api/sessions/create", maxWaitMs: 480000, match: VALID.match, label: "대화창 · 새 에이전트 세션 만들기" }));
    expect(r).toMatchObject({ ok: true, final: true, detail: expect.stringContaining("started") });
  });

  it("cap refusal (409) is retryable; a failure after the worktree/terminal exists is final", () => {
    expect(outcomeOf({ ok: false, status: 409, data: { ok: false, error: "최대 2" } })).toMatchObject({ ok: false, final: false });
    expect(outcomeOf({ ok: false, status: 502, data: { ok: false, error: "[제출 확인] 초안으로 남아", session: { handle: "term_1", stage: "submit_confirm" } } })).toMatchObject({ ok: false, final: true, detail: expect.stringContaining("제출 확인") });
    expect(outcomeOf({ ok: false, status: 502, data: { ok: false, error: "[워크트리 만들기] boom", session: { stage: "worktree_create" } } })).toMatchObject({ final: false });
  });
});

describe("wireActionCards (DOM)", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("edit the prompt → 실행: stage shown while running, executed with the result, saved running → executed", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const states: Record<string, Record<string, unknown>> = { "9": { status: "idle", preview: { target_label: VALID.target_label, label: VALID.label } } };
    const draw = () => { root.innerHTML = renderActionCard(BLOCK, states["9"], { id: "9" }); };
    const persist = vi.fn(async (_id: string, _b: unknown) => ({ ok: true, status: 200 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const postJson = vi.fn(async () => ({ ok: true, status: 200, data: VALID }));
    const sendAndWait = vi.fn(async (_body: unknown, opts: { onTick: (ms: number, stage?: string) => void }) => {
      opts.onTick(12_000, "agent_boot");
      await gate;
      return { ok: true, status: 200, data: { ok: true, detail: "started /wt/login-fix (term_1) · opus" } };
    });
    const h = {
      get: (id: string) => (states[id] ? { block: BLOCK, state: states[id] } : null),
      set: (id: string, patch: Record<string, unknown>, rerender = true) => { states[id] = { ...states[id], ...patch }; if (rerender) draw(); },
      persist,
      deps: { postJson, sendAndWait },
    };
    draw();
    wireActionCards(root, h);

    const ta = root.querySelector<HTMLTextAreaElement>("[data-ca-text]")!;
    ta.value = "먼저 계획을 제시하고 승인받은 뒤 구현한다.\n\n로그인 + 회원가입 버그 둘 다";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    await flush(); await flush();
    expect(root.textContent).toContain("실행 중…");
    expect(root.textContent).toContain(`${STAGE_KO.agent_boot} · 12초`);
    release();
    await flush(); await flush();

    expect(postJson).toHaveBeenCalledWith("/api/chat/actions/validate", { block: BLOCK, text: ta.value });
    expect(sendAndWait).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls.map((c) => (c[1] as { state: string }).state)).toEqual(["running", "executed"]);
    expect(states["9"].status).toBe("executed");
    expect(root.textContent).toContain("✓ 실행됨");
    expect(root.querySelector("[data-ca-run], textarea")).toBeNull();
  });
});
