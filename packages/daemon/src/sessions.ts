import path from "node:path";
import type { NedEvent } from "./events.js";
import { lastAssistantText } from "./events.js";

export type SessionStatus = "running" | "waiting" | "done" | "error" | "ended";

export interface SessionView {
  id: string;
  cwd: string;
  worktree: string;
  status: SessionStatus;
  since: number;
  last_event_ts: number;
  last_prompt: string | null;
  last_summary: string | null;
  subagents_active: number;
  orca_worktree: string | null;
}

const TERMINAL: SessionStatus[] = ["ended"];

/** Reduce raw hook events into per-session views (state machine). */
export function reduceSessions(events: NedEvent[], staleMinutes: number, now = Date.now()): SessionView[] {
  const map = new Map<string, SessionView>();
  for (const e of events) {
    if (!e.session_id) continue;
    let s = map.get(e.session_id);
    if (!s) {
      s = {
        id: e.session_id,
        cwd: e.cwd ?? "",
        worktree: e.cwd ? path.basename(e.cwd) : "?",
        status: "running",
        since: e.ts,
        last_event_ts: e.ts,
        last_prompt: null,
        last_summary: null,
        subagents_active: 0,
        orca_worktree: e.orca_worktree ?? null,
      };
      map.set(e.session_id, s);
    }
    s.last_event_ts = e.ts;
    if (e.cwd) {
      s.cwd = e.cwd;
      s.worktree = path.basename(e.cwd);
    }
    if (e.orca_worktree) s.orca_worktree = e.orca_worktree;

    switch (e.event) {
      case "SessionStart":
        s.status = "running";
        break;
      case "UserPromptSubmit":
        s.status = "running";
        s.last_prompt = e.prompt ?? s.last_prompt;
        break;
      case "SubagentStart":
        s.subagents_active++;
        break;
      case "SubagentStop":
        s.subagents_active = Math.max(0, s.subagents_active - 1);
        break;
      case "Notification":
        // permission_prompt / idle_prompt / elicitation → needs the human.
        s.status = "waiting";
        if (e.message) s.last_summary = String(e.message).slice(0, 240);
        break;
      case "Stop":
        s.status = "done";
        s.last_summary = lastAssistantText(e.transcript_path) ?? s.last_summary;
        break;
      case "StopFailure":
        s.status = "error";
        s.last_summary = e.message ? String(e.message).slice(0, 240) : s.last_summary;
        break;
      case "SessionEnd":
        s.status = "ended";
        break;
    }
  }
  const staleMs = staleMinutes * 60_000;
  return [...map.values()]
    .filter((s) => !TERMINAL.includes(s.status) && now - s.last_event_ts < staleMs)
    .sort((a, b) => b.last_event_ts - a.last_event_ts);
}
