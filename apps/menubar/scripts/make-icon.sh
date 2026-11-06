#!/usr/bin/env bash
# Regenerate Resources/Ned.icns from the brand mark (packages/daemon/public/proposals/ned-glasses.svg).
# The 64×64 tile is padded to Apple's icon grid (~824/1024 body) before rasterizing.
# Uses rsvg-convert when present (brew install librsvg), else qlmanage + sips. Needs iconutil (Xcode CLT).
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="../../packages/daemon/public/proposals/ned-glasses.svg"
OUT="Resources/Ned.icns"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
sed 's|viewBox="0 0 64 64"|viewBox="-7 -7 78 78" width="1024" height="1024"|' "$SRC" > "$TMP/padded.svg"

if command -v rsvg-convert >/dev/null; then
  rsvg-convert -w 1024 -h 1024 -b none "$TMP/padded.svg" -o "$TMP/1024.png"
else
  qlmanage -t -s 1024 -o "$TMP" "$TMP/padded.svg" >/dev/null 2>&1
  mv "$TMP/padded.svg.png" "$TMP/1024.png"
fi

SET="$TMP/Ned.iconset"; mkdir "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$TMP/1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2)); sips -z $d $d "$TMP/1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
mkdir -p Resources
iconutil -c icns "$SET" -o "$OUT"
echo "✓ $PWD/$OUT"
