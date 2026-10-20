/** Minimal CDP client: page target, navigate, eval, screenshot, click, file input. */
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function openPage() {
  let ver;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(300); }
  }
  if (!ver) throw new Error('chrome CDP not reachable on ' + PORT);
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let id = 0; const pending = new Map(); const events = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    events.push(m);
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, (m) => m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result));
    ws.send(JSON.stringify({ id: mid, method, params, sessionId }));
  });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s('Page.enable'); await s('Runtime.enable'); await s('Network.enable');
  await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await s('Network.setUserAgentOverride', {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
  });

  const page = {
    targetId, sessionId,
    send: s,
    async goto(url, { wait = 6000, timeout = 60000 } = {}) {
      const t0 = Date.now();
      let nav;
      try { nav = await s('Page.navigate', { url }); } catch (e) { return { error: String(e), ms: Date.now() - t0 }; }
      // wait for load event or timeout
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const st = await s('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }).catch(() => null);
        if (st?.result?.value === 'complete') break;
        await sleep(300);
      }
      await sleep(wait);
      const info = await page.eval(`({url:location.href,title:document.title,ready:document.readyState})`).catch(() => ({}));
      return { ...info, ms: Date.now() - t0, navError: nav?.errorText };
    },
    async eval(expr, awaitPromise = false) {
      const r = await s('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || ''));
      return r.result.value;
    },
    async shot(path) {
      mkdirSync(path.split('/').slice(0, -1).join('/'), { recursive: true });
      const r = await s('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(r.data, 'base64'));
      return path;
    },
    async scrollToBottom(steps = 6, ms = 500) {
      for (let i = 0; i < steps; i++) {
        await page.eval('window.scrollBy(0, Math.round(innerHeight*0.9)); 1');
        await sleep(ms);
      }
      await page.eval('window.scrollTo(0,0); 1');
    },
    async clickText(text, tag = '*') {
      return page.eval(`(() => {
        const els = [...document.querySelectorAll('${tag}')].filter(e => {
          const t = (e.innerText||e.textContent||'').trim();
          const r = e.getBoundingClientRect();
          return t && t.length < 80 && t.includes(${JSON.stringify(text)}) && r.width>0 && r.height>0;
        });
        const el = els[els.length-1];
        if (!el) return {ok:false, n:els.length};
        el.scrollIntoView({block:'center'}); el.click();
        return {ok:true, tag:el.tagName, text:(el.innerText||'').trim().slice(0,60)};
      })()`);
    },
    async setFile(selector, files) {
      const doc = await s('DOM.getDocument', { depth: -1 });
      const q = await s('DOM.querySelector', { nodeId: doc.root.nodeId, selector });
      if (!q.nodeId) return { ok: false, reason: 'no node' };
      await s('DOM.setFileInputFiles', { nodeId: q.nodeId, files });
      return { ok: true, nodeId: q.nodeId };
    },
    close() { try { ws.close(); } catch {} },
    events,
  };
  return page;
}

export { sleep };
