/**
 * 수집 이력 (config.history): everything agenda phase 1 collected, kept per source on disk so the collection window can be
 * short and incremental while the display window stays long. No claude call — the daemon writes it.
 *
 * Files (NED_HOME/history/, all written temp → rename):
 *   <source>.json  {v:1, records:[…]} — one record per key, newest `ts` first. slack: permalink (slackUrlKey), mail: thread
 *                  id, jira: issue key, github: PR url, calendar: event id (else url|start).
 *   meta.json      {last_prune_day, collect:{slack|mail:{last_ok_at, last_full_at}}} — the incremental window's anchors.
 *
 * Record: {key, source, first_seen, last_seen (ms), ts (ISO, the item's own time), state, item}. `item` is a light snapshot
 * (no phase-2 context / thread excerpts); `state` per source — slack {reason, need, answered, acked, count},
 * mail {unread, needs_action}, jira / github {open}, calendar {rsvp}.
 *
 * Writers: agenda.ts mergeSources (historyUpsert, right after a source's list is merged), agenda-context.ts mergeThreads
 * (historyFromThreads: my replies seen by phase 2). Slack·메일 blocks of agenda.json are then rebuilt from here
 * (slackView / mailView) for the display window, so every agenda.json reader stays unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { collapseDMs, dedupeSlack, slackConvKey, slackUrlKey, supersetMail, supersetSlack, type Agenda, type AgendaPayload, type AgendaSourceKey, type CalendarItem, type GithubItem, type JiraItem, type MailAllItem, type MailBlock, type MailItem, type MailReason, type SlackAllItem, type SlackBlock, type SlackItem, type SlackReason, type SlackWatchChannel } from "./agenda.js";
import { HISTORY_SOURCES, watchChannels, type HistorySource, type NedConfig } from "./config.js";
import { NED_HOME, localDay, log, readJson } from "./paths.js";
import { threadRef, type SlackThread } from "./slack-threads.js";
import type { Reviewed } from "./state.js";

export const HISTORY_DIR = path.join(NED_HOME, "history");
export const HISTORY_META_PATH = path.join(HISTORY_DIR, "meta.json");
/** The only files Ned writes (and prunes / deletes) in HISTORY_DIR — anything else there is left alone. */
export const historyFile = (src: HistorySource): string => path.join(HISTORY_DIR, `${src}.json`);

/** Incremental collection: overlap with the last successful run, and how often a full window is re-searched anyway. */
export const OVERLAP_MINUTES = 30;
export const FULL_RESCAN_HOURS = 6;
/** Full collection windows (what every run searched before the history store). */
export const SLACK_FULL_HOURS = 24;
export const MAIL_FULL_DAYS = 3;
/** Mail unread count / `all` search window (always searched whole — it is the unread count). */
export const MAIL_UNREAD_DAYS = 2;

const H = 3600_000, D = 24 * H;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface HistRecord<S extends object = Record<string, any>, I extends object = Record<string, any>> {
  key: string;
  source: HistorySource;
  /** ms: first / latest time a collection returned it (latest also when a list says it's still there). */
  first_seen: number;
  last_seen: number;
  /** ISO: the item's own time (Slack message ts, mail last message, Jira / PR updated, event start); first_seen when unknown. */
  ts: string;
  state: S;
  item: I;
}

export interface SlackHistItem {
  channel: string;
  from: string;
  /** Raw one-line text (all[] / recent), else the ask. */
  text: string;
  /** items[]: what the sender wants from me (one line). */
  ask?: string;
  url: string;
  ts: string;
  /** Seen in a 팔로업 channel search (highlight or one of the newest messages). */
  watch?: { channel: string; hl: boolean; needs_me: boolean; why: string; text: string };
}
export interface SlackHistState {
  /** Absent = only seen in a 팔로업 channel (not a mention / DM / thread / group row). */
  reason?: SlackReason;
  /** The list picked it into items[] (needs a reply) the last time it was returned. */
  need: boolean;
  answered: boolean;
  acked: boolean;
  /** DMs: unanswered messages of the conversation collapsed into this one. */
  count: number;
  /** Position in the items[] of the run that last picked it (rank_at) — the model's urgency order. */
  rank?: number;
  rank_at?: number;
}
export interface MailHistItem {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  why: string;
  reason?: MailReason;
  url: string;
}
export interface MailHistState {
  unread: boolean;
  needs_action: boolean;
  rank?: number;
  rank_at?: number;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRec = HistRecord<any, any>;
export type SlackRec = HistRecord<SlackHistState, SlackHistItem>;
export type MailRec = HistRecord<MailHistState, MailHistItem>;

// ---------- config helpers ----------

/** The source is recorded (history on and keep_days > 0). */
export function recording(cfg: Pick<NedConfig, "history">, src: HistorySource): boolean {
  return cfg.history?.enabled !== false && (cfg.history?.keep_days?.[src] ?? 0) > 0;
}
/** Slack / 메일 blocks of agenda.json come from the history (display window) instead of the latest list. */
export const historyDisplay = (cfg: Pick<NedConfig, "history">, src: "slack" | "mail"): boolean => recording(cfg, src);

// ---------- storage ----------

interface HistFile {
  v: 1;
  records: HistRecord[];
}
const cache = new Map<string, { mtime: number; size: number; recs: HistRecord[] }>();

/** Every record of `src` (newest ts first). Cached by mtime+size; callers must not mutate (loadMap clones). */
export function readHistory<R extends AnyRec = HistRecord>(src: HistorySource): R[] {
  const file = historyFile(src);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    cache.delete(file);
    return [];
  }
  const c = cache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return c.recs as R[];
  const f = readJson<Partial<HistFile> | null>(file, null);
  if (!f || !Array.isArray(f.records)) {
    // Unreadable: keep it aside for inspection and start over (collectWindow sees no file → the full window).
    const aside = `${file}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(file, aside);
      log(`history[${src}]: ${path.basename(file)} unreadable — moved to ${path.basename(aside)}, starting a fresh history`);
    } catch (e) {
      log(`history[${src}]: ${path.basename(file)} unreadable and could not be moved — ${String(e).slice(0, 200)}`);
    }
    cache.delete(file);
    return [];
  }
  const recs = f.records.filter((r) => r && typeof r === "object" && typeof r.key === "string");
  cache.set(file, { mtime: st.mtimeMs, size: st.size, recs });
  return recs as R[];
}

/** Atomic compact write (temp → rename in the same directory), newest ts first. */
export function writeHistory(src: HistorySource, recs: HistRecord[]): void {
  const file = historyFile(src);
  const sorted = [...recs].sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0));
  writeAtomic(file, JSON.stringify({ v: 1, records: sorted } satisfies HistFile));
  cache.delete(file);
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.ned-tmp-${process.pid}`);
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** Mutable copy keyed by record key. */
function loadMap<R extends AnyRec>(src: HistorySource): Map<string, R> {
  return new Map(readHistory<R>(src).map((r) => [r.key, structuredClone(r)]));
}

export interface CollectMark {
  /** ms: the reference time of the last successful list run (its prompt's "now"). */
  last_ok_at: number;
  /** ms: the last successful run that searched the full window. */
  last_full_at: number;
}
export interface HistoryMeta {
  v: 1;
  last_prune_day: string | null;
  collect: Partial<Record<"slack" | "mail", CollectMark>>;
}
export function readHistoryMeta(): HistoryMeta {
  const m = readJson<Partial<HistoryMeta> | null>(HISTORY_META_PATH, null);
  return { v: 1, last_prune_day: typeof m?.last_prune_day === "string" ? m.last_prune_day : null, collect: m?.collect && typeof m.collect === "object" ? m.collect : {} };
}
function patchHistoryMeta(fn: (m: HistoryMeta) => void): HistoryMeta {
  const m = readHistoryMeta();
  fn(m);
  writeAtomic(HISTORY_META_PATH, JSON.stringify(m, null, 2));
  return m;
}

// ---------- collection window ----------

export interface CollectWindow {
  /** Searched the full window (first run / periodic re-search / history off). */
  full: boolean;
  /** ms: search `after` this. */
  since: number;
  reason: "off" | "first" | "rescan" | "incremental";
}

/**
 * Slack / mail phase-1 search window. Full (Slack 24 h, mail 3 d) when the source isn't recorded, on the first run (no
 * history file or no successful run yet) and when the last full search is FULL_RESCAN_HOURS old; else incremental:
 * max(full start, last successful run − OVERLAP_MINUTES).
 */
export function collectWindow(src: "slack" | "mail", cfg: Pick<NedConfig, "history">, now: number, meta: HistoryMeta = readHistoryMeta(), hasFile = historyUsable(src)): CollectWindow {
  const fullSince = now - (src === "slack" ? SLACK_FULL_HOURS * H : MAIL_FULL_DAYS * D);
  if (!recording(cfg, src)) return { full: true, since: fullSince, reason: "off" };
  const c = meta.collect[src];
  if (!hasFile || !c || !Number.isFinite(c.last_ok_at) || !c.last_ok_at) return { full: true, since: fullSince, reason: "first" };
  if (!c.last_full_at || now - c.last_full_at >= FULL_RESCAN_HOURS * H || c.last_ok_at > now) return { full: true, since: fullSince, reason: "rescan" };
  return { full: false, since: Math.max(fullSince, c.last_ok_at - OVERLAP_MINUTES * 60_000), reason: "incremental" };
}

/** The source's history file exists and parses (a corrupt one is moved aside by readHistory → false). */
function historyUsable(src: HistorySource): boolean {
  readHistory(src);
  return fs.existsSync(historyFile(src));
}

/** Remember a successful list run (its prompt time `at`) as the next incremental window's anchor. */
export function noteCollected(src: "slack" | "mail", at: number, full: boolean): void {
  try {
    patchHistoryMeta((m) => {
      const prev = m.collect[src];
      m.collect[src] = { last_ok_at: at, last_full_at: full ? at : prev?.last_full_at ?? 0 };
    });
  } catch (e) {
    log(`history: meta write failed — ${String(e).slice(0, 200)}`);
  }
}

/**
 * Gmail `after:YYYY/MM/DD` for a window start: Gmail reads the date as midnight Pacific, so take the date at UTC−8 —
 * that midnight is never later than `since` (PST or PDT), at the cost of up to a day of overlap.
 */
export function gmailAfter(since: number): string {
  const d = new Date(since - 8 * H);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ---------- upsert ----------

export interface UpsertCtx {
  now: number;
  /** This run's window per source (incremental runs don't reconcile what they didn't search). */
  win?: Partial<Record<"slack" | "mail", CollectWindow>>;
  /** Slack: permalinks of my own messages the searches returned (`mine`). */
  mine?: string[];
  /** Slack: slackUrlKey()s of messages I reacted to with an ack emoji. */
  acked?: Set<string>;
  /** Mail: thread ids whose last message is mine (`replied`). */
  replied?: string[];
}

const SLACK_RANK: Record<SlackReason, number> = { dm: 0, mention: 1, thread: 2, group: 3 };
const strongest = (a: SlackReason | undefined, b: SlackReason | undefined): SlackReason | undefined => (!a ? b : !b ? a : SLACK_RANK[b] < SLACK_RANK[a] ? b : a);
const ms = (iso: string | undefined): number => Date.parse(iso ?? "") || 0;
const slackKey = (x: { url: string; channel: string; from: string; ts: string }) => (x.url ? slackUrlKey(x.url) : `nourl:${x.channel}|${x.from}|${x.ts}`);

function touch<R extends AnyRec>(map: Map<string, R>, src: HistorySource, key: string, ts: string, now: number, init: () => Pick<R, "state" | "item">): R {
  let r = map.get(key);
  if (!r) {
    r = { key, source: src, first_seen: now, last_seen: now, ts: new Date(now).toISOString(), ...init() } as R;
    map.set(key, r);
  }
  r.last_seen = now;
  if (ms(ts)) r.ts = new Date(ms(ts)).toISOString();
  return r;
}

const newSlack = (): Pick<SlackRec, "state" | "item"> => ({ state: { need: false, answered: false, acked: false, count: 1 }, item: { channel: "", from: "", text: "", url: "", ts: "" } });

/** One Slack list (normalized block) into the record map. Exported for tests. */
export function upsertSlack(map: Map<string, SlackRec>, s: SlackBlock, ctx: UpsertCtx): void {
  const now = ctx.now;
  const itemIdx = new Map<string, number>();
  s.items.forEach((x, i) => { const k = slackKey(x); if (!itemIdx.has(k)) itemIdx.set(k, i); });
  const returned = new Set<string>();
  let oldest = Infinity;
  for (const x of [...s.all, ...s.items] as (SlackItem & { answered?: boolean })[]) {
    const k = slackKey(x);
    returned.add(k);
    if (ms(x.ts)) oldest = Math.min(oldest, ms(x.ts));
    const r = touch(map, "slack", k, x.ts, now, newSlack), st = r.state, it = r.item;
    it.channel = x.channel || it.channel;
    it.from = x.from || it.from;
    it.url = x.url || it.url;
    it.ts = x.ts || it.ts;
    const i = itemIdx.get(k);
    if ("answered" in x) {
      it.text = x.text || it.text;
      if (x.answered) st.answered = true;
    } else {
      it.ask = x.text || it.ask;
      if (!it.text) it.text = x.text;
    }
    st.reason = strongest(st.reason, x.reason as SlackReason);
    st.need = i !== undefined;
    if (i !== undefined) {
      st.rank = i;
      st.rank_at = now;
      st.count = Math.max(1, Math.trunc(Number(s.items[i].count) || 1));
    }
    if (ctx.acked?.has(k)) st.acked = true;
  }
  // A newer DM ask in a conversation supersedes the older open ones there (their count rolls into it).
  for (const x of s.items.filter((y) => y.reason === "dm")) {
    const k = slackKey(x), r = map.get(k);
    if (!r || !r.state.need) continue;
    const conv = slackConvKey(x);
    let rolled = 0;
    for (const o of map.values()) {
      if (o === r || o.state.reason !== "dm" || !o.state.need || slackConvKey(o.item) !== conv || ms(o.ts) >= ms(r.ts)) continue;
      o.state.need = false;
      rolled += Math.max(1, o.state.count || 1);
    }
    if (rolled) r.state.count = Math.max(r.state.count, rolled + 1);
  }
  // 팔로업 channels: highlights (picked) and the newest messages.
  for (const w of s.watch ?? []) {
    for (const h of w.highlights) {
      const r = touch(map, "slack", slackKey({ ...h, channel: w.channel }), h.ts, now, newSlack);
      fillSlack(r.item, { channel: w.channel, from: h.from, url: h.url, ts: h.ts, text: "" });
      r.item.watch = { channel: w.channel, hl: true, needs_me: h.needs_me && !r.state.answered && !r.state.acked, why: h.reason, text: h.text };
    }
    for (const m of w.recent) {
      const r = touch(map, "slack", slackKey({ ...m, channel: w.channel }), m.ts, now, newSlack);
      fillSlack(r.item, { channel: w.channel, from: m.from, url: m.url, ts: m.ts, text: m.text });
      r.item.watch ??= { channel: w.channel, hl: false, needs_me: false, why: "", text: "" };
    }
  }
  // Ack emoji on any record Ned remembers (a channel / thread message outside this run's results too).
  for (const k of ctx.acked ?? []) {
    const r = map.get(k);
    if (!r) continue;
    r.state.acked = true;
    if (r.item.watch) r.item.watch.needs_me = false;
  }
  markMine(map, ctx.mine ?? [], "answered");
  // An acked DM closes that conversation up to the acked message (same rule as agenda normalize()).
  markMine(map, [...(ctx.acked ?? [])].filter((k) => /\/archives\/D[A-Z0-9]+\//.test(k)).map((k) => `https://${k}`), "acked", true);
  // A full search is authoritative for what it returned: an ask it no longer lists isn't open any more. Only rows newer
  // than the oldest one returned (each search is capped, older rows may simply have fallen off), never on an empty answer.
  const win = ctx.win?.slack;
  if (win?.full && returned.size) {
    const lo = Math.max(win.since, oldest);
    for (const r of map.values()) if (r.state.need && !returned.has(r.key) && ms(r.ts) >= lo) r.state.need = false;
  }
}

function fillSlack(it: SlackHistItem, x: { channel: string; from: string; url: string; ts: string; text: string }): void {
  if (!it.channel) it.channel = x.channel;
  if (!it.from) it.from = x.from;
  if (!it.url) it.url = x.url;
  if (!it.ts) it.ts = x.ts;
  if (!it.text) it.text = x.text;
}

/**
 * My own message (or an acked one, `inclusive`) at `url` answers the older records of the same DM conversation
 * (state.reason dm) or of the same thread. Returns the keys it changed.
 */
function markMine(map: Map<string, SlackRec>, urls: string[], field: "answered" | "acked", inclusive = false): Set<string> {
  const changed = new Set<string>();
  for (const u of urls) {
    const me = threadRef(u);
    if (!me) continue;
    const myTs = Number(me.ts);
    for (const r of map.values()) {
      const rr = threadRef(r.item.url);
      if (!rr || rr.channel_id !== me.channel_id) continue;
      if (inclusive ? Number(rr.ts) > myTs : Number(rr.ts) >= myTs) continue;
      if (r.state.reason !== "dm" && rr.thread_ts !== me.thread_ts) continue;
      if (!r.state[field]) changed.add(r.key);
      r.state[field] = true;
      if (r.item.watch) r.item.watch.needs_me = false;
    }
  }
  return changed;
}

const newMail = (): Pick<MailRec, "state" | "item"> => ({ state: { unread: false, needs_action: false }, item: { id: "", from: "", subject: "", snippet: "", why: "", url: "" } });

/** One mail list (normalized block) into the record map. Exported for tests. */
export function upsertMail(map: Map<string, MailRec>, m: MailBlock, ctx: UpsertCtx): void {
  const now = ctx.now;
  const win = ctx.win?.mail;
  const itemIdx = new Map<string, number>();
  m.items.forEach((x, i) => { if (x.id && !itemIdx.has(x.id)) itemIdx.set(x.id, i); });
  const inAll = new Set<string>();
  let oldestAll = Infinity;
  for (const x of m.all) {
    if (!x.id) continue;
    inAll.add(x.id);
    if (ms(x.ts)) oldestAll = Math.min(oldestAll, ms(x.ts));
    const r = touch(map, "mail", x.id, x.ts, now, newMail);
    Object.assign(r.item, { id: x.id, from: x.from || r.item.from, subject: x.subject || r.item.subject, url: x.url || r.item.url });
    r.state.unread = x.unread;
    // In the items search's window but not picked → no action needed (any more).
    if (!itemIdx.has(x.id) && win && ms(x.ts) >= win.since) r.state.needs_action = false;
  }
  for (const [i, x] of m.items.entries()) {
    if (!x.id) continue;
    const r = touch(map, "mail", x.id, x.received, now, newMail);
    Object.assign(r.item, { id: x.id, from: x.from || r.item.from, subject: x.subject || r.item.subject, snippet: x.snippet, why: x.why, reason: x.reason, url: x.url || r.item.url });
    r.state.needs_action = true;
    r.state.rank = i;
    r.state.rank_at = now;
  }
  for (const id of ctx.replied ?? []) {
    const r = map.get(id);
    if (r && !itemIdx.has(id)) r.state.needs_action = false;
  }
  // The unread search always covers MAIL_UNREAD_DAYS whole: a thread it no longer lists there was read.
  const unreadLo = now - MAIL_UNREAD_DAYS * D;
  if (m.all.length || (m.unread === 0 && win?.full !== false)) {
    const lo = m.all.length ? Math.max(unreadLo, oldestAll) : unreadLo;
    for (const r of map.values()) if (r.state.unread && !inAll.has(r.key) && ms(r.ts) >= lo) r.state.unread = false;
  }
  if (win?.full && (m.items.length || m.all.length)) {
    for (const r of map.values()) if (r.state.needs_action && !itemIdx.has(r.key) && ms(r.ts) >= win.since) r.state.needs_action = false;
  }
}

/** A whole-list source (jira / github / calendar): listed → open (upserted), previously open and gone → open=false. */
function upsertList<T>(map: Map<string, HistRecord>, src: HistorySource, list: T[], key: (x: T) => string, ts: (x: T) => string, state: (x: T) => Record<string, unknown>, now: number, closes: boolean): void {
  const seen = new Set<string>();
  for (const x of list) {
    const k = key(x);
    if (!k) continue;
    seen.add(k);
    const r = touch(map, src, k, ts(x), now, () => ({ state: {}, item: {} }));
    r.item = { ...(x as object) } as Record<string, unknown>;
    r.state = { ...r.state, ...state(x) };
  }
  if (closes) for (const r of map.values()) if (!seen.has(r.key) && r.state.open === true) r.state.open = false;
}

export const calendarKey = (e: Pick<CalendarItem, "id" | "url" | "start">): string => e.id || (e.url ? `${e.url}|${e.start}` : "");

/**
 * The hook in agenda.ts mergeSources: record every source in `keys` from this run's (normalized) payload, then prune
 * once a day. Never throws — a history failure must not lose the agenda merge; returns the sources whose write failed.
 */
export function historyUpsert(p: AgendaPayload, keys: readonly AgendaSourceKey[], cfg: NedConfig, ctx: UpsertCtx): Set<HistorySource> {
  const failed = new Set<HistorySource>();
  if (cfg.history?.enabled === false) return failed;
  for (const k of keys) {
    const src = k as HistorySource;
    if (!recording(cfg, src)) continue;
    try {
      const map = loadMap<HistRecord>(src);
      if (src === "slack" && p.slack) upsertSlack(map as unknown as Map<string, SlackRec>, p.slack, ctx);
      else if (src === "mail" && p.mail) upsertMail(map as unknown as Map<string, MailRec>, p.mail, ctx);
      else if (src === "jira") upsertList<JiraItem>(map, src, p.jira, (j) => j.key, (j) => j.updated, () => ({ open: true }), ctx.now, true);
      else if (src === "github") upsertList<GithubItem>(map, src, p.github, (g) => g.url, (g) => g.updated, () => ({ open: true }), ctx.now, true);
      else if (src === "calendar") upsertList<CalendarItem>(map, src, p.calendar, calendarKey, (e) => e.start, (e) => ({ rsvp: e.rsvp }), ctx.now, false);
      else continue;
      writeHistory(src, [...map.values()]);
    } catch (e) {
      log(`history[${src}]: upsert failed — ${String(e).slice(0, 200)}`);
      failed.add(src);
    }
  }
  pruneHistory(cfg, ctx.now);
  return failed;
}

/**
 * Phase 2 read threads / DM conversations (slack-threads.ts): my last reply in a thread answers its older records, my
 * newest message in a DM answers the conversation's older ones. Returns the slackUrlKey()s newly answered.
 */
export function historyFromThreads(s: Pick<SlackBlock, "threads" | "dms"> | null, cfg: NedConfig): Set<string> {
  if (!s || !recording(cfg, "slack")) return new Set();
  const urls: string[] = [];
  for (const t of s.threads ?? []) if (t.my_last_reply_ts) urls.push(permalinkOf(t, t.my_last_reply_ts, t.thread_ts));
  for (const d of s.dms ?? []) {
    const mine = [...d.recent].reverse().find((m) => m.from === "나");
    if (mine) urls.push(permalinkOf(d, mine.ts, ""));
  }
  if (!urls.length) return new Set();
  try {
    const map = loadMap<SlackRec>("slack");
    const changed = markMine(map, urls, "answered");
    if (changed.size) writeHistory("slack", [...map.values()]);
    return changed;
  } catch (e) {
    log(`history[slack]: thread state failed — ${String(e).slice(0, 200)}`);
    return new Set();
  }
}

/** A synthetic permalink threadRef() can read: channel + message ts (+ thread_ts). */
function permalinkOf(t: Pick<SlackThread, "channel_id">, ts: string, threadTs: string): string {
  const [a, b = "0"] = String(ts).split(".");
  const p = `slack.local/archives/${t.channel_id}/p${a.padStart(10, "0")}${b.padEnd(6, "0").slice(0, 6)}`;
  return `https://${p}${threadTs ? `?thread_ts=${threadTs}` : ""}`;
}

/** Rows of the Slack view whose key phase 2 just answered: out of items (unless reopened), answered in all. */
export function applyAnswered(s: SlackBlock, keys: Set<string>): void {
  if (!keys.size) return;
  const hit = (x: { url: string }) => !!x.url && keys.has(slackUrlKey(x.url));
  s.items = s.items.filter((x) => (x as { reopened?: boolean }).reopened || !hit(x));
  for (const x of s.all) if (hit(x) && !(x as { reopened?: boolean }).reopened) x.answered = true;
}

// ---------- prune ----------

/**
 * Once a day (meta.last_prune_day): drop records not seen within keep_days (0 → the source's file goes). Only the
 * HISTORY_SOURCES files are touched. History switched off → nothing is deleted (switching it back on keeps the past).
 */
export function pruneHistory(cfg: NedConfig, now = Date.now(), force = false): Partial<Record<HistorySource, number>> {
  const removed: Partial<Record<HistorySource, number>> = {};
  if (cfg.history?.enabled === false) return removed;
  const today = localDay(new Date(now));
  try {
    if (!force && readHistoryMeta().last_prune_day === today) return removed;
    for (const src of HISTORY_SOURCES) {
      const keep = cfg.history?.keep_days?.[src] ?? 0;
      const file = historyFile(src);
      if (!fs.existsSync(file)) continue;
      const recs = readHistory(src);
      if (keep <= 0) {
        fs.rmSync(file, { force: true });
        cache.delete(file);
        removed[src] = recs.length;
        continue;
      }
      const lo = now - keep * D;
      const kept = recs.filter((r) => Math.max(r.last_seen || 0, ms(r.ts)) >= lo);
      if (kept.length !== recs.length) {
        writeHistory(src, kept);
        removed[src] = recs.length - kept.length;
      }
    }
    patchHistoryMeta((m) => { m.last_prune_day = today; });
    const n = Object.values(removed).reduce((a, b) => a + (b ?? 0), 0);
    if (n) log(`history: pruned ${Object.entries(removed).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  } catch (e) {
    log(`history: prune failed — ${String(e).slice(0, 200)}`);
  }
  return removed;
}

// ---------- views (agenda.json's slack / mail blocks) ----------

/** Same rule as the dashboard's reviewed.js srcRevAt: a mark counts when it is at or after the item's time. */
function revAt(marks: Reviewed, key: string, itemMs: number): boolean {
  let at = marks[key] ?? 0;
  if (!at && key.includes("@")) {
    const b = marks[key.split("@")[0]], lr = Number(key.split("@")[1]) * 1000;
    if (b && b >= lr) at = b;
  }
  return !!at && at >= itemMs;
}
/** reviewed.js srcKey for a Slack row (`slack:<channel>:<ts>[@<last_reply_ts>]`). */
export function slackReviewKey(x: { url: string; thread?: { last_reply_ts?: string } }): string {
  const m = /\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(x.url || "");
  if (!m) return x.url ? `slack:${x.url}` : "";
  const base = `slack:${m[1]}:${m[2]}.${m[3]}`, lr = x.thread?.last_reply_ts;
  return lr && lr !== `${m[2]}.${m[3]}` ? `${base}@${lr}` : base;
}

const byRank = (a: HistRecord<{ rank?: number; rank_at?: number }>, b: HistRecord<{ rank?: number; rank_at?: number }>) =>
  (b.state.rank_at ?? 0) - (a.state.rank_at ?? 0) || (a.state.rank ?? 99) - (b.state.rank ?? 99) || ms(b.ts) - ms(a.ts);

export interface ViewCtx {
  now: number;
  /** This run's window (full → a 팔로업 channel's empty summary means quiet; incremental → keep the previous one). */
  full: boolean;
}

/** An open Slack ask: picked into items[] by a list, not answered (my reply / `mine`) and not acked. */
export const openAsk = (r: SlackRec): boolean => !!r.state.reason && r.state.need && !r.state.answered && !r.state.acked;

/**
 * The Slack block for agenda.json from the history. items = open asks (openAsk) of **any age** — an unanswered ask
 * stays until it is answered / acked / 확인 완료 or pruned (keep_days.slack); reviewed is dropped later, once thread
 * state is known (finalizeSlackView). all = every mention / DM / thread / group row within history.display.slack_hours;
 * watch = 팔로업 channel highlights + newest messages (display window). DM collapse / dedupe / excluded channels as in
 * normalize(). `fresh` = this run's normalized list (summary, watch summaries), `prev` = agenda.json's block.
 */
export function slackView(cfg: NedConfig, fresh: SlackBlock, prev: SlackBlock | null, ctx: ViewCtx, recs: SlackRec[] = readHistory<SlackRec>("slack")): SlackBlock {
  const lo = ctx.now - cfg.history.display.slack_hours * H;
  const ex = new Set(cfg.filters.slack.exclude_channels.map((c) => c.toLowerCase()));
  const shown = recs.filter((r) => !ex.has(r.item.channel.replace(/^#/, "").toLowerCase()));
  const inWin = shown.filter((r) => ms(r.ts) >= lo);
  const rows = inWin.filter((r) => r.state.reason);
  const all: SlackAllItem[] = [...rows]
    .sort((a, b) => ms(b.ts) - ms(a.ts))
    .map((r) => ({ channel: r.item.channel, from: r.item.from, text: r.item.text || r.item.ask || "", url: r.item.url, ts: r.item.ts || r.ts, reason: r.state.reason!, answered: r.state.answered || r.state.acked }));
  const items: SlackItem[] = shown
    .filter(openAsk)
    .sort(byRank)
    .map((r) => ({ channel: r.item.channel, from: r.item.from, text: r.item.ask || r.item.text, url: r.item.url, ts: r.item.ts || r.ts, reason: r.state.reason!, ...(r.state.count > 1 ? { count: Math.min(99, r.state.count) } : {}) }));
  const viewItems = collapseDMs(dedupeSlack(items));
  const viewAll = collapseDMs(dedupeSlack(all)).slice(0, cfg.agenda_all_limit);
  const watch: SlackWatchChannel[] = [];
  for (const ch of watchChannels(cfg.filters)) {
    const lc = ch.toLowerCase(), is = (w: { channel: string }) => w.channel.replace(/^#+/, "").toLowerCase() === lc;
    const fw = fresh.watch.find(is), pw = prev?.watch?.find(is);
    const mine = inWin.filter((r) => r.item.watch && r.item.watch.channel.replace(/^#+/, "").toLowerCase() === lc);
    if (!fw && !pw && !mine.length) continue;
    const hls = mine
      .filter((r) => r.item.watch!.hl)
      .sort((a, b) => Number(b.item.watch!.needs_me) - Number(a.item.watch!.needs_me) || ms(b.ts) - ms(a.ts))
      .slice(0, 5)
      .map((r) => ({ from: r.item.from, text: r.item.watch!.text || r.item.text, ts: r.item.ts || r.ts, url: r.item.url, needs_me: r.item.watch!.needs_me && !r.state.answered && !r.state.acked, reason: r.item.watch!.why }));
    const recent = [...mine]
      .sort((a, b) => ms(b.ts) - ms(a.ts))
      .slice(0, 3)
      .map((r) => ({ from: r.item.from, text: (r.item.text || r.item.watch!.text).slice(0, 120), ts: r.item.ts || r.ts, url: r.item.url }));
    const summary = fw && (ctx.full || fw.summary) ? fw.summary : pw?.summary ?? "";
    watch.push({ channel: `#${ch}`, summary, highlights: hls, recent });
  }
  // Incremental answer with no rows: whatever it says ("새 것 없음") doesn't replace the summary of what is still open.
  const freshEmpty = !fresh.items.length && !fresh.all.length;
  const keepPrev = viewItems.length && !ctx.full ? prev?.summary ?? "" : "";
  const summary = !ctx.full && freshEmpty ? keepPrev : fresh.summary || keepPrev;
  // all stays the display window: only in-window asks are added to it (the dashboard's 전체 = all ∪ items anyway).
  return { summary, items: viewItems, all: supersetSlack(viewItems.filter((x) => ms(x.ts) >= lo), viewAll), watch };
}

/** After thread state (applyThreadState): drop 확인 완료 rows from items (thread-aware key), cap at 10. */
export function finalizeSlackView(s: SlackBlock, marks: Reviewed): void {
  s.items = s.items.filter((x) => !revAt(marks, slackReviewKey(x), ms(x.ts))).slice(0, 10);
}

/**
 * The mail block from the history: threads whose last message is within history.display.mail_days. items = needs
 * action and not 확인 완료 (max 10, the lists' urgency order, newest first after that); all = every thread, newest first
 * (agenda_all_limit); unread count / summary from this run.
 */
export function mailView(cfg: NedConfig, fresh: MailBlock, prev: MailBlock | null, ctx: ViewCtx, marks: Reviewed, recs: MailRec[] = readHistory<MailRec>("mail")): MailBlock {
  const lo = ctx.now - cfg.history.display.mail_days * D;
  const rows = recs.filter((r) => ms(r.ts) >= lo);
  const all: MailAllItem[] = [...rows]
    .sort((a, b) => ms(b.ts) - ms(a.ts))
    .slice(0, cfg.agenda_all_limit)
    .map((r) => ({ id: r.key, from: r.item.from, subject: r.item.subject, ts: r.ts, url: r.item.url, unread: r.state.unread }));
  const items: MailItem[] = rows
    .filter((r) => r.state.needs_action && !revAt(marks, `mail:${r.key}`, ms(r.ts)))
    .sort(byRank)
    .slice(0, 10)
    .map((r) => ({ id: r.key, from: r.item.from, subject: r.item.subject, snippet: r.item.snippet, received: r.ts, url: r.item.url, reason: r.item.reason ?? "request", why: r.item.why }));
  const keepPrev = items.length && !ctx.full ? prev?.summary ?? "" : "";
  const summary = !ctx.full && !fresh.items.length && !fresh.all.length ? keepPrev : fresh.summary || keepPrev;
  return { summary, unread: fresh.unread, unread_capped: fresh.unread_capped, items, all: supersetMail(items, all) };
}

/**
 * Open Slack asks in the history (any age — the card keeps them, see slackView), excluded channels left out: how many,
 * and the oldest one's time (ms). The ack-emoji search reaches back to it so an old ask can still be released.
 */
export function openSlack(cfg: NedConfig, now: number, recs: SlackRec[] = readHistory<SlackRec>("slack")): { n: number; oldest: number } {
  if (!recording(cfg, "slack")) return { n: 0, oldest: now };
  const open = recs.filter((r) => openAsk(r) && !excludedSlack(cfg, r));
  return { n: open.length, oldest: open.reduce((m, r) => Math.min(m, ms(r.ts) || now), now) };
}

// ---------- reading: /api/history, status, search, archive ----------

export interface HistoryRow {
  key: string;
  source: HistorySource;
  ts: string;
  first_seen: number;
  last_seen: number;
  /** In what the card shows now (Slack·메일 display window, an open Jira issue / PR, an event in the agenda's 2 weeks). */
  current: boolean;
  title: string;
  detail: string;
  url: string;
  /** slack: "#channel" (팔로업 rows: their channel). */
  channel?: string;
  state: Record<string, unknown>;
  item: Record<string, unknown>;
}

const one = (s: unknown, n: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Title / detail / url of a record, per source (the history list, search hits, the archive). */
export function describeRecord(r: HistRecord): { title: string; detail: string; url: string; channel?: string } {
  const it = r.item as Record<string, any>, st = r.state as Record<string, any>;
  switch (r.source) {
    case "slack": {
      const ch = it.channel || it.watch?.channel || "";
      return { title: one(it.text || it.ask || it.watch?.text, 200) || "(내용 없음)", detail: [ch, it.from].filter(Boolean).join(" · "), url: String(it.url ?? ""), channel: ch };
    }
    case "mail":
      return { title: one(it.subject, 200) || "(제목 없음)", detail: [it.from, it.why || it.snippet].filter(Boolean).map((x) => one(x, 120)).join(" · "), url: String(it.url ?? "") };
    case "jira":
      return { title: one(it.title, 200), detail: [it.key, it.status, st.open === false ? "목록에서 빠짐" : ""].filter(Boolean).join(" · "), url: String(it.url ?? "") };
    case "github":
      return { title: one(it.title, 200), detail: [`${it.repo ?? ""}#${it.number ?? ""}`, it.author ? `@${it.author}` : "", st.open === false ? "목록에서 빠짐" : ""].filter(Boolean).join(" · "), url: String(it.url ?? "") };
    case "calendar":
      return { title: one(it.title, 200), detail: [it.all_day ? "종일" : "", it.location].filter(Boolean).map((x) => one(x, 80)).join(" · "), url: String(it.url ?? "") };
  }
}

/** Keys of what agenda.json shows now, per source (search skips these history records — they're already hits). */
export function currentKeys(a: Agenda): Record<HistorySource, Set<string>> {
  const sk = (u: string) => (u ? slackUrlKey(u) : "");
  return {
    slack: new Set([...(a.slack?.items ?? []), ...(a.slack?.all ?? []), ...(a.slack?.watch ?? []).flatMap((w) => w.highlights)].map((x) => sk(x.url)).filter(Boolean)),
    mail: new Set([...(a.mail?.items ?? []), ...(a.mail?.all ?? [])].map((x) => x.id).filter(Boolean)),
    jira: new Set(a.jira.map((j) => j.key)),
    github: new Set(a.github.map((g) => g.url)),
    calendar: new Set(a.calendar.map(calendarKey).filter(Boolean)),
  };
}

/** Is the record part of what the card shows now (HistoryRow.current)? */
function isCurrent(r: HistRecord, cfg: NedConfig, now: number, cur: Record<HistorySource, Set<string>>): boolean {
  if (r.source === "slack") return historyDisplay(cfg, "slack") ? ms(r.ts) >= now - cfg.history.display.slack_hours * H || openAsk(r as SlackRec) : cur.slack.has(r.key);
  if (r.source === "mail") return historyDisplay(cfg, "mail") ? ms(r.ts) >= now - cfg.history.display.mail_days * D : cur.mail.has(r.key);
  if (r.source === "jira" || r.source === "github") return r.state.open === true && cur[r.source].has(r.key);
  return cur.calendar.has(r.key);
}

/** A Slack record in a channel tracking-excluded (filters.slack.exclude_channels) — never listed or searched. */
export function excludedSlack(cfg: Pick<NedConfig, "filters">, r: HistRecord): boolean {
  if (r.source !== "slack") return false;
  const ex = new Set(cfg.filters.slack.exclude_channels.map((c) => c.toLowerCase()));
  if (!ex.size) return false;
  const it = r.item as Partial<SlackHistItem>;
  return [it.channel, it.watch?.channel].some((c) => !!c && ex.has(String(c).replace(/^#+/, "").toLowerCase()));
}

export interface HistoryQuery {
  source: HistorySource;
  /** 1..90 (default 7). */
  days?: number;
  /** Case-insensitive; every whitespace-separated token must appear in the title / detail. */
  q?: string;
  /** slack: only this channel ("#ops" / "ops"), incl. 팔로업 rows. */
  channel?: string;
  limit?: number;
}

/** GET /api/history: records of one source with ts within `days`, newest first (max 200). */
export function queryHistory(cfg: NedConfig, agenda: Agenda, qy: HistoryQuery, now = Date.now()): { source: HistorySource; days: number; items: HistoryRow[]; total: number } {
  const days = Math.max(1, Math.min(90, Math.trunc(Number(qy.days) || 7)));
  const limit = Math.max(1, Math.min(200, Math.trunc(Number(qy.limit) || 200)));
  const lo = now - days * D;
  const toks = String(qy.q ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const ch = String(qy.channel ?? "").replace(/^#+/, "").toLowerCase();
  const cur = currentKeys(agenda);
  const rows: HistoryRow[] = [];
  for (const r of readHistory(qy.source)) {
    if (ms(r.ts) < lo || excludedSlack(cfg, r)) continue;
    const d = describeRecord(r);
    if (ch) {
      const it = r.item as Partial<SlackHistItem>;
      const chans = [it.channel, it.watch?.channel].map((c) => String(c ?? "").replace(/^#+/, "").toLowerCase());
      if (!chans.includes(ch)) continue;
    }
    if (toks.length) {
      const hay = `${d.title} ${d.detail}`.toLowerCase();
      if (!toks.every((t) => hay.includes(t))) continue;
    }
    rows.push({ key: r.key, source: r.source, ts: r.ts, first_seen: r.first_seen, last_seen: r.last_seen, current: isCurrent(r, cfg, now, cur), ...d, state: r.state, item: r.item });
  }
  rows.sort((a, b) => ms(b.ts) - ms(a.ts));
  return { source: qy.source, days, items: rows.slice(0, limit), total: rows.length };
}

export interface HistorySourceStatus {
  keep_days: number;
  recording: boolean;
  count: number;
  /** Days between the oldest record's first_seen and now (0 when empty). */
  days: number;
  bytes: number;
  oldest: string | null;
  newest: string | null;
}

/** GET /api/history/status: per source count / span / file size, the collect anchors, last prune. */
export function historyStatus(cfg: NedConfig, now = Date.now()) {
  const meta = readHistoryMeta();
  const sources = Object.fromEntries(
    HISTORY_SOURCES.map((src) => {
      const recs = readHistory(src);
      let bytes = 0;
      try { bytes = fs.statSync(historyFile(src)).size; } catch { /* none */ }
      const first = recs.reduce((m, r) => Math.min(m, r.first_seen || now), now);
      const tsList = recs.map((r) => ms(r.ts)).filter(Boolean);
      const s: HistorySourceStatus = {
        keep_days: cfg.history.keep_days[src],
        recording: recording(cfg, src),
        count: recs.length,
        days: recs.length ? Math.max(1, Math.ceil((now - first) / D)) : 0,
        bytes,
        oldest: tsList.length ? new Date(Math.min(...tsList)).toISOString() : null,
        newest: tsList.length ? new Date(Math.max(...tsList)).toISOString() : null,
      };
      return [src, s];
    }),
  ) as Record<HistorySource, HistorySourceStatus>;
  const win = (src: "slack" | "mail") => {
    const w = collectWindow(src, cfg, now, meta);
    return { ...meta.collect[src], next: { full: w.full, reason: w.reason, since: w.since } };
  };
  return { enabled: cfg.history.enabled, display: cfg.history.display, sources, collect: { slack: win("slack"), mail: win("mail") }, last_prune_day: meta.last_prune_day, overlap_minutes: OVERLAP_MINUTES, full_rescan_hours: FULL_RESCAN_HOURS };
}

/** Records of every source first seen on local day `day` (the archive's "📥 들어온 것"), oldest first per source. */
export function firstSeenOn(day: string): Record<HistorySource, HistRecord[]> {
  return Object.fromEntries(
    HISTORY_SOURCES.map((src) => [src, readHistory(src).filter((r) => localDay(new Date(r.first_seen)) === day).sort((a, b) => a.first_seen - b.first_seen || ms(a.ts) - ms(b.ts))]),
  ) as Record<HistorySource, HistRecord[]>;
}
