/** Attempt an actual try-on: upload portrait, click a trigger, capture result.
 * usage: node tryon.mjs <url> <slug> <clickText> [waitMs]
 */
import { openPage } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
const slug = process.argv[3];
const clickText = process.argv[4] || 'Try On';
const waitMs = Number(process.argv[5] || 90000);
const face = process.argv[6] || 'research/face_f.jpg';
const p = await openPage();
const out = { url, slug, steps: [] };
const log = (k, v) => { out.steps.push({ t: new Date().toISOString(), k, v }); console.log(k, JSON.stringify(v).slice(0, 300)); };

try {
  await p.goto(url, { wait: 4000 });
  const set = await p.setFile('input[type=file]', [face.replace(/^/, process.cwd() + '/')]);
  log('setFile', set);
  await new Promise(r => setTimeout(r, 3500));
  await p.shot(`research/shots/${slug}_1_uploaded.png`);

  const clicked = await p.clickText(clickText, 'button');
  log('click', clicked);
  if (!clicked?.ok) log('click2', await p.clickText(clickText));

  for (let i = 0; i < Math.ceil(waitMs / 5000); i++) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await p.eval(`(() => ({txt: (document.body.innerText||'').slice(0,600), imgs: [...document.images].filter(i=>i.naturalWidth>200).map(i=>i.src).slice(-8), dialogs: document.querySelectorAll('[role=dialog],.modal').length}))()`);
    if (i % 4 === 0) log('poll' + i, { txt: st.txt.slice(-200), imgs: st.imgs.length, dialogs: st.dialogs });
    if (/result|生成完成|Done|Download|下载/i.test(st.txt) && st.imgs.length) { log('maybe_done', st.txt.slice(-300)); break; }
  }
  await p.shot(`research/shots/${slug}_2_result.png`);
  out.final = await p.eval(`(() => ({url: location.href, txt: (document.body.innerText||'').slice(0,3000), imgs: [...document.images].filter(i=>i.naturalWidth>200).map(i=>({src:i.src, w:i.naturalWidth, h:i.naturalHeight})).slice(-12), canvases: document.querySelectorAll('canvas').length}))()`);
} catch (e) { out.error = String(e.stack || e); }
writeFileSync(`research/data/${slug}_tryon.json`, JSON.stringify(out, null, 1));
console.log('FINAL', JSON.stringify(out.final || out.error).slice(0, 1200));
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close(); process.exit(0);
