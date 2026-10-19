// tools/hudalign.js —— 移动端 HUD 实测：① 顶栏三个按钮是否底边对齐 ② 技能区占比
//
// 【为什么要有这个脚本】两个问题都是「肉眼看得出、断言看不出」的：
//   · 三个按钮底边差几像素 —— 只看「按钮都在 44px 以上」这种断言永远抓不到不对齐；
//   · 技能区占屏多少 —— 只有量出「可视战场还剩多少」才知道够不够。
//   所以这里量**相对关系**（底边 y 坐标的极差）与**占屏比例**，而不是量单个元素的高度。
//
// 【另一个坑】`@media (pointer: coarse)` 桌面永不命中 → 必须显式开触摸模拟，
//   不然量的是 PC 版式（那是已知的假失败来源）。
//
// 用法：node tools/hudalign.js [端口]

const { spawn, execFile } = require('node:child_process');

const PORT = Number(process.argv[2] || 3111);
const CDP = 9388;
const { TMP, CHROME } = require('./env');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  →  ' + extra : '')); }
}

function killBrowser() {
  return new Promise(res => execFile('taskkill', ['/F', '/IM', 'chrome-headless-shell.exe'], () => res()));
}

// ★一次量两件事的那个探针：按钮底边 + 技能区占屏
const PROBE = `(function(){
  var q = function(s){ return document.querySelector(s); };
  var qa = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };

  // ---- ① 顶栏右侧三个按钮 ----
  var btns = [
    ['pause', '.hud-right .pause-btn'],
    ['speed', '.hud-right .speed-btn'],
    ['help',  '.hud-right .help-btn']
  ].map(function(pair){
    var el = q(pair[1]);
    if (!el) return { name: pair[0], missing: true };
    var r = el.getBoundingClientRect();
    return { name: pair[0], bottom: Math.round(r.bottom * 10) / 10,
             top: Math.round(r.top * 10) / 10, h: Math.round(r.height * 10) / 10,
             w: Math.round(r.width * 10) / 10, visible: r.width > 0 };
  });

  // 顶栏整块的高度也要知道（右侧被撑高会把中间倒计时挤偏）
  var topbar = q('.hud-top') || q('.topbar');

  // ---- ② 技能区占屏 ----
  var slots = q('.hud-slots');
  var slotInfo = null;
  if (slots) {
    var r = slots.getBoundingClientRect();
    var vh = window.innerHeight;
    slotInfo = {
      h: Math.round(r.height),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vh: vh,
      // 技能区占屏高的比例 —— 「占一半」这句话要变成一个数才好判
      ratioPct: Math.round(r.height / vh * 1000) / 10,
      // 战场实际还剩多少：从技能区顶边往上算（战场可视区）
      battleTop: Math.round(r.top),
      battlePct: Math.round(r.top / vh * 1000) / 10
    };
  }

  return {
    vw: window.innerWidth, vh: window.innerHeight,
    btns: btns,
    topbarH: topbar ? Math.round(topbar.getBoundingClientRect().height) : null,
    slots: slotInfo
  };
})()`;

(async () => {
  await killBrowser();
  const child = spawn(CHROME, [
    '--disable-gpu', '--no-sandbox', '--no-proxy-server', '--hide-scrollbars',
    '--user-data-dir=' + TMP + '/vs_align_profile',
    '--remote-debugging-port=' + CDP, '--remote-allow-origins=*',
    '--window-size=414,896', 'about:blank'
  ], { stdio: 'ignore' });

  for (let i = 0; i < 40; i++) {
    try {
      await new Promise((res, rej) => require('node:http')
        .get({ host: '127.0.0.1', port: CDP, path: '/json/version' }, r => { r.resume(); res(); }).on('error', rej));
      break;
    } catch (e) { await sleep(500); }
  }

  const tab = await fetch('http://127.0.0.1:' + CDP + '/json/new?about:blank', { method: 'PUT' }).then(r => r.json());
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  const send = (m, p) => new Promise((res, rej) => {
    const i = ++id; const t = setTimeout(() => { delete pend[i]; rej(new Error('timeout ' + m)); }, 30000);
    pend[i] = r => { clearTimeout(t); res(r); };
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; }
  });

  const ev = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { ERR: JSON.stringify(r.exceptionDetails).slice(0, 200) };
    return r.result ? r.result.value : null;
  };

  await send('Page.enable'); await send('Runtime.enable');
  // ★★必须开触摸模拟，否则 `@media (pointer: coarse)` 那套手机样式根本不生效，
  //   量出来的是 PC 版式（会误报一大片）。
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await send('Emulation.setDeviceMetricsOverride', {
    width: 414, height: 896, deviceScaleFactor: 2, mobile: true
  });
  await send('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 1 });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/game?debug=1' });
  await sleep(4000);

  // 进对局并造出满配技能（不然 slots 只有 1 行，量不到真实高度）
  await ev(`(function(){
    var G = window.VS_GAME;
    if (!G) return 'NO_GAME';
    try { G.start && G.start(); } catch (e) {}
    return 'OK';
  })()`);
  await sleep(2500);

  // 直接把 hud 塞满：走 fakeHud 预览窗口，然后填 10 武器 + 10 被动 + 3 组合技
  await ev(`(function(){
    var G = window.VS_GAME;
    if (!G || !G.fakeHud) return 'NO_FAKE';
    var w = [], p = [], c = [];
    var WS = ['刑天干戚','定海神钉','艾草熏烟','净瓶甘露','五雷正法','引魂珠','回风刃','道德真经','陨星巨岩','雷部神锤'];
    var PS = ['血玉髓','玄铁甲','风羽','秘典','千里镜','磁石','分身符','玉冕','金面具','玄铁甲'];
    for (var i = 0; i < 10; i++) {
      w.push({ id: 'w'+i, name: WS[i], level: i === 0 ? 8 : 1 + i, evolved: i === 0 });
      p.push({ id: 'p'+i, name: PS[i], level: 1 + i });
    }
    c.push({ id: 'c1', name: '刃之旋风', level: 3 });
    c.push({ id: 'c2', name: '唤魂', level: 2 });
    c.push({ id: 'c3', name: '冰封葬礼', level: 3 });
    G.fakeHud({ weapons: w, passives: p, combos: c }, 60000);
    return 'OK';
  })()`);
  await sleep(900);

  const m = await ev(PROBE);
  console.log('\n=== 实测（视口 ' + (m.vw) + '×' + (m.vh) + '）===');
  console.log(JSON.stringify(m, null, 2));
  console.log('');

  // ---------- 展开态：折起来后再展开，量「展开时占多少」 ----------
  // ★为什么要量两种状态：折叠是默认，占屏自然小 —— 但那只证明「折叠有效」，
  //   不证明「展开后还能看」。玩家一定会展开的，展开后压掉一半战场就是回归。
  //
  // ★★必须量完展开态**把 slotsFolded 恢复成 true**再量角标：
  //   下面这段会把 ui.slotsFolded 改成 false，如果顺序排反，
  //   后面查角标时它已经是展开态 → `document.querySelector('.slot-fold')` 当然是 null。
  //   而且症状极具误导性（会以为「模板写错了/ v-if 不成立」），
  //   实际是**测试自己把状态改坏了**。所以这里显式恢复，并留注释钉住。
  await ev(`(function(){
    var G = window.VS_GAME;
    if (!G || !G.ui) return 'NO_UI';
    G.ui.slotsFolded = false;
    return 'EXPANDED';
  })()`);
  await sleep(700);
  const expanded = await ev(PROBE);
  console.log('\n=== 展开态 ===');
  console.log(JSON.stringify(expanded.slots, null, 2));
  // ★在量完展开态的**当场**截一张。留到最后截是不行的 ——
  //   后面还有「点角标 → 点收起」的往返，最后一帧已经是折叠态，
  //   于是「展开态截图」里其实是一张折叠图，看不出展开后到底长什么样。
  await send('Page.captureScreenshot', { format: 'png', fullPage: false })
    .then(r => { if (r && r.data) require('node:fs').writeFileSync(TMP + '/vs_hudalign_expanded.png', Buffer.from(r.data, 'base64')); });

  // 收起按钮（展开态的退路）——要在恢复之前量，它只在展开态存在
  const foldBtnGeo = await ev(`(function(){
    var el = document.querySelector('.slot-fold-btn');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    // ★「有没有被别的元素盖住」要单独量：按钮在 DOM 里、rect 也正常，
    //   但可能压在调试面板下面 —— 截图上完全看不见，断言却全绿。
    //   判据用 elementFromPoint（命中点是不是这个按钮自己/它的子元素）。
    var hit = document.elementFromPoint(Math.round(r.left + r.width / 2),
                                       Math.round(r.top + r.height / 2));
    return { w: Math.round(r.width), h: Math.round(r.height),
             left: Math.round(r.left), bottom: Math.round(r.bottom),
             covered: !(hit === el || (hit && el.contains && el.contains(hit))),
             hitTag: hit ? (hit.className || hit.tagName) : 'null',
             vh: window.innerHeight };
  })()`);
  console.log('\n=== 收起按钮 ===');
  console.log(JSON.stringify(foldBtnGeo));

  // ★恢复折叠态，后续的角标断言才有意义
  await ev(`(function(){ window.VS_GAME.ui.slotsFolded = true; return 'FOLDED'; })()`);
  await sleep(700);

  // 角标本身的几何：折叠时它必须 ≥44px 且在屏幕内
  const foldGeo = await ev(`(function(){
    var el = document.querySelector('.slot-fold');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             left: Math.round(r.left), top: Math.round(r.top),
             bottom: Math.round(r.bottom),
             onScreen: r.left >= 0 && r.bottom <= window.innerHeight };
  })()`);
  console.log('\n=== 折叠角标 ===');
  console.log(JSON.stringify(foldGeo));

  // ★再折一次，量「折叠态下技能区是否真的不占屏」——
  //   前面量的是展开态的 slots，现在要的是折叠态的（应为 null）。
  const foldedProbe = await ev(PROBE);
  console.log('\n=== 折叠态的技能区（应为 null）===');
  console.log(JSON.stringify(foldedProbe.slots));

  await send('Page.captureScreenshot', { format: 'png', fullPage: false })
    .then(r => { if (r && r.data) require('node:fs').writeFileSync(TMP + '/vs_hudalign.png', Buffer.from(r.data, 'base64')); });

  // ================= 断言 =================
  const shown = (m.btns || []).filter(b => !b.missing && b.visible);
  ok('顶栏三个按钮都在', shown.length === 3, JSON.stringify(m.btns));

  // ★核心：底边对齐。同一个 flex 行里，不对齐会让「暂停」显得比「?」高一截。
  if (shown.length === 3) {
    const bottoms = shown.map(b => b.bottom);
    const spread = Math.max.apply(null, bottoms) - Math.min.apply(null, bottoms);
    ok('★三个按钮底边对齐（极差 ≤ 1px）', spread <= 1,
      '极差 ' + spread.toFixed(1) + 'px  底边=' + bottoms.join(' / '));

    const heights = shown.map(b => b.h);
    const hs = Math.max.apply(null, heights) - Math.min.apply(null, heights);
    ok('★三个按钮高度一致（极差 ≤ 1px）', hs <= 1,
      '极差 ' + hs.toFixed(1) + 'px  高=' + heights.map(h => h + '').join(' / '));

    // 触摸目标下限是项目约定（44px）
    const small = shown.filter(b => b.h < 44 || b.w < 44);
    ok('三个按钮都 ≥ 44px（触摸目标下限）', small.length === 0,
      small.map(b => b.name + ' ' + b.w + '×' + b.h).join(', '));
  }

  // ---------- 折叠角标 ----------
  // ★先查实况再断言：角标不渲染的原因有好几种（v-if 不成立 / ui 没暴露 /
  //   测试自己把状态改坏了），症状都是「查到 null」。一律报 null 等于没测，
  //   所以这里把相关条件都查出来。
  const foldDiag = await ev(`(function(){
    var ui = window.VS_GAME && window.VS_GAME.ui;
    var hudRef = window.VS_GAME && window.VS_GAME.hud;
    return {
      hasEl: !!document.querySelector('.slot-fold'),
      slotsFolded: ui ? ui.slotsFolded : '(no ui)',
      weaponsLen: hudRef && hudRef.weapons ? hudRef.weapons.length : '(no hud.weapons)',
      spectating: hudRef ? !!hudRef.spectating : '(no hud)'
    };
  })()`);
  console.log('\n=== 角标诊断 ===');
  console.log(JSON.stringify(foldDiag));

  ok('折叠时技能区已隐藏（.hud-slots 不存在）', !foldedProbe.slots,
    '折叠态仍占屏 ' + (foldedProbe.slots ? foldedProbe.slots.h + 'px' : ''));
  ok('折叠角标存在', !!foldGeo,
    '诊断：' + JSON.stringify(foldDiag));
  if (foldGeo) {
    ok('★角标 ≥ 44×44（触摸目标下限）', foldGeo.w >= 44 && foldGeo.h >= 44,
      foldGeo.w + '×' + foldGeo.h);
    ok('★角标完整在屏幕内（没被手势条切掉）', foldGeo.onScreen,
      'left=' + foldGeo.left + ' bottom=' + foldGeo.bottom + ' 屏高=' + foldedProbe.vh);
    const foldNum = await ev(`(function(){
      var n = document.querySelector('.slot-fold .sf-n');
      return n ? n.textContent.trim() : '';
    })()`);
    ok('★角标显示已学技能数（不能是纯图标）', /\d/.test(foldNum || ''),
      '角标文字=' + JSON.stringify(foldNum) + ' → 折叠起来看不出自己学了什么');
    ok('★组合技有金色「技」字标记',
      !!(await ev(`!!document.querySelector('.slot-fold .sf-badge')`)),
      '凑出组合技了但角标上看不出来');

    // ---------- ★端到端：真的点一下角标 ----------
    // ★这里必须用**真实点击事件**，不能像上面那样直接改 ui.slotsFolded：
    //   改状态绕过了 @click 绑定 —— 「按钮写了但没绑上」「点不到」这两类真 bug
    //   那样测**全部测不出来**，而且症状是「界面上有个按钮，点了没反应」。
    const clickRes = await ev(`(function(){
      var el = document.querySelector('.slot-fold');
      if (!el) return { err: 'NO_EL' };
      el.click();
      return { clicked: true };
    })()`);
    await sleep(700);
    const afterClick = await ev(`(function(){
      return {
        folded: window.VS_GAME.ui.slotsFolded,
        slotsShown: !!document.querySelector('.hud-slots'),
        foldBtnShown: !!document.querySelector('.slot-fold-btn')
      };
    })()`);
    ok('★点角标真的展开技能区（端到端，非改状态）',
      afterClick.folded === false && afterClick.slotsShown === true,
      JSON.stringify(clickRes) + ' → ' + JSON.stringify(afterClick));
    ok('★展开后「收起」按钮出现（不是单向门）', afterClick.foldBtnShown === true,
      '点开就回不去了');

    // 再点收起，验证闭环
    const backRes = await ev(`(function(){
      var el = document.querySelector('.slot-fold-btn');
      if (!el) return { err: 'NO_BTN' };
      el.click();
      return { clicked: true };
    })()`);
    await sleep(700);
    const afterBack = await ev(`(function(){
      return { folded: window.VS_GAME.ui.slotsFolded,
               slotsShown: !!document.querySelector('.hud-slots'),
               foldBadgeShown: !!document.querySelector('.slot-fold') };
    })()`);
    ok('★点「收起」能折回去（闭环）',
      afterBack.folded === true && afterBack.slotsShown === false
      && afterBack.foldBadgeShown === true,
      JSON.stringify(backRes) + ' → ' + JSON.stringify(afterBack));
  }

  // ---------- 展开态（玩家一定会展开） ----------
  ok('展开后技能区回来了', !!expanded.slots,
    '点角标/收起按钮没有把技能区放回来');
  if (expanded.slots) {
    ok('★展开后仍不占屏一半（≤ 40%）', expanded.slots.ratioPct <= 40,
      '当前 ' + expanded.slots.ratioPct + '%（高 ' + expanded.slots.h + 'px）');
    ok('★展开后战场仍留 ≥ 50%', expanded.slots.battlePct >= 50,
      '当前 ' + expanded.slots.battlePct + '%');
  }

  // ---------- 展开态的退路（否则按开就回不去） ----------
  ok('展开态有「收起」按钮（不能是单向门）', !!foldBtnGeo, '没有 .slot-fold-btn');
  if (foldBtnGeo) {
    ok('★收起按钮 ≥ 44px 高', foldBtnGeo.h >= 44, foldBtnGeo.h + 'px');
    ok('★收起按钮没被调试面板之类盖住（点得到）', !foldBtnGeo.covered,
      '中心点命中的是 ' + foldBtnGeo.hitTag + ' —— 按钮在页面上，但被压住了');
    ok('★收起按钮在屏幕内', foldBtnGeo.bottom <= foldBtnGeo.vh,
      'bottom=' + foldBtnGeo.bottom + ' 屏高=' + foldBtnGeo.vh);
  }

  await send('Page.captureScreenshot', { format: 'png', fullPage: false })
    .then(r => { if (r && r.data) require('node:fs').writeFileSync(TMP + '/vs_hudalign.png', Buffer.from(r.data, 'base64')); });

  console.log('\n========================================');
  console.log('  PASS ' + pass + ' / FAIL ' + fail);
  console.log('  截图：' + TMP + '/vs_hudalign.png');
  console.log('========================================');

  ws.close(); child.kill(); await killBrowser();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('异常：' + (e && e.stack || e)); process.exit(1); });