"""Qwen-Image-2.1-Turbo probe (port 1236). 8 steps, CFG 1."""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

SD = "http://127.0.0.1:1236"
OUT = Path(r"F:/LLMs/Minimax-H3/h3-studio/backend/app/lookbook/candidates")

POS = (
    "25岁中国女性，正面看向镜头，表情放松自然。真实感摄影，影棚柔光，"
    "奶油白背景，画面明亮通透。皮肤通透有光泽，能看到真实毛孔和细绒毛，"
    "淡妆，野生眉，卧蚕，自然唇色，眼睛里有高光。深棕色长直发，发根蓬松有高颅顶，"
    "一根根发丝清楚，发尾有重量感。85mm 镜头，浅景深，高清照片，半身构图。"
)
NEG = ""


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(SD + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def get(path: str) -> dict:
    with urllib.request.urlopen(SD + path, timeout=30) as r:
        return json.loads(r.read())


def main() -> None:
    tag = sys.argv[1] if len(sys.argv) > 1 else "qwen_test"
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 8
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 2026
    w = int(sys.argv[4]) if len(sys.argv) > 4 else 896
    h = int(sys.argv[5]) if len(sys.argv) > 5 else 1152
    body = {
        "prompt": POS, "negative_prompt": NEG,
        "width": w, "height": h, "seed": seed, "batch_count": 1,
        "output_format": "png",
        "sample_params": {"sample_steps": steps, "sample_method": "euler",
                          "scheduler": "simple", "guidance": {"txt_cfg": 1.0}},
    }
    t0 = time.time()
    sub = post("/sdcpp/v1/img_gen", body)
    jid = sub.get("id")
    print("submitted", jid, flush=True)
    while True:
        time.sleep(2)
        st = get(f"/sdcpp/v1/jobs/{jid}")
        if st.get("status") in ("completed", "done"):
            break
        if st.get("status") in ("failed", "error"):
            print("FAILED", json.dumps(st)[:500])
            return
    res = st.get("result") or {}
    b64 = res.get("b64_json")
    if not b64 and isinstance(res.get("images"), list) and res["images"]:
        b64 = res["images"][0].get("b64_json")
    if not b64:
        print("no image", json.dumps(res)[:300])
        return
    if "," in b64[:64]:
        b64 = b64.split(",", 1)[1]
    OUT.mkdir(parents=True, exist_ok=True)
    dst = OUT / f"{tag}.png"
    dst.write_bytes(base64.b64decode(b64))
    print(f"done {time.time()-t0:.0f}s -> {dst} {dst.stat().st_size//1024} KB")


if __name__ == "__main__":
    main()
