"""Launch the H3 Studio backend with the ComfyUI-embedded Python (isolated deps)."""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / "pylibs"))
sys.path.insert(0, str(HERE))

import uvicorn  # noqa: E402

if __name__ == "__main__":
    from app import config
    uvicorn.run("app.main:app", host=config.HOST, port=config.PORT, log_level="info")
