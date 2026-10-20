"""AI 造型间: hairstyle / makeup restyle on top of MiniMax-H3 ref2va.

The engine is a reference-to-video model, so the product is a short *video* of the
same person wearing a new cut, not a still image. Identity is carried by the
portrait reference; the cut is carried by the prompt (and optionally a second
reference image of the target hairstyle).
"""
from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import Any

from . import config

# name_zh, name_en, prompt fragment (English works best for the Qwen3-VL encoder)
STYLES: list[dict[str, str]] = [
    {"id": "bob_blunt", "zh": "齐肩一刀切", "en": "blunt bob", "desc": "chin-length blunt bob, sharp straight ends"},
    {"id": "bob_french", "zh": "法式波波", "en": "french bob", "desc": "french bob with soft fringe, jaw-length"},
    {"id": "wolf_cut", "zh": "狼尾", "en": "wolf cut", "desc": "wolf cut, short choppy layers on top, longer mullet at the back"},
    {"id": "pixie", "zh": "精灵短发", "en": "pixie cut", "desc": "short pixie cut with textured crown and side-swept fringe"},
    {"id": "curtain", "zh": "八字刘海", "en": "curtain bangs", "desc": "long layers with curtain bangs parted in the middle"},
    {"id": "long_layers", "zh": "长层次", "en": "long layers", "desc": "long hair with face-framing layers and a soft blowout"},
    {"id": "hime", "zh": "姬发式", "en": "hime cut", "desc": "hime cut, blunt straight sidelocks and blunt fringe, long back"},
    {"id": "shag", "zh": "碎盖", "en": "shag", "desc": "shag cut with heavy texture and a choppy fringe"},
    {"id": "mullet", "zh": "鲻鱼头", "en": "mullet", "desc": "modern mullet, short sides, textured top, longer back"},
    {"id": "lob_wavy", "zh": "波浪中长", "en": "wavy lob", "desc": "wavy lob, shoulder length, loose beach waves"},
    {"id": "ponytail_high", "zh": "高马尾", "en": "high ponytail", "desc": "sleek high ponytail with a face-lifting pull-back"},
    {"id": "bun_messy", "zh": "慵懒丸子头", "en": "messy bun", "desc": "messy bun with loose strands framing the face"},
    {"id": "twin_tails", "zh": "双马尾", "en": "twin tails", "desc": "high twin tails, straight and glossy"},
    {"id": "braid_french", "zh": "法式编发", "en": "french braid", "desc": "single french braid down the back, neat and tight"},
    {"id": "crop_textured", "zh": "纹理寸头", "en": "textured crop", "desc": "short textured crop with a fade on the sides"},
    {"id": "fade_side", "zh": "侧分背头", "en": "side-part fade", "desc": "side-part fade, slicked back with pomade"},
    {"id": "buzz", "zh": "圆寸", "en": "buzz cut", "desc": "buzz cut, uniform short length"},
    {"id": "man_bun", "zh": "男士丸子头", "en": "man bun", "desc": "man bun with a clean taper and a neat hairline"},
    {"id": "korean_perm", "zh": "韩式纹理烫", "en": "korean perm", "desc": "korean textured perm, soft c-curl volume on top"},
    {"id": "slick_back", "zh": "湿发背头", "en": "slicked back", "desc": "slicked-back wet look, high shine, tight sides"},
]

COLOR_HINTS = {
    "natural": "natural black hair",
    "platinum": "platinum blonde hair",
    "chocolate": "chocolate brown hair",
    "auburn": "auburn red hair",
    "ash": "ash grey hair",
    "blue": "deep blue dyed hair",
    "pink": "dusty pink dyed hair",
}

BASE_NEGATIVE = (
    "different person, face swap, identity change, deformed face, distorted features, "
    "extra fingers, extra limbs, blurry, low resolution, text, watermark, logo, "
    "cartoon, anime, 3d render, plastic skin, helmet hair, wig edge visible"
)


def get_style(style_id: str) -> dict[str, str] | None:
    return next((s for s in STYLES if s["id"] == style_id), None)


def build_prompt(style_id: str, color: str = "natural", extra: str = "",
                 motion: str = "slowly turns the head left and right") -> str:
    st = get_style(style_id)
    if not st:
        raise ValueError(f"unknown style: {style_id}")
    hair = f"{st['desc']}, {COLOR_HINTS.get(color, COLOR_HINTS['natural'])}"
    prompt = (
        f"the exact same person as the reference photo, identical face, identical facial "
        f"features, same skin tone and age, now with {hair}. "
        f"the person {motion} to show the haircut from different angles, "
        f"shoulders-up portrait, neutral studio background, soft key light, "
        f"photorealistic, 85mm lens, shallow depth of field, high detail hair strands"
    )
    if extra.strip():
        prompt += ", " + extra.strip()
    return prompt


def resolve_data_uri(ref: str) -> str | None:
    """Turn an h3studio:<file> reference (or bare filename) into a data URI."""
    name = ref.split(":", 1)[1] if ref.startswith("h3studio:") else ref
    for p in (config.OUTPUT_DIR / "uploads" / name,
              config.COMFY_DIR / "ComfyUI" / "input" / name,
              config.BASE / name):
        if p.is_file():
            mime = mimetypes.guess_type(p.name)[0] or "image/png"
            return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()
    return None


def build_payload(*, prompt: str, refs: list[str], width: int = 864, height: int = 480,
                  frames: int = 22, steps: int = 4, seed: int = 42,
                  cfg: float = 1.0) -> dict[str, Any]:
    """sd-server vid_gen payload for a style job (same shape graph.interpret emits)."""
    return {
        "prompt": prompt,
        "negative_prompt": BASE_NEGATIVE,
        "width": width,
        "height": height,
        "video_frames": frames,
        "fps": 24,
        "seed": seed,
        "output_format": "webm",
        "ref_images": refs,
        "sample_params": {
            "sample_steps": steps,
            "sample_method": "res_multistep",
            "scheduler": "simple",
            "guidance": {"txt_cfg": cfg},
        },
    }
