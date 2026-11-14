/* 驿站助手（重建版）· 数据层
   本地优先：localStorage 持久化；被禁用时自动降级为内存存储，页面不崩。
   所有写操作都留流水，支持导出 / 恢复 / 清空。 */
(function (global) {
  'use strict';

  var R = global.StationRules || (typeof require !== 'undefined' ? require('./rules.js') : null);
  var KEY = 'station.rebuild.v1';
  var str = R.str, upper = R.upper, dayKey = R.dayKey, fmt = R.fmt, iso = R.iso,
    uid = R.uid, pad = R.pad, tail4 = R.tail4, stamp = R.stamp;

  /* 读取 localStorage 属性本身就可能抛 SecurityError（部分手机浏览器 / 隐私模式） */
  function pickStorage(kind) {
    try {
      var s = kind === 'session' ? global.sessionStorage : global.localStorage;
      if (!s) return memoryStorage();
      var probe = '__station_probe__';
      s.setItem(probe, '1'); s.removeItem(probe);
      return s;
    } catch (e) { return memoryStorage(); }
  }
  function memoryStorage() {
    var m = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
      setItem: function (k, v) { m[k] = String(v); },
      removeItem: function (k) { delete m[k]; },
      _memory: true
    };
  }

  /* 老 Android WebView（Chromium < 45）没有 Array.prototype.findIndex */
  function indexWhere(arr, fn) {
    for (var i = 0; i < arr.length; i++) { if (fn(arr[i], i)) return i; }
    return -1;
  }

  function defaultDB() {
    var s = {};
    Object.keys(R.DEFAULT_SETTINGS).forEach(function (k) { s[k] = R.DEFAULT_SETTINGS[k]; });
    return {
      app: 'station-assistant', version: 2, createdAt: iso(),
      settings: s,
      parcels: [],
      customers: [],
      companies: JSON.parse(JSON.stringify(R.DEFAULT_COMPANIES)),
      labels: ['加急', '易碎', '大件', '生鲜', '到付'],
      accounts: [],
      logs: [],
      uploads: [],
      collections: [],
      intercepts: [],
      counters: { serial: (s.serialStart || 1) - 1, daily: {}, slot: {}, batch: 0, collection: 0 }
    };
  }

  function normalizeParcel(p) {
    p = p || {};
    return {
      id: str(p.id) || uid('p'),
      trackingNo: upper(p.trackingNo),
      carrier: str(p.carrier) || '其他',
      carrierShort: str(p.carrierShort) || 'QT',
      recipient: str(p.recipient),
      phone: str(p.phone),
      phoneTail: str(p.phoneTail) || tail4(p.phone),
      slot: upper(p.slot),
      serial: str(p.serial),
      goodsNo: upper(p.goodsNo),
      pickupCode: str(p.pickupCode) || upper(p.goodsNo),
      note: str(p.note), label: str(p.label),
      count: Math.max(1, Number(p.count) || 1),
      status: ['in', 'out', 'void'].indexOf(p.status) >= 0 ? p.status : 'in',
      inAt: p.inAt || iso(), outAt: p.outAt || null,
      outType: str(p.outType), outReason: str(p.outReason), outNote: str(p.outNote),
      pickupBy: str(p.pickupBy), refundReason: str(p.refundReason),
      batchId: str(p.batchId),
      operatorIn: str(p.operatorIn), operatorOut: str(p.operatorOut),
      photos: Array.isArray(p.photos) ? p.photos.map(function (x) {
        return typeof x === 'string' ? { id: x, name: x, at: '', kind: '' } : {
          id: str(x.id), name: str(x.name), at: x.at || '', kind: str(x.kind)
        };
      }) : [],
      uploadState: str(p.uploadState) || 'local',
      moveHistory: Array.isArray(p.moveHistory) ? p.moveHistory : [],
      history: Array.isArray(p.history) ? p.history : []
    };
  }

  function normalizeDB(raw) {
    var base = defaultDB();
    if (!raw || typeof raw !== 'object') return base;
    var d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    var s = d.settings || {};
    Object.keys(base.settings).forEach(function (k) {
      if (s[k] !== undefined && s[k] !== null) base.settings[k] = s[k];
    });
    if (!Array.isArray(base.settings.zones) || !base.settings.zones.length) base.settings.zones = ['A'];
    ['parcels', 'customers', 'companies', 'labels', 'accounts', 'logs', 'uploads', 'collections', 'intercepts'].forEach(function (k) {
      if (Array.isArray(d[k])) base[k] = d[k];
    });
    base.parcels = base.parcels.map(normalizeParcel);
    var c = d.counters || {};
    Object.keys(base.counters).forEach(function (k) { if (c[k] !== undefined) base.counters[k] = c[k]; });
    base.createdAt = d.createdAt || base.createdAt;
    return base;
  }

  /* 旧版（1.x express-station）备份导入兼容：字段对齐，不做隐式覆盖 */
  function fromLegacy(raw) {
    var d = raw && raw.data ? raw.data : raw;
    if (!d || !Array.isArray(d.parcels)) return null;
    var out = defaultDB();
    if (d.settings) {
      ['stationName', 'operator', 'zones', 'shelvesPerZone', 'levelsPerShelf', 'codeMode'].forEach(function (k) {
        if (d.settings[k] !== undefined) out.settings[k] = d.settings[k];
      });
    }
    out.parcels = d.parcels.map(function (p) {
      return normalizeParcel({
        id: p.id, trackingNo: p.trackingNo, carrier: p.carrier, recipient: p.recipient,
        phoneTail: p.phoneTail, slot: p.slot, note: p.note, count: p.count,
        goodsNo: p.goodsNo || p.pickupCode, pickupCode: p.pickupCode,
        serial: p.serial || p.goodsNo || '', status: p.status, inAt: p.inAt, outAt: p.outAt,
        outType: p.outType || (p.status === 'out' ? 'pickup' : ''), pickupBy: p.pickupBy,
        batchId: p.batchId, operatorIn: p.operatorIn, operatorOut: p.operatorOut,
        photos: p.photos
      });
    });
    if (Array.isArray(d.customers)) out.customers = d.customers;
    if (Array.isArray(d.logs)) out.logs = d.logs.map(function (l) {
      return { id: l.id, at: l.at, action: l.action, text: l.text, actor: l.actor || '', ref: l.ref || '' };
    });
    return out;
  }

  function createStore(storage, actorName) {
    var storage = storage || pickStorage('local');
    var db = defaultDB();
    var actor = str(actorName) || '未登录';
    try {
      var saved = storage.getItem(KEY);
      if (saved) db = normalizeDB(JSON.parse(saved));
    } catch (e) { db = defaultDB(); }

    function save() {
      try { storage.setItem(KEY, JSON.stringify(db)); return true; }
      catch (e) { return false; }
    }
    function storageOk() { return !storage._memory; }
    function setActor(n) { actor = str(n) || '未登录'; }
    function getActor() { return actor; }
    function raw() { return db; }

    function log(action, text, ref) {
      var l = { id: uid('l'), at: iso(), action: action, text: text, actor: actor, ref: ref || '' };
      db.logs.unshift(l);
      if (db.logs.length > 5000) db.logs.length = 5000;
      return l;
    }

    function queueUpload(p, action) {
      var u = {
        id: uid('u'), parcelId: p.id, goodsNo: p.goodsNo, trackingNo: p.trackingNo,
        action: action, state: db.settings.syncEnabled ? 'pending' : 'local',
        at: iso(), note: db.settings.syncEnabled ? '等待同步' : '本机模式，无需上传'
      };
      db.uploads.unshift(u);
      if (db.uploads.length > 3000) db.uploads.length = 3000;
      return u;
    }

    /* ---------- 设置 ---------- */
    function settings() { return db.settings; }
    function updateSettings(patch) {
      patch = patch || {};
      var oldStart = db.settings.serialStart;
      Object.keys(patch).forEach(function (k) {
        if (k in db.settings) db.settings[k] = patch[k];
      });
      if (patch.serialStart !== undefined && Number(patch.serialStart) !== Number(oldStart)) {
        db.counters.serial = Math.max(0, Number(patch.serialStart) || 1) - 1;
      }
      log('settings', '修改设置：' + Object.keys(patch).join('、'));
      save();
      return db.settings;
    }

    /* ---------- 编号 / 货架 ---------- */
    function occupied(slot, exceptId) {
      if (!slot) return false;
      return db.parcels.some(function (p) {
        return p.status === 'in' && p.id !== exceptId && upper(p.slot) === upper(slot);
      });
    }
    function suggestSlot(zone) {
      var list = R.slotList(db.settings);
      var z = upper(zone || db.settings.zones[0]);
      var prefer = list.filter(function (s) { return s.charAt(0) === z; });
      var pool = prefer.length ? prefer : list;
      for (var i = 0; i < pool.length; i++) if (!occupied(pool[i])) return pool[i];
      return '';
    }
    function nextSeq(slot) {
      var mode = db.settings.serialMode, c = db.counters, seq;
      if (mode === 'daily') {
        var k = dayKey(); c.daily[k] = (c.daily[k] || 0) + 1; seq = c.daily[k];
      } else if (mode === 'slot') {
        var z = upper(slot || 'A'); c.slot[z] = (c.slot[z] || 0) + 1; seq = c.slot[z];
      } else {
        c.serial = (c.serial || 0) + 1; seq = c.serial;
      }
      return seq;
    }
    /* 预览不消耗计数器：渲染页面时反复调用也不会跳号 */
    function peekSeq(slot) {
      var mode = db.settings.serialMode, c = db.counters;
      if (mode === 'daily') return (c.daily[dayKey()] || 0) + 1;
      if (mode === 'slot') return (c.slot[upper(slot || 'A')] || 0) + 1;
      return (c.serial || 0) + 1;
    }
    function makeNums(ctx, seq) {
      var s = db.settings;
      return {
        seq: seq,
        serial: R.serialNumber(s.serialMode, { seq: seq, width: s.serialWidth, tail: ctx.tail }),
        goodsNo: R.goodsNumber(s.goodsMode, {
          seq: seq, width: s.serialWidth, slot: ctx.slot, tail: ctx.tail,
          short: ctx.short, date: Date.now(), template: s.goodsTemplate
        })
      };
    }
    function previewNums(ctx) { return makeNums(ctx || {}, peekSeq(ctx && ctx.slot)); }
    function buildNums(ctx) { return makeNums(ctx || {}, nextSeq(ctx && ctx.slot)); }

    /* ---------- 客户 / 拦截 ---------- */
    function listCustomers(q) {
      var kw = upper(q && q.kw);
      return db.customers.filter(function (c) {
        if (q && q.type && q.type !== 'all' && c.type !== q.type) return false;
        if (!kw) return true;
        return [c.name, c.phone, c.tail, c.remark].join(' ').toUpperCase().indexOf(kw) >= 0;
      }).sort(function (a, b) { return new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0); });
    }
    function customerByTail(t) {
      return db.customers.filter(function (c) { return c.tail === t; })[0] || null;
    }
    function upsertCustomer(input) {
      input = input || {};
      var phone = str(input.phone).replace(/\D/g, '');
      var tail = str(input.tail) || tail4(phone);
      if (!tail && !str(input.name)) return { ok: false, error: '请填客户姓名或手机号' };
      if (phone && !R.phoneOk(phone)) return { ok: false, error: '联系电话格式不正确' };
      var c = input.id ? db.customers.filter(function (x) { return x.id === input.id; })[0]
        : db.customers.filter(function (x) { return x.tail === tail || (phone && x.phone === phone); })[0];
      if (!c) {
        c = { id: uid('c'), createdAt: iso(), count: 0, name: '', phone: '', tail: tail,
          type: 'normal', star: '', remark: '' };
        db.customers.unshift(c);
      }
      /* 只覆盖本次显式提交的字段：按尾号自动归档时不能把 VIP / 备注冲掉 */
      if (input.name !== undefined && str(input.name)) c.name = str(input.name);
      if (input.phone !== undefined && phone) c.phone = phone;
      if (input.tail !== undefined && tail) c.tail = tail;
      if (input.remark !== undefined) c.remark = str(input.remark);
      if (input.type !== undefined && str(input.type)) c.type = str(input.type);
      if (input.star !== undefined) c.star = str(input.star);
      c.updatedAt = iso();
      log('customer', '保存客户 ' + (c.name || c.tail) + '（' + c.type + '）', c.id);
      save();
      return { ok: true, customer: c, replaced: !!input.id };
    }
    function removeCustomer(id) {
      var i = indexWhere(db.customers, function (c) { return c.id === id; });
      if (i < 0) return { ok: false, error: '客户不存在' };
      var c = db.customers.splice(i, 1)[0];
      log('customer', '删除客户 ' + (c.name || c.tail), id);
      save();
      return { ok: true, customer: c };
    }
    function touchCustomer(p) {
      var t = p.phoneTail || tail4(p.phone);
      if (!t) return null;
      var c = customerByTail(t);
      if (!c) {
        c = { id: uid('c'), name: p.recipient || '', phone: p.phone || '', tail: t,
          type: 'normal', star: '', remark: '', count: 0, createdAt: iso() };
        db.customers.unshift(c);
      }
      if (p.recipient && !c.name) c.name = p.recipient;
      if (p.phone && !c.phone) c.phone = p.phone;
      c.count = (c.count || 0) + 1;
      c.lastAt = iso();
      c.updatedAt = iso();
      return c;
    }
    function isBlacklisted(phone, tail) {
      var t = tail || tail4(phone);
      return db.customers.some(function (c) { return c.type === 'black' && c.tail && c.tail === t; });
    }
    function listIntercepts() { return db.intercepts; }
    function addIntercept(no, reason) {
      var n = upper(no);
      if (!n) return { ok: false, error: '请输入单号' };
      if (db.intercepts.some(function (x) { return x.no === n; })) return { ok: false, error: '该单号已拦截' };
      var it = { id: uid('i'), no: n, reason: str(reason) || '手动添加', at: iso() };
      db.intercepts.unshift(it);
      log('intercept', '添加入库拦截 ' + n, it.id);
      save();
      return { ok: true, intercept: it };
    }
    function removeIntercept(id) {
      var i = indexWhere(db.intercepts, function (x) { return x.id === id; });
      if (i < 0) return { ok: false, error: '记录不存在' };
      var it = db.intercepts.splice(i, 1)[0];
      log('intercept', '移除入库拦截 ' + it.no, id);
      save();
      return { ok: true };
    }
    function isIntercepted(no) {
      return db.intercepts.some(function (x) { return x.no === upper(no); });
    }
    function pruneIntercepts() {
      var days = Number(db.settings.interceptDays) || 30;
      var cut = Date.now() - days * 86400000;
      var n = db.intercepts.length;
      db.intercepts = db.intercepts.filter(function (x) { return new Date(x.at).getTime() >= cut; });
      return n - db.intercepts.length;
    }

    /* ---------- 包裹 ---------- */
    function listParcels(q) { return R.queryParcels(db.parcels, q); }
    function getParcel(id) { return db.parcels.filter(function (p) { return p.id === id; })[0] || null; }
    function findByNo(no) {
      var n = upper(no);
      return db.parcels.filter(function (p) { return upper(p.trackingNo) === n; })[0] || null;
    }
    function findByCode(code) {
      var k = upper(code);
      return db.parcels.filter(function (p) {
        return p.status === 'in' && (upper(p.goodsNo) === k || upper(p.serial) === k ||
          upper(p.pickupCode) === k || upper(p.trackingNo) === k || str(p.phoneTail) === k);
      });
    }

    function addParcel(input) {
      input = input || {};
      var s = db.settings;
      var no = upper(input.trackingNo);
      if (!no) return { ok: false, error: '运单号不能为空' };
      if (no.length < 6) return { ok: false, error: '运单号太短，请输入完整单号' };
      if (s.duplicateBlock !== false) {
        var dup = db.parcels.filter(function (p) {
          return p.status === 'in' && upper(p.trackingNo) === no;
        })[0];
        if (dup) return { ok: false, error: '此快递已入库：' + (dup.goodsNo || dup.slot), parcel: dup, code: 'duplicate' };
      }
      if (isIntercepted(no)) return { ok: false, error: '此快递已被设为入库拦截', code: 'intercepted' };
      var phone = str(input.phone).replace(/[^\d]/g, '');
      var t = str(input.phoneTail) || tail4(phone);
      if (phone && !R.phoneOk(phone) && phone.length !== 4) {
        return { ok: false, error: '请输入正确的联系电话（或只填后四位）' };
      }
      if (s.blacklistBlock && isBlacklisted(phone, t)) {
        return { ok: false, error: '该号码在黑名单中，已拦截入库', code: 'blacklist' };
      }
      var companies = db.companies;
      var carrier = str(input.carrier) || R.detectCarrier(no, companies).name;
      var co = companies.filter(function (c) { return c.name === carrier; })[0];
      var short = co ? co.short : (R.detectCarrier(no, companies).short || 'QT');
      var slot = upper(input.slot) || suggestSlot(input.zone);
      if (!slot) return { ok: false, error: '货架位已满，请先移库或调整货架设置' };
      if (occupied(slot)) return { ok: false, error: '货架位 ' + slot + ' 已被占用' };
      var nums = buildNums({ slot: slot, tail: t, short: short });
      var goodsNo = upper(input.goodsNo) || nums.goodsNo;
      if (!R.validGoodsNo(goodsNo)) return { ok: false, error: '货号不合法：非数字只能在前三位，结尾必须是数字' };
      var p = normalizeParcel({
        trackingNo: no, carrier: carrier, carrierShort: short,
        recipient: str(input.recipient), phone: phone, phoneTail: t,
        slot: slot, serial: str(input.serial) || nums.serial, goodsNo: goodsNo,
        pickupCode: goodsNo, note: str(input.note), label: str(input.label),
        count: Math.max(1, Number(input.count) || 1), status: 'in', inAt: iso(),
        operatorIn: str(input.operator) || actor,
        photos: input.photos || [], batchId: str(input.batchId) || ''
      });
      db.parcels.unshift(p);
      touchCustomer(p);
      queueUpload(p, 'in');
      log('in', '入库 ' + p.trackingNo + ' → 货号 ' + p.goodsNo + ' / ' + p.slot +
        (p.recipient ? ' / ' + p.recipient : ''), p.id);
      save();
      return { ok: true, parcel: p };
    }

    function batchAdd(rows, opts) {
      opts = opts || {};
      var ok = [], fail = [];
      var batchId = 'IN-' + stamp() + '-' + rand();
      rows.forEach(function (r, i) {
        var payload = {};
        Object.keys(r || {}).forEach(function (k) { payload[k] = r[k]; });
        payload.batchId = batchId; payload.operator = opts.operator || actor;
        var res = addParcel(payload);
        if (res.ok) ok.push(res.parcel);
        else fail.push({ index: i + 1, row: r, error: res.error });
      });
      if (ok.length) log('batchIn', '批量入库 ' + ok.length + ' 件，失败 ' + fail.length + ' 件', batchId);
      return { ok: true, count: ok.length, parcels: ok, failed: fail, batchId: batchId };
    }
    function rand() { return Math.random().toString(36).slice(2, 5); }

    function updateParcel(id, patch) {
      var p = getParcel(id);
      if (!p) return { ok: false, error: '包裹不存在' };
      patch = patch || {};
      var before = R.fmt(p.inAt) + ' ' + p.goodsNo + '/' + p.slot;
      if (patch.goodsNo !== undefined) {
        var g = upper(patch.goodsNo);
        if (!R.validGoodsNo(g)) return { ok: false, error: '货号不合法：非数字只能在前三位，结尾必须是数字' };
        p.goodsNo = g; p.pickupCode = g;
      }
      if (patch.slot !== undefined) {
        var sl = upper(patch.slot);
        if (sl && sl !== p.slot && occupied(sl, p.id)) return { ok: false, error: '货架位 ' + sl + ' 已被占用' };
        p.slot = sl;
      }
      ['serial', 'trackingNo', 'carrier', 'recipient', 'note', 'label'].forEach(function (k) {
        if (patch[k] !== undefined) p[k] = (k === 'trackingNo' || k === 'serial') ? upper(patch[k]) : str(patch[k]);
      });
      if (patch.phone !== undefined) {
        var ph = str(patch.phone).replace(/[^\d]/g, '');
        if (ph && ph.length !== 4 && !R.phoneOk(ph)) return { ok: false, error: '联系电话格式不正确' };
        p.phone = ph; p.phoneTail = tail4(ph);
        touchCustomer(p);
      }
      if (patch.phoneTail !== undefined) { p.phoneTail = tail4(patch.phoneTail); }
      log('edit', '修改包裹 ' + p.trackingNo + '（' + before + ' → ' + p.goodsNo + '/' + p.slot + '）', p.id);
      save();
      return { ok: true, parcel: p };
    }

    function removeParcel(id) {
      var i = indexWhere(db.parcels, function (p) { return p.id === id; });
      if (i < 0) return { ok: false, error: '包裹不存在' };
      var p = db.parcels.splice(i, 1)[0];
      log('delete', '删除记录 ' + p.trackingNo, p.id);
      save();
      return { ok: true, parcel: p };
    }

    function undoInbound(idOrBatch) {
      var list = idOrBatch && idOrBatch.indexOf && idOrBatch.indexOf('IN-') === 0
        ? db.parcels.filter(function (p) { return p.batchId === idOrBatch && p.status === 'in'; })
        : [getParcel(idOrBatch)].filter(function (p) { return p && p.status === 'in'; });
      if (!list.length) return { ok: false, error: '没有可撤销的入库记录' };
      list.forEach(function (p) {
        p.status = 'void';
        p.history.push({ at: iso(), action: 'undoIn', actor: actor });
      });
      log('undoIn', '撤销本次入库 ' + list.length + ' 件', idOrBatch);
      save();
      return { ok: true, count: list.length, parcels: list };
    }

    /* 出库：outType = pickup/goods/phone/scan/merge/refund */
    function checkout(ids, opts) {
      opts = opts || {};
      var picked = (ids || []).map(getParcel).filter(function (p) { return p && p.status === 'in'; });
      if (!picked.length) return { ok: false, error: '没有可出库的在库包裹' };
      var type = str(opts.outType) || 'pickup';
      if (type === 'refund' && !str(opts.reason) && !str(opts.refundReason)) {
        return { ok: false, error: '请选择退件原因' };
      }
      var merged = picked.length > 1 || type === 'merge';
      db.counters.batch = (db.counters.batch || 0) + 1;
      var batchId = 'OUT-' + stamp() + '-' + pad(db.counters.batch, 3);
      picked.forEach(function (p) {
        p.status = 'out'; p.outAt = iso(); p.outType = type;
        p.outReason = str(opts.reason || opts.refundReason);
        p.refundReason = p.outReason;
        p.outNote = str(opts.note);
        p.pickupBy = str(opts.pickupBy);
        p.operatorOut = str(opts.operator) || actor;
        p.batchId = batchId;
        if (Array.isArray(opts.photos) && opts.photos.length) {
          p.photos = p.photos.concat(opts.photos.map(function (x) {
            return typeof x === 'string' ? { id: x, name: x, at: iso(), kind: 'out' } : x;
          }));
        }
        p.history.push({ at: iso(), action: type, actor: actor, batchId: batchId });
        queueUpload(p, type === 'refund' ? 'refund' : 'out');
      });
      log(type === 'refund' ? 'refund' : 'out',
        (merged ? '合并出库 ' : '') + picked.length + ' 件 · 批次 ' + batchId + ' · ' +
        (type === 'refund' ? '退件（' + str(opts.reason || opts.refundReason) + '）' : type), batchId);
      save();
      return { ok: true, count: picked.length, parcels: picked, batchId: batchId, merged: merged, outType: type };
    }

    function undoCheckout(ids) {
      var list = (ids || []).map(getParcel).filter(function (p) { return p && p.status === 'out'; });
      if (!list.length) return { ok: false, error: '选中的记录不支持撤销出库' };
      list.forEach(function (p) {
        p.history.push({ at: iso(), action: 'undoOut', actor: actor, batchId: p.batchId });
        p.status = 'in'; p.outAt = null; p.outType = ''; p.outReason = '';
        p.pickupBy = ''; p.operatorOut = ''; p.batchId = '';
      });
      log('undoOut', '撤销出库 ' + list.length + ' 件', ids.join(','));
      save();
      return { ok: true, count: list.length, parcels: list };
    }

    /* 移库：换货架位，可选重算货号 */
    function moveSlots(ids, slot, opts) {
      opts = opts || {};
      var sl = upper(slot);
      if (!sl) return { ok: false, error: '请输入移库后货架号' };
      var list = (ids || []).map(getParcel).filter(function (p) { return p && p.status === 'in'; });
      if (!list.length) return { ok: false, error: '无待移库记录' };
      var same = list.filter(function (p) { return p.slot === sl; });
      if (same.length === list.length) return { ok: false, error: '货架号相同，无需移库' };
      var moved = [];
      list.forEach(function (p) {
        if (p.slot === sl) return;
        var from = p.slot;
        p.slot = sl;
        if (opts.regenGoods) {
          p.goodsNo = R.goodsNumber(opts.mode || 'slotSerial', {
            seq: Number(p.serial) || 1, width: db.settings.serialWidth,
            slot: sl, tail: p.phoneTail, short: p.carrierShort,
            template: db.settings.goodsTemplate
          });
          p.pickupCode = p.goodsNo;
        }
        p.moveHistory.push({ at: iso(), from: from, to: sl, actor: actor });
        moved.push(p);
      });
      log('move', '移库 ' + moved.length + ' 件 → ' + sl, sl);
      save();
      return { ok: true, count: moved.length, parcels: moved };
    }

    /* 批量修改编号 / 货号：从指定包裹起重新累加 */
    function batchRenum(startId, kind) {
      var list = db.parcels.filter(function (p) { return p.status === 'in'; })
        .sort(function (a, b) {
          /* 同一毫秒入库时用现有编号做次序，保证「此号之后累加」结果稳定 */
          var na = Number(a.serial) || 0, nb = Number(b.serial) || 0;
          if (na && nb && na !== nb) return na - nb;
          return new Date(a.inAt) - new Date(b.inAt);
        });
      var idx = indexWhere(list, function (p) { return p.id === startId; });
      if (idx < 0) return { ok: false, error: '起始包裹不在库' };
      var baseRaw = str(list[idx][kind === 'goods' ? 'goodsNo' : 'serial']);
      var m = baseRaw.match(/(\d+)$/);
      var start = m ? parseInt(m[1], 10) : 1;
      var prefix = m ? baseRaw.slice(0, m.index) : '';
      for (var i = idx; i < list.length; i++) {
        var v = prefix + pad(start + (i - idx), m ? m[1].length : db.settings.serialWidth);
        list[i][kind === 'goods' ? 'goodsNo' : 'serial'] = v;
        if (kind === 'goods') list[i].pickupCode = v;
      }
      log('renum', '批量修改' + (kind === 'goods' ? '货号' : '编号') + '：从 ' + baseRaw + ' 起共 ' + (list.length - idx) + ' 件');
      save();
      return { ok: true, count: list.length - idx };
    }

    /* ---------- 公司 / 标签 ---------- */
    function listCompanies() { return db.companies; }
    function upsertCompany(input) {
      input = input || {};
      var name = str(input.name).trim();
      if (!name) return { ok: false, error: '请输入公司名称' };
      if (input.rule) { try { new RegExp(input.rule); } catch (e) { return { ok: false, error: '识别规则不是合法正则' }; } }
      var c = input.id ? db.companies.filter(function (x) { return x.id === input.id; })[0] : null;
      if (!c) { c = { id: uid('co') }; db.companies.push(c); }
      c.name = name; c.short = upper(input.short) || name.slice(0, 2);
      c.rule = str(input.rule); c.enabled = input.enabled !== false;
      log('company', '保存快递公司 ' + name, c.id);
      save();
      return { ok: true, company: c };
    }
    function removeCompany(id) {
      var i = indexWhere(db.companies, function (c) { return c.id === id; });
      if (i < 0) return { ok: false, error: '公司不存在' };
      var c = db.companies.splice(i, 1)[0];
      log('company', '删除快递公司 ' + c.name, id);
      save();
      return { ok: true };
    }
    function listLabels() { return db.labels; }
    function setLabels(arr) {
      db.labels = (arr || []).map(function (x) { return str(x).trim().slice(0, 6); })
        .filter(function (x, i, a) { return x && a.indexOf(x) === i; }).slice(0, 20);
      save(); return db.labels;
    }

    /* ---------- 收件（寄件）任务 ---------- */
    function listCollections(q) {
      var kw = upper(q && q.kw);
      return db.collections.filter(function (c) {
        if (q && q.status && q.status !== 'all' && c.status !== q.status) return false;
        if (!kw) return true;
        return [c.no, c.sender, c.recipient, c.phone, c.carrier].join(' ').toUpperCase().indexOf(kw) >= 0;
      }).sort(function (a, b) { return new Date(b.at) - new Date(a.at); });
    }
    function addCollection(input) {
      input = input || {};
      if (!str(input.recipient) && !str(input.phone)) return { ok: false, error: '请填写收件人或联系电话' };
      db.counters.collection = (db.counters.collection || 0) + 1;
      var c = {
        id: uid('col'), no: 'SJ' + pad(db.counters.collection, 4),
        sender: str(input.sender), senderPhone: str(input.senderPhone),
        recipient: str(input.recipient), phone: str(input.phone),
        address: str(input.address), carrier: str(input.carrier),
        weight: Number(input.weight) || 0, fee: Number(input.fee) || 0,
        note: str(input.note), status: 'pending', at: iso(), operator: actor
      };
      db.collections.unshift(c);
      log('collection', '新建收件任务 ' + c.no + ' · ' + c.recipient, c.id);
      save();
      return { ok: true, collection: c };
    }
    function updateCollection(id, patch) {
      var c = db.collections.filter(function (x) { return x.id === id; })[0];
      if (!c) return { ok: false, error: '任务不存在' };
      Object.keys(patch || {}).forEach(function (k) { if (k in c) c[k] = patch[k]; });
      log('collection', '更新收件任务 ' + c.no + ' → ' + (c.status || ''), id);
      save();
      return { ok: true, collection: c };
    }
    function removeCollection(id) {
      var i = indexWhere(db.collections, function (x) { return x.id === id; });
      if (i < 0) return { ok: false, error: '任务不存在' };
      var c = db.collections.splice(i, 1)[0];
      log('collection', '删除收件任务 ' + c.no, id);
      save();
      return { ok: true };
    }

    /* ---------- 同步 / 上传记录（本地模式等价实现） ---------- */
    function listUploads(q) {
      return db.uploads.filter(function (u) {
        if (q && q.state && q.state !== 'all' && u.state !== q.state) return false;
        if (q && q.kw) {
          var k = upper(q.kw);
          return [u.goodsNo, u.trackingNo, u.action].join(' ').toUpperCase().indexOf(k) >= 0;
        }
        return true;
      });
    }
    function retryUpload(id) {
      var u = db.uploads.filter(function (x) { return x.id === id; })[0];
      if (!u) return { ok: false, error: '记录不存在' };
      u.state = db.settings.syncEnabled ? 'pending' : 'local';
      u.at = iso();
      u.note = db.settings.syncEnabled ? '已重新排入同步队列' : '本机模式，无需上传';
      log('sync', '重新标记同步记录 ' + (u.goodsNo || u.trackingNo), id);
      save();
      return { ok: true, upload: u };
    }

    /* ---------- 账号（由 auth.js 管理，数据放这里） ---------- */
    function getAccounts() { return db.accounts; }
    function setAccounts(arr) { db.accounts = arr || []; save(); }

    /* ---------- 统计 / 导出 ---------- */
    function stats(range) { return R.summarize(db.parcels, db.logs, range, db.settings); }
    function listLogs(q) {
      var kw = upper(q && q.kw);
      return db.logs.filter(function (l) {
        if (q && q.action && q.action !== 'all' && l.action !== q.action) return false;
        if (kw && [l.text, l.actor, l.action].join(' ').toUpperCase().indexOf(kw) < 0) return false;
        return true;
      }).slice(0, (q && q.limit) || 500);
    }
    function exportCSV(kind, q) {
      var rows = [];
      if (kind === 'customers') {
        rows.push(['姓名', '电话', '尾号', '类型', '星标', '备注', '累计件数', '最近入库']);
        listCustomers(q).forEach(function (c) {
          rows.push([c.name, c.phone, c.tail, c.type, c.star, c.remark, c.count || 0, R.fmt(c.lastAt)]);
        });
      } else if (kind === 'logs') {
        rows.push(['时间', '操作', '内容', '操作人']);
        listLogs(q).forEach(function (l) { rows.push([R.fmt(l.at), l.action, l.text, l.actor]); });
      } else if (kind === 'stats') {
        var s = stats((q && q.range) || R.dateRange('month'));
        rows.push(['日期', '入库数', '出库数', '取件数', '退件数']);
        s.daily.forEach(function (d) { rows.push([d.day, d.inCount, d.outCount, d.pickupCount, d.refundCount]); });
      } else {
        rows.push(['货号', '编号', '运单号', '快递公司', '收件人', '联系电话', '尾号', '货架号', '标签',
          '状态', '入库时间', '出库时间', '出库类型', '退件原因', '取件人', '出库备注', '在库天数',
          '件数', '照片数', '批次', '备注', '操作员入库', '操作员出库', '同步状态']);
        listParcels(q || {}).forEach(function (p) {
          rows.push([p.goodsNo, p.serial, p.trackingNo, p.carrier, p.recipient, p.phone, p.phoneTail,
            p.slot, p.label, p.status === 'in' ? '在库' : p.status === 'out' ? (p.outType === 'refund' ? '已退件' : '已出库') : '已撤销',
            R.fmt(p.inAt), R.fmt(p.outAt), p.outType, p.refundReason, p.pickupBy, p.outNote,
            p.status === 'in' ? R.daysBetween(p.inAt, Date.now()) : (p.outAt ? R.daysBetween(p.inAt, p.outAt) : ''),
            p.count, (p.photos || []).length, p.batchId, p.note, p.operatorIn, p.operatorOut, p.uploadState]);
        });
      }
      return '\ufeff' + R.toCSV(rows);
    }

    function exportSnapshot() {
      return { app: 'station-assistant', version: 2, exportedAt: iso(), data: JSON.parse(JSON.stringify(db)) };
    }
    function restoreSnapshot(obj, mode) {
      if (!obj || typeof obj !== 'object') return { ok: false, error: '不是有效的备份文件' };
      var incoming;
      if (obj.app === 'express-station') incoming = fromLegacy(obj);
      else if (obj.app === 'station-assistant') incoming = normalizeDB(obj);
      else return { ok: false, error: '备份文件来源不明（' + str(obj.app) + '）' };
      if (!incoming) return { ok: false, error: '备份里没有可导入的数据' };
      if (mode === 'merge') {
        var seen = {};
        db.parcels.forEach(function (p) { seen[p.id] = true; });
        incoming.parcels.forEach(function (p) { if (!seen[p.id]) db.parcels.push(p); });
        ['customers', 'logs', 'uploads', 'collections', 'intercepts', 'accounts'].forEach(function (k) {
          var ids = {};
          db[k].forEach(function (x) { ids[x.id] = true; });
          incoming[k].forEach(function (x) { if (!ids[x.id]) db[k].push(x); });
        });
      } else {
        db = incoming;
      }
      log('restore', '恢复备份（' + (mode === 'merge' ? '合并' : '覆盖') + '）');
      save();
      return { ok: true, parcels: db.parcels.length };
    }
    function clearAll() {
      db = defaultDB();
      save();
      return { ok: true };
    }

    return {
      KEY: KEY, raw: raw, save: save, storageOk: storageOk,
      setActor: setActor, getActor: getActor, log: log,
      settings: settings, updateSettings: updateSettings,
      suggestSlot: suggestSlot, occupied: occupied, buildNums: buildNums, previewNums: previewNums,
      listCustomers: listCustomers, customerByTail: customerByTail, upsertCustomer: upsertCustomer,
      removeCustomer: removeCustomer, touchCustomer: touchCustomer, isBlacklisted: isBlacklisted,
      listIntercepts: listIntercepts, addIntercept: addIntercept, removeIntercept: removeIntercept,
      isIntercepted: isIntercepted, pruneIntercepts: pruneIntercepts,
      listParcels: listParcels, getParcel: getParcel, findByNo: findByNo, findByCode: findByCode,
      addParcel: addParcel, batchAdd: batchAdd, updateParcel: updateParcel, removeParcel: removeParcel,
      undoInbound: undoInbound, checkout: checkout, undoCheckout: undoCheckout,
      moveSlots: moveSlots, batchRenum: batchRenum,
      listCompanies: listCompanies, upsertCompany: upsertCompany, removeCompany: removeCompany,
      listLabels: listLabels, setLabels: setLabels,
      listCollections: listCollections, addCollection: addCollection,
      updateCollection: updateCollection, removeCollection: removeCollection,
      listUploads: listUploads, retryUpload: retryUpload,
      getAccounts: getAccounts, setAccounts: setAccounts,
      stats: stats, listLogs: listLogs, exportCSV: exportCSV,
      exportSnapshot: exportSnapshot, restoreSnapshot: restoreSnapshot, clearAll: clearAll
    };
  }

  var out = { KEY: KEY, createStore: createStore, pickStorage: pickStorage, memoryStorage: memoryStorage,
    defaultDB: defaultDB, normalizeParcel: normalizeParcel, fromLegacy: fromLegacy };
  if (typeof module !== 'undefined' && module.exports) { module.exports = out; global.StationDB = out; }
  else global.StationDB = out;
})(typeof window !== 'undefined' ? window : globalThis);
