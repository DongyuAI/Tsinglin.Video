/**
 * Load a workflow into the live ComfyUI and evaluate an expression against the
 * resulting graph. Used to read things ComfyUI only knows at render time
 * (localised port names, widget geometry, ...).
 *
 * usage: node eval-comfy.mjs "<workflow.json>" "<js expression>"
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const expr = process.argv[3];
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const doc = JSON.parse(readFileSync(file, 'utf8'));

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
  if (r.result?.exceptionDetails) return 'EXC ' + r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description || '');
  return r.result?.result?.value;
};

await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8188/' });
for (let i = 0; i < 90; i++) {
  await sleep(500);
  if (await evaluate('typeof app !== "undefined" && !!app.graph') === true) break;
}
await sleep(1500);
console.log('load:', await evaluate(`(() => { try { app.loadGraphData(${JSON.stringify(doc)}, true, true, false); return 'ok'; } catch (e) { return 'ERR ' + e.message; } })()`));
await sleep(4000);
console.log('--- eval ---');
console.log(await evaluate(expr));
ws.close();
process.exit(0);
