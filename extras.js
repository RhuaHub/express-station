/* 驿站助手（重建版 2.3.0）· 扩展功能
   对应原版「出库任务 / 代收管理 / 充值账单 / 服务中心」等页面。
   纯 ES5、零依赖、按需渲染：切到某个视图才渲染那一个，绝不一次性重绘全部。
   所有数据只写本机 localStorage（db.extras），照片只写 IndexedDB，不联网；
   2.2.0 起短信 / 电话 / 微信通知由独立的 notify.js 实现，本模块不再声称「排除通知」。 */
(function (global) {
  'use strict';

  var C = null;
  var ST = {
    taskPool: [], taskSelected: {}, taskCurrent: '', taskLoaded: false,
    stationLoaded: false, walletLoaded: false, qrText: '', faqKw: ''
  };

  function E() {
    var db = C.store.raw();
    if (!db.extras) db.extras = { station: {}, tasks: [], wallet: { records: [] }, feedbacks: [], templates: [], queryHistory: [], activities: [], notices: [] };
    if (!db.extras.station) db.extras.station = {};
    if (!db.extras.wallet) db.extras.wallet = { records: [] };
    if (!Array.isArray(db.extras.wallet.records)) db.extras.wallet.records = [];
    ['tasks', 'feedbacks', 'templates', 'queryHistory', 'activities', 'notices'].forEach(function (k) {
      if (!Array.isArray(db.extras[k])) db.extras[k] = [];
    });
    return db.extras;
  }
  function $(id) { return C.$(id); }
  function esc(s) { return C.esc(String(s === undefined || s === null ? '' : s)); }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function setVal(id, v) { var el = $(id); if (el) el.value = v === undefined || v === null ? '' : String(v); }
  function num(id) { var n = Number(val(id)); return isFinite(n) ? n : 0; }
  function money(n) { return '¥' + (Number(n) || 0).toFixed(2); }
  function uid(p) { return C.R.uid(p || 'x'); }
  function now() { return C.R.iso(); }
  function fmt(s) { return C.R.fmt(s, false); }
  function step(t) { try { C.step('扩展 · ' + t); } catch (e) { } }
  function persist(msg, action, text) {
    if (action) { try { C.store.log(action, text || msg); } catch (e) { } }
    try { C.afterWrite(msg); } catch (e) { C.store.save(); C.toast(msg, 'ok'); }
  }
  function strip(id, html, empty) {
    var el = $(id); if (el) el.innerHTML = html || '<div class="muted">' + esc(empty || '暂无数据') + '</div>';
  }
  function csv(name, head, rows) {
    var q = function (v) { return '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"'; };
    var text = '\ufeff' + head.map(q).join(',') + '\r\n' +
      rows.map(function (r) { return r.map(q).join(','); }).join('\r\n');
    C.download(name, text, 'text/csv');
  }
  function confirmBox(title, msg, ok) { C.confirmBox(title, msg, ok); }
  function qrSVG(text, size) {
    var Q = global.StationQr;
    if (!Q || typeof Q.svg !== 'function') return '';
    try { return Q.svg(text, { size: size || 220, margin: 2 }); } catch (e) { return ''; }
  }

  /* ==================== 出库任务 ==================== */
  var TASK_LABEL = { open: '待出库', done: '已完成' };
  function taskById(id) {
    var list = E().tasks, i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function inStock(kw) {
    var list = C.store.listParcels({ status: 'in' }) || [];
    if (kw) {
      var k = kw.toLowerCase();
      list = list.filter(function (p) {
        return ([p.goodsNo, p.trackingNo, p.phoneTail, p.recipient, p.serial, p.slot].join(' ')).toLowerCase().indexOf(k) >= 0;
      });
    }
    return list.slice(0, 200);
  }
  function renderPool() {
    var box = $('taskPool'), ids = ST.taskPool, i;
    if (!box) return;
    if (!ids.length) {
      box.innerHTML = '<div class="muted">点「筛选在库件」加载包裹，可勾选后创建任务。默认不自动列出，避免老设备一次渲染过多数据。</div>';
    } else {
      var h = [];
      for (i = 0; i < ids.length; i++) {
        var p = C.store.getParcel(ids[i]); if (!p) continue;
        h.push('<label class="pool-row"><input type="checkbox" data-task-check="' + esc(p.id) + '"' +
          (ST.taskSelected[p.id] ? ' checked' : '') + '><span class="mono">' + esc(p.goodsNo) + '</span>' +
          '<span>' + esc(p.carrier) + ' · ' + esc(p.trackingNo) + '</span><span class="muted">' + esc(p.slot) + '</span></label>');
      }
      box.innerHTML = h.join('') || '<div class="muted">没有符合条件的在库件</div>';
    }
    var n = 0; Object.keys(ST.taskSelected).forEach(function (k) { if (ST.taskSelected[k]) n++; });
    if ($('taskPoolCount')) $('taskPoolCount').textContent = '候选 ' + ids.length + ' 件 · 已选 ' + n + ' 件';
  }
  function renderTaskList() {
    var filter = val('taskFilter') || 'all';
    var list = E().tasks.filter(function (t) { return filter === 'all' || t.status === filter; });
    list.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    strip('taskList', list.map(function (t) {
      return '<div class="strip-item' + (t.id === ST.taskCurrent ? ' on' : '') + '" data-act="x-taskOpen" data-id="' + esc(t.id) + '">' +
        '<div><b>' + esc(t.name) + '</b><span class="muted"> · ' + esc(fmt(t.at)) + ' · ' + (t.ids || []).length + ' 件</span></div>' +
        '<div class="row"><span class="tag ' + (t.status === 'done' ? 'ok' : 'warn') + '">' + esc(TASK_LABEL[t.status] || t.status) + '</span>' +
        '<span class="muted">' + esc(t.note || '') + '</span></div></div>';
    }).join(''), '还没有任务，先在左侧创建');
  }
  function renderTaskDetail() {
    var t = taskById(ST.taskCurrent), rows = [];
    if ($('taskDetailTitle')) $('taskDetailTitle').textContent = t ? t.name + ' · ' + (t.ids || []).length + ' 件 · ' + (TASK_LABEL[t.status] || '') : '点上方任务查看明细';
    if (t) {
      (t.ids || []).slice(0, 200).forEach(function (id) {
        var p = C.store.getParcel(id); if (!p) return;
        rows.push({
          id: p.id,
          cells: [esc(p.goodsNo), esc(p.trackingNo), esc(p.carrier), esc(p.slot),
            esc(p.recipient || '—'), C.statusTag(p), esc(fmt(p.inAt))]
        });
      });
    }
    C.table('taskDetailTable', ['货号', '运单号', '公司', '货架', '收件人', '状态', '入库时间'],
      rows, { empty: t ? '任务内没有可查到的包裹' : '请先选择一个任务' });
  }
  function renderTasks() {
    renderPool(); renderTaskList(); renderTaskDetail();
  }
  function loadPool() {
    ST.taskPool = inStock(val('taskKw')).map(function (p) { return p.id; });
    ST.taskSelected = {};
    renderPool();
    C.toast('已列出 ' + ST.taskPool.length + ' 件在库包裹', 'ok');
  }
  function createTask() {
    if (!C.guard('tasks')) return;
    var name = val('taskName');
    if (!name) { C.toast('请填任务名称', 'err'); return; }
    var ids = Object.keys(ST.taskSelected).filter(function (k) { return ST.taskSelected[k]; });
    if (!ids.length) ids = ST.taskPool.slice();
    ids = ids.filter(function (id) { var p = C.store.getParcel(id); return p && p.status === 'in'; });
    if (!ids.length) { C.toast('请先点「筛选在库件」并勾选包裹', 'err'); return; }
    var t = { id: uid('tk'), name: name, note: val('taskNote'), ids: ids, status: 'open', at: now(), doneAt: '', operator: C.store.getActor() };
    E().tasks.unshift(t); ST.taskCurrent = t.id; ST.taskSelected = {};
    setVal('taskName', ''); setVal('taskNote', '');
    persist('已创建任务「' + name + '」共 ' + ids.length + ' 件', 'task', '创建出库任务：' + name);
  }
  function taskCheckout() {
    if (!C.guard('outbound')) return;
    var t = taskById(ST.taskCurrent);
    if (!t || t.status === 'done') { C.toast('请先选择一个待出库任务', 'err'); return; }
    var ids = (t.ids || []).filter(function (id) { var p = C.store.getParcel(id); return p && p.status === 'in'; });
    if (!ids.length) { C.toast('任务内已没有在库包裹', 'err'); return; }
    var self = this;
    confirmBox('按任务出库', '将任务「' + t.name + '」中 ' + ids.length + ' 件一次性出库？', function () {
      var r = C.store.checkout(ids, { outType: 'task', pickupBy: '', note: '出库任务：' + t.name });
      if (!r || !r.ok) { C.toast((r && r.error) || '出库失败', 'err'); return; }
      t.status = 'done'; t.doneAt = now();
      persist('任务出库完成，共 ' + r.count + ' 件', 'task', '按任务出库：' + t.name);
    });
  }
  function taskDelete() {
    if (!C.guard('tasks')) return;
    var t = taskById(ST.taskCurrent); if (!t) { C.toast('请先选择任务', 'err'); return; }
    confirmBox('删除任务', '删除「' + t.name + '」？包裹记录不受影响。', function () {
      E().tasks = E().tasks.filter(function (x) { return x.id !== t.id; });
      ST.taskCurrent = '';
      persist('任务已删除', 'task', '删除出库任务：' + t.name);
    });
  }

  /* ==================== 驿站档案 ==================== */
  var PHOTO_LABEL = { storeFront: '门头照', idFront: '身份证人像面', idBack: '身份证国徽面' };
  var PHOTO_KEYS = ['storeFront', 'idFront', 'idBack'];
  function stationFormFill() {
    if (ST.stationLoaded) return;
    var s = E().station;
    setVal('stName', s.name || C.store.settings().stationName || '');
    setVal('stContact', s.contact || ''); setVal('stAddress', s.address || '');
    setVal('stHours', s.hours || ''); setVal('stOpened', s.opened ? '1' : '0');
    setVal('stServices', (s.services || []).join('\n'));
    setVal('stRealName', s.realName || ''); setVal('stIdNo', s.idNo || '');
    setVal('stDelayMin', s.delayMinutes === undefined ? 30 : s.delayMinutes);
    var cb = $('stDelay'); if (cb) cb.checked = !!s.delayUpload;
    ST.stationLoaded = true;
  }
  function renderPartners() {
    var el = $('stPartners'); if (!el) return;
    var chosen = E().station.partners || [];
    el.innerHTML = C.store.listCompanies().map(function (co) {
      return '<label class="inline"><input type="checkbox" data-partner="' + esc(co.name) + '"' +
        (chosen.indexOf(co.name) >= 0 ? ' checked' : '') + '> ' + esc(co.name) + '</label>';
    }).join('') || '<span class="muted">还没有快递公司，请到「设置 → 快递公司管理」添加</span>';
  }
  function renderStationPhotos() {
    var s = E().station, out = [];
    PHOTO_KEYS.forEach(function (k) {
      var id = s[k];
      out.push('<div class="strip-item"><div><b>' + PHOTO_LABEL[k] + '</b> ' +
        (id ? '<span class="tag ok">已上传</span>' : '<span class="muted">未上传</span>') + '</div>' +
        (id ? '<button class="btn btn-ghost btn-sm" data-act="x-stPhotoDel" data-kind="' + k + '">移除</button>' : '') + '</div>');
    });
    strip('stPhotos', out.join(''), '暂无证件照片');
  }
  function renderQrBox() {
    var el = $('stQrBox'); if (!el) return;
    if (!ST.qrText) { el.innerHTML = '<div class="muted">输入货号 / 取件码后点「生成二维码」，可打印成取件海报。</div>'; return; }
    var svg = qrSVG(ST.qrText, 220);
    el.innerHTML = svg
      ? '<div class="qr-card"><div class="qr-img">' + svg + '</div><div class="qr-meta"><b>' + esc(E().station.name || C.store.settings().stationName || '快递驿站') + '</b>' +
        '<p>取件码</p><div class="qr-code">' + esc(ST.qrText) + '</div><p class="muted">出示此码或报取件码即可取件</p></div></div>'
      : '<div class="muted">二维码模块未加载，请检查 ocr.js / qr.js 是否完整</div>';
  }
  function renderStation() {
    stationFormFill();
    var s = E().station;
    if ($('stationState')) $('stationState').textContent = s.opened ? '代收已登记（本机标记）' : '代收未开通（本机标记）';
    renderPartners(); renderStationPhotos(); renderQrBox();
  }
  function saveStationBase() {
    if (!C.guard('station')) return;
    var s = E().station;
    s.name = val('stName'); s.contact = val('stContact'); s.address = val('stAddress');
    s.hours = val('stHours'); s.opened = val('stOpened') === '1';
    if (s.opened && !s.openedAt) s.openedAt = now();
    s.services = val('stServices').split(/\n+/).map(function (x) { return x.trim(); }).filter(function (x) { return !!x; });
    if (s.name) C.store.updateSettings({ stationName: s.name });
    ST.stationLoaded = false;
    persist('驿站信息已保存', 'station', '修改驿站档案');
  }
  function saveStationId() {
    if (!C.guard('station')) return;
    var s = E().station;
    s.realName = val('stRealName'); s.idNo = val('stIdNo');
    ST.stationLoaded = false;
    persist('实名资料已保存到本机', 'station', '修改实名资料');
  }
  function uploadStationPhoto(kind) {
    if (!PHOTO_LABEL[kind]) return;
    if (!C.Media || typeof C.Media.pickFiles !== 'function') { C.toast('照片模块不可用', 'err'); return; }
    C.Media.pickFiles({ multiple: false }).then(function (files) {
      if (!files || !files.length) return;
      return C.Media.put(files[0].blob, PHOTO_LABEL[kind] + '.jpg', 'station:' + kind).then(function (r) {
        if (!r || !r.ok) { C.toast('照片保存失败', 'err'); return; }
        var s = E().station, old = s[kind];
        s[kind] = r.id;
        if (old && C.Media.del) { try { C.Media.del(old); } catch (e) { } }
        persist(PHOTO_LABEL[kind] + '已保存到本机', 'station', '上传' + PHOTO_LABEL[kind]);
      });
    }).catch(function (e) { C.toast('照片读取失败：' + ((e && e.message) || '设备不支持'), 'err'); });
  }
  function saveStationSync() {
    if (!C.guard('station')) return;
    var s = E().station, chosen = [];
    var nodes = document.querySelectorAll('[data-partner]');
    for (var i = 0; i < nodes.length; i++) if (nodes[i].checked) chosen.push(nodes[i].getAttribute('data-partner'));
    s.partners = chosen;
    s.delayUpload = !!($('stDelay') && $('stDelay').checked);
    s.delayMinutes = Math.max(0, num('stDelayMin'));
    persist('合作公司与延迟上传策略已保存', 'station', '修改合作公司 / 延迟上传');
  }
  function qrPrint() {
    if (!ST.qrText) { C.toast('请先生成二维码', 'err'); return; }
    var root = $('printRoot'); if (!root) return;
    var svg = qrSVG(ST.qrText, 320);
    root.innerHTML = '<div class="qr-card"><div class="qr-img">' + svg + '</div><div class="qr-meta"><b>' +
      esc(E().station.name || '快递驿站') + '</b><p>取件码</p><div class="qr-code">' + esc(ST.qrText) + '</div></div></div>';
    try { global.print(); } catch (e) { C.toast('打印未启动，请长按图片保存', 'err'); }
  }

  /* ==================== 账本资费 ==================== */
  function records() { return E().wallet.records; }
  function balance() {
    var n = 0;
    records().forEach(function (r) { n += Number(r.amount) || 0; });
    return n;
  }
  var REC_LABEL = { recharge: '充值', proxy: '替他人充值', bill: '账单支出', reward: '活动奖励' };
  function addRecord(type, title, amount, note) {
    records().unshift({ id: uid('wr'), type: type, title: title, amount: Number(amount) || 0,
      note: note || '', at: now(), actor: C.store.getActor() });
  }
  function fillWalletForm() {
    if (ST.walletLoaded) return;
    var w = E().wallet;
    setVal('walFeeIn', w.feePerIn || 0); setVal('walFeeOut', w.feePerOut || 0);
    var sel = $('walRange');
    if (sel && !sel.options.length) {
      sel.innerHTML = [['today', '今天'], ['week', '最近一周'], ['month', '本月'], ['all', '全部']].map(function (x) {
        return '<option value="' + x[0] + '">' + x[1] + '</option>';
      }).join('');
      sel.value = 'today';
    }
    ST.walletLoaded = true;
  }
  function renderWalletTable() {
    var filter = val('walFilter') || 'all';
    var list = records().filter(function (r) { return filter === 'all' || r.type === filter; });
    var rows = list.slice(0, 300).map(function (r) {
      return { id: r.id, cells: [esc(fmt(r.at)), esc(REC_LABEL[r.type] || r.type), esc(r.title),
        (Number(r.amount) >= 0 ? '<span class="up">+' : '<span class="down">') + money(r.amount) + '</span>',
        esc(r.actor || ''), esc(r.note || ''),
        '<button class="btn btn-ghost btn-sm" data-act="x-walDel" data-id="' + esc(r.id) + '">删除</button>'] };
    });
    C.table('walTable', ['时间', '类型', '摘要', '金额', '操作人', '备注', '操作'], rows, { empty: '暂无账单记录' });
  }
  function renderActivities() {
    strip('actList', E().activities.slice(0, 50).map(function (a) {
      return '<div class="strip-item"><div><b>' + esc(a.title) + '</b><span class="muted"> · ' + esc(fmt(a.at)) + '</span></div>' +
        '<div class="row"><span class="tag ok">' + money(a.amount) + '</span>' +
        '<button class="btn btn-ghost btn-sm" data-act="x-actDel" data-id="' + esc(a.id) + '">删除</button></div></div>';
    }).join(''), '还没有活动 / 奖励记录');
  }
  function renderWallet() {
    fillWalletForm();
    var b = balance(), rs = records(), inc = 0, out = 0;
    rs.forEach(function (r) { if (Number(r.amount) >= 0) inc += Number(r.amount); else out -= Number(r.amount); });
    if ($('walBalance')) $('walBalance').textContent = money(b);
    if ($('walSummary')) $('walSummary').textContent = rs.length + ' 笔 · 收入 ' + money(inc) + ' · 支出 ' + money(out);
    if ($('walFeeText')) $('walFeeText').textContent = '资费说明：入库每件 ' + money(E().wallet.feePerIn) +
      '，出库每件 ' + money(E().wallet.feePerOut) + '。结算按时间范围内的实际出入库件数生成一笔本机账单，不产生真实扣费。';
    renderWalletTable(); renderActivities();
  }
  function recharge() {
    if (!C.guard('wallet')) return;
    var a = num('walAmount');
    if (!(a > 0)) { C.toast('请输入大于 0 的金额', 'err'); return; }
    var note = val('walNote');
    addRecord(note ? 'proxy' : 'recharge', note ? '替 ' + note + ' 充值' : val('walWay') + '充值', a, note);
    setVal('walAmount', ''); setVal('walNote', '');
    persist('已记一笔充值 ' + money(a) + '（仅本机记账）', 'wallet', '记录充值');
  }
  function saveFee() {
    if (!C.guard('wallet')) return;
    E().wallet.feePerIn = Math.max(0, num('walFeeIn'));
    E().wallet.feePerOut = Math.max(0, num('walFeeOut'));
    persist('资费已保存', 'wallet', '修改资费');
  }
  function rangeDays(key) {
    if (key === 'today') return 1;
    if (key === 'week') return 7;
    if (key === 'month') return 30;
    return 0;
  }
  function settle() {
    if (!C.guard('wallet')) return;
    var days = rangeDays(val('walRange') || 'today');
    var from = days ? Date.now() - days * 86400000 : 0;
    var all = C.store.listParcels({ status: 'all' }) || [];
    var ic = 0, oc = 0;
    var ms = function (v) { var t = v ? new Date(v).getTime() : 0; return isNaN(t) ? 0 : t; };
    all.forEach(function (p) {
      if (ms(p.inAt) >= from) ic += Number(p.count) || 1;
      if (p.outAt && ms(p.outAt) >= from && p.status === 'out') oc += Number(p.count) || 1;
    });
    var amount = ic * (E().wallet.feePerIn || 0) + oc * (E().wallet.feePerOut || 0);
    if (amount <= 0) { C.toast('该范围内没有产生费用（件数为 0 或资费为 0）', 'err'); return; }
    addRecord('bill', '入库 ' + ic + ' 件 / 出库 ' + oc + ' 件结算', -amount, val('walRange'));
    persist('已生成结算账单 ' + money(amount), 'wallet', '按件数结算');
  }
  function walletExport() {
    csv('账本流水.csv', ['时间', '类型', '摘要', '金额', '操作人', '备注'],
      records().map(function (r) { return [r.at, REC_LABEL[r.type] || r.type, r.title, r.amount, r.actor, r.note]; }));
  }

  /* ==================== 服务中心 ==================== */
  var FAQ = [
    ['第一次打开怎么建账号？', '登录页点「初始化本站（创建站长账号）」，只有站长能添加子账号，不开放注册。'],
    ['换手机 / 换浏览器数据会同步吗？', '不会。数据只存当前浏览器，请到「设置 → 数据备份」导出 JSON，在新设备登录页导入。'],
    ['清除浏览器数据会怎样？', '台账、客户、账号、设置、照片会一起清掉，务必先导出备份。'],
    ['忘记密码怎么办？', '本机不存明文密码、也没有找回服务器。请用备份文件恢复，或由站长在「子账号」里重置该账号密码。'],
    ['拍照识别不出条码？', '2.3.0 起开镜头后会连续自动识别，把面单一维条码放进框内、拿稳手机，命中即自动拍照；倾斜、模糊、光线不均也能解。支持 Code128 / EAN-13 / UPC-A / ITF / Code39 与二维码。只读到面单印刷数字时页面会明确提示「可能缺前缀，请核对」，不会冒充条码；完全读不到可重拍或直接手输。'],
    ['货号结尾为什么必须是数字？', '货号规则要求以数字结尾，便于按尾号找货；可在「设置 → 编号货号规则」切换模式或写自定义模板。'],
    ['一码多件怎么处理？', '扫描出库命中多件时只列候选，不会自动出库，需人工勾选确认，避免错取。'],
    ['入库后想改货架？', '在「库存台账」点「移库」，可换货架并选择是否重算货号，每次移库都留流水。'],
    ['出库错了能撤销吗？', '可以。出库凭证 / 台账里点「撤销出库」或「撤销本次出库」，包裹恢复到在库状态。'],
    ['短信 / 电话通知怎么用？', '2.2.0 已全面实现：通知中心切通道、短信群发与电话通知页都能用。默认跳系统短信 / 拨号应用由你最后确认；想自动直发需切「本机直发」并授权 SEND_SMS / CALL_PHONE，每次群发仍有二次确认、免打扰与限额。'],
    ['微信取件通知会自动推送吗？', '不会。公众号模板消息需要认证公众号与服务端，本页只生成本机文案与取件二维码，页面明确标注不联网、不代表已推送。'],
    ['充值和账单是真的扣钱吗？', '不是。「账本资费」只是本机记账，不接支付、不联网，用于自己记流水与按件数对账。'],
    ['实名资料会上传吗？', '不会。门头照 / 证件照只存本机 IndexedDB，页面上的「代收开通」只是本机登记状态，不做联网实名核验。'],
    ['标签能直接连蓝牙打印机吗？', '厂商蓝牙 SDK 无法在纯静态版里内置，改为系统打印：勾选字段后点打印，用系统打印对话框选择已配对的打印机；标签含可扫的 Code39 条码与二维码。'],
    ['离线能用吗？', '能。所有脚本与资源都打进 APK / PWA 缓存，首次加载后断网照常使用，照片也只存本机。']
  ];
  var GUIDE = [
    ['1 · 初始化', '首次打开创建站长账号；到「设置」填驿站名称、货架区与编号货号规则。'],
    ['2 · 补基础数据', '「设置 → 快递公司管理」维护识别规则；「客户管理」可批量导入号码；「驿站档案」登记合作公司与资料。'],
    ['3 · 入库', '手动 / 极速 / 批量 / 扫码枪四种录法；拍照可自动识别条码并按码命名照片。'],
    ['4 · 出库', '取件出库五种模式，支持合并出库、扫描出库、出库任务整批出库、退件与撤销。'],
    ['5 · 查件与统计', '查件页多条件组合查询；业务统计按 13 种时间范围算出库率、工作量与每日明细。'],
    ['6 · 备份', '定期到「设置 → 数据备份」导出 JSON；换设备时在登录页导入，避免数据丢失。']
  ];
  function renderFaq() {
    var k = ST.faqKw.toLowerCase();
    var list = FAQ.filter(function (x) { return !k || (x[0] + x[1]).toLowerCase().indexOf(k) >= 0; });
    strip('faqList', list.map(function (x) {
      return '<div class="faq-item"><b>' + esc(x[0]) + '</b><p>' + esc(x[1]) + '</p></div>';
    }).join(''), '没有匹配的问题');
  }
  function renderFeedback() {
    strip('fbList', E().feedbacks.slice(0, 50).map(function (f) {
      return '<div class="strip-item"><div><b>' + esc(f.text.slice(0, 40)) + '</b><span class="muted"> · ' + esc(fmt(f.at)) +
        ' · ' + (f.status === 'replied' ? '已回复' : '待处理') + '</span></div>' +
        '<div class="row"><button class="btn btn-ghost btn-sm" data-act="x-fbReply" data-id="' + esc(f.id) + '">' +
        (f.status === 'replied' ? '查看回复' : '回复') + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="x-fbDel" data-id="' + esc(f.id) + '">删除</button></div>' +
        (f.reply ? '<div class="muted">回复：' + esc(f.reply) + '</div>' : '') + '</div>';
    }).join(''), '还没有反馈记录');
  }
  function renderService() {
    renderFaq(); renderFeedback();
    strip('guideList', GUIDE.map(function (x) {
      return '<div class="faq-item"><b>' + esc(x[0]) + '</b><p>' + esc(x[1]) + '</p></div>';
    }).join(''), '暂无指南');
    var box = $('aboutBox');
    if (box) {
      box.innerHTML = '<p><b>驿站助手 · 重建版 2.3.0</b>（build 20）：对照原版功能重建，纯静态、零后端、零上传。</p>' +
        '<p>短信群发、短信模板与签名、短信历史与失败重发、扫码发短信、电话直拨 / 回拨 / 顺序群呼、通话记录与未接来电、语音通知模板、微信取件文案与二维码全部可用；业务、任务、档案、账本、打印、查询、统计、服务功能同样齐备。</p>' +
        '<p>通知默认走系统短信 / 拨号应用由人最后确认；本机直发 / 直拨需运行时授权，带免打扰、单批与每日限额、逐批二次确认与完整流水。App 不联网调用第三方通知接口、不上传号码。</p>' +
        '<p>依赖服务端合作、支付、实名核验、运营商或厂商 SDK 的能力（微信模板消息、隐私号中转、语音外呼、蓝牙 SDK 等），均以「本机登记 / 记账 / TTS 试听 / 系统打印」等价实现，页面会明确标注，不会假装已联网完成。</p>' +
        '<p>数据与账号全部保存在当前设备，清除浏览器数据会一并清空，请定期备份。本软件按「现状」提供，不对数据丢失、短信费用或经营损失承担责任。</p>' +
        '<p>联系我们：驿站联系方式由站长在「驿站档案」里维护；意见反馈可在本页记录并导出后自行提交。本页面不发起联网客服会话。</p>';
    }
  }
  function fbSave() {
    if (!C.guard('service')) return;
    var text = val('fbText');
    if (!text) { C.toast('请填写反馈内容', 'err'); return; }
    E().feedbacks.unshift({ id: uid('fb'), text: text, contact: val('fbContact'), at: now(), status: 'open', reply: '' });
    setVal('fbText', ''); setVal('fbContact', '');
    persist('反馈已保存到本机', 'service', '新增意见反馈');
  }
  function fbReply(id) {
    var list = E().feedbacks, f = null, i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) f = list[i];
    if (!f) return;
    var m = C.openModal('处理反馈', '<div class="form-grid"><label class="wide">反馈内容<textarea class="input" id="fbEditText" rows="3">' + esc(f.text) + '</textarea></label>' +
      '<label class="wide">处理回复<textarea class="input" id="fbReplyText" rows="3" placeholder="填写处理结果（只存本机）">' + esc(f.reply || '') + '</textarea></label></div>',
      '<button class="btn btn-ghost" data-modal="close">取消</button><button class="btn btn-primary" data-modal="ok">保存</button>');
    var btn = m && m.querySelector ? m.querySelector('[data-modal="ok"]') : null;
    if (btn) btn.onclick = function () {
      f.text = val('fbEditText') || f.text;
      f.reply = val('fbReplyText');
      f.status = f.reply ? 'replied' : 'open';
      f.replyAt = now();
      C.closeModal();
      persist('反馈已更新', 'service', '回复意见反馈');
    };
  }
  function fbExport() {
    csv('意见反馈.csv', ['时间', '内容', '联系方式', '状态', '回复'],
      E().feedbacks.map(function (f) { return [f.at, f.text, f.contact, f.status === 'replied' ? '已回复' : '待处理', f.reply]; }));
  }
  function activitySave() {
    if (!C.guard('wallet')) return;
    var t = val('actTitle');
    if (!t) { C.toast('请填活动 / 奖励标题', 'err'); return; }
    var a = num('actAmount');
    E().activities.unshift({ id: uid('ac'), title: t, amount: a, at: now() });
    if (a > 0) addRecord('reward', '活动奖励：' + t, a, '');
    setVal('actTitle', ''); setVal('actAmount', '');
    persist('活动 / 奖励已记录', 'wallet', '记录活动奖励');
  }

  /* ==================== 打印模板 ==================== */
  function fillTemplates() {
    var sel = $('tplSelect'); if (!sel) return;
    var cur = sel.value;
    sel.innerHTML = '<option value="">默认模板</option>' + E().templates.map(function (t) {
      return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>';
    }).join('');
    sel.value = cur;
  }
  function tplCurrent() {
    var fields = [], nodes = document.querySelectorAll('[data-label-field]'), i;
    for (i = 0; i < nodes.length; i++) if (nodes[i].checked) fields.push(nodes[i].getAttribute('data-label-field'));
    return { fields: fields, width: num('labelW') || 80, height: num('labelH') || 50 };
  }
  function tplSave() {
    if (!C.guard('print')) return;
    var name = val('tplName');
    if (!name) { C.toast('请填模板名称', 'err'); return; }
    var c = tplCurrent();
    E().templates.unshift({ id: uid('tp'), name: name, fields: c.fields, width: c.width, height: c.height, at: now() });
    setVal('tplName', '');
    persist('打印模板「' + name + '」已保存', 'print', '保存打印模板');
  }
  function tplApply(id) {
    if (!id) { C.store.updateSettings({ labelFields: C.R.DEFAULT_SETTINGS.labelFields.slice(), labelWidth: 80, labelHeight: 50 }); persist('已恢复默认模板', 'print', '恢复默认打印模板'); return; }
    var t = null, list = E().templates, i;
    for (i = 0; i < list.length; i++) if (list[i].id === id) t = list[i];
    if (!t) return;
    C.store.updateSettings({ labelFields: (t.fields || []).slice(), labelWidth: t.width || 80, labelHeight: t.height || 50 });
    persist('已套用模板「' + t.name + '」', 'print', '套用打印模板');
  }
  function tplDel() {
    if (!C.guard('print')) return;
    var id = val('tplSelect');
    if (!id) { C.toast('请先选择要删除的模板', 'err'); return; }
    confirmBox('删除模板', '确定删除这套打印模板？', function () {
      E().templates = E().templates.filter(function (t) { return t.id !== id; });
      setVal('tplSelect', '');
      persist('打印模板已删除', 'print', '删除打印模板');
    });
  }

  /* ==================== 查询历史 ==================== */
  function recordQuery(kw) {
    kw = String(kw || '').trim(); if (!kw) return;
    var h = E().queryHistory;
    h.unshift({ id: uid('qh'), keyword: kw, at: now(), actor: C.store.getActor() });
    while (h.length > 20) h.pop();
    try { C.store.save(); } catch (e) { }
  }
  function renderQueryHistory() {
    var el = $('qHistory'); if (!el) return;
    var h = E().queryHistory.slice(0, 12);
    el.innerHTML = h.length ? h.map(function (x) {
      return '<button class="link" data-act="x-qHistory" data-id="' + esc(x.id) + '">' + esc(x.keyword) + '</button>';
    }).join(' · ') : '<span class="muted">暂无查询记录</span>';
  }

  /* ==================== 动作分发 / 表单 ==================== */
  function action(act, el) {
    var id = el.getAttribute('data-id');
    try {
      if (act === 'x-taskPreview' || act === 'x-taskRefresh') loadPool();
      else if (act === 'x-taskOpen') { ST.taskCurrent = id; renderTasks(); }
      else if (act === 'x-taskCheckout') taskCheckout();
      else if (act === 'x-taskDelete') taskDelete();
      else if (act === 'x-stPhoto') uploadStationPhoto(el.getAttribute('data-kind'));
      else if (act === 'x-stPhotoDel') {
        var k = el.getAttribute('data-kind');
        if (E().station[k] && C.Media && C.Media.del) { try { C.Media.del(E().station[k]); } catch (e) { } }
        E().station[k] = '';
        persist(PHOTO_LABEL[k] + '已移除', 'station', '移除证件照片');
      }
      else if (act === 'x-stSaveSync') saveStationSync();
      else if (act === 'x-stQr') { ST.qrText = val('stQrText').toUpperCase(); renderQrBox(); }
      else if (act === 'x-stQrPrint') qrPrint();
      else if (act === 'x-walSettle') settle();
      else if (act === 'x-walExport') walletExport();
      else if (act === 'x-walDel') {
        confirmBox('删除账单', '删除这条记录？余额会随之重算。', function () {
          var w = E().wallet; w.records = w.records.filter(function (r) { return r.id !== id; });
          persist('账单已删除', 'wallet', '删除账单记录');
        });
      }
      else if (act === 'x-actDel') {
        E().activities = E().activities.filter(function (a) { return a.id !== id; });
        persist('活动记录已删除', 'wallet', '删除活动记录');
      }
      else if (act === 'x-qHistory') {
        var hs = E().queryHistory, qh = null, hi;
        for (hi = 0; hi < hs.length; hi++) if (hs[hi].id === id) qh = hs[hi];
        if (qh) { setVal('qKw', qh.keyword); C.renderAll(); }
      }
      else if (act === 'x-tplSave') tplSave();
      else if (act === 'x-tplDel') tplDel();
      else if (act === 'x-fbExport') fbExport();
      else if (act === 'x-fbReply') fbReply(id);
      else if (act === 'x-fbDel') {
        confirmBox('删除反馈', '确定删除这条反馈？', function () {
          E().feedbacks = E().feedbacks.filter(function (f) { return f.id !== id; });
          persist('反馈已删除', 'service', '删除意见反馈');
        });
      }
    } catch (e) {
      step('动作失败 ' + act + ' ' + e.message);
      C.toast('操作失败：' + (e.message || e), 'err');
    }
  }
  function onForm(e) {
    var id = e.target && e.target.id;
    var map = {
      formTask: createTask, formStation: saveStationBase, formStationId: saveStationId,
      formRecharge: recharge, formFee: saveFee, formActivity: activitySave, formFeedback: fbSave
    };
    if (map[id]) { try { e.preventDefault(); } catch (er) { } map[id](); }
  }
  function onChange(e) {
    var t = e.target, id = t && t.id;
    if (!t) return;
    if (t.hasAttribute && t.hasAttribute('data-task-check')) {
      ST.taskSelected[t.getAttribute('data-task-check')] = !!t.checked;
      renderPool();
      return;
    }
    if (id === 'taskFilter') { renderTaskList(); return; }
    if (id === 'walFilter') { renderWalletTable(); return; }
    if (id === 'faqKw') { ST.faqKw = String(t.value || ''); renderFaq(); return; }
    if (id === 'tplSelect') { tplApply(String(t.value || '')); return; }
    if (id === 'taskKw' && ST.taskPool.length) { /* 关键词改变不自动重查，等用户点筛选 */ }
  }
  function init(ctx) {
    C = ctx;
    try {
      document.addEventListener('submit', onForm, false);
      document.addEventListener('change', onChange, false);
    } catch (e) { step('事件绑定失败 ' + e.message); }
  }
  function render(name) {
    if (!C) return;
    step('渲染扩展视图 → ' + name);
    try {
      if (name === 'tasks') renderTasks();
      else if (name === 'station') renderStation();
      else if (name === 'wallet') renderWallet();
      else if (name === 'service') renderService();
    } catch (e) {
      step('扩展视图渲染失败 ' + name + ' ' + e.message);
      C.toast('页面渲染失败：' + (e.message || e), 'err');
    }
  }

  var out = { init: init, render: render, action: action, fillTemplates: fillTemplates,
    recordQuery: recordQuery, renderQueryHistory: renderQueryHistory,
    FAQ: FAQ, GUIDE: GUIDE, state: ST };
  if (typeof module !== 'undefined' && module.exports) { module.exports = out; global.StationExtras = out; }
  else global.StationExtras = out;
})(typeof window !== 'undefined' ? window : globalThis);
