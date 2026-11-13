/* 图片存储层：阿里云盘本地同步目录 / AList WebDAV / 浏览器暂存兜底。
   只存文件本体，台账里只保存引用字符串；配置与凭据仅在当前浏览器。 */
(function (global) {
  'use strict';

  var CFG_KEY = 'express-station.photos.v1';
  var DB_NAME = 'express-station-media';
  var DB_VERSION = 1;
  var S_FILES = 'files';
  var S_META = 'meta';
  var dirHandleRecord = null;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function defaults() {
    return {
      mode: 'webdav',
      dirName: 'express-station',
      webdav: { baseUrl: '', user: '', pass: '', proxyKey: '' },
      maxSide: 1600,
      quality: 0.82,
      requireProof: true
    };
  }
  var fallbackStore = {};
  function storage() {
    if (typeof localStorage !== 'undefined') return localStorage;
    return {
      getItem: function (k) { return fallbackStore[k] || null; },
      setItem: function (k, v) { fallbackStore[k] = v; },
      removeItem: function (k) { delete fallbackStore[k]; }
    };
  }
  function config() {
    var c = defaults();
    try {
      var raw = storage().getItem(CFG_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        c.mode = ['local', 'webdav', 'browser'].indexOf(p.mode) >= 0 ? p.mode : c.mode;
        c.dirName = String(p.dirName || c.dirName).replace(/[\\/:*?"<>|]/g, '-').trim() || c.dirName;
        c.webdav = {
          baseUrl: String((p.webdav && p.webdav.baseUrl) || '').trim().replace(/\/+$/, ''),
          user: String((p.webdav && p.webdav.user) || ''),
          pass: String((p.webdav && p.webdav.pass) || ''),
          proxyKey: String((p.webdav && p.webdav.proxyKey) || '')
        };
        c.maxSide = Math.max(600, Math.min(4000, Number(p.maxSide) || c.maxSide));
        c.quality = Math.max(0.4, Math.min(1, Number(p.quality) || c.quality));
        c.requireProof = p.requireProof !== false;
      }
    } catch (e) { /* 配置损坏则用默认值 */ }
    return c;
  }
  function saveConfig(patch) {
    var c = Object.assign(config(), patch || {});
    if (patch && patch.webdav) c.webdav = Object.assign(config().webdav, patch.webdav);
    storage().setItem(CFG_KEY, JSON.stringify(c));
    return config();
  }

  /* ---------- IndexedDB：句柄与暂存图片 ---------- */
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (typeof indexedDB === 'undefined') return reject(new Error('当前环境不支持 IndexedDB'));
      var settled = false;
      /* 某些环境（file://、隐私模式）open 既不成功也不报错，必须超时兜底 */
      var timer = setTimeout(function () {
        finish(reject, new Error('IndexedDB 打开超时'));
      }, 3000);
      function finish(fn, value) {
        if (settled) return;
        settled = true; clearTimeout(timer); fn(value);
      }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { return finish(reject, e); }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(S_FILES)) db.createObjectStore(S_FILES, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(S_META)) db.createObjectStore(S_META, { keyPath: 'key' });
      };
      req.onsuccess = function () { finish(resolve, req.result); };
      req.onerror = function () { finish(reject, req.error || new Error('IndexedDB 打开失败')); };
    });
  }
  function idbPut(name, value) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).put(value);
        tx.oncomplete = function () { db.close(); resolve(value); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('写入失败')); };
      });
    });
  }
  function idbGet(name, key) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, 'readonly');
        var req = tx.objectStore(name).get(key);
        req.onsuccess = function () { db.close(); resolve(req.result); };
        req.onerror = function () { db.close(); reject(req.error || new Error('读取失败')); };
      });
    });
  }

  /* ---------- 本地同步目录 ---------- */
  function isLocalSupported() {
    return !!(global.showDirectoryPicker && global.isSecureContext);
  }
  async function init() {
    try {
      dirHandleRecord = await idbGet(S_META, 'dirHandle');
    } catch (e) { dirHandleRecord = null; }
    return dirHandleRecord;
  }
  async function ensurePermission() {
    var h = dirHandleRecord && dirHandleRecord.handle;
    if (!h) return false;
    var opt = { mode: 'readwrite' };
    try {
      if (h.queryPermission) {
        var q = await h.queryPermission(opt);
        if (q === 'granted') return true;
        if (h.requestPermission) return (await h.requestPermission(opt)) === 'granted';
        return false;
      }
      return true;
    } catch (e) { return false; }
  }
  async function pickDirectory() {
    if (!isLocalSupported()) {
      return { ok: false, error: '当前浏览器不支持选择文件夹。请用桌面版 Chrome / Edge 打开 https 站点，或改用 WebDAV 模式。' };
    }
    try {
      var h = await global.showDirectoryPicker({ mode: 'readwrite' });
      dirHandleRecord = { key: 'dirHandle', handle: h };
      await idbPut(S_META, dirHandleRecord);
      return { ok: true, message: '已授权文件夹「' + h.name + '」，照片会写入其中的 ' + config().dirName + ' 子目录' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, error: '已取消选择' };
      return { ok: false, error: '授权失败：' + (e.message || e) };
    }
  }
  async function localRoot(create) {
    var h = dirHandleRecord && dirHandleRecord.handle;
    if (!h) throw new Error('尚未选择阿里云盘同步文件夹');
    return h.getDirectoryHandle(config().dirName || 'express-station', { create: !!create });
  }

  /* ---------- WebDAV（AList） ---------- */
  function toBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function basic(w) { return 'Basic ' + toBase64((w.user || '') + ':' + (w.pass || '')); }
  /* 统一 WebDAV 请求头；proxyKey 仅用于自建 CORS 代理（如坚果云 Worker），可留空 */
  function wdHeaders(w, extra) {
    var h = Object.assign({ 'Authorization': basic(w) }, extra || {});
    if (w && w.proxyKey) h['X-Proxy-Key'] = w.proxyKey;
    return h;
  }
  function joinUrl(base, segments) {
    var out = String(base || '').replace(/\/+$/, '');
    segments.forEach(function (seg) {
      String(seg || '').split('/').filter(Boolean).forEach(function (piece) {
        out += '/' + encodeURIComponent(piece);
      });
    });
    return out;
  }
  function wdSegments(w, rel) {
    return [config().dirName || 'express-station', rel || ''];
  }
  async function mkcol(w, segments) {
    try {
      await fetch(joinUrl(w.baseUrl, segments), {
        method: 'MKCOL', headers: wdHeaders(w)
      });
    } catch (e) { /* 目录已存在或跨域预检被拒，交给 PUT 给出真实错误 */ }
  }
  async function webdavPut(rel, blob, w) {
    if (!w.baseUrl) throw new Error('未填写 WebDAV 地址');
    var segs = wdSegments(w, rel);
    var parts = rel.split('/');
    await mkcol(w, [segs[0]]);
    /* 出库凭证多一层目录，逐层 MKCOL，避免坚果云返回 409 */
    for (var i = 0; i < parts.length - 1; i++) {
      await mkcol(w, [segs[0], parts.slice(0, i + 1).join('/')]);
    }
    var url = joinUrl(w.baseUrl, segs);
    var res = await fetch(url, {
      method: 'PUT',
      headers: wdHeaders(w, { 'Content-Type': 'image/jpeg' }),
      body: blob
    });
    if (!res.ok) {
      var extra = res.status === 401 ? '（账号或应用密码错误，坚果云要用「应用密码」而非登录密码）'
        : res.status === 403 ? '（无写入权限、跨域被拒绝或代理密钥不对）'
          : res.status === 409 ? '（上级目录不存在，请先在云盘网页端建好目录）' : '';
      throw new Error('HTTP ' + res.status + extra);
    }
  }

  /* ---------- 压缩与文件名 ---------- */
  function compress(file, maxSide, quality) {
    return new Promise(function (resolve, reject) {
      if (!file || String(file.type || '').indexOf('image/') !== 0) return reject(new Error('请选择图片文件'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth, h = img.naturalHeight;
        var scale = Math.min(1, (maxSide || 1600) / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = cw; canvas.height = ch;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        URL.revokeObjectURL(url);
        canvas.toBlob(function (blob) {
          if (!blob) return reject(new Error('图片压缩失败'));
          resolve(blob);
        }, 'image/jpeg', quality || 0.82);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('无法读取该图片')); };
      img.src = url;
    });
  }
  function monthKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1);
  }
  function newName(prefix) {
    var d = new Date();
    return (prefix || '') + String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '-' +
      Math.random().toString(36).slice(2, 7) + '.jpg';
  }
  /* 云盘目录：入库照片与出库凭证分开归档，各按年月再分一层，便于事后按日期取证 */
  function buildRel(kind) {
    var pickup = kind === 'pickup';
    return (pickup ? '出库凭证' : '入库照片') + '/' + monthKey() + '/' + newName(pickup ? 'CK-' : 'RK-');
  }
  /* 逐级打开/创建目录，兼容任意层数的 rel（旧版两段路径也能正常读取） */
  async function ensureDirs(root, rel, create) {
    var parts = String(rel).split('/');
    var dir = root;
    for (var i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: !!create });
    }
    return dir;
  }

  /* ---------- 对外主流程 ---------- */
  async function fallback(blob, rel, warning) {
    var ref = 'idb:' + rel;
    await idbPut(S_FILES, { key: ref, blob: blob, at: Date.now() });
    return {
      ok: true, ref: ref, mode: 'browser', size: blob.size,
      name: rel.split('/').pop(), warning: warning || ''
    };
  }
  async function safeFallback(blob, rel, warning) {
    try { return await fallback(blob, rel, warning); }
    catch (e) { return { ok: false, error: '暂存浏览器也失败：' + (e.message || e) }; }
  }
  async function put(file, kind) {
    var c = config();
    var blob;
    try { blob = await compress(file, c.maxSide, c.quality); }
    catch (e) { return { ok: false, error: e.message }; }
    var rel = buildRel(kind);
    var name = rel.split('/').pop();
    if (c.mode === 'local') {
      if (!dirHandleRecord || !dirHandleRecord.handle || !(await ensurePermission())) {
        return safeFallback(blob, rel, '未授权云盘同步文件夹，本次照片暂存浏览器');
      }
      try {
        var root = await localRoot(true);
        var dir = await ensureDirs(root, rel, true);
        var fh = await dir.getFileHandle(name, { create: true });
        var writer = await fh.createWritable();
        await writer.write(blob);
        await writer.close();
        return { ok: true, ref: 'local:' + rel, mode: 'local', size: blob.size, name: name, warning: '' };
      } catch (e) {
        return safeFallback(blob, rel, '写入同步目录失败，已暂存浏览器：' + (e.message || e));
      }
    }
    if (c.mode === 'webdav') {
      try {
        await webdavPut(rel, blob, c.webdav);
        return { ok: true, ref: 'webdav:' + rel, mode: 'webdav', size: blob.size, name: name, warning: '' };
      } catch (e) {
        return safeFallback(blob, rel, 'WebDAV 上传失败，已暂存浏览器：' + (e.message || e));
      }
    }
    return safeFallback(blob, rel, '');
  }

  async function getUrl(ref) {
    var c = config();
    if (String(ref).indexOf('idb:') === 0) {
      var rec = await idbGet(S_FILES, ref);
      if (!rec || !rec.blob) throw new Error('本机暂存图片已丢失（清过浏览器数据或换了设备）');
      return URL.createObjectURL(rec.blob);
    }
    if (String(ref).indexOf('local:') === 0) {
      if (!dirHandleRecord || !dirHandleRecord.handle || !(await ensurePermission())) {
        throw new Error('需要重新授权云盘同步文件夹');
      }
      var parts = String(ref).slice(6).split('/');
      /* 旧版是「年-月/文件」两段，新版是「出库凭证/年-月/文件」三段，逐层进入都兼容 */
      var dir = await ensureDirs(await localRoot(false), String(ref).slice(6), false);
      var fh = await dir.getFileHandle(parts[parts.length - 1]);
      var file = await fh.getFile();
      return URL.createObjectURL(file);
    }
    if (String(ref).indexOf('webdav:') === 0) {
      var rel = String(ref).slice(7);
      var url = joinUrl(c.webdav.baseUrl, wdSegments(c.webdav, rel));
      var res = await fetch(url, { headers: wdHeaders(c.webdav) });
      if (!res.ok) throw new Error('WebDAV 读取失败 HTTP ' + res.status);
      return URL.createObjectURL(await res.blob());
    }
    throw new Error('无法识别的图片引用');
  }

  async function test() {
    var c = config();
    if (c.mode === 'browser') return { ok: true, message: '当前为浏览器暂存模式，图片不会写入云盘' };
    if (c.mode === 'local') {
      if (!isLocalSupported()) return { ok: false, error: '此浏览器不支持文件夹授权，请改用 WebDAV 模式' };
      if (!dirHandleRecord || !dirHandleRecord.handle) return { ok: false, error: '请先选择云盘同步文件夹' };
      if (!(await ensurePermission())) return { ok: false, error: '文件夹读写权限未授予' };
      try {
        var root = await localRoot(true);
        await ensureDirs(root, buildRel('pickup'), true);
        return { ok: true, message: '可写：' + c.dirName + '/出库凭证/（云盘客户端会自动同步）' };
      } catch (e) {
        return { ok: false, error: '写入测试失败：' + (e.message || e) };
      }
    }
    if (!c.webdav.baseUrl) return { ok: false, error: '请先填写 WebDAV 地址' };
    try {
      var res = await fetch(joinUrl(c.webdav.baseUrl, []), {
        method: 'PROPFIND',
        headers: wdHeaders(c.webdav, { 'Depth': '0' })
      });
      if (res.status === 401) return { ok: false, error: '账号或密码错误（401）· 坚果云请填「应用密码」' };
      if (!res.ok && res.status !== 207) return { ok: false, error: 'WebDAV 返回 HTTP ' + res.status };
      return { ok: true, message: 'WebDAV 可访问（' + c.webdav.baseUrl + '）' };
    } catch (e) {
      return { ok: false, error: '连不上 WebDAV：' + (e.message || e) + '。坚果云不能用 dav.jianguoyun.com 直连（无 CORS 头），请部署 deploy/nutstore-worker.js 并填 Worker 地址；AList 若是 http 内网地址，也会被 https 页面拦截。' };
    }
  }

  function status() {
    var c = config();
    if (c.mode === 'browser') return '浏览器暂存模式 · 图片不写入云盘';
    if (c.mode === 'webdav') return c.webdav.baseUrl ? 'WebDAV · ' + c.webdav.baseUrl : 'WebDAV 未填地址 · 照片暂存浏览器';
    if (!isLocalSupported()) return '当前浏览器不支持文件夹授权，请改用 WebDAV';
    return dirHandleRecord && dirHandleRecord.handle
      ? '已授权同步文件夹 · ' + (dirHandleRecord.handle.name || '') + '/' + c.dirName
      : '尚未选择云盘同步文件夹 · 照片暂存浏览器';
  }

  var api = {
    config: config, saveConfig: saveConfig, init: init,
    isLocalSupported: isLocalSupported, pickDirectory: pickDirectory,
    put: put, getUrl: getUrl, test: test, status: status, buildRel: buildRel
  };
  global.StationPhotos = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
