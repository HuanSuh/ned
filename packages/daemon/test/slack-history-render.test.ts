import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain browser ES module (public/app), no types
import { histPanel, histToggle, historyOf, recentHtml } from "../public/app/features/slackthread.js";

const NOW = Date.parse("2026-11-07T03:00:00.000Z");
const sec = Math.floor(NOW / 1000);
const ts = (minAgo: number) => `${sec - minAgo * 60}.000100`;
const P = (n: number) => `https://x.slack.com/archives/C0123ABCD/p17300000000000${n}`;

beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => vi.useRealTimers());

const thread = { key: "C1:1.0", recent: [{ from: "Kim", ts: ts(30), text: "배포?" }, { from: "나", ts: ts(20), text: "오후 <3시>" }, { from: "Kim", ts: ts(5), text: "몇 시?" }] };
const dmRow = { reason: "dm", thread: { key: "D1:9.0", recent: [{ from: "Lee", ts: ts(2), text: "x" }] }, dm: { key: "dm:D1", recent: [{ from: "나", ts: ts(50), text: "네" }, { from: "Lee", ts: ts(40), text: "회의록 확인 부탁" }] } };

describe("history panel", () => {
  it("DM rows unfold the DM conversation; other rows their thread; nothing → null", () => {
    expect(historyOf(dmRow).key).toBe("dm:D1");
    expect(historyOf({ reason: "mention", thread }).key).toBe("C1:1.0");
    expect(historyOf({ reason: "dm" })).toBeNull();
    expect(histToggle({ reason: "mention", thread: { key: "k", recent: [{ from: "a", ts: ts(1), text: "only" }] } })).toBe("");
  });
  it("renders the toggle chip and a hidden panel, oldest first, my messages marked", () => {
    expect(histToggle({ reason: "mention", thread })).toMatchInlineSnapshot(`"<button type="button" class="chipx more hist-tg" data-hist="C1:1.0" aria-expanded="false" title="이 대화의 최근 메시지 3개 펼치기">▸ 이력 3</button>"`);
    const shuffled = { reason: "mention", thread: { ...thread, recent: [thread.recent[2], thread.recent[0], thread.recent[1]] } };
    expect(histPanel(shuffled)).toMatchInlineSnapshot(`"<div class="hist" data-hist-panel="C1:1.0" hidden><div class="trep"><span class="from">Kim</span><span class="tw">30분 전</span><span class="tx">배포?</span></div><div class="trep me"><span class="from">나</span><span class="tw">20분 전</span><span class="tx">오후 &lt;3시&gt;</span></div><div class="trep"><span class="from">Kim</span><span class="tw">5분 전</span><span class="tx">몇 시?</span></div></div>"`);
  });
});

describe("팔로업 recent", () => {
  it("lists the newest messages with ↗, skipping urls already shown", () => {
    const recent = [{ from: "a", text: "노드 패치 끝", ts: new Date(NOW - 10 * 60_000).toISOString(), url: P(1) }, { from: "b", text: "<ok>", ts: new Date(NOW - 3600_000).toISOString(), url: P(2) }];
    expect(recentHtml(recent)).toMatchInlineSnapshot(`"<div class="wrec"><div class="wrech">최근 대화</div><div class="trep"><span class="from">a</span><span class="tw">10분 전</span><span class="tx">노드 패치 끝</span><a class="wlk" href="https://x.slack.com/archives/C0123ABCD/p173000000000001" target="_blank" rel="noopener">↗</a></div><div class="trep"><span class="from">b</span><span class="tw">1시간 전</span><span class="tx">&lt;ok&gt;</span><a class="wlk" href="https://x.slack.com/archives/C0123ABCD/p173000000000002" target="_blank" rel="noopener">↗</a></div></div>"`);
    expect(recentHtml(recent, new Set([P(1), P(2)]))).toBe("");
    expect(recentHtml(undefined)).toBe("");
  });
});
