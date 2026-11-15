/* CDP 探针表达式：在真实浏览器里验证离线 OCR 的 canvas / Blob 两条识别链路。
   用法：node tools/cdp-probe.js http://127.0.0.1:8765/index.html tools/ocr-probe-expr.js */
(async () => {
  const O = window.StationOcr, M = window.StationMedia, A = window.StationApp;
  const out = {
    version: A && A.version, ocr: !!O, media: !!M,
    engines: M ? { any: M.engines().any, offline: M.engines().offline } : null,
    boot: (window.StationBoot && window.StationBoot.errors) || null
  };
  if (!O) return out;
  const mods = O.encodeCode128('YT9000012345');
  const sc = 3, h = 90, pad = 24, w = mods.length * sc + pad * 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#f6f6f6'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#080808';
  for (let y = 16; y < h - 16; y++) {
    for (let x = pad; x < pad + mods.length * sc; x++) {
      if (mods[Math.floor((x - pad) / sc)] === 1) ctx.fillRect(x, y, 1, 1);
    }
  }
  const r = O.scanCanvas(c);
  out.canvasBarcodes = r.barcodes;
  out.canvasEngine = r.engine;
  out.canvasConfidence = r.confidence;
  out.canvasElapsed = r.elapsed;
  const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92));
  const mr = await M.recognize(blob);
  out.mediaBarcodes = mr.barcodes;
  out.mediaEngine = mr.engine;
  out.mediaConfidence = mr.confidence;
  out.mediaSupported = mr.supported;
  out.mediaError = mr.error;
  /* 空照片 / 坏输入：必须返回结果而不是抛异常 */
  const blank = document.createElement('canvas');
  blank.width = 80; blank.height = 80;
  blank.getContext('2d').fillStyle = '#ffffff';
  blank.getContext('2d').fillRect(0, 0, 80, 80);
  const bad = O.scanCanvas(blank);
  out.blankSafe = !!bad && Array.isArray(bad.barcodes) && bad.error.length > 0;
  return out;
})()
