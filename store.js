/* 快递驿站 - 数据层。无外部依赖，可注入 storage 以便在 Node 中测试。 */
(function (global) {
  'use strict';

  var KEY = 'express-station.db.v1';

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function uid(prefix) {
    return (prefix || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }
  function isoNow() { return new Date().toISOString(); }
  function dayKey(value) {
    var d = value ? new Date(value) : new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function daysSince(value, now) {
    var t = new Date(value).getTime();
    if (isNaN(t)) return 0;
    return Math.max(0, Math.floor(((now || Date.now()) - t) / 86400000));
  }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function tail4(v) {
    var digits = str(v).replace(/\D/g, '');
    return digits.length > 4 ? digits.slice(-4) : digits;
  }

  function defaultSettings() {
    return {
      stationName: '我的快递驿站',
      warnDays: 3,
      dangerDays: 7,
      carriers: ['中通', '圆通', '韵达', '申通', '极兔', '顺丰', '京东', '邮政', '其他'],
      zones: ['A', 'B', 'C', 'D'],
      shelvesPerZone: 8,
      levelsPerShelf: 4,
      operator: '值班员'
    };
  }

  function defaultDB() {
    return { version: 1, settings: defaultSettings(), parcels: [], logs: [], createdAt: isoNow() };
  }

  function normalizePhotos(list) {
    return (Array.isArray(list) ? list : []).map(function (ph) {
      return {
        id: str(ph.id) || uid('ph'),
        ref: str(ph.ref),
        name: str(ph.name),
        mode: str(ph.mode) || 'browser',
        kind: ph.kind === 'pickup' ? 'pickup' : 'inbound',
        at: ph.at || isoNow(),
        size: Number(ph.size) || 0
      };
    }).filter(function (ph) { return !!ph.ref; });
  }

  function normalize(raw) {
    var base = defaultDB();
    if (!raw || typeof raw !== 'object') return base;
    var s = raw.settings || {};
    base.settings = {
      stationName: str(s.stationName) || base.settings.stationName,
      warnDays: Number(s.warnDays) >= 0 ? Number(s.warnDays) : base.settings.warnDays,
      dangerDays: Number(s.dangerDays) >= 0 ? Number(s.dangerDays) : base.settings.dangerDays,
      carriers: Array.isArray(s.carriers) && s.carriers.length ? s.carriers.map(str).filter(Boolean) : base.settings.carriers,
      zones: Array.isArray(s.zones) && s.zones.length ? s.zones.map(str).filter(Boolean) : base.settings.zones,
      shelvesPerZone: Math.max(1, Math.min(99, Number(s.shelvesPerZone) || base.settings.shelvesPerZone)),
      levelsPerShelf: Math.max(1, Math.min(99, Number(s.levelsPerShelf) || base.settings.levelsPerShelf)),
      operator: str(s.operator) || base.settings.operator
    };
    base.parcels = (Array.isArray(raw.parcels) ? raw.parcels : []).map(function (p) {
      return {
        id: str(p.id) || uid('p'),
        trackingNo: str(p.trackingNo),
        carrier: str(p.carrier) || '其他',
        recipient: str(p.recipient),
        phoneTail: tail4(p.phoneTail),
        slot: str(p.slot),
        note: str(p.note),
        count: Math.max(1, Number(p.count) || 1),
        status: p.status === 'out' ? 'out' : 'in',
        inAt: p.inAt || isoNow(),
        outAt: p.outAt || null,
        pickupBy: str(p.pickupBy),
        operatorIn: str(p.operatorIn),
        operatorOut: str(p.operatorOut),
        photos: normalizePhotos(p.photos)
      };
    });
    base.logs = (Array.isArray(raw.logs) ? raw.logs : []).map(function (l) {
      return {
        id: str(l.id) || uid('l'),
        at: l.at || isoNow(),
        type: str(l.type) || 'edit',
        summary: str(l.summary),
        parcelId: str(l.parcelId),
        trackingNo: str(l.trackingNo)
      };
    });
    base.createdAt = raw.createdAt || base.createdAt;
    return base;
  }

  function memoryStorage() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; }
    };
  }

  function createStore(storage) {
    var st = storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
    var db = read();

    function read() {
      try {
        var raw = st.getItem(KEY);
        return raw ? normalize(JSON.parse(raw)) : defaultDB();
      } catch (e) {
        return defaultDB();
      }
    }
    function save() {
      st.setItem(KEY, JSON.stringify(db));
      return true;
    }
    function log(type, summary, parcel) {
      db.logs.unshift({
        id: uid('l'), at: isoNow(), type: type, summary: summary,
        parcelId: parcel ? parcel.id : '', trackingNo: parcel ? parcel.trackingNo : ''
      });
      if (db.logs.length > 3000) db.logs.length = 3000;
    }
    function settings() { return db.settings; }

    function updateSettings(patch) {
      if (!patch || typeof patch !== 'object') return { ok: false, error: '设置内容无效' };
      var s = normalize({ settings: Object.assign({}, db.settings, patch), parcels: db.parcels, logs: db.logs }).settings;
      db.settings = s;
      log('settings', '更新驿站设置');
      save();
      return { ok: true, settings: s };
    }

    function slotKey(zone, shelf, level) {
      return zone + '-' + pad(shelf) + '-' + level;
    }
    function occupied() {
      var used = {};
      db.parcels.forEach(function (p) { if (p.status === 'in' && p.slot) used[p.slot.toUpperCase()] = true; });
      return used;
    }
    function suggestSlot(zone) {
      var s = db.settings;
      var z = str(zone) || s.zones[0] || 'A';
      var used = occupied();
      for (var i = 1; i <= s.shelvesPerZone; i++) {
        for (var j = 1; j <= s.levelsPerShelf; j++) {
          var key = slotKey(z, i, j);
          if (!used[key.toUpperCase()]) return key;
        }
      }
      return slotKey(z, s.shelvesPerZone, s.levelsPerShelf);
    }
    function slotAvailable(slot, excludeId) {
      if (!slot) return true;
      var key = str(slot).toUpperCase();
      return !db.parcels.some(function (p) {
        return p.status === 'in' && p.id !== excludeId && p.slot && p.slot.toUpperCase() === key;
      });
    }

    function addParcel(input) {
      input = input || {};
      var trackingNo = str(input.trackingNo);
      if (!trackingNo) return { ok: false, error: '运单号不能为空' };
      var dup = db.parcels.find(function (p) {
        return p.status === 'in' && p.trackingNo.toUpperCase() === trackingNo.toUpperCase();
      });
      if (dup) return { ok: false, error: '该运单号已在库：' + dup.slot, parcel: dup };
      var slot = str(input.slot).toUpperCase() || suggestSlot(input.zone || db.settings.zones[0]);
      if (!slotAvailable(slot)) return { ok: false, error: '货架位 ' + slot + ' 已被占用' };
      var p = {
        id: uid('p'),
        trackingNo: trackingNo,
        carrier: str(input.carrier) || '其他',
        recipient: str(input.recipient),
        phoneTail: tail4(input.phoneTail),
        slot: slot,
        note: str(input.note),
        count: Math.max(1, Number(input.count) || 1),
        status: 'in',
        inAt: isoNow(),
        outAt: null,
        pickupBy: '',
        operatorIn: str(input.operator) || db.settings.operator,
        operatorOut: '',
        photos: normalizePhotos(input.photos)
      };
      db.parcels.unshift(p);
      log('in', '入库 ' + p.trackingNo + ' → ' + p.slot + (p.recipient ? ' / ' + p.recipient : '') +
        (p.photos.length ? ' · 含 ' + p.photos.length + ' 张照片' : ''), p);
      save();
      return { ok: true, parcel: p };
    }

    function updateParcel(id, patch) {
      var p = db.parcels.find(function (x) { return x.id === id; });
      if (!p) return { ok: false, error: '包裹不存在' };
      patch = patch || {};
      if (patch.trackingNo !== undefined) {
        var tn = str(patch.trackingNo);
        if (!tn) return { ok: false, error: '运单号不能为空' };
        if (db.parcels.some(function (x) { return x.id !== id && x.status === 'in' && x.trackingNo.toUpperCase() === tn.toUpperCase(); })) {
          return { ok: false, error: '运单号与在库件重复' };
        }
        p.trackingNo = tn;
      }
      if (patch.slot !== undefined) {
        var slot = str(patch.slot).toUpperCase();
        if (!slotAvailable(slot, id)) return { ok: false, error: '货架位已被占用' };
        p.slot = slot;
      }
      ['carrier', 'recipient', 'note', 'pickupBy'].forEach(function (k) {
        if (patch[k] !== undefined) p[k] = str(patch[k]);
      });
      if (patch.phoneTail !== undefined) p.phoneTail = tail4(patch.phoneTail);
      if (patch.count !== undefined) p.count = Math.max(1, Number(patch.count) || 1);
      log('edit', '修改 ' + p.trackingNo + ' 的资料', p);
      save();
      return { ok: true, parcel: p };
    }

    function removeParcel(id) {
      var idx = db.parcels.findIndex(function (x) { return x.id === id; });
      if (idx < 0) return { ok: false, error: '包裹不存在' };
      var p = db.parcels[idx];
      db.parcels.splice(idx, 1);
      log('delete', '删除记录 ' + p.trackingNo, p);
      save();
      return { ok: true, parcel: p };
    }

    function checkout(ids, pickupBy, photos) {
      var list = Array.isArray(ids) ? ids : [ids];
      if (!list.length) return { ok: false, error: '请先选择要出库的包裹' };
      var picked = [];
      for (var i = 0; i < list.length; i++) {
        var p = db.parcels.find(function (x) { return x.id === list[i]; });
        if (!p) return { ok: false, error: '有包裹不存在，请刷新后重试' };
        if (p.status !== 'in') return { ok: false, error: p.trackingNo + ' 已出库' };
        picked.push(p);
      }
      var at = isoNow();
      var who = str(pickupBy) || '本人';
      var operator = db.settings.operator;
      var proof = normalizePhotos(photos).map(function (ph) { ph.kind = 'pickup'; return ph; });
      picked.forEach(function (p) {
        p.status = 'out';
        p.outAt = at;
        p.pickupBy = who;
        p.operatorOut = operator;
      });
      if (proof.length) picked[0].photos = picked[0].photos.concat(proof);
      log('out', '出库 ' + picked.length + ' 件：' + picked.map(function (p) { return p.trackingNo; }).join('、') +
        (proof.length ? ' · 含 ' + proof.length + ' 张取件凭证' : ''), picked[0]);
      save();
      return { ok: true, count: picked.length, parcels: picked };
    }

    function attachPhoto(parcelId, photos) {
      var p = db.parcels.find(function (x) { return x.id === parcelId; });
      if (!p) return { ok: false, error: '包裹不存在' };
      var list = normalizePhotos(Array.isArray(photos) ? photos : [photos]);
      if (!list.length) return { ok: false, error: '照片引用无效' };
      p.photos = p.photos.concat(list);
      log('photo', '为 ' + p.trackingNo + ' 添加 ' + list.length + ' 张照片', p);
      save();
      return { ok: true, photos: list };
    }

    function detachPhoto(parcelId, photoId) {
      var p = db.parcels.find(function (x) { return x.id === parcelId; });
      if (!p) return { ok: false, error: '包裹不存在' };
      var idx = p.photos.findIndex(function (ph) { return ph.id === photoId; });
      if (idx < 0) return { ok: false, error: '照片记录不存在' };
      var removed = p.photos.splice(idx, 1)[0];
      log('photo', '移除 ' + p.trackingNo + ' 的 1 张照片记录（云盘文件保留）', p);
      save();
      return { ok: true, photo: removed };
    }

    function restoreParcel(id) {
      var p = db.parcels.find(function (x) { return x.id === id; });
      if (!p) return { ok: false, error: '包裹不存在' };
      if (p.status === 'in') return { ok: false, error: '该包裹已在库' };
      if (!slotAvailable(p.slot, p.id)) return { ok: false, error: '原货架位 ' + p.slot + ' 已被占用，请先修改货架位' };
      p.status = 'in';
      p.outAt = null;
      p.pickupBy = '';
      p.operatorOut = '';
      log('restore', '撤销出库，恢复在库 ' + p.trackingNo, p);
      save();
      return { ok: true, parcel: p };
    }

    function decorate(p, now) {
      var s = db.settings;
      var days = p.status === 'in' ? daysSince(p.inAt, now) : daysSince(p.inAt, p.outAt ? new Date(p.outAt).getTime() : now);
      var level = p.status === 'in' && days >= s.dangerDays ? 'danger'
        : p.status === 'in' && days >= s.warnDays ? 'warn' : 'normal';
      return Object.assign({}, p, { stayDays: days, overdueLevel: level });
    }

    function listParcels(filter) {
      filter = filter || {};
      var now = Date.now();
      var kw = str(filter.keyword).toLowerCase();
      var out = db.parcels.map(function (p) { return decorate(p, now); });
      out = out.filter(function (p) {
        if (filter.status && p.status !== filter.status) return false;
        if (filter.carrier && p.carrier !== filter.carrier) return false;
        if (filter.zone && p.slot.toUpperCase().indexOf(str(filter.zone).toUpperCase() + '-') !== 0) return false;
        if (filter.overdueMin !== undefined && filter.overdueMin !== '' && p.stayDays < Number(filter.overdueMin)) return false;
        if (filter.overdueLevel && p.overdueLevel !== filter.overdueLevel) return false;
        if (kw) {
          var hay = [p.trackingNo, p.recipient, p.phoneTail, p.slot, p.carrier, p.note].join(' ').toLowerCase();
          if (hay.indexOf(kw) === -1) return false;
        }
        return true;
      });
      var by = filter.sortBy || 'inAt';
      var dir = filter.sortDir === 'asc' ? 1 : -1;
      out.sort(function (a, b) {
        var x = a[by], y = b[by];
        if (x == null) x = '';
        if (y == null) y = '';
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir;
        return String(x).localeCompare(String(y), 'zh-CN') * dir;
      });
      return out;
    }

    /* 查件：取件窗口的快速检索。在库优先、精确命中优先、最近优先，含已出库记录 */
    function lookup(keyword, scope) {
      var kw = str(keyword).trim().toLowerCase();
      if (!kw) return [];
      var rows = listParcels({ keyword: kw, status: scope || undefined });
      var digits = kw.replace(/\D/g, '');
      function score(p) {
        var no = str(p.trackingNo).toLowerCase();
        var tail = str(p.phoneTail).toLowerCase();
        var slot = str(p.slot).toLowerCase();
        var s = 0;
        if (digits.length >= 4 && tail === digits) s += 100;
        if (no === kw) s += 90;
        if (slot && slot === kw) s += 80;
        if (p.status === 'in') s += 40;
        if (tail && tail.indexOf(kw) === 0) s += 20;
        if (no.indexOf(kw) === 0) s += 15;
        return s;
      }
      rows.sort(function (a, b) {
        var d = score(b) - score(a);
        if (d) return d;
        return String(b.inAt || '').localeCompare(String(a.inAt || ''));
      });
      return rows.slice(0, 60);
    }

    function listLogs(filter) {
      filter = filter || {};
      var kw = str(filter.keyword).toLowerCase();
      return db.logs.filter(function (l) {
        if (filter.type && l.type !== filter.type) return false;
        if (kw && [l.summary, l.trackingNo, l.type].join(' ').toLowerCase().indexOf(kw) === -1) return false;
        return true;
      });
    }

    function stats() {
      var now = Date.now();
      var today = dayKey();
      var s = db.settings;
      var todayIn = 0, todayOut = 0, inStock = 0, warn = 0, danger = 0;
      var byCarrier = {}, byZone = {}, stayHours = [], overdueBuckets = { '0-2': 0, '3-6': 0, '7+': 0 };
      var last7 = [];
      for (var i = 6; i >= 0; i--) {
        var d = new Date(now - i * 86400000);
        last7.push({ day: dayKey(d), label: pad(d.getMonth() + 1) + '/' + pad(d.getDate()), in: 0, out: 0 });
      }
      var dayIndex = {};
      last7.forEach(function (x, i) { dayIndex[x.day] = i; });
      db.parcels.forEach(function (p) {
        var inDay = dayKey(p.inAt);
        if (inDay === today) todayIn++;
        if (dayIndex[inDay] !== undefined) last7[dayIndex[inDay]].in++;
        if (p.outAt) {
          var outDay = dayKey(p.outAt);
          if (outDay === today) todayOut++;
          if (dayIndex[outDay] !== undefined) last7[dayIndex[outDay]].out++;
          var h = (new Date(p.outAt).getTime() - new Date(p.inAt).getTime()) / 3600000;
          if (h >= 0 && h < 24 * 365) stayHours.push(h);
        }
        if (p.status === 'in') {
          inStock++;
          var days = daysSince(p.inAt, now);
          if (days >= s.dangerDays) { danger++; overdueBuckets['7+']++; }
          else if (days >= s.warnDays) { warn++; overdueBuckets['3-6']++; }
          else overdueBuckets['0-2']++;
          byCarrier[p.carrier] = (byCarrier[p.carrier] || 0) + 1;
          var z = (p.slot.split('-')[0] || '未分区').toUpperCase();
          byZone[z] = (byZone[z] || 0) + 1;
        }
      });
      var capacity = s.zones.length * s.shelvesPerZone * s.levelsPerShelf;
      return {
        todayIn: todayIn, todayOut: todayOut, inStock: inStock,
        warn: warn, danger: danger, capacity: capacity,
        avgStayHours: stayHours.length ? stayHours.reduce(function (a, b) { return a + b; }, 0) / stayHours.length : 0,
        last7: last7,
        byCarrier: Object.keys(byCarrier).map(function (k) { return { name: k, value: byCarrier[k] }; }).sort(function (a, b) { return b.value - a.value; }),
        byZone: Object.keys(byZone).map(function (k) { return { name: k, value: byZone[k] }; }).sort(function (a, b) { return a.name.localeCompare(b.name); }),
        overdueBuckets: overdueBuckets
      };
    }

    function exportJSON() {
      return JSON.stringify({ app: 'express-station', version: 1, exportedAt: isoNow(), data: db }, null, 2);
    }
    function importJSON(text, mode) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: '文件不是有效的 JSON' }; }
      var payload = parsed && parsed.data ? parsed.data : parsed;
      if (!payload || !Array.isArray(payload.parcels)) return { ok: false, error: '备份文件缺少包裹数据' };
      var incoming = normalize(payload);
      if (mode === 'merge') {
        var seen = {};
        db.parcels.forEach(function (p) { seen[p.id] = true; });
        var added = 0;
        incoming.parcels.forEach(function (p) {
          if (!seen[p.id]) { db.parcels.push(p); seen[p.id] = true; added++; }
        });
        var logSeen = {};
        db.logs.forEach(function (l) { logSeen[l.id] = true; });
        incoming.logs.forEach(function (l) { if (!logSeen[l.id]) db.logs.push(l); });
        db.logs.sort(function (a, b) { return String(b.at).localeCompare(String(a.at)); });
        log('import', '合并导入备份，新增 ' + added + ' 条包裹');
        save();
        return { ok: true, count: added };
      }
      db = incoming;
      log('import', '覆盖导入备份，共 ' + db.parcels.length + ' 条包裹');
      save();
      return { ok: true, count: db.parcels.length };
    }

    function csvCell(v) {
      var s = str(v).replace(/"/g, '""');
      return '"' + s + '"';
    }
    function exportCSV(kind) {
      var rows = [];
      if (kind === 'logs') {
        rows.push(['时间', '类型', '摘要', '关联运单号']);
        db.logs.forEach(function (l) {
          rows.push([fmtTime(l.at), logTypeName(l.type), l.summary, l.trackingNo]);
        });
      } else {
        rows.push(['运单号', '快递公司', '收件人', '手机后四位', '货架位', '件数', '状态', '入库时间', '出库时间', '取件人', '照片数', '备注']);
        listParcels({ status: kind === 'instock' ? 'in' : undefined, sortBy: 'inAt' }).forEach(function (p) {
          rows.push([p.trackingNo, p.carrier, p.recipient, p.phoneTail, p.slot, p.count,
            p.status === 'in' ? '在库' : '已出库', fmtTime(p.inAt), p.outAt ? fmtTime(p.outAt) : '', p.pickupBy,
            (p.photos || []).length, p.note]);
        });
      }
      return '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    }

    function fmtTime(v) {
      var d = new Date(v);
      if (isNaN(d.getTime())) return str(v);
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }
    function logTypeName(t) {
      return { in: '入库', out: '出库', edit: '修改', delete: '删除', restore: '撤销出库', settings: '设置', import: '导入', clear: '清空', photo: '照片' }[t] || t;
    }

    function clearAll() {
      var n = db.parcels.length;
      db = defaultDB();
      log('clear', '清空全部数据（原 ' + n + ' 条包裹）');
      save();
      return { ok: true, count: n };
    }
    function clearLogs() {
      var n = db.logs.length;
      db.logs = [];
      save();
      return { ok: true, count: n };
    }
    function seedDemo() {
      var s = db.settings;
      var names = ['张先生', '李女士', '王先生', '陈女士', '刘先生', '赵女士', '孙先生', '周女士'];
      var carriers = s.carriers.length ? s.carriers : ['中通', '圆通', '韵达', '申通'];
      var zones = s.zones.length ? s.zones : ['A'];
      var now = Date.now();
      var added = 0;
      for (var i = 0; i < 18; i++) {
        var daysAgo = i % 10;
        var hoursAgo = (i * 7) % 20;
        var inMs = now - daysAgo * 86400000 - hoursAgo * 3600000;
        var inAt = new Date(inMs).toISOString();
        var isOut = i % 3 === 0 && daysAgo >= 2;
        var outAt = null;
        if (isOut) {
          var candidate = inMs + (6 + i % 30) * 3600000;
          outAt = new Date(Math.min(candidate, now - 60000)).toISOString();
        }
        var zone = zones[i % zones.length];
        db.parcels.push({
          id: uid('p'),
          trackingNo: 'SF' + String(100000000000 + i * 7919),
          carrier: carriers[i % carriers.length],
          recipient: names[i % names.length],
          phoneTail: String(1000 + (i * 1379) % 9000),
          slot: suggestSlot(zone),
          note: i % 5 === 0 ? '大件' : '',
          count: 1,
          status: isOut ? 'out' : 'in',
          inAt: inAt,
          outAt: outAt,
          pickupBy: isOut ? '本人' : '',
          operatorIn: s.operator,
          operatorOut: isOut ? s.operator : '',
          photos: []
        });
        added++;
      }
      log('import', '载入演示数据 ' + added + ' 条');
      save();
      return { ok: true, count: added };
    }
    function reload() { db = read(); return db; }

    return {
      seedDemo: seedDemo,
      attachPhoto: attachPhoto,
      detachPhoto: detachPhoto,
      normalizePhotos: normalizePhotos,
      KEY: KEY,
      getDB: function () { return db; },
      settings: settings,
      updateSettings: updateSettings,
      suggestSlot: suggestSlot,
      slotAvailable: slotAvailable,
      addParcel: addParcel,
      updateParcel: updateParcel,
      removeParcel: removeParcel,
      checkout: checkout,
      restoreParcel: restoreParcel,
      listParcels: listParcels,
      lookup: lookup,
      listLogs: listLogs,
      stats: stats,
      exportJSON: exportJSON,
      importJSON: importJSON,
      exportCSV: exportCSV,
      fmtTime: fmtTime,
      logTypeName: logTypeName,
      daysSince: daysSince,
      clearAll: clearAll,
      clearLogs: clearLogs,
      reload: reload
    };
  }

  var api = {
    createStore: createStore,
    memoryStorage: memoryStorage,
    defaultSettings: defaultSettings,
    dayKey: dayKey,
    daysSince: daysSince,
    tail4: tail4,
    fmtTime: function (v) {
      var d = new Date(v), p = function (n) { return n < 10 ? '0' + n : '' + n; };
      if (isNaN(d.getTime())) return str(v);
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    logTypeName: function (t) {
      return { in: '入库', out: '出库', edit: '修改', delete: '删除', restore: '撤销出库', settings: '设置', import: '导入', clear: '清空', photo: '照片' }[t] || t;
    }
  };
  global.StationStore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
