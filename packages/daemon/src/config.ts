import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { LINK_SERVICES, SLACK_TEAM_ID_RE, normalizeSlackTeamId, type LinkService } from "./links.js";
import type { NotifyMode } from "./notify.js";
import { CONFIG_PATH } from "./paths.js";

export interface NedConfig {
  /** Minutes between heartbeats. */
  heartbeat_minutes: number;
  /** Minimum minutes between two LLM-backed signal checks when no session events arrived. */
  signal_check_minutes: number;
  /**
   * Automatic heartbeats skip the claude call when nothing they judge from changed since the last one that ran (source list
   * signatures, calendar 2h window, unraised thread replies, session news) — src/scheduler.ts. Daily briefing / manual runs never skip.
   */
  heartbeat_skip_unchanged: boolean;
  /** Local time "HH:MM" for the daily briefing. */
  briefing_time: string;
  /** Quiet hours: no notifications (heartbeats still run). */
  quiet_hours: { start: string; end: string } | null;
  /** What automatic work does during quiet_hours: normal, slow (every interval × slow_factor) or pause. Manual runs are never affected. */
  quiet_schedule: QuietSchedule;
  /** Idle auto-slowdown: no user activity for after_minutes AND the last unchanged_runs automatic refreshes all unchanged. */
  idle_schedule: IdleSchedule;
  /** Which work-signal sources Ned may consult. */
  sources: { gmail: boolean; slack: boolean; jira: boolean; github: boolean; sentry: boolean; calendar: boolean };
  /** Voice + theme + mark set (prompts/personas/<id>.md, dashboard data-persona). Features/data don't change. */
  persona: PersonaId;
  /** Tracking exclusions: items in these Slack channels / Jira projects are never queried or reported. */
  filters: NedFilters;
  /** Dashboard port. */
  port: number;
  /** Extra args for `claude -p`. */
  claude_model: string | null;
  claude_max_turns: number;
  /** A session with no events for this many minutes is considered gone. */
  session_stale_minutes: number;
  /** Minutes between agenda (calendar/jira/github) refreshes for the dashboard HOME tab. */
  agenda_refresh_minutes: number;
  /** Per-source auto-refresh interval (minutes, 1..1440); null = agenda_refresh_minutes. */
  agenda_source_minutes: AgendaSourceMinutes;
  /** Briefing banners: `auto` = Ned.app when it spawned the daemon (`NED_NOTIFY=app`), else osascript. */
  notify: NotifyMode;
  /** What deserves a banner (read by Ned.app from state.json, and by the daemon's osascript fallback). */
  notifications: NedNotifications;
  /**
   * Outbound actions (POST /api/send). Ned is read-only except here, and only for switches that are on.
   * session_send types into a local Orca terminal (reversible) so it defaults on; the rest default off/draft-only.
   */
  actions: NedActions;
  /** Voice for reply drafts (POST /api/draft) — the USER's own voice, not the persona's. */
  reply_tone: string;
  /** Per-source reply voice (Slack / 메일 / 세션); null = reply_tone (the 기본 말투). */
  reply_tone_by_source: ReplyToneBySource;
  /** Agenda-collected Slack/mail context younger than this feeds the no-tool fast draft path; older → full (tool) path. */
  draft_context_max_age_minutes: number;
  /** Model for no-tool (fast) drafts, run with `--effort low`. Default "sonnet" (≈9s vs ≈12-15s on the default model); null = claude_model. */
  draft_fast_model: string | null;
  /** After each agenda run, pre-generate the 'normal' draft (fast path, max 6, sequential) for items that need a reply. */
  drafts_pregenerate: boolean;
  /** Agenda phase 1: max rows in mail.all[] / slack.all[] (the card's "전체" view). */
  agenda_all_limit: number;
  /** Agenda phase 2: reply-needing items per context-collection `claude -p` (narrow tools, ≤6 turns). */
  agenda_context_batch: number;
  /** Agenda phase 2: followed Slack threads re-read (slack_read_thread) per run, at most. */
  agenda_thread_batch: number;
  /** Agenda phase 2 stops (and won't start) once today's total `claude -p` spend (~/.ned/costs.json) reaches this. */
  agenda_daily_budget_usd: number;
  /** Model for every agenda `claude -p` (phase-1 per-source lists, phase-2 context batches); null = claude_model. */
  agenda_light_model: string | null;
  /** Dashboard home: source card order + width (1 = half row, 2 = full row) — Settings → 홈 카드 배치. */
  dashboard: NedDashboard;
  /** Ned 채팅 (POST /api/chat) runs even when today's spend ≥ agenda_daily_budget_usd. Default false: 429 over budget. */
  chat_ignore_budget: boolean;
  /** Obsidian 아카이브: the daemon writes a daily report + 정리 결과물 notes into a vault (no claude call). src/archive.ts. */
  archive: NedArchive;
  /** 수집 이력 (src/history.ts): what agenda collected, kept per source; Slack·메일 cards / patrol / drafts read their display window from it. */
  history: NedHistory;
}

export const HISTORY_SOURCES = ["slack", "mail", "jira", "github", "calendar"] as const;
export type HistorySource = (typeof HISTORY_SOURCES)[number];
export interface NedHistory {
  /** false = no history file is written and Slack·메일 show the latest snapshot only (the old behaviour). */
  enabled: boolean;
  /** 표시 구간: how far back the Slack·메일 cards, the patrol prompt and draft context look (1..168 h / 1..14 d). */
  display: { slack_hours: number; mail_days: number };
  /** 보관 기간 per source, whole days 0..365 (0 = don't record that source). Never below its display window. */
  keep_days: Record<HistorySource, number>;
  /** 수집 창: how far back a full Slack search (first run / every 6 h re-search / history off) looks, 1..168 h, ≥ display.slack_hours. */
  collect: { slack_hours: number };
}
export const DEFAULT_HISTORY: NedHistory = {
  enabled: true,
  display: { slack_hours: 24, mail_days: 3 },
  collect: { slack_hours: 24 },
  keep_days: { slack: 30, mail: 30, jira: 90, github: 90, calendar: 90 },
};

/**
 * Merge a (partial) history patch over `base`: enabled boolean; display clamped (slack 1..168 h, mail 1..14 d); keep_days
 * integers 0..365; collect.slack_hours 1..168 h, raised to display.slack_hours. Slack keep ≥ ceil(collect h / 24) days. A keep below its display window is raised to it (Slack: ceil(hours / 24) days) — 0 stays 0 (off).
 */
export function normalizeHistory(raw: unknown, base: NedHistory = DEFAULT_HISTORY): NedHistory {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const d = obj(r.display), k = obj(r.keep_days), c = obj(r.collect);
  const bd = base.display ?? DEFAULT_HISTORY.display, bk = base.keep_days ?? DEFAULT_HISTORY.keep_days, bc = base.collect ?? DEFAULT_HISTORY.collect;
  const int = (v: unknown, min: number, max: number, fb: number) => {
    const n = Number(v);
    return v == null || v === "" || typeof v === "boolean" || !Number.isFinite(n) ? fb : Math.max(min, Math.min(max, Math.round(n)));
  };
  const display = { slack_hours: int(d.slack_hours, 1, 168, bd.slack_hours), mail_days: int(d.mail_days, 1, 14, bd.mail_days) };
  // The full Slack window never shorter than what the card shows: incremental runs floor at it, so a short one would lose
  // the stretch the daemon slept through for good.
  const collect = { slack_hours: Math.max(display.slack_hours, int(c.slack_hours, 1, 168, bc.slack_hours ?? DEFAULT_HISTORY.collect.slack_hours)) };
  const keep_days = Object.fromEntries(HISTORY_SOURCES.map((s) => [s, int(k[s], 0, 365, bk[s] ?? DEFAULT_HISTORY.keep_days[s])])) as Record<HistorySource, number>;
  const floor: Partial<Record<HistorySource, number>> = { slack: Math.ceil(collect.slack_hours / 24), mail: display.mail_days };
  for (const [s, min] of Object.entries(floor) as [HistorySource, number][]) if (keep_days[s] > 0 && keep_days[s] < min) keep_days[s] = min;
  return { enabled: typeof r.enabled === "boolean" ? r.enabled : base.enabled !== false, display, keep_days, collect };
}

export interface NedArchive {
  enabled: boolean;
  /** Absolute vault path ("~/" expanded). Must be an existing directory outside ~/.ned and the repo (checked on save / write). */
  vault: string;
  /** Ned's folder inside the vault (relative, no ".."). */
  folder: string;
  /** Put an `![[…]]` embed of the day's report into the user's own daily note (only when that note already exists). */
  daily_embed: boolean;
  /** history = 데일리 리포트 "## 📥 들어온 것" (그날 처음 본 수집 이력 항목, src/history.ts). */
  include: { briefings: boolean; updates: boolean; actions: boolean; outputs: boolean; sessions: boolean; history: boolean };
}
export const DEFAULT_ARCHIVE: NedArchive = {
  enabled: false,
  vault: "",
  folder: "Ned",
  daily_embed: false,
  include: { briefings: true, updates: true, actions: true, outputs: true, sessions: false, history: true },
};

/** "Ned/", "/a//b/" → "Ned", "a/b"; "..", absolute-looking or control characters → `fallback`. Max 120 chars. */
export function normalizeArchiveFolder(v: unknown, fallback = DEFAULT_ARCHIVE.folder): string {
  if (typeof v !== "string") return fallback;
  const segs = v.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter((s) => s && s !== ".");
  if (!segs.length) return DEFAULT_ARCHIVE.folder;
  if (segs.some((s) => s === ".." || s.startsWith(".") || /[\u0000-\u001f:]/.test(s))) return fallback;
  const out = segs.join("/");
  return out.length <= 120 ? out : fallback;
}

/** Merge a (partial) archive patch over `base`; vault is trimmed and "~/" expanded (existence is checked elsewhere). */
export function normalizeArchive(raw: unknown, base: NedArchive = DEFAULT_ARCHIVE): NedArchive {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const inc = (r.include && typeof r.include === "object" && !Array.isArray(r.include) ? r.include : {}) as Record<string, unknown>;
  const bi = base.include ?? DEFAULT_ARCHIVE.include;
  let vault = base.vault ?? "";
  if (typeof r.vault === "string") {
    vault = r.vault.trim();
    if (vault === "~" || vault.startsWith("~/")) vault = path.join(os.homedir(), vault.slice(1));
    if (vault.length > 1 && /[\\/]$/.test(vault)) vault = vault.replace(/[\\/]+$/, "");
  } else if (r.vault === null) vault = "";
  return {
    enabled: bool(r.enabled, base.enabled),
    vault,
    folder: "folder" in r ? normalizeArchiveFolder(r.folder, base.folder) : base.folder,
    daily_embed: bool(r.daily_embed, base.daily_embed),
    include: { briefings: bool(inc.briefings, bi.briefings), updates: bool(inc.updates, bi.updates), actions: bool(inc.actions, bi.actions), outputs: bool(inc.outputs, bi.outputs), sessions: bool(inc.sessions, bi.sessions), history: bool(inc.history, bi.history ?? true) },
  };
}

export const DASHBOARD_CARDS = ["slack", "mail", "jira", "github"] as const;
export type DashboardCard = (typeof DASHBOARD_CARDS)[number];
/** A 팔로업 channel's own home card: `watch:<channel>` (channel as in filters.slack.watch_channels, no "#"). */
export const WATCH_PREFIX = "watch:";
export type WatchCardId = `watch:${string}`;
/** Any source card: the four fixed ones + one per followed channel. */
export type DashboardCardId = DashboardCard | WatchCardId;
/** Home panels on the free grid (≥1100px): 일정, the four source cards, 할 일 (+ watch cards, see WatchCardId). */
export const DASHBOARD_PANELS = ["cal", "slack", "mail", "jira", "github", "todo"] as const;
export type DashboardPanel = (typeof DASHBOARD_PANELS)[number];
/** A panel's cell on the 12-column grid: x/w in columns, y/h in row units. */
export interface PanelRect { x: number; y: number; w: number; h: number }
export const LAYOUT_COLS = 12;
/** Smallest size a panel may be resized to (columns × rows). */
export const PANEL_MIN: Record<DashboardPanel, { w: number; h: number }> = { cal: { w: 2, h: 4 }, todo: { w: 2, h: 3 }, slack: { w: 2, h: 2 }, mail: { w: 2, h: 2 }, jira: { w: 2, h: 2 }, github: { w: 2, h: 2 } };
export const WATCH_MIN = { w: 2, h: 2 };
export interface NedDashboard {
  /** Fixed cards first-class; `watch:<ch>` ids only for channels currently followed (watchChannels). */
  card_order: DashboardCardId[];
  card_span: Partial<Record<DashboardCardId, 1 | 2>> & Record<DashboardCard, 1 | 2>;
  /** Free-grid layout (drag / resize on home). null = not set yet: the dashboard derives it once from order/span and saves. */
  layout: Partial<Record<DashboardPanel | WatchCardId, PanelRect>> | null;
  /** Home layout editing off (no drag / resize). */
  locked: boolean;
  /** 팔로업 channels as their own home cards (true) or folded into the Slack card (false). */
  watch_cards: boolean;
  /** Dashboard colour theme → <html data-theme>: "system" follows the OS (prefers-color-scheme), light / dark force it. */
  theme: DashboardTheme;
  /** 링크를 앱으로 열기 (src/links.ts, public/app/features/openlink.js): Slack · Figma · Notion web links open in their app. */
  open_links_in_app: boolean;
  /** Per service, only while open_links_in_app is on. */
  open_links_in_app_by_service: Record<LinkService, boolean>;
  /** Slack workspace id ("T…", SLACK_TEAM_ID_RE) for slack:// deep links (src/links.ts). "" = Slack links stay on the web. */
  slack_team_id: string;
}
export const DEFAULT_OPEN_LINKS_BY_SERVICE: Record<LinkService, boolean> = { slack: true, figma: true, notion: true };
export const DASHBOARD_THEMES = ["system", "light", "dark"] as const;
export type DashboardTheme = (typeof DASHBOARD_THEMES)[number];
/** "system" | "light" | "dark"; anything else → "system". */
export const normalizeTheme = (v: unknown): DashboardTheme => (DASHBOARD_THEMES.includes(v as DashboardTheme) ? (v as DashboardTheme) : "system");
/** Slack first (most real-time), mail + Jira side by side, then GitHub. */
export const DEFAULT_DASHBOARD: NedDashboard = { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 }, layout: null, locked: false, watch_cards: true, theme: "system", open_links_in_app: true, open_links_in_app_by_service: DEFAULT_OPEN_LINKS_BY_SERVICE, slack_team_id: "" };
export const watchCardId = (channel: string): WatchCardId => `${WATCH_PREFIX}${channel}`;
/** What DEFAULT_DASHBOARD's order/span become on the free grid: 일정 3 | cards 6 | 할 일 3, 12 rows tall. */
export const DEFAULT_LAYOUT: Record<DashboardPanel, PanelRect> = {
  cal: { x: 0, y: 0, w: 3, h: 12 },
  slack: { x: 3, y: 0, w: 6, h: 4 },
  mail: { x: 3, y: 4, w: 3, h: 4 },
  jira: { x: 6, y: 4, w: 3, h: 4 },
  github: { x: 3, y: 8, w: 6, h: 4 },
  todo: { x: 9, y: 0, w: 3, h: 12 },
};

/**
 * `watch:<channel>` → the canonical id for a channel in `watch` (case-insensitive, "#" tolerated), else null.
 * Unknown / unfollowed channels have no card, so their ids are dropped.
 */
export function watchIdIn(id: unknown, watch: readonly string[]): WatchCardId | null {
  if (typeof id !== "string" || !id.startsWith(WATCH_PREFIX)) return null;
  const want = id.slice(WATCH_PREFIX.length).replace(/^#+/, "").toLowerCase();
  const ch = want ? watch.find((c) => c.toLowerCase() === want) : undefined;
  return ch ? watchCardId(ch) : null;
}

/** Known panels (+ `watch:` ids for channels in `watch`), integer cells clamped into the grid (min size per panel, h ≤ 48, y ≤ 500); nothing valid → null. */
export function normalizeLayout(raw: unknown, watch: readonly string[] = []): NedDashboard["layout"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: NonNullable<NedDashboard["layout"]> = {};
  const put = (id: DashboardPanel | WatchCardId, v: unknown, m: { w: number; h: number }) => {
    if (!v || typeof v !== "object") return;
    const n = (k: keyof PanelRect) => Number((v as Record<string, unknown>)[k]);
    if (!(["x", "y", "w", "h"] as const).every((k) => Number.isFinite(n(k)))) return;
    const w = Math.max(m.w, Math.min(LAYOUT_COLS, Math.trunc(n("w"))));
    const h = Math.max(m.h, Math.min(48, Math.trunc(n("h"))));
    out[id] = { x: Math.max(0, Math.min(LAYOUT_COLS - w, Math.trunc(n("x")))), y: Math.max(0, Math.min(500, Math.trunc(n("y")))), w, h };
  };
  for (const id of DASHBOARD_PANELS) put(id, (raw as Record<string, unknown>)[id], PANEL_MIN[id]);
  for (const [k, v] of Object.entries(raw)) {
    const id = watchIdIn(k, watch);
    if (id && !out[id]) put(id, v, WATCH_MIN);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Known card ids only, each once; missing fixed ones keep `base`'s relative order at the end, then any followed channel
 * (`watch`, = watchChannels(filters)) that has no `watch:<ch>` id yet. `watch:` ids for channels not in `watch` are dropped
 * (also from `base`, so removing a channel in settings removes its card). Spans are 1 | 2, else `base`'s (watch cards: 1).
 * layout: absent keeps `base`'s, null / junk clears it (→ re-derived by the dashboard); locked / watch_cards: boolean, else `base`'s.
 * theme: absent keeps `base`'s (partial PUTs such as the home lock don't reset it); any other value → "system".
 * open_links_in_app / open_links_in_app_by_service.<svc>: booleans, else `base`'s (default on).
 * slack_team_id: absent keeps `base`'s; "" / null clears; "t0abc123" → "T0ABC123"; anything else not a team id keeps `base`'s
 * (PUT /api/config rejects it first with a 400 — slackTeamIdError).
 */
export function normalizeDashboard(raw: unknown, base: NedDashboard = DEFAULT_DASHBOARD, watch: readonly string[] = []): NedDashboard {
  const r = (raw && typeof raw === "object" ? raw : {}) as { card_order?: unknown; card_span?: unknown; layout?: unknown; locked?: unknown; watch_cards?: unknown; theme?: unknown; open_links_in_app?: unknown; open_links_in_app_by_service?: unknown; slack_team_id?: unknown };
  const isCard = (v: unknown): v is DashboardCard => DASHBOARD_CARDS.includes(v as DashboardCard);
  const cardId = (v: unknown): DashboardCardId | null => (isCard(v) ? v : watchIdIn(v, watch));
  const ids = (xs: readonly unknown[]) => [...new Set(xs.map(cardId).filter((x): x is DashboardCardId => x !== null))];
  const order = ids(Array.isArray(r.card_order) ? r.card_order : base.card_order);
  for (const id of [...base.card_order, ...DASHBOARD_CARDS]) if (isCard(id) && !order.includes(id)) order.push(id);
  for (const id of ids([...base.card_order, ...watch.map(watchCardId)])) if (!order.includes(id)) order.push(id);
  const spans = (r.card_span && typeof r.card_span === "object" ? r.card_span : {}) as Record<string, unknown>;
  const baseSpans = Object.fromEntries(Object.entries(base.card_span ?? {}).map(([k, v]) => [cardId(k) ?? "", v]));
  const spanOf = (id: DashboardCardId): 1 | 2 => {
    const own = Object.entries(spans).find(([k]) => cardId(k) === id)?.[1];
    if (Number(own) === 1 || Number(own) === 2) return Number(own) as 1 | 2;
    const b = baseSpans[id];
    return b === 1 || b === 2 ? b : isCard(id) ? DEFAULT_DASHBOARD.card_span[id] : 1;
  };
  const card_span = Object.fromEntries(order.map((id) => [id, spanOf(id)])) as NedDashboard["card_span"];
  const layout = r.layout === undefined ? normalizeLayout(base.layout, watch) : normalizeLayout(r.layout, watch);
  const locked = typeof r.locked === "boolean" ? r.locked : base.locked === true;
  const watch_cards = typeof r.watch_cards === "boolean" ? r.watch_cards : base.watch_cards !== false;
  const theme = normalizeTheme(r.theme === undefined ? base.theme : r.theme);
  const baseTeam = normalizeSlackTeamId(base.slack_team_id);
  const slack_team_id = r.slack_team_id === undefined ? baseTeam : normalizeSlackTeamId(r.slack_team_id, baseTeam);
  const open_links_in_app = typeof r.open_links_in_app === "boolean" ? r.open_links_in_app : base.open_links_in_app !== false;
  const svcRaw = (r.open_links_in_app_by_service && typeof r.open_links_in_app_by_service === "object" && !Array.isArray(r.open_links_in_app_by_service) ? r.open_links_in_app_by_service : {}) as Record<string, unknown>;
  const open_links_in_app_by_service = Object.fromEntries(LINK_SERVICES.map((s) => [s, typeof svcRaw[s] === "boolean" ? svcRaw[s] : base.open_links_in_app_by_service?.[s] !== false])) as Record<LinkService, boolean>;
  return { card_order: order, card_span, layout, locked, watch_cards, theme, open_links_in_app, open_links_in_app_by_service, slack_team_id };
}

/** PUT /api/config: a non-empty dashboard.slack_team_id that isn't a team id → the error to show, else null. */
export function slackTeamIdError(dashboard: unknown): string | null {
  const v = dashboard && typeof dashboard === "object" ? (dashboard as { slack_team_id?: unknown }).slack_team_id : undefined;
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) return null;
  return typeof v === "string" && SLACK_TEAM_ID_RE.test(v.trim().toUpperCase()) ? null : "Slack 팀 ID 는 T 로 시작하는 영문 대문자·숫자(7자 이상)야 — 예: T0ABC1234";
}

export interface NedActions {
  slack_send: boolean;
  gmail_draft: boolean;
  gmail_send: boolean;
  /** 메일 확인 완료(체크) 시 Gmail 에서도 읽음 표시(UNREAD 라벨 제거). Off = 확인 완료만 (Ned 안에서만). Default off. */
  gmail_mark_read: boolean;
  session_send: boolean;
  /** Wave 2 (all default off): Jira comment, Jira status transition, GitHub PR review/comment, Calendar RSVP. */
  jira_comment: boolean;
  jira_transition: boolean;
  github_review: boolean;
  calendar_rsvp: boolean;
  /** New Google Calendar event from the 일정 card (POST /api/calendar/events). Default off. */
  calendar_create: boolean;
  /**
   * Ned Net 대화창 may PROPOSE writes (a ```ned-action block → 확인 카드). The model itself stays read-only; the card runs
   * the existing endpoints with origin "chat", and each kind still needs its own switch above. Default off.
   */
  chat_write: boolean;
  /** Ned 대화창이 제안한 새 에이전트 세션(Orca 워크트리 + claude + 첫 프롬프트)을 확인 후 시작 (POST /api/sessions/create). Default off. */
  chat_session_create: boolean;
}
export const DEFAULT_ACTIONS: NedActions = {
  slack_send: false,
  gmail_draft: true,
  gmail_send: false,
  gmail_mark_read: false,
  session_send: true,
  jira_comment: false,
  jira_transition: false,
  github_review: false,
  calendar_rsvp: false,
  calendar_create: false,
  chat_write: false,
  chat_session_create: false,
};
export const DEFAULT_REPLY_TONE = "간결하고 정중한 존댓말, 핵심 먼저";

/** Merge a (partial) actions patch over `base`; only real booleans are taken. */
export function normalizeActions(raw: unknown, base: NedActions = DEFAULT_ACTIONS): NedActions {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = (k: keyof NedActions) => (typeof r[k] === "boolean" ? (r[k] as boolean) : base[k]);
  return Object.fromEntries((Object.keys(DEFAULT_ACTIONS) as (keyof NedActions)[]).map((k) => [k, pick(k)])) as unknown as NedActions;
}

/** A non-empty string (trimmed, max 200 chars), else `fallback`. */
export function normalizeReplyTone(v: unknown, fallback = DEFAULT_REPLY_TONE): string {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : fallback;
}

export const REPLY_TONE_SOURCES = ["slack", "email", "session"] as const;
export type ReplyToneSource = (typeof REPLY_TONE_SOURCES)[number];
export type ReplyToneBySource = Record<ReplyToneSource, string | null>;
export const DEFAULT_REPLY_TONE_BY_SOURCE: ReplyToneBySource = { slack: null, email: null, session: null };

/** Merge a (partial) per-source tone patch over `base`: strings are trimmed (max 200), blank / null → null; absent keys keep `base`. */
export function normalizeReplyToneBySource(raw: unknown, base: ReplyToneBySource = DEFAULT_REPLY_TONE_BY_SOURCE): ReplyToneBySource {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const one = (k: ReplyToneSource): string | null => {
    if (!(k in r)) return base[k] ?? null;
    const v = r[k];
    return typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null;
  };
  return { slack: one("slack"), email: one("email"), session: one("session") };
}

export const PERSONAS = ["ned", "alfred", "oracle", "jarvis"] as const;
export type PersonaId = (typeof PERSONAS)[number];
export const normalizePersona = (v: unknown): PersonaId => (PERSONAS.includes(v as PersonaId) ? (v as PersonaId) : "ned");

export const NOTIFY_KINDS = ["session", "email", "slack", "jira", "github", "sentry", "calendar"] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];
export interface NedNotifications {
  enabled: boolean;
  kinds: Record<NotifyKind, boolean>;
  /** Banner for the morning briefing. */
  briefing: boolean;
  /** More than this many items at once → one summary banner instead of one per item. */
  summary_threshold: number;
  /** During quiet_hours: drop banners, or deliver them without sound. */
  quiet_delivery: "skip" | "silent";
  sound: boolean;
}
export const DEFAULT_NOTIFICATIONS: NedNotifications = {
  enabled: true,
  kinds: { session: true, email: true, slack: true, jira: true, github: true, sentry: true, calendar: true },
  briefing: true,
  summary_threshold: 3,
  quiet_delivery: "skip",
  sound: true,
};

/** Merge a (partial) notifications patch over `base` and coerce every field to its type. */
export function normalizeNotifications(raw: unknown, base: NedNotifications = DEFAULT_NOTIFICATIONS): NedNotifications {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof NedNotifications, unknown>>;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  const kr = (r.kinds && typeof r.kinds === "object" ? r.kinds : {}) as Record<string, unknown>;
  const kinds = Object.fromEntries(NOTIFY_KINDS.map((k) => [k, bool(kr[k], base.kinds[k])])) as Record<NotifyKind, boolean>;
  const th = Number(r.summary_threshold);
  return {
    enabled: bool(r.enabled, base.enabled),
    kinds,
    briefing: bool(r.briefing, base.briefing),
    summary_threshold: Number.isFinite(th) ? Math.max(0, Math.min(50, Math.trunc(th))) : base.summary_threshold,
    quiet_delivery: r.quiet_delivery === "silent" || r.quiet_delivery === "skip" ? r.quiet_delivery : base.quiet_delivery,
    sound: bool(r.sound, base.sound),
  };
}

export interface NedFilters {
  /** Channel names without "#", e.g. ["random", "mobile_dev_casual"]. */
  slack: {
    exclude_channels: string[];
    /** Channels followed even without a mention (agenda `slack.watch`, heartbeat). Excluded channels win. */
    watch_channels: string[];
    /**
     * Emoji names (no colons, lower-case, e.g. "white_check_mark", "+1"): a mention / DM / thread message I reacted to
     * with one of these counts as handled — out of agenda `slack.items`, `answered: true` in `all`, `needs_me: false`
     * in watch highlights. [] turns the check off (no extra `hasmy::emoji:` searches).
     */
    ack_reactions: string[];
    /** At most this many ack_reactions (from the front) are searched per agenda run (1..ACK_REACTIONS_MAX, default 3). */
    ack_check_max: number;
    /**
     * Slack user groups I belong to whose mentions also count (agenda `reason: "group"`): user-group IDs ("S0ABC123")
     * or handles without "@" ("mobile-dev"). [] = off (no extra search). At most GROUP_MENTIONS_MAX.
     */
    group_mentions: string[];
  };
  /** Jira project keys, e.g. ["MNT", "IP2"]. */
  jira: { exclude_projects: string[] };
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** Default `filters.slack.ack_reactions` (used when the key is absent; an explicit [] stays empty). */
export const DEFAULT_ACK_REACTIONS = ["white_check_mark", "eyes", "+1", "heavy_check_mark"];
/** At most this many ack emoji — each one is an extra Slack search per agenda run. */
export const ACK_REACTIONS_MAX = 8;
/** Default `filters.slack.ack_check_max`: emoji searched per run (the rest of ack_reactions is kept but not searched). */
export const ACK_CHECK_MAX_DEFAULT = 3;
const normalizeAckCheckMax = (v: unknown): number => {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? ACK_CHECK_MAX_DEFAULT : Math.max(1, Math.min(ACK_REACTIONS_MAX, Math.trunc(n)));
};

/** ":White_Check_Mark:" → "white_check_mark"; drops anything that can't be a Slack emoji name. */
export function normalizeAckReactions(v: unknown): string[] {
  if (v === undefined || v === null) return [...DEFAULT_ACK_REACTIONS];
  const list = typeof v === "string" ? v.split(/[,\s]+/) : strs(v);
  const names = list.map((e) => e.trim().replace(/^:+|:+$/g, "").toLowerCase()).filter((e) => /^[\p{Ll}\p{Lo}\p{N}_+'.-]{1,64}$/u.test(e));
  return uniq(names).slice(0, ACK_REACTIONS_MAX);
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** At most this many group mentions (one extra Slack search per group, same turn). */
export const GROUP_MENTIONS_MAX = 8;
/**
 * "@Mobile-Dev " → "mobile-dev" (handles lower-cased); "s0abc123" → "S0ABC123" (ID-shaped: s + 6+ alnum with a digit).
 * Deduped case-insensitively. Accepts a list or a comma / space separated string.
 */
export function normalizeGroupMentions(v: unknown): string[] {
  const list = typeof v === "string" ? v.split(/[,\s]+/) : strs(v);
  const out = list
    .map((e) => e.replace(/\s+/g, "").replace(/^@+/, ""))
    .filter((e) => /^[\p{L}\p{N}._-]{1,80}$/u.test(e))
    .map((e) => (/^s[a-z0-9]{6,}$/i.test(e) && /\d/.test(e) ? e.toUpperCase() : e.toLowerCase()));
  return uniq(out).slice(0, GROUP_MENTIONS_MAX);
}
/** User-group ID ("S0ABC123") vs. handle ("mobile-dev"). */
export const isGroupId = (g: string): boolean => /^S[A-Z0-9]{6,}$/.test(g) && /\d/.test(g);

/**
 * Coerce whatever came from YAML / PUT into clean filters. Channel names lose a leading "#" and spaces;
 * Jira keys are upper-cased and must look like a project key (they are pasted into JQL verbatim).
 */
export function normalizeFilters(raw: unknown): NedFilters {
  const f = (raw && typeof raw === "object" ? raw : {}) as { slack?: { exclude_channels?: unknown; watch_channels?: unknown; ack_reactions?: unknown; ack_check_max?: unknown; group_mentions?: unknown }; jira?: { exclude_projects?: unknown } };
  const chans = (v: unknown) => strs(v).map((c) => c.trim().replace(/^#+/, "").replace(/\s+/g, "")).filter((c) => c && c.length <= 80);
  const channels = chans(f.slack?.exclude_channels);
  const watch = chans(f.slack?.watch_channels);
  const projects = strs(f.jira?.exclude_projects).map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,19}$/.test(k));
  return { slack: { exclude_channels: uniq(channels), watch_channels: uniq(watch).slice(0, 20), ack_reactions: normalizeAckReactions(f.slack?.ack_reactions), ack_check_max: normalizeAckCheckMax(f.slack?.ack_check_max), group_mentions: normalizeGroupMentions(f.slack?.group_mentions) }, jira: { exclude_projects: uniq(projects) } };
}

/** Deep-merge a partial filters patch over the current filters (a key that is present replaces that list). */
export function mergeFilters(cur: NedFilters, patch: unknown): NedFilters {
  const p = (patch && typeof patch === "object" ? patch : {}) as { slack?: object; jira?: object };
  return normalizeFilters({ slack: { ...cur.slack, ...(p.slack ?? {}) }, jira: { ...cur.jira, ...(p.jira ?? {}) } });
}

/** `AND project NOT IN (A, B)` for JQL, or "" when nothing is excluded. */
export function jqlExclude(f: NedFilters): string {
  return f.jira.exclude_projects.length ? `AND project NOT IN (${f.jira.exclude_projects.join(", ")})` : "";
}

/** The {{FILTERS}} block shared by heartbeat / briefing / agenda prompts. */
export function filtersPrompt(f: NedFilters): string {
  const ch = f.slack.exclude_channels, pj = f.jira.exclude_projects;
  if (!ch.length && !pj.length) return "(없음)";
  const lines = [
    `제외 채널: ${ch.length ? ch.map((c) => `#${c}`).join(", ") : "(없음)"} / 제외 Jira 프로젝트: ${pj.length ? pj.join(", ") : "(없음)"} — 이들에 속한 항목은 조회·보고하지 말 것`,
  ];
  if (pj.length) lines.push(`  - Jira: 모든 JQL 에 \`${jqlExclude(f)}\` 를 직접 넣는다 (ORDER BY 가 있으면 그 앞에). 결과에 그 프로젝트 이슈가 섞여 있어도 버린다.`);
  if (ch.length) lines.push(`  - Slack: 검색 결과에서 위 채널(${ch.map((c) => `#${c}`).join(", ")})의 메시지와 스레드는 버린다. 그 채널을 따로 조회하지도 않는다.`);
  return lines.join("\n");
}

/** Watched channels minus excluded ones (case-insensitive) — what the agenda / heartbeat actually follow. */
export function watchChannels(f: NedFilters): string[] {
  const ex = new Set(f.slack.exclude_channels.map((c) => c.toLowerCase()));
  return (f.slack.watch_channels ?? []).filter((c) => !ex.has(c.toLowerCase()));
}

/** Heartbeat / briefing {{FILTERS}} addendum for watched channels; "" when none. */
export function watchPrompt(f: NedFilters): string {
  const w = watchChannels(f);
  if (!w.length) return "";
  return [
    `팔로업 채널: ${w.map((c) => `#${c}`).join(", ")} — 멘션이 없어도 최근 대화를 본다 (채널별 \`slack_search_public_and_private\` \`in:#채널\` 한 번, 읽기만).`,
    "  - 나에게 향한 듯한 질문·요청, 내 일에 영향을 주는 결정, 마감이 걸린 것 → `action_items` (kind `slack`, 원문 permalink 를 `url` 로).",
    "  - 그 밖에 채널에서 정해진 것·중요한 변화 → `updates` (kind `slack`, 채널당 1줄). 잡담·단순 공유는 버린다.",
  ].join("\n");
}

export const AGENDA_SOURCE_KEYS = ["slack", "mail", "calendar", "jira", "github"] as const;
export type AgendaSourceMinutes = Record<(typeof AGENDA_SOURCE_KEYS)[number], number | null>;
export const DEFAULT_AGENDA_SOURCE_MINUTES: AgendaSourceMinutes = { slack: null, mail: null, calendar: null, jira: null, github: null };

/** null / missing / non-numeric / ≤0 → null (= agenda_refresh_minutes); numbers clamp to 1..1440 (integer). */
function normalizeSourceMinute(v: unknown): number | null {
  if (v == null || v === "" || typeof v === "boolean") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1, Math.min(1440, Math.round(n)));
}

/** `patch` keys override `base` (a key missing from patch keeps base's value; an explicit null resets it). */
export function normalizeAgendaSourceMinutes(raw: unknown, base: AgendaSourceMinutes = DEFAULT_AGENDA_SOURCE_MINUTES): AgendaSourceMinutes {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(AGENDA_SOURCE_KEYS.map((k) => [k, k in o ? normalizeSourceMinute(o[k]) : base[k]])) as AgendaSourceMinutes;
}

export type QuietScheduleMode = "normal" | "slow" | "pause";
export interface QuietSchedule {
  mode: QuietScheduleMode;
  /** slow: multiply every automatic interval by this (2..24). */
  slow_factor: number;
}
export const DEFAULT_QUIET_SCHEDULE: QuietSchedule = { mode: "slow", slow_factor: 6 };

/** Unknown mode → base's; slow_factor clamps to 2..24 (integer); missing keys keep base. */
export function normalizeQuietSchedule(raw: unknown, base: QuietSchedule = DEFAULT_QUIET_SCHEDULE): QuietSchedule {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const mode = o.mode === "normal" || o.mode === "slow" || o.mode === "pause" ? o.mode : base.mode;
  const n = Number(o.slow_factor);
  const slow_factor = o.slow_factor == null || o.slow_factor === "" || typeof o.slow_factor === "boolean" || !Number.isFinite(n) ? base.slow_factor : Math.max(2, Math.min(24, Math.round(n)));
  return { mode, slow_factor };
}

export interface IdleSchedule {
  enabled: boolean;
  /** Minutes since the latest user activity (dashboard ping, Claude Code session event, macOS input) — 10..1440. */
  after_minutes: number;
  /** How many consecutive automatic refreshes must all come back unchanged — 1..50. */
  unchanged_runs: number;
  mode: "slow" | "pause";
  /** slow: multiply every automatic interval by this (2..24). */
  slow_factor: number;
}
export const DEFAULT_IDLE_SCHEDULE: IdleSchedule = { enabled: true, after_minutes: 120, unchanged_runs: 6, mode: "slow", slow_factor: 6 };

export function normalizeIdleSchedule(raw: unknown, base: IdleSchedule = DEFAULT_IDLE_SCHEDULE): IdleSchedule {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const int = (v: unknown, min: number, max: number, fb: number) => {
    const n = Number(v);
    return v == null || v === "" || typeof v === "boolean" || !Number.isFinite(n) ? fb : Math.max(min, Math.min(max, Math.round(n)));
  };
  return {
    enabled: typeof o.enabled === "boolean" ? o.enabled : base.enabled,
    after_minutes: int(o.after_minutes, 10, 1440, base.after_minutes),
    unchanged_runs: int(o.unchanged_runs, 1, 50, base.unchanged_runs),
    mode: o.mode === "slow" || o.mode === "pause" ? o.mode : base.mode,
    slow_factor: int(o.slow_factor, 2, 24, base.slow_factor),
  };
}

/** Effective auto-refresh interval for one source (minutes ≥ 1). */
export function sourceRefreshMinutes(cfg: Pick<NedConfig, "agenda_refresh_minutes" | "agenda_source_minutes">, k: keyof AgendaSourceMinutes): number {
  return cfg.agenda_source_minutes?.[k] ?? Math.max(1, cfg.agenda_refresh_minutes || DEFAULT_CONFIG.agenda_refresh_minutes);
}

export const DEFAULT_CONFIG: NedConfig = {
  heartbeat_minutes: 10,
  signal_check_minutes: 60,
  heartbeat_skip_unchanged: true,
  briefing_time: "09:00",
  quiet_hours: { start: "23:00", end: "08:00" },
  quiet_schedule: DEFAULT_QUIET_SCHEDULE,
  idle_schedule: DEFAULT_IDLE_SCHEDULE,
  sources: { gmail: true, slack: true, jira: true, github: true, sentry: true, calendar: true },
  persona: "ned",
  filters: { slack: { exclude_channels: [], watch_channels: [], ack_reactions: [...DEFAULT_ACK_REACTIONS], ack_check_max: ACK_CHECK_MAX_DEFAULT, group_mentions: [] }, jira: { exclude_projects: [] } },
  port: 7777,
  claude_model: null,
  claude_max_turns: 25,
  session_stale_minutes: 180,
  agenda_refresh_minutes: 60,
  agenda_source_minutes: DEFAULT_AGENDA_SOURCE_MINUTES,
  notify: "auto",
  notifications: DEFAULT_NOTIFICATIONS,
  actions: DEFAULT_ACTIONS,
  reply_tone: DEFAULT_REPLY_TONE,
  reply_tone_by_source: DEFAULT_REPLY_TONE_BY_SOURCE,
  draft_context_max_age_minutes: 180,
  draft_fast_model: "sonnet",
  drafts_pregenerate: false,
  agenda_all_limit: 20,
  agenda_context_batch: 5,
  agenda_thread_batch: 8,
  agenda_daily_budget_usd: 15,
  agenda_light_model: "sonnet",
  dashboard: DEFAULT_DASHBOARD,
  chat_ignore_budget: false,
  archive: DEFAULT_ARCHIVE,
  history: DEFAULT_HISTORY,
};

/** A finite number within [min, max] (truncated when `int`), else `fallback`. */
function numIn(v: unknown, min: number, max: number, fallback: number, int = true): number {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return fallback;
  const c = Math.max(min, Math.min(max, n));
  return int ? Math.trunc(c) : c;
}

export function loadConfig(): NedConfig {
  let cfg: NedConfig;
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify(DEFAULT_CONFIG));
    cfg = { ...DEFAULT_CONFIG, filters: normalizeFilters(DEFAULT_CONFIG.filters) };
  } else {
    const parsed = (YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")) ?? {}) as Partial<NedConfig>;
    const filters = mergeFilters(normalizeFilters(DEFAULT_CONFIG.filters), parsed.filters);
    cfg = {
      ...DEFAULT_CONFIG,
      ...parsed,
      sources: { ...DEFAULT_CONFIG.sources, ...(parsed.sources ?? {}) },
      persona: normalizePersona(parsed.persona),
      notifications: normalizeNotifications(parsed.notifications),
      actions: normalizeActions(parsed.actions),
      reply_tone: normalizeReplyTone(parsed.reply_tone),
      reply_tone_by_source: normalizeReplyToneBySource(parsed.reply_tone_by_source),
      draft_context_max_age_minutes: Number.isFinite(Number(parsed.draft_context_max_age_minutes)) && Number(parsed.draft_context_max_age_minutes) >= 0 ? Number(parsed.draft_context_max_age_minutes) : DEFAULT_CONFIG.draft_context_max_age_minutes,
      drafts_pregenerate: parsed.drafts_pregenerate === true,
      heartbeat_skip_unchanged: parsed.heartbeat_skip_unchanged !== false,
      chat_ignore_budget: parsed.chat_ignore_budget === true,
      archive: normalizeArchive(parsed.archive),
      history: normalizeHistory(parsed.history),
      dashboard: normalizeDashboard(parsed.dashboard, DEFAULT_DASHBOARD, watchChannels(filters)),
      agenda_source_minutes: normalizeAgendaSourceMinutes(parsed.agenda_source_minutes),
      quiet_schedule: normalizeQuietSchedule(parsed.quiet_schedule),
      idle_schedule: normalizeIdleSchedule(parsed.idle_schedule),
      agenda_all_limit: numIn(parsed.agenda_all_limit, 1, 50, DEFAULT_CONFIG.agenda_all_limit),
      agenda_context_batch: numIn(parsed.agenda_context_batch, 1, 10, DEFAULT_CONFIG.agenda_context_batch),
      agenda_thread_batch: numIn(parsed.agenda_thread_batch, 0, 20, DEFAULT_CONFIG.agenda_thread_batch),
      agenda_daily_budget_usd: numIn(parsed.agenda_daily_budget_usd, 0, 10_000, DEFAULT_CONFIG.agenda_daily_budget_usd, false),
      agenda_light_model: parsed.agenda_light_model === null ? null : typeof parsed.agenda_light_model === "string" && parsed.agenda_light_model.trim() ? parsed.agenda_light_model.trim() : DEFAULT_CONFIG.agenda_light_model,
      filters,
    };
  }
  const envPort = portOverride();
  return envPort ? { ...cfg, port: envPort } : cfg;
}

/** `NED_PORT` env overrides `config.yaml`'s port (used by Ned.app and tests). Never persisted. */
function portOverride(): number | null {
  const n = Number(process.env.NED_PORT);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

export function saveConfig(cfg: NedConfig): void {
  let out = cfg;
  if (portOverride() && fs.existsSync(CONFIG_PATH)) {
    // Keep the file's own port: the env override is per-process, not a setting.
    const onDisk = (YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")) ?? {}) as Partial<NedConfig>;
    out = { ...cfg, port: onDisk.port ?? DEFAULT_CONFIG.port };
  }
  backupConfigFile();
  fs.writeFileSync(CONFIG_PATH, YAML.stringify(out));
  stampConfig();
}

// ---------- updated_at: the version token for PUT /api/config's if_updated_at ----------
let lastStamp = 0;
/**
 * After a save: set the file's mtime to a fresh, strictly increasing whole ms, so configUpdatedAt() changes on every
 * save (even two within one ms) while a hand edit of config.yaml (new mtime) still reads as a change.
 */
function stampConfig(): void {
  const now = Math.max(Date.now(), lastStamp + 1, Math.floor(configUpdatedAt()) + 1);
  lastStamp = now;
  try { fs.utimesSync(CONFIG_PATH, new Date(now), new Date(now)); } catch { /* the mtime still moved with the write */ }
}
/** config.yaml's mtime in whole ms (0 when missing). Changes on every saveConfig and on any hand edit. */
export function configUpdatedAt(): number {
  try { return Math.floor(fs.statSync(CONFIG_PATH).mtimeMs); } catch { return 0; }
}

// ---------- backups: ~/.ned/config-backups/config-<ISO>.yaml, newest CONFIG_BACKUP_KEEP kept ----------
export const CONFIG_BACKUP_KEEP = 10;
const BACKUP_RE = /^config-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.yaml$/;
export const configBackupDir = () => path.join(path.dirname(CONFIG_PATH), "config-backups");
export interface ConfigBackup { name: string; at: number; size: number }

/** Copy the current config.yaml (if any) into the backup dir, then drop all but the newest CONFIG_BACKUP_KEEP. */
export function backupConfigFile(): string | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  const dir = configBackupDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stem = `config-${new Date().toISOString().replace(/:/g, "-").replace(".", "-")}`;
    let name = `${stem}.yaml`;
    for (let i = 1; fs.existsSync(path.join(dir, name)); i++) name = `${stem}-${i}.yaml`;
    fs.copyFileSync(CONFIG_PATH, path.join(dir, name));
    for (const old of listConfigBackups().slice(CONFIG_BACKUP_KEEP)) fs.rmSync(path.join(dir, old.name), { force: true });
    return name;
  } catch {
    return null; // a backup failure never blocks the save itself
  }
}

/** Newest first (by the time in the name, then file mtime). */
export function listConfigBackups(): ConfigBackup[] {
  const dir = configBackupDir();
  let names: string[];
  try { names = fs.readdirSync(dir).filter((n) => BACKUP_RE.test(n)); } catch { return []; }
  return names
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      const iso = name.replace(/^config-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*$/, "$1T$2:$3:$4.$5Z");
      const at = Date.parse(iso);
      return { name, at: Number.isFinite(at) ? at : Math.floor(st.mtimeMs), size: st.size };
    })
    .sort((a, b) => b.at - a.at || b.name.localeCompare(a.name, "en", { numeric: true }));
}

/** Restore a backup (by exact name from listConfigBackups) over config.yaml — the current file is backed up first. */
export function restoreConfigBackup(name: unknown): NedConfig {
  if (typeof name !== "string" || !BACKUP_RE.test(name)) throw new Error("bad backup name");
  const file = path.join(configBackupDir(), name);
  if (!fs.existsSync(file)) throw new Error("no such backup");
  const parsed = YAML.parse(fs.readFileSync(file, "utf8")) ?? {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("backup is not a config");
  saveConfig(parsed as NedConfig); // backs up the current file, keeps the file's port under NED_PORT
  return loadConfig();
}

// ---------- PUT /api/config: deep merge + change log ----------
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** `patch` over `base`: plain objects merge key by key (recursively), anything else (arrays, null, scalars) replaces. Keys absent from `patch` are kept. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || UNSAFE_KEYS.has(k)) continue; // a JSON body can carry "__proto__" as an own key
    out[k] = isPlain(out[k]) && isPlain(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Leaf-level differences (`a.b.c`), arrays compared whole. */
export function configChanges(before: unknown, after: unknown, prefix = ""): Array<{ key: string; from: unknown; to: unknown }> {
  if (isPlain(before) && isPlain(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return keys.flatMap((k) => configChanges(before[k], after[k], prefix ? `${prefix}.${k}` : k));
  }
  return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ key: prefix, from: before, to: after }];
}

/** One log value: strings as-is, the rest as JSON; clamped to 200 chars. */
export function logValue(v: unknown): string {
  const s = v === undefined ? "(없음)" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 200 ? `${s.slice(0, 199)}…` : s;
}

export function inQuietHours(cfg: NedConfig, now = new Date()): boolean {
  if (!cfg.quiet_hours) return false;
  // Tolerate a hand-edited config: a missing/invalid "HH:MM" disables quiet hours instead of throwing.
  const toMin = (s: unknown): number | null => {
    if (typeof s !== "string" || !/^\d{1,2}:\d{2}$/.test(s.trim())) return null;
    const [h, m] = s.trim().split(":").map(Number);
    return h * 60 + m;
  };
  const start = toMin(cfg.quiet_hours.start);
  const end = toMin(cfg.quiet_hours.end);
  if (start === null || end === null) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
