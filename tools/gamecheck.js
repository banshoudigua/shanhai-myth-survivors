// tools/gamecheck.js —— 用 CDP 在真实时钟下实测 game.html
//
// 为什么不用 --virtual-time-budget：
//   实测（tools/diag1.js）在该参数下 requestAnimationFrame 只跑了 3 帧就彻底停住
//   （raf=3 从 t100 一直保持到 t20000，而 setInterval 正常触发 400 次）。
//   游戏主循环是 rAF 驱动的，虚拟时钟根本推不动它，测了等于没测。
//
// 所以走 CDP + 真实时钟，并且额外用 Page.startScreencast 强制渲染器持续出帧
// —— 无头环境没有可见窗口、没有合成帧，rAF 不会被调度；起一个投屏就能把它唤醒。
//
// 用法：node tools/gamecheck.js [端口] [秒数]
// 依赖：先启动 server/index.js；本机 chrome-headless-shell 见 CHROME

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
// 数值表：断言里要拿它比对（比如角色卡片的数量），不引的话只能写死数字 —— 而写死
// 正是「加一个角色就要改测试」的来源。
const C = require('../shared/const.js');

const APP_PORT = Number(process.argv[2] || 3000);
const SECONDS = Number(process.argv[3] || 35);
const CDP_PORT = 9333;                 // 别用 9222：那是 WorkBuddy 自己的调试端口
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_gamecheck_profile';
const SHOT = TMP + '/vs_gamecheck.png';
const LOG = TMP + '/vs_gamecheck.log';


// 日志落盘：脚本被超时杀掉时 stdout 的缓冲会丢，只有写文件才能看到卡在哪一步
fs.writeFileSync(LOG, '');
function log() {
  const s = Array.prototype.map.call(arguments, function (a) {
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ');
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// ============================================================
// 启动无头浏览器
// ============================================================

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
      '--disable-gpu',
      '--no-sandbox',
      '--no-proxy-server',                 // 本机常驻代理会污染本地请求
      '--no-first-run',
      '--hide-scrollbars',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-allow-origins=*',          // 缺这个 CDP 的 WS 握手直接 403
      '--window-size=1280,800',
      'about:blank'
    ];
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    child.on('error', reject);

    // 等调试端口起来
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

// ============================================================
// CDP 会话
// ============================================================

// 建立连接并返回一个 send() 包装；返回 Promise 是为了能用 await 串起来
function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      if (!tab || !tab.webSocketDebuggerUrl) throw new Error('新建标签页失败：' + JSON.stringify(tab));
      return tab.webSocketDebuggerUrl;
    })
    .then(function (wsUrl) {
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = {};
        const consoleLogs = [];
        const pageErrors = [];

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

          // 页面 alert/confirm 会阻塞主线程，让后续 evaluate 永挂，必须自动点掉
          if (msg.method === 'Page.javascriptDialogOpening') {
            log('!! 页面弹出对话框：' + JSON.stringify(msg.params));
            send('Page.handleJavaScriptDialog', { accept: true });
            return;
          }

          // 必须 ack，否则投屏流会停，rAF 又不跑了
          if (msg.method === 'Page.screencastFrame') {
            send('Page.screencastFrameAck', { sessionId: msg.params.sessionId });
            return;
          }

          // 收集页面控制台与未捕获异常（这是判定「有没有报错」的唯一依据）
          if (msg.method === 'Runtime.consoleAPICalled') {
            const text = (msg.params.args || []).map(function (a) {
              return a.value !== undefined ? String(a.value) : (a.description || a.type);
            }).join(' ');
            consoleLogs.push({ type: msg.params.type, text: text });
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

        ws.addEventListener('open', function () {
          resolve({ send: send, ws: ws, consoleLogs: consoleLogs, pageErrors: pageErrors });
        });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// ============================================================
// 主流程
// ============================================================

// 页面内取状态：走 game.js 在 ?debug=1 下暴露的 window.VS_GAME 句柄。
// 不走 __vue_app__._instance 是因为 Vue 打包版里它恒为 null（已实测确认）。
const STATE_EXPR = [
  '(function(){',
  '  var el = document.getElementById("hud");',
  '  var g = window.VS_GAME;',
  '  var r = { ok: !!(g && g.world) };',
  '  if (!r.ok) { r.hasHook = !!g; r.hasEl = !!el; r.hookKeys = g ? Object.keys(g).join(",") : null; return r; }',
  '  r.screen = g.screen; r.tick = g.tick; r.fps = g.fps;',
  '  var st = g.stat; r.drawn = st.drawn; r.total = st.total;',
  '  r.pending = g.ui.pendingLevels;',
  '  var h = g.hud;',
  '  r.hud = { level: h.level, kills: h.kills, mobCount: h.mobCount, wave: h.wave,',
  '    hp: h.hp, maxHp: h.maxHp, gold: h.gold, timeLeft: h.timeLeft, state: h.state,',
  '    charName: h.charName, weapons: h.weapons.length, passives: h.passives.length };',
  // 界面上真实可见的文本（用于确认 Vue 绑定没渲染成空白）
  '  var ov = document.querySelector(".overlay");',
  '  r.overlayText = ov ? ov.innerText.replace(/\\s+/g," ").trim().slice(0,80) : null;',
  '  r.choices = document.querySelectorAll(".choice").length;',
  '  r.choiceText = r.choices ? document.querySelector(".choice").innerText.replace(/\\s+/g," ").trim().slice(0,60) : null;',
  '  var tm = document.querySelector(".hud-timer");',
  '  r.timerText = tm ? tm.innerText.trim() : null;',
  '  var hpBar = document.querySelector(".bar.hp i");',
  '  r.hpBarWidth = hpBar ? hpBar.style.width : null;',
  '  r.slotCount = document.querySelectorAll(".hud-slots .slot").length;',
  '  r.cloak = el.hasAttribute("v-cloak");',
  '  r.hasTemplate = el.innerText.indexOf("{{") >= 0;',
  '  return r;',
  '})()'
].join('\n');

// 页面内执行一个动作（点按钮之类）
function actExpr(js) {
  return '(function(){' + js + '})()';
}

async function main() {
  log('');
  log('=== game.html CDP 实测  目标 http://127.0.0.1:' + APP_PORT + '  时长 ' + SECONDS + 's ===');
  log('');

  if (!fs.existsSync(CHROME)) {
    log('!! 找不到无头浏览器: ' + CHROME);
    process.exit(1);
  }

  // 先确认应用服务活着
  const alive = await fetch('http://127.0.0.1:' + APP_PORT + '/api/health')
    .then(function (r) { return r.status === 200; })
    .catch(function () { return false; });
  if (!alive) {
    log('!! 应用服务未就绪，先启动 server/index.js');
    process.exit(1);
  }

  await killByPort(CDP_PORT);
  await sleep(500);

  log('[1] 启动无头浏览器（调试端口 ' + CDP_PORT + '）');
  const chrome = await launchChrome();
  log('[2] 浏览器已就绪');

  const s = await connect();
  const send = s.send;

  log('[3] Page.enable / Runtime.enable / Log.enable');
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  // 强制渲染器持续出帧，让 requestAnimationFrame 真正被调度
  log('[4] Page.startScreencast（唤醒 rAF）');
  await send('Page.startScreencast', { format: 'jpeg', quality: 30, everyNthFrame: 2 });

  log('[5] 导航到 /game.html?debug=1（带 debug 才会挂 window.VS_GAME 调试句柄）');
  await send('Page.navigate', {
    url: 'http://127.0.0.1:' + APP_PORT + '/game.html?debug=1&_t=' + Date.now()
  });

  // 等页面脚本就绪
  await sleep(2500);

  let started = false;
  let levels = 0;
  let maxLevel = 1;
  // 单机出现过几次「联机贴底升级面板」——正确值恒为 0
  let soloDockSeen = 0;
  let maxKills = 0;
  let maxMobs = 0;
  let maxWave = 0;
  let maxTick = 0;
  let drawnMax = 0;
  let totalMax = 0;
  let sawTemplate = false;
  let cloakStuck = false;
  let screens = [];
  const selectSnap = {};
  const pauseSnap = {};
  let pauseTested = false;

  const startedAt = Date.now();
  let iter = 0;

  // 让角色走起来：验证 input.js 的键盘监听真的接到了事件
  async function pressKey(dir, down) {
    const map = { d: [68, 'KeyD', 'd'], a: [65, 'KeyA', 'a'], w: [87, 'KeyW', 'w'], s: [83, 'KeyS', 's'] };
    const m = map[dir];
    await send('Input.dispatchKeyEvent', {
      type: down ? 'keyDown' : 'keyUp',
      windowsVirtualKeyCode: m[0], nativeVirtualKeyCode: m[0],
      code: m[1], key: m[2]
    });
  }

  while ((Date.now() - startedAt) < SECONDS * 1000) {
    iter += 1;
    await sleep(700);

    const r = await send('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
    const st = (r && r.result && r.result.value) || null;
    if (!st) { log('  第 ' + iter + ' 轮拿不到状态'); continue; }
    if (st.ok === false) { log('  第 ' + iter + ' 轮 调试句柄不可用，st=' + JSON.stringify(st)); continue; }

    if (st.cloak) cloakStuck = true;
    if (st.hasTemplate) sawTemplate = true;
    if (st.tick > maxTick) maxTick = st.tick;
    if (st.drawn > drawnMax) drawnMax = st.drawn;
    if (st.total > totalMax) totalMax = st.total;
    if (st.hud) {
      if (st.hud.level > maxLevel) maxLevel = st.hud.level;
      if (st.hud.kills > maxKills) maxKills = st.hud.kills;
      if (st.hud.mobCount > maxMobs) maxMobs = st.hud.mobCount;
      if (st.hud.wave > maxWave) maxWave = st.hud.wave;
    }
    if (screens.indexOf(st.screen) < 0) {
      screens.push(st.screen);
      log('  第 ' + iter + ' 轮 界面=' + st.screen + ' tick=' + st.tick +
        ' 绘制=' + st.drawn + '/' + st.total + ' FPS=' + st.fps +
        ' 等级=' + (st.hud ? st.hud.level : '-') + ' 击杀=' + (st.hud ? st.hud.kills : '-') +
        (st.overlayText ? ' 面板="' + st.overlayText.slice(0, 50) + '"' : ''));
    }

    // 角色选择阶段：记录面板内容后点「开始对局」
    if (!started && st.screen === 'select') {
      selectSnap.cards = -1; // 卡片数在下面单独取
      const cards = await send('Runtime.evaluate', {
        expression: actExpr(
          'var cs = document.querySelectorAll(".char-card");' +
          'var first = cs[0] ? cs[0].innerText.replace(/\\s+/g," ").trim() : null;' +
          'var btn = document.querySelector(".overlay .btn-primary");' +
          'var bt = btn ? btn.innerText.trim() : null;' +
          'return { n: cs.length, first: first, btn: bt };'
        ), returnByValue: true
      });
      const c = (cards && cards.result && cards.result.value) || {};
      selectSnap.cards = c.n;
      selectSnap.first = c.first;
      selectSnap.btn = c.btn;
      log('  角色面板：卡片=' + c.n + ' 开始按钮="' + c.btn + '"');
      log('  首张卡="' + c.first + '"');

      await send('Runtime.evaluate', {
        expression: actExpr('document.querySelector(".overlay .btn-primary").click(); return 1;'),
        returnByValue: true
      });
      started = true;
      log('  -> 已点击「开始对局」');
      // 开局后按住 D 键向右走，途中跑一段验证输入链路
      await pressKey('d', true);
    }

    // 开局约 7 秒后验一次暂停/继续：走真实键盘 Esc，顺带验证 input 层的按键绑定
    if (started && !pauseTested && iter >= 10 && st.screen === 'playing') {
      pauseTested = true;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
      await sleep(700);
      const pr = await send('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
      const pv = (pr && pr.result && pr.result.value) || {};
      pauseSnap.afterEsc = pv.screen;
      pauseSnap.pauseText = pv.overlayText;
      log('  按 Esc 后：界面=' + pv.screen + ' 面板="' + (pv.overlayText || '') + '"');

      // 暂停面板里「继续游戏」是 .btn-primary
      await send('Runtime.evaluate', {
        expression: actExpr('var b = document.querySelector(".overlay .btn-primary"); if (b) b.click(); return 1;'),
        returnByValue: true
      });
      await sleep(700);
      const pr2 = await send('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
      pauseSnap.afterResume = ((pr2 && pr2.result && pr2.result.value) || {}).screen;
      log('  点「继续游戏」后：界面=' + pauseSnap.afterResume);
    }

    // 升级面板：点第一个选项（否则世界会一直冻结）
    if (st.screen === 'levelup' && st.choices > 0) {
      if (st.dock) soloDockSeen += 1;
      log('  升级面板：候选=' + st.choices + ' 等级=' + st.hud.level +
        ' 待选=' + st.pending + ' 首项="' + st.choiceText + '"');
      await send('Runtime.evaluate', {
        expression: actExpr('document.querySelectorAll(".choice")[0].click(); return 1;'),
        returnByValue: true
      });
      levels += 1;
      // 换方向继续走，避免一直贴边
      await pressKey('d', false);
      await pressKey('s', true);
      await sleep(900);
      await pressKey('s', false);
      await pressKey('d', true);
    }

    if (st.screen === 'result') {
      log('  对局结束：' + st.overlayText);
      break;
    }
  }

  await pressKey('d', false);

  // 末次状态 + 截图
  const fin = await send('Runtime.evaluate', { expression: STATE_EXPR, returnByValue: true });
  const f = (fin && fin.result && fin.result.value) || {};

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  log('[6] 截图已保存：' + SHOT);

  await send('Page.stopScreencast');
  s.ws.close();
  chrome.kill();
  await killByPort(CDP_PORT);

  // ------------------------------------------------------------
  // 判定
  // ------------------------------------------------------------
  log('');
  log('=== 断言 ===');

  let pass = 0, fail = 0;
  function expect(name, cond, detail) {
    if (cond) { pass++; log('  PASS  ' + name); }
    else { fail++; log('  FAIL  ' + name + '  ->  ' + detail); }
  }

  const realErrors = s.pageErrors.filter(function (e) { return e.indexOf('favicon') < 0; });

  expect('页面无未捕获异常', realErrors.length === 0, realErrors.join(' || '));
  expect('v-cloak 已摘除', cloakStuck === false, 'v-cloak 一直挂着，说明 Vue 没挂载成功');
  expect('无未渲染的 {{ }} 残留', sawTemplate === false, '页面上残留了模板文本');
  // 【为什么不在断言里写死数字】这里原来是 `=== 4`，本轮角色从 4 个扩到 8 个就假失败了。
  // 卡片数本来就该跟着 CHARACTERS 走 —— 断言写死等于「每加一个角色都要改测试」，
  // 而加角色恰恰是这个页面最常发生的事。改成与定义比对，同时仍能抓住
  // 「v-for 没渲染出来」这类真问题（那时 cards 会是 0 或 1）。
  const charCount = (C.CHARACTERS && C.CHARACTERS.length) || 0;
  expect('角色选择面板渲染出的卡片数与角色定义一致（' + charCount + ' 张）',
    selectSnap.cards === charCount, 'cards=' + selectSnap.cards + ' 定义=' + charCount);
  expect('角色卡文案非空（Vue 绑定生效）', !!selectSnap.first, '"' + selectSnap.first + '"');
  expect('点「开始对局」能进入游戏', started && screens.indexOf('playing') >= 0,
    '界面轨迹=' + screens.join(' > '));
  expect('键盘 Esc 能暂停', pauseSnap.afterEsc === 'paused',
    'Esc 后界面=' + pauseSnap.afterEsc);
  expect('暂停面板文案已渲染', !!pauseSnap.pauseText,
    '面板文本=' + pauseSnap.pauseText);
  expect('点「继续游戏」能恢复', pauseSnap.afterResume === 'playing',
    '恢复后界面=' + pauseSnap.afterResume);
  expect('主循环在真实时钟下跑起来（tick 增长）', maxTick > 0, 'maxTick=' + maxTick);
  expect('游戏内时间推进到位', maxTick >= 600, 'maxTick=' + maxTick + ' (期望 ≥600，即 30 秒)');
  expect('Canvas 确实画了东西', drawnMax > 0, 'drawn=' + drawnMax);
  expect('视口裁剪快照可用', totalMax >= drawnMax, 'drawn=' + drawnMax + ' total=' + totalMax);
  expect('有击杀发生', maxKills > 0, 'kills=' + maxKills);
  expect('升级链路通了（等级 > 1）', maxLevel > 1, 'level=' + maxLevel);
  expect('升级面板弹出且被成功选择', levels > 0, '选择次数=' + levels);
  expect('波次推进（wave ≥ 2）', maxWave >= 2, 'wave=' + maxWave);
  expect('同屏怪数不超硬上限', maxMobs <= 1200, 'mobs=' + maxMobs);
  expect('HUD 有真实读数（等级/击杀非空）', !!(f.hud && f.hud.maxHp > 0), JSON.stringify(f.hud));
  expect('HUD 血条宽度样式已绑定', !!f.hpBarWidth, 'width=' + f.hpBarWidth);
  expect('倒计时文本已渲染', !!f.timerText, 'timer=' + f.timerText);
  expect('武器槽位已渲染', f.slotCount > 0, 'slots=' + f.slotCount);
  // 单机升级面板必须还是「全屏遮罩」那一套：贴底变体是给联机用的
  // （联机世界不停，才需要让出战场）。串台了说明 ui.online 判断写漏了地方。
  expect('单机升级面板没被联机的贴底变体污染', soloDockSeen === 0, '出现次数=' + soloDockSeen);

  log('');
  log('--- 末帧快照 ---');
  log('  界面=' + f.screen + ' tick=' + f.tick + ' FPS=' + f.fps +
    ' 绘制=' + f.drawn + '/' + f.total);
  log('  等级=' + maxLevel + ' 击杀=' + maxKills + ' 波次=' + maxWave +
    ' 同屏峰值=' + maxMobs + ' 角色=' + (f.hud ? f.hud.charName : '-'));
  log('  倒计时=' + f.timerText + ' 剩余血量=' + (f.hud ? f.hud.hp + '/' + f.hud.maxHp : '-') +
    ' 剩余时间=' + (f.hud ? f.hud.timeLeft : '-'));
  log('  界面轨迹=' + screens.join(' > '));
  log('  页面 console 条数=' + s.consoleLogs.length);
  s.consoleLogs.slice(-12).forEach(function (c) { log('    [' + c.type + '] ' + c.text); });

  log('');
  log('=== 实测结束 ===');
  log('  PASS = ' + pass + '   FAIL = ' + fail);
  log('  日志：' + LOG);
  process.exit(fail === 0 ? 0 : 1);
}

// 兜底：整脚本 3 分钟没跑完就退出，避免静默挂死
setTimeout(function () {
  log('!! 总超时 180 秒，强制退出');
  process.exit(2);
}, 180000);

main().catch(function (e) {
  log('脚本出错：' + (e && e.message));
  log((e && e.stack) || '');
  process.exit(1);
});
