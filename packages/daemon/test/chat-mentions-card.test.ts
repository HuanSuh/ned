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

const PL = "https://acme.slack.com/archives/C0TESTADS01/p1794277961148039";
const BLOCK = {
  kind: "slack_send",
  target: { url: PL, channel_name: "#ads-ops" },
  target_excerpt: "11/10 광고 오류 현황 공유드립니다…",
  mentions: [
    { text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A" }] },
    { text: "@사람B", candidates: [{ id: "U0TESTPB01", name: "사람B" }] },
  ],
  text: "@사람A님 @사람B님 보상 지급 지표는 어디서 볼 수 있을까요?",
  summary: "광고 오류 현황 스레드에 질문",
};
/** What validate answers for the golden block (server: chat-actions.ts slack_send). */
const SLACK_OK = {
  target_source: "found", channel: "C0TESTADS01", channel_name: "#ads-ops", thread_ts: "1794277961.148039", target_excerpt: BLOCK.target_excerpt, external: "unknown",
  preview_text: "<@U0TESTPA01>님 <@U0TESTPB01>님 보상 지급 지표는 어디서 볼 수 있을까요?",
  mentions: { resolved: [{ text: "@사람A", kind: "user", id: "U0TESTPA01", name: "사람A" }, { text: "@사람B", kind: "user", id: "U0TESTPB01", name: "사람B" }], unresolved: [], missing: [] },
};

describe("golden card: chips + 알림 받는 사람", () => {
  it("parseActionBlock keeps mentions / excerpt for validate", () => {
    const p = parseActionBlock(`물어볼게.\n\`\`\`ned-action\n${JSON.stringify(BLOCK)}\n\`\`\``);
    expect(p.block.mentions).toHaveLength(2);
    expect(p.block.target_excerpt).toBe(BLOCK.target_excerpt);
  });

  it("renders two name chips, the notify line, the source badge, the 외부 확인 못 함 badge and the excerpt", () => {
    const html = renderActionCard(BLOCK, { status: "idle", preview: { target_label: "Slack · #ads-ops · 스레드 (Ned 가 찾은 대상)", label: "Slack 보내기", slack: SLACK_OK } }, { id: "7" });
    document.body.innerHTML = html;
    const chips = [...document.querySelectorAll(".ca-pv .ca-chip")].map((e) => e.textContent);
    expect(chips).toEqual(["@사람A", "@사람B"]);
    expect(document.querySelector(".ca-notify")!.textContent).toBe("알림 받는 사람: 사람A, 사람B");
    expect(document.querySelector(".ca-badge.src")!.textContent).toBe("Ned 가 찾은 대상 — 맞는지 확인");
    expect(document.querySelector(".ca-badge.unk")!.textContent).toBe("외부 여부 확인 못 함");
    expect(document.querySelector(".ca-ex")!.textContent).toContain("광고 오류 현황");
    expect(document.querySelector(".ca-pv")!.textContent).not.toContain("U0TEST"); // ids only in title attributes
  });

  it("external people / channel → 외부 badge and (외부: …) in the notify line; not-found and group chips", () => {
    const sl = { ...SLACK_OK, external: "external", preview_text: "<@U0TESTEX01> @사람C @ads-team <!subteam^S0TESTGRP1> 확인",
      mentions: { resolved: [{ text: "@사람X", kind: "user", id: "U0TESTEX01", name: "사람X", external: true }, { text: "@mobile-dev", kind: "group", id: "S0TESTGRP1", name: "@mobile-dev" }], unresolved: [], missing: [{ text: "@사람C", kind: "user" }, { text: "@ads-team", kind: "group" }] } };
    expect(notifyLine(sl)).toBe("알림 받는 사람: 👥 @mobile-dev (외부: 사람X)");
    document.body.innerHTML = renderActionCard(BLOCK, { status: "idle", preview: { slack: sl } }, { id: "8" });
    expect(document.querySelector(".ca-badge.ext")!.textContent).toBe("외부");
    const chips = [...document.querySelectorAll(".ca-pv .ca-chip")].map((e) => e.textContent);
    expect(chips).toEqual(["@사람X", "@사람C — 못 찾음, 글자로 보냄", "👥 @ads-team — 그룹 ID 없음, 글자로 보냄", "👥 @mobile-dev"]);
    expect(document.querySelector(".ca-chip.warn.grp")!.getAttribute("title")).toBe("그룹 ID 를 설정 → 소스 → Slack 에 넣으면 멘션됨");
  });

  it("escapes model-written names in chips", () => {
    const sl = { ...SLACK_OK, preview_text: "<@U0TESTPA01>", mentions: { resolved: [{ text: "@x", kind: "user", id: "U0TESTPA01", name: "<img src=x onerror=alert(1)>" }], unresolved: [], missing: [] } };
    expect(mentionPreviewHtml(sl.preview_text, sl)).not.toContain("<img");
  });
});

describe("동명이인 dropdown", () => {
  const SAME = { ...BLOCK, mentions: [{ text: "@사람A", candidates: [{ id: "U0TESTPA01", name: "사람A", title: "광고" }, { id: "U0TESTPA02", name: "사람A", title: "디자인" }] }], text: "@사람A님 확인 부탁드려요" };
  const NEED = { ...SLACK_OK, preview_text: SAME.text, mentions: { resolved: [], unresolved: [{ text: "@사람A", candidates: SAME.mentions[0].candidates }], missing: [] } };

  it("shows a select per unresolved mention; picking one re-validates with mention_choices; run sends them along", async () => {
    const root = document.createElement("div");
    document.body.replaceChildren(root);
    const state: Record<string, unknown> = { status: "idle", preview: { slack: NEED }, previewError: "멘션 선택 필요: @사람A" };
    const render = () => { root.innerHTML = renderActionCard(SAME, state, { id: "9" }); };
    render();
    const sel = root.querySelector<HTMLSelectElement>('select[data-ca-mention="@사람A"]')!;
    expect([...sel.options].map((o) => o.value)).toEqual(["", "U0TESTPA01", "U0TESTPA02"]);
    expect(sel.options[2].textContent).toBe("사람A · 디자인");

    const postJson = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, endpoint: "/api/send", label: "Slack 보내기", payload: { source: "slack", mode: "send", ref: {}, text: "<@U0TESTPA02>님 확인 부탁드려요", origin: "chat" } } }));
    const sendAndWait = vi.fn(async () => ({ ok: true, status: 200, data: { ok: true, detail: "https://acme.slack.com/archives/C0TESTADS01/p2" } }));
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
    expect(postJson).toHaveBeenCalledWith("/api/chat/actions/validate", expect.objectContaining({ conversation_id: "c-test0009", mention_choices: { "@사람A": "U0TESTPA02" } }));
    expect(sendAndWait).toHaveBeenCalledTimes(1);
    expect((sendAndWait.mock.calls[0] as unknown[])[0]).toMatchObject({ text: "<@U0TESTPA02>님 확인 부탁드려요", origin: "chat" });
  });
});

describe("no [실행], no send", () => {
  it("rendering + preview validate never call /api/send", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(url === "/api/chat/actions/validate" ? { ok: true, endpoint: "/api/send", slack: SLACK_OK, target_label: "Slack · #ads-ops", label: "Slack 보내기", payload: {} } : {}), { status: 200, headers: { "content-type": "application/json" } });
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
    expect(sa.parseGroupIds("@Ads-Team = s0testgrp1\nqa: S0TESTGRP2, ")).toEqual(["ads-team=S0TESTGRP1", "qa=S0TESTGRP2"]);
    expect(sa.groupIdsText({ "ads-team": "S0TESTGRP1" })).toBe("ads-team = S0TESTGRP1");
    expect(sa.groupIdsMsg(["ads-team=S0TESTGRP1"])).toBeNull();
    expect(sa.groupIdsMsg(["ads team"])).toContain("형식");
  });
});

describe("복사용 초안", () => {
  it("mentionMap: settled mentions only (one candidate or the card's choice); groups excluded", () => {
    const m = { mentions: [{ text: "@사람A", candidates: [{ id: "U0TESTPA01" }] }, { text: "@사람B", candidates: [{ id: "U0TESTPB01" }, { id: "U0TESTPB02" }] }, { text: "@ads", group: true, candidates: [] }] };
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
    const answer = `초안:\n\`\`\`\n@사람A님 @사람B님 보상 지급 지표 위치 알려 주세요\n\`\`\`\n\`\`\`ned-action\n${JSON.stringify(BLOCK)}\n\`\`\``;
    document.body.innerHTML = messagesHtml([{ role: "ned", text: answer, ts: 3 }], COMMS_VOICE.ned, null, () => "", "", () => ({ status: "idle" }));
    const writes: string[] = [];
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: async (t: string) => { writes.push(t); } }, configurable: true });
    const click = async (el: Element) => { await onCopyClick({ target: el, preventDefault() {} }); };
    await click(document.querySelector(".cm-copy")!);
    await click(document.querySelector(".cm-copy-alt")!);
    expect(writes).toEqual(["@사람A님 @사람B님 보상 지급 지표 위치 알려 주세요", "<@U0TESTPA01>님 <@U0TESTPB01>님 보상 지급 지표 위치 알려 주세요"]);
  });
});
