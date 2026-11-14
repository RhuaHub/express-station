/* 驿站助手（重建版）· UI 控制器 */
(function () {
  'use strict';
  var R = window.StationRules, DB = window.StationDB, Auth = window.StationAuth, Media = window.StationMedia;
  var store = DB.createStore(DB.pickStorage('local'));
  var auth = Auth.create(store);
  var $ = function (id) { return document.getElementById(id); };
  var esc = R.esc;

  var S = {
    view: 'dash', inTab: 'manual', outTab: 'pickup', outType: 'pickup',
    inFiles: [], outFiles: [], inUrls: [], outUrls: [], inOcrPending: null,
    lastIn: null, lastInBatchId: '', lastOut: null, lastOutIds: [],
    quickList: [], scanInList: [], batchRows: [], batchErrors: [],
    outSelected: {}, invSelected: {}, printSelected: {},
    autoTried: false, outEngine: '', outCandidates: [], outScanPhoto: null,
    statPreset: 'today', statTab: 'rate', qResult: [], invResult: [],
    photoUrls: {}, idleTimer: null, lastActive: Date.now()
  };

  /* ---------------- 通用 ---------------- */
  function toast(msg, kind) {
    var w = $('toastWrap'), d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : ''); d.textContent = msg;
    w.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2800);
    if (window.StationNative && window.StationNative.toastMsg && kind === 'err') {
      try { window.StationNative.toastMsg(msg); } catch (e) { }
    }
  }
  function download(name, content, mime) {
    if (window.StationNative && window.StationNative.saveText) {
      try { window.StationNative.saveText(name, content, mime || 'text/plain'); return; } catch (e) { }
    }
    try {
      var blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
      var u = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = u; a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(u); if (a.parentNode) a.parentNode.removeChild(a); }, 800);
    } catch (e) { toast('导出失败：' + e.message, 'err'); }
  }
  function feedback(kind, text) { Media.feedback(kind, text, store.settings()); }
  function guard(perm) {
    if (!auth.can(perm)) { toast('当前账号没有「' + perm + '」权限', 'err'); return false; }
    return true;
  }
  function openModal(title, html, foot) {
    $('modal').innerHTML = '<h3>' + esc(title) + '</h3>' + html +
      '<div class="modal-foot">' + (foot || '<button class="btn btn-ghost" data-modal="close">关闭</button>') + '</div>';
    $('modalMask').hidden = false;
    return $('modal');
  }
  function closeModal() { $('modalMask').hidden = true; $('modal').innerHTML = ''; }
  function confirmBox(title, msg, onOk) {
    var m = openModal(title, '<div class="notice" style="border-radius:9px">' + esc(msg) + '</div>',
      '<button class="btn btn-ghost" data-modal="close">取消</button><button class="btn btn-primary" data-modal="ok">确定</button>');
    m.querySelector('[data-modal="ok"]').onclick = function () { closeModal(); onOk(); };
  }
  function table(elId, cols, rows, opts) {
    opts = opts || {};
    var el = $(elId); if (!el) return;
    var h = '<thead><tr>' + (opts.check ? '<th></th>' : '') +
      cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    if (!rows.length) {
      h += '<tr><td class="empty" colspan="' + (cols.length + (opts.check ? 1 : 0)) + '">' +
        esc(opts.empty || '查无数据') + '</td></tr>';
    }
    rows.forEach(function (r) {
      h += '<tr' + (r.id ? ' data-id="' + esc(r.id) + '"' : '') + '>' +
        (opts.check ? '<td data-label="选择"><input type="checkbox" data-check="' + esc(r.id) + '"' +
          (opts.selected && opts.selected[r.id] ? ' checked' : '') + '></td>' : '') +
        r.cells.map(function (c, i) { return '<td data-label="' + esc(cols[i]) + '">' + c + '</td>'; }).join('') + '</tr>';
    });
    el.innerHTML = h + '</tbody>';
  }
  function fillSelect(id, list, value, labelFn, valFn) {
    var el = $(id); if (!el) return;
    el.innerHTML = list.map(function (x) {
      var v = valFn ? valFn(x) : x, l = labelFn ? labelFn(x) : x;
      return '<option value="' + esc(v) + '"' + (String(v) === String(value) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }
  function ops(buttons) {
    return '<div class="ops">' + buttons.map(function (b) {
      return '<button class="btn btn-ghost btn-sm" data-act="' + b[0] + '" data-id="' + esc(b[2]) + '">' + esc(b[1]) + '</button>';
    }).join('') + '</div>';
  }
  function statusTag(p) {
    if (p.status === 'void') return '<span class="tag tag-out">已撤销</span>';
    if (p.status === 'out') return p.outType === 'refund'
      ? '<span class="tag tag-refund">已退件</span>' : '<span class="tag tag-out">已出库</span>';
    var d = R.daysBetween(p.inAt, Date.now());
    var set = store.settings();
    return '<span class="tag ' + (d >= set.dangerDays ? 'tag-danger' : d >= set.warnDays ? 'tag-warn' : 'tag-in') + '">' +
      (d >= set.warnDays ? '滞留 ' + d + ' 天' : '在库') + '</span>';
  }
  function parcelLine(p) {
    return '<div><b class="mono">' + esc(p.goodsNo || p.serial || '—') + '</b>' +
      '<div class="td-sub">' + esc(p.trackingNo) + ' · ' + esc(p.slot) + '</div></div>';
  }
  function afterWrite(msg, kind) {
    store.save();
    renderAll();
    if (kind) feedback(kind, msg);
    toast(msg, 'ok');
  }

  /* ---------------- 登录门 ---------------- */
  function showGate() {
    $('app').hidden = true; $('authGate').hidden = false;
    var st = auth.status();
    $('authSetup').hidden = true; $('authLogin').hidden = true; $('authBootHint').hidden = true;
    $('authStorageHint').hidden = st.storageOk;
    if (st.locked) {
      $('authLogin').hidden = false; $('authLoginTitle').textContent = '已锁屏 · 输入密码解锁';
    } else if (st.needSetup) {
      $('authBootHint').hidden = false;
    } else {
      $('authLogin').hidden = false; $('authLoginTitle').textContent = '登录';
    }
    $('authMsg').textContent = '';
  }
  function reportBoot(where, e) {
    if (window.StationBoot) window.StationBoot.report(where + '：' + (e && e.message ? e.message : String(e)));
  }
  function enterApp() {
    /* 安卓 WebView 上任何一个渲染函数抛错都不允许变成白屏/闪退 */
    $('authGate').hidden = true; $('app').hidden = false;
    var st = auth.status();
    $('topUser').textContent = st.user + (st.role === 'owner' ? ' · 站长' : st.role === 'viewer' ? ' · 只读' : '');
    $('topStation').textContent = store.settings().stationName || '快递驿站';
    store.setActor(st.user);
    try { renderAll(); } catch (e) { reportBoot('渲染主界面失败', e); }
    try {
      var h = (location.hash || '').replace('#', '');
      if (h && $('view-' + h)) switchView(h);
      bindIdle();
    } catch (e2) { reportBoot('界面绑定失败', e2); }
  }
  function doLogin() {
    try {
      var pw = $('loginPw').value;
      var r = auth.status().locked ? auth.unlock(pw) : auth.login($('loginName').value, pw);
      $('authMsg').textContent = r.ok ? '' : r.error;
      $('authMsg').className = 'auth-msg';
      if (r.ok) { $('loginPw').value = ''; enterApp(); }
    } catch (e) {
      reportBoot('登录失败', e);
      $('authMsg').textContent = '登录出错：' + (e && e.message ? e.message : String(e));
    }
  }
  function bindGate() {
    $('btnLogin').onclick = doLogin;
    $('loginPw').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    $('btnSetup').onclick = function () {
      var n = $('setupName').value.trim(), p = $('setupPw').value, p2 = $('setupPw2').value;
      if (p !== p2) { $('authMsg').textContent = '两次密码不一致'; return; }
      var r = auth.setup({ name: n, password: p });
      if (!r.ok) { $('authMsg').textContent = r.error; return; }
      enterApp();
    };
    $('btnGoSetup').onclick = function () {
      $('authSetup').hidden = false; $('authBootHint').hidden = true; $('authLogin').hidden = true;
    };
    function importBackup(file) {
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var obj = JSON.parse(fr.result);
          var r = store.restoreSnapshot(obj, 'replace');
          if (!r.ok) { $('authMsg').textContent = r.error; return; }
          if (obj.photos && Media.importAll) Media.importAll(obj.photos);
          $('authMsg').textContent = '已导入 ' + r.parcels + ' 条记录';
          $('authMsg').className = 'auth-msg ok';
          showGate();
        } catch (e) { $('authMsg').textContent = '备份文件无法解析：' + e.message; }
      };
      fr.readAsText(file);
    }
    $('btnBootImport').onclick = function () { $('authImportFile').click(); };
    $('btnSetupImport').onclick = function () { $('authImportFile').click(); };
    $('authImportFile').addEventListener('change', function () { importBackup(this.files[0]); this.value = ''; });
    $('btnDiag').onclick = function () {
      var d = auth.diag();
      d.storage = { db: DB.KEY, ok: store.storageOk() };
      d.bootErrors = window.StationBoot ? window.StationBoot.errors() : [];
      try { d.nativeLog = (window.StationNative && window.StationNative.crashLog) ? window.StationNative.crashLog() : ''; }
      catch (e) { d.nativeLog = ''; }
      $('authDiag').hidden = false;
      $('authDiag').textContent = JSON.stringify(d, null, 2);
    };
    $('btnClearLock').onclick = function () { auth.clearLock(); $('authMsg').textContent = '登录限制已清除'; };
  }

  /* ---------------- 视图切换 ---------------- */
  var TITLES = {
    dash: '工作台', inbound: '入库', outbound: '出库', query: '查件', inventory: '库存台账',
    collections: '收件任务', customers: '客户管理', stats: '业务统计', print: '货号标签',
    sync: '同步记录', settings: '设置', accounts: '子账号', logs: '操作流水', help: '帮助 / 关于'
  };
  function switchView(name) {
    if (!$('view-' + name)) name = 'dash';
    S.view = name;
    Object.keys(TITLES).forEach(function (v) { var el = $('view-' + v); if (el) el.hidden = v !== name; });
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-view') === name);
      var p = b.getAttribute('data-perm');
      b.disabled = !!(p && !auth.can(p));
    });
    $('topSub').textContent = TITLES[name];
    $('sidebar').classList.remove('open'); $('sideShade').classList.remove('on');
    try { history.replaceState(null, '', '#' + name); } catch (e) { }
    renderAll();
    window.scrollTo(0, 0);
    if (name === 'inbound' && S.inTab === 'manual') setTimeout(function () { try { $('inNo').focus(); } catch (e) { } }, 100);
    if (name === 'outbound' && store.settings().autoCapture && !S.autoTried &&
      auth.can('outbound') && Media.supported() && store.listParcels({ status: 'in' }).length) {
      S.autoTried = true;
      setTimeout(function () { if (S.view === 'outbound') capturePickup(true); }, 500);
    }
  }
  function renderAll() {
    if ($('app').hidden) return;
    renderDash(); renderInbound(); renderOutbound(); renderQuery(); renderInventory();
    renderCollections(); renderCustomers(); renderStats(); renderPrint(); renderSync();
    renderSettings(); renderAccounts(); renderLogs(); renderHelp();
  }

  /* ---------------- 工作台 ---------------- */
  function renderDash() {
    var s = store.stats(R.dateRange('today'));
    var all = store.listParcels({ status: 'in' });
    var overdue = all.filter(function (p) { return R.daysBetween(p.inAt, Date.now()) >= store.settings().warnDays; }).length;
    $('dashDate').textContent = R.fmt(new Date(), false) + ' · ' + (store.settings().stationName || '驿站');
    $('dashKpi').innerHTML = [
      ['今日入库', s.inCount, '今日累计'], ['今日出库', s.outCount, '取件 ' + s.pickupCount + ' · 退件 ' + s.refundCount],
      ['当前库存', all.length, '在库件数'], ['滞留提醒', overdue, '超过 ' + store.settings().warnDays + ' 天']
    ].map(function (x) {
      return '<div class="kpi"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div><div class="s">' + esc(x[2]) + '</div></div>';
    }).join('');
    var d = s.stockDays, max = Math.max(1, d.d0, d.d1, d.d2, d.d3, d.over);
    $('dashStockTotal').textContent = '共 ' + s.inStock + ' 件';
    $('dashStock').innerHTML = [['当天', d.d0], ['1 天', d.d1], ['2 天', d.d2], ['3 天', d.d3], ['4 天以上', d.over]]
      .map(function (x) {
        return '<div class="bar-row"><span class="b-label">' + x[0] + '</span><span class="bar-track">' +
          '<span class="bar-fill" style="width:' + (x[1] / max * 100) + '%"></span></span><span class="b-num">' + x[1] + '</span></div>';
      }).join('');
    $('dashLogs').innerHTML = store.listLogs({ limit: 8 }).map(function (l) {
      return '<div class="m-row"><time>' + esc(R.fmt(l.at).slice(5)) + '</time><span>' + esc(l.text) + '</span></div>';
    }).join('') || '<div class="muted">暂无操作</div>';
    $('dashQuick').innerHTML = [
      ['inbound', '手动 / 极速入库'], ['outbound', '拍照取件出库'], ['query', '多维查件'],
      ['inventory', '库存台账与移库'], ['stats', '业务统计'], ['print', '打印货号标签'],
      ['customers', '客户管理'], ['settings', '设置与备份']
    ].map(function (x) {
      return '<button class="btn btn-outline" data-go="' + x[0] + '">' + esc(x[1]) + '</button>';
    }).join('');
  }

  /* ---------------- 入库 ---------------- */
  function renderInbound() {
    var set = store.settings();
    var companies = store.listCompanies().filter(function (c) { return c.enabled !== false; });
    if (document.activeElement !== $('inCarrier') || !$('inCarrier').value) {
      fillSelect('inCarrier', companies.map(function (c) { return c.name; }), $('inCarrier').value || companies[0] && companies[0].name);
    }
    var slots = R.slotList(set).filter(function (s) { return !store.occupied(s); });
    fillSelect('inSlot', slots, $('inSlot').value || set.zones[0] + '01-01');
    fillSelect('inLabel', [''].concat(store.listLabels()), $('inLabel').value, function (x) { return x || '无标签'; });
    if (!$('inSerial').value && !$('inGoods').value) {
      var preview = store.previewNums({ slot: $('inSlot').value, tail: R.tail4($('inPhone').value), short: 'YT' });
      $('inSerial').placeholder = '自动生成：' + preview.serial;
      $('inGoods').placeholder = '自动生成：' + preview.goodsNo;
    }
    $('inPhotoState').textContent = S.inFiles.length ? S.inFiles.length + ' 张照片待保存' : (set.photoIn ? '入库拍照已开启' : '');
    renderPhotos('inPhotoPreview', S.inFiles, S.inUrls, 'in');
    renderStrip('quickList', S.quickList, function (x, i) {
      return '<div class="strip-item"><b>' + esc(x.goodsNo) + '</b><span class="grow">' + esc(x.trackingNo) +
        ' · ' + esc(x.slot) + '</span><span class="muted">' + esc(x.phoneTail || '待补录') + '</span></div>';
    }, '本次还没有入库记录');
    renderStrip('scanInList', S.scanInList, function (x) {
      return '<div class="strip-item"><b>' + esc(x.goodsNo || '失败') + '</b><span class="grow">' + esc(x.text) + '</span></div>';
    }, '等待扫码…');
    $('quickCount').textContent = '本次 ' + S.quickList.length + ' 件';
    if (S.lastIn) {
      $('lastInCard').hidden = false;
      var p = S.lastIn;
      $('lastIn').innerHTML = '<div class="strip-item"><b class="mono">' + esc(p.goodsNo) + '</b><span class="grow">' +
        esc(p.trackingNo) + ' → ' + esc(p.slot) + '</span><button class="btn btn-outline btn-sm" data-act="label" data-id="' +
        esc(p.id) + '">打印标签</button></div>';
    }
  }
  function renderPhotos(elId, files, urls, which) {
    var el = $(elId); if (!el) return;
    while (urls.length < files.length) urls.push(URL.createObjectURL(files[urls.length].blob));
    el.innerHTML = files.map(function (f, i) {
      return '<img src="' + urls[i] + '" title="' + esc(f.name) + '" data-photo="' + which + '" data-index="' + i + '" alt="照片">';
    }).join('');
  }
  function renderStrip(elId, list, fn, empty) {
    var el = $(elId); if (!el) return;
    el.innerHTML = list.length ? list.map(fn).join('') : '<div class="muted">' + esc(empty) + '</div>';
  }

  function nameInFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return /^image\//.test((f.blob || f).type || ''); }).slice(0, 12);
    var jobs = files.map(function (f) {
      return Media.recognize(f.blob).then(function (d) {
        var code = R.barcodeOf(d);
        return { blob: f.blob, type: f.type, name: R.inboundPhotoName(code), code: code,
          engine: d.supported ? '本机识别' : '未支持识别' };
      });
    });
    S.inOcrPending = Promise.all(jobs).then(function (out) {
      S.inFiles = S.inFiles.concat(out).slice(0, 12);
      if (!$('inNo').value) {
        var hit = out.filter(function (x) { return x.code; })[0];
        if (hit) { $('inNo').value = hit.code; syncCarrier(); }
      }
      var ok = out.filter(function (x) { return x.code; }).length;
      var st = $('inOcrState'); st.hidden = false;
      st.className = 'ocr-state ' + (ok ? 'ok' : 'err');
      st.textContent = out.length
        ? (ok ? '识别到条码 ' + out.filter(function (x) { return x.code; }).map(function (x) { return x.code; }).join('、') + '，照片已按条码命名'
          : '未识别到条码，照片按时间命名，运单号请手输或扫码枪录入')
        : '';
      renderInbound();
      return out;
    });
    return S.inOcrPending;
  }
  function syncCarrier() {
    var no = $('inNo').value.trim();
    if (!no) return;
    var c = R.detectCarrier(no, store.listCompanies());
    var sel = $('inCarrier');
    if (c && Array.prototype.some.call(sel.options, function (o) { return o.value === c.name; })) sel.value = c.name;
    $('inCarrierHint').textContent = c && c.rule ? '按单号自动识别：' + c.name + '（可手动改）' : '未匹配到识别规则，请手动选公司';
  }
  function clearInForm(keepFocus) {
    ['inNo', 'inRecipient', 'inPhone', 'inSerial', 'inGoods', 'inNote'].forEach(function (id) { $(id).value = ''; });
    $('inCount').value = '1'; $('inLabel').value = ''; $('inCarrierHint').textContent = '';
    $('inOcrState').hidden = true; $('inOcrState').textContent = '';
    S.inUrls.forEach(function (u) { URL.revokeObjectURL(u); }); S.inUrls = []; S.inFiles = [];
    S.inOcrPending = null;
    renderInbound();
    if (keepFocus) $('inNo').focus();
  }
  function savePhotos(files, kind, nameFn) {
    var jobs = files.map(function (f, i) {
      return Media.put(f.blob, nameFn ? nameFn(f, i) : f.name, kind);
    });
    return Promise.all(jobs).then(function (items) {
      return items.filter(function (x) { return x && x.ok; }).map(function (x) {
        return { id: x.id, name: x.name, at: R.iso(), kind: kind };
      });
    });
  }
  function submitInbound(e) {
    e.preventDefault();
    if (!guard('inbound')) return;
    var btn = $('formIn').querySelector('button[type="submit"]');
    btn.disabled = true;
    var wait = S.inOcrPending || Promise.resolve([]);
    wait.then(function () {
      return savePhotos(S.inFiles, 'in');
    }).then(function (photos) {
      var r = store.addParcel({
        trackingNo: $('inNo').value, carrier: $('inCarrier').value,
        recipient: $('inRecipient').value, phone: $('inPhone').value,
        slot: $('inSlot').value, serial: $('inSerial').value, goodsNo: $('inGoods').value,
        label: $('inLabel').value, note: $('inNote').value, count: $('inCount').value,
        photos: photos
      });
      btn.disabled = false;
      if (!r.ok) { feedback('error'); toast(r.error, 'err'); return; }
      S.lastIn = r.parcel; S.lastInBatchId = '';
      var txt = R.feedbackText('in', r.parcel);
      feedback('in', txt);
      clearInForm(true);
      S.lastIn = r.parcel;
      afterWrite('已入库 ' + r.parcel.trackingNo + ' → ' + r.parcel.goodsNo + ' / ' + r.parcel.slot);
    }).catch(function (err) { btn.disabled = false; toast('照片保存失败：' + err.message, 'err'); });
  }
  function quickAdd(noText, tail) {
    if (!guard('inbound')) return;
    var parts = String(noText).split(/[,，\s]+/).filter(Boolean);
    var no = R.upper(parts[0]) || '';
    var t = tail || (parts[1] && /^\d{4}$/.test(parts[1]) ? parts[1] : '') || R.tail4($('quickTail').value);
    var r = store.addParcel({ trackingNo: no, phoneTail: t });
    if (!r.ok) { feedback('error'); toast(r.error, 'err'); return false; }
    S.quickList.unshift(r.parcel); S.lastIn = r.parcel; S.lastInBatchId = '';
    feedback('in', R.feedbackText('in', r.parcel));
    $('quickHint').textContent = '已入库 ' + r.parcel.goodsNo + ' / ' + r.parcel.slot + '，继续扫下一件';
    renderInbound();
    return true;
  }

  /* ---------------- 出库 ---------------- */
  function renderOutbound() {
    var set = store.settings();
    var eng = Media.engines();
    $('outEngine').textContent = '本机识别：' +
      (eng.barcode ? '条码 ✔ ' : '条码 ✘ ') + (eng.text ? '文字 ✔' : '文字 ✘') +
      ' · 不支持时照片仍自动命名，手输货号即可出库';
    var mode = $('outMode').value || set.queryMode || 'fuzzy';
    $('outMode').value = mode;
    $('outReasonBox').hidden = S.outType !== 'refund';
    var kw = $('outKeyword').value.trim();
    var list = store.listParcels({ kw: kw, mode: $('outMode').value, status: 'in', limit: 120 });
    $('outResultCount').textContent = (kw ? '匹配 ' : '在库 ') + list.length + ' 件';
    var rows = list.map(function (p) {
      return { id: p.id, cells: [parcelLine(p), esc(p.carrier), esc(p.recipient || '—') + ' <span class="muted">' + esc(p.phoneTail || '') + '</span>',
        esc(p.slot), esc(R.fmt(p.inAt).slice(5)) + '<div class="td-sub">在库 ' + R.daysBetween(p.inAt, Date.now()) + ' 天</div>',
        '<input type="checkbox" data-out-check="' + esc(p.id) + '"' + (S.outSelected[p.id] ? ' checked' : '') + '>'] };
    });
    table('outTable', ['货号 / 单号', '公司', '收件人', '货架', '入库', '选择'], rows, { empty: '没有匹配的在库包裹' });
    var n = Object.keys(S.outSelected).filter(function (k) { return S.outSelected[k]; }).length;
    $('outSelected').textContent = '已选 ' + n + ' 件';
    $('btnOutSubmit').textContent = S.outType === 'refund' ? '确认退件出库' : (n > 1 ? '合并出库 ' + n + ' 件' : '确认出库');
    $('outPhotoState') && ($('outPhotoState').textContent = '');
    renderPhotos('outPhotoPreview', S.outFiles, S.outUrls, 'out');
    if (S.lastOut) {
      $('lastOutCard').hidden = false;
      $('lastOut').innerHTML = '<div class="strip-item"><b>' + esc(S.lastOut.batchId) + '</b><span class="grow">' +
        S.lastOut.parcels.map(function (p) { return esc(p.goodsNo); }).join('、') + '</span>' +
        '<button class="btn btn-outline btn-sm" data-act="undoBatch" data-id="' + esc(S.lastOut.batchId) + '">撤销本次出库</button></div>';
    }
  }
  function setOutTab(tab) {
    S.outTab = tab; S.outType = tab;
    document.querySelectorAll('#outTabs .tab').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    $('outKeyword').placeholder = tab === 'phone' ? '输入手机后四位' : tab === 'scan' ? '扫描货号 / 条码后回车即出库' : '货号 / 编号 / 单号 / 尾号 / 收件人';
    renderOutbound();
  }
  function toggleOutCheck(id, on) {
    if (on) S.outSelected[id] = true; else delete S.outSelected[id];
    renderOutbound();
  }
  function outIds() {
    return Object.keys(S.outSelected).filter(function (k) { return S.outSelected[k]; });
  }
  function doCheckout(type) {
    if (!guard('outbound')) return;
    var ids = outIds();
    if (!ids.length) { toast('请先选择包裹', 'err'); return; }
    type = type || S.outType || 'pickup';
    var reason = type === 'refund' ? $('outReason').value : '';
    if (type === 'refund' && !reason) { toast('请选择退件原因', 'err'); return; }
    var needPhoto = store.settings().photoOut && $('outPhotoPreview').children.length === 0;
    var run = function () {
      var p0 = store.getParcel(ids[0]);
      savePhotos(S.outFiles, 'out', function (f) { return R.outboundPhotoName(p0); }).then(function (photos) {
        var r = store.checkout(ids, {
          outType: type, reason: reason, pickupBy: $('outPickupBy').value,
          note: $('outNote').value, photos: photos
        });
        if (!r.ok) { toast(r.error, 'err'); return; }
        S.lastOut = r; S.outSelected = {}; S.outFiles.forEach(function (_, i) { if (S.outUrls[i]) URL.revokeObjectURL(S.outUrls[i]); });
        S.outFiles = []; S.outUrls = []; S.outScanPhoto = null;
        $('outKeyword').value = ''; $('outPickupBy').value = ''; $('outNote').value = '';
        $('outOcrState').hidden = true; $('outCandidates').innerHTML = '';
        feedback(type === 'refund' ? 'refund' : 'out', R.feedbackText(type === 'refund' ? 'refund' : 'out', r.parcels[0]));
        afterWrite((r.merged ? '合并出库 ' : '已出库 ') + r.count + ' 件 · ' + r.batchId);
        if (S.outTab === 'pickup' && store.settings().autoCapture && Media.supported() && auth.can('outbound')) {
          setTimeout(function () { if (S.view === 'outbound') capturePickup(true); }, 650);
        }
      }).catch(function (e) { toast('凭证保存失败：' + e.message, 'err'); });
    };
    if (needPhoto && store.settings().photoAuto && Media.supported()) {
      captureOutProof().then(function (ok) { if (ok) run(); });
    } else run();
  }
  function captureOutProof() {
    return Media.capture({ title: '拍出库凭证', max: 6, prefix: 'CK', torch: store.settings().torch }).then(function (r) {
      if (r.cancelled) { toast('未拍照，已取消出库', 'err'); return false; }
      S.outFiles = S.outFiles.concat(r.files).slice(0, 12);
      renderOutbound();
      return true;
    });
  }
  function capturePickup(auto) {
    if (!guard('outbound')) return Promise.resolve(false);
    return Media.capture({ title: '拍照取件 · 对准面单条码', single: true, prefix: 'CK',
      torch: store.settings().torch }).then(function (r) {
      if (r.cancelled || !r.files.length) return false;
      var f = r.files[0];
      return Media.recognize(f.blob).then(function (d) {
        var code = R.barcodeOf(d);
        var st = $('outOcrState'); st.hidden = false;
        st.className = 'ocr-state ' + (code ? 'busy' : 'err');
        st.textContent = code ? '识别串：' + code + ' · 正在匹配在库包裹…' : '没读到条码，请手输货号 / 单号，照片仍会按货号自动命名';
        var hits = code ? store.findByCode(code) : [];
        if (hits.length === 1) {
          var p = hits[0];
          S.outSelected[p.id] = true;
          $('outKeyword').value = p.goodsNo || code;
          f.name = R.outboundPhotoName(p);
          S.outScanPhoto = f;
          st.className = 'ocr-state ok';
          st.textContent = '已匹配 ' + p.goodsNo + ' · ' + p.trackingNo + ' · ' + p.slot + '，确认无误后点「确认出库」';
          $('outCandidates').innerHTML = '';
        } else if (hits.length > 1) {
          $('outCandidates').innerHTML = '<span class="muted">多个匹配，请点选：</span>' + hits.map(function (p) {
            return '<button class="btn btn-outline btn-sm" data-act="pickCandidate" data-id="' + esc(p.id) + '">' +
              esc(p.goodsNo) + ' · ' + esc(p.trackingNo.slice(-6)) + '</button>';
          }).join('');
          st.textContent = '识别到 ' + code + '，有 ' + hits.length + ' 件匹配，请手动点选，不会自动出库';
        } else {
          $('outCandidates').innerHTML = '';
          S.outScanPhoto = null;
        }
        if (S.outScanPhoto) {
          S.outFiles = [S.outScanPhoto].concat(S.outFiles.filter(function (x) { return x !== S.outScanPhoto; })).slice(0, 12);
        } else {
          S.outFiles = [f].concat(S.outFiles).slice(0, 12);
        }
        renderOutbound();
        return true;
      });
    });
  }

  /* ---------------- 查件 / 台账 ---------------- */
  function queryArgs() {
    return {
      kw: $('qKw').value.trim(), mode: $('qMode').value, status: $('qStatus').value,
      carrier: $('qCarrier').value, slot: $('qSlot').value.trim(), label: $('qLabel').value,
      from: $('qFrom').value, to: $('qTo').value, warnDays: store.settings().warnDays
    };
  }
  function parcelRows(list, extraActions) {
    return list.map(function (p) {
      var acts = [['detail', '详情', p.id], ['photos', '照片(' + (p.photos || []).length + ')', p.id], ['label', '标签', p.id]];
      if (p.status === 'in') acts.push(['edit', '修改', p.id], ['out', '出库', p.id]);
      else if (p.status === 'out') acts.push(['undoOut', '撤销出库', p.id]);
      if (extraActions) acts = acts.concat(extraActions(p));
      return { id: p.id, cells: [
        parcelLine(p), esc(p.serial || '—'), statusTag(p), esc(p.recipient || '—') + '<div class="td-sub">' + esc(p.phoneTail || '') + '</div>',
        esc(p.slot), esc(R.fmt(p.inAt).slice(5)), p.outAt ? esc(R.fmt(p.outAt).slice(5)) : '—',
        esc(p.carrier), esc(p.label || ''), ops(acts)
      ] };
    });
  }
  var COLS = ['货号 / 单号', '编号', '状态', '收件人', '货架', '入库', '出库', '公司', '标签', '操作'];
  function renderQuery() {
    fillSelect('qCarrier', ['all'].concat(store.listCompanies().map(function (c) { return c.name; })),
      $('qCarrier').value || 'all', function (x) { return x === 'all' ? '全部公司' : x; });
    fillSelect('qLabel', [''].concat(store.listLabels()), $('qLabel').value, function (x) { return x || '全部标签'; });
    var q = queryArgs();
    q.status = q.status === 'overdue' ? 'overdue' : q.status;
    S.qResult = store.listParcels(q).slice(0, 300);
    $('qCount').textContent = '共 ' + S.qResult.length + ' 条' + (S.qResult.length >= 300 ? '（仅显示前 300 条）' : '');
    table('queryTable', COLS, parcelRows(S.qResult), { empty: '无查询结果' });
  }
  function renderInventory() {
    var status = $('invStatus').value, kw = $('invKw').value.trim();
    var q = { kw: kw, status: status === 'overdue' ? 'in' : status, warnDays: 999 };
    var list = store.listParcels(q);
    if (status === 'overdue') list = list.filter(function (p) { return R.daysBetween(p.inAt, Date.now()) >= store.settings().warnDays; });
    var sort = $('invSort').value;
    if (sort === 'old') list.sort(function (a, b) { return new Date(a.inAt) - new Date(b.inAt); });
    if (sort === 'days') list.sort(function (a, b) { return new Date(a.inAt) - new Date(b.inAt); });
    if (sort === 'goods') list.sort(function (a, b) { return (a.goodsNo || '').localeCompare(b.goodsNo || ''); });
    S.invResult = list.slice(0, 300);
    var days = S.invResult.filter(function (p) { return p.status === 'in'; })
      .map(function (p) { return R.daysBetween(p.inAt, Date.now()); });
    $('invSummary').textContent = '共 ' + S.invResult.length + ' 条 · 在库 ' +
      S.invResult.filter(function (p) { return p.status === 'in'; }).length + ' 件' +
      (days.length ? ' · 平均在库 ' + (days.reduce(function (a, b) { return a + b; }, 0) / days.length).toFixed(1) + ' 天' : '');
    table('invTable', COLS, parcelRows(S.invResult), { check: true, selected: S.invSelected, empty: '台账为空' });
  }
  function invIds() { return Object.keys(S.invSelected).filter(function (k) { return S.invSelected[k]; }); }

  /* ---------------- 收件任务 ---------------- */
  function renderCollections() {
    fillSelect('colCarrier', store.listCompanies().map(function (c) { return c.name; }), $('colCarrier').value);
    var list = store.listCollections({ status: $('colFilter').value });
    renderStrip('colList', list, function (c) {
      return '<div class="strip-item"><b>' + esc(c.no) + '</b><span class="grow">' + esc(c.recipient || '—') +
        ' · ' + esc(c.phone || '') + ' · ' + esc(c.carrier || '') + '</span>' +
        '<span class="tag ' + (c.status === 'done' ? 'tag-out' : 'tag-in') + '">' +
        esc({ pending: '待取', picked: '已取', sent: '已发出', done: '完成' }[c.status] || c.status) + '</span>' +
        ops([['colStatus', '流转', c.id], ['colDel', '删除', c.id]]) + '</div>';
    }, '暂无收件任务');
  }

  /* ---------------- 客户管理 ---------------- */
  var TYPE_LABEL = { normal: '普通', vip: 'VIP', old: '老客户', black: '黑名单' };
  function renderCustomers() {
    var list = store.listCustomers({ kw: $('cusKw').value.trim(), type: $('cusFilter').value });
    $('cusCount').textContent = '共 ' + list.length + ' 位客户';
    table('cusTable', ['客户', '电话', '尾号', '类型', '星标', '备注', '件数', '操作'],
      list.map(function (c) {
        return { id: c.id, cells: [
          esc(c.name || '—'), esc(R.maskPhone(c.phone) || '—'), '<span class="code-chip">' + esc(c.tail || '') + '</span>',
          '<span class="tag ' + (c.type === 'black' ? 'tag-danger' : c.type === 'vip' ? 'tag-warn' : 'tag-in') + '">' +
            esc(TYPE_LABEL[c.type] || c.type) + '</span>', esc(c.star || '—'), esc(c.remark || ''),
          String(c.count || 0), ops([['customerEdit', '编辑', c.id], ['customerDel', '删除', c.id]])
        ] };
      }), { empty: '暂无客户，入库时会按尾号自动归档' });
    $('interceptList').innerHTML = store.listIntercepts().map(function (x) {
      return '<button class="chip" data-act="interceptDel" data-id="' + esc(x.id) + '" title="点击移除">⨯ ' +
        esc(x.no) + ' · ' + esc(x.reason) + '</button>';
    }).join('') || '<span class="muted">暂无拦截单号</span>';
  }

  /* ---------------- 业务统计 ---------------- */
  function statsRange() {
    return R.dateRange(S.statPreset, $('statFrom').value, $('statTo').value);
  }
  function renderStats() {
    fillSelect('statPreset', R.PRESETS.map(function (p) { return p.id; }), S.statPreset,
      function (x) { return (R.PRESETS.filter(function (p) { return p.id === x; })[0] || {}).label || x; });
    $('statTab').value = S.statTab;
    var range = statsRange(), s = store.stats(range);
    $('statRangeLabel').textContent = range.label + '（' + range.fromDay + ' ~ ' + range.toDay + '）';
    $('statKpi').innerHTML = [
      ['入库数', s.inCount], ['出库数', s.outCount], ['取件数', s.pickupCount],
      ['退件数', s.refundCount], ['在库数', s.inStock], ['出库率', s.outRate + '%']
    ].map(function (x) { return '<div class="kpi"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div></div>'; }).join('');
    var max = Math.max(1, s.outCount, s.nonOut);
    $('statRate').innerHTML = [
      ['出库数', s.outCount], ['非出库数', s.nonOut]
    ].map(function (x) {
      return '<div class="bar-row"><span class="b-label">' + x[0] + '</span><span class="bar-track">' +
        '<span class="bar-fill" style="width:' + (x[1] / max * 100) + '%"></span></span><span class="b-num">' + x[1] + '</span></div>';
    }).join('') + '<div class="muted">出库率 = 出库数 / 入库数 = ' + s.outRate + '%，撤销入库 ' + s.undoIn + ' 次，撤销出库 ' + s.undoOut + ' 次</div>';
    $('statRateBox').hidden = S.statTab !== 'rate';
    $('statWorkBox').hidden = S.statTab !== 'work';
    var names = Object.keys(s.byOperator);
    table('statWork', ['操作人', '入库', '出库', '退件', '撤销'],
      names.map(function (n) {
        var o = s.byOperator[n];
        return { cells: [esc(n), String(o.inCount), String(o.outCount), String(o.refundCount), String(o.undo)] };
      }), { empty: '该时间段没有操作记录' });
    table('statDaily', ['日期', '入库数', '出库数', '取件数', '退件数', '操作'],
      s.daily.map(function (d) {
        return { cells: ['<b>' + esc(d.day) + '</b>', String(d.inCount), String(d.outCount),
          String(d.pickupCount), String(d.refundCount),
          '<button class="btn btn-ghost btn-sm" data-act="statDay" data-id="' + esc(d.day) + '">当日明细</button>'] };
      }), { empty: '该时间段无数据' });
  }

  /* ---------------- 货号标签 / 打印 ---------------- */
  var LABEL_FIELDS = [
    ['station', '驿站名称'], ['goods', '货号'], ['slot', '货架号'], ['serial', '编号'],
    ['recipient', '收件人'], ['tail', '手机尾号'], ['carrier', '快递公司'], ['date', '入库时间'],
    ['tracking', '运单号'], ['barcode', 'Code39 条码'], ['label', '快递标签'], ['note', '备注']
  ];
  function renderPrint() {
    var set = store.settings();
    $('labelFields').innerHTML = LABEL_FIELDS.map(function (f) {
      return '<label class="switch"><input type="checkbox" data-label-field="' + f[0] + '"' +
        (set.labelFields.indexOf(f[0]) >= 0 ? ' checked' : '') + '>' + esc(f[1]) + '</label>';
    }).join('');
    $('labelW').value = set.labelWidth || 80; $('labelH').value = set.labelHeight || 50;
    var kw = $('printKw').value.trim();
    var list = store.listParcels({ kw: kw, status: 'all', limit: 20 });
    $('printList').innerHTML = list.map(function (p) {
      return '<label class="strip-item"><input type="checkbox" data-print-check="' + esc(p.id) + '"' +
        (S.printSelected[p.id] ? ' checked' : '') + '><b>' + esc(p.goodsNo) + '</b><span class="grow">' +
        esc(p.trackingNo) + ' · ' + esc(p.slot) + '</span></label>';
    }).join('') || '<div class="muted">没有匹配的包裹</div>';
    var chosen = Object.keys(S.printSelected).filter(function (k) { return S.printSelected[k]; })
      .map(function (k) { return store.getParcel(k); }).filter(Boolean);
    $('printCount').textContent = chosen.length + ' 张标签';
    $('printPreview').innerHTML = chosen.length ? chosen.map(function (p) {
      return '<div style="width:' + (set.labelWidth || 80) + 'mm;min-height:' + (set.labelHeight || 50) + 'mm">' +
        R.labelHTML(p, set) + '</div>';
    }).join('') : '<div class="muted">勾选左边的包裹，这里会显示打印预览</div>';
  }
  function printParcels(list) {
    list = (list || []).filter(Boolean);
    if (!list.length) { toast('请先选择要打印的包裹', 'err'); return; }
    var set = store.settings();
    $('printRoot').innerHTML = list.map(function (p) { return R.labelHTML(p, set); }).join('');
    toast('已生成 ' + list.length + ' 张标签，调起系统打印', 'ok');
    setTimeout(function () { window.print(); }, 150);
  }

  /* ---------------- 同步记录 ---------------- */
  function renderSync() {
    var list = store.listUploads({ state: $('syncState').value, kw: $('syncKw').value.trim() });
    $('syncCount').textContent = '共 ' + list.length + ' 条';
    table('syncTable', ['时间', '货号', '单号', '动作', '状态', '说明', '操作'],
      list.slice(0, 300).map(function (u) {
        return { cells: [esc(R.fmt(u.at)), esc(u.goodsNo || ''), esc(u.trackingNo || ''),
          esc({ in: '入库', out: '出库', refund: '退件', move: '移库' }[u.action] || u.action),
          '<span class="tag ' + (u.state === 'done' ? 'tag-in' : u.state === 'pending' ? 'tag-warn' : 'tag-out') + '">' +
            esc({ local: '本机记录', pending: '待同步', done: '已标记' }[u.state] || u.state) + '</span>',
          esc(u.note || ''), ops([['uploadRetry', '重新标记', u.id]])] };
      }), { empty: '暂无同步记录' });
  }

  /* ---------------- 设置 ---------------- */
  function renderSettings() {
    var set = store.settings();
    fillSelect('setSerialMode', R.SERIAL_MODES.map(function (x) { return x.id; }), set.serialMode,
      function (x) { return (R.SERIAL_MODES.filter(function (m) { return m.id === x; })[0] || {}).label; });
    fillSelect('setGoodsMode', R.GOODS_MODES.map(function (x) { return x.id; }), set.goodsMode,
      function (x) { return (R.GOODS_MODES.filter(function (m) { return m.id === x; })[0] || {}).label; });
    if (!S.settingsFilled) {
      var map = {
        setStation: 'stationName', setContact: 'contact', setPhone: 'phone', setProvince: 'province',
        setAddress: 'address', setSerialStart: 'serialStart', setSerialWidth: 'serialWidth',
        setGoodsTemplate: 'goodsTemplate', setShelves: 'shelvesPerZone', setLevels: 'levelsPerShelf',
        setPhoneInput: 'phoneInput', setQueryMode: 'queryMode', setIdle: 'idleMinutes',
        setWarn: 'warnDays', setDanger: 'dangerDays', setPhotoMode: 'photoOutMode',
        setInterceptDays: 'interceptDays', setDelay: 'delayUpload', labelW: 'labelWidth', labelH: 'labelHeight'
      };
      Object.keys(map).forEach(function (id) { if ($(id)) $(id).value = set[map[id]]; });
      $('setZones').value = (set.zones || []).join(',');
      var checks = {
        setBeepIn: 'beepIn', setBeepOut: 'beepOut', setVibrateIn: 'vibrateIn', setVibrateOut: 'vibrateOut',
        setVoiceIn: 'voiceIn', setVoiceOut: 'voiceOut', setTorch: 'torch', setAutoCapture: 'autoCapture',
        setPhotoIn: 'photoIn', setPhotoOut: 'photoOut', setPhotoAuto: 'photoAuto',
        setBlacklist: 'blacklistBlock', setDuplicate: 'duplicateBlock', setSync: 'syncEnabled'
      };
      Object.keys(checks).forEach(function (id) { if ($(id)) $(id).checked = set[checks[id]] !== false; });
      S.settingsFilled = true;
    }
    var ex = store.previewNums({ slot: (set.zones[0] || 'A') + '01-01', tail: '6789', short: 'YT' });
    $('setNumsPreview').textContent = '示例：编号 ' + ex.serial + ' · 货号 ' + ex.goodsNo +
      ' · 可用货架位 ' + R.slotList(set).length + ' 个';
    table('companyTable', ['公司名称', '简称', '单号识别规则', '状态', '操作'],
      store.listCompanies().map(function (c) {
        return { cells: [esc(c.name), esc(c.short), '<span class="mono">' + esc(c.rule || '—') + '</span>',
          c.enabled === false ? '<span class="tag tag-out">停用</span>' : '<span class="tag tag-in">启用</span>',
          ops([['companyEdit', '编辑', c.id], ['companyToggle', c.enabled === false ? '启用' : '停用', c.id],
            ['companyDel', '删除', c.id]])] };
      }), { empty: '还没有快递公司' });
    $('labelList').innerHTML = store.listLabels().map(function (l) {
      return '<button class="chip" data-act="labelDel" data-label="' + esc(l) + '" title="点击删除">⨯ ' + esc(l) + '</button>';
    }).join('') || '<span class="muted">暂无标签</span>';
  }
  function readSettings() {
    return {
      stationName: $('setStation').value.trim() || '快递驿站', contact: $('setContact').value.trim(),
      phone: $('setPhone').value.trim(), province: $('setProvince').value.trim(), address: $('setAddress').value.trim(),
      serialMode: $('setSerialMode').value, serialStart: Number($('setSerialStart').value) || 1,
      serialWidth: Number($('setSerialWidth').value) || 4, goodsMode: $('setGoodsMode').value,
      goodsTemplate: $('setGoodsTemplate').value.trim() || '{slot}{serial}',
      zones: $('setZones').value.split(/[,，]/).map(function (x) { return R.upper(x); }).filter(Boolean),
      shelvesPerZone: Number($('setShelves').value) || 9, levelsPerShelf: Number($('setLevels').value) || 5,
      phoneInput: $('setPhoneInput').value, queryMode: $('setQueryMode').value,
      idleMinutes: Number($('setIdle').value) || 15, warnDays: Number($('setWarn').value) || 2,
      dangerDays: Number($('setDanger').value) || 5,
      beepIn: $('setBeepIn').checked, beepOut: $('setBeepOut').checked,
      vibrateIn: $('setVibrateIn').checked, vibrateOut: $('setVibrateOut').checked,
      voiceIn: $('setVoiceIn').checked, voiceOut: $('setVoiceOut').checked,
      torch: $('setTorch').checked, autoCapture: $('setAutoCapture').checked,
      photoIn: $('setPhotoIn').checked, photoOut: $('setPhotoOut').checked,
      photoAuto: $('setPhotoAuto').checked, photoOutMode: $('setPhotoMode').value,
      blacklistBlock: $('setBlacklist').checked, duplicateBlock: $('setDuplicate').checked,
      syncEnabled: $('setSync').checked, interceptDays: Number($('setInterceptDays').value) || 30,
      delayUpload: Number($('setDelay').value) || 0
    };
  }

  /* ---------------- 子账号 / 流水 / 帮助 ---------------- */
  var PERM_LABEL = {
    inbound: '入库', outbound: '出库', query: '查件', inventory: '台账', customers: '客户',
    collections: '收件任务', stats: '统计', print: '打印', sync: '同步记录', logs: '流水',
    settings: '设置', accounts: '子账号'
  };
  function renderAccounts() {
    $('accPerms').innerHTML = Auth.PERMS.map(function (p) {
      return '<label class="switch"><input type="checkbox" data-perm-check="' + p + '">' + esc(PERM_LABEL[p] || p) + '</label>';
    }).join('');
    table('accTable', ['账号', '角色', '权限数', '创建时间', '操作'],
      auth.listAccounts().map(function (a) {
        return { cells: [esc(a.name) + (a.role === 'owner' ? ' <span class="tag tag-warn">站长</span>' : ''),
          esc({ owner: '站长', operator: '操作员', viewer: '只读' }[a.role] || a.role),
          String((a.perms || []).length), esc(R.fmt(a.createdAt, false)),
          a.role === 'owner' ? '<span class="muted">—</span>' : ops([['accEdit', '编辑', a.id], ['accDel', '删除', a.id]])] };
      }), { empty: '暂无账号' });
  }
  function renderLogs() {
    var list = store.listLogs({ kw: $('logKw').value.trim(), action: $('logAction').value, limit: 300 });
    $('logCount').textContent = '共 ' + list.length + ' 条';
    table('logTable', ['时间', '操作', '内容', '操作人'],
      list.map(function (l) {
        return { cells: [esc(R.fmt(l.at)), '<span class="tag tag-out">' + esc(l.action) + '</span>',
          esc(l.text), esc(l.actor || '')] };
      }), { empty: '暂无流水' });
  }
  var HELP_FEATURES = [
    ['入库', '手动 / 极速 / 批量 / 扫码枪连录，条码识别按码命名照片，自动识别公司、分配货架与货号'],
    ['编号货号', '连续 / 按日 / 按货架 / 尾号四种编号模式，五种货号模式 + 自定义模板，批量改号'],
    ['出库', '取件 / 货号 / 电话 / 扫描 / 退件五种出库，合并出库、出库拍照、出库备注、撤销出库'],
    ['拍照取件', '进出库页自动开镜头，拍面单自动识别并匹配在库件，连续取件自动开下一张'],
    ['查件台账', '多条件组合查询、在库天数、滞留筛选、详情、修改、照片、批量移库与打印'],
    ['移库', '扫描或勾选加入移库列表，换货架号并可重算货号，留移库流水'],
    ['客户管理', '按尾号自动归档、VIP / 老客户 / 黑名单、星标备注、号码导入导出与去重'],
    ['入库拦截', '黑名单禁止入库、单号拦截名单、记录按天数自动清理'],
    ['快递公司', '公司启停、简称、单号正则识别规则，可编辑'],
    ['收件任务', '上门取件 / 寄件登记与状态流转'],
    ['业务统计', '出库率 / 工作量统计，13 种时间范围、每日明细与 CSV 导出'],
    ['货号标签', '模板字段可配、Code39 可扫条码、批量打印（系统打印）'],
    ['同步记录', '本地等价实现：上传记录、状态标记、重试、导出上行文件'],
    ['设置与账号', '提醒 / 拍照 / 拦截 / 货架设置、主子账号、逐项权限、锁屏、登录限速'],
    ['数据', '完整备份 JSON（含照片）、恢复 / 合并、包裹 CSV 导入导出、一键清空']
  ];
  var HELP_EXCLUDED = [
    ['短信类', '群发短信、短信模板 / 签名 / 审核、短信历史、失败短信提醒、扫码发短信'],
    ['电话类', '直拨 / 回拨 / 隐私号、群呼、群呼历史、通话记录、未接来电、语音通知模板'],
    ['微信通知', '微信取件通知、公众号绑定、码上取件、永久二维码海报'],
    ['服务端合作', '驿站代收开通 / 实名认证、物流数据上行到快递公司、延迟上传真实生效'],
    ['商业与硬件', '充值 / 账单 / 资费、商城、蓝牙打印机厂商 SDK、在线客服与活动奖励'],
    ['云端能力', '云端 OCR / 在线语音识别引擎（本机用浏览器自带接口，不联网）']
  ];
  function renderHelp() {
    $('helpFeatures').innerHTML = HELP_FEATURES.map(function (x) { return '<div><b>' + esc(x[0]) + '</b><br>' + esc(x[1]) + '</div>'; }).join('');
    $('helpExcluded').innerHTML = HELP_EXCLUDED.map(function (x) { return '<div><b>' + esc(x[0]) + '</b><br>' + esc(x[1]) + '</div>'; }).join('');
  }

  /* ---------------- 弹窗动作 ---------------- */
  function detailDialog(id) {
    var p = store.getParcel(id); if (!p) return;
    var rows = [
      ['货号', p.goodsNo], ['编号', p.serial], ['运单号', p.trackingNo], ['快递公司', p.carrier],
      ['收件人', p.recipient || '—'], ['联系电话', R.maskPhone(p.phone) || p.phoneTail || '—'],
      ['货架号', p.slot], ['标签', p.label || '—'], ['件数', p.count], ['备注', p.note || '—'],
      ['入库时间', R.fmt(p.inAt)], ['出库时间', R.fmt(p.outAt) || '—'],
      ['在库天数', p.status === 'in' ? R.daysBetween(p.inAt, Date.now()) : (p.outAt ? R.daysBetween(p.inAt, p.outAt) : '—')],
      ['出库类型', p.outType || '—'], ['退件原因', p.refundReason || '—'], ['取件人', p.pickupBy || '—'],
      ['状态', p.status === 'in' ? '在库' : p.status === 'out' ? (p.outType === 'refund' ? '已退件' : '已出库') : '已撤销'],
      ['批次', p.batchId || '—'], ['照片', (p.photos || []).length + ' 张'],
      ['操作人', p.operatorIn + (p.operatorOut ? ' / ' + p.operatorOut : '')],
      ['同步状态', { local: '本机记录', pending: '待同步', done: '已标记' }[p.uploadState] || p.uploadState]
    ];
    var m = openModal('包裹详情', '<dl class="detail-list">' + rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(String(r[1])) + '</dd>';
    }).join('') + '</dl>',
      '<button class="btn btn-ghost" data-modal="close">关闭</button>' +
      '<button class="btn btn-outline" data-modal="photos">查看照片</button>' +
      '<button class="btn btn-primary" data-modal="label">打印标签</button>');
    m.querySelector('[data-modal="photos"]').onclick = function () { photosDialog(id); };
    m.querySelector('[data-modal="label"]').onclick = function () { printParcels([p]); };
  }
  function photosDialog(id) {
    var p = store.getParcel(id); if (!p) return;
    var m = openModal('照片 · ' + (p.goodsNo || p.trackingNo), '<div class="modal-photos" id="modalPhotos">加载中…</div>');
    Promise.all((p.photos || []).map(function (ph) { return Media.url(ph.id); })).then(function (urls) {
      var box = $('modalPhotos'); if (!box) return;
      box.innerHTML = urls.length ? urls.map(function (u, i) {
        return '<a href="' + u + '" target="_blank" rel="noopener"><img src="' + u + '" alt="' + esc(p.photos[i].name) + '"></a>';
      }).join('') : '<span class="muted">这件包裹没有照片</span>';
    });
  }
  function editParcelDialog(id) {
    if (!guard('inventory')) return;
    var p = store.getParcel(id); if (!p) return;
    var companies = store.listCompanies().map(function (c) {
      return '<option value="' + esc(c.name) + '"' + (c.name === p.carrier ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('');
    var labels = [''].concat(store.listLabels()).map(function (l) {
      return '<option value="' + esc(l) + '"' + (l === p.label ? ' selected' : '') + '>' + esc(l || '无标签') + '</option>';
    }).join('');
    var slots = R.slotList(store.settings()).filter(function (s) { return !store.occupied(s, p.id); });
    var slotOpts = [p.slot].concat(slots).filter(function (v, i, a) { return v && a.indexOf(v) === i; })
      .map(function (s) { return '<option value="' + esc(s) + '"' + (s === p.slot ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('');
    var html = '<div class="form-grid">' +
      '<label>货号<input class="input mono" id="edGoods" value="' + esc(p.goodsNo) + '"></label>' +
      '<label>编号<input class="input mono" id="edSerial" value="' + esc(p.serial) + '"></label>' +
      '<label>运单号<input class="input mono" id="edNo" value="' + esc(p.trackingNo) + '"></label>' +
      '<label>快递公司<select class="input" id="edCarrier">' + companies + '</select></label>' +
      '<label>收件人<input class="input" id="edRecipient" value="' + esc(p.recipient) + '"></label>' +
      '<label>联系电话 / 后四位<input class="input mono" id="edPhone" value="' + esc(p.phone || p.phoneTail) + '"></label>' +
      '<label>货架号<select class="input" id="edSlot">' + slotOpts + '</select></label>' +
      '<label>标签<select class="input" id="edLabel">' + labels + '</select></label>' +
      '<label class="wide">备注<input class="input" id="edNote" value="' + esc(p.note) + '"></label></div>';
    var m = openModal('修改包裹信息', html,
      '<button class="btn btn-ghost" data-modal="close">取消</button><button class="btn btn-primary" data-modal="ok">保存</button>');
    m.querySelector('[data-modal="ok"]').onclick = function () {
      var r = store.updateParcel(id, {
        goodsNo: $('edGoods').value, serial: $('edSerial').value, trackingNo: $('edNo').value,
        carrier: $('edCarrier').value, recipient: $('edRecipient').value, phone: $('edPhone').value,
        slot: $('edSlot').value, label: $('edLabel').value, note: $('edNote').value
      });
      if (!r.ok) { toast(r.error, 'err'); return; }
      closeModal(); afterWrite('包裹信息已保存');
    };
  }
  function companyDialog(id) {
    var c = id ? store.listCompanies().filter(function (x) { return x.id === id; })[0] : null;
    var html = '<div class="form-grid">' +
      '<label>公司名称<input class="input" id="coName" value="' + esc(c ? c.name : '') + '"></label>' +
      '<label>简称（货号用）<input class="input mono" id="coShort" value="' + esc(c ? c.short : '') + '"></label>' +
      '<label class="wide">单号识别正则<input class="input mono" id="coRule" placeholder="^(YT|8\\d{11,})" value="' + esc(c ? c.rule : '') + '"></label>' +
      '</div><label class="switch"><input type="checkbox" id="coEnabled"' + (!c || c.enabled !== false ? ' checked' : '') + '>启用</label>';
    var m = openModal(c ? '编辑快递公司' : '新增快递公司', html,
      '<button class="btn btn-ghost" data-modal="close">取消</button><button class="btn btn-primary" data-modal="ok">保存</button>');
    m.querySelector('[data-modal="ok"]').onclick = function () {
      var r = store.upsertCompany({ id: id || '', name: $('coName').value, short: $('coShort').value,
        rule: $('coRule').value, enabled: $('coEnabled').checked });
      if (!r.ok) { toast(r.error, 'err'); return; }
      closeModal(); afterWrite('快递公司已保存');
    };
  }
  function renumDialog(kind) {
    if (!guard('inventory')) return;
    var list = store.listParcels({ status: 'in', limit: 200 });
    if (!list.length) { toast('没有在库包裹', 'err'); return; }
    var html = '<label>从哪件开始（后面的都会重新累加）<select class="input" id="rnStart">' +
      list.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.goodsNo) + ' · ' + esc(p.trackingNo) + '</option>'; }).join('') +
      '</select></label><label>起始值<input class="input mono" id="rnValue" value="' +
      esc(list[0][kind === 'goods' ? 'goodsNo' : 'serial'] || '1') + '"></label>';
    var m = openModal('批量修改' + (kind === 'goods' ? '货号' : '编号'), html,
      '<button class="btn btn-ghost" data-modal="close">取消</button><button class="btn btn-primary" data-modal="ok">批量修改</button>');
    m.querySelector('[data-modal="ok"]').onclick = function () {
      var patch = {}; patch[kind === 'goods' ? 'goodsNo' : 'serial'] = $('rnValue').value.trim();
      var u = store.updateParcel($('rnStart').value, patch);
      if (!u.ok) { toast(u.error, 'err'); return; }
      var r = store.batchRenum($('rnStart').value, kind);
      closeModal();
      if (!r.ok) { toast(r.error, 'err'); return; }
      afterWrite('已重新编号 ' + r.count + ' 件');
    };
  }
  function supplementDialog() {
    var list = S.quickList.filter(function (p) { return !p.phone || !p.phoneTail; });
    if (!list.length) list = store.listParcels({ status: 'in', limit: 12 }).filter(function (p) { return !p.phoneTail; });
    if (!list.length) { toast('没有需要补录号码的包裹', 'ok'); return; }
    var html = '<div class="muted">未录入号码的件，填完整号码或后四位：</div>' + list.map(function (p) {
      return '<label>' + esc(p.goodsNo) + ' · ' + esc(p.trackingNo) +
        '<input class="input mono" data-tail="' + esc(p.id) + '" placeholder="手机号或后四位"></label>';
    }).join('');
    var m = openModal('补录号码', html,
      '<button class="btn btn-ghost" data-modal="close">取消</button><button class="btn btn-primary" data-modal="ok">保存</button>');
    m.querySelector('[data-modal="ok"]').onclick = function () {
      var n = 0;
      m.querySelectorAll('[data-tail]').forEach(function (el) {
        if (el.value.trim()) {
          var r = store.updateParcel(el.getAttribute('data-tail'), { phone: el.value.trim() });
          if (r.ok) n++;
        }
      });
      closeModal(); afterWrite('已补录 ' + n + ' 件号码');
    };
  }
  function statDayDialog(day) {
    var list = store.listParcels({ from: day, to: day, status: 'all' });
    var out = store.listParcels({ outFrom: day, outTo: day, status: 'all' });
    openModal(day + ' 明细',
      '<div class="muted">入库 ' + list.length + ' 件 · 出库 ' + out.length + ' 件</div>' +
      '<div class="strip-list" style="margin-top:10px">' + (list.concat(out.filter(function (p) { return list.indexOf(p) < 0; })))
        .slice(0, 60).map(function (p) {
          return '<div class="strip-item"><b>' + esc(p.goodsNo) + '</b><span class="grow">' + esc(p.trackingNo) +
            ' · ' + esc(p.carrier) + '</span>' + statusTag(p) + '</div>';
        }).join('') + '</div>');
  }
  function handleAct(act, el) {
    var id = el.getAttribute('data-id');
    if (act === 'detail') detailDialog(id);
    else if (act === 'photos') photosDialog(id);
    else if (act === 'label') printParcels([store.getParcel(id)]);
    else if (act === 'edit') editParcelDialog(id);
    else if (act === 'out') {
      if (!guard('outbound')) return;
      confirmBox('确认出库', '把 ' + (store.getParcel(id) || {}).goodsNo + ' 出库？', function () {
        var r = store.checkout([id], { outType: 'goods' });
        if (r.ok) afterWrite('已出库 ' + r.count + ' 件'); else toast(r.error, 'err');
      });
    } else if (act === 'undoOut') {
      if (!guard('outbound')) return;
      confirmBox('撤销出库', '把这件包裹恢复到在库？', function () {
        var r = store.undoCheckout([id]);
        if (r.ok) afterWrite('已撤销出库'); else toast(r.error, 'err');
      });
    } else if (act === 'undoBatch') {
      if (!guard('outbound')) return;
      var list = store.listParcels({ status: 'all' }).filter(function (p) { return p.batchId === id; });
      confirmBox('撤销本次出库', '恢复 ' + list.length + ' 件到在库？', function () {
        var r = store.undoCheckout(list.map(function (p) { return p.id; }));
        if (r.ok) afterWrite('已撤销 ' + r.count + ' 件出库'); else toast(r.error, 'err');
      });
    } else if (act === 'pickCandidate') {
      var p = store.getParcel(id); if (!p) return;
      S.outSelected[id] = true; $('outKeyword').value = p.goodsNo;
      $('outOcrState').className = 'ocr-state ok';
      $('outOcrState').textContent = '已选 ' + p.goodsNo + ' · ' + p.trackingNo + '，确认后点「确认出库」';
      $('outCandidates').innerHTML = '';
      if (S.outFiles.length) S.outFiles[0].name = R.outboundPhotoName(p);
      renderOutbound();
    } else if (act === 'customerEdit') {
      var c = store.listCustomers({}).filter(function (x) { return x.id === id; })[0]; if (!c) return;
      $('cusId').value = c.id; $('cusName').value = c.name || ''; $('cusPhone').value = c.phone || '';
      $('cusType').value = c.type; $('cusStar').value = c.star || ''; $('cusRemark').value = c.remark || '';
      $('cusName').focus();
    } else if (act === 'customerDel') {
      confirmBox('删除客户', '确定删除这位客户？包裹记录不受影响。', function () {
        store.removeCustomer(id); afterWrite('客户已删除');
      });
    } else if (act === 'companyEdit') companyDialog(id);
    else if (act === 'companyToggle') {
      var co = store.listCompanies().filter(function (x) { return x.id === id; })[0];
      if (co) { store.upsertCompany({ id: id, name: co.name, short: co.short, rule: co.rule, enabled: co.enabled === false }); afterWrite('公司状态已更新'); }
    } else if (act === 'companyDel') {
      confirmBox('删除快递公司', '删除后新入库将不再识别这家公司，已有包裹不受影响。', function () {
        store.removeCompany(id); afterWrite('公司已删除');
      });
    } else if (act === 'accEdit') {
      var a = auth.listAccounts().filter(function (x) { return x.id === id; })[0]; if (!a) return;
      $('accId').value = a.id; $('accName').value = a.name; $('accPw').value = '';
      $('accRole').value = a.role;
      document.querySelectorAll('[data-perm-check]').forEach(function (cb) {
        cb.checked = a.perms.indexOf(cb.getAttribute('data-perm-check')) >= 0;
      });
    } else if (act === 'accDel') {
      confirmBox('删除子账号', '确定删除？该账号将无法再登录。', function () {
        var r = auth.removeAccount(id); if (r.ok) afterWrite('子账号已删除'); else toast(r.error, 'err');
      });
    } else if (act === 'colStatus') {
      var task = store.listCollections({}).filter(function (x) { return x.id === id; })[0]; if (!task) return;
      var next = { pending: 'picked', picked: 'sent', sent: 'done', done: 'pending' }[task.status] || 'pending';
      store.updateCollection(id, { status: next }); afterWrite('任务状态 → ' + next);
    } else if (act === 'colDel') {
      store.removeCollection(id); afterWrite('任务已删除');
    } else if (act === 'uploadRetry') {
      store.retryUpload(id); afterWrite('已重新标记同步记录');
    } else if (act === 'interceptDel') { store.removeIntercept(id); afterWrite('拦截已移除'); }
    else if (act === 'labelDel') {
      var label = el.getAttribute('data-label');
      store.setLabels(store.listLabels().filter(function (x) { return x !== label; }));
      afterWrite('标签已删除');
    } else if (act === 'statDay') statDayDialog(id);
  }

  /* ---------------- 事件绑定 ---------------- */
  function on(id, evt, fn) { var el = $(id); if (el) el.addEventListener(evt, fn); }
  function readFileText(file, cb) {
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () { cb(String(fr.result || '')); };
    fr.readAsText(file);
  }
  function bind() {
    document.querySelectorAll('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { if (!b.disabled) switchView(b.getAttribute('data-view')); });
    });
    document.addEventListener('click', function (e) {
      var go = e.target.closest('[data-go]');
      if (go) { switchView(go.getAttribute('data-go')); return; }
      var act = e.target.closest('[data-act]');
      if (act) { e.preventDefault(); handleAct(act.getAttribute('data-act'), act); return; }
      var mc = e.target.closest('[data-modal="close"]');
      if (mc) { closeModal(); return; }
      if (e.target === $('modalMask')) closeModal();
    });
    on('btnMenu', 'click', function () {
      $('sidebar').classList.toggle('open'); $('sideShade').classList.toggle('on');
    });
    on('sideShade', 'click', function () { $('sidebar').classList.remove('open'); $('sideShade').classList.remove('on'); });
    on('btnLock', 'click', function () { auth.lock(); showGate(); });
    on('btnLogout', 'click', function () { auth.logout(); showGate(); });

    /* 入库 */
    on('formIn', 'submit', submitInbound);
    on('inNo', 'input', syncCarrier);
    on('btnInScan', 'click', function () {
      Media.capture({ title: '扫描面单条码', single: true, prefix: 'RK', torch: store.settings().torch }).then(function (r) {
        if (r.cancelled || !r.files.length) return;
        var f = r.files[0];
        return Media.recognize(f.blob).then(function (d) {
          var code = R.barcodeOf(d);
          if (code) { $('inNo').value = code; syncCarrier(); }
          f.name = R.inboundPhotoName(code);
          S.inFiles.push(f);
          $('inOcrState').hidden = false;
          $('inOcrState').className = 'ocr-state ' + (code ? 'ok' : 'err');
          $('inOcrState').textContent = code ? '识别到条码 ' + code + '，已填入运单号，照片按条码命名'
            : '没读到条码，照片按时间命名，请手输运单号';
          renderInbound();
          toast(code ? '已识别 ' + code : '未识别到条码', code ? 'ok' : 'err');
        });
      });
    });
    on('btnInVoice', 'click', function () {
      Media.listen().then(function (r) {
        if (!r.ok) { toast(r.error, 'err'); return; }
        $('inPhone').value = r.text; syncCarrier(); toast('已录入 ' + r.text, 'ok');
      });
    });
    on('btnInCamera', 'click', function () {
      Media.capture({ title: '入库面单拍照', max: 12, prefix: 'RK', torch: store.settings().torch })
        .then(function (r) { if (!r.cancelled && r.files.length) return nameInFiles(r.files); });
    });
    on('btnInAlbum', 'click', function () { $('inPhotos').click(); });
    on('inPhotos', 'change', function () {
      var files = Array.prototype.slice.call(this.files).map(function (f) { return { blob: f, name: f.name, type: f.type }; });
      if (files.length) nameInFiles(files); this.value = '';
    });
    ['inPhotoPreview', 'outPhotoPreview'].forEach(function (boxId) {
      on(boxId, 'click', function (e) {
        var img = e.target.closest('[data-photo]'); if (!img) return;
        var which = img.getAttribute('data-photo'), idx = Number(img.getAttribute('data-index'));
        var arr = which === 'in' ? S.inFiles : S.outFiles;
        var f = arr[idx]; if (!f) return;
        var m = openModal(f.name, '<img src="' + img.src + '" style="width:100%;border-radius:9px">',
          '<button class="btn btn-ghost" data-modal="close">关闭</button>' +
          '<button class="btn btn-outline" data-modal="remove">移除这张</button>');
        m.querySelector('[data-modal="remove"]').onclick = function () {
          var urls = which === 'in' ? S.inUrls : S.outUrls;
          if (urls[idx]) URL.revokeObjectURL(urls[idx]);
          arr.splice(idx, 1); urls.splice(idx, 1);
          closeModal(); renderAll();
        };
      });
    });
    document.querySelectorAll('#inTabs .tab').forEach(function (b) {
      b.addEventListener('click', function () {
        S.inTab = b.getAttribute('data-tab');
        document.querySelectorAll('#inTabs .tab').forEach(function (x) { x.classList.toggle('on', x === b); });
        ['manual', 'quick', 'batch', 'scan'].forEach(function (t) { $('inPane-' + t).hidden = t !== S.inTab; });
        if (S.inTab === 'quick') $('quickNo').focus();
        if (S.inTab === 'scan') $('scanInNo').focus();
      });
    });
    on('btnUndoLastIn', 'click', function () {
      if (!guard('inbound')) return;
      var target = S.lastInBatchId || (S.lastIn && S.lastIn.id);
      if (!target) { toast('没有可撤销的入库记录', 'err'); return; }
      confirmBox('撤销本次入库', '撤销后记录标记为已撤销，可在台账里查看。', function () {
        var r = store.undoInbound(target);
        if (r.ok) { S.lastIn = null; afterWrite('已撤销入库 ' + r.count + ' 件'); }
        else toast(r.error, 'err');
      });
    });
    on('btnInBatchNum', 'click', function () { renumDialog('serial'); });
    on('quickNo', 'keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (quickAdd(this.value, R.tail4($('quickTail').value))) { this.value = ''; $('quickTail').value = ''; }
      this.focus();
    });
    on('btnQuickSupplement', 'click', supplementDialog);
    on('btnQuickEnd', 'click', function () {
      toast('本次入库结束，共 ' + S.quickList.length + ' 件', 'ok');
      S.quickList = []; renderInbound();
    });
    on('scanInNo', 'keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var v = this.value.trim(); if (!v) return;
      var parts = v.split(/[,，\s]+/).filter(Boolean);
      var r = store.addParcel({ trackingNo: parts[0], phoneTail: parts[1] || '' });
      S.scanInList.unshift({ goodsNo: r.ok ? r.parcel.goodsNo : '失败', text: v + (r.ok ? '' : ' · ' + r.error) });
      S.scanInList = S.scanInList.slice(0, 40);
      if (r.ok) { feedback('in', R.feedbackText('in', r.parcel)); S.lastIn = r.parcel; }
      else feedback('error');
      this.value = ''; renderInbound(); this.focus();
    });
    on('btnBatchPreview', 'click', function () {
      var res = R.parseBatch($('batchText').value);
      S.batchRows = res.rows; S.batchErrors = res.errors;
      $('batchPreview').innerHTML = '<div class="muted">解析 ' + res.total + ' 行：可导入 ' + res.rows.length +
        ' 行，失败 ' + res.errors.length + ' 行</div>' +
        (res.rows.length ? '<div class="strip-list" style="margin-top:8px">' + res.rows.slice(0, 8).map(function (r) {
          return '<div class="strip-item"><b>' + esc(r.trackingNo) + '</b><span class="grow">' +
            esc([r.carrier, r.phone, r.slot, r.note].filter(Boolean).join(' · ')) + '</span></div>';
        }).join('') + '</div>' : '') +
        (res.errors.length ? '<div class="ocr-state err" style="margin-top:8px">' +
          res.errors.map(function (x) { return '第 ' + x.line + ' 行：' + esc(x.text) + '（' + esc(x.reason) + '）'; }).join('<br>') + '</div>' : '');
    });
    on('btnBatchCsv', 'click', function () { $('batchCsvFile').click(); });
    on('batchCsvFile', 'change', function () {
      readFileText(this.files[0], function (t) { $('batchText').value = t; $('btnBatchPreview').click(); });
      this.value = '';
    });
    on('btnBatchImport', 'click', function () {
      if (!guard('inbound')) return;
      var res = R.parseBatch($('batchText').value);
      if (!res.rows.length) { toast('没有可导入的行', 'err'); return; }
      var r = store.batchAdd(res.rows);
      S.lastInBatchId = r.batchId;
      var remain = r.failed.map(function (f) {
        return [f.row.trackingNo, f.row.carrier, f.row.phone, f.row.slot, f.row.note].filter(Boolean).join(',');
      });
      $('batchText').value = remain.join('\n');
      $('batchPreview').innerHTML = '<div class="ocr-state ok">成功 ' + r.count + ' 件，失败 ' + r.failed.length +
        ' 件（失败行已回留在输入框）</div>' + (r.failed.length ? '<div class="ocr-state err">' +
          r.failed.map(function (f) { return esc(f.row.trackingNo) + '：' + esc(f.error); }).join('<br>') + '</div>' : '');
      feedback('in', '批量入库 ' + r.count + ' 件');
      afterWrite('批量入库 ' + r.count + ' 件' + (r.failed.length ? '，失败 ' + r.failed.length + ' 件' : ''));
    });

    /* 出库 */
    document.querySelectorAll('#outTabs .tab').forEach(function (b) {
      b.addEventListener('click', function () { setOutTab(b.getAttribute('data-tab')); });
    });
    on('outKeyword', 'input', renderOutbound);
    on('outKeyword', 'keydown', function (e) {
      if (e.key !== 'Enter' || S.outTab !== 'scan') return;
      e.preventDefault();
      var hits = store.findByCode(this.value.trim());
      if (hits.length === 1) { S.outSelected = {}; S.outSelected[hits[0].id] = true; doCheckout('scan'); this.value = ''; }
      else { toast(hits.length ? '一个码对应 ' + hits.length + ' 件，请手动点选' : '未匹配到在库包裹', 'err'); renderOutbound(); }
    });
    on('btnOutSearch', 'click', renderOutbound);
    on('btnOutSelectAll', 'click', function () {
      store.listParcels({ kw: $('outKeyword').value.trim(), mode: $('outMode').value, status: 'in', limit: 120 })
        .forEach(function (p) { S.outSelected[p.id] = true; });
      renderOutbound();
    });
    on('btnOutClear', 'click', function () { S.outSelected = {}; $('outKeyword').value = ''; renderOutbound(); });
    on('btnOutPhoto', 'click', captureOutProof);
    on('btnOutMerge', 'click', function () {
      var ids = outIds(); if (!ids.length) { toast('先选一件，再按同尾号合并', 'err'); return; }
      var t = (store.getParcel(ids[0]) || {}).phoneTail;
      var same = store.listParcels({ status: 'in' }).filter(function (p) { return p.phoneTail && p.phoneTail === t; });
      same.forEach(function (p) { S.outSelected[p.id] = true; });
      toast(t ? '已合并同尾号 ' + same.length + ' 件' : '这件没有尾号，无法按尾号合并', same.length > 1 ? 'ok' : 'err');
      renderOutbound();
      doCheckout('merge');
    });
    on('btnOutSubmit', 'click', function () { doCheckout(S.outType); });
    on('btnUndoLastOut', 'click', function () {
      if (!guard('outbound')) return;
      if (!S.lastOut) { toast('没有可撤销的本次出库', 'err'); return; }
      confirmBox('撤销本次出库', '恢复 ' + S.lastOut.count + ' 件到在库？', function () {
        var r = store.undoCheckout(S.lastOut.parcels.map(function (p) { return p.id; }));
        if (r.ok) { S.lastOut = null; afterWrite('已撤销出库 ' + r.count + ' 件'); }
        else toast(r.error, 'err');
      });
    });
    on('btnOutCamera', 'click', function () { capturePickup(false); });
    on('btnOutCameraNow', 'click', function () { capturePickup(false); });
    $('outTable').addEventListener('change', function (e) {
      var cb = e.target.closest('[data-out-check]');
      if (cb) toggleOutCheck(cb.getAttribute('data-out-check'), cb.checked);
    });

    /* 查件 / 台账 */
    ['qKw', 'qMode', 'qStatus', 'qCarrier', 'qSlot', 'qLabel', 'qFrom', 'qTo'].forEach(function (id) {
      on(id, 'change', renderQuery); on(id, 'input', renderQuery);
    });
    on('btnQuery', 'click', renderQuery);
    on('btnQueryReset', 'click', function () {
      ['qKw', 'qSlot', 'qFrom', 'qTo'].forEach(function (id) { $(id).value = ''; });
      $('qStatus').value = 'all'; $('qCarrier').value = 'all'; $('qLabel').value = '';
      $('qMode').value = store.settings().queryMode; renderQuery();
    });
    on('btnQueryExport', 'click', function () { download('查件结果-' + R.dayKey() + '.csv', store.exportCSV('parcels', queryArgs()), 'text/csv'); });
    ['invKw', 'invStatus', 'invSort'].forEach(function (id) { on(id, 'change', renderInventory); on(id, 'input', renderInventory); });
    on('btnInvExport', 'click', function () {
      download('库存台账-' + R.dayKey() + '.csv', store.exportCSV('parcels', { kw: $('invKw').value.trim(), status: $('invStatus').value }), 'text/csv');
    });
    on('btnInvAll', 'click', function () { S.invResult.forEach(function (p) { S.invSelected[p.id] = true; }); renderInventory(); });
    $('invTable').addEventListener('change', function (e) {
      var cb = e.target.closest('[data-check]');
      if (cb) { if (cb.checked) S.invSelected[cb.getAttribute('data-check')] = true; else delete S.invSelected[cb.getAttribute('data-check')]; }
    });
    on('btnInvMove', 'click', function () {
      if (!guard('inventory')) return;
      var ids = invIds(); if (!ids.length) { toast('请先勾选包裹', 'err'); return; }
      var slot = $('invMoveSlot').value.trim();
      if (!slot) { toast('请填移库后货架号', 'err'); return; }
      var r = store.moveSlots(ids, slot, { regenGoods: $('invRegen').checked, mode: store.settings().goodsMode });
      if (!r.ok) { toast(r.error, 'err'); return; }
      S.invSelected = {}; afterWrite('已移库 ' + r.count + ' 件 → ' + R.upper(slot));
    });
    on('btnInvRenumSerial', 'click', function () { renumDialog('serial'); });
    on('btnInvRenumGoods', 'click', function () { renumDialog('goods'); });
    on('btnInvPrint', 'click', function () { printParcels(invIds().map(function (id) { return store.getParcel(id); })); });
    on('btnInvOut', 'click', function () {
      if (!guard('outbound')) return;
      var ids = invIds(); if (!ids.length) { toast('请先勾选包裹', 'err'); return; }
      S.outSelected = {}; ids.forEach(function (id) { S.outSelected[id] = true; });
      switchView('outbound');
    });
    on('btnInvDel', 'click', function () {
      if (!guard('inventory')) return;
      var ids = invIds(); if (!ids.length) { toast('请先勾选包裹', 'err'); return; }
      confirmBox('删除记录', '彻底删除 ' + ids.length + ' 条记录？此操作不可撤销。', function () {
        ids.forEach(function (id) { store.removeParcel(id); });
        S.invSelected = {}; afterWrite('已删除 ' + ids.length + ' 条记录');
      });
    });

    /* 收件任务 */
    on('formCollection', 'submit', function (e) {
      e.preventDefault(); if (!guard('collections')) return;
      var r = store.addCollection({ sender: $('colSender').value, senderPhone: $('colSenderPhone').value,
        recipient: $('colRecipient').value, phone: $('colPhone').value, address: $('colAddress').value,
        carrier: $('colCarrier').value, weight: $('colWeight').value, fee: $('colFee').value, note: $('colNote').value });
      if (!r.ok) { toast(r.error, 'err'); return; }
      ['colSender', 'colSenderPhone', 'colRecipient', 'colPhone', 'colAddress', 'colWeight', 'colFee', 'colNote'].forEach(function (id) { $(id).value = ''; });
      afterWrite('收件任务 ' + r.collection.no + ' 已创建');
    });
    on('colFilter', 'change', renderCollections);

    /* 客户 */
    on('formCustomer', 'submit', function (e) {
      e.preventDefault(); if (!guard('customers')) return;
      var r = store.upsertCustomer({ id: $('cusId').value, name: $('cusName').value, phone: $('cusPhone').value,
        type: $('cusType').value, star: $('cusStar').value, remark: $('cusRemark').value });
      if (!r.ok) { toast(r.error, 'err'); return; }
      $('btnCusClear').click(); afterWrite('客户已保存');
    });
    on('btnCusClear', 'click', function () {
      ['cusId', 'cusName', 'cusPhone', 'cusRemark'].forEach(function (id) { $(id).value = ''; });
      $('cusType').value = 'normal'; $('cusStar').value = '';
    });
    ['cusKw', 'cusFilter'].forEach(function (id) { on(id, 'change', renderCustomers); on(id, 'input', renderCustomers); });
    on('btnCusImport', 'click', function () {
      var nums = $('cusNumbers').value.split(/[,，\s]+/).map(function (x) { return x.replace(/\D/g, ''); }).filter(Boolean);
      var ok = 0, bad = [];
      nums.forEach(function (n) {
        if (!R.phoneOk(n)) { bad.push(n); return; }
        var r = store.upsertCustomer({ phone: n }); if (r.ok) ok++;
      });
      $('cusImportState').textContent = '导入 ' + ok + ' 个号码' + (bad.length ? '，不规则号码已跳过：' + bad.join('、') : '');
      $('cusNumbers').value = bad.join('\n');
      afterWrite('已导入 ' + ok + ' 个客户号码');
    });
    on('btnCusDedup', 'click', function () {
      var seen = {}, dup = [];
      store.listCustomers({}).forEach(function (c) {
        var k = c.phone || c.tail;
        if (k && seen[k]) dup.push(c.id); else seen[k] = 1;
      });
      dup.forEach(function (id) { store.removeCustomer(id); });
      afterWrite('已删除 ' + dup.length + ' 条重复客户');
    });
    on('btnCusExport', 'click', function () { download('客户名单-' + R.dayKey() + '.csv', store.exportCSV('customers'), 'text/csv'); });
    on('btnInterceptAdd', 'click', function () {
      var r = store.addIntercept($('interceptNo').value.trim(), '手动添加');
      if (!r.ok) { toast(r.error, 'err'); return; }
      $('interceptNo').value = ''; afterWrite('已添加入库拦截');
    });

    /* 统计 / 打印 / 同步 */
    on('statPreset', 'change', function () { S.statPreset = this.value; renderStats(); });
    ['statFrom', 'statTo'].forEach(function (id) { on(id, 'change', function () { S.statPreset = 'custom'; renderStats(); }); });
    on('statTab', 'change', function () { S.statTab = this.value; renderStats(); });
    on('btnStatsExport', 'click', function () {
      download('每日统计-' + R.dayKey() + '.csv', store.exportCSV('stats', { range: statsRange() }), 'text/csv');
    });
    on('labelW', 'change', function () { store.updateSettings({ labelWidth: Number(this.value) || 80 }); renderPrint(); });
    on('labelH', 'change', function () { store.updateSettings({ labelHeight: Number(this.value) || 50 }); renderPrint(); });
    $('labelFields').addEventListener('change', function (e) {
      var cb = e.target.closest('[data-label-field]'); if (!cb) return;
      var arr = store.settings().labelFields.slice();
      var k = cb.getAttribute('data-label-field');
      arr = cb.checked ? arr.concat([k]).filter(function (x, i, a) { return a.indexOf(x) === i; }) : arr.filter(function (x) { return x !== k; });
      store.updateSettings({ labelFields: arr }); renderPrint();
    });
    on('printKw', 'input', renderPrint);
    on('btnPrintRecent', 'click', function () {
      $('printKw').value = ''; S.printSelected = {};
      store.listParcels({ status: 'all', limit: 10 }).forEach(function (p) { S.printSelected[p.id] = true; });
      renderPrint();
    });
    on('btnPrintAll', 'click', function () {
      store.listParcels({ kw: $('printKw').value.trim(), status: 'all', limit: 20 }).forEach(function (p) { S.printSelected[p.id] = true; });
      renderPrint();
    });
    $('printList').addEventListener('change', function (e) {
      var cb = e.target.closest('[data-print-check]'); if (!cb) return;
      var id = cb.getAttribute('data-print-check');
      if (cb.checked) S.printSelected[id] = true; else delete S.printSelected[id];
      renderPrint();
    });
    on('btnDoPrint', 'click', function () {
      printParcels(Object.keys(S.printSelected).filter(function (k) { return S.printSelected[k]; })
        .map(function (k) { return store.getParcel(k); }));
    });
    ['syncState', 'syncKw'].forEach(function (id) { on(id, 'change', renderSync); on(id, 'input', renderSync); });
    on('btnSyncExport', 'click', function () {
      var rows = [['时间', '货号', '运单号', '动作', '状态', '说明']];
      store.listUploads({}).forEach(function (u) {
        rows.push([R.fmt(u.at), u.goodsNo, u.trackingNo, u.action, u.state, u.note]);
      });
      download('上行文件-' + R.dayKey() + '.csv', '\ufeff' + R.toCSV(rows), 'text/csv');
    });

    /* 设置 */
    on('formSettings', 'submit', function (e) {
      e.preventDefault(); if (!guard('settings')) return;
      store.updateSettings(readSettings());
      $('topStation').textContent = store.settings().stationName;
      S.settingsFilled = false;
      afterWrite('设置已保存');
    });
    ['setSerialMode', 'setGoodsMode', 'setGoodsTemplate', 'setZones', 'setShelves', 'setLevels'].forEach(function (id) {
      on(id, 'change', function () {
        var set = store.settings();
        var preview = R.goodsNumber($('setGoodsMode').value, {
          seq: Number($('setSerialStart').value) || 1, width: Number($('setSerialWidth').value) || 4,
          slot: (($('setZones').value.split(',')[0] || 'A') + '01-01'), tail: '6789', short: 'YT',
          template: $('setGoodsTemplate').value
        });
        $('setNumsPreview').textContent = '示例货号：' + preview + '（保存后生效）';
      });
    });
    on('btnCompanyAdd', 'click', function () { companyDialog(''); });
    on('btnLabelAdd', 'click', function () {
      var v = $('labelNew').value.trim(); if (!v) return;
      store.setLabels(store.listLabels().concat([v])); $('labelNew').value = '';
      afterWrite('标签已添加');
    });
    on('btnBackup', 'click', function () {
      toast('正在打包照片，请稍候…');
      Media.exportAll().then(function (photos) {
        var snap = store.exportSnapshot(); snap.photos = photos;
        download('驿站备份-' + R.dayKey() + '.json', JSON.stringify(snap), 'application/json');
        toast('备份已导出（含 ' + photos.length + ' 张照片）', 'ok');
      });
    });
    on('btnRestore', 'click', function () { $('restoreFile').click(); });
    on('restoreFile', 'change', function () {
      var self = this;
      readFileText(this.files[0], function (t) {
        var obj; try { obj = JSON.parse(t); } catch (e) { toast('备份文件无法解析', 'err'); return; }
        confirmBox('恢复备份', '覆盖当前全部数据？取消则关闭；如需合并请用 README 说明的合并方式。', function () {
          var r = store.restoreSnapshot(obj, 'replace');
          if (!r.ok) { toast(r.error, 'err'); return; }
          if (obj.photos) Media.importAll(obj.photos);
          S.settingsFilled = false;
          store.setActor(auth.status().user || '未登录');
          afterWrite('已恢复 ' + r.parcels + ' 条记录');
          $('topStation').textContent = store.settings().stationName;
          if (!auth.status().logged) showGate();
        });
      });
      self.value = '';
    });
    on('btnImportCsv', 'click', function () { $('importCsvFile').click(); });
    on('importCsvFile', 'change', function () {
      readFileText(this.files[0], function (t) {
        var rows = R.parseCSV(t).slice(1).map(function (c) {
          return { trackingNo: c[0], carrier: c[1], phone: c[2], slot: c[3], note: c[4] };
        }).filter(function (r) { return r.trackingNo; });
        if (!rows.length) { toast('CSV 里没有数据行', 'err'); return; }
        var r = store.batchAdd(rows);
        afterWrite('CSV 导入 ' + r.count + ' 件，失败 ' + r.failed.length + ' 件');
      });
      this.value = '';
    });
    on('btnExportCsv', 'click', function () { download('包裹台账-' + R.dayKey() + '.csv', store.exportCSV('parcels', {}), 'text/csv'); });
    on('btnPhotoExport', 'click', function () {
      Media.exportAll().then(function (photos) {
        download('照片数据-' + R.dayKey() + '.json', JSON.stringify(photos), 'application/json');
        toast('已导出 ' + photos.length + ' 张照片数据', 'ok');
      });
    });
    on('btnClearAll', 'click', function () {
      confirmBox('清空全部数据', '包裹、客户、账号、照片引用、流水都会被清空，且不可撤销。建议先导出备份！', function () {
        store.clearAll(); S.settingsFilled = false; S.invSelected = {}; S.outSelected = {};
        auth.logout(); showGate();
        toast('已清空，请重新初始化本站', 'ok');
      });
    });

    /* 账号 / 流水 */
    on('formAccount', 'submit', function (e) {
      e.preventDefault(); if (!guard('accounts')) return;
      var perms = [];
      document.querySelectorAll('[data-perm-check]').forEach(function (cb) {
        if (cb.checked) perms.push(cb.getAttribute('data-perm-check'));
      });
      var id = $('accId').value;
      var r = id ? auth.updateAccount(id, { password: $('accPw').value || undefined, role: $('accRole').value, perms: perms })
        : auth.addAccount({ name: $('accName').value, password: $('accPw').value, role: $('accRole').value, perms: perms });
      if (!r.ok) { toast(r.error, 'err'); return; }
      $('btnAccClear').click(); afterWrite('子账号已保存');
    });
    on('btnAccClear', 'click', function () {
      ['accId', 'accName', 'accPw'].forEach(function (id) { $(id).value = ''; });
      $('accRole').value = 'operator';
      document.querySelectorAll('[data-perm-check]').forEach(function (cb) {
        cb.checked = Auth.OPERATOR_DEFAULT.indexOf(cb.getAttribute('data-perm-check')) >= 0;
      });
    });
    on('btnMyPw', 'click', function () {
      var me = auth.current(); if (!me) return;
      var r = auth.updateAccount(me.id, { password: $('myPw').value });
      if (!r.ok) { toast(r.error, 'err'); return; }
      $('myPw').value = ''; toast('密码已修改', 'ok');
    });
    on('btnDiag2', 'click', function () {
      var d = auth.diag();
      d.storage = { db: DB.KEY, ok: store.storageOk(), parcels: store.listParcels({ status: 'all' }).length };
      d.media = Media.engines();
      d.bootErrors = window.StationBoot ? window.StationBoot.errors() : [];
      try { d.nativeLog = (window.StationNative && window.StationNative.crashLog) ? window.StationNative.crashLog() : ''; }
      catch (e) { d.nativeLog = ''; }
      $('appDiag').hidden = false; $('appDiag').textContent = JSON.stringify(d, null, 2);
    });
    ['logKw', 'logAction'].forEach(function (id) { on(id, 'change', renderLogs); on(id, 'input', renderLogs); });
    on('btnLogExport', 'click', function () {
      download('操作流水-' + R.dayKey() + '.csv',
        store.exportCSV('logs', { kw: $('logKw').value.trim(), action: $('logAction').value }), 'text/csv');
    });

    /* 键盘遮挡：把软键盘高度写进 CSS 变量 */
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        var kb = Math.max(0, window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop);
        document.documentElement.style.setProperty('--kb', kb + 'px');
      });
    }
    ['click', 'keydown', 'touchstart'].forEach(function (evt) {
      document.addEventListener(evt, function () { S.lastActive = Date.now(); }, { passive: true });
    });
  }

  function bindIdle() {
    if (S.idleTimer) clearInterval(S.idleTimer);
    S.idleTimer = setInterval(function () {
      var m = Number(store.settings().idleMinutes) || 15;
      if (auth.status().logged && Date.now() - S.lastActive > m * 60000) {
        auth.lock(); showGate(); toast('闲置超时，已锁屏');
      }
    }, 30000);
  }

  /* ---------------- 启动 ---------------- */
  try {
    bindGate();
    bind();
    if (auth.status().logged) enterApp(); else showGate();
  } catch (e) {
    reportBoot('启动失败', e);
    try { showGate(); } catch (e2) { }
  }
  window.StationApp = {
    store: store, auth: auth, state: S, switchView: switchView, renderAll: renderAll,
    rules: R, media: Media, version: '2.0.2',
    bootErrors: function () { return window.StationBoot ? window.StationBoot.errors() : []; }
  };
})();
