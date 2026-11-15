// tools/layertest.js —— 图层顺序回归：角色必须压在技能表现之上
// （第二十九轮建立，第三十二轮重写判据口径）
//
// 【为什么要有这条】图层顺序错了不会报错，只会「看着不对」—— 而肉眼在满屏特效里
// 容易看走眼（前几轮的角色三帧就是断言全绿、图上一模一样）。
// 这里用**像素亮度**做客观判据。
//
// ★★★第三十二轮为什么重写（老判据是一颗假雷）
// 老口径：取角色脚下 20×20 屏幕方框的**平均亮度**，比较「有特效」与「清空」两次采样的差。
// 问题是这个方框比角色本体宽，**包含了剪影边缘的半透明像素**——那些像素本来就透出地面，
// 爆发的加法高光从那里透上来，于是差恒为 8.1~8.2（阈值 8），本地线上都一样。
// 这跟图层顺序对错无关，只是「方框大于实心正身」造成的口径误差。
// 试过把方框缩小到 12px —— 更糟（差 36.2），因为框偏到了角色非实心的边缘/脚下。
// 所以**别再靠调框大小或放宽阈值**，要换判据：
//
// 新口径（本轮）：先求出「角色真正覆盖了哪些像素」的**掩膜**，只在掩膜里比亮度。
//   掩膜怎么来：把玩家从采样点挪开 320px，同一个世界点再采一次 —— 两帧亮度差 > 45 的
//   像素就是被角色实心覆盖的像素（半透明边缘差不到 45，自动被排除）。
//   在掩膜内比「有特效 / 无特效」的亮度，差应当接近 0（角色在上层，把特效整块挡住）。
//
// 并且补一条**正向对照**（防假绿的关键）：把同一套特效画在角色旁边的纯地面上，
// 那块区域的亮度必须明显升高。否则「特效根本没画出来」也会让差值 = 0，
// 一条永远绿的断言等于没写。
//
// 断言清单（八条，反向验证过：把 drawPlayer 挪到 drawEffects 之前会红两条以上）：
//   ① 采样框拿到完整像素、没有越界补黑
//   ② 掩膜占到 40% 以上（证明采到了角色正身，不是一块空地）
//   ③ 掩膜里的像素确实亮于地面（差 > 15）
//   ④ 弹幕压在角色身上，掩膜内亮度差 ≤ 3
//   ⑤ 爆发压在角色身上，掩膜内亮度差 ≤ 3
//   ⑥ 爆发 + 刀光一起，掩膜内亮度差 ≤ 3
//   ⑦ 正向对照：同一套特效画在角色旁边地面上，亮度至少升高 25
//   ⑧ 全程没有 JS 异常
//
// 用法：node tools/layertest.js [端口或完整网址]
// 依赖：先启动 server/index.js
//
// ★★★第三十三轮定位到的真正根因（补记，别再走弯路）
// 上一轮以为是「剪影边缘透明像素」，其实主因是**角色自己的动作帧在变**：
// `actor-motion.js` 的 poseOf 在没有攻击时按 `clock * 2.4` 来回切待机呼吸帧，
// 而「无特效」与「有特效」两组采样之间隔了 600ms，正好跨过相位切换 ——
// 掩膜里最亮的 70 个像素在呼吸两帧之间差 47（207.4 ↔ 160.2），于是恒报差 8.2 / 47.2。
// 证据（一次性探针，跑完已删）：
//   · 只加 boom                        → 207.4 不变（角色挡住爆发，图层本来就是对的）
//   · 只加 arc                         → 160.2（换帧）
//   · arc 放到角色右侧 200px           → 207.4 不变（不是全局副作用）
//   · 关掉 pixelfx 再加 arc            → 207.4 不变（不是库的绘制）
//   · 胸前采样 vs 角色左上角采样        → 旁边变化 0.0，只有角色身上变（不是覆盖，是换帧）
//   · 逐帧记录 pose                     → pose 0 → 1
// 所以本测试开头就把 AM.begin 换成空函数（clock 停住 → pose 恒定）+ punch 置空。
// 这是**隔离干扰机制**，不是绕过问题：呼吸/挥砍帧是表现层另一个模块的事，
// 测图层就不该让它掺进来。要测「挥砍时角色是否被盖住」是另一个命题，得单独设计。
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { TMP, CHROME, splitShare, shareSuffix } = require('./env');

// 线上链接带分享码：允许直接把整条分享链接传进来，这里拆出 code（机制见 env.js 的注释）
const SH = splitShare(process.argv[2] || 3000);
const SHARE = shareSuffix(SH.code);
const ARG = SH.url;
const ONLINE = /^https?:\/\//.test(ARG);
const BASE = ONLINE ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const CDP_PORT = 9357;
const PROFILE = TMP + '/vs_layertest_profile';

// 采样参数（屏幕像素）
const SAMPLE_R = 10;      // 半径 10 → 20×20 屏幕像素的方框
const FRAMES = 8;         // 连续 8 帧取每像素平均（角色有呼吸起伏，单帧噪声 ±7）
const MASK_THR = 45;      // 掩膜阈值：两帧亮度差超过它才算「被角色实心覆盖」
const MASK_MIN_RATIO = 0.4; // 掩膜至少占采样框这么大比例，否则说明没采到角色（后面全绿也是假的）
const LAYER_MAX = 3;      // 掩膜内允许的亮度差（角色在上层应接近 0；实测 0.0，给量化留一点余量）
const NEAR_DX = 140;      // 正向对照：特效放在角色右侧多少像素

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
      '--window-size=1280,860', '--force-device-scale-factor=1'
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
            const to = setTimeout(function () { delete pending[mid]; rej(new Error('CDP 超时：' + method)); }, 20000);
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
          // 无头 Chromium 不开 screencast 的话 rAF 只跑三帧（踩过），采样会拿到死帧
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

// 页内工具：世界坐标 → 屏幕矩形，连续 n 帧累加后返回**每个像素的平均亮度**数组
// （逐像素平均是重点：掩膜要逐像素算，只给一个平均值做不出掩膜）
const PIX_FN = `
  window.__pixAvg = function (wx, wy, r, n) {
    return new Promise(function (res) {
      var cv = document.getElementById('game-canvas');
      if (!cv) { res(null); return; }
      var g = cv.getContext('2d');
      var accum = null, w = 0, cnt = 0, i = 0;
      function step() {
        var R2 = VS_GAME.renderer;
        var rect = cv.getBoundingClientRect();
        if (!R2 || !rect.width) { res(null); return; }
        var k = cv.width / rect.width;
        var sx = Math.round((wx - R2.cam.x) * k);
        var sy = Math.round((wy - R2.cam.y) * k);
        w = Math.max(6, Math.round(r * k));
        var x0 = sx - (w >> 1), y0 = sy - (w >> 1);
        // 采样框越界就明确失败，别让 getImageData 悄悄补黑（那会把结果算成「变亮了」）
        if (x0 < 0 || y0 < 0 || x0 + w > cv.width || y0 + w > cv.height) { res(null); return; }
        var d = g.getImageData(x0, y0, w, w).data;
        if (!accum) accum = new Float64Array(w * w);
        for (var p = 0; p < w * w; p++) {
          var o = p * 4;
          accum[p] += d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
        }
        cnt += 1; i += 1;
        if (i < n) { requestAnimationFrame(step); return; }
        var out = [];
        for (var q = 0; q < accum.length; q++) out.push(Math.round(accum[q] / cnt * 100) / 100);
        res({ w: w, lum: out });
      }
      requestAnimationFrame(step);
    });
  };
  // 把玩家钉到指定世界坐标，并且**清掉它的移动残留**（px/py），免得插值把它画在半路上
  window.__pin = function (wx, wy) {
    var w = VS_GAME.world, p = w.player;
    p.x = wx; p.y = wy; p.px = wx; p.py = wy;
    return true;
  };
  // 清干净动态内容（怪 / 特效 / 弹幕 / 环绕物），采样前必做
  window.__clear = function () {
    var w = VS_GAME.world;
    w.mobs.length = 0; w.effects.length = 0; w.projectiles.length = 0; w.orbits.length = 0;
    return true;
  };
  'ok';
`;

// ---- Node 侧的像素统计工具 ----
function allMean(sample) {
  if (!sample || !sample.lum || !sample.lum.length) return null;
  let s = 0;
  for (let i = 0; i < sample.lum.length; i++) s += sample.lum[i];
  return s / sample.lum.length;
}

// 掩膜：同一世界点「有角色」比「无角色」亮出 MASK_THR 以上的像素才算被角色实心覆盖。
// ★只取「更亮」的方向，把角色脚下的淡影子排除掉（影子是暗的，量它没有意义，
//   而且影子在特效下层，会把差值推向假 FAIL）。
function buildMask(body, ground, thr) {
  const m = [];
  if (!body || !ground || body.lum.length !== ground.lum.length) return m;
  for (let i = 0; i < body.lum.length; i++) m.push((body.lum[i] - ground.lum[i]) > thr);
  return m;
}

function maskMean(sample, mask) {
  if (!sample || !sample.lum) return null;
  let s = 0, n = 0;
  for (let i = 0; i < sample.lum.length; i++) {
    if (mask[i]) { s += sample.lum[i]; n += 1; }
  }
  return n ? s / n : null;
}

function maskCount(mask) {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) n += 1;
  return n;
}

function r1(v) { return Math.round(v * 10) / 10; }

async function main() {
  let pass = 0, fail = 0;
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  }

  const chrome = await launchChrome();
  const P = await connect();
  await P.nav(BASE + '/game.html?debug=1' + SHARE);
  await waitFor(function () {
    return P.eval('!!(window.VS_GAME && window.VS_GAME.renderer && window.VS)');
  }, 25000, '游戏加载');
  await P.eval('VS_GAME.start()');
  await waitFor(function () { return P.eval('VS_GAME.screen === "playing"'); }, 10000, '进入战场');
  await sleep(800);

  // 清场：怪清掉（否则镜头会跟着被打抖）、特效/弹幕清掉、玩家钉在地图中心
  // ★顺手把武器清空 —— 否则自动攻击每半秒射一发，clean 与 fx 两组采样的背景不一样
  const PW = await P.eval(`(function(){
    var w = VS_GAME.world;
    w.mobs.length = 0; w.effects.length = 0; w.projectiles.length = 0; w.orbits.length = 0;
    if (w.player.weapons) w.player.weapons.length = 0;
    var cx = w.map.w / 2, cy = w.map.h / 2;
    w.player.x = cx; w.player.y = cy; w.player.px = cx; w.player.py = cy;
    if (window.__lzTimer) clearInterval(window.__lzTimer);
    // ★动作帧是最大的干扰源（见文件头）：待机呼吸会让角色每 0.4 秒换一帧，
    //   两帧在最亮像素上能差 47，比任何图层错误都大。把动作时钟停住、起手也换掉，
    //   角色就恒定在同一帧，测出来的差才只反映图层。
    window.__lzQuiet = function () {
      var AM = window.VS.ActorMotion;
      if (!AM) return;
      AM.begin = function () { return 0; };   // 时钟不推进 → pose 恒定
      AM.punch = function () { return 0; };   // 也别让挥砍插进来
    };
    window.__lzQuiet();
    window.__lzTimer = setInterval(function(){
      VS_GAME.world.mobs.length = 0;
      window.__lzQuiet();
    }, 30);
    return { x: cx, y: cy };
  })()`);
  await P.eval(PIX_FN);
  await sleep(700);   // 等镜头完全停稳（镜头平滑跟随，还在动的话采样点会漂）
  const camA = await P.eval('VS_GAME.renderer.cam.x.toFixed(1) + "," + VS_GAME.renderer.cam.y.toFixed(1)');

  // ---- 1) 「有角色」与「同一世界点无角色」两帧，求掩膜 ----
  const bodyS = await P.eval(`window.__pixAvg(${PW.x}, ${PW.y}, ${SAMPLE_R}, ${FRAMES})`);
  // 把玩家挪开 320px（仍在视野内，镜头会跟过去一点，但采样用的是世界坐标，不受影响）
  await P.eval(`window.__pin(${PW.x + 320}, ${PW.y + 320})`);
  await sleep(900);   // 等镜头追完
  const groundS = await P.eval(`window.__pixAvg(${PW.x}, ${PW.y}, ${SAMPLE_R}, ${FRAMES})`);
  const mask = buildMask(bodyS, groundS, MASK_THR);
  const maskN = maskCount(mask);

  // ★采样框的边长是「屏幕像素 × k」，k = canvas 内部宽 / CSS 宽（本机实测 0.5），
  //   所以别把 400 这种数字写死 —— 只断言「拿到的确实是 w×w 个像素、没有越界补黑」
  if (!bodyS || !groundS) {
    ok('采样框在世界点处没有越界', false, '拿不到样本（越界或 canvas 读不到）');
  } else {
    ok('采样框在世界点处没有越界（' + bodyS.w + '×' + bodyS.w + ' = ' + bodyS.lum.length + ' 个像素）',
      bodyS.lum.length === bodyS.w * bodyS.w && groundS.lum.length === bodyS.lum.length,
      '有角色 ' + bodyS.lum.length + ' / 无角色 ' + groundS.lum.length);
  }
  const maskNeed = Math.ceil(bodyS ? bodyS.lum.length * MASK_MIN_RATIO : 0);
  ok('★掩膜确实采到了角色正身（占采样框 ' + Math.round(MASK_MIN_RATIO * 100) + '% 以上，即 ≥ ' + maskNeed + ' 像素）',
    maskN >= maskNeed, '只拿到 ' + maskN + ' 个像素（镜头位置 ' + camA + '）');

  // 玩家移回原位，等镜头回稳
  await P.eval(`window.__pin(${PW.x}, ${PW.y})`);
  await sleep(900);

  const bodyOn = maskMean(bodyS, mask);
  const groundAtPw = allMean(groundS);
  console.log('  掩膜内亮度 = ' + r1(bodyOn || 0) + ' / 同一处无角色时 = ' + r1(groundAtPw || 0) + ' / 掩膜像素 = ' + maskN);
  ok('★掩膜里的像素确实亮于地面（差 > 15）', bodyOn !== null && Math.abs(bodyOn - groundAtPw) > 15,
    '差 ' + (bodyOn !== null ? r1(Math.abs(bodyOn - groundAtPw)) : 'n/a'));

  // ---- 2) 技能弹幕压在角色身上：掩膜内亮度不该变 ----
  await P.eval('window.__clear()');
  await sleep(250);
  const clean1 = await P.eval(`window.__pixAvg(${PW.x}, ${PW.y}, ${SAMPLE_R}, ${FRAMES})`);

  await P.eval(`(function(){
    var w = VS_GAME.world, p = w.player;
    w.projectiles.length = 0;
    w.projectiles.push({ id: 88001, kind: 'line', x: p.x, y: p.y, px: p.x, py: p.y,
      vx: 0.001, vy: 0, r: 6, color: '#ffffff', life: 8, pierce: 1, hitIds: {} });
    return true;
  })()`);
  await sleep(350);
  const shotS = await P.eval(`window.__pixAvg(${PW.x}, ${PW.y}, ${SAMPLE_R}, ${FRAMES})`);
  await P.eval('VS_GAME.world.projectiles.length = 0');
  await sleep(250);

  const shotOn = maskMean(shotS, mask), shotOff = maskMean(clean1, mask);
  const shotDiff = (shotOn !== null && shotOff !== null) ? Math.abs(shotOn - shotOff) : 999;
  console.log('  弹幕压在身上：掩膜内 ' + r1(shotOn || 0) + ' vs 清空 ' + r1(shotOff || 0) + ' → 差 ' + r1(shotDiff));
  ok('★★角色压在技能弹幕之上（掩膜内差 ≤ ' + LAYER_MAX + '）', shotDiff <= LAYER_MAX, '差 ' + r1(shotDiff));

  // ---- 3) 爆发 + 刀光压在角色身上 ----
  // ★先分开各测一次：上一轮就是「两个特效一起注入」看不出是谁在改动像素，
  //   结果追了一整轮。分开测的代价只是多两次 8 帧采样，换来一眼定位。
  const amState = await P.eval(`(function(){ var AM = window.VS.ActorMotion;
    return AM ? (AM.punch ? String(AM.punch).slice(0, 40) : 'no-punch') : 'no-AM'; })()`);
  console.log('  角色动作模块状态：' + amState);

  async function fxOnce(label, list) {
    await P.eval(`(function(){
      var w = VS_GAME.world, p = w.player;
      w.effects.length = 0;
      ${list}
      return true;
    })()`);
    await sleep(350);
    const smp = await P.eval(`window.__pixAvg(${PW.x}, ${PW.y}, ${SAMPLE_R}, ${FRAMES})`);
    await P.eval('window.__clear()');
    await sleep(250);
    const on = maskMean(smp, mask), off = maskMean(clean1, mask);
    const d = (on !== null && off !== null) ? Math.abs(on - off) : 999;
    console.log('  ' + label + '：掩膜内 ' + r1(on || 0) + ' vs 清空 ' + r1(off || 0) + ' → 差 ' + r1(d));
    return d;
  }

  const arcDiff = await fxOnce('只加刀光', `
      w.effects.push({ kind: 'arc', x: p.x, y: p.y, r: 90, facing: 0, arcDeg: 220, life: 8, maxLife: 8, color: '#ffffff' });`);
  const boomDiff = await fxOnce('只加爆发', `
      w.effects.push({ kind: 'boom', x: p.x, y: p.y, r: 100, life: 8, maxLife: 8, color: '#ffffff' });`);

  await P.eval(`(function(){
    var w = VS_GAME.world, p = w.player;
    w.effects.length = 0;
    w.effects.push({ kind: 'boom', x: p.x, y: p.y, r: 100, life: 8, maxLife: 8, color: '#ffffff' });
    w.effects.push({ kind: 'arc', x: p.x, y: p.y, r: 90, facing: 0, arcDeg: 220, life: 8, maxLife: 8, color: '#ffffff' });
    return true;
  })()`);
  await sleep(350);
  const fxS = await P.eval(`window.__pixAvg(${PW.x}, ${PW.y}, ${SAMPLE_R}, ${FRAMES})`);
  await P.shot(TMP + '/vs_layer_on.png');   // 留一张「特效正压在角色身上」的图给人看
  await P.eval('window.__clear()');
  await sleep(250);

  const fxOn = maskMean(fxS, mask), fxOff = maskMean(clean1, mask);
  const fxDiff = (fxOn !== null && fxOff !== null) ? Math.abs(fxOn - fxOff) : 999;
  console.log('  爆发+刀光一起压在身上：掩膜内 ' + r1(fxOn || 0) + ' vs 清空 ' + r1(fxOff || 0) + ' → 差 ' + r1(fxDiff));
  ok('★★角色压在爆发之上（掩膜内差 ≤ ' + LAYER_MAX + '）', boomDiff <= LAYER_MAX, '差 ' + r1(boomDiff));
  ok('★★角色压在爆发/刀光之上（掩膜内差 ≤ ' + LAYER_MAX + '）', fxDiff <= LAYER_MAX, '差 ' + r1(fxDiff));
  // ★「只加刀光」**故意不做断言**：反向验证（把 drawPlayer 挪到 drawEffects 之前）时这三条
  //   里有两条变红（弹幕 31.8、爆发 46.9），但刀光那条仍是 0 —— 因为 pixelfx 的 slash
  //   把刀光画在角色右侧（画布 @-44,-92，覆盖 -44..92），角色中心那 20px 上本来就没有
  //   可见像素。钉不住「不该发生的事」的断言不能留在结果里，否则又是假绿。
  //   它保留为观察值：真实值是 0，将来若有人改了 slash 的落点，这里会先冒出来。

  // ---- 4) 正向对照：同一套特效画在角色旁边的地面上，必须明显变亮 ----
  // ★没有这一条的话，「特效压根没画出来」也会让上面两条的差 = 0 —— 永远绿的假断言。
  const nearX = PW.x + NEAR_DX, nearY = PW.y;
  const nearClean = await P.eval(`window.__pixAvg(${nearX}, ${nearY}, ${SAMPLE_R}, ${FRAMES})`);
  await P.eval(`(function(){
    var w = VS_GAME.world;
    w.effects.length = 0;
    w.effects.push({ kind: 'boom', x: ${nearX}, y: ${nearY}, r: 100, life: 8, maxLife: 8, color: '#ffffff' });
    w.effects.push({ kind: 'arc', x: ${nearX}, y: ${nearY}, r: 90, facing: 0, arcDeg: 220, life: 8, maxLife: 8, color: '#ffffff' });
    return true;
  })()`);
  await sleep(350);
  const nearFx = await P.eval(`window.__pixAvg(${nearX}, ${nearY}, ${SAMPLE_R}, ${FRAMES})`);
  await P.eval('window.__clear()');
  await sleep(250);

  const nearBare = allMean(nearClean), nearLit = allMean(nearFx);
  const nearGain = (nearBare !== null && nearLit !== null) ? (nearLit - nearBare) : -999;
  console.log('  正向对照：地面 ' + r1(nearBare || 0) + ' → 加特效 ' + r1(nearLit || 0) + ' → 升 ' + r1(nearGain));
  ok('★★正向对照：特效确实画在画面上（同一点变亮 ≥ 25）', nearGain >= 25, '只升了 ' + r1(nearGain));

  console.log('  截图（特效压在角色身上时的样子）：' + TMP + '/vs_layer_on.png');
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
