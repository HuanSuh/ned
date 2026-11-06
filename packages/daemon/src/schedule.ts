/**
 * Per-source agenda auto-refresh schedule (pure, so it's unit-testable). The daemon ticks every minute and refreshes
 * the sources that are due in one refreshAgenda({ sources }) call.
 *
 * A source's last run = the later of what the scheduler started and sources_status[k].started_at in agenda.json,
 * so a manual card refresh (POST /api/agenda/refresh) pushes that source's next automatic run back too.
 * Interval = config.agenda_source_minutes[k] ?? agenda_refresh_minutes, read on every tick (a settings change applies
 * at the next tick, measured from the last run).
 */
import type { AgendaSourceKey } from "./agenda.js";
import { sourceRefreshMinutes, type NedConfig } from "./config.js";

export type SourceTimes = Partial<Record<AgendaSourceKey, number>>;

/** A tick a few seconds early still counts (setInterval drifts; otherwise a 60m source would wait 61m). */
export const DUE_SLACK_MS = 5_000;

/** Last run per source: the later of the scheduler's own start time and agenda.json's sources_status started_at. */
export function lastRuns(scheduled: SourceTimes, status: Partial<Record<AgendaSourceKey, { started_at?: number; updated_at?: number }>> | undefined, keys: readonly AgendaSourceKey[]): SourceTimes {
  const out: SourceTimes = {};
  for (const k of keys) {
    const t = Math.max(scheduled[k] ?? 0, status?.[k]?.started_at ?? 0);
    if (t > 0) out[k] = t;
  }
  return out;
}

/** next_due_at per source (ms). A source never run is due now. */
export function nextDueAt(cfg: Pick<NedConfig, "agenda_refresh_minutes" | "agenda_source_minutes">, keys: readonly AgendaSourceKey[], last: SourceTimes, now: number): SourceTimes {
  const out: SourceTimes = {};
  for (const k of keys) out[k] = last[k] == null ? now : last[k]! + sourceRefreshMinutes(cfg, k) * 60_000;
  return out;
}

/** Sources (of `enabled`, minus ones already running) whose next_due_at has come. Order follows `enabled`. */
export function dueSources(
  cfg: Pick<NedConfig, "agenda_refresh_minutes" | "agenda_source_minutes">,
  enabled: readonly AgendaSourceKey[],
  last: SourceTimes,
  now: number,
  running: readonly AgendaSourceKey[] = [],
): AgendaSourceKey[] {
  const next = nextDueAt(cfg, enabled, last, now);
  return enabled.filter((k) => !running.includes(k) && now + DUE_SLACK_MS >= next[k]!);
}
