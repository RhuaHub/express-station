/* 临时探针：确认「设置 → 图片存储」默认落到坚果云，且上游地址/提示同步更新。
   用法：node tools/probe-nutstore.js && msedge --headless=new --dump-dom file:///.../index-probe.html */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = path.join(root, 'index.html');
const out = path.join(root, 'index-probe.html');

const probe = `<script id="probe-nutstore">
window.onerror = function (m) { document.documentElement.setAttribute('data-err', String(m)); };
window.addEventListener('load', function () {
  setTimeout(function () {
    try {
      var a = window.StationAuth;
      if (!a) throw new Error('StationAuth 未加载');
      if (!a.current()) {
        var r = a.register({ name: '测试站长', username: 'probe02', password: 'probe123456', confirm: 'probe123456', remember: true });
        if (!r || !r.ok) throw new Error('注册失败 ' + JSON.stringify(r));
        document.documentElement.setAttribute('data-reg', 'ok');
        location.reload();
        return;
      }
      document.documentElement.setAttribute('data-in', a.current().username);
      location.hash = '#settings';
      setTimeout(function () {
        var q = function (id) { var el = document.getElementById(id); return el ? (el.value || el.textContent) : 'MISSING:' + id; };
        document.documentElement.setAttribute('data-provider', q('phProvider'));
        document.documentElement.setAttribute('data-base', q('phBase'));
        document.documentElement.setAttribute('data-title', q('phProviderTitle'));
        var opts = Array.prototype.map.call(document.querySelectorAll('#phProvider option'), function (o) { return o.value + '=' + o.textContent; });
        document.documentElement.setAttribute('data-opts', opts.join(' | '));
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
