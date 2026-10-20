/**
 * Measure peak per-GPU VRAM for one vid_gen job on the resident sd-server.
 * usage: node bench/vram-bench.mjs --w 864 --h 480 --frames 22 --steps 2 --tag h3_480p
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i > -1 ? args[i + 1] : d; };
const W = Number(opt('w', 864)), H = Number(opt('h', 480));
const frames = Number(opt('frames', 22)), steps = Number(opt('steps', 2));
const seed = Number(opt('seed', 42));
const tag = opt('tag', `${W}x${H}_f${frames}_s${steps}`);
const prompt = opt('prompt', 'a young woman slowly turns her head, studio lighting, sharp focus');
const SD = process.env.SD_BASE || 'http://127.0.0.1:1234';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const gpu = () => execSync('nvidia-smi --query-gpu=index,memory.used --format=csv,noheader,nounits', { encoding: 'utf8' })
  .trim().split(/\r?\n/).map(l => Number(l.split(',')[1]));

const idle = gpu();
let peak = idle.slice();
const samples = [];
const t0 = Date.now();
const sampler = setInterval(() => {
  try {
    const g = gpu();
    g.forEach((v, i) => { if (v > peak[i]) peak[i] = v; });
    samples.push([Date.now() - t0, ...g]);
  } catch {}
}, 300);

const payload = {
  prompt, negative_prompt: '', width: W, height: H, video_frames: frames,
  fps: 24, seed, output_format: 'webm',
  sample_params: { sample_steps: steps, sample_method: 'res_multistep', scheduler: 'simple', guidance: { txt_cfg: 1.0 } },
};
const submit = await (await fetch(`${SD}/sdcpp/v1/vid_gen`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
})).json();
if (!submit.id) { clearInterval(sampler); console.log('submit failed', JSON.stringify(submit)); process.exit(1); }
console.log('submitted', submit.id, tag);

let status = '', last = '';
for (let i = 0; i < 4000; i++) {
  await sleep(2000);
  const j = await (await fetch(`${SD}/sdcpp/v1/jobs/${submit.id}`)).json();
  status = (j.status || '').toLowerCase();
  const line = `${status} ${j.progress != null ? (j.progress * 100).toFixed(0) + '%' : ''}`;
  if (line !== last) { last = line; process.stdout.write('\r  ' + line + '     '); }
  if (['completed', 'done', 'succeeded', 'failed', 'error'].includes(status)) break;
}
clearInterval(sampler);
const wall = (Date.now() - t0) / 1000;
const result = {
  tag, width: W, height: H, frames, steps, seed, status,
  idle, peak, peak_total: peak.reduce((a, b) => a + b, 0),
  wall_sec: Math.round(wall), samples: samples.length,
};
mkdirSync('bench/results', { recursive: true });
writeFileSync(`bench/results/${tag}.json`, JSON.stringify({ ...result, trace: samples }, null, 1));
console.log('\n' + JSON.stringify(result));
