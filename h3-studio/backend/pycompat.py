"""Interpreter compatibility guard for the project-local ``pylibs``.

``pylibs`` is installed with one specific CPython — currently **3.12**, the
ComfyUI embedded interpreter. Its compiled extensions (pywin32's
``_win32sysloader.pyd``, pydantic-core, ...) are ABI-locked, so importing them
under a different CPython fails with a bare ``DLL load failed`` traceback that
says nothing about the real cause.

``ensure()`` detects the mismatch before the first compiled import and either
re-execs the process under a compatible interpreter or exits with a bilingual,
actionable message.

No environment variables are *required*; ``H3_PYTHON`` overrides the interpreter
search and ``H3_NO_RELAUNCH=1`` turns the automatic re-exec off.
"""
from __future__ import annotations

import os
import re
import shutil
import sys
from pathlib import Path

# backend/pycompat.py -> backend -> h3-studio -> Minimax-H3
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

_TAG = re.compile(r"Tag:\s*cp(\d)(\d+)-")


def required_version(pylibs: Path) -> tuple[int, int] | None:
    """CPython (major, minor) that ``pylibs`` was built for, from WHEEL tags."""
    for wheel in sorted(pylibs.glob("*.dist-info/WHEEL")):
        try:
            text = wheel.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        m = _TAG.search(text)
        if m:
            return int(m.group(1)), int(m.group(2))
    return None


def find_python(version: tuple[int, int]) -> str | None:
    """Locate a compatible interpreter without touching the environment."""
    env = os.environ.get("H3_PYTHON")
    if env and Path(env).is_file():
        return env
    embedded = (REPO_ROOT / "ComfyUI_windows_portable" / "python_embeded"
                / "python.exe")
    if embedded.is_file():
        return str(embedded)
    for name in (f"python{version[0]}.{version[1]}",
                 f"python{version[0]}{version[1]}",
                 f"python{version[1]}"):
        exe = shutil.which(name)
        if exe:
            return exe
    return None


def _die(pylibs: Path, req: tuple[int, int]) -> "None":
    have = f"{sys.version_info[0]}.{sys.version_info[1]}"
    want = f"{req[0]}.{req[1]}"
    print(
        f"[h3-studio] pylibs 是为 Python {want} 安装的，当前解释器是 {have}；"
        f"编译扩展（pywin32 / pydantic-core）无法加载。\n"
        f"[h3-studio] pylibs was built for Python {want} but this interpreter "
        f"is {have}; its compiled extensions cannot load.\n"
        f"  请用项目解释器运行 / run with the project interpreter:\n"
        f"    {REPO_ROOT / 'ComfyUI_windows_portable' / 'python_embeded' / 'python.exe'} "
        f"{sys.argv[0]}\n"
        f"  或设置 / or set H3_PYTHON=<path-to-python{want}.exe>",
        file=sys.stderr,
    )
    raise SystemExit(2)


def ensure(pylibs: Path) -> None:
    """Fail fast (or re-exec) when the running CPython cannot load ``pylibs``."""
    req = required_version(pylibs)
    if req is None or sys.version_info[:2] == req:
        return
    if os.environ.get("H3_NO_RELAUNCH") == "1":
        _die(pylibs, req)
    exe = find_python(req)
    if not exe:
        _die(pylibs, req)
    os.environ["H3_NO_RELAUNCH"] = "1"  # never relaunch twice
    print(f"[h3-studio] re-launching under Python {req[0]}.{req[1]} -> {exe}",
          file=sys.stderr)
    try:
        os.execv(exe, [exe, *sys.argv])
    except OSError as exc:  # pragma: no cover - platform dependent
        print(f"[h3-studio] re-launch failed: {exc}", file=sys.stderr)
        _die(pylibs, req)
