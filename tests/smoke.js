/* 冒烟测试：node tests/smoke.js —— 不依赖浏览器，验证数据层与页面引用完整性。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const api = require('../store.js');

const root = path.join(__dirname, '..');
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  ok  ' + name);
}

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

console.log('页面引用');
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
  const refs = Array.from(html.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css))"/g), m => m[1]);
  assert.ok(refs.length >= 4);
  refs.forEach(ref => assert.ok(fs.existsSync(path.join(root, ref)), '缺少文件 ' + ref));
});

console.log('\n全部通过：' + passed + ' 项');
