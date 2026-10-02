"""MCP server exposing every H3 Studio capability.

Talks to the resident backend (default http://127.0.0.1:8199) over HTTP, so the
MCP process stays stateless and the backend remains the single source of truth.

Run (stdio, the usual transport for agent clients):

    python mcp_server.py
    # or, without activating anything:
    ../ComfyUI_windows_portable/python_embeded/python.exe mcp_server.py

Run as a network server instead:

    python mcp_server.py --transport streamable-http --port 8200

Dependencies live in ./pylibs (project-local); nothing is installed into the
system interpreter and no global environment variables are required.
"""
from __future__ import annotations

import argparse
import json
import os
import site
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PYLIBS = HERE / "pylibs"

# pylibs is ABI-locked to one CPython; importing it under another gives a bare
# "DLL load failed". Re-exec under a compatible interpreter, or say so clearly.
sys.path.insert(0, str(HERE))
import pycompat  # noqa: E402

pycompat.ensure(PYLIBS)

# `site.addsitedir` (not sys.path.insert) so pywin32.pth is processed — mcp's
# Windows stdio transport needs the pywintypes shim that .pth registers.
site.addsitedir(str(PYLIBS))

import httpx  # noqa: E402
from mcp.server.mcpserver import MCPServer  # noqa: E402

# Keep stderr clean: httpx logs every request at INFO, which pollutes an agent
# client's view of the server.
import logging  # noqa: E402

logging.getLogger("httpx").setLevel(logging.WARNING)

API = os.environ.get("H3_API", "http://127.0.0.1:8199")
TIMEOUT = float(os.environ.get("H3_API_TIMEOUT", "120"))

mcp = MCPServer(
    name="h3-studio",
    title="H3 Studio (MiniMax-H3 video)",
    version="1.0",
    instructions=(
        "MiniMax-H3 video generation on a resident stable-diffusion.cpp server. "
        "Typical flow: list_templates -> get_prompt(mode) -> fill the scaffold -> "
        "upload_image (if the mode needs frames) -> run -> get_job until "
        "completed -> read media[].url. Both output dimensions must be >= 192 "
        "and multiples of 32; smaller values are raised automatically."
    ),
)


async def _req(method: str, path: str, **kw):
    url = API.rstrip("/") + path
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        r = await c.request(method, url, **kw)
    try:
        return r.json()
    except Exception:  # noqa: BLE001
        return {"status_code": r.status_code, "text": r.text[:2000]}


# ------------------------------------------------------------------ meta
@mcp.tool(description="Backend + sd-server health and current engine state.")
async def health() -> dict:
    return await _req("GET", "/api/health")


@mcp.tool(description="Discovered model files per role (diffusion / llm / vae / audio_vae).")
async def list_models() -> dict:
    return await _req("GET", "/api/models")


# ------------------------------------------------------------- templates
@mcp.tool(description="List the four MiniMax-H3 templates (t2v / i2v / r2v / flf).")
async def list_templates() -> dict:
    return await _req("GET", "/api/templates")


@mcp.tool(description="Full ComfyUI graph for one template id (t2v, i2v, r2v, flf).")
async def get_template(template_id: str) -> dict:
    return await _req("GET", f"/api/templates/{template_id}")


@mcp.tool(description=(
    "Resolve a template into the exact sd-server request without running it. "
    "overrides may set prompt / negative_prompt / width / height / length / seed / "
    "steps / sampler / scheduler / cfg_scale / output_format."))
async def interpret_template(template_id: str, overrides: dict | None = None) -> dict:
    return await _req("POST", f"/api/templates/{template_id}/interpret",
                      json={"overrides": overrides or {}})


# ---------------------------------------------------------- prompt library
@mcp.tool(description="Agent-facing prompt scaffolds for the four modes, plus a usage guide.")
async def list_prompts() -> dict:
    return await _req("GET", "/api/prompts")


@mcp.tool(description="Prompt scaffold for one mode: t2va, i2va, ref2va or fl2va.")
async def get_prompt(mode: str) -> dict:
    return await _req("GET", f"/api/prompts/{mode}")


# ------------------------------------------------------------------- run
@mcp.tool(description=(
    "Queue a generation. Give either `template` (t2v/i2v/r2v/flf) or a full "
    "ComfyUI `graph` object. Returns a job with an id to poll."))
async def run(template: str | None = None, graph: dict | None = None,
              overrides: dict | None = None) -> dict:
    body: dict = {"overrides": overrides or {}}
    if template:
        body["template"] = template
    if graph:
        body["graph"] = graph
    if not template and not graph:
        return {"error": "provide either 'template' or 'graph'"}
    return await _req("POST", "/api/run", json=body)


@mcp.tool(description="Poll one job by id (status / progress / media).")
async def get_job(job_id: str) -> dict:
    return await _req("GET", f"/api/jobs/{job_id}")


@mcp.tool(description="List recent jobs, newest first.")
async def list_jobs(limit: int = 50) -> dict:
    return await _req("GET", "/api/jobs", params={"limit": limit})


# ---------------------------------------------------------------- outputs
@mcp.tool(description="List generated outputs on disk (id, files, size).")
async def list_outputs() -> dict:
    root = HERE.parent / "outputs"
    items = []
    if root.is_dir():
        for d in sorted(root.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if not d.is_dir() or d.name == "uploads":
                continue
            files = [{"name": f.name, "size": f.stat().st_size,
                      "url": f"/api/files/{d.name}/{f.name}"}
                     for f in d.iterdir() if f.is_file()]
            meta = {}
            jf = d / "job.json"
            if jf.is_file():
                try:
                    j = json.loads(jf.read_text(encoding="utf-8"))
                    meta = {"template": j.get("template"), "status": j.get("status"),
                            "elapsed": round(j.get("elapsed") or 0, 1),
                            "warnings": (j.get("meta") or {}).get("warnings", [])}
                except Exception:  # noqa: BLE001
                    pass
            items.append({"id": d.name, "files": files, **meta})
    return {"outputs": items, "dir": str(root)}


# ---------------------------------------------------------------- uploads
@mcp.tool(description="Upload a local image so it can be used as a frame / reference.")
async def upload_image(path: str) -> dict:
    p = Path(path)
    if not p.is_file():
        return {"error": f"file not found: {path}"}
    async with httpx.AsyncClient(timeout=TIMEOUT) as c:
        with p.open("rb") as fh:
            r = await c.post(API.rstrip("/") + "/api/upload",
                             files={"file": (p.name, fh)})
    try:
        return r.json()
    except Exception:  # noqa: BLE001
        return {"status_code": r.status_code, "text": r.text[:2000]}


@mcp.tool(description="List uploaded images (h3studio:<name> refs).")
async def list_uploads() -> dict:
    return await _req("GET", "/api/uploads")


# -------------------------------------------------------------- sd-server
@mcp.tool(description="Resident sd-server status (mode, model, uptime, samplers).")
async def sd_status() -> dict:
    return await _req("GET", "/api/sdserver/status")


@mcp.tool(description="Start sd-server (resident MiniMax-H3 engine).")
async def sd_start() -> dict:
    return await _req("POST", "/api/sdserver/start", json={})


@mcp.tool(description="Stop sd-server.")
async def sd_stop() -> dict:
    return await _req("POST", "/api/sdserver/stop")


@mcp.tool(description="Restart sd-server (e.g. after changing models).")
async def sd_restart() -> dict:
    return await _req("POST", "/api/sdserver/restart", json={})


@mcp.tool(description="Tail the sd-server log.")
async def sd_log(lines: int = 200) -> dict:
    return await _req("GET", "/api/sdserver/log", params={"n": lines})


def main() -> None:
    global API
    ap = argparse.ArgumentParser(description="H3 Studio MCP server")
    ap.add_argument("--transport", default="stdio",
                    choices=["stdio", "sse", "streamable-http"])
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8200)
    ap.add_argument("--api", default=API, help="H3 Studio backend base URL")
    args = ap.parse_args()

    API = args.api
    if args.transport == "stdio":
        mcp.run("stdio")
    else:
        mcp.run(args.transport, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
