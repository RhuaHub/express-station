# 快递驿站 · 入库出库管理

本地优先的快递驿站管理系统。纯静态、零依赖、零后端：数据存在浏览器里，照片写到 123 云盘 / 坚果云 WebDAV 或本地同步目录，需要跨设备时再用 GitHub 同步台账 JSON。

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
- **账号体系**：站长 / 操作员 / 只读访客三级权限，站长可开子账号、重置密码（本机账号，不依赖云盘）
- **备份**：JSON 全量导出导入，可自动同步到 GitHub 仓库
- **照片存储**：123 云盘 / 坚果云 / 自建 AList（WebDAV），或云盘客户端同步目录

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
deploy/               WebDAV CORS 代理 Worker、AList 容器配置
tests/smoke.js        回归测试（52 项）
tools/                图标生成、无头浏览器探针等辅助脚本
```

## 照片存哪儿

入库照片与出库凭证都只存引用，文件本体写到云盘，按 `入库照片/年-月/RK-*.jpg`、`出库凭证/年-月/CK-*.jpg` 归档，文件名带拍摄时间。

| 方案 | 需要什么 | 说明 |
| --- | --- | --- |
| **123 云盘** | 应用密码 + 一个 Cloudflare Worker | 免费 2TB、不限速、单文件 100GB，推荐 |
| 坚果云 | 应用密码 + 同一个 Worker | 免费版每月上传 1GB |
| 自定义 / AList | AList 的 WebDAV 地址 | AList 自带 CORS，可直连 |
| 同步文件夹 | 桌面版 Chrome / Edge | 用云盘客户端把目录同步上去 |

**为什么必须有个 Worker**：123 云盘与坚果云的 WebDAV 都不返回 `Access-Control-Allow-Origin`（实测连 OPTIONS 预检都直接 401），浏览器会拦掉上传。`deploy/webdav-proxy.js` 只做转发和补 CORS 头，不存任何账号密码，免费额度足够个人使用。

配置路径：123 云盘网页版 → 工具中心 → 第三方挂载 → WebDAV 授权管理 → 添加应用（勾「读写」）→ 复制**应用密码**（只显示一次）。然后部署 Worker，在「设置 → 图片存储」把云盘服务选「123 云盘」、CORS 代理地址填 Worker 根地址，账号填手机号/邮箱、密码填应用密码，点「测试连接」。

Worker 路由：`/pan123` → 123 云盘，`/nutstore` → 坚果云，`/webdav` → 自定义上游（配 `UPSTREAM_CUSTOM`）。123 若给的是专属 WebDAV 域名，用环境变量 `UPSTREAM_PAN123` 覆盖。

## 使用

### 网页 / PWA

1. 直接打开 `index.html`，首次会要求注册站长账号（账号只在本机，**不用 123 云盘账号登录**）。
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
