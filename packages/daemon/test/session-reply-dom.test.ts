// @vitest-environment jsdom
/**
 * 세션에 답하기 — dashboard (public/app/features/sessreply.js): a waiting session row's quick buttons / one-line input go
 * through the real sendjob.js (POST /api/send → 202 {job_id} → GET /api/send/:id) against a mocked fetch; 409 → the fixed
 * "터미널이 닫혀 있어" toast and the typed text stays; can_reply false → hint only; running → ⋯ → 메시지 보내기.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
vi.mock("../public/app/ui/toast.js", () => ({ toast }));
vi.mock("../public/app/main.js", () => ({ loadState: vi.fn(), renderHeader: vi.fn(), renderAll: vi.fn(), loadAgenda: vi.fn() }));

// @ts-expect-error — plain browser ES module (public/app), no types
const SR = await import("../public/app/features/sessreply.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { S, subscribe } = await import("../public/app/state.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { unitHtml } = await import("../public/app/tabs/inbox.js");

type Sess = { id: string; worktree: string; cwd: string; status: string; last_event_ts: number; last_summary: string | null; last_prompt: string | null; subagents_active: number; can_reply?: boolean };
const sess = (over: Partial<Sess> = {}): Sess => ({ id: "sess-74", worktree: "fb-74", cwd: "/w/fb-74", status: "waiting", last_event_ts: 1000, last_summary: "Claude needs your permission to use Bash", last_prompt: "배포 스크립트 고쳐 줘", subagents_active: 0, can_reply: true, ...over });

/** fetch mock: POST /api/send → 202 job; GET /api/send/:id → `result` (http_status …). Records POST bodies. */
let posts: Record<string, unknown>[] = [];
let result: Record<string, unknown> = { ok: true, http_status: 200, action: "orca_terminal_send term_x", detail: "sent" };
let gate: Promise<void> | null = null;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === "POST" && url === "/api/send") {
    posts.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ ok: true, job_id: "job-1", reused: false, started_at: new Date().toISOString() }), { status: 202 });
  }
  if (url.startsWith("/api/send/")) {
    if (gate) await gate;
    return new Response(JSON.stringify({ job_id: "job-1", state: "done", elapsed_ms: 5, result }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
});

const host = () => document.getElementById("host")!;
const draw = () => SR.keepFocus(() => { host().innerHTML = (S.state.sessions as Sess[]).map((x) => unitHtml(x, "rail")).join(""); });
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };
const click = (el: Element | null) => { expect(el).not.toBeNull(); el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); };

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  SR.init(document);
  subscribe("sessreply", draw);
});
beforeEach(() => {
  posts = []; toast.mockReset(); fetchMock.mockClear(); gate = null;
  result = { ok: true, http_status: 200, action: "orca_terminal_send term_x", detail: "sent" };
  SR._resetReply();
  localStorage.clear();
  S.config = { actions: { session_send: true }, dashboard: {} };
  S.state = { sessions: [sess()], attention: [] };
  document.body.innerHTML = `<div id="host"></div>`;
  draw();
});
afterEach(() => { vi.useRealTimers(); });

describe("waiting session row", () => {
  it("shows what it asks (Notification text) + the default quick buttons ㄱㄱ · 승인 · 계속 + an input", () => {
    const u = host().querySelector(".unit")!;
    expect(u.querySelector(".s")!.textContent).toBe("Claude needs your permission to use Bash");
    expect([...u.querySelectorAll("[data-srq]")].map((b) => b.textContent)).toEqual(["ㄱㄱ", "승인", "계속"]);
    expect(u.querySelector("[data-sri]")).not.toBeNull();
    expect(u.querySelector("[data-srmenu]")).toBeNull(); // waiting: the box is already open, no ⋯
  });

  it("quick buttons follow config.dashboard.session_quick_replies", () => {
    S.config.dashboard.session_quick_replies = ["진행", "아니"];
    draw();
    expect([...host().querySelectorAll("[data-srq]")].map((b) => b.textContent)).toEqual(["진행", "아니"]);
  });

  it("quick button → POST /api/send (session body, origin session) → 202 → poll → toast + row shows 보냄 until the session moves", async () => {
    let release!: () => void; // hold the poll to look at the busy row
    gate = new Promise((r) => { release = r; });
    click(host().querySelector('[data-srq="승인"]'));
    await flush();
    expect(posts).toEqual([{ source: "session", mode: "session", text: "승인", ref: { session_id: "sess-74" }, origin: "session" }]);
    // while sending: every control is disabled
    expect(host().querySelector(".sreply.busy")).not.toBeNull();
    expect([...host().querySelectorAll(".sreply button, .sreply input")].every((e) => (e as HTMLButtonElement).disabled)).toBe(true);
    release();
    await flush();
    expect(fetchMock.mock.calls.some(([u]) => u === "/api/send/job-1")).toBe(true);
    expect(toast).toHaveBeenCalledWith("fb-74 에 보냄");
    expect(host().querySelector(".sreply.sent")!.textContent).toBe("보냄 — 응답 기다리는 중");
    expect(host().querySelector("[data-sri]")).toBeNull();
    // next /api/state with no new event → still 보냄; the session's next event (UserPromptSubmit → running) → real state
    draw();
    expect(host().querySelector(".sreply.sent")).not.toBeNull();
    S.state.sessions = [sess({ status: "running", last_event_ts: 2000, last_summary: null })];
    draw();
    expect(host().querySelector(".sreply")).toBeNull();
    expect(host().querySelector("[data-srmenu]")).not.toBeNull();
  });

  it("typed text + ⏎ sends it; an Enter while composing Hangul does not; Shift+⏎ sends nothing", async () => {
    const inp = host().querySelector("[data-sri]") as HTMLInputElement;
    inp.value = "테스트도 돌려";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }));
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    await flush();
    expect(posts).toEqual([]);
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    expect(posts.map((p) => p.text)).toEqual(["테스트도 돌려"]);
  });

  it("409 → '터미널이 닫혀 있어' toast, the input comes back with the typed text", async () => {
    result = { ok: false, http_status: 409, action: "session_send", detail: "…열려 있지 않다", error: "…열려 있지 않다" };
    const inp = host().querySelector("[data-sri]") as HTMLInputElement;
    inp.value = "계속 진행해";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    click(host().querySelector("[data-srsend]"));
    await flush();
    expect(toast).toHaveBeenCalledWith("터미널이 닫혀 있어 보낼 수 없음 — 터미널에서 직접 입력", 5000);
    const again = host().querySelector("[data-sri]") as HTMLInputElement;
    expect(again.value).toBe("계속 진행해");
    expect(again.disabled).toBe(false);
    expect(host().querySelector(".sreply.sent")).toBeNull();
  });

  it("other failures show the daemon's reason as is", async () => {
    result = { ok: false, http_status: 502, action: "orca_terminal_send term_x", detail: "orca terminal send 실패: boom", error: "orca terminal send 실패: boom" };
    click(host().querySelector('[data-srq="ㄱㄱ"]'));
    await flush();
    expect(toast).toHaveBeenCalledWith("보내지 못했어: orca terminal send 실패: boom", 5000);
  });

  it("can_reply false → no input, only the 터미널에서 직접 입력 hint", () => {
    S.state.sessions = [sess({ can_reply: false })];
    draw();
    expect(host().querySelector("[data-sri]")).toBeNull();
    expect(host().querySelector("[data-srq]")).toBeNull();
    expect(host().querySelector(".sreply.nohint")!.textContent).toContain("터미널에서 직접 입력");
  });

  it("actions.session_send off → no reply UI at all", () => {
    S.config.actions.session_send = false;
    draw();
    expect(host().querySelector(".sreply")).toBeNull();
  });

  it("a periodic re-render keeps focus and caret in the input", () => {
    const inp = host().querySelector("[data-sri]") as HTMLInputElement;
    inp.focus();
    inp.value = "abc";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.setSelectionRange(1, 1);
    draw();
    const now = host().querySelector("[data-sri]") as HTMLInputElement;
    expect(now).not.toBe(inp);
    expect(document.activeElement).toBe(now);
    expect(now.value).toBe("abc");
    expect(now.selectionStart).toBe(1);
  });

  it("보냄 expires after 90 s even without a session event", () => {
    SR.R.sent.set("sess-74", { at: Date.now() - 91_000, ts: 1000 });
    expect(SR.sentPending(sess())).toBe(false);
    SR.R.sent.set("sess-74", { at: Date.now(), ts: 1000 });
    expect(SR.sentPending(sess())).toBe(true);
  });
});

describe("running session row", () => {
  beforeEach(() => { S.state.sessions = [sess({ status: "running", last_summary: null })]; draw(); });

  it("no input; ⋯ → 메시지 보내기 opens it (no quick buttons) and sends the extra instruction", async () => {
    expect(host().querySelector("[data-sri]")).toBeNull();
    click(host().querySelector("[data-srmenu]"));
    click(host().querySelector("[data-sropen]"));
    const inp = host().querySelector("[data-sri]") as HTMLInputElement;
    expect(inp).not.toBeNull();
    expect(document.activeElement).toBe(inp);
    expect(host().querySelector("[data-srq]")).toBeNull();
    inp.value = "끝나면 PR 올려";
    inp.dispatchEvent(new Event("input", { bubbles: true }));
    inp.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await flush();
    expect(posts).toEqual([{ source: "session", mode: "session", text: "끝나면 PR 올려", ref: { session_id: "sess-74" }, origin: "session" }]);
    expect(toast).toHaveBeenCalledWith("fb-74 에 보냄");
  });

  it("닫기 / Esc close the opened input", () => {
    click(host().querySelector("[data-srmenu]"));
    click(host().querySelector("[data-sropen]"));
    click(host().querySelector("[data-srclose]"));
    expect(host().querySelector("[data-sri]")).toBeNull();
    click(host().querySelector("[data-srmenu]"));
    click(host().querySelector("[data-sropen]"));
    host().querySelector("[data-sri]")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host().querySelector("[data-sri]")).toBeNull();
  });

  it("no ⋯ when the session can't be replied to", () => {
    S.state.sessions = [sess({ status: "running", can_reply: false })];
    draw();
    expect(host().querySelector("[data-srmenu]")).toBeNull();
  });
});
