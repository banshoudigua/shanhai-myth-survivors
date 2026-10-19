// tools/renderbench.js —— 渲染层性能基准（改造前 / 改造后对比用）
//
// 为什么要单独写一个 bench 而不是靠 gamecheck 的 FPS：
//   gamecheck 跑的是真实对局，同屏怪数一直变，FPS 波动大、不可复现。
//   这里改成「固定场景 + 同步批量 draw」，同一台机器同一批怪，前后两次结果可以直接比。
//
// 关键手法：
//   1. 先在页面里把界面切成 paused，主循环就不会推进 sim，注入的怪不会被清掉；
//   2. 全部测量写在一个同步 evaluate 里 —— JS 单线程，同步执行期间 rAF 根本插不进来，
//      所以主循环不会污染计时；
//   3. 结束前做一次 1x1 getImageData 强制刷命令队列，避免只量到「录命令」的时间。
//
// 用法：node tools/renderbench.js [端口] [同屏怪数] [标签]
// 例：  node tools/renderbench.js 3000 800 基线

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const APP_PORT = Number(process.argv[2] || 3000);
const MOB_COUNT = Number(process.argv[3] || 800);
const LABEL = process.argv[4] || '未命名';

const CDP_PORT = 9334;                 // 与 gamecheck 的 9333 错开，避免互相抢端口
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_renderbench_profile';
const LOG = TMP + '/vs_renderbench.log';


fs.writeFileSync(LOG, '');
function log() {
  const s = Array.prototype.map.call(arguments, function (a) {
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ');
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// ============================================================
// 无头浏览器
// ============================================================

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
      '--disable-gpu',          // 软件光栅：CPU 时间才是我们想量的东西
      '--no-sandbox',
      '--no-proxy-server',
      '--no-first-run',
      '--hide-scrollbars',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-allow-origins=*',
      '--window-size=1280,800',
      'about:blank'
    ];
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    child.on('error', reject);

    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume();
        clearInterval(t);
        resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口 ' + CDP_PORT + ' 20 秒内没起来')); }
      });
    }, 500);
  });
}

function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      if (!tab || !tab.webSocketDebuggerUrl) throw new Error('新建标签页失败：' + JSON.stringify(tab));
      return tab.webSocketDebuggerUrl;
    })
    .then(function (wsUrl) {
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = {};
        const pageErrors = [];

        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () {
              delete pending[msgId];
              rej(new Error('CDP 命令超时：' + method));
            }, 20000);
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
            pageErrors.push('exception: ' + (d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
          }
          if (msg.method === 'Log.entryAdded') {
            const e = msg.params.entry || {};
            if (e.level === 'error') pageErrors.push('log: ' + (e.text || ''));
          }
        });

        ws.addEventListener('open', function () { resolve({ send: send, ws: ws, pageErrors: pageErrors }); });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// ============================================================
// 页面内基准脚本
// ============================================================
//
// 量法说明（踩过坑，别再改回去）：
//   曾经只量「批量调 draw() 一次，最后再来一发 getImageData」——
//   结果 submit 与 flush 两个数根本不构成一帧的真实成本（display list 会攒着，
//   最后一次 readback 只刷最后一帧），拿它做前后对比会得出反向结论。
//   现在改成：每帧 draw() 之后立刻 getImageData(0,0,1,1) 强制光栅化这一帧，
//   于是「一帧的完整成本 = 录命令 + 光栅」全部计进去，可复现、可横向比。
//
// 同时把场景拆成 4 档分别计时，用来定位成本到底花在哪：
//   full     正常画
//   noGround 关掉整图地面纹理（走逐帧网格兜底）
//   noMobs   清空怪物（剩下的就是地面 + 掉落物 + 各种特效）
//   noPick   清空掉落物

function benchExpr(mobCount, warmup, frames, rounds) {
  return '(function(){' + [
    'var g = window.VS_GAME;',
    'if (!g) return { err: "没有 window.VS_GAME（要用 ?debug=1 打开）" };',
    'if (!g.renderer) return { err: "VS_GAME 没有暴露 renderer" };',
    'var w = g.world, r = g.renderer, C = window.VS.CONST;',
    'if (!w) return { err: "world 为空" };',
    // 切暂停：主循环不再推进 sim，注入的怪不会被清掉也不会乱跑
    'g.ui.screen = "paused";',
    'var viewW = r.viewW, viewH = r.viewH;',
    'var p = w.player;',
    'var cx = p.x, cy = p.y;',
    // 怪的类型配比贴近后期波次：小怪为主，精英/Boss 少量
    'var MIX = [["corpse",0.58],["bat",0.15],["skeleton_warrior",0.11],["gargoyle",0.08],["witch_hunter",0.05],["blood_priest",0.02],["blood_lord",0.01]];',
    'function pick(u){ var acc=0; for (var i=0;i<MIX.length;i++){ acc+=MIX[i][1]; if (u<=acc) return MIX[i][0]; } return "corpse"; }',
    'var seq = 900000;',
    'var seed = 123456789;',
    'function rnd(){ seed = (seed*1664525+1013904223)>>>0; return seed/4294967296; }',
    // 全部撒在视口内 —— 这是最坏情况，没有任何视口裁剪折扣
    'var made = 0;',
    'w.mobs.length = 0;',
    'for (var i=0;i<' + mobCount + ';i++){',
    '  var id = pick(rnd()); var def = C.MOB_MAP[id]; if (!def) continue;',
    '  var x = cx - viewW/2 + rnd()*viewW;',
    '  var y = cy - viewH/2 + rnd()*viewH;',
    '  w.mobs.push({ id: seq++, defId: def.id, def: def, x: x, y: y, px: x, py: y,',
    '    hp: def.hp, maxHp: def.hp, r: def.r, alive: true, vx: 0.003, vy: 0.002,',
    '    kx: 0, ky: 0, hitCd: 0, flash: 0, shootCd: 0, chargeCd: 0,',
    '    charging: 0, stun: 0, phase: rnd()*6.283, buffMul: 1 });',
    '  made++;',
    '}',
    'w.aliveMobCount = made;',
    // 经验球是后期最密集的绘制物，一起塞进去
    'w.pickups.length = 0;',
    'for (var k=0;k<300;k++){',
    '  var ox = cx - viewW/2 + rnd()*viewW, oy = cy - viewH/2 + rnd()*viewH;',
    '  w.pickups.push({ kind: (k%17===0?"gold":(k%53===0?"heart":"exp")), x:ox, y:oy, px:ox, py:oy });',
    '}',
    // 预热：首次 draw 会建地面纹理 + 精灵缓存，不能算进成绩
    'for (var q=0;q<' + warmup + ';q++) { r.draw(w, 1, null); r.ctx.getImageData(0,0,1,1); }',
    // 单档次计时：每帧强制光栅化，量到的是「一帧完整成本」。
    // 每档跑多轮取最小值 —— 机器上还有别的进程在抢 CPU，最小值才是最接近
    // "纯渲染成本"的估计（平均值会被偶发抢占拉高，前后对比会失真）。
    // 轮次不够时会出现「做了更少的事反而更慢」的鬼数据（本机实测遇到过），
    // 遇到这种自相矛盾的档，加轮次重跑，别当成真实结论。
    'var N = ' + frames + ';',
    'function timed(label){',
    '  var best = Infinity, drawn = 0, total = 0;',
    '  for (var round=0; round<' + rounds + '; round++){',
    '    var t0 = performance.now();',
    '    for (var f=0;f<N;f++){ r.draw(w, 1, null); r.ctx.getImageData(0,0,1,1); }',
    '    var t1 = performance.now();',
    '    var ms = (t1-t0)/N;',
    '    if (ms < best) { best = ms; drawn = r.stat.drawn; total = r.stat.total; }',
    '  }',
    '  return { label: label, ms: +best.toFixed(3), drawn: drawn, total: total };',
    '}',
    'var out = [];',
    'out.push(timed("full"));',
    // 不刷队列，只量「录命令」阶段 —— 这一档才和早期的旧基线同口径
    'var t0 = performance.now();',
    'for (var f2=0;f2<N;f2++) r.draw(w, 1, null);',
    'var t1 = performance.now();',
    'out.push({ label: "submitOnly", ms: +((t1-t0)/N).toFixed(3), drawn: r.stat.drawn, total: r.stat.total });',
    'r.ctx.getImageData(0,0,1,1);',
    // 关地面纹理
    'var keepTex = r.groundTex; r.groundTex = null;',
    'out.push(timed("noGround"));',
    'r.groundTex = keepTex;',
    // 清怪
    'var keepMobs = w.mobs; w.mobs = [];',
    'out.push(timed("noMobs"));',
    'w.mobs = keepMobs;',
    // 清掉落物
    'var keepPick = w.pickups; w.pickups = [];',
    'out.push(timed("noPick"));',
    'w.pickups = keepPick;',
    // 旧版怪物绘制对照：改造前 render.js 的 drawMob / drawMobs 原样搬过来，
    // 用同一套计时方法（每帧强制光栅化）量，才敢说快慢。
    'var LCD = r.ctx;',
    'function oldVisible(x,y,rr){ var b=r.bounds; return x+rr>=b.x0&&x-rr<=b.x1&&y+rr>=b.y0&&y-rr<=b.y1; }',
    'function oldDrawMob(m,x,y){',
    '  var def=m.def, rr=def.r, flash=m.flash>0;',
    '  LCD.fillStyle = flash ? "#ffffff" : def.color;',
    '  if (def.id==="bat"){ LCD.beginPath(); LCD.moveTo(x,y-rr); LCD.lineTo(x+rr*1.6,y); LCD.lineTo(x,y+rr); LCD.lineTo(x-rr*1.6,y); LCD.closePath(); LCD.fill(); return; }',
    // 这只怪后来从「骸骨弓手」改成了近战的「骸骨武士」（怪物不做远程），
    // id 跟着改；绘制还是当年的简笔版本，用来跟新版比渲染耗时。
    '  if (def.id==="skeleton_warrior"){ LCD.fillRect(x-rr*0.8,y-rr,rr*1.6,rr*2); LCD.strokeStyle=flash?"#ffffff":"#6d6455"; LCD.lineWidth=2; LCD.beginPath(); LCD.arc(x+rr*1.3,y,rr*0.9,-Math.PI/2.4,Math.PI/2.4); LCD.stroke(); return; }',
    '  if (def.id==="gargoyle"){ LCD.beginPath(); for(var k=0;k<6;k++){var a=(Math.PI/3)*k-Math.PI/2; var px=x+Math.cos(a)*rr, py=y+Math.sin(a)*rr; if(k===0)LCD.moveTo(px,py); else LCD.lineTo(px,py);} LCD.closePath(); LCD.fill(); LCD.fillStyle=flash?"#ffffff":"rgba(0,0,0,0.25)"; LCD.beginPath(); LCD.arc(x,y,rr*0.45,0,Math.PI*2); LCD.fill(); return; }',
    '  if (def.id==="blood_priest"){ LCD.beginPath(); LCD.arc(x,y,rr,0,Math.PI*2); LCD.fill(); LCD.strokeStyle="rgba(201,58,58,0.35)"; LCD.lineWidth=1.5; LCD.beginPath(); LCD.arc(x,y,def.auraRadius,0,Math.PI*2); LCD.stroke(); return; }',
    '  if (def.id==="witch_hunter"){ var ang=Math.atan2(m.vy,m.vx); LCD.save(); LCD.translate(x,y); LCD.rotate(ang); LCD.fillStyle=flash?"#ffffff":(m.charging>0?"#ff6b3d":def.color); LCD.beginPath(); LCD.moveTo(rr*1.3,0); LCD.lineTo(-rr,-rr*0.85); LCD.lineTo(-rr,rr*0.85); LCD.closePath(); LCD.fill(); LCD.restore(); return; }',
    '  if (def.id==="blood_lord"){ LCD.beginPath(); LCD.arc(x,y,rr,0,Math.PI*2); LCD.fill(); LCD.fillStyle=flash?"#ffffff":"#4a0a17"; LCD.beginPath(); for(var k2=0;k2<10;k2++){var a2=(Math.PI*2/10)*k2; LCD.moveTo(x+Math.cos(a2-0.12)*rr*0.9,y+Math.sin(a2-0.12)*rr*0.9); LCD.lineTo(x+Math.cos(a2)*rr*1.55,y+Math.sin(a2)*rr*1.55); LCD.lineTo(x+Math.cos(a2+0.12)*rr*0.9,y+Math.sin(a2+0.12)*rr*0.9); LCD.closePath();} LCD.fill(); LCD.strokeStyle="rgba(201,58,58,0.3)"; LCD.lineWidth=2; LCD.beginPath(); LCD.arc(x,y,def.auraRadius,0,Math.PI*2); LCD.stroke(); return; }',
    '  LCD.beginPath(); LCD.arc(x,y,rr,0,Math.PI*2); LCD.fill();',
    '}',
    'function oldDrawMobs(list){',
    '  for (var i=0;i<list.length;i++){',
    '    var m=list[i]; if(!m.alive) continue;',
    '    if(!oldVisible(m.x,m.y,m.def.r+24)) continue;',
    '    var x=m.x, y=m.y;',
    '    oldDrawMob(m,x,y);',
    '    var tier=m.def.tier;',
    '    if(tier==="elite"||tier==="commander"||tier==="boss"){',
    '      var bw=m.def.r*2.4, bh=tier==="boss"?6:3, ratio=Math.max(0,m.hp/m.maxHp);',
    '      LCD.fillStyle="rgba(0,0,0,0.6)"; LCD.fillRect(x-bw/2,y-m.def.r-10,bw,bh);',
    '      LCD.fillStyle=tier==="boss"?"#c93a3a":"#e08a3a"; LCD.fillRect(x-bw/2,y-m.def.r-10,bw*ratio,bh);',
    '    }',
    '  }',
    '}',
    'var lt0 = 0, ltBest = Infinity;',
    'for (var lround=0; lround<' + rounds + '; lround++){',
    '  lt0 = performance.now();',
    '  for (var lf=0; lf<N; lf++){',
    '    LCD.save(); LCD.translate(-r.cam.x, -r.cam.y);',
    '    oldDrawMobs(w.mobs);',
    '    LCD.restore();',
    '    LCD.getImageData(0,0,1,1);',
    '  }',
    '  var lms = (performance.now()-lt0)/N;',
    '  if (lms < ltBest) ltBest = lms;',
    '}',
    'out.push({ label: "oldMobsOnly", ms: +ltBest.toFixed(3), drawn: 0, total: 0 });',
    'return { ok: true, mobs: made, frames: N, rounds: ' + rounds + ', viewW: viewW, viewH: viewH, dpr: r.dpr, stages: out };',
    ''
  ].join('\n') + '})()';
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  log('');
  log('=== renderbench  [' + LABEL + ']  同屏怪 ' + MOB_COUNT + '  http://127.0.0.1:' + APP_PORT + ' ===');

  if (!fs.existsSync(CHROME)) {
    log('!! 找不到无头浏览器: ' + CHROME);
    process.exit(1);
  }

  const alive = await fetch('http://127.0.0.1:' + APP_PORT + '/api/health')
    .then(function (r) { return r.status === 200; })
    .catch(function () { return false; });
  if (!alive) { log('!! 应用服务未就绪，先启动 server/index.js'); process.exit(1); }

  await killByPort(CDP_PORT);
  await sleep(400);

  const chrome = await launchChrome();
  const s = await connect();
  const send = s.send;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  // 关掉磁盘缓存：user-data-dir 是复用的，不清缓存会量到上一次改动的旧 JS
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.startScreencast', { format: 'jpeg', quality: 20, everyNthFrame: 4 });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + APP_PORT + '/game.html?debug=1&_t=' + Date.now() });

  await sleep(2500);

  // 先开局，让 world.player 有真实属性（pickupRadius 等）
  await send('Runtime.evaluate', {
    expression: '(function(){ var g=window.VS_GAME; if(!g) return 0; g.start(); return 1; })()',
    returnByValue: true
  });
  await sleep(600);

  // 每档帧数与轮次，可用环境变量调小/调大：
  //   RENDERBENCH_FRAMES=25  做大数量级（2000+ 怪）容量扫描时必须缩短，
  //   否则 6 档 × 轮次 × 120 帧会撞上 CDP 那条 20 秒的 Runtime.evaluate 超时。
  //   RENDERBENCH_ROUNDS=3   机器上还有别的进程抢 CPU 时，多跑几轮取最小值更抗干扰。
  const frames = Math.max(8, Number(process.env.RENDERBENCH_FRAMES || 120));
  const rounds = Math.max(1, Number(process.env.RENDERBENCH_ROUNDS || 2));
  const res = await send('Runtime.evaluate', {
    expression: benchExpr(MOB_COUNT, 20, frames, rounds),
    returnByValue: true
  });
  const v = (res && res.result && res.result.value) || null;

  await send('Page.stopScreencast');
  s.ws.close();
  chrome.kill();
  await killByPort(CDP_PORT);

  if (!v || !v.ok) {
    log('!! 基准失败：' + JSON.stringify(v));
    log('   页面异常：' + s.pageErrors.join(' || '));
    process.exit(1);
  }

  log('');
  log('  实际造怪      ' + v.mobs);
  log('  视口          ' + v.viewW + 'x' + v.viewH + '  dpr=' + v.dpr);
  log('  每档 ' + v.frames + ' 帧 × ' + v.rounds + ' 轮取最小；除 submitOnly 外，每帧 draw 后强制光栅化（数值 = 一帧完整成本）');
  log('');
  log('  场景            ms/帧    说明');
  const NOTE = {
    full: '整帧（新渲染器）',
    submitOnly: '只录命令不刷队列（与旧基线同口径）',
    noGround: '关掉整图地面纹理',
    noMobs: '清空怪物（地面 + 掉落物 + 特效）',
    noPick: '清空掉落物',
    oldMobsOnly: '旧版路径绘制 800 只怪（仅怪物部分）'
  };
  for (let i = 0; i < v.stages.length; i++) {
    const s = v.stages[i];
    log('  ' + s.label.padEnd(14, ' ') + ' ' +
      String(s.ms).padEnd(8, ' ') + ' ' + (NOTE[s.label] || ''));
  }

  // 怪物部分的对照：新版 = full - noMobs；旧版 = oldMobsOnly
  const st = {};
  v.stages.forEach(function (x) { st[x.label] = x.ms; });
  const newMobs = st.full - st.noMobs;
  log('');
  log('  怪物部分对照（同为 800 只，同为每帧强制光栅化）');
  log('    旧版路径绘制  ' + st.oldMobsOnly + ' ms/帧');
  log('    新版精灵绘制  ' + newMobs.toFixed(3) + ' ms/帧');
  log('    差值          ' + (newMobs - st.oldMobsOnly).toFixed(3) + ' ms/帧' +
    (newMobs < st.oldMobsOnly ? '（新版更快）' : '（新版更慢）'));
  log('');
  log('  整帧            ' + st.full + ' ms/帧  →  折算上限 ' +
    Math.round(1000 / st.full) + ' fps（只算渲染）');
  log('');

  // 给自动化/对比脚本留一个可以直接读的机器可读行
  log('BENCH_RESULT ' + JSON.stringify({
    label: LABEL, mobs: v.mobs, frames: v.frames, rounds: v.rounds,
    fullMs: st.full, submitMs: st.submitOnly,
    noGroundMs: st.noGround, noMobsMs: st.noMobs, noPickMs: st.noPick,
    oldMobsOnlyMs: st.oldMobsOnly,
    newMobsMs: Math.round(newMobs * 1000) / 1000,
    fpsCeiling: Math.round(1000 / st.full)
  }));

  if (s.pageErrors.length) log('页面异常：' + s.pageErrors.join(' || '));
  log('');
  log('日志：' + LOG);
  // 主动退出：下面的 180 秒兜底定时器会拖住事件循环，不退出会被外层工具判成超时
  process.exit(0);
}

setTimeout(function () { log('!! 总超时 180 秒，强制退出'); process.exit(2); }, 180000);

main().catch(function (e) {
  log('脚本出错：' + (e && e.message));
  log((e && e.stack) || '');
  process.exit(1);
});
