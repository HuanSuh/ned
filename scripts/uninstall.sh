#!/usr/bin/env bash
# Remove Ned: quit the app (which stops the daemon it supervises), delete the app bundle, the legacy
# LaunchAgent and the build runtime. Leaves $NED_HOME (data, config, logs) — only $NED_HOME/runtime goes.
#
# Same environment as scripts/install.sh: NED_HOME, NED_RUNTIME_DIR, NED_APP_DEST, NED_DEFAULTS_DOMAIN,
# NED_PLUGIN_MODE, NED_CLAUDE_SETTINGS. Plugin mode (what /ned:uninstall runs) leaves ~/.claude/settings.json alone — the plugin's
# hooks go with `/plugin uninstall ned`. Direct mode removes the settings.json hooks as before.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
DEFAULT_DEST="/Applications/Ned.app"
DEFAULT_DOMAIN="com.ned.menubar"
NED_HOME="${NED_HOME:-$HOME/.ned}"
DEST="${NED_APP_DEST:-$DEFAULT_DEST}"
DOMAIN="${NED_DEFAULTS_DOMAIN:-$DEFAULT_DOMAIN}"
RUNTIME="${NED_RUNTIME_DIR:-$NED_HOME/runtime}"
PLIST="$HOME/Library/LaunchAgents/com.ned.daemon.plist"
ISOLATED=""
if [ "$DEST" != "$DEFAULT_DEST" ] || [ "$DOMAIN" != "$DEFAULT_DOMAIN" ]; then ISOLATED=1; fi

echo "▶ Ned uninstall ($([ -n "${NED_PLUGIN_MODE:-}" ] && echo plugin || echo direct) mode${ISOLATED:+, isolated})"
echo "  NED_HOME : $NED_HOME   runtime : $RUNTIME   app : $DEST   defaults : $DOMAIN"

echo "▶ quit Ned.app"
if [ -z "$ISOLATED" ]; then
  osascript -e 'tell application id "com.ned.menubar" to quit' >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do pgrep -x Ned >/dev/null || break; sleep 1; done
  pkill -x Ned 2>/dev/null || true   # SIGTERM: the app still stops its daemon child
else
  pkill -f "^$DEST/Contents/MacOS/Ned" 2>/dev/null || true
fi

echo "▶ legacy LaunchAgent"
if [ -z "$ISOLATED" ]; then
  launchctl bootout "gui/$(id -u)/com.ned.daemon" 2>/dev/null || true
  rm -f "$PLIST"
else
  echo "  skipped (isolated)"
fi

echo "▶ app"
rm -rf "$DEST"

echo "▶ Claude Code hooks"
if [ -n "${NED_PLUGIN_MODE:-}" ]; then
  echo "  left alone — the plugin's hooks are removed by: /plugin uninstall ned"
else
  if [ -n "${NED_CLAUDE_SETTINGS:-}" ]; then
    node "$SRC/packages/hook/install-hooks.mjs" --uninstall --settings "$NED_CLAUDE_SETTINGS" | sed 's/^/  /'
  else
    node "$SRC/packages/hook/install-hooks.mjs" --uninstall | sed 's/^/  /'
  fi
fi

echo "▶ runtime"
if [ -f "$RUNTIME/.ned-runtime" ]; then
  RUNTIME="$(cd "$RUNTIME" && pwd -P)"
  case "$RUNTIME" in
    /|"$HOME"|"$SRC") echo "  ✗ refusing to delete $RUNTIME" ;;
    *) rm -rf "$RUNTIME"; echo "  removed $RUNTIME" ;;
  esac
else
  echo "  none ($RUNTIME has no .ned-runtime marker)"
fi
if [ "$(defaults read "$DOMAIN" nedRepoPath 2>/dev/null || true)" = "$RUNTIME" ]; then
  defaults delete "$DOMAIN" nedRepoPath 2>/dev/null || true
  echo "  cleared nedRepoPath ($DOMAIN)"
fi

echo
echo "✓ Ned removed. Data left in $NED_HOME (rm -rf $NED_HOME to delete it)."
echo "  If Ned was a Login Item, it disappears from System Settings > General > Login Items once the app is gone."
if [ -n "${NED_PLUGIN_MODE:-}" ]; then echo "  Next: /plugin uninstall ned  (removes the session hooks and /ned:* commands)"; fi
