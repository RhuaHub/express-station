/* 驿站助手（重建版）· 回归测试
   运行：node tests/smoke.js
   覆盖：规则层、数据层、账号权限、页面接线、功能清单、排除项与版本一致性。 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const exists = (f) => fs.existsSync(path.join(root, f));

const R = require('../rules.js');
const DB = require('../db.js');
const Auth = require('../auth.js');
const Media = require('../media.js');

let pass = 0, fail = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; }
  catch (e) { fail++; failures.push(name + ' :: ' + (e && e.message || e)); }
}

function fresh() { return DB.createStore(DB.memoryStorage(), '测试员'); }
function isoAt(day, h) { return new Date(day + 'T' + (h || '10:00') + ':00').toISOString(); }

/* ================= 1. 文件与版本一致性 ================= */
check('重建版文件齐全', () => {
  ['index.html', 'styles.css', 'rules.js', 'db.js', 'auth.js', 'media.js', 'app.js', 'sw.js',
    'manifest.webmanifest', 'README.md', 'tests/smoke.js', 'android/build-apk.sh'].forEach(f => {
      assert.ok(exists(f), '缺文件 ' + f);
    });
  ['store.js', 'assistant.js', 'recognize.js', 'photos.js', 'camera.js', 'sync.js'].forEach(f => {
    assert.ok(!exists(f), '旧版文件未作废：' + f);
  });
});
check('index.html 脚本版本号统一 2.0.1', () => {
  const h = read('index.html');
  ['rules.js', 'db.js', 'auth.js', 'media.js', 'app.js', 'styles.css', 'manifest.webmanifest'].forEach(f => {
    assert.ok(h.includes(f + '?v=2.0.1'), '没有带版本号引用 ' + f);
  });
  assert.ok(!/\?v=1\./.test(h), '还残留旧版版本号');
});
check('SW 缓存清单与 BUILD 同步', () => {
  const sw = read('sw.js');
  assert.ok(/BUILD\s*=\s*'2\.0\.1'/.test(sw));
  assert.ok(/station-rebuild-v2/.test(sw));
  ['rules.js', 'db.js', 'auth.js', 'media.js', 'app.js', 'styles.css'].forEach(f => {
    assert.ok(sw.includes("'./" + f + "?v=' + BUILD"), 'SW 漏缓存 ' + f);
  });
});
check('安卓资源清单 / 版本号 / APK 名', () => {
  const sh = read('android/build-apk.sh');
  const listed = (sh.match(/for f in (index\.html[^;]*); do/) || [])[1] || '';
  ['rules.js', 'db.js', 'auth.js', 'media.js', 'app.js', 'sw.js'].forEach(f => {
    assert.ok(listed.includes(f), '打包漏了 ' + f);
  });
  assert.ok(/--version-name 2\.0\.1/.test(sh) && /--version-code 12/.test(sh));
  assert.ok(/station-assistant-2\.0\.1\.apk/.test(sh));
  const mf = read('android/app/src/main/AndroidManifest.xml');
  assert.ok(/versionCode="12"/.test(mf) && /versionName="2\.0\.1"/.test(mf));
  assert.ok(!/SEND_SMS|CALL_PHONE|READ_CONTACTS/.test(mf), '安卓清单出现通知类权限');
});
check('安卓 APK 已构建且含全部新脚本', () => {
  const apk = path.join(root, 'android/dist/station-assistant-2.0.1.apk');
  assert.ok(fs.existsSync(apk), '2.0.1 APK 未构建');
  const bin = fs.readFileSync(apk).toString('latin1');
  ['assets/app.js', 'assets/rules.js', 'assets/db.js', 'assets/auth.js', 'assets/media.js'].forEach(f => {
    assert.ok(bin.includes(f), 'APK 缺少 ' + f);
  });
  assert.ok(!bin.includes('assets/store.js'), 'APK 里还带着旧版文件');
});

/* ============ 1.1 安卓 WebView 稳定性（2.0.1） ============ */
check('安卓 WebView 启动与登录崩溃加固', () => {
  const h = read('index.html');
  assert.ok(h.includes('window.StationBoot ='), '缺少启动错误兜底');
  assert.ok(h.includes('id="bootError"') && h.includes('bootErrorCopy'), '缺少可见错误条');
  assert.ok(h.includes('ExpressStationApp') && h.includes("typeof sw.register !== 'function'"),
    '没有为 Android WebView 跳过 / 加固 Service Worker 注册');
  assert.ok(h.includes('StationNative.logError'), '页面异常没有同步到原生日志');
  assert.ok(read('styles.css').includes('.boot-error'), '缺少错误条样式');

  const app = read('app.js');
  assert.ok(app.includes('function reportBoot('), '缺少异常上报');
  assert.ok(app.includes('try { renderAll(); }'), '主界面渲染没有兜底');
  assert.ok(app.includes('bootErrors: function ()'), '自检没有带启动错误');
  assert.ok(app.includes('window.StationNative.crashLog'), '自检没有读原生日志');

  ['app.js', 'db.js', 'auth.js', 'media.js', 'rules.js'].forEach(f => {
    assert.ok(!/\.findIndex\(/.test(read(f)), f + ' 用了老 WebView 不支持的 findIndex');
  });

  const java = read('android/app/src/main/java/com/rhua/expressstation/MainActivity.java');
  assert.ok(java.includes('installCrashHandler()'), '缺少原生崩溃日志');
  assert.ok(java.includes('station-errors.txt'), '缺少错误日志文件');
  assert.ok(java.includes('web.loadUrl(START_URL)'), '没有始终重新加载页面');
  assert.ok(!java.includes('restoreState('), '仍在用 restoreState 导致重建白屏');
  assert.ok(java.includes('public String crashLog()'), '原生桥没暴露 crashLog');
  assert.ok(read('README.md').includes('安卓 WebView 稳定性修复'), '文档没写修复说明');
});

/* ================= 2. 排除项：源码里没有通知能力 ================= */
check('业务代码没有短信 / 电话 / 群呼能力', () => {
  const files = ['index.html', 'app.js', 'rules.js', 'db.js', 'auth.js', 'media.js',
    'sw.js', 'android/app/src/main/java/com/rhua/expressstation/MainActivity.java'];
  const bad = /tel:|sms:|SmsManager|ACTION_CALL|ACTION_SENDTO|sendSms\(|makePhoneCall|groupCall|CALL_PHONE|SEND_SMS|拨打电话|群发短信接口|语音通知接口/;
  files.forEach(f => {
    assert.ok(!bad.test(read(f)), f + ' 里出现通知能力调用');
  });
});
check('帮助页逐条列出已实现与排除项', () => {
  const app = read('app.js');
  assert.ok(/var HELP_FEATURES = \[/.test(app) && /var HELP_EXCLUDED = \[/.test(app));
  const seg = app.slice(app.indexOf('var HELP_FEATURES'), app.indexOf('function renderHelp'));
  ['拍照取件', '移库', '客户管理', '业务统计', '货号标签', '入库拦截'].forEach(k => {
    assert.ok(seg.includes(k), '功能清单漏了 ' + k);
  });
  ['短信类', '电话类', '微信通知', '服务端合作'].forEach(k => {
    assert.ok(seg.includes(k), '排除项漏了 ' + k);
  });
});

/* ================= 3. 规则层 ================= */
check('SHA-256 与标准实现一致（含中文与长文本）', () => {
  ['abc', '', '驿站助手', 'a'.repeat(200), '汉'.repeat(300)].forEach(s => {
    assert.strictEqual(Auth.sha256Hex(s), crypto.createHash('sha256').update(s, 'utf8').digest('hex'));
  });
});
check('快递公司：常见单号前缀识别', () => {
  assert.strictEqual(R.detectCarrier('YT9000012345', R.DEFAULT_COMPANIES).name, '圆通速递');
  assert.strictEqual(R.detectCarrier('ZT7700000012', R.DEFAULT_COMPANIES).short, 'ZT');
  assert.strictEqual(R.detectCarrier('SF123456789012', R.DEFAULT_COMPANIES).name, '顺丰速运');
  assert.strictEqual(R.detectCarrier('XX_UNKNOWN_99', R.DEFAULT_COMPANIES).name, '其他');
});
check('快递公司：自定义规则与停用', () => {
  const cs = [{ id: 'x', name: '测试速递', short: 'CS', rule: '^CS\\d+', enabled: true }];
  assert.strictEqual(R.detectCarrier('CS123456', cs).name, '测试速递');
  cs[0].enabled = false;
  assert.strictEqual(R.detectCarrier('CS123456', cs).name, '其他');
});
check('编号模式：连续 / 每日 / 货架 / 尾号', () => {
  assert.strictEqual(R.serialNumber('continuous', { seq: 23, width: 4 }), '0023');
  assert.strictEqual(R.serialNumber('tail', { seq: 23, width: 4, tail: '6789' }), '6789');
  assert.strictEqual(R.serialNumber('daily', { seq: 7, width: 3 }), '007');
});
check('货号模式：五种 + 自定义模板', () => {
  const ctx = { seq: 23, width: 4, slot: 'A01-01', tail: '6789', short: 'YT', date: '2026-11-23T10:00:00' };
  assert.strictEqual(R.goodsNumber('slotSerial', ctx), 'A01010023');
  assert.strictEqual(R.goodsNumber('dateCompany', ctx), '1123YT0023');
  assert.strictEqual(R.goodsNumber('tail', ctx), '67890023');
  assert.strictEqual(R.goodsNumber('plain', ctx), '0023');
  assert.strictEqual(R.goodsNumber('custom', Object.assign({}, ctx, { template: '{short}{day}{serial}' })), 'YT230023');
});
check('货号校验：结尾必须是数字、只允许大写字母数字连字符', () => {
  assert.ok(R.validGoodsNo('A010023') && R.validGoodsNo('YT23-0023'));
  assert.ok(!R.validGoodsNo('ABC') && !R.validGoodsNo('A/0023') && !R.validGoodsNo(''));
});
check('货架位生成与数量', () => {
  const list = R.slotList({ zones: ['A', 'B'], shelvesPerZone: 2, levelsPerShelf: 3 });
  assert.strictEqual(list.length, 12);
  assert.strictEqual(list[0], 'A01-01');
});
check('手机号：尾号、校验、脱敏', () => {
  assert.strictEqual(R.tail4('13800138000'), '8000');
  assert.ok(R.phoneOk('13800138000') && R.phoneOk('075512345678'));
  assert.ok(!R.phoneOk('123'));
  assert.strictEqual(R.maskPhone('13800138000'), '138****8000');
});
check('文件名：清洗路径穿越并强制 .jpg', () => {
  const cleaned = R.safeFileName('../../etc/passwd');
  assert.ok(cleaned.endsWith('.jpg') && cleaned.indexOf('/') < 0 && cleaned.indexOf('..') < 0);
  assert.ok(R.safeFileName('A<B>:C').indexOf('/') < 0);
  assert.ok(/\.jpg$/.test(R.inboundPhotoName('YT900001')));
  assert.ok(R.outboundPhotoName({ goodsNo: 'A010023', trackingNo: 'YT900001' }).startsWith('CK_'));
  assert.ok(R.inboundPhotoName('').includes('未识别'));
});
check('条码清洗：过滤网址 / 年份 / 过短串，取最长', () => {
  assert.strictEqual(R.cleanBarcode('https://example.com/x'), '');
  assert.strictEqual(R.cleanBarcode('2026'), '');
  assert.strictEqual(R.cleanBarcode('abc'), '');
  assert.strictEqual(R.cleanBarcode('YT 9000 0123 45'), 'YT9000012345');
  assert.strictEqual(R.barcodeOf({ barcodes: ['YT900001'], texts: ['ZT7700000012', '8000'] }), 'ZT7700000012');
});
check('批量文本解析：正常行、错误行、CSV 表头', () => {
  const text = '运单号,公司,电话,货架,备注\nYT9000012345,圆通速递,13800138000,A01-01,大件\nBAD\nZT7700000012 中通 13900001111';
  const r = R.parseBatch(text);
  assert.strictEqual(r.rows.length, 2);
  assert.strictEqual(r.errors.length, 1);
  assert.strictEqual(r.rows[0].trackingNo, 'YT9000012345');
  assert.strictEqual(r.rows[0].phone, '13800138000');
  assert.strictEqual(r.rows[0].slot, 'A01-01');
});
check('CSV 编解码：引号、逗号、换行', () => {
  const rows = [['货号', '备注'], ['A010023', '含,逗号'], ['B010024', '带"引号"']];
  const csv = R.toCSV(rows);
  const back = R.parseCSV(csv);
  assert.deepStrictEqual(back, rows);
});
check('查件打分：货号 / 编号 / 尾号 / 模糊', () => {
  const p = { goodsNo: 'A010023', serial: '0023', trackingNo: 'YT9000012345', phoneTail: '8000',
    pickupCode: 'A010023', recipient: '张三', slot: 'A01-01', carrier: '圆通速递', note: '' };
  assert.ok(R.scoreParcel(p, 'A010023', 'fuzzy') > R.scoreParcel(p, '8000', 'fuzzy'));
  assert.ok(R.scoreParcel(p, 'YT9000', 'fuzzy') > 0);
  assert.strictEqual(R.scoreParcel(p, 'ZZZZ', 'fuzzy'), 0);
});
check('组合查询：状态 / 公司 / 日期 / 排序', () => {
  const list = [
    { id: '1', goodsNo: 'A010001', trackingNo: 'YT1', status: 'in', inAt: isoAt('2026-11-10'), carrier: '圆通速递', slot: 'A01-01', phoneTail: '8000', recipient: '张三' },
    { id: '2', goodsNo: 'A010002', trackingNo: 'ZT2', status: 'out', outAt: isoAt('2026-11-12'), outType: 'pickup', inAt: isoAt('2026-11-11'), carrier: '中通快递', slot: 'A01-02', phoneTail: '1111', recipient: '李四' }
  ];
  assert.strictEqual(R.queryParcels(list, { status: 'in' }).length, 1);
  assert.strictEqual(R.queryParcels(list, { carrier: '中通快递' })[0].id, '2');
  assert.strictEqual(R.queryParcels(list, { from: '2026-11-11', to: '2026-11-12' }).length, 1);
  assert.strictEqual(R.queryParcels(list, { kw: '8000' })[0].id, '1');
});
check('时间范围：13 种预设都返回合法区间', () => {
  assert.strictEqual(R.PRESETS.length, 13);
  R.PRESETS.forEach(p => {
    const r = R.dateRange(p.id, '2026-01-01', '2026-01-31');
    assert.ok(r.from <= r.to, p.id + ' 区间反了');
    assert.ok(r.fromDay && r.toDay, p.id + ' 缺日期');
  });
});
check('统计汇总：入库 / 出库 / 退件 / 在库 / 出库率 / 每日明细', () => {
  const parcels = [
    { inAt: isoAt('2026-11-10'), outAt: isoAt('2026-11-10', '18:00'), status: 'out', outType: 'pickup', carrier: '圆通速递', operatorIn: '甲', operatorOut: '甲', photos: [] },
    { inAt: isoAt('2026-11-10'), outAt: isoAt('2026-11-11', '09:00'), status: 'out', outType: 'refund', carrier: '中通快递', operatorIn: '乙', operatorOut: '乙', photos: [] },
    { inAt: isoAt('2026-11-11'), status: 'in', outAt: null, outType: '', carrier: '圆通速递', operatorIn: '甲', operatorOut: '', photos: [] }
  ];
  const logs = [{ at: isoAt('2026-11-11'), action: 'undoIn', actor: '甲' }];
  const r = R.summarize(parcels, logs, R.dateRange('custom', '2026-11-10', '2026-11-11'), {});
  assert.strictEqual(r.inCount, 3);
  assert.strictEqual(r.outCount, 2);
  assert.strictEqual(r.pickupCount, 1);
  assert.strictEqual(r.refundCount, 1);
  assert.strictEqual(r.undoIn, 1);
  assert.strictEqual(r.byOperator['甲'].inCount, 2);
  assert.strictEqual(r.daily.length, 2);
  assert.ok(r.outRate > 0);
});
check('Code39 条码表自洽（每项 9 元素、3 个宽单元）', () => {
  Object.keys(R.C39).forEach(k => {
    const p = R.C39[k];
    assert.strictEqual(p.length, 9, k + ' 长度不对');
    assert.strictEqual((p.match(/w/g) || []).length, 3, k + ' 宽单元数不对');
  });
  const svg = R.code39SVG('A010023');
  assert.ok(svg.startsWith('<svg') && svg.includes('<rect') && svg.includes('A010023'));
  assert.strictEqual(R.code39SVG(''), '');
});
check('标签 HTML：字段可配、转义、含条码', () => {
  const p = { goodsNo: 'A010023', slot: 'A01-01', serial: '0023', recipient: '<b>', phoneTail: '8000',
    carrier: '圆通速递', trackingNo: 'YT9000012345', inAt: isoAt('2026-11-10'), label: '加急', note: '' };
  const html = R.labelHTML(p, { stationName: '测试驿站' }, ['station', 'goods', 'barcode']);
  assert.ok(html.includes('测试驿站') && html.includes('A010023') && html.includes('<svg'));
  assert.ok(!html.includes('<b>'), '收件人未转义');
  const minimal = R.labelHTML(p, {}, ['goods']);
  assert.ok(!minimal.includes('<svg'), '字段开关没生效');
});

/* ================= 4. 数据层 ================= */
check('存储被禁时自动降级为内存存储', () => {
  const old = global.localStorage;
  global.localStorage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() { throw new Error('SecurityError'); } };
  try {
    const s = DB.pickStorage('local');
    assert.ok(s._memory, '没有降级');
    const st = DB.createStore(s);
    assert.ok(!st.storageOk());
    assert.ok(st.addParcel({ trackingNo: 'YT9000012345' }).ok, '降级后不能入库');
  } finally { if (old === undefined) delete global.localStorage; else global.localStorage = old; }
});
check('默认数据库结构与设置项', () => {
  const st = fresh();
  assert.strictEqual(st.raw().app, 'station-assistant');
  assert.ok(st.raw().parcels && st.raw().customers && st.raw().companies && st.raw().logs);
  assert.strictEqual(st.settings().goodsMode, 'slotSerial');
  assert.strictEqual(st.settings().serialMode, 'continuous');
  assert.ok(Array.isArray(st.settings().labelFields));
});
check('入库：自动公司 / 货架 / 编号 / 货号 / 客户归档 / 流水 / 同步记录', () => {
  const st = fresh();
  const r = st.addParcel({ trackingNo: 'YT9000012345', phone: '13800138000', recipient: '张三' });
  assert.ok(r.ok, r.error);
  assert.strictEqual(r.parcel.carrier, '圆通速递');
  assert.strictEqual(r.parcel.serial, '0001');
  assert.ok(r.parcel.goodsNo && /\d$/.test(r.parcel.goodsNo));
  assert.ok(r.parcel.slot);
  assert.strictEqual(r.parcel.phoneTail, '8000');
  assert.strictEqual(st.listCustomers({})[0].tail, '8000');
  assert.strictEqual(st.listLogs({ action: 'in' }).length, 1);
  assert.strictEqual(st.listUploads({}).length, 1);
});
check('编号连续且预览不消耗计数器', () => {
  const st = fresh();
  const a = st.previewNums({ slot: 'A01-01' });
  const b = st.previewNums({ slot: 'A01-01' });
  assert.strictEqual(a.serial, b.serial);
  const p1 = st.addParcel({ trackingNo: 'YT9000000001' });
  const p2 = st.addParcel({ trackingNo: 'YT9000000002' });
  assert.strictEqual(p1.parcel.serial, '0001');
  assert.strictEqual(p2.parcel.serial, '0002');
});
check('入库校验：空号 / 过短 / 重复 / 货架占用', () => {
  const st = fresh();
  assert.ok(!st.addParcel({}).ok);
  assert.ok(!st.addParcel({ trackingNo: 'ABC' }).ok);
  const a = st.addParcel({ trackingNo: 'YT9000012345', slot: 'A01-01' });
  assert.ok(a.ok);
  assert.strictEqual(st.addParcel({ trackingNo: 'YT9000012345' }).error.indexOf('已入库') >= 0, true);
  assert.ok(!st.addParcel({ trackingNo: 'YT9000099999', slot: 'A01-01' }).ok);
});
check('黑名单与单号拦截', () => {
  const st = fresh();
  st.upsertCustomer({ phone: '13800138000', type: 'black' });
  const r = st.addParcel({ trackingNo: 'YT9000012345', phone: '13800138000' });
  assert.strictEqual(r.code, 'blacklist');
  st.updateSettings({ blacklistBlock: false });
  assert.ok(st.addParcel({ trackingNo: 'YT9000012345', phone: '13800138000' }).ok);
  assert.ok(st.addIntercept('ZT7700000012').ok);
  assert.strictEqual(st.addParcel({ trackingNo: 'ZT7700000012' }).code, 'intercepted');
  assert.ok(st.removeIntercept(st.listIntercepts()[0].id).ok);
});
check('修改包裹：货号校验、电话、留痕', () => {
  const st = fresh();
  const p = st.addParcel({ trackingNo: 'YT9000012345' }).parcel;
  assert.ok(!st.updateParcel(p.id, { goodsNo: 'ABC' }).ok);
  const r = st.updateParcel(p.id, { goodsNo: 'B020099', phone: '13900001111', note: '补录' });
  assert.ok(r.ok);
  assert.strictEqual(r.parcel.goodsNo, 'B020099');
  assert.strictEqual(r.parcel.phoneTail, '1111');
  assert.strictEqual(st.listLogs({ action: 'edit' }).length, 1);
});
check('出库：合并批次、退件原因必填、拍照引用、撤销出库', () => {
  const st = fresh();
  const a = st.addParcel({ trackingNo: 'YT9000000001' }).parcel;
  const b = st.addParcel({ trackingNo: 'YT9000000002' }).parcel;
  assert.ok(!st.checkout([b.id], { outType: 'refund' }).ok, '退件原因没校验');
  const r = st.checkout([a.id, b.id], { outType: 'merge', pickupBy: '本人', photos: [{ id: 'x', name: 'CK.jpg' }] });
  assert.ok(r.ok && r.merged && r.count === 2);
  assert.strictEqual(st.getParcel(a.id).batchId, r.batchId);
  assert.strictEqual(st.getParcel(a.id).photos.length, 1);
  assert.strictEqual(st.listLogs({ action: 'out' }).length, 1);
  const u = st.undoCheckout([a.id, b.id]);
  assert.ok(u.ok && st.getParcel(a.id).status === 'in');
  assert.strictEqual(st.listLogs({ action: 'undoOut' }).length, 1);
  const rf = st.checkout([a.id], { outType: 'refund', reason: '超期未取' });
  assert.ok(rf.ok && st.getParcel(a.id).outType === 'refund');
});
check('撤销入库：单件与批量', () => {
  const st = fresh();
  const one = st.addParcel({ trackingNo: 'YT9000000001' }).parcel;
  assert.ok(st.undoInbound(one.id).ok);
  assert.strictEqual(st.getParcel(one.id).status, 'void');
  const batch = st.batchAdd([{ trackingNo: 'YT9000000002' }, { trackingNo: 'YT9000000003' }]);
  assert.strictEqual(batch.count, 2);
  assert.strictEqual(st.undoInbound(batch.batchId).count, 2);
});
check('批量入库：失败行单独返回且不入库', () => {
  const st = fresh();
  const r = st.batchAdd([{ trackingNo: 'YT9000000001' }, { trackingNo: 'BAD' }, { trackingNo: 'YT9000000002' }]);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].row.trackingNo, 'BAD');
});
check('移库：同货架拒绝、换货架留痕、可选重算货号', () => {
  const st = fresh();
  const p = st.addParcel({ trackingNo: 'YT9000012345', slot: 'A01-01' }).parcel;
  assert.ok(!st.moveSlots([p.id], 'A01-01').ok);
  const before = p.goodsNo;
  assert.ok(st.moveSlots([p.id], 'C03-02', { regenGoods: true }).ok);
  assert.strictEqual(st.getParcel(p.id).slot, 'C03-02');
  assert.notStrictEqual(st.getParcel(p.id).goodsNo, before);
  assert.strictEqual(st.getParcel(p.id).moveHistory.length, 1);
  assert.strictEqual(st.listLogs({ action: 'move' }).length, 1);
});
check('批量改编号 / 货号从指定件起累加', () => {
  const st = fresh();
  st.addParcel({ trackingNo: 'YT9000000001' });
  st.addParcel({ trackingNo: 'YT9000000002' });
  const list = st.listParcels({ status: 'in' }).sort((a, b) => Number(a.serial) - Number(b.serial));
  const r = st.batchRenum(list[0].id, 'serial');
  assert.ok(r.ok && r.count === 2);
  assert.strictEqual(st.getParcel(list[1].id).serial, '0002');
});
check('客户：新增 / 尾号归并 / 类型 / 删除', () => {
  const st = fresh();
  assert.ok(st.upsertCustomer({ name: '张三', phone: '13800138000', type: 'vip' }).ok);
  const again = st.upsertCustomer({ phone: '13800138000', remark: '老客户' });
  assert.strictEqual(st.listCustomers({}).length, 1);
  assert.strictEqual(again.customer.type, 'vip');
  assert.strictEqual(st.listCustomers({ type: 'vip' }).length, 1);
  assert.ok(st.removeCustomer(again.customer.id).ok);
});
check('快递公司：CRUD 与非法正则拦截', () => {
  const st = fresh();
  assert.ok(!st.upsertCompany({ name: '坏规则', rule: '[' }).ok);
  const r = st.upsertCompany({ name: '测试速递', short: 'CS', rule: '^CS\\d+' });
  assert.ok(r.ok);
  assert.ok(st.listCompanies().some(c => c.name === '测试速递'));
  assert.ok(st.removeCompany(r.company.id).ok);
});
check('快递标签与收件任务', () => {
  const st = fresh();
  assert.deepStrictEqual(st.setLabels(['加急', '加急', '易碎']), ['加急', '易碎']);
  const c = st.addCollection({ recipient: '李四', phone: '13900001111', carrier: '圆通速递' });
  assert.ok(c.ok && c.collection.no.startsWith('SJ'));
  assert.ok(st.updateCollection(c.collection.id, { status: 'picked' }).ok);
  assert.strictEqual(st.listCollections({ status: 'picked' }).length, 1);
  assert.ok(st.removeCollection(c.collection.id).ok);
});
check('同步记录：本机模式与重新标记', () => {
  const st = fresh();
  const p = st.addParcel({ trackingNo: 'YT9000012345' }).parcel;
  const u = st.listUploads({})[0];
  assert.strictEqual(u.state, 'local');
  st.updateSettings({ syncEnabled: true });
  assert.ok(st.retryUpload(u.id).ok);
  assert.strictEqual(st.listUploads({})[0].state, 'pending');
});
check('统计、CSV 导出（包裹 / 客户 / 流水 / 统计）', () => {
  const st = fresh();
  st.addParcel({ trackingNo: 'YT9000012345', phone: '13800138000', recipient: '张三' });
  assert.ok(st.stats(R.dateRange('today')).inCount >= 1);
  ['parcels', 'customers', 'logs', 'stats'].forEach(k => {
    const csv = st.exportCSV(k, k === 'stats' ? { range: R.dateRange('today') } : {});
    assert.ok(csv.startsWith('\ufeff') && csv.split('\r\n').length >= 2, k + ' CSV 为空');
  });
  assert.ok(st.exportCSV('parcels').includes('YT9000012345'));
});
check('备份：导出 / 覆盖恢复 / 合并恢复', () => {
  const st = fresh();
  st.addParcel({ trackingNo: 'YT9000012345' });
  st.upsertCustomer({ phone: '13800138000' });
  const snap = st.exportSnapshot();
  assert.strictEqual(snap.app, 'station-assistant');
  const other = fresh();
  assert.ok(other.restoreSnapshot(snap, 'replace').ok);
  assert.strictEqual(other.listParcels({}).length, 1);
  assert.strictEqual(other.listCustomers({}).length, 1);
  assert.ok(other.restoreSnapshot(snap, 'merge').ok);
  assert.strictEqual(other.listParcels({}).length, 1, '合并重复导入了');
});
check('旧版 1.x 备份可导入（字段映射）', () => {
  const legacy = { app: 'express-station', version: 3, data: {
    settings: { stationName: '老驿站' },
    parcels: [{ id: 'old1', trackingNo: 'YT9000012345', pickupCode: 'A010023', slot: 'A01-01',
      phoneTail: '8000', recipient: '张三', carrier: '圆通速递', status: 'in', inAt: isoAt('2026-11-10'), photos: [] }],
    logs: [{ id: 'l1', at: isoAt('2026-11-10'), action: 'in', text: '入库', actor: '甲' }]
  } };
  const st = fresh();
  const r = st.restoreSnapshot(legacy, 'replace');
  assert.ok(r.ok);
  assert.strictEqual(st.getParcel('old1').goodsNo, 'A010023');
  assert.strictEqual(st.settings().stationName, '老驿站');
  assert.strictEqual(st.listLogs({}).length, 2);
});
check('清空数据后回到零账号状态', () => {
  const st = fresh();
  st.addParcel({ trackingNo: 'YT9000012345' });
  assert.ok(st.clearAll().ok);
  assert.strictEqual(st.listParcels({}).length, 0);
  assert.strictEqual(st.getAccounts().length, 0);
});

/* ================= 5. 账号与权限 ================= */
check('初始化站长 / 登录 / 退出 / 不开放注册', () => {
  const st = fresh(); const a = Auth.create(st);
  assert.ok(a.status().needSetup);
  const s = Auth.create(fresh());
  assert.ok(!s.setup({ name: 'j', password: '123' }).ok, '弱密码没拦住');
  assert.ok(s.setup({ name: 'joey', password: 'abc123456' }).ok);
  assert.ok(!s.setup({ name: 'x', password: 'abc123456' }).ok, '重复初始化没拦住');
  assert.ok(s.status().logged && s.can('settings'));
  s.logout();
  assert.ok(!s.status().logged);
  assert.ok(!s.login('joey', 'wrong').ok);
  assert.ok(s.login('joey', 'abc123456').ok);
});
check('登录失败限速与清除限制', () => {
  const st = fresh(); const a = Auth.create(st);
  a.setup({ name: 'joey', password: 'abc123456' }); a.logout();
  for (let i = 0; i < 5; i++) a.login('joey', 'bad');
  const r = a.login('joey', 'abc123456');
  assert.ok(!r.ok && /锁定|秒/.test(r.error), '没有触发锁定');
  a.clearLock();
  assert.ok(a.login('joey', 'abc123456').ok);
});
check('子账号：创建 / 授权 / 改密 / 删除 / 站长保护', () => {
  const st = fresh(); const a = Auth.create(st);
  a.setup({ name: 'boss', password: 'abc123456' });
  const sub = a.addAccount({ name: 'op', password: 'abc123456', role: 'operator' });
  assert.ok(sub.ok);
  assert.ok(!sub.account.perms.includes('accounts'), '操作员不该能管账号');
  a.logout(); a.login('op', 'abc123456');
  assert.ok(a.can('inbound') && !a.can('settings') && !a.can('accounts'));
  assert.ok(!a.addAccount({ name: 'x', password: 'abc123456' }).ok, '子账号竟然能建号');
  a.logout(); a.login('boss', 'abc123456');
  assert.ok(a.updateAccount(sub.account.id, { password: 'newpass12' }).ok);
  a.logout();
  assert.ok(a.login('op', 'newpass12').ok, '改密后登不上');
  a.logout(); a.login('boss', 'abc123456');
  const ownerId = a.listAccounts()[0].id;
  assert.ok(!a.removeAccount(ownerId).ok, '竟然能删站长');
  assert.ok(a.removeAccount(sub.account.id).ok);
});
check('子账号只读角色权限收敛', () => {
  const st = fresh(); const a = Auth.create(st);
  a.setup({ name: 'boss', password: 'abc123456' });
  const v = a.addAccount({ name: 'view', password: 'abc123456', role: 'viewer' });
  assert.ok(v.ok && v.account.perms.includes('query') && !v.account.perms.includes('inbound'));
});
check('自检面板信息可用', () => {
  const st = fresh(); const a = Auth.create(st);
  a.setup({ name: 'boss', password: 'abc123456' });
  const d = a.diag();
  assert.strictEqual(d.accounts, 1);
  assert.strictEqual(d.build, '2.0.1');
  assert.ok('storageOk' in d && 'role' in d);
});

/* ================= 6. 页面接线 ================= */
check('14 个视图与导航齐全', () => {
  const h = read('index.html'), app = read('app.js');
  ['dash', 'inbound', 'outbound', 'query', 'inventory', 'collections', 'customers', 'stats',
    'print', 'sync', 'settings', 'accounts', 'logs', 'help'].forEach(v => {
      assert.ok(h.includes('id="view-' + v + '"'), '缺视图 ' + v);
      assert.ok(h.includes('data-view="' + v + '"'), '缺导航 ' + v);
      assert.ok(app.includes(v + ': '), '缺标题 ' + v);
    });
});
check('页面接线：关键表单 / 按钮 / 渲染函数', () => {
  const app = read('app.js'), h = read('index.html');
  ['formIn', 'formSettings', 'formCustomer', 'formAccount', 'formCollection',
    'btnOutSubmit', 'btnBackup', 'btnRestore', 'btnDoPrint', 'btnInScan',
    'btnQuickSupplement', 'btnBatchImport', 'btnInvMove', 'btnInterceptAdd'].forEach(id => {
      assert.ok(h.includes('id="' + id + '"'), '缺元素 ' + id);
      assert.ok(app.includes("'" + id + "'"), '未绑定 ' + id);
    });
  ['renderAll', 'switchView', 'capturePickup', 'doCheckout', 'handleAct', 'submitInbound',
    'nameInFiles', 'renumDialog', 'supplementDialog', 'printParcels', 'bindIdle'].forEach(fn => {
      assert.ok(app.includes('function ' + fn), '缺函数 ' + fn);
    });
});
check('CSS：打印样式、移动端表格、16px 输入、安全区', () => {
  const css = read('styles.css');
  assert.ok(css.includes('@media print') && css.includes('.print-root'));
  assert.ok(css.includes('data-label') && css.includes('pointer: coarse'));
  assert.ok(css.includes('safe-area-inset') && css.includes('--kb'));
  assert.ok(css.includes('.cam-mask') && css.includes('.label-sheet'));
});
check('媒体模块：识别降级、反馈与照片库接口齐全', () => {
  assert.strictEqual(typeof Media.recognize, 'function');
  assert.strictEqual(typeof Media.capture, 'function');
  assert.strictEqual(typeof Media.exportAll, 'function');
  assert.strictEqual(typeof Media.feedback, 'function');
  assert.strictEqual(typeof Media.listen, 'function');
  const e = Media.engines();
  assert.ok('any' in e && 'barcode' in e && 'text' in e);
});
check('README 写明功能对照、排除项与数据边界', () => {
  const md = read('README.md');
  ['2.0.1', '短信', '电话', '群呼', '重建', '备份', 'IndexedDB', 'Code39'].forEach(k => {
    assert.ok(md.includes(k), 'README 漏了 ' + k);
  });
});
check('仓库无敏感凭据', () => {
  const files = ['index.html', 'app.js', 'rules.js', 'db.js', 'auth.js', 'media.js', 'sw.js', 'README.md'];
  const bad = /ghp_[A-Za-z0-9]{20}|"access_token"\s*:\s*"[A-Za-z0-9]{20}|refresh_token\s*[:=]\s*"[A-Za-z0-9]{20}|-----BEGIN [A-Z ]+PRIVATE KEY-----/;
  files.forEach(f => assert.ok(!bad.test(read(f)), f + ' 含疑似凭据'));
});

/* ================= 结果 ================= */
console.log('\n驿站助手 2.0.1 · 回归测试');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
