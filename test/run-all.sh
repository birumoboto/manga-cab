#!/bin/bash
# Runs the full MANGA.CAB verification suite.
cd "$(dirname "$0")/.." || exit 1

PASS=0
FAIL=0

run() {
  local name="$1"; shift
  echo ""
  echo "══════ $name ══════"
  if "$@"; then
    PASS=$((PASS+1))
  else
    FAIL=$((FAIL+1))
    echo "  ^^ $name FAILED"
  fi
}

run "encoding (multipart filenames)"   node test/encoding.test.js
run "ui (headless chrome)"          node test/ui.verify.js
run "ocr pipeline (real mokuro)"     node test/ocr.verify.js
run "mokuro ocr integration"        node test/mokuro.verify.js "${MOKURO_FILE:-/tmp/zhvol.mokuro}"
run "tailscale (real https)"        node test/tailscale.verify.js

echo ""
echo "══════════════════════════════"
echo "suites passed: $PASS   failed: $FAIL"
echo "══════════════════════════════"
exit $([ "$FAIL" -eq 0 ] && echo 0 || echo 1)
