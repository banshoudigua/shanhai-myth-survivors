// tools/imgfit.js —— 把生成的大图裁切+缩到网页能用的尺寸（零依赖）
//
// 【为什么需要】生图工具出的是 1024×1024、1~2MB 的 PNG；这张图在界面上只占
//   几十像素宽，直接引用等于让大厅首屏多下几兆。项目里又**不装 sharp**（本机
//   npm install 会卡死），所以用无头 Chrome 的 canvas 做一次「裁切 + 缩放 + 压 PNG」。
//
// 【两种裁法】
//   --trim   按 alpha 裁掉四周透明边（徽章类素材用这个，去掉生成图自带的大片留白）
//   --crop   指定裁切矩形（纹理类素材用这个，用来切掉角落的水印）
//
// 【实现方式】不把图片塞进 evaluate 的表达式里（几百 KB 的 base64 表达式很容易
//   把 CDP 消息撑爆，实测会直接失败）：改成写一个临时 HTML，用 --allow-file-access-from-files
//   让页面直接 <img src="file:///...">，脚本只发一小段 canvas 操作。
//
// 用法：
//   node tools/imgfit.js 输入.png 输出.png 160 --trim
//   node tools/imgfit.js 输入.png 输出.png 512 --crop=0,0,1024,924

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TMP, CHROME } = require('./env');

const SRC = process.argv[2];
const OUT = process.argv[3];
const SIZE = parseInt(process.argv[4] || '256', 10);
const MODE = process.argv[5] || '';
const CROP = /--crop=(\d+),(\d+),(\d+),(\d+)/.exec(MODE);
const CDP_PORT = 9379;

if (!SRC || !OUT) {
  console.log('用法：node tools/imgfit.js 输入.png 输出.png 尺寸 [--trim | --crop=x,y,w,h]');
  process.exit(1);
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// 临时页面：同一个目录放 HTML 与图片引用（file:// 下相对路径最稳）
const abs = path.resolve(SRC);
const htmlPath = path.join(TMP, 'vs_imgfit.html');
fs.writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8">' +
  '<body style="margin:0;background:#000"><img id="im" src="file:///' +
  abs.replace(/\\/g, '/') + '"></body>', 'utf8');
const pageUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

const expr = `(function(){
  var img = document.getElementById('im');
  if (!img || !img.complete || !img.naturalWidth) return null;
  var crop = null;
  ${(MODE === '--trim' || MODE === '--keywhite') ? `
  var c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  var cx = c.getContext('2d');
  cx.drawImage(img, 0, 0);
  var data = cx.getImageData(0, 0, c.width, c.height).data;
  var minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (var y = 0; y < c.height; y += 2) {
    for (var x = 0; x < c.width; x += 2) {
      if (data[(y * c.width + x) * 4 + 3] > 16) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX > minX && maxY > minY) crop = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  // ★生图给的「透明底」常常落地成白底：把亮且中性的像素抠掉，
  //   边缘按亮度做一段渐变，避免留下白色描边。抠完再求内容框才准。
  if ('${MODE}' === '--keywhite') {
    for (var i2 = 0; i2 < data.length; i2 += 4) {
      var mn = Math.min(data[i2], data[i2 + 1], data[i2 + 2]);
      if (mn >= 232) data[i2 + 3] = 0;
      else if (mn > 196) data[i2 + 3] = Math.round((232 - mn) / 36 * 255);
    }
    cx.putImageData(new ImageData(data, c.width, c.height), 0, 0);
    minX = c.width; minY = c.height; maxX = 0; maxY = 0;
    for (var y2 = 0; y2 < c.height; y2 += 2) {
      for (var x2 = 0; x2 < c.width; x2 += 2) {
        if (data[(y2 * c.width + x2) * 4 + 3] > 16) {
          if (x2 < minX) minX = x2; if (x2 > maxX) maxX = x2;
          if (y2 < minY) minY = y2; if (y2 > maxY) maxY = y2;
        }
      }
    }
    crop = (maxX > minX && maxY > minY) ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  }
  ` : ''}
  ${CROP ? 'crop = { x: ' + CROP[1] + ', y: ' + CROP[2] + ', w: ' + CROP[3] + ', h: ' + CROP[4] + ' };' : ''}
  if (!crop) crop = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
  var out = document.createElement('canvas');
  out.width = ${SIZE}; out.height = ${SIZE};
  var ox = out.getContext('2d');
  // 保持比例：长边缩到 SIZE 后居中（徽章不会被拉扁）
  var scale = Math.max(crop.w, crop.h) / ${SIZE};
  var dw = crop.w / scale, dh = crop.h / scale;
  ox.imageSmoothingEnabled = true;
  ox.drawImage(img, crop.x, crop.y, crop.w, crop.h, (${SIZE} - dw) / 2, (${SIZE} - dh) / 2, dw, dh);
  return { png: out.toDataURL('image/png'), crop: crop, w: img.naturalWidth, h: img.naturalHeight };
})()`;

(async function main() {
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + TMP + '/vs_imgfit_profile', '--no-proxy-server', 'about:blank'], { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    const ok = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')
      .then(function (r) { return r.ok; }).catch(function () { return false; });
    if (ok) { up = true; break; }
  }
  if (!up) { console.log('无头浏览器没起来'); process.exit(1); }

  const tab = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pend = {};
  const send = function (method, params) {
    return new Promise(function (res) {
      const mid = ++id;
      pend[mid] = res;
      ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
    });
  };
  ws.addEventListener('message', function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; }
  });
  await new Promise(function (r) { ws.addEventListener('open', r); });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: pageUrl });
  await sleep(1500);      // 等图片解码（1024² 的 PNG 一瞬间就够）

  let val = null;
  for (let i = 0; i < 10; i++) {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    val = res && res.result ? res.result.value : null;
    if (val && val.png) break;
    await sleep(600);
  }
  if (!val || !val.png) { console.log('处理失败（图片没载入或 canvas 被拒）'); process.exit(1); }

  const b64 = String(val.png).replace(/^data:image\/png;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  const srcSize = Math.round(fs.statSync(SRC).size / 1024);
  console.log('原始 ' + val.w + '×' + val.h +
    ' → 裁切 ' + val.crop.w + '×' + val.crop.h + ' @' + val.crop.x + ',' + val.crop.y +
    ' → ' + SIZE + '×' + SIZE + '，体积 ' + srcSize + 'KB → ' + Math.round(buf.length / 1024) + 'KB');
  process.exit(0);
})();
