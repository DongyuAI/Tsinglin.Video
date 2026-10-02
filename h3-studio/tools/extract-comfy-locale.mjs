/**
 * Extract the exact strings ComfyUI's own frontend renders for the MiniMax-H3
 * node set, and emit them as `frontend/src/lib/comfy-locale.js`.
 *
 * ComfyUI localises three things at render time that are NOT in the workflow
 * JSON: node titles, widget labels, and port labels. All three are read off the
 * live frontend here (8188) rather than guessed.
 *
 * usage: node extract-comfy-locale.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMFY_DIR = process.env.H3_COMFY_DIR || join(HERE, '..', '..', 'ComfyUI_windows_portable');
const OUT = join(HERE, '..', 'frontend', 'src', 'lib', 'comfy-locale.js');
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const FILES = [
  'MiniMax H3：文生视频.json',
  'MiniMax H3：图生视频.json',
  'MiniMax H3：参考生视频.json',
  'MiniMax H3_ 首尾帧视频生成.json',
];

// ------------------------------------------------------------------ CDP
async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const page = (await r.json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('no CDP target');
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    return;
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true });
  if (r.result?.exceptionDetails) return null;
  return r.result?.result?.value;
};

await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Page.enable');

// ------------------------------------------------------------------ collect
const titleSets = new Map();   // type -> Set(title)
const widgets = {};            // type -> { name -> label }
const inputs = {};             // type -> { name -> label }
const outputs = {};            // type -> { name -> label }
const globalIn = {};           // port name -> localised (fallback for subgraph promotions)
const globalOut = {};

for (const f of FILES) {
  const doc = JSON.parse(readFileSync(`${COMFY_DIR}/${f}`, 'utf8'));
  const sgIds = new Set((doc.definitions?.subgraphs || []).map(s => s.id));

  // ComfyUI keeps the previous graph when loadGraphData is called again
  await send('Page.navigate', { url: 'http://127.0.0.1:8188/' });
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    if (await evaluate('typeof app !== "undefined" && !!app.graph') === true) break;
  }
  await sleep(1500);
  await evaluate(`(() => { try { app.loadGraphData(${JSON.stringify(doc)}, true, true, false); return 1; } catch (e) { return 0; } })()`);
  await sleep(3500);

  const dump = await evaluate(`(() => JSON.stringify(app.graph._nodes.map(n => ({
    id: n.id,
    type: String(n.type),
    title: n.title,
    widgets: (n.widgets || []).map(w => ({ name: w.name, label: w.label || w.name })),
    ins: (n.inputs || []).map(i => ({ name: i.name, label: i.label || null, loc: i.localized_name || null })),
    outs: (n.outputs || []).map(o => ({ name: o.name, label: o.label || null, loc: o.localized_name || null })),
  }))))()`);

  const defById = {};
  for (const d of doc.nodes || []) defById[d.id] = d;

  for (const n of JSON.parse(dump || '[]')) {
    if (sgIds.has(n.type) || /^[0-9a-f-]{36}$/i.test(n.type)) continue;  // subgraph instances are per-workflow
    // If the workflow set this exact title, ComfyUI is just showing it back —
    // that is a per-workflow label, not a localised node name. Its widgets and
    // ports are still localised, so only the title is skipped.
    const workflowTitle = defById[n.id]?.title;
    if (workflowTitle !== n.title) {
      if (!titleSets.has(n.type)) titleSets.set(n.type, new Set());
      titleSets.get(n.type).add(n.title);
    }

    widgets[n.type] = widgets[n.type] || {};
    for (const w of n.widgets) widgets[n.type][w.name] = w.label;

    inputs[n.type] = inputs[n.type] || {};
    for (const i of n.ins) {
      const lab = i.label || i.loc || i.name;
      inputs[n.type][i.name] = lab;
      if (i.loc && i.loc !== i.name) globalIn[i.name] = i.loc;
    }
    outputs[n.type] = outputs[n.type] || {};
    for (const o of n.outs) {
      const lab = o.label || o.loc || o.name;
      outputs[n.type][o.name] = lab;
      if (o.loc && o.loc !== o.name) globalOut[o.name] = o.loc;
    }
  }
  console.log('collected', f);
}

ws.close();

// ------------------------------------------------------------------ widget specs
// ComfyUI decides a widget's control (combo / number / toggle / button) from the
// node definition, not from the workflow JSON — so read it from object_info.
const oi = await (await fetch('http://127.0.0.1:8188/api/object_info')).json();
const seenTypes = new Set(Object.keys(widgets));
const LINK_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'MASK', 'MODEL', 'CLIP', 'VAE',
  'CONDITIONING', 'LATENT', 'SIGMAS', 'SAMPLER', 'GUIDER', 'NOISE', 'CLIP_VISION',
  'CONTROL_NET', 'STYLE_MODEL', 'UPSCALE_MODEL', 'BOUNDING_BOX', 'MESH', 'SPLAT',
  'POSE_KEYPOINT', 'FACE_LANDMARKER', 'LATENTS', 'WEBCAM', 'IMAGEUPLOAD']);
const AFTER_GEN = ['fixed', 'increment', 'decrement', 'randomize'];

const widgetSpecs = {};
for (const type of seenTypes) {
  const def = oi[type];
  if (!def) continue;
  const s = {};
  const all = { ...(def.input?.required || {}), ...(def.input?.optional || {}) };
  // dynamic combos return objects; the frontend only ever shows their `key`
  const flatten = (arr) => (arr || []).map(o => (o && typeof o === 'object' && 'key' in o) ? o.key : o);
  for (const [name, v] of Object.entries(all)) {
    const t = v[0];
    const opts = v[1] || {};
    let spec = null;
    if (Array.isArray(t)) spec = { kind: 'combo', options: flatten(t) };
    else if (t === 'COMBO' || t === 'COMFY_DYNAMICCOMBO_V3') spec = { kind: 'combo', options: flatten(opts.options) };
    else if (t === 'INT' || t === 'FLOAT') spec = { kind: 'number' };
    else if (t === 'BOOLEAN') spec = { kind: 'toggle' };
    else if (t === 'STRING') spec = { kind: 'text' };
    else if (!LINK_TYPES.has(t)) spec = { kind: 'text' };
    if (spec) s[name] = spec;

    if (opts.control_after_generate === true) s.control_after_generate = { kind: 'combo', options: AFTER_GEN };
    else if (typeof opts.control_after_generate === 'string') s[opts.control_after_generate] = { kind: 'combo', options: AFTER_GEN };
    if (opts.image_upload) s.upload = { kind: 'button' };
  }
  if (Object.keys(s).length) widgetSpecs[type] = s;
}

// ------------------------------------------------------------------ emit
// A node's localised title only counts when every instance agrees — otherwise
// the workflow simply set a custom title (e.g. the MarkdownNote headers).
const titles = {};
for (const [type, set] of titleSets) {
  if (set.size === 1) titles[type] = [...set][0];
}

const js = `// AUTO-GENERATED by tools/extract-comfy-locale.mjs — do not edit by hand.
// Extracted from the live ComfyUI frontend (locale: zh-CN) so node titles,
// widget labels and port labels match what ComfyUI itself renders.
// ComfyUI localises these at render time; they are NOT in the workflow JSON.
export const TITLES = ${JSON.stringify(titles, null, 2)};

export const WIDGET_LABELS = ${JSON.stringify(widgets, null, 2)};

export const INPUT_LABELS = ${JSON.stringify(inputs, null, 2)};

export const OUTPUT_LABELS = ${JSON.stringify(outputs, null, 2)};

// Global port-name fallbacks — subgraph promoted sockets (width, height, ...)
// carry no per-type entry, so ComfyUI localises them by name alone.
export const PORT_IN_LABELS = ${JSON.stringify(globalIn, null, 2)};

export const PORT_OUT_LABELS = ${JSON.stringify(globalOut, null, 2)};

// How ComfyUI draws each widget (control type + option list), read from its
// node definitions — the workflow JSON only stores the values.
export const WIDGET_SPECS = ${JSON.stringify(widgetSpecs, null, 2)};
`;
writeFileSync(OUT, js);
console.log('\nwrote', OUT);
console.log('titles:', Object.keys(titles).length,
  'widgets:', Object.keys(widgets).length,
  'inputs:', Object.keys(inputs).length,
  'outputs:', Object.keys(outputs).length,
  'portIn:', Object.keys(globalIn).length,
  'portOut:', Object.keys(globalOut).length);
process.exit(0);
