"""AI 造型间: hairstyle restyle on top of MiniMax-H3 ref2va.

Prompt structure is taken from the community's image-editing formulas
(Qwen-Image-Edit / Flux Kontext hairstyle prompts), adapted to H3 ref2va:

  1. tag the reference            -> H3 only honours <Picture N> in connect order
  2. lock identity, change ONE thing -> "preserve exact facial identity ... change only the hairstyle"
  3. describe the hair physically  -> length / texture / parting / ends / volume
  4. hair realism cues             -> strands, hairline, scalp, light reflection
  5. camera + light                -> 85mm, soft key + rim, editorial beauty
  6. negative                      -> face swap, wig edge, helmet hair, plastic skin
"""
from __future__ import annotations

import base64
import json
import mimetypes
from pathlib import Path
from typing import Any

from . import config

# ---------------------------------------------------------------- style catalog
# The 50 styles come from the lookbook catalog that also produced the sample
# photos (backend/app/lookbook/<id>.jpg). One source of truth: the same fields
# that constrain the reference photo also constrain the restyle video.
_CATALOG = Path(__file__).with_name("lookbook") / "hairstyles_2026.json"
_CAT = json.loads(_CATALOG.read_text(encoding="utf-8"))["styles"]


def _desc(s: dict[str, str]) -> str:
    """Length / layers / parting / bangs / curl / ends, in reading order."""
    keys = ("len", "layer", "part", "bang", "curl", "end")
    return "，".join(s[k] for k in keys if s.get(k))


STYLES: list[dict[str, str]] = [
    {"id": s["id"], "zh": s["zh"], "en": s["en"], "cat": s["cat"], "g": s["g"],
     "desc": _desc(s)}
    for s in _CAT
]

# ids that shipped before the 2026 catalog; old links keep resolving
LEGACY_IDS = {
    "bob_blunt": "blunt_bob",
    "bob_french": "french_bob",
    "wolf_cut": "wolf_short",
    "curtain": "bang_curtain",
    "long_layers": "long_layers_straight",
    "hime": "hime_cut",
    "shag": "jp_layered_short",
    "mullet": "m_wolf",
    "lob_wavy": "layer_collarbone",
    "ponytail_high": "pony_high",
    "bun_messy": "bun_lazy",
    "twin_tails": "twin_braid",
    "braid_french": "twin_braid",
    "crop_textured": "m_textured_crop",
    "fade_side": "m_side_part",
    "buzz": "m_fade",
    "man_bun": "half_bun",
    "korean_perm": "m_natural_curl",
    "slick_back": "m_side_part",
}

COLOR_HINTS = {
    "natural": "自然黑棕",
    "platinum": "白金",
    "chocolate": "巧克力棕",
    "auburn": "红棕",
    "ash": "冷灰",
    "blue": "深蓝黑",
    "pink": "雾粉",
}

BASE_NEGATIVE = (
    "换了一张脸, 五官变了, 脸型变了, 肤色不对, 年龄变了, 眼睛不对称, 眼睛变形, 耳朵畸形, "
    "手指畸形, 多手指, 假发感, 发际线不自然, 贴头皮, 头发像塑料, 块状头发, 头发糊成一片, "
    "模糊, 低清晰度, 噪点, 过曝, 卡通, 动漫, 插画, 3D 渲染, CGI, 塑料皮肤, 磨皮过度, "
    "文字, 水印, logo, 多人, 侧脸, 低头"
)


def get_style(style_id: str) -> dict[str, str] | None:
    style_id = LEGACY_IDS.get(style_id, style_id)
    return next((s for s in STYLES if s["id"] == style_id), None)


def build_prompt(style_id: str, color: str = "natural", extra: str = "",
                 motion: str = "头部慢慢向左向右转，展示正面、侧面和四分之三侧脸") -> str:
    st = get_style(style_id)
    if not st:
        raise ValueError(f"unknown style: {style_id}")
    shade = COLOR_HINTS.get(color, COLOR_HINTS["natural"])
    prompt = (
        "subject_definitions:\n"
        "<Picture 1> 作为 <Subject 1> 人物外观来源，需保持其面部特征、五官、肤色与年龄。\n"
        "<Subject 1> 表示 Picture 1 中的人物，视频中只改变发型。\n"
        "\nsummary:\n"
        f"[reference generation] 生成一段 <Subject 1> 换上{st['desc']}、{shade}发色之后的半身人像视频，"
        "面部完全保持 <Picture 1> 不变。\n"
        "\nretention_analysis:\n"
        "<Subject 1>（出现于 [Shot 1]）：fully_preserved - 保持 Picture 1 中人物的面部特征、五官、肤色与年龄。\n"
        "<Picture 1>（人物外观来源）：fully_preserved - 保持该图提供的人物身份与面部特征，只改变发型。\n"
        "\ndetailed_description:\n"
        "画面是明亮的半身人像，浅色干净背景柔和虚化，自然光从侧前方照进来，"
        "脸上光比柔和，皮肤清透有光泽，能看到真实毛孔和细绒毛，淡妆，野生眉，自然的唇色。"
        f"头发是{st['desc']}，发色{shade}，一根根发丝清楚可见，发根自然蓬起有高颅顶，"
        "发际线和分线过渡自然，发尾有重量感，头发上有柔和的高光，几根碎发落在光里。\n"
        f"[Shot 1] At 00:00.000, <Subject 1> 正面看向镜头，表情放松，{motion}，"
        "镜头保持半身构图，肩部以上，85mm 镜头浅景深，画面干净，高清真实照片。\n"
        "\noverall_soundscape: 安静的室内环境，轻微的呼吸声。\n"
        "\nnon_diegetic_music: N/A\n"
    )
    if extra.strip():
        prompt += " " + extra.strip()
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
