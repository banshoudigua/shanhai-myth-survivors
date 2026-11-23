// tools/mapthumbs.js —— 从「真实地形数据」渲染六张地图缩略图（零依赖）
//
// 【为什么不用生图】缩略图的职责是让玩家**一眼认出这张图长什么样**：
//   乱葬岗是散落墓碑、轮回廊是规则柱阵、祭天台是断墙广场、血月祭坛是中央环阵、
//   镇妖塔是 45° 斜阵、毒泽孤屿是成簇孤岛。生图画的是「氛围」，画不出真实布局，
//   玩家点进去发现和缩略图对不上反而更糟。
//   而这些布局本来就在 shared/maps.js 里（buildObstacles/buildProps 是纯函数），
//   直接把它画成俯视小地图 —— **所见即所得**，且换图/改地形时缩略图自动跟着变。
//
// 【零依赖】项目不装 sharp（本机 npm install 会卡死），用无头 Chrome 的 canvas
//   画 + toDataURL 导出 PNG，和 imgfit.js 同一套 CDP 机制。
//
// 【确定性】障碍坐标来自 buildObstacles 的 LCG（同一个 mapId 永远同一份），
//   噪点用 seedOf(id) 派生的另一条 LCG —— 每次生成逐字节相同，可 MD5 比对。
//
// 用法：node tools/mapthumbs.js
// 产物：public/img/maps/<id>.png（240×150，约 20~40KB）

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const MAPS = require('../shared/maps.js');
const { TMP, CHROME } = require('./env');

const OUT_DIR = path.join(__dirname, '..', 'public', 'img', 'maps');
const W = 240, H = 150;
const CDP_PORT = 9383;
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// 把每张地图的真实地形算好，序列化喂给浏览器画
const DATA = MAPS.MAPS.map(function (m) {
  return {
    id: m.id,
    name: m.name,
    w: m.w, h: m.h,
    theme: m.theme,
    obTheme: m.obTheme || {},
    obstacles: MAPS.buildObstacles(m),
    props: MAPS.buildProps(m),
    chests: MAPS.buildChests(m),
    shrines: MAPS.buildShrines(m),
    seed: MAPS.seedOf(m.id)
  };
});

// 临时 HTML：只放一个空 canvas，绘制逻辑全在 evaluate 里（数据走 JSON 注入）
const htmlPath = path.join(TMP, 'vs_mapthumbs.html');
fs.writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><body style="margin:0"></body>', 'utf8');
const pageUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

const expr = `(function(){
  var DATA = ${JSON.stringify(DATA)};
  var W = ${W}, H = ${H};
  function lcg(seed){ var s=seed>>>0; return function(){ s=(s*1664525+1013904223)>>>0; return s/4294967296; }; }
  function rgba(base, a){ // base 形如 'rgba(120,24,32,0.16)' 或 'rgba(132,20,34,'
    var nums = (base.match(/[\\d.]+/g)||[]).map(Number);
    return 'rgba('+nums[0]+','+nums[1]+','+nums[2]+','+a+')';
  }
  var out = [];
  for (var di=0; di<DATA.length; di++){
    var d = DATA[di];
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');

    // 1) 地面底色
    g.fillStyle = d.theme.ground;
    g.fillRect(0,0,W,H);

    // 2) 中心辉光：把整张图的中心当成光源，越往外越暗
    var grd = g.createRadialGradient(W/2,H/2,4, W/2,H/2, Math.max(W,H)*0.72);
    grd.addColorStop(0, rgba(d.theme.glow, 0.85));
    grd.addColorStop(1, 'rgba(0,0,0,0.32)');
    g.fillStyle = grd;
    g.fillRect(0,0,W,H);

    // 3) 地面噪点（密度跟地图的 speck 走）：营造「地表质感」，不是纯色块
    var rnd = lcg(d.seed ^ 0x9e3779b9);
    var dots = Math.round(150 * (d.theme.speck||1));
    g.fillStyle = rgba(d.theme.stain || 'rgba(120,20,30,', 0.5);
    for (var i=0;i<dots;i++){
      var px = rnd()*W, py = rnd()*H;
      var rr = 0.4 + rnd()*1.2;
      g.globalAlpha = 0.18 + rnd()*0.24;
      g.fillRect(px, py, rr, rr);
    }
    g.globalAlpha = 1;

    // 4) deco 纹理提示：砖/石板画淡网格，环形画同心圈，其余画散点
    g.strokeStyle = rgba(d.theme.stain || 'rgba(120,20,30,', 0.16);
    g.lineWidth = 1;
    if (d.theme.deco==='brick' || d.theme.deco==='flagstone'){
      for (var gx=0; gx<W; gx+=18){ g.beginPath(); g.moveTo(gx,0); g.lineTo(gx,H); g.stroke(); }
      for (var gy=0; gy<H; gy+=14){ g.beginPath(); g.moveTo(0,gy); g.lineTo(W,gy); g.stroke(); }
    } else if (d.theme.deco==='altar'){
      for (var k=1;k<=3;k++){ g.beginPath(); g.ellipse(W/2,H/2,k*W*0.13,k*H*0.18,0,0,Math.PI*2); g.stroke(); }
    }

    // 把世界坐标映射到缩略图（留 6px 内边距）
    var pad = 7;
    var sx = (W-pad*2)/d.w, sy = (H-pad*2)/d.h;
    function TX(x){ return pad + x*sx; }
    function TY(y){ return pad + y*sy; }

    // 5) 障碍：按真实半径画圆（带描边与顶部高光），一眼看出柱阵/断墙/环阵/孤岛
    var ob = d.obTheme || {};
    var solid = ob.solid || '#55606b', edge = ob.edge || '#1a1e24', hi = ob.hi || '#7d8a97';
    for (var oi=0; oi<d.obstacles.length; oi++){
      var o = d.obstacles[oi];
      var cx = TX(o.x), cy = TY(o.y);
      var r = Math.max(1.6, o.r * Math.min(sx,sy) * 1.7); // 放大一点，缩略图里才看得见
      g.beginPath(); g.arc(cx,cy,r,0,Math.PI*2);
      g.fillStyle = o.color || solid; g.fill();
      g.lineWidth = 1; g.strokeStyle = o.edge || edge; g.stroke();
      // 顶面高光
      g.beginPath(); g.arc(cx-r*0.2,cy-r*0.25,r*0.42,0,Math.PI*2);
      g.fillStyle = o.hi || hi; g.globalAlpha = 0.55; g.fill(); g.globalAlpha = 1;
    }

    // 6) 宝箱 / 神龛 / 传送门：小标记，提示「这张图有东西可拿」
    function mark(x,y,color,r){
      g.beginPath(); g.arc(TX(x),TY(y),r,0,Math.PI*2);
      g.fillStyle=color; g.globalAlpha=0.9; g.fill(); g.globalAlpha=1;
    }
    for (var ci=0;ci<d.chests.length;ci++) mark(d.chests[ci].x,d.chests[ci].y,'#f4c455',2.4);
    for (var si=0;si<d.shrines.length;si++) mark(d.shrines[si].x,d.shrines[si].y,'#5fe0b0',2.2);

    // 7) 出生点：中心一个冷灰小环
    g.beginPath(); g.arc(W/2,H/2,4.5,0,Math.PI*2);
    g.strokeStyle='rgba(220,230,240,0.75)'; g.lineWidth=1.4; g.stroke();

    // 8) 暗角 + 内描边，收住画面
    var vg = g.createRadialGradient(W/2,H/2,Math.min(W,H)*0.22, W/2,H/2, Math.max(W,H)*0.62);
    vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,0.42)');
    g.fillStyle=vg; g.fillRect(0,0,W,H);
    g.strokeStyle='rgba(244,196,85,0.28)'; g.lineWidth=2; g.strokeRect(1,1,W-2,H-2);

    out.push({ id:d.id, png:c.toDataURL('image/png') });
  }
  return out;
})()`;

(async function main () {
  if (!CHROME) { console.log('未找到无头浏览器'); process.exit(1); }
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + TMP + '/vs_mapthumbs_profile', '--no-proxy-server', 'about:blank'],
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
  if (!list || !list.length) { console.log('缩略图渲染失败'); process.exit(1); }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const item of list) {
    const buf = Buffer.from(String(item.png).replace(/^data:image\/png;base64,/, ''), 'base64');
    const file = path.join(OUT_DIR, item.id + '.png');
    fs.writeFileSync(file, buf);
    console.log(item.id + '.png  ' + W + '×' + H + '  ' + Math.round(buf.length / 1024) + 'KB');
  }
  process.exit(0);
})();
