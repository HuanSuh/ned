/**
 * 항목 포커스 · 원문 바로가기 · 출처 줄 (public/app/features/focus.js, pure): hash parse / build (incl. hostile values),
 * message → target → inbox tab / row / anchor (attention · briefing item · Slack thread reply · ✓ · gone), source line
 * parts from data already there, the per-source 원문 button (safe schemes only), the typing guard for `o`.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { ANCHOR_RE, focusHash, isTypingTarget, originalOf, parseFocusHash, resolveFocus, sourceParts, srcBtn } from "../public/app/features/focus.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { buildFeed } from "../public/app/features/chat-core.js";

const NOW = Date.UTC(2026, 10, 18, 3, 0, 0);
const BID = "2026-11-18T02-00-00-000Z";
const SLACK = "https://acme.slack.com/archives/C0123ABCD/p1794193614524359";
const THREAD = "https://acme.slack.com/archives/C0999/p1794193614000001";

describe("parseFocusHash / focusHash", () => {
  it("round-trips ids with : . # / (attention, briefing item, review keys)", () => {
    for (const t of [{ item: `${BID}:0`, tab: "priority" }, { item: `${BID}:updates:2`, tab: "other" }, { item: `bf:${BID}`, tab: "history", at: "action_items.1" }, { item: "github:acme/app#42" }, { item: "session:abc-123" }]) {
      const h = focusHash(t);
      expect(h).toMatch(/^#item=/);
      expect(parseFocusHash(h)).toEqual(t);
    }
    expect(focusHash({ item: "slack:C1:1.2" })).toBe("#item=slack%3AC1%3A1.2");
  });

  it("not a focus hash → null; hostile / malformed values are dropped, never passed through", () => {
    expect(parseFocusHash("#inbox")).toBeNull();
    expect(parseFocusHash("")).toBeNull();
    expect(parseFocusHash("#item=")).toBeNull();
    expect(parseFocusHash(`#item=${encodeURIComponent('"]<img src=x onerror=alert(1)>')}`)).toBeNull();
    expect(parseFocusHash(`#item=${encodeURIComponent("a b")}`)).toBeNull();
    expect(parseFocusHash("#item=%E0%A4%A")).toBeNull(); // bad percent-encoding
    expect(parseFocusHash(`#item=${"x".repeat(201)}`)).toBeNull();
    // the id is fine, the extras are not → extras ignored
    expect(parseFocusHash(`#item=a1&tab=settings&at=${encodeURIComponent('x"]')}`)).toEqual({ item: "a1" });
    expect(parseFocusHash("#item=a1&at=action_items.0%22%5D")).toEqual({ item: "a1" });
    expect(parseFocusHash("#item=a1&at=%E0%A4%A&tab=other")).toEqual({ item: "a1", tab: "other" });
    expect(focusHash({ item: "<x>" })).toBeNull();
    expect(focusHash({ item: "a1", tab: "nope", at: "raw.1" })).toBe("#item=a1");
    expect(ANCHOR_RE.test("fyi.3")).toBe(true);
    expect(ANCHOR_RE.test("fyi.3]")).toBe(false);
  });
});

// A hand-built inbox model (tabs/inbox.js model() shape).
const att = (id: string, extra = {}) => ({ key: id, att: { id, ...extra }, kind: "slack" });
const M = {
  pri: [att(`${BID}:0`), att(`${BID}:1`, { reviewed_at: NOW }), att("session:s1")],
  other: [{ key: `${BID}:updates:0`, rk: "slack:C0999:1794193614.000001", rat: 0 }, { key: `${BID}:fyi:0`, rk: "mail:t1", rat: NOW }],
  hist: [{ key: `bf:${BID}`, brief: { id: BID } }, { key: "ok:b-ok2", okrun: [{ id: "b-ok2" }, { id: "b-ok1" }] }],
};

describe("resolveFocus", () => {
  it("attention → 우선; ✓ 처리된 것은 reviewed", () => {
    expect(resolveFocus({ item: `${BID}:0` }, M)).toEqual({ tab: "priority", key: `${BID}:0`, reviewed: false });
    expect(resolveFocus({ item: `${BID}:1` }, M)).toEqual({ tab: "priority", key: `${BID}:1`, reviewed: true });
  });
  it("briefing item (id + section + index) → 기타; a review key (Slack reply / mail) finds the same 기타 row", () => {
    expect(resolveFocus({ item: `${BID}:updates:0` }, M)).toMatchObject({ tab: "other", key: `${BID}:updates:0` });
    expect(resolveFocus({ item: "slack:C0999:1794193614.000001", tab: "other" }, M)).toMatchObject({ tab: "other", key: `${BID}:updates:0`, reviewed: false });
    expect(resolveFocus({ item: "mail:t1" }, M)).toMatchObject({ tab: "other", key: `${BID}:fyi:0`, reviewed: true });
  });
  it("briefing → 기록 with its anchor; a quiet briefing finds its folded NED_OK row", () => {
    expect(resolveFocus({ item: `bf:${BID}`, at: "action_items.0" }, M)).toEqual({ tab: "history", key: `bf:${BID}`, reviewed: false, at: "action_items.0" });
    expect(resolveFocus({ item: "bf:b-ok1" }, M)).toMatchObject({ tab: "history", key: "ok:b-ok2" });
  });
  it("dismissed attention → its briefing's 행동 필요 block; gone everywhere → missing (with the tab to show)", () => {
    expect(resolveFocus({ item: `${BID}:4` }, M)).toEqual({ tab: "history", key: `bf:${BID}`, reviewed: false, at: "action_items.4" });
    expect(resolveFocus({ item: "old-brief:2" }, M)).toEqual({ missing: true, tab: "priority" });
    expect(resolveFocus({ item: "old-brief:fyi:1" }, M)).toEqual({ missing: true, tab: "other" });
    expect(resolveFocus({ item: "slack:C9:1.2", tab: "other" }, M)).toEqual({ missing: true, tab: "other" });
    expect(resolveFocus(null, M)).toEqual({ missing: true, tab: "priority" });
  });
});

describe("buildFeed targets + short source line", () => {
  const state = {
    attention: [
      { id: `${BID}:0`, kind: "slack", title: "배포 언제?", url: SLACK, ts: NOW - 60_000, source: BID },
      { id: "session:s1", kind: "session", title: "입력 대기", ts: NOW - 30_000, source: "sessions" },
    ],
    sessions: [{ id: "s1", worktree: "sample-wt" }],
  };
  const briefings = [{ id: BID, ts: NOW - 120_000, type: "heartbeat", status: "UPDATE", headline: "결재 2건", action_items: [{}, {}] }];
  const agenda = {
    slack: { items: [{ channel: "#dev", from: "사람A", text: "배포 언제?", url: SLACK, ts: new Date(NOW - 60_000).toISOString(), reason: "mention" }],
      threads: [{ key: "C0999:1794193614.000001", channel: "#ops", url: THREAD, new_since_me: 1, last_reply_ts: "9", last_reply_at: new Date(NOW).toISOString(), last_reply_from: "사람B" }] },
  };
  it("attention / briefing / Slack thread each carry their target", () => {
    const f = buildFeed({ state, briefings, agenda }, new Set(), NOW);
    const by = Object.fromEntries(f.map((x: { key: string }) => [x.key, x]));
    expect(by[`att:${BID}:0`].target).toEqual({ item: `${BID}:0`, tab: "priority" });
    expect(by[`att:${BID}:0`].src).toEqual(["Slack", "#dev", "사람A"]);
    expect(by["att:session:s1"].src).toEqual(["세션", "sample-wt"]);
    expect(by[`brief:${BID}`].target).toEqual({ item: `bf:${BID}`, tab: "history", at: "action_items.0" });
    expect(by["thr:C0999:1794193614.000001@9"].target).toEqual({ item: "slack:C0999:1794193614.000001", tab: "other" });
    expect(by["thr:C0999:1794193614.000001@9"].fallback).toBe("home");
  });
});

describe("sourceParts (출처 줄)", () => {
  const agenda = {
    slack: { items: [], watch: [{ channel: "#watch", highlights: [{ from: "사람C", url: SLACK, ts: "2026-11-18T01:00:00Z", needs_me: true }] }] },
    mail: { items: [{ id: "t1", from: "사람D <d@example.com>", subject: "견적 회신", received: "2026-11-18T01:00:00Z", url: "https://mail.google.com/mail/u/0/#inbox/t1" }], all: [] },
    jira: [{ key: "ABC-12", status: "In Review", url: "https://example.atlassian.net/browse/ABC-12" }],
    github: [{ repo: "acme/app", number: 42, author: "dev-x", url: "https://github.com/acme/app/pull/42" }],
  };
  it("full: Slack channel · from · time, mail from · subject, Jira key · status, GitHub repo#n · author", () => {
    const fmt = () => "1시간 전";
    expect(sourceParts({ kind: "slack", url: SLACK }, { agenda, fmt })).toEqual(["Slack", "#watch", "사람C", "1시간 전"]);
    expect(sourceParts({ kind: "email", url: "https://mail.google.com/mail/u/0/#inbox/t1", id: "not-a-thread" }, { agenda })).toEqual(["메일", "사람D <d@example.com>", "견적 회신"]);
    expect(sourceParts({ kind: "jira", url: "https://example.atlassian.net/browse/ABC-12" }, { agenda })).toEqual(["Jira", "ABC-12", "In Review"]);
    expect(sourceParts({ kind: "github", url: "https://github.com/acme/app/pull/42" }, { agenda })).toEqual(["GitHub", "acme/app#42", "dev-x"]);
  });
  it("mail: found by the URL's thread token even when it is not the agenda id (L4)", () => {
    const ag = { mail: { items: [{ id: "gmail-id-1", from: "사람E", subject: "샘플 제목", url: "https://mail.google.com/mail/u/0/#inbox/FMfcgzSample" }], all: [] } };
    expect(sourceParts({ kind: "email", url: "https://mail.google.com/mail/u/0/#inbox/FMfcgzSample" }, { agenda: ag })).toEqual(["메일", "사람E", "샘플 제목"]);
  });
  it("short drops time / subject; unknown → just the kind label (no guessing)", () => {
    expect(sourceParts({ kind: "email", url: "https://mail.google.com/mail/u/0/#inbox/t1" }, { agenda, short: true })).toEqual(["메일", "사람D <d@example.com>"]);
    expect(sourceParts({ kind: "sentry", url: "https://sentry.io/x" }, { agenda })).toEqual(["Sentry"]);
    expect(sourceParts({ kind: "slack" }, { agenda: null })).toEqual(["Slack"]);
  });
});

describe("원문 button (srcBtn) / originalOf", () => {
  it("each source → its own URL and label; opened by the openlink.js delegate (plain external anchor)", () => {
    const cases: [string, string, string][] = [
      ["slack", SLACK, "Slack"], ["email", "https://mail.google.com/mail/u/0/#inbox/t1", "메일"], ["jira", "https://example.atlassian.net/browse/ABC-12", "Jira"],
      ["github", "https://github.com/acme/app/pull/42", "GitHub"], ["sentry", "https://sentry.io/issues/1/", "Sentry"],
    ];
    for (const [kind, url, name] of cases) {
      const h = srcBtn(kind, url);
      expect(h).toContain(`href="${url}"`);
      expect(h).toContain(`data-src="${kind}"`);
      expect(h).toContain(`title="${name}에서 원문 열기"`);
      expect(h).toContain('target="_blank" rel="noopener"');
    }
  });
  it("dangerous / missing schemes → no button", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,x", " javascript:x", "slack://channel?id=C1", "file:///etc/passwd", "", null]) expect(srcBtn("slack", u)).toBe("");
    expect(srcBtn("slack", 'https://x.test/"><script>')).toContain("&quot;&gt;&lt;script&gt;");
  });
  it("originalOf: url, else the session, else nothing", () => {
    expect(originalOf({ url: SLACK })).toEqual({ url: SLACK });
    expect(originalOf({ url: "javascript:x", sess: { id: "s1" } })).toEqual({ session: { id: "s1" } });
    expect(originalOf({ kind: "jira" })).toBeNull();
  });
});

describe("isTypingTarget", () => {
  it("inputs / textareas / selects / contenteditable swallow shortcuts", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(isTypingTarget({ tagName })).toBe(true);
    expect(isTypingTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: "BODY" })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
