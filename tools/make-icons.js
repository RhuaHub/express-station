/* 生成 PWA 图标（纯 Node，零依赖）：暖金圆角底 + 白色包裹盒线稿 */
'use strict';
var zlib = require('zlib');
var fs = require('fs');
var path = require('path');

function crc32(buf) {
  var table = crc32.table;
  if (!table) {
    table = crc32.table = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  var t = Buffer.from(type, 'ascii');
  var crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(size, rgba) {
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  var raw = Buffer.alloc((size * 4 + 1) * size);
  for (var y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* 超采样光栅：返回 (size*S)^2 的 alpha 遮罩标记函数 */
function raster(size, S, drawFn) {
  var grid = new Uint8Array(size * S * size * S); // 1 = 命中
  drawFn(function put(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x >= 0 && y >= 0 && x < size * S && y < size * S) grid[y * size * S + x] = 1;
  }, size * S);
  return grid;
}
function line(put, x1, y1, x2, y2, w) {
  var r = w / 2, steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2 + 1;
  for (var i = 0; i <= steps; i++) {
    var t = i / steps, x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    for (var dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (var dx = -Math.ceil(r); dx <= Math.ceil(r); dx++)
        if (dx * dx + dy * dy <= r * r) put(x + dx + 0.5, y + dy + 0.5);
  }
}
function inRoundedRect(x, y, W, H, m, r) {
  var rx = m + r, rx2 = W - m - r, ry = m + r, ry2 = H - m - r;
  if (x < m || y < m || x >= W - m || y >= H - m) return false;
  if (x < rx && y < ry) { var dx = rx - x, dy = ry - y; return dx * dx + dy * dy <= r * r; }
  if (x > rx2 && y < ry) { dx = x - rx2; dy = ry - y; return dx * dx + dy * dy <= r * r; }
  if (x < rx && y > ry2) { dx = rx - x; dy = y - ry2; return dx * dx + dy * dy <= r * r; }
  if (x > rx2 && y > ry2) { dx = x - rx2; dy = y - ry2; return dx * dx + dy * dy <= r * r; }
  return true;
}

function makeIcon(size, maskable) {
  var S = 4, N = size * S;
  var m = Math.round(N * (maskable ? 0.12 : 0.04));
  var r = Math.round(N * 0.2);
  var penW = N * 0.06;
  var cx = N / 2, cy = N / 2, u = N / 10;
  // 立方体顶点
  var T = [cx, cy - 2.6 * u], TR = [cx + 2.3 * u, cy - 1.3 * u], B = [cx, cy],
      TL = [cx - 2.3 * u, cy - 1.3 * u], BR = [cx + 2.3 * u, cy + 1.3 * u],
      D = [cx, cy + 2.6 * u], BL = [cx - 2.3 * u, cy + 1.3 * u];
  var edges = [[T, TR], [TR, B], [B, TL], [TL, T], [TL, BL], [BL, D], [D, B], [TR, BR], [BR, D]];

  var bg = raster(size, S, function (put, W) {
    for (var y = 0; y < W; y++) for (var x = 0; x < W; x++)
      if (inRoundedRect(x + 0.5, y + 0.5, W, W, m, r)) put(x, y);
  });
  var fg = raster(size, S, function (put, W) {
    edges.forEach(function (e) { line(put, e[0][0], e[0][1], e[1][0], e[1][1], penW); });
  });

  var rgba = Buffer.alloc(size * size * 4);
  var SS = S * S;
  for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) {
    var bgHit = 0, fgHit = 0;
    for (var sy = 0; sy < S; sy++) for (var sx = 0; sx < S; sx++) {
      var idx = (y * S + sy) * (size * S) + (x * S + sx);
      if (bg[idx]) bgHit++;
      if (fg[idx]) fgHit++;
    }
    var o = (y * size + x) * 4;
    var aBg = bgHit / SS, aFg = fgHit / SS;
    // 底色金 #B8860B，前景白 #FFFFFF
    var br = 184, bg_ = 134, bb = 11;
    var outA = aBg;
    var outR = br, outG = bg_, outB = bb;
    if (aFg > 0) {
      outA = Math.max(aBg, aFg);
      outR = br + (255 - br) * aFg; outG = bg_ + (255 - bg_) * aFg; outB = bb + (255 - bb) * aFg;
    }
    rgba[o] = Math.round(outR); rgba[o + 1] = Math.round(outG); rgba[o + 2] = Math.round(outB);
    rgba[o + 3] = Math.round(outA * 255);
  }
  return encodePNG(size, rgba);
}

var outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
[
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
  ['apple-touch-icon.png', 180, false]
].forEach(function (spec) {
  var buf = makeIcon(spec[1], spec[2]);
  fs.writeFileSync(path.join(outDir, spec[0]), buf);
  console.log('生成 ' + spec[0] + ' (' + buf.length + ' bytes)');
});
