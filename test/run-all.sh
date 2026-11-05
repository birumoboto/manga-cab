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

run "text zones (tap to reveal on white)" node test/zones.verify.js
run "firefox add-on (tap to read)"     node test/addon.verify.js
run "ui revamp (menu + ocr modes + api)" node test/ui-revamp.verify.js
run "cache policy (no stale shell)"    node test/cache.verify.js
run "transcript button (4 devices)"       node test/transcript-visible.verify.js
run "ocr transcript (one section per line)" node test/transcript.verify.js
run "overlay lines (one section per line)"  node test/overlay-lines.verify.js
run "real webtoon text (no truncation)"  node test/real-text.verify.js
run "text scale (matches artwork)"     node test/text-scale.verify.js
run "text selection (tap + highlight)"  node test/touch-select.verify.js
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
