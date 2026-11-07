/**
 * Automatic-work scheduler: one 1-minute tick drives the heartbeat (순찰) and the per-source agenda refresh, and stretches
 * (slow: every interval × factor) or pauses them during quiet hours (config.quiet_schedule) and while idle
 * (config.idle_schedule). Phase 2 (reply context / threads) only follows a phase-1 run, so it slows down with it.
 *
 * Manual runs — POST /api/check, /api/heartbeat, /api/agenda/refresh (card ↻) — never go through here: always immediate.
 *
 * Heartbeat skip-unchanged (config.heartbeat_skip_unchanged, default on): an automatic, non-daily heartbeat is skipped
 * (no claude call; next_heartbeat_at still advances) when every enabled source's list signature and the heartbeat watch
 * key (calendar 2h window, unraised thread replies) equal those at the last heartbeat that judged, and no session event
 * is pending. With Sentry on, a real run still happens at least every HEARTBEAT_SKIP_MAX_MINUTES.
 *
 * Idle = BOTH (1) no user activity for idle_schedule.after_minutes (latest of: dashboard activity ping, Claude Code
 * session event, macOS HID input) AND (2) the last unchanged_runs automatic refreshes all came back unchanged.
 * Quiet + idle overlapping → the slower one wins (pause > larger factor).
 * When quiet hours end / idle ends: every source refreshes at once, then one heartbeat (so a morning briefing that is
 * already due reads fresh lists).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { AgendaSourceKey } from "./agenda.js";
import { inQuietHours, sourceRefreshMinutes as sourceMinutes, type IdleSchedule, type NedConfig, type QuietScheduleMode } from "./config.js";
import { EVENTS_DIR, localDay } from "./paths.js";
import { DUE_SLACK_MS, dueSources, lastRuns, type SourceTimes } from "./schedule.js";

// ---------- pure parts ----------

export interface QuietStatus {
  /** Inside config.quiet_hours right now (regardless of mode). */
  active: boolean;
  mode: QuietScheduleMode;
  /** quiet_hours.end ("HH:MM") — when automatic work resumes; null when quiet hours are off. */
  until: string | null;
  /** Interval multiplier while active: slow → slow_factor, otherwise 1. */
  factor: number;
}

export function quietStatus(cfg: Pick<NedConfig, "quiet_hours" | "quiet_schedule">, now = new Date()): QuietStatus {
  const mode = cfg.quiet_schedule?.mode ?? "slow";
  return {
    active: inQuietHours(cfg as NedConfig, now),
    mode,
    until: cfg.quiet_hours?.end ?? null,
    factor: mode === "slow" ? cfg.quiet_schedule.slow_factor : 1,
  };
}

/** Idle verdict from the two signals. `recentRuns`: oldest → newest, true = that automatic refresh was all-unchanged. */
export function idleVerdict(sched: IdleSchedule, lastActivityAt: number, recentRuns: readonly boolean[], now: number): { idle: boolean; reason: string } {
  if (!sched.enabled) return { idle: false, reason: "disabled" };
  const quietMin = Math.max(0, Math.floor((now - lastActivityAt) / 60_000));
  const noActivity = now - lastActivityAt >= sched.after_minutes * 60_000;
  const tail = recentRuns.slice(-sched.unchanged_runs);
  const unchanged = tail.length >= sched.unchanged_runs && tail.every(Boolean);
  const actTxt = `활동 없음 ${quietMin}분`;
  const runTxt = unchanged ? `연속 무변경 ${sched.unchanged_runs}회` : `무변경 ${trailingTrue(recentRuns)}/${sched.unchanged_runs}회`;
  return { idle: noActivity && unchanged, reason: `${actTxt} · ${runTxt}` };
}

const trailingTrue = (xs: readonly boolean[]): number => {
  let n = 0;
  for (let i = xs.length - 1; i >= 0 && xs[i]; i--) n++;
  return n;
};

export interface IdleStatus {
  active: boolean;
  /** ms when idle began; null when not idle. */
  since: number | null;
  reason: string;
  mode: IdleSchedule["mode"];
  factor: number;
}

export interface Throttle {
  pause: boolean;
  /** Interval multiplier (1 = as configured). */
  factor: number;
  /** What is throttling: null = nothing. */
  by: "quiet" | "idle" | null;
}

/** Quiet and idle together → the slower one: pause beats slow; between two slows, the larger factor. */
export function combineThrottle(quiet: Pick<QuietStatus, "active" | "mode" | "factor">, idle: Pick<IdleStatus, "active" | "mode" | "factor">): Throttle {
  const cands: Throttle[] = [];
  if (quiet.active && quiet.mode === "pause") cands.push({ pause: true, factor: 1, by: "quiet" });
  if (idle.active && idle.mode === "pause") cands.push({ pause: true, factor: 1, by: "idle" });
  if (quiet.active && quiet.mode === "slow") cands.push({ pause: false, factor: Math.max(1, quiet.factor), by: "quiet" });
  if (idle.active && idle.mode === "slow") cands.push({ pause: false, factor: Math.max(1, idle.factor), by: "idle" });
  const p = cands.find((c) => c.pause);
  if (p) return p;
  return cands.reduce<Throttle>((a, c) => (c.factor > a.factor ? c : a), { pause: false, factor: 1, by: null });
}

/** Heartbeat due: never run, or heartbeat_minutes × factor since the last automatic run (a few seconds' slack). */
export function heartbeatDue(lastAt: number | null, minutes: number, factor: number, now: number): boolean {
  return lastAt == null || now + DUE_SLACK_MS >= lastAt + Math.max(1, minutes) * Math.max(1, factor) * 60_000;
}

// ---------- activity signals ----------

let pingAt = 0;
let wake: (() => void) | null = null;

/** Dashboard activity ping (POST /api/activity, GET /api/state?visible=1). Ends idle right away. */
export function noteActivity(at = Date.now()): void {
  pingAt = Math.max(pingAt, at);
  wake?.();
}
export const lastPingAt = (): number => pingAt;

/** Latest Claude Code session event: mtime of the newest events/*.jsonl (0 when none). */
export function eventsActivityAt(dir = EVENTS_DIR): number {
  try {
    let max = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".jsonl")) continue;
      const m = fs.statSync(path.join(dir, f)).mtimeMs;
      if (m > max) max = m;
    }
    return max;
  } catch {
    return 0;
  }
}

/** `ioreg -c IOHIDSystem` output → ms since the last keyboard / mouse input (HIDIdleTime is ns); null when absent. */
export function parseHidIdle(out: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
  return m ? Math.floor(Number(m[1]) / 1e6) : null;
}

/** macOS input idle (ms), or null when unavailable (non-darwin, NED_NO_HID=1, ioreg failed). */
export function hidIdleMs(): Promise<number | null> {
  if (process.platform !== "darwin" || process.env.NED_NO_HID === "1") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("ioreg", ["-c", "IOHIDSystem"], { timeout: 3_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : parseHidIdle(String(stdout))));
  });
}

// ---------- status shared with the server ----------

const IDLE_OFF: IdleStatus = { active: false, since: null, reason: "", mode: "slow", factor: 1 };
let idleNow: IdleStatus = IDLE_OFF;

/** For GET /api/state and /api/agenda: quiet computed live from config, idle from the running scheduler. */
export function schedulerStatus(cfg: Pick<NedConfig, "quiet_hours" | "quiet_schedule">, now = new Date()): { quiet: QuietStatus; idle: IdleStatus } {
  return { quiet: quietStatus(cfg, now), idle: idleNow };
}

// ---------- the scheduler ----------

export interface SchedulerDeps {
  now?: () => number;
  loadConfig: () => NedConfig;
  /** Daily budget gate for automatic runs (logs on its own). */
  overBudget: (cfg: NedConfig, job: string) => boolean;
  enabledSources: (cfg: NedConfig) => AgendaSourceKey[];
  runningSources: () => AgendaSourceKey[];
  sourcesStatus: () => Partial<Record<AgendaSourceKey, { started_at?: number; unchanged?: boolean; signature?: string }>> | undefined;
  refreshAgenda: (cfg: NedConfig, sources: AgendaSourceKey[]) => Promise<unknown>;
  heartbeat: (cfg: NedConfig, opts: { daily: boolean }) => Promise<unknown>;
  /** Unprocessed session-news events (Stop / StopFailure / Notification — heartbeat.ts pendingSessionNews; any → run). Absent = 0. */
  pendingEvents?: () => number;
  /** Heartbeat inputs the list signatures miss (heartbeat.ts heartbeatWatchKey: calendar 2h window, unraised thread replies). */
  heartbeatWatchKey?: (cfg: NedConfig) => string;
  /** Latest non-ping activity (session events, HID input), ms. Pings are added here. */
  activityAt: () => number | Promise<number>;
  /** Today's daily briefing already exists (daemon restart). */
  dailyDoneToday?: boolean;
  /** After an automatic heartbeat: when the next one is planned (state.next_heartbeat_at). */
  onHeartbeat?: (nextAt: number) => void;
  log: (msg: string) => void;
}

export interface Scheduler {
  tick: () => Promise<void>;
  /** Wait for automatic runs started by earlier ticks (tests). */
  idle: () => Promise<void>;
  status: () => { idle: IdleStatus; recentRuns: boolean[] };
  stop: () => void;
}

const RUNS_KEEP = 50;
/** Skip-unchanged never holds a heartbeat off longer than this while Sentry is on (only the heartbeat reads Sentry). */
export const HEARTBEAT_SKIP_MAX_MINUTES = 180;

/** What an automatic heartbeat would judge from, minus session events: every enabled source's list signature + the watch key. */
export function heartbeatFingerprint(enabled: readonly AgendaSourceKey[], status: Partial<Record<AgendaSourceKey, { signature?: string }>> | undefined, watchKey = ""): string {
  return JSON.stringify({ sig: [...enabled].sort().map((k) => [k, status?.[k]?.signature ?? null]), watch: watchKey });
}

export function createScheduler(d: SchedulerDeps): Scheduler {
  const now = d.now ?? Date.now;
  const startedAt = now();
  const scheduled: SourceTimes = {};
  const runs: boolean[] = [];
  const inflight = new Set<Promise<unknown>>();
  let firstAgenda = true;
  let lastHbAt: number | null = null;
  /** Fingerprint + time of the last heartbeat that actually ran (skip-unchanged compares against it). */
  let lastRunFp: string | null = null;
  let lastRunAt = 0;
  let hbBusy = false;
  let ticking = false;
  let lastDaily = d.dailyDoneToday ? localDay(new Date(startedAt)) : "";
  let prevQuietThrottled = false;
  let idle: IdleStatus = IDLE_OFF;
  let pausedLogAt = 0;

  const track = <T>(p: Promise<T>): Promise<T> => {
    inflight.add(p);
    void p.finally(() => inflight.delete(p)).catch(() => {});
    return p;
  };

  const runAgenda = async (cfg: NedConfig, keys: AgendaSourceKey[], why: string): Promise<void> => {
    const t = now();
    for (const k of keys) scheduled[k] = t;
    d.log(`agenda: scheduled refresh [${keys.join(",")}] (${why})`);
    try {
      await d.refreshAgenda(cfg, keys);
      const st = d.sourcesStatus();
      runs.push(keys.every((k) => st?.[k]?.unchanged === true));
      if (runs.length > RUNS_KEEP) runs.splice(0, runs.length - RUNS_KEEP);
    } catch (e) {
      d.log(`agenda failed: ${String(e)}`);
    }
  };

  const runHeartbeat = async (cfg: NedConfig, factor: number): Promise<void> => {
    if (hbBusy) return;
    hbBusy = true;
    const t = now();
    lastHbAt = t;
    const date = new Date(t);
    const today = localDay(date);
    const daily = lastDaily !== today && date.toTimeString().slice(0, 5) >= cfg.briefing_time;
    if (daily) lastDaily = today;
    const fp = () => heartbeatFingerprint(d.enabledSources(cfg), d.sourcesStatus(), d.heartbeatWatchKey?.(cfg) ?? "");
    try {
      // Skip-unchanged: nothing the heartbeat judges from moved since the last one that ran → no claude call.
      if (!daily && cfg.heartbeat_skip_unchanged !== false && lastRunFp !== null) {
        const events = d.pendingEvents?.() ?? 0;
        const sentryDue = cfg.sources.sentry && t - lastRunAt >= HEARTBEAT_SKIP_MAX_MINUTES * 60_000;
        if (!events && !sentryDue && fp() === lastRunFp) {
          d.log(`heartbeat: skipped — unchanged (source lists, calendar window and thread replies same since ${new Date(lastRunAt).toTimeString().slice(0, 5)}, no new session news)`);
          d.onHeartbeat?.(now() + cfg.heartbeat_minutes * factor * 60_000);
          return;
        }
      }
      const r = await d.heartbeat(cfg, { daily });
      // null = heartbeat.ts stayed silent without judging: what it skipped must still count as unseen next time.
      if (r !== null) {
        lastRunFp = fp(); // after the run: a heartbeat may have refreshed the lists itself
        lastRunAt = t;
      }
      d.onHeartbeat?.(now() + cfg.heartbeat_minutes * factor * 60_000);
    } catch (e) {
      d.log(`heartbeat failed: ${String(e)}`);
    } finally {
      hbBusy = false;
    }
  };

  const tick = async (): Promise<void> => {
    if (ticking) return;
    ticking = true;
    try {
      const cfg = d.loadConfig();
      const t = now();
      const q = quietStatus(cfg, new Date(t));
      const quietThrottled = q.active && q.mode !== "normal";
      const quietEnded = prevQuietThrottled && !quietThrottled;
      prevQuietThrottled = quietThrottled;

      const isch = cfg.idle_schedule;
      const act = Math.max(startedAt, pingAt, (await d.activityAt()) || 0);
      const v = idleVerdict(isch, act, runs, t);
      let idleEnded = false;
      if (v.idle && !idle.active) {
        idle = { active: true, since: t, reason: v.reason, mode: isch.mode, factor: isch.mode === "slow" ? isch.slow_factor : 1 };
        d.log(`idle: started — ${v.reason} (${isch.mode === "slow" ? `slow ×${isch.slow_factor}` : "pause"})`);
      } else if (!v.idle && idle.active) {
        idleEnded = true;
        idle = IDLE_OFF;
        runs.length = 0; // idle again only after unchanged_runs fresh unchanged refreshes
      } else if (idle.active) {
        idle = { ...idle, mode: isch.mode, factor: isch.mode === "slow" ? isch.slow_factor : 1 }; // settings change applies now
      }
      idleNow = idle;

      if (quietEnded || idleEnded) {
        d.log(`${quietEnded ? "quiet" : "idle"}: ended — full refresh`);
        if (d.overBudget(cfg, "agenda")) return;
        const live = d.runningSources();
        const keys = d.enabledSources(cfg).filter((k) => !live.includes(k));
        firstAgenda = false;
        if (keys.length) await track(runAgenda(cfg, keys, quietEnded ? "quiet ended" : "idle ended"));
        if (!d.overBudget(cfg, "heartbeat")) await track(runHeartbeat(cfg, 1));
        return;
      }

      const th = combineThrottle(q, idle);
      if (th.pause) {
        if (t - pausedLogAt >= 60 * 60_000) {
          pausedLogAt = t;
          d.log(`${th.by}: paused${th.by === "quiet" && q.until ? ` (until ${q.until})` : ""}`);
        }
        return;
      }
      pausedLogAt = 0;

      if (!d.overBudget(cfg, "agenda")) {
        const enabled = d.enabledSources(cfg);
        const live = d.runningSources();
        const last = lastRuns(scheduled, d.sourcesStatus(), enabled);
        const due = firstAgenda ? enabled.filter((k) => !live.includes(k)) : dueSources(cfg, enabled, last, t, live, th.factor);
        if (due.length) {
          const why = firstAgenda ? "startup" : `due: ${due.map((k) => `${k} ${Math.round(sourceMinutes(cfg, k) * th.factor)}m`).join(", ")}${th.by ? ` (${th.by} ×${th.factor})` : ""}`;
          firstAgenda = false;
          void track(runAgenda(cfg, due, why));
        }
      }

      const date = new Date(t);
      const dailyDue = lastDaily !== localDay(date) && date.toTimeString().slice(0, 5) >= cfg.briefing_time;
      if (!hbBusy && (dailyDue || heartbeatDue(lastHbAt, cfg.heartbeat_minutes, th.factor, t)) && !d.overBudget(cfg, "heartbeat")) void track(runHeartbeat(cfg, th.factor));
    } catch (e) {
      d.log(`scheduler tick failed: ${String(e)}`);
    } finally {
      ticking = false;
    }
  };

  wake = () => {
    if (idle.active) void tick();
  };

  return {
    tick,
    idle: async () => {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
    status: () => ({ idle, recentRuns: [...runs] }),
    stop: () => {
      wake = null;
      idleNow = IDLE_OFF;
    },
  };
}
