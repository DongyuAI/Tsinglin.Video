/**
 * Screenshot one node from the live ComfyUI (or the replica) at 100%.
 * usage: node shot-node.mjs <comfy|replica> <templateId|jsonPath> <nodeId> <out.png>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [who, which, nodeId, out] = process.argv.slice(2);
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const HERE = dirname(fileURLToPath(import.meta.url));
// repo root is two levels up from h3-studio/tools
const COMFY_DIR = process.env.H3_COMFY_DIR || join(HERE, '..', '..', 'ComfyUI_windows_portable');

const TEMPLATES = {
  t2v: 'MiniMax H3：文生视频.json',
  i2v: 'MiniMax H3：图生视频.json',
  r2v: 'MiniMax H3：参考生视频.json',
  flf: 'MiniMax H3_ 首尾帧视频生成.json',
};
const file = TEMPLATES[which] || which;
const doc = JSON.parse(readFileSync(join(COMFY_DIR, file), 'utf8'));

async function findTarget() {
  if (who === 'replica') {
    // dedicated tab so the ComfyUI tab is left untouched
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
    return await r.json();
  }
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const p = (await r.json()).find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (p) return p;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('no CDP target');
}
const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Page.javascriptDialogOpening') {
    ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
    return;
  }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id; pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});
const evaluate = async (e) => {
  const r = await send('Runtime.evaluate', { expression: e, returnByValue: true });
  if (r.result?.exceptionDetails) return 'EXC ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
  return r.result?.result?.value;
};
await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable'); await send('Page.enable');

if (who === 'comfy') {
  await send('Page.navigate', { url: 'http://127.0.0.1:8188/' });
  for (let i = 0; i < 90; i++) { await sleep(500); if (await evaluate('typeof app!=="undefined"&&!!app.graph') === true) break; }
  await sleep(1500);
  console.log('load:', await evaluate(`(()=>{try{app.loadGraphData(${JSON.stringify(doc)},true,true,false);return "ok"}catch(e){return "ERR "+e.message}})()`));
  await sleep(4000);
} else {
  await send('Page.navigate', { url: 'http://127.0.0.1:4321/' });
  for (let i = 0; i < 90; i++) { await sleep(500); if (await evaluate('window.__h3&&window.__h3.canvas&&!!window.__h3.canvas.graph') === true) break; }
  await evaluate(`document.querySelector('.tpl-card[data-id="${which}"]')?.click()`);
  for (let i = 0; i < 40; i++) { await sleep(500); if (await evaluate('window.__h3.canvas.graph._nodes.length') === doc.nodes.length) break; }
  await sleep(1000);
}

// screen rect of the node
const rect = await evaluate(`(()=>{
  const g = ${who === 'comfy' ? 'app.graph' : 'window.__h3.canvas.graph'};
  const n = g._nodes.find(x=>String(x.id)===${JSON.stringify(String(nodeId))});
  if(!n) return null;
  const cv = ${who === 'comfy' ? 'app.canvas' : '(window.__h3.canvas.canvas || window.__h3.canvas)'};
  const ds = cv.ds;
  ds.scale = 1;
  ds.offset[0] = 40 - n.pos[0];
  ds.offset[1] = 40 - n.pos[1];
  cv.draw(true, true);
  return [40, 40, n.size[0], n.size[1]];
})()`);
console.log('rect:', JSON.stringify(rect));
if (!rect) { ws.close(); process.exit(1); }
const pad = 6;
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
await sleep(300);
const shot = await send("Page.captureScreenshot", {
  format: 'png',
  clip: { x: Math.max(0, rect[0] - pad), y: Math.max(0, rect[1] - pad), width: rect[2] + pad * 2, height: rect[3] + pad * 2, scale: 1 },
});
if(!shot.result){console.log("CAPTURE ERR:",JSON.stringify(shot));ws.close();process.exit(1);}
writeFileSync(out, Buffer.from(shot.result.data, "base64"));
console.log('saved', out);
ws.close();
if (who === 'replica' && target.id) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`); } catch { /* ignore */ }
}
process.exit(0);
