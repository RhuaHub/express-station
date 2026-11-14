/* 取件拍照识别：把照片里的条码 / 数字 / 取件码读出来，匹配在库包裹，并生成可归档的文件名。
   纯前端零依赖：
   - 优先用浏览器自带的 BarcodeDetector（面单一维码、二维码，识别率最高）
   - 有 TextDetector 的平台再叠加文字检测（打印的取件标签大字）
   - 两者都没有的浏览器（iOS Safari 等）不做假识别，如实降级为「手输 / 重拍」
   本模块不读台账、不碰存储、不联网；匹配与命名都是纯函数，可在 Node 里直接测。 */
(function (global) {
  'use strict';

  var api = {};

  function engines() {
    var e = {
      barcode: typeof global.BarcodeDetector === 'function',
      text: typeof global.TextDetector === 'function'
    };
    e.any = e.barcode || e.text;
    e.label = e.barcode ? (e.text ? '条码 + 文字识别' : '条码识别')
      : (e.text ? '文字识别' : '当前浏览器不支持本地识别');
    return e;
  }
  api.engines = engines;

  /* ---------- 纯函数：从识别文本里提取可用于查件的候选串 ---------- */
  function tokens(texts) {
    var out = [], seen = {};
    function add(t) {
      t = String(t == null ? '' : t).toUpperCase().replace(/[^0-9A-Z\-]/g, '');
      t = t.replace(/^-+|-+$/g, '');
      if (t.length < 3 || t.length > 32) return;
      if (/^0+$/.test(t)) return;
      if (/^(19|20)\d{2}$/.test(t)) return;          /* 面单上的年份，不是取件码 */
      if (seen[t]) return;
      seen[t] = 1;
      out.push(t);
    }
    var list = Array.isArray(texts) ? texts : [texts];
    for (var i = 0; i < list.length && out.length < 60; i++) {
      var raw = String(list[i] == null ? '' : list[i]).toUpperCase();
      if (!raw) continue;
      /* 中文、空格、冒号天然把「取件码 A011」「单号 YT100001」切成片段 */
      var parts = raw.match(/[0-9A-Z][0-9A-Z\-]{2,31}/g) || [];
      for (var j = 0; j < parts.length && out.length < 60; j++) {
        var seg = parts[j];
        add(seg);
        add(seg.replace(/-/g, ''));
        var digits = seg.replace(/\D/g, '');
        if (digits.length >= 8) {
          add(digits);
          add(digits.slice(-6));
          add(digits.slice(-4));
        } else if (digits.length >= 4) {
          add(digits);
          add(digits.slice(-4));
        }
      }
    }
    /* 长串优先：能匹配完整运单号就别先拿 4 位尾号去撞库 */
    out.sort(function (a, b) { return b.length - a.length; });
    return out;
  }
  api.tokens = tokens;

  function compactSlot(slot) {
    return String(slot == null ? '' : slot).toUpperCase().replace(/[^0-9A-Z]/g, '');
  }

  /* ---------- 纯函数：候选串 × 在库包裹打分 ---------- */
  function scoreParcel(p, tok) {
    var code = String(p.pickupCode == null ? '' : p.pickupCode).toUpperCase();
    var no = String(p.trackingNo == null ? '' : p.trackingNo).toUpperCase();
    var tail = String(p.phoneTail == null ? '' : p.phoneTail).toUpperCase();
    var slot = compactSlot(p.slot);
    var digits = tok.replace(/\D/g, '');
    if (code && tok === code) return 120;
    if (no && tok === no) return 115;
    if (tail && digits === tail) return 100;
    if (slot && tok === slot) return 90;
    if (tok.length >= 6 && no.length >= tok.length && no.slice(-tok.length) === tok) return 80;
    if (tok.length >= 6 && no.indexOf(tok) >= 0) return 70;
    if (tok.length >= 4 && code.indexOf(tok) >= 0) return 60;
    if (digits.length >= 8 && tail && digits.slice(-4) === tail) return 55;
    if (tok.length >= 4 && String(p.recipient == null ? '' : p.recipient).toUpperCase().indexOf(tok) >= 0) return 40;
    if (tok.length >= 4 && String(p.note == null ? '' : p.note).toUpperCase().indexOf(tok) >= 0) return 40;
    if (tok.length >= 4 && no.indexOf(tok) >= 0) return 35;
    return 0;
  }
  api.scoreParcel = scoreParcel;

  function match(texts, parcels) {
    var ts = tokens(texts);
    var rows = Array.isArray(parcels) ? parcels : [];
    var best = {};   /* id -> { parcel, score, token } */
    for (var i = 0; i < ts.length; i++) {
      var t = ts[i];
      for (var j = 0; j < rows.length; j++) {
        var p = rows[j];
        if (!p || p.status && p.status !== 'in') continue;
        var s = scoreParcel(p, t);
        if (!s) continue;
        var id = String(p.id);
        if (!best[id] || s > best[id].score) best[id] = { parcel: p, score: s, token: t };
      }
    }
    var candidates = Object.keys(best).map(function (k) { return best[k]; })
      .sort(function (a, b) { return b.score - a.score; }).slice(0, 6);
    var top = candidates[0], second = candidates[1];
    /* 只有足够确定才自动勾选：明显领先或第二名很弱。
       两件包裹各被一个精确命中的串打到 100 分时，必须让人点一下，绝不猜一件出库。 */
    var sure = !!top && top.score >= 60 &&
      (!second || second.score < 60 || (top.score >= 80 && top.score - second.score >= 20));
    return {
      tokens: ts,
      candidates: candidates,
      best: sure ? top : null,
      ambiguous: !!top && top.score >= 60 && !sure,
      top: top || null
    };
  }
  api.match = match;

  /* ---------- 纯函数：按识别结果给凭证命名，方便在仓库里按码取证 ---------- */
  function safeName(name) {
    var s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/[^0-9A-Za-z_\u4e00-\u9fa5.\-]/g, '_')
      .replace(/^\.+/, '').trim();
    s = s.slice(0, 90);
    if (!/\.(jpe?g)$/i.test(s)) {
      s = s.replace(/\.[^.]{1,5}$/, '') + '.jpg';
    }
    return s || 'CK.jpg';
  }
  api.safeName = safeName;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fileName(res, at) {
    var d = at ? new Date(at) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var ts = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    var bits = ['CK', ts];
    var hit = res && (res.best || res.top);
    var p = hit && hit.parcel;
    if (p) {
      bits.push(String(p.pickupCode || '无码').slice(0, 20) || '无码');
      bits.push(String(p.trackingNo || '').slice(-8) || '无单号');
    } else if (res && res.tokens && res.tokens.length) {
      bits.push('未匹配_' + res.tokens[0].slice(0, 18));
    } else {
      bits.push('未识别');
    }
    bits.push(Math.random().toString(36).slice(2, 5));
    return safeName(bits.join('_') + '.jpg');
  }
  api.fileName = fileName;

  /* ---------- 浏览器侧：调用系统识别能力 ---------- */
  async function toSource(file) {
    if (typeof global.createImageBitmap === 'function') {
      return await global.createImageBitmap(file);
    }
    if (typeof document === 'undefined' || !global.URL || !global.URL.createObjectURL) {
      throw new Error('当前环境无法解码照片');
    }
    var url = global.URL.createObjectURL(file);
    try {
      var img = new global.Image();
      img.src = url;
      await new Promise(function (res, rej) {
        img.onload = res;
        img.onerror = function () { rej(new Error('无法读取该照片')); };
      });
      /* 返回 canvas，同样是 BarcodeDetector 接受的 ImageBitmapSource */
      var c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      return c;
    } finally {
      try { global.URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
    }
  }

  async function runBarcode(src) {
    var Ctor = global.BarcodeDetector;
    var detector;
    try {
      var formats = Ctor.getSupportedFormats ? await Ctor.getSupportedFormats() : null;
      detector = formats && formats.length ? new Ctor({ formats: formats }) : new Ctor();
    } catch (e) {
      try { detector = new Ctor(); } catch (e2) { return []; }
    }
    try {
      var found = await detector.detect(src);
      return (found || []).map(function (x) { return x && x.rawValue; }).filter(Boolean);
    } catch (e) { return []; }
  }

  async function runText(src) {
    try {
      var d = new global.TextDetector();
      var found = await d.detect(src);
      return (found || []).map(function (x) { return x && x.rawValue; }).filter(Boolean);
    } catch (e) { return []; }
  }

  async function detect(file) {
    var eng = engines();
    var res = { supported: eng.any, engines: eng, texts: [], error: '' };
    if (!eng.any) return res;
    var src;
    try { src = await toSource(file); }
    catch (e) { res.error = e.message || '无法读取照片'; return res; }
    try {
      var jobs = [];
      if (eng.barcode) jobs.push(runBarcode(src));
      if (eng.text) jobs.push(runText(src));
      var all = await Promise.all(jobs);
      var seen = {};
      all.forEach(function (list) {
        list.forEach(function (t) {
          var k = String(t).toUpperCase();
          if (!seen[k]) { seen[k] = 1; res.texts.push(String(t)); }
        });
      });
      if (!res.texts.length) res.error = '照片里没读到条码或数字，请对准面单再拍一次，或直接手输取件码';
    } finally {
      if (src && typeof src.close === 'function') {
        try { src.close(); } catch (e) { /* 忽略 */ }
      }
    }
    return res;
  }
  api.detect = detect;

  async function detectAndMatch(file, parcels) {
    var d = await detect(file);
    var m = match(d.texts, parcels);
    m.supported = d.supported;
    m.engineLabel = d.engines.label;
    m.detected = d.texts;
    m.readError = d.error;
    return m;
  }
  api.detectAndMatch = detectAndMatch;

  global.StationRecognize = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
