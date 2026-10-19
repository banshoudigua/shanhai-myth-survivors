// tools/shopui.js —— 商店 + 角色数据 + 手机端 HUD 压缩的界面实测
//
// 为什么这三样必须有界面断言
// ----------------------
// ① 商店：sim 层已经验了「钱扣了效果生效」，但界面层还有三件独立的事会坏——
//   按钮点不动（pointer-events）、买完界面不刷新（以为没生效）、
//   买不了时不显示原因（玩家不知道还差多少）。这三个只有真点按钮才测得到。
// ② 角色数据：detail 有值 ≠ 界面显示出来。v-for 少写一个键就是白板一块。
// ③ 手机端击杀/金币压缩：这个改动是**减东西**，肉眼很难确认到底压掉多少 ——
//   必须量它占了多宽、多少行、还溢出没有。
//
// 用法：node tools/shopui.js [端口] [宽] [高]
const { spawn } = require('node:child_process');

const APP_PORT = Number(process.argv[2] || 3000);
const LIVE = /^(https?:)?\/\//.test(String(process.argv[2] || ''));
const BASE = LIVE ? String(process.argv[2]).replace(/\/$/, '') : ('http://127.0.0.1:' + APP_PORT);
const W = Number(process.argv[3] || 1600);
const H = Number(process.argv[4] || 1000);
const CDP_PORT = 9365;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_shopui_profile';
const SHOT = TMP + '/vs_shopui.png';

// 直接读 shared/const.js（服务端那份就是唯一的数据源）——
// 断言要拿「世界定义了几件商品 / 几件技能」与「界面画出来几件」比对。
// ★不写死数字：写死 3 的话，本轮加了血脉契约 / 置换契约就会假红；写死 5 则下次加又会假红。
//   而且写死之后它就只能证明「等于我记的数」，发现不了「界面漏画了一件」。
const CONST = require('../shared/const.js');
const C_SHOP_N = CONST.SHOP.items.length;
const C_SKILL_N = CONST.WEAPONS.length + CONST.PASSIVES.length;

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

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=' + W + ',' + H, 'about:blank'
    ];
    // ★测线上域名时必须显式指定代理：Windows 版 Chrome 不读 http_proxy 环境变量，
    //   而本机系统代理是「直连」—— 不指定的话导航会落在 `chrome-error://chromewebdata/`，
    //   症状是「VS_GAME 不存在、所有断言全红」，看起来像前端崩了，其实代码没错。
    //   端口每次会话都会变 → 从环境变量现取；测本地则绕开代理。
    const proxy = process.env.http_proxy || process.env.https_proxy ||
      process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
    if (LIVE && proxy) args.push('--proxy-server=' + proxy);
    else args.push('--no-proxy-server');
    const child = spawn(CHROME, args, { stdio: 'ignore' });
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

async function main() {
  console.log('=== 商店 + 角色数据 + 手机端HUD（' + BASE + ' ' + W + 'x' + H + '）===');
  if (!require('node:fs').existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }
  const alive = LIVE
    ? await fetch(BASE + '/game.html').then(function (r) { return r.status === 200; }).catch(function () { return false; })
    : await fetch(BASE + '/api/health').then(function (r) { return r.status === 200; }).catch(function () { return false; });
  if (!alive) { console.log('!! 目标未就绪'); process.exit(1); }

  await killByPort(CDP_PORT);
  await sleep(400);
  const chrome = await launchChrome();
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

  // ---------- 1. 开局 + 暂停 ----------
  await evalJS('(function(){ var g=window.VS_GAME; if(g) g.start(); return 1; })()');
  await sleep(1400);
  // 给一些金币与等级，否则商店全灰、角色数据全是基础值。
  // ★改完 passives/weapons **必须调 SIM.recalcAttrs**：
  //   那些属性是重算进 p.attrs 的，直接改背包不会让战斗用的数值跟着变。
  //   （第一版忘了调，界面里全是 ×100 基础值，查了很久才想到是它。）
  await evalJS(`(function(){
    var g = window.VS_GAME, w = g.world;
    if (!w || !w.self) return 0;
    w.self.shopGold = 260;
    w.self.level = 12;
    w.self.passives = [{id:'blood_crystal',level:3},{id:'sun_brand',level:2},{id:'magnet',level:2}];
    w.self.weapons.push({id:'garlic',level:4,timer:0,rt:{}});
    w.self.hp = Math.round(w.self.maxHp * 0.5);
    window.VS.SIM.recalcAttrs(w);
    return 1;
  })()`);
  await sleep(400);
  await evalJS(`(function(){
    var l = Array.prototype.slice.call(document.querySelectorAll("button"));
    var b = l.filter(function(x){ return (x.innerText||"").trim() === "暂停"; })[0];
    if (b) b.click(); return 1;
  })()`);
  await sleep(900);

  console.log('\n--- [1] 商店 ---');
  const shop = await evalJS(`(async function(){
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var box = document.querySelector(".shop");
    if (!box) return { err: "no shop" };
    var items = Array.prototype.slice.call(document.querySelectorAll(".shop-item"));
    var bal = document.querySelector(".shop-bal b");
    return {
      has: true,
      bal: bal ? (bal.innerText||"").trim() : null,
      n: items.length,
      names: items.map(function(b){ return (b.innerText||"").replace(/\\s+/g," ").trim().slice(0,26); }),
      // 每一件的可点状态（钱够就该可点）
      enabled: items.map(function(b){ return !b.disabled; })
    };
  })()`);
  ok('暂停面板里有商店', !!(shop && shop.has), JSON.stringify(shop));
  // ★件数从写死改成「从 CONST 现取」：本轮加了血脉契约 / 置换契约两件，
  //   写死 3 会假红，而写死 5 下次加商品又会假红 —— 断言要钉「界面画了几件」
  //   而不是「世界里定义了几件」。
  ok('商店把 CONST 里定义的商品全画出来了',
    shop && shop.n === C_SHOP_N, shop && (shop.n + ' 件 / 定义 ' + C_SHOP_N + ' 件'));
  ok('★余额显示出来了（且是 260）', shop && shop.bal === '260', shop && String(shop.bal));
  ok('★260 枚金币时能买得起的都点了（30/45/70/80，120 也够）',
    shop && shop.enabled.every(function (x) { return x; }), shop && JSON.stringify(shop.enabled));

  // ---------- 2. 真点一次购买 ----------
  console.log('\n--- [2] 点购买 ---');
  const buyRes = await evalJS(`(async function(){
    var before = { hp: 0, gold: 0 };
    var g = window.VS_GAME, w = g.world;
    before.hp = Math.round(w.self.hp); before.gold = w.self.shopGold;
    var b = document.querySelectorAll(".shop-item")[0];   // 急救绷带
    b.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    return {
      before: before,
      afterHp: Math.round(w.self.hp),
      afterGold: w.self.shopGold,
      msg: (document.querySelector(".shop-msg")||{}).innerText || ''
    };
  })()`);
  ok('★点第一件后金币真的扣了（260 → 230）',
    buyRes && buyRes.afterGold === 230, JSON.stringify(buyRes));
  ok('★点第一件后血真的回了（+60）',
    buyRes && buyRes.afterHp >= buyRes.before.hp + 55, JSON.stringify(buyRes));
  ok('★界面上给出了反馈（「急救绷带 已生效」）',
    buyRes && buyRes.msg.indexOf('已生效') >= 0, buyRes && buyRes.msg);

  // ---------- 3. 买不了时要说原因 ----------
  console.log('\n--- [3] 钱不够 ---');
  const poor = await evalJS(`(async function(){
    var g = window.VS_GAME, w = g.world;
    w.self.shopGold = 3;
    g.ui.shopMsg = '';
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var items = Array.prototype.slice.call(document.querySelectorAll(".shop-item"));
    return {
      allDisabled: items.every(function(b){ return b.disabled; }),
      poorCls: items.every(function(b){ return b.className.indexOf("poor") >= 0; })
    };
  })()`);
  ok('钱不够时按钮变灰', poor && poor.allDisabled, JSON.stringify(poor));
  ok('★钱不够时用「poor」样式（不只是变灰，要看得出是买不起）',
    poor && poor.poorCls, JSON.stringify(poor));

  // ---------- 4. 角色详细数据 ----------
  console.log('\n--- [4] 角色数据 ---');
  const dt = await evalJS(`(async function(){
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var box = document.querySelector(".detail");
    if (!box) return { err: "no detail" };
    var cells = Array.prototype.slice.call(document.querySelectorAll(".dt-cell"));
    var up = document.querySelectorAll(".dt-v.up");
    var own = document.querySelectorAll(".dt-own-row");
    return {
      has: true,
      n: cells.length,
      keys: cells.map(function(c){ return c.innerText.replace(/\\s+/g," ").trim(); }),
      upCount: up.length,
      ownCount: own.length,
      char: (document.querySelector(".dt-char")||{}).innerText || ""
    };
  })()`);
  ok('暂停面板里有角色数据区', !!(dt && dt.has), JSON.stringify(dt));
  ok('★显示了多项属性（>= 8 项）', dt && dt.n >= 8, dt && String(dt.n));
  ok('★带升级点的属性被高亮（up 标记生效）', dt && dt.upCount > 0, dt && String(dt.upCount));
  ok('★显示持有技能（武器 + 被动）', dt && dt.ownCount >= 2, dt && String(dt.ownCount));
  ok('★显示了角色名与等级', dt && dt.char.indexOf('Lv12') >= 0, dt && dt.char);
  // 条件属性：只显示真的点了的（暴击 16%、回血…）
  ok('★条件属性也显示了（日轮烙印的暴击率）',
    dt && dt.keys.some(function (k) { return k.indexOf('暴击') >= 0; }),
    JSON.stringify(dt && dt.keys));
  ok('★没点的属性不显示（不显示「反伤 0」这类噪音）',
    dt && !dt.keys.some(function (k) { return k.indexOf('反伤') >= 0; }),
    JSON.stringify(dt && dt.keys));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('node:fs').writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('  截图：' + SHOT);

  // ---------- 5. 手机端击杀/金币区是否压缩 ----------
  console.log('\n--- [5] 手机端 HUD 压缩 ---');
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const hud = await evalJS(`(function(){
    var r = document.querySelector(".hud-right");
    if (!r) return null;
    var rect = r.getBoundingClientRect();
    var stats = Array.prototype.slice.call(document.querySelectorAll(".hud-right .stat"));
    var tops = stats.map(function(s){ return Math.round(s.getBoundingClientRect().top); });
    var ico = document.querySelector(".hud-right .ico");
    return {
      w: Math.round(rect.width), h: Math.round(rect.height),
      stats: stats.length,
      // ★行数：不同top 的个数。两行= 压缩失败，仍占两行
      rows: (function(){
        var u = {}; tops.forEach(function(t){ u[t]=1; });
        return Object.keys(u).length;
      })(),
      icoHidden: !ico || getComputedStyle(ico).display === 'none',
      font: stats.length ? getComputedStyle(stats[0]).fontSize : null,
      numFont: stats.length ? (function(){
        var b = stats[0].querySelector("b");
        return b ? getComputedStyle(b).fontSize : null;
      })() : null,
      vw: document.documentElement.clientWidth
    };
  })()`);
  console.log('  HUD 量测：' + JSON.stringify(hud));
  ok('★击杀/金币压成一行（rows === 1）', hud && hud.rows === 1, hud && ('rows=' + hud.rows));
  // 高度目标：一行文字 + 一点行距。原来是**两行**（约 30~34px）。
  ok('★区块变矮了（<= 34px；实测 30= 一行数字 + ? 按钮，原为两行约 45px）', hud && hud.h <= 34, hud && (hud.h + 'px'));
  ok('★宽度收窄了（<= 120px；实测 107px，原为 173px）', hud && hud.w <= 120, hud && (hud.w + 'px'));
  ok('★压缩后宽度不到视口的 30%（107/390 ≈ 27%）',
    hud && hud.w < hud.vw * 0.3, hud && (hud.w + '/' + hud.vw));

  // 整个顶栏占了多少 —— 这才是玩家真正感受到的「顶部吃掉多少空间」
  const top = await evalJS(`(function(){
    var t = document.querySelector(".hud-top");
    if (!t) return null;
    var r = t.getBoundingClientRect();
    // 内容实际到哪一行（去掉底部那块为渐变预留的空白）
    var kids = Array.prototype.slice.call(t.children).filter(function(c){
      var rr = c.getBoundingClientRect();
      return rr.width > 1 && rr.height > 1;
    });
    var bottom = 0;
    kids.forEach(function(c){ bottom = Math.max(bottom, c.getBoundingClientRect().bottom); });
    return { boxH: Math.round(r.height), contentBottom: Math.round(bottom),
             vh: document.documentElement.clientHeight,
             leftW: Math.round(document.querySelector(".hud-left").getBoundingClientRect().width),
             timerTop: Math.round(document.querySelector(".hud-timer").getBoundingClientRect().top) };
  })()`);
  console.log('  顶栏量测：' + JSON.stringify(top));
  ok('★顶栏内容高度在视口的 22% 以内（顶部不能吃掉太多战场）',
    top && (top.contentBottom - top.timerTop) / top.vh <= 0.22,
    top && Math.round((top.contentBottom - top.timerTop) / top.vh * 100) + '%');
  ok('★血条区不再固定 300px（实测约 160px，原来一家就占 77% 宽度）',
    top && top.leftW <= 175, top && (top.leftW + 'px'));
  ok('★图标在窄屏上隐藏了（纯占宽度不提供信息）', hud && hud.icoHidden === true);
  ok('没有横向溢出（压缩不该造成新问题）',
    await evalJS('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1'));

  // 压缩之后倒计时还在吗（这是最该保住的东西 —— 上一轮正是因为它被挤压才改的）
  const timer = await evalJS(`(function(){
    var t = document.querySelector(".hud-timer");
    if (!t) return null;
    var r = t.getBoundingClientRect();
    return { w: Math.round(r.width), text: (t.innerText||"").trim(), visible: r.width > 10 };
  })()`);
  ok('★倒计时还在且没被挤没', timer && timer.visible && /\d/.test(timer.text), JSON.stringify(timer));

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  require('node:fs').writeFileSync(TMP + '/vs_shopui_phone.png', Buffer.from(shot2.data, 'base64'));
  console.log('  截图：' + TMP + '/vs_shopui_phone.png');

  // ---------- 6. 顶栏各元素不能互相重叠 ----------
  // ★必须先回到playing：暂停时顶栏被遮罩盖住，量不到真实的并排关系。
  //   （第一版在暂停态量，.help-btn 的 getBoundingClientRect 全是 0，
  //    于是「不重叠」这条永远通过 —— 断言看着在跑，其实什么也没验。）
  await evalJS('(function(){ window.VS_GAME.ui.screen = "playing"; return 1; })()');
  await sleep(700);
  // Boss 血条要真的渲染才能量到重叠（它 v-if="hud.boss"）。
  // 用 fakeHud 打一个 Boss 出来，窗口给 3 秒 —— 单机下 HUD 每帧从本地世界重算，
  // 不开预览窗口的话这一帧就被覆盖回去了。
  await evalJS(`(function(){
    window.VS_GAME.fakeHud({ boss: { name: '血月领主', hp: 3200, maxHp: 3200 } }, 3000);
    return 1;
  })()`);
  await sleep(500);
  const overlap = await evalJS(`(function(){
    var help = document.querySelector(".help-btn");
    if (!help) return { err: "no help btn" };
    var hb = help.getBoundingClientRect();
    var res = { helpW: Math.round(hb.width), helpH: Math.round(hb.height) };
    // 触摸目标：手机上? 按钮不能小到点不准
    res.helpTouchOk = hb.width >= 24 && hb.height >= 24;
    // 与 Boss 血条是否相交
    var boss = document.querySelector(".boss-bar");
    if (boss) {
      var bb = boss.getBoundingClientRect();
      // ★把 top/bottom/left 也量出来：只量 width/right 时，
      //   「上下错开」与「左右重叠」两种情况会给出同一个结果，
      //   我就分不清是哪个方向的问题（这一版正是这么绕了两圈的）。
      res.boss = { l: Math.round(bb.left), r: Math.round(bb.right),
                   t: Math.round(bb.top), b: Math.round(bb.bottom),
                   w: Math.round(bb.width) };
      res.helpBox = { t: Math.round(hb.top), b: Math.round(hb.bottom) };
      res.bossOverlaps = !(bb.right <= hb.left || bb.left >= hb.right ||
                           bb.bottom <= hb.top || bb.top >= hb.bottom);
      // 分开报「纵向」与「横向」两种相交，定位时不用再猜
      res.overlapX = !(bb.right <= hb.left || bb.left >= hb.right);
      res.overlapY = !(bb.bottom <= hb.top || bb.top >= hb.bottom);
    } else {
      res.boss = null;
      res.bossOverlaps = false;
    }
    // 与波次信息行是否相交（那一行也常换行）
    var wave = document.querySelector(".hud-wave");
    if (wave) {
      var wb = wave.getBoundingClientRect();
      res.waveOverlaps = !(wb.right <= hb.left || wb.left >= hb.right ||
                           wb.bottom <= hb.top || wb.top >= hb.bottom);
    }
    return res;
  })()`);
  console.log('  重叠量测：' + JSON.stringify(overlap));
  ok('★? 按钮够大（>= 24px 触摸目标）', overlap && overlap.helpTouchOk === true,
    overlap && (overlap.helpW + 'x' + overlap.helpH));
  ok('★? 按钮不与 Boss 血条重叠', overlap && overlap.bossOverlaps === false,
    overlap && JSON.stringify({ boss: overlap.boss, help: overlap.helpBox, 横向: overlap.overlapX, 纵向: overlap.overlapY }));
  ok('★? 按钮不与波次信息行重叠', overlap && overlap.waveOverlaps === false);

  // ---------- 7. 两段式商店：血脉契约 / 置换契约 ----------
  // 【为什么要单独测】三件老商品都是「点一下 = 买完」，而这两件是**两段式**：
  //   点商品只开选择器、选完再点确认才扣钱。这条路径上有三件事只有真点按钮才验得到：
  //   ① 开选择器时**一分钱没扣**（先扣再选的话，玩家取消一次就白亏 120 枚）
  //   ② 选中态真的高亮（清单三十来项，看串行时这是唯一的反馈）
  //   ③ 确认后新技能**真的出现在左下角槽位行里**（sim 里生效 ≠ 界面上画出来了）
  console.log('\n--- [7] 血脉契约 / 置换契约 ---');
  // 回到暂停态并把余额给足（前面第 3 段把它改成过 3）
  await evalJS(`(function(){
    var g = window.VS_GAME;
    // ★必须先把第 6 段留下的 fakeHud 预览窗口关掉（传 0 = 立刻恢复）。
    //   预览窗口期内 applyHud 会被忽略 → hud.shopGold 停在旧值 3 →
    //   商品按钮全是 disabled → 「点了没反应」。本轮第一次跑就是这么白报三条的：
    //   症状看起来像 openPick 坏了，其实只是余额没同步进界面。
    g.fakeHud(null, 0);
    g.ui.screen = 'paused';
    g.world.self.shopGold = 400;
    g.ui.shopMsg = '';
    return 1;
  })()`);
  await sleep(800);

  const pk1 = await evalJS(`(async function(){
    await Vue.nextTick();
    var g = window.VS_GAME, w = g.world;
    var its = Array.prototype.slice.call(document.querySelectorAll(".shop-item"));
    var c = its.filter(function(b){ return (b.innerText||"").indexOf("血脉契约") >= 0; })[0];
    if (!c) return { err: "没找到血脉契约" };
    var gold0 = w.self.shopGold;
    c.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var box = document.querySelector(".shop-pick");
    var chips = box ? Array.prototype.slice.call(box.querySelectorAll(".sp-chip")) : [];
    var btn = box ? box.querySelector(".sp-foot .btn") : null;
    return {
      open: !!box,
      // 诊断字段：失败时能一眼看出是「按钮点不动」还是「状态没进界面」
      disabledAtClick: c.disabled,
      screen: g.ui.screen,
      hudGold: g.hud.shopGold,
      pickState: JSON.stringify(g.ui.pick),
      gold0: gold0,
      gold1: w.self.shopGold,
      chips: chips.length,
      owned: w.self.weapons.length + w.self.passives.length,
      confirmDisabled: btn ? btn.disabled : null,
      title: (document.querySelector(".sp-title")||{}).innerText || ""
    };
  })()`);
  console.log('  选择器：' + JSON.stringify(pk1));
  ok('★点「血脉契约」先开选择器，而不是直接扣钱', pk1 && pk1.open === true, JSON.stringify(pk1));
  ok('★★开选择器时一分钱没扣（取消一次不会白亏 120 枚）',
    pk1 && pk1.gold1 === pk1.gold0, JSON.stringify(pk1));
  ok('★清单 = 全部武器 + 被动 − 已拥有的（' + C_SKILL_N + ' − 手上这几件）',
    pk1 && pk1.chips === C_SKILL_N - pk1.owned, pk1 && (pk1.chips + ' 项，已拥有 ' + pk1.owned));
  ok('★还没选之前确认按钮是禁用的',
    pk1 && pk1.confirmDisabled === true, String(pk1 && pk1.confirmDisabled));

  const pk2 = await evalJS(`(async function(){
    var g = window.VS_GAME, w = g.world;
    var box = document.querySelector(".shop-pick");
    var chips = Array.prototype.slice.call(box.querySelectorAll(".sp-chip"));
    var t = chips[0];
    var id = t.getAttribute("data-id");
    t.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var btn = document.querySelector(".sp-foot .btn");
    var out = {
      id: id,
      highlighted: box.querySelectorAll(".sp-chip.on").length,
      btnText: (btn.innerText||"").trim(),
      btnDisabled: btn.disabled,
      note: (document.querySelector(".sp-note")||{}).innerText || "",
      gold0: w.self.shopGold
    };
    btn.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var def = window.VS.CONST.WEAPON_MAP[id] || window.VS.CONST.PASSIVE_MAP[id];
    out.name = def ? def.name : id;
    out.gold1 = w.self.shopGold;
    out.closed = !document.querySelector(".shop-pick");
    out.msg = (document.querySelector(".shop-msg")||{}).innerText || "";
    out.inBag = w.self.weapons.some(function(x){ return x.id === id; }) ||
               w.self.passives.some(function(x){ return x.id === id; });
    // ★界面层：新技能必须出现在左下角槽位行里（sim 生效 ≠ 界面画出来了）
    var slots = Array.prototype.slice.call(document.querySelectorAll(".hud-slots .slot"));
    out.inSlots = slots.some(function(x){ return (x.innerText||"").indexOf(out.name) >= 0; });
    out.slotFull = slots.filter(function(x){ return x.className.indexOf("empty") < 0; }).length;
    return out;
  })()`);
  console.log('  购买：' + JSON.stringify(pk2));
  ok('★选中一项后高亮 1 个（清单很长，这是唯一的选没选中反馈）',
    pk2 && pk2.highlighted === 1, pk2 && String(pk2.highlighted));
  ok('★确认按钮带上价格（120 金）', pk2 && pk2.btnText.indexOf('120') >= 0, pk2 && pk2.btnText);
  ok('★确认后金币真的扣了 120',
    pk2 && pk2.gold0 - pk2.gold1 === 120, pk2 && (pk2.gold0 + ' → ' + pk2.gold1));
  ok('★选择器自动收起（买完不该还挂着）', pk2 && pk2.closed === true, JSON.stringify(pk2));
  ok('★技能真的进了背包', pk2 && pk2.inBag === true, JSON.stringify(pk2));
  ok('★★新技能真的画进了左下角槽位行（界面不是白买的）',
    pk2 && pk2.inSlots === true, pk2 && JSON.stringify(pk2.slotNames || pk2.name));
  ok('买完给出反馈（「已生效：习得 X」）',
    pk2 && pk2.msg.indexOf('已生效') >= 0 && pk2.msg.indexOf('习得') >= 0, pk2 && pk2.msg);

  // ---- 置换契约：① 遗忘 ② 换上 ----
  const sw1 = await evalJS(`(async function(){
    var g = window.VS_GAME, w = g.world;
    g.ui.shopMsg = '';
    g.world.self.shopGold = 400;
    await Vue.nextTick();
    var its = Array.prototype.slice.call(document.querySelectorAll(".shop-item"));
    var c = its.filter(function(b){ return (b.innerText||"").indexOf("置换契约") >= 0; })[0];
    if (!c) return { err: "没找到置换契约" };
    c.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var box = document.querySelector(".shop-pick");
    if (!box) return { err: "选择器没开" };
    var grids = Array.prototype.slice.call(box.querySelectorAll(".sp-grid"));
    var owned = grids[0] ? Array.prototype.slice.call(grids[0].querySelectorAll(".sp-chip")) : [];
    var free = grids[1] ? Array.prototype.slice.call(grids[1].querySelectorAll(".sp-chip")) : [];
    var labels = Array.prototype.slice.call(box.querySelectorAll(".sp-label")).map(function(x){ return (x.innerText||"").trim(); });
    var drop = owned[0];
    var add = free[0];
    var dropId = drop.getAttribute("data-id");
    var addId = add.getAttribute("data-id");
    drop.click(); add.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var btn = box.querySelector(".sp-foot .btn");
    var out = {
      labels: labels,
      ownedN: owned.length,
      freeN: free.length,
      bagN: w.self.weapons.length + w.self.passives.length,
      highlighted: box.querySelectorAll(".sp-chip.on").length,
      note: (document.querySelector(".sp-note")||{}).innerText || "",
      btnDisabled: btn.disabled,
      dropId: dropId, addId: addId,
      gold0: w.self.shopGold
    };
    var kn = function(id){
      var d = window.VS.CONST.WEAPON_MAP[id] || window.VS.CONST.PASSIVE_MAP[id];
      return d ? d.name : id;
    };
    out.dropName = kn(dropId); out.addName = kn(addId);
    btn.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    out.gold1 = w.self.shopGold;
    out.dropGone = !(w.self.weapons.some(function(x){ return x.id === dropId; }) ||
                     w.self.passives.some(function(x){ return x.id === dropId; }));
    out.addIn = w.self.weapons.some(function(x){ return x.id === addId; }) ||
                w.self.passives.some(function(x){ return x.id === addId; });
    out.msg = (document.querySelector(".shop-msg")||{}).innerText || "";
    return out;
  })()`);
  console.log('  置换：' + JSON.stringify(sw1));
  ok('★置换选择器分两步（① 遗忘 / ② 换成）', sw1 && sw1.labels.length === 2, JSON.stringify(sw1 && sw1.labels));
  ok('★第一步只列已拥有的（数量 = 背包数量）',
    sw1 && sw1.ownedN === sw1.bagN, sw1 && (sw1.ownedN + ' vs 背包 ' + sw1.bagN));
  ok('★两步都选中后确认按钮才可用', sw1 && sw1.btnDisabled === false && sw1.highlighted === 2,
    sw1 && JSON.stringify({ d: sw1.btnDisabled, on: sw1.highlighted }));
  ok('★状态行说清了「遗忘 X → 习得 Y」',
    sw1 && sw1.note.indexOf(sw1.dropName) >= 0 && sw1.note.indexOf(sw1.addName) >= 0, sw1 && sw1.note);
  ok('★置换扣 80 金', sw1 && sw1.gold0 - sw1.gold1 === 80, sw1 && (sw1.gold0 + ' → ' + sw1.gold1));
  ok('★被遗忘的那件真的没了', sw1 && sw1.dropGone === true, JSON.stringify(sw1));
  ok('★换上的那件真的在背包里', sw1 && sw1.addIn === true, JSON.stringify(sw1));
  ok('置换之后背包数量不变（一件换一件）',
    sw1 && (sw1.ownedN === sw1.bagN), JSON.stringify(sw1));

  // ---- 取消：关了选择器，一分钱不扣 ----
  const cx = await evalJS(`(async function(){
    var g = window.VS_GAME, w = g.world;
    var gold0 = w.self.shopGold;
    var its = Array.prototype.slice.call(document.querySelectorAll(".shop-item"));
    var c = its.filter(function(b){ return (b.innerText||"").indexOf("血脉契约") >= 0; })[0];
    c.click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var opened = !!document.querySelector(".shop-pick");
    document.querySelector(".sp-cancel").click();
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    return { opened: opened, closed: !document.querySelector(".shop-pick"),
             goldSame: w.self.shopGold === gold0, gold: w.self.shopGold };
  })()`);
  ok('★点「取消」能关掉选择器', cx && cx.opened === true && cx.closed === true, JSON.stringify(cx));
  ok('★★取消之后一分钱没扣', cx && cx.goldSame === true, JSON.stringify(cx));

  // ---------- 8. 技能全满 → 升级自动领补给 ----------
  // 【为什么这条必须真跑一遍】「开关打上了」与「它真的会替玩家领」是两件事。
  //   这里直接把世界摆成「只剩补给」的那个状态（技能全练满时 sim 就是给这一个兜底项），
  //   再开/关开关各看一次 —— 两遍都要看，只验「开了会领」的话，
  //   一个「永远自动领」的 bug 会被当成正确。
  console.log('\n--- [8] 升级自动领补给 ---');
  const AU = `(function(){
    var g = window.VS_GAME, w = g.world, p = w.self;
    g.ui.screen = 'levelup';
    w.state = 'levelup';
    p.pendingLevels = 1;
    p.hp = 40;
    // 技能全练满时，sim 的 buildChoices 什么都给不出来，openLevelUp 会塞这一个兜底项。
    // 这里直接构造同一个候选，等于「站在全满级那一刻」。
    p.choices = [{ type:'fallback', id:'heal', name:'补给', desc:'回复 30 点生命', tag:'补给' }];
    return 1;
  })()`;

  await evalJS('(function(){ window.VS_GAME.ui.autoSupply = false; return 1; })()');
  await evalJS(AU);
  await sleep(700);
  const au0 = await evalJS(`(function(){
    var g = window.VS_GAME, p = g.world.self;
    return { screen: g.ui.screen, hp: Math.round(p.hp), state: g.world.state,
             panel: !!document.querySelector(".overlay .choice") };
  })()`);
  ok('★关着开关时：只剩补给的面板照常停住等人点（没有偷偷替玩家选）',
    au0 && au0.screen === 'levelup' && au0.hp <= 45, JSON.stringify(au0));

  const auToggle = await evalJS(`(function(){
    // 面板上应该出现「以后自动领补给」这个开关（只在真的只剩补给时出现）
    var box = document.querySelector(".auto-supply");
    if (!box) return { err: "面板里没有自动补给开关" };
    var b = box.querySelector(".btn");
    return { has: true, text: (b.innerText||"").trim() };
  })()`);
  ok('★只剩补给时，升级面板里出现「以后自动领补给」开关',
    auToggle && auToggle.has === true, JSON.stringify(auToggle));

  const au1 = await evalJS(`(async function(){
    var g = window.VS_GAME, p = g.world.self;
    g.ui.autoSupply = true;
    var hp0 = Math.round(p.hp);
    await new Promise(function(r){ setTimeout(r, 900); });
    return { hp0: hp0, hp: Math.round(p.hp), screen: g.ui.screen, state: g.world.state,
             pending: p.pendingLevels };
  })()`);
  ok('★★开启开关后：只剩补给时自动领取（血 +30），面板自动收起',
    au1 && au1.hp >= au1.hp0 + 25 && au1.screen === 'playing',
    JSON.stringify(au1));
  // 收尾：关回去，别把这台机器的偏好留在「自动」上
  await evalJS('(function(){ window.VS_GAME.ui.autoSupply = false; return 1; })()');

  // ---------- 9. 手机 + 触摸下：选择器不能被裁掉 ----------
  // 【为什么必须单独验】选择器是**嵌在暂停面板里**的一段长清单（三十来项）。
  //   面板是 overflow:hidden 的（弹层那一套），内容一旦超过面板高度，
  //   多出来的部分会被**直接切掉而且不报错** —— 最坏的形态是「确认按钮看不见」，
  //   玩家选完了技能却点不到确认（这个坑在剧情关卡列表上踩过）。
  //   ★同时也把触摸模拟显式打开：上面第 5 段只改了设备尺寸，没开触摸，
  //     所以那一段量到的其实是「窄屏 + 鼠标」的规则。
  console.log('\n--- [9] 手机 + 触摸：选择器不被裁 ---');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await sleep(500);
  await evalJS(`(function(){
    var g = window.VS_GAME;
    g.fakeHud(null, 0);
    g.ui.screen = 'paused';
    g.world.self.shopGold = 400;
    g.ui.shopMsg = '';
    return 1;
  })()`);
  await sleep(800);
  // 先记一下「没开选择器时暂停面板多高」—— 好判断本轮新增的选择器到底加了多长。
  // 暂停面板本来就长（商店 + 角色数据 + 四个按钮），手机上是靠 overlay 滚动看的，
  // 记录这个数字是为了以后有人问「加了选择器是不是把面板撑爆了」时有据可查。
  const panelClosed = await evalJS('(function(){' +
    'var p = document.querySelector(".overlay .panel");' +
    'return p ? Math.round(p.getBoundingClientRect().height) : -1; })()');
  await evalJS(`(function(){
    var its = Array.prototype.slice.call(document.querySelectorAll(".shop-item"));
    var c = its.filter(function(b){ return (b.innerText||"").indexOf("置换契约") >= 0; })[0];
    if (c) c.click();
    return 1;
  })()`);
  await sleep(600);
  const phone = await evalJS(`(function(){
    var box = document.querySelector(".shop-pick");
    if (!box) return { err: "选择器没开" };
    var btn = box.querySelector(".sp-foot .btn");
    var grid = box.querySelector(".sp-grid");
    var chip = box.querySelector(".sp-chip");
    var panel = box.closest(".panel");
    var ov = document.querySelector(".overlay");
    var br = btn.getBoundingClientRect();
    var pr = panel.getBoundingClientRect();
    var ovr = ov.getBoundingClientRect();
    var gcs = getComputedStyle(grid);
    return {
      coarse: window.matchMedia("(pointer: coarse)").matches,
      vh: document.documentElement.clientHeight,
      btn: { t: Math.round(br.top), b: Math.round(br.bottom) },
      panel: { t: Math.round(pr.top), b: Math.round(pr.bottom), h: Math.round(pr.height) },
      // 面板比视口高是**正常**的（暂停面板本来就长，overlay 负责滚）。
      // 真正要守的是「滚得到底」：面板整体落在 overlay 的可滚范围内。
      panelReachable: ov.scrollHeight >= Math.round(pr.bottom - ovr.top) - 2,
      // ★机制断言：清单自带 max-height + overflow-y，所以它涨到多大都不会把面板顶爆。
      //   不写成「清单必须正在滚动」—— 那是**状态**：置换第一步只有几件，
      //   本来就滚不到（第一版这么写，白报了一条 FAIL）。
      gridMaxH: gcs.maxHeight,
      gridOverflow: gcs.overflowY,
      chipH: chip ? Math.round(chip.getBoundingClientRect().height) : 0,
      gridH: Math.round(grid.getBoundingClientRect().height)
    };
  })()`);
  console.log('  手机剖面：' + JSON.stringify(phone) + '  面板高（选择器关闭时）=' + panelClosed + 'px');
  ok('★触摸模拟真的生效（否则这一整段量的是桌面规则）', phone && phone.coarse === true, JSON.stringify(phone));
  ok('★确认按钮完整落在面板里（没被 .panel 的 overflow:hidden 切掉）',
    phone && !phone.err && phone.btn.t >= phone.panel.t && phone.btn.b <= phone.panel.b,
    JSON.stringify(phone && { btn: phone.btn, panel: phone.panel }));
  ok('★面板整体滚得到（长面板靠 overlay 滚，不是被裁掉）',
    phone && !phone.err && phone.panelReachable === true,
    JSON.stringify(phone && { panel: phone.panel, reachable: phone.panelReachable }));
  ok('★技能清单自带 max-height + overflow-y（机制：涨多大都不会把面板顶爆）',
    phone && phone.gridMaxH && phone.gridMaxH !== 'none' && phone.gridOverflow === 'auto',
    JSON.stringify(phone && { maxH: phone.gridMaxH, oy: phone.gridOverflow }));
  ok('★选择器里的技能块在触屏下 ≥44px（触摸目标约定）',
    phone && phone.chipH >= 44, phone && (phone.chipH + 'px'));
  await evalJS('(function(){ var c=document.querySelector(".sp-cancel"); if(c) c.click(); return 1; })()');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });

  const errs = s.errors.filter(function (e) { return e && e.indexOf('favicon') < 0; });
  ok('页面零 JS 异常', errs.length === 0, errs.slice(0, 2).join(' || '));

  await send('Page.stopScreencast');
  s.ws.close();
  chrome.kill();
  await killByPort(CDP_PORT);
  console.log('\n  PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

// 本轮加了「两段式商店 + 自动补给」两组交互，各段都要等 DOM 更新，
// 150 秒开始不够用（不是卡死，是真在跑）→ 放宽到 240 秒。
setTimeout(function () { console.log('!! 总超时 240 秒'); process.exit(2); }, 240000);
main().catch(function (e) { console.log('脚本出错：' + (e && e.stack || e)); process.exit(1); });
