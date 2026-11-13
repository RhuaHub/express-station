/* Cloudflare Worker：给坚果云 WebDAV 补上 CORS 头，让纯静态页面能直连上传照片。
 *
 * 为什么需要它：坚果云 WebDAV 不返回 Access-Control-Allow-Origin，
 * 浏览器发 PROPFIND / MKCOL / PUT 会先发 OPTIONS 预检并被拦下。
 * 本 Worker 只做转发 + 补 CORS，不存储任何账号密码（Authorization 由前端带过来）。
 *
 * 部署：
 *   1. Cloudflare 控制台 → Workers 和 Pages → 创建 → 创建 Worker → 粘贴本文件
 *   2. （可选）把 ALLOWED_ORIGINS 改成自己的站点域名，防止别人蹭你的 Worker 额度
 *   3. （可选）设置 PROXY_KEY；同时在驿站系统「图片存储 → 代理密钥」填同一个值
 *   4. 部署后把 Worker 地址（形如 https://xxx.workers.dev，结尾不要带 /dav）
 *      填进系统「设置与数据 → 图片存储 → WebDAV 地址」
 *
 * 坚果云侧：网页版 → 账户信息 → 安全选项 → 第三方应用管理 → 添加应用密码。
 * 系统里用户名填坚果云账号邮箱，密码填「应用密码」（不是登录密码）。
 */

const UPSTREAM = 'https://dav.jianguoyun.com/dav';

// 强烈建议填自己的 Pages 域名，例如 'https://rhuahub.github.io'。
// 留空 = 不校验来源（方便本地调试，但 Worker 地址泄露后可能被他人借用）。
const ALLOWED_ORIGINS = [];

// 留空 = 不校验密钥；填了则前端必须带同样的 X-Proxy-Key 头。
const PROXY_KEY = '';

const CORS_METHODS = 'GET, HEAD, PUT, DELETE, MKCOL, PROPFIND, OPTIONS';
const CORS_HEADERS = 'Authorization, Content-Type, Depth, X-Proxy-Key, Overwrite, Destination';

function corsHeaders(origin) {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', origin || '*');
  h.set('Access-Control-Allow-Methods', CORS_METHODS);
  h.set('Access-Control-Allow-Headers', CORS_HEADERS);
  h.set('Access-Control-Expose-Headers', 'ETag, Last-Modified, Content-Length');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  return h;
}

function withCors(res, origin) {
  const out = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: new Headers(res.headers)
  });
  const c = corsHeaders(origin);
  c.forEach((v, k) => out.headers.set(k, v));
  // 上游可能自带冲突的 CORS 头，以本 Worker 的为准
  return out;
}

function deny(msg, status, origin) {
  const h = corsHeaders(origin);
  h.set('Content-Type', 'text/plain;charset=utf-8');
  return new Response(msg, { status, headers: h });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';

    // 预检：直接放行，不碰上游
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (ALLOWED_ORIGINS.length && (!origin || !ALLOWED_ORIGINS.includes(origin))) {
      return deny('来源未被允许（请在 Worker 里配置 ALLOWED_ORIGINS）', 403, origin);
    }
    if (PROXY_KEY && request.headers.get('X-Proxy-Key') !== PROXY_KEY) {
      return deny('代理密钥不正确', 401, origin);
    }

    const incoming = new URL(request.url);
    // 上游固定为坚果云，路径原样透传，杜绝被当成任意地址的开放代理
    const target = UPSTREAM + incoming.pathname + incoming.search;

    const headers = new Headers(request.headers);
    headers.delete('Host');
    headers.delete('Origin');
    headers.delete('Referer');
    headers.delete('X-Proxy-Key');

    const init = {
      method: request.method,
      headers,
      redirect: 'manual'
    };
    // GET / HEAD 没有 body，传了会让 Workers 报错
    if (!['GET', 'HEAD'].includes(request.method) && request.body) init.body = request.body;

    try {
      const res = await fetch(target, init);
      return withCors(res, origin);
    } catch (e) {
      return deny('转发坚果云失败：' + (e.message || e), 502, origin);
    }
  }
};
