// tools/prepsceneimg.js —— 页面主题配图的处理（零依赖，与 prepcharimg 同一套 PNG 工具）
//
// 【为什么需要】图片生成模型输出的是 1536×1024、1.8–2.2 MB 的原图，
//   而这些图是要铺在页面上的：既占流量，又可能在高分屏上被拉糊。
//   这里统一缩到「刚好覆盖最大显示尺寸 × 2」的尺寸，并量化到 64 色。
//
// 【为什么缩放公式是「按显示尺寸 × 2」】
//   CSS 里按 max-width 限制显示宽度，移动端与 PC 差一倍以上。
//   ×2 是给高分屏（DPR=2）留的余量 —— 再大就只是白费流量。
//   ★不要用「原始尺寸直接上线」：那是给生成器看的，不是给页面看的。
//
// 【为什么场景图要量化得更狠（48 色）】
//   场景图是**背景**，压在它上面的是文字。48 色 + 面积平均的柔化，
//   反而让背景更平整、更不抢文字；60+ 色的渐变会在文字后面制造噪点。
//
// 用法：node tools/prepsceneimg.js

const fs = require('node:fs');
const path = require('node:path');

// ---- 与 prepcharimg.js 相同的 PNG 工具（复制而非 require：那个文件会跑 main()）----

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; ctype = data[9];
      if (data[12] !== 0) return { err: '隔行 PNG 不支持' };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (ctype !== 2 && ctype !== 6)) {
    return { err: 'bitDepth=' + depth + ' colorType=' + ctype };
  }
  const zlib = require('node:zlib');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ctype === 6 ? 4 : 3;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= ch) ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b;
      else if (f === 3) v += ((a + b) >> 1); else if (f === 4) v += paeth(a, b, c);
      cur[x] = v & 0xff;
    }
  }
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    rgba[i * 4] = out[i * ch];
    rgba[i * 4 + 1] = out[i * ch + 1];
    rgba[i * 4 + 2] = out[i * ch + 2];
    rgba[i * 4 + 3] = ch === 4 ? out[i * ch + 3] : 255;
  }
  return { w: w, h: h, rgba: rgba };
}

function resizeArea(rgba, w, h, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = w / dw, sy = h / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy, y1 = (y + 1) * sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx, x1 = (x + 1) * sx;
      let r = 0, g = 0, b = 0, aSum = 0, alphaSum = 0, wsum = 0;
      const iy0 = Math.floor(y0), iy1 = Math.min(h, Math.ceil(y1));
      for (let yy = iy0; yy < iy1; yy++) {
        const covY = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (covY <= 0) continue;
        const ix0 = Math.floor(x0), ix1 = Math.min(w, Math.ceil(x1));
        for (let xx = ix0; xx < ix1; xx++) {
          const covX = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (covX <= 0) continue;
          const cov = covX * covY;
          const i = (yy * w + xx) * 4;
          const wa = cov * (rgba[i + 3] / 255);
          r += rgba[i] * wa; g += rgba[i + 1] * wa; b += rgba[i + 2] * wa;
          aSum += wa; alphaSum += cov * rgba[i + 3]; wsum += cov;
        }
      }
      const o = (y * dw + x) * 4;
      if (aSum === 0 || wsum === 0) { out[o + 3] = 0; continue; }
      out[o] = Math.round(r / aSum);
      out[o + 1] = Math.round(g / aSum);
      out[o + 2] = Math.round(b / aSum);
      out[o + 3] = Math.round(alphaSum / wsum);
    }
  }
  return out;
}

function quantize(rgba, w, h, maxColors) {
  const buckets = Object.create(null);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 8) continue;
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  let keys = Object.keys(buckets);
  if (keys.length === 0) return { palette: [[0, 0, 0]], idx: null };
  keys.sort(function (a, b) { return buckets[b] - buckets[a]; });   // ★按频次截断，不是「缩放重排」
  if (keys.length > maxColors) keys = keys.slice(0, maxColors);

  const palette = [[0, 0, 0]];
  keys.forEach(function (k) {
    const n = Number(k);
    palette.push([((n >> 10) & 31) << 3, ((n >> 5) & 31) << 3, (n & 31) << 3]);
  });

  const idx = Buffer.alloc(w * h);
  const cache = Object.create(null);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 8) { idx[i] = 0; continue; }
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    let v = cache[key];
    if (v === undefined) {
      let best = 1, bd = Infinity;
      const kr = key >> 10, kg = (key >> 5) & 31, kb = key & 31;
      for (let p = 1; p < palette.length; p++) {
        const c = palette[p];
        const dr = (c[0] >> 3) - kr, dg = (c[1] >> 3) - kg, db = (c[2] >> 3) - kb;
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = p; if (d === 0) break; }
      }
      v = best; cache[key] = v;
    }
    idx[i] = v;
  }
  return { palette: palette, idx: idx };
}

const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePalettePng(palette, idx, w, h) {
  const zlib = require('node:zlib');
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) raw[y * (w + 1) + 1 + x] = idx[y * w + x];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 3;
  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(function (c, i) { plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2]; });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('tRNS', Buffer.from([0])),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ============================================================
// 主流程
// ============================================================
const ROOT = path.join(__dirname, '..', 'public', 'img', 'scene');
const OUT = path.join(__dirname, '..', 'public', 'img', 'scene-out');

// name: { 文件夹, 输出名, 目标宽, 颜色数, 用途 }
// ★目标宽按「最大显示宽 × 2」给；改 CSS 里的 max-width 时要同步改这里，
//   否则图要么被拉糊（给小了）、要么白下载像素（给大了）。
const JOBS = [
  {
    name: 'story', dir: '', out: 'story-bg.png',
    width: 1200, colors: 48,
    note: '关卡选择弹层背景（.story-box max-width 620px，取 2 倍余量）'
  },
  {
    name: 'lobby', dir: 'lobby', out: 'lobby-banner.png',
    width: 1440, colors: 48,
    note: '大厅顶部横幅（.topbar 满宽，上方留白可放标题）'
  }
];

function listPng(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) { return /\.png$/i.test(f); })
    .map(function (f) { return path.join(dir, f); });
}

function main() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  JOBS.forEach(function (job) {
    const files = listPng(path.join(ROOT, job.dir));
    if (files.length !== 1) {
      console.error('[scene] ★' + job.name + ' 的源图数量=' + files.length + '（应为 1）');
      console.error('[scene]   多半是**同秒并发生成互相覆盖**了 —— 接口照样返回成功，不报错。');
      process.exit(1);
    }
    const src = files[0];
    const buf = fs.readFileSync(src);
    const dec = decodePng(buf);
    if (dec && dec.err) { console.error('  ✖ ' + job.name + ' 解码失败：' + dec.err); process.exit(1); }

    // 目标高度按**原图比例**算，不写死 —— 写死会在换生成尺寸时悄悄裁掉构图
    const dh = Math.round(job.width * dec.h / dec.w);
    const small = resizeArea(dec.rgba, dec.w, dec.h, job.width, dh);
    const q = quantize(small, job.width, dh, job.colors);
    const out = encodePalettePng(q.palette, q.idx, job.width, dh);
    fs.writeFileSync(path.join(OUT, job.out), out);

    console.log('  ✔ ' + job.name.padEnd(7) + dec.w + 'x' + dec.h + ' → ' + job.width + 'x' + dh
      + '  ' + q.palette.length + ' 色  '
      + (buf.length / 1024 / 1024).toFixed(1) + ' MB → ' + (out.length / 1024).toFixed(0) + ' KB');
    console.log('    用途：' + job.note);
  });

  console.log('[scene] 完成');
}

main();