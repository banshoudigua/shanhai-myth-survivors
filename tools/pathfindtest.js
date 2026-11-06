// 导航流场回归：自写 BFS 流场 vs rot.js 的 Dijkstra（算法对照基准）。
// 跑：node tools/pathfindtest.js
//
// ★为什么 rot.js 只出现在测试里（不进运行时热路径）：
//   ROT.Path.Dijkstra 是「单目标 → 距离场」的正确模型，但它用 "x,y" 字符串做 key、
//   用 shift() 出队，在 95×70 的格子上每 0.5 秒跑一遍会制造大量临时对象；
//   本项目服务端 20Hz 且同屏几百怪，改用定长 TypedArray BFS 更稳。
//   库留在 tools/vendor/rot.min.js 作为**标准答案**，每次回归都拿它校验我们的距离场；
//   它不发布到线上（浏览器根本不加载这个文件）。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SIM = require('../shared/sim.js');
const MAPS = require('../shared/maps.js');
const C = require('../shared/const.js');

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// --- 加载 rot.js 的浏览器构建（UMD），只取 ROT 全局 ---
const rotCtx = { console: console, Math: Math, Object: Object, Array: Array, JSON: JSON };
rotCtx.window = rotCtx; rotCtx.self = rotCtx; rotCtx.globalThis = rotCtx;
vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'tools/vendor/rot.min.js'), 'utf8'),
  rotCtx, { filename: 'rot.min.js', timeout: 5000 });
const ROT = rotCtx.ROT;

// --- 造一张 20×15 的小测试图：中间一道墙 + 一个缺口 ---
function makeWorld() {
  const w = SIM.createWorld({ charId: C.CHARACTERS[0].id, seed: 4242 });
  w.map = Object.assign({}, MAPS.mapById('corridor'), { id: 'navtest', w: 800, h: 600 });
  const obs = [];
  for (let y = 20; y <= 580; y += 40) {
    if (y >= 260 && y <= 340) continue;         // 缺口：y=260~340
    obs.push({ x: 400, y: y, r: 26, kind: 'wall' });
  }
  w.obstacles = obs;
  w.obsGrid = MAPS.buildGrid(w.map, obs);
  // 玩家固定在右侧；先清掉自动攻击，免得测试里怪被打死
  const p = w.players[0];
  p.x = 700; p.y = 300; p.px = 700; p.py = 300;
  p.weapons = [];
  p.passives = [];
  p.hp = 1e9; p.maxHp = 1e9;
  w.mobs.length = 0;
  return w;
}

const CELL = 40;

function rotDistance(blocked, gw, gh, tx, ty, sx, sy) {
  const dj = new ROT.Path.Dijkstra(tx, ty, function (x, y) {
    return x >= 0 && y >= 0 && x < gw && y < gh && !blocked[y * gw + x];
  }, { topology: 4 });   // ★ROT 默认 8 邻域（能斜穿），我们的流场是 4 邻域，必须对齐
  let n = 0;
  dj.compute(sx, sy, function () { n++; });
  return n - 1;                  // 回调含起点，步数要减一
}

console.log('=== 导航流场 / rot.js 对照 ===');

expect('rot.js 运行时可用（Path.Dijkstra 存在）', !!(ROT && ROT.Path && ROT.Path.Dijkstra));

const w = makeWorld();
SIM.step(w, { mx: 0, my: 0 });
const nav = w.nav;
expect('推进一帧就建出共享流场（挂在 w.nav，模拟层内部）', !!nav && nav.ready === true);
expect('格子尺寸 20×15（800×600 / 40）', nav.gw === 20 && nav.gh === 15,
  nav ? nav.gw + '×' + nav.gh : '无');
expect('墙上确实有不可走格', nav.blocked.reduce((a, b) => a + b, 0) >= 8,
  '不可走格=' + nav.blocked.reduce((a, b) => a + b, 0));

// 目标格：流场实际用的那个（玩家所在格）
const tx = nav.tx, ty = nav.ty;
expect('目标格不是墙', nav.blocked[ty * nav.gw + tx] === 0, 'tx=' + tx + ' ty=' + ty);

// ★核心对照：对多个起点，ROT 的最短步数必须等于我们的 dist
{
  const starts = [
    [1, 1], [1, 7], [1, 14], [5, 2], [5, 7], [5, 13],
    [9, 1], [9, 7], [9, 14], [14, 3], [14, 7], [14, 12], [18, 7], [18, 1]
  ];
  let checked = 0, mismatch = [];
  for (const s of starts) {
    const [sx, sy] = s;
    const i = sy * nav.gw + sx;
    if (nav.blocked[i]) continue;
    const ours = nav.dist[i];
    const theirs = rotDistance(nav.blocked, nav.gw, nav.gh, tx, ty, sx, sy);
    checked++;
    if (ours !== theirs) mismatch.push(sx + ',' + sy + ' ours=' + ours + ' rot=' + theirs);
  }
  expect('★' + checked + ' 个起点的最短路与 rot.js Dijkstra 完全一致',
    checked >= 10 && mismatch.length === 0, mismatch.join(' | '));
}

// 流场自身一致性：沿 dir 走一步，dist 必须减 1（不能指回死路）
{
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  let bad = 0, walked = 0;
  for (let cy = 0; cy < nav.gh; cy++) {
    for (let cx = 0; cx < nav.gw; cx++) {
      const i = cy * nav.gw + cx;
      if (nav.dist[i] <= 0) continue;
      const k = nav.dir[i];
      const nx = cx + DX[k], ny = cy + DY[k];
      walked++;
      if (nx < 0 || ny < 0 || nx >= nav.gw || ny >= nav.gh ||
          nav.dist[ny * nav.gw + nx] !== nav.dist[i] - 1) bad++;
    }
  }
  expect('★每个可走格的方向都指向 dist 更小的邻格', walked > 100 && bad === 0,
    'walked=' + walked + ' bad=' + bad);
  expect('墙后的格子仍可达（流场绕过了缺口，不是被墙切断）',
    nav.dist[7 * nav.gw + 1] > 0 && nav.dist[7 * nav.gw + 1] < 900);
}

// 节流与性能：0.5 秒最多重算一次，且一次 BFS 必须远小于一帧预算
{
  const buildsBefore = nav.builds;
  for (let i = 0; i < 8; i++) SIM.step(w, { mx: 0, my: 0 });
  expect('★8 帧内不重复 BFS（0.5 秒节流生效）', nav.builds === buildsBefore,
    'builds ' + buildsBefore + ' → ' + nav.builds);
  w.nav.at = -99;                       // 强制下一帧重算
  const t0 = process.hrtime.bigint();
  SIM.step(w, { mx: 0, my: 0 });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  expect('单次 BFS 远小于 50ms 帧预算（含整帧模拟）', ms < 50, ms.toFixed(2) + 'ms');
  console.log('    参考：强制重算那一帧共 ' + ms.toFixed(2) + 'ms');
}

// ★不进快照协议：白名单里一个 nav 字段都不能有
{
  const proto = fs.readFileSync(path.join(ROOT, 'shared/proto_bin.js'), 'utf8');
  expect('二进制协议里没有 nav/flow 字段', !/\b(nav|flowField|blocked|dirAt)\b/i.test(proto));
}

// 降级路径：把流场关掉，怪仍应能移动（旧切向绕行不能被删）
{
  const w2 = makeWorld();
  const m = SIM.spawnMob(w2, C.MOBS[0].id, 120, 300, 1);
  expect('造出一只测试怪', !!m);
  const x0 = m.x;
  for (let i = 0; i < 40; i++) {
    w2.nav && (w2.nav.ready = false, w2.nav.at = w2.time + 100);
    SIM.step(w2, { mx: 0, my: 0 });
  }
  expect('★流场不可用时怪照样在走（旧绕行没被拆）', m.x > x0 + 10,
    'x ' + x0.toFixed(1) + ' → ' + m.x.toFixed(1));
}

// 反向验证：有流场时，怪从墙左侧能穿过缺口追到右侧，不会被墙永久挡死
{
  const w3 = makeWorld();
  const m = SIM.spawnMob(w3, C.MOBS[0].id, 120, 300, 1);
  m.hp = 1e9; m.maxHp = 1e9;
  for (let i = 0; i < 220; i++) SIM.step(w3, { mx: 0, my: 0 });
  expect('★有流场时怪能绕过墙追向玩家（x 越过 400 的墙线）', m.x > 430,
    'x=' + m.x.toFixed(1));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
