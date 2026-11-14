/**
 * ✓ 확인 완료 — one rule on both sides. src/review-keys.ts is the definition, public/app/features/revkeys.js a copy:
 * every fixture here runs through both, plus the daemon paths that use it (finalizeSlackView, slackRecReviewed,
 * markThreadSeen / hasNewSinceMe, phase-2 last_reply_ts correction, readReviewed's fold of old `@…` keys).
 */
import fs from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import type { SlackAllItem, SlackBlock } from "../src/agenda.js";
import { finalizeSlackView, slackRecReviewed } from "../src/history.js";
import { REVIEWED_PATH } from "../src/paths.js";
import * as server from "../src/review-keys.js";
import { threadAttention } from "../src/heartbeat.js";
import { UNKNOWN_REPLY, applyThreadState, hasNewSinceMe, markThreadSeen, markTs, mergeThreadReads, syncThreadsFromList } from "../src/slack-threads.js";
import { readReviewed, setReviewed } from "../src/state.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { newReplies } from "../public/app/features/slackthread.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { histTarget } from "../public/app/features/histrows.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import * as client from "../public/app/features/revkeys.js";
// @ts-expect-error — plain browser ES module (public/app), no types
import { S } from "../public/app/state.js";

const NOW = Date.UTC(2026, 10, 9, 3, 0, 0);
const sec = Math.floor(NOW / 1000);
/** Slack ts `min` minutes before NOW. */
const ts = (min: number) => `${sec - min * 60}.000100`;
const msOf = (t: string) => Number(t) * 1000;
const link = (ch: string, t: string, thread?: string) => `https://x.slack.com/archives/${ch}/p${t.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${ch}` : ""}`;
const iso = (t: string) => new Date(msOf(t)).toISOString();
const SIDES = [["server", server], ["client", client]] as const;

// Live observation: phase 2 recorded last_reply_ts = thread_ts = root, phase 1 already saw a newer reply.
const ROOT = ts(120), SEARCH = ts(30);
const liveRow = () => ({ channel: "#dev", from: "Kim", text: "배포?", url: link("C1", ROOT), ts: iso(ROOT), thread: { thread_ts: ROOT, last_reply_ts: ROOT, search_latest_ts: SEARCH } });

beforeEach(() => { S.agenda = { reviewed: {}, slack: { threads: [] } }; });

describe.each(SIDES)("%s: key", (_name, m) => {
  it("same Slack item → same key whatever the thread metadata says", () => {
    const base = { url: link("C1", ROOT), ts: iso(ROOT) };
    const want = `slack:C1:${ROOT}`;
    for (const thread of [undefined, null, {}, { last_reply_ts: ROOT }, { last_reply_ts: ts(5) }, { last_reply_ts: ts(500), search_latest_ts: ts(1) }]) {
      expect(m.srcKey("slack", { ...base, thread })).toBe(want);
    }
    expect(m.slackReviewKey({ url: link("C1", ts(5), ROOT) })).toBe(`slack:C1:${ts(5)}`); // a reply row: its own message ts
    expect(m.srcKey("slack", { url: "https://x.slack.com/odd" })).toBe("slack:https://x.slack.com/odd");
    expect(m.srcKey("slack", { url: "" })).toBe("");
    expect(m.srcKey("email", { id: "th1" })).toBe("mail:th1");
    expect(m.srcKey("jira", { url: "https://a.atlassian.net/browse/AB-1" })).toBe("jira:AB-1");
    expect(m.srcKey("github", { repo: "o/r", number: 3 })).toBe("github:o/r#3");
  });

  it("old `@…` marks fold into the base key, largest mark wins; others untouched", () => {
    const folded = m.foldReviewMarks({
      "slack:D0TESTDM001:1794193614.524359@1794193470.379259": 100,
      "slack:D0TESTDM001:1794193614.524359@1794193999.000001": 300,
      "slack:D0TESTDM001:1794193614.524359": 200,
      "slack:https://x.slack.com/odd@x": 5, // odd-permalink key (not channel:ts) → kept as is
      "mail:th1": 7,
      "session:a@b": 9,
    });
    expect(folded).toEqual({ "slack:D0TESTDM001:1794193614.524359": 300, "slack:https://x.slack.com/odd@x": 5, "mail:th1": 7, "session:a@b": 9 });
  });
});

describe.each(SIDES)("%s: open rule (mark ms vs the item's last change)", (_name, m) => {
  const key = `slack:C1:${ROOT}`;
  it("live case: mark after search_latest_ts → closed, although last_reply_ts is the root", () => {
    const x = liveRow();
    expect(m.activityMs("slack", x)).toBe(msOf(SEARCH));
    expect(m.reviewedAt({ [key]: msOf(SEARCH) + 1000 }, key, m.activityMs("slack", x))).toBeGreaterThan(0);
  });
  it("metadata-only change after the mark keeps it closed; a newer reply (either field) reopens it; earlier replies don't", () => {
    const mark = msOf(SEARCH) + 60_000, marks = { [key]: mark };
    const closed = (x: object) => !!m.reviewedAt(marks, key, m.activityMs("slack", x));
    expect(closed(liveRow())).toBe(true);
    // phase 2 re-reads: last_reply_ts fixed up to the search ts, summary etc. — nothing newer than the mark
    expect(closed({ ...liveRow(), thread: { thread_ts: ROOT, last_reply_ts: SEARCH, search_latest_ts: SEARCH, thread_summary: "새 요약" } })).toBe(true);
    expect(closed({ ...liveRow(), thread: undefined })).toBe(true);
    expect(closed({ ...liveRow(), thread: { thread_ts: ROOT, last_reply_ts: ts(10), search_latest_ts: SEARCH } })).toBe(false);
    expect(closed({ ...liveRow(), thread: { thread_ts: ROOT, last_reply_ts: ROOT, search_latest_ts: ts(10) } })).toBe(false);
    // a mark made before the newest known reply doesn't cover it
    expect(m.reviewedAt({ [key]: msOf(SEARCH) - 1000 }, key, m.activityMs("slack", liveRow()))).toBe(0);
  });
  it("mail / jira / github use their own last-change field", () => {
    expect(m.activityMs("email", { received: "2026-11-01T00:00:00Z", ts: "2026-11-05T00:00:00Z" })).toBe(Date.parse("2026-11-01T00:00:00Z"));
    expect(m.activityMs("email", { ts: "2026-11-05T00:00:00Z" })).toBe(Date.parse("2026-11-05T00:00:00Z"));
    expect(m.activityMs("jira", { updated: "2026-11-02T00:00:00Z" })).toBe(Date.parse("2026-11-02T00:00:00Z"));
    expect(m.activityMs("github", { updated: "2026-11-03T00:00:00Z", ts: "2026-11-01T00:00:00Z" })).toBe(Date.parse("2026-11-03T00:00:00Z"));
    expect(m.tsMs("1700000000.000100")).toBeCloseTo(1700000000000.1, 0);
    expect(m.tsMs("")).toBe(0);
  });
});

describe("daemon = dashboard on the same rows", () => {
  it("finalizeSlackView / slackRecReviewed / revkeys.revAt agree for the live case and after a new reply", () => {
    const thread = { key: `C1:${ROOT}`, channel_id: "C1", thread_ts: ROOT, channel: "#dev", url: link("C1", ROOT), prio: 0, first_seen_at: iso(ROOT), reply_count: 2, new_since_me: 0, participants: [], recent: [], last_reply_ts: ROOT, search_latest_ts: SEARCH };
    const marks = { [`slack:C1:${ROOT}`]: msOf(SEARCH) + 60_000 };
    const rec = { item: { url: link("C1", ROOT), ts: iso(ROOT) } as never, ts: iso(ROOT) };
    const row = () => ({ channel: "#dev", from: "Kim", text: "배포?", url: link("C1", ROOT), ts: iso(ROOT), reason: "mention" as const, thread: { ...thread } });
    const verdicts = () => {
      const s: SlackBlock = { summary: "", items: [row()], all: [], watch: [], threads: [thread] };
      finalizeSlackView(s, marks);
      S.agenda = { reviewed: marks, slack: { threads: [thread] } };
      return [s.items.length === 0, slackRecReviewed(marks, rec, [thread]), !!client.revAt("slack", row())];
    };
    expect(verdicts()).toEqual([true, true, true]);
    thread.search_latest_ts = ts(1); // a reply after the mark
    expect(verdicts()).toEqual([false, false, false]);
  });

  it("이력 row: record ts ≠ item ts — histTarget (item.ts, else record ts) and slackRecReviewed agree", () => {
    const u = link("C1", ROOT), key = `slack:C1:${ROOT}`, MARK = msOf(ts(30));
    const cases = [
      { item: iso(ts(60)), rec: iso(ts(10)), want: true }, // item.ts older than the mark → closed on both sides, though the record ts is newer
      { item: "", rec: iso(ts(10)), want: false }, // no item.ts → both use the record ts (after the mark) → open
      { item: iso(ts(10)), rec: iso(ts(60)), want: false },
    ];
    for (const c of cases) {
      const row = { key: `C1:${ROOT}`, source: "slack", ts: c.rec, url: u, title: "t", detail: "", current: false, state: {}, item: { channel: "#dev", from: "Kim", text: "t", url: u, ...(c.item ? { ts: c.item } : {}) } };
      S.agenda = { reviewed: { [key]: MARK }, slack: { threads: [] } };
      const t = histTarget(row);
      expect(!!client.revAt("slack", t.item), JSON.stringify(c)).toBe(c.want);
      expect(slackRecReviewed({ [key]: MARK }, { item: row.item as never, ts: c.rec }), JSON.stringify(c)).toBe(c.want);
    }
  });

  it("srcCheck: a row without a key gets an inert ✓ (aria-disabled, clickable for the toast) titled 확인 키 없음, never a data-review", () => {
    const html = client.srcCheck("slack", { url: "", text: "x" });
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toMatch(/\sdisabled[\s>=]/);
    expect(html).toContain('title="확인 키 없음"');
    expect(html).not.toContain("data-review=");
    expect(client.srcCheck("slack", { url: link("C1", ROOT) })).toContain(`data-review="slack:C1:${ROOT}"`);
  });

  it("applyReviewMark: optimistic set / clear with an undo that restores the previous value; empty key → null", () => {
    expect(client.applyReviewMark({}, "", true)).toBeNull();
    expect(client.applyReviewMark({}, "nope", true)).toBeNull();
    const a = client.applyReviewMark({ "mail:t": 5 }, "slack:C1:1.1", true, 99);
    expect(a.next).toEqual({ "mail:t": 5, "slack:C1:1.1": 99 });
    expect(a.undo(a.next)).toEqual({ "mail:t": 5 });
    const b = client.applyReviewMark({ "slack:C1:1.1": 7 }, "slack:C1:1.1", false);
    expect(b.next).toEqual({});
    expect(b.undo(b.next)).toEqual({ "slack:C1:1.1": 7 });
  });
});

describe("markThreadSeen / hasNewSinceMe", () => {
  const block = (): SlackBlock => {
    const row: SlackAllItem = { channel: "#dev", from: "Kim", text: "배포?", url: link("C1", ROOT), ts: iso(ROOT), reason: "mention", answered: true };
    const s: SlackBlock = { summary: "", items: [], all: [row], watch: [] };
    s.threads = syncThreadsFromList([], s, NOW);
    return s;
  };
  it("seen = the mark time (Slack ts format); false right after; a reply after the mark → true; un-review clears", () => {
    const s = block(), t = s.threads![0];
    Object.assign(t, { last_reply_ts: ROOT, search_latest_ts: SEARCH, new_since_me: 1, my_last_reply_ts: ts(60) }); // live shape
    applyThreadState(s);
    expect(hasNewSinceMe(t)).toBe(true);
    expect(s.items).toHaveLength(1); // reopened
    const MARK = msOf(ts(20));
    expect(markThreadSeen(s, `slack:C1:${ROOT}`, true, MARK)).toBe(true);
    expect(t.seen_reply_ts).toBe(markTs(MARK));
    expect(t.seen_reply_ts).toBe(`${(MARK / 1000).toFixed(6)}`);
    expect(hasNewSinceMe(t)).toBe(false);
    expect(s.items).toHaveLength(0); // not reopened by the next pass
    applyThreadState(s);
    expect(s.items).toHaveLength(0);
    t.search_latest_ts = ts(2); // new reply seen by phase 1, after the mark
    expect(hasNewSinceMe(t)).toBe(true);
    expect(markThreadSeen(s, `slack:C1:${ROOT}`, false)).toBe(true);
    expect(t.seen_reply_ts).toBeUndefined();
  });

  it("M1: a reply posted before the ✓ but collected after it → row stays closed, no 새 답글 (daemon, heartbeat, +N chip); a reply after → both open", () => {
    const s = block(), t = s.threads![0];
    Object.assign(t, { last_reply_ts: ts(60), search_latest_ts: ts(60), new_since_me: 0, my_last_reply_ts: ts(60) });
    const MARK = msOf(ts(10)), key = `slack:C1:${ROOT}`, marks = { [key]: MARK };
    markThreadSeen(s, key, true, MARK);
    // Next collection: phase 1 sees a reply from 15 min ago (before the mark), phase 2 reads it.
    t.search_latest_ts = ts(15);
    mergeThreadReads(s.threads!, [{ key: `C1:${ROOT}`, messages: [{ from: "Kim", ts: ROOT, text: "배포?" }, { from: "나", ts: ts(60), text: "곧" }, { from: "Kim", ts: ts(15), text: "언제?" }] }], NOW);
    applyThreadState(s);
    const row = s.all[0];
    S.agenda = { reviewed: marks, slack: { threads: s.threads } };
    expect(t.new_since_me).toBe(1);
    expect(hasNewSinceMe(t)).toBe(false);
    expect(s.items).toHaveLength(0); // not reopened
    expect(threadAttention({ slack: s } as never, new Set(), NOW).items).toHaveLength(0); // no heartbeat alert
    expect(newReplies(row)).toBe(0); // no +N chip
    expect(client.revAt("slack", row)).toBeGreaterThan(0); // ✓ holds
    expect(finalizeVerdict(s, marks)).toBe(true);
    // A reply after the mark: everything opens together.
    t.search_latest_ts = ts(5);
    mergeThreadReads(s.threads!, [{ key: `C1:${ROOT}`, messages: [{ from: "Kim", ts: ROOT, text: "배포?" }, { from: "나", ts: ts(60), text: "곧" }, { from: "Kim", ts: ts(15), text: "언제?" }, { from: "Lee", ts: ts(5), text: "?" }] }], NOW);
    applyThreadState(s);
    expect(hasNewSinceMe(t)).toBe(true);
    expect(s.items).toHaveLength(1);
    expect(threadAttention({ slack: s } as never, new Set(), NOW).items).toHaveLength(1);
    expect(newReplies(s.all[0])).toBe(2);
    expect(client.revAt("slack", s.all[0])).toBe(0);
    expect(finalizeVerdict(s, marks)).toBe(false);
  });
});
/** Does finalizeSlackView drop the C1 row as 확인 완료? (row rebuilt with the current thread view) */
function finalizeVerdict(s: SlackBlock, marks: Record<string, number>): boolean {
  const x = { ...s.all[0], reason: "mention" as const };
  const v: SlackBlock = { summary: "", items: [x], all: [], watch: [], threads: s.threads };
  finalizeSlackView(v, marks);
  return v.items.length === 0;
}

describe("phase 2: untrustworthy reads / last_reply_ts behind search_latest_ts", () => {
  const setup = () => {
    const row: SlackAllItem = { channel: "#dev", from: "Kim", text: "배포?", url: link("C1", SEARCH, ROOT), ts: iso(SEARCH), reason: "mention", answered: true };
    const threads = syncThreadsFromList([], { summary: "", items: [], all: [row], watch: [] }, NOW);
    expect(threads[0].search_latest_ts).toBe(SEARCH);
    const warns: [string, unknown][] = [];
    return { threads, warns, warn: (msg: string, raw: unknown) => warns.push([msg, raw]) };
  };
  const good = (extra: object[] = []) => ({ key: `C1:${ROOT}`, thread_summary: "요약", messages: [{ from: "Kim", ts: ROOT, text: "배포?" }, { from: "나", ts: ts(60), text: "곧" }, { from: "Lee", ts: SEARCH, text: "언제요" }, ...extra] });

  it("only the root survives (replies without ts / with the root's ts) → previous last reply kept, warn with the entry; checked_at moves", () => {
    const { threads, warns, warn } = setup(), t = threads[0];
    mergeThreadReads(threads, [good()], NOW - 60_000, warn); // a normal read first
    expect(t).toMatchObject({ last_reply_ts: SEARCH, last_reply_from: "Lee", last_reply_text: "언제요", new_since_me: 1, summary_ts: SEARCH });
    expect(warns).toHaveLength(0);
    const entry = { key: `C1:${ROOT}`, reply_count: 2, messages: [{ from: "Kim", ts: ROOT, text: "배포?" }, { from: "Lee", ts: ROOT, text: "곧" }, { from: "Park", ts: "", text: "?" }] };
    mergeThreadReads(threads, [entry], NOW, warn);
    expect(t).toMatchObject({ last_reply_ts: SEARCH, last_reply_from: "Lee", last_reply_text: "언제요", new_since_me: 1, summary_ts: SEARCH, thread_summary: "요약" });
    expect(t.checked_at).toBe(new Date(NOW).toISOString()); // no re-read loop
    expect(t.read_search_ts).toBe(SEARCH);
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain("unreliable");
    expect(warns[0][0]).toContain("C1");
    expect(warns[0][0]).toContain(ROOT);
    expect(warns[0][0]).toContain("no-ts 1");
    expect(warns[0][0]).toContain("same-ts 1");
    expect(warns[0][1]).toBe(entry);
  });

  it("a read that stops before phase 1's newest ts → raised, from/text 미확인 (not the old message), new_since_me ≥ 1, warn", () => {
    const { threads, warns, warn } = setup(), t = threads[0];
    const entry = { key: `C1:${ROOT}`, messages: [{ from: "Kim", ts: ROOT, text: "배포?" }, { from: "나", ts: ts(60), text: "곧" }] }; // newest reply missing
    mergeThreadReads(threads, [entry], NOW, warn);
    expect(t.last_reply_ts).toBe(SEARCH);
    expect(t.last_reply_from).toBe("");
    expect(t.last_reply_text).toBe(UNKNOWN_REPLY);
    expect(t.new_since_me).toBe(1);
    expect(hasNewSinceMe(t)).toBe(true);
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain("raised");
    expect(warns[0][0]).toContain(SEARCH);
    // heartbeat: no "<old author>: <old text>" as the new reply; the key is the raised ts, so the real read later doesn't re-alert
    const hb = threadAttention({ slack: { summary: "", items: [], all: [], watch: [], threads } } as never, new Set(), NOW);
    expect(hb.items[0].title).toContain(UNKNOWN_REPLY);
    expect(hb.items[0].title).not.toContain("나:");
    mergeThreadReads(threads, [good()], NOW, warn);
    expect(t).toMatchObject({ last_reply_ts: SEARCH, last_reply_from: "Lee", last_reply_text: "언제요" });
    expect(threadAttention({ slack: { summary: "", items: [], all: [], watch: [], threads } } as never, new Set(hb.keys), NOW).items).toHaveLength(0);
  });

  it("a normal, up-to-date read → updated, no warn", () => {
    const { threads, warns, warn } = setup();
    mergeThreadReads(threads, [good()], NOW, warn);
    expect(threads[0]).toMatchObject({ last_reply_ts: SEARCH, last_reply_from: "Lee", reply_count: 2 });
    expect(warns).toHaveLength(0);
  });
});

describe("reviewed.json: old keys folded on read, new shape on the next write", () => {
  it("readReviewed folds; setReviewed writes base keys only", () => {
    const now = Date.now();
    fs.writeFileSync(REVIEWED_PATH, JSON.stringify({ [`slack:C1:${ROOT}@${ts(5)}`]: now - 2000, [`slack:C1:${ROOT}@${ROOT}`]: now - 1000, "mail:t": now - 500 }));
    expect(readReviewed()).toEqual({ [`slack:C1:${ROOT}`]: now - 1000, "mail:t": now - 500 });
    setReviewed("jira:AB-1", true, now);
    const raw = JSON.parse(fs.readFileSync(REVIEWED_PATH, "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["jira:AB-1", "mail:t", `slack:C1:${ROOT}`]);
  });
});
