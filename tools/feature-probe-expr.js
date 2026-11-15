/* CDP 探针表达式：真实浏览器里验证 2.1.0 四个新视图、二维码与三通道识别。
   用法：node tools/cdp-probe.js http://127.0.0.1:8765/index.html tools/feature-probe-expr.js */
(async () => {
  const A = window.StationApp, Q = window.StationQr, E = window.StationExtras, M = window.StationMedia;
  const out = {
    version: A && A.version, qr: !!Q, extras: !!E, media: !!M,
    bootErrors: (window.StationBoot && window.StationBoot.errors && window.StationBoot.errors()) || []
  };
  if (!Q || !A) return out;

  const code = 'A01010023';
  const enc = Q.encode(code);
  out.qrVersion = enc && enc.version;
  out.qrMatrix = Q.decodeMatrix(enc.modules);
  out.qrSvgLen = Q.svg(code).length;
  out.qrImage = Q.decodeImage(Q.modulesToImage(enc, 5, 4));

  /* 二维码图 -> canvas -> Blob -> Media.recognize 全链路 */
  const im = Q.modulesToImage(enc, 6, 4);
  const c = document.createElement('canvas');
  c.width = im.width; c.height = im.height;
  c.getContext('2d').putImageData(new ImageData(im.data, im.width, im.height), 0, 0);
  const blob = await new Promise(res => c.toBlob(res, 'image/png'));
  const rec = await M.recognize(blob);
  out.recognize = { barcodes: rec.barcodes, engine: rec.engine, supported: rec.supported, error: rec.error };

  /* 走完整 UI 初始化流程进入主界面 */
  const click = id => { const el = document.getElementById(id); if (el) el.click(); };
  const setv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  click('btnGoSetup');
  setv('setupName', 'probe'); setv('setupPw', 'abc123456'); setv('setupPw2', 'abc123456');
  click('btnSetup');
  await new Promise(r => setTimeout(r, 180));
  out.appVisible = !document.getElementById('app').hidden;
  out.logged = A.auth.status().logged;

  const views = ['tasks', 'station', 'wallet', 'service', 'print', 'query', 'sync', 'help'];
  out.views = {};
  for (const v of views) {
    A.switchView(v);
    await new Promise(r => setTimeout(r, 130));
    const sec = document.getElementById('view-' + v);
    const body = sec ? sec.innerHTML.length : 0;
    out.views[v] = { hidden: sec ? sec.hidden : null, len: body };
  }
  out.serviceFaq = (document.getElementById('faqList') || {}).childElementCount;
  out.walletBalance = (document.getElementById('walBalance') || {}).textContent;
  out.stationPartners = (document.getElementById('stPartners') || {}).childElementCount;
  out.taskListText = ((document.getElementById('taskList') || {}).textContent || '').slice(0, 30);
  out.tplOptions = (document.getElementById('tplSelect') || {}).childElementCount;
  out.bootErrorsAfter = (window.StationBoot && window.StationBoot.errors && window.StationBoot.errors()) || [];
  return out;
})()
