/**
 * Ground-truth probe: load a MiniMax-H3 workflow into the *real* ComfyUI
 * frontend (already running on 8188) and dump how it renders the subgraph
 * node — title, visible widget names, and port labels. Used to verify that
 * the Astro replica matches ComfyUI exactly.
 *
 * usage: node compare-comfy.mjs "<path-to-workflow.json>" [--shot out.png]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
const shotArg = process.argv.indexOf('--shot');
const shotPath = shotArg > -1 ? process.argv[shotArg + 1] : null;
const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const doc = JSON.parse(readFileSync(file, 'utf8'));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
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
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:8188/' });

// wait for the ComfyUI app object to be ready
for (let i = 0; i < 60; i++) {
  await sleep(1000);
  const r = await send('Runtime.evaluate', {
    expression: 'typeof app !== "undefined" && !!app.graph',
    returnByValue: true,
  });
  if (r.result?.result?.value === true) break;
}
await sleep(3000);

// load the workflow through ComfyUI's own API
const load = await send('Runtime.evaluate', {
  expression: `(() => {
    try {
      app.loadGraphData(${JSON.stringify(doc)}, true, true, false);
      return 'ok';
    } catch (e) { return 'ERR ' + (e && e.message); }
  })()`,
  returnByValue: true, awaitPromise: false,
});
console.log('loadGraphData:', load.result?.result?.value ?? JSON.stringify(load.result));
await sleep(4000);

const dump = await send('Runtime.evaluate', {
  expression: `(() => {
    const g = app.graph;
    const out = [];
    for (const n of g._nodes) {
      out.push({
        id: n.id, type: n.type, title: n.title,
        widgets: (n.widgets || []).map(w => w.name),
        inputs: (n.inputs || []).map(i => i.label || i.name),
        outputs: (n.outputs || []).map(o => o.label || o.name),
      });
    }
    return JSON.stringify(out, null, 1);
  })()`,
  returnByValue: true,
});
console.log('--- comfy nodes ---');
console.log(dump.result?.result?.value ?? JSON.stringify(dump.result));

const colors = await send('Runtime.evaluate', {
  expression: `(() => {
    const pick = (t) => { const n = app.graph._nodes.find(x => String(x.type) === t || String(x.type).startsWith(t));
      return n ? { color: n.color, bgcolor: n.bgcolor, boxcolor: n.boxcolor, shape: n.shape,
        widgetLabels: (n.widgets||[]).map(w => (w.label||w.name)) } : null; };
    return JSON.stringify({
      all: app.graph._nodes.map(n => ({ type: String(n.type).slice(0, 40), title: n.title,
        color: n.color, bgcolor: n.bgcolor, boxcolor: n.boxcolor,
        widgetLabels: (n.widgets||[]).map(w => (w.label||w.name)) })),
      theme: { bg: LiteGraph.NODE_DEFAULT_BGCOLOR, box: LiteGraph.NODE_DEFAULT_BOXCOLOR,
               title: LiteGraph.NODE_TITLE_COLOR, text: LiteGraph.NODE_TEXT_COLOR,
               def: LiteGraph.NODE_DEFAULT_COLOR, sel: LiteGraph.NODE_SELECTED_TITLE_COLOR },
      linkColors: app.canvas.default_connection_color_byType || null,
    }, null, 1);
  })()`,
  returnByValue: true,
});
console.log('--- comfy colors ---');
console.log(colors.result?.result?.value ?? JSON.stringify(colors.result));

const focusArg = process.argv.indexOf('--focus');
const scaleArg = process.argv.indexOf('--scale');
const scale = scaleArg > -1 ? Number(process.argv[scaleArg + 1]) : 1;
if (focusArg > -1) {
  const prefix = process.argv[focusArg + 1];
  const r = await send('Runtime.evaluate', {
    expression: `(() => {
      const c = app.canvas, g = app.graph;
      const n = g._nodes.find(x => String(x.type).startsWith(${JSON.stringify(prefix)}));
      c.ds.scale = ${scale};
      if (n) {
        // screen = (graph + offset) * scale
        c.ds.offset[0] = 60 / ${scale} - n.pos[0];
        c.ds.offset[1] = 60 / ${scale} - n.pos[1];
      }
      g.setDirtyCanvas(true, true);
      return n ? n.title : 'not found';
    })()`,
    returnByValue: true,
  });
  console.log('--- focus ---', r.result?.result?.value);
  await sleep(1500);
}

if (shotPath) {
  await sleep(1200);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(shotPath, Buffer.from(r.result.data, 'base64'));
  console.log('--- shot --- saved ' + shotPath);
}
ws.close();
process.exit(0);
