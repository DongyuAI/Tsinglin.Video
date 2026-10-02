#!/usr/bin/env bash
# Start sd-server with a given --backend, run the resolution sweep, then restore
# the backend-managed server. usage: tools/res-test.sh "<backend spec>"
set -u
BACKEND=${1:?usage: res-test.sh "<backend spec>"}
cd "$(dirname "$0")/.."        # h3-studio
BASE=$(cd .. && pwd)           # repo root
API=http://127.0.0.1:8199
mkdir -p tools/qa
LOG=tools/qa/_res.log

echo "--- stopping backend-managed sd-server ---"
curl -s -X POST "$API/api/sdserver/stop" >/dev/null; sleep 3

"$BASE/stable-diffusion.cpp/sd-server.exe" \
  --diffusion-model "$BASE/minimax_h3_ref2va_pruned-Q4_K.gguf" \
  --vae "$BASE/minimax_h3_video_vae_fp16.safetensors" \
  --audio-vae "$BASE/minimax_h3_audio_vae_fp32.safetensors" \
  --llm "$BASE/qwen3vl_32b_minimax_h3-Q4_K_M.gguf" \
  --diffusion-fa --listen-ip 127.0.0.1 --listen-port 1234 --log-level info \
  --backend "$BACKEND" --auto-fit off >"$LOG" 2>&1 &
SPID=$!
echo "server pid $SPID"

for i in $(seq 1 120); do
  sleep 2
  [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 4 http://127.0.0.1:1234/v1/models 2>/dev/null)" = "200" ] && break
  kill -0 "$SPID" 2>/dev/null || { echo "exited early"; break; }
done
echo "--- backend=$BACKEND ---"
node tools/vram-sweep.mjs 4 22
echo "--- engine placement ---"
grep -E "graph-cut layer split" "$LOG" | sed 's/\[INFO   \] //' || echo "(no cross-device splits)"

echo "--- restoring ---"
kill "$SPID" 2>/dev/null; sleep 4
curl -s -X POST "$API/api/sdserver/start" >/dev/null; sleep 2
echo "restore requested"
