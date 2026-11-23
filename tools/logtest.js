// tools/logtest.js —— 右下角「战况记录」端到端（真实浏览器）
//
// 用法：node tools/logtest.js [端口]
//
// 【这个脚本要证明什么】
// 玩家反馈「中间提示文字太多，而且一会就没了，没法知道之前发生了什么」。
// 原来的实现是 .toast-wrap 居中 + 2.4s setTimeout 删除。现在改成右下角常驻面板。
// 纯读代码不能证明「提示真的不消失」——必须让真实时钟走过 2.4 秒再看 DOM。
// 同样，面板落在右下角、手机上不压技能区，只有真浏览器量 rect 才知道。

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { TMP, CHROME, splitShare, shareSuffix } = require('./env');

// 与项目其它浏览器脚本一致：第一个参数可以是端口，也可以是完整线上 URL
// （线上必须带 ?sharecode=，否则平台会 403 —— 见 tools/env.js 的 splitShare）
const BASE_IN = String(process.argv[2] || '3031');
const LIVE = /^(https?:)?\/\//.test(BASE_IN);
// ★分享码是 query，不能留在 BASE 里再拼 '/game.html'（会变成 /?sharecode=x/game.html：
//   路径无效 → 落到首页 → #hud 不存在 → 19 条断言整片假红）。剥掉再拼。
const SHARE = splitShare(BASE_IN + (process.env.VS_SHARECODE ? '?sharecode=' + process.env.VS_SHARECODE : ''));
const BASE = LIVE
  ? BASE_IN.replace(/[?&]sharecode=[^&]+/, '').replace(/[?&]$/, '').replace(/\/$/, '')
  : ('http://127.0.0.1:' + Number(BASE_IN));
const CDP_PORT = 9393;
const PROFILE = TMP + '/vs_logtest_profile';

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
}

function killByPort(port) {
  return new Promise(function (resolve) {
    require('node:child_process').execFile('powershell', ['-NoProfile', '-Command',
      '$p = (Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue).OwningProcess; ' +
      'if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }'
    ], function () { resolve(); });
  });
}

function launchChrome(w, h) {
  return new Promise(function (resolve, reject) {
    const child = spawn(CHROME, [
      '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
      // ★线上域名要走本机代理，127.0.0.1 必须绕开（与 storycheck.js 同一条约定）
      LIVE ? ('--proxy-server=' + (process.env.http_proxy || process.env.https_proxy || '')) : '--no-proxy-server',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=' + w + ',' + h, 'about:blank'
    ].filter(function (a) { return a !== '--proxy-server='; }), { stdio: 'ignore' });
    child.on('error', reject);
    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume(); clearInterval(t); resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('CDP 调试端口没起来')); }
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
            const timer = setTimeout(function () { delete pending[msgId]; rej(new Error('CDP 超时：' + method)); }, 25000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
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

function evalJS(send, expr) {
  return send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    .then(function (r) {
      if (r && r.exceptionDetails) {
        return { __err: (r.exceptionDetails.text || '') + ' ' +
          ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '') };
      }
      return r && r.result ? r.result.value : undefined;
    });
}

// 量一块元素的矩形 + 视口（全部取整数，断言写起来清楚）
const RECT = '(function(sel){ var e=document.querySelector(sel); if(!e) return null;' +
  ' var r=e.getBoundingClientRect(); return {x:Math.round(r.left),y:Math.round(r.top),' +
  ' w:Math.round(r.width),h:Math.round(r.height),r:Math.round(r.right),b:Math.round(r.bottom),' +
  ' vw:innerWidth,vh:innerHeight}; })';

function overlap(a, b) {
  if (!a || !b) return false;
  return a.x < b.r && b.x < a.r && a.y < b.b && b.y < a.b;
}

async function main() {
  console.log('=== 右下角战况记录 端到端（目标 ' + BASE + '）===');
  if (!fs.existsSync(CHROME)) { console.log('!! 找不到无头浏览器：' + CHROME); process.exit(1); }
  const alive = LIVE ? true : await fetch(BASE + '/api/health').then(function (r) { return r.status === 200; }).catch(function () { return false; });
  if (!alive) { console.log('!! 应用服务未就绪：' + BASE); process.exit(1); }

  await killByPort(CDP_PORT);
  const chrome = await launchChrome(1280, 800);
  const c = await connect();
  const send = c.send;
  await send('Page.enable');
  await send('Runtime.enable');
  // ★无头环境必须唤醒 rAF，否则游戏主循环不走（项目已有教训）
  await send('Page.startScreencast', { format: 'jpeg', quality: 20, everyNthFrame: 4 });

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  // ★线上必须保留分享码：平台靠首次导航的 ?sharecode= 写 cookie，
  //   丢掉它就整片 403（而 403 的错误页 DOM 里什么都没有，看起来像白屏）。
  await send('Page.navigate', {
    url: BASE + '/game.html?debug=1&_t=' + Date.now() + shareSuffix(SHARE.code)
  });
  await sleep(2600);

  // ---------- 一、选角 → 开局 ----------
  console.log('');
  console.log('[一] 开局与旧浮层清除');
  const boot = await evalJS(send, '(function(){ return { hook: !!window.VS_GAME, ' +
    ' cloak: document.getElementById("hud").hasAttribute("v-cloak"), ' +
    ' raw: document.body.innerText.indexOf("{{") >= 0 }; })()');
  ok('调试句柄已挂载（?debug=1）', boot && boot.hook === true, boot);
  ok('Vue 已渲染（无 v-cloak / 无 {{ }} 残留）', boot && !boot.cloak && !boot.raw, boot);

  const oldToast = await evalJS(send, '(function(){ return { wrap: !!document.querySelector(".toast-wrap"),' +
    ' toast: !!document.querySelector(".toast") }; })()');
  ok('★中央 .toast-wrap / .toast 已移除', oldToast && !oldToast.wrap && !oldToast.toast, oldToast);

  await evalJS(send, '(function(){ var b=document.querySelector(".overlay .btn-primary"); if(b) b.click(); return !!b; })()');
  await sleep(1200);
  const started = await evalJS(send, '(function(){ var g=window.VS_GAME; return g ? { screen:g.ui.screen,' +
    ' logs:g.ui.logs.length, keep:g.logKeep } : null; })()');
  ok('游戏已开局（screen=playing）', started && started.screen === 'playing', started);
  ok('日志上限常量已暴露（80）', started && started.keep === 80, started);

  // ---------- 二、右下角位置（桌面） ----------
  console.log('');
  console.log('[二] 桌面位置：贴在右下角，不再占屏幕中间');
  // 先推一条，保证面板出现（opening 事件可能还没到）
  await evalJS(send, '(function(){ window.VS_GAME.pushLog("位置测试：妖潮将起", false); return 1; })()');
  await sleep(300);
  const pr = await evalJS(send, RECT + '(".log-panel")');
  ok('战况记录面板存在', !!pr && pr.w > 0 && pr.h > 0, pr);
  if (pr) {
    ok('★面板贴右边（右边界距视口 < 40px）', pr.vw - pr.r < 40, pr);
    ok('★面板贴下边（底边距视口 < 200px，桌面带 debug 上移）', pr.vh - pr.b < 200, pr);
    ok('★面板不再占据画面中上部（top > 视口 40%）', pr.y > pr.vh * 0.4, pr);
    ok('面板宽度克制（≤ 视口 1/3）', pr.w <= pr.vw / 3, pr);
  }

  // ---------- 三、不消失（真时钟跨过 2.4 秒） ----------
  console.log('');
  console.log('[三] 内容常驻：旧版 2.4 秒删除，新版必须仍在');
  const mid = await evalJS(send, '(function(){ window.VS_GAME.pushLog("常驻测试：这条不能消失", true);' +
    ' return { n: window.VS_GAME.ui.logs.length }; })()');
  await sleep(3200);   // ★故意超过旧版的 2400ms
  const after = await evalJS(send, '(function(){ var g=window.VS_GAME;' +
    ' return { n: g.ui.logs.length, found: g.ui.logs.some(function(l){return l.text.indexOf("常驻测试：这条不能消失")>=0;}),' +
    ' rows: document.querySelectorAll(".log-panel .log-row").length,' +
    ' domFound: (document.querySelector(".log-panel")||{innerText:""}).innerText.indexOf("常驻测试：这条不能消失")>=0 }; })()');
  ok('推入前日志非空', mid && mid.n > 0, mid);
  ok('★★3.2 秒后日志数组条目仍在', after && after.found === true, after);
  ok('★★3.2 秒后 DOM 仍能看见那条文字', after && after.domFound === true, after);
  ok('日志条数没有减少（只进不删）', after && mid && after.n >= mid.n, { mid: mid, after: after });

  // ---------- 四、最新在上 + 时间戳 ----------
  console.log('');
  console.log('[四] 排序与时间戳');
  const order = await evalJS(send, '(function(){ var g=window.VS_GAME;' +
    ' g.pushLog("最新一条：歧路双碑开启", false);' +
    ' var l=g.ui.logs[0]; return { text:l.text, at:l.at, boss:l.boss }; })()');
  // ★Vue 的 DOM 刷新是异步的（nextTick）：同一个表达式里 push 完立刻读 innerText
  //   还是上一帧的内容，会误判成「排序错了」。必须等一帧再量。
  await sleep(250);
  const firstRow = await evalJS(send,
    '((document.querySelector(".log-panel .log-row .lg-text")||{}).innerText||"")');
  ok('★最新一条在最上面（数组）', order && /最新一条/.test(order.text), order);
  ok('★最新一条在最上面（DOM 首行）', /最新一条/.test(firstRow || ''), firstRow);
  ok('每条带 mm:ss 局内时间戳', order && /^\d\d:\d\d$/.test(order.at || ''), order);

  // ---------- 五、折叠 / 展开 ----------
  console.log('');
  console.log('[五] 折叠与展开');
  const headRect = await evalJS(send, RECT + '(".log-head")');
  ok('标题栏触摸目标 ≥44px', headRect && headRect.h >= 44, headRect);
  await evalJS(send, '(function(){ document.querySelector(".log-head").click(); return 1; })()');
  await sleep(250);
  const folded = await evalJS(send, '(function(){ return { open: window.VS_GAME.ui.logOpen,' +
    ' list: !!document.querySelector(".log-list"), peek: !!document.querySelector(".log-peek"),' +
    ' peekText: (document.querySelector(".log-peek")||{innerText:""}).innerText }; })()');
  ok('点标题栏后折叠', folded && folded.open === false && !folded.list, folded);
  ok('★折叠态仍留一条最新摘要（不静默消失）', folded && folded.peek && /最新一条/.test(folded.peekText || ''), folded);
  await evalJS(send, '(function(){ document.querySelector(".log-head").click(); return 1; })()');
  await sleep(250);
  const unfolded = await evalJS(send, '(function(){ return { open: window.VS_GAME.ui.logOpen,' +
    ' list: !!document.querySelector(".log-list") }; })()');
  ok('再点标题栏恢复展开', unfolded && unfolded.open === true && unfolded.list, unfolded);

  // ---------- 六、上限：只留最近 80 条 ----------
  console.log('');
  console.log('[六] 上限截断（防长时间局撑爆内存）');
  const capped = await evalJS(send, '(function(){ var g=window.VS_GAME;' +
    ' for(var i=0;i<100;i++) g.pushLog("压测 #"+i, false);' +
    ' var a=g.ui.logs; return { n:a.length, first:a[0].text, last:a[a.length-1].text,' +
    ' rows:document.querySelectorAll(".log-panel .log-row").length }; })()');
  ok('★推 100 条后恰好保留 80 条', capped && capped.n === 80, capped);
  ok('★丢的是最旧条目（首条是最新压测）', capped && /压测 #99/.test(capped.first || ''), capped);
  ok('末条不是最早那条（#0 已丢）', capped && !/压测 #0$/.test(capped.last || ''), capped);

  // ---------- 七、手机视口：不压技能区 ----------
  console.log('');
  console.log('[七] 390×844 窄屏：右下角但不能压住技能区');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await sleep(500);
  const mp = await evalJS(send, '(function(){ var e=document.querySelector(".log-panel");' +
    ' if(!e) return null; var r=e.getBoundingClientRect();' +
    ' return {x:Math.round(r.left),y:Math.round(r.top),r:Math.round(r.right),b:Math.round(r.bottom),' +
    ' w:Math.round(r.width),h:Math.round(r.height),vw:innerWidth,vh:innerHeight}; })()');
  const slots = await evalJS(send, RECT + '(".hud-slots,.slot-fold")');
  ok('窄屏面板仍在视口内', mp && mp.x >= 0 && mp.r <= mp.vw + 1 && mp.b <= mp.vh + 1, mp);
  ok('★窄屏面板不与底部技能区重叠', !overlap(mp, slots), { log: mp, slots: slots });
  ok('窄屏面板不占满屏宽（留出左侧技能区）', mp && mp.w <= mp.vw * 0.7, mp);

  // ---------- 八、页面无异常 ----------
  console.log('');
  console.log('[八] 控制台');
  const errs = (c.errors || []).filter(function (e) { return e && e.indexOf('favicon') < 0; });
  ok('无未捕获异常', errs.length === 0, errs.slice(0, 3));

  console.log('');
  console.log('=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  try { send('Page.stopScreencast'); } catch (e) { /* 关不关无所谓 */ }
  c.ws.close();
  chrome.kill();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('脚本异常：' + (e && e.stack || e));
  process.exit(2);
});
