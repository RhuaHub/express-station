# 安卓壳 · 驿站助手 2.3.0

一个 `WebView` 壳，把仓库根目录的静态页面打包进 `assets`，不依赖 Gradle / Android Studio。

- 产物：`android/dist/station-assistant-2.3.0.apk`
- 页面入口：`https://appassets.androidplatform.net/index.html`（用 `shouldInterceptRequest` 映射到 assets，保证是安全上下文，摄像头 / localStorage / IndexedDB 才可用）
- 打包脚本：`bash android/build-apk.sh`（需 JDK 17 + Android SDK platform / build-tools）
- 版本：`versionName 2.3.0` / `versionCode 20`，包名沿用 `com.rhua.expressstation`，可直接覆盖安装旧版

打包进 assets 的页面文件：`index.html`、`styles.css`、`rules.js`、`ocr.js`、`qr.js`、`db.js`、`auth.js`、`media.js`、`extras.js`、`notify.js`、`app.js`、`sw.js`、`manifest.webmanifest`（共 13 个）。改了前端就要重跑脚本，否则手机还是旧页面。

**2.3.0 拍照识别**：预览连续自动识别由前端 `media.js` + `ocr.js` 完成，不调用安卓原生扫码 SDK、不联网。相机权限沿用 `CAMERA`；识别只在本机 canvas 里跑，照片存 IndexedDB。

`StationNative` 提供 `saveText(name, content, mime)`（导出 CSV / JSON）、`toastMsg`、`platform`、`version`、`logError`、`crashLog`、`lastFatal`、`logStep`（步骤日志）、`setView`（记住当前视图）。JS 对话框、文件选择器、相机权限都有对应处理。

## 崩溃诊断

- **诊断屏**：静态块安装全局未捕获异常处理器，`onCreate` 全链路 `catch (Throwable)`；任何启动异常都不闪退，而是显示一个纯原生界面，列出完整堆栈、机型、Android 版本、App 版本，可「复制诊断」或点「仍要进入」继续加载页面。
- **公共日志**：崩溃时除写私有 `files/crash/station-errors.txt` 外，还在「下载/快递驿站」生成一份 `驿站助手-崩溃日志-*.txt`（Android 10+ 走 MediaStore）。Android 11+ 无法直接访问 `Android/data`，公共目录才是用户真正能拿到的那份。
- **安全启动**：上次崩溃在 10 分钟内，本次启动先停在诊断屏，避免反复闪退；用户点「仍要进入」后清空记录。
- **WebView 不可用**：`new WebView(this)` 失败时提示更新 Android System WebView，不再直接退出。
- **老 WebView**：同时实现 `shouldInterceptRequest(WebView, WebResourceRequest)` 与 `(WebView, String)` 两个重载，覆盖 Android 5.x 只回调旧签名的情况。
- 页面顶部另有红色错误条，「自检」可看 `bootErrors` / `nativeLog` / `lastFatal`。

## 登录瞬间退出（2.0.3 定点修复）

确认崩溃发生在「点登录那一刻」后，定位到启动与登录的唯一大差异：登录成功会在单帧内 `renderAll()` 重绘全部 14 个视图，低端 WebView 渲染进程可能被回收，系统默认连带杀掉 App，JS 与 Java 回调的 try/catch 都兜不住。

- 页面改为**按需渲染**：`renderAll()` 只渲当前视图，`switchView()` 切到哪个渲哪个，登录瞬间 DOM 峰值约降为 1/14。
- 原生实现 `onRenderProcessGone()` 并**返回 true**（返回 false 系统直接杀进程），自动重建 WebView；15 秒内连续崩 2 次则停在诊断屏。
- `shouldOverrideUrlLoading` 只放行明确 http/https 外链；相机权限回调整体 `catch (Throwable)` 并判空。

## 点出库就退出（2.0.4 全面检查）

- 页面层去掉全部 `NodeList.forEach` / `Element.closest` / `classList` 依赖，改自写 ES5 helper；此前 `bind()` 在老 WebView 上启动即抛错，导致所有导航与按钮失效。
- 出库页不再自动 `getUserMedia` 开镜头，拍照改由用户点按钮触发；相机失败自动降级到「从相册选」，15 秒超时收尾。
- 原生层：相机权限请求 8 秒超时自动 deny；`Activity` 已结束时直接 deny；`onRequestPermissionsResult` 判空；`onActivityResult` 与 `JsResult` 回调整体 `catch (Throwable)`；渲染进程重建时按 `lastHash` 回到用户刚才的视图。
- 诊断方式不变：异常会停在原生诊断屏，日志副本在「下载/快递驿站」。

## 点出库就死（2.0.5 · 缓存隔离 / 零渲染 / 步骤日志）

- **缓存隔离**：入口 `START_URL` 带 `?v=2.0.5`，主文档不再命中旧缓存；启动 `web.clearCache(true)`（不动 localStorage / IndexedDB）、`LOAD_NO_CACHE`、关 AppCache；assets 响应统一 `no-store, no-cache, must-revalidate`。老 WebView 缓存上一版 `index.html` 会让所有前端修复看起来「没生效」。
- **API < 26 现实**：`onRenderProcessGone()` 只在 API 26+ 回调，老设备上渲染进程被回收系统会直接杀 App，没有任何 JS/Java 兜底机会。因此出库页改成「点查询才渲染」，切视图瞬间零数据生成，渲染延到下一帧。
- **不再改 URL**：页面去掉 `history.replaceState`，改由 `StationNative.setView()` 把当前视图同步到 `lastHash`，重建 WebView 后据此恢复。
- **步骤日志**：原生桥新增 `logStep()` / `setView()`；关键步骤与致命异常自动覆盖写入「下载/快递驿站/驿站助手-运行日志.txt」，诊断屏显示「最后一步」，登录门可一键「导出运行日志」并显示 `2.0.5 · build 16`。
- **兼容模式**：登录门可勾选「老设备兼容模式」，延迟渲染、列表减半、跳过语音播报与振动。

权限包含 `INTERNET`、`CAMERA`、`READ_MEDIA_IMAGES`（Android 13+）、`SEND_SMS`、`CALL_PHONE`、`READ_CALL_LOG` 与旧版存储写入。短信 / 电话权限只在通知功能里按需运行时申请；**不申请通讯录权限**，也不上传任何号码或照片。
