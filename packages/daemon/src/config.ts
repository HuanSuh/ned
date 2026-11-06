import fs from "node:fs";
import YAML from "yaml";
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
}

export const PERSONAS = ["ned", "alfred", "oracle", "jarvis"] as const;
export type PersonaId = (typeof PERSONAS)[number];
export const normalizePersona = (v: unknown): PersonaId => (PERSONAS.includes(v as PersonaId) ? (v as PersonaId) : "ned");

export interface NedFilters {
  /** Channel names without "#", e.g. ["random", "mobile_dev_casual"]. */
  slack: { exclude_channels: string[] };
  /** Jira project keys, e.g. ["MNT", "IP2"]. */
  jira: { exclude_projects: string[] };
}

const uniq = (xs: string[]) => [...new Set(xs)];
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/**
 * Coerce whatever came from YAML / PUT into clean filters. Channel names lose a leading "#" and spaces;
 * Jira keys are upper-cased and must look like a project key (they are pasted into JQL verbatim).
 */
export function normalizeFilters(raw: unknown): NedFilters {
  const f = (raw && typeof raw === "object" ? raw : {}) as { slack?: { exclude_channels?: unknown }; jira?: { exclude_projects?: unknown } };
  const channels = strs(f.slack?.exclude_channels).map((c) => c.trim().replace(/^#+/, "").replace(/\s+/g, "")).filter((c) => c && c.length <= 80);
  const projects = strs(f.jira?.exclude_projects).map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z][A-Z0-9_]{0,19}$/.test(k));
  return { slack: { exclude_channels: uniq(channels) }, jira: { exclude_projects: uniq(projects) } };
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

export const DEFAULT_CONFIG: NedConfig = {
  heartbeat_minutes: 10,
  signal_check_minutes: 60,
  briefing_time: "09:00",
  quiet_hours: { start: "23:00", end: "08:00" },
  sources: { gmail: true, slack: true, jira: true, github: true, sentry: true, calendar: true },
  persona: "ned",
  filters: { slack: { exclude_channels: [] }, jira: { exclude_projects: [] } },
  port: 7777,
  claude_model: null,
  claude_max_turns: 25,
  session_stale_minutes: 180,
  agenda_refresh_minutes: 60,
};

export function loadConfig(): NedConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify(DEFAULT_CONFIG));
    return { ...DEFAULT_CONFIG, filters: normalizeFilters(DEFAULT_CONFIG.filters) };
  }
  const parsed = (YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")) ?? {}) as Partial<NedConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    sources: { ...DEFAULT_CONFIG.sources, ...(parsed.sources ?? {}) },
    persona: normalizePersona(parsed.persona),
    filters: mergeFilters(normalizeFilters(DEFAULT_CONFIG.filters), parsed.filters),
  };
}

export function saveConfig(cfg: NedConfig): void {
  fs.writeFileSync(CONFIG_PATH, YAML.stringify(cfg));
}

export function inQuietHours(cfg: NedConfig, now = new Date()): boolean {
  if (!cfg.quiet_hours) return false;
  const toMin = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return h * 60 + m;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const start = toMin(cfg.quiet_hours.start);
  const end = toMin(cfg.quiet_hours.end);
  return start <= end ? cur >= start && cur < end : cur >= start || cur < end;
}
