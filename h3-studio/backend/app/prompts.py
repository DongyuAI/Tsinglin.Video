"""Agent-facing prompt scaffolds for the four MiniMax-H3 modes.

These are *scaffolds*, not finished prompts: an agent (or a person) fills the
``{placeholders}`` from the brief and posts the result to ``POST /api/run``.
MiniMax-H3 responds best to English, cinematic, shot-by-shot text, so the
templates are English while the field guide and notes stay Chinese for review.

Modes map onto the conditioning node actually wired up in each template:

    t2va    text            -> MiniMaxH3ImageToVideo (no frames)
    i2va    first frame     -> MiniMaxH3ImageToVideo (first_frame)
    fl2va   first + last    -> MiniMaxH3ImageToVideo (first_frame + last_frame)
    ref2va  reference imgs  -> MiniMaxH3ReferenceToVideo
"""
from __future__ import annotations

from typing import Any

# Shared building blocks so the four modes stay consistent.
_COMMON_FIELDS: dict[str, str] = {
    "shot_size": "景别，如 extreme close-up / close-up / medium shot / wide shot",
    "camera_move": "运镜，如 static / slow push-in / tracking / handheld / crane up",
    "subject": "主体（人物/物体），保持身份一致",
    "action": "主体在镜头里做什么，一句话说清",
    "environment": "环境与地点",
    "time_of_day": "时间，如 golden hour / dusk / night / overcast noon",
    "lighting": "光线，如 soft key + rim / hard noon sun / neon practicals",
    "lens": "镜头质感，如 35mm anamorphic / 85mm shallow depth of field",
    "color_grade": "调色，如 teal-orange / desaturated / warm filmic",
    "film_grain": "颗粒，如 fine 35mm grain / clean digital",
    "motion": "运动细节与物理感，如 cloth flutter, dust kicked up",
    "ambient_sound": "环境音，如 city hum, wind, rain on metal",
    "music": "配乐，如 low synth pulse building to a hit",
}

_CONSTRAINTS = ("No on-screen text, no subtitles, no watermark, no jump cuts; "
                "keep {subject} identity and wardrobe consistent.")

AGENT_PROMPTS: dict[str, dict[str, Any]] = {
    "t2va": {
        "label": "文生视频",
        "template": (
            "{shot_size} {camera_move} of {subject}, {action}.\n"
            "Setting: {environment}, {time_of_day}.\n"
            "Look: {lighting}; {lens}; {color_grade}; {film_grain}.\n"
            "Motion: {motion}; one continuous take, no cuts.\n"
            "Audio: {ambient_sound}; {music}.\n"
            "Constraints: " + _CONSTRAINTS
        ),
        "fields": {
            **_COMMON_FIELDS,
            "duration_hint": "目标时长（秒），会被换算成帧数（24fps，帧数对齐 17k+5）",
        },
        "notes": "纯文本驱动。先把主体、动作、环境写死，再补镜头与光线；"
                 "描述越具体，画面越稳定。建议 5 秒 / 124 帧起步。",
    },
    "i2va": {
        "label": "图生视频",
        "template": (
            "Animate the provided first frame.\n"
            "Camera: {camera_move}, starting from the current framing.\n"
            "Action: {action}.\n"
            "Look: keep the frame's {lighting} and {color_grade}; {lens}.\n"
            "Motion: {motion}; natural physics; one continuous take, no cuts.\n"
            "Audio: {ambient_sound}.\n"
            "Constraints: preserve the subject's identity and the original "
            "composition; no on-screen text, no watermark."
        ),
        "fields": {
            **_COMMON_FIELDS,
            "first_frame": "首帧图片（上传后得到 h3studio:<name> 引用）",
        },
        "notes": "首帧已给定，提示词只描述“接下来发生什么”，不要重复描述画面里已经存在的东西。",
    },
    "fl2va": {
        "label": "首尾帧视频生成",
        "template": (
            "Use Image 1 as the first frame and Image 2 as the last frame.\n"
            "Transition: {motion} carrying {subject} from the opening pose to "
            "the closing pose.\n"
            "Look: {lighting}; {lens}; {color_grade}.\n"
            "Motion: one continuous shot, smooth interpolation, no cuts.\n"
            "Audio: {ambient_sound}.\n"
            "Constraints: same character and style from start to end; "
            "no on-screen text, no watermark."
        ),
        "fields": {
            **_COMMON_FIELDS,
            "first_frame": "首帧图片",
            "last_frame": "尾帧图片",
        },
        "notes": "两张图之间补间。开头/结尾的姿态差异要写成一条连贯的运动路径，"
                 "否则模型会在中途“跳”。",
    },
    "ref2va": {
        "label": "参考生视频",
        "template": (
            "Use the reference images for identity and style: "
            "<Picture 1> is {ref_1}, <Picture 2> is {ref_2}.\n"
            "Scene: {environment}, {time_of_day}.\n"
            "Action: {action}.\n"
            "Look: {lighting}; {lens}; {color_grade}; {film_grain}.\n"
            "Motion: {motion}; one continuous take, no cuts.\n"
            "Audio: {ambient_sound}; {music}.\n"
            "Constraints: keep every referenced subject consistent; "
            "no on-screen text, no watermark."
        ),
        "fields": {
            **_COMMON_FIELDS,
            "ref_1": "第 1 张参考图的角色/物体描述（对应 <Picture 1>）",
            "ref_2": "第 2 张参考图的角色/物体描述（对应 <Picture 2>）",
            "ref_images": "参考图列表，按 ref_image_0..N 顺序上传",
        },
        "notes": "用 <Picture N> 指代参考图，顺序必须与 ref_image_0..N 一致；"
                 "只描述要发生的事，别复述参考图内容。",
    },
}

# How an agent should drive the whole flow — surfaced over the API and MCP.
AGENT_GUIDE = {
    "zh": [
        "1) GET /api/templates 选模板，GET /api/templates/{id} 拿到默认图。",
        "2) GET /api/prompts/{mode} 取提示词骨架，用用户需求填 {占位符}。",
        "3) 需要图片时先 POST /api/upload，拿到 h3studio:<name> 引用。",
        "4) POST /api/run {template, overrides} 提交；overrides 可覆盖 prompt/width/height/length/seed/steps。",
        "5) GET /api/jobs/{id} 轮询到 completed，再从 media[].url 取结果。",
        "6) 分辨率两个方向都必须 >= 192 且为 32 的倍数，否则会被自动提升（低于该尺寸会出块状色块）。",
    ],
    "en": [
        "1) GET /api/templates, then GET /api/templates/{id} for the default graph.",
        "2) GET /api/prompts/{mode} for the scaffold; fill the {placeholders}.",
        "3) Upload images with POST /api/upload to get an h3studio:<name> ref.",
        "4) POST /api/run {template, overrides}; overrides may set prompt/width/height/length/seed/steps.",
        "5) Poll GET /api/jobs/{id} until completed, then read media[].url.",
        "6) Both dimensions must be >= 192 and multiples of 32; smaller values are raised automatically.",
    ],
}


def list_prompts() -> list[dict]:
    return [{"mode": m, **p} for m, p in AGENT_PROMPTS.items()]


def get_prompt(mode: str) -> dict | None:
    p = AGENT_PROMPTS.get(mode)
    return {"mode": mode, **p} if p else None
