// tools/mobilecheck.js —— 手机端布局排障（多宽度剖面 + 问题清单 + 截图）
//
// 【与 artshot 的 [8] 节分工】artshot 是「验收」：一组断言 + 两张截图，改动后必跑。
// 这个脚本是「排障」：一次把 390/375/360/320 四个宽度、登录页/大厅/候场室/游戏页
// 全量量一遍并给出问题清单 —— 手机上出问题（挤了、溢出了、按钮太小）先跑它，
// 能直接看到是哪个宽度、哪一页、哪个元素出的问题。
//
// 用法：node tools/mobilecheck.js [端口或完整地址]
//
// 【为什么要实测而不是直接改】「哪里挤、哪里溢出、被浏览器底栏遮了多少」
// 都要量出来。凭感觉改容易「修了标题、漏了候场室」。
//
// 【第一版踩的错】写完就在 look() 里先 nav 再量 —— 于是四次测量全部落在
// 登录页（每次导航都会重置回登录页），既没测到已登录大厅、也没测到候场室。
// 现在把「导航」和「测量」分开：整轮只导航两次（大厅 / 游戏页），
// 中间靠改视口来量不同宽度。
const fs = require('node:fs');
const { spawn } = require('node:child_process');

const BASE = 'http://127.0.0.1:' + String(process.argv[2] || 3020);
const CDP_PORT = 9340;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_mobilediag_profile';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const cp = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      '--window-size=390,844', '--force-device-scale-factor=1',
      'about:blank'
    ], { stdio: 'ignore' });
    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        clearInterval(t); res.resume(); resolve(cp);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口没起来')); }
      });
    }, 500);
  });
}

function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      return new Promise(function (resolve) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        let id = 0;
        const pending = {};
        const errs = [];
        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () {
              delete pending[msgId]; rej(new Error('CDP 超时：' + method));
            }, 20000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            errs.push(String((d.exception && d.exception.description) || d.text || '').split('\n')[0]);
          }
        });
        ws.addEventListener('open', function () {
          const api = {
            send: send, errs: errs,
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', {
                expression: expr, returnByValue: true, awaitPromise: true
              });
              if (r && r.exceptionDetails) {
                const d = r.exceptionDetails;
                return {
                  __err: String(d.text || ''),
                  __desc: String((d.exception && d.exception.description) || '').split('\n').slice(0, 2).join(' | ')
                };
              }
              return r && r.result ? r.result.value : null;
            },
            setDevice: function (w, h, mobile) {
              // ★必须同时开 touch emulation：只设 mobile:true 不足以让
              // `pointer: coarse` 匹配，而触摸相关的样式规则全挂在那个媒体查询下
              // —— 不开的话测出来永远是「触摸规则没生效」，真假难辨。
              return send('Emulation.setDeviceMetricsOverride', {
                width: w, height: h, deviceScaleFactor: 1, mobile: !!mobile
              }).then(function () {
                return send('Emulation.setTouchEmulationEnabled', {
                  enabled: !!mobile, maxTouchPoints: mobile ? 5 : 0
                });
              });
            },
            nav: function (url) { return send('Page.navigate', { url: url }); },
            shot: async function (path) {
              const r = await send('Page.captureScreenshot', { format: 'png' });
              if (r && r.data) fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
            },
            close: function () { ws.close(); }
          };
          // ★禁用缓存：profile 复用时会命中启发式缓存，改完 CSS 再跑却拿到旧样式，
          // 表现为「改了没用」—— 很容易被误判成选择器写错。
          send('Network.enable', {}).then(function () {
            return send('Network.setCacheDisabled', { cacheDisabled: true });
          }).then(function () {
            resolve(api);
          });
        });
      });
    });
}

// ★行数是关键指标：标题被挤成「一字一行」时，高度可能只比一行高一点，
// 光看高度会漏判；直接数它占了几行才准。
// ★行数用「高度 ÷ 行高」算，不要用 Range.getClientRects().length ——
// `h1` 里裹着 `<em>辛存者</em>`，同一行上的两个内联片段会各返回一个矩形，
// 于是「一行」被数成两行。我第一版就是这么误报的（明明已经修好了还报 3 行）。
const MEASURE = `(function(){
  function box(sel) {
    var el = document.querySelector(sel);
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }
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
  // 触摸目标：所有可见按钮/链接里高度不足 44px 的
  var small = [];
  Array.prototype.slice.call(document.querySelectorAll("button, .btn")).forEach(function (b) {
    var r = b.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.height < 44) small.push((b.innerText || "").trim().replace(/\\n/g, "/").slice(0, 12) + ":" + Math.round(r.height));
  });
  var tb = document.querySelector(".topbar");
  var kids = [];
  if (tb) {
    Array.prototype.slice.call(tb.children).forEach(function (c) {
      kids.push(Math.round(c.getBoundingClientRect().width));
    });
  }
  return {
    vw: de.clientWidth,
    vh: de.clientHeight,
    scrollW: de.scrollWidth,
    overflowX: de.scrollWidth > de.clientWidth + 1,
    bodyH: document.body.scrollHeight,
    coarse: window.matchMedia("(pointer: coarse)").matches,
    h1W: h1 ? Math.round(h1.getBoundingClientRect().width) : -1,
    h1Lines: lines(h1),
    pLines: lines(bp),
    brand: box(".brand"),
    topbar: box(".topbar"),
    topbarKids: kids,
    conn: box(".conn"),
    smallTargets: small.slice(0, 10)
  };
})()`;

// 谁把页面撑宽了（只看 rect.right 超过视口宽的元素）
const OVERFLOW = `(function(){
  var de = document.documentElement, out = [];
  Array.prototype.slice.call(document.querySelectorAll("*")).forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (r.right > de.clientWidth + 1) {
      out.push({
        t: el.tagName,
        c: String(el.className || "").slice(0, 36),
        right: Math.round(r.right),
        w: Math.round(r.width)
      });
    }
  });
  return out.slice(0, 8);
})()`;

async function main() {
  const chrome = await launchChrome();
  const P = await connect();

  const bad = [];
  async function look(tag, w, h, shotName, checks) {
    await P.setDevice(w, h, true);
    await sleep(700);
    const m = await P.eval(MEASURE);
    console.log('--- ' + tag + '  (' + w + 'x' + h + ') ---');
    if (!m || m.__err) { console.log('  !! 量取失败 ' + JSON.stringify(m)); bad.push(tag + ' 量取失败'); return m || {}; }
    console.log('  视口 ' + m.vw + 'x' + m.vh + '  内容高 ' + m.bodyH +
      '  横向溢出 ' + (m.overflowX ? '!! 是(scrollW=' + m.scrollW + ')' : '否') +
      '  pointer:coarse ' + (m.coarse ? '匹配' : '!! 不匹配'));
    console.log('  标题宽 ' + m.h1W + 'px  占 ' + m.h1Lines + ' 行  副标题占 ' + m.pLines + ' 行' +
      (m.h1Lines > 1 || m.pLines > 1 ? '   << 挤压' : ''));
    console.log('  topbar ' + JSON.stringify(m.topbar) + '  子元素宽度 ' + JSON.stringify(m.topbarKids));
    console.log('  conn ' + JSON.stringify(m.conn));
    console.log('  按钮 <44px：' + (m.smallTargets.length ? JSON.stringify(m.smallTargets) : '无'));
    if (checks) {
      if (m.h1Lines > 1) bad.push(tag + '：标题占了 ' + m.h1Lines + ' 行（被挤压）');
      if (m.pLines > 2) bad.push(tag + '：副标题占了 ' + m.pLines + ' 行');
      if (m.overflowX) bad.push(tag + '：横向溢出');
      if (m.smallTargets.length) bad.push(tag + '：' + m.smallTargets.length + ' 个按钮小于 44px');
    }
    if (checks && m.overflowX) {
      console.log('  溢出元素：' + JSON.stringify(await P.eval(OVERFLOW)));
    }
    if (shotName) { await P.shot(TMP + '/' + shotName); console.log('  截图 ' + shotName); }
    return m;
  }

  // ---------- ① 登录页 ----------
  await P.setDevice(390, 844, true);
  await P.nav(BASE + '/');
  await sleep(2600);
  await P.eval('(function(){ try{ localStorage.removeItem("vs_profile"); }catch(e){} return 1; })()');
  await look('登录页', 390, 844, 'vs_mobile_login.png', true);

  // ---------- ② 以游客身份进大厅 ----------
  await P.eval('(function(){' +
    'var i = document.querySelector("input[placeholder*=\\"名字\\"]");' +
    'if (!i) return "(没找到输入框)";' +
    'i.value = "手机测试"; i.dispatchEvent(new Event("input", {bubbles:true}));' +
    'return i.value; })()');
  await sleep(400);
  const clicked = await P.eval('(function(){' +
    'var l = Array.prototype.slice.call(document.querySelectorAll("button"));' +
    'var b = l.filter(function(x){ return (x.innerText||"").indexOf("游客") >= 0; })[0];' +
    'if (!b) return "(没找到游客按钮)";' +
    'b.click(); return "clicked"; })()');
  console.log('游客登录：' + clicked);
  await sleep(2500);

  await look('大厅（已登录·390）', 390, 844, 'vs_mobile_lobby.png', true);
  await look('大厅（375）', 375, 667, 'vs_mobile_lobby_375.png', true);
  await look('大厅（360·主流安卓）', 360, 740, 'vs_mobile_lobby_360.png', true);
  await look('大厅（320·超窄）', 320, 568, 'vs_mobile_lobby_320.png', true);

  // ---------- ③ 候场室 ----------
  await P.setDevice(390, 844, true);
  await sleep(500);
  const made = await P.eval('(function(){' +
    'var l = Array.prototype.slice.call(document.querySelectorAll("button"));' +
    'var b = l.filter(function(x){ return (x.innerText||"").indexOf("创建房间") >= 0; })[0];' +
    'if (!b) return "(没找到创建房间)"; b.click(); return "clicked"; })()');
  console.log('创建房间：' + made);
  await sleep(2000);
  await look('候场室', 390, 844, 'vs_mobile_room.png', true);

  // ---------- ④ 游戏页 ----------
  const G = await connect();
  await G.setDevice(390, 844, true);
  await G.nav(BASE + '/game.html?debug=1');
  await sleep(2800);
  const gm = await G.eval(`(function(){
    var de = document.documentElement;
    var hi = [];
    Array.prototype.slice.call(document.querySelectorAll(".hud-top *")).forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 1) return;
      if (r.right > de.clientWidth + 1 || r.left < -1) hi.push((el.className || el.tagName) + ':' + Math.round(r.left) + '~' + Math.round(r.right));
    });
    var cards = document.querySelectorAll(".char-card");
    var btnSm = [];
    Array.prototype.slice.call(document.querySelectorAll("button")).forEach(function (b) {
      var r = b.getBoundingClientRect();
      if (r.width > 1 && r.height > 1 && r.height < 44) btnSm.push((b.innerText||"").trim().slice(0,8) + ':' + Math.round(r.height));
    });
    return {
      vw: de.clientWidth, vh: de.clientHeight,
      overflowX: de.scrollWidth > de.clientWidth + 1,
      hudOutOfBox: hi.slice(0, 6),
      charCards: cards.length,
      smallBtns: btnSm.slice(0, 6)
    };
  })()`);
  console.log('--- 游戏页  (390x844) ---');
  console.log('  ' + JSON.stringify(gm));
  await G.shot(TMP + '/vs_mobile_game.png');
  console.log('  截图 vs_mobile_game.png');
  await G.close();

  console.log('');
  console.log('=== 问题清单 ===');
  if (bad.length) bad.forEach(function (x) { console.log('  · ' + x); });
  else console.log('  无');
  console.log('页面异常：' + (P.errs.length ? P.errs.slice(0, 3).join(' | ') : '无'));

  await P.close();
  chrome.kill();
  process.exit(0);
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack || e));
  process.exit(1);
});
