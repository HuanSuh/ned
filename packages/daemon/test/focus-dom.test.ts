// @vitest-environment jsdom
/**
 * 항목 포커스 on the inbox DOM (tabs/inbox.js focusItem / openOriginal): the right tab, the row selected + highlighted +
 * scrolled to, the 확인 완료 fold opened for a ✓ item, the briefing block anchor, the gone case (top + toast), and `o`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.fn();
const openLinkMock = vi.fn();
vi.mock("../public/app/ui/toast.js", () => ({ toast }));
vi.mock("../public/app/api.js", () => ({ api: (...a: unknown[]) => api(...a) }));
vi.mock("../public/app/main.js", () => ({ loadState: vi.fn(), renderAll: vi.fn(), renderHeader: vi.fn() }));
vi.mock("../public/app/features/sendjob.js", () => ({ waitJob: vi.fn() }));
vi.mock("../public/app/features/openlink.js", () => ({ openLink: openLinkMock, init: vi.fn() }));

const api = vi.fn();
// @ts-expect-error — plain browser ES module (public/app), no types
const { focusItem, openOriginal, FOCUS_HL_MS, renderInbox, select, setTab, dismissSelected, flash, hashRoute, applyPendingFocus, onInboxKey } = await import("../public/app/tabs/inbox.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { S, ui } = await import("../public/app/state.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { PF } = await import("../public/app/ui/chips.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { isTypingTarget } = await import("../public/app/features/focus.js");
// @ts-expect-error — plain browser ES module (public/app), no types
const { feedHash, goFeedTarget } = await import("../public/app/features/comms.js");

const VIEWS = ["home", "inbox", "timeline", "settings"];
const key = (k: string, target: EventTarget = document.body) => {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  Object.defineProperty(ev, "target", { value: target });
  return { ev, handled: onInboxKey(ev) };
};

const NOW = Date.now();
const BID = "2026-11-18T02-00-00-000Z";
const SLACK = "https://acme.slack.com/archives/C0123ABCD/p1794193614524359";
const scrolled: Element[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  toast.mockReset(); openLinkMock.mockReset(); scrolled.length = 0;
  Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
  document.body.innerHTML = `<div id="leds"></div><div id="inbox"><div id="tabs"></div><div id="pf-inbox"></div><div id="items"></div><div id="detail"></div><div id="rail"></div></div><details id="msess"><summary id="msess-sum"></summary><div id="msess-rack"></div></details>`;
  S.events = [];
  S.agenda = { reviewed: {}, slack: { items: [{ channel: "#dev", from: "사람A", url: SLACK, ts: new Date(NOW).toISOString() }] } };
  S.briefings = [{ id: BID, ts: NOW - 60_000, type: "heartbeat", status: "UPDATE", headline: "샘플", action_items: [{ title: "첫 행동", kind: "slack" }, { title: "둘째 행동" }], updates: [{ title: "업데이트 하나", kind: "jira" }], fyi: [] }];
  S.state = {
    attention: [
      { id: `${BID}:0`, kind: "slack", title: "첫 행동", url: SLACK, ts: NOW, source: BID },
      { id: `${BID}:1`, kind: "jira", title: "둘째 행동", ts: NOW, source: BID, reviewed_at: NOW },
      { id: "session:s1", kind: "session", title: "입력 대기", ts: NOW, source: "sessions" },
    ],
    sessions: [{ id: "s1", worktree: "sample-wt", status: "waiting", cwd: "/tmp/x", since: NOW, last_event_ts: NOW, subagents_active: 0 }],
  };
  ui.view = "inbox"; ui.tab = "other"; ui.sel = 0; ui.selKey = null; ui.revOpenInbox = false; ui.revOpenOther = false; ui.detailSig = ""; ui.railOff = false;
  ui.hl = null; ui.focusKey = null; ui.pendingFocus = null;
  S.briefingsLoaded = true;
  PF.inbox.clear();
  history.replaceState(null, "", "#inbox");
});
afterEach(() => { vi.useRealTimers(); delete (window as { matchMedia?: unknown }).matchMedia; });
const setWidth = (narrow: boolean) => {
  (window as unknown as { matchMedia: (q: string) => { matches: boolean } }).matchMedia = (q: string) => ({ matches: narrow && q === "(max-width: 1180px)" });
};

describe("focusItem", () => {
  it("attention: 우선 tab, row selected, detail open, highlight + scrollIntoView, cleared after ~2.6 s; 출처 줄 in the detail", () => {
    const r = focusItem({ item: `${BID}:0` });
    expect(r).toMatchObject({ tab: "priority", key: `${BID}:0` });
    expect(ui.tab).toBe("priority");
    const row = document.querySelector("#items .row.sel")!;
    expect(row.textContent).toContain("첫 행동");
    expect(row.classList.contains("focus-hl")).toBe(true);
    expect(scrolled).toContain(row);
    expect(document.getElementById("detail")!.classList.contains("open")).toBe(true);
    expect(document.querySelector("#detail .srcline")!.textContent).toMatch(/^Slack · #dev · 사람A · /);
    expect(document.querySelector('#detail a.ib-src[data-src="slack"]')!.getAttribute("href")).toBe(SLACK);
    vi.advanceTimersByTime(FOCUS_HL_MS + 10);
    expect(row.classList.contains("focus-hl")).toBe(false);
  });

  it("✓ 처리된 항목: 확인 완료 fold opens, the row is shown with the 확인 완료 badge", () => {
    focusItem({ item: `${BID}:1` });
    expect(ui.revOpenInbox).toBe(true);
    expect(document.getElementById("revfold")!.getAttribute("aria-expanded")).toBe("true");
    const row = document.querySelector("#items .row.sel")!;
    expect(row.classList.contains("reviewed")).toBe(true);
    expect(row.classList.contains("focus-hl")).toBe(true);
    expect(document.querySelector("#detail .crumb")!.textContent).toContain("확인 완료");
  });

  it("briefing: 기록 tab, detail open at the item block (anchor highlighted + scrolled)", () => {
    focusItem({ item: `bf:${BID}`, at: "action_items.1" });
    expect(ui.tab).toBe("history");
    const li = document.querySelector('#detail [data-anchor="action_items.1"]')!;
    expect(li.textContent).toContain("둘째 행동");
    expect(li.classList.contains("focus-hl")).toBe(true);
    expect(scrolled).toContain(li);
  });

  it("a source pill hiding the row is cleared so the row can be shown", () => {
    PF.inbox.add("github");
    focusItem({ item: `${BID}:0` });
    expect(PF.inbox.size).toBe(0);
    expect(document.querySelector("#items .row.sel")!.textContent).toContain("첫 행동");
  });

  it("gone: that tab's top, detail closed, a short notice — nothing highlighted", () => {
    const r = focusItem({ item: "old-brief:fyi:3" });
    expect(r).toEqual({ missing: true, tab: "other" });
    expect(ui.tab).toBe("other");
    expect(toast).toHaveBeenCalledWith("항목이 더 이상 없음");
    expect(document.querySelector(".focus-hl")).toBeNull();
    expect(document.getElementById("detail")!.classList.contains("open")).toBe(false);
  });
});

describe("o — 원문", () => {
  it("URL → openLink (the shared opener, app deep link in Ned.app)", () => {
    expect(openOriginal({ kind: "slack", url: SLACK })).toBe("url");
    expect(openLinkMock).toHaveBeenCalledWith(SLACK);
  });
  it("unsafe URL never reaches openLink; a session goes to its rail unit (or the timeline when the rail is folded)", () => {
    focusItem({ item: "session:s1" });
    expect(openOriginal({ kind: "session", url: "javascript:alert(1)", sess: S.state.sessions[0] })).toBe("rail");
    expect(openLinkMock).not.toHaveBeenCalled();
    expect(document.querySelector('#rail .unit[data-sid="s1"]')!.classList.contains("focus-hl")).toBe(true);
    ui.railOff = true;
    expect(openOriginal({ kind: "session", sess: S.state.sessions[0] })).toBe("timeline");
    expect(location.hash).toBe("#timeline");
    expect([...S.filterWt]).toEqual(["sample-wt"]);
  });
  it("no URL, no session → the detail", () => {
    expect(openOriginal({ kind: "jira" })).toBe("detail");
    expect(openLinkMock).not.toHaveBeenCalled();
  });
  it("typing in an input / textarea / contenteditable: the page keys (o included) stay off", () => {
    document.body.insertAdjacentHTML("beforeend", `<input id="q"><textarea id="t"></textarea><div id="ce" contenteditable="true"></div><button id="b">x</button>`);
    expect(isTypingTarget(document.getElementById("q"))).toBe(true);
    expect(isTypingTarget(document.getElementById("t"))).toBe(true);
    const ce = document.getElementById("ce")!;
    Object.defineProperty(ce, "isContentEditable", { value: true }); // jsdom has no editing host
    expect(isTypingTarget(ce)).toBe(true);
    expect(isTypingTarget(document.getElementById("b"))).toBe(false);
  });
});

describe("통신기 message click → hash (comms.js feedHash)", () => {
  const model = () => ({ pri: [{ key: `${BID}:0`, att: { id: `${BID}:0` } }], other: [{ key: `${BID}:updates:0`, rk: "slack:C0999:1794193614.000001", rat: 0 }], hist: [{ key: `bf:${BID}`, brief: { id: BID } }] });
  it("attention / briefing → #item=…; a Slack thread focuses its 기타 row, else stays on #home; chat-only has no target", () => {
    expect(feedHash({ go: "inbox", target: { item: `${BID}:0`, tab: "priority" } }, model())).toBe(`#item=${encodeURIComponent(`${BID}:0`)}&tab=priority`);
    expect(feedHash({ go: "inbox", target: { item: `bf:${BID}`, tab: "history", at: "action_items.0" } }, model())).toBe(`#item=${encodeURIComponent(`bf:${BID}`)}&tab=history&at=action_items.0`);
    expect(feedHash({ go: "home", fallback: "home", target: { item: "slack:C0999:1794193614.000001", tab: "other" } }, model())).toBe(`#item=${encodeURIComponent("slack:C0999:1794193614.000001")}&tab=other`);
    expect(feedHash({ go: "home", fallback: "home", target: { item: "slack:C1:1.2", tab: "other" } }, model())).toBe("#home");
    expect(feedHash({ go: "inbox", target: { item: "<bad>" } }, model())).toBe("#inbox");
  });
  it("a Slack thread whose URL is not a message permalink (no representable key) → #home", () => {
    expect(feedHash({ go: "home", fallback: "home", target: { item: "slack:https://acme.slack.com/archives/C1?x=1", tab: "other" } }, model())).toBe("#home");
  });
  it("same message clicked again (hash unchanged) → a hashchange is still sent, so the focus runs again", () => {
    const seen = vi.fn();
    window.addEventListener("hashchange", seen);
    history.replaceState(null, "", `#item=${encodeURIComponent(`${BID}:0`)}&tab=priority`);
    goFeedTarget({ go: "inbox", target: { item: `${BID}:0`, tab: "priority" } });
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener("hashchange", seen);
  });
});

describe("review fixes", () => {
  it("M1: the highlight survives a polling re-render (outline only, no second blink) and ends after ~2.6 s", () => {
    focusItem({ item: `${BID}:0` });
    expect(document.querySelector("#items .row.sel")!.classList.contains("focus-hl")).toBe(true);
    renderInbox(); // e.g. the 10 s loadState
    const row = document.querySelector("#items .row.sel")!;
    expect(row.classList.contains("focus-hold")).toBe(true);
    expect(row.classList.contains("focus-hl")).toBe(false);
    vi.advanceTimersByTime(FOCUS_HL_MS + 10);
    expect(document.querySelector("#items .row.sel")!.className).not.toMatch(/focus-(hl|hold)/);
    renderInbox();
    expect(document.querySelector("#items .row.sel")!.className).not.toMatch(/focus-(hl|hold)/);
  });

  it("M2: the detail signature does not change as minutes pass (absolute time in the 출처 줄)", () => {
    focusItem({ item: `${BID}:0` });
    const sig = ui.detailSig, html = document.getElementById("detail")!.innerHTML;
    expect(document.querySelector("#detail .srcline")!.textContent).toMatch(/· \d{1,2}\/\d{1,2} \d\d:\d\d$/);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    renderInbox();
    expect(ui.detailSig).toBe(sig);
    expect(document.getElementById("detail")!.innerHTML).toBe(html);
  });

  it("M3: #item= stays while on the item, goes back to #inbox (no hashchange) on another row / tab / ✕", async () => {
    const seen = vi.fn();
    window.addEventListener("hashchange", seen);
    const h = `#item=${encodeURIComponent(`${BID}:0`)}&tab=priority`;
    history.replaceState(null, "", h);
    focusItem({ item: `${BID}:0` });
    select(ui.sel); // same row
    expect(location.hash).toBe(h);
    select(ui.sel + 1);
    expect(location.hash).toBe("#inbox");
    history.replaceState(null, "", h); focusItem({ item: `${BID}:0` });
    setTab("other");
    expect(location.hash).toBe("#inbox");
    history.replaceState(null, "", h); focusItem({ item: `${BID}:0` });
    api.mockResolvedValue({});
    await dismissSelected();
    expect(location.hash).toBe("#inbox");
    expect(seen).not.toHaveBeenCalled();
    window.removeEventListener("hashchange", seen);
  });

  it("L1: narrow screen (rail hidden) → the session is shown in the opened 세션 drawer, not the invisible rail", () => {
    setWidth(true);
    renderInbox();
    expect(openOriginal({ kind: "session", sess: S.state.sessions[0] })).toBe("drawer");
    expect((document.getElementById("msess") as HTMLDetailsElement).open).toBe(true);
    expect(document.querySelector('#msess-rack .unit[data-sid="s1"]')!.classList.contains("focus-hl")).toBe(true);
    expect(document.querySelector('#rail .unit[data-sid="s1"]')!.classList.contains("focus-hl")).toBe(false);
  });

  it("L2: flashing the same element again restarts it — the first timer does not cut the second short", () => {
    const el = document.createElement("div"); document.body.append(el);
    flash(el);
    vi.advanceTimersByTime(2000);
    flash(el);
    vi.advanceTimersByTime(1000); // 3 s after the first, 1 s after the second
    expect(el.classList.contains("focus-hl")).toBe(true);
    vi.advanceTimersByTime(FOCUS_HL_MS);
    expect(el.classList.contains("focus-hl")).toBe(false);
  });

  it("L3 / reload: a pending #item= waits for briefings + agenda, then focuses once", () => {
    const r = hashRoute(`#item=${encodeURIComponent(`bf:${BID}`)}&tab=history&at=action_items.1`, VIEWS);
    expect(r).toEqual({ view: "inbox", focus: { item: `bf:${BID}`, tab: "history", at: "action_items.1" } });
    ui.pendingFocus = r.focus;
    S.briefingsLoaded = false;
    expect(applyPendingFocus()).toBe(false);
    S.briefingsLoaded = true; const ag = S.agenda; S.agenda = undefined;
    expect(applyPendingFocus()).toBe(false);
    S.agenda = ag;
    expect(applyPendingFocus()).toBe(true);
    expect(ui.tab).toBe("history");
    expect(document.querySelector('#detail [data-anchor="action_items.1"]')!.classList.contains("focus-hl")).toBe(true);
    expect(applyPendingFocus()).toBe(false); // once
  });

  it("invalid hash → inbox, gone: top + toast, hash cleaned to #inbox", () => {
    expect(hashRoute("#inbox", VIEWS)).toEqual({ view: "inbox", focus: null });
    expect(hashRoute("#nope", VIEWS)).toEqual({ view: "home", focus: null });
    const bad = `#item=${encodeURIComponent('"]<x>')}`;
    const r = hashRoute(bad, VIEWS);
    expect(r.view).toBe("inbox");
    history.replaceState(null, "", bad);
    ui.pendingFocus = r.focus;
    applyPendingFocus();
    expect(toast).toHaveBeenCalledWith("항목이 더 이상 없음");
    expect(location.hash).toBe("#inbox");
  });

  it("keys through the real handler: ⏎ → detail (focus moves there), o → openOriginal, typing → ignored", () => {
    focusItem({ item: `${BID}:0` });
    document.getElementById("detail")!.classList.remove("open");
    expect(key("Enter").handled).toBe(true);
    expect(document.getElementById("detail")!.classList.contains("open")).toBe(true);
    expect(document.activeElement).toBe(document.getElementById("detail"));
    expect(openLinkMock).not.toHaveBeenCalled(); // ⏎ no longer opens the original
    expect(key("o").handled).toBe(true);
    expect(openLinkMock).toHaveBeenCalledWith(SLACK);
    openLinkMock.mockReset();
    document.body.insertAdjacentHTML("beforeend", `<input id="q2"><button id="b2">x</button>`);
    expect(key("o", document.getElementById("q2")!).handled).toBe(false);
    expect(key("Enter", document.getElementById("b2")!).handled).toBe(false);
    expect(openLinkMock).not.toHaveBeenCalled();
  });
});
