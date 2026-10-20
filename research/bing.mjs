/** Bing search scrape. usage: node bing.mjs "<query>" <slug> [pages] */
import { openPage } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const q = process.argv[2];
const slug = process.argv[3] || 'q';
const pages = Number(process.argv[4] || 1);
const p = await openPage();
const all = [];
for (let i = 0; i < pages; i++) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${i * 10 + 1}&setlang=zh-CN`;
  await p.goto(url, { wait: 2500, timeout: 25000 });
  const rows = await p.eval(`(() => [...document.querySelectorAll('#b_results > li.b_algo')].map(li => {
    const a = li.querySelector('h2 a');
    const sn = li.querySelector('.b_caption p, .b_lineclamp2, .b_algoSlug');
    return { title: a ? a.innerText.trim() : '', url: a ? a.href : '', snippet: sn ? sn.innerText.trim().slice(0,300) : '' };
  }).filter(r => r.title))()`);
  all.push(...rows);
}
writeFileSync(`research/data/${slug}.json`, JSON.stringify({ q, results: all }, null, 1));
console.log(JSON.stringify({ q, n: all.length, top: all.slice(0, 12) }, null, 1));
p.close(); process.exit(0);
