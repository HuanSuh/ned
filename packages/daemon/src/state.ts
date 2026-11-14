import { DEFAULT_NOTIFICATIONS, type NedNotifications, type PersonaId } from "./config.js";
import path from "node:path";
import { NED_HOME, REVIEWED_PATH, STATE_PATH, readJson, writeJsonAtomic } from "./paths.js";
import { foldReviewMarks } from "./review-keys.js";
import type { SessionView } from "./sessions.js";

export type AttentionKind = "session" | "email" | "slack" | "jira" | "github" | "sentry" | "calendar" | "other";

export interface AttentionItem {
  id: string;
  kind: AttentionKind;
  title: string;
  detail?: string;
  url?: string;
  ts: number;
  /** Where it came from: a briefing id or "sessions". */
  source: string;
  /** Marked 확인 완료 (ms). Still in `attention`, just not counted as open. Cleared when the item changes after it. */
  reviewed_at?: number;
}

export interface BriefingSection {
  title: string;
  detail?: string;
  url?: string;
  kind?: AttentionKind;
}

export interface Briefing {
  id: string;
  ts: number;
  type: "heartbeat" | "daily";
  status: "NED_OK" | "UPDATE";
  headline?: string;
  action_items: BriefingSection[];
  updates: BriefingSection[];
  fyi: BriefingSection[];
  sessions?: BriefingSection[];
  cost_usd?: number;
  raw?: string;
  /** false = claude failed or its answer didn't parse (raw holds the text). Absent on older files — see briefingOk. */
  ok?: boolean;
}

/** Did this briefing actually judge? Older files have no `ok`: a failed run is the one that kept `raw`. */
export const briefingOk = (b: Pick<Briefing, "ok" | "raw">): boolean => b.ok ?? b.raw === undefined;

export interface NedState {
  updated_at: number;
  daemon_pid: number;
  sessions: SessionView[];
  attention: AttentionItem[];
  last_briefing: Pick<Briefing, "id" | "ts" | "type" | "status" | "headline" | "ok"> | null;
  last_heartbeat_at: number | null;
  /** Today's automatic morning briefing gave up after its retries (ms). Cleared by the next successful daily. */
  daily_failed_at?: number | null;
  next_heartbeat_at: number | null;
  quiet: boolean;
  /** config.persona, mirrored here so the menu-bar app and dashboard can follow it. */
  persona: PersonaId;
  /** config.notifications, mirrored for Ned.app (which posts the banners). */
  notifications: NedNotifications;
  /** attention items not marked 확인 완료 — for the menu-bar badge / counts. */
  attention_open_count: number;
  /** A newer Ned plugin version found by the update check (src/self-update.ts); `notified` = announced once already. */
  update_available?: UpdateBadge | null;
  /** 맡긴 일: the patrol's latest rating per config.responsibilities id (heartbeat.ts applyResponsibilityReport). */
  responsibilities?: Record<string, ResponsibilityStatus>;
}

export const RESP_STATUSES = ["on_track", "watch", "blocked"] as const;
export type RespStatus = (typeof RESP_STATUSES)[number];
export interface ResponsibilityStatus {
  status: RespStatus;
  /** 1–2 sentences in the persona's voice. */
  note: string;
  /** ≤ 3 links, each one the model saw in the patrol's 업무 목록. */
  urls: string[];
  /** When the patrol last rated it (ms). */
  updated_at: number;
}

/** 자동 업데이트 bookkeeping (src/self-update.ts writes it, scripts/self-update.sh records the install result). */
export const UPDATE_STATE_PATH = path.join(NED_HOME, "update-state.json");
export interface UpdateBadge { current: string | null; latest: string; notified: boolean }
/** update-state.json `available` → the state.json field (null when nothing newer is known). */
export function readUpdateBadge(): UpdateBadge | null {
  const u = readJson<{ available?: { current?: unknown; latest?: unknown } | null; notified_version?: unknown }>(UPDATE_STATE_PATH, {});
  const a = u.available;
  if (!a || typeof a.latest !== "string" || !a.latest) return null;
  return { current: typeof a.current === "string" ? a.current : null, latest: a.latest, notified: u.notified_version === a.latest };
}

export function readState(): NedState {
  return readJson<NedState>(STATE_PATH, {
    updated_at: 0,
    daemon_pid: 0,
    sessions: [],
    attention: [],
    last_briefing: null,
    last_heartbeat_at: null,
    next_heartbeat_at: null,
    quiet: false,
    persona: "ned",
    notifications: DEFAULT_NOTIFICATIONS,
    attention_open_count: 0,
  });
}

/** Review keys for source items that have no attention id: mail:<thread>, slack:<channel>:<ts>, jira:<KEY>, github:<repo>#<n>. */
export const SOURCE_KEY = /^(mail|slack|jira|github):[^\s]{1,200}$/;
/** Source-item review marks only (for the dashboard). */
export const readSourceReviewed = (): Reviewed => Object.fromEntries(Object.entries(readReviewed()).filter(([k]) => SOURCE_KEY.test(k)));

/** Attention id (or a SOURCE_KEY) → reviewed at (ms). */
export type Reviewed = Record<string, number>;
/**
 * reviewed.json, old thread-aware Slack keys (`slack:<ch>:<ts>@<reply ts>`) folded into `slack:<ch>:<ts>` (largest
 * mark) — review-keys.ts foldReviewMarks. The file itself is rewritten in the new shape on the next setReviewed.
 */
export const readReviewed = (): Reviewed => foldReviewMarks(readJson<Reviewed>(REVIEWED_PATH, {}));

/**
 * Mark / unmark an attention item as 확인 완료 (persisted in reviewed.json, entries kept 7 days).
 * Returns the item's new reviewed_at (or null).
 */
export function setReviewed(id: string, reviewed: boolean, now = Date.now()): number | null {
  // attention marks live 7 days; source-item marks (mail: / slack: / jira: / github:) 30 days — Jira issues etc. stay around.
  const keep = (k: string) => (SOURCE_KEY.test(k) ? 30 : 7) * 24 * 60 * 60_000;
  const r = Object.fromEntries(Object.entries(readReviewed()).filter(([k, at]) => now - at < keep(k)));
  if (reviewed) r[id] = now; else delete r[id];
  writeJsonAtomic(REVIEWED_PATH, r);
  writeState(readState());
  return reviewed ? now : null;
}

/** Attention ids (`session:<id>`) of worker sessions (Orca child worktrees) — never attention. */
export function workerAttentionIds(sessions: SessionView[]): Set<string> {
  return new Set(sessions.filter((s) => s.is_worker).map((s) => `session:${s.id}`));
}

export function writeState(state: NedState): void {
  // Worker sessions stay in `sessions` (the rail shows them) but never raise 입력 대기/오류 attention.
  const workers = workerAttentionIds(state.sessions ?? []);
  if (workers.size) state.attention = state.attention.filter((a) => !workers.has(a.id));
  // Re-apply 확인 완료 on every write, so attention rebuilt by refreshSessions / heartbeat keeps it.
  // An item that changed after it was reviewed (ts later than the mark, e.g. a session's new alert) is open again.
  const reviewed = readReviewed();
  state.attention = state.attention.map(({ reviewed_at: _old, ...a }) => (reviewed[a.id] != null && reviewed[a.id] >= (a.ts || 0) ? { ...a, reviewed_at: reviewed[a.id] } : a));
  state.attention_open_count = state.attention.filter((a) => !a.reviewed_at).length;
  state.update_available = readUpdateBadge();
  state.updated_at = Date.now();
  state.daemon_pid = process.pid;
  writeJsonAtomic(STATE_PATH, state);
}
