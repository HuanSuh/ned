#!/usr/bin/env bash
# Ned self-update (자동 업데이트 / 설정 → 앱 "지금 업데이트"): the Claude Code plugin update, then /ned:install's script.
# Started by the daemon (src/self-update.ts) as a detached process in its own session — install.sh quits Ned.app,
# which stops the daemon, so this must not depend on either. One run at a time ($NED_HOME/self-update.lock).
#
#   1. claude plugin marketplace update <marketplace>
#   2. claude plugin update <plugin>@<marketplace>
#   3. the new version's scripts/install.sh (installPath from installed_plugins.json, else
#      <plugins>/cache/<marketplace>/<plugin>/<to>/) with NED_PLUGIN_MODE=1 … < /dev/null
#   4. $NED_HOME/update-state.json ← {last_attempt_at, last_result ok|fail, from, to, log, fail_line?}
#      (ok also clears `available`). Output: $NED_HOME/logs/self-update.log.
#
# Usage: self-update.sh --to <version> [--from <version>] [--marketplace ned] [--plugin ned]
# Environment: NED_HOME (default ~/.ned), CLAUDE_CONFIG_DIR (default ~/.claude), NED_CLAUDE_BIN (default claude),
#              NED_NODE (default node — writes the JSON state).
# Exit: 0 ok, 1 a step failed, 2 bad usage, 75 another run holds the lock.
#
# Everything runs inside main(): bash has parsed the whole function before install.sh swaps the runtime dir this
# file lives in, so the swap cannot change the code mid-run.
set -u
LOCK_HELD=""

main() {
  local to="" from="" market="ned" plugin="ned"
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) to="${2:-}"; shift 2 ;;
      --from) from="${2:-}"; shift 2 ;;
      --marketplace) market="${2:-}"; shift 2 ;;
      --plugin) plugin="${2:-}"; shift 2 ;;
      *) echo "self-update: unknown argument $1" >&2; return 2 ;;
    esac
  done
  if [ -z "$to" ]; then echo "self-update: --to <version> is required" >&2; return 2; fi
  case "$to$market$plugin" in *[!A-Za-z0-9._+-]*) echo "self-update: bad version / name" >&2; return 2 ;; esac

  local home="${NED_HOME:-$HOME/.ned}"
  local claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  local claude="${NED_CLAUDE_BIN:-claude}"
  local node="${NED_NODE:-node}"
  local log="$home/logs/self-update.log"
  local state="$home/update-state.json"
  local lock="$home/self-update.lock"
  mkdir -p "$home/logs"
  exec >>"$log" 2>&1
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') self-update ${from:-?} → $to (pid $$)"

  # Lock: a directory (mkdir is atomic) holding the owner's pid; a dead owner's lock is taken over.
  if ! mkdir "$lock" 2>/dev/null; then
    local owner; owner="$(cat "$lock/pid" 2>/dev/null || true)"
    if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then
      echo "✗ already running (pid $owner) — not starting a second one"
      return 75
    fi
    echo "  stale lock (pid ${owner:-?}) — taking it over"
    rm -rf "$lock"
    mkdir "$lock" || { echo "✗ cannot take the lock $lock"; return 75; }
  fi
  echo $$ >"$lock/pid"
  LOCK_HELD="$lock" # global: the EXIT trap runs after main's locals are gone
  trap 'rm -rf "$LOCK_HELD"' EXIT

  local started; started="$(date +%s)000"
  # update-state.json merge: <result> <fail line>. Node is on the daemon's PATH (Ned.app puts it first).
  write_state() {
    STATE="$state" RESULT="$1" FAIL="${2:-}" FROM="$from" TO="$to" LOG="$log" AT="$started" "$node" -e '
      const fs = require("fs"), e = process.env;
      let s = {}; try { s = JSON.parse(fs.readFileSync(e.STATE, "utf8")) || {}; } catch {}
      Object.assign(s, { last_attempt_at: Number(e.AT), last_result: e.RESULT, from: e.FROM || null, to: e.TO, log: e.LOG, finished_at: Date.now() });
      if (e.FAIL) s.fail_line = e.FAIL; else delete s.fail_line;
      if (e.RESULT === "ok") s.available = null;
      const tmp = e.STATE + ".tmp-" + process.pid; fs.writeFileSync(tmp, JSON.stringify(s, null, 2)); fs.renameSync(tmp, e.STATE);
    ' || echo "  (update-state.json 을 쓰지 못함)"
  }
  local out
  # step <label> <cmd…>: run, tee into the log, on failure record the last non-empty output line.
  step() {
    local label="$1"; shift
    echo "▶ $label: $*"
    out="$("$@" 2>&1)"; local rc=$?
    [ -n "$out" ] && printf '%s\n' "$out"
    if [ $rc -ne 0 ]; then
      local last; last="$(printf '%s\n' "$out" | awk 'NF { l = $0 } END { print l }')"
      echo "✗ $label failed (exit $rc)"
      write_state fail "$label: ${last:-exit $rc}"
      return 1
    fi
  }

  step "marketplace update" "$claude" plugin marketplace update "$market" || return 1
  step "plugin update" "$claude" plugin update "$plugin@$market" || return 1

  local src
  src="$(PLUGINS="$claude_dir/plugins" ID="$plugin@$market" "$node" -e '
    const fs = require("fs"), e = process.env;
    try {
      const j = JSON.parse(fs.readFileSync(e.PLUGINS + "/installed_plugins.json", "utf8"));
      const v = (j.plugins || j)[e.ID]; const list = Array.isArray(v) ? v : v ? [v] : [];
      const p = list.map((x) => x && x.installPath).find((x) => typeof x === "string");
      if (p) process.stdout.write(p);
    } catch {}
  ' 2>/dev/null)"
  if [ -z "$src" ] || [ ! -f "$src/scripts/install.sh" ]; then src="$claude_dir/plugins/cache/$market/$plugin/$to"; fi
  if [ ! -f "$src/scripts/install.sh" ]; then
    echo "✗ new version not found ($src/scripts/install.sh)"
    write_state fail "설치 경로 없음: $src"
    return 1
  fi
  local got; got="$(SRC="$src" "$node" -e 'try { process.stdout.write(String(require(process.env.SRC + "/.claude-plugin/plugin.json").version || "")); } catch {}' 2>/dev/null)"
  if [ -n "$got" ] && [ "$got" != "$to" ]; then
    echo "✗ plugin update left version $got (wanted $to)"
    write_state fail "플러그인이 $got 에 머묾 ($to 아님)"
    return 1
  fi
  echo "  source: $src (version ${got:-?})"
  step "install" env NED_PLUGIN_MODE=1 bash "$src/scripts/install.sh" </dev/null || return 1
  write_state ok
  echo "✓ updated to $to"
  return 0
}

main "$@"
exit $?
