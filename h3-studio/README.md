# H3 Studio

A ComfyUI-faithful web front-end for **MiniMax-H3** running on
[`stable-diffusion.cpp`](https://github.com/leejet/stable-diffusion.cpp) — with the
model kept **resident** in an `sd-server.exe` process, so a generation never pays
the model-load cost twice.

```
┌────────────────────────┐      ┌──────────────────────┐      ┌───────────────────┐
│  Astro front-end       │ HTTP │  FastAPI BFF         │ HTTP │  sd-server.exe    │
│  (litegraph node       │─────▶│  · graph interpreter │─────▶│  MiniMax-H3       │
│   canvas, ComfyUI look)│      │  · job queue         │      │  resident in VRAM │
│  :4321                 │      │  · media store :8199 │      │  :1234            │
└────────────────────────┘      └──────────────────────┘      └───────────────────┘
```

## Quick start

```bat
:: from the h3-studio directory
start.bat
```

Then open <http://127.0.0.1:4321> and press **Start engine** in the top bar
(loads ~29 GB of weights; first load takes a while).

Or run the two halves manually:

```bat
..\ComfyUI_windows_portable\python_embeded\python.exe backend\run.py
cd frontend && npm run dev
```

## Why a BFF instead of talking to sd.cpp directly?

`sd-server` already keeps the model resident (`/sdcpp/v1/*` async job API), so no
custom inference service is needed. The FastAPI layer exists to translate
**ComfyUI workflow graphs** into sd.cpp `vid_gen` requests and to persist the
returned media:

| ComfyUI node | becomes |
|---|---|
| `MiniMaxH3ImageToVideo` | `prompt`, `width`, `height`, `length`, `init_image`, `end_image` |
| `MiniMaxH3ReferenceToVideo` | `ref_images[]` (Ref2VA) |
| `MinimaxHailuo03FirstLastFrameNode` | mapped onto local FL2VA (it is a cloud node) |
| `ResolutionSelector` | width/height from aspect ratio × megapixels |
| `ComfyMathExpression` | `duration (s)` → the model's `17k+5` frame grid |
| `ComfySwitchNode` + `Primitive*` | turbo on/off → steps |
| `KSamplerSelect` / `BasicScheduler` | `sample_method` / `scheduler` / `sample_steps` |
| `RandomNoise` | `seed` |
| `LoraLoaderModelOnly` | LoRA (applied when the switch is on) |
| `CreateVideo` / `SaveVideo` | `fps`, `output_format` |

ComfyUI **subgraphs** are expanded on the backend (`graph.py:flatten`) — promoted
inputs are matched **by name**, and promoted widget values are pushed into the
inner consumer nodes, so the four shipped templates work unmodified.

## Matching ComfyUI's canvas exactly

The canvas is the same engine ComfyUI uses (`@comfyorg/litegraph`), so node
geometry, sockets and widgets are already identical. Everything else was read
off a *live* ComfyUI and mirrored:

| what | how |
|---|---|
| subgraph node title | the definition's `name`, not the raw UUID (`Image to Video (MiniMax H3)`) |
| subgraph sockets | every promoted socket from the definition — the instance JSON only serialises the *connected* ones |
| socket labels | the instance's renamed promotions (`value_1` → `duration`) |
| widget labels | ComfyUI's own i18n strings (`duration`, `保存视频`, `宽高比`, …) |
| linked widget values | hidden — tagged `slot.widget` so litegraph blanks the value like ComfyUI |
| links | rebuilt from the serialised `links` array, resolving slots **by port name** |
| palette | node `#333`/`#353535`, title `#999`, text `#AAA`, background `#141414`, ComfyUI's socket→link colour table |

`tools/extract-comfy-locale.mjs` regenerates `frontend/src/lib/comfy-locale.js`
from the running ComfyUI; `tools/compare-comfy.mjs` loads a workflow into
ComfyUI and dumps what it renders, for side-by-side checking.

## The four templates

They live in `..\ComfyUI_windows_portable\` and are loaded verbatim:

| id | file | mode |
|---|---|---|
| `t2v` | `MiniMax H3：文生视频.json` | text → video+audio |
| `i2v` | `MiniMax H3：图生视频.json` | first frame → video+audio |
| `r2v` | `MiniMax H3：参考生视频.json` | reference images → video+audio |
| `flf` | `MiniMax H3_ 首尾帧视频生成.json` | first+last frame → video+audio |

> **Note on `flf`:** that template's node (`MinimaxHailuo03FirstLastFrameNode`) is a
> MiniMax **cloud API** node, not a local one. H3 Studio runs its *intent* locally
> through sd.cpp FL2VA and says so in the job warnings.

All four modes (t2va / i2va / fl2va / ref2va) were verified to run on the local
`minimax_h3_ref2va_pruned-Q4_K.gguf` checkpoint.

## Models

Discovered automatically from the **repo root** (the parent of `h3-studio/`, i.e.
where `ComfyUI_windows_portable/` lives) and the ComfyUI model dirs. The root is
derived from `config.py`'s own location, so a fresh clone works with no edits:

| role | file |
|---|---|
| diffusion | `minimax_h3_ref2va_pruned-Q4_K.gguf` |
| llm | `qwen3vl_32b_minimax_h3-Q4_K_M.gguf` (largest wins; `-Q2_K_M` also present) |
| vae | `minimax_h3_video_vae_fp16.safetensors` |
| audio_vae | `minimax_h3_audio_vae_fp32.safetensors` |

## GPU residency (two P40s, no RAM offload)

`backend/app/sdsrv.py` launches `sd-server` with an explicit placement instead of
letting `--auto-fit` decide, because auto-fit's fallback order is
*compute GPU → **system RAM** → other GPU → disk* — it will happily fill RAM while
the second card sits idle.

```
--backend "te=cuda0,diffusion=cuda1,vae=cuda1" --auto-fit off
```

* each module is pinned to **one** device (no cross-device split): the text
  encoder on cuda0, the diffusion model + video VAE on cuda1;
* `--auto-fit off` means the engine **never** offloads to RAM or disk — if it does
  not fit it OOMs, which is the intended policy;
* `--offload-to-cpu`, `--mmap` and `--rpc-servers` are **refused** (set
  `H3_SD_REQUIRE_VRAM_ONLY=0` to allow them deliberately).

Why pinning instead of splitting: the engine's graph-cut placer is greedy
first-fit on CUDA0 and does **not** honour `te=cuda0&cuda1` (the whole 17.4 GB
text encoder fits on cuda0 alone). The old
`diffusion=cuda0&cuda1,te=cuda0&cuda1,vae=cuda1` therefore left cuda0 at
19612 MB with only 1588 MB free while cuda1 sat at 12802 MB — and every
resolution above ~480p OOM'd on cuda0. Pinning balances the two cards:

```
te -> cuda0 17266 MB | diffusion + vae -> cuda1 16026 MB
```

Measured peaks (22 frames, 4 steps), all resident with RAM 0.00 MB:

| size | cuda0 | cuda1 | total |
|---|---|---|---|
| 864×480 | 17270 | 16706 | 33976 MB |
| 1280×736 | 17266 | 18218 | 35484 MB |
| 1344×768 | 18581 | 18434 | 37015 MB |
| 1920×1080 | 18581 | 20858 | 39439 MB |

Activation cost grows faster than pixels (attention is superlinear): +0.7 GB at
864×480 but +6.1 GB at 1080p, i.e. 5× the pixels → 9× the VRAM.

Two caveats found on this box (Pascal P40, this sd.cpp build):

* `--split-mode row` is advertised but the backend reports *"no split buffer
  type"*, so it silently falls back to layer split — don't rely on it.
* `--eager-load` is incompatible with the deferred graph-cut split (it tries to
  place every tensor on device 0 and OOMs), so it stays off.

## Resolution rule (this is what caused "meaningless colour blocks")

MiniMax-H3 collapses into per-latent-cell **colour blocks** when either axis is
too small. Measured on this box (VAE spatial factor 32):

| size | result |
|---|---|
| 64×64, 128×128, 192×128 | colour blocks |
| 288×160 (min 160) | colour blocks |
| 224×224, 256×192, 192×256, 320×224, 864×480 | clean |

So **every aligned dimension must be ≥ 192 px** (≥ 6 latent cells). `graph.py`
raises anything smaller and records a warning:

```json
"width=128 低于 MiniMax-H3 的最小有效尺寸 192（会产生色块），已提升到 192。"
```

Override the floor with `H3_MIN_DIM` if you have measured otherwise.

## Python environment

The backend runs on the **ComfyUI-embedded interpreter**
(`ComfyUI_windows_portable\python_embeded\python.exe`) and its dependencies are
installed into `backend\pylibs` with `pip install --target` — nothing is written
to the system Python and nothing is written into the embedded interpreter's own
`site-packages` either.

```bat
..\ComfyUI_windows_portable\python_embeded\python.exe -m pip install ^
  --target backend\pylibs -r backend\requirements.txt
```

## Layout

```
h3-studio/
├── backend/
│   ├── app/
│   │   ├── config.py     paths, model discovery, GPU placement, resolution floor
│   │   ├── sdsrv.py      sd-server supervisor (resident model) + client
│   │   ├── graph.py      ComfyUI graph -> sd.cpp vid_gen  (subgraph flatten)
│   │   ├── prompts.py    agent-facing prompt scaffolds per mode
│   │   ├── jobs.py       job queue + media persistence
│   │   └── main.py       FastAPI routes
│   ├── mcp_server.py     MCP server exposing every tool
│   ├── pycompat.py       interpreter guard for the ABI-locked pylibs
│   ├── test_mcp.py       MCP smoke test
│   ├── pylibs/           isolated deps, incl. mcp>=2.0 (gitignored)
│   └── run.py            launcher
├── frontend/             Astro + @comfyorg/litegraph (ComfyUI's own canvas)
│   └── src/
│       ├── pages/index.astro
│       ├── lib/comfy-canvas.js   node registry + ComfyUI theme + link wiring
│       ├── lib/comfy-locale.js   ComfyUI's rendered titles/labels (generated)
│       ├── lib/zh-labels.js      english → 中文 glossary (english (中文) labels)
│       ├── lib/app.js            UI wiring
│       └── styles/app.css
├── outputs/              generated media + uploads (gitignored)
├── tools/
│   ├── chrome.sh                 headless Chrome with the CDP endpoint
│   ├── cdp-probe.mjs             headless Chrome DevTools probe
│   ├── diff-comfy.mjs            node-by-node render diff vs live ComfyUI
│   ├── shot.mjs                  screenshot a template (replica or ComfyUI)
│   ├── gen.mjs                   submit one vid_gen job (resolution experiments)
│   ├── eval-replica.mjs          evaluate JS against the replica graph
│   ├── eval-comfy.mjs            evaluate JS against live ComfyUI
│   ├── test-prompt-editor.mjs    multiline prompt editor interaction test
│   ├── check-errors.mjs          load all templates, assert no client errors
│   ├── compare-comfy.mjs         dump what ComfyUI renders for a workflow
│   └── extract-comfy-locale.mjs  regenerate comfy-locale.js from live ComfyUI
└── start.bat
```

## MCP

`backend/mcp_server.py` exposes every backend capability as an MCP tool (18 of
them) and talks to the resident BFF over HTTP, so it holds no state of its own.

```bat
:: stdio (what agent clients use)
..\ComfyUI_windows_portable\python_embeded\python.exe backend\mcp_server.py

:: or a network server
..\ComfyUI_windows_portable\python_embeded\python.exe backend\mcp_server.py ^
   --transport streamable-http --port 8200
```

Client config (stdio) — also committed as `../.mcp.json` so clients that
auto-discover project servers need no setup:

```json
{ "mcpServers": { "h3-studio": {
    "command": "${H3_PYTHON:-ComfyUI_windows_portable/python_embeded/python.exe}",
    "args": ["${H3_REPO:-.}/h3-studio/backend/mcp_server.py"],
    "env": { "H3_API": "http://127.0.0.1:8199" } } } }
```

The paths are **relative to the repo root** and overridable via `H3_PYTHON`
(the interpreter) and `H3_REPO` (the repo root) — no machine-specific drive
letters, so a fresh clone works as-is.

`pylibs` is ABI-locked to Python 3.12, so its compiled extensions (pywin32's
`_win32sysloader.pyd`, pydantic-core) refuse to load under another interpreter —
a bare `DLL load failed` with no hint of the cause. `pycompat.ensure()` checks
the WHEEL tags first and, if the running CPython does not match, re-execs under a
compatible one (`$H3_PYTHON`, then `ComfyUI_windows_portable/python_embeded`,
then `python3.12` on PATH); if none is found it exits with a bilingual message
instead of the cryptic traceback. `H3_NO_RELAUNCH=1` disables the re-exec.

Tools: `health`, `list_models`, `list_templates`, `get_template`,
`interpret_template`, `list_prompts`, `get_prompt`, `run`, `get_job`,
`list_jobs`, `list_outputs`, `upload_image`, `list_uploads`, `sd_status`,
`sd_start`, `sd_stop`, `sd_restart`, `sd_log`.

`mcp>=2.0` is installed **into `backend/pylibs`** with the project interpreter —
no system Python, no global environment variables:

```bat
..\ComfyUI_windows_portable\python_embeded\python.exe -m pip install ^
  --target backend\pylibs "mcp>=2.0"
```

Verify with `python_embeded\python.exe backend\test_mcp.py`.

## Agent prompts

`GET /api/prompts` returns a fill-in-the-blanks scaffold per mode
(`t2va` / `i2va` / `fl2va` / `ref2va`), the fields each placeholder expects, and
a bilingual usage guide. The scaffolds are English (what the model consumes);
the field guide is Chinese. Example (`t2va`):

```
{shot_size} {camera_move} of {subject}, {action}.
Setting: {environment}, {time_of_day}.
Look: {lighting}; {lens}; {color_grade}; {film_grain}.
Motion: {motion}; one continuous take, no cuts.
Audio: {ambient_sound}; {music}.
Constraints: No on-screen text, ... keep {subject} identity consistent.
```

## Variable labels

Every port and widget is rendered as `english (中文)` — e.g. `first_frame (首帧)`,
`seed (随机种子)`, `filename_prefix (文件名前缀)`. ComfyUI's own i18n table is used
where it has an entry; `frontend/src/lib/zh-labels.js` fills the rest (ComfyUI
never localises a socket promoted out of a subgraph).

Prompt boxes are edited in a real multi-line overlay textarea
(`Enter` newline, `Ctrl+Enter`/blur commits, `Esc` cancels) rather than
litegraph's one-line *Value* input.

## API

| method | path | purpose |
|---|---|---|
| GET | `/api/health` | backend + sd-server status |
| GET | `/api/models` | discovered models per role |
| POST | `/api/sdserver/start\|stop\|restart` | resident model lifecycle |
| GET | `/api/sdserver/log` | tail of `sd-server.log` |
| GET | `/api/templates` · `/api/templates/{id}` | the four workflows |
| GET | `/api/prompts` · `/api/prompts/{mode}` | agent prompt scaffolds + usage guide |
| POST | `/api/interpret` | dry-run: graph → vid_gen payload |
| POST | `/api/run` | `{template}` or `{graph}` + `{overrides}` → job |
| GET | `/api/jobs` · `/api/jobs/{id}` | queue / status |
| GET | `/api/files/{job}/{name}` | generated media |
| POST | `/api/upload` | image inputs (returns a `h3studio:` ref) |
| GET | `/api/uploads` | uploaded images |

## Known limits

- sd.cpp exposes prompt → video; the latent space is not handed back to the
  browser, so the canvas is an editor/orchestrator, not a step-by-step executor.
- Reference/keyframe images referenced by the shipped templates
  (e.g. `red_superboy_on_city_roof.png`) are not bundled — upload your own via
  the image-inputs button (the left rail, picture icon).
- First generation after a cold start also pays the text-encoder pass; the
  engine keeps weights resident afterwards.
