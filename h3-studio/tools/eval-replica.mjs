/**
 * Load a template in the replica and evaluate an expression against the graph.
 *
 * usage: node eval-replica.mjs <t2v|i2v|r2v|flf> "<js expression>"
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMFY_DIR = process.env.H3_COMFY_DIR || join(HERE, '..', '..', 'ComfyUI_windows_portable');
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const TEMPLATES = {
  t2v: 'MiniMax H3：文生视频.json',
  i2v: 'MiniMax H3：图生视频.json',
  r2v: 'MiniMax H3：参考生视频.json',
  flf: 'MiniMax H3_ 首尾帧视频生成.json',
};

const id = process.argv[2];
const expr = process.argv[3];

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
  const evaluate = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
    if (r.result?.exceptionDetails) return 'EXC ' + r.result.exceptionDetails.text;
    return r.result?.result?.value;
  };
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
async function waitFor(c, e, tries = 90) { for (let i = 0; i < tries; i++) { await sleep(500); if (await c.evaluate(e) === true) return true; } return false; }

const t = await openTab('http://127.0.0.1:4321/');
const c = connect(t.webSocketDebuggerUrl); await c.ready();
await c.send('Runtime.enable'); await c.send('Page.enable');
await c.send('Page.navigate', { url: 'http://127.0.0.1:4321/' });
if (!await waitFor(c, 'window.__h3 && window.__h3.canvas && !!window.__h3.canvas.graph')) throw new Error('replica not ready');
if (!await waitFor(c, `!!document.querySelector('.tpl-card[data-id="${id}"]')`)) throw new Error('card missing ' + id);
const wantN = JSON.parse(readFileSync(join(COMFY_DIR, TEMPLATES[id]), 'utf8')).nodes.length;
await c.evaluate(`document.querySelector('.tpl-card[data-id="${id}"]').click()`);
for (let i = 0; i < 40; i++) { await sleep(500); if (await c.evaluate('window.__h3.canvas.graph._nodes.length') === wantN) break; }
await sleep(1200);
console.log(await c.evaluate(expr));
c.ws.close(); process.exit(0);
