import { openPage } from './cdp.mjs';
const url = process.argv[2], face = process.argv[3], click = process.argv[4];
const p = await openPage();
await p.goto(url, { wait: 4000 });
console.log('files before', await p.eval('document.querySelectorAll("input[type=file]").length'));
console.log(await p.setFile('input[type=file]', [process.cwd() + '/' + face]));
await new Promise(r=>setTimeout(r,4000));
console.log(await p.eval(`(() => ({
  buttons: [...document.querySelectorAll('button')].map(b=>({t:(b.innerText||'').trim().slice(0,40), d:b.disabled, v:b.offsetParent!==null})).filter(x=>x.t),
  dialogs: [...document.querySelectorAll('[role=dialog],.modal')].map(d=>(d.innerText||'').slice(0,300)),
  imgs: [...document.images].map(i=>({src:i.src.slice(0,80), w:i.naturalWidth})).filter(i=>i.w>100).slice(-6),
  txt: (document.body.innerText||'').slice(0,500)
}))()`));
if (click) { console.log('click', await p.clickText(click, 'button')); await new Promise(r=>setTimeout(r,3000)); console.log('after', await p.eval('(document.body.innerText||"").slice(0,600)')); }
await p.shot('research/shots/debug_' + Date.now() + '.png');
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close(); process.exit(0);
