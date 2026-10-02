"""Job tracking: wraps sd-server jobs, persists media to disk, exposes progress."""
from __future__ import annotations

import asyncio
import json
import time
import uuid
from pathlib import Path
from typing import Any

from . import config
from .sdsrv import sdsrv, save_b64_media


class Job:
    def __init__(self, jid: str, template: str, payload: dict, meta: dict):
        self.id = jid
        self.template = template
        self.payload = payload
        self.meta = meta
        self.status = "queued"
        self.sd_job_id: str | None = None
        self.error: str | None = None
        self.created = time.time()
        self.started = None
        self.finished = None
        self.media: list[dict] = []
        self.progress = 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "template": self.template,
            "status": self.status,
            "error": self.error,
            "created": self.created,
            "started": self.started,
            "finished": self.finished,
            "elapsed": (self.finished or time.time()) - (self.started or self.created),
            "meta": self.meta,
            "payload": {k: v for k, v in self.payload.items()
                        if not (isinstance(v, str) and v.startswith("data:"))},
            "media": self.media,
            "progress": self.progress,
        }


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def create(self, template: str, payload: dict, meta: dict) -> Job:
        jid = uuid.uuid4().hex[:12]
        job = Job(jid, template, payload, meta)
        self.jobs[jid] = job
        self._tasks[jid] = asyncio.create_task(self._run(job))
        return job

    def get(self, jid: str) -> Job | None:
        return self.jobs.get(jid)

    def list(self, limit: int = 50) -> list[dict]:
        jobs = sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)[:limit]
        return [j.to_dict() for j in jobs]

    async def _run(self, job: Job) -> None:
        job.status = "running"
        job.started = time.time()
        try:
            resp = await sdsrv.submit(job.payload)
            job.sd_job_id = resp.get("id")
            job.status = resp.get("status", "queued")
            await self._poll_loop(job)
        except Exception as exc:  # noqa: BLE001
            job.status = "failed"
            job.error = str(exc)
            job.finished = time.time()

    async def _poll_loop(self, job: Job) -> None:
        deadline = time.time() + 3600 * 3
        while time.time() < deadline:
            await asyncio.sleep(2)
            try:
                data = await sdsrv.poll(job.sd_job_id)
            except Exception as exc:  # noqa: BLE001
                job.error = f"poll failed: {exc}"
                continue
            st = (data.get("status") or "").lower()
            if st:
                job.status = st
            if data.get("error"):
                job.status = "failed"
                job.error = str(data["error"])
                job.finished = time.time()
                return
            res = data.get("result")
            if st in ("completed", "done", "succeeded") or (res and st not in ("queued", "generating")):
                self._save_media(job, res)
                job.status = "completed"
                job.finished = time.time()
                job.progress = 1.0
                self._write_sidecar(job)
                return
        job.status = "failed"
        job.error = "timed out"
        job.finished = time.time()

    def _save_media(self, job: Job, res: Any) -> None:
        if not isinstance(res, dict):
            return
        fmt = job.payload.get("output_format", "webm")
        outdir = config.OUTPUT_DIR / job.id
        outdir.mkdir(parents=True, exist_ok=True)

        b64 = res.get("b64_json") or res.get("video") or res.get("data")
        if isinstance(b64, list):
            b64 = b64[0] if b64 else None
        if b64:
            name = f"{job.id}.{fmt}"
            size = save_b64_media(b64, outdir / name)
            job.media.append({
                "kind": "video", "name": name, "size": size,
                "url": f"/api/files/{job.id}/{name}",
            })
        # any extra named outputs
        for key in ("audio", "audio_b64"):
            v = res.get(key)
            if isinstance(v, str) and v:
                name = f"{job.id}_audio.wav"
                save_b64_media(v, outdir / name)
                job.media.append({"kind": "audio", "name": name,
                                  "url": f"/api/files/{job.id}/{name}"})

    def _write_sidecar(self, job: Job) -> None:
        try:
            outdir = config.OUTPUT_DIR / job.id
            outdir.mkdir(parents=True, exist_ok=True)
            (outdir / "job.json").write_text(
                json.dumps(job.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass


jobs = JobManager()
