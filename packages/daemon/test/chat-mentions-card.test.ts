// @vitest-environment jsdom
/**
 * 대화창 쓰기 보강 (WU-07) — the 확인 카드 side: mention chips + "알림 받는 사람" line (golden case), 출처 / 외부 배지,
 * not-found chips, the 동명이인 dropdown (choice → re-validate with mention_choices), nothing is sent without [실행],
 * and the copy menu ("@이름 텍스트로 복사" / "<@U…> 포함 복사"). APIs mocked; pseudonymous ids only.
 */
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { mentionMap, mentionPreviewHtml, notifyLine, parseActionBlock, renderActionCard, wireActionCards } from "../public/app/features/chat-action.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { COMMS_VOICE, codeBlockHtml, messagesHtml, withMentionIds } from "../public/app/features/chat-core.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { onCopyClick } from "../public/app/features/code-copy.js";

const PL = "https://acme.slack.com/archives/C0TESTOPS01/p1700000000000100";
const BLOCK = {
  kind: "slack_send",
  target: { url: PL },
  target_excerpt: "11/10 샘플 오류 현황 공유드립니다…",
  mentions: [
    { text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A" }] },
    { text: "@사람B", candidates: [{ id: "U0TESTPB01", name: "사람B" }] },
  ],
  text: "@사람A님 @사람B님 샘플 지표는 어디서 볼 수 있을까요?",
  summary: "샘플 오류 현황 스레드에 질문",
};
/** What validate answers for the golden block (server: chat-actions.ts slack_send). */
const SLACK_OK = {
  target_source: "found", channel: "C0TESTOPS01", channel_name: "", thread_ts: "1700000000.000100", target_excerpt: BLOCK.target_excerpt, external: "unknown",
  preview_text: "<@U0TESTPA01>님 <@U0TESTPB01>님 샘플 지표는 어디서 볼 수 있을까요?",
  mentions: { resolved: [{ text: "@사람A", kind: "user", id: "U0TESTPA01", name: "사람A", verified: true }, { text: "@사람B", kind: "user", id: "U0TESTPB01", name: "사람B", verified: true }], unresolved: [], missing: [] },
};

describe("golden card: chips + 알림 받는 사람", () => {
  it("parseActionBlock keeps mentions / excerpt for validate", () => {
    const p = parseActionBlock(`물어볼게.\n\`\`\`ned-action\n${JSON.stringify(BLOCK)}\n\`\`\``);
    expect(p.block.mentions).toHaveLength(2);
    expect(p.block.target_excerpt).toBe(BLOCK.target_excerpt);
  });

  it("renders two name chips with the full id, the notify line, the source / unnamed-channel / 외부 확인 못 함 badges and the excerpt", () => {
    const html = renderActionCard(BLOCK, { status: "idle", preview: { target_label: "Slack · C0TESTOPS01 (채널 이름 확인 안 됨) · 스레드 (Ned 가 찾은 대상)", label: "Slack 보내기", slack: SLACK_OK } }, { id: "7" });
    document.body.innerHTML = html;
    const chips = [...document.querySelectorAll(".ca-pv .ca-chip")].map((e) => e.textContent);
    expect(chips).toEqual(["@사람A · U0TESTPA01", "@사람B · U0TESTPB01"]);
    expect([...document.querySelectorAll(".ca-badge.unk")].map((e) => e.textContent)).toContain("채널 이름 확인 안 됨 · C0TESTOPS01");
    expect(document.querySelector(".ca-notify")!.textContent).toBe("알림 받는 사람: 사람A(U0TESTPA01), 사람B(U0TESTPB01)");
    expect(document.querySelector(".ca-badge.src")!.textContent).toBe("Ned 가 찾은 대상 — 맞는지 확인");
    expect([...document.querySelectorAll(".ca-badge.unk")].map((e) => e.textContent)).toContain("외부 여부 확인 못 함");
    expect(document.querySelector(".ca-ex")!.textContent).toBe("Ned 발췌: “11/10 샘플 오류 현황 공유드립니다…”");
    expect(document.querySelector("[data-ca-edited]")!.hasAttribute("hidden")).toBe(true);
  });

  it("N2: a name only the model vouches for → yellow '이름 확인 안 됨'; a different model name → red mismatch badge (chip + notify line)", () => {
    const sl = { ...SLACK_OK, preview_text: "<@U0TESTPA01> <@U0TESTPB01> 확인", mentions: { resolved: [
      { text: "@사람A", kind: "user", id: "U0TESTPA01", name: "사람A", verified: false },
      { text: "@사람B", kind: "user", id: "U0TESTPB01", name: "사람B", verified: true, name_mismatch: true, model_name: "사람Z" },
    ], unresolved: [], missing: [] } };
    document.body.innerHTML = renderActionCard(BLOCK, { status: "idle", preview: { slack: sl } }, { id: "12" });
    expect(document.querySelector(".ca-pv .ca-badge.unv")!.textContent).toBe("이름 확인 안 됨");
    expect(document.querySelector(".ca-pv .ca-badge.mis")!.textContent).toBe('이름 불일치: 모델 "사람Z"');
    expect(document.querySelector(".ca-notify")!.textContent).toBe('알림 받는 사람: 사람A(U0TESTPA01 · 이름 확인 안 됨), 사람B(U0TESTPB01 · 이름 불일치: 모델 "사람Z")');
  });

  it("N7: no workspace domain set → a grey '워크스페이스 주소 미설정' badge", () => {
    document.body.innerHTML = renderActionCard(BLOCK, { status: "idle", preview: { slack: { ...SLACK_OK, workspace_unset: true } } }, { id: "13" });
    expect([...document.querySelectorAll(".ca-badge.unk")].map((e) => e.textContent)).toContain("워크스페이스 주소 미설정");
  });

  it("external people / channel → 외부 badge and (외부: …) in the notify line; not-found and group chips", () => {
    const sl = { ...SLACK_OK, external: "external", preview_text: "<@U0TESTEX01> @사람C @sample-team <!subteam^S0TESTGRP1> 확인",
      mentions: { resolved: [{ text: "@사람X", kind: "user", id: "U0TESTEX01", name: "사람X", external: true }, { text: "@mobile-dev", kind: "group", id: "S0TESTGRP1", name: "@mobile-dev" }], unresolved: [], missing: [{ text: "@사람C", kind: "user" }, { text: "@sample-team", kind: "group" }] } };
    expect(notifyLine(sl)).toBe("알림 받는 사람: 👥 @mobile-dev (외부: 사람X(U0TESTEX01))");
    document.body.innerHTML = renderActionCard(BLOCK, { status: "idle", preview: { slack: sl } }, { id: "8" });
    expect(document.querySelector(".ca-badge.ext")!.textContent).toBe("외부");
    const chips = [...document.querySelectorAll(".ca-pv .ca-chip")].map((e) => e.textContent);
    expect(chips).toEqual(["@사람X · U0TESTEX01", "@사람C — 못 찾음, 글자로 보냄", "👥 @sample-team — 그룹 ID 없음, 글자로 보냄", "👥 @mobile-dev · S0TESTGRP1"]);
    expect(document.querySelector(".ca-chip.warn.grp")!.getAttribute("title")).toBe("그룹 ID 를 설정 → 소스 → Slack 에 넣으면 멘션됨");
  });

  it("escapes model-written names in chips", () => {
    const sl = { ...SLACK_OK, preview_text: "<@U0TESTPA01>", mentions: { resolved: [{ text: "@x", kind: "user", id: "U0TESTPA01", name: "<img src=x onerror=alert(1)>" }], unresolved: [], missing: [] } };
    expect(mentionPreviewHtml(sl.preview_text, sl)).not.toContain("<img");
  });

  it("H4: broadcast mentions show as red chips; L2: a glued name shows why it stays text", () => {
    const sl = { ...SLACK_OK, preview_text: "@here <!channel> @사람A씨네 확인", mentions: { resolved: [], unresolved: [], missing: [{ text: "@사람A", kind: "user", reason: "뒤에 글자가 붙어 이름 경계를 알 수 없음" }], broadcast: ["@here", "<!channel>"] } };
    document.body.innerHTML = renderActionCard(BLOCK, { status: "idle", preview: { slack: sl }, previewError: "전체 알림 멘션은 대화창에서 보낼 수 없음 — Slack 에서 직접" }, { id: "10" });
    expect([...document.querySelectorAll(".ca-chip.bad")].map((e) => e.textContent)).toEqual(["@here — 전체 알림, 보낼 수 없음", "<!channel> — 전체 알림, 보낼 수 없음"]);
    expect(document.querySelector(".ca-chip.warn")!.textContent).toBe("@사람A — 이름 경계 모름, 글자로 보냄");
  });

  it("M2: a cache-resolved mention is a choice with a '캐시로 해석' badge", () => {
    const sl = { ...SLACK_OK, mentions: { resolved: [], unresolved: [{ text: "@사람C", via_cache: true, candidates: [{ id: "U0TESTPC01", name: "사람C" }] }], missing: [] } };
    document.body.innerHTML = renderActionCard(BLOCK, { status: "idle", preview: { slack: sl } }, { id: "11" });
    expect(document.querySelector(".ca-mc")!.textContent).toContain("캐시로 해석");
    expect([...document.querySelectorAll<HTMLOptionElement>('select[data-ca-mention="@사람C"] option')].map((o) => o.textContent)).toEqual(["고르기 (보내기 전에 필수)", "사람C · U0TESTPC01"]);
  });
});

describe("동명이인 dropdown", () => {
  const SAME = { ...BLOCK, mentions: [{ text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A", title: "운영" }, { id: "U0TESTPA02", name: "사람A", title: "디자인" }] }], text: "@사람A님 확인 부탁드려요" };
  const NEED = { ...SLACK_OK, preview_text: SAME.text, mentions: { resolved: [], unresolved: [{ text: "@사람A", candidates: SAME.mentions[0].candidates }], missing: [] } };

  it("shows a select per unresolved mention; picking one re-validates with mention_choices; run sends them along", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const state: Record<string, unknown> = { status: "idle", preview: { slack: NEED }, previewError: "멘션 선택 필요: @사람A" };
    const render = () => { root.innerHTML = renderActionCard(SAME, state, { id: "9" }); };
    render();
    const sel = root.querySelector<HTMLSelectElement>('select[data-ca-mention="@사람A"]')!;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "U0TESTPA01", "U0TESTPA02"]);
    expect(sel.options[2].textContent).toBe("사람A · 디자인 · U0TESTPA02");

    const postJson = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, endpoint: "/api/send", label: "Slack 보내기", payload: { source: "slack", mode: "send", ref: {}, text: "<@U0TESTPA02>님 확인 부탁드려요", origin: "chat" } } }));
    const sendAndWait = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, detail: "https://acme.slack.com/archives/C0TESTOPS01/p2" } }));
    wireActionCards(root, {
      get: () => ({ block: SAME, state }),
      set: (_id: string, patch: Record<string, unknown>, rerender = true) => { Object.assign(state, patch); if (rerender) render(); },
      persist: async () => ({ ok: true, status: 200 }),
      deps: { postJson, sendAndWait },
      ctx: () => ({ conversation_id: "c-test0009" }),
    });
    sel.value = "U0TESTPA02";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    expect(state.mention_choices).toEqual({ "@사람A": "U0TESTPA02" });
    expect(state.preview).toBeNull(); // → comms.js cardState re-validates with the choice
    expect(sendAndWait).not.toHaveBeenCalled(); // choosing never sends

    root.querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    expect(postJson).toHaveBeenCalledWith("/api/chat/actions/validate", expect.objectContaining({ conversation_id: "c-test0009", mention_choices: { "@사람A": "U0TESTPA02" }, intent: "run" }));
    expect(sendAndWait).toHaveBeenCalledTimes(1);
    expect((sendAndWait.mock.calls[0] as unknown[])[0]).toMatchObject({ text: "<@U0TESTPA02>님 확인 부탁드려요", origin: "chat" });
  });
});

describe("N1: edit → [실행] shows the new preview first", () => {
  it("typing reveals '편집됨'; the first run sends no digest → 409 need_review → new chips + digest; the second run sends it and goes through", async () => {
    const B = { ...BLOCK, text: "확인 부탁드려요", mentions: [{ text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A" }] }] };
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const state: Record<string, unknown> = { status: "idle", preview: { slack: { ...SLACK_OK, preview_text: "확인 부탁드려요", mentions: { resolved: [], unresolved: [], missing: [] } }, digest: "d-old" } };
    const render = () => { root.innerHTML = renderActionCard(B, state, { id: "20" }); };
    render();
    const NEW = { ...SLACK_OK, preview_text: "<@U0TESTPA01> 확인 부탁드려요", mentions: { resolved: [{ text: "@사람A", kind: "user", id: "U0TESTPA01", name: "사람A", verified: true }], unresolved: [], missing: [] } };
    const postJson = vi.fn(async (_u: string, body: Record<string, unknown>) => body.ack_digest === "d-new"
      ? { ok: true, status: 200, data: { ok: true, endpoint: "/api/send", label: "Slack 보내기", payload: { source: "slack", mode: "send", ref: {}, text: "<@U0TESTPA01> 확인 부탁드려요", origin: "chat", ack_digest: "d-new" } } }
      : { ok: false, status: 409, data: { ok: false, need_review: true, preview_digest: "d-new", slack: NEW, error: "보낼 모양이 바뀌었어 — 새 미리보기(알림 받는 사람)를 확인하고 다시 실행해 줘" } });
    const sendAndWait = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, detail: "https://acme.slack.com/archives/C0TESTOPS01/p3" } }));
    wireActionCards(root, {
      get: () => ({ block: B, state }),
      set: (_id: string, patch: Record<string, unknown>, rerender = true) => { Object.assign(state, patch); if (rerender) render(); },
      persist: async () => ({ ok: true, status: 200 }),
      deps: { postJson, sendAndWait },
      ctx: () => ({ conversation_id: "c-test0020" }),
    });
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
    const ta = root.querySelector<HTMLTextAreaElement>("[data-ca-text]")!;
    ta.value = "@사람A 확인 부탁드려요";
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector("[data-ca-edited]")!.hasAttribute("hidden")).toBe(false);

    root.querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    await flush();
    expect((postJson.mock.calls[0] as unknown[])[1]).toMatchObject({ intent: "run", ack_digest: "" }); // edited: no digest of the old preview
    expect(sendAndWait).not.toHaveBeenCalled();
    expect([...root.querySelectorAll(".ca-pv .ca-chip")].map((e) => e.textContent)).toEqual(["@사람A · U0TESTPA01"]);
    expect(root.querySelector("[data-ca-edited]")!.hasAttribute("hidden")).toBe(true);

    root.querySelector<HTMLButtonElement>("[data-ca-run]")!.click();
    await flush();
    expect((postJson.mock.calls[1] as unknown[])[1]).toMatchObject({ ack_digest: "d-new" });
    expect(sendAndWait).toHaveBeenCalledTimes(1);
    expect((sendAndWait.mock.calls[0] as unknown[])[0]).toMatchObject({ ack_digest: "d-new", text: "<@U0TESTPA01> 확인 부탁드려요" });
  });
});

describe("no [실행], no send", () => {
  it("rendering + preview validate never call /api/send", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(url === "/api/chat/actions/validate" ? { ok: true, endpoint: "/api/send", slack: SLACK_OK, target_label: "Slack · #sample-ops", label: "Slack 보내기", payload: {} } : {}), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const html = messagesHtml([{ role: "user", text: "물어봐 줘", ts: 1 }, { role: "ned", text: `물어볼게.\n\`\`\`ned-action\n${JSON.stringify(BLOCK)}\n\`\`\``, ts: 2 }], COMMS_VOICE.ned);
    document.body.innerHTML = html;
    expect(document.querySelector('[data-ca="2"] [data-ca-run]')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.filter((u) => u.startsWith("/api/send"))).toEqual([]);
    vi.unstubAllGlobals();
  });
});

describe("settings: 대화창 하루 상한 · 그룹 핸들 ↔ ID", () => {
  it("the chat group renders #c-chat-limit (not a toggle); read + guard; group ids parse / guard", async () => {
    // @ts-expect-error — plain browser ES module (public/app), no types
    const sa = await import("../public/app/tabs/settings-actions.js");
    const defaults = { chat_write: false, chat_session_create: false, chat_write_daily_limit: 20 };
    const root = document.createElement("div");
    root.innerHTML = sa.writeActionsHtml({ actions: { chat_write: true, chat_write_daily_limit: 5 } }, defaults, {});
    expect(root.querySelector('[data-wagrp="chat"] #c-chat-limit')).not.toBeNull();
    expect(root.querySelector('[data-act="chat_write_daily_limit"]')).toBeNull();
    expect(root.querySelector('[data-wagrp="other"]')).toBeNull();
    expect(sa.readChatLimit(root)).toBe(5);
    expect(sa.chatLimitMsg({ chat_write_daily_limit: 201 })).toContain("0~200");
    expect(sa.chatLimitMsg({ chat_write_daily_limit: 0 })).toBeNull();
    expect(sa.parseGroupIds("@Sample-Team = s0testgrp1\nqa: S0TESTGRP2, ")).toEqual(["sample-team=S0TESTGRP1", "qa=S0TESTGRP2"]);
    expect(sa.groupIdsText({ "sample-team": "S0TESTGRP1" })).toBe("sample-team = S0TESTGRP1");
    expect(sa.groupIdsMsg(["sample-team=S0TESTGRP1"])).toBeNull();
    expect(sa.groupIdsMsg(["sample team"])).toContain("형식");
  });
});

describe("복사용 초안", () => {
  it("mentionMap: settled mentions only (one candidate or the card's choice); groups excluded", () => {
    const m = { mentions: [{ text: "@사람A", candidates: [{ id: "U0TESTPA01" }] }, { text: "@사람B", candidates: [{ id: "U0TESTPB01" }, { id: "U0TESTPB02" }] }, { text: "@sample", group: true, candidates: [] }] };
    expect(mentionMap(m)).toEqual({ "@사람A": "<@U0TESTPA01>" });
    expect(mentionMap(m, { "@사람B": "U0TESTPB02" })).toEqual({ "@사람A": "<@U0TESTPA01>", "@사람B": "<@U0TESTPB02>" });
    expect(withMentionIds("@사람A님 @사람A.x", { "@사람A": "<@U0TESTPA01>" })).toBe("<@U0TESTPA01>님 @사람A.x");
  });

  it("a code block naming a settled mention gets '<@U…> 포함 복사' (with the caveat); others stay a plain copy", () => {
    expect(codeBlockHtml("그냥 글", { "@사람A": "<@U0TESTPA01>" })).not.toContain("cm-copy-alt");
    document.body.innerHTML = codeBlockHtml("@사람A님 지표 어디 있어요?", { "@사람A": "<@U0TESTPA01>" });
    expect(document.querySelector(".cm-copy")!.getAttribute("title")).toBe("@이름 텍스트로 복사");
    const alt = document.querySelector<HTMLElement>(".cm-copy-alt")!;
    expect(alt.dataset.alt).toBe("<@U0TESTPA01>님 지표 어디 있어요?");
    expect(document.querySelector(".cm-copyh")!.textContent).toBe("Slack 입력창에 붙이면 글자로 들어갈 수 있음 — 진짜 멘션은 Ned 로 보내기");
  });

  it("the answer's draft block offers it when the proposal's mentions are settled; clicks copy each text", async () => {
    const answer = `초안:\n\`\`\`\n@사람A님 @사람B님 샘플 지표 위치 알려 주세요 (@사람A준 아님)\n\`\`\`\n\`\`\`ned-action\n${JSON.stringify(BLOCK)}\n\`\`\``;
    document.body.innerHTML = messagesHtml([{ role: "ned", text: answer, ts: 3 }], COMMS_VOICE.ned, null, () => "", "", () => ({ status: "idle" }));
    const writes: string[] = [];
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t: string) => { writes.push(t); } }, configurable: true });
    const click = async (el: Element) => { await onCopyClick({ target: el, preventDefault() {} }); };
    await click(document.querySelector(".cm-copy")!);
    await click(document.querySelector(".cm-copy-alt")!);
    expect(writes).toEqual(["@사람A님 @사람B님 샘플 지표 위치 알려 주세요 (@사람A준 아님)", "<@U0TESTPA01>님 <@U0TESTPB01>님 샘플 지표 위치 알려 주세요 (@사람A준 아님)"]);
  });
});
