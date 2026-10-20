import { openPage } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const p = await openPage();
const log = (...a)=>console.log(...a);
await p.goto('https://www.aihairstyle.cn/', { wait: 5000 });
log('set', await p.setFile('#fileInput', [process.cwd() + '/research/face_f.jpg']));
await new Promise(r=>setTimeout(r,3000));
log('after upload:', (await p.eval('(document.body.innerText||"").slice(0,300)')));
await p.shot('research/shots/aihairstylecn_uploaded.png');
// pick a style by clicking its label
const pick = await p.eval(`(() => {
  const els=[...document.querySelectorAll('*')].filter(e=>e.children.length===0 && (e.innerText||'').trim()==='波波头');
  if(!els.length) return false; els[0].click(); return true;
})()`);
log('pick', pick);
await new Promise(r=>setTimeout(r,1000));
log('click gen', await p.clickText('生成','button'));
for (let i=0;i<24;i++){
  await new Promise(r=>setTimeout(r,5000));
  const s = await p.eval(`({t:(document.body.innerText||'').slice(-300), imgs:[...document.images].filter(i=>i.naturalWidth>300).map(i=>i.src).slice(-5)})`);
  if (i%3===0) log(i, s.imgs.length, s.t.replace(/\n/g,' | ').slice(-100));
}
await p.shot('research/shots/aihairstylecn_result.png');
const imgs = await p.eval(`[...document.images].filter(i=>i.naturalWidth>300).map(i=>({src:i.src.slice(0,120),w:i.naturalWidth}))`);
log('imgs', JSON.stringify(imgs).slice(0,600));
const b64 = await p.eval(`(async () => { const i=[...document.images].filter(x=>x.naturalWidth>300).pop(); if(!i) return null; const r=await fetch(i.src); const b=await r.blob(); return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(b);}); })()`, true).catch(e=>null);
if (b64) { mkdirSync('research/results',{recursive:true}); writeFileSync('research/results/aihairstylecn_result.png', Buffer.from(String(b64).split(',')[1],'base64')); log('saved'); }
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close(); process.exit(0);
