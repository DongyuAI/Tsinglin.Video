/** Baidu search scrape. usage: node baidu.mjs "<query>" <slug> [pages] */
import { openPage } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const q = process.argv[2];
const slug = process.argv[3] || 'q';
const pages = Number(process.argv[4] || 1);
const p = await openPage();
const all = [];
for (let i = 0; i < pages; i++) {
  await p.goto(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&pn=${i * 10}`, { wait: 2500, timeout: 25000 });
  const rows = await p.eval(`(() => [...document.querySelectorAll('#content_left > div')].map(div => {
    const a = div.querySelector('h3 a');
    const abs = div.querySelector('.c-abstract, [class*=content-right], .content-right_8Zs40');
    return {
      title: a ? (a.innerText||'').trim() : '',
      url: a ? a.href : '',
      real: div.getAttribute('mu') || '',
      snippet: abs ? (abs.innerText||'').trim().slice(0,400) : (div.innerText||'').trim().slice(0,200)
    };
  }).filter(r => r.title))` + '()');
  all.push(...rows);
}
writeFileSync(`research/data/${slug}.json`, JSON.stringify({ q, results: all }, null, 1));
console.log(JSON.stringify({ q, n: all.length, top: all.slice(0, 10) }, null, 1));
p.close(); process.exit(0);
