/** Visit a URL headlessly, dump text/structure, screenshot. usage: node visit.mjs <url> <slug> [waitMs] */
import { openPage } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const url = process.argv[2];
const slug = process.argv[3] || new URL(url).hostname.replace(/\W+/g, '_');
const wait = Number(process.argv[4] || 6000);
const HARD = Number(process.env.VISIT_TIMEOUT || 45000);
const p = await openPage();
let out = { url, slug, at: new Date().toISOString() };

const work = (async () => {
  const nav = await p.goto(url, { wait, timeout: Math.min(30000, HARD - 5000) });
  await p.scrollToBottom(3, 350);
  const data = await p.eval(`(() => {
    const txt = (document.body.innerText || '').replace(/\\n{3,}/g,'\\n\\n').trim();
    const metas = [...document.querySelectorAll('meta')].map(m => [m.name||m.property, m.content]).filter(x=>x[0]);
    const links = [...document.querySelectorAll('a[href]')].map(a => ({t:(a.innerText||'').trim().slice(0,60), h:a.href}))
      .filter(l => l.t).slice(0, 120);
    const buttons = [...document.querySelectorAll('button,[role=button],input[type=submit]')].map(b => ({
      t:(b.innerText||b.value||b.getAttribute('aria-label')||'').trim().slice(0,50),
      disabled: !!b.disabled
    })).filter(b=>b.t).slice(0,60);
    const files = [...document.querySelectorAll('input[type=file]')].map(i => ({accept:i.accept, multiple:i.multiple, name:i.name, id:i.id}));
    const prices = (txt.match(/(?:US\\$|\\$|¥|￥)\\s?\\d+(?:\\.\\d+)?(?:\\s?\\/\\s?(?:mo|month|月|年|year))?/g)||[]).slice(0,40);
    return {
      title: document.title, lang: document.documentElement.lang, finalUrl: location.href,
      h1: [...document.querySelectorAll('h1')].map(h=>h.innerText.trim()).slice(0,5),
      h2: [...document.querySelectorAll('h2')].map(h=>h.innerText.trim()).filter(Boolean).slice(0,15),
      metas, textLen: txt.length, text: txt.slice(0, 9000), links, buttons, files, prices,
      imgs: document.images.length, canvases: document.querySelectorAll('canvas').length,
      videos: document.querySelectorAll('video').length,
    };
  })()`);
  out = { ...out, ...nav, ...data };
  out.shot = await p.shot(`research/shots/${slug}.png`);
})();

try {
  await Promise.race([work, new Promise((_, rej) => setTimeout(() => rej(new Error('HARD_TIMEOUT')), HARD))]);
} catch (e) {
  out.error = String(e && e.message || e);
  try { out.shot = await p.shot(`research/shots/${slug}.png`); } catch {}
}
writeFileSync(`research/data/${slug}.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ slug, title: out.title, url: out.finalUrl, textLen: out.textLen, error: out.error, files: out.files?.length }));
try { await p.send('Target.closeTarget', { targetId: p.targetId }); } catch {}
p.close();
process.exit(0);
