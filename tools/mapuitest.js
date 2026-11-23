// tools/mapuitest.js —— 三处「地图缩略图卡片」版式回归
//
// 守什么（用户报障：地图选择那块布局不好、各地图要有缩略图）：
//   ① 大厅单人战场：6 张卡 + 6 张缩略图都成功加载（naturalWidth > 0）
//   ② 候场室对局地图：同样 6 张卡、缩略图、房主能点 / 非房主锁定
//   ③ 剧情关卡卡片：每关都带一张缩略图，且不越出卡片边界
//   ④ 三处版式统一：都用 .map-card / .sc-thumb，缩略图 8:5 不变形
//   ⑤ 响应式：390px 窄屏不出现横向滚动条
//
// 用法：node tools/mapuitest.js [端口或域名] [宽] [高]

const { spawn } = require('node:child_process');
const { TMP, CHROME, splitShare, shareSuffix } = require('./env');
const CDP_PORT = 9385;
const PROFILE = TMP + '/vs_mapui_profile';

function proxyArgs(LIVE) {
  const p = process.env.http_proxy || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  return (LIVE && p) ? ['--proxy-server=' + p] : ['--no-proxy-server'];
}

const APP_IN = String(process.argv[2] || 3031);
const SHARE_RAW = splitShare(APP_IN);
const LIVE = /^(https?:)?\/\//.test(SHARE_RAW.url);
const BASE = LIVE ? SHARE_RAW.url.replace(/\/$/, '') : ('http://127.0.0.1:' + APP_IN);
const SHARE = SHARE_RAW.code ? ('?sharecode=' + SHARE_RAW.code) : '';
const VW = Number(process.argv[3] || 1100);
const VH = Number(process.argv[4] || 900);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (extra !== undefined ? ('  -> ' + extra) : '')); }
}

async function main () {
  console.log('=== 地图缩略图卡片版式回归（' + BASE + ' ' + VW + 'x' + VH + '）===');
  if (!require('node:fs').existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }

  const alive = await fetch(BASE + '/api/health' + (SHARE ? '?sharecode=' + SHARE_RAW.code : ''))
    .then(r => r.status === 200).catch(() => false);
  if (!alive) { console.log('!! 应用服务未就绪：' + BASE); process.exit(1); }

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + CDP_PORT,
    '--remote-allow-origins=*', '--window-size=' + VW + ',' + VH, 'about:blank'
  ].concat(proxyArgs(LIVE)), { stdio: 'ignore' });

  await sleep(2200);
  const tab = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  const send = (m, p) => new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => rej(new Error('timeout ' + m)), 20000);
    pend[i] = (r) => { clearTimeout(t); res(r); };
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const evalJS = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r && r.result ? r.result.value : null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/index.html?debug=1' + (SHARE ? '&sharecode=' + SHARE_RAW.code : '') });
  await sleep(2600);

  // 进大厅（enterAsGuest 之后要等 WebSocket 连上才会切到大堂视图）
  await evalJS('window.VS_LOBBY.enterAsGuest("地图测试"); true');
  for (let i = 0; i < 40; i++) {
    const shown = await evalJS('!!document.querySelector(".battlefield .map-grid")');
    if (shown) break;
    await sleep(300);
  }

  // ---------- ① 大厅单人战场 ----------
  // 等六张缩略图都解码完再量，避免「图还在下就被判碎图」的假红
  for (let i = 0; i < 20; i++) {
    const n = await evalJS(`(function(){
      var imgs = Array.prototype.slice.call(document.querySelectorAll('.battlefield .mc-thumb img'));
      return imgs.filter(function(i){ return i && i.complete && i.naturalWidth>0; }).length;
    })()`);
    if (n >= 6) break;
    await sleep(250);
  }
  const lobby = await evalJS(`(function(){
    var grid = document.querySelector('.battlefield .map-grid');
    if (!grid) return { err: 'no battlefield grid' };
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.map-card'));
    var imgs = cards.map(function(c){ return c.querySelector('.mc-thumb img'); });
    return {
      cards: cards.length,
      imgs: imgs.length,
      loaded: imgs.filter(function(i){ return i && i.complete && i.naturalWidth > 0; }).length,
      names: cards.map(function(c){ var n=c.querySelector('.mc-name'); return n?(n.innerText||'').trim():''; }),
      checked: grid.querySelectorAll('.mc-check').length,
      gridCols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()`);
  console.log('  单人战场：' + JSON.stringify(lobby));
  ok('大厅单人战场 6 张地图卡', lobby && lobby.cards === 6, lobby && lobby.cards);
  ok('★6 张缩略图全部真实加载（不是碎图）', lobby && lobby.loaded === 6, lobby && lobby.loaded);
  ok('六张图名字齐全', lobby && lobby.names && lobby.names.join(',') === '乱葬岗,轮回廊,祭天台,血月祭坛,镇妖塔,毒泽孤屿', lobby && JSON.stringify(lobby.names));
  ok('当前图有「已选」角标（且有且仅有一个）', lobby && lobby.checked === 1, lobby && lobby.checked);
  ok('桌面宽屏无横向滚动', lobby && lobby.overflowX <= 1, lobby && lobby.overflowX);

  // 点第二张图，选中态要跟着走
  const pick = await evalJS(`(function(){
    var cards = document.querySelectorAll('.battlefield .map-card');
    if (!cards[1]) return 'no card';
    cards[1].click();
    return cards[1].querySelector('.mc-name').innerText.trim();
  })()`);
  await sleep(300);
  const afterPick = await evalJS(`(function(){
    var cards = Array.prototype.slice.call(document.querySelectorAll('.battlefield .map-card'));
    var on = cards.map(function(c,i){ return c.className.indexOf('on')>=0 ? i : -1; }).filter(function(i){return i>=0;});
    return { on: on, check: document.querySelectorAll('.battlefield .mc-check').length };
  })()`);
  ok('点第二张图后选中态唯一且跟随（点的是「' + pick + '」）',
    afterPick && afterPick.on.length === 1 && afterPick.on[0] === 1 && afterPick.check === 1,
    JSON.stringify(afterPick));

  // ---------- ③ 剧情关卡缩略图（走真实入口按钮，不是调试句柄） ----------
  await evalJS('(function(){ var b=document.querySelector(".btn-story"); if(b) b.click(); return !!b; })()');
  for (let i = 0; i < 20; i++) {
    const shown = await evalJS('!!document.querySelector(".story-card")');
    if (shown) break;
    await sleep(250);
  }
  const story = await evalJS(`(function(){
    var cards = Array.prototype.slice.call(document.querySelectorAll('.story-card'));
    if (!cards.length) return { err: 'no story cards' };
    var thumbs = cards.map(function(c){ return c.querySelector('.sc-thumb img'); });
    var loaded = thumbs.filter(function(i){ return i && i.complete && i.naturalWidth>0; }).length;
    var bleed = [];
    cards.forEach(function(c,ni){
      var cr = c.getBoundingClientRect();
      var t = c.querySelector('.sc-thumb');
      if (!t) return;
      var tr = t.getBoundingClientRect();
      if (tr.bottom - cr.bottom > 1) bleed.push('卡'+ni+' 缩略图越出 '+(tr.bottom-cr.bottom)+'px');
      if (t.scrollHeight - t.clientHeight > 1) bleed.push('卡'+ni+' 缩略图自身溢出');
    });
    return { cards: cards.length, thumbs: thumbs.length, loaded: loaded, bleed: bleed };
  })()`);
  console.log('  剧情关卡：' + JSON.stringify(story));
  ok('剧情每关都带缩略图', story && story.cards === story.thumbs && story.thumbs >= 6, JSON.stringify(story));
  ok('★剧情缩略图全部真实加载', story && story.thumbs > 0 && story.loaded === story.thumbs, story && story.loaded + '/' + story.thumbs);
  ok('剧情缩略图不越出卡片边界', story && story.bleed && story.bleed.length === 0, story && JSON.stringify(story.bleed));
  await evalJS('(function(){ var b=document.querySelector(".story-box .panel-actions .btn"); if(b) b.click(); return true; })()');
  await sleep(300);

  // ---------- ④ 候场室对局地图 ----------
  await evalJS('window.VS_LOBBY.createRoom(); true');
  await sleep(1400);
  const room = await evalJS(`(function(){
    var grid = document.querySelector('.map-grid');
    if (!grid) return { err: 'no room map grid' };
    var cards = Array.prototype.slice.call(grid.querySelectorAll('.map-card'));
    var imgs = cards.map(function(c){ return c.querySelector('.mc-thumb img'); });
    return {
      cards: cards.length,
      loaded: imgs.filter(function(i){ return i && i.complete && i.naturalWidth>0; }).length,
      checked: grid.querySelectorAll('.mc-check').length,
      disabled: cards.filter(function(c){ return c.disabled; }).length,
      activeCards: cards.filter(function(c){ return c.className.indexOf('on')>=0; }).length
    };
  })()`);
  console.log('  候场室：' + JSON.stringify(room));
  ok('候场室对局地图 6 张卡', room && room.cards === 6, room && room.cards);
  ok('★候场室缩略图全部真实加载', room && room.loaded === 6, room && room.loaded);
  ok('候场室房主可点（没有整排禁用）', room && room.disabled === 0, room && room.disabled);
  ok('候场室当前图有且仅有一个「已选」', room && room.checked === 1 && room.activeCards === 1, JSON.stringify(room));

  // ---------- ⑤ 390px 窄屏 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  const narrow = await evalJS(`(function(){
    var grid = document.querySelector('.map-grid');
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
      cardW: (function(){ var c=grid&&grid.querySelector('.map-card'); return c?Math.round(c.getBoundingClientRect().width):0; })()
    };
  })()`);
  console.log('  窄屏 390：' + JSON.stringify(narrow));
  ok('390px 窄屏无横向滚动条', narrow && narrow.overflowX <= 1, narrow && narrow.overflowX);
  ok('390px 窄屏地图卡折行但仍够宽（>=120px 触摸目标）', narrow && narrow.cardW >= 120, narrow && narrow.cardW);

  // 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const shotPath = TMP + '/vs_mapui_narrow.png';
  require('node:fs').writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  console.log('  窄屏截图：' + shotPath);

  console.log('\n=== ' + pass + ' PASS / ' + fail + ' FAIL ===');
  ws.close(); child.kill();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error('!! ' + (e && e.stack || e)); process.exit(1); });
