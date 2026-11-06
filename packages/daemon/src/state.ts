import { DEFAULT_NOTIFICATIONS, type NedNotifications, type PersonaId } from "./config.js";
import { STATE_PATH, readJson, writeJsonAtomic } from "./paths.js";
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
  });
}

export function writeState(state: NedState): void {
  state.updated_at = Date.now();
  state.daemon_pid = process.pid;
  writeJsonAtomic(STATE_PATH, state);
}
