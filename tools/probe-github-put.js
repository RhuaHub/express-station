/* 临时探针：用 stub fetch 跑一遍 GitHub 直存的上传链路，验证请求地址、payload 与公开仓库拦截。
   用法：node tools/probe-github-put.js && msedge --headless=new --dump-dom file:///.../index-probe.html */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'index.html');
const out = path.join(root, 'index-probe.html');

const probe = `<script id="probe-ghput">
window.onerror = function (m) { document.documentElement.setAttribute('data-err', String(m)); };
function makeJpeg() {
  return new Promise(function (resolve) {
    var c = document.createElement('canvas');
    c.width = 32; c.height = 24;
    var x = c.getContext('2d');
    x.fillStyle = '#c33'; x.fillRect(0, 0, 32, 24);
    c.toBlob(function (b) { resolve(new File([b], 't.jpg', { type: 'image/jpeg' })); }, 'image/jpeg', 0.8);
  });
}
window.addEventListener('load', function () {
  setTimeout(async function () {
    try {
      document.documentElement.setAttribute('data-step','enter');
      var a = window.StationAuth;
      if (!a) throw new Error('StationAuth 未加载');
      if (!a.current()) {
        a.register({ name: '测试站长', username: 'probe04', password: 'probe123456', confirm: 'probe123456', remember: true });
        location.reload();
        return;
      }
      var calls = [];
      /* 无头环境里 Image 解码 / canvas 编码不会触发，用桩替代，只验证上传链路本身 */
      window.HTMLCanvasElement.prototype.getContext = function () {
        return { fillStyle: '', fillRect: function () {}, drawImage: function () {} };
      };
      window.HTMLCanvasElement.prototype.toBlob = function (cb) {
        cb(new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' }));
      };
      window.Image = function () {
        var self = this;
        self.naturalWidth = 32;
        self.naturalHeight = 24;
        setTimeout(function () { if (self.onload) self.onload(); }, 0);
        return self;
      };
      document.documentElement.setAttribute('data-step','stubs');
      window.StationSync.saveConfig({ token: 'stub-token-not-real', repo: 'me/private-repo', branch: 'main' });
      window.fetch = function (url, opt) {
        opt = opt || {};
        var u = String(url);
        calls.push({ url: u, method: opt.method || 'GET', body: opt.body ? JSON.parse(opt.body) : null });
        if (u.indexOf('/repos/me/private-repo') > 0 && (!opt.method || opt.method === 'GET')) {
          return Promise.resolve(new Response(JSON.stringify({ private: true, default_branch: 'main' }), { status: 200 }));
        }
        if (u.indexOf('/contents/') > 0 && opt.method === 'PUT') {
          return Promise.resolve(new Response(JSON.stringify({ content: { path: 'ok' } }), { status: 201 }));
        }
        return Promise.resolve(new Response('{}', { status: 200 }));
      };

      // 1) 正常上传：仓库留空 → 跟随同步配置，目录 photos
      window.StationPhotos.saveConfig({ mode: 'github', github: { repo: '', branch: '', dir: 'photos', allowPublic: false, isPublic: null } });
      document.documentElement.setAttribute('data-step','jpeg');
      var jpg1 = await makeJpeg();
      document.documentElement.setAttribute('data-step','put1');
      var r1 = await window.StationPhotos.put(jpg1, 'in');
      document.documentElement.setAttribute('data-step','after-put1');
      document.documentElement.setAttribute('data-r1', JSON.stringify(r1));
      var put = calls.filter(function (c) { return c.method === 'PUT'; })[0];
      document.documentElement.setAttribute('data-put', put ? JSON.stringify({ url: put.url, msg: put.body.message, branch: put.body.branch, hasB64: !!(put.body.content && put.body.content.length > 100) }) : 'NONE');

      // 2) 公开仓库：默认必须拦下，并回退到浏览器暂存
      calls.length = 0;
      window.StationPhotos.saveConfig({ github: { isPublic: true, allowPublic: false } });
      var r2 = await window.StationPhotos.put(await makeJpeg(), 'pickup');
      document.documentElement.setAttribute('data-r2', JSON.stringify(r2));
      document.documentElement.setAttribute('data-put2', String(calls.filter(function (c) { return c.method === 'PUT'; }).length));

      // 3) 显式放行后应能写入
      window.StationPhotos.saveConfig({ github: { allowPublic: true } });
      var r3 = await window.StationPhotos.put(await makeJpeg(), 'pickup');
      document.documentElement.setAttribute('data-r3', JSON.stringify(r3));
      document.documentElement.setAttribute('data-probe', 'done');
    } catch (e) {
      document.documentElement.setAttribute('data-probe', 'EX ' + (e && (e.stack || e.message)));
    }
  }, 600);
});
</script>`;

const html = fs.readFileSync(src, 'utf8');
fs.writeFileSync(out, html.replace('</body>', probe + '\n</body>'));
console.log('probe written: ' + out);
