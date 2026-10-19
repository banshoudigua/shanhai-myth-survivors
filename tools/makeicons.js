// tools/makeicons.js —— 生成站点图标（零依赖）
//
// 【为什么不手搓这些图标文件】
// 图标是这个项目里唯一「每次设计微调都要重出一整套二进制」的东西：
// 16/32/48 的 ico、180 的 apple-touch、192/512 的 PWA、还有一个矢量 svg。
// 手工维护必然出现「改了 svg 忘了改 png」「三个尺寸颜色不一致」。
// 所以这里用**同一份几何定义**算出所有尺寸 —— 保证每个文件长得一模一样，
// 只是分辨率不同。
//
// 【为什么不用任何依赖】
// 1) 本机 npm install 会卡死（项目硬约定，见用户级记忆）；仓库里也不该为几张图标引入包。
// 2) PNG 编码其实很短：zlib.deflateSync 是 Node 内置的，剩下的就是几个 chunk 拼装。
//
// 输出（全部写进 public/）：
//   favicon.svg                矢量，浏览器标签页用
//   favicon.ico                16/32/48 三合一，传统浏览器与书签
//   favicon-32.png             32px PNG（部分浏览器的标签页优先挑它）
//   apple-touch-icon.png       180px，**不透明方角**（iOS 自己画圆角，透明会被填成黑块）
//   icon-192.png / icon-512.png  PWA / manifest 用
//   site.webmanifest            PWA 清单（start_url / display / theme_color）
//
// 用法：node tools/makeicons.js

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.join(__dirname, '..', 'public');

// ============================================================
// 设计（全部用 0~1 的连续坐标，最后一次性量化成像素画）
// ============================================================
// 配色取项目主题：暗红 + 琥珀金 + 冷灰。**不引入紫/紫蓝**（项目硬约定）。
const COLORS = {
  bg: [0x14, 0x16, 0x1a],        // 冷灰近黑，与 theme.css 的 --bg 一致
  drop: [0xc9, 0x3a, 0x3a],      // 暗红，血珠主色
  dropLit: [0xe8, 0x5c, 0x4a],   // 受光面
  dropDark: [0x8c, 0x1f, 0x22],  // 背光面
  spec: [0xf2, 0xc1, 0x4e]       // 琥珀金高光（主题强调色）
};

// 像素画的设计分辨率：先在 32×32 的网格上算好，再按整数倍放大。
// 用 16 会丢太多细节（高光就没了），用 64 又会让 16px 缩略图糊成一团。
const DESIGN_N = 32;

// —— 血珠形状 = 圆 ∪ 顶点切线三角形 ——
// 圆心与半径决定了「肚子」的大小，顶点 P 决定「尖」有多长。
// ★tipY 别太靠上（0.145 太尖，看着像气球而不是血珠），0.21 才是「上尖下圆」的比例。
const DROP = { cx: 0.5, cy: 0.635, r: 0.30, tipY: 0.215 };
// 高光点：左上偏内，打光方向与阴影相反。★别贴边，贴边会被圆角矩形裁掉
const SPEC = { x: 0.395, y: 0.475, r: 0.072 };

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// 血珠：圆 ∪ 三角形（P, T1, T2）。三角形取切线，形状才「胖瘦匀称」，
// 用「顶点正下方的等腰三角形」会在圆与三角的接缝处出现台阶。
function inDrop(x, y) {
  const c = DROP;
  if (inCircle(x, y, c.cx, c.cy, c.r)) return true;

  // 切线角：sin α = r / |C - P|
  const d = c.cy - c.tipY;
  const sinA = c.r / d;
  const cosA = Math.sqrt(1 - sinA * sinA);
  const tx1 = c.cx + c.r * sinA;
  const tx2 = c.cx - c.r * sinA;
  const ty = c.cy + c.r * cosA;

  // 只关心顶点与圆心之间的那一段（三角形的下半截全在圆里）
  if (y > ty) return false;

  // 叉积判在三角形内。三个顶点：顶点 P、左切点、右切点
  const ax = c.cx, ay = c.tipY;   // P
  const bx = tx1, by = ty;        // 右切点
  const cx2 = tx2, cy2 = ty;      // 左切点
  const s1 = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  const s2 = (x - bx) * (cy2 - by) - (y - by) * (cx2 - bx);
  const s3 = (x - cx2) * (ay - cy2) - (y - cy2) * (ax - cx2);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

// 圆角矩形（apple-touch-icon 要方角：iOS 自己画圆角）
function inRoundRect(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  if (x >= radius && x <= 1 - radius) return true;
  if (y >= radius && y <= 1 - radius) return true;
  return dx * dx + dy * dy <= radius * radius;
}

// 单个设计像素的颜色
function sample(x, y, radius) {
  if (!inRoundRect(x, y, radius)) return null;          // 圆角外 = 透明

  // 背景（带一点纵向渐变，避免大尺寸下显得死板）
  const shade = 1 - 0.18 * y;
  const r0 = Math.round(COLORS.bg[0] * shade);
  const g0 = Math.round(COLORS.bg[1] * shade);
  const b0 = Math.round(COLORS.bg[2] * shade);

  if (!inDrop(x, y)) return [r0, g0, b0, 255];

  // 血珠内部的明暗：右下暗、左上亮。
  // ★分档而不是一刀切 —— 单个 t > 阈值 的硬边界会在图上留下一条笔直的斜线，
  //   32px 上看着像「被刀切过」。分三档 + 过渡带才有球体的圆润感。
  const t = (x - 0.40) * 0.85 + (y - 0.46) * 0.62;
  let c;
  if (t > 0.34) c = COLORS.dropDark;
  else if (t > 0.22) c = mix(COLORS.drop, COLORS.dropDark, 0.5);
  else if (t < -0.14) c = COLORS.dropLit;
  else if (t < -0.04) c = mix(COLORS.drop, COLORS.dropLit, 0.45);
  else c = COLORS.drop;
  let out = [c[0], c[1], c[2], 255];

  // 高光最后画（压在血珠上）
  if (inCircle(x, y, SPEC.x, SPEC.y, SPEC.r)) {
    out = [COLORS.spec[0], COLORS.spec[1], COLORS.spec[2], 255];
  }
  return out;
}

function mix(a, b, k) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k)
  ];
}

// ============================================================
// 1) 算出 32×32 的设计网格（每个像素用 4×4 超采样取众数，边缘才不会有锯齿噪点）
// ============================================================

const SS = 4;

function renderGrid(n) {
  const grid = [];
  for (let py = 0; py < n; py++) {
    const row = [];
    for (let px = 0; px < n; px++) {
      // 累积颜色：透明像素不参与平均，否则边缘会被背景色拉脏
      let r = 0, g = 0, b = 0, a = 0, cnt = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / n;
          const y = (py + (sy + 0.5) / SS) / n;
          const c = sample(x, y, 0.2);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += c[3]; cnt++;
        }
      }
      row.push(cnt === 0 ? [0, 0, 0, 0] : [
        Math.round(r / cnt), Math.round(g / cnt), Math.round(b / cnt), Math.round(a / cnt)
      ]);
    }
    grid.push(row);
  }
  return grid;
}

// 缩放到目标尺寸：整数倍用最近邻（保住像素画的硬边），非整数倍用面积平均（避免摩尔纹）
function resample(grid, size) {
  const n = grid.length;
  const out = [];
  const ratio = n / size;
  const nearest = Math.abs(ratio - Math.round(ratio)) < 1e-6;
  const k = Math.round(ratio);

  for (let y = 0; y < size; y++) {
    const row = [];
    for (let x = 0; x < size; x++) {
      if (nearest) {
        row.push(grid[y * k][x * k]);
        continue;
      }
      // 面积平均：把目标像素覆盖到的源像素按面积权重混色
      const x0 = x * ratio, y0 = y * ratio;
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.min(n, Math.ceil(y0 + ratio)); sy++) {
        const ovY = Math.min(y0 + ratio, sy + 1) - Math.max(y0, sy);
        if (ovY <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.min(n, Math.ceil(x0 + ratio)); sx++) {
          const ovX = Math.min(x0 + ratio, sx + 1) - Math.max(x0, sx);
          if (ovX <= 0) continue;
          const w = ovX * ovY;
          const c = grid[sy][sx];
          r += c[0] * c[3] * w; g += c[1] * c[3] * w; b += c[2] * c[3] * w;
          a += c[3] * w; wsum += w;
        }
      }
      if (a === 0 || wsum === 0) { row.push([0, 0, 0, 0]); continue; }
      const aw = a / wsum;                     // 平均 alpha
      const norm = a === 0 ? 1 : a;
      row.push([
        Math.round(r / norm), Math.round(g / norm), Math.round(b / norm), Math.round(aw)
      ]);
    }
    out.push(row);
  }
  return out;
}

// ============================================================
// 2) PNG 编码（zlib 是 Node 内置，够用了）
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

// grid → PNG 字节流（RGBA / 8bit）
function encodePng(grid) {
  const n = grid.length;
  const raw = Buffer.alloc(n * (n * 4 + 1));
  let off = 0;
  for (let y = 0; y < n; y++) {
    raw[off++] = 0;                            // filter type 0（None）
    for (let x = 0; x < n; x++) {
      const c = grid[y][x];
      raw[off++] = c[0]; raw[off++] = c[1]; raw[off++] = c[2]; raw[off++] = c[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // color type: RGBA
  ihdr[10] = 0;   // compression
  ihdr[11] = 0;   // filter
  ihdr[12] = 0;   // interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ============================================================
// 3) ICO 打包（Vista 之后可以直接内嵌 PNG，省掉 BMP 那套 32bpp 手工编码）
// ============================================================

function buildIco(pngs) {
  // pngs: [{size, buf}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach(function (p, i) {
    const b = i * 16;
    dir[b] = p.size >= 256 ? 0 : p.size;      // 0 表示 256
    dir[b + 1] = p.size >= 256 ? 0 : p.size;
    dir[b + 2] = 0;                            // 调色板数（真彩色写 0）
    dir[b + 3] = 0;                            // reserved
    dir.writeUInt16LE(1, b + 4);               // color planes
    dir.writeUInt16LE(32, b + 6);              // bits per pixel
    dir.writeUInt32LE(p.buf.length, b + 8);
    dir.writeUInt32LE(offset, b + 12);
    offset += p.buf.length;
  });

  return Buffer.concat([header, dir].concat(pngs.map(function (p) { return p.buf; })));
}

// ============================================================
// 4) SVG（从设计网格生成，保证与 PNG 像素级一致）
// ============================================================

// ★必须做「水平连续段合并」，不能一个像素一个 rect ——
//   32×32 = 1024 个 rect，每个约 60 字节 → 光这一个文件就 56 KB，
//   每个标签页都要下载它。合并之后同一行的同色像素变成一个矩形，只剩几十个。
// （不透明像素按颜色分桶；半透明的边角像素单独走 path，宁可多几个也别丢质量。）
function buildSvg(grid) {
  const n = grid.length;
  const paths = Object.create(null);   // 颜色 → path 片段

  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      const c = grid[y][x];
      if (c[3] === 0) { x++; continue; }

      // 从 x 起向右找「完全同色」的连续段
      let w = 1;
      while (x + w < n) {
        const d = grid[y][x + w];
        if (d[0] !== c[0] || d[1] !== c[1] || d[2] !== c[2] || d[3] !== c[3]) break;
        w++;
      }

      const key = rgbToHex(c[0], c[1], c[2]) + (c[3] === 255 ? '' : '_' + c[3]);
      paths[key] = (paths[key] || '') +
        'M' + x + ' ' + y + 'h' + w + 'v1h-' + w + 'z';
      x += w;
    }
  }

  let body = '';
  Object.keys(paths).forEach(function (key) {
    const parts = key.split('_');
    const op = parts[1] ? ' fill-opacity="' + (Number(parts[1]) / 255).toFixed(3) + '"' : '';
    body += '<path fill="' + parts[0] + '"' + op + ' d="' + paths[key] + '"/>';
  });

  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" ' +
    'width="' + n + '" height="' + n + '" shape-rendering="crispEdges">' +
    '<title>山海神话传</title>' + body + '</svg>\n';
}

function rgbToHex(r, g, b) {
  const h = function (v) { return ('0' + v.toString(16)).slice(-2); };
  return '#' + h(r) + h(g) + h(b);
}

// ============================================================
// 5) 写文件
// ============================================================

const grid32 = renderGrid(DESIGN_N);
const png32 = encodePng(grid32);

fs.writeFileSync(path.join(OUT_DIR, 'favicon.svg'), buildSvg(grid32), 'utf8');
fs.writeFileSync(path.join(OUT_DIR, 'favicon-32.png'), png32);

fs.writeFileSync(path.join(OUT_DIR, 'favicon.ico'), buildIco([
  { size: 16, buf: encodePng(resample(grid32, 16)) },
  { size: 32, buf: png32 },
  { size: 48, buf: encodePng(resample(grid32, 48)) }
]));

fs.writeFileSync(path.join(OUT_DIR, 'apple-touch-icon.png'), encodePng(renderGrid(180)));
fs.writeFileSync(path.join(OUT_DIR, 'icon-192.png'), encodePng(renderGrid(192)));
fs.writeFileSync(path.join(OUT_DIR, 'icon-512.png'), encodePng(renderGrid(512)));

// manifest：start_url 用 '/'（大厅），display standalone 让「添加到主屏幕」像原生应用
fs.writeFileSync(path.join(OUT_DIR, 'site.webmanifest'), JSON.stringify({
  name: '山海神话传',
  short_name: '山海神话传',
  description: '山海神话 · 局域网合作生存',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  background_color: '#0f1114',
  theme_color: '#0f1114',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
}, null, 2) + '\n', 'utf8');

console.log('[icons] 已生成：favicon.svg / favicon-32.png / favicon.ico(16,32,48) / ' +
  'apple-touch-icon.png / icon-192.png / icon-512.png / site.webmanifest');