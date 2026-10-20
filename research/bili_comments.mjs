/** For each BV: fetch stat + top comments. usage: node bili_comments.mjs out.json BV1 BV2 ... */
import { writeFileSync } from 'node:fs';
const out = process.argv[2];
const bvs = process.argv.slice(3);
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Referer: 'https://www.bilibili.com/' };
const j = async (u) => { const r = await fetch(u, { headers: H }); return r.json(); };
const rows = [];
for (const bv of bvs) {
  try {
    const v = await j('https://api.bilibili.com/x/web-interface/view?bvid=' + bv);
    if (v.code !== 0) { rows.push({ bv, error: v.message }); continue; }
    const d = v.data;
    const rep = await j(`https://api.bilibili.com/x/v2/reply?type=1&oid=${d.aid}&sort=2&ps=20&pn=1`);
    const comments = (rep?.data?.replies || []).map(r => ({ user: r.member.uname, like: r.like, msg: r.content.message.slice(0, 300) }));
    rows.push({ bv, title: d.title, author: d.owner.name, view: d.stat.view, like: d.stat.like, pubdate: d.pubdate, desc: (d.desc || '').slice(0, 200), comments });
    console.log(bv, d.stat.view, d.title.slice(0, 40), 'comments', comments.length);
  } catch (e) { rows.push({ bv, error: String(e) }); }
}
writeFileSync(out, JSON.stringify(rows, null, 1));
