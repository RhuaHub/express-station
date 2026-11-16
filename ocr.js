/* 驿站助手（重建版）· 离线 OCR / 条码识别引擎
   纯 JS、零依赖、不联网、不上传照片：canvas 取像素 → 自适应二值化 → 游程扫描
   → 一维条码解码（Code128 / EAN-13 / UPC-A / ITF / Code39）+ 印刷数字模板识别。
   兼容老 Android WebView：ES5 语法、无 classList / closest / NodeList.forEach /
   无 Array.findIndex、无 BarcodeDetector 也能工作；全程有耗时上限，永不抛异常。
   编码表来源：ZXing Code128Reader / Code39Reader / ITFReader / UPC-EAN 表。 */
(function (global) {
  'use strict';

  /* ---------------- 编码表 ---------------- */
  /* Code128：107 个码字，6 位条/空宽度；最后一项是 7 元素的 STOP */
  var C128 = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
  ];
  /* Code39：9 元素宽窄掩码（1=宽），43 个字符；'*' 单独作起止符 */
  var C39_ENC = [
    0x034, 0x121, 0x061, 0x160, 0x031, 0x130, 0x070, 0x025, 0x124, 0x064,
    0x109, 0x049, 0x148, 0x019, 0x118, 0x058, 0x00D, 0x10C, 0x04C, 0x01C,
    0x103, 0x043, 0x142, 0x013, 0x112, 0x052, 0x007, 0x106, 0x046, 0x016,
    0x181, 0x0C1, 0x1C0, 0x091, 0x190, 0x0D0, 0x085, 0x184, 0x0C4, 0x0A8,
    0x0A2, 0x08A, 0x02A
  ];
  var C39_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';
  var C39_STAR = 0x094;
  /* EAN/UPC：4 段宽度表，0-9 = L，10-19 = G（L 的逆序）；右半用 L 表 */
  var EAN_LG = [
    [3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2],
    [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2],
    [1, 1, 2, 3], [1, 2, 2, 2], [2, 2, 1, 2], [1, 1, 4, 1], [2, 3, 1, 1],
    [1, 3, 2, 1], [4, 1, 1, 1], [2, 1, 3, 1], [3, 1, 2, 1], [2, 1, 1, 3]
  ];
  var EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
    'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  /* ITF（交插二五码）：窄=1，宽=2 */
  var ITF_PAT = [
    [1, 1, 2, 2, 1], [2, 1, 1, 1, 2], [1, 2, 1, 1, 2], [2, 2, 1, 1, 1], [1, 1, 2, 1, 2],
    [2, 1, 2, 1, 1], [1, 2, 2, 1, 1], [1, 1, 1, 2, 2], [2, 1, 1, 2, 1], [1, 2, 1, 2, 1]
  ];

  /* ---------------- 通用小工具 ---------------- */
  function num(c) { return c.charCodeAt(0) - 48; }
  function patSum(s) { var t = 0; for (var i = 0; i < s.length; i++) t += num(s.charAt(i)); return t; }
  function pushUnique(arr, s) {
    if (!s) return;
    for (var i = 0; i < arr.length; i++) if (arr[i] === s) return;
    arr.push(s);
  }
  /* 游程序列与码字模式的平均绝对偏差；按总宽归一化，抗缩放与轻微倾斜 */
  function variance(runs, off, pattern, len, patTotal) {
    var total = 0, i;
    for (i = 0; i < len; i++) {
      if (runs[off + i] === undefined) return 99;
      total += runs[off + i];
    }
    if (total <= 0) return 99;
    var unit = total / (patTotal || 11), v = 0, want;
    for (i = 0; i < len; i++) {
      want = typeof pattern === 'string' ? num(pattern.charAt(i)) : pattern[i];
      v += Math.abs(runs[off + i] / unit - want);
    }
    return v / len;
  }
  function varianceArr(runs, off, pattern) {
    var total = 0, i;
    for (i = 0; i < pattern.length; i++) {
      if (runs[off + i] === undefined) return 99;
      total += runs[off + i];
    }
    var ptotal = 0;
    for (i = 0; i < pattern.length; i++) ptotal += pattern[i];
    if (total <= 0 || ptotal <= 0) return 99;
    var unit = total / ptotal, v = 0;
    for (i = 0; i < pattern.length; i++) v += Math.abs(runs[off + i] / unit - pattern[i]);
    return v / pattern.length;
  }
  function cleanText(t) {
    var s = String(t || '').replace(/[^A-Za-z0-9\-\.\/ ]/g, '').toUpperCase().replace(/\s+/g, '');
    return s;
  }

  /* ---------------- 纯函数解码器（入参：从黑条开始的交替游程宽度数组） ---------------- */
  function decodeCode128(runs, deadline, loose) {
    var n = runs.length, s, c, d, i;
    if (n < 20) return '';
    /* loose：细条码 / 取整锯齿导致宽度比例失真时用，仍靠 mod103 校验位把关 */
    var startLimit = loose ? 0.52 : 0.36, codeLimit = loose ? 0.50 : 0.34,
      stopLimit = loose ? 0.44 : 0.30;
    /* 面单上条码左侧常有文字/边框，把整行都纳入起点搜索（只取黑段起点，步进 2）。
       放宽的匹配阈值由 mod103 校验位兜底，不会因此产生误报。 */
    var maxStart = n - 20;
    for (s = 0; s <= maxStart; s += 2) {
      if (deadline && (s & 15) === 0 && Date.now() > deadline) return '';
      var startCode = -1, best = startLimit;
      for (c = 103; c <= 105; c++) {
        var v = variance(runs, s, C128[c], 6, 11);
        if (v < best) { best = v; startCode = c; }
      }
      if (startCode < 0) continue;
      var codes = [], pos = s + 6, guard = 0, done = false;
      while (pos + 6 <= n && guard++ < 70) {
        if (deadline && (guard % 8 === 0) && Date.now() > deadline) return '';
        if (variance(runs, pos, C128[106], 6, 11) < stopLimit) { done = true; break; }
        var bv = codeLimit, bi = -1;
        for (d = 0; d < 106; d++) {
          var dv = variance(runs, pos, C128[d], 6, 11);
          if (dv < bv) { bv = dv; bi = d; }
        }
        if (bi < 0) break;
        codes.push(bi);
        pos += 6;
      }
      if (!done || codes.length < 2) continue;
      /* 校验：最后一个码字 = (start + Σ(i * data_i)) mod 103（ZXing 口径） */
      var sum = startCode;
      for (i = 0; i < codes.length - 1; i++) sum += (i + 1) * codes[i];
      if (sum % 103 !== codes[codes.length - 1]) continue;
      var text = parse128(codes.slice(0, codes.length - 1), startCode);
      if (text && text.length >= 4) return text;
    }
    return '';
  }
  function parse128(codes, startCode) {
    var mode = startCode === 103 ? 'A' : startCode === 104 ? 'B' : 'C';
    var out = '', shift = false, i;
    for (i = 0; i < codes.length; i++) {
      var c = codes[i], eff = mode;
      if (c === 98) { shift = true; continue; }
      if (c === 99) { mode = 'C'; continue; }
      if (c === 100) { mode = 'B'; continue; }
      if (c === 101) { mode = 'A'; continue; }
      if (c === 96 || c === 97 || c === 102) continue; /* FNC 忽略 */
      if (shift) { eff = mode === 'A' ? 'B' : 'A'; shift = false; }
      if (eff === 'C') {
        out += (c < 10 ? '0' : '') + c;
      } else if (eff === 'B') {
        out += String.fromCharCode(32 + c);
      } else {
        out += c < 64 ? String.fromCharCode(32 + c) : String.fromCharCode(c - 64);
      }
    }
    return cleanText(out.replace(/\s+$/, ''));
  }

  function narrowWideMask(nine) {
    var sorted = nine.slice(0, 9).sort(function (a, b) { return a - b; });
    var narrow = sorted[1] || sorted[0];
    if (!narrow) return -1;
    var mask = 0, wide = 0, i;
    for (i = 0; i < 9; i++) {
      mask = mask * 2;
      if (nine[i] >= narrow * 1.55) { mask += 1; wide++; }
    }
    return wide === 3 ? mask : -1;
  }
  function decodeCode39(runs, deadline) {
    var n = runs.length, s;
    if (n < 30) return '';
    for (s = 0; s <= n - 30; s += 2) {
      if (deadline && (s & 15) === 0 && Date.now() > deadline) return '';
      if (narrowWideMask(runs.slice(s, s + 9)) !== C39_STAR) continue;
      var pos = s + 10, out = '', end = false, guard = 0;
      while (pos + 9 <= n && guard++ < 45) {
        var m = narrowWideMask(runs.slice(pos, pos + 9));
        if (m < 0) break;
        if (m === C39_STAR) { end = true; break; }
        var idx = -1;
        for (var k = 0; k < C39_ENC.length; k++) if (C39_ENC[k] === m) { idx = k; break; }
        if (idx < 0) break;
        out += C39_CHARS.charAt(idx);
        pos += 10;
      }
      if (end && cleanText(out).length >= 4) return cleanText(out);
    }
    return '';
  }

  function decodeEAN(runs, deadline) {
    var n = runs.length, s, k, i;
    if (n < 59) return '';
    for (s = 0; s <= n - 59; s += 2) {
      if (deadline && (s & 15) === 0 && Date.now() > deadline) return '';
      /* 左护线 101 → 3 段近似等宽 */
      var g = varianceArr(runs, s, [1, 1, 1]);
      if (g > 0.28) continue;
      var pos = s + 3, left = '', parity = '', digits = '', ok = true;
      for (k = 0; k < 6; k++) {
        var bv = 0.36, bi = -1;
        for (i = 0; i < 20; i++) {
          var v = varianceArr(runs, pos + k * 4, EAN_LG[i]);
          if (v < bv) { bv = v; bi = i; }
        }
        if (bi < 0) { ok = false; break; }
        left += String(bi % 10);
        parity += bi >= 10 ? 'G' : 'L';
      }
      if (!ok) continue;
      pos += 24;
      if (varianceArr(runs, pos, [1, 1, 1, 1, 1]) > 0.30) continue; /* 中间护线 01010 */
      pos += 5;
      var right = '';
      for (k = 0; k < 6; k++) {
        var rv = 0.36, ri = -1;
        for (i = 0; i < 10; i++) {
          var vv = varianceArr(runs, pos + k * 4, EAN_LG[i]);
          if (vv < rv) { rv = vv; ri = i; }
        }
        if (ri < 0) { ok = false; break; }
        right += String(ri);
      }
      if (!ok) continue;
      pos += 24;
      if (varianceArr(runs, pos, [1, 1, 1]) > 0.30) continue; /* 右护线 101 */
      var first = -1;
      for (i = 0; i < EAN_PARITY.length; i++) if (EAN_PARITY[i] === parity) { first = i; break; }
      if (first < 0) continue;
      digits = first === 0 ? '' : String(first);
      digits += left + right;
      if (!eanCheck(digits.length === 12 ? '0' + digits : digits)) continue;
      return digits;
    }
    return '';
  }
  function eanCheck(d) {
    if (d.length !== 13) return false;
    var sum = 0;
    for (var i = 0; i < 12; i++) sum += num(d.charAt(i)) * (i % 2 === 0 ? 1 : 3);
    return (10 - sum % 10) % 10 === num(d.charAt(12));
  }

  function itfDigit(five) {
    var bv = 0.40, bi = -1, i;
    for (i = 0; i < 10; i++) {
      var v = varianceArr(five, 0, ITF_PAT[i]);
      if (v < bv) { bv = v; bi = i; }
    }
    return bi;
  }
  function decodeITF(runs, deadline) {
    var n = runs.length, s;
    if (n < 24) return '';
    for (s = 0; s <= n - 24; s += 2) {
      if (deadline && (s & 15) === 0 && Date.now() > deadline) return '';
      var base = (runs[s] + runs[s + 1] + runs[s + 2] + runs[s + 3]) / 4;
      if (!base || varianceArr(runs, s, [1, 1, 1, 1]) > 0.24) continue;
      /* 无校验码制：要求起始符后确实是密集窄条区，文字行的宽黑块在这里会被排除 */
      var dense = true, q;
      for (q = s + 4; q < Math.min(n, s + 14); q++) if (runs[q] > base * 3.2) { dense = false; break; }
      if (!dense) continue;
      var pos = s + 4, out = '', guard = 0, k;
      while (pos + 10 <= n && guard++ < 30) {
        /* 终止：宽条 + 窄空 + 窄条；只在真正接近序列末尾才认 */
        if (pos + 8 >= n && runs[pos] > base * 1.55 &&
            runs[pos + 1] < base * 1.35 && runs[pos + 2] < base * 1.35) break;
        var bars = [], spaces = [];
        for (k = 0; k < 5; k++) {
          bars.push(runs[pos + 2 * k] / base);
          spaces.push(runs[pos + 2 * k + 1] / base);
        }
        var d1 = itfDigit(bars), d2 = itfDigit(spaces);
        if (d1 < 0 || d2 < 0) break;
        out += String(d1) + String(d2);
        pos += 10;
      }
      /* 少于 8 位几乎都是噪点误报；真实 ITF 面单至少 8 位 */
      if (out.length >= 8 && out.length % 2 === 0) return out;
    }
    return '';
  }
  /* verified = 码制自带校验位（Code128 / EAN），可作为最终结果且优先于无校验候选 */
  function decodeAny(runs, deadline, loose) {
    var out = [], t;
    t = decodeCode128(runs, deadline, loose); if (t) out.push({ text: t, format: 'Code128', weight: loose ? 0.86 : 1.0, verified: true, loose: !!loose });
    /* 宽松重解只跑自带校验位的 Code128，避免无校验码制借机误报 */
    if (loose) return out;
    t = decodeEAN(runs, deadline); if (t) out.push({ text: t, format: 'EAN/UPC', weight: 1.0, verified: true });
    t = decodeCode39(runs, deadline); if (t) out.push({ text: t, format: 'Code39', weight: 0.62, verified: false });
    t = decodeITF(runs, deadline); if (t) out.push({ text: t, format: 'ITF', weight: 0.55, verified: false });
    return out;
  }

  /* ---------------- 图像预处理 ---------------- */
  function pixelsOf(source) {
    if (!source) return null;
    if (source.data && source.width && source.height) {
      return { w: source.width, h: source.height, data: source.data };
    }
    if (source.getContext) {
      var ctx = source.getContext('2d');
      if (!ctx || !ctx.getImageData) return null;
      var im = ctx.getImageData(0, 0, source.width, source.height);
      return { w: im.width, h: im.height, data: im.data };
    }
    return null;
  }
  function grayOf(px) {
    var w = px.w, h = px.h, d = px.data, out = new Uint8Array(w * h), i, j = 0;
    for (i = 0; i < w * h; i++, j += 4) {
      out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    }
    return out;
  }
  function downGray(g, w, h, maxSide) {
    var scale = Math.min(1, maxSide / Math.max(w, h));
    if (scale >= 1) return { g: g, w: w, h: h };
    var nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    var out = new Uint8Array(nw * nh), x, y;
    for (y = 0; y < nh; y++) {
      var sy = Math.min(h - 1, Math.floor(y / scale));
      for (x = 0; x < nw; x++) out[y * nw + x] = g[sy * w + Math.min(w - 1, Math.floor(x / scale))];
    }
    return { g: out, w: nw, h: nh };
  }
  /* 局部均值自适应二值化：用积分图，O(w*h)，抗面单明暗不均 */
  function binarize(g, w, h, factor) {
    factor = factor || 0.80;
    var integral = new Float64Array((w + 1) * (h + 1)), x, y;
    for (y = 0; y < h; y++) {
      var row = 0;
      for (x = 0; x < w; x++) {
        row += g[y * w + x];
        integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
      }
    }
    var r = Math.max(6, Math.round(w / 90)), out = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (x = 0; x < w; x++) {
        var x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
        var sum = integral[(y1 + 1) * (w + 1) + x1 + 1] - integral[y0 * (w + 1) + x1 + 1]
          - integral[(y1 + 1) * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
        var area = (x1 - x0 + 1) * (y1 - y0 + 1);
        /* 0.80：浅灰噪点不至于被判成黑条，深色印刷笔画仍保留 */
        out[y * w + x] = g[y * w + x] < (sum / area) * factor ? 1 : 0;
      }
    }
    return out;
  }
  /* 去孤立黑点：4 邻域里黑点少于 2 个就抹掉。
     条码竖条上下相连会保留，照片噪点这种单点会被清掉，避免打断游程。 */
  function despeckle(bw, w, h) {
    var out = new Uint8Array(bw.length), x, y, i;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x;
      if (!bw[i]) { out[i] = 0; continue; }
      var n = 0;
      if (y > 0 && bw[i - w]) n++;
      if (y + 1 < h && bw[i + w]) n++;
      if (x > 0 && bw[i - 1]) n++;
      if (x + 1 < w && bw[i + 1]) n++;
      out[i] = n >= 2 ? 1 : 0;
    }
    return out;
  }

  /* 从某行/列取交替游程；跳过前导白，返回以黑段开头的宽度数组 */
  function runsFrom(getter, len, invert) {
    var x = 0;
    function isBlack(v) { return invert ? v === 0 : v === 1; }
    while (x < len && !isBlack(getter(x))) x++;
    if (x >= len) return [];
    var runs = [], count = 0, cur = true;
    for (; x < len; x++) {
      var black = isBlack(getter(x));
      if (black === cur) count++;
      else { runs.push(count); cur = black; count = 1; }
    }
    runs.push(count);
    return runs;
  }
  function rowRuns(bw, w, y, invert) {
    var base = y * w;
    return runsFrom(function (x) { return bw[base + x]; }, w, invert);
  }
  function colRuns(bw, w, h, x, invert) {
    return runsFrom(function (y) { return bw[y * w + x]; }, h, invert);
  }
  /* 三行多数投票：条码竖条垂直连续会保留，只出现在一行的噪点被抹掉 */
  function smoothRow(bw, w, h, y, invert) {
    var line = new Uint8Array(w), x;
    var y0 = Math.max(0, y - 1), y2 = Math.min(h - 1, y + 1);
    for (x = 0; x < w; x++) {
      var n = bw[y0 * w + x] + bw[y * w + x] + bw[y2 * w + x];
      var v = n >= 2 ? 1 : 0;
      line[x] = invert ? 1 - v : v;
    }
    return runsFrom(function (i) { return line[i]; }, w, false);
  }

  /* ---------------- 印刷数字 OCR（辅助通道） ---------------- */
  var FONT_5x7 = [
    '01110/10001/10011/10101/11001/10001/01110', /* 0 */
    '00100/01100/00100/00100/00100/00100/01110', /* 1 */
    '01110/10001/00001/00010/00100/01000/11111', /* 2 */
    '11110/00001/00001/01110/00001/00001/11110', /* 3 */
    '00010/00110/01010/10010/11111/00010/00010', /* 4 */
    '11111/10000/10000/11110/00001/00001/11110', /* 5 */
    '00110/01000/10000/11110/10001/10001/01110', /* 6 */
    '11111/00001/00010/00100/01000/01000/01000', /* 7 */
    '01110/10001/10001/01110/10001/10001/01110', /* 8 */
    '01110/10001/10001/01111/00001/00010/01100'  /* 9 */
  ];
  var GW = 10, GH = 14;
  function scaleFont(rows) {
    var parts = rows.split('/'), out = new Uint8Array(GW * GH), y, x;
    for (y = 0; y < GH; y++) {
      var line = parts[Math.floor(y / 2)] || '00000';
      for (x = 0; x < GW; x++) out[y * GW + x] = line.charAt(Math.floor(x / 2)) === '1' ? 1 : 0;
    }
    return out;
  }
  function morph(src, grow) {
    var out = new Uint8Array(GW * GH), y, x, k;
    var nb = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]];
    for (y = 0; y < GH; y++) for (x = 0; x < GW; x++) {
      var hit = 0;
      for (k = 0; k < 5; k++) {
        var yy = y + nb[k][0], xx = x + nb[k][1];
        var v = (yy >= 0 && yy < GH && xx >= 0 && xx < GW) ? src[yy * GW + xx] : 0;
        if (grow ? v : !v) { hit = 1; break; }
      }
      out[y * GW + x] = grow ? hit : (hit ? 0 : src[y * GW + x]);
    }
    return out;
  }
  var TEMPLATES = null;
  function templates() {
    if (TEMPLATES) return TEMPLATES;
    TEMPLATES = [];
    for (var d = 0; d < 10; d++) {
      var base = scaleFont(FONT_5x7[d]);
      TEMPLATES.push({ digit: d, bits: base });
      TEMPLATES.push({ digit: d, bits: morph(base, true) });
      TEMPLATES.push({ digit: d, bits: morph(base, false) });
    }
    return TEMPLATES;
  }
  /* 等比缩放并居中：连通域只框住笔画，直接拉伸会把细长的「1」拉胖 */
  function glyphBits(bw, w, box) {
    var out = new Uint8Array(GW * GH), y, x;
    var scale = Math.min(GW / box.w, GH / box.h);
    var dw = Math.max(1, Math.round(box.w * scale)), dh = Math.max(1, Math.round(box.h * scale));
    var ox = Math.floor((GW - dw) / 2), oy = Math.floor((GH - dh) / 2);
    for (y = 0; y < dh; y++) {
      var sy = box.y + Math.min(box.h - 1, Math.floor(y / scale));
      for (x = 0; x < dw; x++) {
        var sx = box.x + Math.min(box.w - 1, Math.floor(x / scale));
        out[(oy + y) * GW + ox + x] = bw[sy * w + sx] ? 1 : 0;
      }
    }
    return out;
  }
  function matchGlyph(bits) {
    var tpl = templates(), bestD = -1, bestDist = 9, i, k;
    for (i = 0; i < tpl.length; i++) {
      var dist = 0;
      for (k = 0; k < GW * GH; k++) if (bits[k] !== tpl[i].bits[k]) dist++;
      dist = dist / (GW * GH);
      if (dist < bestDist) { bestDist = dist; bestD = tpl[i].digit; }
    }
    return { digit: bestDist <= 0.40 ? bestD : -1, dist: bestDist };
  }
  /* 连通域 → 字符框 → 数字串；只在条码没解出来或作为补充时调用 */
  function readDigits(bw, w, h, deadline) {
    var labels = new Int32Array(w * h), boxes = [], stack = [], y, x, i, k;
    var nb = [-1, 0, 1];
    for (y = 0; y < h; y++) {
      if (y % 24 === 0 && Date.now() > deadline) return [];
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (bw[i] !== 1 || labels[i] !== 0) continue;
        var id = boxes.length + 1, minX = x, maxX = x, minY = y, maxY = y, area = 0;
        labels[i] = id; stack.length = 0; stack.push(i);
        while (stack.length) {
          var p = stack.pop(), py = Math.floor(p / w), px = p - py * w;
          area++;
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (py < minY) minY = py; if (py > maxY) maxY = py;
          for (k = 0; k < 9; k++) {
            var dy = nb[Math.floor(k / 3)], dx = nb[k % 3], ny = py + dy, nx = px + dx;
            if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
            var q = ny * w + nx;
            if (bw[q] === 1 && labels[q] === 0) { labels[q] = id; stack.push(q); }
          }
        }
        if (boxes.length < 4000) boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, area: area });
      }
    }
    var chars = [];
    for (i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      /* 极细长条是条码竖线，不是数字笔画 */
      if (b.h < 9 || b.h > h * 0.92 || b.w > b.h * 1.6 || b.w < 2 || b.w < b.h * 0.09) continue;
      if (b.area / (b.w * b.h) < 0.08) continue;
      var m = matchGlyph(glyphBits(bw, w, b));
      chars.push({ x: b.x, y: b.y, h: b.h, w: b.w, digit: m.digit, conf: 1 - m.dist });
    }
    chars.sort(function (a, b) { return a.y - b.y || a.x - b.x; });
    var out = [], rows = [], j;
    for (i = 0; i < chars.length; i++) {
      var placed = false;
      for (j = 0; j < rows.length; j++) {
        if (Math.abs(rows[j].cy - (chars[i].y + chars[i].h / 2)) < Math.max(6, chars[i].h * 0.45)) {
          rows[j].items.push(chars[i]); placed = true; break;
        }
      }
      if (!placed) rows.push({ cy: chars[i].y + chars[i].h / 2, items: [chars[i]] });
    }
    for (j = 0; j < rows.length; j++) {
      var items = rows[j].items;
      items.sort(function (a, b) { return a.x - b.x; });
      var hs = items.map(function (o) { return o.h; }).sort(function (a, b) { return a - b; });
      var limit = (hs[Math.floor(hs.length / 2)] || 14) * 1.25;
      var cur = '', conf = 0, cnt = 0, lastX = null;
      for (i = 0; i < items.length; i++) {
        var c = items[i], gap = lastX === null ? 0 : c.x - lastX;
        if (lastX !== null && gap > limit) {
          if (cur.length >= 4 && conf / cnt >= 0.60) out.push({ text: cur, confidence: conf / cnt });
          cur = ''; conf = 0; cnt = 0;
        }
        if (c.digit < 0) { cur = ''; conf = 0; cnt = 0; }
        else { cur += String(c.digit); conf += c.conf; cnt++; }
        lastX = c.x + c.w;
      }
      if (cur.length >= 4 && cnt && conf / cnt >= 0.60) out.push({ text: cur, confidence: conf / cnt });
    }
    out.sort(function (a, b) { return b.text.length - a.text.length; });
    var seen = {}, res = [];
    for (i = 0; i < out.length && res.length < 6; i++) {
      if (seen[out[i].text] || junkDigitString(out[i].text)) continue;
      seen[out[i].text] = 1;
      res.push(out[i]);
    }
    return res;
  }
  /* 过滤条码竖线 / 边框线被当成数字串的情况：太长，或几乎全是同一个数字 */
  function junkDigitString(s) {
    if (s.length < 4 || s.length > 20) return true;
    var counts = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], max = 0, i;
    for (i = 0; i < s.length; i++) {
      var d = num(s.charAt(i));
      if (d >= 0 && d <= 9) { counts[d]++; if (counts[d] > max) max = counts[d]; }
    }
    return max > Math.max(5, Math.floor(s.length * 0.72));
  }

  /* ---------------- 主扫描 ---------------- */
  /* 游程去毛刺：把异常窄的段连同它后面的段一起并入前一段（成对删，保持奇偶）。
     照片噪点常把一条黑/白游程切成两段，合并后条码宽度序列即可复原。 */
  function denoiseRuns(runs) {
    if (runs.length < 12) return runs;
    var sorted = runs.slice().sort(function (a, b) { return a - b; });
    var med = sorted[Math.floor(sorted.length * 0.6)] || 1;
    var minW = Math.max(1, Math.round(med * 0.34));
    var out = runs.slice(), guard = 0, i, changed = true;
    while (changed && guard++ < 24) {
      changed = false;
      for (i = 1; i < out.length - 1; i++) {
        if (out[i] < minW) {
          out[i - 1] = out[i - 1] + out[i] + out[i + 1];
          out.splice(i, 2);
          changed = true;
          break;
        }
      }
    }
    return out;
  }
  function shrinkBinary(bw, w, h, maxSide) {
    var scale = Math.min(1, maxSide / Math.max(w, h));
    if (scale >= 1) return { bw: bw, w: w, h: h };
    var nw = Math.max(1, Math.round(w * scale)), nh = Math.max(1, Math.round(h * scale));
    var out = new Uint8Array(nw * nh), x, y;
    for (y = 0; y < nh; y++) {
      var sy = Math.min(h - 1, Math.floor(y / scale));
      for (x = 0; x < nw; x++) out[y * nw + x] = bw[sy * w + Math.min(w - 1, Math.floor(x / scale))];
    }
    return { bw: out, w: nw, h: nh };
  }
  /* ---------------- 主扫描：多通道投票 ----------------
     真实面单会有倾斜、模糊、明暗不均、条码左侧一堆文字。单通道扫描在老 WebView 上
     要么解不出，要么被无校验码制（ITF/Code39）误报盖过。这里按「常规 → 对比度增强
     → 倾斜校正」逐级加通道，所有通道共用一份投票表，最后统一按可信度裁决。 */
  function newVotes() {
    return { map: Object.create ? Object.create(null) : {}, order: [] };
  }
  function addVote(V, hit, lineId) {
    var t = hit.text;
    if (!t) return;
    var v = V.map[t];
    if (!v) {
      v = V.map[t] = { text: t, format: hit.format, weight: hit.weight,
        verified: !!hit.verified, strict: !hit.loose, count: 0, lines: 0, seen: {} };
      V.order.push(t);
    }
    v.count++;
    if (hit.verified) v.verified = true;
    if (!hit.loose) v.strict = true;
    var key = String(lineId);
    if (!v.seen[key]) { v.seen[key] = 1; v.lines++; }
  }
  function strongVerified(V) {
    var i, v;
    for (i = 0; i < V.order.length; i++) {
      v = V.map[V.order[i]];
      /* 提前收工要保守：短串 / 宽松档 / 票数少都不能算「已确定」 */
      if (v.verified && v.strict && v.count >= 3 && v.lines >= 2 && v.text.length >= 10) return v;
    }
    return null;
  }
  function collectLine(V, raw, lineId, deadline) {
    if (!raw || raw.length < 20 || Date.now() > deadline) return;
    var r = denoiseRuns(raw), k, oi, sub, list;
    /* 解码器已整行搜起点，只需 0 / 2 两个奇偶偏移应对前导噪点 */
    for (oi = 0; oi < 2; oi++) {
      if (Date.now() > deadline) return;
      sub = oi === 0 ? r : (r.length > 22 ? r.slice(2) : null);
      if (!sub) continue;
      list = decodeAny(sub, deadline, false);
      var hasVerified = false;
      for (k = 0; k < list.length; k++) {
        addVote(V, list[k], lineId + ':' + oi);
        if (list[k].verified) hasVerified = true;
      }
      /* 细条码 / 取整锯齿：严格档没解出来时，用宽松档再解一次带校验位的 Code128 */
      if (!hasVerified && Date.now() < deadline - 40) {
        var loose = decodeAny(sub, deadline, true);
        for (k = 0; k < loose.length; k++) {
          if (loose[k].verified) addVote(V, loose[k], lineId + ':L' + oi);
        }
      }
    }
  }
  function scanPass(bw, w, h, V, deadline, passId) {
    /* 倾斜条码常常只有很窄一条「完整行」，步长必须够密 */
    var y, x, invert, lineId = 0, stepY = Math.max(2, Math.floor(h / 200)), lid;
    /* 单行游程对倾斜更稳，三行投票对噪点更稳，两条都收 */
    for (y = Math.floor(h * 0.05); y < h * 0.95 && Date.now() <= deadline; y += stepY) {
      for (invert = 0; invert < 2; invert++) {
        lid = passId * 1000000 + lineId++;
        collectLine(V, rowRuns(bw, w, Math.floor(y), invert), lid, deadline);
        collectLine(V, smoothRow(bw, w, h, Math.floor(y), invert), lid + 400000, deadline);
      }
      if (strongVerified(V)) return true;
    }
    /* 竖扫：面单横过来拍、条码竖着 */
    var stepX = Math.max(3, Math.floor(w / 12));
    for (x = Math.floor(w * 0.05); x < w * 0.95 && Date.now() <= deadline; x += stepX) {
      for (invert = 0; invert < 2; invert++) {
        collectLine(V, colRuns(bw, w, h, Math.floor(x), invert),
          passId * 1000000 + 700000 + lineId++, deadline);
      }
      if (strongVerified(V)) return true;
    }
    return false;
  }
  /* 沿斜线取游程：不重建整图，覆盖 ±13° 左右的倾斜 */
  function skewRuns(bw, w, h, y, slope, invert) {
    var line = new Uint8Array(w), x, yy;
    for (x = 0; x < w; x++) {
      yy = y + Math.round((x - w / 2) * slope);
      var v = (yy >= 0 && yy < h) ? bw[yy * w + x] : 0;
      line[x] = invert ? 1 - v : v;
    }
    return runsFrom(function (i) { return line[i]; }, w, false);
  }
  function scanSkew(bw, w, h, V, deadline, passId, center) {
    var SLOPES = [], i, j;
    if (center && Math.abs(center) > 0.02) {
      var signs = [1, -1], deltas = [-0.10, -0.06, -0.03, 0, 0.03, 0.06, 0.10];
      for (i = 0; i < signs.length; i++) for (j = 0; j < deltas.length; j++) {
        SLOPES.push(signs[i] * center + deltas[j]);
      }
    } else {
      SLOPES = [-0.24, -0.18, -0.12, -0.08, -0.04, 0.04, 0.08, 0.12, 0.18, 0.24];
    }
    var y, s, invert, lineId = 0, stepY = Math.max(3, Math.floor(h / 16));
    for (y = Math.floor(h * 0.16); y < h * 0.86 && Date.now() <= deadline; y += stepY) {
      for (s = 0; s < SLOPES.length && Date.now() <= deadline; s++) {
        for (invert = 0; invert < 2; invert++) {
          collectLine(V, skewRuns(bw, w, h, Math.floor(y), SLOPES[s], invert),
            passId * 1000000 + 850000 + lineId++, deadline);
        }
        if (strongVerified(V)) return true;
      }
    }
    return false;
  }
  /* 百分位对比度拉伸：模糊 / 低对比照片的笔画边界更清楚 */
  function stretchGray(g, w, h) {
    var hist = new Int32Array(256), i, v, total = w * h;
    for (i = 0; i < total; i++) hist[g[i]]++;
    var lo = 0, hi = 255, acc = 0, cut = Math.floor(total * 0.02);
    for (v = 0; v < 256; v++) { acc += hist[v]; if (acc >= cut) { lo = v; break; } }
    acc = 0;
    for (v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= cut) { hi = v; break; } }
    if (hi - lo < 70) return g;
    var out = new Uint8Array(total), scale = 215 / (hi - lo), nv;
    for (i = 0; i < total; i++) {
      nv = (g[i] - lo) * scale + 20;
      out[i] = nv < 0 ? 0 : nv > 255 ? 255 : nv;
    }
    return out;
  }
  /* 细条码 / 拍得太远：把面单中部条带做 2 倍双线性放大再二值化。
     取整锯齿在放大后被摊开，游程宽度比例更接近真实模块宽度。
     只放大中部条带并限制尺寸，避免老安卓 WebView 上积分图占太多内存。 */
  function upscaleGrayBand(g, w, h, f) {
    var y0 = Math.floor(h * 0.22), y1 = Math.min(h, Math.ceil(h * 0.88));
    var bh = y1 - y0, nw = w * f, nh = bh * f;
    var out = new Uint8Array(nw * nh), y, x, sy, sx, yA, yB, xA, xB, wy, wx, v, a, b, c, d;
    for (y = 0; y < nh; y++) {
      sy = y / f; yA = Math.floor(sy); yB = Math.min(bh - 1, yA + 1); wy = sy - yA;
      for (x = 0; x < nw; x++) {
        sx = x / f; xA = Math.floor(sx); xB = Math.min(w - 1, xA + 1); wx = sx - xA;
        a = g[(y0 + yA) * w + xA]; b = g[(y0 + yA) * w + xB];
        c = g[(y0 + yB) * w + xA]; d = g[(y0 + yB) * w + xB];
        v = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
        out[y * nw + x] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return { g: out, w: nw, h: nh };
  }
  /* 用相隔 d 的两行做互相关，估计条码竖条的倾斜斜率 */
  function estimateSkew(bw, w, h) {
    var d = Math.min(48, Math.max(12, Math.floor(h / 8)));
    var YS = [0.2, 0.35, 0.5, 0.65, 0.8], vals = [], k, sh, x, y0, y1, score, best, bestShift;
    for (k = 0; k < YS.length; k++) {
      y0 = Math.floor(h * YS[k]); y1 = Math.min(h - 1, y0 + d);
      best = 0; bestShift = 0;
      for (sh = -18; sh <= 18; sh++) {
        score = 0;
        for (x = 20; x < w - 20; x += 3) {
          var xx = x + sh;
          if (xx < 0 || xx >= w) continue;
          if (bw[y0 * w + x] === 1 && bw[y1 * w + xx] === 1) score += 2;
        }
        if (score > best) { best = score; bestShift = sh; }
      }
      if (best > 25) vals.push(bestShift / d);
    }
    if (!vals.length) return 0;
    vals.sort(function (a, b) { return a - b; });
    var m = vals[Math.floor(vals.length / 2)];
    return Math.abs(m) > 0.30 ? 0 : m;
  }
  function shearBinary(bw, w, h, slope) {
    var out = new Uint8Array(w * h), y, x, sx, off;
    for (y = 0; y < h; y++) {
      off = Math.round((y - h / 2) * slope);
      for (x = 0; x < w; x++) {
        sx = x + off;
        out[y * w + x] = (sx >= 0 && sx < w) ? bw[y * w + sx] : 0;
      }
    }
    return out;
  }
  /* 条码值通常也印在条码下方：用印刷数字串给无校验候选做交叉印证 */
  function corroborate(code, texts) {
    var i, t, j, k, best, prev, cur, tmp;
    for (i = 0; i < texts.length; i++) {
      t = texts[i];
      if (!t || t.length < 6) continue;
      if (code.indexOf(t) >= 0 || t.indexOf(code) >= 0) return true;
      best = 0;
      prev = new Int32Array(t.length + 1); cur = new Int32Array(t.length + 1);
      for (j = 1; j <= code.length; j++) {
        for (k = 1; k <= t.length; k++) {
          cur[k] = code.charAt(j - 1) === t.charAt(k - 1) ? prev[k - 1] + 1 : 0;
          if (cur[k] > best) best = cur[k];
        }
        tmp = prev; prev = cur; cur = tmp;
      }
      if (best >= 6) return true;
    }
    return false;
  }
  function voteScore(a, b) {
    return (b.count * b.weight * b.weight + b.lines * 2)
      - (a.count * a.weight * a.weight + a.lines * 2)
      || b.text.length - a.text.length;
  }
  function finalize(V, digitHits) {
    var i, v, verified = [], unverified = [], texts = [], barcodes = [];
    var bestWeight = 0, bestFormat = '', source = '', confidence = 0;
    var hasTexts, hasCorrobHit = false;
    function rank(a, b) {
      return ((b.corrob ? 1000 : 0) - (a.corrob ? 1000 : 0)) || voteScore(a, b);
    }
    for (i = 0; i < digitHits.length; i++) pushUnique(texts, digitHits[i].text);
    hasTexts = texts.length > 0;
    for (i = 0; i < V.order.length; i++) {
      v = V.map[V.order[i]];
      if (!/[0-9]/.test(v.text) || v.text.length < 6 || v.text.length > 32) continue;
      v.corrob = hasTexts ? corroborate(v.text, texts) : false;
      (v.verified ? verified : unverified).push(v);
    }
    /* 面单上条码值通常也印成数字。互证命中的候选排最前；对不上的候选要按可信度收紧，
       否则倾斜 / 模糊照片里 ITF、宽松 Code128 的校验碰撞会把错码当成识别结果。 */
    verified.sort(rank); unverified.sort(rank);
    if (verified.length) {
      for (i = 0; i < verified.length && barcodes.length < 2; i++) {
        v = verified[i];
        if (v.count < 2) continue;
        if (hasTexts && !v.corrob && (!v.strict || v.count < 3 || hasCorrobHit)) continue;
        pushUnique(barcodes, v.text);
        if (v.corrob) hasCorrobHit = true;
        if (!bestFormat) { bestFormat = v.format; bestWeight = v.count * v.weight; }
      }
      source = 'verified';
    } else {
      /* 无校验码制：多票 + 多行 + 必须与印刷数字互证，宁可空着也不报错码 */
      for (i = 0; i < unverified.length && barcodes.length < 2; i++) {
        v = unverified[i];
        if (v.count < 4 || v.lines < 3) continue;
        if (junkDigitString(v.text)) continue;
        /* Code39 有起止符保护，误报远少于 ITF；印刷数字读糊时仍可采信 */
        var code39 = v.format === 'Code39';
        if (hasTexts && !v.corrob && !code39) continue;
        pushUnique(barcodes, v.text);
        if (!bestFormat) { bestFormat = v.format; bestWeight = v.count * v.weight; }
      }
      source = 'unverified';
    }
    if (barcodes.length) confidence = source === 'verified'
      ? Math.min(0.99, 0.90 + bestWeight * 0.01)
      : Math.min(0.88, 0.70 + bestWeight * 0.01);
    else if (texts.length) confidence = Math.max(0.55,
      Math.min(0.8, digitHits[0] ? digitHits[0].confidence : 0.6));
    return {
      barcodes: barcodes, texts: texts, format: bestFormat, source: source,
      engine: barcodes.length ? '离线条码 · ' + bestFormat : (texts.length ? '离线数字 OCR' : '离线识别'),
      confidence: confidence
    };
  }
  function readDigitsSafe(bw, w, h, deadline) {
    try {
      var sb = shrinkBinary(bw, w, h, 900);
      return readDigits(sb.bw, sb.w, sb.h, deadline);
    } catch (e) { return []; }
  }
  function scanBinary(bw, w, h, opts) {
    var budget = (opts && opts.budget) || 2200;
    var deadline = Date.now() + budget;
    var V = newVotes();
    scanPass(bw, w, h, V, deadline, 0);
    var digitHits = (!opts || opts.digits !== false) && Date.now() < deadline
      ? readDigitsSafe(bw, w, h, deadline) : [];
    return finalize(V, digitHits);
  }

  function emptyResult(err) {
    return { supported: true, barcodes: [], texts: [], engine: '离线识别', confidence: 0,
      error: err || '', format: '', source: '', elapsed: 0 };
  }
  function scanCanvas(source, opts) {
    var t0 = Date.now();
    try {
      var px = pixelsOf(source);
      if (!px) return emptyResult('无法读取照片像素');
      var budget = (opts && opts.budget) || 2800;
      var deadline = t0 + budget;
      var small = downGray(grayOf(px), px.w, px.h, (opts && opts.maxSide) || 1400);
      var g = small.g, w = small.w, h = small.h;
      var V = newVotes();
      var bwA = despeckle(binarize(g, w, h, 0.80), w, h);
      var slope = 0, digitHits = [], digitsDone = false;
      /* 通道 1：常规二值化，密集行采样 + 单行 / 三行投票双取 */
      scanPass(bwA, w, h, V, Math.min(deadline, t0 + Math.round(budget * 0.30)), 0);
      /* 通道 2：对比度拉伸 + 高阈值，救模糊 / 低对比 */
      if (!strongVerified(V)) {
        var bwB = despeckle(binarize(stretchGray(g, w, h), w, h, 0.88), w, h);
        scanPass(bwB, w, h, V, Math.min(deadline, t0 + Math.round(budget * 0.46)), 1);
      }
      /* 印刷数字先取，保证即使增强通道耗尽预算也有手输候选可用 */
      if ((!opts || opts.digits !== false) && Date.now() < deadline - 100) {
        digitHits = readDigitsSafe(bwA, w, h,
          Math.min(deadline - 60, Date.now() + Math.round(budget * 0.14)));
        digitsDone = true;
      }
      /* 通道 3：以估计斜率为中心的斜线扫描，覆盖倾斜面单 */
      if (!strongVerified(V)) {
        slope = estimateSkew(bwA, w, h);
        scanSkew(bwA, w, h, V, Math.min(deadline, t0 + Math.round(budget * 0.68)), 3, slope);
      }
      /* 通道 4：错切校正（正负两个方向都试），让整块条码重新水平 */
      if (!strongVerified(V) && Math.abs(slope) > 0.02) {
        scanPass(shearBinary(bwA, w, h, slope), w, h, V,
          Math.min(deadline, t0 + Math.round(budget * 0.78)), 2);
        if (!strongVerified(V)) {
          scanPass(shearBinary(bwA, w, h, -slope), w, h, V,
            Math.min(deadline, t0 + Math.round(budget * 0.84)), 4);
        }
      }
      /* 通道 5：2 倍超采样，救拍得太远 / 模块只有 1~2px 的细条码 */
      if (!strongVerified(V) && w <= 1300 && h <= 1000 && Date.now() < deadline - 150) {
        var up = upscaleGrayBand(g, w, h, 2);
        var bwU = despeckle(binarize(up.g, up.w, up.h, 0.82), up.w, up.h);
        scanPass(bwU, up.w, up.h, V, Math.min(deadline, t0 + Math.round(budget * 0.96)), 5);
      }
      if (!digitsDone && (!opts || opts.digits !== false) && Date.now() < deadline - 40) {
        digitHits = readDigitsSafe(bwA, w, h, deadline);
      }
      var r = finalize(V, digitHits);
      r.supported = true;
      r.error = (r.barcodes.length || r.texts.length) ? '' : '没读到条码或数字，请对准面单再拍一次，或直接手输';
      r.elapsed = Date.now() - t0;
      if (opts && opts.debug) {
        r.votes = V.order.map(function (k) {
          var x = V.map[k];
          return { text: x.text, format: x.format, count: x.count, lines: x.lines,
            verified: x.verified, strict: x.strict, corrob: !!x.corrob };
        });
      }
      return r;
    } catch (e) {
      var out = emptyResult('识别未完成，可直接手输单号 / 货号');
      out.elapsed = Date.now() - t0;
      return out;
    }
  }
  function fromBlob(blob, opts) {
    return new Promise(function (resolve) {
      if (!blob || !global.document || !global.URL || !global.Image) { resolve(emptyResult('当前环境无法解码照片')); return; }
      var url, img;
      try { url = URL.createObjectURL(blob); img = new Image(); } catch (e) { resolve(emptyResult('照片解码失败')); return; }
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      var timer = setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { } done(emptyResult('识别超时，可直接手输')); }, 12000);
      img.onload = function () {
        clearTimeout(timer);
        try {
          var max = (opts && opts.maxSide) || 1400;
          var scale = Math.min(1, max / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * scale));
          c.height = Math.max(1, Math.round(img.height * scale));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          done(scanCanvas(c, opts));
        } catch (e2) { try { URL.revokeObjectURL(url); } catch (e3) { } done(emptyResult('照片处理失败')); }
      };
      img.onerror = function () {
        clearTimeout(timer);
        try { URL.revokeObjectURL(url); } catch (e) { }
        done(emptyResult('照片解码失败'));
      };
      try { img.src = url; } catch (e4) { clearTimeout(timer); done(emptyResult('照片解码失败')); }
    });
  }
  function scan(source, opts) {
    if (source && typeof source.size === 'number' && source.type && /^image\//.test(source.type)) {
      return fromBlob(source, opts);
    }
    return Promise.resolve(scanCanvas(source, opts));
  }

  /* ---------------- 导出 ---------------- */
  var api = {
    version: '2.3.0',
    scan: scan, scanCanvas: scanCanvas, scanBinary: scanBinary,
    decode: { code128: decodeCode128, code39: decodeCode39, ean: decodeEAN, itf: decodeITF, any: decodeAny },
    grayscale: grayOf, binarize: binarize, despeckle: despeckle, rowRuns: rowRuns, colRuns: colRuns,
    smoothRow: smoothRow, denoiseRuns: denoiseRuns, shrinkBinary: shrinkBinary,
    readDigits: readDigits, matchGlyph: matchGlyph, templates: templates,
    narrowWideMask: narrowWideMask, junkDigitString: junkDigitString,
    stretchGray: stretchGray, estimateSkew: estimateSkew, shearBinary: shearBinary,
    skewRuns: skewRuns, scanPass: scanPass, newVotes: newVotes, finalize: finalize,
    corroborate: corroborate, strongVerified: strongVerified,
    /* 供测试与标签生成用的编码辅助 */
    encodeCode128: encodeCode128, encodeCode39: encodeCode39, encodeEAN13: encodeEAN13, encodeITF: encodeITF,
    modulesToRuns: modulesToRuns
  };
  function modulesToRuns(modules) {
    var runs = [], i = 0;
    while (i < modules.length && modules[i] === 0) i++;
    var cur = 1, count = 0;
    for (; i < modules.length; i++) {
      if (modules[i] === cur) count++;
      else { runs.push(count); cur = modules[i]; count = 1; }
    }
    runs.push(count);
    return runs;
  }
  /* --- 测试用编码器：把字符串转成 0/1 模块序列（1=黑） --- */
  function appendPat(mods, s) { for (var i = 0; i < s.length; i++) { var w = num(s.charAt(i)); for (var j = 0; j < w; j++) mods.push(i % 2 === 0 ? 1 : 0); } }
  function encodeCode128(text) {
    /* 简化编码：纯数字用 Code C，其余用 Code B；带校验与 STOP */
    var digits = /^\d+$/.test(text) && text.length % 2 === 0;
    var start = digits ? 105 : 104, codes = [], i;
    if (digits) { for (i = 0; i < text.length; i += 2) codes.push(parseInt(text.substr(i, 2), 10)); }
    else { for (i = 0; i < text.length; i++) codes.push(text.charCodeAt(i) - 32); }
    var sum = start;
    for (i = 0; i < codes.length; i++) sum += (i + 1) * codes[i];
    codes.push(sum % 103);
    var mods = [];
    appendPat(mods, C128[start]);
    for (i = 0; i < codes.length; i++) appendPat(mods, C128[codes[i]]);
    appendPat(mods, C128[106]);
    return mods;
  }
  function appendC39(mods, mask) {
    var i, bit, w;
    for (i = 8; i >= 0; i--) {
      bit = (mask >> i) & 1;
      w = bit ? 3 : 1;
      for (var j = 0; j < w; j++) mods.push((8 - i) % 2 === 0 ? 1 : 0);
    }
  }
  function encodeCode39(text) {
    var mods = [], i;
    appendC39(mods, C39_STAR); mods.push(0);
    var s = String(text).toUpperCase();
    for (i = 0; i < s.length; i++) {
      var idx = C39_CHARS.indexOf(s.charAt(i));
      if (idx < 0) idx = C39_CHARS.indexOf(' ');
      appendC39(mods, C39_ENC[idx]); mods.push(0);
    }
    appendC39(mods, C39_STAR);
    return mods;
  }
  function appendEAN(mods, pattern, fromOne) {
    /* pattern 是 4 段宽度数组；从条(1)开始时需与前一空衔接，这里按段连续追加 */
    var cur = fromOne ? 1 : 0, i, j;
    for (i = 0; i < pattern.length; i++) {
      for (j = 0; j < pattern[i]; j++) mods.push(cur);
      cur = 1 - cur;
    }
  }
  function encodeEAN13(text) {
    var d = String(text);
    if (d.length === 12) d = '0' + d;
    if (d.length !== 13) return [];
    var mods = [1, 0, 1], i, k;
    var parity = EAN_PARITY[num(d.charAt(0))];
    for (k = 0; k < 6; k++) {
      var idx = num(d.charAt(k + 1));
      appendEAN(mods, EAN_LG[parity.charAt(k) === 'G' ? idx + 10 : idx], false);
    }
    /* 中间护线 01010 = 空、条、空、条、空，接着右半从条开始 */
    for (i = 0; i < 5; i++) mods.push(i % 2 === 0 ? 0 : 1);
    for (k = 0; k < 6; k++) appendEAN(mods, EAN_LG[num(d.charAt(k + 7))], true);
    mods.push(1); mods.push(0); mods.push(1);
    return mods;
  }
  function encodeITF(text) {
    var d = String(text), mods = [1, 0, 1, 0], i, k, j;
    for (i = 0; i < d.length; i += 2) {
      var a = ITF_PAT[num(d.charAt(i))], b = ITF_PAT[num(d.charAt(i + 1))];
      var cur = 1;
      for (k = 0; k < 5; k++) {
        for (j = 0; j < a[k]; j++) mods.push(cur);
        cur = 1 - cur;
        for (j = 0; j < b[k]; j++) mods.push(cur);
        cur = 1 - cur;
      }
    }
    mods.push(1); mods.push(1); mods.push(1); mods.push(0); mods.push(1);
    return mods;
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.StationOcr = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
