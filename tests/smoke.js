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

console.log('页面引用');
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
  const refs = Array.from(html.matchAll(/(?:src|href)="([\w./-]+\.(?:js|css))"/g), m => m[1]);
  assert.ok(refs.length >= 4);
  refs.forEach(ref => assert.ok(fs.existsSync(path.join(root, ref)), '缺少文件 ' + ref));
});

check('photos.js 可加载且导出完整接口', () => {
  const p = require('../photos.js');
  ['config', 'saveConfig', 'init', 'pickDirectory', 'put', 'getUrl', 'test', 'status', 'buildRel'].forEach(function (k) {
    assert.strictEqual(typeof p[k], 'function', '缺少接口 ' + k);
  });
  assert.strictEqual(p.config().mode, 'webdav');
  assert.strictEqual(p.config().requireProof, true, '出库凭证默认应为必拍');
  assert.strictEqual(p.saveConfig({ requireProof: false }).requireProof, false);
  p.saveConfig({ requireProof: true });
});

check('坚果云 CORS 代理 Worker 存在且不含硬编码凭据', () => {
  const worker = fs.readFileSync(path.join(root, 'deploy', 'nutstore-worker.js'), 'utf8');
  ['export default', 'dav.jianguoyun.com/dav', 'Access-Control-Allow-Origin',
    'Access-Control-Allow-Methods', 'MKCOL', 'PROPFIND', 'X-Proxy-Key']
    .forEach(k => assert.ok(worker.includes(k), 'Worker 缺少 ' + k));
  assert.ok(!/(?:password|token|secret)\s*=\s*['"][^'"]{8,}['"]/i.test(worker), 'Worker 里疑似写死凭据');
});

check('页面含坚果云配置入口与代理密钥字段', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  ['phProxyKey', 'nut-tip', 'nutstore-worker.js', '应用密码'].forEach(k => assert.ok(html.includes(k), '页面缺少 ' + k));
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
  assert.ok(/photos\.put\(files\[i\], kind\)/.test(app), '上传时未传入照片类型');
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

console.log('\n全部通过：' + passed + ' 项');
