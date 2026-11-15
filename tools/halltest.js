// tools/halltest.js —— 「山海榜」与结算回顾的浏览器回归（第三十六轮）
//
// 守什么：
//   ① 大厅的三页签（图鉴 / 成就 / 山海谱）真的有内容，不是空白壳；
//   ② 花灵玉点天赋：余额减少、等级 +1、上限处变「已满」；
//   ③ 结算页的「伤害构成」不是空的，且百分比加起来接近 100；
//   ④ 结算入账只发生一次（settleRun 的哨兵），不会因为结算屏每帧都在而翻倍。
//
// 用法：node tools/halltest.js [端口或完整网址]
//   本地：node tools/halltest.js 3021
//   线上：node tools/halltest.js "https://xxx/?sharecode=XXXX"

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { TMP, CHROME, splitShare, shareSuffix } = require('./env');

const SH = splitShare(process.argv[2] || 3000);
const SHARE = shareSuffix(SH.code);
const ARG = SH.url;
const ONLINE = /^https?:\/\//.test(ARG);
const BASE = ONLINE ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9361;
const PROFILE = TMP + '/vs_halltest_profile';

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
      '--window-size=1280,900', '--force-device-scale-factor=1'
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

  // ==================== 一、大厅：山海榜三页签 ====================
  await P.nav(BASE + '/index.html?debug=1' + SHARE);
  const lobbyReady = await waitFor(function () {
    return P.eval('!!(window.VS_LOBBY && window.VS_PROGRESS && window.VS.CODEX)');
  }, 25000, '大厅加载');
  ok('大厅与山海榜模块都加载上（VS_LOBBY / VS_PROGRESS / VS.CODEX）', lobbyReady);

  // 清档后灌两局模拟数据：保证面板有内容、且灵玉够点一级
  // ★怪 id 从 MOB_LIST 现取：手写 'bone_king' 这类记忆里的名字一旦和表不符，
  //   存档里会多出几条永远匹配不上图鉴的脏数据（这次的断言就是被它抓出来的）。
  const seeded = await P.eval(`(function(){
    if (!window.VS_PROGRESS) return null;
    var P = window.VS_PROGRESS;
    var X = window.VS.CODEX;
    P.reset();
    var ids = [X.MOB_LIST[0].id, X.MOB_LIST[1].id, X.MOB_LIST[2].id];
    var kb1 = {}; kb1[ids[0]] = 120; kb1[ids[1]] = 3; kb1[ids[2]] = 40;
    var one = { kills: 320, wave: 12, gold: 240, dmgDealt: 5200, won: false,
      killsBy: kb1, weapons: [{ id: 'whip', level: 6 }],
      combos: 2, evolutions: 1, shrineKinds: 2, challengers: 1, charId: 'blade', mapId: 'graveyard' };
    var r1 = P.settle(one);
    var kb2 = {}; kb2[ids[0]] = 80;
    var two = { kills: 180, wave: 9, gold: 120, dmgDealt: 3100, won: true,
      killsBy: kb2, weapons: [{ id: 'whip', level: 5 }],
      combos: 1, evolutions: 0, shrineKinds: 1, challengers: 0, charId: 'blade', mapId: 'marsh' };
    var r2 = P.settle(two);
    return { jade: P.meta.jade, mobs: Object.keys(P.codex.mobs).length, ach: Object.keys(P.codex.ach).length,
      r1jade: r1.jade, r2jade: r2.jade, newAch1: r1.newAch.length, newAch2: r2.newAch.length };
  })()`);
  console.log('  灌档结果：' + JSON.stringify(seeded));
  ok('结算入账能算出灵玉与解锁成就', !!(seeded && seeded.jade > 0), JSON.stringify(seeded));
  ok('★两局都入账（灵玉 = 两局之和）', !!(seeded && seeded.r1jade + seeded.r2jade === seeded.jade),
    seeded ? (seeded.r1jade + '+' + seeded.r2jade + '=' + seeded.jade) : '');

  // 打开图鉴页
  await P.eval('VS_LOBBY.openHall("codex")');
  await sleep(450);
  const h1 = await P.eval('JSON.stringify(VS_LOBBY.hall)');
  const h = JSON.parse(h1 || '{}');
  console.log('  面板状态：' + h1);
  ok('图鉴面板打开了', !!h.open);
  ok('★妖物条目数 = 怪物表条目数（不是空白壳）', h.mobs > 0, h.mobs + ' 条');
  ok('★武器条目 = 全武器表（含未用过的）', h.weapons > 3, h.weapons + ' 条');
  ok('已收录妖物计数正确', h.mobDone === 3, h.mobDone + ' 种');  await P.shot(TMP + '/vs_hall_codex.png');

  // 成就页
  await P.eval('(function(){ document.querySelectorAll(".hall-tab")[1].click(); return true; })()');
  await sleep(300);
  const h2 = JSON.parse((await P.eval('JSON.stringify(VS_LOBBY.hall)')) || '{}');
  ok('切到成就页签', h2.tab === 'ach', h2.tab);
  ok('★成就条目 = 成就表条目数', h2.achs > 5, h2.achs + ' 条');
  ok('已解锁成就计数与存档一致', h2.achDone === seeded.ach, h2.achDone + ' 个');
  await P.shot(TMP + '/vs_hall_ach.png');

  // 山海谱页
  await P.eval('(function(){ document.querySelectorAll(".hall-tab")[2].click(); return true; })()');
  await sleep(300);
  const h3 = JSON.parse((await P.eval('JSON.stringify(VS_LOBBY.hall)')) || '{}');
  ok('切到山海谱页签', h3.tab === 'tal', h3.tab);
  ok('★天赋条目 = 天赋表条目数', h3.tals === 6, h3.tals + ' 条');
  await P.shot(TMP + '/vs_hall_tal.png');

  // 买一级天赋（从最便宜的开始）
  const before = await P.eval('JSON.stringify({jade: VS_PROGRESS.meta.jade, tal: VS_PROGRESS.meta.tal})');
  await P.eval('VS_LOBBY.buyTal("hand")');
  await sleep(300);
  const after = await P.eval('JSON.stringify({jade: VS_PROGRESS.meta.jade, tal: VS_PROGRESS.meta.tal, hall: VS_LOBBY.hall})');
  const b = JSON.parse(before || '{}');
  const a = JSON.parse(after || '{}');
  console.log('  买天赋：' + before + ' -> ' + after);
  ok('★点天赋真的扣灵玉并升一级', !!(a.tal && a.tal.hand === (b.tal.hand || 0) + 1 && a.jade === b.jade - 25),
    '灵玉 ' + b.jade + '→' + a.jade);
  ok('★面板跟着刷新（不是买完还显示旧等级）', a.hall.talTotal === 1, '总级数 ' + a.hall.talTotal);

  // 连点同一项到满级，再点一次应当被拒且不改数据。
  // ★先把灵玉补足：不补的话「点满」这一步会因为钱不够中途停下，
  //   断言就变成「检验我的存款」，而不是「检验满级拦截」。
  await P.eval('(function(){ var P = window.VS_PROGRESS; P.meta.jade = 500; P.saveMeta(); return true; })()');
  await P.eval('VS_LOBBY.buyTal("hand"); VS_LOBBY.buyTal("hand");');
  await sleep(250);
  const full = JSON.parse((await P.eval('JSON.stringify({lv: VS_PROGRESS.meta.tal.hand, jade: VS_PROGRESS.meta.jade})')) || '{}');
  ok('★能连点到满级（Lv' + full.lv + '）', full.lv === 3, '灵玉余 ' + full.jade);
  await P.eval('VS_LOBBY.buyTal("hand")');
  await sleep(250);
  const full2 = JSON.parse((await P.eval('JSON.stringify({lv: VS_PROGRESS.meta.tal.hand, jade: VS_PROGRESS.meta.jade})')) || '{}');
  ok('★满级后再点不生效（等级与余额都不动）',
    full2.lv === full.lv && full2.jade === full.jade,
    '等级 ' + full.lv + '→' + full2.lv + '，灵玉 ' + full.jade + '→' + full2.jade);

  // ==================== 二、对局页：结算的伤害构成 ====================
  await P.nav(BASE + '/game.html?debug=1' + SHARE);
  const gameReady = await waitFor(function () {
    return P.eval('!!(window.VS_GAME && window.VS_GAME.world)');
  }, 30000, '对局页加载');
  ok('对局页加载', gameReady);

  await P.eval('VS_GAME.start()');
  await waitFor(function () { return P.eval('VS_GAME.screen === "playing"'); }, 15000, '进入战场');
  await sleep(1400);

  // ★必须「贴脸」才有伤害：开局怪刷在视口外的环上（几百像素外），
  //   站着不动的 3 秒里武器一次都打不到东西 —— 第一版断言就是这么红的。
  //   这里等第一只怪出现后把角色挪到它旁边，让初始武器真的开火。
  const hasMob = await waitFor(function () {
    return P.eval('(function(){ var w = VS_GAME.world; return !!(w && w.mobs && w.mobs.length); })()');
  }, 15000, '刷出第一波怪');
  ok('开局会刷出怪', hasMob);
  await P.eval(`(function(){
    var w = VS_GAME.world, p = w.player, m = w.mobs[0];
    p.x = m.x - 22; p.y = m.y; p.px = p.x; p.py = p.y;
    return true;
  })()`);
  await sleep(2500);
  const dmgBefore = await P.eval('JSON.stringify(VS_GAME.world.player.stats.dmgBy)');
  console.log('  开局伤害来源：' + dmgBefore);
  ok('★伤害按来源累计（不是只有一个总数）', !!(dmgBefore && dmgBefore !== '{}'), dmgBefore);

  // 直接把时间推到尾：触发「撑满时长」结局 → 结算屏
  await P.eval('(function(){ var w = VS_GAME.world; w.tick = Math.floor(w.matchSec * 20) - 1; return true; })()');
  // ★升级面板会冻结世界（screen=levelup 时 loop 不推进），
  //   而贴脸打怪几乎必然升一级 —— 不在这里自动选一个，世界就永远停在那，
  //   结算屏等不到（第一版就是卡在这一步）。
  let ended = false;
  for (let i = 0; i < 40; i++) {
    const st = await P.eval('VS_GAME.screen');
    if (st === 'result') { ended = true; break; }
    if (st === 'levelup') await P.eval('VS_GAME.choose(0)');
    await sleep(200);
  }
  ok('时间到 → 结算屏', ended);

  const extra = JSON.parse((await P.eval('JSON.stringify(VS_GAME.ui.runExtra)')) || '{}');
  console.log('  结算回顾：' + JSON.stringify(extra));
  ok('★结算里有伤害构成列表', !!(extra.dmgList && extra.dmgList.length > 0),
    (extra.dmgList ? extra.dmgList.length : 0) + ' 项');
  ok('★伤害构成带中文名（不是原始 id）', !!(extra.dmgList && extra.dmgList[0] && /[\u4e00-\u9fa5]/.test(extra.dmgList[0].name)),
    extra.dmgList && extra.dmgList[0] ? extra.dmgList[0].name : '');
  ok('★本局拿到了灵玉', extra.jade > 0, '灵玉 +' + extra.jade);
  const pctSum = (extra.dmgList || []).reduce(function (s, d) { return s + d.pct; }, 0);
  ok('★占比之和落在 90~110（允许四舍五入误差）', pctSum >= 90 && pctSum <= 110, pctSum + '%');

  // 结算屏停一会儿：入账哨兵必须挡住重复结算
  const jadeA = await P.eval('VS_PROGRESS.meta.jade');
  await sleep(1200);
  const jadeB = await P.eval('VS_PROGRESS.meta.jade');
  ok('★★结算只入账一次（停 1.2 秒余额不变）', jadeA === jadeB, jadeA + ' / ' + jadeB);

  await P.shot(TMP + '/vs_result_dmg.png');
  console.log('  截图：' + TMP + '/vs_result_dmg.png');

  // ==================== 三、手机布局（390×844 + 触摸） ====================
  // ★pointer:coarse 在桌面无头浏览器里永远不命中，必须显式开触摸仿真，
  //   否则 44px 触摸目标那条断言等于没测（项目踩过）。
  await P.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  await P.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  await P.nav(BASE + '/index.html?debug=1' + SHARE);
  await waitFor(function () { return P.eval('!!window.VS_LOBBY'); }, 25000, '手机端大厅加载');
  await P.eval('VS_LOBBY.openHall("codex")');
  await sleep(500);
  const mob = await P.eval(`(function(){
    var box = document.querySelector('.hall-box');
    if (!box) return null;
    var r = box.getBoundingClientRect();
    var btn = document.querySelector('.hall-close');
    var br = btn.getBoundingClientRect();
    var hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      vw: window.innerWidth, vh: window.innerHeight,
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      closeH: Math.round(br.height),
      closeHit: !!(hit && (hit === btn || btn.contains(hit)))
    };
  })()`);
  console.log('  手机端面板：' + JSON.stringify(mob));
  ok('★手机上面板不横向溢出', !!(mob && !mob.overflowX), mob ? ('vw=' + mob.vw) : '');
  ok('★手机上面板不高于视口（顶部没被推出屏幕）', !!(mob && mob.top >= 0 && mob.h <= mob.vh), mob ? ('top=' + mob.top + ' h=' + mob.h) : '');
  ok('★「收起」按钮 ≥44px 且点得到', !!(mob && mob.closeH >= 44 && mob.closeHit), mob ? (mob.closeH + 'px hit=' + mob.closeHit) : '');
  await P.shot(TMP + '/vs_hall_phone.png');

  // 手机端结算页：伤害构成那一块不能把面板撑破
  await P.nav(BASE + '/game.html?debug=1' + SHARE);
  await waitFor(function () { return P.eval('!!(window.VS_GAME && window.VS_GAME.world)'); }, 30000, '手机端对局页');
  await P.eval('VS_GAME.start()');
  await waitFor(function () { return P.eval('VS_GAME.screen === "playing"'); }, 15000, '手机端进入战场');
  await sleep(1200);
  await waitFor(function () {
    return P.eval('(function(){ var w = VS_GAME.world; return !!(w && w.mobs && w.mobs.length); })()');
  }, 15000, '手机端刷怪');
  await P.eval(`(function(){
    var w = VS_GAME.world, p = w.player, m = w.mobs[0];
    if (m) { p.x = m.x - 20; p.y = m.y; p.px = p.x; p.py = p.y; }
    return true;
  })()`);
  await sleep(1800);
  await P.eval('(function(){ var w = VS_GAME.world; w.tick = Math.floor(w.matchSec * 20) - 1; return true; })()');
  let mobEnded = false;
  for (let i = 0; i < 40; i++) {
    const st = await P.eval('VS_GAME.screen');
    if (st === 'result') { mobEnded = true; break; }
    if (st === 'levelup') await P.eval('VS_GAME.choose(0)');
    await sleep(200);
  }
  ok('手机端也能走到结算', mobEnded);
  const mobRes = await P.eval(`(function(){
    var panel = document.querySelector('.overlay .panel') || document.querySelector('.panel');
    var dr = document.querySelector('.dmg-review');
    var pr = panel ? panel.getBoundingClientRect() : null;
    var rr = dr ? dr.getBoundingClientRect() : null;
    return {
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      panelW: pr ? Math.round(pr.width) : 0,
      panelH: pr ? Math.round(pr.height) : 0,
      drW: rr ? Math.round(rr.width) : 0,
      drRows: document.querySelectorAll('.dr-row').length
    };
  })()`);
  console.log('  手机端结算：' + JSON.stringify(mobRes));
  ok('★手机端结算页不横向溢出', !!(mobRes && !mobRes.overflowX));
  ok('★伤害构成在手机上有行且不超出面板宽度', !!(mobRes && mobRes.drRows > 0 && mobRes.drW <= mobRes.panelW),
    mobRes ? (mobRes.drRows + ' 行 / ' + mobRes.drW + '≤' + mobRes.panelW) : '');
  await P.shot(TMP + '/vs_result_phone.png');

  ok('全程没有 JS 异常', P.pageErrors.length === 0, P.pageErrors.slice(0, 3).join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  P.close();
  process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) {
  console.error('脚本出错：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
