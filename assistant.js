/* 驿站助手业务规则层：纯函数 + 浏览器可选能力（语音播报 / 标签）。
   零依赖，Node 里可直接 require 用于回归测试；不联网、不发短信、不打电话。 */
(function (global) {
  'use strict';

  function str(v) { return v == null ? '' : String(v).trim(); }
  function esc(v) {
    return str(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function pad(n, w) { var s = String(n); while (s.length < (w || 2)) s = '0' + s; return s; }
  function upper(v) { return str(v).toUpperCase(); }
  function safe(v) { return str(v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24); }

  /* ---------- 快递公司：按运单号前缀自动识别，规则可在设置里改 ---------- */
  /* 格式：公司=前缀1|前缀2,公司=前缀。前缀越具体越优先，空前缀不参与匹配。 */
  var DEFAULT_RULES = '圆通=YT|8,韵达=YD|43|46|31,申通=ST|77|66,中通=ZT|75|78|73,' +
    '极兔=JT|JT0,顺丰=SF|SF0,京东=JD|JDX|JD0,邮政=YZ|EMS|EA|EB|9,' +
    '德邦=DB|DBK|DPK,菜鸟=CN|PDD,百世=BS|BT,其他=';

  function parseRules(text) {
    var out = [];
    str(text).split(/[,，\n;；]+/).forEach(function (item) {
      var m = item.split(/[=:：]/);
      var name = str(m[0]);
      if (!name) return;
      var prefixes = str(m.slice(1).join('=')).split(/[|\/、\s]+/).map(upper).filter(Boolean);
      if (prefixes.length) out.push({ name: name, prefixes: prefixes });
    });
    return out;
  }
  function formatRules(rules) {
    return (rules || []).map(function (r) { return r.name + '=' + r.prefixes.join('|'); }).join(',');
  }
  function detectCarrier(trackingNo, rulesText) {
    var no = upper(trackingNo).replace(/[\s-]/g, '');
    if (no.length < 4) return '';
    var rules = parseRules(rulesText || DEFAULT_RULES);
    var hit = null, len = 0;
    rules.forEach(function (r) {
      r.prefixes.forEach(function (pre) {
        if (no.indexOf(pre) === 0 && pre.length > len) { hit = r.name; len = pre.length; }
      });
    });
    return hit || '';
  }
  var SHORTS = {
    '圆通': 'YT', '韵达': 'YD', '申通': 'ST', '中通': 'ZT', '极兔': 'JT', '顺丰': 'SF',
    '京东': 'JD', '邮政': 'YZ', '德邦': 'DB', '菜鸟': 'CN', '百世': 'BS', '其他': 'QT'
  };
  function carrierShort(name) {
    if (SHORTS[name]) return SHORTS[name];
    var letters = upper(name).replace(/[^A-Z0-9]/g, '');
    return (letters || 'QT').slice(0, 2);
  }

  /* ---------- 编号 / 货号 ---------- */
  /* 「编号」是连续流水号（贴件、盘点用），「货号」是按规则生成的找货号。 */
  function compactSlot(slot) {
    var m = /^([A-Za-z0-9]+)-?(\d{1,2})-?(\d{1,2})$/.exec(str(slot));
    if (!m) return safe(slot).slice(0, 12);
    return (m[1] + m[2] + m[3]).toUpperCase();
  }
  function serialText(n, width) { return pad(Math.max(1, Number(n) || 1), width || 4); }
  function goodsNo(mode, ctx) {
    ctx = ctx || {};
    var serial = Number(ctx.serial) || 1;
    var short = carrierShort(ctx.carrier);
    var d = ctx.date ? new Date(ctx.date) : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var mmdd = pad(d.getMonth() + 1) + pad(d.getDate());
    var out;
    switch (mode) {
      case 'date': out = mmdd + short + pad(serial, 3); break;   /* 1114YT007：日期 + 公司简称 */
      case 'phone': out = str(ctx.phoneTail) + '-' + pad(serial, 3); break;
      case 'serial': out = serialText(serial, 4); break;
      case 'off': out = ''; break;
      case 'slot': default: out = compactSlot(ctx.slot); break;  /* A-01-2 → A012 */
    }
    return safe(out).toUpperCase();
  }
  function goodsModeLabel(mode) {
    return { slot: '货架位式（A-01-2 → A012）', date: '日期 + 公司简称 + 流水', phone: '手机尾号 + 流水',
      serial: '纯流水编号', off: '不生成货号' }[mode] || '货架位式';
  }

  /* ---------- 批量文本解析 ---------- */
  /* 每行：单号[,公司,收件人,手机尾号,备注]；也支持制表符、中文逗号；# 开头为注释。 */
  var HEAD = /^(单号|运单号|快递单号|tracking|no)$/i;
  function parseBatch(text) {
    var rows = [], errors = [], seen = {};
    str(text).split(/\r?\n/).forEach(function (line, i) {
      var raw = str(line);
      if (!raw || raw.charAt(0) === '#' || raw.charAt(0) === '/' && raw.charAt(1) === '/') return;
      var cells = raw.split(/[\t,，;；]+|\s{2,}/).map(str);
      var no = str(cells[0]).replace(/^['"]|['"]$/g, '');
      if (HEAD.test(no)) return;
      if (!no || no.length < 4 || /[^A-Za-z0-9_-]/.test(no)) {
        errors.push('第 ' + (i + 1) + ' 行不是有效运单号：' + no.slice(0, 20)); return;
      }
      var key = upper(no);
      if (seen[key]) { errors.push('第 ' + (i + 1) + ' 行重复：' + no); return; }
      seen[key] = true;
      rows.push({
        trackingNo: no,
        carrier: str(cells[1]) || '',
        recipient: str(cells[2]) || '',
        phoneTail: str(cells[3]).replace(/\D/g, '').slice(-4),
        phone: /^1\d{10}$/.test(str(cells[3])) ? str(cells[3]) : '',
        note: str(cells[4]) || ''
      });
    });
    return { rows: rows, errors: errors };
  }
  /* 批量出库：每行一个取件码 / 单号 / 货号 / 编号 / 手机尾号 */
  function parseTokens(text) {
    var out = [], seen = {};
    str(text).split(/\r?\n/).forEach(function (line) {
      var t = str(line).split(/[\t,，;；]+/)[0].replace(/^['"]|['"]$/g, '');
      if (!t || t.charAt(0) === '#' || HEAD.test(t)) return;
      var k = upper(t);
      if (!seen[k]) { seen[k] = true; out.push(t); }
    });
    return out;
  }
  function matchTokens(tokens, inParcels) {
    var list = inParcels || [], matched = [], missing = [], ambiguous = [];
    (tokens || []).forEach(function (token) {
      var k = upper(token), hits = [];
      list.forEach(function (p) {
        var fields = [p.pickupCode, p.trackingNo, p.goodsNo, p.serialNo].map(upper);
        if (fields.indexOf(k) >= 0) { hits.push(p); return; }
        if (/^\d{4}$/.test(k) && upper(p.phoneTail) === k) hits.push(p);
        else if (k.length >= 6 && upper(p.trackingNo).slice(-k.length) === k) hits.push(p);
      });
      if (!hits.length) missing.push(token);
      else if (hits.length > 1) ambiguous.push({ token: token, parcels: hits });
      else matched.push({ token: token, parcel: hits[0] });
    });
    return { matched: matched, missing: missing, ambiguous: ambiguous };
  }

  /* ---------- 客户档案（本地，只用于核对与归并摆放） ---------- */
  function customerKey(phoneTail, name) {
    return str(phoneTail).replace(/\D/g, '').slice(-4) || str(name);
  }
  function mergeCustomer(list, input, now) {
    var items = (list || []).slice();
    var tail = str(input.phoneTail).replace(/\D/g, '').slice(-4);
    var name = str(input.name || input.recipient);
    var key = customerKey(tail, name);
    var idx = -1;
    items.forEach(function (c, i) { if (c.key === key) idx = i; });
    var c = idx >= 0 ? Object.assign({}, items[idx]) : {
      id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      key: key, phoneTail: tail, phone: '', name: name, tag: 'normal', note: '', total: 0,
      createdAt: now || new Date().toISOString()
    };
    if (str(input.phone)) c.phone = str(input.phone);
    if (name) c.name = name;
    if (input.tag !== undefined) c.tag = str(input.tag) || 'normal';
    if (input.note !== undefined) c.note = str(input.note);
    if (input.bump) c.total = (Number(c.total) || 0) + 1;
    c.updatedAt = now || new Date().toISOString();
    if (idx >= 0) items[idx] = c; else items.push(c);
    return { list: items, customer: c };
  }
  var TAG_LABEL = { normal: '普通', vip: '重点客户', block: '黑名单' };
  function tagLabel(t) { return TAG_LABEL[t] || '普通'; }

  /* ---------- 入库拦截：单号 / 手机尾号黑名单 ---------- */
  function parseBlocked(text) {
    return str(text).split(/[,，\s;；\n]+/).map(upper).filter(Boolean);
  }
  function isBlocked(blockedText, trackingNo, phoneTail) {
    var list = parseBlocked(blockedText);
    if (!list.length) return '';
    var no = upper(trackingNo), tail = str(phoneTail).replace(/\D/g, '').slice(-4);
    var hit = list.filter(function (b) {
      return b.length >= 4 && (no === b || no.indexOf(b) === 0 || (tail && b === tail));
    });
    return hit.length ? hit[0] : '';
  }

  /* ---------- 时间段业务统计 ---------- */
  function toTime(v) { var t = new Date(v).getTime(); return isNaN(t) ? 0 : t; }
  function summarize(parcels, logs, opts) {
    opts = opts || {};
    var from = opts.from || 0, to = opts.to || Date.now() + 86400000;
    var res = { inCount: 0, outCount: 0, pickupCount: 0, refundCount: 0, undoInCount: 0,
      byCarrier: {}, byOperator: {}, byDay: {}, details: [], stayHours: 0, staySum: 0 };
    (parcels || []).forEach(function (p) {
      var tin = toTime(p.inAt), tout = p.outAt ? toTime(p.outAt) : 0;
      if (tin >= from && tin <= to) {
        res.inCount++;
        res.details.push({ at: p.inAt, type: '入库', trackingNo: p.trackingNo, carrier: p.carrier,
          operator: p.operatorIn || '', extra: p.goodsNo || p.slot || '', note: p.note || '' });
        var d1 = new Date(tin); var k1 = d1.getFullYear() + '-' + pad(d1.getMonth() + 1) + '-' + pad(d1.getDate());
        res.byDay[k1] = res.byDay[k1] || { in: 0, out: 0, refund: 0 };
        res.byDay[k1].in++;
      }
      if (tout >= from && tout <= to && p.status === 'out') {
        res.outCount++;
        var refund = p.outType === 'refund';
        if (refund) res.refundCount++; else res.pickupCount++;
        res.details.push({ at: p.outAt, type: refund ? '退件出库' : '取件出库', trackingNo: p.trackingNo,
          carrier: p.carrier, operator: p.operatorOut || '', extra: refund ? (p.refundReason || '') : (p.pickupBy || ''), note: p.note || '' });
        var d2 = new Date(tout); var k2 = d2.getFullYear() + '-' + pad(d2.getMonth() + 1) + '-' + pad(d2.getDate());
        res.byDay[k2] = res.byDay[k2] || { in: 0, out: 0, refund: 0 };
        res.byDay[k2].out++;
        if (refund) res.byDay[k2].refund++;
        var op = p.operatorOut || '未记录';
        res.byOperator[op] = res.byOperator[op] || { in: 0, out: 0 };
        res.byOperator[op].out++;
        if (tin > 0 && tout >= tin) { res.staySum += (tout - tin) / 3600000; res.stayHours++; }
      }
      if (tin >= from && tin <= to) {
        res.byCarrier[p.carrier || '其他'] = (res.byCarrier[p.carrier || '其他'] || 0) + 1;
        var opIn = p.operatorIn || '未记录';
        res.byOperator[opIn] = res.byOperator[opIn] || { in: 0, out: 0 };
        res.byOperator[opIn].in++;
      }
    });
    (logs || []).forEach(function (l) {
      var t = toTime(l.at);
      if (t >= from && t <= to && l.type === 'undoIn') res.undoInCount++;
    });
    res.details.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
    res.avgStayHours = res.stayHours ? res.staySum / res.stayHours : 0;
    return res;
  }
  function rangePreset(preset, now) {
    var d = new Date(now || Date.now()); d.setHours(0, 0, 0, 0);
    var from = d.getTime(), to = Date.now() + 86400000;
    if (preset === 'yesterday') { from = d.getTime() - 86400000; to = d.getTime(); }
    else if (preset === '3d') from = d.getTime() - 2 * 86400000;
    else if (preset === 'week') from = d.getTime() - 6 * 86400000;
    else if (preset === 'month') from = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    else if (preset === 'all') from = 0;
    return { from: from, to: to };
  }

  /* ---------- 标签打印（普通打印机 / 浏览器打印，不需要蓝牙） ---------- */
  function labelHTML(p, s) {
    s = s || {};
    p = p || {};
    return '<div class="label-sheet">' +
      '<div class="ls-station">' + esc(s.stationName || '快递驿站') + '</div>' +
      (s.stationAddress || s.stationPhone ? '<div class="ls-sub">' + esc(s.stationAddress || '') + ' ' + esc(s.stationPhone || '') + '</div>' : '') +
      '<div class="ls-caption">货号 / 取件码</div>' +
      '<div class="ls-code">' + esc(p.goodsNo || p.pickupCode || '—') + '</div>' +
      '<div class="ls-slot">货架位 <b>' + esc(p.slot || '—') + '</b>　编号 <b>' + esc(p.serialNo || '—') + '</b></div>' +
      '<div class="ls-row"><span>取件码 ' + esc(p.pickupCode || '—') + '</span><span>尾号 ' + esc(p.phoneTail || '—') + '</span></div>' +
      '<div class="ls-row"><span>收件人 ' + esc(p.recipient || '—') + '</span><span>' + esc(p.carrier || '—') + '</span></div>' +
      '<div class="ls-row"><span>' + esc(p.inAt ? String(p.inAt).slice(0, 16).replace('T', ' ') : '') + '</span><span>件数 ' + esc(p.count || 1) + '</span></div>' +
      '<div class="ls-no">' + esc(p.trackingNo || '') + '</div>' +
      (p.note ? '<div class="ls-note">备注：' + esc(p.note) + '</div>' : '') +
      '</div>';
  }

  /* ---------- 本地语音播报（浏览器自带 TTS，不联网、不拨号） ---------- */
  function canSpeak() {
    return typeof window !== 'undefined' && !!window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function';
  }
  function speak(text, enabled) {
    if (!enabled || !canSpeak() || !str(text)) return false;
    try {
      var u = new window.SpeechSynthesisUtterance(str(text));
      u.lang = 'zh-CN'; u.rate = 1.05; u.volume = 1;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }

  var api = {
    DEFAULT_RULES: DEFAULT_RULES, parseRules: parseRules, formatRules: formatRules,
    detectCarrier: detectCarrier, carrierShort: carrierShort, compactSlot: compactSlot,
    serialText: serialText, goodsNo: goodsNo, goodsModeLabel: goodsModeLabel,
    parseBatch: parseBatch, parseTokens: parseTokens, matchTokens: matchTokens,
    customerKey: customerKey, mergeCustomer: mergeCustomer, tagLabel: tagLabel,
    parseBlocked: parseBlocked, isBlocked: isBlocked,
    summarize: summarize, rangePreset: rangePreset,
    labelHTML: labelHTML, canSpeak: canSpeak, speak: speak, esc: esc, str: str
  };
  global.StationAssistant = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
