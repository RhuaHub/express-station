/* Cloudflare Worker：给 123 云盘 / 坚果云 WebDAV 补上 CORS 头，让纯静态页面能直连上传照片。
 *
 * 为什么需要它：这两个云盘的 WebDAV 都不返回 Access-Control-Allow-Origin，
 * 浏览器发 PROPFIND / MKCOL / PUT 会先发 OPTIONS 预检并被拦下（实测返回 401，无 CORS 头）。
 * 本 Worker 只做转发 + 补 CORS，不存储任何账号密码（Authorization 由前端带过来）。
 *
 * 路由：
 *   /pan123/*   → https://webdav.123pan.cn/webdav/*      （123 云盘，推荐）
 *   /nutstore/* → https://dav.jianguoyun.com/dav/*
 *   /webdav/*   → env.UPSTREAM_CUSTOM 指定的自定义上游（AList 外网地址等）
 * 上游地址在 Worker 里写死或由环境变量给出，绝不从请求里取，避免变成开放代理。
 *
 * 部署：
 *   1. Cloudflare 控制台 → Workers 和 Pages → 创建 Worker → 粘贴本文件
 *   2. （可选）环境变量 ALLOWED_ORIGINS = 'https://rhuahub.github.io'，防止别人蹭额度
 *   3. （可选）环境变量 PROXY_KEY，同时在驿站系统「图片存储 → 代理密钥」填同一个值
 *   4. 部署后把 Worker 根地址（形如 https://xxx.workers.dev，结尾不要带 /pan123）
 *      填进「设置 → 图片存储 → CORS 代理地址」；上游地址保持默认即可
 *   5. 若 123 云盘给你的是专属 WebDAV 域名，设环境变量 UPSTREAM_PAN123 覆盖默认值
 *
 * 123 云盘侧：网页版 → 工具中心 → 第三方挂载 → WebDAV 授权管理 → 添加应用（勾「读写」）→
 * 复制应用密码（只显示一次）。系统里账号填 123 云盘手机号/邮箱，密码填应用密码。
 */

const ROUTES = {
  '/pan123': 'https://webdav.123pan.cn/webdav',
  '/nutstore': 'https://dav.jianguoyun.com/dav',
  '/webdav': ''
};
const ROUTE_ENV = {
  '/pan123': 'UPSTREAM_PAN123',
  '/nutstore': 'UPSTREAM_NUTSTORE',
  '/webdav': 'UPSTREAM_CUSTOM'
};

// 强烈建议填自己的站点域名，例如 'https://rhuahub.github.io'。
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

/* 按前缀挑上游；返回 { prefix, upstream } 或 null */
function resolveUpstream(pathname, env) {
  const prefixes = Object.keys(ROUTES).sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(prefix + '/')) {
      const key = ROUTE_ENV[prefix];
      const fromEnv = env && key ? String(env[key] || '').replace(/\/+$/, '') : '';
      const upstream = fromEnv || ROUTES[prefix];
      return upstream ? { prefix, upstream } : { prefix, upstream: '' };
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
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
    const hit = resolveUpstream(incoming.pathname, env);
    if (!hit) {
      return deny('请使用 /pan123、/nutstore 或 /webdav 前缀访问', 404, origin);
    }
    if (!hit.upstream) {
      return deny('该路由未配置上游地址，请设置环境变量 ' + ROUTE_ENV[hit.prefix], 500, origin);
    }

    // 去掉前缀后原样透传到固定上游，杜绝被当成任意地址的开放代理
    const rest = incoming.pathname.slice(hit.prefix.length) || '/';
    const target = hit.upstream + rest + incoming.search;

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
      return deny('转发失败：' + (e.message || e), 502, origin);
    }
  }
};
