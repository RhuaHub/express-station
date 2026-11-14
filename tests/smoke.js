/* 冒烟测试：node tests/smoke.js —— 不依赖浏览器，验证数据层与页面引用完整性。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const api = require('../store.js');

const root = path.join(__dirname, '..');
let passed = 0;
const asyncChecks = [];
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}
function checkAsync(name, fn) { asyncChecks.push({ name: name, fn: fn }); }

console.log('数据层');
const storage = api.memoryStorage();
let store = api.createStore(storage);

check('空库启动、默认设置可用', () => {
  assert.strictEqual(store.listParcels({ status: 'in' }).length, 0);
  assert.ok(store.settings().carriers.length > 0);
  assert.strictEqual(store.stats().last7.length, 7);
});

let p1, p2, p3;
check('入库自动分配货架位、手机号只留后四位', () => {
  p1 = store.addParcel({ trackingNo: 'YT100001', carrier: '圆通', recipient: '张三', phoneTail: '13800123456', zone: 'A' }).parcel;
  assert.strictEqual(p1.slot, 'A-01-1');
  assert.strictEqual(p1.phoneTail, '3456');
  p2 = store.addParcel({ trackingNo: 'YT100002', zone: 'A' }).parcel;
  assert.strictEqual(p2.slot, 'A-01-2');
  p3 = store.addParcel({ trackingNo: 'YT100003', zone: 'B' }).parcel;
  assert.strictEqual(p3.slot, 'B-01-1');
});

check('在库单号重复与货位占用被拒绝', () => {
  assert.strictEqual(store.addParcel({ trackingNo: 'YT100001' }).ok, false);
  assert.strictEqual(store.addParcel({ trackingNo: 'YT100004', slot: 'A-01-1' }).ok, false);
});

check('批量出库、统计回读、撤销出库', () => {
  const r = store.checkout([p1.id, p2.id], '代取');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(store.stats().todayOut, 2);
  assert.strictEqual(store.listParcels({ status: 'in' }).length, 1);
  assert.strictEqual(store.getDB().parcels.find(x => x.id === p1.id).pickupBy, '代取');
  const back = store.restoreParcel(p1.id);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(store.listParcels({ status: 'in' }).length, 2);
});

check('修改资料、删除记录并写入流水', () => {
  const u = store.updateParcel(p3.id, { slot: 'B-02-1', recipient: '王五' });
  assert.strictEqual(u.ok, true);
  assert.strictEqual(u.parcel.slot, 'B-02-1');
  const before = store.getDB().logs.length;
  assert.strictEqual(store.removeParcel(p3.id).ok, true);
  assert.ok(store.getDB().logs.length > before);
  assert.ok(store.listLogs({ type: 'delete' }).length > 0);
});

check('写入后重新打开仍可读回（持久化）', () => {
  const reopened = api.createStore(storage);
  assert.strictEqual(reopened.getDB().parcels.length, 2);
  assert.strictEqual(reopened.listParcels({ status: 'in' }).length, 1);
});

check('JSON 备份导出后覆盖导入一致', () => {
  const text = store.exportJSON();
  assert.ok(text.includes('YT100001'));
  const fresh = api.createStore(api.memoryStorage());
  const r = fresh.importJSON(text, 'replace');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(fresh.getDB().parcels.length, store.getDB().parcels.length);
  assert.strictEqual(fresh.settings().stationName, store.settings().stationName);
  const bad = fresh.importJSON('{oops', 'merge');
  assert.strictEqual(bad.ok, false);
});

check('CSV 导出含 BOM 与表头', () => {
  const csv = store.exportCSV('all');
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('运单号'));
  assert.ok(store.exportCSV('logs').includes('操作类型') === false); // 流水表头不同
  assert.ok(store.exportCSV('logs').includes('摘要'));
});

check('设置更新与演示数据', () => {
  const r = store.updateSettings({ warnDays: 2, dangerDays: 5, carriers: ['中通', '顺丰'], zones: ['A', 'B'] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(store.settings().warnDays, 2);
  const seed = store.seedDemo();
  assert.strictEqual(seed.ok, true);
  assert.strictEqual(seed.count, 18);
  const st = store.stats();
  assert.strictEqual(st.last7.length, 7);
  assert.ok(st.byCarrier.length > 0);
  assert.ok(st.todayIn > 0);
});

check('清空数据后回到初始状态', () => {
  store.clearAll();
  assert.strictEqual(store.getDB().parcels.length, 0);
  assert.strictEqual(store.stats().inStock, 0);
});

console.log('照片元数据');
check('入库照片引用随包裹保存', () => {
  const s = api.createStore(api.memoryStorage());
  const r = s.addParcel({
    trackingNo: 'PHOTO001', zone: 'A',
    photos: [{ ref: 'webdav:2026-11/a.jpg', name: 'a.jpg', mode: 'webdav', kind: 'inbound', size: 12345 }]
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.parcel.photos.length, 1);
  assert.strictEqual(r.parcel.photos[0].ref, 'webdav:2026-11/a.jpg');
  assert.ok(s.listLogs({ type: 'in' })[0].summary.includes('照片'));
});

check('出库凭证照片可挂载、可移除引用', () => {
  const s = api.createStore(api.memoryStorage());
  const p = s.addParcel({ trackingNo: 'PHOTO002' }).parcel;
  const r = s.checkout([p.id], '本人', [{ ref: 'local:2026-11/b.jpg', name: 'b.jpg', mode: 'local' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.parcels[0].photos.length, 1);
  assert.strictEqual(r.parcels[0].photos[0].kind, 'pickup');
  const add = s.attachPhoto(p.id, { ref: 'idb:2026-11/c.jpg', name: 'c.jpg' });
  assert.strictEqual(add.ok, true);
  assert.strictEqual(s.getDB().parcels[0].photos.length, 2);
  assert.strictEqual(s.detachPhoto(p.id, add.photos[0].id).ok, true);
  assert.strictEqual(s.getDB().parcels[0].photos.length, 1);
  assert.ok(s.listLogs({ type: 'photo' }).length >= 2);
});

check('备份导入保留照片引用、CSV 含照片数列', () => {
  const s = api.createStore(api.memoryStorage());
  s.addParcel({ trackingNo: 'PHOTO003', photos: [{ ref: 'webdav:2026-11/d.jpg', name: 'd.jpg' }] });
  const fresh = api.createStore(api.memoryStorage());
  fresh.importJSON(s.exportJSON(), 'replace');
  assert.strictEqual(fresh.getDB().parcels[0].photos.length, 1);
  assert.ok(fresh.exportCSV('all').includes('照片数'));
});

console.log('查件');
check('查件命中在库/已出库、精确尾号优先、范围过滤', () => {
  const s = api.createStore(api.memoryStorage());
  const a = s.addParcel({ trackingNo: 'YT900001', phoneTail: '13800001234', recipient: '赵六' }).parcel;
  const b = s.addParcel({ trackingNo: 'YT900002', phoneTail: '13900005678' }).parcel;
  assert.strictEqual(s.checkout([b.id], '代取').ok, true);
  assert.strictEqual(s.lookup('1234').length, 1);
  assert.strictEqual(s.lookup('1234')[0].id, a.id);
  const out = s.lookup('YT900002');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].status, 'out');
  assert.strictEqual(out[0].pickupBy, '代取');
  assert.strictEqual(s.lookup('YT900002', 'in').length, 0);
  assert.strictEqual(s.lookup('YT900002', 'out').length, 1);
  assert.strictEqual(s.lookup('90000').length, 2);
  assert.strictEqual(s.lookup('90000')[0].id, a.id, '在库件应排在已出库件之前');
  assert.deepStrictEqual(s.lookup(''), []);
});

console.log('取件码（货号）');
check('取件码默认由货架位压缩生成，且不与在库件重复', () => {
  const s = api.createStore(api.memoryStorage());
  const a = s.addParcel({ trackingNo: 'CODE001', zone: 'A' }).parcel;
  assert.strictEqual(a.slot, 'A-01-1');
  assert.strictEqual(a.pickupCode, 'A011');
  assert.strictEqual(s.compactSlot('A-01-1'), 'A011');
  assert.strictEqual(s.previewPickupCode('B-03-2'), 'B032');
  const b = s.addParcel({ trackingNo: 'CODE002', zone: 'A' }).parcel;
  assert.notStrictEqual(a.pickupCode, b.pickupCode);
  const dup = s.addParcel({ trackingNo: 'CODE003', pickupCode: 'A011' }).parcel;
  assert.strictEqual(dup.pickupCode, 'A013', '建议码被占用时应自动换成可用码');
});

check('手改取件码、重复码拒绝、换货位自动重算', () => {
  const s = api.createStore(api.memoryStorage());
  const a = s.addParcel({ trackingNo: 'CODE011', zone: 'A' }).parcel;
  const b = s.addParcel({ trackingNo: 'CODE012', zone: 'A' }).parcel;
  assert.strictEqual(s.updateParcel(a.id, { pickupCode: 'VIP1' }).parcel.pickupCode, 'VIP1');
  assert.strictEqual(s.updateParcel(b.id, { pickupCode: 'VIP1' }).ok, false);
  assert.strictEqual(s.updateParcel(b.id, { slot: 'C-02-2' }).parcel.pickupCode, 'C022');
  assert.strictEqual(s.updateParcel(a.id, { slot: 'C-03-3' }).parcel.pickupCode, 'VIP1', '手写码不应被换货位覆盖');
  assert.strictEqual(s.lookup('VIP1')[0].id, a.id);
});

check('每日流水号规则、关闭规则与旧备份回填', () => {
  const st = api.memoryStorage();
  const s = api.createStore(st);
  s.updateSettings({ codeMode: 'daily' });
  const a = s.addParcel({ trackingNo: 'DAILY01' }).parcel;
  const b = s.addParcel({ trackingNo: 'DAILY02' }).parcel;
  const d = new Date();
  const pre = ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
  assert.ok(a.pickupCode.indexOf(pre + '-') === 0, '每日码应带日期前缀：' + a.pickupCode);
  assert.notStrictEqual(a.pickupCode, b.pickupCode);
  s.updateSettings({ codeMode: 'off' });
  assert.strictEqual(s.addParcel({ trackingNo: 'DAILY03' }).parcel.pickupCode, '');
  assert.strictEqual(api.createStore(st).getDB().parcels.find(x => x.trackingNo === 'DAILY03').pickupCode, '');
  const legacy = api.createStore(api.memoryStorage());
  legacy.importJSON(JSON.stringify({
    parcels: [{ id: 'old1', trackingNo: 'OLD1', slot: 'C-03-4', status: 'in', inAt: new Date().toISOString() }]
  }), 'replace');
  assert.strictEqual(legacy.getDB().parcels[0].pickupCode, 'C034', '旧备份应按货架位回填');
  assert.strictEqual(legacy.getDB().parcels[0].batchId, '');
});

console.log('合并出库');
check('多件自动合并批次，凭证共享到每件，流水带批次号', () => {
  const s = api.createStore(api.memoryStorage());
  const a = s.addParcel({ trackingNo: 'BATCH01', zone: 'A' }).parcel;
  const b = s.addParcel({ trackingNo: 'BATCH02', zone: 'A' }).parcel;
  const c = s.addParcel({ trackingNo: 'BATCH03', zone: 'B' }).parcel;
  const r = s.checkout([a.id, b.id], '本人', [{ ref: 'webdav:出库凭证/2026-11/x.jpg', name: 'x.jpg' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.merged, true);
  assert.ok(/^B-\d{8}-\d{3}$/.test(r.batchId), '批次号格式：' + r.batchId);
  assert.strictEqual(a.batchId, r.batchId);
  assert.strictEqual(b.batchId, r.batchId);
  assert.strictEqual(c.batchId, '');
  assert.strictEqual(s.listBatch(r.batchId).length, 2);
  assert.strictEqual(a.photos.length, 1);
  assert.strictEqual(b.photos.length, 1, '同批第二件也应能翻到凭证');
  assert.strictEqual(a.photos[0].ref, b.photos[0].ref, '共享同一云盘文件引用，不重复上传');
  assert.notStrictEqual(a.photos[0].id, b.photos[0].id, '各件引用 id 应独立');
  assert.strictEqual(a.photos[0].kind, 'pickup');
  const lg = s.listLogs({ type: 'out' })[0];
  assert.strictEqual(lg.batchId, r.batchId);
  assert.ok(lg.summary.includes('合并出库'));
});

check('整批撤销一次恢复全部；货位被占用时整批拒绝', () => {
  const s = api.createStore(api.memoryStorage());
  const a = s.addParcel({ trackingNo: 'RB001', zone: 'A' }).parcel;
  const b = s.addParcel({ trackingNo: 'RB002', zone: 'A' }).parcel;
  const r = s.checkout([a.id, b.id], '代取', [{ ref: 'idb:x.jpg', name: 'x.jpg' }]);
  const blocker = s.addParcel({ trackingNo: 'RB003', slot: 'A-01-1' }).parcel;
  const refused = s.restoreBatch(r.batchId);
  assert.strictEqual(refused.ok, false);
  assert.ok(refused.error.includes('A-01-1'));
  assert.strictEqual(s.getDB().parcels.find(x => x.id === a.id).status, 'out', '拒绝时不能只撤一半');
  s.removeParcel(blocker.id);
  const back = s.restoreBatch(r.batchId);
  assert.strictEqual(back.ok, true);
  assert.strictEqual(back.count, 2);
  assert.strictEqual(s.listParcels({ status: 'in' }).length, 2);
  assert.strictEqual(s.getDB().parcels.find(x => x.id === a.id).batchId, '');
  assert.strictEqual(s.getDB().parcels.find(x => x.id === a.id).photos.length, 1, '撤销保留历史凭证');
  assert.strictEqual(s.restoreBatch(r.batchId).ok, false, '已撤销的批次不能重复撤销');
});

check('单件撤销会清掉批次标记且不误撤同批其它件', () => {
  const s = api.createStore(api.memoryStorage());
  const a = s.addParcel({ trackingNo: 'ONE001' }).parcel;
  const b = s.addParcel({ trackingNo: 'ONE002' }).parcel;
  const r = s.checkout([a.id, b.id], '本人');
  assert.strictEqual(s.restoreParcel(a.id).ok, true);
  assert.strictEqual(s.getDB().parcels.find(x => x.id === a.id).batchId, '');
  assert.strictEqual(s.getDB().parcels.find(x => x.id === b.id).status, 'out');
  assert.strictEqual(s.listBatch(r.batchId).length, 1);
});

check('查件可按取件码与批次号命中，备份/CSV 保留新字段', () => {
  const s = api.createStore(api.memoryStorage());
  const a = s.addParcel({ trackingNo: 'FIND01', zone: 'A' }).parcel;
  const b = s.addParcel({ trackingNo: 'FIND02', zone: 'A' }).parcel;
  const r = s.checkout([a.id, b.id], '本人');
  assert.strictEqual(s.lookup(a.pickupCode)[0].id, a.id);
  assert.strictEqual(s.lookup(r.batchId).length, 2, '批次号应能查到同批所有件');
  assert.ok(s.lookup(r.batchId)[0].batchId === r.batchId);
  const fresh = api.createStore(api.memoryStorage());
  fresh.importJSON(s.exportJSON(), 'replace');
  assert.strictEqual(fresh.getDB().parcels.find(x => x.id === a.id).pickupCode, a.pickupCode);
  assert.strictEqual(fresh.getDB().parcels.find(x => x.id === a.id).batchId, r.batchId);
  const csv = s.exportCSV('all');
  assert.ok(csv.includes('取件码'));
  assert.ok(csv.includes('出库批次'));
  assert.ok(csv.includes(a.pickupCode));
  assert.ok(s.exportCSV('logs').includes('出库批次'));
});

console.log('账号与权限');
const authApi = require('../auth.js');
const crypto = require('crypto');
const auth = authApi.createAuth(authApi.memoryStorage(), authApi.memoryStorage());

check('SHA-256 实现与标准一致（含中文与空串）', () => {
  ['abc', '中文密码123', '', 'a'.repeat(200)].forEach(function (s) {
    assert.strictEqual(authApi.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});
check('首次注册站长并自动登录', () => {
  assert.strictEqual(auth.status().needSetup, true);
  const r = auth.register({ name: '李站长', username: 'Boss', password: 'abc12345', confirm: 'abc12345' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.account.role, 'owner');
  assert.strictEqual(auth.current().username, 'boss');
  assert.strictEqual(auth.can('owner'), true);
});
check('密码只存加盐哈希，错误密码被拒', () => {
  const raw = JSON.stringify(auth.snapshot());
  assert.ok(!raw.includes('abc12345'), '账号库不得出现明文密码');
  assert.ok(raw.includes('hash') && raw.includes('salt'));
  assert.notStrictEqual(auth.snapshot().accounts[0].hash, authApi.sha256Hex('abc12345'));
  auth.logout();
  assert.strictEqual(auth.login({ username: 'boss', password: 'wrong' }).ok, false);
  assert.strictEqual(auth.login({ username: 'boss', password: 'abc12345' }).ok, true);
});
check('重复注册、账号格式与密码强度都被拒绝', () => {
  assert.strictEqual(auth.register({ username: 'x', password: '123456', confirm: '123456' }).ok, false);
  assert.strictEqual(auth.createSub({ username: 'Bad User', password: '123456' }).ok, false);
  assert.strictEqual(auth.createSub({ username: 'short', password: '123' }).ok, false);
});
check('关掉自助注册：只有零账号时能初始化，之后只能由站长添加', () => {
  const a = authApi.createAuth(authApi.memoryStorage(), authApi.memoryStorage());
  assert.strictEqual(a.status().needSetup, true);
  assert.strictEqual(a.status().canRegister, true);
  assert.strictEqual(a.register({ name: '站长', username: 'boss', password: 'abc12345', confirm: 'abc12345' }).ok, true);
  assert.strictEqual(a.status().needSetup, false);
  assert.strictEqual(a.status().canRegister, false);
  /* 外人拿到地址也无法自己开号 */
  const outsider = a.register({ name: '外人', username: 'intruder', password: 'abc12345', confirm: 'abc12345' });
  assert.strictEqual(outsider.ok, false);
  assert.ok(/已初始化/.test(outsider.error), '拒绝注册应说明站点已初始化');
  assert.strictEqual(a.list().length, 1, '被拒的注册不得留下账号');
  /* 站长后台添加仍然可用 */
  assert.strictEqual(a.createSub({ name: '小王', username: 'clerk', password: 'pass123', role: 'operator' }).ok, true);
  assert.strictEqual(a.list().length, 2);
});
check('连续输错密码锁定本设备，且不泄露账号是否存在', () => {
  const a = authApi.createAuth(authApi.memoryStorage(), authApi.memoryStorage());
  a.register({ name: '站长', username: 'boss', password: 'abc12345', confirm: 'abc12345' });
  a.logout();
  const wrong = a.login({ username: 'boss', password: 'wrong-pass' });
  const ghost = a.login({ username: 'ghost', password: 'wrong-pass' });
  assert.strictEqual(wrong.ok, false);
  assert.strictEqual(ghost.error, wrong.error, '账号不存在与密码错误必须给同一提示');
  for (let i = 0; i < 3; i++) a.login({ username: 'boss', password: 'wrong-pass' });
  assert.ok(a.lockRemain() > 0, '连续 5 次失败后应锁定');
  const locked = a.login({ username: 'boss', password: 'abc12345' });
  assert.strictEqual(locked.ok, false, '锁定期间正确密码也不放行');
  assert.ok(locked.lockSeconds > 0 && /秒后再试/.test(locked.error));
  /* 达到失败上限时状态里也要报出来，UI 才能提示 */
  assert.ok(a.status().lockSeconds > 0);
  a.clearLock();
  assert.strictEqual(a.login({ username: 'boss', password: 'abc12345' }).ok, true);
});
check('登录页默认不暴露注册入口，初始化改为显式触发', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const setupTag = (html.match(/<div id="authSetup"[^>]*>/) || [''])[0];
  const loginTag = (html.match(/<div id="authLogin"[^>]*>/) || [''])[0];
  assert.ok(/\bhidden\b/.test(setupTag), '初始化表单默认必须隐藏');
  assert.ok(!/\bhidden\b/.test(loginTag), '登录表单应默认可见');
  // 初始化入口从「隐藏手势」改成零账号时的可见按钮（?setup=1 仍可用）
  ['不开放自助注册', 'id="authBootHint"', 'id="btnGoSetup"', '按网址隔离']
    .forEach(k => assert.ok(html.includes(k), '登录页缺少 ' + k));
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/function wantSetup\(/.test(app), '缺少初始化入口判定');
  assert.ok(!/showGate\(auth\.status\(\)\.needSetup \?/.test(app), '不得再自动弹出注册表单');
  assert.ok(/IDLE_MS/.test(app) && /function idleTick\(/.test(app), '缺少闲置自动锁屏');
  assert.ok(/data-perm="owner"[^>]*id="formAddSub"|id="formAddSub"[^>]*data-perm="owner"/.test(html) ||
    /<form id="formAddSub"[^>]*data-perm="owner"/.test(html), '新增子账号必须只对站长开放');
});
check('创建子账号并检查角色权限矩阵', () => {
  assert.strictEqual(auth.createSub({ name: '小王', username: 'clerk', password: 'pass123', role: 'operator' }).ok, true);
  assert.strictEqual(auth.createSub({ name: '访客', username: 'guest', password: 'pass123', role: 'viewer' }).ok, true);
  assert.strictEqual(auth.list().length, 3);
  assert.strictEqual(auth.createSub({ username: 'clerk', password: 'pass123' }).ok, false);
});
check('切换账号后权限随角色变化，越权创建子账号被拒', () => {
  auth.logout();
  assert.strictEqual(auth.login({ username: 'clerk', password: 'pass123' }).ok, true);
  assert.strictEqual(auth.can('write'), true);
  assert.strictEqual(auth.can('manage'), false);
  assert.strictEqual(auth.createSub({ username: 'hack', password: 'pass123' }).ok, false);
  auth.logout();
  assert.strictEqual(auth.login({ username: 'guest', password: 'pass123' }).ok, true);
  assert.strictEqual(auth.can('read'), true);
  assert.strictEqual(auth.can('write'), false);
});
check('停用账号无法登录；不能停用或删除自己', () => {
  auth.logout();
  assert.strictEqual(auth.login({ username: 'boss', password: 'abc12345' }).ok, true);
  const clerk = auth.list().find(a => a.username === 'clerk');
  assert.strictEqual(auth.updateSub(clerk.id, { active: false }).ok, true);
  const me = auth.current();
  assert.strictEqual(auth.updateSub(me.id, { active: false }).ok, false);
  assert.strictEqual(auth.updateSub(me.id, { role: 'viewer' }).ok, false);
  assert.strictEqual(auth.removeSub(me.id).ok, false);
  auth.logout();
  assert.strictEqual(auth.login({ username: 'clerk', password: 'pass123' }).ok, false);
  assert.strictEqual(auth.login({ username: 'boss', password: 'abc12345' }).ok, true);
  assert.strictEqual(auth.updateSub(clerk.id, { password: 'newpass1', active: true, role: 'viewer' }).ok, true);
  assert.strictEqual(auth.removeSub(clerk.id).ok, true);
});
check('改自己密码需验证旧密码，账号库可导出导入', () => {
  assert.strictEqual(auth.changePassword('bad', 'zzz999', 'zzz999').ok, false);
  assert.strictEqual(auth.changePassword('abc12345', 'zzz999', 'zzz9999').ok, false);
  assert.strictEqual(auth.changePassword('abc12345', 'zzz999', 'zzz999').ok, true);
  const text = auth.exportAccounts();
  assert.ok(!text.includes('zzz999'), '导出文件不得含明文密码');
  const other = authApi.createAuth(authApi.memoryStorage(), authApi.memoryStorage());
  assert.strictEqual(other.importAccounts(text).ok, true);
  assert.strictEqual(other.login({ username: 'boss', password: 'zzz999' }).ok, true);
});
check('数据层记录操作人：包裹、流水、CSV 与检索', () => {
  const s2 = api.createStore(api.memoryStorage());
  s2.setActor('小王');
  const pp = s2.addParcel({ trackingNo: 'AUTH001', zone: 'A' }).parcel;
  assert.strictEqual(pp.operatorIn, '小王');
  s2.checkout([pp.id], '本人');
  assert.strictEqual(s2.getDB().parcels.find(x => x.id === pp.id).operatorOut, '小王');
  assert.strictEqual(s2.getDB().logs.find(l => l.type === 'out').actor, '小王');
  assert.ok(s2.exportCSV('logs').includes('操作人'));
  assert.ok(s2.listLogs({ keyword: '小王' }).length >= 2);
  assert.strictEqual(s2.logEvent('login', '小王 登录（操作员）'), true);
  assert.ok(s2.exportCSV('logs').includes('登录'));
});
check('账号库随 JSON 备份导出，导入时恢复', () => {
  const s3 = api.createStore(api.memoryStorage());
  s3.registerAccountsProvider(auth);
  const backup = s3.exportJSON();
  assert.strictEqual(JSON.parse(backup).accounts.accounts.length, 2);
  const s4 = api.createStore(api.memoryStorage());
  let restored = 0;
  s4.registerAccountsProvider({
    snapshot: function () { return auth.snapshot(); },
    restore: function (p) { restored = (p.accounts || []).length; return { ok: true }; }
  });
  assert.strictEqual(s4.importJSON(backup, 'replace').ok, true);
  assert.strictEqual(restored, 2);
});

console.log('页面引用');
check('页面含登录门、账号管理视图与权限标记', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['authGate', 'authSetup', 'authLogin', 'authStationName', 'formRegister', 'formLogin',
    'regUser', 'regPass', 'loginUser', 'loginPass', 'btnAuthImport', 'authImportFile',
    'view-accounts', 'formAddSub', 'formChangePwd', 'accountList', 'acCount',
    'btnAccountsExport', 'btnAccountsImport', 'btnLogout', 'userChip', 'auth.js']
    .forEach(k => assert.ok(html.includes(k), '页面缺少 ' + k));
  assert.ok(/<body class="auth-locked">/.test(html), '未登录时业务界面应默认隐藏');
  ['owner', 'write', 'manage'].forEach(p => assert.ok(html.includes('data-perm="' + p + '"'), '缺少权限标记 ' + p));
});
check('交互层有登录门禁、权限拦截与账号库绑定', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  ['StationAuth', 'registerAccountsProvider', 'bindAuth', 'bindAccounts', 'enterApp',
    'showGate', 'leaveApp', 'applyPermissions', 'store.setActor', 'data-perm', 'log-actor',
    "addEventListener('click', function (e) {", "addEventListener('submit', function (e) {"]
    .forEach(k => assert.ok(app.includes(k), '交互逻辑缺少 ' + k));
  ['body.auth-locked .app', '.auth-gate[hidden]', '.account-row', '.log-actor', '.user-chip']
    .forEach(k => assert.ok(css.includes(k), '样式缺少 ' + k));
});

check('登录不依赖 IndexedDB 初始化，照片模块有超时兜底', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const ph = fs.readFileSync(path.join(root, 'photos.js'), 'utf8');
  assert.ok(!/await photos\.init\(\)/.test(app), 'photos.init 不能阻塞登录门绑定');
  assert.ok(/photos\.init\(\)\.catch\(/.test(app), '照片初始化应放后台执行');
  assert.ok(/IndexedDB 打开超时/.test(ph), 'IndexedDB 需要超时兜底');
});

check('页面含查件视图、拍照按钮与摄像头容器', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['view-lookup', 'lookupKey', 'lookupResults', 'lookupScope', 'quickLookup',
    'btnInCamera', 'btnProof', 'btnProofPick', 'phRequireProof', 'cameraRoot', 'camera.js']
    .forEach(k => assert.ok(html.includes(k), '页面缺少 ' + k));
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/capture['"], ['"]environment['"]/.test(app), '缺少系统相机 capture 回退');
  assert.ok(/ensureProof/.test(app), '缺少出库强制拍照逻辑');
  assert.ok(/store\.lookup\(/.test(app), '查件页未接数据层');
});

check('页面含取件码、打印标签与合并出库入口', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  ['inPickupCode', 'btnRecode', 'setCodeMode', 'mergeHint', 'i-ticket', 'i-print', 'i-merge']
    .forEach(k => assert.ok(html.includes(k), '页面缺少 ' + k));
  ['printLabelDialog', 'printing-label', 'data-print-label', 'data-restore-batch',
    'store.restoreBatch(', 'store.previewPickupCode(', 'pickupCode: $(']
    .forEach(k => assert.ok(app.includes(k), '交互逻辑缺少 ' + k));
  assert.ok(css.includes('@media print'), '缺少打印样式');
  assert.ok(css.includes('.label-sheet'), '缺少标签样式');
});

check('camera.js 可加载且导出完整接口', () => {
  const c = require('../camera.js');
  ['supported', 'open'].forEach(k => assert.strictEqual(typeof c[k], 'function', '缺少接口 ' + k));
  assert.strictEqual(typeof c.lastError, 'string');
  assert.strictEqual(c.supported(), false, 'Node 环境应判定为不支持摄像头');
});
check('app.js 引用的 DOM id 都存在于页面或动态模板', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const collect = (text, re) => Array.from(text.matchAll(re), m => m[1]);
  const htmlIds = new Set(collect(html, /id="([^"]+)"/g));
  const dynamicIds = new Set(collect(app, /id="([^"]+)"/g));
  const used = new Set(collect(app, /\$\('([^']+)'\)/g));
  const missing = [...used].filter(id => !htmlIds.has(id) && !dynamicIds.has(id));
  assert.deepStrictEqual(missing, [], '缺失的 id: ' + missing.join(', '));
});

check('页面引用的本地脚本与样式都存在', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // 允许 ?v=1.0.5 这类版本号：用来绕开旧 Service Worker 的缓存
  const refs = Array.from(html.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css))(?:\?[^"]*)?"/g), m => m[1]);
  assert.ok(refs.length >= 4);
  refs.forEach(ref => assert.ok(fs.existsSync(path.join(root, ref)), '缺少文件 ' + ref));
});

check('photos.js 可加载且导出完整接口', () => {
  const p = require('../photos.js');
  ['config', 'saveConfig', 'init', 'pickDirectory', 'put', 'getUrl', 'test', 'status', 'buildRel'].forEach(function (k) {
    assert.strictEqual(typeof p[k], 'function', '缺少接口 ' + k);
  });
  assert.strictEqual(p.config().mode, 'github', '默认写入方式应为 GitHub 仓库（照片随项目走）');
  assert.strictEqual(p.config().github.dir, 'photos', 'GitHub 照片目录默认 photos/');
  assert.strictEqual(p.config().webdav.provider, 'nutstore', '云盘服务默认应为坚果云（免费版就含 WebDAV）');
  assert.strictEqual(p.config().requireProof, true, '出库凭证默认应为必拍');
  assert.strictEqual(p.saveConfig({ requireProof: false }).requireProof, false);
  p.saveConfig({ requireProof: true });
});

check('WebDAV CORS 代理 Worker：多上游路由且不含硬编码凭据', () => {
  const worker = fs.readFileSync(path.join(root, 'deploy', 'webdav-proxy.js'), 'utf8');
  ['export default', 'dav.jianguoyun.com/dav', 'webdav.123pan.cn/webdav', '/pan123', '/nutstore',
    'Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'MKCOL', 'PROPFIND', 'X-Proxy-Key',
    'UPSTREAM_PAN123', 'resolveUpstream']
    .forEach(k => assert.ok(worker.includes(k), 'Worker 缺少 ' + k));
  // 上游必须来自常量或环境变量，绝不能取自请求
  assert.ok(!/new URL\([^)]*\)\.(host|hostname|origin)/.test(worker), 'Worker 不应从请求里取上游地址');
  assert.ok(!/(?:password|token|secret)\s*=\s*['"][^'"]{8,}['"]/i.test(worker), 'Worker 里疑似写死凭据');
});

check('123 云盘：服务预设、地址与代理前缀解析正确', () => {
  const p = require('../photos.js');
  const list = p.providers().map(x => x.key);
  assert.deepStrictEqual(list.sort(), ['custom', 'nutstore', 'pan123'], '缺少云盘服务预设：' + list);
  const pan = p.providers().find(x => x.key === 'pan123');
  assert.strictEqual(pan.upstream, 'https://webdav.123pan.cn/webdav');
  assert.strictEqual(pan.proxyPath, '/pan123');
  assert.ok(/应用密码/.test(pan.hint), '123 云盘提示应说明用应用密码');

  // 直连：上游地址原样使用
  assert.strictEqual(p.endpoint({ provider: 'pan123', baseUrl: '', proxyBase: '' }), 'https://webdav.123pan.cn/webdav');
  // 经 Worker：Worker 根地址 + 服务前缀
  assert.strictEqual(p.endpoint({ provider: 'pan123', baseUrl: '', proxyBase: 'https://x.workers.dev/' }),
    'https://x.workers.dev/pan123');
  // 自定义上游 + 代理
  assert.strictEqual(p.endpoint({ provider: 'custom', baseUrl: 'https://dav.example.com/dav', proxyBase: 'https://w.dev' }),
    'https://w.dev/webdav');

  const saved = p.saveConfig({ webdav: { provider: 'pan123', proxyBase: 'https://x.workers.dev' } });
  assert.strictEqual(saved.webdav.provider, 'pan123');
  assert.strictEqual(saved.webdav.proxyBase, 'https://x.workers.dev');
  // 旧配置（只有 baseUrl）应按自定义处理，不能误判成 123 云盘
  p.saveConfig({ webdav: { provider: 'custom', baseUrl: 'https://dav.jianguoyun.com/dav', proxyBase: '' } });
  assert.strictEqual(p.config().webdav.provider, 'custom');
  // 连 provider 都没有的空配置，回退到坚果云
  assert.ok(/\? 'custom' : 'nutstore'/.test(fs.readFileSync(path.join(root, 'photos.js'), 'utf8')),
    '旧配置回退应为坚果云');
  p.saveConfig({ webdav: { provider: 'nutstore', baseUrl: '', proxyBase: '' } });
});

check('页面含云盘服务选择与 CORS 代理入口', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['phProvider', 'phProxyBase', 'phProxyKey', 'phUserLabel', 'phProviderHint', 'phProviderRoute',
    'webdav-proxy.js', '应用密码', '123 云盘'].forEach(k => assert.ok(html.includes(k), '页面缺少 ' + k));
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/function refreshProviderUI/.test(app), '缺少服务切换时的地址预填逻辑');
  assert.ok(/photos\.providers\(\)/.test(app), '页面未读取服务预设');
});

check('代理密钥配置可写入并回读', () => {
  const s = require('../photos.js');
  assert.strictEqual(s.config().webdav.proxyKey, '');
  assert.strictEqual(s.saveConfig({ webdav: { proxyKey: 'my-key' } }).webdav.proxyKey, 'my-key');
  s.saveConfig({ webdav: { proxyKey: '' } });
});

check('出库凭证独立目录、按年月分层、文件名带类型前缀', () => {
  const p = require('../photos.js');
  const out = p.buildRel('pickup');
  const inn = p.buildRel('inbound');
  const parts = out.split('/');
  assert.strictEqual(parts.length, 3, '应为 类型/年-月/文件 三层');
  assert.strictEqual(parts[0], '出库凭证');
  assert.ok(/^\d{4}-\d{2}$/.test(parts[1]), '第二层应为年-月');
  assert.ok(/^CK-\d{8}-\d{6}-[a-z0-9]{1,5}\.jpg$/.test(parts[2]), '出库文件名应有 CK- 前缀：' + parts[2]);
  assert.ok(inn.indexOf('入库照片/') === 0, '入库照片应独立目录');
  assert.ok(/\/RK-/.test(inn) || inn.includes('/RK-'), '入库文件名应有 RK- 前缀');
  assert.notStrictEqual(out, p.buildRel('pickup'), '连续出库不应产生同名文件');
});

check('上传时传入照片类型，且 WebDAV / 本地目录均逐层创建', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const ph = fs.readFileSync(path.join(root, 'photos.js'), 'utf8');
  assert.ok(/photos\.put\(files\[i\], kind/.test(app), '上传时未传入照片类型');
  assert.ok(/customName/.test(app) && /name: customName/.test(app), '拍照取件的自定义文件名没传给 photos.put');
  assert.ok(/parts\.slice\(0, i \+ 1\)/.test(ph), 'WebDAV 未逐层 MKCOL');
  assert.ok(/ensureDirs\(/.test(ph), '本地同步目录未逐级创建');
  assert.ok(/rel\.split\('\/\'\)\.pop\(\)/.test(ph), '文件名未取最后一段');
});

check('待提交文件里没有硬编码的云盘凭据', () => {
  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).reduce(function (acc, e) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (['.git', 'node_modules', 'data'].indexOf(e.name) >= 0) return acc;
        return acc.concat(walk(p));
      }
      return acc.concat([p]);
    }, []);
  }
  const secret = /(?:REFRESH_TOKEN|ALIYUN_TOKEN|WEBDAV_PASSWORD)\s*=\s*[0-9a-f]{32}\b/i;
  walk(root).filter(f => !/\.env$/.test(f)).forEach(function (f) {
    assert.ok(!secret.test(fs.readFileSync(f, 'utf8')), '疑似凭据泄漏：' + f);
  });
});

check('PWA：manifest 合法且图标文件齐备', () => {
  const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  assert.strictEqual(mf.start_url, './index.html');
  assert.strictEqual(mf.scope, './');
  assert.strictEqual(mf.display, 'standalone');
  assert.ok(/^#[0-9A-Fa-f]{6}$/.test(mf.theme_color), 'theme_color 应为 #RRGGBB');
  assert.ok(mf.name && mf.short_name, '缺少 name / short_name');
  const sizes = mf.icons.map(i => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), '缺少 192/512 图标');
  assert.ok(mf.icons.some(i => i.purpose === 'maskable'), '缺少 maskable 图标');
  mf.icons.forEach(function (ic) {
    const p = path.join(root, ic.src);
    assert.ok(fs.existsSync(p), '图标文件不存在：' + ic.src);
    const buf = fs.readFileSync(p);
    assert.ok(buf.slice(1, 4).toString() === 'PNG', '图标不是 PNG：' + ic.src);
    const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
    assert.strictEqual(w + 'x' + h, ic.sizes, '图标实际尺寸与声明不符：' + ic.src);
  });
});

check('PWA：Service Worker 只接管同源 GET，且缓存清单与真实文件一致', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(/req\.method !== 'GET'/.test(sw), '未排除非 GET 请求');
  assert.ok(/url\.origin !== self\.location\.origin/.test(sw), '未排除跨域请求，会破坏云盘上传');
  assert.ok(/caches\.open\(VERSION\)/.test(sw) && /caches\.delete/.test(sw), '缺少版本化缓存与旧缓存清理');
  // 清单里可能带 ?v=1.0.5 版本号（用来绕开旧缓存），比对文件时去掉查询串
  const listed = (sw.match(/'\.\/[^']+'/g) || [])
    .map(s => s.replace(/'|\.\//g, ''))
    .map(f => f.split('?')[0])
    .filter(Boolean);
  assert.ok(listed.length >= 10, '缓存清单过短：' + listed.length);
  listed.forEach(function (f) {
    if (f === '' || f === '') return;
    assert.ok(fs.existsSync(path.join(root, f)), 'SW 缓存了不存在的文件：' + f);
  });
});

check('深链：视图 hash 可直达且不越权', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/function hashView/.test(app), '缺少 hash 解析');
  assert.ok(/history\.replaceState/.test(app), '未同步 hash 到地址栏');
  assert.ok(/addEventListener\('hashchange'/.test(app), '未监听 hashchange');
  assert.ok(/if \(!auth\.current\(\)\) return;[\s\S]{0,120}hashchange/.test(app) || /hashchange[\s\S]{0,120}auth\.current\(\)/.test(app),
    'hashchange 未做登录判断');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(/rel="manifest" href="manifest\.webmanifest"/.test(html), '页面未引用 manifest');
  assert.ok(/serviceWorker\.register\('sw\.js'\)/.test(html), '未注册 Service Worker');
  assert.ok(/\^https\?:\$\/\.test\(location\.protocol\)/.test(html), 'file:// 下应跳过 SW 注册');
});

check('安卓壳：WebView 关键实现齐全（https 资源域、JS 对话框、文件选择）', () => {
  const java = fs.readFileSync(path.join(root, 'android/app/src/main/java/com/rhua/expressstation/MainActivity.java'), 'utf8');
  assert.ok(/appassets\.androidplatform\.net/.test(java), '未使用 https 资源域，摄像头与本地存储会被限制');
  assert.ok(/shouldInterceptRequest/.test(java), '缺少 assets 拦截');
  assert.ok(/onPermissionRequest[\s\S]{0,600}RESOURCE_VIDEO_CAPTURE/.test(java), '未处理摄像头权限');
  assert.ok(/onJsConfirm/.test(java) && /onJsAlert/.test(java), '未接管 JS 对话框，confirm 会静默失败');
  assert.ok(/getAcceptTypes/.test(java), '文件选择未按 accept 传类型，JSON 备份无法导入');
  assert.ok(/setDomStorageEnabled\(true\)/.test(java), '未开启 localStorage');
  const manifest = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(/android:exported="true"/.test(manifest), '缺少 exported 声明，Android 12+ 无法安装启动');
  assert.ok(/android\.permission\.CAMERA/.test(manifest), '缺少相机权限');
  assert.ok(/android:configChanges="[^"]*orientation/.test(manifest), '旋转会重建 Activity，可能丢表单');
});

check('安卓壳：APK 已构建且资源路径正确', () => {
  const distDir = path.join(root, 'android/dist');
  const apks = fs.existsSync(distDir) ? fs.readdirSync(distDir).filter(f => /^express-station-[\d.]+\.apk$/.test(f)) : [];
  assert.ok(apks.length, 'APK 不存在，先运行 android/build-apk.sh');
  const apkPath = path.join(distDir, apks.sort().pop());
  const buf = fs.readFileSync(apkPath);
  assert.ok(buf.length > 50000, 'APK 体积异常：' + buf.length);
  const text = buf.toString('latin1');
  ['AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'META-INF/', 'assets/index.html',
    'assets/app.js', 'assets/store.js', 'assets/auth.js', 'assets/photos.js', 'assets/camera.js',
    'assets/styles.css', 'assets/icons/icon-192.png'].forEach(function (needle) {
    assert.ok(text.indexOf(needle) >= 0, 'APK 内缺少 ' + needle);
  });
  assert.ok(text.indexOf('assets\\icons') < 0, 'assets 出现反斜杠路径，AssetManager 将读不到图标');
  const script = fs.readFileSync(path.join(root, 'android/build-apk.sh'), 'utf8');
  const listed = (script.match(/for f in (index\.html[^;]*); do/) || [])[1] || '';
  assert.ok(listed, '打包脚本缺少网页资源同步列表');
  listed.trim().split(/\s+/).forEach(function (f) {
    assert.ok(fs.existsSync(path.join(root, f)), '打包脚本同步了不存在的文件：' + f);
  });
  ['index.html', 'styles.css', 'app.js', 'store.js', 'auth.js', 'photos.js', 'camera.js', 'sync.js'].forEach(function (f) {
    assert.ok(listed.indexOf(f) >= 0, '打包脚本漏掉网页文件：' + f);
  });
});

check('GitHub 仓库直存：目标解析、路径拼接与公开仓库保护', () => {
  const p = require('../photos.js');
  const ph = fs.readFileSync(path.join(root, 'photos.js'), 'utf8');

  p.saveConfig({ github: { repo: '', branch: '', dir: 'photos', allowPublic: false } });
  let t = p.githubTarget();
  assert.strictEqual(t.dir, 'photos');
  assert.strictEqual(t.allowPublic, false, '公开仓库默认必须拦截');
  assert.strictEqual(p.githubPath('入库照片/2026-11/RK-1.jpg'), 'photos/入库照片/2026-11/RK-1.jpg');

  // 仓库/分支留空时跟随「GitHub 同步」
  const prev = global.StationSync;
  global.StationSync = { config: () => ({ token: 'ghp_dummy', repo: 'RhuaHub/express-station', branch: 'main' }) };
  t = p.githubTarget();
  assert.strictEqual(t.repo, 'RhuaHub/express-station', '仓库留空应跟随同步配置');
  assert.strictEqual(t.branch, 'main');
  assert.strictEqual(t.ready, true, '有 token + 仓库即为就绪');

  // 显式填写优先，并规整 URL / .git / 斜杠
  p.saveConfig({ github: { repo: 'https://github.com/foo/bar.git', branch: 'dev', dir: '/photos-archive/' } });
  t = p.githubTarget();
  assert.strictEqual(t.repo, 'foo/bar');
  assert.strictEqual(t.branch, 'dev');
  assert.strictEqual(t.dir, 'photos-archive', '目录要去掉首尾斜杠');
  if (prev === undefined) delete global.StationSync; else global.StationSync = prev;

  // 公开仓库要显式放行，且报错文案要点明隐私风险
  assert.ok(/该仓库是公开的/.test(ph), '缺少公开仓库拦截');
  assert.ok(/面单照片会对外可见|含手机号/.test(ph), '拦截文案应说明隐私风险');
  p.saveConfig({ github: { repo: '', branch: '', dir: 'photos', allowPublic: false, isPublic: null } });
});

check('设置页含 GitHub 直存入口与公开仓库闸门', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['id="phGithubBox"', 'id="ghRepo"', 'id="ghBranch"', 'id="ghDir"', 'id="ghAllowPublic"',
    'id="btnGhFromSync"', 'value="github"', 'photos/'].forEach(k => assert.ok(html.includes(k), '页面缺少 ' + k));
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/\$\('phGithubBox'\)\.hidden/.test(app), '未控制 GitHub 区块显隐');
  assert.ok(/\$\('btnGhFromSync'\)\.onclick/.test(app), '未绑定「用同步里的仓库」');
  assert.ok(/github:\s*\{/.test(app), '保存表单未带 github 配置');
});

check('123 云盘 WebDAV 权益变化有兜底出口', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['id="btnUseNutstore"', 'id="btnUseLocal"', 'id="btnUseBrowser"', '2026-11-04', 'WebDAV 授权管理']
    .forEach(k => assert.ok(html.includes(k), '设置页缺少 ' + k));
  const photos = fs.readFileSync(path.join(root, 'photos.js'), 'utf8');
  assert.ok(/2026-11-04/.test(photos), '云盘提示未说明 123 权益调整时间点');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  ['btnUseNutstore', 'btnUseLocal', 'btnUseBrowser'].forEach(id => {
    assert.ok(new RegExp("\\$\\('" + id + "'\\)\\.onclick").test(app), '未绑定 ' + id);
  });
  assert.ok(/\|\| 'nutstore'/.test(app), '设置页回填默认云盘服务应为坚果云');
});

checkAsync('GitHub 直存：测试连接能区分公开与私有仓库', async () => {
  const p = require('../photos.js');
  const realFetch = global.fetch;
  const stub = (isPrivate) => async (url) => {
    const u = String(url);
    if (u.indexOf('/branches/') > 0) return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ private: isPrivate }), { status: 200 });
  };
  const prevSync = global.StationSync;
  global.StationSync = { config: () => ({ token: 'stub-token-not-real', repo: 'me/pub', branch: 'main' }) };
  p.saveConfig({ mode: 'github', github: { repo: 'me/pub', branch: 'main', dir: 'photos', allowPublic: false, isPublic: null } });

  global.fetch = stub(false);
  let r = await p.test();
  assert.strictEqual(r.ok, false, '公开仓库必须被拒');
  assert.ok(/公开/.test(r.error), '提示应点明公开仓库：' + r.error);
  assert.strictEqual(p.config().github.isPublic, true, '应记住仓库可见性');
  assert.ok(/公开/.test(p.status()), '状态栏应标出公开仓库');

  p.saveConfig({ github: { allowPublic: true } });
  r = await p.test();
  assert.strictEqual(r.ok, true, '显式放行后应通过：' + r.error);

  p.saveConfig({ github: { allowPublic: false, isPublic: null } });
  global.fetch = stub(true);
  r = await p.test();
  assert.strictEqual(r.ok, true, '私有仓库应通过：' + r.error);
  assert.ok(/私有仓库/.test(r.message), '应回报私有仓库：' + r.message);

  global.fetch = realFetch;
  if (prevSync === undefined) delete global.StationSync; else global.StationSync = prevSync;
  p.saveConfig({ mode: 'github', github: { repo: '', branch: '', dir: 'photos', allowPublic: false, isPublic: null } });
});

check('照片读取：本机缓存开关与加速节点地址解析', () => {
  const p = require('../photos.js');
  p.saveConfig({ github: { proxyBase: '', proxyKey: '', cache: true } });
  assert.strictEqual(p.githubTarget().cache, true, '本机缓存应默认开启');
  assert.strictEqual(p.githubTarget().proxyBase, '', '默认不启用加速节点');

  // 直连形态
  const direct = p.photoUrl('me/repo', 'main', 'photos/入库照片/2026-11/RK-1.jpg');
  assert.ok(/^https:\/\/api\.github\.com\/repos\/me\/repo\/contents\/photos\/%E5%85%A5/.test(direct), '直连地址不对：' + direct);

  // 尾斜杠必须吃掉，否则会拼出 //photo
  p.saveConfig({ github: { proxyBase: 'https://gh.example.workers.dev/' } });
  assert.strictEqual(p.githubTarget().proxyBase, 'https://gh.example.workers.dev');

  // 代理形态：repo / branch / path 全部走 query 并编码，避免路径里的中文和斜杠被拆开
  assert.strictEqual(p.photoUrl('me/repo', 'main', 'photos/入库照片/2026-11/RK-1.jpg'),
    'https://gh.example.workers.dev/photo?repo=me%2Frepo&branch=main&path=photos%2F%E5%85%A5%E5%BA%93%E7%85%A7%E7%89%87%2F2026-11%2FRK-1.jpg');

  // 关缓存要能持久化，且不会把 cloud 配置带坏
  assert.strictEqual(p.saveConfig({ github: { cache: false } }).github.cache, false);
  assert.strictEqual(p.saveConfig({ github: { cache: true, proxyBase: '', proxyKey: '' } }).github.cache, true);
  assert.strictEqual(p.cacheLimit(), 400, '缓存上限应为 400 张');
});

check('换仓库后旧的公开/私有结论必须失效', () => {
  const p = require('../photos.js');
  p.saveConfig({ github: { repo: 'me/a', isPublic: true } });
  assert.strictEqual(p.config().github.isPublic, true, '显式写入的结论要保留');
  assert.strictEqual(p.saveConfig({ github: { repo: 'me/a' } }).github.isPublic, true, '同仓库重复保存不该清掉结论');
  assert.strictEqual(p.saveConfig({ github: { repo: 'me/b' } }).github.isPublic, null,
    '换仓库后必须重新校验，否则私有仓库会被旧结论当成公开的拦住');
  p.saveConfig({ github: { repo: '', isPublic: null } });
});

check('Cloudflare 照片加速 Worker：只读、防穿越、带边缘缓存', () => {
  const w = fs.readFileSync(path.join(root, 'deploy', 'gh-photo-proxy.js'), 'utf8');
  ['caches.default', 'GH_TOKEN', 'PROXY_KEY', 'X-Station-Key', 'application/vnd.github.raw',
    '/photo', '/ping', 'ALLOWED_ORIGINS', 'CACHE_TTL', 'private, max-age', 'immutable', 'X-Cache']
    .forEach(k => assert.ok(w.includes(k), 'Worker 缺少 ' + k));
  assert.ok(/request\.method !== 'GET'/.test(w), '应显式拒绝非 GET 请求');
  assert.ok(!/method:\s*'PUT'/.test(w), '这个节点不能接受写入，否则等于对外开放仓库写权限');
  assert.ok(/=== '\.\.'/.test(w), '必须拦截 ../ 路径穿越');
  assert.ok(/gh-photo-proxy\.internal/.test(w), '缓存键要用固定内部域名，避免请求差异把缓存打散');
  assert.ok(!/(?:GH_TOKEN|PROXY_KEY)\s*=\s*['"][^'"]{8,}['"]/.test(w), 'Worker 里不能写死 token 或密钥');
});

check('设置页：加速地址、密钥与照片缓存开关都在 GitHub 区块里', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['ghProxyBase', 'ghProxyKey', 'ghCache', 'ghCacheState', 'btnGhClearCache']
    .forEach(id => assert.ok(html.includes('id="' + id + '"'), '设置页缺字段 ' + id));
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/photos\.clearCache\(\)/.test(app), '要有清除缓存的动作');
  assert.ok(/photos\.cacheInfo\(\)/.test(app), '要展示缓存状态');
  assert.ok(/ghProxyBase'\)\.value/.test(app), '要读写加速地址');
});

checkAsync('照片缓存：没有 IndexedDB 时静默降级而不是抛错', async () => {
  const p = require('../photos.js');
  const info = await p.cacheInfo();
  assert.strictEqual(info.supported, false, 'Node 环境没有 IndexedDB，应报不支持');
  assert.strictEqual(info.count, 0);
  const clear = await p.clearCache();
  assert.strictEqual(typeof clear.ok, 'boolean', 'clearCache 应返回结果而不是抛异常');
});

check('本地存储写不进去时：注册明确报错，不静默成功', () => {
  const authApi = require('../auth.js');
  const bad = {
    getItem: function () { return null; },
    setItem: function () { throw new Error('QuotaExceededError'); },
    removeItem: function () { }
  };
  const a = authApi.createAuth(bad, bad);
  assert.strictEqual(a.status().storageOk, false, '启动探测就该发现存储不可写');
  const r = a.register({ name: '测试', username: 'quotauser', password: 'quota123456', confirm: 'quota123456' });
  assert.strictEqual(r.ok, false, '账号存不下来时不能假装成功');
  assert.ok(/本地存储/.test(r.error), '提示应点明是本地存储的问题：' + r.error);
  assert.strictEqual(a.status().count, 0, '失败的注册不能留在内存里');
});

check('本地存储写不进去时：登录仍能进入，并提示刷新会掉线', () => {
  const authApi = require('../auth.js');
  const base = authApi.memoryStorage();
  const writer = authApi.createAuth(base, authApi.memoryStorage());
  assert.strictEqual(writer.register({
    name: '测试', username: 'quituser', password: 'quit123456', confirm: 'quit123456'
  }).ok, true);

  /* 读得到、写不进：等同无痕模式 */
  const ro = {
    getItem: function (k) { return base.getItem(k); },
    setItem: function () { throw new Error('QuotaExceededError'); },
    removeItem: function () { }
  };
  const a = authApi.createAuth(ro, ro);
  let r;
  assert.doesNotThrow(function () { r = a.login({ username: 'quituser', password: 'quit123456' }); },
    '存储异常不能冒到提交处理器外面，那会让「点登录毫无反应」');
  assert.strictEqual(r.ok, true, '登录本身应当成功：' + r.error);
  assert.ok(/只在当前页面/.test(r.warning || ''), '必须提示只在当前页面有效：' + r.warning);
  assert.ok(!!a.current(), '要有内存会话兜底，否则会「登录成功→立刻弹回登录页」');
  assert.doesNotThrow(function () { a.logout(); }, '退出登录也不能因为存储异常而崩');
  assert.strictEqual(a.current(), null);
});

check('台账写入失败不抛异常，但会如实报告没存下来', () => {
  const bad = {
    getItem: function () { return null; },
    setItem: function () { throw new Error('QuotaExceededError'); },
    removeItem: function () { }
  };
  const s2 = api.createStore(bad);
  assert.strictEqual(s2.storageOk(), true, '还没写之前应视为可用');
  assert.doesNotThrow(function () { s2.addParcel({ trackingNo: 'QUOTA001' }); }, '入库不能因存储异常中断');
  assert.strictEqual(s2.storageOk(), false, '写失败后要能被界面查出来');
});

check('移动端登录：输入框 16px 防缩放、触屏延迟、键盘余量都已就位', () => {
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.ok(/\.input,\s*select\.input[\s\S]{0,90}font-size:\s*16px/.test(css),
    '移动端输入框必须 16px，否则 iOS 聚焦会放大整页并把按钮顶出屏幕');
  assert.ok(/touch-action:\s*manipulation/.test(css), '按钮要取消双击缩放的 300ms 等待');
  assert.ok(/-webkit-touch-callout:\s*none/.test(css), '长按标题要屏蔽系统菜单，否则初始化入口点不出来');
  assert.ok(/var\(--kb/.test(css), '登录门要按键盘高度留出可滚动余量');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/visualViewport/.test(app), '要用 visualViewport 算键盘高度');
  assert.ok(/authStorageHint/.test(app), '存储不可用要在登录页直接说明');
  assert.ok(/pointer:\s*coarse/.test(app), '触屏设备不应自动聚焦弹键盘');
});

/* 关键回归：有些环境「读 localStorage 属性」本身就抛 SecurityError
   （Safari 阻止所有 Cookie、微信/QQ 内置浏览器、WebView 未开 DOM storage、Chrome 打开 file://）。
   裸访问会让 app.js 在加载阶段崩掉，表现是「点登录毫无反应、连报错都没有」。 */
check('存储不可访问（属性直接抛异常）时模块不崩，登录仍给出准确提示', () => {
  const keys = ['localStorage', 'sessionStorage'];
  const saved = {};
  keys.forEach(k => { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); });
  keys.forEach(k => {
    Object.defineProperty(globalThis, k, {
      configurable: true,
      get() { throw new Error('SecurityError: The operation is insecure.'); }
    });
  });
  try {
    delete require.cache[require.resolve('../store.js')];
    delete require.cache[require.resolve('../auth.js')];

    const S = require('../store.js');
    assert.strictEqual(S.pickStorage('local').__memory, true, '取不到 localStorage 时应退回内存实现');
    assert.strictEqual(S.storageBlocked(), true);
    assert.doesNotThrow(() => S.createStore(), 'createStore 不能在加载阶段抛异常');

    const A = require('../auth.js');
    const auth = A.createAuth();
    const st = auth.status();
    assert.strictEqual(st.storageOk, false, '应识别出存储不可用');
    assert.strictEqual(st.needSetup, true);

    /* 没有账号时不能报「密码不正确」——那会让用户以为密码错了 */
    const r = auth.login({ username: 'admin', password: 'demo-pass-1' });
    assert.strictEqual(r.ok, false);
    assert.ok(/不允许保存数据|文件方式|还没有账号/.test(r.error), '提示应说明根因：' + r.error);

    /* 初始化仍应能在内存里跑通，但要明确告诉用户刷新会丢 */
    const reg = auth.register({ name: '站长', username: 'admin', password: 'demo-pass-1', confirm: 'demo-pass-1' });
    assert.strictEqual(reg.ok, true, '内存态应允许初始化：' + (reg.error || ''));
    assert.ok(/刷新/.test(reg.warning || ''), '必须提示刷新会丢：' + reg.warning);
    assert.strictEqual(auth.status().loggedIn, true, '内存会话应让当前页面可用');
  } finally {
    keys.forEach(k => {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    });
    delete require.cache[require.resolve('../store.js')];
    delete require.cache[require.resolve('../auth.js')];
  }
});

check('脚本带版本号，登录页自带自检入口', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  // 旧 Service Worker 用的是「缓存优先」，不换 URL 就永远拿不到新代码
  assert.ok(/<script src="app\.js\?v=[\d.]+"><\/script>/.test(html), 'app.js 必须带版本号绕开旧缓存');
  assert.ok(/href="styles\.css\?v=[\d.]+"/.test(html), 'styles.css 同样要带版本号');
  assert.ok(/id="btnAuthDiag"/.test(html) && /id="authDiag"/.test(html), '登录页要有自检入口');
  assert.ok(/id="authStorageWhy"/.test(html), '存储提示要能按场景换文案');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(/BUILD\s*=\s*'[\d.]+'/.test(sw), 'SW 预缓存清单要用同一个版本号');
});

check('零账号时登录页有可见的初始化入口，且初始化仍受「仅零账号」限制', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(/id="btnGoSetup"/.test(html), '零账号时必须给可见的初始化按钮，不能只靠长按手势');
  assert.ok(/id="btnBootImport"/.test(html), '零账号时也要能直接导入备份');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/btnGoSetup'\)\.onclick[\s\S]{0,200}needSetup/.test(app), '初始化按钮必须自己再校验一次「零账号」');
  const auth = fs.readFileSync(path.join(root, 'auth.js'), 'utf8');
  assert.ok(/if \(db\.accounts\.length\) return \{ ok: false, error: '本站已初始化/.test(auth),
    'auth.register 仍要拒绝有账号后的自助注册');
});

/* ---------- 拍照取件（1.0.7） ---------- */
check('拍照取件：识别模块可加载，纯函数接口齐全', () => {
  const r = require('../recognize.js');
  ['engines', 'tokens', 'scoreParcel', 'match', 'safeName', 'fileName', 'detect', 'detectAndMatch']
    .forEach(k => assert.strictEqual(typeof r[k], 'function', '识别模块缺少接口 ' + k));
});

check('拍照取件：候选串能拆出取件码 / 单号 / 尾号，并排除年份干扰', () => {
  const r = require('../recognize.js');
  const t = r.tokens(['取件码 A011', '运单号 YT100001', '手机 13800123456', '2026 0000']);
  assert.ok(t.includes('A011'), '没提到取件码');
  assert.ok(t.includes('YT100001'), '没提到运单号');
  assert.ok(t.includes('13800123456'), '没提到完整手机号');
  assert.ok(t.includes('3456'), '没从长数字串里取出手机尾号');
  assert.ok(!t.includes('2026') && !t.includes('0000'), '年份 / 全零不该当取件码');
  assert.ok(t.indexOf('YT100001') < t.indexOf('3456'), '长串应优先于 4 位尾号');
});

check('拍照取件：精确命中自动选中，并列候选不自动出库，无命中留手输', () => {
  const r = require('../recognize.js');
  const parcels = [
    { id: 'p1', status: 'in', pickupCode: 'A011', trackingNo: 'YT100001', phoneTail: '3456', slot: 'A-01-1' },
    { id: 'p2', status: 'in', pickupCode: 'B012', trackingNo: 'YT100002', phoneTail: '7890', slot: 'B-01-1' }
  ];
  const one = r.match(['取件码 A011'], parcels);
  assert.ok(one.best && one.best.parcel.id === 'p1', '精确取件码应自动选中');
  const amb = r.match(['3456 7890'], parcels);
  assert.strictEqual(amb.best, null, '两件都精确命中时不能猜一件自动出库');
  assert.strictEqual(amb.ambiguous, true);
  assert.strictEqual(amb.candidates.length, 2);
  const none = r.match(['ZZZZ9999'], parcels);
  assert.strictEqual(none.best, null);
  assert.strictEqual(none.candidates.length, 0);
  const out = r.match(['A011'], [{ id: 'x', status: 'out', pickupCode: 'A011', trackingNo: 'YT9' }]);
  assert.strictEqual(out.best, null, '已出库包裹不该被识别选中');
});

check('拍照取件：凭证名带取件码 / 单号，路径穿越被清洗', () => {
  const r = require('../recognize.js');
  const parcel = { pickupCode: 'A011', trackingNo: 'YT100001', phoneTail: '3456' };
  const name = r.fileName({ best: { parcel: parcel } }, new Date(2026, 10, 14, 19, 32, 10));
  assert.ok(/^CK_20261114-193210_A011_YT100001_[a-z0-9]{1,3}\.jpg$/.test(name), '命名格式不对：' + name);
  assert.ok(r.fileName({ tokens: ['YT999'] }, new Date(2026, 10, 14)).includes('未匹配'));
  assert.ok(r.fileName({ tokens: [] }, new Date(2026, 10, 14)).includes('未识别'));
  assert.ok(!r.safeName('../../etc/passwd').includes('/'), '文件名不能带路径分隔符');
  assert.ok(/\.jpg$/.test(r.safeName('凭证.PNG')), '压缩成 JPEG 后文件名必须以 .jpg 结尾');
});

checkAsync('拍照取件：没有浏览器识别接口时如实降级，不假识别', async () => {
  const r = require('../recognize.js');
  const d = await r.detect({});
  if (!r.engines().any) {
    assert.strictEqual(d.supported, false);
    assert.deepStrictEqual(d.texts, []);
    assert.deepStrictEqual(d.barcodes, []);
  } else {
    assert.ok(Array.isArray(d.texts));
  }
  const m = await r.detectAndMatch({}, []);
  assert.ok(m && Array.isArray(m.candidates) && Array.isArray(m.tokens));
});

check('拍照取件：photos.put 支持自定义文件名，且不允许路径穿越', () => {
  const p = require('../photos.js');
  assert.strictEqual(typeof p.safeCustomName, 'function');
  const clean = p.safeCustomName('../../CK_20261114_A011.jpg');
  assert.ok(!clean.includes('/'), '自定义文件名被清洗后仍含路径分隔符');
  assert.ok(/\.jpg$/.test(clean));
  const rel = p.buildRel('pickup', 'CK_20261114-193000_A011_YT100001_abc.jpg');
  assert.ok(rel.indexOf('出库凭证/') === 0, '目录仍要按出库凭证 / 年-月 归档');
  assert.ok(rel.endsWith('/CK_20261114-193000_A011_YT100001_abc.jpg'));
  assert.ok(p.buildRel('pickup').endsWith('.jpg'), '不传自定义名时仍用随机时间名');
});

check('拍照取件：自动开镜头开关默认开、可关闭并回读', () => {
  const p = require('../photos.js');
  assert.strictEqual(p.config().autoCapture, true);
  assert.strictEqual(p.saveConfig({ autoCapture: false }).autoCapture, false);
  p.saveConfig({ autoCapture: true });
});

check('拍照取件：首屏结构、自动开镜头与连续取件流程齐全', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['id="scanCard"', 'id="btnScanPickup"', 'id="scanState"', 'id="scanCandidates"',
    'id="scanFileName"', 'id="scanEngine"', 'id="phAutoCapture"', 'recognize.js?v=']
    .forEach(k => assert.ok(html.includes(k), '页面缺少 ' + k));
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  ['maybeAutoCapture', 'capturePickup', 'handlePickupPhoto', 'applyScanChoice',
    'recognize.detectAndMatch', 'recognize.fileName', 'name: customName', 'usedScan',
    'phAutoCapture', 'state.scan.autoTried = false',
    'state.outKeyword = res.best.token']
    .forEach(k => assert.ok(app.includes(k), 'app.js 缺少 ' + k));
  const cam = fs.readFileSync(path.join(root, 'camera.js'), 'utf8');
  assert.ok(/subtitle/.test(cam) && /startWatch/.test(cam), '相机缺少拍照取件副标题 / 黑屏兜底');
});

/* ---------- 入库：识别条码并按条码命名（1.0.8） ---------- */
check('入库条码：清洗、优先取条码、按条码生成 RK_ 文件名', () => {
  const r = require('../recognize.js');
  assert.strictEqual(r.cleanBarcode(' YT 100001 '), 'YT100001');
  assert.strictEqual(r.cleanBarcode('1234'), '', '太短的串不能当运单号');
  assert.strictEqual(r.cleanBarcode('https://example.com/a'), '', '二维码里的网址不是运单号');
  assert.strictEqual(r.cleanBarcode('2026'), '', '年份不是运单号');
  assert.strictEqual(r.barcodeOf({ barcodes: ['1234', 'YT100001'], texts: [] }), 'YT100001');
  assert.strictEqual(r.barcodeOf({ barcodes: [], texts: ['运单号 YT999888777'] }), 'YT999888777',
    '没有条码结果时应退回文字识别里最长的一串');
  assert.strictEqual(r.barcodeOf({ barcodes: [], texts: ['2026 0000'] }), '');
  const name = r.inboundName('YT100001', new Date(2026, 10, 14, 20, 5, 6));
  assert.ok(/^RK_20261114-200506_YT100001_[a-z0-9]{1,3}\.jpg$/.test(name), '入库文件名格式不对：' + name);
  assert.ok(r.inboundName('').includes('未识别'), '读不到条码也要按时间命名');
});

checkAsync('入库条码：detect 把条码与文字结果分开，barcodeOf 优先用条码', async () => {
  const r = require('../recognize.js');
  const keys = ['BarcodeDetector', 'TextDetector', 'createImageBitmap'];
  const saved = {};
  keys.forEach(k => { saved[k] = globalThis[k]; });
  globalThis.BarcodeDetector = class {
    static async getSupportedFormats() { return ['code_128']; }
    async detect() { return [{ rawValue: 'YT100001' }]; }
  };
  globalThis.TextDetector = class {
    async detect() { return [{ rawValue: '取件码 A011' }]; }
  };
  globalThis.createImageBitmap = async () => ({});
  try {
    const d = await r.detect({});
    assert.deepStrictEqual(d.barcodes, ['YT100001']);
    assert.ok(d.texts.includes('YT100001') && d.texts.includes('取件码 A011'),
      '出库查件仍要拿到全部候选文本');
    assert.strictEqual(r.barcodeOf(d), 'YT100001');
  } finally {
    keys.forEach(k => {
      if (saved[k] === undefined) delete globalThis[k];
      else globalThis[k] = saved[k];
    });
  }
});

check('入库条码：文件名能一路透传到 photos.buildRel', () => {
  const r = require('../recognize.js');
  const p = require('../photos.js');
  const name = r.inboundName('YT100001');
  assert.strictEqual(p.safeCustomName(name), name, '合法文件名不该被改写');
  const rel = p.buildRel('inbound', name);
  assert.ok(rel.indexOf('入库照片/') === 0, '入库目录仍按 入库照片/年-月 归档');
  assert.ok(rel.endsWith('/' + name), '自定义文件名未生效');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/savePhotos\(state\.inFiles, 'inbound'\)/.test(app), '入库提交仍要走 inbound 类型');
});

check('入库条码：页面状态条、自动填单号与等待识别后提交', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(html.includes('id="inOcrState"'), '入库页缺少识别状态条');
  assert.ok(html.includes('拍完自动识别条码、按条码命名'), '入库照片区未说明条码命名');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  ['nameInboundFiles', 'renderInOcr', 'recognize.barcodeOf', 'recognize.inboundName',
    'inOcrPending', 'await state.inOcrPending', 'input.value = codes[0]']
    .forEach(k => assert.ok(app.includes(k), 'app.js 缺少 ' + k));
  assert.ok(/if \(input && !input\.value\.trim\(\)\)/.test(app), '自动填单号必须只在输入框为空时生效');
  const css = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  assert.ok(/\.in-ocr\.ok/.test(css) && /\.in-ocr\.err/.test(css), '识别状态条缺少配色');
});

check('入库条码：降级路径不阻塞入库，且不会覆盖已有单号', () => {
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.ok(/没读到条码/.test(app), '读不到条码时要有明确提示');
  assert.ok(/识别失败仍按手输继续/.test(app), '识别失败不能卡住提交');
  assert.ok(/运单号已填，未覆盖/.test(app), '应说明已有单号不会被覆盖');
});

check('1.0.8 版本清单：脚本、SW、安卓资源与 APK 同步', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.ok(!/\?v=1\.0\.7/.test(html), '页面还有旧版本号，手机会一直跑旧 JS');
  assert.ok((html.match(/\?v=1\.0\.8/g) || []).length >= 8, '资源版本号数量不足');
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.ok(/BUILD\s*=\s*'1\.0\.8'/.test(sw) && /station-shell-v9/.test(sw));
  assert.ok(/\.\/recognize\.js\?v=' \+ BUILD/.test(sw), 'SW 预缓存清单漏了识别模块');
  const sh = fs.readFileSync(path.join(root, 'android/build-apk.sh'), 'utf8');
  const listed = (sh.match(/for f in (index\.html[^;]*); do/) || [])[1] || '';
  assert.ok(listed.includes('recognize.js'), '打包脚本漏掉 recognize.js');
  assert.ok(/--version-name 1\.0\.8/.test(sh) && /express-station-1\.0\.8\.apk/.test(sh));
  const mf = fs.readFileSync(path.join(root, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(/versionCode="9"/.test(mf) && /versionName="1\.0\.8"/.test(mf));
  const dist = path.join(root, 'android/dist');
  const apks = fs.readdirSync(dist).filter(f => /^express-station-1\.0\.8\.apk$/.test(f));
  assert.ok(apks.length, '1.0.8 APK 未构建');
  const bin = fs.readFileSync(path.join(dist, apks[0])).toString('latin1');
  assert.ok(bin.includes('assets/recognize.js'), 'APK 里没有打包识别模块');
});

(async () => {
  for (const c of asyncChecks) {
    await c.fn();
    passed++;
    console.log('  ok  ' + c.name);
  }
  console.log('\n全部通过：' + passed + ' 项');
})();
