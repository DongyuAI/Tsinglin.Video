"""sd-server supervisor: keeps the MiniMax-H3 model resident and proxies generation."""
from __future__ import annotations

import asyncio
import base64
import os
import subprocess
import sys
import time
from typing import Any

import httpx

from . import config


class SDServer:
    """Owns the sd-server.exe child process and talks to its HTTP API."""

    def __init__(self) -> None:
        self.proc: subprocess.Popen | None = None
        self.started_at: float | None = None
        self.last_error: str | None = None
        self._log_path = config.ROOT / "sd-server.log"
        self._log_fh = None
        self._lock = asyncio.Lock()

    # ---------------------------------------------------------------- process
    def _build_cmd(self, models: dict[str, str | None], extra: list[str]) -> list[str]:
        cmd = [str(config.SD_SERVER)]
        if models.get("diffusion"):
            cmd += ["--diffusion-model", models["diffusion"]]
        if models.get("vae"):
            cmd += ["--vae", models["vae"]]
        if models.get("audio_vae"):
            cmd += ["--audio-vae", models["audio_vae"]]
        if models.get("llm"):
            cmd += ["--llm", models["llm"]]
        cmd += ["--diffusion-fa", "--listen-ip", config.SD_HOST,
                "--listen-port", str(config.SD_PORT), "--log-level", "info"]
        # keep every weight resident on the GPUs, spread across both cards
        if config.SD_BACKEND:
            cmd += ["--backend", config.SD_BACKEND]
        if config.SD_AUTO_FIT:
            cmd += ["--auto-fit", config.SD_AUTO_FIT]
        cmd += self._sanitize_extra(extra)
        return cmd

    @staticmethod
    def _sanitize_extra(extra: list[str]) -> list[str]:
        """Drop flags that would offload weights to RAM/disk unless explicitly allowed."""
        if not extra:
            return []
        if config.SD_REQUIRE_VRAM_ONLY:
            blocked = [f for f in extra if f in config.SD_OFFLOAD_FLAGS]
            if blocked:
                raise ValueError(
                    "拒绝启动：以下参数会把权重卸载到内存/磁盘，与“模型常驻显存”冲突："
                    + ", ".join(blocked)
                    + "（如确需，设置 H3_SD_REQUIRE_VRAM_ONLY=0）")
        return list(extra)

    async def start(self, models: dict[str, str | None] | None = None,
                    extra: list[str] | None = None, wait: bool = True) -> dict:
        async with self._lock:
            if self.is_alive():
                return {"ok": True, "already_running": True, **await self.status()}
            # a server may already be listening on the port (started outside the app)
            if await self.capabilities():
                return {"ok": True, "already_running": True, "external": True,
                        **await self.status()}
            models = models or config.pick_models()
            missing = [r for r in ("diffusion", "vae", "audio_vae", "llm") if not models.get(r)]
            if missing:
                self.last_error = f"missing model(s): {', '.join(missing)}"
                return {"ok": False, "error": self.last_error}
            cmd = None
            try:
                cmd = self._build_cmd(models, extra or [])
            except ValueError as exc:
                self.last_error = str(exc)
                return {"ok": False, "error": self.last_error}
            self._log_fh = open(self._log_path, "w", encoding="utf-8", errors="replace")
            self._log_fh.write("$ " + " ".join(cmd) + "\n\n")
            self._log_fh.flush()
            creation = 0x08000000 if os.name == "nt" else 0
            self.proc = subprocess.Popen(
                cmd, cwd=str(config.SD_CPP_DIR), stdout=self._log_fh,
                stderr=subprocess.STDOUT, creationflags=creation)
            self.started_at = time.time()
            self.last_error = None
        if wait:
            ok = await self.wait_ready(timeout=900)
            if not ok:
                return {"ok": False, "error": self.last_error or "sd-server did not become ready"}
        return {"ok": True, **await self.status()}

    async def stop(self) -> dict:
        async with self._lock:
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.terminate()
                    try:
                        await asyncio.get_event_loop().run_in_executor(None, self.proc.wait, 15)
                    except subprocess.TimeoutExpired:
                        self.proc.kill()
                except Exception as exc:  # noqa: BLE001
                    self.last_error = str(exc)
            self.proc = None
            self.started_at = None
            if self._log_fh:
                try:
                    self._log_fh.close()
                except Exception:  # noqa: BLE001
                    pass
                self._log_fh = None
        return {"ok": True}

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    async def wait_ready(self, timeout: float = 900) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc is not None and self.proc.poll() is not None:
                tail = self.log_tail(20)
                self.last_error = f"sd-server exited (code {self.proc.returncode}): {tail[-500:]}"
                return False
            try:
                async with httpx.AsyncClient(timeout=3) as c:
                    r = await c.get(f"{config.SD_BASE}/sdcpp/v1/capabilities")
                    if r.status_code == 200:
                        return True
            except Exception:  # noqa: BLE001
                pass
            await asyncio.sleep(2)
        self.last_error = "timeout waiting for sd-server"
        return False

    def log_tail(self, n: int = 60) -> str:
        try:
            txt = self._log_path.read_text(encoding="utf-8", errors="replace")
            return "\n".join(txt.splitlines()[-n:])
        except Exception:  # noqa: BLE001
            return ""

    # ------------------------------------------------------------------ client
    async def capabilities(self) -> dict | None:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
                r = await c.get(f"{config.SD_BASE}/sdcpp/v1/capabilities")
                if r.status_code == 200:
                    return r.json()
        except Exception:  # noqa: BLE001
            return None
        return None

    async def status(self) -> dict:
        caps = await self.capabilities()
        return {
            "running": caps is not None,
            "process_alive": self.is_alive(),
            "uptime": (time.time() - self.started_at) if self.started_at else None,
            "mode": (caps or {}).get("current_mode"),
            "model": (caps or {}).get("model"),
            "samplers": (caps or {}).get("samplers", []),
            "schedulers": (caps or {}).get("schedulers", []),
            "output_formats": (caps or {}).get("output_formats", []),
            "features": (caps or {}).get("features", {}),
            "limits": (caps or {}).get("limits", {}),
            "defaults": (caps or {}).get("defaults_by_mode", {}).get(
                (caps or {}).get("current_mode", "vid_gen"), {}),
            "last_error": self.last_error,
        }

    async def submit(self, payload: dict) -> dict:
        async with httpx.AsyncClient(timeout=30) as c:
            r = await c.post(f"{config.SD_BASE}/sdcpp/v1/vid_gen", json=payload)
            try:
                body = r.json()
            except Exception:  # noqa: BLE001
                body = {"error": r.text}
            if r.status_code >= 400:
                raise RuntimeError(body.get("error") or f"HTTP {r.status_code}")
            return body

    async def poll(self, job_id: str) -> dict:
        async with httpx.AsyncClient(timeout=15) as c:
            r = await c.get(f"{config.SD_BASE}/sdcpp/v1/jobs/{job_id}")
            return r.json()

    async def cancel(self, job_id: str) -> dict:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                r = await c.post(f"{config.SD_BASE}/sdcpp/v1/jobs/{job_id}/cancel")
                return r.json()
        except Exception as exc:  # noqa: BLE001
            return {"ok": False, "error": str(exc)}


def save_b64_media(b64: str, out_path) -> int:
    """Decode a (possibly data-URI) base64 blob to disk. Returns byte count."""
    if "," in b64 and b64.strip().startswith("data:"):
        b64 = b64.split(",", 1)[1]
    data = base64.b64decode(b64)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(data)
    return len(data)


sdsrv = SDServer()
