#!/usr/bin/env bash
# Install (or update — same command, idempotent) Ned on this Mac: deps → build daemon → hooks → Ned.app.
# Ned.app supervises the daemon itself (spawns `node packages/daemon/dist/cli.js run` under `nedRepoPath`,
# restarts it, stops it on quit), so the old com.ned.daemon LaunchAgent is removed if present.
# Autostart: turn on "Login Items 에 등록" in the menu.
#
# Two modes:
#   plugin  (NED_PLUGIN_MODE=1, what /ned:install runs): the source is the plugin cache
#           (~/.claude/plugins/cache/ned/ned/<version>/), which moves on every plugin update and is deleted
#           14 days later. So the source is synced to a fixed runtime dir and built there, and the app points
#           at that. Hooks come from the plugin's hooks/hooks.json; old absolute-path Ned hooks in
#           ~/.claude/settings.json are removed so events aren't logged twice.
#   direct  (default, for development from a clone): build in the checkout itself and register hooks in
#           ~/.claude/settings.json (packages/hook/install-hooks.mjs). Set NED_RUNTIME_DIR to build in a
#           runtime dir here too.
#
# Environment (all optional):
#   NED_HOME                 data dir (default ~/.ned) — logs, config; the default runtime dir lives under it
#   NED_RUNTIME_DIR          where plugin mode builds (default $NED_HOME/runtime)
#   NED_APP_DEST             app bundle destination (default /Applications/Ned.app)
#   NED_DEFAULTS_DOMAIN      defaults domain for nedRepoPath (default com.ned.menubar)
#   NED_PLUGIN_MODE=1        plugin mode (above)
#   NED_SKIP_HOOK_MIGRATION=1  plugin mode: leave ~/.claude/settings.json alone
#   NED_CLAUDE_SETTINGS      settings file the hook step edits (default ~/.claude/settings.json) — smoke tests
#   NED_SKIP_OPEN=1          don't launch the app at the end
#   NED_SIGN_IDENTITY        code-signing identity (see apps/menubar/scripts/package.sh)
# With a non-default NED_APP_DEST or NED_DEFAULTS_DOMAIN the run is "isolated" (smoke tests): it neither
# quits the installed Ned.app nor touches the legacy LaunchAgent, and only stops a Ned running from NED_APP_DEST.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
DEFAULT_DEST="/Applications/Ned.app"
DEFAULT_DOMAIN="com.ned.menubar"
NED_HOME="${NED_HOME:-$HOME/.ned}"
DEST="${NED_APP_DEST:-$DEFAULT_DEST}"
DOMAIN="${NED_DEFAULTS_DOMAIN:-$DEFAULT_DOMAIN}"
PLUGIN_MODE="${NED_PLUGIN_MODE:-}"
PLIST="$HOME/Library/LaunchAgents/com.ned.daemon.plist"
ISOLATED=""
if [ "$DEST" != "$DEFAULT_DEST" ] || [ "$DOMAIN" != "$DEFAULT_DOMAIN" ]; then ISOLATED=1; fi
if [ -n "$PLUGIN_MODE" ] || [ -n "${NED_RUNTIME_DIR:-}" ]; then
  RUNTIME="${NED_RUNTIME_DIR:-$NED_HOME/runtime}"
else
  RUNTIME=""
fi

echo "▶ Ned install ($([ -n "$PLUGIN_MODE" ] && echo plugin || echo direct) mode${ISOLATED:+, isolated})"
echo "  source      : $SRC"
echo "  NED_HOME    : $NED_HOME"
echo "  runtime     : ${RUNTIME:-(build in source)}"
echo "  app         : $DEST"
echo "  defaults    : $DOMAIN"

# ── preflight ────────────────────────────────────────────────────────────────────────────────────────
echo "▶ preflight"
missing=0
need() { echo "  ✗ $1"; shift; for l in "$@"; do echo "      $l"; done; missing=1; }
if ! command -v node >/dev/null; then
  need "node 없음 (22 이상 필요)" "nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash && nvm install 22" "또는 brew install node@22"
else
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$NODE_MAJOR" -lt 22 ]; then need "node $(node -v) — 22 이상 필요" "nvm install 22 && nvm alias default 22"
  else echo "  ✓ node $(node -v)"; fi
fi
if command -v pnpm >/dev/null; then echo "  ✓ pnpm $(pnpm -v)"
else need "pnpm 없음" "corepack enable   (node 에 포함 — 이 레포의 packageManager 버전을 씀)" "또는 npm i -g pnpm"; fi
if xcode-select -p >/dev/null 2>&1 && command -v swift >/dev/null; then echo "  ✓ swift ($(xcode-select -p))"
else need "Xcode 명령줄 도구(swift) 없음 — Ned.app 을 이 Mac 에서 빌드하는 데 필요" "xcode-select --install"; fi
if command -v claude >/dev/null; then echo "  ✓ claude $(claude --version 2>/dev/null | head -1)"
else need "claude CLI 없음 — 브리핑이 claude -p 를 부름" "https://code.claude.com/docs 의 설치 안내 (curl -fsSL https://claude.ai/install.sh | bash)"; fi
if [ "$missing" = 1 ]; then echo "✗ 위 항목을 설치한 뒤 다시 실행하세요."; exit 1; fi
if [ -n "$PLUGIN_MODE" ] && ! command -v rsync >/dev/null; then echo "✗ rsync 없음"; exit 1; fi

mkdir -p "$NED_HOME/logs"

# ── runtime sync (plugin mode) ───────────────────────────────────────────────────────────────────────
BUILD="$SRC"
if [ -n "$RUNTIME" ]; then
  echo "▶ runtime sync → $RUNTIME"
  mkdir -p "$RUNTIME"
  RUNTIME="$(cd "$RUNTIME" && pwd -P)"
  case "$RUNTIME" in
    /|"$HOME"|"$SRC") echo "✗ runtime dir $RUNTIME 은 쓸 수 없음"; exit 1 ;;
    "$SRC"/*) echo "✗ runtime dir 이 소스 안에 있음: $RUNTIME"; exit 1 ;;
  esac
  # --delete only into a dir that is empty or that an earlier run marked as Ned's runtime.
  if [ -n "$(ls -A "$RUNTIME" 2>/dev/null)" ] && [ ! -f "$RUNTIME/.ned-runtime" ]; then
    echo "✗ $RUNTIME 가 비어 있지 않고 Ned 런타임 표시(.ned-runtime)가 없음 — 다른 경로를 NED_RUNTIME_DIR 로 주거나 비우세요."
    exit 1
  fi
  # Excluded paths are kept on the receiving side too (no --delete-excluded): node_modules, .build and dist
  # (all gitignored build output) stay for fast incremental rebuilds, and the running daemon's dist/ isn't
  # deleted before tsc rewrites it.
  rsync -a --delete \
    --exclude node_modules --exclude .build --exclude dist --exclude .git --exclude .omc --exclude /.ned-runtime \
    "$SRC/" "$RUNTIME/"
  printf 'source=%s\nsynced=%s\n' "$SRC" "$(date '+%Y-%m-%dT%H:%M:%S%z')" > "$RUNTIME/.ned-runtime"
  echo "  synced (version $(node -p "require('$RUNTIME/.claude-plugin/plugin.json').version" 2>/dev/null || echo '?'))"
  BUILD="$RUNTIME"
fi

echo "▶ deps + build ($BUILD)"
if [ -n "$RUNTIME" ]; then
  # A release must build from its lockfile; no prompt to purge node_modules after a pnpm upgrade.
  (cd "$BUILD" && pnpm install --frozen-lockfile --silent --config.confirm-modules-purge=false && pnpm -r build)
else
  (cd "$BUILD" && pnpm install --silent && pnpm -r build)
fi

# ── hooks ───────────────────────────────────────────────────────────────────────────────────────────
SETTINGS_ARGS=()
if [ -n "${NED_CLAUDE_SETTINGS:-}" ]; then SETTINGS_ARGS=(--settings "$NED_CLAUDE_SETTINGS"); fi
if [ -n "$PLUGIN_MODE" ]; then
  echo "▶ Claude Code hooks: plugin hooks/hooks.json (old settings.json hooks → removed)"
  if [ -n "${NED_SKIP_HOOK_MIGRATION:-}" ]; then
    echo "  skipped (NED_SKIP_HOOK_MIGRATION)"
  else
    node "$BUILD/packages/hook/install-hooks.mjs" --uninstall ${SETTINGS_ARGS[@]+"${SETTINGS_ARGS[@]}"} | sed 's/^/  /'
  fi
else
  echo "▶ Claude Code hooks (settings.json)"
  node "$BUILD/packages/hook/install-hooks.mjs" ${SETTINGS_ARGS[@]+"${SETTINGS_ARGS[@]}"} | sed 's/^/  /'
fi

# ── legacy LaunchAgent ──────────────────────────────────────────────────────────────────────────────
echo "▶ legacy LaunchAgent"
if [ -n "$ISOLATED" ]; then
  echo "  skipped (isolated)"
elif [ -f "$PLIST" ] || launchctl print "gui/$(id -u)/com.ned.daemon" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/com.ned.daemon" 2>/dev/null || true
  rm -f "$PLIST"
  echo "  removed com.ned.daemon (Ned.app runs the daemon now)"
else
  echo "  none"
fi

# ── Ned.app ─────────────────────────────────────────────────────────────────────────────────────────
echo "▶ Ned.app"
if [ -z "${NED_SIGN_IDENTITY:-}" ] && ! { security find-identity -v -p codesigning 2>/dev/null || true; } | grep '"Ned Local Signing"' >/dev/null; then
  echo "  ! 유효한 서명 인증서 없음(없거나 신뢰 안 됨) → ad-hoc 서명: 매 설치마다 macOS 가 권한(문서 폴더 등)을 다시 묻게 됨."
  echo "    한 번만: bash $BUILD/scripts/make-signing-cert.sh  (apps/menubar/README.md 'macOS 가 권한을 매번 다시 물으면' 참고)"
fi
bash "$BUILD/apps/menubar/scripts/package.sh"
SKIP_COPY=""
if [ -d "$DEST" ]; then
  answer="y"
  if [ -t 0 ]; then read -r -p "  $DEST exists. Overwrite? [Y/n] " answer || answer="y"; fi
  case "${answer:-y}" in [nN]*) echo "  kept existing $DEST"; SKIP_COPY=1 ;; esac
fi
if [ -z "$SKIP_COPY" ]; then
  if [ -z "$ISOLATED" ]; then
    osascript -e 'tell application id "com.ned.menubar" to quit' >/dev/null 2>&1 || true
    pkill -x Ned 2>/dev/null || true
    sleep 1
  else
    pkill -f "^$DEST/Contents/MacOS/Ned" 2>/dev/null || true
  fi
  rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  cp -R "$BUILD/apps/menubar/.build/Ned.app" "$DEST"
  echo "  copied → $DEST"
fi
# An installed Ned.app has no repo ancestor, so tell it where the daemon lives.
defaults write "$DOMAIN" nedRepoPath "$BUILD"
echo "  nedRepoPath = $BUILD ($DOMAIN)"
if [ -n "${NED_SKIP_OPEN:-}" ]; then
  echo "  not opening (NED_SKIP_OPEN)"
else
  open "$DEST" --args --dashboard
fi

echo
echo "✓ Ned installed."
echo "  app       : $DEST  (menu: 'Login Items 에 등록' to autostart)"
echo "  daemon    : $BUILD/packages/daemon/dist/cli.js"
echo "  dashboard : http://127.0.0.1:7777  (or 메뉴 > 대시보드)"
echo "  config    : $NED_HOME/config.yaml"
echo "  logs      : $NED_HOME/logs/app-daemon.log (supervisor + daemon output), $NED_HOME/logs/daemon.log"
if [ -n "$PLUGIN_MODE" ]; then
  echo "  update    : /plugin update ned → /ned:install     uninstall : /ned:uninstall"
  echo "  hooks     : 플러그인 훅은 새 세션(또는 /reload-plugins)부터 기록됨"
else
  echo "  uninstall : scripts/uninstall.sh"
fi
echo "  macOS 26+ : if the glasses icon is hidden, allow Ned under System Settings > Menu Bar"
