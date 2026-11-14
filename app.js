/* 快递驿站 - 界面与交互 */
(function () {
  'use strict';

  /* 不能直接写 createStore(localStorage)：Safari 开了「阻止所有 Cookie」、微信/QQ 内置浏览器
     或 WebView 未开 DOM storage 时，读 localStorage 这个属性本身就会抛 SecurityError，
     整个 app.js 会在加载阶段崩掉，所有按钮绑定都执行不到 —— 表现就是「点登录毫无反应」。
     pickStorage 会兜住异常并退回内存实现。 */
  var store = StationStore.createStore(StationStore.pickStorage('local'));
  var auth = window.StationAuth;
  var sync = window.StationSync;
  var photos = window.StationPhotos;
  var camera = window.StationCamera;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var viewTitles = {
    dash: ['工作台', '今天也要把包裹安排明白'],
    lookup: ['查件', '报尾号或扫单号，货架位与取件状态一屏看清'],
    inbound: ['入库登记', '扫码、回车、下一件'],
    outbound: ['取件出库', '按后四位或单号找件，支持一次多件'],
    inventory: ['在库台账', '所有包裹的记录、修改与检索'],
    analytics: ['统计看板', '流转、滞留与货架占用'],
    logs: ['操作流水', '每一步都留痕，误操作可撤销'],
    accounts: ['账号管理', '子账号、角色权限与密码'],
    settings: ['设置与数据', '驿站参数、备份导出与 GitHub 同步']
  };
  var state = { view: 'dash', selected: {}, invLimit: 50, outKeyword: '', lookupKey: '',
    inFiles: [], proofFiles: [], lastParcel: null };
  var syncTimer = null;
  var inPreviewUrls = [];
  var proofPreviewUrls = [];
  var viewerUrls = [];

  /* ---------- 基础工具 ---------- */
  function toast(msg, type) {
    var el = $('toast');
    el.innerHTML = '<div class="toast-inner ' + (type === 'err' ? 'err' : 'ok') + '">' +
      '<svg class="ic"><use href="#' + (type === 'err' ? 'i-warn' : 'i-check') + '"/></svg>' + esc(msg) + '</div>';
    el.classList.add('show');
    clearTimeout(el._timer);
    el._timer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }
  function closeModal() { $('modalRoot').innerHTML = ''; }
  function confirmDialog(title, text, okText, isDanger) {
    return new Promise(function (resolve) {
      $('modalRoot').innerHTML = '<div class="modal-mask"><div class="modal">' +
        '<h3>' + esc(title) + '</h3><p>' + esc(text) + '</p>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-act="cancel">取消</button>' +
        '<button class="btn ' + (isDanger ? 'btn-primary' : 'btn-primary') + '" data-act="ok">' + esc(okText || '确认') + '</button></div>' +
        '</div></div>';
      var root = $('modalRoot');
      root.querySelector('[data-act="cancel"]').onclick = function () { closeModal(); resolve(false); };
      root.querySelector('[data-act="ok"]').onclick = function () { closeModal(); resolve(true); };
      root.querySelector('.modal-mask').onclick = function (e) { if (e.target === this) { closeModal(); resolve(false); } };
    });
  }
  function editDialog(p) {
    return new Promise(function (resolve) {
      var carriers = store.settings().carriers.map(function (c) {
        return '<option value="' + esc(c) + '"' + (c === p.carrier ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('');
      $('modalRoot').innerHTML = '<div class="modal-mask"><div class="modal">' +
        '<h3>修改包裹资料</h3><p>运单号 ' + esc(p.trackingNo) + ' · 当前状态：' + (p.status === 'in' ? '在库' : '已出库') + '</p>' +
        '<div class="field"><label>运单号</label><input class="input" id="edNo" value="' + esc(p.trackingNo) + '"></div>' +
        '<div class="field-row"><div class="field"><label>快递公司</label><select class="input" id="edCarrier">' + carriers + '</select></div>' +
        '<div class="field"><label>件数</label><input class="input" type="number" min="1" id="edCount" value="' + p.count + '"></div></div>' +
        '<div class="field-row"><div class="field"><label>收件人</label><input class="input" id="edRecipient" value="' + esc(p.recipient) + '"></div>' +
        '<div class="field"><label>手机后四位</label><input class="input" id="edPhone" value="' + esc(p.phoneTail) + '"></div></div>' +
        '<div class="field-row"><div class="field"><label>取件码</label><input class="input" id="edCode" value="' + esc(p.pickupCode || '') + '"></div>' +
        '<div class="field"><label>货架位</label><input class="input" id="edSlot" value="' + esc(p.slot) + '"></div></div>' +
        '<div class="field"><label>备注</label><input class="input" id="edNote" value="' + esc(p.note) + '"></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" data-act="ok">保存修改</button></div></div></div>';
      var root = $('modalRoot');
      root.querySelector('[data-act="cancel"]').onclick = function () { closeModal(); resolve(null); };
      root.querySelector('[data-act="ok"]').onclick = function () {
        var patch = {
          trackingNo: $('edNo').value, carrier: $('edCarrier').value, count: $('edCount').value,
          recipient: $('edRecipient').value, phoneTail: $('edPhone').value,
          slot: $('edSlot').value, note: $('edNote').value
        };
        /* 只有真正改了取件码才传，避免覆盖「换货位时自动重算」 */
        if ($('edCode').value.trim() !== (p.pickupCode || '')) patch.pickupCode = $('edCode').value;
        closeModal(); resolve(patch);
      };
      root.querySelector('.modal-mask').onclick = function (e) { if (e.target === this) { closeModal(); resolve(null); } };
    });
  }
  /* 取件标签：普通打印机即可，不依赖本机打印控件 */
  function printLabelDialog(p) {
    $('modalRoot').innerHTML = '<div class="modal-mask"><div class="modal label-modal">' +
      '<h3>取件标签</h3><p>用普通打印机打在标签纸或 A4 上，贴到面单；也可以直接抄下取件码。</p>' +
      '<div class="label-sheet" id="labelSheet">' +
      '<div class="ls-station">' + esc(store.settings().stationName) + '</div>' +
      '<div class="ls-caption">取件码 / 货号</div>' +
      '<div class="ls-code">' + esc(p.pickupCode || '—') + '</div>' +
      '<div class="ls-slot">货架位 <b>' + esc(p.slot || '—') + '</b></div>' +
      '<div class="ls-row"><span>收件人 ' + esc(p.recipient || '—') + '</span><span>尾号 ' + esc(p.phoneTail || '—') + '</span></div>' +
      '<div class="ls-row"><span>' + esc(p.carrier) + '</span><span>' + esc(store.fmtTime(p.inAt)) + '</span></div>' +
      '<div class="ls-no">' + esc(p.trackingNo) + '</div>' +
      '</div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-act="close">关闭</button>' +
      '<button class="btn btn-outline" data-act="copy">复制取件码</button>' +
      '<button class="btn btn-primary" data-act="print"><svg class="ic"><use href="#i-print"/></svg>打印标签</button></div>' +
      '</div></div>';
    var root = $('modalRoot');
    root.querySelector('[data-act="close"]').onclick = closeModal;
    root.querySelector('[data-act="copy"]').onclick = function () { copyText(p.pickupCode || ''); };
    root.querySelector('[data-act="print"]').onclick = function () {
      document.body.classList.add('printing-label');
      window.addEventListener('afterprint', function handler() {
        document.body.classList.remove('printing-label');
        window.removeEventListener('afterprint', handler);
      });
      window.print();
    };
    root.querySelector('.modal-mask').onclick = function (e) { if (e.target === this) closeModal(); };
  }

  /* 入库框里的取件码预览：手改过就保留，换货架位只重算自动生成的值 */
  function refreshCodePreview(force) {
    var el = $('inPickupCode');
    var slot = $('inSlot').value.trim() || store.suggestSlot($('inZone').value || store.settings().zones[0]);
    var auto = store.previewPickupCode(slot);
    if (force || !el.dataset.manual || el.value === el.dataset.auto) {
      el.value = auto;
      el.dataset.auto = auto;
      el.dataset.manual = '';
    }
    var mode = store.settings().codeMode;
    $('inCodeHint').textContent = mode === 'off'
      ? '当前规则为「不生成取件码」，旧记录仍可用原码查件'
      : mode === 'daily' ? '每日流水号：每天从 001 开始，不与当天已有件重复'
        : '顾客报码即可查件；货架位变化会自动重算';
  }

  function downloadFile(name, text, mime) {
    /* 安卓 App 内运行时：WebView 不支持 blob 下载，交给原生写入「下载/快递驿站」 */
    if (window.StationNative && typeof window.StationNative.saveText === 'function') {
      try {
        window.StationNative.saveText(name, text, mime || 'text/plain;charset=utf-8');
        return;
      } catch (e) { /* 桥接异常时回落到浏览器下载 */ }
    }
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function dateStamp() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  }
  function scheduleSync() {
    var c = sync.config();
    if (!c.auto || !sync.isConfigured()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () {
      sync.push(store.exportJSON()).then(function (r) {
        renderSyncState();
        if (!r.ok) toast('自动同步失败：' + r.error, 'err');
      });
    }, 2500);
  }
  /* 本地存储写不进去（无痕模式 / 存储满 / 系统限制）时只提示一次，避免每次操作都弹 */
  var storageWarned = false;
  function warnStorageOnce() {
    if (storageWarned) return;
    var okStore = typeof store.storageOk !== 'function' || store.storageOk();
    var okAuth = auth.status ? auth.status().storageOk !== false : true;
    if (okStore && okAuth) return;
    storageWarned = true;
    toast('本机存储写不进去（无痕模式或空间不足）：这次改动刷新后会丢，请尽快导出备份', 'err');
  }
  function afterWrite(msg, type) {
    if (msg) toast(msg, type);
    warnStorageOnce();
    renderAll();
    scheduleSync();
  }

  /* ---------- 照片 ---------- */
  function releaseUrls(arr) {
    arr.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ } });
    arr.length = 0;
  }
  function renderFilePreview(containerId, files, urlBag, removable) {
    releaseUrls(urlBag);
    $(containerId).innerHTML = files.map(function (f, i) {
      var u = URL.createObjectURL(f);
      urlBag.push(u);
      return '<div class="thumb"><img src="' + u + '" alt="待上传照片">' +
        (removable ? '<button type="button" class="thumb-del" data-remove="' + i + '" title="移除"><svg class="ic"><use href="#i-close"/></svg></button>' : '') +
        '</div>';
    }).join('');
  }
  function clearFiles(which) {
    if (which === 'in') {
      state.inFiles = []; $('inPhotos').value = '';
      renderFilePreview('inPhotoPreview', state.inFiles, inPreviewUrls, true);
    } else {
      state.proofFiles = []; $('outProof').value = '';
      renderFilePreview('proofPreview', state.proofFiles, proofPreviewUrls, false);
    }
  }
  function addFiles(which, fileList) {
    var files = Array.from(fileList || []).filter(function (f) { return /^image\//.test(f.type); }).slice(0, 12);
    if (!files.length) { toast('请选择图片文件', 'err'); return; }
    if (which === 'in') {
      state.inFiles = state.inFiles.concat(files).slice(0, 12);
      renderFilePreview('inPhotoPreview', state.inFiles, inPreviewUrls, true);
    } else {
      state.proofFiles = state.proofFiles.concat(files).slice(0, 12);
      renderFilePreview('proofPreview', state.proofFiles, proofPreviewUrls, false);
    }
    renderPhotoStatus();
  }
  async function savePhotos(files, kind) {
    var items = [], warnings = [], failed = 0;
    for (var i = 0; i < files.length; i++) {
      var r;
      try { r = await photos.put(files[i], kind); }
      catch (e) { r = { ok: false, error: e.message || String(e) }; }
      if (!r.ok) { failed++; continue; }
      if (r.warning) warnings.push(r.warning);
      items.push({
        ref: r.ref, name: r.name, mode: r.mode, kind: kind,
        size: r.size, at: new Date().toISOString()
      });
    }
    return { items: items, warnings: warnings, failed: failed };
  }
  function reportPhotoResult(res) {
    if (res.failed) toast(res.failed + ' 张照片保存失败，包裹记录已保留', 'err');
    if (res.warnings.length) toast(res.warnings[0], 'err');
  }
  function renderPhotoStatus() {
    var st = photos.status();
    $('photoStatus').textContent = st;
    $('inPhotoState').textContent = state.inFiles.length ? state.inFiles.length + ' 张待上传 · ' + st : st;
    var n = state.proofFiles.length;
    $('btnProof').innerHTML = '<svg class="ic"><use href="#i-camera"/></svg>' + (n ? '凭证 ' + n + ' 张 · 再拍' : '拍取件凭证');
  }
  async function renderCacheState() {
    var el = $('ghCacheState');
    if (!el) return;
    var info = await photos.cacheInfo();
    var c = photos.config();
    if (!info.supported) { el.textContent = '本机缓存不可用（这个浏览器禁用了本地存储），照片每次都会重新下载'; return; }
    var hits = info.hit, total = info.hit + info.miss;
    var rate = total ? Math.round(hits * 100 / total) + '%' : '—';
    el.textContent = '已缓存 ' + info.count + '/' + info.max + ' 张 · 本次命中 ' + hits + '/' + total +
      '（' + rate + '）' + (c.github.cache ? '' : ' · 缓存开关已关');
  }
  /* 拍照：优先调用设备摄像头实时预览，不可用时回退到系统相机 / 相册 */
  function nativeCapture(which) {
    var input = $(which === 'in' ? 'inPhotos' : 'outProof');
    input.setAttribute('capture', 'environment');
    input.click();
    setTimeout(function () { input.removeAttribute('capture'); }, 1500);
  }
  async function takePhoto(which) {
    var single = which === 'proof';
    if (camera && camera.supported()) {
      var files = await camera.open({
        single: single,
        title: single ? '取件凭证 · 拍照' : '面单 / 包裹照片'
      });
      if (files && files.length) { addFiles(which, files); return files; }
      if (camera.lastError) { toast(camera.lastError, 'err'); nativeCapture(which); }
      return null;
    }
    nativeCapture(which);
    return null;
  }
  function togglePhotoBoxes() {
    var m = $('phMode').value;
    $('phGithubBox').hidden = m !== 'github';
    $('phWebdavBox').hidden = m !== 'webdav';
    $('phProviderTipBox').hidden = m !== 'webdav';
    $('phWebdavTipBox').hidden = m !== 'webdav';
    $('phLocalBox').hidden = m !== 'local';
  }
  function currentProvider() {
    var key = $('phProvider').value;
    var list = photos.providers();
    for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
    return list[0];
  }
  /* 切换云盘服务时带出官方地址，并实时预览真正会请求的根地址 */
  function refreshProviderUI(applyPreset) {
    var p = currentProvider();
    var all = photos.providers();
    var cur = $('phBase').value.trim();
    var isPreset = all.some(function (x) { return x.upstream && x.upstream === cur; });
    if (applyPreset ? (!cur || isPreset) : (!cur && p.upstream)) $('phBase').value = p.upstream || '';

    $('phUserLabel').textContent = '账号（' + p.account + '）';
    $('phProviderTitle').textContent = p.upstream ? '用 ' + p.name + '：三步就够' : '自定义 WebDAV（AList 等）';
    $('phProviderHint').innerHTML = p.hint +
      (p.upstream
        ? ' ③ 把仓库里的 <b>deploy/webdav-proxy.js</b> 部署成 Cloudflare Worker（只补 CORS 头，不需要服务器），' +
          '把 <b>Worker 根地址</b>填到「CORS 代理地址」，下面的上游地址保持默认即可。' +
          (p.key === 'pan123'
            ? '照片按 <b>入库照片/出库凭证 + 年-月</b> 自动分目录。注意：123 云盘自 2026-11-04 起新账号/新会员已不含 WebDAV，' +
              '后台看不到「WebDAV 授权管理」就说明这个账号没有该权益，别在这儿耗时间，改用坚果云或本机文件夹。'
            : '照片按 <b>入库照片/出库凭证 + 年-月</b> 自动分目录。坚果云免费版就有 WebDAV，每月上传 1GB / 下载 3GB，' +
              '存出库凭证够用；照片量大就把「图片最长边」调到 1200，或升级套餐。')
        : '');
    var ep = photos.endpoint({
      provider: $('phProvider').value,
      baseUrl: $('phBase').value.trim(),
      proxyBase: $('phProxyBase').value.trim()
    });
    $('phProviderRoute').textContent = !ep
      ? '实际请求：未配置'
      : $('phProxyBase').value.trim()
        ? '实际请求：' + ep + '（经 Worker 转发到 ' + ($('phBase').value.trim() || '上游') + '）'
        : '实际请求：' + ep + (p.upstream ? ' · 直连没有 CORS 头，浏览器会拦，务必填代理地址' : '');
  }
  function fillPhotoSettings() {
    var c = photos.config();
    $('phMode').value = c.mode;
    $('phDir').value = c.dirName;
    $('phProvider').value = c.webdav.provider || 'nutstore';
    $('phBase').value = c.webdav.baseUrl;
    $('phProxyBase').value = c.webdav.proxyBase;
    $('phUser').value = c.webdav.user;
    $('phPass').value = c.webdav.pass;
    $('phProxyKey').value = c.webdav.proxyKey;
    $('ghRepo').value = c.github.repo;
    $('ghBranch').value = c.github.branch;
    $('ghDir').value = c.github.dir;
    $('ghAllowPublic').checked = !!c.github.allowPublic;
    $('ghProxyBase').value = c.github.proxyBase;
    $('ghProxyKey').value = c.github.proxyKey;
    $('ghCache').checked = c.github.cache !== false;
    $('phMax').value = c.maxSide;
    $('phQuality').value = c.quality;
    $('phRequireProof').checked = c.requireProof !== false;
    togglePhotoBoxes();
    refreshProviderUI(false);
    renderPhotoStatus();
    renderCacheState();
  }
  function savePhotoForm() {
    photos.saveConfig({
      mode: $('phMode').value,
      dirName: $('phDir').value.trim(),
      webdav: {
        provider: $('phProvider').value,
        baseUrl: $('phBase').value.trim(),
        proxyBase: $('phProxyBase').value.trim(),
        user: $('phUser').value,
        pass: $('phPass').value,
        proxyKey: $('phProxyKey').value.trim()
      },
      github: {
        repo: $('ghRepo').value.trim(),
        branch: $('ghBranch').value.trim(),
        dir: $('ghDir').value.trim() || 'photos',
        allowPublic: $('ghAllowPublic').checked,
        proxyBase: $('ghProxyBase').value.trim(),
        proxyKey: $('ghProxyKey').value.trim(),
        cache: $('ghCache').checked
      },
      maxSide: Number($('phMax').value),
      quality: Number($('phQuality').value),
      requireProof: $('phRequireProof').checked
    });
    renderPhotoStatus();
  }
  async function openPhotoViewer(parcelId) {
    var p = store.getDB().parcels.find(function (x) { return x.id === parcelId; });
    if (!p || !p.photos || !p.photos.length) return;
    releaseUrls(viewerUrls);
    $('modalRoot').innerHTML = '<div class="modal-mask"><div class="modal" style="width:min(700px,100%)">' +
      '<h3>' + esc(p.trackingNo) + ' · 照片 ' + p.photos.length + ' 张</h3>' +
      '<p>照片按设置存到 GitHub 仓库或云盘。移除只删台账里的引用，文件本身保留。</p>' +
      '<div class="viewer-grid" id="viewerGrid"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-act="close">关闭</button></div></div></div>';
    var root = $('modalRoot');
    root.querySelector('[data-act="close"]').onclick = function () { releaseUrls(viewerUrls); closeModal(); };
    root.querySelector('.modal-mask').onclick = function (e) {
      if (e.target === this) { releaseUrls(viewerUrls); closeModal(); }
    };
    var grid = $('viewerGrid');
    grid.innerHTML = p.photos.map(function (ph) {
      return '<div class="viewer-item"><div class="viewer-img" data-img>加载中…</div>' +
        '<div class="viewer-meta"><span class="viewer-kind">' + (ph.kind === 'pickup' ? '取件凭证' : '入库照片') + '</span>' +
        '<button type="button" data-detach="' + esc(ph.id) + '">移除引用</button></div></div>';
    }).join('');
    var loads = p.photos.map(function (ph, idx) {
      var box = grid.children[idx] && grid.children[idx].querySelector('[data-img]');
      if (!box) return null;
      return photos.getUrl(ph.ref).then(function (url) {
        viewerUrls.push(url);
        box.innerHTML = '<img src="' + url + '" alt="照片">';
      }).catch(function (e) {
        box.textContent = e.message || '读取失败';
      });
    });
    /* 照片读完后刷新缓存命中率，顺便让「清除缓存」旁边的数字是实时的 */
    Promise.all(loads).then(renderCacheState, renderCacheState);
    grid.addEventListener('click', function (e) {
      var b = e.target.closest('[data-detach]');
      if (!b) return;
      if (!window.confirm('移除这张照片的引用？台账里将不再显示，阿里云盘里的文件保留。')) return;
      var r = store.detachPhoto(parcelId, b.dataset.detach);
      if (!r.ok) { toast(r.error, 'err'); return; }
      releaseUrls(viewerUrls);
      closeModal();
      afterWrite('已移除照片引用');
    });
  }

  /* ---------- 账号、登录门与权限 ---------- */
  function guard(perm) {
    if (auth.can(perm)) return true;
    var c = auth.current();
    toast('当前账号（' + (c ? c.roleName : '未登录') + '）没有此操作权限', 'err');
    return false;
  }
  function renderUserChip() {
    var c = auth.current();
    $('userChip').textContent = c ? c.name + ' · ' + c.roleName : '未登录';
  }
  function applyPermissions() {
    document.querySelectorAll('[data-perm]').forEach(function (el) {
      var ok = auth.can(el.dataset.perm);
      if (el.classList.contains('nav-item')) { el.hidden = !ok; return; }
      if (el.tagName === 'FORM') {
        el.querySelectorAll('input, select, button, textarea').forEach(function (x) { x.disabled = !ok; });
      } else el.disabled = !ok;
      el.classList.toggle('perm-locked', !ok);
    });
    renderUserChip();
    if (!viewTitles[state.view]) state.view = 'dash';
    var activeNav = $('nav').querySelector('[data-view="' + state.view + '"]');
    if (!activeNav || activeNav.hidden) state.view = 'dash';
  }
  function authMsg(text, isErr) {
    var box = $('authMsg');
    box.textContent = text;
    box.className = 'auth-msg' + (isErr ? ' err' : ' ok');
    box.hidden = false;
    /* 手机上键盘会挡掉下半屏，错误提示在按钮下方很容易看不见，主动带进视野 */
    try { box.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* 老浏览器忽略 */ }
  }
  /* 初始化入口只在「一个账号都没有」且显式请求时才放行：
     ① 打开带 #setup 或 ?setup=1 的地址；② 在登录面板长按标题 1.2 秒（安卓 App 用这个）。
     站内不再默认展示注册表单，外人打开网站只能看到登录框。 */
  function wantSetup() {
    if (!auth.status().needSetup) return false;
    var h = String(location.hash || '').toLowerCase();
    var q = String(location.search || '').toLowerCase();
    return h === '#setup' || h === '#/setup' || q.indexOf('setup=1') >= 0;
  }
  function showGate(mode) {
    var st = auth.status();
    /* 有账号时注册入口永久失效，任何情况下都回落到登录 */
    if (mode === 'setup' && !st.needSetup) mode = 'login';
    document.body.classList.add('auth-locked');
    $('authGate').hidden = false;
    $('authSetup').hidden = mode !== 'setup';
    $('authLogin').hidden = mode !== 'login';
    $('authStationName').textContent = store.settings().stationName;
    $('authMsg').hidden = true;
    ['regPass', 'regConfirm', 'loginPass'].forEach(function (id) { $(id).value = ''; });
    /* 无账号时在登录页给出唯一线索，避免站长自己也不知道怎么初始化 */
    var boot = $('authBootHint');
    if (boot) {
      boot.hidden = !(mode === 'login' && st.needSetup);
    }
    /* 存储不可写（无痕模式/配额满）时提前说清楚，别等用户输完密码以为账号错了 */
    var sh = $('authStorageHint');
    if (sh) {
      sh.hidden = st.storageOk !== false;
      var why = $('authStorageWhy');
      if (why && st.storageOk === false) {
        /* file:// 是最常见的一种：手机上直接点开下载的 index.html，
           Chrome / Safari 一律拒绝这类页面使用 localStorage，提示必须写准。 */
        why.innerHTML = location.protocol === 'file:'
          ? '你现在是用<b>文件方式</b>打开的（<code>file://</code>）。Chrome 与 Safari 都禁止这种页面保存数据，所以账号库读不到，也没法登录。请把站点放到网址上打开（GitHub Pages 等），或直接用安卓 App。'
          : '账号库读不到，也存不下来。常见原因：<b>Safari 开了「阻止所有 Cookie」</b>、<b>微信/QQ/微博的内置浏览器</b>、无痕模式、存储已满。请复制地址栏网址，用<b>系统浏览器</b>（Safari / Chrome）重新打开；Safari 需到「设置 → Safari → 阻止所有 Cookie」关掉。';
      }
    }
    var focusId = mode === 'setup' ? 'regName' : 'loginUser';
    /* 触屏设备不自动聚焦：一进页面就弹键盘，iOS 还会因输入框字号不足 16px 自动放大，
       把登录按钮顶出可视区——这正是「手机上点不到登录」的典型成因。 */
    var coarse = false;
    try { coarse = window.matchMedia('(hover: none), (pointer: coarse)').matches; } catch (e) { coarse = false; }
    if (!coarse) setTimeout(function () { $(focusId).focus(); }, 80);
  }
  function hideGate() {
    document.body.classList.remove('auth-locked');
    $('authGate').hidden = true;
  }
  function enterApp() {
    var c = auth.current();
    if (!c) { showGate(wantSetup() ? 'setup' : 'login'); return; }
    /* 先放行进入，再补记账：写日志失败不该把登录卡在门口 */
    hideGate();
    store.setActor(c.name);
    try { store.logEvent('login', c.name + ' 登录（' + c.roleName + '）'); } catch (e) { /* 日志失败不影响使用 */ }
    applyPermissions();
    fillSettings();
    renderAll();
    var target = hashView();
    switchView(target || 'dash', target ? { noHash: true } : undefined);
    if (target) toast('已打开「' + viewTitles[target][0] + '」');
    else toast('欢迎回来，' + c.name + '（' + c.roleName + '）');
    /* 放在最后：存储告警比「欢迎回来」更需要被看见 */
    warnStorageOnce();
  }
  function leaveApp() {
    var c = auth.current();
    if (c) { try { store.logEvent('logout', c.name + ' 退出登录'); } catch (e) { /* 忽略 */ } }
    auth.logout();
    store.setActor('');
    state.selected = {}; state.outKeyword = ''; state.lookupKey = '';
    ['outSearch', 'lookupKey', 'quickLookup'].forEach(function (id) { $(id).value = ''; });
    syncHash('dash');
    showGate('login');
  }
  /* 闲置自动锁定：设备放在柜台上没人管时，别让人顺手点进去。
     15 分钟无操作即回登录门；正在输入框里打字（可能填到一半）不抢锁。 */
  var IDLE_MS = 15 * 60 * 1000;
  var idleAt = Date.now();
  function markActive() { idleAt = Date.now(); }
  function idleTick() {
    if (!auth.current() || document.body.classList.contains('auth-locked')) return;
    var ae = document.activeElement;
    var tag = ae && ae.tagName ? ae.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select') { idleAt = Date.now(); return; }
    if (Date.now() - idleAt < IDLE_MS) return;
    leaveApp();
    authMsg('已闲置 ' + Math.round(IDLE_MS / 60000) + ' 分钟，为防止他人操作已自动锁定，请重新登录', false);
  }
  function bindIdle() {
    ['mousedown', 'keydown', 'touchstart', 'change', 'wheel'].forEach(function (ev) {
      document.addEventListener(ev, markActive, { passive: true, capture: true });
    });
    setInterval(idleTick, 30000);
    /* 切回前台立刻判断一次，别等下一个 30 秒 */
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) idleTick();
    });
  }
  function bindAuth() {
    /* 手机键盘弹出时，position:fixed 的登录门不会被压缩，按钮会躲在键盘后面且滚不到。
       用 visualViewport 算出键盘占了多高，写进 --kb，给登录门留出可滚动的余量。 */
    (function bindKeyboardInset() {
      var vv = window.visualViewport;
      if (!vv || !vv.addEventListener) return;
      var apply = function () {
        var gap = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
        document.documentElement.style.setProperty('--kb', gap + 'px');
      };
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      apply();
    })();
    $('formRegister').addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        var r = auth.register({
          name: $('regName').value, username: $('regUser').value,
          password: $('regPass').value, confirm: $('regConfirm').value,
          remember: $('regRemember').checked
        });
        if (!r.ok) { authMsg(r.error, true); return; }
        toast('初始化完成，注册入口已关闭，之后请在「账号管理」里添加店员');
        enterApp();
        if (r.warning) toast(r.warning, 'err');
      } catch (err) {
        /* 兜住任何意外异常：不能让按钮点下去毫无反应 */
        authMsg('初始化失败：' + (err && err.message ? err.message : '浏览器拒绝写入本地存储'), true);
      }
    });
    $('formLogin').addEventListener('submit', function (e) {
      e.preventDefault();
      try {
        /* 锁定期间连正确密码也不放行，避免绕过限速反复试 */
        var wait = auth.lockRemain ? auth.lockRemain() : 0;
        if (wait > 0) { authMsg('密码错误次数过多，请 ' + wait + ' 秒后再试', true); return; }
        var r = auth.login({
          username: $('loginUser').value, password: $('loginPass').value,
          remember: $('loginRemember').checked
        });
        if (!r.ok) { authMsg(r.error, true); return; }
        /* 上一次输错留下的红字必须清掉，否则登录成功后回到登录页还会看到旧报错 */
        authMsg('', false);
        $('authMsg').hidden = true;
        enterApp();
        if (r.warning) toast(r.warning, 'err');
      } catch (err) {
        authMsg('登录失败：' + (err && err.message ? err.message : '浏览器拒绝写入本地存储'), true);
      }
    });
    /* 无账号时长按标题 1.2 秒进入初始化（安卓 App 内没法改地址，只能靠手势） */
    var brand = document.querySelector('.auth-brand');
    if (brand && !brand.dataset.longpress) {
      brand.dataset.longpress = '1';
      var timer = null;
      var trySetup = function () {
        if (!auth.status().needSetup) { authMsg('本站已初始化，注册入口已关闭', true); return; }
        showGate('setup');
        authMsg('已进入初始化，请创建站长账号；建好后此入口自动失效', false);
      };
      var stop = function () { if (timer) { clearTimeout(timer); timer = null; } };
      var start = function () {
        stop();
        timer = setTimeout(function () { timer = null; trySetup(); }, 1200);
      };
      /* 手机长按会先弹系统菜单（iOS 的「拷贝/查询」），那一下会触发 touchcancel 把计时器清掉，
         所以必须屏蔽长按菜单与文字选中（配合 CSS 的 touch-callout / user-select），
         否则初始化入口在移动端等于不存在。 */
      brand.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      brand.addEventListener('mousedown', start);
      brand.addEventListener('touchstart', start, { passive: true });
      ['mouseup', 'mouseleave', 'touchend', 'touchcancel', 'touchmove'].forEach(function (ev) {
        brand.addEventListener(ev, stop, ev === 'touchmove' ? { passive: true } : undefined);
      });
      /* 长按仍被系统吃掉时的兜底：2.5 秒内连点 5 下 */
      var taps = [];
      brand.addEventListener('click', function () {
        var now = Date.now();
        taps.push(now);
        taps = taps.filter(function (t) { return now - t < 2500; });
        if (taps.length >= 5) { taps = []; trySetup(); }
      });
    }
    /* 登录页自检：手机上出问题时，不用猜也不用连电脑。
       把「地址 / 存储 / 账号数 / 缓存版本 / 浏览器」一次列清楚。 */
    if ($('btnAuthDiag')) {
      $('btnAuthDiag').onclick = async function () {
        var box = $('authDiag');
        if (!box.hidden && box.textContent) { box.hidden = true; return; }
        box.textContent = '正在自检…';
        box.hidden = false;
        var st = auth.status();
        var lines = [];
        lines.push('地址：' + location.origin + location.pathname + (location.hash || ''));
        lines.push('协议：' + location.protocol + (window.isSecureContext ? '（安全上下文）' : '（非安全上下文）'));
        lines.push('本地存储：' + (st.storageOk ? '可用' : '被禁止（读或写 localStorage 抛出异常）'));
        lines.push('账号数：' + st.count + (st.needSetup ? '（本站未初始化）' : ''));
        lines.push('登录状态：' + (st.loggedIn ? '已登录' : '未登录') + (st.lockLeft ? ' · 剩余锁定 ' + st.lockLeft + ' 秒' : ''));
        var reg = null;
        try {
          if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
            var regs = await navigator.serviceWorker.getRegistrations();
            reg = regs && regs[0];
          }
        } catch (e) { /* 忽略 */ }
        var ver = '未知';
        try {
          var res = await fetch('sw.js?probe=' + Date.now(), { cache: 'no-store' });
          var m = /VERSION\s*=\s*'([^']+)'/.exec(await res.text());
          if (m) ver = m[1];
        } catch (e) { /* 离线时取不到 */ }
        lines.push('离线缓存：' + (reg ? '已注册 · 缓存版本 ' + ver : '未注册') +
          (navigator.serviceWorker && navigator.serviceWorker.controller ? ' · 本页已受控' : ''));
        lines.push('页面代码：' + (document.querySelector('script[src*="app.js"]') || {}).getAttribute('src'));
        lines.push('浏览器：' + navigator.userAgent);
        box.textContent = lines.join('\n');
      };
    }
    $('btnAuthImport').onclick = function () { $('authImportFile').click(); };
    $('authImportFile').addEventListener('change', async function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var text = await file.text();
      this.value = '';
      var r = store.importJSON(text, 'replace');
      if (!r.ok) { authMsg(r.error, true); return; }
      fillSettings();
      showGate('login');
      authMsg('已恢复 ' + r.count + ' 条记录' +
        (r.accounts && r.accounts.ok ? '和 ' + r.accounts.count + ' 个账号' : '') + '，请用原密码登录', false);
    });
  }

  /* ---------- 账号管理（仅站长） ---------- */
  function renderMyAccount() {
    var c = auth.current();
    $('myAccount').innerHTML = c
      ? '<div class="ma-avatar"><svg class="ic"><use href="#i-user"/></svg></div>' +
        '<div class="ma-info"><strong>' + esc(c.name) + '</strong>' +
        '<span>@' + esc(c.username) + ' · <b>' + esc(c.roleName) + '</b></span>' +
        '<span class="muted">最近登录 ' + esc(c.lastLoginAt ? store.fmtTime(c.lastLoginAt) : '本次') + '</span></div>'
      : emptyHTML('未登录');
  }
  function accountCardHTML(a) {
    var me = auth.current() && auth.current().id === a.id;
    var badge = a.role === 'owner' ? 'tag-normal' : (a.role === 'operator' ? 'tag-warn' : 'tag-out');
    return '<div class="account-row' + (a.active ? '' : ' is-off') + '">' +
      '<div class="ar-avatar"><svg class="ic"><use href="#i-user"/></svg></div>' +
      '<div class="ar-main"><div class="ar-name">' + esc(a.name) +
      '<span class="tag ' + badge + '">' + esc(a.roleName) + '</span>' +
      (a.active ? '' : '<span class="tag tag-danger">已停用</span>') +
      (me ? '<span class="tag tag-out">当前账号</span>' : '') + '</div>' +
      '<div class="ar-meta">@' + esc(a.username) + ' · ' +
      (a.createdBy ? '由 ' + esc(a.createdBy) + ' 创建 · ' : '') +
      '最近登录 ' + esc(a.lastLoginAt ? store.fmtTime(a.lastLoginAt) : '从未') + '</div></div>' +
      '<div class="ar-actions">' +
      '<button class="btn btn-ghost btn-sm" data-perm="owner" data-account-act="edit" data-id="' + esc(a.id) + '">编辑</button>' +
      '<button class="btn btn-ghost btn-sm" data-perm="owner" data-account-act="reset" data-id="' + esc(a.id) + '">重置密码</button>' +
      (me ? '' : '<button class="btn btn-ghost btn-sm" data-perm="owner" data-account-act="toggle" data-id="' + esc(a.id) + '">' +
        (a.active ? '停用' : '启用') + '</button>' +
        '<button class="btn btn-ghost btn-sm danger" data-perm="owner" data-account-act="remove" data-id="' + esc(a.id) + '">删除</button>') +
      '</div></div>';
  }
  function renderAccounts() {
    renderMyAccount();
    var list = auth.list();
    $('acCount').textContent = '共 ' + list.length + ' 个账号';
    $('accountList').innerHTML = list.length ? list.map(accountCardHTML).join('') : emptyHTML('暂无账号');
  }
  function accountEditDialog(a) {
    return new Promise(function (resolve) {
      $('modalRoot').innerHTML = '<div class="modal-mask"><div class="modal">' +
        '<h3>编辑账号 · ' + esc(a.name) + '</h3><p>登录账号 @' + esc(a.username) + ' 不可修改。</p>' +
        '<div class="field"><label>显示姓名</label><input class="input" id="acEditName" value="' + esc(a.name) + '"></div>' +
        '<div class="field"><label>角色</label><select class="input" id="acEditRole"' + (a.role === 'owner' ? ' disabled' : '') + '>' +
        '<option value="owner"' + (a.role === 'owner' ? ' selected' : '') + '>站长（不可授予）</option>' +
        '<option value="operator"' + (a.role === 'operator' ? ' selected' : '') + '>操作员 · 入库出库改台账</option>' +
        '<option value="viewer"' + (a.role === 'viewer' ? ' selected' : '') + '>只读访客 · 仅查件看板</option>' +
        '</select></div>' +
        '<label class="switch"><input type="checkbox" id="acEditActive"' + (a.active ? ' checked' : '') +
        (a.role === 'owner' ? ' disabled' : '') + '><span>启用该账号（停用后不能登录）</span></label>' +
        '<div class="field"><label>重设密码（留空表示不改）</label><input class="input" id="acEditPass" type="password" placeholder="至少 6 位" autocomplete="new-password"></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" data-act="ok">保存</button></div></div></div>';
      var root = $('modalRoot');
      root.querySelector('[data-act="cancel"]').onclick = function () { closeModal(); resolve(null); };
      root.querySelector('[data-act="ok"]').onclick = function () {
        var patch = {
          name: $('acEditName').value,
          role: $('acEditRole').value,
          active: $('acEditActive').checked,
          password: $('acEditPass').value
        };
        closeModal(); resolve(patch);
      };
      root.querySelector('.modal-mask').onclick = function (e) { if (e.target === this) { closeModal(); resolve(null); } };
    });
  }
  function accountResetDialog(a) {
    return new Promise(function (resolve) {
      $('modalRoot').innerHTML = '<div class="modal-mask"><div class="modal">' +
        '<h3>重置密码 · ' + esc(a.name) + '</h3><p>设置后请线下告知本人，密码只以哈希形式保存。</p>' +
        '<div class="field"><label>新密码</label><input class="input" id="acResetPass" type="password" placeholder="至少 6 位" autocomplete="new-password"></div>' +
        '<div class="field"><label>确认新密码</label><input class="input" id="acResetConfirm" type="password" autocomplete="new-password"></div>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-act="cancel">取消</button>' +
        '<button class="btn btn-primary" data-act="ok">确认重置</button></div></div></div>';
      var root = $('modalRoot');
      root.querySelector('[data-act="cancel"]').onclick = function () { closeModal(); resolve(null); };
      root.querySelector('[data-act="ok"]').onclick = function () {
        var pw = $('acResetPass').value, cf = $('acResetConfirm').value;
        closeModal(); resolve(pw && pw === cf ? pw : null);
        if (pw !== cf) toast('两次输入的新密码不一致', 'err');
      };
      root.querySelector('.modal-mask').onclick = function (e) { if (e.target === this) { closeModal(); resolve(null); } };
    });
  }
  function bindAccounts() {
    $('btnUserMenu').onclick = function () {
      var c = auth.current();
      if (auth.can('owner')) switchView('accounts');
      else toast(c ? c.name + ' · ' + c.roleName + '（只读或操作权限）' : '未登录');
    };
    $('btnLogout').onclick = leaveApp;

    $('formAddSub').addEventListener('submit', function (e) {
      e.preventDefault();
      if (!guard('owner')) return;
      var r = auth.createSub({
        name: $('subName').value, username: $('subUser').value,
        password: $('subPass').value, role: $('subRole').value
      });
      if (!r.ok) { toast(r.error, 'err'); return; }
      this.reset();
      store.logEvent('account', '创建子账号 ' + r.account.name + '（' + r.account.roleName + '）');
      renderAccounts();
      toast('已创建子账号 ' + r.account.name + '（' + r.account.roleName + '）');
    });
    $('formChangePwd').addEventListener('submit', function (e) {
      e.preventDefault();
      var r = auth.changePassword($('oldPwd').value, $('newPwd').value, $('confirmPwd').value);
      if (!r.ok) { toast(r.error, 'err'); return; }
      this.reset();
      store.logEvent('account', '修改自己的登录密码');
      toast('密码已修改，请牢记新密码');
    });
    $('accountList').addEventListener('click', async function (e) {
      var b = e.target.closest('[data-account-act]');
      if (!b || !guard('owner')) return;
      var id = b.dataset.id, act = b.dataset.accountAct;
      var a = auth.list().find(function (x) { return x.id === id; });
      if (!a) return;
      var r = null;
      if (act === 'toggle') {
        r = auth.updateSub(id, { active: !a.active });
        if (r.ok) toast(a.active ? '已停用 ' + a.name : '已启用 ' + a.name);
      } else if (act === 'edit') {
        var patch = await accountEditDialog(a);
        if (patch) { r = auth.updateSub(id, patch); if (r.ok) toast('账号资料已更新'); }
      } else if (act === 'reset') {
        var pw = await accountResetDialog(a);
        if (pw) { r = auth.updateSub(id, { password: pw }); if (r.ok) toast('已重置 ' + a.name + ' 的密码'); }
      } else if (act === 'remove') {
        var ok = await confirmDialog('删除账号？', '账号 ' + a.name + ' 将被删除，历史流水里的操作人姓名会保留。', '确认删除', true);
        if (ok) { r = auth.removeSub(id); if (r.ok) toast('已删除账号 ' + a.name); }
      }
      if (r && !r.ok) toast(r.error, 'err');
      if (r && r.ok) {
        store.logEvent('account', ({ edit: '编辑账号资料', reset: '重置账号密码', toggle: '切换账号启用状态', remove: '删除账号' }[act] || '账号操作') + '：' + a.name);
      }
      renderAccounts();
    });
    $('btnAccountsExport').onclick = function () {
      if (!guard('owner')) return;
      downloadFile('accounts-' + dateStamp() + '.json', auth.exportAccounts(), 'application/json');
      toast('账号库已导出（含密码哈希，请妥善保管）');
    };
    $('btnAccountsImport').onclick = function () { $('acImportFile').click(); };
    $('acImportFile').addEventListener('change', async function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var text = await file.text();
      this.value = '';
      var ok = await confirmDialog('导入并覆盖账号库？', '本机现有账号会被备份文件里的账号替换，可能需要用备份中的密码重新登录。', '确认导入', true);
      if (!ok) return;
      var r = auth.importAccounts(text);
      if (!r.ok) { toast(r.error, 'err'); return; }
      if (!auth.current()) { leaveApp(); return; }
      enterApp();
      toast('已导入 ' + r.count + ' 个账号');
    });
  }

  /* ---------- 视图切换 ---------- */
  function switchView(name, opts) {
    if (!viewTitles[name]) name = 'dash';
    state.view = name;
    /* 地址栏 hash 跟随视图，便于桌面快捷方式、分享链接直达具体页面 */
    if (!(opts && opts.noHash)) syncHash(name);
    document.querySelectorAll('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === name); });
    document.querySelectorAll('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + name); });
    $('pageTitle').textContent = viewTitles[name][0];
    $('pageSub').textContent = viewTitles[name][1];
    $('checkoutBar').style.display = name === 'outbound' ? 'flex' : 'none';
    window.scrollTo({ top: 0, behavior: 'smooth' });
    if (name === 'inbound') setTimeout(function () { $('inTracking').focus(); }, 120);
    if (name === 'outbound') setTimeout(function () { $('outSearch').focus(); }, 120);
    if (name === 'lookup') setTimeout(function () { $('lookupKey').focus(); }, 120);
  }

  /* ---------- 渲染：公共 ---------- */
  function syncHash(name) {
    var h = '#' + name;
    if (location.hash === h) return;
    try { history.replaceState(null, '', h); } catch (e) { /* file:// 下可能不支持，忽略 */ }
  }
  function hashView() {
    var raw = String(location.hash || '').replace(/^#\/?/, '').trim();
    return viewTitles[raw] ? raw : '';
  }
  function renderHeader() {
    var s = store.settings();
    $('brandName').textContent = s.stationName;
    document.title = s.stationName + ' · 入库出库管理';
    var d = new Date();
    var week = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    $('todayText').textContent = d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 · 周' + week;
  }
  function kpiHTML(st) {
    var items = [
      { label: '今日入库', value: st.todayIn, foot: '件包裹已登记', tone: '' },
      { label: '今日出库', value: st.todayOut, foot: '件已取走', tone: 'tone-ok' },
      { label: '当前在库', value: st.inStock, foot: '容量 ' + st.capacity + ' 个货位', tone: '' },
      { label: '滞留件', value: st.warn + st.danger, foot: '其中严重超期 ' + st.danger + ' 件', tone: st.danger ? 'tone-danger' : (st.warn ? 'tone-warn' : '') }
    ];
    return items.map(function (i) {
      return '<div class="kpi ' + i.tone + '"><div class="k-label">' + i.label + '</div>' +
        '<div class="k-value">' + i.value + '</div><div class="k-foot">' + i.foot + '</div></div>';
    }).join('');
  }
  function trendSVG(data, large) {
    var W = 640, H = large ? 220 : 176;
    var left = 34, right = 12, top = 14, bottom = 28;
    var plotW = W - left - right, plotH = H - top - bottom;
    var max = 1;
    data.forEach(function (d) { max = Math.max(max, d.in, d.out); });
    max = Math.max(4, Math.ceil(max / 4) * 4);
    var grid = '';
    for (var g = 0; g <= 4; g++) {
      var y = top + plotH - plotH * g / 4;
      grid += '<line class="grid-line" x1="' + left + '" y1="' + y + '" x2="' + (W - right) + '" y2="' + y + '"/>' +
        '<text x="' + (left - 7) + '" y="' + (y + 3.5) + '" text-anchor="end">' + Math.round(max * g / 4) + '</text>';
    }
    var group = plotW / data.length, bw = Math.min(18, group * 0.26), gap = 4;
    var bars = '';
    data.forEach(function (d, i) {
      var gx = left + i * group + (group - (bw * 2 + gap)) / 2;
      var hIn = plotH * d.in / max, hOut = plotH * d.out / max;
      var yBase = top + plotH;
      bars += '<rect class="bar-in" x="' + gx + '" y="' + (yBase - hIn) + '" width="' + bw + '" height="' + hIn + '" rx="3"/>';
      bars += '<rect class="bar-out" x="' + (gx + bw + gap) + '" y="' + (yBase - hOut) + '" width="' + bw + '" height="' + hOut + '" rx="3"/>';
      if (d.in) bars += '<text x="' + (gx + bw / 2) + '" y="' + (yBase - hIn - 5) + '" text-anchor="middle">' + d.in + '</text>';
      if (d.out) bars += '<text x="' + (gx + bw * 1.5 + gap) + '" y="' + (yBase - hOut - 5) + '" text-anchor="middle">' + d.out + '</text>';
      bars += '<text x="' + (left + i * group + group / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(d.label) + '</text>';
    });
    return '<svg class="chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + grid + bars + '</svg>';
  }
  function barsHTML(rows, color, suffix) {
    if (!rows.length) return '<div class="empty">暂无在库包裹</div>';
    var max = Math.max.apply(null, rows.map(function (r) { return r.value; })) || 1;
    return rows.map(function (r) {
      return '<div class="bar-row"><div class="bar-name">' + esc(r.name) + '</div>' +
        '<div class="bar-track"><div class="bar-fill ' + (color || '') + '" style="width:' + (r.value / max * 100) + '%"></div></div>' +
        '<div class="bar-val">' + r.value + (suffix || '') + '</div></div>';
    }).join('');
  }
  function emptyHTML(text) {
    return '<div class="empty"><svg class="ic"><use href="#i-box"/></svg>' + esc(text) + '</div>';
  }
  function listItemHTML(p, side) {
    return '<div class="list-item"><div class="li-main"><div class="li-title">' + esc(p.trackingNo) +
      '</div><div class="li-sub">' + esc(p.carrier) + (p.pickupCode ? ' · 码 ' + esc(p.pickupCode) : '') +
      (p.recipient ? ' · ' + esc(p.recipient) : '') +
      (p.phoneTail ? ' · 尾号 ' + esc(p.phoneTail) : '') + '</div></div>' +
      '<span class="slot-chip">' + esc(p.slot || '未分配') + '</span>' +
      '<div class="li-side">' + side + '</div></div>';
  }

  /* ---------- 渲染：工作台 ---------- */
  function renderDash() {
    var st = store.stats();
    $('dashKpi').innerHTML = kpiHTML(st);
    $('dashTrend').innerHTML = trendSVG(st.last7, false);
    $('trendHint').textContent = '近 7 日入库 ' + st.last7.reduce(function (a, b) { return a + b.in; }, 0) + ' / 出库 ' + st.last7.reduce(function (a, b) { return a + b.out; }, 0);
    var overdue = store.listParcels({ status: 'in', sortBy: 'inAt', sortDir: 'asc' })
      .filter(function (p) { return p.overdueLevel !== 'normal'; }).slice(0, 6);
    $('dashOverdue').innerHTML = overdue.length ? overdue.map(function (p) {
      return listItemHTML(p, '<span class="tag ' + (p.overdueLevel === 'danger' ? 'tag-danger' : 'tag-warn') + '">滞留 ' + p.stayDays + ' 天</span>');
    }).join('') : emptyHTML('没有滞留包裹，很清爽');
    var recent = store.listParcels({ sortBy: 'inAt' }).slice(0, 6);
    $('dashRecent').innerHTML = recent.length ? recent.map(function (p) {
      return listItemHTML(p, '<span class="tag ' + (p.status === 'in' ? 'tag-normal' : 'tag-out') + '">' + (p.status === 'in' ? '在库' : '已取') + '</span>');
    }).join('') : emptyHTML('还没有包裹，去登记第一件吧');
  }

  /* ---------- 渲染：入库 ---------- */
  function fillSelect(el, values, keep) {
    var old = keep ? el.value : '';
    el.innerHTML = values.map(function (v) { return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
    if (old && values.indexOf(old) !== -1) el.value = old;
  }
  function renderInbound() {
    var s = store.settings();
    fillSelect($('inCarrier'), s.carriers, true);
    fillSelect($('inZone'), s.zones, true);
    fillSelect($('invCarrier'), ['全部公司'].concat(s.carriers), true);
    fillSelect($('invZone'), ['全部货架区'].concat(s.zones), true);
    if (!$('inSlot').value.trim() || !store.slotAvailable($('inSlot').value.trim())) {
      $('inSlot').value = store.suggestSlot($('inZone').value || s.zones[0]);
    }
    refreshCodePreview();
    var recent = store.listParcels({ sortBy: 'inAt' }).slice(0, 7);
    $('inRecent').innerHTML = recent.length ? recent.map(function (p) {
      return listItemHTML(p, store.fmtTime(p.inAt).slice(5));
    }).join('') : emptyHTML('暂无入库记录');
    $('inTodayCount').textContent = '今日 ' + store.stats().todayIn + ' 件';
  }
  function clearInForm(keepMeta) {
    $('inTracking').value = '';
    $('inRecipient').value = '';
    $('inPhone').value = '';
    $('inNote').value = '';
    $('inCount').value = '1';
    if (!keepMeta) { $('inCarrier').selectedIndex = 0; $('inZone').selectedIndex = 0; }
    $('inSlot').value = store.suggestSlot($('inZone').value || store.settings().zones[0]);
    $('inPickupCode').dataset.manual = '';
    refreshCodePreview(true);
    $('inTracking').focus();
  }

  /* ---------- 渲染：查件 ---------- */
  function lookupCardHTML(p) {
    var inStock = p.status === 'in';
    var tagCls = inStock
      ? (p.overdueLevel === 'danger' ? 'tag-danger' : (p.overdueLevel === 'warn' ? 'tag-warn' : 'tag-normal'))
      : 'tag-out';
    var tagText = inStock ? '在库 · 待取' + (p.overdueLevel !== 'normal' ? ' · 滞留' : '') : '已取出';
    var photoCount = (p.photos || []).length;
    return '<div class="lookup-card ' + (inStock ? 'is-in' : 'is-out') + '">' +
      '<div class="lc-top"><span class="tag ' + tagCls + '">' + tagText + '</span>' +
      '<span class="lc-carrier">' + esc(p.carrier) + '</span>' +
      '<button type="button" class="lc-copy" data-copy="' + esc(p.trackingNo) + '" title="复制运单号"><svg class="ic"><use href="#i-copy"/></svg></button></div>' +
      '<div class="lc-code"><svg class="ic"><use href="#i-ticket"/></svg><span>取件码</span>' +
      '<strong>' + esc(p.pickupCode || '—') + '</strong>' +
      (p.pickupCode ? '<button type="button" class="lc-code-copy" data-copy-code="' + esc(p.pickupCode) + '" title="复制取件码"><svg class="ic"><use href="#i-copy"/></svg></button>' : '') +
      '</div>' +
      '<div class="lc-no">' + esc(p.trackingNo) + '</div>' +
      '<div class="lc-slot"><div><span>货架位</span><strong>' + esc(p.slot || '未分配') + '</strong></div>' +
      '<span class="lc-stay">' + (inStock ? '已存放 ' + p.stayDays + ' 天' : '原货位') + '</span></div>' +
      '<div class="lc-grid">' +
      '<div><span>收件人</span><b>' + esc(p.recipient || '—') + '</b></div>' +
      '<div><span>手机尾号</span><b>' + esc(p.phoneTail || '—') + '</b></div>' +
      '<div><span>件数</span><b>' + p.count + '</b></div>' +
      '<div><span>' + (inStock ? '入库时间' : '出库时间') + '</span><b>' + esc(store.fmtTime(inStock ? p.inAt : (p.outAt || p.inAt))) + '</b></div>' +
      (inStock ? '' : '<div class="lc-wide"><span>取件人</span><b>' + esc(p.pickupBy || '本人') + '</b></div>') +
      (p.batchId ? '<div class="lc-wide"><span>出库批次</span><b><button type="button" class="link" data-batch="' + esc(p.batchId) + '">' + esc(p.batchId) + ' · 查同批</button></b></div>' : '') +
      '</div>' +
      (p.note ? '<div class="lc-note">备注：' + esc(p.note) + '</div>' : '') +
      '<div class="lc-foot"><span class="muted">' + (inStock ? '登记 ' + esc(p.operatorIn || '—') : '办理 ' + esc(p.operatorOut || '—')) + '</span>' +
      '<div class="btn-row">' +
      (photoCount ? '<button type="button" class="btn btn-ghost btn-sm" data-photos="' + esc(p.id) + '"><svg class="ic"><use href="#i-camera"/></svg>照片 ' + photoCount + '</button>' : '') +
      (inStock ? '<button type="button" class="btn btn-primary btn-sm" data-perm="write" data-lookup-out="' + esc(p.id) + '"><svg class="ic"><use href="#i-out"/></svg>去出库</button>' : '') +
      '</div></div></div>';
  }
  function renderLookup() {
    var kw = state.lookupKey.trim();
    var scope = $('lookupScope').value;
    var rows = kw ? store.lookup(kw, scope) : [];
    var st = store.stats();
    $('lookupStock').textContent = '当前在库 ' + st.inStock + ' 件';
    var summary = $('lookupSummary');
    var box = $('lookupResults');
    if (!kw) {
      summary.hidden = true;
      var recent = store.listParcels({ status: 'in', sortBy: 'inAt' }).slice(0, 6);
      var chips = recent.filter(function (p) { return p.phoneTail; }).map(function (p) {
        return '<button type="button" class="chip" data-quick="' + esc(p.phoneTail) + '">尾号 ' + esc(p.phoneTail) + '</button>';
      }).join('');
      box.innerHTML = '<div class="card lookup-empty">' + emptyHTML('输入取件码、手机号后四位、运单号或收件人开始查件；扫码枪扫面单会直接出结果。') +
        (chips ? '<div class="lookup-quick"><span class="muted">最近入库的尾号</span><div class="chip-row">' + chips + '</div></div>' : '') + '</div>';
      return;
    }
    var inCount = rows.filter(function (p) { return p.status === 'in'; }).length;
    summary.hidden = false;
    summary.innerHTML = '<strong>「' + esc(kw) + '」找到 ' + rows.length + ' 件</strong>' +
      '<span>在库 ' + inCount + ' 件 · 已取出 ' + (rows.length - inCount) + ' 件</span>' +
      (rows.length >= 60 ? '<span>仅显示最相关的 60 条，可补全单号缩小范围</span>' : '');
    box.innerHTML = rows.length ? rows.map(lookupCardHTML).join('')
      : '<div class="card lookup-empty">' + emptyHTML('没有匹配「' + kw + '」的包裹。请核对尾号，或在「范围」里切到全部记录（可能已被取走）。') + '</div>';
  }
  function goCheckout(id) {
    if (!guard('write')) return;
    var p = store.getDB().parcels.find(function (x) { return x.id === id; });
    if (!p || p.status !== 'in') { toast('该包裹已出库，请刷新查件结果', 'err'); renderLookup(); return; }
    state.selected = {};
    state.selected[id] = true;
    $('outSearch').value = p.pickupCode || p.trackingNo;
    state.outKeyword = p.pickupCode || p.trackingNo;
    switchView('outbound');
    renderAll();
    toast('已勾选 ' + p.trackingNo + '，拍照后确认出库');
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制 ' + text); })
        .catch(function () { toast('复制失败，请长按选择单号', 'err'); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制 ' + text); } catch (e) { toast('复制失败', 'err'); }
    document.body.removeChild(ta);
  }

  /* ---------- 渲染：出库 ---------- */
  function renderOutbound() {
    var kw = state.outKeyword.trim();
    var results = kw ? store.listParcels({ status: 'in', keyword: kw, sortBy: 'inAt' }) : [];
    $('outResultCount').textContent = kw
      ? (results.length ? '找到 ' + results.length + ' 件在库包裹' : '没有匹配的在库包裹')
      : '输入关键词开始查找在库包裹';
    $('outResults').innerHTML = !kw
      ? '<div class="card" style="grid-column:1/-1">' + emptyHTML('输入手机号后四位、运单号或收件人，支持跨多次搜索累加勾选') + '</div>'
      : (results.length ? results.map(function (p) {
        var sel = !!state.selected[p.id];
        var tagCls = p.overdueLevel === 'danger' ? 'tag-danger' : (p.overdueLevel === 'warn' ? 'tag-warn' : 'tag-normal');
        return '<div class="pick-card' + (sel ? ' selected' : '') + '" data-id="' + esc(p.id) + '">' +
          '<div class="pc-top"><div class="pc-no">' + esc(p.trackingNo) + '</div>' +
          '<div class="pc-check"><svg class="ic"><use href="#i-check"/></svg></div></div>' +
          '<div class="pc-meta"><span class="code-chip"><svg class="ic"><use href="#i-ticket"/></svg>' + esc(p.pickupCode || '无码') + '</span>' +
          '<span class="slot-chip">' + esc(p.slot || '未分配') + '</span>' +
          '<span>' + esc(p.carrier) + '</span>' +
          (p.recipient ? '<span>' + esc(p.recipient) + '</span>' : '') +
          (p.phoneTail ? '<span>尾号 ' + esc(p.phoneTail) + '</span>' : '') + '</div>' +
          '<div class="pc-foot"><span>' + esc(store.fmtTime(p.inAt)) + '</span>' +
          '<span class="tag ' + tagCls + '">在库 ' + p.stayDays + ' 天</span></div></div>';
      }).join('') : '<div class="card" style="grid-column:1/-1">' + emptyHTML('换个关键词试试，或确认包裹是否已出库') + '</div>');
    var n = Object.keys(state.selected).length;
    $('pickCount').textContent = n;
    $('mergeHint').hidden = n < 2;
    $('btnCheckout').disabled = n === 0 || !auth.can('write');
    $('btnCheckout').innerHTML = n > 1
      ? '<svg class="ic"><use href="#i-merge"/></svg>合并出库 ' + n + ' 件'
      : '<svg class="ic"><use href="#i-check"/></svg>确认出库';
  }

  /* ---------- 渲染：在库台账 ---------- */
  function renderInventory() {
    var filter = {
      keyword: $('invKeyword').value,
      carrier: $('invCarrier').value === '全部公司' ? '' : $('invCarrier').value,
      zone: $('invZone').value === '全部货架区' ? '' : $('invZone').value,
      status: $('invStatus').value,
      overdueLevel: $('invOverdue').value,
      sortBy: $('invSort').value === 'stayDays' ? 'stayDays' : $('invSort').value,
      sortDir: $('invSort').value === 'slot' ? 'asc' : 'desc'
    };
    var rows = store.listParcels(filter);
    var shown = rows.slice(0, state.invLimit);
    $('invCount').textContent = '共 ' + rows.length + ' 条记录' + (rows.length > shown.length ? '，已显示 ' + shown.length + ' 条' : '');
    $('invMore').hidden = rows.length <= shown.length;
    $('invBody').innerHTML = shown.length ? shown.map(function (p) {
      var tag = p.status === 'out' ? '<span class="tag tag-out">已出库</span>'
        : '<span class="tag ' + (p.overdueLevel === 'danger' ? 'tag-danger' : p.overdueLevel === 'warn' ? 'tag-warn' : 'tag-normal') + '">' +
          (p.overdueLevel === 'normal' ? '正常' : '滞留') + '</span>';
      return '<tr>' +
        '<td data-label="取件码"><span class="code-chip">' + esc(p.pickupCode || '—') + '</span>' +
          (p.batchId ? '<div class="td-sub">' + esc(p.batchId) + '</div>' : '') + '</td>' +
        '<td data-label="运单号" class="td-no">' + esc(p.trackingNo) +
          '<div class="td-sub">×' + p.count + (p.note ? ' · ' + esc(p.note) : '') + '</div>' +
          ((p.photos && p.photos.length) ? '<button class="photo-badge" data-photos="' + esc(p.id) + '"><svg class="ic"><use href="#i-camera"/></svg>' + p.photos.length + ' 张照片</button>' : '') +
          '</td>' +
        '<td data-label="公司">' + esc(p.carrier) + '</td>' +
        '<td data-label="收件人">' + esc(p.recipient || '—') + '<div class="td-sub">' + (p.phoneTail ? '尾号 ' + esc(p.phoneTail) : '无尾号') + '</div></td>' +
        '<td data-label="货架位"><span class="slot-chip">' + esc(p.slot || '—') + '</span></td>' +
        '<td data-label="入库">' + esc(store.fmtTime(p.inAt)) + (p.outAt ? '<div class="td-sub">取件 ' + esc(store.fmtTime(p.outAt)) + '</div>' : '') + '</td>' +
        '<td data-label="停留">' + p.stayDays + ' 天</td>' +
        '<td data-label="状态">' + tag + '</td>' +
        '<td data-label="操作" class="td-actions"><div class="row-actions">' +
        '<button class="icon-btn" data-perm="write" data-edit="' + esc(p.id) + '" title="修改"><svg class="ic"><use href="#i-edit"/></svg></button>' +
        '<button class="icon-btn danger" data-perm="write" data-del="' + esc(p.id) + '" title="删除"><svg class="ic"><use href="#i-trash"/></svg></button>' +
        '</div></td></tr>';
    }).join('') : '<tr><td colspan="9">' + emptyHTML('没有符合条件的记录') + '</td></tr>';
  }

  /* ---------- 渲染：统计 ---------- */
  function renderAnalytics() {
    var st = store.stats();
    $('anaKpi').innerHTML = kpiHTML(st);
    $('anaTrend').innerHTML = trendSVG(st.last7, true);
    $('anaCarrier').innerHTML = barsHTML(st.byCarrier, '', ' 件');
    $('anaZone').innerHTML = barsHTML(st.byZone, 'green', ' 件');
    $('anaCapacity').textContent = '已用 ' + st.inStock + ' / ' + st.capacity + ' 位';
    $('anaOverdue').innerHTML = barsHTML([
      { name: '0–2 天', value: st.overdueBuckets['0-2'] },
      { name: '3–6 天', value: st.overdueBuckets['3-6'] },
      { name: '7 天以上', value: st.overdueBuckets['7+'] }
    ], 'red', ' 件');
    var avg = st.avgStayHours;
    var avgText = avg ? (avg < 24 ? avg.toFixed(1) + ' 小时' : (avg / 24).toFixed(1) + ' 天') : '暂无已出库记录';
    var rate = st.todayIn + st.todayOut ? Math.round(st.todayOut / (st.todayIn + st.todayOut) * 100) : 0;
    $('anaSummary').innerHTML =
      '<div>当前在库 <b>' + st.inStock + '</b> 件，占全部货位的 <b>' + (st.capacity ? Math.round(st.inStock / st.capacity * 100) : 0) + '%</b>。</div>' +
      '<div>今日出库 / 今日流转占比 <b>' + rate + '%</b>，平均取件时长 <b>' + avgText + '</b>。</div>' +
      '<div>滞留提醒线 <b>' + store.settings().warnDays + ' 天</b>，严重超期线 <b>' + store.settings().dangerDays + ' 天</b>；当前超期 <b>' + st.danger + '</b> 件，建议先联系收件人。</div>' +
      '<div>近 7 日累计入库 <b>' + st.last7.reduce(function (a, b) { return a + b.in; }, 0) + '</b> 件，出库 <b>' + st.last7.reduce(function (a, b) { return a + b.out; }, 0) + '</b> 件。</div>';
  }

  /* ---------- 渲染：流水 ---------- */
  function renderLogs() {
    var rows = store.listLogs({ type: $('logType').value, keyword: $('logKeyword').value });
    $('logCount').textContent = '共 ' + rows.length + ' 条流水（最多保留 3000 条）';
    var db = store.getDB();
    $('logList').innerHTML = rows.length ? rows.slice(0, 300).map(function (l) {
      var p = l.parcelId ? db.parcels.find(function (x) { return x.id === l.parcelId; }) : null;
      var canRestore = l.type === 'out' && p && p.status === 'out';
      var batchCount = l.batchId ? db.parcels.filter(function (x) {
        return x.status === 'out' && x.batchId === l.batchId;
      }).length : 0;
      var btn = (l.batchId && batchCount > 0)
        ? '<button class="btn btn-outline btn-sm" data-perm="write" data-restore-batch="' + esc(l.batchId) + '"><svg class="ic"><use href="#i-merge"/></svg>' +
          (batchCount > 1 ? '整批撤销 ' + batchCount + ' 件' : '撤销剩余 1 件') + '</button>'
        : (canRestore ? '<button class="btn btn-ghost btn-sm" data-perm="write" data-restore="' + esc(l.parcelId) + '">撤销出库</button>' : '');
      return '<div class="log-item"><div class="log-time">' + esc(store.fmtTime(l.at)) + '</div>' +
        '<span class="log-badge t-' + esc(l.type) + '">' + esc(store.logTypeName(l.type)) + '</span>' +
        (l.actor ? '<span class="log-actor">' + esc(l.actor) + '</span>' : '') +
        '<div class="log-text">' + esc(l.summary) + '</div>' + btn + '</div>';
    }).join('') : emptyHTML('暂无操作流水');
  }

  /* ---------- 渲染：设置与同步 ---------- */
  function fillSettings() {
    var s = store.settings();
    $('setName').value = s.stationName;
    $('setOperator').value = s.operator;
    $('setWarn').value = s.warnDays;
    $('setDanger').value = s.dangerDays;
    $('setCarriers').value = s.carriers.join(', ');
    $('setZones').value = s.zones.join(', ');
    $('setShelves').value = s.shelvesPerZone;
    $('setLevels').value = s.levelsPerShelf;
    $('setCodeMode').value = s.codeMode;
    var c = sync.config();
    $('syncToken').value = c.token;
    $('syncRepo').value = c.repo;
    $('syncBranch').value = c.branch;
    $('syncPath').value = c.path;
    $('syncAuto').checked = !!c.auto;
    renderSyncState();
    fillPhotoSettings();
  }
  function renderSyncState() {
    $('syncState').textContent = sync.state();
    var c = sync.config();
    $('storeMode').textContent = (c.auto && sync.isConfigured()) ? '数据同步到 GitHub 仓库' : '数据存于本机浏览器';
  }
  function renderAll() {
    renderHeader();
    renderDash();
    renderLookup();
    renderInbound();
    renderOutbound();
    renderInventory();
    renderAnalytics();
    renderLogs();
    if (auth.can('owner')) renderAccounts();
    renderSyncState();
    renderPhotoStatus();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    /* 捕获阶段统一拦截越权操作：按钮与表单上标注 data-perm，静态页面也能做角色隔离 */
    document.addEventListener('click', function (e) {
      var t = e.target && e.target.closest && e.target.closest('[data-perm]');
      if (!t || !auth.current()) return;
      if (!auth.can(t.dataset.perm)) {
        e.preventDefault(); e.stopPropagation();
        toast('当前账号（' + auth.current().roleName + '）没有此操作权限', 'err');
      }
    }, true);
    document.addEventListener('submit', function (e) {
      var f = e.target && e.target.closest && e.target.closest('form[data-perm]');
      if (!f || !auth.current()) return;
      if (!auth.can(f.dataset.perm)) {
        e.preventDefault(); e.stopPropagation();
        toast('当前账号（' + auth.current().roleName + '）没有此操作权限', 'err');
      }
    }, true);

    $('nav').addEventListener('click', function (e) {
      var b = e.target.closest('.nav-item');
      if (b) switchView(b.dataset.view);
    });
    document.addEventListener('click', function (e) {
      var g = e.target.closest('[data-goto]');
      if (g) switchView(g.dataset.goto);
    });
    $('btnQuickIn').onclick = function () { switchView('inbound'); };
    /* 浏览器前进/后退或外部改 hash 时同步视图（未登录时忽略，登录后再按 hash 落位） */
    window.addEventListener('hashchange', function () {
      if (!auth.current()) return;
      var v = hashView();
      if (v && v !== state.view) switchView(v, { noHash: true });
    });

    /* 查件（工作台快捷入口 + 独立查件页） */
    function quickLookup() {
      var v = $('quickLookup').value.trim();
      if (v) { $('lookupKey').value = v; state.lookupKey = v; }
      switchView('lookup');
      renderLookup();
      $('lookupKey').focus();
    }
    $('btnQuickLookup').onclick = quickLookup;
    $('quickLookup').addEventListener('keydown', function (e) { if (e.key === 'Enter') quickLookup(); });
    $('lookupKey').addEventListener('input', function () {
      state.lookupKey = this.value;
      renderLookup();
    });
    $('lookupKey').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { this.select(); renderLookup(); }
    });
    $('btnLookup').onclick = function () { state.lookupKey = $('lookupKey').value; renderLookup(); $('lookupKey').focus(); };
    $('lookupScope').addEventListener('change', renderLookup);
    $('lookupClear').onclick = function () {
      $('lookupKey').value = ''; state.lookupKey = ''; renderLookup(); $('lookupKey').focus();
    };
    $('lookupResults').addEventListener('click', function (e) {
      var q = e.target.closest('[data-quick]');
      if (q) {
        $('lookupKey').value = q.dataset.quick; state.lookupKey = q.dataset.quick;
        renderLookup(); $('lookupKey').focus(); return;
      }
      var pv = e.target.closest('[data-photos]');
      if (pv) { openPhotoViewer(pv.dataset.photos); return; }
      var go = e.target.closest('[data-lookup-out]');
      if (go) { goCheckout(go.dataset.lookupOut); return; }
      var cc = e.target.closest('[data-copy-code]');
      if (cc) { copyText(cc.dataset.copyCode); return; }
      var bt = e.target.closest('[data-batch]');
      if (bt) {
        $('lookupKey').value = bt.dataset.batch;
        state.lookupKey = bt.dataset.batch;
        $('lookupScope').value = '';
        renderLookup();
        $('lookupKey').focus();
        return;
      }
      var cp = e.target.closest('[data-copy]');
      if (cp) { copyText(cp.dataset.copy); return; }
    });

    /* 入库 */
    $('formIn').addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!guard('write')) return;
      var btn = $('formIn').querySelector('button[type="submit"]');
      var tn = $('inTracking').value.trim();
      var exists = store.getDB().parcels.some(function (p) {
        return p.status === 'in' && p.trackingNo.toUpperCase() === tn.toUpperCase();
      });
      if (exists) { toast('该运单号已在库，请先核对', 'err'); $('inTracking').select(); return; }
      btn.disabled = true;
      var pr = await savePhotos(state.inFiles, 'inbound');
      var res = store.addParcel({
        trackingNo: tn,
        carrier: $('inCarrier').value,
        recipient: $('inRecipient').value,
        phoneTail: $('inPhone').value,
        slot: $('inSlot').value,
        count: $('inCount').value,
        note: $('inNote').value,
        pickupCode: $('inPickupCode').value,
        photos: pr.items
      });
      btn.disabled = false;
      if (!res.ok) { toast(res.error, 'err'); $('inTracking').select(); return; }
      state.lastParcel = res.parcel;
      $('lastIn').hidden = false;
      $('lastIn').innerHTML = '<div class="li-ok">已入库 <strong>' + esc(res.parcel.trackingNo) + '</strong> → 货架位 <strong>' + esc(res.parcel.slot) + '</strong>' +
        (pr.items.length ? '，照片 ' + pr.items.length + ' 张' : '') + '，继续扫下一件</div>' +
        (res.parcel.pickupCode ? '<div class="code-hero"><span>取件码</span><strong>' + esc(res.parcel.pickupCode) + '</strong>' +
          '<button type="button" class="btn btn-ghost btn-sm" data-copy-code="' + esc(res.parcel.pickupCode) + '"><svg class="ic"><use href="#i-copy"/></svg>复制</button>' +
          '<button type="button" class="btn btn-outline btn-sm" data-print-label="1"><svg class="ic"><use href="#i-print"/></svg>打印标签</button></div>' : '');
      clearInForm(true);
      clearFiles('in');
      afterWrite('入库成功 · ' + res.parcel.slot);
      reportPhotoResult(pr);
      $('inTracking').focus();
    });
    $('btnInCamera').onclick = function () { takePhoto('in'); };
    $('btnInPhotos').onclick = function () { $('inPhotos').removeAttribute('capture'); $('inPhotos').click(); };
    $('inPhotos').addEventListener('change', function () { addFiles('in', this.files); this.value = ''; });
    $('inPhotoPreview').addEventListener('click', function (e) {
      var b = e.target.closest('[data-remove]');
      if (!b) return;
      state.inFiles.splice(Number(b.dataset.remove), 1);
      renderFilePreview('inPhotoPreview', state.inFiles, inPreviewUrls, true);
      renderPhotoStatus();
    });
    $('lastIn').addEventListener('click', function (e) {
      var cp = e.target.closest('[data-copy-code]');
      if (cp) { copyText(cp.dataset.copyCode); return; }
      if (e.target.closest('[data-print-label]') && state.lastParcel) printLabelDialog(state.lastParcel);
    });
    $('inPickupCode').addEventListener('input', function () { this.dataset.manual = '1'; });
    $('inSlot').addEventListener('input', function () { refreshCodePreview(); });
    $('btnRecode').onclick = function () { refreshCodePreview(true); toast('取件码已按当前货架位重算'); };
    $('btnReslot').onclick = function () {
      $('inSlot').value = store.suggestSlot($('inZone').value || store.settings().zones[0]);
      refreshCodePreview();
      $('inTracking').focus();
    };
    $('inZone').onchange = function () {
      $('inSlot').value = store.suggestSlot(this.value);
      refreshCodePreview();
    };

    /* 出库 */
    $('outSearch').addEventListener('input', function () {
      state.outKeyword = this.value;
      renderOutbound();
    });
    $('outSearch').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && Object.keys(state.selected).length) doCheckout();
    });
    $('outResults').addEventListener('click', function (e) {
      var card = e.target.closest('.pick-card');
      if (!card) return;
      var id = card.dataset.id;
      if (state.selected[id]) delete state.selected[id]; else state.selected[id] = true;
      renderOutbound();
    });
    $('outSelectAll').onclick = function () {
      var rows = state.outKeyword.trim() ? store.listParcels({ status: 'in', keyword: state.outKeyword.trim() }) : [];
      rows.forEach(function (p) { state.selected[p.id] = true; });
      renderOutbound();
      if (rows.length) toast('已选中本次搜索的 ' + rows.length + ' 件');
    };
    $('outClear').onclick = function () {
      $('outSearch').value = ''; state.outKeyword = '';
      state.selected = {}; clearFiles('proof'); renderOutbound(); $('outSearch').focus();
    };
    $('outClearSel').onclick = function () {
      state.selected = {}; renderOutbound();
    };
    $('btnProof').onclick = function () { takePhoto('proof'); };
    $('btnProofPick').onclick = function () { $('outProof').removeAttribute('capture'); $('outProof').click(); };
    $('outProof').addEventListener('change', function () { addFiles('proof', this.files); this.value = ''; });
    $('btnCheckout').onclick = doCheckout;

    /* 在库台账 */
    ['invKeyword', 'invCarrier', 'invZone', 'invStatus', 'invOverdue', 'invSort'].forEach(function (id) {
      var el = $(id);
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () {
        state.invLimit = 50; renderInventory();
      });
    });
    $('btnInvMore').onclick = function () { state.invLimit += 50; renderInventory(); };
    $('btnInvExport').onclick = function () {
      downloadFile('包裹台账-' + dateStamp() + '.csv', store.exportCSV($('invStatus').value === 'in' ? 'instock' : 'all'), 'text/csv;charset=utf-8');
      toast('台账已导出');
    };
    $('invBody').addEventListener('click', async function (e) {
      var pv = e.target.closest('[data-photos]');
      if (pv) { openPhotoViewer(pv.dataset.photos); return; }
      var ed = e.target.closest('[data-edit]');
      var del = e.target.closest('[data-del]');
      if ((ed || del) && !guard('write')) return;
      if (ed) {
        var p = store.getDB().parcels.find(function (x) { return x.id === ed.dataset.edit; });
        if (!p) return;
        var patch = await editDialog(p);
        if (!patch) return;
        var r = store.updateParcel(p.id, patch);
        if (!r.ok) toast(r.error, 'err'); else afterWrite('资料已更新');
      }
      if (del) {
        var item = store.getDB().parcels.find(function (x) { return x.id === del.dataset.del; });
        if (!item) return;
        var ok = await confirmDialog('删除这条记录？', '将永久删除 ' + item.trackingNo + ' 的包裹记录，此操作不可撤销。建议先导出备份。', '确认删除', true);
        if (!ok) return;
        store.removeParcel(item.id);
        afterWrite('记录已删除');
      }
    });

    /* 流水 */
    $('logKeyword').addEventListener('input', renderLogs);
    $('logType').addEventListener('change', renderLogs);
    $('btnLogExport').onclick = function () {
      downloadFile('操作流水-' + dateStamp() + '.csv', store.exportCSV('logs'), 'text/csv;charset=utf-8');
      toast('流水已导出');
    };
    $('btnLogClear').onclick = async function () {
      var ok = await confirmDialog('清空操作流水？', '所有历史动作记录将被删除，包裹台账不受影响。建议先导出流水 CSV。', '确认清空', true);
      if (!ok) return;
      store.clearLogs(); renderLogs(); toast('流水已清空');
    };
    $('logList').addEventListener('click', function (e) {
      if (!e.target.closest('[data-restore-batch]') && !e.target.closest('[data-restore]')) return;
      if (!guard('write')) return;
      var bb = e.target.closest('[data-restore-batch]');
      if (bb) {
        var rb = store.restoreBatch(bb.dataset.restoreBatch);
        if (!rb.ok) toast(rb.error, 'err');
        else afterWrite('整批撤销 ' + rb.count + ' 件，已恢复在库');
        return;
      }
      var b = e.target.closest('[data-restore]');
      if (!b) return;
      var r = store.restoreParcel(b.dataset.restore);
      if (!r.ok) toast(r.error, 'err'); else afterWrite('已撤销出库，包裹恢复在库');
    });

    /* 图片存储 */
    $('phMode').addEventListener('change', togglePhotoBoxes);
    $('phProvider').addEventListener('change', function () { refreshProviderUI(true); });
    ['phBase', 'phProxyBase'].forEach(function (id) {
      $(id).addEventListener('input', function () { refreshProviderUI(false); });
    });
    $('btnGhFromSync').onclick = function () {
      var s = (typeof StationSync !== 'undefined' && StationSync) ? StationSync.config() : null;
      if (!s || !s.repo) { toast('「GitHub 同步」里还没填仓库，先在下面填 token 和 owner/repo', 'err'); return; }
      $('ghRepo').value = s.repo;
      $('ghBranch').value = s.branch || 'main';
      if (!$('ghDir').value.trim()) $('ghDir').value = 'photos';
      $('phMode').value = 'github';
      togglePhotoBoxes();
      savePhotoForm();
      toast('已取用 ' + s.repo + ' @ ' + (s.branch || 'main') + '，点「测试连接」确认能写');
    };
    $('btnGhClearCache').onclick = async function () {
      var r = await photos.clearCache();
      renderCacheState();
      toast(r.ok ? '已清空照片缓存，下次打开会重新从 GitHub 拉' : ('清除失败：' + r.error), r.ok ? 'ok' : 'err');
    };
    $('ghCache').onchange = function () {
      savePhotoForm();
      renderCacheState();
      toast($('ghCache').checked ? '已开启本机缓存' : '已关闭本机缓存：每张照片都会重新下载');
    };
    $('btnPhPick').onclick = async function () {
      var r = await photos.pickDirectory();
      renderPhotoStatus();
      toast(r.ok ? r.message : r.error, r.ok ? 'ok' : 'err');
    };
    /* 123 云盘砍掉 WebDAV 后的三条退路，点一下就把表单切过去 */
    $('btnUseNutstore').onclick = function () {
      $('phMode').value = 'webdav';
      $('phProvider').value = 'nutstore';
      togglePhotoBoxes();
      refreshProviderUI(true);
      $('phProviderRoute').scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast('已切到坚果云：填注册邮箱 + 应用密码，再填 Worker 地址后点「测试连接」');
    };
    $('btnUseLocal').onclick = function () {
      $('phMode').value = 'local';
      togglePhotoBoxes();
      renderPhotoStatus();
      toast('已切到本机文件夹：点「选择本机文件夹」，选 123 云盘客户端挂载的盘符目录（选择器里看不到就改用坚果云）');
    };
    $('btnUseBrowser').onclick = function () {
      $('phMode').value = 'browser';
      togglePhotoBoxes();
      renderPhotoStatus();
      toast('已切到浏览器暂存：照片只在当前设备，换设备不跟随');
    };
    $('btnPhSave').onclick = function () {
      savePhotoForm();
      toast('图片存储设置已保存');
    };
    $('btnPhTest').onclick = async function () {
      savePhotoForm();
      toast('正在测试图片存储…');
      var r = await photos.test();
      renderPhotoStatus();
      toast(r.ok ? r.message : r.error, r.ok ? 'ok' : 'err');
    };

    /* 设置 */
    $('formSettings').addEventListener('submit', function (e) {
      e.preventDefault();
      var warn = Number($('setWarn').value), danger = Number($('setDanger').value);
      if (danger <= warn) { toast('严重超期天数要大于滞留提醒天数', 'err'); return; }
      var split = function (v) { return v.split(/[,，、]/).map(function (x) { return x.trim(); }).filter(Boolean); };
      var carriers = split($('setCarriers').value), zones = split($('setZones').value);
      if (!carriers.length || !zones.length) { toast('快递公司和货架区至少各填一项', 'err'); return; }
      store.updateSettings({
        stationName: $('setName').value.trim(), operator: $('setOperator').value.trim(),
        warnDays: warn, dangerDays: danger, carriers: carriers, zones: zones,
        shelvesPerZone: Number($('setShelves').value), levelsPerShelf: Number($('setLevels').value),
        codeMode: $('setCodeMode').value
      });
      afterWrite('设置已保存');
    });

    /* 数据管理 */
    document.querySelectorAll('[data-export]').forEach(function (b) {
      b.onclick = function () {
        var kind = b.dataset.export;
        if (kind === 'json') {
          downloadFile('驿站备份-' + dateStamp() + '.json', store.exportJSON(), 'application/json;charset=utf-8');
          toast('全量备份已导出');
        } else {
          var names = { all: '全部包裹', instock: '在库件', logs: '操作流水' };
          downloadFile(names[kind] + '-' + dateStamp() + '.csv', store.exportCSV(kind), 'text/csv;charset=utf-8');
          toast(names[kind] + '已导出');
        }
      };
    });
    $('btnImport').onclick = function () { $('importFile').click(); };
    $('importFile').addEventListener('change', async function () {
      var file = this.files && this.files[0];
      if (!file) return;
      var text = await file.text();
      var mode = $('importMode').value;
      if (mode === 'replace') {
        var ok = await confirmDialog('覆盖现有数据？', '当前浏览器里的全部包裹和流水会被备份文件替换，此操作不可撤销。', '确认覆盖', true);
        if (!ok) { this.value = ''; return; }
      }
      var r = store.importJSON(text, mode);
      this.value = '';
      if (!r.ok) toast(r.error, 'err');
      else {
        fillSettings();
        afterWrite('导入完成，处理 ' + r.count + ' 条记录' +
          (r.accounts && r.accounts.ok ? ' · 账号库已恢复' : ''));
        /* 备份里的账号库替换了本机账号，需要重新登录 */
        if (!auth.current()) showGate('login');
      }
    });
    $('btnClearAll').onclick = async function () {
      var ok = await confirmDialog('清空全部数据？', '所有包裹、流水和设置都会恢复到初始状态，此操作不可撤销。请务必先导出 JSON 备份。', '我确认清空', true);
      if (!ok) return;
      store.clearAll(); fillSettings(); afterWrite('数据已清空');
    };
    $('btnDemo').onclick = async function () {
      var ok = await confirmDialog('载入演示数据？', '会写入一批示例包裹用于预览统计效果，可在用完后再清空。', '载入演示', false);
      if (!ok) return;
      var r = store.seedDemo();
      if (!r.ok) toast(r.error, 'err'); else afterWrite('已载入 ' + r.count + ' 条演示数据');
    };

    /* GitHub 同步 */
    function readSyncInputs() {
      return sync.saveConfig({
        token: $('syncToken').value.trim(), repo: $('syncRepo').value.trim(),
        branch: $('syncBranch').value.trim(), path: $('syncPath').value.trim(),
        auto: $('syncAuto').checked
      });
    }
    $('btnSyncSave').onclick = function () {
      var c = readSyncInputs();
      $('syncRepo').value = c.repo; $('syncBranch').value = c.branch; $('syncPath').value = c.path;
      renderSyncState(); toast('同步配置已保存在本机浏览器');
    };
    $('btnSyncTest').onclick = async function () {
      readSyncInputs();
      if (!sync.isConfigured()) { toast('请先填写 token 和仓库', 'err'); return; }
      toast('正在连接 GitHub…');
      var r = await sync.test();
      renderSyncState(); toast(r.ok ? r.message : r.error, r.ok ? 'ok' : 'err');
    };
    $('btnSyncPush').onclick = async function () {
      readSyncInputs();
      if (!sync.isConfigured()) { toast('请先填写 token 和仓库', 'err'); return; }
      toast('正在上传…');
      var r = await sync.push(store.exportJSON());
      renderSyncState(); toast(r.ok ? r.message : r.error, r.ok ? 'ok' : 'err');
    };
    $('btnSyncPull').onclick = async function () {
      readSyncInputs();
      if (!sync.isConfigured()) { toast('请先填写 token 和仓库', 'err'); return; }
      var ok = await confirmDialog('拉取并覆盖本机数据？', '远端仓库里的台账会覆盖当前浏览器的全部包裹与流水，请先导出备份。', '确认拉取', true);
      if (!ok) return;
      toast('正在拉取…');
      var r = await sync.pull();
      if (!r.ok) { renderSyncState(); toast(r.error, 'err'); return; }
      var imp = store.importJSON(r.text, 'replace');
      renderSyncState();
      if (!imp.ok) toast(imp.error, 'err');
      else {
        fillSettings();
        afterWrite('已拉取 ' + imp.count + ' 条记录' +
          (imp.accounts && imp.accounts.ok ? ' · 账号库已同步' : ''));
        if (!auth.current()) showGate('login');
      }
    };
  }

  /* 出库留证：开启「必须拍凭证」且尚未拍照时，自动调起摄像头，拍完继续出库 */
  async function ensureProof() {
    if (state.proofFiles.length) return true;
    if (!photos.config().requireProof) return true;
    if (!camera || !camera.supported()) {
      toast('已开启「出库必须拍凭证」，请先点「拍取件凭证」；也可到设置里关闭', 'err');
      return false;
    }
    var files = await camera.open({ single: true, title: '取件凭证 · 拍照后自动出库' });
    if (camera.lastError) toast(camera.lastError, 'err');
    if (!files || !files.length) { toast('未拍照，已取消出库', 'err'); return false; }
    addFiles('proof', files);
    return true;
  }

  async function doCheckout() {
    if (!guard('write')) return;
    var ids = Object.keys(state.selected);
    if (!ids.length) { toast('请先选择包裹', 'err'); return; }
    if (!(await ensureProof())) return;
    var btn = $('btnCheckout');
    btn.disabled = true;
    var pr = await savePhotos(state.proofFiles, 'pickup');
    var r = store.checkout(ids, $('pickupBy').value, pr.items);
    btn.disabled = false;
    if (!r.ok) { toast(r.error, 'err'); renderOutbound(); return; }
    state.selected = {};
    $('pickupBy').value = '';
    $('outSearch').value = ''; state.outKeyword = '';
    clearFiles('proof');
    afterWrite((r.merged ? '合并出库 ' : '已出库 ') + r.count + ' 件 · 批次 ' + r.batchId +
      (pr.items.length ? ' · 共用凭证 ' + pr.items.length + ' 张' : ''));
    reportPhotoResult(pr);
    $('outSearch').focus();
  }

  function init() {
    /* 账号库随台账 JSON 备份 / GitHub 同步一起迁移 */
    store.registerAccountsProvider(auth);
    bind();            /* 事件只绑定一次，登录/退出只切换门与重新渲染 */
    bindAuth();
    bindIdle();
    bindAccounts();
    fillSettings();
    if (auth.current()) enterApp();
    else showGate(wantSetup() ? 'setup' : 'login');
    /* 恢复本地目录句柄放后台：IndexedDB 不可用时也不能拖住登录与业务界面 */
    photos.init().catch(function () { /* 照片模块会回退到 WebDAV / 浏览器暂存 */ });
  }
  init();
})();
