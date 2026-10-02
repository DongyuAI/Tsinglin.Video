/**
 * Rigorous render diff: load each MiniMax-H3 workflow into the *real* ComfyUI
 * (8188) and into the Astro replica (4321) — in two separate browser tabs —
 * dump how each renders every node, and print the differences.
 *
 * usage: node diff-comfy.mjs [templateId ...]      (default: all four)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.CDP_PORT || 9333;
const COMFY = 'http://127.0.0.1:8188/';
const MINE = 'http://127.0.0.1:4321/';
const COMFY_DIR = process.env.H3_COMFY_DIR || join(HERE, '..', '..', 'ComfyUI_windows_portable');

const TEMPLATES = [
  { id: 't2v', file: 'MiniMax H3：文生视频.json' },
  { id: 'i2v', file: 'MiniMax H3：图生视频.json' },
  { id: 'r2v', file: 'MiniMax H3：参考生视频.json' },
  { id: 'flf', file: 'MiniMax H3_ 首尾帧视频生成.json' },
];
const want = process.argv.slice(2).filter(a => !a.startsWith('-'));
const list = want.length ? TEMPLATES.filter(t => want.includes(t.id)) : TEMPLATES;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP client
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result?.result?.value;
  };
  const ready = () => new Promise(r => ws.addEventListener('open', r));
  return { ws, send, evaluate, ready };
}

async function pageTargets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json`);
  return (await r.json()).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function openTab(url) {
  const before = new Set((await pageTargets()).map(t => t.id));
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const now = await pageTargets();
    const fresh = now.find(t => !before.has(t.id) && t.url.startsWith(url));
    if (fresh) return fresh;
  }
  // fall back: reuse any tab already on the url
  const now = await pageTargets();
  const hit = now.find(t => t.url.startsWith(url));
  if (hit) return hit;
  throw new Error('could not open tab ' + url);
}

async function waitFor(conn, expr, tries = 90) {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    if (await conn.evaluate(expr) === true) { await sleep(1200); return true; }
  }
  return false;
}

// dump expression shared by both frontends (identical shape)
const dumpExpr = (graphRef) => `(() => {
  const g = ${graphRef};
  return JSON.stringify(g._nodes.map(n => ({
    type: String((n._comfy && n._comfy.type) || n.type),
    title: n.title,
    pos: [Math.round(n.pos[0]), Math.round(n.pos[1])],
    size: [Math.round(n.size[0]), Math.round(n.size[1])],
    color: n.color || null, bgcolor: n.bgcolor || null, boxcolor: n.boxcolor || null,
    shape: n.shape,
    widgets: (n.widgets || []).map(w => ({
      name: w.name, label: w.label || w.name, value: w.value,
      disabled: !!w.computedDisabled,
    })),
    inputs: (n.inputs || [])
      // ComfyUI keeps every widget-backed socket in its input array but only
      // draws one when it is wired up; compare the drawn slots only.
      .filter(i => i.link != null || !i.widget)
      .map(i => ({ name: i.name, label: i.label || i.localized_name || i.name, type: i.type })),
    outputs: (n.outputs || []).map(o => ({ name: o.name, label: o.label || o.localized_name || o.name, type: o.type })),
  })));
})()`;

// ------------------------------------------------------------------ open tabs
const comfyTarget = (await pageTargets()).find(t => t.url.includes(':8188')) || (await pageTargets())[0];
const comfy = connect(comfyTarget.webSocketDebuggerUrl);
await comfy.ready();
await comfy.send('Runtime.enable'); await comfy.send('Page.enable');
await comfy.send('Page.navigate', { url: COMFY });
if (!await waitFor(comfy, 'typeof app !== "undefined" && !!app.graph')) throw new Error('ComfyUI not ready');
console.log('comfy tab ready');

const mineTarget = await openTab(MINE);
const mine = connect(mineTarget.webSocketDebuggerUrl);
await mine.ready();
await mine.send('Runtime.enable'); await mine.send('Page.enable');
await mine.send('Page.navigate', { url: MINE });
if (!await waitFor(mine, 'window.__h3 && window.__h3.canvas && !!window.__h3.canvas.graph')) throw new Error('replica not ready');
console.log('replica tab ready');

// ------------------------------------------------------------------ collect
const results = {};
for (const t of list) {
  const doc = JSON.parse(readFileSync(`${COMFY_DIR}/${t.file}`, 'utf8'));

  // ComfyUI ignores loadGraphData when a graph is already open, so reload the
  // page first — otherwise every template silently re-uses the first one.
  await comfy.send('Page.navigate', { url: COMFY });
  if (!await waitFor(comfy, 'typeof app !== "undefined" && !!app.graph')) throw new Error('ComfyUI not ready (reload)');
  const loaded = await comfy.evaluate(`(() => { try { app.loadGraphData(${JSON.stringify(doc)}, true, true, false); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`);
  if (loaded !== 'ok') console.log(`  [${t.id}] comfy loadGraphData: ${loaded}`);
  await sleep(3500);
  const cNodes = JSON.parse(await comfy.evaluate(dumpExpr('app.graph')) || '[]');
  if (cNodes.length !== doc.nodes.length)
    console.log(`  [${t.id}] !! comfy shows ${cNodes.length} nodes, source JSON has ${doc.nodes.length}`);

  await mine.evaluate(`document.querySelector('.tpl-card[data-id="${t.id}"]').click()`, false);
  // the first template fetches its graph over the network; poll until the node
  // count matches the source JSON instead of trusting a fixed sleep.
  const wantN = doc.nodes.length;
  let mNodes = [];
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    mNodes = JSON.parse(await mine.evaluate(dumpExpr('window.__h3.canvas.graph')) || '[]');
    if (mNodes.length === wantN) { await sleep(800); break; }
  }

  results[t.id] = { comfy: cNodes, mine: mNodes };
  console.log(`  [${t.id}] comfy=${cNodes.length} replica=${mNodes.length}`);
}

comfy.ws.close(); mine.ws.close();

// ------------------------------------------------------------------ diff
const byType = (nodes) => {
  const m = new Map();
  for (const n of nodes) m.set(n.type, n);
  return m;
};

// The replica renders every variable as `english (中文)`; ComfyUI shows either
// the English name (subgraph-promoted sockets), its own Chinese, or the short
// name of a dotted widget (`prompt` for `model.prompt`). Accept all spellings.
const sameLabel = (comfy, mine) => {
  if (comfy === mine) return true;
  const m = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(mine || '');
  const en = (m ? m[1] : String(mine ?? '')).trim();
  const zh = m ? m[2].trim() : null;
  const short = en.includes('.') ? en.split('.').pop() : en;
  return comfy === en || comfy === short || comfy === zh;
};

let totalIssues = 0;
const report = [];

for (const t of list) {
  const { comfy: cN, mine: mN } = results[t.id];
  const lines = [];
  const push = (s) => { lines.push(s); totalIssues++; };

  lines.push(`\n================ ${t.id}  (${t.file}) ================`);
  if (cN.length !== mN.length) push(`  !! node count: comfy=${cN.length} replica=${mN.length}`);

  const cm = byType(cN), mm = byType(mN);
  for (const [type, c] of cm) {
    const m = mm.get(type);
    if (!m) { push(`  !! MISSING node type ${type}`); continue; }

    if (c.title !== m.title) push(`  title   ${type}: comfy="${c.title}"  replica="${m.title}"`);
    // ComfyUI leaves color/bgcolor null and lets the canvas defaults show;
    // the replica stores those defaults explicitly. Compare the effective value.
    const eff = (v, dflt) => (v == null || v === '' ? dflt : String(v).toLowerCase());
    if (eff(c.color, '#333') !== eff(m.color, '#333')) push(`  color   ${type}: comfy=${c.color}  replica=${m.color}`);
    if (eff(c.bgcolor, '#353535') !== eff(m.bgcolor, '#353535')) push(`  bgcolor ${type}: comfy=${c.bgcolor}  replica=${m.bgcolor}`);
    if (c.pos[0] !== m.pos[0] || c.pos[1] !== m.pos[1]) push(`  pos     ${type}: comfy=[${c.pos}]  replica=[${m.pos}]`);
    if (Math.abs(c.size[0] - m.size[0]) > 1 || Math.abs(c.size[1] - m.size[1]) > 1)
      push(`  size    ${type}: comfy=[${c.size}]  replica=[${m.size}]`);

    const cw = c.widgets, mw = m.widgets;
    if (cw.length !== mw.length)
      push(`  widgets ${type}: count comfy=${cw.length} replica=${mw.length}\n      comfy  =${JSON.stringify(cw.map(w => w.name))}\n      replica=${JSON.stringify(mw.map(w => w.name))}`);
    else
      for (let i = 0; i < cw.length; i++) {
        const a = cw[i], b = mw[i];
        if (a.name !== b.name) { push(`  widget#${i} ${type}: name comfy=${a.name} replica=${b.name}`); continue; }
        if (!sameLabel(a.label, b.label)) push(`  widget   ${type}.${a.name}: label comfy="${a.label}" replica="${b.label}"`);
        if (a.disabled !== b.disabled) push(`  widget   ${type}.${a.name}: disabled comfy=${a.disabled} replica=${b.disabled}`);
        const av = a.value == null ? '' : String(a.value), bv = b.value == null ? '' : String(b.value);
        if (av !== bv) push(`  widget   ${type}.${a.name}: value comfy="${av}" replica="${bv}"`);
      }

    if (c.inputs.length !== m.inputs.length)
      push(`  inputs  ${type}: count comfy=${c.inputs.length} replica=${m.inputs.length}\n      comfy  =${JSON.stringify(c.inputs.map(i => i.label))}\n      replica=${JSON.stringify(m.inputs.map(i => i.label))}`);
    else
      for (let i = 0; i < c.inputs.length; i++)
        if (!sameLabel(c.inputs[i].label, m.inputs[i].label))
          push(`  input#${i} ${type}: comfy="${c.inputs[i].label}" replica="${m.inputs[i].label}"`);

    if (c.outputs.length !== m.outputs.length)
      push(`  outputs ${type}: count comfy=${c.outputs.length} replica=${m.outputs.length}\n      comfy  =${JSON.stringify(c.outputs.map(o => o.label))}\n      replica=${JSON.stringify(m.outputs.map(o => o.label))}`);
    else
      for (let i = 0; i < c.outputs.length; i++)
        if (!sameLabel(c.outputs[i].label, m.outputs[i].label))
          push(`  output#${i} ${type}: comfy="${c.outputs[i].label}" replica="${m.outputs[i].label}"`);
  }

  if (lines.length === 2) lines.push('  (no differences)');
  report.push(lines.join('\n'));
}

console.log(report.join('\n'));
console.log(`\n==== total divergences: ${totalIssues} ====`);
writeFileSync(join(HERE, 'diff-comfy.json'), JSON.stringify(results, null, 1));
process.exit(0);
