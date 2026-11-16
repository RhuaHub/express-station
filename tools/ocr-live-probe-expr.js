/* CDP 探针表达式：真实浏览器里验证 2.3.0 多通道识别、预览连续识别与结果分级。
   用法：node tools/serve.js 8765
        node tools/cdp-probe.js http://127.0.0.1:8765/index.html tools/ocr-live-probe-expr.js */
(async () => {
  const O = window.StationOcr, M = window.StationMedia, R = window.StationRules, A = window.StationApp;
  const out = {
    version: A && A.version, ocrVersion: O && O.version,
    liveScan: typeof (M && M.liveScan), detectedInfo: typeof (R && R.detectedInfo),
    bootErrors: (window.StationBoot && window.StationBoot.errors && window.StationBoot.errors()) || []
  };
  if (!O || !M || !R || !A) return out;

  function barCanvas(code, sc, h, blur) {
    const mods = O.encodeCode128(code), pad = 30, w = mods.length * sc + pad * 2;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f4f4f4'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0b0b0b';
    for (let y = 12; y < h - 12; y++) {
      for (let x = pad; x < pad + mods.length * sc; x++) {
        if (mods[Math.floor((x - pad) / sc)] === 1) ctx.fillRect(x, y, 1, 1);
      }
    }
    if (blur) {
      const im = ctx.getImageData(0, 0, w, h), d = im.data, cp = new Uint8ClampedArray(d);
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        let sum = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += cp[((y + j) * w + x + i) * 4];
        const v = 128 + (sum / 9 - 128) * 0.68, k = (y * w + x) * 4;
        d[k] = d[k + 1] = d[k + 2] = v;
      }
      ctx.putImageData(im, 0, 0);
    }
    return c;
  }

  const clean = barCanvas('YT9000012345', 4, 100, false);
  const fuzzy = barCanvas('YT9000012345', 4, 100, true);
  const rc = O.scanCanvas(clean, { budget: 2400, maxSide: 1400 });
  const rf = O.scanCanvas(fuzzy, { budget: 2400, maxSide: 1400 });
  out.clean = { barcodes: rc.barcodes, engine: rc.engine, source: rc.source, elapsed: rc.elapsed };
  out.fuzzy = { barcodes: rf.barcodes, engine: rf.engine, source: rf.source, elapsed: rf.elapsed };
  out.live = M.liveScan(clean, 800);
  out.detected = R.detectedInfo({ barcodes: ['YT900001'], texts: ['ZT7700000012'] });
  out.fallback = R.detectedInfo({ barcodes: [], texts: ['9000012345'] });

  /* 走完整初始化流程进入主界面，再切到入库 / 出库看说明文案 */
  const click = id => { const el = document.getElementById(id); if (el) el.click(); };
  const setv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  click('btnGoSetup');
  setv('setupName', 'probe'); setv('setupPw', 'abc123456'); setv('setupPw2', 'abc123456');
  click('btnSetup');
  await new Promise(r => setTimeout(r, 220));
  out.logged = A.auth.status().logged;
  out.appVisible = !document.getElementById('app').hidden;
  A.switchView('inbound');
  await new Promise(r => setTimeout(r, 120));
  A.switchView('outbound');
  await new Promise(r => setTimeout(r, 120));
  const eng = document.getElementById('outEngine');
  out.outEngine = eng ? eng.textContent : '';
  out.viewErrors = typeof A.bootErrors === 'function' ? A.bootErrors() : null;
  return out;
})()
