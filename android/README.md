# 安卓壳 · 驿站助手 2.0.1

一个 `WebView` 壳，把仓库根目录的静态页面打包进 `assets`，不依赖 Gradle / Android Studio。

- 产物：`android/dist/station-assistant-2.0.1.apk`
- 页面入口：`https://appassets.androidplatform.net/index.html`（用 `shouldInterceptRequest` 映射到 assets，保证是安全上下文，摄像头 / localStorage / IndexedDB 才可用）
- 打包脚本：`bash android/build-apk.sh`（需 JDK 17 + Android SDK platform / build-tools）
- 版本：`versionName 2.0.1` / `versionCode 12`，包名沿用 `com.rhua.expressstation`，可直接覆盖安装旧版

打包进 assets 的页面文件：`index.html`、`styles.css`、`rules.js`、`db.js`、`auth.js`、`media.js`、`app.js`、`sw.js`、`manifest.webmanifest`。改了前端就要重跑脚本，否则手机还是旧页面。

`StationNative` 提供 `saveText(name, content, mime)`（导出 CSV / JSON）、`toastMsg`、`platform`、`version`、`logError`（页面把异常写进原生日志）、`crashLog`（自检面板读回日志）。JS 对话框、文件选择器、相机权限都有对应处理。

## 崩溃诊断（2.0.1）

- Activity 始终重新 `loadUrl(START_URL)`，不再用 `restoreState`——后者在深色模式 / 字体变化导致 Activity 重建时会恢复出空白页，且原生桥注入可能失效。
- JS 对话框、相机授权回调、资源拦截、WebView 销毁都加了异常兜底，避免一个回调异常让整个 App 闪退。
- 原生未捕获异常与 `console.error` 追加写入 `Android/data/com.rhua.expressstation/files/crash/station-errors.txt`（不需要存储权限，用 `getExternalFilesDir`）。
- 页面顶部有红色错误条，点「自检」可看到 `bootErrors` 与 `nativeLog`；把内容发回即可定位。

权限只有 `INTERNET`、`CAMERA`、`READ_MEDIA_IMAGES`（Android 13+）与旧版存储写入；**没有短信、电话、通讯录权限**。
