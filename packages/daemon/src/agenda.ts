import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import { ACK_CHECK_MAX_DEFAULT, filtersPrompt, isGroupId, jqlExclude, watchChannels, type NedConfig } from "./config.js";
import { personaPrompt } from "./persona.js";
import { AGENDA_PATH, AGENDA_RAW_PATH, log, readJson, writeJsonAtomic } from "./paths.js";
import { collectWindow, finalizeSlackView, slackFullHours, gmailAfter, historyDisplay, historyUpsert, mailView, noteCollected, openSlack, recording, slackView, type CollectWindow, type UpsertCtx } from "./history.js";
import { readReviewed } from "./state.js";
import { applyThreadState, syncDmsFromList, syncThreadsFromList, type SlackThread, type ThreadRowFields } from "./slack-threads.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(here, "../../../prompts");
const execFileP = promisify(execFile);

export type Rsvp = "accepted" | "needsAction" | "declined" | "tentative" | "organizer";

export interface CalendarItem {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  location: string;
  url: string;
  meet_url: string;
  rsvp: Rsvp;
  attendees: number;
}

export interface JiraItem {
  key: string;
  title: string;
  status: string;
  priority: string;
  due: string | null;
  url: string;
  updated: string;
}

export interface GithubItem {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  updated: string;
  reason: "review_requested" | "my_pr_changes_requested" | "my_pr_approved";
}

export type MailReason = "reply" | "approval" | "deadline" | "request";

/** Size limits for agenda-collected draft context (must match prompts/agenda-context.md). */
export const CTX_LIMITS = { slackMessages: 5, slackText: 300, mailBody: 1500, attachments: 10 } as const;

/** Thread excerpt the agenda model already saw, so a reply draft needs no second fetch (drafts.ts fast path). */
export interface SlackContext {
  participants: string[];
  /** Oldest first, last CTX_LIMITS.slackMessages, each text ≤ CTX_LIMITS.slackText chars. */
  messages: { from: string; ts: string; text: string }[];
  /** ISO time the agenda run collected it. */
  collected_at: string;
}

export interface MailContext {
  from: string;
  to: string;
  subject: string;
  /** Latest message from someone else, quoted replies stripped, ≤ CTX_LIMITS.mailBody chars. */
  body_excerpt: string;
  attachments: string[];
  /** Gmail id of that message + its sender address (reply addressing for POST /api/send). */
  message_id?: string;
  reply_to?: string;
  collected_at: string;
}

export interface MailItem {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  received: string;
  url: string;
  reason: MailReason;
  /** One short line: why this needs me (e.g. "금요일까지 회신 요청"). */
  why: string;
  context?: MailContext;
}

export interface MailBlock {
  /** One-line inbox summary in Ned's voice; "" when nothing notable. */
  summary: string;
  /** Unread inbox threads in the last 2 days, at most MAIL_UNREAD_CAP. */
  unread: number;
  /** True when the unread search hit MAIL_UNREAD_CAP, so the real count may be higher. */
  unread_capped: boolean;
  /** Mails that need my action, most urgent first (max 10). */
  items: MailItem[];
  /** Every unread inbox thread of the last 2 days, newest first (max 50) — the card's "전체" view. */
  all: MailAllItem[];
}

export interface MailAllItem {
  id: string;
  from: string;
  subject: string;
  ts: string;
  url: string;
  unread: boolean;
}

/** "group": a mention of one of my user groups (filters.slack.group_mentions) — never followed as a thread. */
export type SlackReason = "mention" | "dm" | "thread" | "group";

export interface SlackItem extends ThreadRowFields {
  /** "#channel" or "DM" / "그룹 DM". */
  channel: string;
  from: string;
  /** The ask, one line. */
  text: string;
  /** Permalink to the message. */
  url: string;
  /** ISO-8601 (Slack epoch ts strings are converted). */
  ts: string;
  reason: SlackReason;
  /** DMs only: unanswered messages in this conversation, collapsed into this (latest) one. */
  count?: number;
  context?: SlackContext;
}

export interface SlackBlock {
  /** One-line summary in Ned's voice; "" when nothing notable. */
  summary: string;
  /** Last 24h: mentions / DMs / thread asks I haven't answered, max 10. */
  items: SlackItem[];
  /** Every mention / DM to me in the last 24h, newest first (max 50) — the card's "전체" view. */
  all: SlackAllItem[];
  /** Followed channels (filters.slack.watch_channels): last 24h per channel, read without needing a mention. [] when none. */
  watch: SlackWatchChannel[];
  /** Followed threads (slack-threads.ts): phase 1 upserts, phase 2 re-reads the active ones. Absent in older agenda.json. */
  threads?: SlackThread[];
  /** DM conversations (slack-threads.ts, key `dm:<channel_id>`): phase 2 reads their recent history. Absent in older agenda.json. */
  dms?: SlackThread[];
}

export interface SlackWatchHighlight extends ThreadRowFields {
  from: string;
  /** ≤200 chars. */
  text: string;
  /** ISO-8601. */
  ts: string;
  url: string;
  /** A question/request plausibly aimed at me, a decision affecting my work, or a deadline. */
  needs_me: boolean;
  /** One short line: why it matters / why it needs me. */
  reason: string;
  /** needs_me only: thread excerpt collected by agenda phase 2 (drafts.ts fast path). */
  context?: SlackContext;
}

export interface SlackWatchChannel {
  /** "#channel". */
  channel: string;
  /** 2–3 lines: what was decided / asked; "" when the channel was quiet. */
  summary: string;
  /** Max 5. */
  highlights: SlackWatchHighlight[];
  /** The channel's newest messages (max 3, newest first), unpicked — the card shows them when nothing stood out. */
  recent: SlackWatchRecent[];
}

export interface SlackWatchRecent {
  from: string;
  /** One line, ≤120 chars. */
  text: string;
  /** ISO-8601. */
  ts: string;
  url: string;
}

export interface SlackAllItem extends SlackItem {
  /** I already replied after it. */
  answered: boolean;
}

export interface AgendaPayload {
  calendar: CalendarItem[];
  jira: JiraItem[];
  github: GithubItem[];
  /** null = not fetched (agenda.json predates mail, or the gmail source is off). */
  mail: MailBlock | null;
  /** null = not fetched (agenda.json predates slack, or the slack source is off). */
  slack: SlackBlock | null;
}

export const AGENDA_SOURCES = ["slack", "mail", "calendar", "jira", "github"] as const;
export type AgendaSourceKey = (typeof AGENDA_SOURCES)[number];

/** Per-source state of the last phase-1 (list) run, so the dashboard can show "갱신 중" per card. */
export interface SourceStatus {
  status: "running" | "done" | "error";
  /** ms epoch of the last change (start, finish or failure). */
  updated_at: number;
  started_at?: number;
  duration_ms?: number;
  /** Cost of the claude -p call that produced it (calendar/jira share one call; github via gh = 0). */
  cost_usd?: number;
  error?: string;
  /** Cheap hash of the list (agenda phase 2 skips sources whose list didn't change). */
  signature?: string;
  /** The list is identical to the previous run's. */
  unchanged?: boolean;
}

/** Agenda phase 2 (background reply-context collection) progress. */
export interface ContextStatus {
  /** Items still waiting for context in this run. */
  pending: number;
  done: number;
  failed: number;
  running: boolean;
  updated_at: number;
  cost_usd: number;
  /** "budget": stopped because today's spend hit config.agenda_daily_budget_usd. */
  stopped: "budget" | "error" | null;
  /** Sources skipped because their list signature equals the one whose context was last completed. */
  skipped: string[];
}

export interface Agenda extends AgendaPayload {
  updated_at: number;
  /** Local dates (inclusive) the calendar list covers: yesterday … today+13. Absent in older agenda.json (= today only). */
  calendar_range?: { from: string; to: string };
  /** Phase-1 cost of the latest run (sum of its per-source calls). */
  cost_usd: number;
  error?: string;
  sources_status?: Partial<Record<AgendaSourceKey, SourceStatus>>;
  context_status?: ContextStatus;
  /** List signatures whose phase-2 context collection completed (skip-unchanged check). */
  context_sigs?: Partial<Record<"slack" | "mail", string>>;
}

/** Must match the `unread` search limit in prompts/agenda-lists.md. */
export const MAIL_UNREAD_CAP = 50;
const EMPTY: Agenda = { updated_at: 0, cost_usd: 0, calendar: [], jira: [], github: [], mail: null, slack: null };
const emptyAgenda = (now: number): Agenda => ({ ...EMPTY, updated_at: now, calendar_range: calendarRange(new Date(now)) });

export function readAgenda(): Agenda {
  const a = readJson<Partial<Agenda>>(AGENDA_PATH, {});
  return { ...EMPTY, ...a, calendar: a.calendar ?? [], jira: a.jira ?? [], github: a.github ?? [], mail: readMail(a.mail), slack: readSlack(a.slack) };
}

/** A missing/garbled mail block stays null so the dashboard can say mail hasn't been fetched yet. */
function readMail(m: unknown): MailBlock | null {
  if (!m || typeof m !== "object") return null;
  const b = m as Partial<MailBlock>;
  const unread = Math.max(0, Math.trunc(Number(b.unread) || 0));
  return { summary: str(b.summary), unread, unread_capped: b.unread_capped ?? unread >= MAIL_UNREAD_CAP, items: Array.isArray(b.items) ? b.items : [], all: Array.isArray(b.all) ? b.all : [] };
}

function readSlack(m: unknown): SlackBlock | null {
  if (!m || typeof m !== "object") return null;
  const b = m as Partial<SlackBlock>;
  return { summary: str(b.summary), items: Array.isArray(b.items) ? b.items : [], all: Array.isArray(b.all) ? b.all : [], watch: Array.isArray(b.watch) ? b.watch : [], threads: Array.isArray(b.threads) ? b.threads : [], dms: Array.isArray(b.dms) ? b.dms : [] };
}

/** Connector tools each phase-1 list call may use (loaded via ToolSearch). github is `gh`, not a connector. */
const LIST_TOOLS: Record<AgendaSourceKey, string[]> = {
  slack: ["mcp__claude_ai_Slack__slack_search_public_and_private"],
  mail: ["mcp__claude_ai_Gmail__search_threads"],
  calendar: ["mcp__claude_ai_Google_Calendar__list_events"],
  jira: ["mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql"],
  github: [],
};

/** `--allowedTools` for one phase-1 call — only that call's sources (narrower than the heartbeat's set). */
export function listTools(keys: AgendaSourceKey[]): string[] {
  const t = ["ToolSearch", ...keys.flatMap((k) => LIST_TOOLS[k])];
  if (keys.includes("github")) t.push("Bash(gh search prs:*)");
  return t;
}

/** ISO-8601 with the local UTC offset, e.g. 2026-11-06T00:00:00+09:00. */
function isoLocal(d: Date): string {
  const p = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.trunc(off / 60))}:${p(off % 60)}`;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const RSVPS: Rsvp[] = ["accepted", "needsAction", "declined", "tentative", "organizer"];
const REASONS: GithubItem["reason"][] = ["review_requested", "my_pr_changes_requested", "my_pr_approved"];
const MAIL_REASONS: MailReason[] = ["reply", "approval", "deadline", "request"];
const SLACK_REASONS: SlackReason[] = ["mention", "dm", "thread", "group"];
/** Same message found by several searches: keep the strongest reason (dm > mention > thread > group). */
const SLACK_RANK: Record<SlackReason, number> = { dm: 0, mention: 1, thread: 2, group: 3 };

/** One row per permalink (slackUrlKey), first position kept, reason upgraded to the strongest seen; answered = any. */
export function dedupeSlack<T extends { url: string; reason: SlackReason; answered?: boolean }>(list: T[]): T[] {
  const at = new Map<string, number>(), out: T[] = [];
  for (const x of list) {
    const k = x.url ? slackUrlKey(x.url) : "";
    const i = k ? at.get(k) : undefined;
    if (i === undefined) { if (k) at.set(k, out.length); out.push(x); continue; }
    const cur = out[i];
    const best = SLACK_RANK[x.reason] < SLACK_RANK[cur.reason] ? { ...cur, reason: x.reason } : cur;
    out[i] = "answered" in cur || "answered" in x ? { ...best, answered: cur.answered === true || x.answered === true } : best;
  }
  return out;
}

/** Slack "1730860000.123456" (epoch seconds) → ISO; ISO/other strings pass through. */
function slackTs(v: unknown): string {
  const t = str(v);
  if (/^\d{9,11}(\.\d+)?$/.test(t)) return new Date(Number(t) * 1000).toISOString();
  return t;
}

/** Model `context` → SlackContext (limits enforced), or undefined when it carries no messages. */
export function normalizeSlackContext(v: unknown, collectedAt: string): SlackContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const messages = arr(c.messages)
    .map((m) => ({ from: str(m.from).slice(0, 80), ts: slackTs(m.ts), text: str(m.text).replace(/\s+/g, " ").trim().slice(0, CTX_LIMITS.slackText) }))
    .filter((m) => m.text)
    .slice(-CTX_LIMITS.slackMessages);
  if (!messages.length) return undefined;
  const participants = [...new Set([...(Array.isArray(c.participants) ? c.participants.map((p) => str(p).slice(0, 80)) : []), ...messages.map((m) => m.from)].filter(Boolean))].slice(0, 20);
  return { participants, messages, collected_at: str(c.collected_at) && !Number.isNaN(Date.parse(str(c.collected_at))) ? str(c.collected_at) : collectedAt };
}

/** Model `context` → MailContext (limits enforced), or undefined when it has no body. */
export function normalizeMailContext(v: unknown, collectedAt: string): MailContext | undefined {
  if (!v || typeof v !== "object") return undefined;
  const c = v as Record<string, unknown>;
  const body = str(c.body_excerpt).trim().slice(0, CTX_LIMITS.mailBody);
  if (!body) return undefined;
  const opt = (x: unknown, n: number) => (str(x).trim() ? { v: str(x).trim().slice(0, n) } : null);
  const mid = opt(c.message_id, 200), rt = opt(c.reply_to, 200);
  return {
    from: str(c.from).slice(0, 200),
    to: str(c.to).slice(0, 300),
    subject: str(c.subject).slice(0, 200),
    body_excerpt: body,
    attachments: (Array.isArray(c.attachments) ? c.attachments.map((a) => str(a).slice(0, 120)).filter(Boolean) : []).slice(0, CTX_LIMITS.attachments),
    ...(mid ? { message_id: mid.v } : {}),
    ...(rt ? { reply_to: rt.v } : {}),
    collected_at: str(c.collected_at) && !Number.isNaN(Date.parse(str(c.collected_at))) ? str(c.collected_at) : collectedAt,
  };
}

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Record<string, unknown>[];

/** Local YYYY-MM-DD. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The agenda's calendar window: yesterday … today+13 (local dates, inclusive). */
export function calendarRange(now = new Date()): { from: string; to: string } {
  const at = (n: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  return { from: ymd(at(-1)), to: ymd(at(13)) };
}

/** ISO bounds for a local date range: start of `from` … start of the day after `to`. */
export function rangeBounds(from: string, to: string): { start: string; end: string } {
  const [fy, fm, fd] = from.split("-").map(Number), [ty, tm, td] = to.split("-").map(Number);
  return { start: isoLocal(new Date(fy, fm - 1, fd)), end: isoLocal(new Date(ty, tm - 1, td + 1)) };
}

/** Conversation key for a Slack message: the channel id in its permalink (D…/G…/C…), else channel + sender. */
export function slackConvKey(x: { url: string; channel: string; from: string }): string {
  const m = /\/archives\/([A-Z0-9]+)\//.exec(x.url || "");
  return m ? m[1] : `${x.channel}|${x.from}`;
}

/** Keep one row per DM conversation (the latest), summing `count`; mentions / threads pass through in order. */
export function collapseDMs<T extends { reason: SlackReason; ts: string; url: string; channel: string; from: string; count?: number }>(list: T[]): T[] {
  const best = new Map<string, T>(), total = new Map<string, number>();
  for (const x of list) {
    if (x.reason !== "dm") continue;
    const k = slackConvKey(x), cur = best.get(k);
    total.set(k, (total.get(k) ?? 0) + Math.max(1, x.count ?? 1));
    if (!cur || Date.parse(x.ts) > Date.parse(cur.ts)) best.set(k, x);
  }
  const out: T[] = [];
  for (const x of list) {
    if (x.reason !== "dm") { out.push(x); continue; }
    const k = slackConvKey(x);
    if (best.get(k) !== x) continue;
    const n = total.get(k) ?? 1;
    out.push(n > 1 ? { ...x, count: n } : x);
  }
  return out;
}

/** Coerce model calendar output into CalendarItem[] (shared by the agenda job and /api/calendar). */
export function normalizeCalendar(raw: unknown): CalendarItem[] {
  return arr(raw)
        .map((e) => ({
          id: str(e.id),
          title: str(e.title),
          start: str(e.start),
          end: str(e.end),
          all_day: e.all_day === true,
          location: str(e.location),
          url: str(e.url),
          meet_url: str(e.meet_url),
          rsvp: RSVPS.includes(e.rsvp as Rsvp) ? (e.rsvp as Rsvp) : "needsAction",
          attendees: Number(e.attendees) || 0,
        }))
        .sort((a, b) => (a.all_day === b.all_day ? Date.parse(a.start) - Date.parse(b.start) || 0 : a.all_day ? -1 : 1));
}

/** Coerce model output into the exact contract the dashboard expects. */
export function normalize(raw: Partial<Record<keyof AgendaPayload, unknown>>, cfg: NedConfig, collectedAt = new Date().toISOString()): AgendaPayload {
  const withCtx = <T extends object>(x: T, ctx: object | undefined): T => (ctx ? { ...x, context: ctx } : x);
  const calendar: CalendarItem[] = cfg.sources.calendar ? normalizeCalendar(raw.calendar) : [];
  const jira: JiraItem[] = cfg.sources.jira
    ? arr(raw.jira)
        .slice(0, 25)
        .map((e) => ({
          key: str(e.key),
          title: str(e.title),
          status: str(e.status),
          priority: str(e.priority),
          due: e.due ? str(e.due) : null,
          url: str(e.url),
          updated: str(e.updated),
        }))
    : [];
  const github: GithubItem[] = cfg.sources.github
    ? arr(raw.github)
        .filter((e) => REASONS.includes(e.reason as GithubItem["reason"]))
        .slice(0, 20)
        .map((e) => ({
          repo: str(e.repo),
          number: Number(e.number) || 0,
          title: str(e.title),
          url: str(e.url),
          author: str(e.author),
          updated: str(e.updated),
          reason: e.reason as GithubItem["reason"],
        }))
    : [];
  const m = raw.mail && typeof raw.mail === "object" ? (raw.mail as Record<string, unknown>) : {};
  const unread = Math.max(0, Math.trunc(Number(m.unread) || 0));
  const mail: MailBlock | null = cfg.sources.gmail
    ? {
        summary: str(m.summary).slice(0, 200),
        unread: Math.min(unread, MAIL_UNREAD_CAP),
        unread_capped: unread >= MAIL_UNREAD_CAP,
        items: arr(m.items)
          .slice(0, 10)
          .map((e) => ({
            id: str(e.id),
            from: str(e.from),
            subject: str(e.subject),
            snippet: str(e.snippet).slice(0, 200),
            received: str(e.received),
            url: str(e.url) || (e.id ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(str(e.id))}` : ""),
            reason: MAIL_REASONS.includes(e.reason as MailReason) ? (e.reason as MailReason) : "request",
            why: str(e.why).slice(0, 120),
          }))
          .map((x, i) => withCtx(x, normalizeMailContext(arr(m.items)[i]?.context, collectedAt))),
        all: arr(m.all)
          .slice(0, cfg.agenda_all_limit)
          .map((e) => ({
            id: str(e.id),
            from: str(e.from).slice(0, 80),
            subject: str(e.subject).slice(0, 200),
            ts: str(e.ts || e.received),
            url: str(e.url) || (e.id ? `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(str(e.id))}` : ""),
            unread: e.unread !== false,
          })),
      }
    : null;
  const sl = raw.slack && typeof raw.slack === "object" ? (raw.slack as Record<string, unknown>) : {};
  const slack: SlackBlock | null = cfg.sources.slack
    ? {
        summary: str(sl.summary).slice(0, 200),
        items: arr(sl.items)
          .filter((e) => SLACK_REASONS.includes(e.reason as SlackReason))
          .slice(0, 10)
          .map((e) => ({
            channel: str(e.channel).slice(0, 80),
            from: str(e.from).slice(0, 80),
            text: str(e.text).replace(/\s+/g, " ").trim().slice(0, 160),
            url: str(e.url),
            ts: slackTs(e.ts),
            reason: e.reason as SlackReason,
            ...(Number(e.count) > 1 ? { count: Math.min(99, Math.trunc(Number(e.count))) } : {}),
            ...(normalizeSlackContext(e.context, collectedAt) ? { context: normalizeSlackContext(e.context, collectedAt) } : {}),
          })),
        all: arr(sl.all)
          .slice(0, cfg.agenda_all_limit)
          .map((e) => ({
            channel: str(e.channel).slice(0, 80),
            from: str(e.from).slice(0, 80),
            text: str(e.text).replace(/\s+/g, " ").trim().slice(0, 200),
            url: str(e.url),
            ts: slackTs(e.ts),
            reason: SLACK_REASONS.includes(e.reason as SlackReason) ? (e.reason as SlackReason) : "mention",
            answered: e.answered === true,
            ...(Number(e.count) > 1 ? { count: Math.min(99, Math.trunc(Number(e.count))) } : {}),
            ...(normalizeSlackContext(e.context, collectedAt) ? { context: normalizeSlackContext(e.context, collectedAt) } : {}),
          })),
        watch: normalizeWatch(sl.watch, cfg),
      }
    : null;
  // Belt and braces for tracking exclusions: drop anything the model let through.
  const exProjects = new Set(cfg.filters.jira.exclude_projects);
  const exChannels = new Set(cfg.filters.slack.exclude_channels.map((c) => c.toLowerCase()));
  const jiraKept = jira.filter((j) => !exProjects.has(j.key.split("-")[0].toUpperCase()));
  const keepCh = (x: { channel: string }) => !exChannels.has(x.channel.replace(/^#/, "").toLowerCase());
  if (slack) {
    // Messages I reacted to with an ack emoji (filters.slack.ack_reactions) count as handled even if the model missed it.
    const acked = ackedSet(sl.acked_urls);
    if (acked.size) {
      const isAcked = (x: { url: string }) => acked.has(slackUrlKey(x.url));
      // A DM I acked closes that conversation up to the acked message (older asks there collapse into it anyway).
      const dmAck = new Map<string, number>();
      for (const k of acked) {
        const m = /\/archives\/(D[A-Z0-9]+)\/p(\d{10})(\d{6})/.exec(k);
        if (m) dmAck.set(m[1], Math.max(dmAck.get(m[1]) ?? 0, Number(m[2]) * 1000 + Math.floor(Number(m[3]) / 1000)));
      }
      const dmClosed = (x: SlackItem) => x.reason === "dm" && dmAck.has(slackConvKey(x)) && (Date.parse(x.ts) || 0) <= dmAck.get(slackConvKey(x))!;
      slack.items = slack.items.filter((x) => !isAcked(x) && !dmClosed(x));
      for (const x of slack.all) if (isAcked(x)) x.answered = true;
      for (const w of slack.watch) for (const h of w.highlights) if (isAcked(h)) h.needs_me = false;
    }
    slack.items = collapseDMs(dedupeSlack(slack.items.filter(keepCh)));
    slack.all = supersetSlack(slack.items, collapseDMs(dedupeSlack(slack.all.filter(keepCh))));
    // The prompt lets all[] skip context for rows already in items[]: share it by permalink, both ways.
    const byUrl = new Map<string, SlackContext>();
    for (const x of [...slack.items, ...slack.all]) if (x.context && x.url) byUrl.set(x.url, x.context);
    for (const x of [...slack.items, ...slack.all]) if (!x.context && byUrl.has(x.url)) x.context = byUrl.get(x.url);
  }
  if (mail) mail.all = supersetMail(mail.items, mail.all);
  return { calendar, jira: jiraKept, github, mail, slack };
}

/** Same Slack message ⇔ same key: permalink without query/hash (`?thread_ts=…&cid=…` varies), host lower-cased. */
export function slackUrlKey(url: string): string {
  const u = url.trim();
  try {
    const p = new URL(u);
    return `${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, "")}`;
  } catch {
    return u.split(/[?#]/)[0];
  }
}

/** Model `slack.acked_urls` → set of slackUrlKey()s (strings only, max 200). */
export function ackedSet(raw: unknown): Set<string> {
  const list = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  return new Set(list.slice(0, 200).map(slackUrlKey));
}

const byTsDesc = (a: { ts: string }, b: { ts: string }) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0);

/** all[] must contain every items[] row (same permalink = same row): add the missing ones (unanswered), newest first. */
export function supersetSlack(items: SlackItem[], all: SlackAllItem[]): SlackAllItem[] {
  const have = new Set(all.map((x) => x.url));
  const missing = items.filter((x) => x.url && !have.has(x.url)).map((x) => ({ ...x, answered: false }));
  return missing.length ? [...all, ...missing].sort(byTsDesc) : all;
}

/** Same for mail: every items[] thread is in all[] (thread id), newest first. Added rows keep unread=false (not known). */
export function supersetMail(items: MailItem[], all: MailAllItem[]): MailAllItem[] {
  const have = new Set(all.map((x) => x.id));
  const missing = items.filter((x) => x.id && !have.has(x.id)).map((x) => ({ id: x.id, from: x.from, subject: x.subject, ts: x.received, url: x.url, unread: false }));
  return missing.length ? [...all, ...missing].sort(byTsDesc) : all;
}

/** Coerce model `slack.watch` output: only channels still being followed, max 5 highlights each. */
function normalizeWatch(raw: unknown, cfg: NedConfig): SlackWatchChannel[] {
  const want = new Map(watchChannels(cfg.filters).map((c) => [c.toLowerCase(), c]));
  const seen = new Set<string>();
  return arr(raw)
    .map((w) => ({ w, key: str(w.channel).trim().replace(/^#+/, "").toLowerCase() }))
    .filter(({ key }) => want.has(key) && !seen.has(key) && seen.add(key))
    .map(({ w, key }) => ({
      channel: `#${want.get(key)}`,
      summary: str(w.summary).trim().slice(0, 400),
      highlights: arr(w.highlights)
        .slice(0, 5)
        .map((h) => ({
          from: str(h.from).slice(0, 80),
          text: str(h.text).replace(/\s+/g, " ").trim().slice(0, 200),
          ts: slackTs(h.ts),
          url: str(h.url),
          needs_me: h.needs_me === true,
          reason: str(h.reason).replace(/\s+/g, " ").trim().slice(0, 120),
          ...(h.context ? { context: normalizeSlackContext(h.context, new Date().toISOString()) } : {}),
        })),
      recent: arr(w.recent)
        .map((m) => ({ from: str(m.from).replace(/\s+/g, " ").trim().slice(0, 80), text: str(m.text).replace(/\s+/g, " ").trim().slice(0, 120), ts: slackTs(m.ts), url: str(m.url) }))
        .filter((m) => m.text || m.url)
        .sort((a, b) => (Date.parse(b.ts) || 0) - (Date.parse(a.ts) || 0))
        .slice(0, 3),
    }));
}

/** Keep the `<!--@name-->…<!--@/name-->` sections in `keep`, drop the rest (prompts/agenda-lists.md). */
export function pickSections(text: string, keep: Set<string>): string {
  return text.replace(/<!--@([a-z]+)-->\n?([\s\S]*?)<!--@\/\1-->\n?/g, (_m, name: string, body: string) => (keep.has(name) ? body : ""));
}

/** Ack emoji the Slack list call searches (`hasmy::emoji:`): the first filters.slack.ack_check_max of ack_reactions. */
export function ackCheckEmojis(cfg: NedConfig): string[] {
  const s = cfg.filters.slack;
  return (s.ack_reactions ?? []).slice(0, Math.max(1, s.ack_check_max ?? ACK_CHECK_MAX_DEFAULT));
}

/** Search keyword for one group mention: an ID matches the raw `<!subteam^S…>` token, a handle its "@handle" text. */
export function groupMentionToken(g: string): string {
  return isGroupId(g) ? `<!subteam^${g}>` : `"@${g}"`;
}

/**
 * {{GROUP_MENTIONS}} in agenda-lists.md: "" without groups (prompt unchanged). Slack `keywords` are AND'd (tool description:
 * "All elements are AND'd"), so the groups can't share one search — one search per group, in the same turn as the others.
 */
export function groupMentionsPrompt(groups: string[], since: string): string {
  if (!groups.length) return "";
  const list = groups.map((g) => `\`keywords: [${JSON.stringify(groupMentionToken(g))}]\``).join(", ");
  return [
    `- 그룹 멘션 (내가 속한 유저그룹): 위 검색과 **같은 턴에** 그룹마다 한 번씩 (같은 인자, \`after: "${since}"\`) — ${list} → \`"group"\`. 결과가 0이어도 다른 표기로 다시 찾지 않는다.`,
    "  - `all` 에는 그룹 멘션도 모두 넣는다 (`answered` 규칙 동일). `items` 에는 **그룹에 구체적인 질문·요청**을 했는데 그 뒤에 **아무도(나 포함) 답하지 않은** 것만 — 공지·공유·참고용은 넣지 않는다.",
    "  - 같은 메시지가 여러 검색에 걸리면 하나만, reason 우선순위 dm > mention > thread > group.",
    "",
  ].join("\n");
}

/** Search windows of one phase-1 call (src/history.ts collectWindow). Absent = the full window (Slack history.collect.slack_hours, mail 3 d). */
export interface ListWindows {
  slack?: CollectWindow;
  mail?: CollectWindow;
  /** ms: the ack-emoji search's `after` — reaches back to the oldest open ask Ned remembers (any age, full runs too). */
  ackSince?: number;
  /** Open Slack asks in the history (any age): the ack search runs even when this run's results have no candidate. */
  openAsks?: number;
  /** Incremental runs: each 팔로업 channel's current summary ("#ch" → text), so the model updates instead of restarting. */
  watchPrev?: Record<string, string>;
}

/** The windows for a call covering `keys` at `now` (history anchors, open asks, previous watch summaries). */
export function listWindows(cfg: NedConfig, keys: readonly AgendaSourceKey[], now: number, prevSlack: SlackBlock | null = null): ListWindows {
  const w: ListWindows = {};
  if (keys.includes("slack")) {
    w.slack = collectWindow("slack", cfg, now);
    // The card keeps open asks of any age (slackView): the ack search reaches back to the oldest one, full runs too.
    const o = openSlack(cfg, now);
    if (o.n) {
      w.openAsks = o.n;
      w.ackSince = Math.min(w.slack.since, o.oldest);
    }
    if (!w.slack.full) w.watchPrev = Object.fromEntries((prevSlack?.watch ?? []).filter((x) => x.summary).map((x) => [x.channel, x.summary]));
  }
  if (keys.includes("mail")) w.mail = collectWindow("mail", cfg, now);
  return w;
}

/** Phase-1 prompt for one call covering `keys` (prompts/agenda-lists.md: lists only, no per-item context). */
/** `tpl`: the template text (tests pass a variant); defaults to prompts/agenda-lists.md. `win`: incremental windows (listWindows). */
export function buildListsPrompt(cfg: NedConfig, keys: AgendaSourceKey[], now = new Date(), tpl = fs.readFileSync(path.join(PROMPTS_DIR, "agenda-lists.md"), "utf8"), win: ListWindows = {}): string {
  const cr = calendarRange(now), cb = rangeBounds(cr.from, cr.to);
  const watch = keys.includes("slack") ? watchChannels(cfg.filters) : [];
  const keep = new Set<string>(keys);
  if (keys.includes("slack") || keys.includes("mail")) keep.add("voice");
  if (watch.length) keep.add("watch");
  // Each ack emoji is one extra Slack search: only the first ack_check_max of them, and only when there are candidates (prompt).
  const ack = keys.includes("slack") ? ackCheckEmojis(cfg) : [];
  if (ack.length) keep.add("ack");
  const groups = keys.includes("slack") ? cfg.filters.slack.group_mentions ?? [] : [];
  const select = `select:${keys.flatMap((k) => LIST_TOOLS[k]).join(",")}`;
  const fullH = slackFullHours(cfg);
  const since = String(win.slack ? Math.floor(win.slack.since / 1000) : Math.floor(now.getTime() / 1000) - fullH * 3600);
  const ackSince = win.ackSince !== undefined ? String(Math.floor(win.ackSince / 1000)) : since;
  const sInc = !!win.slack && !win.slack.full, mInc = !!win.mail && !win.mail.full;
  const slackIncr = sInc
    ? "- **증분 수집**: `after` 는 지난 수집 직전이다 — 그 뒤에 온 새 메시지만 본다 (이전 항목은 Ned 가 기억한다). 새 것이 없으면 `\"items\":[]`, `\"all\":[]` 로 바로 끝낸다. 범위를 넓혀 다시 찾지 않는다.\n"
    : "";
  const prev = Object.entries(win.watchPrev ?? {});
  const watchPrev = sInc && watch.length
    ? `- **증분**: 채널마다 \`after\` 뒤 새 메시지만 본다. 새 메시지가 없으면 그 채널은 \`summary: ""\`, \`highlights: []\`, \`recent: []\` (Ned 가 이전 것을 유지한다). 있으면 아래 이전 요약에 새 내용을 반영해 \`summary\` 를 다시 쓴다.\n${prev.map(([c, t]) => `  - ${c} 이전 요약: ${JSON.stringify(t.slice(0, 400))}\n`).join("")}`
    : "";
  const ackOpen = (win.openAsks ?? 0) > 0 ? ` — 단, 지금은 Ned 가 기억하는 열린 항목이 ${win.openAsks}건 있으니 후보가 없어도 한다` : "";
  const mailIncr = mInc ? "- **증분 수집**: 두 번째 검색은 지난 수집 이후(`after:` 날짜)만 본다 — 이전 항목은 Ned 가 기억한다. 새 것이 없으면 `items: []`.\n" : "";
  return pickSections(tpl, keep)
    .replaceAll("{{NOW}}", isoLocal(now))
    .replaceAll("{{TZ}}", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .replaceAll("{{TOOL_SELECT}}", select)
    .replaceAll("{{CAL_FROM}}", cr.from)
    .replaceAll("{{CAL_TO}}", cr.to)
    .replaceAll("{{CAL_START}}", cb.start)
    .replaceAll("{{CAL_END}}", cb.end)
    .replaceAll("{{ALL_LIMIT}}", String(cfg.agenda_all_limit))
    .replaceAll("{{WATCH_CHANNELS}}", watch.map((c) => `#${c}`).join(", "))
    .replaceAll("{{GROUP_MENTIONS}}", () => groupMentionsPrompt(groups, since))
    .replaceAll("{{GROUP_REASON}}", groups.length ? "|group" : "")
    .replaceAll("{{GROUP_ITEMS_RULE}}", groups.length ? " (그룹 멘션은 위 그룹 규칙을 따른다)" : "")
    .replaceAll("{{GROUP_PRIO}}", groups.length ? " > group" : "")
    .replaceAll("{{ACK_EMOJIS}}", ack.map((e) => `:${e}:`).join(" "))
    .replaceAll("{{ACK_EXAMPLE}}", ack.length ? `\`hasmy::${ack[0]}:\`` : "")
    .replaceAll("{{ACK_WATCH_COND}}", watch.length ? " 또는 팔로업 채널의 `needs_me` 하이라이트 후보" : "")
    .replaceAll("{{ACK_KEY}}", ack.length ? ',"acked_urls":[]' : "")
    .replaceAll("{{WATCH_KEY}}", watch.length ? ',"watch":[{"channel":"#채널","summary":"","highlights":[{"from":"","text":"","ts":"ISO","url":"","needs_me":false,"reason":""}],"recent":[{"from":"","text":"","ts":"ISO","url":""}]}]' : "")
    .replaceAll("{{PERSONA}}", () => personaPrompt(cfg.persona))
    .replaceAll("{{FILTERS}}", () => filtersPrompt(cfg.filters))
    .replaceAll("{{JQL_EXCLUDE}}", () => (jqlExclude(cfg.filters) ? ` ${jqlExclude(cfg.filters)}` : ""))
    .replaceAll("{{SLACK_RANGE}}", sInc ? "지난 수집 이후 나에게 온 것 (증분)" : `최근 ${fullH}시간, 나에게 온 것`)
    .replaceAll("{{SLACK_INCR}}", () => slackIncr)
    .replaceAll("{{WATCH_PREV}}", () => watchPrev)
    .replaceAll("{{ACK_OPEN}}", () => ackOpen)
    .replaceAll("{{ACK_SINCE}}", ackSince)
    .replaceAll("{{MAIL_ITEMS_RANGE}}", mInc ? `after:${gmailAfter(win.mail!.since)}` : "newer_than:3d")
    .replaceAll("{{MAIL_INCR}}", () => mailIncr)
    .replaceAll("{{SLACK_SINCE}}", since);
}

/** What a list answer carries besides the lists: my own Slack messages, acked permalinks, mail threads I answered last. */
export function listExtras(raw: Partial<Record<keyof AgendaPayload, unknown>> | null): Pick<UpsertCtx, "mine" | "acked" | "replied"> {
  const sl = raw?.slack && typeof raw.slack === "object" ? (raw.slack as Record<string, unknown>) : {};
  const ml = raw?.mail && typeof raw.mail === "object" ? (raw.mail as Record<string, unknown>) : {};
  const strs = (v: unknown, n: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()).slice(0, n) : []);
  return { mine: strs(sl.mine, 50), acked: ackedSet(sl.acked_urls), replied: strs(ml.replied, 30) };
}

/** `ned prompt agenda`: every phase-1 prompt this config would send, in start order. */
export function buildPrompt(cfg: NedConfig, now = new Date()): string {
  return listCalls(cfg, false)
    .map((c) => `===== ${c.id} (${c.keys.join("+")}, model ${c.model ?? "default"}, maxTurns ${c.maxTurns}) =====\n${buildListsPrompt(cfg, c.keys, now, undefined, listWindows(cfg, c.keys, now.getTime(), readAgenda().slack))}`)
    .join("\n\n");
}

export interface ListCall {
  id: "slack" | "mail" | "jira" | "calendar";
  keys: AgendaSourceKey[];
  model: string | null;
  maxTurns: number;
}

/**
 * Phase-1 calls in priority order: Slack first, then mail, then jira (+github when `gh` isn't usable) and calendar on the
 * light model. All run in parallel; each merges its own keys into agenda.json the moment it finishes. Calendar is its own
 * call because its 2-week list is the biggest output (~9K tokens, ~60-90s): measured, jira alone lands in ~30s instead.
 */
export function listCalls(cfg: NedConfig, githubDirect: boolean, want: readonly AgendaSourceKey[] = AGENDA_SOURCES): ListCall[] {
  const out: ListCall[] = [];
  const light = cfg.agenda_light_model ?? cfg.claude_model;
  const on = (k: AgendaSourceKey) => want.includes(k) && (k === "mail" ? cfg.sources.gmail : cfg.sources[k]);
  // Measured: slack/mail on sonnet take the same wall time as the default model at ~half the cost ($0.38 vs $0.79, $0.24 vs $0.50).
  if (on("slack")) out.push({ id: "slack", keys: ["slack"], model: light, maxTurns: 6 });
  if (on("mail")) out.push({ id: "mail", keys: ["mail"], model: light, maxTurns: 6 });
  // jira (+github when gh isn't usable) share one call, carrying only the requested keys of the two.
  const jira: AgendaSourceKey[] = [];
  if (on("jira")) jira.push("jira");
  if (on("github") && !githubDirect) jira.push("github");
  if (jira.length) out.push({ id: "jira", keys: jira, model: light, maxTurns: 6 });
  if (on("calendar")) out.push({ id: "calendar", keys: ["calendar"], model: light, maxTurns: 6 });
  return out;
}

/** True when no enabled source returned a single item (mail/slack summaries don't count). */
export function isEmptyPayload(p: AgendaPayload): boolean {
  return !p.calendar.length && !p.jira.length && !p.github.length && !p.mail?.items.length && !p.mail?.all.length && !p.slack?.items.length && !p.slack?.all.length;
}

/** True when none of `keys` returned an item. */
function emptyFor(p: AgendaPayload, keys: AgendaSourceKey[]): boolean {
  return keys.every((k) => (k === "mail" ? !p.mail?.items.length && !p.mail?.all.length : k === "slack" ? !p.slack?.items.length && !p.slack?.all.length : !p[k].length));
}

/**
 * Cheap per-source list signature. Slack: which messages need me (items + watch needs_me); mail: which threads need me
 * (id + last message time + reason); calendar/jira/github: the whole list. Equal signature → phase 2 has nothing new to read.
 */
export function sourceSignature(k: AgendaSourceKey, p: Partial<AgendaPayload>): string {
  // Sorted ids only: the model's ordering and timestamp formatting vary run to run, the set of things needing me doesn't.
  // (A new message in a Slack conversation is a new permalink; a new mail reply is caught by carryContexts' time check.)
  const sorted = (xs: string[]) => [...new Set(xs)].sort();
  let basis: unknown;
  if (k === "slack") basis = p.slack ? sorted([...p.slack.items.map((x) => x.url), ...p.slack.watch.flatMap((w) => w.highlights.filter((h) => h.needs_me).map((h) => `w:${h.url}`))]) : null;
  else if (k === "mail") basis = p.mail ? sorted(p.mail.items.filter((x) => x.reason !== "deadline").map((x) => x.id)) : null;
  else if (k === "calendar") basis = sorted((p.calendar ?? []).map((e) => `${e.id}|${Date.parse(e.start) || e.start}|${e.rsvp}`));
  else if (k === "jira") basis = sorted((p.jira ?? []).map((j) => `${j.key}|${j.status}|${j.due}`));
  else basis = sorted((p.github ?? []).map((g) => `${g.url}|${g.reason}`));
  return crypto.createHash("sha1").update(JSON.stringify(basis)).digest("hex").slice(0, 12);
}

/** Read-modify-write agenda.json in one synchronous step (no interleaving inside this process), atomically. */
export function patchAgenda(fn: (a: Agenda) => void): Agenda {
  const a = readAgenda();
  fn(a);
  writeJsonAtomic(AGENDA_PATH, a);
  return a;
}

/**
 * Keep phase-2 context across list refreshes, keyed by stable ids: Slack by permalink (a new message = a new permalink),
 * mail by thread id only while its last-message time is unchanged (a new reply makes the excerpt stale).
 */
function carryContexts(prev: Agenda, next: AgendaPayload, keys: AgendaSourceKey[]): void {
  if (keys.includes("slack") && next.slack && prev.slack) {
    const byUrl = new Map<string, SlackContext>();
    for (const x of [...prev.slack.items, ...prev.slack.all, ...prev.slack.watch.flatMap((w) => w.highlights)]) if (x.context && x.url) byUrl.set(x.url, x.context);
    for (const x of [...next.slack.items, ...next.slack.all, ...next.slack.watch.flatMap((w) => w.highlights)]) if (!x.context && byUrl.has(x.url)) x.context = byUrl.get(x.url);
  }
  // Thread follow-up survives list refreshes; the new rows join it, and what earlier reads learned flows back onto them.
  if (keys.includes("slack") && next.slack) {
    next.slack.threads = syncThreadsFromList(prev.slack?.threads, next.slack);
    next.slack.dms = syncDmsFromList(prev.slack?.dms, next.slack);
    applyThreadState(next.slack);
  }
  if (keys.includes("mail") && next.mail && prev.mail) {
    const byId = new Map(prev.mail.items.filter((x) => x.context).map((x) => [x.id, x]));
    for (const x of next.mail.items) {
      const p = byId.get(x.id);
      // Still valid if it was read after the thread's latest message (formatting of `received` varies between runs).
      const latest = Date.parse(x.received), read = p?.context ? Date.parse(p.context.collected_at) : NaN;
      if (!x.context && p?.context && (p.received === x.received || (Number.isFinite(latest) && read >= latest))) x.context = p.context;
    }
  }
}

function setSourceStatus(keys: AgendaSourceKey[], s: SourceStatus): void {
  patchAgenda((a) => {
    a.sources_status ??= {};
    for (const k of keys) a.sources_status[k] = { ...a.sources_status[k], ...s, ...(s.error ? {} : { error: undefined }) };
  });
}

export interface MergeMeta {
  started: number;
  cost: number;
  /** The run's reference time (its prompts' "now"). */
  now: number;
  /** The windows the call searched + what it reported besides the lists (history upsert). */
  win?: ListWindows;
  extras?: Pick<UpsertCtx, "mine" | "acked" | "replied">;
  /** Source keys the answer didn't carry at all — treated as a failed collection (not recorded, window anchor kept). */
  missing?: AgendaSourceKey[];
}

/** Source keys of `keys` that a list answer doesn't carry (absent / null). */
export function missingKeys(raw: Record<string, unknown> | null, keys: readonly AgendaSourceKey[]): AgendaSourceKey[] {
  return keys.filter((k) => !raw || raw[k] === undefined || raw[k] === null);
}

/** This source came back with no rows (Slack items + all, mail all). */
const noRows = (p: AgendaPayload, k: "slack" | "mail") => (k === "slack" ? !p.slack?.items.length && !p.slack?.all.length : !p.mail?.all.length);

/**
 * Merge one finished call's keys into agenda.json (item-level context carry-over) and mark them done. With the history
 * on, the call's lists are recorded first (historyUpsert) and Slack / mail remember this run as the next window's anchor.
 */
export function mergeSources(payload: AgendaPayload, keys: AgendaSourceKey[], meta: MergeMeta, cfg: NedConfig): Agenda {
  const missing = new Set(meta.missing ?? []);
  const empty = { slack: noRows(payload, "slack"), mail: noRows(payload, "mail") }; // this run's own answer, before the view replaces it
  let failed = new Set<string>();
  const a = patchAgenda((a) => {
    // A key the answer didn't carry is a failed collection: nothing recorded for it (the view still comes from the history).
    failed = historyUpsert(payload, keys.filter((k) => !missing.has(k)), cfg, { now: meta.now, win: { slack: meta.win?.slack, mail: meta.win?.mail }, ...meta.extras });
    for (const k of failed) log(`agenda[${k}]: history write failed — showing this run's list as is, window anchor kept`);
    // 표시 원천 = 이력: Slack / mail blocks are rebuilt from the history for the display window, so every agenda.json reader
    // (heartbeat, drafts, chat, search, phase 2, the dashboard) sees the long window while collection stays incremental.
    const view = (k: "slack" | "mail") => keys.includes(k) && !!payload[k] && historyDisplay(cfg, k) && !failed.has(k);
    const vctx = (k: "slack" | "mail") => ({ now: meta.now, full: meta.win?.[k]?.full ?? true });
    const reviewed = view("slack") || view("mail") ? readReviewed() : {};
    if (view("slack")) payload.slack = slackView(cfg, payload.slack!, a.slack, vctx("slack"));
    if (view("mail")) payload.mail = mailView(cfg, payload.mail!, a.mail, vctx("mail"), reviewed);
    carryContexts(a, payload, keys);
    if (view("slack")) finalizeSlackView(payload.slack!, reviewed); // after thread state: 확인 완료 keys carry the latest reply
    a.sources_status ??= {};
    for (const k of keys) {
      const sig = sourceSignature(k, payload);
      const prevSig = a.sources_status[k]?.signature;
      (a as unknown as Record<string, unknown>)[k] = payload[k];
      a.sources_status[k] = { status: "done", updated_at: Date.now(), started_at: meta.started, duration_ms: Date.now() - meta.started, cost_usd: meta.cost, signature: sig, unchanged: sig === prevSig };
    }
    if (keys.includes("calendar")) a.calendar_range = calendarRange(new Date(meta.now));
    a.updated_at = Date.now();
  });
  // The next incremental window starts from this run only when it really collected: not on a missing key / history write
  // failure, and not on an empty incremental answer (right after a restart the connectors may not be attached yet —
  // moving the anchor would lose that stretch for good).
  for (const k of ["slack", "mail"] as const) {
    if (!keys.includes(k) || !recording(cfg, k)) continue;
    const inc = meta.win?.[k] ? !meta.win[k]!.full : false;
    const why = missing.has(k) ? "no key in the answer" : failed.has(k) ? "history write failed" : inc && empty[k] ? "empty incremental answer" : "";
    if (why) log(`agenda[${k}]: window anchor kept (${why})`);
    else noteCollected(k, meta.now, meta.win?.[k]?.full ?? true);
  }
  return a;
}

/** github without an LLM: the three `gh search prs` queries in parallel. null when gh is missing / unauthenticated / failing. */
export async function fetchGithubDirect(): Promise<GithubItem[] | null> {
  const fields = "repository,number,title,url,author,updatedAt";
  const q: [GithubItem["reason"], string[]][] = [
    ["review_requested", ["--review-requested=@me"]],
    ["my_pr_changes_requested", ["--author=@me", "--review=changes_requested"]],
    ["my_pr_approved", ["--author=@me", "--review=approved"]],
  ];
  try {
    const lists = await Promise.all(
      q.map(([, args]) =>
        execFileP("gh", ["search", "prs", ...args, "--state=open", "--json", fields, "--limit", "20"], { timeout: 30_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }).then((r) => JSON.parse(r.stdout) as Record<string, any>[]),
      ),
    );
    const seen = new Set<string>();
    const out: GithubItem[] = [];
    lists.forEach((list, i) => {
      for (const e of list) {
        if (!e?.url || seen.has(e.url)) continue;
        seen.add(e.url);
        out.push({ repo: str(e.repository?.nameWithOwner), number: Number(e.number) || 0, title: str(e.title), url: str(e.url), author: str(e.author?.login), updated: str(e.updatedAt), reason: q[i][0] });
      }
    });
    return out.slice(0, 20);
  } catch (e) {
    log(`agenda[github]: gh failed — falling back to claude (${String(e).slice(0, 200)})`);
    return null;
  }
}

/** NED_NO_LLM: the fixture (NED_NO_LLM_AGENDA = path to a raw model-shaped JSON) or {}; optional per-call delay. */
async function stubList(keys: AgendaSourceKey[], order: number): Promise<{ raw: Record<string, unknown>; cost: number }> {
  const delay = Number(process.env.NED_NO_LLM_DELAY_MS) || 0;
  if (delay) await new Promise((r) => setTimeout(r, delay * (order + 1)));
  const file = process.env.NED_NO_LLM_AGENDA;
  const fx = file ? readJson<Record<string, unknown>>(file, {}) : {};
  return { raw: Object.fromEntries(keys.map((k) => [k, fx[k]])), cost: 0 };
}

/** Per-source in-flight runs: a source is refreshed by at most one run at a time, different sources run side by side. */
const running = new Map<AgendaSourceKey, Promise<Agenda>>();

/** True while any agenda source refresh is running. */
export function agendaBusy(): boolean {
  return running.size > 0;
}

/** Sources whose phase-1 list call is in flight right now. */
export function runningSources(): AgendaSourceKey[] {
  return AGENDA_SOURCES.filter((k) => running.has(k));
}

/** Sources switched on in config (mail = sources.gmail). */
export function enabledSources(cfg: NedConfig): AgendaSourceKey[] {
  return AGENDA_SOURCES.filter((k) => (k === "mail" ? cfg.sources.gmail : cfg.sources[k]));
}

export interface RefreshOptions {
  /** Only these sources (default: every enabled source). Disabled ones are ignored. */
  sources?: readonly AgendaSourceKey[];
}

export interface RefreshStart {
  /** Sources this call started. */
  started: AgendaSourceKey[];
  /** Requested sources already running in another refresh (joined, not restarted). */
  busy: AgendaSourceKey[];
  /** Resolves once the started and joined sources are merged (phase 1). */
  done: Promise<Agenda>;
}

/**
 * Start a phase-1 refresh for the requested sources. A source already running is joined instead of re-run, so a
 * POST during a scheduled refresh never spawns a second `claude -p` for it; other sources start right away.
 */
export function startAgendaRefresh(cfg: NedConfig, opts: RefreshOptions = {}): RefreshStart {
  const enabled = enabledSources(cfg);
  if (!enabled.length) {
    // Nothing on: the agenda is empty (dashboard hides every card).
    const a = emptyAgenda(Date.now());
    writeJsonAtomic(AGENDA_PATH, a);
    return { started: [], busy: [], done: Promise.resolve(a) };
  }
  const want = opts.sources ? enabled.filter((k) => opts.sources!.includes(k)) : enabled;
  const busy = want.filter((k) => running.has(k));
  const started = want.filter((k) => !running.has(k));
  const waits: Promise<unknown>[] = [...new Set(busy.map((k) => running.get(k)!))];
  if (started.length) {
    const p: Promise<Agenda> = doRefresh(cfg, started).finally(() => {
      for (const k of started) if (running.get(k) === p) running.delete(k);
    });
    for (const k of started) running.set(k, p);
    waits.push(p);
  }
  return { started, busy, done: Promise.all(waits).then(() => readAgenda()) };
}

/** Refresh agenda.json (all enabled sources, or `opts.sources`) and resolve after phase 1. */
export function refreshAgenda(cfg: NedConfig, opts: RefreshOptions = {}): Promise<Agenda> {
  return startAgendaRefresh(cfg, opts).done;
}

async function doRefresh(cfg: NedConfig, want: AgendaSourceKey[]): Promise<Agenda> {
  const now = Date.now();
  if (llmDisabled()) log(`agenda: NED_NO_LLM=1 — stub lists${process.env.NED_NO_LLM_AGENDA ? ` from ${process.env.NED_NO_LLM_AGENDA}` : " (empty)"}`);

  if (filtersPrompt(cfg.filters) !== "(없음)") log(`agenda: filters — ${filtersPrompt(cfg.filters).split("\n")[0]}`);
  const t0 = Date.now();
  const stub = llmDisabled();
  const errors: string[] = [];
  let total = 0;
  const finished: string[] = [];

  // Mark the requested sources as running up front so their cards show "갱신 중" immediately.
  setSourceStatus(want, { status: "running", updated_at: Date.now(), started_at: t0 });

  const runCall = async (c: ListCall, order: number): Promise<void> => {
    const started = Date.now();
    // Slack / mail: incremental windows from the history (first run / every FULL_RESCAN_HOURS: the full window).
    const win = listWindows(cfg, c.keys, now, readAgenda().slack);
    const incremental = (["slack", "mail"] as const).some((k) => win[k] && !win[k]!.full);
    if (win.slack || win.mail) log(`agenda[${c.id}]: window ${(["slack", "mail"] as const).filter((k) => win[k]).map((k) => `${k} ${win[k]!.full ? `full (${win[k]!.reason})` : `since ${new Date(win[k]!.since).toISOString().slice(11, 16)}Z`}`).join(", ")}`);
    let extras: MergeMeta["extras"] = {};
    let missing: AgendaSourceKey[] = [];
    const parse = (text: string): AgendaPayload | null => {
      const j = extractJson<Partial<Record<keyof AgendaPayload, unknown>>>(text);
      if (j) { extras = listExtras(j); missing = missingKeys(j as Record<string, unknown>, c.keys); }
      return j ? normalize(j, cfg, new Date(now).toISOString()) : null;
    };
    let payload: AgendaPayload | null = null, cost = 0, turns = 0, error = "", raw = "";
    if (stub) {
      const s = await stubList(c.keys, order);
      extras = listExtras(s.raw);
      missing = missingKeys(s.raw, c.keys);
      payload = normalize(s.raw, cfg, new Date(now).toISOString());
    } else {
      const run = () =>
        runClaude(buildListsPrompt(cfg, c.keys, new Date(now), undefined, win), {
          allowedTools: listTools(c.keys),
          tools: c.keys.includes("github") ? ["ToolSearch", "Bash"] : ["ToolSearch"],
          maxTurns: c.maxTurns,
          model: c.model,
          timeoutMs: 4 * 60_000,
          job: "agenda",
        });
      let res = await run();
      cost = res.cost_usd;
      turns = res.num_turns;
      payload = res.ok ? parse(res.text) : null;
      // An incremental window is usually empty (nothing new) — that's the point, not a connector hiccup.
      if (payload && !incremental && emptyFor(payload, c.keys)) {
        // Seen live: the claude.ai connectors hadn't attached yet when ToolSearch ran (daemon start), so the
        // call came back []. One delayed retry usually finds them; a second empty answer is taken as real.
        log(`agenda[${c.id}]: empty on first try ($${cost.toFixed(2)}, ${turns} turns) — retrying once in 20s`);
        try { fs.writeFileSync(AGENDA_RAW_PATH, res.text.slice(0, 4000)); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 20_000));
        res = await run();
        cost += res.cost_usd;
        turns += res.num_turns;
        payload = res.ok ? parse(res.text) : null;
      }
      if (!payload) error = res.ok ? `invalid JSON from model (${turns} turns, ${res.text.length} chars, tail: …${res.text.slice(-120)})` : (res.error ?? "claude failed").slice(0, 500);
      raw = res.text;
    }
    total += cost;
    const at = Math.round((Date.now() - t0) / 1000);
    if (!payload) {
      // Keep the last good lists so the card doesn't blank out on a transient failure.
      setSourceStatus(c.keys, { status: "error", updated_at: Date.now(), started_at: started, duration_ms: Date.now() - started, cost_usd: cost, error });
      errors.push(`${c.id}: ${error.slice(0, 200)}`);
      // Whole answer (capped at 1 MB), so a cut-off / malformed reply can be inspected after the fact.
      if (raw) try { fs.writeFileSync(AGENDA_RAW_PATH, raw.slice(0, 1_000_000)); } catch { /* ignore */ }
      log(`agenda[${c.id}]: failed at +${at}s — ${error.slice(0, 300)}`);
      return;
    }
    const a = mergeSources(payload, c.keys, { started, cost, now, win, extras, missing }, cfg);
    finished.push(`${c.id}+${at}s`);
    const unchanged = c.keys.filter((k) => a.sources_status?.[k]?.unchanged);
    log(`agenda[${c.id}]: ${describe(a, c.keys)} — $${cost.toFixed(2)}, ${turns} turns, ${Math.round((Date.now() - started) / 1000)}s, merged at +${at}s${unchanged.length ? ` (unchanged: ${unchanged.join(",")})` : ""}`);
    if (c.keys.includes("slack") || c.keys.includes("mail")) {
      // Phase 2 for this source starts now, in the background (Slack queued first). Lazy import: agenda-context imports this module.
      const srcs = c.keys.filter((k): k is "slack" | "mail" => k === "slack" || k === "mail");
      import("./agenda-context.js").then((m) => m.requestContext(cfg, srcs)).catch((e) => log(`agenda-context: failed to start ${String(e)}`));
    }
  };

  // github: straight from `gh` (no LLM) while the claude calls start; only if gh fails does it join the light call.
  const wantGh = want.includes("github");
  const ghP: Promise<GithubItem[] | null> = wantGh && !stub ? fetchGithubDirect() : Promise.resolve(null);
  const calls = listCalls(cfg, wantGh && !stub, want); // optimistic: assume gh works
  const jobs: Promise<void>[] = [];
  // Start order = priority (slack, mail, calendar); the jira call waits for gh's answer (~1s) to know whether to carry github.
  calls.filter((c) => c.id !== "jira").forEach((c, i) => jobs.push(runCall(c, i)));
  jobs.push(
    (async () => {
      const gh = await ghP;
      if (gh) {
        mergeSources({ ...emptyAgenda(now), github: gh }, ["github"], { started: t0, cost: 0, now }, cfg);
        finished.push(`github+${Math.round((Date.now() - t0) / 1000)}s`);
        log(`agenda[github]: ${gh.length} prs via gh (no LLM), merged at +${Math.round((Date.now() - t0) / 1000)}s`);
      }
      const jira = listCalls(cfg, !!gh, want).find((c) => c.id === "jira");
      if (jira) await runCall(jira, 2);
    })(),
  );
  await Promise.all(jobs);

  const agenda = patchAgenda((a) => {
    a.cost_usd = Math.round(total * 10000) / 10000;
    // Errors of every source as they stand now: a slack-only run neither clears nor hides a failing jira.
    const errs = AGENDA_SOURCES.filter((k) => a.sources_status?.[k]?.status === "error" && enabledSources(cfg).includes(k)).map((k) => `${k}: ${(a.sources_status![k]!.error ?? "").slice(0, 200)}`);
    a.error = errs.length ? errs.join(" | ") : undefined;
    a.updated_at = Date.now();
  });
  log(`agenda: phase 1 [${want.join(",")}] done in ${Math.round((Date.now() - t0) / 1000)}s, $${total.toFixed(2)} — order ${finished.join(", ")}${errors.length ? ` — errors: ${errors.join(" | ").slice(0, 300)}` : ""}`);
  return agenda;
}

function describe(a: Agenda, keys: AgendaSourceKey[]): string {
  return keys
    .map((k) => {
      if (k === "slack") return `slack ${a.slack?.items.length ?? 0} items / ${a.slack?.all.length ?? 0} all${a.slack?.watch.length ? ` / ${a.slack.watch.length} watched (${a.slack.watch.reduce((n, w) => n + w.highlights.filter((h) => h.needs_me).length, 0)} needs_me)` : ""}`;
      if (k === "mail") return `mail ${a.mail?.items.length ?? 0} items / ${a.mail?.all.length ?? 0} all / ${a.mail?.unread ?? 0} unread`;
      return `${a[k].length} ${k}`;
    })
    .join(", ");
}
