// tools/storylist.js —— 剧情模式「关卡列表」排版回归
//
// 【为什么需要它】用户截图报障：关卡卡片里的第 4 行（「需要先通关第 N 关」）
// 看起来被切掉一半，跟下一张卡叠在一起。这类问题**必须量，不能靠肉眼**：
// 被裁的元素「字还在，只是少了半截」，看截图很容易当成字体渲染问题。
//
// 量三件事：
//   ① 每张卡片的 offsetHeight vs scrollHeight（自己有没有溢出）
//   ② 卡片内每个子元素的 rect 是否越出卡片边界（越出 = 被裁或盖住邻居）
//   ③ 相邻卡片的 rect 是否相交（叠在一起 = 版面坏了）
//
// 用法：node tools/storylist.js [端口或域名] [宽] [高]

const { spawn } = require('node:child_process');
const CDP_PORT = 9381;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_storylist_profile';

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
const VW = Number(process.argv[3] || 820);
const VH = Number(process.argv[4] || 1180);

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
  console.log('=== 剧情关卡列表排版回归（' + BASE + ' 视口 ' + VW + 'x' + VH + '）===');
  if (!require('node:fs').existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }

  const alive = await fetch(BASE + '/api/health')
    .then((r) => r.status === 200).catch(() => false);
  if (!alive) { console.log('!! 应用服务未就绪：' + BASE); process.exit(1); }

  const child = spawn(CHROME, [
    '--disable-gpu', '--no-sandbox',
    '--user-data-dir=' + PROFILE,
    '--remote-debugging-port=' + CDP_PORT,
    '--remote-allow-origins=*',
    '--window-size=' + VW + ',' + VH,
    'about:blank'
  ].concat(proxyArgs()), { stdio: 'ignore' });

  await sleep(2500);
  const tab = await (await fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pend = {};
  const send = (m, p) => new Promise((res, rej) => {
    const i = ++id;
    const t = setTimeout(() => rej(new Error('timeout ' + m)), 20000);
    pend[i] = (r) => { clearTimeout(t); res(r); };
    ws.send(JSON.stringify({ id: i, method: m, params: p || {} }));
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend[m.id]) { pend[m.id](m.result); delete pend[m.id]; }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  await send('Page.enable');
  await send('Runtime.enable');
  // 真实设备视口：宽高比用户截图一致
  await send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 1, mobile: VW < 760
  });
  // ★触摸模拟默认开：iPad 是 pointer: coarse，会命中**另一套**规则
  //   （pixel-ui.css 的 `button { min-height: 44px }` 只在 coarse 下生效）。
  //   ★这是本轮最关键的一条：**不开触摸就测不到 iPad 的真实版面**，
  //     之前的「8/0 全绿」正是因为漏了它 —— 绿得毫无意义。
  //   传第四参数 0 可关掉，用于开关对比。
  const TOUCH = process.argv[5] !== '0';
  if (TOUCH) {
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  console.log('  触摸模拟：' + (TOUCH ? '开（pointer:coarse，等同 iPad）' : '关（pointer:fine，桌面）'));

  const evalJS = async (expr) => {
    const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
    return r.result ? r.result.value : undefined;
  };

  await send('Page.navigate', { url: BASE + '/index.html?debug=1&_t=' + Date.now() });
  await sleep(4000);

  // ---------- 打开剧情模式弹层 ----------
  // ★走**真实用户路径**（点按钮）而不是调内部方法：
  //   ① VS_LOBBY 是 getter 白名单，根本没暴露 openStory
  //   ② 就算暴露了，直接改状态也测不到「入口能不能点、点了出不出得来」
  // 页面初始停在登录页，所以先以游客身份进大厅。
  const step1 = await evalJS(`(function(){
    var b = document.querySelector('.btn-gold.btn-block');
    if (!b) return 'no-guest-btn';
    var inp = document.querySelector('.input');
    if (inp) {
      // 用 native setter 写 v-model，否则 Vue 收不到 input 事件
      var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(inp, '排版测试');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    b.click();
    return 'clicked';
  })()`);
  console.log('  进入大厅：' + step1);
  await sleep(2500);

  const step2 = await evalJS(`(function(){
    var b = document.querySelector('.btn-story');
    if (!b) return 'no-story-btn';
    b.click();
    return 'clicked';
  })()`);
  await sleep(800);
  console.log('  打开剧情弹层：' + step2);
  ok('剧情入口按钮存在且能打开弹层', step2 === 'clicked');

  // ---------- 量：卡片自身的溢出 + 子元素越界 ----------
  const m = await evalJS(`(function(){
    var list = document.querySelector('.story-list');
    if (!list) return { err: 'no .story-list' };
    var cards = Array.prototype.slice.call(list.querySelectorAll('.story-card'));
    if (!cards.length) return { err: 'no cards' };

    var lr = list.getBoundingClientRect();
    var out = {
      cards: cards.length,
      list: {
        h: Math.round(lr.height),
        scrollH: list.scrollHeight,
        clientH: list.clientHeight,
        scrollable: list.scrollHeight > list.clientHeight + 1
      },
      rows: []
    };

    cards.forEach(function (c, i) {
      var cr = c.getBoundingClientRect();
      var cs = getComputedStyle(c);
      // 卡片自己有没有「内容比盒子高」
      var selfOver = c.scrollHeight - c.clientHeight;

      // 每个子元素的边界
      var kids = Array.prototype.slice.call(c.children);
      var kidInfo = kids.map(function (k) {
        var kr = k.getBoundingClientRect();
        return {
          cls: k.className,
          h: Math.round(kr.height),
          top: Math.round(kr.top - cr.top),
          bottom: Math.round(kr.bottom - cr.top),
          // 超出卡片底部多少（>0 表示被卡片裁掉/盖住邻居）
          over: Math.round(kr.bottom - cr.bottom),
          scrollH: k.scrollHeight
        };
      });

      // ★单独量「锁定提示」那一行 —— 用户截图上「看起来被切半截」的就是它。
      //   它挤在卡片最底部，只要离边框太近（或溢出），视觉上就跟下一张卡粘在一起。
      var lockEl = c.querySelector('.sc-lock');
      var lockInfo = null;
      if (lockEl) {
        var lkr = lockEl.getBoundingClientRect();
        var padB = parseFloat(getComputedStyle(c).paddingBottom) || 0;
        lockInfo = {
          h: Math.round(lkr.height),
          top: Math.round(lkr.top - cr.top),
          bottom: Math.round(lkr.bottom - cr.top),
          // 距卡片**内容区**底边还有多少（负数 = 已经溢出被裁）
          gapToPad: Math.round(cr.bottom - padB - lkr.bottom),
          // 距卡片盒底边（含 padding）
          gapToBox: Math.round(cr.bottom - lkr.bottom),
          text: (lockEl.textContent || '').trim()
        };
      }

      out.rows.push({
        i: i,
        no: (c.querySelector('.sc-no') || {}).textContent || '',
        h: Math.round(cr.height),
        scrollH: c.scrollHeight,
        clientH: c.clientHeight,
        selfOver: selfOver,
        top: Math.round(cr.top),
        bottom: Math.round(cr.bottom),
        overflow: cs.overflow,
        alignItems: cs.alignItems,
        // ★高度被谁钉住的关键证据：盒模型 + 三个高度属性
        box: cs.boxSizing,
        hProp: cs.height,
        minH: cs.minHeight,
        maxH: cs.maxHeight,
        disp: cs.display,
        padT: cs.paddingTop,
        padB2: cs.paddingBottom,
        // 内层承载者的真实高度（它才是内容高度）
        innerH: (function () {
          var el = c.querySelector('.sc-inner');
          return el ? Math.round(el.getBoundingClientRect().height) : -1;
        })(),
        innerDisp: (function () {
          var el = c.querySelector('.sc-inner');
          return el ? getComputedStyle(el).display : '';
        })(),
        locked: c.className.indexOf('locked') >= 0,
        kids: kidInfo,
        lock: lockInfo
      });
    });
    return out;
  })()`);

  if (m.err) { console.log('  !! ' + m.err); ws.close(); child.kill(); process.exit(1); }

  console.log('');
  console.log('  列表：高 ' + m.list.h + 'px / 内容 ' + m.list.scrollH + 'px / 可视 ' + m.list.clientH +
    'px' + (m.list.scrollable ? '（可滚动）' : '（不可滚动）'));
  console.log('');
  m.rows.forEach(function (r) {
    console.log('  卡片' + r.no + '  盒高=' + r.h + '  内容高=' + r.scrollH +
      '  自溢出=' + r.selfOver + '  overflow=' + r.overflow);
    console.log('        display=' + r.disp + ' box=' + r.box + ' height=' + r.hProp +
      ' min=' + r.minH + ' max=' + r.maxH + ' pad=' + r.padT + '/' + r.padB2);
    console.log('        .sc-inner display=' + r.innerDisp + ' 真实高=' + r.innerH +
      '（内容被裁与否看这一对：盒高 vs innerH）');
    r.kids.forEach(function (k) {
      console.log('      ' + (k.cls || '?').padEnd(12) + ' 高=' + String(k.h).padStart(4) +
        '  top=' + String(k.top).padStart(4) + '  bottom=' + String(k.bottom).padStart(4) +
        '  越出卡片=' + k.over);
    });
    if (r.lock) {
      console.log('      >> .sc-lock 高=' + r.lock.h + ' top=' + r.lock.top +
        ' bottom=' + r.lock.bottom + ' 距内容底=' + r.lock.gapToPad +
        ' 距盒底=' + r.lock.gapToBox + '  「' + r.lock.text + '」');
    }
  });
  console.log('');

  // ---------- 断言 ----------
  // ① 卡片自己不能有内容溢出
  const selfOverflow = m.rows.filter(function (r) { return r.selfOver > 1; });
  ok('★每张卡片都没有内容溢出（盒高 >= 内容高）',
    selfOverflow.length === 0,
    selfOverflow.map(function (r) { return '卡' + r.no + ' 溢出' + r.selfOver + 'px'; }).join(' | '));

  // ② 子元素不能越出卡片底部
  let bleed = [];
  m.rows.forEach(function (r) {
    r.kids.forEach(function (k) {
      if (k.over > 1) bleed.push('卡' + r.no + ' 的 ' + k.cls + ' 越出 ' + k.over + 'px');
    });
  });
  ok('★卡片内元素都不越出卡片边界（越出就是「被切掉半截」）',
    bleed.length === 0, bleed.join(' | '));

  // ③ 相邻卡片不能相交（叠在一起 = 版面坏）
  let overlap = [];
  for (let i = 0; i < m.rows.length - 1; i++) {
    const a = m.rows[i], b = m.rows[i + 1];
    const ov = a.bottom - b.top;
    if (ov > 1) overlap.push('卡' + a.no + ' 与卡' + b.no + ' 重叠 ' + ov + 'px');
  }
  ok('★相邻卡片不重叠', overlap.length === 0, overlap.join(' | '));

  // ④ 卡片间距一致（gap 生效）
  const gaps = [];
  for (let i = 0; i < m.rows.length - 1; i++) {
    gaps.push(m.rows[i + 1].top - m.rows[i].bottom);
  }
  const gapSame = gaps.length === 0 || gaps.every(function (g) { return Math.abs(g - gaps[0]) <= 1; });
  ok('★卡片间距一致（gap 真的生效）', gapSame, gaps.join(','));

  // ⑤ 列表区域能滚动到全部卡片（内容比可视高时必须可滚）
  ok('长列表可滚动（内容超出时不会静默截断）',
    m.list.scrollH <= m.list.clientH + 1 || m.list.scrollable,
    'scrollH=' + m.list.scrollH + ' clientH=' + m.list.clientH);

  // ⑤b ★锁定提示不能贴边（用户就是看着这个报的「被切半截」）
  //     判据用「距卡片**盒**底」而不是「距内容区底」——
  //     后者要减 border + padding，算错一次就会得出「贴边」的假结论（已踩过）。
  //     盒底距离与盒子模型细节无关，是最不容易算错的量。
  const tight = [];
  m.rows.forEach(function (r) {
    if (!r.lock) return;
    if (r.lock.gapToBox < 12) tight.push('卡' + r.no + ' 的锁定提示距盒底仅 ' + r.lock.gapToBox + 'px');
  });
  ok('★锁定提示距卡片底边 >= 12px（贴边会看着像被切、与下一张卡粘连）',
    tight.length === 0, tight.join(' | '));

  // 【这里原本有一条「同类卡片高度必须一致」的断言，已删除】
  // 它是我加的，但**判据本身是错的**：每关题记长度不同（「天裂处无物，只余风声。」
  // vs「瘴自沼底升，无物自生。」），窄屏换行数就不同，卡片高度必然不等。
  // 列表参差不是 bug —— 用户报的是「被切半截」，不是「高度不一」。
  // ★教训：断言要钉「不该发生的事」，而不是钉「看起来很整齐的样子」。
  //   钉后者会稳定误报，而误报多了会训练人忽略告警。

  // ⑥ 弹层没被居中溢出裁顶
  const panelTop = await evalJS(`(function(){
    var p = document.querySelector('.story-box');
    return p ? Math.round(p.getBoundingClientRect().top) : null;
  })()`);
  ok('★弹层顶部 >= 0（没被居中溢出裁掉）', panelTop !== null && panelTop >= 0, 'top=' + panelTop);

  // ⑥b ★★结构断言（本次报障的真凶守在这里）
  //
  // ★为什么用 **computed style** 而不是去解析 CSS 文本：
  //   ① CSS 文本要走 fetch + 正则，跨了"字符串转义 / 媒体查询 / 加载顺序"三层，
  //      极易写出假绿或假红（第一版就踩了：模板字符串把 `\s` 吃成 `s`，正则静默失配）。
  //   ② computed style 是浏览器**解析并层叠之后**的最终结果 ——
  //      它同时覆盖了「媒体查询有没有命中」「有没有被后加载的规则盖掉」，
  //      这正是我们需要确保的事。
  //   ③ 这几条判据（display / flex-shrink / overflow / min-height）本来就是样式值，
  //      不存在"只有源码里才能看出来"的情况。
  const struct = await evalJS(`(function(){
    var c = document.querySelector('.story-card');
    if (!c) return { err: 'no .story-card' };
    var cs = getComputedStyle(c);
    var inner = c.querySelector('.sc-inner');
    return {
      tag: c.tagName,
      display: cs.display,
      flexShrink: cs.flexShrink,
      flexGrow: cs.flexGrow,
      overflow: cs.overflow,
      minHeight: cs.minHeight,
      appearance: cs.webkitAppearance || cs.appearance,
      innerExists: !!inner,
      innerDisplay: inner ? getComputedStyle(inner).display : '',
      // 卡片高度必须真的容得下内容（这是"没被压扁"的最终证据）
      boxH: Math.round(c.getBoundingClientRect().height),
      innerH: inner ? Math.round(inner.getBoundingClientRect().height) : -1
    };
  })()`);

  if (struct && struct.err) {
    ok('能取到卡片做结构检查', false, struct.err);
  } else {
    ok('★★卡片禁止被压缩（flex-shrink = 0）—— 这是本次「最后一行被切半截」的真凶',
      struct.flexShrink === '0', 'flex-shrink=' + struct.flexShrink + ' flex-grow=' + struct.flexGrow);
    ok('★★卡片盒高真的容得下内容（盒高 >= 内层真实高）',
      struct.boxH >= struct.innerH && struct.innerH > 0,
      '盒高=' + struct.boxH + ' 内容高=' + struct.innerH);
    ok('★卡片是 display:block（不自己当 flex 容器）',
      struct.display === 'block', struct.display);
    ok('★卡片 overflow:visible（内容绝不静默被裁）',
      struct.overflow === 'visible', struct.overflow);
    ok('★卡片 min-height 被清零（不继承触摸兜底的 44px）',
      struct.minHeight === '0px', struct.minHeight);
    ok('★.sc-inner 存在且是 flex 容器（横向排布的真正承载者）',
      struct.innerExists && struct.innerDisplay === 'flex',
      'exists=' + struct.innerExists + ' display=' + struct.innerDisplay);
  }

  // ⑦ 零 JS 异常
  const errs = await evalJS(`(function(){ return (window.__visErrs || []).length; })()`);
  ok('页面零 JS 异常（钩子未挂时为 0）', !errs, 'errs=' + errs);

  // 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = TMP + '/vs_storylist.png';
  require('node:fs').writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('  截图：' + out);

  console.log('');
  console.log('========================================');
  console.log('  PASS = ' + pass + '   FAIL = ' + fail);
  console.log('========================================');

  ws.close();
  child.kill();
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) { console.log('err', e && e.message); process.exit(1); });
