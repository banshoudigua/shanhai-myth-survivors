// tools/sbui.js —— 技能图鉴的界面实测（CDP + 真实浏览器）
//
// 为什么纯 Node 的 skillbooktest 还不够
// -----------------------------------
// skillbooktest 验的是「数据算得对」。但图鉴还有一半是**界面**，那部分只能真跑：
//   ① 顶栏那个「?」按钮点得动吗？它在 .hud-right 里（那层 pointer-events 有讲究）
//   ② 抽屉真的是「不遮战场」的吗？—— 断言它的宽度 < 视口宽的一半，
//      并且整层 pointer-events:none、只有面板本体 auto（摇杆才不会被挡）
//   ③ 联机下会不会骗人说「已暂停」？—— 断言联机时那行「世界仍在推进」在
//   ④ 四个页签都能切、条目数对得上吗？
//   ⑤ 打开图鉴时会不会顺手把世界暂停了？（单机也不该停 —— 抽屉设计上就没接screen）
//
// 用法：node tools/sbui.js [端口] [online]
//   online 传1 时用 ?room= 之外的方式模拟：直接改 ui.online=true 看提示条
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const APP_PORT = Number(process.argv[2] || 3000);
const CDP_PORT = 9341;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_sbui_profile';
const SHOT_W = TMP + '/vs_sbui_weapon.png';
const SHOT_C = TMP + '/vs_sbui_combo.png';
const SHOT_M = TMP + '/vs_sbui_mobile.png';

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
      '--disable-gpu', '--no-sandbox', '--no-proxy-server', '--no-first-run',
      '--hide-scrollbars', '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=' + w + ',' + h, 'about:blank'
    ], { stdio: 'ignore' });
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
          if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            errors.push(msg.params.entry.text || '');
          }
        });
        ws.addEventListener('open', function () { resolve({ send: send, ws: ws, errors: errors }); });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

async function evalJS(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return (r && r.result && r.result.value) || null;
}

// 读图鉴当前的 DOM 状态
const READ = `(async function(){
  await Vue.nextTick();
  await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
  var box = document.querySelector(".skillbook");
  var panel = document.querySelector(".sb-panel");
  var list = document.querySelector(".sb-list");
  var de = document.documentElement;
  var r = { open: !!box };
  if (!box) return r;
  var cs = getComputedStyle(box), ps = panel ? getComputedStyle(panel) : null;
  r.boxPointerEvents = cs.pointerEvents;
  r.panelPointerEvents = ps ? ps.pointerEvents : null;
  r.panelW = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
  r.panelRight = panel ? Math.round(panel.getBoundingClientRect().right) : 0;
  r.viewW = de.clientWidth;
  r.items = document.querySelectorAll(".sb-item").length;
  r.tabs = Array.prototype.slice.call(document.querySelectorAll(".sb-tab")).map(function(b){ return (b.innerText||"").replace(/\\s+/g,""); });
  r.tab = window.VS_GAME.ui.helpTab;
  r.hint = (document.querySelector(".sb-hint")||{}).innerText || "";
  r.firstItem = (document.querySelector(".sb-item")||{}).innerText ? document.querySelector(".sb-item").innerText.replace(/\\s+/g," ").trim().slice(0,120) : null;
  r.liveTag = !!document.querySelector(".sb-live");
  r.ownedMarks = document.querySelectorAll(".sb-item.owned").length;
  r.readyMarks = document.querySelectorAll(".sb-item.ready").length;
  r.overlay = !!document.querySelector(".overlay");
  r.scrollable = list ? (list.scrollHeight > list.clientHeight) : false;
  r.hasTpl = box.innerText.indexOf("{{") >= 0;
  return r;
})()`;

async function main() {
  console.log('=== 技能图鉴界面实测  目标 http://127.0.0.1:' + APP_PORT + ' ===');
  if (!fs.existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }
  const alive = await fetch('http://127.0.0.1:' + APP_PORT + '/api/health')
    .then(function (r) { return r.status === 200; }).catch(function () { return false; });
  if (!alive) { console.log('!! 应用服务未就绪'); process.exit(1); }

  await killByPort(CDP_PORT);
  await sleep(400);
  const chrome = await launchChrome(1600, 1000);
  const s = await connect();
  const send = s.send;
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.startScreencast', { format: 'jpeg', quality: 25, everyNthFrame: 4 });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + APP_PORT + '/game.html?debug=1&_t=' + Date.now() });
  await sleep(2600);

  // ---------- ① 选人界面就该能看到图鉴入口 ----------
  console.log('\n--- [1] 角色选择界面---');
  const sel = await evalJS(send, READ);
  ok('默认没有打开图鉴', sel.open === false);
  const hasBtn = await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll("button"));
    var b = l.filter(function(x){ return ((x.innerText||"").trim()) === "技能图鉴"; })[0];
    return { hasPanelBtn: !!b, hasTopQ: !!document.querySelector(".help-btn") };
  })()`);
  ok('选人面板里有「技能图鉴」按钮', hasBtn && hasBtn.hasPanelBtn, JSON.stringify(hasBtn));
  ok('顶栏也有 ? 按钮', hasBtn && hasBtn.hasTopQ, JSON.stringify(hasBtn));

  // ---------- ② 开局 + 顶栏 ? 按钮 ----------
  console.log('\n--- [2] 对局中点顶栏 ? ---');
  await evalJS(send, '(function(){ window.VS_GAME.start(); return 1; })()');
  await sleep(900);
  const beforeTick = await evalJS(send, 'window.VS_GAME.tick');
  const clicked = await evalJS(send, `(function(){
    var b = document.querySelector(".help-btn");
    if (!b) return "no-btn";
    b.click(); return "clicked";
  })()`);
  await sleep(500);
  ok('点得到顶栏的 ? 按钮', clicked === 'clicked', String(clicked));
  const w = await evalJS(send, READ);

  ok('抽屉打开了', w.open === true);
  ok('模板已渲染（没有残留 {{ }}）', w.hasTpl === false);
  ok('武器页签有 4 个', w.tabs && w.tabs.length === 4, JSON.stringify(w.tabs));
  ok('默认停在武器页', w.tab === 'weapon', String(w.tab));
  ok('武器 17 条', w.items === 17, String(w.items));
  ok('列表可滚动（54 条内容塞得下）', w.scrollable === true, 'scrollable=' + w.scrollable);

  // ★核心断言：抽屉不遮战场
  ok('整层不吃指针事件（摇杆/按住走位不被挡）', w.boxPointerEvents === 'none', w.boxPointerEvents);
  ok('只有面板本体吃事件', w.panelPointerEvents === 'auto', w.panelPointerEvents);
  ok('抽屉宽度不足视口一半（战场左侧全程可见）',
    w.panelW < w.viewW * 0.5, w.panelW + ' / ' + w.viewW);
  ok('抽屉贴在屏幕右边', Math.abs(w.panelRight - w.viewW) <= 2, w.panelRight + ' vs ' + w.viewW);
  ok('没有弹出全屏 .overlay 遮罩', w.overlay === false);

  // ★世界不该被图鉴停住（单机也不停 —— 抽屉设计上就没接 screen）
  await sleep(1200);
  const afterTick = await evalJS(send, 'window.VS_GAME.tick');
  ok('开着图鉴世界照样推进（不会被偷偷冻结）', afterTick > beforeTick,
    beforeTick + ' -> ' + afterTick);

  const fs1 = fs;
  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs1.writeFileSync(SHOT_W, Buffer.from(shot1.data, 'base64'));
  console.log('  截图：' + SHOT_W);

  // ---------- ③ 切到组合技页 ----------
  console.log('\n--- [3] 切页签 ---');
  await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-tab"));
    var b = l.filter(function(x){ return (x.innerText||"").indexOf("组合技") >= 0; })[0];
    if (b) b.click();
    return 1;
  })()`);
  await sleep(400);
  const cb = await evalJS(send, READ);
  ok('切到组合技页', cb.tab === 'combo', String(cb.tab));
  ok('组合技 13 条', cb.items === 13, String(cb.items));
  ok('组合技页带配方提示', cb.hint.indexOf('两件武器') >= 0, cb.hint);
  // 造一个「配方已齐」的场景：直接给玩家发两件 5 级武器
  await evalJS(send, `(function(){
    var g = window.VS_GAME;
    g.hud.weapons = [{id:'whip',name:'铁鞭',level:5,evolved:false},{id:'garlic',name:'蒜雾',level:5,evolved:false}];
    return 1;
  })()`);
  await sleep(400);
  // ★持有标记要在**武器页**看：组合技页的「已持有」指的是组合技本身解锁了没有，
  //   而这里发的是两件武器（组合技还没解锁）。断言写错位置会让人误以为功能坏了。
  await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-tab"));
    var b = l.filter(function(x){ return (x.innerText||"").indexOf("武器") >= 0; })[0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(400);
  const wp = await evalJS(send, READ);
  ok('武器页：持有标记亮起（2 件）', wp.ownedMarks === 2, 'owned=' + wp.ownedMarks);
  const whipRow = await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-item"));
    for (var i=0;i<l.length;i++){
      if ((l[i].innerText||"").indexOf("铁鞭") >= 0 && l[i].className.indexOf("owned") >= 0) {
        return l[i].innerText.replace(/\\s+/g," ").trim().slice(0,160);
      }
    }
    return null;
  })()`);
  ok('铁鞭那条显示 Lv5、且带出「起始」与「组合」交叉信息',
    !!whipRow && whipRow.indexOf('Lv5') >= 0 && whipRow.indexOf('猎魔人') >= 0 &&
    whipRow.indexOf('血雾领域') >= 0, whipRow);

  // 回组合技页验配方
  await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-tab"));
    var b = l.filter(function(x){ return (x.innerText||"").indexOf("组合技") >= 0; })[0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(400);
  const comboReady = await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-item"));
    for (var i=0;i<l.length;i++){
      if ((l[i].innerText||"").indexOf("血雾领域") >= 0) {
        return { text: l[i].innerText.replace(/\\s+/g," ").trim().slice(0,140),
                 ready: l[i].className.indexOf("ready") >= 0 };
      }
    }
    return null;
  })()`);
  ok('血雾领域被标成「已齐」（两件 5 级齐了）', comboReady && comboReady.ready === true,
    JSON.stringify(comboReady));
  ok('血雾领域条目的文案正确', comboReady && comboReady.text.indexOf('铁鞭 Lv5') >= 0 &&
    comboReady.text.indexOf('已齐') >= 0, comboReady && comboReady.text);

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs1.writeFileSync(SHOT_C, Buffer.from(shot2.data, 'base64'));
  console.log('  截图：' + SHOT_C);

  // ---------- ④ 被动页 ----------
  await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-tab"));
    var b = l.filter(function(x){ return (x.innerText||"").indexOf("被动") >= 0; })[0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(350);
  const ps = await evalJS(send, READ);
  ok('切到被动页', ps.tab === 'passive', String(ps.tab));
  ok('被动 14 条', ps.items === 14, String(ps.items));

  await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-tab"));
    var b = l.filter(function(x){ return (x.innerText||"").indexOf("进化") >= 0; })[0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(350);
  const ev = await evalJS(send, READ);
  ok('切到进化页', ev.tab === 'evo', String(ev.tab));
  ok('进化 10 条', ev.items === 10, String(ev.items));

  // ---------- ⑤ 联机：必须写明「世界仍在推进」 ----------
  console.log('\n--- [4] 联机语义 ---');
  await evalJS(send, '(function(){ window.VS_GAME.ui.online = true; return 1; })()');
  await sleep(350);
  const on = await evalJS(send, READ);
  ok('联机时显示「世界仍在推进」', on.liveTag === true, 'liveTag=' + on.liveTag);
  const liveText = await evalJS(send, '(document.querySelector(".sb-live")||{}).innerText || ""');
  ok('提示文案里没有「暂停」二字', liveText.indexOf('暂停') < 0, liveText);
  // 还原
  await evalJS(send, '(function(){ window.VS_GAME.ui.online = false; return 1; })()');

  // ---------- ⑥ Esc 优先收图鉴，不去动 screen ----------
  console.log('\n--- [5] Esc 行为 ---');
  const screenBefore = await evalJS(send, 'window.VS_GAME.screen');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
  await sleep(400);
  const afterEsc = await evalJS(send, READ);
  ok('Esc 关掉了图鉴', afterEsc.open === false);
  const screenAfter = await evalJS(send, 'window.VS_GAME.screen');
  ok('Esc 顺手把界面也切了？（不该发生 —— 一次按键只干一件事）',
    screenAfter === screenBefore, screenBefore + ' -> ' + screenAfter);

  // 再按一次 Esc 才轮到暂停
  await send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, code: 'Escape', key: 'Escape' });
  await sleep(400);
  const paused = await evalJS(send, 'window.VS_GAME.screen');
  ok('第二次 Esc 才暂停', paused === 'paused', String(paused));

  // ---------- ⑦ 关闭按钮 ----------
  await evalJS(send, '(function(){ window.VS_GAME.screen = "playing"; return 1; })()');
  await evalJS(send, '(function(){ document.querySelector(".help-btn").click(); return 1; })()');
  await sleep(350);
  await evalJS(send, `(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll(".sb-head button"));
    if (l[0]) l[0].click(); return 1;
  })()`);
  await sleep(350);
  const closed = await evalJS(send, READ);
  ok('「关闭」按钮能收起抽屉', closed.open === false);

  // ---------- ⑧ 手机窄屏 ----------
  console.log('\n--- [6] 手机竖屏 390 ---');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 2, mobile: true
  });
  // ★★必须**同时开触摸模拟**：只改视口宽度是不够的。
  //   本项目有多处规则是按「操作方式」而不是「宽度」分流的（如 `@media (pointer: fine)`
  //   里的面板放大），而无头浏览器**默认是 pointer:fine** ——
  //   不开触摸的话，这个「手机剖面」量到的其实是**桌面规则**，跟真手机不是同一个版面。
  //   【实测踩过】`.sb-panel` 在 fine 段有一条 `min(470px, 92vw)`（文件末尾、同权重会盖掉
  //   前面窄屏段的 `width:100%`），于是这里量出 359 而不是 390 —— 白报一条 FAIL。
  //   补上触摸后：fine 段不命中 → 走窄屏段 100% → 390 ✓ 这才是真手机的样子。
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(500);
  await evalJS(send, '(function(){ document.querySelector(".help-btn").click(); return 1; })()');
  await sleep(500);
  const mob = await evalJS(send, READ);
  ok('窄屏下抽屉占满整屏（92vw 会留一条缝，反而更难读）',
    Math.abs(mob.panelW - mob.viewW) <= 2, mob.panelW + ' / ' + mob.viewW);
  const mobOverflow = await evalJS(send, `(function(){
    var de = document.documentElement;
    var bad = [];
    Array.prototype.slice.call(document.querySelectorAll(".sb-panel *")).forEach(function(el){
      var r = el.getBoundingClientRect();
      if (r.width < 1) return;
      if (r.right > de.clientWidth + 1) bad.push((el.className||el.tagName)+":"+Math.round(r.right));
    });
    return { overflowX: de.scrollWidth > de.clientWidth + 1, bad: bad.slice(0,5) };
  })()`);
  ok('窄屏下没有横向溢出', mobOverflow.overflowX === false &&
    mobOverflow.bad.length === 0, JSON.stringify(mobOverflow));
  const shot3 = await send('Page.captureScreenshot', { format: 'png' });
  fs1.writeFileSync(SHOT_M, Buffer.from(shot3.data, 'base64'));
  console.log('  截图：' + SHOT_M);
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await send('Emulation.clearDeviceMetricsOverride');

  // ---------- 收尾 ----------
  const errs = s.errors.filter(function (e) {
    // v-cloak / favicon 之类与本功能无关的噪声不报
    return e && e.indexOf('favicon') < 0;
  });
  ok('页面没有 JS 异常 / console error', errs.length === 0, errs.slice(0, 3).join(' || '));

  await send('Page.stopScreencast');
  s.ws.close();
  chrome.kill();
  await killByPort(CDP_PORT);

  console.log('\n  PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

setTimeout(function () { console.log('!! 总超时 180 秒'); process.exit(2); }, 180000);
main().catch(function (e) { console.log('脚本出错：' + (e && e.stack || e)); process.exit(1); });
