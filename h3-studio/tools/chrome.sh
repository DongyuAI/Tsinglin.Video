#!/usr/bin/env bash
# Start a headless Chrome exposing the DevTools endpoint the tools connect to
# (diff-comfy.mjs / shot.mjs / check-errors.mjs / extract-comfy-locale.mjs).
#
#   bash tools/chrome.sh          # foreground
#   CDP_PORT=9333 bash tools/chrome.sh &
set -euo pipefail

CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
PORT="${CDP_PORT:-9333}"
PROFILE="${CHROME_PROFILE:-${TMPDIR:-/tmp}/h3chrome}"

mkdir -p "$PROFILE"
exec "$CHROME" \
  --headless=new \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$PROFILE" \
  --no-first-run --no-default-browser-check \
  --hide-scrollbars \
  --window-size=1440,900 \
  about:blank
