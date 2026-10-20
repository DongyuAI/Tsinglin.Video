import { openPage } from './cdp.mjs';
const url=process.argv[2], sel=process.argv[3]||'input[type=file]';
const p=await openPage();
await p.goto(url,{wait:5000});
const before = await p.eval(`(() => ({n:document.querySelectorAll('input[type=file]').length, btn:[...document.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,30),d:b.disabled})).filter(b=>b.t)}))()`);
console.log('BEFORE', JSON.stringify(before));
console.log('SET', await p.setFile(sel,[process.cwd()+'/research/face_f.jpg']));
await new Promise(r=>setTimeout(r,5000));
const after = await p.eval(`(() => ({
  imgs:[...document.images].map(i=>({s:i.src.slice(0,60),w:i.naturalWidth})).filter(i=>i.s.startsWith('blob')||i.s.startsWith('data')),
  btn:[...document.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,30),d:b.disabled})).filter(b=>b.t),
  txt:(document.body.innerText||'').slice(-300)
}))()`);
console.log('AFTER', JSON.stringify(after).slice(0,1500));
try { await p.send('Target.closeTarget',{targetId:p.targetId}); } catch {}
p.close(); process.exit(0);
