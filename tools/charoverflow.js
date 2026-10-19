// tools/charoverflow.js —— 角色选择面板「顶部被裁、滚不回去」的回归
//
// 现象（用户实测截图）
// --------------------
// 8 张角色卡排4×2，面板比视口高。`.overlay` 是 `display:flex; align-items:center`
// + `overflow-y:auto` —— 这是 flexbox 的经典陷阱：
// **居中的子元素一旦比容器高，顶部会被推到容器内容区之外，而滚动条只能往下走。**
// 结果是上方一整排角色（猎魔人/修女）永远看不见，也滚不出来。
//
// 为什么值得单独一个脚本
// -------------------
// 这个 bug 在**窄屏或矮窗口**上必现、在宽屏上不现，截图不看容易判成「响应式没做」。
// 而且它不会报错、不会白屏 —— 只是「少了两张卡」，人肉不点开滚动条根本发现不了。
// 断言必须量「第一张卡的 top 是否 >= 0」与「scrollTop=0 时是否可见」。
//
// 用法：node tools/charoverflow.js [端口]
const { spawn } = require('node:child_process');

// 第二个参数也可以是**线上域名**（发布后复验用）—— 这个 bug 修完必须在线上量一次，
// 因为「CSS 传上去了」和「浏览器里真的生效了」是两件事。
const APP_PORT = Number(process.argv[2] || 3000);
const LIVE = /^(https?:)?\/\//.test(String(process.argv[2] || ''));
const BASE = LIVE ? String(process.argv[2]).replace(/\/$/, '') : ('http://127.0.0.1:' + APP_PORT);
const CDP_PORT = 9353;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_charoverflow_profile';

// 启动参数里的代理部分。
// ★测**线上域名**时必须显式指定代理：Windows 版 Chrome **不读** `http_proxy` 环境变量
//   （只认系统代理设置，而本机是「直连」），不指定的话导航会落到
//   `chrome-error://chromewebdata/` —— 症状是「页面里什么都没有、断言整片红」，
//   看起来像前端崩了，其实一行代码都没错（本地跑全绿）。2026-10-06 踩过一次。
//   ★端口每次会话都可能变（49675 / 52494…）→ 只能从环境变量现取；
//   测本地 127.0.0.1 时反过来要绕开代理。
function proxyArgs() {
  const p = process.env.http_proxy || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  return (LIVE && p) ? ['--proxy-server=' + p] : ['--no-proxy-server'];
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
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

function launchChrome(w, h) {
  return new Promise(function (resolve, reject) {
    const child = spawn(CHROME, [
      '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=' + w + ',' + h, 'about:blank'
    ].concat(proxyArgs()), { stdio: 'ignore' });
    child.on('error', reject);
    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume(); clearInterval(t); resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口没起来')); }
      });
    }, 500);
  });
}

function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) { return tab.webSocketDebuggerUrl; })
    .then(function (wsUrl) {
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = {};
        const errors = [];
        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () { delete pending[msgId]; rej(new Error('CDP 超时：' + method)); }, 20000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
          if (msg.method === 'Page.screencastFrame') { send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }); return; }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            errors.push((d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
          }
        });
        ws.addEventListener('open', function () { resolve({ send: send, ws: ws, errors: errors }); });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// 量角色选择页的布局：面板多高、第一张卡在哪、能不能滚到顶
const PROBE = `(async function(){
  await Vue.nextTick();
  await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
  var ov = document.querySelector(".overlay");
  var pn = document.querySelector(".overlay .panel");
  var cards = Array.prototype.slice.call(document.querySelectorAll(".char-card"));
  var grid = document.querySelector(".character-grid");
  // 「开始对局」按钮：与标题是否同屏，是「不用滚就能开始」的关键
  var btnList = Array.prototype.slice.call(document.querySelectorAll(".overlay button"));
  var startBtn = btnList.filter(function (b) { return (b.innerText || "").trim() === "开始对局"; })[0];
  var titleEl = pn ? pn.querySelector("h2") : null;
  if (!ov || !pn || !cards.length) return { err: "no panel/cards" };
  var ovr = ov.getBoundingClientRect();
  var pnr = pn.getBoundingClientRect();
  var first = cards[0].getBoundingClientRect();
  // 每张卡的 top，按行分组（同一行的 top 应该接近）
  var tops = cards.map(function(c){ return Math.round(c.getBoundingClientRect().top); });
  // 面板顶部相对遮罩顶部的偏移：>0 说明上面被裁掉了
  var panelTopInOverlay = Math.round(pnr.top - ovr.top);
  return {
    vh: de = document.documentElement.clientHeight,
    cards: cards.length,
    panelH: Math.round(pnr.height),
    panelW: Math.round(pnr.width),
    overlayH: Math.round(ovr.height),
    // ★核心：面板比遮罩高多少（>0 就会触发居中溢出）
    overflowPx: Math.round(pnr.height - (ovr.height - 40)),
    panelTopInOverlay: panelTopInOverlay,
    firstCardTop: Math.round(first.top),
    scrollTop: ov.scrollTop,
    scrollH: ov.scrollHeight,
    clientH: ov.clientHeight,
    tops: tops.slice(0, 8),
    alignItems: getComputedStyle(ov).alignItems,
    // ★第二层：网格自己是否可滚。8 张卡排开有 1961px，不给上限的话
    // 玩家要滚过整个面板才够得到「开始对局」，且标题会一起滚走
    gridScrollable: grid ? (grid.scrollHeight > grid.clientHeight + 1) : null,
    gridClientH: grid ? Math.round(grid.clientHeight) : null,
    gridScrollH: grid ? Math.round(grid.scrollHeight) : null,
    // 「开始对局」按钮是否与标题同屏（不滚就能点到）
    startBtnTop: startBtn ? Math.round(startBtn.getBoundingClientRect().top) : null,
    titleTop: titleEl ? Math.round(titleEl.getBoundingClientRect().top) : null,
    vhH: document.documentElement.clientHeight
  };
})()`;

async function runAt(send, label, w, h, mobile) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile
  });
  await sleep(700);
  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true });
  const v = (r && r.result && r.result.value) || {};
  console.log('  [' + label + ' ' + w + 'x' + h + '] ' + JSON.stringify(v));
  return v;
}

async function main() {
  console.log('=== 角色选择面板溢出回归（目标 ' + BASE + '）===');
  if (!require('node:fs').existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }
  // 线上没有本地那套 pglite 服务，探活改成抓页面本身
  const alive = LIVE
    ? await fetch(BASE + '/game.html').then(function (r) { return r.status === 200; }).catch(function () { return false; })
    : await fetch(BASE + '/api/health').then(function (r) { return r.status === 200; }).catch(function () { return false; });
  if (!alive) { console.log('!! 目标未就绪'); process.exit(1); }

  await killByPort(CDP_PORT);
  await sleep(400);
  const chrome = await launchChrome(1600, 1000);
  const s = await connect();
  const send = s.send;
  const evalJS = async function (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return (r && r.result && r.result.value) || null;
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.startScreencast', { format: 'jpeg', quality: 25, everyNthFrame: 4 });
  await send('Page.navigate', { url: BASE + '/game.html?debug=1&_t=' + Date.now() });
  await sleep(3000);

  console.log('\n--- 各尺寸下的角色选择页 ---');

  // 大屏：内容装得下，不该出问题
  const big = await runAt(send, '大屏', 1600, 1000, false);
  ok('大屏：8 张角色卡都在', big.cards === 8, String(big.cards));
  ok('大屏：面板不溢出（overflowPx <= 0）', big.overflowPx <= 0, '溢出 ' + big.overflowPx + 'px');
  ok('大屏：第一张卡完整可见（top >= 0）', big.firstCardTop >= 0, 'top=' + big.firstCardTop);
  ok('大屏：面板顶部在遮罩内（未被裁）', big.panelTopInOverlay >= 0, '偏移 ' + big.panelTopInOverlay);

  // ★用户截图那个尺寸：1080x580 附近（笔记本矮窗口 / 横屏手机）
  const short = await runAt(send, '矮窗口', 1080, 580, false);
  ok('★矮窗口：这个尺寸下内容确实装不下（证明测到了溢出场景）',
    short.overflowPx > 0, 'overflowPx=' + short.overflowPx);
  ok('★矮窗口：面板顶部没有被推到视口外', short.panelTopInOverlay >= 0,
    '偏移 ' + short.panelTopInOverlay + 'px（负数=上面被裁且滚不回去）');
  ok('★矮窗口：第一张角色卡完整可见', short.firstCardTop >= 0, 'top=' + short.firstCardTop);
  ok('★矮窗口：8 张卡一个不少', short.cards === 8, String(short.cards));
  ok('★矮窗口：角色网格自己可滚（不必滚过整个面板）',
    short.gridScrollable === true, 'scrollH=' + short.gridScrollH + ' clientH=' + short.gridClientH);
  ok('★矮窗口：「开始对局」按钮与标题同屏（不滚就能开始）',
    short.startBtnTop !== null && short.titleTop !== null && short.startBtnTop - short.titleTop < short.vhH,
    'titleTop=' + short.titleTop + ' btnTop=' + short.startBtnTop + ' vh=' + short.vhH);

  // 极端：超矮（横屏手机）
  const tiny = await runAt(send, '超矮', 844, 390, true);
  ok('★超矮（横屏手机）：面板顶部没被裁', tiny.panelTopInOverlay >= 0,
    '偏移 ' + tiny.panelTopInOverlay + 'px');
  ok('★超矮（横屏手机）：第一张卡可见', tiny.firstCardTop >= 0, 'top=' + tiny.firstCardTop);
  ok('超矮：8 张卡都在', tiny.cards === 8, String(tiny.cards));

  // 竖屏手机
  const phone = await runAt(send, '竖屏', 390, 844, true);
  ok('竖屏：8 张卡都在', phone.cards === 8, String(phone.cards));
  ok('竖屏：第一张卡可见', phone.firstCardTop >= 0, 'top=' + phone.firstCardTop);

  // ★内容超出时能不能滚到顶（这是 flex 居中溢出的第二个症状）
  const scrolled = await runAt(send, '矮窗口+滚到底再回顶', 1080, 580, false);
  if (scrolled.overflowPx > 0) {
    const r = await evalJS(`(function(){
      var ov = document.querySelector(".overlay");
      ov.scrollTop = 99999;                 // 滚到底
      var atBottom = ov.scrollTop;
      ov.scrollTop = 0;                     // 再回顶
      await0();
      function await0(){}
      var first = document.querySelector(".char-card").getBoundingClientRect();
      return { scrolledTo: atBottom, maxScroll: ov.scrollHeight - ov.clientHeight,
               backToTop: ov.scrollTop, firstTopAfter: Math.round(first.top) };
    })()`);
    console.log('  滚动探测：' + JSON.stringify(r));
    ok('内容超出一屏时遮罩真的可滚（scrollHeight > clientHeight）',
      r.maxScroll > 0, 'maxScroll=' + r.maxScroll);
    ok('★滚回顶后第一张卡仍在视口内（这正是原来做不到的那一步）',
      r.firstTopAfter >= 0, 'firstTop=' + r.firstTopAfter);
  }

  // 结算/暂停这类短面板不该被牵连
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  const other = await evalJS(`(function(){
    var g = window.VS_GAME; g.start(); return 1;
  })()`);
  await sleep(1200);
  const paused = await evalJS(`(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll("button"));
    var b = l.filter(function(x){ return (x.innerText||"").trim() === "暂停"; })[0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(600);
  const p = await evalJS(`(function(){
    var pn = document.querySelector(".overlay .panel");
    if (!pn) return null;
    var ov = document.querySelector(".overlay");
    var pnr = pn.getBoundingClientRect(), ovr = ov.getBoundingClientRect();
    return { top: Math.round(pnr.top - ovr.top), h: Math.round(pnr.height) };
  })()`);
  ok('暂停面板（内容短）仍然垂直居中，没有被改成顶对齐',
    !!(p && p.top > 0), JSON.stringify(p));

  const errs = s.errors.filter(function (e) { return e && e.indexOf('favicon') < 0; });
  ok('页面零 JS 异常', errs.length === 0, errs.slice(0, 2).join(' || '));

  await send('Page.stopScreencast');
  s.ws.close();
  chrome.kill();
  await killByPort(CDP_PORT);
  console.log('\n  PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

setTimeout(function () { console.log('!! 总超时 150 秒'); process.exit(2); }, 150000);
main().catch(function (e) { console.log('脚本出错：' + (e && e.stack || e)); process.exit(1); });
