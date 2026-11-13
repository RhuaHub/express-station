/* 可选：把台账同步到 GitHub 仓库里的一个 JSON 文件。token 仅保存在当前浏览器。 */
(function (global) {
  'use strict';

  var CFG_KEY = 'express-station.sync.v1';
  var API = 'https://api.github.com';

  function defaults() {
    return { token: '', repo: '', branch: 'main', path: 'data/station-db.json', auto: false, lastAt: '', lastError: '' };
  }
  function storage() {
    if (typeof localStorage !== 'undefined') return localStorage;
    var m = {};
    return { getItem: function (k) { return m[k] || null; }, setItem: function (k, v) { m[k] = v; }, removeItem: function (k) { delete m[k]; } };
  }
  function config() {
    var c = defaults();
    try {
      var raw = storage().getItem(CFG_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        Object.keys(c).forEach(function (k) { if (p[k] !== undefined) c[k] = p[k]; });
      }
    } catch (e) { /* 忽略损坏的配置 */ }
    return c;
  }
  function saveConfig(patch) {
    var c = Object.assign(config(), patch || {});
    c.repo = String(c.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '');
    c.branch = String(c.branch || 'main').trim() || 'main';
    c.path = String(c.path || 'data/station-db.json').trim().replace(/^\//, '') || 'data/station-db.json';
    storage().setItem(CFG_KEY, JSON.stringify(c));
    return c;
  }
  function clearConfig() { storage().removeItem(CFG_KEY); }
  function isConfigured() {
    var c = config();
    return !!(c.token && /^[^/\s]+\/[^/\s]+$/.test(c.repo));
  }
  function state() {
    var c = config();
    if (!isConfigured()) return '未配置';
    if (c.lastError) return '上次失败：' + c.lastError;
    if (c.lastAt) return '上次同步：' + c.lastAt + (c.auto ? ' · 自动同步已开' : '');
    return '已配置 · ' + c.repo + (c.auto ? ' · 自动同步已开' : '');
  }

  function toBase64(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function fromBase64(b64) {
    var bin = atob(String(b64).replace(/\s/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function headers(c) {
    return {
      'Authorization': 'Bearer ' + c.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json'
    };
  }
  function explain(res, body) {
    if (res.status === 401) return 'token 无效或已过期（401）';
    if (res.status === 403) return '没有权限或触发限流（403），请检查 token 的 Contents 读写权限';
    if (res.status === 404) return '仓库、分支或文件不存在（404），也可能是 token 无权访问该私有仓库';
    if (res.status === 409) return '远端有冲突（409），请先拉取再上传';
    var msg = body && body.message ? body.message : 'HTTP ' + res.status;
    return 'GitHub 返回：' + msg;
  }
  async function request(url, options) {
    var res = await fetch(url, options);
    var text = await res.text();
    var body = null;
    try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
    if (!res.ok && !(options && options.allow404 && res.status === 404)) {
      return { ok: false, error: explain(res, body), status: res.status };
    }
    return { ok: true, body: body, status: res.status };
  }
  function fileUrl(c, withRef) {
    var path = c.path.split('/').map(encodeURIComponent).join('/');
    var url = API + '/repos/' + c.repo + '/contents/' + path;
    if (withRef) url += '?ref=' + encodeURIComponent(c.branch) + '&t=' + Date.now();
    return url;
  }
  function mark(ok, text) {
    var now = new Date();
    var stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') +
      ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    saveConfig(ok ? { lastAt: stamp, lastError: '' } : { lastError: text });
  }

  async function test() {
    if (!isConfigured()) return { ok: false, error: '请先填写 token 和仓库（owner/repo）' };
    var c = config();
    var r = await request(API + '/repos/' + c.repo, { headers: headers(c) });
    if (!r.ok) { mark(false, r.error); return r; }
    var branch = await request(API + '/repos/' + c.repo + '/branches/' + encodeURIComponent(c.branch), { headers: headers(c) });
    if (!branch.ok) { mark(false, '分支不可用：' + branch.error); return { ok: false, error: '分支不可用：' + branch.error }; }
    mark(true, '');
    return { ok: true, message: '连接正常：' + c.repo + ' @ ' + c.branch };
  }

  async function pull() {
    if (!isConfigured()) return { ok: false, error: '请先配置 GitHub 同步' };
    var c = config();
    var r = await request(fileUrl(c, true), { headers: headers(c) });
    if (!r.ok) { mark(false, r.error); return r; }
    if (!r.body || !r.body.content) return { ok: false, error: '远端文件内容为空' };
    var text;
    try { text = fromBase64(r.body.content); } catch (e) { return { ok: false, error: '远端文件无法解码' }; }
    mark(true, '');
    return { ok: true, text: text, sha: r.body.sha, message: '已拉取远端台账' };
  }

  async function push(contentText) {
    if (!isConfigured()) return { ok: false, error: '请先配置 GitHub 同步' };
    var c = config();
    var existing = await request(fileUrl(c, true), { headers: headers(c), allow404: true });
    if (!existing.ok && existing.status !== 404) { mark(false, existing.error); return existing; }
    var payload = {
      message: 'chore(station): 更新快递驿站台账 ' + new Date().toISOString().slice(0, 19).replace('T', ' '),
      content: toBase64(contentText),
      branch: c.branch
    };
    if (existing.ok && existing.body && existing.body.sha) payload.sha = existing.body.sha;
    var r = await request(fileUrl(c, false), { method: 'PUT', headers: headers(c), body: JSON.stringify(payload) });
    if (!r.ok) { mark(false, r.error); return r; }
    mark(true, '');
    return { ok: true, message: '已上传到 ' + c.repo + '/' + c.path };
  }

  var api = {
    config: config, saveConfig: saveConfig, clearConfig: clearConfig,
    isConfigured: isConfigured, state: state,
    test: test, pull: pull, push: push
  };
  global.StationSync = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
