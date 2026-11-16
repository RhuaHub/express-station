/* 真实快递面单模拟场景回归（2.3.0）
   合成带文字、二维码方块、边框、印刷数字、明暗渐变、噪点、倾斜、模糊、细条码、
   竖排与四种码制的面单图，端到端跑 StationOcr.scanCanvas。
   判定：解出正确条码且不输出无关错码；允许个别极端场景由印刷数字兜底。
   单独运行：node tests/ocr-scenarios.js
   被 smoke.js 引用：Scenarios.run(OCR) */
'use strict';

const FONT = [
  '01110/10001/10011/10101/11001/10001/01110',
  '00100/01100/00100/00100/00100/00100/01110',
  '01110/10001/00001/00010/00100/01000/11111',
  '11110/00001/00001/01110/00001/00001/11110',
  '00010/00110/01010/10010/11111/00010/00010',
  '11111/10000/10000/11110/00001/00001/11110',
  '00110/01000/10000/11110/10001/10001/01110',
  '11111/00001/00010/00100/01000/01000/01000',
  '01110/10001/10001/01110/10001/10001/01110',
  '01110/10001/10001/01111/00001/00010/01100'
];

function scene(o) {
  o = o || {};
  const W = o.w || 1000, H = o.h || 700;
  const px = new Uint8ClampedArray(W * H * 4);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const light = o.light === undefined ? 0.18 : o.light;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const grad = 1 - light * (x / W) - light * 0.5 * (y / H);
    let v = 244 * grad + (o.noise ? (rnd() - 0.5) * o.noise : 0);
    if (o.dark) v *= o.dark;
    const k = (y * W + x) * 4;
    px[k] = px[k + 1] = px[k + 2] = Math.max(0, Math.min(255, v)); px[k + 3] = 255;
  }
  const set = (x, y, v) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const k = (y * W + x) * 4;
    px[k] = px[k + 1] = px[k + 2] = Math.max(0, Math.min(255, v)); px[k + 3] = 255;
  };
  const rect = (x, y, w, h, v) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) set(x + i, y + j, v); };
  const digits = (s, x, y, sc, v) => {
    [...String(s)].forEach((ch, n) => {
      const d = Number(ch); if (!Number.isFinite(d)) return;
      const rows = FONT[d].split('/');
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++)
        if (rows[r][c] === '1') rect(x + n * 6 * sc + c * sc, y + r * sc, sc, sc, v);
    });
  };
  const mods = o.mods;
  const sc = o.sc || 3, bh = o.bh || 70;
  const bx = o.bx === undefined ? Math.round((W - mods.length * sc) / 2) : o.bx;
  const by = o.by === undefined ? Math.round(H * 0.45) : o.by;
  for (let i = 0; i < mods.length; i++) if (mods[i] === 1) rect(bx + i * sc, by, sc, bh, 12);
  if (o.leftText) {
    let xx = 20;
    while (xx < bx - 20) {
      const w = 2 + Math.floor(rnd() * 9);
      rect(xx, by + 8, w, bh - 16, 40 + Math.floor(rnd() * 30));
      xx += w + 2 + Math.floor(rnd() * 7);
    }
  }
  if (o.border) {
    for (let x = 20; x < W - 20; x++) { set(x, 20, 60); set(x, H - 20, 60); }
    for (let y = 20; y < H - 20; y++) { set(20, y, 60); set(W - 20, y, 60); }
  }
  if (o.words) {
    for (let row = 0; row < o.words; row++) {
      const yy = 60 + row * 44;
      let xx = 60;
      while (xx < W - 120) {
        const w = 3 + Math.floor(rnd() * 15), h = 12 + Math.floor(rnd() * 12);
        rect(xx, yy, w, h, 40 + Math.floor(rnd() * 40));
        xx += w + 3 + Math.floor(rnd() * 10);
      }
    }
  }
  if (o.human) digits(o.human, bx + 6, by + bh + 14, o.humanScale || 3, 25);
  if (o.qr) {
    const qs = 6, qn = 21;
    for (let r = 0; r < qn; r++) for (let c = 0; c < qn; c++)
      if (rnd() > 0.5) rect(W - 40 - qn * qs + c * qs, 50 + r * qs, qs, qs, 20);
  }
  let data = px;
  if (o.rotate) {
    const a = o.rotate * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a), cx = W / 2, cy = H / 2;
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const sx = Math.round(cx + dx * ca + dy * sa), sy = Math.round(cy - dx * sa + dy * ca);
      const v = (sx >= 0 && sy >= 0 && sx < W && sy < H) ? data[(sy * W + sx) * 4] : 244;
      const k = (y * W + x) * 4; out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = 255;
    }
    data = out;
  }
  if (o.blur || o.contrast) {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let sum = 0, n = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const xx = x + i, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        sum += data[(yy * W + xx) * 4]; n++;
      }
      let v = sum / n;
      if (o.contrast) v = 128 + (v - 128) * o.contrast;
      const k = (y * W + x) * 4; out[k] = out[k + 1] = out[k + 2] = v; out[k + 3] = 255;
    }
    data = out;
  }
  return { width: W, height: H, data: data };
}

function cases(O) {
  const C128 = O.encodeCode128('YT9000012345');
  const C39 = O.encodeCode39('A1234567');
  const B = { expect: 'YT9000012345', human: '9000012345' };
  return [
    ['干净整幅', Object.assign({ mods: C128, sc: 5, bh: 120, w: C128.length * 5 + 60, h: 180, by: 30 }, B)],
    ['典型面单·居中', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, qr: true, border: true }, B)],
    ['条码偏小 sc=2', Object.assign({ mods: C128, sc: 2, bh: 55, words: 4, qr: true, border: true }, B)],
    ['极细条码 sc=1.5（允许印刷数字兜底）', Object.assign({ mods: C128, sc: 1.5, bh: 42, words: 4, qr: true, allowMiss: true }, B)],
    ['倾斜 6°', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, qr: true, rotate: 6 }, B)],
    ['倾斜 14°', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, rotate: 14 }, B)],
    ['模糊低对比', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, blur: true, contrast: 0.65 }, B)],
    ['强光照渐变', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, qr: true, light: 0.55 }, B)],
    ['照片噪点', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, qr: true, noise: 45 }, B)],
    ['整体偏暗', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, qr: true, dark: 0.62 }, B)],
    ['条码左侧大量文字', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, w: 1200, bx: 420, leftText: true }, B)],
    ['竖排条码', Object.assign({ mods: C128, sc: 4, bh: 80, words: 3, rotate: 90 }, B)],
    ['Code39', { mods: C39, sc: 3, bh: 70, words: 3, human: '1234567', expect: 'A1234567' }],
    ['Code39 倾斜', { mods: C39, sc: 3, bh: 70, words: 3, human: '1234567', rotate: 8, expect: 'A1234567' }],
    ['纯数字 Code128C', { mods: O.encodeCode128('780012345678'), sc: 4, bh: 80, words: 3, human: '780012345678', qr: true, expect: '780012345678' }],
    ['EAN13', { mods: O.encodeEAN13('6901234567892'), sc: 4, bh: 90, words: 3, human: '6901234567892', qr: true, expect: '6901234567892' }],
    ['ITF', { mods: O.encodeITF('12345670'), sc: 4, bh: 80, words: 3, human: '12345670', qr: true, expect: '12345670' }]
  ];
}

function run(O) {
  const list = cases(O), details = [], wrongCodes = [];
  let pass = 0, wrong = 0;
  list.forEach(([name, cfg]) => {
    const r = O.scanCanvas(scene(cfg), { budget: 2400, maxSide: 1400 });
    const want = String(cfg.expect).replace(/[^A-Z0-9]/g, '');
    /* 正确码本身、或它的连续子串（部分解码）不算错码；其余一律视为误报 */
    const bad = r.barcodes.filter(b => {
      const s = String(b).replace(/[^A-Z0-9]/g, '');
      return s !== want && !(want.indexOf(s) >= 0 && s.length >= 6);
    });
    if (bad.length) { wrong += bad.length; bad.forEach(b => wrongCodes.push(name + ':' + b)); }
    const hit = r.barcodes.some(b => String(b).replace(/[^A-Z0-9]/g, '') === want);
    const fallback = !!cfg.allowMiss && !bad.length && r.texts.some(t => want.indexOf(t) >= 0 && t.length >= 6);
    const ok = !bad.length && (hit || fallback);
    if (ok) pass++;
    details.push({ name: name, ok: ok, hit: hit, fallback: fallback,
      bad: bad, barcodes: r.barcodes, texts: r.texts, elapsed: r.elapsed });
  });
  return { total: list.length, pass: pass, wrong: wrong, wrongCodes: wrongCodes, details: details };
}

module.exports = { run: run, scene: scene, cases: cases };

if (require.main === module) {
  const O = require('../ocr.js');
  const r = run(O);
  r.details.forEach(d => {
    console.log((d.ok ? 'PASS' : 'FAIL').padEnd(5), d.name.padEnd(34),
      '条码:', JSON.stringify(d.barcodes).padEnd(30), '数字:', JSON.stringify(d.texts).padEnd(18),
      d.elapsed + 'ms');
  });
  console.log('通过 ' + r.pass + '/' + r.total + '，错误条码 ' + r.wrong + ' 个');
  process.exit(r.pass >= 16 && r.wrong === 0 ? 0 : 1);
}
