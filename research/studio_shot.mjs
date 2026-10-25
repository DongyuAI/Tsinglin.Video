/** Screenshot the consumer studio page at iPhone width, full height. */
import { openPage, sleep } from './cdp.mjs';

const URL = process.env.URL || 'http://127.0.0.1:8199/studio';
const OUT = process.argv[2] || 'shots/studio-mobile.png';
const W = Number(process.env.W || 390);

const page = await openPage();
await page.send('Emulation.setDeviceMetricsOverride', {
  width: W, height: 844, deviceScaleFactor: 2, mobile: true,
});
await page.send('Emulation.setTouchEmulationEnabled', { enabled: true });
await page.goto(URL, { wait: 1500 });
for (let i = 0; i < 30; i++) {
  const n = await page.eval("[...document.images].filter(i=>i.complete&&i.naturalWidth>0).length").catch(() => 0);
  const total = await page.eval('document.images.length').catch(() => 0);
  if (total > 0 && n >= Math.min(total, 8)) break;
  await sleep(400);
}
const h = await page.eval('Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)');
await page.send('Emulation.setDeviceMetricsOverride', {
  width: W, height: Math.min(h, 4000), deviceScaleFactor: 2, mobile: true,
});
await sleep(700);
await page.shot(OUT);
const info = await page.eval("({title: document.title, h: document.body.scrollHeight, imgs: document.images.length, loaded: [...document.images].filter(i=>i.complete&&i.naturalWidth>0).length, broken: [...document.images].filter(i=>i.complete&&i.naturalWidth===0).map(i=>i.getAttribute('src')).slice(0,25)})");
console.log(JSON.stringify(info, null, 1));
page.close();
process.exit(0);
