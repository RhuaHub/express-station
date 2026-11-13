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

check('photos.js 可加载且导出完整接口', () => {
  const p = require('../photos.js');
  ['config', 'saveConfig', 'init', 'pickDirectory', 'put', 'getUrl', 'test', 'status'].forEach(function (k) {
    assert.strictEqual(typeof p[k], 'function', '缺少接口 ' + k);
  });
  assert.strictEqual(p.config().mode, 'webdav');
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

console.log('\n全部通过：' + passed + ' 项');
