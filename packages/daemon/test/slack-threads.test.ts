import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { patchAgenda, readAgenda, refreshAgenda, type SlackAllItem, type SlackBlock, type SlackItem } from "../src/agenda.js";
import { buildContextPrompt, buildThreadPrompt, processThreads } from "../src/agenda-context.js";
import { DEFAULT_CONFIG, loadConfig, type NedConfig } from "../src/config.js";
import { agendaContext } from "../src/drafts.js";
import { threadAttention } from "../src/heartbeat.js";
import { CONFIG_PATH, NED_HOME } from "../src/paths.js";
import {
  DM_BATCH_MAX,
  HIST_TEXT,
  RECENT_KEEP,
  THREAD_RECHECK_MINUTES,
  applyThreadState,
  dmCandidates,
  dmKeyOf,
  followState,
  unchangedCount,
  syncDmsFromList,
  hasNewSinceMe,
  markThreadSeen,
  markTs,
  mergeThreadReads,
  syncThreadsFromList,
  threadCandidates,
  threadKeyOf,
  type SlackThread,
} from "../src/slack-threads.js";

const NOW = Date.parse("2026-11-07T03:00:00.000Z");
const sec = Math.floor(NOW / 1000);
/** Slack ts `m` minutes before NOW. */
const ts = (minAgo: number) => `${sec - minAgo * 60}.000100`;
const link = (ch: string, t: string, thread?: string) => `https://x.slack.com/archives/${ch}/p${t.replace(".", "")}${thread ? `?thread_ts=${thread}&cid=${ch}` : ""}`;
const iso = (t: string) => new Date(Number(t) * 1000).toISOString();

const ROOT = ts(120); // thread root, 2h ago
const MINE = ts(60); // my reply
const item = (over: Partial<SlackItem> = {}): SlackItem => ({ channel: "#dev", from: "Kim", text: "배포 언제 해요?", url: link("C1", ROOT), ts: iso(ROOT), reason: "mention", ...over });
const block = (over: Partial<SlackBlock> = {}): SlackBlock => ({ summary: "", items: [], all: [], watch: [], ...over });

describe("thread keys", () => {
  it("permalink → channel:thread_ts (thread_ts param wins, else the message itself)", () => {
    expect(threadKeyOf(link("C1", ROOT))).toBe(`C1:${ROOT}`);
    expect(threadKeyOf(link("C1", MINE, ROOT))).toBe(`C1:${ROOT}`);
    expect(threadKeyOf("https://example.com")).toBe("");
  });
});

describe("syncThreadsFromList", () => {
  it("one record per thread from items + all + watch, with the newest seen ts and best priority", () => {
    const s = block({
      items: [item()],
      all: [{ ...item({ url: link("C1", MINE, ROOT), text: "답글 멘션", ts: iso(MINE) }), answered: true }],
      watch: [{ channel: "#ops", summary: "", highlights: [{ from: "Lee", text: "장애", ts: iso(ts(30)), url: link("C9", ts(30)), needs_me: false, reason: "" }] }],
    });
    const th = syncThreadsFromList([], s, NOW);
    expect(th.map((t) => t.key).sort()).toEqual([`C1:${ROOT}`, `C9:${ts(30)}`].sort());
    const t = th.find((x) => x.key === `C1:${ROOT}`)!;
    expect(t.search_latest_ts).toBe(MINE);
    expect(t.prio).toBe(0);
    expect(t.root_text).toBe("배포 언제 해요?");
    expect(th.find((x) => x.key.startsWith("C9"))!.prio).toBe(2);
  });
  it("group mentions (reason group) never become thread records / candidates", () => {
    const g = item({ reason: "group", url: link("C7", ts(10)), ts: iso(ts(10)) });
    const th = syncThreadsFromList([], block({ items: [g], all: [{ ...g, answered: false }] }), NOW);
    expect(th).toEqual([]);
    expect(threadCandidates(th, 5, NOW)).toEqual([]);
  });
  it("keeps what earlier reads learned; drops unlisted threads quiet for over a week", () => {
    const old = (sec - 8 * 86400).toFixed(6);
    const prev: SlackThread[] = [
      { ...syncThreadsFromList([], block({ items: [item()] }), NOW)[0], last_reply_ts: ts(10), thread_summary: "요약", new_since_me: 1 },
      { key: `C2:${old}`, channel_id: "C2", thread_ts: old, channel: "#old", url: link("C2", old), prio: 1, first_seen_at: "", reply_count: 0, new_since_me: 0, participants: [], recent: [] },
    ];
    const th = syncThreadsFromList(prev, block({ items: [item()] }), NOW);
    expect(th).toHaveLength(1);
    expect(th[0]).toMatchObject({ last_reply_ts: ts(10), thread_summary: "요약", new_since_me: 1 });
  });
});

describe("threadCandidates (cost control)", () => {
  const base = (over: Partial<SlackThread>): SlackThread => ({ key: "C1:" + ROOT, channel_id: "C1", thread_ts: ROOT, channel: "#dev", url: link("C1", ROOT), prio: 1, first_seen_at: "", reply_count: 0, new_since_me: 0, participants: [], recent: [], ...over });
  const recently = new Date(NOW - 60_000).toISOString();
  it("skips a thread whose known last reply equals phase 1's newest ts and was read recently", () => {
    expect(threadCandidates([base({ last_reply_ts: MINE, search_latest_ts: MINE, checked_at: recently })], 8, NOW)).toEqual([]);
  });
  it("re-reads when phase 1 saw something newer, when never read, or after the recheck interval", () => {
    const newer = base({ key: "a", last_reply_ts: ROOT, search_latest_ts: MINE, checked_at: recently });
    const never = base({ key: "b" });
    const stale = base({ key: "c", last_reply_ts: MINE, search_latest_ts: MINE, checked_at: new Date(NOW - (THREAD_RECHECK_MINUTES + 1) * 60_000).toISOString() });
    expect(threadCandidates([stale, never, newer], 8, NOW).map((t) => t.key)).toEqual(["a", "b", "c"]);
  });
  it("skips a read thread whose phase-1 newest ts is unchanged since the read, even when the read's last reply lags it", () => {
    // Phase 1 saw MINE, the read came back with only ROOT (e.g. the excerpt cut) — before, this re-read every pass.
    const t = base({ last_reply_ts: ROOT, search_latest_ts: MINE, read_search_ts: MINE, checked_at: recently });
    expect(followState(t, NOW)).toBe("unchanged");
    expect(threadCandidates([t], 8, NOW)).toEqual([]);
    expect(unchangedCount([t], NOW)).toBe(1);
    // Phase 1 then sees a newer message → read again, first in line.
    const moved = { ...t, search_latest_ts: ts(1) };
    expect(followState(moved, NOW)).toBe("moved");
    expect(threadCandidates([moved], 8, NOW)).toHaveLength(1);
  });
  it("safety net: an unchanged thread is re-read once its last read is 6h old (not before)", () => {
    expect(THREAD_RECHECK_MINUTES).toBe(360);
    const at = (min: number) => new Date(NOW - min * 60_000).toISOString();
    const t5h = base({ last_reply_ts: MINE, search_latest_ts: MINE, read_search_ts: MINE, checked_at: at(5 * 60) });
    expect(threadCandidates([t5h], 8, NOW)).toEqual([]);
    const t6h = { ...t5h, checked_at: at(6 * 60 + 1) };
    expect(followState(t6h, NOW)).toBe("recheck");
    expect(threadCandidates([t6h], 8, NOW)).toHaveLength(1);
    expect(unchangedCount([t5h, t6h], NOW)).toBe(1);
  });
  it("mergeThreadReads records the phase-1 ts it was read at (read_search_ts)", () => {
    const t = base({ search_latest_ts: MINE });
    mergeThreadReads([t], [{ key: t.key, messages: [{ from: "Kim", ts: ROOT, text: "x" }] }], NOW);
    expect(t.read_search_ts).toBe(MINE);
    expect(threadCandidates([t], 8, NOW)).toEqual([]);
    const never = base({ key: "n" });
    mergeThreadReads([never], [{ key: "n", messages: [] }], NOW);
    expect(never.read_search_ts).toBe("");
  });
  it("only threads active in the last 48h, at most N", () => {
    const old = (sec - 49 * 3600).toFixed(6);
    expect(threadCandidates([base({ key: "x", thread_ts: old, search_latest_ts: old })], 8, NOW)).toEqual([]);
    const many = Array.from({ length: 12 }, (_, i) => base({ key: `k${i}` }));
    expect(threadCandidates(many, 8, NOW)).toHaveLength(8);
    expect(threadCandidates(many, 0, NOW)).toEqual([]);
  });
});

describe("mergeThreadReads", () => {
  const fresh = () => syncThreadsFromList([], block({ items: [item()] }), NOW);
  const read = (msgs: [string, string, string][], extra: Record<string, unknown> = {}) => ({ key: `C1:${ROOT}`, messages: msgs.map(([from, t, text]) => ({ from, ts: t, text })), ...extra });

  it("latest reply, reply count, my last reply and replies by others after it", () => {
    const th = fresh();
    const done = mergeThreadReads(th, [read([["Kim", ROOT, "배포 언제 해요?"], ["나", MINE, "오늘 오후요"], ["Kim", ts(20), "몇 시쯤?"], ["Park", ts(10), "저도 궁금"]], { reply_count: 3, thread_summary: "배포 시각 재질문 — 시간 답해줘" })], NOW);
    expect(done).toEqual([`C1:${ROOT}`]);
    expect(th[0]).toMatchObject({ last_reply_ts: ts(10), last_reply_from: "Park", last_reply_text: "저도 궁금", reply_count: 3, my_last_reply_ts: MINE, my_last_reply_at: iso(MINE), new_since_me: 2, thread_summary: "배포 시각 재질문 — 시간 답해줘", summary_ts: ts(10) });
    expect(th[0].participants).toEqual(["Kim", "나", "Park"]);
    expect(th[0].checked_at).toBe(new Date(NOW).toISOString());
  });
  it("no reply of mine → new_since_me 0; my reply cut off by the excerpt → the model's count", () => {
    const a = fresh();
    mergeThreadReads(a, [read([["Kim", ROOT, "q"], ["Park", ts(10), "a"]])], NOW);
    expect(a[0].new_since_me).toBe(0);
    const b = fresh();
    mergeThreadReads(b, [read([["Kim", ts(20), "x"], ["Park", ts(10), "y"]], { my_last_reply_ts: MINE, new_since_me: 5 })], NOW);
    expect(b[0].new_since_me).toBe(5);
  });
  it("summary is cached while last_reply_ts stays, dropped when the thread moved without a new one", () => {
    const th = fresh();
    mergeThreadReads(th, [read([["Kim", ROOT, "q"], ["Park", ts(10), "a"]], { thread_summary: "첫 요약" })], NOW);
    mergeThreadReads(th, [read([["Kim", ROOT, "q"], ["Park", ts(10), "a"]], { thread_summary: "" })], NOW);
    expect(th[0].thread_summary).toBe("첫 요약");
    mergeThreadReads(th, [read([["Park", ts(10), "a"], ["Kim", ts(5), "b"]])], NOW);
    expect(th[0].thread_summary).toBeUndefined();
    mergeThreadReads(th, [read([["Park", ts(10), "a"], ["Kim", ts(5), "b"]], { thread_summary: "새 요약" })], NOW);
    expect(th[0]).toMatchObject({ thread_summary: "새 요약", summary_ts: ts(5) });
  });
});

describe("applyThreadState (reopen)", () => {
  const answered = (): SlackAllItem => ({ ...item(), answered: true });
  const withThread = (msgs: [string, string][]) => {
    const s = block({ all: [answered()] });
    s.threads = syncThreadsFromList([], s, NOW);
    mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, messages: msgs.map(([from, t]) => ({ from, ts: t, text: `${from} 메시지` })) }], NOW);
    applyThreadState(s);
    return s;
  };
  it("an answered row with a reply after mine goes back to 확인 필요 (once), with thread view + draft context", () => {
    const s = withThread([["Kim", ROOT], ["나", MINE], ["Kim", ts(5)]]);
    expect(s.all[0]).toMatchObject({ answered: false, reopened: true });
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({ reopened: true, reason: "thread", url: item().url });
    expect(s.items[0].thread).toMatchObject({ last_reply_from: "Kim", new_since_me: 1 });
    expect(s.items[0].context?.messages.at(-1)?.text).toBe("Kim 메시지");
    applyThreadState(s);
    expect(s.items).toHaveLength(1);
  });
  it("stays answered while nobody wrote after me; undone after I reply again", () => {
    expect(withThread([["Kim", ROOT], ["나", MINE]]).items).toHaveLength(0);
    const s = withThread([["Kim", ROOT], ["나", MINE], ["Kim", ts(5)]]);
    mergeThreadReads(s.threads!, [{ key: `C1:${ROOT}`, messages: [{ from: "Kim", ts: ts(5), text: "?" }, { from: "나", ts: ts(2), text: "!" }] }], NOW);
    applyThreadState(s);
    expect(s.items).toHaveLength(0);
    expect(s.all[0]).toMatchObject({ answered: true });
    expect(s.all[0].reopened).toBeUndefined();
  });
  it("a followed-channel highlight that got a reply after mine needs me again", () => {
    const h = { from: "Lee", text: "장애", ts: iso(ROOT), url: link("C1", ROOT), needs_me: false, reason: "" };
    const s = block({ watch: [{ channel: "#ops", summary: "", highlights: [h] }] });
    s.threads = syncThreadsFromList([], s, NOW);
    mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, messages: [{ from: "나", ts: MINE, text: "봤어요" }, { from: "Lee", ts: ts(5), text: "재발" }] }], NOW);
    applyThreadState(s);
    expect(s.watch[0].highlights[0]).toMatchObject({ needs_me: true, reopened: true, reason: "내 답 이후 새 답글" });
  });
});

describe("확인 완료 keyed by the latest reply", () => {
  it("markThreadSeen stores the mark time (an old `@…` key suffix is ignored); a reply after the mark makes it new again", () => {
    const s = block({ all: [{ ...item(), answered: true }] });
    s.threads = syncThreadsFromList([], s, NOW);
    mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, messages: [{ from: "나", ts: MINE, text: "a" }, { from: "Kim", ts: ts(5), text: "b" }] }], NOW);
    applyThreadState(s);
    expect(hasNewSinceMe(s.threads[0])).toBe(true);
    const MARK = NOW - 3 * 60_000; // after ts(5), before ts(1)
    expect(markThreadSeen(s, `slack:C1:${ROOT}@${ROOT}`, true, MARK)).toBe(true); // suffix (even a stale one) doesn't matter
    expect(s.threads[0].seen_reply_ts).toBe(markTs(MARK));
    expect(hasNewSinceMe(s.threads[0])).toBe(false);
    expect(s.all[0].thread?.seen_reply_ts).toBe(markTs(MARK));
    // Seen at that reply → no longer reopened (back to answered) until the next reply.
    expect(s.items).toHaveLength(0);
    expect(s.all[0].answered).toBe(true);
    mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, messages: [{ from: "나", ts: MINE, text: "a" }, { from: "Kim", ts: ts(5), text: "b" }, { from: "Kim", ts: ts(1), text: "c" }] }], NOW);
    expect(hasNewSinceMe(s.threads[0])).toBe(true);
    applyThreadState(s);
    expect(s.items).toHaveLength(1);
    // A key whose ts is a reply no longer listed still finds the thread through its known messages.
    expect(markThreadSeen(s, `slack:C1:${ts(1)}`, true, NOW)).toBe(true);
    expect(s.threads[0].seen_reply_ts).toBe(markTs(NOW));
    expect(markThreadSeen(s, `slack:C1:${ROOT}`, false)).toBe(true);
    expect(s.threads[0].seen_reply_ts).toBeUndefined();
    expect(markThreadSeen(s, "jira:APP-1", true)).toBe(false);
  });
});

describe("heartbeat thread attention", () => {
  it("one action item per (thread, last_reply_ts); a new reply raises it again; seen threads are skipped", () => {
    const s = block({ all: [{ ...item(), answered: true }] });
    s.threads = syncThreadsFromList([], s, NOW);
    mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, thread_summary: "시간 답 기다림", messages: [{ from: "나", ts: MINE, text: "a" }, { from: "Kim", ts: ts(5), text: "몇 시?" }] }], NOW);
    const a = { ...readAgenda(), slack: s };
    const first = threadAttention(a, new Set(), NOW);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({ kind: "slack", url: item().url, detail: "시간 답 기다림" });
    expect(first.items[0].title).toContain("Kim: 몇 시?");
    expect(threadAttention(a, new Set(first.keys), NOW).items).toEqual([]);
    mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, messages: [{ from: "나", ts: MINE, text: "a" }, { from: "Kim", ts: ts(5), text: "몇 시?" }, { from: "Kim", ts: ts(1), text: "??" }] }], NOW);
    expect(threadAttention(a, new Set(first.keys), NOW).items).toHaveLength(1);
    s.threads[0].seen_reply_ts = ts(1);
    expect(threadAttention(a, new Set(), NOW).items).toEqual([]);
  });
});

describe("prompts", () => {
  const cfg: NedConfig = { ...DEFAULT_CONFIG };
  it("the thread prompt asks for the follow-up keys and summary; the context prompt doesn't", () => {
    const t = syncThreadsFromList([], block({ items: [item()] }), NOW);
    const p = buildThreadPrompt(t, cfg);
    for (const k of ["slack_read_thread", "my_last_reply_ts", "new_since_me", "thread_summary", "known_last_reply_ts", `"key":"C1:${ROOT}"`]) expect(p).toContain(k);
    expect(p).not.toContain("{{");
    expect(p).not.toContain("<!--@");
    const c = buildContextPrompt("slack", [{ src: "slack", key: item().url, from: "Kim", text: "q", ts: iso(ROOT) }]);
    expect(c).not.toContain("thread_summary");
    expect(c).not.toContain("{{");
  });
});

describe("history (RECENT_KEEP / HIST_TEXT)", () => {
  it("a thread read keeps the last 10 messages at ≤220 chars, and the row view carries all of them", () => {
    const s = block({ items: [item()] });
    s.threads = syncThreadsFromList([], s, NOW);
    const messages = Array.from({ length: 14 }, (_, i) => ({ from: i % 3 ? "Kim" : "나", ts: ts(100 - i), text: `m${i} ` + "y".repeat(400) }));
    mergeThreadReads(s.threads, [{ key: `C1:${ROOT}`, messages }], NOW);
    const t = s.threads[0];
    expect(t.recent).toHaveLength(RECENT_KEEP);
    expect(RECENT_KEEP).toBe(10);
    expect(t.recent[0].text.startsWith("m4 ")).toBe(true);
    expect(t.recent.every((m) => m.text.length <= HIST_TEXT)).toBe(true);
    expect(t.last_reply_text!.length).toBeLessThanOrEqual(160);
    applyThreadState(s);
    expect(s.items[0].thread?.recent).toHaveLength(10);
  });
});

describe("DM conversations (slack.dms)", () => {
  const dm = (ch: string, minAgo: number, over: Partial<SlackItem> = {}): SlackItem => ({ channel: "DM", from: "Lee", text: "q", url: link(ch, ts(minAgo)), ts: iso(ts(minAgo)), reason: "dm", ...over });
  it("one record per DM conversation keyed dm:<channel>, newest ts; needs-me first", () => {
    const s = block({ items: [dm("D1", 10)], all: [{ ...dm("D1", 30), answered: false }, { ...dm("D2", 5), answered: true }, { ...item(), answered: false }] as SlackAllItem[] });
    const d = syncDmsFromList([], s, NOW);
    expect(d.map((x) => x.key).sort()).toEqual(["dm:D1", "dm:D2"]);
    expect(dmKeyOf(link("D1", ts(3)))).toBe("dm:D1");
    const d1 = d.find((x) => x.key === "dm:D1")!;
    expect(d1).toMatchObject({ channel_id: "D1", thread_ts: "", prio: 0, search_latest_ts: ts(10) });
    expect(d.find((x) => x.key === "dm:D2")!.prio).toBe(1);
  });
  it("dmCandidates: at most 5, needs-me first; same last ts read <15 min ago is skipped", () => {
    const s = block({ all: Array.from({ length: 8 }, (_, i) => ({ ...dm(`D${i}`, 10 + i), answered: i !== 7 })) as SlackAllItem[] });
    const d = syncDmsFromList([], s, NOW);
    const c = dmCandidates(d, 99, NOW);
    expect(c).toHaveLength(DM_BATCH_MAX);
    expect(c[0].key).toBe("dm:D7");
    const read = d.find((x) => x.key === "dm:D0")!;
    read.checked_at = new Date(NOW - 5 * 60_000).toISOString();
    read.last_reply_ts = read.search_latest_ts;
    expect(dmCandidates(d, 99, NOW).some((x) => x.key === "dm:D0")).toBe(false);
    read.checked_at = new Date(NOW - (THREAD_RECHECK_MINUTES + 1) * 60_000).toISOString();
    expect(dmCandidates([read], 99, NOW).map((x) => x.key)).toEqual(["dm:D0"]);
    read.checked_at = new Date(NOW - 60_000).toISOString();
    read.search_latest_ts = ts(1); // phase 1 saw a newer message
    expect(dmCandidates([read], 99, NOW).map((x) => x.key)).toEqual(["dm:D0"]);
  });
  it("dmCandidates: a DM whose newest phase-1 ts is unchanged since its read is skipped until the 6h recheck", () => {
    const d = syncDmsFromList([], block({ items: [dm("D1", 10)] }), NOW)[0];
    // Read 2h ago: slack_read_channel's newest message is older than what search saw (read_search_ts keeps the search's).
    mergeThreadReads([d], [{ key: "dm:D1", messages: [{ from: "Lee", ts: ts(30), text: "q" }] }], NOW - 2 * 3600_000);
    expect(d.last_reply_ts).toBe(ts(30));
    expect(dmCandidates([d], 99, NOW)).toEqual([]);
    expect(unchangedCount([d], NOW)).toBe(1);
    // Next phase-1 pass sees the same newest DM message → still skipped; a newer one → read.
    const again = syncDmsFromList([d], block({ items: [dm("D1", 10)] }), NOW)[0];
    expect(dmCandidates([again], 99, NOW)).toEqual([]);
    const newer = syncDmsFromList([d], block({ items: [dm("D1", 2)] }), NOW)[0];
    expect(dmCandidates([newer], 99, NOW).map((x) => x.key)).toEqual(["dm:D1"]);
    expect(dmCandidates([d], 99, NOW + 4 * 3600_000 + 60_000).map((x) => x.key)).toEqual(["dm:D1"]); // 6h after the read
  });
  it("a read DM (mine included, ≤10) lands on its DM rows as `dm`, not on other rows", () => {
    const s = block({ items: [dm("D1", 10)], all: [{ ...dm("D1", 10), answered: false }, { ...item(), answered: false }] as SlackAllItem[] });
    s.dms = syncDmsFromList([], s, NOW);
    const messages = Array.from({ length: 12 }, (_, i) => ({ from: i % 2 ? "나" : "Lee", ts: ts(60 - i), text: `d${i}` }));
    expect(mergeThreadReads(s.dms, [{ key: "dm:D1", messages }], NOW)).toEqual(["dm:D1"]);
    applyThreadState(s);
    expect(s.items[0].dm?.key).toBe("dm:D1");
    expect(s.items[0].dm?.recent.map((m) => m.text)).toEqual(messages.slice(2).map((m) => m.text));
    expect(s.items[0].dm?.recent.some((m) => m.from === "나")).toBe(true);
    expect(s.all[0].dm?.recent).toHaveLength(10);
    expect(s.all[1].dm).toBeUndefined();
  });
  it("the thread prompt lists DM items with slack_read_channel only when there are some", () => {
    const s = block({ items: [item(), dm("D1", 10)] });
    const th = syncThreadsFromList([], s, NOW).filter((t) => t.key.startsWith("C1"));
    const p = buildThreadPrompt(th, { ...DEFAULT_CONFIG }, syncDmsFromList([], s, NOW));
    expect(p).toContain('"key":"dm:D1","kind":"dm","channel_id":"D1"');
    expect(p).toContain("slack_read_channel");
    expect(buildThreadPrompt(th, { ...DEFAULT_CONFIG })).not.toContain("mcp__claude_ai_Slack__slack_read_channel");
  });
});

describe("end to end (NED_NO_LLM fixtures, temp NED_HOME)", () => {
  it("phase 1 keeps threads across refreshes, phase 2 reads them, drafts get the thread excerpt", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { calendar: false, jira: false, github: false, gmail: false, slack: true, sentry: false } }));
    const fx = path.join(NED_HOME, "fx-agenda.json");
    const now = Date.now(), s0 = Math.floor(now / 1000);
    const R = `${s0 - 3600}.000100`, M = `${s0 - 1800}.000100`, K = `${s0 - 60}.000100`;
    fs.writeFileSync(fx, JSON.stringify({ slack: { summary: "", items: [], all: [{ channel: "#dev", from: "Kim", text: "배포?", url: link("C1", R), ts: R, reason: "mention", answered: true }], watch: [] } }));
    process.env.NED_NO_LLM_AGENDA = fx;
    try {
      await refreshAgenda(loadConfig());
      let a = readAgenda();
      expect(a.slack?.threads?.map((t) => t.key)).toEqual([`C1:${R}`]);

      const tf = path.join(NED_HOME, "fx-threads.json");
      fs.writeFileSync(tf, JSON.stringify({ threads: [{ key: `C1:${R}`, reply_count: 2, thread_summary: "배포 시각 다시 물음", messages: [{ from: "Kim", ts: R, text: "배포?" }, { from: "나", ts: M, text: "오후" }, { from: "Kim", ts: K, text: "몇 시?" }] }] }));
      process.env.NED_NO_LLM_THREADS = tf;
      expect(await processThreads(loadConfig())).toBe("ok");
      a = readAgenda();
      expect(a.slack?.items).toHaveLength(1);
      expect(a.slack?.items[0]).toMatchObject({ reopened: true, thread: { thread_summary: "배포 시각 다시 물음", last_reply_from: "Kim", new_since_me: 1 } });
      // Read just now and nothing newer from phase 1 → not read again.
      expect(await processThreads(loadConfig())).toBe("none");

      const ctx = agendaContext({ source: "slack", ref: { channel: "C1", ts: K, thread_ts: R } });
      expect(ctx?.kind === "slack" && ctx.ctx.messages.at(-1)?.text).toBe("몇 시?");

      // Next phase-1 run: the list comes back with the row answered again — thread state survives and reopens it.
      await refreshAgenda(loadConfig());
      a = readAgenda();
      expect(a.slack?.threads?.[0]).toMatchObject({ last_reply_ts: K, thread_summary: "배포 시각 다시 물음" });
      expect(a.slack?.items[0]?.reopened).toBe(true);
      const mark = Number(K) * 1000 + 1000; // ✓ just after the latest reply
      patchAgenda((x) => void markThreadSeen(x.slack, `slack:C1:${R}`, true, mark));
      expect(readAgenda().slack?.threads?.[0].seen_reply_ts).toBe(markTs(mark));
      expect(hasNewSinceMe(readAgenda().slack!.threads![0])).toBe(false);
    } finally {
      delete process.env.NED_NO_LLM_AGENDA;
      delete process.env.NED_NO_LLM_THREADS;
    }
  });

  it("phase 2 reads DM conversations in the same batch and the DM row carries the history", async () => {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify({ notify: "off", sources: { calendar: false, jira: false, github: false, gmail: false, slack: true, sentry: false } }));
    const fx = path.join(NED_HOME, "fx-agenda-dm.json");
    const s0 = Math.floor(Date.now() / 1000);
    const A = `${s0 - 900}.000100`, B = `${s0 - 600}.000100`, C = `${s0 - 120}.000100`;
    const row = { channel: "DM", from: "Lee", text: "확인 부탁", url: link("D7", C), ts: C, reason: "dm" };
    fs.writeFileSync(fx, JSON.stringify({ slack: { summary: "", items: [row], all: [{ ...row, answered: false }], watch: [] } }));
    process.env.NED_NO_LLM_AGENDA = fx;
    const tf = path.join(NED_HOME, "fx-threads-dm.json");
    fs.writeFileSync(tf, JSON.stringify({ threads: [{ key: "dm:D7", messages: [{ from: "Lee", ts: A, text: "안녕하세요" }, { from: "나", ts: B, text: "네" }, { from: "Lee", ts: C, text: "확인 부탁" }] }] }));
    process.env.NED_NO_LLM_THREADS = tf;
    try {
      await refreshAgenda(loadConfig());
      expect(readAgenda().slack?.dms?.map((d) => d.key)).toEqual(["dm:D7"]);
      expect(await processThreads(loadConfig())).toBe("ok");
      const a = readAgenda();
      expect(a.slack?.items[0].dm?.recent.map((m) => m.from)).toEqual(["Lee", "나", "Lee"]);
      expect(a.slack?.dms?.[0]).toMatchObject({ last_reply_ts: C });
      // Same last ts, read just now → the DM is not read again (the per-message thread record follows its own rule).
      expect(dmCandidates(a.slack?.dms)).toEqual([]);
    } finally {
      delete process.env.NED_NO_LLM_AGENDA;
      delete process.env.NED_NO_LLM_THREADS;
    }
  });
});

describe("thread cap keeps 확인 필요 threads (MAX_THREADS)", () => {
  it("an old open ask's thread survives 200 newer unlisted ones; DMs likewise", async () => {
    const { syncThreadsFromList, syncDmsFromList } = await import("../src/slack-threads.js");
    const now = Date.now(), sec = Math.floor(now / 1000);
    const prev = Array.from({ length: 220 }, (_, i) => ({ key: `C9:${sec - i}.000100`, channel_id: "C9", thread_ts: `${sec - i}.000100`, channel: "#x", url: "", prio: 1, first_seen_at: "", reply_count: 0, new_since_me: 0, participants: [], recent: [], search_latest_ts: `${sec - i}.000100` }));
    const oldTs = sec - 5 * 86400;
    const ask = { channel: "#a", from: "kim", text: "확인?", url: `https://x.slack.com/archives/C1/p${oldTs}000100`, ts: new Date(oldTs * 1000).toISOString(), reason: "mention" as const };
    const out = syncThreadsFromList(prev, { summary: "", items: [ask], all: [], watch: [] }, now);
    expect(out).toHaveLength(200);
    expect(out.find((t) => t.channel_id === "C1")?.prio).toBe(0);
    const dprev = Array.from({ length: 60 }, (_, i) => ({ ...prev[i], key: `dm:D${i}`, channel_id: `D${i}`, thread_ts: "" }));
    const dm = { ...ask, channel: "DM", url: `https://x.slack.com/archives/DOLD/p${oldTs}000100`, reason: "dm" as const };
    expect(syncDmsFromList(dprev, { summary: "", items: [dm], all: [], watch: [] }, now).find((t) => t.key === "dm:DOLD")?.prio).toBe(0);
  });
});
