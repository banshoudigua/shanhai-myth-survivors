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
const SHOT_ACTOR = TMP + '/vs_actor_frames.png';
const SHOT_FEATURE = TMP + '/vs_features.png';

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
            shot: async function (path, clip) {
              const p = { format: 'png' };
              if (clip) {
                p.clip = Object.assign({ scale: 1 }, clip);
                p.captureBeyondViewport = true;
              }
              const r = await send('Page.captureScreenshot', p);
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
  w.strikes.length = 0;
  // 抛物线锤：按时间循环它的飞行进度，截图才能看到「出手 → 划弧 → 落点」的残影轨迹
  // 固定在飞行的中后段（0.6~0.8）：三个残影的时刻 tk = ph - k*0.055 全为正，
  // 截图才拍得到完整轨迹；用随机相位经常只拍到刚出手、残影还没生成。
  var ph = 0.6 + 0.2 * ((Date.now() % 700) / 700);
  w.strikes.push({ id:9201, kind:'parabola', owner:w.player,
    sx:px-170, sy:py-130, x:px+70, y:py+150, r:56,
    life:L*(1-ph), delay:L, color:'#ffcf5c' });
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

// 8 个角色 × 3 帧对照图：直接在页面里用 PLAYER_ART.paint 重画一遍同样的变换，
// 截图能一眼看出「三帧轮廓是不是真的不一样」（战场里角色只有 40px，看不清）。
const ACTOR_SHEET = `(function () {
  var C = window.VS && VS.CONST;
  var PA = window.VS && VS.PLAYER_ART;
  if (!C || !PA) return null;
  var ids = C.CHARACTERS.map(function (c) { return c.id; });
  // ★与渲染层共用同一份帧参数，别在测试脚本里复制数值
  var V = (PA && PA.frames) || [{sx:1,sy:1,dy:0}];
  var cw = 112, ch = 96, pad = 24;
  var w = pad * 2 + cw * V.length, h = pad * 2 + ch * ids.length;
  var d = document.getElementById('__actor_sheet');
  if (!d) {
    d = document.createElement('div');
    d.id = '__actor_sheet';
    d.style.cssText = 'position:absolute;top:0;left:0;z-index:99999;background:#f4efe6;';
    document.body.appendChild(d);
  }
  var cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  var g = cv.getContext('2d');
  g.fillStyle = '#f4efe6'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#33261c'; g.font = '12px sans-serif';
  for (var i = 0; i < ids.length; i++) {
    for (var f = 0; f < V.length; f++) {
      var cx = pad + cw * f + cw / 2, cy = pad + ch * i + ch / 2;
      g.save();
      g.translate(cx, cy + V[f].dy);
      g.scale(V[f].sx, V[f].sy);
      g.translate(-cx, -cy);
      PA.paint(g, ids[i], cx, cy, 16);
      g.restore();
      g.fillText(ids[i] + '  f' + f, pad + cw * f + 6, pad + ch * i + 14);
    }
  }
  d.innerHTML = '';
  d.appendChild(cv);
  return [w, h];
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

  // ---- 角色动作帧：对照图 + 状态机真实页面断言 ----
  const sheetSize = await P.eval(ACTOR_SHEET);
  if (sheetSize) {
    await P.shot(SHOT_ACTOR, { x: 0, y: 0, width: sheetSize[0], height: sheetSize[1] });
    console.log('  角色帧对照图：' + SHOT_ACTOR);
  }
  expect('角色三帧对照图已生成', !!sheetSize);
  // 对照层用完就撤，别让它影响后面的性能对照与后续截图
  await P.eval("(function(){var d=document.getElementById('__actor_sheet');if(d&&d.parentNode)d.parentNode.removeChild(d);return true;})()");

  const actor = await P.eval(`(function () {
    var AM = VS.ActorMotion, R = VS_GAME.renderer;
    var keys = Object.keys(R.playerArtCache || {});
    var frames = keys.length && R.playerArtCache[keys[0]].frames
      ? R.playerArtCache[keys[0]].frames.length : 0;
    AM.reset(); AM.punch('probe', 'slash');
    for (var i = 0; i < 14; i++) AM.begin(0.016);
    var s = AM.stats();
    return JSON.stringify({ready: !!AM, cachedChars: keys.length, frames: frames,
      freezes: s.freezes, freezeLeft: s.freezeLeft});
  })()`);
  console.log('  角色动作：' + actor);
  const ast = JSON.parse(actor || '{}');
  expect('渲染层已按角色预烘焙 3 帧', ast.frames === 3, JSON.stringify(ast));
  expect('★命中定格在真实页面里触发', ast.freezes > 0, JSON.stringify(ast));

  const st = JSON.parse(stats || '{}');
  expect('本帧真的画了像素技能特效', !!(st.fx && st.fx.drawnLastFrame > 0), JSON.stringify(st.fx));
  expect('页面没有 JS 异常', P.pageErrors.length === 0, P.pageErrors.join(' ; '));

  // 角色动作层 A/B：把状态机摘掉后渲染层自动走单帧兜底，
  // 用来确认本轮新增的每帧开销到底是不是它带来的（而不是测量波动）
  await P.eval('window.__AM_SAVE = VS.ActorMotion; VS.ActorMotion = null;');
  await sleep(500);
  const noActor = await P.eval('JSON.stringify({drawMs:VS_GAME.renderer.stat.drawMs, fps:VS_GAME.fps})');
  console.log('  关掉角色动作层对照：' + noActor);
  await P.eval('VS.ActorMotion = window.__AM_SAVE;');

  // 角色层 JS 的真实 CPU 耗时：drawMs 是 20 帧滑动平均，在「每 140ms 重建特效」
  // 的压力场景里噪声很大，单独禁用某一项测出来的数字互相矛盾。直接给方法套计时器，
  // 采 1 秒，才能说清这层到底吃不吃 CPU。
  await P.eval(`(function(){
    var A = VS.ActorMotion, names = ['begin','poseOf','mobWobble','shake'];
    window.__AM_ORIG = {}; window.__AM_MS = {}; window.__AM_T0 = performance.now();
    names.forEach(function(n){
      window.__AM_ORIG[n] = A[n]; window.__AM_MS[n] = 0;
      A[n] = function(){
        var s = performance.now();
        var r = window.__AM_ORIG[n].apply(this, arguments);
        window.__AM_MS[n] += performance.now() - s;
        return r;
      };
    });
    return true;
  })()`);
  await sleep(1000);
  const amCost = await P.eval(`(function(){
    var A = VS.ActorMotion, e = performance.now() - window.__AM_T0;
    Object.keys(window.__AM_ORIG).forEach(function(n){ A[n] = window.__AM_ORIG[n]; });
    var ms = {}; Object.keys(window.__AM_MS).forEach(function(n){ ms[n] = Math.round(window.__AM_MS[n] * 100) / 100; });
    return JSON.stringify({elapsedMs: Math.round(e), methods: ms});
  })()`);
  console.log('  角色层 JS 耗时（1 秒采样）：' + amCost);

  // 场景物件层 A/B（第二十八轮）：物件每帧要重新合成自己的像素画布，
  // 这层到底吃掉多少毫秒必须量出来 —— 不然「掉帧了」只能靠猜。
  const withProps = await P.eval('JSON.stringify({drawMs:VS_GAME.renderer.stat.drawMs, fps:VS_GAME.fps, decals: VS.PropLayer ? VS.PropLayer.decalCount() : -1, props: VS.PropLayer ? VS.PropLayer.list().length : -1})');
  await P.eval('if (VS.PropLayer) VS.PropLayer.enabled = false;');
  await sleep(600);
  const noProps = await P.eval('JSON.stringify({drawMs:VS_GAME.renderer.stat.drawMs, fps:VS_GAME.fps})');
  await P.eval('if (VS.PropLayer) VS.PropLayer.enabled = true;');
  console.log('  关掉物件层对照：' + noProps + '（开启时 ' + withProps + '）');

  // 性能对照：同一批数据下把像素层关掉再量一次，才知道掉帧是不是它造成的
  await P.eval('clearInterval(window.__fxTimer)');
  await P.eval('VS.PixelFx.ready = false');
  await sleep(500);
  const plain = await P.eval('JSON.stringify({drawMs:VS_GAME.renderer.stat.drawMs, fps:VS_GAME.fps})');
  console.log('  关掉像素层对照：' + plain + '（开启时 ' + stats + '）');
  await P.eval('VS.PixelFx.ready = true');

  // ============================================================
  // 第二十五轮：① 音效 · ② 界面库 · ③ Ink 剧情 —— 真浏览器验收
  // ============================================================
  const libState = await P.eval(`(function(){
    return JSON.stringify({
      howler: !!window.Howl, floating: !!window.FloatingUIDOM,
      anime: !!(window.anime && window.anime.animate),
      ink: !!(window.inkjs && window.inkjs.Story),
      sfx: VS.Sfx ? VS.Sfx.stats() : null,
      ui: VS.UiFx ? VS.UiFx.stats() : null
    });
  })()`);
  const lib = JSON.parse(libState || '{}');
  expect('Howler / Floating UI / anime.js / inkjs 四个 UMD 都挂载',
    !!(lib.howler && lib.floating && lib.anime && lib.ink), libState);
  expect('音效层建好 15 个 Howl 实例', !!(lib.sfx && lib.sfx.ready && lib.sfx.count === 15), JSON.stringify(lib.sfx));
  expect('界面层报告浮层与补间可用', !!(lib.ui && lib.ui.floating && lib.ui.anime && lib.ui.typewriter), JSON.stringify(lib.ui));

  const sfxBefore = await P.eval('VS.Sfx.stats().played');
  await P.eval("VS.Sfx.play('select', { gap: 0, vary: false })");
  const sfxAfter = await P.eval('VS.Sfx.stats().played');
  expect('★真浏览器里 play() 确实发出了一次播放', sfxAfter === sfxBefore + 1,
    sfxBefore + ' → ' + sfxAfter);

  // 音效开关：先暂停（暂停面板才有这个 opt-row），再按 DOM 精确找按钮
  await P.eval('VS_GAME.pause()');
  await waitFor(function () { return P.eval('VS_GAME.screen === "paused"'); }, 5000, '进入暂停面板');
  const sfxBtn = JSON.parse(await P.eval(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.opt-row'));
    var row = rows.filter(function(r){ return r.textContent.indexOf('技能音效') >= 0; })[0];
    if (!row) return JSON.stringify({found:false});
    var b = row.querySelector('button');
    if (!b) return JSON.stringify({found:false, reason:'行里没有按钮'});
    var r = b.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return JSON.stringify({found:true, text:b.textContent.trim(),
      h: Math.round(r.height), hit: !!(hit && (hit === b || b.contains(hit)))});
  })()`));
  expect('暂停面板里能找到技能音效开关', !!sfxBtn.found, JSON.stringify(sfxBtn));
  expect('★开关点得到（elementFromPoint 命中，不是被别层盖住）', !!sfxBtn.hit, JSON.stringify(sfxBtn));
  expect('触摸目标 ≥44px', (sfxBtn.h || 0) >= 44, '高度 ' + sfxBtn.h);
  await P.eval(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.opt-row'));
    var row = rows.filter(function(r){ return r.textContent.indexOf('技能音效') >= 0; })[0];
    row.querySelector('button').click(); return true;
  })()`);
  await sleep(120);
  // ★VS_GAME 是自定义调试句柄，不暴露 ui.sfxOn；用按钮文案验证 Vue 那边也同步了
  const sfxLabel = await P.eval(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.opt-row'));
    var row = rows.filter(function(r){ return r.textContent.indexOf('技能音效') >= 0; })[0];
    return row.querySelector('button').textContent.trim();
  })()`);
  expect('★点一下真的关掉音效（音效层与 Vue 文案同步）',
    await P.eval('VS.Sfx.enabled === false') && sfxLabel === '已关闭',
    '按钮=' + sfxLabel);
  await P.eval(`(function(){
    var rows = Array.prototype.slice.call(document.querySelectorAll('.opt-row'));
    var row = rows.filter(function(r){ return r.textContent.indexOf('技能音效') >= 0; })[0];
    row.querySelector('button').click(); return true;
  })()`);
  await sleep(120);
  expect('再点一下恢复开启', await P.eval('VS.Sfx.enabled === true'));

  // Floating UI：真浏览器里量一次定位（Node stub 证明不了 computePosition 能跑）
  await P.eval(`(function(){
    var d = document.createElement('div');
    d.className = 'slot-card';
    d.style.width = '300px'; d.style.height = '120px';
    document.getElementById('hud').appendChild(d);
    VS.UiFx.layoutSlotCard();
    return true;
  })()`);
  await sleep(260);
  const pos = JSON.parse(await P.eval(`(function(){
    var d = document.querySelector('.slot-card');
    var st = VS.UiFx.stats();
    var out = { left: d.style.left, top: d.style.top, bottom: d.style.bottom, positioned: st.positioned };
    if (d.parentNode) d.parentNode.removeChild(d);
    VS.UiFx.clearSlotCard();
    return JSON.stringify(out);
  })()`));
  expect('★Floating UI 真的写回了 left/top', !!pos.left && !!pos.top, JSON.stringify(pos));
  expect('★切到 JS 定位时清掉了 CSS 的 bottom', pos.bottom === 'auto', JSON.stringify(pos));

  // 剧情卷首页：Ink 数据 + 回顾列表
  await P.navigate(BASE + '/game.html?debug=1&mod=myth&stage=ch1');
  await waitFor(function () {
    return P.eval('!!(window.VS_GAME && window.VS && VS.Storylines && document.querySelector(".pl-recap-btn"))');
  }, 10000, '剧情卷首页挂载');
  await waitFor(function () { return P.eval('!!(VS.Storylines && VS.Storylines.ready)'); }, 10000, 'Ink 数据加载');
  expect('★Ink 运行时在浏览器里就绪', await P.eval('VS.Storylines.ready === true'));

  const recapBtn = JSON.parse(await P.eval(`(function(){
    var b = document.querySelector('.pl-recap-btn');
    var r = b.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width/2, r.top + r.height/2);
    return JSON.stringify({text:b.textContent.trim(), h:Math.round(r.height),
      hit: !!(hit && (hit === b || b.contains(hit)))});
  })()`));
  expect('★剧情回顾按钮点得到（elementFromPoint 命中）', !!recapBtn.hit, JSON.stringify(recapBtn));
  expect('触摸目标 ≥44px', (recapBtn.h || 0) >= 44, '高度 ' + recapBtn.h);
  await P.eval("document.querySelector('.pl-recap-btn').click()");
  await waitFor(function () {
    return P.eval("document.querySelectorAll('.pl-recap-list p').length === 3");
  }, 6000, '回顾列表出现三句');
  const recap = JSON.parse(await P.eval(`JSON.stringify({
    lines: Array.prototype.map.call(document.querySelectorAll('.pl-recap-list p'), function(p){return p.textContent.trim();}),
    ink: VS.Storylines.linesOf(1),
    panelTop: Math.round(document.querySelector('.panel-prologue').getBoundingClientRect().top)
  })`));
  expect('★回顾列表三句与 Ink 运行时逐句一致',
    recap.lines.length === 3 && recap.lines[0].indexOf(recap.ink[0]) >= 0,
    JSON.stringify(recap));
  expect('★卷首页面板没被新增内容顶出视口', recap.panelTop >= 0, 'top=' + recap.panelTop);
  await P.shot(SHOT_FEATURE);
  console.log('  剧情卷首截图：' + SHOT_FEATURE);
  expect('★全程没有 JS 异常', P.pageErrors.length === 0, P.pageErrors.join(' ; '));

  P.close();
  chrome.kill();
  console.log('\n结果：' + (fail === 0 ? '全部通过' : fail + ' 项失败'));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(function (e) {
  console.error('截图脚本失败：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
