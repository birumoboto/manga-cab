#!/bin/bash
# MANGA.CAB launcher.
#
# Serves the reader on 127.0.0.1:8790 and points Tailscale Serve at it
# so the site is reachable from the tailnet (phone included).
#
# Runs in the foreground under launchd: launchd's KeepAlive restarts us
# if we die, and we supervise the node process ourselves.

set -uo pipefail

NODE="/opt/homebrew/opt/node@22/bin/node"
DIR="/Users/bing/manga-reader"
PORT=8790
LOG="/tmp/manga-reader.log"

if [ ! -x "$NODE" ]; then
  NODE="$(command -v node)"
fi

cd "$DIR" || exit 1

# ── Tailscale Serve ────────────────────────────────────────────
if command -v tailscale >/dev/null 2>&1; then
  tailscale serve --bg "http://127.0.0.1:${PORT}" >/dev/null 2>&1 || true
fi

# ── Server ─────────────────────────────────────────────────────
"$NODE" server/index.js >>"$LOG" 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  wait "$SERVER_PID" 2>/dev/null
  exit 0
}
trap cleanup TERM INT

# ── Health check loop ──────────────────────────────────────────
# If the server dies, exit non-zero so launchd restarts the whole thing.
while true; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "manga-reader server exited" >>"$LOG"
    exit 1
  fi
  sleep 5
done
