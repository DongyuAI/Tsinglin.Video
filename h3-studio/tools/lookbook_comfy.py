"""Generate the 2026 hairstyle lookbook with Qwen-Image-2.1 on ComfyUI.

The lookbook is 50 hairstyles x 1 photo, shot with one fixed brief (white
shirt, grey seamless backdrop, 85mm) so the styles can be compared against each
other instead of against the lighting.

    python tools/lookbook_comfy.py gen                  # all 50 -> lb_<id>
    python tools/lookbook_comfy.py gen --ids wool_roll --fix   # with overrides
    python tools/lookbook_comfy.py sheet --ids wool_roll --out research/shots/x.jpg
    python tools/lookbook_comfy.py assemble             # best pick -> lookbook/<id>.jpg
    python tools/lookbook_comfy.py grid                 # one 10x5 contact sheet

ComfyUI must be running on 127.0.0.1:8188 with the three model files below.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(0, str(TOOLS))
from prompt_builder import BACK_IDS, BACK_VIEW, BY, FRONT_VIEW, build, forbid_for  # noqa: E402

ROOT = TOOLS.parents[1]
STUDIO = ROOT / "h3-studio"
LOOKBOOK = STUDIO / "backend" / "app" / "lookbook"
OUTPUT = ROOT / "ComfyUI_windows_portable" / "ComfyUI" / "output"
SHOTS = ROOT / "research" / "shots"
FIXES = json.loads((TOOLS / "prompt_fixes.json").read_text(encoding="utf-8"))

HOST = "http://127.0.0.1:8188"
UNET = "qwen_image_2.1_int8_convrot.safetensors"
CLIP = "qwen3vl_8b_int8_convrot.safetensors"
VAE = "qwen_image_2.1_vae_bf16.safetensors"
WIDTH, HEIGHT = 896, 1152


def graph(prompt: str, negative: str, seed: int, prefix: str, steps: int = 25, cfg: float = 1.0) -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "QwenImage21Cache", "inputs": {"model": ["1", 0], "device": "auto", "dtype": "default"}},
        "3": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": "qwen_image", "device": "default"}},
        "4": {"class_type": "TextEncodeQwenImage21",
              "inputs": {"clip": ["3", 0], "prompt": prompt, "negative_prompt": negative, "resolution": 1024}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": WIDTH, "height": HEIGHT, "batch_size": 1}},
        "6": {"class_type": "KSampler", "inputs": {"model": ["2", 0], "positive": ["4", 0], "negative": ["4", 1],
                                                    "latent_image": ["5", 0], "seed": seed, "steps": steps,
                                                    "cfg": cfg, "sampler_name": "euler", "scheduler": "simple",
                                                    "denoise": 1.0}},
        "7": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["6", 0], "vae": ["7", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": prefix}},
    }


def submit(prompt: str, negative: str, seed: int, prefix: str, steps: int = 25, cfg: float = 1.0) -> str:
    body = json.dumps({"prompt": graph(prompt, negative, seed, prefix, steps, cfg),
                       "client_id": str(uuid.uuid4())}).encode()
    req = urllib.request.Request(HOST + "/prompt", data=body,
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())["prompt_id"]


def prompt_for(sid: str, fix: bool) -> tuple[str, str]:
    style = BY[sid]
    view = BACK_VIEW if sid in BACK_IDS else FRONT_VIEW
    prompt = build(style, view)
    negative = forbid_for(style)
    override = FIXES.get(sid) if fix else None
    if override:
        prompt = prompt.replace("。【禁止出现】", "。" + override["pos"] + "。【禁止出现】", 1)
        prompt = prompt.replace("【禁止出现】", "【禁止出现】" + override["neg"] + "、", 1)
        negative += "、" + override["neg"]
    return prompt, negative


def cmd_gen(args) -> None:
    ids = args.ids.split(",") if args.ids else list(BY)
    jobs = {}
    for sid in ids:
        prompt, negative = prompt_for(sid, args.fix)
        prefix = args.prefix + sid
        jobs[submit(prompt, negative, args.seed, prefix)] = sid
        print(f"queued {sid} {len(prompt)} chars", flush=True)

    done, t0 = set(), time.time()
    while len(done) < len(jobs):
        time.sleep(10)
        try:
            hist = json.loads(urllib.request.urlopen(HOST + "/history?max_items=500", timeout=30).read())
        except OSError:
            continue
        for pid, sid in jobs.items():
            if pid in done or pid not in hist:
                continue
            done.add(pid)
            files = [im["filename"] for o in hist[pid].get("outputs", {}).values() for im in o.get("images", [])]
            print(f"done   {sid} {files} {round(time.time() - t0)}s", flush=True)


def _pick(sid: str, prefix: str) -> Path | None:
    for name in (prefix + sid + "_00001_.png", prefix + sid + "_00002_.png"):
        p = OUTPUT / name
        if p.exists():
            return p
    return None


def cmd_sheet(args) -> None:
    from PIL import Image, ImageDraw, ImageFont

    ids = args.ids.split(",")
    cols = args.cols or min(3, len(ids))
    w, h = 360, 465
    rows = (len(ids) + cols - 1) // cols
    sheet = Image.new("RGB", (w * cols, (h + 32) * rows), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
    for i, sid in enumerate(ids):
        x, y = (i % cols) * w, (i // cols) * (h + 32)
        src = _pick(sid, args.prefix) or _pick(sid, "lb_")
        if src:
            sheet.paste(Image.open(src).convert("RGB").resize((w, h)), (x, y + 32))
        else:
            draw.rectangle([x, y + 32, x + w, y + 32 + h], outline="red", width=3)
            draw.text((x + 12, y + 52), "MISSING", font=font, fill="red")
        draw.text((x + 8, y + 7), sid + " " + BY[sid]["zh"], font=font, fill="black")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=92)
    print("saved", out)


def _best_source(sid: str) -> Path | None:
    for prefix in ("fx4_", "fx3_", "fx_", "lb_"):
        p = _pick(sid, prefix)
        if p:
            return p
    return None


def cmd_assemble(_args) -> None:
    from PIL import Image

    missing = []
    for sid in BY:
        src = _best_source(sid)
        if not src:
            missing.append(sid)
            continue
        im = Image.open(src).convert("RGB")
        im.save(LOOKBOOK / (sid + ".jpg"), quality=90, optimize=True, progressive=True)
    print(f"assembled {len(BY) - len(missing)}/{len(BY)}", "missing: " + ",".join(missing) if missing else "")


def cmd_grid(_args) -> None:
    from PIL import Image, ImageDraw, ImageFont

    cols, w, h = 10, 180, 232
    rows = (len(BY) + cols - 1) // cols
    sheet = Image.new("RGB", (w * cols, (h + 22) * rows), "white")
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 14)
    for i, sid in enumerate(BY):
        x, y = (i % cols) * w, (i // cols) * (h + 22)
        sheet.paste(Image.open(LOOKBOOK / (sid + ".jpg")).convert("RGB").resize((w, h)), (x, y + 22))
        draw.text((x + 3, y + 4), BY[sid]["zh"], font=font, fill="black")
    out = SHOTS / "lookbook_all.jpg"
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=90)
    print("saved", out, sheet.size)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    g = sub.add_parser("gen", help="render styles through ComfyUI")
    g.add_argument("--ids", help="comma separated style ids (default: all 50)")
    g.add_argument("--prefix", default="lb_", help="output filename prefix")
    g.add_argument("--seed", type=int, default=2026)
    g.add_argument("--fix", action="store_true", help="apply prompt_fixes.json overrides")
    g.set_defaults(func=cmd_gen)

    s = sub.add_parser("sheet", help="contact sheet for review")
    s.add_argument("--ids", required=True)
    s.add_argument("--out", required=True)
    s.add_argument("--prefix", default="fx_")
    s.add_argument("--cols", type=int, default=0)
    s.set_defaults(func=cmd_sheet)

    sub.add_parser("assemble", help="copy the best render of each style into the lookbook").set_defaults(func=cmd_assemble)
    sub.add_parser("grid", help="10x5 contact sheet of the shipped lookbook").set_defaults(func=cmd_grid)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
