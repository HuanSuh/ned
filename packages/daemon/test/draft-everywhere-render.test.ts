/**
 * 답장 초안 확대 (dashboard side, pure modules in node): ✎ / ✓ on "지난 N일" 이력 rows (histrows.js), ✎ on every 팔로업
 * row · 최근 대화 · 요약 줄 (watchrow.js — shared by separate cards and the Slack card's fold), the refs they carry
 * (channel / ts / thread_ts, mail thread id, origin) and the 출처 chip of the action log.
 */
import { beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { draftFor, originChip, parseDraftAttr, slackRef } from "../public/app/features/draftref.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { histAct, histHtml, histTarget } from "../public/app/features/histrows.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { srcKey } from "../public/app/features/revkeys.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { RECENT_NOTE, summaryAct, watchFoldHtml, watchRecent, watchRow, watchSummary } from "../public/app/features/watchrow.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { summaryTarget } from "../public/app/features/watchsum.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { S } from "../public/app/state.js";

const P = (ch: string, sec: string, us = "000100") => `https://x.slack.com/archives/${ch}/p${sec}${us}`;
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");
/** Every data-draft payload in an html string. */
const drafts = (html: string) => [...html.matchAll(/data-draft="([^"]*)"/g)].map((m) => parseDraftAttr(unesc(m[1])));
const axms = (html: string) => [...html.matchAll(/data-axm="([^"]*)"/g)].map((m) => parseDraftAttr(unesc(m[1])));
const reviews = (html: string) => [...html.matchAll(/data-review="([^"]*)"/g)].map((m) => unesc(m[1]));

beforeEach(() => { S.agenda = { reviewed: {}, slack: { threads: [] } }; });

describe("지난 N일 이력 rows", () => {
  const slackRow = { key: "C9:1700000000.000100", source: "slack", ts: "2026-11-01T01:00:00.000Z", url: P("C9", "1700000000"), title: "배포 언제?", detail: "#ops · kim", channel: "#ops", current: false, state: { need: true, answered: false, acked: false }, item: { channel: "#ops", from: "kim", text: "배포 언제?", url: P("C9", "1700000000"), ts: "2026-11-01T01:00:00.000Z" } };
  const mailRow = { key: "th-42", source: "mail", ts: "2026-11-02T01:00:00.000Z", url: "https://mail.google.com/mail/u/0/#all/th-42", title: "견적서", detail: "boss", current: true, state: { needs_action: false }, item: { id: "th-42", from: "boss", subject: "견적서", snippet: "확인 부탁", why: "회신 필요", url: "https://mail.google.com/mail/u/0/#all/th-42" } };
  const jiraRow = { key: "AB-1", source: "jira", ts: "2026-11-02T01:00:00.000Z", url: "https://acme.atlassian.net/browse/AB-1", title: "버그", detail: "AB-1", current: false, state: { open: true }, item: { key: "AB-1", title: "버그", url: "https://acme.atlassian.net/browse/AB-1" } };

  it("Slack row → ✎ with channel / ts (origin history) + ✓ on the card's key", () => {
    const html = histAct(slackRow);
    const [d] = drafts(html);
    expect(d).toMatchObject({ source: "slack", origin: "history", ref: { url: slackRow.url, channel: "C9", ts: "1700000000.000100", text: "배포 언제?" } });
    expect(html).not.toContain(" soft"); // still needs me → full-strength ✎
    expect(html).toContain('data-att="slack:C9:1700000000.000100"');
    expect(reviews(html)).toEqual([srcKey("slack", slackRow.item)]);
  });

  it("Slack row of a followed thread → thread_ts + the card's `@reply` 확인 key", () => {
    S.agenda.slack.threads = [{ key: "C9:1700000000.000100", thread_ts: "1700000000.000100", reply_count: 3, last_reply_ts: "1700000500.000100" }];
    const t = histTarget(slackRow);
    expect(t.item.thread.last_reply_ts).toBe("1700000500.000100");
    const html = histAct(slackRow);
    expect(drafts(html)[0].ref.thread_ts).toBe("1700000000.000100");
    expect(reviews(html)).toEqual(["slack:C9:1700000000.000100@1700000500.000100"]);
  });

  it("mail row → ✎ with the thread id (dimmed: nothing to do) + ✓ on mail:<thread>", () => {
    const html = histAct(mailRow);
    expect(drafts(html)[0]).toMatchObject({ source: "email", origin: "history", ref: { thread_id: "th-42", title: "견적서 — boss", text: "회신 필요" } });
    expect(html).toContain("drb soft");
    expect(reviews(html)).toEqual(["mail:th-42"]);
  });

  it("✓ state is shared with the card (same key; a mark after the message counts)", () => {
    S.agenda.reviewed = { "mail:th-42": Date.parse("2026-11-03T00:00:00Z") };
    expect(histAct(mailRow)).toContain('aria-pressed="true"');
  });

  it("Jira row → the existing ⋯ (origin history), no ✎ / ✓", () => {
    const html = histAct(jiraRow);
    expect(drafts(html)).toEqual([]);
    expect(axms(html)[0]).toMatchObject({ kind: "jira", origin: "history", ref: { key: "AB-1" } });
    expect(reviews(html)).toEqual([]);
  });

  it("histHtml puts them in each row's actions cell", () => {
    const html = histHtml([mailRow, slackRow, jiraRow], 3, Date.parse("2026-11-09T00:00:00"));
    expect(drafts(html).map((d: { source: string }) => d.source)).toEqual(["email", "slack"]);
    expect(axms(html)).toHaveLength(1);
    expect(histHtml([slackRow], 1, Date.parse("2026-11-09T00:00:00"), null)).not.toContain("data-draft");
  });
});

describe("팔로업 rows", () => {
  const hl = (n: number, text: string, extra = {}) => ({ from: `u${n}`, text, url: P("C7", `170000000${n}`), ts: `2026-11-0${n}T01:00:00.000Z`, ...extra });

  it("every highlight row gets ✎ — needs_me full strength, the rest dimmed — always a thread reply", () => {
    const need = watchRow("#ops", hl(1, "리뷰 부탁", { needs_me: true }));
    const plain = watchRow("#ops", hl(2, "배포 완료"));
    expect(need).not.toContain("drb soft");
    expect(plain).toContain("drb soft");
    const d = drafts(plain)[0];
    expect(d).toMatchObject({ source: "slack", origin: "watch", ref: { channel: "C7", ts: "1700000002.000100", thread_ts: "1700000002.000100", title: "#ops · u2" } });
  });

  it("최근 대화 rows: ✎ with ts as thread_ts", () => {
    const html = watchRecent({ channel: "#ops", recent: [{ from: "lee", text: "누가 봐 줄래요?", url: P("C7", "1700000009"), ts: "2026-11-08T01:00:00.000Z" }] });
    expect(drafts(html)[0].ref).toMatchObject({ channel: "C7", ts: "1700000009.000100", thread_ts: "1700000009.000100" });
  });

  it("slackRef keeps an explicit thread_ts and never forces one on a DM", () => {
    expect(slackRef({ url: `${P("C7", "1700000003")}?thread_ts=1699999999.000001` }, { thread: true }).thread_ts).toBe("1699999999.000001");
    expect(slackRef({ url: P("D1", "1700000003") }, { thread: true }).thread_ts).toBeUndefined();
    expect(slackRef({ url: P("C7", "1700000003") }).thread_ts).toBeUndefined(); // cards keep today's behaviour
  });

  describe("summary line → which message", () => {
    const hls = [hl(1, "ABC-12 배포 일정 조율"), hl(2, "ABC-12 롤백 여부 결정"), hl(3, "점심 메뉴 투표")];
    const recent = [{ from: "park", text: "최신 메시지", url: P("C7", "1700000099"), ts: "2026-11-09T01:00:00.000Z" }];

    it("one clear match → that message", () => {
      const t = summaryTarget("점심 메뉴 투표 진행", hls, recent);
      expect(t).toMatchObject({ kind: "one", h: { from: "u3" } });
      expect(drafts(summaryAct("#ops")(t))[0].ref.ts).toBe("1700000003.000100");
    });

    it("several → a pick list (from · text, refs with thread_ts) in the modal", () => {
      const t = summaryTarget("ABC-12 논의 중", hls, recent);
      expect(t.kind).toBe("many");
      const d = drafts(summaryAct("#ops")(t))[0];
      expect(d.pick.map((c: { from: string }) => c.from)).toEqual(["u1", "u2"]);
      expect(d.pick[1]).toMatchObject({ source: "slack", label: "ABC-12 롤백 여부 결정", ref: { ts: "1700000002.000100", thread_ts: "1700000002.000100" }, att: "slack:C7:1700000002.000100" });
      expect(d.origin).toBe("watch");
    });

    it("none → the channel's newest message, with the 가장 최근 메시지 note", () => {
      const t = summaryTarget("전반적으로 조용함", hls, recent);
      expect(t).toMatchObject({ kind: "recent", h: { from: "park" } });
      const d = drafts(summaryAct("#ops")(t))[0];
      expect(d.note).toBe(RECENT_NOTE);
      expect(d.ref).toMatchObject({ ts: "1700000099.000100", thread_ts: "1700000099.000100" });
      expect(summaryTarget("조용함", [], [])).toBeNull();
    });

    it("watchSummary puts the ✎ on each line next to the ↗", () => {
      const html = watchSummary({ channel: "#ops", summary: "점심 메뉴 투표 진행\nABC-12 논의 중\n전반적으로 조용함", highlights: hls, recent });
      expect(html.match(/<li>/g)).toHaveLength(3);
      const ds = drafts(html);
      expect(ds.map((d: { pick?: unknown[]; note?: string }) => (d.pick ? "many" : d.note ? "recent" : "one"))).toEqual(["one", "many", "recent"]);
    });
  });

  it("both placements render the same ✎ rows: separate card pieces and the Slack card's fold", () => {
    const w = { channel: "#ops", summary: "점심 메뉴 투표 진행", highlights: [hl(1, "리뷰 부탁", { needs_me: true }), hl(3, "점심 메뉴 투표")], recent: [] };
    const cardHtml = watchSummary(w) + w.highlights.map((h) => watchRow(w.channel, h)).join("");
    const foldHtml = watchFoldHtml([w], 1, false);
    const refsOf = (html: string) => drafts(html).map((d: { ref: { ts: string } }) => d.ref.ts).sort();
    expect(refsOf(foldHtml)).toEqual(refsOf(cardHtml));
    expect(refsOf(foldHtml)).toEqual(["1700000001.000100", "1700000003.000100", "1700000003.000100"]);
    expect(foldHtml).toContain('class="wsum sws"');
    // a quiet channel in the fold: 최근 대화 with ✎
    const quiet = watchFoldHtml([{ channel: "#q", highlights: [], recent: [{ from: "a", text: "x", url: P("C8", "1700000005"), ts: "2026-11-05T00:00:00Z" }] }]);
    expect(drafts(quiet)[0].ref.thread_ts).toBe("1700000005.000100");
    expect(watchFoldHtml([])).toBe("");
  });
});

describe("refs / chips", () => {
  it("draftFor: string 4th arg = origin; Jira etc. get the ⋯ with origin", () => {
    expect(drafts(draftFor("slack", { url: P("C1", "1700000001") }, "", "card"))[0].origin).toBe("card");
    expect(axms(draftFor("github", { url: "https://github.com/o/r/pull/5" }, "", "card"))[0]).toMatchObject({ kind: "github", origin: "card", ref: { repo: "o/r", number: "5" } });
    expect(drafts(draftFor("slack", { url: P("C1", "1700000001") }))[0]).not.toHaveProperty("origin");
  });
  it("action log 출처 chip per origin; none for older entries", () => {
    expect(originChip("chat")).toContain(">대화창<");
    expect(originChip("card")).toContain(">카드<");
    expect(originChip("history")).toContain(">지난 N일<");
    expect(originChip("watch")).toContain(">팔로업<");
    expect(originChip(undefined)).toBe("");
    expect(originChip("evil")).toBe("");
  });
});
