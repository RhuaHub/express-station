/* Cloudflare Worker：GitHub 照片只读加速节点
 *
 * 作用只有两个：
 *   1. 边缘缓存 —— GitHub 的 contents 接口只给 60 秒缓存、且前面没有 CDN，
 *      换设备或本机缓存被清掉之后，同一张照片要重新走一次 api.github.com。
 *      这里用 caches.default 把照片按 repo/branch/path 存在离你最近的节点上。
 *   2. 收 token —— 读私有仓库要 PAT。放进 Worker 的 Secret 后，浏览器不再需要
 *      持有一个能读全仓库的 token，也就少了一份会被前端拿走的凭据。
 *
 * 只做读，故意不支持写入：写要靠用户自己的 PAT 走 api.github.com，避免这个
 * 节点变成一个「谁都能往你仓库塞文件」的入口。
 *
 * 部署：Workers & Pages → 新建 Worker → 粘贴本文件 → 设置 → 变量与机密
 *   GH_TOKEN          必填，fine-grained PAT，对目标私有仓库只给 Contents: Read
 *   PROXY_KEY         建议填，随便一串长随机串，前端「加速节点密钥」填同一个
 *   ALLOWED_ORIGINS   可选，逗号分隔的来源白名单（如 https://rhuahub.github.io）；
 *                     不填则放行任意来源，靠 PROXY_KEY 兜住
 *   CACHE_TTL         可选，边缘缓存秒数，默认 2592000（30 天）
 */

const GH_API = 'https://api.github.com';
const DEFAULT_TTL = 2592000;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allow = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const h = new Headers();
  h.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'X-Station-Key, Content-Type');
  h.set('Access-Control-Max-Age', '86400');
  h.set('Vary', 'Origin');
  if (!allow.length) h.set('Access-Control-Allow-Origin', '*');
  else if (allow.indexOf(origin) >= 0) h.set('Access-Control-Allow-Origin', origin);
  return h;
}

function json(body, status, extra) {
  const h = new Headers({ 'Content-Type': 'application/json;charset=utf-8', 'Cache-Control': 'no-store' });
  if (extra) extra.forEach((v, k) => h.set(k, v));
  return new Response(JSON.stringify(body), { status: status || 200, headers: h });
}

/* 只允许仓库内的正常相对路径：挡掉 ../ 与绝对路径，避免被拿去读别的仓库或别的接口 */
function safePath(p) {
  const s = String(p || '').trim();
  if (!s || s.length > 500) return '';
  if (s.charAt(0) === '/' || s.indexOf('\\') >= 0 || s.indexOf('://') >= 0) return '';
  const parts = s.split('/');
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return '';
  }
  return parts.map(encodeURIComponent).join('/');
}

function safeBranch(b) {
  const s = String(b || '').trim();
  if (!s || s.length > 250) return '';
  if (s.indexOf('..') >= 0 || s.charAt(0) === '/' || s.charAt(s.length - 1) === '/') return '';
  if (s.indexOf('//') >= 0 || s.indexOf(' ') >= 0) return '';
  return s;
}

function keyOk(request, env) {
  const expect = String(env.PROXY_KEY || '');
  if (!expect) return true;
  const got = request.headers.get('X-Station-Key') || '';
  if (got.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expect.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: '此节点只读，不支持 ' + request.method }, 405, cors);
    }
    if (!keyOk(request, env)) return json({ error: 'X-Station-Key 不对' }, 401, cors);

    if (url.pathname === '/ping' || url.pathname === '/') {
      return json({ ok: true, service: 'gh-photo-proxy', hasToken: !!env.GH_TOKEN, at: new Date().toISOString() }, 200, cors);
    }
    if (url.pathname !== '/photo') return json({ error: '未知路径，只有 /ping 与 /photo' }, 404, cors);

    const repo = String(url.searchParams.get('repo') || '').trim();
    const branch = safeBranch(url.searchParams.get('branch') || 'main');
    const path = safePath(url.searchParams.get('path') || '');
    if (!REPO_RE.test(repo)) return json({ error: 'repo 格式应为 owner/name' }, 400, cors);
    if (!branch) return json({ error: 'branch 不合法' }, 400, cors);
    if (!path) return json({ error: 'path 不合法（不能为空、不能含 .. 或以 / 开头）' }, 400, cors);
    if (!env.GH_TOKEN) return json({ error: 'Worker 没配 GH_TOKEN' }, 500, cors);

    const cache = caches.default;
    const cacheKey = new Request('https://gh-photo-proxy.internal/photo?repo=' + encodeURIComponent(repo) +
      '&branch=' + encodeURIComponent(branch) + '&path=' + encodeURIComponent(path), { method: 'GET' });

    const hit = await cache.match(cacheKey);
    if (hit) return rebuild(hit, 'HIT', cors);

    const upstream = await fetch(GH_API + '/repos/' + repo + '/contents/' + path + '?ref=' + encodeURIComponent(branch), {
      headers: {
        'Authorization': 'Bearer ' + env.GH_TOKEN,
        'Accept': 'application/vnd.github.raw',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gh-photo-proxy'
      }
    });
    if (!upstream.ok) {
      /* 401/403/404 原样回传状态码，前端能对着错误码给出可读提示；不写进缓存 */
      const detail = await upstream.text().catch(() => '');
      return json({ error: 'GitHub HTTP ' + upstream.status, detail: detail.slice(0, 300) },
        upstream.status === 404 ? 404 : upstream.status === 401 || upstream.status === 403 ? 403 : 502, cors);
    }

    const body = await upstream.arrayBuffer();
    const type = upstream.headers.get('Content-Type') || 'image/jpeg';
    const ttl = Math.max(60, Number(env.CACHE_TTL) || DEFAULT_TTL);

    /* 给边缘缓存用的那份：长 TTL，文件名带时间戳和随机串，内容不会变 */
    const edgeHeaders = new Headers();
    edgeHeaders.set('Content-Type', type);
    edgeHeaders.set('Cache-Control', 'public, max-age=' + ttl + ', immutable');
    edgeHeaders.set('Content-Length', String(body.byteLength));
    ctx.waitUntil(cache.put(cacheKey, new Response(body, { status: 200, headers: edgeHeaders })));

    return rebuild(new Response(body, { status: 200, headers: edgeHeaders }), 'MISS', cors);
  }
};

/* 交给浏览器的响应：只给一天的私有缓存，不把「公开且一年不变」这种头透出去 */
function rebuild(res, state, cors) {
  const h = new Headers();
  h.set('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');
  h.set('Cache-Control', 'private, max-age=86400');
  h.set('X-Cache', state);
  const len = res.headers.get('Content-Length');
  if (len) h.set('Content-Length', len);
  cors.forEach((v, k) => h.set(k, v));
  return new Response(res.body, { status: 200, headers: h });
}
