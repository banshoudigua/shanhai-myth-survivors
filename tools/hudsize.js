// tools/hudsize.js —— 顶栏「击杀 / 金币 / 暂停」那一块的占地量测与回归
//
// 【为什么要单独一个脚本】用户报「击杀和金币显示区太占用空间」。
//   这类问题**肉眼看不出「省了多少」**，改完只能凭感觉说「好像小了点」；
//   而真正的风险是改坏的两种：
//     ① 为了省空间把数据删了（击杀/金币是玩家要盯着看的，不能删）
//     ② 把 .hud-right 收窄之后，`.hud-center{flex:1}` 的剩余空间变宽
//        → **倒计时跟着偏移**（顶栏三块是 flex，左右宽度会决定中间的位置）
//   所以这里既量「省了多少」，也量「有没有把别人挤歪」。
//
// 【分工】mobilecheck 是「手机端多宽度排障」；本脚本是「顶栏右侧这一块的专项回归」，
//   跑 PC 与手机两种 pointer 条件（窄屏走的是**另一套**规则，必须都测）。
//
// 用法：node tools/hudsize.js [端口]
// 依赖：先启动 server/index.js

const fs = require('node:fs');

// 第二参数可以是端口，也可以是完整地址（线上域名）。
// 【为什么必须支持域名】本地跑全绿只说明「本地这份代码没问题」，
//   而线上跑的到底是不是新代码、版面是不是也一样，只能打线上量一次才算数。
//   （本轮 HUD 改动就是这么复验的：不然「发布成功」只是一句话。）
const ARG = String(process.argv[2] || 3000);
const IS_URL = /^https?:\/\//.test(ARG);
const BASE = IS_URL ? ARG.replace(/\/+$/, '') : 'http://127.0.0.1:' + ARG;
const CDP_PORT = 9336;                 // 9333 gamecheck / 9334 roomcheck / 9335 预留
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_hudsize_profile';
const SHOT = TMP + '/vs_hudsize.png';
const LOG = TMP + '/vs_hudsize.log';


fs.writeFileSync(LOG, '');
function log() {
  const s = Array.prototype.map.call(arguments, function (a) {
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ');
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + '  ->  ' + (detail === undefined ? '断言不成立' : detail)); }
}

function killByPort(port) {
  return new Promise(function (resolve) {
    const { execFile } = require('node:child_process');
    execFile('powershell', ['-NoProfile', '-Command',
      '$p = (Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue).OwningProcess; ' +
      'if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }'
    ], function () { resolve(); });
  });
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-allow-origins=*',
      '--window-size=1280,860',
      'about:blank'
    ];
    // ★★测**线上域名**时必须显式指定代理，两个原因叠在一起：
    //   ① Windows 版 Chrome **不读** `http_proxy`/`https_proxy` 环境变量，只认系统代理设置；
    //   ② 本机的系统代理是「直连」，而这里出网要走本地代理。
    //   → 不指定的话导航会直接落到 `chrome-error://chromewebdata/`，
    //     症状是「VS_GAME 不存在 / 按钮全 no-btn / screen 空」，**看起来像前端崩了**，
    //     其实一行代码都没错（本地跑全绿）。本轮就是这么白查了一轮。
    //   ★端口每次会话都可能变（49675 / 52494…）→ 只能从环境变量现取，不能写死。
    //   测本地 127.0.0.1 时反过来要绕开代理（--no-proxy-server），免得代理把本地请求也接走。
    const proxy = process.env.http_proxy || process.env.https_proxy ||
      process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (IS_URL && proxy) args.push('--proxy-server=' + proxy);
    else args.push('--no-proxy-server');
    const chrome = require('node:child_process').spawn(CHROME, args, { stdio: 'ignore' });
    const t = setInterval(function () {
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        clearInterval(t); resolve(chrome);
      }).on('error', function () { /* 还没起来，继续等 */ });
    }, 300);
    setTimeout(function () { clearInterval(t); reject(new Error('Chrome 启动超时')); }, 20000);
  });
}

function connect(tag) {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      if (!tab || !tab.webSocketDebuggerUrl) throw new Error('新建标签页失败');
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        let id = 0;
        const pending = {};
        const pageErrors = [];
        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () { delete pending[msgId]; rej(new Error('CDP 超时：' + method)); }, 10000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
          if (msg.method === 'Page.javascriptDialogOpening') { send('Page.handleJavaScriptDialog', { accept: true }); return; }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            pageErrors.push('exception: ' + (d.text || ''));
          }
        });
        ws.addEventListener('open', async function () {
          await send('Page.enable');
          await send('Runtime.enable');
          resolve({
            tag: tag,
            pageErrors: pageErrors,
            send: send,
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
              if (r && r.exceptionDetails) { pageErrors.push('eval 异常: ' + (r.exceptionDetails.text || '')); return null; }
              return r && r.result ? r.result.value : null;
            },
            close: function () { try { ws.close(); } catch (e) { /* 收尾失败无所谓 */ } }
          });
        });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// ------------------------------------------------------------
// 页面内的量测体
// ------------------------------------------------------------
// 只读 DOM，不改任何状态 —— 量测脚本绝不能顺手把游戏弄停/弄乱。
const MEASURE = '(function(){' +
  'function rect(sel){' +
  '  var e = document.querySelector(sel); if (!e) return null;' +
  '  var r = e.getBoundingClientRect();' +
  '  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),' +
  '           h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };' +
  '}' +
  'var out = { vw: window.innerWidth, vh: window.innerHeight };' +
  'out.top = rect(".hud-top");' +
  'out.hudLeft = rect(".hud-left");' +
  'out.center = rect(".hud-center");' +
  'out.right = rect(".hud-right");' +
  'out.timer = rect(".hud-timer");' +
  // 右侧块的直接子元素（两个 .stat + 暂停 + ?）
  'out.kids = Array.prototype.slice.call(document.querySelectorAll(".hud-right > *")).map(function(e){' +
  '  var r = e.getBoundingClientRect();' +
  '  return { cls: String(e.className), text: (e.innerText || "").trim().slice(0, 10),' +
  '           x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),' +
  '           bottom: Math.round(r.bottom), display: getComputedStyle(e).display };' +
  '});' +
  // 击杀 / 金币两个 .stat：看它们是不是同一行（top 相同 = 并排）
  'var st = Array.prototype.slice.call(document.querySelectorAll(".hud-right .stat"));' +
  'out.stats = st.map(function(e){' +
  '  var r = e.getBoundingClientRect();' +
  '  return { text: (e.innerText || "").trim(), x: Math.round(r.left), y: Math.round(r.top),' +
  '           w: Math.round(r.width), h: Math.round(r.height),' +
  '           padT: getComputedStyle(e).paddingTop, padB: getComputedStyle(e).paddingBottom };' +
  '});' +
  'out.hudRightDisplay = (function(){ var e=document.querySelector(".hud-right"); return e?getComputedStyle(e).display:""; })();' +
  'out.hudRightFlex = (function(){ var e=document.querySelector(".hud-right"); return e?getComputedStyle(e).flex:""; })();' +
  'out.hudRightLH = (function(){ var e=document.querySelector(".hud-right"); return e?getComputedStyle(e).lineHeight:""; })();' +
  // Boss 血条让位探针。
  // 【为什么用探针】.boss-bar 带 v-if（只有首领在场才渲染），平时 DOM 里没有；
  //   但它的位置完全由 CSS 决定（基础 top:96px / 窄屏 top:126px）——
  //   造一个同 class 的元素量一次 top 再移除，量到的就是真实位置。
  // ★这条为什么必须量：Boss 血条是**绝对定位**，而顶栏高度由内容撑开，
  //   「改了顶栏 → 撞到 Boss 血条」是本项目踩过的坑（窄屏那次就是这么撞上的）。
  'out.bossTop = (function(){' +
  '  var host = document.getElementById("hud") || document.body;' +
  '  var probe = document.createElement("div");' +
  '  probe.className = "boss-bar";' +
  // ★必须禁掉入场动画再量：.boss-bar 有 `animation: bossIn`，它的 from 是
  //   translateY(-10px) —— 探针刚 append 的那一帧就落在动画起点上，
  //   量出来会比 CSS 里的 top 小 10px（96 → 86、126 → 116），
  //   于是得到「差 -1/-2px，撞上了」的假红。（第一版就是这么白报了两条 FAIL。）
  '  probe.style.animation = "none";' +
  '  host.appendChild(probe);' +
  '  var t = Math.round(probe.getBoundingClientRect().top);' +
  '  probe.remove();' +
  '  return t;' +
  '})();' +
  // 顶栏**内容**的底：三个块 bottom 的最大值。
  // ★不能用 .hud-top 的盒子底 —— 它含 34px 的底部渐变过渡区（padding），
  //   那一段本来就没有内容，拿来比较会得出「永远重叠」的假结论。
  'out.topContentBottom = Math.max(out.hudLeft.bottom, out.center.bottom, out.right.bottom);' +
  // 武器/被动槽位：格子数、空位数、空位与已占格的宽度差。
  // 【为什么要量】需求的验收标准就是「空位要看得见、且知道自己还剩几格」——
  //   而这两件事都只能靠 DOM 数量与宽度来判（肉眼看不出 6 格还是 5 格）。
  'var SLOT_MAX = (window.VS.CONST && window.VS.CONST.SLOTS) || { weapon: 0, passive: 0 };' +
  'out.slotMax = SLOT_MAX;' +
  'out.slots = Array.prototype.slice.call(document.querySelectorAll(".hud-slots .slot-row")).map(function(row){' +
  '  var all = Array.prototype.slice.call(row.querySelectorAll(".slot"));' +
  '  var emp = all.filter(function(e){ return e.className.indexOf("empty") >= 0; });' +
  '  var ful = all.filter(function(e){ return e.className.indexOf("empty") < 0; });' +
  '  var er = emp.length ? emp[0].getBoundingClientRect() : null;' +
  '  var fr = ful.length ? ful[0].getBoundingClientRect() : null;' +
  '  var rr = row.getBoundingClientRect();' +
  '  return {' +
  '    n: all.length, empty: emp.length, full: ful.length,' +
  '    emptyW: er ? Math.round(er.width) : 0, fullW: fr ? Math.round(fr.width) : 0,' +
  '    right: Math.round(rr.right), h: Math.round(rr.height),' +
  // 单格最高高度：用来判「这一行有没有折成两行」——
  // 不折行时行高 == 单格高；折了就是 2 倍单格高 + 一个 gap。
  '    chipH: all.length ? Math.round(Math.max.apply(null, all.map(function(e){' +
  '      return e.getBoundingClientRect().height; }))) : 0,' +
  '    txt: all.map(function(e){ return (e.innerText || "").trim(); }).join("/")' +
  '  };' +
  '});' +
  'out.slotBox = (function(){ var e = document.querySelector(".hud-slots"); if (!e) return null;' +
  '  var r = e.getBoundingClientRect();' +
  '  return { right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width) }; })();' +
  'out.goldVisible = (function(){' +
  '  var t = document.querySelector(".hud-right"); return t ? (t.innerText || "").indexOf("金币") >= 0 : false; })();' +
  'out.killVisible = (function(){' +
  '  var t = document.querySelector(".hud-right"); return t ? (t.innerText || "").indexOf("击杀") >= 0 : false; })();' +
  'return out;' +
  '})()';

async function openMatch(A) {
  // 导航到游戏页（带 debug=1 才挂 VS_GAME 调试句柄）
  await A.send('Page.navigate', {
    url: BASE + '/game.html?debug=1&_t=' + Date.now()
  });
  await sleep(2600);

  // 角色选择页 → 点「开始对局」
  const clicked = await A.eval('(function(){' +
    'var bs = Array.prototype.slice.call(document.querySelectorAll("button"));' +
    'var hit = bs.filter(function(b){ return (b.innerText || "").trim() === "开始对局"; })[0];' +
    'if (!hit) return "no-btn";' +
    'hit.click(); return "ok"; })()');
  log('  点「开始对局」：' + clicked);

  // ★点不到按钮时把现场打出来 —— 最常见的两种真因：
  //   ① 线上域名没走代理 → 导航失败，落在 chrome-error 页（见 launchChrome 的注释）
  //   ② 页面还没渲染完（远端首屏慢）
  //   没有这段诊断的话，症状只有一句「no-btn」，得再从零查一遍。
  if (clicked === 'no-btn') {
    const diag = await A.eval('(function(){' +
      'return { title: document.title, url: location.href,' +
      '  vg: typeof window.VS_GAME,' +
      '  btns: Array.prototype.slice.call(document.querySelectorAll("button")).map(function(b){' +
      '    return (b.innerText||"").replace(/\\s+/g," ").trim().slice(0,10); }).slice(0, 8),' +
      '  text: (document.body.innerText||"").replace(/\\s+/g," ").slice(0, 160) }; })()');
    log('  ⚠ 点不到「开始对局」，页面现场：' + JSON.stringify(diag));
  }
  await sleep(1800);

  const scr = await A.eval('(window.VS_GAME && window.VS_GAME.screen) || ""');
  log('  当前 screen：' + JSON.stringify(scr));
  return scr === 'playing';
}

// 一条尺寸剖面的完整量测 + 断言
async function measureOne(A, label, isTouch, viewW, viewH) {
  log('');
  log('=== ' + label + '（' + viewW + 'x' + viewH + (isTouch ? '  触摸/coarse' : '  桌面/fine') + '）===');

  // ★★量测前必须把世界拉回「进行中」，否则量到的是**残缺的顶栏**。
  //   【实测踩过】暂停与倍速按钮都是 `v-if="screen === 'playing'"`，而玩家站着不动
  //   会被怪打出升级面板（screen 变 levelup）—— 那一轮手机段只量到
  //   `hr-stats` 和 `?` 两个元素，于是「三个按钮会不会挤爆手机顶栏」这件事
  //   **根本没验到**，断言还全是绿的（因为溢出不溢出，少两个按钮当然不溢出）。
  //   处理：消化掉升级面板 + 给玩家一段无敌时间（用 invuln 而不是改血量 ——
  //   改 maxHp 会把血条数字撑长，反而污染「顶栏两侧等宽」那几条断言）。
  await A.eval('(function(){' +
    'var g = window.VS_GAME;' +
    'if (g.ui.screen === "levelup") {' +
    '  var ch = document.querySelectorAll(".overlay .choice, .overlay-dock .choice");' +
    '  if (ch.length) ch[0].click();' +
    '}' +
    'var p = g.world && g.world.player;' +
    'if (p) p.invuln = 30;' +
    'return 1; })()');
  await sleep(400);
  const scr = await A.eval('(window.VS_GAME && window.VS_GAME.ui.screen) || ""');
  expect(label + '：量测时处于对局中（顶栏元素齐全，否则量的是残缺态）',
    scr === 'playing', 'screen=' + JSON.stringify(scr) + '（levelup/result 会让暂停与倍速按钮隐藏）');

  await A.send('Emulation.setDeviceMetricsOverride', {
    width: viewW, height: viewH, deviceScaleFactor: 1, mobile: isTouch
  });
  // ★触摸模拟必须显式开/关：窄屏那套规则挂在 @media (pointer: coarse)，
  //   桌面 Chrome 默认 fine —— 不切的话「手机剖面」量的其实还是桌面规则（踩过）。
  await A.send('Emulation.setTouchEmulationEnabled', { enabled: isTouch, maxTouchPoints: isTouch ? 5 : 0 });
  await sleep(900);

  const m = await A.eval(MEASURE);
  if (!m || !m.right) { expect(label + '：能量到顶栏右侧', false, JSON.stringify(m)); return null; }

  log('  视口 ' + m.vw + 'x' + m.vh + '   顶栏 .hud-top ' + m.top.w + 'x' + m.top.h);
  log('  左 .hud-left   x=' + m.hudLeft.x + ' ~ ' + m.hudLeft.right + '  (' + m.hudLeft.w + 'x' + m.hudLeft.h + ')');
  log('  中 .hud-center x=' + m.center.x + ' ~ ' + m.center.right + '  (' + m.center.w + 'x' + m.center.h + ')  倒计时中心 x=' +
    (m.timer ? Math.round((m.timer.x + m.timer.right) / 2) : '-') + '（视口中心 ' + Math.round(m.vw / 2) + '）');
  log('  右 .hud-right  x=' + m.right.x + ' ~ ' + m.right.right + '  (' + m.right.w + 'x' + m.right.h + ')' +
    '  display=' + m.hudRightDisplay + ' flex=' + m.hudRightFlex + ' line-height=' + m.hudRightLH);
  log('    子元素：');
  m.kids.forEach(function (k) {
    log('      ' + (k.cls || '?').padEnd(22) + ' x=' + String(k.x).padStart(4) + '  y=' + String(k.y).padStart(4) +
      '  ' + String(k.w).padStart(4) + 'x' + String(k.h).padStart(3) + '  「' + k.text + '」');
  });

  log('  顶栏内容底 y=' + m.topContentBottom + '｜Boss 血条 top=' + m.bossTop +
    '（余 ' + (m.bossTop - m.topContentBottom) + 'px）' +
    (m.bossTop >= m.topContentBottom ? '' : '  ★撞上了'));
  if (m.slots && m.slots.length) {
    log('  槽位（上限 武器 ' + m.slotMax.weapon + ' / 被动 ' + m.slotMax.passive + '）：');
    m.slots.forEach(function (r, i) {
      log('    行' + (i + 1) + '  ' + r.n + ' 格（已占 ' + r.full + ' 空 ' + r.empty + '）' +
        '  空位宽=' + r.emptyW + 'px  已占格宽=' + r.fullW + 'px  右缘=' + r.right +
        '  行高=' + r.h + '  「' + r.txt.slice(0, 46) + '」');
    });
  } else {
    log('  ★没量到槽位（.hud-slots 不在 DOM 里？）');
  }
  // 顶栏右侧那几个按钮是否都在（少一个就说明量的是残缺态，后面的"溢出"结论不可信）
  const btns = m.kids.filter(function (k) { return k.cls.indexOf('btn') >= 0; }).map(function (k) { return k.text; });
  log('  右侧按钮：' + (btns.length ? btns.join(' / ') : '（无）'));
  expect(label + '：顶栏右侧按钮齐全（暂停 / ? / 倍速 ×1）',
    btns.length >= 3, '实际 ' + btns.length + ' 个：' + JSON.stringify(btns));

  const sameRow = m.stats.length >= 2 && m.stats[0].y === m.stats[1].y;
  log('  两个 stat：' + m.stats.map(function (s) {
    return '「' + s.text + '」y=' + s.y + ' ' + s.w + 'x' + s.h + ' pad=' + s.padT + '/' + s.padB;
  }).join('  |  ') + '  → ' + (sameRow ? '同一行' : '分两行'));
  m.stats.forEach(function (s, i) {
    log('    stat[' + i + '] x=' + s.x + ' 宽=' + s.w + ' 高=' + s.h + ' 右缘=' + (s.x + s.w));
  });

  // ---------------- 断言 ----------------
  // ① 数据不能因为「省空间」被删掉 —— 击杀与金币都是玩家盯着看的
  expect(label + '：击杀仍然显示', m.killVisible, 'innerText 里找不到「击杀」');
  expect(label + '：金币仍然显示', m.goldVisible, 'innerText 里找不到「金币」');

  // ② 两个 stat 必须在同一行（这就是「省空间」的直接判据）
  expect(label + '：击杀与金币并成一行（不再各占一行）', sameRow,
    JSON.stringify(m.stats.map(function (s) { return s.y; })));

  // ③ 右侧整块不能比顶栏还高（否则它会把顶栏撑起来）
  expect(label + '：右侧块高度不超过顶栏高度', m.right.h <= m.top.h,
    'right=' + m.right.h + ' top=' + m.top.h);

  // ④ 不能溢出视口右缘
  expect(label + '：右侧块没溢出视口', m.right.right <= m.vw,
    'right=' + m.right.right + ' vw=' + m.vw);

  // ⑤ 不能与中间的倒计时区重叠
  // ★判据必须是**二维矩形相交**，不能只比 x。
  //   窄屏顶栏是 flex-wrap（倒计时独占第一行、血条与击杀金币在第二行），
  //   那时 center 与 right 的 x 区间天然是重叠的 —— 只比 x 会稳定假红。
  //   （第一版就是这么写的，在手机上白报了一条 FAIL。）
  const xOverlap = m.center.right > m.right.x && m.right.right > m.center.x;
  const yOverlap = m.center.bottom > m.right.y && m.right.bottom > m.center.y;
  const reallyOverlap = xOverlap && yOverlap;
  expect(label + '：右侧块与倒计时区不重叠（二维判定）', !reallyOverlap,
    'center ' + m.center.x + '~' + m.center.right + ' y ' + m.center.y + '~' + m.center.bottom +
    ' | right ' + m.right.x + '~' + m.right.right + ' y ' + m.right.y + '~' + m.right.bottom +
    '  x重叠=' + xOverlap + ' y重叠=' + yOverlap);

  // ⑤c ★槽位必须画出「已占用 + 空位」，且总数等于上限。
  //     需求的验收点就在这：玩家要能一眼看到还剩几格能学技能。
  //     ★上限从页面里的 CONST 现取，不写死 6 —— 以后调 SLOTS 断言不会假红。
  const SL = m.slotMax || { weapon: 0, passive: 0 };
  if (m.slots && m.slots.length >= 2) {
    expect(label + '：武器行格子数 = 上限 ' + SL.weapon + '（含空位）',
      m.slots[0].n === SL.weapon, '实际 ' + m.slots[0].n + ' 格');
    expect(label + '：被动行格子数 = 上限 ' + SL.passive + '（含空位）',
      m.slots[1].n === SL.passive, '实际 ' + m.slots[1].n + ' 格');
    expect(label + '：开局武器行只有 1 格已占、其余是空位',
      m.slots[0].full === 1 && m.slots[0].empty === SL.weapon - 1,
      '已占 ' + m.slots[0].full + ' 空 ' + m.slots[0].empty);
    expect(label + '：开局被动行全是空位（还没学）',
      m.slots[1].full === 0 && m.slots[1].empty === SL.passive,
      '已占 ' + m.slots[1].full + ' 空 ' + m.slots[1].empty);
    expect(label + '：空位格子明显比已占格窄（不抢宽度）',
      m.slots[0].emptyW > 0 && m.slots[0].fullW > 0 && m.slots[0].emptyW < m.slots[0].fullW,
      '空 ' + m.slots[0].emptyW + 'px vs 已占 ' + m.slots[0].fullW + 'px');
    // ★★槽位行**不许折行**。
    //   上限从 6 提到 10 之后，一行要放下 10 格 —— 放不下就会折成两行，
    //   底部 HUD 抬高一大截盖住战场，而且**不报任何错**。
    //   「不溢出视口」那条抓不到它（折行之后总宽反而更小了），只能量行高：
    //   不折行时 行高 == 单格高；折一行就是 2 倍单格高 + 一个间隙。
    //   【反向验证过】把窄屏段的 `.slot-row{max-width:calc(100vw - 34px)}` 收回 54vw
    //     → 手机段武器行立刻折成两行，这条变红（实测 行高 51 vs 单格 28）。
    //   ⚠️ 窄屏段另一条 `.slot.empty{width:16px}` 在 390px 上量不出差别（收窄行之后
    //      22px 也放得下），它是给 ≤360px 的更窄屏兜底的 —— 所以没有为它单独写断言，
    //      别以为「两条 CSS 各自都有一条断言守着」。
    expect(label + '：武器槽一行放得下（10 格没折成两行）',
      m.slots[0].chipH > 0 && m.slots[0].h <= m.slots[0].chipH + 8,
      '行高 ' + m.slots[0].h + ' vs 单格高 ' + m.slots[0].chipH);
    expect(label + '：被动槽一行放得下（10 格没折成两行）',
      m.slots[1].chipH > 0 && m.slots[1].h <= m.slots[1].chipH + 8,
      '行高 ' + m.slots[1].h + ' vs 单格高 ' + m.slots[1].chipH);
    expect(label + '：槽位整块没溢出视口',
      !!m.slotBox && m.slotBox.right <= m.vw, m.slotBox ? ('right=' + m.slotBox.right + ' vw=' + m.vw) : 'null');
  } else {
    expect(label + '：能量到武器/被动两行槽位', false, JSON.stringify(m.slots));
  }

  // ⑤b ★Boss 血条必须让开顶栏**内容**（顶栏盒子底不算 —— 那 34px 是渐变过渡区）
  //     这条守的是「改了顶栏把 Boss 血条撞了」：血条是绝对定位，顶栏高度却是内容撑的，
  //     两者没有硬关联，只能靠量。
  expect(label + '：Boss 血条让开了顶栏内容', m.bossTop >= m.topContentBottom,
    'boss-bar top=' + m.bossTop + ' 顶栏内容底=' + m.topContentBottom +
    '（差 ' + (m.bossTop - m.topContentBottom) + 'px）');

  // ⑥ 倒计时仍在视口水平中央附近（±6%）——
  //    ★这条是防「收窄右侧把倒计时挤偏」：顶栏三块是 flex，左右宽度会决定中间的位置
  const timerCx = m.timer ? Math.round((m.timer.x + m.timer.right) / 2) : 0;
  const off = Math.abs(timerCx - m.vw / 2);
  expect(label + '：倒计时仍在视口中央附近（偏移 ≤ ' + Math.round(m.vw * 0.06) + 'px）',
    off <= m.vw * 0.06, '倒计时中心 ' + timerCx + ' 视口中心 ' + Math.round(m.vw / 2) + ' 偏 ' + off + 'px');

  return m;
}

// ============================================================

// ============================================================
// 技能说明卡：点左下角技能格能不能看到说明
// ============================================================
// 【为什么要真点一次】说明卡有**两个入口**，而且它们按指针类型分流：
//   · 鼠标（pointer: fine）→ 精确点到某一格，直接看那一件
//   · 触屏（pointer: coarse）→ 点整块技能区，打开「我的技能」列表（每行 44px）
// 这两条路各自可能坏在不同的地方：data-skill 没挂上 / closest 取错元素 /
// matchMedia 判断反了 / 卡片把技能行盖住了 —— 都只有真点一次才看得出来。
//
// 【为什么不把技能格做成 <button>】格子只有 20~28px 高，而项目约定触摸目标 ≥44px。
//   做成按钮会被 pixel-ui.css 的 `button{min-height:44px}` 强行拉高，10 格的槽位行
//   会变成一堵高墙（实测底部 HUD 从 52px 涨到 140px）。所以可点区域是**整块技能区**，
//   这里也要顺带验「没有哪个技能格偷偷变成小于 44px 的按钮」。
async function measureSlotCard(A, label, isTouch, viewW, viewH) {
  log('');
  log('=== 技能说明卡（' + label + (isTouch ? '  触摸/coarse' : '  桌面/fine') + '）===');

  await A.send('Emulation.setDeviceMetricsOverride', {
    width: viewW, height: viewH, deviceScaleFactor: 1, mobile: isTouch
  });
  // ★触摸模拟必须显式开/关：两条入口就是按 pointer 类型分流的，
  //   不切的话「触屏走列表」这条根本没被验到（会安静地按桌面路径跑过去）。
  await A.send('Emulation.setTouchEmulationEnabled', isTouch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await sleep(400);

  // 保证处于对局中（升级面板会把左下角槽位一起盖掉）
  await A.eval('(function(){' +
    'var g = window.VS_GAME;' +
    'if (g.ui.screen === "levelup") {' +
    '  var ch = document.querySelectorAll(".overlay .choice, .overlay-dock .choice");' +
    '  if (ch.length) ch[0].click();' +
    '}' +
    'var p = g.world && g.world.player;' +
    'if (p) p.invuln = 60;' +
    'var c = document.querySelector(".sc-close"); if (c) c.click();' +   // 先收掉上一轮可能开着的卡片
    'return 1; })()');
  await sleep(350);
  const scr = await A.eval('(window.VS_GAME && window.VS_GAME.ui.screen) || ""');
  expect(label + '：说明卡量测时处于对局中', scr === 'playing', 'screen=' + JSON.stringify(scr));

  // ---------- ① 点一格（鼠标）/ 点整块（触屏）----------
  // ★注意：本文件的 A.eval 用的是 `awaitPromise: false`，
  //   所以**不能**在这里写 async IIFE —— 返回的是个 Promise 对象，
  //   returnByValue 序列化出来是 `{}`，量测会静默拿到空对象。
  //   一律「点一次 → sleep → 同步量一次」，与 measureOne 的写法保持一致。
  await A.eval('(function(){' +
    'var chips = document.querySelectorAll(".hud-slots .slot:not(.empty)");' +
    'if (!chips.length) return 0;' +
    'chips[0].click();' +              // 点在具体某一格上（触屏路径会自己降级成列表）
    'return 1; })()');
  await sleep(400);
  const open = await A.eval('(function(){' +
    'var chips = document.querySelectorAll(".hud-slots .slot:not(.empty)");' +
    'var card = document.querySelector(".slot-card");' +
    'var rows = Array.prototype.slice.call(document.querySelectorAll(".mc-row"));' +
    'var rh = rows.map(function(x){ return x.getBoundingClientRect().height; });' +
    'return {' +
    '  id: chips.length ? chips[0].getAttribute("data-skill") : "",' +
    '  coarse: window.matchMedia("(pointer: coarse)").matches,' +
    '  hasCard: !!card,' +
    '  cardName: (document.querySelector(".sc-name")||{}).innerText || "",' +
    '  desc: (document.querySelector(".sc-desc")||{}).innerText || "",' +
    '  relRows: document.querySelectorAll(".sc-row").length,' +
    '  listN: rows.length,' +
    '  listMinH: rh.length ? Math.round(Math.min.apply(null, rh)) : 0,' +
    '  cardBox: card ? (function(){ var r = card.getBoundingClientRect();' +
    '    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; })() : null,' +
    '  slotsTop: (function(){ var s = document.querySelector(".hud-slots");' +
    '    if (!s) return -1;' +
    '    var rr = Array.prototype.slice.call(s.querySelectorAll(".slot-row"));' +
    '    return rr.length ? Math.round(rr[0].getBoundingClientRect().top) : -1; })()' +
    '}; })()');
  log('  点第一格：' + JSON.stringify(open));

  if (isTouch) {
    // 触屏：手指点不准 16px 宽的空槽 → 一律给「我的技能」列表（每行 44px）
    expect(label + '：★触屏点技能区打开「我的技能」列表（不猜玩家点的是哪一格）',
      !!(open && open.listN > 0), JSON.stringify(open && { listN: open.listN, card: open.hasCard }));
    expect(label + '：★列表每一行都 ≥44px（触摸目标约定）',
      !!(open && open.listMinH >= 44), open && (open.listMinH + 'px'));
  } else {
    expect(label + '：★鼠标点某一格直接给出那一件的说明（卡片出现）',
      !!(open && open.hasCard && !open.listN), JSON.stringify(open && { card: open.hasCard, list: open.listN }));
    expect(label + '：说明卡里写出了技能名与说明',
      !!(open && open.cardName && open.desc), open && JSON.stringify({ n: open.cardName, d: open.desc.slice(0, 20) }));
    expect(label + '：★说明卡里带得出关联（组合技 / 进化 / 配方至少有一行）',
      !!(open && open.relRows > 0), open && String(open.relRows));
    // 版面：卡片必须整个待在技能行**上方**，不能把技能格盖住
    expect(label + '：卡片没有盖住左下角技能行',
      !!(open && open.cardBox && open.cardBox.bottom <= open.slotsTop),
      open && JSON.stringify({ cardBottom: open.cardBox && open.cardBox.bottom, slotsTop: open.slotsTop }));

    // ---------- ② 再点同一格 = 收起 ----------
    await A.eval('(function(){' +
      'var chips = document.querySelectorAll(".hud-slots .slot:not(.empty)");' +
      'if (!chips.length) return 0;' +
      'chips[0].click();' +
      'return 1; })()');
    await sleep(400);
    const closed = await A.eval('(function(){' +
      'return { hasCard: !!document.querySelector(".slot-card"),' +
      '         info: !!window.VS_GAME.ui.slotInfo }; })()');
    expect(label + '：★再点同一格会收起卡片（不用非得去戳那个小 ×）',
      !!(closed && !closed.hasCard && !closed.info), JSON.stringify(closed));
  }

  // ---------- ③ 卡片上的关闭按钮：在触屏下也不能被裁掉 ----------
  await A.eval('(function(){' +
    // 触屏这条前面没打开过卡片（走的是列表），先打开才有得量
    'if (!document.querySelector(".slot-card")) {' +
    '  var s = document.querySelector(".hud-slots"); if (s) s.click();' +
    '}' +
    'return 1; })()');
  await sleep(400);
  const closeBox = await A.eval('(function(){' +
    'var b = document.querySelector(".sc-close");' +
    'if (!b) return { err: "没有卡片" };' +
    'var r = b.getBoundingClientRect();' +
    'var card = document.querySelector(".slot-card").getBoundingClientRect();' +
    'return { w: Math.round(r.width), h: Math.round(r.height),' +
    '         right: Math.round(card.right), vw: document.documentElement.clientWidth }; })()');
  expect(label + '：卡片能打开，且关闭按钮没被裁出视口',
    !!(closeBox && !closeBox.err && closeBox.right <= closeBox.vw),
    JSON.stringify(closeBox));

  // 收尾：把卡片关掉，别影响后面的量测
  await A.eval('(function(){ var c = document.querySelector(".sc-close"); if (c) c.click(); return 1; })()');
  await sleep(200);
}

// ============================================================

async function main() {
  log('=== HUD 击杀/金币区占地量测  目标 ' + BASE + ' ===');

  await killByPort(CDP_PORT);
  const chrome = await launchChrome();
  const A = await connect('A');
  // 投屏唤醒 rAF（无头环境没有合成帧，主循环不会跑）
  await A.send('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 1 });

  const playing = await openMatch(A);
  expect('能进入对局（量测前提）', playing, 'screen 不是 playing');
  if (!playing) { chrome.kill(); await killByPort(CDP_PORT); process.exit(2); }

  // ---------- 倍速（单机）----------
  // ★放在三个剖面**之前**量：那三段加起来要十几秒，而这游戏里站着不动的玩家
  //   很快就会被怪打死 —— 一旦进结算界面世界就不再推进，倍速根本量不出来。
  log('');
  log('=== 倍速功能（单机）===');
  {
    const sp0 = await A.eval('(function(){' +
      'var g = window.VS_GAME; var b = document.querySelector(".speed-btn");' +
      'return { speed: g.ui.speed, has: !!b, txt: b ? (b.innerText || "").trim() : "",' +
      '         screen: g.ui.screen, online: !!g.ui.online }; })()');
    log('  初始：' + JSON.stringify(sp0));
    expect('单机对局里有倍速按钮', !!(sp0 && sp0.has), JSON.stringify(sp0));
    expect('初始倍速是 ×1', !!(sp0 && sp0.speed === 1), JSON.stringify(sp0));

    await A.eval('(function(){ var b=document.querySelector(".speed-btn"); if(b) b.click(); return 1; })()');
    await sleep(320);
    const sp1 = await A.eval('(function(){ var b=document.querySelector(".speed-btn");' +
      'return { speed: window.VS_GAME.ui.speed, on: b ? b.className.indexOf("on") >= 0 : false,' +
      '         txt: b ? (b.innerText || "").trim() : "" }; })()');
    log('  点一次：' + JSON.stringify(sp1));
    expect('点一下变 ×2，且按钮带高亮（.on）',
      !!(sp1 && sp1.speed === 2 && sp1.on === true), JSON.stringify(sp1));

    await A.eval('(function(){ document.querySelector(".speed-btn").click(); return 1; })()');
    await sleep(320);
    const sp2 = await A.eval('window.VS_GAME.ui.speed');
    expect('再点一下变 ×4（1 → 2 → 4 循环）', sp2 === 4, '×' + sp2);

    // ★功能验证（这一条才是重点）：同样长度的**真实时间**里，
    //   ×4 应该推进出明显更多的**世界时间** —— 「整体加速、时间也变快」就落在这里。
    //   只验「按钮文字变了」是不够的：那只能证明 UI 会变，证明不了世界真的快了。
    const rateOf = async function () {
      const a = await A.eval('window.VS_GAME.world.time');
      await sleep(1500);
      const b = await A.eval('window.VS_GAME.world.time');
      return { a: a, b: b, rate: (b - a) / 1.5 };   // 世界秒 / 真实秒
    };
    const r4 = await rateOf();                       // 当前 ×4
    await A.eval('(function(){ document.querySelector(".speed-btn").click(); return 1; })()');  // 4 → 1
    await sleep(400);
    const r1 = await rateOf();                       // ×1
    log('  世界时间流速：×4 = ' + r4.rate.toFixed(2) + ' 世界秒/真实秒（' + r4.a.toFixed(1) + '→' + r4.b.toFixed(1) + '）' +
      '，×1 = ' + r1.rate.toFixed(2) + '（' + r1.a.toFixed(1) + '→' + r1.b.toFixed(1) + '）');
    // ★阈值取 2.5 而不是 4：×4 是「目标」，实际会被 CPU 与补帧上限压住一点；
    //   只要明显快于 1 倍即算生效。同时 ×1 那一条必须接近 1（否则说明基准就不对）。
    expect('★★×4 时世界时间明显走得更快（真的加速了，不只是按钮变了）',
      r4.rate > r1.rate * 2.5, '×4=' + r4.rate.toFixed(2) + ' vs ×1=' + r1.rate.toFixed(2));
    expect('×1 时世界时间流速接近 1（基准可信）',
      r1.rate > 0.7 && r1.rate < 1.4, r1.rate.toFixed(2));
    const back = await A.eval('window.VS_GAME.ui.speed');
    expect('已恢复 ×1（不把加速态留给后面的量测）', back === 1, '×' + back);
  }

  const pc = await measureOne(A, 'PC 1280x860', false, 1280, 860);
  const phone = await measureOne(A, '手机 390x844', true, 390, 844);
  const ipad = await measureOne(A, 'iPad 820x1180', true, 820, 1180);

  await measureSlotCard(A, 'PC 1280x860', false, 1280, 860);
  await measureSlotCard(A, '手机 390x844', true, 390, 844);

  // 截图留档（手机那一屏，用户报的就是这一带）
  try {
    const shot = await A.send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    log('');
    log('截图已存：' + SHOT);
  } catch (e) { log('截图失败：' + e.message); }

  expect('页面零未捕获异常', A.pageErrors.length === 0, JSON.stringify(A.pageErrors.slice(0, 3)));

  log('');
  log('=== 汇总 ===');
  log('  PASS  ' + pass);
  log('  FAIL  ' + fail);

  try { chrome.kill(); } catch (e) { /* 收尾失败无所谓 */ }
  await killByPort(CDP_PORT);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  log('脚本异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
