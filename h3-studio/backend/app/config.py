"""Configuration, paths and model discovery for H3 Studio."""
from __future__ import annotations

import os
from pathlib import Path

# h3-studio/backend/app/config.py -> h3-studio
ROOT = Path(__file__).resolve().parents[2]
# the repo root, i.e. the directory that holds ComfyUI_windows_portable/ and the
# model weights — derived from this file's location, never hard-coded
BASE = ROOT.parent

SD_CPP_DIR = BASE / "stable-diffusion.cpp"
SD_CLI = SD_CPP_DIR / "sd-cli.exe"
SD_SERVER = SD_CPP_DIR / "sd-server.exe"

COMFY_DIR = BASE / "ComfyUI_windows_portable"
COMFY_PY = COMFY_DIR / "python_embeded" / "python.exe"

OUTPUT_DIR = ROOT / "outputs"
TEMPLATE_DIR = ROOT / "templates"

HOST = os.environ.get("H3_HOST", "127.0.0.1")
PORT = int(os.environ.get("H3_PORT", "8199"))

SD_HOST = os.environ.get("H3_SD_HOST", "127.0.0.1")
SD_PORT = int(os.environ.get("H3_SD_PORT", "1234"))
SD_BASE = f"http://{SD_HOST}:{SD_PORT}"

# ---------------------------------------------------------------- GPU placement
# Two Tesla P40 (24 GB each, 46 GB total). Everything must stay resident on the
# GPUs and the two big modules (text encoder + diffusion) are spread across both
# cards. --auto-fit is turned OFF so the engine never silently falls back to
# system RAM or disk; if it does not fit it OOMs, which is the intended policy
# ("unless every CUDA device is OOM, do not offload to memory").
#
# Placement is *measured*, not guessed. The engine's graph-cut placer is greedy
# first-fit on CUDA0 and does NOT honour `te=cuda0&cuda1` (it puts the whole
# 17.4 GB text encoder on CUDA0 because it fits alone), so the old
# `diffusion=cuda0&cuda1,te=cuda0&cuda1,vae=cuda1` left CUDA0 at 19612 MB with
# only 1588 MB free while CUDA1 sat at 12802 MB with 10237 MB idle. That starved
# CUDA0 and capped output at ~480p: 1280x736 needed 2351 MB, 1344x768 2534 MB and
# 1920x1080 4558 MB, all OOM on CUDA0.
#
# Pinning each module to one device (no cross-device split at all) balances the
# two cards and frees the headroom the diffusion model needs:
#   te -> cuda0 17266 MB | diffusion + vae -> cuda1 16026 MB
# measured peaks (22 frames, 4 steps): 1280x736 35484 MB, 1344x768 37015 MB,
# 1920x1080-class 39439 MB — all resident, RAM 0.00 MB, all complete.
#
# Note: `--split-mode row` is advertised but this build reports "backend has no
# split buffer type", so it silently falls back to layer split — do not rely on
# it. `--eager-load` is also incompatible with the deferred graph-cut split (it
# tries to place every tensor on device 0 and OOMs), so it must stay off.
SD_BACKEND = os.environ.get(
    "H3_SD_BACKEND", "te=cuda0,diffusion=cuda1,vae=cuda1")
SD_AUTO_FIT = os.environ.get("H3_SD_AUTO_FIT", "off")

# Flags that would push weights into RAM/disk; refused unless explicitly allowed.
SD_OFFLOAD_FLAGS = ("--offload-to-cpu", "--mmap", "--rpc-servers")
# The resident engine must fit in VRAM; anything larger is a misconfiguration.
SD_REQUIRE_VRAM_ONLY = os.environ.get("H3_SD_REQUIRE_VRAM_ONLY", "1") != "0"

# ------------------------------------------------------------------ video rules
# MiniMax-H3 degenerates into per-latent-cell colour blocks below a minimum
# size. Empirically (measured on this box): each aligned dimension must be
# >= 192 px (the VAE's spatial factor is 32, so >= 6 latent cells per axis).
# 288x160 -> blocks, 256x192 / 192x256 / 224x224 -> clean.
MIN_DIM = int(os.environ.get("H3_MIN_DIM", "192"))
DIM_MULTIPLE = 32

# Model roles -> filename glob patterns, searched in BASE (and models/ subdirs).
MODEL_PATTERNS = {
    "diffusion": ["*minimax*h3*ref2va*.gguf", "*minimax*h3*fl2va*.gguf",
                  "*minimax*h3*ref2va*.safetensors", "*minimax*h3*fl2va*.safetensors"],
    "llm": ["qwen3vl_32b_minimax_h3*.gguf", "*qwen3vl*minimax*h3*.safetensors"],
    "vae": ["minimax_h3_video_vae*.safetensors"],
    "audio_vae": ["minimax_h3_audio_vae*.safetensors"],
    "lora": ["*minimax*h3*turbo*.safetensors", "*minimax*h3*fl2v*.safetensors"],
}

MODEL_LABELS = {
    "diffusion": "扩散模型（DiT）",
    "llm": "文本编码器（Qwen3-VL-32B）",
    "vae": "视频 VAE",
    "audio_vae": "音频 VAE",
    "lora": "加速 LoRA（Turbo）",
}


def _search_dirs() -> list[Path]:
    dirs = [BASE]
    for sub in ("models", "models/diffusion_models", "models/text_encoders",
                "models/vae", "models/loras", "loras"):
        p = BASE / sub
        if p.is_dir():
            dirs.append(p)
    p = COMFY_DIR / "ComfyUI" / "models"
    if p.is_dir():
        for sub in ("diffusion_models", "text_encoders", "vae", "loras", "checkpoints"):
            q = p / sub
            if q.is_dir():
                dirs.append(q)
    return dirs


def discover_models() -> dict[str, list[dict]]:
    """Return {role: [{name, path, size}]} for every role, best-first."""
    dirs = _search_dirs()
    out: dict[str, list[dict]] = {}
    for role, patterns in MODEL_PATTERNS.items():
        found: list[dict] = []
        seen: set[str] = set()
        for pat in patterns:
            for d in dirs:
                for f in sorted(d.glob(pat)):
                    if not f.is_file():
                        continue
                    key = str(f.resolve()).lower()
                    if key in seen:
                        continue
                    seen.add(key)
                    found.append({
                        "name": f.name,
                        "path": str(f),
                        "size": f.stat().st_size,
                    })
        out[role] = found
    return out


def pick_models() -> dict[str, str | None]:
    """Best default model per role (largest file wins, i.e. highest quality quant)."""
    disc = discover_models()
    picked: dict[str, str | None] = {}
    for role, items in disc.items():
        if not items:
            picked[role] = None
            continue
        # prefer the biggest file (Q4_K_M over Q2_K_M), but never the *_vision/_separate extras
        items = sorted(items, key=lambda x: x["size"], reverse=True)
        picked[role] = items[0]["path"]
    return picked


def ensure_dirs() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    TEMPLATE_DIR.mkdir(parents=True, exist_ok=True)
