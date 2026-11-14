# 安卓 App（WebView 壳）

把网页版原样装进 App，不依赖 Gradle / Android Studio，用 SDK 自带工具直接出 APK。

## 为什么不是简单的 WebView

直接用 `file://` 加载会得到**不透明来源**，摄像头（getUserMedia 需要安全上下文）、localStorage、IndexedDB 都会被限制或失效。这里改成：

```
https://appassets.androidplatform.net/  --shouldInterceptRequest-->  assets/
```

页面因此拥有真正的 https 安全上下文，摄像头、本地存储、离线缓存都能正常工作。

## 构建

前置：JDK 17、Android SDK（`build-tools` + `platforms/android-34`）。

```bash
bash android/build-apk.sh
```

脚本按顺序做：同步网页资源 → `aapt2 compile/link` → `javac` → `d8` → 写入 `classes.dex` 与图标 → `zipalign` → `apksigner`。
首次运行会自动生成 `android/debug.keystore`（已在 `.gitignore` 中排除）。产物：`android/dist/express-station-1.0.8.apk`。

自定义工具链位置：

```bash
ANDROID_SDK_ROOT=/path/to/sdk JAVA_HOME=/path/to/jdk bash android/build-apk.sh
```

## 安装

1. 把 APK 传到手机（微信文件传输 / 数据线 / 网盘均可）。
2. 点击安装，若提示「未知来源」需在系统设置里允许该来源。
3. 首次启动时登录页只有登录框（不开放自助注册）：**长按顶部驿站标题 1.2 秒**进入初始化，创建站长账号；建好后该手势失效。之后给店员开账号走「账号管理 → 新增子账号」，或导入网页版导出的 JSON 备份。

## 壳层做了什么

| 能力 | 实现 |
| --- | --- |
| 页面加载 | `shouldInterceptRequest` 把 `appassets.androidplatform.net` 映射到 `assets/` |
| 摄像头 | `WebChromeClient.onPermissionRequest` 授予 `RESOURCE_VIDEO_CAPTURE`，并处理运行时权限 |
| 文件选择 | `onShowFileChooser` 按页面 `accept` 传 MIME，照片与 JSON 备份都能选 |
| 弹窗 | 接管 `onJsAlert` / `onJsConfirm`，否则 `window.confirm` 会静默返回 false |
| 导出 | `StationNative.saveText()` 写入「下载/快递驿站」，绕开 WebView 不支持 blob 下载的问题 |
| 后退 | 先回退网页历史，再按一次才退出 |
| 旋转 | `configChanges` 声明齐全，不重建 Activity，表单不丢 |

## 已知限制

- 页面资源随 APK 打包，**改网页后需要重新执行构建**才能同步到 App。
- 打包用的是调试签名，适合自用与内部安装；要上应用商店需换成正式签名并自行加固。
- 未接入系统相机 Intent 的「拍照返回」通道，App 内拍照走 `getUserMedia` 实时预览；从相册选择走系统文件选择器。
- 扫码枪按键盘输入模拟，USB / 蓝牙 HID 模式即插即用；专业串口枪需额外桥接。
