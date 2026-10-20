import { openPage } from './cdp.mjs';
const url = process.argv[2], name = process.argv[3], email = process.argv[4], pass = process.argv[5];
const p = await openPage();
const focusFill = async (sel, text) => {
  const ok = await p.eval(`(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.focus(); e.click(); return true; })()`);
  if (!ok) return false;
  await p.send('Input.insertText', { text });
  return true;
};
await p.goto(url, { wait: 5000 });
console.log('name', await focusFill('input[name=name]', name));
console.log('email', await focusFill('input[name=email]', email));
console.log('pass', await focusFill('input[name=password]', pass));
await p.shot('research/shots/register_filled.png');
console.log('click', await p.clickText('Sign Up', 'button'));
await new Promise(r=>setTimeout(r,6000));
console.log(await p.eval(`(() => ({url:location.href, txt:(document.body.innerText||'').slice(0,800), err:[...document.querySelectorAll('[class*=error],[role=alert]')].map(e=>e.innerText).slice(0,5)}))()`));
await p.shot('research/shots/register_after.png');
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close(); process.exit(0);
