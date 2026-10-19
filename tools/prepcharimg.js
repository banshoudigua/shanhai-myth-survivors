// tools/prepcharimg.js —— 角色立绘产物的整理与缩放（零依赖）
//
// 【为什么不用 sharp】项目有硬约束：WorkBuddy「发布为应用」的预检会检查**依赖清单**，
// 而本项目历史上就栽过「依赖里出现不该出现的包 → 直接拒绝发布」。
// 为了缩几张图去引入一个原生模块（还要预编译二进制），风险收益完全不成比例。
// PNG 的解码/编码都是纯计算，Node 内置 zlib 就够（makeicons.js 里已经用过一次）。
//
// 【为什么需要这一步】
// 内置图片生成模型输出的文件名带**时间戳**，而页面要按**角色 id** 引用。
//
// ★★更要紧的是：**同秒并发生成会互相覆盖**。
//   实测：同一秒里生成两张图，文件名完全相同 → 后写的把前一张盖掉，
//   而**接口照样返回成功**（返回同一个路径，看起来毫无异常）。
//   本轮真踩了一次（玄武被魃覆盖）。所以：① 生成时用**独立 output_dir**（按角色分目录）；
//   ② 本脚本按**目录**判定归属；③ 数量与期望不符时**直接退出非零**，不「少一张也继续」。
//
// 【缩放】1024×1024 原图约 1.7–1.9 MB，8 张 ≈ 14 MB；而页面上只显示 160×160。
//   这里缩到 320×320（2 倍于显示尺寸，高分屏不糊），再**量化到 64 色**——
//   像素画本来就没那么多色，量化后更像像素画、体积也小一个量级。
//
// 用法：node tools/prepcharimg.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const DIR = path.join(__dirname, '..', 'public', 'img', 'chars');
const OUT = path.join(__dirname, '..', 'public', 'img', 'char');

// 期望的角色 → 生成时的独立子目录（空串 = 根目录）
const EXPECT = [
  { id: 'hunter', dir: '' },
  { id: 'blacksmith', dir: '' },
  { id: 'nun', dir: '' },
  { id: 'scholar', dir: '' },
  { id: 'knight', dir: 'knight' },
  { id: 'thief', dir: '' },
  { id: 'witch', dir: '' },
  { id: 'monk', dir: 'monk' }
];

// 根目录那批按时间顺序对应谁 —— **显式列出**，不用「按 mtime 猜」：
// 猜错就是张冠李戴，而这种错要等玩家看到才发现。
const ROOT_ORDER = ['hunter', 'blacksmith', 'nun', 'scholar', 'thief', 'witch'];

// ============================================================
// PNG 解码（只处理我们需要的：8bit truecolor(+alpha)，非隔行）
// ============================================================

// PNG 的「滤波器」：每行开头一个字节，告诉解码器这一行怎么编码的。
// 逐行反滤波，必须按顺序来（Sub/Average/Paeth 都依赖**左边和上一行**的原始像素）。
//
// ★★BYTES_PER_PIXEL 是个**陷阱**：解码阶段的每行字节数是「w × 实际通道数」，
//   而通道数取决于 colorType（2=RGB 三通道、6=RGBA 四通道）。
//   固定写成 4 的话，遇到无 alpha 的图（colorType=2）整行会错位 ——
//   解出来全黑、量化后只剩 2 色、体积 4KB，**整条链路静默出错、不报任何错**。
//   本轮第一版就栽在这里。所以这里不再有常量，stride 一律用 channels 算。
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(buf) {
  if (buf.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;

  let pos = 8;
  let w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      if (data[12] !== 0) return null;          // 隔行不支持（生成器不会输出）
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;                            // 8(长度+类型) + len + 4(CRC)
  }

  // 只支持 8bit；真彩色(2) 或 带 alpha(6)。其它组合不猜，直接报错。
  if (depth !== 8 || (ctype !== 2 && ctype !== 6)) {
    return { err: 'bitDepth=' + depth + ' colorType=' + ctype + '（只支持 8bit 的 2/6）' };
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const channels = ctype === 6 ? 4 : 3;
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);

  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride);
    rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : null;

    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;   // 左边
      const b = prev ? prev[x] : 0;                      // 上面
      const c = (prev && x >= channels) ? prev[x - channels] : 0;  // 左上
      let v = line[x];
      switch (filter) {
        case 0: break;
        case 1: v = v + a; break;
        case 2: v = v + b; break;
        case 3: v = v + ((a + b) >> 1); break;
        case 4: v = v + paeth(a, b, c); break;
        default: return { err: '未知的滤波器 ' + filter };
      }
      cur[x] = v & 0xff;
    }
  }

  // 统一成 RGBA，简化后面的缩放与量化
  let rgba = Buffer.alloc(w * h * 4);
  for (let i = 0, n = w * h; i < n; i++) {
    rgba[i * 4] = out[i * channels];
    rgba[i * 4 + 1] = out[i * channels + 1];
    rgba[i * 4 + 2] = out[i * channels + 2];
    rgba[i * 4 + 3] = channels === 4 ? out[i * channels + 3] : 255;
  }

  // ★自检：解码结果必须是「有内容的」。整幅纯黑/纯色说明上面某一步算错了
  //（错位、全零、stride 用错……），而这类错误一路走到编码都是**静默**的 ——
  // 只看最终 PNG 的话，只会觉得「图怎么是黑的」，找不到是哪一步坏的。
  //   所以在**解码的出口**就断言一次：不同颜色的数量必须够多。
  let distinct = Object.create(null);
  for (let i = 0; i < w * h; i += 97) {          // 抽样即可，不必全扫（1024² 全扫也没人等）
    const o = i * 4;
    distinct[((rgba[o] >> 4) << 8) | ((rgba[o + 1] >> 4) << 4) | (rgba[o + 2] >> 4)] = 1;
  }
  const distinctCount = Object.keys(distinct).length;
  if (distinctCount < 4) {
    return { err: '解码结果只有 ' + distinctCount + ' 种颜色（几乎纯色）—— ' +
      'stride 或通道数算错了。colorType=' + ctype };
  }

  return { w: w, h: h, rgba: rgba, distinct: distinctCount };
}

// ============================================================
// 缩放：面积平均（box filter）
// ============================================================
// ★为什么不用「最近邻」：1024→320 是缩小，最近邻会**丢掉 90% 的像素**，
//   结果是像素画的细线条断断续续（摩尔纹/锯齿）。面积平均相当于先做一次降采样抗锯齿。
//   ★注意项目「像素引擎三条铁律」讲的是**绘制时**不许插值；那是运行时画精灵图，
//   与「离线处理素材」是两回事 —— 这里处理完就是成品，不参与运行期绘制。
function resizeArea(rgba, w, h, dw, dh) {
  const out = Buffer.alloc(dw * dh * 4);
  const sx = w / dw;
  const sy = h / dh;

  for (let y = 0; y < dh; y++) {
    const y0 = y * sy;
    const y1 = (y + 1) * sy;
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;

      // r/g/b = Σ(颜色 × alpha权重)；aSum = Σ(alpha权重)；alphaSum = Σ(alpha × cov)；wsum = Σ(cov)
      let r = 0, g = 0, b = 0, aSum = 0, alphaSum = 0, wsum = 0;
      const iy0 = Math.floor(y0);
      const iy1 = Math.min(h, Math.ceil(y1));
      for (let yy = iy0; yy < iy1; yy++) {
        const covY = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (covY <= 0) continue;
        const ix0 = Math.floor(x0);
        const ix1 = Math.min(w, Math.ceil(x1));
        for (let xx = ix0; xx < ix1; xx++) {
          const covX = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (covX <= 0) continue;
          const cov = covX * covY;
          const i = (yy * w + xx) * 4;
          // ★两个累加器各司其职，别混：
          //   wsum = Σ(cov)              —— 纯**面积**权重
          //   aSum = Σ(cov × alpha/255)  —— **alpha 加权**的颜色权重
          //   （本项目的图是 colorType=2 无 alpha，aSum 恒等于 wsum；
          //     但写成两个变量，将来处理带透明的素材也不会错）
          const wAlpha = cov * (rgba[i + 3] / 255);
          r += rgba[i] * wAlpha;
          g += rgba[i + 1] * wAlpha;
          b += rgba[i + 2] * wAlpha;
          aSum += wAlpha;
          alphaSum += cov * rgba[i + 3];
          wsum += cov;
        }
      }
      const o = (y * dw + x) * 4;
      if (aSum === 0 || wsum === 0) { out[o + 3] = 0; continue; }
      // ★除以 aSum（颜色权重和），不是除以 alphaSum —— 用后者会把颜色除成一个很小的数，
      //   整幅图会变成近黑。第一版就是这么错的，症状是「2 色 / 4KB」，一路静默。
      out[o] = Math.round(r / aSum);
      out[o + 1] = Math.round(g / aSum);
      out[o + 2] = Math.round(b / aSum);
      out[o + 3] = Math.round(alphaSum / wsum);
    }
  }
  return out;
}

// ============================================================
// 量化到有限调色板（PNG 的 palette 模式，体积能再降一个量级）
// ============================================================

function quantize(rgba, w, h, maxColors) {
  // 1) 统计出现最多的颜色（量化到 5bit/通道 再统计：抗住轻微渐变，否则颜色数会爆炸）
  const buckets = Object.create(null);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 8) continue;               // 近透明不参与（它归到透明色）
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  let keys = Object.keys(buckets);
  if (keys.length === 0) return { palette: [[0, 0, 0]], idx: null };

  // 2) 收敛到 maxColors
  // ★这里原来写的是一个「把频次按比例缩放再重排」的循环，cap 每轮乘 0.7 ——
  //   但**重排并不会让 entries 变短**，长度只取决于 key 的个数。
  //   于是循环要么立刻退出（cap 掉到 <2）、要么跑到 entries.length 仍 > cap 而死循环。
  //   结果：调色板永远只有 2 个条目（1 个真色 + 透明）→ 图几乎全黑、4 KB。
  //   ★正确的做法是**按频次排序后直接截断**（中位截断会丢主色，但按频次截断不会，
  //   丢的都是几万像素里偶尔出现一次的杂色，肉眼无感）。
  keys.sort(function (a, b) { return buckets[b] - buckets[a]; });
  if (keys.length > maxColors) keys = keys.slice(0, maxColors);

  const palette = [[0, 0, 0]];                    // 索引 0 留给透明
  keys.forEach(function (k) {
    const n = Number(k);
    const r = ((n >> 10) & 31) << 3;
    const g = ((n >> 5) & 31) << 3;
    const b = (n & 31) << 3;
    palette.push([r, g, b]);
  });

  // 3) 每个像素找最近色（调色板很小，线性找足够；先做 5bit 缓存避免重复计算）
  const idx = Buffer.alloc(w * h);
  const cache = Object.create(null);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (rgba[o + 3] < 8) { idx[i] = 0; continue; }
    const key = ((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3);
    let v = cache[key];
    if (v === undefined) {
      let best = 1;
      let bd = Infinity;
      const kr = key >> 10, kg = (key >> 5) & 31, kb = key & 31;
      for (let p = 1; p < palette.length; p++) {
        const c = palette[p];
        const dr = ((c[0] >> 3) - kr), dg = ((c[1] >> 3) - kg), db = ((c[2] >> 3) - kb);
        const d = dr * dr + dg * dg + db * db;
        if (d < bd) { bd = d; best = p; if (d === 0) break; }
      }
      v = best;
      cache[key] = v;
    }
    idx[i] = v;
  }
  return { palette: palette, idx: idx };
}

// ============================================================
// 编码 palette PNG（色深 8，索引走 PLTE）
// ============================================================

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
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePalettePng(palette, idx, w, h) {
  // 每行：1 字节 filter(0) + w 字节索引
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    for (let x = 0; x < w; x++) {
      raw[y * (w + 1) + 1 + x] = idx[y * w + x];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 3;      // color type: indexed
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(function (c, i) {
    plte[i * 3] = c[0]; plte[i * 3 + 1] = c[1]; plte[i * 3 + 2] = c[2];
  });
  // tRNS：索引 0 = 全透明
  const trns = Buffer.from([0]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ============================================================
// 主流程
// ============================================================

const TARGET = 320;
const COLORS = 64;

function listPng(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(function (f) { return /\.png$/i.test(f); })
    .map(function (f) { return path.join(dir, f); });
}

function main() {
  const rootFiles = listPng(DIR).sort(function (a, b) {
    return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs;
  });

  if (rootFiles.length !== ROOT_ORDER.length) {
    console.error('[prep] ★根目录数量不对：期望 ' + ROOT_ORDER.length + ' 张，实际 ' + rootFiles.length + ' 张');
    rootFiles.forEach(function (f) { console.error('        ' + path.basename(f)); });
    console.error('[prep]   多半是**同秒并发生成互相覆盖**了（接口照样返回成功，不报错）。');
    console.error('[prep]   重新生成缺的那张，用独立的 output_dir（别和别的角色同一秒）。');
    process.exit(1);
  }

  const plan = ROOT_ORDER.map(function (id, i) { return { id: id, src: rootFiles[i] }; });
  EXPECT.forEach(function (e) {
    if (!e.dir) return;
    const files = listPng(path.join(DIR, e.dir));
    if (files.length !== 1) {
      console.error('[prep] ★目录 ' + e.dir + ' 里有 ' + files.length + ' 张图（应为 1 张）');
      process.exit(1);
    }
    plan.push({ id: e.id, src: files[0] });
  });

  const ids = EXPECT.map(function (e) { return e.id; });
  const byId = Object.create(null);
  plan.forEach(function (p) { byId[p.id] = p.src; });

  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

  let totalIn = 0, totalOut = 0;
  ids.forEach(function (id) {
    const src = byId[id];
    const buf = fs.readFileSync(src);
    totalIn += buf.length;

    const dec = decodePng(buf);
    if (dec && dec.err) { console.error('  ✖ ' + id + ' 解码失败：' + dec.err); process.exit(1); }
    if (!dec) { console.error('  ✖ ' + id + ' 不是 PNG'); process.exit(1); }

    const small = resizeArea(dec.rgba, dec.w, dec.h, TARGET, TARGET);
    const q = quantize(small, TARGET, TARGET, COLORS);
    const out = encodePalettePng(q.palette, q.idx, TARGET, TARGET);
    fs.writeFileSync(path.join(OUT, id + '.png'), out);
    totalOut += out.length;

    console.log('  ✔ ' + id.padEnd(12) + dec.w + 'x' + dec.h + ' → ' + TARGET + 'x' + TARGET
      + '  ' + q.palette.length + ' 色  '
      + (buf.length / 1024).toFixed(0) + ' KB → ' + (out.length / 1024).toFixed(0) + ' KB');
  });

  console.log('[prep] 完成：' + ids.length + ' 张，'
    + (totalIn / 1024 / 1024).toFixed(1) + ' MB → ' + (totalOut / 1024).toFixed(0) + ' KB');
}

main();