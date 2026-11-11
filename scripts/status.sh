#!/usr/bin/env bash
# Read-only Ned status (what /ned:status runs): daemon API, app process, nedRepoPath, runtime vs plugin version,
# last app-daemon.log lines, leftover settings.json hooks. Changes nothing.
#
# Usage: scripts/status.sh [plugin-root]   (plugin-root = ${CLAUDE_PLUGIN_ROOT}; default: this checkout)
# Environment: NED_HOME, NED_PORT (7777), NED_DEFAULTS_DOMAIN (com.ned.menubar),
#              NED_CLAUDE_SETTINGS (~/.claude/settings.json), NED_CLAUDE_PLUGINS_DIR (~/.claude/plugins)
#              — tests point these at temp values.
set -uo pipefail
PLUGIN_ROOT="${1:-$(cd "$(dirname "$0")/.." && pwd -P)}"
NED_HOME="${NED_HOME:-$HOME/.ned}"
PORT="${NED_PORT:-7777}"
DOMAIN="${NED_DEFAULTS_DOMAIN:-com.ned.menubar}"
SETTINGS="${NED_CLAUDE_SETTINGS:-$HOME/.claude/settings.json}"
PLUGINS_DIR="${NED_CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
version_of() { node -p "require(process.argv[1]).version" "$1/.claude-plugin/plugin.json" 2>/dev/null || echo "?"; }

echo "## daemon (http://127.0.0.1:$PORT)"
if state="$(curl -s --max-time 3 "http://127.0.0.1:$PORT/api/state")" && [ -n "$state" ]; then
  printf '%s' "$state" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const j = JSON.parse(s);
        const sessions = Array.isArray(j.sessions) ? j.sessions : [];
        const by = {};
        for (const x of sessions) by[x.status ?? "?"] = (by[x.status ?? "?"] ?? 0) + 1;
        const t = (ms) => (ms ? new Date(ms).toLocaleString("ko-KR") : "—");
        console.log("  up — daemon_pid " + (j.daemon_pid ?? "?") + (j.quiet ? " (조용한 시간)" : ""));
        console.log("  heartbeat: last " + t(j.last_heartbeat_at) + " · next " + t(j.next_heartbeat_at));
        const b = j.last_briefing;
        console.log("  last briefing: " + (b ? t(b.ts) + " " + (b.type ?? "") + " — " + (b.headline ?? "") : "—"));
        console.log("  sessions: " + sessions.length + (sessions.length ? " (" + Object.entries(by).map(([k, v]) => k + " " + v).join(", ") + ")" : ""));
        console.log("  attention open: " + (j.attention_open_count ?? 0));
      } catch { console.log("  up, but /api/state is not JSON: " + s.slice(0, 120)); }
    });'
else
  echo "  down — no answer (Ned.app 이 꺼져 있거나 데몬이 아직 안 뜸)"
fi

echo "## MCP (http://127.0.0.1:$PORT/mcp)"
# One initialize request (no session — the endpoint is stateless). Whether this Claude Code session loaded the plugin's
# ned MCP server is not visible from here: check with /mcp in the session.
init='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"ned-status","version":"0"}}}'
mcp="$(curl -s --max-time 3 -w '\n%{http_code}' -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d "$init" "http://127.0.0.1:$PORT/mcp")"
code="${mcp##*$'\n'}"   # last line = HTTP status (curl -w); 000 / empty = no answer
mcp="${mcp%$'\n'*}"
if [ -z "$code" ] || [ "$code" = "000" ]; then
  echo "  응답 없음 (데몬이 꺼져 있음)"
elif [ "$code" = "403" ]; then
  echo "  403 Host/Origin 거부 — $NED_HOME/logs/app-daemon.log 의 'request-guard: refused' 줄 확인"
elif [ "$code" = "404" ]; then
  echo "  응답은 있으나 MCP 가 아님 (런타임이 /mcp 이전 버전? → /ned:install): 404"
else
  printf '%s' "$mcp" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        const r = JSON.parse(s).result;
        console.log(r?.serverInfo ? "  응답함 — " + r.serverInfo.name + " " + r.serverInfo.version + " (protocol " + r.protocolVersion + ")" : "  응답은 있으나 MCP 가 아님 (런타임이 /mcp 이전 버전? → /ned:install): " + s.slice(0, 120));
      } catch { console.log("  응답은 있으나 MCP 가 아님 (런타임이 /mcp 이전 버전? → /ned:install): " + s.slice(0, 120)); }
    });'
fi
echo "  이 세션에 ned MCP 서버가 로드됐는지는 Claude Code 에서 /mcp 로 확인 (도구 ned_attention·ned_sessions·…)"

echo "## app"
if pids="$(pgrep -x Ned)"; then echo "  Ned running (pid $(echo $pids))"; else echo "  Ned not running"; fi

echo "## runtime"
REPO="$(defaults read "$DOMAIN" nedRepoPath 2>/dev/null || true)"
PV="$(version_of "$PLUGIN_ROOT")"
echo "  plugin   : $PV  ($PLUGIN_ROOT)"
# The session may still be running the version it loaded before `/plugin update` (see scripts/lib/plugin-check.mjs).
check="$(node "$(dirname "$0")/lib/plugin-check.mjs" "$PLUGINS_DIR" "$PLUGIN_ROOT" 2>&1)"; rc=$?
case "$rc" in
  3|4) echo "  ⚠ 로드된 플러그인이 설치본과 다름 — /reload-plugins(또는 새 세션) 후 다시 확인 ($check)" ;;
  *) echo "  plugin check: $check" ;;
esac
if [ -z "$REPO" ]; then
  echo "  nedRepoPath: (unset in $DOMAIN) — /ned:install 을 아직 안 돌림"
else
  RV="$(version_of "$REPO")"
  echo "  nedRepoPath: $REPO"
  echo "  runtime  : $RV$([ -f "$REPO/.ned-runtime" ] && sed -n 's/^synced=/, synced /p' "$REPO/.ned-runtime")"
  [ -f "$REPO/packages/daemon/dist/cli.js" ] || echo "  ! $REPO/packages/daemon/dist/cli.js 없음 — 빌드 안 됨"
  if [ "$RV" != "$PV" ]; then echo "  ⚠ 업데이트 필요: 런타임 $RV ≠ 플러그인 $PV → /ned:install"; else echo "  ✓ 런타임이 플러그인 버전과 같음"; fi
fi

echo "## log ($NED_HOME/logs/app-daemon.log, last 10)"
if [ -f "$NED_HOME/logs/app-daemon.log" ]; then tail -n 10 "$NED_HOME/logs/app-daemon.log" | sed 's/^/  /'; else echo "  (none)"; fi

echo "## old settings.json hooks ($SETTINGS)"
if [ -f "$SETTINGS" ]; then
  n="$(node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    let n = 0;
    for (const groups of Object.values(s.hooks ?? {})) for (const g of groups ?? []) if ((g.hooks ?? []).some((h) => String(h.command ?? "").includes("ned-hook.sh"))) n++;
    console.log(n);' "$SETTINGS" 2>/dev/null || echo "?")"
  if [ "$n" = "0" ]; then echo "  none ✓"
  else echo "  ⚠ $n Ned hook entr$([ "$n" = 1 ] && echo y || echo ies) left — plugin hooks + these = events logged twice. /ned:install removes them."; fi
else
  echo "  (no settings file)"
fi
