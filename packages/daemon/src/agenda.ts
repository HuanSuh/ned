import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import { filtersPrompt, jqlExclude, type NedConfig } from "./config.js";
import { personaPrompt } from "./persona.js";
import { AGENDA_PATH, log, readJson, writeJsonAtomic } from "./paths.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(here, "../../../prompts");

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

/** Size limits for agenda-collected draft context (must match prompts/agenda.md). */
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

export interface Agenda extends AgendaPayload {
  updated_at: number;
  /** Local dates (inclusive) the calendar list covers: yesterday … today+13. Absent in older agenda.json (= today only). */
  calendar_range?: { from: string; to: string };
  cost_usd: number;
  error?: string;
}

/** Must match the `unread` search limit in prompts/agenda.md. */
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
  return { summary: str(b.summary), items: Array.isArray(b.items) ? b.items : [], all: Array.isArray(b.all) ? b.all : [] };
}

/** Read tools for the agenda job only — narrower than the heartbeat's set. */
function agendaTools(cfg: NedConfig): string[] {
  const t = ["ToolSearch"];
  if (cfg.sources.calendar) t.push("mcp__claude_ai_Google_Calendar__list_events", "mcp__claude_ai_Google_Calendar__search_events");
  if (cfg.sources.jira) t.push("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql");
  if (cfg.sources.github) t.push("Bash(gh search prs:*)", "Bash(gh pr list:*)", "Bash(gh api:*)");
  if (cfg.sources.gmail) t.push("mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__get_thread");
  if (cfg.sources.slack) t.push("mcp__claude_ai_Slack__slack_search_public_and_private", "mcp__claude_ai_Slack__slack_read_thread");
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
function normalize(raw: Partial<Record<keyof AgendaPayload, unknown>>, cfg: NedConfig, collectedAt = new Date().toISOString()): AgendaPayload {
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
          .slice(0, 50)
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
          .slice(0, 50)
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
      }
    : null;
  // Belt and braces for tracking exclusions: drop anything the model let through.
  const exProjects = new Set(cfg.filters.jira.exclude_projects);
  const exChannels = new Set(cfg.filters.slack.exclude_channels.map((c) => c.toLowerCase()));
  const jiraKept = jira.filter((j) => !exProjects.has(j.key.split("-")[0].toUpperCase()));
  const keepCh = (x: { channel: string }) => !exChannels.has(x.channel.replace(/^#/, "").toLowerCase());
  if (slack) {
    slack.items = collapseDMs(slack.items.filter(keepCh));
    slack.all = collapseDMs(slack.all.filter(keepCh));
    // The prompt lets all[] skip context for rows already in items[]: share it by permalink, both ways.
    const byUrl = new Map<string, SlackContext>();
    for (const x of [...slack.items, ...slack.all]) if (x.context && x.url) byUrl.set(x.url, x.context);
    for (const x of [...slack.items, ...slack.all]) if (!x.context && byUrl.has(x.url)) x.context = byUrl.get(x.url);
  }
  return { calendar, jira: jiraKept, github, mail, slack };
}

export function buildPrompt(cfg: NedConfig, now = new Date()): string {
  const cr = calendarRange(now), cb = rangeBounds(cr.from, cr.to);
  const off = (on: boolean) => (on ? "ON" : "OFF — 조회하지 말고 빈 배열 []");
  return fs
    .readFileSync(path.join(PROMPTS_DIR, "agenda.md"), "utf8")
    .replaceAll("{{NOW}}", isoLocal(now))
    .replaceAll("{{TZ}}", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .replaceAll("{{CAL_FROM}}", cr.from)
    .replaceAll("{{CAL_TO}}", cr.to)
    .replaceAll("{{CAL_START}}", cb.start)
    .replaceAll("{{CAL_END}}", cb.end)
    .replaceAll("{{CALENDAR}}", off(cfg.sources.calendar))
    .replaceAll("{{JIRA}}", off(cfg.sources.jira))
    .replaceAll("{{GITHUB}}", off(cfg.sources.github))
    .replaceAll("{{GMAIL}}", off(cfg.sources.gmail))
    .replaceAll("{{SLACK}}", off(cfg.sources.slack))
    .replaceAll("{{PERSONA}}", () => personaPrompt(cfg.persona))
    .replaceAll("{{FILTERS}}", () => filtersPrompt(cfg.filters))
    .replaceAll("{{JQL_EXCLUDE}}", () => (jqlExclude(cfg.filters) ? ` ${jqlExclude(cfg.filters)}` : ""))
    .replaceAll("{{SLACK_SINCE}}", String(Math.floor(now.getTime() / 1000) - 24 * 3600));
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
  if (llmDisabled()) {
    log("agenda: NED_NO_LLM=1 — skipping claude, writing empty agenda");
    const a = emptyAgenda(now);
    writeJsonAtomic(AGENDA_PATH, a);
    return a;
  }
  if (!cfg.sources.calendar && !cfg.sources.jira && !cfg.sources.github && !cfg.sources.gmail && !cfg.sources.slack) {
    const a = emptyAgenda(now);
    writeJsonAtomic(AGENDA_PATH, a);
    return a;
  }

  log(`agenda: asking claude${filtersPrompt(cfg.filters) !== "(없음)" ? ` (filters — ${filtersPrompt(cfg.filters).split("\n")[0]})` : ""}`);
  // 22 = the old 20 + one turn for the parallel get_thread reads that fill mail item context.
  const res = await runClaude(buildPrompt(cfg), { allowedTools: agendaTools(cfg), maxTurns: 22, model: cfg.claude_model, timeoutMs: 5 * 60_000 });
  const parsed = res.ok ? extractJson<Partial<Record<keyof AgendaPayload, unknown>>>(res.text) : null;
  let agenda: Agenda;
  if (parsed) {
    agenda = { updated_at: Date.now(), cost_usd: res.cost_usd, calendar_range: calendarRange(new Date(now)), ...normalize(parsed, cfg, new Date(now).toISOString()) };
  } else {
    // Keep the last good lists so the dashboard doesn't blank out on a transient failure.
    const prev = readAgenda();
    const error = res.ok ? `invalid JSON from model: ${res.text.slice(0, 300)}` : (res.error ?? "claude failed").slice(0, 500);
    agenda = { ...prev, updated_at: Date.now(), cost_usd: res.cost_usd, error };
    log(`agenda: failed — ${error.slice(0, 300)}`);
  }
  writeJsonAtomic(AGENDA_PATH, agenda);
  if (parsed && cfg.drafts_pregenerate) {
    // Background, after the agenda is on disk; drafts.ts imports agenda.ts, so load it lazily.
    import("./drafts.js").then((m) => m.pregenerateDrafts(agenda, cfg)).catch((e) => log(`pregenerate: failed ${String(e)}`));
  }
  const ctxN = (agenda.slack?.items.filter((x) => x.context).length ?? 0) + (agenda.mail?.items.filter((x) => x.context).length ?? 0);
  log(`agenda: ${ctxN} items with draft context`);
  log(`agenda: ${agenda.calendar.length} events / ${agenda.jira.length} jira / ${agenda.github.length} prs / ${agenda.mail?.items.length ?? "-"} mails / ${agenda.slack?.items.length ?? "-"} slack ($${res.cost_usd.toFixed(2)}, ${res.num_turns} turns, ${Math.round(res.duration_ms / 1000)}s)`);
  return agenda;
}
