/** Load a UI workflow into ComfyUI, queue it, sample VRAM, report timing.
 * usage: node bench/comfy-run.mjs bench/r2v-gguf.json [tag]
 */
import { openPage } from '../../research/cdp.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const wf = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const tag = process.argv[3] || 'comfy';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gpu = () => execSync('nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits', { encoding: 'utf8' })
  .trim().split(/\r?\n/).map(l => Number(l.split(',')[1]));

const p = await openPage();
await p.goto('http://127.0.0.1:8188/', { wait: 4000, timeout: 60000 });
const ready = await p.eval('typeof app !== "undefined" && !!app.graph', true);
console.log('app ready', ready);
await p.eval(`window.__wf = ${JSON.stringify(JSON.stringify(wf))}`);
await p.eval('app.loadGraphData(JSON.parse(window.__wf))', true);
await sleep(1500);
const api = await p.eval('(async () => { const r = await app.graphToPrompt(); return JSON.stringify(r.output); })()', true);
const prompt = JSON.parse(api);
console.log('api nodes', Object.keys(prompt).length);

const idle = gpu();
let peak = idle.slice(); const trace = [];
const t0 = Date.now();
const timer = setInterval(() => {
  try { const g = gpu(); g.forEach((v, i) => { if (v > peak[i]) peak[i] = v; }); trace.push([Date.now() - t0, ...g]); } catch {}
}, 300);

const res = await p.eval(`(async () => {
  const r = await fetch('/prompt', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ prompt: ${api}, client_id: 'bench' }) });
  return await r.text();
})()`, true);
console.log('queue:', String(res).slice(0, 300));
const pid = JSON.parse(res).prompt_id;
if (!pid) { clearInterval(timer); p.close(); process.exit(1); }

let status = '';
for (let i = 0; i < 1200; i++) {
  await sleep(2000);
  const h = await p.eval(`(async () => (await (await fetch('/history/${pid}')).json()))()`, true).catch(() => null);
  if (h && h[pid]) {
    status = h[pid].status?.status_str || 'done';
    if (status === 'success' || status === 'error') break;
  }
  const q = await p.eval(`(async () => (await (await fetch('/queue')).json()))()`, true).catch(() => null);
  const running = q?.queue_running?.length || 0;
  if (i % 5 === 0) console.log('  t=' + Math.round((Date.now()-t0)/1000) + 's running=' + running + ' vram=' + gpu().join('/'));
}
clearInterval(timer);
const wall = (Date.now() - t0) / 1000;
const hist = await p.eval(`(async () => (await (await fetch('/history/${pid}')).json()))()`, true).catch(() => null);
const msgs = hist?.[pid]?.status?.messages || [];
const err = msgs.find(m => m[0] === 'execution_error');
await p.shot(`research/shots/${tag}.png`);
const out = { tag, prompt_id: pid, status, wall_sec: Math.round(wall), idle, peak, peak_total: peak.reduce((a,b)=>a+b,0), error: err ? err[1] : null, outputs: hist?.[pid]?.outputs };
mkdirSync('bench/results', { recursive: true });
writeFileSync(`bench/results/${tag}.json`, JSON.stringify({ ...out, trace }, null, 1));
console.log(JSON.stringify({ ...out, trace: undefined }, null, 1).slice(0, 1500));
p.close(); process.exit(0);
