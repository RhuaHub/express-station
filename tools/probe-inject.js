const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || process.cwd();
const file = path.join(dir, 'index.html');
let s = fs.readFileSync(file, 'utf8');

const removed = s.replace(/<script id="probe-a">[\s\S]*?<\/script>/g, '');
const probe = `<script id="probe-a">
window.onerror = function (m) {
  document.documentElement.setAttribute('data-err', String(m));
};
window.addEventListener('unhandledrejection', function (e) {
  document.documentElement.setAttribute('data-rej', String((e.reason && e.reason.message) || e.reason));
});
window.addEventListener('load', function () {
  setTimeout(function () {
    try {
      var a = window.StationAuth;
      if (!a) throw new Error('StationAuth 未加载');
      if (!a.current()) {
        var r = a.register({ name: '测试站长', username: 'probe01', password: 'probe123456', confirm: 'probe123456', remember: true });
        if (!r || !r.ok) throw new Error('注册失败 ' + JSON.stringify(r));
        location.reload();
        return;
      }
      document.documentElement.setAttribute('data-in', a.current().username);
      var st = window.StationStore;
      if (st && st.stats) document.documentElement.setAttribute('data-stock', String(st.stats().inStock));
    } catch (e) {
      document.documentElement.setAttribute('data-probe', 'EX ' + (e && e.message));
    }
  }, 500);
});
</script>`;

fs.writeFileSync(file, removed.replace('</body>', probe + '\n</body>'));
console.log('probe injected into ' + file);
