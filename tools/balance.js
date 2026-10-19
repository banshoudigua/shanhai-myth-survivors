// tools/balance.js —— 平衡探测器：用一个「会走位的玩家」把一局打出来
//
// 为什么需要它：
//   simtest.js 只能验「逻辑对不对」，验不出「好不好玩」。
//   实测发现满局（临时无敌）20 分钟只到 8 级、224 杀 —— 而升级经验累计到 Lv20 需要 1463，
//   说明武器成长完全跟不上怪物强度，普通玩家会在 1 分钟内被压死，20 分钟通关在数值上不可达。
//
// 这个脚本用一个「打不过就跑、有机会就捡」的简单 AI 代替真人，
// 每 30 秒打一份快照，输出等级 / 击杀 / 血量 / 同屏怪物 / 装备成长曲线，
// 用来判断成长速度是否跟得上难度曲线。
//
// 用法：
//   node tools/balance.js                       # 用当前 const.js 的数值跑默认场景
//   node tools/balance.js --runs 3              # 跑 3 个不同种子
//   node tools/balance.js --set WAVES.hpGrowth=0.08 --set EXP.step=6
//   node tools/balance.js --still                # 对照：站着不动的玩家
//
// --set 直接改内存里的数值表（不走文件），方便快速扫参数。

const C = require('../shared/const.js');
const SIM = require('../shared/sim.js');

// ============================================================
// 命令行参数
// ============================================================

const argv = process.argv.slice(2);
let runs = 1;
let still = false;
let quiet = false;
const overrides = [];

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--runs') runs = Number(argv[++i]) || 1;
  else if (argv[i] === '--still') still = true;
  else if (argv[i] === '--quiet') quiet = true;
  else if (argv[i] === '--set') overrides.push(argv[++i]);
}

// 把 "WAVES.hpGrowth=0.08" 写进内存里的数值表
// 支持数组下标，例如 "MOBS.0.dmg=3" 直接改腐尸的接触伤害
function applyOverrides(list) {
  const applied = [];
  for (let i = 0; i < list.length; i++) {
    const at = list[i].indexOf('=');
    const pathStr = list[i].slice(0, at);
    const value = Number(list[i].slice(at + 1));
    const parts = pathStr.split('.');

    // 值解析不出数字时直接报出来。
    // 踩过的坑：用 shell 变量拼参数一旦没被正确分词，整串会挤进一个 --set，
    // value 变成 NaN 后静默生效，量出来的数据全是假的。
    if (!isFinite(value)) {
      applied.push('!! ' + pathStr + ' 的值不是数字（收到 "' + list[i].slice(at + 1) + '"），已跳过');
      continue;
    }

    let obj = C;
    let ok = true;
    for (let j = 0; j < parts.length - 1; j++) {
      // 纯数字的段当作数组下标
      const key = /^\d+$/.test(parts[j]) ? Number(parts[j]) : parts[j];
      obj = obj ? obj[key] : undefined;
      if (obj === undefined || obj === null) { ok = false; break; }
    }
    if (!ok) { applied.push(pathStr + ' -> 路径不存在，跳过'); continue; }

    const key = /^\d+$/.test(parts[parts.length - 1])
      ? Number(parts[parts.length - 1])
      : parts[parts.length - 1];
    const old = obj[key];
    obj[key] = value;
    applied.push(pathStr + ': ' + old + ' -> ' + value);
  }
  return applied;
}

// ============================================================
// 走位 AI
// ============================================================
// 必须贴近真人的打法，否则量出来的数据没意义。
//
// 踩过的坑（两版都被淘汰）：
//   1) 只要 170px 内有怪就掉头跑 → 它永远背对怪群绕圈，270 秒只杀 56 个、等级 4。
//      因为经验球只能走过去捡（拾取半径才 40px），一直跑 = 不升级，量的不是我们想要的东西。
//   2) 只做「局部反向推」→ 不会挑空档，一被合围就原地挨打。真人会往缝里钻。
//
// 现在用 16 方向采样：对每个方向算「沿该方向走出去多远会撞上怪」，
// 再叠加「与目标方向的一致性」，取分最高的方向。这就是人挑空档的简化模型。
const SAMPLE_DIRS = 16;
const CLEAR_CAP = 300;      // 前方空旷程度的封顶值，避免只追求空旷而背离目标
const PICKUP_PULL = 430;    // 这个距离内的经验球都值得去捡
const HIT_BOX = 14;         // 侧向容差：投影偏离小于这个值才算「挡在路上」

function kitingInput(w) {
  const p = w.player;

  // 目标方向：最近的掉落物；没掉落物就回地图中心，别飘到荒地
  let ax = 0;
  let ay = 0;
  let bestD = PICKUP_PULL;
  for (let i = 0; i < w.pickups.length; i++) {
    const k = w.pickups[i];
    const dx = k.x - p.x;
    const dy = k.y - p.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < bestD && d > 1) {
      bestD = d;
      ax = dx / d;
      ay = dy / d;
    }
  }
  if (!ax && !ay) {
    const cx = C.MAP.width / 2 - p.x;
    const cy = C.MAP.height / 2 - p.y;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (d > 200) { ax = cx / d; ay = cy / d; }
  }

  // 预筛出附近值得考虑的怪，避免每次采样都遍历全场
  const near = [];
  const mobs = w.mobs;
  for (let i = 0; i < mobs.length; i++) {
    const m = mobs[i];
    if (m.alive === false) continue;
    const ox = m.x - p.x;
    const oy = m.y - p.y;
    if (ox * ox + oy * oy > 420 * 420) continue;
    near.push({ ox: ox, oy: oy, r: m.r });
  }

  // 四周无可躲之物：直接朝目标走
  if (!near.length) {
    if (!ax && !ay) return { mx: 0, my: 0 };
    return { mx: ax, my: ay };
  }

  // 16 方向采样
  let bestScore = -1e9;
  let bx = 0;
  let by = 0;
  for (let k = 0; k < SAMPLE_DIRS; k++) {
    const th = (Math.PI * 2 / SAMPLE_DIRS) * k;
    const dx = Math.cos(th);
    const dy = Math.sin(th);

    // 该方向上「会撞上怪」的最近距离
    let clearance = CLEAR_CAP;
    for (let i = 0; i < near.length; i++) {
      const m = near[i];
      const along = m.ox * dx + m.oy * dy;          // 沿采样方向的投影
      if (along <= 0) continue;                      // 在身后，走这个方向不会被它挡
      const perp = Math.abs(-m.ox * dy + m.oy * dx);  // 侧向偏移
      if (perp > m.r + p.r + HIT_BOX) continue;      // 不在路径上
      const hit = along - m.r - p.r;
      if (hit < clearance) clearance = hit;
    }

    // 与目标方向的一致性
    const align = ax * dx + ay * dy;
    const score = Math.min(Math.max(clearance, -60), CLEAR_CAP) + align * 150;
    if (score > bestScore) { bestScore = score; bx = dx; by = dy; }
  }

  let mx = bx;
  let my = by;
  if (!mx && !my) return { mx: 0, my: 0 };

  // 别贴着地图边被围死
  const M = C.MAP;
  const margin = 140;
  if (p.x < margin && mx < 0.15) mx = 1;
  if (p.x > M.width - margin && mx > -0.15) mx = -1;
  if (p.y < margin && my < 0.15) my = 1;
  if (p.y > M.height - margin && my > -0.15) my = -1;

  const l = Math.sqrt(mx * mx + my * my);
  if (l > 1) { mx /= l; my /= l; }
  return { mx: mx, my: my };
}

// ============================================================
// 升级选择策略
// ============================================================
// 进化 > 新武器（凑到 5 件）> 武器升级 > 新道具（凑到 4 件）> 道具升级
// 这个策略偏「先把武器铺开再拉等级」，是同类游戏的常见打法。

function pickIndex(choices, w) {
  const p = w.player;
  const order = ['evolve'];
  if (p.weapons.length < 5) order.push('weapon_new');
  order.push('weapon_up');
  if (p.passives.length < 4) order.push('passive_new');
  order.push('passive_up');

  for (let t = 0; t < order.length; t++) {
    for (let i = 0; i < choices.length; i++) {
      if (choices[i].type === order[t]) return i;
    }
  }
  return 0;
}

// ============================================================
// 打一局
// ============================================================

function gearText(w) {
  const p = w.player;
  const wep = p.weapons.map(function (x) {
    const d = C.WEAPON_MAP[x.id];
    return (d ? d.name : x.id) + 'L' + x.level;
  }).join('/') || '(无)';
  const pas = p.passives.map(function (x) {
    const d = C.PASSIVE_MAP[x.id];
    return (d ? d.name : x.id) + 'L' + x.level;
  }).join('/') || '(无)';
  return wep + '　道具：' + pas;
}

function runOne(seed, label) {
  const w = SIM.createWorld({
    charId: 'hunter',
    seed: seed,
    spawnRadius: 955          // 与浏览器实测时一致（1280x800 视口）
  });

  // 把「运行时真实生效」的关键数值打出来。
  // 这一步不能省：参数覆盖如果静默失败，量出来的数据会一模一样却看不出原因。
  if (!quiet) {
    console.log('  生效数值: 玩家HP=' + C.PLAYER.hp + ' 无敌帧=' + C.PLAYER.invulnSec +
      ' 拾取半径=' + C.PLAYER.pickupRadius +
      ' | 第1波=' + C.WAVES.baseCount + ' 每波增量=' + C.WAVES.countPerWave +
      ' 血量增长=' + C.WAVES.hpGrowth +
      ' | 武器伤害成长=' + C.GROWTH.dmg +
      ' | 腐尸伤害=' + C.MOBS[0].dmg + ' 血量=' + C.MOBS[0].hp +
      ' | 磁吸=' + C.DROPS.magnetAttractDist + ' 掉心=' + C.DROPS.heartChance);
  }

  const snaps = [];
  let lastSnapTick = -1;
  let peakMobs = 0;
  let peakFrame = 0;
  let steps = 0;
  const totalTicks = C.MATCH_SEC * C.TICK_HZ;

  while (w.state === 'playing' && w.tick < totalTicks) {
    SIM.step(w, still ? { mx: 0, my: 0 } : kitingInput(w));
    steps += 1;

    // 升级面板：可能一次攒了好几次，连着选完
    let guard = 0;
    while (w.state === 'levelup' && guard < 50) {
      const h = SIM.getHud(w);
      SIM.chooseLevelUp(w, pickIndex(h.choices, w));
      guard += 1;
    }

    // 每 30 秒打一份快照
    const snapAt = Math.floor(w.tick / (30 * C.TICK_HZ));
    if (snapAt > lastSnapTick) {
      lastSnapTick = snapAt;
      const h = SIM.getHud(w);
      if (h.mobCount > peakMobs) peakMobs = h.mobCount;
      if (w.mobs.length + w.projectiles.length > peakFrame) peakFrame = w.mobs.length + w.projectiles.length;
      snaps.push(h);
    }

    if (steps > 4000000) { console.log('!! 步数异常，强制中断'); break; }
  }

  const h = SIM.getHud(w);
  return {
    label: label,
    seed: seed,
    endState: w.state,                 // dead / won
    survivedSec: w.time,
    level: h.level,
    kills: h.stats ? h.stats.kills : w.stats.kills,
    killsW: w.stats.kills,
    dmg: Math.round(w.stats.dmgDealt),
    gold: w.stats.gold,
    hp: h.hp,
    wave: h.wave,
    peakMobs: peakMobs,
    peakFrame: peakFrame,
    gear: gearText(w),
    snaps: snaps
  };
}

// ============================================================
// 执行
// ============================================================

console.log('');
console.log('=== 平衡探测开始 ===');
console.log('  模式: ' + (still ? '站着不动（下限对照）' : '会走位（接近真人）'));
console.log('  局数: ' + runs);
if (quiet) console.log('  安静模式：只出一行摘要');

const applied = applyOverrides(overrides);
if (applied.length && !quiet) {
  console.log('  内存覆盖:');
  applied.forEach(function (a) { console.log('    ' + a); });
}
console.log('');

const seeds = [20260920, 777001, 3141592, 424242, 909090];
const results = [];
for (let i = 0; i < runs; i++) {
  const r = runOne(seeds[i % seeds.length], 'run' + (i + 1));
  results.push(r);

  if (quiet) {
    // 一行摘要：结局 / 存活 / 等级 / 击杀 / 峰值同屏 / 装备
    console.log('  种子' + r.seed + '  ' + r.endState + '  ' + r.survivedSec.toFixed(0) + 's' +
      '  Lv' + r.level + '  杀' + r.kills + '  峰值' + r.peakMobs + '  ' + r.gear);
    continue;
  }

  console.log('--- 第 ' + (i + 1) + ' 局（种子 ' + r.seed + '）---');
  console.log('  结局: ' + r.endState + '　存活 ' + r.survivedSec.toFixed(1) + ' 秒' +
    '　等级 ' + r.level + '　击杀 ' + r.kills + '　造成伤害 ' + r.dmg);
  console.log('  峰值同屏怪物 ' + r.peakMobs + '　峰值实体 ' + r.peakFrame + '　波次 ' + r.wave);
  console.log('  最终装备: ' + r.gear);
  console.log('');
  console.log('  时间轴（每 30 秒）:');
  console.log('    时刻   等级  击杀   血量    同屏  装备');
  for (let j = 0; j < r.snaps.length; j++) {
    const s = r.snaps[j];
    const t = ((j + 1) * 30) + 's';
    console.log('    ' + ('     ' + t).slice(-6) + '  ' +
      ('    ' + s.level).slice(-4) + '  ' +
      ('    ' + s.kills).slice(-5) + '  ' +
      ('      ' + s.hp).slice(-6) + '  ' +
      ('    ' + s.mobCount).slice(-5) + '  ' +
      s.weapons.map(function (x) { return x.name + 'L' + x.level; }).join('/'));
  }
  console.log('');
}

// 汇总
const avgSurv = results.reduce(function (a, r) { return a + r.survivedSec; }, 0) / results.length;
const avgLv = results.reduce(function (a, r) { return a + r.level; }, 0) / results.length;
const avgKill = results.reduce(function (a, r) { return a + r.kills; }, 0) / results.length;
const wins = results.filter(function (r) { return r.endState === 'won'; }).length;

console.log('=== 汇总 ===');
console.log('  平均存活 ' + avgSurv.toFixed(1) + ' 秒　平均等级 ' + avgLv.toFixed(1) +
  '　平均击杀 ' + Math.round(avgKill) + '　通关 ' + wins + '/' + results.length);

// 判定（用的是「会走位」模式下的期望，站着不动的对照组不参与判定）
if (!still) {
  let pass = 0;
  let fail = 0;
  function check(name, cond, detail) {
    if (cond) { pass++; if (!quiet) console.log('  PASS  ' + name); }
    else { fail++; if (!quiet) console.log('  FAIL  ' + name + '  ->  ' + detail); }
  }

  check('会走位的玩家至少能活 3 分钟', avgSurv >= 180,
    '平均存活 ' + avgSurv.toFixed(1) + ' 秒');
  check('成长曲线跟得上（平均等级 ≥ 10）', avgLv >= 10,
    '平均等级 ' + avgLv.toFixed(1));
  check('击杀量像样（平均 ≥ 400）', avgKill >= 400,
    '平均击杀 ' + Math.round(avgKill));
  check('20 分钟通关是可达的（有通关局）', wins > 0,
    '通关 ' + wins + ' 局');

  console.log('');
  console.log('  PASS = ' + pass + '   FAIL = ' + fail);
}
console.log('');
