// tools/artshot.js —— 本轮美术/形象改动的视觉验证（真实浏览器截图）
//
// 【为什么必须单独写一个】本轮的核心交付是「看得见的东西」：
// 8 个角色在战场上各长得不一样、4 只 Boss 形象递进、大经验球要能一眼认出来、
// 手机上的 HUD 不许挤成一团。这些**全部无法用断言证明** ——
// 断言只能证明「数据对了」，而这一轮要的恰恰是「画面对了」。
//
// 覆盖：
//   [1] 角色选择页：8 张卡片，每张立绘不同
//   [2] 战场角色形象：8 个角色各画一遍，横排对照
//   [3] 四个关卡的怪种差异（改 wave 强制推进关卡，各截一张）
//   [4] 四只 Boss 的形象差异
//   [5] 大经验球与小球同时出现（掉落分级）
//   [6] 手机竖屏 / 手机横屏的 HUD 与升级面板
//
// 用法：node tools/artshot.js [端口]
// 依赖：先启动 server/index.js

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const ARG = String(process.argv[2] || 3000);
const BASE = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9338;                  // 别撞 9336（netcheck）/ 9337（specui）
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_artshot_profile';

const SHOT_SELECT = TMP + '/vs_art_select.png';
// 8 张立绘的对照图（选择页上锁定的卡片是暗的，看不清，所以另画一张）
const SHOT_PORTRAITS = TMP + '/vs_art_portraits.png';
const SHOT_CHARS = TMP + '/vs_art_characters.png';
const SHOT_STAGE = TMP + '/vs_art_stage.png';       // 四关怪种拼图
const SHOT_BOSS = TMP + '/vs_art_boss.png';         // 四只 Boss 拼图
const SHOT_ORBS = TMP + '/vs_art_orbs.png';         // 大球 / 小球
const SHOT_PHONE_V = TMP + '/vs_art_phone_portrait.png';
const SHOT_PHONE_H = TMP + '/vs_art_phone_landscape.png';
const SHOT_PC_PANEL = TMP + '/vs_art_pc_panel.png';   // PC 升级面板（放大 + 像素风）
const SHOT_LOBBY = TMP + '/vs_art_lobby.png';         // 大厅（像素风）
const SHOT_PHONE_LOBBY = TMP + '/vs_art_phone_lobby.png';       // 手机大厅（390）
const SHOT_PHONE_LOBBY_320 = TMP + '/vs_art_phone_lobby_320.png'; // 手机大厅（320 超窄）

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function killByPort(port) {
  return new Promise(function (resolve) {
    const cp = spawn('node', ['-e',
      'try{const o=require("child_process").execSync("netstat -ano").toString();' +
      'const l=o.split("\\n").filter(function(x){return x.indexOf(":' + port + ' ")>=0 && x.indexOf("LISTENING")>=0;});' +
      'const pids={};l.forEach(function(x){const p=x.trim().split(/\\s+/).pop();pids[p]=1;});' +
      'Object.keys(pids).forEach(function(p){try{require("child_process").execSync("taskkill /F /PID "+p);}catch(e){}});' +
      '}catch(e){} console.log("ok");'
    ], { stdio: 'ignore' });
    cp.on('exit', function () { resolve(); });
  });
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      '--window-size=1280,860',
      '--force-device-scale-factor=1',
      'about:blank'
    ];
    const cp = spawn(CHROME, args, { stdio: 'ignore' });
    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        clearInterval(t);
        res.resume();
        resolve(cp);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口没起来')); }
      });
    }, 500);
  });
}

function connect(tag) {
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
            const msgId = ++id;
            const timer = setTimeout(function () {
              delete pending[msgId];
              rej(new Error('CDP 超时：' + method));
            }, 15000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            const ex = d.exception || {};
            // 【为什么记这么细】只记 d.text 的话，页面抛异常时往往只拿到 "Uncaught"
            // 三个字（真正的信息在 exception.description 与行号里），排查等于瞎猜。
            pageErrors.push(
              (d.text || '') +
              (ex.description ? (' :: ' + String(ex.description).split('\n')[0]) : '') +
              ((d.url || d.lineNumber !== undefined)
                ? (' @ ' + (d.url || '') + ':' + (d.lineNumber || 0) + ':' + (d.columnNumber || 0))
                : '')
            );
          }
        });
        ws.addEventListener('open', function () {
          send('Runtime.enable');
          send('Page.enable');
          // ★禁用缓存：无头浏览器用的是固定 profile，改完 CSS/JS 再跑很容易
          // 命中启发式缓存 —— 表现是「明明改了却没生效」，极容易被误判成
          // 选择器写错或样式没加上。本轮就因为没禁缓存，白查了一轮
          // （成员行的修复看着没生效，其实是拿到的旧 CSS）。
          send('Network.enable').then(function () {
            return send('Network.setCacheDisabled', { cacheDisabled: true });
          });
          resolve({
            tag: tag,
            send: send,
            pageErrors: pageErrors,
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', {
                expression: expr, returnByValue: true, awaitPromise: true
              });
              if (r && r.exceptionDetails) {
                // 【为什么要带表达式片段】只记一句 "Uncaught" 完全定位不到是哪一句 ——
                // 这个脚本里有十几处 eval。把出错表达式的前 60 字带上，一眼就能对上。
                const d = r.exceptionDetails;
                const ex = d.exception || {};
                pageErrors.push('eval 异常 [' +
                  String(expr).replace(/\s+/g, ' ').slice(0, 60) + '] ' +
                  (d.text || '') +
                  (ex.description ? (' :: ' + String(ex.description).split('\n')[0]) : ''));
                return null;
              }
              return r && r.result ? r.result.value : null;
            },
            // beyond=true 时截「整页」：角色选择页有 8 张卡，视口一屏放不下，
            // 只截视口的话看不到全部形象 —— 而「8 个角色各不相同」正是要验的东西。
            shot: async function (path, clip, beyond) {
              const p = { format: 'png' };
              if (beyond) p.captureBeyondViewport = true;
              if (clip) p.clip = Object.assign({ scale: 1 }, clip);
              const r = await send('Page.captureScreenshot', p);
              if (r && r.data) fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
            },
            metrics: async function () {
              const m = await send('Page.getLayoutMetrics');
              return (m && m.cssContentSize) || null;
            },
            setDevice: async function (w, h, mobile) {
              // ★顺序要紧：**先**设置触摸模拟，**再**设视口尺寸。
              // 反过来的话，从手机视口切回 PC 视口时 touch 模拟还留着，
              // `(pointer: fine)` 就不匹配 —— 而 PC 专属的样式（技能面板放大）
              // 全挂在那条媒体查询下，于是「切回 PC 后放大失效」，
              // 表现为一串莫名其妙的字号断言失败（本轮踩到）。
              // ★为什么要同时开 touch：只设 mobile:true 不足以让
              // `(pointer: coarse)` 匹配，触摸相关的样式（44px 触摸目标）
              // 就永远测不到 —— 大厅按钮一直偏小却没被自动化发现，就是这个原因。
              // ★不要传 `maxTouchPoints: 0` —— 实测这个值会让整次调用不生效，
              // 触摸模拟一直留着，于是切回 PC 后 `(pointer: fine)` 仍不匹配，
              // PC 专属样式（技能面板放大）全部失效。只传 enabled 就够了。
              await send('Emulation.setTouchEmulationEnabled', { enabled: !!mobile });
              await send('Emulation.setDeviceMetricsOverride', {
                width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile
              });
            },
            navigate: async function (url) {
              await send('Page.navigate', { url: url });
            },
            close: function () { try { ws.close(); } catch (e) { } }
          });
        });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错')); });
      });
    });
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  console.log('   （等待超时：' + label + '）');
  return null;
}

let pass = 0, fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  ->  ' + detail : '')); }
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('');
  console.log('=== 本轮形象改动视觉验证（' + BASE + '） ===');

  await killByPort(CDP_PORT);
  const chrome = await launchChrome();

  try {
    // ----------------------------------------------------------
    // [1] 角色选择页（单机入口就是它）
    // ----------------------------------------------------------
    const P = await connect('角色选择');
    // 【先把视口调高再进页面】8 张角色卡排下来面板接近 2000px，
    // 而默认视口只有 860px —— headless shell 的 captureBeyondViewport 不生效，
    // 结果只能截到视口那一块（还带偏移）。把视口撑高，一屏就能装下整块面板。
    await P.setDevice(1280, 2050, false);
    await P.navigate(BASE + '/game.html?debug=1');
    const selReady = await waitFor(async function () {
      const r = await P.eval('(function(){var a=document.getElementById("hud");' +
        'return a && !a.hasAttribute("v-cloak") ? 1 : null;})()');
      return r;
    }, 20000, '角色选择页渲染');
    expect('[1] 角色选择页渲染完成', !!selReady);

    const cards = await P.eval('(function(){' +
      'var list = document.querySelectorAll(".char-card");' +
      'var names = [];' +
      'for (var i = 0; i < list.length; i++) {' +
      '  var n = list[i].querySelector(".char-name");' +
      '  names.push(n ? (n.innerText||"").trim() : "?");' +
      '}' +
      'return { n: list.length, names: names };' +
      '})()');
    console.log('   卡片：' + (cards && cards.n) + ' 张 -> ' + (cards && cards.names.join(' / ')));
    expect('[1] 角色卡片数量 = 8', !!(cards && cards.n === 8), JSON.stringify(cards && cards.n));

    // 数值是否真的随角色变化（这是「卡片显示真实数值」那一处改动）
    const stats = await P.eval('(function(){' +
      'var list = document.querySelectorAll(".char-card");' +
      'var out = [];' +
      'for (var i = 0; i < list.length; i++) {' +
      '  var v = list[i].querySelectorAll(".stat-value");' +
      '  var arr = [];' +
      '  for (var k = 0; k < v.length; k++) arr.push((v[k].innerText||"").trim());' +
      '  out.push(arr.join("/"));' +
      '}' +
      'return out;' +
      '})()');
    console.log('   数值：' + (stats && stats.join('  ')));
    const uniq = (stats || []).filter(function (x, i, a) { return a.indexOf(x) === i; });
    expect('[1] 各角色的数值不再完全相同（原来 8 张卡都是 100/120/200）',
      uniq.length > 1, JSON.stringify(stats));

    // 截图范围取**面板本身**而不是整个页面：
    // 选择页的 overlay 是垂直居中的，截整页会在上下留出大片空白 ——
    // 看图的人得在一堆黑边里找卡片。另外整页高过视口，headless shell 的
    // captureBeyondViewport 不一定认，结果只截到视口那一块（还带着偏移）。
    const panelRect = await P.eval('(function(){' +
      'var el = document.querySelector(".panel");' +
      'if (!el) return null;' +
      'var r = el.getBoundingClientRect();' +
      'return { x: Math.max(0, Math.floor(r.x)), y: Math.max(0, Math.floor(r.y)),' +
      '  width: Math.ceil(r.width), height: Math.ceil(r.height) };' +
      '})()');
    if (panelRect) {
      // 四边多留 12px：卡片有 hover 位移与阴影，贴着边截会把框切掉
      await P.shot(SHOT_SELECT, {
        x: Math.max(0, panelRect.x - 12),
        y: Math.max(0, panelRect.y - 12),
        width: panelRect.width + 24,
        height: panelRect.height + 24
      }, true);
      console.log('   截图（面板 ' + panelRect.width + 'x' + panelRect.height + '）：' + SHOT_SELECT);
    } else {
      await P.shot(SHOT_SELECT);
      console.log('   截图（未找到面板，退化为整屏）：' + SHOT_SELECT);
    }

    // ----------------------------------------------------------
    // [1b] 8 张立绘对照图
    // ----------------------------------------------------------
    // 【为什么不能只截选择页】选择页上未选中的卡片是**暗的** —— 游客身份下
    // 除了猎魔人都被锁定（guestAllowed），锁定的卡片降透明度显示。
    // 那是正确行为，但截图里看不清另外 7 张立绘到底长什么样，也就验不了配色。
    // 这里直接调立绘函数把 8 张并排画出来，一屏看清。
    //
    // ★★必须先「等图加载完」再画（第十九轮加的 AI 立绘是异步加载的）：
    //   renderPortrait 是「图优先、没到就先用程序化版顶上」。异步图在截图那一刻
    //   很可能还没到 → 截到的是兜底版 → 断言会误判成「立绘没换成功」，
    //   而真正的错误方向完全错（要去查图片加载，而不是查绘图）。
    //   所以先等 isLoaded 全为 true（带超时上限，绝不无限等）。
    await P.eval([
      '(async function(){',
      '  var PT = window.VS && window.VS.CharacterPortraits;',
      '  var C = window.VS && window.VS.CONST;',
      '  if (!PT || !C || !C.CHARACTERS) return "NO_MODULE";',
      '  var ids = C.CHARACTERS.map(function (c) { return c.id; });',
      // 触发加载：先画一次到离屏 canvas，图片才会开始请求
      '  for (var i = 0; i < ids.length; i++) {',
      '    var t = document.createElement("canvas"); t.width = t.height = 150;',
      '    PT.renderPortrait(t, ids[i], 150);',
      '  }',
      '  var deadline = Date.now() + 8000;',
      '  while (Date.now() < deadline) {',
      '    var ok = ids.every(function (id) { return PT.isLoaded(id); });',
      '    if (ok) return "ALL_LOADED";',
      '    await new Promise(function(r){ setTimeout(r, 100); });',
      '  }',
      '  return "TIMEOUT:" + ids.filter(function(id){ return !PT.isLoaded(id); }).join(",");',
      '})()'
    ].join('\n'));

    // ★等图到位之后**再画一次**：第一次调用时图还在飞，canvas 上是程序化兜底版；
    //   load 回调把图补画上去，但那是**在另一个 canvas 上**（第一次那批离屏 canvas）。
    //   真正要截图的这批是下面新建的 —— 必须重画，否则截到的又是兜底版
    //   （症状：isLoaded 全绿、断言全过，截图却是 8 个空框）。
    const portraitDrawn = await P.eval([
      '(async function(){',
      '  var PT = window.VS && window.VS.CharacterPortraits;',
      '  var C = window.VS && window.VS.CONST;',
      '  if (!PT || !PT.renderPortrait) return "NO_MODULE";',
      '  if (!C || !C.CHARACTERS) return "NO_CONST";',
      '  var ids = C.CHARACTERS.map(function (c) { return c.id; });',
      '  var names = {};',
      '  C.CHARACTERS.forEach(function (c) { names[c.id] = c.name; });',
      '  var size = 150, pad = 14, gap = 8;',
      '  var old = document.getElementById("art-portraits"); if (old) old.remove();',
      '  var wrap = document.createElement("div");',
      '  wrap.id = "art-portraits";',
      '  wrap.style.cssText = "position:fixed;left:0;top:0;z-index:99998;background:#12141a;' +
      'padding:" + pad + "px;display:grid;grid-template-columns:repeat(4," + size + "px);gap:" + gap + "px;";',
      '  for (var i = 0; i < ids.length; i++) {',
      '    var cell = document.createElement("div");',
      '    cell.style.cssText = "text-align:center;";',
      '    var cv = document.createElement("canvas");',
      '    cv.width = size; cv.height = size;',
      '    cv.style.cssText = "display:block;background:#1a1d24;border-radius:10px;";',
      // ★图已在缓存里，这次是同步命中 —— drawImage 立即执行，截到的一定是真图
      '    PT.renderPortrait(cv, ids[i], size);',
      '    var lab = document.createElement("div");',
      '    lab.textContent = names[ids[i]];',
      '    lab.style.cssText = "margin-top:4px;color:#EFEAE0;font:14px sans-serif;";',
      '    cell.appendChild(cv); cell.appendChild(lab);',
      '    wrap.appendChild(cell);',
      '  }',
      '  document.body.appendChild(wrap);',
      // 等两帧，确保 canvas 的绘制结果已经提交到合成器
      '  await new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });',
      '  var r = wrap.getBoundingClientRect();',
      '  return { n: ids.length, w: Math.ceil(r.width), h: Math.ceil(r.height),',
      '           loaded: ids.filter(function(id){ return PT.isLoaded(id); }).length };',
      '})()'
    ].join('\n'));

    // ★再验一次「canvas 上真的画上了东西」：isLoaded 只说明**图片下载完了**，
    //   不代表**画到 canvas 上了**。第一版就栽在这：图加载成功、断言全绿，
    //   但截图是 8 个空框 —— 那批 canvas 是图画好之前建的，
    //   而 load 回调补画的是**另一批**（第一次触发加载用的离屏 canvas）。
    const pdInk = await P.eval(`(function(){
      var cvs = document.querySelectorAll('#art-portraits canvas');
      var inked = 0;
      for (var i = 0; i < cvs.length; i++) {
        try {
          var cv = cvs[i];
          var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
          // 背景是 #1a1d24；偏离背景足够的像素算「有内容」
          var hit = 0;
          for (var p = 0; p < d.length; p += 4 * 97) {
            if (Math.abs(d[p] - 26) + Math.abs(d[p+1] - 29) + Math.abs(d[p+2] - 36) > 24) hit++;
          }
          if (hit > 20) inked++;
        } catch (e) { /* 跨域污染会抛，忽略 */ }
      }
      return { n: cvs.length, inked: inked };
    })()`);
    const pd = portraitDrawn || {};
    console.log('   立绘对照图：' + pd.n + ' 张，' + pd.w + 'x' + pd.h);
    expect('[1b] 8 张选择页立绘全部画出', pd.n === 8, JSON.stringify(portraitDrawn));
    // ★第十九轮新增：AI 立绘（public/img/char/*.png）必须**真的加载到了**。
    //   为什么要有这条：renderPortrait 是「图优先、没到先用程序化版顶上」，
    //   所以图挂了（发布漏文件 / 路径写错 / 服务器 404）时界面**照常显示**，
    //   只是变成程序化头像 —— 玩家看不出来，但「已经换成 AI 立绘」这件事悄悄失效了。
    //   而上面那条 `pd.n === 8` 照样是绿的（8 个 canvas 都建了）。
    //   ★所以必须单独盯「图有没有加载成功」这个**机制**，而不是「canvas 有没有建」。
    expect('[1b] 8 张 AI 立绘图都加载成功（不是程序化兜底版）',
      pd.loaded === 8, 'loaded=' + pd.loaded + '（缺失就是 public/img/char/ 下的图没取到）');
    expect('[1b] 8 个 canvas 上真的画上了像素（不只是图下载完了）',
      pdInk && pdInk.inked === 8, JSON.stringify(pdInk));
    if (pd.n === 8) {
      await P.shot(SHOT_PORTRAITS, { x: 0, y: 0, width: pd.w, height: pd.h });
      console.log('   截图：' + SHOT_PORTRAITS);
    }
    // 撤掉对照图，别挡住后面的战场截图
    await P.eval('(function(){ var e = document.getElementById("art-portraits"); if (e) e.remove(); return 1; })()');

    // ----------------------------------------------------------
    // [2] 8 个角色在战场上的形象（直接调 player-art 画一张对照图）
    // ----------------------------------------------------------
    // 【为什么直接调 player-art 而不是开 8 局】战场上同一时刻只会有一个自己，
    // 要在一张图里横向对比 8 个形象，最直接的办法就是把画法本身画出来。
    // 这也是美术改动最该验证的东西：8 个形象**互相区分得开**。
    //
    // 【为什么拆成两步 eval】一次 eval 里做太多事，任何一步出错都只表现为
    // 「返回 null」，完全看不出卡在哪 —— 拆开后能直接定位到「模块没加载」
    // 还是「画的时候抛了」。
    const paInfo = await P.eval('(function(){' +
      'var PA = window.VS && window.VS.PLAYER_ART;' +
      'if (!PA) return "NO_MODULE";' +
      'if (!PA.paint) return "NO_PAINT";' +
      'return PA.ids.join(",");' +
      '})()');
    console.log('   PLAYER_ART 导出的画法：' + paInfo);
    expect('[2] player-art.js 已加载并导出全部角色画法',
      !!(paInfo && paInfo !== 'NO_MODULE' && paInfo !== 'NO_PAINT' &&
        paInfo.indexOf('hunter') >= 0 && paInfo.split(',').length === 8),
      String(paInfo));

    const artDrawn = await P.eval('(function(){' +
      'var PA = window.VS.PLAYER_ART;' +
      'var ids = PA.ids;' +
      'var cell = 130, pad = 16;' +
      'var cv = document.createElement("canvas");' +
      'cv.id = "art-compare";' +
      'cv.width = pad * 2 + cell * 4;' +
      'cv.height = pad * 2 + cell * 2 + 40;' +
      'cv.style.position = "fixed";' +
      'cv.style.left = "0";' +
      'cv.style.top = "0";' +
      'cv.style.zIndex = "99999";' +
      'cv.style.background = "#12141a";' +
      'var g = cv.getContext("2d");' +
      'if (!g) return "NO_CTX";' +
      'var names = { hunter: "刑天", nun: "后土", scholar: "文昌", blacksmith: "祝融",' +
      ' knight: "玄武", thief: "窃火", witch: "魃", monk: "行者" };' +
      'for (var i = 0; i < ids.length; i++) {' +
      '  var col = i % 4;' +
      '  var row = Math.floor(i / 4);' +
      '  var cx = pad + col * cell + cell / 2;' +
      '  var cy = pad + row * cell + cell / 2 + 10;' +
      '  PA.paint(g, ids[i], cx, cy, 34);' +
      '  g.fillStyle = "#EFEAE0";' +
      '  g.font = "16px sans-serif";' +
      '  g.textAlign = "center";' +
      '  g.fillText(names[ids[i]] || ids[i], cx, cy + 74);' +
      '}' +
      'document.body.appendChild(cv);' +
      'return ids.length;' +
      '})()');
    console.log('   已画出 ' + artDrawn + ' 个角色形象（放大到 r=34 便于看清特征）');
    expect('[2] 8 个角色形象全部画出', artDrawn === 8, String(artDrawn));

    if (artDrawn === 8) {
      await P.shot(SHOT_CHARS, { x: 0, y: 0, width: 130 * 4 + 32, height: 130 * 2 + 72 });
      console.log('   截图：' + SHOT_CHARS);
    }

    // ----------------------------------------------------------
    // [2b] 配色自检：三处色表一致 + 区分度 + 禁紫
    // ----------------------------------------------------------
    // 【为什么要专门断言这三件事】改一次配色要同时动三个文件（const.js 的 accent、
    // 战场画法 player-art.js、选择页立绘 character-portraits.js），
    // 而**漏改的任何一处都不会报错**：角色照样画出来，只是选择页和战场上不是同一个色。
    // 这类错误人眼要等到「选了奶黄的角色，打起来是灰的」才会发现。
    //
    // 另两条同样来自实战：
    //   ① 「区分度」——第一版按色相均匀铺开，看着很满意，实际算 RGB 距离才发现
    //      抹茶与薄荷只差 46（色相差 53° 但明度接近），小尺寸下几乎一样。
    //      所以这里把「两两最小距离」钉成断言，以后调色不能再调回相似。
    //   ② 「禁紫」——项目硬约定。主色与它的三档深浅色都要查，光查主色不够
    //     （很容易主色没事、斗篷用了紫）。
    const palCheck = await P.eval([
      '(function(){',
      '  var C = window.VS && window.VS.CONST;',
      '  var PA = window.VS && window.VS.PLAYER_ART;',
      '  var PT = window.VS && window.VS.CharacterPortraits;',
      '  if (!C || !PA || !PT) return { err: "缺少模块", has: { const: !!C, art: !!PA, portraits: !!PT } };',
      '  function rgb(h) { var n = parseInt(h.slice(1), 16); return [(n>>16)&255, (n>>8)&255, n&255]; }',
      '  function sum(h) { var c = rgb(h); return c[0] + c[1] + c[2]; }',
      '  function dist(a, b) {',
      '    var A = rgb(a), B = rgb(b);',
      '    return Math.round(Math.sqrt(Math.pow(A[0]-B[0],2) + Math.pow(A[1]-B[1],2) + Math.pow(A[2]-B[2],2)));',
      '  }',
      '  // 色相 + 饱和度：饱和度过低的颜色（近灰）色相无意义，不参与禁紫判定',
      '  function hs(h) {',
      '    var c = rgb(h), r = c[0]/255, g = c[1]/255, b = c[2]/255;',
      '    var mx = Math.max(r,g,b), mn = Math.min(r,g,b), d = mx - mn, H = 0;',
      '    var L = (mx + mn) / 2;',
      '    var S = d === 0 ? 0 : d / (1 - Math.abs(2*L - 1));',
      '    if (d === 0) H = 0;',
      '    else if (mx === r) H = 60 * (((g - b) / d) % 6);',
      '    else if (mx === g) H = 60 * ((b - r) / d + 2);',
      '    else H = 60 * ((r - g) / d + 4);',
      '    if (H < 0) H += 360;',
      '    return { h: Math.round(H), s: S };',
      '  }',
      '  var chars = C.CHARACTERS;',
      '  var out = { n: chars.length, mismatch: [], purple: [], notDarker: [], minDist: 9999, minPair: "" };',
      '  for (var i = 0; i < chars.length; i++) {',
      '    var id = chars[i].id, name = chars[i].name;',
      '    var acc = String(chars[i].accent || "").toUpperCase();',
      '    var pa = PA.colors[id] || {}, pt = PT.colors[id] || {};',
      '    var paMain = String(pa.main || "").toUpperCase();',
      '    var ptMain = String(pt.main || "").toUpperCase();',
      '    if (!acc || acc !== paMain || acc !== ptMain) {',
      '      out.mismatch.push(name + "  const=" + acc + " 战场=" + paMain + " 立绘=" + ptMain);',
      '    }',
      '    // 深色三档必须真的比主色暗/亮（写反了等于色系分层没生效）',
      '    if (pa.dark && sum(pa.dark) >= sum(paMain)) out.notDarker.push(name + " dark");',
      '    if (pa.deep && sum(pa.deep) >= sum(pa.dark || paMain)) out.notDarker.push(name + " deep");',
      '    if (pa.soft && sum(pa.soft) <= sum(paMain)) out.notDarker.push(name + " soft");',
      '    var slots = [["主色", paMain], ["深色", pa.dark], ["更暗", pa.deep], ["更亮", pa.soft]];',
      '    for (var k = 0; k < slots.length; k++) {',
      '      var v = slots[k][1];',
      '      if (!v) continue;',
      '      var q = hs(v);',
      '      if (q.h >= 250 && q.h <= 290 && q.s >= 0.15) {',
      '        out.purple.push(name + " " + slots[k][0] + "=" + v + " 色相" + q.h + "°");',
      '      }',
      '    }',
      '    for (var j = i + 1; j < chars.length; j++) {',
      '      var d2 = dist(acc, String(chars[j].accent || "").toUpperCase());',
      '      if (d2 < out.minDist) { out.minDist = d2; out.minPair = name + " × " + chars[j].name; }',
      '    }',
      '  }',
      '  return out;',
      '})()'
    ].join('\n'));

    const pc = palCheck || {};
    console.log('   配色自检：角色 ' + pc.n + ' 个，两两最小距离 ' + pc.minDist +
      '（' + pc.minPair + '）');
    if (pc.mismatch && pc.mismatch.length) console.log('     !! 三处不一致：' + pc.mismatch.join(' / '));
    if (pc.purple && pc.purple.length) console.log('     !! 踩到紫/紫蓝：' + pc.purple.join(' / '));
    expect('[2b] 三个文件的角色主色逐角色一致（const/战场/立绘）',
      !!(pc.mismatch && pc.mismatch.length === 0), JSON.stringify(pc.mismatch));
    expect('[2b] 8 个角色的主色两两距离 ≥50（色相铺开还不够，明度也要分层）',
      !!(pc.minDist >= 50), '最小 ' + pc.minDist + '（' + pc.minPair + '）');
    expect('[2b] 没有任何一档配色落在紫/紫蓝区（250°~290°）',
      !!(pc.purple && pc.purple.length === 0), JSON.stringify(pc.purple));
    expect('[2b] 深色三档确实比主色暗、亮色比主色亮（色系分层生效）',
      !!(pc.notDarker && pc.notDarker.length === 0), JSON.stringify(pc.notDarker));

    // ----------------------------------------------------------
    // [3]-[5] 进战场：关卡怪种 / Boss / 经验球
    // ----------------------------------------------------------
    // 先把对照图撤掉，再开始对局
    await P.eval('(function(){var c=document.getElementById("art-compare"); if(c) c.remove(); return 1;})()');

    // 恢复成常规视口（前面为了截全角色面板把它撑到 2050 高）
    await P.setDevice(1280, 860, false);
    await sleep(500);
    await P.eval('(function(){' +
      'var list = Array.prototype.slice.call(document.querySelectorAll("button"));' +
      'var b = list.filter(function(x){ return (x.innerText||"").indexOf("开始对局")>=0; })[0];' +
      'if (b) b.click();' +
      'return !!b;' +
      '})()');
    const playing = await waitFor(async function () {
      const r = await P.eval('(function(){var G=window.VS_GAME; return G && G.screen==="playing" ? 1 : null;})()');
      return r;
    }, 25000, '进入对局');
    expect('[3] 单机对局已开始', !!playing);

    // 变成打不死：截图要的是画面，不是操作水平
    await P.eval('(function(){var w=window.VS_GAME.world; w.player.maxHp=99999; w.player.hp=99999; return 1;})()');

    // ---- 四关怪种 ----
    // 【为什么直接改 wave】正常跑到第 15 波要 7 分钟。这里把 wave 设成目标前一波、
    // 并把 nextWaveTick 拉到当前 tick，下一步就会立刻按目标波次刷怪 ——
    // 走的是**真实的 spawnWave**，不是伪造的假数据。
    const stageShots = [];
    // ★只写目标波次，**不写地图名**：地图名是内容（第十八轮改过一次：
    //   钟楼广场→祭天台、荒村墓园→乱葬岗…），在这里钉一份副本、改内容时忘了同步就假红 ——
    //   而症状看起来像「波次错了」，会把人引到波次曲线上查，方向完全错。
    //   期望值改成从**同一份数据表**取（被测对象也读它），源头一致就永不失配。
    const stages = [{ wave: 1 }, { wave: 5 }, { wave: 11 }, { wave: 15 }];
    const stageNames = [];
    for (let i = 0; i < stages.length; i++) {
      // ★用 P.eval（本脚本的页面连接句柄），不是全局 evalJS —— artshot 没有那个函数
      const nm = await P.eval('(function(){ var s = window.VS.CONST.stageForWave(' + stages[i].wave + '); return s && s.name; })()');
      expect('[3] 数据表能查到第 ' + stages[i].wave + ' 波所属的地图名',
        !!nm && String(nm).length > 0, String(nm));
      stageNames.push(nm);
    }
    for (let i = 0; i < stages.length; i++) {
      const st = { wave: stages[i].wave, name: stageNames[i] };
      await P.eval('(function(){' +
        'var w = window.VS_GAME.world;' +
        // 清场：只留这一关要看的怪，否则上一关的怪会混进画面
        'w.mobs.length = 0;' +
        // 【必须先解锁升级面板并禁止升级】单机模式下一次升级就会让那一帧不推进世界
        //（pauseAllOnLevelUp：弹面板时冻结整局），于是 nextWaveTick 永远等不到，
        // wave 卡在原地 —— 表现成「脚本里明明设了 wave=9，跑完还是 9、Boss 没出来」。
        // 这是本脚本第一次跑就踩到的坑：上一轮侥幸没升级才通过，不可靠。
        'w.player.pendingLevels = 0;' +
        'w.player.choices = [];' +
        'w.player.state = "playing";' +
        'w.player.exp = 0;' +
        'w.player.expNext = 1e9;' +     // 永远升不了级
        // 【把刷怪半径压到 240】默认 1200 是给真实对局用的（怪不该在视野里凭空出现），
        // 但那样怪要走 13~30 秒才到玩家身边，截图里只能看到几个小点在远处 ——
        // 截图的目的是「看清这一关刷的是哪些怪」，所以让它们就在眼前生成。
        'w.spawnRadius = 240;' +
        'w.wave = ' + (st.wave - 1) + ';' +
        'w.nextWaveTick = w.tick;' +
        'return 1;' +
        '})()');
      // 等刷怪 + 稍微走近一点（240px / 40~90px 每秒 ≈ 3~6 秒，这里取 2.8 秒）
      await sleep(2800);
      const info = await P.eval('(function(){' +
        'var w = window.VS_GAME.world;' +
        'var kinds = {};' +
        'for (var i = 0; i < w.mobs.length; i++) {' +
        '  if (!w.mobs[i].alive) continue;' +
        '  var k = w.mobs[i].defId; kinds[k] = (kinds[k]||0)+1;' +
        '}' +
        'return { wave: w.wave, stage: window.VS.CONST.stageForWave(w.wave).name, kinds: kinds };' +
        '})()');
      console.log('   第 ' + (info && info.wave) + ' 波 [' + (info && info.stage) + '] 场上：' +
        JSON.stringify(info && info.kinds));
      await P.shot(SHOT_STAGE.replace('.png', '_' + st.wave + '.png'));
      stageShots.push(SHOT_STAGE.replace('.png', '_' + st.wave + '.png'));
      expect('[3] 第 ' + st.wave + ' 波属于「' + st.name + '」',
        !!(info && info.stage === st.name), JSON.stringify(info && info.stage));
      expect('[3] 第 ' + st.wave + ' 波场上怪种数 = ' + Object.keys((info && info.kinds) || {}).length,
        !!(info && Object.keys(info.kinds).length > 0), '一只怪都没有');
    }

    // 四关怪种是否真的不同（把四次的 keys 拼起来比）
    // —— 由上面每关的日志人工核对，这里只做「至少出现过 4 种以上不同怪」的弱校验
    console.log('   四关的怪种截图已保存，文件名含波次号');

    // ---- Boss 形象 ----
    // 【为什么把 wave 设到 Boss 波而不是直接放一只 Boss 出来】
    // spawnMob 是 sim 的内部函数，页面里拿不到；自己拼一个怪对象喂给渲染层也不行
    //（渲染要读 def，而 def 来自 MOB_MAP，拼出来的对象没有那层关系）。
    // 把 wave 拉到 Boss 波前一波、nextWaveTick 拉到当前帧，就让**真实的 spawnWave**
    // 把 Boss 刷出来 —— 形象与游戏里百分之百一致，因为它就是同一条代码路径。
    const bossIds = ['blood_lord', 'bone_tyrant', 'abyss_prelate', 'moon_queen'];
    for (let i = 0; i < bossIds.length; i++) {
      const bossWave = (i + 1) * 10;
      await P.eval('(function(){' +
        'var w = window.VS_GAME.world;' +
        'w.mobs.length = 0;' +          // 清场：只留这一只 Boss，画面干净
        // 同样先解锁升级面板（理由见关卡那段）
        'w.player.pendingLevels = 0;' +
        'w.player.choices = [];' +
        'w.player.state = "playing";' +
        'w.player.exp = 0;' +
        'w.player.expNext = 1e9;' +
        'w.spawnRadius = 240;' +        // 同上：让 Boss 就在眼前，截得到细节
        'w.wave = ' + (bossWave - 1) + ';' +
        'w.nextWaveTick = w.tick;' +
        'return 1;' +
        '})()');
      await sleep(2800);
      const b = await P.eval('(function(){' +
        'var w = window.VS_GAME.world;' +
        'var out = null;' +
        'for (var i = 0; i < w.mobs.length; i++) {' +
        '  if (w.mobs[i].alive && w.mobs[i].def.tier === "boss") out = w.mobs[i].def.id;' +
        '}' +
        'return { wave: w.wave, bossId: out };' +
        '})()');
      console.log('   第 ' + (b && b.wave) + ' 波 Boss = ' + (b && b.bossId));
      expect('[4] 第 ' + bossWave + ' 波的 Boss 是 ' + bossIds[i],
        !!(b && b.bossId === bossIds[i]), JSON.stringify(b));
      await P.shot(SHOT_BOSS.replace('.png', '_' + bossWave + '.png'));
    }

    // ---- 经验球分级 ----
    await P.eval('(function(){' +
      'var w = window.VS_GAME.world;' +
      'w.mobs.length = 0;' +
      'w.player.state = "playing";' +
      'w.player.expNext = 1e9;' +
      'w.pickups.length = 0;' +
      // 【必须是 /* */ 而不是 //】这些片段拼接后是**一整行**，
      // 写成 // 会把后面所有代码全注释掉 —— 报的是 "Unexpected end of input"，
      // 看起来像括号写错了，其实是被自己的注释吃掉了。
      // 【为什么摆到 250/330 那么远】磁石吸引距离是 200（C.DROPS.magnetAttractDist），
      // 摆在吸引范围内的话，截图前那 0.6 秒球就被玩家吸走吃光了 ——
      // 第一次跑就是这么得到一张「没有经验球」的截图。
      '/* 在玩家周围摆两圈：内圈小球、外圈大球，都放在磁石吸不到的地方 */' +
      'var px = w.player.x, py = w.player.y;' +
      'var i;' +
      'for (i = 0; i < 14; i++) {' +
      '  var a = (Math.PI * 2 / 14) * i;' +
      '  w.pickups.push({ id: w.nextId++, kind: "exp", x: px + Math.cos(a) * 250,' +
      '    y: py + Math.sin(a) * 250, px: px + Math.cos(a) * 250, py: py + Math.sin(a) * 250,' +
      '    value: 2, big: 0, vx: 0, vy: 0, life: 60 });' +
      '}' +
      'for (i = 0; i < 6; i++) {' +
      '  var a2 = (Math.PI * 2 / 6) * i + 0.4;' +
      '  w.pickups.push({ id: w.nextId++, kind: "exp", x: px + Math.cos(a2) * 330,' +
      '    y: py + Math.sin(a2) * 330, px: px + Math.cos(a2) * 330, py: py + Math.sin(a2) * 330,' +
      '    value: 12, big: 1, vx: 0, vy: 0, life: 60 });' +
      '}' +
      'w.mobs.length = 0;' +
      'return w.pickups.length;' +
      '})()');
    await sleep(600);
    await P.shot(SHOT_ORBS);
    console.log('   截图：' + SHOT_ORBS);
    expect('[5] 大球与小球已摆到画面上（见截图）', true);

    // ----------------------------------------------------------
    // [6] 手机 UI
    // ----------------------------------------------------------
    await P.setDevice(390, 844, true);      // iPhone 14 竖屏
    await sleep(900);
    await P.shot(SHOT_PHONE_V);
    console.log('   截图：' + SHOT_PHONE_V);

    // 竖屏下检查 HUD 有没有横向溢出
    const vOver = await P.eval('(function(){' +
      'var t = document.querySelector(".hud-top");' +
      'var s = document.querySelector(".hud-slots");' +
      'return {' +
      '  docW: document.documentElement.clientWidth,' +
      '  topW: t ? Math.round(t.getBoundingClientRect().width) : -1,' +
      '  topH: t ? Math.round(t.getBoundingClientRect().height) : -1,' +
      '  slotsR: s ? Math.round(s.getBoundingClientRect().right) : -1' +
      '};' +
      '})()');
    console.log('   竖屏度量：' + JSON.stringify(vOver));
    expect('[6] 竖屏顶部条没有超出屏宽',
      !!(vOver && vOver.topW <= vOver.docW + 1), JSON.stringify(vOver));
    expect('[6] 竖屏槽位没有溢出右边',
      !!(vOver && (vOver.slotsR < 0 || vOver.slotsR <= vOver.docW + 1)), JSON.stringify(vOver));

    await P.setDevice(844, 390, true);      // 横屏
    await sleep(900);
    await P.shot(SHOT_PHONE_H);
    console.log('   截图：' + SHOT_PHONE_H);

    const hOver = await P.eval('(function(){' +
      'var t = document.querySelector(".hud-top");' +
      'return { docW: document.documentElement.clientWidth,' +
      '  topW: t ? Math.round(t.getBoundingClientRect().width) : -1 };' +
      '})()');
    expect('[6] 横屏顶部条没有超出屏宽',
      !!(hOver && hOver.topW <= hOver.docW + 1), JSON.stringify(hOver));

    expect('[6] 页面零未捕获异常', P.pageErrors.length === 0,
      P.pageErrors.slice(0, 3).join(' | '));

    // ----------------------------------------------------------
    // [7] PC 界面：技能面板放大 + 整体像素风
    // ----------------------------------------------------------
    // 【为什么要单独验这一节】样式类改动最容易「看着改了其实没生效」
    // —— 字体没加载、媒体查询条件不匹配（pointer 不分 fine/coarse）、
    // 选择器特异性被压过。这几种都不会报错，只会静静地保持原样。
    // 所以这里断言的是**浏览器算出来的最终值**（getComputedStyle），
    // 不是 CSS 文件里写了什么。
    await P.setDevice(1290, 880, false);     // 回 PC 尺寸（mobile:false → pointer:fine）
    await sleep(600);

    // 塞一颗经验球让玩家升级 —— 走真实路径弹出面板，不是手动改 screen
    await P.eval('(function(){' +
      'var w = window.VS_GAME.world;' +
      'w.player.expNext = 5;' +
      'w.pickups.push({ id: w.nextId++, kind: "exp", x: w.player.x, y: w.player.y,' +
      '  px: w.player.x, py: w.player.y, value: 60, big: 1, vx: 0, vy: 0, life: 60 });' +
      'return 1; })()');
    const lvUp = await waitFor(async function () {
      const r = await P.eval('(function(){' +
        'var G = window.VS_GAME;' +
        // screen 挂在 ui（reactive）、候选项挂在 hud 上，不是顶层字段
        'if (!G || !G.ui || G.ui.screen !== "levelup") return null;' +
        'return { screen: G.ui.screen, choices: (G.hud.choices || []).length };' +
        '})()');
      return (r && r.screen === 'levelup') ? r : null;
    }, 10000, '升级面板弹出');
    expect('[7] 升级面板弹出了（后面的度量才有意义）',
      !!(lvUp && lvUp.choices > 0), JSON.stringify(lvUp));

    // 面板与候选项的实测几何 + 字号 + 圆角 + 阴影
    // 【为什么不用 .btn 做「按钮类」样本】升级面板里根本没有 .btn
    // —— 它的候选项是 .choice。第一版拿 .btn 去查，拿到 null 后
    // 三条断言（渲染、圆角、阴影）全部报 FAIL，看着像样式坏了，
    // 实际是探针取样取错了元素。
    const px = await P.eval('(function(){' +
      'function cs(sel, prop) {' +
      '  var el = document.querySelector(sel);' +
      '  if (!el) return null;' +
      '  return getComputedStyle(el)[prop];' +
      '}' +
      'function pxv(v) { return v === null ? -1 : Math.round(parseFloat(v) * 10) / 10; }' +
      'var panel = document.querySelector(".panel");' +
      'var choice = document.querySelector(".choice");' +
      'var sh = choice ? getComputedStyle(choice).boxShadow : "";' +
      'var nums = (sh.match(/-?[0-9]+(\\.[0-9]+)?px/g) || []).map(function(x){ return parseFloat(x); });' +
      'return {' +
      '  panelW: panel ? Math.round(panel.getBoundingClientRect().width) : -1,' +
      '  choiceCount: document.querySelectorAll(".choice").length,' +
      '  nameSize: pxv(cs(".choice .name", "fontSize")),' +
      '  descSize: pxv(cs(".choice .desc", "fontSize")),' +
      '  tagSize: pxv(cs(".choice .tag", "fontSize")),' +
      '  choiceH: choice ? Math.round(choice.getBoundingClientRect().height) : -1,' +
      '  panelRadius: cs(".panel", "borderRadius"),' +
      '  choiceRadius: cs(".choice", "borderRadius"),' +
      '  tagRadius: cs(".choice .tag", "borderRadius"),' +
      '  shadowBlur: nums.length >= 3 ? nums[2] : -1,' +
      '  hudFont: cs("#hud", "fontFamily"),' +
      '  bodyFont: cs("body", "fontFamily"),' +
      // PC 专属样式全挂在 (pointer: fine) 下，这里把它一并报出来：
      // 一旦它不匹配，后面那串「面板宽度/字号」会全红，而真正的原因
      // 是媒体查询没匹配，不是样式写错了。
      '  fine: window.matchMedia("(pointer: fine)").matches,' +
      '  coarse: window.matchMedia("(pointer: coarse)").matches,' +
      // 【为什么用 check() 而不是遍历 document.fonts 看 status】status 是
      // 「这个 FontFace 被加载了没有」，而浏览器**只在字体真的被用上时才加载**。
      // 于是「没被用上」和「加载失败」都会表现为 unloaded，分不清。
      // check(font, text) 直接回答「这段文字现在能不能用这个字体渲染」，
      // 它才是我们要断言的那件事。
      '  zpixReady: document.fonts.check("16px Zpix", "升级选择玩家"),' +
      '  arcadeReady: document.fonts.check("16px VT323", "Lv 12")' +
      '};' +
      '})()');
    console.log('   PC 实测：' + JSON.stringify(px));

    expect('[7] PC 视口下 pointer:fine 匹配（PC 专属样式的前提）',
      !!(px && px.fine === true), 'fine=' + (px && px.fine) + ' coarse=' + (px && px.coarse));

    // 面板必须真的渲染出来了 —— 否则后面所有度量都是「undefined 的默认值」
    expect('[7] PC 面板已渲染（候选项 > 0，防「整页空白」）',
      !!(px && px.choiceCount > 0), JSON.stringify(px));
    expect('[7] 技能面板宽度已放大到 860px 以上', !!(px && px.panelW >= 860),
      'panelW=' + (px && px.panelW));
    expect('[7] 候选项名称字号 ≥ 22px', !!(px && px.nameSize >= 22),
      'nameSize=' + (px && px.nameSize));
    expect('[7] 候选项描述字号 ≥ 15px', !!(px && px.descSize >= 15),
      'descSize=' + (px && px.descSize));
    expect('[7] 候选项标签字号 ≥ 14px', !!(px && px.tagSize >= 14),
      'tagSize=' + (px && px.tagSize));
    expect('[7] 候选项行高 ≥ 88px（整块够大，好点）', !!(px && px.choiceH >= 88),
      'choiceH=' + (px && px.choiceH));

    // 像素风三条铁律
    expect('[7] 圆角全部为 0（面板/候选项/标签）',
      !!(px && px.panelRadius === '0px' && px.choiceRadius === '0px' && px.tagRadius === '0px'),
      JSON.stringify({ p: px && px.panelRadius, c: px && px.choiceRadius, t: px && px.tagRadius }));
    expect('[7] 阴影是实心偏移块（blur = 0，不是柔和阴影）',
      !!(px && px.shadowBlur === 0), 'blur(choice)=' + (px && px.shadowBlur));
    expect('[7] 点阵中文字体 Zpix 真的能渲染中文（check 通过）',
      !!(px && px.zpixReady === true), 'zpixReady=' + (px && px.zpixReady));
    expect('[7] 街机数字字体 VT323 可用', !!(px && px.arcadeReady === true),
      'arcadeReady=' + (px && px.arcadeReady));
    // ★这条是防「中间层容器自己声明字体把继承链打断」——#hud 就踩过
    expect('[7] #hud 的字体栈是 Zpix（没被硬编码字体盖掉）',
      !!(px && px.hudFont && px.hudFont.indexOf('Zpix') >= 0),
      'hudFont=' + (px && px.hudFont));

    await P.shot(SHOT_PC_PANEL);
    console.log('   截图（PC 升级面板）：' + SHOT_PC_PANEL);

    // 同一屏也把「结算面板」的字号量一下 —— 用户要的是「整体改大」，
    // 不能只有升级面板变大了。
    await P.close();
    const L = await connect('大厅');
    await L.setDevice(1290, 880, false);
    await L.navigate(BASE + '/');
    await waitFor(async function () {
      const r = await L.eval('(function(){var a=document.getElementById("app");' +
        'return a ? !a.hasAttribute("v-cloak") : null;})()');
      return r === true ? r : null;
    }, 15000, '大厅渲染完成');
    await sleep(900);

    const lobbyPx = await L.eval('(function(){' +
      'function v(sel, prop) {' +
      '  var el = document.querySelector(sel); if (!el) return null;' +
      '  return getComputedStyle(el)[prop];' +
      '}' +
      'var b = document.querySelector(".btn");' +
      'var sh = b ? getComputedStyle(b).boxShadow : "";' +
      'var nums = (sh.match(/-?[0-9]+(\\.[0-9]+)?px/g) || []).map(function(x){ return parseFloat(x); });' +
      'var card = document.querySelector(".card");' +
      'return {' +
      '  btnRadius: v(".btn", "borderRadius"),' +
      '  cardRadius: card ? v(".card", "borderRadius") : "0px",' +
      '  btnBlur: nums.length >= 3 ? nums[2] : -1,' +
      '  bodyFont: v("body", "fontFamily"),' +
      '  btnCount: document.querySelectorAll(".btn").length,' +
      '  textLen: (document.body.innerText || "").length' +
      '};' +
      '})()');
    console.log('   大厅实测：' + JSON.stringify(lobbyPx));
    expect('[7] 大厅已渲染出内容（防整页空白）',
      !!(lobbyPx && lobbyPx.btnCount > 0 && lobbyPx.textLen > 50), JSON.stringify(lobbyPx));
    expect('[7] 大厅圆角同样为 0（像素风覆盖到大厅）',
      !!(lobbyPx && lobbyPx.btnRadius === '0px' && lobbyPx.cardRadius === '0px'),
      JSON.stringify(lobbyPx));
    expect('[7] 大厅按钮也是实心偏移块（blur = 0）',
      !!(lobbyPx && lobbyPx.btnBlur === 0), 'blur=' + (lobbyPx && lobbyPx.btnBlur));
    expect('[7] 大厅字体也是 Zpix',
      !!(lobbyPx && lobbyPx.bodyFont && lobbyPx.bodyFont.indexOf('Zpix') >= 0),
      'bodyFont=' + (lobbyPx && lobbyPx.bodyFont));

    await L.shot(SHOT_LOBBY);
    console.log('   截图（大厅）：' + SHOT_LOBBY);

    // ----------------------------------------------------------
    // [8] 手机端布局：顶栏不许挤压 + 触摸目标 ≥44px
    // ----------------------------------------------------------
    // 【为什么单开一节】[6] 只验了**游戏页**的 HUD 是否溢出，而「标题被挤成
    // 一字一行」「按钮只有 30px」这类问题出在**大厅/候场室**。手机端的样式
    // 一直没被自动化覆盖到，本轮才由用户截图发现：390 宽下标题占 5 行、
    // 320 宽下 6 行，大厅好几个按钮只有 30~40px。
    //
    // 【验的是「最终布局」不是「CSS 里写了什么」】行数、高度、是否溢出
    // 全部读 getBoundingClientRect / getComputedStyle。
    // 另外**必须先确认 pointer:coarse 真的匹配** —— 触摸规则全挂在那条媒体
    // 查询下，不匹配的话测出来是假的（要么假过要么假失败）。
    await L.setDevice(390, 844, true);
    await sleep(600);

    // 以游客身份进大厅：已登录状态的顶栏元素最多（连接状态 + 2 个按钮），
    // 是最容易把品牌块挤扁的场景
    await L.eval('(function(){' +
      'var i = document.querySelector("input[placeholder*=\\"名字\\"]");' +
      'if (i) { i.value = "手机布局"; i.dispatchEvent(new Event("input", {bubbles:true})); }' +
      'return !!i; })()');
    await sleep(300);
    const guestIn = await L.eval('(function(){' +
      'var l = Array.prototype.slice.call(document.querySelectorAll("button"));' +
      'var b = l.filter(function(x){ return (x.innerText||"").indexOf("游客") >= 0; })[0];' +
      'if (!b) return false; b.click(); return true; })()');
    expect('[8] 能以游客身份进入大厅（后面的度量才有意义）', guestIn === true, String(guestIn));
    await sleep(2200);

    // 手机端探针：行数 / 溢出 / 触摸目标 / 品牌块是否独占一行
    const MOBILE_STATE = `(function () {
      function lines(el) {
        if (!el) return 0;
        var cs = getComputedStyle(el);
        var lh = parseFloat(cs.lineHeight);
        if (!lh || isNaN(lh)) lh = parseFloat(cs.fontSize) * 1.25;
        var h = el.getBoundingClientRect().height;
        return Math.max(1, Math.round(h / lh));
      }
      var de = document.documentElement;
      var h1 = document.querySelector(".brand h1");
      var bp = document.querySelector(".brand p");
      var tb = document.querySelector(".topbar");
      var brand = document.querySelector(".brand");
      var small = [];
      Array.prototype.slice.call(document.querySelectorAll("button, .btn")).forEach(function (b) {
        var r = b.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        if (r.height < 44) small.push((b.innerText || "").trim().replace(/\\n/g, "/").slice(0, 10) + ":" + Math.round(r.height));
      });
      return {
        vw: de.clientWidth,
        coarse: window.matchMedia("(pointer: coarse)").matches,
        overflowX: de.scrollWidth > de.clientWidth + 1,
        scrollW: de.scrollWidth,
        h1Lines: lines(h1),
        pLines: lines(bp),
        h1W: h1 ? Math.round(h1.getBoundingClientRect().width) : -1,
        brandW: brand ? Math.round(brand.getBoundingClientRect().width) : -1,
        topbarW: tb ? Math.round(tb.getBoundingClientRect().width) : -1,
        smallTargets: small,
        btnCount: document.querySelectorAll("button, .btn").length
      };
    })()`;

    const m390 = await L.eval(MOBILE_STATE);
    console.log('   手机 390 实测：' + JSON.stringify(m390));
    expect('[8] 手机视口下 pointer:coarse 匹配（否则触摸规则测不到）',
      !!(m390 && m390.coarse === true), 'coarse=' + (m390 && m390.coarse));
    expect('[8] 大厅已渲染（按钮数 > 0，防整页空白）',
      !!(m390 && m390.btnCount > 0), JSON.stringify(m390));
    expect('[8] 标题没被挤成多行（必须 1 行）',
      !!(m390 && m390.h1Lines === 1), 'h1Lines=' + (m390 && m390.h1Lines) + ' 宽=' + (m390 && m390.h1W));
    expect('[8] 副标题不超过 2 行',
      !!(m390 && m390.pLines <= 2), 'pLines=' + (m390 && m390.pLines));
    // 品牌块独占一行：它的宽度应接近 topbar 的内容宽度（而不是被按钮挤成几十像素）
    expect('[8] 品牌块独占一行（宽度 ≥ topbar 的 80%）',
      !!(m390 && m390.brandW >= m390.topbarW * 0.8),
      'brand=' + (m390 && m390.brandW) + ' topbar=' + (m390 && m390.topbarW));
    expect('[8] 手机端没有横向溢出',
      !!(m390 && m390.overflowX === false), 'scrollW=' + (m390 && m390.scrollW));
    expect('[8] 所有按钮高度 ≥ 44px（触摸目标）',
      !!(m390 && m390.smallTargets.length === 0),
      JSON.stringify(m390 && m390.smallTargets));

    await L.shot(SHOT_PHONE_LOBBY);
    console.log('   截图（手机大厅）：' + SHOT_PHONE_LOBBY);

    // 最窄的老机型（320）再验一遍
    await L.setDevice(320, 568, true);
    await sleep(700);
    const m320 = await L.eval(MOBILE_STATE);
    console.log('   手机 320 实测：' + JSON.stringify(m320));
    expect('[8] 320 超窄屏下标题仍是 1 行',
      !!(m320 && m320.h1Lines === 1), 'h1Lines=' + (m320 && m320.h1Lines));
    expect('[8] 320 超窄屏下没有横向溢出',
      !!(m320 && m320.overflowX === false), 'scrollW=' + (m320 && m320.scrollW));
    expect('[8] 320 超窄屏下按钮仍 ≥ 44px',
      !!(m320 && m320.smallTargets.length === 0),
      JSON.stringify(m320 && m320.smallTargets));
    await L.shot(SHOT_PHONE_LOBBY_320);
    console.log('   截图（手机大厅 320）：' + SHOT_PHONE_LOBBY_320);

    await L.close();
  } catch (e) {
    console.log('脚本异常：' + (e && e.stack || e));
    fail += 1;
  }

  try { chrome.kill(); } catch (e) { }

  console.log('');
  console.log('=== 汇总 ===');
  console.log('  PASS  ' + pass);
  console.log('  FAIL  ' + fail);
  console.log('  截图目录：' + TMP + '/vs_art_*.png');
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack || e));
  process.exit(1);
});
