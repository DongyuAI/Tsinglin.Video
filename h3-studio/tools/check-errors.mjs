/**
 * Load every MiniMax-H3 template in the replica and report any client-side
 * errors the app surfaced (window.__h3errors) plus a per-template node count.
 *
 * usage: node check-errors.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// repo root is two levels up from h3-studio/tools
const COMFY_DIR = process.env.H3_COMFY_DIR || join(HERE, '..', '..', 'ComfyUI_windows_portable');
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
  let n = 0; const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Page.javascriptDialogOpening') {
      ws.send(JSON.stringify({ id: ++n, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); return;
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise(res => { const mid = ++n; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;
  return { ws, send, evaluate, ready: () => new Promise(r => ws.addEventListener('open', r)) };
}

async function pageTargets() { return (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter(t => t.type === 'page' && t.webSocketDebuggerUrl); }
async function openTab(url) {
  const before = new Set((await pageTargets()).map(t => t.id));
  await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).catch(() => {});
  for (let i = 0; i < 40; i++) { await sleep(400); const f = (await pageTargets()).find(t => !before.has(t.id) && t.url.startsWith(url)); if (f) return f; }
  const hit = (await pageTargets()).find(t => t.url.startsWith(url)); if (hit) return hit;
  throw new Error('could not open ' + url);
}
async function waitFor(c, expr, tries = 90) { for (let i = 0; i < tries; i++) { await sleep(500); if (await c.evaluate(expr) === true) return true; } return false; }

const t = await openTab('http://127.0.0.1:4321/');
const c = connect(t.webSocketDebuggerUrl); await c.ready();
await c.send('Runtime.enable'); await c.send('Page.enable');
await c.send('Page.navigate', { url: 'http://127.0.0.1:4321/' });
if (!await waitFor(c, 'window.__h3 && window.__h3.canvas && !!window.__h3.canvas.graph')) throw new Error('replica not ready');

let bad = 0;
for (const [id, file] of Object.entries(TEMPLATES)) {
  const wantN = JSON.parse(readFileSync(join(COMFY_DIR, file), 'utf8')).nodes.length;
  await c.evaluate('window.__h3errors = []; document.body.removeAttribute("data-h3-error")');
  if (!await waitFor(c, `!!document.querySelector('.tpl-card[data-id="${id}"]')`)) throw new Error('card missing ' + id);
  await c.evaluate(`document.querySelector('.tpl-card[data-id="${id}"]').click()`);
  let got = 0;
  for (let i = 0; i < 40; i++) { await sleep(500); got = await c.evaluate('window.__h3.canvas.graph._nodes.length'); if (got === wantN) break; }
  await sleep(600);
  const errs = await c.evaluate('JSON.stringify(window.__h3errors || [])');
  const ok = got === wantN && JSON.parse(errs).length === 0;
  if (!ok) bad++;
  console.log(`${id}: nodes ${got}/${wantN}  errors=${errs}  ${ok ? 'OK' : 'FAIL'}`);
}
console.log(bad === 0 ? '\nall templates clean' : `\n${bad} template(s) with problems`);
c.ws.close(); process.exit(0);
