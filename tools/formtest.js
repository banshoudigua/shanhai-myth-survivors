// tools/formtest.js —— 登录/注册表单在手机上的「跳上跳下」回归（第二十九轮）
//
// 【为什么单开一条】这个问题在桌面上完全复现不出来：桌面没有软键盘，
// 浏览器也不会为了「键盘挤压」再滚一次。而它是**纯几何**问题 ——
// 表单比一屏高多少、聚焦时页面滚多少、滚完会不会回弹，全都可以量。
// 所以用手机仿真把这几件事钉死，别人以后动登录页样式时能立刻看到回归。
//
// 用法：node tools/formtest.js [端口或完整网址]
// 依赖：先启动 server/index.js
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { TMP, CHROME, splitShare, shareSuffix } = require('./env');

// 线上链接带分享码：允许直接把整条分享链接传进来，这里拆出 code（机制见 env.js 的注释）
const SH = splitShare(process.argv[2] || 3000);
const SHARE = shareSuffix(SH.code);
const ARG = SH.url;
const ONLINE = /^https?:\/\//.test(ARG);
const BASE = ONLINE ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9355;
const PROFILE = TMP + '/vs_formtest_profile';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function proxyArgs() {
  if (!ONLINE) return ['--no-proxy-server'];
  const proxy = process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || '';
  return proxy ? ['--proxy-server=' + proxy] : [];
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const cp = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + PROFILE,
      '--window-size=1280,900', '--force-device-scale-factor=1'
    ].concat(proxyArgs()).concat(['about:blank']), { stdio: 'ignore' });
    let tries = 0;
    const timer = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        clearInterval(timer); res.resume(); resolve(cp);
      }).on('error', function () {
        if (tries > 40) { clearInterval(timer); reject(new Error('调试端口没起来')); }
      });
    }, 500);
  });
}

function connect() {
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
            const mid = ++id;
            const to = setTimeout(function () { delete pending[mid]; rej(new Error('CDP 超时：' + method)); }, 15000);
            pending[mid] = function (r) { clearTimeout(to); res(r); };
            ws.send(JSON.stringify({ id: mid, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const m = JSON.parse(ev.data);
          if (m.id && pending[m.id]) { pending[m.id](m.result); delete pending[m.id]; return; }
          if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails || {};
            pageErrors.push(d.text || 'exception');
          }
        });
        ws.addEventListener('open', function () {
          send('Runtime.enable');
          send('Page.enable');
          send('Network.enable').then(function () {
            return send('Network.setCacheDisabled', { cacheDisabled: true });
          });
          // ★无头 Chromium 不开 screencast 时 rAF 只跑 3 帧
          send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 });
          resolve({
            send: send,
            pageErrors: pageErrors,
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
              if (r && r.exceptionDetails) {
                const ex = r.exceptionDetails.exception || {};
                pageErrors.push('eval 异常：' + (ex.description ? String(ex.description).split('\n')[0] : ''));
                return null;
              }
              return r && r.result ? r.result.value : null;
            },
            nav: function (u) { return send('Page.navigate', { url: u }); },
            shot: async function (p) {
              const r = await send('Page.captureScreenshot', { format: 'png' });
              if (r && r.data) fs.writeFileSync(p, Buffer.from(r.data, 'base64'));
            },
            close: function () { ws.close(); }
          });
        });
        ws.addEventListener('error', function () { reject(new Error('CDP WS 出错')); });
      });
    });
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(150);
  }
  console.log('  （等待超时：' + label + '）');
  return null;
}

// 手机仿真：iPhone 12 级别
async function usePhone(P) {
  await P.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
    screenWidth: 390, screenHeight: 844
  });
  await P.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

async function useDesktop(P) {
  await P.send('Emulation.clearDeviceMetricsOverride');
  await P.send('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 0 });
}

async function main() {
  let pass = 0, fail = 0;
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  }

  const chrome = await launchChrome();
  const P = await connect();

  // ============================================================
  // 一、手机：登录屏的几何
  // ============================================================
  console.log('=== 一、手机 390×844：登录屏 ===');
  await usePhone(P);
  await P.nav(BASE + '/?debug=1' + SHARE);
  await waitFor(function () { return P.eval('!!document.querySelector(".input")'); }, 20000, '登录表单');
  await sleep(700);

  const m1 = JSON.parse(await P.eval(`(function(){
    var inp = document.querySelector('.input');
    var hero = document.querySelector('.hero-banner');
    var card = document.querySelector('.card');
    var cs = getComputedStyle(inp);
    return JSON.stringify({
      font: cs.fontSize,
      scrollMargin: cs.scrollMarginTop,
      heroH: hero ? Math.round(hero.getBoundingClientRect().height) : -1,
      slim: hero ? hero.classList.contains('hero-slim') : false,
      cardTop: Math.round(card.getBoundingClientRect().top + window.scrollY),
      scrollH: document.scrollingElement.scrollHeight,
      innerH: window.innerHeight
    });
  })()`));
  console.log('  ' + JSON.stringify(m1));
  ok('登录屏横幅压到 72px（hero-slim 生效）', m1.slim && m1.heroH <= 80, 'heroH=' + m1.heroH + ' slim=' + m1.slim);
  ok('输入框字号 ≥16px（iOS 不会自动放大整页）', parseFloat(m1.font) >= 16, m1.font);
  ok('输入框有滚动边距（聚焦时不会贴边，少一次修正滚动）',
    parseFloat(m1.scrollMargin) >= 60, m1.scrollMargin);
  ok('★登录表单溢出量 < 120px（原来 942-844=98，压扁后应更小）',
    (m1.scrollH - m1.innerH) < 120, (m1.scrollH - m1.innerH) + 'px');

  // 移动端修正脚本挂上了吗（?debug=1 才暴露调试口）
  ok('触摸设备上挂载了 mobile-form 修正层',
    !!(await P.eval('!!window.VS_MOBILE_FORM')),
    'VS_MOBILE_FORM 不存在');

  // ============================================================
  // 二、手机：注册屏 + 聚焦行为（不许来回弹）
  // ============================================================
  console.log('\n=== 二、手机：注册屏 ===');
  await P.eval(`(function(){
    var bs = [].slice.call(document.querySelectorAll('.tab'));
    for (var i = 0; i < bs.length; i++) {
      if (bs[i].textContent.trim() === '注册') { bs[i].click(); return true; }
    }
    return false;
  })()`);
  await sleep(500);

  const m2 = JSON.parse(await P.eval(`(function(){
    var list = [].slice.call(document.querySelectorAll('.input'));
    var last = list[list.length - 1].getBoundingClientRect();
    return JSON.stringify({
      inputs: list.length,
      lastTop: Math.round(last.top + window.scrollY),
      scrollH: document.scrollingElement.scrollHeight,
      innerH: window.innerHeight,
      autocomplete: list.map(function (i) { return i.getAttribute('autocomplete') || ''; }),
      enter: list.map(function (i) { return i.getAttribute('enterkeyhint') || ''; })
    });
  })()`));
  console.log('  ' + JSON.stringify(m2));
  ok('注册表单 5 个输入框都在', m2.inputs === 5, String(m2.inputs));
  ok('★最后一个输入框的首屏位移已从 881 降到 ≤ 840', m2.lastTop <= 840, 'lastTop=' + m2.lastTop);
  ok('每个输入框都声明了 autocomplete（换框时键盘不再换型，少一次高度变化）',
    m2.autocomplete.length === 5 && m2.autocomplete.every(function (v) { return v !== ''; }),
    m2.autocomplete.join(','));
  ok('每个输入框都声明了 enterkeyhint', m2.enter.length === 5 && m2.enter.every(function (v) { return v !== ''; }),
    m2.enter.join(','));

  // 聚焦最后一个框，采样 scrollY：只允许单调向下一段，不许回弹
  const samples = JSON.parse(await P.eval(`(function(){
    var list = [].slice.call(document.querySelectorAll('.input'));
    var el = list[list.length - 1];
    window.scrollTo(0, 0);
    var out = [];
    el.focus();
    var t0 = performance.now();
    return new Promise(function(res){
      var iv = setInterval(function(){
        out.push(Math.round(window.scrollY));
        if (performance.now() - t0 > 900) { clearInterval(iv); res(JSON.stringify(out)); }
      }, 30);
    });
  })()`));
  let maxBack = 0, maxY = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i] > maxY) maxY = samples[i];
    const back = maxY - samples[i];
    if (back > maxBack) maxBack = back;
  }
  console.log('  scrollY 采样：' + samples.slice(0, 24).join(',') + ' …');
  ok('★聚焦最后一个输入框时页面只滚一次，不回弹（回弹 ≤ 4px）',
    maxBack <= 4, '回弹 ' + maxBack + 'px，最大 scrollY=' + maxY);

  await P.shot(TMP + '/vs_form_phone.png');
  console.log('  截图：' + TMP + '/vs_form_phone.png');

  // ============================================================
  // 三、桌面：大横幅不能被压扁，修正层不该挂
  // ============================================================
  console.log('\n=== 三、桌面 1280×900 ===');
  await useDesktop(P);
  await P.nav(BASE + '/?debug=1' + SHARE);
  await waitFor(function () { return P.eval('!!document.querySelector(".input")'); }, 20000, '登录表单');
  await sleep(600);
  const m3 = JSON.parse(await P.eval(`(function(){
    var hero = document.querySelector('.hero-banner');
    return JSON.stringify({
      heroH: hero ? Math.round(hero.getBoundingClientRect().height) : -1,
      vw: window.innerWidth,
      mobileFix: !!window.VS_MOBILE_FORM
    });
  })()`));
  console.log('  ' + JSON.stringify(m3));
  ok('桌面横幅保持原高度（≥150px）', m3.heroH >= 150, 'heroH=' + m3.heroH);

  // ★无头 Chrome 在同一个标签页里开过触摸仿真之后，`(pointer: coarse)` 不会可靠地切回 fine，
  //   所以这里**不测「脚本有没有挂上」，改测真正的契约**：桌面上聚焦输入框不许动滚动位置。
  //   （脚本内部还有一道 keyboardOpen() 闸门：可视区没被键盘占走就一次都不修。）
  const deskScroll = JSON.parse(await P.eval(`(function(){
    var el = document.querySelector('.input');
    window.scrollTo(0, 0);
    el.focus();
    return JSON.stringify({before: Math.round(window.scrollY)});
  })()`));
  await sleep(500);
  const deskAfter = JSON.parse(await P.eval(`(function(){
    return JSON.stringify({
      after: Math.round(window.scrollY),
      fixes: window.VS_MOBILE_FORM ? window.VS_MOBILE_FORM.state().fixes : 0,
      keyboard: window.VS_MOBILE_FORM ? window.VS_MOBILE_FORM.state().keyboard : false
    });
  })()`));
  console.log('  桌面聚焦：' + JSON.stringify(deskScroll) + ' -> ' + JSON.stringify(deskAfter));
  ok('★桌面聚焦输入框不会挪动页面（没有键盘就不做任何修正）',
    deskAfter.after === deskScroll.before && deskAfter.fixes === 0,
    'scrollY ' + deskScroll.before + '→' + deskAfter.after + '，fixes=' + deskAfter.fixes);
  ok('桌面上不会误判「键盘打开」', deskAfter.keyboard === false, 'keyboard=' + deskAfter.keyboard);

  ok('全程没有 JS 异常', P.pageErrors.length === 0, P.pageErrors.slice(0, 3).join(' | '));

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  P.close();
  chrome.kill();
  process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) {
  console.error('脚本出错：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
