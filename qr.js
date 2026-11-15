/* 驿站助手（重建版 2.1.0）· 离线二维码
   纯 JS 零依赖、ES5、不联网。支持生成（字节模式，版本 1~5，纠错 L）与
   从正面清晰的图片里解码（数字 / 字母数字 / 字节三种模式）。
   生成端不做图片上传；解码端不做纠错（清晰图无误码），倾斜 / 反光照片建议手输。 */
(function (global) {
  'use strict';

  /* ---------------- GF(256) 与 RS ---------------- */
  var EXP = [], LOG = [];
  (function () {
    var x = 1, i;
    for (i = 0; i < 256; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
    for (i = 256; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  function gmul(a, b) { return (!a || !b) ? 0 : EXP[(LOG[a] + LOG[b]) % 255]; }
  function rsGen(n) {
    var g = [1], i, j;
    for (i = 0; i < n; i++) {
      var ng = [], k;
      for (k = 0; k <= g.length; k++) ng.push(0);
      for (j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }
  function rsRemainder(data, gen) {
    var res = [], i, j;
    for (i = 0; i < gen.length - 1; i++) res.push(0);
    for (i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift(); res.push(0);
      for (j = 0; j < gen.length - 1; j++) res[j] ^= gmul(gen[j + 1], factor);
    }
    return res;
  }

  /* 版本 1~5 / 纠错 L 容量表（均为单块，无需交织） */
  var CAP = [
    { total: 26, ec: 7, data: 19 }, { total: 44, ec: 10, data: 34 },
    { total: 70, ec: 15, data: 55 }, { total: 100, ec: 20, data: 80 },
    { total: 134, ec: 26, data: 108 }
  ];

  function utf8Bytes(s) {
    var out = [], i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }
  function utf8Text(bytes) {
    var s = '', i = 0, b;
    while (i < bytes.length) {
      b = bytes[i++];
      if (b < 0x80) s += String.fromCharCode(b);
      else if (b >= 0xc0 && b < 0xe0 && i < bytes.length) {
        s += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
      } else if (b >= 0xe0 && b < 0xf0 && i + 1 < bytes.length) {
        var c1 = bytes[i++], c2 = bytes[i++];
        s += String.fromCharCode(((b & 15) << 12) | ((c1 & 63) << 6) | (c2 & 63));
      } else s += '';
    }
    return s;
  }

  function maskBit(m, x, y) {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return (x * y) % 2 + (x * y) % 3 === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }
  /* 功能图形占位：finder + separator、timing、alignment、format、dark module */
  function reservedFor(size) {
    var res = [], y, x, i;
    for (y = 0; y < size; y++) { res.push([]); for (x = 0; x < size; x++) res[y].push(0); }
    function finder(x0, y0) {
      var dy, dx;
      for (dy = -1; dy <= 7; dy++) for (dx = -1; dx <= 7; dx++) {
        var xx = x0 + dx, yy = y0 + dy;
        if (xx < 0 || yy < 0 || xx >= size || yy >= size) continue;
        var inside = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
        var dark = inside && (dx === 0 || dx === 6 || dy === 0 || dy === 6 ||
          (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
        res[yy][xx] = 1;
        if (!dark) res[yy][xx] = 2; /* 2 = 功能图形且为白 */
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);
    for (i = 8; i < size - 8; i++) { res[6][i] = i % 2 === 0 ? 1 : 2; res[i][6] = i % 2 === 0 ? 1 : 2; }
    if (size >= 25) {
      var c = size - 7, dy, dx;
      for (dy = -2; dy <= 2; dy++) for (dx = -2; dx <= 2; dx++) {
        var darkA = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
        res[c + dy][c + dx] = darkA ? 1 : 2;
      }
    }
    for (i = 0; i <= 8; i++) { res[8][i] = res[8][i] || 2; res[i][8] = res[i][8] || 2; }
    for (i = 0; i < 8; i++) {
      res[8][size - 1 - i] = res[8][size - 1 - i] || 2;
      res[size - 1 - i][8] = res[size - 1 - i][8] || 2;
    }
    return res;
  }
  function placeData(mods, res, bytes, mask) {
    var size = mods.length, bit = 0, right, upward = true, vert, j, y, x;
    var totalBits = bytes.length * 8;
    for (right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (vert = 0; vert < size; vert++) {
        y = upward ? size - 1 - vert : vert;
        for (j = 0; j < 2; j++) {
          x = right - j;
          if (res[y][x]) continue;
          var b = bit < totalBits ? (bytes[bit >> 3] >> (7 - (bit & 7))) & 1 : 0;
          mods[y][x] = maskBit(mask, x, y) ? 1 - b : b;
          bit++;
        }
      }
      upward = !upward;
    }
  }
  function drawFormat(mods, mask) {
    var size = mods.length, data = (1 << 3) | mask, rem = data, i;
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    function gb(k) { return (bits >>> k) & 1; }
    for (i = 0; i <= 5; i++) mods[i][8] = gb(i);
    mods[7][8] = gb(6); mods[8][8] = gb(7); mods[8][7] = gb(8);
    for (i = 9; i < 15; i++) mods[8][14 - i] = gb(i);
    for (i = 0; i < 8; i++) mods[8][size - 1 - i] = gb(i);
    for (i = 8; i < 15; i++) mods[size - 15 + i][8] = gb(i);
    mods[size - 8][8] = 1;
  }
  function penalty(mods) {
    var size = mods.length, x, y, p = 0, run, last, dark = 0;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) dark += mods[y][x];
    p += Math.abs(dark * 2 - size * size) * 2 / (size * size);
    for (y = 0; y < size; y++) {
      last = -1; run = 0;
      for (x = 0; x < size; x++) {
        if (mods[y][x] === last) run++; else { last = mods[y][x]; run = 1; }
        if (run === 5) p += 3; else if (run > 5) p += 1;
      }
    }
    for (x = 0; x < size; x++) {
      last = -1; run = 0;
      for (y = 0; y < size; y++) {
        if (mods[y][x] === last) run++; else { last = mods[y][x]; run = 1; }
        if (run === 5) p += 3; else if (run > 5) p += 1;
      }
    }
    return p;
  }
  function build(text, mask) {
    var bytes = utf8Bytes(String(text)), v, cap = null;
    for (v = 0; v < CAP.length; v++) if (bytes.length + 2 <= CAP[v].data) { cap = CAP[v]; break; }
    if (!cap) return null;
    var version = v + 1, size = 17 + 4 * version, bits = [], i, j;
    function push(n, len) { for (j = len - 1; j >= 0; j--) bits.push((n >>> j) & 1); }
    push(4, 4); push(bytes.length, 8);
    for (i = 0; i < bytes.length; i++) push(bytes[i], 8);
    var rem = cap.data * 8 - bits.length;
    push(0, Math.min(4, rem));
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (i = 0; i < bits.length; i += 8) {
      var b = 0; for (j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b);
    }
    var pad = 0;
    while (data.length < cap.data) data.push(pad++ % 2 ? 0x11 : 0xec);
    var ec = rsRemainder(data, rsGen(cap.ec));
    var all = data.concat(ec), mods = [], res = reservedFor(size), y, x;
    for (y = 0; y < size; y++) { mods.push([]); for (x = 0; x < size; x++) mods[y].push(res[y][x] === 1 ? 1 : 0); }
    placeData(mods, res, all, mask);
    drawFormat(mods, mask);
    return { version: version, size: size, modules: mods, mask: mask };
  }
  function encode(text) {
    var best = null, bestP = 1e9, m;
    for (m = 0; m < 8; m++) {
      var r = build(text, m); if (!r) return null;
      var p = penalty(r.modules);
      if (p < bestP) { bestP = p; best = r; }
    }
    return best;
  }
  function svg(text, opts) {
    var r = encode(text); if (!r) return '';
    opts = opts || {};
    var size = r.size, margin = opts.margin === undefined ? 2 : opts.margin;
    var px = opts.size || 220, n = size + margin * 2, d = [], y, x;
    for (y = 0; y < size; y++) for (x = 0; x < size; x++) {
      if (r.modules[y][x]) d.push('M' + (x + margin) + ' ' + (y + margin) + 'h1v1h-1z');
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n +
      '" width="' + px + '" height="' + px + '" shape-rendering="crispEdges" role="img" aria-label="二维码">' +
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d.join('') + '" fill="#111"/></svg>';
  }

  /* ---------------- 解码 ---------------- */
  function readBits(mods, res, mask) {
    var size = mods.length, bits = [], right, upward = true, vert, j, y, x;
    for (right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (vert = 0; vert < size; vert++) {
        y = upward ? size - 1 - vert : vert;
        for (j = 0; j < 2; j++) {
          x = right - j;
          if (res[y][x]) continue;
          var b = mods[y][x] ^ (maskBit(mask, x, y) ? 1 : 0);
          bits.push(b & 1);
        }
      }
      upward = !upward;
    }
    return bits;
  }
  var ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  function parseBits(bits, version) {
    var p = 0, i, text = '';
    function take(n) { var v = 0, k; for (k = 0; k < n; k++) v = (v << 1) | (bits[p++] || 0); return v; }
    while (p + 4 <= bits.length) {
      var mode = take(4);
      if (mode === 0) break;
      var count, groups, k, v, s;
      if (mode === 1) {
        count = take(10); s = '';
        groups = Math.floor(count / 3);
        for (i = 0; i < groups; i++) { v = take(10); s += ('00' + v).slice(-3); }
        if (count % 3 === 2) { v = take(7); s += ('0' + v).slice(-2); }
        else if (count % 3 === 1) { v = take(4); s += String(v); }
        text += s;
      } else if (mode === 2) {
        count = take(9); s = '';
        groups = Math.floor(count / 2);
        for (i = 0; i < groups; i++) {
          v = take(11); s += ALNUM.charAt(Math.floor(v / 45)) + ALNUM.charAt(v % 45);
        }
        if (count % 2) { v = take(6); s += ALNUM.charAt(v); }
        text += s;
      } else if (mode === 4) {
        count = take(version < 10 ? 8 : 16);
        var bytes = [];
        for (k = 0; k < count; k++) bytes.push(take(8));
        text += utf8Text(bytes);
      } else return null;
      if (text.length > 300) return null;
    }
    if (!text) return null;
    /* 控制字符过滤：误码时通常会出现大量乱码 */
    var bad = 0;
    for (i = 0; i < text.length; i++) if (text.charCodeAt(i) < 32 && text.charCodeAt(i) !== 10) bad++;
    return bad > 2 ? null : text;
  }
  /* 格式信息不参与掩码，BCH 校验通过即可确定 mask，避免「猜 mask」解出乱码 */
  function readFormat(mods) {
    var size = mods.length, bits = 0, i, copy, f, d, rem, j;
    for (copy = 0; copy < 2; copy++) {
      bits = 0;
      if (copy === 0) {
        for (i = 0; i <= 5; i++) bits |= (mods[i][8] & 1) << i;
        bits |= (mods[7][8] & 1) << 6; bits |= (mods[8][8] & 1) << 7; bits |= (mods[8][7] & 1) << 8;
        for (i = 9; i < 15; i++) bits |= (mods[8][14 - i] & 1) << i;
      } else {
        for (i = 0; i < 8; i++) bits |= (mods[8][size - 1 - i] & 1) << i;
        for (i = 8; i < 15; i++) bits |= (mods[size - 15 + i][8] & 1) << i;
      }
      f = bits ^ 0x5412;
      if (f < 0 || f > 0x7fff) continue;
      d = f >>> 10; rem = d;
      for (j = 0; j < 10; j++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      if ((f & 0x3ff) === (rem & 0x3ff)) return { mask: d & 7, ec: (d >>> 3) & 3 };
    }
    return null;
  }
  function scoreText(t) {
    var s = 0, i, c;
    for (i = 0; i < t.length; i++) {
      c = t.charCodeAt(i);
      if (c >= 48 && c <= 57) s += 2;
      else if (c >= 97 && c <= 122) s += 2;
      else if (c >= 65 && c <= 90) s += 1;
      else if (c >= 0x4e00 && c <= 0x9fff) s += 3;
      else if (c === 45 || c === 46 || c === 47 || c === 58 || c === 32) s += 0;
      else s -= 3;
    }
    if (/0{4,}$/.test(t)) s -= 20;
    return s - t.length * 0.2;
  }
  function decodeMatrix(mods) {
    if (!mods || !mods.length || mods.length !== mods[0].length) return null;
    var size = mods.length;
    if (size < 21 || size > 37 || (size - 17) % 4 !== 0) return null;
    var version = (size - 17) / 4, res = reservedFor(size), m, t;
    var fmt = readFormat(mods);
    if (fmt) {
      try {
        t = parseBits(readBits(mods, res, fmt.mask), version);
        if (t && scoreText(t) > 0) return t;
      } catch (e) { }
    }
    /* 格式信息损坏时再遍历掩码，按文本合理性挑最优 */
    var best = null, bs = -1e9;
    for (m = 0; m < 8; m++) {
      try {
        t = parseBits(readBits(mods, res, m), version);
        if (!t) continue;
        var s = scoreText(t);
        if (s > bs) { bs = s; best = t; }
      } catch (e2) { }
    }
    return bs > 0 ? best : null;
  }
  function grayImage(img) {
    var w = img.width, h = img.height, d = img.data, g = new Uint8Array(w * h), i, k;
    for (i = 0; i < w * h; i++) {
      k = i * 4;
      g[i] = (d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29) >> 8;
    }
    return g;
  }
  function decodeImage(img) {
    if (!img || !img.data || !img.width || !img.height) return null;
    var w = img.width, h = img.height, g = grayImage(img), x, y, i;
    var bw = new Uint8Array(w * h), sum = 0;
    for (i = 0; i < g.length; i++) sum += g[i];
    var th = sum / g.length * 0.82;
    for (i = 0; i < g.length; i++) bw[i] = g[i] < th ? 1 : 0;
    /* 逐行找 1:1:3:1:1 的定位符，收集中心与模块宽 */
    var hits = [];
    for (y = 2; y < h - 2; y += 1) {
      var runs = [], last = bw[y * w], len = 1;
      for (x = 1; x < w; x++) {
        if (bw[y * w + x] === last) len++;
        else { runs.push({ v: last, n: len }); last = bw[y * w + x]; len = 1; }
      }
      runs.push({ v: last, n: len });
      for (i = 0; i + 4 < runs.length; i++) {
        var a = runs[i], b = runs[i + 1], c = runs[i + 2], d2 = runs[i + 3], e = runs[i + 4];
        if (!a.v || b.v || !c.v || d2.v || !e.v) continue;
        var unit = (a.n + b.n + d2.n + e.n) / 4;
        if (unit < 1.5 || c.n < unit * 2.2 || c.n > unit * 3.8) continue;
        if (Math.abs(a.n - unit) > unit * 0.6 || Math.abs(e.n - unit) > unit * 0.6) continue;
        var px = 0;
        for (var q = 0; q < i; q++) px += runs[q].n;
        hits.push({ x: px + a.n + b.n + c.n / 2, y: y, unit: unit });
      }
    }
    if (hits.length < 12) return null;
    /* 按 x 聚类：同一列定位符会跨多行重复命中，取命中数最多的几组，避免数据区伪图形干扰 */
    var groups = [], i2, k;
    hits.sort(function (p, q) { return p.x - q.x; });
    for (i2 = 0; i2 < hits.length; i2++) {
      var hit = hits[i2], grp = null;
      for (k = 0; k < groups.length; k++) if (Math.abs(groups[k].x - hit.x) < 4) { grp = groups[k]; break; }
      if (!grp) { grp = { x: hit.x, pts: [] }; groups.push(grp); }
      grp.pts.push(hit);
      grp.x = (grp.x * (grp.pts.length - 1) + hit.x) / grp.pts.length;
    }
    groups = groups.filter(function (gg) { return gg.pts.length >= 3; })
      .sort(function (a, b) { return b.pts.length - a.pts.length; }).slice(0, 3)
      .sort(function (a, b) { return a.x - b.x; });
    if (groups.length < 2) return null;
    var left = groups[0], right = groups[groups.length - 1];
    function avg(list) { var s = 0, z; for (z = 0; z < list.length; z++) s += list[z]; return list.length ? s / list.length : 0; }
    function ysOf(gg) { return gg.pts.map(function (p) { return p.y; }).sort(function (a, b) { return a - b; }); }
    function splitYs(ys) {
      var gap = 0, at = 0, z;
      for (z = 1; z < ys.length; z++) if (ys[z] - ys[z - 1] > gap) { gap = ys[z] - ys[z - 1]; at = z; }
      return gap > 4 ? [avg(ys.slice(0, at)), avg(ys.slice(at))] : null;
    }
    var leftYs = ysOf(left), split = splitYs(leftYs);
    var tlY = split ? split[0] : avg(leftYs);
    var blY = split ? split[1] : avg(ysOf(right));
    var units = [];
    groups.forEach(function (gg) { gg.pts.forEach(function (p) { units.push(p.unit); }); });
    var unit = avg(units);
    if (!(unit > 1)) return null;
    var span = (right.x - left.x + Math.max(0, blY - tlY)) / 2;
    var size = 17 + 4 * Math.round((Math.round(span / unit) + 7 - 17) / 4);
    if (size < 21 || size > 37) return null;
    var sizes = [size], s, dx, dy, du, yy, xx, sx, sy, mods, t;
    if (size - 4 >= 21) sizes.push(size - 4);
    if (size + 4 <= 37) sizes.push(size + 4);
    var offsets = [0, -1, 1], scaleFix = [0, -0.06, 0.06];
    /* 定位与模块宽可能有 1 像素级误差，小范围多候选采样，取第一个能解出的 */
    for (s = 0; s < sizes.length; s++) {
      for (dx = 0; dx < 3; dx++) for (dy = 0; dy < 3; dy++) for (du = 0; du < 3; du++) {
        var u = unit * (1 + scaleFix[du]);
        mods = [];
        for (yy = 0; yy < sizes[s]; yy++) {
          mods.push([]);
          for (xx = 0; xx < sizes[s]; xx++) {
            sx = Math.round(left.x + offsets[dx] + (xx - 3) * u);
            sy = Math.round(tlY + offsets[dy] + (yy - 3) * u);
            mods[yy].push(sx >= 0 && sx < w && sy >= 0 && sy < h ? bw[sy * w + sx] : 0);
          }
        }
        t = decodeMatrix(mods);
        if (t) return t;
      }
    }
    return null;
  }
  /* 测试与预览用：把模块矩阵放大成 ImageData 结构 */
  function modulesToImage(r, scale, quiet) {
    scale = scale || 4; quiet = quiet === undefined ? 4 : quiet;
    var n = (r.size + quiet * 2) * scale, w = n, h = n;
    var data = new Uint8ClampedArray(w * h * 4), y, x, k;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      var mx = Math.floor(x / scale) - quiet, my = Math.floor(y / scale) - quiet;
      var dark = mx >= 0 && my >= 0 && mx < r.size && my < r.size && r.modules[my][mx];
      var v = dark ? 8 : 250;
      k = (y * w + x) * 4; data[k] = v; data[k + 1] = v; data[k + 2] = v; data[k + 3] = 255;
    }
    return { width: w, height: h, data: data };
  }

  var out = {
    version: '2.1.0', encode: encode, build: build, svg: svg,
    decodeMatrix: decodeMatrix, decodeImage: decodeImage, modulesToImage: modulesToImage,
    reservedFor: reservedFor, maskBit: maskBit
  };
  if (typeof module !== 'undefined' && module.exports) { module.exports = out; global.StationQr = out; }
  else global.StationQr = out;
})(typeof window !== 'undefined' ? window : globalThis);
