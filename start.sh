#!/bin/bash
# MANGA.CAB launcher.
#
# Serves the reader on 127.0.0.1:8790 and points Tailscale Serve at it
# so the site is reachable from the tailnet (phone included).
#
# Runs in the foreground under launchd: launchd's KeepAlive restarts us
# if we die, and we supervise the node process ourselves.

set -uo pipefail

# launchd gives us no PATH, so fall back to the usual Homebrew locations
# before giving up on `command -v`.
NODE="${NODE:-}"
if [ -z "$NODE" ]; then
  for candidate in /opt/homebrew/opt/node@22/bin/node /opt/homebrew/bin/node \
                   /usr/local/bin/node /usr/bin/node; do
    [ -x "$candidate" ] && NODE="$candidate" && break
  done
fi
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null)"
fi
if [ -z "$NODE" ]; then
  echo "manga-reader: no node binary found" >&2
  exit 1
fi

DIR="${DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${PORT:-8790}"
LOG="${LOG:-/tmp/manga-reader.log}"

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
