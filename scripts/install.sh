#!/usr/bin/env bash
# Install (or update — same command, idempotent) Ned on this Mac: deps → build daemon → Ned.app → hooks.
# Ned.app supervises the daemon itself (spawns `node packages/daemon/dist/cli.js run` under `nedRepoPath`,
# restarts it, stops it on quit), so the old com.ned.daemon LaunchAgent is removed if present.
# Autostart: dashboard 설정 → 앱(Ned.app) → "로그인할 때 Ned 실행".
#
# Two modes:
#   plugin  (NED_PLUGIN_MODE=1, what /ned:install runs): the source is the plugin cache
#           (~/.claude/plugins/cache/ned/ned/<version>/), which moves on every plugin update and is deleted
#           14 days later. The source is built in a fresh "$RUNTIME.next" and swapped in for the fixed runtime
#           dir only once everything built — a failed build leaves the installed runtime and app untouched.
#           Hooks come from the plugin's hooks/hooks.json; old absolute-path Ned hooks in
#           ~/.claude/settings.json are removed so events aren't logged twice.
#           Refuses to run from a plugin version Claude Code has already replaced (scripts/lib/plugin-check.mjs)
#           — after `/plugin update ned`, run /reload-plugins (or start a new session) first.
#   direct  (default, for development from a clone): build in the checkout itself and register hooks in
#           ~/.claude/settings.json (packages/hook/install-hooks.mjs). Set NED_RUNTIME_DIR to build into a
#           runtime dir as in plugin mode.
#
# Environment (all optional):
#   NED_HOME                 data dir (default ~/.ned) — logs (this run: $NED_HOME/logs/install.log), config
#   NED_RUNTIME_DIR          where plugin mode builds (default $NED_HOME/runtime; absolute)
#   NED_APP_DEST             app bundle destination (default /Applications/Ned.app; absolute *.app)
#   NED_DEFAULTS_DOMAIN      defaults domain for nedRepoPath (default com.ned.menubar)
#   NED_PLUGIN_MODE=1        plugin mode (above)
#   NED_SKIP_HOOK_MIGRATION=1  plugin mode: leave ~/.claude/settings.json alone
#   NED_CLAUDE_SETTINGS      settings file the hook step edits (default ~/.claude/settings.json)
#   NED_CLAUDE_PLUGINS_DIR   Claude Code plugins dir read for the version check (default ~/.claude/plugins)
#   NED_SKIP_OPEN=1          don't launch the app at the end
#   NED_SIGN_IDENTITY        code-signing identity (see apps/menubar/scripts/package.sh)
# Isolated runs (smoke tests) change NED_APP_DEST and NED_DEFAULTS_DOMAIN together (one alone is refused):
# they neither quit the installed Ned.app nor touch the legacy LaunchAgent.
# Test hooks (packages/daemon/test/install-scripts.test.ts): NED_SKIP_PREFLIGHT=1, NED_TEST_FAKE_BUILD=1
# (stand-in build products instead of pnpm/tsc/swift), NED_FAIL_AT=sync|build|package|swap.
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd -P)"
# shellcheck source=lib/common.sh
. "$SRC/scripts/lib/common.sh"
PLUGIN_MODE="${NED_PLUGIN_MODE:-}"
PLUGINS_DIR="${NED_CLAUDE_PLUGINS_DIR:-$HOME/.claude/plugins}"
PLIST="$HOME/Library/LaunchAgents/com.ned.daemon.plist"
FAKE="${NED_TEST_FAKE_BUILD:-}"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

mkdir -p "$NED_HOME/logs"
LOG="$NED_HOME/logs/install.log"
exec > >(tee "$LOG") 2>&1

fail_at() { if [ "${NED_FAIL_AT:-}" = "$1" ]; then echo "✗ NED_FAIL_AT=$1 (test)"; return 1; fi; }

# Failure anywhere before the swap commits: drop what this run built, put the old runtime back if it was
# already moved aside. The installed runtime and app stay as they were.
NEXT_OWNED="" STAGE="" SWAPPED="" COMMITTED=""
on_exit() {
  local rc=$?
  [ "$rc" = 0 ] && return 0
  [ -n "$NEXT_OWNED" ] && rm -rf "$NEXT"
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  if [ -n "$SWAPPED" ] && [ -z "$COMMITTED" ] && [ -d "$PREV" ]; then
    rm -rf "$RUNTIME" && mv "$PREV" "$RUNTIME" && echo "  런타임을 이전 것으로 되돌림"
  fi
  echo "✗ 설치 실패 (exit $rc) — 기존 설치는 유지됨. 원인을 고친 뒤 /ned:install 을 다시 실행하세요. 로그: $LOG"
  return "$rc"
}
trap on_exit EXIT

check_isolation
check_dest
RUNTIME=""
if [ -n "$PLUGIN_MODE" ] || [ -n "${NED_RUNTIME_DIR:-}" ]; then resolve_runtime "${NED_RUNTIME_DIR:-$NED_HOME/runtime}"; fi

echo "▶ Ned install ($([ -n "$PLUGIN_MODE" ] && echo plugin || echo direct) mode${ISOLATED:+, isolated})"
echo "  source      : $SRC"
echo "  NED_HOME    : $NED_HOME"
echo "  runtime     : ${RUNTIME:-(build in source)}"
echo "  app         : $DEST"
echo "  defaults    : $DOMAIN"
echo "  log         : $LOG"

# ── plugin version check ────────────────────────────────────────────────────────────────────────────
if [ -n "$PLUGIN_MODE" ]; then
  echo "▶ plugin version"
  set +e
  check="$(node "$SRC/scripts/lib/plugin-check.mjs" "$PLUGINS_DIR" "$SRC")"; rc=$?
  set -e
  echo "  $check"
  case "$rc" in
    0) ;;
    3|4) die "이 세션이 로드한 플러그인($SRC)은 설치된 버전이 아님 — /plugin update 뒤라면 /reload-plugins(또는 새 세션) 후 다시 /ned:install" ;;
    *) die "plugin-check 실패 ($rc)" ;;
  esac
fi

# ── preflight ────────────────────────────────────────────────────────────────────────────────────────
echo "▶ preflight"
if [ -n "${NED_SKIP_PREFLIGHT:-}" ]; then
  echo "  skipped (NED_SKIP_PREFLIGHT)"
else
  missing=0
  need() { echo "  ✗ $1"; shift; for l in "$@"; do echo "      $l"; done; missing=1; }
  if ! command -v node >/dev/null; then
    need "node 없음 (22 이상 필요)" "nvm: https://github.com/nvm-sh/nvm 설치 후 nvm install 22 && nvm alias default 22" \
      "또는 brew install node@22 && brew link --force --overwrite node@22  (node@22 는 keg-only 라 link 필요)"
  else
    NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$NODE_MAJOR" -lt 22 ]; then need "node $(node -v) — 22 이상 필요" "nvm install 22 && nvm alias default 22"
    else echo "  ✓ node $(node -v)"; fi
  fi
  WANT_PNPM="$(node -p 'String(require(process.argv[1]).packageManager||"").replace(/^pnpm@/,"").split(".")[0]' "$SRC/package.json" 2>/dev/null || true)"
  if command -v pnpm >/dev/null; then
    PNPM_V="$(pnpm -v 2>/dev/null || echo '?')"
    echo "  ✓ pnpm $PNPM_V"
    if [ -n "$WANT_PNPM" ] && [ "${PNPM_V%%.*}" != "$WANT_PNPM" ]; then
      echo "    ! 이 레포는 pnpm $WANT_PNPM.x 기준(packageManager) — 설치가 실패하면: npm i -g pnpm@$WANT_PNPM"
    fi
  else
    need "pnpm 없음" "npm i -g pnpm@${WANT_PNPM:-latest}" "또는 corepack 이 있는 node 에서: corepack enable pnpm (Node 25+ 에는 corepack 이 기본 포함되지 않음)"
  fi
  if xcode-select -p >/dev/null 2>&1 && command -v swift >/dev/null; then echo "  ✓ swift ($(xcode-select -p))"
  else need "Xcode 명령줄 도구(swift) 없음 — Ned.app 을 이 Mac 에서 빌드하는 데 필요" "xcode-select --install"; fi
  if command -v claude >/dev/null; then echo "  ✓ claude $(claude --version 2>/dev/null | head -1)"
  else need "claude CLI 없음 — 브리핑이 claude -p 를 부름" "curl -fsSL https://claude.ai/install.sh | bash"; fi
  if [ "$missing" = 1 ]; then die "위 항목을 설치한 뒤 다시 실행하세요."; fi
fi
if [ -n "$RUNTIME" ] && ! command -v rsync >/dev/null; then die "rsync 없음"; fi

# ── build ───────────────────────────────────────────────────────────────────────────────────────────
fake_build() {   # NED_TEST_FAKE_BUILD: the files later steps need, without pnpm/tsc/swift
  mkdir -p "$1/packages/daemon/dist" "$1/apps/menubar/.build/Ned.app/Contents/MacOS"
  echo "// fake build $(date +%s)" > "$1/packages/daemon/dist/cli.js"
  printf '#!/bin/sh\nexit 0\n' > "$1/apps/menubar/.build/Ned.app/Contents/MacOS/Ned"
}
BUILD="$SRC"
if [ -n "$RUNTIME" ]; then
  echo "▶ runtime: build in $NEXT"
  # Leftovers of an interrupted earlier run (both carry the marker or are empty — checked above).
  if [ -d "$PREV" ] && [ ! -e "$RUNTIME" ]; then mv "$PREV" "$RUNTIME"; echo "  restored $RUNTIME from an interrupted swap"; fi
  rm -rf "$NEXT" "$PREV"
  mkdir -p "$NEXT"
  NEXT_OWNED=1
  # Fresh tree every time: no build output from an earlier version survives (deleted modules can't linger).
  rsync -a \
    --exclude node_modules --exclude .build --exclude dist --exclude .git --exclude .omc \
    --exclude /.ned-runtime --exclude /.orphaned_at \
    "$SRC/" "$NEXT/"
  printf 'source=%s\nsynced=%s\n' "$SRC" "$(date '+%Y-%m-%dT%H:%M:%S%z')" > "$NEXT/.ned-runtime"
  echo "  synced (version $(node -p 'require(process.argv[1]).version' "$NEXT/.claude-plugin/plugin.json" 2>/dev/null || echo '?'))"
  fail_at sync
  BUILD="$NEXT"
fi

echo "▶ deps + build"
if [ -n "$FAKE" ]; then
  fake_build "$BUILD"; echo "  (fake build)"
elif [ -n "$RUNTIME" ]; then
  # A release builds from its lockfile; no prompt to purge node_modules after a pnpm upgrade.
  (cd "$BUILD" && pnpm install --frozen-lockfile --silent --config.confirm-modules-purge=false && pnpm -r build)
else
  (cd "$BUILD" && pnpm install --silent && pnpm -r build)
fi
fail_at build

echo "▶ Ned.app build"
if [ -n "$FAKE" ]; then
  echo "  (fake build)"
else
  if [ -z "${NED_SIGN_IDENTITY:-}" ] && ! { security find-identity -v -p codesigning 2>/dev/null || true; } | grep '"Ned Local Signing"' >/dev/null; then
    echo "  ! 유효한 서명 인증서 없음(없거나 신뢰 안 됨) → ad-hoc 서명: 매 설치마다 macOS 가 권한(문서 폴더 등)을 다시 묻게 됨."
    echo "    한 번만: bash ${RUNTIME:-$SRC}/scripts/make-signing-cert.sh  (apps/menubar/README.md 'macOS 가 권한을 매번 다시 물으면' 참고)"
  fi
  bash "$BUILD/apps/menubar/scripts/package.sh"
fi
fail_at package

COPY_APP=1
if [ -d "$DEST" ] && [ -t 0 ]; then
  answer="y"
  read -r -p "  $DEST exists. Overwrite? [Y/n] " answer || answer="y"
  case "${answer:-y}" in [nN]*) echo "  kept existing $DEST"; COPY_APP="" ;; esac
fi
if [ -n "$COPY_APP" ]; then
  STAGE="$DEST.next"
  rm -rf "$STAGE"
  mkdir -p "$(dirname "$DEST")"
  cp -R "$BUILD/apps/menubar/.build/Ned.app" "$STAGE"
fi

# ── swap: everything is built; from here it's quit → rename → copy ─────────────────────────────────────
echo "▶ swap"
quit_app
if [ -n "$RUNTIME" ]; then
  if [ -e "$RUNTIME" ]; then mv "$RUNTIME" "$PREV"; echo "  $RUNTIME → $(basename "$PREV")"; fi
  SWAPPED=1
  mv "$NEXT" "$RUNTIME"
  NEXT_OWNED=""
  echo "  $(basename "$NEXT") → $RUNTIME"
  BUILD="$RUNTIME"
fi
fail_at swap
if [ -n "$COPY_APP" ]; then
  rm -rf "$DEST"
  mv "$STAGE" "$DEST"
  STAGE=""
  echo "  app → $DEST"
fi
# An installed Ned.app has no repo ancestor, so tell it where the daemon lives.
defaults write "$DOMAIN" nedRepoPath "$BUILD"
echo "  nedRepoPath = $BUILD ($DOMAIN)"
COMMITTED=1
if [ -n "$RUNTIME" ] && [ -d "$PREV" ]; then rm -rf "$PREV"; echo "  removed $(basename "$PREV")"; fi

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

if [ -n "${NED_SKIP_OPEN:-}" ]; then
  echo "  not opening (NED_SKIP_OPEN)"
else
  open "$DEST" --args --dashboard
fi

echo
echo "✓ Ned installed."
echo "  app       : $DEST  (autostart: 대시보드 설정 → 앱(Ned.app))"
echo "  daemon    : $BUILD/packages/daemon/dist/cli.js"
echo "  dashboard : http://127.0.0.1:7777  (or 메뉴 > 대시보드 열기)"
echo "  config    : $NED_HOME/config.yaml"
echo "  logs      : $NED_HOME/logs/app-daemon.log (supervisor + daemon output), $NED_HOME/logs/daemon.log"
if [ -n "$PLUGIN_MODE" ]; then
  echo "  update    : /plugin update ned → /reload-plugins (또는 새 세션) → /ned:install     uninstall : /ned:uninstall"
  echo "  hooks     : 플러그인 훅은 새 세션(또는 /reload-plugins)부터 기록됨"
else
  echo "  uninstall : scripts/uninstall.sh"
fi
echo "  macOS 26+ : if the glasses icon is hidden, allow Ned under System Settings > Menu Bar"
