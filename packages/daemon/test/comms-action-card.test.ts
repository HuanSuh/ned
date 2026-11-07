// @vitest-environment jsdom
/**
 * The 확인 카드 inside the real comms panel (public/app/features/comms.js), APIs mocked with fetch:
 * a saved answer with a ```ned-action block → card with the server's target line (validate preview) → edit → 실행
 * → validate (edited text) → POST /api/todos (origin chat) → card "실행됨", state saved via /api/chat/:id/action.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../public/app/main.js", () => ({ loadState: async () => {}, renderAll: () => {} }));

const CHAT_ID = "c-test0001";
const ANSWER = '할 일에 넣을게.\n```ned-action\n{"kind":"todo_add","target":{"due":"2026-11-10"},"text":"보고서","summary":"보고서 할 일 추가"}\n```';

describe("comms panel + 확인 카드", () => {
  it("renders the card from a saved chat and runs it through the existing endpoints", async () => {
    const calls: { url: string; body: Record<string, unknown> | null }[] = [];
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ url, body });
      if (url === `/api/chat/${CHAT_ID}`) return json({ id: CHAT_ID, cost_usd: 0, running: false, messages: [{ role: "user", text: "보고서 할 일", ts: 1 }, { role: "ned", text: ANSWER, ts: 2 }] });
      if (url === "/api/chat/actions/validate") return json({ ok: true, kind: "todo_add", endpoint: "/api/todos", label: "할 일 추가", summary: "보고서 할 일 추가", target_label: "개인 할 일 · 마감 2026-11-10", text: body?.text ?? "보고서", payload: { title: body?.text ?? "보고서", due: "2026-11-10", origin: "chat" } });
      if (url === "/api/todos") return json({ id: "t1", title: body?.title, due: body?.due }, 201);
      if (url === `/api/chat/${CHAT_ID}/action`) return json({ ok: true, action: { ...body, at: 3 } });
      return json({});
    }));
    window.HTMLElement.prototype.scrollIntoView ??= () => {};
    localStorage.setItem("ned.chat.id", CHAT_ID);
    const comms = await import("../public/app/features/comms.js");
    comms.init();
    comms.open("chat");
    const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
    await flush();

    const log = document.getElementById("cm-log")!;
    const card = () => log.querySelector<HTMLElement>('[data-ca="2"]')!;
    expect(card()).not.toBeNull();
    expect(log.querySelector("pre")).toBeNull(); // not shown as a code block
    expect(log.textContent).toContain("할 일에 넣을게.");
    expect(card().textContent).toContain("개인 할 일 · 마감 2026-11-10"); // validate preview
    expect(calls.filter((c) => c.url === "/api/chat/actions/validate")).toHaveLength(1);

    const ta = card().querySelector<HTMLTextAreaElement>("[data-ca-text]")!;
    ta.value = "보고서 초안 쓰기";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    card().querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    await flush();

    const seq = calls.slice(2).map((c) => c.url);
    expect(seq).toEqual([`/api/chat/${CHAT_ID}/action`, "/api/chat/actions/validate", "/api/todos", `/api/chat/${CHAT_ID}/action`]);
    expect(calls[3].body).toEqual({ block: { kind: "todo_add", target: { due: "2026-11-10" }, text: "보고서", summary: "보고서 할 일 추가" }, text: "보고서 초안 쓰기" });
    expect(calls[4].body).toEqual({ title: "보고서 초안 쓰기", due: "2026-11-10", origin: "chat" });
    expect(calls[2].body).toEqual({ ts: 2, state: "running", text: "보고서 초안 쓰기" });
    expect(calls[5].body).toMatchObject({ ts: 2, state: "executed", result: { ok: true, detail: "할 일 추가됨: 보고서 초안 쓰기 (마감 2026-11-10)" } });
    expect(card().className).toContain("s-executed");
    expect(card().textContent).toContain("✓ 실행됨");
    expect(card().querySelector("[data-ca-run]")).toBeNull();
  });
});
