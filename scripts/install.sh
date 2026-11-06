#!/usr/bin/env bash
# Install Ned end to end: deps → build daemon → Claude Code hooks → LaunchAgent → menu bar app.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
CLAUDE_DIR="$(dirname "$(command -v claude)")"
PLIST="$HOME/Library/LaunchAgents/com.ned.daemon.plist"
mkdir -p "$HOME/.ned/logs" "$HOME/Library/LaunchAgents"

echo "▶ deps + build"
(cd "$REPO" && pnpm install --silent && pnpm -r build)

echo "▶ Claude Code hooks"
node "$REPO/packages/hook/install-hooks.mjs"

echo "▶ LaunchAgent"
sed -e "s|__NODE__|$NODE|g" -e "s|__REPO__|$REPO|g" -e "s|__HOME__|$HOME|g" \
    -e "s|__PATH__|$CLAUDE_DIR:$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin|g" \
    "$REPO/scripts/com.ned.daemon.plist.template" > "$PLIST"
launchctl bootout "gui/$(id -u)/com.ned.daemon" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/com.ned.daemon"

echo "▶ menu bar app"
bash "$REPO/apps/menubar/scripts/package.sh"
APP="$REPO/apps/menubar/.build/Ned.app"
pkill -x Ned 2>/dev/null || true
open "$APP"

echo
echo "✓ Ned installed."
echo "  dashboard : http://127.0.0.1:7777"
echo "  config    : ~/.ned/config.yaml"
echo "  logs      : ~/.ned/logs/daemon.log"
echo "  menu bar  : $APP   (add to Login Items to autostart)"
echo "  macOS 26+ : if the glasses icon is hidden, allow Ned under System Settings > Menu Bar"
