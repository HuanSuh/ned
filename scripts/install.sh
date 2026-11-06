#!/usr/bin/env bash
# Install Ned end to end: deps → build daemon → Claude Code hooks → /Applications/Ned.app.
# Ned.app supervises the daemon itself (spawns `node packages/daemon/dist/cli.js run`, restarts it,
# stops it on quit), so the old com.ned.daemon LaunchAgent is removed if present.
# Autostart: turn on "Login Items 에 등록" in the menu.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="/Applications/Ned.app"
PLIST="$HOME/Library/LaunchAgents/com.ned.daemon.plist"
command -v node >/dev/null || { echo "✗ node not on PATH"; exit 1; }
command -v claude >/dev/null || echo "! claude not on PATH — briefings will fail until it is"
mkdir -p "$HOME/.ned/logs"

echo "▶ deps + build"
(cd "$REPO" && pnpm install --silent && pnpm -r build)

echo "▶ Claude Code hooks"
node "$REPO/packages/hook/install-hooks.mjs"

echo "▶ legacy LaunchAgent"
if [ -f "$PLIST" ] || launchctl print "gui/$(id -u)/com.ned.daemon" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.ned.daemon" 2>/dev/null || true
  rm -f "$PLIST"
  echo "  removed com.ned.daemon (Ned.app runs the daemon now)"
else
  echo "  none"
fi

echo "▶ Ned.app"
if [ -z "${NED_SIGN_IDENTITY:-}" ] && ! { security find-identity -v -p codesigning 2>/dev/null || true; } | grep '"Ned Local Signing"' >/dev/null; then
  echo "  ! 유효한 서명 인증서 없음(없거나 신뢰 안 됨) → ad-hoc 서명: 매 설치마다 macOS 가 권한(문서 폴더 등)을 다시 묻게 됨."
  echo "    한 번만: bash $REPO/scripts/make-signing-cert.sh  (README 'macOS 가 권한을 매번 다시 물으면' 참고)"
fi
bash "$REPO/apps/menubar/scripts/package.sh"
if [ -d "$DEST" ]; then
  answer="y"
  if [ -t 0 ]; then read -r -p "  $DEST exists. Overwrite? [Y/n] " answer || answer="y"; fi
  case "${answer:-y}" in [nN]*) echo "  kept existing $DEST"; SKIP_COPY=1 ;; esac
fi
if [ -z "${SKIP_COPY:-}" ]; then
  osascript -e 'tell application id "com.ned.menubar" to quit' >/dev/null 2>&1 || true
  pkill -x Ned 2>/dev/null || true
  sleep 1
  rm -rf "$DEST"
  cp -R "$REPO/apps/menubar/.build/Ned.app" "$DEST"
fi
# /Applications/Ned.app has no repo ancestor, so tell it where the daemon lives.
defaults write com.ned.menubar nedRepoPath "$REPO"
open "$DEST" --args --dashboard

echo
echo "✓ Ned installed."
echo "  app       : $DEST  (menu: 'Login Items 에 등록' to autostart)"
echo "  dashboard : http://127.0.0.1:7777  (or 메뉴 > 대시보드)"
echo "  config    : ~/.ned/config.yaml"
echo "  logs      : ~/.ned/logs/app-daemon.log (supervisor + daemon output), ~/.ned/logs/daemon.log"
echo "  uninstall : scripts/uninstall.sh"
echo "  macOS 26+ : if the glasses icon is hidden, allow Ned under System Settings > Menu Bar"
