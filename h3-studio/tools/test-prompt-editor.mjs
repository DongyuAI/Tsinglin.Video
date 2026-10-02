/**
 * Interaction test: click the prompt box in the replica and verify a real
 * multi-line editor opens (not litegraph's one-line "Value" input), that
 * editing + blurring commits the new value, and that Esc cancels.
 *
 * usage: node test-prompt-editor.mjs [t2v|i2v|r2v|flf]
 */
import { readFileSync, writeFileSync } from 'node:fs';
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
const id = process.argv[2] || 'flf';

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
await sleep(1500);

// zoom in so the prompt box is big enough to click
await c.evaluate(`(() => { const w=window.__h3.canvas, cc=w.canvas; cc.ds.scale=1; const g=w.graph;
  let minX=Infinity,minY=Infinity; for(const n of g._nodes){minX=Math.min(minX,n.pos[0]);minY=Math.min(minY,n.pos[1]);}
  cc.ds.offset[0]=80-minX; cc.ds.offset[1]=80-minY; cc.draw(true,true); })()`);
await sleep(800);

// locate the prompt widget and its page-space centre
const hit = await c.evaluate(`(() => {
  const g = window.__h3.canvas.graph;
  for (const n of g._nodes) for (const w of (n.widgets||[])) {
    if (/prompt/i.test(w.name) && w._screenRect) {
      const r = w._screenRect;
      const cb = document.getElementById('graph-canvas').getBoundingClientRect();
      return JSON.stringify({ name:w.name, value:String(w.value).slice(0,40),
        x: cb.left + r.left + r.width/2, y: cb.top + r.top + Math.min(r.height/2, 20) });
    }
  }
  return null;
})()`);
if (!hit) { console.log('FAIL: no prompt widget with a screen rect found'); process.exit(1); }
const info = JSON.parse(hit);
console.log('prompt widget:', info.name, '| value:', JSON.stringify(info.value));

await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
await sleep(500);

const ed = await c.evaluate(`(() => { const t=document.querySelector('.h3-prompt-editor');
  if(!t) return null; return JSON.stringify({tag:t.tagName, multiline:t.tagName==='TEXTAREA', rows:t.rows, h:t.style.height}); })()`);
console.log('editor after click:', ed);
if (!ed) { console.log('FAIL: no editor opened'); process.exit(1); }
const e = JSON.parse(ed);
if (!e.multiline) { console.log('FAIL: editor is not a textarea'); process.exit(1); }
{
  const shot = process.env.SHOT || join(HERE, 'prompt-editor.png');
  const r = await c.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  writeFileSync(shot, Buffer.from(r.result.data, 'base64'));
  console.log('editor screenshot ->', shot);
}

// type a new value, then blur to commit
const NEW = 'line one\nline two\nline three';
await c.evaluate(`(() => { const t=document.querySelector('.h3-prompt-editor'); t.value=${JSON.stringify(NEW)}; t.blur(); })()`);
await sleep(500);
const after = await c.evaluate(`(() => { const g=window.__h3.canvas.graph;
  for (const n of g._nodes) for (const w of (n.widgets||[])) if (/prompt/i.test(w.name)) return String(w.value);
  return null; })()`);
console.log('value after blur:', JSON.stringify(after));
console.log(after === NEW ? 'PASS: multiline edit committed' : 'FAIL: value not committed');

// Esc must cancel
await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 });
await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 });
await sleep(400);
await c.evaluate(`(() => { const t=document.querySelector('.h3-prompt-editor'); t.value='SHOULD NOT STICK'; })()`);
await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
await sleep(400);
const afterEsc = await c.evaluate(`(() => { const g=window.__h3.canvas.graph;
  for (const n of g._nodes) for (const w of (n.widgets||[])) if (/prompt/i.test(w.name)) return String(w.value);
  return null; })()`);
console.log('value after Esc:', JSON.stringify(afterEsc).slice(0, 60));
console.log(afterEsc === NEW ? 'PASS: Esc cancelled' : 'FAIL: Esc did not cancel');

c.ws.close(); process.exit(0);
