#!/usr/bin/env bash
# Create a self-signed code-signing certificate "Ned Local Signing" in the login keychain and trust it for
# code signing, so apps/menubar/scripts/package.sh signs Ned.app with a stable identity. With ad-hoc
# signing every build has a new code hash, and macOS (TCC) treats each install as a new app: it asks for
# 문서 폴더 등 접근 again after every install.
#
# Two steps, each skipped when already done (idempotent):
#   1. create + import the identity (key + cert) — skipped if the cert is already in the keychain;
#   2. trust the cert for the code-signing policy (`security add-trusted-cert -p codeSign`). Without this a
#      self-signed cert shows up as CSSMERR_TP_NOT_TRUSTED and `find-identity -v` reports 0 valid
#      identities, so package.sh falls back to ad-hoc.
# If `security find-identity -v -p codesigning` already lists the identity as valid, nothing runs.
#
# Usage: scripts/make-signing-cert.sh [--dry-run]
#   --dry-run  print what would run; generates nothing and does not touch the keychain.
# macOS shows a keychain dialog during import and an authentication dialog (login password / Touch ID)
# for the trust step — approve them yourself.
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
# Output is captured first (not piped into `grep -q`), so an early grep exit can't SIGPIPE `security`
# and trip pipefail.
valid_count() {
  local out
  out="$(security find-identity -v -p codesigning 2>/dev/null || true)"
  printf '%s\n' "$out" | grep -c "\"$NAME\"" || true
}
cert_present() {
  local out
  out="$(security find-identity -p codesigning "$KEYCHAIN" 2>/dev/null || true)"
  printf '%s\n' "$out" | grep -q "\"$NAME\""
}

if [ "$(valid_count)" -gt 0 ]; then
  echo "✓ '$NAME' is already a valid code-signing identity — nothing to do."
  exit 0
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/ned-sign.XXXXXX")"
TMP="$(cd "$TMP" && pwd -P)"   # absolute, symlinks resolved — the cleanup below removes exactly this
cleanup() { case "$TMP" in /*ned-sign.*) rm -rf "$TMP" ;; esac; }
trap cleanup EXIT

if cert_present; then
  # Imported earlier but not trusted (CSSMERR_TP_NOT_TRUSTED): reuse it, only export the cert for step 2.
  echo "▶ '$NAME' is already in the login keychain but not trusted — skipping creation, trusting it"
  if [ "$DRY" = 1 ]; then
    echo "  [dry-run] security find-certificate -c \"$NAME\" -p $KEYCHAIN > $TMP/cert.pem"
  else
    security find-certificate -c "$NAME" -p "$KEYCHAIN" > "$TMP/cert.pem"
    grep -q 'BEGIN CERTIFICATE' "$TMP/cert.pem" || { echo "✗ could not export '$NAME' from the keychain" >&2; exit 1; }
  fi
else
  command -v openssl >/dev/null || { echo "✗ openssl not found" >&2; exit 1; }
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
fi

echo "▶ trusting '$NAME' for code signing"
echo "  macOS 가 인증 대화상자(로그인 암호 또는 Touch ID)를 한 번 띄웁니다 — '신뢰 설정 변경'을 직접 승인하세요."
run security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"

if [ "$DRY" = 1 ]; then
  echo "✓ dry-run done — nothing was created, imported or trusted."
  exit 0
fi

echo
echo "▶ security find-identity -v -p codesigning"
security find-identity -v -p codesigning 2>/dev/null | sed 's/^/  /' || true
if [ "$(valid_count)" -gt 0 ]; then
  echo "✓ '$NAME' is a valid code-signing identity."
else
  echo "✗ '$NAME' is still not a valid identity (0 valid)." >&2
  echo "  인증 대화상자를 취소했다면 이 스크립트를 다시 실행하세요. 계속 실패하면 키체인 접근 → '$NAME' →" >&2
  echo "  '신뢰' → '코드 서명: 항상 신뢰' 를 직접 설정할 수 있습니다." >&2
  exit 1
fi
echo "  codesign 이 매번 키체인 암호를 묻지 않게 하려면 한 번 직접 실행하세요 (로그인 암호 입력):"
echo "    security set-key-partition-list -S apple-tool:,apple: -s -k \"<로그인 암호>\" \"$KEYCHAIN\""
echo "  그다음 apps/menubar/scripts/package.sh (또는 scripts/install.sh) 를 다시 실행하면 이 정체성으로 서명됩니다."
echo "  첫 설치 때 '문서 폴더 접근' 을 한 번 더 허용하면 이후 재설치에서는 다시 묻지 않습니다."
