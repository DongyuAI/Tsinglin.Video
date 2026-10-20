import { openPage } from './cdp.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
const p=await openPage();
await p.goto('https://best-haircut.com/',{wait:5000});
await p.setFile('input[type=file]',[process.cwd()+'/research/face_f.jpg']);
await new Promise(r=>setTimeout(r,4000));
console.log('click', await p.clickText('Generate My Hair Report'));
for(let i=0;i<30;i++){
  await new Promise(r=>setTimeout(r,4000));
  const s=await p.eval(`(() => ({u:location.href,toasts:[...document.querySelectorAll('[role=alert],[class*=toast],[class*=Toast]')].map(e=>e.innerText.slice(0,200)), txt:(document.body.innerText||'').slice(-600), imgs:[...document.images].filter(i=>i.naturalWidth>200).map(i=>i.src).slice(-6)}))()`);
  if(i%2===0) console.log(i, s.u, JSON.stringify(s.toasts).slice(0,200), s.txt.replace(/\n/g,' | ').slice(-160));
  if(/generat|生成|report is ready|Download/i.test(s.txt)){ console.log('HIT', s.txt.slice(-300)); break; }
}
await p.shot('research/shots/bh_gen2.png');
console.log('TXT', (await p.eval('(document.body.innerText||"").slice(0,1200)')));
const imgs=await p.eval(`[...document.images].filter(i=>i.naturalWidth>300).map(i=>({s:i.src.slice(0,150),w:i.naturalWidth}))`);
console.log('IMGS', JSON.stringify(imgs).slice(0,900));
const b64=await p.eval(`(async()=>{const i=[...document.images].filter(x=>x.naturalWidth>300).pop();if(!i)return null;const r=await fetch(i.src);const b=await r.blob();return await new Promise(res=>{const f=new FileReader();f.onload=()=>res(f.result);f.readAsDataURL(b);});})()`,true).catch(()=>null);
if(b64){mkdirSync('research/results',{recursive:true});writeFileSync('research/results/besthaircut_result.png',Buffer.from(String(b64).split(',')[1],'base64'));console.log('saved');}
try{await p.send('Target.closeTarget',{targetId:p.targetId});}catch{}
p.close();process.exit(0);
