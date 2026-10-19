// tools/pausecheck.js —— 暂停行为回归
//
// 【为什么需要它】用户报障：「有时按暂停，会暂停，但没有弹出暂停面板」。
// 「有时」的问题必须靠**逐帧采样**才抓得到 —— 肉眼点几十次也未必撞上那一帧。
//
// 本脚本做三件事：
//   ① 逐帧采样 (ui.screen, world.state)，抓「世界停住但没有任何面板」的状态
//   ② 反复按 Esc，统计「按了却没进入暂停」的比例（按键被吞）
//   ③ 断言「进入 paused 时暂停面板必须在 DOM 里」
//
// 用法：node tools/pausecheck.js [端口或域名] [秒数]

const { spawn } = require('node:child_process');
const CDP_PORT = 9401;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_pausecheck_profile';

// 启动参数里的代理部分。
// ★测**线上域名**时必须显式指定代理：Windows 版 Chrome **不读** `http_proxy` 环境变量
//   （只认系统代理设置，而本机是「直连」），不指定的话导航会落到
//   `chrome-error://chromewebdata/` —— 症状是「页面里什么都没有、断言整片红」，
//   看起来像前端崩了，其实一行代码都没错（本地跑全绿）。2026-10-06 踩过一次。
//   ★端口每次会话都可能变（49675 / 52494…）→ 只能从环境变量现取。
function proxyArgs() {
  const p = process.env.http_proxy || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  return (LIVE && p) ? ['--proxy-server=' + p] : ['--no-proxy-server'];
}

const APP_IN = String(process.argv[2] || 3000);
const LIVE = /^(https?:)?\/\//.test(APP_IN);
const BASE = LIVE ? APP_IN.replace(/\/$/, '') : ('http://127.0.0.1:' + APP_IN);
const SECONDS = Number(process.argv[3] || 26);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else {
    fail += 1;
    console.log('  FAIL  ' + name + (extra !== undefined ? ('  -> ' + extra) : ''));
  }
}

async function main() {
  console.log('=== 暂停行为回归（' + BASE + '，跑 ' + SECONDS + ' 秒）===');
  if (!require('node:fs').existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }
  const alive = await fetch(BASE + '/api/health')
    .then((r) => r.status === 200).catch(() => false);
  if (!alive) { console.log('!! 应用服务未就绪：' + BASE); process.exit(1); }

  const child = spawn(CHROME, [
    '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + PROFILE, '--remote-debugging-port=' + CDP_PORT,
    '--remote-allow-origins=*', '--window-size=1280,800', 'about:blank'
  ].concat(proxyArgs()), { stdio: 'ignore' });
  await sleep(2500);
  const tab = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0; const pend = {};
  const send = (m, p) => new Promise((res, rej) => {
    const i = ++id; const t = setTimeout(() => rej(new Error('timeout ' + m)), 20000);
    pend[i] = (r) => { clearTimeout(t); res(r); };
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable'); await send('Runtime.enable');
  // ★开触摸模拟：用户的报障来自 iPad。上一轮「iPad 关卡列表」就是吃了这个亏 ——
  //   不开触摸，测的是 pointer:fine 那套规则，跟用户看到的不是同一个版面。
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    return r.result ? r.result.value : undefined;
  };

  await send('Page.navigate', { url: BASE + '/game.html?debug=1&_t=' + Date.now() });
  await sleep(4000);

  const booted = await evalJS('!!window.VS_GAME');
  ok('调试钩子已挂载', booted === true);
  if (!booted) { ws.close(); child.kill(); process.exit(1); }

  // 开局（单机：先过角色选择）
  await evalJS('window.VS_GAME.start()');
  await sleep(1200);
  ok('已进入对局', (await evalJS('window.VS_GAME.ui.screen')) === 'playing',
    String(await evalJS('window.VS_GAME.ui.screen')));

  // ---------- 注入逐帧监控 ----------
  // ★被判为「异常」的两种状态：
  //   A：screen === 'paused' 但 DOM 里没有暂停面板（面板该显示却没显示）—— 直接命中报障
  //   B：连续多帧「世界停住（world.state !== 'playing'）但没有任何面板」
  //      （既不是 paused、也不是 levelup / result）—— 玩家看到的就是「卡住了但没界面」
  //   B 类要连续 5 帧才算，避免把「同一帧内状态已变、事件还没消费」的过渡帧误报。
  // ★判据必须带「连续帧数」：
  //   Vue 的 DOM 更新是异步批量的 —— 设置 screen='paused' 之后、
  //   DOM 落地之前的那 1 帧，采样会看到「状态是 paused 但面板还没出现」。
  //   那一帧只有 16ms，玩家根本感知不到，属于**测试误报**。
  //   真 bug 是「持续多帧都不出现」—— 玩家才会看到「卡住但没有界面」。
  //   所以 A / B 两类都要求连续 >= 3 帧才计一次异常。
  await evalJS(`(function(){
    var rec = { samples: 0, badA: [], badB: [], seq: [], aStreak: 0, aStart: -1,
                bStreak: 0, bStart: -1, maxA: 0, maxB: 0 };
    window.__pdbg = rec;
    function frame() {
      var g = window.VS_GAME;
      if (g && g.world && g.ui) {
        var sc = g.ui.screen;
        var st = g.world.state;
        var help = !!g.ui.helpOpen;
        rec.samples += 1;
        rec.seq.push(sc + '|' + st + (help ? '|help' : ''));
        if (rec.seq.length > 240) rec.seq.shift();

        // A 类：进暂停态却持续没有暂停面板
        //   ★选择器用 .overlay .panel 而不是某个具体宽度类 ——
        //     暂停面板的宽度类改过一次（panel-narrow → panel-wide，第十三轮加商店时），
        //     当时我写的选择器没跟着改，于是「面板明明在、却判定为不在」，
        //     白白追了半天的假 bug。判「有没有面板」就该只认 .panel。
        //   （图鉴打开时不算 —— 那时候暂停面板本来就不该抢在图鉴前面）
        var aBad = (sc === 'paused') && !help &&
                   !document.querySelector('.overlay .panel');
        if (aBad) {
          if (rec.aStreak === 0) rec.aStart = rec.samples;
          rec.aStreak += 1;
          if (rec.aStreak > rec.maxA) rec.maxA = rec.aStreak;
          if (rec.aStreak === 3) {
            var ov = document.querySelectorAll('.overlay');
            var cls = [];
            for (var i = 0; i < ov.length; i++) cls.push(ov[i].firstElementChild ?
              ov[i].firstElementChild.className : '(空)');
            rec.badA.push({ sc: sc, st: st, help: help, from: rec.aStart,
              overlays: ov.length, panels: cls.join(','), hidden: document.hidden });
          }
        } else { rec.aStreak = 0; }

        // B 类：世界停住却没有任何面板（既不 paused 也不 levelup / result）
        var bBad = (st !== 'playing' && sc !== 'paused' && sc !== 'levelup' &&
                    sc !== 'result' && sc !== 'connecting' && sc !== 'select');
        if (bBad) {
          if (rec.bStreak === 0) rec.bStart = rec.samples;
          rec.bStreak += 1;
          if (rec.bStreak > rec.maxB) rec.maxB = rec.bStreak;
          if (rec.bStreak === 3) rec.badB.push({ sc: sc, st: st, from: rec.bStart });
        } else { rec.bStreak = 0; }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return 1;
  })()`);
  await sleep(600);

  // ---------- 第 1 轮：按 Esc（键盘路径）----------
  // ---------- 反复按 Esc，间隔打乱以撞上不同时机 ----------
  const gaps = [700, 1300, 500, 2100, 900, 1600, 600, 1100, 800, 1900,
                650, 1400, 750, 1700, 850, 1200, 550, 2000, 950, 1500];
  let pressed = 0;
  const t0 = Date.now();
  for (let i = 0; i < 60 && (Date.now() - t0) < SECONDS * 1000; i++) {
    const before = await evalJS('window.VS_GAME.ui.screen');
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27
    });
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27
    });
    pressed += 1;
    await sleep(120);
    const after = await evalJS('window.VS_GAME.ui.screen');
    // 从 playing 按下去，应当进入 paused（除非此刻正好在升级/结算）
    if (before === 'playing' && after !== 'paused' && after !== 'levelup' && after !== 'result') {
      await evalJS(`(function(){ window.__pdbg.badPress = window.__pdbg.badPress || [];
        window.__pdbg.badPress.push({ before: ${JSON.stringify(before)}, after: ${JSON.stringify(after)} }); return 1; })()`);
    }
    await sleep(gaps[i % gaps.length]);
  }

  // ---------- 第 2 轮：点「暂停」按钮（触摸设备的真实操作）----------
  // ★用户报障来自 iPad，而 iPad 上没有 Esc 键 —— 它只能点按钮。
  //   只测键盘路径等于没测用户的操作方式（上一轮「关卡列表」就吃过这个亏）。
  console.log('');
  console.log('  第 2 轮：点暂停按钮（触摸路径）');
  let btnRounds = 0, btnBad = 0, btnNoBtn = 0;
  const btnBadDetail = [];
  for (let i = 0; i < 8; i++) {
    // 先确保处于 playing
    // ★必须先处理 levelup：跑第 1 轮时打怪会自然升级，一旦停在升级面板就再也出不来，
    //   后面所有轮次都会「找不到暂停按钮」—— 那是测试自身把游戏卡住了，不是产品 bug。
    await evalJS(`(function(){
      var g = window.VS_GAME;
      // 升级面板：点第一个候选把它消化掉
      if (g.ui.screen === 'levelup') {
        var ch = document.querySelectorAll('.overlay .choice, .overlay-dock .choice');
        if (ch.length) ch[0].click();
        return 'levelup-cleared';
      }
      return 'ok';
    })()`);
    await sleep(300);
    await evalJS(`(function(){
      var g = window.VS_GAME;
      if (g.ui.screen === 'paused') {
        var bs = document.querySelectorAll('.overlay .panel .btn');
        for (var i = 0; i < bs.length; i++) {
          if ((bs[i].textContent || '').indexOf('继续') >= 0) { bs[i].click(); break; }
        }
      }
      return 1; })()`);
    await sleep(250);

    const clicked = await evalJS(`(function(){
      var b = document.querySelector('.pause-btn');
      if (!b) return 'no-btn';
      b.click();
      return 'clicked';
    })()`);
    if (clicked !== 'clicked') { btnNoBtn += 1; await sleep(400); continue; }
    btnRounds += 1;
    await sleep(220);

    const st = await evalJS(`(function(){
      var g = window.VS_GAME;
      return { sc: g.ui.screen, panel: !!document.querySelector('.overlay .panel'),
               hasPauseBtn: !!document.querySelector('.pause-btn') };
    })()`);
    // 点了暂停按钮，就该进入 paused 且面板可见
    if (st.sc !== 'paused' || !st.panel) {
      btnBad += 1;
      btnBadDetail.push({ round: i, sc: st.sc, panel: st.panel, btn: st.hasPauseBtn });
    }

    // 恢复，继续下一轮
    await evalJS(`(function(){
      var bs = document.querySelectorAll('.overlay .panel .btn');
      for (var i = 0; i < bs.length; i++) {
        if ((bs[i].textContent || '').indexOf('继续') >= 0) { bs[i].click(); break; }
      }
      return 1; })()`);
    await sleep(300);
  }
  console.log('  按钮轮次：' + btnRounds + '（按钮不可见 ' + btnNoBtn + ' 次）');

  const rec = await evalJS('(function(){ var r = window.__pdbg; return { samples: r.samples, badA: r.badA.length, badB: r.badB.length, maxA: r.maxA, maxB: r.maxB, badPress: (r.badPress||[]).length, badASample: r.badA[0]||null, badBSample: r.badB[0]||null, badPressSample: (r.badPress||[])[0]||null, tail: r.seq.slice(-14) }; })()');

  console.log('');
  console.log('  采样帧数：' + rec.samples + '｜按 Esc 次数：' + pressed);
  console.log('  最长连续异常：A(暂停无面板)=' + rec.maxA + ' 帧  B(停住无界面)=' + rec.maxB + ' 帧');
  console.log('  末段状态序列（screen|world.state）：' + rec.tail.join('  '));
  console.log('');

  ok('★进入暂停态时暂停面板一定在 DOM 里（A 类异常 = 0）',
    rec.badA === 0, JSON.stringify(rec.badASample));
  ok('★不存在「世界停住却没有任何面板」的持续状态（B 类异常 = 0）',
    rec.badB === 0, JSON.stringify(rec.badBSample));
  ok('★从 playing 按 Esc 一定进入 paused（按键不被吞）',
    rec.badPress === 0, JSON.stringify(rec.badPressSample));
  ok('★点「暂停」按钮一定进入 paused 且面板可见（触摸设备的真实路径）',
    btnRounds > 0 && btnBad === 0, JSON.stringify(btnBadDetail));

  console.log('');
  console.log('========================================');
  console.log('  PASS = ' + pass + '   FAIL = ' + fail);
  console.log('========================================');

  ws.close(); child.kill();
  process.exit(fail ? 1 : 0);
}
main().catch(function (e) { console.log('err', e && e.message); process.exit(1); });
