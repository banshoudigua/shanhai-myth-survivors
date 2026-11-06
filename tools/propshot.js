// tools/propshot.js —— 场景物件层真浏览器验收（第二十八轮）
//
// 【为什么必须有这一条】物件层的断言只能证明「算了几个点、库有没有就绪」，
// 证明不了「火盆是不是悬在空中」「瀑布有没有盖住怪」「贴地的毒潭有没有铺平」。
// 这些只有看图才知道 —— 上一轮角色三帧就是断言全绿、图上一模一样。
//
// 用法：node tools/propshot.js [端口或完整网址]
//       本地：node tools/propshot.js 3000
//       线上：node tools/propshot.js https://xxx.app.workbuddy.host
// 依赖：先启动 server/index.js；线上域名要走本机代理（见 proxyArgs 注释）。
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { TMP, CHROME } = require('./env');

const ARG = String(process.argv[2] || 3000);
const ONLINE = /^https?:\/\//.test(ARG);
const BASE = ONLINE ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9343;
const PROFILE = TMP + '/vs_propshot_profile';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Windows 版 Chrome 不读 http_proxy 环境变量：测线上必须显式传 --proxy-server
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
          // ★无头 Chromium 不开 screencast 的话 rAF 只跑 3 帧
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

// 把玩家挪到第一个物件旁边，让截图里一定能看到它（物件可能离出生点很远）
const MOVE_TO_PROP = `(function(){
  var w = VS_GAME.world;
  var list = (VS.PropLayer && VS.PropLayer.list) ? VS.PropLayer.list() : [];
  if (!list.length) return 'no-props';
  var idx = 0;
  // 优先挑「立牌」物件（ground 层是铺在地上的，截图里不如火盆明显）
  for (var i = 0; i < list.length; i++) { if (list[i].layer !== 'ground') { idx = i; break; } }
  var p = list[idx];
  w.player.x = p.x + 90;
  w.player.y = p.y + 60;
  w.player.px = w.player.x;
  w.player.py = w.player.y;
  return JSON.stringify(p);
})()`;

async function main() {
  let fail = 0;
  function expect(name, cond, detail) {
    console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? ' -> ' + detail : ''));
    if (!cond) fail += 1;
  }

  const chrome = await launchChrome();
  const P = await connect();
  const maps = ['graveyard', 'corridor', 'cathedral', 'altar', 'spire', 'marsh'];
  const shots = [];

  for (const mapId of maps) {
    console.log('\n=== ' + mapId + ' ===');
    await P.navigate(BASE + '/game.html?debug=1&map=' + mapId);
    const ready = await waitFor(function () {
      return P.eval('(function(){return !!(window.VS_GAME && window.VS_GAME.renderer && window.VS && VS.PropLayer);})()');
    }, 25000, '页面与物件层加载');
    expect('页面与物件层挂载', !!ready);
    expect('物件层就绪（pixelfx 加载成功）', await P.eval('!!(VS.PropLayer && VS.PropLayer.ready)'));

    await P.eval('VS_GAME.start()');
    await waitFor(function () { return P.eval('VS_GAME.screen === "playing"'); }, 10000, '进入战场');
    await sleep(900);

    const info = await P.eval('(function(){' +
      'var M = VS.MAPS; var m = VS_GAME.world.map;' +
      'var want = M.buildProps(m).length;' +
      'var got = VS.PropLayer.list().length;' +
      'var doors = VS.PropLayer.portals(m.id).length;' +
      'var kinds = {}; VS.PropLayer.list().forEach(function(p){kinds[p.kind]=1;});' +
      'return JSON.stringify({map:m.id, want:want, got:got, doors:doors, kinds:Object.keys(kinds),' +
      'chest: VS_GAME.world.pickups.filter(function(it){return it.kind==="chest";}).length});})()');
    console.log('  物件：' + info);
    const d = JSON.parse(info || '{}');
    expect('物件数量与纯函数一致（' + d.got + '/' + d.want + '）', d.got === d.want && d.got > 0);
    expect('传送门 2 座（成对）', d.doors === 2, 'doors=' + d.doors);
    expect('地图宝箱 ≥ 3 个', d.chest >= 3, 'chest=' + d.chest);

    console.log('  移到物件旁：' + (await P.eval(MOVE_TO_PROP)));
    await sleep(700);
    const shotPath = TMP + '/vs_props_' + mapId + '.png';
    await P.shot(shotPath);
    shots.push(shotPath);
    console.log('  截图：' + shotPath);

    const stat = await P.eval('JSON.stringify({fps:VS_GAME.fps, drawMs:VS_GAME.renderer.stat.drawMs, decals: VS.PropLayer.decalCount()})');
    console.log('  运行时：' + stat);
  }

  // ============================================================
  // 甘露（技能区域）贴花：这是「用毒潭效果换个颜色」那条需求的样子
  // ============================================================
  console.log('\n=== 甘露区域贴花 ===');
  await P.navigate(BASE + '/game.html?debug=1&map=graveyard');
  await waitFor(function () {
    return P.eval('(function(){return !!(window.VS_GAME && window.VS_GAME.renderer && window.VS && VS.PropLayer);})()');
  }, 25000, '页面加载');
  await P.eval('VS_GAME.start()');
  await waitFor(function () { return P.eval('VS_GAME.screen === "playing"'); }, 10000, '进入战场');
  await sleep(600);
  // 在玩家左右各放一个区域：左边普通（冷灰）、右边进化（琥珀金）
  const zoneInfo = await P.eval(`(function(){
    var w = VS_GAME.world;
    var px = w.player.x, py = w.player.y;
    w.zones.length = 0;
    w.zones.push({ id: 9301, kind:'zone', owner:w.player, x:px-110, y:py+20, r:78,
      dmg: 5, tickSec: 0.4, tickTimer: 0, life: 30, maxLife: 30, color: '#a8b6c4', hitKey: 'z9301' });
    w.zones.push({ id: 9302, kind:'zone', owner:w.player, x:px+120, y:py+20, r:78,
      dmg: 5, tickSec: 0.4, tickTimer: 0, life: 30, maxLife: 30, color: '#ffd166', hitKey: 'z9302' });
    return w.zones.length + '|' + w.player.x + ',' + w.player.y;
  })()`);
  console.log('  注入区域：' + zoneInfo);
  await sleep(800);
  const zoneShot = TMP + '/vs_props_zone.png';
  await P.shot(zoneShot);
  shots.push(zoneShot);
  console.log('  截图：' + zoneShot);
  expect('甘露贴花真的建了实例（贴花缓存 ≥ 2）',
    (await P.eval('VS.PropLayer.decalCount()')) >= 2,
    'decals=' + (await P.eval('VS.PropLayer.decalCount()')));

  expect('全程没有 JS 异常', P.pageErrors.length === 0, P.pageErrors.slice(0, 3).join(' | '));
  console.log('\n截图目录：' + TMP);
  console.log('结果：' + (fail === 0 ? '全部通过' : ('失败 ' + fail + ' 项')));

  P.close();
  chrome.kill();
  process.exitCode = fail ? 1 : 0;
}

main().catch(function (e) {
  console.error('脚本出错：' + (e && e.message ? e.message : e));
  process.exitCode = 1;
});
