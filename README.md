# 快递驿站 · 入库出库管理

本地优先的快递驿站管理系统。纯静态、零依赖、零后端：数据存在浏览器里，照片可存坚果云 WebDAV 或本地同步目录，需要跨设备时再用 GitHub 同步台账 JSON。

同时提供三种使用方式：

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| 网页 | `index.html` | 双击即用，也可部署到 Cloudflare Pages / GitHub Pages |
| PWA | 浏览器「安装到桌面」 | 支持离线打开，桌面图标、启动画面齐全 |
| 安卓 App | `android/dist/express-station-1.0.0.apk` | 内置同一套页面，摄像头、扫码枪、导出都可用 |

## 功能

- **入库登记**：扫码枪回车连录、自动分配货架位、自动生成取件码、面单拍照留证
- **查件**：按取件码 / 手机尾号 / 运单号 / 收件人 / 货架位检索，在库优先排序
- **取件出库**：多次搜索累加勾选、合并出库生成批次凭证、出库拍照留证
- **在库台账**：多条件筛选、滞留分级提醒、CSV 导出
- **统计看板**：今日进出、7 日趋势、快递公司分布、货架区占用、滞留分布
- **操作流水**：谁在什么时候做了什么，支持撤销出库 / 整批撤销
- **账号体系**：站长 / 操作员 / 只读访客三级权限，站长可开子账号、重置密码
- **备份**：JSON 全量导出导入，可自动同步到 GitHub 仓库

## 目录

```
index.html            单页应用骨架（含登录门）
styles.css            样式（暖金配色，移动端适配）
app.js                UI 控制器：渲染、事件、权限落位
store.js              数据层：包裹、流水、统计、取件码、导入导出
auth.js               账号与角色权限（SHA-256 加盐迭代哈希）
photos.js             照片后端：WebDAV / 本地目录 / IndexedDB
camera.js             实时预览拍照（getUserMedia）
sync.js               GitHub 仓库同步
manifest.webmanifest  PWA 清单
sw.js                 离线缓存（仅同源 GET）
icons/                PWA 与桌面图标
android/              安卓 App 壳（WebView）与打包脚本
deploy/               坚果云 CORS 中转 Worker、AList 容器配置
tests/smoke.js        回归测试（51 项）
tools/                图标生成、无头浏览器探针等辅助脚本
```

## 使用

### 网页 / PWA

1. 直接打开 `index.html`，首次会要求注册站长账号。
2. 部署到静态托管后，浏览器地址栏会出现「安装」入口，装到桌面即可离线使用。
3. 支持深链：`index.html#inbound`、`#lookup`、`#outbound`、`#inventory` 直接落到对应页面。

### 安卓 App

```bash
bash android/build-apk.sh          # 需要 JDK 17 + Android SDK build-tools/platform
```

产物在 `android/dist/express-station-1.0.0.apk`，传到手机安装即可（首次需允许「安装未知来源应用」）。
详细说明见 [android/README.md](android/README.md)。

## 数据与隐私

- 台账、账号、流水都在本机浏览器（localStorage），**不上传任何服务器**。
- 密码只存加盐哈希，不存明文；账号库随 JSON 备份一起迁移。
- 云盘凭据、GitHub token 只存在本机浏览器设置里，不进代码库（`.gitignore` 已排除 `.env`、`*.token`）。
- 照片文件名按 `类型/年-月/前缀-时间-随机.jpg` 归档，出库凭证与入库照片分目录。

## 测试

```bash
node tests/smoke.js
```

覆盖数据层、权限矩阵、取件码规则、批次凭证共享、PWA 清单与 Service Worker 边界、深链、安卓壳实现与 APK 内容。
