import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { NedEvent } from "../src/events.js";
import { reduceSessions } from "../src/sessions.js";

const T0 = 1_760_000_000_000;
const ev = (event: string, ts: number, extra: Partial<NedEvent> = {}): NedEvent => ({ event, ts, session_id: "s1", cwd: "/work/repo-a", ...extra });

describe("reduceSessions", () => {
  it("starts a session as running on SessionStart", () => {
    const [s] = reduceSessions([ev("SessionStart", T0)], 180, T0 + 1000);
    expect(s).toMatchObject({ id: "s1", status: "running", worktree: "repo-a", cwd: "/work/repo-a", since: T0, alert_ts: null });
  });

  it("UserPromptSubmit keeps running and records the prompt", () => {
    const [s] = reduceSessions([ev("SessionStart", T0), ev("Stop", T0 + 1), ev("UserPromptSubmit", T0 + 2, { prompt: "fix it" })], 180, T0 + 10);
    expect(s.status).toBe("running");
    expect(s.last_prompt).toBe("fix it");
  });

  it("Notification → waiting with alert_ts and a truncated summary", () => {
    const msg = "x".repeat(500);
    const [s] = reduceSessions([ev("SessionStart", T0), ev("Notification", T0 + 5, { message: msg })], 180, T0 + 10);
    expect(s.status).toBe("waiting");
    expect(s.alert_ts).toBe(T0 + 5);
    expect(s.last_summary).toHaveLength(240);
  });

  it("Stop → done (no transcript keeps the previous summary)", () => {
    const [s] = reduceSessions([ev("Notification", T0, { message: "perm?" }), ev("Stop", T0 + 1)], 180, T0 + 10);
    expect(s.status).toBe("done");
    expect(s.last_summary).toBe("perm?");
  });

  it("Stop reads the last assistant text from the transcript", () => {
    const tp = path.join(process.env.NED_HOME!, "transcript-sessions.jsonl");
    fs.writeFileSync(tp, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "All tests pass." }] } }) + "\n");
    const [s] = reduceSessions([ev("Stop", T0, { transcript_path: tp })], 180, T0 + 10);
    expect(s.last_summary).toBe("All tests pass.");
  });

  it("StopFailure → error with alert_ts", () => {
    const [s] = reduceSessions([ev("SessionStart", T0), ev("StopFailure", T0 + 3, { message: "rate limited" })], 180, T0 + 10);
    expect(s.status).toBe("error");
    expect(s.alert_ts).toBe(T0 + 3);
    expect(s.last_summary).toBe("rate limited");
  });

  it("SessionEnd removes the session", () => {
    expect(reduceSessions([ev("SessionStart", T0), ev("SessionEnd", T0 + 1)], 180, T0 + 10)).toEqual([]);
  });

  it("a later event after SessionEnd revives it", () => {
    const out = reduceSessions([ev("SessionStart", T0), ev("SessionEnd", T0 + 1), ev("SessionStart", T0 + 2)], 180, T0 + 10);
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("running");
  });

  it("drops stale sessions, keeps fresh ones, and 0 disables the filter", () => {
    const events = [ev("SessionStart", T0), ev("SessionStart", T0 + 50 * 60_000, { session_id: "s2" })];
    const now = T0 + 60 * 60_000;
    expect(reduceSessions(events, 30, now).map((s) => s.id)).toEqual(["s2"]);
    expect(reduceSessions(events, 0, now).map((s) => s.id)).toEqual(["s2", "s1"]);
  });

  it("sorts newest-first by last event", () => {
    const out = reduceSessions([ev("SessionStart", T0, { session_id: "a" }), ev("SessionStart", T0 + 1, { session_id: "b" }), ev("Stop", T0 + 2, { session_id: "a" })], 180, T0 + 10);
    expect(out.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("counts subagents and never goes negative", () => {
    const [s] = reduceSessions([ev("SubagentStart", T0), ev("SubagentStart", T0 + 1), ev("SubagentStop", T0 + 2), ev("SubagentStop", T0 + 3), ev("SubagentStop", T0 + 4)], 180, T0 + 10);
    expect(s.subagents_active).toBe(0);
    const [s2] = reduceSessions([ev("SubagentStart", T0), ev("SubagentStart", T0 + 1), ev("SubagentStop", T0 + 2)], 180, T0 + 10);
    expect(s2.subagents_active).toBe(1);
  });

  it("names a worktree from the Orca id when the hook had no cwd", () => {
    const [s] = reduceSessions([ev("SessionStart", T0, { cwd: undefined, orca_worktree: "wt-123::/Users/x/orca/workspaces/ned/ned-tests" })], 180, T0 + 10);
    expect(s.worktree).toBe("ned-tests");
    expect(s.orca_worktree).toBe("wt-123::/Users/x/orca/workspaces/ned/ned-tests");
  });

  it("falls back to '?' with neither cwd nor orca path", () => {
    const [s] = reduceSessions([ev("SessionStart", T0, { cwd: undefined })], 180, T0 + 10);
    expect(s.worktree).toBe("?");
  });

  it("a cwd seen later wins over the Orca-derived name", () => {
    const [s] = reduceSessions([ev("SessionStart", T0, { cwd: undefined, orca_worktree: "id::/a/orca-name" }), ev("UserPromptSubmit", T0 + 1, { cwd: "/b/real-cwd" })], 180, T0 + 10);
    expect(s.worktree).toBe("real-cwd");
  });

  it("ignores events without session_id or numeric ts", () => {
    const bad = [{ event: "SessionStart", ts: T0 } as NedEvent, { event: "SessionStart", ts: "x", session_id: "s9" } as unknown as NedEvent];
    expect(reduceSessions(bad, 180, T0 + 10)).toEqual([]);
  });
});
