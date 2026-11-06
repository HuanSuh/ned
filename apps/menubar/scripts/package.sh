#!/usr/bin/env bash
# Build the menu bar app and wrap it in a minimal .app bundle at .build/Ned.app.
# The app supervises the daemon itself (see Sources/Ned/DaemonManager.swift); scripts/install.sh
# copies this bundle to /Applications. Icons: Resources/Ned*.icns (regenerate with scripts/make-icon.sh --all).
# Usage: scripts/package.sh && open --env NED_HOME=/tmp/ned-mb --env NED_PORT=7790 .build/Ned.app
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release 2>&1 | tail -1
APP=".build/Ned.app"
rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/Ned "$APP/Contents/MacOS/Ned"
# Ned.icns is the bundle icon (Finder, Login Items, notification banners); Ned-<persona>.icns are
# applied at runtime through NSApp.applicationIconImage (Sources/Ned/Persona.swift).
cp Resources/Ned*.icns "$APP/Contents/Resources/"
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
# Sign with a stable identity so TCC (문서 폴더 등 권한) and SMAppService (Login Items) keep recognising
# the app across rebuilds. An ad-hoc signature (`--sign -`) changes with every build's code hash, so macOS
# asks for the same permissions again after every install. Identity: $NED_SIGN_IDENTITY, else
# "Ned Local Signing" from the keychain (create it once with scripts/make-signing-cert.sh), else ad-hoc.
# Only a *valid* identity (`find-identity -v`) counts: a self-signed cert that is imported but not trusted
# for code signing (CSSMERR_TP_NOT_TRUSTED) is not used.
IDENTITY="${NED_SIGN_IDENTITY:-}"
IDS_VALID="$(security find-identity -v -p codesigning 2>/dev/null || true)"
IDS_ALL="$(security find-identity -p codesigning 2>/dev/null || true)"
if [ -z "$IDENTITY" ] && printf '%s\n' "$IDS_VALID" | grep -q '"Ned Local Signing"'; then
  IDENTITY="Ned Local Signing"
fi
if [ -n "$IDENTITY" ]; then
  codesign --force --sign "$IDENTITY" --identifier com.ned.menubar "$APP"
elif printf '%s\n' "$IDS_ALL" | grep -q '"Ned Local Signing"'; then
  echo "! ad-hoc 서명 — 'Ned Local Signing' 이 키체인에 있지만 코드 서명용으로 신뢰되지 않음(CSSMERR_TP_NOT_TRUSTED)." >&2
  echo "  scripts/make-signing-cert.sh 를 다시 실행하세요 (신뢰 단계만 수행, 인증 대화상자 1회)." >&2
  codesign --force --sign - --identifier com.ned.menubar "$APP" >/dev/null 2>&1 || true
else
  echo "! ad-hoc 서명 — 매 설치마다 권한을 다시 묻게 됨 — scripts/make-signing-cert.sh 실행" >&2
  codesign --force --sign - --identifier com.ned.menubar "$APP" >/dev/null 2>&1 || true
fi
codesign -dv "$APP" 2>&1 | grep -E '^(Identifier|Authority|Signature)=' | sed 's/^/  sign: /' || true
echo "✓ $PWD/$APP"
