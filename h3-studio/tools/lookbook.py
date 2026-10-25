"""Batch-generate the star-level lookbook: one AI base model, 20 hairstyles.

Runs against the resident sd-server (MiniMax-H3 ref2va) using the exact same
prompt builder the product uses, so the lookbook is a real end-to-end test.

usage: python tools/lookbook.py [--force] [--only wolf_cut,pixie]
"""
from __future__ import annotations

import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app import stylist  # noqa: E402

SD = "http://127.0.0.1:1234"
OUT = ROOT / "backend" / "app" / "lookbook"
RAW = ROOT / "bench" / "lookbook_raw"
FFMPEG = r"E:\Huayu\ffmpeg"
W, H, FRAMES, STEPS, SEED = 640, 960, 22, 4, 2026

BASE_PROMPT = (
    "integrated_multimodal_description: [Shot 1] 明亮通透的韩系棚拍半身人像。25岁亚洲女性，"
    "正面看向镜头，表情放松自然，嘴角微微上扬。奶油白背景干净、曝光充足、没有硬阴影；"
    "大面积柔光从正前方和侧前方同时打过来，整张照片是高明调，脸部和背景都很亮，"
    "发丝边缘有一层柔和的轮廓光。皮肤清透有光泽但不磨皮，能看到真实毛孔和细绒毛；"
    "淡妆，野生眉，卧蚕，自然唇色，眼睛里有高光。深棕色长直发自然垂落，发根蓬起有高颅顶，"
    "一根根发丝清楚，发尾有重量感。85mm 镜头，f/2.0，浅景深，高清真实照片，半身构图，画面干净。\n"
    "\noverall_soundscape: 安静的室内环境，轻微的呼吸声。\n"
    "\nnon_diegetic_music: N/A\n"
)
BASE_NEG = stylist.BASE_NEGATIVE


def log(msg: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {msg}"
    print(line, flush=True)


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(SD + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read())


def get(path: str) -> dict:
    with urllib.request.urlopen(SD + path, timeout=30) as r:
        return json.loads(r.read())


def run_job(prompt: str, negative: str, refs: list[str], tag: str,
            steps: int = STEPS) -> Path:
    payload = {
        "prompt": prompt, "negative_prompt": negative,
        "width": W, "height": H, "video_frames": FRAMES, "fps": 24,
        "seed": SEED, "output_format": "webm", "ref_images": refs,
        "sample_params": {"sample_steps": steps, "sample_method": "res_multistep",
                          "scheduler": "simple", "guidance": {"txt_cfg": 1.0}},
    }
    t0 = time.time()
    sub = post("/sdcpp/v1/vid_gen", payload)
    jid = sub.get("id")
    if not jid:
        raise RuntimeError(f"submit failed: {sub}")
    log(f"{tag}: submitted {jid}")
    while True:
        time.sleep(3)
        st = get(f"/sdcpp/v1/jobs/{jid}")
        status = st.get("status")
        if status in ("completed", "done", "success"):
            break
        if status in ("failed", "error", "cancelled"):
            raise RuntimeError(f"{tag}: {status} {st.get('error')}")
        if time.time() - t0 > 1800:
            raise RuntimeError(f"{tag}: timeout")
    raw = RAW / f"{tag}.webm"
    raw.parent.mkdir(parents=True, exist_ok=True)
    res = st.get("result") or {}
    blob = (res.get("b64_json") or res.get("video") or res.get("data")
            or st.get("video") or st.get("output") or "")
    if not blob:
        raise RuntimeError(f"{tag}: no media in {list(st)}")
    if "," in blob[:64]:
        blob = blob.split(",", 1)[1]
    raw.write_bytes(base64.b64decode(blob))
    log(f"{tag}: done in {time.time()-t0:.0f}s -> {raw.stat().st_size//1024} KB")
    return raw


def poster(webm: Path, out: Path, frame: int = 1) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([FFMPEG, "-y", "-v", "error", "-i", str(webm),
                    "-vf", f"select=eq(n\\,{frame})", "-frames:v", "1", "-q:v", "2",
                    str(out)], check=True)


def data_uri(p: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()


def main() -> None:
    force = "--force" in sys.argv
    only = None
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))

    OUT.mkdir(parents=True, exist_ok=True)
    base_png = OUT / "_base.png"
    if force or not base_png.exists():
        webm = run_job(BASE_PROMPT, BASE_NEG, [], "base_model", steps=4)
        poster(webm, base_png, 1)
        log(f"base model -> {base_png}")
    ref = data_uri(base_png)

    for st in stylist.STYLES:
        sid = st["id"]
        if only and sid not in only:
            continue
        dst = OUT / f"{sid}.jpg"
        if dst.exists() and not force:
            log(f"{sid}: skip (exists)")
            continue
        prompt = stylist.build_prompt(
            sid, "natural", "", motion="头部保持不动，正面看向镜头")
        try:
            webm = run_job(prompt, stylist.BASE_NEGATIVE, [ref], sid)
            poster(webm, dst, 1)
            log(f"{sid}: poster -> {dst.name} ({dst.stat().st_size//1024} KB)")
        except Exception as exc:  # noqa: BLE001
            log(f"{sid}: FAILED {exc}")
    log("ALL DONE")


if __name__ == "__main__":
    main()
