/**
 * Screenshot the replica (or ComfyUI) at a chosen template + zoom.
 *
 * usage: node shot.mjs <t2v|i2v|r2v|flf> <out.png> [--scale 1] [--comfy]
 *
 * --comfy   screenshot the real ComfyUI (8188) instead of the replica (4321)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMFY_DIR = process.env.H3_COMFY_DIR || join(HERE, '..', '..', 'ComfyUI_windows_portable');

const id = process.argv[2];
const out = process.argv[3];
const scaleArg = process.argv.indexOf('--scale');
const scaleRaw = scaleArg > -1 ? process.argv[scaleArg + 1] : '1';
const fitView = scaleRaw === 'fit';          // keep the app's own fit-to-view
const scale = fitView ? 1 : Number(scaleRaw);
const useComfy = process.argv.includes('--comfy');
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TEMPLATES = {
  t2v: 'MiniMax H3：文生视频.json',
  i2v: 'MiniMax H3：图生视频.json',
  r2v: 'MiniMax H3：参考生视频.json',
  flf: 'MiniMax H3_ 首尾帧视频生成.json',
};

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let n = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++n, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
      return;
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++n; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result?.result?.value;
  return { ws, send, evaluate, ready: () => new Promise(r => ws.addEventListener('open', r)) };
}

async function pageTargets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
}

async function openTab(url) {
  const before = new Set((await pageTargets()).map(t => t.id));
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => {});
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const fresh = (await pageTargets()).find(t => !before.has(t.id) && t.url.startsWith(url));
    if (fresh) return fresh;
  }
  const hit = (await pageTargets()).find(t => t.url.startsWith(url));
  if (hit) return hit;
  throw new Error('could not open ' + url);
}

async function waitFor(conn, expr, tries = 90) {
  for (let i = 0; i < tries; i++) { await sleep(500); if (await conn.evaluate(expr) === true) { await sleep(1200); return true; } }
  return false;
}

// litegraph maps screen = (pos + offset) * scale; frame the graph's bounding
// box at (60,60) so both frontends show the same viewport for a given scale.
const frameExpr = (getCanvas, getGraph) => `(() => {
  const c = ${getCanvas}, g = ${getGraph}, s = ${scale};
  let minX = Infinity, minY = Infinity;
  for (const n of g._nodes) { minX = Math.min(minX, n.pos[0]); minY = Math.min(minY, n.pos[1]); }
  if (!isFinite(minX)) { minX = 0; minY = 0; }
  c.ds.scale = s;
  c.ds.offset[0] = 60 / s - minX;
  c.ds.offset[1] = 60 / s - minY;
  g.setDirtyCanvas(true, true);
  if (typeof c.draw === 'function') c.draw(true, true);   // force a full repaint now
  return c.ds.scale;
})()`;

if (useComfy) {
  const doc = JSON.parse(readFileSync(join(COMFY_DIR, TEMPLATES[id]), 'utf8'));
  const t = await openTab('http://127.0.0.1:8188/');
  const c = connect(t.webSocketDebuggerUrl); await c.ready();
  await c.send('Runtime.enable'); await c.send('Page.enable');
  await c.send('Page.navigate', { url: 'http://127.0.0.1:8188/' });
  if (!await waitFor(c, 'typeof app !== "undefined" && !!app.graph')) throw new Error('comfy not ready');
  await c.evaluate(`app.loadGraphData(${JSON.stringify(doc)}, true, true, false)`);
  await sleep(6000);   // let ComfyUI's fit-to-view animation finish first
  if (!fitView) {
    const setComfy = frameExpr('app.canvas', 'app.graph');
    await c.evaluate(setComfy);
    await sleep(1500);
    await c.evaluate(setComfy);
    await sleep(800);
  }
  console.log('comfy scale =', await c.evaluate('app.canvas.ds.scale'));
  const r = await c.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  console.log('saved', out);
  c.ws.close(); process.exit(0);
}

const t = await openTab('http://127.0.0.1:4321/');
const c = connect(t.webSocketDebuggerUrl); await c.ready();
await c.send('Runtime.enable'); await c.send('Page.enable');
await c.send('Page.navigate', { url: 'http://127.0.0.1:4321/' });
if (!await waitFor(c, 'window.__h3 && window.__h3.canvas && !!window.__h3.canvas.graph')) throw new Error('replica not ready');
// the template cards are built asynchronously after boot; wait for this one.
if (!await waitFor(c, `!!document.querySelector('.tpl-card[data-id="${id}"]')`)) throw new Error('template card missing: ' + id);
const wantN = JSON.parse(readFileSync(join(COMFY_DIR, TEMPLATES[id]), 'utf8')).nodes.length;
await c.evaluate(`document.querySelector('.tpl-card[data-id="${id}"]').click()`);
// the default t2v graph is already loaded; wait until the clicked template's
// node count actually appears before screenshotting.
for (let i = 0; i < 40; i++) { await sleep(500); if (await c.evaluate('window.__h3.canvas.graph._nodes.length') === wantN) break; }
await sleep(2000);   // let the replica's fit-to-view settle
if (!fitView) {
  const setReplica = frameExpr('window.__h3.canvas.canvas', 'window.__h3.canvas.graph') + '; window.__h3.canvas.listeners.zoom.forEach(f => f(' + scale + '))';
  await c.evaluate(setReplica);
  await sleep(1200);
  await c.evaluate(setReplica);
  await sleep(800);
}
console.log('replica scale =', await c.evaluate('window.__h3.canvas.canvas.ds.scale'));
const r = await c.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
writeFileSync(out, Buffer.from(r.result.data, 'base64'));
console.log('saved', out);
c.ws.close(); process.exit(0);
