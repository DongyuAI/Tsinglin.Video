"""Smoke-test the MCP server over stdio: list tools and call a few of them.

    ../ComfyUI_windows_portable/python_embeded/python.exe test_mcp.py
"""
from __future__ import annotations

import asyncio
import json
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

site.addsitedir(str(PYLIBS))

from mcp import ClientSession, StdioServerParameters  # noqa: E402
from mcp.client.stdio import stdio_client  # noqa: E402


async def main() -> int:
    params = StdioServerParameters(
        command=sys.executable, args=[str(HERE / "mcp_server.py")],
        cwd=str(HERE))
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as s:
            await s.initialize()
            tools = await s.list_tools()
            names = [t.name for t in tools.tools]
            print(f"tools ({len(names)}): {', '.join(sorted(names))}")

            calls = [
                ("health", {}),
                ("list_templates", {}),
                ("get_prompt", {"mode": "t2va"}),
                ("list_outputs", {}),
                ("sd_status", {}),
                ("interpret_template", {"template_id": "flf",
                                        "overrides": {"width": 128, "height": 96}}),
            ]
            bad = 0
            for name, args in calls:
                res = await s.call_tool(name, args)
                text = ""
                for c in res.content:
                    text += getattr(c, "text", "")
                ok = not res.is_error
                if not ok:
                    bad += 1
                print(f"  {name}: {'ok' if ok else 'ERROR'} :: {text[:180].replace(chr(10),' ')}")
            print("PASS" if bad == 0 else f"FAIL ({bad} tool errors)")
            return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
