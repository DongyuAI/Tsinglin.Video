/**
 * Minimal Chrome DevTools Protocol probe: opens a page, collects console
 * messages + exceptions, then evaluates a JS expression and prints the result.
 *
 * usage: node cdp-probe.mjs <url> [--wait ms] [--eval "expr"]
 */
const url = process.argv[2] || 'http://127.0.0.1:4321/';
const waitArg = process.argv.indexOf('--wait');
const waitMs = waitArg > -1 ? Number(process.argv[waitArg + 1]) : 9000;
const evalArg = process.argv.indexOf('--eval');
const evalExpr = evalArg > -1 ? process.argv[evalArg + 1] : null;
const PORT = process.env.CDP_PORT || 9333;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('no CDP target');
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const logs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = (msg.params.args || []).map(a => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${msg.params.type}] ${args}`);
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description || ''}`);
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
});

const send = (method, params = {}) => new Promise((res) => {
  const mid = ++id;
  pending.set(mid, res);
  ws.send(JSON.stringify({ id: mid, method, params }));
});

await new Promise(r => ws.addEventListener('open', r));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url });
await sleep(waitMs);

console.log('--- console ---');
for (const l of logs) console.log(l);
if (!logs.length) console.log('(clean)');

if (evalExpr) {
  const r = await send('Runtime.evaluate', {
    expression: evalExpr, returnByValue: true, awaitPromise: true,
  });
  console.log('--- eval ---');
  console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails ?? r.result, null, 1));
}

const shotArg = process.argv.indexOf('--shot');
if (shotArg > -1) {
  const path = process.argv[shotArg + 1];
  await sleep(600);
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path, Buffer.from(r.result.data, 'base64'));
  console.log('--- shot ---');
  console.log('saved ' + path);
}
ws.close();
process.exit(0);
