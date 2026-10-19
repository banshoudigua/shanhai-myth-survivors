// tools/netcheck.js —— 本轮四项改动的端到端实测（真实浏览器 + 真实 WebSocket）
//
// 为什么单独写一个脚本而不是塞进 roomcheck：
//   roomcheck 是「两个客户端把房间流程走一遍」的重型脚本（跑一次好几分钟）。
//   本轮的四项改动里，有三项**一个人就能验**（阵亡倒计时界面、掉线自动重连、
//   分享二维码），只有「扫码进房」需要第二个客户端。合进 roomcheck 的话，
//   每次改这几块都要陪跑整套房间流程，太慢。
//
// 覆盖：
//   [1] 单人房也能开局（后面几项的载体）
//   [2] 分享二维码：弹层 / 码面点阵与库生成的矩阵逐点一致 / 链接带房间号
//   [3] 联机阵亡倒计时层：出现 / 显示秒数 / 收起
//   [4] 掉线自动重连：提示条出现 → 自己接回来 → 提示条消失 → 进度与座位接回
//   [5] 扫码进房：另一个标签页打开邀请链接，自动落进这桌（中途加入）
//
// 用法：node tools/netcheck.js [端口]
// 依赖：先启动 server/index.js

const fs = require('node:fs');
const { spawn } = require('node:child_process');

// 参数：端口（3000）或完整地址（https://xxx.app.workbuddy.host）。
// 与 fuzzcheck / statscheck / difftest 保持同一套约定 —— 同一份脚本能直接对着线上跑，
// 这是「改动在真公网环境同样成立」的唯一证据（本机直连没有网关，有些坑只在线上出现）。
const ARG = String(process.argv[2] || 3000);
const BASE_URL = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9336;                  // 别撞 9333（gamecheck）/ 9334（roomcheck）
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_netcheck_profile';
const SHARE_SHOT = TMP + '/vs_netcheck_share.png';
const DEAD_SHOT = TMP + '/vs_netcheck_dead.png';
const RETRY_SHOT = TMP + '/vs_netcheck_retry.png';
const TEAM_SHOT = TMP + '/vs_netcheck_team.png';
const CHEST_SHOT = TMP + '/vs_netcheck_chest.png';
const CONNLOG_SHOT = TMP + '/vs_netcheck_connlog.png';
const AVATAR2_SHOT = TMP + '/vs_netcheck_avatar2.png';
const SPEC_SHOT = TMP + '/vs_netcheck_spec.png';
const LOG = TMP + '/vs_netcheck.log';


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
  if (cond) { pass += 1; log('  PASS  ' + name); }
  else { fail += 1; log('  FAIL  ' + name + '  ->  ' + (detail === undefined ? '断言不成立' : detail)); }
}

// ============================================================
// 无头浏览器与 CDP（与 roomcheck 同一套做法）
// ============================================================

function killByPort(port) {
  return new Promise(function (resolve) {
    require('node:child_process').execFile('powershell', ['-NoProfile', '-Command',
      '$p = (Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue).OwningProcess; ' +
      'if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }'
    ], function () { resolve(); });
  });
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--disable-gpu',
      '--no-sandbox',
      '--no-proxy-server',
      '--no-first-run',
      '--hide-scrollbars',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-allow-origins=*',
      '--window-size=1280,860',
      'about:blank'
    ];
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    child.on('error', reject);

    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume();
        clearInterval(t);
        resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口 ' + CDP_PORT + ' 20 秒内没起来')); }
      });
    }, 500);
  });
}

function connect(tag) {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      if (!tab || !tab.webSocketDebuggerUrl) throw new Error('新建标签页失败：' + JSON.stringify(tab));
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        let id = 0;
        const pending = {};
        const pageErrors = [];
        const consoleLogs = [];

        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () {
              delete pending[msgId];
              rej(new Error('CDP 命令超时：' + method));
            }, 10000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }

        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) {
            pending[msg.id](msg.result);
            delete pending[msg.id];
            return;
          }
          if (msg.method === 'Page.javascriptDialogOpening') {
            log('！！页面弹了对话框：' + JSON.stringify(msg.params));
            send('Page.handleJavaScriptDialog', { accept: true });
            return;
          }
          if (msg.method === 'Runtime.consoleAPICalled') {
            const text = (msg.params.args || []).map(function (a) {
              return a.value !== undefined ? String(a.value) : (a.description || a.type);
            }).join(' ');
            consoleLogs.push(msg.params.type + ': ' + text);
            return;
          }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            pageErrors.push('exception: ' + (d.text || '') + ' ' +
              ((d.exception && d.exception.description) || ''));
            return;
          }
          if (msg.method === 'Log.entryAdded') {
            const e = msg.params.entry || {};
            if (e.level === 'error') pageErrors.push('log: ' + (e.text || '') + ' ' + (e.url || ''));
          }
        });

        ws.addEventListener('open', async function () {
          await send('Page.enable');
          await send('Runtime.enable');
          await send('Log.enable');
          resolve({
            tag: tag,
            send: send,
            pageErrors: pageErrors,
            consoleLogs: consoleLogs,
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', {
                expression: expr,
                returnByValue: true,
                awaitPromise: false
              });
              if (r && r.exceptionDetails) {
                pageErrors.push('eval 异常: ' + JSON.stringify(r.exceptionDetails.text || ''));
                return null;
              }
              return r && r.result ? r.result.value : null;
            },
            // 能 await 页面里的 Promise。
            // 【为什么需要】验证「阵亡倒计时层」这类界面必须在一个表达式里做完
            // 「注入状态 → 等 Vue 更新完 DOM → 读 DOM」：分开两次 eval 的话，
            // 中间服务端的 HUD 就会把状态覆盖回 playing，界面还没画出来就没了。
            evalAsync: async function (expr) {
              const r = await send('Runtime.evaluate', {
                expression: expr,
                returnByValue: true,
                awaitPromise: true
              });
              if (r && r.exceptionDetails) {
                pageErrors.push('eval 异常: ' + JSON.stringify(r.exceptionDetails.text || ''));
                return null;
              }
              return r && r.result ? r.result.value : null;
            },
            shot: async function (path) {
              const r = await send('Page.captureScreenshot', { format: 'png' });
              if (r && r.data) fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
            },
            // 控制台里有没有出现过某个片段（自动化断言「服务端确实把人接回来了」）
            said: function (needle) {
              return consoleLogs.some(function (l) { return l.indexOf(needle) >= 0; });
            },
            // 主动关掉这个标签页。
            // 【为什么必须有】观战那一节要新开第三个标签页，不关的话它会一直连着服务器 ——
            // 后面 [8] 那条「坏 token 要停止重连」会因此多出一个干扰源（多一个重连中的观众），
            // 排查时很难想到是残留标签页干的。
            close: function () {
              try { ws.close(); } catch (e) { /* 已断开就算了 */ }
            }
          });
        });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

function clickByText(text, exact) {
  return '(function(){' +
    'var list = Array.prototype.slice.call(document.querySelectorAll("button"));' +
    'var hit = list.filter(function(b){ var t=(b.innerText||"").trim();' +
    '  return ' + (exact ? 't === ' + JSON.stringify(text) : 't.indexOf(' + JSON.stringify(text) + ') === 0') + '; })[0];' +
    'if(!hit) return { ok:false, buttons: list.map(function(b){return (b.innerText||"").trim()}) };' +
    'hit.click();' +
    'return { ok:true };' +
    '})()';
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  if (label) log('   （等待超时：' + label + '）');
  return null;
}

// ---------------- 大厅侧状态 ----------------
const LOBBY_STATE = '(function(){' +
  'var R = {};' +
  'var app = document.getElementById("app");' +
  'R.cloak = app ? app.hasAttribute("v-cloak") : null;' +
  'var big = document.querySelector(".room-code-big");' +
  'R.roomCode = big ? (big.innerText||"").trim() : null;' +
  'R.memberNames = Array.prototype.slice.call(document.querySelectorAll(".member-row")).map(function(e){ return (e.innerText||"").replace(/\\s+/g," ").trim(); });' +
  'R.connText = (document.querySelector(".conn")||{}).innerText || "";' +
  'R.buttons = Array.prototype.slice.call(document.querySelectorAll("button")).map(function(b){ return (b.innerText||"").trim(); });' +
  'R.href = location.href;' +
  'return R;' +
  '})()';

// 游戏页侧状态（字段全部读自 window.VS_GAME，与 game.js 里挂的名字一一对应）
const GAME_STATE = '(function(){' +
  'var G = window.VS_GAME; if (!G) return { missing:true };' +
  'var R = {};' +
  'R.screen = G.screen;' +
  'R.online = G.online;' +
  'R.players = G.players;' +
  'R.mobs = G.mobs;' +
  'R.snapCount = G.snapCount;' +
  'R.netState = G.netState;' +
  'R.netRetry = G.netRetry;' +
  'R.netReconnecting = G.netReconnecting;' +
  'R.netWelcomed = G.netWelcomed;' +
  'R.netErr = G.ui.netErr;' +
  'R.level = G.hud.level;' +
  'R.kills = G.hud.kills;' +
  'R.shareOpen = G.ui.shareOpen;' +
  'R.shareUrl = G.ui.shareUrl;' +
  'R.shareCode = G.ui.shareCode;' +
  'R.roomCode = G.ui.roomCode;' +
  'R.hasShareCanvas = !!document.getElementById("share-qr");' +
  'R.retryBanner = !!document.querySelector(".net-retry");' +
  'R.retryText = (document.querySelector(".net-retry")||{}).innerText || "";' +
  'R.deadDock = !!document.querySelector(".dead-dock");' +
  'R.deadText = (document.querySelector(".dead-dock")||{}).innerText || "";' +
  'R.buttons = Array.prototype.slice.call(document.querySelectorAll("button")).map(function(b){ return (b.innerText||"").trim(); });' +
  'return R;' +
  '})()';

// 逐点比对「canvas 上画出来的点阵」与「库对同一个链接生成的矩阵」。
// 这一步才是真的在验二维码：只断言「canvas 不是空白」的话，
// 画歪了、缩放错了、静默区没了都照样过。
const QR_VERIFY = function (code) {
  return '(function(){' +
    'var G = window.VS_GAME; if (!G) return { missing:true };' +
    'var Qr = window.qrcode; if (!Qr) return { noLib:true };' +
    'var cv = document.getElementById("share-qr"); if (!cv) return { noCanvas:true };' +
    'var url = window.VS.SHARE.inviteUrl(G.ui.shareCode);' +
    'var qr = Qr(0,"M"); qr.addData(url); qr.make();' +
    'var n = qr.getModuleCount();' +
    'var pad = 4, total = n + pad*2, px = 216, dpr = window.devicePixelRatio || 1;' +
    'var ctx = cv.getContext("2d");' +
    'var img = ctx.getImageData(0,0,cv.width,cv.height).data;' +
    'function darkAt(x,y){ var i=((y*cv.width)+x)*4; return img[i] < 120; }' +
    'var cell = (px*dpr)/total;' +
    'var mismatch = 0;' +
    'for (var r=0;r<n;r++){ for (var c=0;c<n;c++){' +
    '  var cx=Math.floor((c+pad+0.5)*cell), cy=Math.floor((r+pad+0.5)*cell);' +
    '  if (qr.isDark(r,c) !== darkAt(cx,cy)) mismatch++;' +
    '} }' +
    // 静默区必须是浅色：不留白的话很多扫描器直接不认
    'var quiet = darkAt(Math.floor(cell*1.5), Math.floor(cell*1.5));' +
    'return { n:n, mismatch:mismatch, quietDark:quiet, url:url, code:G.ui.shareCode, lib:true };' +
    '})()';
};

// 候场室的难度选择器状态
const DIFF_UI = '(function(){' +
  // ★`.diff-btn:not(.map-btn)`：地图按钮为了复用样式也挂了 diff-btn 这个类，
  //   不加限定就会把 4 张地图一起当成难度档，count 从 4 变 8。
  'var btns = Array.prototype.slice.call(document.querySelectorAll(".diff-btn:not(.map-btn)"));' +
  'return {' +
  '  count: btns.length,' +
  '  names: btns.map(function(b){ var n = b.querySelector(".diff-name"); return n ? (n.innerText||"").trim() : ""; }),' +
  '  active: (function(){ var a = btns.filter(function(b){ return b.className.indexOf("active") >= 0; })[0];' +
  '    if (!a) return ""; var n = a.querySelector(".diff-name"); return n ? (n.innerText||"").trim() : ""; })(),' +
  '  disabledCount: btns.filter(function(b){ return b.disabled; }).length' +
  '};' +
  '})()';

// 数画布上「琥珀金系」的像素。
// 宝箱的描边是 #f2c14e（242,196,78）—— 这个色相在场景里几乎没有别的东西会用：
// 地面是冷灰、怪是暗红/土黄、经验球是冷灰白、血条是红。所以「琥珀像素明显变多」
// 就是「宝箱真的画出来了」的可靠证据，比截图肉眼看靠谱。
const AMBER_PROBE = '(function(){' +
  'var cv = document.getElementById("game-canvas"); if (!cv) return { noCanvas: true };' +
  'var d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;' +
  'var n = 0;' +
  'for (var i = 0; i < d.length; i += 4) {' +
  '  if (d[i] > 200 && d[i+1] > 150 && d[i+1] < 225 && d[i+2] < 130) n++;' +
  '}' +
  'return { amber: n, w: cv.width, h: cv.height };' +
  '})()';

// 连接日志：既读数据（VS_LOBBY.connLog，新的在前），也读渲染结果（面板里的行）
const CONN_LOG = '(function(){' +
  'var R = {};' +
  'var L = (window.VS_LOBBY && window.VS_LOBBY.connLog) ? window.VS_LOBBY.connLog : [];' +
  'R.count = L.length;' +
  'R.texts = L.map(function(x){ return x.text; });' +
  'R.times = L.map(function(x){ return x.at; });' +
  'R.joined = R.texts.join(" | ");' +
  'R.atOk = R.times.length > 0 && R.times.every(function(t){ return /^\\d\\d:\\d\\d:\\d\\d$/.test(t); });' +
  'R.badCount = L.filter(function(x){ return x.level === "err" || x.level === "warn"; }).length;' +
  'R.handshakeCount = R.texts.filter(function(t){ return t.indexOf("握手完成") >= 0; }).length;' +
  'R.warnText = L.filter(function(x){ return x.level === "warn" || x.level === "err"; })' +
  '  .map(function(x){ return x.text; }).join(" | ");' +
  'R.panelOpen = !!document.querySelector(".connlog-panel");' +
  'R.rows = document.querySelectorAll(".connlog-row").length;' +
  'R.toggleText = (document.querySelector(".connlog-toggle")||{}).innerText || "";' +
  'R.wsState = window.VS_LOBBY ? window.VS_LOBBY.wsState : "";' +
  'return R;' +
  '})()';

// 对局名单里的头像（双窗口头像隔离用例读它）
const ROSTER_AV = '(function(){' +
  'var G = window.VS_GAME; if (!G) return { missing: true };' +
  'var r = G.roster || [];' +
  'return {' +
  '  n: r.length,' +
  '  slots: r.map(function(x){ return x.slot; }),' +
  '  names: r.map(function(x){ return x.name; }),' +
  '  avatars: r.slice().sort(function(a,b){ return a.slot - b.slot; }).map(function(x){ return x.avatar; })' +
  '};' +
  '})()';

// 观战状态探针：验「观战者真的处在观战形态」。
// 【为什么要单开一个而不是复用 GAME_STATE】GAME_STATE 是一大坨通用字段，
// 观战的每一条（是不是观众、有没有座位、跟谁）都是「必须为某个特定值」，
// 混在一起会让断言写成「不小于 0」这种糊弄形式，失去意义。
const SPEC_STATE = '(function(){' +
  'var G = window.VS_GAME; if (!G) return { missing: true };' +
  'return {' +
  '  screen: G.screen,' +
  '  spectating: G.spectating,' +
  '  selfSlot: G.selfSlot,' +
  '  followSlot: G.followSlot,' +
  '  players: G.players,' +
  '  snapPlayers: (G.snapPlayers||[]).map(function(x){ return { slot: x.slot, name: x.name }; }),' +
  '  roster: (G.roster||[]).map(function(x){ return { slot: x.slot, name: x.name }; }),' +
  '  tick: G.tick,' +
  '  snapSpectating: G.snapSpectating' +
  '};' +
  '})()';

// 观战界面探针：直接查 DOM 有没有那些元素。
// 【为什么要查 DOM 而不是只看状态】状态对了但模板没跟着改，是这类界面改动
// 最常见的失败方式 —— 数据层全绿，玩家看到的却还是一屏血条。
// eval 遇到异常返回 null，所以每个表达式都写成不会抛的形式。
const SPEC_UI = '(function(){' +
  'function txt(sel){ var e=document.querySelector(sel); return e ? (e.innerText||"") : null; }' +
  'function hasText(sel, s){ var e=document.querySelector(sel);' +
  '  if (!e) return false; return ((e.innerText||"") + " " + (e.textContent||"")).indexOf(s) >= 0; }' +
  'function btn(s){ return Array.prototype.slice.call(document.querySelectorAll("button"))' +
  '  .some(function(b){ return ((b.innerText||"").trim()) === s; }); }' +
  'var badge = document.querySelector(".spec-badge");' +
  'return {' +
  '  badge: badge ? (badge.innerText||"") : null,' +
  '  noHpBar: !document.querySelector(".hud-left .bar.hp"),' +
  '  lv: !!document.querySelector(".hud-left .hud-level"),' +
  '  followBtn: btn("切换视角"),' +
  '  followBtnDisabled: (function(){ var list = Array.prototype.slice.call(document.querySelectorAll("button"));' +
  '    var b = list.filter(function(x){ return ((x.innerText||"").trim()) === "切换视角"; })[0];' +
  '    return !!(b && b.disabled); })(),' +
  '  stopBtn: btn("退出观战"),' +
  '  followName: (function(){' +
  '    var d = document.querySelector(".spec-now");' +
  '    if (!d) return null;' +
  '    var b = d.querySelector("b");' +
  '    return b ? (b.innerText||"") : null;' +
  '  })(),' +
  '  dock: !!document.querySelector(".spec-dock")' +
  '};' +
  '})()';

// ============================================================
// 主流程
// ============================================================
async function main() {
  log('');
  log('=== 本轮改动端到端实测（' + BASE_URL + '） ===');

  await killByPort(CDP_PORT);
  const chrome = await launchChrome();
  log('无头浏览器已就绪');

  const A = await connect('甲');
  // 带 debug=1：跳游戏页时参数会带过去，那边才会挂 window.VS_GAME
  const URL = BASE_URL + '/?debug=1';

  // ---------------- [1] 进大厅 → 建房 → 单人开局 ----------------
  await A.send('Page.navigate', { url: URL });
  const ready = await waitFor(async function () {
    const r = await A.eval('(function(){var a=document.getElementById("app");return a?!a.hasAttribute("v-cloak"):null;})()');
    return r === true ? r : null;
  }, 12000, '页面渲染完成');
  expect('[1] 大厅页面渲染完成', ready === true, '12 秒内没渲染出来');

  await A.eval('(function(){' +
    'var inp = document.querySelector("input[placeholder=\'给自己起个名字\']");' +
    'if (inp) { inp.value = "测试甲"; inp.dispatchEvent(new Event("input", {bubbles:true})); }' +
    'return !!inp;' +
    '})()');
  await sleep(120);
  const okGuest = await A.eval(clickByText('以游客身份进入', false));
  expect('[1] 能点「以游客身份进入」', !!(okGuest && okGuest.ok), JSON.stringify(okGuest));

  const connOK = await waitFor(async function () {
    const r = await A.eval(LOBBY_STATE);
    return r && r.connText && r.connText.indexOf('已连接') >= 0 ? r : null;
  }, 12000, 'WebSocket 握手完成');
  expect('[1] WebSocket 已握手完成', !!connOK, '连接状态：' + (connOK && connOK.connText));

  const created = await A.eval(clickByText('创建房间', true));
  expect('[1] 能点「创建房间」', !!(created && created.ok), JSON.stringify(created));

  const inRoom = await waitFor(async function () {
    const r = await A.eval(LOBBY_STATE);
    return r && r.roomCode ? r : null;
  }, 10000, '进入候场室');
  expect('[1] 进入候场室并显示房间号', !!(inRoom && inRoom.roomCode), JSON.stringify(inRoom));
  let CODE = inRoom ? inRoom.roomCode : '';
  log('   房间号 = ' + CODE);

  // ---------------- [2b] 候场室里的邀请弹层 ----------------
  // 大厅页与对局页是两套模板、两个 openShare 实现，各验一遍才算数 ——
  // Vue 模板里字段名写错是**静默空白**，不报错，读代码看不出来。
  const lobbyShare = await A.evalAsync('(async function(){' +
    'var btn = Array.prototype.slice.call(document.querySelectorAll("button")).filter(function(b){ return (b.innerText||"").trim() === "邀请队友"; })[0];' +
    'if (!btn) return { noBtn: true, buttons: Array.prototype.slice.call(document.querySelectorAll("button")).map(function(b){ return (b.innerText||"").trim(); }) };' +
    'btn.click();' +
    'await Vue.nextTick();' +
    'await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });' +
    'var cv = document.getElementById("share-qr");' +
    'var dark = 0;' +
    'if (cv) { var d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;' +
    '  for (var i = 0; i < d.length; i += 4) { if (d[i] < 120) dark++; } }' +
    'return {' +
    '  mask: !!document.querySelector(".share-mask"),' +
    '  canvas: !!cv, dark: dark,' +
    '  url: (document.querySelector(".share-link")||{}).innerText || "",' +
    '  codeText: (document.querySelector(".share-code")||{}).innerText || ""' +
    '};' +
    '})()');
  expect('[2b] 候场室能开出邀请弹层', !!(lobbyShare && lobbyShare.mask), JSON.stringify(lobbyShare));
  expect('[2b] 候场室二维码真的画了内容（不是空 canvas）',
    !!(lobbyShare && lobbyShare.canvas && lobbyShare.dark > 500), 'dark=' + (lobbyShare && lobbyShare.dark));
  expect('[2b] 候场室邀请链接带上了房间号',
    !!(lobbyShare && lobbyShare.url.indexOf('?room=' + CODE) >= 0), 'url=' + (lobbyShare && lobbyShare.url));
  expect('[2b] 弹层上大号显示了房间号',
    !!(lobbyShare && lobbyShare.codeText.indexOf(CODE) >= 0), 'codeText=' + (lobbyShare && lobbyShare.codeText));
  await A.eval('(function(){' +
    'var b = Array.prototype.slice.call(document.querySelectorAll("button")).filter(function(x){ return (x.innerText||"").trim() === "关闭"; })[0];' +
    'if (b) b.click();' +
    'return true;' +
    '})()');
  await sleep(250);

  // ---------------- [1b] 候场室里断线也要能自动接回来 ----------------
  // 这是用户实际踩到的场景：掉线 → 一看界面是「未连接」，只能刷新页面。
  // 原来的重连逻辑只在 view === 'lobby' 时生效，人在候场室（view === 'room'）
  // 断线等于彻底不重连 —— 而候场室恰恰是最不能掉线的地方（队友在等你点准备）。
  const dropped = await A.eval('(function(){ window.VS_LOBBY.drop(); return window.VS_LOBBY.wsState; })()');
  expect('[1b] 能把候场室的连接掐断（模拟掉线）', dropped === 'retry' || dropped === 'off', 'wsState=' + dropped);

  const thinking = await waitFor(async function () {
    const r = await A.eval(LOBBY_STATE);
    return r && r.connText.indexOf('正在自动重连') >= 0 ? r : null;
  }, 5000, '界面显示正在自动重连');
  expect('[1b] 断线后界面写「正在自动重连（第 N 次）」而不是含糊的「未连接」', !!thinking,
    'connText=' + (thinking && thinking.connText));

  const reconnected = await waitFor(async function () {
    const r = await A.evalAsync('(async function(){ return { ws: window.VS_LOBBY.wsState, retry: window.VS_LOBBY.retry, view: window.VS_LOBBY.view }; })()');
    return r && r.ws === 'on' && r.retry === 0 ? r : null;
  }, 20000, '自动重连完成');
  expect('[1b] 断线后自己接回来了（不需要刷新页面）', !!reconnected, JSON.stringify(reconnected));

  const afterDrop = await A.eval(LOBBY_STATE);
  expect('[1b] 接回后界面恢复可用（连接状态回到「已连接」）',
    !!(afterDrop && afterDrop.connText.indexOf('已连接') >= 0), 'connText=' + (afterDrop && afterDrop.connText));
  // 【单人房的既定语义】房主离开 = 房间解散（manager.leaveRoom：房空了就销毁）。
  // 但「断线重连回来时房间还在不在」其实是个**竞态**，取决于服务端先处理哪一件事：
  //   · 本机（localhost，close 几乎立刻到达）：先处理断开 → 房间销毁 → 回来落在大厅
  //   · 线上（经过网关，重连的 room_join 可能先到）：房间还活着 → 他回到原来那间
  // 两种都说得通，而且线上那种（房间还在）对玩家其实更好。所以这里只断言
  // 「连接可用 + 界面处于一个合理的位置」，别把某一种结果写死 ——
  // 写死的话，本机过、线上挂，报的是产品 bug 的样子，实际是断言太死。
  const afterDropOk = !!(afterDrop && afterDrop.connText.indexOf('已连接') >= 0);
  const backInLobby = !!(afterDrop && !afterDrop.roomCode && afterDrop.buttons.indexOf('创建房间') >= 0);
  const backInRoom = !!(afterDrop && afterDrop.roomCode);
  expect('[1b] 接回后落在一个合理的位置（大厅或原房间，取决于断开与重连谁先到）',
    afterDropOk && (backInLobby || backInRoom),
    JSON.stringify(afterDrop && { room: afterDrop.roomCode, conn: afterDrop.connText }));
  log('   重连后位置：' + (backInRoom ? ('仍在房间 ' + afterDrop.roomCode) : '已回到大厅'));

  // ---------------- [1c] 重新开一桌，继续后面的流程 ----------------
  // 先确保站在大厅视图：「创建房间」按钮只在大厅有，在候场室里点它是静默失效
  if (backInRoom) {
    await A.eval(clickByText('离开房间', true));
    await waitFor(async function () {
      const r = await A.eval(LOBBY_STATE);
      return r && !r.roomCode ? r : null;
    }, 8000, '离开房间回到大厅');
  }
  await A.eval(clickByText('创建房间', true));
  const inRoom2 = await waitFor(async function () {
    const r = await A.eval(LOBBY_STATE);
    return r && r.roomCode && r.roomCode !== CODE ? r : null;
  }, 10000, '重新进入候场室');
  expect('[1c] 断线后能立刻重新开一桌', !!(inRoom2 && inRoom2.roomCode), JSON.stringify(inRoom2));
  CODE = inRoom2 ? inRoom2.roomCode : CODE;
  log('   新房间号 = ' + CODE);

  const started = await A.eval(clickByText('开始对局', false));
  expect('[1] 房主能点「开始对局」', !!(started && started.ok), JSON.stringify(started));

  const inGame = await waitFor(async function () {
    const r = await A.eval(GAME_STATE);
    if (!r || r.missing) return null;
    if (r.screen !== 'playing') return null;
    return r.snapCount > 5 ? r : null;
  }, 25000, '进入对局并收到快照');
  expect('[1] 单人房也能真的开局（收到快照）', !!inGame,
    JSON.stringify(await A.eval(GAME_STATE)));

  // ---------------- [2] 分享二维码 ----------------
  const opened = await A.eval('(function(){ window.VS_GAME.openShare(); return true; })()');
  await sleep(500);
  const share = await A.eval(GAME_STATE);
  expect('[2] 点分享后弹层出现', !!(opened && share && share.shareOpen), JSON.stringify(share && { open: share.shareOpen }));
  expect('[2] 弹层里真的画了二维码 canvas', !!(share && share.hasShareCanvas), 'canvas 没找到');
  expect('[2] 邀请链接带上了当前房间号',
    !!(share && share.shareUrl && share.shareUrl.indexOf('?room=' + CODE) >= 0),
    'url=' + (share && share.shareUrl));

  const qr = await A.eval(QR_VERIFY(CODE));
  expect('[2] 二维码库已加载', !!(qr && qr.lib), JSON.stringify(qr));
  expect('[2] canvas 点阵与库生成的矩阵逐点一致（画歪/缩放错都会被这条抓住）',
    !!(qr && qr.mismatch === 0), '不一致 ' + (qr && qr.mismatch) + ' 点 / 共 ' + (qr && qr.n) + ' 模块');
  expect('[2] 二维码留了静默区（不留白很多扫描器不认）', !!(qr && qr.quietDark === false), JSON.stringify(qr));
  await A.shot(SHARE_SHOT);

  await A.eval('(function(){ window.VS_GAME.ui.shareOpen = false; return true; })()');
  await sleep(200);

  // ---------------- [3] 联机阵亡倒计时层 ----------------
  // 真去死一次太慢（要站在怪堆里挨打），所以用调试钩子把「阵亡那一帧的 HUD」打进来。
  // 验的是界面这一层：该出现的出现、该显示的数字对、该收起的收起。
  // 【必须在一个表达式里等 Vue 更新完再读 DOM】服务端的 HUD 是 10Hz 持续下发的，
  // 拆成两次 eval 的话，中间那一帧就会把 state 覆盖回 playing，界面还没画出来就被抹平。
  const dead = await A.evalAsync('(async function(){' +
    // 第二个参数是预览窗口：让它压住 4 秒，读 DOM 才不会被服务端 HUD 抢跑
    'window.VS_GAME.fakeHud({ state:"dead", reviveLeft:4.2 }, 4000);' +
    'await Vue.nextTick();' +
    'await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });' +
    'var d = document.querySelector(".dead-dock");' +
    'var texts = Array.prototype.slice.call(document.querySelectorAll("button")).map(function(b){ return (b.innerText||"").trim(); });' +
    'var full = !!document.querySelector(".overlay:not(.overlay-dock)");' +
    'return { dock: !!d, text: d ? (d.innerText||"") : "", buttons: texts, fullOverlay: full };' +
    '})()');
  expect('[3] 阵亡后浮出倒计时层', !!(dead && dead.dock), JSON.stringify(dead));
  expect('[3] 倒计时层显示剩余秒数（4.2 → 5）',
    !!(dead && dead.text && dead.text.indexOf('5') >= 0 && dead.text.indexOf('复活') >= 0),
    'text=' + (dead && dead.text));
  expect('[3] 倒计时层不遮战场（联机不能弹全屏遮罩）', !!(dead && dead.fullOverlay === false),
    JSON.stringify(dead && { full: dead.fullOverlay }));
  await A.shot(DEAD_SHOT);

  const alive = await A.evalAsync('(async function(){' +
    // 窗口传 0：立刻把 HUD 交还给服务端，验「复活后倒计时层收起」
    'window.VS_GAME.fakeHud({ state:"playing", reviveLeft:0 }, 0);' +
    'await Vue.nextTick();' +
    'return { dock: !!document.querySelector(".dead-dock") };' +
    '})()');
  expect('[3] 复活后倒计时层收起', !!(alive && !alive.dock), JSON.stringify(alive));

  // 服务端的真实复活行为由 simtest / matchtest 断言（那边能精确制造致死伤害）；
  // 这里补一条界面上看得见的：整场打下来场上不该出现任何敌方子弹。
  const shots = await A.eval('(function(){ var w = window.VS_GAME.world; return w && w.enemyShots ? w.enemyShots.length : -1; })()');
  expect('[3] 场上没有任何敌方子弹（怪物不做远程）', shots === 0, '敌弹数=' + shots);

  // 渲染统计：等到怪物走进视口，取「本帧画了多少」。
  // 【为什么要等】开局那一波怪是在玩家周围 ~950px 的环上刷出来的，
  // 走路速度 42~78px/s，要好几秒才进得了视口 —— 刚开局就读统计必然是 0。
  // （这一点也解释了调试浮层上开局显示「绘制 0 / 0」是正常的，不是没画。）
  const statProbe = await A.evalAsync('(async function(){' +
    'var G = window.VS_GAME, best = { drawn: 0, total: 0, mobs: 0, waited: 0 };' +
    'for (var i = 0; i < 30; i++) {' +
    '  await new Promise(function(r){ setTimeout(r, 500); });' +
    '  best.waited = (i + 1) * 0.5;' +
    '  var m = (G.world && G.world.mobs) ? G.world.mobs.length : 0;' +
    '  if (G.stat.drawn > best.drawn) best = { drawn: G.stat.drawn, total: G.stat.total, mobs: m, waited: best.waited };' +
    '  if (best.drawn > 0 && m > 0) break;' +
    '}' +
    'return best;' +
    '})()');
  expect('[3] 联机下怪物真的被画到了画布上（渲染统计 > 0）',
    !!(statProbe && statProbe.drawn > 0), JSON.stringify(statProbe));

  // ---------------- [4] 掉线自动重连 ----------------
  const before = await A.eval(GAME_STATE);
  log('   断线前：tick 快照 ' + before.snapCount + ' 等级 ' + before.level + ' 击杀 ' + before.kills);

  await A.eval('(function(){ window.VS_GAME.dropNet(); return true; })()');
  // 重连提示条会在下一次重试前挂着；退避第一跳是 1 秒，所以要快采样
  let sawBanner = false;
  let bannerText = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 4000) {
    const r = await A.eval(GAME_STATE);
    if (r && r.retryBanner) { sawBanner = true; bannerText = r.retryText; if (!fs.existsSync(RETRY_SHOT)) await A.shot(RETRY_SHOT); break; }
    await sleep(120);
  }
  expect('[4] 断线后界面浮出「正在自动重连」提示条', sawBanner, '4 秒内没看到 .net-retry');
  expect('[4] 提示条写明是第几次重试', /第\s*\d+\s*次/.test(bannerText), 'text=' + bannerText);

  const back = await waitFor(async function () {
    const r = await A.eval(GAME_STATE);
    if (!r || !r.netWelcomed) return null;
    if (r.netRetry !== 0) return null;
    if (r.snapCount <= before.snapCount) return null;
    return r;
  }, 20000, '自动接回并继续收快照');
  expect('[4] 自己接回来了（不需要刷新页面）', !!back, JSON.stringify(await A.eval(GAME_STATE)));
  expect('[4] 接回后重试计数归零', !!(back && back.netRetry === 0), 'retry=' + (back && back.netRetry));
  expect('[4] 接回后快照继续增长（世界在往下走）',
    !!(back && back.snapCount > before.snapCount), before.snapCount + ' → ' + (back && back.snapCount));
  expect('[4] 接回后回到对局界面', !!(back && back.screen === 'playing'), 'screen=' + (back && back.screen));
  expect('[4] 重连提示条已消失', !!(back && !back.retryBanner), 'banner=' + (back && back.retryBanner));
  expect('[4] 进度没被清档（等级不倒退）', !!(back && back.level >= before.level),
    before.level + ' → ' + (back && back.level));
  expect('[4] 服务端确认接回了断线前的进度', A.said('已接回断线前进度'),
    '控制台里没找到「已接回断线前进度」');

  // ---------------- [5] 扫码进房 ----------------
  // 另一个标签页（模拟别人的手机）打开邀请链接：应当自动落进这一桌。
  const B = await connect('乙（扫码）');
  await B.send('Page.navigate', { url: BASE_URL + '/?room=' + CODE + '&debug=1' });
  const bReady = await waitFor(async function () {
    const r = await B.eval('(function(){var a=document.getElementById("app");return a?!a.hasAttribute("v-cloak"):null;})()');
    return r === true ? r : null;
  }, 12000, '乙 页面渲染完成');
  expect('[5] 扫码页（带 ?room=）能打开', bReady === true, '12 秒内没渲染出来');

  const hint = await B.eval('(function(){var e=document.querySelector(".msg");return e?(e.innerText||""):"";})()');
  expect('[5] 登录页提示了「正在加入房间」', !!(hint && hint.indexOf(CODE) >= 0), 'notice=' + hint);
  await B.eval('(function(){' +
    'var inp = document.querySelector("input[placeholder=\'给自己起个名字\']");' +
    'if (inp) { inp.value = "扫码乙"; inp.dispatchEvent(new Event("input", {bubbles:true})); }' +
    'return !!inp;' +
    '})()');
  await sleep(120);
  await B.eval(clickByText('以游客身份进入', false));

  // 这一桌正在对局中（state=playing），所以扫码进来的人不会被留在候场室，
  // 大厅收到 game_start 后会直接把他送到 game.html —— 断言要落在这里。
  const bJoined = await waitFor(async function () {
    const r = await B.eval(GAME_STATE);
    if (!r || r.missing) return null;
    if (r.screen !== 'playing') return null;
    return r.players >= 2 ? r : null;
  }, 25000, '乙 落到对局里');
  expect('[5] 扫码后直接落到这一局（不用手输房间号）', !!bJoined,
    JSON.stringify(await B.eval(GAME_STATE)));
  expect('[5] 乙 的世界里能看到 2 个人（真的进了同一个世界）',
    !!(bJoined && bJoined.players >= 2), 'players=' + (bJoined && bJoined.players));
  expect('[5] 乙 进的就是邀请链接里那个房间',
    !!(bJoined && bJoined.roomCode === CODE), 'code=' + (bJoined && bJoined.roomCode));

  const hostSees2 = await waitFor(async function () {
    const r = await A.eval(GAME_STATE);
    return r && r.players >= 2 ? r : null;
  }, 15000, '甲 看到人数变 2');
  expect('[5] 甲的对局里立刻多了一个人（中途加入生效）', !!hostSees2,
    'players=' + (hostSees2 && hostSees2.players));

  // ---------------- [7] 结算面板的全队战绩 ----------------
  // 结算包里的 result 是服务端算好的（含各人击杀/金币/等级，中途退出的也在里面），
  // 前端以前只显示自己那一份 hud。这里塞一份样本渲染一遍 ——
  // 真打完一局要 20 分钟，等不起；而「Vue 模板字段名写错 = 静默空白」这条只能靠渲染验。
  const teamPanel = await A.evalAsync('(async function(){' +
    'var G = window.VS_GAME;' +
    'G.ui.resultList = [' +
    '  { slot: 0, name: "测试甲", kills: 33, gold: 120, level: 7, left: false },' +
    '  { slot: 1, name: "扫码乙", kills: 12, gold: 40, level: 4, left: true }' +
    '];' +
    'G.ui.screen = "result";' +
    'await Vue.nextTick();' +
    'var rows = Array.prototype.slice.call(document.querySelectorAll(".result-team .rt-row"));' +
    'return {' +
    '  panel: !!document.querySelector(".result-team"),' +
    '  rows: rows.length,' +
    '  meMarked: rows.filter(function(r){ return r.className.indexOf("me") >= 0; }).length,' +
    '  leftMarked: rows.filter(function(r){ return r.className.indexOf("left") >= 0; }).length,' +
    '  text: rows.map(function(r){ return (r.innerText || "").replace(/\\s+/g, " ").trim(); })' +
    '};' +
    '})()');
  expect('[7] 结算面板出现全队战绩表', !!(teamPanel && teamPanel.panel), JSON.stringify(teamPanel));
  expect('[7] 表里有两行（一人一行）', !!(teamPanel && teamPanel.rows === 2), JSON.stringify(teamPanel));
  expect('[7] 「我」那一行被高亮出来', !!(teamPanel && teamPanel.meMarked === 1),
    JSON.stringify(teamPanel && teamPanel.meMarked));
  expect('[7] 中途退出的队友被标成「已离开」', !!(teamPanel && teamPanel.leftMarked === 1),
    JSON.stringify(teamPanel && teamPanel.text));
  expect('[7] 每行都带上了击杀与金币数字',
    !!(teamPanel && teamPanel.text.join('|').indexOf('33') >= 0 &&
      teamPanel.text.join('|').indexOf('120') >= 0 && teamPanel.text.join('|').indexOf('12') >= 0),
    JSON.stringify(teamPanel && teamPanel.text));
  await A.shot(TEAM_SHOT);

  // 恢复界面，别把后面的断言带歪
  await A.evalAsync('(async function(){ window.VS_GAME.ui.screen = "playing"; await Vue.nextTick(); return true; })()');

  // ---------------- [10] 对局难度：候场室选择器 + 单人游戏不该误入联机 ----------------
  // 这一节用一个新标签页，因为前面两个标签页都已经在「对局中」了，
  // 而难度选择器只在候场室出现（房间状态是开局后就锁死的）。
  const D = await connect('丁（难度）');
  const LOBBY_URL = BASE_URL + '/?debug=1';
  await D.send('Page.navigate', { url: LOBBY_URL });
  await waitFor(async function () {
    const r = await D.eval('(function(){var a=document.getElementById("app");return a?!a.hasAttribute("v-cloak"):null;})()');
    return r === true ? r : null;
  }, 12000, '丁 页面渲染完成');
  // 【必须重置难度偏好再往下走】这个无头浏览器用的是固定 profile，
  // 「上次选的难度」会跨运行留下来 —— 第二次跑的时候房间建出来就是「血月」，
  // 「默认选中普通」那条断言会假失败。（第一次跑就踩了：失败信息是 active=血月，
  // 但那恰恰说明「记住偏好」这个功能是好的。测试自己得先把环境清零。）
  await D.eval('(function(){ localStorage.removeItem("vs_diff"); return true; })()');
  await D.send('Page.navigate', { url: LOBBY_URL });
  await waitFor(async function () {
    const r = await D.eval('(function(){var a=document.getElementById("app");return a?!a.hasAttribute("v-cloak"):null;})()');
    return r === true ? r : null;
  }, 12000, '丁 重新渲染（偏好已清）');

  await D.eval('(function(){' +
    'var inp = document.querySelector("input[placeholder=\'给自己起个名字\']");' +
    'if (inp) { inp.value = "难度丁"; inp.dispatchEvent(new Event("input", {bubbles:true})); }' +
    'return !!inp;' +
    '})()');
  await sleep(120);
  await D.eval(clickByText('以游客身份进入', false));
  await waitFor(async function () {
    const r = await D.eval(LOBBY_STATE);
    return r && r.connText && r.connText.indexOf('已连接') >= 0 ? r : null;
  }, 12000, '丁 握手完成');

  // ---------------- [9] 连接日志：要看得见，而且真的记下发生了什么 ----------------
  // 这一节是用户直接提的需求：出问题时界面上只有一句「未连接」，看不到任何原因，
  // 只能截图问人。所以日志必须 ① 默认就在（不依赖 ?debug=1）② 记的是时间线 ③ 能复制。
  const logInit = await D.eval(CONN_LOG);
  expect('[9] 握手完成后连接日志里已有记录', !!(logInit && logInit.count >= 2),
    JSON.stringify(logInit && { count: logInit.count, texts: logInit.texts }));
  expect('[9] 记录了「连接已建立」与「握手完成」两个节点',
    !!(logInit && logInit.joined.indexOf('连接已建立') >= 0 && logInit.joined.indexOf('握手完成') >= 0),
    logInit && logInit.joined);
  expect('[9] 每条都带时间戳（HH:MM:SS）',
    !!(logInit && logInit.atOk), JSON.stringify(logInit && logInit.times));

  // 面板默认是收起的（平时不占地方），点一下要能展开
  const beforeOpen = await D.eval('(function(){ return !!document.querySelector(".connlog-panel"); })()');
  expect('[9] 面板默认收起（不占地方）', beforeOpen === false, 'panel=' + beforeOpen);
  await D.eval(clickByText('连接日志', false));
  const logOpen = await waitFor(async function () {
    const r = await D.eval(CONN_LOG);
    return r && r.panelOpen && r.rows > 0 ? r : null;
  }, 6000, '连接日志面板展开');
  expect('[9] 点一下能展开并列出记录', !!logOpen,
    JSON.stringify(await D.eval(CONN_LOG)));
  expect('[9] 行数与记录数一致（没有漏渲染）',
    !!(logOpen && logOpen.rows === logOpen.count), JSON.stringify(logOpen && { rows: logOpen.rows, count: logOpen.count }));
  await D.shot(CONNLOG_SHOT);

  // 复制按钮：拿不到剪贴板也必须给出反馈，不能点了没反应
  await D.eval(clickByText('复制全部', true));
  await sleep(600);
  const copyMsg = await D.eval('(function(){ var e=document.querySelector(".msg"); return e?(e.innerText||""):""; })()');
  expect('[9] 点「复制全部」有明确反馈',
    !!(copyMsg && (copyMsg.indexOf('复制') >= 0 || copyMsg.indexOf('连接日志') >= 0)),
    'notice=' + copyMsg);

  // 走一次**真实断线**的路径（不摘 onclose，等价于服务端主动断开 / 网络掉线）。
  // 这里不能用 drop()：它会先 closeWs 把 onclose 摘掉，那条路径上的日志根本不会产生。
  await D.eval('(function(){ window.VS_LOBBY.hardDrop(); return true; })()');
  const dropped2 = await waitFor(async function () {
    const r = await D.eval(CONN_LOG);
    return r && r.joined.indexOf('连接已关闭') >= 0 ? r : null;
  }, 6000, '断线被记进日志');
  expect('[9] 真实断线后日志记下「连接已关闭」', !!dropped2,
    dropped2 && dropped2.joined);
  expect('[9] 并记下「将在 N 秒后重连」（能看出它在自愈）',
    !!(dropped2 && dropped2.joined.indexOf('后重连') >= 0), dropped2 && dropped2.joined);
  expect('[9] 异常条数被计入角标（收起时也能看出出过问题）',
    !!(dropped2 && dropped2.badCount >= 1), '角标=' + (dropped2 && dropped2.badCount));

  const beforeCount = (dropped2 && dropped2.handshakeCount) || 0;
  const backOk = await waitFor(async function () {
    const r = await D.eval(CONN_LOG);
    // 用「握手完成的条数比断线前多」来判断，而不是写死一个数字 ——
    // 前面重连过几次会随环境不同而变，写死必然假失败
    return r && r.wsState === 'on' && r.handshakeCount > beforeCount ? r : null;
  }, 20000, '重连后再次记下握手完成');
  expect('[9] 自己接回来之后，日志里又添了一条「握手完成」', !!backOk,
    '断线前 ' + beforeCount + ' 条，现在 ' + (await D.eval(CONN_LOG)).handshakeCount + ' 条');
  await D.eval(clickByText('收起', false));
  // 收起之后按钮上要能看出「出过事」（展开时显示的是「收起连接日志」，所以这条得放在收起之后）
  const collapsed = await D.eval(CONN_LOG);
  expect('[9] 收起后按钮文案带上异常条数（不用展开就知道出过事）',
    !!(collapsed && collapsed.toggleText.indexOf('条异常') >= 0),
    '按钮=' + (collapsed && collapsed.toggleText));
  expect('[9] 收起后按钮里仍显示当前连接状态',
    !!(collapsed && collapsed.toggleText.indexOf('已连接') >= 0),
    '按钮=' + (collapsed && collapsed.toggleText));

  await D.eval(clickByText('创建房间', true));
  const diffUi = await waitFor(async function () {
    const r = await D.eval(DIFF_UI);
    return r && r.count > 0 ? r : null;
  }, 10000, '难度选择器出现');
  expect('[10] 候场室出现难度选择器', !!(diffUi && diffUi.count === 4),
    JSON.stringify(diffUi));
  expect('[10] 四档名称齐全（休闲/普通/噩梦/血月）',
    !!(diffUi && diffUi.names.join(',') === '休闲,普通,噩梦,血月'),
    JSON.stringify(diffUi && diffUi.names));
  expect('[10] 默认选中「普通」', !!(diffUi && diffUi.active === '普通'),
    'active=' + (diffUi && diffUi.active));
  expect('[10] 房主可选（按钮不是禁用的）', !!(diffUi && diffUi.disabledCount === 0),
    '禁用了 ' + (diffUi && diffUi.disabledCount) + ' 个');

  // 点「血月」：选中态要跟着走，并且记成偏好（下次建房直接用它）
  await D.evalAsync('(async function(){' +
    'var b = Array.prototype.slice.call(document.querySelectorAll(".diff-btn:not(.map-btn)")).filter(function(x){' +
    '  return (x.innerText||"").indexOf("血月") === 0; })[0];' +
    'if (b) b.click();' +
    'await new Promise(function(r){ setTimeout(r, 600); });' +
    'return true;' +
    '})()');
  const picked = await D.eval(DIFF_UI);
  expect('[10] 点「血月」后选中态切过去', !!(picked && picked.active === '血月'),
    'active=' + (picked && picked.active));
  const pref = await D.eval('(function(){ return localStorage.getItem("vs_diff") || ""; })()');
  expect('[10] 难度被记成偏好（下次建房省一步）', pref === 'bloodmoon', 'vs_diff=' + pref);

  // 【回归】单人游戏必须清掉上一局联机的残留。
  // 先离开房间回到大厅 —— 「单人游戏」按钮只在大厅视图里，候场室是没有的
  // （第一次写就在这里踩空：按钮找不到，点击静默失效，断言看起来像功能坏了）。
  await D.eval(clickByText('离开房间', true));
  await waitFor(async function () {
    const r = await D.eval('(function(){ return document.querySelector(".room-code-big") ? false : true; })()');
    return r === true ? r : null;
  }, 6000, '丁 回到大厅');

  // 手动塞一个 vs_match 模拟「刚打完一局联机」，再点「单人游戏」——
  // 清不掉的话游戏页会把自己当成联机局，去连一个已经不存在的房间。
  await D.eval('(function(){ sessionStorage.setItem("vs_match", JSON.stringify({ roomCode: "ZZZZ", charId: "hunter" })); return true; })()');
  const clickedSingle = await D.eval(clickByText('单人游戏', true));
  expect('[10] 大厅里能找到「单人游戏」按钮', !!(clickedSingle && clickedSingle.ok),
    JSON.stringify(clickedSingle));

  const onGamePage = await waitFor(async function () {
    // ★同时认 /game 与 /game.html：第十七轮加了 History API，玩家侧地址是 /game，
    //   而 /game.html 刻意保留（测试脚本与老书签都靠它）。只认一个都会误报。
    const r = await D.eval('(function(){ return /^\\/game(\\.html)?$/.test(location.pathname) ? true : null; })()');
    return r === true ? r : null;
  }, 12000, '丁 跳到游戏页');
  expect('[10] 点「单人游戏」跳到了游戏页', !!onGamePage,
    '当前地址=' + (await D.eval('(function(){ return location.href; })()')));

  const leftover = await D.eval('(function(){ return sessionStorage.getItem("vs_match"); })()');
  expect('[10] 联机残留的 vs_match 被清掉了（键名笔误回归）', !leftover,
    'vs_match=' + leftover);

  // ---------------- [11] 宝箱渲染：真的画到画布上了 ----------------
  // 逻辑层（掉宝箱、不被磁石吸、拾取给升级）由 simtest 断言；
  // 这里只验「画出来了」——它是个全新图元，尺寸算错会被精灵图裁剪，静默不报错。
  //
  // 重新用带 debug=1 的地址打开：单人游戏按钮跳的是干净的 /game.html，
  // 那个页面按设计不挂 window.VS_GAME（调试句柄只在 ?debug=1 时挂）。
  await D.send('Page.navigate', { url: BASE_URL + '/game.html?debug=1' });
  await waitFor(async function () {
    const r = await D.eval('(function(){ return window.VS_GAME ? true : null; })()');
    return r === true ? r : null;
  }, 12000, '丁 游戏页调试句柄就绪');
  const offState = await D.eval(GAME_STATE);
  expect('[11] 直接打开 /game.html 是单机模式（没有房间号就本地跑）',
    !!(offState && offState.online === false), 'online=' + (offState && offState.online));

  await D.eval('(function(){ window.VS_GAME.start(); return true; })()');
  const playing = await waitFor(async function () {
    const r = await D.eval(GAME_STATE);
    return r && r.screen === 'playing' ? r : null;
  }, 10000, '丁 单机对局开始');
  expect('[11] 单机能开始一局', !!playing, JSON.stringify(await D.eval(GAME_STATE)));

  // 采样两次、前后一比。
  // 【为什么不用「暂停」来冻结世界】单机的暂停会把「已暂停」菜单铺满屏幕，
  // 截图里根本看不到战场 —— 而这一节既要断言、也想留一张能给人看的图。
  // 开局最初那零点几秒本来就没什么变化（怪还在 700px 外的生成环上走，
  // 没有击杀就没有新掉落物），前后两次采样之间只有宝箱是变量。
  const amberBefore = await D.eval(AMBER_PROBE);
  await D.eval('(function(){' +
    'var G = window.VS_GAME, w = G.world, p = w.player;' +
    // 放在玩家右边一点：相机以玩家为中心，这个位置一定在屏幕内
    'w.pickups.push({ id: 999001, kind: "chest", x: p.x + 110, y: p.y, px: p.x + 110, py: p.y,' +
    '  value: 1, vx: 0, vy: 0, life: 120 });' +
    'return w.pickups.length;' +
    '})()');
  await sleep(400);
  const amberAfter = await D.eval(AMBER_PROBE);
  expect('[11] 宝箱被真的画到画布上（琥珀金描边像素明显增加）',
    !!(amberBefore && amberAfter && amberAfter.amber > amberBefore.amber + 120),
    '前 ' + (amberBefore && amberBefore.amber) + ' -> 后 ' + (amberAfter && amberAfter.amber));
  await D.shot(CHEST_SHOT);

  // ---------------- [12] 双窗口头像隔离（用户实测踩到的回归） ----------------
  // 症状：两个窗口各选了不同图标，进对局后两人头顶的图标却一样。
  // 根因：头像存在 localStorage['vs_avatar']，而 localStorage 是**同一浏览器
  // 所有标签页共享**的 —— 同机双开对测（最常见的测法）时后选的会覆盖前一个，
  // 两人跳进对局时握手都上报同一个 id。与昵称/角色走过的坑完全同类。
  // 这条必须用**同一个浏览器里的两个真实标签页**来验：WS 层的脚本（avatartest）
  // 绕过了浏览器存储，永远测不出这个 bug。
  const E = await connect('戊（头像）');
  const F = await connect('己（头像）');
  const LOBBY_URL2 = BASE_URL + '/?debug=1';

  async function enterLobby(page, nick) {
    await page.send('Page.navigate', { url: LOBBY_URL2 });
    await waitFor(async function () {
      const r = await page.eval('(function(){var a=document.getElementById("app");return a?!a.hasAttribute("v-cloak"):null;})()');
      return r === true ? r : null;
    }, 12000, nick + ' 页面渲染完成');
    // 【为什么先清 vs_profile】无头浏览器用的是固定 profile，localStorage 跨运行共享。
    // 登录页会拿上次记住的昵称把输入框预填上，而游客昵称一旦与已存在的身份重名，
    // 服务端按身份键（userId 优先、其次昵称）会把两个标签页认成**同一个人** ——
    // 本轮观战用例就踩了这个：P1 顶着「测试甲」建房，结果与 A 是同一人，
    // A 一断开就把 P1 的世界一起带走了（表现为 MATCH_EMPTY），极难定位。
    // 写进文档：凡是要开「第二个独立玩家」的用例，进大厅前必须先清这一项。
    await page.eval('(function(){ try { localStorage.removeItem("vs_profile"); } catch(e){} return true; })()');
    await page.eval('(function(){' +
      'var inp = document.querySelector("input[placeholder=\'给自己起个名字\']");' +
      'if (inp) { inp.value = ' + JSON.stringify(nick) + '; inp.dispatchEvent(new Event("input", {bubbles:true})); }' +
      'return inp ? inp.value : "(没找到输入框)"; })()');
    await sleep(150);
    await page.eval(clickByText('以游客身份进入', false));
    await waitFor(async function () {
      const r = await page.eval(LOBBY_STATE);
      return r && r.connText && r.connText.indexOf('已连接') >= 0 ? r : null;
    }, 12000, nick + ' 握手完成');
  }

  // 点某个头像按钮（按钮的 title 就是图标名，如「残月」「晨星」）
  // 【选择器要整体 JSON 化】拼成 '.avatar-btn[title="残月"]' 后整串 stringify 再塞进表达式；
  // 直接把名字 stringify 进去会写出 querySelector(".avatar-btn[title="残月"]") ——
  // 双引号把外层字符串截断，整条表达式语法错误、eval 静默返回 null（第一次写就栽在这）。
  function pickAvatarByTitle(name) {
    const sel = '.avatar-btn[title="' + name + '"]';
    return '(function(){' +
      'var b = document.querySelector(' + JSON.stringify(sel) + ');' +
      'if (!b) return { ok: false, titles: Array.prototype.slice.call(document.querySelectorAll(".avatar-btn")).map(function(x){ return x.title; }) };' +
      'b.click();' +
      'return { ok: true };' +
      '})()';
  }

  await enterLobby(E, '头像戊');
  await enterLobby(F, '头像己');

  await E.eval(clickByText('创建房间', true));
  const eRoom = await waitFor(async function () {
    const r = await E.eval(LOBBY_STATE);
    return r && r.roomCode ? r : null;
  }, 10000, '戊 进入候场室');
  const CODE2 = eRoom ? eRoom.roomCode : '';
  log('   第二个房间号 = ' + CODE2);

  const pickE = await E.eval(pickAvatarByTitle('残月'));
  expect('[12] 戊 能在候场室里点「残月」', !!(pickE && pickE.ok), JSON.stringify(pickE));
  await sleep(700);

  // 点一下**别的**头像，确认控件本身是活的（选中态会跟着走）。
  // 注意点完要切回残月 —— 这一步会改状态，忘了切回去后面「戊 看到的是残月」就会假失败。
  await E.eval('(function(){ var b=document.querySelector(\'.avatar-btn[title="铁盾"]\'); if (b) b.click(); return !!b; })()');
  await sleep(500);
  const clickProbe = await E.eval('(function(){ var a=document.querySelector(".avatar-btn.active"); return a?a.title:null; })()');
  expect('[12] 点击头像按钮真的会切换选中态（控件本身可用）', clickProbe === '铁盾',
    '点「铁盾」后选中=' + clickProbe);
  await E.eval(pickAvatarByTitle('残月'));
  await sleep(500);

  // 关键一步：这一路操作必须真的落到本窗口的存储里。
  // 【为什么值得单独断言】这条曾经全线静默失败 —— 模块里的 save() 因为闭包里
  // 取不到 window（见 shared/avatars.js 的说明）抛 ReferenceError，又被 catch 吞掉：
  // 界面上选中态照常变化，但什么都没存下来，刷新就回默认值、进对局还会和队友撞图标。
  const justAfterE = await E.eval('(function(){' +
    'var act = document.querySelector(".avatar-btn.active");' +
    'return { s: sessionStorage.getItem("vs_avatar"), l: localStorage.getItem("vs_avatar"),' +
    '  active: act ? act.title : null }; })()');
  expect('[12] 点头像会真的写进本窗口的 sessionStorage（不是只改界面）',
    !!(justAfterE && justAfterE.s === 'moon' && justAfterE.active === '残月'),
    JSON.stringify(justAfterE));

  // 己 用邀请链接进同一桌（顺带复用扫码进房那条路径）
  await F.send('Page.navigate', { url: BASE_URL + '/?room=' + CODE2 + '&debug=1' });
  await waitFor(async function () {
    const r = await F.eval('(function(){var a=document.getElementById("app");return a?!a.hasAttribute("v-cloak"):null;})()');
    return r === true ? r : null;
  }, 12000, '己 页面渲染完成');
  await F.eval('(function(){' +
    'var inp = document.querySelector("input[placeholder=\'给自己起个名字\']");' +
    'if (inp) { inp.value = "头像己"; inp.dispatchEvent(new Event("input", {bubbles:true})); } return true; })()');
  await sleep(150);
  await F.eval(clickByText('以游客身份进入', false));
  const fInRoom = await waitFor(async function () {
    const r = await F.eval(LOBBY_STATE);
    return r && r.roomCode === CODE2 ? r : null;
  }, 15000, '己 落进这一桌');
  expect('[12] 己 通过邀请链接进了同一桌', !!fInRoom,
    JSON.stringify(await F.eval(LOBBY_STATE)));

  const pickF = await F.eval(pickAvatarByTitle('晨星'));
  expect('[12] 己 能在候场室里点「晨星」', !!(pickF && pickF.ok), JSON.stringify(pickF));
  await sleep(700);

  // 关键一步：两个窗口现在选的是不同的头像。看它们在浏览器存储里到底各存了什么。
  const storeE = await E.eval('(function(){ return { s: sessionStorage.getItem("vs_avatar"), l: localStorage.getItem("vs_avatar") }; })()');
  const storeF = await F.eval('(function(){ return { s: sessionStorage.getItem("vs_avatar"), l: localStorage.getItem("vs_avatar") }; })()');
  expect('[12] 各窗口的 sessionStorage 里是各自选的头像（这才是每窗口身份）',
    !!(storeE && storeF && storeE.s === 'moon' && storeF.s === 'star'),
    '戊=' + JSON.stringify(storeE) + ' 己=' + JSON.stringify(storeF));
  expect('[12] localStorage 只有一个值（正是它会串号的原因，只能用来看偏好）',
    !!(storeE && storeF && storeE.l === storeF.l && storeE.l === 'star'),
    '戊=' + (storeE && storeE.l) + ' 己=' + (storeF && storeF.l));

  // 开打
  await F.eval(clickByText('准备', true));
  await sleep(700);
  await E.eval(clickByText('开始对局', false));

  await waitFor(async function () {
    const r = await E.eval(GAME_STATE);
    return r && r.screen === 'playing' && r.players >= 2 ? r : null;
  }, 25000, '戊 进入对局');
  await waitFor(async function () {
    const r = await F.eval(GAME_STATE);
    return r && r.screen === 'playing' && r.players >= 2 ? r : null;
  }, 25000, '己 进入对局');

  const rosterE = await E.eval(ROSTER_AV);
  const rosterF = await F.eval(ROSTER_AV);
  expect('[12] 戊 的对局名单里两人头像不同（这就是本次要修的 bug）',
    !!(rosterE && rosterE.n === 2 && rosterE.avatars[0] !== rosterE.avatars[1]),
    JSON.stringify(rosterE));
  expect('[12] 己 那边看到的也是同样两个不同头像',
    !!(rosterF && rosterF.n === 2 && rosterF.avatars[0] !== rosterF.avatars[1]),
    JSON.stringify(rosterF));
  expect('[12] 戊 看到的是 残月 + 晨星（按座位号 0/1 排）',
    !!(rosterE && rosterE.avatars[0] === 'moon' && rosterE.avatars[1] === 'star'),
    JSON.stringify(rosterE));
  expect('[12] 己 看到的与 戊 完全一致（两人对同一份名单的认知必须相同）',
    !!(rosterE && rosterF && rosterE.avatars.join(',') === rosterF.avatars.join(',')),
    JSON.stringify(rosterF));

  // 对局里两人看到的必须是同一份名单（每人各自渲染，谁都不该「看花眼」）
  await E.shot(AVATAR2_SHOT);

  // ---------------- [13] 观战界面验证：已移到 tools/specui.js ----------------
  // 【为什么从 netcheck 里搬出来】netcheck 前面有 20 多条用例，跑了十几分钟，
  // 期间会开过好几桌、又先后结束。观战用例要在大厅里点「进行中」那张桌的按钮，
  // 点到哪一桌取决于当时谁还活着 —— 同一条断言在两轮里点到不同的桌子，
  // 一轮过一轮不过，看起来像功能坏了，实际是测试环境的状态依赖。
  // 独立脚本自己开一桌、只开一桌，状态完全可控。

  // ---------------- [8] 登录态失效：要停下来，不能无限转圈重连 ----------------
  // 【为什么必须验】服务端遇到坏 token 会回 BAD_TOKEN 并关连接；如果客户端只会
  // 「断了就重连」，就会变成 连上→被拒→再连 的死循环：界面上永远在「正在自动重连（第 N 次）」，
  // 看着像网络问题，其实是账号状态问题，怎么等都不会好。
  // 这一条只能放在最后：它会把本地 token 清掉，后面的用例就没法连了。
  await A.eval('(function(){ localStorage.setItem("vs_token", "f".repeat(64)); return true; })()');
  await A.eval('(function(){ window.VS_GAME.dropNet(); return true; })()');

  const badToken = await waitFor(async function () {
    const r = await A.eval(GAME_STATE);
    return (r && r.netErr && r.netErr.indexOf('登录状态已失效') >= 0) ? r : null;
  }, 15000, '界面提示登录失效');
  expect('[8] 失效 token 时明确提示「登录状态已失效」', !!badToken,
    JSON.stringify((await A.eval(GAME_STATE)) || null));
  expect('[8] 连接状态被标成终止（failed），不再是「连接中」',
    !!(badToken && badToken.netState === 'failed'), 'netState=' + (badToken && badToken.netState));

  // 再等两个退避周期，确认它真的停下来了（原来会一直重连下去）
  await sleep(6000);
  const settled = await A.eval(GAME_STATE);
  expect('[8] 停止自动重连（重试计数归零、不挂重连提示条）',
    !!(settled && settled.netRetry === 0 && !settled.retryBanner),
    JSON.stringify(settled && { retry: settled.netRetry, banner: settled.retryBanner }));
  const tok = await A.eval('(function(){ return localStorage.getItem("vs_token") || ""; })()');
  expect('[8] 本地那个失效的 token 已被清掉（免得下次还拿它连）', tok === '', 'token=' + tok);

  // ---------------- 收尾：零未捕获异常 ----------------
  expect('[6] 甲 页面零未捕获异常', A.pageErrors.length === 0, A.pageErrors.join(' | '));
  expect('[6] 乙 页面零未捕获异常', B.pageErrors.length === 0, B.pageErrors.join(' | '));

  // 失败时把控制台尾部打出来，省得再复跑一次才知道原因
  if (fail > 0) {
    log('');
    log('--- 甲 控制台尾部 ---');
    A.consoleLogs.slice(-25).forEach(function (l) { log('   ' + l); });
  }

  try { chrome.kill(); } catch (e) { /* 收尾失败不影响结论 */ }

  log('');
  log('=== 汇总 ===');
  log('  PASS  ' + pass);
  log('  FAIL  ' + fail);
  log('  截图：' + SHARE_SHOT + ' / ' + DEAD_SHOT + ' / ' + RETRY_SHOT + ' / ' + TEAM_SHOT + ' / ' + SPEC_SHOT);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  log('脚本异常：' + (e && e.stack || e));
  process.exit(1);
});
