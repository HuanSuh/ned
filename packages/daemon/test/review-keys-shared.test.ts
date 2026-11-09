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
import { applyThreadState, hasNewSinceMe, markThreadSeen, mergeThreadReads, syncThreadsFromList } from "../src/slack-threads.js";
import { readReviewed, setReviewed } from "../src/state.js";
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
      "slack:D087RE55D25:1794193614.524359@1794193470.379259": 100,
      "slack:D087RE55D25:1794193614.524359@1794193999.000001": 300,
      "slack:D087RE55D25:1794193614.524359": 200,
      "slack:https://x.slack.com/odd@x": 5, // odd-permalink key (not channel:ts) → kept as is
      "mail:th1": 7,
      "session:a@b": 9,
    });
    expect(folded).toEqual({ "slack:D087RE55D25:1794193614.524359": 300, "slack:https://x.slack.com/odd@x": 5, "mail:th1": 7, "session:a@b": 9 });
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

  it("srcCheck: a row without a key gets a disabled ✓ titled 확인 키 없음, never a data-review", () => {
    const html = client.srcCheck("slack", { url: "", text: "x" });
    expect(html).toContain("disabled");
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
  it("seen = max(last_reply_ts, search_latest_ts, thread_ts); false right after; a newer reply → true; un-review clears", () => {
    const s = block(), t = s.threads![0];
    Object.assign(t, { last_reply_ts: ROOT, search_latest_ts: SEARCH, new_since_me: 1, my_last_reply_ts: ts(60) }); // live shape
    applyThreadState(s);
    expect(hasNewSinceMe(t)).toBe(true);
    expect(s.items).toHaveLength(1); // reopened
    expect(markThreadSeen(s, `slack:C1:${ROOT}`, true)).toBe(true);
    expect(t.seen_reply_ts).toBe(SEARCH);
    expect(hasNewSinceMe(t)).toBe(false);
    expect(s.items).toHaveLength(0); // not reopened by the next pass
    applyThreadState(s);
    expect(s.items).toHaveLength(0);
    t.search_latest_ts = ts(2); // new reply seen by phase 1
    expect(hasNewSinceMe(t)).toBe(true);
    expect(markThreadSeen(s, `slack:C1:${ROOT}`, false)).toBe(true);
    expect(t.seen_reply_ts).toBeUndefined();
  });
});

describe("phase 2: last_reply_ts behind search_latest_ts", () => {
  it("is raised to search_latest_ts with one warn (channel · ts · both values) and the model entry", () => {
    const row: SlackAllItem = { channel: "#dev", from: "Kim", text: "배포?", url: link("C1", SEARCH, ROOT), ts: iso(SEARCH), reason: "mention", answered: true };
    const threads = syncThreadsFromList([], { summary: "", items: [], all: [row], watch: [] }, NOW);
    expect(threads[0].search_latest_ts).toBe(SEARCH);
    const warns: [string, unknown][] = [];
    // The model gave the replies no usable ts / the root's ts → only the root survives.
    const entry = { key: `C1:${ROOT}`, reply_count: 2, messages: [{ from: "Kim", ts: ROOT, text: "배포?" }, { from: "Lee", ts: ROOT, text: "곧" }, { from: "Park", ts: "", text: "?" }] };
    mergeThreadReads(threads, [entry], NOW, (msg, raw) => warns.push([msg, raw]));
    expect(threads[0].last_reply_ts).toBe(SEARCH);
    expect(warns).toHaveLength(1);
    expect(warns[0][0]).toContain("C1");
    expect(warns[0][0]).toContain(ROOT);
    expect(warns[0][0]).toContain(SEARCH);
    expect(warns[0][0]).toContain("no-ts 1");
    expect(warns[0][1]).toBe(entry);
    // a read that is up to date → no warn
    mergeThreadReads(threads, [{ key: `C1:${ROOT}`, messages: [{ from: "Kim", ts: ROOT, text: "a" }, { from: "Lee", ts: SEARCH, text: "b" }] }], NOW, (msg, raw) => warns.push([msg, raw]));
    expect(warns).toHaveLength(1);
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
