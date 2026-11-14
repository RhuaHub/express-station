/* 临时探针：确认设置页默认写入方式是 GitHub，且只显示 GitHub 配置区块。
   用法：node tools/probe-github.js && msedge --headless=new --dump-dom file:///.../index-probe.html */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'index.html');
const out = path.join(root, 'index-probe.html');

const probe = `<script id="probe-github">
window.onerror = function (m) { document.documentElement.setAttribute('data-err', String(m)); };
window.addEventListener('load', function () {
  setTimeout(function () {
    try {
      var a = window.StationAuth;
      if (!a) throw new Error('StationAuth 未加载');
      if (!a.current()) {
        var r = a.register({ name: '测试站长', username: 'probe03', password: 'probe123456', confirm: 'probe123456', remember: true });
        if (!r || !r.ok) throw new Error('注册失败 ' + JSON.stringify(r));
        location.reload();
        return;
      }
      location.hash = '#settings';
      setTimeout(function () {
        var q = function (id) { var el = document.getElementById(id); return el ? (el.value || el.textContent) : 'MISSING:' + id; };
        var hidden = function (id) { var el = document.getElementById(id); return el ? String(el.hidden) : 'MISSING:' + id; };
        document.documentElement.setAttribute('data-mode', q('phMode'));
        document.documentElement.setAttribute('data-ghbox', hidden('phGithubBox'));
        document.documentElement.setAttribute('data-wdbox', hidden('phWebdavBox'));
        document.documentElement.setAttribute('data-tip', hidden('phWebdavTipBox'));
        document.documentElement.setAttribute('data-ghdir', q('ghDir'));
        document.documentElement.setAttribute('data-allowpub', String(document.getElementById('ghAllowPublic').checked));
        document.documentElement.setAttribute('data-cachebox', String(document.getElementById('ghCache').checked));
        document.documentElement.setAttribute('data-cachestate', q('ghCacheState'));
        document.documentElement.setAttribute('data-proxyfield', String(!!document.getElementById('ghProxyBase')));
        document.documentElement.setAttribute('data-status', q('photoStatus'));
        document.documentElement.setAttribute('data-probe', 'done');
      }, 400);
    } catch (e) {
      document.documentElement.setAttribute('data-probe', 'EX ' + (e && e.message));
    }
  }, 500);
});
</script>`;

const html = fs.readFileSync(src, 'utf8');
fs.writeFileSync(out, html.replace('</body>', probe + '\n</body>'));
console.log('probe written: ' + out);
