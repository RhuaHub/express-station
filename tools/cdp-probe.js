/* 用 CDP 驱动无头 Edge 跑真实浏览器场景：可以 await 页面里的 Promise，不受虚拟时钟干扰。
 * 用法：node tools/cdp-probe.js <页面 URL> <测速表达式文件>
 * 只依赖 Node 22 自带的 WebSocket / fetch。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EDGE = process.env.EDGE_BIN || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.CDP_PORT || 9223);
const pageUrl = process.argv[2];
const exprFile = process.argv[3];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitVersion(tries) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/version');
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('调试端口没起来');
}

async function newTarget(url) {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(url), { method: 'PUT' });
  if (!r.ok) throw new Error('创建标签页失败 HTTP ' + r.status);
  return await r.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let seq = 0;
    const logs = [];
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          const id = ++seq;
          ws.send(JSON.stringify({ id, method, params: params || {} }));
          return new Promise((res, rej) => {
            const timer = setTimeout(() => rej(new Error(method + ' 超时')), 30000);
            pending.set(id, { res, rej, timer });
          });
        },
        logs,
        close() { try { ws.close(); } catch (e) { /* 忽略 */ } }
      });
    });
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 失败')));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.rej(new Error(msg.error.message || JSON.stringify(msg.error)));
        else p.res(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        logs.push((msg.params.args || []).map((a) => a.value === undefined ? a.description : a.value).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        logs.push('EXCEPTION ' + (d.exception ? d.exception.description : d.text));
      }
    });
  });
}

(async () => {
  const tmp = path.join(os.tmpdir(), 'edge-cdp-' + Date.now());
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + tmp, 'about:blank'
  ], { stdio: 'ignore' });

  let cli = null;
  try {
    await waitVersion(80);
    const target = await newTarget(pageUrl);
    cli = await connect(target.webSocketDebuggerUrl);
    await cli.send('Runtime.enable');
    await cli.send('Page.enable');
    /* 等页面脚本都加载完 */
    await sleep(1500);
    const expr = fs.readFileSync(exprFile, 'utf8');
    const out = await cli.send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true
    });
    if (out.exceptionDetails) {
      console.error('页面内异常：', out.exceptionDetails.exception ? out.exceptionDetails.exception.description : out.exceptionDetails.text);
    }
    console.log(JSON.stringify(out.result && out.result.value, null, 2));
    if (cli.logs.length) console.error('控制台：', cli.logs.slice(-8).join(' | '));
  } finally {
    if (cli) cli.close();
    try { child.kill(); } catch (e) { /* 忽略 */ }
    await sleep(300);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => { console.error('探针失败：' + e.message); process.exit(1); });
