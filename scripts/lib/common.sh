# Shared by scripts/install.sh and scripts/uninstall.sh (sourced, bash). Resolves the environment and refuses
# paths a mistake in NED_* could turn into an rm -rf of something that isn't Ned's.
# Expects: SRC (repo/plugin root, physical path). Sets: NED_HOME DEST DOMAIN ISOLATED RUNTIME NEXT PREV.

DEFAULT_DEST="/Applications/Ned.app"
DEFAULT_DOMAIN="com.ned.menubar"
NED_HOME="${NED_HOME:-$HOME/.ned}"
DEST="${NED_APP_DEST:-$DEFAULT_DEST}"
DOMAIN="${NED_DEFAULTS_DOMAIN:-$DEFAULT_DOMAIN}"
HOME_REAL="$(cd "$HOME" 2>/dev/null && pwd -P || echo "$HOME")"

die() { echo "✗ $*"; exit 1; }

# A test run changes both the app path and the defaults domain, or neither: with only one changed, an
# "isolated" run would still overwrite /Applications/Ned.app or the real app's nedRepoPath.
check_isolation() {
  local d=0 m=0
  [ "$DEST" = "$DEFAULT_DEST" ] || d=1
  [ "$DOMAIN" = "$DEFAULT_DOMAIN" ] || m=1
  if [ "$d" != "$m" ]; then
    die "격리 실행은 NED_APP_DEST 와 NED_DEFAULTS_DOMAIN 을 둘 다 바꿔야 함 (지금: app=$DEST, defaults=$DOMAIN)"
  fi
  ISOLATED=""
  if [ "$d" = 1 ]; then ISOLATED=1; fi
}

# NED_APP_DEST: an absolute path to a *.app, not /, $HOME, the source tree or a path with "..".
check_dest() {
  case "$DEST" in
    /*.app) ;;
    *) die "NED_APP_DEST 는 절대 경로의 .app 이어야 함: $DEST" ;;
  esac
  case "$DEST" in
    */../*|*/./*|*/..|*//*) die "NED_APP_DEST 에 '..'·'.'·'//' 를 쓸 수 없음: $DEST" ;;
  esac
  case "$DEST" in
    /|"$HOME"|"$HOME_REAL"|"$SRC") die "NED_APP_DEST 로 쓸 수 없는 경로: $DEST" ;;
    "$SRC"/*) die "NED_APP_DEST 가 소스 안에 있음: $DEST" ;;
  esac
}

# Runtime dir and its .next/.prev siblings: absolute, physical, not /, $HOME, the source or inside it, not an
# ancestor of the source; when they exist and aren't empty they must carry the .ned-runtime marker.
resolve_runtime() {
  local r="$1" parent base
  case "$r" in /*) ;; *) die "NED_RUNTIME_DIR 는 절대 경로여야 함: $r" ;; esac
  parent="$(dirname "$r")"
  base="$(basename "$r")"
  case "$base" in ""|"/"|"."|"..") die "NED_RUNTIME_DIR 로 쓸 수 없는 경로: $r" ;; esac
  mkdir -p "$parent"
  RUNTIME="$(cd "$parent" && pwd -P)/$base"
  NEXT="$RUNTIME.next"
  PREV="$RUNTIME.prev"
  local d
  for d in "$RUNTIME" "$NEXT" "$PREV"; do check_runtime_dir "$d"; done
  case "$DEST" in "$RUNTIME"/*|"$NEXT"/*|"$PREV"/*) die "NED_APP_DEST 가 런타임 안에 있음: $DEST" ;; esac
}
check_runtime_dir() {
  local d="$1"
  case "$d" in
    /|"$HOME"|"$HOME_REAL"|"$SRC") die "런타임 경로로 쓸 수 없음: $d" ;;
    "$SRC"/*) die "런타임 경로가 소스 안에 있음: $d" ;;
  esac
  case "$SRC/" in "$d"/*) die "소스가 런타임 경로 안에 있음: $SRC (런타임 $d)" ;; esac
  if [ -e "$d" ] && [ ! -d "$d" ]; then die "$d 가 디렉터리가 아님"; fi
  if [ -d "$d" ] && [ -n "$(ls -A "$d" 2>/dev/null)" ] && [ ! -f "$d/.ned-runtime" ]; then
    die "$d 가 비어 있지 않고 Ned 런타임 표시(.ned-runtime)가 없음 — 다른 경로를 NED_RUNTIME_DIR 로 주거나 비우세요."
  fi
}

# Stop the Ned that runs from $DEST. The real install quits by bundle id (the app stops its daemon child);
# an isolated run only kills a process started from its own bundle path.
quit_app() {
  if [ -z "$ISOLATED" ]; then
    osascript -e 'tell application id "com.ned.menubar" to quit' >/dev/null 2>&1 || true
    local _
    for _ in 1 2 3 4 5; do pgrep -x Ned >/dev/null 2>&1 || break; sleep 1; done
    pkill -x Ned 2>/dev/null || true
  else
    pkill -f "^$DEST/Contents/MacOS/Ned" 2>/dev/null || true
  fi
}
