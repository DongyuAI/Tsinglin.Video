/**
 * Submit one vid_gen job to the resident sd-server and save the result.
 *
 * usage: node gen.mjs <out.webm> --w 512 --h 512 --frames 22 --steps 8 [--prompt "..."] [--seed 42]
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = args[0];
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i > -1 ? args[i + 1] : dflt;
};
const W = Number(opt('w', 512));
const H = Number(opt('h', 512));
const frames = Number(opt('frames', 22));
const steps = Number(opt('steps', 8));
const seed = Number(opt('seed', 42));
const prompt = opt('prompt', 'a red ball rolling on a wooden table');
const sampler = opt('sampler', 'res_multistep');
const scheduler = opt('scheduler', 'simple');
const cfg = Number(opt('cfg', 1.0));
const SD = process.env.SD_BASE || 'http://127.0.0.1:1234';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const payload = {
  prompt, negative_prompt: '', width: W, height: H, video_frames: frames,
  fps: 24, seed, output_format: 'webm',
  sample_params: { sample_steps: steps, sample_method: sampler, scheduler, guidance: { txt_cfg: cfg } },
};

const t0 = Date.now();
const submit = await (await fetch(`${SD}/sdcpp/v1/vid_gen`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
})).json();
if (!submit.id) { console.log('submit failed', JSON.stringify(submit)); process.exit(1); }
console.log(`submitted ${submit.id}  ${W}x${H} frames=${frames} steps=${steps}`);

let last = '';
for (let i = 0; i < 3000; i++) {
  await sleep(3000);
  const j = await (await fetch(`${SD}/sdcpp/v1/jobs/${submit.id}`)).json();
  const st = (j.status || '').toLowerCase();
  const pct = j.progress != null ? ` ${(j.progress * 100).toFixed(0)}%` : '';
  const line = `${st}${pct}`;
  if (line !== last) { last = line; process.stdout.write(`\r  ${line}      `); }
  if (st === 'completed' || st === 'done' || st === 'succeeded') {
    const res = j.result || {};
    const b64 = res.b64_json || res.video || res.data;
    if (b64) {
      const data = Buffer.from(String(b64).replace(/^data:[^,]*,/, ''), 'base64');
      writeFileSync(out, data);
      console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${out} (${data.length} bytes)`);
    } else {
      console.log('\ncompleted but no media; result keys:', Object.keys(res));
    }
    process.exit(0);
  }
  if (st === 'failed' || st === 'error') { console.log('\nfailed:', j.error || JSON.stringify(j)); process.exit(1); }
}
console.log('\ntimed out');
process.exit(1);
