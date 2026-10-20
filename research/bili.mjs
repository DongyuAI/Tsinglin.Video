/** Bilibili search scrape -> cards with author/plays/url. usage: node bili.mjs "<kw>" <slug> [pages] */
import { openPage } from './cdp.mjs';
import { writeFileSync } from 'node:fs';

const kw = process.argv[2];
const slug = process.argv[3] || 'bili';
const pages = Number(process.argv[4] || 1);
const p = await openPage();
const all = [];
for (let i = 1; i <= pages; i++) {
  await p.goto(`https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}&page=${i}`, { wait: 3500, timeout: 30000 });
  const rows = await p.eval(`(() => [...document.querySelectorAll('.bili-video-card')].map(c => {
    const a = c.querySelector('a[href*="/video/"]');
    const t = c.querySelector('.bili-video-card__info--tit');
    const up = c.querySelector('.bili-video-card__info--author');
    const date = c.querySelector('.bili-video-card__info--date');
    const stat = c.querySelector('.bili-video-card__stats--item span');
    const play = c.querySelector('.bili-video-card__stats--left span');
    return {
      title: t ? (t.innerText||t.getAttribute('title')||'').trim() : '',
      author: up ? up.innerText.trim() : '',
      date: date ? date.innerText.trim() : '',
      play: play ? play.innerText.trim() : (stat ? stat.innerText.trim() : ''),
      url: a ? a.href : ''
    };
  }).filter(r => r.title))` + '()');
  all.push(...rows);
}
writeFileSync(`research/data/${slug}.json`, JSON.stringify({ kw, results: all }, null, 1));
console.log(JSON.stringify({ kw, n: all.length, sample: all.slice(0, 6) }, null, 1));
p.close(); process.exit(0);
