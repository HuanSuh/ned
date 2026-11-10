#!/usr/bin/env bash
# Remove Ned: quit the app (which stops the daemon it supervises), delete the app bundle, the legacy
# LaunchAgent and the build runtime. Leaves $NED_HOME (data, config, logs) — only $NED_HOME/runtime goes.
#
# Same environment and path checks as scripts/install.sh (scripts/lib/common.sh): NED_HOME, NED_RUNTIME_DIR,
# NED_APP_DEST, NED_DEFAULTS_DOMAIN, NED_PLUGIN_MODE, NED_CLAUDE_SETTINGS. Plugin mode (what /ned:uninstall runs)
# leaves ~/.claude/settings.json alone — the plugin's hooks go with `/plugin uninstall ned`. Direct mode removes
# the settings.json hooks as before. A runtime dir without the .ned-runtime marker is never deleted.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=lib/common.sh
. "$SRC/scripts/lib/common.sh"
PLIST="$HOME/Library/LaunchAgents/com.ned.daemon.plist"

check_isolation
check_dest
RUNTIME_IN="${NED_RUNTIME_DIR:-$NED_HOME/runtime}"
case "$RUNTIME_IN" in /*) ;; *) die "NED_RUNTIME_DIR 는 절대 경로여야 함: $RUNTIME_IN" ;; esac
if [ -d "$(dirname "$RUNTIME_IN")" ]; then
  RUNTIME="$(cd "$(dirname "$RUNTIME_IN")" && pwd -P)/$(basename "$RUNTIME_IN")"
else
  RUNTIME="$RUNTIME_IN"
fi

echo "▶ Ned uninstall ($([ -n "${NED_PLUGIN_MODE:-}" ] && echo plugin || echo direct) mode${ISOLATED:+, isolated})"
echo "  NED_HOME : $NED_HOME   runtime : $RUNTIME   app : $DEST   defaults : $DOMAIN"

echo "▶ quit Ned.app"
quit_app

echo "▶ legacy LaunchAgent"
if [ -z "$ISOLATED" ]; then
  launchctl bootout "gui/$(id -u)/com.ned.daemon" 2>/dev/null || true
  rm -f "$PLIST"
else
  echo "  skipped (isolated)"
fi

echo "▶ app"
if [ -e "$DEST" ]; then rm -rf "$DEST"; echo "  removed $DEST"; else echo "  none"; fi
rm -rf "$DEST.next"

echo "▶ Claude Code hooks"
if [ -n "${NED_PLUGIN_MODE:-}" ]; then
  echo "  left alone — the plugin's hooks are removed by: /plugin uninstall ned"
elif [ -n "${NED_CLAUDE_SETTINGS:-}" ]; then
  node "$SRC/packages/hook/install-hooks.mjs" --uninstall --settings "$NED_CLAUDE_SETTINGS" | sed 's/^/  /'
else
  node "$SRC/packages/hook/install-hooks.mjs" --uninstall | sed 's/^/  /'
fi

echo "▶ runtime"
for d in "$RUNTIME" "$RUNTIME.next" "$RUNTIME.prev"; do
  [ -e "$d" ] || continue
  case "$d" in
    /|"$HOME"|"$HOME_REAL"|"$SRC"|"$SRC"/*) echo "  ✗ refusing to delete $d"; continue ;;
  esac
  case "$SRC/" in "$d"/*) echo "  ✗ refusing to delete $d (contains the source)"; continue ;; esac
  if [ -f "$d/.ned-runtime" ]; then rm -rf "$d"; echo "  removed $d"
  else echo "  kept $d (no .ned-runtime marker — not Ned's)"; fi
done
if [ "$(defaults read "$DOMAIN" nedRepoPath 2>/dev/null || true)" = "$RUNTIME" ]; then
  defaults delete "$DOMAIN" nedRepoPath 2>/dev/null || true
  echo "  cleared nedRepoPath ($DOMAIN)"
fi

echo
echo "✓ Ned removed. Data left in $NED_HOME (rm -rf $NED_HOME to delete it)."
echo "  If Ned was a Login Item, it disappears from System Settings > General > Login Items once the app is gone."
if [ -n "${NED_PLUGIN_MODE:-}" ]; then echo "  Next: /plugin uninstall ned  (removes the session hooks and /ned:* commands)"; fi
