#!/usr/bin/env bash
# Peak per-GPU VRAM for a sequence of resolutions, one vid_gen job each.
# usage: tools/vram-sweep.sh [steps]
set -u
STEPS=${1:-4}
cd "$(dirname "$0")/.."
mkdir -p tools/qa

peak() { nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | tr -d '\r' | paste -sd, -; }

echo "idle: $(peak)"
for spec in "864 480 22" "1280 720 22" "1344 768 22" "1920 1080 22"; do
  set -- $spec; W=$1; H=$2; F=$3
  node tools/gen.mjs tools/qa/_probe.webm --w "$W" --h "$H" --frames "$F" --steps "$STEPS" >tools/qa/_probe.log 2>&1 &
  PID=$!
  p0=0; p1=0
  while kill -0 "$PID" 2>/dev/null; do
    line=$(peak)
    a=$(printf '%s' "${line%,*}" | tr -dc '0-9')
    b=$(printf '%s' "${line#*,}" | tr -dc '0-9')
    [ -n "$a" ] && [ "$a" -gt "$p0" ] && p0=$a
    [ -n "$b" ] && [ "$b" -gt "$p1" ] && p1=$b
    sleep 0.4
  done
  wait "$PID"; rc=$?
  tail -1 tools/qa/_probe.log | tr -d '\r'
  echo "RESULT ${W}x${H} f=${F} steps=${STEPS}: cuda0=${p0} cuda1=${p1} sum=$((p0+p1)) MiB rc=$rc"
done
