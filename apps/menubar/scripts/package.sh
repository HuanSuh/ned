#!/usr/bin/env bash
# Build the menu bar app and wrap it in a minimal .app bundle at .build/Ned.app.
# Mirrors the bundle step in scripts/install.sh (LSUIElement=true).
# Usage: scripts/package.sh && open --env NED_HOME=/tmp/ned-mb .build/Ned.app
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release 2>&1 | tail -1
APP=".build/Ned.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cp .build/release/Ned "$APP/Contents/MacOS/Ned"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Ned</string>
  <key>CFBundleIdentifier</key><string>com.ned.menubar</string>
  <key>CFBundleName</key><string>Ned</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
echo "✓ $PWD/$APP"
