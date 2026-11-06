#!/usr/bin/env bash
# Remove Ned: quit the app (which stops the daemon it supervises), delete /Applications/Ned.app,
# remove the Claude Code hooks and any legacy LaunchAgent. Leaves ~/.ned (data, config, logs).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="/Applications/Ned.app"
PLIST="$HOME/Library/LaunchAgents/com.ned.daemon.plist"

echo "▶ quit Ned.app"
osascript -e 'tell application id "com.ned.menubar" to quit' >/dev/null 2>&1 || true
for _ in 1 2 3 4 5; do pgrep -x Ned >/dev/null || break; sleep 1; done
pkill -x Ned 2>/dev/null || true   # SIGTERM: the app still stops its daemon child

echo "▶ legacy LaunchAgent"
launchctl bootout "gui/$(id -u)/com.ned.daemon" 2>/dev/null || true
rm -f "$PLIST"

echo "▶ app"
rm -rf "$DEST"

echo "▶ Claude Code hooks"
node "$REPO/packages/hook/install-hooks.mjs" --uninstall

echo
echo "✓ Ned removed. Data left in ~/.ned (rm -rf ~/.ned to delete it)."
echo "  If Ned was a Login Item, it disappears from System Settings > General > Login Items once the app is gone."
