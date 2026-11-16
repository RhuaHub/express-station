/* 驿站助手（重建版）· 回归测试
   运行：node tests/smoke.js
   覆盖：规则层、数据层、账号权限、页面接线、通知能力与安全限制、版本一致性。 */
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
const OCR = require('../ocr.js');
const QR = require('../qr.js');
const Extras = require('../extras.js');
const Notify = require('../notify.js');
const Scenarios = require('./ocr-scenarios.js');

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
  ['index.html', 'styles.css', 'rules.js', 'ocr.js', 'qr.js', 'db.js', 'auth.js', 'media.js',
    'extras.js', 'notify.js', 'app.js', 'sw.js', 'manifest.webmanifest', 'README.md', 'tests/smoke.js',
    'tests/ocr-scenarios.js', 'android/build-apk.sh'].forEach(f => {
      assert.ok(exists(f), '缺文件 ' + f);
    });
  ['store.js', 'assistant.js', 'recognize.js', 'photos.js', 'camera.js', 'sync.js'].forEach(f => {
    assert.ok(!exists(f), '旧版文件未作废：' + f);
  });
});
check('index.html 脚本版本号统一 2.3.0', () => {
  const h = read('index.html');
  ['rules.js', 'ocr.js', 'qr.js', 'db.js', 'auth.js', 'media.js', 'extras.js', 'notify.js', 'app.js',
    'styles.css', 'manifest.webmanifest'].forEach(f => {
      assert.ok(h.includes(f + '?v=2.3.0'), '没有带版本号引用 ' + f);
    });
  assert.ok(h.indexOf('ocr.js') < h.indexOf('media.js'), 'ocr.js 必须在 media.js 之前加载');
  assert.ok(h.indexOf('qr.js') < h.indexOf('media.js'), 'qr.js 必须在 media.js 之前加载');
  assert.ok(h.indexOf('notify.js') < h.indexOf('app.js'), 'notify.js 必须在 app.js 之前加载');
  assert.ok(!/\?v=1\./.test(h), '还残留旧版版本号');
});
check('SW 缓存清单与 BUILD 同步', () => {
  const sw = read('sw.js');
  assert.ok(/BUILD\s*=\s*'2\.3\.0'/.test(sw));
  assert.ok(/station-rebuild-v10/.test(sw));
  ['rules.js', 'ocr.js', 'qr.js', 'db.js', 'auth.js', 'media.js', 'extras.js', 'notify.js', 'app.js', 'styles.css'].forEach(f => {
    assert.ok(sw.includes("'./" + f + "?v=' + BUILD"), 'SW 漏缓存 ' + f);
  });
});
check('安卓资源清单 / 版本号 / 通知权限 / APK 名', () => {
  const sh = read('android/build-apk.sh');
  const listed = (sh.match(/for f in (index\.html[^;]*); do/) || [])[1] || '';
  ['rules.js', 'ocr.js', 'qr.js', 'db.js', 'auth.js', 'media.js', 'extras.js', 'notify.js', 'app.js', 'sw.js'].forEach(f => {
    assert.ok(listed.includes(f), '打包漏了 ' + f);
  });
  assert.ok(/--version-name 2\.3\.0/.test(sh) && /--version-code 20/.test(sh));
  assert.ok(/station-assistant-2\.3\.0\.apk/.test(sh));
  const mf = read('android/app/src/main/AndroidManifest.xml');
  assert.ok(/versionCode="20"/.test(mf) && /versionName="2\.3\.0"/.test(mf));
  ['SEND_SMS', 'CALL_PHONE', 'READ_CALL_LOG'].forEach(p => {
    assert.ok(mf.includes('android.permission.' + p), '安卓清单缺少通知权限 ' + p);
  });
});
check('安卓 APK 已构建且含全部新脚本', () => {
  const apk = path.join(root, 'android/dist/station-assistant-2.3.0.apk');
  assert.ok(fs.existsSync(apk), '2.3.0 APK 未构建');
  const bin = fs.readFileSync(apk).toString('latin1');
  ['assets/app.js', 'assets/rules.js', 'assets/ocr.js', 'assets/qr.js', 'assets/db.js',
    'assets/auth.js', 'assets/media.js', 'assets/extras.js', 'assets/notify.js'].forEach(f => {
      assert.ok(bin.includes(f), 'APK 缺少 ' + f);
    });
  assert.ok(!bin.includes('assets/store.js'), 'APK 里还带着旧版文件');
});

/* ============ 1.1 安卓 WebView 稳定性（2.0.5） ============ */
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
  assert.ok(java.includes('Thread.setDefaultUncaughtExceptionHandler'), '缺少静态崩溃处理器');
  assert.ok(java.includes('attachBaseContext(Context base)'), '崩溃处理器拿不到 Context');
  assert.ok(java.includes('station-errors.txt'), '缺少错误日志文件');
  assert.ok(java.includes('web.loadUrl(START_URL'), '没有始终重新加载页面');
  assert.ok(!java.includes('restoreState('), '仍在用 restoreState 导致重建白屏');
  assert.ok(java.includes('public String crashLog()'), '原生桥没暴露 crashLog');
  assert.ok(read('README.md').includes('安卓 WebView 稳定性修复'), '文档没写修复说明');
});

/* ============ 1.2 崩溃自显 / 公共日志 / 老 WebView（2.0.5） ============ */
check('安卓启动异常不再闪退且诊断可见', () => {
  const java = read('android/app/src/main/java/com/rhua/expressstation/MainActivity.java');
  assert.ok(java.includes('catch (Throwable t)'), '启动链路没有兜住 Error 类异常');
  assert.ok(java.includes('private void showFatal('), '缺少原生诊断屏');
  assert.ok(java.includes('writePublicCrash('), '崩溃日志没写到用户可读目录');
  assert.ok(java.includes('private String recentFatal('), '上次崩溃不会自动进入诊断模式');
  assert.ok(java.includes('clearCrashLog()'), '确认后无法清除崩溃记录');
  assert.ok(java.includes('FATAL WebView 创建失败'), 'WebView 构造失败没有降级');
  assert.ok(java.includes('shouldInterceptRequest(WebView view, String url)'),
    'Android 5.x 只会回调旧重载，缺了会整页 404 白屏');
  assert.ok(java.includes('public String lastFatal()'), '原生桥没暴露最近崩溃');
  const mf = read('android/app/src/main/AndroidManifest.xml');
  assert.ok(mf.includes('@android:style/Theme.Material.Light.NoActionBar'),
    '应用主题仍依赖自定义 style，启动前有资源解析风险');
});

/* ============ 1.3 登录瞬间退出：按需渲染 + 渲染进程托管（2.0.5） ============ */
check('登录不再单帧重绘全部视图，原生接管渲染进程崩溃', () => {
  const app = read('app.js');
  assert.ok(app.includes('var RENDERERS = {'), '缺少视图渲染器映射');
  assert.ok(app.includes('function renderCurrent()'), '缺少按需渲染入口');
  assert.ok(!/renderDash\(\); renderInbound\(\); renderOutbound\(\);/.test(app),
    'renderAll 仍在一次性重绘全部视图，登录瞬间会打崩渲染进程');
  assert.ok(/function renderAll\(\) \{ renderCurrent\(\); \}/.test(app),
    '数据变更后没有收敛到当前视图');
  assert.ok(/setTimeout\(function \(\) \{\s*\n\s*if \(S\.view !== name\) return;/.test(app),
    '切视图仍在同帧同步渲染，老设备渲染进程可能被回收');

  const java = read('android/app/src/main/java/com/rhua/expressstation/MainActivity.java');
  assert.ok(java.includes('RenderProcessGoneDetail'), '没有引用渲染进程崩溃类型');
  assert.ok(java.includes('onRenderProcessGone('), '没有接管渲染进程崩溃');
  assert.ok(/onRenderProcessGone[\s\S]{0,2200}?return true;/.test(java),
    'onRenderProcessGone 必须返回 true，否则系统会直接杀进程');
  assert.ok(java.includes('private boolean openExternal('), '外链跳转没有收敛');
  assert.ok(java.includes('onPermissionRequest " + stackOf(t)'), '相机权限回调没有整体兜底');
});

/* ============ 1.4 点出库就退出：老 WebView 兼容 + 相机链路（2.0.5） ============ */
check('出库视图不再触发启动崩溃或自动开镜头', () => {
  const frontend = ['index.html', 'app.js', 'rules.js', 'ocr.js', 'db.js', 'auth.js', 'media.js'];
  frontend.forEach(f => {
    const t = read(f);
    assert.ok(!/querySelectorAll\([^)]*\)\.forEach/.test(t),
      f + ' 用了老 WebView 没有的 NodeList.forEach');
    assert.ok(!/\.closest\(/.test(t), f + ' 用了老 WebView 没有的 Element.closest');
    assert.ok(!/\.classList\./.test(t), f + ' 用了可能缺失的 classList');
  });
  const app = read('app.js');
  assert.ok(app.includes('function each(') && app.includes('function closestData('),
    '缺少 ES5 DOM 兼容 helper');
  assert.ok(app.includes('function safeChain('), '异步链没有兜住 unhandledrejection');
  assert.ok(!/if \(name === 'outbound' && store\.settings\(\)\.autoCapture/.test(app),
    '进入出库页仍会自动开镜头');
  assert.ok(app.includes('S.manualCaptureUsed'), '连续取件自动开镜头没有用户手势前置条件');
  assert.ok(/var cap = set\.safeMode \? 10 : 20;/.test(app) && /limit: cap/.test(app),
    '出库表格没有降峰或没有按查询状态门控');
  assert.ok(/autoCapture:\s*false/.test(read('rules.js')), '默认设置仍在自动开镜头');
  assert.ok(read('index.html').includes('输入货号后点「查询」'), '出库页文案没同步');

  const media = read('media.js');
  assert.ok(media.includes('function closestAct('), '相机面板仍依赖 Element.closest');
  assert.ok(media.includes('if (!closed && !settled) finish(true)'), '相机预览没有超时收尾');
  assert.ok(media.includes('typeof p.then !=='), 'getUserMedia 返回值没有判空');
  assert.ok(media.includes('var engCache = null'), '识别引擎每次渲染都重新探测');

  const java = read('android/app/src/main/java/com/rhua/expressstation/MainActivity.java');
  assert.ok(java.includes('postDelayed'), '相机权限请求没有超时拒绝');
  assert.ok(java.includes('results != null'), '权限回调结果没有判空');
  assert.ok(java.includes('lastHash'), '渲染进程重建后没有恢复当前视图');
  assert.ok(java.includes('activityGone()'), 'Activity 已结束时没有直接拒绝权限');
  assert.ok(read('README.md').includes('点出库就退出'), '文档没写本轮修复说明');
});

/* ============ 1.4 2.0.5 缓存隔离 / 出库零渲染 / 步骤日志 ============ */
check('点出库就死：缓存隔离、零渲染、步骤日志', () => {
  const java = read('android/app/src/main/java/com/rhua/expressstation/MainActivity.java');
  assert.ok(java.includes('index.html?v=2.3.0'), '入口 URL 没带版本号，可能命中旧主文档缓存');
  assert.ok(java.includes('web.clearCache(true)'), '启动没有清资源缓存');
  assert.ok(java.includes('WebSettings.LOAD_NO_CACHE'), '没有关闭磁盘缓存');
  assert.ok(java.includes('no-store, no-cache, must-revalidate'), 'assets 响应仍允许缓存');
  assert.ok(java.includes('public void logStep('), '原生桥缺少步骤日志');
  assert.ok(java.includes('public void setView('), '原生桥没记住当前视图');
  assert.ok(java.includes('mirrorPublicLog('), '步骤日志没有镜像到公共下载目录');
  assert.ok(java.includes('驿站助手-运行日志.txt'), '没有固定文件名的公共运行日志');

  const app = read('app.js');
  assert.ok(!/history\.replaceState\s*\(/.test(app), '仍在改 URL，老 WebView 会当成导航');
  assert.ok(app.includes('function step(') && app.includes('StationNative.logStep'), '页面没写步骤日志');
  assert.ok(app.includes('function exportRunLog('), '缺少一键导出运行日志');
  assert.ok(app.includes('outQueried: false'), '出库页默认仍在列出在库包裹');
  assert.ok(/S\.outQueried\s*\?\s*store\.listParcels/.test(app), '出库渲染没有按查询状态门控');
  assert.ok(app.includes('setTimeout(function () {\n      if (S.view !== name) return;'), '切视图仍在同帧渲染');
  assert.ok(app.includes('function updateOutSelection('), '勾选仍会整表重绘');
  assert.ok(app.includes('safeMode'), '没有老设备兼容模式');

  const h = read('index.html');
  assert.ok(h.includes('no-cache, no-store, must-revalidate'), '页面缺少 no-store meta');
  assert.ok(h.includes('id="gateVersion"') && h.includes('build 20'), '登录门没有版本自证');
  assert.ok(h.includes('id="gateSafeMode"') && h.includes('id="btnExportLog"'), '缺少兼容模式 / 导出日志入口');
  assert.ok(read('README.md').includes('## 十、2.0.5'), 'README 没有 2.0.5 修复说明');
});

/* ================= 2. 通知能力：源码里确实实现了短信 / 电话 ================= */
check('业务代码实现短信 / 电话 / 群呼能力', () => {
  const js = read('notify.js'), java = read('android/app/src/main/java/com/rhua/expressstation/MainActivity.java');
  const html = read('index.html'), app = read('app.js');
  assert.ok(/sms:/.test(js) && /tel:/.test(js), '缺少系统意图通道');
  assert.ok(js.includes('function sendSmsBatch(') && js.includes('function retryFailed('), '缺少群发 / 失败重发');
  assert.ok(js.includes('function oneCall(') && js.includes('function runGroup('), '缺少拨号 / 群呼');
  assert.ok(js.includes('function quietBlocked(') && js.includes("confirmBox('确认发送短信'"), '缺少免打扰 / 二次确认');
  assert.ok(js.includes('onReceipt'), '缺少短信回执');
  assert.ok(java.includes('SmsManager') && java.includes('ACTION_CALL') && java.includes('ACTION_SENDTO'), '原生桥没有真实发送 / 拨号能力');
  assert.ok(java.includes('StationNotifyNative') && java.includes('sendMultipartTextMessage'), '原生桥没接通');
  assert.ok(java.includes('READ_CALL_LOG') && java.includes('CallLog.Calls'), '缺少系统通话记录读取');
  assert.ok(html.includes('id="view-notify"') && html.includes('id="view-sms"') && html.includes('id="view-calls"'), '缺少三个通知视图');
  assert.ok(app.includes("act.indexOf('n-') === 0") && app.includes('window.StationNotify.init('), '通知模块没有接线');
});
check('帮助页逐条列出已实现功能与边界限制', () => {
  const app = read('app.js');
  assert.ok(/var HELP_FEATURES = \[/.test(app) && /var HELP_EXCLUDED = \[/.test(app));
  const seg = app.slice(app.indexOf('var HELP_FEATURES'), app.indexOf('function renderHelp'));
  ['拍照取件', '移库', '客户管理', '业务统计', '货号标签', '入库拦截'].forEach(k => {
    assert.ok(seg.includes(k), '功能清单漏了 ' + k);
  });
  ['短信通知', '电话通知', '通知中心', '微信取件'].forEach(k => {
    assert.ok(seg.includes(k), '功能清单漏了通知能力 ' + k);
  });
  ['发送通道与权限', '发送安全限制', '微信通知（本机等价）', '运营商与服务端能力'].forEach(k => {
    assert.ok(seg.includes(k), '边界说明漏了 ' + k);
  });
  ['出库任务', '驿站档案', '账本资费', '服务中心'].forEach(k => {
    assert.ok(seg.includes(k), '功能清单漏了新增视图 ' + k);
  });
  assert.ok(!seg.includes('商业与硬件'), '充值 / 账单等已补齐，不应再列为不做');
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
check('条码清洗：过滤网址 / 年份 / 过短串，条码优先于印刷数字', () => {
  assert.strictEqual(R.cleanBarcode('https://example.com/x'), '');
  assert.strictEqual(R.cleanBarcode('2026'), '');
  assert.strictEqual(R.cleanBarcode('abc'), '');
  assert.strictEqual(R.cleanBarcode('YT 9000 0123 45'), 'YT9000012345');
  /* 2.3.0：真正解出的条码优先，不能再拿更长的印刷数字串去命名 / 匹配 */
  const info = R.detectedInfo({ barcodes: ['YT900001'], texts: ['ZT7700000012', '8000'] });
  assert.strictEqual(info.code, 'YT900001');
  assert.strictEqual(info.from, 'barcode');
  assert.strictEqual(R.barcodeOf({ barcodes: ['YT900001'], texts: ['ZT7700000012'] }), 'YT900001');
  const dig = R.detectedInfo({ barcodes: [], texts: ['9000012345'] });
  assert.strictEqual(dig.code, '9000012345');
  assert.strictEqual(dig.from, 'digits');
  assert.strictEqual(R.barcodeOf({ barcodes: [], texts: [] }), '');
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
  assert.strictEqual(d.build, '2.3.0');
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
check('README 写明功能对照、通知实现与数据边界', () => {
  const md = read('README.md');
  ['2.3.0', '短信', '电话', '群呼', 'SEND_SMS', 'CALL_PHONE', '重建', '备份', 'IndexedDB', 'Code39', 'OCR'].forEach(k => {
    assert.ok(md.includes(k), 'README 漏了 ' + k);
  });
});
check('仓库无敏感凭据', () => {
  const files = ['index.html', 'app.js', 'rules.js', 'ocr.js', 'db.js', 'auth.js', 'media.js', 'sw.js', 'README.md'];
  const bad = /ghp_[A-Za-z0-9]{20}|"access_token"\s*:\s*"[A-Za-z0-9]{20}|refresh_token\s*[:=]\s*"[A-Za-z0-9]{20}|-----BEGIN [A-Z ]+PRIVATE KEY-----/;
  files.forEach(f => assert.ok(!bad.test(read(f)), f + ' 含疑似凭据'));
});

/* ================= 7. 离线 OCR / 条码识别（2.1.0） ================= */
function syntheticBarcode(mods, scale, h) {
  const pad = 24, w = mods.length * scale + pad * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4; data[k] = 246; data[k + 1] = 246; data[k + 2] = 246; data[k + 3] = 255;
  }
  for (let y = 16; y < h - 16; y++) {
    for (let x = pad; x < pad + mods.length * scale; x++) {
      if (!mods[Math.floor((x - pad) / scale)]) continue;
      const k = (y * w + x) * 4; data[k] = 8; data[k + 1] = 8; data[k + 2] = 8;
    }
  }
  return { width: w, height: h, data: data };
}
function syntheticDigits(str) {
  const t = OCR.templates(), glyph = [];
  for (const ch of str) {
    for (let i = 0; i < t.length; i++) {
      if (String(t[i].digit) === ch) { glyph.push(t[i].bits.slice()); break; }
    }
  }
  const GW = 10, GH = 14, sc = 2, cw = GW * sc, gap = 6;
  const w = glyph.length * (cw + gap) + 20, h = GH * sc + 20;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const k = i * 4; data[k] = 246; data[k + 1] = 246; data[k + 2] = 246; data[k + 3] = 255;
  }
  glyph.forEach((b, gi) => {
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      if (!b[y * GW + x]) continue;
      for (let dy = 0; dy < sc; dy++) for (let dx = 0; dx < sc; dx++) {
        const px = 10 + gi * (cw + gap) + x * sc + dx, py = 10 + y * sc + dy;
        const k = (py * w + px) * 4; data[k] = 8; data[k + 1] = 8; data[k + 2] = 8;
      }
    }
  });
  return { width: w, height: h, data: data };
}
check('OCR：四种码制编码 → 解码往返', () => {
  ['123456789012', 'YT9000012345', '780012345678', 'SF1234567890'].forEach(t => {
    assert.strictEqual(OCR.decode.code128(OCR.modulesToRuns(OCR.encodeCode128(t))), t, 'Code128 ' + t);
  });
  ['A12345', 'YT9000'].forEach(t => {
    assert.strictEqual(OCR.decode.code39(OCR.modulesToRuns(OCR.encodeCode39(t))), t, 'Code39 ' + t);
  });
  assert.strictEqual(OCR.decode.ean(OCR.modulesToRuns(OCR.encodeEAN13('6901234567892'))), '6901234567892');
  ['12345670', '98765432'].forEach(t => {
    assert.strictEqual(OCR.decode.itf(OCR.modulesToRuns(OCR.encodeITF(t))), t, 'ITF ' + t);
  });
});
check('OCR：合成条码照片端到端识别（含噪点）', () => {
  const cases = [
    ['Code128', OCR.encodeCode128('YT9000012345'), 'YT9000012345'],
    ['Code39', OCR.encodeCode39('A12345'), 'A12345'],
    ['EAN13', OCR.encodeEAN13('6901234567892'), '6901234567892'],
    ['ITF', OCR.encodeITF('12345670'), '12345670']
  ];
  cases.forEach(([name, mods, want]) => {
    const r = OCR.scanCanvas(syntheticBarcode(mods, 3, 90));
    assert.ok(r.barcodes.indexOf(want) >= 0, name + ' 未识别：' + JSON.stringify(r.barcodes));
    assert.strictEqual(r.supported, true);
    assert.ok(r.engine.indexOf('离线条码') >= 0, '引擎标注不对：' + r.engine);
    assert.ok(r.confidence > 0.8);
  });
  /* 确定性伪随机噪点，模拟照片颗粒 */
  const im = syntheticBarcode(OCR.encodeCode128('780012345678'), 3, 90);
  let seed = 42;
  for (let i = 0; i < 600; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = seed % im.width;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const y = seed % im.height;
    const k = (y * im.width + x) * 4;
    im.data[k] = 200; im.data[k + 1] = 200; im.data[k + 2] = 200;
  }
  const noisy = OCR.scanCanvas(im);
  assert.ok(noisy.barcodes.indexOf('780012345678') >= 0, '带噪点识别失败：' + JSON.stringify(noisy.barcodes));
});
check('OCR：印刷数字识别与误报过滤', () => {
  ['1234', '902381', '6688', '135790'].forEach(s => {
    const r = OCR.scanCanvas(syntheticDigits(s));
    assert.ok(r.texts.indexOf(s) >= 0, '数字 ' + s + ' 未识别：' + JSON.stringify(r.texts));
  });
  assert.strictEqual(OCR.junkDigitString('111111111111'), true, '条码竖线误报没过滤');
  assert.strictEqual(OCR.junkDigitString('123'), true, '过短串没过滤');
  assert.strictEqual(OCR.junkDigitString('902381'), false);
  const r = OCR.scanCanvas(syntheticBarcode(OCR.encodeCode128('YT9000012345'), 3, 90));
  assert.ok(!r.texts.some(t => t.length > 20), '条码被误读成超长数字串');
});
check('识别链路：原生 + 离线双通道，永不 reject', () => {
  const m = read('media.js');
  assert.ok(m.includes("require('./ocr.js')"), 'media.js 没有加载离线引擎');
  assert.ok(m.includes('OCR.scanCanvas(') && m.includes('function nativeOf('), '缺少双通道');
  assert.ok(m.includes('|| 2400'), '离线识别没有耗时上限');
  assert.ok(m.includes('function finish('), '缺少结果收口');
  assert.ok(m.includes('function liveScan(') && m.includes('function liveTick('), '缺少预览连续自动识别');
  assert.ok(m.includes('autoShootOnHit') && m.includes('stopLive()'), '命中后没有自动拍照 / 没有清理定时器');
  assert.strictEqual(typeof Media.liveScan, 'function');
  assert.ok(!m.includes('当前浏览器不支持本机识别'), '仍在无原生 API 时直接放弃识别');
  const e = Media.engines();
  assert.strictEqual(e.offline, true, '离线引擎没有标记为可用');
  const app = read('app.js');
  assert.ok(app.includes('d.engine') && app.includes('d.confidence'), '界面没有显示引擎 / 置信度');
  assert.ok(app.includes('ocr: window.StationOcr'), '自检没有暴露 OCR 引擎');
  assert.ok(app.includes('拍照取件：开镜头后连续自动识别'), '出库页没有说明连续自动识别');
  assert.ok(app.includes('R.detectedInfo') && app.includes("info.from === 'digits'"), '界面没有区分印刷数字兜底');
  assert.ok(app.includes('live: !store.settings().safeMode'), '拍照入口没有开启预览识别');
});
check('OCR：不联网、不上传，且兼容老 WebView', () => {
  const src = read('ocr.js');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|upload/.test(src), 'OCR 出现联网 / 上传调用');
  assert.ok(!/\bfetch\b|\.closest\(|\.classList\.|\.findIndex\(|querySelectorAll\([^)]*\)\.forEach/.test(src));
  assert.ok(!/\b(let|const|class)\s/.test(src), 'ocr.js 必须保持 ES5 语法');
  assert.ok(src.includes('Date.now() > deadline'), '缺少耗时截止检查');
  assert.ok(src.includes('function despeckle(') && src.includes('function denoiseRuns('), '缺少去噪');
  assert.ok(src.includes('function scanSkew(') && src.includes('function shearBinary(')
    && src.includes('function stretchGray(') && src.includes('function upscaleGrayBand('),
    '2.3.0 多通道识别缺失');
  assert.ok(src.includes('corroborate(') && src.includes('verified'), '缺少校验位优先 / 印刷数字互证');
});
check('OCR：真实面单 17 场景识别率与零误报', () => {
  const r = Scenarios.run(OCR);
  assert.ok(r.pass >= 16, '通过场景不足 ' + r.pass + '/' + r.total + '：' +
    JSON.stringify(r.details.filter(d => !d.ok).map(d => d.name)));
  assert.strictEqual(r.wrong, 0, '输出了错误条码：' + JSON.stringify(r.wrongCodes));
});

/* ============ 8. 2.1.0 功能对齐：任务 / 档案 / 账本 / 服务 / 二维码 ============ */
check('二维码：编码、SVG 与矩阵解码往返', () => {
  ['A01010023', 'YT9000012345', '902381', 'https://example.com/p/123', '驿站取件码 A-3-12'].forEach(t => {
    const r = QR.encode(t);
    assert.ok(r && r.version >= 1 && r.version <= 5, '没有生成合法版本');
    assert.strictEqual(QR.decodeMatrix(r.modules), t);
    assert.ok(QR.svg(t).indexOf('<svg') === 0, 'SVG 生成失败');
  });
});
check('二维码：图像定位解码与空白图不误报', () => {
  const t = 'YT9000012345', r = QR.encode(t);
  assert.strictEqual(QR.decodeImage(QR.modulesToImage(r, 5, 4)), t);
  const blank = { width: 180, height: 180, data: new Uint8ClampedArray(180 * 180 * 4).fill(250) };
  assert.strictEqual(QR.decodeImage(blank), null);
});
check('二维码：零依赖、ES5、不联网', () => {
  const src = read('qr.js');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(src), '二维码模块出现联网调用');
  assert.ok(!/\b(let|const|class)\s|=>|\.closest\(|\.classList\.|querySelectorAll\([^)]*\)\.forEach/.test(src),
    'qr.js 必须保持 ES5 且不依赖老 WebView 缺失的 API');
});
check('媒体识别接入离线二维码通道', () => {
  const m = read('media.js');
  assert.ok(m.includes("require('./qr.js')") && m.includes('QR.decodeImage('));
  assert.ok(m.includes('离线 QR'), '识别结果没有标注二维码引擎');
});
check('标签支持二维码字段', () => {
  const html = R.labelHTML({ goodsNo: 'A1', trackingNo: 'YT123456' }, R.DEFAULT_SETTINGS, ['qrcode', 'goods']);
  assert.ok(html.includes('<svg') && html.includes('A1'));
  assert.ok(read('app.js').includes("['qrcode', '二维码']"), '打印页没有二维码勾选项');
});
check('扩展数据模型：默认结构、归一化与备份恢复', () => {
  const d = DB.defaultDB();
  ['tasks', 'feedbacks', 'templates', 'queryHistory', 'activities', 'notices'].forEach(k => {
    assert.ok(Array.isArray(d.extras[k]), '缺扩展表 ' + k);
  });
  assert.ok(d.extras.station && d.extras.wallet && Array.isArray(d.extras.wallet.records));
  const st = fresh();
  st.raw().extras.tasks.push({ id: 'tk1', name: '晚高峰', ids: [], status: 'open', at: new Date().toISOString() });
  st.save();
  const snap = st.exportSnapshot();
  const st2 = DB.createStore(DB.memoryStorage(), '测试员');
  assert.ok(st2.restoreSnapshot(snap, 'merge').ok);
  assert.ok(st2.raw().extras.tasks.some(t => t.id === 'tk1'), '备份合并丢了出库任务');
  assert.ok(st2.restoreSnapshot(snap, 'cover').ok, '备份覆盖恢复失败');
});
check('权限表扩展到 20 项并含通知权限', () => {
  ['tasks', 'station', 'wallet', 'service', 'notify', 'sms', 'calls', 'wechat'].forEach(p => {
    assert.ok(Auth.PERMS.indexOf(p) >= 0, '缺权限 ' + p);
  });
  assert.strictEqual(Auth.PERMS.length, 20);
  assert.ok(Auth.OPERATOR_DEFAULT.indexOf('sms') >= 0, '操作员默认不能发短信');
  assert.ok(Auth.VIEWER_DEFAULT.indexOf('sms') < 0, '只读角色不应有发送权限');
});
check('四个新视图已接线（导航 / 渲染 / 事件转发 / 初始化）', () => {
  const h = read('index.html'), a = read('app.js');
  ['tasks', 'station', 'wallet', 'service'].forEach(v => {
    assert.ok(h.includes('id="view-' + v + '"') && h.includes('data-view="' + v + '"'), '缺视图 ' + v);
    assert.ok(a.includes("exRender('" + v + "')"), '渲染器漏了 ' + v);
  });
  assert.ok(a.includes("act.indexOf('x-') === 0") && a.includes('window.StationExtras.action'));
  assert.ok(a.includes('window.StationExtras.init('), '扩展模块没有初始化');
  assert.ok(a.includes('extras: window.StationExtras'), '自检没有暴露扩展模块');
});
check('扩展模块：ES5、零联网、按需渲染与内容', () => {
  const src = read('extras.js');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|tel:|sms:/.test(src), '扩展模块出现联网 / 通知调用');
  assert.ok(!/\b(let|const|class)\s|=>|\.closest\(|\.classList\.|querySelectorAll\([^)]*\)\.forEach/.test(src),
    'extras.js 必须保持 ES5');
  assert.ok(src.includes("document.addEventListener('change'") && src.includes('function render(name)'));
  assert.ok(Extras.FAQ.length >= 10 && Extras.GUIDE.length >= 5);
  ['action', 'fillTemplates', 'recordQuery', 'renderQueryHistory'].forEach(k => {
    assert.strictEqual(typeof Extras[k], 'function', '缺导出 ' + k);
  });
});
check('原版细节：隐号面单 / 查询历史 / 语音 / 记住账号 / 忘记密码 / 同步明细', () => {
  const h = read('index.html'), a = read('app.js'), d = read('db.js');
  assert.ok(h.includes('id="inHidden"') && a.includes('hiddenPhone:') && d.includes('hiddenPhone: !!p.hiddenPhone'));
  assert.ok(h.includes('id="qHistory"') && h.includes('id="btnQueryVoice"'));
  assert.ok(a.includes('recordQuery()') && a.includes('Media.listen()'));
  assert.ok(h.includes('id="loginRemember"') && a.includes('station.remember.name'));
  assert.ok(h.includes('id="btnForgotPw"') && h.includes('id="btnSyncPending"'));
  assert.ok(a.includes('syncDelayInfo') && a.includes('st.delayUpload'));
});
check('打印模板管理接线', () => {
  const h = read('index.html'), a = read('app.js'), e = read('extras.js');
  assert.ok(h.includes('id="tplSelect"') && h.includes('x-tplSave') && h.includes('x-tplDel'));
  assert.ok(a.includes('fillTemplates()') && e.includes('function tplApply('));
});
check('通知能力已接通，且不引入第三方联网通知接口', () => {
  const src = read('notify.js');
  ['sms:', 'tel:', 'StationNotifyNative', 'sendSms', 'onReceipt', 'requestPerms'].forEach(k => {
    assert.ok(src.includes(k), '通知引擎缺少 ' + k);
  });
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|api\.[a-z0-9-]+\.com/.test(src),
    '通知引擎出现联网接口：号码与内容必须只走本机 / 系统应用');
  const mf = read('android/app/src/main/AndroidManifest.xml');
  ['SEND_SMS', 'CALL_PHONE', 'READ_CALL_LOG'].forEach(p => {
    assert.ok(mf.includes('android.permission.' + p), '清单缺权限 ' + p);
  });
});
check('README 记录 2.1.0 功能对齐与 2.3.0 通知实现', () => {
  const md = read('README.md');
  assert.ok(md.includes('## 十二、2.1.0'), 'README 没有 2.1.0 章节');
  assert.ok(md.includes('## 十三、2.2.0'), 'README 没有 2.2.0 通知章节');
  assert.ok(md.includes('## 十四、2.3.0'), 'README 没有 2.3.0 条码识别章节');
  ['出库任务', '驿站档案', '账本资费', '服务中心', '二维码', '短信群发', '电话通知', '通知中心'].forEach(k => {
    assert.ok(md.includes(k), 'README 漏了 ' + k);
  });
});

/* ============ 9. 2.3.0 通知能力：引擎 / 数据 / 接线 / 原生桥 ============ */
check('通知引擎：变量、分段、号码校验与内置模板', () => {
  ['init', 'render', 'action', 'onReceipt', 'permState', 'renderText', 'segments', 'phoneOK'].forEach(k => {
    assert.strictEqual(typeof Notify[k], 'function', '缺导出 ' + k);
  });
  assert.ok(Notify.BUILTIN.length >= 8 && Notify.VAR_DESC.length >= 10);
  const t = Notify.renderText('{sign}{name}/{goods}/{slot}/{code}', {
    sign: '【驿站】', name: '张三', goods: 'A01010023', slot: 'A-3', code: '1234'
  });
  assert.strictEqual(t, '【驿站】张三/A01010023/A-3/1234');
  assert.strictEqual(Notify.renderText('{a}{b}', { a: '1' }), '1');
  assert.strictEqual(Notify.segments('x'.repeat(70)), 1);
  assert.strictEqual(Notify.segments('x'.repeat(140)), 3);
  assert.strictEqual(Notify.phoneOK('138 0013-8000'), '13800138000');
  assert.strictEqual(Notify.phoneOK('123'), '');
});
check('通知数据模型纳入持久化与备份合并', () => {
  const st = fresh(), n = st.raw().extras.notify;
  assert.ok(n && n.settings && Array.isArray(n.templates) && Array.isArray(n.history) &&
    Array.isArray(n.calls) && Array.isArray(n.queue) && n.counters);
  assert.strictEqual(n.settings.channel, 'system', '默认必须是系统通道');
  assert.strictEqual(n.settings.autoSend, false, '默认不允许自动直发');
  assert.ok(n.settings.quietOn && n.settings.batchLimit === 50 && n.settings.dayLimit === 500);
  n.history.push({ id: 'nh1', kind: 'sms', phone: '13800138000', at: new Date().toISOString() });
  n.templates.push({ id: 'tplX', name: '自定义', kind: 'sms', body: '{name}' });
  st.save();
  const snap = st.exportSnapshot();
  const st2 = DB.createStore(DB.memoryStorage(), '测试员');
  st2.raw().extras.notify.settings.channel = 'native';
  assert.ok(st2.restoreSnapshot(snap, 'merge').ok, '备份合并失败');
  assert.ok(st2.raw().extras.notify.history.some(h => h.id === 'nh1'), '合并丢了通知流水');
  assert.ok(st2.raw().extras.notify.templates.some(t => t.id === 'tplX'), '合并丢了通知模板');
  assert.strictEqual(st2.raw().extras.notify.settings.channel, 'native', '合并模式不应覆盖本机通知配置');
  assert.ok(st2.restoreSnapshot(snap, 'merge').ok, '重复合并失败');
  assert.strictEqual(st2.raw().extras.notify.history.filter(h => h.id === 'nh1').length, 1, '合并没有按 id 去重');
  assert.ok(st2.restoreSnapshot(snap, 'cover').ok, '备份覆盖恢复失败');
});
check('通知引擎：ES5、按需渲染、不联网', () => {
  const src = read('notify.js');
  assert.ok(!/\b(let|const|class)\s|=>|\.closest\(|\.classList\.|querySelectorAll\([^)]*\)\.forEach/.test(src),
    'notify.js 必须保持 ES5');
  assert.ok(!/fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon/.test(src), 'notify.js 出现联网调用');
  assert.ok(src.includes("document.addEventListener('change'") && src.includes('function render(name)'));
  assert.ok(src.includes("document.addEventListener('submit'"), '缺表单委托');
});
check('三视图接线：导航 / 渲染器 / 动作分发 / 初始化 / 导出', () => {
  const h = read('index.html'), a = read('app.js');
  ['notify', 'sms', 'calls'].forEach(v => {
    assert.ok(h.includes('id="view-' + v + '"') && h.includes('data-view="' + v + '"'), '缺视图 ' + v);
    assert.ok(a.includes("ntRender('" + v + "')"), '渲染器漏了 ' + v);
    assert.ok(a.includes(v + ": '"), '标题漏了 ' + v);
  });
  assert.ok(a.includes("act.indexOf('n-') === 0") && a.includes('window.StationNotify.action'));
  assert.ok(a.includes('window.StationNotify.init('), '通知模块没有初始化');
  assert.ok(a.includes('notify: window.StationNotify'), '自检没有暴露通知模块');
  ['ntSetChannel', 'smsTemplate', 'smsPreviewBox', 'callQueueBox', 'ntHistoryTable', 'callLogTable', 'ntQrBox'].forEach(id => {
    assert.ok(h.includes('id="' + id + '"'), '缺 DOM ' + id);
  });
});
check('发送安全：二次确认、免打扰、限额与回执', () => {
  const src = read('notify.js');
  ["confirmBox('确认发送短信'", 'quietBlocked()', 'batchLimit', 'dayLimit',
    'onReceipt', 'retryFailed', "permState()", "cfg().channel === 'native'"].forEach(k => {
      assert.ok(src.includes(k), '缺少安全机制 ' + k);
    });
  assert.ok(src.includes('function openSmsSystem(') && src.includes('function dialNumber('), '缺系统意图通道');
});
check('原生通知桥：直发 / 回执 / 直拨 / 通话记录 / 权限申请', () => {
  const java = read('android/app/src/main/java/com/rhua/expressstation/MainActivity.java');
  ['class NotifyBridge', 'StationNotifyNative', 'sendSmsNow', 'sendMultipartTextMessage',
    'SmsManager.getDefault()', 'SMS_SENT', 'SMS_DELIVERED', 'receipt(', 'registerSmsReceiver',
    'ACTION_CALL', 'ACTION_DIAL', 'ACTION_SENDTO', 'callLog(', 'missedCalls(',
    'readSystemCallLog', 'requestNotifyPerms', 'REQ_NOTIFY_PERM', 'speakNow',
    'TextToSpeech', 'Context.RECEIVER_NOT_EXPORTED'].forEach(k => {
      assert.ok(java.includes(k), '原生桥缺少 ' + k);
    });
  assert.ok(java.includes('"tel".equalsIgnoreCase(scheme)'), 'URL 拦截没放行 tel:');
  assert.ok(java.includes('"sms".equalsIgnoreCase(scheme)'), 'URL 拦截没放行 sms:');
  assert.ok(java.includes('unregisterReceiver(smsReceiver)'), 'onDestroy 没有注销回执接收器');
});
check('权限标签与角色默认值覆盖通知', () => {
  const a = read('app.js');
  ['notify: \'通知中心\'', 'sms: \'短信发送\'', 'calls: \'电话通知\'', 'wechat: \'微信取件\''].forEach(k => {
    assert.ok(a.includes(k), '权限中文标签漏了 ' + k);
  });
});

/* ================= 结果 ================= */
console.log('\n驿站助手 2.3.0 · 回归测试');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (failures.length) {
  console.log('\n失败明细：');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
