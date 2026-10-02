/**
 * Peak per-GPU VRAM for a list of resolutions, one vid_gen job each, all in a
 * single process (avoids the Windows libuv exit race of a bash loop).
 *
 * usage: node vram-sweep.mjs [steps] [frames]
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const STEPS = Number(process.argv[2] || 4);
const FRAMES = Number(process.argv[3] || 22);
const SD = process.env.SD_BASE || 'http://127.0.0.1:1234';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const used = () => execSync('nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits')
  .toString().trim().split(/\r?\n/).map((n) => parseInt(n, 10));

// Cases come from H3_CASES="864x480,1920x1080" (default below).
const CASES = (process.env.H3_CASES
  ? process.env.H3_CASES.split(',')
  : ['864x480', '1280x736', '1344x768', '1920x1080'])
  .map((s) => s.trim().split('x').map(Number));

console.log('idle:', used().join(','), 'MiB');
for (const [W, H] of CASES) {
  const payload = {
    prompt: 'a red ceramic teapot on a wooden table, soft window light',
    negative_prompt: '', width: W, height: H, video_frames: FRAMES, fps: 24, seed: 42,
    output_format: 'webm',
    sample_params: { sample_steps: STEPS, sample_method: 'res_multistep', scheduler: 'simple', guidance: { txt_cfg: 1.0 } },
  };
  let id;
  try {
    const r = await (await fetch(`${SD}/sdcpp/v1/vid_gen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })).json();
    id = r.id;
    if (!id) { console.log(`RESULT ${W}x${H}: submit failed ${JSON.stringify(r)}`); continue; }
  } catch (e) { console.log(`RESULT ${W}x${H}: submit error ${e.message}`); continue; }

  let p0 = 0, p1 = 0, status = '?', err = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 20 * 60 * 1000) {
    const [a, b] = used();
    if (a > p0) p0 = a;
    if (b > p1) p1 = b;
    const j = await (await fetch(`${SD}/sdcpp/v1/jobs/${id}`)).json().catch(() => ({}));
    status = (j.status || '').toLowerCase();
    if (status === 'failed' || status === 'error') { err = JSON.stringify(j.error || j).slice(0, 200); break; }
    if (status === 'completed' || status === 'done' || status === 'succeeded') break;
    await sleep(400);
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`RESULT ${W}x${H} f=${FRAMES} steps=${STEPS}: cuda0=${p0} cuda1=${p1} sum=${p0 + p1} MiB  status=${status} ${secs}s ${err}`);
}
writeFileSync('tools/qa/_sweep.done', 'ok');
