// tools/mobthumbs.js —— 从「真实游戏像素素材」渲染 21 只妖物立绘（零依赖）
//
// 【为什么不用生图】图鉴立绘的职责是让玩家「一眼认出这只怪」——游戏里它就是
//   那张像素精灵。AI 生图会给每只怪画出不同的脸，点开图鉴反而对不上号。
//   真正的素材就在 public/js/pixel-sprites.js（PIXEL_MOBS），直接用 PX.drawCentered
//   按怪物主色上色即可 —— 所见即所得，且改精灵时立绘自动跟着变。
//
// 【零依赖】与 mapthumbs.js 同一套无头 Chrome + canvas + toDataURL 机制，
//   不装 sharp（本机 npm install 会卡死）。
//
// 用法：node tools/mobthumbs.js
// 产物：public/img/mobs/<id>.png（160×160，透明底，约 3~8KB）

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const MOBS = require('../shared/const.js').MOBS;
const { TMP, CHROME } = require('./env');

// 在 Node 里直接加载两个 UMD（它们挂在 global.VS 上），拿到素材矩阵
require('../public/js/pixel.js');
require('../public/js/pixel-sprites.js');
const PX = global.VS.PIXEL;
const ART = global.VS.PIXEL_MOBS;

const OUT_DIR = path.join(__dirname, '..', 'public', 'img', 'mobs');
const SIZE = 160;
const CDP_PORT = 9384;
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// 每条：id + 矩阵 + 现算的调色板（paletteFor 是纯函数，Node 里就能算好）
const DATA = MOBS.map(function (m) {
  const art = ART[m.id] || ART.corpse;
  const cols = art[0].length;
  // 16 格用 8px/格（128），20 格用 7px/格（140）—— 都留足边距
  const px = cols <= 16 ? 8 : 7;
  // 与战场渲染同一套优先级：外部素材专属调色板 > 项目主色兜底。
  // ★这样图鉴立绘与战场上看到的才是同一张脸、同一套颜色。
  const extPal = (global.VS.PIXEL_MOB_PALS && global.VS.PIXEL_MOB_PALS[m.id]) || null;
  const pal = extPal ? Object.assign(PX.paletteFor(m.color), extPal) : PX.paletteFor(m.color);
  return { id: m.id, name: m.name, tier: m.tier, color: m.color, art: art, px: px, pal: pal };
});

const htmlPath = path.join(TMP, 'vs_mobthumbs.html');
fs.writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><body style="margin:0"></body>', 'utf8');
const pageUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

// 把 pixel.js 的绘制逻辑内联进 evaluate（避免 page 再引脚本）；slot 映射与 PX 一致
const expr = `(function(){
  var DATA = ${JSON.stringify(DATA)};
  var SIZE = ${SIZE};
  var SLOT = { '.':null, '#':'edge', '+':'main', '=':'light', '-':'dark', '@':'deep',
               '*':'hi', 'o':'pupil', 'x':'blood', '$':'gold', 'w':'bone' };
  function draw(g, art, x, y, px, pal){
    for (var r=0;r<art.length;r++){
      var row=art[r], start=-1, cur=null;
      for (var c=0;c<=row.length;c++){
        var key = c<row.length ? SLOT[row[c]] : undefined;
        var col = key ? (pal[key]||null) : null;
        if (col!==cur){
          if (cur){ g.fillStyle=cur; g.fillRect(x+start*px, y+r*px, (c-start)*px, px); }
          start=c; cur=col;
        }
      }
    }
  }
  var out=[];
  for (var i=0;i<DATA.length;i++){
    var d=DATA[i];
    var c=document.createElement('canvas'); c.width=SIZE; c.height=SIZE;
    var g=c.getContext('2d');
    g.imageSmoothingEnabled=false;
    var cols=d.art[0].length, rows=d.art.length, px=d.px;
    var w=cols*px, h=rows*px;
    var ox=Math.round((SIZE-w)/2), oy=Math.round((SIZE-h)/2)+4; // 略微下移给顶部留呼吸

    // 地面投影（贴地椭圆，暗色），不用跨层契约色
    g.save();
    g.globalAlpha=0.5;
    g.fillStyle='rgba(0,0,0,0.5)';
    g.beginPath();
    g.ellipse(SIZE/2, oy+h-2, w*0.34, Math.max(5,px*1.1), 0, 0, Math.PI*2);
    g.fill();
    g.restore();

    draw(g, d.art, ox, oy, px, d.pal);
    out.push({ id:d.id, png:c.toDataURL('image/png') });
  }
  return out;
})()`;

(async function main () {
  if (!CHROME) { console.log('未找到无头浏览器'); process.exit(1); }
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + TMP + '/vs_mobthumbs_profile', '--no-proxy-server', 'about:blank'],
    { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(350);
    const ok = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')
      .then(r => r.ok).catch(() => false);
    if (ok) { up = true; break; }
  }
  if (!up) { console.log('无头浏览器没起来'); process.exit(1); }

  const tab = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  const send = function (method, params) {
    return new Promise(function (res) {
      const mid = ++id; pend[mid] = res;
      ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
    });
  };
  ws.addEventListener('message', function (ev) {
    const m = JSON.parse(ev.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; }
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: pageUrl });
  await sleep(700);

  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const list = res && res.result ? res.result.value : null;
  if (!list || !list.length) { console.log('立绘渲染失败'); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const item of list) {
    const buf = Buffer.from(String(item.png).replace(/^data:image\/png;base64,/, ''), 'base64');
    fs.writeFileSync(path.join(OUT_DIR, item.id + '.png'), buf);
  }
  console.log('已生成 ' + list.length + ' 张立绘 → public/img/mobs/');
  process.exit(0);
})();
