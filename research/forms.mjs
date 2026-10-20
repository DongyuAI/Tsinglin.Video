import { openPage } from './cdp.mjs';
const url = process.argv[2];
const p = await openPage();
await p.goto(url, { wait: 5000 });
const info = await p.eval(`(() => ({
  url: location.href,
  inputs: [...document.querySelectorAll('input')].map(i=>({type:i.type,name:i.name,id:i.id,ph:i.placeholder,label:(i.closest('label')?.innerText||'').slice(0,40)})),
  buttons: [...document.querySelectorAll('button,[role=button]')].map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,20),
  txt: (document.body.innerText||'').slice(0,800)
}))()`);
console.log(JSON.stringify(info, null, 1));
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close(); process.exit(0);
