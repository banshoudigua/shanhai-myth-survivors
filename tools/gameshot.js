// tools/gameshot.js —— 给游戏页拍"定点场景"截图
//
// 为什么不用 gamecheck 的截图：
//   gamecheck 跑的是真实对局，拍到的同屏怪数全看运气（经常只有十几只），
//   根本没法核对某一种怪的造型对不对、某个面板排版有没有歪。
//   这里直接把场景摆好再拍：7 种怪整齐排开、各种掉落物、指定面板。
//
// 用法：node tools/gameshot.js [端口] [场景] [输出名]
//   场景：mobs | hud | select | levelup | paused | result
// 例：  node tools/gameshot.js 3000 mobs mobs01
// 输出：<系统临时目录>/vs_shot_<输出名>.png（路径见 tools/env.js 的 TMP）

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const APP_PORT = Number(process.argv[2] || 3000);
const SCENE = process.argv[3] || 'mobs';
const NAME = process.argv[4] || SCENE;

const CDP_PORT = 9335;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_gameshot_profile';
const OUT = TMP + '/vs_shot_' + NAME + '.png';

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function killByPort(port) {
  return new Promise(function (resolve) {
    const { execFile } = require('node:child_process');
    execFile('powershell', ['-NoProfile', '-Command',
      '$p = (Get-NetTCPConnection -LocalPort ' + port + '-State Listen -ErrorAction SilentlyContinue).OwningProcess; ' +
      'if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }'
    ], function () { resolve(); });
  });
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--disable-gpu', '--no-sandbox', '--no-proxy-server', '--no-first-run',
      '--hide-scrollbars', '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=1600,1200', 'about:blank'
    ];
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    child.on('error', reject);
    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume(); clearInterval(t); resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口没起来')); }
      });
    }, 500);
  });
}

function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) { return tab.webSocketDebuggerUrl; })
    .then(function (wsUrl) {
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = {};
        const errors = [];
        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () { delete pending[msgId]; rej(new Error('CDP 超时：' + method)); }, 20000);
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
            errors.push((d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
          }
          if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            errors.push(msg.params.entry.text || '');
          }
        });
        ws.addEventListener('open', function () { resolve({ send: send, ws: ws, errors: errors }); });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// ============================================================
// 场景搭建（在页面里跑）
// ============================================================

// 把 7 种怪按行铺开，每行一种，方便逐行核对造型与辨识度
function sceneMobs() {
  return [
    '(function(){',
    'var g = window.VS_GAME; if (!g) return "no hook";',
    'var w = g.world, C = window.VS.CONST;',
    // 关键：冻结世界但不要弹遮罩。
    // 用 ui.screen="paused" 会把暂停面板盖上来，整屏都是浮层；
    // 把 w.state 置成非 playing 才会让主循环停步，ui.screen 保持 playing 就没有浮层。
    'w.state = "paused";',
    'g.ui.screen = "playing";',
    // 把玩家挪到地图正中，镜头跟着摆正
    'w.player.x = w.player.px = C.MAP.width/2;',
    'w.player.y = w.player.py = C.MAP.height/2;',
    'w.player.hp = Math.round(w.player.maxHp * 0.62);',
    'var cx = w.player.x, cy = w.player.y;',
    'w.mobs.length = 0;',
    'var seq = 1;',
    'var ids = ["corpse","bat","skeleton_warrior","gargoyle","blood_priest","witch_hunter","blood_lord"];',
    'var cols = 5, gapX = 140, gapY = 100;',
    'for (var row=0; row<ids.length; row++){',
    '  var def = C.MOB_MAP[ids[row]];',
    '  for (var c=0; c<cols; c++){',
    '    if (row === ids.length-1 && c > 1) continue;',   // Boss 太大，少放两只
    '    var x = cx - ((cols-1)/2 - c) * gapX;',
    // 网格整体下移一点：上方避开顶部 HUD 与 Boss 血条，下方给掉落物留位置
    '    var y = cy + 30 - ((ids.length-1)/2 - row) * gapY;',
    // 玩家占着屏幕正中，那一格留空，免得把玩家盖住看不出造型
    '    if (Math.abs(x - cx) < 70 && Math.abs(y - cy) < 70) continue;',
    '    w.mobs.push({ id: seq++, defId: def.id, def: def, x: x, y: y, px: x, py: y,',
    '      hp: def.hp * (c === 1 ? 0.45 : 1), maxHp: def.hp, r: def.r, alive: true,',
    '      vx: 1, vy: 0.35, kx: 0, ky: 0, hitCd: 0, flash: (c === 2 ? 0.05 : 0),',
    '      shootCd: 0, chargeCd: 0, charging: (c === 3 ? 0.4 : 0), stun: 0, phase: 1.2, buffMul: 1 });',
    '  }',
    '}',
    'w.aliveMobCount = w.mobs.length;',
    // 掉落物：三种各排一行
    'w.pickups.length = 0;',
    'for (var k=0;k<9;k++){',
    '  var ox = cx - 300 + k*38, oy = cy + 268;',
    '  w.pickups.push({ kind: "exp", x: ox, y: oy, px: ox, py: oy });',
    '}',
    'for (var k2=0;k2<4;k2++){',
    '  var gx = cx - 60 + k2*42, hx = cx + 130 + k2*42, oy2 = cy + 268;',
    '  w.pickups.push({ kind: "gold", x: gx, y: oy2, px: gx, py: oy2 });',
    '  w.pickups.push({ kind: "heart", x: hx, y: oy2, px: hx, py: oy2 });',
    '}',
    // 画几种特效，顺便验证特效层观感
    'w.effects.length = 0;',
    'w.effects.push({ kind: "ring", x: cx - 300, y: cy - 330, r: 70, life: 0.35, maxLife: 0.5, color: "#f2c14e" });',
    'w.effects.push({ kind: "boom", x: cx + 300, y: cy - 330, r: 48, life: 0.3, maxLife: 0.5 });',
    'w.effects.push({ kind: "arc", x: cx, y: cy - 370, r: 90, arcDeg: 110, facing: 0, life: 0.4, maxLife: 0.6, color: "#e8dcc0" });',
    'return "ok mobs=" + w.mobs.length;',
    '})()'
  ].join('\n');
}

// 面板类场景：把数值撑起来再切到对应界面，免得面板里全是 0
function scenePanel(screen) {
  return [
    '(function(){',
    'var g = window.VS_GAME; if (!g) return "no hook";',
    'var C = window.VS.CONST;',
    'g.start();',
    'var w = g.world, p = w.player;',
    // 补几件武器与被动，让底部槽位和结算的"持有武器"不是孤零零一个
    'var wid = ["whip","heavy_ball","thunder","scripture"];',
    'for (var i=0;i<wid.length;i++){',
    '  var d = C.WEAPON_MAP[wid[i]];',
    '  if (d) p.weapons.push({ id: d.id, level: 3 + i, cd: 0 });',
    '}',
    'p.weapons[0].level = 8;',   // 让一个槽位吃到"进化"样式
    'var pid = ["blood_crystal","iron_shell","wind_feather","wide_lens"];',
    'for (var j=0;j<pid.length;j++){',
    '  var pd = C.PASSIVE_MAP[pid[j]];',
    '  if (pd) p.passives.push({ id: pd.id, level: 2 + j });',
    '}',
    'p.level = 12; p.exp = 18; p.expNext = 60;',
    'p.hp = 62; p.maxHp = 120;',
    'p.pendingLevels = 2; w.pendingLevels = 2;',
    'w.stats.kills = 486; w.stats.gold = 213; w.stats.dmgDealt = 91234;',
    'w.wave = 14; w.time = 512;',
    'var S = "' + screen + '";',
    'if (S === "levelup") {',
    '  w.state = "levelup";',
    // 候选列表是 HUD 直接引用的，给三条假数据即可（只截图，不会真的点）
    '  w.choices = [',
    '    { tag: "新武器", name: "圣经风暴", desc: "召唤环绕的经卷，持续切割靠近的敌人", type: "weapon" },',
    '    { tag: "进化", name: "血鞭", desc: "铁鞭的进化形态：范围更大、附带吸血", type: "evolve" },',
    '    { tag: "被动", name: "广域镜", desc: "技能范围 +8% / 级", type: "passive" }',
    '  ];',
    '} else if (S === "result") {',
    '  w.state = "won";',
    '} else if (S === "paused") {',
    '  w.state = "paused";',
    '}',
    'g.ui.screen = S;',
    'return "ok " + S + " 武器=" + p.weapons.length + " 被动=" + p.passives.length;',
    '})()'
  ].join('\n');
}

// ============================================================

async function main() {
  console.log('=== gameshot  场景=' + SCENE + '  输出=' + OUT + ' ===');
  if (!fs.existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }

  const alive = await fetch('http://127.0.0.1:' + APP_PORT + '/api/health')
    .then(function (r) { return r.status === 200; }).catch(function () { return false; });
  if (!alive) { console.log('!! 应用服务未就绪'); process.exit(1); }

  await killByPort(CDP_PORT);
  await sleep(400);

  const chrome = await launchChrome();
  const s = await connect();
  const send = s.send;

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.startScreencast', { format: 'jpeg', quality: 25, everyNthFrame: 4 });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + APP_PORT + '/game.html?debug=1&_t=' + Date.now() });
  await sleep(2500);

  // 必须先开局：VS_GAME.world 在选人阶段是个空转的预览世界
  await send('Runtime.evaluate', {
    expression: '(function(){ var g=window.VS_GAME; if(g) g.start(); return 1; })()',
    returnByValue: true
  });
  await sleep(700);

  const PANEL_SCENES = ['select', 'levelup', 'paused', 'result'];
  let expr;
  if (SCENE === 'mobs') expr = sceneMobs();
  else if (PANEL_SCENES.indexOf(SCENE) >= 0) expr = scenePanel(SCENE);
  else { console.log('!! 未知场景：' + SCENE + '（可用：mobs / ' + PANEL_SCENES.join(' / ') + '）'); expr = sceneMobs(); }

  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  const v = res && res.result && res.result.value;
  console.log('  搭景结果：' + JSON.stringify(v));

  // 摆完景让渲染循环多跑几帧（浮字/动画时钟要动起来）
  await sleep(900);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('  截图：' + OUT);

  await send('Page.stopScreencast');
  s.ws.close();
  chrome.kill();
  await killByPort(CDP_PORT);

  if (s.errors.length) console.log('  页面异常：' + s.errors.join(' || '));
  process.exit(0);
}

setTimeout(function () { console.log('!! 总超时 120 秒'); process.exit(2); }, 120000);

main().catch(function (e) {
  console.log('脚本出错：' + (e && e.message));
  process.exit(1);
});
