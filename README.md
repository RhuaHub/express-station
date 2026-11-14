# 快递驿站 · 入库出库管理

本地优先的快递驿站管理系统。纯静态、零依赖、零后端：数据存在浏览器里，照片写到 坚果云 / 123 云盘 WebDAV 或本地同步目录，需要跨设备时再用 GitHub 同步台账 JSON。

同时提供三种使用方式：

| 形态 | 入口 | 说明 |
| --- | --- | --- |
| 网页 | `index.html` | 双击即用，也可部署到 Cloudflare Pages / GitHub Pages |
| PWA | 浏览器「安装到桌面」 | 支持离线打开，桌面图标、启动画面齐全 |
| 安卓 App | `android/dist/express-station-1.0.2.apk` | 内置同一套页面，摄像头、扫码枪、导出都可用 |

## 功能

- **入库登记**：扫码枪回车连录、自动分配货架位、自动生成取件码、面单拍照留证
- **查件**：按取件码 / 手机尾号 / 运单号 / 收件人 / 货架位检索，在库优先排序
- **取件出库**：多次搜索累加勾选、合并出库生成批次凭证、出库拍照留证
- **在库台账**：多条件筛选、滞留分级提醒、CSV 导出
- **统计看板**：今日进出、7 日趋势、快递公司分布、货架区占用、滞留分布
- **操作流水**：谁在什么时候做了什么，支持撤销出库 / 整批撤销
- **账号体系**：站长 / 操作员 / 只读访客三级权限，站长可开子账号、重置密码（本机账号，不依赖云盘）
- **备份**：JSON 全量导出导入，可自动同步到 GitHub 仓库
- **照片存储**：直接提交进 GitHub 仓库 `photos/`（默认）/ 坚果云 / 123 云盘 / 自建 AList（WebDAV）/ 云盘客户端同步目录

## 目录

```
index.html            单页应用骨架（含登录门）
styles.css            样式（暖金配色，移动端适配）
app.js                UI 控制器：渲染、事件、权限落位
store.js              数据层：包裹、流水、统计、取件码、导入导出
auth.js               账号与角色权限（SHA-256 加盐迭代哈希）
photos.js             照片后端：GitHub 仓库 / WebDAV / 本地目录 / IndexedDB
camera.js             实时预览拍照（getUserMedia）
sync.js               GitHub 仓库同步
manifest.webmanifest  PWA 清单
sw.js                 离线缓存（仅同源 GET）
icons/                PWA 与桌面图标
android/              安卓 App 壳（WebView）与打包脚本
deploy/               WebDAV CORS 代理 Worker、AList 容器配置
tests/smoke.js        回归测试（59 项）
tools/                图标生成、无头浏览器探针等辅助脚本
```

## 照片存哪儿

入库照片与出库凭证都只存引用，文件本体写到 GitHub 仓库或云盘，按 `入库照片/年-月/RK-*.jpg`、`出库凭证/年-月/CK-*.jpg` 归档，文件名带拍摄时间。

| 方案 | 需要什么 | 说明 |
| --- | --- | --- |
| **GitHub 仓库**（默认） | 一个 PAT（Contents 读写）+ 私有仓库 | 照片直接进 `photos/`，不用云盘和 Worker；**每张一次 commit**，见下方容量说明 |
| 坚果云 | 注册邮箱 + 应用密码 + 一个 Cloudflare Worker | 免费版就带 WebDAV，每月上传 1GB / 下载 3GB，存出库凭证够用 |
| 123 云盘 | 应用密码 + 同一个 Worker | 软件与代理免费；云盘侧要账号本身有 WebDAV 权益（老账号 / 连续续费的老会员），**新账号、新开通会员都不含** |
| 自定义 / AList | AList 的 WebDAV 地址 | AList 自带 CORS，可直连 |
| 同步文件夹 | 桌面版 Chrome / Edge | 用云盘客户端把目录同步上去 |

> **“免费”的边界**：免费的是本项目和 Worker（Cloudflare 免费额度），不是 123 云盘的存储权益。123 侧的可用性取决于账号：2026-11-04 之前注册的老账号、以及权益连续有效的老会员，WebDAV 照旧、不额外花钱；新注册用户免费额度只有 20GB，新开通的会员也不再有 WebDAV。零成本且最少配置的方案是 **GitHub 仓库直存**（复用已有的 token，不需要第二个账号）。

### GitHub 仓库直存（默认方式）

照片走 [Contents API](https://docs.github.com/rest/repos/contents) 提交进仓库，路径 `{目录}/入库照片|出库凭证/年-月/*.jpg`，默认目录 `photos`。

1. 在「GitHub 同步」里填 **Personal Access Token**（fine-grained 需 `Contents: Read and write`）与 **owner/repo**；
2. 「图片存储 → 写入方式」选 **GitHub 仓库**，仓库/分支可留空（跟随同步配置），点「用同步里的仓库」自动带出；
3. 点「测试连接」：会回报仓库是私有还是公开、分支是否可用。

三条硬约束：

- **必须私有仓库**。面单照片含收件人手机号与地址，公开仓库会把它们公开展示。代码层面默认拦截：审计到公开仓库时直接拒写并回退浏览器暂存，需要勾选「允许写入公开仓库」才会放行。
- **每张照片一次 commit**。优势是天然版本化、可在 GitHub 网页里按日期翻；代价是提交历史会很多，仓库有 1GB 软上限（单张压缩后约 150–250KB，一天 100 件约 20MB/月）。件量大就调低「图片最长边」、或定期清理旧月份目录。
- **删除不可逆**。照片一旦提交就进了 git 历史，从仓库删文件不会缩小 `.git` 体积；真要清理需改写历史。台账里「移除引用」只删引用，不动仓库文件。

**为什么必须有个 Worker**：坚果云与 123 云盘的 WebDAV 都不返回 `Access-Control-Allow-Origin`（实测连 OPTIONS 预检都直接 401），浏览器会拦掉上传。`deploy/webdav-proxy.js` 只做转发和补 CORS 头，不存任何账号密码，免费额度足够个人使用。

> **⚠️ 123 云盘 WebDAV 权益变化（2026-11-04 起）**
> 123 云盘调整权益：**新注册账号不再赠送每月下载流量；新开通的会员不再包含同步、备份、WebDAV、云桌面、离线下载**。老会员只要会员资格连续有效，原有权益保留。
> 所以新账号登录网页版后，可能**只有「会员中心 → 工具中心」，看不到「第三方挂载 → WebDAV 授权管理」**——这不是配置问题，是账号本身没有该权益。遇到这种情况走三条退路（设置页「看不到 WebDAV 授权管理？」里有对应按钮）：
> 1. **改用坚果云 WebDAV**：坚果云对所有用户（含免费版）开放 WebDAV，免费版每月上传 1GB / 下载 3GB，够存出库凭证；
> 2. **改用本机文件夹**：用 123 云盘客户端把云盘挂载成磁盘或同步到本地目录，再在设置里选那个目录（仅桌面版 Chrome / Edge，且选择器不一定列网络驱动器）；
> 3. **只存浏览器**：照片留在本机 IndexedDB，换设备不跟随。

配置路径（坚果云）：坚果云网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 添加**应用密码**（只显示一次）。然后部署 Worker，在「设置 → 图片存储」把云盘服务选「坚果云」、CORS 代理地址填 Worker 根地址，账号填**注册邮箱**、密码填应用密码，点「测试连接」。

配置路径（123 云盘，需账号仍保留权益）：123 云盘网页版 → 工具中心 → 第三方挂载 → WebDAV 授权管理 → 添加应用（勾「读写」）→ 复制**应用密码**。后续同上，云盘服务选「123 云盘」，账号填手机号/邮箱。

Worker 路由：`/pan123` → 123 云盘，`/nutstore` → 坚果云，`/webdav` → 自定义上游（配 `UPSTREAM_CUSTOM`）。123 若给的是专属 WebDAV 域名，用环境变量 `UPSTREAM_PAN123` 覆盖。

## 使用

### 网页 / PWA

1. **首次部署先初始化**（只做一次）：在地址栏把链接改成 `index.html?setup=1` 打开，创建站长账号。初始化入口在「本机一个账号都没有」时才有效，建完立即失效。
2. 之后打开 `index.html` 只会看到**登录框**——本站不开放自助注册，新账号只能由站长在「账号管理 → 新增子账号」里添加。
3. 部署到静态托管后，浏览器地址栏会出现「安装」入口，装到桌面即可离线使用。
4. 支持深链：`index.html#inbound`、`#lookup`、`#outbound`、`#inventory` 直接落到对应页面。

**三道对外防护**（纯静态站能做到的部分）：

| 防护 | 作用 |
|---|---|
| 自助注册关闭 | 站点有账号后，任何访问者都无法自行创建账号，只能看到登录框 |
| 初始化需显式入口 | 只有 `?setup=1` 或安卓 App 里长按标题 1.2 秒才能进初始化，且仅在零账号时生效 |
| 登录失败限速 | 同一设备连错 5 次锁 60 秒，再错翻倍（上限 15 分钟），锁定期间正确密码也不放行；账号不存在与密码错误给同一提示 |
| 闲置自动锁定 | 15 分钟无操作自动回登录门，防止设备放柜台上被人顺手操作 |

> 如实说明：这是纯前端应用，账号库和台账都在浏览器本地。防护挡的是「打开你链接的陌生人」和「随手拿起设备的人」；能物理接触设备并清空浏览器数据的人，等于把站点恢复出厂，只能重新初始化——那也读不到你原来浏览器里的数据。真正的多用户隔离需要服务端，本项目刻意不做。 |


### 安卓 App

```bash
bash android/build-apk.sh          # 需要 JDK 17 + Android SDK build-tools/platform
```

产物在 `android/dist/express-station-1.0.2.apk`，传到手机安装即可（首次需允许「安装未知来源应用」）。
详细说明见 [android/README.md](android/README.md)。

## 数据与隐私

- 台账、账号、流水都在本机浏览器（localStorage），**不上传任何服务器**。
- 密码只存加盐哈希，不存明文；账号库随 JSON 备份一起迁移。
- 云盘凭据、GitHub token 只存在本机浏览器设置里，不进代码库（`.gitignore` 已排除 `.env`、`*.token`）。
- 选 GitHub 直存时，同一个 token 同时用于台账同步与照片上传；照片提交进**私有仓库**，v1.0.2 起默认拒绝写入公开仓库。
- 照片文件名按 `类型/年-月/前缀-时间-随机.jpg` 归档，出库凭证与入库照片分目录。

## 没接 123 云盘 OAuth 登录的原因（决策记录）

官方授权地址形如 `https://yun.123pan.com/auth?client_id=&redirect_uri=&scope=user:base,file:all:read,file:all:write&state=`，授权后回跳 `redirect_uri?code=`，再用 `POST https://open-api.123pan.com/api/v1/oauth2/access_token`（`client_id` + **`client_secret`** + `grant_type=authorization_code` + `code` + `redirect_uri`）换 token。核实后不采用，原因是四点叠加：

1. **`client_secret` 必填**，纯静态站无法安全保存，必须由 Worker 中转换 token；
2. **开放平台已改为付费权益**：2026-03 起 OpenAPI 划入「开发者权益包」，¥25/月连续包月且要求账号为会员，此前免费申请已于 3 月 1 日到期；企业合作通道需营业执照与 ICP 备案；
3. **回调地址是硬前提**：OAuth 需要公网 https 地址，Pages 未开启时（`rhuahub.github.io/express-station/` 返回 404）整条链跑不起来；安卓壳的页面来源是 `https://appassets.androidplatform.net`，无法在 123 后台登记，App 内也走不通；
4. **与「不开放注册」冲突**：OAuth 登录天然允许任何 123 账号进入。若要接，必须做成白名单（站长生成一次性邀请码，登录后凭码绑定）。

现状：登录走本机账号（站长初始化 + 后台加子账号），照片走 WebDAV 应用密码 —— 两项都不依赖 Pages，也不需要付费；WebDAV 那侧的可用性取决于云盘账号自身权益。

> 注：`open-api.123pan.com` 实测返回 `Access-Control-Allow-Origin: *`，`GET /api/v1/user/info`（Bearer token）可直接前端调用。哪天开通了权益包又想接，只需在 `deploy/webdav-proxy.js` 加一个 `/oauth/pan123` 端点存 secret，前端负责跳授权页与带 `state` 校验。

### 参考样本：VidHub 的授权链接为什么不能照抄

线上可见的真实链接长这样（第三方播放器 VidHub 注册的客户端，`client_id` 中段已打码）：

```
https://yun.123pan.com/auth?client_id=s23oy2xv…96soz
  &redirect_uri=vidhub%3A%2F%2Foauth-callback%2Faliyundrive
  &scope=user:base,file:all:read,file:all:write&state=VidHubStateiOS
```

它和「官方模板」只差三个值，但这三个值正是门槛：

| 字段 | VidHub 的值 | 我们能不能有自己的 |
| --- | --- | --- |
| `client_id` | VidHub 的应用 ID | 能，但必须在开放平台建应用，即 ¥25/月权益包 |
| `redirect_uri` | `vidhub://oauth-callback/aliyundrive`（App 自定义 scheme，绑在该 App 内） | 网页端只能用公网 https；安卓壳来源是 `appassets.androidplatform.net`，登记不了 |
| 换 token 的 `client_secret` | 存在 VidHub 服务端 | 纯前端存不住，必须 Worker |

实测补充（2026-11-14）：

- 授权页 **不校验** `client_id` 和 `redirect_uri`：随手编一个 32 位 `client_id`、把 `redirect_uri` 换成 `https://example.com/cb`，返回的仍是同一张 4336 字节登录页。**所以「链接能打开」不等于「凭据可用」**。
- `POST https://open-api.123pan.com/api/v1/oauth2/access_token` 只接受 `application/x-www-form-urlencoded`；用 JSON 提交会一律报 `unsupported_grant_type`（这是踩过的坑，别误判成「端点不支持授权码模式」）。
- 该端点带 `Access-Control-Allow-Origin: *`，浏览器能跨域直达；真正卡住的是 `client_secret`，不是 CORS。

结论不变：不冒用第三方 `client_id`（拿不到 code，也违反平台规则），也不为一张照片存储付费开权益包。照片走 WebDAV 应用密码 + Worker 中转，只要账号本身有 WebDAV 权益就不额外花钱，也够用。

## 测试

```bash
node tests/smoke.js
```

覆盖数据层、权限矩阵、取件码规则、批次凭证共享、PWA 清单与 Service Worker 边界、深链、安卓壳实现与 APK 内容。
