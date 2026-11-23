// tools/extsprites.js —— 把外部 MIT 精灵转成项目像素矩阵（零依赖）
//
// 【来源】sprite-foundry-packs（MIT，48px 八方向）的 albedo/front.png，
//   素材原件在 tools/assets/ext-mobs/<mobId>.png，来源映射见同目录 SOURCES.txt。
//
// 【为什么只取形状、不取颜色】项目有硬配色约定：暗红 + 琥珀金 + 冷灰、禁紫。
//   外部素材自带蓝/紫/绿，直接搬进来会破配色。这里把它降采样成 10 色字符矩阵，
//   上色仍走 pixel.js 的 paletteFor(def.color) —— 每只怪保留自己的主色，
//   形状来自外部、颜色仍归项目，两边都守得住。
//
// 【一致性】图鉴立绘 tools/mobthumbs.js 本来就从事实矩阵 PIXEL_MOBS 出图，
//   所以本工具只改矩阵、再重跑 mobthumbs，图鉴与战场自动保持同一张脸。
//
// 用法：
//   node tools/extsprites.js            # 只生成 tools/assets/ext-mobs/matrices.json
//   node tools/extsprites.js --apply    # 写回 public/js/pixel-sprites.js

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { TMP, CHROME } = require('./env');

require('../public/js/pixel.js');
require('../public/js/pixel-sprites.js');
const PX = global.VS.PIXEL;
const ART = global.VS.PIXEL_MOBS;

const SRC = path.join(__dirname, 'assets', 'ext-mobs');
const MATRIX_JSON = path.join(SRC, 'matrices.json');
const SPRITES_JS = path.join(__dirname, '..', 'public', 'js', 'pixel-sprites.js');
const CDP_PORT = 9385;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 矩阵数组名映射。★huichun 原本与 blood_priest 共用 BLOOD_PRIEST，
// 这次拆出独立素材，需要新增 HUICHUN 并改 PIXEL_MOBS 的引用。
const CONST_NAME = {
  corpse: 'CORPSE', bat: 'BAT', skeleton_warrior: 'SKELETON_WARRIOR',
  plague_hound: 'PLAGUE_HOUND', blood_spider: 'BLOOD_SPIDER', gargoyle: 'GARGOYLE',
  witch_hunter: 'WITCH_HUNTER', challenger: 'CHALLENGER', shanxiao: 'SHANXIAO',
  twins: 'TWINS', taotie: 'TAOTIE', shadow_puppet: 'SHADOW_PUPPET',
  wangliang: 'WANGLIANG', blood_priest: 'BLOOD_PRIEST', bone_knight: 'BONE_KNIGHT',
  ghoul_matriarch: 'GHOUL_MATRIARCH', blood_lord: 'BLOOD_LORD',
  bone_tyrant: 'BONE_TYRANT', abyss_prelate: 'ABYSS_PRELATE', moon_queen: 'MOON_QUEEN'
};

const DATA = Object.keys(CONST_NAME).concat(['huichun']).map(function (id) {
  const png = path.join(SRC, id + '.png');
  if (!fs.existsSync(png)) throw new Error('缺素材：' + png);
  // 沿用原矩阵的网格尺寸：小怪 16、Boss 20 —— 不破坏战场的体型档位与 px 计算
  const base = ART[id] || ART.corpse;
  const n = base[0].length;
  return { id: id, n: n, dataUrl: 'data:image/png;base64,' + fs.readFileSync(png).toString('base64') };
});

const htmlPath = path.join(TMP, 'vs_extsprites.html');
fs.writeFileSync(htmlPath, '<!doctype html><meta charset="utf-8"><body style="margin:0"></body>', 'utf8');
const pageUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

// 在页面里：加载 PNG → 最近邻降采样 → 映射到 10 色槽位 → 强制四角留白。
const expr = `(async function(){
  var DATA = ${JSON.stringify(DATA)};
  // ★用「每只怪自己的亮度分位」而不是全局绝对阈值：外部素材有深有浅，
  //   固定阈值会把深色怪整只吃掉（只剩几根描边），形状就散成碎片。
  function toChar(p, q){
    if (p.a < 64) return '.';
    var lum = p.r*0.299 + p.g*0.587 + p.b*0.114;
    var sat = Math.max(p.r,p.g,p.b) - Math.min(p.r,p.g,p.b);
    if (p.r > p.g*1.5 && p.r > p.b*1.35 && lum > q.q30 && lum < q.q92) return 'x';
    if (p.r>145 && p.g>100 && p.b<110 && sat>55) return '$';
    if (lum > q.q88 && sat < 30) return 'w';
    if (lum < q.q18) return '#';
    if (lum < q.q42) return '-';
    if (lum > q.q90) return '*';
    if (lum > q.q72) return '=';
    return '+';
  }
  var out=[];
  for (var i=0;i<DATA.length;i++){
    var d=DATA[i];
    var im=new Image(); im.src=d.dataUrl; await im.decode();
    var c=document.createElement('canvas'); c.width=d.n; c.height=d.n;
    var g=c.getContext('2d',{willReadFrequently:true});
    g.imageSmoothingEnabled=false;              // 最近邻：像素画不能被插值糊掉
    g.drawImage(im,0,0,d.n,d.n);
    var px=g.getImageData(0,0,d.n,d.n).data;
    var list=[];
    for (var k=0;k<px.length;k+=4){
      if (px[k+3]>=64) list.push(px[k]*0.299+px[k+1]*0.587+px[k+2]*0.114);
    }
    list.sort(function(a,b){return a-b});
    function q(t){ return list.length ? list[Math.min(list.length-1, Math.floor(list.length*t))] : 0; }
    var Q={q18:q(0.18),q30:q(0.30),q42:q(0.42),q72:q(0.72),q88:q(0.88),q90:q(0.90),q92:q(0.92)};
    var rows=[], seen={};
    for (var y=0;y<d.n;y++){
      var row='';
      for (var x=0;x<d.n;x++){
        var k=(y*d.n+x)*4;
        var p={r:px[k],g:px[k+1],b:px[k+2],a:px[k+3]};
        var ch=toChar(p, Q);
        row+=ch;
        if (ch!=='.'){ (seen[ch]||(seen[ch]=[])).push([p.r,p.g,p.b]); }
      }
      rows.push(row);
    }
    // validateAll 硬约束：四角必须透明，否则描边被裁
    var A=rows.map(function(r){return r.split('')});
    A[0][0]=A[0][d.n-1]=A[d.n-1][0]=A[d.n-1][d.n-1]='.';
    // 每个槽位取素材里的中位色，作为这只怪的专属调色板。
    // ★紫过滤：蓝显著高于红绿且红不低于绿 → 判紫，改成冷灰（项目配色红线）。
    function norm(v){ return Math.max(0,Math.min(255,Math.round(v))); }
    function depurple(c){
      var r=c[0],g=c[1],b=c[2];
      if (b>r*1.08 && b>g*1.05 && r>g*0.88){ var l=(r+b)/2; r=l*0.94; g=l*0.98; b=l; }
      // 非线性提亮：战场底色 #12141a 极暗，深色素材（冥君/影傀）整体提 12%
      // 仍然看不见；亮色（骨白）再提会过曝。所以暗的提 30%、中的 18%、亮的 8%。
      var lum = r*0.299+g*0.587+b*0.114;
      var k = lum < 70 ? 0.30 : (lum < 120 ? 0.18 : 0.08);
      return [norm(r+(255-r)*k), norm(g+(255-g)*k), norm(b+(255-b)*k)];
    }
    var hex=function(c){ return '#'+c.map(function(v){return ('0'+v.toString(16)).slice(-2)}).join(''); };
    var pal={};
    var KEYS={'#':'edge','+':'main','=':'light','-':'dark','@':'deep','*':'hi','o':'pupil','x':'blood','$':'gold','w':'bone'};
    Object.keys(KEYS).forEach(function(ch){
      var s=seen[ch]; if (!s || !s.length) return;
      var med=[0,0,0];
      for (var k=0;k<3;k++){
        var vals=s.map(function(c){return c[k]}).sort(function(a,b){return a-b});
        med[k]=vals[Math.floor(vals.length/2)];
      }
      pal[KEYS[ch]]=hex(depurple(med));
    });
    out.push({id:d.id, art:A.map(function(r){return r.join('')}), pal:pal});
  }
  return out;
})()`;

(async function main () {
  if (!CHROME) { console.log('未找到无头浏览器'); process.exit(1); }
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--allow-file-access-from-files', '--hide-scrollbars',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + TMP + '/vs_extsprites_profile', '--no-proxy-server', 'about:blank'],
    { stdio: 'ignore' });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(350);
    const ok = await fetch('http://127.0.0.1:' + CDP_PORT + '/json/version')
      .then((r) => r.ok).catch(() => false);
    if (ok) { up = true; break; }
  }
  if (!up) { console.log('无头浏览器没起来'); process.exit(1); }

  const tab = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  const send = (method, params) => new Promise((res) => {
    const mid = ++id; pend[mid] = res;
    ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: pageUrl });
  await sleep(700);

  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  const list = res && res.result ? res.result.value : null;
  if (!list || list.length !== DATA.length) { console.log('矩阵转换失败', res && res.exceptionDetails); process.exit(1); }

  // 自检：不能用未知字符、行列必须齐、四角留白、不能全空
  const SLOT = PX.SLOT;
  const bad = [];
  const map = {};
  const pals = {};
  for (const item of list) {
    const art = item.art;
    pals[item.id] = item.pal || {};
    const w = art[0].length;
    let filled = 0;
    for (let r = 0; r < art.length; r++) {
      if (art[r].length !== w) bad.push(item.id + ' 第' + r + '行宽度错');
      for (const ch of art[r]) {
        if (!(ch in SLOT)) bad.push(item.id + ' 未知字符 ' + ch);
        if (ch !== '.') filled++;
      }
    }
    // 蝙蝠/飞龙这类张翼素材天然留白多，阈值放到 8%；低于此基本等于整张空图
    if (filled < w * art.length * 0.08) bad.push(item.id + ' 实心太少（' + filled + '）');
    map[item.id] = art;
  }
  if (bad.length) { console.log('自检失败：\n  - ' + bad.join('\n  - ')); process.exit(1); }

  fs.writeFileSync(MATRIX_JSON, JSON.stringify({ art: map, pal: pals }, null, 2), 'utf8');
  console.log('已生成 ' + list.length + ' 份矩阵 + 专属调色板 → tools/assets/ext-mobs/matrices.json');
  for (const id of ['corpse', 'gargoyle', 'blood_lord']) {
    console.log('\n' + id + ' pal=' + JSON.stringify(pals[id]));
    console.log(map[id].join('\n'));
  }

  if (process.argv.indexOf('--apply') >= 0) {
    let src = fs.readFileSync(SPRITES_JS, 'utf8');
    for (const id of Object.keys(CONST_NAME)) {
      const name = CONST_NAME[id];
      const art = map[id];
      const re = new RegExp('(const ' + name + ' = \\[)[\\s\\S]*?(\\n  \\];)');
      if (!re.test(src)) throw new Error('找不到数组 ' + name);
      const body = '\n' + art.map((r) => "    '" + r + "'").join(',\n') + '\n  ';
      src = src.replace(re, (m, a, b) => a + body.replace(/\n  $/, '') + b);
    }
    // huichun 从「共用 BLOOD_PRIEST」改为独立数组
    const huichunBody = map.huichun.map((r) => "    '" + r + "'").join(',\n');
    const insert = '  // 回春巫：外部 MIT 素材独立一张（不再与巫傩共用）\n  const HUICHUN = [\n' + huichunBody + '\n  ];\n\n';
    src = src.replace('  root.VS.PIXEL_MOBS = {', insert + '  root.VS.PIXEL_MOBS = {');
    src = src.replace('    huichun: BLOOD_PRIEST,', '    huichun: HUICHUN,');
    // 专属调色板：渲染层与图鉴生成器都读这张表（见 render.js / mobthumbs.js）。
    // 只列素材里实际用到的槽位；缺的由 pixel.js 的 paletteFor 兜底补齐。
    const palJs = '\n  // 外部 MIT 素材专属调色板（从素材中位色提取，已过滤紫色）。\n' +
      '  // ★渲染层优先读这张表，缺项再回退 paletteFor(def.color)。\n' +
      '  root.VS.PIXEL_MOB_PALS = ' + JSON.stringify(pals, null, 2).replace(/\n/g, '\n  ') + ';\n';
    src = src.replace('  root.VS.PIXEL_OBSTACLES = {', palJs + '\n  root.VS.PIXEL_OBSTACLES = {');
    fs.writeFileSync(SPRITES_JS, src, 'utf8');
    console.log('\n已写回 public/js/pixel-sprites.js（矩阵 + 专属调色板）');
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
