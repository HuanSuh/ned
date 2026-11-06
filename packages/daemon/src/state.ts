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
  });
}

export function writeState(state: NedState): void {
  state.updated_at = Date.now();
  state.daemon_pid = process.pid;
  writeJsonAtomic(STATE_PATH, state);
}
