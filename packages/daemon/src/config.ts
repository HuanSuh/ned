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

export const DEFAULT_CONFIG: NedConfig = {
  heartbeat_minutes: 10,
  signal_check_minutes: 60,
  briefing_time: "09:00",
  quiet_hours: { start: "23:00", end: "08:00" },
  sources: { gmail: true, slack: true, jira: true, github: true, sentry: true, calendar: true },
  port: 7777,
  claude_model: null,
  claude_max_turns: 25,
  session_stale_minutes: 180,
  agenda_refresh_minutes: 60,
};

export function loadConfig(): NedConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, YAML.stringify(DEFAULT_CONFIG));
    return { ...DEFAULT_CONFIG };
  }
  const parsed = (YAML.parse(fs.readFileSync(CONFIG_PATH, "utf8")) ?? {}) as Partial<NedConfig>;
  return { ...DEFAULT_CONFIG, ...parsed, sources: { ...DEFAULT_CONFIG.sources, ...(parsed.sources ?? {}) } };
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
