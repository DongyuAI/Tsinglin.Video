/**
 * ComfyUI-faithful graph canvas built on @comfyorg/litegraph (the same engine
 * ComfyUI's frontend uses). Renders a ComfyUI workflow JSON verbatim: nodes keep
 * their titles, ports, widgets and positions.
 *
 * ComfyUI localises titles, widget labels and port labels at render time — none
 * of that is in the workflow JSON, so it comes from comfy-locale.js (extracted
 * from the live frontend). Widget *controls* (combo / number / toggle / button)
 * and their option lists come from the same extraction.
 */
import { LiteGraph, LGraph, LGraphCanvas, LGraphNode } from '@comfyorg/litegraph';
import {
  TITLES, WIDGET_LABELS, INPUT_LABELS, OUTPUT_LABELS,
  PORT_IN_LABELS, PORT_OUT_LABELS, WIDGET_SPECS,
} from './comfy-locale.js';
import { drawMarkdown } from './markdown.js';
import { zhFor, labelEnZh } from './zh-labels.js';

/**
 * First candidate that is a real translation of `en`.
 *
 * ComfyUI's localized_name is sometimes just the English name repeated (a
 * subgraph-promoted socket keeps `first_frame`), so a plain `??` chain would
 * stop on it and never reach our glossary.
 */
function firstZh(en, ...candidates) {
  const short = en && en.includes('.') ? en.split('.').pop() : en;
  for (const c of candidates) if (c && c !== en && c !== short) return c;
  return null;
}

// --------------------------------------------------------------- theme
// Values read straight off a live ComfyUI 0.33 frontend. ComfyUI leaves
// node.color/bgcolor unset for almost every node and lets the canvas defaults
// show through, so the replica does the same instead of colour-coding by type.
export const THEME = {
  node:      { color: '#333', bgcolor: '#353535', boxcolor: '#666' },
  titleText: '#999',
  text:      '#AAA',
  link:      '#9A9',
  socket:    { input_off: '#778', input_on: '#7F7', output_off: '#778', output_on: '#7F7' },
  background: '#141414',
};

// ComfyUI's socket -> link colour table (empty entries fall back to THEME.link)
export const TYPE_COLORS = {
  MODEL: '#B39DDB', CONDITIONING: '#FFA931', LATENT: '#FF9CF9', CLIP: '#FFD500',
  VAE: '#FF6E6E', IMAGE: '#64B5F6', MASK: '#81C784', CLIP_VISION: '#A8DADC',
  CLIP_VISION_OUTPUT: '#ad7452', STYLE_MODEL: '#C2FFAE', CONTROL_NET: '#6EE7B7',
  SAMPLER: '#ECB4B4', SIGMAS: '#CDFFCD', GUIDER: '#66FFFF', NOISE: '#B0B0B0',
  TAESD: '#DCC274',
};

let samplerOptions = [];

// The DOM element the canvas lives in — needed to place the multiline editor.
let canvasElRef = null;

// ---------------------------------------------------------- multiline editor
// ComfyUI edits a multiline widget in a real textarea. litegraph's built-in
// prompt() opens a one-line <input> for text widgets (that was the "Value"
// box), so multiline widgets get their own overlay textarea pinned over the
// widget instead.
let promptEditor = null;

function closePromptEditor(commit) {
  const ed = promptEditor;
  if (!ed) return;
  promptEditor = null;
  const { ta, node, w, name, canvas } = ed;
  if (commit) {
    const v = ta.value;
    if (v !== w.value) {
      w.value = v;
      node.onWidgetChanged?.(name, v);
    }
  }
  ta.remove();
  if (node._comfy) node._comfy.editing = false;
  canvas?.setDirty?.(true, true);
}

function openPromptEditor(node, w, canvas, name) {
  if (promptEditor) closePromptEditor(true);
  const host = canvasElRef?.parentElement || document.body;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const r = w._screenRect || { left: 40, top: 80, width: 320, height: 140 };
  const cb = canvasElRef?.getBoundingClientRect();
  const hb = host.getBoundingClientRect();
  const offX = cb && hb ? cb.left - hb.left : 0;
  const offY = cb && hb ? cb.top - hb.top : 0;

  const ta = document.createElement('textarea');
  ta.className = 'h3-prompt-editor';
  ta.value = String(w.value ?? '');
  ta.spellcheck = false;
  ta.wrap = 'soft';
  Object.assign(ta.style, {
    position: 'absolute',
    left: Math.round(r.left + offX) + 'px',
    top: Math.round(r.top + offY) + 'px',
    width: Math.round(r.width) + 'px',
    height: Math.round(Math.max(72, r.height)) + 'px',
    zIndex: 60,
    boxSizing: 'border-box',
    margin: '0',
    padding: '6px 8px',
    resize: 'none',
    overflow: 'auto',
    background: '#1E1E1E',
    color: '#DDD',
    border: '1px solid #7A7A7A',
    borderRadius: '4px',
    outline: 'none',
    font: '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    lineHeight: '15px',
    whiteSpace: 'pre-wrap',
  });
  host.appendChild(ta);
  promptEditor = { ta, node, w, name, canvas };
  if (node._comfy) node._comfy.editing = true;
  canvas.setDirty(true, true);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  ta.addEventListener('blur', () => closePromptEditor(true));
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  ta.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closePromptEditor(false); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); closePromptEditor(true); }
  });
}
let schedulerOptions = [];
const staticOptions = {
  sampler_name: () => samplerOptions,
  scheduler: () => schedulerOptions,
};

export function setBackendOptions({ samplers, schedulers }) {
  if (samplers?.length) samplerOptions = samplers;
  if (schedulers?.length) schedulerOptions = schedulers.filter(s => s !== 'normal');
}

// ------------------------------------------------------- sd.cpp model bindings
// The canvas renders a ComfyUI workflow, but this app drives stable-diffusion.cpp.
// The workflow's model fields name ComfyUI safetensors that sd.cpp never loads,
// so every model widget is rebound to the file the backend actually picked.
// Keyed by widget name and by the promoted subgraph label (vae_name_1 ->
// `audio_vae`), because a promotion renames the widget on the instance.
const MODEL_ROLE_BY_WIDGET = {
  unet_name: 'diffusion', diffusion_model: 'diffusion',
  clip_name: 'llm', llm: 'llm',
  vae_name: 'vae', vae_name_1: 'audio_vae', audio_vae: 'audio_vae',
  lora_name: 'lora',
};
const NO_MODEL = 'none';

let modelPicked = {};   // role -> basename the engine loads
let modelFiles = {};    // role -> every basename on disk

export function setModels(models) {
  const disc = models?.discovered || {};
  const picked = models?.picked || {};
  modelFiles = {};
  modelPicked = {};
  for (const [role, items] of Object.entries(disc)) {
    modelFiles[role] = (items || []).map(m => m.name);
  }
  for (const [role, p] of Object.entries(picked)) {
    modelPicked[role] = p ? String(p).split(/[\\/]/).pop() : null;
  }
}

// Decimals ComfyUI renders each numeric widget with. Read off the live ComfyUI
// for all four templates (litegraph defaults to 3 when precision is unset, which
// is where the bogus `5.000` / `757358688076805.000` came from).
const WIDGET_PRECISION = {
  value_1: 1, duration: 1,                    // FLOAT seconds
  value_2: 0, turbo_steps: 0,
  strength_model_1: 2, turbo_model_strength: 2, strength_model: 2,
  denoise: 2, megapixels: 1,
  multiple: 0, resolution_steps: 0,
  width: 0, height: 0, length: 0, noise_seed: 0, seed: 0, steps: 0, fps: 0,
};

function widgetPrecision(type, name, en, socketType) {
  if (WIDGET_PRECISION[name] != null) return WIDGET_PRECISION[name];
  if (WIDGET_PRECISION[en] != null) return WIDGET_PRECISION[en];
  const t = socketType
    || (type === 'PrimitiveFloat' ? 'FLOAT' : type === 'PrimitiveInt' ? 'INT' : null);
  return t === 'FLOAT' ? 1 : 0;
}

function widgetSpec(type, name) {
  const s = WIDGET_SPECS[type]?.[name];
  if (!s) return null;
  const dyn = staticOptions[name];
  if (dyn && dyn().length) return { kind: 'combo', options: dyn() };
  return s;
}

// --------------------------------------------------------------- node class
class ComfyNode extends LGraphNode {
  constructor() {
    super();
    this.shape = 'round';
    this._comfy = { type: null, widgets: {}, widgetSpecs: [], isNote: false, scroll: 0 };
  }

  getTitle() { return this.title || this.type; }

  // keep a named widget map so the UI can read/edit values
  syncWidgets() {
    if (this._comfy.isNote) { this._comfy.widgets = { text: this._comfy.text ?? '' }; return this._comfy.widgets; }
    const out = {};
    for (const w of this.widgets || []) {
      if (w._displayOnly) continue;   // e.g. ResolutionSelector's preview row
      out[w.name] = w.value;
    }
    this._comfy.widgets = out;
    return out;
  }

  onWidgetChanged(name, value) {
    this._comfy.widgets[name] = value;
    this.__dirty = true;
    if (this.onComfyWidget) this.onComfyWidget(name, value);
  }

  // ComfyUI stops drawing a widget once its shadowing input is wired up.
  isWidgetVisible(w) {
    const slot = this.getSlotFromWidget?.(w);
    if (slot && slot.link != null) return false;
    return true;
  }
}
// NOTE: do not set ComfyNode.title_color - litegraph 0.17 uses it as the
// title-bar *fill*; leaving it unset makes the bar use the node's fg color.
LiteGraph.registerNodeType('comfy/generic', ComfyNode);

// --------------------------------------------------------------- helpers
const NOTE_TYPES = new Set(['MarkdownNote', 'Note']);

/** Greedy word wrap of a plain string into lines that fit `maxW` pixels. */
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && ctx.measureText(test).width > maxW) { out.push(line); line = word.trimStart(); }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

/**
 * ComfyUI renders STRING widgets (prompt boxes, expressions) as a tall,
 * scrollable text area rather than a one-line field.
 */
function makeTextArea(node, w) {
  w.computeSize = () => [node.size[0] - 20, node._comfy.textAreaH || 120];
  // click -> real multiline editor instead of litegraph's one-line "Value" box
  w.options = { ...(w.options || {}), multiline: true };
  w.onClick = ({ node: n, canvas: c }) => openPromptEditor(n, w, c, w.name);
  w.draw = (ctx, n, _width, y, H, lowQuality) => {
    // litegraph hands every widget the same constant height; the reserved
    // height (computeSize) is what the box actually occupies.
    const boxH = Math.max(H, n._comfy.textAreaH || H);
    const x = 8, ww = Math.max(40, n.size[0] - 16);
    // remember where this box lands on screen so the editor can sit on top of it
    try {
      const m = ctx.getTransform();
      const p0 = m.transformPoint(new DOMPoint(x, y));
      const p1 = m.transformPoint(new DOMPoint(x + ww, y + boxH));
      w._screenRect = { left: p0.x, top: p0.y, width: p1.x - p0.x, height: p1.y - p0.y };
    } catch { /* older canvas: fall back to a default position */ }
    ctx.save();
    ctx.fillStyle = '#1E1E1E';
    ctx.fillRect(x, y, ww, boxH);
    if (lowQuality) { ctx.restore(); return; }   // ComfyUI drops text when zoomed out
    if (n._comfy && n._comfy.editing) { ctx.restore(); return; }  // covered by the editor
    ctx.strokeStyle = LiteGraph.WIDGET_OUTLINE_COLOR || '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, ww, boxH);
    ctx.beginPath(); ctx.rect(x + 1, y + 1, ww - 2, boxH - 2); ctx.clip();
    ctx.fillStyle = '#DDD';
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const lines = wrapText(ctx, w.value, ww - 14);
    let cy = y + 15;
    for (const ln of lines) {
      if (cy > y + boxH - 3) break;
      ctx.fillText(ln, x + 7, cy);
      cy += 15;
    }
    // ComfyUI shows a scrollbar once the text overflows the box
    const totalH = lines.length * 15 + 6;
    if (totalH > boxH) {
      const trackH = boxH - 6;
      const barH = Math.max(20, trackH * (boxH / totalH));
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x + ww - 8, y + 3, 5, trackH);
      ctx.fillStyle = 'rgba(255,255,255,0.40)';
      ctx.fillRect(x + ww - 8, y + 3, 5, barH);
    }
    ctx.restore();
  };
  return w;
}

/** Widget control type for a value when ComfyUI's definition doesn't say. */
function fallbackKind(value) {
  if (typeof value === 'boolean') return 'toggle';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'combo';
  if (typeof value === 'string' && value.length > 60) return 'multiline';
  return 'text';
}

/** Map a ComfyUI socket type to the widget control it implies. */
function kindFromSocketType(t, value) {
  if (t === 'COMBO') return 'combo';
  if (t === 'INT' || t === 'FLOAT') return 'number';
  if (t === 'BOOLEAN') return 'toggle';
  if (t === 'STRING') return (typeof value === 'string' && value.length > 60) ? 'multiline' : 'text';
  return fallbackKind(value);
}

// Widgets that ComfyUI always renders as a tall multi-line box, regardless of
// how short the current text is.
const MULTILINE_TYPES = new Set(['PrimitiveStringMultiline']);
function isMultilineWidget(type, name) {
  if (MULTILINE_TYPES.has(type)) return true;
  return /prompt/i.test(name);
}

// --------------------------------------------------------------- loader
export function buildNode(def, subgraphs = null) {
  const node = LiteGraph.createNode('comfy/generic');
  const type = def.type || 'Node';
  // ComfyUI subgraph instances use the definition id as their node type and
  // take their displayed title from the definition's `name` (not a raw UUID).
  const sg = subgraphs ? subgraphs[type] : null;
  node.type = type;
  node._comfy.type = type;
  node._comfy.isSubgraph = !!sg;
  node._comfyId = def.id;
  // A workflow-set title wins; ComfyUI only falls back to its own localised
  // name when the node has none (and to the subgraph definition's name).
  node.title = def.title || TITLES[type] || sg?.name || type;
  node.pos = [def.pos?.[0] ?? 0, def.pos?.[1] ?? 0];
  node.size = [def.size?.[0] ?? 240, def.size?.[1] ?? 100];

  // ComfyUI leaves these unset and lets the canvas defaults render; only
  // nodes that explicitly carry colours in the JSON (e.g. MarkdownNote) differ.
  node.color = def.color || THEME.node.color;
  node.bgcolor = def.bgcolor || THEME.node.bgcolor;
  node.boxcolor = def.boxcolor || THEME.node.boxcolor;

  const named = def.widgets_values_named || {};

  // ---- MarkdownNote: ComfyUI renders the text as markdown, not as a field ----
  if (NOTE_TYPES.has(type)) {
    node._comfy.isNote = true;
    node._comfy.text = String(named.text ?? '');
    node._comfy.widgets = { text: node._comfy.text };
    node.size = [def.size?.[0] ?? 300, def.size?.[1] ?? 200];
    node.onDrawForeground = (ctx, cnv) => {
      if (cnv && cnv.low_quality) return;   // ComfyUI hides note text when zoomed out
      const pad = 8;
      drawMarkdown(ctx, node._comfy.text, pad, 2, node.size[0] - pad * 2, node.size[1] - 10, node._comfy.scroll);
    };
    // ComfyUI keeps a `text` widget on the node (the markdown is its value);
    // it is painted by the renderer above rather than as a field.
    const tw = node.addWidget('text', 'text', node._comfy.text, (v) => { node._comfy.text = v; });
    if (tw) {
      tw.serialize = true;
      tw.computeSize = () => [0, 0];
      tw.draw = () => {};
      tw._displayOnly = true;
    }
    node.size = [def.size?.[0] ?? 300, def.size?.[1] ?? 200];
    node._comfy.widgetSpecs = [{ name: 'text', kind: 'markdown', value: node._comfy.text }];
    return node;
  }

  // ---- widgets ----
  const instInput = {};
  for (const i of def.inputs || []) instInput[i.name] = i;
  const sgInput = {};
  for (const i of sg?.inputs || []) sgInput[i.name] = i;
  // subgraph promotions rename inner widgets on the instance (value_1 -> "duration")
  const promotedLabel = {};
  for (const i of def.inputs || []) if (i.label) promotedLabel[i.name] = i.label;

  const specs = [];
  for (const [name, value] of Object.entries(named)) {
    let kind, options;
    const ws = widgetSpec(type, name);
    if (ws) { kind = ws.kind; options = ws.options; }
    else { kind = kindFromSocketType(sgInput[name]?.type, value); }
    // Prompts are always edited as a multi-line box, however short the current
    // text is — ComfyUI marks these STRING inputs multiline in object_info.
    if (kind !== 'multiline' && isMultilineWidget(type, name)) kind = 'multiline';
    if (kind === 'combo' && (!options || !options.length)) options = [value];
    // rebind a model field to the file sd.cpp actually loads
    const en0 = promotedLabel[name] || name;
    const role = MODEL_ROLE_BY_WIDGET[name] || MODEL_ROLE_BY_WIDGET[en0];
    let v = value;
    if (role) {
      kind = 'combo';
      v = modelPicked[role] || NO_MODEL;
      const files = modelFiles[role] || [];
      options = files.includes(v) ? files.slice() : [v, ...files];
    }
    specs.push({ name, kind, options, value: v, role, socketType: sgInput[name]?.type });
  }
  // nodes without widgets_values_named (older/other templates): fall back to arrays
  if (!specs.length && Array.isArray(def.widgets_values)) {
    def.widgets_values.forEach((v, i) => specs.push({ name: `value_${i}`, kind: fallbackKind(v), value: v }));
  }

  for (const s of specs) {
    let w;
    // a subgraph promotion renames the inner widget (value_1 -> "duration");
    // that promoted name is the English one to show.
    const en = promotedLabel[s.name] || s.name;
    const zh = firstZh(en, WIDGET_LABELS[type]?.[s.name], zhFor(en));
    if (s.kind === 'button') {
      w = node.addWidget('button', s.name, s.value, () => {});
      if (w) w.label = labelEnZh(en, zh);
    } else if (s.kind === 'combo') {
      w = node.addWidget('combo', s.name, s.value, (v) => node.onWidgetChanged(s.name, v), { values: s.options });
    } else if (s.kind === 'toggle') {
      w = node.addWidget('toggle', s.name, !!s.value, (v) => node.onWidgetChanged(s.name, v));
    } else if (s.kind === 'number') {
      // litegraph renders `Number(value).toFixed(precision ?? 3)`; without an
      // explicit precision every integer showed up as `5.000`.
      const precision = widgetPrecision(type, s.name, en, s.socketType);
      w = node.addWidget('number', s.name, Number(s.value) || 0,
        (v) => node.onWidgetChanged(s.name, v), { step: 1, precision });
    } else {
      // multiline widgets must open a textarea, not litegraph's one-line input
      const opts = s.kind === 'multiline' ? { multiline: true } : undefined;
      w = node.addWidget('text', s.name, String(s.value ?? ''), (v) => node.onWidgetChanged(s.name, v), opts);
    }
    if (!w) continue;
    s.widget = w;
    s.en = en;
    w.serialize = true;
    // every variable is shown as `english (中文)`
    if (s.kind !== 'button') w.label = labelEnZh(en, zh);
  }

  // ComfyUI's ResolutionSelector carries a 4th, read-only row that reserves
  // space for a computed-size preview but paints nothing.
  if (type === 'ResolutionSelector') {
    const w = node.addWidget('text', 'preview', '', () => {});
    if (w) { w.label = ''; w.serialize = false; w._displayOnly = true; w.draw = () => {}; w.mouse = () => true; }
  }

  // ---- ports ----
  // A subgraph instance surfaces *every* promoted socket from its definition,
  // while the instance JSON only serialises the ones that were connected. The
  // displayed label comes from the instance entry when it renames the socket
  // (value_1 -> "duration"), otherwise from ComfyUI's localisation table.
  const instOut = {};
  for (const o of def.outputs || []) instOut[o.name] = o;

  const srcIn = sg ? (sg.inputs || []) : (def.inputs || []);
  const srcOut = sg ? (sg.outputs || []) : (def.outputs || []);

  const widgetNames = new Set(specs.map(s => s.name));
  for (const inp of srcIn) {
    const wi = instInput[inp.name];
    // A socket that shadows a widget is drawn as a widget row until it is
    // actually wired up — ComfyUI only promotes it to a slot when connected.
    const isWidgetInput = !!wi?.widget || widgetNames.has(inp.name);
    if (isWidgetInput && wi?.link == null) continue;
    const port = node.addInput(inp.name, inp.type || '*');
    if (!port) continue;
    const instLabel = wi?.label;
    // the English name: an instance rename wins, else the raw socket name
    const en = (instLabel && instLabel !== inp.name) ? instLabel : inp.name;
    // the Chinese annotation: ComfyUI's own table, then our glossary
    const zh = firstZh(en, INPUT_LABELS[type]?.[inp.name], PORT_IN_LABELS[inp.name],
      zhFor(en), inp.localized_name);
    port.label = labelEnZh(en, zh);
    if (isWidgetInput) port.widget = { name: inp.name };
  }
  for (const out of srcOut) {
    const port = node.addOutput(out.name, out.type || '*');
    if (!port) continue;
    const instLabel = instOut[out.name]?.label;
    const en = (instLabel && instLabel !== out.name) ? instLabel : out.name;
    const zh = firstZh(en, OUTPUT_LABELS[type]?.[out.name], PORT_OUT_LABELS[out.name],
      zhFor(en), out.localized_name);
    port.label = labelEnZh(en, zh);
  }

  // ComfyUI honours the size stored in the workflow and clips anything that
  // overflows, so pin the node to it instead of letting litegraph grow it.
  if (def.size) {
    const authored = [def.size[0] ?? node.size[0], def.size[1] ?? node.size[1]];
    node.size = [...authored];
    node.computeSize = () => [...authored];
    // litegraph grows a node to fit its slots/widgets (on addInput/addOutput and
    // again while arranging); ComfyUI never does — it keeps the authored box and
    // clips — so undo the growth each time it arranges.
    const arrange = node.arrange.bind(node);
    node.arrange = () => { arrange(); node.size = [...authored]; };
  }
  // ComfyUI gives any multiline box (the prompt) the vertical space left over.
  // When the node is too short for that, it stays a compact single-line field.
  const multi = specs.filter(s => s.kind === 'multiline' && s.widget);
  if (multi.length) {
    const slotsH = node.inputs.length * LiteGraph.NODE_SLOT_HEIGHT;
    const rowsH = (specs.length - multi.length) * LiteGraph.NODE_WIDGET_HEIGHT;
    const each = (node.size[1] - 30 - slotsH - rowsH - 12) / multi.length;
    if (each >= 60) {
      node._comfy.textAreaH = each;
      for (const s of multi) makeTextArea(node, s.widget);
    }
  }
  node._comfy.widgetSpecs = specs;
  return node;
}

// --------------------------------------------------------------- canvas
export function createCanvas(canvasEl) {
  const graph = new LGraph();
  const canvas = new LGraphCanvas(canvasEl, graph);
  canvasElRef = canvasEl;
  // zooming/panning moves the widget out from under the overlay editor
  canvasEl.addEventListener('wheel', () => closePromptEditor(true), { passive: true });

  const doResize = () => {
    const parent = canvasEl.parentElement;
    if (parent?.clientWidth) canvas.resize(parent.clientWidth, parent.clientHeight);
  };
  doResize();
  addEventListener('resize', doResize);
  setTimeout(doResize, 60);

  // --- values mirrored from a live ComfyUI canvas ---
  LiteGraph.NODE_DEFAULT_COLOR = THEME.node.color;
  LiteGraph.NODE_DEFAULT_BGCOLOR = THEME.node.bgcolor;
  LiteGraph.NODE_DEFAULT_BOXCOLOR = THEME.node.boxcolor;
  LiteGraph.NODE_TITLE_COLOR = THEME.titleText;
  LiteGraph.NODE_TEXT_COLOR = THEME.text;
  LiteGraph.NODE_TITLE_HEIGHT = 30;
  LiteGraph.NODE_SLOT_HEIGHT = 20;

  canvas.clear_background = true;
  canvas.clear_background_color = THEME.background;
  canvas.render_connections_shadows = false;
  canvas.connections_width = 3;
  canvas.default_link_color = THEME.link;
  canvas.default_connection_color = { ...THEME.socket };
  canvas.links_render_mode = LiteGraph.SPLINE_LINK;
  canvas.round_radius = 8;
  canvas.highquality_render = true;
  canvas.allow_searchbox = true;
  canvas.show_info = false;
  canvas.links_ontop = false;
  canvas.render_node_widgets = true;

  // ComfyUI's socket -> link colour table; unlisted types use the default link colour
  LGraphCanvas.link_type_colors = { ...TYPE_COLORS };

  graph.start();

  const listeners = { select: [], change: [], zoom: [] };
  canvas.onNodeSelected = (n) => listeners.select.forEach(f => f(n));
  canvas.onNodeDeselected = () => listeners.select.forEach(f => f(null));
  const origZoom = canvas.setZoom.bind(canvas);
  canvas.setZoom = (z, center) => { origZoom(z, center); listeners.zoom.forEach(f => f(z)); };

  return {
    graph, canvas, listeners,
    on(evt, fn) { listeners[evt]?.push(fn); },
    clear() { graph.clear(); },
    add(def, subgraphs) { const n = buildNode(def, subgraphs); graph.add(n); return n; },
    // ComfyUI serialises links as [id, originId, originSlot, targetId, targetSlot, type].
    // The slot indexes address the *serialised* port arrays, which for a subgraph
    // instance are shorter than what it renders, so resolve them by port name.
    connect(doc) {
      const byId = {};
      for (const n of graph._nodes || []) byId[n._comfyId] = n;
      const defById = {};
      for (const d of doc.nodes || []) defById[d.id] = d;
      let made = 0;
      for (const link of doc.links || []) {
        if (!Array.isArray(link) || link.length < 5) continue;
        const [, on, oslot, tn, tslot] = link;
        const oNode = byId[on], tNode = byId[tn];
        const oDef = defById[on], tDef = defById[tn];
        if (!oNode || !tNode || !oDef || !tDef) continue;
        const oName = (oDef.outputs || [])[oslot]?.name;
        const tName = (tDef.inputs || [])[tslot]?.name;
        const oIdx = (oNode.outputs || []).findIndex(o => o.name === oName);
        const tIdx = (tNode.inputs || []).findIndex(i => i.name === tName);
        if (oIdx < 0 || tIdx < 0) continue;
        oNode.connect(oIdx, tNode, tIdx);
        made++;
      }
      return made;
    },
    zoom() { return canvas.ds.scale; },
    setZoom(z) { canvas.setZoom(z); },
    fit(padding = 0.12) {
      doResize();
      const nodes = graph._nodes || [];
      if (!nodes.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.pos[0]);
        minY = Math.min(minY, n.pos[1]);
        maxX = Math.max(maxX, n.pos[0] + n.size[0]);
        maxY = Math.max(maxY, n.pos[1] + n.size[1]);
      }
      const cw = canvasEl.clientWidth, ch = canvasEl.clientHeight;
      const bw = maxX - minX, bh = maxY - minY;
      const scale = Math.min(cw / (bw * (1 + padding * 2)), ch / (bh * (1 + padding * 2)), 1.4);
      canvas.ds.scale = Math.max(0.08, scale);
      canvas.ds.offset[0] = -minX + (cw / canvas.ds.scale - bw) / 2;
      canvas.ds.offset[1] = -minY + (ch / canvas.ds.scale - bh) / 2;
      canvas.setDirty(true, true);
      listeners.zoom.forEach(f => f(canvas.ds.scale));
    },
    // every node's current widget values -> for the backend
    collect() {
      const out = [];
      for (const n of graph._nodes || []) {
        out.push({
          comfyId: n._comfyId, type: n._comfy.type, title: n.title,
          widgets: n.syncWidgets(),
        });
      }
      return out;
    },
  };
}

export { LiteGraph, LGraph, LGraphCanvas, LGraphNode };
