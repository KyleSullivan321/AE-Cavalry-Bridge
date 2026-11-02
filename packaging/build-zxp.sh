#!/usr/bin/env bash
# Build a signed .zxp of the Cavalry Bridge CEP extension.
# Cross-platform (bash; works on macOS, Linux, Windows git-bash).
#
# Requirements:
#   - ZXPSignCmd on PATH (or set ZXPSIGN=/path/to/ZXPSignCmd). Get it from
#     https://github.com/Adobe-CEP/CEP-Resources (ZXPSignCMD/ folder).
#   - A signing certificate (.p12). For real distribution use a code-signing cert.
#     For testing, run ./make-test-cert.sh to self-sign one.
#
# Env vars (or defaults):
#   CERT=cert.p12  CERT_PASS=bridge  TSA=<timestamp url, optional/off by default>
#   ZXPSIGN=./ZXPSignCmd.exe  (or .../ZXPSignCmd on macOS)
# Notes:
#   - On git-bash (Windows), export MSYS2_ARG_CONV_EXCL="*" and MSYS_NO_PATHCONV=1
#     before running, or the /C=.. cert subject + paths get mangled.
#   - TSA (timestamping) is OFF by default: public timestamp servers are flaky and
#     caused "Arguments are invalid". Set TSA=<url> to enable for a real release.
set -euo pipefail
cd "$(dirname "$0")"

ROOT="$(cd .. && pwd)"
SRC="$ROOT/extension"
STAGE="$ROOT/packaging/stage"
OUT="$ROOT/packaging/dist"
ZXP="$OUT/CavalryBridge.zxp"

CERT="${CERT:-$ROOT/packaging/cert.p12}"

# ZXPSignCmd is a native exe on Windows — it needs Windows-style paths (C:/..),
# not git-bash's /c/.. form. cygpath converts when available; otherwise pass through
# (on macOS/Linux paths are already native).
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi
}
CERT_PASS="${CERT_PASS:-bridge}"
TSA="${TSA:-}"
ZXPSIGN="${ZXPSIGN:-ZXPSignCmd}"

echo "==> Staging extension (excluding dev files)"
rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE" "$OUT"
# copy everything, then strip development-only artifacts
cp -R "$SRC/." "$STAGE/"
rm -f  "$STAGE/.debug"                 # remote-debug config — must not ship
rm -rf "$STAGE/samples"                # bundled test scenes — optional, drop to slim
find "$STAGE" -name '.DS_Store' -delete 2>/dev/null || true

echo "==> Files staged:"
( cd "$STAGE" && find . -type f | sed 's/^/    /' )

if ! command -v "$ZXPSIGN" >/dev/null 2>&1 && [ ! -x "$ZXPSIGN" ]; then
  echo "!! ZXPSignCmd not found. Set ZXPSIGN=/path/to/ZXPSignCmd and retry."
  echo "   Download: https://github.com/Adobe-CEP/CEP-Resources (ZXPSignCMD/)"
  exit 2
fi
# native-path forms for the Windows exe
W_STAGE="$(winpath "$STAGE")"; W_ZXP="$(winpath "$ZXP")"; W_CERT="$(winpath "$CERT")"

if [ ! -f "$CERT" ]; then
  echo "==> No cert at $CERT — generating a self-signed one (Adobe format)"
  "$ZXPSIGN" -selfSignedCert US NA "Cavalry Bridge" "Cavalry Bridge Dev" "$CERT_PASS" "$W_CERT"
fi

echo "==> Signing → $ZXP"
if [ -n "$TSA" ]; then
  "$ZXPSIGN" -sign "$W_STAGE" "$W_ZXP" "$W_CERT" "$CERT_PASS" -tsa "$TSA"
else
  "$ZXPSIGN" -sign "$W_STAGE" "$W_ZXP" "$W_CERT" "$CERT_PASS"
fi

echo "==> Verifying signature"
"$ZXPSIGN" -verify "$W_ZXP" -certInfo -skipOnlineRevocationChecks || true

echo "==> Done: $ZXP"
