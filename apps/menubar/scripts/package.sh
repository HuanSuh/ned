#!/usr/bin/env bash
# Build the menu bar app and wrap it in a minimal .app bundle at .build/Ned.app.
# The app supervises the daemon itself (see Sources/Ned/DaemonManager.swift); scripts/install.sh
# copies this bundle to /Applications. Icon: Resources/Ned.icns (regenerate with scripts/make-icon.sh).
# Usage: scripts/package.sh && open --env NED_HOME=/tmp/ned-mb --env NED_PORT=7790 .build/Ned.app
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release 2>&1 | tail -1
APP=".build/Ned.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Ned "$APP/Contents/MacOS/Ned"
cp Resources/Ned.icns "$APP/Contents/Resources/Ned.icns"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Ned</string>
  <key>CFBundleIdentifier</key><string>com.ned.menubar</string>
  <key>CFBundleName</key><string>Ned</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleIconFile</key><string>Ned</string>
  <key>CFBundleShortVersionString</key><string>0.2.0</string>
  <key>CFBundleVersion</key><string>2</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
</dict></plist>
PLIST
# Ad-hoc sign so SMAppService (Login Items) and TCC see a stable identity.
codesign --force --sign - "$APP" >/dev/null 2>&1 || true
echo "✓ $PWD/$APP"
