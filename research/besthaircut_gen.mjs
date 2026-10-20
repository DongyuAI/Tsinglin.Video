import { openPage } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const p = await openPage();
const log = (...a) => console.log(...a);
await p.goto('https://best-haircut.com/', { wait: 5000 });
log('files', await p.eval('document.querySelectorAll("input[type=file]").length'));
log('set', await p.setFile('input[type=file]', [process.cwd() + '/research/face_f.jpg']));
await new Promise(r=>setTimeout(r,4000));
await p.shot('research/shots/besthaircut_uploaded.png');
log('click', await p.clickText('Generate My Hair Report'));
for (let i=0;i<36;i++){
  await new Promise(r=>setTimeout(r,5000));
  const s = await p.eval(`(() => ({u:location.href, t:(document.body.innerText||'').slice(-500), imgs:[...document.images].filter(i=>i.naturalWidth>300).map(i=>i.src)}))()`);
  if (i%3===0) log(i, s.u, s.t.slice(-120).replace(/\n/g,' | '));
  if (/report|Download|下载|Your result/i.test(s.t) || s.imgs.length>3) { log('DONE?', s.imgs.slice(-4)); break; }
}
await p.shot('research/shots/besthaircut_result.png');
const imgs = await p.eval(`[...document.images].filter(i=>i.naturalWidth>300).map(i=>({src:i.src,w:i.naturalWidth,h:i.naturalHeight}))`);
log('imgs', JSON.stringify(imgs).slice(0,800));
const b64 = await p.eval(`(async () => { const i=[...document.images].filter(x=>x.naturalWidth>300).pop(); if(!i) return null; const r=await fetch(i.src); const b=await r.blob(); return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(b);}); })()`, true);
if (b64) { mkdirSync('research/results',{recursive:true}); writeFileSync('research/results/besthaircut_result.png', Buffer.from(String(b64).split(',')[1],'base64')); log('saved'); }
log('txt', (await p.eval('(document.body.innerText||"").slice(0,1500)')));
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close(); process.exit(0);
