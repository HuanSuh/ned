import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import { filtersPrompt, jqlExclude, watchChannels, type NedConfig } from "./config.js";
import { personaPrompt } from "./persona.js";
import { AGENDA_PATH, AGENDA_RAW_PATH, log, readJson, writeJsonAtomic } from "./paths.js";

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

export type SlackReason = "mention" | "dm" | "thread";

export interface SlackItem {
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
}

export interface SlackWatchHighlight {
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
  stopped: "budget" | null;
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
  return { summary: str(b.summary), items: Array.isArray(b.items) ? b.items : [], all: Array.isArray(b.all) ? b.all : [], watch: Array.isArray(b.watch) ? b.watch : [] };
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
const SLACK_REASONS: SlackReason[] = ["mention", "dm", "thread"];

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
    slack.items = collapseDMs(slack.items.filter(keepCh));
    slack.all = supersetSlack(slack.items, collapseDMs(slack.all.filter(keepCh)));
    // The prompt lets all[] skip context for rows already in items[]: share it by permalink, both ways.
    const byUrl = new Map<string, SlackContext>();
    for (const x of [...slack.items, ...slack.all]) if (x.context && x.url) byUrl.set(x.url, x.context);
    for (const x of [...slack.items, ...slack.all]) if (!x.context && byUrl.has(x.url)) x.context = byUrl.get(x.url);
  }
  if (mail) mail.all = supersetMail(mail.items, mail.all);
  return { calendar, jira: jiraKept, github, mail, slack };
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
    }));
}

/** Keep the `<!--@name-->…<!--@/name-->` sections in `keep`, drop the rest (prompts/agenda-lists.md). */
export function pickSections(text: string, keep: Set<string>): string {
  return text.replace(/<!--@([a-z]+)-->\n?([\s\S]*?)<!--@\/\1-->\n?/g, (_m, name: string, body: string) => (keep.has(name) ? body : ""));
}

/** Phase-1 prompt for one call covering `keys` (prompts/agenda-lists.md: lists only, no per-item context). */
export function buildListsPrompt(cfg: NedConfig, keys: AgendaSourceKey[], now = new Date()): string {
  const cr = calendarRange(now), cb = rangeBounds(cr.from, cr.to);
  const watch = keys.includes("slack") ? watchChannels(cfg.filters) : [];
  const keep = new Set<string>(keys);
  if (keys.includes("slack") || keys.includes("mail")) keep.add("voice");
  if (watch.length) keep.add("watch");
  const select = `select:${keys.flatMap((k) => LIST_TOOLS[k]).join(",")}`;
  const since = String(Math.floor(now.getTime() / 1000) - 24 * 3600);
  return pickSections(fs.readFileSync(path.join(PROMPTS_DIR, "agenda-lists.md"), "utf8"), keep)
    .replaceAll("{{NOW}}", isoLocal(now))
    .replaceAll("{{TZ}}", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .replaceAll("{{TOOL_SELECT}}", select)
    .replaceAll("{{CAL_FROM}}", cr.from)
    .replaceAll("{{CAL_TO}}", cr.to)
    .replaceAll("{{CAL_START}}", cb.start)
    .replaceAll("{{CAL_END}}", cb.end)
    .replaceAll("{{ALL_LIMIT}}", String(cfg.agenda_all_limit))
    .replaceAll("{{WATCH_CHANNELS}}", watch.map((c) => `#${c}`).join(", "))
    .replaceAll("{{WATCH_KEY}}", watch.length ? ',"watch":[{"channel":"#채널","summary":"","highlights":[{"from":"","text":"","ts":"ISO","url":"","needs_me":false,"reason":""}]}]' : "")
    .replaceAll("{{PERSONA}}", () => personaPrompt(cfg.persona))
    .replaceAll("{{FILTERS}}", () => filtersPrompt(cfg.filters))
    .replaceAll("{{JQL_EXCLUDE}}", () => (jqlExclude(cfg.filters) ? ` ${jqlExclude(cfg.filters)}` : ""))
    .replaceAll("{{SLACK_SINCE}}", since);
}

/** `ned prompt agenda`: every phase-1 prompt this config would send, in start order. */
export function buildPrompt(cfg: NedConfig, now = new Date()): string {
  return listCalls(cfg, false)
    .map((c) => `===== ${c.id} (${c.keys.join("+")}, model ${c.model ?? "default"}, maxTurns ${c.maxTurns}) =====\n${buildListsPrompt(cfg, c.keys, now)}`)
    .join("\n\n");
}

interface ListCall {
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
function listCalls(cfg: NedConfig, githubDirect: boolean): ListCall[] {
  const out: ListCall[] = [];
  const light = cfg.agenda_light_model ?? cfg.claude_model;
  // Measured: slack/mail on sonnet take the same wall time as the default model at ~half the cost ($0.38 vs $0.79, $0.24 vs $0.50).
  if (cfg.sources.slack) out.push({ id: "slack", keys: ["slack"], model: light, maxTurns: 6 });
  if (cfg.sources.gmail) out.push({ id: "mail", keys: ["mail"], model: light, maxTurns: 6 });
  const jira: AgendaSourceKey[] = [];
  if (cfg.sources.jira) jira.push("jira");
  if (cfg.sources.github && !githubDirect) jira.push("github");
  if (jira.length) out.push({ id: "jira", keys: jira, model: light, maxTurns: 6 });
  if (cfg.sources.calendar) out.push({ id: "calendar", keys: ["calendar"], model: light, maxTurns: 6 });
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

/** Merge one finished call's keys into agenda.json (item-level context carry-over) and mark them done. */
function mergeSources(payload: AgendaPayload, keys: AgendaSourceKey[], meta: { started: number; cost: number; now: number }): Agenda {
  return patchAgenda((a) => {
    carryContexts(a, payload, keys);
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

let inflight: Promise<Agenda> | null = null;

/** True while an agenda refresh is running. */
export function agendaBusy(): boolean {
  return inflight !== null;
}

/**
 * Refresh ~/.ned/agenda.json. Concurrent callers share the in-flight run (busy guard),
 * so a POST during a scheduled refresh never spawns a second `claude -p`.
 */
export function refreshAgenda(cfg: NedConfig): Promise<Agenda> {
  if (inflight) return inflight;
  inflight = doRefresh(cfg).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doRefresh(cfg: NedConfig): Promise<Agenda> {
  const now = Date.now();
  if (llmDisabled()) log(`agenda: NED_NO_LLM=1 — stub lists${process.env.NED_NO_LLM_AGENDA ? ` from ${process.env.NED_NO_LLM_AGENDA}` : " (empty)"}`);
  if (!cfg.sources.calendar && !cfg.sources.jira && !cfg.sources.github && !cfg.sources.gmail && !cfg.sources.slack) {
    const a = emptyAgenda(now);
    writeJsonAtomic(AGENDA_PATH, a);
    return a;
  }

  if (filtersPrompt(cfg.filters) !== "(없음)") log(`agenda: filters — ${filtersPrompt(cfg.filters).split("\n")[0]}`);
  const t0 = Date.now();
  const stub = llmDisabled();
  const errors: string[] = [];
  let total = 0;
  const finished: string[] = [];

  // Mark everything enabled as running up front so every card shows "갱신 중" immediately.
  const enabled = AGENDA_SOURCES.filter((k) => (k === "mail" ? cfg.sources.gmail : cfg.sources[k]));
  setSourceStatus(enabled, { status: "running", updated_at: Date.now(), started_at: t0 });

  const runCall = async (c: ListCall, order: number): Promise<void> => {
    const started = Date.now();
    const parse = (text: string): AgendaPayload | null => {
      const j = extractJson<Partial<Record<keyof AgendaPayload, unknown>>>(text);
      return j ? normalize(j, cfg, new Date(now).toISOString()) : null;
    };
    let payload: AgendaPayload | null = null, cost = 0, turns = 0, error = "", raw = "";
    if (stub) {
      const s = await stubList(c.keys, order);
      payload = normalize(s.raw, cfg, new Date(now).toISOString());
    } else {
      const run = () =>
        runClaude(buildListsPrompt(cfg, c.keys, new Date(now)), {
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
      if (payload && emptyFor(payload, c.keys)) {
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
      if (!payload) error = res.ok ? `invalid JSON from model: ${res.text.slice(0, 300)}` : (res.error ?? "claude failed").slice(0, 500);
      raw = res.text;
    }
    total += cost;
    const at = Math.round((Date.now() - t0) / 1000);
    if (!payload) {
      // Keep the last good lists so the card doesn't blank out on a transient failure.
      setSourceStatus(c.keys, { status: "error", updated_at: Date.now(), started_at: started, duration_ms: Date.now() - started, cost_usd: cost, error });
      errors.push(`${c.id}: ${error.slice(0, 200)}`);
      if (raw) try { fs.writeFileSync(AGENDA_RAW_PATH, raw.slice(0, 4000)); } catch { /* ignore */ }
      log(`agenda[${c.id}]: failed at +${at}s — ${error.slice(0, 300)}`);
      return;
    }
    const a = mergeSources(payload, c.keys, { started, cost, now });
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
  const ghP: Promise<GithubItem[] | null> = cfg.sources.github && !stub ? fetchGithubDirect() : Promise.resolve(null);
  const calls = listCalls(cfg, cfg.sources.github && !stub); // optimistic: assume gh works
  const jobs: Promise<void>[] = [];
  // Start order = priority (slack, mail, calendar); the jira call waits for gh's answer (~1s) to know whether to carry github.
  calls.filter((c) => c.id !== "jira").forEach((c, i) => jobs.push(runCall(c, i)));
  jobs.push(
    (async () => {
      const gh = await ghP;
      if (gh) {
        mergeSources({ ...emptyAgenda(now), github: gh }, ["github"], { started: t0, cost: 0, now });
        finished.push(`github+${Math.round((Date.now() - t0) / 1000)}s`);
        log(`agenda[github]: ${gh.length} prs via gh (no LLM), merged at +${Math.round((Date.now() - t0) / 1000)}s`);
      }
      const jira = listCalls(cfg, !!gh).find((c) => c.id === "jira");
      if (jira) await runCall(jira, 2);
    })(),
  );
  await Promise.all(jobs);

  const agenda = patchAgenda((a) => {
    a.cost_usd = Math.round(total * 10000) / 10000;
    a.error = errors.length ? errors.join(" | ") : undefined;
    a.updated_at = Date.now();
  });
  log(`agenda: phase 1 done in ${Math.round((Date.now() - t0) / 1000)}s, $${total.toFixed(2)} — order ${finished.join(", ")}${errors.length ? ` — errors: ${errors.join(" | ").slice(0, 300)}` : ""}`);
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
