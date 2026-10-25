"""Identity drift check: CLIP image embedding cosine between the base portrait
and each generated hairstyle. Low cosine => the model replaced the person."""
from __future__ import annotations

import sys
from pathlib import Path

import torch
from PIL import Image
from transformers import CLIPImageProcessor, CLIPVisionModelWithProjection

ROOT = Path(__file__).resolve().parents[1]
LOOK = ROOT / "backend" / "app" / "lookbook"
MODEL = "openai/clip-vit-base-patch32"

proc = CLIPImageProcessor.from_pretrained(MODEL)
model = CLIPVisionModelWithProjection.from_pretrained(MODEL).eval()


@torch.no_grad()
def emb(p: Path) -> torch.Tensor:
    img = Image.open(p).convert("RGB")
    px = proc(images=img, return_tensors="pt")
    v = model(**px).image_embeds
    return v / v.norm(dim=-1, keepdim=True)


def main() -> None:
    base = LOOK / "_base.png"
    b = emb(base)
    files = sorted(f for f in LOOK.glob("*.jpg"))
    for f in files:
        c = float((emb(f) @ b.T).item())
        flag = "  <-- IDENTITY DRIFT" if c < 0.80 else ""
        print(f"{f.stem:16s} cos={c:.3f}{flag}")


if __name__ == "__main__":
    main()
