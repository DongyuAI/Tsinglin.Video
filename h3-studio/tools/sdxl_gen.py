"""One-shot SDXL portrait probe against the second sd-server (port 1235)."""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

SD = "http://127.0.0.1:1235"
OUT = Path(r"F:/LLMs/Minimax-H3/h3-studio/backend/app/lookbook/candidates")

POS = (
    "(masterpiece, best quality, raw photo:1.2), 1girl, 25 year old chinese woman, "
    "ultra detailed beautiful face, delicate facial features, clear skin texture with visible pores, "
    "natural makeup, glossy lips, korean style long straight dark brown hair, fluffy crown, "
    "clean cream background, soft studio lighting, rim light on hair, "
    "85mm lens, f/2.0, shallow depth of field, film grain, sharp focus, photorealistic"
)
NEG = (
    "bad hands, bad anatomy, ugly, deformed, (face asymmetry, eyes asymmetry, deformed eyes, "
    "deformed mouth, open mouth), cartoon, anime, 3d, cgi, plastic skin, over-smooth, blurry, "
    "lowres, watermark, text, logo, extra fingers, multiple faces"
)


def post(path: str, body: dict) -> dict:
    req = urllib.request.Request(SD + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


def get(path: str) -> dict:
    with urllib.request.urlopen(SD + path, timeout=30) as r:
        return json.loads(r.read())


def main() -> None:
    tag = sys.argv[1] if len(sys.argv) > 1 else "sdxl_test"
    steps = int(sys.argv[2]) if len(sys.argv) > 2 else 30
    seed = int(sys.argv[3]) if len(sys.argv) > 3 else 2026
    body = {
        "prompt": POS, "negative_prompt": NEG,
        "width": 832, "height": 1216, "seed": seed, "batch_count": 1,
        "output_format": "png",
        "sample_params": {"sample_steps": steps, "sample_method": "dpm++2m",
                          "scheduler": "karras", "guidance": {"txt_cfg": 6.0}},
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
            print(json.dumps(st)[:600])
            return
    res = st.get("result") or {}
    b64 = res.get("b64_json") or res.get("images", [{}])[0].get("b64_json") if isinstance(res.get("images"), list) else res.get("b64_json")
    if not b64:
        print("no image", list(st), json.dumps(res)[:300])
        return
    if "," in b64[:64]:
        b64 = b64.split(",", 1)[1]
    OUT.mkdir(parents=True, exist_ok=True)
    dst = OUT / f"{tag}.png"
    dst.write_bytes(base64.b64decode(b64))
    print(f"done {time.time()-t0:.0f}s -> {dst} {dst.stat().st_size//1024} KB")


if __name__ == "__main__":
    main()
