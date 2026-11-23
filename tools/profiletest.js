// tools/profiletest.js —— 「我的档案 / 局志」的浏览器回归（第三十七轮）
//
// 守什么（这是用户报障的直接来源：单人打完回来看档案还是 0 局）：
//   ① 单人局、剧情局、联机局都要进档案（对局数、击杀、时长都涨）；
//   ② 局志列表要按「最新在前」列出，条数与存档一致；
//   ③ 点一行能打开「局志」明细，里面六项主数字与伤害构成对得上；
//   ④ 手机 390×844 上卡片不横向溢出，档案与局志浮层都能看全。
//
// 用法：node tools/profiletest.js [端口或完整网址]

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { TMP, CHROME, splitShare, shareSuffix } = require('./env');

const SH = splitShare(process.argv[2] || 3000);
const SHARE = shareSuffix(SH.code);
const ARG = SH.url;
const ONLINE = /^https?:\/\//.test(ARG);
const BASE = ONLINE ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9365;
const PROFILE = TMP + '/vs_profiletest_profile';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function proxyArgs() {
  if (!ONLINE) return ['--no-proxy-server'];
  const proxy = process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || '';
  return proxy ? ['--proxy-server=' + proxy] : [];
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1400,1000', '--force-device-scale-factor=1'
    ].concat(proxyArgs()).concat(['about:blank']), { stdio: 'ignore' });
    let tries = 0;
    const timer = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        clearInterval(timer); res.resume(); resolve();
      }).on('error', function () {
        if (tries > 40) { clearInterval(timer); reject(new Error('调试端口没起来')); }
      });
    }, 500);
  });
}

function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        let id = 0;
        const pending = {};
        const pageErrors = [];
        function send(method, params) {
          return new Promise(function (res, rej) {
            const mid = ++id;
            const to = setTimeout(function () { delete pending[mid]; rej(new Error('CDP 超时：' + method)); }, 20000);
            pending[mid] = function (r) { clearTimeout(to); res(r); };
            ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const m = JSON.parse(ev.data);
          if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; return; }
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails || {};
            pageErrors.push(d.text || 'exception');
          }
        });
        ws.addEventListener('open', function () {
          send('Runtime.enable');
          send('Page.enable');
          send('Network.enable').then(function () { return send('Network.setCacheDisabled', { cacheDisabled: true }); });
          send('Page.startScreencast', { format: 'jpeg', quality: 45, everyNthFrame: 1 });
          resolve({
            pageErrors: pageErrors,
            send: send,
            nav: function (u) { return send('Page.navigate', { url: u }); },
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
              if (r && r.exceptionDetails) {
                const ex = r.exceptionDetails.exception || {};
                pageErrors.push('eval：' + (ex.description ? String(ex.description).split('\n')[0] : ''));
                return null;
              }
              return r && r.result ? r.result.value : null;
            },
            shot: async function (p) {
              const r = await send('Page.captureScreenshot', { format: 'png' });
              if (r && r.data) fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
            },
            close: function () { ws.close(); }
          });
        });
        ws.addEventListener('error', function () { reject(new Error('CDP WS 出错')); });
      });
    });
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await sleep(150);
  }
  console.log('  等待超时：' + label);
  return false;
}

async function main() {
  let pass = 0;
  let fail = 0;
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  }

  await launchChrome();
  const P = await connect();

  await P.nav(BASE + '/index.html?debug=1' + SHARE);
  const ready = await waitFor(function () {
    return P.eval('!!(window.VS_LOBBY && window.VS_PROGRESS)');
  }, 25000, '大厅加载');
  ok('大厅与本机存档都加载上', ready);

  // ---- 灌三局：单人阵亡 / 剧情通关 / 联机 ----
  const seeded = await P.eval(`(function(){
    var P = window.VS_PROGRESS;
    P.reset();
    var r1 = P.settle({ kills: 214, wave: 11, level: 26, gold: 320, time: 372, dmgDealt: 9800, won: false,
      dmgList: [{ src: 'whip', dmg: 6400 }, { src: 'thorns', dmg: 3400 }],
      weapons: [{ id: 'whip', level: 7 }, { id: 'holy_water', level: 3 }],
      killsBy: {}, charId: 'blade', charName: '刑天', mapId: 'graveyard', mapName: '荒村墓园',
      diffName: '普通', challengers: 1, combos: 3, evolutions: 1, shrineKinds: 2, state: 'dead' });
    var r2 = P.settle({ kills: 96, wave: 6, level: 17, gold: 140, time: 240, dmgDealt: 4200, won: true,
      dmgList: [{ src: 'thunder', dmg: 4200 }], weapons: [{ id: 'thunder', level: 5 }],
      killsBy: {}, charId: 'blade', charName: '刑天', mapId: 'marsh', mapName: '毒泽',
      diffName: '噩梦', campaign: true, stageId: 'ch1', state: 'won' });
    P.settle({ kills: 58, wave: 7, level: 12, gold: 90, time: 190, dmgDealt: 2100, won: false,
      weapons: [{ id: 'whip', level: 4 }], killsBy: {}, charName: '祝融', mapName: '荒村墓园',
      diffName: '普通', state: 'dead' }, { online: true });
    // 进大厅（档案卡在 <section v-else> 里，不进大堂根本不在 DOM 上）
    window.VS_LOBBY.enterAsGuest('档案测试');
    window.VS_LOBBY.refreshCareer();
    // ★career 是 Vue 的响应式代理，直接 returnByValue 会序列化成 {} —— 必须自己 stringify
    return JSON.stringify({ career: window.VS_LOBBY.career, runs: window.VS_LOBBY.runCount, jadeExpect: r1.jade + r2.jade });
  })()`);
  const seededObj = seeded ? JSON.parse(seeded) : {};
  const c = seededObj.career || {};
  const sObj = seededObj;
  // 等大厅视图把档案卡渲染出来（进大堂是异步的：WebSocket 连上才算进去）
  const cardShown = await waitFor(function () { return P.eval('!!document.querySelector(".profile-card")'); }, 15000, '档案卡渲染');
  ok('进入大厅后档案卡出现在 DOM 上', cardShown);
  console.log('  生涯：' + JSON.stringify(c));
  ok('★三局都进了档案（单人 + 剧情 + 联机都算）', c.runs === 3, c.runs + ' 局');
  ok('★累计击杀 = 三局之和', c.kills === 214 + 96 + 58, c.kills + '');
  ok('★累计时长 = 三局之和', c.playSec === 372 + 240 + 190, c.playSec + ' 秒');
  ok('局志条数与对局数一致', sObj.runs === 3, sObj.runs + ' 条');
  ok('通关率按局数算（1/3 ≈ 33%）', c.winRate === 33, c.winRate + '%');
  ok('最高波次取单局最大值', c.bestWave === 11, c.bestWave + '');
  ok('★联机局不计灵玉（只有单人与剧情发）', c.jade > 0 && c.jade === sObj.jadeExpect,
    '灵玉 ' + c.jade + '，两局单机应为 ' + sObj.jadeExpect);

  // ---- 列表渲染 ----
  const dom = await P.eval(`(function(){
    var card = document.querySelector('.profile-card');
    if (!card) return null;
    return {
      rows: card.querySelectorAll('.pf-run').length,
      bars: card.querySelectorAll('.sp-bars i').length,
      firstMode: (card.querySelector('.pr-mode') || {}).textContent || '',
      firstMain: (card.querySelector('.pr-main') || {}).textContent || '',
      w: Math.round(card.getBoundingClientRect().width),
      h: Math.round(card.getBoundingClientRect().height),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  })()`);
  console.log('  卡片：' + JSON.stringify(dom));
  ok('★局志列表渲染出 3 行', !!(dom && dom.rows === 3), dom ? dom.rows + ' 行' : '');
  ok('★柱状图有 3 根（不足 12 局时按实际局数画）', !!(dom && dom.bars === 3), dom ? dom.bars + ' 根' : '');
  ok('列表首行是「最新那一局」（联机）', !!(dom && dom.firstMode.trim() === '联机'),
    dom ? dom.firstMode.trim() : '');
  ok('★整页没有横向溢出', !!(dom && !dom.overflowX));
  // 截图前把卡片滚到视口中间（整页图里它在下半屏，看不清细节）
  await P.eval('(function(){ var c = document.querySelector(".profile-card"); if (c) c.scrollIntoView({ block: "center" }); return true; })()');
  await sleep(400);
  await P.shot(TMP + '/vs_profile_desktop.png');

  // ---- 点开明细 ----
  await P.eval('(function(){ var b = document.querySelectorAll(".pf-run")[1]; if (b) b.click(); return true; })()');
  await sleep(400);
  const detail = await P.eval('JSON.stringify({open: VS_LOBBY.runOpen, d: VS_LOBBY.runDetail})');
  const d = JSON.parse(detail || '{}');
  ok('★点一行能打开局志明细', d.open === true);
  ok('明细里是点的那一局（剧情通关 / 毒泽 / 噩梦）',
    !!(d.d && d.d.resText === '通关' && d.d.map === '毒泽' && d.d.diff === '噩梦'),
    d.d ? (d.d.resText + ' / ' + d.d.map + ' / ' + d.d.diff) : '');
  ok('明细六项主数字齐全', !!(d.d && d.d.wave === 6 && d.d.level === 17 && d.d.kills === 96 &&
    d.d.gold === 140 && d.d.dmg === 4200), d.d ? JSON.stringify({ w: d.d.wave, l: d.d.level, k: d.d.kills, g: d.d.gold, dmg: d.d.dmg }) : '');
  ok('明细里有伤害构成（占比 100%）', !!(d.d && d.d.dmgRows.length === 1 && d.d.dmgRows[0].pct === 100),
    d.d && d.d.dmgRows ? JSON.stringify(d.d.dmgRows) : '');
  ok('明细里有武器与灵玉', !!(d.d && d.d.weapons.length === 1 && d.d.jade > 0),
    d.d ? ('武器 ' + d.d.weapons.length + ' / 灵玉 ' + d.d.jade) : '');
  await P.shot(TMP + '/vs_profile_run.png');

  // 收起
  await P.eval('VS_LOBBY.closeRun()');
  await sleep(250);
  ok('能收起明细', (await P.eval('VS_LOBBY.runOpen')) === false);

  // ---- 手机剖面 ----
  await P.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await P.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(600);
  const mob = await P.eval(`(function(){
    var card = document.querySelector('.profile-card');
    // ★390 宽下档案卡在首屏之外，不先滚过去 elementFromPoint 取到的是 null
    if (card) card.scrollIntoView({ block: 'center' });
    var r = card ? card.getBoundingClientRect() : null;
    var btn = document.querySelector('.pf-run');
    var br = btn ? btn.getBoundingClientRect() : null;
    var hit = br ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) : null;
    return {
      w: r ? Math.round(r.width) : 0,
      vw: window.innerWidth,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      rowH: br ? Math.round(br.height) : 0,
      rowHit: !!(hit && (hit === btn || btn.contains(hit)))
    };
  })()`);
  console.log('  手机：' + JSON.stringify(mob));
  ok('★手机上面板不横向溢出', !!(mob && !mob.overflowX), mob ? ('vw=' + mob.vw) : '');
  ok('★手机上局志行高 ≥44px 且点得到', !!(mob && mob.rowH >= 44 && mob.rowHit),
    mob ? (mob.rowH + 'px hit=' + mob.rowHit) : '');
  await P.shot(TMP + '/vs_profile_phone.png');

  // 手机上打开明细也不能溢出
  await P.eval('VS_LOBBY.openRun(0)');
  await sleep(400);
  const mob2 = await P.eval(`(function(){
    var box = document.querySelector('.runbox');
    var r = box ? box.getBoundingClientRect() : null;
    return {
      has: !!box,
      top: r ? Math.round(r.top) : 0,
      h: r ? Math.round(r.height) : 0,
      vh: window.innerHeight,
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1
    };
  })()`);
  console.log('  手机明细：' + JSON.stringify(mob2));
  ok('★手机上局志浮层不溢出、顶部没被推出屏幕',
    !!(mob2 && mob2.has && !mob2.overflowX && mob2.top >= 0 && mob2.h <= mob2.vh),
    mob2 ? ('top=' + mob2.top + ' h=' + mob2.h) : '');
  await P.shot(TMP + '/vs_profile_run_phone.png');

  // ---- 空档案：第一次打开的样子（不能是一块空白，也不能报错）----
  await P.eval('(function(){ window.VS_PROGRESS.reset(); window.VS_LOBBY.refreshCareer(); return true; })()');
  await sleep(350);
  const blank = await P.eval(`(function(){
    var card = document.querySelector('.profile-card');
    if (!card) return null;
    return JSON.stringify({
      runs: card.querySelectorAll('.pf-run').length,
      bars: card.querySelectorAll('.sp-bars i').length,
      hasEmpty: card.textContent.indexOf('还没有对局记录') >= 0,
      runEmpty: card.textContent.indexOf('这一台还没有局志') >= 0,
      num: (card.querySelector('.pf-num') || {}).textContent || ''
    });
  })()`);
  const bk = JSON.parse(blank || '{}');
  console.log('  空档案：' + blank);
  ok('★清档后档案回到 0 局，且给出「去打一局」的空状态', bk.runs === 0 && bk.hasEmpty && bk.runEmpty,
    '局数 ' + bk.num);

  // ---- 真打一局：对局页打到结算 → 回大厅 → 档案里多一局 ----
  // ★这一段是**用户报障的原场景**：前面几段都是直接调 settle() 灌数据，
  //   只有这一段证明「真的打完一局，档案会长数字」这条链是通的。
  await P.nav(BASE + '/game.html?debug=1' + SHARE);
  const gameReady = await waitFor(function () {
    return P.eval('!!(window.VS_GAME && window.VS_GAME.world && window.VS_PROGRESS)');
  }, 30000, '对局页加载');
  ok('对局页打开（本机存档也在）', gameReady);
  await P.eval('window.VS_PROGRESS.reset()');      // 从 0 开始，这一局必须变成 1
  await P.eval('VS_GAME.start()');
  await waitFor(function () { return P.eval('VS_GAME.screen === "playing"'); }, 15000, '进入战场');
  await sleep(1200);
  // 贴脸打两秒（有怪才有击杀/伤害数字），再把时间推到尾触发结算
  await waitFor(function () {
    return P.eval('(function(){ var w = VS_GAME.world; return !!(w && w.mobs && w.mobs.length); })()');
  }, 15000, '刷出怪');
  await P.eval(`(function(){
    var w = VS_GAME.world, p = w.player, m = w.mobs[0];
    if (m) { p.x = m.x - 20; p.y = m.y; p.px = p.x; p.py = p.y; }
    return true;
  })()`);
  await sleep(1800);
  await P.eval('(function(){ var w = VS_GAME.world; w.tick = Math.floor(w.matchSec * 20) - 1; return true; })()');
  let reached = false;
  for (let i = 0; i < 40; i++) {
    const st = await P.eval('VS_GAME.screen');
    if (st === 'result') { reached = true; break; }
    if (st === 'levelup') await P.eval('VS_GAME.choose(0)');
    await sleep(200);
  }
  ok('这一局走到了结算屏', reached);

  const afterRun = await P.eval('JSON.stringify(window.VS_PROGRESS.career())');
  const ar = JSON.parse(afterRun || '{}');
  console.log('  打完一局后本机存档：' + afterRun);
  ok('★真打完一局后存档里记了 1 局（有波次/时长）', ar.runs === 1 && ar.playSec > 0,
    '局数 ' + ar.runs + ' / 时长 ' + ar.playSec + ' 秒');

  // 回大厅看档案卡上的数字
  await P.nav(BASE + '/index.html?debug=1' + SHARE);
  await waitFor(function () { return P.eval('!!(window.VS_LOBBY && window.VS_PROGRESS)'); }, 25000, '回大厅');
  await P.eval('window.VS_LOBBY.enterAsGuest("回归测试")');
  await waitFor(function () { return P.eval('!!document.querySelector(".profile-card")'); }, 15000, '档案卡渲染');
  await sleep(400);
  const shown = await P.eval(`(function(){
    var card = document.querySelector('.profile-card');
    if (!card) return null;
    return JSON.stringify({
      num: (card.querySelector('.pf-num') || {}).textContent || '',
      rows: card.querySelectorAll('.pf-run').length,
      src: (card.querySelector('.pf-src') || {}).textContent || ''
    });
  })()`);
  const sh = JSON.parse(shown || '{}');
  console.log('  大厅档案卡：' + shown);
  ok('★★大厅档案卡上的「总对局」就是刚才那一局（1）', String(sh.num).trim() === '1',
    '显示 ' + sh.num + ' · 局志 ' + sh.rows + ' 行');

  ok('全程没有 JS 异常', P.pageErrors.length === 0, P.pageErrors.slice(0, 3).join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  P.close();
  process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) {
  console.error('脚本出错：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
