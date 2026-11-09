/**
 * Slack thread follow-up: agenda.json `slack.threads[]`, one record per thread (channel id + thread_ts; a message
 * outside a thread is its own thread). Phase 1 (list search) upserts the threads its rows belong to; phase 2
 * (agenda-context.ts) re-reads the active ones with slack_read_thread and merges the latest replies back here.
 *
 * Pure functions only (no file I/O, no runtime imports from agenda.ts) — agenda.ts calls into this module.
 */
import type { SlackBlock, SlackContext, SlackItem } from "./agenda.js";

/** Threads with activity in this window are re-read by phase 2. */
export const THREAD_FOLLOW_HOURS = 48;
/** Threads quiet for longer than this (and gone from the lists) are dropped. */
export const THREAD_KEEP_DAYS = 7;
/**
 * Safety net: a thread / DM whose newest phase-1 ts hasn't moved since its last read is skipped, but re-read once this
 * much time has passed since that read (phase 1 searches only the newest 20 hits, so a quiet-looking thread can still move).
 */
export const THREAD_RECHECK_MINUTES = 6 * 60;
const MAX_THREADS = 200;
/** Messages kept per thread / DM conversation (the card's history panel shows all of them). */
export const RECENT_KEEP = 10;
/** Kept message text, chars. */
export const HIST_TEXT = 220;
const TEXT_MAX = 300;
const LINE_MAX = 160;
/** DM conversations read per phase-2 batch (needs-me ones first). */
export const DM_BATCH_MAX = 5;
const MAX_DMS = 50;

export interface ThreadMessage {
  from: string;
  /** Slack ts ("1730860000.123456"). */
  ts: string;
  /** ISO-8601 of `ts`. */
  at: string;
  text: string;
}

export interface SlackThread {
  /** `${channel_id}:${thread_ts}`. */
  key: string;
  channel_id: string;
  thread_ts: string;
  /** "#channel" / "DM" as phase 1 named it. */
  channel: string;
  /** A permalink into the thread (the first row that brought it in). */
  url: string;
  /** The thread's opening message as phase 1 listed it (one line), when a row was the root; else the first row's text. */
  root_text?: string;
  root_from?: string;
  /** One Korean line in the persona's voice: what it's about, where it stands, what's on me. Rebuilt only when last_reply_ts changes. */
  thread_summary?: string;
  /** last_reply_ts the summary was written for. */
  summary_ts?: string;
  /** Where it was seen: 0 items (needs me), 1 all (mentions / DMs), 2 followed-channel highlights. Lower = read first. */
  prio: number;
  first_seen_at: string;
  /** Newest message ts phase 1 saw in this thread (Slack ts). */
  search_latest_ts?: string;
  /** Latest message in the thread as of the last read (Slack ts / ISO / sender / one line). */
  last_reply_ts?: string;
  last_reply_at?: string;
  last_reply_from?: string;
  last_reply_text?: string;
  /** Replies (root excluded). */
  reply_count: number;
  /** ISO of my last message in the thread; absent = I never wrote in it. */
  my_last_reply_at?: string;
  my_last_reply_ts?: string;
  /** Messages by others after my last message (0 when I never wrote in it). */
  new_since_me: number;
  participants: string[];
  /** last_reply_ts at the moment the user marked it 확인 완료. */
  seen_reply_ts?: string;
  /** Last RECENT_KEEP messages, oldest first. */
  recent: ThreadMessage[];
  /** ISO of the last slack_read_thread. */
  checked_at?: string;
  /** search_latest_ts as it was at that read ("" = none yet). Absent in records read before this field existed. */
  read_search_ts?: string;
}

/** Why a followed thread / DM is (or isn't) re-read now. */
export type FollowState = "never" | "moved" | "recheck" | "unchanged";

/**
 * never: not read yet · moved: phase 1 saw a newer message than at the last read · recheck: unchanged, but the last
 * read is THREAD_RECHECK_MINUTES old · unchanged: skip. Records without read_search_ts compare against last_reply_ts.
 */
export function followState(t: SlackThread, now = Date.now()): FollowState {
  if (!t.checked_at) return "never";
  const seen = tsNum(t.search_latest_ts);
  const base = t.read_search_ts !== undefined ? tsNum(t.read_search_ts) : tsNum(t.last_reply_ts);
  if (seen > (base || 0)) return "moved";
  return now - (Date.parse(t.checked_at) || 0) >= THREAD_RECHECK_MINUTES * 60_000 ? "recheck" : "unchanged";
}

/**
 * Still followed by phase 2: activity within THREAD_FOLLOW_HOURS, or a row of the card's "확인 필요" (prio 0) — an old
 * unanswered ask stays on the card (history.ts slackView), so its thread / DM keeps being re-read (THREAD_RECHECK_MINUTES)
 * until my reply there answers it.
 */
export const followed = (t: SlackThread, now = Date.now()): boolean => t.prio === 0 || threadActivity(t) >= now / 1000 - THREAD_FOLLOW_HOURS * 3600;

/** Followed records skipped because nothing moved since their last read. */
export function unchangedCount(list: SlackThread[] | undefined, now = Date.now()): number {
  return (list ?? []).filter((t) => followed(t, now) && followState(t, now) === "unchanged").length;
}

/** What a list row carries about its thread (cards / drafts). */
export interface SlackThreadView {
  key: string;
  thread_ts: string;
  root_text?: string;
  root_from?: string;
  thread_summary?: string;
  last_reply_ts?: string;
  last_reply_at?: string;
  last_reply_from?: string;
  last_reply_text?: string;
  reply_count: number;
  new_since_me: number;
  my_last_reply_at?: string;
  seen_reply_ts?: string;
  /** Every kept message (≤ RECENT_KEEP), oldest first — the row shows the last 3, the history panel all. */
  recent: ThreadMessage[];
}

/** What a DM row carries about its conversation (slack.dms, key `dm:<channel_id>`). */
export interface SlackDmView {
  key: string;
  channel_id: string;
  last_reply_ts?: string;
  checked_at?: string;
  /** Last RECENT_KEEP messages of the conversation (mine included, from `나`), oldest first. */
  recent: ThreadMessage[];
}

/** Fields applyThreadState adds to list rows. */
export interface ThreadRowFields {
  thread?: SlackThreadView;
  /** Put back into "확인 필요" because someone replied after my last message. */
  reopened?: boolean;
  /** DM rows: the conversation's recent history, once phase 2 read it. */
  dm?: SlackDmView;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const oneLine = (s: string, n: number) => str(s).replace(/\s+/g, " ").trim().slice(0, n);

/** Slack ts or ISO → epoch seconds (NaN when neither). */
export function tsNum(v: string | undefined | null): number {
  const t = str(v).trim();
  if (!t) return NaN;
  if (/^\d{9,11}(\.\d+)?$/.test(t)) return Number(t);
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? NaN : ms / 1000;
}
/** Slack ts → ISO ("" when not a ts). */
export const tsIso = (v: string | undefined): string => {
  const n = tsNum(v);
  return Number.isFinite(n) ? new Date(n * 1000).toISOString() : "";
};
/** Anything ts-like → canonical Slack ts string ("1730860000.123456"). */
function slackTsStr(v: unknown): string {
  const t = str(v).trim();
  if (/^\d{9,11}\.\d+$/.test(t)) return t;
  const n = tsNum(t);
  return Number.isFinite(n) ? n.toFixed(6) : "";
}

/** Channel id, message ts and thread ts from a Slack permalink (same rules as drafts.ts parseSlackUrl). */
export function threadRef(url: string | undefined): { channel_id: string; ts: string; thread_ts: string } | null {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(url ?? "");
  if (!m) return null;
  const ts = `${m[2]}.${m[3]}`;
  const tt = /[?&]thread_ts=(\d+\.\d+)/.exec(url ?? "");
  return { channel_id: m[1], ts, thread_ts: tt ? tt[1] : ts };
}
/** `${channel}:${thread_ts}` for a permalink, or "". */
export const threadKeyOf = (url: string | undefined): string => {
  const r = threadRef(url);
  return r ? `${r.channel_id}:${r.thread_ts}` : "";
};

/** Last activity of a thread, epoch seconds. */
export function threadActivity(t: SlackThread): number {
  return Math.max(...[t.last_reply_ts, t.search_latest_ts, t.thread_ts].map(tsNum).filter(Number.isFinite), 0);
}

type Row = { url: string; channel: string; from: string; text: string; ts: string };

/** Cap order: 확인 필요 (prio 0) first — an old open ask's thread must survive the cap — then the most recent activity. */
const keepOrder = (a: SlackThread, b: SlackThread) => Number(b.prio === 0) - Number(a.prio === 0) || threadActivity(b) - threadActivity(a);

/** Group mentions (reason "group") are never followed as threads — too noisy, and the ask wasn't mine alone. */
function rowsWithPrio(s: SlackBlock): [Row, number][] {
  return [
    ...s.items.filter((x) => x.reason !== "group").map((x): [Row, number] => [x, 0]),
    ...s.all.filter((x) => x.reason !== "group").map((x): [Row, number] => [x, 1]),
    ...s.watch.flatMap((w) => w.highlights.map((h): [Row, number] => [{ ...h, channel: w.channel }, h.needs_me ? 0 : 2])),
  ];
}

/**
 * Phase 1 → thread records: upsert every thread a row of `next` belongs to (keeping what earlier reads learned),
 * bump search_latest_ts, then drop threads quiet for THREAD_KEEP_DAYS that are no longer listed.
 */
export function syncThreadsFromList(prev: SlackThread[] | undefined, next: SlackBlock, now = Date.now()): SlackThread[] {
  const byKey = new Map<string, SlackThread>((prev ?? []).filter((t) => t && t.key).map((t) => [t.key, { ...t, prio: 9 }]));
  const listed = new Set<string>();
  const nowIso = new Date(now).toISOString();
  for (const [x, prio] of rowsWithPrio(next)) {
    const r = threadRef(x.url);
    if (!r) continue;
    const key = `${r.channel_id}:${r.thread_ts}`;
    listed.add(key);
    let t = byKey.get(key);
    if (!t) {
      t = { key, channel_id: r.channel_id, thread_ts: r.thread_ts, channel: x.channel, url: x.url, prio, first_seen_at: nowIso, reply_count: 0, new_since_me: 0, participants: [], recent: [] };
      byKey.set(key, t);
    }
    t.prio = Math.min(t.prio, prio);
    if (x.text && (r.ts === r.thread_ts || !t.root_text)) { t.root_text = oneLine(x.text, LINE_MAX); t.root_from = oneLine(x.from, 80); }
    if (!t.channel && x.channel) t.channel = x.channel;
    if (!(tsNum(t.search_latest_ts) >= tsNum(r.ts))) t.search_latest_ts = r.ts; // NaN-safe: unset → take it
  }
  const keepAfter = now / 1000 - THREAD_KEEP_DAYS * 86400;
  return [...byKey.values()]
    .map((t) => (listed.has(t.key) ? t : { ...t, prio: t.prio === 9 ? 3 : t.prio }))
    .filter((t) => listed.has(t.key) || threadActivity(t) >= keepAfter)
    .sort(keepOrder)
    .slice(0, MAX_THREADS);
}

/**
 * Threads phase 2 should re-read now, at most `n`: followed (activity within THREAD_FOLLOW_HOURS or 확인 필요), and either never read,
 * phase 1 saw a newer message than at the last read, or the last read is THREAD_RECHECK_MINUTES old (followState).
 * Order: known-new first, then never read, then by where it was seen (needs me first), then the stalest read.
 */
export function threadCandidates(threads: SlackThread[] | undefined, n: number, now = Date.now()): SlackThread[] {
  if (n <= 0) return [];
  const newer = (t: SlackThread) => followState(t, now) === "moved";
  const checked = (t: SlackThread) => (t.checked_at ? Date.parse(t.checked_at) || 0 : 0);
  return (threads ?? [])
    .filter((t) => followed(t, now))
    .filter((t) => followState(t, now) !== "unchanged")
    .sort((a, b) => Number(newer(b)) - Number(newer(a)) || Number(!b.checked_at) - Number(!a.checked_at) || a.prio - b.prio || checked(a) - checked(b))
    .slice(0, n);
}

// ---------- DM conversations (slack.dms, key `dm:<channel_id>`) ----------
// Same record shape as a thread (thread_ts ""), but one per DM conversation: phase 2 reads its latest messages with
// slack_read_channel so a DM row can unfold the conversation's history. No summary, no reopen logic.

/** `dm:<channel_id>` for a DM permalink, or "". */
export const dmKeyOf = (url: string | undefined): string => {
  const r = threadRef(url);
  return r ? `dm:${r.channel_id}` : "";
};

/** Phase 1 → DM conversation records: one per DM conversation in items / all (needs me = prio 0), quiet ones expire like threads. */
export function syncDmsFromList(prev: SlackThread[] | undefined, next: SlackBlock, now = Date.now()): SlackThread[] {
  const byKey = new Map<string, SlackThread>((prev ?? []).filter((t) => t && t.key).map((t) => [t.key, { ...t, prio: 9 }]));
  const listed = new Set<string>();
  const nowIso = new Date(now).toISOString();
  const rows: [Row, number][] = [
    ...next.items.filter((x) => x.reason === "dm").map((x): [Row, number] => [x, 0]),
    ...next.all.filter((x) => x.reason === "dm").map((x): [Row, number] => [x, (x as { answered?: boolean }).answered ? 1 : 0]),
  ];
  for (const [x, prio] of rows) {
    const r = threadRef(x.url);
    if (!r) continue;
    const key = `dm:${r.channel_id}`;
    listed.add(key);
    let t = byKey.get(key);
    if (!t) {
      t = { key, channel_id: r.channel_id, thread_ts: "", channel: x.channel || "DM", url: x.url, prio, first_seen_at: nowIso, reply_count: 0, new_since_me: 0, participants: [], recent: [] };
      byKey.set(key, t);
    }
    t.prio = Math.min(t.prio, prio);
    if (!(tsNum(t.search_latest_ts) >= tsNum(r.ts))) { t.search_latest_ts = r.ts; t.url = x.url; }
  }
  const keepAfter = now / 1000 - THREAD_KEEP_DAYS * 86400;
  return [...byKey.values()]
    .map((t) => (listed.has(t.key) ? t : { ...t, prio: t.prio === 9 ? 3 : t.prio }))
    .filter((t) => listed.has(t.key) || threadActivity(t) >= keepAfter)
    .sort(keepOrder)
    .slice(0, MAX_DMS);
}

/**
 * DM conversations phase 2 should read now, at most min(n, DM_BATCH_MAX): same freshness rule as threads (never read,
 * phase 1 saw a newer message than the last read, or the last read is THREAD_RECHECK_MINUTES old). Needs-me first.
 */
export function dmCandidates(dms: SlackThread[] | undefined, n = DM_BATCH_MAX, now = Date.now()): SlackThread[] {
  const cap = Math.min(n, DM_BATCH_MAX);
  if (cap <= 0) return [];
  const newer = (t: SlackThread) => followState(t, now) === "moved";
  const checked = (t: SlackThread) => (t.checked_at ? Date.parse(t.checked_at) || 0 : 0);
  return (dms ?? [])
    .filter((t) => followed(t, now))
    .filter((t) => followState(t, now) !== "unchanged")
    .sort((a, b) => a.prio - b.prio || Number(newer(b)) - Number(newer(a)) || Number(!b.checked_at) - Number(!a.checked_at) || checked(a) - checked(b))
    .slice(0, cap);
}

export function dmView(t: SlackThread): SlackDmView {
  const v: SlackDmView = { key: t.key, channel_id: t.channel_id, recent: t.recent.slice(-RECENT_KEEP) };
  if (t.last_reply_ts) v.last_reply_ts = t.last_reply_ts;
  if (t.checked_at) v.checked_at = t.checked_at;
  return v;
}

/** DM rows (items / all) get `dm` = their conversation's history, once read. */
export function applyDmState(s: SlackBlock): void {
  const byKey = new Map((s.dms ?? []).map((t) => [t.key, t]));
  for (const x of [...s.items, ...s.all] as (SlackItem & ThreadRowFields)[]) {
    if (x.reason !== "dm") { delete x.dm; continue; }
    const t = byKey.get(dmKeyOf(x.url));
    if (t && t.recent.length) x.dm = dmView(t);
    else delete x.dm;
  }
}

/**
 * One slack_read_thread result (model JSON) → the thread's latest state. Mutates `threads`; returns the keys updated.
 * Raw shape: {key, reply_count, my_last_reply_ts, new_since_me, participants[], messages[{from, ts, text}]} — `나` = me.
 */
export function mergeThreadReads(threads: SlackThread[], raw: unknown[], now = Date.now()): string[] {
  const byKey = new Map(threads.map((t) => [t.key, t]));
  const nowIso = new Date(now).toISOString();
  const done: string[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const t = byKey.get(str(o.key));
    if (!t) continue;
    const msgs: ThreadMessage[] = (Array.isArray(o.messages) ? o.messages : [])
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map((m) => ({ from: oneLine(str(m.from), 80), ts: slackTsStr(m.ts), text: oneLine(str(m.text), TEXT_MAX) }))
      .filter((m) => m.ts && (m.text || m.from))
      .map((m) => ({ ...m, at: tsIso(m.ts) }))
      .sort((a, b) => tsNum(a.ts) - tsNum(b.ts));
    t.checked_at = nowIso;
    t.read_search_ts = t.search_latest_ts ?? ""; // what phase 1 had seen when this read happened (skip-unchanged)
    done.push(t.key);
    if (!msgs.length) continue;
    const me = (m: ThreadMessage) => m.from === "나";
    const last = msgs[msgs.length - 1];
    // Summary cache: keep the old one while the thread hasn't moved; a new one replaces it whenever the model wrote one.
    const summary = oneLine(str(o.thread_summary), 120);
    if (summary) { t.thread_summary = summary; t.summary_ts = last.ts; }
    else if (t.summary_ts && t.summary_ts !== last.ts) { delete t.thread_summary; delete t.summary_ts; }
    const root = msgs.find((m) => m.ts === t.thread_ts);
    if (root) { t.root_text = oneLine(root.text, LINE_MAX); t.root_from = root.from; }
    t.last_reply_ts = last.ts;
    t.last_reply_at = last.at;
    t.last_reply_from = last.from;
    t.last_reply_text = oneLine(last.text, LINE_MAX);
    const replies = msgs.filter((m) => tsNum(m.ts) > tsNum(t.thread_ts)).length;
    t.reply_count = Math.max(Math.trunc(Number(o.reply_count)) || 0, replies);
    const mine = [...msgs].reverse().find(me);
    const myTs = mine?.ts || slackTsStr(o.my_last_reply_ts) || t.my_last_reply_ts || "";
    if (myTs) {
      t.my_last_reply_ts = myTs;
      t.my_last_reply_at = tsIso(myTs);
      const counted = msgs.filter((m) => !me(m) && tsNum(m.ts) > tsNum(myTs)).length;
      // My last message may be older than the excerpt: then the model's count covers what the excerpt cut off.
      const windowCut = !mine && tsNum(myTs) < tsNum(msgs[0].ts);
      t.new_since_me = windowCut ? Math.max(counted, Math.trunc(Number(o.new_since_me)) || 0) : counted;
    } else t.new_since_me = 0;
    t.participants = [...new Set([...(Array.isArray(o.participants) ? o.participants.map((p) => oneLine(str(p), 80)) : []), ...msgs.map((m) => m.from)].filter(Boolean))].slice(0, 20);
    t.recent = msgs.slice(-RECENT_KEEP).map((m) => ({ ...m, text: m.text.slice(0, HIST_TEXT) }));
  }
  return done;
}

/** The thread excerpt as a draft context (drafts.ts fast path), or undefined when never read. */
export function threadContext(t: SlackThread): SlackContext | undefined {
  if (!t.recent.length || !t.checked_at) return undefined;
  const ctx: SlackContext = { participants: t.participants, messages: t.recent.map((m) => ({ from: m.from, ts: m.at, text: m.text })), collected_at: t.checked_at };
  if (t.my_last_reply_ts) ctx.my_last_ts = t.my_last_reply_ts;
  return ctx;
}

export function threadView(t: SlackThread): SlackThreadView {
  const v: SlackThreadView = { key: t.key, thread_ts: t.thread_ts, reply_count: t.reply_count, new_since_me: t.new_since_me, recent: t.recent.slice(-RECENT_KEEP) };
  for (const k of ["root_text", "root_from", "thread_summary", "last_reply_ts", "last_reply_at", "last_reply_from", "last_reply_text", "my_last_reply_at", "seen_reply_ts"] as const) if (t[k]) v[k] = t[k];
  return v;
}

/** Someone replied after my last message, and the user hasn't marked that reply seen. */
export const hasNewSinceMe = (t: SlackThread | SlackThreadView): boolean => t.new_since_me > 0 && !!t.last_reply_ts && !(t.seen_reply_ts && tsNum(t.seen_reply_ts) >= tsNum(t.last_reply_ts));

/**
 * Thread state → list rows (mutates `s`): every row gets `thread`; a thread read also refreshes the rows' draft
 * context; and an answered row (or a non-needs_me highlight) whose thread got a reply after mine goes back to
 * "확인 필요" (`reopened`) — undone again once I reply (new_since_me back to 0).
 */
export function applyThreadState(s: SlackBlock): void {
  const byKey = new Map((s.threads ?? []).map((t) => [t.key, t]));
  const tOf = (url: string) => byKey.get(threadKeyOf(url));
  type R = SlackItem & ThreadRowFields;
  const decorate = (x: { url: string; context?: SlackContext } & ThreadRowFields) => {
    const t = tOf(x.url);
    if (!t) { delete x.thread; return; }
    x.thread = threadView(t);
    const ctx = threadContext(t);
    if (ctx && (!x.context || Date.parse(ctx.collected_at) >= Date.parse(x.context.collected_at))) x.context = ctx;
  };
  // Reopened copies from an earlier pass are rebuilt below.
  // Reopen only while the reply after mine is unseen (확인 완료 at that reply → seen_reply_ts) — hasNewSinceMe.
  const open = (t: SlackThread | undefined): t is SlackThread => !!t && hasNewSinceMe(t);
  s.items = (s.items as R[]).filter((x) => !(x.reopened && !open(tOf(x.url))));
  for (const x of s.items as R[]) decorate(x);
  const needKeys = new Set(s.items.map((x) => threadKeyOf(x.url)).filter(Boolean));
  for (const x of s.all as (R & { answered: boolean })[]) {
    decorate(x);
    const t = tOf(x.url);
    if (x.reopened && !open(t)) { x.answered = true; delete x.reopened; }
    if (!open(t) || !x.answered) continue;
    x.answered = false;
    x.reopened = true;
    if (needKeys.has(t.key)) continue;
    needKeys.add(t.key);
    const { answered: _a, ...row } = x;
    (s.items as R[]).push({ ...row, reason: row.reason === "dm" ? "dm" : "thread", reopened: true });
  }
  for (const w of s.watch) {
    for (const h of w.highlights as (typeof w.highlights[number] & ThreadRowFields)[]) {
      decorate(h);
      const t = tOf(h.url);
      if (h.reopened && !open(t)) { h.needs_me = false; delete h.reopened; }
      if (open(t) && !h.needs_me) {
        h.needs_me = true;
        h.reopened = true;
        if (!h.reason) h.reason = "내 답 이후 새 답글";
      }
    }
  }
  applyDmState(s);
}

/**
 * 확인 완료 on a Slack row (review key `slack:<channel>:<ts>[@<last_reply_ts>]`): remember the thread's current
 * last reply as seen. Returns true when a thread matched.
 */
export function markThreadSeen(s: SlackBlock | null, reviewKey: string, reviewed: boolean): boolean {
  const m = /^slack:([A-Z0-9]+):(\d+\.\d+)(?:@(\d+\.\d+))?$/.exec(reviewKey);
  if (!s?.threads?.length || !m) return false;
  const [, ch, ts, at] = m;
  const rowKeys = new Set(rowsWithPrio(s).map(([x]) => threadRef(x.url)).filter((r) => r && r.channel_id === ch && r.ts === ts).map((r) => `${r!.channel_id}:${r!.thread_ts}`));
  rowKeys.add(`${ch}:${ts}`);
  let hit = false;
  // The key's ts may be a reply whose row already left the lists: match the thread by its known messages too.
  for (const t of s.threads) {
    if (!rowKeys.has(t.key) && !(t.channel_id === ch && (t.search_latest_ts === ts || t.recent.some((m) => m.ts === ts)))) continue;
    hit = true;
    if (reviewed) t.seen_reply_ts = at || t.last_reply_ts || t.thread_ts;
    else delete t.seen_reply_ts;
  }
  if (hit) applyThreadState(s);
  return hit;
}
