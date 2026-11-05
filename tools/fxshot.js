// tools/fxshot.js —— 技能特效改动的「真实浏览器截图」验证
//
// 为什么必须单独写：像素特效是纯视觉交付，Node 侧的自检只能证明
// 「库能画出非空像素」，证明不了「贴到战场之后位置对、大小对、配色对」。
// 这里开一局单机，往世界里塞一批各形态的特效，再用真浏览器截图。
//
// 用法：node tools/fxshot.js [端口或完整网址]
//       本地：node tools/fxshot.js 3000
//       线上：node tools/fxshot.js https://xxx.app.workbuddy.host
// 依赖：先启动 server/index.js；线上域名需要本机代理环境变量（见 proxyArgs）。

const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { TMP, CHROME } = require('./env');

const ARG = String(process.argv[2] || 3000);
const ONLINE = /^https?:\/\//.test(ARG);
const BASE = ONLINE ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9341;
const PROFILE = TMP + '/vs_fxshot_profile';
const SHOT = TMP + '/vs_fxshot.png';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ★Windows 版 Chrome 不读 http_proxy 环境变量：测线上域名必须显式传 --proxy-server，
// 否则页面落到 chrome-error:// 上，看起来像「前端全崩了」。测 127.0.0.1 反而要禁用代理。
function proxyArgs() {
  if (!ONLINE) return ['--no-proxy-server'];
  const proxy = process.env.http_proxy || process.env.HTTP_PROXY || process.env.https_proxy || '';
  return proxy ? ['--proxy-server=' + proxy] : [];
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      '--window-size=1280,860', '--force-device-scale-factor=1',
    ].concat(proxyArgs()).concat(['about:blank']);
    const cp = spawn(CHROME, args, { stdio: 'ignore' });
    let tries = 0;
    const timer = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        clearInterval(timer);
        res.resume();
        resolve(cp);
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
            const msgId = ++id;
            const t = setTimeout(function () {
              delete pending[msgId];
              rej(new Error('CDP 超时：' + method));
            }, 15000);
            pending[msgId] = function (r) { clearTimeout(t); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            const ex = d.exception || {};
            pageErrors.push((d.text || '') + (ex.description ? (' :: ' + String(ex.description).split('\n')[0]) : ''));
          }
        });
        ws.addEventListener('open', function () {
          send('Runtime.enable');
          send('Page.enable');
          send('Network.enable').then(function () {
            return send('Network.setCacheDisabled', { cacheDisabled: true });
          });
          // ★无头 Chromium 不开 screencast 的话 rAF 只跑 3 帧，主循环等于没动
          send('Page.startScreencast', { format: 'jpeg', quality: 50, everyNthFrame: 1 });
          resolve({
            send: send,
            pageErrors: pageErrors,
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', {
                expression: expr, returnByValue: true, awaitPromise: true,
              });
              if (r && r.exceptionDetails) {
                const ex = r.exceptionDetails.exception || {};
                pageErrors.push('eval 异常 [' + String(expr).slice(0, 70) + '] ' +
                  (ex.description ? String(ex.description).split('\n')[0] : r.exceptionDetails.text || ''));
                return null;
              }
              return r && r.result ? r.result.value : null;
            },
            shot: async function (path) {
              const r = await send('Page.captureScreenshot', { format: 'png' });
              if (r && r.data) fs.writeFileSync(path, Buffer.from(r.data, 'base64'));
            },
            navigate: function (url) { return send('Page.navigate', { url: url }); },
            close: function () { ws.close(); },
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
    await sleep(200);
  }
  console.log('  （等待超时：' + label + '）');
  return null;
}

// 一次把各形态的打击与弹丸都摆到玩家附近：截图上要能同时看到刀光、
// 雷击、爆炸、光环、命中火花，以及四种飞行弹幕。
const INJECT = `(function () {
  var w = VS_GAME.world;
  var px = w.player.x, py = w.player.y;
  // 用真实打击寿命（0.55s），并且每 140ms 重新喂一批：
  // 一次性特效只活一瞬间，不持续喂的话截图很容易只拍到「余烬」那一帧。
  var L = 0.55;
  function feed() {
  w.effects.length = 0;
  w.projectiles.length = 0;
  w.effects.push({kind:'arc', x:px-260, y:py-120, r:110, facing:0, arcDeg:110, life:L, maxLife:L, color:'#e8dcc0'});
  w.effects.push({kind:'arc', x:px+260, y:py-120, r:110, facing:Math.PI, arcDeg:110, life:L, maxLife:L, color:'#ff4d4d'});
  w.effects.push({kind:'boom', x:px-300, y:py+170, r:75, life:L, maxLife:L, color:'#ffcf5c'});
  w.effects.push({kind:'boom', x:px+300, y:py+170, r:75, life:L, maxLife:L, color:'#ff9f45'});
  w.effects.push({kind:'ring', x:px, y:py, r:145, life:L, maxLife:L, color:'#e8d9b8'});
  w.effects.push({kind:'hitplayer', x:px, y:py+220, r:20, life:L, maxLife:L, color:'#ff6b6b'});
  function pr(id, kind, dx, dy, color, vx, vy) {
    w.projectiles.push({id:id, kind:kind, x:px+dx, y:py+dy, px:px+dx, py:py+dy,
      vx:vx, vy:vy, r:4, color:color, life:L, pierce:1, hitIds:{}});
  }
  pr(9101,'line',-270,270,'#dfe6ef',220,0);
  pr(9102,'line',-90,270,'#ff8c42',220,0);
  pr(9103,'homing',90,270,'#a8b6c4',160,-60);
  pr(9104,'boomerang',270,270,'#e6dcc6',180,0);
  }
  feed();
  if (window.__fxTimer) clearInterval(window.__fxTimer);
  window.__fxTimer = setInterval(feed, 140);
  return w.effects.length + '|' + w.projectiles.length + '|' + (VS.PixelFx ? VS.PixelFx.ready : 'no-layer');
})()`;

async function main() {
  let fail = 0;
  function expect(name, cond, detail) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' -> ' + detail : ''));
    if (!cond) fail += 1;
  }

  const chrome = await launchChrome();
  const P = await connect();
  await P.navigate(BASE + '/game.html?debug=1');

  const ready = await waitFor(function () {
    return P.eval('(function(){return !!(window.VS_GAME && window.VS_GAME.renderer && window.VS && VS.PixelFx);})()');
  }, 20000, '游戏与技能特效层加载');
  expect('游戏与 PixelFx 层都挂载', !!ready);
  expect('PixelFx 已就绪（库加载成功）', await P.eval('!!(window.VS && VS.PixelFx && VS.PixelFx.ready)'));

  await P.eval('VS_GAME.start()');
  await waitFor(function () { return P.eval('VS_GAME.screen === "playing"'); }, 8000, '进入战场');
  const injected = await P.eval(INJECT);
  console.log('  注入：effects|projectiles|layer = ' + injected);

  await sleep(700);
  const stats = await P.eval('JSON.stringify({fx:VS.PixelFx.stats(), drawMs:VS_GAME.renderer.stat.drawMs, fps:VS_GAME.fps})');
  console.log('  运行时：' + stats);
  await P.shot(SHOT);
  console.log('  截图：' + SHOT);

  const st = JSON.parse(stats || '{}');
  expect('本帧真的画了像素技能特效', !!(st.fx && st.fx.drawnLastFrame > 0), JSON.stringify(st.fx));
  expect('页面没有 JS 异常', P.pageErrors.length === 0, P.pageErrors.join(' ; '));

  // 性能对照：同一批数据下把像素层关掉再量一次，才知道掉帧是不是它造成的
  await P.eval('clearInterval(window.__fxTimer)');
  await P.eval('VS.PixelFx.ready = false');
  await sleep(500);
  const plain = await P.eval('JSON.stringify({drawMs:VS_GAME.renderer.stat.drawMs, fps:VS_GAME.fps})');
  console.log('  关掉像素层对照：' + plain + '（开启时 ' + stats + '）');
  await P.eval('VS.PixelFx.ready = true');

  P.close();
  chrome.kill();
  console.log('\n结果：' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('截图脚本失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
