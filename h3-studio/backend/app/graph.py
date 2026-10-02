"""ComfyUI workflow graph -> stable-diffusion.cpp vid_gen request.

Two jobs:
  * ``flatten``  - expand ComfyUI subgraph instances into a flat node list so a
    single interpreter handles both subgraph-based and flat templates.
  * ``interpret``- walk the flat graph, evaluate the utility nodes
    (ResolutionSelector / ComfyMathExpression / ComfySwitchNode / Primitive*),
    and emit the payload sd-server's ``/sdcpp/v1/vid_gen`` expects.
"""
from __future__ import annotations

import base64
import json
import math
import mimetypes
import re
from pathlib import Path
from typing import Any

from . import config

# --------------------------------------------------------------------- widgets
WIDGET_NAMES: dict[str, list[str]] = {
    "MiniMaxH3ImageToVideo": ["prompt", "width", "height", "length"],
    "MiniMaxH3ReferenceToVideo": ["prompt", "width", "height", "length", "ref_image_size"],
    "EmptyMiniMaxH3LatentAV": ["width", "height", "length"],
    "ResolutionSelector": ["aspect_ratio", "megapixels", "multiple"],
    "ComfyMathExpression": ["expression"],
    "PrimitiveFloat": ["value"],
    "PrimitiveInt": ["value"],
    "PrimitiveBoolean": ["value"],
    "PrimitiveString": ["value"],
    "PrimitiveStringMultiline": ["value"],
    "RandomNoise": ["noise_seed", "control_after_generate"],
    "BasicScheduler": ["scheduler", "steps", "denoise"],
    "KSamplerSelect": ["sampler_name"],
    "CreateVideo": ["fps", "bit_depth", "color_space", "codec"],
    "SaveVideo": ["filename_prefix", "format", "format.codec", "codec"],
    "LoraLoaderModelOnly": ["lora_name", "strength_model"],
    "LoadImage": ["image", "upload"],
    "UNETLoader": ["unet_name", "weight_dtype"],
    "CLIPLoader": ["clip_name", "type", "device"],
    "VAELoader": ["vae_name"],
    "ComfySwitchNode": ["switch"],
    "ImageScaleToTotalPixels": ["upscale_method", "megapixels"],
    "GetImageSize": [],
    "MarkdownNote": ["text"],
    "SamplerCustomAdvanced": [],
    "BasicGuider": [],
    "VAEDecode": [],
    "VAEDecodeAudio": [],
    "MinimaxHailuo03FirstLastFrameNode": [
        "model", "model.prompt", "model.resolution", "model.duration",
        "seed", "control_after_generate", "watermark"],
}

# The cloud Hailuo-03 node has no local engine; it maps onto sd.cpp's FL2VA.
HAILUO_RESOLUTIONS = {
    "512P": (896, 512), "768P": (1344, 768), "1080P": (1344, 768),
    "480P": (864, 480), "720P": (1280, 736),
}

ASPECT_RATIOS: dict[str, tuple[float, float]] = {
    "1:1 (Square)": (1, 1),
    "3:2 (Photo)": (3, 2),
    "2:3 (Portrait Photo)": (2, 3),
    "16:9 (Widescreen)": (16, 9),
    "9:16 (Portrait Widescreen)": (9, 16),
    "4:3 (Standard)": (4, 3),
    "3:4 (Portrait Standard)": (3, 4),
    "21:9 (Cinematic)": (21, 9),
}

SAMPLER_MAP = {
    "euler": "euler", "euler_ancestral": "euler_a", "euler_cfg_pp": "euler_cfg_pp",
    "euler_ancestral_cfg_pp": "euler_a_cfg_pp", "heun": "heun", "heunpp2": "heun",
    "dpm_2": "dpm2", "dpm_2_ancestral": "dpm2", "lms": "lms",
    "dpm_fast": "dpm++2m", "dpm_adaptive": "dpm++2m",
    "dpmpp_2s_ancestral": "dpm++2s_a", "dpmpp_sde": "dpm++2m_sde",
    "dpmpp_sde_gpu": "dpm++2m_sde", "dpmpp_2m": "dpm++2m",
    "dpmpp_2m_sde": "dpm++2m_sde", "dpmpp_2m_sde_gpu": "dpm++2m_sde",
    "dpmpp_3m_sde": "dpm++2m_sde", "dpmpp_3m_sde_gpu": "dpm++2m_sde",
    "ddim": "ddim_trailing", "uni_pc": "res_multistep", "uni_pc_bh2": "res_multistep",
    "lcm": "lcm", "ipndm": "ipndm", "ipndm_v": "ipndm_v", "res_multistep": "res_multistep",
    "res_2s": "res_2s", "er_sde": "er_sde", "seeds_2": "euler", "seeds_3": "euler",
    "ddpm": "euler", "tcd": "tcd",
}

SCHEDULER_MAP = {
    "simple": "simple", "normal": "discrete", "karras": "karras",
    "exponential": "exponential", "sgm_uniform": "sgm_uniform", "beta": "beta",
    "ddim_uniform": "discrete", "linear_quadratic": "simple", "kl_optimal": "kl_optimal",
    "ays": "ays", "gits": "gits", "smoothstep": "smoothstep", "bong_tangent": "bong_tangent",
}

MODE_BY_NODE = {
    "MiniMaxH3ImageToVideo": "fl2va",
    "MiniMaxH3ReferenceToVideo": "ref2va",
    "EmptyMiniMaxH3LatentAV": "t2va",
}


# ------------------------------------------------------------------- utilities
def _node_widgets(node: dict) -> dict[str, Any]:
    named = node.get("widgets_values_named")
    if isinstance(named, dict) and named:
        out = dict(named)
    else:
        vals = node.get("widgets_values") or []
        names = WIDGET_NAMES.get(node.get("type", ""), [])
        out = {}
        for i, name in enumerate(names):
            if i < len(vals):
                out[name] = vals[i]
    # values promoted from a subgraph instance's widget (set during flatten)
    if node.get("_promoted"):
        out.update(node["_promoted"])
    return out


def _link_tuple(link: Any) -> tuple:
    """Normalise a ComfyUI link into (id, origin_id, origin_slot, target_id, target_slot)."""
    if isinstance(link, dict):
        return (link.get("id"), link.get("origin_id"), link.get("origin_slot"),
                link.get("target_id"), link.get("target_slot"))
    if isinstance(link, (list, tuple)):
        return (link[0], link[1], link[2], link[3], link[4])
    raise TypeError(f"bad link: {link!r}")


# --------------------------------------------------------------------- flatten
def flatten(doc: dict) -> dict:
    """Expand subgraph instances into a flat node/link graph."""
    nodes: dict[Any, dict] = {}
    for n in doc.get("nodes", []):
        nodes[n["id"]] = json.loads(json.dumps(n))

    links: dict[Any, tuple] = {}
    for l in doc.get("links", []):
        t = _link_tuple(l)
        links[t[0]] = t

    subgraphs = {s["id"]: s for s in doc.get("definitions", {}).get("subgraphs", [])}

    # Which input name feeds a given link id (filled while flattening).
    # link_id -> (target_node_id, target_input_name)
    changed = True
    guard = 0
    while changed and guard < 32:
        guard += 1
        changed = False
        for nid, inst in list(nodes.items()):
            sg = subgraphs.get(inst.get("type"))
            if not sg:
                continue
            changed = True
            _expand_instance(nid, inst, sg, nodes, links)
            del nodes[nid]

    # Re-index links by id after rewiring
    for nid, n in nodes.items():
        for inp in n.get("inputs", []) or []:
            lid = inp.get("link")
            if lid is not None and lid not in links:
                inp["link"] = None
    return {"nodes": list(nodes.values()), "links": [list(v) for v in links.values()]}


def _expand_instance(inst_id, inst: dict, sg: dict,
                     nodes: dict, links: dict) -> None:
    """Replace one subgraph instance with its inner nodes, rewiring links.

    Promoted inputs/outputs are matched by **name** (the instance only lists the
    ports it exposes, which need not line up index-wise with the definition).
    Promoted *widget* inputs (no outer link) push their instance value into the
    inner consumer node's widget.
    """
    prefix = f"{inst_id}::"
    inner_nodes = {n["id"]: json.loads(json.dumps(n)) for n in sg.get("nodes", [])}
    inner_links = {l["id"]: l for l in sg.get("links", []) if isinstance(l, dict)}

    idmap: dict[Any, Any] = {i: f"{prefix}{i}" for i in inner_nodes}
    linkmap: dict[Any, Any] = {i: f"{prefix}{i}" for i in inner_links}

    inst_inputs = {i.get("name"): i for i in (inst.get("inputs") or [])}
    inst_outputs = {o.get("name"): o for o in (inst.get("outputs") or [])}
    inst_w = inst.get("widgets_values_named") or {}

    # --- promoted inputs: subgraph input -> inner consumer -------------------
    for sgin in sg.get("inputs", []) or []:
        name = sgin.get("name")
        inst_in = inst_inputs.get(name)
        outer_link = inst_in.get("link") if inst_in else None
        value = inst_w.get(name)
        for lid in sgin.get("linkIds", []) or []:
            il = inner_links.get(lid)
            if not il:
                continue
            tgt, tslot = il.get("target_id"), il.get("target_slot")
            if tgt not in inner_nodes or tgt is None or tgt < 0:
                continue
            tnode = inner_nodes[tgt]
            ins = tnode.get("inputs") or []
            if tslot is None or tslot >= len(ins):
                continue
            iname = ins[tslot].get("name")
            if outer_link is not None and outer_link in links:
                ins[tslot]["link"] = outer_link
                lt = list(links[outer_link])
                lt[3], lt[4] = idmap[tgt], tslot
                links[outer_link] = tuple(lt)
            elif value is not None:
                tnode.setdefault("_promoted", {})[iname] = value

    # --- promoted outputs: inner producer -> subgraph output -----------------
    for sgout in sg.get("outputs", []) or []:
        inst_out = inst_outputs.get(sgout.get("name"))
        outer_links = (inst_out.get("links") or []) if inst_out else []
        for lid in sgout.get("linkIds", []) or []:
            il = inner_links.get(lid)
            if not il:
                continue
            origin, oslot = il.get("origin_id"), il.get("origin_slot")
            if origin not in inner_nodes or origin is None or origin < 0:
                continue
            for ol in outer_links:
                if ol in links:
                    lt = list(links[ol])
                    lt[1], lt[2] = idmap[origin], oslot
                    links[ol] = tuple(lt)

    # --- materialise inner nodes --------------------------------------------
    for iid, n in inner_nodes.items():
        n["id"] = idmap[iid]
        n["_from_subgraph"] = inst_id
        for inp in n.get("inputs") or []:
            if inp.get("link") is not None:
                inp["link"] = linkmap.get(inp["link"], inp["link"])
        for out in n.get("outputs") or []:
            if out.get("links"):
                out["links"] = [linkmap.get(x, x) for x in out["links"]]
        nodes[idmap[iid]] = n

    # --- materialise inner links (promoted ones are replaced by outer links) --
    for lid, il in inner_links.items():
        o, t = il.get("origin_id"), il.get("target_id")
        if o in (None, -10, -20) or t in (None, -10, -20):
            continue
        if o not in idmap or t not in idmap:
            continue
        links[linkmap[lid]] = (linkmap[lid], idmap[o], il.get("origin_slot"),
                               idmap[t], il.get("target_slot"))

    # --- drop outer links still pointing at the removed instance -------------
    for lid, lt in list(links.items()):
        if lt[3] == inst_id:
            del links[lid]


def resolve(doc: dict) -> dict:
    """Build lookup tables: nodes, incoming (node,input)->(origin,slot), by_type."""
    flat = flatten(doc)
    nodes = {n["id"]: n for n in flat["nodes"]}
    incoming: dict[tuple, tuple] = {}
    outgoing: dict[tuple, list] = {}
    for lt in flat["links"]:
        lid, o, oslot, t, tslot = lt
        tnode = nodes.get(t)
        if tnode is None:
            continue
        ins = tnode.get("inputs", []) or []
        name = ins[tslot]["name"] if tslot is not None and tslot < len(ins) else f"#{tslot}"
        incoming[(t, name)] = (o, oslot)
        outgoing.setdefault((o, oslot), []).append((t, name))
    by_type: dict[str, list] = {}
    for n in nodes.values():
        by_type.setdefault(n.get("type", ""), []).append(n)
    return {"nodes": nodes, "incoming": incoming, "outgoing": outgoing,
            "by_type": by_type, "flat": flat}


# ---------------------------------------------------------------- node evaluators
def _resolution_selector(w: dict) -> tuple[int, int]:
    aspect = w.get("aspect_ratio", "16:9 (Widescreen)")
    mp = float(w.get("megapixels", 1.0) or 1.0)
    mult = int(w.get("multiple", 32) or 32)
    ratio = ASPECT_RATIOS.get(aspect, (16, 9))
    r = ratio[0] / ratio[1]
    total = mp * 1_000_000
    h = math.sqrt(total / r)
    ww = h * r
    ww = max(mult, math.ceil(ww / mult) * mult)
    hh = max(mult, math.ceil(h / mult) * mult)
    return int(ww), int(hh)


_SAFE_MATH = {k: getattr(math, k) for k in
              ("sqrt", "ceil", "floor", "pi", "e", "sin", "cos", "pow")}
_SAFE_MATH.update({"max": max, "min": min, "abs": abs, "round": round, "int": int, "float": float})


def _eval_expression(expr: str, env: dict) -> Any:
    try:
        return eval(expr, {"__builtins__": {}}, {**_SAFE_MATH, **env})  # noqa: S307
    except Exception:  # noqa: BLE001
        return None


class Interpreter:
    def __init__(self, resolved: dict, overrides: dict | None = None):
        self.r = resolved
        self.nodes = resolved["nodes"]
        self.overrides = overrides or {}
        self.warnings: list[str] = []
        self.cache: dict[tuple, Any] = {}

    # --- input evaluation ---------------------------------------------------
    def input_value(self, node: dict, name: str) -> Any:
        """Value of one node input: follow a link, else fall back to the widget."""
        key = (node["id"], name)
        if key in self.cache:
            return self.cache[key]
        self.cache[key] = None  # cycle guard
        src = self.r["incoming"].get(key)
        if src is not None:
            val = self.output_value(src[0], src[1])
        else:
            w = _node_widgets(node)
            val = w.get(name)
            # promoted subgraph widget inputs live on the instance; after flattening
            # the widget name is the same, so nothing else to do
        self.cache[key] = val
        return val

    def output_value(self, node_id, slot: int) -> Any:
        node = self.nodes.get(node_id)
        if node is None:
            return None
        key = (f"out:{node_id}", slot)
        if key in self.cache:
            return self.cache[key]
        self.cache[key] = None
        t = node.get("type", "")
        w = _node_widgets(node)
        val = None
        if t == "ResolutionSelector":
            ww, hh = _resolution_selector(w)
            val = ww if slot == 0 else hh
        elif t == "ComfyMathExpression":
            env = {}
            for inp in node.get("inputs", []) or []:
                nm = inp.get("name", "")
                short = nm.split(".")[-1]
                env[short] = self.input_value(node, nm)
            res = _eval_expression(w.get("expression", ""), env)
            if slot == 0:
                val = float(res) if res is not None else None
            elif slot == 1:
                val = int(res) if res is not None else None
            else:
                val = bool(res) if res is not None else None
        elif t in ("PrimitiveFloat", "PrimitiveInt", "PrimitiveBoolean",
                   "PrimitiveString", "PrimitiveStringMultiline"):
            v = self.input_value(node, "value")
            val = v if v is not None else w.get("value")
            if t == "PrimitiveInt" and val is not None:
                val = int(val)
            elif t == "PrimitiveFloat" and val is not None:
                val = float(val)
            elif t == "PrimitiveBoolean" and val is not None:
                val = bool(val)
        elif t == "ComfySwitchNode":
            sw = self.input_value(node, "switch")
            if sw is None:
                sw = w.get("switch", False)
            val = self.input_value(node, "on_true" if sw else "on_false")
        elif t == "RandomNoise":
            val = self.input_value(node, "noise_seed")
            if val is None:
                val = w.get("noise_seed")
        elif t == "BasicScheduler":
            if slot == 0:
                val = None  # SIGMAS - not needed, scheduler name is enough
            else:
                val = None
        elif t == "KSamplerSelect":
            val = w.get("sampler_name")
        elif t == "LoadImage":
            val = w.get("image")
        elif t == "LoraLoaderModelOnly":
            val = w.get("lora_name") if slot == 0 else None
        else:
            # pass-through for wiring-only nodes (UNETLoader/CLIPLoader/VAELoader/...)
            val = w.get("value")
        self.cache[key] = val
        return val

    # --- top-level interpretation ------------------------------------------
    def interpret(self) -> dict:
        cond_node = None
        for t in ("MiniMaxH3ReferenceToVideo", "MiniMaxH3ImageToVideo",
                  "MinimaxHailuo03FirstLastFrameNode", "EmptyMiniMaxH3LatentAV"):
            if self.r["by_type"].get(t):
                cond_node = self.r["by_type"][t][0]
                break
        if cond_node is None:
            raise ValueError("no MiniMax-H3 conditioning node found in the workflow")

        hailuo = cond_node.get("type") == "MinimaxHailuo03FirstLastFrameNode"
        w = _node_widgets(cond_node)
        if hailuo:
            prompt = w.get("model.prompt") or w.get("prompt") or ""
            width, height = HAILUO_RESOLUTIONS.get(
                str(w.get("model.resolution", "768P")), (1344, 768))
            # duration (seconds) -> the model's 17k+5 frame grid at 24 fps
            length = self._align_frames(max(5, round(float(w.get("model.duration", 5) or 5) * 24)))
            self.warnings.append(
                "MinimaxHailuo03FirstLastFrameNode is a MiniMax cloud node; "
                "running it locally through stable-diffusion.cpp FL2VA instead.")
        else:
            prompt = self.input_value(cond_node, "prompt") or w.get("prompt") or ""
            width = self.input_value(cond_node, "width")
            height = self.input_value(cond_node, "height")
            length = self.input_value(cond_node, "length")
            width = int(width if width is not None else w.get("width", 1344))
            height = int(height if height is not None else w.get("height", 768))
            length = int(length if length is not None else w.get("length", 124))

        # sampler / scheduler / steps
        sampler = "euler"
        if self.r["by_type"].get("KSamplerSelect"):
            n = self.r["by_type"]["KSamplerSelect"][0]
            sampler = _node_widgets(n).get("sampler_name") or sampler
        sampler = SAMPLER_MAP.get(sampler, sampler)

        scheduler, steps = "simple", 8
        if self.r["by_type"].get("BasicScheduler"):
            n = self.r["by_type"]["BasicScheduler"][0]
            sched = _node_widgets(n).get("scheduler", "simple")
            scheduler = SCHEDULER_MAP.get(sched, "simple")
            steps = self.input_value(n, "steps")
            if steps is None:
                steps = _node_widgets(n).get("steps", 8)
            steps = int(steps)

        seed = 0
        if self.r["by_type"].get("RandomNoise"):
            n = self.r["by_type"]["RandomNoise"][0]
            s = self.input_value(n, "noise_seed")
            if s is None:
                s = _node_widgets(n).get("noise_seed", 0)
            seed = int(s)
        elif w.get("seed") is not None:
            seed = int(w["seed"])

        fps = 24
        if self.r["by_type"].get("CreateVideo"):
            fps = int(_node_widgets(self.r["by_type"]["CreateVideo"][0]).get("fps", 24) or 24)

        # LoRA (gated by the switch nodes upstream)
        lora = None
        if self.r["by_type"].get("LoraLoaderModelOnly"):
            n = self.r["by_type"]["LoraLoaderModelOnly"][0]
            lw = _node_widgets(n)
            lname = self.input_value(n, "lora_name") or lw.get("lora_name")
            strength = self.input_value(n, "strength_model")
            if strength is None:
                strength = lw.get("strength_model", 1.0)
            if lname and lname not in ("(none)", "None", ""):
                lora = {"name": lname, "strength": float(strength or 1.0)}
                # only apply when the switch that feeds BasicScheduler is ON
                if not self._lora_enabled():
                    lora = None

        # images
        init_image = end_image = None
        ref_images: list[str] = []
        if cond_node.get("type") in ("MiniMaxH3ImageToVideo",
                                     "MinimaxHailuo03FirstLastFrameNode"):
            init_image = self._image_datauri(self.input_value(cond_node, "first_frame"))
            end_image = self._image_datauri(self.input_value(cond_node, "last_frame"))
        elif cond_node.get("type") == "MiniMaxH3ReferenceToVideo":
            for inp in cond_node.get("inputs", []) or []:
                if inp.get("name", "").startswith("ref_image"):
                    u = self._image_datauri(self.input_value(cond_node, inp["name"]))
                    if u:
                        ref_images.append(u)

        # effective mode from what is actually wired up
        if ref_images:
            mode = "ref2va"
        elif init_image and end_image:
            mode = "fl2va"
        elif init_image:
            mode = "i2va"
        else:
            mode = "t2va"

        # overrides from the UI win
        ov = self.overrides
        prompt = ov.get("prompt", prompt)
        width = int(ov.get("width", width))
        height = int(ov.get("height", height))
        length = int(ov.get("length", length))
        seed = int(ov.get("seed", seed))
        steps = int(ov.get("steps", steps))
        sampler = ov.get("sampler", sampler)
        scheduler = ov.get("scheduler", scheduler)

        # align to the model's rules and enforce the measured minimum. Below
        # MIN_DIM the model collapses into per-latent-cell colour blocks.
        width = self._align_dim("width", width)
        height = self._align_dim("height", height)
        length = self._align_frames(max(5, length))

        payload: dict[str, Any] = {
            "prompt": prompt,
            "negative_prompt": ov.get("negative_prompt", ""),
            "width": width,
            "height": height,
            "video_frames": length,
            "fps": 24,
            "seed": seed,
            "output_format": ov.get("output_format", "webm"),
            "sample_params": {
                "sample_steps": steps,
                "sample_method": sampler,
                "scheduler": scheduler,
                "guidance": {"txt_cfg": float(ov.get("cfg_scale", 1.0))},
            },
        }
        if init_image:
            payload["init_image"] = init_image
        if end_image:
            payload["end_image"] = end_image
        if ref_images:
            payload["ref_images"] = ref_images

        meta = {
            "mode": mode,
            "conditioning_node": cond_node.get("type"),
            "duration_s": round(length / 24.0, 2),
            "lora": lora,
            "has_init": bool(init_image),
            "has_end": bool(end_image),
            "n_ref_images": len(ref_images),
            "fps": fps,
            "warnings": self.warnings,
        }
        return {"payload": payload, "meta": meta}

    # --- helpers ------------------------------------------------------------
    def _lora_enabled(self) -> bool:
        """True when a ComfySwitchNode gating the model/steps is switched on."""
        for n in self.r["by_type"].get("ComfySwitchNode", []):
            sw = self.input_value(n, "switch")
            if sw is None:
                sw = _node_widgets(n).get("switch", False)
            if sw:
                return True
        # No switch at all -> LoRA is unconditional
        return not self.r["by_type"].get("ComfySwitchNode")

    @staticmethod
    def _align_frames(n: int) -> int:
        while n % 17 != 5:
            n += 1
        return n

    def _align_dim(self, name: str, value: int) -> int:
        """Round a width/height to the model grid and enforce the measured minimum.

        MiniMax-H3 collapses into per-latent-cell colour blocks when either axis
        is below ``config.MIN_DIM`` (the VAE's spatial factor is 32). We clamp
        upwards and record a warning so the UI can surface it.
        """
        mult = config.DIM_MULTIPLE
        aligned = max(mult, round(value / mult) * mult)
        if aligned < config.MIN_DIM:
            self.warnings.append(
                f"{name}={value} 低于 MiniMax-H3 的最小有效尺寸 {config.MIN_DIM}"
                f"（会产生色块），已提升到 {config.MIN_DIM}。")
            aligned = config.MIN_DIM
        return int(aligned)

    def _image_datauri(self, ref: Any) -> str | None:
        if not ref:
            return None
        if isinstance(ref, str) and ref.startswith("data:"):
            return ref
        if not isinstance(ref, str):
            return None
        p = self._resolve_image_path(ref)
        if p is None:
            self.warnings.append(f"image not found: {ref}")
            return None
        mime = mimetypes.guess_type(p.name)[0] or "image/png"
        return f"data:{mime};base64," + base64.b64encode(p.read_bytes()).decode()

    @staticmethod
    def _resolve_image_path(name: str) -> Path | None:
        candidates = []
        if name.startswith("h3studio:"):
            candidates.append(config.OUTPUT_DIR / "uploads" / name.split(":", 1)[1])
        candidates += [
            config.COMFY_DIR / "ComfyUI" / "input" / name,
            config.BASE / "inputs" / name,
            config.BASE / name,
            config.OUTPUT_DIR / "uploads" / name,
        ]
        for c in candidates:
            if c.is_file():
                return c
        return None


def interpret(doc: dict, overrides: dict | None = None) -> dict:
    return Interpreter(resolve(doc), overrides).interpret()


# ------------------------------------------------------------------- templates
TEMPLATE_FILES = [
    ("t2v", "MiniMax H3：文生视频.json", "文生视频", "t2va"),
    ("i2v", "MiniMax H3：图生视频.json", "图生视频", "i2va"),
    ("r2v", "MiniMax H3：参考生视频.json", "参考生视频", "ref2va"),
    ("flf", "MiniMax H3_ 首尾帧视频生成.json", "首尾帧视频生成", "fl2va"),
]


def list_templates() -> list[dict]:
    out = []
    for tid, fname, label, mode in TEMPLATE_FILES:
        p = config.COMFY_DIR / fname
        out.append({
            "id": tid, "label": label, "mode": mode,
            "file": fname, "exists": p.is_file(),
            "size": p.stat().st_size if p.is_file() else 0,
        })
    return out


def load_template(tid: str) -> dict:
    for t in TEMPLATE_FILES:
        if t[0] == tid:
            p = config.COMFY_DIR / t[1]
            if not p.is_file():
                raise FileNotFoundError(str(p))
            return json.loads(p.read_text(encoding="utf-8"))
    raise KeyError(tid)
