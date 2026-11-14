/* 快递驿站 - 本机账号体系：注册站长、登录、子账号与角色权限。
   零依赖、无服务端：账号库存 localStorage，密码只存「随机盐 + 多轮 SHA-256 哈希」。
   账号库可通过 snapshot/restore 随台账 JSON 备份和 GitHub 同步迁移到其它设备。 */
(function (global) {
  'use strict';

  var KEY = 'express-station.accounts.v1';
  var SESSION_KEY = 'express-station.session.v1';
  var REMEMBER_KEY = 'express-station.remember.v1';
  var LOCK_KEY = 'express-station.loginlock.v1';
  var ROUNDS = 400;

  /* 登录失败限速：连续错 5 次开始锁定，之后每错一次锁定时长翻倍，上限 15 分钟。
     纯前端只能做到「本设备」粒度，清空浏览器数据即可绕过，主要挡住随手猜密码。 */
  var MAX_TRIES = 5;
  var BASE_LOCK_MS = 60 * 1000;
  var MAX_LOCK_MS = 15 * 60 * 1000;

  var ROLE_NAMES = { owner: '站长', operator: '操作员', viewer: '只读访客' };
  /* owner：全部；operator：日常入库出库与台账；viewer：只看不动 */
  var PERMS = {
    owner: { read: 1, write: 1, manage: 1, owner: 1 },
    operator: { read: 1, write: 1, manage: 0, owner: 0 },
    viewer: { read: 1, write: 0, manage: 0, owner: 0 }
  };

  function memoryStorage() {
    var map = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; }
    };
  }
  function str(v) { return v == null ? '' : String(v).trim(); }
  function uid(p) {
    return (p || 'id') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }
  function isoNow() { return new Date().toISOString(); }

  /* ---------- SHA-256（同步纯 JS，file:// 与 Node 都能跑，不依赖 crypto.subtle） ---------- */
  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];
  function utf8Bytes(s) {
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        var c2 = s.charCodeAt(++i);
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256Hex(input) {
    var bytes = utf8Bytes(String(input));
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var bitLen = (utf8Bytes(String(input)).length) * 8;
    var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var w = new Array(64);
    for (var off = 0; off < bytes.length; off += 64) {
      for (var i = 0; i < 16; i++) {
        w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) |
          (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
      }
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
      H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
      H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    return H.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }
  function randomHex(n) {
    var out = '';
    if (global.crypto && global.crypto.getRandomValues) {
      var arr = new Uint8Array(n);
      global.crypto.getRandomValues(arr);
      for (var j = 0; j < arr.length; j++) out += ('0' + arr[j].toString(16)).slice(-2);
      return out;
    }
    for (var i = 0; i < n; i++) out += ('0' + Math.floor(Math.random() * 256).toString(16)).slice(-2);
    return out;
  }
  function hashPassword(password, salt) {
    var x = sha256Hex(salt + String(password));
    for (var i = 0; i < ROUNDS; i++) x = sha256Hex(x + salt);
    return x;
  }

  function emptyDB() { return { version: 1, accounts: [], createdAt: isoNow() }; }
  function normalizeAccount(a) {
    if (!a || typeof a !== 'object') return null;
    var username = str(a.username).toLowerCase();
    if (!username || !a.salt || !a.hash) return null;
    return {
      id: str(a.id) || uid('u'),
      username: username,
      name: str(a.name) || username,
      role: ROLE_NAMES[a.role] ? a.role : 'viewer',
      salt: str(a.salt),
      hash: str(a.hash),
      active: a.active !== false,
      createdAt: a.createdAt || isoNow(),
      createdBy: str(a.createdBy),
      lastLoginAt: a.lastLoginAt || ''
    };
  }
  function normalizeDB(raw) {
    var db = emptyDB();
    if (!raw || typeof raw !== 'object') return db;
    db.accounts = (Array.isArray(raw.accounts) ? raw.accounts : [])
      .map(normalizeAccount).filter(Boolean);
    db.createdAt = raw.createdAt || db.createdAt;
    db.version = 1;
    return db;
  }
  function publicAccount(a) {
    if (!a) return null;
    return {
      id: a.id, username: a.username, name: a.name, role: a.role,
      roleName: ROLE_NAMES[a.role] || a.role, active: a.active,
      createdAt: a.createdAt, createdBy: a.createdBy, lastLoginAt: a.lastLoginAt
    };
  }

  function createAuth(storage, sessionStorageLike) {
    var st = storage || (typeof localStorage !== 'undefined' ? localStorage : memoryStorage());
    var ses = sessionStorageLike || (typeof sessionStorage !== 'undefined' ? sessionStorage : memoryStorage());
    var db = read();

    function read() {
      try {
        var raw = st.getItem(KEY);
        return raw ? normalizeDB(JSON.parse(raw)) : emptyDB();
      } catch (e) { return emptyDB(); }
    }
    function save() { st.setItem(KEY, JSON.stringify(db)); return true; }
    function readJSON(store, key) {
      try { return JSON.parse(store.getItem(key) || 'null'); } catch (e) { return null; }
    }
    function writeSession(userId, remember) {
      ses.setItem(SESSION_KEY, JSON.stringify({ userId: userId, at: Date.now() }));
      if (remember) {
        st.setItem(REMEMBER_KEY, JSON.stringify({ userId: userId, until: Date.now() + 7 * 86400000 }));
      } else st.removeItem(REMEMBER_KEY);
    }
    function sessionUserId() {
      var s = readJSON(ses, SESSION_KEY);
      if (s && s.userId) return s.userId;
      var r = readJSON(st, REMEMBER_KEY);
      if (r && r.userId && r.until > Date.now()) return r.userId;
      return '';
    }
    function findById(id) { return db.accounts.find(function (a) { return a.id === id; }) || null; }
    function findByUsername(u) {
      var key = str(u).toLowerCase();
      return db.accounts.find(function (a) { return a.username === key; }) || null;
    }

    function status() {
      var lock = lockRemain();
      return {
        hasAccounts: db.accounts.length > 0,
        count: db.accounts.length,
        loggedIn: !!current(),
        needSetup: db.accounts.length === 0,
        /* 只有「一个账号都没有」时才允许初始化；之后自助注册永久关闭 */
        canRegister: db.accounts.length === 0,
        lockSeconds: lock,
        lockLeft: lock > 0 ? lock : 0
      };
    }
    function current() {
      var a = findById(sessionUserId());
      return a && a.active ? publicAccount(a) : null;
    }
    function actor() {
      var c = current();
      return c ? c.name : '';
    }
    function can(perm) {
      var c = current();
      if (!c) return false;
      return !!(PERMS[c.role] || {})[perm];
    }
    function requireOwner() {
      var c = current();
      if (!c) return { ok: false, error: '请先登录' };
      if (c.role !== 'owner') return { ok: false, error: '只有站长可以管理子账号' };
      return { ok: true };
    }

    function validPassword(pw) {
      if (String(pw || '').length < 6) return { ok: false, error: '密码至少 6 位' };
      return { ok: true };
    }
    function makeAccount(input, role, creator) {
      var salt = randomHex(16);
      return {
        id: uid('u'),
        username: str(input.username).toLowerCase(),
        name: str(input.name) || str(input.username),
        role: role,
        salt: salt,
        hash: hashPassword(input.password, salt),
        active: true,
        createdAt: isoNow(),
        createdBy: creator || '',
        lastLoginAt: ''
      };
    }

    /* 首次使用：注册站长。已有账号后禁止再次调用，避免被绕过提权 */
    function register(input) {
      input = input || {};
      /* 自助注册只用于「站点初始化」，有账号后彻底关闭，新账号只能由站长在后台添加 */
      if (db.accounts.length) return { ok: false, error: '本站已初始化，不能自助注册，请联系站长开通账号' };
      var username = str(input.username).toLowerCase();
      if (!/^[a-z0-9_.-]{2,32}$/.test(username)) {
        return { ok: false, error: '登录账号需 2–32 位，只能用字母、数字、_ . -' };
      }
      var vp = validPassword(input.password);
      if (!vp.ok) return vp;
      if (String(input.password) !== String(input.confirm)) return { ok: false, error: '两次输入的密码不一致' };
      var a = makeAccount({ username: username, name: input.name, password: input.password }, 'owner', '');
      db.accounts.push(a);
      clearLock();
      save();
      writeSession(a.id, !!input.remember);
      return { ok: true, account: publicAccount(a) };
    }

    function login(input) {
      input = input || {};
      var wait = lockRemain();
      if (wait > 0) {
        return { ok: false, error: '密码错误次数过多，请 ' + wait + ' 秒后再试', lockSeconds: wait };
      }
      var a = findByUsername(input.username);
      /* 账号不存在与密码错误给同一个提示，避免被用来探测账号是否存在 */
      if (!a) {
        noteFail();
        return failResult('账号或密码不正确');
      }
      if (!a.active) return { ok: false, error: '该账号已停用，请联系站长' };
      if (hashPassword(input.password || '', a.salt) !== a.hash) {
        noteFail();
        return failResult('账号或密码不正确');
      }
      clearLock();
      a.lastLoginAt = isoNow();
      save();
      writeSession(a.id, !!input.remember);
      return { ok: true, account: publicAccount(a) };
    }
    /* 失败时把「还剩几次会锁」一起带回去，让用户知道后果 */
    function failResult(base) {
      var l = readLock();
      var left = MAX_TRIES - (l.fails || 0);
      if (left > 0 && left <= 2) return { ok: false, error: base + '（再错 ' + left + ' 次将锁定）', left: left };
      return { ok: false, error: base, left: left };
    }
    function readLock() {
      var r = readJSON(st, LOCK_KEY) || {};
      return { fails: Math.max(0, Number(r.fails) || 0), until: Number(r.until) || 0 };
    }
    function writeLock(v) {
      try { st.setItem(LOCK_KEY, JSON.stringify(v)); } catch (e) { /* 隐私模式写不进去就不限速，不阻断登录 */ }
    }
    function lockRemain() {
      var l = readLock();
      if (!l.until || l.until <= Date.now()) return 0;
      return Math.ceil((l.until - Date.now()) / 1000);
    }
    function noteFail() {
      var l = readLock();
      l.fails = (l.fails || 0) + 1;
      if (l.fails >= MAX_TRIES) {
        var ms = Math.min(BASE_LOCK_MS * Math.pow(2, l.fails - MAX_TRIES), MAX_LOCK_MS);
        l.until = Date.now() + ms;
      }
      writeLock(l);
      return l.fails;
    }
    function clearLock() {
      try { st.removeItem(LOCK_KEY); } catch (e) { /* 忽略 */ }
    }
    function logout() {
      ses.removeItem(SESSION_KEY);
      st.removeItem(REMEMBER_KEY);
      return { ok: true };
    }

    function list() {
      return db.accounts.map(publicAccount);
    }
    function createSub(input) {
      var gate = requireOwner();
      if (!gate.ok) return gate;
      input = input || {};
      var username = str(input.username).toLowerCase();
      if (!/^[a-z0-9_.-]{2,32}$/.test(username)) {
        return { ok: false, error: '登录账号需 2–32 位，只能用字母、数字、_ . -' };
      }
      if (findByUsername(username)) return { ok: false, error: '登录账号 ' + username + ' 已存在' };
      var vp = validPassword(input.password);
      if (!vp.ok) return vp;
      var role = ROLE_NAMES[input.role] && input.role !== 'owner' ? input.role : 'operator';
      var c = current();
      var a = makeAccount({ username: username, name: input.name, password: input.password }, role, c.name);
      db.accounts.push(a);
      save();
      return { ok: true, account: publicAccount(a) };
    }
    function updateSub(id, patch) {
      var gate = requireOwner();
      if (!gate.ok) return gate;
      var a = findById(id);
      if (!a) return { ok: false, error: '账号不存在' };
      var me = current();
      patch = patch || {};
      if (patch.name !== undefined) a.name = str(patch.name) || a.username;
      if (patch.role !== undefined) {
        if (a.id === me.id) return { ok: false, error: '不能修改自己的角色' };
        if (!ROLE_NAMES[patch.role] || patch.role === 'owner') return { ok: false, error: '子账号角色只能是操作员或只读访客' };
        a.role = patch.role;
      }
      if (patch.active !== undefined) {
        if (a.id === me.id) return { ok: false, error: '不能停用自己' };
        a.active = !!patch.active;
      }
      if (patch.password !== undefined && patch.password !== '') {
        var vp = validPassword(patch.password);
        if (!vp.ok) return vp;
        a.salt = randomHex(16);
        a.hash = hashPassword(patch.password, a.salt);
      }
      save();
      return { ok: true, account: publicAccount(a) };
    }
    function removeSub(id) {
      var gate = requireOwner();
      if (!gate.ok) return gate;
      var a = findById(id);
      if (!a) return { ok: false, error: '账号不存在' };
      if (a.id === current().id) return { ok: false, error: '不能删除自己' };
      if (a.role === 'owner' && db.accounts.filter(function (x) { return x.role === 'owner' && x.active; }).length <= 1) {
        return { ok: false, error: '至少保留一个站长账号' };
      }
      db.accounts = db.accounts.filter(function (x) { return x.id !== id; });
      save();
      return { ok: true, count: 1 };
    }
    /* 自己改密码必须验证旧密码；站长重置子账号密码走 updateSub */
    function changePassword(oldPassword, newPassword, confirm) {
      var c = current();
      if (!c) return { ok: false, error: '请先登录' };
      var a = findById(c.id);
      if (hashPassword(oldPassword || '', a.salt) !== a.hash) return { ok: false, error: '原密码不正确' };
      var vp = validPassword(newPassword);
      if (!vp.ok) return vp;
      if (String(newPassword) !== String(confirm)) return { ok: false, error: '两次输入的新密码不一致' };
      a.salt = randomHex(16);
      a.hash = hashPassword(newPassword, a.salt);
      save();
      return { ok: true };
    }

    /* 账号库随台账备份 / GitHub 同步一起走，实现「多设备共用同一套账号」 */
    function snapshot() { return JSON.parse(JSON.stringify(db)); }
    function restore(payload) {
      var incoming = payload && payload.accounts !== undefined ? payload : null;
      if (!incoming) return { ok: false, error: '备份里没有账号数据' };
      var next = normalizeDB(incoming);
      if (!next.accounts.length) return { ok: false, error: '备份里的账号数据为空' };
      db = next;
      save();
      /* 本机会话若指向已被替换掉的账号，强制重新登录 */
      if (!findById(sessionUserId())) logout();
      return { ok: true, count: db.accounts.length };
    }
    function exportAccounts() {
      return JSON.stringify({ app: 'express-station-accounts', version: 1, exportedAt: isoNow(), data: snapshot() }, null, 2);
    }
    function importAccounts(text) {
      var parsed;
      try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: '文件不是有效的 JSON' }; }
      return restore(parsed && parsed.data ? parsed.data : parsed);
    }

    return {
      KEY: KEY, status: status, current: current, actor: actor, can: can,
      register: register, login: login, logout: logout,
      lockRemain: lockRemain, clearLock: clearLock, MAX_TRIES: MAX_TRIES,
      list: list, createSub: createSub, updateSub: updateSub, removeSub: removeSub,
      changePassword: changePassword,
      snapshot: snapshot, restore: restore,
      exportAccounts: exportAccounts, importAccounts: importAccounts,
      roleName: function (r) { return ROLE_NAMES[r] || r; }
    };
  }

  var defaultAuth = createAuth();
  var api = {
    createAuth: createAuth,
    memoryStorage: memoryStorage,
    ROLE_NAMES: ROLE_NAMES,
    PERMS: PERMS,
    sha256Hex: sha256Hex,
    hashPassword: hashPassword
  };
  Object.keys(defaultAuth).forEach(function (k) {
    if (api[k] === undefined) api[k] = defaultAuth[k];
  });
  global.StationAuth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
