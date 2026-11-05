// tools/trajtest.js —— 技能运行轨迹的专项回归
//
// 为什么要单独写：轨迹是「动起来才看得出来」的东西，截图只拍一帧证明不了。
// 这里在 Node 里把世界跑若干帧，量出弹丸每一帧的位置与速度方向，
// 钉住三件事：① 摆尾/弧线/花瓣轨迹确实发生了 ② 摆尾没有把判定带偏到离谱
// ③ 新加的模拟层字段一个都没混进二进制快照协议（联机带宽与一致性）。
//
// 用法：node tools/trajtest.js

const fs = require('node:fs');
const path = require('node:path');
const C = require('../shared/const.js');
const SIM = require('../shared/sim.js');

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

// 造一个干净的世界：清怪、清障碍、不刷波、不升级。
// ★测轨迹必须隔离掉会干扰它的机制，否则「撞墙消失 / 被怪打死」会让采样凭空断掉。
function cleanWorld(weaponId) {
  const w = SIM.createWorld({ charId: 'hunter', seed: 7, mapId: 'graveyard', pauseAllOnLevelUp: false });
  w.mobs.length = 0;
  w.obstacles.length = 0;
  w.nextWaveTick = 1e9;
  w.player.expNext = 1e9;
  w.player.weapons[0] = { id: weaponId, level: 1, timer: 0, rt: {} };
  return w;
}

function maxDev(pts, dt) {
  if (pts.length < 3) return 0;
  const y0 = pts[0].y, vy = pts[0].vy;
  let m = 0;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(pts[i].y - (y0 + vy * i * dt));
    if (d > m) m = d;
  }
  return m;
}

const DT = 1 / C.TICK_HZ;

// ---------------- 1. 直线弹：蛇形摆尾 ----------------
console.log('\n[1] 直线弹摆尾');
const lineW = cleanWorld('spirit_chain');
const linePts = [];
let linePr = null;
for (let i = 0; i < 26; i++) {
  SIM.step(lineW, { mx: 0, my: 0 });
  if (!linePr && lineW.projectiles.length) linePr = lineW.projectiles[0];
  if (linePr && lineW.projectiles.indexOf(linePr) >= 0) {
    linePts.push({ x: linePr.x, y: linePr.y, vx: linePr.vx, vy: linePr.vy });
  }
}
expect('幽冥锁链真的发出弹丸', !!linePr && linePts.length >= 10, '采样 ' + linePts.length + ' 帧');
expect('发射时带上了摆尾参数（不进快照，见第 4 节）',
  !!linePr && linePr.sway > 0 && linePr.swayHz > 0, linePr ? 'sway=' + linePr.sway : '无弹丸');
const dev = maxDev(linePts, DT);
expect('★轨迹确实偏离纯直线（摆尾生效）', dev > 2, '最大偏移 ' + dev.toFixed(2) + 'px');
expect('★摆幅克制，不会把命中判定甩飞', dev < 22, '最大偏移 ' + dev.toFixed(2) + 'px');

// 反向验证：摘掉 sway 后必须回到一条直线，证明偏移不是别的机制造成的
const plainW = cleanWorld('spirit_chain');
plainW.player.weapons.length = 0;   // 不让武器自己开火，手动塞一发不带 sway 的弹
plainW.projectiles.push({
  id: plainW.nextId++, owner: plainW.player, kind: 'line', r: 4, dmg: 1, pierce: 1,
  x: 400, y: 400, px: 400, py: 400, vx: 620, vy: 0, speed: 620,
  life: 3, hitIds: {}, explodeRadius: 0, explodeDmg: 0,
});
const plainPts = [];
for (let i = 0; i < 20; i++) {
  SIM.step(plainW, { mx: 0, my: 0 });
  const q = plainW.projectiles[0];
  if (q) plainPts.push({ x: q.x, y: q.y, vx: q.vx, vy: q.vy });
}
expect('★反向验证：没有 sway 就是一条直线',
  plainPts.length >= 10 && maxDev(plainPts, DT) < 0.01,
  '最大偏移 ' + maxDev(plainPts, DT).toFixed(4) + 'px');

// ---------------- 2. 回旋刃：弧线去程 ----------------
console.log('\n[2] 回旋刃弧线');
const bw = cleanWorld('boomerang');
const angs = [];
let bpr = null;
for (let i = 0; i < 24; i++) {
  SIM.step(bw, { mx: 0, my: 0 });
  if (!bpr && bw.projectiles.length) bpr = bw.projectiles[0];
  // 只量「去程」的转角：回程本来就要大角度找主人，混进来会把弧线幅度放大好几倍
  if (bpr && bw.projectiles.indexOf(bpr) >= 0 && bpr.phase === 'out') {
    angs.push(Math.atan2(bpr.vy, bpr.vx));
  }
}
expect('回旋刃带上了弧线角速度', !!bpr && Math.abs(bpr.curve) > 0,
  bpr ? 'curve=' + bpr.curve : '无弹丸');
let turn = 0;
for (let i = 1; i < angs.length; i++) turn += Math.abs(angs[i] - angs[i - 1]);
expect('★去程速度方向持续变化（不是一根直线）', turn > 0.15,
  '去程累计转角 ' + turn.toFixed(3) + ' rad');
expect('★去程弧线幅度克制（不会自己绕圈）', turn < 1.6,
  '去程累计转角 ' + turn.toFixed(3) + ' rad');

// ★钉「真的飞回来」而不是「最后消失」：超时也会消失，那样武器就废了。
//   tripsDone 只有在回到主人 22px 内才会增加，life 还剩很多说明不是熬到 6 秒超时。
for (let i = 0; i < 200; i++) SIM.step(bw, { mx: 0, my: 0 });
expect('★回旋刃真的飞回主人完成往返（不是靠 life 超时消失）',
  !!bpr && bpr.tripsDone >= 1 && bpr.life > 1,
  bpr ? 'tripsDone=' + bpr.tripsDone + ' 剩余life=' + bpr.life.toFixed(2) : '无弹丸');
expect('★收尾后从场上移除', bw.projectiles.indexOf(bpr) < 0,
  '仍在场=' + (bw.projectiles.indexOf(bpr) >= 0));

// ---------------- 3. 环绕物：花瓣轨迹 ----------------
console.log('\n[3] 环绕物花瓣轨迹');
const ow = cleanWorld('scripture');
const radii = [];
let orb = null;
for (let i = 0; i < 55; i++) {
  SIM.step(ow, { mx: 0, my: 0 });
  if (!orb && ow.orbits.length) orb = ow.orbits[0];
  if (orb && ow.orbits.indexOf(orb) >= 0) {
    radii.push(Math.hypot(orb.x - ow.player.x, orb.y - ow.player.y));
  }
}
const rMax = Math.max.apply(null, radii);
const rMin = Math.min.apply(null, radii);
expect('环绕物半径不是死圆', radii.length > 20 && rMax - rMin > 3,
  '半径浮动 ' + (rMax - rMin).toFixed(2) + 'px');
expect('★半径呼吸不越界（不改变清怪范围）', rMax - rMin < 14,
  '半径浮动 ' + (rMax - rMin).toFixed(2) + 'px');

// ---------------- 4. 协议白名单没被撑大 ----------------
console.log('\n[4] 二进制快照协议');
const proto = fs.readFileSync(path.join(__dirname, '..', 'shared', 'proto_bin.js'), 'utf8');
const start = proto.indexOf('projs: [');
const end = proto.indexOf('],', start);
const block = proto.slice(start, end);
const names = [];
const re = /n:\s*'([^']+)'/g;
let m;
while ((m = re.exec(block)) !== null) names.push(m[1]);
const leaked = ['sway', 'swayHz', 'swayT', 'swayOff', 'curve'].filter(function (n) { return names.indexOf(n) >= 0; });
expect('★模拟层新字段一个都没进 projs 白名单', leaked.length === 0, leaked.join(',') || '无');
expect('projs 字段数仍是 11（带宽不变）', names.length === 11, '实际 ' + names.length + ' 个：' + names.join(','));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
