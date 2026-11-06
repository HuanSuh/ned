import fs from "node:fs";
import YAML from "yaml";
import type { NotifyMode } from "./notify.js";
import { CONFIG_PATH } from "./paths.js";

export interface NedConfig {
  /** Minutes between heartbeats. */
  heartbeat_minutes: number;
  /** Minimum minutes between two LLM-backed signal checks when no session events arrived. */
  signal_check_minutes: number;
  /** Local time "HH:MM" for the daily briefing. */
  briefing_time: string;
  /** Quiet hours: no notifications (heartbeats still run). */
  quiet_hours: { start: string; end: string } | null;
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
  /** Agenda phase 2 stops (and won't start) once today's total `claude -p` spend (~/.ned/costs.json) reaches this. */
  agenda_daily_budget_usd: number;
  /** Model for every agenda `claude -p` (phase-1 per-source lists, phase-2 context batches); null = claude_model. */
  agenda_light_model: string | null;
  /** Dashboard home: source card order + width (1 = half row, 2 = full row) — Settings → 홈 카드 배치. */
  dashboard: NedDashboard;
}

export const DASHBOARD_CARDS = ["slack", "mail", "jira", "github"] as const;
export type DashboardCard = (typeof DASHBOARD_CARDS)[number];
/** Home panels on the free grid (≥1100px): 일정, the four source cards, 할 일. */
export const DASHBOARD_PANELS = ["cal", "slack", "mail", "jira", "github", "todo"] as const;
export type DashboardPanel = (typeof DASHBOARD_PANELS)[number];
/** A panel's cell on the 12-column grid: x/w in columns, y/h in row units. */
export interface PanelRect { x: number; y: number; w: number; h: number }
export const LAYOUT_COLS = 12;
/** Smallest size a panel may be resized to (columns × rows). */
export const PANEL_MIN: Record<DashboardPanel, { w: number; h: number }> = { cal: { w: 2, h: 4 }, todo: { w: 2, h: 3 }, slack: { w: 2, h: 2 }, mail: { w: 2, h: 2 }, jira: { w: 2, h: 2 }, github: { w: 2, h: 2 } };
export interface NedDashboard {
  card_order: DashboardCard[];
  card_span: Record<DashboardCard, 1 | 2>;
  /** Free-grid layout (drag / resize on home). null = not set yet: the dashboard derives it once from order/span and saves. */
  layout: Partial<Record<DashboardPanel, PanelRect>> | null;
  /** Home layout editing off (no drag / resize). */
  locked: boolean;
}
/** Slack first (most real-time), mail + Jira side by side, then GitHub. */
export const DEFAULT_DASHBOARD: NedDashboard = { card_order: ["slack", "mail", "jira", "github"], card_span: { slack: 2, mail: 1, jira: 1, github: 2 }, layout: null, locked: false };
/** What DEFAULT_DASHBOARD's order/span become on the free grid: 일정 3 | cards 6 | 할 일 3, 12 rows tall. */
export const DEFAULT_LAYOUT: Record<DashboardPanel, PanelRect> = {
  cal: { x: 0, y: 0, w: 3, h: 12 },
  slack: { x: 3, y: 0, w: 6, h: 4 },
  mail: { x: 3, y: 4, w: 3, h: 4 },
  jira: { x: 6, y: 4, w: 3, h: 4 },
  github: { x: 3, y: 8, w: 6, h: 4 },
  todo: { x: 9, y: 0, w: 3, h: 12 },
};

/** Known panels only, integer cells clamped into the grid (min size per panel, h ≤ 48, y ≤ 500); nothing valid → null. */
export function normalizeLayout(raw: unknown): NedDashboard["layout"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Partial<Record<DashboardPanel, PanelRect>> = {};
  for (const id of DASHBOARD_PANELS) {
    const v = (raw as Record<string, unknown>)[id] as Partial<Record<keyof PanelRect, unknown>> | undefined;
    if (!v || typeof v !== "object") continue;
    const n = (k: keyof PanelRect) => Number(v[k]);
    if (!(["x", "y", "w", "h"] as const).every((k) => Number.isFinite(n(k)))) continue;
    const m = PANEL_MIN[id];
    const w = Math.max(m.w, Math.min(LAYOUT_COLS, Math.trunc(n("w"))));
    const h = Math.max(m.h, Math.min(48, Math.trunc(n("h"))));
    out[id] = { x: Math.max(0, Math.min(LAYOUT_COLS - w, Math.trunc(n("x")))), y: Math.max(0, Math.min(500, Math.trunc(n("y")))), w, h };
  }
  return Object.keys(out).length ? out : null;
}

/** Known card ids only, each once; missing ones keep `base`'s relative order at the end. Spans are 1 | 2, else `base`'s.
 * layout: absent keeps `base`'s, null / junk clears it (→ re-derived by the dashboard); locked: boolean, else `base`'s. */
export function normalizeDashboard(raw: unknown, base: NedDashboard = DEFAULT_DASHBOARD): NedDashboard {
  const r = (raw && typeof raw === "object" ? raw : {}) as { card_order?: unknown; card_span?: unknown; layout?: unknown; locked?: unknown };
  const isCard = (v: unknown): v is DashboardCard => DASHBOARD_CARDS.includes(v as DashboardCard);
  const order = Array.isArray(r.card_order) ? [...new Set(r.card_order.filter(isCard))] : [...base.card_order];
  for (const id of base.card_order) if (!order.includes(id)) order.push(id);
  const spans = (r.card_span && typeof r.card_span === "object" ? r.card_span : {}) as Record<string, unknown>;
  const card_span = Object.fromEntries(DASHBOARD_CARDS.map((id) => [id, Number(spans[id]) === 1 || Number(spans[id]) === 2 ? Number(spans[id]) : base.card_span[id]])) as NedDashboard["card_span"];
  const layout = r.layout === undefined ? (base.layout ?? null) : normalizeLayout(r.layout);
  const locked = typeof r.locked === "boolean" ? r.locked : base.locked === true;
  return { card_order: order, card_span, layout, locked };
}

export interface NedActions {
  slack_send: boolean;
  gmail_draft: boolean;
  gmail_send: boolean;
  session_send: boolean;
  /** Wave 2 (all default off): Jira comment, Jira status transition, GitHub PR review/comment, Calendar RSVP. */
  jira_comment: boolean;
  jira_transition: boolean;
  github_review: boolean;
  calendar_rsvp: boolean;
}
export const DEFAULT_ACTIONS: NedActions = {
  slack_send: false,
  gmail_draft: true,
  gmail_send: false,
  session_send: true,
  jira_comment: false,
  jira_transition: false,
  github_review: false,
  calendar_rsvp: false,
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
  };
  /** Jira project keys, e.g. ["MNT", "IP2"]. */
  jira: { exclude_projects: string[] };
}

const uniq = (xs: string[]) => [...new Set(xs)];

/** Default `filters.slack.ack_reactions` (used when the key is absent; an explicit [] stays empty). */
export const DEFAULT_ACK_REACTIONS = ["white_check_mark", "eyes", "+1", "heavy_check_mark"];
/** At most this many ack emoji — each one is an extra Slack search per agenda run. */
export const ACK_REACTIONS_MAX = 8;

/** ":White_Check_Mark:" → "white_check_mark"; drops anything that can't be a Slack emoji name. */
export function normalizeAckReactions(v: unknown): string[] {
  if (v === undefined || v === null) return [...DEFAULT_ACK_REACTIONS];
  const list = typeof v === "string" ? v.split(/[,\s]+/) : strs(v);
  const names = list.map((e) => e.trim().replace(/^:+|:+$/g, "").toLowerCase()).filter((e) => /^[\p{Ll}\p{Lo}\p{N}_+'.-]{1,64}$/u.test(e));
  return uniq(names).slice(0, ACK_REACTIONS_MAX);
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Coerce whatever came from YAML / PUT into clean filters. Channel names lose a leading "#" and spaces;
 * Jira keys are upper-cased and must look like a project key (they are pasted into JQL verbatim).
 */
export function normalizeFilters(raw: unknown): NedFilters {
  const f = (raw && typeof raw === "object" ? raw : {}) as { slack?: { exclude_channels?: unknown; watch_channels?: unknown; ack_reactions?: unknown }; jira?: { exclude_projects?: unknown } };
  const chans = (v: unknown) => strs(v).map((c) => c.trim().replace(/^#+/, "").replace(/\s+/g, "")).filter((c) => c && c.length <= 80);
  const channels = chans(f.slack?.exclude_channels);
  const watch = chans(f.slack?.watch_channels);
  const projects = strs(f.jira?.exclude_projects).map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,19}$/.test(k));
  return { slack: { exclude_channels: uniq(channels), watch_channels: uniq(watch).slice(0, 20), ack_reactions: normalizeAckReactions(f.slack?.ack_reactions) }, jira: { exclude_projects: uniq(projects) } };
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

export const DEFAULT_CONFIG: NedConfig = {
  heartbeat_minutes: 10,
  signal_check_minutes: 60,
  briefing_time: "09:00",
  quiet_hours: { start: "23:00", end: "08:00" },
  sources: { gmail: true, slack: true, jira: true, github: true, sentry: true, calendar: true },
  persona: "ned",
  filters: { slack: { exclude_channels: [], watch_channels: [], ack_reactions: [...DEFAULT_ACK_REACTIONS] }, jira: { exclude_projects: [] } },
  port: 7777,
  claude_model: null,
  claude_max_turns: 25,
  session_stale_minutes: 180,
  agenda_refresh_minutes: 60,
  notify: "auto",
  notifications: DEFAULT_NOTIFICATIONS,
  actions: DEFAULT_ACTIONS,
  reply_tone: DEFAULT_REPLY_TONE,
  draft_context_max_age_minutes: 180,
  draft_fast_model: "sonnet",
  drafts_pregenerate: false,
  agenda_all_limit: 20,
  agenda_context_batch: 5,
  agenda_daily_budget_usd: 15,
  agenda_light_model: "sonnet",
  dashboard: DEFAULT_DASHBOARD,
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
    cfg = {
      ...DEFAULT_CONFIG,
      ...parsed,
      sources: { ...DEFAULT_CONFIG.sources, ...(parsed.sources ?? {}) },
      persona: normalizePersona(parsed.persona),
      notifications: normalizeNotifications(parsed.notifications),
      actions: normalizeActions(parsed.actions),
      reply_tone: normalizeReplyTone(parsed.reply_tone),
      draft_context_max_age_minutes: Number.isFinite(Number(parsed.draft_context_max_age_minutes)) && Number(parsed.draft_context_max_age_minutes) >= 0 ? Number(parsed.draft_context_max_age_minutes) : DEFAULT_CONFIG.draft_context_max_age_minutes,
      drafts_pregenerate: parsed.drafts_pregenerate === true,
      dashboard: normalizeDashboard(parsed.dashboard),
      agenda_all_limit: numIn(parsed.agenda_all_limit, 1, 50, DEFAULT_CONFIG.agenda_all_limit),
      agenda_context_batch: numIn(parsed.agenda_context_batch, 1, 10, DEFAULT_CONFIG.agenda_context_batch),
      agenda_daily_budget_usd: numIn(parsed.agenda_daily_budget_usd, 0, 10_000, DEFAULT_CONFIG.agenda_daily_budget_usd, false),
      agenda_light_model: parsed.agenda_light_model === null ? null : typeof parsed.agenda_light_model === "string" && parsed.agenda_light_model.trim() ? parsed.agenda_light_model.trim() : DEFAULT_CONFIG.agenda_light_model,
      filters: mergeFilters(normalizeFilters(DEFAULT_CONFIG.filters), parsed.filters),
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
  fs.writeFileSync(CONFIG_PATH, YAML.stringify(out));
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
