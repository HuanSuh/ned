#!/bin/sh
# Ned hook for Claude Code.
# Reads the hook payload from stdin, appends one JSON line to ~/.ned/events/YYYY-MM-DD.jsonl,
# and always answers `{}` so it never blocks Claude Code. Must stay fast and silent.

NED_HOME="${NED_HOME:-$HOME/.ned}"
payload=$(cat 2>/dev/null)
printf '{}\n'
[ -n "$payload" ] || exit 0

mkdir -p "$NED_HOME/events" 2>/dev/null || exit 0

NED_PAYLOAD="$payload" NED_HOME="$NED_HOME" NED_PPID="$PPID" /usr/bin/python3 - <<'PY' 2>>"$NED_HOME/hook.err" || :
import json, os, time, datetime

raw = os.environ.get("NED_PAYLOAD", "")
try:
    p = json.loads(raw)
except Exception:
    raise SystemExit(0)

now = time.time()
ev = {
    "ts": int(now * 1000),
    "event": p.get("hook_event_name"),
    "session_id": p.get("session_id"),
    "cwd": p.get("cwd"),
    "transcript_path": p.get("transcript_path"),
    "pid": int(os.environ["NED_PPID"]) if os.environ.get("NED_PPID", "").isdigit() else None,
}
# Event-specific extras, kept small.
for k in ("message", "notification_type", "source", "reason", "agent_id", "agent_type", "stop_hook_active", "matcher", "tool_name"):
    if k in p:
        ev[k] = p[k]
if "prompt" in p and isinstance(p["prompt"], str):
    ev["prompt"] = p["prompt"][:200]
# Orca context if present.
for env_key, out_key in (("ORCA_WORKTREE_ID", "orca_worktree"), ("ORCA_PANE_KEY", "orca_pane"), ("ORCA_TAB_ID", "orca_tab")):
    v = os.environ.get(env_key)
    if v:
        ev[out_key] = v

ev = {k: v for k, v in ev.items() if v is not None}
day = datetime.datetime.fromtimestamp(now).strftime("%Y-%m-%d")
path = os.path.join(os.environ["NED_HOME"], "events", day + ".jsonl")
with open(path, "a") as f:
    f.write(json.dumps(ev, ensure_ascii=False) + "\n")
PY
exit 0
