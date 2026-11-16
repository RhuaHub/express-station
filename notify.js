/* 驿站助手（重建版 2.3.0）· 通知中心
   短信 / 电话 / 微信取件通知的完整业务实现。
   纯 ES5、零依赖、按需渲染；所有流水、模板、队列只写本机 db.extras.notify。

   通道设计（重要）：
   1) system（默认）：sms: / smsto: / tel: 系统意图，跳系统短信 / 拨号应用，
      由人在系统里最后确认，零敏感权限，不会静默产生费用。
   2) native：安卓 WebView 壳的 StationNotifyNative 桥，SmsManager 直发 +
      SENT/DELIVERED 回执、ACTION_CALL 直拨，需运行时授权 SEND_SMS / CALL_PHONE，
      默认关闭，必须在「通知中心」显式开启并授权后才能用。
   微信通知、隐私号、公众号绑定依赖厂商服务端：本机等价实现为文案 / 二维码 /
   登记，页面明确标注不联网、不调用微信接口，不假装已推送。 */
(function (global) {
  'use strict';

  var C = null;
  var ST = {
    smsPool: [], smsSelected: {}, smsPreview: '', smsLoaded: false,
    callQueue: [], callCursor: 0, callTimer: null, groupRunning: false,
    historyFilter: 'all', callFilter: 'all', qrText: '', wechatText: '',
    lastBatch: []
  };

  /* ==================== 基础工具 ==================== */
  function $(id) { return C.$(id); }
  function esc(s) { return C.esc(String(s === undefined || s === null ? '' : s)); }
  function val(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function setVal(id, v) { var el = $(id); if (el) el.value = v === undefined || v === null ? '' : String(v); }
  function num(id, d) { var n = Number(val(id)); return isFinite(n) ? n : (d || 0); }
  function uid(p) { return C.R.uid(p || 'n'); }
  function now() { return C.R.iso(); }
  function fmt(s) { return C.R.fmt(s, false); }
  function step(t) { try { C.step('通知 · ' + t); } catch (e) { } }
  function toast(m, k) { try { C.toast(m, k); } catch (e) { } }
  function persist(msg, action, text) {
    if (action) { try { C.store.log(action, text || msg); } catch (e) { } }
    try { C.afterWrite(msg); } catch (e) { try { C.store.save(); } catch (e2) { } toast(msg, 'ok'); }
  }
  function strip(id, html, empty) {
    var el = $(id); if (el) el.innerHTML = html || '<div class="muted">' + esc(empty || '暂无数据') + '</div>';
  }
  function csv(name, head, rows) {
    var q = function (v) { return '"' + String(v === undefined || v === null ? '' : v).replace(/"/g, '""') + '"'; };
    C.download(name, '\ufeff' + head.map(q).join(',') + '\r\n' +
      rows.map(function (r) { return r.map(q).join(','); }).join('\r\n'), 'text/csv');
  }
  function confirmBox(t, m, ok) { C.confirmBox(t, m, ok); }
  function guard(p) { try { return C.guard(p); } catch (e) { return true; } }

  /* ---------- 数据容器（兼容旧备份缺字段） ---------- */
  function N() {
    var db = C.store.raw();
    if (!db.extras) db.extras = {};
    var n = db.extras.notify;
    if (!n || typeof n !== 'object') { n = {}; db.extras.notify = n; }
    if (!n.settings || typeof n.settings !== 'object') {
      n.settings = {
        channel: 'system', autoSend: false, signature: '【快递驿站】', signStatus: 'pending',
        templateId: '', quietOn: true, quietStart: 21, quietEnd: 8,
        batchLimit: 50, dayLimit: 500, intervalMs: 600, costPerSms: 0.05,
        callChannel: 'dial', groupCallInterval: 3, privacyNo: '',
        wechatAccount: '', wechatBound: false
      };
    }
    ['templates', 'history', 'calls', 'queue'].forEach(function (k) {
      if (!Array.isArray(n[k])) n[k] = [];
    });
    if (!n.counters || typeof n.counters !== 'object') n.counters = { day: '', sent: 0, calls: 0 };
    return n;
  }
  function cfg() { return N().settings; }
  function saveCfg() { try { C.store.save(); } catch (e) { } }

  /* ---------- 内置模板 ---------- */
  var VAR_DESC = [
    ['{sign}', '短信签名'], ['{name}', '收件人'], ['{company}', '快递公司'],
    ['{station}', '驿站名称'], ['{goods}', '货号'], ['{slot}', '货架号'],
    ['{tracking}', '运单号'], ['{code}', '取件码'], ['{date}', '日期'],
    ['{days}', '滞留天数'], ['{count}', '待取件数'], ['{phone}', '手机号']
  ];
  var BUILTIN = [
    { id: 'tpl-arrive', name: '到件通知', kind: 'sms', builtin: true, body: '{sign}{name}您好，您的{company}包裹已到{station}，货号{goods}，货架{slot}，取件码{code}，请及时领取。' },
    { id: 'tpl-remind', name: '滞留催取', kind: 'sms', builtin: true, body: '{sign}{name}您好，包裹{goods}已存放{days}天，请尽快到{station}领取，货架{slot}。' },
    { id: 'tpl-out', name: '出库确认', kind: 'sms', builtin: true, body: '{sign}您的包裹{goods}已于{date}签收出库，如有疑问请联系{station}。' },
    { id: 'tpl-refund', name: '退件通知', kind: 'sms', builtin: true, body: '{sign}{name}您好，包裹{goods}因超时未取已安排退件，请联系{station}。' },
    { id: 'tpl-batch', name: '批量待取通知', kind: 'sms', builtin: true, body: '{sign}{name}您好，您有{count}件包裹待取，货号{goods}，请到{station}领取。' },
    { id: 'tpl-voice-arrive', name: '到件语音', kind: 'voice', builtin: true, body: '{name}您好，您的{company}包裹已到{station}，货号{goods}，请到{slot}货架领取。' },
    { id: 'tpl-voice-remind', name: '催取语音', kind: 'voice', builtin: true, body: '{name}您好，您有包裹已存放{days}天，请尽快到驿站领取。' },
    { id: 'tpl-wechat', name: '微信取件通知', kind: 'wechat', builtin: true, body: '{sign}{name}您好，{company}包裹已到{station}。货号 {goods} · 货架 {slot} · 取件码 {code}。出示二维码或报货号即可取件。' }
  ];
  function ensureTemplates() {
    var n = N(), changed = false;
    BUILTIN.forEach(function (b) {
      var hit = false;
      for (var i = 0; i < n.templates.length; i++) if (n.templates[i].id === b.id) { hit = true; break; }
      if (!hit) { n.templates.push({ id: b.id, name: b.name, kind: b.kind, body: b.body, builtin: true, enabled: true, at: now() }); changed = true; }
    });
    if (changed) saveCfg();
    return n.templates;
  }
  function tplById(id) {
    var list = N().templates;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  function tplOptions(kind) {
    return N().templates.filter(function (t) { return !kind || t.kind === kind; })
      .map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.name) + '</option>'; }).join('');
  }

  /* ---------- 文案 / 分段 / 号码 ---------- */
  function renderText(body, ctx) {
    return String(body || '').replace(/\{(\w+)\}/g, function (m, k) {
      return ctx[k] === undefined || ctx[k] === null ? '' : String(ctx[k]);
    });
  }
  function segments(text) {
    var len = String(text || '').length;
    return len === 0 ? 0 : (len <= 70 ? 1 : Math.ceil(len / 67));
  }
  function phoneOK(p) {
    var s = String(p || '').replace(/[\s\-+()]/g, '');
    return /^1[3-9]\d{9}$/.test(s) || /^0\d{9,11}$/.test(s) ? s : '';
  }
  function parcelCtx(p, extra) {
    var s = C.store.settings();
    var ctx = {
      sign: cfg().signature || '', name: p.recipient || '客户', company: p.company || '快递',
      station: s.stationName || '驿站', goods: p.goodsNo || p.serial || '',
      slot: p.slot || '', tracking: p.trackingNo || '',
      code: p.phoneTail || String(p.phone || '').slice(-4) || '',
      date: fmt(new Date()), days: 0, count: 1, phone: p.phone || ''
    };
    try { ctx.days = C.R.daysBetween(p.inAt, Date.now()) || 0; } catch (e) { }
    if (extra) Object.keys(extra).forEach(function (k) { ctx[k] = extra[k]; });
    return ctx;
  }
  function recipientOf(p) {
    var ph = phoneOK(p.phone);
    return {
      id: p.id, parcelId: p.id, name: p.recipient || '客户', phone: ph,
      rawPhone: p.phone || '', goodsNo: p.goodsNo || p.serial || '', slot: p.slot || '',
      company: p.company || '', trackingNo: p.trackingNo || '', inAt: p.inAt, parcel: p
    };
  }
  function buildRecipients(scope, kw, days) {
    var all = [];
    try { all = C.store.listParcels({ status: scope === 'all' ? 'all' : 'in' }) || []; } catch (e) { all = []; }
    var k = String(kw || '').toLowerCase();
    var list = all.filter(function (p) {
      if (scope === 'overdue' && (C.R.daysBetween(p.inAt, Date.now()) || 0) < (Number(days) || 3)) return false;
      if (!k) return true;
      return [p.goodsNo, p.trackingNo, p.recipient, p.phone, p.phoneTail, p.slot, p.company]
        .join(' ').toLowerCase().indexOf(k) >= 0;
    }).map(recipientOf);
    /* 按手机号合并同一人的多件，保留首件用于变量，件数写进 {count} */
    var byPhone = {}, order = [], out = [];
    list.forEach(function (r) {
      var key = r.phone || ('x' + r.name + r.goodsNo);
      if (!byPhone[key]) { byPhone[key] = r; r.count = 1; order.push(key); }
      else byPhone[key].count++;
    });
    order.forEach(function (k2) { out.push(byPhone[k2]); });
    return out;
  }

  /* ==================== 通道层 ==================== */
  function bridge() {
    try { return global.StationNotifyNative || null; } catch (e) { return null; }
  }
  function callBridge(name, args) {
    var b = bridge();
    if (!b || typeof b[name] !== 'function') return null;
    try { return b[name].apply(b, args || []); } catch (e) { step('原生桥 ' + name + ' 失败 ' + e.message); return null; }
  }
  function permState() {
    var b = bridge();
    if (!b) return { native: false, sms: false, call: false, log: false, platform: 'web' };
    return {
      native: true, platform: 'android',
      sms: callBridge('smsGranted', []) === true,
      call: callBridge('callGranted', []) === true,
      log: callBridge('logGranted', []) === true
    };
  }
  function todayKey() { return new Date().toISOString().slice(0, 10); }
  function dailyCount(kind) {
    var n = N();
    if (n.counters.day !== todayKey()) { n.counters.day = todayKey(); n.counters.sent = 0; n.counters.calls = 0; }
    return kind === 'call' ? n.counters.calls : n.counters.sent;
  }
  function bumpDaily(kind, add) {
    var n = N(); dailyCount(kind);
    if (kind === 'call') n.counters.calls += add; else n.counters.sent += add;
  }
  function quietBlocked() {
    var s = cfg();
    if (!s.quietOn) return false;
    var h = new Date().getHours(), a = Number(s.quietStart) || 21, b = Number(s.quietEnd) || 8;
    return a > b ? (h >= a || h < b) : (h >= a && h < b);
  }
  function writeHistory(recs, kind, status, channel, textOf) {
    var n = N(), at = now();
    recs.forEach(function (r) {
      n.history.push({
        id: uid('nh'), kind: kind, phone: r.phone, name: r.name, parcelId: r.parcelId || '',
        goodsNo: r.goodsNo || '', text: textOf(r), status: status, channel: channel,
        at: at, error: '', tries: 0
      });
    });
    if (n.history.length > 3000) n.history = n.history.slice(-3000);
    return at;
  }
  function onReceipt(id, status, detail) {
    var n = N(), hit = null;
    for (var i = 0; i < n.history.length; i++) if (n.history[i].nativeId === id) { hit = n.history[i]; break; }
    if (!hit) return;
    if (status === 'delivered' || status === 'sent' || status === 'failed') {
      hit.status = status;
      hit.error = status === 'failed' ? String(detail || '发送失败') : '';
      hit.receiptAt = now();
      saveCfg();
      try { if (ST.view === 'notify' || ST.view === 'sms') render(ST.view); } catch (e) { }
    }
  }

  function openSmsSystem(phone, text) {
    var b = bridge();
    if (b && typeof b.openSms === 'function') { callBridge('openSms', [phone, text]); return true; }
    try {
      global.location.href = 'sms:' + String(phone || '') + '?body=' + encodeURIComponent(text || '');
      return true;
    } catch (e) { toast('无法打开系统短信：' + e.message, 'err'); return false; }
  }
  function openBatchSmsSystem(recs, textOf) {
    /* 系统短信应用支持多收件人；一次 handoff，由人在系统里确认群发 */
    var phones = recs.filter(function (r) { return r.phone; }).map(function (r) { return r.phone; });
    if (!phones.length) { toast('没有有效手机号', 'err'); return false; }
    var first = recs.filter(function (r) { return r.phone; })[0];
    return openSmsSystem(phones.join(';'), textOf(first));
  }
  function dialNumber(phone, direct) {
    var b = bridge();
    var useDirect = !!direct && cfg().callChannel === 'call';
    if (b) {
      if (useDirect && typeof b.call === 'function') { callBridge('call', [phone]); return true; }
      if (!useDirect && typeof b.dial === 'function') { callBridge('dial', [phone]); return true; }
    }
    try { global.location.href = 'tel:' + String(phone || ''); return true; }
    catch (e) { toast('无法打开拨号：' + e.message, 'err'); return false; }
  }
  function speak(text) {
    if (!text) return;
    var b = bridge();
    if (b && typeof b.speak === 'function') { callBridge('speak', [text]); return; }
    try {
      if (global.speechSynthesis && global.SpeechSynthesisUtterance) {
        global.speechSynthesis.cancel();
        var u = new global.SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN'; u.rate = 1; global.speechSynthesis.speak(u);
      } else toast('当前设备不支持语音播报', 'err');
    } catch (e) { toast('语音播报不可用', 'err'); }
  }

  /* ==================== 短信发送 ==================== */
  function selectedRecs() {
    return ST.smsPool.filter(function (r, i) { return ST.smsSelected[r.id + '|' + i]; });
  }
  function smsBody(rec) {
    if (ST.smsCustom) return renderText(ST.smsCustom, parcelCtx(rec.parcel, { count: rec.count || 1 }));
    var t = tplById(cfg().templateId) || tplById('tpl-arrive') || BUILTIN[0];
    return renderText(t.body, parcelCtx(rec.parcel, { count: rec.count || 1 }));
  }
  function previewSms(quiet) {
    var recs = selectedRecs();
    var valid = recs.filter(function (r) { return r.phone; });
    ST.lastBatch = valid;
    var seg = 0;
    valid.forEach(function (r) { seg += segments(smsBody(r)); });
    var cost = seg * (Number(cfg().costPerSms) || 0);
    var info = '收件人 ' + valid.length + ' 人 · 短信约 ' + seg + ' 条 · 预估 ¥' + cost.toFixed(2) +
      (valid.length < recs.length ? ' · ' + (recs.length - valid.length) + ' 条手机号无效已跳过' : '');
    var el = $('smsCountInfo'); if (el) el.textContent = info;
    var box = $('smsPreviewBox');
    if (box) {
      box.innerHTML = valid.length ? valid.slice(0, 6).map(function (r) {
        var t = smsBody(r);
        return '<div class="sms-bubble"><div class="sms-to">' + esc(r.name) + ' · ' + esc(r.phone) +
          ' <span class="muted">' + esc(r.goodsNo) + '</span></div><div class="sms-body">' + esc(t) +
          '</div><div class="sms-meta">' + t.length + ' 字 / ' + segments(t) + ' 条</div></div>';
      }).join('') + (valid.length > 6 ? '<div class="muted">仅预览前 6 条，实际按全部 ' + valid.length + ' 人发送</div>' : '')
        : '<div class="muted">先在上方筛选并勾选收件人</div>';
    }
    if (!quiet && !valid.length) toast('还没有勾选有效收件人', 'err');
    return { recs: valid, seg: seg, info: info };
  }
  function sendSmsBatch(overrideQuiet) {
    if (!guard('sms')) return;
    var p = previewSms(true), recs = p.recs, s = cfg();
    if (!recs.length) { toast('没有可发送的有效号码', 'err'); return; }
    if (s.quietOn && quietBlocked() && !overrideQuiet) {
      confirmBox('免打扰时段', '当前处于免打扰时段（' + s.quietStart + ':00–' + s.quietEnd + ':00）。仍要继续发送吗？',
        function () { sendSmsBatch(true); });
      return;
    }
    if (recs.length > (Number(s.batchLimit) || 50)) {
      toast('单批上限 ' + s.batchLimit + ' 人，当前 ' + recs.length + ' 人，请缩小筛选范围', 'err'); return;
    }
    if (dailyCount('sms') + p.seg > (Number(s.dayLimit) || 500)) {
      toast('已达今日发送上限 ' + s.dayLimit + ' 条', 'err'); return;
    }
    var ps = permState();
    var useNative = s.channel === 'native' && ps.native && ps.sms;
    var channel = useNative ? 'native' : 'system';
    confirmBox('确认发送短信',
      '将向 ' + recs.length + ' 人发送约 ' + p.seg + ' 条短信（预估 ¥' +
      (p.seg * (Number(s.costPerSms) || 0)).toFixed(2) + '）。通道：' +
      (useNative ? '本机直发（已授权，将真实发出并计费）' : '系统短信应用（跳转后需你手动点发送）') +
      '。收件人：' + recs.slice(0, 3).map(function (r) { return r.name + ' ' + r.phone; }).join('、') +
      (recs.length > 3 ? ' 等' : ''),
      function () { doSend(recs, channel, p.seg); });
  }
  function doSend(recs, channel, seg) {
    step('短信发送开始 ' + recs.length + ' 人 / ' + channel);
    var ok = true;
    if (channel === 'system') {
      ok = openBatchSmsSystem(recs, smsBody);
      writeHistory(recs, 'sms', ok ? 'handoff' : 'failed', 'system', smsBody);
    } else {
      var at = writeHistory(recs, 'sms', 'queued', 'native', smsBody);
      var n = N(), idx = n.history.length - recs.length;
      for (var i = 0; i < recs.length; i++) {
        var h = n.history[idx + i];
        if (!h) continue;
        h.nativeId = uid('sm');
        var sent = callBridge('sendSms', [recs[i].phone, smsBody(recs[i]), h.nativeId]);
        h.status = sent === true ? 'sent' : 'failed';
        if (sent !== true) h.error = '原生通道不可用或未授权';
      }
    }
    bumpDaily('sms', seg);
    saveCfg();
    C.store.log('notify', '短信 ' + channel + ' · ' + recs.length + ' 人 / ' + seg + ' 条');
    persist(channel === 'system' ? '已交系统短信应用，请在系统里确认发送' : '已提交直发，等待送达回执', 'sms',
      '短信发送 ' + recs.length + ' 人 / ' + seg + ' 条');
    try { render(ST.view || 'sms'); } catch (e) { }
  }
  function retryFailed() {
    if (!guard('sms')) return;
    var n = N();
    var failed = n.history.filter(function (h) { return h.kind === 'sms' && (h.status === 'failed' || h.status === 'queued'); });
    if (!failed.length) { toast('没有失败 / 待发的短信', 'ok'); return; }
    var ps = permState(), useNative = cfg().channel === 'native' && ps.native && ps.sms;
    confirmBox('重发失败短信', '共 ' + failed.length + ' 条失败 / 待发记录，按' +
      (useNative ? '本机直发' : '系统短信应用') + '重发？', function () {
        if (useNative) {
          failed.forEach(function (h) {
            h.nativeId = uid('sm');
            var sent = callBridge('sendSms', [h.phone, h.text, h.nativeId]);
            h.status = sent === true ? 'sent' : 'failed';
            h.tries = (h.tries || 0) + 1;
          });
        } else {
          openBatchSmsSystem(failed.map(function (h) {
            return { phone: h.phone, name: h.name, goodsNo: h.goodsNo, text: h.text, parcel: { recipient: h.name, phone: h.phone } };
          }), function (r) { return r.text; });
          failed.forEach(function (h) { h.status = 'handoff'; h.tries = (h.tries || 0) + 1; });
        }
        saveCfg();
        persist('已重发 ' + failed.length + ' 条', 'sms', '重发失败短信 ' + failed.length + ' 条');
        try { render(ST.view || 'notify'); } catch (e) { }
      });
  }
  function scanToSms() {
    if (!guard('sms')) return;
    if (!C.Media || typeof C.Media.capture !== 'function') { toast('拍照能力不可用', 'err'); return; }
    try {
      C.Media.capture({ title: '扫码发短信 · 拍面单', single: true, prefix: 'DX' }).then(function (r) {
        if (!r || r.cancelled || !r.files || !r.files.length) return;
        return C.Media.recognize(r.files[0].blob).then(function (d) {
          var code = C.R.barcodeOf(d) || '';
          if (!code) { toast('没识别到条码，请手输货号后筛选', 'err'); return; }
          setVal('smsKw', code);
          var pool = buildRecipients('in', code, 3);
          ST.smsPool = pool; ST.smsSelected = {};
          pool.forEach(function (x, i) { ST.smsSelected[x.id + '|' + i] = true; });
          renderSmsPool();
          previewSms();
          toast('已匹配 ' + pool.length + ' 件，核对后发送', pool.length ? 'ok' : 'err');
        });
      }).catch(function (e) { toast('扫码失败：' + (e && e.message ? e.message : e), 'err'); });
    } catch (e) { toast('扫码发短信不可用', 'err'); }
  }

  /* ==================== 电话 / 群呼 ==================== */
  function writeCall(phone, name, kind, note, duration) {
    var n = N();
    n.calls.push({ id: uid('cl'), phone: phone, name: name || '', kind: kind, note: note || '',
      duration: Number(duration) || 0, at: now(), source: 'manual' });
    if (n.calls.length > 2000) n.calls = n.calls.slice(-2000);
    saveCfg();
  }
  function oneCall(phone, name, direct) {
    var p = phoneOK(phone);
    if (!p) { toast('请填写有效手机号', 'err'); return; }
    if (!guard('calls')) return;
    var ps = permState();
    if (direct && cfg().callChannel === 'call' && !(ps.native && ps.call)) {
      toast('直拨需要 CALL_PHONE 授权，请先到通知中心授权，或改用「拨号盘」', 'err'); return;
    }
    var ok = dialNumber(p, direct);
    if (ok) {
      writeCall(p, name || '', 'out', direct ? '直拨' : '拨号盘');
      bumpDaily('call', 1); saveCfg();
      C.store.log('notify', '电话 ' + (direct ? '直拨' : '拨号盘') + ' ' + p);
      persist('已发起呼叫 ' + p);
      try { renderCalls(); } catch (e) { }
    }
  }
  function buildGroup() {
    if (!guard('calls')) return;
    var scope = val('callScope') || 'in', kw = val('callKw'), days = num('callDays', 3);
    var recs = buildRecipients(scope, kw, days).filter(function (r) { return r.phone; });
    ST.callQueue = recs; ST.callCursor = 0;
    renderCallQueue();
    toast('已生成 ' + recs.length + ' 位待呼客户', 'ok');
  }
  function runGroup() {
    if (!guard('calls')) return;
    if (!ST.callQueue.length) { toast('请先生成群呼名单', 'err'); return; }
    if (quietBlocked()) { toast('当前处于免打扰时段，暂不外呼', 'err'); return; }
    if (ST.groupRunning) { stopGroup(); return; }
    var mode = val('callGroupMode') || 'prompt';
    var direct = cfg().callChannel === 'call';
    if (direct) {
      var ps = permState();
      if (!(ps.native && ps.call)) { toast('自动外呼需要 CALL_PHONE 授权，请先授权或改用「逐个提醒」', 'err'); return; }
    }
    ST.groupRunning = true;
    var btn = $('nGroupRun'); if (btn) btn.textContent = '停止群呼';
    var tick = function () {
      if (!ST.groupRunning) return;
      if (ST.callCursor >= ST.callQueue.length) {
        stopGroup(); toast('群呼名单已完成', 'ok'); return;
      }
      var r = ST.callQueue[ST.callCursor];
      ST.callCursor++;
      renderCallQueue();
      if (mode === 'auto') {
        oneCall(r.phone, r.name, direct);
      } else {
        toast('第 ' + ST.callCursor + '/' + ST.callQueue.length + ' 位：' + r.name + ' ' + r.phone + '，点「拨下一位」', 'ok');
        var go = $('nCallNext'); if (go) go.disabled = false;
      }
      if (mode === 'auto') {
        var sec = Math.max(2, Number(val('callInterval')) || Number(cfg().groupCallInterval) || 3);
        ST.callTimer = setTimeout(tick, sec * 1000);
      } else ST.groupRunning = false;
      if (!ST.groupRunning) { var b2 = $('nGroupRun'); if (b2) b2.textContent = '开始群呼'; }
    };
    tick();
  }
  function stopGroup() {
    ST.groupRunning = false;
    if (ST.callTimer) { try { clearTimeout(ST.callTimer); } catch (e) { } ST.callTimer = null; }
    var b = $('nGroupRun'); if (b) b.textContent = '开始群呼';
    var go = $('nCallNext'); if (go) go.disabled = false;
    renderCallQueue();
  }
  function callNext() {
    if (ST.callCursor >= ST.callQueue.length) { toast('名单已拨完', 'ok'); return; }
    var r = ST.callQueue[ST.callCursor]; ST.callCursor++;
    var direct = cfg().callChannel === 'call';
    oneCall(r.phone, r.name, direct);
    renderCallQueue();
  }
  function readSystemCalls(missedOnly) {
    var b = bridge();
    if (!b || typeof b.callLog !== 'function') { toast('请在安卓 App 内使用系统通话记录同步', 'err'); return; }
    var ps = permState();
    if (!ps.log) { toast('需要先授权读取通话记录', 'err'); callBridge('requestLog', []); return; }
    var raw = missedOnly ? callBridge('missedCalls', [60]) : callBridge('callLog', [120]);
    var list = [];
    try { list = JSON.parse(String(raw || '[]')); } catch (e) { list = []; }
    if (!list.length) { toast('系统通话记录为空或未授权', 'err'); return; }
    var n = N(), seen = {}, added = 0;
    n.calls.forEach(function (c) { seen[c.at + '|' + c.phone] = true; });
    list.forEach(function (x) {
      var at = x.at || now();
      if (seen[at + '|' + x.phone]) return;
      n.calls.push({ id: uid('cl'), phone: x.phone || '', name: x.name || '',
        kind: x.type === 'missed' ? 'missed' : (x.type === 'in' ? 'in' : 'out'),
        duration: Number(x.duration) || 0, at: at, note: '系统通话记录', source: 'system' });
      added++;
    });
    saveCfg();
    persist('已同步 ' + added + ' 条系统通话记录', 'calls', '同步系统通话记录 ' + added + ' 条');
    try { renderCalls(); } catch (e) { }
  }
  function missedCallback(id) {
    var n = N(), hit = null;
    for (var i = 0; i < n.calls.length; i++) if (n.calls[i].id === id) { hit = n.calls[i]; break; }
    if (!hit) return;
    oneCall(hit.phone, hit.name, false);
    hit.note = '已回拨'; saveCfg();
  }

  /* ==================== 微信取件 ==================== */
  function wechatText(rec) {
    var t = tplById('tpl-wechat') || BUILTIN[7];
    var body = val('ntWechatCustom') || t.body;
    return rec ? renderText(body, parcelCtx(rec.parcel, { count: rec.count || 1 })) : renderText(body, {
      sign: cfg().signature || '', name: '客户', company: '快递', station: C.store.settings().stationName || '驿站',
      goods: 'A01010023', slot: 'A-3', code: '1234', date: fmt(new Date()), days: 0, count: 1, phone: ''
    });
  }
  function qrSVG(text, size) {
    var Q = global.StationQr;
    if (!Q || typeof Q.svg !== 'function') return '';
    try { return Q.svg(text, { size: size || 200, margin: 2 }); } catch (e) { return ''; }
  }
  function genWechat() {
    if (!guard('wechat')) return;
    var scope = val('ntWechatScope') || 'in';
    var recs = buildRecipients(scope, val('ntWechatKw'), 3);
    if (!recs.length) { toast('没有匹配的在库件', 'err'); return; }
    var r = recs[0];
    ST.qrText = r.goodsNo || r.trackingNo || r.phone || 'PICKUP';
    ST.wechatText = wechatText(r);
    var box = $('ntQrBox');
    if (box) {
      box.innerHTML = '<div class="qr-card"><div class="qr-img">' + qrSVG(ST.qrText, 210) + '</div>' +
        '<div class="qr-meta"><b>取件码海报</b><span>' + esc(ST.qrText) + '</span>' +
        '<span class="muted">扫码显示货号；二维码内容只在本机生成，不联网、不代表已推送微信</span></div></div>';
    }
    var t = $('ntWechatText'); if (t) t.value = ST.wechatText;
    toast('已生成取件通知文案与二维码', 'ok');
  }
  function copyWechat() {
    var t = val('ntWechatText') || ST.wechatText;
    if (!t) { toast('请先生成文案', 'err'); return; }
    var b = bridge();
    if (b && typeof b.copyText === 'function') { callBridge('copyText', [t]); toast('已复制通知文案', 'ok'); return; }
    try {
      var el = $('ntWechatText');
      if (el && el.select) { el.select(); document.execCommand && document.execCommand('copy'); toast('已复制通知文案', 'ok'); }
      else toast('请长按文本框手动复制', 'ok');
    } catch (e) { toast('请长按文本框手动复制', 'ok'); }
  }

  /* ==================== 渲染：通知中心 ==================== */
  function renderNotify() {
    ensureTemplates();
    var n = N(), s = cfg(), ps = permState();
    var today = todayKey();
    var todayH = n.history.filter(function (h) { return String(h.at).slice(0, 10) === today; });
    var cnt = {
      sms: todayH.filter(function (h) { return h.kind === 'sms'; }).length,
      ok: todayH.filter(function (h) { return h.status === 'sent' || h.status === 'delivered' || h.status === 'handoff'; }).length,
      fail: todayH.filter(function (h) { return h.status === 'failed'; }).length,
      call: n.calls.filter(function (c) { return String(c.at).slice(0, 10) === today; }).length,
      queue: n.queue.length
    };
    var kpi = $('ntKpi');
    if (kpi) kpi.innerHTML = [
      ['今日短信', cnt.sms, '含跳转系统应用'], ['成功 / 已交', cnt.ok, '送达或待人工确认'],
      ['失败', cnt.fail, '可一键重发'], ['今日电话', cnt.call, '含拨号与直拨'], ['待发队列', cnt.queue, '延迟发送']
    ].map(function (x) {
      return '<div class="kpi"><div class="k">' + x[0] + '</div><div class="v">' + x[1] + '</div><div class="s">' + esc(x[2]) + '</div></div>';
    }).join('');

    var cs = $('ntChannelState');
    if (cs) {
      var nativeOn = s.channel === 'native';
      cs.innerHTML = '<div class="chan-row"><div><b>当前通道：' + (nativeOn ? '本机直发' : '系统应用（默认）') + '</b>' +
        '<div class="muted">' + (nativeOn
          ? '真实发出短信并产生运营商费用；每次群发仍需二次确认。'
          : '跳转系统短信 / 拨号应用，由人最后确认；不需要敏感权限。') + '</div></div>' +
        '<div class="chip-row">' +
        '<span class="tag ' + (ps.native ? 'tag-ok' : '') + '">' + (ps.native ? '安卓原生桥已就绪' : '浏览器 / 网页模式') + '</span>' +
        '<span class="tag ' + (ps.sms ? 'tag-ok' : 'tag-warn') + '">SEND_SMS ' + (ps.sms ? '已授权' : (ps.native ? '未授权' : '不适用')) + '</span>' +
        '<span class="tag ' + (ps.call ? 'tag-ok' : 'tag-warn') + '">CALL_PHONE ' + (ps.call ? '已授权' : (ps.native ? '未授权' : '不适用')) + '</span>' +
        '<span class="tag ' + (ps.log ? 'tag-ok' : 'tag-warn') + '">通话记录 ' + (ps.log ? '已授权' : '未授权') + '</span>' +
        '</div></div>';
    }
    setVal('ntSetChannel', s.channel);
    setVal('ntSetSignature', s.signature);
    setVal('ntSetSignStatus', s.signStatus);
    setVal('ntSetQuietStart', s.quietStart);
    setVal('ntSetQuietEnd', s.quietEnd);
    setVal('ntSetBatchLimit', s.batchLimit);
    setVal('ntSetDayLimit', s.dayLimit);
    setVal('ntSetCost', s.costPerSms);
    setVal('ntSetCallChannel', s.callChannel);
    setVal('ntSetGroupInterval', s.groupCallInterval);
    setVal('ntSetPrivacyNo', s.privacyNo);
    setVal('ntSetWechatAccount', s.wechatAccount);
    var q = $('ntSetQuietOn'); if (q) q.checked = !!s.quietOn;
    var au = $('ntSetAutoSend'); if (au) au.checked = !!s.autoSend;
    var signInfo = $('ntSignInfo');
    if (signInfo) signInfo.textContent = s.signStatus === 'approved'
      ? '签名已审核（本机标记）：发送时自动附加。' : '签名待审核（本机标记）：短信通道商通常要求报备签名，本机直发会原样附在正文前。';

    renderQueue();
    renderHistory();
    var vb = $('ntVarDesc');
    if (vb) vb.innerHTML = VAR_DESC.map(function (v) {
      return '<span class="chip"><code>' + esc(v[0]) + '</code> ' + esc(v[1]) + '</span>';
    }).join('');
    var wa = $('ntWechatState');
    if (wa) wa.textContent = s.wechatBound && s.wechatAccount
      ? '已登记公众号：' + s.wechatAccount + '（仅本机登记，不代表已绑定或可推送）'
      : '未登记公众号。微信模板消息需服务端与认证公众号；本页只生成文案与取件二维码。';
  }
  function renderQueue() {
    var n = N();
    strip('ntQueue', n.queue.length ? n.queue.map(function (q) {
      return '<div class="strip-item"><div><b>' + esc(q.name || q.phone) + '</b> <span class="mono">' + esc(q.phone) + '</span>' +
        '<div class="muted">' + esc(String(q.text || '').slice(0, 60)) + '</div></div>' +
        '<span class="tag ' + (q.status === 'done' ? 'tag-ok' : 'tag-warn') + '">' + esc(q.status === 'done' ? '已发送' : '待发') + '</span></div>';
    }).join('') : '', '暂无延迟发送队列');
  }
  function historyRows(filter) {
    var n = N();
    return n.history.filter(function (h) {
      if (filter === 'sms' && h.kind !== 'sms') return false;
      if (filter === 'call' && h.kind !== 'call') return false;
      if (filter === 'failed' && h.status !== 'failed') return false;
      return true;
    }).slice(-200).reverse().map(function (h) {
      return { cells: [
        esc(fmt(h.at).slice(5)), '<span class="tag">' + esc(h.kind === 'sms' ? '短信' : (h.kind === 'call' ? '电话' : h.kind)) + '</span>',
        esc(h.name || '—') + '<div class="muted mono">' + esc(h.phone) + '</div>',
        '<div class="clip">' + esc(String(h.text || '').slice(0, 80)) + '</div>',
        '<span class="tag ' + (h.status === 'failed' ? 'tag-warn' : 'tag-ok') + '">' + esc({
          sent: '已发送', delivered: '已送达', failed: '失败', queued: '待发', handoff: '已交系统应用'
        }[h.status] || h.status) + '</span>',
        esc(h.channel === 'native' ? '本机直发' : '系统应用') +
        (h.error ? '<div class="muted">' + esc(h.error) + '</div>' : ''),
        '<button class="btn btn-ghost btn-sm" data-act="n-retryOne" data-id="' + esc(h.id) + '">重发</button>'
      ] };
    });
  }
  function renderHistory() {
    C.table('ntHistoryTable', ['时间', '类型', '收件人', '内容', '状态', '通道', '操作'],
      historyRows(ST.historyFilter), { empty: '暂无通知流水' });
    var c = $('ntHistoryCount'); if (c) c.textContent = '今日已发 ' + dailyCount('sms') + ' / ' + cfg().dayLimit + ' 条';
  }

  /* ==================== 渲染：短信群发 ==================== */
  function renderSmsPool() {
    var pool = ST.smsPool;
    strip('smsPool', pool.length ? pool.map(function (r, i) {
      var key = r.id + '|' + i, on = !!ST.smsSelected[key];
      return '<label class="strip-item pick' + (on ? ' on' : '') + '">' +
        '<input type="checkbox" data-sms-pick="' + esc(key) + '"' + (on ? ' checked' : '') + '>' +
        '<div><b>' + esc(r.name) + '</b> <span class="mono">' + esc(r.phone || '无有效号码') + '</span>' +
        (r.phone ? '' : ' <span class="tag tag-warn">不可发送</span>') +
        '<div class="muted">' + esc(r.goodsNo) + ' · ' + esc(r.slot) + ' · ' + esc(r.company) +
        (r.count > 1 ? ' · 共 ' + r.count + ' 件' : '') + '</div></div></label>';
    }).join('') : '', '点「筛选收件人」从在库件生成名单');
    var c = $('smsPoolCount');
    if (c) c.textContent = pool.length ? '共 ' + pool.length + ' 人 · 已选 ' + selectedRecs().length + ' 人' : '';
  }
  function renderSms() {
    ensureTemplates();
    var sel = $('smsTemplate');
    if (sel && !sel.getAttribute('data-filled')) {
      sel.innerHTML = tplOptions('sms') || '<option value="tpl-arrive">到件通知</option>';
      sel.setAttribute('data-filled', '1');
    }
    setVal('smsTemplate', cfg().templateId || 'tpl-arrive');
    var vt = $('smsVoiceTpl');
    if (vt && !vt.getAttribute('data-filled')) {
      vt.innerHTML = tplOptions('voice'); vt.setAttribute('data-filled', '1');
    }
    if (!ST.smsLoaded) { ST.smsLoaded = true; refreshSmsPool(); }
    else renderSmsPool();
    renderTplList();
    C.table('smsHistoryTable', ['时间', '收件人', '内容', '状态', '通道', '操作'],
      N().history.filter(function (h) { return h.kind === 'sms'; }).slice(-120).reverse().map(function (h) {
        return { cells: [esc(fmt(h.at).slice(5)), esc(h.name) + '<div class="muted mono">' + esc(h.phone) + '</div>',
          '<div class="clip">' + esc(String(h.text || '').slice(0, 80)) + '</div>',
          '<span class="tag ' + (h.status === 'failed' ? 'tag-warn' : 'tag-ok') + '">' + esc({
            sent: '已发送', delivered: '已送达', failed: '失败', queued: '待发', handoff: '已交系统应用'
          }[h.status] || h.status) + '</span>', esc(h.channel === 'native' ? '直发' : '系统'),
          '<button class="btn btn-ghost btn-sm" data-act="n-retryOne" data-id="' + esc(h.id) + '">重发</button>' ] };
      }), { empty: '暂无短信记录' });
    previewSms(true);
  }
  function refreshSmsPool() {
    var scope = val('smsScope') || 'in';
    ST.smsPool = buildRecipients(scope, val('smsKw'), num('smsDays', 3));
    ST.smsSelected = {};
    ST.smsPool.forEach(function (r, i) { if (r.phone) ST.smsSelected[r.id + '|' + i] = true; });
    renderSmsPool();
    previewSms(true);
  }
  function renderTplList() {
    strip('smsTplList', N().templates.map(function (t) {
      return '<div class="strip-item"><div><b>' + esc(t.name) + '</b> ' +
        '<span class="tag">' + esc({ sms: '短信', voice: '语音', wechat: '微信' }[t.kind] || t.kind) + '</span>' +
        (t.builtin ? '<span class="muted"> · 内置</span>' : '') +
        '<div class="muted clip">' + esc(t.body) + '</div></div>' +
        '<div class="row-actions"><button class="btn btn-ghost btn-sm" data-act="n-tplUse" data-id="' + esc(t.id) + '">选用</button>' +
        (t.builtin ? '' : '<button class="btn btn-ghost btn-sm" data-act="n-tplDel" data-id="' + esc(t.id) + '">删除</button>') + '</div></div>';
    }).join(''), '暂无模板');
  }

  /* ==================== 渲染：电话通知 ==================== */
  function renderCallQueue() {
    strip('callQueueBox', ST.callQueue.length ? ST.callQueue.map(function (r, i) {
      var state = i < ST.callCursor ? 'done' : (i === ST.callCursor && ST.groupRunning ? 'now' : 'wait');
      return '<div class="strip-item ' + state + '"><div><b>' + (i + 1) + '. ' + esc(r.name) + '</b> ' +
        '<span class="mono">' + esc(r.phone) + '</span><div class="muted">' + esc(r.goodsNo) + ' · ' + esc(r.slot) + '</div></div>' +
        '<span class="tag ' + (state === 'done' ? 'tag-ok' : (state === 'now' ? 'tag-warn' : '')) + '">' +
        esc(state === 'done' ? '已拨' : (state === 'now' ? '当前' : '待拨')) + '</span>' +
        '<button class="btn btn-ghost btn-sm" data-act="n-callOne" data-id="' + esc(r.phone) + '" data-name="' + esc(r.name) + '">拨号</button></div>';
    }).join('') : '', '点「生成群呼名单」从在库件建立顺序外呼清单');
    var c = $('callQueueCount');
    if (c) c.textContent = ST.callQueue.length ? '进度 ' + ST.callCursor + ' / ' + ST.callQueue.length : '';
  }
  function renderCalls() {
    ensureTemplates();
    renderCallQueue();
    var n = N(), f = ST.callFilter;
    C.table('callLogTable', ['时间', '号码 / 姓名', '类型', '时长', '备注', '操作'],
      n.calls.filter(function (c) {
        if (f === 'missed' && c.kind !== 'missed') return false;
        if (f === 'out' && c.kind !== 'out') return false;
        return true;
      }).slice(-160).reverse().map(function (c) {
        return { cells: [esc(fmt(c.at).slice(5)),
          '<span class="mono">' + esc(c.phone) + '</span><div class="muted">' + esc(c.name || '—') + '</div>',
          '<span class="tag ' + (c.kind === 'missed' ? 'tag-warn' : 'tag-ok') + '">' +
          esc({ out: '去电', in: '来电', missed: '未接' }[c.kind] || c.kind) + '</span>',
          esc(c.duration ? c.duration + ' 秒' : '—'), esc(c.note || c.source || '—'),
          '<button class="btn btn-ghost btn-sm" data-act="n-callBack" data-id="' + esc(c.phone) + '" data-name="' + esc(c.name) + '">回拨</button>' +
          (c.kind === 'missed' ? '<button class="btn btn-ghost btn-sm" data-act="n-missedDone" data-id="' + esc(c.id) + '">标记已处理</button>' : '')
        ] };
      }), { empty: '暂无通话记录' });
    var vt = $('callVoiceTpl');
    if (vt && !vt.getAttribute('data-filled')) { vt.innerHTML = tplOptions('voice'); vt.setAttribute('data-filled', '1'); }
    var m = $('callMissedCount');
    if (m) m.textContent = '未接 ' + n.calls.filter(function (c) { return c.kind === 'missed' && !c.handled; }).length + ' 条';
    var pv = $('callPrivacyInfo');
    if (pv) pv.textContent = cfg().privacyNo
      ? '已登记隐私号 / 中转号：' + cfg().privacyNo + '（仅本机记录；真实隐私号需运营商 AXB 能力）'
      : '未登记隐私号。真实隐私号 / 回拨中转依赖运营商能力，本页以「本机登记 + 直接拨号」等价替代。';
  }

  /* ==================== 动作分发 ==================== */
  function action(act, el) {
    var id = el.getAttribute('data-id') || '', name = el.getAttribute('data-name') || '';
    if (act === 'n-saveSettings') saveSettings();
    else if (act === 'n-requestPerm') requestPerms();
    else if (act === 'n-exportHistory') exportHistory();
    else if (act === 'n-retryFailed') retryFailed();
    else if (act === 'n-retryOne') retryOne(id);
    else if (act === 'n-queueAdd') queueAdd();
    else if (act === 'n-queueRun') queueRun();
    else if (act === 'n-queueClear') queueClear();
    else if (act === 'n-wechatGen') genWechat();
    else if (act === 'n-wechatCopy') copyWechat();
    else if (act === 'n-wechatSave') {
      var t = val('ntWechatText') || ST.wechatText;
      if (!t) { toast('请先生成文案', 'err'); return; }
      C.download('微信取件通知.txt', t, 'text/plain');
    }
    else if (act === 'n-smsPreview') { refreshSmsPool(); previewSms(); }
    else if (act === 'n-smsSend') sendSmsBatch(false);
    else if (act === 'n-smsScan') scanToSms();
    else if (act === 'n-smsAll') { ST.smsPool.forEach(function (r, i) { ST.smsSelected[r.id + '|' + i] = !!r.phone; }); renderSmsPool(); previewSms(true); }
    else if (act === 'n-smsNone') { ST.smsSelected = {}; renderSmsPool(); previewSms(true); }
    else if (act === 'n-tplUse') {
      var t2 = tplById(id); if (!t2) return;
      cfg().templateId = id; saveCfg(); setVal('smsTemplate', id);
      setVal('smsCustom', ''); ST.smsCustom = ''; previewSms();
      toast('已选用模板「' + t2.name + '」', 'ok');
    }
    else if (act === 'n-tplDel') {
      var n0 = N();
      n0.templates = n0.templates.filter(function (t) { return t.id !== id; });
      saveCfg(); renderTplList(); resetTplSelect(); toast('模板已删除', 'ok');
    }
    else if (act === 'n-callDial') oneCall(val('callPhone'), val('callName'), false);
    else if (act === 'n-callDirect') oneCall(val('callPhone'), val('callName'), true);
    else if (act === 'n-callMatch') matchPhone();
    else if (act === 'n-callOne') oneCall(id, name, false);
    else if (act === 'n-callBack') oneCall(id, name, false);
    else if (act === 'n-groupBuild') buildGroup();
    else if (act === 'n-groupRun') runGroup();
    else if (act === 'n-groupStop') stopGroup();
    else if (act === 'n-callNext') callNext();
    else if (act === 'n-syncCallLog') readSystemCalls(false);
    else if (act === 'n-syncMissed') readSystemCalls(true);
    else if (act === 'n-missedDone') markMissed(id);
    else if (act === 'n-callLogAdd') addCallLog();
    else if (act === 'n-voicePlay') playVoice();
    else if (act === 'n-voiceFromTpl') {
      var v = tplById(val('callVoiceTpl'));
      if (v) { setVal('callVoiceText', v.body); }
    }
  }
  function resetTplSelect() {
    var s = $('smsTemplate'); if (s) { s.innerHTML = tplOptions('sms'); s.setAttribute('data-filled', '1'); }
    var v = $('callVoiceTpl'); if (v) { v.innerHTML = tplOptions('voice'); v.setAttribute('data-filled', '1'); }
  }
  function saveSettings() {
    if (!guard('notify')) return;
    var s = cfg();
    s.channel = val('ntSetChannel') || 'system';
    s.signature = val('ntSetSignature') || '';
    s.signStatus = val('ntSetSignStatus') || 'pending';
    s.quietStart = num('ntSetQuietStart', 21); s.quietEnd = num('ntSetQuietEnd', 8);
    s.batchLimit = Math.max(1, num('ntSetBatchLimit', 50));
    s.dayLimit = Math.max(1, num('ntSetDayLimit', 500));
    s.costPerSms = Math.max(0, num('ntSetCost', 0.05));
    s.callChannel = val('ntSetCallChannel') || 'dial';
    s.groupCallInterval = Math.max(2, num('ntSetGroupInterval', 3));
    s.privacyNo = val('ntSetPrivacyNo');
    s.wechatAccount = val('ntSetWechatAccount');
    s.wechatBound = !!s.wechatAccount;
    var q = $('ntSetQuietOn'); s.quietOn = q ? !!q.checked : false;
    var au = $('ntSetAutoSend'); s.autoSend = au ? !!au.checked : false;
    if (s.channel === 'native') {
      var ps = permState();
      if (!ps.native) { s.channel = 'system'; toast('当前不在安卓 App 内，已回落系统通道', 'err'); }
      else if (!ps.sms) { toast('本机直发需要先授权 SEND_SMS，点「申请权限」', 'err'); }
    }
    saveCfg();
    C.store.log('notify', '通知设置：通道 ' + s.channel + ' · 签名 ' + s.signature);
    persist('通知设置已保存', 'notify', '更新通知设置');
    try { render('notify'); } catch (e) { }
  }
  function requestPerms() {
    var b = bridge();
    if (!b) { toast('当前不在安卓 App 内，无需授权；网页模式走系统短信 / 拨号应用', 'ok'); return; }
    callBridge('requestSms', []); callBridge('requestCall', []); callBridge('requestLog', []);
    toast('已发起权限申请，授权后回到本页点「刷新」', 'ok');
  }
  function exportHistory() {
    var rows = N().history.map(function (h) {
      return [h.at, h.kind, h.name, h.phone, h.goodsNo, h.status, h.channel, h.text, h.error];
    });
    csv('通知流水.csv', ['时间', '类型', '收件人', '号码', '货号', '状态', '通道', '内容', '错误'], rows);
    toast('已导出 ' + rows.length + ' 条通知流水', 'ok');
  }
  function retryOne(id) {
    if (!guard('sms')) return;
    var n = N(), h = null;
    for (var i = 0; i < n.history.length; i++) if (n.history[i].id === id) { h = n.history[i]; break; }
    if (!h) return;
    if (h.kind !== 'sms') { toast('电话记录请用「回拨」', 'err'); return; }
    var ps = permState(), useNative = cfg().channel === 'native' && ps.native && ps.sms;
    if (useNative) {
      h.nativeId = uid('sm');
      h.status = callBridge('sendSms', [h.phone, h.text, h.nativeId]) === true ? 'sent' : 'failed';
    } else {
      openSmsSystem(h.phone, h.text); h.status = 'handoff';
    }
    h.tries = (h.tries || 0) + 1; saveCfg();
    persist('已重发 1 条', 'sms', '重发短信 ' + h.phone);
    try { render(ST.view || 'notify'); } catch (e) { }
  }
  function queueAdd() {
    if (!guard('sms')) return;
    var recs = buildRecipients(val('ntQueueScope') || 'overdue', val('ntQueueKw'), num('ntQueueDays', 3))
      .filter(function (r) { return r.phone; });
    if (!recs.length) { toast('没有匹配的收件人', 'err'); return; }
    var n = N(), body = tplById(cfg().templateId) || tplById('tpl-remind') || BUILTIN[1];
    recs.forEach(function (r) {
      n.queue.push({ id: uid('nq'), phone: r.phone, name: r.name, goodsNo: r.goodsNo,
        text: renderText(body.body, parcelCtx(r.parcel, { count: r.count || 1 })),
        status: 'pending', at: now() });
    });
    saveCfg(); renderQueue();
    toast('已加入 ' + recs.length + ' 条待发队列', 'ok');
  }
  function queueRun() {
    if (!guard('sms')) return;
    var n = N(), pending = n.queue.filter(function (q) { return q.status !== 'done'; });
    if (!pending.length) { toast('队列为空', 'ok'); return; }
    if (quietBlocked()) { toast('免打扰时段，暂不发送', 'err'); return; }
    confirmBox('发送待发队列', '将发送 ' + pending.length + ' 条短信，通道为' +
      (cfg().channel === 'native' ? '本机直发' : '系统短信应用') + '，继续？', function () {
        var ps = permState(), useNative = cfg().channel === 'native' && ps.native && ps.sms;
        if (useNative) {
          pending.forEach(function (q) {
            var r = callBridge('sendSms', [q.phone, q.text, q.id]);
            q.status = r === true ? 'done' : 'pending';
            writeHistory([{ phone: q.phone, name: q.name, parcelId: '', goodsNo: q.goodsNo }],
              'sms', r === true ? 'sent' : 'failed', 'native', function () { return q.text; });
          });
        } else {
          openBatchSmsSystem(pending.map(function (q) { return { phone: q.phone, text: q.text }; }),
            function (r) { return r.text; });
          pending.forEach(function (q) {
            q.status = 'done';
            writeHistory([{ phone: q.phone, name: q.name, parcelId: '', goodsNo: q.goodsNo }],
              'sms', 'handoff', 'system', function () { return q.text; });
          });
        }
        saveCfg(); persist('队列发送完成', 'sms', '发送待发队列 ' + pending.length + ' 条');
        try { render('notify'); } catch (e) { }
      });
  }
  function queueClear() {
    confirmBox('清空待发队列', '删除全部待发记录？已发送流水会保留。', function () {
      N().queue = []; saveCfg(); renderQueue(); toast('队列已清空', 'ok');
    });
  }
  function matchPhone() {
    var p = phoneOK(val('callPhone'));
    if (!p) { toast('请先填有效手机号', 'err'); return; }
    var all = [];
    try { all = C.store.listParcels({ status: 'in' }) || []; } catch (e) { }
    var hit = all.filter(function (x) { return phoneOK(x.phone) === p || String(x.phoneTail || '') === p.slice(-4); });
    var box = $('callMatchBox');
    if (box) box.innerHTML = hit.length ? hit.map(function (x) {
      return '<div class="strip-item"><div><b>' + esc(x.recipient || '客户') + '</b> · ' + esc(x.goodsNo) +
        ' · ' + esc(x.slot) + '<div class="muted">' + esc(x.company) + ' · ' + esc(x.trackingNo) + '</div></div></div>';
    }).join('') : '<div class="muted">没有匹配的在库件</div>';
    toast('匹配到 ' + hit.length + ' 件在库包裹', hit.length ? 'ok' : 'err');
  }
  function markMissed(id) {
    var n = N();
    n.calls.forEach(function (c) { if (c.id === id) { c.handled = true; c.note = '已处理'; } });
    saveCfg(); try { renderCalls(); } catch (e) { } toast('已标记处理', 'ok');
  }
  function addCallLog() {
    if (!guard('calls')) return;
    var p = phoneOK(val('callLogPhone'));
    if (!p) { toast('请填有效手机号', 'err'); return; }
    writeCall(p, val('callLogName'), val('callLogKind') || 'missed', val('callLogNote'), num('callLogDuration', 0));
    persist('已登记通话记录', 'calls', '登记通话记录 ' + p);
    try { renderCalls(); } catch (e) { }
  }
  function playVoice() {
    if (!guard('calls')) return;
    var body = val('callVoiceText');
    if (!body) {
      var t = tplById(val('callVoiceTpl'));
      body = t ? t.body : '';
      setVal('callVoiceText', body);
    }
    var recs = buildRecipients('in', '', 0);
    var ctx = recs.length ? parcelCtx(recs[0].parcel, { count: recs[0].count || 1 })
      : { sign: '', name: '客户', company: '快递', station: '驿站', goods: 'A01010023', slot: 'A-3', code: '1234', date: fmt(new Date()), days: 0, count: 1, phone: '' };
    var text = renderText(body, ctx);
    speak(text);
    toast('正在播报：' + text.slice(0, 30) + '…', 'ok');
  }

  /* ==================== 表单 / 变更委托 ==================== */
  function onForm(e) {
    var id = e.target && e.target.id;
    if (!id) return;
    if (id === 'formSmsTpl') {
      try { e.preventDefault(); } catch (e2) { }
      var name = val('smsTplName'), body = val('smsTplBody');
      if (!name || !body) { toast('模板名称和内容都要填', 'err'); return; }
      N().templates.push({ id: uid('tpl'), name: name, kind: val('smsTplKind') || 'sms',
        body: body, builtin: false, enabled: true, at: now() });
      saveCfg(); setVal('smsTplName', ''); setVal('smsTplBody', '');
      renderTplList(); resetTplSelect();
      persist('模板已保存', 'notify', '新增通知模板 ' + name);
    } else if (id === 'formNotifyQueue' || id === 'formNotifyWechat' || id === 'formSmsFilter' ||
      id === 'formCallLog' || id === 'formGroupCall') {
      try { e.preventDefault(); } catch (e2) { }
    }
  }
  function onChange(e) {
    var t = e.target, id = t && t.id;
    if (!id) return;
    if (id === 'smsTemplate') { cfg().templateId = t.value; saveCfg(); ST.smsCustom = ''; setVal('smsCustom', ''); previewSms(true); }
    else if (id === 'smsCustom') { ST.smsCustom = t.value; previewSms(true); }
    else if (id === 'smsScope' || id === 'smsKw' || id === 'smsDays') refreshSmsPool();
    else if (id === 'ntHistoryFilter') { ST.historyFilter = t.value; renderHistory(); }
    else if (id === 'callFilter') { ST.callFilter = t.value; try { renderCalls(); } catch (e2) { } }
    else if (id === 'ntSetChannel') {
      if (t.value === 'native') { var ps = permState(); if (!ps.native) { toast('网页模式不支持本机直发，请用安卓 App', 'err'); setVal('ntSetChannel', 'system'); } }
    }
  }
  function onClick(e) {
    var t = e.target;
    if (t && t.getAttribute && t.hasAttribute && t.hasAttribute('data-sms-pick')) {
      var k = t.getAttribute('data-sms-pick');
      ST.smsSelected[k] = !!t.checked;
      var row = t.parentNode;
      if (row && row.className) row.className = String(row.className).replace(/\s*on\b/g, '') + (t.checked ? ' on' : '');
      renderSmsPool(); previewSms(true);
    }
  }

  /* ==================== 生命周期 ==================== */
  function init(ctx) {
    C = ctx;
    try {
      document.addEventListener('submit', onForm, false);
      document.addEventListener('change', onChange, false);
      document.addEventListener('click', onClick, false);
    } catch (e) { step('事件绑定失败 ' + e.message); }
    ensureTemplates();
  }
  function render(name) {
    if (!C) return;
    ST.view = name;
    step('渲染通知视图 → ' + name);
    try {
      if (name === 'notify') renderNotify();
      else if (name === 'sms') renderSms();
      else if (name === 'calls') renderCalls();
    } catch (e) {
      step('通知视图渲染失败 ' + name + ' ' + e.message);
      toast('页面渲染失败：' + (e.message || e), 'err');
    }
  }

  var out = {
    init: init, render: render, action: action,
    onReceipt: onReceipt, permState: permState,
    renderText: renderText, segments: segments, phoneOK: phoneOK,
    VAR_DESC: VAR_DESC, BUILTIN: BUILTIN, state: ST
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = out; global.StationNotify = out; }
  else global.StationNotify = out;
})(typeof window !== 'undefined' ? window : globalThis);
