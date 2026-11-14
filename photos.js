/* 图片存储层：GitHub 仓库（默认）/ 云盘 WebDAV / 本机同步目录 / 浏览器暂存兜底。
   只存文件本体，台账里只保存引用字符串；配置与凭据仅在当前浏览器。
   GitHub 读取带本机 IndexedDB 缓存，并可选经 Cloudflare Worker 走边缘缓存。 */
(function (global) {
  'use strict';

  var CFG_KEY = 'express-station.photos.v1';
  var DB_NAME = 'express-station-media';
  /* v2：多了 cache 仓（GitHub 照片的本机缓存），旧库升级时只新增，不动 files/meta */
  var DB_VERSION = 2;
  var S_FILES = 'files';
  var S_META = 'meta';
  var S_CACHE = 'cache';
  /* 缓存上限：按张数算，400 张约 60–100MB，够覆盖几个月的常用查询，又不至于把磁盘撑满 */
  var CACHE_MAX = 400;
  var dirHandleRecord = null;
  var cacheStats = { hit: 0, miss: 0 };
  var ghInflight = {};
  var pruneTimer = null;

  /* 云盘服务预设：upstream 是官方 WebDAV 根地址，proxyPath 是 Worker 里的路由前缀。
     两者都缺 CORS 头，必须经自建 Worker 中转；AList 自带 CORS，可直连。 */
  var PROVIDERS = {
    pan123: {
      name: '123 云盘',
      upstream: 'https://webdav.123pan.cn/webdav',
      proxyPath: '/pan123',
      account: '手机号 / 邮箱',
      hint: '123 云盘网页版 → 工具中心 → 第三方挂载 → WebDAV 授权管理 → 添加应用（权限勾「读写」）→ 复制应用密码。' +
        '若这里没有 WebDAV 授权管理：123 云盘自 2026-11-04 起，新注册账号与新开通会员已不含 WebDAV 权益，' +
        '这种账号走不通 WebDAV 路线，改用坚果云或「本机文件夹」模式。'
    },
    nutstore: {
      name: '坚果云',
      upstream: 'https://dav.jianguoyun.com/dav',
      proxyPath: '/nutstore',
      account: '注册邮箱',
      hint: '坚果云网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 添加「应用密码」。账号填注册邮箱，密码填应用密码。' +
        '坚果云对所有用户（含免费版）开放 WebDAV，免费版每月上传 1GB / 下载 3GB。'
    },
    custom: {
      name: '自定义 / AList',
      upstream: '',
      proxyPath: '/webdav',
      account: 'WebDAV 账号',
      hint: 'AList 自带 CORS，可直连 https://你的域名/dav；其它无 CORS 头的服务同样需要 Worker 中转。'
    }
  };
  var PROVIDER_KEYS = ['nutstore', 'pan123', 'custom'];

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function defaults() {
    return {
      mode: 'github',
      dirName: 'express-station',
      webdav: { provider: 'nutstore', baseUrl: '', proxyBase: '', user: '', pass: '', proxyKey: '' },
      github: {
        repo: '', branch: '', dir: 'photos', allowPublic: false, isPublic: null,
        proxyBase: '', proxyKey: '', cache: true
      },
      maxSide: 1600,
      quality: 0.82,
      requireProof: true,
      /* 进入「取件出库」自动开镜头拍照；关掉后退回首屏手动按钮 + 搜索出库 */
      autoCapture: true
    };
  }
  var fallbackStore = {};
  function storage() {
    /* 读 localStorage 属性本身也可能抛 SecurityError（Safari 阻止 Cookie、
       内置浏览器、WebView 未开 DOM storage），裸访问会让整个脚本加载即崩。 */
    try {
      var s = global.localStorage;
      if (s) { s.getItem('__station_probe__'); return s; }
    } catch (e) { /* 落到内存实现 */ }
    return {
      __memory: true,
      getItem: function (k) { return fallbackStore[k] == null ? null : fallbackStore[k]; },
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
        c.mode = ['local', 'webdav', 'browser', 'github'].indexOf(p.mode) >= 0 ? p.mode : c.mode;
        c.dirName = String(p.dirName || c.dirName).replace(/[\\/:*?"<>|]/g, '-').trim() || c.dirName;
        c.webdav = {
          provider: PROVIDER_KEYS.indexOf(p.webdav && p.webdav.provider) >= 0
            ? p.webdav.provider
            /* 旧配置没有 provider：填了地址的一律按自定义处理，空配置默认坚果云
               （坚果云免费版就含 WebDAV；123 云盘 2026-11-04 起新账号/新会员已不含该权益） */
            : (p.webdav && p.webdav.baseUrl ? 'custom' : 'nutstore'),
          baseUrl: String((p.webdav && p.webdav.baseUrl) || '').trim().replace(/\/+$/, ''),
          proxyBase: String((p.webdav && p.webdav.proxyBase) || '').trim().replace(/\/+$/, ''),
          user: String((p.webdav && p.webdav.user) || ''),
          pass: String((p.webdav && p.webdav.pass) || ''),
          proxyKey: String((p.webdav && p.webdav.proxyKey) || '')
        };
        c.github = {
          repo: String((p.github && p.github.repo) || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, ''),
          /* 留空表示跟随「GitHub 同步」里的仓库与分支 */
          branch: String((p.github && p.github.branch) || '').trim(),
          dir: String((p.github && p.github.dir) || 'photos').trim().replace(/^\/+|\/+$/g, '') || 'photos',
          allowPublic: !!(p.github && p.github.allowPublic),
          isPublic: p.github && typeof p.github.isPublic === 'boolean' ? p.github.isPublic : null,
          /* 可选的 Cloudflare 只读加速节点；留空则直连 api.github.com */
          proxyBase: String((p.github && p.github.proxyBase) || '').trim().replace(/\/+$/, ''),
          proxyKey: String((p.github && p.github.proxyKey) || ''),
          /* 默认开：同一张照片只下载一次 */
          cache: !(p.github && p.github.cache === false)
        };
        c.maxSide = Math.max(600, Math.min(4000, Number(p.maxSide) || c.maxSide));
        c.quality = Math.max(0.4, Math.min(1, Number(p.quality) || c.quality));
        c.requireProof = p.requireProof !== false;
        c.autoCapture = p.autoCapture !== false;
      }
    } catch (e) { /* 配置损坏则用默认值 */ }
    return c;
  }
  function saveConfig(patch) {
    var c = Object.assign(config(), patch || {});
    if (patch && patch.webdav) c.webdav = Object.assign(config().webdav, patch.webdav);
    if (patch && patch.github) {
      var g = Object.assign(config().github, patch.github);
      /* 换了仓库，旧的「公开/私有」结论就失效了；不清掉会把私有仓库当成公开的拦住。
         显式传了 isPublic 的调用（test/put 回来写缓存）不受影响。 */
      if (patch.github.isPublic === undefined && patch.github.repo !== undefined &&
        String(patch.github.repo || '') !== config().github.repo) g.isPublic = null;
      c.github = g;
    }
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
        if (!db.objectStoreNames.contains(S_CACHE)) {
          var cs = db.createObjectStore(S_CACHE, { keyPath: 'key' });
          cs.createIndex('at', 'at');
        }
      };
      req.onsuccess = function () { finish(resolve, req.result); };
      /* 另一个标签页还开着旧版本库时升级会被挡住，直接失败比干等 3 秒好 */
      req.onblocked = function () { finish(reject, new Error('IndexedDB 被其它标签页占用，请关掉多余页面')); };
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
  function idbCount(name) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, 'readonly');
        var req = tx.objectStore(name).count();
        req.onsuccess = function () { db.close(); resolve(req.result); };
        req.onerror = function () { db.close(); reject(req.error || new Error('统计失败')); };
      });
    });
  }
  function idbClear(name) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = function () { db.close(); resolve(true); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('清空失败')); };
      });
    });
  }
  /* 按 at 索引删最旧的若干条；keep 是保留张数 */
  function idbPruneOldest(name, indexName, keep) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(name, 'readwrite');
        var store = tx.objectStore(name);
        var removed = 0, excess = 0;
        var crest = store.count();
        crest.onsuccess = function () {
          excess = Math.max(0, crest.result - keep);
          if (!excess) return;
          var cur = store.index(indexName).openCursor();
          cur.onsuccess = function () {
            var c = cur.result;
            if (!c || removed >= excess) return;
            c.delete();
            removed++;
            c.continue();
          };
        };
        tx.oncomplete = function () { db.close(); resolve(removed); };
        tx.onerror = function () { db.close(); reject(tx.error || new Error('清理缓存失败')); };
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
  function provider(w) { return PROVIDERS[(w && w.provider)] || PROVIDERS.custom; }
  /* 真正发请求的根地址：填了 CORS 代理就走代理前缀，否则直连上游地址 */
  function endpoint(w) {
    var p = provider(w);
    var upstream = String((w && w.baseUrl) || p.upstream || '').replace(/\/+$/, '');
    var proxy = String((w && w.proxyBase) || '').replace(/\/+$/, '');
    if (proxy) return proxy + p.proxyPath;
    return upstream;
  }
  function wdSegments(w, rel) {
    return [config().dirName || 'express-station', rel || ''];
  }
  async function mkcol(w, segments) {
    try {
      await fetch(joinUrl(endpoint(w), segments), {
        method: 'MKCOL', headers: wdHeaders(w)
      });
    } catch (e) { /* 目录已存在或跨域预检被拒，交给 PUT 给出真实错误 */ }
  }
  async function webdavPut(rel, blob, w) {
    var base = endpoint(w);
    if (!base) throw new Error('未配置 WebDAV / 云盘代理地址');
    var segs = wdSegments(w, rel);
    var parts = rel.split('/');
    await mkcol(w, [segs[0]]);
    /* 出库凭证多一层目录，逐层 MKCOL，避免坚果云 / 123 云盘返回 409 */
    for (var i = 0; i < parts.length - 1; i++) {
      await mkcol(w, [segs[0], parts.slice(0, i + 1).join('/')]);
    }
    var url = joinUrl(base, segs);
    var res = await fetch(url, {
      method: 'PUT',
      headers: wdHeaders(w, { 'Content-Type': 'image/jpeg' }),
      body: blob
    });
    if (!res.ok) {
      var name = provider(w).name;
      var extra = res.status === 401 ? '（' + name + ' 的账号或应用密码不对，要用「应用密码」而非登录密码）'
        : res.status === 403 ? '（无写入权限、跨域被拒绝或代理密钥不对）'
          : res.status === 409 ? '（上级目录不存在，请先在云盘网页端建好首层目录）' : '';
      throw new Error('HTTP ' + res.status + extra);
    }
  }

  /* ---------- GitHub 仓库直存：照片随项目一起进 repo ----------
     复用「GitHub 同步」里的 token / 仓库 / 分支，照片落到 {dir}/入库照片|出库凭证/年-月/*.jpg。
     公开仓库默认拦截：面单上有收件人手机号与地址，不能跟着代码一起公开。 */
  var GH_API = 'https://api.github.com';
  function ghFromSync() {
    var s = (global.StationSync && typeof global.StationSync.config === 'function') ? global.StationSync.config() : {};
    return { token: String(s.token || ''), repo: String(s.repo || ''), branch: String(s.branch || 'main') };
  }
  function ghSettings() {
    var g = config().github;
    var sync = ghFromSync();
    return {
      token: sync.token,
      /* 留空则跟随同步配置，少填一项 */
      repo: String(g.repo || sync.repo || '').replace(/^\/+|\/+$/g, ''),
      branch: String(g.branch || sync.branch || 'main'),
      dir: String(g.dir || 'photos').replace(/^\/+|\/+$/g, ''),
      allowPublic: !!g.allowPublic,
      isPublic: g.isPublic,
      proxyBase: String(g.proxyBase || '').replace(/\/+$/, ''),
      proxyKey: String(g.proxyKey || ''),
      cache: g.cache !== false
    };
  }
  function ghReady(t) { return !!(t.token && /^[^/\s]+\/[^/\s]+$/.test(t.repo)); }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function ghPath(t, rel) { return (t.dir ? t.dir + '/' : '') + rel; }
  function ghHeaders(t, extra) {
    return Object.assign({
      'Authorization': 'Bearer ' + t.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    }, extra || {});
  }
  function ghError(status) {
    if (status === 401) return 'token 无效或已过期（401）';
    if (status === 403) return '没有权限或触发限流（403），token 需要 Contents 读写权限';
    if (status === 404) return '仓库或分支不存在（404），也可能是 token 无权访问该私有仓库';
    if (status === 422) return '分支不可用或文件已存在（422）';
    return 'GitHub 返回 HTTP ' + status;
  }
  async function ghRepoInfo(t) {
    var res = await fetch(GH_API + '/repos/' + t.repo, { headers: ghHeaders(t) });
    if (!res.ok) throw new Error(ghError(res.status));
    return res.json();
  }
  async function ghIsPublic(t) {
    if (typeof t.isPublic === 'boolean') return t.isPublic;
    var info = await ghRepoInfo(t);
    var pub = !info.private;
    saveConfig({ github: { isPublic: pub } });
    return pub;
  }
  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { reject(new Error('图片编码失败')); };
      fr.readAsDataURL(blob);
    });
  }
  async function githubPut(rel, blob) {
    var t = ghSettings();
    if (!t.token) throw new Error('没填 token：先在「GitHub 同步」里填一个带 Contents 读写权限的 PAT');
    if (!/^[^/\s]+\/[^/\s]+$/.test(t.repo)) throw new Error('没填仓库：在下面填 owner/repo，或先配置「GitHub 同步」');
    if (await ghIsPublic(t) && !t.allowPublic) {
      throw new Error('该仓库是公开的，面单照片会对外可见（含手机号与地址）· 换私有仓库，或勾选「允许写入公开仓库」');
    }
    var path = ghPath(t, rel);
    var b64 = await blobToBase64(blob);
    var res = await fetch(GH_API + '/repos/' + t.repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/'), {
      method: 'PUT',
      headers: ghHeaders(t),
      body: JSON.stringify({ message: 'photos: ' + path.split('/').pop(), content: b64, branch: t.branch })
    });
    if (!res.ok) throw new Error(ghError(res.status));
    return path;
  }
  /* 读取结果按「仓库@分支:路径」缓存到本机 IndexedDB。
     文件名带时间戳与随机串、内容不会变，所以命中即视为最新；换仓库/分支自然换键，不会串。 */
  function ghCacheKey(t, path) { return 'gh:' + t.repo + '@' + t.branch + ':' + path; }
  function ghCachePut(key, blob) {
    idbPut(S_CACHE, { key: key, blob: blob, at: Date.now(), size: blob.size }).then(function () {
      /* 攒一批再剪，避免每张都开一次事务 */
      clearTimeout(pruneTimer);
      pruneTimer = setTimeout(function () {
        idbPruneOldest(S_CACHE, 'at', CACHE_MAX).catch(function () { /* 清理失败不影响读图 */ });
      }, 4000);
    }).catch(function () { /* 缓存写失败（配额满 / 隐私模式）就当没缓存，不影响主流程 */ });
  }
  /* 直连 api.github.com：注入了 token，私有仓库也能拿原始字节 */
  async function ghDirectBlob(t, path) {
    if (!t.token) throw new Error('读取仓库照片需要 token（在「GitHub 同步」里填），或配一个加速节点免 token');
    var url = GH_API + '/repos/' + t.repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/') +
      '?ref=' + encodeURIComponent(t.branch);
    var res = await fetch(url, {
      headers: ghHeaders(t, { 'Accept': 'application/vnd.github.raw' }),
      cache: 'no-store'
    });
    if (!res.ok) throw new Error('GitHub 读取失败：' + ghError(res.status));
    return res.blob();
  }
  /* 经 Cloudflare Worker：边缘缓存 + token 留在服务端，浏览器不用带 PAT */
  async function ghProxyBlob(t, path) {
    var url = t.proxyBase + '/photo?repo=' + encodeURIComponent(t.repo) +
      '&branch=' + encodeURIComponent(t.branch) + '&path=' + encodeURIComponent(path);
    var headers = {};
    if (t.proxyKey) headers['X-Station-Key'] = t.proxyKey;
    var res = await fetch(url, { headers: headers, cache: 'no-store' });
    if (!res.ok) {
      throw new Error('加速节点读取失败：HTTP ' + res.status +
        (res.status === 401 || res.status === 403 ? '（X-Station-Key 不对，或 Worker 没配 GH_TOKEN）' : '') +
        (res.status === 404 ? '（照片不在该分支，或 GH_TOKEN 无权读这个私有仓库）' : ''));
    }
    return res.blob();
  }
  async function ghRawBlob(t, path) {
    return t.proxyBase ? ghProxyBlob(t, path) : ghDirectBlob(t, path);
  }
  async function githubBlob(path) {
    var t = ghSettings();
    if (!/^[^/\s]+\/[^/\s]+$/.test(t.repo)) throw new Error('没填仓库：在下面填 owner/repo，或先配置「GitHub 同步」');
    var key = ghCacheKey(t, path);
    if (t.cache) {
      try {
        var rec = await idbGet(S_CACHE, key);
        if (rec && rec.blob) { cacheStats.hit++; return rec.blob; }
      } catch (e) { /* 缓存坏了就退回网络 */ }
    }
    /* 同一张照片被同时请求（比如网格里重复引用）时只发一次 */
    if (ghInflight[key]) return ghInflight[key];
    cacheStats.miss++;
    var task = ghRawBlob(t, path).then(function (blob) {
      if (t.cache) ghCachePut(key, blob);
      delete ghInflight[key];
      return blob;
    }, function (e) {
      delete ghInflight[key];
      throw e;
    });
    ghInflight[key] = task;
    return task;
  }
  async function clearPhotoCache() {
    try { await idbClear(S_CACHE); } catch (e) { return { ok: false, error: e.message || String(e) }; }
    cacheStats = { hit: 0, miss: 0 };
    return { ok: true };
  }
  async function cacheInfo() {
    var out = { count: 0, hit: cacheStats.hit, miss: cacheStats.miss, max: CACHE_MAX, supported: true };
    try { out.count = await idbCount(S_CACHE); }
    catch (e) { out.supported = false; }
    return out;
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
  /* 拍照取件会把识别出的取件码 / 单号写进文件名，事后在仓库里按码就能翻到凭证。
     只接受干净的单文件名：不允许路径分隔符、控制字符，强制 .jpg（压缩后就是 JPEG）。 */
  function safeCustomName(name) {
    var s = String(name == null ? '' : name)
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
      .replace(/[^0-9A-Za-z_\u4e00-\u9fa5.\-]/g, '_')
      .replace(/^\.+/, '').trim().slice(0, 90);
    if (!s) return '';
    if (!/\.(jpe?g)$/i.test(s)) s = s.replace(/\.[^.]{1,5}$/, '') + '.jpg';
    return s;
  }
  /* 云盘目录：入库照片与出库凭证分开归档，各按年月再分一层，便于事后按日期取证 */
  function buildRel(kind, customName) {
    var pickup = kind === 'pickup';
    var file = safeCustomName(customName) || newName(pickup ? 'CK-' : 'RK-');
    return (pickup ? '出库凭证' : '入库照片') + '/' + monthKey() + '/' + file;
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
  async function put(file, kind, opts) {
    var c = config();
    var blob;
    try { blob = await compress(file, c.maxSide, c.quality); }
    catch (e) { return { ok: false, error: e.message }; }
    var rel = buildRel(kind, opts && opts.name);
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
    if (c.mode === 'github') {
      try {
        var path = await githubPut(rel, blob);
        return { ok: true, ref: 'github:' + path, mode: 'github', size: blob.size, name: name, warning: '' };
      } catch (e) {
        return safeFallback(blob, rel, '写入 GitHub 失败，已暂存浏览器：' + (e.message || e));
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
      var url = joinUrl(endpoint(c.webdav), wdSegments(c.webdav, rel));
      var res = await fetch(url, { headers: wdHeaders(c.webdav) });
      if (!res.ok) throw new Error('WebDAV 读取失败 HTTP ' + res.status);
      return URL.createObjectURL(await res.blob());
    }
    if (String(ref).indexOf('github:') === 0) {
      /* 缓存命中时这里只是把 Blob 包一层 URL，几乎零耗时；URL 仍交给调用方 revoke */
      return URL.createObjectURL(await githubBlob(String(ref).slice(7)));
    }
    throw new Error('无法识别的图片引用');
  }

  async function test() {
    var c = config();
    if (c.mode === 'browser') return { ok: true, message: '当前为浏览器暂存模式，图片不会写入云盘' };
    if (c.mode === 'github') {
      var t = ghSettings();
      if (!t.token) return { ok: false, error: '请先在「GitHub 同步」里填 Personal Access Token（需 Contents 读写权限）' };
      if (!/^[^/\s]+\/[^/\s]+$/.test(t.repo)) return { ok: false, error: '请填仓库，格式 owner/repo' };
      try {
        var t0 = nowMs();
        var repo = await ghRepoInfo(t);
        var directMs = Math.round(nowMs() - t0);
        saveConfig({ github: { isPublic: !repo.private } });
        var br = await fetch(GH_API + '/repos/' + t.repo + '/branches/' + encodeURIComponent(t.branch), { headers: ghHeaders(t) });
        if (!br.ok) return { ok: false, error: '分支不可用：' + ghError(br.status) };
        if (!repo.private && !t.allowPublic) {
          return { ok: false, error: '这个仓库是公开的：照片会对外可见（面单含手机号/地址）。换私有仓库，或勾选「允许写入公开仓库」' };
        }
        var line = '可写：' + t.repo + ' @ ' + t.branch + ' · ' + (repo.private ? '私有仓库' : '公开仓库') + ' · 目录 ' + t.dir + '/';
        line += ' · 直连 ' + directMs + 'ms';
        var extra = { directMs: directMs, proxyMs: null, cache: t.cache };
        if (t.proxyBase) {
          try {
            var p0 = nowMs();
            var pr = await fetch(t.proxyBase + '/ping', {
              headers: t.proxyKey ? { 'X-Station-Key': t.proxyKey } : {}, cache: 'no-store'
            });
            if (!pr.ok) { line += ' · 加速节点 HTTP ' + pr.status; }
            else { extra.proxyMs = Math.round(nowMs() - p0); line += ' · 加速节点 ' + extra.proxyMs + 'ms'; }
          } catch (e) {
            line += ' · 加速节点不可达（' + (e.message || e) + '）';
          }
        }
        line += t.cache ? ' · 本机缓存已开' : ' · 本机缓存已关';
        return { ok: true, message: line, stats: extra };
      } catch (e) {
        return { ok: false, error: '连不上 GitHub：' + (e.message || e) };
      }
    }
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
    var p = provider(c.webdav);
    var base = endpoint(c.webdav);
    if (!base) return { ok: false, error: '请先填写 WebDAV 地址或云盘代理地址' };
    try {
      var res = await fetch(joinUrl(base, []), {
        method: 'PROPFIND',
        headers: wdHeaders(c.webdav, { 'Depth': '0' })
      });
      if (res.status === 401) {
        return {
          ok: false,
          error: p.name + ' 账号或应用密码错误（401）· 请用「应用密码」而不是登录密码' +
            (p.key === 'pan123'
              ? '；若后台根本没有「WebDAV 授权管理」，说明该账号不含 WebDAV 权益（2026-11-04 起新账号/新会员不再包含），请改用坚果云或「本机文件夹」'
              : '')
        };
      }
      if (!res.ok && res.status !== 207) return { ok: false, error: p.name + ' WebDAV 返回 HTTP ' + res.status };
      return { ok: true, message: p.name + ' 可访问（' + base + '）' };
    } catch (e) {
      return {
        ok: false,
        error: '连不上 ' + p.name + '：' + (e.message || e) +
          '。' + p.name + ' WebDAV 没有 CORS 头，浏览器无法直连，请把 deploy/webdav-proxy.js 部署成 Cloudflare Worker，' +
          '在「CORS 代理地址」填 Worker 根地址（结尾不带 /' + p.proxyPath.replace(/^\//, '') + '）；AList 若是 http 内网地址也会被 https 页面拦截。'
      };
    }
  }

  function status() {
    var c = config();
    if (c.mode === 'browser') return '浏览器暂存模式 · 图片不写入云盘';
    if (c.mode === 'github') {
      var t = ghSettings();
      if (!ghReady(t)) return 'GitHub 未配置（缺 token 或仓库）· 照片暂存浏览器';
      var vis = typeof t.isPublic === 'boolean' ? (t.isPublic ? '公开仓库·会被拦' : '私有仓库') : '未校验';
      return 'GitHub ' + t.repo + ' · ' + t.dir + '/ · ' + vis +
        (t.proxyBase ? ' · 加速' : ' · 直连') + (t.cache ? ' + 缓存' : '');
    }
    if (c.mode === 'webdav') {
      var p = provider(c.webdav);
      var base = endpoint(c.webdav);
      if (!base) return p.name + ' 未填地址 · 照片暂存浏览器';
      var viaProxy = !!c.webdav.proxyBase;
      return p.name + (viaProxy ? '（经 Worker）' : '') + ' · ' + base.replace(/^https?:\/\//, '');
    }
    if (!isLocalSupported()) return '当前浏览器不支持文件夹授权，请改用 WebDAV';
    return dirHandleRecord && dirHandleRecord.handle
      ? '已授权同步文件夹 · ' + (dirHandleRecord.handle.name || '') + '/' + c.dirName
      : '尚未选择云盘同步文件夹 · 照片暂存浏览器';
  }

  var api = {
    config: config, saveConfig: saveConfig, init: init,
    isLocalSupported: isLocalSupported, pickDirectory: pickDirectory,
    put: put, getUrl: getUrl, test: test, status: status, buildRel: buildRel,
    safeCustomName: safeCustomName,
    providers: function () {
      return PROVIDER_KEYS.map(function (k) {
        return {
          key: k, name: PROVIDERS[k].name, upstream: PROVIDERS[k].upstream,
          proxyPath: PROVIDERS[k].proxyPath, account: PROVIDERS[k].account, hint: PROVIDERS[k].hint
        };
      });
    },
    endpoint: function (patch) {
      return endpoint(Object.assign(config().webdav, patch || {}));
    },
    /* 供设置页与测试用的 GitHub 目标解析 */
    githubTarget: function () {
      var t = ghSettings();
      return {
        repo: t.repo, branch: t.branch, dir: t.dir, ready: ghReady(t),
        allowPublic: t.allowPublic, isPublic: t.isPublic,
        proxyBase: t.proxyBase, cache: t.cache
      };
    },
    githubPath: function (rel) { return ghPath(ghSettings(), rel || '入库照片/2026-01/RK-x.jpg'); },
    /* 缓存与加速：给设置页做状态展示、清空与本机验证 */
    cacheInfo: cacheInfo,
    clearCache: clearPhotoCache,
    cacheLimit: function () { return CACHE_MAX; },
    photoUrl: function (repo, branch, path) {
      var t = Object.assign(ghSettings(), { repo: repo || '', branch: branch || '' });
      return t.proxyBase
        ? t.proxyBase + '/photo?repo=' + encodeURIComponent(t.repo) + '&branch=' + encodeURIComponent(t.branch) + '&path=' + encodeURIComponent(path || '')
        : GH_API + '/repos/' + t.repo + '/contents/' + String(path || '').split('/').map(encodeURIComponent).join('/') + '?ref=' + encodeURIComponent(t.branch);
    }
  };
  global.StationPhotos = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
