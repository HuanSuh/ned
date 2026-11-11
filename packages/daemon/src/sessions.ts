import os from "node:os";
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
  /** ts of the latest Notification/StopFailure — keys attention dismissals. */
  alert_ts: number | null;
  /**
   * cwd (or the Orca worktree path) is under a worker root (`~/orca/workspaces/`) — an Orca child
   * worktree, i.e. one of the user's own agent workers. Shown (dimmed) but never an attention item.
   */
  is_worker: boolean;
  /** "chat" = Ned 대화창에서 시작한 세션 (session-create.ts — cwd 가 기록된 워크트리 경로). */
  origin?: "chat";
  /** origin "chat": the Orca terminal handle Ned started it in. */
  origin_terminal?: string;
  /**
   * A hook event of this session carried orca_pane / orca_tab — Ned knows which Orca terminal to type into
   * (POST /api/send source "session", actions.ts sendToSession). false → the UI shows "터미널에서 직접 입력" only.
   * Whether that terminal is open *now* is only known at send time (409).
   */
  can_reply: boolean;
  /**
   * The waiting Notification's `notification_type` (permission_prompt / idle_prompt / elicitation_dialog …), null once the
   * session moves on. A dialog type (REPLY_DIALOG_TYPES) means the terminal shows a picker, not the prompt: typed text is
   * ignored and the Enter of a reply confirms the highlighted option (Claude Code keybindings: Confirmation `confirm:yes`
   * = Enter) — so the reply UIs show "터미널에서 직접 선택" and POST /api/send answers 409.
   */
  notification_type: string | null;
}

/** Notification types whose terminal shows a picker / form instead of the prompt — no typed replies. */
export const REPLY_DIALOG_TYPES = ["permission_prompt", "elicitation_dialog"];
export const inReplyDialog = (s: Pick<SessionView, "status" | "notification_type">): boolean =>
  s.status === "waiting" && !!s.notification_type && REPLY_DIALOG_TYPES.includes(s.notification_type);

const TERMINAL: SessionStatus[] = ["ended"];

/** Worker roots: `NED_WORKER_ROOTS` (`:`-separated, for tests) or `~/orca/workspaces`. */
export function workerRoots(): string[] {
  const env = process.env.NED_WORKER_ROOTS;
  const roots = env != null ? env.split(":").filter(Boolean) : [path.join(os.homedir(), "orca", "workspaces")];
  return roots.map((r) => path.resolve(r));
}

/** True when `cwd` (or the path half of `<id>::<path>`) is strictly inside a worker root. */
export function isWorkerPath(cwd: string | null | undefined, orca?: string | null, roots = workerRoots()): boolean {
  const candidates = [cwd, orca?.split("::")[1]].filter((p): p is string => !!p);
  return candidates.some((p) => {
    const abs = path.resolve(p);
    return roots.some((r) => abs.startsWith(r + path.sep));
  });
}

/** Orca passes `<worktree-id>::<path>`; use the path's basename when the hook had no cwd. */
function worktreeName(cwd: string | undefined, orca: string | undefined | null): string {
  if (cwd) return path.basename(cwd);
  const p = orca?.split("::")[1];
  return p ? path.basename(p) : "?";
}

/** Reduce raw hook events into per-session views (state machine). */
export function reduceSessions(events: NedEvent[], staleMinutes: number, now = Date.now()): SessionView[] {
  const map = new Map<string, SessionView>();
  for (const e of events) {
    if (!e.session_id || typeof e.ts !== "number") continue;
    let s = map.get(e.session_id);
    if (!s) {
      s = {
        id: e.session_id,
        cwd: e.cwd ?? "",
        worktree: worktreeName(e.cwd, e.orca_worktree),
        status: "running",
        since: e.ts,
        last_event_ts: e.ts,
        last_prompt: null,
        last_summary: null,
        subagents_active: 0,
        orca_worktree: e.orca_worktree ?? null,
        alert_ts: null,
        is_worker: false,
        can_reply: false,
        notification_type: null,
      };
      map.set(e.session_id, s);
    }
    s.last_event_ts = Math.max(s.last_event_ts, e.ts);
    if (e.orca_pane || e.orca_tab) s.can_reply = true;
    if (e.cwd) {
      s.cwd = e.cwd;
      s.worktree = path.basename(e.cwd);
    }
    if (e.orca_worktree) {
      s.orca_worktree = e.orca_worktree;
      if (!e.cwd && !s.cwd) s.worktree = worktreeName(undefined, e.orca_worktree);
    }

    // The dialog type belongs to the Notification that made it wait; any other status-changing event ends it.
    if (["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd"].includes(e.event)) s.notification_type = null;
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
        s.alert_ts = e.ts;
        s.notification_type = typeof e.notification_type === "string" && e.notification_type ? e.notification_type.slice(0, 40) : null;
        if (e.message) s.last_summary = String(e.message).slice(0, 240);
        break;
      case "Stop":
        s.status = "done";
        s.last_summary = lastAssistantText(e.transcript_path) ?? s.last_summary;
        break;
      case "StopFailure":
        s.status = "error";
        s.alert_ts = e.ts;
        s.last_summary = e.message ? String(e.message).slice(0, 240) : s.last_summary;
        break;
      case "SessionEnd":
        s.status = "ended";
        break;
    }
  }
  // staleMinutes <= 0 disables the stale filter.
  const staleMs = staleMinutes > 0 ? staleMinutes * 60_000 : Infinity;
  const roots = workerRoots();
  for (const s of map.values()) s.is_worker = isWorkerPath(s.cwd, s.orca_worktree, roots);
  return [...map.values()]
    .filter((s) => !TERMINAL.includes(s.status) && now - s.last_event_ts < staleMs)
    .sort((a, b) => b.last_event_ts - a.last_event_ts);
}
