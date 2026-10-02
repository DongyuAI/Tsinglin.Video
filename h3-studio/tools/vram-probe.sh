#!/usr/bin/env bash
# Peak per-GPU VRAM while one vid_gen job runs.
# usage: tools/vram-probe.sh <W> <H> <frames> <steps>
set -u
W=${1:-864}; H=${2:-480}; F=${3:-22}; S=${4:-8}
cd "$(dirname "$0")/.."

peak() { nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | paste -sd, -; }
base=$(peak)
echo "baseline (weights only): $base"

node tools/gen.mjs tools/qa/_probe.webm --w "$W" --h "$H" --frames "$F" --steps "$S" >tools/qa/_probe.log 2>&1 &
PID=$!
p0=0; p1=0
while kill -0 "$PID" 2>/dev/null; do
  line=$(peak)
  a=${line%,*}; b=${line#*,}
  [ "$a" -gt "$p0" ] && p0=$a
  [ "$b" -gt "$p1" ] && p1=$b
  sleep 0.4
done
wait "$PID"; rc=$?
tail -2 tools/qa/_probe.log | tr -d '\r'
echo "PEAK ${W}x${H} f=${F}: cuda0=${p0} MiB  cuda1=${p1} MiB  sum=$((p0+p1)) MiB"
exit $rc
