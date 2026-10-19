// tools/storycheck.js —— 剧情模式端到端（真实浏览器）
//
// 用法：node tools/storycheck.js [端口|线上域名]
//
// 【这个脚本要证明什么】
// 纯逻辑测试（campaigntest）验的是「数据与规则对不对」；
// 这里要验的是「界面上真的能用」——这两件事完全不同：
//   · 脚本顺序错 → window.VS.CAMPAIGN 是 undefined → 页面白屏
//   · 模板里引用了 computed 没定义的字段 → Vue 静默不显示（不报错）
//   · 弹层写了 align-items:center → 第六关卡片被裁掉，滚不回来
//   · 节拍横条与 Boss 血条同高 → 两个东西叠在一起
// 这几类只有真浏览器才暴露得出来。

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const BASE_IN = String(process.argv[2] || '3000');
const LIVE = /^(https?:)?\/\//.test(BASE_IN);
const BASE = LIVE ? BASE_IN.replace(/\/$/, '') : ('http://127.0.0.1:' + BASE_IN);
const CDP_PORT = 9381;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_storycheck_profile';

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
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')); }
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
        ws.addEventListener('open', function () { resolve({ send: send, ws: ws, errors: errors, close: function () { ws.close(); } }); });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// ★URL 一律带 debug=1：VS_GAME 调试句柄只在 ?debug=1 下挂到 window 上
//   （见 game.js 的 `if (DEBUG)`）。不带的话所有「读运行时状态」的断言
//   都会拿到 undefined，而那种失败看起来像功能坏了，其实是测试没开门。

// 在页面里执行表达式并取回值
function evalJS(send, expr) {
  return send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true
  }).then(function (r) {
    if (r && r.exceptionDetails) {
      return { __err: (r.exceptionDetails.text || '') + ' ' +
        ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || '') };
    }
    return r && r.result ? r.result.value : undefined;
  });
}

async function main() {
  console.log('=== 剧情模式端到端（目标 ' + BASE + '）===');
  if (!fs.existsSync(CHROME)) { console.log('!! 找不到无头浏览器：' + CHROME); process.exit(1); }

  if (!LIVE) {
    const alive = await fetch(BASE + '/api/health')
      .then(function (r) { return r.status === 200; }).catch(function () { return false; });
    if (!alive) { console.log('!! 应用服务未就绪：' + BASE); process.exit(1); }
  }

  await killByPort(CDP_PORT);
  const chrome = await launchChrome(1280, 900);
  const c = await connect();
  const send = c.send;
  await send('Page.enable');
  await send('Runtime.enable');

  // ==========================================================
  // 一、大厅：剧情入口与关卡选择
  // ==========================================================
  console.log('');
  console.log('[一] 大厅：剧情入口 + 关卡选择');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  // ★先清掉本机可能残留的登录态：测试必须从「未登录」这个确定状态开始，
  //   否则上一次跑留下的 profile 会让页面直接进大厅，关卡列表里还带着旧进度
  //   （第一关变成「已通关」而不是「可挑战」）—— 那样断言就成了「看运气」。
  await send('Page.navigate', { url: BASE + '/index.html?_t=' + Date.now() });
  await sleep(2000);
  await evalJS(send, '(function(){ try { localStorage.removeItem("vs_profile"); localStorage.removeItem("vs_story_progress"); } catch(e){} return 1; })()');
  // 进度存在 localStorage，而 campaign 的名字/关卡表存在内存里 ——
  // 重载页面同时清掉两者，保证每次跑都是干净初始态。
  await send('Page.navigate', { url: BASE + '/index.html?_t=' + Date.now() });
  await sleep(3000);

  // ★默认落在 auth(登录) 页，而「剧情模式」按钮在大厅里 ——
  //   所以要先以游客身份进入。不走「注册」是因为测试不该在库里留账号。
  const guestIn = await evalJS(send, '(function(){\n' +
    '  var inp = document.querySelector(\'input[placeholder="给自己起个名字"]\');\n' +
    '  if (!inp) return { err: "no guest input", has: false };\n' +
    '  inp.value = "剧情测试";\n' +
    '  inp.dispatchEvent(new Event("input", { bubbles: true }));\n' +
    '  return { has: true };\n' +
    '})()');
  await sleep(300);
  const guestClick = await evalJS(send, '(function(){\n' +
    '  var bs = Array.prototype.slice.call(document.querySelectorAll("button"));\n' +
    '  var b = bs.filter(function(x){ return (x.innerText||"").indexOf("以游客身份进入") >= 0; })[0];\n' +
    '  if (b) b.click();\n' +
    '  return !!b;\n' +
    '})()');
  ok('能以游客身份进入大厅（测试前置）', guestIn && guestIn.has && guestClick === true,
    JSON.stringify(guestIn) + ' click=' + guestClick);
  await sleep(2200);

  // 关键模块是否加载成功（顺序错了就是 undefined，且页面会白屏）
  const mods = await evalJS(send, '(function(){\n' +
    '  return { hasVS: !!window.VS, hasCampaign: !!(window.VS && window.VS.CAMPAIGN),' +
    '   hasStory: !!(window.VS && window.VS.STORY),' +
    '   modCount: (window.VS && window.VS.CAMPAIGN) ? window.VS.CAMPAIGN.MOD_IDS.length : -1 };\n' +
    '})()');
  ok('大厅加载了 campaign.js', mods && mods.hasCampaign === true, JSON.stringify(mods));
  ok('大厅加载了 story-progress.js', mods && mods.hasStory === true, JSON.stringify(mods));

  // Vue 是否渲染完（有 v-cloak 的话未渲染不会闪）
  const cloak = await evalJS(send, '(function(){\n' +
    '  var el = document.querySelector(".app, #app, [v-cloak]");\n' +
    '  return { hasCloakAttr: document.body.innerHTML.indexOf("v-cloak") >= 0,' +
    '   raw: document.body.innerText.indexOf("{{") >= 0 };\n' +
    '})()');
  ok('页面没有残留未渲染的 {{ }}', cloak && cloak.raw === false, JSON.stringify(cloak));

  // 剧情入口按钮
  const entry = await evalJS(send, '(function(){\n' +
    '  var bs = Array.prototype.slice.call(document.querySelectorAll("button"));\n' +
    '  var b = bs.filter(function(x){ return (x.innerText||"").trim() === "剧情模式"; })[0];\n' +
    '  return b ? { found: true, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) } : { found: false };\n' +
    '})()');
  ok('大厅有「剧情模式」入口按钮', entry && entry.found === true, JSON.stringify(entry));

  // 打开关卡选择
  await evalJS(send, '(function(){\n' +
    '  var bs = Array.prototype.slice.call(document.querySelectorAll("button"));\n' +
    '  var b = bs.filter(function(x){ return (x.innerText||"").trim() === "剧情模式"; })[0];\n' +
    '  if (b) b.click(); return !!b;\n' +
    '})()');
  await sleep(700);

  let overlay = await evalJS(send, '(function(){\n' +
    '  var m = document.querySelector(".story-mask");\n' +
    '  if (!m) return { err: "no overlay" };\n' +
    '  var box = document.querySelector(".story-box");\n' +
    '  var cards = Array.prototype.slice.call(document.querySelectorAll(".story-card"));\n' +
    '  var mr = m.getBoundingClientRect();\n' +
    '  var br = box.getBoundingClientRect();\n' +
    '  var first = cards.length ? cards[0].getBoundingClientRect() : null;\n' +
    '  return {\n' +
    '    cards: cards.length,\n' +
    '    disabled: cards.map(function(x){ return !!x.disabled; }),\n' +
    '    names: cards.map(function(x){ var n = x.querySelector(".sc-name"); return n ? n.innerText.replace(/\\s+/g," ").trim() : ""; }),\n' +
    '    // ★弹层居中溢出：卡片区顶部必须在视口内\n' +
    '    boxTop: Math.round(br.top),\n' +
    '    maskAlign: getComputedStyle(m).alignItems,\n' +
    '    boxMarginTop: getComputedStyle(box).marginTop,\n' +
    '    maskH: Math.round(mr.height),\n' +
    '    boxH: Math.round(br.height),\n' +
    '    // 内容矮于容器时是否垂直居中（margin:auto 的效果）\n' +
    '    shortContentCentered: br.height < mr.height - 4\n' +
    '      ? Math.abs((br.top - mr.top) - (mr.bottom - br.bottom)) <= 3 : null,\n' +
    '    firstCardTop: first ? Math.round(first.top) : null,\n' +
    '    mods: Array.prototype.slice.call(document.querySelectorAll(".story-mod")).map(function(x){ return x.innerText.trim(); }),\n' +
    '    progress: (document.querySelector(".story-prog")||{}).innerText || ""\n' +
    '  };\n' +
    '})()');
  ok('关卡选择弹层打开了', overlay && !overlay.err, JSON.stringify(overlay && overlay.err));
  // ★断言链要能容错：overlay 拿不到时后续几条不能把脚本自己搞崩
  //   （脚本崩了就看不到「后面还有几条失败」，排查成本立刻翻倍）
  overlay = overlay || {}; overlay.names = overlay.names || []; overlay.disabled = overlay.disabled || [];
  ok('★弹层里列出 6 关', overlay.cards === 6, String(overlay.cards));
  ok('★第一关解锁、其余 5 关锁定（设了解锁门槛）',
    overlay && overlay.disabled &&
    overlay.disabled[0] === false &&
    overlay.disabled.slice(1).every(function (d) { return d === true; }),
    overlay && JSON.stringify(overlay.disabled));
  ok('★弹层不写 align-items:center（否则小屏会裁掉第一关）',
    overlay && overlay.maskAlign !== 'center', overlay && overlay.maskAlign);
  // ★不能断言 computed marginTop === 'auto' —— 浏览器会把 auto **解析成实际像素值**
  //   返回，所以那个字符串永远拿不到。要判的是「效果」：内容比视口矮时它是垂直居中的。
  //   这一条才是 margin:auto 的用途所在（而不是 align-items:center 那种会裁顶部）。
  ok('★弹层内容比视口矮时垂直居中（margin:auto 的效果，不是 align-items:center）',
    overlay && overlay.shortContentCentered === true,
    overlay && ('boxTop=' + overlay.boxTop + ' maskH=' + overlay.maskH + ' boxH=' + overlay.boxH));
  ok('★第一关卡片在视口内（顶部 >= 0）',
    overlay && overlay.firstCardTop !== null && overlay.firstCardTop >= 0,
    overlay && String(overlay.firstCardTop));
  ok('关卡名是剧情名（乱星岗 / 无色祭坛在列）',
    overlay && overlay.names.join('|').indexOf('无色祭坛') >= 0 &&
    overlay.names.join('|').indexOf('落霞坳') >= 0,
    overlay && overlay.names.join(' / '));
  ok('★有个模组切换区（可切换世界观的落地入口）',
    overlay && overlay.mods.length >= 2, overlay && JSON.stringify(overlay.mods));
  ok('进度显示「0 / 6 关」', overlay && /0\s*\/\s*6/.test(overlay.progress), overlay && overlay.progress);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(TMP + '/vs_story_lobby.png', Buffer.from(shot1.data, 'base64'));
  console.log('  截图：' + TMP + '/vs_story_lobby.png');

  // ==========================================================
  // 二、关卡选择弹层在手机竖屏下也不能裁
  // ==========================================================
  console.log('');
  console.log('[二] 手机竖屏：弹层不裁');

  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(600);
  let mobile = await evalJS(send, '(function(){\n' +
    '  var box = document.querySelector(".story-box");\n' +
    '  var cards = Array.prototype.slice.call(document.querySelectorAll(".story-card"));\n' +
    '  var list = document.querySelector(".story-list");\n' +
    '  if (!box) return { err: "no box" };\n' +
    '  var br = box.getBoundingClientRect();\n' +
    '  var first = cards.length ? cards[0].getBoundingClientRect() : null;\n' +
    '  return {\n' +
    '    boxTop: Math.round(br.top),\n' +
    '    boxW: Math.round(br.width),\n' +
    '    firstCardTop: first ? Math.round(first.top) : null,\n' +
    '    listScrollable: list ? (list.scrollHeight > list.clientHeight + 1) : null,\n' +
    '    listH: list ? Math.round(list.clientHeight) : null,\n' +
    '    closeVisible: (function(){ var cs = Array.prototype.slice.call(document.querySelectorAll(".story-box button"));\n' +
    '      var b = cs.filter(function(x){ return (x.innerText||"").trim() === "关闭"; })[0];\n' +
    '      if (!b) return null; var r = b.getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight; })()\n' +
    '  };\n' +
    '})()');
  ok('★手机竖屏下第一关卡片顶部仍 >= 0（没被居中溢出裁掉）',
    mobile && mobile.firstCardTop !== null && mobile.firstCardTop >= 0,
    mobile && String(mobile.firstCardTop));
  ok('★手机竖屏下「关闭」按钮同屏可见', mobile && mobile.closeVisible === true,
    mobile && String(mobile.closeVisible));
  ok('关卡列表自己有滚动上限（长列表不给上限就得滚过整个弹层）',
    mobile && mobile.listScrollable === true, mobile && String(mobile.listScrollable));

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(TMP + '/vs_story_lobby_phone.png', Buffer.from(shot2.data, 'base64'));
  console.log('  截图：' + TMP + '/vs_story_lobby_phone.png');

  // ==========================================================
  // 三、进第一关：卷首页
  // ==========================================================
  console.log('');
  console.log('[三] 卷首页');

  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/game.html?debug=1&mod=myth&stage=ch1&_t=' + Date.now() });
  await sleep(3600);

  const pro = await evalJS(send, '(function(){\n' +
    '  var p = document.querySelector(".panel-prologue");\n' +
    '  if (!p) return { err: "no prologue panel" };\n' +
    '  var chars = Array.prototype.slice.call(document.querySelectorAll(".pl-char"));\n' +
    '  var diffs = Array.prototype.slice.call(document.querySelectorAll(".pl-diff .pl-diffbtn"));\n' +
    '  return {\n' +
    '    title: (p.querySelector("h2")||{}).innerText || "",\n' +
    '    epigraph: (p.querySelector(".pl-epi")||{}).innerText || "",\n' +
    '    rows: Array.prototype.slice.call(p.querySelectorAll(".pl-row")).map(function(r){ return r.innerText.replace(/\\s+/g," ").trim(); }),\n' +
    '    charChips: chars.length,\n' +
    '    charDefaultOn: chars.filter(function(x){ return (" "+x.className+" ").indexOf(" def ") >= 0; }).length,\n' +
    // ★推荐角色的**显示文字**：直接从「默认高亮那个 chip」上读，而不是在测试里
    //   查名字表 —— 显示名是「本名 + 模组改名表」叠加出来的，测试自己拼容易拼错，
    //   而这个值天然就是界面上真正显示的东西。第十八轮改名时踩过：
    //   断言写死「行者」，而剧情里显示的是「斗战胜者」。
    '    recommendedCharName: (function(){ var d = chars.filter(function(x){ return (" "+x.className+" ").indexOf(" def ") >= 0; })[0];\n' +
    '      return d ? d.innerText.replace(/\\s+/g," ").trim() : null; })(),\n' +
    '    diffCount: diffs.length,\n' +
    '    panelW: Math.round(p.getBoundingClientRect().width),\n' +
    '    diffWidths: diffs.map(function(x){ return Math.round(x.getBoundingClientRect().width); }),\n' +
    '    // 并排判据：所有 chip 的纵向中心落在同一条水平线上（容差 8px）\n' +
    '    diffSameRow: (function(){ if (!diffs.length) return false;\n' +
    '      var tops = diffs.map(function(x){ var r = x.getBoundingClientRect(); return r.top + r.height / 2; });\n' +
    '      var mn = Math.min.apply(null, tops), mx = Math.max.apply(null, tops);\n' +
    '      return (mx - mn) <= 8; })(),\n' +
    '    diffRows: (function(){ var s2 = {};\n' +
    '      diffs.forEach(function(x){ var r = x.getBoundingClientRect(); s2[Math.round(r.top)] = 1; });\n' +
    '      return Object.keys(s2).length; })(),\n' +
    '    chapterDots: p.querySelectorAll(".pl-cp").length,\n' +
    '    curDot: p.querySelectorAll(".pl-cp.cur").length,\n' +
    '    buttons: Array.prototype.slice.call(p.querySelectorAll(".panel-actions button")).map(function(b){ return b.innerText.trim(); }),\n' +
    '    tip: (function(){ var t = document.querySelector(".pl-sub2");\n' +
    '      return t ? t.innerText.replace(/\\s+/g," ").trim() : ""; })(),\n' +
    '    top: Math.round(p.getBoundingClientRect().top)\n' +
    '  };\n' +
    '})()');
  ok('剧情模式进的是卷首页（不是角色选择页）', pro && !pro.err, pro && pro.err);
  ok('卷首页标题带关卡名（落霞坳）', pro && pro.title.indexOf('落霞坳') >= 0, pro && pro.title);
  ok('★卷首页有卷首题记', pro && pro.epigraph.length >= 6, pro && pro.epigraph);
  ok('卷首页列出本关要素（战场/时长/初始角色）',
    pro && pro.rows.length >= 3, pro && JSON.stringify(pro.rows));
  ok('★卷首页可换角色（8 个可选）', pro && pro.charChips === 8, pro && String(pro.charChips));
  ok('★默认高亮关卡推荐角色（1 个，且不是上一次存档的角色）',
    pro && pro.charDefaultOn === 1, pro && String(pro.charDefaultOn));
  // ★初始提示应是 v-else 那一支（「使用本关推荐角色…」），而不是「已换用…」——
  //   前者说明「你没选过，用的是关卡推荐」，后者说明「你选过了」。
  ok('★卷首页初始提示是「使用本关推荐角色」（不是「已换用」）',
    pro && pro.tip.indexOf('使用本关推荐角色') >= 0 && pro.tip.indexOf('已换用') < 0,
    pro && JSON.stringify(pro.tip));
  // ★这里判的是「提示里点名了**推荐的那个角色**」，而角色显示名走的是
  //   **剧情名字表**（本名 + 模组改名表叠加），不是数据表本名 ——
  //   第十八轮改名前两者恰好都叫「行者」，改名后剧情名变成「斗战胜者」。
  //   所以判据改成「提示里出现的是该关推荐角色的**剧情名**」。
  ok('★初始提示里点名的是本关推荐角色（按剧情名字表取）',
    pro && pro.tip.indexOf(pro.recommendedCharName) >= 0,
    pro && JSON.stringify({ tip: pro.tip, expect: pro.recommendedCharName }));
  ok('★卷首页可选难度（4 档，且不硬锁）', pro && pro.diffCount === 4, pro && String(pro.diffCount));
  // ★★难度 chip 必须**并排**在一行里。
  //   踩过的坑：复用了大厅那个 `.diff-btn`（它是三列网格卡 + width:100%），
  //   塞进 flex 行里就各自占满一整行 → 四个竖排大块。
  //   这类「复用了别的场景的类」的问题不报错、只是版面坏，只能靠量宽度抓。
  ok('★难度 chip 并排在一行（不是各自占满整行的竖排大块）',
    pro && pro.diffSameRow === true,
    pro && ('宽=' + JSON.stringify(pro.diffWidths) + ' 面板宽=' + pro.panelW + ' 行数=' + pro.diffRows));
  ok('★难度 chip 宽度远小于面板宽（说明没被 width:100% 撑满）',
    pro && pro.diffWidths && pro.diffWidths.length > 0 &&
    Math.max.apply(null, pro.diffWidths) < pro.panelW * 0.4,
    pro && JSON.stringify(pro.diffWidths));
  ok('章节进度点 6 个，当前 1 个高亮',
    pro && pro.chapterDots === 6 && pro.curDot === 1,
    pro && (pro.chapterDots + '/' + pro.curDot));
  ok('★卷首页顶部 >= 0（弹层没被裁）', pro && pro.top >= 0, pro && String(pro.top));

  const shot3 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(TMP + '/vs_story_prologue.png', Buffer.from(shot3.data, 'base64'));
  console.log('  截图：' + TMP + '/vs_story_prologue.png');

  // ==========================================================
  // 四、换角色 + 难度 → 开局 → HUD 显示剧情名
  // ==========================================================
  console.log('');
  console.log('[四] 换角色 / 难度 / 开局');

  // 点一个非默认角色（第 3 个），验证换角色生效
  const pick = await evalJS(send, '(function(){\n' +
    '  var cs = Array.prototype.slice.call(document.querySelectorAll(".pl-char"));\n' +
    '  if (cs.length < 3) return null;\n' +
    '  cs[2].click();\n' +
    '  return cs[2].innerText.trim();\n' +
    '})()');
  await sleep(400);
  const afterPick = await evalJS(send, '(function(){\n' +
    '  var cs = Array.prototype.slice.call(document.querySelectorAll(".pl-char"));\n' +
    '  var on = cs.filter(function(x){ return (" "+x.className+" ").indexOf(" on ") >= 0; });\n' +
    '  var tip = document.querySelector(".pl-sub2");\n' +
    '  return { onCount: on.length, onName: on.length ? on[0].innerText.trim() : "", tip: tip ? tip.innerText.trim() : "" };\n' +
    '})()');
  ok('★点角色能换（高亮转移，且只高亮一个）',
    afterPick && afterPick.onCount === 1 && afterPick.onName === pick,
    JSON.stringify(afterPick) + ' 点的是 ' + pick);
  ok('换角色后有提示文案',
    afterPick && afterPick.tip.indexOf('已换用') >= 0, afterPick && afterPick.tip);

  // 换难度
  const diffPick = await evalJS(send, '(function(){\n' +
    '  var ds = Array.prototype.slice.call(document.querySelectorAll(".pl-diff .pl-diffbtn"));\n' +
    '  if (ds.length < 3) return null;\n' +
    '  ds[2].click();\n' +
    '  return ds[2].innerText.trim();\n' +
    '})()');
  await sleep(350);
  const diffAfter = await evalJS(send, '(function(){\n' +
    '  var ds = Array.prototype.slice.call(document.querySelectorAll(".pl-diff .pl-diffbtn"));\n' +
    '  var on = ds.filter(function(x){ return (" "+x.className+" ").indexOf(" on ") >= 0; });\n' +
    '  var d = document.querySelector(".pl-diffdesc");\n' +
    '  return { onCount: on.length, onName: on.length ? on[0].innerText.trim() : "", desc: d ? d.innerText.trim() : "" };\n' +
    '})()');
  ok('★点难度能选中（难度不硬锁）',
    diffAfter && diffAfter.onCount === 1 && diffAfter.onName === diffPick,
    JSON.stringify(diffAfter) + ' 点的是 ' + diffPick);
  ok('难度选中后有说明文字', diffAfter && diffAfter.desc.length >= 4, diffAfter && diffAfter.desc);

  const shot4 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(TMP + '/vs_story_prologue_picked.png', Buffer.from(shot4.data, 'base64'));
  console.log('  截图：' + TMP + '/vs_story_prologue_picked.png');

  // 进入关卡
  await evalJS(send, '(function(){\n' +
    '  var bs = Array.prototype.slice.call(document.querySelectorAll(".panel-actions button"));\n' +
    '  var b = bs.filter(function(x){ return (x.innerText||"").trim() === "进入关卡"; })[0];\n' +
    '  if (b) b.click(); return !!b;\n' +
    '})()');
  await sleep(2600);

  const hud = await evalJS(send, '(function(){\n' +
    '  var w = window.VS_GAME && window.VS_GAME.world;\n' +
    '  var hudEl = document.querySelector("#hud");\n' +
    '  if (!w) return { err: "no world" };\n' +
    '  return {\n' +
    '    modId: w.modId,\n' +
    '    stageId: w.storyStage ? w.storyStage.id : null,\n' +
    '    matchSec: w.matchSec,\n' +
    '    mapId: w.map.id,\n' +
    '    charId: w.self.charId,\n' +
    '    nameTableHunter: w.nameTable ? w.nameTable.char.hunter : null,\n' +
    '    hudText: hudEl ? hudEl.innerText.replace(/\\s+/g, " ").trim() : "",\n' +
    '    chapterTag: (document.querySelector(".chapter-tag")||{}).innerText || ""\n' +
    '  };\n' +
    '})()');
  ok('★开局的 modId 是 myth（剧情模式真的生效了）',
    hud && hud.modId === 'myth', hud && String(hud.modId));
  ok('★开局关卡是 ch1，时长 240 秒',
    hud && hud.stageId === 'ch1' && hud.matchSec === 240,
    hud && (hud.stageId + ' / ' + hud.matchSec));
  ok('开局地图按关卡走（corridor）', hud && hud.mapId === 'corridor', hud && hud.mapId);
  ok('★换的角色生效了（不是关卡默认的 monk）',
    hud && hud.charId && hud.charId !== 'monk', hud && hud.charId);
  // ★断言要跟着「玩家换过的那个角色」走，不能写死成关卡默认的「行者」——
  //   脚本上面刚把角色换成文昌，HUD 就该显示「文昌」。写死会让断言与步骤脱节，
  //   表现是「功能明明对了，测试却红」。
  const pickedStoryName = await evalJS(send,
    '(function(){ var g = window.VS_GAME; if (!g || !g.world || !g.world.nameTable) return "";\n' +
    '  return g.world.nameTable.char[g.world.self.charId] || ""; })()');
  ok('★HUD 上的角色名是剧情名（' + pickedStoryName + '，不是「学者」）',
    hud && pickedStoryName && hud.hudText.indexOf(pickedStoryName) >= 0,
    hud && (pickedStoryName + ' | ' + hud.hudText.slice(0, 160)));
  ok('★HUD 上没有出现数据表本名（学者 / 猎魔人）',
    hud && hud.hudText.indexOf('学者') < 0 && hud.hudText.indexOf('猎魔人') < 0,
    hud && hud.hudText.slice(0, 160));
  ok('★HUD 有章节标「第 1 / 6 关」',
    hud && /1\s*\/\s*6/.test(hud.chapterTag), hud && hud.chapterTag);

  const shot5 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(TMP + '/vs_story_playing.png', Buffer.from(shot5.data, 'base64'));
  console.log('  截图：' + TMP + '/vs_story_playing.png');

  // ==========================================================
  // 五、节拍横条：出现、不与 Boss 血条重叠、不吃指针事件
  // ==========================================================
  console.log('');
  console.log('[五] 节拍横条');

  // 第一条节拍在 2 秒时出，等它
  await sleep(2600);
  const beat = await evalJS(send, '(function(){\n' +
    '  var b = document.querySelector(".story-beat");\n' +
    '  if (!b) return { shown: false };\n' +
    '  var r = b.getBoundingClientRect();\n' +
    '  var cs = getComputedStyle(b);\n' +
    '  return { shown: true, text: b.innerText.replace(/\\s+/g," ").trim(),\n' +
    '    top: Math.round(r.top), w: Math.round(r.width),\n' +
    '    pe: cs.pointerEvents, z: cs.zIndex };\n' +
    '})()');
  ok('★节拍横条出现了', beat && beat.shown === true, JSON.stringify(beat));
  ok('★节拍横条不吃指针事件（否则挡住走位）',
    beat && beat.pe === 'none', beat && beat.pe);
  ok('节拍横条在视口内（不是跑到屏幕外）',
    beat && beat.shown && beat.top >= 0, beat && String(beat.top));

  // ★用调试钩子主动把节拍**叫出来**，再同时造一个 Boss 血条 ——
  //   靠 sleep 去撞「节拍恰好可见」的那个 6 秒窗口是看运气的测试，
  //   而运气型的断言迟早会在某次跑里红掉，然后被人当成噪声忽略。
  const hooks = await evalJS(send, '(function(){\n' +
    '  var g = window.VS_GAME;\n' +
    '  return { hasFakeHud: !!(g && g.fakeHud), hasStoryLine: !!(g && typeof g.storyLine === "function") };\n' +
    '})()');
  ok('调试钩子齐全（fakeHud + storyLine）', hooks && hooks.hasFakeHud && hooks.hasStoryLine,
    JSON.stringify(hooks));
  await evalJS(send, '(function(){\n' +
    '  var g = window.VS_GAME;\n' +
    '  if (g && typeof g.storyLine === "function") g.storyLine("节拍重叠测试");\n' +
    '  if (g && g.fakeHud) g.fakeHud({ boss: { name: "九婴", hp: 3200, maxHp: 4200 } }, 60000);\n' +
    '  return 1;\n' +
    '})()');
  await sleep(600);
  const overlap = await evalJS(send, '(function(){\n' +
    '  var b = document.querySelector(".story-beat");\n' +
    '  var boss = document.querySelector(".boss-bar");\n' +
    '  var hb = document.querySelector(".help-btn");\n' +
    '  var res = { hasBeat: !!b, hasBoss: !!boss, hasHelp: !!hb };\n' +
    '  function box(el){ if(!el) return null; var r = el.getBoundingClientRect();\n' +
    '    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom) }; }\n' +
    '  function hit(a, c){ if(!a||!c) return null;\n' +
    '    return !(a.r <= c.l || a.l >= c.r || a.b <= c.t || a.t >= c.b); }\n' +
    '  res.beat = box(b); res.boss = box(boss); res.help = box(hb);\n' +
    '  res.beatVsBoss = hit(box(b), box(boss));\n' +
    '  res.bossVsHelp = hit(box(boss), box(hb));\n' +
    '  res.beatVsHelp = hit(box(b), box(hb));\n' +
    '  return res;\n' +
    '})()');
  ok('★节拍横条与 Boss 血条不重叠（同高会叠在一起）',
    overlap && overlap.hasBeat && overlap.hasBoss && overlap.beatVsBoss === false,
    JSON.stringify(overlap && { beat: overlap.beat, boss: overlap.boss }));
  ok('★Boss 血条与「?」按钮不重叠（上一轮修过的问题没回流）',
    overlap && overlap.hasBoss && overlap.hasHelp && overlap.bossVsHelp === false,
    JSON.stringify(overlap && { boss: overlap.boss, help: overlap.help }));

  // ==========================================================
  // 六、解锁门槛：手输 URL 也进不去未解锁的关
  // ==========================================================
  console.log('');
  console.log('[六] 解锁门槛（手输 URL 绕过测试）');

  await send('Page.navigate', { url: BASE + '/game.html?debug=1&mod=myth&stage=ch6&_t=' + Date.now() });
  await sleep(3600);
  const bypass = await evalJS(send, '(function(){\n' +
    '  var w = window.VS_GAME && window.VS_GAME.world;\n' +
    '  return { stageId: w && w.storyStage ? w.storyStage.id : null, matchSec: w ? w.matchSec : null };\n' +
    '})()');
  ok('★手输 URL 进 ch6 被降级到第一关（解锁门槛不是摆设）',
    bypass && bypass.stageId === 'ch1', JSON.stringify(bypass));

  // ==========================================================
  // 七、自由模式不受影响（回归）
  // ==========================================================
  console.log('');
  console.log('[七] 自由模式回归');

  await send('Page.navigate', { url: BASE + '/game.html?debug=1&_t=' + Date.now() });
  await sleep(3400);
  const free = await evalJS(send, '(function(){\n' +
    '  var w = window.VS_GAME && window.VS_GAME.world;\n' +
    '  var sel = document.querySelector(".character-grid");\n' +
    '  var pro = document.querySelector(".panel-prologue");\n' +
    '  var hudEl = document.querySelector("#hud");\n' +
    '  return {\n' +
    '    hasCharSelect: !!sel,\n' +
    '    hasPrologue: !!pro,\n' +
    '    modId: w ? w.modId : null,\n' +
    '    charName: w && w.nameTable ? w.nameTable.char.hunter : null,\n' +
    '    hudText: hudEl ? hudEl.innerText.replace(/\\s+/g, " ").trim() : ""\n' +
    '  };\n' +
    '})()');
  ok('★自由模式仍是角色选择页（不是卷首页）',
    free && free.hasCharSelect === true && free.hasPrologue === false, JSON.stringify(free && { sel: free.hasCharSelect, pro: free.hasPrologue }));
  // ★自由模式的名字表必须等于**数据表本名**（vanilla 模组不覆写）。
  //   名字是**内容**（第十八轮把「猎魔人」改成了「刑天」），写死字串会假红。
  //   判据改成与页面里的真实数据表比对。
  const freeCharName = await evalJS(send, '(function(){\n' +
    '  var cs = (window.VS && window.VS.CONST && window.VS.CONST.CHARACTERS) || [];\n' +
    '  for (var i = 0; i < cs.length; i++) { if (cs[i].id === "hunter") return cs[i].name; }\n' +
    '  return null;\n' +
    '})()');
  ok('★自由模式名字表是本名（vanilla 不覆写）',
    free && freeCharName && free.charName === freeCharName,
    free && (String(free.charName) + ' vs 本名 ' + freeCharName));
  ok('自由模式 HUD 没有章节标',
    free && free.hudText.indexOf('/ 6 关') < 0, free && free.hudText.slice(0, 160));

  // ==========================================================
  // 八、无 JS 异常
  // ==========================================================
  console.log('');
  console.log('[八] JS 异常检查');
  const realErrors = c.errors.filter(function (e) {
    return e && e.indexOf('favicon') < 0 && e.indexOf('net::ERR') < 0;
  });
  ok('全程无 JS 异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));

  c.close();
  chrome.kill();
  await killByPort(CDP_PORT);

  console.log('');
  console.log('========================================');
  console.log('  PASS = ' + pass + '   FAIL = ' + fail);
  console.log('========================================');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本自身出错：' + (e && e.message));
  process.exit(1);
});
