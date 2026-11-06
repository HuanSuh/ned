#!/usr/bin/env bash
# Rasterize a 64×64 mark SVG into an .icns (padded to Apple's ~824/1024 icon grid first).
#   scripts/make-icon.sh                          # Resources/marks/ned.svg -> Resources/Ned.icns (bundle icon)
#   scripts/make-icon.sh <in.svg> <OutName>       # -> Resources/<OutName>.icns
#   scripts/make-icon.sh --all                    # Ned.icns + Ned-<id>.icns for every other Resources/marks/<id>.svg
# Persona icons (Ned-alfred.icns …) are set at runtime via NSApp.applicationIconImage; Finder,
# Login Items and notification banners keep the bundle's Ned.icns (CFBundleIconFile).
# Uses rsvg-convert when present (brew install librsvg), else qlmanage + sips. Needs iconutil (Xcode CLT).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--all" ]]; then
  "$0" Resources/marks/ned.svg Ned
  for svg in Resources/marks/*.svg; do
    id="$(basename "$svg" .svg)"; [[ "$id" == ned ]] && continue
    "$0" "$svg" "Ned-$id"
  done
  exit 0
fi

SRC="${1:-Resources/marks/ned.svg}"
NAME="${2:-Ned}"
OUT="Resources/$NAME.icns"
[[ -f "$SRC" ]] || { echo "no such svg: $SRC" >&2; exit 1; }
grep -q 'viewBox="0 0 64 64"' "$SRC" || { echo "$SRC: expected viewBox=\"0 0 64 64\"" >&2; exit 1; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
sed 's|viewBox="0 0 64 64"|viewBox="-7 -7 78 78" width="1024" height="1024"|' "$SRC" > "$TMP/padded.svg"

if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 1024 -h 1024 -b none "$TMP/padded.svg" -o "$TMP/1024.png"
else
  qlmanage -t -s 1024 -o "$TMP" "$TMP/padded.svg" >/dev/null 2>&1
  mv "$TMP/padded.svg.png" "$TMP/1024.png"
fi

SET="$TMP/$NAME.iconset"; mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$TMP/1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
mkdir -p Resources
iconutil -c icns "$SET" -o "$OUT"
echo "✓ $PWD/$OUT"
