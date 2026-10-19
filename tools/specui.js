// tools/specui.js —— 观战模式的**界面**端到端实测（真实浏览器 + 真实 WebSocket）
//
// 【为什么观战要拆成两个脚本】spectest.js 验的是「观战不影响这一局」这条硬边界
// （纯 WS，不开页面）；这里验的是界面那一半：点「观战」能不能进游戏页、
// 进去之后 HUD 是不是真的换成了观战形态、按钮能不能点。
// 裸 WS 脚本连游戏页都没打开过，模板引用了不存在的字段它一个都测不出来。
//
// 【为什么必须独立于 netcheck】netcheck 前面二十多条用例跑了十几分钟，
// 期间会开过好几桌又先后结束。观战要在大厅点「进行中」那张桌的按钮，
// 点到哪一桌取决于当时谁还活着 —— 同一条断言两轮里点到不同的桌子，
// 一轮过一轮不过，看着像功能坏了，实际是测试环境的状态依赖。
// 这个脚本自己开一桌、只开一桌，状态完全可控。
//
// 覆盖：
//   [1] 玩家开一桌并进入对局
//   [2] 大厅里「进行中」的那一桌有「观战」按钮，点击跳到游戏页
//   [3] 观战者拿到 selfSlot=-1 / spectating 标记 / 跟随目标，且名单里没有他自己
//   [4] 界面换成观战形态：不画血条与武器栏、显示「观战中 · 跟着谁」、底部有控制条
//   [5] 玩家那边完全不受影响（世界照跑、名单没变、玩家没被踢）
//   [6] 「切换视角」按钮在只有一个人可跟时是禁用而非消失
//   [7] 「退出观战」回大厅并清掉 vs_spec 残留
//
// ★**跑之前要有一个「干净」的服务器**：上一轮 netcheck 之类跑完会留下还在进行中的桌子
//   （对局挂起 60 秒、房间保留 90 秒），而本脚本要点大厅里「进行中」那张桌的按钮 ——
//   点到哪一桌取决于当时谁还活着。同一条断言在两种状态下会得到不同结果：
//   点到别人那桌（2 人）时「切换视角」是可用的，点到自己这桌（1 人）时是禁用的。
//   所以**别和 netcheck / roomcheck 连着跑**，中间等 90 秒以上，或者重启服务。
//   （这条不是产品问题，是浏览器脚本的环境依赖；`spectest.js` 没这个依赖，
//     任何状态下都能跑 —— 需要「硬边界」的验证用那个。）
//
// 用法：node tools/specui.js [端口或完整地址]
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ARG = String(process.argv[2] || 3000);
const BASE_URL = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9337;                  // 独立端口：别与 netcheck(9336) / gamecheck(9333) 撞车
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_specui_profile';
const SPEC_SHOT = TMP + '/vs_specui_spectating.png';
const LOG = TMP + '/vs_specui.log';
const LOBBY_URL2 = BASE_URL + '/?debug=1';


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
  'var btns = Array.prototype.slice.call(document.querySelectorAll(".diff-btn"));' +
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
  // 观战者不该出现的元素，一律用 no* 语义（true = 确实没画）。
  // 【为什么不用正向的 lv/slots】两种命名混在一个探针里必然有人写反 ——
  // 断言里再取反一次就成了「元素必须在」，与意图正好相反，而且照样显示 PASS/FAIL，
  // 看不出是断言写错了。统一成 no* 之后，看到字段名就知道该期望什么。
  '  noExpBar: !document.querySelector(".hud-left .bar.exp"),' +
  '  noLevel: !document.querySelector(".hud-left .hud-level"),' +
  '  noSlots: !document.querySelector(".hud-slots"),' +
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
  '  dock: !!document.querySelector(".spec-dock"),' +
  '  noKillStat: !(function(){ var l = Array.prototype.slice.call(document.querySelectorAll(".hud-right .stat"));' +
  '    return l.some(function(x){ return ((x.innerText||"").indexOf("击杀") >= 0); }); })(),' +
  '  specNote: (function(){ var l = Array.prototype.slice.call(document.querySelectorAll(".hud-right .stat"));' +
  '    for (var i=0;i<l.length;i++){ if ((l[i].innerText||"").indexOf("观战者") >= 0) return l[i].innerText||""; }' +
  '    return null; })(),' +
  '  debugSaysNoMove: (function(){ var l = Array.prototype.slice.call(document.querySelectorAll(".kbd-hint"));' +
  '    for (var i=0;i<l.length;i++){ if ((l[i].innerText||"").indexOf("观战") >= 0) return l[i].innerText||""; }' +
  '    return null; })()' +
  '};' +
  '})()';


// 进大厅并以游客身份进入。
// 【为什么进大厅前先清 vs_profile】无头浏览器用固定 profile，localStorage 跨运行共享；
// 登录页会拿上次记住的昵称预填输入框，而游客昵称一旦与已存在的身份重名，
// 服务端按身份键（userId 优先、其次昵称）会把两个标签页认成**同一个人** ——
// 本脚本第一版就栽在这：观众顶着上次残留的昵称进场，与玩家成了同一人，
// 玩家一断开就把观众的观战带走了（表现为 MATCH_EMPTY / 观战进不去），极难定位。
async function enterLobby(page, nick) {
  await page.send('Page.navigate', { url: LOBBY_URL2 });
  await waitFor(async function () {
    const r = await page.eval('(function(){var a=document.getElementById("app");return a?!a.hasAttribute("v-cloak"):null;})()');
    return r === true ? r : null;
  }, 12000, nick + ' 页面渲染完成');
  await page.eval('(function(){ try { localStorage.removeItem("vs_profile"); } catch(e){} return true; })()');
  // 昵称选择器：placeholder 是中文，里面带单引号。
  // 【为什么用 [title] 之外的办法】placeholder 选择器里那个中文串必须转义，
  // 一旦引号层级写错，整条表达式语法错误、eval 静默返回 null（netcheck 栽过）。
  // 所以把选择器整体拼好再 JSON.stringify 一次，引号由 stringify 负责转义。
  const NICK_SEL = JSON.stringify('input[placeholder=\'给自己起个名字\']');
  await page.eval('(function(){' +
    'var inp = document.querySelector(' + NICK_SEL + ');' +
    'if (inp) { inp.value = ' + JSON.stringify(nick) + '; inp.dispatchEvent(new Event("input", {bubbles:true})); }' +
    'return inp ? inp.value : "(没找到输入框)"; })()');
  await sleep(200);
  await page.eval(clickByText('以游客身份进入', false));
  await waitFor(async function () {
    const r = await page.eval(LOBBY_STATE);
    return r && r.connText && r.connText.indexOf('已连接') >= 0 ? r : null;
  }, 12000, nick + ' 握手完成');
}

// ============================================================
// 主流程
// ============================================================
// ============================================================
// 主流程
// ============================================================

async function main() {
  log('');
  log('=== 观战界面端到端实测（' + BASE_URL + '） ===');

  await killByPort(CDP_PORT);
  const chrome = await launchChrome();
  try {
    // ----------------------------------------------------------------
    // [1] 玩家开一桌并进入对局
    // ----------------------------------------------------------------
    const P = await connect('玩家');
    await enterLobby(P, '观战测试甲');
    await P.eval(clickByText('创建房间', true));
    const room = await waitFor(async function () {
      const r = await P.eval(LOBBY_STATE);
      return r && r.roomCode ? r : null;
    }, 12000, '玩家建房');
    expect('[1] 玩家开了一桌（观战要有东西可看）', !!(room && room.roomCode),
      JSON.stringify(room));
    log('   房间号 = ' + (room && room.roomCode));

    await P.eval(clickByText('开始对局', true));
    const pIn = await waitFor(async function () {
      const r = await P.eval(GAME_STATE);
      return r && r.screen === 'playing' ? r : null;
    }, 25000, '玩家进入对局');
    expect('[1] 玩家那一局正常跑起来了', !!pIn, JSON.stringify(pIn));

    // ----------------------------------------------------------------
    // [2] 大厅里的观战入口
    // ----------------------------------------------------------------
    const S = await connect('观众');
    await enterLobby(S, '观战测试乙');
    // 自己开的那一桌一定在列表里，而且必须是「对局中」——
    // 玩家刚进对局，房间状态已经是 playing。
    const hit = await S.eval('(function(){' +
      'var list = Array.prototype.slice.call(document.querySelectorAll("button"));' +
      'var b = list.filter(function(x){ return (x.innerText||"").trim() === "观战"; })[0];' +
      'if (b) { b.click(); return { ok:true }; }' +
      'return { ok:false, buttons: list.map(function(x){return (x.innerText||"").trim(); }) };' +
      '})()');
    expect('[2] 大厅里「进行中」的那一桌有「观战」按钮', !!(hit && hit.ok),
      JSON.stringify(hit));
    if (!hit || !hit.ok) log('   按钮清单：' + JSON.stringify(hit && hit.buttons));

    // 导航是异步的：点完按钮此刻还在大厅页。
    // 【必须判成功并分流】原来这里是 waitFor + 忽略结果，导航没发生时就一路
    // 带着「还在大厅的页面」跑下去，后面十几条全在报「VS_GAME 不存在」——
    // 看着像观战功能坏了，实际是根本没跳过去。
    const navOk = await waitFor(async function () {
      // ★同时认 /game 与 /game.html（第十七轮起玩家侧地址是干净的 /game，
      //   老路径刻意保留给测试脚本与书签）
      const r = await S.eval('(function(){ return /^\\/game(\\.html)?$/.test(location.pathname) ? 1 : null; })()');
      return r;
    }, 20000, '观众跳到游戏页');
    expect('[2] 点「观战」跳到游戏页（且带着 debug 句柄）', !!navOk,
      '仍在 ' + (await S.eval('(function(){ return location.pathname + location.search; })()')));

    if (!navOk) {
      (S.pageErrors || []).slice(-8).forEach(function (l) { log('   ' + l); });
      (S.consoleLogs || []).slice(-12).forEach(function (l) { log('   ' + l); });
      await S.close();
      await P.close();
      finish(chrome);
      return;
    }

    // ----------------------------------------------------------------
    // [3] 观战者身份
    // ----------------------------------------------------------------
    // 【为什么等的是 spectating 而不是 screen】screen 从 connecting 变 playing
    // 要等握手 + 观战起手包都到齐，而 spectating 一为真就说明这两件事都完成了。
    const st = await waitFor(async function () {
      const r = await S.eval(SPEC_STATE);
      return r && r.missing !== true && r.spectating === true ? r : null;
    }, 30000, '观众进入观战');
    if (!st) {
      log('   —— 观众页面异常 ——');
      (S.pageErrors || []).slice(-8).forEach(function (l) { log('   ' + l); });
      (S.consoleLogs || []).slice(-14).forEach(function (l) { log('   ' + l); });
    }
    expect('[3] 观战者进入了游戏页', !!(st && st.screen === 'playing'), JSON.stringify(st));
    expect('[3] 客户端认得自己是观战者', !!(st && st.spectating === true), JSON.stringify(st));
    expect('[3] 观战者没有座位（selfSlot=-1）',
      st && st.selfSlot === -1, 'selfSlot=' + (st && st.selfSlot));
    expect('[3] 观战者有跟随目标', st && st.followSlot >= 0,
      'followSlot=' + (st && st.followSlot));
    const roster = (st && st.roster) || [];
    expect('[3] 名单里有玩家（观战有东西可看）', roster.length >= 1, JSON.stringify(roster));
    expect('[3] 观战者不在名单里（没混成一个座位）',
      roster.every(function (x) { return x.name !== '观战测试乙'; }), JSON.stringify(roster));

    // 等第一帧快照：game_start 到了不代表快照到了，此刻读 tick 还是 0
    const snapped = await waitFor(async function () {
      const r = await S.eval(SPEC_STATE);
      return r && r.tick > 0 ? r : null;
    }, 20000, '观众收到第一帧快照');
    expect('[3] 观战者收到的世界在推进（不是静止假画面）', !!snapped,
      'tick=' + (snapped && snapped.tick));
    expect('[3] 快照带观战标记', !!(snapped && snapped.snapSpectating === true),
      JSON.stringify(snapped && snapped.snapSpectating));

    // ----------------------------------------------------------------
    // [4] 界面换成观战形态
    // ----------------------------------------------------------------
    const ui = await S.eval(SPEC_UI);
    expect('[4] 界面上标着「观战中」',
      !!(ui && ui.badge && ui.badge.indexOf('观战') >= 0), JSON.stringify(ui));
    expect('[4] 不画血条（观战者没有血）', !!(ui && ui.noHpBar), JSON.stringify(ui));
    // 探针返回的就是「这个元素在不在」（noHpBar / noExpBar / noLevel / noSlots），
    // 断言不要再取反 —— 取反两次就成了「元素必须在」，与意图正好相反。
    expect('[4] 不画经验条', !!(ui && ui.noExpBar), JSON.stringify(ui));
    expect('[4] 不画等级', !!(ui && ui.noLevel), JSON.stringify(ui));
    expect('[4] 不画武器与被动栏（那是「被跟那个人」的）',
      !!(ui && ui.noSlots), JSON.stringify(ui));
    expect('[4] 底部观战控制条在', !!(ui && ui.dock), JSON.stringify(ui));
    expect('[4] 标出正在跟谁', !!(ui && ui.followName && ui.followName !== '—'),
      JSON.stringify(ui));
    expect('[4] 有「退出观战」按钮', !!(ui && ui.stopBtn), JSON.stringify(ui));
    // 击杀/金币是**被跟那个人**的战绩。显示成观战者自己的，等于骗人。
    expect('[4] 不显示击杀与金币（那是参战者的战绩）', !!(ui && ui.noKillStat), JSON.stringify(ui));
    expect('[4] 右上角写明「观战者不参与计数」',
      !!(ui && ui.specNote && ui.specNote.indexOf('观战者') >= 0), JSON.stringify(ui));
    // 调试浮层那句「移动 WASD」对观战者是错的（sendInput 直接 return）
    expect('[4] 调试提示不再对观战者说「移动 WASD」',
      !!(ui && ui.debugSaysNoMove), JSON.stringify(ui));
    await S.shot(SPEC_SHOT);

    // ----------------------------------------------------------------
    // [5] 玩家那边完全不受影响（这一节最重要）
    // ----------------------------------------------------------------
    const pDuring = await P.eval(GAME_STATE);
    expect('[5] 观战者进场后玩家仍在对局里',
      !!(pDuring && pDuring.screen === 'playing'), 'screen=' + (pDuring && pDuring.screen));
    // tick 不从 GAME_STATE 读（那里面没有这个字段，读到的是 undefined）。
    // 「世界照跑」改用玩家自己的观察：snapCount 在涨就说明快照一直在来。
    expect('[5] 玩家的世界照跑（观战不影响模拟）',
      !!(pDuring && pDuring.snapCount > 0), 'snapCount=' + (pDuring && pDuring.snapCount));
    expect('[5] 观战者没有混进玩家的名单',
      pDuring && pDuring.players === 1, 'players=' + (pDuring && pDuring.players));
    expect('[5] 玩家侧零未捕获异常', P.pageErrors.length === 0, P.pageErrors.join(' | '));
    expect('[5] 观众侧零未捕获异常', S.pageErrors.length === 0, S.pageErrors.join(' | '));

    // ----------------------------------------------------------------
    // [6] 退出观战（只有 1 人可跟时，切换视角应当是禁用而不是消失）
    // ----------------------------------------------------------------
    expect('[6] 只有一个人可跟时「切换视角」是禁用的（不是没做出来）',
      !!(ui && ui.followBtnDisabled), JSON.stringify(ui));

    await S.eval(clickByText('退出观战', true));
    const back = await waitFor(async function () {
      const r = await S.eval('(function(){ return location.pathname === "/" ? 1 : null; })()');
      return r;
    }, 20000, '观众回到大厅');
    expect('[6] 「退出观战」回到大厅', !!back,
      '仍在 ' + (await S.eval('(function(){ return location.pathname; })()')));
    const spec = await S.eval('(function(){ return sessionStorage.getItem("vs_spec"); })()');
    expect('[6] 退出后 vs_spec 残留被清掉（下次进大厅不会又跳回观战）',
      spec === null, 'vs_spec=' + spec);

    // ----------------------------------------------------------------
    // [7] 观战者退出后，玩家那边一切照常
    // ----------------------------------------------------------------
    const pAfter = await P.eval(GAME_STATE);
    expect('[7] 观战者退出后玩家仍在对局里（没被连带踢出）',
      !!(pAfter && pAfter.screen === 'playing'), 'screen=' + (pAfter && pAfter.screen));
    expect('[7] 玩家侧没有出现错误提示（没被当成「退出对局」）',
      pAfter && pAfter.netErr === '', 'netErr=' + (pAfter && pAfter.netErr));

    await S.close();
    await P.close();
  } catch (e) {
    log('脚本异常：' + (e && e.stack || e));
    fail += 1;
  }
  finish(chrome);
}

function finish(chrome) {
  try { chrome.kill(); } catch (e) { /* 收尾失败不影响结论 */ }
  log('');
  log('=== 汇总 ===');
  log('  PASS  ' + pass);
  log('  FAIL  ' + fail);
  log('  截图：' + SPEC_SHOT);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  log('脚本异常：' + (e && e.stack || e));
  process.exit(1);
});
