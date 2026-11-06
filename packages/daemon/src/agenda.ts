import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractJson, llmDisabled, runClaude } from "./claude.js";
import type { NedConfig } from "./config.js";
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
}

export interface SlackBlock {
  /** One-line summary in Ned's voice; "" when nothing notable. */
  summary: string;
  /** Last 24h: mentions / DMs / thread asks I haven't answered, max 10. */
  items: SlackItem[];
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
  cost_usd: number;
  error?: string;
}

/** Must match the `unread` search limit in prompts/agenda.md. */
export const MAIL_UNREAD_CAP = 50;
const EMPTY: Agenda = { updated_at: 0, cost_usd: 0, calendar: [], jira: [], github: [], mail: null, slack: null };
const emptyAgenda = (now: number): Agenda => ({ ...EMPTY, updated_at: now });

export function readAgenda(): Agenda {
  const a = readJson<Partial<Agenda>>(AGENDA_PATH, {});
  return { ...EMPTY, ...a, calendar: a.calendar ?? [], jira: a.jira ?? [], github: a.github ?? [], mail: readMail(a.mail), slack: readSlack(a.slack) };
}

/** A missing/garbled mail block stays null so the dashboard can say mail hasn't been fetched yet. */
function readMail(m: unknown): MailBlock | null {
  if (!m || typeof m !== "object") return null;
  const b = m as Partial<MailBlock>;
  const unread = Math.max(0, Math.trunc(Number(b.unread) || 0));
  return { summary: str(b.summary), unread, unread_capped: b.unread_capped ?? unread >= MAIL_UNREAD_CAP, items: Array.isArray(b.items) ? b.items : [] };
}

function readSlack(m: unknown): SlackBlock | null {
  if (!m || typeof m !== "object") return null;
  const b = m as Partial<SlackBlock>;
  return { summary: str(b.summary), items: Array.isArray(b.items) ? b.items : [] };
}

/** Read tools for the agenda job only — narrower than the heartbeat's set. */
function agendaTools(cfg: NedConfig): string[] {
  const t = ["ToolSearch"];
  if (cfg.sources.calendar) t.push("mcp__claude_ai_Google_Calendar__list_events", "mcp__claude_ai_Google_Calendar__search_events");
  if (cfg.sources.jira) t.push("mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql");
  if (cfg.sources.github) t.push("Bash(gh search prs:*)", "Bash(gh pr list:*)", "Bash(gh api:*)");
  if (cfg.sources.gmail) t.push("mcp__claude_ai_Gmail__search_threads");
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

/** Coerce model output into the exact contract the dashboard expects. */
function normalize(raw: Partial<Record<keyof AgendaPayload, unknown>>, cfg: NedConfig): AgendaPayload {
  const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
  const calendar: CalendarItem[] = cfg.sources.calendar
    ? arr(raw.calendar)
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
        .sort((a, b) => (a.all_day === b.all_day ? Date.parse(a.start) - Date.parse(b.start) || 0 : a.all_day ? -1 : 1))
    : [];
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
          })),
      }
    : null;
  return { calendar, jira, github, mail, slack };
}

function buildPrompt(cfg: NedConfig, now = new Date()): string {
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const off = (on: boolean) => (on ? "ON" : "OFF — 조회하지 말고 빈 배열 []");
  return fs
    .readFileSync(path.join(PROMPTS_DIR, "agenda.md"), "utf8")
    .replaceAll("{{NOW}}", isoLocal(now))
    .replaceAll("{{TZ}}", Intl.DateTimeFormat().resolvedOptions().timeZone)
    .replaceAll("{{DAY_START}}", isoLocal(dayStart))
    .replaceAll("{{DAY_END}}", isoLocal(dayEnd))
    .replaceAll("{{CALENDAR}}", off(cfg.sources.calendar))
    .replaceAll("{{JIRA}}", off(cfg.sources.jira))
    .replaceAll("{{GITHUB}}", off(cfg.sources.github))
    .replaceAll("{{GMAIL}}", off(cfg.sources.gmail))
    .replaceAll("{{SLACK}}", off(cfg.sources.slack))
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

  log("agenda: asking claude");
  const res = await runClaude(buildPrompt(cfg), { allowedTools: agendaTools(cfg), maxTurns: 16, model: cfg.claude_model, timeoutMs: 5 * 60_000 });
  const parsed = res.ok ? extractJson<Partial<Record<keyof AgendaPayload, unknown>>>(res.text) : null;
  let agenda: Agenda;
  if (parsed) {
    agenda = { updated_at: Date.now(), cost_usd: res.cost_usd, ...normalize(parsed, cfg) };
  } else {
    // Keep the last good lists so the dashboard doesn't blank out on a transient failure.
    const prev = readAgenda();
    const error = res.ok ? `invalid JSON from model: ${res.text.slice(0, 300)}` : (res.error ?? "claude failed").slice(0, 500);
    agenda = { ...prev, updated_at: Date.now(), cost_usd: res.cost_usd, error };
    log(`agenda: failed — ${error.slice(0, 300)}`);
  }
  writeJsonAtomic(AGENDA_PATH, agenda);
  log(`agenda: ${agenda.calendar.length} events / ${agenda.jira.length} jira / ${agenda.github.length} prs / ${agenda.mail?.items.length ?? "-"} mails / ${agenda.slack?.items.length ?? "-"} slack ($${res.cost_usd.toFixed(2)}, ${res.num_turns} turns, ${Math.round(res.duration_ms / 1000)}s)`);
  return agenda;
}
