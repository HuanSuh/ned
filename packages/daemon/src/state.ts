import { DEFAULT_NOTIFICATIONS, type NedNotifications, type PersonaId } from "./config.js";
import { REVIEWED_PATH, STATE_PATH, readJson, writeJsonAtomic } from "./paths.js";
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
}

export interface NedState {
  updated_at: number;
  daemon_pid: number;
  sessions: SessionView[];
  attention: AttentionItem[];
  last_briefing: Pick<Briefing, "id" | "ts" | "type" | "status" | "headline"> | null;
  last_heartbeat_at: number | null;
  next_heartbeat_at: number | null;
  quiet: boolean;
  /** config.persona, mirrored here so the menu-bar app and dashboard can follow it. */
  persona: PersonaId;
  /** config.notifications, mirrored for Ned.app (which posts the banners). */
  notifications: NedNotifications;
  /** attention items not marked 확인 완료 — for the menu-bar badge / counts. */
  attention_open_count: number;
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
export const readReviewed = (): Reviewed => readJson<Reviewed>(REVIEWED_PATH, {});

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

export function writeState(state: NedState): void {
  // Re-apply 확인 완료 on every write, so attention rebuilt by refreshSessions / heartbeat keeps it.
  // An item that changed after it was reviewed (ts later than the mark, e.g. a session's new alert) is open again.
  const reviewed = readReviewed();
  state.attention = state.attention.map(({ reviewed_at: _old, ...a }) => (reviewed[a.id] != null && reviewed[a.id] >= (a.ts || 0) ? { ...a, reviewed_at: reviewed[a.id] } : a));
  state.attention_open_count = state.attention.filter((a) => !a.reviewed_at).length;
  state.updated_at = Date.now();
  state.daemon_pid = process.pid;
  writeJsonAtomic(STATE_PATH, state);
}
