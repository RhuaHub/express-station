/* 快递驿站 - 界面与交互 */
(function () {
  'use strict';

  var store = StationStore.createStore(localStorage);
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
    settings: ['设置与数据', '驿站参数、备份导出与 GitHub 同步']
  };
  var state = { view: 'dash', selected: {}, invLimit: 50, outKeyword: '', lookupKey: '', inFiles: [], proofFiles: [] };
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
        '<div class="field-row"><div class="field"><label>货架位</label><input class="input" id="edSlot" value="' + esc(p.slot) + '"></div>' +
        '<div class="field"><label>备注</label><input class="input" id="edNote" value="' + esc(p.note) + '"></div></div>' +
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
        closeModal(); resolve(patch);
      };
      root.querySelector('.modal-mask').onclick = function (e) { if (e.target === this) { closeModal(); resolve(null); } };
    });
  }
  function downloadFile(name, text, mime) {
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
  function afterWrite(msg, type) {
    if (msg) toast(msg, type);
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
      try { r = await photos.put(files[i]); }
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
    $('phWebdavBox').hidden = m !== 'webdav';
    $('phLocalBox').hidden = m !== 'local';
  }
  function fillPhotoSettings() {
    var c = photos.config();
    $('phMode').value = c.mode;
    $('phDir').value = c.dirName;
    $('phBase').value = c.webdav.baseUrl;
    $('phUser').value = c.webdav.user;
    $('phPass').value = c.webdav.pass;
    $('phProxyKey').value = c.webdav.proxyKey;
    $('phMax').value = c.maxSide;
    $('phQuality').value = c.quality;
    $('phRequireProof').checked = c.requireProof !== false;
    togglePhotoBoxes();
    renderPhotoStatus();
  }
  function savePhotoForm() {
    photos.saveConfig({
      mode: $('phMode').value,
      dirName: $('phDir').value.trim(),
      webdav: {
        baseUrl: $('phBase').value.trim(),
        user: $('phUser').value,
        pass: $('phPass').value,
        proxyKey: $('phProxyKey').value.trim()
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
      '<p>图片保存在阿里云盘。移除只删台账里的引用，云盘文件本身保留。</p>' +
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
    p.photos.forEach(function (ph, idx) {
      var box = grid.children[idx] && grid.children[idx].querySelector('[data-img]');
      if (!box) return;
      photos.getUrl(ph.ref).then(function (url) {
        viewerUrls.push(url);
        box.innerHTML = '<img src="' + url + '" alt="照片">';
      }).catch(function (e) {
        box.textContent = e.message || '读取失败';
      });
    });
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

  /* ---------- 视图切换 ---------- */
  function switchView(name) {
    if (!viewTitles[name]) name = 'dash';
    state.view = name;
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
      '</div><div class="li-sub">' + esc(p.carrier) + (p.recipient ? ' · ' + esc(p.recipient) : '') +
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
      '<div class="lc-no">' + esc(p.trackingNo) + '</div>' +
      '<div class="lc-slot"><div><span>货架位</span><strong>' + esc(p.slot || '未分配') + '</strong></div>' +
      '<span class="lc-stay">' + (inStock ? '已存放 ' + p.stayDays + ' 天' : '原货位') + '</span></div>' +
      '<div class="lc-grid">' +
      '<div><span>收件人</span><b>' + esc(p.recipient || '—') + '</b></div>' +
      '<div><span>手机尾号</span><b>' + esc(p.phoneTail || '—') + '</b></div>' +
      '<div><span>件数</span><b>' + p.count + '</b></div>' +
      '<div><span>' + (inStock ? '入库时间' : '出库时间') + '</span><b>' + esc(store.fmtTime(inStock ? p.inAt : (p.outAt || p.inAt))) + '</b></div>' +
      (inStock ? '' : '<div class="lc-wide"><span>取件人</span><b>' + esc(p.pickupBy || '本人') + '</b></div>') +
      '</div>' +
      (p.note ? '<div class="lc-note">备注：' + esc(p.note) + '</div>' : '') +
      '<div class="lc-foot"><span class="muted">' + (inStock ? '登记 ' + esc(p.operatorIn || '—') : '办理 ' + esc(p.operatorOut || '—')) + '</span>' +
      '<div class="btn-row">' +
      (photoCount ? '<button type="button" class="btn btn-ghost btn-sm" data-photos="' + esc(p.id) + '"><svg class="ic"><use href="#i-camera"/></svg>照片 ' + photoCount + '</button>' : '') +
      (inStock ? '<button type="button" class="btn btn-primary btn-sm" data-lookup-out="' + esc(p.id) + '"><svg class="ic"><use href="#i-out"/></svg>去出库</button>' : '') +
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
      box.innerHTML = '<div class="card lookup-empty">' + emptyHTML('输入手机号后四位、运单号或收件人开始查件；扫码枪扫面单会直接出结果。') +
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
    var p = store.getDB().parcels.find(function (x) { return x.id === id; });
    if (!p || p.status !== 'in') { toast('该包裹已出库，请刷新查件结果', 'err'); renderLookup(); return; }
    state.selected = {};
    state.selected[id] = true;
    $('outSearch').value = p.trackingNo;
    state.outKeyword = p.trackingNo;
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
          '<div class="pc-meta"><span class="slot-chip">' + esc(p.slot || '未分配') + '</span>' +
          '<span>' + esc(p.carrier) + '</span>' +
          (p.recipient ? '<span>' + esc(p.recipient) + '</span>' : '') +
          (p.phoneTail ? '<span>尾号 ' + esc(p.phoneTail) + '</span>' : '') + '</div>' +
          '<div class="pc-foot"><span>' + esc(store.fmtTime(p.inAt)) + '</span>' +
          '<span class="tag ' + tagCls + '">在库 ' + p.stayDays + ' 天</span></div></div>';
      }).join('') : '<div class="card" style="grid-column:1/-1">' + emptyHTML('换个关键词试试，或确认包裹是否已出库') + '</div>');
    $('pickCount').textContent = Object.keys(state.selected).length;
    $('btnCheckout').disabled = Object.keys(state.selected).length === 0;
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
        '<button class="icon-btn" data-edit="' + esc(p.id) + '" title="修改"><svg class="ic"><use href="#i-edit"/></svg></button>' +
        '<button class="icon-btn danger" data-del="' + esc(p.id) + '" title="删除"><svg class="ic"><use href="#i-trash"/></svg></button>' +
        '</div></td></tr>';
    }).join('') : '<tr><td colspan="8">' + emptyHTML('没有符合条件的记录') + '</td></tr>';
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
    $('logList').innerHTML = rows.length ? rows.slice(0, 300).map(function (l) {
      var canRestore = l.type === 'out' && l.parcelId && (function () {
        var p = store.getDB().parcels.find(function (x) { return x.id === l.parcelId; });
        return p && p.status === 'out';
      })();
      return '<div class="log-item"><div class="log-time">' + esc(store.fmtTime(l.at)) + '</div>' +
        '<span class="log-badge t-' + esc(l.type) + '">' + esc(store.logTypeName(l.type)) + '</span>' +
        '<div class="log-text">' + esc(l.summary) + '</div>' +
        (canRestore ? '<button class="btn btn-ghost btn-sm" data-restore="' + esc(l.parcelId) + '">撤销出库</button>' : '') + '</div>';
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
    renderSyncState();
    renderPhotoStatus();
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('nav').addEventListener('click', function (e) {
      var b = e.target.closest('.nav-item');
      if (b) switchView(b.dataset.view);
    });
    document.addEventListener('click', function (e) {
      var g = e.target.closest('[data-goto]');
      if (g) switchView(g.dataset.goto);
    });
    $('btnQuickIn').onclick = function () { switchView('inbound'); };

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
      var cp = e.target.closest('[data-copy]');
      if (cp) { copyText(cp.dataset.copy); return; }
    });

    /* 入库 */
    $('formIn').addEventListener('submit', async function (e) {
      e.preventDefault();
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
        photos: pr.items
      });
      btn.disabled = false;
      if (!res.ok) { toast(res.error, 'err'); $('inTracking').select(); return; }
      $('lastIn').hidden = false;
      $('lastIn').innerHTML = '已入库 <strong>' + esc(res.parcel.trackingNo) + '</strong> → 货架位 <strong>' + esc(res.parcel.slot) + '</strong>' +
        (pr.items.length ? '，照片 ' + pr.items.length + ' 张' : '') + '，继续扫下一件';
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
    $('btnReslot').onclick = function () {
      $('inSlot').value = store.suggestSlot($('inZone').value || store.settings().zones[0]);
      $('inTracking').focus();
    };
    $('inZone').onchange = function () {
      $('inSlot').value = store.suggestSlot(this.value);
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
      var b = e.target.closest('[data-restore]');
      if (!b) return;
      var r = store.restoreParcel(b.dataset.restore);
      if (!r.ok) toast(r.error, 'err'); else afterWrite('已撤销出库，包裹恢复在库');
    });

    /* 图片存储 */
    $('phMode').addEventListener('change', togglePhotoBoxes);
    $('btnPhPick').onclick = async function () {
      var r = await photos.pickDirectory();
      renderPhotoStatus();
      toast(r.ok ? r.message : r.error, r.ok ? 'ok' : 'err');
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
        shelvesPerZone: Number($('setShelves').value), levelsPerShelf: Number($('setLevels').value)
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
      else afterWrite('导入完成，处理 ' + r.count + ' 条记录');
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
      else { fillSettings(); afterWrite('已拉取 ' + imp.count + ' 条记录'); }
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
    afterWrite('已出库 ' + r.count + ' 件' + (pr.items.length ? ' · 凭证 ' + pr.items.length + ' 张' : ''));
    reportPhotoResult(pr);
    $('outSearch').focus();
  }

  async function init() {
    await photos.init();
    fillSettings();
    bind();
    renderAll();
    switchView('dash');
  }
  init();
})();
