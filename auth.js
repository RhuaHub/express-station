/* 驿站助手（重建版）· 账号、角色与权限
   不开放注册：站长首次在本机初始化，子账号只能由站长在后台添加。
   密码用 SHA-256 + 每账号随机盐 + 多轮迭代后存本机，不存明文。 */
(function (global) {
  'use strict';

  /* ---------- 同步 SHA-256（不依赖 Web Crypto，Node / 老 WebView 行为一致） ---------- */
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
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  function sha256Hex(msg) {
    var bytes = [], s = unescape(encodeURIComponent(String(msg)));
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    var bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    var hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    for (var off = 0; off < bytes.length; off += 64) {
      var W = [];
      for (var t = 0; t < 16; t++) {
        W[t] = ((bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) |
          (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3]) >>> 0;
      }
      for (t = 16; t < 64; t++) {
        var s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
        var s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
        W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[t] + W[t]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var mj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + mj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H = [(H[0] + a) >>> 0, (H[1] + b) >>> 0, (H[2] + c) >>> 0, (H[3] + d) >>> 0,
        (H[4] + e) >>> 0, (H[5] + f) >>> 0, (H[6] + g) >>> 0, (H[7] + h) >>> 0];
    }
    return H.map(function (x) { return ('00000000' + x.toString(16)).slice(-8); }).join('');
  }

  var PERMS = ['inbound', 'outbound', 'query', 'inventory', 'customers', 'collections',
    'stats', 'print', 'sync', 'logs', 'settings', 'accounts'];
  var OPERATOR_DEFAULT = ['inbound', 'outbound', 'query', 'inventory', 'customers', 'collections',
    'stats', 'print', 'sync', 'logs'];
  var VIEWER_DEFAULT = ['query', 'inventory', 'stats', 'print', 'logs'];

  function create(store) {
    var sess = global.StationDB.pickStorage('session');
    var SESS = 'station.rebuild.session';
    var FAIL = 'station.rebuild.fail';
    var memSession = null;
    var locked = false;

    function accounts() { return store.getAccounts() || []; }
    function persist(arr) { store.setAccounts(arr); }
    function salt() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
    function hash(pw, s, rounds) {
      var v = String(pw) + '|' + s;
      for (var i = 0; i < (rounds || 1200); i++) v = sha256Hex(v + s + i);
      return sha256Hex(v);
    }
    function safeSet(k, v) { try { sess.setItem(k, v); } catch (e) { /* 内存会话兜底 */ } }
    function safeGet(k) { try { return sess.getItem(k); } catch (e) { return null; } }
    function safeDel(k) { try { sess.removeItem(k); } catch (e) { } }

    function current() {
      if (locked) return null;
      var raw = memSession || safeGet(SESS);
      if (!raw) return null;
      try {
        var o = JSON.parse(raw);
        return accounts().filter(function (x) { return x.id === o.id && x.name === o.name; })[0] || null;
      } catch (e) { return null; }
    }
    function writeSession(a) {
      var o = { id: a.id, name: a.name, at: Date.now() };
      memSession = JSON.stringify(o);
      safeSet(SESS, JSON.stringify(o));
    }
    function clearSession() { memSession = null; safeDel(SESS); }

    function status() {
      var a = current();
      return {
        needSetup: accounts().length === 0, logged: !!a, user: a ? a.name : '', role: a ? a.role : '',
        perms: a ? (a.perms || []) : [], storageOk: store.storageOk(),
        locked: locked, accountCount: accounts().length
      };
    }
    function failState() {
      var o = {};
      try { o = JSON.parse(safeGet(FAIL) || '{}'); } catch (e) { }
      return { count: o.count || 0, remain: Math.max(0, Math.ceil(((o.until || 0) - Date.now()) / 1000)) };
    }
    function clearLock() { safeDel(FAIL); locked = false; }

    function login(name, pw) {
      var f = failState();
      if (f.remain > 0) return { ok: false, error: '尝试过多，请 ' + f.remain + ' 秒后再试' };
      var a = accounts().filter(function (x) { return x.name === String(name).trim(); })[0];
      if (!a) return bump('账号不存在');
      if (hash(pw, a.salt, a.rounds) !== a.hash) return bump('密码不正确');
      clearLock(); locked = false;
      writeSession(a);
      store.setActor(a.name);
      store.log('login', a.name + ' 登录');
      return { ok: true, account: a };
    }
    function bump(msg) {
      var f = failState();
      var n = (f.count || 0) + 1;
      var wait = n >= 5 ? Math.min(300, 30 * Math.pow(2, Math.min(n - 5, 3))) : 0;
      safeSet(FAIL, JSON.stringify({ count: n, until: wait ? Date.now() + wait * 1000 : 0 }));
      return { ok: false, error: msg + (wait ? '，已锁定 ' + wait + ' 秒' : '（' + n + '/5）') };
    }
    function logout() {
      var a = current();
      if (a) store.log('logout', a.name + ' 退出');
      clearSession(); store.setActor('未登录');
      return { ok: true };
    }
    function lock() { locked = true; clearSession(); store.setActor('未登录'); }
    function unlock(pw) {
      var a = accounts().filter(function (x) { return x.role === 'owner'; })[0] || accounts()[0];
      if (a && hash(pw, a.salt, a.rounds) === a.hash) { locked = false; writeSession(a); return { ok: true }; }
      return { ok: false, error: '密码不正确' };
    }

    function setup(input) {
      input = input || {};
      if (accounts().length) return { ok: false, error: '本站已有账号，不能重复初始化' };
      var name = String(input.name || '').trim();
      var pw = String(input.password || '');
      if (name.length < 2) return { ok: false, error: '账号至少 2 个字符' };
      if (pw.length < 6) return { ok: false, error: '密码至少 6 位' };
      var s = salt(), rounds = 1200;
      var a = { id: 'u-' + Date.now().toString(36), name: name, role: 'owner',
        perms: PERMS.slice(), salt: s, rounds: rounds, hash: hash(pw, s, rounds),
        createdAt: new Date().toISOString() };
      persist([a]);
      store.setActor(name);
      store.log('setup', '初始化本站，创建站长账号 ' + name);
      writeSession(a);
      locked = false;
      return { ok: true, account: a };
    }

    function listAccounts() {
      return accounts().map(function (a) {
        return { id: a.id, name: a.name, role: a.role, perms: (a.perms || []).slice(), createdAt: a.createdAt };
      });
    }
    function addAccount(input) {
      if (!can('accounts')) return { ok: false, error: '只有站长能添加子账号' };
      input = input || {};
      var name = String(input.name || '').trim();
      var pw = String(input.password || '');
      if (name.length < 2) return { ok: false, error: '账号至少 2 个字符' };
      if (pw.length < 6) return { ok: false, error: '密码至少 6 位' };
      var arr = accounts();
      if (arr.some(function (a) { return a.name === name; })) return { ok: false, error: '账号已存在' };
      var role = ['operator', 'viewer'].indexOf(input.role) >= 0 ? input.role : 'operator';
      var s = salt(), rounds = 1200;
      var a = { id: 'u-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        name: name, role: role,
        perms: Array.isArray(input.perms) ? input.perms.filter(function (p) { return PERMS.indexOf(p) >= 0; })
          : (role === 'operator' ? OPERATOR_DEFAULT.slice() : VIEWER_DEFAULT.slice()),
        salt: s, rounds: rounds, hash: hash(pw, s, rounds), createdAt: new Date().toISOString() };
      arr.push(a); persist(arr);
      store.log('account', '创建子账号 ' + name + '（' + role + '）', a.id);
      return { ok: true, account: a };
    }
    function updateAccount(id, patch) {
      if (!can('accounts')) return { ok: false, error: '只有站长能修改子账号' };
      var arr = accounts();
      var a = arr.filter(function (x) { return x.id === id; })[0];
      if (!a) return { ok: false, error: '账号不存在' };
      if (a.role === 'owner' && patch.role && patch.role !== 'owner') return { ok: false, error: '不能降级站长' };
      if (patch.role && ['operator', 'viewer'].indexOf(patch.role) >= 0) a.role = patch.role;
      if (Array.isArray(patch.perms)) a.perms = patch.perms.filter(function (p) { return PERMS.indexOf(p) >= 0; });
      if (patch.password) {
        if (String(patch.password).length < 6) return { ok: false, error: '密码至少 6 位' };
        a.salt = salt(); a.rounds = 1200; a.hash = hash(patch.password, a.salt, a.rounds);
      }
      persist(arr);
      store.log('account', '修改子账号 ' + a.name, id);
      return { ok: true, account: a };
    }
    function removeAccount(id) {
      if (!can('accounts')) return { ok: false, error: '只有站长能删除子账号' };
      var arr = accounts();
      var a = arr.filter(function (x) { return x.id === id; })[0];
      if (!a) return { ok: false, error: '账号不存在' };
      if (a.role === 'owner') return { ok: false, error: '不能删除站长' };
      persist(arr.filter(function (x) { return x.id !== id; }));
      store.log('account', '删除子账号 ' + a.name, id);
      return { ok: true };
    }
    function can(perm) {
      var a = current();
      if (!a) return false;
      if (a.role === 'owner') return true;
      return (a.perms || []).indexOf(perm) >= 0;
    }
    function diag() {
      return {
        accounts: accounts().length, logged: status().logged, user: status().user,
        role: status().role, storageOk: store.storageOk(), sessionMemory: !!sess._memory,
        locked: locked, fail: failState(), build: '2.0.2'
      };
    }

    return {
      PERMS: PERMS.slice(), OPERATOR_DEFAULT: OPERATOR_DEFAULT.slice(), VIEWER_DEFAULT: VIEWER_DEFAULT.slice(),
      sha256Hex: sha256Hex, status: status, setup: setup, login: login, logout: logout,
      lock: lock, unlock: unlock, lockRemain: function () { return failState().remain; }, clearLock: clearLock,
      listAccounts: listAccounts, addAccount: addAccount, updateAccount: updateAccount,
      removeAccount: removeAccount, can: can, diag: diag, current: current
    };
  }

  var out = { create: create, sha256Hex: sha256Hex, PERMS: PERMS,
    OPERATOR_DEFAULT: OPERATOR_DEFAULT, VIEWER_DEFAULT: VIEWER_DEFAULT };
  if (typeof module !== 'undefined' && module.exports) { module.exports = out; global.StationAuth = out; }
  else global.StationAuth = out;
})(typeof window !== 'undefined' ? window : globalThis);
