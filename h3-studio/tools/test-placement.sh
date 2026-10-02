#!/usr/bin/env bash
# Restart sd-server with an alternative --backend and report the engine's own
# per-device placement lines. Restores the backend-managed server afterwards.
# usage: tools/test-placement.sh "diffusion=cuda1,te=cuda0,vae=cuda1"
set -u
BACKEND=${1:?usage: test-placement.sh "<backend spec>"}
cd "$(dirname "$0")/.."        # h3-studio
BASE=$(cd .. && pwd)           # repo root
API=http://127.0.0.1:8199
mkdir -p tools/qa

echo "--- stopping backend-managed sd-server ---"
curl -s -X POST "$API/api/sdserver/stop" >/dev/null
sleep 3

LOG=tools/qa/_placement.log
"$BASE/stable-diffusion.cpp/sd-server.exe" \
  --diffusion-model "$BASE/minimax_h3_ref2va_pruned-Q4_K.gguf" \
  --vae "$BASE/minimax_h3_video_vae_fp16.safetensors" \
  --audio-vae "$BASE/minimax_h3_audio_vae_fp32.safetensors" \
  --llm "$BASE/qwen3vl_32b_minimax_h3-Q4_K_M.gguf" \
  --diffusion-fa --listen-ip 127.0.0.1 --listen-port 1234 --log-level info \
  --backend "$BACKEND" --auto-fit off >"$LOG" 2>&1 &
SPID=$!

echo "--- waiting for server readiness (pid $SPID) ---"
for i in $(seq 1 120); do
  sleep 2
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 4 http://127.0.0.1:1234/v1/models 2>/dev/null)
  [ "$code" = "200" ] && break
  kill -0 "$SPID" 2>/dev/null || { echo "server exited early"; break; }
done
# weights are placed lazily on the first graph, so trigger one tiny generation
curl -s -X POST http://127.0.0.1:1234/sdcpp/v1/vid_gen -H 'Content-Type: application/json' \
  -d '{"prompt":"x","width":192,"height":192,"video_frames":5,"fps":24,"seed":1,"output_format":"webm","sample_params":{"sample_steps":1,"sample_method":"res_multistep","scheduler":"simple","guidance":{"txt_cfg":1.0}}}' >/dev/null

echo "--- waiting for placement ---"
for i in $(seq 1 150); do
  sleep 2
  done_n=$(grep -c "loading tensors completed" "$LOG" 2>/dev/null || echo 0)
  if [ "${done_n:-0}" -ge 3 ]; then break; fi
  kill -0 "$SPID" 2>/dev/null || { echo "server exited early"; break; }
done
sleep 6
grep -E "total params memory size|graph-cut layer split" "$LOG" | sed 's/\[INFO   \] //'
echo "--- GPU ---"
nvidia-smi --query-gpu=index,memory.used --format=csv,noheader | tr -d '\r'

echo "--- restoring ---"
kill "$SPID" 2>/dev/null; sleep 4
curl -s -X POST "$API/api/sdserver/start" >/dev/null
sleep 2
echo "restore requested"
