"""H3 Studio backend: FastAPI BFF in front of a resident sd-server (MiniMax-H3)."""
from __future__ import annotations

import base64
import mimetypes
import shutil
import uuid
from pathlib import Path

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

from . import config, graph, prompts, stylist
from .jobs import jobs
from .sdsrv import sdsrv

app = FastAPI(title="H3 Studio", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
)

config.ensure_dirs()


# ------------------------------------------------------------------- meta
@app.get("/api/health")
async def health():
    st = await sdsrv.status()
    return {"ok": True, "backend": "h3-studio", "sd_server": st}


@app.get("/api/models")
async def models():
    disc = config.discover_models()
    picked = config.pick_models()
    return {
        "roles": config.MODEL_LABELS,
        "discovered": disc,
        "picked": picked,
    }


# --------------------------------------------------------------- sd-server
@app.post("/api/sdserver/start")
async def sd_start(body: dict = Body(default={})):
    res = await sdsrv.start(models=body.get("models"), extra=body.get("extra"))
    return res


@app.post("/api/sdserver/stop")
async def sd_stop():
    return await sdsrv.stop()


@app.post("/api/sdserver/restart")
async def sd_restart(body: dict = Body(default={})):
    await sdsrv.stop()
    return await sdsrv.start(models=body.get("models"), extra=body.get("extra"))


@app.get("/api/sdserver/status")
async def sd_status():
    return await sdsrv.status()


@app.get("/api/sdserver/log")
async def sd_log(n: int = 200):
    return {"log": sdsrv.log_tail(n)}


# --------------------------------------------------------------- templates
@app.get("/api/templates")
async def templates():
    return {"templates": graph.list_templates()}


# ------------------------------------------------------- agent prompt library
@app.get("/api/prompts")
async def list_prompts():
    """Agent-facing prompt scaffolds for the four modes + a usage guide."""
    return {"prompts": prompts.list_prompts(), "guide": prompts.AGENT_GUIDE}


@app.get("/api/prompts/{mode}")
async def get_prompt(mode: str):
    p = prompts.get_prompt(mode)
    if not p:
        raise HTTPException(404, f"unknown mode: {mode}")
    return p


@app.get("/api/templates/{tid}")
async def template(tid: str):
    try:
        return graph.load_template(tid)
    except FileNotFoundError as exc:
        raise HTTPException(404, f"template not found: {exc}") from exc
    except KeyError as exc:
        raise HTTPException(404, f"unknown template: {tid}") from exc


@app.post("/api/templates/{tid}/interpret")
async def template_interpret(tid: str, body: dict = Body(default={})):
    doc = graph.load_template(tid)
    try:
        return graph.interpret(doc, body.get("overrides") or {})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc)) from exc


# -------------------------------------------------------------------- run
@app.post("/api/run")
async def run(body: dict = Body(default={})):
    """Run either a named template or an arbitrary graph the UI sends."""
    overrides = body.get("overrides") or {}
    doc = body.get("graph")
    tid = body.get("template") or "custom"
    if doc is None:
        if not body.get("template"):
            raise HTTPException(400, "provide either 'template' or 'graph'")
        try:
            doc = graph.load_template(body["template"])
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(404, str(exc)) from exc
    try:
        interp = graph.interpret(doc, overrides)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, f"graph error: {exc}") from exc

    if not await sdsrv.capabilities():
        raise HTTPException(503, "sd-server is not running (start it first)")

    job = jobs.create(tid, interp["payload"], interp["meta"])
    return job.to_dict()


@app.post("/api/interpret")
async def interpret_only(body: dict = Body(default={})):
    doc = body.get("graph")
    if doc is None and body.get("template"):
        doc = graph.load_template(body["template"])
    if doc is None:
        raise HTTPException(400, "provide 'graph' or 'template'")
    try:
        return graph.interpret(doc, body.get("overrides") or {})
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(400, str(exc)) from exc


# ------------------------------------------------------------------- jobs
@app.get("/api/jobs")
async def list_jobs(limit: int = 50):
    return {"jobs": jobs.list(limit)}


@app.get("/api/jobs/{jid}")
async def get_job(jid: str):
    job = jobs.get(jid)
    if not job:
        raise HTTPException(404, "job not found")
    return job.to_dict()


@app.get("/api/files/{jid}/{name}")
async def get_file(jid: str, name: str):
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "bad name")
    p = config.OUTPUT_DIR / jid / name
    if not p.is_file():
        raise HTTPException(404, "file not found")
    media = mimetypes.guess_type(name)[0] or "application/octet-stream"
    return FileResponse(p, media_type=media)


# ------------------------------------------------------------------ uploads
@app.post("/api/upload")
async def upload(file: UploadFile = File(...)):
    ext = Path(file.filename or "img.png").suffix or ".png"
    name = f"{uuid.uuid4().hex[:12]}{ext}"
    dest = config.OUTPUT_DIR / "uploads" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("wb") as fh:
        shutil.copyfileobj(file.file, fh)
    mime = mimetypes.guess_type(name)[0] or "image/png"
    return {
        "ok": True,
        "ref": f"h3studio:{name}",
        "url": f"/api/uploads/{name}",
        "data_uri": f"data:{mime};base64," + base64.b64encode(dest.read_bytes()).decode(),
    }


@app.get("/api/uploads")
async def list_uploads():
    d = config.OUTPUT_DIR / "uploads"
    items = []
    if d.is_dir():
        for f in sorted(d.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if f.is_file():
                items.append({"name": f.name, "ref": f"h3studio:{f.name}",
                              "url": f"/api/uploads/{f.name}"})
    return {"uploads": items}


@app.get("/api/uploads/{name}")
async def get_upload(name: str):
    if "/" in name or "\\" in name or ".." in name:
        raise HTTPException(400, "bad name")
    p = config.OUTPUT_DIR / "uploads" / name
    if not p.is_file():
        raise HTTPException(404, "not found")
    return FileResponse(p, media_type=mimetypes.guess_type(name)[0] or "image/png")


# ------------------------------------------------------------- AI 造型间
@app.get("/api/style/styles")
async def style_styles():
    return {
        "styles": stylist.STYLES,
        "colors": stylist.COLOR_HINTS,
        "defaults": {"width": 864, "height": 480, "frames": 22, "steps": 4, "cfg": 1.0},
        "negative": stylist.BASE_NEGATIVE,
    }


@app.post("/api/style/run")
async def style_run(body: dict = Body(default={})):
    style_id = body.get("style_id") or "bob_blunt"
    portrait = body.get("portrait")
    if not portrait:
        raise HTTPException(400, "portrait is required")
    if not await sdsrv.capabilities():
        raise HTTPException(503, "sd-server is not running (start it first)")

    refs: list[str] = []
    for ref in [portrait, body.get("style_ref")]:
        if not ref:
            continue
        uri = stylist.resolve_data_uri(ref)
        if not uri:
            raise HTTPException(400, f"image not found: {ref}")
        refs.append(uri)

    prompt = stylist.build_prompt(
        style_id, body.get("color", "natural"), body.get("extra", ""),
        body.get("motion", "slowly turns the head left and right"))
    payload = stylist.build_payload(
        prompt=prompt, refs=refs,
        width=int(body.get("width", 864)), height=int(body.get("height", 480)),
        frames=int(body.get("frames", 22)), steps=int(body.get("steps", 4)),
        seed=int(body.get("seed", 42)), cfg=float(body.get("cfg", 1.0)),
    )
    meta = {
        "mode": "ref2va", "feature": "style_studio", "style_id": style_id,
        "color": body.get("color", "natural"), "n_ref_images": len(refs),
        "prompt": prompt, "warnings": [],
    }
    job = jobs.create(f"style:{style_id}", payload, meta)
    return job.to_dict()


@app.get("/api/style/jobs/{jid}")
async def style_job(jid: str):
    job = jobs.get(jid)
    if not job:
        raise HTTPException(404, "job not found")
    return job.to_dict()


@app.get("/studio")
async def studio_page():
    p = Path(__file__).with_name("studio.html")
    if not p.is_file():
        raise HTTPException(404, "studio.html missing")
    return FileResponse(p, media_type="text/html", headers={"Cache-Control": "no-store"})


@app.exception_handler(Exception)
async def unhandled(_req, exc):  # noqa: ANN001
    return JSONResponse({"error": str(exc)}, status_code=500)
