/* 驿站助手（重建版）· 业务规则层
   纯函数，无 DOM / 无网络 / 无存储，Node 下可直接测试。 */
(function (global) {
  'use strict';

  var api = {};
  var VERSION = '2.0.2';
  api.VERSION = VERSION;

  function str(v) { return v === null || v === undefined ? '' : String(v); }
  function trim(v) { return str(v).trim(); }
  function upper(v) { return trim(v).toUpperCase(); }
  function pad(n, len) { var s = String(n); while (s.length < len) s = '0' + s; return s; }
  function uid(p) {
    return (p || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function iso(d) { return new Date(d === undefined ? Date.now() : d).toISOString(); }
  function dayKey(v) {
    var d = v ? new Date(v) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2);
  }
  function fmt(v, withTime) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return str(v);
    var s = dayKey(v) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2);
    return withTime === false ? dayKey(v) : s;
  }
  function daysBetween(a, b) {
    var x = new Date(dayKey(a) + 'T00:00:00'), y = new Date(dayKey(b) + 'T00:00:00');
    return Math.max(0, Math.round((y - x) / 86400000));
  }
  function esc(s) {
    return str(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function tail4(v) {
    var d = str(v).replace(/\D/g, '');
    return d.length >= 4 ? d.slice(-4) : d;
  }
  function phoneOk(v) {
    var d = str(v).replace(/\D/g, '');
    return /^1[3-9]\d{9}$/.test(d) || /^0\d{9,11}$/.test(d) || /^\d{7,8}$/.test(d);
  }
  function maskPhone(v) {
    var d = str(v).replace(/\D/g, '');
    if (d.length < 7) return d;
    return d.slice(0, 3) + '****' + d.slice(-4);
  }
  function safeFileName(name) {
    var s = str(name).replace(/[\\/\r\n\t:*?"<>|\x00-\x1f]/g, '_').replace(/\.\./g, '_');
    s = s.replace(/^\.+/, '').trim().slice(0, 90);
    if (!s) s = 'unnamed';
    if (!/\.(jpg|jpeg|png|webp|gif)$/i.test(s)) s += '.jpg';
    return s;
  }
  function stamp(d) {
    var t = d ? new Date(d) : new Date();
    return dayKey(t) + '-' + pad(t.getHours(), 2) + pad(t.getMinutes(), 2) + pad(t.getSeconds(), 2);
  }
  function randSuffix() { return Math.random().toString(36).slice(2, 5); }

  api.str = str; api.trim = trim; api.upper = upper; api.pad = pad; api.uid = uid;
  api.iso = iso; api.dayKey = dayKey; api.fmt = fmt; api.daysBetween = daysBetween;
  api.esc = esc; api.tail4 = tail4; api.phoneOk = phoneOk; api.maskPhone = maskPhone;
  api.safeFileName = safeFileName; api.stamp = stamp;

  /* ---------- 快递公司与单号识别 ---------- */

  var DEFAULT_COMPANIES = [
    { id: 'yt', name: '圆通速递', short: 'YT', rule: '^(YT|8\\d{11,})', enabled: true },
    { id: 'zt', name: '中通快递', short: 'ZT', rule: '^(ZT|75\\d{10,})', enabled: true },
    { id: 'yd', name: '韵达速递', short: 'YD', rule: '^(YD|43\\d{10,}|31\\d{10,})', enabled: true },
    { id: 'sf', name: '顺丰速运', short: 'SF', rule: '^(SF|\\d{12})', enabled: true },
    { id: 'jd', name: '京东物流', short: 'JD', rule: '^(JD|JD\\d+)', enabled: true },
    { id: 'ems', name: '邮政EMS', short: 'EM', rule: '^(EM|E[A-Z]\\d{9}[A-Z]{2}|1[0-9]{12})', enabled: true },
    { id: 'st', name: '申通快递', short: 'ST', rule: '^(ST|77\\d{10,})', enabled: true },
    { id: 'db', name: '德邦快递', short: 'DB', rule: '^(DB|DPK|\\d{10})', enabled: true },
    { id: 'jt', name: '极兔速递', short: 'JT', rule: '^(JT|JT\\d+)', enabled: true },
    { id: 'pdd', name: '拼多多', short: 'PD', rule: '^(PD|PDD)', enabled: true },
    { id: 'other', name: '其他', short: 'QT', rule: '', enabled: true }
  ];
  api.DEFAULT_COMPANIES = DEFAULT_COMPANIES;

  function detectCarrier(no, companies) {
    var n = upper(no).replace(/\s/g, '');
    var list = companies && companies.length ? companies : DEFAULT_COMPANIES;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.enabled === false || !c.rule) continue;
      try { if (new RegExp(c.rule, 'i').test(n)) return c; } catch (e) { /* 忽略错误规则 */ }
    }
    return list.filter(function (c) { return c.id === 'other'; })[0] || { name: '其他', short: 'QT' };
  }
  api.detectCarrier = detectCarrier;

  /* ---------- 编号 / 货号 ---------- */

  var SERIAL_MODES = [
    { id: 'continuous', label: '连续累加（不重置）' },
    { id: 'daily', label: '每日从 1 重新开始' },
    { id: 'slot', label: '按货架位分组累加' },
    { id: 'tail', label: '联系电话后四位' }
  ];
  var GOODS_MODES = [
    { id: 'slotSerial', label: '货架号 + 编号（A01-0023）' },
    { id: 'dateCompany', label: '日期 + 公司简称 + 编号（1123YT0023）' },
    { id: 'tail', label: '手机尾号 + 编号（67890023）' },
    { id: 'plain', label: '纯编号（00023）' },
    { id: 'custom', label: '自定义模板' }
  ];
  api.SERIAL_MODES = SERIAL_MODES;
  api.GOODS_MODES = GOODS_MODES;

  api.DEFAULT_SETTINGS = {
    stationName: '快递驿站', contact: '', phone: '', province: '', address: '',
    zones: ['A', 'B', 'C'], shelvesPerZone: 9, levelsPerShelf: 5,
    serialMode: 'continuous', serialStart: 1, serialWidth: 4,
    goodsMode: 'slotSerial', goodsTemplate: '{slot}{serial}',
    phoneInput: 'manual', queryMode: 'fuzzy',
    beepIn: true, beepOut: false, vibrateIn: true, vibrateOut: false,
    voiceIn: false, voiceOut: false, torch: false,
    photoIn: false, photoOut: true, photoAuto: true, photoOutMode: 'auto',
    blacklistBlock: true, duplicateBlock: true, interceptDays: 30,
    warnDays: 2, dangerDays: 5,
    labelFields: ['station', 'goods', 'slot', 'recipient', 'tail', 'carrier', 'tracking', 'barcode'],
    labelWidth: 80, labelHeight: 50,
    delayUpload: 0, syncEnabled: false,
    autoCapture: true, idleMinutes: 15
  };

  /* ctx: {seq, slot, tail, short, date, template, width, mode} */
  function serialNumber(mode, ctx) {
    ctx = ctx || {};
    var w = Number(ctx.width) || 4;
    if (mode === 'tail') return ctx.tail || pad(ctx.seq || 1, w);
    return pad(ctx.seq || 1, w);
  }
  api.serialNumber = serialNumber;

  function goodsNumber(mode, ctx) {
    ctx = ctx || {};
    var seq = pad(ctx.seq || 1, Number(ctx.width) || 4);
    var slot = upper(ctx.slot || '').replace(/[^A-Z0-9]/g, '');
    var short = upper(ctx.short || 'QT');
    var tail = ctx.tail || '';
    var d = new Date(ctx.date || Date.now());
    var dd = pad(d.getDate(), 2), mm = pad(d.getMonth() + 1, 2);
    switch (mode) {
      case 'dateCompany': return mm + dd + short + seq;
      case 'tail': return (tail || '0000') + seq;
      case 'plain': return seq;
      case 'custom':
        return str(ctx.template || '{slot}{serial}')
          .replace(/\{slot\}/g, slot).replace(/\{serial\}/g, seq)
          .replace(/\{date\}/g, mm + dd).replace(/\{day\}/g, dd)
          .replace(/\{month\}/g, mm).replace(/\{short\}/g, short)
          .replace(/\{tail\}/g, tail).replace(/\{zone\}/g, slot.charAt(0))
          .toUpperCase().replace(/[^A-Z0-9\-]/g, '').slice(0, 24) || seq;
      case 'slotSerial':
      default: return slot + seq;
    }
  }
  api.goodsNumber = goodsNumber;

  /* 原版规则：非数字只能在前三位，结尾必须是数字 */
  function validGoodsNo(s) {
    var v = upper(s);
    if (!v || v.length > 24) return false;
    if (!/^[A-Z0-9\-]+$/.test(v)) return false;
    return /\d$/.test(v); /* 与原版一致：货号结尾必须是数字 */
  }
  api.validGoodsNo = validGoodsNo;

  function slotList(settings) {
    var out = [], z = settings.zones || ['A'], s = Number(settings.shelvesPerZone) || 9,
      l = Number(settings.levelsPerShelf) || 5;
    for (var i = 0; i < z.length; i++)
      for (var j = 1; j <= s; j++)
        for (var k = 1; k <= l; k++) out.push(z[i] + pad(j, 2) + '-' + pad(k, 2));
    return out;
  }
  api.slotList = slotList;

  /* ---------- 批量文本 / CSV 解析 ---------- */

  function splitLine(line) {
    if (line.indexOf(',') >= 0 || line.indexOf('\t') >= 0) {
      return line.split(/[,\t]/).map(function (x) { return x.trim().replace(/^"|"$/g, ''); });
    }
    return line.trim().split(/\s+/);
  }

  /* 每行：单号 [公司] [电话] [货架] [备注]；也支持 CSV 表头 */
  function parseBatch(text, opts) {
    opts = opts || {};
    var rows = [], errors = [];
    var lines = str(text).replace(/\r/g, '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i].trim();
      if (!raw) continue;
      var cells = splitLine(raw).filter(function (x) { return x; });
      if (!cells.length) continue;
      if (i === 0 && /运单号|单号|货号|tracking/i.test(cells[0]) && /电话|手机|公司|货架|备注/.test(raw)) continue;
      var no = upper(cells[0]);
      if (!/^[A-Z0-9\-]{6,32}$/.test(no)) { errors.push({ line: i + 1, text: raw, reason: '单号不合法' }); continue; }
      var row = { trackingNo: no, carrier: '', phone: '', slot: '', note: '' };
      cells.slice(1).forEach(function (c) {
        if (/^[\d\+\-\(\) ]{7,20}$/.test(c) && !row.phone) row.phone = c.replace(/[^\d]/g, '');
        else if (/^[A-Z]\d{2}-\d{2}$/i.test(c) && !row.slot) row.slot = upper(c);
        else if (/^[\u4e00-\u9fa5A-Za-z]{2,12}$/.test(c) && !row.carrier) row.carrier = c;
        else row.note = (row.note ? row.note + ' ' : '') + c;
      });
      if (opts.defaultCarrier && !row.carrier) row.carrier = '';
      rows.push(row);
    }
    return { rows: rows, errors: errors, total: rows.length + errors.length };
  }
  api.parseBatch = parseBatch;

  function parseCSV(text) {
    var lines = str(text).replace(/\r/g, '').split('\n').filter(function (l) { return l.trim(); });
    return lines.map(function (l) {
      var out = [], cur = '', q = false;
      for (var i = 0; i < l.length; i++) {
        var ch = l[i];
        if (ch === '"') { if (q && l[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
        else if (ch === ',' && !q) { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out;
    });
  }
  api.parseCSV = parseCSV;

  function toCSV(rows) {
    return (rows || []).map(function (r) {
      return r.map(function (c) {
        var s = str(c === null || c === undefined ? '' : c);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\r\n');
  }
  api.toCSV = toCSV;

  /* ---------- 查件打分 ---------- */

  function scoreParcel(p, kw, mode) {
    var k = upper(kw).replace(/\s/g, '');
    if (!k) return 1;
    var fields = {
      goodsNo: [upper(p.goodsNo), 160], serial: [upper(p.serial), 140],
      trackingNo: [upper(p.trackingNo), 130], pickupCode: [upper(p.pickupCode), 120],
      phoneTail: [str(p.phoneTail), 100], phone: [str(p.phone).replace(/\D/g, ''), 95],
      slot: [upper(p.slot), 90], recipient: [str(p.recipient), 70],
      carrier: [str(p.carrier), 50], note: [str(p.note), 25], batchId: [upper(p.batchId), 60]
    };
    var best = 0;
    Object.keys(fields).forEach(function (f) {
      var v = fields[f][0], w = fields[f][1];
      if (!v) return;
      if (v === k) best = Math.max(best, w + 40);
      else if (mode === 'exact') { /* 精确模式只认全等 */ }
      else if (v.indexOf(k) === 0) best = Math.max(best, w + 10);
      else if (v.indexOf(k) >= 0) best = Math.max(best, w - 20);
      else if (k.length >= 4 && v.slice(-k.length) === k) best = Math.max(best, w - 10);
    });
    return best;
  }
  api.scoreParcel = scoreParcel;

  /* q: {kw, mode, status, carrier, from, to, label, overdue} */
  function queryParcels(list, q) {
    q = q || {};
    var from = q.from ? dayKey(q.from) : '', to = q.to ? dayKey(q.to) : '';
    var out = (list || []).filter(function (p) {
      if (q.status && q.status !== 'all') {
        if (q.status === 'in' && p.status !== 'in') return false;
        if (q.status === 'out' && p.status !== 'out') return false;
        if (q.status === 'refund' && p.outType !== 'refund') return false;
        if (q.status === 'void' && p.status !== 'void') return false;
        if (q.status === 'overdue' && (p.status !== 'in' || daysBetween(p.inAt, Date.now()) < (q.warnDays || 3))) return false;
      }
      if (q.carrier && q.carrier !== 'all' && p.carrier !== q.carrier) return false;
      if (q.label && p.label !== q.label) return false;
      if (q.slot && upper(p.slot).indexOf(upper(q.slot)) < 0) return false;
      if (from && dayKey(p.inAt) < from) return false;
      if (to && dayKey(p.inAt) > to) return false;
      if (q.outFrom && (!p.outAt || dayKey(p.outAt) < dayKey(q.outFrom))) return false;
      if (q.outTo && (!p.outAt || dayKey(p.outAt) > dayKey(q.outTo))) return false;
      if (q.kw) return scoreParcel(p, q.kw, q.mode) > 0;
      return true;
    });
    if (q.kw) {
      out = out.map(function (p) { return { p: p, s: scoreParcel(p, q.kw, q.mode) }; })
        .sort(function (a, b) { return b.s - a.s || new Date(b.p.inAt) - new Date(a.p.inAt); })
        .map(function (x) { return x.p; });
    } else {
      out.sort(function (a, b) { return new Date(b.inAt) - new Date(a.inAt); });
    }
    if (q.limit) out = out.slice(0, q.limit);
    return out;
  }
  api.queryParcels = queryParcels;

  /* ---------- 时间范围与统计 ---------- */

  var PRESETS = [
    { id: 'today', label: '今天' }, { id: 'yesterday', label: '昨天' },
    { id: 'd3', label: '最近三天' }, { id: 'week', label: '一周内' },
    { id: 'week2', label: '两周内' }, { id: 'month', label: '一个月内' },
    { id: 'month2', label: '两个月内' }, { id: 'month3', label: '三个月内' },
    { id: 'thisweek', label: '本周' }, { id: 'thismonth', label: '本月' },
    { id: 'lastmonth', label: '上个月' }, { id: 'all', label: '全部' },
    { id: 'custom', label: '自定义时间' }
  ];
  api.PRESETS = PRESETS;

  function dateRange(preset, from, to) {
    var now = new Date(), y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
    var s, e = new Date(y, m, d, 23, 59, 59, 999);
    function back(days) { return new Date(y, m, d - days, 0, 0, 0, 0); }
    switch (preset) {
      case 'yesterday': s = back(1); e = new Date(y, m, d - 1, 23, 59, 59, 999); break;
      case 'd3': s = back(2); break;
      case 'week': s = back(6); break;
      case 'week2': s = back(13); break;
      case 'month': s = new Date(y, m - 1, d, 0, 0, 0, 0); break;
      case 'month2': s = new Date(y, m - 2, d, 0, 0, 0, 0); break;
      case 'month3': s = new Date(y, m - 3, d, 0, 0, 0, 0); break;
      case 'thisweek': s = back((now.getDay() + 6) % 7); break;
      case 'thismonth': s = new Date(y, m, 1, 0, 0, 0, 0); break;
      case 'lastmonth': s = new Date(y, m - 1, 1, 0, 0, 0, 0); e = new Date(y, m, 0, 23, 59, 59, 999); break;
      case 'all': s = new Date(2000, 0, 1); break;
      case 'custom':
        s = from ? new Date(from + 'T00:00:00') : back(6);
        e = to ? new Date(to + 'T23:59:59') : e;
        if (s > e) { var t = s; s = e; e = t; }
        break;
      case 'today': default: s = new Date(y, m, d, 0, 0, 0, 0); break;
    }
    var label = (PRESETS.filter(function (p) { return p.id === preset; })[0] || {}).label || '今天';
    if (preset === 'custom') label = dayKey(s) + ' ~ ' + dayKey(e);
    return { from: s.getTime(), to: e.getTime(), fromDay: dayKey(s), toDay: dayKey(e), label: label };
  }
  api.dateRange = dateRange;

  function inRange(t, r) { return t && t >= r.from && t <= r.to; }

  function summarize(parcels, logs, range, settings) {
    settings = settings || {};
    var r = range || dateRange('today');
    var res = {
      label: r.label, fromDay: r.fromDay, toDay: r.toDay,
      inCount: 0, outCount: 0, pickupCount: 0, refundCount: 0,
      undoIn: 0, undoOut: 0, nonOut: 0, outRate: 0,
      inStock: 0, stockDays: { d0: 0, d1: 0, d2: 0, d3: 0, over: 0 },
      byOperator: {}, byCarrier: {}, daily: [], photos: 0
    };
    (parcels || []).forEach(function (p) {
      if (inRange(new Date(p.inAt).getTime(), r)) {
        res.inCount++;
        var op = p.operatorIn || '未记录';
        res.byOperator[op] = res.byOperator[op] || { inCount: 0, outCount: 0, refundCount: 0, undo: 0 };
        res.byOperator[op].inCount++;
        var c = p.carrier || '其他'; res.byCarrier[c] = (res.byCarrier[c] || 0) + 1;
        res.photos += (p.photos || []).length;
      }
      if (p.outAt && inRange(new Date(p.outAt).getTime(), r) && p.status !== 'void') {
        res.outCount++;
        if (p.outType === 'refund') res.refundCount++; else res.pickupCount++;
        var o2 = p.operatorOut || '未记录';
        res.byOperator[o2] = res.byOperator[o2] || { inCount: 0, outCount: 0, refundCount: 0, undo: 0 };
        res.byOperator[o2].outCount++;
        if (p.outType === 'refund') res.byOperator[o2].refundCount++;
      }
      /* 截止区间结束仍在库 */
      var it = new Date(p.inAt).getTime();
      if (it <= r.to && (!p.outAt || new Date(p.outAt).getTime() > r.to) && p.status !== 'void') {
        res.inStock++;
        var days = daysBetween(p.inAt, Math.min(r.to, Date.now()));
        if (days <= 0) res.stockDays.d0++;
        else if (days === 1) res.stockDays.d1++;
        else if (days === 2) res.stockDays.d2++;
        else if (days === 3) res.stockDays.d3++;
        else res.stockDays.over++;
      }
    });
    (logs || []).forEach(function (l) {
      if (!inRange(new Date(l.at).getTime(), r)) return;
      if (l.action === 'undoIn') { res.undoIn++; if (res.byOperator[l.actor]) res.byOperator[l.actor].undo++; }
      if (l.action === 'undoOut') { res.undoOut++; if (res.byOperator[l.actor]) res.byOperator[l.actor].undo++; }
    });
    res.nonOut = Math.max(0, res.inCount - res.outCount);
    res.outRate = res.inCount ? Math.round(res.outCount / res.inCount * 1000) / 10 : 0;

    /* 每日明细 */
    var days = {}, s = new Date(r.from), e = new Date(r.to);
    var guard = 0;
    for (var t = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      t.getTime() <= e.getTime() && guard++ < 400; t.setDate(t.getDate() + 1)) {
      days[dayKey(t)] = { day: dayKey(t), inCount: 0, outCount: 0, pickupCount: 0, refundCount: 0, inStock: 0 };
    }
    (parcels || []).forEach(function (p) {
      var di = dayKey(p.inAt); if (days[di]) days[di].inCount++;
      if (p.outAt) { var dO = dayKey(p.outAt); if (days[dO]) { days[dO].outCount++; if (p.outType === 'refund') days[dO].refundCount++; else days[dO].pickupCount++; } }
    });
    res.daily = Object.keys(days).sort().map(function (k) { return days[k]; });
    return res;
  }
  api.summarize = summarize;

  /* ---------- 提醒与反馈文案 ---------- */
  function feedbackText(kind, p) {
    var g = p && (p.goodsNo || p.serial) || '';
    var s = p && p.slot || '';
    if (kind === 'in') return '入库成功，货号 ' + g + '，货架 ' + s;
    if (kind === 'out') return '出库成功，货号 ' + g;
    if (kind === 'refund') return '退件出库，货号 ' + g;
    if (kind === 'duplicate') return '该单号已入库';
    return '操作完成';
  }
  api.feedbackText = feedbackText;

  /* ---------- 文件名（拍照识别后按条码命名） ---------- */
  function cleanBarcode(raw) {
    var s = upper(raw).replace(/\s/g, '');
    if (/^(HTTPS?|HTTP|WWW|WWW\.)/.test(s)) return '';
    if (/^(19|20)\d{2}$/.test(s)) return '';
    s = s.replace(/[^A-Z0-9\-]/g, '');
    if (s.length < 6 || s.length > 32) return '';
    if (!/\d/.test(s)) return '';
    return s;
  }
  api.cleanBarcode = cleanBarcode;

  function barcodeOf(detected) {
    var d = detected || {};
    var list = (d.barcodes || []).concat(d.texts || []);
    var best = '';
    list.forEach(function (t) {
      var c = cleanBarcode(t);
      if (c && c.length > best.length) best = c;
    });
    return best;
  }
  api.barcodeOf = barcodeOf;

  function inboundPhotoName(code, at) {
    return safeFileName('RK_' + stamp(at) + '_' + (code || '未识别') + '_' + randSuffix() + '.jpg');
  }
  function outboundPhotoName(p, at) {
    var g = p && (p.goodsNo || p.serial) || '取件';
    var t = p && p.trackingNo ? upper(p.trackingNo).slice(-6) : '';
    return safeFileName('CK_' + stamp(at) + '_' + g + (t ? '_' + t : '') + '_' + randSuffix() + '.jpg');
  }
  api.inboundPhotoName = inboundPhotoName;
  api.outboundPhotoName = outboundPhotoName;

  /* ---------- Code39 条码（可扫码枪识别，用于货号标签） ---------- */

  var C39 = {
    '0': 'nnnwwnwnn', '1': 'wnnwnnnnw', '2': 'nnwwnnnnw', '3': 'wnwwnnnnn',
    '4': 'nnnwwnnnw', '5': 'wnnwwnnnn', '6': 'nnwwwnnnn', '7': 'nnnwnnwnw',
    '8': 'wnnwnnwnn', '9': 'nnwwnnwnn', 'A': 'wnnnnwnnw', 'B': 'nnwnnwnnw',
    'C': 'wnwnnwnnn', 'D': 'nnnnwwnnw', 'E': 'wnnnwwnnn', 'F': 'nnwnwwnnn',
    'G': 'nnnnnwwnw', 'H': 'wnnnnwwnn', 'I': 'nnwnnwwnn', 'J': 'nnnnwwwnn',
    'K': 'wnnnnnnww', 'L': 'nnwnnnnww', 'M': 'wnwnnnnwn', 'N': 'nnnnwnnww',
    'O': 'wnnnwnnwn', 'P': 'nnwnwnnwn', 'Q': 'nnnnnnwww', 'R': 'wnnnnnwwn',
    'S': 'nnwnnnwwn', 'T': 'nnnnwnwwn', 'U': 'wwnnnnnnw', 'V': 'nwwnnnnnw',
    'W': 'wwwnnnnnn', 'X': 'nwnnwnnnw', 'Y': 'wwnnwnnnn', 'Z': 'nwwnwnnnn',
    '-': 'nwnnnnwnw', '.': 'wwnnnnwnn', ' ': 'nwwnnwnnn', '$': 'nwnwnwnnn',
    '/': 'nwnwnnnwn', '+': 'nwnnnwnwn', '%': 'nnnwnwnwn', '*': 'nwnnwnwnn'
  };
  api.C39 = C39;

  function code39SVG(text, opts) {
    opts = opts || {};
    var s = upper(text).replace(/[^0-9A-Z\-\. \$/\+%]/g, '').slice(0, 28);
    if (!s) return '';
    var seq = '*' + s + '*';
    var units = [], i, j;
    for (i = 0; i < seq.length; i++) {
      var pat = C39[seq[i]] || C39['*'];
      for (j = 0; j < 9; j++) units.push({ bar: j % 2 === 0, w: pat[j] === 'w' ? 3 : 1 });
      units.push({ bar: false, w: 1 }); /* 字符间窄空 */
    }
    var total = units.reduce(function (a, u) { return a + u.w; }, 0);
    var h = opts.height || 46, x = 0, bars = '';
    for (i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.bar) bars += '<rect x="' + x + '" y="0" width="' + u.w + '" height="' + h + '" fill="#111"/>';
      x += u.w;
    }
    return '<svg class="barcode" viewBox="0 0 ' + total + ' ' + (h + 12) + '" preserveAspectRatio="none" ' +
      'width="100%" height="' + (h + 12) + '" role="img" aria-label="货号条码 ' + esc(s) + '">' +
      bars + '<text x="' + (total / 2) + '" y="' + (h + 10) + '" text-anchor="middle" ' +
      'font-size="8" font-family="monospace" fill="#111">' + esc(s) + '</text></svg>';
  }
  api.code39SVG = code39SVG;

  /* ---------- 标签 HTML（普通打印机 / 蓝牙打印机的网页替代） ---------- */

  function labelHTML(p, settings, fields) {
    settings = settings || {};
    var f = fields || settings.labelFields || api.DEFAULT_SETTINGS.labelFields;
    function has(k) { return f.indexOf(k) >= 0; }
    var rows = [];
    if (has('station')) rows.push('<div class="lb-station">' + esc(settings.stationName || '快递驿站') + '</div>');
    if (has('goods')) rows.push('<div class="lb-goods">' + esc(p.goodsNo || p.serial || '—') + '</div>');
    if (has('slot')) rows.push('<div class="lb-slot">货架 <b>' + esc(p.slot || '—') + '</b>' + (has('serial') ? ' · 编号 ' + esc(p.serial || '—') : '') + '</div>');
    var line = [];
    if (has('recipient')) line.push(esc(p.recipient || '—'));
    if (has('tail')) line.push('尾号 ' + esc(p.phoneTail || '—'));
    if (line.length) rows.push('<div class="lb-line">' + line.join(' · ') + '</div>');
    var line2 = [];
    if (has('carrier')) line2.push(esc(p.carrier || '—'));
    if (has('date')) line2.push(esc(fmt(p.inAt)));
    if (line2.length) rows.push('<div class="lb-line">' + line2.join(' · ') + '</div>');
    if (has('tracking')) rows.push('<div class="lb-no">' + esc(p.trackingNo || '') + '</div>');
    if (has('barcode')) rows.push(code39SVG(p.goodsNo || p.serial || p.trackingNo, { height: 38 }));
    if (has('label') && p.label) rows.push('<div class="lb-tag">' + esc(p.label) + '</div>');
    if (has('note') && p.note) rows.push('<div class="lb-note">' + esc(p.note) + '</div>');
    return '<div class="label-sheet">' + rows.join('') + '</div>';
  }
  api.labelHTML = labelHTML;

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StationRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
