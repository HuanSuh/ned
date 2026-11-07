// @vitest-environment jsdom
/**
 * 확인 카드 (public/app/features/chat-action.js): the ```ned-action parser, the card HTML per state, the chat message
 * rendering (card instead of a code block, hidden while streaming) and the run / cancel flow with the APIs mocked —
 * validate → the endpoint the server named → result on the card, saved once; a second click never runs twice.
 */
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { outcomeOf, parseActionBlock, pickTransition, renderActionCard, runChatAction, wireActionCards } from "../public/app/features/chat-action.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { COMMS_VOICE, messagesHtml } from "../public/app/features/chat-core.js";

const BLOCK = { kind: "slack_send", target: { url: "https://acme.slack.com/archives/C1/p1730000000123456" }, text: "곧 배포해요", summary: "kim 에게 배포 시각 답장" };
const answer = (json: string) => `kim 에게 이렇게 보낼게.\n\n\`\`\`ned-action\n${json}\n\`\`\`\n`;

describe("parseActionBlock", () => {
  it("splits the text from the last complete block; no block → untouched", () => {
    expect(parseActionBlock("그냥 답")).toEqual({ text: "그냥 답", block: null, error: "", pending: false });
    const p = parseActionBlock(answer(JSON.stringify(BLOCK)));
    expect(p.text).toBe("kim 에게 이렇게 보낼게.");
    expect(p.block).toEqual(BLOCK);
    const two = parseActionBlock(`a\n\`\`\`ned-action\n{"kind":"todo_add","text":"1"}\n\`\`\`\nb\n\`\`\`ned-action\n{"kind":"todo_add","text":"2"}\n\`\`\``);
    expect(two.block.text).toBe("2");
    expect(two.text).toBe("a\n\nb");
    // ordinary code fences are left to mdLite
    expect(parseActionBlock("```sh\nls\n```").block).toBeNull();
  });

  it("bad JSON / unknown kind → error (no card); an unterminated fence while streaming is hidden as pending", () => {
    expect(parseActionBlock(answer("{kind: oops"))).toMatchObject({ block: null, error: expect.stringContaining("JSON") });
    expect(parseActionBlock(answer('{"kind":"rm_rf"}'))).toMatchObject({ block: null, error: expect.stringContaining("rm_rf") });
    expect(parseActionBlock('보낼게.\n```ned-action\n{"kind":"sla')).toEqual({ text: "보낼게.", block: null, error: "", pending: true });
  });
});

describe("renderActionCard", () => {
  it("idle: summary, read-only target, editable text, 실행 / 취소", () => {
    const html = renderActionCard(BLOCK, { status: "idle", preview: { target_label: "Slack · #dev · kim", label: "Slack 보내기" } }, { id: "42" });
    expect(html).toContain('data-ca="42"');
    expect(html).toContain("⚡ 실행 제안 · Slack 보내기");
    expect(html).toContain("kim 에게 배포 시각 답장");
    expect(html).toContain("Slack · #dev · kim");
    expect(html).toMatch(/<textarea class="ca-tx" data-ca-text[^>]*>곧 배포해요<\/textarea>/);
    expect(html).toContain("data-ca-run");
    expect(html).toContain("data-ca-cancel");
    // only the text is editable: there is no input for the target
    expect((html.match(/<(input|textarea|select)\b/g) || []).length).toBe(1);
  });

  it("escapes everything the model wrote", () => {
    const html = renderActionCard({ ...BLOCK, summary: "<img src=x onerror=alert(1)>", text: "</textarea><script>x</script>" }, {}, { id: "1" });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });

  it("running / executed / failed / cancelled", () => {
    expect(renderActionCard(BLOCK, { status: "running", tick: "3초" })).toContain("실행 중…");
    expect(renderActionCard(BLOCK, { status: "running" })).not.toContain("data-ca-run");
    const done = renderActionCard(BLOCK, { status: "executed", text: "고친 글", result: { ok: true, detail: "https://acme.slack.com/archives/C1/p2", link: "https://acme.slack.com/archives/C1/p2" } });
    expect(done).toContain("✓ 실행됨");
    expect(done).toContain('href="https://acme.slack.com/archives/C1/p2"');
    expect(done).toContain("고친 글");
    expect(done).not.toContain("<textarea");
    expect(done).not.toContain("data-ca-run");
    const failed = renderActionCard(BLOCK, { status: "failed", result: { ok: false, detail: "403 꺼져 있어" } });
    expect(failed).toContain("⚠ 403 꺼져 있어");
    expect(failed).toContain("다시 실행");
    expect(renderActionCard(BLOCK, { status: "executed", result: { ok: true, detail: "x", link: "javascript:alert(1)" } })).not.toContain("javascript:");
    const cancelled = renderActionCard(BLOCK, { status: "cancelled" });
    expect(cancelled).toContain("취소됨");
    expect(cancelled).not.toContain("data-ca-run");
  });
});

describe("chat messages", () => {
  it("a ned answer's block renders as a card, not a code block; card state comes from the message", () => {
    const msgs = [{ role: "user", text: "답해 줘", ts: 1 }, { role: "ned", text: answer(JSON.stringify(BLOCK)), ts: 2, action: { state: "executed", text: "보냄", result: { ok: true, detail: "ok" }, at: 3 } }];
    const html = messagesHtml(msgs, COMMS_VOICE.ned);
    expect(html).toContain('class="cm-act s-executed" data-ca="2"');
    expect(html).not.toContain("<pre>");
    expect(html).not.toContain("ned-action");
    // a user message that quotes a block is just text
    expect(messagesHtml([{ role: "user", text: answer(JSON.stringify(BLOCK)), ts: 5 }], COMMS_VOICE.ned)).not.toContain("cm-act");
  });

  it("while streaming the block is hidden behind '실행 제안 준비 중…'", () => {
    const html = messagesHtml([], COMMS_VOICE.ned, { text: '보낼게.\n```ned-action\n{"kind":"slack_se', tool: "" });
    expect(html).toContain("실행 제안 준비 중…");
    expect(html).not.toContain("slack_se");
  });
});

describe("runChatAction", () => {
  it("validate → the endpoint the server named; text override goes to validate", async () => {
    const postJson = vi.fn(async (_p: string) => ({ ok: true, status: 200, data: { ok: true, endpoint: "/api/send", label: "Slack 보내기", payload: { source: "slack", mode: "send", ref: { url: "u" }, text: "새 글", origin: "chat" } } }));
    const sendAndWait = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, detail: "https://acme.slack.com/archives/C1/p9 ($0.010)" } }));
    const r = await runChatAction(BLOCK, "새 글", { postJson, sendAndWait });
    expect(postJson).toHaveBeenCalledWith("/api/chat/actions/validate", { block: BLOCK, text: "새 글" });
    expect(sendAndWait).toHaveBeenCalledWith({ source: "slack", mode: "send", ref: { url: "u" }, text: "새 글", origin: "chat" }, expect.objectContaining({ label: "대화창 · Slack 보내기" }));
    expect(r).toEqual({ ok: true, final: true, detail: "https://acme.slack.com/archives/C1/p9 ($0.010)", link: "https://acme.slack.com/archives/C1/p9" });
  });

  it("validate refusal stops before any write", async () => {
    const postJson = vi.fn(async () => ({ ok: false, status: 403, data: { ok: false, error: "대화창 쓰기가 꺼져 있어" } }));
    const sendAndWait = vi.fn();
    expect(await runChatAction(BLOCK, "x", { postJson, sendAndWait })).toEqual({ ok: false, final: false, detail: "대화창 쓰기가 꺼져 있어" });
    expect(sendAndWait).not.toHaveBeenCalled();
  });

  it("todo_add posts /api/todos; calendar_create uses the job endpoint + match", async () => {
    const calls: [string, unknown][] = [];
    const postJson = vi.fn(async (p: string, b: unknown) => {
      calls.push([p, b]);
      if (p.endsWith("validate")) return { ok: true, status: 200, data: { ok: true, endpoint: "/api/todos", label: "할 일 추가", payload: { title: "보고서", origin: "chat" } } };
      return { ok: true, status: 201, data: { id: "t1", title: "보고서", due: null } };
    });
    expect(await runChatAction({ kind: "todo_add", target: {}, text: "보고서", summary: "" }, "보고서", { postJson, sendAndWait: vi.fn() })).toMatchObject({ ok: true, detail: "할 일 추가됨: 보고서" });
    expect(calls[1]).toEqual(["/api/todos", { title: "보고서", origin: "chat" }]);

    const payload = { title: "1:1", date: "2026-11-10", start_time: "15:00", end_time: "15:30", origin: "chat" };
    const sendAndWait = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, detail: "created", event: { id: "e1", html_link: "https://calendar.google.com/e1" } } }));
    const r = await runChatAction({ kind: "calendar_create", target: {}, text: "1:1", summary: "" }, "1:1", { postJson: async () => ({ ok: true, status: 200, data: { ok: true, endpoint: "/api/calendar/events", label: "캘린더 일정 만들기", payload } }), sendAndWait });
    expect(sendAndWait).toHaveBeenCalledWith(payload, expect.objectContaining({ endpoint: "/api/calendar/events", match: { source: "calendar", mode: "create", ref: { title: "1:1", calendar_id: "primary" } } }));
    expect(r.link).toBe("https://calendar.google.com/e1");
  });

  it("jira_transition: lists transitions, picks by the card text, then transitions with that id", async () => {
    const lookup = { source: "jira", mode: "transitions", ref: { key: "NED-7" }, text: "", origin: "chat" };
    const payload = { source: "jira", mode: "transition", ref: { key: "NED-7", transition_name: "진행 중" }, text: "", origin: "chat" };
    const postJson = async () => ({ ok: true, status: 200, data: { ok: true, endpoint: "/api/send", label: "Jira 상태 변경", payload, lookup } });
    const sendAndWait = vi.fn(async (b: { mode: string }) => (b.mode === "transitions"
      ? { ok: true, status: 200, data: { ok: true, transitions: [{ id: "11", name: "Start", to: "진행 중" }, { id: "21", name: "Done", to: "완료" }] } }
      : { ok: true, status: 200, data: { ok: true, detail: "NED-7 → transition 11" } }));
    expect(await runChatAction({ kind: "jira_transition", target: {}, text: "진행 중", summary: "" }, "진행 중", { postJson, sendAndWait })).toMatchObject({ ok: true });
    expect(sendAndWait.mock.calls[1][0]).toEqual({ ...payload, ref: { key: "NED-7", transition_name: "Start", transition_id: "11" } });
    const none = await runChatAction({ kind: "jira_transition", target: {}, text: "보류", summary: "" }, "보류", { postJson, sendAndWait });
    expect(none).toMatchObject({ ok: false, final: false, detail: expect.stringContaining("진행 중, 완료") });
    expect(pickTransition([{ id: "1", name: "In Progress", to: "In Progress" }], "progress")).toMatchObject({ id: "1" });
  });

  it("outcomes: dry-run / 403 retryable, already_sent + unknown final", () => {
    expect(outcomeOf({ ok: true, status: 200, data: { ok: false, action: "dry_run:slack_message C1", detail: "not executed (NED_NO_LLM=1); argv logged" } })).toMatchObject({ ok: false, final: false });
    expect(outcomeOf({ ok: false, status: 403, data: { ok: false, error: "off" } })).toEqual({ ok: false, final: false, detail: "off" });
    expect(outcomeOf({ ok: false, status: 409, data: { already_sent: true, sent_at: "t", detail: "d", link: "https://x/y" } })).toMatchObject({ ok: true, final: true, link: "https://x/y" });
    expect(outcomeOf({ ok: false, status: 0, unknown: true, data: { error: "모름" } })).toEqual({ ok: false, final: true, detail: "모름" });
  });
});

describe("wireActionCards (DOM)", () => {
  function mount(deps: { postJson: unknown; sendAndWait: unknown }, persist = vi.fn(async (_id: string, _b: unknown) => ({ ok: true, status: 200 }))) {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const states: Record<string, Record<string, unknown>> = { "7": { status: "idle" } };
    const draw = () => { root.innerHTML = renderActionCard(BLOCK, states["7"], { id: "7" }); };
    const h = {
      get: (id: string) => (states[id] ? { block: BLOCK, state: states[id] } : null),
      set: vi.fn((id: string, patch: Record<string, unknown>, rerender = true) => { states[id] = { ...states[id], ...patch }; if (rerender) draw(); }),
      persist,
      deps,
    };
    draw();
    wireActionCards(root, h);
    return { root, states, h, persist };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("edit → 실행: validate with the edited text, run, result on the card, saved running → executed; double click runs once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const postJson = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, endpoint: "/api/send", label: "Slack 보내기", payload: { source: "slack", mode: "send", ref: {}, text: "고친 글", origin: "chat" } } }));
    const sendAndWait = vi.fn(async () => { await gate; return { ok: true, status: 200, data: { ok: true, detail: "https://acme.slack.com/archives/C1/p5" } }; });
    const { root, states, persist } = mount({ postJson, sendAndWait });

    const ta = root.querySelector<HTMLTextAreaElement>("[data-ca-text]")!;
    ta.value = "고친 글";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(states["7"].text).toBe("고친 글");
    const run = root.querySelector<HTMLButtonElement>("[data-ca-run]")!;
    run.click();
    run.click(); // same (detached) button again while running
    await flush();
    expect(root.querySelector("[data-ca-run]")).toBeNull(); // running: no buttons
    expect(root.textContent).toContain("실행 중…");
    release();
    await flush(); await flush();

    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith("/api/chat/actions/validate", { block: BLOCK, text: "고친 글" });
    expect(sendAndWait).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls.map((c) => (c[1] as { state: string }).state)).toEqual(["running", "executed"]);
    expect(persist.mock.calls[1][1]).toMatchObject({ text: "고친 글", result: { ok: true, link: "https://acme.slack.com/archives/C1/p5" } });
    expect(states["7"].status).toBe("executed");
    expect(root.textContent).toContain("✓ 실행됨");
    expect(root.querySelector("[data-ca-run], textarea")).toBeNull();
  });

  it("a failed run can be retried; 취소 collapses and saves cancelled without calling any API", async () => {
    let n = 0;
    const postJson = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, endpoint: "/api/send", label: "Slack 보내기", payload: {} } }));
    const sendAndWait = vi.fn(async () => (++n === 1 ? { ok: false, status: 502, data: { ok: false, error: "claude failed" } } : { ok: true, status: 200, data: { ok: true, detail: "ok" } }));
    const { root, states, persist } = mount({ postJson, sendAndWait });
    root.querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    await flush(); await flush();
    expect(states["7"].status).toBe("failed");
    expect(root.textContent).toContain("⚠ claude failed");
    root.querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    await flush(); await flush();
    expect(states["7"].status).toBe("executed");
    expect(persist.mock.calls.map((c) => (c[1] as { state: string }).state)).toEqual(["running", "failed", "running", "executed"]);

    const c = mount({ postJson: vi.fn(), sendAndWait: vi.fn() });
    c.root.querySelector<HTMLButtonElement>("[data-ca-cancel]")!.click();
    await flush();
    expect(c.states["7"].status).toBe("cancelled");
    expect(c.root.textContent).toContain("취소됨");
    expect(c.persist).toHaveBeenCalledWith("7", { state: "cancelled" });
  });

  it("the server says the card was already run (409 on the running claim) → nothing is sent", async () => {
    const postJson = vi.fn();
    const sendAndWait = vi.fn();
    const { root, states } = mount({ postJson, sendAndWait }, vi.fn(async () => ({ ok: false, status: 409, data: { error: "이미 실행한 카드야" } })));
    root.querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    await flush(); await flush();
    expect(postJson).not.toHaveBeenCalled();
    expect(sendAndWait).not.toHaveBeenCalled();
    expect(states["7"]).toMatchObject({ status: "executed", result: { ok: false, detail: "이미 실행한 카드야" } });
  });
});
