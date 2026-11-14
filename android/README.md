# 安卓壳 · 驿站助手 2.0.2

一个 `WebView` 壳，把仓库根目录的静态页面打包进 `assets`，不依赖 Gradle / Android Studio。

- 产物：`android/dist/station-assistant-2.0.2.apk`
- 页面入口：`https://appassets.androidplatform.net/index.html`（用 `shouldInterceptRequest` 映射到 assets，保证是安全上下文，摄像头 / localStorage / IndexedDB 才可用）
- 打包脚本：`bash android/build-apk.sh`（需 JDK 17 + Android SDK platform / build-tools）
- 版本：`versionName 2.0.2` / `versionCode 13`，包名沿用 `com.rhua.expressstation`，可直接覆盖安装旧版

打包进 assets 的页面文件：`index.html`、`styles.css`、`rules.js`、`db.js`、`auth.js`、`media.js`、`app.js`、`sw.js`、`manifest.webmanifest`。改了前端就要重跑脚本，否则手机还是旧页面。

`StationNative` 提供 `saveText(name, content, mime)`（导出 CSV / JSON）、`toastMsg`、`platform`、`version`、`logError`、`crashLog`、`lastFatal`。JS 对话框、文件选择器、相机权限都有对应处理。

## 崩溃诊断（2.0.2）

- **诊断屏**：静态块安装全局未捕获异常处理器，`onCreate` 全链路 `catch (Throwable)`；任何启动异常都不闪退，而是显示一个纯原生界面，列出完整堆栈、机型、Android 版本、App 版本，可「复制诊断」或点「仍要进入」继续加载页面。
- **公共日志**：崩溃时除写私有 `files/crash/station-errors.txt` 外，还在「下载/快递驿站」生成一份 `驿站助手-崩溃日志-*.txt`（Android 10+ 走 MediaStore）。Android 11+ 无法直接访问 `Android/data`，公共目录才是用户真正能拿到的那份。
- **安全启动**：上次崩溃在 10 分钟内，本次启动先停在诊断屏，避免反复闪退；用户点「仍要进入」后清空记录。
- **WebView 不可用**：`new WebView(this)` 失败时提示更新 Android System WebView，不再直接退出。
- **老 WebView**：同时实现 `shouldInterceptRequest(WebView, WebResourceRequest)` 与 `(WebView, String)` 两个重载，覆盖 Android 5.x 只回调旧签名的情况。
- 页面顶部另有红色错误条，「自检」可看 `bootErrors` / `nativeLog` / `lastFatal`。

权限只有 `INTERNET`、`CAMERA`、`READ_MEDIA_IMAGES`（Android 13+）与旧版存储写入；**没有短信、电话、通讯录权限**。
