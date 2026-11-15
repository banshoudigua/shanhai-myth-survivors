// tools/stucktest.js —— 怪物被地形卡住的回归（第三十八轮）
//
// 【为什么要有这条】「怪卡在石头上」不会报错，只会让玩家觉得「这游戏 AI 坏了」。
// 之前的代码注释里写着「圆形障碍是凸的，两两相切不产生凹角，永远不会死胡同」——
// 这句话是错的：**单个圆是凸的，但两个圆之间的缝是凹的**。
// 实测 spire 图的石柱阵里，蝙蝠会卡在缝里 28 秒、位置一步不动（沙盒里量出来的）。
//
// 本脚本守三件事：
//   ① 口袋场景：把怪直接放进「两柱之间」的缝里，它必须能出来并追到玩家；
//   ② 全图扫：三张图各撒一批怪跑 30 秒，不允许出现「离玩家很远且 2.5 秒不动」的怪；
//   ③ ★反向验证：确认「卡住计时 / 相位兜底」这条路径**真的被跑到过**
//      （phaseAt 或 stuckSec 有值）。少了这条，①②全绿也可能只是「碰巧这批怪没卡」，
//      以后有人把兜底删了，测试照样绿。
//
// 用法：node tools/stucktest.js

const SIM = require('../shared/sim.js');
const C = require('../shared/const.js');

// ★怪 id 用真实表里的：写成 'ghost' / 'skeleton' 这种记忆里的名字会静默造不出怪，
//   而「造不出来」的测试照样能跑到绿（第一版就是：80 只里只有 27 只真正生成了）。
const MOB_IDS = ['corpse', 'bat', 'skeleton_warrior'];

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name + (detail ? '  -> ' + detail : '')); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

// 一只怪「卡住」的判据：活着、离玩家 > 150、连续 2.5 秒位移 < 0.4px
function scanStuck(w, track, secs) {
  const out = [];
  for (let i = 0; i < track.length; i++) {
    const t = track[i];
    if (!t.m.alive) continue;
    const dp = Math.hypot(t.m.x - w.player.x, t.m.y - w.player.y);
    if (t.still > 2.5 && dp > 150) {
      out.push({ id: t.m.def.id, x: Math.round(t.m.x), y: Math.round(t.m.y), dp: Math.round(dp), still: +t.still.toFixed(1) });
    }
  }
  return out;
}

function stepWorld(w, track, frames) {
  for (let s = 0; s < frames; s++) {
    SIM.step(w, 1 / C.TICK_HZ);
    // 单机升级会冻结世界 —— 不消化面板的话「所有怪都不动」，那是假卡住（踩过）
    if (w.self && w.self.state === 'levelup') SIM.chooseLevelUp(w, 0);
    for (let i = 0; i < track.length; i++) {
      const t = track[i];
      if (!t.m.alive) continue;
      const d = Math.hypot(t.m.x - t.lx, t.m.y - t.ly);
      t.lx = t.m.x;
      t.ly = t.m.y;
      if (d < 0.4) t.still += 1 / C.TICK_HZ;
      else t.still = 0;
    }
  }
}

// ============================================================
// 一、口袋场景：直接把怪塞进两柱之间的缝里
// ============================================================
// 坐标来自实测的「卡死点」：spire 图三根石柱 (2158,443)/(2200,485)/(2242,527)
// 形成一道斜墙，怪夹在 (2193,448) 这个缝里出不来。
(function pocket() {
  console.log('\n=== 一、口袋场景（spire 石柱缝）===');
  const w = SIM.createWorld({ charId: 'blade', mapId: 'spire', seed: 4242, spawnRadius: 900 });
  w.self = w.player;
  w.player.invuln = 1e9;
  // ★把武器清空：不清的话玩家会边测边把测的怪打死，「有没有追到」就没法量了
  w.player.weapons.length = 0;
  w.player.x = 2193;
  w.player.y = 1000;          // 玩家在墙的下方，逼怪必须绕过去
  w.player.px = w.player.x;
  w.player.py = w.player.y;
  lastX = w.player.x;

  const track = [];
  for (let i = 0; i < 6; i++) {
    const m = SIM.spawnMob(w, 'bat', 2193 + (i % 3) * 3, 448 + Math.floor(i / 3) * 3);
    if (m) track.push({ m: m, lx: m.x, ly: m.y, still: 0 });
  }
  ok('在口袋里造出了 6 只蝙蝠（造怪接口可用）', track.length === 6, track.length + ' 只');

  const before = track.map(function (t) { return Math.hypot(t.m.x - w.player.x, t.m.y - w.player.y); });
  stepWorld(w, track, 16 * C.TICK_HZ);
  const after = track.map(function (t) { return Math.hypot(t.m.x - w.player.x, t.m.y - w.player.y); });

  let escaped = 0;
  for (let i = 0; i < track.length; i++) {
    if (after[i] < before[i] - 250) escaped += 1;    // 至少逼近 250px = 真的绕过墙了（不是原地抖）
  }
  ok('★16 秒内所有蝙蝠都绕出了缝（每只至少逼近 250px）', escaped === track.length,
    escaped + '/' + track.length + '；起始距离 ' + Math.round(before[0]) + ' → ' + Math.round(after[0]));

  const phaseUsed = track.filter(function (t) { return (t.m.phaseAt || 0) > 0; }).length;
  const stuckUsed = track.filter(function (t) { return (t.m.stuckSec || 0) > 0; }).length;
  ok('★兜底路径真的被跑到过（不是碰巧没卡住）', phaseUsed > 0 || stuckUsed > 0,
    '触发相位 ' + phaseUsed + ' 只 / 记录到卡住 ' + stuckUsed + ' 只');
})();

// ============================================================
// 二、全图扫：三张图各撒 80 只，跑 30 秒
// ============================================================
(function sweep() {
  console.log('\n=== 二、全图扫（三张图，各 80 只，30 秒）===');
  const maps = ['graveyard', 'marsh', 'spire'];
  for (let k = 0; k < maps.length; k++) {
    const id = maps[k];
    const w = SIM.createWorld({ charId: 'blade', mapId: id, seed: 777, spawnRadius: 900 });
    w.self = w.player;
    w.player.invuln = 1e9;
    const track = [];
    for (let i = 0; i < 80; i++) {
      const m = SIM.spawnMob(w, MOB_IDS[i % 3],
        120 + ((i * 173) % (w.map.w - 240)), 120 + ((i * 293) % (w.map.h - 240)));
      if (m) track.push({ m: m, lx: m.x, ly: m.y, still: 0 });
    }
    ok('★' + id + '：80 只怪全部生成成功', track.length === 80, track.length + ' 只');
    stepWorld(w, track, 30 * C.TICK_HZ);
    const stuck = scanStuck(w, track);
    ok('★' + id + '：没有「离玩家很远却 2.5 秒不动」的怪', stuck.length === 0,
      stuck.length ? JSON.stringify(stuck.slice(0, 3)) : '0 只');
  }
})();

// ============================================================
// 三、别改坏追击：怪还得能追到玩家
// ============================================================
(function chase() {
  console.log('\n=== 三、追击没被改坏 ===');
  const w = SIM.createWorld({ charId: 'blade', mapId: 'spire', seed: 99, spawnRadius: 900 });
  w.self = w.player;
  w.player.invuln = 1e9;
  // 同上：清空武器，保证「怪有没有追到」量的是追击而不是射程
  w.player.weapons.length = 0;
  const track = [];
  for (let i = 0; i < 12; i++) {
    const ang = (Math.PI * 2 / 12) * i;
    const m = SIM.spawnMob(w, 'skeleton_warrior', w.player.x + Math.cos(ang) * 420, w.player.y + Math.sin(ang) * 420);
    if (m) track.push({ m: m, lx: m.x, ly: m.y, still: 0 });
  }
  // 20 秒：最远的那只要绕过一根柱子，12 秒里它一直在动（still=0.2）只是没走到，
  // 不能拿「12 秒必须到」当判据 —— 那测的是速度，不是「会不会卡住」。
  stepWorld(w, track, 20 * C.TICK_HZ);
  let near = 0;
  for (let i = 0; i < track.length; i++) {
    if (!track[i].m.alive) continue;
    if (Math.hypot(track[i].m.x - w.player.x, track[i].m.y - w.player.y) < 200) near += 1;
  }
  ok('★12 只怪从 420px 外出发，20 秒内全部来到 200px 内', near === track.length,
    near + '/' + track.length);
})();

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
