import { openPage } from './cdp.mjs';
const p = await openPage();
await p.goto('http://127.0.0.1:8199/studio?v=3', { wait: 3500 });
console.log(await p.eval(`({styles: document.querySelectorAll('.style').length, colors: document.querySelectorAll('#color option').length, btn: document.querySelector('#go').disabled, engine: document.querySelector('#engine').textContent})`));
await p.shot('research/shots/studio_final.png');
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close(); process.exit(0);
