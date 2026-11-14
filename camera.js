/* 摄像头拍照：getUserMedia 实时预览 → canvas 抓帧 → File。
   产出的 File 交给 photos.js 压缩并写入阿里云盘；本模块不碰存储与凭据。 */
(function (global) {
  'use strict';

  var api = { lastError: '' };

  function supported() {
    try {
      return typeof navigator !== 'undefined' &&
        !!navigator.mediaDevices &&
        typeof navigator.mediaDevices.getUserMedia === 'function' &&
        (typeof global.isSecureContext === 'undefined' || global.isSecureContext !== false);
    } catch (e) { return false; }
  }
  api.supported = supported;

  function stamp() {
    var d = new Date(), p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* opts: { single: 只拍一张拍完即返回, title: 标题 }
     返回 Promise<File[]|null>：null 表示用户取消；失败时 api.lastError 有值，调用方应回退系统相机。 */
  function open(opts) {
    opts = opts || {};
    api.lastError = '';
    if (!supported()) {
      api.lastError = '当前环境不支持摄像头调用（需 https 页面与支持 getUserMedia 的浏览器）';
      return Promise.resolve(null);
    }
    var root = document.getElementById('cameraRoot');
    if (!root) {
      root = document.createElement('div');
      root.id = 'cameraRoot';
      document.body.appendChild(root);
    }

    return new Promise(function (resolve) {
      var single = !!opts.single;
      var title = opts.title || '拍照';
      var subtitle = opts.subtitle || '';
      var tip = opts.tip || '对准包裹或面单后点「拍照」';
      var done = false, stream = null, facing = 'environment';
      var files = [], thumbUrls = [];
      var baseName = '';
      var startWatch = null;

      root.innerHTML = '<div class="cam-mask"><div class="cam-panel">' +
        '<div class="cam-head"><h3>' + esc(title) + '</h3>' +
        '<button type="button" class="cam-x" data-act="cancel" aria-label="关闭"><svg class="ic"><use href="#i-close"/></svg></button></div>' +
        (subtitle ? '<div class="cam-sub">' + esc(subtitle) + '</div>' : '') +
        '<div class="cam-stage">' +
        '<video id="camVideo" autoplay playsinline muted></video>' +
        '<div class="cam-error" id="camError" hidden></div>' +
        '<div class="cam-hint" id="camHint">正在启动摄像头…</div>' +
        '</div>' +
        '<div class="cam-thumbs" id="camThumbs"></div>' +
        '<div class="cam-actions">' +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="switch"><svg class="ic"><use href="#i-switch-cam"/></svg>切换镜头</button>' +
        '<button type="button" class="btn btn-primary" data-act="shoot"><svg class="ic"><use href="#i-shutter"/></svg>拍照</button>' +
        (single ? '' : '<button type="button" class="btn btn-outline btn-sm" data-act="finish" id="camFinish" hidden>完成</button>') +
        '<button type="button" class="btn btn-ghost btn-sm" data-act="cancel">取消</button>' +
        '</div></div></div>';

      var panel = root.querySelector('.cam-panel');
      var video = root.querySelector('#camVideo');
      var errBox = root.querySelector('#camError');
      var hint = root.querySelector('#camHint');
      var thumbs = root.querySelector('#camThumbs');
      var finishBtn = root.querySelector('#camFinish');

      function stopStream() {
        if (stream) {
          stream.getTracks().forEach(function (t) { try { t.stop(); } catch (e) { /* 忽略 */ } });
          stream = null;
        }
      }
      function finish(result) {
        if (done) return;
        done = true;
        if (startWatch) clearTimeout(startWatch);
        stopStream();
        document.removeEventListener('keydown', onKey);
        thumbUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ } });
        root.innerHTML = '';
        resolve(result);
      }
      function fail(msg) {
        api.lastError = msg;
        errBox.hidden = false;
        errBox.innerHTML = esc(msg) + '<br><span>可关闭本窗口，改用「选图」或系统相机。</span>';
        hint.textContent = '摄像头不可用';
        video.style.opacity = '0';
      }
      function onKey(e) { if (e.key === 'Escape') finish(null); }

      async function start() {
        stopStream();
        hint.textContent = facing === 'environment' ? '正在启动后置摄像头…' : '正在启动前置摄像头…';
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: facing },
              width: { ideal: 1920 },
              height: { ideal: 1080 }
            }
          });
        } catch (e) {
          var n = e && e.name;
          if (n === 'NotAllowedError' || n === 'PermissionDeniedError') {
            fail('相机权限被拒绝，请在浏览器地址栏允许摄像头访问');
          } else if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') {
            if (facing === 'environment') { facing = 'user'; return start(); }
            fail('没有找到可用的摄像头');
          } else {
            fail('无法启动摄像头：' + ((e && e.message) || n || '未知错误'));
          }
          return;
        }
        video.srcObject = stream;
        try { await video.play(); } catch (e) { /* 部分浏览器需用户手势，忽略 */ }
        hint.textContent = (facing === 'environment' ? '后置' : '前置') + '摄像头 · ' + tip;
        /* 自动开镜头时 iOS Safari 可能不给自动播放，画面全黑；2.6 秒后给一句可操作的提示 */
        if (startWatch) clearTimeout(startWatch);
        startWatch = setTimeout(function () {
          if (!done && stream && video && !video.videoWidth) {
            hint.textContent = '若画面仍是黑的，请先点一下屏幕；不行就关闭本窗口重新点「拍照取件」';
          }
        }, 2600);
      }

      function drawFrame() {
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return Promise.reject(new Error('画面尚未就绪，请稍等一秒再拍'));
        var max = 1600, scale = Math.min(1, max / Math.max(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        var ctx = canvas.getContext('2d');
        if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        return new Promise(function (res, rej) {
          canvas.toBlob(function (blob) {
            if (!blob) return rej(new Error('抓拍失败，请重试'));
            res(blob);
          }, 'image/jpeg', 0.88);
        });
      }

      function renderThumbs() {
        thumbUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* 忽略 */ } });
        thumbUrls = [];
        thumbs.innerHTML = files.map(function (f) {
          var u = URL.createObjectURL(f);
          thumbUrls.push(u);
          return '<div class="cam-thumb"><img src="' + u + '" alt="已拍照片"></div>';
        }).join('');
        if (finishBtn) {
          finishBtn.hidden = !files.length;
          finishBtn.textContent = '完成（' + files.length + ' 张）';
        }
      }

      async function shoot() {
        var btn = panel.querySelector('[data-act="shoot"]');
        if (btn.disabled) return;
        btn.disabled = true;
        try {
          var blob = await drawFrame();
          if (!baseName) baseName = 'camera-' + stamp();
          var file = new File([blob], baseName + '-' + (files.length + 1) + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
          files.push(file);
          renderThumbs();
          if (single) { finish(files); return; }
          hint.textContent = '已拍 ' + files.length + ' 张，可继续拍或点「完成」';
        } catch (e) {
          api.lastError = e.message || String(e);
          hint.textContent = api.lastError;
        }
        btn.disabled = false;
      }

      panel.addEventListener('click', async function (e) {
        var b = e.target.closest('[data-act]');
        if (!b) return;
        var act = b.dataset.act;
        if (act === 'cancel') finish(null);
        else if (act === 'shoot') shoot();
        else if (act === 'finish') finish(files.length ? files : null);
        else if (act === 'switch') { facing = facing === 'environment' ? 'user' : 'environment'; start(); }
      });
      root.querySelector('.cam-mask').addEventListener('click', function (e) {
        if (e.target === this) finish(null);
      });
      document.addEventListener('keydown', onKey);

      start();
    });
  }
  api.open = open;

  global.StationCamera = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
