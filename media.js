/* 驿站助手（重建版）· 拍照 / 条码识别 / 照片本机存储 / 声音振动语音
   照片只存本机 IndexedDB，不上传任何服务器；导入导出备份时可一并带走。 */
(function (global) {
  'use strict';

  var R = global.StationRules || (typeof require !== 'undefined' ? require('./rules.js') : null);
  var DB_NAME = 'station-media-v2', STORE = 'photos';
  var memFallback = {};   /* IndexedDB 不可用时，至少保证当前会话内能看 */
  var dbPromise = null;

  function hasIDB() {
    try { return !!global.indexedDB; } catch (e) { return false; }
  }
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!hasIDB()) { reject(new Error('本机不支持 IndexedDB')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          var os = d.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('at', 'at');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('打开照片库失败')); };
    }).catch(function (e) { dbPromise = null; throw e; });
    return dbPromise;
  }
  function tx(fn) {
    return openDB().then(function (d) {
      return new Promise(function (resolve, reject) {
        var t = d.transaction(STORE, 'readwrite');
        var req = fn(t.objectStore(STORE));
        if (!req) { resolve(); return; }
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error || new Error('照片读写失败')); };
      });
    });
  }

  /* ---------- 压缩 / 命名 ---------- */
  function compress(blob, maxSide, quality) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(blob.type || '')) { resolve(blob); return; }
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
        var scale = Math.min(1, (maxSide || 1600) / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var c = document.createElement('canvas'); c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        if (c.toBlob) c.toBlob(function (out) { resolve(out || blob); }, 'image/jpeg', quality || 0.82);
        else resolve(blob);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(blob); };
      img.src = url;
    });
  }

  function put(blob, name, kind) {
    var id = R.uid('ph');
    var item = { id: id, name: R.safeFileName(name || id + '.jpg'), kind: kind || '',
      at: R.iso(), type: (blob && blob.type) || 'image/jpeg' };
    return compress(blob, 1600, 0.82).then(function (out) {
      item.blob = out;
      item.size = out && out.size || 0;
      return tx(function (os) { return os.put(item); }).then(function () {
        return { ok: true, id: id, name: item.name, kind: item.kind, size: item.size };
      }).catch(function () {
        memFallback[id] = item;
        return { ok: true, id: id, name: item.name, kind: item.kind, size: item.size, memory: true };
      });
    });
  }
  function get(id) {
    if (memFallback[id]) return Promise.resolve(memFallback[id].blob);
    return tx(function (os) { return os.get(id); }).then(function (r) { return r && r.blob; });
  }
  function url(id) {
    return get(id).then(function (b) { return b ? URL.createObjectURL(b) : ''; })
      .catch(function () { return ''; });
  }
  function del(id) {
    delete memFallback[id];
    return tx(function (os) { return os.delete(id); }).catch(function () { });
  }
  function list() {
    return tx(function (os) { return os.getAll(); }).then(function (rows) {
      var out = (rows || []).map(function (r) { return { id: r.id, name: r.name, kind: r.kind, at: r.at, size: r.size }; });
      Object.keys(memFallback).forEach(function (k) {
        var m = memFallback[k];
        out.push({ id: m.id, name: m.name, kind: m.kind, at: m.at, size: m.size, memory: true });
      });
      return out;
    }).catch(function () {
      return Object.keys(memFallback).map(function (k) { return memFallback[k]; });
    });
  }
  function blobToDataURL(b) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { resolve(''); };
      fr.readAsDataURL(b);
    });
  }
  function exportAll() {
    return tx(function (os) { return os.getAll(); }).then(function (rows) {
      return Promise.all((rows || []).map(function (r) {
        return blobToDataURL(r.blob).then(function (data) {
          return { id: r.id, name: r.name, kind: r.kind, at: r.at, type: r.type, data: data };
        });
      }));
    }).catch(function () { return []; });
  }
  function importAll(arr) {
    var jobs = (arr || []).map(function (x) {
      return new Promise(function (resolve) {
        if (!x || !x.data) { resolve(false); return; }
        try {
          var parts = String(x.data).split(','), b64 = parts[1] || '';
          var bin = atob(b64), bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var blob = new Blob([bytes], { type: x.type || 'image/jpeg' });
          memFallback[x.id] = { id: x.id, name: x.name, kind: x.kind, at: x.at, blob: blob, size: blob.size };
          tx(function (os) {
            return os.put({ id: x.id, name: x.name, kind: x.kind, at: x.at, type: blob.type, blob: blob, size: blob.size });
          }).then(function () { delete memFallback[x.id]; resolve(true); }).catch(function () { resolve(true); });
        } catch (e) { resolve(false); }
      });
    });
    return Promise.all(jobs).then(function (r) { return r.filter(Boolean).length; });
  }

  /* ---------- 浏览器原生识别（条码 / 文字） ---------- */
  function engines() {
    /* 部分 WebView 里这些属性本身就会抛 SecurityError，或 getSupportedFormats 不可用 */
    var BD = null, TD = null;
    try { BD = global.BarcodeDetector; TD = global.TextDetector; } catch (e) { }
    var formats = Promise.resolve([]);
    if (BD && typeof BD.getSupportedFormats === 'function') {
      try { formats = BD.getSupportedFormats() || formats; } catch (e2) { }
    }
    return { barcode: !!BD, text: !!TD, any: !!(BD || TD), formats: formats };
  }
  function canvasOf(blob) {
    return new Promise(function (resolve, reject) {
      var u = URL.createObjectURL(blob), img = new Image();
      img.onload = function () {
        var scale = Math.min(1, 1800 / Math.max(img.width, img.height));
        var c = document.createElement('canvas');
        c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(u); resolve(c);
      };
      img.onerror = function () { URL.revokeObjectURL(u); reject(new Error('无法读取照片')); };
      img.src = u;
    });
  }
  function recognize(blob) {
    var e = engines();
    var res = { supported: e.any, barcode: e.barcode, text: e.text, barcodes: [], texts: [], error: '' };
    if (!e.any) {
      res.error = '当前浏览器不支持本机识别，可直接手输单号 / 货号';
      return Promise.resolve(res);
    }
    return canvasOf(blob).then(function (canvas) {
      var jobs = [];
      if (global.BarcodeDetector) {
        var bd;
        try {
          bd = new global.BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'qr_code', 'code_93', 'itf'] });
        } catch (err) { bd = new global.BarcodeDetector(); }
        jobs.push(bd.detect(canvas).then(function (list) {
          (list || []).forEach(function (b) { res.barcodes.push(String(b.rawValue || '')); });
        }).catch(function () { }));
      }
      if (global.TextDetector) {
        var td = new global.TextDetector();
        jobs.push(td.detect(canvas).then(function (list) {
          (list || []).forEach(function (t) { res.texts.push(String(t.rawValue || '')); });
        }).catch(function () { }));
      }
      return Promise.all(jobs).then(function () {
        if (!res.barcodes.length && !res.texts.length) res.error = '没读到条码或数字，请对准面单再拍一次，或直接手输';
        return res;
      });
    }).catch(function (err) { res.error = err.message || '识别失败'; return res; });
  }
  function barcodeOf(d) { return R.barcodeOf(d); }

  /* ---------- 相机面板 ---------- */
  function supported() {
    try { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia); }
    catch (e) { return false; }
  }
  function capture(opts) {
    opts = opts || {};
    var title = opts.title || '拍照';
    var single = !!opts.single;
    var autoTorch = !!opts.torch;
    var max = opts.max || 12;
    return new Promise(function (resolve) {
      if (!supported()) {
        pickFiles(opts).then(function (files) { resolve({ files: files, cancelled: !files.length, fallback: true }); });
        return;
      }
      var root = document.createElement('div');
      root.className = 'cam-mask';
      root.innerHTML = '<div class="cam-panel">' +
        '<div class="cam-head"><h3>' + R.esc(title) + '</h3>' +
        '<button type="button" class="cam-x" data-act="close" aria-label="关闭">✕</button></div>' +
        '<div class="cam-stage"><video playsinline autoplay muted></video>' +
        '<div class="cam-frame"></div><div class="cam-hint" id="camHint">正在打开摄像头…</div></div>' +
        '<div class="cam-bar">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="switch">切换镜头</button>' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="torch">补光灯</button>' +
        '<button type="button" class="btn btn-outline btn-sm" data-act="album">从相册选</button>' +
        '<button type="button" class="btn btn-primary" data-act="shoot">拍照</button>' +
        '</div><div class="cam-thumbs" id="camThumbs"></div>' +
        '<div class="cam-foot"><span id="camCount">0 张</span>' +
        '<button type="button" class="btn btn-primary btn-sm" data-act="done">完成</button></div>' +
        '</div>';
      document.body.appendChild(root);
      var video = root.querySelector('video');
      var hint = root.querySelector('#camHint');
      var stream = null, facing = 'environment', done = false, torchOn = false;
      var files = [], thumbs = [];

      function stop() {
        if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { } }
        stream = null;
      }
      function finish(cancelled) {
        if (done) return;
        done = true; stop();
        thumbs.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { } });
        if (root.parentNode) root.parentNode.removeChild(root);
        resolve({ files: files, cancelled: cancelled || !files.length });
      }
      function start() {
        stop();
        var constraints = { video: { facingMode: { ideal: facing }, width: { ideal: 1280 } }, audio: false };
        return navigator.mediaDevices.getUserMedia(constraints).then(function (s) {
          stream = s; video.srcObject = s;
          try { return video.play(); } catch (e) { return null; }
        }).then(function () {
          hint.textContent = (facing === 'environment' ? '后置' : '前置') + '摄像头 · 把面单条码放入框内';
          if (autoTorch) setTimeout(function () { toggleTorch(true); }, 200);
        }).catch(function () {
          if (facing === 'environment') { facing = 'user'; return start(); }
          hint.textContent = '打不开摄像头，可点「从相册选」，或检查相机权限';
        });
      }
      function toggleTorch(force) {
        if (!stream) return;
        var track = stream.getVideoTracks()[0];
        if (!track || !track.applyConstraints) return;
        torchOn = force === undefined ? !torchOn : !!force;
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(function () { torchOn = false; });
      }
      function shoot() {
        if (!stream && !video.videoWidth) { hint.textContent = '摄像头还没就绪，请稍等或从相册选图'; return; }
        var c = document.createElement('canvas');
        c.width = video.videoWidth || 1280; c.height = video.videoHeight || 720;
        try { c.getContext('2d').drawImage(video, 0, 0, c.width, c.height); }
        catch (e) { hint.textContent = '画面读取失败，请重试'; return; }
        var make = function (blob) {
          var name = (opts.prefix || 'PH') + '_' + R.stamp() + '_' + Math.random().toString(36).slice(2, 5) + '.jpg';
          files.push({ blob: blob, name: name, type: 'image/jpeg' });
          var u = URL.createObjectURL(blob); thumbs.push(u);
          var box = root.querySelector('#camThumbs');
          var im = document.createElement('img'); im.src = u;
          im.onclick = function () {
            files = files.filter(function (_, i) { return thumbs[i] !== u; });
            thumbs = thumbs.filter(function (x) { return x !== u; });
            if (im.parentNode) im.parentNode.removeChild(im);
            root.querySelector('#camCount').textContent = files.length + ' 张';
          };
          box.appendChild(im);
          root.querySelector('#camCount').textContent = files.length + ' 张';
          if (single || files.length >= max) finish(false);
          else hint.textContent = '已拍 ' + files.length + ' 张，可继续拍或点「完成」';
        };
        if (c.toBlob) c.toBlob(function (b) { make(b || new Blob()); }, 'image/jpeg', 0.9);
        else make(new Blob());
      }
      root.addEventListener('click', function (ev) {
        var b = ev.target.closest('[data-act]');
        if (!b) return;
        var act = b.getAttribute('data-act');
        if (act === 'close') finish(true);
        else if (act === 'switch') { facing = facing === 'environment' ? 'user' : 'environment'; start(); }
        else if (act === 'torch') toggleTorch();
        else if (act === 'shoot') shoot();
        else if (act === 'done') finish(false);
        else if (act === 'album') {
          pickFiles({ multiple: !single }).then(function (picked) {
            picked.forEach(function (f) { files.push(f); });
            root.querySelector('#camCount').textContent = files.length + ' 张';
            if (files.length) finish(false);
          });
        }
      });
      start();
      if (opts.autoShoot && opts.autoShoot > 0) setTimeout(function () { if (!done) shoot(); }, opts.autoShoot);
    });
  }
  function pickFiles(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var input = document.createElement('input');
      input.type = 'file'; input.accept = 'image/*';
      if (opts.multiple !== false) input.multiple = true;
      if (opts.capture) { input.setAttribute('capture', 'environment'); }
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', function () {
        var out = Array.prototype.slice.call(input.files || []).slice(0, 12).map(function (f) {
          return { blob: f, name: f.name, type: f.type };
        });
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(out);
      });
      input.click();
    });
  }

  /* ---------- 声音 / 振动 / 语音播报 / 语音录入 ---------- */
  var audioCtx = null;
  function beep(kind) {
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = kind === 'error' ? 420 : kind === 'out' ? 660 : 880;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.16, audioCtx.currentTime + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.16);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + 0.17);
    } catch (e) { }
  }
  function vibrate(ms) { try { if (navigator.vibrate) navigator.vibrate(ms || 60); } catch (e) { } }
  function speak(text) {
    try {
      if (!global.speechSynthesis || !global.SpeechSynthesisUtterance) return false;
      var u = new global.SpeechSynthesisUtterance(String(text));
      u.lang = 'zh-CN'; u.rate = 1.05; u.volume = 1;
      global.speechSynthesis.cancel(); global.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
  function feedback(kind, text, settings) {
    settings = settings || {};
    if (kind === 'in') { if (settings.beepIn !== false) beep('in'); if (settings.vibrateIn !== false) vibrate(50); }
    else if (kind === 'out' || kind === 'refund') { if (settings.beepOut) beep('out'); if (settings.vibrateOut) vibrate(50); }
    else if (kind === 'error') { beep('error'); vibrate([40, 40, 40]); }
    if (text && ((kind === 'in' && settings.voiceIn) || (kind !== 'in' && settings.voiceOut))) speak(text);
  }
  function listen() {
    return new Promise(function (resolve) {
      var SR = global.SpeechRecognition || global.webkitSpeechRecognition;
      if (!SR) { resolve({ ok: false, error: '当前浏览器不支持语音录入，请手动输入' }); return; }
      var rec;
      try { rec = new SR(); } catch (e) { resolve({ ok: false, error: '语音识别启动失败' }); return; }
      rec.lang = 'zh-CN'; rec.interimResults = false; rec.maxAlternatives = 1;
      rec.onresult = function (ev) {
        var t = ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript || '';
        resolve({ ok: true, text: String(t).replace(/\D/g, '') });
      };
      rec.onerror = function () { resolve({ ok: false, error: '没听清，请重试或手动输入' }); };
      rec.onend = function () { };
      try { rec.start(); } catch (e) { resolve({ ok: false, error: '语音识别启动失败' }); }
    });
  }

  var out = {
    openDB: openDB, put: put, get: get, url: url, del: del, list: list,
    exportAll: exportAll, importAll: importAll, compress: compress,
    engines: engines, recognize: recognize, barcodeOf: barcodeOf,
    supported: supported, capture: capture, pickFiles: pickFiles,
    beep: beep, vibrate: vibrate, speak: speak, feedback: feedback, listen: listen
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = out; global.StationMedia = out; }
  else global.StationMedia = out;
})(typeof window !== 'undefined' ? window : globalThis);
