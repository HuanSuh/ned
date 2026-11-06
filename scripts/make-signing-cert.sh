#!/usr/bin/env bash
# Create a self-signed code-signing certificate "Ned Local Signing" in the login keychain, so
# apps/menubar/scripts/package.sh signs Ned.app with a stable identity. With ad-hoc signing every build
# has a new code hash, and macOS (TCC) treats each install as a new app: it asks for 문서 폴더 등 접근
# again after every install. Run once; idempotent (does nothing if the identity already exists).
#
# Usage: scripts/make-signing-cert.sh [--dry-run]
#   --dry-run  print what would run; generates nothing and does not touch the keychain.
# macOS shows one keychain dialog during import — approve it yourself.
set -euo pipefail
NAME="${NED_SIGN_IDENTITY:-Ned Local Signing}"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
run() { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }

# `-p codesigning` without -v also lists a self-signed cert the system does not trust yet; codesign can
# still sign with it, so either form counts as "already there".
if security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null | grep -q "\"$NAME\""; then
  echo "✓ '$NAME' already in the login keychain — nothing to do."
  exit 0
fi
command -v openssl >/dev/null || { echo "✗ openssl not found" >&2; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ned-sign.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"   # absolute, symlinks resolved — the cleanup below removes exactly this
cleanup() { case "$TMP" in /*ned-sign.*) rm -rf "$TMP" ;; esac; }
trap cleanup EXIT
PASS="ned-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"   # only protects the throwaway .p12

cat > "$TMP/cert.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions    = ext
prompt             = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints       = critical, CA:false
keyUsage               = critical, digitalSignature
extendedKeyUsage       = critical, codeSigning
subjectKeyIdentifier   = hash
EOF

echo "▶ generating key + certificate ('$NAME', 10 years)"
run openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$TMP/cert.cnf" \
  -keyout "$TMP/key.pem" -out "$TMP/cert.pem"
# -legacy: OpenSSL 3's default PKCS#12 ciphers are not readable by `security import`. LibreSSL (macOS's
# /usr/bin/openssl) has no -legacy flag and already writes the old format.
P12_LEGACY=()
if openssl version 2>/dev/null | grep -q '^OpenSSL 3'; then P12_LEGACY=(-legacy); fi
run openssl pkcs12 -export ${P12_LEGACY[@]+"${P12_LEGACY[@]}"} -name "$NAME" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -out "$TMP/ned.p12" -passout "pass:$PASS"

echo "▶ importing into the login keychain (approve the macOS dialog if one appears)"
run security import "$TMP/ned.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign

if [ "$DRY" = 1 ]; then
  echo "✓ dry-run done — nothing was created or imported."
  exit 0
fi
echo
echo "✓ '$NAME' imported."
echo "  codesign 이 매번 키체인 암호를 묻지 않게 하려면 한 번 직접 실행하세요 (로그인 암호 입력):"
echo "    security set-key-partition-list -S apple-tool:,apple: -s -k \"<로그인 암호>\" \"$KEYCHAIN\""
echo "  그다음 apps/menubar/scripts/package.sh (또는 scripts/install.sh) 를 다시 실행하면 이 정체성으로 서명됩니다."
echo "  첫 설치 때 '문서 폴더 접근' 을 한 번 더 허용하면 이후 재설치에서는 다시 묻지 않습니다."
