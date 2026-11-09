/**
 * ✓ 확인 키 end to end for a followed thread: the card row the daemon builds (applyThreadState → row.thread), the same
 * message as a "지난 N일" 이력 row (histrows.js histTarget + agenda slack.threads), the 팔로업 row, and the daemon's own
 * slackReviewKey / slackRecReviewed must all name one key — so a ✓ in any of them closes the others.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { SlackAllItem, SlackBlock } from "../src/agenda.js";
import { slackRecReviewed, slackReviewKey } from "../src/history.js";
import { applyThreadState, mergeThreadReads, syncThreadsFromList } from "../src/slack-threads.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { histAct } from "../public/app/features/histrows.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { srcCheck, srcKey } from "../public/app/features/revkeys.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { watchRow } from "../public/app/features/watchrow.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { S } from "../public/app/state.js";

const NOW = Date.now();
const sec = Math.floor(NOW / 1000);
const ts = (minAgo: number) => `${sec - minAgo * 60}.000100`;
const link = (ch: string, t: string) => `https://x.slack.com/archives/${ch}/p${t.replace(".", "")}`;
const iso = (t: string) => new Date(Number(t) * 1000).toISOString();
const ROOT = ts(120), MINE = ts(60), LATE = ts(5);
const reviewKeys = (html: string) => [...html.matchAll(/data-review="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));

/** A Slack block whose answered thread got a reply after mine → applyThreadState reopens it with row.thread. */
function block(): SlackBlock {
  const row: SlackAllItem = { channel: "#dev", from: "Kim", text: "배포 언제 해요?", url: link("C1", ROOT), ts: iso(ROOT), reason: "mention", answered: true };
  const s: SlackBlock = { summary: "", items: [], all: [row], watch: [] };
  s.threads = syncThreadsFromList([], s, NOW);
  mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, messages: [["Kim", ROOT], ["나", MINE], ["Kim", LATE]].map(([from, t]) => ({ from, ts: t, text: `${from} 메시지` })) }], NOW);
  applyThreadState(s);
  return s;
}
/** The same message as GET /api/history returns it (HistoryRow: item = the record's own fields, no thread). */
const histRow = (s: SlackBlock) => {
  const x = s.items[0];
  return { key: `C1:${ROOT}`, source: "slack", ts: x.ts, url: x.url, title: x.text, detail: "#dev · Kim", channel: "#dev", current: false, state: { need: true, answered: false, acked: false }, item: { channel: "#dev", from: "Kim", text: x.text, url: x.url, ts: x.ts } };
};

beforeEach(() => { S.agenda = { reviewed: {}, slack: { threads: [] } }; });

describe("✓ key: card row = 이력 row = 팔로업 row = daemon", () => {
  it("one `slack:<ch>:<ts>` key everywhere (thread metadata never in the key)", () => {
    const s = block();
    const card = s.items[0];
    expect(card.thread?.last_reply_ts).toBe(LATE);
    const want = `slack:C1:${ROOT}`;
    expect(slackReviewKey(card)).toBe(want); // daemon (history.ts)
    expect(srcKey("slack", card)).toBe(want); // card row (reviewed.js)
    expect(reviewKeys(srcCheck("slack", card))).toEqual([want]);
    S.agenda.slack.threads = s.threads; // what /api/agenda hands the dashboard
    expect(reviewKeys(histAct(histRow(s)))).toEqual([want]); // 이력 row
    expect(reviewKeys(watchRow("#dev", card))).toEqual([want]); // 팔로업 row
  });

  it("a ✓ made on the 이력 row shows on the card row and closes the record on the daemon side", () => {
    const s = block();
    S.agenda.slack.threads = s.threads;
    const key = reviewKeys(histAct(histRow(s)))[0];
    S.agenda.reviewed = { [key]: Date.now() };
    expect(srcCheck("slack", s.items[0])).toContain('aria-pressed="true"');
    expect(slackRecReviewed({ [key]: Date.now() }, { item: { url: s.items[0].url } as never, ts: s.items[0].ts })).toBe(true);
  });

  it("without the thread in agenda (not followed), every side falls back to the base key", () => {
    const s = block();
    const plain = { ...s.items[0], thread: undefined };
    expect(srcKey("slack", plain)).toBe(`slack:C1:${ROOT}`);
    expect(slackReviewKey(plain)).toBe(`slack:C1:${ROOT}`);
    expect(reviewKeys(histAct(histRow(s)))).toEqual([`slack:C1:${ROOT}`]);
  });
});
