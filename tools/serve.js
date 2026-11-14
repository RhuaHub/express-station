/* 最小静态服务，只给探针用：node tools/serve.js 8765 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 8765);
const root = path.join(__dirname, '..');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.apk': 'application/vnd.android.package-archive'
};

http.createServer(function (req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  /* 探针用：故意慢的响应，把 load 事件拖住，好让 IndexedDB 在真实时钟下做完 */
  if (url.pathname === '/slow') {
    const ms = Math.min(15000, Number(url.searchParams.get('ms')) || 3000);
    return setTimeout(function () {
      res.writeHead(200, { 'Content-Type': 'image/gif', 'Cache-Control': 'no-store' });
      res.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64'));
    }, ms);
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(root, rel || 'index.html');
  if (!file.startsWith(root)) { res.writeHead(403); return res.end('no'); }
  fs.readFile(file, function (err, buf) {
    if (err) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', function () {
  console.log('serving ' + root + ' on http://127.0.0.1:' + port);
});
