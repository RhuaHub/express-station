# 驿站助手（重建版 2.1.0）

对照 `570665.apk`（`com.touchez.mossp.ezhelper`，2021 年版「驿站助手」）**从零重建**的快递驿站管理系统。纯静态、零依赖、零后端：台账存浏览器 localStorage，照片存 IndexedDB，不上传任何服务器。

> **以前的作废**：1.1.0 及之前的实现全部废弃、不复用一行代码。旧代码留在 git 标签 `archive/pre-rebuild-1.1.0`，可随时 `git show` 查看，但新版本不加载、不兼容旧前端文件。
> **按需求整块排除**：短信、电话、群呼及一切对外通知发送能力。**除此之外功能要与原版一样**：2.1.0 重新逐项审计 APK 的 160 个组件、873 条业务文案与 33 个 H5 页面，补齐了「出库任务 / 代收档案 / 账本资费 / 服务中心 / 二维码」等整块缺失页面。确实需要支付、服务端合作、实名核验或厂商 SDK 的部分，一律做成本机等价实现并明确标注，不会假装已联网完成。

---

## 一、功能对照表

| 原版功能（Activity / 页面） | 重建版实现 |
| --- | --- |
| `PutInPack` 手动入库、公司自动识别、货架号、编号、货号、备注 | 入库页「手动入库」：单号自动识别公司（规则可编辑），自动分配货架 / 编号 / 货号，支持自定义、标签、件数、备注、照片 |
| `QuickPutIn` 极速入库、`SuppleMent` 补录号码 | 「极速入库」扫单号回车即入库 + 尾号；「补录号码」批量补齐未识别号码 |
| `ExpressCodeImport` / `ScannerImport` 单号导入、`NumImport` 号码导入 | 「批量导入」粘贴 / CSV 逐行解析，失败行回留；客户管理里号码批量导入、去重、导出 |
| `ScanPack` 扫码入库、`CaptureScanID` 条码识别 | 「扫码枪连录」回车连录；拍照用浏览器原生 `BarcodeDetector` / `TextDetector` 识别条码，**按条码命名照片** |
| `PutOutPack` 取件出库、`MergePutOut` 合并出库 | 出库页五种模式 + 合并出库（同尾号一键合并）+ 批次凭证 + 取件人 / 出库备注 |
| `ScanCode` 扫描出库、`QueryPack` 货号 / 电话 / 编号查询 | 「扫描出库」回车即出，一码多件只列候选不自动出库；查件页 8 个条件组合查询 |
| `ReFundPack` 退件出库、退件原因 | 退件模式：必选原因（超期未取 / 拒收 / 地址不详…），独立计入统计与流水 |
| `PackDetail`、`ModifyPack`、`QueryPackHistory` 详情 / 修改 / 历史 | 详情弹窗 20 个字段、修改弹窗、操作流水、每次状态变更留 `history` |
| `ExpreeLabel` 快递标签、`PrintDevice/Setting/Template` 打印设置 | 货号标签：12 个字段可勾选、纸张尺寸、Code39 可扫条码、批量打印（系统 `window.print()`） |
| `ShelfNum` 货架号管理、`TransferExpress` 移库 | 设置里货架区 / 货架数 / 层数；台账「移库」换货架并可重算货号，留移库流水 |
| `MarkCustom` 客户管理、VIP / 黑名单 / 星标 | 客户按尾号自动归档，普通 / VIP / 老客户 / 黑名单、红黑绿星、备注、累计件数、号码导入导出 |
| `AddInterceptMailNum` 入库拦截 | 黑名单禁止入库 + 单号拦截名单 + 按天数自动清理 |
| `CompanyMange` 快递公司管理、单号识别规则 | 公司列表启停、简称、正则识别规则增删改 |
| `BusinessStatistics` 出库率 / 工作量统计、每日明细 | 13 种时间范围（今天 / 昨天 / 三天 / 一周 / 两周 / 一两三月 / 本周月 / 上月 / 全部 / 自定义），出库率、按操作人工作量、每日明细与 CSV |
| `SynData` 数据同步 / 上传记录 / 重新上传 | 「同步记录」本地等价实现：记录每条入库 / 出库 / 退件，状态标记、重新标记、导出上行 CSV（**不假装已上传**） |
| `CollectionRegist/List/Result` 收件（寄件）任务 | 收件任务：寄收件人、地址、公司、重量、费用，待取 → 已取 → 已发出 → 完成 |
| `SubAccount` 子账号、`AccountInit` 账号初始化 | 站长初始化（不开放注册）、主子账号、逐项权限（12 项）、改密、闲置锁屏、登录失败限速 |
| `EZSetting` / `PutInSetting` / `PutOutSetting` / `PickOutSetting` | 设置页四组：驿站信息、编号货号规则、录入查询模式、声音 / 振动 / 语音 / 补光灯 / 拍照 / 拦截 / 同步 |
| 入库出库声音 / 振动 / 语音提醒、出库拍照、手动 / 自动拍照 | 本机 WebAudio「嘀」声、`navigator.vibrate`、浏览器 TTS 播报、拍照模式与自动开镜头 |
| 查询模式：模糊 / 精确 / 尾号匹配、按状态 / 公司 / 时间筛选 | 查件页与出库页共用规则层打分查询 |
| 操作流水、数据备份与导出 | 全量流水（5000 条）、完整备份 JSON（含照片 base64）、恢复 / 合并、四类 CSV 导出 |
| `PickOutTask` 出库任务 / 待出库记录 | **出库任务**：按货号 / 单号 / 尾号筛选在库件 → 建任务 → 看明细 → 整批出库，任务状态留痕（2.1.0 补齐） |
| `StationInformation` / `ServiceItems` / `DelayLinkCompanySetting` | **驿站档案**：驿站名称地址、营业时间、代收登记、实名资料与门头 / 身份证照片（本机）、合作快递公司、服务项目、延迟上传策略（2.1.0 补齐） |
| `Recharge` / `Bill` / `tariff.html` / 替他人充值 / `EarnEntrance` | **账本资费**：余额、充值与替他人充值记录、按件数结算账单、资费说明、活动奖励、CSV 导出（本机记账，不接支付）（2.1.0 补齐） |
| `FAQ` / `Suggestions` / `ContactUs` / `UserGuide` / `Guide` / `About` / `Disclaimer` / `RateIntroductions` / `ContactUs` | **服务中心**：14 条 FAQ、6 步用户指南、意见反馈与回复、活动记录、关于 / 免责 / 联系方式（本机记录，不联网客服）（2.1.0 补齐） |
| `BarCodeScan` 扫描二维码 / 系统自动更新二维码 / 永久二维码海报 | **取件二维码**：本机生成二维码海报、货号标签可选二维码字段、拍照离线解二维码（2.1.0 补齐） |
| `PrintDevice` / `PrintTemplateSetting` 打印模板 | 打印模板可保存多套、随时切换 / 删除，字段含 Code39 条码与二维码，系统打印 |
| `HideCalleePutInPack` 隐号面单入库 | 手动入库可勾「隐号面单」，不强制录入手机号，详情里标明按货号 / 单号取件 |
| 语音录入 / 语音搜索、`QueryAction` 查询记录、`ImportAndExportNumber` | 查件页语音搜索、最近查询一键重查、客户号码批量导入导出 |
| `ForgetPassword` / 记住密码 / 子账号重置密码 | 登录门「记住账号」（不存密码）、「忘记密码」本机找回指引、站长在子账号页重置密码 |
| `UnUploadDetail` 未上传明细 / 延迟代收设置 | 同步记录页「仅看未上传」、延迟上传策略展示，导出上行 CSV |

**相对原版额外补齐**：拍照自动识别 → 自动选中在库件 → 凭证按货号命名；离线 OCR + 二维码解码（安卓 WebView 没有 `BarcodeDetector` 也能识别）；IndexedDB 照片本机缓存；PWA 离线壳；移动窄屏表格卡片化、触屏 16px 输入、软键盘安全区。
**注意**：进库 / 出库页**不会自动开摄像头**，拍照一律由用户点按钮触发（低端安卓 WebView 上自动调用 `getUserMedia` 会直接杀渲染进程）。

---

## 二、排除范围与本机等价实现

### 2.1 按需求整块排除（不做，也不假装做）

| 类别 | 具体功能 |
| --- | --- |
| **短信类** | 群发短信、短信模板 / 签名 / 审核、短信历史、失败短信提醒、扫码发短信、预约短信 |
| **电话通知类** | 直拨 / 回拨 / 隐私号、群呼、群呼历史、通话记录、未接来电、语音通知模板、隐藏号码模板 |
| **一切对外通知发送** | 微信 / 公众号消息推送、自动取件通知、消息推送通道：本版只在本机生成取件二维码与凭证，**不发送任何消息** |

代码里没有任何 `tel:` / `sms:` / 拨号 / 短信发送调用，安卓清单也没有 `SEND_SMS`、`CALL_PHONE`、`READ_CONTACTS` 权限；回归测试会扫描并断言这一点。

### 2.2 其余功能一律补齐，需要服务端的做成本机等价

| 原版能力 | 本版做法（可用，但不联网 / 不产生真实交易） |
| --- | --- |
| 充值 / 账单 / 资费 / 替他人充值 / 商城与活动奖励 | 「账本资费」本机记账、按件数结算、活动奖励流水，页面明确标注「不产生真实支付」 |
| 驿站代收开通 / 实名认证 / 门头与身份证上传 | 「驿站档案」本机登记代收状态，证件照片只存 IndexedDB，不做联网实名核验 |
| 物流数据上行 / 入库即代收 / 出库即签收 / 延迟上传 | 「同步记录」本机待上传状态、延迟策略、未上传明细、上行 CSV 导出，不真实上行 |
| 微信取件通知 / 码上取件 / 永久二维码海报 | 取件二维码海报与货号标签二维码本机生成，可打印、可拍照解码；不发送任何消息 |
| 在线客服 / 意见反馈 / FAQ / 用户指南 | 「服务中心」FAQ + 用户指南 + 本机反馈记录与回复、导出；不联网客服 |
| 蓝牙打印机厂商 SDK | 系统打印对话框（可选已配对蓝牙打印机）；标签含可扫码的 Code39 条码与二维码 |
| 云端 OCR / 讯飞百度在线语音引擎 | 内置离线 OCR（一维码 + 印刷数字）+ 二维码解码；语音用浏览器自带接口，不支持时跳过 |

---

## 三、文件结构

```
index.html            全部 18 个视图的页面骨架
styles.css            浅色暖金主题、移动端适配、打印样式
rules.js              纯函数规则层：公司识别、编号货号、批量解析、查询打分、时间范围、统计、Code39 条码、标签
ocr.js                离线 OCR 引擎：图像二值化 / 去噪、Code128 / EAN-13 / UPC-A / ITF / Code39 解码、印刷数字模板识别
qr.js                 离线二维码：版本 1~5 / 纠错 L 生成、格式信息定位与数字 / 字母数字 / 字节模式解码
db.js                 数据层：localStorage 持久化（禁用时降级内存）、包裹 / 客户 / 公司 / 流水 / 扩展数据 / 设置、备份恢复
auth.js               账号：SHA-256 加盐迭代、主子账号、16 项权限、锁屏与登录限速
media.js              拍照、原生 + 离线 OCR + 二维码三通道识别、IndexedDB 照片库、声音振动语音
extras.js             2.1.0 扩展视图逻辑：出库任务、驿站档案、账本资费、服务中心、打印模板、查询历史
app.js                UI 控制器：18 个视图按需渲染、全部交互、打印、备份、自检
sw.js                 PWA 壳缓存（版本号一变旧缓存整体失效）
manifest.webmanifest  PWA 清单
tests/smoke.js        回归测试
tools/serve.js        本地静态服务；tools/cdp-probe.js 真实浏览器探针
android/              WebView 壳与免 Gradle 打包脚本
```

数据模型：`parcels`（货号 / 编号 / 单号 / 公司 / 收件人 / 电话 / 隐号标记 / 货架 / 标签 / 状态 / 出入库时间 / 退件原因 / 照片引用 / 批次 / 操作员 / 同步状态 / 变更历史）、`customers`、`companies`、`labels`、`accounts`、`logs`、`uploads`、`collections`、`intercepts`、`counters`、`settings`，以及 `extras`（`station` / `tasks` / `wallet` / `feedbacks` / `templates` / `queryHistory` / `activities` / `notices`）——扩展数据同样纳入备份与恢复。

---

## 四、运行

### 网页 / PWA
```bash
node tools/serve.js 8765      # 打开 http://127.0.0.1:8765/index.html
```
部署到 Cloudflare Pages / GitHub Pages 后直接访问；`index.html#outbound` 可直接进入拍照取件，`#inbound` 进入入库。

### 安卓
```bash
bash android/build-apk.sh     # 产物 android/dist/station-assistant-2.1.0.apk
```
需要 JDK 17 与 Android SDK build-tools / platform。APK 用 `https://appassets.androidplatform.net/` 映射到 assets，保证摄像头、localStorage、IndexedDB 都运行在安全上下文里；首次使用需允许相机权限。

---

## 五、使用要点

1. **首次使用**：本机没有账号时登录页会显示「初始化本站（创建站长账号）」；子账号只能由站长在「子账号」页添加，不开放注册。
2. **换设备 / 换浏览器**：数据按站点来源隔离，不会自动同步。用「设置 → 数据备份」导出 JSON（默认含照片），在新设备登录页「从备份导入」或设置里「从备份恢复」。旧版 1.x 的备份也能导入（做字段映射）。
3. **编号 / 货号**：默认连续编号 + `货架号+编号`（如 `A01010023`）。设置里可切「每日重置 / 按货架分组 / 手机尾号」和五种货号模式，或写 `{slot}{serial}{date}{day}{short}{tail}{zone}` 自定义模板。货号结尾必须是数字。
4. **公司识别**：`圆通=^(YT|8\d{11,})` 这类正则可在「设置 → 快递公司管理」编辑，从上往下匹配，手动选择优先。
5. **拍照识别**：内置离线 OCR，不依赖 `BarcodeDetector`（安卓 WebView 基本没有）。对准面单条码拍照即可自动填运单号 / 匹配在库件并按码命名照片；没读到时照片按时间命名，手输单号照常出入库，不会假装识别成功。低置信度结果会提示核对。
6. **权限**：站长全权；操作员默认可用业务页但不能改设置与账号；只读角色仅查件 / 台账 / 统计 / 打印 / 流水。可逐项调整。
7. **版本缓存**：每次改动都必须同步 `index.html` 的 `?v=2.1.0`、`sw.js` 的 `BUILD`、安卓 `versionName` / `versionCode` 与 APK 名，否则手机会继续跑旧 JS。
8. **功能入口**：出库任务、驿站档案、账本资费、服务中心都在侧边栏；取件二维码在「驿站档案」，二维码标签与打印模板在「货号标签」，最近查询与语音搜索在「查件」。

---

## 六、数据与隐私

- 台账、客户、账号密码哈希、设置、操作流水全部只存当前浏览器 `localStorage`（键 `station.rebuild.v1`）；照片存 `IndexedDB`（`station-media-v2`）。
- 没有账号体系服务器、没有统计上报、没有第三方 CDN、没有云照片上传；客户完整手机号只存本机，界面默认脱敏显示。
- 密码用 SHA-256 + 每账号随机盐 + 1200 轮迭代，实现与 Node `crypto` 标准输出逐例比对通过。
- 浏览器禁用存储时自动降级为内存会话，页面不崩，但刷新会丢数据；登录页会提示。
- 清除浏览器数据 = 清空全部业务数据，**务必定期导出备份**。

---

## 七、验证与边界

```bash
node tests/smoke.js           # 回归测试（含规则层、数据层、账号、页面接线、排除项、版本一致性）
node --check app.js           # 语法检查
```

**已知边界**（不藏着）：
- 标签同时支持 Code39 条码与二维码（本机生成）；原版蓝牙打印依赖厂商 SDK，这里改用系统打印对话框。
- 二维码**生成**支持版本 1~5 / 纠错 L（最长约 108 字节）；**解码**针对正面清晰的二维码，倾斜、反光、局部遮挡的照片不做透视校正与纠错，识别不到请手输或用扫码枪。
- 「同步记录」「驿站档案」「账本资费」都是本机登记 / 记账，不真实上行、不产生支付、不做联网实名核验。
- 语音录入依赖浏览器 `SpeechRecognition`，语音播报依赖 `speechSynthesis`，不支持时自动跳过。
- 本机识别率取决于面单清晰度；模糊、反光、手写单需手输。所有识别结果都可手输覆盖，低置信度会提示核对。

---

## 八、2.0.1 ~ 2.0.3 · 安卓 WebView 稳定性修复

针对「安卓版登录崩溃」的三轮加固（旧版 APK 请直接覆盖安装）：

**2.0.1（页面层）**
- 页面顶部红色错误条，任何脚本异常都可见、可「复制诊断」；登录门与主界面「自检」带 `bootErrors` / `nativeLog`。
- `bind()` / `renderAll()` / `doLogin()` / 启动段全部包异常捕获；Android WebView 跳过 Service Worker 注册，浏览器侧逐项判空。
- 去掉 `Array.prototype.findIndex`（Chromium < 45 没有）；`BarcodeDetector.getSupportedFormats()` 加保护。
- 原生壳始终重新 `loadUrl`；JS 对话框、相机授权、资源拦截、销毁都加兜底。

**2.0.2（原生层 · 让崩溃可见）**
- 上一轮让用户去 `Android/data/com.rhua.expressstation/files/crash/` 取日志，但 **Android 11+ 文件管理器进不去该目录**，诊断路径等于失效。改为：
  - 静态块安装全局未捕获异常处理器（早于主题解析与 `onCreate`），`attachBaseContext` 提供 Context；
  - `onCreate` 全链路 `catch (Throwable)`，连 `NoSuchMethodError` / `VerifyError` 这类 `Error` 也不再闪退；
  - 任何启动异常都切换成**不依赖 WebView 的原生诊断屏**，显示完整堆栈 + 机型/系统版本，支持「复制诊断」和「仍要进入」；
  - 崩溃日志额外写一份到**「下载/快递驿站」公共目录**（Android 10+ 走 MediaStore）；
  - 上次崩溃在 10 分钟内，本次启动先停在诊断屏，确认后自动清空记录。
- `new WebView(this)` 单独兜底；补 `shouldInterceptRequest(WebView, String)` 旧重载（Android 5.x 只回调旧签名，缺了会整页 404 白）；主题改直接引用框架资源。

**2.0.3（登录瞬间）**

用户确认是「**点登录那一刻退出**」后，才定位到真正的差异点：启动时的登录门几乎不产生 DOM 操作，而登录成功会走 `enterApp() → renderAll()`，**在同一帧里一次性重绘全部 14 个视图**（大量 `innerHTML`、表格、SVG 条码）。低端 WebView 的渲染进程可能被这波峰值回收，而系统默认会连带杀掉 App 进程——这解释了为什么前两轮的 JS try/catch 与 Java 回调兜底都无效：渲染进程直接没了，根本没有异常可捕获。

- **按需渲染**：`renderAll()` 改为只渲染当前视图，`switchView()` 切到哪个视图才渲染哪一个；数据变更后只刷新当前，切过去时用最新数据重绘。登录瞬间 DOM 峰值降到原来的约 1/14。
- **接管渲染进程崩溃**：实现 `WebViewClient.onRenderProcessGone()` 并**返回 `true`**（返回 false 系统会直接杀进程），自动重建 WebView；15 秒内连续崩溃 2 次则停在诊断屏，不再无限重启。
- **外链跳转收敛**：`shouldOverrideUrlLoading` 只放行明确的 http/https 外链，hash / 相对地址 / 未知 scheme 一律留在页内，避免误起外部 Activity 让人误以为「退出」。
- **相机权限回调**：整个 `runOnUiThread` 体包 `catch (Throwable)`，并对 `request` / `getResources()` 判空。

**若仍有问题**：启动异常会停在诊断屏（截图或「复制诊断」发回）；渲染进程崩溃会在「下载/快递驿站」留下 `驿站助手-崩溃日志-*.txt`。网页版可点登录门「自检」查看 `bootErrors` / `nativeLog` / `lastFatal`。

---

## 九、2.0.4 · 点出库就退出（全面检查后的统一修复）

用户反馈「能登录，点出库就退出」。这次不再逐点猜，先做全链路只读排查，再用 CDP 把老 Android WebView 缺失的 API 全部撤掉后复现。

**真实根因**：`bind()` 第一行就用了 `document.querySelectorAll('.nav-item').forEach(...)`，而 Chromium < 51 的 WebView 没有 `NodeList.prototype.forEach`。启动阶段 `bind()` 整体抛错 → **所有导航、按钮、事件委托都没绑上** → 点侧栏「出库」毫无反应；探针里直接调 `switchView()`，14 个视图全部抛同一个 TypeError。登录之所以正常，是因为登录门用的是更早执行的 `.onclick`。

**同一轮全面检查发现的其它隐患**（一并修掉）：

- `Element.prototype.closest` 在事件委托里用了 9 处；`classList.toggle(x, force)` / `classList.remove` 在部分老 WebView 也不完整 → 统一换成自写 ES5 helper `each()` / `closestData()` / `setClass()` / `setOn()`。
- `rules.js` 默认 `autoCapture: true`，且 `switchView('outbound')` 会在 500ms 后自动 `getUserMedia` 开镜头；国产 ROM 上相机预览 / 权限回调是渲染进程退出的高发点。
- `Media.capture()` 遇到 `getUserMedia` 同步抛错、不返回 Promise、`srcObject` 缺失、`video.play()` 返回 undefined、面板点击用 `closest`，都可能让 Promise 悬挂或把异常抛到页面外。
- Java 层相机权限请求没有超时、`onRequestPermissionsResult` 未判空、`onActivityResult` 未兜底。

**修复**：

- **进入出库页绝不自动开镜头**：改由用户点「拍照取件 / 立即拍照 / 拍出库凭证」触发；设置里的 `autoCapture` 默认关，且只有用户先主动拍过一次，才可能用于连续取件时自动再开镜头。
- 出库页表格单次生成上限 120 → 60 行；`Media.engines()` 结果缓存，不再每次渲染都触发一次 `getSupportedFormats()`。
- `Media.capture()` 重写：全链路 `try/catch` 与判空、兼容老 WebView 的 `srcObject` / `play()`、15 秒超时自动收尾、任何失败降级到「从相册选」、Promise 永不 reject；`pickFiles()` 同样有兜底。
- 所有 `Media.capture / recognize / listen / exportAll / Promise.all` 调用链统一走 `safeChain()`，不再出现 `unhandledrejection`。
- Java：权限请求 8 秒超时自动 deny、Activity 已结束直接 deny、权限结果与文件选择回调整体 `catch (Throwable)`、渲染进程重建后按 `lastHash` 回到用户刚才的视图而不是退回首页。

**验证**：CDP 模拟老 WebView（撤掉 `NodeList.forEach` / `Element.closest` / `Array.findIndex`，并让 `getUserMedia` 同步抛错）跑「初始化 → 登录 → 点出库 → 14 视图」，`bootErrors` / 页面异常全空，点侧栏能正常切到出库，自动相机调用 0 次。

**版本**：2.0.4 · SW `station-rebuild-v5` · 安卓 versionCode 15。

---

## 十、2.0.5 · 点出库就死（缓存隔离 + 零渲染 + 步骤日志）

用户反馈 2.0.4 之后「点出库就死」。前几轮都在**全新浏览器 profile** 里验证通过，说明真机跑的很可能不是同一份代码。这次从三个方向同时封死：

**一、强制绕开 WebView 缓存（此前一直没查的盲点）**

老 WebView 会缓存 `shouldInterceptRequest` 返回的响应，而**主文档 `index.html` 此前不带版本号**。覆盖安装新 APK 后，WebView 仍可能从磁盘缓存拿到上一版 `index.html`，进而加载上一版 `app.js`——这正是「改了好几版，症状一点没变」的典型表现。

- 入口 URL 改为 `https://appassets.androidplatform.net/index.html?v=2.0.5`；
- 启动 `web.clearCache(true)`（不动 localStorage / IndexedDB），`WebSettings.setCacheMode(LOAD_NO_CACHE)`、关闭 AppCache；
- 所有 assets 响应头改为 `no-store, no-cache, must-revalidate` + `Pragma: no-cache`，页面加 `no-store` meta；
- **登录门显示 `2.0.5 · build 16`**，装的是不是新版一眼可确认。

**二、点出库那一瞬间零数据渲染**

`onRenderProcessGone()` 是 **API 26+** 才有的回调；而用户的 WebView 老到连 `NodeList.forEach` 都没有（Chromium < 51，通常 Android 5/6/7）。这类设备上渲染进程一旦被系统回收，**没有回调可接管、系统直接杀 App**，前几轮的 try/catch 和诊断屏全都来不及生效。

- 出库页**默认不列出在库包裹**：切过去只写几处文本和一行空表，必须点「查询」或扫码才生成表格，一次最多 20 行（兼容模式 10 行）；
- 输入过程不再逐字重绘；勾选包裹只更新计数，不重绘整表；切换出库页签、完成出库后回到未查询态；
- 渲染移到 `setTimeout` 下一帧，点击动作立即返回，不在同一帧里既切 `hidden` 又生成 DOM；
- `switchView()` **不再调用 `history.replaceState`**：老 WebView 会把它当成导航并回调 `shouldOverrideUrlLoading`，部分 ROM 甚至重新加载主文档；视图状态改由 `StationNative.setView()` 记在原生层，渲染进程重建后据此恢复；
- 切视图时不再探测 `BarcodeDetector`（原生能力探测在老 WebView 上可能直接抛错），识别引擎只在真正点拍照时探测。

**三、每一步都留痕，不再靠猜**

- 新增原生桥 `logStep()` / `setView()`；登录、点导航、开始渲染、渲染完成、查件、兼容模式切换都会写日志；
- 关键步骤与致命异常**自动镜像到「下载/快递驿站/驿站助手-运行日志.txt」**（固定文件名、覆盖式），Android 11+ 用普通文件管理器就能拿到；
- 诊断屏显示「最后一步」；登录门新增「导出运行日志」按钮，一键导出版本、机型、启动错误、存储状态与原生日志；
- 新增**老设备兼容模式**开关（登录门勾选）：渲染再延迟、列表减半、跳过语音播报与振动。

**排查顺序建议**：覆盖安装后先看登录门版本号是不是 `2.0.5 / build 16`；若不是，说明装到的仍是旧包。若版本正确仍异常，取「下载/快递驿站/驿站助手-运行日志.txt」发回，最后一条 `STEP` 就是崩溃前停在的动作。

**版本**：2.0.5 · SW `station-rebuild-v6` · 安卓 versionCode 16。

---

## 十一、2.0.6 · 离线 OCR 识别（不依赖浏览器原生能力）

**问题**：2.0.5 及以前的「拍照识别」只调用 `BarcodeDetector` / `TextDetector`。这两个 API 在绝大多数安卓 WebView 上根本不存在， iOS Safari 也没有，实际表现是「永远提示未支持识别，只能手输」——功能名义存在、实际不可用。

**方案**：新增 `ocr.js`，纯 JS、零依赖、不联网、不上传照片。照片在 canvas 里解码后即丢弃，只把识别出的字符串交给业务层。

- 预处理：最长边 1400 降采样 → 灰度 → 局部均值自适应二值化 → 去孤立黑点 → 三行多数投票 → 游程去毛刺；
- 条码解码：**Code128（含 Code C 数字压缩）、EAN-13 / UPC-A、ITF（交插二五码）、Code39**，编码表按 ZXing 逐项核对，Code128 / EAN 带校验位验证，无校验码制需多票才认，避免噪点误报；
- 辅助通道：**印刷数字模板 OCR**（连通域分割 → 等比归一化 → 30 个字形变体匹配），用于货号 / 取件码这类大号数字，带置信度；条码竖线、超长串、单调重复串都会被过滤；
- 水平 + 垂直扫描线，应对面单横拍 / 条码竖放；多行投票给置信度；
- 识别链路：原生引擎（若存在）优先 → 无论原生是否成功都跑离线引擎兜底 → 结果去重合并，返回 `engine` / `confidence` / `format`；
- 稳定性：全程 1.5s 预算上限、`Date.now()` 检查点、ES5 语法、所有异常吞掉且 `recognize()` 永不 reject，老 WebView 不会因识别卡死。

**界面**：入库 / 出库识别状态会显示实际引擎（如「离线条码 · Code128」）与置信度，低于 75% 时提示「请核对」；识别结果仍可直接手输覆盖。帮助页的功能对照表已补上 OCR 条目，排除项里的「云端能力」明确为「不接入云端 OCR 服务」。

**验证**：`tests/smoke.js` 覆盖四种码制的编码→解码往返、合成条码图像端到端识别、噪点鲁棒性、数字 OCR、误报过滤、版本一致性；CDP 真实浏览器加载页面验证 `StationOcr` 与 `Media.recognize` 链路。

**版本**：2.0.6 · SW `station-rebuild-v7` · 安卓 versionCode 17 · `station-assistant-2.0.6.apk`。

---

## 十二、2.1.0 · 功能对齐补齐（除短信电话通知外，功能要一样）

**用户要求**：「仿驿站助手功能，功能要一样，除去短信 电话通知」。重新只读审计 `570665.apk`：从 `AndroidManifest.xml` 字符串池提取 **160 个组件名**、从 dex / `resources.arsc` 提取 **873 条业务文案**、列出 `assets/html/` 下 **33 个 H5 页面**。比对后发现 2.0.6 覆盖了出入库核心业务，但原版「我的 / 任务 / 商业 / 信息」整块页面没有对应实现，且 2.0.0 的「不做清单」把充值账单、意见反馈、二维码海报等**非短信电话**能力也一起排除了，与本次要求不符。

**补齐的功能**

1. **出库任务**（`PickOutTask`）：按货号 / 单号 / 尾号筛选在库件 → 建任务 → 勾选 → 看明细 → 整批出库 → 任务状态留痕。默认不自动列出在库件，保持 2.0.5 的零渲染稳定性策略。
2. **驿站档案**（`StationInformation` / `ServiceItems` / `DelayLinkCompanySetting` / 实名资料）：驿站名称地址、营业时间、代收开通登记、实名姓名证件号、门头照 / 身份证人像面 / 国徽面（只存 IndexedDB）、合作快递公司、服务项目、延迟上传策略、取件二维码海报。
3. **账本资费**（`Recharge` / `Bill` / `tariff.html` / `EarnEntrance`）：余额（由流水累加）、充值与替他人充值、按件数结算账单、资费设置、活动奖励、CSV 导出。明确标注「本机记账，不接支付」。
4. **服务中心**（`FAQ` / `Suggestions` / `ContactUs` / `UserGuide` / `About` / `Disclaimer`）：14 条 FAQ、6 步用户指南、意见反馈与回复、活动记录、关于 / 免责 / 联系方式。反馈只写本机、可导出。
5. **二维码**（`BarCodeScan` / 二维码海报）：新增 `qr.js`，纯 JS 实现 QR 版本 1~5 / 纠错 L 生成（RS 编码、8 种掩码惩罚择优、BCH 格式信息）与解码（定位符检测、格式信息定掩码、数字 / 字母数字 / 字节模式解析）。取件海报、标签二维码字段、拍照离线解二维码全部接通 `media.js` 三通道识别。
6. **细节对齐**：打印模板多套保存 / 切换 / 删除、隐号面单入库、查件语音搜索与最近查询、延迟上传明细、记住账号、忘记密码本机指引、出库任务与同步策略联动。
7. **账号权限**：12 项扩到 16 项（`tasks` / `station` / `wallet` / `service`），操作员默认可用出库任务与服务中心，账本与档案仅站长可见。

**稳定性约束**（沿用 2.0.1~2.0.6 的教训）：新逻辑放独立 `extras.js`，通过 `x-*` 动作委托与 `submit` / `change` 事件委托接入，不改动原有 `bind()` 主体；所有前端文件保持 ES5，不用 `NodeList.forEach` / `closest` / `classList`；切视图只渲染当前视图；新视图切换写 `StationNative.logStep()`；进入页面绝不自动调用摄像头；异步链全部有兜底。

**验证**：`tests/smoke.js` 覆盖二维码编码→矩阵→图像往返（含中文与 URL）、空白图不误报、扩展数据模型与备份合并 / 覆盖、16 项权限、四个视图接线、ES5 与不联网扫描、排除项扫描、版本一致性；CDP 真实浏览器验证新视图无 JS 报错；APK 内 12 个 assets 与源码 sha256 一致。

**版本**：2.1.0 · SW `station-rebuild-v8` · 安卓 versionCode 18 · build 18 · `station-assistant-2.1.0.apk`。
