import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveTouch } from "./archive.js";
import { agendaBusy, readAgenda, refreshAgenda, type Agenda } from "./agenda.js";
import { extractJson, llmDisabled, noLlmResult, runClaude, type ClaudeRunOptions } from "./claude.js";
import { RESP_SOURCES, activeResponsibilities, inQuietHours, watchChannels, type NedConfig, type NotifyKind, type RespSource, type Responsibility } from "./config.js";
import { personaPrompt } from "./persona.js";
import { readRecentEvents, readUnprocessedEvents, type NedEvent } from "./events.js";
import { notify } from "./notify.js";
import { BRIEFINGS_DIR, DISMISSED_PATH, SENT_LOG, localDay, log, readJson, writeJsonAtomic } from "./paths.js";
import { reduceSessions } from "./sessions.js";
import { annotateChatOrigin } from "./session-create.js";
import { THREAD_FOLLOW_HOURS, hasNewSinceMe, threadActivity, threadKeyOf } from "./slack-threads.js";
import { RESP_STATUSES, briefingOk, readState, writeState, type AttentionItem, type Briefing, type BriefingSection, type RespStatus } from "./state.js";

type State = ReturnType<typeof readState>;

const here = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(here, "../../../prompts");

/**
 * Heartbeat / briefing read Gmail·Slack·Jira·GitHub·Calendar from agenda.json (agenda phase 1 already fetched them).
 * Sentry is the only source agenda doesn't cover, so it is the only connector the model may load (via ToolSearch).
 */
const SENTRY_TOOLS = ["mcp__Sentry__search_issues", "mcp__Sentry__get_issue_details"];
export const HEARTBEAT_MAX_TURNS = 6;

/** claude -p options for a heartbeat: Sentry on → ToolSearch + Sentry reads; off → no tools at all, isolated (fast start). */
export function heartbeatRunOptions(cfg: NedConfig): Pick<ClaudeRunOptions, "allowedTools" | "tools" | "maxTurns" | "isolated"> {
  return cfg.sources.sentry
    ? { allowedTools: ["ToolSearch", ...SENTRY_TOOLS], tools: ["ToolSearch"], maxTurns: HEARTBEAT_MAX_TURNS }
    : { allowedTools: [], tools: [], maxTurns: 1, isolated: true };
}

interface LlmBriefing {
  status: "NED_OK" | "UPDATE";
  headline?: string;
  action_items?: BriefingSection[];
  updates?: BriefingSection[];
  fyi?: BriefingSection[];
  sessions?: BriefingSection[];
  /** 맡긴 일 ratings — only asked for when an active responsibility exists (applyResponsibilityReport cleans it). */
  responsibilities?: unknown;
}

export function sentKeys(): Set<string> {
  try {
    return new Set(fs.readFileSync(SENT_LOG, "utf8").split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

export function markSent(keys: string[]): void {
  if (keys.length) fs.appendFileSync(SENT_LOG, keys.join("\n") + "\n");
}

export const keyOf = (s: BriefingSection) => (s.url || s.title || "").trim().toLowerCase();

/**
 * Followed Slack threads where someone replied after my last message → action items, once per (thread, last_reply_ts):
 * the sent key carries the reply ts, so the next new reply raises it again. Threads marked seen at that reply are skipped.
 */
export function threadAttention(a: Agenda, sent: Set<string>, now = Date.now()): { items: BriefingSection[]; keys: string[] } {
  const since = now / 1000 - THREAD_FOLLOW_HOURS * 3600;
  const items: BriefingSection[] = [], keys: string[] = [];
  for (const t of a.slack?.threads ?? []) {
    if (!hasNewSinceMe(t) || threadActivity(t) < since) continue;
    const key = `slack-thread:${t.key}@${t.last_reply_ts}`.toLowerCase();
    if (sent.has(key)) continue;
    keys.push(key);
    items.push({
      kind: "slack",
      title: clip(`${t.channel || "Slack"} 스레드 · 내 답 이후 새 답글 ${t.new_since_me}건 — ${t.last_reply_from ? `${t.last_reply_from}: ` : ""}${t.last_reply_text ?? ""}`, 160),
      detail: clip(t.thread_summary || t.root_text || "", 200) || undefined,
      url: t.url,
    });
  }
  return { items, keys };
}

/** Heartbeat's "앞으로 2시간" calendar window (agendaDigest, non-daily): timed, not declined, starting ≤2h out and not over. */
function soonEvents(a: Agenda, now: number) {
  return a.calendar.filter((e) => {
    if (e.all_day || e.rsvp === "declined") return false;
    const s = Date.parse(e.start), end = Date.parse(e.end);
    return s <= now + 2 * 3600_000 && (Number.isFinite(end) ? end > now : s > now - 15 * 60_000);
  });
}

/**
 * What a heartbeat would see that the per-source list signatures don't cover: calendar events entering / leaving the
 * 2-hour window (time passes, the list doesn't change) and followed-thread replies after mine not yet raised (phase 2
 * reads them without touching the list). The scheduler's skip-unchanged check compares this along with the signatures.
 */
export function heartbeatWatchKey(cfg: NedConfig, a: Agenda = readAgenda(), now = Date.now()): string {
  const cal = cfg.sources.calendar ? soonEvents(a, now).map((e) => e.id).sort() : [];
  const th = cfg.sources.slack ? threadAttention(a, sentKeys(), now).keys.sort() : [];
  // 맡긴 일 added / edited / ended → judge again even if the lists didn't move. Absent when none (key as before).
  const resp = activeResponsibilities(cfg, new Date(now));
  return JSON.stringify(resp.length ? { cal, th, resp } : { cal, th });
}

function summarizeEvents(events: NedEvent[]): string {
  if (!events.length) return "(없음)";
  return events
    .slice(-40)
    .map((e) => `- ${new Date(e.ts).toLocaleTimeString("ko-KR")} ${e.event} ${e.cwd ? path.basename(e.cwd) : ""} ${e.prompt ? `prompt="${e.prompt.slice(0, 80)}"` : ""} ${e.message ? `msg="${String(e.message).slice(0, 80)}"` : ""}`.trim())
    .join("\n");
}

/** Dismissed attention ids → the alert they dismissed (`alert_ts`) and when. */
type Dismissed = Record<string, { alert_ts: number; at: number }>;
const readDismissed = () => readJson<Dismissed>(DISMISSED_PATH, {});

/** Refresh `state.sessions` from events. Cheap; runs every tick. */
export function refreshSessions(cfg: NedConfig): void {
  const state = readState();
  const sessions = annotateChatOrigin(reduceSessions(readRecentEvents(2), cfg.session_stale_minutes));
  const dismissed = readDismissed();
  // Sessions that need the human become attention items (replaced each tick),
  // unless the user dismissed this same alert (a new Notification/StopFailure brings it back).
  const sessionAttention: AttentionItem[] = sessions
    .filter((s) => s.status === "waiting" || s.status === "error")
    .filter((s) => dismissed[`session:${s.id}`]?.alert_ts !== s.alert_ts)
    .map((s) => ({
      id: `session:${s.id}`,
      kind: "session",
      title: `${s.worktree}: ${s.status === "waiting" ? "입력 대기" : "오류"}`,
      detail: s.last_summary ?? s.last_prompt ?? undefined,
      ts: s.last_event_ts,
      source: "sessions",
    }));
  state.sessions = sessions;
  state.attention = [...sessionAttention, ...state.attention.filter((a) => a.source !== "sessions")];
  state.quiet = inQuietHours(cfg);
  state.persona = cfg.persona;
  state.notifications = cfg.notifications;
  writeState(state);
}

export interface HeartbeatOptions {
  force?: boolean;
  daily?: boolean;
  /**
   * Agenda phase 1 before judging: "stale" (default) refreshes only when agenda.json is older than
   * signal_check_minutes (a refresh already running is awaited either way); "always" = POST /api/check; "skip" = use as is.
   */
  agenda?: "stale" | "always" | "skip";
}

/** Orca worker sessions (SessionView.is_worker, added elsewhere) are driven by another session — not the user's to watch. */
const isWorker = (s: object) => (s as { is_worker?: unknown }).is_worker === true;

const hm = (ms: number) => new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const when = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? `${new Date(t).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })} ${hm(t)}` : (iso ?? "");
};
const clip = (s: string | undefined | null, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * agenda.json → the {{AGENDA}} block: compact text lists the model judges from (no connector calls).
 * Heartbeat drops entries whose url was already sent (sent.log) so they can't come back; the daily briefing keeps them.
 * `markSent` (an active 맡긴 일 exists): already-sent entries stay, tagged "[이미 알림]", so a responsibility's evidence
 * doesn't vanish once it was raised (off → the text is exactly as before). `links` collects the url field of every entry
 * actually printed — the only links a 맡긴 일 rating may cite.
 */
export function agendaDigest(cfg: NedConfig, a: Agenda, opts: { daily: boolean; sent: Set<string>; now?: number; markSent?: boolean; links?: Set<string> }): string {
  const now = opts.now ?? Date.now();
  let skipped = 0;
  const isSent = (url: string | undefined) => !opts.daily && !!url && opts.sent.has(url.trim().toLowerCase());
  const keep = (url: string | undefined) => {
    if (!isSent(url) || opts.markSent) return true;
    skipped++;
    return false;
  };
  /** An entry's url as printed (+ the "[이미 알림]" tag under markSent), recorded in `links`. */
  const u = (url: string | undefined) => {
    if (url && opts.links) opts.links.add(url.trim());
    return `${opts.markSent && isSent(url) ? "[이미 알림] " : ""}${url}`;
  };
  const out: string[] = [];
  if (!a.updated_at) out.push("(agenda 아직 없음 — 세션·Sentry 만으로 판단)");
  else out.push(`agenda 갱신: ${when(new Date(a.updated_at).toISOString())} (${Math.round((now - a.updated_at) / 60_000)}분 전)`);
  const failed = Object.entries(a.sources_status ?? {}).filter(([, s]) => s?.status === "error").map(([k]) => k);
  if (failed.length) out.push(`갱신 실패 소스(이전 목록일 수 있음): ${failed.join(", ")}`);

  if (cfg.sources.calendar) {
    const soon = opts.daily
      ? a.calendar.filter((e) => !e.all_day && e.rsvp !== "declined" && new Date(Date.parse(e.start)).toDateString() === new Date(now).toDateString())
      : soonEvents(a, now);
    const allDay = opts.daily ? a.calendar.filter((e) => e.all_day && new Date(Date.parse(e.start)).toDateString() === new Date(now).toDateString()) : [];
    const rsvp = a.calendar.filter((e) => e.rsvp === "needsAction" && Date.parse(e.start) > now && !soon.includes(e)).sort((x, y) => Date.parse(x.start) - Date.parse(y.start));
    out.push(`\n#### 캘린더 — ${opts.daily ? "오늘 일정" : "앞으로 2시간"}`);
    if (!soon.length && !allDay.length) out.push("(없음)");
    for (const e of allDay) out.push(`- [종일] ${e.title}${e.rsvp === "needsAction" ? " · RSVP 안 함" : ""} ${u(e.url)}`);
    for (const e of soon) out.push(`- ${when(e.start)}–${hm(Date.parse(e.end))} ${e.title}${e.location ? ` @${clip(e.location, 40)}` : ""}${e.meet_url ? ` meet ${e.meet_url}` : ""} · 참석 ${e.attendees}명${e.rsvp === "needsAction" ? " · RSVP 안 함" : ""} ${u(e.url)}`);
    if (rsvp.length) {
      out.push("응답 안 한 초대:");
      for (const e of rsvp.slice(0, 8)) if (keep(e.url)) out.push(`- ${when(e.start)} ${e.title} ${u(e.url)}`);
    }
  }
  if (cfg.sources.slack) {
    out.push(`\n#### Slack (최근 ${cfg.history?.enabled !== false && (cfg.history?.keep_days?.slack ?? 0) > 0 ? cfg.history.display.slack_hours : 24}h, 나를 멘션·DM)`);
    const s = a.slack;
    if (!s) out.push("(아직 안 가져옴)");
    else {
      if (s.summary) out.push(`요약: ${s.summary}`);
      const items = s.items.filter((x) => keep(x.url));
      out.push(items.length ? "답 필요:" : "답 필요: (없음)");
      for (const x of items) out.push(`- [${x.reason}] ${x.channel} ${x.from}${x.count && x.count > 1 ? ` (+${x.count - 1})` : ""}: ${clip(x.text, 160)} (${when(x.ts)}) ${u(x.url)}`);
      const seen = new Set(s.items.map((x) => x.url));
      const rest = s.all.filter((x) => !x.answered && !seen.has(x.url) && keep(x.url)).slice(0, 8);
      if (rest.length) {
        out.push("그 밖에 답 안 한 멘션·DM:");
        for (const x of rest) out.push(`- [${x.reason}] ${x.channel} ${x.from}: ${clip(x.text, 120)} (${when(x.ts)}) ${u(x.url)}`);
      }
      for (const w of s.watch) {
        const hs = w.highlights.filter((h) => keep(h.url));
        if (!w.summary && !hs.length) continue;
        out.push(`팔로업 채널 ${w.channel}: ${clip(w.summary, 240) || "(요약 없음)"}`);
        for (const h of hs) out.push(`  - ${h.needs_me ? "[나 필요] " : ""}${h.from}: ${clip(h.text, 160)} — ${clip(h.reason, 80)} (${when(h.ts)}) ${u(h.url)}`);
      }
    }
  }
  if (cfg.sources.gmail) {
    out.push("\n#### 메일");
    const m = a.mail;
    if (!m) out.push("(아직 안 가져옴)");
    else {
      out.push(`안 읽은 메일(최근 2일): ${m.unread}${m.unread_capped ? "+" : ""}통${m.summary ? ` · 요약: ${m.summary}` : ""}`);
      const items = m.items.filter((x) => keep(x.url));
      out.push(items.length ? "내 행동 필요:" : "내 행동 필요: (없음)");
      for (const x of items) out.push(`- [${x.reason}] ${x.from} — ${clip(x.subject, 100)} · ${clip(x.why, 80)} (${when(x.received)}) ${u(x.url)}`);
    }
  }
  if (cfg.sources.jira) {
    out.push("\n#### Jira (나에게 할당, 열린 것)");
    const js = a.jira.filter((x) => keep(x.url));
    if (!js.length) out.push("(없음)");
    for (const x of js.slice(0, 20)) out.push(`- ${x.key} [${x.status}${x.priority ? `/${x.priority}` : ""}] ${clip(x.title, 100)}${x.due ? ` · 마감 ${x.due}` : ""} · 갱신 ${when(x.updated)} ${u(x.url)}`);
  }
  if (cfg.sources.github) {
    out.push("\n#### GitHub PR");
    const gs = a.github.filter((x) => keep(x.url));
    if (!gs.length) out.push("(없음)");
    for (const x of gs.slice(0, 15)) out.push(`- [${x.reason}] ${x.repo}#${x.number} ${clip(x.title, 100)} · ${x.author} · 갱신 ${when(x.updated)} ${u(x.url)}`);
  }
  if (skipped) out.push(`\n(이미 알린 항목 ${skipped}건은 뺐다)`);
  return out.join("\n");
}

/** {{FILTERS}}: agenda already applied the exclusions; this only guards Sentry and leftovers. */
function filtersLine(cfg: NedConfig): string {
  const ch = cfg.filters.slack.exclude_channels, pj = cfg.filters.jira.exclude_projects, w = cfg.sources.slack ? watchChannels(cfg.filters) : [];
  const parts: string[] = [];
  if (ch.length || pj.length) parts.push(`제외 채널 ${ch.map((c) => `#${c}`).join(", ") || "(없음)"} / 제외 Jira 프로젝트 ${pj.join(", ") || "(없음)"} — 섞여 있어도 보고하지 않는다`);
  if (w.length) parts.push(`팔로업 채널 ${w.map((c) => `#${c}`).join(", ")} — 위 Slack 의 "[나 필요]" 는 action_items, 채널에서 정해진 것은 updates (채널당 1줄)`);
  return parts.join("\n") || "(없음)";
}

// ---------- 맡긴 일 (config.responsibilities → prompt section, answer → state.json) ----------

const RESP_SOURCE_KO: Record<RespSource, string> = { slack: "Slack", mail: "메일", jira: "Jira", github: "GitHub", calendar: "캘린더", sessions: "세션" };
/** Responsibility source → the config.sources switch that feeds it (sessions: always there). */
const RESP_SOURCE_ON: Record<RespSource, (cfg: NedConfig) => boolean> = {
  slack: (c) => c.sources.slack, mail: (c) => c.sources.gmail, jira: (c) => c.sources.jira, github: (c) => c.sources.github, calendar: (c) => c.sources.calendar, sessions: () => true,
};
const RESP_STATUS_KO: Record<RespStatus, string> = { on_track: "on_track", watch: "watch", blocked: "blocked" };

/** {{RESPONSIBILITIES}}: one block per active responsibility (id, title, until, goal, where to look, keywords, last rating). */
export function responsibilitiesPrompt(cfg: NedConfig, list: Responsibility[], prev: State["responsibilities"] = {}, now = Date.now()): string {
  return list
    .map((r) => {
      const want = r.sources?.length ? r.sources : [...RESP_SOURCES];
      const on = want.filter((s) => RESP_SOURCE_ON[s](cfg));
      const lines = [`- id \`${r.id}\` · **${r.title}**${r.until ? ` (~${r.until}까지)` : ""}`];
      lines.push(`  - 챙길 것: ${r.goal || "(설명 없음 — 제목으로 판단)"}`);
      lines.push(`  - 볼 곳: ${on.length ? on.map((s) => RESP_SOURCE_KO[s]).join(", ") : "(켜진 소스 없음 — 세션·이벤트만)"}`);
      if (r.keywords?.length) lines.push(`  - 키워드: ${r.keywords.join(", ")}`);
      const p = prev?.[r.id];
      if (p) lines.push(`  - 지난 평가: ${RESP_STATUS_KO[p.status]} — ${clip(p.note, 160)} (${Math.max(0, Math.round((now - p.updated_at) / 60_000))}분 전)`);
      return lines.join("\n");
    })
    .join("\n");
}

/** Ratings only for ids still in config (a deleted responsibility's old rating must not come back with a re-created id). */
export function pruneResponsibilityRatings(prev: State["responsibilities"], known: readonly string[]): NonNullable<State["responsibilities"]> {
  const keep = new Set(known);
  return Object.fromEntries(Object.entries(prev ?? {}).filter(([id]) => keep.has(id)));
}

/**
 * The model's `responsibilities` answer over the previous state: entries for an unknown / inactive id, a bad status or a
 * repeated id are dropped; note → one line ≤ 300; urls → only ones in `allowed` (the url fields of the 업무 목록 entries the
 * model was shown; exact, else case-insensitive → the allowed spelling), deduped, ≤ 3. Responsibilities missing from the
 * answer keep their previous rating (and updated_at); ratings for ids no longer in config are dropped (`known`).
 */
export function applyResponsibilityReport(
  prev: State["responsibilities"],
  report: unknown,
  active: readonly Responsibility[],
  allowed: ReadonlySet<string>,
  now: number,
  known: readonly string[] = active.map((r) => r.id),
): NonNullable<State["responsibilities"]> {
  const out = pruneResponsibilityRatings(prev, known);
  const ids = new Set(active.map((r) => r.id));
  const lower = new Map([...allowed].map((u) => [u.toLowerCase(), u]));
  const seen = new Set<string>();
  for (const x of Array.isArray(report) ? report : []) {
    if (!x || typeof x !== "object") continue;
    const { id, status, note, urls } = x as Record<string, unknown>;
    if (typeof id !== "string" || !ids.has(id) || seen.has(id)) continue;
    if (!RESP_STATUSES.includes(status as RespStatus)) continue;
    seen.add(id);
    const links: string[] = [];
    for (const u of Array.isArray(urls) ? urls : []) {
      if (typeof u !== "string") continue;
      const t = u.trim();
      const hit = allowed.has(t) ? t : lower.get(t.toLowerCase());
      if (hit && !links.includes(hit)) links.push(hit);
      if (links.length >= 3) break;
    }
    out[id] = { status: status as RespStatus, note: clip(typeof note === "string" ? note : "", 300), urls: links, updated_at: now };
  }
  return out;
}

/** `{{#RESP}}…{{/RESP}}` blocks: kept (markers removed) when `on`, else cut out whole — the template then reads as before. */
export const respBlocks = (template: string, on: boolean) => template.replace(/\{\{#RESP\}\}([\s\S]*?)\{\{\/RESP\}\}/g, (_m, inner: string) => (on ? inner : ""));

export interface HeartbeatPrompt {
  prompt: string;
  /** The 맡긴 일 rated in this prompt (decided once here; the answer is stored against the same list). */
  active: Responsibility[];
  /** url fields of the 업무 목록 entries printed in {{AGENDA}} — what a rating may cite. */
  links: Set<string>;
}

/**
 * Render briefing.md / heartbeat.md with live inputs. Pure apart from reading the template, agenda.json and the sent log.
 * `template` / `now`: tests (render a fixed template text at a fixed time).
 */
export function renderHeartbeatPrompt(cfg: NedConfig, daily: boolean, state: State, events: NedEvent[], agenda: Agenda = readAgenda(), o: { template?: string; now?: Date } = {}): HeartbeatPrompt {
  const now = o.now ?? new Date();
  const active = activeResponsibilities(cfg, now);
  const on = active.length > 0;
  // No active 맡긴 일 → the blocks vanish and the prompt is exactly what it was before the feature (same cost).
  const template = respBlocks(o.template ?? fs.readFileSync(path.join(PROMPTS_DIR, daily ? "briefing.md" : "heartbeat.md"), "utf8"), on);
  const sent = sentKeys();
  const links = new Set<string>();
  const workers = new Set(state.sessions.filter(isWorker).map((s) => s.id));
  const sessions = state.sessions.filter((s) => !workers.has(s.id));
  // Function replacers: inputs may contain "$&"-style sequences that a string replacement would expand.
  const prompt = template
    .replace("{{RESPONSIBILITIES}}", () => responsibilitiesPrompt(cfg, active, state.responsibilities, now.getTime()))
    .replace("{{NOW}}", () => now.toLocaleString("ko-KR"))
    .replace("{{SOURCES}}", () => Object.entries(cfg.sources).filter(([, v]) => v).map(([k]) => k).join(", "))
    .replace("{{PERSONA}}", () => personaPrompt(cfg.persona))
    .replace("{{FILTERS}}", () => filtersLine(cfg))
    .replace("{{SENTRY}}", () => (cfg.sources.sentry ? "켜짐 — 아래 체크리스트대로 직접 조회" : "꺼짐 — 조회하지 않는다 (도구도 없음)"))
    // 맡긴 일 on: already-sent entries stay (tagged) so a raised blocker keeps its evidence on the next patrol.
    .replace("{{AGENDA}}", () => agendaDigest(cfg, agenda, on ? { daily, sent, markSent: true, links } : { daily, sent }))
    .replace("{{SESSIONS}}", () => (sessions.length ? sessions.map((s) => `- [${s.status}] ${s.worktree} — ${s.last_summary ?? s.last_prompt ?? ""}`).join("\n") : "(활성 세션 없음)"))
    .replace("{{EVENTS}}", () => summarizeEvents(events.filter((e) => !e.session_id || !workers.has(e.session_id))))
    .replace("{{ALREADY_SENT}}", () => [...sent].slice(-60).join("\n") || "(없음)");
  return { prompt, active, links };
}

/** renderHeartbeatPrompt's text only (`ned prompt heartbeat|briefing`, tests). */
export function buildHeartbeatPrompt(cfg: NedConfig, daily: boolean, state: State, events: NedEvent[], agenda: Agenda = readAgenda()): string {
  return renderHeartbeatPrompt(cfg, daily, state, events, agenda).prompt;
}

// ---------- check progress (POST /api/check, GET /api/check) ----------

export type CheckPhase = "agenda" | "judge";
export interface CheckStatus {
  running: boolean;
  phase: CheckPhase | null;
  daily: boolean;
  started_at: number | null;
  phase_started_at: number | null;
}
let progress: CheckStatus = { running: false, phase: null, daily: false, started_at: null, phase_started_at: null };
const setPhase = (phase: CheckPhase | null, daily = false) => {
  const t = Date.now();
  progress = phase
    ? { running: true, phase, daily, started_at: progress.running ? progress.started_at : t, phase_started_at: t }
    : { running: false, phase: null, daily: false, started_at: null, phase_started_at: null };
};
/** Where the running heartbeat is: "agenda" (waiting for agenda phase 1) → "judge" (claude -p). */
export function checkStatus(): CheckStatus {
  return { ...progress };
}

let checkInflight: Promise<Briefing | null> | null = null;
/** POST /api/check: agenda phase 1 (always) → heartbeat. Concurrent calls share one run. */
export function runCheck(cfg: NedConfig, opts: { daily?: boolean } = {}): Promise<Briefing | null> {
  if (checkInflight) return checkInflight;
  checkInflight = heartbeat(cfg, { force: true, daily: !!opts.daily, agenda: "always" }).finally(() => {
    checkInflight = null;
  });
  return checkInflight;
}

/** Make agenda.json fresh enough to judge from. Never throws: a failed refresh leaves the previous lists. */
async function ensureAgenda(cfg: NedConfig, mode: NonNullable<HeartbeatOptions["agenda"]>, daily: boolean): Promise<{ agenda: Agenda; refreshed: string }> {
  const prev = readAgenda();
  const age = Date.now() - (prev.updated_at || 0);
  const stale = age > cfg.signal_check_minutes * 60_000;
  const anySource = cfg.sources.calendar || cfg.sources.jira || cfg.sources.github || cfg.sources.gmail || cfg.sources.slack;
  const go = anySource && mode !== "skip" && (mode === "always" || stale || agendaBusy());
  if (!go) return { agenda: prev, refreshed: `reused (${Math.round(age / 60_000)}m old)` };
  setPhase("agenda", daily);
  const t0 = Date.now();
  const joined = agendaBusy();
  try {
    const a = await refreshAgenda(cfg);
    return { agenda: a, refreshed: `${joined ? "joined running refresh" : mode === "always" ? "refreshed" : `refreshed (was ${Math.round(age / 60_000)}m old)`} in ${Math.round((Date.now() - t0) / 1000)}s, $${(a.cost_usd ?? 0).toFixed(2)}` };
  } catch (e) {
    log(`heartbeat: agenda refresh failed — ${String(e).slice(0, 200)} (using previous lists)`);
    return { agenda: readAgenda(), refreshed: "refresh failed, reused" };
  }
}

/** Session events that make a heartbeat judge right away (a session stopped, failed or wants the user). */
const isSessionNews = (e: NedEvent) => ["Stop", "StopFailure", "Notification"].includes(e.event);

/** Unprocessed session-news events (scheduler skip-unchanged: any → the heartbeat runs). Read-only, no cursor commit. */
export function pendingSessionNews(): number {
  return readUnprocessedEvents().events.filter(isSessionNews).length;
}

/** One heartbeat: decide whether to think, then (maybe) ask Claude and publish a briefing. */
export async function heartbeat(cfg: NedConfig, opts: HeartbeatOptions = {}): Promise<Briefing | null> {
  refreshSessions(cfg);
  const state = readState();
  const { events, commit } = readUnprocessedEvents();
  const now = Date.now();
  const sinceLast = state.last_heartbeat_at ? now - state.last_heartbeat_at : Infinity;
  const signalDue = sinceLast >= cfg.signal_check_minutes * 60_000;
  const sessionNews = events.some(isSessionNews);

  if (!opts.force && !opts.daily && !signalDue && !sessionNews) {
    log(`heartbeat: nothing new (next signal check in ${Math.ceil((cfg.signal_check_minutes * 60_000 - sinceLast) / 60_000)}m) — silent`);
    return null;
  }

  const t0 = Date.now();
  let res;
  let refreshed = "";
  // 맡긴 일 rated in the prompt + the 업무 목록 links the model saw (the only ones a rating may cite) — reused when storing.
  let resp: Pick<HeartbeatPrompt, "active" | "links"> = { active: [], links: new Set() };
  try {
    const ag = await ensureAgenda(cfg, opts.agenda ?? "stale", !!opts.daily);
    refreshed = ag.refreshed;
    setPhase("judge", !!opts.daily);
    // State again: the agenda wait may have taken a minute and sessions moved on.
    const rendered = renderHeartbeatPrompt(cfg, !!opts.daily, readState(), events, ag.agenda);
    const prompt = rendered.prompt;
    resp = rendered;
    if (llmDisabled()) {
      log(`heartbeat: NED_NO_LLM=1 — skipping claude, recording ${process.env.NED_NO_LLM_RESULT ? "NED_NO_LLM_RESULT" : "NED_OK"} (agenda ${refreshed}, prompt ${prompt.length} chars)`);
      const delay = Number(process.env.NED_NO_LLM_DELAY_MS) || 0; // lets tests see the "judge" step
      if (delay) await new Promise((r) => setTimeout(r, delay));
      res = noLlmResult();
    } else {
      const ro = heartbeatRunOptions(cfg);
      log(`heartbeat: asking claude (${opts.daily ? "daily" : "heartbeat"}, ${events.length} new events, signalDue=${signalDue}, agenda ${refreshed}, prompt ${prompt.length} chars, tools ${ro.allowedTools.length ? ro.allowedTools.join(",") : "none"})`);
      res = await runClaude(prompt, { ...ro, model: cfg.claude_model, timeoutMs: 5 * 60_000, job: "heartbeat" });
    }
  } finally {
    setPhase(null);
  }
  const sent = sentKeys();
  const id = new Date().toISOString().replace(/[:.]/g, "-");

  const parsed = res.ok ? extractJson<LlmBriefing>(res.text) : null;
  const briefing: Briefing = {
    id,
    ts: now,
    type: opts.daily ? "daily" : "heartbeat",
    status: parsed?.status === "UPDATE" ? "UPDATE" : "NED_OK",
    headline: parsed?.headline,
    action_items: parsed?.action_items ?? [],
    updates: parsed?.updates ?? [],
    fyi: parsed?.fyi ?? [],
    sessions: parsed?.sessions ?? [],
    cost_usd: res.cost_usd,
    raw: res.ok && parsed ? undefined : res.text.slice(0, 4000),
    ok: res.ok && !!parsed,
  };
  if (!res.ok) log(`heartbeat: claude failed — ${res.error?.slice(0, 300)}`);
  else if (!parsed) log(`heartbeat: answer didn't parse as JSON — kept in raw (${res.text.length} chars)`);

  // Drop items already surfaced before, then record the new ones.
  const fresh = (xs: BriefingSection[]) => xs.filter((x) => !sent.has(keyOf(x)));
  briefing.action_items = fresh(briefing.action_items);
  briefing.updates = fresh(briefing.updates);
  briefing.fyi = fresh(briefing.fyi);
  const sentNow = [...briefing.action_items, ...briefing.updates, ...briefing.fyi].map(keyOf);
  if (!opts.daily && cfg.sources.slack) {
    // Deterministic, not left to the model: a reply after mine in a followed thread is always surfaced (once per reply).
    const th = threadAttention(readAgenda(), sent);
    // Same thread already reported by the model (any permalink into it) → don't add a second row.
    const reported = new Set(briefing.action_items.flatMap((x) => [(x.url ?? "").trim().toLowerCase(), threadKeyOf(x.url).toLowerCase()]).filter(Boolean));
    briefing.action_items.push(...th.items.filter((x) => !reported.has((x.url ?? "").trim().toLowerCase()) && !reported.has(threadKeyOf(x.url).toLowerCase())));
    sentNow.push(...th.keys); // the thread key only — not its url, so the model may still mention the thread later
    if (th.items.length && briefing.status !== "UPDATE") {
      briefing.status = "UPDATE";
      briefing.headline ??= `Slack 스레드에 내 답 이후 새 답글 ${th.items.length}건`;
    }
  }
  const hasContent = briefing.action_items.length + briefing.updates.length + briefing.fyi.length > 0;
  if (briefing.status === "UPDATE" && !hasContent && !opts.daily) briefing.status = "NED_OK";
  markSent(sentNow);

  writeJsonAtomic(path.join(BRIEFINGS_DIR, `${id}.json`), briefing);
  commit();
  // Obsidian 아카이브: briefing / UPDATE → write the day's report now; a quiet NED_OK only bumps the 순찰 count (tick flush).
  archiveTouch(now, { cfg, immediate: (briefing.type === "daily" && briefing.ok === true) || briefing.status === "UPDATE" });

  const next = readState();
  next.last_heartbeat_at = now;
  next.last_briefing = { id, ts: now, type: briefing.type, status: briefing.status, headline: briefing.headline, ok: briefing.ok };
  if (briefing.type === "daily" && briefing.ok) next.daily_failed_at = null; // a good morning briefing clears the 실패 line
  // 맡긴 일: stored whatever the status (NED_OK included) — silence applies to banners / action_items only. Every run drops
  // ratings of responsibilities no longer in config, even when the model sent none or none is configured.
  const known = cfg.responsibilities.map((r) => r.id);
  if (briefing.ok && parsed && resp.active.length && parsed.responsibilities !== undefined) {
    next.responsibilities = applyResponsibilityReport(next.responsibilities, parsed.responsibilities, resp.active, resp.links, Date.now(), known);
  } else if (next.responsibilities) {
    next.responsibilities = pruneResponsibilityRatings(next.responsibilities, known);
  }
  if (briefing.status === "UPDATE") {
    const items: AttentionItem[] = briefing.action_items.map((a, i) => ({
      id: `${id}:${i}`,
      kind: a.kind ?? "other",
      title: a.title,
      detail: a.detail,
      url: a.url,
      ts: now,
      source: id,
    }));
    next.attention = [...next.attention.filter((a) => a.source === "sessions"), ...items, ...next.attention.filter((a) => a.source !== "sessions")].slice(0, 30);
    notifyBriefing(cfg, briefing);
  }
  writeState(next);
  log(`heartbeat: ${briefing.status} (${briefing.action_items.length} action / ${briefing.updates.length} updates / ${briefing.fyi.length} fyi, $${res.cost_usd.toFixed(2)}, ${res.num_turns} turns, judge ${Math.round(res.duration_ms / 1000)}s, total ${Math.round((Date.now() - t0) / 1000)}s, agenda ${refreshed})`);
  return briefing;
}

/**
 * Daemon-side banners (osascript fallback; under Ned.app notify() only logs). Honours config.notifications:
 * enabled, per-kind switches, morning-briefing switch, summary_threshold (more items → one summary banner),
 * quiet_delivery (skip / silent during quiet hours) and sound.
 */
export function notifyBriefing(cfg: NedConfig, briefing: Briefing): void {
  const n = cfg.notifications;
  if (!n.enabled) return log("notify: off (notifications.enabled = false)");
  const quiet = inQuietHours(cfg);
  if (quiet && n.quiet_delivery === "skip") return log("notify: quiet hours — skipped (quiet_delivery = skip)");
  const sound = n.sound && !quiet;
  if (briefing.type === "daily") {
    if (n.briefing) notify("Ned · 아침 브리핑", briefing.headline ?? "오늘 브리핑이 준비됐어.", cfg.notify, { sound });
    else log("notify: morning briefing banner off (notifications.briefing = false)");
    return;
  }
  const kindOn = (k: string) => (k in n.kinds ? n.kinds[k as NotifyKind] : true); // "other" etc. follow the master switch
  const items = briefing.action_items.filter((a) => kindOn(a.kind ?? "other"));
  if (!items.length) return log(`notify: no banner — ${briefing.action_items.length ? "all action kinds switched off" : "no action items"}`);
  if (items.length > n.summary_threshold) {
    notify("Ned", `${items.length}건 확인 필요${briefing.headline ? ` — ${briefing.headline}` : ""}`, cfg.notify, { sound });
  } else {
    items.forEach((a, i) => notify(`Ned · ${a.kind ?? "other"}`, a.title, cfg.notify, { sound: sound && i === 0 }));
  }
}

/** Today's (local day) daily briefing that actually judged — failed ones (claude error / unparsable) don't count. */
export function hadGoodDailyOn(day: string, briefings: Briefing[] = listBriefings(50)): boolean {
  return briefings.some((b) => b.type === "daily" && briefingOk(b) && localDay(new Date(b.ts)) === day);
}

export function listBriefings(limit = 50): Briefing[] {
  if (!fs.existsSync(BRIEFINGS_DIR)) return [];
  return fs
    .readdirSync(BRIEFINGS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((f) => readJson<Briefing | null>(path.join(BRIEFINGS_DIR, f), null))
    .filter((b): b is Briefing => !!b);
}

export function dismissAttention(id: string): void {
  const s = readState();
  s.attention = s.attention.filter((a) => a.id !== id);
  writeState(s);
  // Session attention is regenerated every refresh — remember which alert was dismissed.
  const session = id.startsWith("session:") ? s.sessions.find((x) => `session:${x.id}` === id) : undefined;
  if (session?.alert_ts != null) {
    const now = Date.now();
    const d = Object.fromEntries(Object.entries(readDismissed()).filter(([, v]) => now - v.at < 7 * 24 * 60 * 60_000));
    d[id] = { alert_ts: session.alert_ts, at: now };
    writeJsonAtomic(DISMISSED_PATH, d);
  }
}
