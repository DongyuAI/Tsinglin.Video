"""Generate a few base-portrait directions and build a contact sheet for review."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
sys.path.insert(0, str(ROOT / "tools"))

import lookbook as lb  # noqa: E402
from app import stylist  # noqa: E402

CAND = ROOT / "backend" / "app" / "lookbook" / "candidates"

VARIANTS = {
    "A_studio": (
        "明亮通透的韩系棚拍人像。25岁亚洲女性，正面看镜头，表情放松自然。"
        "奶油白背景干净、曝光充足；大面积柔光从正前方和侧前方同时打过来，整张照片是高明调，"
        "发丝边缘有一层柔和的轮廓光。皮肤清透有光泽但不磨皮，能看到真实毛孔和细绒毛；"
        "淡妆，野生眉，卧蚕，自然唇色，眼睛有高光。深棕色长直发自然垂落，发根蓬起有高颅顶。"
        "85mm 镜头，f/2.0，浅景深，高清真实照片，半身构图，不要文字。"
    ),
    "B_window": (
        "午后窗边的自然光人像。25岁亚洲女性，正面看镜头，表情松弛。"
        "米白色墙面，窗光从侧面打进来，脸上有柔和的明暗过渡，头发被逆光照透，发丝边缘发亮。"
        "皮肤通透，有真实的毛孔和绒毛，几乎没有妆感；深棕色长发蓬松有空气感，发根立起来。"
        "50mm 镜头，f/1.8，浅景深，生活感真实照片，像很会拍照的博主自拍，不要文字。"
    ),
    "C_cream": (
        "奶油色调的日系胶片人像。25岁亚洲女性，正面看镜头，表情温柔。"
        "浅色墙面背景，低饱和、暖白、柔和；逆光下发丝发亮，有一点柔焦和胶片颗粒。"
        "皮肤干净通透，淡妆，自然眉形，唇色偏豆沙；深棕色长发自然蓬松，发尾有一点弧度。"
        "85mm 镜头，浅景深，胶片质感，高清真实照片，不要文字。"
    ),
}


def main() -> None:
    CAND.mkdir(parents=True, exist_ok=True)
    for name, prompt in VARIANTS.items():
        dst = CAND / f"{name}.jpg"
        if dst.exists():
            print("skip", name, flush=True)
            continue
        webm = lb.run_job(prompt, stylist.BASE_NEGATIVE, [], name, steps=4)
        lb.poster(webm, dst, 1)
        print("done", name, flush=True)


if __name__ == "__main__":
    main()
