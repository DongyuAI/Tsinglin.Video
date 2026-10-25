"""Objective quality gate for lookbook stills: face present, centred, sharp, exposed."""
from __future__ import annotations

import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
LOOK = ROOT / "backend" / "app" / "lookbook"
CASCADE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
PROFILE = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_profileface.xml")


def check(p: Path) -> dict:
    img = cv2.imread(str(p))
    if img is None:
        return {"file": p.name, "error": "unreadable"}
    h, w = img.shape[:2]
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = CASCADE.detectMultiScale(gray, 1.08, 5, minSize=(int(w * 0.12), int(w * 0.12)))
    prof = PROFILE.detectMultiScale(gray, 1.08, 5, minSize=(int(w * 0.12), int(w * 0.12)))
    sharp = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    bright = float(gray.mean())
    out = {
        "file": p.name, "w": w, "h": h,
        "faces": int(len(faces)), "profiles": int(len(prof)),
        "sharp": round(sharp, 1), "bright": round(bright, 1),
    }
    if len(faces):
        x, y, fw, fh = max(faces, key=lambda f: f[2])
        out.update({
            "face_w": int(fw), "face_ratio": round(fw / w, 3),
            "face_cx": round((x + fw / 2) / w, 3), "face_cy": round((y + fh / 2) / h, 3),
        })
    return out


def main() -> None:
    files = sorted(LOOK.glob("*.png")) + sorted(LOOK.glob("*.jpg"))
    if len(sys.argv) > 1:
        files = [Path(a) for a in sys.argv[1:]]
    for f in files:
        r = check(f)
        flag = ""
        if r.get("faces", 0) == 0:
            flag = "  <-- NO FRONTAL FACE"
        elif r.get("face_ratio", 0) < 0.18:
            flag = "  <-- FACE TOO SMALL"
        elif r.get("sharp", 0) < 120:
            flag = "  <-- SOFT"
        print(r, flag)


if __name__ == "__main__":
    main()
