// tools/codextest.js —— 妖物图鉴「点开看立绘 + 属性」与山海谱高等级回归
//
// 守什么（用户报障：技能全满后灵玉没去处；怪物图鉴只能看名字）：
//   ① 六项天赋上限从 3 提到 8，价目数量配套，Lv8 加成按 8 级算
//   ② 图鉴 21 行都带真实立绘（naturalWidth > 0，不是碎图）
//   ③ 点某一行弹出详情：大图 + 四项属性 + 特性 + 击杀数都对
//   ④ 关闭按钮 / 点遮罩空白处都能关掉；打开另一只会切换内容
//   ⑤ 390px 窄屏无横向滚动，触摸目标 ≥44px
//
// 用法：node tools/codextest.js [端口或域名] [宽] [高]

const { spawn } = require('node:child_process');
const { TMP, CHROME, splitShare, shareSuffix } = require('./env');
const CDP_PORT = 9386;
const PROFILE = TMP + '/vs_codex_profile';

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
  console.log('=== 妖物图鉴详情 + 天赋上限回归（' + BASE + ' ' + VW + 'x' + VH + '）===');
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

  await evalJS('window.VS_LOBBY.enterAsGuest("图鉴测试"); true');
  for (let i = 0; i < 40; i++) {
    const shown = await evalJS('!!document.querySelector(".battlefield")');
    if (shown) break;
    await sleep(300);
  }

  // ---------- ① 天赋上限 ----------
  const tal = await evalJS(`(function(){
    var X = window.VS.CODEX; if (!X) return {err:'no codex'};
    var t = X.TALENTS;
    return {
      count: t.length,
      maxes: t.map(function(d){ return d.max; }),
      costsOk: t.every(function(d){ return d.costs && d.costs.length === d.max; }),
      rising: t.every(function(d){ for(var i=1;i<d.costs.length;i++) if(d.costs[i]<=d.costs[i-1]) return false; return true; }),
      bonus8: X.talBonus({hand:8}).pickupMul,
      bonus3: X.talBonus({hand:3}).pickupMul,
      spent8: X.talSpent({hand:8})
    };
  })()`);
  console.log('  天赋：' + JSON.stringify(tal));
  ok('六项天赋上限全部提到 8', tal && tal.count === 6 && tal.maxes.every(m => m === 8), tal && JSON.stringify(tal.maxes));
  ok('★每项价目条数与上限一致（不半路假满级）', tal && tal.costsOk, tal && tal.costsOk);
  ok('★价格逐级递增', tal && tal.rising, tal && tal.rising);
  ok('★Lv8 加成按 8 级算（1.2 = 8×15%）', tal && Math.abs(tal.bonus8 - 1.2) < 1e-9, tal && tal.bonus8);
  ok('Lv3 加成仍是 0.45（没被高等级挤掉）', tal && Math.abs(tal.bonus3 - 0.45) < 1e-9, tal && tal.bonus3);

  // ---------- ② 打开图鉴，等立绘全部加载 ----------
  await evalJS('window.VS_LOBBY.openHall("codex"); true');
  for (let i = 0; i < 20; i++) {
    const n = await evalJS(`(function(){
      var imgs=Array.prototype.slice.call(document.querySelectorAll('.mob-list .mob-mini'));
      return imgs.filter(function(i){return i&&i.complete&&i.naturalWidth>0;}).length;
    })()`);
    if (n >= 21) break;
    await sleep(250);
  }
  const list = await evalJS(`(function(){
    var rows=Array.prototype.slice.call(document.querySelectorAll('.mob-list .mob-row'));
    var imgs=rows.map(function(r){return r.querySelector('.mob-mini');});
    return {
      rows: rows.length,
      loaded: imgs.filter(function(i){return i&&i.complete&&i.naturalWidth>0;}).length,
      minH: rows.length ? Math.min.apply(null, rows.map(function(r){return r.getBoundingClientRect().height;})) : 0,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()`);
  console.log('  图鉴列表：' + JSON.stringify(list));
  ok('★21 行妖物全部列出', list && list.rows === 21, list && list.rows);
  ok('★21 张立绘全部真实加载（不是碎图）', list && list.loaded === 21, list && list.loaded);
  ok('每行触摸目标 ≥44px', list && list.minH >= 44, list && list.minH);
  ok('桌面无横向滚动', list && list.overflowX <= 1, list && list.overflowX);

  // ---------- ③ 点第一行（僵尸）开详情 ----------
  await evalJS(`(function(){ var r=document.querySelector('.mob-list .mob-row'); if(!r) return false; r.click(); return true; })()`);
  await sleep(400);
  const detail = await evalJS(`(function(){
    var card=document.querySelector('.mob-card'); if(!card) return {err:'no card'};
    var img=card.querySelector('.mob-portrait img');
    var stats=Array.prototype.slice.call(card.querySelectorAll('.mob-stat')).map(function(s){
      return {k:s.querySelector('span').innerText, v:s.querySelector('b').innerText};
    });
    return {
      d: window.VS_LOBBY.mobDetail,
      name: card.querySelector('.mob-name').innerText,
      imgLoaded: !!(img && img.complete && img.naturalWidth>0),
      stats: stats,
      trait: card.querySelector('.mob-trait-tx').innerText,
      closeH: card.querySelector('.mob-x').getBoundingClientRect().height
    };
  })()`);
  console.log('  详情（僵尸）：' + JSON.stringify(detail));
  ok('点行弹出详情浮层', detail && !detail.err, detail && detail.err);
  ok('★详情大图真实加载', detail && detail.imgLoaded, detail && detail.imgLoaded);
  ok('详情名字正确', detail && detail.name === '僵尸', detail && detail.name);
  ok('★四项属性齐全（生命12/移速42/伤害5/体型11）', detail && JSON.stringify(detail.stats) === JSON.stringify([
    {k:'生命',v:'12'},{k:'移速',v:'42'},{k:'伤害',v:'5'},{k:'体型',v:'11'}
  ]), detail && JSON.stringify(detail.stats));
  ok('特性文案非空', detail && detail.trait && detail.trait.length > 0, detail && detail.trait);
  ok('关闭按钮 ≥44px', detail && detail.closeH >= 44, detail && detail.closeH);
  ok('调试句柄读到同一条详情', detail && detail.d && detail.d.id === 'corpse', detail && JSON.stringify(detail.d));

  // ---------- ④ 关闭 / 切换 ----------
  await evalJS('window.VS_LOBBY.closeMob(); true');
  await sleep(250);
  ok('★关闭按钮把浮层收掉', await evalJS('!document.querySelector(".mob-card")'));

  // 点另一只怪（妖王·罗睺），看属性是否切换成大数字
  await evalJS(`(function(){
    var rows=Array.prototype.slice.call(document.querySelectorAll('.mob-list .mob-row'));
    for(var i=0;i<rows.length;i++) if(rows[i].innerText.indexOf('罗睺')>=0){ rows[i].click(); return true; }
    return false;
  })()`);
  await sleep(400);
  const boss = await evalJS(`(function(){
    var d=window.VS_LOBBY.mobDetail;
    return d ? {id:d.id, hp:d.hp, dmg:d.dmg, tier:d.tierFull, trait:d.trait} : null;
  })()`);
  console.log('  详情（罗睺）：' + JSON.stringify(boss));
  ok('★切换到另一只怪后属性跟着变', boss && boss.id === 'blood_lord' && boss.hp === 3200 && boss.dmg === 30, boss && JSON.stringify(boss));
  ok('Boss 档位与光环特性都在', boss && boss.tier === '妖王' && boss.trait.indexOf('灼烧') >= 0, boss && JSON.stringify(boss));

  // 点遮罩空白处关闭（不能用 @click.self，走手写 target 比对）
  await evalJS(`(function(){
    var mask=document.querySelector('.mob-mask'); if(!mask) return false;
    mask.click(); return true;
  })()`);
  await sleep(250);
  ok('★点遮罩空白处也能关闭', await evalJS('!document.querySelector(".mob-card")'));

  // ---------- ⑤ 390px 窄屏 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await evalJS('window.VS_LOBBY.openHall("codex"); true');
  await sleep(500);
  await evalJS(`(function(){ var r=document.querySelector('.mob-list .mob-row'); if(r) r.click(); return true; })()`);
  await sleep(300);
  const narrow = await evalJS(`(function(){
    var card=document.querySelector('.mob-card');
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      cardW: card ? Math.round(card.getBoundingClientRect().width) : 0,
      portW: window.innerWidth,
      statsCols: card ? getComputedStyle(card.querySelector('.mob-stats')).gridTemplateColumns.split(' ').length : 0
    };
  })()`);
  console.log('  窄屏：' + JSON.stringify(narrow));
  ok('390px 窄屏无横向滚动', narrow && narrow.overflowX <= 1, narrow && narrow.overflowX);
  ok('详情卡不超出视口', narrow && narrow.cardW <= narrow.portW, narrow && JSON.stringify(narrow));
  ok('四项属性在窄屏仍是四列', narrow && narrow.statsCols === 4, narrow && narrow.statsCols);

  await send('Page.captureScreenshot', { format: 'png' }).then(s => {
    require('node:fs').writeFileSync(TMP + '/vs_codex_narrow.png', Buffer.from(s.data, 'base64'));
  });
  await evalJS('window.VS_LOBBY.closeMob(); window.VS_LOBBY.closeHall(); true');
  await sleep(200);
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });
  await evalJS('window.VS_LOBBY.openHall("codex"); true');
  await sleep(400);
  await evalJS(`(function(){ var r=document.querySelector('.mob-list .mob-row'); if(r) r.click(); return true; })()`);
  await sleep(300);
  await send('Page.captureScreenshot', { format: 'png' }).then(s => {
    require('node:fs').writeFileSync(TMP + '/vs_codex_detail.png', Buffer.from(s.data, 'base64'));
  });

  console.log('\n结果：' + pass + ' PASS / ' + fail + ' FAIL');
  console.log('截图：' + TMP + '/vs_codex_detail.png, ' + TMP + '/vs_codex_narrow.png');
  ws.close(); child.kill();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.error(e); process.exit(1); });
