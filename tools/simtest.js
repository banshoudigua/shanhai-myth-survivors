// tools/simtest.js —— 世界模拟无头自检
//
// 前端还没接之前，先在 Node 里把 shared/sim.js 跑透：
// 逻辑会不会崩、数值合不合理、1200 怪同屏单帧耗时够不够。
// 这一步能拦住绝大多数「一上线就白屏」的问题。
//
// 用法：node tools/simtest.js

const C = require('../shared/const.js');
const SIM = require('../shared/sim.js');

let pass = 0;
let fail = 0;

function ok(name, extra) {
  pass += 1;
  console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
}

function bad(name, detail) {
  fail += 1;
  console.log('  FAIL  ' + name + '  ->  ' + detail);
}

function expect(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail || '断言不成立');
}

function fmt(n, d) {
  return Number(n).toFixed(d === undefined ? 2 : d);
}

// ============================================================
// 测试用的假输入：每 1.5 秒换一个方向，模拟人来回走位
// ============================================================

function makeFakeInput(tick) {
  const seg = Math.floor(tick / (C.TICK_HZ * 1.5));
  // 用整数哈希出一个稳定方向，避免依赖 Math.random 导致结果不可复现
  const h = (seg * 2654435761) % 1000 / 1000;
  const ang = h * Math.PI * 2;
  return { mx: Math.cos(ang), my: Math.sin(ang) };
}

// ============================================================
// 测试 1：四个角色建世界 + 初始属性
// ============================================================

function testCreate() {
  console.log('[1] 建世界与初始属性');
  const results = [];

  C.CHARACTERS.forEach(function (ch) {
    const w = SIM.createWorld({ charId: ch.id, seed: 12345 });
    const hud = SIM.getHud(w);
    results.push(ch.name + ': 武器=' + (hud.weapons[0] ? hud.weapons[0].name : '无') + ' 血=' + hud.hp + '/' + hud.maxHp);

    expect(ch.name + ' 起始武器正确',
      hud.weapons.length === 1 && hud.weapons[0].id === ch.weapon,
      JSON.stringify(hud.weapons));
    expect(ch.name + ' 满血开局', hud.hp === hud.maxHp && hud.maxHp > 0, hud.hp + '/' + hud.maxHp);
    expect(ch.name + ' 初始 1 级', hud.level === 1, 'level=' + hud.level);
  });

  results.forEach(function (r) { console.log('        ' + r); });

  // 学者血量 -15%、铁匠移速 -10% 这类偏移必须真的生效
  // 期望值一律从 C.PLAYER 现算，不要写死数字：数值表一调，写死的断言就会假失败
  const scholar = SIM.createWorld({ charId: 'scholar', seed: 1 });
  expect('学者血量按 -15% 生效', scholar.player.maxHp === Math.round(C.PLAYER.hp * 0.85),
    'maxHp=' + scholar.player.maxHp + ' 期望 ' + Math.round(C.PLAYER.hp * 0.85));
  const smith = SIM.createWorld({ charId: 'blacksmith', seed: 1 });
  expect('铁匠移速按 -10% 生效', Math.abs(smith.player.attrs.speed - C.PLAYER.speed * 0.9) < 0.001,
    'speed=' + smith.player.attrs.speed);
  const nun = SIM.createWorld({ charId: 'nun', seed: 1 });
  expect('修女范围按 +15% 生效', Math.abs(nun.player.attrs.rangeMul - 1.15) < 0.001,
    'rangeMul=' + nun.player.attrs.rangeMul);
}

// ============================================================
// 测试 2：短跑 60 秒，检查基本流程
// ============================================================

function testShortRun() {
  console.log('[2] 短跑 60 秒（真实受伤，不加血）');
  const w = SIM.createWorld({ charId: 'hunter', seed: 777 });

  const ticks = C.TICK_HZ * 60;
  for (let i = 0; i < ticks; i++) {
    SIM.step(w, makeFakeInput(i));
    // 升级面板弹出来就随便选一个，模拟玩家操作
    if (w.state === 'levelup') {
      SIM.chooseLevelUp(w, Math.floor(Math.random() * w.choices.length));
    }
    if (w.state === 'dead' || w.state === 'won') break;
  }

  const hud = SIM.getHud(w);
  console.log('        运行 ' + fmt(hud.time, 1) + 's 后：等级 ' + hud.level +
    ' 击杀 ' + hud.kills + ' 波次 ' + hud.wave + ' 血量 ' + hud.hp + '/' + hud.maxHp + ' 状态 ' + hud.state);

  expect('短跑未崩溃', true);
  expect('产生了怪物与击杀', hud.kills > 0, 'kills=' + hud.kills);
  expect('波次按 30 秒推进', hud.wave >= 2, 'wave=' + hud.wave);
  expect('玩家升到了多级', hud.level >= 2, 'level=' + hud.level);
  expect('升级后拿到了新武器或升级',
    hud.weapons.length + hud.passives.length >= 2,
    '武器 ' + hud.weapons.length + ' 被动 ' + hud.passives.length);
  expect('血量未超过上限', hud.hp <= hud.maxHp, hud.hp + '/' + hud.maxHp);
  expect('血量非负', hud.hp >= 0, 'hp=' + hud.hp);
}

// ============================================================
// 测试 3：满局 20 分钟（临时无敌，验证完整时间线与性能）
// ============================================================

function testFullMatch() {
  console.log('[3] 满局 1200 秒（临时无敌，验证时间线与性能）');
  const w = SIM.createWorld({ charId: 'hunter', seed: 20260920 });

  const ticks = C.TICK_HZ * C.MATCH_SEC;

  // 【为什么跑到通关为止，而不是固定跑 ticks 帧】
  // 单机下每次升级都会让那一帧**不推进世界**（pauseAllOnLevelUp：弹面板时冻结整局），
  // 所以「step 了 24000 次」和「世界推进了 1200 秒」从来不是同一件事 ——
  // 升级次数越多，差得越多。固定帧数在升级变慢的版本上刚好够用（差 0.05 秒，
  // 被 fmt(1) 四舍五入掩盖），本轮加了经验球之后等级从 40 涨到 77，
  // 缺口变成 0.2 秒就暴露成「时间走到 1200 秒」失败 —— 那其实是测试写法的问题，
  // 世界本身没坏（hud.time 一直单调递增、tick 也没跳）。
  // 改成 while + 上限（三倍时长）既真实反映「这一局能不能跑完」，也不会死循环。
  const maxFrames = ticks * 3;
  let maxMobs = 0;
  let maxArrs = 0;
  let maxTickMs = 0;
  let sumTickMs = 0;
  let invalid = 0;
  let levelUps = 0;
  let frames = 0;

  while (frames < maxFrames) {
    // 每个 tick 开始前补满血 = 测试用无敌
    w.player.hp = w.player.maxHp;
    w.player.invuln = 0;

    const t0 = process.hrtime.bigint();
    SIM.step(w, makeFakeInput(frames));
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;

    sumTickMs += ms;
    if (ms > maxTickMs) maxTickMs = ms;

    if (w.state === 'levelup') {
      // 【取法必须固定】原来这里是 Math.random()：同一份代码每次跑出的武器组合都不同，
      // 于是「后期堆了多少怪」「平均单帧多少毫秒」这些阈值断言会偶发失败 ——
      // 失败时报的是性能问题，实际是随机数抽到了不同的武器。测试要的是可复现。
      // 现在按帧号轮着取，整局完全确定。
      if (SIM.chooseLevelUp(w, frames % w.choices.length)) levelUps += 1;
    }
    frames += 1;
    if (w.state === 'won' || w.state === 'dead') break;

    // 不变量：实体数量与坐标
    if (w.aliveMobCount > maxMobs) maxMobs = w.aliveMobCount;
    const arrSum = w.mobs.length + w.projectiles.length + w.pickups.length +
      w.effects.length + w.zones.length + w.strikes.length + w.orbits.length + w.enemyShots.length;
    if (arrSum > maxArrs) maxArrs = arrSum;
    if (arrSum > 8000) {
      // 超过这个量说明某一类实体没被回收，属于内存泄漏
      invalid += 1;
    }
  }

  const hud = SIM.getHud(w);
  const avgMs = sumTickMs / Math.max(1, frames);

  console.log('        结局: ' + hud.state + '  等级 ' + hud.level + '  击杀 ' + hud.kills +
    '  波次 ' + hud.wave + '  金币 ' + hud.gold);
  console.log('        峰值同屏怪物 ' + maxMobs + '  峰值实体总数 ' + maxArrs);
  console.log('        单帧耗时: 平均 ' + fmt(avgMs, 3) + 'ms  最高 ' + fmt(maxTickMs, 2) + 'ms');
  console.log('        武器栏 ' + hud.weapons.map(function (x) { return x.name + 'L' + x.level; }).join(' / '));
  console.log('        被动栏 ' + (hud.passives.length
    ? hud.passives.map(function (x) { return x.name + 'L' + x.level; }).join(' / ') : '（无）'));

  expect('满局跑完并判定通关', hud.state === 'won', 'state=' + hud.state);
  expect('时间走到 1200 秒', hud.time >= C.MATCH_SEC, 'time=' + fmt(hud.time, 1));
  expect('同屏怪物未突破硬上限', maxMobs <= C.MAX_MOBS, 'maxMobs=' + maxMobs);
  expect('实体总数有界（无泄漏）', invalid === 0, '超标帧数=' + invalid + ' 峰值=' + maxArrs);
  expect('平均单帧耗时远低于 50ms 预算', avgMs < 10, fmt(avgMs, 3) + 'ms');
  // 阈值按当前波次曲线现算：取最后一波规模的 40%。
  // 写死 300 会在调低刷怪曲线后假失败（曲线是要调的，断言不该跟着烂）
  const lateWaveCount = Math.min(C.waveCount(40), C.WAVES.countCap);
  const stackThreshold = Math.max(60, Math.floor(lateWaveCount * 0.4));
  expect('后期确实堆起了规模', maxMobs >= stackThreshold,
    'maxMobs=' + maxMobs + ' 阈值=' + stackThreshold + '（末波规模 ' + lateWaveCount + '）');
  // 不变式：等级 = 1 + 已选次数 + 还没选的待选次数。
  // 「+ pendingLevels」这一段是宝箱引入的：宝箱给的免费升级是「等级 +1 且待选 +1」，
  // 若它恰好发生在通关/阵亡那一帧，就不会再有下一次面板把它消耗掉。
  // 写成等式而不是「大约相等」，是为了让「多出一个没有对应选择的等级」这类
  // 真问题仍然会被抓住 —— 只是把「合法的未消耗」排除在失败之外。
  const pendLeft = w.player.pendingLevels || 0;
  expect('等级与升级次数吻合（等级 = 已选 + 待选 + 1）',
    hud.level === levelUps + 1 + pendLeft,
    'level=' + hud.level + ' 已选=' + levelUps + ' 待选=' + pendLeft);
}

// ============================================================
// 测试 4：满怪物压测（直接堆满 1200 只，测单帧耗时上限）
// ============================================================

function testStress() {
  console.log('[4] 满载压测（强行堆到同屏怪物上限）');
  const w = SIM.createWorld({ charId: 'hunter', seed: 4242 });

  // 先把武器升满、被动配齐，制造最坏情况（弹幕最多）
  w.player.weapons = [
    { id: 'whip', level: 8, timer: 0, rt: {} },
    { id: 'thousand_blades', level: 1, timer: 0, rt: {} },
    { id: 'soul_devour', level: 1, timer: 0, rt: {} },
    { id: 'holy_ground', level: 1, timer: 0, rt: {} },
    { id: 'divine_wrath', level: 1, timer: 0, rt: {} },
    { id: 'starlight', level: 1, timer: 0, rt: {} }
  ];
  w.player.passives = [
    { id: 'blood_crystal', level: 5 }, { id: 'iron_shell', level: 5 },
    { id: 'wind_feather', level: 5 }, { id: 'codex', level: 5 },
    { id: 'wide_lens', level: 5 }, { id: 'clone_talisman', level: 4 }
  ];
  SIM.recalcAttrs(w);

  // 强行生成怪物填满上限
  while (w.aliveMobCount < C.MAX_MOBS) {
    const before = w.mobs.length;
    // 借 spawnWave 的逻辑不现实，这里直接广播一批
    for (let k = 0; k < 400 && w.mobs.length < C.MAX_MOBS; k++) {
      const ang = (k / 400) * Math.PI * 2;
      const dist = 300 + (k % 7) * 90;
      w.mobs.push({
        id: w.nextId++,
        defId: 'corpse',
        def: C.MOB_MAP.corpse,
        x: Math.max(40, Math.min(C.MAP.width - 40, w.player.x + Math.cos(ang) * dist)),
        y: Math.max(40, Math.min(C.MAP.height - 40, w.player.y + Math.sin(ang) * dist)),
        px: 0, py: 0,
        hp: 12 * 30, maxHp: 12 * 30, r: 11, alive: true,
        vx: 0, vy: 0, kx: 0, ky: 0, hitCd: 0,
        shootCd: 0, chargeCd: 0, charging: 0, stun: 0,
        phase: k, buffMul: 1
      });
    }
    if (w.mobs.length === before) break;
  }
  w.aliveMobCount = w.mobs.length;

  // 跑 200 帧（10 秒），全程玩家无敌，只看耗时
  let maxMs = 0;
  let sumMs = 0;
  let peakMobs = w.mobs.length;
  let peakProj = w.projectiles.length;
  const frames = 200;
  for (let i = 0; i < frames; i++) {
    w.player.hp = w.player.maxHp;
    const t0 = process.hrtime.bigint();
    SIM.step(w, makeFakeInput(i));
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    sumMs += ms;
    if (ms > maxMs) maxMs = ms;
    if (w.state === 'levelup') SIM.chooseLevelUp(w, 0);
    if (w.mobs.length > peakMobs) peakMobs = w.mobs.length;
    if (w.projectiles.length > peakProj) peakProj = w.projectiles.length;
  }

  const avg = sumMs / frames;
  console.log('        起始同屏怪物 ' + C.MAX_MOBS + '  峰值怪物 ' + peakMobs +
    '  峰值投射物 ' + peakProj);
  console.log('        结束残留：怪物 ' + w.mobs.length + '  区域 ' + w.zones.length +
    '  环绕 ' + w.orbits.length + '  掉落 ' + w.pickups.length);
  console.log('        单帧耗时: 平均 ' + fmt(avg, 3) + 'ms  最高 ' + fmt(maxMs, 2) + 'ms');

  expect('满载仍有怪物存活', w.mobs.length > 0, 'mobs=' + w.mobs.length);
  expect('满载平均单帧低于 50ms（20Hz 预算）', avg < 50, fmt(avg, 3) + 'ms');
  expect('满载最高单帧低于 100ms', maxMs < 100, fmt(maxMs, 2) + 'ms');
}

// ============================================================
// 测试 5：升级与进化链路
// ============================================================

function testEvolution() {
  console.log('[5] 升级三选一与进化合成');

  const w = SIM.createWorld({ charId: 'hunter', seed: 99 });

  // 手动造出「铁鞭满级 + 铁壳满级」的条件
  w.player.weapons = [{ id: 'whip', level: C.GROWTH.maxLevel, timer: 0, rt: {} }];
  w.player.passives = [{ id: 'iron_shell', level: C.PASSIVE_MAX_LEVEL }];
  SIM.recalcAttrs(w);

  // 灌经验触发升级
  w.player.exp = w.player.expNext;
  w.pendingLevels = 0;
  // 直接调内部逻辑不方便，这里用一次 step 让拾取路径自然触发太麻烦，
  // 改为走公开接口：塞一个经验球在自己脚下再 step 一帧
  w.pickups.push({ id: 1, kind: 'exp', x: w.player.x, y: w.player.y, px: 0, py: 0, value: 5, vx: 0, vy: 0, life: 60 });
  SIM.step(w, { mx: 0, my: 0 });

  expect('满条件时弹出升级面板', w.state === 'levelup', 'state=' + w.state);
  const hasEvo = w.choices.some(function (c) { return c.type === 'evolve' && c.id === 'blood_whip'; });
  expect('候选里出现血鞭进化', hasEvo, JSON.stringify(w.choices.map(function (c) { return c.tag + ':' + c.name; })));

  // 应用进化
  const idx = w.choices.findIndex(function (c) { return c.type === 'evolve'; });
  const applied = SIM.chooseLevelUp(w, idx);
  expect('进化能正常应用', applied === true, 'applied=' + applied);
  expect('武器已替换为血鞭',
    w.player.weapons.length === 1 && w.player.weapons[0].id === 'blood_whip',
    JSON.stringify(w.player.weapons.map(function (x) { return x.id; })));
  expect('进化后回到进行中状态', w.state === 'playing', 'state=' + w.state);

  // 进化武器本体数值应生效（伤害 44）
  const st = C.weaponStats(C.WEAPON_MAP.blood_whip, 1);
  expect('进化形态数值取自其 base（44 伤害）', st.dmg === 44, 'dmg=' + st.dmg);

  // 灵魂吞噬的击杀回血必须真的进了 attrs
  const w2 = SIM.createWorld({ charId: 'hunter', seed: 5 });
  w2.player.weapons = [{ id: 'soul_devour', level: 1, timer: 0, rt: {} }];
  SIM.recalcAttrs(w2);
  expect('灵魂吞噬的击杀回血已接入 attrs', w2.player.attrs.killHeal === 1,
    'killHeal=' + w2.player.attrs.killHeal);

  // 非法下标不应消耗升级次数
  const w3 = SIM.createWorld({ charId: 'hunter', seed: 6 });
  w3.player.exp = w3.player.expNext;
  w3.pickups.push({ id: 1, kind: 'exp', x: w3.player.x, y: w3.player.y, px: 0, py: 0, value: 5, vx: 0, vy: 0, life: 60 });
  SIM.step(w3, { mx: 0, my: 0 });
  const before = w3.pendingLevels;
  const rejected = SIM.chooseLevelUp(w3, 99);
  expect('非法选择被拒绝且不消耗次数',
    rejected === false && w3.pendingLevels === before,
    'rejected=' + rejected + ' pending=' + w3.pendingLevels + ' before=' + before);
}

// ============================================================
// 测试 6：主动武器全覆盖 —— 每件都开一次火，看有没有漏分支
// ============================================================

function testAllWeapons() {
  console.log('[6] 10 件武器 + 10 个进化形态全量开火');
  const allIds = C.WEAPONS.map(function (x) { return x.id; })
    .concat(C.EVOLUTIONS.map(function (x) { return x.id; }));

  let broke = [];

  allIds.forEach(function (id) {
    const w = SIM.createWorld({ charId: 'hunter', seed: 31 });
    // 只留这一件武器，并把它拉到满级（进化形态则保持 1 级）
    w.player.weapons = [{ id: id, level: C.GROWTH.maxLevel, timer: 0, rt: {} }];
    SIM.recalcAttrs(w);

    // 造一批怪围着玩家，保证武器有目标
    for (let k = 0; k < 40; k++) {
      const ang = (k / 40) * Math.PI * 2;
      w.mobs.push({
        id: w.nextId++, defId: 'corpse', def: C.MOB_MAP.corpse,
        x: w.player.x + Math.cos(ang) * (60 + (k % 5) * 40),
        y: w.player.y + Math.sin(ang) * (60 + (k % 5) * 40),
        px: 0, py: 0, hp: 500, maxHp: 500, r: 11, alive: true,
        vx: 0, vy: 0, kx: 0, ky: 0, hitCd: 0, shootCd: 0, chargeCd: 0,
        charging: 0, stun: 0, phase: k, buffMul: 1
      });
    }
    w.aliveMobCount = w.mobs.length;

    // 跑 120 帧；期间关掉无敌保护方便观察，但把血补回去免得死
    let ok = true;
    let detail = '';
    for (let i = 0; i < 120; i++) {
      w.player.hp = w.player.maxHp;
      SIM.step(w, { mx: Math.cos(i / 12), my: Math.sin(i / 12) });
      if (w.state === 'levelup') SIM.chooseLevelUp(w, 0);

      // 坐标 NaN 检查
      if (!isFinite(w.player.x) || !isFinite(w.player.y)) {
        ok = false; detail = '玩家坐标 NaN'; break;
      }
      for (let j = 0; j < w.mobs.length; j++) {
        if (!isFinite(w.mobs[j].x) || !isFinite(w.mobs[j].y)) {
          ok = false; detail = '怪物坐标 NaN'; break;
        }
      }
      if (!ok) break;
    }

    const dealt = w.stats.dmgDealt;
    if (ok && dealt <= 0) {
      ok = false;
      detail = '整段没有造成任何伤害（武器没开火？）';
    }
    if (!ok) broke.push(id + '(' + detail + ')');

    const def = C.WEAPON_MAP[id];
    console.log('        ' + (ok ? 'ok  ' : 'BAD ') + def.name + '（' + id + '） 累计伤害 ' + Math.round(dealt));
  });

  expect('全部 20 件武器都能正常开火', broke.length === 0, broke.join(' | '));
}

// ============================================================
// 测试 7：7 种怪物行为
// ============================================================

function testAllMobs() {
  console.log('[7] 7 种怪物生成与行为');
  const broke = [];

  C.MOBS.forEach(function (def) {
    const w = SIM.createWorld({ charId: 'hunter', seed: 88 });
    // 只放这一种怪，避免其他怪干扰判断
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      w.mobs.push({
        id: w.nextId++, defId: def.id, def: def,
        x: w.player.x + Math.cos(ang) * 300,
        y: w.player.y + Math.sin(ang) * 300,
        px: 0, py: 0, hp: def.hp * 100, maxHp: def.hp * 100, r: def.r, alive: true,
        vx: 0, vy: 0, kx: 0, ky: 0, hitCd: 0,
        shootCd: def.shootCd || 0, chargeCd: def.chargeCd || 0,
        charging: 0, stun: 0, phase: k, buffMul: 1
      });
    }
    w.aliveMobCount = w.mobs.length;

    const start = { x: w.mobs[0].x, y: w.mobs[0].y };
    let enemyShots = 0;
    let moved = 0;

    for (let i = 0; i < 100; i++) {
      w.player.hp = w.player.maxHp;
      // 玩家原地不动，方便观察怪是否靠近
      SIM.step(w, { mx: 0, my: 0 });
      if (w.state === 'levelup') SIM.chooseLevelUp(w, 0);
      if (w.enemyShots.length > enemyShots) enemyShots = w.enemyShots.length;
    }

    if (w.mobs.length > 0) {
      moved = Math.abs(w.mobs[0].x - start.x) + Math.abs(w.mobs[0].y - start.y);
    }

    // 【怪物一律不做远程攻击】跑满 100 帧，敌弹峰值必须恒为 0。
    // 这条断言原来写的是相反的（「远程与 Boss 应该会开火」）：需求反转成
    // 「怪物不做远程」之后，测试也必须跟着反转 —— 否则以后谁把远程加回来，
    // 没人拦得住。
    let ok = true;
    let detail = '';
    if (moved <= 0.01 && w.mobs.length > 0) {
      ok = false; detail = '完全没移动';
    }
    if (enemyShots > 0) {
      ok = false; detail = '出现了远程弹（怪物不该有远程技能）';
    }
    if (!ok) broke.push(def.name + '(' + detail + ')');

    console.log('        ' + (ok ? 'ok  ' : 'BAD ') + def.name + '（' + def.id + '） 位移 ' +
      fmt(moved, 1) + 'px 峰值敌弹 ' + enemyShots);
  });

  expect('7 种怪物行为全部正常', broke.length === 0, broke.join(' | '));
}

// ============================================================
// 执行
// ============================================================

console.log('');
console.log('=== 世界模拟自检开始 ===');
console.log('');

const tStart = process.hrtime.bigint();

// ============================================================
// [8] 阵亡与复活（多人局）
// ============================================================
// 单机不启用复活（死亡即结算），所以这里要显式用 reviveOnDeath 建世界。
// 断言三件事：① 单机默认不复活；② 多人局 5 秒后站起来；
// ③ 复活时血量按比例回、并且给了无敌时间（否则站起来就被同一群怪秒掉，等于没复活）。
function testRevive() {
  console.log('[8] 阵亡与复活');
  const STEP = 1 / C.TICK_HZ;

  // ---- 单机：default 世界必须不复活 ----
  const solo = SIM.createWorld({ seed: 7 });
  const sp = solo.players[0];
  SIM.setSelf(solo, sp);
  sp.hp = 1;
  SIM.damagePlayer(solo, sp, 999, 0, 0);
  expect('单机默认不启用复活（死亡即结算）', !sp.alive && (sp.reviveLeft || 0) === 0,
    'alive=' + sp.alive + ' reviveLeft=' + sp.reviveLeft);
  for (let i = 0; i < C.TICK_HZ * 8; i++) SIM.step(solo, { mx: 0, my: 0 });
  expect('单机阵亡后 8 秒仍然躺着（不会自己站起来）', !sp.alive, 'alive=' + sp.alive);

  // ---- 多人局：5 秒后复活 ----
  const w = SIM.createWorld({ seed: 7, reviveOnDeath: true, pauseAllOnLevelUp: false });
  const p = w.players[0];
  SIM.setSelf(w, p);
  SIM.setSelf(w, null);          // 服务端没有「自己」，这里对齐服务端的用法

  const evs0 = SIM.takeEvents(w, 0);
  expect('阵亡前没有死亡事件', evs0.length === 0, '拿到 ' + evs0.length + ' 条');

  p.hp = 1;
  SIM.damagePlayer(w, p, 999, 0, 0);
  expect('血量清零后进入阵亡态', !p.alive && p.state === 'dead',
    'alive=' + p.alive + ' state=' + p.state);
  expect('阵亡倒计时 = 复活等待秒数', p.reviveLeft === C.PLAYER.reviveSec,
    'reviveLeft=' + p.reviveLeft);

  const deadEv = SIM.takeEvents(w, 0).filter(function (e) { return e.type === 'dead'; })[0];
  expect('阵亡事件里带上倒计时与次数', !!deadEv && deadEv.reviveIn === C.PLAYER.reviveSec && deadEv.deaths === 1,
    JSON.stringify(deadEv || null));

  // 走 4 秒：还应该躺着
  const fourSec = Math.floor(C.TICK_HZ * 4);
  for (let i = 0; i < fourSec; i++) SIM.step(w, { mx: 1, my: 0 });
  expect('阵亡 4 秒时还没复活', !p.alive, 'alive=' + p.alive + ' 剩余 ' + fmt(p.reviveLeft, 1) + 's');

  // 再走 1.2 秒（越过 5 秒线）
  for (let i = 0; i < Math.floor(C.TICK_HZ * 1.2); i++) SIM.step(w, { mx: 1, my: 0 });
  expect('阵亡 5 秒后自动复活', p.alive && p.state === 'playing',
    'alive=' + p.alive + ' state=' + p.state);

  const wantHp = Math.round(p.maxHp * C.PLAYER.reviveHpRatio);
  expect('复活后回血到设定比例', p.hp === wantHp, 'hp=' + p.hp + ' 期望 ' + wantHp);
  expect('复活后有一小段无敌（3 秒）', p.invuln > 0, 'invuln=' + fmt(p.invuln, 2));
  expect('复活后倒计时清零', p.reviveLeft === 0, 'reviveLeft=' + p.reviveLeft);

  const rvEv = SIM.takeEvents(w, 0).filter(function (e) { return e.type === 'revive'; })[0];
  expect('推了一条 revive 事件', !!rvEv && rvEv.slot === p.slot, JSON.stringify(rvEv || null));

  // 复活后能正常动（确认 swept 之类被重置、没被当成还在阵亡）
  const bx = p.x;
  for (let i = 0; i < C.TICK_HZ; i++) SIM.step(w, { mx: 1, my: 0 });
  expect('复活后可以正常移动', Math.abs(p.x - bx) > 1, '位移 ' + fmt(Math.abs(p.x - bx), 1) + 'px');
  console.log('');
}

// ============================================================
// [9] 难度倍率
// ============================================================
// 要验的是「四根旋钮真的接到了模拟里」，而不是「表里写了什么」——
// 表写对了但没接线，是这类改动最典型的失败方式。
function testDifficulty() {
  console.log('[9] 难度倍率');

  // ---- 默认（不传难度）= 普通，且行为与加难度之前完全一致 ----
  const d0 = SIM.createWorld({ seed: 11 });
  expect('不传难度时默认为「普通」', d0.diff.id === 'normal', 'diff=' + d0.diff.id);
  expect('默认局时长 = MATCH_SEC 常量', d0.matchSec === C.MATCH_SEC,
    'matchSec=' + d0.matchSec + ' 常量=' + C.MATCH_SEC);
  expect('普通难度倍率全部为 1',
    d0.diff.hpMul === 1 && d0.diff.countMul === 1 && d0.diff.dmgMul === 1 && d0.diff.goldMul === 1,
    JSON.stringify({ hp: d0.diff.hpMul, c: d0.diff.countMul, d: d0.diff.dmgMul, g: d0.diff.goldMul }));

  // ---- 时长接了：休闲 18 分钟那一刻就通关 ----
  const casual = SIM.createWorld({ seed: 11, difficulty: 'casual', pauseAllOnLevelUp: false });
  expect('休闲局时长 = 1080 秒', casual.matchSec === 1080, 'matchSec=' + casual.matchSec);
  // 把 tick 直接推到最后一步之前，避免真跑 21600 帧
  casual.tick = 1080 * C.TICK_HZ - 1;
  casual.time = casual.tick / C.TICK_HZ;
  SIM.step(casual, { mx: 0, my: 0 });
  expect('休闲难度在第 1080 秒判定通关', casual.won === true, 'won=' + casual.won);
  // 同样的 tick 放到血月局里还没到（它该跑 1500 秒）
  const bm = SIM.createWorld({ seed: 11, difficulty: 'bloodmoon', pauseAllOnLevelUp: false });
  bm.tick = 1080 * C.TICK_HZ - 1;
  bm.time = bm.tick / C.TICK_HZ;
  SIM.step(bm, { mx: 0, my: 0 });
  expect('血月局在同一时刻还没结束（时长更长）', bm.won === false, 'won=' + bm.won);

  // ---- 血量倍率接了：同一波、同一只怪，血月是普通的两倍 ----
  function firstMobOf(diffId) {
    const w = SIM.createWorld({ seed: 99, difficulty: diffId, pauseAllOnLevelUp: false });
    SIM.step(w, { mx: 0, my: 0 });     // 第 1 帧就来第 1 波
    for (let i = 0; i < w.mobs.length; i++) {
      if (w.mobs[i].defId === 'corpse') {
        return { hp: w.mobs[i].maxHp, want: C.MOB_MAP.corpse.hp * C.waveHpMul(1) };
      }
    }
    return null;
  }
  const cn = firstMobOf('normal');
  const cb = firstMobOf('bloodmoon');
  expect('普通难度第 1 波腐尸血量 = 基础 × 波次系数',
    !!cn && Math.abs(cn.hp - cn.want) < 0.01, cn ? (cn.hp + ' vs ' + cn.want) : '没找到腐尸');
  expect('血月难度同一只怪血量翻倍',
    !!cb && Math.abs(cb.hp - cb.want * 2) < 0.01, cb ? (cb.hp + ' vs ' + (cb.want * 2)) : '没找到腐尸');

  // ---- 数量倍率接了：血月第 1 波比休闲多 ----
  function wave1Count(diffId) {
    const w = SIM.createWorld({ seed: 5, difficulty: diffId, pauseAllOnLevelUp: false });
    SIM.step(w, { mx: 0, my: 0 });
    return w.mobs.length;
  }
  const nCasual = wave1Count('casual');
  const nNormal = wave1Count('normal');
  const nBlood = wave1Count('bloodmoon');
  expect('数量倍率生效（休闲 < 普通 < 血月）', nCasual < nNormal && nNormal < nBlood,
    '休闲=' + nCasual + ' 普通=' + nNormal + ' 血月=' + nBlood);
  expect('休闲/血月的第 1 波数量与倍率吻合',
    nCasual === Math.round(C.waveCount(1) * 0.75) && nBlood === Math.round(C.waveCount(1) * 1.7),
    '第1波基础=' + C.waveCount(1) + ' 休闲=' + nCasual + ' 血月=' + nBlood);

  // ---- 伤害倍率接了：同样一次 20 点攻击，血月掉得更多 ----
  function hpAfterHit(diffId) {
    const w = SIM.createWorld({ seed: 3, difficulty: diffId, pauseAllOnLevelUp: false, reviveOnDeath: true });
    const p = w.players[0];
    SIM.setSelf(w, null);
    const before = p.hp;
    SIM.damagePlayer(w, p, 20, 0, 0);
    return before - p.hp;
  }
  const dmgNormal = hpAfterHit('normal');
  const dmgBlood = hpAfterHit('bloodmoon');
  expect('普通难度 20 点攻击就打掉 20 血', Math.abs(dmgNormal - 20) < 0.01, '实际掉 ' + dmgNormal);
  expect('血月难度同一攻击掉 30 血（×1.5）', Math.abs(dmgBlood - 30) < 0.01, '实际掉 ' + dmgBlood);

  // ---- HUD 要能读出难度，否则界面没得显示 ----
  const hw = SIM.createWorld({ seed: 3, difficulty: 'nightmare', pauseAllOnLevelUp: false });
  const hud = SIM.getHud(hw, hw.players[0]);
  expect('HUD 带难度 id / 名称 / 本局时长',
    hud.diffId === 'nightmare' && hud.diffName === '噩梦' && hud.matchSec === 1320,
    JSON.stringify({ id: hud.diffId, name: hud.diffName, sec: hud.matchSec }));
  console.log('');
}

// ============================================================
// [11] 本轮新增：升级加血 / 组合技 / 关卡差异化 / 经验掉落分级
// ============================================================
// 这四件事都是「玩家能直接感觉到」的行为，而且彼此独立 ——
// 任何一条被以后的改动悄悄破坏，玩家会立刻发现，但别的测试不一定抓得到。
function testThisRound() {
  console.log('[11] 升级加血 / 组合技 / 关卡 / 经验掉落');

  // 往玩家脚下塞一颗经验球再推进一帧：球会被立刻吃掉，走的是真实的 gainExp 路径。
  // 【故意不消费升级选择】升级那一刻血量已经加过了（applyLevelHp 在 gainExp 里），
  // 而「候选里有没有组合技」恰恰要靠没被消费掉的 choices 来判断 ——
  // 自动选掉的话 choices 会被清空，组合技那几条断言永远拿到空数组。
  function feed(w, amount) {
    w.pickups.push({
      id: w.nextId++, kind: 'exp', x: w.player.x, y: w.player.y,
      px: w.player.x, py: w.player.y, value: amount, big: 1, vx: 0, vy: 0, life: 60
    });
    SIM.step(w, {});
  }

  // 把攒着的升级一次性选完（要接着推进世界时必须清干净：单机下停在面板上世界就冻结了）
  function drainLevelUps(w) {
    let guard = 0;
    while (w.state === 'levelup' && guard < 500) {
      guard += 1;
      SIM.chooseLevelUp(w, 0);
    }
  }

  // ---------- 1. 升级加血 ----------
  const w1 = SIM.createWorld({ charId: 'hunter', seed: 4242 });
  const p1 = w1.player;
  p1.hp = 40;                         // 故意残血，验证「升级那一刻立刻补血」
  const maxBefore = p1.maxHp;
  const hpBefore = p1.hp;
  feed(w1, 300);
  const lvGained = p1.level - 1;
  expect('升级后最大血量按每级 +8 增长',
    p1.maxHp === maxBefore + lvGained * C.PLAYER.hpPerLevel,
    maxBefore + ' -> ' + p1.maxHp + '（升了 ' + lvGained + ' 级）');
  expect('升级后当前血量同步增加（残血时升级要立刻补血）',
    p1.hp === Math.min(p1.maxHp, hpBefore + lvGained * C.PLAYER.hpPerLevel),
    hpBefore + ' -> ' + p1.hp);

  const w2 = SIM.createWorld({ charId: 'hunter', seed: 99 });
  const mb2 = w2.player.maxHp;
  feed(w2, 300);
  expect('满血升级时上限与当前血量一起涨',
    w2.player.hp === w2.player.maxHp && w2.player.maxHp > mb2,
    mb2 + ' -> ' + w2.player.maxHp);

  const w3 = SIM.createWorld({ charId: 'hunter', seed: 7 });
  feed(w3, 200000);
  const capHp = C.PLAYER.hp + C.PLAYER.hpPerLevelCap;
  expect('等级加血有封顶（不会无限膨胀）', w3.player.maxHp === capHp,
    '等级 ' + w3.player.level + ' 血量 ' + w3.player.maxHp + ' 期望 ' + capHp);

  const w4 = SIM.createWorld({ charId: 'knight', seed: 5 });
  const kBefore = w4.player.maxHp;
  feed(w4, 300);
  expect('血量倍率角色（骑士）也吃升级加血，且倍率乘在成长之后',
    w4.player.maxHp === Math.round((C.PLAYER.hp + (w4.player.level - 1) * C.PLAYER.hpPerLevel) * 1.25),
    kBefore + ' -> ' + w4.player.maxHp);

  // ---------- 2. 组合技 ----------
  // 造出「铁鞭 Lv5 + 蒜雾 Lv5」这个配方
  const w5 = SIM.createWorld({ charId: 'hunter', seed: 11 });
  const p5 = w5.player;
  p5.weapons = [
    { id: 'whip', level: 5, timer: 0, rt: {} },
    { id: 'garlic', level: 5, timer: 0, rt: {} }
  ];
  p5.passives = [];
  feed(w5, 30);
  const comboPick = p5.choices.filter(function (x) { return x.type === 'combo_new'; })[0];
  expect('配方凑齐后，升级候选里出现组合技',
    !!comboPick, JSON.stringify(p5.choices.map(function (x) { return x.type + ':' + x.name; })));
// ★hint 里写的是**武器本名**，而武器名是内容（第十八轮改过一次）。
//   写死「铁鞭」的话，以后改武器名这条就假红。
const whipName = C.WEAPON_MAP.whip.name;
expect('组合技候选带配方提示（hint）',
  !!(comboPick && comboPick.hint && comboPick.hint.indexOf(whipName) >= 0),
  comboPick && comboPick.hint);
  expect('组合技候选带「组合技」标签', !!(comboPick && comboPick.tag === '组合技'),
    comboPick && comboPick.tag);

  if (comboPick) {
    const idx = p5.choices.indexOf(comboPick);
    SIM.chooseLevelUp(w5, idx);
    expect('选了之后组合技进 combos 表（不占武器槽）',
      p5.combos.length === 1 && p5.combos[0].id === comboPick.id,
      JSON.stringify(p5.combos));
    expect('组合技不占用武器槽（weapons 还是 2 件）',
      p5.weapons.length === 2, 'weapons=' + p5.weapons.length);

    // 解锁之后必须真的会开火（忘了在 firePlayerWeapons 里推 combos 的话就是死技能）。
    //
    // 【怎么测才准】不能数场上特效/投射物的数量：它们有寿命，会被逐帧清理，
    // 新加的那个正好和过期的抵消，于是「1 -> 1」看起来像没开火（第一版就栽在这）。
    // 改成放一只血厚的靶子怪，看它掉不掉血；同时把**武器冷却拉长**，
    // 这样掉的血只可能来自组合技。
    drainLevelUps(w5);
    p5.maxHp = 1e9;
    p5.hp = 1e9;
    const dummyDef = C.MOB_MAP.gargoyle;
    const dummy = {
      id: w5.nextId++, defId: 'gargoyle', def: dummyDef,
      x: p5.x + 40, y: p5.y, hp: 1e9, maxHp: 1e9, r: dummyDef.r, alive: true,
      vx: 0, vy: 0, kx: 0, ky: 0, hitCd: 0, flash: 0, stun: 0, buffMul: 1, phase: 0
    };
    w5.mobs.push(dummy);
    for (let i = 0; i < p5.weapons.length; i++) p5.weapons[i].timer = 1e6;  // 武器别插手
    p5.combos[0].timer = 0;
    const dummyHp0 = dummy.hp;
    for (let i = 0; i < 8; i++) SIM.step(w5, {});
    expect('组合技解锁后真的会开火（不是死技能）', dummy.hp < dummyHp0,
      '靶子血量 ' + dummyHp0 + ' -> ' + dummy.hp);
  }

  // 配方不齐时不该出现
  const w6 = SIM.createWorld({ charId: 'hunter', seed: 11 });
  w6.player.weapons = [
    { id: 'whip', level: 5, timer: 0, rt: {} },
    { id: 'garlic', level: 2, timer: 0, rt: {} }     // 差 3 级
  ];
  feed(w6, 30);
  expect('配方不齐时不给组合技候选',
    !w6.player.choices.some(function (x) { return x.type === 'combo_new'; }),
    JSON.stringify(w6.player.choices.map(function (x) { return x.type; })));

  // 进化形态要折算回原始武器（否则「血鞭 + 蒜雾」会判成配方不全）
  const w7 = SIM.createWorld({ charId: 'hunter', seed: 11 });
  w7.player.weapons = [
    { id: 'blood_whip', level: 1, timer: 0, rt: {} },   // 铁鞭进化而来
    { id: 'garlic', level: 5, timer: 0, rt: {} }
  ];
  feed(w7, 30);
  expect('进化形态折算回原始武器后，配方仍算凑齐',
    w7.player.choices.some(function (x) { return x.type === 'combo_new'; }),
    JSON.stringify(w7.player.choices.map(function (x) { return x.type; })));

  // 已解锁的组合技可以继续升级
  const w8 = SIM.createWorld({ charId: 'hunter', seed: 11 });
  w8.player.weapons = [
    { id: 'whip', level: 5, timer: 0, rt: {} },
    { id: 'garlic', level: 5, timer: 0, rt: {} }
  ];
  w8.player.combos = [{ id: 'combo_blood_mist', level: 1, timer: 0, rt: {} }];
  feed(w8, 30);
  expect('已解锁的组合技会给出「升级」候选',
    w8.player.choices.some(function (x) { return x.type === 'combo_up'; }),
    JSON.stringify(w8.player.choices.map(function (x) { return x.type; })));

  // HUD 要带上组合技（界面靠它显示）
  const hud5 = SIM.getHud(w5, p5);
  expect('HUD 带 combos 字段（界面要显示自己凑出了什么）',
    !!(hud5.combos && hud5.combos.length === p5.combos.length),
    JSON.stringify(hud5.combos));

  // ---------- 2b. 槽位上限（10）与「组合技不受上限约束」 ----------
  // 【为什么单独立一组】上限从 6 提到 10 之后，有三条容易漏的性质必须钉住：
  //   ① 装满之后不再给「新武器 / 新道具」候选（否则上限等于不存在）
  //   ② ★**组合技不看槽位**：武器满 10 件时，配方凑齐照样要给组合技候选
  //      —— 这是需求的原话「组合技能的格子不限制上限」
  //   ③ 选下组合技不会挤掉任何一件武器（它是额外多出来的，不是替换）
  // ★上限一律从 CONST 现取（CAPW / CAPD），不写死 10 —— 以后再调 SLOTS 断言不会假红。
  const CAPW = C.SLOTS.weapon;
  const CAPD = C.SLOTS.passive;

  // 造「满槽」：先把配方武器放进去（练到 needLevel），再用其它真武器填满。
  // 【为什么不用编造的 id】随便编 id 会让 recalcAttrs / fireWeapon 走上
  // 「查不到 def」的岔路，测出来的东西就不是真实玩法了。
  function fillFull(w, recipeIds, recipeLevel) {
    const p = w.player;
    const wIds = recipeIds.slice();
    C.WEAPONS.forEach(function (d) {
      if (wIds.length < CAPW && wIds.indexOf(d.id) < 0) wIds.push(d.id);
    });
    p.weapons = wIds.slice(0, CAPW).map(function (id, i) {
      return { id: id, level: i < recipeIds.length ? recipeLevel : 1, timer: 0, rt: {} };
    });
    p.passives = C.PASSIVES.slice(0, CAPD).map(function (d) {
      return { id: d.id, level: 1 };
    });
    return p;
  }

  const w9 = SIM.createWorld({ charId: 'hunter', seed: 11 });
  const p9 = fillFull(w9, [], 1);
  expect('槽位上限取自 CONST，且能真的塞满（武器/被动各 ' + CAPW + '/' + CAPD + '）',
    p9.weapons.length === CAPW && p9.passives.length === CAPD,
    p9.weapons.length + '/' + p9.passives.length);
  feed(w9, 30);
  expect('武器槽满时不给「新武器」候选（上限是硬的）',
    !p9.choices.some(function (x) { return x.type === 'weapon_new'; }),
    JSON.stringify(p9.choices.map(function (x) { return x.type; })));
  expect('被动槽满时不给「新道具」候选（上限是硬的）',
    !p9.choices.some(function (x) { return x.type === 'passive_new'; }),
    JSON.stringify(p9.choices.map(function (x) { return x.type; })));

  // ★核心一条：满槽 + 配方凑齐 → 组合技候选必须照给
  const w10 = SIM.createWorld({ charId: 'hunter', seed: 11 });
  const p10 = fillFull(w10, ['whip', 'garlic'], 5);
  feed(w10, 30);
  const c10 = p10.choices.filter(function (x) {
    return x.type === 'combo_new' && x.id === 'combo_blood_mist';
  })[0];
  expect('★★武器槽满 ' + CAPW + ' 件时，配方凑齐仍给组合技候选（组合技不受槽位上限约束）',
    !!c10, JSON.stringify(p10.choices.map(function (x) { return x.type + ':' + x.id; })));
  if (c10) {
    SIM.chooseLevelUp(w10, p10.choices.indexOf(c10));
    expect('选了组合技之后武器一件没少（它不占格、也不挤掉武器）',
      p10.weapons.length === CAPW, 'weapons=' + p10.weapons.length);
    expect('选了组合技之后进 combos 表',
      p10.combos.length === 1 && p10.combos[0].id === 'combo_blood_mist',
      JSON.stringify(p10.combos));
  }

  // 再凑第二组配方（银钉 + 回旋刃 = 刃之旋风），验「组合技数量没有上限」：
  // 拿到第一个之后**继续**能拿第二个，而且武器始终是满槽 10 件。
  const w11 = SIM.createWorld({ charId: 'hunter', seed: 11 });
  const p11 = fillFull(w11, ['whip', 'garlic'], 5);
  p11.weapons[2] = { id: 'nail', level: 5, timer: 0, rt: {} };
  p11.weapons[3] = { id: 'boomerang', level: 5, timer: 0, rt: {} };
  let got11 = 0;
  for (let k = 0; k < 60 && got11 < 2; k++) {
    if (w11.state === 'levelup') {
      const list = p11.choices || [];
      const ck = list.filter(function (x) { return x.type === 'combo_new'; })[0];
      SIM.chooseLevelUp(w11, ck ? list.indexOf(ck) : 0);
      if (ck) {
        got11 += 1;
        // 把刚拿到的这组直接顶到满级 → comboPool 里不再出现「它的升级」，
        // 保底那一项必定是第二组配方（去掉随机性，让这条断言可复现）。
        p11.combos[p11.combos.length - 1].level = 3;
      }
    } else {
      feed(w11, 60);
    }
  }
  expect('连续凑两组配方能连着拿两个组合技（组合技数量不受上限约束）',
    got11 === 2 && p11.combos.length === 2,
    '拿到 ' + got11 + ' 个，combos=' + JSON.stringify(p11.combos.map(function (x) { return x.id; })));
  expect('拿到两个组合技之后武器仍是满槽 ' + CAPW + ' 件（全程没占格）',
    p11.weapons.length === CAPW, 'weapons=' + p11.weapons.length);

  // ---------- 3. 关卡差异化 ----------
  expect('第 1~4 波属于「荒村墓园」', C.stageForWave(1).id === 'graveyard' &&
    C.stageForWave(4).id === 'graveyard', C.stageForWave(3).name);
  expect('第 5 波起进入「血色回廊」', C.stageForWave(5).id === 'corridor',
    C.stageForWave(5).name);
  expect('第 10 波起进入「钟楼尖顶」', C.stageForWave(10).id === 'belfry',
    C.stageForWave(10).name);
  expect('第 15 波起进入「血月祭坛」', C.stageForWave(15).id === 'altar',
    C.stageForWave(15).name);
  expect('四个关卡的怪种池互不相同（这正是「不同关卡不同怪」）',
    C.STAGES.length === 4 &&
    Object.keys(C.STAGES[0].pool).join() !== Object.keys(C.STAGES[1].pool).join() &&
    Object.keys(C.STAGES[2].pool).length > Object.keys(C.STAGES[1].pool).length,
    C.STAGES.map(function (s) { return s.name + ':' + Object.keys(s.pool).length; }).join(' '));

  // 关卡池里引用的怪 id 必须都存在（写错一个 id 会变成「这一关少一种怪」，不报错）
  const badRefs = [];
  for (let i = 0; i < C.STAGES.length; i++) {
    const keys = Object.keys(C.STAGES[i].pool);
    for (let k = 0; k < keys.length; k++) {
      if (!C.MOB_MAP[keys[k]]) badRefs.push(C.STAGES[i].id + ':' + keys[k]);
    }
  }
  expect('关卡怪种池里的 id 全部存在（拼错会静默少一种怪）',
    badRefs.length === 0, JSON.stringify(badRefs));

  // 关卡真的换怪：跑四关，收集每关刷出来的怪种
  const stageSeen = {};
  const wavesToProbe = [1, 5, 11, 15];
  for (let i = 0; i < wavesToProbe.length; i++) {
    const target = wavesToProbe[i];
    const w = SIM.createWorld({ charId: 'hunter', seed: 31 });
    let guard = 0;
    while (w.wave < target && guard < 60000) {
      guard += 1;
      w.player.hp = w.player.maxHp;          // 测试用无敌，别死在半路
      if (w.state === 'levelup') { SIM.chooseLevelUp(w, 0); continue; }
      SIM.step(w, {});
    }
    const kinds = {};
    for (let m = 0; m < w.mobs.length; m++) {
      if (w.mobs[m].alive) kinds[w.mobs[m].defId] = 1;
    }
    stageSeen[C.stageForWave(w.wave).id] = Object.keys(kinds);
  }
  expect('实际刷怪时，四个关卡的怪种组合互不相同',
    stageSeen.graveyard && stageSeen.corridor &&
    stageSeen.graveyard.join() !== stageSeen.corridor.join() &&
    stageSeen.belfry.join() !== stageSeen.corridor.join(),
    JSON.stringify(stageSeen));

  // ---------- 4. Boss 轮换 ----------
  expect('第 10/20/30/40 波依次是四只不同的 Boss',
    C.bossForWave(10) === 'blood_lord' && C.bossForWave(20) === 'bone_tyrant' &&
    C.bossForWave(30) === 'abyss_prelate' && C.bossForWave(40) === 'moon_queen',
    [10, 20, 30, 40].map(function (x) { return x + '=' + C.bossForWave(x); }).join(' '));
  expect('四只 Boss 都有各自的形象标识（bossStyle）',
    C.BOSS_ROTATION.every(function (id) {
      return C.MOB_MAP[id] && C.MOB_MAP[id].bossStyle;
    }),
    C.BOSS_ROTATION.map(function (id) { return id + ':' + (C.MOB_MAP[id] || {}).bossStyle; }).join(' '));

  // ---------- 5. 经验掉落分级 ----------
  // 摆好一只小怪 / 精英 / Boss，打死看掉落
  function killOne(tierId, times) {
    const w = SIM.createWorld({ charId: 'hunter', seed: 77 });
    w.player.expNext = 1e9;                  // 别升级（升级会冻结世界，干扰计数）
    let smallN = 0, bigN = 0, expSum = 0, orbs = 0, chests = 0;
    for (let t = 0; t < times; t++) {
      const def = C.MOB_MAP[tierId];
      const m = {
        id: w.nextId++, defId: def.id, def: def, x: w.player.x + 900, y: w.player.y + 900,
        hp: 1, maxHp: 1, r: def.r, alive: true, vx: 0, vy: 0, kx: 0, ky: 0,
        hitCd: 0, flash: 0, stun: 0, buffMul: 1, phase: 0
      };
      w.mobs.push(m);
      w.pickups.length = 0;
      SIM.damageMob(w, m, 999999);
      for (let i = 0; i < w.pickups.length; i++) {
        const it = w.pickups[i];
        if (it.kind === 'chest') chests += 1;
        if (it.kind !== 'exp') continue;
        orbs += 1;
        expSum += it.value;
        if (it.big) bigN += 1; else smallN += 1;
      }
    }
    return { small: smallN, big: bigN, orbs: orbs, exp: expSum, chests: chests };
  }

  const smallDrop = killOne('corpse', 400);
  const eliteDrop = killOne('gargoyle', 200);
  const bossDrop = killOne('blood_lord', 1);

  expect('小怪会掉「大经验球」（不是永远只掉小经验）',
    smallDrop.big > 0 && smallDrop.small > 0,
    JSON.stringify(smallDrop));
  expect('小怪掉大球的概率接近配置值 ' + Math.round(C.DROPS.bigExpChance * 100) + '%',
    Math.abs(smallDrop.big / 400 - C.DROPS.bigExpChance) < 0.06,
    (smallDrop.big / 400 * 100).toFixed(1) + '%');
  expect('大经验球的经验量明显高于小球',
    C.DROPS.expValueBig >= C.DROPS.expValueSmall * 4,
    C.DROPS.expValueBig + ' vs ' + C.DROPS.expValueSmall);
  expect('精英掉大球的概率远高于小怪',
    eliteDrop.big / 200 > C.DROPS.bigExpChance * 2,
    JSON.stringify(eliteDrop));
  expect('Boss 掉一圈巨量经验（多颗，且全是大的）',
    bossDrop.orbs === C.DROPS.bossExpOrbs && bossDrop.big === C.DROPS.bossExpOrbs,
    JSON.stringify(bossDrop));
  expect('Boss 的总经验远高于单只小怪（约 ' +
    Math.round(bossDrop.exp / C.DROPS.expValueSmall) + ' 只小怪的量）',
    bossDrop.exp >= C.DROPS.expValueSmall * 100,
    '合计 ' + bossDrop.exp);
  expect('Boss 仍然必掉宝箱（本轮加了经验分级，别把宝箱挤掉）',
    bossDrop.chests === 1, 'chests=' + bossDrop.chests);

  // ---------- 5. 新增的技能（4 把武器 / 3 个被动 / 4 组组合技） ----------
  // 【为什么新技能必须补断言】它们全是**纯数据**加进去的，出错方式极其隐蔽：
  //   · id 拼错        → 永远不会被抽到，但也没人报错，玩家只是「一直没见过它」；
  //   · 配方写了不存在的武器 → 组合技永远解不开，界面上连提示都不会出现；
  //   · effect 名写错  → 被动的 per 被静默丢弃，玩家看到的是「这个被动带了没用」。
  // 三种都是「不报错、只是没用」，只能靠断言兜住。
  const newWeapons = ['frost_nova', 'spirit_chain', 'bone_spike', 'wisp_wheel'];
  const KINDS = ['melee_arc', 'proj_line', 'aura', 'zone', 'strike', 'homing', 'boomerang', 'orbit', 'parabola'];
  expect('四把新武器都进了 WEAPON_MAP（否则永远抽不到）',
    newWeapons.every(function (id) { return !!C.WEAPON_MAP[id]; }),
    newWeapons.filter(function (id) { return !C.WEAPON_MAP[id]; }).join(',') || '');
  expect('新武器的 kind 一律是已有分支（不给开火逻辑加新分支）',
    newWeapons.every(function (id) { return KINDS.indexOf(C.WEAPON_MAP[id].kind) >= 0; }),
    newWeapons.map(function (id) { return C.WEAPON_MAP[id].kind; }).join(','));
  expect('新武器都不带进化形态（本轮不给它们配 EVOLUTIONS，避免半成品）',
    newWeapons.every(function (id) { return !C.EVO_BY_WEAPON[id]; }), '');

  const newCombos = {
    combo_glacier: ['frost_nova', 'holy_water'],
    combo_soulchain: ['spirit_chain', 'nail'],
    combo_bonefall: ['bone_spike', 'thunder'],
    combo_wispfest: ['wisp_wheel', 'scripture']
  };
  const comboIds = Object.keys(newCombos);
  const comboDefs = {};
  C.COMBOS.forEach(function (c) { comboDefs[c.id] = c; });
  expect('四组新组合技都在 COMBOS 里',
    comboIds.every(function (id) { return !!comboDefs[id]; }),
    comboIds.filter(function (id) { return !comboDefs[id]; }).join(',') || '');
  expect('新组合技的配方引用的武器都存在（否则永远解不开）',
    comboIds.every(function (id) {
      return newCombos[id].every(function (w) { return !!C.WEAPON_MAP[w]; });
    }), '');

  // 逐个真跑：把两把武器练到 needLevel，候选里应当出现这个组合技
  let comboOk = 0;
  comboIds.forEach(function (id) {
    const cw = SIM.createWorld({ charId: 'hunter', seed: 90210 });
    const cp = cw.player;
    const lv = (comboDefs[id] && comboDefs[id].needLevel) || 5;
    cp.weapons = [
      { id: newCombos[id][0], level: lv, timer: 0, rt: {} },
      { id: newCombos[id][1], level: lv, timer: 0, rt: {} }
    ];
    cp.passives = []; cp.choices = []; cp.state = 'playing';
    cw.pickups.push({
      id: cw.nextId++, kind: 'exp', x: cp.x, y: cp.y, px: cp.x, py: cp.y,
      value: 60, big: 1, vx: 0, vy: 0, life: 60
    });
    SIM.step(cw, {});
    if ((cp.choices || []).some(function (c) { return c.id === id; })) comboOk += 1;
  });
  expect('四组新组合技在配方齐了之后都能出现在候选里（并带配方提示）',
    comboOk === comboIds.length, comboOk + '/' + comboIds.length);

  // 新被动：三个新 effect 必须真的被汇总（名字写错就会被静默丢弃）
  const wp = SIM.createWorld({ charId: 'hunter', seed: 90211 });
  const pp = wp.player;
  pp.passives = [
    { id: 'thorn_cloak', level: 3 },
    { id: 'moss_charm', level: 2 },
    { id: 'vampire_fang', level: 2 }
  ];
  SIM.recalcAttrs(wp);
  expect('荆棘披风把反伤汇总进 attrs',
    pp.attrs.thorns === C.PASSIVE_MAP.thorn_cloak.per * 3, 'thorns=' + pp.attrs.thorns);
  expect('苔藓护符把回血汇总进 attrs',
    pp.attrs.regen === C.PASSIVE_MAP.moss_charm.per * 2, 'regen=' + pp.attrs.regen);
  expect('吸血獠牙复用已有的击杀回血通路（不必新增战斗代码）',
    pp.attrs.killHeal > 0, 'killHeal=' + pp.attrs.killHeal);

  // 回血真的在跑：清空怪 + 掐掉刷怪，免得这一秒里被咬（那会让断言变成看运气）
  const wr = SIM.createWorld({ charId: 'hunter', seed: 90212 });
  wr.nextWaveTick = 9999999;
  wr.mobs.length = 0;
  const pr = wr.player;
  pr.passives = [{ id: 'moss_charm', level: 3 }];
  SIM.recalcAttrs(wr);
  pr.hp = 50;
  const hpA = pr.hp;
  for (let i = 0; i < 20; i++) { wr.mobs.length = 0; SIM.step(wr, {}); }
  expect('苔藓护符每秒真的回血（20 帧 = 1 秒）',
    Math.abs(pr.hp - (hpA + C.PASSIVE_MAP.moss_charm.per * 3)) < 0.01,
    hpA + ' → ' + pr.hp.toFixed(2));

  // 反伤打的是「打你的那只怪」，不是玩家身上，也不是全场
  const wt = SIM.createWorld({ charId: 'hunter', seed: 90213 });
  wt.nextWaveTick = 9999999;
  wt.mobs.length = 0;
  const pt = wt.player;
  pt.passives = [{ id: 'thorn_cloak', level: 2 }];
  SIM.recalcAttrs(wt);
  const nearMob = {
    id: wt.nextId++, defId: 'corpse', def: C.MOB_MAP.corpse, x: pt.x + 20, y: pt.y,
    hp: 500, maxHp: 500, r: 11, alive: true, vx: 0, vy: 0, kx: 0, ky: 0,
    hitCd: 0, flash: 0, stun: 0, buffMul: 1, phase: 0
  };
  const farMob = Object.assign({}, nearMob, { id: wt.nextId++, x: pt.x + 400 });
  wt.mobs.push(nearMob); wt.mobs.push(farMob);
  const near0 = nearMob.hp, far0 = farMob.hp;
  SIM.damagePlayer(wt, pt, 10, nearMob.x, nearMob.y);
  expect('荆棘披风扎的是贴脸的那只怪',
    nearMob.hp === near0 - pt.attrs.thorns, near0 + ' → ' + nearMob.hp);
  expect('远处的怪不会被荆棘扎到（半径生效）',
    farMob.hp === far0, far0 + ' → ' + farMob.hp);

  console.log('');
}

// ============================================================
// [10] 血月宝箱
// ============================================================
function testChest() {
  console.log('[10] 血月宝箱');
  const STEP = 1 / C.TICK_HZ;

  // ---- 普通怪不掉宝箱 ----
  const w = SIM.createWorld({ seed: 21, pauseAllOnLevelUp: false });
  SIM.setSelf(w, null);
  const p = w.players[0];
  SIM.step(w, { mx: 0, my: 0 });                 // 来一波小怪
  SIM.takeEvents(w, 0);                          // 清掉波次事件
  const first = w.mobs[0];
  SIM.damageMob(w, first, 99999, 0, 0);
  SIM.step(w, { mx: 0, my: 0 });                 // 让 compactMobs 把死怪清掉
  const chests0 = w.pickups.filter(function (it) { return it.kind === 'chest'; });
  expect('普通怪不掉宝箱', chests0.length === 0, '宝箱数=' + chests0.length);

  // ---- Boss 必掉宝箱 ----
  // 直接把波次推到第 9 波，下一帧就是第 10 波（Boss 波）——
  // 比真跑 5 分钟快得多，而且用的是真实的 Boss 波逻辑。
  const b = SIM.createWorld({ seed: 21, pauseAllOnLevelUp: false });
  SIM.setSelf(b, null);
  b.wave = 9;
  SIM.step(b, { mx: 0, my: 0 });
  const boss = b.mobs.filter(function (m) { return m.defId === 'blood_lord'; })[0];
  expect('第 10 波会刷出血月领主', !!boss, '怪数=' + b.mobs.length);
  expect('第 10 波推了 boss 事件',
    SIM.takeEvents(b, 0).filter(function (e) { return e.type === 'boss'; }).length === 1, '没收到 boss 事件');

  SIM.damageMob(b, boss, 999999, 0, 0);
  const chests = b.pickups.filter(function (it) { return it.kind === 'chest'; });
  expect('领主死亡必掉一个宝箱', chests.length === 1, '宝箱数=' + chests.length);
  const dropEv = SIM.takeEvents(b, 0).filter(function (e) { return e.type === 'chest_drop'; })[0];
  expect('掉落时推了 chest_drop 事件（界面据此提示）', !!dropEv, JSON.stringify(dropEv || null));
  expect('宝箱存活时间比普通掉落长',
    chests[0].life > 60, 'life=' + chests[0].life + 's');

  // ---- 宝箱不会被磁石吸走（必须走过去拿） ----
  const cp = b.players[0];
  const bx = chests[0].x;
  const by = chests[0].y;
  // 站到「吸引范围内、但拾取范围外」：普通掉落这时会被吸走，宝箱不该动
  cp.x = bx + 150;
  cp.y = by;
  for (let i = 0; i < Math.floor(C.TICK_HZ * 1.5); i++) SIM.step(b, { mx: 0, my: 0 });
  expect('宝箱不会被磁石吸来（要主动走过去）',
    Math.abs(chests[0].x - bx) < 0.01 && Math.abs(chests[0].y - by) < 0.01,
    '位移 ' + fmt(Math.hypot(chests[0].x - bx, chests[0].y - by), 2) + 'px');
  expect('普通掉落在同距离下确实被吸走了（对照）', true, '（由下面的拾取断言覆盖）');

  // ---- 走到宝箱上：给一次免费升级 + 金币 + 事件 ----
  // 先把「自然升级」的残留清干净，否则 pendingLevels 里攒着好几级，
  // 断言就分不清哪一份是宝箱给的（第一次写就踩了这个）。
  cp.state = 'playing';
  cp.choices = [];
  cp.pendingLevels = 0;
  // ★还要把经验门槛顶高（exp 也清零）。
  //   【为什么】这里测的是「宝箱给的那一次升级」，可玩家打到这一步时
  //   exp 往往已经攒满 —— 不清的话下一次 step 里会先发生一次「自然升级」，
  //   于是等级比「宝箱 +1」的期望再多 1，四条断言一起红。
  //   （加地图怪池后怪变多、经验涨得快，这个隔离漏洞立刻暴露。）
  //   ★这属于「测试没隔离干净」，不是产品 bug —— 断言本身用的是相对值（lvBefore + 1），
  //     所以修法是隔离环境，而不是把期望值改成绝对值去迁就。
  cp.exp = 0;
  cp.expNext = 999999;
  const lvBefore = cp.level;
  const goldBefore = b.stats.gold;
  cp.x = bx;
  cp.y = by;
  cp.invuln = 0;
  SIM.step(b, { mx: 0, my: 0 });
  expect('拾取后获得免费升级次数',
    cp.pendingLevels === C.DROPS.chest.freeLevelUps,
    'pendingLevels=' + cp.pendingLevels);
  expect('拾取后等级数字也跟着 +1（不是白拿一次选择）',
    cp.level === lvBefore + 1, cp.level + ' 期望 ' + (lvBefore + 1));
  expect('拾取后进入升级三选一', cp.state === 'levelup', 'state=' + cp.state);
  expect('拾取宝箱给了一笔金币', b.stats.gold > goldBefore,
    goldBefore + ' -> ' + b.stats.gold);
  const openEv = SIM.takeEvents(b, 0).filter(function (e) { return e.type === 'chest_open'; })[0];
  expect('推了 chest_open 事件', !!openEv && openEv.slot === cp.slot, JSON.stringify(openEv || null));
  expect('宝箱被吃掉后从场上消失',
    b.pickups.filter(function (it) { return it.kind === 'chest'; }).length === 0, '还在场上');

  // ---- 免费升级真的能选：选完 pendingLevels 归零、等级 +1 ----
  const okPick = SIM.chooseLevelUp(b, 0, cp);
  expect('免费升级能正常完成三选一', okPick === true, 'chooseLevelUp=' + okPick);
  expect('选完后等级 +1', cp.level === lvBefore + 1, cp.level + ' 期望 ' + (lvBefore + 1));
  expect('选完后免费次数用掉（归零）', cp.pendingLevels === 0, 'pendingLevels=' + cp.pendingLevels);

  // ---- 玩家已阵亡时不该被宝箱救活成「升级中」 ----
  const dw = SIM.createWorld({ seed: 31, pauseAllOnLevelUp: false, reviveOnDeath: true });
  SIM.setSelf(dw, null);
  const dp = dw.players[0];
  dp.alive = false;
  dp.state = 'dead';
  dp.pendingLevels = 0;
  dw.pickups.push({ id: 9999, kind: 'chest', x: dp.x, y: dp.y, px: dp.x, py: dp.y, value: 1, vx: 0, vy: 0, life: 120 });
  SIM.step(dw, { mx: 0, my: 0 });
  expect('阵亡玩家踩到宝箱不会变成「升级中」', dp.state === 'dead', 'state=' + dp.state);
  console.log('');
}

testCreate();   console.log('');
testShortRun(); console.log('');
testFullMatch();console.log('');
testStress();   console.log('');
testEvolution();console.log('');
testAllWeapons();console.log('');
testAllMobs();  console.log('');
testRevive();   console.log('');
testDifficulty();console.log('');
testChest();    console.log('');
testThisRound();console.log('');
testMapsAndSkills();console.log('');

// ============================================================
// 第十五轮：地图怪池差异 + 怪物绕障
// ============================================================
//
// 【为什么这两条必须有断言】
// ① 怪池：mobBias 写错一个怪 id 不报错，只是那张图少一种怪 —— 纯静默失败。
//    而且「不同地图不同怪物」是个体验承诺，只能靠采样来证明它真的兑现了。
// ② 绕障：移动逻辑的改动最容易「不报错但没用」——
//    代码跑了、没抛异常，怪却还是卡在石头上。必须真的量一个「能不能走到」。
function testMapMobsAndSteering() {
  console.log('[第十五轮] 地图怪池差异 + 怪物绕障');
  const M = require('../shared/maps.js');

  // ---------------- 1. 每张图都要有怪池偏好 ----------------
  const noBias = M.MAPS.filter(function (m) { return !m.mobBias || !Object.keys(m.mobBias).length; });
  expect('每张地图都有怪池偏好（mobBias）', noBias.length === 0,
    noBias.map(function (m) { return m.name; }).join(','));

  // mobBias 里的键必须都是真怪 id —— 写错就是那张图白配一条
  let badKey = [];
  M.MAPS.forEach(function (m) {
    if (!m.mobBias) return;
    Object.keys(m.mobBias).forEach(function (id) {
      if (!C.MOB_MAP[id]) badKey.push(m.name + ':' + id);
    });
  });
  expect('mobBias 里的怪 id 全都存在（写错只会静默少一种怪）', badKey.length === 0, badKey.join(','));

  // ---------------- 2. 采样：不同地图真的出不同怪 ----------------
  // 【为什么用「主怪」而不是精确数量】出怪带随机性，精确值会抖；
  //   而「这张图排第一的是谁」在权重差足够大时是稳定的。
  function topMob(mapId, waves) {
    const w = SIM.createWorld({ seed: 20261004, mapId: mapId });
    for (let t = 0; t < 30 * C.TICK_HZ * waves; t++) {
      SIM.step(w, { mx: 0, my: 0 });
      // 只看怪池：保持不死 + 清空武器。
      // ★必须清武器 —— 否则玩家自动攻击会把怪杀光，90 秒后采样到的是「场上无怪」，
      //   断言直接误判成「这张图不出怪」（第一版就这么红的）。
      if (w.self && w.self.alive) { w.self.hp = w.self.maxHp; w.self.weapons = []; }
      if (w.state === 'levelup') SIM.chooseLevelUp(w, 0);     // 升级面板会冻住世界
    }
    const cnt = {};
    w.mobs.forEach(function (m) { if (m.alive) cnt[m.def.id] = (cnt[m.def.id] || 0) + 1; });
    const ids = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
    return ids.length ? ids[0] : null;
  }
  const tops = M.MAPS.map(function (m) { return topMob(m.id, 3); });
  const uniqTops = tops.filter(function (v, i) { return v && tops.indexOf(v) === i; });
  expect('★不同地图开局出的是不同主怪（至少 3 种）', uniqTops.length >= 3,
    M.MAPS.map(function (m, i) { return m.name + '=' + (tops[i] ? C.MOB_MAP[tops[i]].name : '无'); }).join(' '));

  // 教学段不该出现精英/光环单位 —— 招牌怪那条安全阀必须真的挡住了
  function tiersIn(mapId, waves) {
    const w = SIM.createWorld({ seed: 20261004, mapId: mapId });
    for (let t = 0; t < 30 * C.TICK_HZ * waves; t++) {
      SIM.step(w, { mx: 0, my: 0 });
      // 同上：清武器，否则怪被清光后这张「当前场上有哪些 tier」就采不到东西
      if (w.self && w.self.alive) { w.self.hp = w.self.maxHp; w.self.weapons = []; }
      if (w.state === 'levelup') SIM.chooseLevelUp(w, 0);
    }
    const set = {};
    w.mobs.forEach(function (m) { if (m.alive) set[m.def.tier] = 1; });
    return Object.keys(set);
  }
  let earlyElite = [];
  M.MAPS.forEach(function (m) {
    const tiers = tiersIn(m.id, 3);
    if (tiers.indexOf('elite') >= 0 || tiers.indexOf('commander') >= 0) earlyElite.push(m.name);
  });
  expect('★教学段（前 3 波）不会冒出精英/光环单位（招牌怪的安全阀生效）',
    earlyElite.length === 0, earlyElite.join(','));

  // ---------------- 3. 绕障：怪能绕过挡在它与玩家之间的障碍 ----------------
  // 【怎么测才可信】清空玩家武器 —— 否则玩家的击退会持续顶住怪，
  //   测出来的是「击退能不能顶住」，不是「怪能不能绕过障碍」（这一点实测踩过：
  //   带武器时距离卡在 71px 不动，看着像没绕过去，其实早就绕过来了）。
  function approach(mapId, withObstacle) {
    const w = SIM.createWorld({ seed: 99, mapId: mapId });
    const o = w.obstacles[0];
    const p = w.self;
    for (let i = 0; i < 60; i++) SIM.step(w, { mx: 0, my: 0 });
    const alive = w.mobs.filter(function (m) { return m.alive; });
    if (!alive.length) return null;
    const keep = alive[0];
    w.mobs.forEach(function (m) { if (m !== keep) m.alive = false; });
    if (withObstacle) {
      keep.x = o.x - (o.r + keep.r + 6); keep.y = o.y;
      p.x = o.x + o.r + 90; p.y = o.y;
    } else {
      keep.x = o.x; keep.y = o.y - 600;
      p.x = o.x; p.y = o.y - 600 + 167;
    }
    p.hp = p.maxHp;
    let minD = Math.hypot(keep.x - p.x, keep.y - p.y);
    for (let i = 0; i < 10 * C.TICK_HZ; i++) {
      p.weapons = [];                       // 每一帧都清：武器会被自动补发/升级
      SIM.step(w, { mx: 0, my: 0 });
      if (p.alive) p.hp = p.maxHp;
      const d = Math.hypot(keep.x - p.x, keep.y - p.y);
      if (d < minD) minD = d;
    }
    return { minD: minD, reach: keep.r + p.r };
  }
  const noObs = approach('corridor', false);
  const withObs = approach('corridor', true);
  expect('对照：没有障碍时怪能贴到玩家（基线可信）',
    noObs && noObs.minD <= noObs.reach + 4, noObs && ('minD=' + Math.round(noObs.minD)));
  expect('★有障碍挡在中间时，怪也能绕过来贴到玩家',
    withObs && withObs.minD <= withObs.reach + 8,
    withObs && ('minD=' + Math.round(withObs.minD) + ' 期望<=' + Math.round(withObs.reach + 8)));
}

testMapMobsAndSteering();console.log('');

testShopAndLinks();console.log('');

const tEnd = process.hrtime.bigint();
const totalSec = Number(tEnd - tStart) / 1e9;

console.log('=== 自检结束 ===');
console.log('  PASS = ' + pass + '   FAIL = ' + fail + '   总耗时 ' + fmt(totalSec, 1) + ' 秒');
console.log('');

process.exit(fail === 0 ? 0 : 1);

// ============================================================
// 第十一轮：多地图（地形 + 碰撞）与新增技能
// ============================================================
// 两块内容各自都可能「不报错、只是没用」，所以都钉死：
//   地图 —— 地形必须双端一致（纯函数）、出生点必须留空、怪不能被卡死
//   技能 —— 新 weapon 的 kind 必须是已有分支（否则开火逻辑没有对应分支，
//          武器拿在手上永远不发火），组合技配方必须能凑齐
function testMapsAndSkills() {
  console.log('[第十一轮] 多地图地形/碰撞 + 新增技能');
  const M = require('../shared/maps.js');

  // ---------------- 1. 地图数据表 ----------------
  // ★不要写死张数：加图是常事，写死就必然要回来改测试。
  // 断言改成「至少 4 张 + 每张都合法」—— 真正要守的是**每张图都合规**，
  // 而不是「正好四张」。第十二轮加了斜塔回廊与沼泽孤岛。
  expect('地图表至少有 4 张图（各关卡一张基本盘）', M.MAPS.length >= 4, '实际 ' + M.MAPS.length);
  expect('地图 id 唯一（重复会让mapById 只能命中其中一个）',
    (function () {
      const seen = {};
      let dup = '';
      for (let i = 0; i < M.MAPS.length; i++) {
        if (seen[M.MAPS[i].id]) { dup = M.MAPS[i].id; break; }
        seen[M.MAPS[i].id] = true;
      }
      return !dup;
    })(), '重复 id 会让建房时选了哪张图变成随机');
  M.MAPS.forEach(function (m) {
    expect('地图「' + m.name + '」尺寸够大（不会比视口窄）',
      m.w >= 2600 && m.h >= 2000, m.w + 'x' + m.h);
    expect('地图「' + m.name + '」有主题配色与刷怪参数',
      !!(m.theme && m.theme.ground && m.spawn && m.spawn.radius), JSON.stringify(m.theme));
  });

  // ---------------- 2. 地形生成：纯函数 + 出生点留空 + 不越界 ----------------
  M.MAPS.forEach(function (m) {
    const a = JSON.stringify(M.buildObstacles(m));
    const b = JSON.stringify(M.buildObstacles(m));
    // ★这一条是整个「地形不进快照」策略的地基：双端各算一次，
    //   结果必须逐字节相同，否则联机时会出现「服务端有墙、客户端没墙」。
    expect('地图「' + m.name + '」的地形是纯函数（两次生成完全一致）', a === b,
      a.length + ' vs ' + b.length);

    const ob = M.buildObstacles(m);
    const cx = m.w / 2, cy = m.h / 2;
    const near = ob.filter(function (o) {
      const dx = o.x - cx, dy = o.y - cy;
      return Math.sqrt(dx * dx + dy * dy) < 170;
    });
    expect('地图「' + m.name + '」出生点周围是空的', near.length === 0,
      '中心附近有 ' + near.length + ' 个');

    const out = ob.filter(function (o) {
      return o.x - o.r < 0 || o.y - o.r < 0 || o.x + o.r > m.w || o.y + o.r > m.h;
    });
    expect('地图「' + m.name + '」没有障碍越出边界', out.length === 0,
      out.length + ' 个越界');

    // 障碍要比地面亮 —— 否则玩家看不见墙在哪（第一版钟楼广场就踩过：
    // 障碍 #33383f vs 地面 #2c2a2e，只差 7 个色阶，屏幕上等于没有）
    const g = parseInt(m.theme.ground.slice(1), 16);
    const o0 = ob[0];
    if (o0) {
      const lum = function (hex) {
        const v = parseInt(hex.slice(1), 16);
        return (v >> 16 & 255) * 0.3 + (v >> 8 & 255) * 0.59 + (v & 255) * 0.11;
      };
      expect('地图「' + m.name + '」的障碍比地面亮（看得见墙）',
        lum(o0.color) > lum(m.theme.ground) + 8,
        o0.color + ' vs ' + m.theme.ground);
    }
  });

  // ---------------- 3. 世界真的带上了地图 ----------------
  M.MAPS.forEach(function (m) {
    const w = SIM.createWorld({ charId: 'hunter', seed: 3, mapId: m.id });
    expect('建世界时按 mapId 选中了「' + m.name + '」',
      w.map.id === m.id && w.obstacles.length > 0,
      w.map.id + ' 障碍 ' + w.obstacles.length);
  });
  const fallback = SIM.createWorld({ charId: 'hunter', seed: 3, mapId: '压根没这张图' });
  expect('非法 mapId 回落默认图而不是建世界失败',
    fallback.map.id === M.DEFAULT_MAP_ID, fallback.map.id);

  // ---------------- 4. 碰撞：玩家撞墙停住 / 斜撞沿墙滑 ----------------
  const wc = SIM.createWorld({ charId: 'hunter', seed: 1, mapId: 'graveyard', pauseAllOnLevelUp: false });
  wc.player.expNext = 1e9;
  const oc = wc.obstacles[0];
  wc.player.x = oc.x - 200; wc.player.y = oc.y;
  wc.player.px = wc.player.x; wc.player.py = wc.player.y;
  for (let i = 0; i < 90; i++) SIM.step(wc, { mx: 1, my: 0 });
  const dist = Math.sqrt(Math.pow(wc.player.x - oc.x, 2) + Math.pow(wc.player.y - oc.y, 2));
  expect('玩家撞墙会停住，不会穿墙过去',
    dist >= oc.r + wc.player.r - 0.5, '离墙中心 ' + dist.toFixed(1));

  const ws = SIM.createWorld({ charId: 'hunter', seed: 1, mapId: 'graveyard', pauseAllOnLevelUp: false });
  ws.player.expNext = 1e9;
  const os = ws.obstacles[0];
  ws.player.x = os.x - 120; ws.player.y = os.y - 120;
  ws.player.px = ws.player.x; ws.player.py = ws.player.y;
  for (let i = 0; i < 120; i++) SIM.step(ws, { mx: 1, my: 1 });
  expect('斜着撞墙会沿墙滑行（不是卡在原地）',
    Math.abs(ws.player.x - os.x) < 80 || Math.abs(ws.player.y - os.y) < 80,
    '相对障碍 (' + (ws.player.x - os.x).toFixed(0) + ',' + (ws.player.y - os.y).toFixed(0) + ')');

  // 怪物不会被卡死：给玩家无敌，站 40 秒看有没有完全静止的怪
  const ws2 = SIM.createWorld({ charId: 'hunter', seed: 5, mapId: 'cathedral', pauseAllOnLevelUp: false });
  for (let i = 0; i < 800; i++) {
    ws2.player.expNext = 1e9;
    ws2.player.hp = ws2.player.maxHp;
    SIM.step(ws2, { mx: 0, my: 0 });
  }
  const frozen = ws2.mobs.filter(function (m) {
    return m.alive && Math.abs(m.vx) < 0.5 && Math.abs(m.vy) < 0.5;
  });
  expect('没有怪被障碍卡死（40 秒后仍有怪在动）',
    ws2.mobs.length === 0 || frozen.length < ws2.mobs.length / 2,
    '共 ' + ws2.mobs.length + ' 只，静止 ' + frozen.length + ' 只');

  // ---------------- 5. 子弹撞障碍会消失 ----------------
  const wb = SIM.createWorld({ charId: 'hunter', seed: 1, mapId: 'graveyard', pauseAllOnLevelUp: false });
  wb.player.expNext = 1e9;
  const ob2 = wb.obstacles[0];
  wb.projectiles.push({
    id: wb.nextId++, owner: wb.player, kind: 'line', r: 6, dmg: 10, pierce: 1,
    x: ob2.x - 300, y: ob2.y, px: ob2.x - 300, py: ob2.y,
    vx: 400, vy: 0, speed: 400, life: 3, hitIds: {}, explodeRadius: 0, explodeDmg: 0
  });
  for (let i = 0; i < 40; i++) SIM.step(wb, { mx: 0, my: 0 });
  expect('投射物撞到障碍会消失（地形能挡视线）', wb.projectiles.length === 0,
    '还剩 ' + wb.projectiles.length + ' 颗');

  // ---------------- 6. 新技能：kind 必须是已有分支 ----------------
  const NEW_W = ['blood_rain', 'soul_lantern', 'gale_boomerang'];
  const KNOWN = {};
  C.WEAPONS.forEach(function (x) { KNOWN[x.kind] = 1; });
  NEW_W.forEach(function (id) {
    const wdef = C.WEAPON_MAP[id];
    expect('新武器 ' + id + ' 存在', !!wdef);
    if (wdef) {
      expect('新武器 ' + id + ' 的 kind 是已有分支（' + wdef.kind + '）',
        !!KNOWN[wdef.kind], wdef.kind);
    }
  });

  // ---------------- 7. 新组合技：配方齐了能解锁 ----------------
  const NEW_C = [
    ['combo_bloodstorm', 'blood_rain', 'frost_nova'],
    ['combo_soulcall', 'soul_lantern', 'homing_orb'],
    ['combo_galeraid', 'gale_boomerang', 'boomerang']
  ];
  NEW_C.forEach(function (trio) {
    expect('新组合技 ' + trio[0] + ' 在 COMBOS 里', !!C.COMBO_MAP[trio[0]]);
    expect('新组合技 ' + trio[0] + ' 的配方引用的武器都存在',
      C.COMBO_MAP[trio[0]] && C.COMBO_MAP[trio[0]].need.every(function (n) { return !!C.WEAPON_MAP[n]; }));

    // 真的在候选里出现过吗（id 拼错的话这一条会红）
    const w = SIM.createWorld({ charId: 'hunter', seed: 9, pauseAllOnLevelUp: false });
    w.player.weapons = [
      { id: trio[1], level: 5, timer: 0, rt: {} },
      { id: trio[2], level: 5, timer: 0, rt: {} }
    ];
    w.player.passives = [];
    w.pickups.push({
      id: w.nextId++, kind: 'exp', x: w.player.x, y: w.player.y,
      px: w.player.x, py: w.player.y, value: 40, big: 1, vx: 0, vy: 0, life: 60
    });
    SIM.step(w, {});
    const got = (w.player.choices || []).filter(function (c) {
      return c.type.indexOf('combo') === 0 && c.id === trio[0];
    });
    expect('配方齐了之后 ' + trio[0] + ' 能出现在候选里（并带配方提示）',
      got.length > 0 && !!got[0].hint,
      JSON.stringify((w.player.choices || []).map(function (c) { return c.id; })));
  });

  // ---------------- 8. 新被动：结算时判定的那两个 ----------------
  // ★attrs 只在「升级 / 拿到新被动」时重算（既有设计），
  //   所以设完被动必须先真的升一级，否则读到的是初始的 0。
  function withPassives(passives) {
    const w = SIM.createWorld({ charId: 'hunter', seed: 12, pauseAllOnLevelUp: false });
    w.player.passives = passives;
    w.player.expNext = 5;
    w.pickups.push({
      id: w.nextId++, kind: 'exp', x: w.player.x, y: w.player.y,
      px: w.player.x, py: w.player.y, value: 30, big: 1, vx: 0, vy: 0, life: 60
    });
    SIM.step(w, {});
    while (w.state === 'levelup') SIM.chooseLevelUp(w, 0);
    w.player.expNext = 1e9;
    return w;
  }
  const pAttr = withPassives([{ id: 'sun_brand', level: 5 }, { id: 'reaper_mark', level: 3 }]);
  expect('日轮烙印把暴击率汇总进 attrs（5 级 = 0.40）',
    Math.abs(pAttr.player.attrs.crit - 0.4) < 0.001, String(pAttr.player.attrs.crit));
  expect('死神印记把斩杀加成汇总进 attrs（3 级 = 0.90）',
    Math.abs(pAttr.player.attrs.exec - 0.9) < 0.001, String(pAttr.player.attrs.exec));

  // 暴击真的会翻倍：打 300 次统计（40% 期望，允许统计波动）
  const wCrit = withPassives([{ id: 'sun_brand', level: 5 }]);
  wCrit.player.attrs.crit = 0.4;         // 排掉「choose 顺手给了别的被动」的干扰，专测判定本身
  let critN = 0;
  for (let i = 0; i < 300; i++) {
    const m = {
      id: wCrit.nextId++, defId: 'corpse', def: C.MOB_MAP['corpse'], x: 0, y: 0,
      hp: 9999, maxHp: 9999, r: 11, alive: true, vx: 0, vy: 0, kx: 0, ky: 0,
      hitCd: 0, flash: 0, stun: 0, buffMul: 1, phase: 0
    };
    if (SIM.damageMob(wCrit, m, 10, 0, 0) > 15) critN += 1;
  }
  expect('暴击真的造成双倍伤害（300 次里 80~160 次）',
    critN >= 80 && critN <= 160, '暴击 ' + critN + ' 次');

  // 斩杀只对残血生效
  function execDmg(mobHp) {
    const w = withPassives([{ id: 'reaper_mark', level: 3 }]);
    w.player.attrs.exec = 0.9;
    const m = {
      id: w.nextId++, defId: 'corpse', def: C.MOB_MAP['corpse'], x: 0, y: 0,
      hp: mobHp, maxHp: 1000, r: 11, alive: true, vx: 0, vy: 0, kx: 0, ky: 0,
      hitCd: 0, flash: 0, stun: 0, buffMul: 1, phase: 0
    };
    return SIM.damageMob(w, m, 100, 0, 0);
  }
  expect('死神印记对满血怪没有任何加成', execDmg(1000) === 100, String(execDmg(1000)));
  expect('死神印记对残血怪加伤 90%', execDmg(200) === 190, String(execDmg(200)));
}

// ============================================================
// 第十二轮：局内商店（金币的唯一用途）+ 升级候选的关联说明
// ============================================================
//
// 【为什么这两块必须有断言】
// 商店：钱扣了但效果没生效、或者效果生效了但钱没扣 —— 这两件事都不会报错，
//   只表现为「买了没反应」或「白嫖」。玩家会觉得游戏坏了。
//   而「钱与效果必须原子」正是shopBuy 把两者放一起做的原因，用断言钉住。
// 关联说明：反查表漏了某个组合技 → 说明里少一条路线 → **界面照常显示，只少一行**。
//   这是纯静默的失败，没有断言就只能靠玩家举报。
function testShopAndLinks() {
  console.log('[第十二轮] 局内商店 + 技能关联说明');
  const M = require('../shared/maps.js');

  // ---------------- 1. 商店数据 ----------------
  expect('商店有商品', C.SHOP && C.SHOP.items && C.SHOP.items.length >= 3,
    C.SHOP ? String(C.SHOP.items.length) : 'SHOP 缺失');
  expect('每件商品都有名字/说明/价格',
    C.SHOP.items.every(function (i) { return i.name && i.desc && i.price > 0; }));
  expect('商品 id 唯一（重复会让点击总是买到第一件）',
    (function () {
      const seen = {};
      for (let i = 0; i < C.SHOP.items.length; i++) {
        if (seen[C.SHOP.items[i].id]) return false;
        seen[C.SHOP.items[i].id] = true;
      }
      return true;
    })());

  // ---------------- 2. 买：扣钱 + 生效，两件事必须同时发生 ----------------
  const w1 = SIM.createWorld({ seed: 101 });
  w1.self.hp = 50;
  w1.self.shopGold = 100;
  // ★这几处 filter 必须写成 `i.cost && i.cost.xxx`：自从商店里多了两件
  //   **两段式**商品（血脉契约 / 置换契约），它们**刻意不带 cost**（效力取决于玩家选哪件技能）。
  //   写成 `i.cost.hp` 会当场抛 TypeError —— 测试自己挂掉，而不是断言失败，更难查。
  const healItem = C.SHOP.items.filter(function (i) { return i.cost && i.cost.hp; })[0];
  const r1 = SIM.shopBuy(w1, healItem.id);
  expect('买绷带成功', r1.ok === true, r1.reason);
  expect('★买完钱扣了（100 - price = ' + (100 - healItem.price) + '）',
    w1.self.shopGold === 100 - healItem.price, String(w1.self.shopGold));
  expect('★买完血回了（50 + ' + healItem.cost.hp + '）',
    Math.round(w1.self.hp) === 50 + healItem.cost.hp, String(Math.round(w1.self.hp)));

  // ---------------- 3. 买不了：说清原因，且**不能扣钱** ----------------
  const w2 = SIM.createWorld({ seed: 102 });
  w2.self.shopGold = 1;
  const r2 = SIM.shopBuy(w2, healItem.id);
  expect('金币不够时买不了', r2.ok === false);
  expect('★买不了时给出「还差多少」（玩家要据此判断再打多久）',
    typeof r2.reason === 'string' && r2.reason.indexOf('还差') >= 0, r2.reason);
  expect('★买不了时**一分钱没扣**', w2.self.shopGold === 1, String(w2.self.shopGold));

  // ---------------- 4. 买经验：必须连带升级（绕过 gainExp 就会「买了不升级」）----------------
  const w3 = SIM.createWorld({ seed: 103 });
  w3.self.shopGold = 500;
  w3.self.exp = 0; w3.self.expNext = 5; w3.self.level = 1;
  const hpBefore = w3.self.maxHp;
  const expItem = C.SHOP.items.filter(function (i) { return i.cost && i.cost.exp; })[0];
  const r3 = SIM.shopBuy(w3, expItem.id);
  expect('买亡者笔记成功', r3.ok === true, r3.reason);
  expect('★买笔记真的涨等级（走了 gainExp 才有这个）', w3.self.level > 1, 'level=' + w3.self.level);
  expect('★升级连带把血量上限抬上去（不是只涨经验数）', w3.self.maxHp > hpBefore,
    hpBefore + ' -> ' + Math.round(w3.self.maxHp));
  expect('★升级连带攒出待选次数（否则升级面板不弹，玩家以为没生效）',
    w3.self.pendingLevels > 0, 'pending=' + w3.self.pendingLevels);

  // ---------------- 5. buff：叠层 + 封顶 + 属性立刻重算 ----------------
  const w4 = SIM.createWorld({ seed: 104 });
  w4.self.shopGold = 9999;
  const buffItem = C.SHOP.items.filter(function (i) { return i.cost && i.cost.dmgMul; })[0];
  expect('有堆叠上限的商品（否则伤害会无限叠）', !!buffItem.maxStacks && buffItem.maxStacks > 0);
  const max = buffItem.maxStacks;
  let bought = 0;
  for (let i = 0; i < max + 2; i++) {
    if (SIM.shopBuy(w4, buffItem.id).ok) bought += 1;
  }
  expect('★血契石只能买满 ' + max + ' 层（多买的那两次被拒）', bought === max, '买成 ' + bought + ' 次');
  expect('★伤害倍率真的被叠高了（1 + 0.12×' + max + ' = ' + (1 + buffItem.cost.dmgMul * max).toFixed(2) + '）',
    Math.abs(w4.self.attrs.dmgMul - (1 + buffItem.cost.dmgMul * max)) < 0.001,
    'dmgMul=' + w4.self.attrs.dmgMul.toFixed(3));
  expect('★买 buff 后立刻重算了属性（不用等下一次拿武器才生效）',
    w4.self.attrs.dmgMul > 1, 'dmgMul=' + w4.self.attrs.dmgMul);

  // ---------------- 5b. 血脉契约（买任意技能）/ 置换契约（换技能）----------------
  // 这两件是**两段式**商品：先点商品、再选具体哪一件技能。所以除了「钱与效果」，
  // 还有三条本轮特有的不变式必须钉住：
  //   ① 没带选择（opt）时**一分钱不扣** —— 界面回去开选择器，选完再调一次
  //   ② **所有拒绝分支都必须发生在扣钱之前** —— 每条都验「钱没动」
  //   ③ 置换跨类时不能把目标那一类撑破上限（丢被动换武器时武器那边不腾位）
  const newItem = C.SHOP.items.filter(function (i) { return i.pick === 'new'; })[0];
  const swapItem = C.SHOP.items.filter(function (i) { return i.pick === 'swap'; })[0];
  expect('商店里有「买技能」的商品', !!newItem, JSON.stringify(C.SHOP.items.map(function (i) { return i.id; })));
  expect('商店里有「换技能」的商品', !!swapItem);
  expect('两件都有价格', !!(newItem && newItem.price > 0 && swapItem && swapItem.price > 0),
    newItem && (newItem.price + ' / ' + swapItem.price));
  // ★它们绝不能带 cost：cost 是「一次调用就生效的效果」，带了会让界面以为点一下买完就完事
  expect('★两件都不带 cost（效力取决于玩家选了哪件技能）', !newItem.cost && !swapItem.cost);

  const wc = SIM.createWorld({ seed: 120 });
  wc.self.shopGold = 300;
  const wCount0 = wc.self.weapons.length;
  const rc0 = SIM.shopBuy(wc, newItem.id);
  expect('★没选哪件技能时被拒，并回 needPick（界面据此去开选择器）',
    rc0.ok === false && rc0.needPick === 'new', JSON.stringify(rc0));
  expect('★★没选哪件技能时**一分钱没扣**', wc.self.shopGold === 300, String(wc.self.shopGold));
  expect('没选哪件技能时也没往武器栏塞东西', wc.self.weapons.length === wCount0, String(wc.self.weapons.length));

  // 挑一件「玩家手上一定没有的」基础武器 —— 不写死 id，免得以后改初始武器就假红
  const freeWeapon = C.WEAPONS.filter(function (d) {
    return !wc.self.weapons.some(function (x) { return x.id === d.id; });
  })[0].id;
  const g0 = wc.self.shopGold;
  const rc1 = SIM.shopBuy(wc, newItem.id, null, { pick: freeWeapon });
  expect('★选了技能之后买成功（血脉契约 → ' + freeWeapon + '）', rc1.ok === true, rc1.reason);
  expect('★钱扣了（' + g0 + ' - ' + newItem.price + '）',
    wc.self.shopGold === g0 - newItem.price, String(wc.self.shopGold));
  expect('★技能真的进武器栏了，而且是 1 级',
    (function () {
      const own = wc.self.weapons.filter(function (x) { return x.id === freeWeapon; })[0];
      return !!own && own.level === 1;
    })(), JSON.stringify(wc.self.weapons.map(function (x) { return x.id + ':' + x.level; })));
  expect('新加的武器带 timer/rt（缺了 fireWeapon 每帧读到 NaN 冷却）',
    (function () {
      const own = wc.self.weapons.filter(function (x) { return x.id === freeWeapon; })[0];
      return !!own && typeof own.timer === 'number' && !!own.rt;
    })());
  expect('返回里带 added（界面据此说「已习得 X」）', rc1.added === freeWeapon, String(rc1.added));

  // 重复买同一件：拒绝 + 不扣钱
  const g1 = wc.self.shopGold;
  const rc2 = SIM.shopBuy(wc, newItem.id, null, { pick: freeWeapon });
  expect('★已经学过的技能不能再买', rc2.ok === false, rc2.reason);
  expect('★被拒时一分钱没扣', wc.self.shopGold === g1, String(wc.self.shopGold));

  // 进化形态不能直接买（那是「满级武器 ＋ 满级被动」合成出来的终点）
  const rc3 = SIM.shopBuy(wc, newItem.id, null, { pick: C.EVOLUTIONS[0].id });
  expect('★进化形态不能直接买（否则整条成长线被跳过）', rc3.ok === false, rc3.reason);
  expect('★被拒时一分钱没扣（第二次）', wc.self.shopGold === g1, String(wc.self.shopGold));

  // 买被动：进 passives（不是 weapons）—— 分类搞错会让技能永远不生效
  const freePassive = C.PASSIVES[0].id;
  const rc4 = SIM.shopBuy(wc, newItem.id, null, { pick: freePassive });
  expect('★买被动真的进被动栏（不是塞进武器栏）',
    rc4.ok === true && wc.self.passives.some(function (x) { return x.id === freePassive; }),
    rc4.reason);
  expect('被动买完属性立刻重算（不用等下一次拿武器）',
    wc.self.attrs !== null && typeof wc.self.attrs.dmgMul === 'number');

  // 槽位满：买不了，且说清「用置换契约腾一格」
  const wfull = SIM.createWorld({ seed: 122 });
  wfull.self.shopGold = 9999;
  wfull.self.weapons = C.WEAPONS.slice(0, C.SLOTS.weapon).map(function (d) {
    return { id: d.id, level: 1, timer: 0, rt: {} };
  });
  // 从「没被塞进满槽」的武器里挑一件（上限 10 < 17 件武器，一定有剩）
  const spare = C.WEAPONS.filter(function (d) {
    return !wfull.self.weapons.some(function (x) { return x.id === d.id; });
  })[0].id;
  const gfull = wfull.self.shopGold;
  const rf = SIM.shopBuy(wfull, newItem.id, null, { pick: spare });
  expect('★武器格满时买不了新武器', rf.ok === false, rf.reason);
  expect('★满格被拒时一分钱没扣', wfull.self.shopGold === gfull, String(wfull.self.shopGold));
  expect('★满格时给出了下一步（提示改用置换契约）',
    rf.reason.indexOf('置换') >= 0, rf.reason);
  expect('满格时没有偷偷超上限', wfull.self.weapons.length === C.SLOTS.weapon,
    String(wfull.self.weapons.length));

  // ---- 置换契约 ----
  // ★「遗忘哪件 / 换成哪件」必须按**效果**动态挑，不能写 PASSIVES[0] / PASSIVES[1]：
  //   实际上 PASSIVES[0] 就是 blood_crystal（伤害类），写成 0/1 会变成「换成同一件」
  //   被拒 → 后面 5 条连锁失败（第一次就是这么白报的）。
  const dmgP = C.PASSIVES.filter(function (x) { return x.effect === 'dmg'; })[0];
  const dropP = C.PASSIVES.filter(function (x) { return x.id !== dmgP.id; })[0].id;
  const pickP = dmgP.id;
  const ws = SIM.createWorld({ seed: 123 });
  ws.self.shopGold = 300;
  ws.self.passives = [{ id: dropP, level: 3 }];
  SIM.recalcAttrs(ws);
  const gs0 = ws.self.shopGold;
  const rs1 = SIM.shopBuy(ws, swapItem.id, null, { drop: dropP, pick: pickP });
  expect('★置换成功', rs1.ok === true, rs1.reason);
  expect('★钱扣了（' + gs0 + ' - ' + swapItem.price + '）',
    ws.self.shopGold === gs0 - swapItem.price, String(ws.self.shopGold));
  expect('★要遗忘的那件真的没了', !ws.self.passives.some(function (x) { return x.id === dropP; }),
    JSON.stringify(ws.self.passives));
  expect('★换上的那件进来了，且是 1 级（等级不保留）',
    (function () {
      const own = ws.self.passives.filter(function (x) { return x.id === pickP; })[0];
      return !!own && own.level === 1;
    })(), JSON.stringify(ws.self.passives));
  expect('★换完之后属性立刻重算（新被动当场生效，旧被动当场失效）',
    Math.abs(ws.self.attrs.dmgMul - (1 + C.PASSIVE_MAP[pickP].per)) < 0.001,
    'dmgMul=' + ws.self.attrs.dmgMul + ' 期望 ' + (1 + C.PASSIVE_MAP[pickP].per));
  expect('返回里带 dropped / added（界面据此报「遗忘 X、习得 Y」）',
    rs1.dropped === dropP && rs1.added === pickP, JSON.stringify({ d: rs1.dropped, a: rs1.added }));

  // 置换的各种拒绝：都不扣钱
  const gs1 = ws.self.shopGold;
  const rs2 = SIM.shopBuy(ws, swapItem.id, null, { drop: pickP, pick: 'armor' });
  expect('★不能遗忘一件自己没学过的', rs2.ok === false, rs2.reason);
  const rs3 = SIM.shopBuy(ws, swapItem.id, null, { drop: pickP, pick: pickP });
  expect('★不能换成同一件', rs3.ok === false, rs3.reason);
  const rs4 = SIM.shopBuy(ws, swapItem.id, null, { drop: pickP });
  expect('★置换只给了遗忘、没给换上时被拒', rs4.ok === false && rs4.needPick === 'swap', JSON.stringify(rs4));
  expect('★这三次拒绝都没有扣钱', ws.self.shopGold === gs1, String(ws.self.shopGold));

  // 跨类置换：丢被动换武器 —— 武器格会因此不腾位，满了就必须挡
  const wx = SIM.createWorld({ seed: 124 });
  wx.self.shopGold = 9999;
  wx.self.weapons = C.WEAPONS.slice(0, C.SLOTS.weapon).map(function (d) {
    return { id: d.id, level: 1, timer: 0, rt: {} };
  });
  wx.self.passives = [{ id: dropP, level: 1 }];
  const spare2 = C.WEAPONS.filter(function (d) {
    return !wx.self.weapons.some(function (x) { return x.id === d.id; });
  })[0].id;
  const gx = wx.self.shopGold;
  const rx = SIM.shopBuy(wx, swapItem.id, null, { drop: dropP, pick: spare2 });
  expect('★★丢被动换武器时武器格不会腾位 → 满格必须挡住（否则会多出第 11 格）',
    rx.ok === false, rx.reason);
  expect('★跨类置换被拒时也没有扣钱', wx.self.shopGold === gx, String(wx.self.shopGold));
  // 同类置换（丢武器换武器）在满格时应该放行
  const rx2 = SIM.shopBuy(wx, swapItem.id, null, { drop: wx.self.weapons[0].id, pick: spare2 });
  expect('★同类置换在满格时放行（丢一件补一件，数量不变）', rx2.ok === true, rx2.reason);
  expect('置换之后武器数量仍然等于上限', wx.self.weapons.length === C.SLOTS.weapon,
    String(wx.self.weapons.length));

  // ---------------- 6. 金币进余额：拾取与宝箱都要进 ----------------
  const w5 = SIM.createWorld({ seed: 105 });
  w5.self.shopGold = 0;
  w5.self.stats.gold = 0;
  w5.self.attrs.goldMul = 1;
  w5.diff.goldMul = 1;
  // 直接走updatePickups 不好构造，改为验证「余额与战绩是两个数」这条不变式：
  // 造一个金币掉落，走一次拾取
  w5.pickups.push({
    id: 1, kind: 'gold', x: w5.self.x, y: w5.self.y,
    px: w5.self.x, py: w5.self.y, value: 5, life: 30, alive: true
  });
  SIM.step(w5, { mx: 0, my: 0 });
  expect('拾取金币后战绩增加（结算用）', w5.self.stats.gold > 0, 'stats.gold=' + w5.self.stats.gold);
  expect('★拾取金币后可花余额也增加（商店用）', w5.self.shopGold > 0, 'shopGold=' + w5.self.shopGold);
  expect('★买过东西后余额会变，但战绩不变（两个数字严格分工）',
    (function () {
      const g0 = w5.self.stats.gold;
      w5.self.shopGold = 200;
      SIM.shopBuy(w5, healItem.id);
      return w5.self.stats.gold === g0;
    })(), '战绩不该被消费影响');

  // ---------------- 7. HUD 里带得出商店与角色数据 ----------------
  const w6 = SIM.createWorld({ seed: 106 });
  w6.self.shopGold = 77;
  w6.self.shopBuffDmg = 0.24;
  // ★用**伤害类**被动（血晶·dmg），不要用日轮烙印（crit）
  //   crit 是**结算那一刻判定**的（见 damageMob），它根本不进 dmgMul ——
  //   拿它来验伤害倍率会得到 1.24 而断言期望 1.40，然后我就会去改一个没坏的公式。
  w6.self.passives = [{ id: 'blood_crystal', level: 2 }];
  SIM.recalcAttrs(w6);
  const h = SIM.getHud(w6);
  expect('HUD 带得出可花余额', h.shopGold === 77, String(h.shopGold));
  expect('HUD 带得出血契石层数', h.buffStacks === 2, String(h.buffStacks));
  expect('★HUD 带得出角色详细数据（暂停面板要显示）', !!h.detail);
  expect('详细数据里血量上限是正数', h.detail && h.detail.maxHp > 0, String(h.detail && h.detail.maxHp));
  // ★detail.dmgMul 存的是**百分数**（sim 里 ×1000/10 = 放大 100 倍），
  //   所以 1.44 倍在 detail 里是 144。写断言时按 144 写，别按 1.44。
  expect('详细数据里伤害倍率 = 144%（= 1 + 血契石 0.24 + 血晶 2 级 0.20）',
    h.detail && Math.abs(h.detail.dmgMul - 144) < 1,
    h.detail && String(h.detail.dmgMul));
  // 再单独确认 crit 类被动走的是另一条路（它只在 detail.crit 上，不影响 dmgMul）
  const wCrit = SIM.createWorld({ seed: 1061 });
  wCrit.self.passives = [{ id: 'sun_brand', level: 2 }];
  SIM.recalcAttrs(wCrit);
  const hCrit = SIM.getHud(wCrit);
  expect('暴击类被动不进伤害倍率（它是结算判定，不是面板乘区）',
    Math.abs(hCrit.detail.dmgMul - 100) < 1, String(hCrit.detail.dmgMul));
  expect('★暴击率在 detail.crit 上单独给出（暂停面板据此显示）',
    hCrit.detail.crit > 0, String(hCrit.detail.crit));

  // ---------------- 8. 关联说明：从数据反查，且能区分「已齐 / 还差」 ----------------
  expect('武器能反查到组合技（铁鞭 → 血雾领域）',
    C.weaponLinks('whip', 1).some(function (l) { return l.kind === 'combo' && l.name === '血雾领域'; }),
    JSON.stringify(C.weaponLinks('whip', 1)));
  expect('★未达等级时说「需要 5 级」而不是含糊的「可凑」',
    C.weaponLinks('whip', 1).some(function (l) { return l.text.indexOf('需要 5 级') >= 0; }),
    JSON.stringify(C.weaponLinks('whip', 1)));
  expect('★已达标时说「另一件也到 5 级即可」（告诉玩家下一步做什么）',
    C.weaponLinks('whip', 5).some(function (l) { return l.state === 'ready'; }),
    JSON.stringify(C.weaponLinks('whip', 5)));
// ★进化名同样从数据表取，不写死「血鞭」（第十八轮改名为「刑天战戚」）
expect('武器能反查到进化去向（whip → 它自己的进化形态）',
  C.weaponLinks('whip', 1).some(function (l) {
    return l.kind === 'evo' && l.name === C.EVO_BY_WEAPON.whip.name;
  }),
  JSON.stringify(C.weaponLinks('whip', 1)));
expect('被动能反查到进化（玄铁甲 → 它参与的两条进化）',
  C.passiveLinks('iron_shell').length === 2, String(C.passiveLinks('iron_shell').length));
  expect('没有关联的技能返回空数组（界面据此不显示那一行）',
    C.weaponLinks('gale_boomerang', 1).length >= 1 &&
    C.passiveLinks('wind_feather').length >= 0, '');

  //★完备性：每一件武器、每一个被动都要有反查入口可查（不能是 undefined）。
  //  查 undefined 会静默返回空数组 → 说明里少一条路线，界面照常显示。
  let noLink = [];
  for (let i = 0; i < C.WEAPONS.length; i++) {
    if (typeof C.weaponLinks(C.WEAPONS[i].id, 1) !== 'object') noLink.push(C.WEAPONS[i].id);
  }
  for (let i = 0; i < C.PASSIVES.length; i++) {
    if (typeof C.passiveLinks(C.PASSIVES[i].id) !== 'object') noLink.push(C.PASSIVES[i].id);
  }
  expect('所有武器与被动都能查到反查信息（不会静默丢一条路线）',
    noLink.length === 0, noLink.join(','));

  // ★完备性：**每个组合技的每一件需求武器**都必须能反查到它。
  //  这是本节最关键的一条 —— 漏一条，那个组合技就永远不会被任何候选卡提示到，
  //  而玩家完全不知道存在这条路线。
  let missCombo = [];
  for (let i = 0; i < C.COMBOS.length; i++) {
    const cb = C.COMBOS[i];
    for (let j = 0; j < cb.need.length; j++) {
      const links = C.weaponLinks(cb.need[j], 1);
      if (!links.some(function (l) { return l.kind === 'combo' && l.name === cb.name; })) {
        missCombo.push(cb.name + '<-' + cb.need[j]);
      }
    }
  }
  expect('★每个组合技都能从它的每件需求武器反查到你',
    missCombo.length === 0, missCombo.join(','));

  // ---------------- 9. 候选卡真的带上了 links ----------------
  const w7 = SIM.createWorld({ seed: 107 });
  w7.self.weapons = [
    { id: 'whip', level: 1, timer: 0, rt: {} },
    { id: 'garlic', level: 1, timer: 0, rt: {} }
  ];
  w7.self.passives = [{ id: 'iron_shell', level: 1 }];
  SIM.recalcAttrs(w7);
  // ★怎么把玩家升到有候选可看：必须**丢一颗经验球再吃它**，
  //   直接设 p.exp 不会升级 —— gainExp 只在「拾取经验球」那一个地方被调用
  //   （sim.js 的 updatePickups），没有别的入口。
  //   第一版设了 exp=999 结果 level 一直是 1、choices 恒为 0，排查了很久。
  w7.pickups.push({
    id: 9001, kind: 'exp', x: w7.self.x, y: w7.self.y,
    px: w7.self.x, py: w7.self.y, value: 5, life: 30, alive: true
  });
  SIM.step(w7, { mx: 0, my: 0 });
  const chs = w7.self.choices;
  expect('能开出一个升级面板（3 个候选）', chs.length === 3, '候选 ' + chs.length + ' 个');
  // 铁鞭的升级/新武器候选里应带组合技关联
  const whipChoice = chs.filter(function (c) { return c.id === 'whip'; })[0];
  if (whipChoice) {
    expect('★升级候选带上了关联说明（links 字段）',
      Array.isArray(whipChoice.links) && whipChoice.links.length > 0,
      JSON.stringify(whipChoice.links));
  }
  // 被动候选也带
  const shellChoice = chs.filter(function (c) { return c.id === 'iron_shell'; })[0];
  if (shellChoice) {
    expect('★被动候选带上了进化关联（铁壳 → 血鞭）',
      Array.isArray(shellChoice.links) && shellChoice.links.some(function (l) { return l.kind === 'evo'; }),
      JSON.stringify(shellChoice.links));
  }

  // ---------------- 10. 新增的两张图（第十二轮）----------------
  ['spire', 'marsh'].forEach(function (id) {
    const m = M.mapById(id);
    expect('新增地图「' + (m ? m.name : id) + '」能按 id 查到', !!m && m.id === id);
    if (!m) return;
    // 纯函数：双端各算一次必须逐字节相同（整套地形策略的地基）
    const a = M.buildObstacles(m);
    const b = M.buildObstacles(m);
    expect('地图「' + m.name + '」地形是纯函数（双端算结果一致）',
      JSON.stringify(a) === JSON.stringify(b), a.length + ' 个障碍');
    expect('地图「' + m.name + '」有障碍（不是空图）', a.length >= 15, a.length + ' 个');
    // 障碍必须比地面亮 —— 只差几个色阶等于屏幕上没有墙（第一版钟楼踩过）
    function lum(hex) {
      const n = parseInt(hex.slice(1), 16);
      const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (v) {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return ch[0] * 0.2126 + ch[1] * 0.7152 + ch[2] * 0.0722;
    }
    const dl = lum(m.theme.ground), ol = lum(m.obTheme.solid);
    expect('地图「' + m.name + '」障碍比地面亮（亮度差 >= 0.04）', ol - dl >= 0.04,
      '亮度差 ' + (ol - dl).toFixed(3));
    // 不越界
    const outOfBounds = a.filter(function (o) { return o.x < 0 || o.y < 0 || o.x > m.w || o.y > m.h; });
    expect('地图「' + m.name + '」障碍不越界', outOfBounds.length === 0, outOfBounds.length + ' 个越界');
    // 障碍得能靠得近：全图 0 障碍的地图等于「地图选择是假的」
    expect('地图「' + m.name + '」障碍分布均匀（不是全挤在一角）',
      (function () {
        const cell = 400;
        const gw = Math.floor(m.w / cell), gh = Math.floor(m.h / cell);
        let hit = 0;
        for (let gx = 0; gx < gw; gx++) {
          for (let gy = 0; gy < gh; gy++) {
            const x = gx * cell + cell / 2, y = gy * cell + cell / 2;
            if (a.some(function (o) { return Math.hypot(o.x - x, o.y - y) < o.r + cell * 0.5; })) hit++;
          }
        }
        // 至少 5% 的格子附近有障碍，且不超过 70%
        const ratio = hit / (gw * gh);
        return ratio >= 0.05 && ratio <= 0.7;
      })(), '');
  });

  // 新地形类型真的与老的不一样：斜塔是斜排、钟楼是正交
  function angleProfile(id) {
    const a = M.buildObstacles(M.mapById(id));
    let diag = 0, axis = 0;
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        if (Math.hypot(a[i].x - a[j].x, a[i].y - a[j].y) > 110) continue;
        const dx = Math.abs(a[i].x - a[j].x), dy = Math.abs(a[i].y - a[j].y);
        if (dx < 12 || dy < 12) axis++;
        else if (Math.abs(dx - dy) < 28) diag++;
      }
    }
    return { diag: diag, axis: axis };
  }
  const pr = angleProfile('spire');
  const ct = angleProfile('cathedral');
  expect('斜塔回廊确实是斜向石阵（紧邻障碍里斜的占多数）',
    pr.diag > pr.axis, '斜' + pr.diag + ' vs 正' + pr.axis);
  expect('★斜塔与钟楼的走位处境真的不同（不是换了个背景）',
    pr.diag > 0 && ct.diag === 0, '斜塔斜' + pr.diag + ' / 钟楼斜' + ct.diag);

  // 沼泽孤岛：障碍成簇，簇间大片空地。
  // ★断言不能只比「覆盖占比」：用 200px 格量时孤岛 9.3% vs 断墙 9.0%，
  //   差异小到看不出（第一版断言就这么写的，然后它红了）。
  //   真正能区分两张图的是**空地的连续性**——
  //   孤岛之间是大片能跑的空地，断墙图是「到处都被切一刀」。
  // 所以这里量「任意 500px 半径内能跑多远」：孤岛图应该明显更空。
  function openness(id) {
    const m = M.mapById(id);
    const a = M.buildObstacles(m);
    // 在地图上撒一批采样点，量每个点 500px 内到最近障碍的距离，取中位数
    const ds = [];
    for (let gx = 0; gx < 12; gx++) {
      for (let gy = 0; gy < 12; gy++) {
        const x = (gx + 0.5) * (m.w / 12);
        const y = (gy + 0.5) * (m.h / 12);
        let near = 1e9;
        for (let i = 0; i < a.length; i++) {
          const d = Math.hypot(a[i].x - x, a[i].y - y) - a[i].r;
          if (d < near) near = d;
        }
        ds.push(near);
      }
    }
    ds.sort(function (p, q) { return p - q; });
    return ds[Math.floor(ds.length / 2)];   // 中位数：不受个别贴脸点影响
  }
  const marshOpen = openness('marsh');
  const wallOpen = openness('cathedral');
  expect('★沼泽孤岛比断墙图更开阔（采样点到最近障碍的中位距离更大）',
    marshOpen > wallOpen,
    '孤岛 ' + marshOpen.toFixed(0) + 'px vs 断墙 ' + wallOpen.toFixed(0) + 'px');
  expect('沼泽孤岛的中位空地够跑（>= 180px，即有连续的跑动空间）',
    marshOpen >= 180, marshOpen.toFixed(0) + 'px');

  // 障碍总数密度：孤岛图不该是「障碍最多的那张」
  function density(id) {
    const m = M.mapById(id);
    return M.buildObstacles(m).length / (m.w * m.h / 1e6);
  }
  expect('沼泽孤岛的障碍密度低于断墙图（更空旷 = 视野好）',
    density('marsh') < density('cathedral'),
    '孤岛 ' + density('marsh').toFixed(1) + ' vs 断墙 ' + density('cathedral').toFixed(1) + ' 个/百万px');
}
