// tools/panelbtn.js —— 暂停/菜单/结算面板「按钮被裁 + 字号偏小」的回归
//
// 现象（用户截图）
// --------------------
// 暂停面板里三个按钮一行：「返回大厅 / 技能图鉴 / 重开一局」。
// 「重开一局」右侧被切掉一半，只剩「重开一局」的左半和「重开一局」三个字的一部分。
//
// 根因（三条叠加，缺一条都不会这样）
// ------------------------------------
//   ① `public/game.html` 里暂停面板写的是**内联** `style="max-width: 420px"` ——
//      内联样式优先级高于 `@media (pointer:fine) .panel { max-width: 900px }`，
//      所以「PC 放大」这条根本没生效，面板停在420px。
//   ② 同一条放大段里 `.panel .btn { font-size:17px; padding:13px 26px }` **照常生效**
//      —— 按钮变大了，容器却没变大。
//   ③ `.panel-actions` 是 `display:flex; gap:10px` + `.btn { flex:1 }`，
//      三个按钮平分 420px 减去 padding 与 gap，每个只剩 ~120px，
//      装不下「重开一局」+ 26px×2 的内边距 → 溢出。
//      而 `.panel` 有 `overflow:hidden` → 溢出的部分**被直接切掉**，不报错。
//
// 为什么值得单独立一个脚本
// ----------------------
// 「字被裁掉一半」在截图上一眼可见，但「按钮溢出多少」「面板实际多宽」
// 必须量。而且这个 bug 只在 **PC（pointer:fine）+ 暂停面板** 上出现，
// 手机窄屏是 flex 换行、看不出问题 —— 很容易被「手机测过了就没事」带偏。
//
// 用法：
//   node tools/panelbtn.js                → 本地
//   node tools/panelbtn.js https://xxx    → 线上（发布后复验）
const { spawn } = require('node:child_process');

const APP_PORT = Number(process.argv[2] || 3000);
const LIVE = /^(https?:)?\/\//.test(String(process.argv[2] || ''));
const BASE = LIVE ? String(process.argv[2]).replace(/\/$/, '') : ('http://127.0.0.1:' + APP_PORT);
const CDP_PORT = 9357;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_panelbtn_profile';

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

// 量一个弹层面板：面板宽、每个按钮的宽 / 文字实际占用 / 是否溢出被裁
const PROBE = `(async function(){
  await Vue.nextTick();
  await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
  var pn = document.querySelector(".overlay .panel");
  if (!pn) return { err: "no panel" };
  var ov = document.querySelector(".overlay");
  var cs = getComputedStyle(pn);
  // 面板的 padding 内边界 = 按钮能用的宽度
  var padL = parseFloat(cs.paddingLeft) || 0, padR = parseFloat(cs.paddingRight) || 0;
  var pnr = pn.getBoundingClientRect();
  var inner = pnr.width - padL - padR;
  var rows = Array.prototype.slice.call(pn.querySelectorAll(".panel-actions"));
  var out = [];
  rows.forEach(function(row, ri){
    var btns = Array.prototype.slice.call(row.querySelectorAll("button"));
    btns.forEach(function(b, bi){
      var r = b.getBoundingClientRect();
      // ★文字实际需要的宽度：用一个离屏 span量同样的字体
      var probe = document.createElement("span");
      probe.style.cssText = "position:absolute;left:-9999px;white-space:nowrap;font:" + getComputedStyle(b).font;
      probe.textContent = (b.innerText || "").trim();
      document.body.appendChild(probe);
      var needW = probe.getBoundingClientRect().width;
      document.body.removeChild(probe);
      var bcs = getComputedStyle(b);
      var pl = parseFloat(bcs.paddingLeft) || 0, pr = parseFloat(bcs.paddingRight) || 0;
      out.push({
        row: ri, idx: bi, text: (b.innerText || "").trim(),
        w: Math.round(r.width), needTextW: Math.round(needW),
        pad: pl + "+" + pr,
        // ★需要的总宽 vs 实际拿到的宽 —— 差值就是被切掉/挤出去的部分
        shortfall: Math.round((needW + pl + pr) - r.width),
        right: Math.round(r.right), panelRight: Math.round(pnr.right),
        fontSize: bcs.fontSize,
        // 文字右缘是否越过面板内边界（越界= 被 overflow:hidden 切掉）
        textRight: Math.round(r.right - pr),
        innerRight: Math.round(pnr.right - padR),
        clipped: (r.right - pr) > (pnr.right - padR) + 1
      });
    });
  });
  return {
    panelW: Math.round(pnr.width), innerW: Math.round(inner),
    padL: padL, padR: padR,
    maxW: cs.maxWidth,
    inlineMaxW: pn.getAttribute("style") || null,
    overflow: cs.overflow,
    h2: Math.round((pn.querySelector("h2") || {getBoundingClientRect:function(){return{height:0}}}).getBoundingClientRect().height),
    sub: (pn.querySelector(".sub") || {innerText:""}).innerText,
    buttons: out,
    vw: document.documentElement.clientWidth
  };
})()`;

async function runAt(send, label, w, h, fine) {
  // pointer:coarse / fine 无法直接设，用 --touch-events 那套不行；
  // 这里靠 hasTouch 让input 判定走不同分支不可靠，
  // 所以 PC 用默认（无 touch），触屏用 setDeviceMetrics + hasTouch。
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: 1, mobile: !!fine
  });
  if (fine) await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  else await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await sleep(600);
  const r = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true, awaitPromise: true });
  const v = (r && r.result && r.result.value) || {};
  console.log('  [' + label + ' ' + w + 'x' + h + '] 面板宽=' + v.panelW +
    ' 内容宽=' + v.innerW + ' h2高=' + v.h2 + ' 按钮=' + JSON.stringify(v.buttons));
  return v;
}

async function main() {
  console.log('=== 弹层按钮裁切回归（目标 ' + BASE + '）===');
  if (!require('node:fs').existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }
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
  await sleep(3200);

  // 开局 → 暂停
  await evalJS('(function(){ var g=window.VS_GAME; if(g) g.start(); return 1; })()');
  await sleep(1500);
  await evalJS(`(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll("button"));
    var b = l.filter(function(x){ return (x.innerText||"").trim() === "暂停"; })[0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(800);

  console.log('\n--- 各操作方式下弹层面板（暂停面板）---');

  const pc = await runAt(send, 'PC 鼠标', 1600, 1000, false);
  console.log('\n--- PC 上的问题 ---');
  ok('★没有任何按钮被裁（文字右缘不超过面板内边界）',
    pc.buttons && pc.buttons.every(function (b) { return !b.clipped; }),
    JSON.stringify((pc.buttons || []).filter(function (b) { return b.clipped; })));
  ok('★没有任何按钮「需要的宽度 > 拿到的宽度」',
    pc.buttons && pc.buttons.every(function (b) { return b.shortfall <= 1; }),
    JSON.stringify((pc.buttons || []).map(function (b) { return b.text + ':' + b.shortfall; })));
  ok('★三个按钮都在（返回大厅/技能图鉴/重开一局）',
    pc.buttons && pc.buttons.length >= 4 &&
    pc.buttons.some(function (b) { return b.text === '技能图鉴'; }) &&
    pc.buttons.some(function (b) { return b.text === '重开一局'; }),
    JSON.stringify((pc.buttons || []).map(function (b) { return b.text; })));
  // 暂停面板的标题与副标题也要够大（用户要「字大一些」）
  const h2Big = await evalJS(`(function(){
    var h = document.querySelector(".overlay .panel h2");
    return h ? getComputedStyle(h).fontSize : null;
  })()`);
  ok('★暂停面板标题字号够大（>= 24px）', h2Big && parseFloat(h2Big) >= 24, h2Big);
  const btnFont = pc.buttons && pc.buttons[0] ? parseFloat(pc.buttons[0].fontSize) : 0;
  ok('★按钮字号够大（>= 16px）', btnFont >= 16, btnFont + 'px');
  // ★内联 max-width 不该再压住 PC 放大
  ok('★面板宽度跟上了放大（不被内联 420px 压住）', pc.panelW >= 560,
    '面板 ' + pc.panelW + 'px，内联=' + pc.inlineMaxW);

  // 手机窄屏：按钮会换行，本来就不该被裁 —— 但也要确认不裁
  const phone = await runAt(send, '触屏', 390, 844, true);
  ok('触屏：按钮同样不被裁',
    phone.buttons && phone.buttons.every(function (b) { return !b.clipped; }),
    JSON.stringify((phone.buttons || []).filter(function (b) { return b.clipped; })));

  // 结算面板也看一眼（它按钮更多，最容易出同样的问题）
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.clearDeviceMetricsOverride');
  await sleep(400);
  const res = await evalJS(`(function(){
    var g = window.VS_GAME;
    g.ui.screen = 'result';
    return 1;
  })()`);
  await sleep(700);
  const rp = await evalJS(PROBE);
  ok('★结算面板的按钮也不被裁',
    rp.buttons && rp.buttons.every(function (b) { return !b.clipped; }),
    JSON.stringify((rp.buttons || []).filter(function (b) { return b.clipped; })));

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
