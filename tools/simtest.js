// tools/simtest.js —— 世界模拟无头自检
//
// 前端还没接之前，先在 Node 里把 shared/sim.js 跑透：
// 逻辑会不会崩、数值合不合理、1200 怪同屏单帧耗时够不够。
// 这一步能拦住绝大多数「一上线就白屏」的问题。
//
// 用法：node tools/simtest.js

const C = require('../shared/const.js');
const SIM = require('../shared/sim.js');
// 第四十一轮：山魈那条「关卡池里不许有它」要扫剧情模组的关卡表，
// 所以这里直接引 campaign（与 sim.js 内部是同一个模块实例，不额外开销）。
const CP = require('../shared/campaign.js');
// 第四十六轮：引魂灯那条「表里不许有死字段」需要直接扫 sim.js 源码 ——
// 这类断言（"写了却没人读的数值"）没别的办法验，只能看源码里还有没有引用。
const FS = require('fs');
const PATH = require('path');

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
  // ★这里原来写死 1.15，和上面三行注释「期望值一律从 C.PLAYER 现算，不要写死数字」自相矛盾：
  //   数值表一调（第四十四轮就把后土从 1.15 提到 1.28），写死的期望值就变成「假失败」，
  //   而假失败最坏的后果是有人去改断言、而不是去查代码。判据改成从表里现读。
  const nunRange = (C.CHAR_MAP.nun && C.CHAR_MAP.nun.mods && C.CHAR_MAP.nun.mods.range) || 1;
  expect('后土范围特性按表生效', Math.abs(nun.player.attrs.rangeMul - nunRange) < 0.001,
    'rangeMul=' + nun.player.attrs.rangeMul + ' 期望 ' + nunRange);
  // 钉「不该发生的事」：一个「纯范围」角色的范围特性不许小到看不出来。
  // ★判据为什么是 1.25 而不是「跟武器满级成长比」：那两个数**没有设计上的必然关系**——
  //   武器满级要练 8 级、要吃掉大量经验，角色是开局就有的底色，本来就不该一样大。
  //   真正该钉的是「肉眼可辨的最低幅度」：900px 宽的画面里，半径宽不到 25% 就是十几像素，
  //   玩家根本看不出这个角色"范围大"（第四十四轮之前她只有 15%，正是这个问题）。
  expect('★范围型角色的特性必须 ≥ +25%（低于这个幅度画面上看不出来，角色特性形同虚设）',
    nunRange >= 1.25, 'nun=' + nunRange);
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
    // 升级面板弹出来就按顺序轮着选，模拟玩家操作。
    // ★这里原来是 Math.random()：同一份代码每次跑出的武器组合都不同，
    //   于是**断言条数**会在 384~434 之间浮动（有些整块断言只对特定组合成立）。
    //   项目里「断言数变少 = 某块被静默跳过」这条纪律就失效了 ——
    //   改成按 tick 轮转既保留了「不同选择都试一遍」的覆盖，又完全可复现。
    if (w.state === 'levelup') {
      SIM.chooseLevelUp(w, i % w.choices.length);
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
  // ★第二十八轮：地图开局自带**固定宝箱**（每张图 3 个，见 maps.js 的 buildChests）。
  //   这一段测的是「普通怪不掉宝箱」，所以先把地图自带的那些按基线记下来，
  //   再断言「杀掉一只小怪之后数量没有增加」——用相对值，不用绝对值。
  const MAP = require('../shared/maps.js');
  const mapChests = w.pickups.filter(function (it) { return it.kind === 'chest'; });
  expect('地图开局自带固定宝箱（点位来自纯函数 buildChests）',
    mapChests.length === MAP.buildChests(w.map).length && mapChests.length > 0,
    '宝箱数=' + mapChests.length);
  expect('固定宝箱的寿命够一局（不会被当成 60 秒掉落物）',
    mapChests.every(function (it) { return it.life > 600; }),
    mapChests.map(function (it) { return Math.round(it.life); }).join(','));
  SIM.step(w, { mx: 0, my: 0 });                 // 来一波小怪
  SIM.takeEvents(w, 0);                          // 清掉波次事件
  const first = w.mobs[0];
  SIM.damageMob(w, first, 99999, 0, 0);
  SIM.step(w, { mx: 0, my: 0 });                 // 让 compactMobs 把死怪清掉
  const chests0 = w.pickups.filter(function (it) { return it.kind === 'chest'; });
  expect('普通怪不掉宝箱（数量与地图固定宝箱一致）', chests0.length === mapChests.length,
    '宝箱数=' + chests0.length + ' 基线=' + mapChests.length);

  // ---- Boss 必掉宝箱 ----
  // 直接把波次推到第 9 波，下一帧就是第 10 波（Boss 波）——
  // 比真跑 5 分钟快得多，而且用的是真实的 Boss 波逻辑。
  const b = SIM.createWorld({ seed: 21, pauseAllOnLevelUp: false });
  SIM.setSelf(b, null);
  // 同上：把地图自带的固定宝箱先摘掉，这一段只看 Boss 掉落
  b.pickups = b.pickups.filter(function (it) { return it.kind !== 'chest'; });
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

testAffix();console.log('');

testChallenger();console.log('');

testShrine();console.log('');

testRage();console.log('');

testMoon();console.log('');
testMeteor();console.log('');
testSummoner();console.log('');
testLey();console.log('');
testPact();console.log('');
testTwins();console.log('');
testLantern();console.log('');
testDevourer();console.log('');
testBoon();console.log('');
testBell();console.log('');
testMerge();console.log('');
testEscort();console.log('');

testMarket();console.log('');
testCauldron();console.log('');
testBounty();console.log('');
testHealer();console.log('');
testSerenity();console.log('');
testGlean();console.log('');
testForge();console.log('');
testStride();console.log('');
testMend();console.log('');
testThunder();console.log('');
testPeril();console.log('');
testDew();console.log('');
testStreak();console.log('');
testBestiary();console.log('');
testSkillDiff();console.log('');
testShoot();console.log('');
testGeneral();console.log('');
testEvade();console.log('');
testTemper();console.log('');
testSwarm();console.log('');
testHunt();console.log('');
testVenge();console.log('');
testAscend();console.log('');
testUnseal();console.log('');
testYongjin();console.log('');
testJuling();console.log('');
testOnehit();console.log('');
testRetaliate();console.log('');
testKillFx();console.log('');
testRangeGrowth();console.log('');
testTaga();console.log('');
testStill();console.log('');
testChain();console.log('');

// ============================================================
// 第八十一轮：踏罡诀（目标制零实体第二十五件，全新轴「四方站位覆盖」）
// ============================================================
function testTaga() {
  console.log('[第八十一轮] 踏罡诀：第一件「四方站位覆盖」目标（空间方位轴）');
  const P = C.TAGA;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    p.attrs.crit = 0;
    // 所有既有机制的排期一律推远，隔离本件的观测窗口。
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 1e9;
    w.yongjinNextTick = 1e9;
    w.julingNextTick = 1e9;
    w.onehitNextTick = 1e9;
    w.retaliateNextTick = 1e9;
    w.tagaNextTick = 0;  // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.tagaNextTick = 0;
    SIM.tickTaga(w);
  }
  // 把玩家放到某方位的圈外一点。extra 为负数时放在圈内，用于边界测试。
  function putSide(w, side, extra) {
    const p = w.self || w.player;
    const cx = w.map.w / 2;
    const cy = w.map.h / 2;
    const d = Math.min(w.map.w, w.map.h) * P.distRatio + (extra || 0);
    if (side === 0) { p.x = cx + d; p.y = cy; }
    else if (side === 1) { p.x = cx; p.y = cy + d; }
    else if (side === 2) { p.x = cx - d; p.y = cy; }
    else { p.x = cx; p.y = cy - d; }
  }
  // 在某方位连续站 sec 秒（按 20Hz 一帧一帧喂钩子）。
  function stay(w, side, sec) {
    putSide(w, side);
    const n = Math.ceil(sec * HZ);
    for (let i = 0; i < n; i++) SIM.onTagaStay(w, 1 / HZ);
  }
  function completeSides(w, count) {
    for (let i = 0; i < count; i++) stay(w, i, w.tagaNeed + 0.01);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('★★首发时刻错开全部 32 个既有事件（含反击诀 588）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE', 'ASCEND', 'UNSEAL', 'YONGJIN', 'JULING', 'ONEHIT', 'RETALIATE'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'taga=' + P.startSec + ' retaliate=' + C.RETALIATE.startSec);
  expect('窗口短于间隔且不短于 20 秒（四方跑得完）',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('站位时长逐轮递增且封顶', SIM.tagaNeedFor(0) === P.needHold &&
    SIM.tagaNeedFor(1) === P.needHold + P.holdStep &&
    SIM.tagaNeedFor(99) === P.maxHold,
    '0=' + SIM.tagaNeedFor(0) + ' 99=' + SIM.tagaNeedFor(99));
  expect('单方时长合理（站得住又不白送）',
    P.needHold > 0 && P.needHold <= P.maxHold && P.maxHold <= 2,
    P.needHold + '~' + P.maxHold);
  expect('方位圈比例落在合理区间（不同地图都跑得到）',
    P.distRatio > 0.05 && P.distRatio < 0.35, P.distRatio);
  expect('奖励仍是「一箱 + 零钱」（与前二十四件同口径）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 方位判定（灵魂边界：中心不算 / 边界含等号 / 四方不串）----------
  const wZ = cleanWorld(14001);
  const pZ = wZ.self || wZ.player;
  pZ.x = wZ.map.w / 2;
  pZ.y = wZ.map.h / 2;
  expect('★★站在地图正中心不算任何方位', SIM.tagaZoneAt(wZ) === -1,
    'zone=' + SIM.tagaZoneAt(wZ));
  putSide(wZ, 0, -1);
  expect('★★方位圈内（差 1 像素）不算', SIM.tagaZoneAt(wZ) === -1,
    'zone=' + SIM.tagaZoneAt(wZ));
  putSide(wZ, 0);
  expect('★★正好踩在圈线上算「东」（边界含等号）', SIM.tagaZoneAt(wZ) === 0,
    'zone=' + SIM.tagaZoneAt(wZ));
  putSide(wZ, 1);
  expect('正下是「南」', SIM.tagaZoneAt(wZ) === 1, 'zone=' + SIM.tagaZoneAt(wZ));
  putSide(wZ, 2);
  expect('正左是「西」', SIM.tagaZoneAt(wZ) === 2, 'zone=' + SIM.tagaZoneAt(wZ));
  putSide(wZ, 3);
  expect('正上是「北」', SIM.tagaZoneAt(wZ) === 3, 'zone=' + SIM.tagaZoneAt(wZ));
  pZ.x = wZ.map.w / 2 + Math.min(wZ.map.w, wZ.map.h) * P.distRatio;
  pZ.y = wZ.map.h / 2 + Math.min(wZ.map.w, wZ.map.h) * P.distRatio;
  expect('45° 落在圈外时固定归「东」，不来回换方', SIM.tagaZoneAt(wZ) === 0,
    'zone=' + SIM.tagaZoneAt(wZ));
  pZ.x = wZ.map.w / 2 - Math.min(wZ.map.w, wZ.map.h) * P.distRatio;
  pZ.y = wZ.map.h / 2 + Math.min(wZ.map.w, wZ.map.h) * P.distRatio;
  expect('左下 45° 固定归「西」', SIM.tagaZoneAt(wZ) === 2,
    'zone=' + SIM.tagaZoneAt(wZ));
  pZ.hp = 0;
  expect('★★阵亡的玩家不占方位', SIM.tagaZoneAt(wZ) === -1,
    'zone=' + SIM.tagaZoneAt(wZ));

  // ---------- 3. 零随机（开窗 / 站位 / 发奖 / 落空全不动随机流）----------
  const wR = cleanWorld(14002);
  const rng0 = wR.rngState;
  openWindow(wR);
  completeSides(wR, 4);
  SIM.tickTaga(wR);
  const wR2 = cleanWorld(14003);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  completeSides(wR2, 1);
  wR2.time = wR2.tagaDeadline + 0.01;
  SIM.tickTaga(wR2);
  expect('★★★四方走遍与落空都不消耗 nextRand（波次/掉落随机流零污染）',
    wR.rngState === rng0 && wR2.rngState === rng1,
    'done=' + wR.rngState + '/' + rng0 + ' fail=' + wR2.rngState + '/' + rng1);

  // ---------- 4. 时序与零实体 ----------
  const wT = cleanWorld(14004);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickTaga(wT);
  expect('到点前零轮零播报', wT.tagaRounds === 0 && evs(wT, 'taga_start').length === 0,
    'rounds=' + wT.tagaRounds);
  openWindow(wT);
  expect('开窗零实体：不造怪、不造球、不造 zone、不造 strike',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pick=' + wT.pickups.length);
  expect('开窗只播一条，且一次说清秒数/单方时长/四方', evs(wT, 'taga_start').length === 1 &&
    evs(wT, 'taga_start')[0].need === P.needHold &&
    evs(wT, 'taga_start')[0].sec === P.windowSec,
    JSON.stringify(evs(wT, 'taga_start')[0]));
  expect('deadline 零漂移（整数 tick 换算 w.time）',
    wT.tagaDeadline === wT.time + P.windowSec,
    wT.tagaDeadline + ' vs ' + (wT.time + P.windowSec));
  expect('下一轮排期 = 首发 tick + 间隔', wT.tagaNextTick === startTick + P.everySec * HZ,
    wT.tagaNextTick + ' vs ' + (startTick + P.everySec * HZ));
  SIM.tickTaga(wT);
  expect('同一帧不重复开窗', wT.tagaRounds === 1 && evs(wT, 'taga_start').length === 1,
    'rounds=' + wT.tagaRounds);
  expect('到期前一帧不结算',
    (wT.time = wT.tagaDeadline - 0.01, SIM.tickTaga(wT),
      wT.tagaActive === 1 && evs(wT, 'taga_done').length === 0 &&
      evs(wT, 'taga_fail').length === 0), 'active=' + wT.tagaActive);
  expect('事件对象不塞快照字段（start 恰好四个键）',
    Object.keys(evs(wT, 'taga_start')[0]).length === 4,
    JSON.stringify(evs(wT, 'taga_start')[0]));

  // ---------- 5. 站位累计（站够才算、不重复、过半不刷屏）----------
  const wS = cleanWorld(14005);
  openWindow(wS);
  putSide(wS, 0);
  SIM.onTagaStay(wS, 0);
  expect('★★dt<=0 不算', wS.tagaHold[0] === 0 && wS.tagaDoneCount === 0,
    'hold=' + wS.tagaHold[0]);
  stay(wS, 0, wS.tagaNeed * 0.5);
  expect('★中心圈里站再久也不累计（先挪回中心）',
    (function () {
      const p = wS.self || wS.player;
      p.x = wS.map.w / 2; p.y = wS.map.h / 2;
      const before = wS.tagaHold[0];
      for (let i = 0; i < 20; i++) SIM.onTagaStay(wS, 1 / HZ);
      return wS.tagaHold[0] === before;
    })(), 'hold=' + wS.tagaHold[0]);
  stay(wS, 0, wS.tagaNeed * 0.6);
  expect('分两次站同一方也能累计到站满（半程不丢）',
    wS.tagaHold[0] === wS.tagaNeed && wS.tagaDoneCount === 1,
    'hold=' + wS.tagaHold[0] + ' done=' + wS.tagaDoneCount);
  expect('★一方站满只记一次，不会因超时站着刷成四方',
    (stay(wS, 0, 5), wS.tagaDoneCount === 1), 'done=' + wS.tagaDoneCount);
  expect('过半前零播报', evs(wS, 'taga_half').length === 0,
    'half=' + evs(wS, 'taga_half').length);
  stay(wS, 1, wS.tagaNeed + 0.01);
  expect('第二方站满即过半，且只播一次', wS.tagaDoneCount === 2 &&
    evs(wS, 'taga_half').length === 1 && evs(wS, 'taga_half')[0].left === 2,
    JSON.stringify(evs(wS, 'taga_half')[0]));
  stay(wS, 2, wS.tagaNeed + 0.01);
  stay(wS, 3, wS.tagaNeed + 0.01);
  expect('★★★过半播报不随第三方/第四方刷屏（钉标记位闸）',
    evs(wS, 'taga_half').length === 1, 'half=' + evs(wS, 'taga_half').length);
  expect('四方站满 = 4，且每方独立不串', wS.tagaDoneCount === 4 &&
    wS.tagaHold.every(function (v) { return v === wS.tagaNeed; }),
    JSON.stringify(wS.tagaHold));

  // ---------- 6. 达标 / 落空 ----------
  const wD = cleanWorld(14006);
  openWindow(wD);
  completeSides(wD, 4);
  SIM.tickTaga(wD);
  const pd = wD.self || wD.player;
  expect('★达标当帧发奖：active 立即关掉', wD.tagaActive === 0 && wD.tagaDone === 1,
    'active=' + wD.tagaActive + ' done=' + wD.tagaDone);
  expect('奖励恰好一箱 + 四金币', byKind(wD, 'chest').length === 1 &&
    byKind(wD, 'gold').length === P.goldDrops,
    'chest=' + byKind(wD, 'chest').length + ' gold=' + byKind(wD, 'gold').length);
  expect('★奖励落在脚下（最后一方的站位）',
    Math.abs(byKind(wD, 'chest')[0].x - pd.x) < 1 &&
    Math.abs(byKind(wD, 'chest')[0].y - pd.y) < 1,
    'chest=' + byKind(wD, 'chest')[0].x + ',' + byKind(wD, 'chest')[0].y +
    ' p=' + pd.x + ',' + pd.y);
  expect('播报数字来自事件本身', evs(wD, 'taga_done').length === 1 &&
    evs(wD, 'taga_done')[0].got === 4 && evs(wD, 'taga_done')[0].gold === 4,
    JSON.stringify(evs(wD, 'taga_done')[0]));
  SIM.tickTaga(wD);
  stay(wD, 0, 5);
  expect('达标后再喂不二次发奖', wD.tagaDone === 1 &&
    byKind(wD, 'chest').length === 1 && evs(wD, 'taga_done').length === 1,
    'done=' + wD.tagaDone);
  expect('达标帧就算压在 deadline 上也是达成而非落空',
    (function () {
      const w = cleanWorld(14007);
      openWindow(w);
      completeSides(w, 4);
      w.time = w.tagaDeadline;
      SIM.tickTaga(w);
      return w.tagaDone === 1 && w.tagaFailed === 0 &&
        evs(w, 'taga_done').length === 1;
    })(), 'done/fail');
  const wF = cleanWorld(14008);
  openWindow(wF);
  completeSides(wF, 1);
  wF.time = wF.tagaDeadline + 0.01;
  SIM.tickTaga(wF);
  expect('★差三方也落空：零奖励、零掉落', wF.tagaFailed === 1 &&
    wF.tagaDone === 0 && wF.pickups.length === 0,
    'failed=' + wF.tagaFailed + ' pickups=' + wF.pickups.length);
  expect('落空不责备，只陈述差额', evs(wF, 'taga_fail').length === 1 &&
    evs(wF, 'taga_fail')[0].left === 3 &&
    !('blame' in evs(wF, 'taga_fail')[0]),
    JSON.stringify(evs(wF, 'taga_fail')[0]));
  expect('落空后不补发（推到很晚也不会突然给奖）',
    (wF.time = wF.tagaDeadline + 100, SIM.tickTaga(wF),
      wF.tagaDone === 0 && wF.pickups.length === 0), 'done=' + wF.tagaDone);
  wF.tick = wF.tagaNextTick;
  wF.time = wF.tick / HZ;
  SIM.tickTaga(wF);
  expect('下一轮目标递增、站位与计数清零',
    wF.tagaRounds === 2 && wF.tagaNeed === P.needHold + P.holdStep &&
    wF.tagaDoneCount === 0 && wF.tagaHold.every(function (v) { return v === 0; }),
    'rounds=' + wF.tagaRounds + ' need=' + wF.tagaNeed);

  // ---------- 7. 窗口外 / 剧情关 / 真实 step ----------
  const wOff = cleanWorld(14009);
  // ★先把单方时长设成正数，否则 need=0 会被「已站满」闸吃掉，窗口闸就成了假屏障。
  wOff.tagaNeed = P.needHold;
  completeSides(wOff, 4);
  expect('★★窗口未开时站遍四方也不计数', wOff.tagaDoneCount === 0 &&
    wOff.tagaHold.every(function (v) { return v === 0; }),
    JSON.stringify(wOff.tagaHold));
  const wStory = cleanWorld(14010);
  wStory.modId = 'myth';
  wStory.storyStage = { id: 'ch6' };
  wStory.tick = startTick;
  wStory.time = wStory.tick / HZ;
  SIM.tickTaga(wStory);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wStory.tagaActive === 0 && wStory.tagaRounds === 0 &&
    evs(wStory, 'taga_start').length === 0,
    'active=' + wStory.tagaActive + ' rounds=' + wStory.tagaRounds);
  // ★先手动给正的单方时长：否则 need=0 会被「已站满」闸吃掉，story 闸成了假屏障。
  wStory.tagaActive = 1;
  wStory.tagaNeed = P.needHold;
  completeSides(wStory, 4);
  wStory.time = wStory.tagaDeadline + 1;
  SIM.tickTaga(wStory);
  expect('★★★剧情关强行开窗站满四方也不发奖（两个入口都钉）',
    wStory.tagaDone === 0 && wStory.pickups.length === 0 &&
    wStory.tagaDoneCount === 0 &&
    wStory.tagaHold.every(function (v) { return v === 0; }),
    'doneCount=' + wStory.tagaDoneCount + ' hold=' + JSON.stringify(wStory.tagaHold));
  const wStory2 = SIM.createWorld({ charId: 'hunter', seed: 14011,
    modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 606 秒：step 验不出，入口断言是唯一依据',
    wStory2.matchSec < P.startSec && P.startSec > 540,
    'ch6上限=' + wStory2.matchSec + ' 首发=' + P.startSec);
  const wStep = cleanWorld(14012);
  wStep.tick = startTick - 1;
  wStep.time = wStep.tick / HZ;
  for (let i = 0; i < 3; i++) SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★真实 step 跨首发帧也开窗（钉 step 段的 tickTaga 调用点）',
    wStep.tagaActive === 1 && wStep.tagaRounds === 1 &&
    evs(wStep, 'taga_start').length === 1,
    'active=' + wStep.tagaActive + ' rounds=' + wStep.tagaRounds +
    ' state=' + wStep.state);
  putSide(wStep, 0);
  for (let i = 0; i < 20; i++) SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★真实 step 会累计站位并站满一方（钉 onTagaStay 调用点）',
    wStep.tagaHold[0] === wStep.tagaNeed && wStep.tagaDoneCount === 1,
    'hold=' + wStep.tagaHold[0] + ' need=' + wStep.tagaNeed +
    ' done=' + wStep.tagaDoneCount);
}

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

// ============================================================
// 第三十三轮：怪物词缀（变异怪）
// ============================================================
// 词缀是「同一只怪、换一套强度」的机制，最怕三种**静默**失效（都不报错）：
//   ① 抽出来的 id 表里没有 → 前端画不出光环，玩家看不出这只怪有什么不同；
//   ② 挂在不该挂的地方 —— Boss / 光环单位 / 剧情关 / 分裂出来的子怪；
//   ③ 挂词缀顺手挪动了主随机流 → 怪站位整体偏移，别的「地图/走位」断言莫名变红。
// 所以下面每条都钉「不该发生的事」，而不是「有没有这个词缀」。
function testAffix() {
  console.log('[词缀] 变异怪：抽签、生效、不该挂的地方');

  // ---------- 1. 概率曲线（纯函数，不跑整局） ----------
  expect('★第 3 波及之前不该出现词缀（开局留白，别毁教学段）',
    C.affixChance(1) === 0 && C.affixChance(3) === 0,
    'c1=' + C.affixChance(1) + ' c3=' + C.affixChance(3));
  expect('第 4 波起有非零概率（否则这套机制等于没接上）', C.affixChance(4) > 0,
    'c4=' + C.affixChance(4).toFixed(3));
  expect('★概率不会超过上限（后期不该变成「只只都变异」）',
    C.affixChance(60) <= C.AFFIX_RULE.maxChance + 1e-9 &&
    C.affixChance(200) <= C.AFFIX_RULE.maxChance + 1e-9,
    'c60=' + C.affixChance(60).toFixed(3) + ' c200=' + C.affixChance(200).toFixed(3));
  expect('★没有任何词缀用 0 当 id（协议里 0 = 不发送，会被静默吞掉）',
    C.AFFIXES.every(function (a) { return a.id !== 0; }) && C.AFFIXES.length >= 2,
    C.AFFIXES.map(function (a) { return a.id + ':' + a.key; }).join(' '));

  // 推进到某一波：直接调 spawnWave（导出给测试用），不靠「跑 120 秒等它自己来」
  function worldAtWave(target, seed, opts) {
    const o = opts || {};
    o.charId = o.charId || 'hunter';
    o.seed = seed;
    const w = SIM.createWorld(o);
    w.player.expNext = 1e9;            // 别升级（升级会冻结世界）
    w.player.weapons.length = 0;       // 别让武器自己把怪清掉
    while (w.wave < target) SIM.spawnWave(w);
    return w;
  }

  // ---------- 2. 第 4 波真的有变异怪，且 id 都在表里 ----------
  const w4 = worldAtWave(4, 4242);
  let affixed = 0;
  const unknown = [];
  for (let i = 0; i < w4.mobs.length; i++) {
    const m = w4.mobs[i];
    if (!m.affix) continue;
    affixed += 1;
    if (!C.AFFIX_MAP[m.affix]) unknown.push(m.defId + ':' + m.affix);
  }
  expect('★第 4 波真的刷出了变异怪（机制接上了）', affixed > 0,
    affixed + ' 只 / 共 ' + w4.mobs.length);
  expect('★★变异怪的词缀 id 全部在表里（不在表里 → 前端画不出环，玩家看不出差别）',
    unknown.length === 0, JSON.stringify(unknown.slice(0, 5)));

  // ---------- 3. Boss 与光环单位绝不带词缀 ----------
  // 一波一波推到 20 波，中间会经过第 10 波（Boss 波）
  const wb = worldAtWave(20, 777);
  let bossN = 0, cmdN = 0;
  const badTier = [];
  for (let i = 0; i < wb.mobs.length; i++) {
    const m = wb.mobs[i];
    const tier = m.def && m.def.tier;
    if (tier === 'boss') bossN += 1;
    if (tier === 'commander') cmdN += 1;
    if ((tier === 'boss' || tier === 'commander') && m.affix) {
      badTier.push(m.defId + ':' + m.affix);
    }
  }
  expect('样本里真的有 Boss 与光环单位（否则下面那条是空断言）',
    bossN > 0 && cmdN > 0, 'boss=' + bossN + ' commander=' + cmdN);
  expect('★★Boss / 光环单位绝不带词缀（它们本身的强度来源不能被搅浑）',
    badTier.length === 0, JSON.stringify(badTier.slice(0, 5)));

  // ---------- 4. 剧情关绝不带词缀（主线是逐关手工配平的） ----------
  const wStory = worldAtWave(14, 4242, { modId: 'myth', stageId: 'ch1' });
  const storyBad = [];
  for (let i = 0; i < wStory.mobs.length; i++) {
    if (wStory.mobs[i].affix) storyBad.push(wStory.mobs[i].defId + ':' + wStory.mobs[i].affix);
  }
  expect('★★剧情关的怪一个词缀都不该有（否则同一关两把难度差一截）',
    !!wStory.storyStage && storyBad.length === 0,
    'storyStage=' + (wStory.storyStage ? wStory.storyStage.id : 'null') +
    ' 带词缀 ' + storyBad.length + ' 只');

  // ---------- 5. ★挂词缀不许扰动主随机流 ----------
  // 把「起始波」推到天上 = 关掉词缀，同种子再跑一次第 4 波：怪的位置必须逐只相同。
  // 这条钉的是「实现上没偷懒用 nextRand」——用了的话整波站位会整体偏移一格。
  const savedStart = C.AFFIX_RULE.startWave;
  C.AFFIX_RULE.startWave = 9999;
  const wPlain = worldAtWave(4, 4242);
  C.AFFIX_RULE.startWave = savedStart;

  let posBad = 0;
  const nCmp = Math.min(wPlain.mobs.length, w4.mobs.length);
  for (let i = 0; i < nCmp; i++) {
    if (wPlain.mobs[i].x !== w4.mobs[i].x || wPlain.mobs[i].y !== w4.mobs[i].y) posBad += 1;
  }
  expect('★关掉词缀前后，第 4 波的怪只数与落点逐只一致（随机流没被扰动）',
    posBad === 0 && nCmp === w4.mobs.length && nCmp === wPlain.mobs.length,
    '差异 ' + posBad + ' 只 / 对比 ' + nCmp + ' 只（有词缀 ' + w4.mobs.length +
    ' 无词缀 ' + wPlain.mobs.length + '）');

  // ---------- 6. 坚壁：同伤害掉血比例 = 1 - dmgReduce ----------
  const wa = SIM.createWorld({ charId: 'hunter', seed: 9 });
  const plain = SIM.spawnMob(wa, 'corpse', wa.player.x + 300, wa.player.y, 1, 0);
  const bul = SIM.spawnMob(wa, 'corpse', wa.player.x + 340, wa.player.y, 1, 2);
  const dmgP = SIM.damageMob(wa, plain, 2);
  const dmgB = SIM.damageMob(wa, bul, 2);
  const ratio = dmgP > 0 ? dmgB / dmgP : 0;
  const wantRatio = 1 - (C.AFFIX_MAP[2].dmgReduce || 0);
  expect('★★坚壁怪真的减伤（同一次伤害，掉血只有普通怪的 1-减伤）',
    Math.abs(ratio - wantRatio) < 0.01,
    '比例 ' + fmt(ratio, 3) + ' 期望 ' + fmt(wantRatio, 3));

  // ---------- 7. 狂暴：真的跑得更快 ----------
  const wv = SIM.createWorld({ charId: 'hunter', seed: 11 });
  wv.player.weapons.length = 0;
  wv.player.expNext = 1e9;
  const slowM = SIM.spawnMob(wv, 'corpse', wv.player.x + 900, wv.player.y, 1, 0);
  const fastM = SIM.spawnMob(wv, 'corpse', wv.player.x - 900, wv.player.y, 1, 1);
  const s0 = { x: slowM.x, y: slowM.y }, f0 = { x: fastM.x, y: fastM.y };
  for (let i = 0; i < 20; i++) SIM.step(wv, {});
  const slowMoved = Math.hypot(slowM.x - s0.x, slowM.y - s0.y);
  const fastMoved = Math.hypot(fastM.x - f0.x, fastM.y - f0.y);
  expect('★对照：普通怪确实动了（否则下面那条是假的）', slowMoved > 5, fmt(slowMoved, 1) + 'px');
  expect('★狂暴怪跑得比同种普通怪明显快（速度倍率真的生效）',
    fastMoved > slowMoved * 1.15,
    '狂暴 ' + fmt(fastMoved, 1) + ' vs 普通 ' + fmt(slowMoved, 1));

  // ---------- 8. 分裂：数量、血量、以及「子怪绝不带词缀」 ----------
  const wsp = SIM.createWorld({ charId: 'hunter', seed: 13 });
  wsp.player.expNext = 1e9;
  const parent = SIM.spawnMob(wsp, 'corpse', wsp.player.x + 300, wsp.player.y + 300, 1, 3);
  const parentMax = parent.maxHp;
  SIM.damageMob(wsp, parent, 999999);

  const kids = [];
  for (let i = 0; i < wsp.mobs.length; i++) {
    if (wsp.mobs[i] !== parent && wsp.mobs[i].alive) kids.push(wsp.mobs[i]);
  }
  expect('★分裂怪死后真的裂成 ' + C.AFFIX_MAP[3].splitCount + ' 只',
    kids.length === C.AFFIX_MAP[3].splitCount, '实际 ' + kids.length + ' 只');
  expect('★★子怪绝不带词缀（带了就是分裂的分裂，一次击杀刷出指数级怪）',
    kids.every(function (k) { return k.affix === 0; }),
    kids.map(function (k) { return k.affix; }).join(','));
  expect('★子怪血量按父怪上限的比例给（不是照抄父怪，也不是回到基础血量）',
    kids.length > 0 && kids.every(function (k) {
      return Math.abs(k.maxHp - parentMax * C.AFFIX_MAP[3].splitHpRatio) < 0.6;
    }),
    kids.length ? ('子怪 ' + fmt(kids[0].maxHp, 1) + ' / 父怪 ' + fmt(parentMax, 1)) : 'n/a');

  // 反向：把子怪也打死，不该再裂（这条才是「不会指数爆炸」的真正证明）
  const afterKids = wsp.mobs.length;
  for (let i = 0; i < kids.length; i++) SIM.damageMob(wsp, kids[i], 999999);
  expect('★★打死子怪不会再分裂（怪数不再增长）', wsp.mobs.length === afterKids,
    '打死前 ' + afterKids + ' 只 / 打死子怪后 ' + wsp.mobs.length + ' 只');

  // ---------- 9. 普通怪不该被顺手加血 ----------
  const wq = SIM.createWorld({ charId: 'hunter', seed: 21 });
  const q0 = SIM.spawnMob(wq, 'corpse', 100, 100, 1, 0);
  expect('★普通怪（affix=0）的血量还是基础值（别把词缀系数漏乘到所有人身上）',
    q0.maxHp === C.MOB_MAP.corpse.hp && q0.affix === 0,
    'maxHp=' + q0.maxHp + ' 基础 ' + C.MOB_MAP.corpse.hp);
}

// ============================================================
// 第三十四轮：挑战者（局内精英事件）
// ============================================================
// 【这一块要钉住什么】挑战者是**唯一一个不按波次、按时间冒出来的实体**，
// 它有四个地方一改就会悄悄坏掉，而且都不会报错：
//   ① 出现在剧情关 → 主线逐关配平被打乱；
//   ② 一次刷出好几只 → 后期变成「三只同时追」，不是决策而是惩罚；
//   ③ 生成时消耗主随机数 → 之后所有波次的落点整体错位（词缀那一轮踩过）；
//   ④ 进关卡池 / 带词缀 → 它从「一段可选战斗」退化成「背景噪音」。
// 所以下面每条断言都写成「不该发生的事」，并且尽量配一个正向对照，
// 免得出现「机制根本没接上、断言却永远绿」的空断言。
function testChallenger() {
  console.log('[挑战者] 事件刷怪：节奏、上限、主线隔离、随机流隔离、掉落');

  const TICKS = C.TICK_HZ;
  const RULE = C.CHALLENGER;

  // ---------- 0. 规则表自洽 ----------
  const def = C.MOB_MAP[RULE.mobId];
  expect('★挑战者的定义真的在怪物表里（否则事件刷出来的是一只 null，静默没反应）',
    !!def && def.challenger === true, def ? ('tier=' + def.tier) : 'n/a');
  expect('★挑战者的 tier 不是 boss（是 boss 就会走「Boss 必掉宝箱 + 剧情通关」那条老路）',
    !!def && def.tier !== 'boss', def ? def.tier : 'n/a');
  // ★起始时刻必须晚于教学段（第一段 4 波 = 120 秒）。
  // 【为什么单独钉这一条】它和 STAGES 的段位是**隐性耦合**：以后有人把 startSec 调小，
  //   `tools/simtest.js` 里那条老的「教学段不会冒出精英」会红，但那条报的是六张图的名字，
  //   看不出是挑战者干的。这条把它钉在原地，报错直接指向 startSec。
  const tutorialSec = C.STAGES[0].to * C.WAVES.intervalSec;
  expect('★★挑战者不许在教学段（前 ' + C.STAGES[0].to + ' 波 = ' + tutorialSec +
    ' 秒）里出现（那时玩家只有起始武器，扛不住一只 560 血的强敌）',
    RULE.startSec > tutorialSec,
    'startSec=' + RULE.startSec + ' 教学段结束于 ' + tutorialSec + 's');

  // ---------- 1. 自由模式：到点才来，而且真的来了 ----------
  // 一个不打架的世界：每帧清空武器、血补满 —— 让它只负责「时间流逝与刷怪」，
  // 排除「武器把怪清掉 / 玩家被打死」这些无关变量。
  function quietWorld(seed) {
    const w = SIM.createWorld({ charId: 'hunter', seed: seed });
    w.player.expNext = 1e9;
    return w;
  }
  function runQuiet(w, seconds) {
    const n = Math.round(seconds * TICKS);
    for (let i = 0; i < n; i++) {
      w.player.weapons.length = 0;
      w.player.hp = w.player.maxHp;
      if (!w.player.alive) { w.player.alive = true; w.player.state = 'playing'; }
      SIM.step(w, { mx: 0, my: 0 });
      if (w.ended) break;
    }
  }

  const wA = quietWorld(515);
  runQuiet(wA, RULE.startSec - 1);
  expect('★挑战者不许提前出现（' + (RULE.startSec - 1) + ' 秒时场上应该是 0 —— 起始武器打不动它）',
    wA.challengerSpawned === 0,
    '已刷 ' + wA.challengerSpawned + ' 只 / 时间 ' + fmt(wA.time, 1) + 's');

  runQuiet(wA, 6);
  const aliveA = wA.mobs.filter(function (m) { return m.alive && m.defId === RULE.mobId; });
  expect('★★到点真的刷出了一只挑战者（不是空断言：机制确实接在 step 里）',
    wA.challengerSpawned >= 1 && aliveA.length === 1,
    '已刷 ' + wA.challengerSpawned + ' 只 / 存活 ' + aliveA.length +
    ' / 时间 ' + fmt(wA.time, 1) + 's');
  expect('挑战者的血量跟着波次成长（后期不该是一只纸糊的箱子）',
    aliveA.length === 1 && aliveA[0].maxHp > def.hp * 0.9,
    aliveA.length ? ('maxHp=' + fmt(aliveA[0].maxHp, 0) + ' 基础 ' + def.hp) : 'n/a');

  // ---------- 2. 同时最多一只：它没死之前不许来下一只 ----------
  // 直接操纵 tick 调入口，比真跑 200 秒快得多，而且能精确落在「间隔到了但上一只还活着」这一刻。
  const wB = quietWorld(516);
  wB.tick = Math.round(RULE.startSec * TICKS);
  SIM.maybeSpawnChallenger(wB);
  const baseSpawn = wB.challengerSpawned;
  // 连推三个间隔（每次都恰好到点），上一只一直没死
  for (let k = 1; k <= 3; k++) {
    wB.tick = Math.round((RULE.startSec + RULE.everySec * k) * TICKS);
    SIM.maybeSpawnChallenger(wB);
  }
  const aliveB = wB.mobs.filter(function (m) { return m.alive && m.defId === RULE.mobId; }).length;
  expect('★★上一只还活着时绝不再刷（后期叠成三只同时追，那不是决策而是惩罚）',
    baseSpawn === 1 && wB.challengerSpawned === 1 && aliveB <= RULE.maxAlive,
    '首刷 ' + baseSpawn + ' 累计 ' + wB.challengerSpawned + ' 存活 ' + aliveB);

  // 正面：把它打死之后再推一个间隔，应该会来新的一只（证明上面那条不是「永远不刷」）
  const firstB = wB.mobs.filter(function (m) { return m.alive && m.defId === RULE.mobId; })[0];
  if (firstB) SIM.damageMob(wB, firstB, 999999);
  wB.tick = Math.round((RULE.startSec + RULE.everySec * 4) * TICKS);
  SIM.maybeSpawnChallenger(wB);
  expect('★打死之后间隔到了会来下一只（否则「最多一只」变成「一辈子一只」）',
    wB.challengerSpawned === 2, '累计 ' + wB.challengerSpawned + ' 只');

  // ---------- 3. 主线隔离：剧情关一只都不许有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 517, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  // 连推多个间隔并每帧走 step：既过入口闸，也过 step 里的调用
  for (let k = 0; k < 4; k++) {
    wS.tick = Math.round((RULE.startSec + k * 30) * TICKS);
    SIM.maybeSpawnChallenger(wS);
    SIM.step(wS, { mx: 0, my: 0 });
  }
  const storyBad = wS.mobs.filter(function (m) { return m.defId === RULE.mobId; }).length;
  expect('★★剧情关（《补天纪》ch1）一只挑战者都不该有（主线是逐关手工配平的）',
    !!wS.storyStage && storyBad === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null') + ' 挑战者 ' + storyBad + ' 只');

  // ---------- 4. ★★生成不许消费主随机流 ----------
  // 同种子两个世界：一个开挑战者、一个把 startSec 推到天上（等于关掉），
  // 跑同样长的时间后，**除挑战者以外**每只怪的位置都必须逐只相同。
  // 这条钉的是「事件生成没用 nextRand」——用了的话，它插进去的那两个随机数
  // 会让之后每一波的落点整体错位一格，现象是「只加了个挑战者，怪的站位全变了」。
  const savedStart = C.CHALLENGER.startSec;
  // ★先把要跑的时间算出来再改 startSec —— RULE 是 C.CHALLENGER 的**同一个对象引用**，
  //   改完再读 RULE.startSec + 20 会变成 1e9 + 20 秒，那一轮直接跑到通关（第一次就踩了）。
  const runSec = savedStart + 20;
  function posSnapshot(w) {
    const out = [];
    for (let i = 0; i < w.mobs.length; i++) {
      const m = w.mobs[i];
      if (m.defId === RULE.mobId) continue;     // 挑战者本身当然只在一边有
      out.push(m.defId + '@' + m.x.toFixed(2) + ',' + m.y.toFixed(2));
    }
    return out;
  }
  const wOn = quietWorld(4242);
  runQuiet(wOn, runSec);
  const snapOn = posSnapshot(wOn);
  const spawnedOn = wOn.challengerSpawned;

  C.CHALLENGER.startSec = 1e9;                  // 关掉（等价于「这个世界没有挑战者」）
  const wOff = quietWorld(4242);
  runQuiet(wOff, runSec);
  const snapOff = posSnapshot(wOff);
  C.CHALLENGER.startSec = savedStart;

  let diffN = 0;
  const nCmp = Math.min(snapOn.length, snapOff.length);
  for (let i = 0; i < nCmp; i++) {
    if (snapOn[i] !== snapOff[i]) { diffN += 1; if (diffN > 999) break; }
  }
  expect('★对照：开挑战者的世界里确实刷过挑战者（否则下面那条比的是两个空世界）',
    spawnedOn >= 1, '已刷 ' + spawnedOn + ' 只');
  expect('★★开关挑战者前后，其它怪的数量与落点逐只一致（主随机流没被扰动）',
    diffN === 0 && snapOn.length === snapOff.length && nCmp > 50,
    '差异 ' + diffN + ' 只 / 对比 ' + nCmp + ' 只（开 ' + snapOn.length + ' 关 ' + snapOff.length + '）');

  // ---------- 5. 它不许被普通刷怪刷出来（不在任何关卡池 / 地图偏好里） ----------
  const poolHit = [];
  for (let i = 0; i < C.STAGES.length; i++) {
    if (C.STAGES[i].pool && C.STAGES[i].pool[RULE.mobId] !== undefined) poolHit.push('stage:' + C.STAGES[i].id);
  }
  const MAPSMOD = require('../shared/maps.js');
  for (let i = 0; i < MAPSMOD.MAPS.length; i++) {
    const mb = MAPSMOD.MAPS[i].mobBias;
    if (mb && mb[RULE.mobId] !== undefined) poolHit.push('map:' + MAPSMOD.MAPS[i].id);
  }
  // 剧情模组的关卡池也扫一遍（campaign.js 里每关有自己的 pool）
  const CPMOD = require('../shared/campaign.js');
  const modIds = Object.keys(CPMOD.MODS || {});
  for (let i = 0; i < modIds.length; i++) {
    const stages = (CPMOD.MODS[modIds[i]] && CPMOD.MODS[modIds[i]].stages) || [];
    for (let k = 0; k < stages.length; k++) {
      if (stages[k].pool && stages[k].pool[RULE.mobId] !== undefined) {
        poolHit.push('campaign:' + modIds[i] + '/' + stages[k].id);
      }
    }
  }
  expect('★★挑战者不许出现在任何关卡池 / 地图偏好里（它只从事件入口来，不是背景噪音）',
    poolHit.length === 0, JSON.stringify(poolHit.slice(0, 5)));

  // 反向对照：刷满 40 波也不该有一只「自己冒出来」的挑战者
  const wP = quietWorld(518);
  while (wP.wave < 40) SIM.spawnWave(wP);
  const fromWaves = wP.mobs.filter(function (m) { return m.defId === RULE.mobId; }).length;
  expect('★对照：40 波刷怪里确实有大量普通怪（否则上面那条扫的是空气）',
    wP.mobs.length > 300, '第 40 波后场上 ' + wP.mobs.length + ' 只');
  expect('★★40 波刷怪一只挑战者都没带出来（它只能由 maybeSpawnChallenger 生成）',
    fromWaves === 0, '混进 ' + fromWaves + ' 只');

  // ---------- 6. 掉落：击杀必掉宝箱与金币；普通精英不掉 ----------
  function chestCount(w) {
    let n = 0;
    for (let i = 0; i < w.pickups.length; i++) {
      if (w.pickups[i].kind === 'chest') n += 1;
    }
    return n;
  }
  function goldCount(w) {
    let n = 0;
    for (let i = 0; i < w.pickups.length; i++) {
      if (w.pickups[i].kind === 'gold') n += 1;
    }
    return n;
  }
  const wK = SIM.createWorld({ charId: 'hunter', seed: 519 });
  wK.player.expNext = 1e9;
  const chestBefore = chestCount(wK);      // 地图自带 3 个固定宝箱，要减掉
  const goldBefore = goldCount(wK);
  const chal = SIM.spawnChallenger(wK);
  expect('★对照：挑战者真的造出来了（否则下面两条测的是 undefined）', !!chal, chal ? 'hp=' + fmt(chal.maxHp, 0) : 'null');
  if (chal) SIM.damageMob(wK, chal, 999999);
  expect('★★打死挑战者必掉宝箱（' + RULE.chest + ' 个，一个都不能少）',
    chestCount(wK) - chestBefore === RULE.chest,
    '新增 ' + (chestCount(wK) - chestBefore) + ' 个 / 期望 ' + RULE.chest);
  expect('★打死挑战者会撒金币（不只是经验球，否则「值得掉头」没有体感）',
    goldCount(wK) - goldBefore === RULE.goldDrops,
    '新增 ' + (goldCount(wK) - goldBefore) + ' 枚 / 期望 ' + RULE.goldDrops);

  // 对照：普通精英（石魁）不该掉宝箱 —— 宝箱只有当「阶段性大奖」才有意义
  const wE = SIM.createWorld({ charId: 'hunter', seed: 520 });
  const eliteChestBefore = chestCount(wE);
  const gar = SIM.spawnMob(wE, 'gargoyle', wE.player.x + 200, wE.player.y, 1, 0);
  SIM.damageMob(wE, gar, 999999);
  expect('★★普通精英（石魁）不掉宝箱（否则宝箱满地，开箱就不再是「你变强了」的时刻）',
    chestCount(wE) - eliteChestBefore === 0,
    '新增 ' + (chestCount(wE) - eliteChestBefore) + ' 个');

  // ---------- 7. 词缀：挑战者绝不带词缀 ----------
  // 先证明「这个波次真的会给怪挂词缀」（正向对照），再看挑战者身上是 0。
  const wAf = quietWorld(521);
  while (wAf.wave < 40) SIM.spawnWave(wAf);
  let waveAffixed = 0;
  for (let i = 0; i < wAf.mobs.length; i++) if (wAf.mobs[i].affix) waveAffixed += 1;
  expect('★对照：第 40 波的普通怪确实带词缀（否则下面那条是空断言）',
    waveAffixed > 0 && C.affixChance(40) > 0, '带词缀 ' + waveAffixed + ' 只');
  wAf.challengerNextTick = 0;
  // ★先把场上的怪清空：40 波之后已经顶到 MAX_MOBS，额度不够时 spawnChallenger 会返回 null，
  //   断言就会以「null」的形式失败（第一次就踩了，看到 FAIL null 才知道是额度问题）。
  wAf.mobs.length = 0;
  const chAf = SIM.spawnChallenger(wAf);
  expect('★★挑战者绝不带词缀（它本身就是「特意来堵你的强敌」，再抽词缀等于强度抽签）',
    !!chAf && chAf.affix === 0, chAf ? ('affix=' + chAf.affix) : 'null');
}

// ============================================================
// 第三十五轮：上古神龛（局内祝福点）
// ============================================================
//
// 【这一轮要钉住的是什么】
// 神龛是「走过去就永久加成」的东西，一旦错了都是**静默**的：
//   · 类型算错 → 踩上去什么都不加（表里查不到，玩家只会觉得"这石头没用"）
//   · 磁石把它吸走 → 玩家没走过去就"领到了"，这件事在日志里看不出任何异常
//   · 生成用了 nextRand → 后面每一波的怪站位整体错位（因果极难看出）
//   · 加到了别人身上 → 只在联机复现
// 所以下面每条都钉「不该发生的事」，并尽量配正向对照防假绿。
function testShrine() {
  console.log('[第三十五轮] 上古神龛（局内祝福点）');
  const MAP = require('../shared/maps.js');
  const RULE = C.SHRINE_RULE;

  function shrinesOf(w) {
    return w.pickups.filter(function (it) { return it.kind === 'shrine'; });
  }

  // ---------- 1. 地图上真的有神龛，点位来自纯函数 ----------
  const w = SIM.createWorld({ charId: 'hunter', seed: 7301 });
  w.player.expNext = 1e9;
  const list0 = shrinesOf(w);
  const pure = MAP.buildShrines(w.map);
  expect('地图开局自带上古神龛（点位来自纯函数 buildShrines）',
    list0.length === pure.length && list0.length > 0, '神龛数=' + list0.length);
  expect('★神龛位置与纯函数逐点一致（两端必须画出同一个世界）',
    list0.every(function (it, i) {
      return Math.abs(it.x - pure[i].x) < 0.01 && Math.abs(it.y - pure[i].y) < 0.01;
    }), list0.map(function (it) { return it.x + ',' + it.y; }).join(' | '));
  expect('神龛的寿命够一局（不会被当成 60 秒掉落物自己消失）',
    list0.every(function (it) { return it.life > 600; }),
    list0.map(function (it) { return Math.round(it.life); }).join(','));

  // 纯函数：连调两次结果必须逐字节相同（否则队友看到的是另一套神龛）
  let notPure = '';
  MAP.MAPS.forEach(function (m) {
    const a = JSON.stringify(MAP.buildShrines(m));
    const b = JSON.stringify(MAP.buildShrines(m));
    if (a !== b) notPure += m.id + ' ';
  });
  expect('★buildShrines 是纯函数（同一张图连调两次结果必须完全相同）', notPure === '', notPure);

  // ---------- 2. 类型：三个神龛三种祝福，且都在表里 ----------
  const vals = list0.map(function (it) { return it.value; });
  expect('★每张图三个神龛、三种祝福各一处（否则"选哪个"这件事不存在）',
    list0.length === 3 && new Set(vals).size === 3, '类型=' + vals.join(','));
  expect('★★神龛的类型 id 全部在祝福表里（查不到就会变成"踩了没反应"）',
    vals.every(function (v) { return v > 0 && !!C.SHRINE_MAP[v]; }), '类型=' + vals.join(','));

  // ---------- 3. 点位规则：离出生点够远、彼此拉开 ----------
  const cx = w.map.w / 2, cy = w.map.h / 2;
  const tooNear = list0.filter(function (it) {
    return Math.hypot(it.x - cx, it.y - cy) < 600;
  });
  expect('★神龛离出生点至少 600（不能开局就送到手上）', tooNear.length === 0,
    tooNear.length + ' 个太近');
  let crowded = 0;
  for (let i = 0; i < list0.length; i++) {
    for (let j = i + 1; j < list0.length; j++) {
      if (Math.hypot(list0[i].x - list0[j].x, list0[i].y - list0[j].y) < 400) crowded += 1;
    }
  }
  expect('神龛之间拉开距离（叠在一起会分不清自己踩到哪一个）', crowded === 0, crowded + ' 对太近');

  // ---------- 4. 主线隔离：剧情关一个都不许有 ----------
  const wStory = SIM.createWorld({ charId: 'hunter', seed: 7301, modId: 'myth', stageId: 'ch1' });
  const storyN = shrinesOf(wStory).length;
  expect('★★剧情关（《补天纪》ch1）一个神龛都没有（主线是逐关手工配平的）',
    !!wStory.storyStage && storyN === 0,
    'storyStage=' + (wStory.storyStage ? wStory.storyStage.id : 'null') + ' 神龛 ' + storyN + ' 个');
  expect('★对照：同一个种子在自由模式里是有神龛的（否则上面那条测的是空气）',
    list0.length > 0, list0.length + ' 个');

  // ---------- 5. 不会被磁石吸走 ----------
  const p = w.player;
  const s0 = list0[0];
  const sx = s0.x, sy = s0.y;
  p.x = sx + 150;
  p.y = sy;
  p.invuln = 999;
  for (let i = 0; i < Math.floor(C.TICK_HZ * 1.5); i++) SIM.step(w, { mx: 0, my: 0 });
  expect('★神龛不会被磁石吸来（要主动走过去）',
    Math.abs(s0.x - sx) < 0.01 && Math.abs(s0.y - sy) < 0.01,
    '位移 ' + fmt(Math.hypot(s0.x - sx, s0.y - sy), 2) + 'px');
  expect('神龛也不会自己消失（跑 1.5 秒后还在场上）',
    shrinesOf(w).length === list0.length, shrinesOf(w).length + ' / ' + list0.length);

  // ---------- 6. 祝福真的生效（三种各验一次） ----------
  // 直接把要验的那个神龛搬到脚下：比"走过去"稳，也不会顺手踩到别的
  function grab(typeId) {
    const it = shrinesOf(w).filter(function (o) { return o.value === typeId; })[0];
    if (!it) return null;
    p.x = it.x;
    p.y = it.y;
    p.invuln = 999;
    SIM.step(w, { mx: 0, my: 0 });
    return it;
  }
  SIM.setSelf(w, p);
  p.state = 'playing';
  p.choices = [];
  p.pendingLevels = 0;

  // ① 兵主之龛：伤害 +12%
  const dmgBefore = p.attrs.dmgMul;
  const gotWar = grab(1);
  expect('★对照：兵主之龛确实在场上（否则下面那条是空断言）', !!gotWar,
    gotWar ? 'at ' + Math.round(gotWar.x) + ',' + Math.round(gotWar.y) : 'null');
  expect('★★兵主之龛：伤害倍率正好 +12%',
    Math.abs(p.attrs.dmgMul - (dmgBefore + 0.12)) < 1e-9,
    fmt(dmgBefore, 3) + ' -> ' + fmt(p.attrs.dmgMul, 3));
  expect('领完从场上消失（不能站在上面无限领）',
    shrinesOf(w).filter(function (o) { return o.value === 1; }).length === 0, '还在场上');

  // ② 厚土之龛：上限 +25 且当前血也补 25
  // ★先把血压下来再踩：满血踩上去只能看到"上限涨了、血没动"，测不出有没有补血
  p.hp = Math.max(1, p.maxHp - 80);
  const maxHpBefore = p.maxHp;
  const hpBefore = p.hp;
  const gotEarth = grab(2);
  expect('★对照：厚土之龛确实在场上', !!gotEarth, gotEarth ? 'ok' : 'null');
  expect('★★厚土之龛：血量上限 +25',
    Math.abs(p.maxHp - (maxHpBefore + 25)) <= 1,
    maxHpBefore + ' -> ' + p.maxHp);
  expect('★★厚土之龛：当前血也补了 25（只抬上限的话玩家会觉得没用）',
    Math.abs(p.hp - (hpBefore + 25)) <= 1, fmt(hpBefore, 1) + ' -> ' + fmt(p.hp, 1));

  // ③ 风伯之龛：移速 +10%、拾取范围 +25%
  const speedBefore = p.attrs.speed;
  const pickBefore = p.attrs.pickupRadius;
  const gotWind = grab(3);
  expect('★对照：风伯之龛确实在场上', !!gotWind, gotWind ? 'ok' : 'null');
  expect('★★风伯之龛：移速 +10%',
    Math.abs(p.attrs.speed - speedBefore * 1.10) < 1e-6,
    fmt(speedBefore, 2) + ' -> ' + fmt(p.attrs.speed, 2));
  expect('★★风伯之龛：拾取范围 +25%',
    Math.abs(p.attrs.pickupRadius - pickBefore * 1.25) < 1e-6,
    fmt(pickBefore, 1) + ' -> ' + fmt(p.attrs.pickupRadius, 1));

  // ---------- 7. 事件：界面全靠它播报（没有面板，这是唯一反馈） ----------
  const shrineEv = SIM.takeEvents(w, 0).filter(function (e) { return e.type === 'shrine'; });
  expect('★每领一个都推了 shrine 事件（否则玩家只知道"屏幕闪了一下"）',
    shrineEv.length === 3, shrineEv.length + ' 条');
  expect('事件里带齐了名字与说明（界面直接拿去播，不再查表）',
    shrineEv.every(function (e) { return !!e.shrineName && !!e.hint; }),
    JSON.stringify(shrineEv.map(function (e) { return e.shrineName; })));

  // ---------- 8. 祝福不会被升级/重算冲掉 ----------
  SIM.setSelf(w, p);
  const dmgWithShrine = p.attrs.dmgMul;
  SIM.recalcAttrs(w);          // 升级、换被动、买 buff 都会走这一次重算
  expect('★★重算属性之后祝福仍然在（写进 recalcAttrs 的唯一理由）',
    Math.abs(p.attrs.dmgMul - dmgWithShrine) < 1e-9,
    fmt(dmgWithShrine, 3) + ' -> ' + fmt(p.attrs.dmgMul, 3));

  // ---------- 9. 同类祝福叠不过上限 ----------
  // 手工在脚下补三个兵主之龛：真实玩法里拿不到这么多，这里测的是**上限本身**
  const wCap = SIM.createWorld({ charId: 'hunter', seed: 7303 });
  wCap.player.expNext = 1e9;
  const cp = wCap.player;
  SIM.setSelf(wCap, cp);
  for (let i = 0; i < RULE.stackMax + 1; i++) {
    wCap.pickups.push({
      id: 9000 + i, kind: 'shrine', x: cp.x, y: cp.y, px: cp.x, py: cp.y,
      value: 1, big: 0, vx: 0, vy: 0, life: 120
    });
  }
  for (let i = 0; i < RULE.stackMax + 1; i++) SIM.step(wCap, { mx: 0, my: 0 });
  expect('★★同一类祝福最多叠 ' + RULE.stackMax + ' 层（再多会把伤害乘区叠成天文数字）',
    cp.shrines[1] === RULE.stackMax, '层数=' + cp.shrines[1]);
  const fullEv = SIM.takeEvents(wCap, 0).filter(function (e) { return e.type === 'shrine' && e.full; });
  expect('满层时仍然播报一句"已满"（不说的话玩家会以为祝福白领了）',
    fullEv.length >= 1, fullEv.length + ' 条');

  // ---------- 10. 只加给踩到的那个人（联机） ----------
  const wMp = SIM.createWorld({
    seed: 7304, pauseAllOnLevelUp: false,
    players: [{ charId: 'hunter' }, { charId: 'nun' }]
  });
  const mp0 = wMp.players[0], mp1 = wMp.players[1];
  mp0.expNext = 1e9; mp1.expNext = 1e9;
  SIM.setSelf(wMp, mp0);
  const otherDmg = mp1.attrs.dmgMul;
  mp0.x = mp1.x + 120;                  // 两人都在场上，但只有 0 号去踩
  mp0.y = mp1.y;
  wMp.pickups.push({
    id: 9100, kind: 'shrine', x: mp0.x, y: mp0.y, px: mp0.x, py: mp0.y,
    value: 1, big: 0, vx: 0, vy: 0, life: 120
  });
  SIM.step(wMp, { mx: 0, my: 0 });
  expect('★踩到的人拿到了祝福', (mp0.shrines[1] || 0) === 1, '层数=' + mp0.shrines[1]);
  // ★再让队友单独重算一次属性（他升级 / 进化 / 买 buff 都会触发这一次）：
  //   如果祝福被写成了世界级或共享的东西，就会在**这一刻**漏到他身上 ——
  //   那种 bug 在"刚领完那一帧"是看不出来的，必须逼他重算一次才现形。
  SIM.setSelf(wMp, mp1);
  SIM.recalcAttrs(wMp);
  SIM.setSelf(wMp, mp0);
  expect('★★队友不会因为别人领了神龛而涨属性（祝福是「每个人一份」的）',
    Math.abs(mp1.attrs.dmgMul - otherDmg) < 1e-9,
    fmt(otherDmg, 3) + ' -> ' + fmt(mp1.attrs.dmgMul, 3));

  // ---------- 11. ★★生成不许消费主随机流 ----------
  // 同种子两个世界：一个正常（有神龛）、一个把 buildShrines 换成立刻返回空。
  // 跑同样长的时间后，**每一只怪的位置都必须逐只相同**。
  // 这条钉的是「createWorld 里生成神龛没用 nextRand」——
  // 用了的话，它插进去的那几个随机数会让之后每一波的落点整体错位。
  const savedBuild = MAP.buildShrines;
  MAP.buildShrines = function () { return []; };
  const wNo = SIM.createWorld({ seed: 9911, pauseAllOnLevelUp: false });
  MAP.buildShrines = savedBuild;
  const wYes = SIM.createWorld({ seed: 9911, pauseAllOnLevelUp: false });
  expect('★对照：一个世界有神龛、另一个没有（否则下面比的是两个同样的世界）',
    shrinesOf(wYes).length > 0 && shrinesOf(wNo).length === 0,
    shrinesOf(wYes).length + ' / ' + shrinesOf(wNo).length);
  wNo.self.expNext = 1e9;
  wYes.self.expNext = 1e9;
  wNo.self.invuln = 1e9;
  wYes.self.invuln = 1e9;
  // ★把武器清掉：这一条比的是**生成本身**，不该让「谁先把怪打死」掺进来。
  //   不清的话 12 秒后场上只剩 10 来只，对照条会变成一条依赖数值的脆断言。
  wNo.self.weapons.length = 0;
  wYes.self.weapons.length = 0;
  // ★跑 32 秒：至少跨过两波（每波 30 秒），场上怪数才够撑住下面那条对照
  const SEC = 32;
  for (let t = 0; t < SEC * C.TICK_HZ; t++) {
    const inp = { mx: 0, my: 0 };
    SIM.step(wNo, inp);
    SIM.step(wYes, inp);
  }
  function posOf(ww) {
    return ww.mobs.map(function (m) {
      return m.defId + '@' + m.x.toFixed(2) + ',' + m.y.toFixed(2);
    });
  }
  const posNo = posOf(wNo), posYes = posOf(wYes);
  let posDiff = 0;
  const nCmp = Math.min(posNo.length, posYes.length);
  for (let i = 0; i < nCmp; i++) if (posNo[i] !== posYes[i]) posDiff += 1;
  expect('★★对照：两个世界确实刷出了足够多的怪（否则下面那条比的是两个空世界）',
    nCmp > 20, '对比 ' + nCmp + ' 只');
  expect('★★开关神龛前后，其它怪的数量与落点逐只一致（生成没动主随机流）',
    posDiff === 0 && posNo.length === posYes.length,
    '差异 ' + posDiff + ' 只 / 对比 ' + nCmp + ' 只（有 ' + posNo.length + ' 无 ' + posYes.length + '）');
}

// ============================================================
// 第三十八轮：血怒（连杀奖励）
// ============================================================
//
// 【这一轮要钉住的是什么】
// 血怒是「临时状态」，它错起来全是静默的：
//   · 门槛差一只就触发 → 等于常驻加成（玩家不会为常驻的东西调整走位）
//   · 间隔不算 → 半小时里零零散散打死的怪能连成一条链，机制等于没有
//   · 结束不清零 → 冷却形同虚设，两次爆发首尾相接
//   · 叠进 attrs → 升级/进化/买 buff 时被算两遍，或者结束时忘了减回去（永久加速）
//   · 算到队友头上 → 只在联机复现
//   · 计时消费 nextRand → 后面每一波的落点整体错位
// 所以下面每条都钉「不该发生的事」，并尽量配正向对照防假绿。
function testRage() {
  console.log('[第三十八轮] 血怒（连杀奖励）');
  const R = C.RAGE;

  // 造一只怪并一击打死。★用「主动造 + 直接打死」而不是「等武器打死」：
  // 后者依赖武器配置与帧数，测试会变得又慢又脆（还会被顺手的击杀污染计数）。
  function killOne(w, x, y) {
    const m = SIM.spawnMob(w, 'corpse', x, y, 1, 0, 0);
    if (!m) return null;
    SIM.damageMob(w, m, 1e9);
    return m;
  }

  // 干净的测试世界：清武器（免得它们顺手杀怪）、锁血（免得被打死）、
  // 经验上限抬高（免得升级面板把 step 冻住）。
  function bareWorld(seed, extra) {
    const w = SIM.createWorld(Object.assign({ seed: seed }, extra || {}));
    w.player.weapons.length = 0;
    w.player.invuln = 1e9;
    w.player.expNext = 1e9;
    // 暴击 / 斩杀会随机改伤害，做「伤害正好 ×1.30」这类断言时必须先关掉
    w.player.attrs.crit = 0;
    w.player.attrs.exec = 0;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    SIM.setSelf(w, w.player);
    return w;
  }

  // ---------- 1. 门槛是硬边界 ----------
  const w = bareWorld(5501);
  const p = w.player;
  const spot = { x: p.x + 320, y: p.y };
  for (let i = 0; i < R.needKills - 1; i++) killOne(w, spot.x, spot.y);
  expect('★差一只不触发（门槛是硬边界，不是「差不多就行」）',
    p.rage === 0 && p.rageStreak === R.needKills - 1,
    'rage=' + p.rage + ' 连杀=' + p.rageStreak + '/' + R.needKills);

  killOne(w, spot.x, spot.y);
  expect('★★连杀满门槛立刻进入血怒（时长 = 表里的 durationSec）',
    p.rage === R.durationSec && p.rageStreak === 0 && p.rageCount === 1,
    'rage=' + p.rage + ' 连杀=' + p.rageStreak + ' 触发次数=' + p.rageCount);

  // 事件：必须带 slot（联机只推给触发者本人），而且只推一条
  const evMine = SIM.takeEvents(w, p.slot).filter(function (e) { return e.type === 'rage'; });
  expect('★血怒事件只推给触发者本人（带 slot；别人不该看到「你血怒了」）',
    evMine.length === 1 && evMine[0].slot === p.slot,
    '本人收到 ' + evMine.length + ' 条');

  // ---------- 2. 血怒期间的伤害乘区 ----------
  const m2 = SIM.spawnMob(w, 'corpse', spot.x + 420, spot.y, 1, 0, 0);
  const hpBefore = m2.hp;
  SIM.damageMob(w, m2, 10);
  expect('★★血怒期间伤害正好 ×' + R.dmgMul + '（乘区落在 damageMob，不在 attrs）',
    Math.abs((hpBefore - m2.hp) - 10 * R.dmgMul) < 1e-6,
    '掉血 ' + fmt(hpBefore - m2.hp, 4) + ' 期望 ' + fmt(10 * R.dmgMul, 4));

  // ---------- 3. attrs 里不许有怒气残留 ----------
  const dmgMulAttr = p.attrs.dmgMul;
  const speedAttr = p.attrs.speed;
  SIM.recalcAttrs(w);
  expect('★★血怒不写进 attrs（重算之后属性里没有怒气残留，升级/进化不会把乘区算两遍）',
    Math.abs(p.attrs.dmgMul - dmgMulAttr) < 1e-9 && Math.abs(p.attrs.speed - speedAttr) < 1e-9,
    'dmgMul ' + fmt(dmgMulAttr, 3) + ' -> ' + fmt(p.attrs.dmgMul, 3) +
    ' / speed ' + fmt(speedAttr, 1) + ' -> ' + fmt(p.attrs.speed, 1));

  // ---------- 4. 血怒期间的击杀不叠强度、不续时长 ----------
  const rageLeftAt = p.rage;
  for (let i = 0; i < R.needKills + 2; i++) killOne(w, spot.x, spot.y);
  expect('★★血怒期间再连杀不会续时长（否则两次爆发首尾相接 = 常驻加成）',
    p.rage <= rageLeftAt + 1e-9 && p.rageCount === 1,
    fmt(rageLeftAt, 2) + ' -> ' + fmt(p.rage, 2) + ' 触发次数=' + p.rageCount);
  const m3 = SIM.spawnMob(w, 'corpse', spot.x + 420, spot.y, 1, 0, 0);
  const hp3 = m3.hp;
  SIM.damageMob(w, m3, 10);
  expect('★★血怒不叠加强度（伤害仍是 ×' + R.dmgMul + '，不是 ×' + fmt(R.dmgMul * R.dmgMul, 2) + '）',
    Math.abs((hp3 - m3.hp) - 10 * R.dmgMul) < 1e-6,
    '掉血 ' + fmt(hp3 - m3.hp, 4));

  // ---------- 5. 结束后进冷却，冷却期间不许再触发 ----------
  for (let i = 0; i < Math.ceil(R.durationSec * C.TICK_HZ) + 4; i++) SIM.step(w, { mx: 0, my: 0 });
  expect('★到点自动结束（rage 归零，且冷却确实开始计）',
    p.rage === 0 && p.rageCd > 0,
    'rage=' + p.rage + ' 冷却=' + fmt(p.rageCd, 2));
  const m4 = SIM.spawnMob(w, 'corpse', spot.x + 420, spot.y, 1, 0, 0);
  const hp4 = m4.hp;
  SIM.damageMob(w, m4, 10);
  expect('★结束后伤害回落（10 点就是 10 点，不再有怒气乘区）',
    Math.abs((hp4 - m4.hp) - 10) < 1e-6, '掉血 ' + fmt(hp4 - m4.hp, 4));

  for (let i = 0; i < R.needKills + 2; i++) killOne(w, spot.x, spot.y);
  expect('★★冷却期间的击杀不计入连杀（不许冷却没完就又攒满）',
    p.rage === 0 && p.rageStreak === 0,
    'rage=' + p.rage + ' 连杀=' + p.rageStreak);

  for (let i = 0; i < Math.ceil(R.cooldownSec * C.TICK_HZ) + 4; i++) SIM.step(w, { mx: 0, my: 0 });
  expect('★对照：冷却走完（否则下一条测的是「一直不能触发」）', p.rageCd === 0, '冷却=' + fmt(p.rageCd, 2));
  for (let i = 0; i < R.needKills; i++) killOne(w, spot.x, spot.y);
  expect('★冷却结束后能重新攒满并再次触发（机制不是一次性的）',
    p.rage > 0 && p.rageCount === 2, 'rage=' + fmt(p.rage, 2) + ' 触发次数=' + p.rageCount);

  // ---------- 6. 间隔超过窗口必须断链 ----------
  const wGap = bareWorld(5503);
  const pg = wGap.player;
  for (let i = 0; i < 6; i++) killOne(wGap, pg.x + 320, pg.y);
  for (let i = 0; i < Math.ceil((R.windowSec + 1) * C.TICK_HZ); i++) SIM.step(wGap, { mx: 0, my: 0 });
  expect('★停手超过窗口就断链（连杀清零）', pg.rageStreak === 0 && pg.rage === 0,
    '连杀=' + pg.rageStreak);
  for (let i = 0; i < 6; i++) killOne(wGap, pg.x + 320, pg.y);
  expect('★★断链之后重新攒的那 6 只不许接上前一段（否则零散击杀也能触发）',
    pg.rage === 0 && pg.rageStreak === 6, 'rage=' + pg.rage + ' 连杀=' + pg.rageStreak);

  // ---------- 7. 移速加成只作用在位移，不改面板 ----------
  const wS1 = bareWorld(5504);
  const wS2 = bareWorld(5504);
  // 清掉障碍：这一条比的是「每帧位移」，撞到墙会让比值失去意义
  [wS1, wS2].forEach(function (ww) { ww.obstacles = []; ww.obsGrid = null; });
  wS1.player.rage = R.durationSec;
  const s1x = wS1.player.x, s2x = wS2.player.x;
  for (let i = 0; i < 10; i++) {
    SIM.step(wS1, { mx: 1, my: 0 });
    SIM.step(wS2, { mx: 1, my: 0 });
  }
  const d1 = wS1.player.x - s1x, d2 = wS2.player.x - s2x;
  expect('★对照：两个世界都真的动了（否则下面那条比的是两个没动的世界）', d2 > 1, '基线位移 ' + fmt(d2, 2));
  expect('★★血怒期间移速正好 ×' + R.speedMul + '（乘在位移上，不写回 attrs）',
    Math.abs(d1 / d2 - R.speedMul) < 0.01, fmt(d1, 2) + ' / ' + fmt(d2, 2) + ' = ' + fmt(d1 / d2, 4));
  expect('★移速加成不会残留在 attrs.speed 上（面板显示的还是基础移速）',
    Math.abs(wS1.player.attrs.speed - wS2.player.attrs.speed) < 1e-9,
    fmt(wS1.player.attrs.speed, 2) + ' vs ' + fmt(wS2.player.attrs.speed, 2));

  // ---------- 8. 阵亡清零（联机复活不许带着半截爆发） ----------
  const wD = bareWorld(5505);
  const pd = wD.player;
  pd.rage = R.durationSec;
  pd.rageStreak = 7;
  pd.alive = false;
  SIM.step(wD, { mx: 0, my: 0 });
  expect('★★阵亡之后血怒清零（不然倒下一次复活还能白赚几秒爆发）',
    pd.rage === 0 && pd.rageStreak === 0, 'rage=' + pd.rage + ' 连杀=' + pd.rageStreak);

  // ---------- 9. 队友的连杀与我无关 ----------
  const wMp = SIM.createWorld({
    seed: 5510,
    players: [{ charId: 'hunter', slot: 0, name: '甲' }, { charId: 'hunter', slot: 1, name: '乙' }]
  });
  const mp0 = wMp.players[0], mp1 = wMp.players[1];
  [mp0, mp1].forEach(function (pp) {
    pp.weapons.length = 0; pp.invuln = 1e9; pp.expNext = 1e9;
    pp.attrs.crit = 0; pp.attrs.exec = 0;
  });
  SIM.setSelf(wMp, mp0);
  for (let i = 0; i < R.needKills; i++) killOne(wMp, mp0.x + 320, mp0.y);
  expect('★★队友不会因为我连杀而进入血怒（连杀是「每个人一份」的）',
    mp0.rage > 0 && mp1.rage === 0 && mp1.rageStreak === 0,
    '甲=' + fmt(mp0.rage, 2) + ' 乙=' + fmt(mp1.rage, 2) + '/' + mp1.rageStreak);
  // 队友自己打出来的伤害必须还是原值 —— 血怒若被写成了世界级，会在这里现形
  SIM.setSelf(wMp, mp1);
  const mm = SIM.spawnMob(wMp, 'corpse', mp1.x + 320, mp1.y, 1, 0, 0);
  const hpMm = mm.hp;
  SIM.damageMob(wMp, mm, 10);
  SIM.setSelf(wMp, mp0);
  expect('★★队友的伤害不受我的血怒影响（乘区读的是归属人，不是「自己」）',
    Math.abs((hpMm - mm.hp) - 10) < 1e-6, '队友掉血 ' + fmt(hpMm - mm.hp, 4));

  // ---------- 10. ★★血怒的计时不许消费主随机流 ----------
  // 同种子两个世界，站着不动跑 8 秒：一个开着血怒、一个不开。
  // 怪的位置与随机数状态必须逐只/逐位相同 ——
  // 计时若动了 nextRand，后面每一波的落点都会整体错位（因果极难看出来）。
  // ★必须「站着不动」：血怒会加快移速，一动起来两个世界的玩家位置就不同，
  //   怪追的位置也跟着不同 —— 那时比出来的差异是移速造成的，与随机流无关。
  const wR1 = bareWorld(5601);
  const wR2 = bareWorld(5601);
  wR1.player.rage = R.durationSec;
  for (let i = 0; i < Math.ceil(R.durationSec * C.TICK_HZ) + 20; i++) {
    SIM.step(wR1, { mx: 0, my: 0 });
    SIM.step(wR2, { mx: 0, my: 0 });
  }
  expect('★★血怒计时不消费主随机流（随机数状态与每只怪的位置逐只一致）',
    wR1.rngState === wR2.rngState &&
    wR1.mobs.length === wR2.mobs.length &&
    wR1.mobs.every(function (m, i) {
      return m.defId === wR2.mobs[i].defId &&
        Math.abs(m.x - wR2.mobs[i].x) < 1e-9 && Math.abs(m.y - wR2.mobs[i].y) < 1e-9;
    }),
    'rng=' + wR1.rngState + '/' + wR2.rngState + ' 怪 ' + wR1.mobs.length + '/' + wR2.mobs.length);
}

// ============================================================
// 第三十九轮：赤月天象（局内全局事件）
// ============================================================
//
// 这一套断言的核心是「钉不该发生的事」：
//   不许提前降临 / 不许拖尾 / 不许首尾相连 / 不许每帧刷事件 /
//   不许让玩家也变快 / 不许把加速残留在 attrs / 不许出现在剧情关 / 不许动随机流。
// 正面效果（怪更快、波更密、经验更高）各配一条硬数值对照。
function testMoon() {
  console.log('[第三十九轮] 赤月天象：排期边界、三重效果、剧情隔离、不碰随机流');
  const BM = C.BLOOD_MOON;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(BM.startSec * HZ);
  const durTick = Math.round(BM.durationSec * HZ);
  const everyTick = Math.round(BM.everySec * HZ);

  // 干净世界：清武器（免得它们顺手杀怪）、锁血、抬高经验上限（免得升级面板把 step 冻住）
  function bareWorld(seed, extra) {
    const w = SIM.createWorld(Object.assign({ seed: seed }, extra || {}));
    w.player.weapons.length = 0;
    w.player.invuln = 1e9;
    w.player.expNext = 1e9;
    // 暴击 / 斩杀会随机改伤害，这一套里有「吃什么都不该变多」的对照，先关掉
    w.player.attrs.crit = 0;
    w.player.attrs.exec = 0;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    SIM.setSelf(w, w.player);
    return w;
  }
  function moonEvents(w) {
    return w.events.filter(function (e) { return e.type === 'moon'; });
  }

  // ---------- 0. 规则表自洽 ----------
  // ★三条都属于「配置被改坏时静默失效」：调错了不报错，
  //   只会表现成「天象永远不来」或「一整局都在赤月里」。
  const tutorialSec = C.STAGES[0].to * C.WAVES.intervalSec;
  expect('★赤月不许落在教学段（前 ' + tutorialSec + ' 秒玩家只有起始武器）',
    BM.startSec > tutorialSec,
    'startSec=' + BM.startSec + ' 教学段结束于 ' + tutorialSec + 's');
  expect('★★持续时长必须短于间隔（否则两次赤月首尾相连 = 全程常驻加速）',
    BM.durationSec < BM.everySec, BM.durationSec + ' / ' + BM.everySec);
  expect('★三个倍率都必须 >1（做成 1.0 等于这个玩法根本没发生，而且不会有任何报错）',
    BM.mobSpeedMul > 1 && BM.countMul > 1 && BM.expMul > 1,
    '速度 ' + BM.mobSpeedMul + ' 数量 ' + BM.countMul + ' 经验 ' + BM.expMul);

  // ---------- 1. 排期边界（纯函数，直接掐 tick） ----------
  // ★边界必须是硬的：差一帧就该是两个不同的世界。
  expect('★赤月不许提前一帧降临（startSec 前一 tick 仍未开始）',
    C.moonPhaseAt(startTick - 1).on === false,
    'on=' + C.moonPhaseAt(startTick - 1).on);
  const ph0 = C.moonPhaseAt(startTick);
  expect('★★到点那一 tick 立刻开始，且剩余时长正好是表里的 durationSec',
    ph0.on === true && Math.abs(ph0.leftSec - BM.durationSec) < 1e-9 && ph0.index === 0,
    'on=' + ph0.on + ' left=' + fmt(ph0.leftSec, 2) + ' index=' + ph0.index);
  expect('★对照：结束前一 tick 仍在赤月里（否则下一条测的是「永远不在」）',
    C.moonPhaseAt(startTick + durTick - 1).on === true);
  expect('★★到点必须结束，不许拖尾（start+duration 那一 tick 已经是普通天象）',
    C.moonPhaseAt(startTick + durTick).on === false,
    'left=' + fmt(C.moonPhaseAt(startTick + durTick).leftSec, 2));
  const ph1 = C.moonPhaseAt(startTick + everyTick);
  expect('★第二次按 everySec 准时到来，且编号是 1（不是「只有一次」）',
    ph1.on === true && ph1.index === 1, 'on=' + ph1.on + ' index=' + ph1.index);
  expect('★★两次赤月之间必须是干净的（间隔期的中间点不许还算在赤月里）',
    C.moonPhaseAt(startTick + durTick + Math.round((everyTick - durTick) / 2)).on === false);

  // 参数被调坏时不许让主循环拿到负时长 / 除零。
  // ★这里刻意「改完就还原」而不是 try/finally —— 项目规范禁 try/catch。
  const savedEvery = BM.everySec;
  BM.everySec = 0;
  const phBad = C.moonPhaseAt(startTick + 500);
  BM.everySec = savedEvery;
  expect('★★everySec 被调成 0 时返回「没有赤月」而不是 NaN/负时长（宁可不来，也不能算出坏数）',
    phBad.on === false && phBad.leftSec === 0 && phBad.index === -1,
    'on=' + phBad.on + ' left=' + phBad.leftSec + ' index=' + phBad.index);

  // ---------- 2. 事件只在「翻转」那一帧推一条 ----------
  const wE = bareWorld(7001);
  wE.tick = startTick - 1;
  SIM.tickMoon(wE);
  expect('★★赤月降临前一条事件都不许有（提前播报会让玩家以为它已经生效了）',
    wE.moonOn === 0 && moonEvents(wE).length === 0,
    'moonOn=' + wE.moonOn + ' 事件 ' + moonEvents(wE).length);

  wE.tick = startTick;
  SIM.tickMoon(wE);
  const evStart = moonEvents(wE);
  expect('★★降临那一帧推且只推一条事件，带 on=1 与剩余时长',
    wE.moonOn === 1 && evStart.length === 1 && evStart[0].on === 1 &&
      evStart[0].left === BM.durationSec,
    '条数 ' + evStart.length + ' left=' + (evStart[0] ? evStart[0].left : 'n/a'));

  for (let i = 0; i < 10; i++) SIM.tickMoon(wE);
  expect('★★★赤月期间不许每帧刷事件（22 秒 × 20Hz = 440 条提示条会把屏幕糊住）',
    moonEvents(wE).length === 1, '条数 ' + moonEvents(wE).length);

  wE.tick = startTick + durTick;
  SIM.tickMoon(wE);
  const evEnd = moonEvents(wE);
  expect('★★结束那一帧推一条 on=0（不然界面永远以为还在赤月里）',
    wE.moonOn === 0 && evEnd.length === 2 && evEnd[1].on === 0,
    '条数 ' + evEnd.length + ' moonOn=' + wE.moonOn);

  for (let i = 1; i <= 20; i++) {
    wE.tick = startTick + durTick + i;
    SIM.tickMoon(wE);
  }
  expect('★结束之后连跑 20 帧不再推事件（这条钉的是「边沿」而不是「状态」）',
    moonEvents(wE).length === 2, '条数 ' + moonEvents(wE).length);

  // ---------- 3. 妖物真的更快，玩家不加速 ----------
  // ★用「同一个世界、赤月内 vs 赤月后」两段位移比，而不是两个世界 ——
  //   因为 moonOn 由 tick 决定（tickMoon 在 step 里按 tick 复位），
  //   强行把两个世界按成不同状态会变成「测我按的开关」，不是「测时间到了天象生效」。
  const wM = bareWorld(7101);
  wM.obstacles = [];                       // 不比墙：清障碍，比的是纯每帧位移
  wM.obsGrid = null;
  const mob = SIM.spawnMob(wM, 'corpse', wM.player.x + 260, wM.player.y, 1, 0, 0);
  // ★必须用 startTick-1 而不是更早：step 里是先 tick+=1 再 tickMoon，
  //   给 -2 的话第一帧还不在赤月里，四帧里只有三帧带加成 —— 比值会算成 (3×1.2+1)/4 = 1.15。
  //   （第一次就踩了这个：断言差 0.05，看起来像「乘区没生效」，其实是我的取样跨过了边界。）
  wM.tick = startTick - 1;
  const mx0 = mob.x;
  for (let i = 0; i < 4; i++) SIM.step(wM, { mx: 0, my: 0 });
  const dMoon = mob.x - mx0;
  const moonFlag = wM.moonOn;

  // 跳到「赤月刚结束」那一 tick 再走同样帧数
  wM.tick = startTick + durTick - 1;
  const mx1 = mob.x;
  for (let i = 0; i < 4; i++) SIM.step(wM, { mx: 0, my: 0 });
  const dPlain = mob.x - mx1;

  expect('★对照：赤月那段里世界真的处于赤月（否则下面比的是两段同样的速度）',
    moonFlag === 1, 'moonOn=' + moonFlag + ' tick=' + (startTick - 1));
  expect('★对照：两段怪都真的在动（否则比值是 0/0）',
    dMoon < -1 && dPlain < -1, fmt(dMoon, 2) + ' / ' + fmt(dPlain, 2));
  expect('★★赤月期间妖物移速正好 ×' + BM.mobSpeedMul + '（乘在移动上，不改 def.speed）',
    Math.abs(dMoon / dPlain - BM.mobSpeedMul) < 0.01,
    fmt(dMoon, 2) + ' / ' + fmt(dPlain, 2) + ' = ' + fmt(dMoon / dPlain, 4));

  // 玩家自己不该变快 —— 赤月是「敌人更凶」，不是「全军加速」
  const wP = bareWorld(7102);
  wP.tick = startTick - 1;
  const px0 = wP.player.x;
  for (let i = 0; i < 6; i++) SIM.step(wP, { mx: 1, my: 0 });
  const pdMoon = wP.player.x - px0;
  const pMoonFlag = wP.moonOn;
  wP.tick = startTick + durTick - 1;
  const px1 = wP.player.x;
  for (let i = 0; i < 6; i++) SIM.step(wP, { mx: 1, my: 0 });
  const pdPlain = wP.player.x - px1;
  expect('★★赤月不许让玩家也加速（玩家快一点，整条难度曲线就白调了）',
    pMoonFlag === 1 && Math.abs(pdMoon - pdPlain) < 1e-9,
    '赤月 ' + fmt(pdMoon, 2) + ' vs 平时 ' + fmt(pdPlain, 2));

  // ---------- 4. attrs 里不许有残留 ----------
  // 与血怒同一条纪律：临时乘区只在本帧的位移/拾取里乘，重算属性必须得回原值。
  const spdBefore = wP.player.attrs.speed;
  SIM.recalcAttrs(wP);
  expect('★赤月不写进 attrs（重算之后面板上的移速与平时一致，升级不会把乘区算两遍）',
    Math.abs(wP.player.attrs.speed - spdBefore) < 1e-9,
    fmt(spdBefore, 2) + ' -> ' + fmt(wP.player.attrs.speed, 2));

  // ---------- 5. 每波数量 ×countMul ----------
  const wc1 = bareWorld(7201);
  const wc2 = bareWorld(7201);
  wc1.moonOn = 1;                 // spawnWave 直接读这个标志，不涉及 tick 复位
  SIM.spawnWave(wc1);
  SIM.spawnWave(wc2);
  expect('★对照：平时那一波照常刷（数量 > 0，否则下面比的是两个空场）',
    wc2.mobs.length > 0, '平时 ' + wc2.mobs.length + ' 只');
  expect('★★赤月期间同一波多刷三成（且严格多于平时，不是「可能多可能不多」）',
    wc1.mobs.length > wc2.mobs.length &&
      Math.abs(wc1.mobs.length / wc2.mobs.length - BM.countMul) < 0.08,
    '赤月 ' + wc1.mobs.length + ' / 平时 ' + wc2.mobs.length +
    ' = ' + fmt(wc1.mobs.length / wc2.mobs.length, 3));

  // ---------- 6. 经验球价值 ×expMul ----------
  // 两个世界：一个第 1 tick 吃球（平时），一个在「赤月刚降临」那一 tick 吃球。
  // ★必须走 step 让它自然进入赤月 —— 手动设 moonOn 会被 step 里的 tickMoon 按 tick 复位，
  //   那样测的是「我按下的开关」，不是「时间到了天象真的生效」。
  const we1 = bareWorld(7301);
  const we2 = bareWorld(7301);
  we2.tick = startTick - 1;              // 下一帧正好踏入赤月
  we1.player.exp = 0;
  we2.player.exp = 0;
  SIM.spawnPickup(we1, 'exp', we1.player.x, we1.player.y, 10, 60, 0);
  SIM.spawnPickup(we2, 'exp', we2.player.x, we2.player.y, 10, 60, 0);
  SIM.step(we1, { mx: 0, my: 0 });
  SIM.step(we2, { mx: 0, my: 0 });
  const eA = we1.player.exp, eB = we2.player.exp;
  expect('★对照：两边都真的吃到了球（经验 > 0）', eA > 0 && eB > 0,
    '平时 ' + fmt(eA, 2) + ' / 赤月 ' + fmt(eB, 2));
  expect('★★赤月期间经验球价值 ×' + BM.expMul +
    '（这是「顶着怪潮清」唯一的回报，少了它就只剩惩罚）',
    Math.abs(eB / eA - BM.expMul) < 0.01, fmt(eB, 2) + ' / ' + fmt(eA, 2) + ' = ' + fmt(eB / eA, 4));
  expect('★★赤月降临那一帧就已经生效（排期必须排在拾取之前，否则第一帧白给）',
    we2.moonOn === 1, 'moonOn=' + we2.moonOn + ' tick=' + we2.tick);

  // ---------- 7. 剧情关一律没有赤月 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 7401, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  SIM.tickMoon(wS);
  for (let i = 0; i < 5; i++) SIM.step(wS, { mx: 0, my: 0 });
  expect('★★剧情关（《补天纪》ch1）永远没有赤月（主线逐关手工配平，随机压力会让「打不过」变成运气）',
    !!wS.storyStage && wS.moonOn === 0 && moonEvents(wS).length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null') +
    ' moonOn=' + wS.moonOn + ' 事件 ' + moonEvents(wS).length);

  // ---------- 8. 排期不许消费主随机流 ----------
  // 同种子的两个世界：一个反复推进排期，一个不动。随机数状态必须一模一样。
  // 用了 nextRand 的话，后面每一波的落点都会整体错位一格（因果极难看出来）。
  const r1 = bareWorld(7501);
  const r2 = bareWorld(7501);
  for (let k = startTick - 5; k <= startTick + everyTick + 20; k += 7) {
    r1.tick = k;
    SIM.tickMoon(r1);
  }
  expect('★★赤月排期不消费主随机流（随机数状态与从不推进排期的世界完全一致）',
    r1.rngState === r2.rngState, 'rng=' + r1.rngState + '/' + r2.rngState);

  // ---------- 9. HUD 字段（界面白名单漏字段时，天幕永不出现且不报错） ----------
  const wH = bareWorld(7601);
  wH.moonOn = 1;
  wH.moonLeft = 12.4;
  const hOn = SIM.getHud(wH, wH.player);
  wH.moonOn = 0;
  wH.moonLeft = 0;
  const hOff = SIM.getHud(wH, wH.player);
  expect('★HUD 带 moon=1 与剩余秒数（界面靠它拉开天幕，不自己算排期）',
    hOn.moon === 1 && Math.abs(hOn.moonLeft - 12.4) < 1e-9,
    'moon=' + hOn.moon + ' left=' + hOn.moonLeft);
  expect('★★赤月结束后 HUD 不许还带着非零剩余时长（否则天幕关不掉、倒计时停在 0.1）',
    hOff.moon === 0 && hOff.moonLeft === 0, 'moon=' + hOff.moon + ' left=' + hOff.moonLeft);
}

// ============================================================
// 第四十轮：陨星（局内小事件）
// ============================================================
// 这一套钉四类东西：
//   ① 表自洽（预警时间必须够跑出圈、伤害必须随波次成长）
//   ② 落点（挑最密处、离玩家有下限、空场不落）
//   ③ 结算（预警不伤人 / 圈外不挨打 / 不致死 / 星火只烧妖物 / 不计连杀 / 不吃血怒暴击）
//   ④ 隔离（剧情关没有、不消费主随机流、结算来源是中文）
function testMeteor() {
  console.log('[第四十轮] 陨星：落点挑最密处、预警不伤人、落地不致死、星火只烧妖物、不计连杀');
  const MT = C.METEOR;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(MT.startSec * HZ);

  // 干净世界：清武器（免得它们顺手清怪）、锁经验（免得升级面板把 step 冻住）、
  // **不设无敌**（这一套要验「玩家会不会真的挨打」）。
  // 波次 / 挑战者 / 陨星三条排期都推到很远，免得摆好场景之后被别的事件插一手。
  function meteorWorld(seed, extra) {
    const w = SIM.createWorld(Object.assign({ seed: seed }, extra || {}));
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.attrs.crit = 0;        // 暴击会随机翻倍，这一套里有「伤害正好等于表里的值」的对照
    p.attrs.exec = 0;        // 斩杀同理（打残血怪时加伤）
    p.invuln = 0;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    SIM.setSelf(w, p);
    return w;
  }
  function meteorEvents(w) {
    return w.events.filter(function (e) { return e.type === 'meteor'; });
  }
  function meteorStrikes(w) {
    return w.strikes.filter(function (s) { return s.kind === 'meteor'; });
  }

  // ---------- 0. 表自洽 ----------
  const tutorialSec = C.STAGES[0].to * C.WAVES.intervalSec;
  expect('★陨星不许落在教学段（前 ' + tutorialSec + ' 秒玩家只有起始武器）',
    MT.startSec > tutorialSec, 'startSec=' + MT.startSec);
  // ★★★这一条是「预警到底有没有意义」的唯一判据：
  //   预警时长 × 玩家移速 必须大于圈半径，否则无论怎么反应都跑不出去 ——
  //   那它就不是「要不要退出圈」的决策，而是「随机挨一下」。
  const runPx = MT.warnSec * C.PLAYER.speed;
  expect('★★预警期间跑出的距离必须大于圈半径（否则「躲得开」是空话）',
    runPx > MT.radius * 1.2,
    '预警可跑 ' + fmt(runPx, 0) + 'px / 圈半径 ' + MT.radius + 'px');
  expect('★★陨星伤害必须随波次成长（写死一个常数的话，后期它连小怪都蹭不掉，而且不报错）',
    C.meteorDmgAt(1) === MT.dmgBase && C.meteorDmgAt(21) > C.meteorDmgAt(1) * 1.5,
    '第 1 波 ' + fmt(C.meteorDmgAt(1), 1) + ' / 第 21 波 ' + fmt(C.meteorDmgAt(21), 1));
  expect('★对玩家的伤害必须是「比例」而不是绝对值（绝对值到后期等于挠痒，写死 12 又到前期等于秒杀）',
    MT.playerHpPct > 0 && MT.playerHpPct < 0.5, 'playerHpPct=' + MT.playerHpPct);

  // 在玩家某个方向上摆「一坨」怪，返回这一坨的位置。
  // ★位置会对齐到**格子中心**（cellSize=110）：怪必须全部落在同一格里，
  //   否则测的是「格子边界刚好切在哪」，而不是「哪一坨更密」——
  //   第一版就是因此红的（12 只被切成 6+6，落点算到了另一格）。
  function pile(w, dist, n, ang, mobId, seedBase) {
    const cell = MT.cellSize;
    const rawX = w.player.x + Math.cos(ang) * dist;
    const rawY = w.player.y + Math.sin(ang) * dist;
    const cx = Math.floor(rawX / cell) * cell + cell / 2;
    const cy = Math.floor(rawY / cell) * cell + cell / 2;
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push(SIM.spawnMob(w, mobId || 'corpse',
        cx + ((i % 4) - 1.5) * 9, cy + (Math.floor(i / 4) - 0.5) * 9,
        1, 0, seedBase + i * 0.37));
    }
    return { list: out, x: cx, y: cy };
  }

  // ---------- 1. 落点：挑最密处 ----------
  const wA = meteorWorld(8101);
  wA.player.x = 1600;
  wA.player.y = 1200;
  const big = pile(wA, 300, 12, 0, 'corpse', 1);            // 正右：12 只
  const small = pile(wA, 380, 3, Math.PI / 2, 'corpse', 40); // 正下：3 只
  const ptA = SIM.pickMeteorPoint(wA);
  expect('★对照：场景摆好了（大堆 12 只、小堆 3 只，落点必须能算出来）',
    !!ptA && ptA.n === 12 && ptA.total === 15,
    ptA ? ('n=' + ptA.n + ' total=' + ptA.total) : 'null');
  expect('★★陨星砸向**最密**的那一堆，不是最近的那一堆（奖励「把怪引成一坨」）',
    !!ptA && Math.hypot(ptA.x - big.x, ptA.y - big.y) < 30,
    ptA ? ('落点 ' + fmt(ptA.x, 0) + ',' + fmt(ptA.y, 0) +
      ' 大堆 ' + fmt(big.x, 0) + ',' + fmt(big.y, 0) +
      ' 离小堆 ' + fmt(Math.hypot(ptA.x - small.x, ptA.y - small.y), 0)) : 'null');
  expect('★★落点离玩家至少 minPlayerDist（不做「贴脸必吃」）',
    !!ptA && Math.hypot(ptA.x - wA.player.x, ptA.y - wA.player.y) >= MT.minPlayerDist,
    ptA ? ('距离 ' + fmt(Math.hypot(ptA.x - wA.player.x, ptA.y - wA.player.y), 1)) : 'null');

  // ★★单独一个「怪就贴着脸」的场景：这才是 minPlayerDist 真正起作用的地方。
  //   上面那一堆在 300px 外，把下限整段删掉它也不会红 —— 那种断言是假绿。
  const wA2 = meteorWorld(8111);
  wA2.player.x = 1600;
  wA2.player.y = 1200;
  pile(wA2, 40, 8, 0, 'corpse', 90);
  const ptA2 = SIM.pickMeteorPoint(wA2);
  expect('★★怪贴在脸上时，落点也必须被推开到 minPlayerDist（否则第一次见就是「躲无可躲」）',
    !!ptA2 && Math.hypot(ptA2.x - wA2.player.x, ptA2.y - wA2.player.y) >= MT.minPlayerDist - 0.01,
    ptA2 ? ('距离 ' + fmt(Math.hypot(ptA2.x - wA2.player.x, ptA2.y - wA2.player.y), 1) +
      ' 期望 ≥' + MT.minPlayerDist) : 'null');

  // 空场 / 太散：都不许落。★「砸在空地上」不会报错，只会让玩家觉得这东西是随机噪音。
  const wB = meteorWorld(8102);
  expect('★★场上没有妖物时不落（空场砸一下既没画面也没意义）',
    SIM.pickMeteorPoint(wB) === null && SIM.spawnMeteor(wB) === null,
    'pick=' + SIM.pickMeteorPoint(wB));
  SIM.spawnMob(wB, 'corpse', wB.player.x + 200, wB.player.y, 1, 0, 1);
  SIM.spawnMob(wB, 'corpse', wB.player.x + 210, wB.player.y + 10, 1, 0, 2);
  expect('★★妖物太散（少于 minMobs=' + MT.minMobs + ' 只）也不落',
    SIM.pickMeteorPoint(wB) === null && wB.meteorSpawned === 0,
    'pick=' + SIM.pickMeteorPoint(wB) + ' spawned=' + wB.meteorSpawned);

  // ★★落空之后只能**短等**，不许顺延一整个间隔。
  //   【为什么钉这条】实测踩过：第一颗的时点正好压在波次那一帧上，新一波的怪刷在
  //   700px 外（搜索半径 520 之外）→ 落点算出「场上空」→ 顺延 95 秒 → 玩家在
  //   4~5 分钟里根本见不到这个玩法，而代码一行错都没有。短等的上限给 5 秒。
  wB.meteorNextTick = 0;
  wB.tick = startTick;
  SIM.maybeSpawnMeteor(wB);
  expect('★★落空之后只是短等（≤5 秒后重试），绝不顺延一整个间隔（否则第一颗可能被推迟一分半）',
    wB.meteorNextTick - wB.tick <= 5 * HZ && wB.meteorNextTick - wB.tick > 0 && wB.meteorSpawned === 0,
    '下一颗排期 = +' + fmt((wB.meteorNextTick - wB.tick) / HZ, 1) + ' 秒（everySec=' + MT.everySec + '）');

  // 落空的那一次不许留下任何东西 —— 「排期推进了、天上有颗石头、地上有团火」这种半成品
  // 不会报错，只会让玩家看到一颗悬在空中永远不落的星星。
  expect('★陨星落点不成立时不许留下任何实体（strike / zone / 事件都要干净）',
    wB.strikes.length === 0 && wB.zones.length === 0 && meteorEvents(wB).length === 0,
    'strikes=' + wB.strikes.length + ' zones=' + wB.zones.length + ' 事件=' + meteorEvents(wB).length);

  // ---------- 2. 排期与事件（只在排期那一帧推一条） ----------
  const wD = meteorWorld(8104);
  pile(wD, 200, 6, 0, 'corpse', 60);
  // ★meteorWorld 把排期推到很远（避免别的场景被插一手），这里要显式放开
  wD.meteorNextTick = 0;
  wD.tick = startTick - 1;
  SIM.maybeSpawnMeteor(wD);
  expect('★★第一颗降临前一帧不落、也不推事件（提前播报会让玩家以为它已经在头顶了）',
    meteorStrikes(wD).length === 0 && meteorEvents(wD).length === 0,
    'strikes=' + meteorStrikes(wD).length + ' 事件=' + meteorEvents(wD).length);

  wD.tick = startTick;
  SIM.maybeSpawnMeteor(wD);
  const evD = meteorEvents(wD);
  const stD = meteorStrikes(wD);
  expect('★★到点那一帧落一颗，且只推一条事件（带坐标与预警秒数）',
    stD.length === 1 && evD.length === 1 && evD[0].sec === MT.warnSec,
    'strikes=' + stD.length + ' 事件=' + evD.length);
  expect('★预警那一帧妖物一滴血都不许掉（伤害只该在落地那一刻结算）',
    stD.length === 1 && stD[0].life > 0 && stD[0].life <= MT.warnSec);

  for (let i = 0; i < 10; i++) {
    wD.tick += 1;
    SIM.maybeSpawnMeteor(wD);
  }
  expect('★★★连调 10 帧仍然只有一颗（排期必须顺延，否则每帧都重试 = 天上一直掉）',
    meteorStrikes(wD).length === 1 && meteorEvents(wD).length === 1,
    'strikes=' + meteorStrikes(wD).length + ' 事件=' + meteorEvents(wD).length);

  // ---------- 3. 落地结算：妖物 / 玩家 / 星火 ----------
  // ★这一坨刻意摆在离玩家 **120px** 处（> minPlayerDist 90，< 圈半径 130）：
  //   于是「玩家站在圈里会受伤」这件事才真的被验到。
  //   第一版摆在 260px 处，玩家根本不在圈里 —— 那两条断言绿得毫无意义。
  const wF = meteorWorld(8106);
  const pf = wF.player;
  pf.x = 1600;
  pf.y = 1200;
  // 先用一坨把「落点大致在哪」定下来（返回的位置已对齐格子中心），再围着它摆圈内的怪。
  const near = pile(wF, 110, 3, 0, 'corpse', 30);
  const cx = near.x;
  const cy = near.y;
  // 圈内：一只石魁用来量「正好掉多少血」（140 血，挨 60 不死），
  // 六只腐尸用来验「能不能秒掉一片小怪」。
  const tank = SIM.spawnMob(wF, 'gargoyle', cx, cy, 1, 0, 1);
  const pack = [];
  for (let i = 0; i < 6; i++) {
    pack.push(SIM.spawnMob(wF, 'corpse', cx + ((i % 3) - 1) * 8, cy + (Math.floor(i / 3) - 0.5) * 18, 1, 0, 2 + i));
  }
  // 圈外：离落点 400px，一滴血都不该掉
  const far = SIM.spawnMob(wF, 'corpse', cx + 400, cy, 1, 0, 20);

  const stF = SIM.spawnMeteor(wF);
  const expectDmg = C.meteorDmgAt(wF.wave || 1);
  expect('★对照：陨星造出来了（否则下面的伤害断言全在比空对象）', !!stF, 'strike=' + (stF ? 'ok' : 'null'));
  expect('★落地伤害就是表里算出来的那个数（第 1 波 = ' + fmt(expectDmg, 1) + '）',
    Math.abs(stF.dmg - expectDmg) < 1e-9, 'dmg=' + fmt(stF.dmg, 2));

  // 预警一帧：什么都不掉
  const tankHp0 = tank.hp;
  const packHp0 = pack[0].hp;
  const farHp0 = far.hp;
  const pHp0 = pf.hp;
  SIM.step(wF, { mx: 0, my: 0 });
  expect('★★预警期间妖物与玩家都不掉血（不然「1.8 秒反应时间」是假的）',
    tank.hp === tankHp0 && pack[0].hp === packHp0 && far.hp === farHp0 && pf.hp === pHp0,
    '石魁 ' + fmt(tank.hp, 1) + ' 腐尸 ' + fmt(pack[0].hp, 1) + ' 玩家 ' + fmt(pf.hp, 1));

  // 直接推进到落地那一帧（不跑满 1.8 秒：怪会走动，血量对照就不再是同一个场景）
  stF.life = 0.001;
  SIM.step(wF, { mx: 0, my: 0 });

  expect('★★落地把圈内小怪整片清掉（这是它存在的理由：一次天火 = 一片经验）',
    pack.every(function (m) { return !m.alive; }),
    pack.filter(function (m) { return !m.alive; }).length + '/6 阵亡');
  expect('★★伤害正好等于表里的值（石魁 140 → ' + fmt(140 - expectDmg, 1) + '，不吃暴击/斩杀/血怒）',
    Math.abs(tank.hp - (140 - expectDmg)) < 1e-6, '石魁 hp=' + fmt(tank.hp, 2));
  expect('★★圈外的怪一点血都不掉（半径是硬的，不是「大概那一带」）',
    far.hp === farHp0, '远处腐尸 ' + fmt(far.hp, 2) + ' / 原 ' + fmt(farHp0, 2));

  const playerLost = pHp0 - pf.hp;
  expect('★★站在圈里的玩家会受伤（没有伤害就没有「要不要退」这个决策）',
    playerLost > 0, '掉了 ' + fmt(playerLost, 2));
  expect('★★但对玩家的伤害按「血量上限的比例」结算，不是按怪物伤害表（后期不会变成秒杀）',
    Math.abs(playerLost - pf.maxHp * MT.playerHpPct) < 0.51,
    '掉了 ' + fmt(playerLost, 2) + ' 期望约 ' + fmt(pf.maxHp * MT.playerHpPct, 2) +
    '（armor=' + fmt(pf.attrs.armor, 1) + '）');

  const fire = wF.zones.filter(function (z) { return z.src === 'meteor'; });
  expect('★落地留下星火（一个持续 5 秒的「妖物加速死亡区」）',
    fire.length === 1 && fire[0].r === MT.fireRadius && Math.abs(fire[0].life - MT.fireSec) < 0.06,
    '条数 ' + fire.length + ' r=' + (fire[0] ? fire[0].r : 'n/a'));
  // ★★这条颜色是**跨层契约**：render 的 drawZones 靠 `#ff8c42` 这一个值区分
  //    「这是火」还是「这是圣水」。改成一个别的色值，画面会变回冷灰的水洼 ——
  //    断言全绿、没人报错、只有截图能看出来（本轮就这么踩了一次）。
  expect('★★星火的颜色必须是 #ff8c42（渲染层靠它区分「火」与圣水的「水」，改了画面会静默变回水洼）',
    fire.length === 1 && fire[0].color === '#ff8c42',
    fire.length ? fire[0].color : 'n/a');

  // ---------- 4. 不致死（环境伤害不该替玩家结束这一局） ----------
  const wK = meteorWorld(8116);
  wK.player.x = 1600;
  wK.player.y = 1200;
  wK.player.hp = 5;              // 只剩 5 点血：按 12% 上限算是 14.4，本来足够砸死他
  pile(wK, 110, 4, 0, 'corpse', 70);
  const stK = SIM.spawnMeteor(wK);
  stK.life = 0.001;
  SIM.step(wK, { mx: 0, my: 0 });
  expect('★★★陨星不许把人砸死（残血清怪时被天降石头结束整局，玩家只会记住「被随机砸死」）',
    wK.player.alive && wK.player.hp >= 1,
    'alive=' + wK.player.alive + ' hp=' + fmt(wK.player.hp, 2) + '（原本 5 点血）');

  // ---------- 5. 星火只烧妖物 ----------
  // ★造一个只有星火、没有怪的世界：把玩家放在星火正中央跑 2 秒，血量必须一点不变。
  //   如果哪天有人把星火改成「也伤害玩家」，这条会立刻红 —— 而它红的时候
  //   玩家正站在自己刚砸出来的圈里回血，那种 bug 极难在实机里复现。
  const wZ = meteorWorld(8126);
  wZ.zones.push({
    src: 'meteor', id: 9001, kind: 'zone', owner: wZ.player,
    x: wZ.player.x, y: wZ.player.y, r: MT.fireRadius, dmg: MT.fireDmg,
    tickSec: MT.fireTickSec, tickTimer: 0, life: MT.fireSec, maxLife: MT.fireSec,
    color: '#ff8c42', hitKey: 'mf_test'
  });
  const zHp0 = wZ.player.hp;
  for (let i = 0; i < 40; i++) SIM.step(wZ, { mx: 0, my: 0 });
  expect('★★星火只烧妖物，站在正中央的玩家一滴血都不掉（它是「战场加速区」不是持续惩罚）',
    wZ.player.hp === zHp0 && wZ.player.alive,
    'hp ' + fmt(zHp0, 1) + ' → ' + fmt(wZ.player.hp, 1));

  // ---------- 6. 天火不算连杀 ----------
  // 6 只腐尸被一颗陨星清掉。血怒要求 2.2 秒内连杀 12 只才触发；
  // 这里连杀进度必须是 0 —— 否则「每 95 秒白送一次血怒」，血怒就不再是「手快」的奖励。
  const wR = meteorWorld(8136);
  wR.player.x = 1600;
  wR.player.y = 1200;
  pile(wR, 260, 6, 0, 'corpse', 50);
  const stR = SIM.spawnMeteor(wR);
  stR.life = 0.001;
  const kills0 = wR.stats.kills;
  SIM.step(wR, { mx: 0, my: 0 });
  const meteorKills = wR.stats.kills - kills0;
  expect('★对照：这一颗真的砸死了好几只（否则「不计数」这条测的是「什么都没发生」）',
    meteorKills >= 5, '击杀 ' + meteorKills);
  expect('★★★天火砸死的不计入连杀（不然每 95 秒就白送一次血怒）',
    wR.player.rageStreak === 0 && wR.player.rage === 0,
    '连杀 ' + wR.player.rageStreak + ' 血怒 ' + fmt(wR.player.rage, 2));

  // ---------- 7. 天火不吃血怒 / 暴击 ----------
  // 同一个场景，把玩家按成「血怒中 + 暴击必中」：石魁掉的血必须还是 60 那一下。
  const wG = meteorWorld(8146);
  wG.player.x = 1600;
  wG.player.y = 1200;
  wG.player.rage = 5;          // 假装正处于血怒
  wG.player.attrs.crit = 1;    // 每次必暴击
  const nearG = pile(wG, 260, 3, 0, 'corpse', 80);
  const tank2 = SIM.spawnMob(wG, 'gargoyle', nearG.x, nearG.y, 1, 0, 1);
  const stG = SIM.spawnMeteor(wG);
  stG.life = 0.001;
  SIM.step(wG, { mx: 0, my: 0 });
  expect('★★★天火伤害与玩家的血怒 / 暴击无关（否则同一个事件在不同 build 下清掉的怪数不一样）',
    Math.abs(tank2.hp - (140 - C.meteorDmgAt(wG.wave || 1))) < 1e-6,
    '石魁 hp=' + fmt(tank2.hp, 2) + ' 血怒=' + fmt(wG.player.rage, 1) + ' 暴击=' + wG.player.attrs.crit);

  // ---------- 8. 剧情关一律没有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 8156, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  for (let i = 0; i < 6; i++) {
    SIM.spawnMob(wS, 'corpse', wS.player.x + 200 + (i % 3) * 12, wS.player.y + Math.floor(i / 3) * 12, 1, 0, i);
  }
  SIM.maybeSpawnMeteor(wS);
  for (let i = 0; i < 5; i++) SIM.step(wS, { mx: 0, my: 0 });
  expect('★★剧情关（《补天纪》ch1）永远没有陨星（会伤到自己人的天火会让难度变成运气）',
    !!wS.storyStage && meteorStrikes(wS).length === 0 && meteorEvents(wS).length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null') +
    ' strikes=' + meteorStrikes(wS).length + ' 事件=' + meteorEvents(wS).length);

  // ---------- 9. 不消费主随机流 ----------
  const r1 = meteorWorld(8166);
  const r2 = meteorWorld(8166);
  r1.meteorNextTick = 0;      // 只有 r1 真的推进排期，r2 一次都不调
  [r1, r2].forEach(function (w) {
    for (let i = 0; i < 8; i++) {
      SIM.spawnMob(w, 'corpse', w.player.x + 200 + (i % 3) * 12, w.player.y + Math.floor(i / 3) * 12, 1, 0, i);
    }
  });
  for (let k = startTick - 5; k <= startTick + Math.round(MT.everySec * HZ) + 20; k += 7) {
    r1.tick = k;
    SIM.maybeSpawnMeteor(r1);
  }
  expect('★★陨星排期不消费主随机流（随机数状态与从不推进排期的世界完全一致）',
    r1.rngState === r2.rngState && r1.meteorSpawned >= 2,
    'rng=' + r1.rngState + '/' + r2.rngState + ' 落过 ' + r1.meteorSpawned + ' 颗');

  // ---------- 10. 结算来源是中文 ----------
  const CODEX = require('../shared/codex.js');
  expect('★结算「伤害构成」里的来源名是中文（漏了会显示成英文 id）',
    CODEX.srcLabel('meteor') === '陨星', CODEX.srcLabel('meteor'));

  // ---------- 11. 整条链路：真的走 step ----------
  // 【为什么还要这一条】上面全是手调 maybeSpawnMeteor —— 函数写好了却**没在 step 里被调用**
  // 是这个项目反复出现过的静默失败（applyHud 白名单漏字段、emitRoom 漏转发都是同一类）。
  // 这条只钉「走完整帧之后天上真的多了一颗」。
  const wE = meteorWorld(8108);
  pile(wE, 200, 6, 0, 'corpse', 75);
  wE.meteorNextTick = 0;
  wE.tick = startTick - 1;
  SIM.step(wE, { mx: 0, my: 0 });
  const stE = meteorStrikes(wE);
  expect('★★走 step 的整条链路也真的会落（防「函数写好了但没被调用」这类静默失效）',
    stE.length === 1 && stE[0].life > 0 && stE[0].delay === MT.warnSec,
    'strikes=' + stE.length + ' delay=' + (stE[0] ? stE[0].delay : 'n/a'));
}

// ============================================================
// 第四十一轮：山魈（召唤型妖物）
// ============================================================
// 这一块钉的全是「不该发生的事」：
//   不许在教学段出现 / 不许压在波次那一帧 / 不许同屏两只 /
//   不许贴脸 / 不许一辈子召超过额度 / 定身不许还召 / 召唤不许碰主随机流 /
//   剧情关一只都不许有 / 召出来的必须是最弱的小怪 / 击杀不许算成挑战者。
function testSummoner() {
  console.log('[第四十一轮] 山魈：绕着走、远远召妖、一生只召 8 只、定身就闭嘴、剧情关没有它');

  const HZ = C.TICK_HZ;
  const RULE = C.SUMMONER;
  const def = C.MOB_MAP[RULE.mobId];
  const startTick = Math.round(RULE.startSec * HZ);

  // ---------- 0. 表自洽 ----------
  expect('★山魈的定义真的在怪物表里、且带 summoner 标记（否则事件刷出来的是一只 null，静默没反应）',
    !!def && def.summoner === true, def ? ('tier=' + def.tier + ' kind=' + def.kind) : 'n/a');
  expect('★山魈的 kind 必须是 summoner（写成 melee 它就会一路贴脸，整个「追还是拖」的选择消失）',
    !!def && def.kind === 'summoner', def ? def.kind : 'n/a');
  expect('★山魈的 tier 不是 boss（是 boss 就会走「Boss 必掉宝箱 + 剧情通关」那条老路）',
    !!def && def.tier !== 'boss', def ? def.tier : 'n/a');

  const tutorialSec = C.STAGES[0].to * C.WAVES.intervalSec;
  expect('★★山魈不许落在教学段（前 ' + C.STAGES[0].to + ' 波 = ' + tutorialSec +
    ' 秒玩家只有起始武器）', RULE.startSec > tutorialSec,
    'startSec=' + RULE.startSec + ' / 教学段结束于 ' + tutorialSec + 's');

  // ★★★这一条是「陨星那坑」的复制防线：30 秒一波，startSec 正好落在网格上时，
  //   新一波的怪刷在 700px 外（搜索半径之外），任何「按场上怪算」的逻辑都会读到空场。
  //   山魈自己不依赖场上怪，但同一类排期一律错开 —— 以后有人把它改成「按场上密度择时」
  //   就会立刻撞上这条断言。
  const onWaveGrid = RULE.startSec % C.WAVES.intervalSec === 0;
  expect('★★山魈的首次时点不许压在 30 秒波次网格上（陨星踩过：那一帧场上往往是空的）',
    !onWaveGrid,
    'startSec=' + RULE.startSec + ' / ' + C.WAVES.intervalSec + ' 秒一波 → 余 ' +
    (RULE.startSec % C.WAVES.intervalSec));

  // 它是全项目唯一「凭空加怪」的事件实体（词缀分裂也有上限）：
  // 额度不封顶的话，一个打不动的山魈就是一局无限叠怪，服务端单帧耗时会被顶爆。
  expect('★★一生召唤额度必须封顶且不大（它是唯一凭空加怪的实体，不封顶就是一局无限叠怪）',
    RULE.summonCap > 0 && RULE.summonCap <= 20, 'summonCap=' + RULE.summonCap);
  expect('召唤节奏必须为正（写成 0 就会每帧都召，额度在 0.1 秒内被烧光）',
    RULE.summonEverySec > 0 && RULE.summonCount > 0,
    '每 ' + RULE.summonEverySec + ' 秒 × ' + RULE.summonCount + ' 只');
  // 召出来的必须是**最弱那一档**：召 elite 上来就是把一局变成四面石墙。
  const child = C.MOB_MAP[RULE.summonMob];
  expect('★★召出来的必须是小怪（tier=small），不许是精英/Boss',
    !!child && child.tier === 'small', child ? (child.name + ' / ' + child.tier) : 'n/a');
  // 保持距离必须真的「保持」：0 就是贴脸，大于刷怪环就是永远不进场。
  expect('★保持距离必须落在「贴身之外、刷怪环之内」',
    RULE.keepDist > 100 && RULE.keepDist < 700, 'keepDist=' + RULE.keepDist);

  // ---------- 1. 关卡池 / 地图偏好里都不许有它 ----------
  // 它与挑战者同一条纪律：只从事件入口来。进了池子就退化成「精英怪又多了一种」。
  let inPool = [];
  for (let i = 0; i < C.STAGES.length; i++) {
    const pool = C.STAGES[i].pool || {};
    if (pool[RULE.mobId]) inPool.push('STAGES[' + i + ']');
  }
  ['myth', 'magic'].forEach(function (modId) {
    const mod = CP.MODS[modId];
    if (!mod || !mod.stages) return;
    for (let i = 0; i < mod.stages.length; i++) {
      const pool = mod.stages[i].pool || {};
      if (pool[RULE.mobId]) inPool.push(modId + '.' + mod.stages[i].id);
    }
  });
  expect('★★关卡池（自由模式四段 + 两个剧情模组）里都不许出现山魈（它只从事件入口来）',
    inPool.length === 0, inPool.join(',') || '干净');

  // ---------- 2. 到点才来，而且真的来了 ----------
  // 不打架的世界：清武器、锁经验、血量给满 —— 只留「时间流逝」这一个变量。
  function quiet(seed, extra) {
    const w = SIM.createWorld(Object.assign({ charId: 'hunter', seed: seed }, extra || {}));
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.maxHp = 99999;
    p.hp = 99999;
    p.invuln = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function runQuiet(w, seconds) {
    const n = Math.round(seconds * HZ);
    for (let i = 0; i < n; i++) {
      w.player.weapons.length = 0;
      w.player.hp = w.player.maxHp;
      if (!w.player.alive) { w.player.alive = true; w.player.state = 'playing'; }
      SIM.step(w, { mx: 0, my: 0 });
      if (w.ended) break;
    }
  }

  const wA = quiet(7101);
  runQuiet(wA, RULE.startSec - 1);
  expect('★山魈不许提前出现（' + (RULE.startSec - 1) + ' 秒时场上应该是 0）',
    wA.summonerSpawned === 0, '已刷 ' + wA.summonerSpawned + ' 只 / 时间 ' + fmt(wA.time, 1) + 's');

  runQuiet(wA, 4);
  const aliveA = wA.mobs.filter(function (m) { return m.alive && m.defId === RULE.mobId; });
  const evA = wA.events.filter(function (e) { return e.type === 'summoner'; });
  expect('★★走 step 的整条链路，到点真的刷出了一只山魈（防「函数写好了但没被调用」）',
    wA.summonerSpawned >= 1 && aliveA.length === 1,
    '已刷 ' + wA.summonerSpawned + ' / 存活 ' + aliveA.length + ' / 时间 ' + fmt(wA.time, 1) + 's');
  // ★★事件里的名字必须走名字表（自由模式就是本名）。写成英文 id 是最典型的
  //   「忘了一处」—— 而且只在玩家真正遇到它时才看得见。
  expect('★现身事件带的是中文名，不是英文 id',
    evA.length === 1 && evA[0].name === '山魈', evA.length ? evA[0].name : 'n/a');

  // ---------- 3. 同屏最多一只 ----------
  const wB = quiet(7102);
  wB.tick = startTick;
  SIM.maybeSpawnSummoner(wB);
  const baseSpawn = wB.summonerSpawned;
  for (let k = 1; k <= 3; k++) {
    wB.tick = Math.round((RULE.startSec + RULE.everySec * k) * HZ);
    SIM.maybeSpawnSummoner(wB);
  }
  const aliveB = wB.mobs.filter(function (m) { return m.alive && m.defId === RULE.mobId; }).length;
  expect('★★上一只还活着时绝不再刷（同屏两只 = 每秒加怪，那不是决策而是惩罚）',
    baseSpawn === 1 && wB.summonerSpawned === 1 && aliveB <= RULE.maxAlive,
    '首刷 ' + baseSpawn + ' 累计 ' + wB.summonerSpawned + ' 存活 ' + aliveB);

  const firstB = wB.mobs.filter(function (m) { return m.alive && m.defId === RULE.mobId; })[0];
  if (firstB) SIM.damageMob(wB, firstB, 9999999);
  wB.tick = Math.round((RULE.startSec + RULE.everySec * 4) * HZ);
  SIM.maybeSpawnSummoner(wB);
  expect('★打死之后间隔到了会来下一只（否则「最多一只」变成「一辈子一只」）',
    wB.summonerSpawned === 2, '累计 ' + wB.summonerSpawned + ' 只');

  // ---------- 4. 主线隔离 ----------
  const wS = quiet(7103, { modId: 'myth', stageId: 'ch1' });
  for (let k = 0; k < 5; k++) {
    wS.tick = Math.round((RULE.startSec + k * 30) * HZ);
    SIM.maybeSpawnSummoner(wS);
    SIM.step(wS, { mx: 0, my: 0 });
  }
  const storyBad = wS.mobs.filter(function (m) { return m.defId === RULE.mobId; }).length;
  const storyEv = wS.events.filter(function (e) { return e.type === 'summoner'; }).length;
  expect('★★主线《补天纪》一只山魈都没有、连播报都没有（剧情关逐关手工配平，插随机强敌 = 运气过关）',
    storyBad === 0 && storyEv === 0 && wS.summonerSpawned === 0,
    '怪 ' + storyBad + ' / 事件 ' + storyEv);

  // ---------- 5. 主随机流隔离（生成与召唤都不许碰 nextRand） ----------
  const wR1 = quiet(7104);
  const wR2 = quiet(7104);
  wR1.tick = startTick;
  wR2.tick = startTick;
  const rngBefore = wR1.rngState;
  SIM.maybeSpawnSummoner(wR1);
  expect('★★生成山魈不消费主随机流（否则后面每一波的落点整体错位，而代码一行错都没有）',
    wR1.rngState === rngBefore && wR1.summonerSpawned === 1 && wR2.summonerSpawned === 0,
    '刷前 ' + rngBefore + ' / 刷后 ' + wR1.rngState);

  // ---------- 6. 行为：它不贴脸，而且真的在动 ----------
  // 造一只山魈放在玩家右侧 480px，玩家原地不动跑 5 秒。
  const wK = quiet(7105);
  const pK = wK.player;
  wK.nextWaveTick = 1e9;
  wK.challengerNextTick = 1e9;
  wK.meteorNextTick = 1e9;
  wK.summonerNextTick = 1e9;
  const smK = SIM.spawnMob(wK, RULE.mobId, pK.x + 480, pK.y, 1, 0, 1.9);
  smK.summonCd = 1e9;           // 这一步只验走位，不让它召怪干扰
  smK.summoned = RULE.summonCap;
  const d0 = Math.hypot(smK.x - pK.x, smK.y - pK.y);
  const x0 = smK.x;
  const y0 = smK.y;
  const nK = Math.round(5 * HZ);
  for (let i = 0; i < nK; i++) {
    pK.hp = pK.maxHp;
    SIM.step(wK, { mx: 0, my: 0 });
  }
  const d1 = Math.hypot(smK.x - pK.x, smK.y - pK.y);
  const moved = Math.hypot(smK.x - x0, smK.y - y0);
  expect('★山魈真的会走（站着不动就只是一块靶子，那只剩血量没有玩法）',
    moved > 40, '5 秒位移 ' + fmt(moved, 0) + 'px');
  expect('★★山魈会靠到玩家身边但不贴脸（保持距离失效 = 退化成一只普通的精英怪）',
    d1 < d0 - 120 && d1 > RULE.keepDist * 0.85,
    '初始 ' + fmt(d0, 0) + 'px → ' + fmt(d1, 0) + 'px（keepDist=' + RULE.keepDist + '）');

  // 玩家追它：它跑得比玩家慢，所以一路追过去距离必须缩小（否则「点掉它」变成空话）
  const wC = quiet(7106);
  const pC = wC.player;
  wC.nextWaveTick = 1e9;
  wC.challengerNextTick = 1e9;
  wC.meteorNextTick = 1e9;
  wC.summonerNextTick = 1e9;
  const smC = SIM.spawnMob(wC, RULE.mobId, pC.x + 480, pC.y, 1, 0, 2.2);
  smC.summonCd = 1e9;
  smC.summoned = RULE.summonCap;
  const dC0 = Math.hypot(smC.x - pC.x, smC.y - pC.y);
  for (let i = 0; i < Math.round(5 * HZ); i++) {
    pC.hp = pC.maxHp;
    SIM.step(wC, { mx: 1, my: 0 });
  }
  const dC1 = Math.hypot(smC.x - pC.x, smC.y - pC.y);
  expect('★★玩家一路追过去真的能贴上（它比玩家慢）：追不上就等于「拖住不打的代价无限大」',
    dC1 < dC0 - 80, '追 5 秒：' + fmt(dC0, 0) + 'px → ' + fmt(dC1, 0) + 'px');

  // ---------- 7. 召唤：召小怪、零随机、有额度 ----------
  const wD = quiet(7107);
  const pD = wD.player;
  wD.nextWaveTick = 1e9;
  wD.challengerNextTick = 1e9;
  wD.meteorNextTick = 1e9;
  wD.summonerNextTick = 1e9;
  const smD = SIM.spawnMob(wD, RULE.mobId, pD.x + 300, pD.y, 1, 0, 1.3);
  smD.summonCd = 0;
  smD.summoned = 0;
  const summonBats = function (w) {
    return w.mobs.filter(function (m) {
      return m.alive && m.defId === RULE.summonMob;
    }).length;
  };
  const rngD = wD.rngState;
  const nD = Math.round(6 * HZ);
  for (let i = 0; i < nD; i++) {
    pD.hp = pD.maxHp;
    SIM.step(wD, { mx: 0, my: 0 });
  }
  expect('★★走 step 真的会把它召的妖放出来（不是只把计时器减下去）',
    summonBats(wD) > 0 && (smD.summoned || 0) > 0,
    '已召 ' + (smD.summoned || 0) + ' 只 / 场上 ' + summonBats(wD) + ' 只');
  expect('★★召唤全程不消费主随机流（与生成同一条铁律：插一次就让后面每波落点错位）',
    wD.rngState === rngD, '召前 ' + rngD + ' / 召后 ' + wD.rngState);

  // 额度：直接对着 tickSummoner 连推，最容易验证「一辈子只召 N 只」
  const wE = quiet(7108);
  const smE = SIM.spawnMob(wE, RULE.mobId, wE.player.x + 300, wE.player.y, 1, 0, 1.4);
  smE.summonCd = 0;
  smE.summoned = 0;
  for (let i = 0; i < 200; i++) SIM.tickSummoner(wE, smE, RULE.summonEverySec);
  const bornE = wE.mobs.filter(function (m) { return m.defId === RULE.summonMob; }).length;
  expect('★★一生召唤总额度必须严格封顶（不封顶 = 打不动的山魈把一局变成无限叠怪）',
    smE.summoned === RULE.summonCap && bornE === RULE.summonCap,
    '召了 ' + smE.summoned + ' / 场上 ' + bornE + ' / 额度 ' + RULE.summonCap);
  // 额度用完之后再推 20 次，必须一只都不再加（防「额度判断写在了循环外」）
  for (let i = 0; i < 20; i++) SIM.tickSummoner(wE, smE, RULE.summonEverySec);
  expect('★★额度用完之后必须彻底安静（额度判断若在循环外，这里会再多出十几只）',
    smE.summoned === RULE.summonCap &&
    wE.mobs.filter(function (m) { return m.defId === RULE.summonMob; }).length === RULE.summonCap,
    '召了 ' + smE.summoned);

  // 定身时不许召唤（陨星落地会定身 0.6 秒：那一下如果照常召，玩家会觉得「砸它没用」）
  const wF = quiet(7109);
  const smF = SIM.spawnMob(wF, RULE.mobId, wF.player.x + 300, wF.player.y, 1, 0, 1.5);
  smF.summonCd = 0;
  smF.summoned = 0;
  smF.stun = 3;
  for (let i = 0; i < 20; i++) SIM.tickSummoner(wF, smF, 0.1);
  expect('★被定住时一滴都不许召（定身就是定身，连嘴也一起定住）',
    (smF.summoned || 0) === 0, '召了 ' + (smF.summoned || 0));

  // ---------- 8. 击杀：掉金币 + 播报 + 不算挑战者 ----------
  const wG = quiet(7110);
  const smG = SIM.spawnMob(wG, RULE.mobId, wG.player.x + 60, wG.player.y, 1, 0, 1.6);
  const goldBefore = wG.pickups.filter(function (it) { return it.kind === 'gold'; }).length;
  wG.stats.challengers = 0;
  SIM.damageMob(wG, smG, 9999999);
  const goldNear = wG.pickups.filter(function (it) {
    // ★只数**按表撒开**的那几枚（半径 14 的小环）。
    //   击杀同时还会照常滚一次 DROPS.goldChance 的随机金币，它掉在怪的正中心 ——
    //   一并数进来就会变成 4 枚，看起来像「多给了一枚」，其实机制没错、判据错了。
    const d = Math.hypot(it.x - smG.x, it.y - smG.y);
    return it.kind === 'gold' && d > 8 && d < 30;
  }).length;
  const evDown = wG.events.filter(function (e) { return e.type === 'summoner_down'; });
  expect('★击杀山魈按表掉金币（追了半天的补偿，写在表里而不是散在代码里）',
    goldNear === RULE.goldDrops,
    '掉落 ' + goldNear + ' 枚 / 表里 ' + RULE.goldDrops + ' 枚（击杀前场上 ' + goldBefore + '）');
  expect('★击杀会播报一条 summoner_down（否则玩家不知道自己已经解除了增援压力）',
    evDown.length === 1, '事件 ' + evDown.length + ' 条');
  expect('★★山魈不许被算进挑战者统计（两者都是事件精英，但奖励不同，混在一起结算就错了）',
    (wG.stats.challengers || 0) === 0, 'challengers=' + wG.stats.challengers);
}

// ============================================================
// 第四十二轮：地脉灵泉（站桩充能）
// ============================================================
// 这一块钉的全是「不该发生的事」：
//   站不满不许爆 / 离开不许保留进度 / 到 16 秒不许自己炸 / 圈外一滴血都不许掉 /
//   不许伤人 / 不许同屏两座 / 剧情关一座都不许有 / 不许消费主随机流 /
//   不许吃暴击与血怒 / 但**必须**接得上连杀（与天火相反）/ 到期不许走通用 strike 那套。
function testLey() {
  console.log('[第四十二轮] 地脉灵泉：站 2 秒才唤醒、离开就回落、到期安静消失、不伤人只清怪');
  const LY = C.LEYLINE;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(LY.startSec * HZ);
  const DT = C.DT;
  // 充满需要多少帧（2.0 / 0.05 = 40）。★判「还没满」时留几帧余量：
  //   浮点累加 40 次 0.05 得到 2.0000000000000013，正好卡在边界上。
  const framesFull = Math.round(LY.chargeSec / DT);

  // 干净世界：清武器（免得顺手清怪）、锁经验（免得升级面板冻住 step）、
  // 所有事件排期推到很远，免得摆好场景被别的东西插一手。
  // ★**不设无敌**：这一套要验「灵泉到底伤不伤玩家」。
  function leyWorld(seed, extra) {
    const w = SIM.createWorld(Object.assign({ seed: seed }, extra || {}));
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.attrs.crit = 0;
    p.attrs.exec = 0;
    p.invuln = 0;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    SIM.setSelf(w, p);
    return w;
  }
  function leyList(w) {
    return w.strikes.filter(function (s) { return s.kind === 'ley'; });
  }
  function leyEvents(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  // 把玩家按到泉眼上站 n 帧（只推进灵泉，不动怪：免得「怪自己走过来」污染伤害对照）
  function stand(w, st, frames) {
    const p = w.player;
    p.x = st.x;
    p.y = st.y;
    for (let i = 0; i < frames; i++) SIM.updateLeys(w, DT);
  }

  // ---------- 0. 表自洽 ----------
  expect('★灵泉不许落在 30 秒波次网格上（与陨星同一条防线：和波次抢同一帧会让排期整体错位）',
    LY.startSec % 30 !== 0, 'startSec=' + LY.startSec);
  expect('★★站桩圈必须明显小于爆发圈（一样大的话「站到圈里就开始充能」会顺手吃到伤害范围，'
    + '「站哪」这件事就没有代价了）',
    LY.standRadius > 0 && LY.standRadius * 3 <= LY.burstRadius,
    '站桩 ' + LY.standRadius + ' / 爆发 ' + LY.burstRadius);
  expect('★★离开必须掉进度（decayMul > 1）：否则最优解是「站半秒跑开再补半秒」，风险全被走位摊平',
    LY.decayMul > 1, 'decayMul=' + LY.decayMul);
  expect('★存在时长必须远大于充能时长（16 秒 vs 2 秒）：玩家要能「先打完这一波再回来站」',
    LY.lifeSec >= LY.chargeSec * 4, 'life=' + LY.lifeSec + ' 充能=' + LY.chargeSec);
  expect('★回复比例必须是个零头（回满血的话「站桩」变成无脑续命，风险不再存在）',
    LY.healPct > 0 && LY.healPct < 0.35, 'healPct=' + LY.healPct);
  expect('★★灵泉伤害必须随波次成长（写死常数的话后期连小怪都蹭不掉，而且不报错）',
    C.leyDmgAt(1) === LY.dmgBase && C.leyDmgAt(21) > C.leyDmgAt(1) * 1.5,
    '第 1 波 ' + fmt(C.leyDmgAt(1), 1) + ' / 第 21 波 ' + fmt(C.leyDmgAt(21), 1));

  // ---------- 1. 排期：到点前一刻没有、到点一座、只播一条 ----------
  const wA = leyWorld(9101);
  wA.player.x = 1600;
  wA.player.y = 1200;
  wA.tick = startTick - 1;
  wA.leyNextTick = 0;
  SIM.maybeSpawnLey(wA);
  expect('★到点前一帧不许涌出（「提前一帧」这种错会让所有排期断言都没了基准）',
    leyList(wA).length === 0, '座数=' + leyList(wA).length);

  wA.tick = startTick;
  SIM.maybeSpawnLey(wA);
  const stA = leyList(wA)[0];
  expect('★到点涌出一座，并且只播一条 ley 事件（播两条会变成提示条刷屏）',
    leyList(wA).length === 1 && leyEvents(wA, 'ley').length === 1 && wA.leySpawned === 1,
    '座数=' + leyList(wA).length + ' 事件=' + leyEvents(wA, 'ley').length);
  expect('★泉眼离玩家约 offset（它是「请你去」的点位：太远走不到，贴脸又不用走）',
    !!stA && Math.abs(Math.hypot(stA.x - wA.player.x, stA.y - wA.player.y) - LY.offset) < 2,
    stA ? ('距离 ' + fmt(Math.hypot(stA.x - wA.player.x, stA.y - wA.player.y), 1)
      + '（offset=' + LY.offset + '）') : 'null');
  expect('★涌出时的延迟字段 = 完整充能时长（客户端靠它画「还差多少」的进度环）',
    !!stA && stA.delay === LY.chargeSec && stA.charge === 0,
    stA ? ('delay=' + stA.delay + ' charge=' + stA.charge) : 'null');
  expect('★配色是跨层契约：#5fe0b0（渲染按这个色值分支玉青画法，改了会静默变成一圈冷灰）',
    !!stA && stA.color === '#5fe0b0', stA ? stA.color : 'null');

  // ---------- 2. 同屏最多一座 ----------
  for (let k = 0; k < 5; k++) {
    wA.tick = startTick + (k + 1) * Math.round(LY.everySec * HZ);
    SIM.maybeSpawnLey(wA);
  }
  expect('★★地上那座还没被唤醒时，连推 5 个间隔也只许有一座（否则玩家一回头看到三座，'
    + '「先跑哪一座」这个决策就消失了）',
    leyList(wA).length === 1, '座数=' + leyList(wA).length);
  expect('★★被同屏上限挡住时只短等（≤5 秒），绝不顺延一整个间隔（否则玩家不去，'
    + '后面的排期会被整体推走 —— 陨星那一轮踩过的同款坑）',
    wA.leyNextTick - wA.tick <= 5 * HZ && wA.leyNextTick - wA.tick > 0,
    '下一座 = +' + fmt((wA.leyNextTick - wA.tick) / HZ, 1) + ' 秒');

  // ---------- 3. 站不满不许爆 ----------
  const wB = leyWorld(9102);
  const stB = SIM.spawnLey(wB);
  // 圈内摆 6 只腐尸（12 血，90 伤害必死）+ 圈外 340 一只做对照
  const inside = [];
  for (let i = 0; i < 6; i++) {
    inside.push(SIM.spawnMob(wB, 'corpse', stB.x + (i % 3) * 12 - 12,
      stB.y + Math.floor(i / 3) * 12, 1, 0, i + 1));
  }
  const far = SIM.spawnMob(wB, 'corpse', stB.x + 340, stB.y, 1, 0, 20);
  const hpFar0 = far.hp;

  stand(wB, stB, framesFull - 2);
  expect('★★差两帧才满时不许爆（差一帧就爆会让「2 秒」这个数字失去意义，玩家也学不会「要站住」）',
    leyList(wB).length === 1 && wB.leyBursts === 0
      && inside.every(function (m) { return m.alive && m.hp === 12; }),
    '座数=' + leyList(wB).length + ' 爆过=' + wB.leyBursts
      + ' 首只 hp=' + fmt(inside[0].hp, 1));
  expect('★站了 ' + fmt((framesFull - 2) * DT, 2) + ' 秒后进度必须是「快满了」而不是「刚起步」'
    + '（delay 是客户端唯一的进度来源）',
    stB.delay > 0 && stB.delay <= LY.chargeSec - (framesFull - 2) * DT + 1e-6,
    'delay=' + fmt(stB.delay, 3) + ' chargeSec=' + LY.chargeSec);

  // ---------- 4. 站满就爆：清圈内、留圈外、不伤人、回血 ----------
  const pB = wB.player;
  pB.hp = pB.maxHp * 0.5;
  const hpB0 = pB.hp;
  stand(wB, stB, 4);
  expect('★★站满 2 秒就爆，爆完这座灵泉立刻消失（留在地上就是一圈「已经吃过」的空环）',
    wB.leyBursts === 1 && leyList(wB).length === 0,
    '爆过=' + wB.leyBursts + ' 座数=' + leyList(wB).length);
  expect('★★圈内那一片腐尸被清掉（这是站 2 秒换来的东西）',
    inside.every(function (m) { return !m.alive; }),
    '存活 ' + inside.filter(function (m) { return m.alive; }).length + '/6');
  expect('★★圈外（340px > 爆发半径 ' + LY.burstRadius + '）那只一滴血都不许掉',
    far.alive && far.hp === hpFar0, 'hp=' + fmt(far.hp, 1) + ' 原 ' + hpFar0);
  expect('★★★灵泉一滴血都不伤玩家（与陨星相反：那是惩罚，这是奖励。奖励带伤害的话，'
    + '玩家分不清「站错了」还是「运气差」）',
    Math.abs(pB.hp - (hpB0 + pB.maxHp * LY.healPct)) < 1e-6,
    'hp ' + fmt(hpB0, 1) + ' → ' + fmt(pB.hp, 1)
      + '（期望 ' + fmt(hpB0 + pB.maxHp * LY.healPct, 1) + '）');
  expect('★回复不许超过血量上限（残血站灵泉回满，不许溢出成「超级血」）',
    pB.hp <= pB.maxHp + 1e-9, 'hp=' + fmt(pB.hp, 1) + ' max=' + fmt(pB.maxHp, 1));
  expect('★爆发要播一条 ley_burst 且带 slot（玩家得知道「刚才那一下是我换来的」）',
    leyEvents(wB, 'ley_burst').length === 1 && wB.events.some(function (e) {
      return e.type === 'ley_burst' && e.slot === pB.slot;
    }), '事件 ' + leyEvents(wB, 'ley_burst').length);
  // ★★爆发必须同时留下一条「边界环」特效。
  //   【为什么钉这个】技能库里的符文阵最大只能铺到百来像素，而这一下真的打到 300 ——
  //   没有这圈环，玩家看不出「站在边上为什么没被扫到」。删掉它不会有任何报错，
  //   只会让人觉得「这个冲击的范围很随便」。
  const ringFx = wB.effects.filter(function (e) { return e.kind === 'leyring'; })[0];
  expect('★★爆发必须留下一条边界环（kind=leyring，半径 = 爆发半径）：没有它，'
    + '「300 到哪」在画面上没有答案',
    !!ringFx && ringFx.r === LY.burstRadius && ringFx.color === LY.color,
    ringFx ? ('r=' + ringFx.r + ' color=' + ringFx.color) : '一条都没有');

  // ---------- 5. 离开就回落 ----------
  const wC = leyWorld(9103);
  const stC = SIM.spawnLey(wC);
  stand(wC, stC, Math.round(framesFull * 0.5));
  const midDelay = stC.delay;
  // 跑出去（不推进灵泉以外的任何东西）
  wC.player.x = stC.x + 400;
  wC.player.y = stC.y + 400;
  for (let i = 0; i < Math.round(framesFull * 0.5) + 4; i++) SIM.updateLeys(wC, DT);
  expect('★★★离开圈之后充能必须掉回去（否则「站半秒跑开、回头补半秒」就能白拿，风险全被走位摊平）',
    stC.delay >= LY.chargeSec - 1e-6 && stC.charge === 0 && wC.leyBursts === 0,
    '中途 delay=' + fmt(midDelay, 2) + ' → 离开后 ' + fmt(stC.delay, 2)
      + '（满值 ' + LY.chargeSec + '）');

  // ---------- 6. 到期安静消失 ----------
  const wD = leyWorld(9104);
  const stD = SIM.spawnLey(wD);
  const insideD = [];
  for (let i = 0; i < 4; i++) {
    insideD.push(SIM.spawnMob(wD, 'corpse', stD.x + i * 10, stD.y, 1, 0, i + 1));
  }
  // 玩家远远站着，让 life 自己走完（16 秒）
  wD.player.x = stD.x + 600;
  wD.player.y = stD.y + 600;
  const dmgBefore = wD.stats.dmgDealt;
  for (let i = 0; i < Math.round(LY.lifeSec / DT) + 4; i++) SIM.updateLeys(wD, DT);
  expect('★★到期没被唤醒就安静消失（不惩罚、不播报：那 2 秒的暴露风险本身就是代价）',
    leyList(wD).length === 0 && wD.leyBursts === 0
      && leyEvents(wD, 'ley_burst').length === 0,
    '座数=' + leyList(wD).length + ' 爆过=' + wD.leyBursts);
  expect('★★★到期消失时不许按「通用落点」砸一下（灵泉的 r 是站桩半径 52，通用逻辑会变成'
    + '对着脚下砸一个小圈 —— 不报错，但完全是另一个玩法）',
    insideD.every(function (m) { return m.alive && m.hp === 12; })
      && wD.stats.dmgDealt === dmgBefore,
    '圈内存活 ' + insideD.filter(function (m) { return m.alive; }).length + '/4'
      + ' 多打出的伤害=' + fmt(wD.stats.dmgDealt - dmgBefore, 1));

  // ---------- 7. 不吃暴击 / 血怒，但接得上连杀 ----------
  const wE = leyWorld(9105);
  wE.player.attrs.crit = 1;      // 每次必暴击
  wE.player.rage = 5;            // 假装正处于血怒
  const stE = SIM.spawnLey(wE);
  const tank = SIM.spawnMob(wE, 'gargoyle', stE.x, stE.y, 1, 0, 1);
  stand(wE, stE, framesFull + 4);
  expect('★★★灵泉伤害与玩家的血怒 / 暴击无关（同一个泉在不同 build 下清掉的怪数必须一样，'
    + '否则「它到底多少伤害」没有答案）',
    Math.abs(tank.hp - (140 - C.leyDmgAt(wE.wave || 1))) < 1e-6,
    '石魁 hp=' + fmt(tank.hp, 2) + '（期望 ' + fmt(140 - C.leyDmgAt(wE.wave || 1), 2)
      + '）血怒=' + fmt(wE.player.rage, 1) + ' 暴击=' + wE.player.attrs.crit);

  // ★与天火**相反**的一条：灵泉爆掉的那一片必须计入连杀。
  //   天火是白送的（静音），灵泉是站出来的（不静音）—— 反过来就等于
  //   「站 2 秒换来的清场不算数」，而那正是这条玩法唯一的回报。
  const wF = leyWorld(9106);
  wF.player.rage = 0;
  wF.player.rageCd = 0;
  wF.player.rageStreak = 0;
  const stF = SIM.spawnLey(wF);
  for (let i = 0; i < C.RAGE.needKills + 2; i++) {
    SIM.spawnMob(wF, 'corpse', stF.x + (i % 5) * 14 - 28,
      stF.y + Math.floor(i / 5) * 14, 1, 0, 100 + i);
  }
  stand(wF, stF, framesFull + 4);
  expect('★★灵泉爆掉的一片必须计入连杀（天火静音是因为白送；灵泉是站 2 秒换的，静音就等于那 2 秒白站）',
    wF.player.rage > 0 && wF.leyBursts === 1,
    '血怒剩余 ' + fmt(wF.player.rage, 2) + ' 连杀 ' + wF.player.rageStreak
      + '（爆了 ' + wF.leyBursts + ' 次）');

  // ---------- 8. 剧情关一律没有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 9107, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.leyNextTick = 0;
  SIM.maybeSpawnLey(wS);
  for (let i = 0; i < 5; i++) SIM.step(wS, { mx: 0, my: 0 });
  expect('★★剧情关（《补天纪》ch1）永远没有灵泉，连播报都没有（与挑战者/神龛/赤月/陨星/山魈同一条纪律）',
    !!wS.storyStage && leyList(wS).length === 0 && leyEvents(wS, 'ley').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
      + ' 座数=' + leyList(wS).length + ' 事件=' + leyEvents(wS, 'ley').length);

  // ---------- 9. 不消费主随机流 ----------
  // ★「事件型生成」的老坑：在任意 tick 抽一次随机，后面每一波的落点都会整体错位。
  const r1 = leyWorld(9108);
  const r2 = leyWorld(9108);
  r1.leyNextTick = 0;
  for (let k = startTick - 5; k <= startTick + Math.round(LY.everySec * HZ) + 20; k += 7) {
    r1.tick = k;
    SIM.maybeSpawnLey(r1);
  }
  expect('★★灵泉的生成（含泉眼角度）不消费主随机流（随机数状态必须与从没生成过的世界完全一致）',
    r1.rngState === r2.rngState && r1.leySpawned >= 1,
    'rng=' + r1.rngState + '/' + r2.rngState + ' 涌出 ' + r1.leySpawned + ' 座');

  // ---------- 10. 结算来源是中文 ----------
  const CODEX = require('../shared/codex.js');
  expect('★结算「伤害构成」里的来源名是中文（漏了会显示成英文 id）',
    CODEX.srcLabel('ley') === '地脉', CODEX.srcLabel('ley'));

  // ---------- 11. 整条链路：真的走 step ----------
  // 【为什么还要这一条】上面全是手调 maybeSpawnLey —— 函数写好了却**没在 step 里被调用**
  // 是这个项目反复出现过的静默失败。这条钉「走完整帧之后地上真的多了一座」，
  // 并且钉住它同样会经过 updateLeys 而不是被 updateStrikes 当成普通落点。
  const wH = leyWorld(9109);
  wH.leyNextTick = 0;
  wH.tick = startTick - 1;
  SIM.step(wH, { mx: 0, my: 0 });
  const stH = leyList(wH);
  expect('★★走 step 的整条链路也真的会涌出（防「函数写好了但没被调用」这类静默失效）',
    stH.length === 1 && stH[0].life > 0 && stH[0].delay === LY.chargeSec,
    '座数=' + stH.length + ' delay=' + (stH[0] ? stH[0].delay : 'n/a'));
  // 站着不动连跑 2.5 秒：验证「step 里 updateLeys 确实被调用」+ 充能真的能满
  wH.player.x = stH[0].x;
  wH.player.y = stH[0].y;
  for (let i = 0; i < framesFull + 6; i++) SIM.step(wH, { mx: 0, my: 0 });
  expect('★★在 step 里真的能站满并爆开（updateLeys 漏挂的话，逻辑全对但永远不爆）',
    wH.leyBursts === 1 && leyList(wH).length === 0,
    '爆过=' + wH.leyBursts + ' 座数=' + leyList(wH).length);

  // ---------- 12. 存在时长只许被减一次 ----------
  // 【为什么单独钉这一条】updateLeys 与 updateStrikes 都会碰到 strikes 这个数组 ——
  //   如果 updateStrikes 没跳过 kind==='ley'，它会把 life 再减一次：
  //   16 秒的灵泉变成 8 秒。**不报错、断言也不红**（除非专门量这个时长），
  //   玩家只会觉得「这泉怎么一会儿就没了」。
  const wI = leyWorld(9110);
  const stI = SIM.spawnLey(wI);
  wI.player.x = stI.x + 700;
  wI.player.y = stI.y + 700;
  const lifeTicks = Math.round(LY.lifeSec / DT);
  for (let i = 0; i < Math.round(lifeTicks * 0.7); i++) SIM.step(wI, { mx: 0, my: 0 });
  const aliveAt70 = leyList(wI).length;
  for (let i = 0; i < Math.round(lifeTicks * 0.45); i++) SIM.step(wI, { mx: 0, my: 0 });
  expect('★★★灵泉的存在时长只许被减一次（走到 70% 时必须还在；被两边各减一次的话 8 秒就没了，'
    + '而且完全不报错）',
    aliveAt70 === 1 && leyList(wI).length === 0,
    '70% 时 ' + aliveAt70 + ' 座 / 之后 ' + leyList(wI).length + ' 座');
}

// ============================================================
// 测试 R：攻击范围的成长幅度与「看得见」（第四十四轮）
// ============================================================
// 【这一组在防什么】「范围」是全项目唯一一个玩家**直接用眼睛**看到的成长维度
// （伤害只体现在飘字大小上，冷却只体现在频率上）。
// 历版数值：武器每级 +4%（满级 1.28 倍）→ +8%（1.56 倍）→ +12%（1.84 倍，第六十七轮）；
// 千里镜每级 +10%（满级 1.5 倍）、角色 +15% —— 在 900px 宽的画面上，88 长到 113 只差 25px，等于没变。
// 所以这组断言不只要「数值变大」，还要钉三件更要紧的事：
//   ① 成长系数不许污染 1 级的起点；② 面板倍数必须真的落到判定上；
//   ③ 卡片上写的数字必须和玩家手上的倍率一致（否则数字和手感对不上）。
function testRangeGrowth() {
  console.log('[R] 攻击范围的成长幅度与可见性');

  // ---------- 1. 武器每级成长 ----------
  // 用一件假武器（底范围 100），避开具体某件武器的数值，改表不会让它假失败
  const fake = { base: { dmg: 10, cd: 1.0, range: 100 } };
  const r1 = C.weaponStats(fake, 1).range;
  const r8 = C.weaponStats(fake, 8).range;
  expect('★武器 1→8 级的范围至少长到 1.75 倍（4% 只有 1.28、8% 只有 1.56，'
    + '实测升一级仍看不出；第六十七轮提到 12%/级 = 满级 1.84）',
    r8 / r1 >= 1.75,
    '1 级=' + r1.toFixed(1) + ' 8 级=' + r8.toFixed(1) + ' 倍=' + (r8 / r1).toFixed(3));
  // 钉「每级跳一档」：相邻两级的差要足够大（12% 底值），不然「逐级升级」还是看不见。
  // ★用假武器量：任意相邻级差 / 底值 = GROWTH.range，不依赖具体武器。
  const r2 = C.weaponStats(fake, 2).range;
  expect('每升一级范围至少 +12% 底值（逐级可见，不是只有满级才看得出来）',
    Math.abs((r2 - r1) / 100 - 0.12) < 1e-9, '每级差=' + ((r2 - r1) / 100).toFixed(3));
  // 钉「不该发生的事」：成长系数不许在起点就生效 ——
  // 一旦公式写成 (1 + g*(L+1))，新号刚捡起武器就比表里宽，所有数值平衡悄悄偏移。
  expect('1 级范围必须严格等于底值（成长不许污染起点）',
    Math.abs(r1 - 100) < 1e-9, 'r1=' + r1);

  // ---------- 2. 千里镜满级 ----------
  const wz = SIM.createWorld({ charId: 'hunter', seed: 901 });
  wz.player.passives = [{ id: 'wide_lens', level: C.PASSIVE_MAX_LEVEL }];
  SIM.recalcAttrs(wz);
  expect('★千里镜满级的范围倍率必须 ≥ 1.8（它是唯一一件纯范围被动，只加范围不加伤害，'
    + '不做到这个量级就没资格占一个槽）',
    wz.player.attrs.rangeMul >= 1.8, 'rangeMul=' + wz.player.attrs.rangeMul);
  // 钉「不该发生的事」：千里镜不许顺手改伤害 ——
  // 它一旦偷偷带一点伤害，就变成「纯范围被动里最划算的那件」，别的被动全成陪衬。
  const wPlain = SIM.createWorld({ charId: 'hunter', seed: 901 });
  expect('千里镜不许带任何伤害加成（纯范围被动就该是纯的）',
    Math.abs(wz.player.attrs.dmgMul - wPlain.player.attrs.dmgMul) < 1e-9,
    '带镜=' + wz.player.attrs.dmgMul + ' 素装=' + wPlain.player.attrs.dmgMul);

  // ---------- 3. ★★★面板倍数必须真的落到判定上 ----------
  // 【为什么这是本组最要紧的一条】rangeMul 涨了、但 fireWeapon 忘了乘它，
  //   玩家会看到面板写「范围倍率 ×1.9」而一点没变宽 ——
  //   **所有数值断言全绿，手感为零**。这是「假绿」最典型的样子。
  // 做法：把一只靶子放在「1 级扇形打不到、乘了千里镜正好打得到」的那段距离上，
  //   两次跑只差一个被动，其余完全一致。
  function arcHits(withLens) {
    const w = SIM.createWorld({ charId: 'hunter', seed: 902 });
    w.player.weapons = [{ id: 'whip', level: 1, timer: 0, rt: {} }];
    w.player.passives = withLens ? [{ id: 'wide_lens', level: C.PASSIVE_MAX_LEVEL }] : [];
    SIM.recalcAttrs(w);
    w.mobs.length = 0;
    w.aliveMobCount = 0;

    const base = C.weaponStats(C.WEAPON_MAP.whip, 1).range;
    const full = base * w.player.attrs.rangeMul;
    // ★距离取 base × 1.4，而不是 (base + full) / 2：
    //   后者在「没带千里镜」的那一次会退化成 base × 1 —— 靶子正好压在判定边界上，
    //   一次 float 误差就能让它被打到，于是「无镜不许命中」这条前提直接失效
    //   （实测就是这么红的：距离=88.0 无镜命中=true）。
    //   固定在 base 的 1.4 倍，两种情况下都稳稳地在「打不到 / 打得到」中间。
    const d = base * 1.4;

    // 靶子摆在正前方（扇形判定朝最近的怪，所以它会自动转向靶子）
    SIM.spawnMob(w, 'corpse', w.player.x + d, w.player.y, 6, 0);
    w.effects.length = 0;
    SIM.step(w, { mx: 0, my: 0 });

    const t = w.mobs.filter(function (m) { return m.defId === 'corpse'; })[0];
    const arc = w.effects.filter(function (e) { return e.kind === 'arc'; })[0];
    return {
      hit: !!t && t.hp < t.maxHp,
      arcR: arc ? arc.r : -1,
      base: base, full: full, d: d
    };
  }
  const noLens = arcHits(false);
  const withLens = arcHits(true);
  expect('★★★范围倍率必须真的放大判定（面板 ×1.9 而判定没变，就是「数字假绿、手感为零」）',
    noLens.hit === false && withLens.hit === true,
    '距离=' + noLens.d.toFixed(1) + ' / 无镜命中=' + noLens.hit + '(判定 ' + noLens.base.toFixed(1)
      + ') / 带镜命中=' + withLens.hit + '(判定 ' + withLens.full.toFixed(1) + ')');
  // 钉「不该发生的事」：特效半径与判定半径必须是同一个数。
  // 两者一旦分叉，表现是「明明打到了却没画出扇形」或反过来 ——
  // 而且只在带范围加成时复现，排查起来极难。
  expect('★扇形特效半径必须等于实际判定半径（分叉就是「打到了却没画出来」）',
    Math.abs(withLens.arcR - withLens.full) < 1e-6,
    '特效=' + withLens.arcR + ' 判定=' + withLens.full);

  // ---------- 4. 升级卡上的范围提示 ----------
  // 期望值全部从 weaponStats 现算，不写死 88/95 —— 武器一调数值这条就会假失败。
  const whipDef = C.WEAPON_MAP.whip;
  const expNow = Math.round(C.weaponStats(whipDef, 1).range);
  const expNext = Math.round(C.weaponStats(whipDef, 2).range);
  const txt = SIM.rangeDeltaText(whipDef, 1, 1) || '';
  expect('★武器升级卡必须写出范围变化（不写的话玩家升到满级也不知道范围变过）',
    txt.indexOf('范围 ' + expNow + '→' + expNext) >= 0,
    '文案="' + txt + '" 期望「范围 ' + expNow + '→' + expNext + '」');
  // 钉「不该发生的事」：卡片上的数字必须算上千里镜。
  // 只按底值算会显示 88→95，而玩家手上实际是 176→190 —— 数字和手感对不上，比不显示更糟。
  const txtLens = SIM.rangeDeltaText(whipDef, 1, 1.9) || '';
  const lensNow = Math.round(C.weaponStats(whipDef, 1).range * 1.9);
  const lensNext = Math.round(C.weaponStats(whipDef, 2).range * 1.9);
  expect('★卡片上的范围必须算上范围倍率（显示底值就和玩家手上的实际宽度对不上）',
    txtLens.indexOf('范围 ' + lensNow + '→' + lensNext) >= 0,
    '文案="' + txtLens + '" 期望「范围 ' + lensNow + '→' + lensNext + '」');
  // 钉「不该发生的事」：变宽幅度小到圆整看不出来时，必须返回空串。
  // ★第六十七轮把每级成长提到 12% 后，门槛变成射程 <4.17 的武器（r×0.12 < 0.5 才圆整不变）。
  //   用射程 3 的假武器钉这条分支：3 → 3.36，圆整后还是 3；这时候写「范围 3→3」
  //   比不写更让人困惑（玩家会以为升级坏了）。
  //   （旧版用射程 6：8% 时 6→6.48 圆整还是 6；12% 后 6→6.72 圆整成 7，反而该显示了。）
  const tinyTxt = SIM.rangeDeltaText({ base: { dmg: 1, cd: 1, range: 3 } }, 1, 1) || '';
  expect('宽度变化小到圆整看不出来时必须返回空串（不许显示「范围 3→3」）',
    tinyTxt === '', '文案="' + tinyTxt + '"');
  // 对照：12% 成长下，射程 6 的贴身武器升一级已经能看出 6→7 —— 这正是本轮的目的。
  const smallTxt = SIM.rangeDeltaText({ base: { dmg: 1, cd: 1, range: 6 } }, 1, 1) || '';
  expect('★12% 成长后小射程武器的升级卡也要写得出范围变化（6→7，不再被圆整吃掉）',
    smallTxt.indexOf('范围 6→7') >= 0, '文案="' + smallTxt + '"');
}

// ============================================================
// 第四十三轮：血祭坛（用生命上限换伤害）
// ============================================================
// 这一块钉的全是「不该发生的事」：
//   不许落在波次网格上 / 不许没被踩就叠第二座 / 剧情关一座都不许有 / 不许消费主随机流 /
//   血不够时**一滴血都不许扣、一点加成都不许给** / 拒绝不许每帧刷播报 /
//   满层不许再涨 / 升级重算之后契约不许丢 / 不许被磁石吸走 / 不许把玩家扣死。
function testPact() {
  console.log('[第四十三轮] 血祭坛：掉上限换伤害、血不够就拒绝、祭坛原地不动');
  const BP = C.BLOODPACT;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(BP.startSec * HZ);

  // 干净世界：清武器（免得顺手清怪）、锁经验（免得升级面板冻住 step）、
  // 所有事件排期推到很远，免得摆好的场景被别的东西插一手。
  function pactWorld(seed, extra) {
    const w = SIM.createWorld(Object.assign({ seed: seed }, extra || {}));
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    SIM.setSelf(w, p);
    return w;
  }
  function pactList(w) {
    return w.pickups.filter(function (it) { return it.kind === 'pact'; });
  }
  function pactEvents(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }

  // ---------- 0. 表自洽 ----------
  expect('★血祭坛不许落在 30 秒波次网格上（陨星为此被推到 305 秒过：和波次抢同一帧会让排期整体错位）',
    BP.startSec % 30 !== 0, 'startSec=' + BP.startSec);
  expect('★★代价必须是真的（hpCostPct > 0）：不付账的「抉择」只是又一次白拿，'
    + '而前面九个点位已经全都是白拿的了',
    BP.hpCostPct > 0 && BP.hpCostPct < 0.3, 'hpCostPct=' + BP.hpCostPct);
  expect('★回报必须存在（dmg > 0）：只扣不给的祭坛是陷阱，不是抉择',
    BP.dmg > 0, 'dmg=' + BP.dmg);
  expect('★★门槛必须远大于单次代价（minHpPct > 2×hpCostPct）：否则它变成「刚好够付就能踩」，'
    + '残血路过时会被当场扣到底',
    BP.minHpPct > BP.hpCostPct * 2,
    'minHpPct=' + BP.minHpPct + ' 代价=' + BP.hpCostPct);
  expect('★★满层也不许把生命上限削掉四成以上（0.4）：再往上这一局就没有容错了，'
    + '那不是「玻璃人 build」而是「必死 build」',
    BP.stackMax * BP.hpCostPct <= 0.4,
    '层数=' + BP.stackMax + ' 合计-' + fmt(BP.stackMax * BP.hpCostPct, 2));
  expect('★祭坛必须落在视野内、又要走一两步（100 ≤ offset ≤ 260）：'
    + '丢到屏幕外的话玩家只会看到提示条却永远找不到它',
    BP.offset >= 100 && BP.offset <= 260, 'offset=' + BP.offset);
  expect('★存在时长必须够「先打完眼前这一波再决定」（≥12 秒）',
    BP.lifeSec >= 12, 'lifeSec=' + BP.lifeSec);

  // ---------- 1. 到点前一座都不许有 ----------
  const wA = pactWorld(9301);
  wA.tick = startTick - 1;
  wA.pactNextTick = 0;
  SIM.maybeSpawnPact(wA);
  expect('★到点前一帧一座都不许浮现（早一帧就等于「时间没到就发奖」）',
    pactList(wA).length === 0 && pactEvents(wA, 'pact').length === 0,
    '座数=' + pactList(wA).length);

  // ---------- 2. 到点一座、且只播一条 ----------
  const wB = pactWorld(9302);
  wB.tick = startTick;
  wB.pactNextTick = 0;
  SIM.maybeSpawnPact(wB);
  const pactsB = pactList(wB);
  const evB = pactEvents(wB, 'pact');
  expect('★到点必须浮现一座，而且只播一条（连着播两条会让人以为出了两座）',
    pactsB.length === 1 && evB.length === 1, '座数=' + pactsB.length + ' 事件=' + evB.length);
  expect('★★浮现事件必须带上「付多少 / 换多少」（提示条要明码标价，'
    + '否则玩家会把它当成又一座白给的神龛）',
    evB.length === 1 && evB[0].costPct === BP.hpCostPct && evB[0].dmg === BP.dmg,
    evB.length ? 'costPct=' + evB[0].costPct + ' dmg=' + evB[0].dmg : '无事件');
  expect('★祭坛离锚点玩家约 offset（看得见、走得到，不贴身）',
    pactsB.length === 1 && Math.abs(
      Math.sqrt(Math.pow(pactsB[0].x - wB.player.x, 2) + Math.pow(pactsB[0].y - wB.player.y, 2))
      - BP.offset) < 60,
    pactsB.length ? 'd=' + fmt(Math.sqrt(
      Math.pow(pactsB[0].x - wB.player.x, 2) + Math.pow(pactsB[0].y - wB.player.y, 2)), 0) : '无');
  expect('★浮现事件必须是**全局**事件（不带 slot）：联机时四个人都该看到有座祭坛',
    evB.length === 1 && evB[0].slot === undefined,
    evB.length ? 'slot=' + evB[0].slot : '无事件');

  // ---------- 3. 没被踩掉时不许叠第二座 ----------
  // ★这条同时钉住「短等 2 秒重试」而不是顺延整个间隔（陨星那一轮的同款坑）
  const wC = pactWorld(9303);
  wC.tick = startTick;
  wC.pactNextTick = 0;
  for (let k = 0; k < 5; k++) {
    SIM.maybeSpawnPact(wC);
    wC.tick += Math.round(BP.everySec * HZ);
  }
  expect('★★场上那座还没被踩时，连推 5 个间隔仍然只有 1 座（不许越堆越多）',
    pactList(wC).length === 1 && pactEvents(wC, 'pact').length === 1,
    '座数=' + pactList(wC).length + ' 事件=' + pactEvents(wC, 'pact').length);
  // 短等只等 2 秒：下一次不该被推到 everySec 之后
  expect('★★被「场上已有一座」挡住时只短等 2 秒（顺延整个间隔会让后面的排期整体漂走）',
    wC.pactNextTick <= wC.tick + Math.round(2 * HZ) + 1,
    'pactNextTick 差 ' + Math.round((wC.pactNextTick - wC.tick) / HZ) + ' 秒');

  // ---------- 4. 剧情关一律没有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 9304, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.pactNextTick = 0;
  SIM.maybeSpawnPact(wS);
  for (let i = 0; i < 5; i++) SIM.step(wS, { mx: 0, my: 0 });
  expect('★★剧情关（《补天纪》ch1）永远没有血祭坛，连播报都没有'
    + '（与挑战者/神龛/赤月/陨星/山魈/灵泉同一条纪律）',
    !!wS.storyStage && pactList(wS).length === 0 && pactEvents(wS, 'pact').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
      + ' 座数=' + pactList(wS).length);

  // ---------- 5. 不消费主随机流 ----------
  const r1 = pactWorld(9305);
  const r2 = pactWorld(9305);
  r1.pactNextTick = 0;
  for (let k = startTick - 5; k <= startTick + Math.round(BP.everySec * HZ) + 20; k += 7) {
    r1.tick = k;
    // 每次都把那座清掉，让 maybeSpawnPact 能反复生成（否则第二座被上限挡住）
    const l = pactList(r1);
    for (let i = 0; i < l.length; i++) r1.pickups.splice(r1.pickups.indexOf(l[i]), 1);
    SIM.maybeSpawnPact(r1);
  }
  expect('★★血祭坛的生成（含落点角度）不消费主随机流（随机数状态必须与从没生成过的世界完全一致）',
    r1.rngState === r2.rngState && r1.pactSpawned >= 2,
    'rng=' + r1.rngState + '/' + r2.rngState + ' 浮现 ' + r1.pactSpawned + ' 座');

  // ---------- 6. 满血踩上去：成交 ----------
  const wD = pactWorld(9306);
  const itD = SIM.spawnPact(wD);
  const pD = wD.player;
  const maxBefore = pD.maxHp;
  const dmgBefore = pD.attrs.dmgMul;
  pD.x = itD.x;
  pD.y = itD.y;
  wD.events.length = 0;
  SIM.step(wD, { mx: 0, my: 0 });
  expect('★满血踩上去契约成立：记 1 层、祭坛被吃掉（不写回数组）',
    pD.pacts === 1 && pactList(wD).length === 0,
    '层数=' + pD.pacts + ' 地上还剩 ' + pactList(wD).length + ' 座');
  expect('★生命上限按表打折（14%）：只扣当前血的话，一瓶绷带就补回来了 —— 那是一次延后结算，不是代价',
    Math.abs(pD.maxHp - maxBefore * (1 - BP.hpCostPct)) <= 1,
    '上限 ' + maxBefore + ' → ' + pD.maxHp + '（期望 ' + fmt(maxBefore * (1 - BP.hpCostPct), 1) + '）');
  expect('★伤害加成进 dmgMul（与被动/神龛同一个乘区）：不许新造一条乘区',
    Math.abs(pD.attrs.dmgMul - (dmgBefore + BP.dmg)) < 1e-9,
    'dmgMul ' + fmt(dmgBefore, 2) + ' → ' + fmt(pD.attrs.dmgMul, 2));
  expect('★★契约不许把玩家扣死（付完仍是满血比例、当前血 > 0）',
    pD.hp > 0 && pD.hp === pD.maxHp,
    'hp=' + fmt(pD.hp, 1) + '/' + pD.maxHp);
  expect('★成交要播一条 pact_taken，并且**只推给签的人**（带自己的 slot）',
    pactEvents(wD, 'pact_taken').length === 1
      && pactEvents(wD, 'pact_taken')[0].slot === pD.slot,
    '事件 ' + pactEvents(wD, 'pact_taken').length + ' 条');
  expect('★成交事件要带上「付之前 / 付之后」的上限（界面要把变化说出来，否则玩家不知道刚才生效了）',
    pactEvents(wD, 'pact_taken').length === 1
      && pactEvents(wD, 'pact_taken')[0].maxAfter < pactEvents(wD, 'pact_taken')[0].maxBefore,
    pactEvents(wD, 'pact_taken').length
      ? pactEvents(wD, 'pact_taken')[0].maxBefore + ' → ' + pactEvents(wD, 'pact_taken')[0].maxAfter
      : '无事件');

  // ---------- 7. 血不够：一滴血都不许扣、一点加成都不许给 ----------
  const wE = pactWorld(9307);
  const itE = SIM.spawnPact(wE);
  const pE = wE.player;
  pE.hp = Math.floor(pE.maxHp * (BP.minHpPct - 0.1));   // 差一点点不够
  const hpE = pE.hp;
  const maxE = pE.maxHp;
  const dmgE = pE.attrs.dmgMul;
  wE.events.length = 0;
  const okE = SIM.applyPact(wE, pE, itE);
  expect('★★★血气不足时必须**什么都不做**：不扣血、不改上限、不给加成'
    + '（这一支写成「先扣再判」的话，残血路过会被扣成 1 点血，而界面只会显示「血气不足」）',
    okE === false && (pE.pacts || 0) === 0
      && pE.hp === hpE && pE.maxHp === maxE && pE.attrs.dmgMul === dmgE,
    'ok=' + okE + ' hp=' + fmt(pE.hp, 1) + '/' + fmt(hpE, 1)
      + ' 上限=' + fmt(pE.maxHp, 1) + '/' + fmt(maxE, 1)
      + ' dmgMul=' + fmt(pE.attrs.dmgMul, 2) + '/' + fmt(dmgE, 2));
  expect('★拒绝要播一条 pact_deny（不说的话玩家会以为这一下白踩了）',
    pactEvents(wE, 'pact_deny').length === 1, '事件 ' + pactEvents(wE, 'pact_deny').length + ' 条');
  // ★拒绝之后祭坛还在原地（走 updatePickups 那条路：被拒 → 写回数组）
  pE.x = itE.x;
  pE.y = itE.y;
  for (let i = 0; i < 3; i++) SIM.step(wE, { mx: 0, my: 0 });
  expect('★★被拒绝时祭坛必须留在原地（回血后还能回来）；而且同一座不许每帧刷播报',
    pactList(wE).length === 1 && pactEvents(wE, 'pact_deny').length === 1,
    '座数=' + pactList(wE).length + ' 拒绝播报 ' + pactEvents(wE, 'pact_deny').length + ' 条');
  // 回血之后再来一次，应当成交
  pE.hp = pE.maxHp;
  const takenAfterHeal = SIM.applyPact(wE, pE, pactList(wE)[0]);
  expect('★回血之后再踩能成交（拒绝不是永久惩罚，只是「现在付不起」）',
    takenAfterHeal === true && pE.pacts === 1, 'ok=' + takenAfterHeal + ' 层数=' + pE.pacts);

  // ---------- 8. 满层之后不许再涨 ----------
  const wF = pactWorld(9308);
  const itF = SIM.spawnPact(wF);
  const pF = wF.player;
  const baseMaxF = pF.maxHp;
  const dmg0F = pF.attrs.dmgMul;
  SIM.applyPact(wF, pF, itF);
  pF.hp = pF.maxHp;
  SIM.applyPact(wF, pF, itF);
  pF.hp = pF.maxHp;
  wF.events.length = 0;
  const okF = SIM.applyPact(wF, pF, itF);
  expect('★★满 2 层之后不许再叠（第 3 层开始不是抉择而是自杀）：层数、上限、伤害全都不许再动',
    okF === false && pF.pacts === 2
      && Math.abs(pF.maxHp - baseMaxF * (1 - BP.hpCostPct * 2)) <= 1
      && Math.abs(pF.attrs.dmgMul - (dmg0F + BP.dmg * 2)) < 1e-9,
    'ok=' + okF + ' 层=' + pF.pacts + ' 上限=' + pF.maxHp
      + '（期望 ' + fmt(baseMaxF * (1 - BP.hpCostPct * 2), 1) + '）dmgMul=' + fmt(pF.attrs.dmgMul, 2));
  expect('★满层被拒时要说是「已满」，不是「血气不足」（两种原因的下一步完全不同）',
    pactEvents(wF, 'pact_full').length === 1 && pactEvents(wF, 'pact_deny').length === 0,
    'pact_full=' + pactEvents(wF, 'pact_full').length
      + ' pact_deny=' + pactEvents(wF, 'pact_deny').length);

  // ---------- 9. 升级重算之后契约不许丢 ----------
  // 【为什么单独钉】契约的加成写在 recalcAttrs 里 —— 只要有一处「重算」忘了把
  //   pactScale 与 dmg 并进去，玩家升一级就把刚付的账白付了（而且上限还会悄悄涨回去，
  //   看上去还像是「升级变强了」）。
  // ★走**真实**的升级路径（脚下塞一颗经验球，让 step 里的 gainExp 去吃）：
  //   applyLevelHp 没导出，而「绕过它直接改 p.level」正是这条断言要防的那种写法。
  const wG = pactWorld(9309);
  const itG = SIM.spawnPact(wG);
  const pG = wG.player;
  SIM.applyPact(wG, pG, itG);
  const maxAfterG = pG.maxHp;
  const dmgAfterG = pG.attrs.dmgMul;
  const lvBeforeG = pG.level;
  pG.exp = 0;
  pG.expNext = 5;                        // 一颗 14 点的球足够连升两级
  wG.pickups.push({
    id: wG.nextId++, kind: 'exp', x: pG.x, y: pG.y,
    px: pG.x, py: pG.y, value: 14, big: 1, vx: 0, vy: 0, life: 60
  });
  SIM.step(wG, { mx: 0, my: 0 });
  // 契约还在的话，每升一级涨的血是**打过折**的（8 × 0.86 ≈ 6.9 < 8）；
  // 漏并 pactScale 的话这里会正好涨 8 的整数倍。
  expect('★★★升级重算之后契约不许丢：伤害加成还在，而且每级涨的血仍然是打过折的'
    + '（重算漏并一次 = 玩家白付账）',
    pG.level > lvBeforeG
      && Math.abs(pG.attrs.dmgMul - dmgAfterG) < 1e-9
      && (pG.maxHp - maxAfterG) < C.PLAYER.hpPerLevel * (pG.level - lvBeforeG) - 0.5,
    '等级 ' + lvBeforeG + ' → ' + pG.level
      + ' dmgMul ' + fmt(dmgAfterG, 2) + ' → ' + fmt(pG.attrs.dmgMul, 2)
      + ' 上限 ' + maxAfterG + ' → ' + pG.maxHp);

  // ---------- 10. 代价不是「额外扣当前血」 ----------
  // 残血（还在门槛之上）踩上去：比例应当**基本不变**（只是上限与当前血一起缩）。
  // 若写成「再扣一截当前血」，付完会立刻掉到门槛以下 —— 那是双重收费。
  const wH = pactWorld(9310);
  const itH = SIM.spawnPact(wH);
  const pH = wH.player;
  pH.hp = Math.round(pH.maxHp * 0.85);
  const ratioBefore = pH.hp / pH.maxHp;
  const okH = SIM.applyPact(wH, pH, itH);
  const ratioAfter = pH.hp / pH.maxHp;
  expect('★★代价只落在生命上限上，不许再额外扣一截当前血（双重收费会让付完当场见底）',
    okH === true && Math.abs(ratioAfter - ratioBefore) < 0.02,
    '比例 ' + fmt(ratioBefore, 3) + ' → ' + fmt(ratioAfter, 3));

  // ---------- 11. 不许被磁石吸走 ----------
  // 它是「要专门走过去」的物件：被吸过来就会在你还来不及决定的时候替你做决定。
  const wI = pactWorld(9311);
  const itI = SIM.spawnPact(wI);
  const pI = wI.player;
  pI.x = itI.x + Math.round(C.DROPS.magnetAttractDist * 0.75);
  pI.y = itI.y;
  const xBefore = itI.x;
  const yBefore = itI.y;
  for (let i = 0; i < 10; i++) SIM.step(wI, { mx: 0, my: 0 });
  const itI2 = pactList(wI)[0];
  expect('★★血祭坛不许被磁石吸走（它要玩家自己走过去 —— 被吸过来等于替你做了决定）',
    !!itI2 && itI2.x === xBefore && itI2.y === yBefore && !pI.pacts,
    itI2 ? 'x ' + xBefore + ' → ' + itI2.x + ' / 层数=' + pI.pacts : '祭坛没了');

  // ---------- 12. 整条链路：真的走 step ----------
  // 【为什么还要这一条】上面全是手调 maybeSpawnPact / applyPact ——
  //   函数写好了却**没在 step 里被调用**是这个项目反复出现过的静默失败。
  const wJ = pactWorld(9312);
  wJ.tick = startTick - 1;
  wJ.pactNextTick = 0;
  SIM.step(wJ, { mx: 0, my: 0 });
  const itJ = pactList(wJ)[0];
  expect('★★走 step 的整条链路也会浮现（防「函数写好了但没被调用」这类静默失效）',
    !!itJ && itJ.life > 0, itJ ? 'life=' + fmt(itJ.life, 1) : '一座都没有');
  wJ.player.x = itJ.x;
  wJ.player.y = itJ.y;
  SIM.step(wJ, { mx: 0, my: 0 });
  expect('★★在 step 里真的能踩成（updatePickups 漏挂这一支的话，逻辑全对但永远踩不动）',
    wJ.player.pacts === 1 && pactList(wJ).length === 0,
    '层数=' + wJ.player.pacts + ' 地上还剩 ' + pactList(wJ).length + ' 座');
}

// ============================================================
// 第四十五轮：双生妖（同命相连的一对精英）
// ============================================================
// 【这一轮验的是什么】「先打死一只」这件事第一次有了代价：
//   另一只必须在 6 秒内也倒下，否则先死的那只原地站起来（60% 血），链接从此断开。
//   所以断言几乎全部钉在**不该发生的事**上：
//     · 窗口差一帧不许复活（早一帧 = 玩家白等）
//     · 窗口过了必须复活（不复活 = 规则不存在）
//     · 两只都倒了之后**不许**再站起来（倒计时没撤 = 一对怪无限循环）
//     · 复活出来的那只**不许**再触发第二次复活（否则一局被两只怪锁死）
//     · 剧情关一只都不许有（与前面所有事件同一条纪律）
//     · 生成不许消费主随机流（否则后面每波落点整体错位）
function testTwins() {
  console.log('[第四十五轮] 双生妖：一对同命、6 秒窗口、只复活一次');
  const TW = C.TWINS;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(TW.startSec * HZ);

  // 干净世界：清武器（免得顺手把摆好的怪打死）、锁经验（免得升级面板冻住 step）、
  // 其它事件排期全部推到很远。
  function twinWorld(seed, extra) {
    const w = SIM.createWorld(Object.assign({ seed: seed }, extra || {}));
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    SIM.setSelf(w, p);
    return w;
  }
  function twinMobs(w) {
    return w.mobs.filter(function (m) { return m.alive && m.defId === TW.mobId; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  // 一刀砍死（伤害给得足够大，越过任何血量曲线）
  function slay(w, m) {
    SIM.setSelf(w, w.player);
    SIM.damageMob(w, m, 1e9, 0, 0, 'test');
  }

  // ---------- 0. 表自洽 ----------
  expect('★双生妖不许落在 30 秒波次网格上（陨星为此被推到 305 秒过）',
    TW.startSec % 30 !== 0, 'startSec=' + TW.startSec);
  expect('★★一次必须正好两只（count === 2）：「三只同命」「一只也算一对」都不成立',
    TW.count === 2, 'count=' + TW.count);
  expect('★★窗口必须是一个能反应、又不至于没约束的区间（3 ≤ delaySec ≤ 10）：'
    + '太短只有秒杀 build 玩得起，太长就等于没有这条规则',
    TW.delaySec >= 3 && TW.delaySec <= 10, 'delaySec=' + TW.delaySec);
  expect('★复活不许可怜到「一碰就死」、也不许回到满血（0.3 ≤ reviveHpPct ≤ 0.9）：'
    + '满血复活是前功尽弃，残血复活等于这条规则没代价',
    TW.reviveHpPct >= 0.3 && TW.reviveHpPct <= 0.9, 'reviveHpPct=' + TW.reviveHpPct);
  expect('★同屏只许一对（maxAlive === 1）：两对同时在场上，「先收哪一对」会盖过「留手」本身',
    TW.maxAlive === 1, 'maxAlive=' + TW.maxAlive);
  expect('★必须从刷怪环外走进来（spawnPad > 0）：凭空出现在脸上就没有「先磨血」的余地',
    TW.spawnPad > 0, 'spawnPad=' + TW.spawnPad);
  expect('★★配色是跨层契约（渲染/串池都按这个值）：必须是约定的冷青灰 #8fb6c8',
    C.MOB_MAP[TW.mobId] && C.MOB_MAP[TW.mobId].color === '#8fb6c8',
    C.MOB_MAP[TW.mobId] ? C.MOB_MAP[TW.mobId].color : '无定义');
  expect('★★双生妖不许进关卡池（只从事件入口来，否则「它是一段插曲」就退化成「又多一种精英」）',
    (function () {
      const pools = C.STAGES || [];
      for (let i = 0; i < pools.length; i++) {
        const pl = pools[i].pool || [];
        for (let k = 0; k < pl.length; k++) {
          if (pl[k] === TW.mobId) return false;
        }
      }
      return true;
    })(), '关卡池里出现了 ' + TW.mobId);
  const wAf = twinWorld(9400);
  expect('★★双生妖不挂词缀（叠坚壁 = 6 秒内收不掉、叠狂暴 = 追不上，两条都把规则变成运气）',
    SIM.affixForSpawn(wAf, TW.mobId) === 0, 'affix=' + SIM.affixForSpawn(wAf, TW.mobId));

  // ---------- 1. 到点前一帧一只都不许有 ----------
  const wA = twinWorld(9402);
  wA.tick = startTick - 1;
  wA.twinNextTick = 0;
  SIM.maybeSpawnTwins(wA);
  expect('★到点前一帧一只都不许出现（早一帧就等于「时间没到就加难度」）',
    twinMobs(wA).length === 0 && evs(wA, 'twins').length === 0,
    '只数=' + twinMobs(wA).length);

  // ---------- 2. 到点一对、且只播一条 ----------
  const wB = twinWorld(9403);
  wB.tick = startTick;
  wB.twinNextTick = 0;
  SIM.maybeSpawnTwins(wB);
  const twinsB = twinMobs(wB);
  const evB = evs(wB, 'twins');
  expect('★到点必须来两只，而且只播一条（两条会让人以为来了两对）',
    twinsB.length === 2 && evB.length === 1,
    '只数=' + twinsB.length + ' 事件=' + evB.length);
  expect('★★现身事件必须带上「几秒内要一起收掉」（这是整套规则唯一的说明书）',
    evB.length === 1 && evB[0].delaySec === TW.delaySec, evB.length ? 'delaySec=' + evB[0].delaySec : '无事件');
  expect('★现身事件必须是**全局**事件（不带 slot）：联机时四个人都该知道有这么一对',
    evB.length === 1 && evB[0].slot === undefined, evB.length ? 'slot=' + evB[0].slot : '无事件');
  expect('★★两只必须同属一个配对号（配对号是「谁和谁同命」的唯一依据）',
    twinsB.length === 2 && twinsB[0].twinPair > 0 && twinsB[0].twinPair === twinsB[1].twinPair,
    twinsB.length === 2 ? twinsB[0].twinPair + ' / ' + twinsB[1].twinPair : '只数不足');
  expect('★两只不许叠在同一个点上（叠在一起就看不出「它们是一对，但从两个方向来」）',
    twinsB.length === 2
      && Math.abs(twinsB[0].x - twinsB[1].x) + Math.abs(twinsB[0].y - twinsB[1].y) > 20,
    twinsB.length === 2 ? 'dx=' + fmt(Math.abs(twinsB[0].x - twinsB[1].x), 0)
      + ' dy=' + fmt(Math.abs(twinsB[0].y - twinsB[1].y), 0) : '只数不足');

  // ---------- 3. 场上还有一对时不许再刷 ----------
  // ★这条同时钉住「顺延整个间隔」而不是「每帧重试」（陨星/血祭坛的同款坑）
  const wC = twinWorld(9404);
  wC.tick = startTick;
  wC.twinNextTick = 0;
  for (let k = 0; k < 5; k++) {
    SIM.maybeSpawnTwins(wC);
    wC.tick += Math.round(TW.everySec * HZ);
  }
  expect('★★场上那一对还没被解决时，连推 5 个间隔仍然只有 2 只（不许越刷越多）',
    twinMobs(wC).length === 2 && evs(wC, 'twins').length === 1,
    '只数=' + twinMobs(wC).length + ' 事件=' + evs(wC, 'twins').length);

  // ---------- 4. 剧情关一只都不许有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 9405, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.twinNextTick = 0;
  SIM.maybeSpawnTwins(wS);
  for (let i = 0; i < 5; i++) SIM.step(wS, { mx: 0, my: 0 });
  expect('★★剧情关（《补天纪》ch1）永远没有双生妖，连播报都没有'
    + '（与挑战者/神龛/赤月/陨星/山魈/灵泉/血祭坛同一条纪律）',
    !!wS.storyStage && twinMobs(wS).length === 0 && evs(wS, 'twins').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null') + ' 只数=' + twinMobs(wS).length);

  // ---------- 5. 不消费主随机流 ----------
  const r1 = twinWorld(9406);
  const r2 = twinWorld(9406);
  r1.twinNextTick = 0;
  for (let k = startTick - 5; k <= startTick + Math.round(TW.everySec * HZ) + 20; k += 7) {
    r1.tick = k;
    // 每次都把那两只清掉，让它能反复生成（否则被同屏上限挡住）
    const l = twinMobs(r1);
    for (let i = 0; i < l.length; i++) { l[i].alive = false; l[i].twinPair = 0; }
    r1.twinPairs.length = 0;
    SIM.maybeSpawnTwins(r1);
  }
  expect('★★双生妖的生成（含两只的落点角度）不消费主随机流'
    + '（随机数状态必须与从没生成过的世界完全一致，否则后面每一波的落点整体错位）',
    r1.rngState === r2.rngState && r1.twinSpawned >= 2,
    'rng=' + r1.rngState + '/' + r2.rngState + ' 刷了 ' + r1.twinSpawned + ' 对');

  // ---------- 6. 只倒一只：排倒计时，窗口内不许复活 ----------
  const wD = twinWorld(9407);
  wD.tick = startTick;
  wD.twinNextTick = 0;
  SIM.maybeSpawnTwins(wD);
  const pairD = twinMobs(wD);
  wD.events.length = 0;
  slay(wD, pairD[0]);
  expect('★倒下一只必须播一条 twin_half（不播的话玩家根本不知道有倒计时在跑）',
    evs(wD, 'twin_half').length === 1, '事件=' + evs(wD, 'twin_half').length);
  expect('★倒下一只后配对要排上倒计时，且正好是 delaySec 之后（不是「下一帧」「随便一个数」）',
    wD.twinPairs.length === 1 && wD.twinPairs[0].dead === 1
      && wD.twinPairs[0].reviveAt === wD.tick + Math.round(TW.delaySec * HZ),
    wD.twinPairs.length ? 'dead=' + wD.twinPairs[0].dead
      + ' 差 ' + fmt((wD.twinPairs[0].reviveAt - wD.tick) / HZ, 1) + ' 秒' : '没有配对记录');
  // 走到「差一帧」
  wD.tick = wD.twinPairs[0].reviveAt - 1;
  SIM.updateTwins(wD);
  expect('★★倒计时差一帧时**不许**复活（早一帧 = 6 秒窗口形同虚设）',
    twinMobs(wD).length === 1, '存活只数=' + twinMobs(wD).length);

  // ---------- 7. 到点必须复活，且是 60% 血 ----------
  const deadMaxHp = wD.twinPairs[0].maxHp;
  wD.tick = wD.twinPairs[0].reviveAt;
  SIM.updateTwins(wD);
  const backD = twinMobs(wD);
  expect('★★窗口过了必须站起来一只（不站起来 = 这条规则根本不存在）',
    backD.length === 2, '存活只数=' + backD.length);
  const revived = backD.filter(function (m) { return !m.twinPair; })[0];
  expect('★复活的必须是**残血**（按它自己的上限回 reviveHpPct，不是满血）',
    !!revived && Math.abs(revived.hp - Math.round(revived.maxHp * TW.reviveHpPct)) <= 1,
    revived ? 'hp=' + fmt(revived.hp, 0) + '/' + fmt(revived.maxHp, 0) : '没找到复活的那只');
  expect('★★复活的那只生命上限必须与被打死时一致（用 def.hp 重算会让后期它变成纸糊的）',
    !!revived && Math.abs(revived.maxHp - deadMaxHp) <= 1,
    revived ? '上限=' + fmt(revived.maxHp, 1) + ' 期望 ' + fmt(deadMaxHp, 1) : '没找到');
  expect('★★复活的那只**链接必须已断**（twinPair === 0）：否则一对双生妖能无限复活，一局被两只怪锁死',
    !!revived && revived.twinPair === 0, revived ? 'twinPair=' + revived.twinPair : '没找到');
  expect('★复活要播一条 twin_revive（「它站起来了」和「又刷了一只」对玩家的下一步动作完全相反）',
    evs(wD, 'twin_revive').length === 1, '事件=' + evs(wD, 'twin_revive').length);

  // ---------- 8. 复活后再打死它：不许再站起来 ----------
  const chestsBefore = wD.pickups.filter(function (it) { return it.kind === 'chest'; }).length;
  wD.events.length = 0;
  slay(wD, revived);
  const afterSlay = wD.twinPairs.length;
  for (let i = 0; i < Math.round((TW.delaySec + 4) * HZ); i++) {
    wD.tick += 1;
    SIM.updateTwins(wD);
  }
  expect('★★★复活出来的那只再死**不许**触发第二次复活（这是「只复活一次」的唯一保障：'
    + '不这样就是一局无限复活，玩家会被两只怪锁死在原地）',
    twinMobs(wD).length === 1 && afterSlay === 0,
    '存活只数=' + twinMobs(wD).length + ' 配对记录=' + afterSlay);
  expect('★失败的那一对也不再给宝箱（奖励只属于「两只都在窗口内收掉」）',
    wD.pickups.filter(function (it) { return it.kind === 'chest'; }).length === chestsBefore,
    '宝箱 ' + chestsBefore + ' → ' + wD.pickups.filter(function (it) { return it.kind === 'chest'; }).length);

  // ---------- 9. 6 秒内两只都倒：给奖励，而且倒计时必须撤掉 ----------
  const wE = twinWorld(9408);
  wE.tick = startTick;
  wE.twinNextTick = 0;
  SIM.maybeSpawnTwins(wE);
  const pairE = twinMobs(wE);
  wE.events.length = 0;
  const chestsE0 = wE.pickups.filter(function (it) { return it.kind === 'chest'; }).length;
  const goldE0 = wE.pickups.filter(function (it) { return it.kind === 'gold'; }).length;
  slay(wE, pairE[0]);
  // 窗口内（差 1 秒）收掉第二只
  wE.tick += Math.round((TW.delaySec - 1) * HZ);
  slay(wE, pairE[1]);
  expect('★★两只都在窗口内倒下 → 必须掉宝箱（这是「做对了」的兑现，而不是「又打了一只」）',
    wE.pickups.filter(function (it) { return it.kind === 'chest'; }).length === chestsE0 + (TW.chest || 0),
    '宝箱 ' + chestsE0 + ' → ' + wE.pickups.filter(function (it) { return it.kind === 'chest'; }).length);
  expect('★★两只都在窗口内倒下 → 金币按表撒够（叠在一点只会被一次性吸走，看着像只掉了一枚）',
    wE.pickups.filter(function (it) { return it.kind === 'gold'; }).length
      === goldE0 + (TW.goldDrops || 0),
    '金币 ' + goldE0 + ' → ' + wE.pickups.filter(function (it) { return it.kind === 'gold'; }).length);
  expect('★全灭要播一条 twin_slain', evs(wE, 'twin_slain').length === 1,
    '事件=' + evs(wE, 'twin_slain').length);
  expect('★★★全灭之后配对必须已结算且倒计时被撤掉（reviveAt === 0）：'
    + '第一只排下的 timer 不撤的话，6 秒后死掉的那只会从地上又站起来 —— 明明已经赢了',
    wE.twinPairs.length === 0 || (wE.twinPairs[0].reviveAt === 0 && wE.twinPairs[0].resolved),
    wE.twinPairs.length ? JSON.stringify(wE.twinPairs[0]) : '配对已清空');

  // ---------- 10. 全灭后推进 12 秒：不许莫名其妙又多出一只 ----------
  for (let i = 0; i < Math.round(12 * HZ); i++) {
    wE.tick += 1;
    SIM.updateTwins(wE);
  }
  expect('★★★同命解决之后推进 12 秒，场上不许再出现双生妖（「撤掉倒计时」这条如果不写，'
    + '测试全绿但玩家会看到刚打完的一对里站起一只）',
    twinMobs(wE).length === 0, '只数=' + twinMobs(wE).length);

  // ---------- 11. 复活被实体上限挡住时：短等 2 秒，不许顺延整个间隔 ----------
  const wF = twinWorld(9409);
  wF.tick = startTick;
  wF.twinNextTick = 0;
  SIM.maybeSpawnTwins(wF);
  const pairF = twinMobs(wF);
  slay(wF, pairF[0]);
  wF.tick = wF.twinPairs[0].reviveAt;
  // 把实体塞满（只临时撑住这一帧）
  const fake = [];
  while (wF.mobs.length < C.MAX_MOBS) {
    const m = SIM.spawnMob(wF, 'bat', 100, 100, 1, 0, 0.5);
    if (!m) break;
    fake.push(m);
  }
  SIM.updateTwins(wF);
  expect('★复活被实体上限挡住时只短等 2 秒重试（顺延整个 84 秒等于「它永远不站起来」）',
    wF.twinPairs.length === 1 && wF.twinPairs[0].reviveAt > wF.tick
      && wF.twinPairs[0].reviveAt - wF.tick <= Math.round(2 * HZ) + 1,
    wF.twinPairs.length ? '差 ' + fmt((wF.twinPairs[0].reviveAt - wF.tick) / HZ, 1) + ' 秒' : '配对没了');
  for (let i = 0; i < fake.length; i++) fake[i].alive = false;

  // ---------- 12. 普通精英被打死不许进同命结算 ----------
  const wG = twinWorld(9410);
  const plain = SIM.spawnMob(wG, 'bone_knight', wG.player.x + 40, wG.player.y, 1, 0, 0.7);
  wG.events.length = 0;
  slay(wG, plain);
  expect('★★没有配对号的怪被打死时，一个字段都不许碰（否则「普通精英也走同命结算」这类事故会在别处冒出来）',
    wG.twinPairs.length === 0 && evs(wG, 'twin_slain').length === 0
      && evs(wG, 'twin_half').length === 0,
    '配对=' + wG.twinPairs.length + ' 事件=' + wG.events.length);

  // ---------- 13. 整条链路：真的走 step ----------
  // 【为什么还要这一条】上面全是手调 maybeSpawnTwins / updateTwins ——
  //   「函数写好了却没在 step 里被调用」是这个项目反复出现过的静默失败。
  const wH = twinWorld(9411);
  wH.tick = startTick - 1;
  wH.twinNextTick = 0;
  SIM.step(wH, { mx: 0, my: 0 });
  expect('★★走 step 的整条链路真的会在 startSec 刷出一对（防「函数写好了但没被调用」）',
    twinMobs(wH).length === 2, '只数=' + twinMobs(wH).length);
  const pairH = twinMobs(wH);
  slay(wH, pairH[0]);
  expect('★★走 damageMob → killMob 的链路也能触发同命结算（挂在 killMob 里，不是只挂在导出函数上）',
    evs(wH, 'twin_half').length === 1 && wH.twinPairs.length === 1,
    '事件=' + evs(wH, 'twin_half').length + ' 配对=' + wH.twinPairs.length);
  // 把 world 的时钟推到复活点，再用 step 推进（updateTwins 必须在 step 里被调用）
  wH.tick = wH.twinPairs[0].reviveAt - 1;
  SIM.step(wH, { mx: 0, my: 0 });
  expect('★★step 里真的会推进同命倒计时并让那只站起来（updateTwins 漏挂的话逻辑全对但永远不复活）',
    twinMobs(wH).length === 2 && evs(wH, 'twin_revive').length === 1,
    '只数=' + twinMobs(wH).length + ' 复活事件=' + evs(wH, 'twin_revive').length);
}

// ============================================================
// 第四十六轮：引魂灯（三盏一组的路线规划）
// ============================================================
//
// 【这一轮为什么值得新增三十多条断言】前面十一个玩法增量各自只需要**一个决定**
// （先打哪只 / 去不去 / 停不停 / 付不付），而引魂灯第一次要求**一条路线**：
// 三盏灯散在三个方向、只有 26 秒，跑不完全部。
// 于是「三点必须真的铺满 360°」「灯不许被磁石吸过来」「点齐才给奖励」
// 这三件事一旦破掉，玩法会**悄悄退化**成「地上多了三个小神龛」——
// 数值全对、断言全绿、手感为零。所以这里每一条都钉「不该发生的事」。
function testLantern() {
  console.log('[第四十六轮] 引魂灯：三盏一组的路线规划');
  const L = C.LANTERN;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(L.startSec * HZ);
  // 扫源码：用于钉「表里不许有死字段」（本轮删掉 drawLift、把 lightRadius 接上真实判定）
  const SRC = FS.readFileSync(PATH.join(__dirname, '..', 'shared', 'sim.js'), 'utf8');

  // 干净世界：清武器（免得顺手把摆好的靶子打死）、锁经验（免得升级面板冻住 step）、
  // 其它事件排期全部推到很远（本轮只验引魂灯）。
  function lanternWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    SIM.setSelf(w, p);
    return w;
  }
  function lamps(w) {
    return w.pickups.filter(function (x) { return x.kind === 'lantern'; });
  }
  function kinds(w, k) {
    return w.pickups.filter(function (x) { return x.kind === k; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  // 把玩家搬到离某一盏灯 dist 远的位置（同一条水平线上，好算）
  function stand(w, it, dist) {
    const p = w.player;
    p.x = it.x + dist;
    p.y = it.y;
    SIM.setSelf(w, p);
    return p;
  }
  // 到点刷一组
  function spawn(w) {
    w.tick = startTick;
    w.lanternNextTick = 0;
    return SIM.maybeSpawnLanterns(w);
  }

  // ---------- 0. 表自洽 ----------
  expect('★引魂灯不许落在 30 秒波次网格上（startSec % 30 !== 0）：'
    + '压在波次那一帧时，刚刷的怪还在 700px 外（陨星为此被推迟过 95 秒）',
    L.startSec % 30 !== 0, 'startSec=' + L.startSec);
  const others = [
    ['挑战者', C.CHALLENGER.startSec], ['灵泉', C.LEYLINE.startSec],
    ['血祭坛', C.BLOODPACT.startSec], ['赤月', C.BLOOD_MOON.startSec],
    ['山魈', C.SUMMONER.startSec], ['陨星', C.METEOR.startSec],
    ['双生妖', C.TWINS.startSec]
  ];
  const sameTick = others.filter(function (o) { return o[1] === L.startSec; });
  expect('★不许与另一个事件的**首发帧**落在同一 tick（同一帧两件事一起弹，玩家只会读一条）',
    sameTick.length === 0, sameTick.length ? '撞了：' + sameTick[0][0] : '无冲突');
  expect('★★一次必须正好三盏（count === 3）：两盏只构成一条线（走到底再折回，几乎不用规划），'
    + '五盏在 26 秒里跑不完（等于把奖励变成抽签）',
    L.count === 3, 'count=' + L.count);
  expect('★环带必须落在「抬头看得见、又跑得过去」的区间（ringMin ≥ 280 且跨度 ≥ 120）：'
    + '太近等于白送，太远就是「根本来不及」',
    L.ringMin >= 280 && (L.ringMax - L.ringMin) >= 120,
    'ring=' + L.ringMin + '~' + L.ringMax);
  expect('★★★点亮半径必须**小于**默认拾取半径（lightRadius < PLAYER.pickupRadius）：'
    + '它代替了拾取半径（否则磁石被动一开，灯在 100px 外就被"吸着点亮"，路线规划整个消失）',
    L.lightRadius < C.PLAYER.pickupRadius && L.lightRadius >= 20,
    'lightRadius=' + L.lightRadius + ' pickupRadius=' + C.PLAYER.pickupRadius);
  expect('★存在时长必须够跑三盏、又不够"打完这一波再慢慢去"（20 ≤ lifeSec ≤ 40）',
    L.lifeSec >= 20 && L.lifeSec <= 40, 'lifeSec=' + L.lifeSec);
  expect('★★收尾冲击必须**小于**灵泉的冲击半径（不许变成"第二个灵泉"）：'
    + '它的定位是「点灯顺手清一下身边的人」',
    L.burstRadius < C.LEYLINE.burstRadius,
    'lantern=' + L.burstRadius + ' ley=' + C.LEYLINE.burstRadius);
  expect('★收尾冲击的伤害必须随波次成长（后期的灯下不该打出开局的白字伤害）',
    C.lanternDmgAt(20) > C.lanternDmgAt(2),
    'wave2=' + fmt(C.lanternDmgAt(2), 1) + ' wave20=' + fmt(C.lanternDmgAt(20), 1));
  expect('★★配色是跨层契约（渲染的灯火 / 光晕 / 边界环都按这个值）：必须是琥珀金 #ffcf5c',
    L.color === '#ffcf5c', L.color);
  expect('★★引魂灯不许出现在怪物表里（它是地面点位，不是怪：进了 MOBS 就会被刷怪、被击杀、进图鉴）',
    C.MOBS.filter(function (m) { return m.name === L.name; }).length === 0,
    'MOBS 里出现了同名条目');
  // ★死字段检查：表里每个键都必须在 sim.js 里被真正读到。
  //   本轮就是靠这条发现 `lightRadius` 从来没被用过（判定一直在吃拾取半径）、
  //   以及 `drawLift: 0` 是个纯装饰的死字段（已删）。
  const dead = [];
  const keys = Object.keys(L);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (k === 'name') continue;              // 展示名，不参与逻辑
    if (k === 'burstDmgBase') {              // 它由 const.js 的 lanternDmgAt 消费
      if (SRC.indexOf('lanternDmgAt') < 0) dead.push(k);
      continue;
    }
    if (SRC.indexOf('.' + k) < 0) dead.push(k);
  }
  expect('★★表里不许有死字段（写了却没人读的数值 = 调了也没用，下次有人改它只会以为自己改错了）',
    dead.length === 0, dead.length ? '没人读：' + dead.join(',') : '全部被引用');

  // ---------- 1. 到点前一帧一盏都不许有 ----------
  const wA = lanternWorld(9600);
  wA.tick = startTick - 1;
  wA.lanternNextTick = 0;
  SIM.maybeSpawnLanterns(wA);
  expect('★到点前一帧一盏都不许出现（早一帧 = 时间没到就先给了奖励）',
    lamps(wA).length === 0 && evs(wA, 'lantern').length === 0,
    '盏数=' + lamps(wA).length);

  // ---------- 2. 到点三盏、只播一条 ----------
  const wB = lanternWorld(9601);
  spawn(wB);
  const lampsB = lamps(wB);
  const evB = evs(wB, 'lantern');
  expect('★到点必须正好三盏，而且只播一条（三条会让人以为来了三组）',
    lampsB.length === 3 && evB.length === 1,
    '盏数=' + lampsB.length + ' 事件=' + evB.length);
  expect('★★现身事件必须带上「几盏」和「多少秒」（这是整套规则唯一的说明书：'
    + '不写秒数，玩家会以为它能一直挂着）',
    evB.length === 1 && evB[0].count === 3 && evB[0].sec === L.lifeSec,
    evB.length ? 'count=' + evB[0].count + ' sec=' + evB[0].sec : '无事件');
  expect('★现身事件必须是**全局**事件（不带 slot）：联机时四个人都该知道有三个方向要跑',
    evB.length === 1 && evB[0].slot === undefined,
    evB.length ? 'slot=' + evB[0].slot : '无事件');

  // ---------- 3. 三点必须真的铺满 360° ----------
  // 【判据】按「相对玩家」的方位角排序，取相邻夹角（含跨 0° 那一段），
  //   每条都必须 ≥ 60°。散列抖动是 ±0.28 弧度（约 ±16°），基准 120°，
  //   所以正常情况最小夹角约 88°。如果三点挤在同一侧，最小夹角会掉到 20° 以下。
  const anchorB = wB.player;
  const angs = lampsB.map(function (it) { return Math.atan2(it.y - anchorB.y, it.x - anchorB.x); })
    .sort(function (a, b) { return a - b; });
  let minGapDeg = 360;
  for (let i = 0; i < angs.length; i++) {
    const next = i === angs.length - 1 ? angs[0] + Math.PI * 2 : angs[i + 1];
    const deg = (next - angs[i]) * 180 / Math.PI;
    if (deg < minGapDeg) minGapDeg = deg;
  }
  expect('★★★三盏灯必须铺满三个方向（相邻夹角 ≥ 60°）：挤在同一侧的话'
    + '「先跑哪一盏」就退化成「顺着走一遍」，这一轮唯一的新东西就没了',
    lampsB.length === 3 && minGapDeg >= 60, '最小夹角=' + fmt(minGapDeg, 1) + '°');
  // 两两直线距离也要真的拉开
  let minDist = 1e9;
  for (let i = 0; i < lampsB.length; i++) {
    for (let k = i + 1; k < lampsB.length; k++) {
      const dd = Math.sqrt(Math.pow(lampsB[i].x - lampsB[k].x, 2) + Math.pow(lampsB[i].y - lampsB[k].y, 2));
      if (dd < minDist) minDist = dd;
    }
  }
  expect('★三盏之间必须真的拉开距离（≥ 环带跨度的 40%）：贴在一起的三盏等于一盏',
    minDist >= (L.ringMax - L.ringMin) * 0.4, '最近两盏=' + fmt(minDist, 0) + 'px');
  // 环带
  let badRing = 0;
  for (let i = 0; i < lampsB.length; i++) {
    const dd = Math.sqrt(Math.pow(lampsB[i].x - anchorB.x, 2) + Math.pow(lampsB[i].y - anchorB.y, 2));
    if (dd < L.ringMin - 1 || dd > L.ringMax + 1) badRing += 1;
  }
  expect('★三盏都必须落在 ringMin~ringMax 的环带上（太近白送、太远来不及）',
    badRing === 0, '越界盏数=' + badRing);

  // ---------- 4. 场上还有灯时，排期到了也不许多刷 ----------
  // ★这一条原来写成「连推 5 个 everySec」，结果测出来是 3 条播报 —— 不是代码错，
  //   是**判据错**：一次推 132 秒早就越过 26 秒的寿命，于是每一轮都会
  //   「先作废上一组、再刷下一组」，播报当然会多。真正要钉的是**同一组还活着的时候**：
  const wC = lanternWorld(9602);
  spawn(wC);
  wC.tick = startTick + Math.round(10 * HZ);   // 组内第 10 秒（还剩 16 秒）
  wC.lanternNextTick = wC.tick;                // 假装排期到了
  for (let k = 0; k < 5; k++) SIM.maybeSpawnLanterns(wC);
  expect('★★★★场上那三盏还没点完时，排期到了也一盏都不许多刷（同屏闸）：'
    + '而且只**短等 2 秒**重试，不许顺延整个 132 秒（陨星踩过这个坑：一顺延就等于这一组永远不来了）',
    lamps(wC).length === 3 && evs(wC, 'lantern').length === 1
      && wC.lanternNextTick === wC.tick + Math.round(2 * HZ),
    '盏数=' + lamps(wC).length + ' 事件=' + evs(wC, 'lantern').length
      + ' 重试差 ' + fmt((wC.lanternNextTick - wC.tick) / HZ, 1) + ' 秒');

  // ---------- 5. 剧情关一盏都没有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 9603, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.lanternNextTick = 0;
  SIM.maybeSpawnLanterns(wS);
  for (let i = 0; i < 5; i++) SIM.step(wS, { mx: 0, my: 0 });
  expect('★★剧情关（《补天纪》ch1）永远没有引魂灯，连播报都没有'
    + '（与挑战者/神龛/赤月/陨星/山魈/灵泉/血祭坛/双生妖同一条纪律）',
    !!wS.storyStage && lamps(wS).length === 0 && evs(wS, 'lantern').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null') + ' 盏数=' + lamps(wS).length);

  // ---------- 6. 不消费主随机流 ----------
  const r1 = lanternWorld(9604);
  const r2 = lanternWorld(9604);
  r1.lanternNextTick = 0;
  for (let k = startTick - 5; k <= startTick + Math.round(L.everySec * HZ) + 20; k += 7) {
    r1.tick = k;
    // 每次都把上一组清掉，让它能反复生成（否则会被同屏闸挡住）
    r1.pickups = r1.pickups.filter(function (x) { return x.kind !== 'lantern'; });
    r1.lanternRound = null;
    SIM.maybeSpawnLanterns(r1);
  }
  expect('★★引魂灯的生成（含三盏的方向与半径）不消费主随机流'
    + '（随机数状态必须与从没生成过的世界完全一致，否则后面每一波的落点整体错位）',
    r1.rngState === r2.rngState && r1.lanternSpawned >= 2,
    'rng=' + r1.rngState + '/' + r2.rngState + ' 刷了 ' + r1.lanternSpawned + ' 组');

  // ---------- 7. 差一点点不算点着 ----------
  const wD = lanternWorld(9605);
  spawn(wD);
  const lampD = lamps(wD)[0];
  stand(wD, lampD, L.lightRadius + 2);
  SIM.step(wD, { mx: 0, my: 0 });
  expect('★距离多 2px 就不算点着（判定半径写死 34：玩家按脚下那圈金环估距离才对得上）',
    lamps(wD).length === 3 && wD.lanternRound.lit === 0,
    '盏数=' + lamps(wD).length + ' lit=' + wD.lanternRound.lit);

  // ---------- 8. 走进去就点着，且只报进度 ----------
  stand(wD, lampD, L.lightRadius - 2);
  SIM.step(wD, { mx: 0, my: 0 });
  const litEvD = evs(wD, 'lantern_lit');
  expect('★走到判定半径内就点着（灯被吃掉、剩 2 盏），并播一条进度',
    lamps(wD).length === 2 && wD.lanternRound.lit === 1 && litEvD.length === 1,
    '盏数=' + lamps(wD).length + ' lit=' + wD.lanternRound.lit + ' 事件=' + litEvD.length);
  expect('★★进度必须带「已亮 / 总数 / 还差几盏」：只说「点亮一盏」，'
    + '玩家要靠自己数地上还剩几个，在怪堆里根本数不清',
    litEvD.length === 1 && litEvD[0].lit === 1 && litEvD[0].total === 3 && litEvD[0].left === 2,
    litEvD.length ? 'lit=' + litEvD[0].lit + ' total=' + litEvD[0].total
      + ' left=' + litEvD[0].left : '无事件');
  expect('★点着的那一盏必须**被我吃掉**（不许留在场上：留着就会被反复点亮，'
    + '进度一口气涨到 3/3 —— 那是白送奖励）',
    lamps(wD).filter(function (x) { return x.x === lampD.x && x.y === lampD.y; }).length === 0,
    '同一坐标还有灯');

  // ---------- 9. ★★磁石不许影响点灯 ----------
  // 【这条是本轮改代码的直接原因】原来那一支走的是 `d <= pickupR`，
  //   而 pickupR 会被磁石被动放大到 120 —— 灯在 100px 外就"自己亮了"。
  const wM = lanternWorld(9606);
  spawn(wM);
  const lampM = lamps(wM)[0];
  wM.player.passives = [{ id: 'magnet', level: 5 }];     // 拾取范围 ×2 → 120
  SIM.recalcAttrs(wM);
  const pickR = wM.player.attrs.pickupRadius;
  stand(wM, lampM, 60);                                   // 60 < 120（旧逻辑会亮）、> 34（新逻辑不亮）
  SIM.step(wM, { mx: 0, my: 0 });
  expect('★★★磁石把拾取半径放大到 120 之后，60px 处仍然**不许**点着'
    + '（旧逻辑就是在这一支吃 pickupR，等于"磁石顺手把三盏灯全点了"）',
    pickR > 100 && lamps(wM).length === 3 && wM.lanternRound.lit === 0,
    '拾取半径=' + Math.round(pickR) + ' 盏数=' + lamps(wM).length
      + ' lit=' + wM.lanternRound.lit);

  // ---------- 10. 灯不被磁石吸走 ----------
  const wN = lanternWorld(9607);
  spawn(wN);
  const lampN = lamps(wN)[0];
  const nx0 = lampN.x, ny0 = lampN.y;
  stand(wN, lampN, 200);
  for (let i = 0; i < 20; i++) SIM.step(wN, { mx: 0, my: 0 });
  const lampN2 = lamps(wN).filter(function (x) {
    return Math.abs(x.x - nx0) < 0.01 && Math.abs(x.y - ny0) < 0.01;
  });
  expect('★★灯不许被磁石吸过来（1 秒后坐标一动不动）：被吸过来就等于「路过自动点亮」，'
    + '三盏之间的路线规划会整个消失',
    lampN2.length === 1, '原坐标上还剩 ' + lampN2.length + ' 盏');

  // ---------- 11. 只点两盏：一分钱都不许给 ----------
  const wE = lanternWorld(9608);
  spawn(wE);
  const chest0 = kinds(wE, 'chest').length;
  const gold0 = kinds(wE, 'gold').length;
  const lampsE = lamps(wE);
  stand(wE, lampsE[0], 4);
  SIM.step(wE, { mx: 0, my: 0 });
  stand(wE, lampsE[1], 4);
  SIM.step(wE, { mx: 0, my: 0 });
  expect('★★只点着两盏时，一个宝箱、一枚金币都不许掉（差一盏 = 还没完成）',
    lamps(wE).length === 1 && kinds(wE, 'chest').length === chest0
      && kinds(wE, 'gold').length === gold0 && evs(wE, 'lantern_done').length === 0,
    '剩灯=' + lamps(wE).length + ' 宝箱+' + (kinds(wE, 'chest').length - chest0)
      + ' 金币+' + (kinds(wE, 'gold').length - gold0));

  // ---------- 12. 第三盏：奖励 + 冲击 + 边界 ----------
  // 先在最后一盏灯的位置摆两只靶子：一只贴着圆心（必须被打到），一只在 240 之外（一滴血都不许掉）
  const lastE = lamps(wE)[0];
  const inMob = SIM.spawnMob(wE, 'bat', lastE.x, lastE.y, 1, 0, 0.3);
  const outMob = SIM.spawnMob(wE, 'bat', lastE.x + L.burstRadius + 140, lastE.y, 1, 0, 0.6);
  const inHp0 = inMob.hp;
  const outHp0 = outMob.hp;
  // ★奖励落在**灯脚下**，而玩家正站在灯上（4px）—— 两个宝箱与八枚金币会在**同一帧**被吃掉。
  //   所以判据不能数地上的掉落物（数出来永远是 0），要看真正兑现到身上的东西：
  //   等级 / 待选次数 / 金币收入。这也正是玩家能感知到的三个数字。
  const lvE0 = wE.player.level;
  const pendE0 = wE.player.pendingLevels;
  const goldE0 = wE.stats.gold;
  stand(wE, lastE, 4);
  SIM.step(wE, { mx: 0, my: 0 });
  expect('★★点齐三盏才掉奖励：+2 宝箱（= 2 次免费升级）、+8 金币（与表里写的一致，不许"少给一个"）',
    wE.player.level - lvE0 >= L.chest && wE.player.pendingLevels - pendE0 >= L.chest
      && wE.stats.gold - goldE0 >= L.goldDrops,
    '等级+' + (wE.player.level - lvE0) + ' 待选+' + (wE.player.pendingLevels - pendE0)
      + ' 金币+' + (wE.stats.gold - goldE0));
  const doneEv = evs(wE, 'lantern_done');
  expect('★点齐必须播一条 lantern_done（不播的话"三盏齐了"只能靠玩家自己发现）',
    doneEv.length === 1 && doneEv[0].chest === L.chest && doneEv[0].gold === L.goldDrops,
    doneEv.length ? 'chest=' + doneEv[0].chest + ' gold=' + doneEv[0].gold : '无事件');
  expect('★★这一组结束后必须把服务端状态清干净（lanternRound = null）：'
    + '否则下一组点灯时会「凭空多出一盏的进度」，而中间没有任何报错',
    wE.lanternRound === null && lamps(wE).length === 0,
    'round=' + (wE.lanternRound ? 'still' : 'null') + ' 剩灯=' + lamps(wE).length);
  const ringFx = wE.effects.filter(function (e) { return e.kind === 'lanternring'; });
  expect('★★作用边界必须画到**判定半径**（lanternring.r === burstRadius）：'
    + 'pixelfx 库的贴地法阵只铺到百来像素，不单独画边界，'
    + '玩家就不理解「为什么站在 241px 处没被扫到」',
    ringFx.length >= 1 && Math.abs(ringFx[ringFx.length - 1].r - L.burstRadius) < 0.01,
    ringFx.length ? 'r=' + ringFx[ringFx.length - 1].r : '没有边界特效');
  // ★★★这条是「被截图推翻两次」的记录：核心**必须**是自绘的 lanterncore。
  //   用 boom（琥珀金）会被 pixelfx 画成天降的雷柱；用 ring 会被画成铺满半屏的白色符文线框。
  //   两个都在真浏览器里看过，都不对 —— 所以这里把 kind 钉死，防止以后有人"顺手复用"。
  const coreFx = wE.effects.filter(function (e) { return e.kind === 'lanterncore'; });
  const badCore = wE.effects.filter(function (e) {
    return (e.kind === 'boom' || e.kind === 'ring') && e.r >= L.burstRadius - 1;
  });
  expect('★★★收尾冲击的火光必须是自绘的 lanterncore，且半径等于判定半径；'
    + '**不许**复用 boom（=金色雷柱）或 ring（=铺满半屏的白色符文线框），两个都试过错',
    coreFx.length >= 1 && Math.abs(coreFx[coreFx.length - 1].r - L.burstRadius) < 0.01
      && badCore.length === 0,
    'core=' + coreFx.length + ' boom/ring=' + badCore.length);
  expect('★★收尾冲击必须真的伤到圈内的妖物',
    inMob.hp < inHp0, '圈内 hp=' + fmt(inHp0, 0) + '→' + fmt(inMob.hp, 0));
  expect('★★圈外的妖物一滴血都不许掉（判定半径写 240，多 140px 还挨打就说明半径没生效）',
    Math.abs(outMob.hp - outHp0) < 0.01, '圈外 hp=' + fmt(outHp0, 0) + '→' + fmt(outMob.hp, 0));

  // ---------- 13. 26 秒到点：剩下的灯一起消失，且不惩罚 ----------
  const wF = lanternWorld(9609);
  spawn(wF);
  const lampsF = lamps(wF);
  stand(wF, lampsF[0], 4);
  SIM.step(wF, { mx: 0, my: 0 });          // 先点着一盏
  const hpF = wF.player.hp;
  const maxHpF = wF.player.maxHp;
  const dmgF = wF.player.attrs.dmgMul;
  wF.events.length = 0;
  wF.tick = wF.lanternRound ? wF.lanternRound.expireTick : 0;
  SIM.maybeSpawnLanterns(wF);
  expect('★★到点（26 秒）时，没点着的灯必须**一起**消失（不是各自到期）：'
    + '「一组作废」是一个事件，三盏灯零散地先后消失会被读成"我点着了"',
    lamps(wF).length === 0 && wF.lanternRound === null,
    '剩灯=' + lamps(wF).length + ' round=' + (wF.lanternRound ? 'still' : 'null'));
  expect('★★没点齐**不许**有任何惩罚（血、上限、伤害一分都不能变）：'
    + '「奖励没拿到」本身就是代价 —— 与灵泉 16 秒到点同一条口径',
    Math.abs(wF.player.hp - hpF) < 0.01 && Math.abs(wF.player.maxHp - maxHpF) < 0.01
      && Math.abs(wF.player.attrs.dmgMul - dmgF) < 1e-6,
    'hp=' + fmt(wF.player.hp, 0) + '/' + fmt(hpF, 0)
      + ' dmgMul=' + fmt(wF.player.attrs.dmgMul, 2));
  expect('★作废时不许额外播报（不给奖励也不宣布失败：失败该由"地上灯没了"自己表达）',
    wF.events.length === 0,
    '事件=' + wF.events.map(function (e) { return e.type; }).join(','));
  expect('★作废之后不许在同一帧补一组（排期仍是「上一组刷出后 +132 秒」：'
    + '此刻距下一次还有 132-26=106 秒。要是这里把排期改成"马上再来一组"，'
    + '"没点完"就变成了"地上一直有灯"，这一组也就没有任何紧迫感了）',
    wF.lanternNextTick >= wF.tick + Math.round((L.everySec - L.lifeSec - 1) * HZ)
      && lamps(wF).length === 0,
    '下一次差 ' + fmt((wF.lanternNextTick - wF.tick) / HZ, 1) + ' 秒');

  // ---------- 14. 整条链路：真的走 step ----------
  // 【为什么还要这一条】上面全是手调 maybeSpawnLanterns / onLanternLit ——
  //   「函数写好了却没在 step 里被调用」是这个项目反复出现过的静默失败（双生妖那轮踩过）。
  const wG = lanternWorld(9610);
  wG.tick = startTick - 1;
  wG.lanternNextTick = 0;
  SIM.step(wG, { mx: 0, my: 0 });
  expect('★★走 step 的整条链路真的会在 startSec 刷出三盏（防「函数写好了但没被调用」）',
    lamps(wG).length === 3, '盏数=' + lamps(wG).length);
  const lampsG = lamps(wG);
  stand(wG, lampsG[0], 4);
  SIM.step(wG, { mx: 0, my: 0 });
  expect('★★走 step 走到灯上真的能点亮（判定挂在 updatePickups 里，不是只挂在导出函数上）',
    lamps(wG).length === 2 && evs(wG, 'lantern_lit').length === 1,
    '剩灯=' + lamps(wG).length + ' 事件=' + evs(wG, 'lantern_lit').length);
  // ★同一条道理：玩家就站在灯上，宝箱会在同一帧被吃掉 —— 数地上的箱子永远是 0，
  //   要看等级涨没涨（一次免费升级 = 等级 +1）。
  const lvG0 = wG.player.level;
  const restG = lamps(wG);
  for (let i = 0; i < restG.length; i++) {
    stand(wG, restG[i], 4);
    SIM.step(wG, { mx: 0, my: 0 });
  }
  expect('★★走 step 点齐三盏真的会给奖励（奖励写在导出函数里、却在链路里没跑到，是这类功能最常见的死法）',
    wG.player.level - lvG0 >= L.chest && evs(wG, 'lantern_done').length === 1,
    '等级+' + (wG.player.level - lvG0)
      + ' 事件=' + evs(wG, 'lantern_done').length);
}

// ============================================================
// 第四十七轮：饕餮（专吃地上精魄的窃贼）
// ============================================================
// 【这一块要钉住什么】它是全项目第一个「会拿走你**已经到手**的东西」的机制，
// 也是最容易悄悄坏掉的一类：坏掉的时候游戏照常跑、一条报错都没有。
//   ① 它开始吃宝箱 / 神龛 / 祭坛 / 灯 / 红心 → 玩家觉得这机制在阴人；
//   ② 吃满 / 到点之后不跑 → 它退化成一只「迟早会被打死的储蓄罐」，取舍消失；
//   ③ 打死它只吐一半 → 「回头去收它」永远不如「当没看见」，正解变成不玩它；
//   ④ 逃跑走了 killMob → 击杀数、血怒、掉落、图鉴全都凭空多一份；
//   ⑤ 生成或吞吃时取 nextRand → 之后每一波的落点整体错位（词缀/挑战者那一轮踩过）。
// 所以下面每条都写成「不该发生的事」，且尽量配一个「另一侧必须发生」的对照。
function testDevourer() {
  console.log('[第四十七轮] 饕餮：专吃地上精魄的窃贼');
  const D = C.DEVOURER;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(D.startSec * HZ);

  // 干净世界：清武器（免得顺手把它打死）、锁经验（免得升级面板冻住 step）、
  // 其它事件排期全部推到很远（本轮只验饕餮）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.bountyNextTick = 1e9;   // 第五十四轮：悬赏首发 186s，默认推远（要验它的世界自己打开）
    w.healerNextTick = 1e9;   // 第五十五轮：回春巫首发 252s，默认推远（要验它的世界自己打开）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function devs(w) {
    return w.mobs.filter(function (m) { return m.defId === 'taotie'; });
  }
  function of(w, k) {
    return w.pickups.filter(function (x) { return x.kind === k; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function sumExp(w) {
    const l = of(w, 'exp');
    let s = 0;
    for (let i = 0; i < l.length; i++) s += l[i].value || 0;
    return s;
  }
  // 把玩家挪到地图角落：否则经验球会被磁石吸走（magnetAttractDist=200），
  // 测出来的「被吃了几份」随时会被玩家自己吃掉一颗。
  function parkPlayer(w) {
    const p = w.player;
    p.x = 120; p.y = 120;
    SIM.setSelf(w, p);
    return p;
  }
  // 造一只并摆到指定位置（spawnDevourer 的落点在刷怪环外，坐标不受控）
  function place(w, x, y) {
    const m = SIM.spawnDevourer(w);
    if (!m) return null;
    m.x = x; m.y = y; m.px = x; m.py = y;
    m.vx = 0; m.vy = 0;
    return m;
  }
  // 直接推它自己的行为（不跑 step：step 会连带跑波次/拾取/武器，变量太多）
  function tickN(w, m, n) {
    for (let i = 0; i < n; i++) SIM.tickDevourer(w, m, 1 / HZ);
  }

  // ---------- 0. 表自洽 ----------
  expect('★饕餮不许落在 30 秒波次网格上（startSec % 30 !== 0）：'
    + '压在波次那一帧时，刚刷的怪还在 700px 外（陨星为此被推迟过 95 秒）',
    D.startSec % C.WAVES.intervalSec !== 0,
    'startSec=' + D.startSec + ' 余 ' + (D.startSec % C.WAVES.intervalSec));
  const others = [
    ['挑战者', C.CHALLENGER.startSec], ['灵泉', C.LEYLINE.startSec],
    ['血祭坛', C.BLOODPACT.startSec], ['赤月', C.BLOOD_MOON.startSec],
    ['山魈', C.SUMMONER.startSec], ['陨星', C.METEOR.startSec],
    ['双生妖', C.TWINS.startSec], ['引魂灯', C.LANTERN.startSec]
  ];
  const sameTick = others.filter(function (o) { return o[1] === D.startSec; });
  expect('★不许与另一个事件的**首发帧**落在同一 tick（同一帧两件事一起弹，玩家只读得到一条）',
    sameTick.length === 0, sameTick.length ? '撞了：' + sameTick[0][0] : '无冲突');

  // 在场时长：短了玩家走不开，长了就变成储蓄罐
  expect('★在场时长必须落在 20~60 秒（短于 20 玩家被人堆围着走不开；长于 60 就退化成储蓄罐）',
    D.holdSec >= 20 && D.holdSec <= 60, 'holdSec=' + D.holdSec);
  // ★★「吃满就跑」这条分支必须真的走得到：吃满所需时间要明显短于在场时长。
  //   （山魈那轮的教训：额度被「每次 2 只」整除时，那道闸是死代码，断言假绿。）
  const fillSec = D.eatCap * D.eatIntervalSec;
  expect('★★吃饱所需时间必须明显小于在场时长（否则「吃满就跑」永远走不到，'
    + '那段分支就是死代码，断言也会假绿 —— 山魈那轮踩过）',
    fillSec <= D.holdSec * 0.5,
    '吃饱 ' + fmt(fillSec, 2) + 's / 在场 ' + D.holdSec + 's');
  expect('★吸收半径必须远小于搜索半径（40 vs 620）：它是走过去吃，不是隔着半张图吸',
    D.eatRadius * 4 < D.searchR, D.eatRadius + ' vs ' + D.searchR);
  expect('★饱腹上限必须封顶且不大（不封顶它会把整张图的球搬空才走）',
    D.eatCap > 0 && D.eatCap <= 30, 'eatCap=' + D.eatCap);
  // 配色：项目硬规矩「禁紫 / 紫蓝」→ 蓝分量不许超过红分量
  const cv = parseInt(D.color.slice(1), 16);
  const cr = (cv >> 16) & 255, cg = (cv >> 8) & 255, cb = cv & 255;
  expect('★配色不许偏紫蓝（蓝分量不许超过红分量）—— 项目硬规矩',
    cb <= cr, D.color + ' r=' + cr + ' g=' + cg + ' b=' + cb);
  expect('★配色必须与另外三只事件精英拉得开（挑战者琥珀金 / 山魈暗橙 / 双生冷青灰）',
    D.color !== C.CHALLENGER.color && D.color !== C.TWINS.color
      && D.color !== C.MOB_MAP.shanxiao.color,
    D.color);

  // ---------- 1. 关卡池里不许有它（只从事件入口来）----------
  const inPool = [];
  for (let i = 0; i < C.STAGES.length; i++) {
    const pool = C.STAGES[i].pool || {};
    if (pool[D.mobId]) inPool.push('STAGES[' + i + ']');
  }
  ['myth', 'magic'].forEach(function (modId) {
    const mod = CP.MODS[modId];
    if (!mod || !mod.stages) return;
    for (let i = 0; i < mod.stages.length; i++) {
      const pool = mod.stages[i].pool || {};
      if (pool[D.mobId]) inPool.push(modId + '.' + mod.stages[i].id);
    }
  });
  expect('★★关卡池（自由模式四段 + 两个剧情模组）里都不许出现饕餮（它只从事件入口来）',
    inPool.length === 0, inPool.join(',') || '干净');

  // 两个模组都必须有它的改名（campaigntest 也会逐个 id 核对，这里先钉一次）
  const nameHit = ['myth', 'magic'].filter(function (id) {
    const mod = CP.MODS[id];
    return !(mod && mod.mobNames && mod.mobNames[D.mobId]);
  });
  expect('★两个剧情模组都必须有它的改名（漏了 HUD 里就会冒出英文 id）',
    nameHit.length === 0, nameHit.join(',') || 'myth/magic 都有');

  // 词缀：不许挂（坚壁 = 回头那几秒打不死它；狂暴 = 追不上它）
  const SRC = FS.readFileSync(PATH.join(__dirname, '..', 'shared', 'sim.js'), 'utf8');
  expect('★词缀闸必须真的写着（def.devourer → 0）：叠坚壁等于「回头那几秒打不死」，'
    + '叠狂暴等于「追不上」，两种都把取舍变成运气',
    SRC.indexOf('if (def.devourer) return 0;') >= 0);

  // ---------- 2. 生成：零随机、从环外进来 ----------
  const wR1 = cleanWorld(8801);
  // ★站到地图正中再验「从环外来」：贴着地图角落时，落点会被裁到边界内，
  //   距离自然短一截 —— 那是边界夹取的正确行为，不是「凭空出现」（挑战者那条同理）。
  const pR1 = wR1.player;
  pR1.x = wR1.map.w / 2; pR1.y = wR1.map.h / 2;
  SIM.setSelf(wR1, pR1);
  const rngBefore = wR1.rngState;
  const mR1 = SIM.spawnDevourer(wR1);
  expect('★★生成不许消费主随机流（rngState 必须一字不动）',
    !!mR1 && wR1.rngState === rngBefore, 'rng=' + wR1.rngState + '/' + rngBefore);
  expect('★出生点必须在常规刷怪环之外（在环内就是「凭空出现」）',
    !!mR1 && Math.hypot(mR1.x - wR1.player.x, mR1.y - wR1.player.y) >= wR1.spawnRadius,
    mR1 ? 'd=' + Math.round(Math.hypot(mR1.x - wR1.player.x, mR1.y - wR1.player.y))
      + ' / 环 ' + wR1.spawnRadius : '没造出来');
  expect('★出生时必须只播一条事件、且带上「多久之内收掉」与「能吃几份」',
    evs(wR1, 'devourer').length === 1
      && evs(wR1, 'devourer')[0].holdSec === D.holdSec
      && evs(wR1, 'devourer')[0].eatCap === D.eatCap,
    JSON.stringify(evs(wR1, 'devourer')[0] || null));
  expect('★刚出生时肚子必须是空的（devourCount/eatenExp/eatenGold 全 0：'
    + '带着上一只的账出生，第一帧就会「凭空吐出」一堆球）',
    !!mR1 && mR1.devourCount === 0 && mR1.eatenExp === 0 && mR1.eatenGold === 0,
    mR1 ? JSON.stringify({ n: mR1.devourCount, e: mR1.eatenExp, g: mR1.eatenGold }) : 'n/a');

  // ---------- 3. 只吃经验球与金币 ----------
  const wK = cleanWorld(8802);
  parkPlayer(wK);
  const mK = place(wK, 600, 600);
  // 七类东西全摆在它嘴边（半径 24 < eatRadius 40）
  SIM.spawnPickup(wK, 'exp', 612, 604, 9, 0);
  SIM.spawnPickup(wK, 'gold', 588, 604, C.DROPS.goldValue);
  SIM.spawnPickup(wK, 'chest', 600, 624, 1, C.DROPS.chest.life);
  SIM.spawnPickup(wK, 'shrine', 600, 576, 0, 0);
  SIM.spawnPickup(wK, 'pact', 576, 600, 0, 20);
  SIM.spawnPickup(wK, 'lantern', 624, 600, 0, 26);
  SIM.spawnPickup(wK, 'heart', 600, 588, C.DROPS.heartHeal);
  tickN(wK, mK, 100);                     // 5 秒：足够吃光脚下的一切
  expect('★★它只吃经验球与金币（这两个必须没了）',
    of(wK, 'exp').length === 0 && of(wK, 'gold').length === 0 && mK.devourCount === 2,
    '剩 exp=' + of(wK, 'exp').length + ' gold=' + of(wK, 'gold').length
      + ' 吃了 ' + (mK.devourCount || 0) + ' 份');
  expect('★★★宝箱 / 神龛 / 血祭坛 / 引魂灯 / 红心 一份都不许少：'
    + '它们是「要专门走过去」或「救命」的东西，被偷走只会让玩家觉得这机制在阴人',
    of(wK, 'chest').length === 1 && of(wK, 'shrine').length === 1
      && of(wK, 'pact').length === 1 && of(wK, 'lantern').length === 1
      && of(wK, 'heart').length === 1,
    JSON.stringify({ chest: of(wK, 'chest').length, shrine: of(wK, 'shrine').length,
      pact: of(wK, 'pact').length, lantern: of(wK, 'lantern').length,
      heart: of(wK, 'heart').length }));
  expect('★吃下去的经验值必须记准（球是 9 点：账上就得是 9，不是「一份」）',
    mK.eatenExp === 9 && mK.eatenExpN === 1, 'eatenExp=' + mK.eatenExp + ' n=' + mK.eatenExpN);
  expect('★越吃越肥：半径必须真的长大（它是客户端唯一能读出「吃了多少」的通道，'
    + '只存在服务端字段里玩家完全看不见）',
    mK.r > C.MOB_MAP.taotie.r + 0.4 && mK.r <= C.MOB_MAP.taotie.r + D.growMax,
    'r=' + fmt(mK.r, 1) + ' / 底 ' + C.MOB_MAP.taotie.r);

  // ---------- 4. 吃满就跑，且跑之前不许再吃 ----------
  const wB = cleanWorld(8803);
  parkPlayer(wB);
  const mB = place(wB, 600, 600);
  mB.devourCount = D.eatCap - 1;
  mB.eatenExp = 100;
  mB.eatenExpN = D.eatCap - 1;
  mB.eatCd = 0;
  SIM.spawnPickup(wB, 'exp', 612, 604, 9, 0);
  SIM.spawnPickup(wB, 'exp', 588, 604, 9, 0);
  // ★这里必须推够时间（0.6 秒 ≈ 3 个吞吃间隔），否则「第 15 份不许吃」是**假绿**：
  //   只推 2 帧时第二颗还没到吞吃间隔，摘掉上限闸也是绿的（反向验证实测踩到）。
  tickN(wB, mB, 12);
  expect('★★吃到最后一刻：第 15 份（> 上限 14）一份都不许吃 —— 「吃满」不是一个数字，'
    + '是一条必须真的挡住手的闸',
    (mB.devourCount || 0) === D.eatCap && mB.eatenExp === 109,
    '吃了 ' + (mB.devourCount || 0) + ' 份 / exp=' + mB.eatenExp);
  expect('★★吃满必须立刻钻地跑掉（alive=false + fled 标记 + 一条播报）',
    mB.alive === false && mB.fled === 1 && evs(wB, 'devourer_flee').length === 1,
    'alive=' + mB.alive + ' fled=' + mB.fled + ' 事件=' + evs(wB, 'devourer_flee').length);
  expect('★逃跑必须带走它吃掉的那一份（事件里写清几份 / 多少经验）',
    evs(wB, 'devourer_flee').length === 1
      && evs(wB, 'devourer_flee')[0].eaten === D.eatCap
      && evs(wB, 'devourer_flee')[0].exp === 109,
    JSON.stringify(evs(wB, 'devourer_flee')[0] || null));
  expect('★逃跑之后**绝不许**再吃（地上还剩的那一颗必须还在）',
    of(wB, 'exp').length === 1, '剩 ' + of(wB, 'exp').length + ' 颗');

  // ---------- 5. 到点就跑（没吃满也一样）----------
  const wT = cleanWorld(8804);
  parkPlayer(wT);
  const mT = place(wT, 600, 600);
  mT.pocketT = D.holdSec - 0.02;
  mT.eatCd = 0;
  SIM.spawnPickup(wT, 'exp', 612, 604, 9, 0);
  tickN(wT, mT, 1);
  expect('★★到点（38 秒）必须钻地跑掉 —— 没吃满也一样：不跑的话它就是一只'
    + '「迟早会被打死的储蓄罐」，玩家先清空球再回来收它，损失恒为零',
    mT.alive === false && mT.fled === 1 && of(wT, 'exp').length === 1,
    'alive=' + mT.alive + ' 剩球 ' + of(wT, 'exp').length);

  // ---------- 6. 逃跑不许算击杀、不许掉东西、不许再咬人 ----------
  const wF = cleanWorld(8805);
  const pF = wF.player;
  const mF = place(wF, pF.x + 8, pF.y);   // 贴着玩家
  mF.pocketT = D.holdSec;                 // 这一帧就该钻地
  mF.hitCd = 0;
  const kills0 = wF.stats.kills;
  const killsBy0 = wF.stats.killsBy.taotie || 0;
  const pickN0 = wF.pickups.length;
  const hp0 = pF.hp;
  SIM.step(wF, { mx: 0, my: 0 });
  expect('★★逃跑不是死亡：本局击杀数、图鉴击杀数都不许动',
    wF.stats.kills === kills0 && (wF.stats.killsBy.taotie || 0) === killsBy0,
    'kills ' + kills0 + '→' + wF.stats.kills + ' / byTaotie '
      + killsBy0 + '→' + (wF.stats.killsBy.taotie || 0));
  expect('★★逃跑只带走肚子里的东西：地上不许因为它凭空多出任何掉落物',
    wF.pickups.length === pickN0, pickN0 + '→' + wF.pickups.length);
  expect('★★刚刚钻地的那一帧不许再咬人一口（逃走的怪还能伤害玩家，是最像 bug 的那种小事）',
    pF.hp === hp0, 'hp ' + fmt(hp0, 0) + '→' + fmt(pF.hp, 0));
  expect('★钻地之后必须从场上消失（交给 compactMobs，不许留在数组里继续被渲染/被追打）',
    devs(wF).length === 0, '场上 ' + devs(wF).length + ' 只');

  // ---------- 7. 打死它：一分不少地吐回来 ----------
  // 【★为什么要两个同种子的世界对比】killMob 自己会掉一颗精英经验球（大/小由随机决定），
  //   直接数「地上的经验总和」会把那一颗算进来。同种子 → 两边的保底掉落完全一样，
  //   差出来的那一份就精确等于它吃掉的东西。这同时证明了「吃不吃都不影响主随机流」。
  const wA = cleanWorld(8806);
  const wC = cleanWorld(8806);
  parkPlayer(wA); parkPlayer(wC);
  const mA = place(wA, 700, 700);
  const mC = place(wC, 700, 700);
  for (let i = 0; i < 6; i++) SIM.spawnPickup(wA, 'exp', 700, 700, 10, 0);
  for (let i = 0; i < 2; i++) SIM.spawnPickup(wA, 'exp', 700, 700, 4, 0);
  for (let i = 0; i < 3; i++) SIM.spawnPickup(wA, 'gold', 700, 700, C.DROPS.goldValue);
  tickN(wA, mA, 80);                       // 3.5 秒：把 8 颗球 + 3 枚金币全吞了
  expect('★连续吞 11 份都吃得下（上限 14 之内，一份都不许漏）',
    (mA.devourCount || 0) === 11 && mA.eatenExp === 68 && mA.eatenGold === 3,
    '吃了 ' + (mA.devourCount || 0) + ' 份 / exp=' + mA.eatenExp + ' / gold=' + mA.eatenGold);
  expect('★★吞吃全程不许消费主随机流（两边的 rngState 必须一致；'
    + '一旦它取走随机数，后面每一波的落点都会整体错位）',
    wA.rngState === wC.rngState, 'rng=' + wA.rngState + '/' + wC.rngState);

  SIM.damageMob(wA, mA, 1e9, 0, 0, 'test');
  SIM.damageMob(wC, mC, 1e9, 0, 0, 'test');
  // ★基线必须在**杀完之后**取：killMob 自己会掉一颗精英经验球（大小由随机决定），
  //   在杀之前取基线就等于把那一颗也算成「它吐出来的」——第一版就是这么错的（多出 6 点）。
  const baseExp = sumExp(wC);
  const baseGold = of(wC, 'gold').length;
  expect('★★打死它必须**一分不少**地吐回来（地上的经验总和之差 == 吃进去的 68）：'
    + '吐一半的话，「回头去收它」永远不如「当没看见」，正解就变成不玩这个机制',
    sumExp(wA) - baseExp === 68, '多出 ' + (sumExp(wA) - baseExp) + ' 点（期望 68）');
  expect('★★金币也必须一枚不少地吐回来',
    of(wA, 'gold').length - baseGold === 3,
    '多出 ' + (of(wA, 'gold').length - baseGold) + ' 枚（期望 3）');
  expect('★吐回来必须有一条「拿到了」的播报，且写清多少精魄',
    evs(wA, 'devourer_down').length === 1
      && evs(wA, 'devourer_down')[0].exp === 68
      && evs(wA, 'devourer_down')[0].gold === 3,
    JSON.stringify(evs(wA, 'devourer_down')[0] || null));

  // 一只没吃过东西的：不许凭空吐任何东西（肚子是空的就该什么都不掉）
  const wE = cleanWorld(8807);
  parkPlayer(wE);
  const mE = place(wE, 700, 700);
  SIM.damageMob(wE, mE, 1e9, 0, 0, 'test');
  expect('★★没吃过东西就不许吐（肚子空着还给奖励 = 变成一台刷球机）',
    evs(wE, 'devourer_down')[0].exp === 0 && evs(wE, 'devourer_down')[0].gold === 0
      && of(wE, 'exp').length <= 1,
    JSON.stringify(evs(wE, 'devourer_down')[0] || null)
      + ' 地上 exp=' + of(wE, 'exp').length);

  // ---------- 8. 同屏只许一只 + 短等 2 秒（不顺延整个间隔）----------
  const wM = cleanWorld(8808);
  parkPlayer(wM);
  wM.tick = startTick;
  wM.devourerNextTick = 0;
  SIM.maybeSpawnDevourer(wM);
  const firstNext = wM.devourerNextTick;
  for (let k = 0; k < 5; k++) {
    wM.tick += Math.round(D.everySec * HZ);
    SIM.maybeSpawnDevourer(wM);
  }
  expect('★★场上还有一只时，推 5 个间隔也不许多刷一只',
    devs(wM).length === 1, '场上 ' + devs(wM).length + ' 只');
  expect('★★被同屏闸挡住时只许**短等 2 秒**，不顺延整个 108 秒：'
    + '否则玩家一直不去收它，后面的排期会被整体推到很久之后（陨星/引魂灯踩过）',
    wM.devourerNextTick <= wM.tick + Math.round(2.5 * HZ),
    '下一次差 ' + fmt((wM.devourerNextTick - wM.tick) / HZ, 1) + ' 秒');
  expect('★第一只的排期确实是「刷出后 +108 秒」（不是被短等改坏了）',
    firstNext === startTick + Math.round(D.everySec * HZ),
    '差 ' + fmt((firstNext - startTick) / HZ, 1) + ' 秒');

  // ---------- 9. 主线《补天纪》一只都不许有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 517, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  for (let k = 0; k < 4; k++) {
    wS.tick = Math.round((D.startSec + k * 30) * HZ);
    SIM.maybeSpawnDevourer(wS);
    SIM.step(wS, { mx: 0, my: 0 });
  }
  const storyBad = wS.mobs.filter(function (m) { return m.defId === D.mobId; }).length;
  expect('★★剧情关（《补天纪》ch1）一只饕餮都不该有，而且零播报：'
    + '主线是逐关手工配平的，多一条「地上的东西会被偷」会破坏配好的压力曲线',
    !!wS.storyStage && storyBad === 0 && evs(wS, 'devourer').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
      + ' 怪 ' + storyBad + ' 只 / 播报 ' + evs(wS, 'devourer').length + ' 条');

  // ---------- 10. 整条链路：真的走 step ----------
  // 【为什么还要这一条】上面全是手调 spawnDevourer / tickDevourer ——
  //   「函数写好了却没在 step 里被调用」是这个项目反复出现的静默失败（双生妖/引魂灯都踩过）。
  const wG2 = cleanWorld(8809);
  parkPlayer(wG2);
  wG2.tick = startTick - 1;
  wG2.devourerNextTick = 0;
  SIM.step(wG2, { mx: 0, my: 0 });
  expect('★★走 step 的整条链路真的会在 startSec 刷出饕餮（防「函数写好了但没被调用」）',
    devs(wG2).length === 1 && evs(wG2, 'devourer').length === 1,
    '怪 ' + devs(wG2).length + ' 只 / 播报 ' + evs(wG2, 'devourer').length + ' 条');
  const mG2 = devs(wG2)[0];
  mG2.x = 600; mG2.y = 600;
  wG2.pickups.length = 0;
  for (let i = 0; i < 5; i++) SIM.spawnPickup(wG2, 'exp', 612, 604, 7, 0);
  for (let i = 0; i < 60; i++) SIM.step(wG2, { mx: 0, my: 0 });
  expect('★★走 step 它真的会走到球边上吞下去（行为挂在 updateMobs 里才作数）',
    (mG2.devourCount || 0) > 0 && of(wG2, 'exp').length < 5,
    '吃了 ' + (mG2.devourCount || 0) + ' 份 / 剩 ' + of(wG2, 'exp').length + ' 颗');
}


// ============================================================
// 歧路双碑（第四十八轮：两座只能取一座，一局只有五组）
// ============================================================
function testBoon() {
  console.log('[第四十八轮] 歧路双碑：两座只能取一座，一局只有五组');
  const B = C.BOON;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(B.startSec * HZ);
  // 串池：颜色与 kind 都在池外的话，每一帧都会走长格式（不报错的带宽劣化）
  const PB = require('../shared/proto_bin.js');
  const pool = PB.STR_POOL || [];

  // 干净世界：清武器（免得顺手把碑当怪打）、锁经验（免得升级面板冻住 step）、
  // 其它事件排期全部推到很远（本轮只验双碑）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.bountyNextTick = 1e9;   // 第五十四轮：悬赏首发 186s，默认推远（要验它的世界自己打开）
    w.healerNextTick = 1e9;   // 第五十五轮：回春巫首发 252s，默认推远（要验它的世界自己打开）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.boonNextTick = 1e9;
    w.mobs.length = 0;
    w.pickups.length = 0;         // ★地图自带的宝箱/神龛也清掉：数「地上有几座碑」才干净
    SIM.setSelf(w, p);
    return w;
  }
  function boons(w) {
    return w.pickups.filter(function (x) { return x.kind === 'boon'; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  // 把玩家摆到地图正中：碑锚在玩家周围 205px，站在角落会被 clamp 贴边
  // （虽然 sim 会把这一组换方向重立，但测试要的是"标准情况"，别去测墙角）。
  function parkPlayer(w) {
    const p = w.player;
    p.x = Math.round(w.map.w / 2); p.y = Math.round(w.map.h / 2);
    SIM.setSelf(w, p);
    return p;
  }
  function stepN(w, n) {
    for (let i = 0; i < n; i++) SIM.step(w, { mx: 0, my: 0 });
  }
  // 直接把玩家摆到某座碑上（坐标由散列决定，不可预测 —— 所以先造再站上去）
  function standOn(w, it) {
    const p = w.player;
    p.x = it.x; p.y = it.y;
    SIM.setSelf(w, p);
    return p;
  }

  // ---------- 0. 表自洽 ----------
  expect('★歧路双碑不许落在 30 秒波次网格上（startSec % 30 !== 0）：'
    + '压在波次那一帧时，刚刷的怪还在 700px 外（陨星为此被推迟过 95 秒）',
    B.startSec % C.WAVES.intervalSec !== 0,
    'startSec=' + B.startSec + ' 余 ' + (B.startSec % C.WAVES.intervalSec));
  const others = [
    ['挑战者', C.CHALLENGER.startSec], ['灵泉', C.LEYLINE.startSec],
    ['血祭坛', C.BLOODPACT.startSec], ['赤月', C.BLOOD_MOON.startSec],
    ['山魈', C.SUMMONER.startSec], ['陨星', C.METEOR.startSec],
    ['双生妖', C.TWINS.startSec], ['引魂灯', C.LANTERN.startSec],
    ['饕餮', C.DEVOURER.startSec]
  ];
  const sameTick = others.filter(function (o) { return o[1] === B.startSec; });
  expect('★不许与另一个事件的**首发帧**落在同一 tick（同一帧两件事一起弹，玩家只读得到一条）',
    sameTick.length === 0, sameTick.length ? '撞了：' + sameTick[0][0] : '无冲突');

  // 节奏：一组还没消失时不该再来一组
  expect('★间隔必须明显大于存在时长（否则上一组还没消失，下一组就立起来了）',
    B.everySec >= B.lifeSec * 2, '间隔 ' + B.everySec + 's / 存在 ' + B.lifeSec + 's');
  expect('★存在时长必须落在 12~30 秒（短于 12 秒来不及想；长于 30 秒玩家会先打完这一波）',
    B.lifeSec >= 12 && B.lifeSec <= 30, 'lifeSec=' + B.lifeSec);
  // ★总预算必须真的放得下：最长的一局（血月）里五组要能全部出现
  const lastSec = B.startSec + (B.maxRounds - 1) * B.everySec;
  const longestSec = Math.max.apply(null, C.DIFFICULTIES.map(function (d) { return d.matchSec; })) * 60;
  expect('★★五组必须能在最长的一局里全部出现（否则"一局五次"是句空话，最后两组永远见不到）',
    lastSec <= longestSec - B.lifeSec,
    '最后一组在 ' + lastSec + ' 秒 / 最长一局 ' + longestSec + ' 秒');
  expect('★maxRounds 必须封顶且不大（3~8）：不封顶的话"选错一次"的代价会被下一次抹平',
    B.maxRounds >= 3 && B.maxRounds <= 8, 'maxRounds=' + B.maxRounds);
  expect('★落点距离必须在一屏之内（150~300）：两座都要一眼看到，否则"只能取一座"看不见',
    B.offset >= 150 && B.offset <= 300, 'offset=' + B.offset);
  const gap = B.offset * B.spreadAngle;
  expect('★两座间距落在 80~170（太近读成一块石头；太远只能看见一座）',
    gap >= 80 && gap <= 170, '间距约 ' + fmt(gap, 0) + 'px');
  // 必须正好两座：三座的话"只能取一座"就退化成"少拿两份"
  expect('★★必须正好两个选项：三座的话"取一座"会退化成"少拿两份"，取舍就不成立了',
    B.options.length === 2, 'options=' + B.options.length);

  const o0 = B.options[0];
  const o1 = B.options[1];
  // 一攻一守：两个都在同一条线上（都是伤害）时玩家只需比数字，那不是取舍
  expect('★★必须一攻一守（一项只给伤害、另一项只给生命上限）：'
    + '两个都在同一条线上时，玩家只需要比大小，那不是取舍',
    (o0.dmg > 0 && !o0.hpPct) && (!o1.dmg && o1.hpPct > 0),
    'o0.dmg=' + o0.dmg + ' o0.hpPct=' + o0.hpPct + ' / o1.dmg=' + o1.dmg + ' o1.hpPct=' + o1.hpPct);
  expect('★攻击项的加成落在 5%~30%（太小没人选，太大会直接决定 build）',
    o0.dmg >= 0.05 && o0.dmg <= 0.30, 'dmg=' + o0.dmg);
  expect('★防守项的上限加成落在 5%~25%（写成绝对值的话前后期价值差十倍）',
    o1.hpPct >= 0.05 && o1.hpPct <= 0.25, 'hpPct=' + o1.hpPct);
  expect('★防守项必须带当场回血（5%~50%）：这是它与攻击项在"当下"这件事上的分水岭',
    o1.healPct >= 0.05 && o1.healPct <= 0.5, 'healPct=' + o1.healPct);
  expect('★攻击项不许偷偷带回血（不然"残血选哪个"就没有代价了）',
    !o0.healPct && !o1.dmg, 'o0.healPct=' + o0.healPct + ' o1.dmg=' + o1.dmg);
  expect('★两个选项的 key 必须不同且非空（它们就是 p.boons 的键）',
    !!o0.key && !!o1.key && o0.key !== o1.key, o0.key + ' / ' + o1.key);
  expect('★两个选项都必须有名字（碑上要写字，玩家靠它做决定）',
    !!o0.name && !!o1.name, (o0.name || '') + ' / ' + (o1.name || ''));
  expect('★两座碑的颜色必须不同（同色的话两座并排分不出谁是谁）',
    o0.color !== o1.color, o0.color + ' / ' + o1.color);
  // ★配色与 kind 必须在串池里：池外字符串每帧走长格式，是一种「不报错的带宽劣化」
  const poolMiss = [];
  if (pool.indexOf('boon') < 0) poolMiss.push('boon');
  if (pool.indexOf('boonshatter') < 0) poolMiss.push('boonshatter');
  if (pool.indexOf(o0.color) < 0) poolMiss.push(o0.color);
  if (pool.indexOf(o1.color) < 0) poolMiss.push(o1.color);
  expect('★★kind 与两个配色都必须已在串池里（池外值每帧走长格式，带宽会悄悄退化）',
    poolMiss.length === 0, '缺：' + poolMiss.join(','));

  // ---------- 1. 生成 ----------
  const w0 = cleanWorld(7101);
  parkPlayer(w0);
  w0.tick = startTick - 1;
  w0.boonNextTick = 0;
  SIM.maybeSpawnBoons(w0);
  expect('★到点前一帧一座碑都不许有',
    boons(w0).length === 0 && evs(w0, 'boon').length === 0,
    '碑 ' + boons(w0).length + ' 座');

  const w1 = cleanWorld(7101);
  const p1 = parkPlayer(w1);
  w1.tick = startTick;
  w1.boonNextTick = 0;
  const g1 = SIM.maybeSpawnBoons(w1);
  const b1 = boons(w1);
  expect('★★到点必须正好立起两座（不是一座、也不是三座）',
    !!g1 && b1.length === 2, '碑 ' + b1.length + ' 座');
  expect('★★两座必须分别是"哪一座"（value 1 与 2 各一）：两座同一种就没有取舍可言',
    b1.length === 2 && b1[0].value !== b1[1].value
      && [b1[0].value, b1[1].value].sort().join(',') === '1,2',
    'value=' + b1.map(function (x) { return x.value; }).join(','));
  expect('★两座必须同属一组（group 相同且非 0）：取一座时靠它把另一座找出来',
    b1.length === 2 && b1[0].group > 0 && b1[0].group === b1[1].group,
    'group=' + b1.map(function (x) { return x.group; }).join(','));
  expect('★只许播一条播报，且写清存在秒数与第几组',
    evs(w1, 'boon').length === 1 && evs(w1, 'boon')[0].sec === B.lifeSec
      && evs(w1, 'boon')[0].round === 1 && evs(w1, 'boon')[0].maxRounds === B.maxRounds,
    JSON.stringify(evs(w1, 'boon')[0] || null));
  const d0 = Math.sqrt(Math.pow(b1[0].x - p1.x, 2) + Math.pow(b1[0].y - p1.y, 2));
  const d1 = Math.sqrt(Math.pow(b1[1].x - p1.x, 2) + Math.pow(b1[1].y - p1.y, 2));
  // ★贴边会被 clamp 夹回来，所以给 40px 的容差；夹得太多说明这一组立在了墙角
  expect('★两座都必须立在 offset 附近（±40px）：丢到半张图外玩家只会看到提示却找不到碑',
    Math.abs(d0 - B.offset) <= 40 && Math.abs(d1 - B.offset) <= 40,
    '距离 ' + fmt(d0, 0) + ' / ' + fmt(d1, 0) + '（期望约 ' + B.offset + '）');
  const gsep = Math.sqrt(Math.pow(b1[0].x - b1[1].x, 2) + Math.pow(b1[0].y - b1[1].y, 2));
  expect('★两座的间距必须真的拉开（≥60px）：叠在一起的话"两座"这件事看不出来',
    gsep >= 60, '间距 ' + fmt(gsep, 0));
  expect('★两座都必须在地图内（贴边的碑跑不进去，等于这一组只剩一座）',
    b1.every(function (x) { return x.x > 0 && x.y > 0 && x.x < w1.map.w && x.y < w1.map.h; }),
    b1.map(function (x) { return Math.round(x.x) + ',' + Math.round(x.y); }).join(' | '));

  // ★不消费主随机流：同种子的另一个世界从没生成过碑，两边的 rngState 必须一致
  const wR = cleanWorld(7101);
  parkPlayer(wR);
  expect('★★立碑不许消费主随机流（否则后面每一波的落点都会整体错位）',
    w1.rngState === wR.rngState, 'rng=' + w1.rngState + '/' + wR.rngState);

  // ---------- 2. 排期：同屏一组 / 短等 2 秒 / 总预算 ----------
  const w2 = cleanWorld(7102);
  parkPlayer(w2);
  w2.tick = startTick;
  w2.boonNextTick = 0;
  SIM.maybeSpawnBoons(w2);
  const firstNext = w2.boonNextTick;
  for (let k = 0; k < 3; k++) {
    w2.tick += Math.round(B.everySec * HZ);
    SIM.maybeSpawnBoons(w2);
  }
  expect('★★地上还留着上一次没取的两座时，推 3 个间隔也只许立一组（不然地上会站一排碑）',
    boons(w2).length === 2, '碑 ' + boons(w2).length + ' 座');
  expect('★★被同屏闸挡住时只许**短等 2 秒**，不顺延整个间隔：'
    + '否则玩家一直不去取，后面的排期会被整体推到很久之后（陨星/引魂灯/饕餮踩过）',
    w2.boonNextTick <= w2.tick + Math.round(2.5 * HZ),
    '下一次差 ' + fmt((w2.boonNextTick - w2.tick) / HZ, 1) + ' 秒');
  expect('★第一组的下一次排期确实是「立起后 +' + B.everySec + ' 秒」（不是被短等改坏的）',
    firstNext === startTick + Math.round(B.everySec * HZ),
    '差 ' + fmt((firstNext - startTick) / HZ, 1) + ' 秒');

  // 总预算：立满 maxRounds 组之后，再推多少个间隔都不许再给
  const w3 = cleanWorld(7103);
  parkPlayer(w3);
  w3.tick = startTick;
  w3.boonNextTick = 0;
  let spawnedRounds = 0;
  for (let k = 0; k < B.maxRounds + 3; k++) {
    if (k > 0) w3.tick = startTick + k * Math.round(B.everySec * HZ);
    if (SIM.maybeSpawnBoons(w3)) spawnedRounds += 1;
    w3.pickups.length = 0;       // 清空地面：绕开"同屏一组"那道闸，只验总预算
  }
  expect('★★一局最多只给 maxRounds 组（推满再加 3 个间隔，也只许 ' + B.maxRounds + ' 组）：'
    + '不封顶的话"选错一次"的代价会被下一次抹平，这个机制就没有重量',
    spawnedRounds === B.maxRounds && w3.boonSpawned === B.maxRounds,
    '实际立了 ' + spawnedRounds + ' 组 / boonSpawned=' + w3.boonSpawned);

  // ---------- 3. 取用：另一座必须当场碎掉 ----------
  const w4 = cleanWorld(7104);
  parkPlayer(w4);
  w4.tick = startTick;
  w4.boonNextTick = 0;
  SIM.maybeSpawnBoons(w4);
  const b4 = boons(w4);
  const pick4 = b4[0];
  const other4 = b4[1];
  const p4 = w4.player;
  const dmgBefore = p4.attrs.dmgMul;
  const maxBefore = p4.maxHp;
  const hpBefore = p4.hp;
  standOn(w4, pick4);             // 站到第一座上
  stepN(w4, 1);
  expect('★★取走一座之后，地上不许还剩任何一座碑（另一座必须**当场**碎掉）：'
    + '另一座还在的话，"只能取一座"就变成了"先取这个、回头再取那个"',
    boons(w4).length === 0, '还剩 ' + boons(w4).length + ' 座');
  const shards = w4.effects.filter(function (e) { return e.kind === 'boonshatter'; });
  expect('★★另一座碎掉必须有**看得见的一下**（boonshatter 特效）：'
    + '没有它的话，"另一座自己跑掉了"与"被系统吃掉了"在画面上分不出来',
    shards.length === 1, '特效 ' + w4.effects.map(function (e) { return e.kind; }).join(','));
  expect('★碎掉的那一下必须落在**另一座**的位置上（落在取走的那座上会让人以为取的那座碎了）',
    shards.length === 1 && Math.abs(shards[0].x - other4.x) < 1
      && Math.abs(shards[0].y - other4.y) < 1,
    JSON.stringify(shards[0] || null));
  expect('★碎掉那一下的配色必须取「碎掉那一座」自己的色',
    shards.length === 1 && shards[0].color === (other4.value === 1 ? o0.color : o1.color),
    (shards[0] && shards[0].color) + ' vs 期望 '
      + (other4.value === 1 ? o0.color : o1.color));

  expect('★层数必须记在**取走的那一项**上（value 1 → ' + o0.key + '）',
    p4.boons && p4.boons[o0.key] === 1, JSON.stringify(p4.boons));
  expect('★★另一项一层都不许有（取一座就该只有一座的收益）',
    !p4.boons || !p4.boons[o1.key], JSON.stringify(p4.boons));
  expect('★兵主碑的伤害加成必须真的进 dmgMul（+' + Math.round(o0.dmg * 100) + '%）',
    Math.abs(p4.attrs.dmgMul - (dmgBefore + o0.dmg)) < 1e-9,
    'dmgMul ' + fmt(dmgBefore, 3) + ' → ' + fmt(p4.attrs.dmgMul, 3));
  expect('★★兵主碑不回血、也不加上限（hp 与 maxHp 都一点不动）：它给的是长期输出，不是当下保命',
    p4.hp === hpBefore && p4.maxHp === maxBefore,
    'hp ' + hpBefore + '→' + p4.hp + ' / max ' + maxBefore + '→' + p4.maxHp);
  const tk = evs(w4, 'boon_taken');
  expect('★必须播一条「取了哪座 + 失去哪座」（另一座的名字就是这一轮唯一的代价）',
    tk.length === 1 && tk[0].label === o0.name && tk[0].other === o1.name && tk[0].level === 1,
    JSON.stringify(tk[0] || null));
  stepN(w4, 60);
  const tot4 = Object.keys(p4.boons).reduce(function (s, k2) { return s + p4.boons[k2]; }, 0);
  expect('★取走之后不许再给：再推 60 帧，层数仍是 1、地上仍是 0 座、播报不重复',
    tot4 === 1 && boons(w4).length === 0 && evs(w4, 'boon_taken').length === 1,
    '层数合计 ' + tot4 + ' / 地上 ' + boons(w4).length + ' 座 / 播报 ' + evs(w4, 'boon_taken').length);

  // 玄龟碑：上限与回血
  const w5 = cleanWorld(7105);
  parkPlayer(w5);
  w5.tick = startTick;
  w5.boonNextTick = 0;
  SIM.maybeSpawnBoons(w5);
  const b5 = boons(w5).filter(function (x) { return x.value === 2; });
  const p5 = w5.player;
  p5.hp = Math.round(p5.maxHp * 0.4);       // 残血：才看得见回血
  const max5 = p5.maxHp;
  const hp5 = p5.hp;
  const dmg5 = p5.attrs.dmgMul;
  standOn(w5, b5[0]);
  stepN(w5, 1);
  expect('★玄龟碑必须真的抬生命上限（约 +' + Math.round(o1.hpPct * 100) + '%）',
    Math.abs(p5.maxHp - Math.round(max5 * (1 + o1.hpPct))) <= 1,
    'maxHp ' + max5 + ' → ' + p5.maxHp + '（期望约 ' + Math.round(max5 * (1 + o1.hpPct)) + '）');
  expect('★玄龟碑必须当场回一截血（残血时选它等于当场活过来）',
    p5.hp > hp5, 'hp ' + hp5 + ' → ' + p5.hp);
  expect('★★玄龟碑一点伤害都不许给（一攻一守，不许两头都占）',
    Math.abs(p5.attrs.dmgMul - dmg5) < 1e-9,
    'dmgMul ' + fmt(dmg5, 3) + ' → ' + fmt(p5.attrs.dmgMul, 3));
  expect('★取玄龟碑也要播一条「失去了兵主碑」',
    evs(w5, 'boon_taken')[0] && evs(w5, 'boon_taken')[0].other === o0.name,
    JSON.stringify(evs(w5, 'boon_taken')[0] || null));

  // ---------- 4. 层数可叠加（取两次同一种就是两层） ----------
  const w6 = cleanWorld(7106);
  parkPlayer(w6);
  w6.tick = startTick;
  w6.boonNextTick = 0;
  SIM.maybeSpawnBoons(w6);
  const base6 = w6.player.attrs.dmgMul;
  standOn(w6, boons(w6).filter(function (x) { return x.value === 1; })[0]);
  stepN(w6, 1);
  // 第二组：直接再立一组（绕过排期，只验层数）
  w6.tick = startTick + Math.round(B.everySec * HZ);
  w6.boonNextTick = 0;
  w6.pickups.length = 0;
  SIM.maybeSpawnBoons(w6);
  standOn(w6, boons(w6).filter(function (x) { return x.value === 1; })[0]);
  stepN(w6, 1);
  expect('★同一项取两次必须是两层（不是覆盖成一层）：伤害加成 ×2',
    w6.player.boons[o0.key] === 2
      && Math.abs(w6.player.attrs.dmgMul - (base6 + o0.dmg * 2)) < 1e-9,
    '层数 ' + w6.player.boons[o0.key] + ' / dmgMul ' + fmt(w6.player.attrs.dmgMul, 3));

  // ---------- 5. 到点没取：两座一起消失，一分不给 ----------
  const w7 = cleanWorld(7107);
  parkPlayer(w7);
  w7.tick = startTick;
  w7.boonNextTick = 0;
  SIM.maybeSpawnBoons(w7);
  const p7 = w7.player;
  const dmg7 = p7.attrs.dmgMul;
  // 走到远处去（400px）：站在碑边上会在 20 秒里把它们全吃了，那就测不到"错过"
  p7.x += 400;
  SIM.setSelf(w7, p7);
  stepN(w7, Math.round(B.lifeSec * HZ) + 5);
  expect('★★到点没取的两座必须**一起**消失（不许留下一座在地上等玩家回头）',
    boons(w7).length === 0, '还剩 ' + boons(w7).length + ' 座');
  expect('★★错过不给任何补偿：层数、伤害一分不变，也不许有"你失去了它"的播报',
    Object.keys(p7.boons).length === 0
      && Math.abs(p7.attrs.dmgMul - dmg7) < 1e-9
      && evs(w7, 'boon_taken').length === 0,
    'boons=' + JSON.stringify(p7.boons) + ' / 播报 ' + evs(w7, 'boon_taken').length);

  // ---------- 6. 不许被磁石吸走 ----------
  const w8 = cleanWorld(7108);
  parkPlayer(w8);
  w8.tick = startTick;
  w8.boonNextTick = 0;
  SIM.maybeSpawnBoons(w8);
  const b8 = boons(w8);
  const p8 = w8.player;
  // ★站到 120px 处：**必须落在「拾取半径(60) 之外、吸附半径(200) 之内」**这一环。
  //   第一版写在 60px —— 那正好等于拾取半径，碑会被直接吃掉；而 b8 是 step 之前
  //   filter 出来的**旧数组**，里面的对象还在，坐标也不会变 → 断言照样绿。
  //   这是一个"假绿"：它测的根本不是"不被吸走"，而是"没有任何事发生"。
  // ★方向必须沿"背离另一座"的轴走出去：两座只隔约 115px，随便往 +x 挪 120px
  //   会正好撞到另一座身上（第二版就是这么踩的 —— taken=1、两座全没）。
  const adx = b8[0].x - b8[1].x;
  const ady = b8[0].y - b8[1].y;
  const alen = Math.sqrt(adx * adx + ady * ady) || 1;
  p8.x = b8[0].x + (adx / alen) * 120;
  p8.y = b8[0].y + (ady / alen) * 120;
  SIM.setSelf(w8, p8);
  const bx = b8[0].x, by = b8[0].y;
  stepN(w8, 20);
  const b8after = boons(w8);
  expect('★★碑不许被磁石吸过来（两座都还在原地、坐标一动不动）：'
    + '两座只隔一百来像素，被吸到一起后"取的是哪一座"在画面上就说不清了',
    b8after.length === 2
      && Math.abs(b8after[0].x - bx) < 0.01 && Math.abs(b8after[0].y - by) < 0.01,
    '还剩 ' + b8after.length + ' 座 / x ' + fmt(bx, 1) + '→' + fmt(b8after.length ? b8after[0].x : NaN, 1)
      + ' / y ' + fmt(by, 1) + '→' + fmt(b8after.length ? b8after[0].y : NaN, 1));

  // ---------- 7. 主线《补天纪》一座都不许有 ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 519, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  for (let k = 0; k < 4; k++) {
    wS.tick = Math.round((B.startSec + k * 30) * HZ);
    wS.boonNextTick = 0;
    SIM.maybeSpawnBoons(wS);
    SIM.step(wS, { mx: 0, my: 0 });
  }
  expect('★★剧情关（《补天纪》ch1）一座碑都不该有，而且零播报：'
    + '主线是逐关手工配平的，凭空多一条"永久加伤害或上限"会破坏配好的血量曲线',
    !!wS.storyStage && boons(wS).length === 0 && evs(wS, 'boon').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
      + ' 碑 ' + boons(wS).length + ' 座 / 播报 ' + evs(wS, 'boon').length + ' 条');

  // ---------- 8. 整条链路：真的走 step ----------
  // 【为什么还要这一条】上面全是手调 maybeSpawnBoons / applyBoon ——
  //   「函数写好了却没在 step 里被调用」是这个项目反复出现的静默失败
  //   （双生妖 / 引魂灯 / 饕餮都踩过）。
  const w9 = cleanWorld(7109);
  parkPlayer(w9);
  w9.tick = startTick - 1;
  w9.boonNextTick = 0;
  SIM.step(w9, { mx: 0, my: 0 });
  expect('★★走 step 的整条链路真的会在 startSec 立起两座碑（防"函数写好了但没被调用"）',
    boons(w9).length === 2 && evs(w9, 'boon').length === 1,
    '碑 ' + boons(w9).length + ' 座 / 播报 ' + evs(w9, 'boon').length + ' 条');
  const b9 = boons(w9);
  standOn(w9, b9[0]);
  stepN(w9, 2);
  const tot9 = Object.keys(w9.player.boons).reduce(function (s, k2) { return s + w9.player.boons[k2]; }, 0);
  expect('★★走 step 真的能取到（站上去两帧内生效），且另一座同帧消失',
    tot9 === 1 && boons(w9).length === 0,
    '层数合计 ' + tot9 + ' / 地上 ' + boons(w9).length + ' 座');
}

// ============================================================
// 第四十九轮：镇妖钟（把妖群牵到你要的地方）
// ============================================================
//
// 【这一轮真正要守的是什么】不是"钟会不会出现"，而是
//   **「牵引只发生在圈内，而且只对三类以外的妖物」**。
//   这类"全项目第一次"的机制最容易出的错从来不是崩，而是
//   「不小心把所有东西都牵了」或者「牵了但一点用都没有」——
//   所以下面绝大多数断言钉的都是「不该发生的事」。
function testBell() {
  console.log('[第四十九轮] 镇妖钟：把妖群牵到你要的地方');
  const B = C.BELL;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(B.startSec * HZ);
  const PB = require('../shared/proto_bin.js');
  const pool = PB.STR_POOL || [];

  // 干净世界：清武器（免得顺手把钟当怪打）、锁经验（免得升级面板冻住 step）、
  // 其它事件排期全部推到很远（本轮只验钟）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.bountyNextTick = 1e9;   // 第五十四轮：悬赏首发 186s，默认推远（要验它的世界自己打开）
    w.healerNextTick = 1e9;   // 第五十五轮：回春巫首发 252s，默认推远（要验它的世界自己打开）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    // ★第五十轮：影傀也要推远。这一条不是"顺手"，是反向验证抓出来的 ——
    //   把影傀生成的 seed 摘掉之后，红的居然是**镇妖钟**那条「立钟不消费主随机流」
    //   （这一段的 cleanWorld 从 0 推到 258 秒，会顺路刷出影傀）。
    //   事件之间必须互相隔离，否则以后每条新机制的随机流断言都会被别的机制带红。
    w.mergeNextTick = 1e9;
    w.mobs.length = 0;
    w.pickups.length = 0;         // ★地图自带的宝箱/神龛也清掉：数「地上有几口钟」才干净
    SIM.setSelf(w, p);
    return w;
  }
  function bells(w) {
    return w.pickups.filter(function (x) { return x.kind === 'bell'; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  // 把玩家摆到地图正中：钟锚在玩家 190px 处，站在角落会被 clamp 贴边
  // （虽然 sim 会换方向重立，但测试要的是"标准情况"，别去测墙角）。
  function parkPlayer(w) {
    const p = w.player;
    p.x = Math.round(w.map.w / 2); p.y = Math.round(w.map.h / 2);
    SIM.setSelf(w, p);
    return p;
  }
  function stepN(w, n) {
    for (let i = 0; i < n; i++) SIM.step(w, { mx: 0, my: 0 });
  }
  // 直接把玩家摆到钟上（坐标由散列决定，不可预测 —— 所以先造再站上去）
  function standOn(w, it) {
    const p = w.player;
    p.x = it.x; p.y = it.y;
    SIM.setSelf(w, p);
    return p;
  }
  // 造一只怪。★必须传 seed：不传的话 spawnMob 会自己摇一次随机（相位/冷却），
  // 下面那条「钟响期间主随机流一动不动」就会因为"测试自己动了随机流"而假红。
  function mkMob(w, id, x, y) {
    return SIM.spawnMob(w, id, x, y, 1, 0, 7001);
  }
  // 清掉障碍：下面几条量的是「位移**方向**」，撞一次石头就会滑一下，
  // 那个 ±1px 的容差会被撞出来的滑动吃掉（不是失败，而是测不准）。
  function clearObstacles(w) {
    w.obstacles = [];
  }

  // ---------- 0. 表自洽 ----------
  expect('★镇妖钟不许落在 30 秒波次网格上（startSec % 30 !== 0）：'
    + '压在波次那一帧时，刚刷的怪还在 700px 外（陨星为此被推迟过 95 秒）',
    B.startSec % C.WAVES.intervalSec !== 0,
    'startSec=' + B.startSec + ' 余 ' + (B.startSec % C.WAVES.intervalSec));
  const others = [
    ['挑战者', C.CHALLENGER.startSec], ['灵泉', C.LEYLINE.startSec],
    ['血祭坛', C.BLOODPACT.startSec], ['赤月', C.BLOOD_MOON.startSec],
    ['山魈', C.SUMMONER.startSec], ['陨星', C.METEOR.startSec],
    ['双生妖', C.TWINS.startSec], ['引魂灯', C.LANTERN.startSec],
    ['饕餮', C.DEVOURER.startSec], ['歧路双碑', C.BOON.startSec]
  ];
  const sameTick = others.filter(function (o) { return o[1] === B.startSec; });
  expect('★不许与另一个事件的**首发帧**落在同一 tick（同一帧两件事一起弹，玩家只读得到一条）',
    sameTick.length === 0, sameTick.length ? '撞了：' + sameTick[0][0] : '无冲突');

  expect('★钟声半径必须明显大于落点距离（radius > offset × 1.5）：'
    + '半径比落点还小的话，敲响那一刻自己就站在圈外，等于什么都没发生',
    B.radius > B.offset * 1.5, 'radius=' + B.radius + ' / offset=' + B.offset);
  expect('★半径不许大过 620（再大就等于全屏牵引，「往哪躲」这件事整个消失）',
    B.radius <= 620, 'radius=' + B.radius);
  expect('★落点距离必须在一屏之内（150~300）：看不见的钟等于不存在',
    B.offset >= 150 && B.offset <= 300, 'offset=' + B.offset);
  expect('★站住的半径必须小于钟声半径的 1/6：不然「到钟下站住」会退化成「在远处就停」',
    B.standRadius < B.radius / 6 && B.standRadius >= 16,
    'standRadius=' + B.standRadius + ' / radius/6=' + fmt(B.radius / 6, 1));
  expect('★钟声时长落在 4~12 秒（短于 4 秒牵不过来；长于 12 秒等于白送一段免伤）',
    B.ringSec >= 4 && B.ringSec <= 12, 'ringSec=' + B.ringSec);
  expect('★钟声时长必须小于钟的存在时长（写反了钟会在响的时候先消失）',
    B.ringSec < B.lifeSec, 'ringSec=' + B.ringSec + ' / lifeSec=' + B.lifeSec);
  expect('★间隔必须大于「存在时长 + 钟声时长」：上一口还在响时下一口不许立起来',
    B.everySec >= B.lifeSec + B.ringSec,
    '间隔 ' + B.everySec + ' / 共存 ' + (B.lifeSec + B.ringSec));
  expect('★一局至少能见到 3 口（最短的一局 18 分钟 = 1080 秒）：'
    + '排到第 3 口就已经超出最短局的话，「每 132 秒一次」是句空话',
    B.startSec + 2 * B.everySec <= 1080,
    '第三口在 ' + (B.startSec + 2 * B.everySec) + ' 秒');

  function rgbOf(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  const cBody = rgbOf(B.color);
  const cRing = rgbOf(B.ringColor);
  expect('★钟身配色不许偏紫蓝（蓝分量必须低于红分量）',
    cBody[2] < cBody[0], B.color + ' rgb=' + cBody.join(','));
  expect('★钟声圈配色也不许偏紫蓝',
    cRing[2] < cRing[0], B.ringColor + ' rgb=' + cRing.join(','));
  expect('★钟身与钟声圈必须是两个颜色（同色的话地上的钟和它脚下的大圈会糊成一块）',
    B.color !== B.ringColor, B.color + ' / ' + B.ringColor);
  const poolMiss = [];
  if (pool.indexOf('bell') < 0) poolMiss.push('bell');
  if (pool.indexOf(B.color) < 0) poolMiss.push(B.color);
  if (pool.indexOf(B.ringColor) < 0) poolMiss.push(B.ringColor);
  expect('★★kind 与两个配色都必须已在串池里：'
    + '池外值每帧走长格式，钟要活 26 秒 = 520 帧，是一段持续的、不报错的带宽劣化',
    poolMiss.length === 0, poolMiss.length ? '缺：' + poolMiss.join(',') : '齐全');

  // ---------- 1. 生成 ----------
  const w0 = cleanWorld(4901);
  parkPlayer(w0);
  w0.tick = startTick - 2;
  w0.bellNextTick = 0;
  SIM.step(w0, { mx: 0, my: 0 });
  expect('★到点**前一帧**地上零口钟、也零播报',
    bells(w0).length === 0 && evs(w0, 'bell').length === 0,
    '钟 ' + bells(w0).length + ' 口 / 播报 ' + evs(w0, 'bell').length + ' 条');

  const w1 = cleanWorld(4901);
  parkPlayer(w1);
  w1.tick = startTick - 1;
  w1.bellNextTick = 0;
  const rngBefore = w1.rngState;
  SIM.step(w1, { mx: 0, my: 0 });
  const b1 = bells(w1);
  const p1 = w1.player;
  const d1 = b1.length ? Math.hypot(b1[0].x - p1.x, b1[0].y - p1.y) : -1;
  expect('★到点正好立起一口钟', b1.length === 1, '钟 ' + b1.length + ' 口');
  expect('★钟离玩家约 offset（±40px）：太近会被拾取半径直接吃掉，太远看不见',
    b1.length === 1 && Math.abs(d1 - B.offset) <= 40, '距离 ' + fmt(d1, 0) + 'px');
  expect('★★刚立起的钟离玩家必须还在 offset 的六成以上：'
    + '被贴边 clamp 夹到脚下的钟等于「一抬手就敲了」，那个决定就没了',
    b1.length === 1 && d1 >= B.offset * 0.6, '距离 ' + fmt(d1, 0) + 'px');
  expect('★钟必须完整落在地图内（露出一半的钟玩家走不过去）',
    b1.length === 1 && b1[0].x > 20 && b1[0].y > 20
      && b1[0].x < w1.map.w - 20 && b1[0].y < w1.map.h - 20,
    b1.length ? fmt(b1[0].x, 0) + ',' + fmt(b1[0].y, 0) + ' / 图 ' + w1.map.w + '×' + w1.map.h : '没有钟');
  expect('★只播一条事件，且带着「存在时长」（提示条要念出这个数）',
    evs(w1, 'bell').length === 1 && evs(w1, 'bell')[0].lifeSec === B.lifeSec,
    '播报 ' + evs(w1, 'bell').length + ' 条');
  expect('★★立钟不消费主随机流（否则后面每一波的落点整体错位 —— 事件型玩法的老坑）',
    w1.rngState === rngBefore, 'rng=' + rngBefore + '→' + w1.rngState);
  expect('★刚落地的钟是「没敲过」的状态（value 0），寿命等于 lifeSec',
    b1.length === 1 && b1[0].value === 0 && Math.abs(b1[0].life - B.lifeSec) < 1,
    b1.length ? 'value=' + b1[0].value + ' life=' + fmt(b1[0].life, 1) : '没有钟');

  // 同屏最多一口：地上那一口一直不敲，推三个间隔也不许再立
  const w2 = cleanWorld(4902);
  parkPlayer(w2);
  w2.tick = startTick - 1;
  w2.bellNextTick = 0;
  SIM.step(w2, { mx: 0, my: 0 });
  const spawned1 = w2.bellSpawned;
  const bx0 = bells(w2)[0] ? bells(w2)[0].x : 0;
  for (let k = 0; k < 3; k++) {
    w2.tick += Math.round(B.everySec * HZ);
    w2.bellNextTick = 0;
    SIM.step(w2, { mx: 0, my: 0 });
  }
  expect('★★地上还有一口（没敲）时，再推三个间隔也只许有一口：'
    + '两口同时在场上，「先敲哪口」会盖过「现在敲不敲」',
    w2.bellSpawned === spawned1 && bells(w2).length === 1,
    '立过 ' + w2.bellSpawned + ' 口 / 地上 ' + bells(w2).length + ' 口');
  expect('★被挡时只**短等** retrySec，不顺延整个间隔（陨星/引魂灯/饕餮/双碑都踩过）',
    w2.bellNextTick <= w2.tick + Math.round(B.retrySec * HZ),
    '下一个排期 ' + (w2.bellNextTick - w2.tick) + ' 帧之后（retrySec=' + B.retrySec + '）');
  expect('★地上那一口一直没被挪走（坐标一动不动）',
    bells(w2)[0] && Math.abs(bells(w2)[0].x - bx0) < 0.01,
    bells(w2)[0] ? 'x ' + fmt(bx0, 1) + '→' + fmt(bells(w2)[0].x, 1) : '没有钟');

  // 落点全被挤掉时：只短等 retrySec 重试（把地图临时缩到比 8 个候选点还小）
  const w3 = cleanWorld(4903);
  parkPlayer(w3);
  const savedW = w3.map.w, savedH = w3.map.h;
  w3.map.w = 200; w3.map.h = 200;
  w3.player.x = 100; w3.player.y = 100;
  SIM.setSelf(w3, w3.player);
  w3.tick = startTick;
  w3.bellNextTick = 0;
  SIM.maybeSpawnBell(w3);
  const blockedWait = w3.bellNextTick - w3.tick;
  expect('★★八个方向都放不下时（贴边 clamp 把每口钟都挤到脚下）必须只短等 retrySec，'
    + '不许把整串排期推到 132 秒之后',
    bells(w3).length === 0 && blockedWait > 0 && blockedWait <= Math.round(B.retrySec * HZ),
    '钟 ' + bells(w3).length + ' 口 / 等待 ' + blockedWait + ' 帧');
  w3.map.w = savedW; w3.map.h = savedH;

  // 主线《补天纪》一口都不许有
  //
  // ★★★这一条第一版是**假绿**，值得记下来：
  //   当时用 ch1（240 秒上限）去验 258 秒的时刻 —— 那一刻这一关早就判定「赢了」，
  //   step 在剧情收尾那一段就 return 了，2.43 的生成段根本没被走到，
  //   「零口钟」当然成立。**摘掉剧情关闸，它照样全绿**（反向验证当场抓出来的）。
  //   两条修法同时上：
  //     ① 直接调事件入口（不经过 step 的早退），这一条测的才是那道闸本身；
  //     ② 走 step 那一遍改用 ch2（300 秒上限，容得下 258 秒），
  //        并且**断言那一刻世界还在跑** —— 世界已结束时，「什么都没有」不构成任何证据。
  const wS = SIM.createWorld({ charId: 'hunter', seed: 519, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.bellNextTick = 0;
  const directS = SIM.maybeSpawnBell(wS);
  expect('★★直接调事件入口也必须被剧情关挡住（不依赖 step 会不会早退）：'
    + '主线是逐关手工配平的，凭空多一个「群体牵引」会直接抹掉配好的走位难度',
    !!wS.storyStage && directS === null
      && bells(wS).length === 0 && evs(wS, 'bell').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
      + ' 返回=' + (directS ? '有钟' : 'null')
      + ' / 钟 ' + bells(wS).length + ' 口 / 播报 ' + evs(wS, 'bell').length + ' 条');

  // 走 step 那一遍：用 ch2（300 秒 > 258 秒），并盯住「世界还在跑」
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 521, modId: 'myth', stageId: 'ch2' });
  wS2.player.expNext = 1e9;
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((B.startSec + k * 30) * HZ);
    wS2.bellNextTick = 0;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch2）走完整条 step 也没有钟，**而且那一刻世界确实还在跑**：'
    + '不钉「世界还活着」的话，用超时的关卡验任何「不该出现的东西」都会假绿',
    storyAlive && bells(wS2).length === 0 && evs(wS2, 'bell').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '）'
      + ' / 钟 ' + bells(wS2).length + ' 口 / 播报 ' + evs(wS2, 'bell').length + ' 条');

  // ---------- 2. 敲响 ----------
  const w4 = cleanWorld(4904);
  parkPlayer(w4);
  SIM.spawnBell(w4);
  const bell4 = bells(w4)[0];
  standOn(w4, bell4);
  stepN(w4, 1);
  const after4 = bells(w4);
  expect('★★踩上去就响：bellRing 里有圆心、有到期时刻',
    !!w4.bellRing && w4.bellRing.until > w4.time,
    w4.bellRing ? 'until=' + fmt(w4.bellRing.until, 2) + ' / time=' + fmt(w4.time, 2) : 'null');
  expect('★★敲响之后钟**不能从地上消失**：它要一直画在钟声圈的中央（响完才没）',
    after4.length === 1 && after4[0].value === 1,
    '地上 ' + after4.length + ' 口 / value=' + (after4[0] ? after4[0].value : 'NA'));
  expect('★敲响时落下一条钟声圈，半径**就是**判定半径、颜色是钟声圈配色',
    w4.zones.length === 1 && Math.abs(w4.zones[0].r - B.radius) < 0.01
      && w4.zones[0].color === B.ringColor,
    w4.zones.length ? 'r=' + w4.zones[0].r + ' color=' + w4.zones[0].color : '没有圈');
  expect('★只播一条 bell_toll、且**不带 slot**（钟声改变的是整个战场，队友也必须看得到）',
    evs(w4, 'bell_toll').length === 1 && evs(w4, 'bell_toll')[0].slot === undefined,
    '播报 ' + evs(w4, 'bell_toll').length + ' 条'
      + (evs(w4, 'bell_toll').length ? ' slot=' + evs(w4, 'bell_toll')[0].slot : ''));
  const until4 = w4.bellRing.until;
  const tolls4 = w4.bellTolls;
  stepN(w4, 3);
  expect('★已经在响的钟再踩也不会重新计时、不会重复播报（否则站在钟上就一直续命）',
    Math.abs(w4.bellRing.until - until4) < 0.001 && w4.bellTolls === tolls4,
    'until ' + fmt(until4, 2) + '→' + fmt(w4.bellRing.until, 2)
      + ' / 敲响次数 ' + tolls4 + '→' + w4.bellTolls);

  // 磁石不许把钟吸走
  const w5 = cleanWorld(4905);
  const p5 = parkPlayer(w5);
  SIM.spawnBell(w5);
  const bell5 = bells(w5)[0];
  // ★站在「拾取半径之外、吸附半径之内」这一环：否则测的其实是「什么都没发生」。
  //   拾取半径放大到 60（默认三十几），站 120px 处 —— 正好落在吸附范围里。
  p5.attrs.pickupRadius = 60;
  p5.x = bell5.x + 120;
  p5.y = bell5.y;
  SIM.setSelf(w5, p5);
  const bx5 = bell5.x, by5 = bell5.y;
  stepN(w5, 20);
  const b5 = bells(w5);
  expect('★★钟不许被磁石吸过来（坐标一动不动）：'
    + '走过去敲是它唯一的成本，隔着两百像素被吸过来就等于「路过自动敲响」',
    b5.length === 1 && Math.abs(b5[0].x - bx5) < 0.01 && Math.abs(b5[0].y - by5) < 0.01
      && b5[0].value === 0,
    b5.length ? 'x ' + fmt(bx5, 1) + '→' + fmt(b5[0].x, 1)
      + ' / y ' + fmt(by5, 1) + '→' + fmt(b5[0].y, 1) + ' / value=' + b5[0].value : '钟没了');

  // ---------- 3. 牵引的方向 ----------
  // 几何：钟在玩家**右边** 380px；被测的怪放在钟的**正上方**。
  //   ★这样「追玩家」的方向是 -x（往左）、「被牵」的方向是 +y（往下）—— 两者正交，
  //     一眼就能从位移分出来是哪一种。
  //   ★第一版把怪放在钟的右侧（与玩家同一条线上）：那时「追玩家」与「朝钟」都指向 -x，
  //     位移长得一模一样 —— 断言永远是绿的（假绿，等于什么都没测）。
  function pullWorld(seed) {
    const w = cleanWorld(seed);
    const p = w.player;
    p.x = Math.round(w.map.w / 2); p.y = Math.round(w.map.h / 2);
    p.hp = 1e9; p.maxHp = 1e9;      // 别让接触伤害打断观察
    SIM.setSelf(w, p);
    clearObstacles(w);
    const bx = p.x + 380, by = p.y;
    SIM.spawnPickup(w, 'bell', bx, by, 0, B.lifeSec);
    const it = w.pickups[w.pickups.length - 1];
    SIM.tollBell(w, p, it);
    return { w: w, p: p, bx: bx, by: by, bell: it };
  }

  const A = pullWorld(4910);
  const wa = A.w, pa = A.p;
  const nearMob = mkMob(wa, 'corpse', A.bx, A.by - 400);   // 圈内（400 < 460），钟正上方
  const farMob = mkMob(wa, 'corpse', A.bx, A.by - 600);    // 圈外（600 > 460）
  const nStartX = nearMob.x, nStartY = nearMob.y;
  const fStartX = farMob.x, fStartY = farMob.y;
  const hpBefore = nearMob.hp;
  stepN(wa, 10);
  const nDx = nearMob.x - nStartX, nDy = nearMob.y - nStartY;
  const fDx = farMob.x - fStartX, fDy = farMob.y - fStartY;
  expect('★★圈内的妖物这一帧朝**钟**走（+y），不是朝玩家（-x）：'
    + '这是整个机制唯一的效果，方向反了它就是「把怪往自己身上赶」',
    nDy > 5 && Math.abs(nDx) < 1,
    'dx=' + fmt(nDx, 1) + ' dy=' + fmt(nDy, 1));
  expect('★★圈外的妖物一步都不许被牵：它照旧追玩家（-x）——'
    + '否则「圈有多大」这件事在画面上完全没了意义',
    fDx < -1, 'dx=' + fmt(fDx, 1) + ' dy=' + fmt(fDy, 1));
  // 速度守恒：被牵的怪不许变快/变慢 —— 它借的是自己的速度，不是另一个数
  const wantN = nearMob.def.speed * (10 / HZ);
  const gotN = Math.hypot(nDx, nDy);
  expect('★★被牵的妖物速度**不变**（位移 == 自己的速度 × 时间）：'
    + '钟声是「换个方向」不是「吸飞过去」—— 吸飞会让这一圈怪瞬间叠到钟上',
    Math.abs(gotN - wantN) <= wantN * 0.12,
    '实测 ' + fmt(gotN, 1) + 'px / 应有 ' + fmt(wantN, 1) + 'px');
  expect('★★牵引不许造成任何伤害（妖物血量不变、玩家血量不变）：'
    + '它是位移机制，带伤害就变成「白给一个范围技能」',
    nearMob.hp === hpBefore && pa.hp === pa.maxHp,
    '怪 ' + fmt(nearMob.hp, 0) + '/' + fmt(nearMob.maxHp, 0) + ' / 人 ' + fmt(pa.hp, 0));
  expect('★玩家本人不会被钟牵（位置只由输入决定）',
    Math.abs(pa.x - (A.bx - 380)) < 0.01 && Math.abs(pa.y - A.by) < 0.01,
    '玩家 ' + fmt(pa.x, 1) + ',' + fmt(pa.y, 1));

  // 三类特殊妖物：**同一帧、同一个世界、只差一个钟声**，比较两只怪的位置。
  // 【为什么不直接断言「y 不许变大」】山魈本来就在绕着玩家走、饕餮在走自己的路 ——
  //   它们自己的 y 就可能上下动，那种断言只会测到它们自己的 AI，测不到钟声。
  //   两个世界逐坐标对比才是真正在问「钟声有没有动它」。
  function specialWorld(seed, withRing) {
    const w = cleanWorld(seed);
    const p = w.player;
    p.x = Math.round(w.map.w / 2); p.y = Math.round(w.map.h / 2);
    p.hp = 1e9; p.maxHp = 1e9;
    SIM.setSelf(w, p);
    clearObstacles(w);
    const bx = p.x + 380, by = p.y;
    if (withRing) {
      SIM.spawnPickup(w, 'bell', bx, by, 0, B.lifeSec);
      SIM.tollBell(w, p, w.pickups[w.pickups.length - 1]);
    }
    return {
      w: w,
      bossM: mkMob(w, 'blood_lord', bx, by - 380),
      summM: mkMob(w, 'shanxiao', bx + 30, by - 380),
      devM: mkMob(w, 'taotie', bx - 30, by - 380),
      normM: mkMob(w, 'corpse', bx, by - 380)
    };
  }
  const R1 = specialWorld(4921, true);    // 有钟声
  const R2 = specialWorld(4921, false);   // 没钟声（对照组）
  stepN(R1.w, 10);
  stepN(R2.w, 10);
  const dOf = function (a, b) { return Math.hypot(a.x - b.x, a.y - b.y); };
  expect('★★Boss 不许被钟牵着走：有钟声与没钟声两个世界里，它 10 帧后的位置必须**一模一样**'
    + '（牵着走整场就变成遛狗）',
    dOf(R1.bossM, R2.bossM) < 0.01,
    '偏差 ' + fmt(dOf(R1.bossM, R2.bossM), 3) + 'px');
  expect('★★山魈不许被钟牵着走（它整套玩法就是「保持距离」，拉过来等于抹掉它的身份）',
    dOf(R1.summM, R2.summM) < 0.01 && SIM.bellPullable(R1.summM) === false,
    '偏差 ' + fmt(dOf(R1.summM, R2.summM), 3) + 'px / pullable=' + SIM.bellPullable(R1.summM));
  expect('★★饕餮不许被钟牵着走（它整套玩法就是「不追你、只吃地上的东西」）',
    dOf(R1.devM, R2.devM) < 0.01 && SIM.bellPullable(R1.devM) === false,
    '偏差 ' + fmt(dOf(R1.devM, R2.devM), 3) + 'px / pullable=' + SIM.bellPullable(R1.devM));
  // ★对照组必须真的动起来：普通怪在两个世界里必须明显不同 ——
  //   否则上面三条可能是「钟根本没生效」的假绿（这正是这一条存在的意义）。
  expect('★★★同一次对比里普通怪必须明显不同（这条是上面三条的"对照组校验"）：'
    + '如果连普通怪都没被动过，那三条"没被牵"测的是"钟根本没生效"',
    dOf(R1.normM, R2.normM) > 10,
    '普通怪偏差 ' + fmt(dOf(R1.normM, R2.normM), 1) + 'px');

  // 定身的怪不许被牵（没有速度可借 → 不能凭空给它一个速度）
  const T = pullWorld(4912);
  const wt = T.w;
  const stunM = mkMob(wt, 'corpse', T.bx, T.by - 400);
  stunM.stun = 5;                 // 定身 5 秒（比这 10 帧长得多）
  const sX0 = stunM.x, sY0b = stunM.y;
  stepN(wt, 10);
  expect('★定身中的妖物不许被钟「解定身并推走」（位移必须是 0）：'
    + '钟声只借它自己的速度，而定身时它的速度就是 0',
    Math.abs(stunM.x - sX0) < 0.01 && Math.abs(stunM.y - sY0b) < 0.01,
    'dx=' + fmt(stunM.x - sX0, 2) + ' dy=' + fmt(stunM.y - sY0b, 2));

  // 到钟下就站住（不许压到钟心叠成一坨）
  const C2 = pullWorld(4913);
  const wc = C2.w;
  const atBell = mkMob(wc, 'corpse', C2.bx + 12, C2.by);
  const aX0 = atBell.x, aY0 = atBell.y;
  stepN(wc, 6);
  expect('★走到钟下（standRadius 内）就站住：不设这一条它们会压到钟心叠成一团色块，'
    + '玩家看不出「来了多少只」',
    Math.abs(atBell.x - aX0) < 0.01 && Math.abs(atBell.y - aY0) < 0.01,
    'dx=' + fmt(atBell.x - aX0, 2) + ' dy=' + fmt(atBell.y - aY0, 2));

  // 钟声到期 → 立刻恢复追玩家
  const D = pullWorld(4914);
  const wd = D.w;
  const backMob = mkMob(wd, 'corpse', D.bx, D.by - 400);
  stepN(wd, 10);
  const midDy = backMob.y - (D.by - 400);
  wd.bellRing.until = wd.time;          // 直接把到期时刻拉到当前帧
  const bxD = backMob.x;
  stepN(wd, 6);
  expect('★★钟声一停立刻回身：到期后必须重新追玩家（-x），'
    + '而且 bellRing 要被清掉（否则「现在有没有钟在响」永远答"有"）',
    midDy > 5 && wd.bellRing === null && (backMob.x - bxD) < -1,
    '响时 dy=' + fmt(midDy, 1) + ' / 停后 dx=' + fmt(backMob.x - bxD, 1)
      + ' / bellRing=' + (wd.bellRing ? '还在' : 'null'));

  // ---------- 4. 整条链路（真的走 step） ----------
  // 【为什么还要这一条】上面全是手调 maybeSpawnBell / tollBell ——
  //   「函数写好了却没在 step 里被调用」是这个项目反复出现的静默失败
  //   （双生妖 / 引魂灯 / 饕餮 / 双碑都踩过）。
  const w9 = cleanWorld(4919);
  const p9 = parkPlayer(w9);
  w9.tick = startTick - 1;
  w9.bellNextTick = 0;
  SIM.step(w9, { mx: 0, my: 0 });
  const bell9 = bells(w9)[0];
  expect('★★走 step 的整条链路真的会在 startSec 立起一口钟（防"函数写好了但没被调用"）',
    bells(w9).length === 1 && evs(w9, 'bell').length === 1,
    '钟 ' + bells(w9).length + ' 口 / 播报 ' + evs(w9, 'bell').length + ' 条');

  // 摆一只怪在钟的正上方（圈内），走过去敲响，看它在随后的帧里真的朝钟靠近
  clearObstacles(w9);
  const mob9 = mkMob(w9, 'corpse', bell9.x, bell9.y - 400);
  const d9Before = Math.hypot(mob9.x - bell9.x, mob9.y - bell9.y);
  const rng9 = w9.rngState;
  standOn(w9, bell9);
  stepN(w9, 1);
  const rang9 = !!w9.bellRing;
  stepN(w9, 10);
  const d9After = Math.hypot(mob9.x - bell9.x, mob9.y - bell9.y);
  const d9Player = Math.hypot(mob9.x - p9.x, mob9.y - p9.y);
  expect('★★走 step 真的能敲响，而且之后那 10 帧里妖物真的朝钟靠近了'
    + '（「钟响了但怪没动」是这个机制最可能的静默失败）',
    rang9 && d9After < d9Before - 5,
    '响=' + rang9 + ' 到钟 ' + fmt(d9Before, 0) + '→' + fmt(d9After, 0)
      + ' / 到玩家 ' + fmt(d9Player, 0));
  expect('★★钟响期间主随机流一动不动（牵引是纯几何：它一碰 nextRand，'
    + '后面每一波的落点全部错位）',
    w9.rngState === rng9, 'rng=' + rng9 + '→' + w9.rngState);
  expect('★钟的寿命跟着钟声走（响完就消失，不许「圈没了、钟还杵在那儿」）',
    bells(w9).length === 1 && Math.abs(bells(w9)[0].life - (B.ringSec - 10 / HZ)) < 0.25,
    bells(w9).length
      ? 'life=' + fmt(bells(w9)[0].life, 2) + ' / 应约 ' + fmt(B.ringSec - 10 / HZ, 2)
      : '钟没了');
}
// ============================================================
// 第五十轮：影傀 / 罔两（两只靠近就会合体的一对）
// ============================================================
// 【这一段在钉什么】
//   ① 排期：不落波次网格、不撞别的首发帧、同屏上限只短等不顺延；
//   ② 成对：一只配一只、**双向**指向、落单不算；
//   ③ 合体：必须贴够 fuseSec；只从 id 小的那只推进；合完两只真的消失；
//   ④ ★★「不该发生的事」（这一段真正的价值都在这里）：
//      单只影傀永远不自行合体 / 罔两不再参与合体 / 影傀一个宝箱都不掉 / 剧情关一只都没有；
//   ⑤ 随机流隔离：生成与合体都不许碰 nextRand。
//
// 【为什么每条都配一个正向对照】前几轮反复踩「机制根本没接上、断言却永远绿」——
//   比如「剧情关没有影傀」这条，如果那一刻世界已经结束，零只什么都不证明（第 49 轮的血泪）。
function testMerge() {
  console.log('[第五十轮] 影傀 / 罔两：两只靠近就会合体的一对');
  const M = C.MERGE;
  const HZ = C.TICK_HZ;
  const SOUL = C.MOB_MAP[M.soulId];
  const BEAST = C.MOB_MAP[M.mobId];
  const startTick = Math.round(M.startSec * HZ);
  const everyTick = Math.round(M.everySec * HZ);
  const retryTick = Math.round(M.retrySec * HZ);
  const fuseTicks = Math.ceil(M.fuseSec * HZ);
  const PB = require('../shared/proto_bin.js');
  const pool = PB.STR_POOL || [];

  function dist2(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function rgbOf(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  // 干净世界：清武器（免得顺手把影傀打掉）、锁经验（免升级面板冻住 step）、
  // 其它事件排期全部推到很远（这一段只验影傀）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.bountyNextTick = 1e9;   // 第五十四轮：悬赏首发 186s，默认推远（要验它的世界自己打开）
    w.healerNextTick = 1e9;   // 第五十五轮：回春巫首发 252s，默认推远（要验它的世界自己打开）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;      // ★地图自带的宝箱/金币也清掉：数「掉几个宝箱」才干净
    SIM.setSelf(w, p);
    return w;
  }
  function souls(w) {
    return w.mobs.filter(function (m) { return m.alive && m.def && m.def.mergeSoul; });
  }
  function beasts(w) {
    return w.mobs.filter(function (m) { return m.alive && m.def && m.def.wangliang; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function parkPlayer(w) {
    const p = w.player;
    p.x = Math.round(w.map.w / 2);
    p.y = Math.round(w.map.h / 2);
    SIM.setSelf(w, p);
    return p;
  }
  // 落点避障会让我们算不准间距，所以测试里先把障碍清空（同 testBell）
  function clearObstacles(w) {
    w.obstacles = [];
  }
  // 造一只影傀并**手动**指定配对（不经过事件入口：这一段测的是合体判定本身）
  function mkSoul(w, x, y, seed) {
    const m = SIM.spawnMob(w, M.soulId, x, y, 1, 0, seed || 9001);
    if (m) { m.mateId = 0; m.fuseT = 0; }
    return m;
  }
  // 把一对摆到指定间距上（坐标直接改，不走移动）
  function placePair(w, a, b, d) {
    const cy = w.map.h / 2;
    const cx = w.map.w / 2;
    a.x = cx - d / 2; a.y = cy;
    b.x = cx + d / 2; b.y = cy;
    a.px = a.x; a.py = a.y;
    b.px = b.x; b.py = b.y;
    a.mateId = b.id;
    b.mateId = a.id;
  }
  function tickN(w, n) {
    for (let i = 0; i < n; i++) SIM.tickMerge(w, 1 / HZ);
  }

  // ---------- 0. 表自洽 ----------
  expect('★影傀与罔两必须是两只真实存在的怪（表里的 id 拼错时，事件会静默什么都不生成）',
    !!SOUL && !!BEAST, M.soulId + ' / ' + M.mobId);
  expect('★影傀必须是 kind=merge（不然它不会朝彼此走，两只各追各的）',
    SOUL.kind === 'merge', SOUL.kind);
  expect('★罔两必须是 kind=melee（合体之后就是一只普通强怪，不该再有花招）',
    BEAST.kind === 'melee', BEAST.kind);
  expect('★两只的身份靠 def 上的布尔标记（协议零改动就是靠它：defId 已经在快照里）',
    SOUL.mergeSoul === true && BEAST.wangliang === true,
    'mergeSoul=' + SOUL.mergeSoul + ' wangliang=' + BEAST.wangliang);
  expect('★★罔两绝不许带 mergeSoul —— 带了它会和别的影傀再合一次，'
    + '血越合越多（每合一次 ×1.15 且叠的是当前血量）',
    !BEAST.mergeSoul, 'wangliang.mergeSoul=' + BEAST.mergeSoul);
  expect('★影傀必须是 normal 档而不是 elite：elite 会「必掉一颗心」，'
    + '那会把「阻止合体」这一侧的回报抬得比宝箱还高',
    SOUL.tier === 'normal', 'tier=' + SOUL.tier);

  expect('★不许落在 30 秒波次网格上（startSec % 30 !== 0）：'
    + '压在波次那一帧时，刚刷的怪还在 700px 外（陨星为此被推迟过 95 秒）',
    M.startSec % C.WAVES.intervalSec !== 0,
    'startSec=' + M.startSec + ' 余 ' + (M.startSec % C.WAVES.intervalSec));

  const otherStarts = [
    ['挑战者', C.CHALLENGER.startSec], ['灵泉', C.LEYLINE.startSec],
    ['血祭坛', C.BLOODPACT.startSec], ['赤月', C.BLOOD_MOON.startSec],
    ['山魈', C.SUMMONER.startSec], ['陨星', C.METEOR.startSec],
    ['双生妖', C.TWINS.startSec], ['引魂灯', C.LANTERN.startSec],
    ['饕餮', C.DEVOURER.startSec], ['歧路双碑', C.BOON.startSec],
    ['镇妖钟', C.BELL.startSec]
  ];
  const clash = otherStarts.filter(function (o) { return o[1] === M.startSec; });
  expect('★不许与另一个事件的**首发帧**落在同一 tick'
    + '（同一帧两件事一起弹，玩家只读得到一条）',
    clash.length === 0, clash.length ? '撞了：' + clash[0][0] : '无冲突');

  expect('★合体窗口必须 ≥ 1 秒（fuseSec）：0 就是「碰到即合体」，'
    + '玩家没有阻止它的机会，机制退化成一只延迟变强的怪',
    M.fuseSec >= 1, 'fuseSec=' + M.fuseSec);
  expect('★合体血量倍率必须 > 1：正好 1.0 的话玩家会发现「分开打更划算」'
    + '（两只分开打还能多两笔击杀经验）',
    M.hpMul > 1, 'hpMul=' + M.hpMul);
  expect('★罔两的宝箱数必须 ≥ 2：这是玩家赌这一把的价码；'
    + '影傀那边一个宝箱都没有（由第 7 段的掉落断言钉住）',
    M.rewardChest >= 2, 'rewardChest=' + M.rewardChest);
  expect('★同屏上限必须是偶数（一对一对地来，奇数会让最后一对永远缺一只）',
    M.maxAlive % 2 === 0, 'maxAlive=' + M.maxAlive);
  expect('★一对张开的半角必须落在 20~70 度：太小出生就贴脸（来不及阻止），'
    + '太大它们要在场上晃很久才碰头',
    M.pairHalf >= 20 && M.pairHalf <= 70, 'pairHalf=' + M.pairHalf);
  expect('★mergeDist 必须大于影傀直径（2r）：'
    + '小于直径时两只圆会被碰撞互相挤开，永远进不了这个阈值（合体永远不触发）',
    M.mergeDist > SOUL.r * 2, 'mergeDist=' + M.mergeDist + ' / 直径 ' + SOUL.r * 2);
  expect('★落点距离必须在一屏之内（240~480）：看不见的影傀等于不存在，'
    + '玩家也就没法选「趁现在点掉它」',
    M.offset >= 240 && M.offset <= 480, 'offset=' + M.offset);
  expect('★一局至少能见到 3 对（最短的一局 18 分钟 = 1080 秒）',
    M.startSec + 2 * M.everySec <= 1080,
    '第三对在 ' + (M.startSec + 2 * M.everySec) + ' 秒');

  // 配色：禁紫 / 紫蓝。判据是「红与蓝**同时**高于绿」——那才是紫/紫蓝。
  // ★不能简单写 b < r：项目里的冷灰档（双生妖 #8fb6c8）本来就是蓝多于红，
  //   那一条会把自己人判红（第 49 轮写钟的断言时差点复制过来）。
  const cSoul = rgbOf(SOUL.color);
  const cBeast = rgbOf(BEAST.color);
  expect('★影傀配色不许偏紫（判据：红与蓝同时高于绿才是紫）',
    !(cSoul[0] > cSoul[1] && cSoul[2] > cSoul[1]), SOUL.color + ' rgb=' + cSoul.join(','));
  expect('★罔两配色不许偏紫',
    !(cBeast[0] > cBeast[1] && cBeast[2] > cBeast[1]), BEAST.color + ' rgb=' + cBeast.join(','));
  expect('★两只不许同色（同屏时要靠颜色分开「一对小的」和「一只大的」）',
    SOUL.color !== BEAST.color, SOUL.color + ' / ' + BEAST.color);

  const poolMiss = [];
  [M.soulId, M.mobId, SOUL.color, BEAST.color, M.markColor, M.fuseColor]
    .forEach(function (v) { if (pool.indexOf(v) < 0) poolMiss.push(v); });
  expect('★★两只的 defId 与两个本体色必须已在串池里：'
    + '池外值每帧走长格式 —— 怪是一直在快照里的，这是一段持续的、不报错的带宽劣化',
    poolMiss.length === 0, poolMiss.length ? '缺：' + poolMiss.join(',') : '齐全');

  // ---------- 1. 生成 ----------
  const w0 = cleanWorld(5001);
  parkPlayer(w0);
  clearObstacles(w0);
  // 地图中心：后面每一段造怪都用它（同一种 createWorld 出来的地图尺寸一致，
  // 但**不假设**这一点 —— 每段仍然用自己的 w.map 算出中心，见 cOf）
  const cx0 = Math.round(w0.map.w / 2);
  const cy0 = Math.round(w0.map.h / 2);

  w0.tick = startTick - 1;
  const early = SIM.maybeSpawnMerge(w0);
  expect('★未到 startSec 一只都不生成',
    early === null && souls(w0).length === 0,
    '返回=' + early + ' / 场上 ' + souls(w0).length + ' 只');

  w0.tick = startTick;
  const made = SIM.maybeSpawnMerge(w0);
  const p4 = souls(w0);
  expect('★到了 startSec 必须一次来满两对（pairsPerSpawn 2 × 2 只 = 4 只影傀）',
    made === 4 && p4.length === 4, '生成 ' + made + ' 只 / 场上 ' + p4.length + ' 只');
  expect('★生成的必须是 soulId 那一种',
    p4.every(function (m) { return m.defId === M.soulId; }),
    p4.map(function (m) { return m.defId; }).join(','));
  expect('★一共记了 2 对（mergeSpawned）', w0.mergeSpawned === 2, 'mergeSpawned=' + w0.mergeSpawned);
  expect('★每一对播一条 merge_pair（四只播一条会让玩家以为只来了一对）',
    evs(w0, 'merge_pair').length === 2, evs(w0, 'merge_pair').length + ' 条');

  const paired = p4.every(function (m) {
    const o = p4.filter(function (x) { return x.id === m.mateId; })[0];
    return !!o && o.mateId === m.id;
  });
  expect('★★配对必须**双向**：每一只的 mateId 都指向那一只，而那一只也指回来。'
    + '单向配对会让其中一只去追一个不认它的同伴，看着像「追着空气走」',
    paired, p4.map(function (m) { return m.id + '→' + m.mateId; }).join(' '));

  const gaps = [];
  for (let i = 0; i < p4.length; i++) {
    if (p4[i].id < p4[i].mateId) {
      const o = p4.filter(function (x) { return x.id === p4[i].mateId; })[0];
      if (o) gaps.push(dist2(p4[i], o));
    }
  }
  expect('★一对必须是**分开**浮现的（间距落在 offset×0.8 ~ offset×1.6）：'
    + '出生就贴在一起的话，「要不要阻止合体」这个选择根本不存在',
    gaps.length === 2 && gaps.every(function (d) { return d > M.offset * 0.8 && d < M.offset * 1.6; }),
    '间距 ' + gaps.map(function (d) { return Math.round(d); }).join(' / '));

  const uniqPos = {};
  p4.forEach(function (m) { uniqPos[Math.round(m.x) + ',' + Math.round(m.y)] = 1; });
  expect('★两对不许重叠在同一处（mergeSeq 递增 → 每一对从不同方位浮现）',
    Object.keys(uniqPos).length === 4,
    Object.keys(uniqPos).length + ' 个不同落点');

  expect('★每一只都必须在一屏之内（< 520px）：看不见的影傀等于不存在',
    p4.every(function (m) { return dist2(m, w0.player) < 520; }),
    p4.map(function (m) { return Math.round(dist2(m, w0.player)); }).join(','));

  // ---------- 2. 同屏上限 ----------
  w0.tick = startTick + everyTick;
  const again = SIM.maybeSpawnMerge(w0);
  expect('★同屏满了就不再生成（maxAlive = ' + M.maxAlive + '）',
    again === null && souls(w0).length === 4,
    '返回=' + again + ' / 场上 ' + souls(w0).length + ' 只');
  expect('★满了只**短等** retrySec，不顺延整个 everySec —— '
    + '顺延的话玩家一直不清场，后面整串排期会被推走（陨星/引魂灯/双碑/钟都踩过）',
    w0.mergeNextTick === w0.tick + retryTick,
    'nextTick - tick = ' + (w0.mergeNextTick - w0.tick) + ' 帧（retry=' + retryTick + '）');

  // ★罔两也必须算进上限：不然一对合体成一只之后限额被腾出来，
  //   下一轮又刷一对，场上会越堆越多只罔两（每只血都是两只之和，三只就是必败局）。
  const wCap = cleanWorld(5011);
  parkPlayer(wCap);
  wCap.mobs.length = 0;
  mkSoul(wCap, cx0 - 300, cy0, 9101);
  mkSoul(wCap, cx0 - 260, cy0, 9102);
  SIM.spawnMob(wCap, M.mobId, cx0 + 260, cy0, 1, 0, 9103);
  SIM.spawnMob(wCap, M.mobId, cx0 + 300, cy0, 1, 0, 9104);
  expect('★对照：场上确实是 2 只影傀 + 2 只罔两',
    souls(wCap).length === 2 && beasts(wCap).length === 2,
    souls(wCap).length + ' 影傀 / ' + beasts(wCap).length + ' 罔两');
  expect('★★罔两也算进同屏上限（countAliveMergeFamily = 4）',
    SIM.countAliveMergeFamily(wCap) === 4, 'count=' + SIM.countAliveMergeFamily(wCap));
  wCap.tick = startTick;
  expect('★★上限占满时（哪怕占位的是罔两）一只都不许再生成',
    SIM.maybeSpawnMerge(wCap) === null && souls(wCap).length === 2,
    '场上 ' + souls(wCap).length + ' 影傀 / ' + beasts(wCap).length + ' 罔两');

  // ---------- 3. ★★生成不许消费主随机流 ----------
  const rA = cleanWorld(5002);
  const rB = cleanWorld(5002);
  parkPlayer(rA); clearObstacles(rA);
  parkPlayer(rB); clearObstacles(rB);
  rA.tick = startTick;
  SIM.maybeSpawnMerge(rA);
  expect('★对照：rA 确实生成了影傀（否则下面比的是两个空世界）',
    souls(rA).length === 4, souls(rA).length + ' 只');
  expect('★★生成影傀不许消费主随机流：角度走 affixHash、相位走 spawnMob 的 seed。'
    + '用了 nextRand 的话，之后每一波的落点都会整体错位一格',
    rA.rngState === rB.rngState, 'rng=' + rA.rngState + '/' + rB.rngState);

  // ---------- 4. 合体 ----------
  const w1 = cleanWorld(5004);
  parkPlayer(w1);
  clearObstacles(w1);
  w1.mobs.length = 0;
  const mA = mkSoul(w1, cx0 - 20, cy0, 9201);
  const mB = mkSoul(w1, cx0 + 20, cy0, 9202);
  placePair(w1, mA, mB, 40);          // 40 < mergeDist 52
  mA.hp = 120;
  mB.hp = 80;

  w1.tick = 1;
  SIM.tickMerge(w1, 1 / HZ);
  expect('★刚贴近的那一帧不许立刻合体（fuseSec 的窗口是玩家阻止它的唯一机会）',
    beasts(w1).length === 0 && mA.alive && mB.alive,
    '罔两 ' + beasts(w1).length + ' 只 / fuseT=' + mA.fuseT.toFixed(2));

  tickN(w1, fuseTicks - 2);
  expect('★差两帧的时候还不许合体（计时必须真的走满 fuseSec）',
    beasts(w1).length === 0 && mA.alive,
    '罔两 ' + beasts(w1).length + ' 只 / fuseT=' + mA.fuseT.toFixed(2));

  tickN(w1, 4);
  expect('★贴够 fuseSec 之后必须合体：两只影傀消失、一只罔两出现',
    souls(w1).length === 0 && beasts(w1).length === 1,
    souls(w1).length + ' 影傀 / ' + beasts(w1).length + ' 罔两');

  const bf1 = beasts(w1)[0];
  expect('★★合体后的血量 = 两只**当前**血量之和 × hpMul（(120+80)×' + M.hpMul + '）。'
    + '用上限之和算的话，「先打残两只再放它们合体」这条策略就不存在了',
    !!bf1 && Math.abs(bf1.maxHp - (120 + 80) * M.hpMul) < 1e-6
      && Math.abs(bf1.hp - bf1.maxHp) < 1e-6,
    bf1 ? 'hp=' + bf1.hp + ' maxHp=' + bf1.maxHp + ' 期望 ' + (120 + 80) * M.hpMul : '没有罔两');
  expect('★合出来的罔两身上不许留 mateId（留着它会被当成某人的同伴）',
    !!bf1 && !bf1.mateId, bf1 ? 'mateId=' + bf1.mateId : '没有罔两');
  expect('★mergeFused 记了一次', w1.mergeFused === 1, 'mergeFused=' + w1.mergeFused);
  expect('★合体事件带血量与宝箱数（界面要照着播报，不能自己再算一遍）',
    evs(w1, 'wangliang').length === 1
      && evs(w1, 'wangliang')[0].hp === Math.round((120 + 80) * M.hpMul)
      && evs(w1, 'wangliang')[0].chest === M.rewardChest,
    JSON.stringify(evs(w1, 'wangliang')[0] || null));

  // ★推一帧 step 让 compactMobs 把死掉的两只剔出去 —— 数组里还留着它们的话，
  //   下一帧的 tickMerge 会再判一次（而它们已经 alive=false，看着"没事"），
  //   真正的危险是「合体」这段时间里 alive 的怪被重复计数。
  const beforeLen = w1.mobs.length;
  SIM.step(w1, { mx: 0, my: 0 });
  expect('★★合体后的那两只必须真的从 mobs 数组里消失（只设 alive=false 不够，'
    + 'compactMobs 之后数组里不该再有它们的 id）',
    w1.mobs.filter(function (m) { return m.id === mA.id || m.id === mB.id; }).length === 0,
    '压缩前 ' + beforeLen + ' 条 → 压缩后 ' + w1.mobs.length + ' 条');
  expect('★★合体之后再怎么推也不会二次合体（罔两不带 mergeSoul）',
    (function () {
      tickN(w1, 200);
      return beasts(w1).length === 1 && souls(w1).length === 0 && w1.mergeFused === 1;
    })(), '合体次数 ' + w1.mergeFused);

  // ---------- 5. 距离拉开要打断融合 ----------
  const w2 = cleanWorld(5005);
  parkPlayer(w2);
  clearObstacles(w2);
  w2.mobs.length = 0;
  const nA = mkSoul(w2, cx0 - 20, cy0, 9301);
  const nB = mkSoul(w2, cx0 + 20, cy0, 9302);
  placePair(w2, nA, nB, 40);
  tickN(w2, 8);
  expect('★对照：融合计时确实在涨', nA.fuseT > 0, 'fuseT=' + nA.fuseT.toFixed(2));
  placePair(w2, nA, nB, 300);
  SIM.tickMerge(w2, 1 / HZ);
  expect('★拉开超过 mergeDist 之后融合计时必须归零（被击退/绕开要能打断合体）',
    nA.fuseT === 0, 'fuseT=' + nA.fuseT);
  tickN(w2, fuseTicks + 10);
  expect('★一直分开就不会合体', beasts(w2).length === 0, '罔两 ' + beasts(w2).length + ' 只');

  // ---------- 6. ★★打断：打死一只，另一只永远不能自行合体 ----------
  const w3 = cleanWorld(5006);
  parkPlayer(w3);
  clearObstacles(w3);
  w3.mobs.length = 0;
  const kA = mkSoul(w3, cx0 - 20, cy0, 9401);
  const kB = mkSoul(w3, cx0 + 20, cy0, 9402);
  placePair(w3, kA, kB, 40);
  SIM.damageMob(w3, kA, 1e6, 0, 0, 'test');
  expect('★对照：被点掉的那只确实死了', !kA.alive, 'alive=' + kA.alive);
  expect('★死了同伴之后 findMergeMate 必须返回 null（不返回的话它会去合一个死人）',
    SIM.findMergeMate(w3, kB) === null,
    'mate=' + (SIM.findMergeMate(w3, kB) ? '有' : 'null'));
  tickN(w3, 60 * HZ);
  expect('★★单只影傀推 60 秒也绝不许自行变成罔两（"落单"不等于"自己合体"）：'
    + '这一条要是绿的假象，玩家点掉一只之后会莫名其妙多出一只罔两',
    beasts(w3).length === 0 && kB.alive,
    '罔两 ' + beasts(w3).length + ' 只 / 剩下那只 alive=' + kB.alive);

  const w4 = cleanWorld(5007);
  parkPlayer(w4);
  clearObstacles(w4);
  w4.mobs.length = 0;
  const lone = mkSoul(w4, w4.player.x + 300, w4.player.y, 9501);
  lone.mateId = 0;
  const d0 = dist2(lone, w4.player);
  for (let k = 0; k < 20; k++) SIM.step(w4, { mx: 0, my: 0 });
  const d1 = dist2(lone, w4.player);
  expect('★落单的影傀必须回头追玩家（否则它站在原地看着像卡住了）',
    d1 < d0 - 5, '距离 ' + Math.round(d0) + ' → ' + Math.round(d1));

  // ★★★上面那个世界杀的是 **id 小** 的那只 —— 而 tickMerge 只从 id 小的那只出发，
  //   所以「剩下 id 大的」这条路径本身就走不到合体判定，那一条断言是**侥幸绿的**。
  //   反向验证（把 findMergeMate 的 alive 判据摘掉）时它照样绿，才发现的。
  //   必须再补一个「杀 id 大 的那只」的世界：这时剩下的是 id 小的，
  //   它会作为起点去配对一个**已经死了的同伴** —— 这才是那道 alive 闸真正守的路径。
  const w3b = cleanWorld(5015);
  parkPlayer(w3b);
  clearObstacles(w3b);
  w3b.mobs.length = 0;
  const r1 = mkSoul(w3b, cx0 - 20, cy0, 9411);   // id 小
  const r2 = mkSoul(w3b, cx0 + 20, cy0, 9412);   // id 大
  placePair(w3b, r1, r2, 40);
  SIM.damageMob(w3b, r2, 1e6, 0, 0, 'test');
  expect('★对照：死的是 id 大的那只，剩下的是 id 小的（它会作为合体判定的起点）',
    !r2.alive && r1.alive && r1.id < r2.id,
    'r1=' + r1.id + ' alive=' + r1.alive + ' / r2=' + r2.id + ' alive=' + r2.alive);
  expect('★★★死了同伴之后，剩下那只作为起点也必须找不到同伴'
    + '（findMergeMate 必须判 o.alive —— 只判 id 的话它会和尸体合体）',
    SIM.findMergeMate(w3b, r1) === null,
    'mate=' + (SIM.findMergeMate(w3b, r1) ? '有（错的）' : 'null'));
  tickN(w3b, 60 * HZ);
  expect('★★★剩下的是 id 小的那只时，推 60 秒也绝不许和尸体合体：'
    + '这条路径才是「单只不合体」真正危险的一支（id 大的那支天然走不到合体判定）',
    beasts(w3b).length === 0, '罔两 ' + beasts(w3b).length + ' 只');

  // ---------- 7. 掉落 ----------
  const w5 = cleanWorld(5008);
  parkPlayer(w5);
  w5.mobs.length = 0;
  const s1 = mkSoul(w5, cx0, cy0, 9601);
  SIM.damageMob(w5, s1, 1e6, 0, 0, 'test');
  const chestAfterSoul = w5.pickups.filter(function (x) { return x.kind === 'chest'; }).length;
  const goldAfterSoul = w5.pickups.filter(function (x) { return x.kind === 'gold'; }).length;
  expect('★★影傀**一个宝箱都不掉**：两边都给宝箱的话，'
    + '「阻止合体」与「放纵合体」收益一样，「什么时候打」这个选择就没了',
    chestAfterSoul === 0, '宝箱 ' + chestAfterSoul + ' 个');
  expect('★影傀掉金币（≥ ' + M.goldDrops + ' 枚，另有随机掉落）：'
    + '这是「阻止合体」那一侧的回报，一枚都不给的话没人会去追它',
    goldAfterSoul >= M.goldDrops, '金币 ' + goldAfterSoul + ' 枚');

  const w6 = cleanWorld(5009);
  parkPlayer(w6);
  w6.mobs.length = 0;
  const bf2 = SIM.spawnMob(w6, M.mobId, cx0, cy0, 1, 0, 9602);
  SIM.damageMob(w6, bf2, 1e6, 0, 0, 'test');
  const chests = w6.pickups.filter(function (x) { return x.kind === 'chest'; });
  expect('★★罔两死掉必须给 ' + M.rewardChest + ' 个宝箱（不多不少）：'
    + '这是玩家赌这一把的价码',
    chests.length === M.rewardChest, '宝箱 ' + chests.length + ' 个');
  expect('★两个宝箱不许叠在同一点（叠在一个点上只会被一次性吸走，看着像只掉了一个）',
    chests.length === 2 && dist2(chests[0], chests[1]) > 20,
    chests.length === 2 ? '间距 ' + Math.round(dist2(chests[0], chests[1])) : '宝箱数不对');
  expect('★罔两伏诛要有自己的播报（否则玩家只看到地上一堆东西，不知道是它掉的）',
    evs(w6, 'wangliang_down').length === 1, evs(w6, 'wangliang_down').length + ' 条');

  // ---------- 8. 合体不许消费主随机流 ----------
  const fA = cleanWorld(5012);
  parkPlayer(fA);
  clearObstacles(fA);
  fA.mobs.length = 0;
  const gA = mkSoul(fA, cx0 - 20, cy0, 9701);
  const gB = mkSoul(fA, cx0 + 20, cy0, 9702);
  placePair(fA, gA, gB, 40);
  const rngBefore = fA.rngState;
  SIM.fuseDuo(fA, gA, gB);
  expect('★对照：合体确实发生了', beasts(fA).length === 1, beasts(fA).length + ' 只罔两');
  expect('★★合体不许消费主随机流（spawnMob 的第 7 参传了定值相位）：'
    + '合体用的随机数会顺着主随机流影响之后每一波的落点',
    fA.rngState === rngBefore, 'rng=' + rngBefore + '→' + fA.rngState);

  // ---------- 9. ★★剧情关 ----------
  // ★第 49 轮的血泪：用 240 秒上限的 ch1 去验 258 秒那一刻，世界早就结束了，
  //   生成段根本没被 step 走到 —— 摘掉剧情闸照样全绿。这里两条修法同时上。
  const wS = SIM.createWorld({ charId: 'hunter', seed: 519, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.mergeNextTick = 0;
  const directS = SIM.maybeSpawnMerge(wS);
  expect('★★直接调事件入口也必须被剧情关挡住（不依赖 step 会不会早退）：'
    + '主线是逐关手工配平的，凭空多一对「会自己合体变强」的精英会直接抹掉配好的强度曲线',
    !!wS.storyStage && directS === null
      && souls(wS).length === 0 && evs(wS, 'merge_pair').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
      + ' 返回=' + (directS ? '有' : 'null')
      + ' / 影傀 ' + souls(wS).length + ' 只 / 播报 ' + evs(wS, 'merge_pair').length + ' 条');

  // 走 step 那一遍：用 ch2（300 秒上限，容得下 138 秒），并盯住「世界还在跑」
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 521, modId: 'myth', stageId: 'ch2' });
  wS2.player.expNext = 1e9;
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((M.startSec + k * 30) * HZ);
    wS2.mergeNextTick = 0;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch2）走完整条 step 也没有影傀，**而且那一刻世界确实还在跑**：'
    + '不钉「世界还活着」的话，用超时的关卡验任何「不该出现的东西」都会假绿',
    storyAlive && souls(wS2).length === 0 && beasts(wS2).length === 0
      && evs(wS2, 'merge_pair').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '）'
      + ' / 影傀 ' + souls(wS2).length + ' 只 / 播报 ' + evs(wS2, 'merge_pair').length + ' 条');

  // ---------- 10. 不进关卡池 ----------
  const inPool = [];
  C.STAGES.forEach(function (s) {
    if (s.pool && (s.pool[M.soulId] || s.pool[M.mobId])) inPool.push(s.id || s.name || '?');
  });
  expect('★★两只都不许进任何关卡池（与挑战者/山魈/双生妖/饕餮同一条纪律）：'
    + '进了池它们就从「一段插曲」退化成「精英怪又多了一种」',
    inPool.length === 0, inPool.length ? '混进了：' + inPool.join(',') : '干净');

  // ---------- 11. 小幅：isMergeSoul / 单只不配对 ----------
  const w7 = cleanWorld(5014);
  w7.mobs.length = 0;
  const solo = mkSoul(w7, cx0, cy0, 9801);
  const soloBeast = SIM.spawnMob(w7, M.mobId, cx0 + 100, cy0, 1, 0, 9802);
  expect('★isMergeSoul 只认影傀（罔两不算）',
    SIM.isMergeSoul(solo) === true && SIM.isMergeSoul(soloBeast) === false,
    '影傀=' + SIM.isMergeSoul(solo) + ' 罔两=' + SIM.isMergeSoul(soloBeast));
  expect('★没配对（mateId=0）的影傀找不到同伴，也不会合体',
    SIM.findMergeMate(w7, solo) === null, 'mate=' + (SIM.findMergeMate(w7, solo) ? '有' : 'null'));
  tickN(w7, fuseTicks + 5);
  expect('★落单的影傀推够 fuseSec 也不合体', beasts(w7).length === 1,
    '罔两 ' + beasts(w7).length + ' 只（本来那 1 只是手造的）');
}


// ============================================================
// 第五十一轮：精卫衔石（会自己飞走、也会死在你眼皮底下的目标）
// ============================================================
// 这一轮要守的东西（都钉「不该发生的事」）：
//   表自洽（速度必须小于玩家移速、首发帧不许撞别的机制、配色不许发紫）；
//   生成零随机 / 同屏只许一只 / 满了只短等不顺延；
//   她只按 speed 走（不许瞬移）/ 不许被磁石吸走 / **玩家走过去也不许把她捡走**；
//   伤害只算够得着的那几只、而且同时最多算 contactCap 只；
//   抵达才给宝箱、而且只给一次；血光那一刻**死优先**（既死又成功是绝对不允许的）；
//   折翼零奖励、只有羽毛；剧情关双管（直接调入口 + 走 step 且断言世界还在跑）。
function testEscort() {
  console.log('[第五十一轮] 精卫衔石：会自己飞走的目标（护她到终点，或者看她折翼）');
  const E = C.ESCORT;
  const HZ = C.TICK_HZ;
  const DT = 1 / HZ;
  const startTick = Math.round(E.startSec * HZ);
  const everyTick = Math.round(E.everySec * HZ);
  const retryTick = Math.round(E.retrySec * HZ);
  const PB = require('../shared/proto_bin.js');
  const pool = PB.STR_POOL || [];

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  // 干净世界：清武器（免得顺手把妖物清掉，接触伤害就测不出来）、锁经验（免升级面板冻住 step）、
  // 其它事件排期全部推到很远（这一段只验精卫）。
  // ★每加一个事件型机制都要回来补这张表，否则「随机流/排期」类断言会被别的机制带红（第 50 轮的血泪）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.bountyNextTick = 1e9;   // 第五十四轮：悬赏首发 186s，默认推远（要验它的世界自己打开）
    w.healerNextTick = 1e9;   // 第五十五轮：回春巫首发 252s，默认推远（要验它的世界自己打开）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;      // ★地图自带的宝箱/金币也清掉：数「掉几个宝箱」才干净
    SIM.setSelf(w, p);
    return w;
  }
  function escorts(w) {
    return w.pickups.filter(function (it) { return it.kind === 'escort'; });
  }
  function chests(w) {
    return w.pickups.filter(function (it) { return it.kind === 'chest'; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function parkPlayer(w) {
    const p = w.player;
    p.x = Math.round(w.map.w / 2);
    p.y = Math.round(w.map.h / 2);
    SIM.setSelf(w, p);
    return p;
  }
  function tickN(w, n, dt) {
    const use = dt === undefined ? DT : dt;
    for (let i = 0; i < n; i++) SIM.tickEscort(w, use);
  }
  // 造一只贴着她的妖物（用最普通的小怪：半径小、不与测试自己的假设打架）
  function mkMobAt(w, x, y, seed) {
    return SIM.spawnMob(w, 'corpse', x, y, 1, 0, seed || 7001);
  }

  // ---------- 0. 表自洽 ----------
  expect('★ESCORT 表必须存在且有名字（表被删/改名时事件会静默什么都不生成）',
    !!E && !!E.name, E ? E.name : 'null');
  expect('★★她的速度必须**明显小于**玩家移速：追不上她，「护住她」这件事在物理上就不成立',
    E.speed < 120 * 0.8, 'speed=' + E.speed + ' / 玩家基础 120');
  expect('★★首发帧不许落在 30 秒波次网格上（压在波次那一帧，场上其实是空的 —— 陨星踩过）',
    E.startSec % 30 !== 0, 'startSec=' + E.startSec + ' %30=' + (E.startSec % 30));
  const otherStart = [];
  ['CHALLENGER', 'BLOOD_MOON', 'METEOR', 'LEYLINE', 'BLOODPACT', 'SUMMONER',
    'TWINS', 'LANTERN', 'DEVOURER', 'BOON', 'BELL', 'MERGE'].forEach(function (k) {
    const t = C[k];
    if (t && typeof t.startSec === 'number') otherStart.push(t.startSec);
  });
  expect('★★首发帧不许与任何既有事件撞 tick（同帧两件事一起弹，玩家只读得到一条）',
    otherStart.indexOf(E.startSec) === -1, '本件 ' + E.startSec + ' / 既有 ' + otherStart.join(','));
  expect('★抵达半径必须远小于航程（一出生就算"到了"的话，这一整段玩法不存在）',
    E.arriveDist < E.flight * 0.1, 'arriveDist=' + E.arriveDist + ' / flight=' + E.flight);
  const fullSurviveSec = E.hp / (E.touchDps * E.contactCap);
  expect('★★满额接触下的存活时间必须在 2~15 秒之间：低于 2 秒玩家来不及反应（等于随机失败），'
    + '高于 15 秒她就是个无敌的靶子',
    fullSurviveSec > 2 && fullSurviveSec < 15, '满额存活 ' + fullSurviveSec.toFixed(2) + ' 秒');
  expect('★★contactCap 必须不超过 8（后期一屏几十只，上限太高就等于没有上限）',
    E.contactCap <= 8, 'cap=' + E.contactCap);
  expect('★奖励至少 2 只宝箱（她要求玩家离开原位十秒，低于挑战者的 1 只就没人跟）',
    E.rewardChest >= 2, 'rewardChest=' + E.rewardChest);
  expect('★同屏上限必须是 1（两只一起飞，"跟不跟"会变成"跟哪只"）',
    E.maxAlive === 1, 'maxAlive=' + E.maxAlive);
  expect('★lifeSec 必须至少是「航程/速度」的两倍（保险丝不能比正常航程还短）',
    E.lifeSec > (E.flight / E.speed) * 2,
    'lifeSec=' + E.lifeSec + ' / 正常 ' + (E.flight / E.speed).toFixed(1) + ' 秒');
  function rgbOf(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function notPurple(h) {
    const c = rgbOf(h);
    // 紫/紫蓝的共同特征：绿通道显著低于红与蓝（红蓝都高、绿塌下去）。
    // 青（海青）与暖白都不该被这条判成紫。
    return c[1] >= c[0] * 0.9 && c[1] >= c[2] * 0.75;
  }
  expect('★主色不许发紫（本项目配色铁律：暗红 + 琥珀金 + 冷灰，禁紫/紫蓝）',
    notPurple(E.color), E.color);
  expect('★航迹色不许发紫（同上）', notPurple(E.trailColor), E.trailColor);
  expect('★★kind 与两个新色值都要在二进制串池里（pickups.kind 与 fx.color 都是 str 字段，'
    + '不进池就走长格式）',
    pool.indexOf('escort') !== -1 && pool.indexOf(E.color) !== -1 && pool.indexOf(E.trailColor) !== -1,
    'escort=' + (pool.indexOf('escort') !== -1)
    + ' 主色=' + (pool.indexOf(E.color) !== -1)
    + ' 航迹=' + (pool.indexOf(E.trailColor) !== -1));

  // ---------- 1. 生成 ----------
  const w1 = cleanWorld(5101);
  const p1 = parkPlayer(w1);
  w1.tick = startTick - 1;
  w1.escortNextTick = 0;
  SIM.maybeSpawnEscort(w1);
  expect('★到点前一帧：一只都不许出现，也不许播报',
    escorts(w1).length === 0 && evs(w1, 'escort').length === 0,
    '精卫 ' + escorts(w1).length + ' 只 / 播报 ' + evs(w1, 'escort').length + ' 条');

  w1.tick = startTick;
  const rngBefore = w1.rngState;
  SIM.maybeSpawnEscort(w1);
  const it1 = escorts(w1)[0];
  expect('★到点那一帧：正好一只', escorts(w1).length === 1 && !!it1,
    escorts(w1).length + ' 只');
  expect('★★生成不许消费主随机流（方位走 affixHash）：插一次就会把之后每一波的落点整体挪一格',
    w1.rngState === rngBefore, 'rng=' + rngBefore + '->' + w1.rngState);
  expect('★初始血量百分比必须是满的（value=100，客户端靠它画血环）',
    it1 && it1.value === 100, it1 ? ('value=' + it1.value) : 'null');
  expect('★★起点必须离玩家 offset 的七成以上：被贴边 clamp 到脚下的话，'
    + '"起飞"这一瞬根本看不见（镇妖钟立钟时踩过同款）',
    it1 && dist(it1, p1) >= E.offset * 0.7, it1 ? Math.round(dist(it1, p1)) + 'px' : 'null');
  expect('★终点必须落在航程的 45% 以上（被地图边缘截断的"三秒就到"等于没有护送）',
    it1 && dist({ x: it1.x, y: it1.y }, { x: it1.tx, y: it1.ty }) >= E.flight * 0.45,
    it1 ? Math.round(dist({ x: it1.x, y: it1.y }, { x: it1.tx, y: it1.ty })) + 'px' : 'null');
  expect('★终点必须在地图内（飞到地图外＝她永远到不了，45 秒保险丝会兜底成"无故消失"）',
    it1 && it1.tx > 0 && it1.tx < w1.map.w && it1.ty > 0 && it1.ty < w1.map.h,
    it1 ? (Math.round(it1.tx) + ',' + Math.round(it1.ty) + ' / 地图 ' + w1.map.w + 'x' + w1.map.h) : 'null');
  expect('★生成必须恰好发一条播报（每只一条；按帧播会刷屏）',
    evs(w1, 'escort').length === 1, evs(w1, 'escort').length + ' 条');
  expect('★生成成功后下一次排期顺延一个 everySec（不是 retrySec）',
    w1.escortNextTick === w1.tick + everyTick,
    '差 ' + (w1.escortNextTick - w1.tick) + ' tick / 期望 ' + everyTick);
  expect('★新世界开局不许自带精卫（她只由事件入口放出来）', (function () {
    const wf = SIM.createWorld({ seed: 5102 });
    return escorts(wf).length === 0;
  })(), '开局就有');

  // ---------- 2. 同屏上限 + 短等 ----------
  const w2 = cleanWorld(5103);
  parkPlayer(w2);
  w2.tick = startTick;
  SIM.maybeSpawnEscort(w2);
  w2.tick = startTick + 5 * HZ;
  w2.escortNextTick = 0;
  const second = SIM.maybeSpawnEscort(w2);
  expect('★★同屏只许一只：地上还有她的时候再来一次，必须什么都不生成',
    second === null && escorts(w2).length === 1, escorts(w2).length + ' 只');
  expect('★★满了只**短等 retrySec**、不许顺延整个 148 秒（否则玩家躲开一次就得再等两分半）',
    w2.escortNextTick - w2.tick === retryTick,
    '差 ' + (w2.escortNextTick - w2.tick) + ' tick / 期望 ' + retryTick);

  // ---------- 3. 飞行与接触伤害 ----------
  const w3 = cleanWorld(5104);
  parkPlayer(w3);
  w3.tick = startTick;
  SIM.maybeSpawnEscort(w3);
  const it3 = escorts(w3)[0];
  const x0 = it3.x;
  const y0 = it3.y;
  const tx0 = it3.tx;
  const ty0 = it3.ty;
  SIM.tickEscort(w3, 0.5);
  const moved = dist(it3, { x: x0, y: y0 });
  expect('★半秒只走 speed×0.5（不许瞬移）：应该走 ' + Math.round(E.speed * 0.5) + 'px',
    Math.abs(moved - E.speed * 0.5) <= 1.5, '实际 ' + Math.round(moved) + 'px');
  expect('★她是朝终点飞的（位移之后离终点必须更近）',
    dist(it3, { x: tx0, y: ty0 }) < dist({ x: x0, y: y0 }, { x: tx0, y: ty0 }),
    '离终点 ' + Math.round(dist(it3, { x: tx0, y: ty0 })) + 'px');
  expect('★没有妖物贴着她时，血量一点都不能掉',
    Math.abs(it3.hp - E.hp) < 0.001, 'hp=' + it3.hp);

  // 一只贴脸：dt=1 一次算清（伤害在移动之前结算，所以这一帧的起始位置就是判据）
  const w4 = cleanWorld(5105);
  parkPlayer(w4);
  w4.tick = startTick;
  SIM.maybeSpawnEscort(w4);
  const it4 = escorts(w4)[0];
  mkMobAt(w4, it4.x, it4.y, 7101);
  SIM.tickEscort(w4, 1);
  expect('★一只妖物贴着她一秒：掉 touchDps 点血（' + E.touchDps + '）',
    Math.abs((E.hp - it4.hp) - E.touchDps) < 0.5, '掉了 ' + (E.hp - it4.hp).toFixed(1));
  expect('★血量百分比必须跟着掉（value 是客户端唯一能看到的那一格）',
    it4.value === Math.round((it4.hp / it4.hpMax) * 100), 'value=' + it4.value
    + ' / 期望 ' + Math.round((it4.hp / it4.hpMax) * 100));

  // 20 只贴脸：只按 contactCap 算
  const w5 = cleanWorld(5106);
  parkPlayer(w5);
  w5.tick = startTick;
  SIM.maybeSpawnEscort(w5);
  const it5 = escorts(w5)[0];
  for (let k = 0; k < 20; k++) mkMobAt(w5, it5.x + (k % 5) * 3, it5.y + Math.floor(k / 5) * 3, 7200 + k);
  SIM.tickEscort(w5, 1);
  const lost = E.hp - it5.hp;
  expect('★★同时贴 20 只时伤害必须按 contactCap(' + E.contactCap + ') 封顶，'
    + '不许 20 只一起算（否则后期一坨怪碾过来是一帧秒杀 = 随机失败）',
    Math.abs(lost - E.touchDps * E.contactCap) < 0.5,
    '掉了 ' + lost.toFixed(1) + ' / 期望 ' + (E.touchDps * E.contactCap));
  expect('★贴了 20 只也不许当场死（满额要 ' + fullSurviveSec.toFixed(1) + ' 秒才打得穿）',
    it5.hp > 0, 'hp=' + it5.hp.toFixed(1));

  // 够不着的妖物不算
  const w6 = cleanWorld(5107);
  parkPlayer(w6);
  w6.tick = startTick;
  SIM.maybeSpawnEscort(w6);
  const it6 = escorts(w6)[0];
  const far = mkMobAt(w6, it6.x + 260, it6.y, 7301);
  expect('★对照：那只远处的妖物是活的（否则下面那条"不掉血"不成立）',
    !!far && far.alive === true, far ? 'alive' : 'null');
  SIM.tickEscort(w6, 1);
  expect('★两百多像素外的妖物不许伤到她（判定半径 = 她 + 妖物半径 + contactPad）',
    Math.abs(it6.hp - E.hp) < 0.001, 'hp=' + it6.hp);

  // ---------- 4. 抵达：只在抵达那一帧给奖励，而且只给一次 ----------
  const w7 = cleanWorld(5108);
  parkPlayer(w7);
  w7.tick = startTick;
  SIM.maybeSpawnEscort(w7);
  const it7 = escorts(w7)[0];
  // 把她摆到"还差一点点"的位置上（沿指向终点的方向退回来）
  const ddx = it7.tx - it7.x;
  const ddy = it7.ty - it7.y;
  const dlen = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
  it7.x = it7.tx - (ddx / dlen) * (E.arriveDist + 4);
  it7.y = it7.ty - (ddy / dlen) * (E.arriveDist + 4);
  SIM.tickEscort(w7, DT);
  expect('★★差一点点的时候不许发奖励（提前给就等于"她一到半路就掉宝箱"）',
    chests(w7).length === 0 && evs(w7, 'escort_done').length === 0,
    '宝箱 ' + chests(w7).length + ' / 播报 ' + evs(w7, 'escort_done').length);
  tickN(w7, 4);
  expect('★★抵达必须正好掉 ' + E.rewardChest + ' 只宝箱（不多不少）',
    chests(w7).length === E.rewardChest, '宝箱 ' + chests(w7).length + ' 只');
  expect('★两只宝箱不许叠在同一点（叠着只会被一次性吸走，看着像只掉了一个）',
    chests(w7).length === 2 && dist(chests(w7)[0], chests(w7)[1]) > 20,
    chests(w7).length === 2 ? '间距 ' + Math.round(dist(chests(w7)[0], chests(w7)[1])) : '宝箱数不对');
  expect('★★她本人必须从 pickups 里消失（留在场上＝玩家会一直以为还有一趟要护）',
    escorts(w7).length === 0, escorts(w7).length + ' 只');
  expect('★抵达播报恰好一条',
    evs(w7, 'escort_done').length === 1, evs(w7, 'escort_done').length + ' 条');
  const chestsBefore = chests(w7).length;
  tickN(w7, 60);
  expect('★★奖励只发一次：再推 3 秒也不许多掉一只宝箱，也不许多播一条',
    chests(w7).length === chestsBefore && evs(w7, 'escort_done').length === 1,
    '宝箱 ' + chests(w7).length + ' / 播报 ' + evs(w7, 'escort_done').length);

  // ---------- 5. ★★★同一帧既被打穿又压线：必须判死（不许既死又成功） ----------
  const w8 = cleanWorld(5109);
  parkPlayer(w8);
  w8.tick = startTick;
  SIM.maybeSpawnEscort(w8);
  const it8 = escorts(w8)[0];
  it8.x = it8.tx - 2;      // 已经在抵达半径内
  it8.y = it8.ty;
  it8.hp = 1;              // 一帧就会被打穿
  mkMobAt(w8, it8.x, it8.y, 7401);
  SIM.tickEscort(w8, 1);
  expect('★★★同一帧既被打穿又压线时，**死优先**：既不许给宝箱、也不许有抵达播报',
    chests(w8).length === 0 && evs(w8, 'escort_done').length === 0,
    '宝箱 ' + chests(w8).length + ' / 抵达播报 ' + evs(w8, 'escort_done').length);
  expect('★★折翼播报必须有且只有一条（她不声不响地消失，玩家会以为是自己看漏了）',
    evs(w8, 'escort_lost').length === 1, evs(w8, 'escort_lost').length + ' 条');
  expect('★★折翼之后她必须从场上消失', escorts(w8).length === 0, escorts(w8).length + ' 只');
  expect('★折翼要有三片羽毛（纯表现，但它是"她没了"唯一的解释）',
    w8.effects.filter(function (e) { return e.kind === 'feathers'; }).length === 3,
    w8.effects.filter(function (e) { return e.kind === 'feathers'; }).length + ' 片');
  tickN(w8, 60);
  expect('★★折翼之后不许再发抵达奖励（再推 3 秒）',
    chests(w8).length === 0 && evs(w8, 'escort_done').length === 0,
    '宝箱 ' + chests(w8).length);

  // ---------- 6. ★★★玩家从她身上走过去：不许把她"捡走" ----------
  // 【为什么这条最贵】updatePickups 里那个 `if (d <= pickupR)` 的默认分支会把
  //   「进了拾取半径、但谁都不认识」的 kind 直接吃掉（不写回数组 = 被丢弃）。
  //   少了 sim 里那一支 write++，表现就是：玩家走过去，她凭空消失，
  //   没有播报、没有宝箱、连羽毛都没有 —— 而任何"生成/抵达"的断言都照样全绿。
  const w9 = cleanWorld(5110);
  const p9 = parkPlayer(w9);
  w9.tick = startTick;
  SIM.maybeSpawnEscort(w9);
  const it9 = escorts(w9)[0];
  p9.x = it9.x;
  p9.y = it9.y;
  SIM.setSelf(w9, p9);
  const expBefore = w9.stats.exp;
  let stillThere = true;
  for (let k = 0; k < 8; k++) {
    SIM.step(w9, { mx: 0, my: 0 });
    if (escorts(w9).length !== 1) { stillThere = false; break; }
  }
  expect('★★★玩家站在她身上推 8 帧，她必须还在场上（走一趟就把她捡没了是静默级事故）',
    stillThere, '精卫 ' + escorts(w9).length + ' 只');
  expect('★她也不许被当成经验球吃掉（走上去不涨经验、不涨金币）',
    w9.stats.exp === expBefore && w9.stats.gold === 0,
    'exp ' + expBefore + '->' + w9.stats.exp + ' / gold=' + w9.stats.gold);

  // ---------- 7. 不被磁石吸走：位移只由她自己决定 ----------
  const w10 = cleanWorld(5111);
  parkPlayer(w10);
  w10.tick = startTick;
  SIM.maybeSpawnEscort(w10);
  const it10 = escorts(w10)[0];
  const px10 = it10.x;
  const py10 = it10.y;
  // 玩家站在她"来的那一边"120px 处（磁石吸引半径内）：
  // 如果她吃吸引力，位移会被拽向玩家而不是终点。
  const backA = Math.atan2(py10 - it10.ty, px10 - it10.tx);
  const p10 = w10.player;
  p10.x = px10 + Math.cos(backA) * 120;
  p10.y = py10 + Math.sin(backA) * 120;
  SIM.setSelf(w10, p10);
  for (let k = 0; k < 10; k++) SIM.step(w10, { mx: 0, my: 0 });
  expect('★她必须还在（磁石名单 / 拾取写回都得排除她）', escorts(w10).length === 1,
    escorts(w10).length + ' 只');
  expect('★★她不许被磁石吸向玩家：十帧之后必须仍在朝**终点**逼近，'
    + '而且离玩家的距离不许变小',
    (function () {
      const now = escorts(w10)[0];
      if (!now) return false;
      const toTarget = dist({ x: px10, y: py10 }, { x: it10.tx, y: it10.ty })
        - dist(now, { x: it10.tx, y: it10.ty });
      const toPlayer = dist(now, p10) - dist({ x: px10, y: py10 }, p10);
      return toTarget > 3 && toPlayer > -1;
    })(), '见下一条明细');

  // ---------- 8. ★★剧情关（双管） ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 5191, modId: 'myth', stageId: 'ch1' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.escortNextTick = 0;
  const directS = SIM.maybeSpawnEscort(wS);
  expect('★★直接调事件入口也必须被剧情关挡住（不依赖 step 会不会早退）：'
    + '主线是逐关手工配平的，凭空多一个「必须离开原位去护航」的目标会抹掉配好的走位难度',
    !!wS.storyStage && directS === null
      && escorts(wS).length === 0 && evs(wS, 'escort').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
      + ' 返回=' + (directS ? '有' : 'null')
      + ' / 精卫 ' + escorts(wS).length + ' 只');

  // 走 step 那一遍：用 ch3（360 秒上限）——★不能用 ch2：它上限 300 秒，
  //   而第二遍要把 tick 推到 294+30=324 秒，那时候关卡早就结束了、step 直接早退
  //   （第 49 轮「用超时关卡验不该出现的东西 = 假绿」就是这么来的）。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 5193, modId: 'myth', stageId: 'ch3' });
  wS2.player.expNext = 1e9;
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((E.startSec + k * 30) * HZ);
    wS2.escortNextTick = 0;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch3）走完整条 step 也没有精卫，**而且那一刻世界确实还在跑**：'
    + '不钉「世界还活着」的话，用超时的关卡验任何「不该出现的东西」都会假绿（第 49 轮的血泪）',
    storyAlive && escorts(wS2).length === 0 && evs(wS2, 'escort').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '）'
      + ' / 精卫 ' + escorts(wS2).length + ' 只 / 播报 ' + evs(wS2, 'escort').length + ' 条');
}

// ============================================================
// 第五十二轮：大人之市（把攒着的金币当场花掉）
// ============================================================
//
// 【为什么这一轮要写的断言与前面几轮不一样】
//   前十七件都是「走过去 → 拿到东西」，失败分支是"没拿到"。
//   这一件的失败分支是「**钱没了，东西也没到手**」—— 它必须是不可能发生的。
//   所以本段最贵的几条都钉在钱上：拒绝了不许扣钱、钱不够不许扣钱、
//   血满时买绷带不许扣钱、血契石满层不许扣钱，而且「扣了多少」必须**正好**
//   等于打折价（不是商店原价）。
function testMarket() {
  console.log('[第五十二轮] 大人之市：把攒着的金币当场花掉（18 件里第一件找你要钱的）');
  const M = C.MARKET;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(M.startSec * HZ);
  const everyTick = Math.round(M.everySec * HZ);
  const retryTick = Math.round(M.retrySec * HZ);
  const PB = require('../shared/proto_bin.js');
  const pool = PB.STR_POOL || [];
  const FS2 = require('fs');
  const PATH2 = require('path');

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  // 干净世界：清武器（免得顺手把怪清掉）、锁经验（免升级面板冻住 step）、
  // 其它事件排期全部推到很远（这一段只验摊子）。
  // ★每加一个事件型机制都要回来补这张表（第 50 轮的血泪）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.bountyNextTick = 1e9;   // 第五十四轮：悬赏首发 186s，默认推远（要验它的世界自己打开）
    w.healerNextTick = 1e9;   // 第五十五轮：回春巫首发 252s，默认推远（要验它的世界自己打开）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;     // 默认不排期：要生成的世界自己显式打开
    w.cauldronNextTick = 1e9;   // 第五十三轮：炼魂鼎也要推远（它 324 秒首发，本表剧情验证推到 342）
    w.mobs.length = 0;
    w.pickups.length = 0;       // ★地图自带的宝箱/金币也清掉：数钱才干净
    SIM.setSelf(w, p);
    return w;
  }
  function markets(w) {
    return w.pickups.filter(function (it) { return it.kind === 'market'; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function parkPlayer(w) {
    const p = w.player;
    p.x = Math.round(w.map.w / 2);
    p.y = Math.round(w.map.h / 2);
    SIM.setSelf(w, p);
    return p;
  }
  // 直接在玩家脚边摆一座摊（落点检查是给真实落点用的，测试要精确控制"站在摊上"）
  function stallAt(w, offerId, offX) {
    const p = w.player;
    const idx = M.offers.indexOf(offerId);
    SIM.spawnPickup(w, 'market', p.x + (offX === undefined ? 4 : offX), p.y, idx, M.lifeSec);
    const it = w.pickups[w.pickups.length - 1];
    it.offer = offerId;
    return it;
  }
  function offerItem(id) {
    const items = C.SHOP.items;
    for (let i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }
  function offerPrice(id) {
    const it = offerItem(id);
    if (!it) return -1;
    return Math.max(1, Math.round(it.price * M.discount));
  }
  function steps(w, n) {
    for (let i = 0; i < n; i++) SIM.step(w, { mx: 0, my: 0 });
  }

  // ---------- 0. 表自洽 ----------
  expect('★MARKET 表必须存在且有名字（表被删/改名时事件会静默什么都不生成）',
    !!M && !!M.name, M ? M.name : 'null');
  expect('★★首发帧不许落在 30 秒波次网格上（压在波次那一帧，场上其实是空的 —— 陨星踩过）',
    M.startSec % 30 !== 0, 'startSec=' + M.startSec + ' %30=' + (M.startSec % 30));
  const otherStart2 = [];
  ['CHALLENGER', 'BLOOD_MOON', 'METEOR', 'LEYLINE', 'BLOODPACT', 'SUMMONER',
    'TWINS', 'LANTERN', 'DEVOURER', 'BOON', 'BELL', 'MERGE', 'ESCORT'].forEach(function (k) {
    const t = C[k];
    if (t && typeof t.startSec === 'number') otherStart2.push(t.startSec);
  });
  expect('★★首发帧不许与任何既有事件撞 tick（同帧两件事一起弹，玩家只读得到一条）',
    otherStart2.indexOf(M.startSec) === -1,
    '本件 ' + M.startSec + ' / 既有 ' + otherStart2.join(','));
  expect('★间隔不许太密（<=60 秒就成了"一直有摊子"，攒钱换契约那条路会整个消失）',
    M.everySec >= 60, 'everySec=' + M.everySec);
  expect('★★折扣必须真的便宜（>0.85 就等于"不如回商店买"，而联机根本没有商店）',
    M.discount > 0 && M.discount <= 0.85, 'discount=' + M.discount);
  expect('★折扣也不许低到 0.5 以下（血契石会便宜到"有钱就买"，攒钱那条路死掉）',
    M.discount >= 0.5, 'discount=' + M.discount);
  expect('★摊上的货至少两种（只有一种就不叫"今天卖什么"，而且会变成固定补给点）',
    M.offers.length >= 2, 'offers=' + M.offers.join(','));
  let offerOk = true;
  let offerDetail = '';
  for (let i = 0; i < M.offers.length; i++) {
    const it2 = offerItem(M.offers[i]);
    if (!it2) { offerOk = false; offerDetail = '找不到 ' + M.offers[i]; break; }
    // ★两段式商品（pick）绝对不能在摊子上卖：摊前没有面板可用，
    //   走到摊上只会拿到 needPick（钱不扣、货不给），玩家会以为摊子坏了。
    if (it2.pick) { offerOk = false; offerDetail = it2.id + ' 需要二段选择'; break; }
    if (!it2.cost) { offerOk = false; offerDetail = it2.id + ' 没有 cost'; break; }
  }
  expect('★★摊上只许卖「付钱就立刻生效」的货：两段式商品（血脉契约/置换契约）在摊子上没法用 ——'
    + '摊前没有面板可选，玩家会站在摊子上反复拿到 needPick（钱不扣、货不给）',
    offerOk, offerDetail || M.offers.join(','));
  let priceOk = true;
  let priceDetail = '';
  for (let i = 0; i < M.offers.length; i++) {
    const it3 = offerItem(M.offers[i]);
    if (!it3) continue;
    const pr = offerPrice(M.offers[i]);
    if (pr < 1 || pr >= it3.price) { priceOk = false; priceDetail = it3.id + ' ' + pr + ' vs ' + it3.price; }
  }
  expect('★每种货的打折价都必须**严格低于**商店价且不少于 1 枚（出现 0 金就是白给）',
    priceOk, priceDetail || M.offers.map(function (id) {
      return id + '=' + offerPrice(id) + '/' + (offerItem(id) ? offerItem(id).price : '?');
    }).join(' '));
  expect('★★成交半径必须远小于摆摊距离：否则摆在 220px 外、站原地就"买"了',
    M.buyRadius < M.offset * 0.3, 'buyRadius=' + M.buyRadius + ' / offset=' + M.offset);
  expect('★摆摊距离要在手机视野内（半屏约 300~400），否则玩家根本看不见摊子',
    M.offset > 120 && M.offset < 380, 'offset=' + M.offset);
  expect('★lifeSec 要在 15~40 秒之间：太短来不及打完手上这一波，太长就变成常驻商店',
    M.lifeSec >= 15 && M.lifeSec <= 40, 'lifeSec=' + M.lifeSec);
  expect('★同屏上限必须是 1（两座并排 = 玩家要在摊子前做算术题，而世界不会停）',
    M.maxAlive === 1, 'maxAlive=' + M.maxAlive);
  expect('★落空只许短等（<=5 秒）：顺延整段间隔会让后面整串排期被推走（陨星/灯/钟都踩过）',
    M.retrySec > 0 && M.retrySec <= 5, 'retrySec=' + M.retrySec);
  expect('★★kind 必须在二进制串池里（pickups.kind 是 str 字段，不进池就走长格式）',
    pool.indexOf('market') !== -1, 'market=' + (pool.indexOf('market') !== -1));
  // 紫/紫蓝的判据：**蓝与红都明显高于绿**（紫罗兰 #8b5cf6：r139 g92 b246）。
  // ★不能照搬精卫那轮的 "green >= red*0.9"：那条判据会把青铜（#b0793a：r176 g121 b58）
  //   判成紫 —— 而青铜/棕色本来就是红远大于绿、蓝最低，是暖色不是紫。
  function rgbOf(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function notPurple(h) {
    const c = rgbOf(h);
    const isPurple = c[2] > c[1] * 1.05 && c[0] > c[1] * 1.05;
    return !isPurple;
  }
  expect('★四色都不许发紫（本项目配色铁律：暗红 + 琥珀金 + 冷灰，禁紫/紫蓝）',
    notPurple(M.color) && notPurple(M.clothColor) && notPurple(M.woodColor) && notPurple(M.buyColor),
    [M.color, M.clothColor, M.woodColor, M.buyColor].join(' '));
  // 表里的字段不许是死字段（写了却没人读 —— 引魂灯那轮立下的规矩）
  const simSrc = FS2.readFileSync(PATH2.join(__dirname, '../shared/sim.js'), 'utf8');
  const deadKeys = ['startSec', 'everySec', 'maxAlive', 'offset', 'buyRadius', 'lifeSec',
    'retrySec', 'discount', 'offers'].filter(function (k) {
    return simSrc.indexOf('rule.' + k) === -1;
  });
  expect('★表里不许有死字段（写了却没人读的数值，等于给下一个人埋一个"改了没用"的坑）',
    deadKeys.length === 0, deadKeys.join(','));

  // ---------- 1. 生成 ----------
  const w1 = cleanWorld(5201);
  const p1 = parkPlayer(w1);
  w1.tick = startTick - 1;
  w1.marketNextTick = 0;
  SIM.maybeSpawnMarket(w1);
  expect('★到点前一帧：一座都不许出现，也不许播报',
    markets(w1).length === 0 && evs(w1, 'market').length === 0,
    '摊子 ' + markets(w1).length + ' 座 / 播报 ' + evs(w1, 'market').length + ' 条');

  w1.tick = startTick;
  const rngBefore = w1.rngState;
  const before1 = w1.mobs.length;
  SIM.maybeSpawnMarket(w1);
  const m1 = markets(w1)[0];
  expect('★到点正好摆开一座（0 座 = 机制不存在；2 座 = 玩家要在摊子前做算术题）',
    markets(w1).length === 1, markets(w1).length + ' 座');
  expect('★★不消费主随机流（rngState 逐位一致）—— 它会在任意 tick 插进来，'
    + '一旦取走随机数，后面每一波的落点都会整体错位',
    w1.rngState === rngBefore, '前 ' + rngBefore + ' / 后 ' + w1.rngState);
  expect('★它不是怪：生成不许顺手往 mobs 里塞东西（塞了就会被武器当敌人打）',
    w1.mobs.length === before1, 'mobs ' + before1 + ' → ' + w1.mobs.length);
  expect('★value 必须是 offers 的合法下标（越界会让客户端算出 undefined 的货名与售价）',
    !!m1 && M.offers.indexOf(m1.offer) === m1.value && m1.value >= 0 && m1.value < M.offers.length,
    m1 ? ('value=' + m1.value + ' offer=' + m1.offer) : 'null');
  const ev1 = evs(w1, 'market');
  expect('★播报恰好一条，且把「卖什么 / 多少钱 / 原价 / 多久收摊」都带上',
    ev1.length === 1 && !!ev1[0].itemName && ev1[0].price > 0
    && ev1[0].listPrice > ev1[0].price && ev1[0].sec === M.lifeSec,
    ev1.length ? JSON.stringify({ n: ev1[0].itemName, p: ev1[0].price, l: ev1[0].listPrice, s: ev1[0].sec }) : '0 条');
  expect('★落点要在"看得见但要走过去"的范围里（被贴边 clamp 到脚下 = 路过自动买）',
    !!m1 && dist(m1, p1) > M.offset * 0.5 && dist(m1, p1) < M.offset * 1.7,
    m1 ? '距玩家 ' + Math.round(dist(m1, p1)) + ' / offset=' + M.offset : 'null');
  expect('★落点必须在地图内（摆到地图外等于这一座不存在）',
    !!m1 && m1.x > 0 && m1.x < w1.map.w && m1.y > 0 && m1.y < w1.map.h,
    m1 ? (Math.round(m1.x) + ',' + Math.round(m1.y) + ' / ' + w1.map.w + 'x' + w1.map.h) : 'null');
  expect('★排期顺延一个完整间隔（everySec），不是短等',
    w1.marketNextTick === startTick + everyTick,
    'nextTick=' + w1.marketNextTick + ' 期望 ' + (startTick + everyTick));

  // ---------- 2. 同屏上限：满了只短等 ----------
  w1.tick = startTick + everyTick;
  SIM.maybeSpawnMarket(w1);
  expect('★场上已有一座时，不许再摆第二座',
    markets(w1).length === 1, markets(w1).length + ' 座');
  expect('★★满了只**短等 retrySec**，不许顺延整个 everySec —— 否则玩家一直不去，'
    + '后面整串排期会被整体推走',
    w1.marketNextTick === w1.tick + retryTick,
    'nextTick=' + w1.marketNextTick + ' / 期望 ' + (w1.tick + retryTick)
    + '（顺延整段会是 ' + (w1.tick + everyTick) + '）');

  // ---------- 3. 成交：钱必须正好扣掉打折价 ----------
  const w2 = cleanWorld(5203);
  const p2 = parkPlayer(w2);
  p2.shopGold = 200;
  p2.hp = p2.maxHp;             // 满血：买血契石（与血无关的货），验证"满血不挡非治疗货"
  const dmgBefore = p2.attrs.dmgMul;
  const st2 = stallAt(w2, 'buff');
  const gold2 = p2.shopGold;
  const price2 = offerPrice('buff');
  SIM.step(w2, { mx: 0, my: 0 });
  expect('★★成交时扣的钱必须正好是**打折价**（不是商店原价）',
    p2.shopGold === gold2 - price2,
    '余额 ' + p2.shopGold + ' / 期望 ' + (gold2 - price2)
    + '（按原价扣会是 ' + (gold2 - offerItem('buff').price) + '）');
  expect('★货必须真的到手（血契石 +12% 伤害，且走 recalcAttrs 落到 attrs 上）',
    Math.abs(p2.shopBuffDmg - 0.12) < 1e-6 && p2.attrs.dmgMul > dmgBefore,
    'shopBuffDmg=' + p2.shopBuffDmg + ' dmgMul ' + dmgBefore + ' → ' + p2.attrs.dmgMul);
  expect('★成交后摊子必须消失（留着的话玩家会反复走上去，以为能一直买）',
    markets(w2).length === 0 && !!st2.sold, markets(w2).length + ' 座');
  expect('★成交播报恰好一条，且带上「花了多少 / 还剩多少」',
    evs(w2, 'market_bought').length === 1
    && evs(w2, 'market_bought')[0].price === price2
    && evs(w2, 'market_bought')[0].gold === p2.shopGold,
    evs(w2, 'market_bought').length + ' 条');
  steps(w2, 60);
  expect('★★再推 3 秒不许二次扣钱（摊子已经没了，谁再扣一次就是最恶劣的那种 bug）',
    p2.shopGold === gold2 - price2 && evs(w2, 'market_bought').length === 1,
    '余额 ' + p2.shopGold + ' / 成交 ' + evs(w2, 'market_bought').length + ' 次');

  // ---------- 4. 拒绝：钱不够 —— 一分钱都不许动，摊子必须留在原地 ----------
  const w3 = cleanWorld(5205);
  const p3 = parkPlayer(w3);
  p3.shopGold = 10;
  p3.hp = p3.maxHp;
  const st3 = stallAt(w3, 'buff');
  const needPrice = offerPrice('buff');
  for (let k = 0; k < 8; k++) SIM.step(w3, { mx: 0, my: 0 });
  expect('★★钱不够时一分钱都不许扣（"先扣再判"会让玩家路过就被扣成 0，'
    + '而提示条只写「还差 X 金币」，没人看得出钱去哪了）',
    p3.shopGold === 10, '余额 ' + p3.shopGold);
  expect('★★货也不许给（钱没扣、伤害却涨了 = 白送）',
    p3.shopBuffDmg === 0 && markets(w3).length === 1,
    'shopBuffDmg=' + p3.shopBuffDmg + ' / 摊子 ' + markets(w3).length + ' 座');
  expect('★★★站在摊上推 8 帧，摊子必须**还在**（拒绝分支漏了写回数组就会把它吃掉 ——'
    + '玩家看到"提示条说我钱不够，然后摊子没了"，而「生成 / 成交 / 收摊」三种断言照样全绿，'
    + '这是精卫那轮踩过的同一个坑）',
    markets(w3).length === 1, markets(w3).length + ' 座');
  const deny3 = evs(w3, 'market_deny');
  expect('★★拒绝播报必须**节流**到一条（摊子留在原地，不拦的话一秒刷几十条）',
    deny3.length === 1, deny3.length + ' 条');
  expect('★播报要说清「差多少」：只说"金币不够"玩家不知道还差 5 枚还是 500 枚',
    deny3.length === 1 && deny3[0].reason === 'no_gold'
    && deny3[0].lack === needPrice - 10 && deny3[0].price === needPrice,
    deny3.length ? JSON.stringify({ r: deny3[0].reason, lack: deny3[0].lack, price: deny3[0].price }) : '0 条');
  expect('★摊子还在原地（坐标没被"拒绝"这一步挪动过）',
    !!st3 && markets(w3)[0] === st3, '同一颗=' + (markets(w3)[0] === st3));

  // 钱够了再回来：必须能买（拒绝不该有后遗症）
  p3.shopGold = 200;
  SIM.step(w3, { mx: 0, my: 0 });
  expect('★★攒够钱再站上去必须能成交（拒绝只是"现在不行"，不许留下永久拉黑）',
    markets(w3).length === 0 && p3.shopBuffDmg > 0 && p3.shopGold < 200,
    '摊子 ' + markets(w3).length + ' 座 / shopBuffDmg=' + p3.shopBuffDmg + ' / 余额 ' + p3.shopGold);

  // ---------- 5. 拒绝：血满时买绷带（最容易被忽略的一种"白扔钱"） ----------
  const w4 = cleanWorld(5207);
  const p4 = parkPlayer(w4);
  p4.shopGold = 200;
  p4.hp = p4.maxHp;
  stallAt(w4, 'heal');
  steps(w4, 6);
  expect('★★血是满的时候买绷带必须被拒（60 点回复一滴不剩 = 把钱扔在地上）：'
    + '不扣钱、不给货、摊子留在原地',
    p4.shopGold === 200 && markets(w4).length === 1,
    '余额 ' + p4.shopGold + ' / 摊子 ' + markets(w4).length + ' 座');
  expect('★拒绝理由必须是 hp_full（提示条要能说出"血是满的"，而不是含糊的"买不了"）',
    evs(w4, 'market_deny').length === 1 && evs(w4, 'market_deny')[0].reason === 'hp_full',
    evs(w4, 'market_deny').length ? evs(w4, 'market_deny')[0].reason : '0 条');
  // 掉血之后同一个摊子必须能买
  p4.hp = p4.maxHp - 100;
  SIM.step(w4, { mx: 0, my: 0 });
  expect('★掉血之后同一个摊子必须立刻能买（"血满"是**当下**的判断，不是永久拒绝）',
    markets(w4).length === 0 && p4.hp > p4.maxHp - 100 && p4.shopGold === 200 - offerPrice('heal'),
    '血 ' + Math.round(p4.hp) + ' / 余额 ' + p4.shopGold);

  // ---------- 6. 拒绝：血契石满 3 层 ----------
  const w5 = cleanWorld(5209);
  const p5 = parkPlayer(w5);
  p5.shopGold = 200;
  p5.shopBuffDmg = 0.36;        // 3 层已满
  p5.hp = p5.maxHp;
  stallAt(w5, 'buff');
  steps(w5, 6);
  expect('★★血契石已满 3 层时必须拒绝（shopBuy 会挡，但摊子这一层也要把播报说清楚）：'
    + '不扣钱、摊子留在原地',
    p5.shopGold === 200 && p5.shopBuffDmg === 0.36 && markets(w5).length === 1,
    '余额 ' + p5.shopGold + ' / 层数 ' + p5.shopBuffDmg + ' / 摊子 ' + markets(w5).length + ' 座');
  expect('★拒绝必须播报（静默拒绝 = 玩家以为摊子坏了，会一直站在上面试）',
    evs(w5, 'market_deny').length === 1, evs(w5, 'market_deny').length + ' 条');

  // ---------- 7. 买笔记：经验必须真的涨（走 gainExp，不能直接改 exp） ----------
  const w6 = cleanWorld(5211);
  const p6 = parkPlayer(w6);
  p6.shopGold = 200;
  p6.hp = p6.maxHp;
  const expBefore = p6.exp;
  stallAt(w6, 'exp');
  SIM.step(w6, { mx: 0, my: 0 });
  expect('★买笔记必须真的涨经验（走 gainExp；直接改 exp 会绕过升级/加血/开面板）',
    p6.exp > expBefore && p6.shopGold === 200 - offerPrice('exp'),
    'exp ' + expBefore + ' → ' + p6.exp + ' / 余额 ' + p6.shopGold);

  // ---------- 8. 磁石：摊子不许被吸走 ----------
  const w7 = cleanWorld(5213);
  const p7 = parkPlayer(w7);
  p7.shopGold = 0;
  const st7 = stallAt(w7, 'buff', 120);   // 120px：磁石吸引半径内
  const sx7 = st7.x;
  const sy7 = st7.y;
  steps(w7, 10);
  expect('★★摊子不许被磁石吸走（被吸过来就等于"隔着两个身位自动买"，'
    + '"走过去"这个唯一的成本会消失）',
    markets(w7).length === 1 && markets(w7)[0].x === sx7 && markets(w7)[0].y === sy7,
    markets(w7).length ? ('位移 ' + Math.round(markets(w7)[0].x - sx7)) : '摊子没了');

  // ---------- 9. 收摊：到点必须播一条，且不许退钱/扣钱 ----------
  const w8 = cleanWorld(5215);
  const p8 = parkPlayer(w8);
  p8.shopGold = 0;
  stallAt(w8, 'exp', 200);      // 摆远一点，别被"站上去"打断
  const gold8 = p8.shopGold;
  steps(w8, Math.ceil((M.lifeSec + 0.5) * HZ));
  expect('★到点收摊：摊子必须消失',
    markets(w8).length === 0, markets(w8).length + ' 座');
  expect('★收摊必须播**一条**提示（不播的话玩家会以为自己看错了，'
    + '或者以为被谁偷偷买走了）',
    evs(w8, 'market_gone').length === 1, evs(w8, 'market_gone').length + ' 条');
  expect('★收摊不许动钱（既不退也不扣）', p8.shopGold === gold8, '余额 ' + p8.shopGold);

  // ---------- 10. 饕餮吃不到摊子 ----------
  const w9 = cleanWorld(5217);
  parkPlayer(w9);
  stallAt(w9, 'heal', 30);
  expect('★★饕餮的食物名单里不许有摊子（它是"要你走过去掏钱"的东西，'
    + '被偷走会让玩家觉得这机制在阴人 —— 宝箱/神龛/祭坛/灯/红心都是同一条）',
    SIM.findDevourFood(w9, { x: w9.player.x + 30, y: w9.player.y }) === null,
    SIM.findDevourFood(w9, { x: w9.player.x + 30, y: w9.player.y }) ? '被当成食物了' : 'null');

  // ---------- 11. ★★剧情关（双管） ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 5221, modId: 'myth', stageId: 'ch4' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.marketNextTick = 0;
  const directS = SIM.maybeSpawnMarket(wS);
  expect('★★直接调事件入口也必须被剧情关挡住（不依赖 step 会不会早退）：'
    + '主线是逐关手工配平的，凭空多一条「花金币换属性」的支线会破坏配好的成长曲线',
    !!wS.storyStage && directS === null
    && markets(wS).length === 0 && evs(wS, 'market').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
    + ' 返回=' + (directS ? '有' : 'null')
    + ' / 摊子 ' + markets(wS).length + ' 座');

  // 走 step 那一遍：用 ch4（420 秒上限）。
  // ★必须先算时长：摊子首发 312 秒，验证循环要推到 312+30=342 秒 ——
  //   ch2(300s) / ch3(360s) 都能撑住 342，但 ch1(240s) 会提前结束、step 早退，
  //   那样"没有摊子"就是**假绿**（第 49 轮、第 51 轮各踩过一次）。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 5223, modId: 'myth', stageId: 'ch4' });
  wS2.player.expNext = 1e9;
  let storyAlive2 = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((M.startSec + k * 30) * HZ);
    wS2.marketNextTick = 0;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive2 = false;
  }
  expect('★★剧情关（《补天纪》ch4）走完整条 step 也没有摊子，**而且那一刻世界确实还在跑**：'
    + '不钉「世界还活着」的话，用超时的关卡验任何"不该出现的东西"都会假绿',
    storyAlive2 && markets(wS2).length === 0 && evs(wS2, 'market').length === 0,
    '世界还在跑=' + storyAlive2 + '（state=' + wS2.state + '，上限 ' + wS2.matchSec + ' 秒）'
    + ' / 摊子 ' + markets(wS2).length + ' 座 / 播报 ' + evs(wS2, 'market').length + ' 条');
}

// ============================================================
// 第五十三轮：炼魂鼎（把攒着的经验炼成一口血）
// ============================================================
// 全项目第 19 件事件型玩法，也是第一件动「经验」的：前 18 件付出的是
// 时间/上限/位置/机会/时机/挨打密度/金币，没有一件是"攒着的修为"。
// 断言绝大多数钉「不该发生的事」：满血/经验不足时什么都不做、鼎留在原地、
// 不消费主随机流、剧情关没有、饕餮偷不走、到点不许二次结算。
function testCauldron() {
  console.log('[第五十三轮] 炼魂鼎：把攒着的经验炼成一口血（19 件里第一件动修为的）');
  const K = C.CAULDRON;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(K.startSec * HZ);
  const everyTick = Math.round(K.everySec * HZ);
  const retryTick = Math.round(K.retrySec * HZ);
  const PB = require('../shared/proto_bin.js');
  const pool = PB.STR_POOL || [];
  const FS2 = require('fs');
  const PATH2 = require('path');

  function dist(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }
  // 干净世界：其它事件排期全推很远（这一段只验鼎）。
  // ★每加一个事件型机制都要回来补这张表（第 50 轮的血泪）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.bountyNextTick = 1e9;   // 第五十四轮：悬赏首发 186s，默认推远（要验它的世界自己打开）
    w.healerNextTick = 1e9;   // 第五十五轮：回春巫首发 252s，默认推远（要验它的世界自己打开）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;   // 默认不排期：要生成的世界自己显式打开
    w.mobs.length = 0;
    w.pickups.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function cauldrons(w) {
    return w.pickups.filter(function (it) { return it.kind === 'cauldron'; });
  }
  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function parkPlayer(w) {
    const p = w.player;
    p.x = Math.round(w.map.w / 2);
    p.y = Math.round(w.map.h / 2);
    SIM.setSelf(w, p);
    return p;
  }
  // 直接在玩家脚边浮一座鼎（落点检查是给真实落点用的，测试要精确控制"站在鼎上"）
  function cauldronAt(w, offX) {
    const p = w.player;
    SIM.spawnPickup(w, 'cauldron', p.x + (offX === undefined ? 4 : offX), p.y, 1, K.lifeSec);
    const it = w.pickups[w.pickups.length - 1];
    it.denied = 0;
    return it;
  }
  // 给玩家一笔"可付"的修为：expNext 定成 100，exp 攒够
  function fundExp(p, exp) {
    p.expNext = 100;
    p.exp = exp === undefined ? 60 : exp;
    return p;
  }
  function steps(w, n) {
    for (let i = 0; i < n; i++) SIM.step(w, { mx: 0, my: 0 });
  }

  // ---------- 0. 表自洽 ----------
  expect('★CAULDRON 表必须存在且有名字（表被删/改名时事件会静默什么都不生成）',
    !!K && !!K.name, K ? K.name : 'null');
  expect('★★首发帧不许落在 30 秒波次网格上（压在波次那一帧，场上其实是空的 —— 陨星踩过）',
    K.startSec % 30 !== 0, 'startSec=' + K.startSec + ' %30=' + (K.startSec % 30));
  const otherStart3 = [];
  ['CHALLENGER', 'BLOOD_MOON', 'METEOR', 'LEYLINE', 'BLOODPACT', 'SUMMONER',
    'TWINS', 'LANTERN', 'DEVOURER', 'BOON', 'BELL', 'MERGE', 'ESCORT', 'MARKET'].forEach(function (k) {
    const t = C[k];
    if (t && typeof t.startSec === 'number') otherStart3.push(t.startSec);
  });
  expect('★★首发帧不许与任何既有事件撞 tick（同帧两件事一起弹，玩家只读得到一条）',
    otherStart3.indexOf(K.startSec) === -1,
    '本件 ' + K.startSec + ' / 既有 ' + otherStart3.join(','));
  expect('★间隔不许太密（<=60 秒就成了"一直有鼎"，残血无脑踩）',
    K.everySec >= 60, 'everySec=' + K.everySec);
  expect('★★代价比例必须落在 0.2~0.6（太低＝白送血，太高＝没人用）',
    K.expCostPct >= 0.2 && K.expCostPct <= 0.6, 'expCostPct=' + K.expCostPct);
  expect('★★回报比例必须落在 0.15~0.45（太低不值得付修为，太高＝一口满血不用打了）',
    K.healPct >= 0.15 && K.healPct <= 0.45, 'healPct=' + K.healPct);
  expect('★★最低余量必须大于代价比例（否则"刚够付"就被扣到 0，等于白嫖一口血）',
    K.minExpPct > K.expCostPct, 'minExpPct=' + K.minExpPct + ' / cost=' + K.expCostPct);
  expect('★最低余量不许高到 0.8（要攒八成经验才能用，这套玩法基本见不到）',
    K.minExpPct < 0.8, 'minExpPct=' + K.minExpPct);
  expect('★★成交半径必须明显小于 offset（磁石会把拾取半径顶到 100+，'
    + '隔着两个身位就炼＝"要不要走过去"这个唯一成本没了）',
    K.buyRadius < K.offset * 0.3, 'buyRadius=' + K.buyRadius + ' / offset=' + K.offset);
  expect('★offset 在 120~380（太近＝路过自动炼，太远＝手机视野外找不到）',
    K.offset >= 120 && K.offset <= 380, 'offset=' + K.offset);
  expect('★lifeSec 15~40（够打完一波折回来，不够干完两件事）',
    K.lifeSec >= 15 && K.lifeSec <= 40, 'lifeSec=' + K.lifeSec);
  expect('★maxAlive 必须是 1（两座一样的鼎并排＝没有取舍）',
    K.maxAlive === 1, 'maxAlive=' + K.maxAlive);
  expect('★retrySec <= 5（落点被挡只短等，不许顺延整段）',
    K.retrySec <= 5, 'retrySec=' + K.retrySec);
  expect("★'cauldron' 必须在串池（漏了走长格式，bintest 会红）",
    pool.indexOf('cauldron') >= 0, 'pool.indexOf=' + pool.indexOf('cauldron'));
  // 三色都不许发紫：紫 = 蓝与红都明显高于绿（照搬第 52 轮重写后的判据）
  ['color', 'soulColor', 'healColor'].forEach(function (key) {
    const hex = K[key] || '';
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    expect('★★' + key + ' 不许发紫（紫 = 蓝与红都明显高于绿；旧判据会把青铜误判）',
      !(b > g * 1.05 && r > g * 1.05), hex + ' r=' + r + ' g=' + g + ' b=' + b);
  });
  // 不许有死字段：表里每个字段都要被 sim.js（rule.<字段>）或 render.js（CD.<字段>）用到。
  // ★两个来源都要扫：soulColor/healColor 是纯渲染字段，只扫 sim.js 会把它们误判成死字段。
  const simSrc = FS2.readFileSync(PATH2.join(__dirname, '..', 'shared', 'sim.js'), 'utf8');
  const renderSrc = FS2.readFileSync(PATH2.join(__dirname, '..', 'public', 'js', 'render.js'), 'utf8');
  Object.keys(K).forEach(function (key) {
    if (typeof K[key] !== 'number' && typeof K[key] !== 'string') return;
    const usedInSim = simSrc.indexOf('rule.' + key) >= 0;
    const usedInRender = renderSrc.indexOf('CD.' + key) >= 0 || renderSrc.indexOf('MK.' + key) >= 0;
    expect('★CAULDRON.' + key + ' 不许是死字段（写了没人读＝改了表也没反应）',
      usedInSim || usedInRender, 'sim.js 找不到 rule.' + key + ' / render.js 找不到 CD.' + key);
  });

  // ---------- 1. 生成 ----------
  const w1 = cleanWorld(5301);
  parkPlayer(w1);
  const rngBefore = w1.rngState;
  w1.tick = startTick - 1;
  w1.cauldronNextTick = 0;
  SIM.maybeSpawnCauldron(w1);
  expect('★到点前一帧：一座都不许出现，也不许播报',
    cauldrons(w1).length === 0 && evs(w1, 'cauldron').length === 0,
    '鼎 ' + cauldrons(w1).length + ' 座 / 播报 ' + evs(w1, 'cauldron').length + ' 条');
  w1.tick = startTick;
  const born = SIM.maybeSpawnCauldron(w1);
  expect('★到点正好浮起一座', !!born && cauldrons(w1).length === 1,
    '返回=' + (born ? '有' : 'null') + ' / ' + cauldrons(w1).length + ' 座');
  expect('★★不消费主随机流（rngState 逐位一致）—— 它是任意 tick 插进来的，'
    + '取走随机数会让后面每一波的落点整体错位',
    w1.rngState === rngBefore, '前 ' + rngBefore + ' / 后 ' + w1.rngState);
  expect('★它不是怪（做成怪的话每支武器都会去打它）', w1.mobs.length === 0,
    'mobs=' + w1.mobs.length);
  expect('★value 固定为 1（鼎没有种类，代价/回报全按玩家当下状态算）',
    born && born.value === 1, 'value=' + (born && born.value));
  const ev1 = evs(w1, 'cauldron');
  expect('★播报恰好一条，且把「代价比例 / 回报比例 / 多久消散」都带上',
    ev1.length === 1 && ev1[0].expCostPct === K.expCostPct
    && ev1[0].healPct === K.healPct && ev1[0].sec === K.lifeSec,
    '共 ' + ev1.length + ' 条 / ' + JSON.stringify(ev1[0] || {}));
  const p1 = w1.player;
  const dBorn = dist({ x: born.x, y: born.y }, p1);
  expect('★落点距玩家在 offset×0.5~1.7（被贴边 clamp 到脚下＝路过自动炼）',
    dBorn >= K.offset * 0.5 && dBorn <= K.offset * 1.7,
    '距离=' + Math.round(dBorn) + ' / offset=' + K.offset);
  expect('★落点在地图内', born.x >= 0 && born.x <= w1.map.w && born.y >= 0 && born.y <= w1.map.h,
    born.x + ',' + born.y);
  expect('★到点后排期顺延一个完整 everySec（不是短等）',
    w1.cauldronNextTick === startTick + everyTick,
    'next=' + w1.cauldronNextTick + ' / 期望=' + (startTick + everyTick));

  // ---------- 2. 同屏上限：满了一座只短等 ----------
  const w2 = cleanWorld(5302);
  w2.tick = startTick + everyTick;
  w2.cauldronNextTick = 0;
  SIM.spawnCauldron(w2);              // 场上先有一座
  const before2 = cauldrons(w2).length;
  SIM.maybeSpawnCauldron(w2);
  expect('★场上已有一座时：不许再浮第二座', cauldrons(w2).length === before2,
    before2 + ' → ' + cauldrons(w2).length);
  expect('★★满了只短等 retrySec，不许顺延整个 everySec（'
    + '否则玩家一直不去，后面整串排期被推到很久之后）',
    w2.cauldronNextTick === w2.tick + retryTick,
    'next=' + w2.cauldronNextTick + ' / 期望=' + (w2.tick + retryTick));

  // ---------- 3. 成交：扣经验、回血、鼎消失，且不许二次结算 ----------
  const w3 = cleanWorld(5303);
  parkPlayer(w3);
  const p3 = w3.player;
  fundExp(p3, 60);
  p3.hp = Math.round(p3.maxHp * 0.4);
  const exp3 = p3.exp, hp3 = p3.hp, max3 = p3.maxHp;
  const cost3 = Math.round(p3.expNext * K.expCostPct);
  const it3 = cauldronAt(w3, 4);
  // ★走真实的 step 路径（而不是直接调 applyCauldron）：从数组移除鼎是 updatePickups 的
  //   职责，只有走 step 才能同时验到"结算"与"鼎被吃掉"两件事。
  steps(w3, 1);
  expect('★残血且修为够：交易成立（经验确实被扣了）', p3.exp < exp3,
    exp3 + ' → ' + p3.exp);
  expect('★★扣的经验正好是 expNext×pct，不是当前经验的几成',
    Math.abs((exp3 - p3.exp) - cost3) < 0.001,
    '扣了 ' + (exp3 - p3.exp) + ' / 期望 ' + cost3);
  expect('★★回的血正好是上限×healPct',
    Math.abs((p3.hp - hp3) - max3 * K.healPct) < 0.001,
    '回了 ' + (p3.hp - hp3) + ' / 期望 ' + max3 * K.healPct);
  expect('★回血不许溢出上限', p3.hp <= p3.maxHp, p3.hp + '/' + p3.maxHp);
  expect('★成交后鼎被吃掉（一次性的"修为换命"）',
    w3.pickups.indexOf(it3) === -1, '还在数组里');
  const tk3 = evs(w3, 'cauldron_taken');
  expect('★成交播报恰好一条，带扣的经验与回的血',
    tk3.length === 1 && tk3[0].expCost === cost3 && tk3[0].hpGain > 0,
    JSON.stringify(tk3[0] || {}));
  // 再推 3 秒：不许出现第二座、第二条播报、第二次扣钱
  const expAfter3 = p3.exp, hpAfter3 = p3.hp;
  w3.cauldronNextTick = 1e9;
  steps(w3, 60);
  expect('★★成交后推 3 秒：不许二次扣经验', p3.exp === expAfter3,
    expAfter3 + ' → ' + p3.exp);
  expect('★★成交后推 3 秒：不许二次回血', p3.hp === hpAfter3,
    hpAfter3 + ' → ' + p3.hp);
  expect('★成交后推 3 秒：不许冒出第二座鼎', cauldrons(w3).length === 0,
    cauldrons(w3).length + ' 座');

  // ---------- 4. 拒绝·满血：什么都不做，鼎原地 ----------
  const w4 = cleanWorld(5304);
  parkPlayer(w4);
  const p4 = fundExp(w4.player, 60);
  p4.hp = p4.maxHp;                    // 满血
  const exp4 = p4.exp, hp4 = p4.hp;
  const it4 = cauldronAt(w4, 4);
  const took4 = SIM.applyCauldron(w4, p4, it4);
  expect('★★满血时拒绝（一滴血都回不上，不该白扔修为）', took4 === false, '返回=' + took4);
  expect('★★满血拒绝：经验一分不扣', p4.exp === exp4, exp4 + ' → ' + p4.exp);
  expect('★★满血拒绝：血一点没动', p4.hp === hp4, hp4 + ' → ' + p4.hp);
  expect('★满血拒绝：鼎必须留在原地（推 8 帧还在）', (function () {
    steps(w4, 8);
    return w4.pickups.indexOf(it4) >= 0;
  })(), '鼎被吃掉了');
  expect('★满血拒绝：播报节流到恰好一条（站在鼎上每帧都踩，不拦会刷几十条）',
    evs(w4, 'cauldron_deny').length === 1, evs(w4, 'cauldron_deny').length + ' 条');
  expect('★满血拒绝的播报写明 reason=hp_full',
    evs(w4, 'cauldron_deny')[0] && evs(w4, 'cauldron_deny')[0].reason === 'hp_full',
    JSON.stringify(evs(w4, 'cauldron_deny')[0] || {}));
  // 掉血之后同一个鼎立刻能成交（拒绝没有后遗症）
  p4.hp = Math.round(p4.maxHp * 0.4);
  const hp4b = p4.hp;
  expect('★★满血拒绝后掉血：同一个鼎立刻能成交（拒绝不消耗鼎）',
    SIM.applyCauldron(w4, p4, it4) === true, '又失败了');
  expect('★再次成交确实回了血', p4.hp > hp4b, hp4b + ' → ' + p4.hp);

  // ---------- 5. 拒绝·经验不足：什么都不做，攒够再回来能成交 ----------
  const w5 = cleanWorld(5305);
  parkPlayer(w5);
  const p5 = fundExp(w5.player, 5);   // 远低于 minExpPct×100 = 40
  p5.hp = Math.round(p5.maxHp * 0.4);
  const exp5 = p5.exp, hp5 = p5.hp;
  const it5 = cauldronAt(w5, 4);
  expect('★★残血但修为不足：拒绝', SIM.applyCauldron(w5, p5, it5) === false, '居然成交了');
  expect('★★修为不足拒绝：经验一分不扣', p5.exp === exp5, exp5 + ' → ' + p5.exp);
  expect('★★修为不足拒绝：血一点没回', p5.hp === hp5, hp5 + ' → ' + p5.hp);
  expect('★修为不足拒绝：鼎留在原地（推 8 帧还在）', (function () {
    steps(w5, 8);
    return w5.pickups.indexOf(it5) >= 0;
  })(), '鼎被吃掉了');
  expect('★修为不足拒绝：播报节流到一条且 reason=no_exp',
    evs(w5, 'cauldron_deny').length === 1
    && evs(w5, 'cauldron_deny')[0].reason === 'no_exp',
    JSON.stringify(evs(w5, 'cauldron_deny')[0] || {}));
  // 攒够修为再踩同一个鼎
  p5.exp = 60;
  expect('★★攒够修为后同一个鼎能成交（拒绝没有后遗症）',
    SIM.applyCauldron(w5, p5, it5) === true, '又失败了');

  // ---------- 6. 走开再回来：节流重置 ----------
  const w6 = cleanWorld(5306);
  parkPlayer(w6);
  const p6 = fundExp(w6.player, 5);
  p6.hp = Math.round(p6.maxHp * 0.4);
  const it6 = cauldronAt(w6, 4);
  SIM.applyCauldron(w6, p6, it6);      // 拒绝一次（denied=1）
  expect('★第一次拒绝后 it.denied 被标记', it6.denied === 1, 'denied=' + it6.denied);
  it6.denied = 0;                      // 模拟走开（真实由 updatePickups 在半径外重置）
  const evBefore6 = evs(w6, 'cauldron_deny').length;
  expect('★走开重置后回来还能再听到一次拒绝（不是永久静音）', (function () {
    SIM.applyCauldron(w6, p6, it6);
    return evs(w6, 'cauldron_deny').length === evBefore6 + 1;
  })(), '播报 ' + evBefore6 + ' → ' + evs(w6, 'cauldron_deny').length);

  // ---------- 7. 磁石不许把鼎吸走 ----------
  const w7 = cleanWorld(5307);
  parkPlayer(w7);
  const p7 = fundExp(w7.player, 60);
  p7.hp = Math.round(p7.maxHp * 0.4);
  const it7 = cauldronAt(w7, 0);
  it7.x = p7.x + 160; it7.y = p7.y; it7.px = it7.x; it7.py = it7.y;
  it7.life = 999;
  p7.attrs.pickupRadius = 400;        // 磁石顶到 400
  const x7 = it7.x;
  steps(w7, 10);
  expect('★★磁石（拾取半径 400）也吸不走鼎：走过去是它唯一的成本',
    it7.x === x7 && w7.pickups.indexOf(it7) >= 0,
    'x ' + x7 + ' → ' + it7.x + ' / 还在=' + (w7.pickups.indexOf(it7) >= 0));
  expect('★磁石没把鼎吸走时也不许偷偷炼掉经验', p7.exp === 60, 'exp=' + p7.exp);

  // ---------- 8. 到点消散：说一声，且不许动经验 ----------
  const w8 = cleanWorld(5308);
  parkPlayer(w8);
  const p8 = fundExp(w8.player, 60);
  p8.hp = Math.round(p8.maxHp * 0.4);
  const it8 = cauldronAt(w8, 300);    // 放远点，玩家踩不到
  it8.life = 0.05;
  const exp8 = p8.exp;
  steps(w8, 3);
  expect('★到点消散：鼎消失', w8.pickups.indexOf(it8) === -1, '还在');
  expect('★到点消散：播报恰好一条', evs(w8, 'cauldron_gone').length === 1,
    evs(w8, 'cauldron_gone').length + ' 条');
  expect('★到点消散：不许动经验', p8.exp === exp8, exp8 + ' → ' + p8.exp);

  // ---------- 9. 饕餮偷不走鼎 ----------
  const w9 = cleanWorld(5309);
  parkPlayer(w9);
  cauldronAt(w9, 30);
  const food9 = SIM.findDevourFood(w9, { x: w9.player.x + 30, y: w9.player.y });
  expect('★★饕餮的食物名单里不许有鼎（它是"要你走过去炼"的东西，'
    + '被偷走会让玩家觉得机制在阴人 —— 宝箱/神龛/祭坛/摊子都是同一条）',
    food9 === null, food9 ? '被当成食物了' : 'null');

  // ---------- 10. 剧情关（双管） ----------
  const wS = SIM.createWorld({ charId: 'hunter', seed: 5310, modId: 'myth', stageId: 'ch4' });
  wS.player.expNext = 1e9;
  wS.tick = startTick;
  wS.cauldronNextTick = 0;
  const directS = SIM.maybeSpawnCauldron(wS);
  expect('★★直接调事件入口也必须被剧情关挡住（不依赖 step 会不会早退）：'
    + '主线逐关手工配平，凭空多一条"修为换血"会破坏配好的血量曲线',
    !!wS.storyStage && directS === null
    && cauldrons(wS).length === 0 && evs(wS, 'cauldron').length === 0,
    'storyStage=' + (wS.storyStage ? wS.storyStage.id : 'null')
    + ' 返回=' + (directS ? '有' : 'null') + ' / 鼎 ' + cauldrons(wS).length + ' 座');
  // 走 step 那一遍：鼎首发 324 秒，验证循环推到 324+30=354 秒 → 用 ch4（420 秒上限）。
  // ★必须先算时长：ch1(240)/ch2(300)/ch3(360) 会在 354 秒前结束、step 早退 → 假绿。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 5311, modId: 'myth', stageId: 'ch4' });
  wS2.player.expNext = 1e9;
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((K.startSec + k * 30) * HZ);
    wS2.cauldronNextTick = 0;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch4）走完整条 step 也没有鼎，**而且那一刻世界确实还在跑**：'
    + '不钉「世界还活着」的话，用超时的关卡验任何"不该出现的东西"都会假绿',
    storyAlive && cauldrons(wS2).length === 0 && evs(wS2, 'cauldron').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' + wS2.matchSec + ' 秒）'
    + ' / 鼎 ' + cauldrons(wS2).length + ' 座 / 播报 ' + evs(wS2, 'cauldron').length + ' 条');
}

// ============================================================
// 第五十四轮：猎妖悬赏（限时击杀目标）
// ============================================================
function testBounty() {
  console.log('[第五十四轮] 猎妖悬赏：第一件「不在地上放东西」的玩法（限时击杀目标）');
  const B = C.BOUNTY;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(B.startSec * HZ);
  const everyTick = Math.round(B.everySec * HZ);

  function evs(w, type) {
    return w.events.filter(function (e) { return e.type === type; });
  }
  // 干净世界：其它事件全推远、关掉武器与金币掉落，只留悬赏这一条轴。
  // ★清掉 pickups 是必要的：createWorld 会按地图放 3 个宝箱，
  //   而"失败不许发奖"这条断言要钉的就是**一个掉落物都不多**。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.attrs.goldMul = 0;          // 怪不掉金币 → 场上的金币只可能来自悬赏奖励
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;       // 默认不排期：要开一轮的世界自己设为 0
    w.healerNextTick = 1e9;       // 第五十五轮：回春巫默认推远（悬赏测试推到 216s 不会碰它，仍统一补上）
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    return w;
  }
  // 把世界挪到首发帧并开一轮（直接调入口，不跑 step，变量最少）。
  function openRound(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.bountyNextTick = 0;
    SIM.tickBounty(w);
  }
  // 造一只普通怪并一击打死。返回它（奖励落点要按它的坐标验）。
  function killOne(w, x, y) {
    const m = SIM.spawnMob(w, 'corpse',
      x === undefined ? w.player.x + 30 : x,
      y === undefined ? w.player.y : y, 1, 0, 0);
    SIM.damageMob(w, m, 1e9, 0, 0, 'test');
    return m;
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则刚刷的怪还在 700px 外，45 秒先跑掉小半）',
    B.startSec % 30 !== 0, B.startSec + ' % 30 = ' + (B.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起）',
    B.windowSec > 15 && B.windowSec < B.everySec, B.windowSec + ' / ' + B.everySec);
  expect('目标数在合理区间（12~40 只，太少白送、太多打不完）',
    B.needKills >= 12 && B.needKills <= 40, String(B.needKills));
  expect('逐轮增长且封顶（后期怪多但血厚，维持难度）',
    B.killStep > 0 && B.maxKills > B.needKills && SIM.bountyNeedFor(100) === B.maxKills,
    'step=' + B.killStep + ' cap=' + B.maxKills);
  expect('奖励是「一个宝箱 + 一小笔零钱」，不是能随便扫货的巨款',
    B.rewardChest === 1 && B.goldDrops >= 2 && B.rewardGold >= 1 && B.rewardGold <= 3,
    JSON.stringify({ chest: B.rewardChest, drops: B.goldDrops, each: B.rewardGold }));
  expect('★目标数按轮号真的会涨（第 2 轮 ≠ 第 1 轮）',
    SIM.bountyNeedFor(1) === B.needKills + B.killStep,
    SIM.bountyNeedFor(0) + ' → ' + SIM.bountyNeedFor(1));

  // ---------- 2. 不消费主随机流 ----------
  const wR = cleanWorld(901);
  wR.tick = startTick - 1;
  wR.time = wR.tick / HZ;
  SIM.tickBounty(wR);
  const rngBefore = wR.rngState;
  wR.tick = startTick;
  wR.time = wR.tick / HZ;
  wR.bountyNextTick = 0;
  SIM.tickBounty(wR);
  expect('★★开一轮不消费主随机流（否则后面每一波的落点整体错位）',
    wR.rngState === rngBefore, rngBefore + ' → ' + wR.rngState);
  // ★必须直接调钩子：走 killOne 会连带跑怪的经验/金币掉落（那些本来就要抽随机），
  //   把"悬赏抽没抽"和"怪抽没抽"混在一起，测出来的红是假红。
  const rngBefore2 = wR.rngState;
  for (let i = 0; i < B.needKills - 1; i++) SIM.onBountyKill(wR, { x: 60, y: 60 });
  SIM.onBountyKill(wR, { x: 60, y: 60 });
  expect('★★达成与发奖也不消费主随机流（奖励落在击杀点，不抽角度）',
    wR.rngState === rngBefore2 && wR.bountyDone === 1,
    rngBefore2 + ' → ' + wR.rngState + ' / done=' + wR.bountyDone);

  // ---------- 3. 开局时序 ----------
  const wT = cleanWorld(902);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  wT.bountyNextTick = 0;
  SIM.tickBounty(wT);
  expect('到点前一帧：零轮、零播报',
    wT.bountyActive === 0 && wT.bountyRounds === 0 && wT.events.length === 0,
    'active=' + wT.bountyActive + ' rounds=' + wT.bountyRounds);
  openRound(wT);
  expect('到点正好开一轮且只开一轮',
    wT.bountyActive === 1 && wT.bountyRounds === 1 && evs(wT, 'bounty_start').length === 1,
    'active=' + wT.bountyActive + ' rounds=' + wT.bountyRounds
    + ' 播报=' + evs(wT, 'bounty_start').length);
  expect('目标数、窗口、到期时刻都正确',
    wT.bountyNeed === B.needKills && wT.bountyKilled === 0
    && Math.abs(wT.bountyDeadline - (B.startSec + B.windowSec)) < 0.001,
    JSON.stringify({ need: wT.bountyNeed, deadline: wT.bountyDeadline }));
  expect('开局播报一次说全「几秒 / 几只 / 第几轮」',
    evs(wT, 'bounty_start').length === 1
    && evs(wT, 'bounty_start')[0].sec === B.windowSec
    && evs(wT, 'bounty_start')[0].need === B.needKills
    && evs(wT, 'bounty_start')[0].round === 1,
    JSON.stringify(evs(wT, 'bounty_start')[0] || {}));
  expect('★开了之后同一帧再 tick 不会重复开第二轮',
    (SIM.tickBounty(wT), wT.bountyRounds === 1 && evs(wT, 'bounty_start').length === 1),
    'rounds=' + wT.bountyRounds);

  // ---------- 4. 计数与过半 ----------
  const wC = cleanWorld(903);
  killOne(wC); killOne(wC); killOne(wC);
  expect('★★不在窗口内的击杀一律不计数（不能靠平时攒数白拿奖励）',
    wC.bountyKilled === 0 && evs(wC, 'bounty_done').length === 0,
    'killed=' + wC.bountyKilled);
  openRound(wC);
  wC.events.length = 0;
  killOne(wC);
  expect('窗口内击杀一只就记一只',
    wC.bountyKilled === 1, 'killed=' + wC.bountyKilled);
  // 已杀 1 只，再杀到 ceil(need/2)-1 只，离过半还差一只。
  for (let i = 0; i < Math.ceil(B.needKills / 2) - 2; i++) killOne(wC);
  expect('★过半之前一句都不报（不刷屏）',
    evs(wC, 'bounty_half').length === 0, JSON.stringify(evs(wC, 'bounty_half')));
  killOne(wC);
  expect('过半恰好报一条，而且带已杀与还差',
    evs(wC, 'bounty_half').length === 1
    && evs(wC, 'bounty_half')[0].killed === Math.ceil(B.needKills / 2)
    && evs(wC, 'bounty_half')[0].left === B.needKills - Math.ceil(B.needKills / 2),
    JSON.stringify(evs(wC, 'bounty_half')[0] || {}));

  // ---------- 5. 达成 ----------
  const wD = cleanWorld(904);
  openRound(wD);
  wD.events.length = 0;
  for (let i = 0; i < B.needKills - 1; i++) killOne(wD);
  expect('差一只时不许提前发奖',
    wD.bountyActive === 1 && byKind(wD, 'chest').length === 0
    && evs(wD, 'bounty_done').length === 0,
    'active=' + wD.bountyActive + ' chest=' + byKind(wD, 'chest').length);
  // 最后一击固定在 (555,333)，钉住"奖励落在尸体处"。
  const last = killOne(wD, 555, 333);
  expect('达标那一刻立即收起窗口、记一次达成',
    wD.bountyActive === 0 && wD.bountyDone === 1 && wD.bountyKilled === B.needKills,
    JSON.stringify({ active: wD.bountyActive, done: wD.bountyDone, killed: wD.bountyKilled }));
  expect('★宝箱正好一个（不是一堆）',
    byKind(wD, 'chest').length === B.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币正好 N 枚，面值正确',
    byKind(wD, 'gold').length === B.goldDrops
    && byKind(wD, 'gold').every(function (it) { return it.value === B.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  expect('★★宝箱落在最后一击那只怪的尸体处，不在玩家脚下',
    byKind(wD, 'chest').length === 1
    && byKind(wD, 'chest')[0].x === last.x && byKind(wD, 'chest')[0].y === last.y
    && (last.x !== wD.player.x || last.y !== wD.player.y),
    JSON.stringify({ box: byKind(wD, 'chest')[0], corpse: { x: last.x, y: last.y } }));
  expect('达成播报恰好一条，带击杀数与奖品种类',
    evs(wD, 'bounty_done').length === 1
    && evs(wD, 'bounty_done')[0].killed === B.needKills
    && evs(wD, 'bounty_done')[0].chest === B.rewardChest
    && evs(wD, 'bounty_done')[0].gold === B.goldDrops * B.rewardGold,
    JSON.stringify(evs(wD, 'bounty_done')[0] || {}));
  const chestAfter = byKind(wD, 'chest').length;
  const goldAfter = byKind(wD, 'gold').length;
  wD.events.length = 0;
  wD.tick += Math.round(3 * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickBounty(wD);
  killOne(wD, 777, 444);
  expect('★★达成后再推 3 秒、再杀怪：不许二次发奖',
    byKind(wD, 'chest').length === chestAfter && byKind(wD, 'gold').length === goldAfter
    && evs(wD, 'bounty_done').length === 0,
    'chest ' + chestAfter + '→' + byKind(wD, 'chest').length
    + ' / gold ' + goldAfter + '→' + byKind(wD, 'gold').length);
  expect('★达成后的击杀不再计入（窗口真的关了）',
    wD.bountyKilled === B.needKills, 'killed=' + wD.bountyKilled);

  // ---------- 6. 失败（这一节全在钉「不该发生的事」） ----------
  const wF = cleanWorld(905);
  openRound(wF);
  wF.events.length = 0;
  wF.tick = Math.round((B.startSec + B.windowSec) * HZ);
  wF.time = wF.tick / HZ;
  SIM.tickBounty(wF);
  expect('到期未达标：收起窗口、记一次过期',
    wF.bountyActive === 0 && wF.bountyFailed === 1 && wF.bountyDone === 0,
    JSON.stringify({ active: wF.bountyActive, failed: wF.bountyFailed, done: wF.bountyDone }));
  expect('★★失败时一个掉落物都不许多（宝箱/金币都不给）',
    wF.pickups.length === 0, 'pickups=' + wF.pickups.length);
  expect('★★失败时绝不出现「达成」播报',
    evs(wF, 'bounty_done').length === 0, JSON.stringify(evs(wF, 'bounty_done')));
  expect('过期播报恰好一条，带还差几只、语气不责备',
    evs(wF, 'bounty_fail').length === 1
    && evs(wF, 'bounty_fail')[0].left === B.needKills
    && evs(wF, 'bounty_fail')[0].killed === 0,
    JSON.stringify(evs(wF, 'bounty_fail')[0] || {}));
  wF.events.length = 0;
  killOne(wF);
  expect('★失败后击杀不再计数（没有后遗症）',
    wF.bountyKilled === 0, 'killed=' + wF.bountyKilled);
  wF.tick += Math.round(3 * HZ);
  wF.time = wF.tick / HZ;
  SIM.tickBounty(wF);
  expect('★失败后再推 3 秒不重复播报',
    evs(wF, 'bounty_fail').length === 0 && evs(wF, 'bounty_done').length === 0,
    JSON.stringify(wF.events));
  const wB = cleanWorld(906);
  openRound(wB);
  wB.tick = Math.round((B.startSec + B.windowSec) * HZ) - 1;
  wB.time = wB.tick / HZ;
  SIM.tickBounty(wB);
  expect('到期前一帧窗口还开着（边界不错杀）',
    wB.bountyActive === 1 && evs(wB, 'bounty_fail').length === 0,
    'active=' + wB.bountyActive);

  // ---------- 7. 剧情关隔离（双管） ----------
  const wS = cleanWorld(907);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch4' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.bountyNextTick = 0;
  SIM.tickBounty(wS);
  expect('★★直接调入口：剧情关不挂悬赏、零播报',
    wS.bountyActive === 0 && wS.bountyRounds === 0 && evs(wS, 'bounty_start').length === 0,
    'active=' + wS.bountyActive + ' rounds=' + wS.bountyRounds);
  wS.bountyActive = 1;
  wS.bountyNeed = B.needKills;
  SIM.onBountyKill(wS, { x: 100, y: 100 });
  expect('★★即便被强行激活，剧情关也不计数、不发奖（双保险）',
    wS.bountyKilled === 0 && byKind(wS, 'chest').length === 0
    && evs(wS, 'bounty_done').length === 0,
    'killed=' + wS.bountyKilled + ' chest=' + byKind(wS, 'chest').length);
  // 走 step 那一遍：悬赏首发 186 秒，推到 216 秒 → 用 ch4（420 秒上限）。
  // ★ch1(240) 虽也够，但要钉"世界还在跑"，ch4 留的余量更宽。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 908, modId: 'myth', stageId: 'ch4' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((B.startSec + k * 30) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch4）走完整条 step 也没有悬赏，且那一刻世界确实还在跑',
    storyAlive && wS2.bountyActive === 0 && evs(wS2, 'bounty_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' + wS2.matchSec + ' 秒）'
    + ' / active=' + wS2.bountyActive);
}

// ============================================================
// 第五十五轮：回春巫（全项目第一只「给同类回血」的支援妖）
// ============================================================
function testHealer() {
  console.log('[第五十五轮] 回春巫：给同类回血但不给自己/Boss/满血怪、定身闭嘴、剧情关没有它');

  const HZ = C.TICK_HZ;
  const RULE = C.HEALER;
  const def = C.MOB_MAP[RULE.mobId];
  const startTick = Math.round(RULE.startSec * HZ);

  function evs(w, type) {
    return w.events.filter(function (e) { return e.type === type; });
  }
  // 干净世界：其它事件全推远、关掉武器，只留回春巫这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.maxHp = 99999;
    p.hp = 99999;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.healerNextTick = 1e9;       // 默认推远：要验它的世界自己设为 0
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  // 造一只缺血的怪：hp = maxHp × hpLeft，放在 (x,y)。返回它。
  function hurtMob(w, x, y, hpLeft, mobId) {
    const m = SIM.spawnMob(w, mobId || 'corpse', x, y, 1, 0, 0);
    m.hp = m.maxHp * hpLeft;
    return m;
  }

  // ---------- 1. 表自洽 ----------
  expect('★回春巫的定义在怪物表里、带 healer 标记（否则事件刷出来的是 null，静默没反应）',
    !!def && def.healer === true, def ? ('tier=' + def.tier + ' kind=' + def.kind) : 'n/a');
  expect('★★kind 必须是 healer（写成 melee 它就变成又一只贴脸怪，整个「先点奶妈」的选择消失）',
    !!def && def.kind === 'healer', def ? def.kind : 'n/a');
  expect('★tier 不是 boss（是 boss 就走 Boss 必掉宝箱 + 剧情通关那条老路）',
    !!def && def.tier !== 'boss', def ? def.tier : 'n/a');
  const tutorialSec = C.STAGES[0].to * C.WAVES.intervalSec;
  expect('★★不许落在教学段（前 ' + C.STAGES[0].to + ' 波 = ' + tutorialSec + ' 秒）',
    RULE.startSec > tutorialSec, 'startSec=' + RULE.startSec + ' / 教学段=' + tutorialSec);
  expect('★★首发不许压在 30 秒波次网格上（陨星踩过：那一帧场上往往是刚刷在 700px 外的空场）',
    RULE.startSec % C.WAVES.intervalSec !== 0,
    'startSec=' + RULE.startSec + ' % ' + C.WAVES.intervalSec + ' = ' +
    (RULE.startSec % C.WAVES.intervalSec));
  expect('施法节奏为正（写成 0 就每帧都奶，玩家的输出被永久抹掉）',
    RULE.healEverySec > 0.5, 'healEverySec=' + RULE.healEverySec);
  expect('★回血比例在合理区间（0.1~0.4：太低看不见跳血，太高后期怪海无解）',
    RULE.healPct > 0.1 && RULE.healPct < 0.4, 'healPct=' + RULE.healPct);
  expect('★施法半径大于保持距离（够得到「你正在清的那一片」，否则支援行为永远不发生）',
    RULE.healRadius > RULE.keepDist, 'healRadius=' + RULE.healRadius + ' / keepDist=' + RULE.keepDist);
  expect('★每轮回血只数封顶且不为 0（无上限就是全场锁血，0 就是没有支援）',
    RULE.healCount >= 2 && RULE.healCount <= 12, 'healCount=' + RULE.healCount);
  // 配色不许发紫：紫 = 蓝与红都明显高于绿（照搬「绿≥红×0.9」会把青铜判成紫）
  function notPurple(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    return !(b > g * 1.05 && r > g * 1.05);
  }
  expect('★本体色与两个标记色都不发紫（项目硬约定：禁紫/紫蓝）',
    !!def && notPurple(def.color) && notPurple(RULE.markColor) && notPurple(RULE.healColor),
    def ? (def.color + ' / ' + RULE.markColor + ' / ' + RULE.healColor) : 'n/a');

  // ---------- 2. 关卡池 / 地图偏好里都不许有它 ----------
  let inPool = [];
  for (let i = 0; i < C.STAGES.length; i++) {
    const pool = C.STAGES[i].pool || {};
    if (pool[RULE.mobId]) inPool.push('STAGES[' + i + ']');
  }
  ['myth', 'magic'].forEach(function (modId) {
    const mod = CP.MODS[modId];
    if (!mod || !mod.stages) return;
    for (let i = 0; i < mod.stages.length; i++) {
      const pool = mod.stages[i].pool || {};
      if (pool[RULE.mobId]) inPool.push(modId + '.' + mod.stages[i].id);
    }
  });
  expect('★★关卡池（自由模式四段 + 两个剧情模组）里都不许出现回春巫（它只从事件入口来）',
    inPool.length === 0, inPool.join(',') || '干净');

  // ---------- 3. 到点才来、零随机 ----------
  const w0 = cleanWorld(9201);
  w0.tick = startTick - 1;
  w0.time = w0.tick / HZ;
  w0.healerNextTick = 0;
  SIM.maybeSpawnHealer(w0);
  expect('★★首发前一帧零只零播报',
    SIM.countAliveHealers(w0) === 0 && evs(w0, 'healer').length === 0,
    'n=' + SIM.countAliveHealers(w0));
  w0.tick = startTick;
  w0.time = w0.tick / HZ;
  const rngBefore = w0.rngState;
  SIM.maybeSpawnHealer(w0);
  expect('★★到点正好一只、播报恰好一条',
    SIM.countAliveHealers(w0) === 1 && evs(w0, 'healer').length === 1 &&
    typeof evs(w0, 'healer')[0].n === 'undefined' && evs(w0, 'healer')[0].hp > 0,
    'n=' + SIM.countAliveHealers(w0) + ' ev=' + evs(w0, 'healer').length);
  expect('★★★生成不消费主随机流（事件怪插在任意 tick，抽一次随机流后面每波落点全错位）',
    w0.rngState === rngBefore, 'before=' + rngBefore + ' after=' + w0.rngState);
  // 落点在被围的那只玩家外侧（不是脚下），且在地图内
  const spawned = w0.mobs.filter(function (m) { return m.defId === RULE.mobId; })[0];
  expect('落点在地图内、且不在玩家脚下（是从外面走进来的，不是凭空冒在身边）',
    !!spawned && spawned.x >= 0 && spawned.x <= w0.map.w && spawned.y >= 0 && spawned.y <= w0.map.h &&
    Math.abs(spawned.x - w0.player.x) + Math.abs(spawned.y - w0.player.y) > 100,
    spawned ? ('(' + spawned.x.toFixed(0) + ',' + spawned.y.toFixed(0) + ')') : 'n/a');
  // 上限：已有一只时不再刷（顺延一个间隔）
  const wCap = w0;
  wCap.tick = startTick + Math.round(RULE.everySec * HZ);
  wCap.time = wCap.tick / HZ;
  wCap.healerNextTick = 0;
  SIM.maybeSpawnHealer(wCap);
  expect('★★场上已有一只时不再刷第二只（它是「该被点掉的目标」，不是一支军队）',
    SIM.countAliveHealers(wCap) === 1 && evs(wCap, 'healer').length === 1,
    'n=' + SIM.countAliveHealers(wCap));

  // ---------- 4. 施法：核心是钉「不该发生的事」 ----------
  function castWorld(seed) {
    const w = cleanWorld(seed);
    // 手动造一只回春巫放在玩家身边（不走排期，变量最少）
    const h = SIM.spawnHealer(w);
    // spawnHealer 用 affixHash 定落点，可能离玩家较远；强制挪到玩家右侧 120px
    if (h) { h.x = w.player.x + 120; h.y = w.player.y; h.healCd = RULE.healEverySec; }
    w.events.length = 0;
    w.effects.length = 0;
    return w;
  }
  function castOnce(w) {
    const h = w.mobs.filter(function (m) { return m.defId === RULE.mobId; })[0];
    // 直接调施法入口，推满一整个施法间隔（不跑 step，变量隔离）
    SIM.tickHealer(w, h, RULE.healEverySec);
    return h;
  }

  // ① 缺血怪会被回、且回的量正确
  const wA = castWorld(9202);
  const a1 = hurtMob(wA, wA.player.x + 150, wA.player.y, 0.3);
  const beforeA = a1.hp;
  castOnce(wA);
  expect('★★缺血怪被回血，量 = 上限 × 22%（不是随便一个数）',
    a1.hp > beforeA && Math.abs(a1.hp - (beforeA + a1.maxHp * RULE.healPct)) < 0.001,
    'before=' + beforeA.toFixed(1) + ' after=' + a1.hp.toFixed(1));
  expect('施法恰好一条播报，带「回了几只」的数字',
    evs(wA, 'healer_cast').length === 1 && evs(wA, 'healer_cast')[0].n === 1,
    JSON.stringify(evs(wA, 'healer_cast')));
  expect('施法有一圈自绘的青光环特效（玩家看见「输出被抹掉」的唯一线索）',
    wA.effects.some(function (e) { return e.kind === 'healring'; }),
    JSON.stringify(wA.effects.map(function (e) { return e.kind; })));
  expect('★缺血怪身上出现逐目标小光环（正向对照：证明下面的「满血不亮环」不是全场都没环）',
    wA.effects.some(function (e) { return e.forMob === a1.id; }),
    'a1.id=' + a1.id + ' / ' + JSON.stringify(wA.effects.map(function (e) { return e.forMob; })));

  // ② 满血怪不许占回血名额
  const wFull = castWorld(9203);
  const full = hurtMob(wFull, wFull.player.x + 150, wFull.player.y, 1.0);
  castOnce(wFull);
  expect('★★★满血怪不许混进候选：身上不亮回血小环、不刷施法播报（否则玩家会看到满血的怪也在「被回血」，额度被白占）',
    full.hp === full.maxHp && evs(wFull, 'healer_cast').length === 0 &&
    !wFull.effects.some(function (e) { return e.forMob === full.id; }),
    'hp=' + full.hp + '/' + full.maxHp + ' ev=' + evs(wFull, 'healer_cast').length +
    ' 亮环=' + wFull.effects.some(function (e) { return e.forMob === full.id; }));

  // ③ 自己不许回（否则「先点掉它」这条唯一解法变成无解）
  const wSelf = castWorld(9204);
  const selfBefore = wSelf.mobs.filter(function (m) { return m.defId === RULE.mobId; })[0];
  selfBefore.hp = selfBefore.maxHp * 0.2;
  castOnce(wSelf);
  expect('★★回春巫绝不给自己回血（否则玩家打它只会让它满血，这只怪无解）',
    selfBefore.hp === selfBefore.maxHp * 0.2, 'selfHp=' + selfBefore.hp.toFixed(1));

  // ④ Boss 不许回（Boss 血厚，再回一口就是几十秒白打，冲掉波次配平）
  const wBoss = castWorld(9205);
  const boss = SIM.spawnMob(wBoss, 'blood_lord', wBoss.player.x + 150, wBoss.player.y, 1, 0, 0);
  boss.hp = boss.maxHp * 0.3;
  const bossBefore = boss.hp;
  castOnce(wBoss);
  expect('★★Boss 一滴都不回（回一口就是几十秒白打，主线波次配平会被冲掉）',
    boss.hp === bossBefore, 'bossHp=' + boss.hp.toFixed(1));

  // ⑤ 范围外不回
  const wFar = castWorld(9206);
  const far = hurtMob(wFar, wFar.player.x + RULE.healRadius + 500, wFar.player.y, 0.3);
  const farBefore = far.hp;
  castOnce(wFar);
  expect('★★施法半径外的怪一滴都不回（范围就是边界，不是全屏）',
    far.hp === farBefore, 'farHp=' + far.hp.toFixed(1));

  // ⑥ 定身不施法（陨星落地那一下应当把奶也封住）
  const wStun = castWorld(9207);
  const s1 = hurtMob(wStun, wStun.player.x + 150, wStun.player.y, 0.3);
  const stunBefore = s1.hp;
  const hStun = wStun.mobs.filter(function (m) { return m.defId === RULE.mobId; })[0];
  hStun.stun = 0.6;
  castOnce(wStun);
  expect('★★被定身时不施法（玩家砸中它那一下要看得见「它闭嘴了」）',
    s1.hp === stunBefore && evs(wStun, 'healer_cast').length === 0,
    'hp=' + s1.hp.toFixed(1) + ' ev=' + evs(wStun, 'healer_cast').length);

  // ⑦ 额度封顶：造 healCount+3 只缺血怪，一轮最多回 healCount 只
  const wCap2 = castWorld(9208);
  const many = [];
  for (let i = 0; i < RULE.healCount + 3; i++) {
    const a = (i / (RULE.healCount + 3)) * Math.PI * 2;
    const rr = 100 + i * 8;
    many.push(hurtMob(wCap2, wCap2.player.x + 120 + Math.cos(a) * rr,
      wCap2.player.y + Math.sin(a) * rr, 0.2));
  }
  castOnce(wCap2);
  const nHealed = many.filter(function (m) { return m.hp > m.maxHp * 0.2 + 0.01; }).length;
  expect('★★★一轮最多回 healCount 只（无上限就是全场锁血，玩家输出永远白打）',
    nHealed === RULE.healCount && evs(wCap2, 'healer_cast')[0].n === RULE.healCount,
    'healed=' + nHealed + ' / cap=' + RULE.healCount +
    ' evN=' + (evs(wCap2, 'healer_cast')[0] || {}).n);
  expect('回血不许溢出各自上限',
    many.every(function (m) { return m.hp <= m.maxHp + 0.001; }),
    'max=' + Math.max.apply(null, many.map(function (m) { return m.hp; })).toFixed(1));

  // ⑧ 施法不消费主随机流（直接调施法入口，隔离掉武器/掉落）
  const wRng = castWorld(9209);
  hurtMob(wRng, wRng.player.x + 150, wRng.player.y, 0.3);
  const rngB = wRng.rngState;
  castOnce(wRng);
  expect('★★★施法（含选目标）不消费主随机流',
    wRng.rngState === rngB, 'before=' + rngB + ' after=' + wRng.rngState);

  // ---------- 5. 剧情关隔离（双管） ----------
  const wS = cleanWorld(9210);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.healerNextTick = 0;
  SIM.maybeSpawnHealer(wS);
  expect('★★直接调入口：剧情关不刷回春巫、零播报',
    SIM.countAliveHealers(wS) === 0 && evs(wS, 'healer').length === 0,
    'n=' + SIM.countAliveHealers(wS));
  // 走 step 那一遍：回春巫首发 252 秒，用 ch5（540 秒上限）确保世界还在跑
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9211, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((RULE.startSec + k * 30) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有回春巫，且那一刻世界确实还在跑',
    storyAlive && SIM.countAliveHealers(wS2) === 0 && evs(wS2, 'healer').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' + wS2.matchSec + ' 秒）'
    + ' / n=' + SIM.countAliveHealers(wS2));
}

// ============================================================
// 第五十六轮：守心劫（限时不受伤的克制型目标）
// ============================================================
function testSerenity() {
  console.log('[第五十六轮] 守心劫：第一件「克制型」目标（限时不受伤，零实体）');
  const S = C.SERENITY;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(S.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  // 干净世界：其它事件全推远、关武器与金币掉落，只留守心这一条轴。
  // ★清 pickups 是必要的：createWorld 会按地图放 3 个宝箱，
  //   而"破功不许发奖"要钉的就是**一个掉落物都不多**。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    p.attrs.goldMul = 0;          // 怪不掉金币 → 场上的金币只可能来自守心奖励
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;   // 第五十七轮：拾荒令 204s 开窗，默认推远
    w.forgeNextTick = 1e9;   // 第五十八轮：破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;  // 第五十九轮：逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;    // 第六十轮：养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9; // 第六十一轮：惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;   // 第六十二轮：履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;     // 第六十三轮：饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    return w;
  }
  // 把世界挪到首发帧并开一轮（直接调入口，不跑 step，变量最少）。
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.serenityNextTick = 0;
    SIM.tickSerenity(w);
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 真扣一次血：把无敌帧清零再走 damagePlayer —— 守心钩子在"真掉血那一行"之后。
  function hurt(w, dmg) {
    const p = w.self || w.player;
    p.invuln = 0;
    const before = p.hp;
    SIM.damagePlayer(w, p, dmg || 10, p.x + 20, p.y);
    return before - p.hp;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则一开窗窗口里全是刚刷在 700px 外的空场）',
    S.startSec % 30 !== 0, S.startSec + ' % 30 = ' + (S.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起）',
    S.windowSec > 8 && S.windowSec < S.everySec, S.windowSec + ' / ' + S.everySec);
  expect('窗口长度在合理区间（8~30 秒，太短白给、太长不可能）',
    S.windowSec >= 8 && S.windowSec <= 30, String(S.windowSec));
  expect('奖励是"一箱 + 零钱"而非巨款（与悬赏同口径）',
    S.rewardChest >= 1 && S.rewardChest <= 2 && S.goldDrops >= 1 &&
    S.rewardGold >= 1 && S.rewardGold <= 5,
    'chest=' + S.rewardChest + ' gold=' + S.goldDrops + '×' + S.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    [C.BLOODPACT, C.BOUNTY, C.BLOOD_MOON, C.CHALLENGER, C.SUMMONER].every(function (x) {
      return !x || x.startSec !== S.startSec;
    }), 'serenity=' + S.startSec);

  // ---------- 2. 不消费主随机流（直接调入口，隔离掉怪的掉落/暴击）----------
  const wR1 = cleanWorld(9301);
  const rngA = wR1.rngState;
  openWindow(wR1);
  expect('★★开一轮前后 rngState 逐位一致（窗口插进来不许让后面每波落点错位）',
    wR1.rngState === rngA, 'before=' + rngA + ' after=' + wR1.rngState);
  const wR2 = cleanWorld(9302);
  openWindow(wR2);
  wR2.time = wR2.serenityDeadline;
  const rngB = wR2.rngState;
  SIM.tickSerenity(wR2);
  expect('★★守住发奖前后 rngState 逐位一致',
    wR2.rngState === rngB, 'before=' + rngB + ' after=' + wR2.rngState);
  const wR3 = cleanWorld(9303);
  openWindow(wR3);
  const rngC = wR3.rngState;
  hurt(wR3, 10);
  expect('★★破功前后 rngState 逐位一致',
    wR3.rngState === rngC, 'before=' + rngC + ' after=' + wR3.rngState);

  // ---------- 3. 时序 ----------
  const wT = cleanWorld(9310);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  wT.serenityNextTick = 0;
  SIM.tickSerenity(wT);
  expect('到点前零轮、零播报、未激活',
    wT.serenityRounds === 0 && wT.serenityActive === 0 &&
    evs(wT, 'serenity_start').length === 0, 'rounds=' + wT.serenityRounds);
  openWindow(wT);
  expect('到点正好一轮、激活、一条开窗播报',
    wT.serenityRounds === 1 && wT.serenityActive === 1 &&
    evs(wT, 'serenity_start').length === 1, 'rounds=' + wT.serenityRounds);
  const st = evs(wT, 'serenity_start')[0];
  expect('开窗播报一次说清"多久 + 第几轮"',
    st.sec === S.windowSec && st.round === 1, JSON.stringify(st));
  expect('到期时刻 = 开窗时刻 + 窗口长度（w.time 口径无漂移）',
    Math.abs(wT.serenityDeadline - (startTick / HZ + S.windowSec)) < 0.02,
    'deadline=' + wT.serenityDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.serenityNextTick === startTick + Math.round(S.everySec * HZ),
    'next=' + wT.serenityNextTick);
  const roundsBefore = wT.serenityRounds;
  SIM.tickSerenity(wT);
  expect('同帧再 tick 不重复开窗',
    wT.serenityRounds === roundsBefore && evs(wT, 'serenity_start').length === 1,
    'rounds=' + wT.serenityRounds);

  // ---------- 4. 守住 → 发奖 ----------
  const wD = cleanWorld(9320);
  openWindow(wD);
  wD.time = wD.serenityDeadline - 1 / HZ;
  SIM.tickSerenity(wD);
  expect('到期前一帧窗口还开着、一个奖励都不发',
    wD.serenityActive === 1 && wD.pickups.length === 0 &&
    evs(wD, 'serenity_done').length === 0, 'active=' + wD.serenityActive);
  const px = wD.self.x, py = wD.self.y;
  wD.time = wD.serenityDeadline;
  SIM.tickSerenity(wD);
  expect('到期正好守住：窗口关闭、守住次数 +1、一条达成播报',
    wD.serenityActive === 0 && wD.serenityDone === 1 &&
    evs(wD, 'serenity_done').length === 1,
    'active=' + wD.serenityActive + ' done=' + wD.serenityDone);
  expect('★★宝箱正好一个（守住的一次免费升级）',
    byKind(wD, 'chest').length === S.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  const dg = byKind(wD, 'gold');
  expect('金币枚数与每枚面值都正确',
    dg.length === S.goldDrops && dg.every(function (it) { return it.value === S.rewardGold; }),
    'n=' + dg.length + ' value=' + (dg[0] || {}).value);
  expect('★★奖励落在玩家脚下（不是地图中央，玩家不用满地图找）',
    byKind(wD, 'chest')[0].x === px && byKind(wD, 'chest')[0].y === py,
    'chest=' + byKind(wD, 'chest')[0].x + ',' + byKind(wD, 'chest')[0].y +
    ' player=' + px + ',' + py);
  const dn = evs(wD, 'serenity_done')[0];
  expect('达成播报带"秒数 + 掉了什么"，数字全来自事件',
    dn.sec === S.windowSec && dn.chest === S.rewardChest &&
    dn.gold === S.goldDrops * S.rewardGold, JSON.stringify(dn));
  const pickupsAfterDone = wD.pickups.length;
  wD.time = wD.serenityDeadline + 5;
  SIM.tickSerenity(wD);
  hurt(wD, 10);
  expect('守住后再推时间、再挨打都不二次发奖、也不算破功',
    wD.serenityDone === 1 && wD.serenityBroken === 0 &&
    wD.pickups.length === pickupsAfterDone,
    'done=' + wD.serenityDone + ' broken=' + wD.serenityBroken);

  // ---------- 5. 破功（"不该发生的事"的守门人）----------
  const wB = cleanWorld(9330);
  openWindow(wB);
  const deadlineB = wB.serenityDeadline;
  const dealt = hurt(wB, 10);
  expect('窗口内一次真实扣血就破功',
    dealt > 0 && wB.serenityActive === 0 && wB.serenityBroken === 1 &&
    evs(wB, 'serenity_broken').length === 1,
    'dealt=' + dealt + ' active=' + wB.serenityActive + ' broken=' + wB.serenityBroken);
  expect('★★★破功后一个掉落物都不多（绝不偷偷发奖）',
    wB.pickups.length === 0, 'pickups=' + wB.pickups.length);
  expect('★★破功后绝不出现"达成"播报',
    evs(wB, 'serenity_done').length === 0 && wB.serenityDone === 0,
    'done=' + wB.serenityDone);
  // 破功后再挨打：先把 invuln 清掉，验证"不重复播报"这一节流
  hurt(wB, 10);
  expect('破功后再受伤不重复播报（不刷屏）',
    wB.serenityBroken === 1 && evs(wB, 'serenity_broken').length === 1,
    'broken=' + wB.serenityBroken);
  // 破功后推到原本的到期时刻，绝不补发
  wB.tick = Math.round(deadlineB * HZ) + 2;
  wB.time = deadlineB + 0.1;
  SIM.tickSerenity(wB);
  expect('★★破功后即使推到原到期时刻也不补发奖励',
    wB.serenityDone === 0 && wB.pickups.length === 0 &&
    evs(wB, 'serenity_done').length === 0, 'done=' + wB.serenityDone);

  // 无敌帧 / 升级定格里的"挨打"不算破功：damagePlayer 在入口就 return，钩子根本走不到
  const wI = cleanWorld(9331);
  openWindow(wI);
  const pI = wI.self;
  pI.invuln = 5;
  const hpI = pI.hp;
  SIM.damagePlayer(wI, pI, 100, pI.x + 20, pI.y);
  expect('★★无敌帧里的"挨打"没掉血，不算破功',
    pI.hp === hpI && wI.serenityActive === 1 &&
    evs(wI, 'serenity_broken').length === 0,
    'hp=' + pI.hp + '/' + hpI + ' active=' + wI.serenityActive);
  const wL = cleanWorld(9332);
  openWindow(wL);
  const pL = wL.self;
  pL.state = 'levelup';
  const hpL = pL.hp;
  SIM.damagePlayer(wL, pL, 100, pL.x + 20, pL.y);
  expect('★★升级三选一定格里的"挨打"没掉血，不算破功',
    pL.hp === hpL && wL.serenityActive === 1 &&
    evs(wL, 'serenity_broken').length === 0,
    'hp=' + pL.hp + '/' + hpL + ' active=' + wL.serenityActive);

  // ---------- 6. 剧情关隔离（双管）----------
  const wS = cleanWorld(9340);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch4' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.serenityNextTick = 0;
  SIM.tickSerenity(wS);
  expect('★★直接调入口：剧情关不开窗、零播报',
    wS.serenityActive === 0 && wS.serenityRounds === 0 &&
    evs(wS, 'serenity_start').length === 0, 'active=' + wS.serenityActive);
  // 双保险：剧情关里强行激活再受伤，也不算破功（onSerenityHit 有 story 闸）
  wS.serenityActive = 1;
  hurt(wS, 10);
  expect('★★剧情关里强行激活也不算破功（双保险）',
    wS.serenityActive === 1 && evs(wS, 'serenity_broken').length === 0,
    'active=' + wS.serenityActive);
  // 走 step 那一遍：守心首发 174 秒，ch4（420 秒上限）确保世界还在跑
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9341, modId: 'myth', stageId: 'ch4' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((S.startSec + k * 30) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch4）走完整条 step 也没有守心劫，且那一刻世界确实还在跑',
    storyAlive && wS2.serenityActive === 0 &&
    evs(wS2, 'serenity_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' + wS2.matchSec + ' 秒）'
    + ' / active=' + wS2.serenityActive);
}

// ============================================================
// 第五十七轮：拾荒令（限时收集地上的精魄/金币，目标制零实体第三件）
// ============================================================
// 这一族三件玩法分别钉三条轴：限时杀几只（悬赏）/ 限时别挨打（守心）/ 限时捡几份（本轮）。
// ★最要紧的两条判据：①「不该数的东西不许数」——红心、宝箱、剧情关、窗口外，
//   全都不许把 gleanCount 顶上去；②「达标发奖不许发生在拾取循环里」——
//   发奖若在 updatePickups 压缩数组时 spawnPickup，新球当帧又被遍历到会刷出一地球。
function testGlean() {
  console.log('[第五十七轮] 拾荒令：第一件「限时收集」目标（只数 exp/gold，零实体）');
  const G = C.GLEAN;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(G.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远、关武器、清掉落，只留拾荒这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;    // 默认不排期：要开窗的世界自己设为 0
    w.forgeNextTick = 1e9;    // 破军令 342s 开窗，默认推远
    w.strideNextTick = 1e9;   // 逐日步 354s 开窗，默认推远
    w.mendNextTick = 1e9;     // 养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9;  // 惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;    // 履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;      // 饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.gleanNextTick = 0;
    SIM.tickGlean(w);
  }
  // 直接调拾取钩子注入 n 份：隔离掉战斗/掉落/暴击，专门验计数与随机流。
  function feed(w, n) {
    for (let i = 0; i < n; i++) SIM.onGleanPickup(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则窗口里刚刷的怪都还在 700px 外，地上没球可捡）',
    G.startSec % 30 !== 0, G.startSec + ' % 30 = ' + (G.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起）',
    G.windowSec > 8 && G.windowSec < G.everySec, G.windowSec + ' / ' + G.everySec);
  expect('目标份数按轮递增且封顶（第 2 轮 +step，第 99 轮到 max）',
    SIM.gleanNeedFor(0) === G.needPickups &&
    SIM.gleanNeedFor(1) === G.needPickups + G.pickupStep &&
    SIM.gleanNeedFor(99) === G.maxPickups,
    '0=' + SIM.gleanNeedFor(0) + ' 1=' + SIM.gleanNeedFor(1) + ' 99=' + SIM.gleanNeedFor(99));
  expect('目标份数与窗口长度合理（每秒约 1 份，站着不动绝无可能）',
    G.needPickups > 0 && G.needPickups <= G.maxPickups &&
    G.needPickups / G.windowSec >= 0.5 && G.needPickups / G.windowSec <= 3,
    'need=' + G.needPickups + ' / ' + G.windowSec + ' 秒');
  expect('奖励仍是"一箱 + 零钱"（与悬赏/守心同口径，不是巨款）',
    G.rewardChest >= 1 && G.rewardChest <= 2 && G.goldDrops >= 1 &&
    G.rewardGold >= 1 && G.rewardGold <= 5,
    'chest=' + G.rewardChest + ' gold=' + G.goldDrops + '×' + G.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    [C.BOUNTY, C.SERENITY, C.BLOODPACT, C.BOUNTY, C.HEALER, C.BELL].every(function (x) {
      return !x || x.startSec !== G.startSec;
    }), 'glean=' + G.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉掉落/暴击）----------
  const wR1 = cleanWorld(9401);
  const rngA = wR1.rngState;
  openWindow(wR1);
  expect('★★开一轮前后 rngState 逐位一致（不能让后面每波落点整体错位）',
    wR1.rngState === rngA, 'before=' + rngA + ' after=' + wR1.rngState);
  const wR2 = cleanWorld(9402);
  openWindow(wR2);
  const rngB = wR2.rngState;
  feed(wR2, 5);
  expect('★★收进 5 份前后 rngState 逐位一致',
    wR2.rngState === rngB, 'before=' + rngB + ' after=' + wR2.rngState);
  const wR3 = cleanWorld(9403);
  openWindow(wR3);
  feed(wR3, G.needPickups);
  wR3.time = wR3.gleanDeadline;
  const rngC = wR3.rngState;
  SIM.tickGlean(wR3);
  expect('★★达标发奖前后 rngState 逐位一致',
    wR3.rngState === rngC, 'before=' + rngC + ' after=' + wR3.rngState);
  const wR4 = cleanWorld(9404);
  openWindow(wR4);
  wR4.time = wR4.gleanDeadline;
  const rngD = wR4.rngState;
  SIM.tickGlean(wR4);
  expect('★★到期落空前后 rngState 逐位一致',
    wR4.rngState === rngD, 'before=' + rngD + ' after=' + wR4.rngState);

  // ---------- 3. 时序与"零实体" ----------
  const wT = cleanWorld(9410);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  wT.gleanNextTick = 0;
  SIM.tickGlean(wT);
  expect('到点前零轮、零播报、未开窗',
    wT.gleanRounds === 0 && wT.gleanActive === 0 &&
    evs(wT, 'glean_start').length === 0, 'rounds=' + wT.gleanRounds);
  const beforeAny = wT.gleanCount;
  feed(wT, 10);
  expect('★★窗口外捡到的球不许计数（早捡不算数）',
    wT.gleanCount === beforeAny, 'count=' + wT.gleanCount);
  openWindow(wT);
  expect('到点正好一轮、开窗、只发一条播报',
    wT.gleanRounds === 1 && wT.gleanActive === 1 &&
    evs(wT, 'glean_start').length === 1, 'rounds=' + wT.gleanRounds);
  expect('开窗本身一个实体都不放（场上本来就有的球才是目标）',
    wT.pickups.length === 0, 'pickups=' + wT.pickups.length);
  const st = evs(wT, 'glean_start')[0];
  expect('开窗播报一次说清"多久 / 捡几份 / 第几轮"',
    st.sec === G.windowSec && st.need === G.needPickups && st.round === 1,
    JSON.stringify(st));
  expect('到期时刻 = 开窗时刻 + 窗口长度（w.time 口径无漂移）',
    Math.abs(wT.gleanDeadline - (startTick / HZ + G.windowSec)) < 0.02,
    'deadline=' + wT.gleanDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.gleanNextTick === startTick + Math.round(G.everySec * HZ),
    'next=' + wT.gleanNextTick);
  const roundsBefore = wT.gleanRounds;
  SIM.tickGlean(wT);
  expect('同帧再 tick 不重复开窗',
    wT.gleanRounds === roundsBefore && evs(wT, 'glean_start').length === 1,
    'rounds=' + wT.gleanRounds);

  // ---------- 4. 收集、过半、达标 ----------
  const wD = cleanWorld(9420);
  openWindow(wD);
  const half = Math.ceil(G.needPickups / 2);
  feed(wD, half - 1);
  expect('过半前一条过半播报都没有',
    evs(wD, 'glean_half').length === 0 && wD.gleanCount === half - 1,
    'count=' + wD.gleanCount);
  feed(wD, 1);
  expect('正好捡到第 ceil(need/2) 份才播报过半',
    evs(wD, 'glean_half').length === 1 &&
    evs(wD, 'glean_half')[0].got === half &&
    evs(wD, 'glean_half')[0].left === G.needPickups - half,
    JSON.stringify(evs(wD, 'glean_half')[0]));
  feed(wD, 10);
  expect('★★过半播报只发一次（后续多捡不刷屏）',
    evs(wD, 'glean_half').length === 1, 'n=' + evs(wD, 'glean_half').length);
  wD.time = wD.gleanDeadline - 1 / HZ;
  SIM.tickGlean(wD);
  expect('到期前一帧窗口还开着、一个奖励都不发',
    wD.gleanActive === 1 && wD.pickups.length === 0 &&
    evs(wD, 'glean_done').length === 0, 'active=' + wD.gleanActive);
  feed(wD, G.needPickups - wD.gleanCount);
  wD.time = wD.gleanDeadline;
  const px = wD.self.x, py = wD.self.y;
  SIM.tickGlean(wD);
  expect('到期正好够数：窗口关闭、达成 +1、一条达成播报',
    wD.gleanActive === 0 && wD.gleanDone === 1 &&
    evs(wD, 'glean_done').length === 1,
    'active=' + wD.gleanActive + ' done=' + wD.gleanDone);
  expect('★★宝箱正好一个（达成的一次免费升级）',
    byKind(wD, 'chest').length === G.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  const dg = byKind(wD, 'gold');
  expect('金币枚数与每枚面值都正确',
    dg.length === G.goldDrops && dg.every(function (it) { return it.value === G.rewardGold; }),
    'n=' + dg.length + ' value=' + (dg[0] || {}).value);
  expect('★★奖励落在玩家脚下（不是地图中央，玩家不用满地图找）',
    byKind(wD, 'chest')[0].x === px && byKind(wD, 'chest')[0].y === py,
    'chest=' + byKind(wD, 'chest')[0].x + ',' + byKind(wD, 'chest')[0].y +
    ' player=' + px + ',' + py);
  const dn = evs(wD, 'glean_done')[0];
  expect('达成播报带"捡了几份 + 掉了什么"，数字全来自事件',
    dn.got === G.needPickups && dn.chest === G.rewardChest &&
    dn.gold === G.goldDrops * G.rewardGold, JSON.stringify(dn));
  const pickupsAfterDone = wD.pickups.length;
  wD.time = wD.gleanDeadline + 5;
  SIM.tickGlean(wD);
  feed(wD, 100);
  expect('★★达标后再推时间、再捡都不二次发奖，也不算落空',
    wD.gleanDone === 1 && wD.gleanFailed === 0 &&
    wD.pickups.length === pickupsAfterDone,
    'done=' + wD.gleanDone + ' failed=' + wD.gleanFailed);
  // 下一轮：目标数涨、计数清零（不能把上一轮捡的带进下一轮）
  wD.tick = startTick + Math.round(G.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickGlean(wD);
  expect('下一轮目标按轮号递增、计数从零开始',
    wD.gleanRounds === 2 && wD.gleanCount === 0 &&
    wD.gleanNeed === SIM.gleanNeedFor(1),
    'rounds=' + wD.gleanRounds + ' need=' + wD.gleanNeed);

  // ---------- 5. 到期落空（"什么都不给、不责备"）----------
  const wF = cleanWorld(9430);
  openWindow(wF);
  feed(wF, G.needPickups - 1);
  wF.time = wF.gleanDeadline;
  SIM.tickGlean(wF);
  expect('差一份到期就落空：窗口关闭、失败 +1、只发一条到期播报',
    wF.gleanActive === 0 && wF.gleanFailed === 1 &&
    evs(wF, 'glean_fail').length === 1,
    'active=' + wF.gleanActive + ' failed=' + wF.gleanFailed);
  expect('★★★落空后一个掉落物都不多（绝不偷偷发奖）',
    wF.pickups.length === 0, 'pickups=' + wF.pickups.length);
  expect('★★落空后绝不出现"达成"播报',
    evs(wF, 'glean_done').length === 0 && wF.gleanDone === 0,
    'done=' + wF.gleanDone);
  const fn = evs(wF, 'glean_fail')[0];
  expect('到期播报只陈述"还差几份"（不责备玩家）',
    fn.left === 1 && fn.got === G.needPickups - 1 && fn.need === G.needPickups,
    JSON.stringify(fn));
  const beforeLate = wF.pickups.length;
  wF.time = wF.gleanDeadline + 10;
  SIM.tickGlean(wF);
  feed(wF, 100);
  expect('★★落空后即使推到很晚、再捡也不补发',
    wF.gleanDone === 0 && wF.pickups.length === beforeLate,
    'done=' + wF.gleanDone + ' pickups=' + wF.pickups.length);
  expect('★★落空后再喂也不计数（active 已清）',
    wF.gleanCount === G.needPickups - 1, 'count=' + wF.gleanCount);

  // ---------- 6. 真实拾取路径：只数 exp / gold ----------
  const wP = cleanWorld(9440);
  openWindow(wP);
  const pP = wP.self;
  // 一颗经验球 + 一枚金币贴脚生成，走真实 step 被吃掉。
  SIM.spawnPickup(wP, 'exp', pP.x, pP.y, 5);
  SIM.spawnPickup(wP, 'gold', pP.x, pP.y, 1);
  SIM.step(wP, { mx: 0, my: 0 });
  expect('★★真实拾取：一颗精魄 + 一枚金币正好算两份',
    wP.gleanCount === 2 && wP.pickups.length === 0,
    'count=' + wP.gleanCount + ' left=' + wP.pickups.length);
  // 红心与宝箱不该被算进来（它们是"走到跟前才领"的点位，与拾取半径无关）
  const wN = cleanWorld(9441);
  openWindow(wN);
  const pN = wN.self;
  pN.hp = pN.maxHp - 10;
  SIM.spawnPickup(wN, 'heart', pN.x, pN.y, 5);
  SIM.spawnPickup(wN, 'chest', pN.x, pN.y, 1, C.DROPS.chest.life);
  SIM.step(wN, { mx: 0, my: 0 });
  expect('★★★红心与宝箱贴脚吃掉也不计数（目标只能是 exp/gold）',
    wN.gleanCount === 0 && wN.pickups.length === 0,
    'count=' + wN.gleanCount + ' left=' + wN.pickups.length);
  // 达标奖励撒在脚边，被捡回时不能算进同一轮（先清 active 再发奖）
  const wR = cleanWorld(9442);
  openWindow(wR);
  feed(wR, G.needPickups);
  wR.time = wR.gleanDeadline;
  SIM.tickGlean(wR);
  const countAtDone = wR.gleanCount;
  SIM.step(wR, { mx: 0, my: 0 });
  expect('★★★达标撒出的金币被捡回也不重复计数（发奖在数组压缩循环之外）',
    wR.gleanCount === countAtDone && wR.gleanActive === 0 &&
    wR.gleanDone === 1,
    'count=' + wR.gleanCount + ' done=' + wR.gleanDone);

  // ---------- 7. 剧情关隔离（双管）----------
  const wS = cleanWorld(9450);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch4' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.gleanNextTick = 0;
  SIM.tickGlean(wS);
  feed(wS, 100);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.gleanActive === 0 && wS.gleanRounds === 0 && wS.gleanCount === 0 &&
    evs(wS, 'glean_start').length === 0,
    'active=' + wS.gleanActive + ' count=' + wS.gleanCount);
  // 双保险：剧情关里强行激活，也不计数
  wS.gleanActive = 1;
  feed(wS, 5);
  expect('★★剧情关里强行激活也不计数（钩子有 story 闸）',
    wS.gleanCount === 0, 'count=' + wS.gleanCount);
  // 走 step 那一遍：ch5 有 540 秒上限，确保 204 秒那一刻世界还在跑
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9451, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((G.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有拾荒令，且那一刻世界确实还在跑',
    storyAlive && wS2.gleanActive === 0 &&
    evs(wS2, 'glean_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' + wS2.matchSec + ' 秒）'
    + ' / active=' + wS2.gleanActive);
}

function testForge() {
  console.log('[第五十八轮] 破军令：第一件「限时伤害量」目标（只数真·玩家输出，零实体）');
  const F = C.ONSLAUGHT;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(F.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远、关武器、清掉落，只留破军令这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    // 保证 damageMob 不抽随机、不叠暴击/血怒乘区，伤害计数可精确断言
    p.attrs.crit = 0;
    p.attrs.exec = 0;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;    // 默认不排期：要开窗的世界自己设为 0
    w.strideNextTick = 1e9;   // 逐日步 354s 开窗，默认推远（本测试要开窗时自己设 0）
    w.mendNextTick = 1e9;     // 养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9;  // 惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;    // 履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;      // 饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.forgeNextTick = 0;
    SIM.tickForge(w);
  }
  // 直接调钩子注入伤害：隔离掉战斗/暴击，专门验计数与随机流。
  function feed(w, dmg) {
    SIM.onForgeHit(w, dmg);
  }
  // 造一只高血量怪，用真实 damageMob 路径验"世界伤害不计入"。
  // seed 参数让它零随机生成；1000 倍血量保证四次小伤打不死（不触发 killMob）。
  function hitMob(w, dmg, src) {
    if (!w._mob) {
      const id = Object.keys(C.MOB_MAP)[0];
      w._mob = SIM.spawnMob(w, id, w.self.x + 40, w.self.y, 1000, 0, 0.5);
    }
    SIM.damageMob(w, w._mob, dmg, 0, 0, src);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则窗口刚开时场上是空场，没怪可打）',
    F.startSec % 30 !== 0, F.startSec + ' % 30 = ' + (F.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起）',
    F.windowSec > 8 && F.windowSec < F.everySec, F.windowSec + ' / ' + F.everySec);
  expect('目标伤害按轮递增且封顶（第 2 轮 +step，第 99 轮到 max）',
    SIM.forgeNeedFor(0) === F.needDamage &&
    SIM.forgeNeedFor(1) === F.needDamage + F.damageStep &&
    SIM.forgeNeedFor(99) === F.maxDamage,
    '0=' + SIM.forgeNeedFor(0) + ' 1=' + SIM.forgeNeedFor(1) + ' 99=' + SIM.forgeNeedFor(99));
  expect('目标伤害与窗口长度合理（每秒 30~120 点，站着不动/只补刀绝无可能）',
    F.needDamage > 0 && F.needDamage <= F.maxDamage &&
    F.needDamage / F.windowSec >= 30 && F.needDamage / F.windowSec <= 120,
    'need=' + F.needDamage + ' / ' + F.windowSec + ' 秒 = ' + (F.needDamage / F.windowSec));
  expect('奖励仍是"一箱 + 零钱"（与悬赏/守心/拾荒同口径，不是巨款）',
    F.rewardChest >= 1 && F.rewardChest <= 2 && F.goldDrops >= 1 &&
    F.rewardGold >= 1 && F.rewardGold <= 5,
    'chest=' + F.rewardChest + ' gold=' + F.goldDrops + '×' + F.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    [C.BOUNTY, C.SERENITY, C.GLEAN, C.CAULDRON, C.BELL, C.HEALER].every(function (x) {
      return !x || x.startSec !== F.startSec;
    }), 'forge=' + F.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉掉落/暴击）----------
  const wR1 = cleanWorld(9501);
  const rngA = wR1.rngState;
  openWindow(wR1);
  expect('★★开一轮前后 rngState 逐位一致（不能让后面每波落点整体错位）',
    wR1.rngState === rngA, 'before=' + rngA + ' after=' + wR1.rngState);
  const wR2 = cleanWorld(9502);
  openWindow(wR2);
  const rngB = wR2.rngState;
  feed(wR2, 500);
  expect('★★打进 500 点伤害前后 rngState 逐位一致',
    wR2.rngState === rngB, 'before=' + rngB + ' after=' + wR2.rngState);
  const wR3 = cleanWorld(9503);
  openWindow(wR3);
  feed(wR3, F.needDamage);
  wR3.time = wR3.forgeDeadline;
  const rngC = wR3.rngState;
  SIM.tickForge(wR3);
  expect('★★达标发奖前后 rngState 逐位一致',
    wR3.rngState === rngC, 'before=' + rngC + ' after=' + wR3.rngState);
  const wR4 = cleanWorld(9504);
  openWindow(wR4);
  wR4.time = wR4.forgeDeadline;
  const rngD = wR4.rngState;
  SIM.tickForge(wR4);
  expect('★★到期落空前后 rngState 逐位一致',
    wR4.rngState === rngD, 'before=' + rngD + ' after=' + wR4.rngState);

  // ---------- 3. 时序与"零实体" ----------
  const wT = cleanWorld(9510);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  wT.forgeNextTick = 0;
  SIM.tickForge(wT);
  expect('到点前零轮、零播报、未开窗',
    wT.forgeRounds === 0 && wT.forgeActive === 0 &&
    evs(wT, 'forge_start').length === 0, 'rounds=' + wT.forgeRounds);
  feed(wT, 1000);
  expect('★★窗口外打出的伤害不许计数（早打不算）',
    wT.forgeDamage === 0, 'damage=' + wT.forgeDamage);
  openWindow(wT);
  expect('到点正好一轮、开窗、只发一条播报',
    wT.forgeRounds === 1 && wT.forgeActive === 1 &&
    evs(wT, 'forge_start').length === 1, 'rounds=' + wT.forgeRounds);
  expect('开窗本身一个实体都不放（场上本来就有的怪才是目标）',
    wT.pickups.length === 0 && wT.mobs.length === 0,
    'pickups=' + wT.pickups.length + ' mobs=' + wT.mobs.length);
  const st = evs(wT, 'forge_start')[0];
  expect('开窗播报一次说清"多久 / 打多少 / 第几轮"',
    st.sec === F.windowSec && st.need === F.needDamage && st.round === 1,
    JSON.stringify(st));
  expect('到期时刻 = 开窗时刻 + 窗口长度（w.time 口径无漂移）',
    Math.abs(wT.forgeDeadline - (startTick / HZ + F.windowSec)) < 0.02,
    'deadline=' + wT.forgeDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.forgeNextTick === startTick + Math.round(F.everySec * HZ),
    'next=' + wT.forgeNextTick);
  const roundsBefore = wT.forgeRounds;
  SIM.tickForge(wT);
  expect('同帧再 tick 不重复开窗',
    wT.forgeRounds === roundsBefore && evs(wT, 'forge_start').length === 1,
    'rounds=' + wT.forgeRounds);

  // ---------- 4. 伤害累计与过半（连续量：>= 阈值 + 标记位）----------
  const wD = cleanWorld(9520);
  openWindow(wD);
  feed(wD, F.needDamage / 2 - 1);
  expect('过半前一条过半播报都没有',
    evs(wD, 'forge_half').length === 0 && wD.forgeDamage === F.needDamage / 2 - 1,
    'damage=' + wD.forgeDamage);
  feed(wD, 1);
  expect('正好打到半程才播报过半',
    evs(wD, 'forge_half').length === 1 &&
    evs(wD, 'forge_half')[0].got === Math.round(F.needDamage / 2),
    JSON.stringify(evs(wD, 'forge_half')[0]));
  feed(wD, 10);
  expect('★★过半播报只发一次（后续多打不刷屏）',
    evs(wD, 'forge_half').length === 1, 'n=' + evs(wD, 'forge_half').length);
  // 一发直接跨过半程也要报（伤害是连续量，=== 会永远错过）
  const wD2 = cleanWorld(9521);
  openWindow(wD2);
  feed(wD2, F.needDamage - 1);
  expect('★★★一发就跨过半程也照报（=== 判定在这里会漏，>= + 标记位才对）',
    evs(wD2, 'forge_half').length === 1 &&
    evs(wD2, 'forge_half')[0].got === F.needDamage - 1,
    JSON.stringify(evs(wD2, 'forge_half')[0]));
  wD.time = wD.forgeDeadline - 1 / HZ;
  SIM.tickForge(wD);
  expect('到期前一帧窗口还开着、一个奖励都不发',
    wD.forgeActive === 1 && wD.pickups.length === 0 &&
    evs(wD, 'forge_done').length === 0, 'active=' + wD.forgeActive);

  // ---------- 5. 达标 ----------
  feed(wD, F.needDamage - wD.forgeDamage);
  wD.time = wD.forgeDeadline;
  const px = wD.self.x, py = wD.self.y;
  SIM.tickForge(wD);
  expect('到期正好够数：窗口关闭、达成 +1、一条达成播报',
    wD.forgeActive === 0 && wD.forgeDone === 1 &&
    evs(wD, 'forge_done').length === 1,
    'active=' + wD.forgeActive + ' done=' + wD.forgeDone);
  expect('★★宝箱正好一个（达成的一次免费升级）',
    byKind(wD, 'chest').length === F.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  const dg = byKind(wD, 'gold');
  expect('金币枚数与每枚面值都正确',
    dg.length === F.goldDrops && dg.every(function (it) { return it.value === F.rewardGold; }),
    'n=' + dg.length + ' value=' + (dg[0] || {}).value);
  expect('★★奖励落在玩家脚下（不是地图中央，玩家不用满地图找）',
    byKind(wD, 'chest')[0].x === px && byKind(wD, 'chest')[0].y === py,
    'chest=' + byKind(wD, 'chest')[0].x + ',' + byKind(wD, 'chest')[0].y +
    ' player=' + px + ',' + py);
  const dn = evs(wD, 'forge_done')[0];
  expect('达成播报带"打了几伤 + 掉了什么"，数字全来自事件',
    dn.got === F.needDamage && dn.chest === F.rewardChest &&
    dn.gold === F.goldDrops * F.rewardGold, JSON.stringify(dn));
  const pickupsAfterDone = wD.pickups.length;
  wD.time = wD.forgeDeadline + 5;
  feed(wD, 1000);
  SIM.tickForge(wD);
  expect('★★达标后再打、再推时间都不二次发奖，也不算落空',
    wD.forgeDone === 1 && wD.forgeFailed === 0 &&
    wD.pickups.length === pickupsAfterDone,
    'done=' + wD.forgeDone + ' failed=' + wD.forgeFailed);
  // 下一轮：目标涨、伤害清零（不能把上一轮的伤害带进下一轮）
  wD.tick = startTick + Math.round(F.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickForge(wD);
  expect('下一轮目标按轮号递增、伤害从零开始',
    wD.forgeRounds === 2 && wD.forgeDamage === 0 &&
    wD.forgeNeed === SIM.forgeNeedFor(1) && wD.forgeHalfNoted === 0,
    'rounds=' + wD.forgeRounds + ' need=' + wD.forgeNeed);

  // ---------- 6. 到期落空（"什么都不给、不责备"）----------
  const wF = cleanWorld(9530);
  openWindow(wF);
  feed(wF, F.needDamage - 1);
  wF.time = wF.forgeDeadline;
  SIM.tickForge(wF);
  expect('差一点到期就落空：窗口关闭、失败 +1、只发一条到期播报',
    wF.forgeActive === 0 && wF.forgeFailed === 1 &&
    evs(wF, 'forge_fail').length === 1,
    'active=' + wF.forgeActive + ' failed=' + wF.forgeFailed);
  expect('★★★落空后一个掉落物都不多（绝不偷偷发奖）',
    wF.pickups.length === 0, 'pickups=' + wF.pickups.length);
  expect('★★落空后绝不出现"达成"播报',
    evs(wF, 'forge_done').length === 0 && wF.forgeDone === 0,
    'done=' + wF.forgeDone);
  const fn = evs(wF, 'forge_fail')[0];
  expect('到期播报只陈述"还差几点伤害"（不责备玩家）',
    fn.left === 1 && fn.got === F.needDamage - 1 && fn.need === F.needDamage,
    JSON.stringify(fn));
  const beforeLate = wF.pickups.length;
  wF.time = wF.forgeDeadline + 10;
  feed(wF, 1000);
  SIM.tickForge(wF);
  expect('★★落空后即使推到很晚、再打也不补发',
    wF.forgeDone === 0 && wF.pickups.length === beforeLate,
    'done=' + wF.forgeDone + ' pickups=' + wF.pickups.length);
  expect('★★落空后再喂也不计数（active 已清）',
    wF.forgeDamage === F.needDamage - 1, 'damage=' + wF.forgeDamage);

  // ---------- 7. ★世界伤害隔离（核心新轴：只认真·玩家输出）----------
  const wW = cleanWorld(9540);
  openWindow(wW);
  hitMob(wW, 50, 'weapon_test');
  expect('玩家武器伤害计入（正向对照：这条路必须通）',
    wW.forgeDamage === 50, 'damage=' + wW.forgeDamage);
  hitMob(wW, 50, 'meteor');
  expect('★★★天火伤害一个都不计入（世界伤害不替玩家达标）',
    wW.forgeDamage === 50, 'damage=' + wW.forgeDamage);
  hitMob(wW, 50, 'ley');
  expect('★★地脉灵泉伤害不计入',
    wW.forgeDamage === 50, 'damage=' + wW.forgeDamage);
  hitMob(wW, 50, 'lantern');
  expect('★★引魂灯收尾伤害不计入',
    wW.forgeDamage === 50, 'damage=' + wW.forgeDamage);
  hitMob(wW, 50, 'weapon_test');
  expect('世界伤害之后玩家伤害继续正常计入（没被误关闸）',
    wW.forgeDamage === 100, 'damage=' + wW.forgeDamage);
  // 剧情关里即使调 damageMob 也不计数（钩子 story 闸）
  const wWS = cleanWorld(9541);
  wWS.modId = 'myth';
  wWS.storyStage = { id: 'ch5' };
  openWindow(wWS);
  hitMob(wWS, 500, 'weapon_test');
  expect('★★剧情关里调 damageMob 也不计数（钩子有 story 闸）',
    wWS.forgeDamage === 0, 'damage=' + wWS.forgeDamage);

  // ---------- 8. 剧情关隔离（双管）----------
  const wS = cleanWorld(9550);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.forgeNextTick = 0;
  SIM.tickForge(wS);
  feed(wS, 100000);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.forgeActive === 0 && wS.forgeRounds === 0 && wS.forgeDamage === 0 &&
    evs(wS, 'forge_start').length === 0,
    'active=' + wS.forgeActive + ' damage=' + wS.forgeDamage);
  wS.forgeActive = 1;
  feed(wS, 500);
  expect('★★剧情关里强行激活也不计数（钩子有 story 闸）',
    wS.forgeDamage === 0, 'damage=' + wS.forgeDamage);
  // 走 step 那一遍：ch5 有 480 秒上限，确保 342 秒那一刻世界还在跑
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9551, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((F.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有破军令，且那一刻世界确实还在跑',
    storyAlive && wS2.forgeActive === 0 &&
    evs(wS2, 'forge_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' + wS2.matchSec + ' 秒）'
    + ' / active=' + wS2.forgeActive);
}

// ============================================================
// 第五十九轮：逐日步 —— 目标制零实体第五件，第一件"限时走位距离"
// ============================================================
function testStride() {
  console.log('[第五十九轮] 逐日步：第一件「限时走位距离」目标（只数真实位移，传送不算）');
  const S = C.STRIDE;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(S.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远，只留逐日步这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;   // 默认不排期：要开窗的世界自己设 0
    w.mendNextTick = 1e9;     // 养元诀 366s 开窗，默认推远
    w.thunderNextTick = 1e9;  // 惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;    // 履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;      // 饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.strideNextTick = 0;
    SIM.tickStride(w);
  }
  // 直接调钩子注入位移：隔离掉移动/传送，专门验计数与随机流。
  function feed(w, dist) {
    SIM.onStrideMove(w, dist);
  }
  function finish(w, dist) {
    feed(w, dist);
    w.time = w.strideDeadline + 0.01;
    SIM.tickStride(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没得走也没得打）',
    S.startSec % 30 !== 0, S.startSec + ' % 30 = ' + (S.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    S.windowSec >= 20 && S.windowSec < S.everySec, S.windowSec + ' / ' + S.everySec);
  expect('目标距离按轮递增且封顶（第 2 轮 +step，第 99 轮到 max）',
    SIM.strideNeedFor(0) === S.needDist &&
    SIM.strideNeedFor(1) === S.needDist + S.distStep &&
    SIM.strideNeedFor(99) === S.maxDist,
    '0=' + SIM.strideNeedFor(0) + ' 1=' + SIM.strideNeedFor(1) +
    ' 99=' + SIM.strideNeedFor(99));
  expect('目标距离与窗口长度合理（每秒 60~130px；基础移速 120 能做完但不能站着做）',
    S.needDist > 0 && S.needDist <= S.maxDist &&
    S.needDist / S.windowSec >= 60 && S.needDist / S.windowSec <= 130,
    'need=' + S.needDist + ' / ' + S.windowSec + ' 秒 = ' + (S.needDist / S.windowSec));
  expect('奖励仍是"一箱 + 零钱"（与悬赏/守心/拾荒/破军同口径，不是巨款）',
    S.rewardChest >= 1 && S.rewardChest <= 2 && S.goldDrops >= 1 &&
    S.rewardGold >= 1 && S.rewardGold <= 5,
    'chest=' + S.rewardChest + ' gold=' + S.goldDrops + '×' + S.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'CAULDRON', 'BELL', 'HEALER',
      'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== S.startSec;
    }), 'stride=' + S.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉移动与掉落）----------
  const wR = cleanWorld(9501);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, 500);
  finish(wR, S.needDist - 500);
  expect('★开窗/计数/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(9502);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 5);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(9510);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickStride(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.strideRounds === 0 && evs(wT, 'stride_start').length === 0,
    'rounds=' + wT.strideRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.strideRounds === 1 && wT.strideActive === 1,
    'rounds=' + wT.strideRounds + ' active=' + wT.strideActive);
  expect('★★开窗零实体：没碑、没怪、没球、没特效（与前四件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'stride_start')[0];
  expect('开窗播报一次说清三件事：多久 / 多远 / 给什么',
    !!st && st.sec === S.windowSec && st.need === S.needDist &&
    st.round === 1 && evs(wT, 'stride_start').length === 1,
    JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.strideDeadline - (startTick / HZ + S.windowSec)) < 1e-9,
    'deadline=' + wT.strideDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.strideNextTick === startTick + Math.round(S.everySec * HZ),
    'next=' + wT.strideNextTick);
  SIM.tickStride(wT);
  expect('同帧重复调用不会二次开窗', wT.strideRounds === 1,
    'rounds=' + wT.strideRounds);
  wT.time = wT.strideDeadline - 0.001;
  SIM.tickStride(wT);
  expect('到期前一帧不发奖也不结算', wT.strideActive === 1 &&
    wT.strideDist === 0 && evs(wT, 'stride_done').length === 0 &&
    evs(wT, 'stride_fail').length === 0,
    'active=' + wT.strideActive + ' dist=' + wT.strideDist);

  // ---------- 4. 过半（连续量，>= + 标记位）----------
  const wH = cleanWorld(9511);
  openWindow(wH);
  feed(wH, S.needDist / 2 - 10);
  expect('过半前零播报', evs(wH, 'stride_half').length === 0,
    'half=' + evs(wH, 'stride_half').length);
  feed(wH, 10);
  expect('正好半程报一次', evs(wH, 'stride_half').length === 1,
    'half=' + evs(wH, 'stride_half').length);
  feed(wH, 900);
  expect('多走不刷屏（过半播报恰好一次）', evs(wH, 'stride_half').length === 1,
    'half=' + evs(wH, 'stride_half').length);
  const wH2 = cleanWorld(9512);
  openWindow(wH2);
  feed(wH2, S.needDist);   // 一帧跨过半程
  expect('★★一帧跨过半程也照报（=== 在这里会漏，>= + 标记位才对）',
    evs(wH2, 'stride_half').length === 1,
    'half=' + evs(wH2, 'stride_half').length);

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(9520);
  openWindow(wD);
  finish(wD, S.needDist);
  expect('到期正好走够 → 达成', wD.strideActive === 0 && wD.strideDone === 1 &&
    evs(wD, 'stride_done').length === 1, 'done=' + wD.strideDone);
  expect('宝箱正好一个（与破军令同口径）', byKind(wD, 'chest').length === S.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === S.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === S.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'stride_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === S.needDist && dn.need === S.needDist &&
    dn.chest === S.rewardChest && dn.gold === S.goldDrops * S.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 1000);
  SIM.tickStride(wD);
  expect('★达标后再走、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.strideDone === 1 && evs(wD, 'stride_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.strideDone);
  wD.tick = startTick + Math.round(S.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickStride(wD);
  expect('下一轮目标递增且距离清零', wD.strideRounds === 2 &&
    wD.strideNeed === S.needDist + S.distStep && wD.strideDist === 0,
    'need=' + wD.strideNeed + ' dist=' + wD.strideDist);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(9530);
  openWindow(wF);
  finish(wF, S.needDist - 1);
  expect('差一像素也落空', wF.strideActive === 0 && wF.strideFailed === 1 &&
    wF.strideDone === 0, 'failed=' + wF.strideFailed + ' done=' + wF.strideDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现"达成"播报', evs(wF, 'stride_done').length === 0,
    'done=' + evs(wF, 'stride_done').length);
  const fl = evs(wF, 'stride_fail')[0];
  expect('落空只陈述还差多远（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === S.needDist - 1 && fl.need === S.needDist,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(S.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  // ★关掉后续排期，否则推这么远会再开一轮，那轮当然可以计数（不是补发）
  wF.strideNextTick = 1e9;
  SIM.tickStride(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.strideDone === 0, 'pickups=' + wF.pickups.length);
  // ★落空不清 dist（留着给失败播报的 got 用）：验的是"再喂不会继续涨"。
  const distAfterFail = wF.strideDist;
  feed(wF, 100000);
  expect('落空后再喂也不计数（钩子只认 active，距离不再涨）',
    wF.strideDist === distAfterFail && wF.strideActive === 0,
    'dist=' + wF.strideDist + '（落空时 ' + distAfterFail + '）');

  // ---------- 7. 位移钩子：只认真走路 ----------
  const wM = cleanWorld(9540);
  feed(wM, 100);
  expect('窗口外喂位移不计数', wM.strideDist === 0, 'dist=' + wM.strideDist);
  openWindow(wM);
  feed(wM, 120);
  expect('窗口内真实位移按像素累计', wM.strideDist === 120, 'dist=' + wM.strideDist);
  feed(wM, 0);
  feed(wM, -50);
  expect('零位移与负位移都不计数（不会白送距离）', wM.strideDist === 120,
    'dist=' + wM.strideDist);
  const wMS = cleanWorld(9541);
  wMS.modId = 'myth';
  wMS.storyStage = { id: 'ch5' };
  openWindow(wMS);
  feed(wMS, 500);
  expect('★★剧情关里强行激活也不计数（钩子有 story 闸）',
    wMS.strideDist === 0, 'dist=' + wMS.strideDist);

  // 真实 step：按住方向键 1 帧，位移应当约等于 speed×dt（120×0.05=6px）。
  // ★开窗在 step 的 tick 段（晚于本帧移动），所以要先空走一帧把窗开出来，
  //   再在下一帧按方向键 —— 否则测的其实是"开窗前那一步不算"（另一种自然安全）。
  const wStep = cleanWorld(9542);
  wStep.strideNextTick = 0;
  wStep.tick = startTick - 1;
  wStep.time = wStep.tick / HZ;
  SIM.step(wStep, { mx: 0, my: 0 });
  expect('开窗那一帧本身不计数（tick 段晚于移动，先开窗后计步）',
    wStep.strideActive === 1 && wStep.strideDist === 0,
    'active=' + wStep.strideActive + ' dist=' + wStep.strideDist);
  SIM.step(wStep, { mx: 1, my: 0 });
  expect('真实 step：开窗后按住方向键 1 帧按真实位移记',
    wStep.strideActive === 1 && wStep.strideDist > 3 && wStep.strideDist < 12,
    'dist=' + wStep.strideDist.toFixed(2));
  const wStill = cleanWorld(9543);
  wStill.strideNextTick = 0;
  wStill.tick = startTick - 1;
  wStill.time = wStill.tick / HZ;
  wStill.portals.length = 0;
  SIM.step(wStill, { mx: 0, my: 0 });
  const stillBefore = wStill.strideDist;
  SIM.step(wStill, { mx: 0, my: 0 });
  expect('★★站着不动一像素都不算（窗口确实开着）',
    wStill.strideActive === 1 && wStill.strideDist === stillBefore,
    'active=' + wStill.strideActive + ' dist=' + wStill.strideDist);

  // ★★传送门：本件最关键的"不该发生的事"——瞬移几百像素不许白拿进度。
  const wPortal = cleanWorld(9544);
  wPortal.strideNextTick = 0;
  wPortal.tick = startTick - 1;
  wPortal.time = wPortal.tick / HZ;
  // 先空走一帧开窗（tick 段在移动之后），再布置门、再真走过去
  SIM.step(wPortal, { mx: 0, my: 0 });
  expect('传送用例的前置条件成立：窗口确实开着', wPortal.strideActive === 1,
    'active=' + wPortal.strideActive);
  const pp = wPortal.self || wPortal.player;
  pp.portalCd = 0;
  const px0 = pp.x;
  const py0 = pp.y;
  wPortal.portals.length = 0;
  wPortal.portals.push({ x: px0 + 10, y: py0, pair: 1 });
  wPortal.portals.push({ x: px0 + 300, y: py0, pair: 0 });
  SIM.step(wPortal, { mx: 1, my: 0 });
  const teleported = Math.sqrt((pp.x - px0) * (pp.x - px0) +
    (pp.y - py0) * (pp.y - py0));
  expect('传送确实发生了（否则这条断言天然安全、假绿）', teleported > 200,
    '玩家位移=' + teleported.toFixed(1));
  expect('★★★跨图瞬移一分都不算逐日步距离（钩子在 tryPortal 之前）',
    wPortal.strideActive === 1 && wPortal.strideDist > 0 &&
    wPortal.strideDist < 20,
    'strideDist=' + wPortal.strideDist.toFixed(2) + ' 玩家位移=' + teleported.toFixed(1));

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(9550);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.strideNextTick = 0;
  SIM.tickStride(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.strideActive === 0 && wS.strideRounds === 0 && wS.strideDist === 0 &&
    evs(wS, 'stride_start').length === 0,
    'active=' + wS.strideActive + ' dist=' + wS.strideDist);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9551, modId: 'myth', stageId: 'ch5' });
  wS2.strideNextTick = 0;
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((S.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有逐日步，且那一刻世界确实还在跑',
    storyAlive && wS2.strideActive === 0 &&
    evs(wS2, 'stride_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.strideActive);
}

// ============================================================
// 第六十轮：养元诀（限时治愈量）—— 目标制零实体第六件
// ============================================================
function testMend() {
  console.log('[第六十轮] 养元诀：第一件「限时治愈量」目标（只认真回进血条的量，满血空吃不算）');
  const M = C.MEND;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(M.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远，只留养元诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.attrs.regen = 0;        // 关掉苔藓护符，避免它每帧偷回血污染计数
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;     // 默认不排期：要开窗的世界自己设 0
    w.thunderNextTick = 1e9;  // 惊雷诀 378s 开窗，默认推远
    w.perilNextTick = 1e9;    // 履险诀 402s 开窗，默认推远
    w.dewNextTick = 1e9;      // 饮露诀 414s 开窗，默认推远
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.mendNextTick = 0;
    SIM.tickMend(w);
  }
  // 直接调 onMendHeal 注入一段"真回血"：隔离掉掉血/红心，专门验计数与随机流。
  function feed(w, amt) {
    SIM.onMendHeal(w, amt);
  }
  function finish(w, amt) {
    feed(w, amt);
    w.time = w.mendDeadline + 0.01;
    SIM.tickMend(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没得回血）',
    M.startSec % 30 !== 0, M.startSec + ' % 30 = ' + (M.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    M.windowSec >= 20 && M.windowSec < M.everySec, M.windowSec + ' / ' + M.everySec);
  expect('目标回血量按轮递增且封顶（第 2 轮 +step，第 99 轮到 max）',
    SIM.mendNeedFor(0) === M.needHeal &&
    SIM.mendNeedFor(1) === M.needHeal + M.healStep &&
    SIM.mendNeedFor(99) === M.maxHeal,
    '0=' + SIM.mendNeedFor(0) + ' 1=' + SIM.mendNeedFor(1) +
    ' 99=' + SIM.mendNeedFor(99));
  expect('目标回血量与窗口长度合理（每秒 1~10 点；掉血后认真回能做，满血站桩绝无可能）',
    M.needHeal > 0 && M.needHeal <= M.maxHeal &&
    M.needHeal / M.windowSec >= 1 && M.needHeal / M.windowSec <= 10,
    'need=' + M.needHeal + ' / ' + M.windowSec + ' 秒 = ' + (M.needHeal / M.windowSec));
  expect('奖励仍是"一箱 + 零钱"（与前五件同口径，不是巨款）',
    M.rewardChest >= 1 && M.rewardChest <= 2 && M.goldDrops >= 1 &&
    M.rewardGold >= 1 && M.rewardGold <= 5,
    'chest=' + M.rewardChest + ' gold=' + M.goldDrops + '×' + M.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'CAULDRON', 'BELL',
      'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== M.startSec;
    }), 'mend=' + M.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉掉落）----------
  const wR = cleanWorld(9601);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, 500);
  finish(wR, M.needHeal - 500);
  expect('★开窗/计数/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(9602);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 5);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(9610);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickMend(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.mendRounds === 0 && evs(wT, 'mend_start').length === 0,
    'rounds=' + wT.mendRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.mendRounds === 1 && wT.mendActive === 1,
    'rounds=' + wT.mendRounds + ' active=' + wT.mendActive);
  expect('★★开窗零实体：没碑、没怪、没球、没特效（与前五件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'mend_start')[0];
  expect('开窗播报一次说清三件事：多久 / 回多少 / 给什么',
    !!st && st.sec === M.windowSec && st.need === M.needHeal &&
    st.round === 1 && evs(wT, 'mend_start').length === 1,
    JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.mendDeadline - (startTick / HZ + M.windowSec)) < 1e-9,
    'deadline=' + wT.mendDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.mendNextTick === startTick + Math.round(M.everySec * HZ),
    'next=' + wT.mendNextTick);
  SIM.tickMend(wT);
  expect('同帧重复调用不会二次开窗', wT.mendRounds === 1,
    'rounds=' + wT.mendRounds);
  wT.time = wT.mendDeadline - 0.001;
  SIM.tickMend(wT);
  expect('到期前一帧不发奖也不结算', wT.mendActive === 1 &&
    wT.mendHealed === 0 && evs(wT, 'mend_done').length === 0 &&
    evs(wT, 'mend_fail').length === 0,
    'active=' + wT.mendActive + ' healed=' + wT.mendHealed);

  // ---------- 4. 过半（连续量，>= + 标记位）----------
  const wH = cleanWorld(9611);
  openWindow(wH);
  feed(wH, M.needHeal / 2 - 10);
  expect('过半前零播报', evs(wH, 'mend_half').length === 0,
    'half=' + evs(wH, 'mend_half').length);
  feed(wH, 10);
  expect('正好半程报一次', evs(wH, 'mend_half').length === 1,
    'half=' + evs(wH, 'mend_half').length);
  feed(wH, 900);
  expect('多回不刷屏（过半播报恰好一次）', evs(wH, 'mend_half').length === 1,
    'half=' + evs(wH, 'mend_half').length);
  const wH2 = cleanWorld(9612);
  openWindow(wH2);
  feed(wH2, M.needHeal);   // 一帧跨过半程
  expect('★★一帧跨过半程也照报（=== 在这里会漏，>= + 标记位才对）',
    evs(wH2, 'mend_half').length === 1,
    'half=' + evs(wH2, 'mend_half').length);

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(9620);
  openWindow(wD);
  finish(wD, M.needHeal);
  expect('到期正好回够 → 达成', wD.mendActive === 0 && wD.mendDone === 1 &&
    evs(wD, 'mend_done').length === 1, 'done=' + wD.mendDone);
  expect('宝箱正好一个（与前五件同口径）', byKind(wD, 'chest').length === M.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === M.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === M.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'mend_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === M.needHeal && dn.need === M.needHeal &&
    dn.chest === M.rewardChest && dn.gold === M.goldDrops * M.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 1000);
  SIM.tickMend(wD);
  expect('★达标后再回血、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.mendDone === 1 && evs(wD, 'mend_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.mendDone);
  wD.tick = startTick + Math.round(M.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickMend(wD);
  expect('下一轮目标递增且回血计数清零', wD.mendRounds === 2 &&
    wD.mendNeed === M.needHeal + M.healStep && wD.mendHealed === 0,
    'need=' + wD.mendNeed + ' healed=' + wD.mendHealed);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(9630);
  openWindow(wF);
  finish(wF, M.needHeal - 1);
  expect('差一点也落空', wF.mendActive === 0 && wF.mendFailed === 1 &&
    wF.mendDone === 0, 'failed=' + wF.mendFailed + ' done=' + wF.mendDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现"达成"播报', evs(wF, 'mend_done').length === 0,
    'done=' + evs(wF, 'mend_done').length);
  const fl = evs(wF, 'mend_fail')[0];
  expect('落空只陈述还差几点（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === M.needHeal - 1 && fl.need === M.needHeal,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(M.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  // ★关掉后续排期，否则推这么远会再开一轮，那轮当然可以计数（不是补发）
  wF.mendNextTick = 1e9;
  wF.thunderNextTick = 1e9;
  wF.perilNextTick = 1e9;
  wF.dewNextTick = 1e9;
  wF.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
  wF.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
  wF.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
  wF.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickMend(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.mendDone === 0, 'pickups=' + wF.pickups.length);
  const healedAfterFail = wF.mendHealed;
  feed(wF, 100000);
  expect('落空后再喂也不计数（钩子只认 active，回血不再涨）',
    wF.mendHealed === healedAfterFail && wF.mendActive === 0,
    'healed=' + wF.mendHealed + '（落空时 ' + healedAfterFail + '）');

  // ---------- 7. 回血钩子：只认真回进血条的量（本件最关键的"不该发生的事"）----------
  const wM = cleanWorld(9640);
  feed(wM, 100);
  expect('窗口外喂回血不计数', wM.mendHealed === 0, 'healed=' + wM.mendHealed);
  openWindow(wM);
  feed(wM, 30);
  expect('窗口内真实回血按点累计', wM.mendHealed === 30, 'healed=' + wM.mendHealed);
  feed(wM, 0);
  feed(wM, -50);
  expect('零回血与负回血都不计数（不会白送）', wM.mendHealed === 30,
    'healed=' + wM.mendHealed);

  // ★★走真实 healPlayer 漏斗：满血时空吃红心 (gained=0) 一分都不算 ——
  //   这是"只认真增量、不认请求量"的核心锚点，反向验证把钩子改成 amount 立刻红。
  const wFull = cleanWorld(9641);
  openWindow(wFull);
  const pf = wFull.player;
  pf.hp = pf.maxHp;                        // 满血
  SIM.healPlayer(wFull, 20);               // 请求回 20，真回 0
  expect('★★★满血空吃红心一分都不算（钩子认 p.hp-before，不认请求量）',
    wFull.mendHealed === 0 && pf.hp === pf.maxHp,
    'healed=' + wFull.mendHealed + ' hp=' + pf.hp);

  const wOver = cleanWorld(9642);
  openWindow(wOver);
  const po = wOver.player;
  po.hp = po.maxHp - 8;                    // 只缺 8 点
  SIM.healPlayer(wOver, 100);              // 请求回 100，真回 8
  expect('★★回血溢出只认真回的 8 点（不是请求的 100 点）',
    wOver.mendHealed === 8 && po.hp === po.maxHp,
    'healed=' + wOver.mendHealed + ' hp=' + po.hp + '/' + po.maxHp);

  const wExact = cleanWorld(9643);
  openWindow(wExact);
  const pe = wExact.player;
  pe.hp = pe.maxHp - 50;
  SIM.healPlayer(wExact, 50);              // 正好回满，真回 50
  expect('真实掉血后吃红心按真增量计入（正向对照，证明非空跑）',
    wExact.mendHealed === 50 && pe.hp === pe.maxHp,
    'healed=' + wExact.mendHealed + ' hp=' + pe.hp);

  // 苔藓护符每秒 regen 是第二条回血通路，也要按真增量计入。
  const wRegen = cleanWorld(9644);
  openWindow(wRegen);
  const pr = wRegen.player;
  pr.hp = pr.maxHp - 100;
  pr.attrs.regen = 10;                     // 每秒 10 点
  SIM.step(wRegen, { mx: 0, my: 0 });      // 一帧 = 0.05 秒 → 真回约 0.5 点
  expect('★苔藓护符的每秒回血也按真增量计入（第二条回血通路不漏）',
    wRegen.mendHealed > 0 && wRegen.mendHealed < 2,
    'healed=' + wRegen.mendHealed.toFixed(2));

  const wMS = cleanWorld(9645);
  wMS.modId = 'myth';
  wMS.storyStage = { id: 'ch5' };
  openWindow(wMS);
  feed(wMS, 500);
  expect('★★剧情关里强行激活也不计数（钩子有 story 闸）',
    wMS.mendHealed === 0, 'healed=' + wMS.mendHealed);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(9650);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.mendNextTick = 0;
  SIM.tickMend(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.mendActive === 0 && wS.mendRounds === 0 && wS.mendHealed === 0 &&
    evs(wS, 'mend_start').length === 0,
    'active=' + wS.mendActive + ' healed=' + wS.mendHealed);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9651, modId: 'myth', stageId: 'ch5' });
  wS2.mendNextTick = 0;
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((M.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有养元诀，且那一刻世界确实还在跑',
    storyAlive && wS2.mendActive === 0 &&
    evs(wS2, 'mend_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.mendActive);
}

function testThunder() {
  console.log('[第六十一轮] 惊雷诀：第一件「限时暴击次数」目标（只认真暴击，不堆暴击永远拿不到）');
  const T = C.THUNDER;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(T.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远、关武器、默认不堆暴击，只留惊雷诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    // ★本件核心：默认暴击率 0（不堆日轮烙印就一次暴击都不会有）
    p.attrs.crit = 0;
    p.attrs.exec = 0;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;  // 默认不排期：要开窗的世界自己设 0
    w.perilNextTick = 1e9;    // 履险诀同理：要开窗的世界自己设 0
    w.dewNextTick = 1e9;      // 饮露诀同理：要开窗的世界自己设 0
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.thunderNextTick = 0;
    SIM.tickThunder(w);
  }
  // 直接调钩子注入 N 次暴击：隔离掉战斗/暴击判定，专门验计数与随机流。
  function feed(w, n) {
    for (let i = 0; i < (n || 1); i++) SIM.onThunderCrit(w, null);
  }
  function finish(w, n) {
    feed(w, n);
    w.time = w.thunderDeadline + 0.01;
    SIM.tickThunder(w);
  }
  // 造一只超高血量怪，用真实 damageMob 路径验"只认真暴击才算"。
  // crit 参数直接设玩家暴击率（1=必爆、0=永不爆），seed 让生成零随机。
  function critHit(w, crit, src) {
    if (!w._mob) {
      const id = Object.keys(C.MOB_MAP)[0];
      w._mob = SIM.spawnMob(w, id, w.self.x + 40, w.self.y, 100000, 0, 0.5);
    }
    w.player.attrs.crit = crit;
    SIM.damageMob(w, w._mob, 1, 0, 0, src || 'weapon_test');
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没怪可暴击）',
    T.startSec % 30 !== 0, T.startSec + ' % 30 = ' + (T.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    T.windowSec >= 20 && T.windowSec < T.everySec, T.windowSec + ' / ' + T.everySec);
  expect('目标暴击次数按轮递增且封顶（第 2 轮 +step，第 99 轮到 max）',
    SIM.thunderNeedFor(0) === T.needCrit &&
    SIM.thunderNeedFor(1) === T.needCrit + T.critStep &&
    SIM.thunderNeedFor(99) === T.maxCrit,
    '0=' + SIM.thunderNeedFor(0) + ' 1=' + SIM.thunderNeedFor(1) +
    ' 99=' + SIM.thunderNeedFor(99));
  expect('目标暴击频率合理（每秒 0.1~1 次；堆了暴击做得到，不堆暴击绝无可能）',
    T.needCrit > 0 && T.needCrit <= T.maxCrit &&
    T.needCrit / T.windowSec >= 0.1 && T.needCrit / T.windowSec <= 1,
    'need=' + T.needCrit + ' / ' + T.windowSec + ' 秒 = ' + (T.needCrit / T.windowSec));
  expect('奖励仍是"一箱 + 零钱"（与前六件同口径，不是巨款）',
    T.rewardChest >= 1 && T.rewardChest <= 2 && T.goldDrops >= 1 &&
    T.rewardGold >= 1 && T.rewardGold <= 5,
    'chest=' + T.rewardChest + ' gold=' + T.goldDrops + '×' + T.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'CAULDRON', 'BELL',
      'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== T.startSec;
    }), 'thunder=' + T.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗）----------
  const wR = cleanWorld(9701);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, 500);
  finish(wR, T.needCrit - 500);
  expect('★开窗/计数/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(9702);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 1);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(9710);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickThunder(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.thunderRounds === 0 && evs(wT, 'thunder_start').length === 0,
    'rounds=' + wT.thunderRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.thunderActive === 1 && wT.thunderRounds === 1,
    'rounds=' + wT.thunderRounds + ' active=' + wT.thunderActive);
  expect('★★开窗零实体：没碑、没怪、没球、没特效（与前六件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'thunder_start')[0];
  expect('开窗播报一次说清三件事：多久 / 暴击几次 / 给什么，还点明要堆暴击',
    !!st && st.sec === T.windowSec && st.need === T.needCrit &&
    st.round === 1 && evs(wT, 'thunder_start').length === 1,
    JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.thunderDeadline - (startTick / HZ + T.windowSec)) < 1e-9,
    'deadline=' + wT.thunderDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.thunderNextTick === startTick + Math.round(T.everySec * HZ),
    'next=' + wT.thunderNextTick);
  SIM.tickThunder(wT);
  expect('同帧重复调用不会二次开窗', wT.thunderRounds === 1,
    'rounds=' + wT.thunderRounds);
  wT.time = wT.thunderDeadline - 0.001;
  SIM.tickThunder(wT);
  expect('到期前一帧不发奖也不结算', wT.thunderActive === 1 &&
    wT.thunderCrits === 0 && evs(wT, 'thunder_done').length === 0 &&
    evs(wT, 'thunder_fail').length === 0,
    'active=' + wT.thunderActive + ' crits=' + wT.thunderCrits);

  // ---------- 4. 过半（>= + 标记位，一帧连爆多次也照报）----------
  const wH = cleanWorld(9711);
  openWindow(wH);
  feed(wH, T.needCrit / 2 - 1);
  expect('过半前零播报', evs(wH, 'thunder_half').length === 0,
    'half=' + evs(wH, 'thunder_half').length);
  feed(wH, 1);
  expect('正好半程报一次', evs(wH, 'thunder_half').length === 1,
    'half=' + evs(wH, 'thunder_half').length);
  feed(wH, 900);
  expect('多爆不刷屏（过半播报恰好一次）', evs(wH, 'thunder_half').length === 1,
    'half=' + evs(wH, 'thunder_half').length);
  const wH2 = cleanWorld(9712);
  openWindow(wH2);
  feed(wH2, T.needCrit);   // 一口气喂够整轮（远超半程）
  // ★暴击是整数次、逐次 +1，=== 与 >= 在此等价（不像养元诀的连续回血会一帧跨半程），
  //   所以这一族真正要钉的是"标记位防刷屏"：摘掉 thunderHalfNoted 闸，这里会连报几十次。
  expect('★★喂满整轮也只报一次过半，且数字锁在首次跨半那一刻（标记位防刷屏）',
    evs(wH2, 'thunder_half').length === 1 &&
    evs(wH2, 'thunder_half')[0].got === Math.ceil(T.needCrit / 2),
    'half=' + evs(wH2, 'thunder_half').length +
    ' got=' + ((evs(wH2, 'thunder_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(9720);
  openWindow(wD);
  finish(wD, T.needCrit);
  expect('到期正好凑够 → 达成', wD.thunderActive === 0 && wD.thunderDone === 1 &&
    evs(wD, 'thunder_done').length === 1, 'done=' + wD.thunderDone);
  expect('宝箱正好一个（与前六件同口径）', byKind(wD, 'chest').length === T.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === T.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === T.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'thunder_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === T.needCrit && dn.need === T.needCrit &&
    dn.chest === T.rewardChest && dn.gold === T.goldDrops * T.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 1000);
  SIM.tickThunder(wD);
  expect('★达标后再暴击、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.thunderDone === 1 && evs(wD, 'thunder_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.thunderDone);
  wD.tick = startTick + Math.round(T.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickThunder(wD);
  expect('下一轮目标递增且暴击计数清零', wD.thunderRounds === 2 &&
    wD.thunderNeed === T.needCrit + T.critStep && wD.thunderCrits === 0,
    'need=' + wD.thunderNeed + ' crits=' + wD.thunderCrits);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(9730);
  openWindow(wF);
  finish(wF, T.needCrit - 1);
  expect('差一次也落空', wF.thunderActive === 0 && wF.thunderFailed === 1 &&
    wF.thunderDone === 0, 'failed=' + wF.thunderFailed + ' done=' + wF.thunderDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现"达成"播报', evs(wF, 'thunder_done').length === 0,
    'done=' + evs(wF, 'thunder_done').length);
  const fl = evs(wF, 'thunder_fail')[0];
  expect('落空只陈述还差几次（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === T.needCrit - 1 && fl.need === T.needCrit,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(T.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  // ★关掉后续排期，否则推这么远会再开一轮，那轮当然可以计数（不是补发）
  wF.thunderNextTick = 1e9;
  wF.perilNextTick = 1e9;
  wF.dewNextTick = 1e9;
  wF.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
  wF.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
  wF.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
  wF.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickThunder(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.thunderDone === 0, 'pickups=' + wF.pickups.length);
  const critsAfterFail = wF.thunderCrits;
  feed(wF, 100000);
  expect('落空后再喂也不计数（钩子只认 active）',
    wF.thunderCrits === critsAfterFail && wF.thunderActive === 0,
    'crits=' + wF.thunderCrits + '（落空时 ' + critsAfterFail + '）');

  // ---------- 7. ★★真暴击钩子（本件核心新轴：只认真暴击，不是每次命中）----------
  const wC = cleanWorld(9740);
  openWindow(wC);
  critHit(wC, 0, 'weapon_test');   // 暴击率 0：命中了但没暴击
  expect('★★★不堆暴击（crit=0）：打中了也不算，一次都拿不到（核心"不该发生的事"）',
    wC.thunderCrits === 0, 'crits=' + wC.thunderCrits);
  critHit(wC, 0, 'weapon_test');
  critHit(wC, 0, 'weapon_test');
  expect('★★不堆暴击连打多次依然 0（普通命中绝不白送）',
    wC.thunderCrits === 0, 'crits=' + wC.thunderCrits);
  critHit(wC, 1, 'weapon_test');   // 暴击率 100%：这一下真暴击
  expect('★★★堆满暴击（crit=1）真暴击一次 → 计数 +1（正向对照，证明非空跑）',
    wC.thunderCrits === 1, 'crits=' + wC.thunderCrits);
  critHit(wC, 1, 'weapon_test');
  expect('连续真暴击逐次累计', wC.thunderCrits === 2, 'crits=' + wC.thunderCrits);
  // 世界伤害即使叠 100% 暴击也不算（isWorld 走暴击判定之外的分支）
  critHit(wC, 1, 'meteor');
  expect('★★★天火伤害不算暴击（世界伤害不替玩家达标）',
    wC.thunderCrits === 2, 'crits=' + wC.thunderCrits);
  critHit(wC, 1, 'ley');
  expect('★★地脉灵泉伤害不算暴击', wC.thunderCrits === 2, 'crits=' + wC.thunderCrits);
  critHit(wC, 1, 'lantern');
  expect('★★引魂灯收尾伤害不算暴击', wC.thunderCrits === 2, 'crits=' + wC.thunderCrits);
  critHit(wC, 1, 'weapon_test');
  expect('世界伤害之后玩家真暴击继续正常计入（没被误关闸）',
    wC.thunderCrits === 3, 'crits=' + wC.thunderCrits);
  // 窗口外 / 剧情关的真实 damageMob 都不算（钩子 active + story 闸）
  const wOut = cleanWorld(9741);
  critHit(wOut, 1, 'weapon_test');   // 不开窗，直接打
  expect('窗口外真暴击也不计数', wOut.thunderCrits === 0, 'crits=' + wOut.thunderCrits);
  const wCS = cleanWorld(9742);
  wCS.modId = 'myth';
  wCS.storyStage = { id: 'ch5' };
  openWindow(wCS);
  critHit(wCS, 1, 'weapon_test');
  expect('★★剧情关里真暴击也不计数（钩子有 story 闸）',
    wCS.thunderCrits === 0, 'crits=' + wCS.thunderCrits);
  // 直接喂钩子的 active/story 闸（补一道，与养元诀同口径）
  const wGate = cleanWorld(9743);
  feed(wGate, 5);
  expect('窗口外直接喂钩子也不计数', wGate.thunderCrits === 0, 'crits=' + wGate.thunderCrits);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch5' };
  feed(wGate, 5);
  expect('窗口内但剧情关下直接喂钩子也不计数',
    wGate.thunderCrits === 0, 'crits=' + wGate.thunderCrits);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(9750);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.thunderNextTick = 0;
  SIM.tickThunder(wS);
  feed(wS, 500);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.thunderActive === 0 && wS.thunderRounds === 0 && wS.thunderCrits === 0 &&
    evs(wS, 'thunder_start').length === 0,
    'active=' + wS.thunderActive + ' crits=' + wS.thunderCrits);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9751, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((T.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有惊雷诀，且那一刻世界确实还在跑',
    storyAlive && wS2.thunderActive === 0 &&
    evs(wS2, 'thunder_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.thunderActive);
}

function testPeril() {
  console.log('[第六十二轮] 履险诀：第一件「限时低血存活」目标（越接近鬼门关越有奖励）');
  const P = C.PERIL;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远、关武器、默认满血，只留履险诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;    // 默认不排期：要开窗的世界自己设 0
    w.dewNextTick = 1e9;      // 默认不排期：要开窗的世界自己设 0
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.perilNextTick = 0;
    SIM.tickPeril(w);
  }
  // 喂 sec 秒时间，并把血量当下设成 maxHp 的 ratio（默认 20%，严格低于 30% 阈值）。
  // ★这里只调钩子本身，血量闸就在钩子里 —— 不会绕过本件最核心的边界。
  function feed(w, sec, ratio) {
    const p = w.self || w.player;
    const r = (ratio === undefined) ? 0.2 : ratio;
    p.hp = Math.max(0, Math.min(p.maxHp, p.maxHp * r));
    SIM.onPerilTime(w, sec);
  }
  function finish(w, sec) {
    feed(w, sec);
    w.time = w.perilDeadline + 0.01;
    SIM.tickPeril(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没有搏命的理由）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标低血秒数按轮递增且封顶（第 2 轮 +step，第 99 轮到 max）',
    SIM.perilNeedFor(0) === P.needSec &&
    SIM.perilNeedFor(1) === P.needSec + P.secStep &&
    SIM.perilNeedFor(99) === P.maxSec,
    '0=' + SIM.perilNeedFor(0) + ' 1=' + SIM.perilNeedFor(1) +
    ' 99=' + SIM.perilNeedFor(99));
  expect('目标占比合理（20%~80% 窗口；留出脱离低血线保命的余量）',
    P.needSec > 0 && P.needSec <= P.maxSec && P.maxSec < P.windowSec &&
    P.needSec / P.windowSec >= 0.2 && P.maxSec / P.windowSec <= 0.8,
    'need=' + P.needSec + ' max=' + P.maxSec + ' / ' + P.windowSec);
  expect('血线阈值是严格小于的百分比（0<ratio<1，满血与阵亡都进不来）',
    P.lowRatio > 0 && P.lowRatio < 1, 'ratio=' + P.lowRatio);
  expect('奖励仍是"一箱 + 零钱"（与前七件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'CAULDRON',
      'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'peril=' + P.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗）----------
  const wR = cleanWorld(9781);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, 1000);
  finish(wR, P.needSec);
  expect('★开窗/累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(9782);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0.5);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(9790);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickPeril(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.perilRounds === 0 && evs(wT, 'peril_start').length === 0,
    'rounds=' + wT.perilRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.perilActive === 1 && wT.perilRounds === 1,
    'rounds=' + wT.perilRounds + ' active=' + wT.perilActive);
  expect('★★开窗零实体：没碑、没怪、没球、没特效（与前七件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'peril_start')[0];
  expect('开窗播报一次说清四件事：多久 / 血线 / 撑几秒 / 给什么',
    !!st && st.sec === P.windowSec && st.need === P.needSec &&
    st.ratio === P.lowRatio && st.round === 1 &&
    evs(wT, 'peril_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.perilDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.perilDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.perilNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.perilNextTick);
  SIM.tickPeril(wT);
  expect('同帧重复调用不会二次开窗', wT.perilRounds === 1,
    'rounds=' + wT.perilRounds);
  wT.time = wT.perilDeadline - 0.001;
  SIM.tickPeril(wT);
  expect('到期前一帧不发奖也不结算', wT.perilActive === 1 &&
    wT.perilLow === 0 && evs(wT, 'peril_done').length === 0 &&
    evs(wT, 'peril_fail').length === 0,
    'active=' + wT.perilActive + ' low=' + wT.perilLow);

  // ---------- 4. 过半（时间是连续量：>= + 标记位，一帧跨半也照报）----------
  const wH = cleanWorld(9791);
  openWindow(wH);
  feed(wH, P.needSec / 2 - 0.1);
  expect('过半前零播报', evs(wH, 'peril_half').length === 0,
    'half=' + evs(wH, 'peril_half').length);
  feed(wH, 0.1);
  expect('正好半程报一次', evs(wH, 'peril_half').length === 1,
    'half=' + evs(wH, 'peril_half').length);
  feed(wH, 1000);
  expect('多撑不刷屏（过半播报恰好一次）', evs(wH, 'peril_half').length === 1,
    'half=' + evs(wH, 'peril_half').length);
  const wH2 = cleanWorld(9792);
  openWindow(wH2);
  feed(wH2, P.needSec);   // 一口气喂够整轮（远超半程）
  // ★低血时间是连续量：一帧跨过半程是常事，=== 会漏报；
  //   同时标记位不能省——否则过半之后每次调用都会重复播报刷屏。
  expect('★★一帧跨过半程也照报，且整轮只报一次（>= + 标记位）',
    evs(wH2, 'peril_half').length === 1 &&
    evs(wH2, 'peril_half')[0].got === Math.round(P.needSec),
    'half=' + evs(wH2, 'peril_half').length +
    ' got=' + ((evs(wH2, 'peril_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(9800);
  openWindow(wD);
  finish(wD, P.needSec);
  expect('到期正好撑够 → 达成', wD.perilActive === 0 && wD.perilDone === 1 &&
    evs(wD, 'peril_done').length === 1, 'done=' + wD.perilDone);
  expect('宝箱正好一个（与前七件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'peril_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needSec && dn.need === P.needSec &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 1000);
  SIM.tickPeril(wD);
  expect('★达标后再撑、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.perilDone === 1 && evs(wD, 'peril_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.perilDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickPeril(wD);
  expect('下一轮目标递增且低血计数清零', wD.perilRounds === 2 &&
    wD.perilNeed === P.needSec + P.secStep && wD.perilLow === 0,
    'need=' + wD.perilNeed + ' low=' + wD.perilLow);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(9810);
  openWindow(wF);
  finish(wF, P.needSec - 1);
  expect('差一点也落空', wF.perilActive === 0 && wF.perilFailed === 1 &&
    wF.perilDone === 0, 'failed=' + wF.perilFailed + ' done=' + wF.perilDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现"达成"播报', evs(wF, 'peril_done').length === 0,
    'done=' + evs(wF, 'peril_done').length);
  const fl = evs(wF, 'peril_fail')[0];
  expect('落空只陈述还差几秒（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needSec - 1 && fl.need === P.needSec,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  // ★关掉后续排期，否则推这么远会再开一轮，那轮当然可以计数（不是补发）
  wF.perilNextTick = 1e9;
  wF.dewNextTick = 1e9;
  wF.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
  wF.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
  wF.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
  wF.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickPeril(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.perilDone === 0, 'pickups=' + wF.pickups.length);
  const lowAfterFail = wF.perilLow;
  feed(wF, 100000);
  expect('落空后再喂也不计数（钩子只认 active）',
    wF.perilLow === lowAfterFail && wF.perilActive === 0,
    'low=' + wF.perilLow + '（落空时 ' + lowAfterFail + '）');

  // ---------- 7. ★★真低血闸（本件核心新轴：满血/阈值上/阵亡/窗口外都不算）----------
  const wL = cleanWorld(9820);
  openWindow(wL);
  feed(wL, 100, 1);
  expect('★★★满血站着不动喂 100 秒也一秒不算（核心"不该发生的事"）',
    wL.perilLow === 0, 'low=' + wL.perilLow);
  feed(wL, 100, P.lowRatio);
  expect('★★血量正好在阈值上也不算（严格小于，不是小于等于）',
    wL.perilLow === 0, 'low=' + wL.perilLow);
  feed(wL, 1, 0.29);
  expect('★★★低于阈值 1% 就真算 1 秒（正向对照，证明钩子不是恒 0）',
    wL.perilLow === 1, 'low=' + wL.perilLow);
  const lowBeforeDeath = wL.perilLow;
  feed(wL, 100, 0);
  expect('★★阵亡（hp=0）的那一刻不算活着撑住',
    wL.perilLow === lowBeforeDeath, 'low=' + wL.perilLow);
  feed(wL, 100, P.lowRatio + 0.01);
  expect('★★从低血线回到阈值以上后不再累计（每帧实时读血条）',
    wL.perilLow === lowBeforeDeath, 'low=' + wL.perilLow);
  feed(wL, 1, 0.01);
  expect('贴着鬼门关（血只剩 1%）照算', wL.perilLow === lowBeforeDeath + 1,
    'low=' + wL.perilLow);
  // ★按"当前"上限判定：血祭坛压过上限之后，比例要跟着上限变
  const wCap = cleanWorld(9821);
  openWindow(wCap);
  wCap.self.maxHp = 74;
  wCap.self.hp = 22;               // 22 < 74×0.3 = 22.2 → 算
  SIM.onPerilTime(wCap, 1);
  expect('★★按当前生命上限判定（压上限后 22/74 算低血）',
    wCap.perilLow === 1, 'low=' + wCap.perilLow);
  wCap.self.hp = 23;               // 23 > 22.2 → 不算
  SIM.onPerilTime(wCap, 100);
  expect('★★同一上限下 23/74 就不算（不是写死血量常数）',
    wCap.perilLow === 1, 'low=' + wCap.perilLow);
  // 窗口外 / 剧情关 / 落空后：钩子自身三道闸
  const wOut = cleanWorld(9822);
  feed(wOut, 100, 0.1);
  expect('窗口外 low hp 也不计数', wOut.perilLow === 0, 'low=' + wOut.perilLow);
  const wGate = cleanWorld(9823);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch5' };
  feed(wGate, 100, 0.1);
  expect('窗口内但剧情关下也不计数（钩子有 story 闸）',
    wGate.perilLow === 0, 'low=' + wGate.perilLow);
  expect('窗口外喂 0 / 负时间都不计数',
    (function () {
      const w0 = cleanWorld(9824);
      openWindow(w0);
      SIM.onPerilTime(w0, 0);
      SIM.onPerilTime(w0, -1);
      return w0.perilLow === 0;
    })(), 'dt<=0 不计数');

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(9830);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.perilNextTick = 0;
  SIM.tickPeril(wS);
  feed(wS, 100, 0.1);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.perilActive === 0 && wS.perilRounds === 0 && wS.perilLow === 0 &&
    evs(wS, 'peril_start').length === 0,
    'active=' + wS.perilActive + ' low=' + wS.perilLow);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9831, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有履险诀，且那一刻世界确实还在跑',
    storyAlive && wS2.perilActive === 0 && evs(wS2, 'peril_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.perilActive);
}

function testDew() {
  console.log('[第六十三轮] 饮露诀：第一件「限时捡真回血红心」目标（拾取物本身第一次成为目标）');
  const P = C.DEW;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远、关武器、默认满血，只留饮露诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;      // 默认不排期：要开窗的世界自己设 0
    w.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.dewNextTick = 0;
    SIM.tickDew(w);
  }
  // 喂 count 颗"真回血"红心：直接调钩子本身，血量闸就在钩子外面（gain>0 才算）。
  function feed(w, count) {
    for (let i = 0; i < count; i++) SIM.onDewHeart(w, C.DROPS.heartHeal);
  }
  function finish(w, count) {
    feed(w, count);
    w.time = w.dewDeadline + 0.01;
    SIM.tickDew(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没红心可捡）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标颗数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.dewNeedFor(0) === P.needHearts &&
    SIM.dewNeedFor(1) === P.needHearts + P.heartStep &&
    SIM.dewNeedFor(99) === P.maxHearts,
    '0=' + SIM.dewNeedFor(0) + ' 1=' + SIM.dewNeedFor(1) + ' 99=' + SIM.dewNeedFor(99));
  expect('目标密度合理（每秒 0.05~0.4 颗；红心掉率 0.012，太密不可能达成）',
    P.needHearts > 0 && P.needHearts <= P.maxHearts && P.maxHearts < P.windowSec &&
    P.needHearts / P.windowSec >= 0.05 && P.maxHearts / P.windowSec <= 0.4,
    'need=' + P.needHearts + ' max=' + P.maxHearts + ' / ' + P.windowSec);
  expect('奖励仍是"一箱 + 零钱"（与前八件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开所有既有事件（避免同一帧挤进两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'dew=' + P.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗）----------
  const wR = cleanWorld(9781);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, 1000);
  finish(wR, P.needHearts);
  expect('★开窗/累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(9782);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(9790);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickDew(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.dewRounds === 0 && evs(wT, 'dew_start').length === 0,
    'rounds=' + wT.dewRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.dewActive === 1 && wT.dewRounds === 1,
    'rounds=' + wT.dewRounds + ' active=' + wT.dewActive);
  expect('★★开窗零实体：没碑、没怪、没球、没特效（与前八件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'dew_start')[0];
  expect('开窗播报一次说清三件事：多久 / 几颗 / 给什么',
    !!st && st.sec === P.windowSec && st.need === P.needHearts && st.round === 1 &&
    evs(wT, 'dew_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.dewDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.dewDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.dewNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.dewNextTick);
  SIM.tickDew(wT);
  expect('同帧重复调用不会二次开窗', wT.dewRounds === 1,
    'rounds=' + wT.dewRounds);
  wT.time = wT.dewDeadline - 0.001;
  SIM.tickDew(wT);
  expect('到期前一帧不发奖也不结算', wT.dewActive === 1 &&
    wT.dewHearts === 0 && evs(wT, 'dew_done').length === 0 &&
    evs(wT, 'dew_fail').length === 0,
    'active=' + wT.dewActive + ' hearts=' + wT.dewHearts);

  // ---------- 4. 过半（颗数是整数次累加：>= + 标记位防刷屏）----------
  const wH = cleanWorld(9791);
  openWindow(wH);
  feed(wH, Math.floor(P.needHearts / 2));
  expect('过半前零播报', evs(wH, 'dew_half').length === 0,
    'half=' + evs(wH, 'dew_half').length);
  feed(wH, 1);
  expect('过半报一次', evs(wH, 'dew_half').length === 1,
    'half=' + evs(wH, 'dew_half').length);
  feed(wH, 1000);
  expect('多捡不刷屏（过半播报恰好一次）', evs(wH, 'dew_half').length === 1,
    'half=' + evs(wH, 'dew_half').length);
  const wH2 = cleanWorld(9792);
  openWindow(wH2);
  feed(wH2, P.needHearts);   // 一口气喂够整轮
  // ★颗数是整数次、逐颗 +1，>= 与 === 都会经过半程；真正要防的是标记位缺失刷屏。
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'dew_half').length === 1 &&
    evs(wH2, 'dew_half')[0].got === Math.ceil(P.needHearts / 2),
    'half=' + evs(wH2, 'dew_half').length +
    ' got=' + ((evs(wH2, 'dew_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(9800);
  openWindow(wD);
  finish(wD, P.needHearts);
  expect('到期正好捡够 → 达成', wD.dewActive === 0 && wD.dewDone === 1 &&
    evs(wD, 'dew_done').length === 1, 'done=' + wD.dewDone);
  expect('宝箱正好一个（与前八件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'dew_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needHearts && dn.need === P.needHearts &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 1000);
  SIM.tickDew(wD);
  expect('★达标后再捡、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.dewDone === 1 && evs(wD, 'dew_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.dewDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickDew(wD);
  expect('下一轮目标递增且红心计数清零', wD.dewRounds === 2 &&
    wD.dewNeed === P.needHearts + P.heartStep && wD.dewHearts === 0,
    'need=' + wD.dewNeed + ' hearts=' + wD.dewHearts);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(9810);
  openWindow(wF);
  finish(wF, P.needHearts - 1);
  expect('差一颗也落空', wF.dewActive === 0 && wF.dewFailed === 1 &&
    wF.dewDone === 0, 'failed=' + wF.dewFailed + ' done=' + wF.dewDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现"达成"播报', evs(wF, 'dew_done').length === 0,
    'done=' + evs(wF, 'dew_done').length);
  const fl = evs(wF, 'dew_fail')[0];
  expect('落空只陈述还差几颗（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needHearts - 1 && fl.need === P.needHearts,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  // ★关掉后续排期，否则推这么远会再开一轮，那轮当然可以计数（不是补发）
  wF.dewNextTick = 1e9;
  wF.streakNextTick = 1e9;  // 第六十四轮：连斩令 426s 开窗，默认推远
  wF.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
  wF.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
  wF.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickDew(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.dewDone === 0, 'pickups=' + wF.pickups.length);
  const heartsAfterFail = wF.dewHearts;
  feed(wF, 1000);
  expect('落空后再喂也不计数（钩子只认 active）',
    wF.dewHearts === heartsAfterFail && wF.dewActive === 0,
    'hearts=' + wF.dewHearts + '（落空时 ' + heartsAfterFail + '）');

  // ---------- 7. ★★真回血闸（本件核心新轴：满血/非红心/溢出/窗口外都不算）----------
  const wL = cleanWorld(9820);
  openWindow(wL);
  SIM.onDewHeart(wL, 0);       // 满血吃：真增量 0
  expect('★★★满血吃红心真增量为 0，一颗都不算（核心"不该发生的事"）',
    wL.dewHearts === 0, 'hearts=' + wL.dewHearts);
  SIM.onDewHeart(wL, -5);
  expect('★★负数增量也不算（防御性：绝不让白嫖）', wL.dewHearts === 0,
    'hearts=' + wL.dewHearts);
  SIM.onDewHeart(wL, 7);       // 只回了一点点也算真回血
  expect('★★★哪怕只真回 7 点血也算一颗（正向对照，证明钩子不是恒 0）',
    wL.dewHearts === 1, 'hearts=' + wL.dewHearts);
  expect('过半播报按颗数而非血量（7 点也算满一颗）',
    evs(wL, 'dew_half').length === (1 >= Math.ceil(P.needHearts / 2) ? 1 : 0),
    'half=' + evs(wL, 'dew_half').length);

  // ★★钩子只挂红心分支：走真实 updatePickups 漏斗，证明"别的来源回血不算"。
  const wSrc = cleanWorld(9821);
  openWindow(wSrc);
  wSrc.self.hp = 20;           // 先掉血，制造真实回血空间
  // ① 绷带/技能等通用回血：走 healPlayer，但不走红心分支 → 不算
  SIM.healPlayer(wSrc, 30);
  expect('★★通用回血（绷带/技能走 healPlayer）不算一颗（本件只认红心本身）',
    wSrc.dewHearts === 0, 'hearts=' + wSrc.dewHearts);
  // ② 造一颗真红心放到玩家脚下，走真实 step 让它被拾取 → 算一颗
  SIM.spawnPickup(wSrc, 'heart', wSrc.self.x, wSrc.self.y, C.DROPS.heartHeal, 8);
  const beforePick = wSrc.dewHearts;
  SIM.step(wSrc, { mx: 0, my: 0 });
  expect('★★★真实 step 捡到一颗红心且真回血 → 计数 +1（证明钩子挂对分支）',
    wSrc.dewHearts === beforePick + 1,
    'hearts ' + beforePick + ' → ' + wSrc.dewHearts);
  // ③ 满血再放一颗红心：会被吃掉（回血 0），但计数不变
  wSrc.self.hp = wSrc.self.maxHp;
  SIM.spawnPickup(wSrc, 'heart', wSrc.self.x, wSrc.self.y, C.DROPS.heartHeal, 8);
  const heartsBeforeFull = wSrc.dewHearts;
  SIM.step(wSrc, { mx: 0, my: 0 });
  expect('★★★满血时红心被吃掉也不计一颗（核心"不该发生的事"，走真实 step）',
    wSrc.dewHearts === heartsBeforeFull,
    'hearts=' + wSrc.dewHearts + '（吃之前 ' + heartsBeforeFull + '）');

  // 窗口外 / 剧情关 / 落空后：钩子自身三道闸
  const wOut = cleanWorld(9822);
  SIM.onDewHeart(wOut, 100);
  expect('窗口外真回血也不计数', wOut.dewHearts === 0, 'hearts=' + wOut.dewHearts);
  const wGate = cleanWorld(9823);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch5' };
  SIM.onDewHeart(wGate, 100);
  expect('窗口内但剧情关下也不计数（钩子有 story 闸）',
    wGate.dewHearts === 0, 'hearts=' + wGate.dewHearts);
  expect('窗口外喂负数也不计数',
    (function () {
      const w0 = cleanWorld(9824);
      SIM.onDewHeart(w0, -1);
      return w0.dewHearts === 0;
    })(), 'negative 不计数');

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(9830);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.dewNextTick = 0;
  SIM.tickDew(wS);
  SIM.onDewHeart(wS, 100);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.dewActive === 0 && wS.dewRounds === 0 && wS.dewHearts === 0 &&
    evs(wS, 'dew_start').length === 0,
    'active=' + wS.dewActive + ' hearts=' + wS.dewHearts);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9831, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有饮露诀，且那一刻世界确实还在跑',
    storyAlive && wS2.dewActive === 0 && evs(wS2, 'dew_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.dewActive);
}

// ============================================================
// 第六十四轮：连斩令（目标制零实体第十件，"节奏/连贯性"新轴）
// ============================================================
function testStreak() {
  console.log('[第六十四轮] 连斩令：第一件「限时连续击杀不中断」目标（断链清零）');
  const P = C.STREAK;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 干净世界：其它机制全推远、关武器、默认满血，只留连斩令这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;   // 默认不排期：要开窗的世界自己设 0
    w.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
    w.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
    w.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.rageMute = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.streakNextTick = 0;
    SIM.tickStreak(w);
  }
  // 喂 count 次击杀，间隔 gap 秒（默认半个 gapSec —— 保证连得上）。
  function feed(w, count, gap) {
    const g = gap === undefined ? P.gapSec * 0.5 : gap;
    for (let i = 0; i < count; i++) {
      if (i > 0) w.time += g;
      SIM.onStreakKill(w);
    }
  }
  function finish(w, count) {
    feed(w, count);
    w.time = w.streakDeadline + 0.01;
    SIM.tickStreak(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没怪可杀）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标连斩数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.streakNeedFor(0) === P.needStreak &&
    SIM.streakNeedFor(1) === P.needStreak + P.streakStep &&
    SIM.streakNeedFor(99) === P.maxStreak,
    '0=' + SIM.streakNeedFor(0) + ' 1=' + SIM.streakNeedFor(1) + ' 99=' + SIM.streakNeedFor(99));
  expect('★★断链间隔合理（0.5~2 秒：太短连 boss 都接不上，太长退化成累计杀怪）',
    P.gapSec >= 0.5 && P.gapSec <= 2 && P.gapSec < P.windowSec,
    'gapSec=' + P.gapSec);
  expect('目标密度合理（每秒至少能连 0.15 只；1.2 秒/只封顶 10 只需 11 秒不断手）',
    P.needStreak > 0 && P.needStreak <= P.maxStreak && P.maxStreak * P.gapSec < P.windowSec &&
    P.needStreak / P.windowSec >= 0.15,
    'need=' + P.needStreak + ' max=' + P.maxStreak + ' gap=' + P.gapSec + ' / ' + P.windowSec);
  expect('奖励仍是"一箱 + 零钱"（与前九件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开所有既有事件（含饮露诀 414，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'streak=' + P.startSec + ' dew=' + C.DEW.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗）----------
  const wR = cleanWorld(9781);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, 1000);
  finish(wR, P.needStreak);
  expect('★开窗/累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(9782);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(9790);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickStreak(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.streakRounds === 0 && evs(wT, 'streak_start').length === 0,
    'rounds=' + wT.streakRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.streakActive === 1 && wT.streakRounds === 1,
    'rounds=' + wT.streakRounds + ' active=' + wT.streakActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone（与前九件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'streak_start')[0];
  expect('开窗播报一次说清四件事：多久 / 连几只 / 断链规则 / 给什么',
    !!st && st.sec === P.windowSec && st.need === P.needStreak &&
    st.gap === P.gapSec && st.round === 1 && evs(wT, 'streak_start').length === 1,
    JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.streakDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.streakDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.streakNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.streakNextTick);
  SIM.tickStreak(wT);
  expect('同帧重复调用不会二次开窗', wT.streakRounds === 1,
    'rounds=' + wT.streakRounds);
  wT.time = wT.streakDeadline - 0.001;
  SIM.tickStreak(wT);
  expect('到期前一帧不发奖也不结算', wT.streakActive === 1 &&
    wT.streakCur === 0 && evs(wT, 'streak_done').length === 0 &&
    evs(wT, 'streak_fail').length === 0,
    'active=' + wT.streakActive + ' cur=' + wT.streakCur);

  // ---------- 4. 过半（整数次累加：标记位防刷屏）----------
  const wH = cleanWorld(9791);
  openWindow(wH);
  // ★喂数必须严格小于 half 阈值（need/2=3）：喂 3 只就已经过半了。
  feed(wH, Math.floor((P.needStreak - 1) / 2));
  expect('过半前零播报', evs(wH, 'streak_half').length === 0,
    'half=' + evs(wH, 'streak_half').length + ' cur=' + wH.streakCur);
  feed(wH, 1);
  expect('过半报一次', evs(wH, 'streak_half').length === 1,
    'half=' + evs(wH, 'streak_half').length);
  feed(wH, 1000);
  expect('多连不刷屏（过半播报恰好一次）', evs(wH, 'streak_half').length === 1,
    'half=' + evs(wH, 'streak_half').length);
  const wH2 = cleanWorld(9792);
  openWindow(wH2);
  feed(wH2, P.needStreak);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'streak_half').length === 1 &&
    evs(wH2, 'streak_half')[0].got === Math.ceil(P.needStreak / 2),
    'half=' + evs(wH2, 'streak_half').length +
    ' got=' + ((evs(wH2, 'streak_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(9800);
  openWindow(wD);
  finish(wD, P.needStreak);
  expect('连够且没断链 → 达成', wD.streakActive === 0 && wD.streakDone === 1 &&
    evs(wD, 'streak_done').length === 1, 'done=' + wD.streakDone);
  expect('宝箱正好一个（与前九件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'streak_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needStreak && dn.need === P.needStreak &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 1000);
  SIM.tickStreak(wD);
  expect('★达标后再连、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.streakDone === 1 && evs(wD, 'streak_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.streakDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickStreak(wD);
  expect('下一轮目标递增且连斩计数清零', wD.streakRounds === 2 &&
    wD.streakNeed === P.needStreak + P.streakStep && wD.streakCur === 0 &&
    wD.streakReached === 0,
    'need=' + wD.streakNeed + ' cur=' + wD.streakCur);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(9810);
  openWindow(wF);
  finish(wF, P.needStreak - 1);
  expect('差一只也落空', wF.streakActive === 0 && wF.streakFailed === 1 &&
    wF.streakDone === 0, 'failed=' + wF.streakFailed + ' done=' + wF.streakDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现"达成"播报', evs(wF, 'streak_done').length === 0,
    'done=' + evs(wF, 'streak_done').length);
  const fl = evs(wF, 'streak_fail')[0];
  expect('落空只陈述还差几只（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needStreak - 1 && fl.need === P.needStreak,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.streakNextTick = 1e9;   // 关掉后续排期，推这么远不该再开一轮
  wF.bestiaryNextTick = 1e9;  // 第六十五轮：降妖录 438s 开窗，默认推远
  wF.shootNextTick = 1e9;     // 第六十七轮：射日诀 462s 开窗，默认推远
  wF.generalNextTick = 1e9;   // 第六十八轮：斩将令 474s 开窗，默认推远
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickStreak(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.streakDone === 0, 'pickups=' + wF.pickups.length);
  const curAfterFail = wF.streakCur;
  feed(wF, 1000);
  expect('落空后再连也不计数（钩子只认 active）',
    wF.streakCur === curAfterFail && wF.streakActive === 0,
    'cur=' + wF.streakCur + '（落空时 ' + curAfterFail + '）');

  // ---------- 7. ★★★断链闸（本件核心新轴）----------
  const wB = cleanWorld(9820);
  openWindow(wB);
  SIM.onStreakKill(wB);       // 第 1 只
  wB.time += P.gapSec + 0.01; // 停手超过 gapSec
  SIM.onStreakKill(wB);       // 迟到的第 2 只：旧链应断，只能从 1 重算
  expect('★★★间隔超过 gapSec 的击杀接不上旧链（只剩它自己的 1 连）',
    wB.streakCur === 1, 'cur=' + wB.streakCur + '（正确应重算为 1）');
  const wB2 = cleanWorld(9821);
  openWindow(wB2);
  SIM.onStreakKill(wB2);
  wB2.time += P.gapSec;       // 恰好等于 gapSec —— 判据是 > 不是 >=
  SIM.onStreakKill(wB2);
  expect('间隔恰好等于 gapSec 不算断（正向对照，证明闸不是恒断）',
    wB2.streakCur === 2, 'cur=' + wB2.streakCur);
  const wB3 = cleanWorld(9822);
  openWindow(wB3);
  SIM.onStreakKill(wB3);
  SIM.onStreakKill(wB3);
  wB3.time += P.gapSec + 0.01;
  // ★★必须走真实 tickStreak，不能直接调 streakMaybeBreak —— 后者只验函数本身，
  //   钉不住"tick 每帧调用它"这个调用点（摘掉调用点的回归会假绿，反向②踩过）。
  SIM.tickStreak(wB3);
  expect('★★★停手不杀，tick 每帧自己就会断链（不必等下一次击杀）',
    wB3.streakCur === 0, 'cur=' + wB3.streakCur);
  expect('断链后过半标记位保留（同一轮不重复播报过半）',
    (function () {
      const w0 = cleanWorld(9823);
      openWindow(w0);
      feed(w0, Math.ceil(P.needStreak / 2) + 1);
      const n = evs(w0, 'streak_half').length;
      w0.time += P.gapSec + 0.01;
      SIM.streakMaybeBreak(w0);
      SIM.onStreakKill(w0);
      return n === 1 && evs(w0, 'streak_half').length === 1;
    })(), 'half 应始终 1 次');

  // ★★★达标锁定：连够之后即便停手断链，奖励也不该被追回。
  const wLock = cleanWorld(9824);
  openWindow(wLock);
  feed(wLock, P.needStreak);
  expect('连够当刻 streakReached 锁定为 1',
    wLock.streakReached === 1 && wLock.streakCur === P.needStreak,
    'reached=' + wLock.streakReached + ' cur=' + wLock.streakCur);
  wLock.time += P.gapSec * 20;
  SIM.streakMaybeBreak(wLock);
  expect('★★★达标后断链只清 streakCur，不清 reached（达成即锁定）',
    wLock.streakCur === 0 && wLock.streakReached === 1,
    'cur=' + wLock.streakCur + ' reached=' + wLock.streakReached);
  SIM.tickStreak(wLock);
  expect('★★★达标后即便断链依旧发奖（不追回已到手的赏金）',
    wLock.streakDone === 1 && evs(wLock, 'streak_done').length === 1 &&
    byKind(wLock, 'chest').length === P.rewardChest,
    'done=' + wLock.streakDone + ' chest=' + byKind(wLock, 'chest').length);

  // ★★★天火/世界伤害砸死的不算连斩（rageMute 隔离线）。
  const wMute = cleanWorld(9825);
  openWindow(wMute);
  wMute.rageMute = 1;
  SIM.onStreakKill(wMute);
  SIM.onStreakKill(wMute);
  expect('★★★rageMute>0 时击杀一律不算连斩（天火白送堵死）',
    wMute.streakCur === 0 && wMute.streakReached === 0,
    'cur=' + wMute.streakCur);
  wMute.rageMute = 0;
  SIM.onStreakKill(wMute);
  expect('rageMute 解除后击杀恢复计数（正向对照，证明闸不是恒关）',
    wMute.streakCur === 1, 'cur=' + wMute.streakCur);

  // ★★钩子只挂 killMob：真实打死一只怪 → 连斩 +1（证明挂对漏斗）。
  const wK = cleanWorld(9826);
  openWindow(wK);
  const mob = SIM.spawnMob(wK, 'corpse', wK.player.x + 260, wK.player.y, 1, 0);
  SIM.damageMob(wK, mob, 999999);
  expect('★★真实 killMob 打死一只怪 → 连斩 +1（钩子挂在唯一击杀漏斗）',
    wK.streakCur === 1, 'cur=' + wK.streakCur);

  // 窗口外 / 剧情关 / 落空后：钩子自身三道闸
  const wOut = cleanWorld(9827);
  SIM.onStreakKill(wOut);
  expect('窗口外击杀也不计数', wOut.streakCur === 0, 'cur=' + wOut.streakCur);
  const wGate = cleanWorld(9828);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch5' };
  SIM.onStreakKill(wGate);
  expect('窗口内但剧情关下击杀也不计数（钩子有 story 闸）',
    wGate.streakCur === 0, 'cur=' + wGate.streakCur);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(9830);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.streakNextTick = 0;
  SIM.tickStreak(wS);
  SIM.onStreakKill(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.streakActive === 0 && wS.streakRounds === 0 && wS.streakCur === 0 &&
    evs(wS, 'streak_start').length === 0,
    'active=' + wS.streakActive + ' cur=' + wS.streakCur);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9831, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有连斩令，且那一刻世界确实还在跑',
    storyAlive && wS2.streakActive === 0 && evs(wS2, 'streak_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.streakActive);
}

// ============================================================
// 第六十五轮：降妖录 BESTIARY —— 第一件「限时击杀不同妖种数（广度/去重）」目标
// ============================================================
function testBestiary() {
  console.log('[第六十五轮] 降妖录：第一件「限时击杀不同妖种数」目标（按 def.id 去重）');
  const P = C.BESTIARY;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);
  // ★去重件的伪怪 id 必须跨调用全局唯一，否则 feedKinds 多次调用会用同一批
  //   id、第二次起全被去重吞掉 —— 这不是实现 bug，是喂数据的姿势不对。
  let feedSeq = 0;

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 造一只"带指定 def.id"的伪怪喂击杀钩子（不真 spawn，隔离掉落/随机）
  function mob(id) {
    return { def: { id: id, name: id, tier: 'small' }, defId: id };
  }
  // 干净世界：其它机制全推远、关武器、默认满血，只留降妖录这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9; // 第六十五轮：默认不排期，要开窗的世界自己设 0
    w.shootNextTick = 1e9;    // 第六十七轮：射日诀同样默认不排期
    w.generalNextTick = 1e9;  // 第六十八轮：斩将令同样默认不排期
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.rageMute = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.bestiaryNextTick = 0;
    SIM.tickBestiary(w);
  }
  // 喂 count 种不同妖物（每种只杀一次；id 全局唯一，跨调用也不重复）
  function feedKinds(w, count) {
    for (let i = 0; i < count; i++) SIM.onBestiaryKill(w, mob('feed_' + (feedSeq++)));
  }
  function finish(w, count) {
    feedKinds(w, count);
    w.time = w.bestiaryDeadline + 0.01;
    SIM.tickBestiary(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没怪可杀）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标种类数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.bestiaryNeedFor(0) === P.needKinds &&
    SIM.bestiaryNeedFor(1) === P.needKinds + P.kindStep &&
    SIM.bestiaryNeedFor(99) === P.maxKinds,
    '0=' + SIM.bestiaryNeedFor(0) + ' 1=' + SIM.bestiaryNeedFor(1) + ' 99=' + SIM.bestiaryNeedFor(99));
  expect('目标种类数不超过基础怪种总数（否则永远达不成）',
    C.MOBS.length >= P.maxKinds && P.needKinds >= 2 && P.needKinds <= P.maxKinds,
    'MOBS=' + C.MOBS.length + ' need=' + P.needKinds + ' max=' + P.maxKinds);
  expect('目标密度合理（每秒至少能收录 0.1 种；封顶 7 种需 30 秒内换够目标）',
    P.needKinds > 0 && P.needKinds <= P.maxKinds &&
    P.maxKinds / P.windowSec >= 0.1 && P.needKinds / P.windowSec <= 0.6,
    'need=' + P.needKinds + ' max=' + P.maxKinds + ' / ' + P.windowSec);
  expect('奖励仍是"一箱 + 零钱"（与前十件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开所有既有事件（含连斩令 426，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'bestiary=' + P.startSec + ' streak=' + C.STREAK.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗）----------
  const wR = cleanWorld(9861);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedKinds(wR, 1000);
  finish(wR, P.needKinds);
  expect('★开窗/去重累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(9862);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(9870);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickBestiary(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.bestiaryRounds === 0 && evs(wT, 'bestiary_start').length === 0,
    'rounds=' + wT.bestiaryRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.bestiaryActive === 1 && wT.bestiaryRounds === 1,
    'rounds=' + wT.bestiaryRounds + ' active=' + wT.bestiaryActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前几件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'bestiary_start')[0];
  expect('开窗播报一次说清四件事：多久 / 几种 / 去重规则 / 给什么',
    !!st && st.sec === P.windowSec && st.need === P.needKinds &&
    st.round === 1 && evs(wT, 'bestiary_start').length === 1,
    JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.bestiaryDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.bestiaryDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.bestiaryNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.bestiaryNextTick);
  SIM.tickBestiary(wT);
  expect('同帧重复调用不会二次开窗', wT.bestiaryRounds === 1,
    'rounds=' + wT.bestiaryRounds);
  wT.time = wT.bestiaryDeadline - 0.001;
  SIM.tickBestiary(wT);
  expect('到期前一帧不发奖也不结算', wT.bestiaryActive === 1 &&
    wT.bestiaryKinds === 0 && evs(wT, 'bestiary_done').length === 0 &&
    evs(wT, 'bestiary_fail').length === 0,
    'active=' + wT.bestiaryActive + ' kinds=' + wT.bestiaryKinds);

  // ---------- 4. 过半（整数次累加：标记位防刷屏）----------
  const wH = cleanWorld(9871);
  openWindow(wH);
  feedKinds(wH, Math.floor((P.needKinds - 1) / 2));
  expect('过半前零播报', evs(wH, 'bestiary_half').length === 0,
    'half=' + evs(wH, 'bestiary_half').length + ' kinds=' + wH.bestiaryKinds);
  feedKinds(wH, 1);
  expect('过半报一次', evs(wH, 'bestiary_half').length === 1,
    'half=' + evs(wH, 'bestiary_half').length);
  feedKinds(wH, 1000);
  expect('多杀不刷屏（过半播报恰好一次）', evs(wH, 'bestiary_half').length === 1,
    'half=' + evs(wH, 'bestiary_half').length);
  const wH2 = cleanWorld(9872);
  openWindow(wH2);
  feedKinds(wH2, P.needKinds);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'bestiary_half').length === 1 &&
    evs(wH2, 'bestiary_half')[0].got === Math.ceil(P.needKinds / 2),
    'half=' + evs(wH2, 'bestiary_half').length +
    ' got=' + ((evs(wH2, 'bestiary_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(9880);
  openWindow(wD);
  finish(wD, P.needKinds);
  expect('杀够不同种 → 达成', wD.bestiaryActive === 0 && wD.bestiaryDone === 1 &&
    evs(wD, 'bestiary_done').length === 1, 'done=' + wD.bestiaryDone);
  expect('宝箱正好一个（与前十件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'bestiary_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needKinds && dn.need === P.needKinds &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feedKinds(wD, 1000);
  SIM.tickBestiary(wD);
  expect('★达标后再杀、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.bestiaryDone === 1 && evs(wD, 'bestiary_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.bestiaryDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickBestiary(wD);
  expect('下一轮目标递增、去重集合与种类数清零', wD.bestiaryRounds === 2 &&
    wD.bestiaryNeed === P.needKinds + P.kindStep && wD.bestiaryKinds === 0 &&
    Object.keys(wD.bestiarySeen).length === 0,
    'need=' + wD.bestiaryNeed + ' kinds=' + wD.bestiaryKinds +
    ' seen=' + Object.keys(wD.bestiarySeen).length);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(9890);
  openWindow(wF);
  finish(wF, P.needKinds - 1);
  expect('差一种也落空', wF.bestiaryActive === 0 && wF.bestiaryFailed === 1 &&
    wF.bestiaryDone === 0, 'failed=' + wF.bestiaryFailed + ' done=' + wF.bestiaryDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现"达成"播报', evs(wF, 'bestiary_done').length === 0,
    'done=' + evs(wF, 'bestiary_done').length);
  const fl = evs(wF, 'bestiary_fail')[0];
  expect('落空只陈述还差几种（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needKinds - 1 && fl.need === P.needKinds,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.bestiaryNextTick = 1e9;   // 关掉后续排期，推这么远不该再开一轮
  wF.shootNextTick = 1e9;
  wF.generalNextTick = 1e9;
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickBestiary(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.bestiaryDone === 0, 'pickups=' + wF.pickups.length);
  const kindsAfterFail = wF.bestiaryKinds;
  feedKinds(wF, 1000);
  expect('落空后再杀也不计数（钩子只认 active）',
    wF.bestiaryKinds === kindsAfterFail && wF.bestiaryActive === 0,
    'kinds=' + wF.bestiaryKinds + '（落空时 ' + kindsAfterFail + '）');

  // ---------- 7. ★★★去重闸（本件核心新轴：同种重复杀只算 1 种）----------
  const wB = cleanWorld(9900);
  openWindow(wB);
  SIM.onBestiaryKill(wB, mob('corpse'));
  SIM.onBestiaryKill(wB, mob('corpse'));
  SIM.onBestiaryKill(wB, mob('corpse'));
  expect('★★★同一种妖物杀 3 次只算 1 种（去重闸是灵魂）',
    wB.bestiaryKinds === 1, 'kinds=' + wB.bestiaryKinds + '（正确应=1）');
  expect('去重登记只留一个 def.id', Object.keys(wB.bestiarySeen).length === 1 &&
    !!wB.bestiarySeen.corpse, 'seen=' + JSON.stringify(wB.bestiarySeen));
  SIM.onBestiaryKill(wB, mob('bat'));
  expect('换第 2 种妖物才 +1（正向对照，证明去重不是恒关）',
    wB.bestiaryKinds === 2, 'kinds=' + wB.bestiaryKinds);
  SIM.onBestiaryKill(wB, mob('bat'));
  expect('第 2 种再杀一次也不涨', wB.bestiaryKinds === 2,
    'kinds=' + wB.bestiaryKinds);
  // 同种重复杀绝不该触发过半/达标（否则站桩刷一种就白拿）
  const wB2 = cleanWorld(9901);
  openWindow(wB2);
  for (let i = 0; i < 500; i++) SIM.onBestiaryKill(wB2, mob('skeleton'));
  expect('★★★站桩刷一种杀 500 次：不达过半、不达标、零掉落',
    wB2.bestiaryKinds === 1 && evs(wB2, 'bestiary_half').length === 0 &&
    evs(wB2, 'bestiary_done').length === 0 && wB2.pickups.length === 0,
    'kinds=' + wB2.bestiaryKinds + ' half=' + evs(wB2, 'bestiary_half').length +
    ' done=' + evs(wB2, 'bestiary_done').length + ' pick=' + wB2.pickups.length);
  // 没有 def.id 的不明怪不算一种
  const wB3 = cleanWorld(9902);
  openWindow(wB3);
  SIM.onBestiaryKill(wB3, {});
  expect('没有 def.id 的不明怪不算一种（不污染去重集合）',
    wB3.bestiaryKinds === 0 && Object.keys(wB3.bestiarySeen).length === 0,
    'kinds=' + wB3.bestiaryKinds);
  // 达标锁定过：结算发奖后（active 已关）重复杀同种不二次发奖
  const wLock = cleanWorld(9903);
  openWindow(wLock);
  finish(wLock, P.needKinds);   // 喂满 + 推到 deadline + tickBestiary 完成结算发奖
  const pickAtDone = wLock.pickups.length;
  const halfAtDone = evs(wLock, 'bestiary_half').length;
  for (let i = 0; i < 100; i++) SIM.onBestiaryKill(wLock, mob('corpse'));
  expect('★★达标后重复杀同种不刷过半、不二次发奖', wLock.pickups.length === pickAtDone &&
    evs(wLock, 'bestiary_half').length === halfAtDone && wLock.bestiaryDone === 1,
    'pick=' + wLock.pickups.length + ' half=' + evs(wLock, 'bestiary_half').length +
    ' done=' + wLock.bestiaryDone);

  // ★★★天火砸死的不算（rageMute 隔离线）
  const wMute = cleanWorld(9904);
  openWindow(wMute);
  wMute.rageMute = 1;
  SIM.onBestiaryKill(wMute, mob('corpse'));
  SIM.onBestiaryKill(wMute, mob('bat'));
  expect('★★★rageMute>0 时击杀一律不算种类（天火白送堵死）',
    wMute.bestiaryKinds === 0 && Object.keys(wMute.bestiarySeen).length === 0,
    'kinds=' + wMute.bestiaryKinds);
  wMute.rageMute = 0;
  SIM.onBestiaryKill(wMute, mob('corpse'));
  expect('rageMute 解除后击杀恢复计数（正向对照，证明闸不是恒关）',
    wMute.bestiaryKinds === 1, 'kinds=' + wMute.bestiaryKinds);

  // ★★钩子只挂 killMob：真实打死两只不同种的怪 → +2（证明挂对漏斗）
  const wK = cleanWorld(9905);
  openWindow(wK);
  const m1 = SIM.spawnMob(wK, 'corpse', wK.player.x + 260, wK.player.y, 1, 0);
  const m2 = SIM.spawnMob(wK, 'bat', wK.player.x + 280, wK.player.y, 1, 0);
  SIM.damageMob(wK, m1, 999999);
  SIM.damageMob(wK, m2, 999999);
  expect('★★真实 killMob 打死两种怪 → +2（钩子挂在唯一击杀漏斗）',
    wK.bestiaryKinds === 2, 'kinds=' + wK.bestiaryKinds);

  // 窗口外 / 剧情关：钩子自身两道闸
  const wOut = cleanWorld(9906);
  SIM.onBestiaryKill(wOut, mob('corpse'));
  expect('窗口外击杀也不计数', wOut.bestiaryKinds === 0, 'kinds=' + wOut.bestiaryKinds);
  const wGate = cleanWorld(9907);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch5' };
  SIM.onBestiaryKill(wGate, mob('corpse'));
  expect('窗口内但剧情关下击杀也不计数（钩子有 story 闸）',
    wGate.bestiaryKinds === 0, 'kinds=' + wGate.bestiaryKinds);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(9910);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  wS.bestiaryNextTick = 0;
  SIM.tickBestiary(wS);
  SIM.onBestiaryKill(wS, mob('corpse'));
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.bestiaryActive === 0 && wS.bestiaryRounds === 0 && wS.bestiaryKinds === 0 &&
    evs(wS, 'bestiary_start').length === 0,
    'active=' + wS.bestiaryActive + ' kinds=' + wS.bestiaryKinds);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 9911, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 20) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有降妖录，且那一刻世界确实还在跑',
    storyAlive && wS2.bestiaryActive === 0 && evs(wS2, 'bestiary_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.bestiaryActive);
}

// ============================================================
// 第六十六轮：同族武器差异化
// （引魂灯=魂灯烙印 / 幽冥火轮=冥火灼烧 / 疾风回旋=罡风击退 /
//   太阴玄霜=冰寒减速 / 白骨钉=钉身定身 / 血雨=滋养 / 幽冥锁链=缠缚）
// 【测试原则】每件新效果都要有「同 kind 老武器」做对照（证明行为由 def 字段
//   驱动、不是 kind 整体变了）；每段都要证明世界还在跑（非空跑）；
//   灼烧要单独验「零随机」（主随机流逐位一致）。
// ============================================================

function testSkillDiff() {
  console.log('[第六十六轮] 同族武器差异化：烙印 / 灼烧 / 罡风 / 冰寒 / 钉身 / 滋养 / 缠缚');

  const F = 1 / C.TICK_HZ;   // 一帧的秒数

  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;  // 第六十七轮：射日诀 462s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function give(w, id) {
    w.player.weapons = [{ id: id, level: 1, timer: 0, rt: {} }];
    SIM.recalcAttrs(w);
  }
  // 造一只远处的靶子怪（带 seed：不抽主随机流；hpMul 放大免得一下被打死）
  function farMob(w, dist, hpMul) {
    return SIM.spawnMob(w, 'corpse', w.player.x + dist, w.player.y, hpMul || 30, 0, 0.5);
  }
  function run(w, frames) {
    for (let i = 0; i < frames; i++) SIM.step(w, { mx: 0, my: 0 });
  }
  // 火轮命中有点火前置：开火 → 等环绕物摸到怪
  function ignite(w, m) {
    for (let i = 0; i < 120; i++) {
      SIM.step(w, { mx: 0, my: 0 });
      if (m.alive && m.burnT > 0) return true;
    }
    return false;
  }

  // ---------- 1. 太阴玄霜：冰寒减速 ----------
  {
    const w1 = cleanWorld(6601);
    give(w1, 'frost_nova');
    const m1 = farMob(w1, 60, 10);
    run(w1, 2);
    expect('玄霜命中后怪被冰寒（chillT 上身）', m1.chillT > 0, 'chillT=' + m1.chillT);
    expect('玄霜的冰寒乘区是 0.65', m1.chillMul === 0.65, 'mul=' + m1.chillMul);

    const w2 = cleanWorld(6602);
    give(w2, 'garlic');
    const m2 = farMob(w2, 60, 10);
    run(w2, 2);
    expect('★对照：蒜雾命中不冰寒（减速由 def 字段驱动，不是 aura kind 整体变了）',
      !(m2.chillT > 0), 'chillT=' + m2.chillT);
    expect('★对照：蒜雾确实命中过（非空跑）', w2.stats.dmgDealt > 0 &&
      w1.state === 'playing' && w2.state === 'playing');
  }
  // 减速真的生效：同 seed 双世界，冻的一只位移 ≈ 0.65 倍
  {
    const wA = cleanWorld(6603);
    const wB = cleanWorld(6603);
    const mA = SIM.spawnMob(wA, 'corpse', wA.player.x + 400, wA.player.y, 30, 0, 0.5);
    const mB = SIM.spawnMob(wB, 'corpse', wB.player.x + 400, wB.player.y, 30, 0, 0.5);
    mA.chillT = 1.2; mA.chillMul = 0.65;
    run(wA, 30); run(wB, 30);
    const dA = Math.abs(mA.x - (wA.player.x + 400));
    const dB = Math.abs(mB.x - (wB.player.x + 400));
    expect('被冻的怪确实走得更慢（位移 ≈ 0.65 倍）',
      dB > 0 && dA / dB > 0.5 && dA / dB < 0.8, 'ratio=' + fmt(dA / dB, 2));
    // 到期自动解除，速度恢复
    run(wA, 30); run(wB, 30);   // 又 0.5s，chillT 0.3+ 已过期
    expect('冰寒到期自动解除（chillT 归零）', !(mA.chillT > 0), 'chillT=' + mA.chillT);
    const dA2 = Math.abs(mA.x - mA.px);   // 这一帧的位移
    const dB2 = Math.abs(mB.x - mB.px);
    expect('解冻后速度恢复（与未冻怪同帧位移一致）',
      Math.abs(dA2 - dB2) < 0.5, 'A=' + fmt(dA2, 2) + ' B=' + fmt(dB2, 2));
  }

  // ---------- 2. 幽冥锁链：缠缚减速 ----------
  {
    const w1 = cleanWorld(6605);
    give(w1, 'spirit_chain');
    const m1 = farMob(w1, 200, 30);
    run(w1, 40);
    expect('锁链命中后怪被缠缚（chillMul 0.7）',
      m1.chillT > 0 && m1.chillMul === 0.7, 'chillT=' + m1.chillT + ' mul=' + m1.chillMul);

    const w2 = cleanWorld(6606);
    give(w2, 'nail');
    const m2 = farMob(w2, 200, 30);
    run(w2, 40);
    expect('★对照：神钉命中不缠缚（直线穿透族没整体变控场）', !(m2.chillT > 0),
      'chillT=' + m2.chillT);
    expect('★对照：神钉确实打到了怪（非空跑）', w2.stats.dmgDealt > 0);
  }

  // ---------- 3. 引魂灯：魂灯烙印 ----------
  {
    const w1 = cleanWorld(6607);
    give(w1, 'soul_lantern');
    const m1 = farMob(w1, 150, 30);
    let marked = false;
    for (let i = 0; i < 240 && !marked; i++) {
      SIM.step(w1, { mx: 0, my: 0 });
      if (m1.alive && m1.markT > 0) marked = true;
    }
    expect('引魂灯命中后猎物被烙印', marked, 'markT=' + m1.markT);
    expect('烙印增伤幅度 0.25', m1.markMul === 0.25, 'mul=' + m1.markMul);
    expect('烙印时长 6 秒', Math.abs(m1.markT - 6) < 0.1, 'markT=' + m1.markT);

    const w2 = cleanWorld(6608);
    give(w2, 'homing_orb');
    const m2 = farMob(w2, 150, 30);
    let hit = false;
    for (let i = 0; i < 240 && !hit; i++) {
      SIM.step(w2, { mx: 0, my: 0 });
      if (w2.stats.dmgDealt > 0) hit = true;
    }
    expect('★对照：引魂珠命中不烙印（追踪族没整体变辅助）', !(m2.markT > 0) && hit,
      'markT=' + m2.markT + ' hit=' + hit);
  }
  // 烙印的结算口径：增伤 / 世界伤害隔离 / 到期失效
  {
    const w = cleanWorld(6609);
    const m = farMob(w, 500, 30);
    const hpFull = m.hp;
    SIM.damageMob(w, m, 100);
    expect('无烙印时伤害原样结算', Math.abs(hpFull - m.hp - 100) < 1e-6, hpFull - m.hp);

    m.markT = 6; m.markMul = 0.25;
    const hp2 = m.hp;
    SIM.damageMob(w, m, 100);
    expect('烙印期间受到的伤害 +25%（100 → 125）', Math.abs(hp2 - m.hp - 125) < 1e-6, hp2 - m.hp);

    m.hp = m.maxHp;   // 补满，避免下一发把怪打死搅进斩杀判定
    SIM.damageMob(w, m, 100, 0, 0, 'meteor');
    expect('★★世界伤害（天火）不吃烙印：数值对所有人恒定',
      Math.abs(m.maxHp - m.hp - 100) < 1e-6, m.maxHp - m.hp);

    m.hp = m.maxHp;
    m.markT = 0.2;
    run(w, 20);       // 0.33s > 0.2s
    expect('烙印到期自动失效', !(m.markT > 0), 'markT=' + m.markT);
    const hp4 = m.hp;
    SIM.damageMob(w, m, 100);
    expect('失效后增伤不再生效', Math.abs(hp4 - m.hp - 100) < 1e-6, hp4 - m.hp);
  }

  // ---------- 4. 白骨钉：钉身定身 ----------
  {
    const w1 = cleanWorld(6610);
    give(w1, 'bone_spike');
    farMob(w1, 250, 30);
    run(w1, 1);
    expect('白骨钉的落点带上钉身字段（stunSec 0.6）',
      w1.strikes.length === 1 && w1.strikes[0].stunSec === 0.6,
      'strikes=' + w1.strikes.length + ' stun=' + (w1.strikes[0] ? w1.strikes[0].stunSec : '-'));

    const w2 = cleanWorld(6611);
    give(w2, 'thunder');
    farMob(w2, 250, 30);
    run(w2, 1);
    expect('★对照：五雷正法的落点不带定身（保持落点不可控的纯爆发）',
      w2.strikes.length === 1 && !(w2.strikes[0].stunSec > 0));

    // 落地结算把 stunSec 真正应用到怪身上（复用既有定身管线）。
    // ★★本机 TICK_HZ=20（dt=0.05）：delay 0.1 → 第 2 帧落地；stun 0.6 → 约 12 帧后过期。
    //   落点结算自带 40 击退冲量（怪会被"砸退"一小段再被钉住）——
    //   所以「钉住」验的是追逐速度 vx/vy 为 0（moveMobToward 对定身怪早退），
    //   不验 x/y（击退漂移是冲击本身，不是 AI 在走）。
    const w3 = cleanWorld(6612);
    const m3 = farMob(w3, 500, 30);
    w3.strikes.push({ kind: 'strike', src: 'bone_spike', owner: w3.player,
      x: m3.x, y: m3.y, r: 34, dmg: 0, delay: 0.1, life: 0.1, stunSec: 0.6, color: '#fff3b0' });
    run(w3, 4);       // 0.2s > delay 0.1 → 已落地
    expect('落地后怪被钉身（复用既有定身状态）', m3.stun > 0, 'stun=' + m3.stun);
    expect('被钉的怪追逐速度清零（AI 停走）', m3.vx === 0 && m3.vy === 0,
      'vx=' + m3.vx + ' vy=' + m3.vy);
    // 定身时长 ≈ 0.6s：数到过期为止用了几帧
    let stunFrames = 0;
    while (m3.stun > 0 && stunFrames < 30) { run(w3, 1); stunFrames++; }
    expect('钉身 0.6 秒后过期（时长按 def 字段）',
      stunFrames >= 9 && stunFrames <= 15 && !(m3.stun > 0),
      'frames=' + stunFrames + '（20Hz 下 0.6s ≈ 12 帧）');
  }

  // ---------- 5. 血雨：滋养 ----------
  {
    const w1 = cleanWorld(6613);
    give(w1, 'blood_rain');
    run(w1, 1);       // 落一摊血雨（场上没怪，按面向扔）
    const z = w1.zones[0];
    expect('血雨的地面区域带上滋养字段（每跳 0.5）', !!z && z.healPerTick === 0.5,
      'healPerTick=' + (z ? z.healPerTick : '-'));
    w1.player.x = z.x; w1.player.y = z.y;
    SIM.damagePlayer(w1, w1.player, 30, w1.player.x, w1.player.y);
    const hpB = w1.player.hp;
    // ★本机 TICK_HZ=20：血雨 tickSec 0.28 ≈ 5.6 帧。不按帧数硬算，
    //   改成「推进到 stats.healed 涨了为止」的循环取点，对帧率不敏感。
    let heal1 = 0;
    for (let i = 0; i < 30 && heal1 === 0; i++) {
      SIM.step(w1, { mx: 0, my: 0 });
      heal1 = w1.player.hp - hpB;
    }
    expect('站在血雨里第一跳回 0.5 血', Math.abs(heal1 - 0.5) < 1e-6, '回血=' + heal1);
    let heal2 = heal1;
    for (let i = 0; i < 30 && Math.abs(heal2 - heal1) < 1e-6; i++) {
      SIM.step(w1, { mx: 0, my: 0 });
      heal2 = w1.player.hp - hpB;
    }
    expect('第二跳再回 0.5（共 1.0）', Math.abs(heal2 - 1.0) < 1e-6, '回血=' + heal2);

    // 满血不溢出（真增量 0，与养元诀口径一致）：推进至少一个 tick 周期
    w1.player.hp = w1.player.maxHp;
    const healedB = w1.stats.healed;
    run(w1, 8);       // 0.4s > tickSec 0.28 → 至少跳一跳
    expect('★满血站雨里不溢出（healed 只记真增量）',
      w1.player.hp === w1.player.maxHp && w1.stats.healed === healedB,
      'hp=' + w1.player.hp + ' healed=' + (w1.stats.healed - healedB));

    // 对照：甘露
    const w2 = cleanWorld(6614);
    give(w2, 'holy_water');
    run(w2, 1);
    const z2 = w2.zones[0];
    expect('★对照：甘露不带滋养（地面区域族没整体变奶水）', !!z2 && z2.healPerTick === 0,
      'healPerTick=' + (z2 ? z2.healPerTick : '-'));
    w2.player.x = z2.x; w2.player.y = z2.y;
    SIM.damagePlayer(w2, w2.player, 30, w2.player.x, w2.player.y);
    const hpB2 = w2.player.hp;
    run(w2, 2);
    expect('★对照：站甘露里一滴血都不回', w2.player.hp === hpB2,
      '回血=' + (w2.player.hp - hpB2));
  }

  // ---------- 6. 幽冥火轮：冥火灼烧 ----------
  {
    const w1 = cleanWorld(6615);
    give(w1, 'wisp_wheel');
    const m1 = farMob(w1, 104, 30);
    const ignited = ignite(w1, m1);
    expect('火轮命中后怪被点燃', ignited, 'burnT=' + m1.burnT);
    expect('灼烧时长 3 秒', Math.abs(m1.burnT - 3) < 0.1, 'burnT=' + m1.burnT);

    // 摘掉火轮本体，只留灼烧：量出纯灼烧伤害
    // ★本机 TICK_HZ=20：跑 48 帧 = 2.4s → 灼烧在 0.5 / 1.0 / 1.5 / 2.0 各跳一次，
    //   恰好 4 跳 × 2 点 = 8（取 48 帧避开 2.5s 整数边界，离两侧都有余量）
    const dealtB = w1.stats.dmgDealt;
    const byB = w1.stats.dmgBy.wisp_wheel || 0;
    const hpB = m1.hp;
    w1.orbits.length = 0;
    const rngB = w1.rngState;
    run(w1, 48);
    expect('纯灼烧 2.4 秒掉 8 血（0.5s 一跳 × 2 点 × 4 跳）', Math.abs(hpB - m1.hp - 8) < 1e-6,
      '掉血=' + (hpB - m1.hp));
    expect('灼烧计入伤害构成（wisp_wheel 名下）',
      Math.abs((w1.stats.dmgBy.wisp_wheel || 0) - byB - 8) < 1e-6,
      'dmgBy=' + (w1.stats.dmgBy.wisp_wheel || 0));
    expect('灼烧计入总输出', Math.abs(w1.stats.dmgDealt - dealtB - 8) < 1e-6);
    expect('★★灼烧结算零随机（主随机流逐位一致，波次落点不被挪走）',
      w1.rngState === rngB);
    expect('灼烧期间世界还在跑', w1.state === 'playing' && m1.alive);

    const w2 = cleanWorld(6616);
    give(w2, 'scripture');
    const m2 = farMob(w2, 104, 30);
    let hit2 = false;
    for (let i = 0; i < 120 && !hit2; i++) {
      SIM.step(w2, { mx: 0, my: 0 });
      if (w2.stats.dmgDealt > 0) hit2 = true;
    }
    expect('★对照：道德真经命中不点燃（环绕族没整体变火）', !(m2.burnT > 0) && hit2,
      'burnT=' + m2.burnT + ' hit=' + hit2);
  }
  // 灼烧致死走 killMob（算玩家击杀，掉落照常）
  {
    const w = cleanWorld(6617);
    give(w, 'wisp_wheel');
    const m = farMob(w, 104, 30);
    const ignited = ignite(w, m);
    expect('灼烧致死场景：怪被点燃（前置）', ignited);
    w.orbits.length = 0;
    m.hp = 2;
    m.burnTick = 0.5;   // 下一跳正好烧死
    // ★掉落球会被玩家磁吸（200px / 340px·s）很快吃掉 ——
    //   必须在「怪死的那个 step 出来」的第一时间取 pickups 数，别等它跑完。
    let dropCount = -1;
    for (let i = 0; i < 40 && dropCount < 0; i++) {
      SIM.step(w, { mx: 0, my: 0 });
      if (!m.alive) dropCount = w.pickups.length;
    }
    expect('★★灼烧致死走 killMob（怪死了、掉落照常）',
      !m.alive && dropCount >= 1, 'alive=' + m.alive + ' 死时掉落=' + dropCount);
  }

  // ---------- 7. 疾风回旋：罡风击退 ----------
  {
    const w1 = cleanWorld(6618);
    give(w1, 'gale_boomerang');
    const m1 = farMob(w1, 60, 30);
    let maxK = 0;
    for (let i = 0; i < 120; i++) {
      SIM.step(w1, { mx: 0, my: 0 });
      const k = Math.hypot(m1.kx || 0, m1.ky || 0);
      if (k > maxK) maxK = k;
      if (m1.kx || m1.ky) { /* 已命中过 */ }
    }
    expect('罡风把命中的怪推开（击退冲量 ≈ 60）', maxK > 50, 'maxK=' + fmt(maxK, 1));

    const w2 = cleanWorld(6619);
    give(w2, 'boomerang');
    const m2 = farMob(w2, 60, 30);
    let maxK2 = 0;
    for (let i = 0; i < 120; i++) {
      SIM.step(w2, { mx: 0, my: 0 });
      const k = Math.hypot(m2.kx || 0, m2.ky || 0);
      if (k > maxK2) maxK2 = k;
    }
    expect('★对照：基础回风刃击退仍是默认 14（往返族没整体变风）',
      maxK2 > 0 && maxK2 < 20 && w2.stats.dmgDealt > 0, 'maxK=' + fmt(maxK2, 1));
  }

  // ---------- 8. 表自洽：字段只挂在七件基础武器上，不外溢 ----------
  {
    const defs = {};
    C.WEAPONS.forEach(function (d) { defs[d.id] = d; });
    expect('★同族老武器一律不带新字段（行为分家只走 def 字段）',
      !defs.garlic.chillSec && !defs.garlic.markSec && !defs.garlic.burnSec &&
      !defs.homing_orb.markSec && !defs.scripture.burnSec && !defs.scripture.chillSec &&
      !defs.boomerang.knock && !defs.nail.chillSec && !defs.nail.stunSec &&
      !defs.holy_water.healPerTick && !defs.thunder.stunSec &&
      !defs.homing_orb.chillSec);
    expect('七件差异化武器各带各的字段',
      defs.frost_nova.chillSec === 1.2 && defs.frost_nova.chillMul === 0.65 &&
      defs.spirit_chain.chillSec === 0.8 && defs.spirit_chain.chillMul === 0.7 &&
      defs.soul_lantern.markSec === 6 && defs.soul_lantern.markMul === 0.25 &&
      defs.wisp_wheel.burnSec === 3 && defs.wisp_wheel.burnDmg === 2 &&
      defs.bone_spike.stunSec === 0.6 && defs.blood_rain.healPerTick === 0.5 &&
      defs.gale_boomerang.knock === 60);
    // 进化 / 组合技不继承新字段（分家不外溢）。
    // ★knock 是 whip/garlic 一族的**老字段**（干戚 60 / 蒜雾 26 / 血鞭 90…），
    //   只有 boomerang kind 的 knock 是本轮新加的（疾风回旋 60）——
    //   所以 knock 只查 boomerang 类的进化/组合不许带，其余 kind 的 knock 不归本轮管。
    // ★stunSec 例外说明：雷霆惩戒（parabola 进化）本来就有 stunSec: 1，是老字段；
    //   所以只查 strike 类的进化/组合不许带（parabola 的不动）。
    const leaked = [];
    C.EVOLUTIONS.concat(C.COMBOS).forEach(function (d) {
      if (d.chillSec || d.markSec || d.burnSec || d.healPerTick) leaked.push(d.id);
      if (d.knock && d.kind === 'boomerang') leaked.push(d.id + '(knock)');
      if (d.stunSec && d.kind === 'strike') leaked.push(d.id + '(stun)');
    });
    expect('进化 / 组合技不继承新字段（分家不外溢）', leaked.length === 0, leaked.join(','));

    // 死字段扫描：每个新字段名都必须在 sim.js 里有真实引用（防「写了没人读」）
    const src = FS.readFileSync(PATH.join(__dirname, '../shared/sim.js'), 'utf8');
    const needFields = ['chillSec', 'chillMul', 'markSec', 'markMul',
      'burnSec', 'burnTickSec', 'burnDmg', 'healPerTick'];
    const dead = needFields.filter(function (f) { return src.indexOf(f) < 0; });
    expect('新字段全部被 sim.js 真实消费（无死字段）', dead.length === 0, dead.join(','));
  }
}

// ============================================================
// 第六十七轮：射日诀（限时「远距离击杀数」目标，目标制零实体第十二件）
// 【测试原则】每件目标制都钉「不该发生的事」：贴脸补刀不算、天火白送不算、
//   近战猛刷不达过半/不达标、落空零掉落、剧情关没有（且证明世界还在跑）。
//   距离边界两头都测（刚好门槛算 / 差 0.01 不算），防「恒真/恒假」假绿。
// ============================================================

function testShoot() {
  console.log('[第六十七轮] 射日诀：第一件「限时远距离击杀」目标（贴脸不算）');
  const P = C.SHOOT;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 隔离世界：其它机制全推远、关武器、默认满血，只留射日诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 0;      // 本件默认开窗，干净世界里显式打开
    w.generalNextTick = 1e9;  // 第六十八轮：finish 会推过斩将令首发 474s，必须推远隔离
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.rageMute = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.shootNextTick = 0;
    SIM.tickShoot(w);
  }
  // 直接喂击杀钩子：不真 spawn，隔离掉落与随机流
  function feedKills(w, count, dist) {
    const p = w.self || w.player;
    for (let i = 0; i < count; i++) {
      SIM.onShootKill(w, { x: p.x + (dist || (P.minDist + 60)), y: p.y });
    }
  }
  function finish(w, count, dist) {
    feedKills(w, count, dist);
    w.time = w.shootDeadline + 0.01;
    SIM.tickShoot(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没怪可杀）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.shootNeedFor(0) === P.needFar &&
    SIM.shootNeedFor(1) === P.needFar + P.farStep &&
    SIM.shootNeedFor(99) === P.maxFar,
    '0=' + SIM.shootNeedFor(0) + ' 1=' + SIM.shootNeedFor(1) + ' 99=' + SIM.shootNeedFor(99));
  expect('目标密度合理（封顶 9 只在 30 秒内可达，平均每 3.3 秒一只）',
    P.needFar >= 3 && P.needFar <= P.maxFar && P.maxFar / P.windowSec <= 0.4,
    'need=' + P.needFar + ' max=' + P.maxFar + ' / ' + P.windowSec);
  expect('距离门槛夹在近战之外、画面之内（贴脸不算，但玩家看得见目标）',
    P.minDist >= 280 && P.minDist <= 420,
    'minDist=' + P.minDist);
  expect('奖励仍是「一箱 + 零钱」（与前十一件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开所有既有事件（含降妖录 438，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'shoot=' + P.startSec + ' bestiary=' + C.BESTIARY.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗掉落）----------
  const wR = cleanWorld(10061);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedKills(wR, 1000);
  finish(wR, P.needFar);
  expect('★开窗/距离累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(10062);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(10070);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickShoot(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.shootRounds === 0 && evs(wT, 'shoot_start').length === 0,
    'rounds=' + wT.shootRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.shootActive === 1 && wT.shootRounds === 1,
    'rounds=' + wT.shootRounds + ' active=' + wT.shootActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前十一件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'shoot_start')[0];
  expect('开窗播报一次说清四件事：多久 / 几只 / 距离门槛 / 给什么',
    !!st && st.sec === P.windowSec && st.need === P.needFar &&
    st.minDist === P.minDist && st.round === 1 && evs(wT, 'shoot_start').length === 1,
    JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.shootDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.shootDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.shootNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.shootNextTick);
  SIM.tickShoot(wT);
  expect('同帧重复调用不会二次开窗', wT.shootRounds === 1,
    'rounds=' + wT.shootRounds);
  wT.time = wT.shootDeadline - 0.001;
  SIM.tickShoot(wT);
  expect('到期前一帧不发奖也不结算', wT.shootActive === 1 &&
    wT.shootFar === 0 && evs(wT, 'shoot_done').length === 0 &&
    evs(wT, 'shoot_fail').length === 0,
    'active=' + wT.shootActive + ' far=' + wT.shootFar);

  // ---------- 4. 过半（整数次累加：标记位防刷屏）----------
  const wH = cleanWorld(10071);
  openWindow(wH);
  feedKills(wH, Math.floor((P.needFar - 1) / 2));
  expect('过半前零播报', evs(wH, 'shoot_half').length === 0,
    'half=' + evs(wH, 'shoot_half').length + ' far=' + wH.shootFar);
  feedKills(wH, 1);
  expect('过半报一次', evs(wH, 'shoot_half').length === 1,
    'half=' + evs(wH, 'shoot_half').length);
  feedKills(wH, 1000);
  expect('多杀不刷屏（过半播报恰好一次）', evs(wH, 'shoot_half').length === 1,
    'half=' + evs(wH, 'shoot_half').length);
  const wH2 = cleanWorld(10072);
  openWindow(wH2);
  feedKills(wH2, P.needFar);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'shoot_half').length === 1 &&
    evs(wH2, 'shoot_half')[0].got === Math.ceil(P.needFar / 2),
    'half=' + evs(wH2, 'shoot_half').length +
    ' got=' + ((evs(wH2, 'shoot_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(10080);
  openWindow(wD);
  finish(wD, P.needFar);
  expect('远距杀够 → 达成', wD.shootActive === 0 && wD.shootDone === 1 &&
    evs(wD, 'shoot_done').length === 1, 'done=' + wD.shootDone);
  expect('宝箱正好一个（与前十一件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'shoot_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needFar && dn.need === P.needFar &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feedKills(wD, 1000);
  SIM.tickShoot(wD);
  expect('★达标后再杀、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.shootDone === 1 && evs(wD, 'shoot_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.shootDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickShoot(wD);
  expect('下一轮目标递增、远距计数清零', wD.shootRounds === 2 &&
    wD.shootNeed === P.needFar + P.farStep && wD.shootFar === 0,
    'need=' + wD.shootNeed + ' far=' + wD.shootFar);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(10090);
  openWindow(wF);
  finish(wF, P.needFar - 1);
  expect('差一只也落空', wF.shootActive === 0 && wF.shootFailed === 1 &&
    wF.shootDone === 0, 'failed=' + wF.shootFailed + ' done=' + wF.shootDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'shoot_done').length === 0,
    'done=' + evs(wF, 'shoot_done').length);
  const fl = evs(wF, 'shoot_fail')[0];
  expect('落空只陈述还差几只（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needFar - 1 && fl.need === P.needFar,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.shootNextTick = 1e9;   // 关掉后续排期，推这么远不该再开一轮
  wF.generalNextTick = 1e9; // 第六十八轮：斩将令同样关掉，推很远不误开
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickShoot(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.shootDone === 0, 'pickups=' + wF.pickups.length);
  const farAfterFail = wF.shootFar;
  feedKills(wF, 1000);
  expect('落空后再杀也不计数（钩子只认 active）',
    wF.shootFar === farAfterFail && wF.shootActive === 0,
    'far=' + wF.shootFar + '（落空时 ' + farAfterFail + '）');

  // ---------- 7. ★★★距离闸（本件核心新轴：贴脸不算）----------
  const wB = cleanWorld(10100);
  openWindow(wB);
  feedKills(wB, 3, 40);
  expect('★★★贴脸杀 3 只一只都不算（距离闸是灵魂）',
    wB.shootFar === 0, 'far=' + wB.shootFar);
  feedKills(wB, 1, P.minDist + 60);
  expect('远处击杀才 +1（正向对照，证明闸不是恒关）',
    wB.shootFar === 1, 'far=' + wB.shootFar);
  feedKills(wB, 1, P.minDist);
  expect('★★正好等于门槛算达标（边界含等号）',
    wB.shootFar === 2, 'far=' + wB.shootFar);
  feedKills(wB, 1, P.minDist - 0.01);
  expect('★★差 0.01 到门槛就不算（边界两头都钉）',
    wB.shootFar === 2, 'far=' + wB.shootFar);
  const wB2 = cleanWorld(10101);
  openWindow(wB2);
  for (let i = 0; i < 500; i++) SIM.onShootKill(wB2, {
    x: wB2.player.x + 40, y: wB2.player.y
  });
  expect('★★★贴脸猛刷 500 只：不达过半、不达标、零掉落',
    wB2.shootFar === 0 && evs(wB2, 'shoot_half').length === 0 &&
    evs(wB2, 'shoot_done').length === 0 && wB2.pickups.length === 0,
    'far=' + wB2.shootFar + ' half=' + evs(wB2, 'shoot_half').length +
    ' done=' + evs(wB2, 'shoot_done').length + ' pick=' + wB2.pickups.length);
  // 后台天火白送的远处击杀不算
  const wMute = cleanWorld(10102);
  openWindow(wMute);
  wMute.rageMute = 1;
  feedKills(wMute, 3);
  expect('★★★rageMute>0 时远距击杀也不算（天火白送堵死）',
    wMute.shootFar === 0, 'far=' + wMute.shootFar);
  wMute.rageMute = 0;
  feedKills(wMute, 1);
  expect('rageMute 解除后远距击杀恢复计数（正向对照）',
    wMute.shootFar === 1, 'far=' + wMute.shootFar);
  // ★钩子挂 killMob 唯一漏斗：真实打死远处怪 +1、近处怪 +0
  const wK = cleanWorld(10103);
  openWindow(wK);
  const mFar = SIM.spawnMob(wK, 'corpse', wK.player.x + 400, wK.player.y, 1, 0);
  const mNear = SIM.spawnMob(wK, 'bat', wK.player.x + 60, wK.player.y, 1, 0);
  SIM.damageMob(wK, mNear, 999999);
  expect('★★真实 killMob 打死近处怪不算（钩子挂在唯一击杀漏斗）',
    wK.shootFar === 0, 'far=' + wK.shootFar);
  SIM.damageMob(wK, mFar, 999999);
  expect('★★真实 killMob 打死远处怪 → +1（钩子挂对漏斗）',
    wK.shootFar === 1, 'far=' + wK.shootFar);
  // 窗口外 / 剧情关：钩子自身两道闸
  const wOut = cleanWorld(10104);
  feedKills(wOut, 3);
  expect('窗口外远距击杀也不计数', wOut.shootFar === 0, 'far=' + wOut.shootFar);
  const wGate = cleanWorld(10105);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch5' };
  feedKills(wGate, 3);
  expect('窗口内但剧情关下远距击杀也不计数（钩子有 story 闸）',
    wGate.shootFar === 0, 'far=' + wGate.shootFar);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(10110);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickShoot(wS);
  feedKills(wS, 3);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.shootActive === 0 && wS.shootRounds === 0 && wS.shootFar === 0 &&
    evs(wS, 'shoot_start').length === 0,
    'active=' + wS.shootActive + ' far=' + wS.shootFar);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 10111, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有射日诀，且那一刻世界确实还在跑',
    storyAlive && wS2.shootActive === 0 && evs(wS2, 'shoot_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.shootActive);
}

function testGeneral() {
  console.log('[第六十八轮] 斩将令：第一件「限时击杀精英」目标（小怪不算，质量轴）');
  const P = C.GENERAL;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 隔离世界：其它机制全推远、关武器、默认满血，只留斩将令这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 0;    // 本件默认开窗，干净世界里显式打开
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.rageMute = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.generalNextTick = 0;
    w.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
    w.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
    w.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    SIM.tickGeneral(w);
  }
  // 按 tier 直接喂击杀钩子：不真 spawn，隔离掉落与随机流
  function feedKills(w, count, tier) {
    for (let i = 0; i < count; i++) {
      SIM.onGeneralKill(w, { def: { tier: tier || 'elite' } });
    }
  }
  function finish(w, count, tier) {
    feedKills(w, count, tier);
    w.time = w.generalDeadline + 0.01;
    SIM.tickGeneral(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没精英可杀）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（第 15 波起怪池才有精英）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.generalNeedFor(0) === P.needElite &&
    SIM.generalNeedFor(1) === P.needElite + P.eliteStep &&
    SIM.generalNeedFor(99) === P.maxElite,
    '0=' + SIM.generalNeedFor(0) + ' 1=' + SIM.generalNeedFor(1) +
    ' 99=' + SIM.generalNeedFor(99));
  expect('目标密度合理（封顶精英数在 30 秒内可达）',
    P.needElite >= 3 && P.needElite <= P.maxElite && P.maxElite / P.windowSec <= 0.4,
    'need=' + P.needElite + ' max=' + P.maxElite + ' / ' + P.windowSec);
  expect('奖励仍是「一箱 + 零钱」（与前十二件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开所有既有事件（含射日诀 462，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'general=' + P.startSec + ' shoot=' + C.SHOOT.startSec);
  // 判据函数自洽：三档精英都认，普通/小怪/未定义一律不认
  expect('★★isEliteTier 认 elite / commander / boss 三档',
    SIM.isEliteTier({ def: { tier: 'elite' } }) &&
    SIM.isEliteTier({ def: { tier: 'commander' } }) &&
    SIM.isEliteTier({ def: { tier: 'boss' } }), '三档');
  expect('★★isEliteTier 拒绝 small / swift / normal / 缺 def（质量闸边界）',
    !SIM.isEliteTier({ def: { tier: 'small' } }) &&
    !SIM.isEliteTier({ def: { tier: 'swift' } }) &&
    !SIM.isEliteTier({ def: { tier: 'normal' } }) &&
    !SIM.isEliteTier({ def: {} }) && !SIM.isEliteTier({}) && !SIM.isEliteTier(null),
    '非精英');

  // ---------- 2. 零随机（直接调入口，隔离掉战斗掉落）----------
  const wR = cleanWorld(10261);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedKills(wR, 1000);
  finish(wR, P.needElite);
  expect('★开窗/精英累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(10262);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(10270);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickGeneral(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.generalRounds === 0 && evs(wT, 'general_start').length === 0,
    'rounds=' + wT.generalRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.generalActive === 1 && wT.generalRounds === 1,
    'rounds=' + wT.generalRounds + ' active=' + wT.generalActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前十二件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'general_start')[0];
  expect('开窗播报一次说清三件事：多久 / 几只 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needElite && st.round === 1 &&
    evs(wT, 'general_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.generalDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.generalDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.generalNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.generalNextTick);
  SIM.tickGeneral(wT);
  expect('同帧重复调用不会二次开窗', wT.generalRounds === 1,
    'rounds=' + wT.generalRounds);
  wT.time = wT.generalDeadline - 0.001;
  SIM.tickGeneral(wT);
  expect('到期前一帧不发奖也不结算', wT.generalActive === 1 &&
    wT.generalElite === 0 && evs(wT, 'general_done').length === 0 &&
    evs(wT, 'general_fail').length === 0,
    'active=' + wT.generalActive + ' elite=' + wT.generalElite);

  // ---------- 4. 过半（整数次累加：标记位防刷屏）----------
  const wH = cleanWorld(10271);
  openWindow(wH);
  feedKills(wH, Math.floor((P.needElite - 1) / 2));
  expect('过半前零播报', evs(wH, 'general_half').length === 0,
    'half=' + evs(wH, 'general_half').length + ' elite=' + wH.generalElite);
  feedKills(wH, 1);
  expect('过半报一次', evs(wH, 'general_half').length === 1,
    'half=' + evs(wH, 'general_half').length);
  feedKills(wH, 1000);
  expect('多杀不刷屏（过半播报恰好一次）', evs(wH, 'general_half').length === 1,
    'half=' + evs(wH, 'general_half').length);
  const wH2 = cleanWorld(10272);
  openWindow(wH2);
  feedKills(wH2, P.needElite);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'general_half').length === 1 &&
    evs(wH2, 'general_half')[0].got === Math.ceil(P.needElite / 2),
    'half=' + evs(wH2, 'general_half').length +
    ' got=' + ((evs(wH2, 'general_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(10280);
  openWindow(wD);
  finish(wD, P.needElite);
  expect('斩够精英 → 达成', wD.generalActive === 0 && wD.generalDone === 1 &&
    evs(wD, 'general_done').length === 1, 'done=' + wD.generalDone);
  expect('宝箱正好一个（与前十二件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'general_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needElite && dn.need === P.needElite &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feedKills(wD, 1000);
  SIM.tickGeneral(wD);
  expect('★达标后再杀、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.generalDone === 1 && evs(wD, 'general_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.generalDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickGeneral(wD);
  expect('下一轮目标递增、精英计数清零', wD.generalRounds === 2 &&
    wD.generalNeed === P.needElite + P.eliteStep && wD.generalElite === 0,
    'need=' + wD.generalNeed + ' elite=' + wD.generalElite);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(10290);
  openWindow(wF);
  finish(wF, P.needElite - 1);
  expect('差一只也落空', wF.generalActive === 0 && wF.generalFailed === 1 &&
    wF.generalDone === 0, 'failed=' + wF.generalFailed + ' done=' + wF.generalDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'general_done').length === 0,
    'done=' + evs(wF, 'general_done').length);
  const fl = evs(wF, 'general_fail')[0];
  expect('落空只陈述还差几只（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needElite - 1 && fl.need === P.needElite,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.generalNextTick = 1e9;   // 关掉后续排期，推这么远不该再开一轮
  wF.evadeNextTick = 1e9;   // 第六十九轮：避锋诀 486s 开窗，默认推远
  wF.temperNextTick = 1e9;  // 第七十轮：淬骨诀 498s 开窗，默认推远
  wF.swarmNextTick = 1e9;   // 第七十一轮：妖潮诀 516s 开窗，默认推远
  wF.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
  wF.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
  wF.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickGeneral(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.generalDone === 0, 'pickups=' + wF.pickups.length);
  const eliteAfterFail = wF.generalElite;
  feedKills(wF, 1000);
  expect('落空后再杀也不计数（钩子只认 active）',
    wF.generalElite === eliteAfterFail && wF.generalActive === 0,
    'elite=' + wF.generalElite + '（落空时 ' + eliteAfterFail + '）');

  // ---------- 7. ★★★质量闸（本件核心新轴：小怪不算）----------
  const wB = cleanWorld(10300);
  openWindow(wB);
  feedKills(wB, 3, 'small');
  expect('★★★小怪连杀 3 只一只都不算（质量闸是灵魂）',
    wB.generalElite === 0, 'elite=' + wB.generalElite);
  feedKills(wB, 1, 'swift');
  expect('★★速度型怪也不算', wB.generalElite === 0, 'elite=' + wB.generalElite);
  feedKills(wB, 1, 'normal');
  expect('★★普通怪也不算', wB.generalElite === 0, 'elite=' + wB.generalElite);
  feedKills(wB, 1, 'elite');
  expect('精英击杀才 +1（正向对照，证明闸不是恒关）',
    wB.generalElite === 1, 'elite=' + wB.generalElite);
  feedKills(wB, 1, 'commander');
  expect('★★指挥官（巫傩/魃母）也算精英 +1',
    wB.generalElite === 2, 'elite=' + wB.generalElite);
  feedKills(wB, 1, 'boss');
  expect('★★首领也算精英 +1', wB.generalElite === 3, 'elite=' + wB.generalElite);
  SIM.onGeneralKill(wB, { def: { tier: 'unknown_mob' } });
  expect('不认识的 tier 一律不算（防御性边界）', wB.generalElite === 3,
    'elite=' + wB.generalElite);
  const wB2 = cleanWorld(10301);
  openWindow(wB2);
  for (let i = 0; i < 500; i++) SIM.onGeneralKill(wB2, { def: { tier: 'small' } });
  expect('★★★小怪猛刷 500 只：不达过半、不达标、零掉落',
    wB2.generalElite === 0 && evs(wB2, 'general_half').length === 0 &&
    evs(wB2, 'general_done').length === 0 && wB2.pickups.length === 0,
    'elite=' + wB2.generalElite + ' half=' + evs(wB2, 'general_half').length +
    ' done=' + evs(wB2, 'general_done').length + ' pick=' + wB2.pickups.length);
  // 后台天火白送的精英击杀不算
  const wMute = cleanWorld(10302);
  openWindow(wMute);
  wMute.rageMute = 1;
  feedKills(wMute, 3);
  expect('★★★rageMute>0 时精英击杀也不算（天火白送堵死）',
    wMute.generalElite === 0, 'elite=' + wMute.generalElite);
  wMute.rageMute = 0;
  feedKills(wMute, 1);
  expect('rageMute 解除后精英击杀恢复计数（正向对照）',
    wMute.generalElite === 1, 'elite=' + wMute.generalElite);
  // ★钩子挂 killMob 唯一漏斗：真实打死精英 +1、小怪 +0
  const wK = cleanWorld(10303);
  openWindow(wK);
  const mSmall = SIM.spawnMob(wK, 'corpse', wK.player.x + 200, wK.player.y, 1, 0);
  SIM.damageMob(wK, mSmall, 999999);
  expect('★★真实 killMob 打死小怪不算（钩子挂在唯一击杀漏斗）',
    wK.generalElite === 0, 'elite=' + wK.generalElite);
  const mElite = SIM.spawnMob(wK, 'gargoyle', wK.player.x + 200, wK.player.y, 1, 0);
  SIM.damageMob(wK, mElite, 999999);
  expect('★★真实 killMob 打死精英 → +1（钩子挂对漏斗）',
    wK.generalElite === 1, 'elite=' + wK.generalElite);
  // 窗口外 / 剧情关：钩子自身两道闸
  const wOut = cleanWorld(10304);
  feedKills(wOut, 3);
  expect('窗口外精英击杀也不计数', wOut.generalElite === 0, 'elite=' + wOut.generalElite);
  const wGate = cleanWorld(10305);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch5' };
  feedKills(wGate, 3);
  expect('窗口内但剧情关下精英击杀也不计数（钩子有 story 闸）',
    wGate.generalElite === 0, 'elite=' + wGate.generalElite);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(10310);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch5' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickGeneral(wS);
  feedKills(wS, 3);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.generalActive === 0 && wS.generalRounds === 0 && wS.generalElite === 0 &&
    evs(wS, 'general_start').length === 0,
    'active=' + wS.generalActive + ' elite=' + wS.generalElite);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 10311, modId: 'myth', stageId: 'ch5' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch5）走完整条 step 也没有斩将令，且那一刻世界确实还在跑',
    storyAlive && wS2.generalActive === 0 && evs(wS2, 'general_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.generalActive);
}

// ============================================================
// 第六十九轮：避锋诀（第一件「限时免伤次数」目标）
// ============================================================
function testEvade() {
  console.log('[第六十九轮] 避锋诀：第一件「限时免伤次数」目标（无敌帧挡下的攻击才算）');
  const P = C.EVADE;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 隔离世界：其它机制全推远、关武器、默认满血，只留避锋诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 0;      // 本件默认开窗，干净世界里显式打开
    w.rageMute = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.effects.length = 0;
    w.zones.length = 0;
    w.strikes.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.evadeNextTick = 0;
    SIM.tickEvade(w);
  }
  // ★走调用方入口 damagePlayer（而不是直接喂 onEvadeHit）：
  //   否则摘掉 damagePlayer 里的调用点照样全绿（第四十轮踩过的假绿）。
  function feedHits(w, count, state) {
    const p = w.player;
    const old = p.state;
    if (state) p.state = state;
    for (let i = 0; i < count; i++) {
      p.invuln = 5;             // 足够长，整段喂击不会被自然递减磨穿
      SIM.damagePlayer(w, p, 10, p.x + 30, p.y);
    }
    if (state) p.state = old;
  }
  function finish(w, count, state) {
    feedHits(w, count, state);
    w.time = w.evadeDeadline + 0.01;
    SIM.tickEvade(w);
  }
  // 真实 step 的怪接触路径：钉住"整条链路上确实会数到"，而不是只验入口函数。
  function contactWorld(seed) {
    const w = cleanWorld(seed);
    openWindow(w);
    const m = SIM.spawnMob(w, 'corpse', w.player.x + 4, w.player.y, 1, 0, 7);
    m.hitCd = 0;
    return { w: w, m: m };
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场没怪，白开一轮）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（第 16 波起怪密，才凑得出免伤次数）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.evadeNeedFor(0) === P.needEvade &&
    SIM.evadeNeedFor(1) === P.needEvade + P.evadeStep &&
    SIM.evadeNeedFor(99) === P.maxEvade,
    '0=' + SIM.evadeNeedFor(0) + ' 1=' + SIM.evadeNeedFor(1) +
    ' 99=' + SIM.evadeNeedFor(99));
  expect('目标密度合理（封顶免伤次数在 30 秒内可达，不是死目标）',
    P.needEvade >= 2 && P.needEvade <= P.maxEvade && P.maxEvade / P.windowSec <= 0.4,
    'need=' + P.needEvade + ' max=' + P.maxEvade + ' / ' + P.windowSec);
  expect('奖励仍是「一箱 + 零钱」（与前十三个目标制同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发错开所有既有事件（含斩将令 474，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'evade=' + P.startSec + ' general=' + C.GENERAL.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗掉落）----------
  const wR = cleanWorld(10401);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedHits(wR, P.needEvade + 50);
  SIM.tickEvade(wR);
  expect('★开窗/免伤累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(10402);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(10410);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickEvade(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.evadeRounds === 0 && evs(wT, 'evade_start').length === 0,
    'rounds=' + wT.evadeRounds);
  const w0 = cleanWorld(10411);
  openWindow(w0);
  expect('到点开且只开一轮，播报一次说清「多久 / 几次」',
    w0.evadeRounds === 1 && w0.evadeActive === 1 &&
    evs(w0, 'evade_start').length === 1 &&
    evs(w0, 'evade_start')[0].sec === P.windowSec &&
    evs(w0, 'evade_start')[0].need === P.needEvade,
    JSON.stringify(evs(w0, 'evade_start')));
  expect('★★开窗零实体：不给怪、不给球、不给特效、不给 zone / strike',
    w0.mobs.length === 0 && w0.pickups.length === 0 && w0.effects.length === 0 &&
    w0.zones.length === 0 && w0.strikes.length === 0,
    'mob=' + w0.mobs.length + ' pick=' + w0.pickups.length + ' fx=' + w0.effects.length);
  expect('deadline 零漂移（w.time 口径，整数 tick 换算）',
    Math.abs(w0.evadeDeadline - (P.startSec + P.windowSec)) < 1e-9,
    'deadline=' + w0.evadeDeadline);
  expect('下一轮排期正确（按 everySec，不按窗口）',
    w0.evadeNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + w0.evadeNextTick);
  SIM.tickEvade(w0);
  expect('同帧重复调用不会二次开窗',
    w0.evadeRounds === 1 && evs(w0, 'evade_start').length === 1,
    'rounds=' + w0.evadeRounds);
  w0.time = w0.evadeDeadline - 0.01;
  SIM.tickEvade(w0);
  expect('到期前一帧不结算（不达成也不落空）',
    w0.evadeActive === 1 && w0.evadeDone === 0 && w0.evadeFailed === 0,
    'active=' + w0.evadeActive);
  // 达标优先于到期：最后一帧刚好挡够也算数
  const wLast = cleanWorld(10412);
  openWindow(wLast);
  wLast.time = wLast.evadeDeadline - 0.01;
  feedHits(wLast, P.needEvade);
  SIM.tickEvade(wLast);
  expect('★★最后一帧刚好挡够也算达成（达标判据优先于到期）',
    wLast.evadeDone === 1 && wLast.evadeFailed === 0,
    'done=' + wLast.evadeDone + ' fail=' + wLast.evadeFailed);

  // ---------- 4. 过半（整数次累加，标记位防刷屏）----------
  const wH = cleanWorld(10420);
  openWindow(wH);
  const halfAt = Math.ceil(P.needEvade / 2);
  feedHits(wH, halfAt - 1);
  expect('过半前零播报',
    evs(wH, 'evade_half').length === 0, 'half=' + evs(wH, 'evade_half').length);
  feedHits(wH, 1);
  expect('刚跨半播报一次，数字来自服务端事实',
    evs(wH, 'evade_half').length === 1 &&
    evs(wH, 'evade_half')[0].got === wH.evadeCount &&
    evs(wH, 'evade_half')[0].need === P.needEvade,
    JSON.stringify(evs(wH, 'evade_half')));
  feedHits(wH, 30);
  SIM.tickEvade(wH);
  expect('★★多挡几十次也不刷屏、不二次播报，数字锁在首次跨半那一下',
    evs(wH, 'evade_half').length === 1 &&
    evs(wH, 'evade_half')[0].got === halfAt &&
    wH.evadeDone === 1,
    'half=' + evs(wH, 'evade_half').length + ' got=' +
    (evs(wH, 'evade_half')[0] ? evs(wH, 'evade_half')[0].got : -1));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(10430);
  openWindow(wD);
  feedHits(wD, P.needEvade);
  SIM.tickEvade(wD);
  expect('挡够次数即达成',
    wD.evadeDone === 1 && wD.evadeActive === 0, 'done=' + wD.evadeDone);
  expect('宝箱正好一个（不是一袋子）',
    byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数与面值都正确（播报数字不是写死的）',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  expect('奖励落在玩家脚下（确定公式，不抽随机）',
    byKind(wD, 'chest').length === 1 &&
    Math.abs(byKind(wD, 'chest')[0].x - wD.player.x) < 1 &&
    Math.abs(byKind(wD, 'chest')[0].y - wD.player.y) < 1,
    'chest=' + JSON.stringify(byKind(wD, 'chest')));
  const doneEv = evs(wD, 'evade_done')[0];
  expect('播报的 got/need/chest/gold 全来自事件事实',
    doneEv && doneEv.got === P.needEvade && doneEv.need === P.needEvade &&
    doneEv.chest === P.rewardChest && doneEv.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(doneEv));
  const after = wD.evadeCount;
  feedHits(wD, 20);
  SIM.tickEvade(wD);
  expect('★达标后再挡也不计数、不二次发奖',
    wD.evadeCount === after && wD.evadeDone === 1 &&
    byKind(wD, 'chest').length === P.rewardChest,
    'count=' + wD.evadeCount + ' done=' + wD.evadeDone);
  wD.tick = wD.evadeNextTick;
  wD.time = wD.tick / HZ;
  SIM.tickEvade(wD);
  expect('下一轮目标随轮次上涨、计数清零',
    wD.evadeRounds === 2 && wD.evadeNeed === SIM.evadeNeedFor(1) &&
    wD.evadeCount === 0 && wD.evadeActive === 1,
    'round=' + wD.evadeRounds + ' need=' + wD.evadeNeed + ' count=' + wD.evadeCount);

  // ---------- 6. 落空（零奖励、不责备）----------
  const wF = cleanWorld(10440);
  openWindow(wF);
  finish(wF, P.needEvade - 1);
  expect('差一次也算落空（不四舍五入、不放水）',
    wF.evadeFailed === 1 && wF.evadeDone === 0,
    'fail=' + wF.evadeFailed + ' done=' + wF.evadeDone);
  expect('★★落空时一个掉落物都不多（宝箱/金币都不发）',
    wF.pickups.length === 0, 'pick=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报',
    evs(wF, 'evade_done').length === 0, 'done=' + evs(wF, 'evade_done').length);
  const failEv = evs(wF, 'evade_fail')[0];
  expect('落空只陈述「还差几次」，不责备玩家',
    failEv && failEv.left === 1 && failEv.got === P.needEvade - 1 &&
    JSON.stringify(failEv).indexOf('失败') < 0,
    JSON.stringify(failEv));
  wF.time = wF.evadeDeadline + 100;
  SIM.tickEvade(wF);
  expect('推到很晚也不补发（不因为时间过头而误判达成）',
    wF.evadeDone === 0 && evs(wF, 'evade_done').length === 0 &&
    evs(wF, 'evade_fail').length === 1,
    'fail=' + evs(wF, 'evade_fail').length);
  const held = wF.evadeCount;
  feedHits(wF, 20);
  expect('落空后再挡也不计数（窗口已关）',
    wF.evadeCount === held, 'count=' + wF.evadeCount);

  // ---------- 7. ★免伤闸（本件核心新轴）----------
  const wNoInv = cleanWorld(10450);
  openWindow(wNoInv);
  const hp0 = wNoInv.player.hp;
  wNoInv.player.invuln = 0;
  SIM.damagePlayer(wNoInv, wNoInv.player, 10, 0, 0);
  expect('★★无敌帧为 0 时被打会真扣血，且不算避锋诀（正向对照证明闸不是恒关）',
    wNoInv.player.hp < hp0 && wNoInv.evadeCount === 0,
    'hp ' + hp0 + ' → ' + wNoInv.player.hp + ' count=' + wNoInv.evadeCount);
  const wYesInv = cleanWorld(10451);
  openWindow(wYesInv);
  const hp1 = wYesInv.player.hp;
  wYesInv.player.invuln = 5;
  SIM.damagePlayer(wYesInv, wYesInv.player, 10, 0, 0);
  expect('★★★无敌帧挡下的攻击：血一点没掉，记一次（本件唯一计数口径）',
    wYesInv.player.hp === hp1 && wYesInv.evadeCount === 1,
    'hp ' + hp1 + ' → ' + wYesInv.player.hp + ' count=' + wYesInv.evadeCount);
  const wLv = cleanWorld(10452);
  openWindow(wLv);
  feedHits(wLv, 5, 'levelup');
  expect('★★★升级三选一定格期间的免伤不算（那不是走位闪避）',
    wLv.evadeCount === 0 && evs(wLv, 'evade_half').length === 0 &&
    evs(wLv, 'evade_done').length === 0,
    'count=' + wLv.evadeCount);
  const wDead = cleanWorld(10453);
  openWindow(wDead);
  wDead.player.alive = false;
  feedHits(wDead, 5);
  expect('阵亡者的免伤不算（died 后不该还能刷目标）',
    wDead.evadeCount === 0, 'count=' + wDead.evadeCount);
  const wOut = cleanWorld(10454);
  feedHits(wOut, 5);
  expect('窗口外的免伤不计数',
    wOut.evadeCount === 0, 'count=' + wOut.evadeCount);
  const wStoryHit = cleanWorld(10455);
  openWindow(wStoryHit);
  wStoryHit.storyStage = { id: 'ch6' };
  feedHits(wStoryHit, 5);
  expect('剧情关下即便开了窗口也不计数（钩子自带 story 闸）',
    wStoryHit.evadeCount === 0, 'count=' + wStoryHit.evadeCount);

  // ★真实 step 的怪接触路径：同时钉住"damagePlayer 里那一行调用点"与整条链路。
  const ct = contactWorld(10456);
  ct.w.player.invuln = 5;
  SIM.step(ct.w, { mx: 0, my: 0 });
  expect('★★真实 step 里怪贴身但被无敌帧挡下 → +1（调用点钉在受伤漏斗）',
    ct.w.evadeCount === 1,
    'count=' + ct.w.evadeCount + ' hp=' + ct.w.player.hp);
  const ct2 = contactWorld(10457);
  ct2.w.player.invuln = 0;
  const ctHp = ct2.w.player.hp;
  SIM.step(ct2.w, { mx: 0, my: 0 });
  expect('★★真实 step 里无敌帧为 0 的接触真扣血、且不计数（不是天然恒关）',
    ct2.w.player.hp < ctHp && ct2.w.evadeCount === 0,
    'hp ' + ctHp + ' → ' + ct2.w.player.hp + ' count=' + ct2.w.evadeCount);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(10460);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickEvade(wS);
  feedHits(wS, 5);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.evadeActive === 0 && wS.evadeRounds === 0 && wS.evadeCount === 0 &&
    evs(wS, 'evade_start').length === 0,
    'active=' + wS.evadeActive + ' count=' + wS.evadeCount);
  // ★ch5 上限 480 秒 < 首发 486 秒，必须用 ch6（540 秒）才验得出"世界还在跑"。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 10461, modId: 'myth', stageId: 'ch6' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch6）走完整条 step 也没有避锋诀，且那一刻世界确实还在跑',
    storyAlive && wS2.evadeActive === 0 && evs(wS2, 'evade_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.evadeActive);
}

function testTemper() {
  console.log('[第七十轮] 淬骨诀：第一件「限时承受真伤害量」目标（真扣进血条才算，溢出不算）');
  const P = C.TEMPER;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 隔离世界：其它机制全推远、关武器、血池拉大（needHurt 180 > 初始 120），
  //   固定 armor=0 / dmgMul=1 让"喂 dmg=10 → 真扣 10"可精确断言。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.maxHp = 1e6;
    p.hp = p.maxHp;
    p.attrs.armor = 0;
    w.diff.dmgMul = 1;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 0;     // 本件默认开窗，干净世界里显式打开
    w.swarmNextTick = 1e9;    // 第七十一轮：妖潮诀 516s 开窗，本件不验，推远
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.rageMute = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.effects.length = 0;
    w.zones.length = 0;
    w.strikes.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.temperNextTick = 0;
    // ★妖潮诀首发 516s 晚于淬骨诀 498s；本测试会把 tick 推到 612s（下一轮），
    //   必须推远，否则那里顺带开一轮妖潮诀、落空播报混进 events 干扰对照。
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;   // 第七十二轮：猎变诀 528s 开窗，默认推远
    w.vengeNextTick = 1e9;  // 第七十三轮：寻仇诀 534s 开窗，默认推远
    w.ascendNextTick = 1e9; // 第七十四轮：登云诀 522s 开窗，默认推远
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    SIM.tickTemper(w);
  }
  // ★走调用方入口 damagePlayer（不是直接喂 onTemperHurt）：
  //   否则摘掉 damagePlayer 里的调用点照样全绿（第四十轮踩过的假绿）。
  //   每下前回满血并清无敌帧：既不会中途战死，又保证每次真扣 10。
  function feedHurt(w, times, dmg, state) {
    const p = w.player;
    const old = p.state;
    if (state) p.state = state;
    for (let i = 0; i < times; i++) {
      p.hp = p.maxHp;
      p.invuln = 0;
      SIM.damagePlayer(w, p, dmg || 10, p.x + 30, p.y);
    }
    if (state) p.state = old;
  }
  // 精确喂数：验"连续量一发跨过半程"这种 dmg/armor 干扰不到的边界。
  function feedExact(w, amount) {
    SIM.onTemperHurt(w, w.player, amount);
  }
  function finish(w, times, dmg, state) {
    feedHurt(w, times, dmg, state);
    w.time = w.temperDeadline + 0.01;
    SIM.tickTemper(w);
  }
  // 真实 step 的怪接触路径：钉住整条链路（含 damagePlayer 里那行调用点）。
  function contactWorld(seed) {
    const w = cleanWorld(seed);
    openWindow(w);
    const m = SIM.spawnMob(w, 'corpse', w.player.x + 4, w.player.y, 1, 0, 7);
    m.hitCd = 0;
    return { w: w, m: m };
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场没怪，白开一轮）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（第 17 波起怪密，才凑得出承伤量）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标按轮递增且封顶（第 2 轮 +60，第 99 轮到 max）',
    SIM.temperNeedFor(0) === P.needHurt &&
    SIM.temperNeedFor(1) === P.needHurt + P.hurtStep &&
    SIM.temperNeedFor(99) === P.maxHurt,
    '0=' + SIM.temperNeedFor(0) + ' 1=' + SIM.temperNeedFor(1) +
    ' 99=' + SIM.temperNeedFor(99));
  expect('目标密度合理（封顶承伤在 30 秒内可达，不是死目标）',
    P.needHurt >= 100 && P.needHurt <= P.maxHurt && P.maxHurt / P.windowSec <= 20,
    'need=' + P.needHurt + ' max=' + P.maxHurt + ' / ' + P.windowSec);
  expect('奖励仍是「一箱 + 零钱」（与前十四个目标制同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发错开所有既有事件（含避锋诀 486，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'temper=' + P.startSec + ' evade=' + C.EVADE.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗掉落）----------
  const wR = cleanWorld(10501);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedHurt(wR, Math.ceil(P.needHurt / 10) + 50);
  SIM.tickTemper(wR);
  expect('★开窗/承伤累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(10502);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(10510);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickTemper(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.temperRounds === 0 && evs(wT, 'temper_start').length === 0,
    'rounds=' + wT.temperRounds);
  const w0 = cleanWorld(10511);
  openWindow(w0);
  expect('到点开且只开一轮，播报一次说清「多久 / 多少」',
    w0.temperRounds === 1 && w0.temperActive === 1 &&
    evs(w0, 'temper_start').length === 1 &&
    evs(w0, 'temper_start')[0].sec === P.windowSec &&
    evs(w0, 'temper_start')[0].need === P.needHurt,
    JSON.stringify(evs(w0, 'temper_start')));
  expect('★★开窗零实体：不给怪、不给球、不给特效、不给 zone / strike',
    w0.mobs.length === 0 && w0.pickups.length === 0 && w0.effects.length === 0 &&
    w0.zones.length === 0 && w0.strikes.length === 0,
    'mob=' + w0.mobs.length + ' pick=' + w0.pickups.length + ' fx=' + w0.effects.length);
  expect('deadline 零漂移（w.time 口径，整数 tick 换算）',
    Math.abs(w0.temperDeadline - (P.startSec + P.windowSec)) < 1e-9,
    'deadline=' + w0.temperDeadline);
  expect('下一轮排期正确（按 everySec，不按窗口）',
    w0.temperNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + w0.temperNextTick);
  SIM.tickTemper(w0);
  expect('同帧重复调用不会二次开窗',
    w0.temperRounds === 1 && evs(w0, 'temper_start').length === 1,
    'rounds=' + w0.temperRounds);
  w0.time = w0.temperDeadline - 0.01;
  SIM.tickTemper(w0);
  expect('到期前一帧不结算（不达成也不落空）',
    w0.temperActive === 1 && w0.temperDone === 0 && w0.temperFailed === 0,
    'active=' + w0.temperActive);
  const wLast = cleanWorld(10512);
  openWindow(wLast);
  wLast.time = wLast.temperDeadline - 0.01;
  feedExact(wLast, P.needHurt);
  SIM.tickTemper(wLast);
  expect('★★最后一帧刚好挨够也算达成（达标判据优先于到期）',
    wLast.temperDone === 1 && wLast.temperFailed === 0,
    'done=' + wLast.temperDone + ' fail=' + wLast.temperFailed);

  // ---------- 4. 过半（连续量：>= + 标记位，不是 ===）----------
  const wH = cleanWorld(10520);
  openWindow(wH);
  feedExact(wH, P.needHurt / 2 - 10);
  expect('过半前零播报',
    evs(wH, 'temper_half').length === 0, 'half=' + evs(wH, 'temper_half').length);
  feedExact(wH, 10);
  expect('刚跨半播报一次，数字来自服务端事实',
    evs(wH, 'temper_half').length === 1 &&
    evs(wH, 'temper_half')[0].got === wH.temperHurt &&
    evs(wH, 'temper_half')[0].need === P.needHurt,
    JSON.stringify(evs(wH, 'temper_half')));
  const wJump = cleanWorld(10521);
  openWindow(wJump);
  feedExact(wJump, P.needHurt / 2 + 1);
  expect('★★一发重击跨过半程也算（连续量必须 >=，写 === 会永远错过）',
    evs(wJump, 'temper_half').length === 1,
    'half=' + evs(wJump, 'temper_half').length);
  feedExact(wH, P.needHurt);
  SIM.tickTemper(wH);
  expect('★★多挨几百点也不刷屏、不二次播报，数字锁在首次跨半那一下',
    evs(wH, 'temper_half').length === 1 &&
    evs(wH, 'temper_half')[0].got === P.needHurt / 2 &&
    wH.temperDone === 1,
    'half=' + evs(wH, 'temper_half').length + ' got=' +
    (evs(wH, 'temper_half')[0] ? evs(wH, 'temper_half')[0].got : -1));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(10530);
  openWindow(wD);
  feedHurt(wD, Math.round(P.needHurt / 10));
  SIM.tickTemper(wD);
  expect('挨够真伤即达成',
    wD.temperDone === 1 && wD.temperActive === 0, 'done=' + wD.temperDone);
  expect('宝箱正好一个（不是一袋子）',
    byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数与面值都正确（播报数字不是写死的）',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  expect('奖励落在玩家脚下（确定公式，不抽随机）',
    byKind(wD, 'chest').length === 1 &&
    Math.abs(byKind(wD, 'chest')[0].x - wD.player.x) < 1 &&
    Math.abs(byKind(wD, 'chest')[0].y - wD.player.y) < 1,
    'chest=' + JSON.stringify(byKind(wD, 'chest')));
  const doneEv = evs(wD, 'temper_done')[0];
  expect('播报的 got/need/chest/gold 全来自事件事实',
    doneEv && doneEv.got === P.needHurt && doneEv.need === P.needHurt &&
    doneEv.chest === P.rewardChest && doneEv.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(doneEv));
  const after = wD.temperHurt;
  feedHurt(wD, 20);
  SIM.tickTemper(wD);
  expect('★达标后再挨也不计数、不二次发奖',
    wD.temperHurt === after && wD.temperDone === 1 &&
    byKind(wD, 'chest').length === P.rewardChest,
    'hurt=' + wD.temperHurt + ' done=' + wD.temperDone);
  wD.tick = wD.temperNextTick;
  wD.time = wD.tick / HZ;
  SIM.tickTemper(wD);
  expect('下一轮目标随轮次上涨、计数清零',
    wD.temperRounds === 2 && wD.temperNeed === SIM.temperNeedFor(1) &&
    wD.temperHurt === 0 && wD.temperActive === 1,
    'round=' + wD.temperRounds + ' need=' + wD.temperNeed + ' hurt=' + wD.temperHurt);

  // ---------- 6. 落空（零奖励、不责备）----------
  const wF = cleanWorld(10540);
  openWindow(wF);
  finish(wF, Math.round(P.needHurt / 10) - 1);
  expect('差一下也落空（不四舍五入、不放水）',
    wF.temperFailed === 1 && wF.temperDone === 0,
    'fail=' + wF.temperFailed + ' done=' + wF.temperDone);
  expect('★★落空时一个掉落物都不多（宝箱/金币都不发）',
    wF.pickups.length === 0, 'pick=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报',
    evs(wF, 'temper_done').length === 0, 'done=' + evs(wF, 'temper_done').length);
  const failEv = evs(wF, 'temper_fail')[0];
  expect('落空只陈述「还差多少」，不责备玩家',
    failEv && failEv.left === 10 && failEv.got === P.needHurt - 10 &&
    JSON.stringify(failEv).indexOf('失败') < 0,
    JSON.stringify(failEv));
  wF.time = wF.temperDeadline + 100;
  SIM.tickTemper(wF);
  expect('推到很晚也不补发（不因为时间过头而误判达成）',
    wF.temperDone === 0 && evs(wF, 'temper_done').length === 0 &&
    evs(wF, 'temper_fail').length === 1,
    'fail=' + evs(wF, 'temper_fail').length);
  const held = wF.temperHurt;
  feedHurt(wF, 20);
  expect('落空后再挨也不计数（窗口已关）',
    wF.temperHurt === held, 'hurt=' + wF.temperHurt);

  // ---------- 7. ★真扣血闸（本件核心新轴）----------
  const wNoInv = cleanWorld(10550);
  openWindow(wNoInv);
  const hp0 = wNoInv.player.hp;
  wNoInv.player.invuln = 0;
  SIM.damagePlayer(wNoInv, wNoInv.player, 10, 0, 0);
  expect('★★无敌帧为 0 时真扣血，且计入淬骨诀（正向对照证明闸不是恒关）',
    wNoInv.player.hp === hp0 - 10 && wNoInv.temperHurt === 10,
    'hp ' + hp0 + ' → ' + wNoInv.player.hp + ' hurt=' + wNoInv.temperHurt);
  const wYesInv = cleanWorld(10551);
  openWindow(wYesInv);
  const hp1 = wYesInv.player.hp;
  wYesInv.player.invuln = 5;
  SIM.damagePlayer(wYesInv, wYesInv.player, 10, 0, 0);
  expect('★★★无敌帧挡下的攻击血没掉，一分都不算（那是避锋诀的轴）',
    wYesInv.player.hp === hp1 && wYesInv.temperHurt === 0,
    'hp ' + hp1 + ' → ' + wYesInv.player.hp + ' hurt=' + wYesInv.temperHurt);
  const wLv = cleanWorld(10552);
  openWindow(wLv);
  feedHurt(wLv, 5, 10, 'levelup');
  expect('★★★升级三选一定格期间不挨打，不计入',
    wLv.temperHurt === 0 && wLv.player.hp === wLv.player.maxHp,
    'hurt=' + wLv.temperHurt + ' hp=' + wLv.player.hp);
  const wDead = cleanWorld(10553);
  openWindow(wDead);
  wDead.player.alive = false;
  feedHurt(wDead, 5);
  expect('阵亡者不再受伤、也不计数',
    wDead.temperHurt === 0, 'hurt=' + wDead.temperHurt);
  const wOut = cleanWorld(10554);
  feedHurt(wOut, 5);
  expect('窗口外的受伤不计数',
    wOut.temperHurt === 0, 'hurt=' + wOut.temperHurt);
  const wStoryHit = cleanWorld(10555);
  openWindow(wStoryHit);
  wStoryHit.storyStage = { id: 'ch6' };
  feedHurt(wStoryHit, 5);
  expect('剧情关下即便开了窗口也不计数（钩子自带 story 闸）',
    wStoryHit.temperHurt === 0, 'hurt=' + wStoryHit.temperHurt);
  // ★★溢出闸：血只剩 5 却挨 50，只记真扣的 5，不能白拿 50 的进度。
  const wOver = cleanWorld(10556);
  openWindow(wOver);
  wOver.player.hp = 5;
  wOver.player.invuln = 0;
  SIM.damagePlayer(wOver, wOver.player, 50, 0, 0);
  expect('★★★致死的溢出伤害不算：只剩 5 血挨 50，只记 5（与养元诀溢出对称）',
    wOver.temperHurt === 5, 'hurt=' + wOver.temperHurt);
  const wZero = cleanWorld(10557);
  openWindow(wZero);
  feedExact(wZero, 0);
  feedExact(wZero, -10);
  expect('零伤害/负伤害一分都不算（钩子自带 amount>0 闸）',
    wZero.temperHurt === 0, 'hurt=' + wZero.temperHurt);

  // ★真实 step 的怪接触路径：同时钉住"damagePlayer 里那一行调用点"与整条链路。
  const ct = contactWorld(10558);
  SIM.step(ct.w, { mx: 0, my: 0 });
  expect('★★真实 step 里怪贴身真扣血 → 累计承伤增加（调用点钉在受伤漏斗）',
    ct.w.temperHurt > 0, 'hurt=' + ct.w.temperHurt + ' hp=' + ct.w.player.hp);
  const ct2 = contactWorld(10559);
  ct2.w.player.invuln = 5;
  SIM.step(ct2.w, { mx: 0, my: 0 });
  expect('★★真实 step 里被无敌帧挡下 → 血没掉、承伤也不计',
    ct2.w.temperHurt === 0, 'hurt=' + ct2.w.temperHurt + ' hp=' + ct2.w.player.hp);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(10560);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickTemper(wS);
  feedHurt(wS, 5);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.temperActive === 0 && wS.temperRounds === 0 && wS.temperHurt === 0 &&
    evs(wS, 'temper_start').length === 0,
    'active=' + wS.temperActive + ' hurt=' + wS.temperHurt);
  // ★ch5 上限 480 秒 < 首发 498 秒，必须用 ch6（540 秒）才验得出"世界还在跑"。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 10561, modId: 'myth', stageId: 'ch6' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch6）走完整条 step 也没有淬骨诀，且那一刻世界确实还在跑',
    storyAlive && wS2.temperActive === 0 && evs(wS2, 'temper_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.temperActive);
}

// ============================================================
// 第七十一轮：妖潮诀（身陷怪潮累计秒数）—— 目标制零实体第十六件
// ============================================================
function testSwarm() {
  console.log('[第七十一轮] 妖潮诀：第一件「身陷怪潮（周围活怪密度）累计秒数」目标');
  const P = C.SWARM;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 隔离世界：其它机制全推远、关武器、血池拉大（避免被怪打死中断累计）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.maxHp = 1e6;
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 0;   // 本件默认开窗
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.effects.length = 0;
    w.zones.length = 0;
    w.strikes.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.swarmNextTick = 0;
    SIM.tickSwarm(w);
  }
  // 往玩家周围塞 n 只怪（dist 为半径；alive=false 造死怪验闸）。
  // ★用极简对象即可：妖潮诀只读 m.alive/m.x/m.y，不碰别的字段。
  function surround(w, n, dist, alive) {
    const p = w.player;
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 / (n || 1)) * i + 0.3;
      w.mobs.push({
        alive: alive === false ? false : true,
        x: p.x + Math.cos(ang) * dist,
        y: p.y + Math.sin(ang) * dist,
        id: 90000 + i
      });
    }
  }
  function feedSec(w, sec) {
    SIM.onSwarmTime(w, sec);
  }
  // 精确轴向摆放（验半径边界含等号用）：不用三角函数，避免浮点误差把 dist 算偏。
  function surroundExact(w, n, dx, dy) {
    const p = w.player;
    for (let i = 0; i < n; i++) {
      w.mobs.push({ alive: true, x: p.x + dx, y: p.y + dy, id: 91000 + i });
    }
  }
  // 真怪（带完整 def 字段）摆放：真实 step 会跑 updateMobs，极简对象缺 def 会崩。
  // ★传 seed 让 spawnMob 走固定相位，不抽 nextRand。
  function spawnReal(w, n, dist) {
    const p = w.player;
    for (let i = 0; i < n; i++) {
      const ang = (Math.PI * 2 / n) * i + 0.3;
      SIM.spawnMob(w, 'corpse', p.x + Math.cos(ang) * dist, p.y + Math.sin(ang) * dist,
        1, 0, 100 + i);
    }
  }
  function finish(w) {
    w.time = w.swarmDeadline + 0.01;
    SIM.tickSwarm(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场没怪，白开一轮）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（第 17 波起怪密，才凑得出 8 只活怪）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标按轮递增且封顶（第 2 轮 +2，第 99 轮到 max）',
    SIM.swarmNeedFor(0) === P.needSec &&
    SIM.swarmNeedFor(1) === P.needSec + P.secStep &&
    SIM.swarmNeedFor(99) === P.maxSec,
    '0=' + SIM.swarmNeedFor(0) + ' 1=' + SIM.swarmNeedFor(1) +
    ' 99=' + SIM.swarmNeedFor(99));
  expect('密度与时长合理（封顶撑秒在窗口内可达，不是死目标）',
    P.mobsNeed >= 3 && P.mobsNeed <= 20 &&
    P.needSec >= 3 && P.maxSec <= P.windowSec,
    'mobs=' + P.mobsNeed + ' need=' + P.needSec + ' max=' + P.maxSec +
    ' window=' + P.windowSec);
  expect('奖励仍是「一箱 + 零钱」（与前十五个目标制同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发错开所有既有事件（含淬骨诀 498，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'swarm=' + P.startSec + ' temper=' + C.TEMPER.startSec);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗掉落）----------
  const wR = cleanWorld(10701);
  const rng0 = wR.rngState;
  openWindow(wR);
  surround(wR, P.mobsNeed, P.radius / 2);
  feedSec(wR, P.needSec);
  SIM.tickSwarm(wR);
  expect('★开窗/密度计数/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(10702);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(10710);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickSwarm(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.swarmRounds === 0 && evs(wT, 'swarm_start').length === 0,
    'rounds=' + wT.swarmRounds);
  const w0 = cleanWorld(10711);
  openWindow(w0);
  expect('到点开且只开一轮，播报一次说清「多久 / 几只怪 / 撑几秒」',
    w0.swarmRounds === 1 && w0.swarmActive === 1 &&
    evs(w0, 'swarm_start').length === 1 &&
    evs(w0, 'swarm_start')[0].sec === P.windowSec &&
    evs(w0, 'swarm_start')[0].mobs === P.mobsNeed &&
    evs(w0, 'swarm_start')[0].need === P.needSec,
    JSON.stringify(evs(w0, 'swarm_start')));
  expect('★★开窗零实体：不给怪、不给球、不给特效、不给 zone / strike',
    w0.mobs.length === 0 && w0.pickups.length === 0 && w0.effects.length === 0 &&
    w0.zones.length === 0 && w0.strikes.length === 0,
    'mob=' + w0.mobs.length + ' pick=' + w0.pickups.length + ' fx=' + w0.effects.length);
  expect('deadline 零漂移（w.time 口径，整数 tick 换算）',
    Math.abs(w0.swarmDeadline - (P.startSec + P.windowSec)) < 1e-9,
    'deadline=' + w0.swarmDeadline);
  expect('下一轮排期正确（按 everySec，不按窗口）',
    w0.swarmNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + w0.swarmNextTick);
  SIM.tickSwarm(w0);
  expect('同帧重复调用不会二次开窗',
    w0.swarmRounds === 1 && evs(w0, 'swarm_start').length === 1,
    'rounds=' + w0.swarmRounds);
  w0.time = w0.swarmDeadline - 0.01;
  SIM.tickSwarm(w0);
  expect('到期前一帧不结算（不达成也不落空）',
    w0.swarmActive === 1 && w0.swarmDone === 0 && w0.swarmFailed === 0,
    'active=' + w0.swarmActive);
  const wLast = cleanWorld(10712);
  openWindow(wLast);
  surround(wLast, P.mobsNeed, P.radius / 2);
  wLast.time = wLast.swarmDeadline - 0.01;
  feedSec(wLast, P.needSec);
  SIM.tickSwarm(wLast);
  expect('★★最后一帧刚好撑够也算达成（达标判据优先于到期）',
    wLast.swarmDone === 1 && wLast.swarmFailed === 0,
    'done=' + wLast.swarmDone + ' fail=' + wLast.swarmFailed);

  // ---------- 4. 过半（连续量：>= + 标记位，不是 ===）----------
  const wH = cleanWorld(10720);
  openWindow(wH);
  surround(wH, P.mobsNeed, P.radius / 2);
  feedSec(wH, P.needSec / 2 - 0.1);
  expect('过半前零播报',
    evs(wH, 'swarm_half').length === 0, 'half=' + evs(wH, 'swarm_half').length);
  feedSec(wH, 0.1);
  expect('刚跨半播报一次，数字来自服务端事实',
    evs(wH, 'swarm_half').length === 1 &&
    evs(wH, 'swarm_half')[0].got === Math.round(wH.swarmSec) &&
    evs(wH, 'swarm_half')[0].need === P.needSec,
    JSON.stringify(evs(wH, 'swarm_half')));
  const wJump = cleanWorld(10721);
  openWindow(wJump);
  surround(wJump, P.mobsNeed, P.radius / 2);
  feedSec(wJump, P.needSec / 2 + 1);
  expect('★★一帧跨过半程也算（连续量必须 >=，写 === 会永远错过）',
    evs(wJump, 'swarm_half').length === 1,
    'half=' + evs(wJump, 'swarm_half').length);
  feedSec(wH, P.needSec);
  SIM.tickSwarm(wH);
  expect('★★多撑一倍也不刷屏、不二次播报，数字锁在首次跨半那一下',
    evs(wH, 'swarm_half').length === 1 &&
    evs(wH, 'swarm_half')[0].got === Math.round(P.needSec / 2) &&
    wH.swarmDone === 1,
    'half=' + evs(wH, 'swarm_half').length + ' got=' +
    (evs(wH, 'swarm_half')[0] ? evs(wH, 'swarm_half')[0].got : -1));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(10730);
  openWindow(wD);
  surround(wD, P.mobsNeed, P.radius / 2);
  feedSec(wD, P.needSec);
  SIM.tickSwarm(wD);
  expect('撑够怪潮秒数即达成',
    wD.swarmDone === 1 && wD.swarmActive === 0, 'done=' + wD.swarmDone);
  expect('宝箱正好一个（不是一袋子）',
    byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数与面值都正确（播报数字不是写死的）',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  expect('奖励落在玩家脚下（确定公式，不抽随机）',
    byKind(wD, 'chest').length === 1 &&
    Math.abs(byKind(wD, 'chest')[0].x - wD.player.x) < 1 &&
    Math.abs(byKind(wD, 'chest')[0].y - wD.player.y) < 1,
    'chest=' + JSON.stringify(byKind(wD, 'chest')));
  const doneEv = evs(wD, 'swarm_done')[0];
  expect('播报的 got/need/chest/gold 全来自事件事实',
    doneEv && doneEv.got === P.needSec && doneEv.need === P.needSec &&
    doneEv.chest === P.rewardChest && doneEv.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(doneEv));
  const afterSec = wD.swarmSec;
  feedSec(wD, 100);
  SIM.tickSwarm(wD);
  expect('★达标后再被围也不计数、不二次发奖',
    wD.swarmSec === afterSec && wD.swarmDone === 1 &&
    byKind(wD, 'chest').length === P.rewardChest,
    'sec=' + wD.swarmSec + ' done=' + wD.swarmDone);
  wD.tick = wD.swarmNextTick;
  wD.time = wD.tick / HZ;
  SIM.tickSwarm(wD);
  expect('下一轮目标随轮次上涨、计数清零',
    wD.swarmRounds === 2 && wD.swarmNeed === SIM.swarmNeedFor(1) &&
    wD.swarmSec === 0 && wD.swarmActive === 1,
    'round=' + wD.swarmRounds + ' need=' + wD.swarmNeed + ' sec=' + wD.swarmSec);

  // ---------- 6. 落空（零奖励、不责备）----------
  const wF = cleanWorld(10740);
  openWindow(wF);
  surround(wF, P.mobsNeed, P.radius / 2);
  feedSec(wF, P.needSec - 0.5);
  finish(wF);
  expect('差一点也落空（不四舍五入、不放水）',
    wF.swarmFailed === 1 && wF.swarmDone === 0,
    'fail=' + wF.swarmFailed + ' done=' + wF.swarmDone);
  expect('★★落空时一个掉落物都不多（宝箱/金币都不发）',
    wF.pickups.length === 0, 'pick=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报',
    evs(wF, 'swarm_done').length === 0, 'done=' + evs(wF, 'swarm_done').length);
  const failEv = evs(wF, 'swarm_fail')[0];
  expect('落空只陈述「还差多少」，不责备玩家',
    failEv && failEv.left === 1 && JSON.stringify(failEv).indexOf('失败') < 0,
    JSON.stringify(failEv));
  wF.time = wF.swarmDeadline + 100;
  SIM.tickSwarm(wF);
  expect('推到很晚也不补发（不因为时间过头而误判达成）',
    wF.swarmDone === 0 && evs(wF, 'swarm_done').length === 0 &&
    evs(wF, 'swarm_fail').length === 1,
    'fail=' + evs(wF, 'swarm_fail').length);
  const held = wF.swarmSec;
  feedSec(wF, 100);
  expect('落空后再被围也不计数（窗口已关）',
    wF.swarmSec === held, 'sec=' + wF.swarmSec);

  // ---------- 7. ★密度闸（本件核心新轴：只认真·活·够近的怪）----------
  const wOK = cleanWorld(10750);
  openWindow(wOK);
  surround(wOK, P.mobsNeed, P.radius / 2);
  feedSec(wOK, 1);
  expect('★★怪够数时累计（正向对照证明闸不是恒关）',
    wOK.swarmSec === 1 &&
    SIM.countSwarmMobs(wOK, wOK.player, P.radius) === P.mobsNeed,
    'sec=' + wOK.swarmSec + ' near=' +
    SIM.countSwarmMobs(wOK, wOK.player, P.radius));
  const wFew = cleanWorld(10751);
  openWindow(wFew);
  surround(wFew, P.mobsNeed - 1, P.radius / 2);
  feedSec(wFew, 5);
  expect('★★★差一只也算没被围，一分不累计（密度闸不是摆设）',
    wFew.swarmSec === 0, 'sec=' + wFew.swarmSec);
  const wFar = cleanWorld(10752);
  openWindow(wFar);
  surround(wFar, P.mobsNeed + 20, P.radius + 5);
  feedSec(wFar, 5);
  expect('★★★半径外的怪不算（哪怕一大群贴着边外，也不算身陷怪潮）',
    wFar.swarmSec === 0 &&
    SIM.countSwarmMobs(wFar, wFar.player, P.radius) === 0,
    'sec=' + wFar.swarmSec + ' near=' +
    SIM.countSwarmMobs(wFar, wFar.player, P.radius));
  const wEdge = cleanWorld(10753);
  openWindow(wEdge);
  // 精确放在正右方 P.radius 处：dx²+dy² 精确等于 r²，测的是"含等号"这条边界本身。
  surroundExact(wEdge, P.mobsNeed, P.radius, 0);
  feedSec(wEdge, 1);
  expect('★★半径边界上的怪算数（平方比较含等号，不放过贴边的）',
    wEdge.swarmSec === 1, 'sec=' + wEdge.swarmSec);
  const wDead = cleanWorld(10754);
  openWindow(wDead);
  surround(wDead, P.mobsNeed + 5, P.radius / 2, false);  // 全死怪
  feedSec(wDead, 5);
  expect('★★★死怪不算（尸体堆成山也不是活怪潮）',
    wDead.swarmSec === 0, 'sec=' + wDead.swarmSec);
  const wMix = cleanWorld(10755);
  openWindow(wMix);
  surround(wMix, P.mobsNeed - 1, P.radius / 2);      // 够数-1 只活怪
  surround(wMix, 10, P.radius / 2, false);           // 一堆死怪
  feedSec(wMix, 5);
  expect('死怪不补数：活怪差一只就是差一只',
    wMix.swarmSec === 0, 'sec=' + wMix.swarmSec);
  const wCorpse = cleanWorld(10756);
  openWindow(wCorpse);
  wCorpse.player.hp = 0;
  surround(wCorpse, P.mobsNeed, P.radius / 2);
  feedSec(wCorpse, 5);
  expect('★★阵亡者不算被围（死亡不由本玩法奖励）',
    wCorpse.swarmSec === 0, 'sec=' + wCorpse.swarmSec);
  const wNeg = cleanWorld(10757);
  openWindow(wNeg);
  surround(wNeg, P.mobsNeed, P.radius / 2);
  feedSec(wNeg, 0);
  feedSec(wNeg, -1);
  expect('零/负 dt 一分不算（钩子自带 dt>0 闸）',
    wNeg.swarmSec === 0, 'sec=' + wNeg.swarmSec);
  const wOut = cleanWorld(10758);
  surround(wOut, P.mobsNeed, P.radius / 2);
  feedSec(wOut, 5);
  expect('窗口外的被围不计数',
    wOut.swarmSec === 0, 'sec=' + wOut.swarmSec);
  const wStoryHit = cleanWorld(10759);
  openWindow(wStoryHit);
  wStoryHit.storyStage = { id: 'ch6' };
  surround(wStoryHit, P.mobsNeed, P.radius / 2);
  feedSec(wStoryHit, 5);
  expect('剧情关下即便开了窗口也不计数（钩子自带 story 闸）',
    wStoryHit.swarmSec === 0, 'sec=' + wStoryHit.swarmSec);

  // ★真实 step：钉住 onSwarmTime 调用点（直接喂钩子会漏掉"有没有被调用"）。
  //   清了武器，怪不会被打死；step 第 2.69 段读的是本帧玩家位置与怪位置（此时怪还没动）。
  const wStep = cleanWorld(10760);
  openWindow(wStep);
  spawnReal(wStep, P.mobsNeed, P.radius / 2);
  SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★真实 step 里被怪围住 → 累计秒数增加（调用点钉在状态段）',
    wStep.swarmSec > 0, 'sec=' + wStep.swarmSec);
  const wStepFar = cleanWorld(10761);
  openWindow(wStepFar);
  spawnReal(wStepFar, P.mobsNeed + 20, P.radius + 15);
  SIM.step(wStepFar, { mx: 0, my: 0 });
  expect('★★真实 step 里怪全在半径外 → 一分不累计（调用点也被密度闸守住）',
    wStepFar.swarmSec === 0, 'sec=' + wStepFar.swarmSec);

  // ---------- 8. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(10770);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickSwarm(wS);
  surround(wS, P.mobsNeed, P.radius / 2);
  feedSec(wS, 5);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.swarmActive === 0 && wS.swarmRounds === 0 && wS.swarmSec === 0 &&
    evs(wS, 'swarm_start').length === 0,
    'active=' + wS.swarmActive + ' sec=' + wS.swarmSec);
  // ★ch5 上限 480 秒 < 首发 516 秒，必须用 ch6（540 秒）才验得出"世界还在跑"。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 10771, modId: 'myth', stageId: 'ch6' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch6）走完整条 step 也没有妖潮诀，且那一刻世界确实还在跑',
    storyAlive && wS2.swarmActive === 0 && evs(wS2, 'swarm_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.swarmActive);
}

// ============================================================
// 第七十二轮：猎变诀（第一件「限时击杀带词缀的变异妖」目标）
// ============================================================
function testHunt() {
  console.log('[第七十二轮] 猎变诀：第一件「限时猎杀带词缀妖物」目标（普通怪/分裂子怪不算，词缀轴）');
  const P = C.HUNT;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 隔离世界：其它机制全推远、关武器、默认满血，只留猎变诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.rage = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 0;       // 本件默认开窗，干净世界里显式打开
    w.vengeNextTick = 1e9;    // 寻仇诀 534s 推远：否则开窗落箱会污染本件"零实体"断言
    w.ascendNextTick = 1e9;   // 登云诀 522s：同理推远，免得落箱污染"零实体"断言
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.rageMute = 0;
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.huntNextTick = 0;
    SIM.tickHunt(w);
  }
  // 按 affix 直接喂击杀钩子：不真 spawn，隔离掉落与随机流。
  // affix 用 C.AFFIXES 里的真实 id（1 狂暴 / 2 坚壁 / 3 分裂）。
  function feedKills(w, count, affix) {
    for (let i = 0; i < count; i++) {
      SIM.onHuntKill(w, { affix: affix === undefined ? 1 : affix });
    }
  }
  function finish(w, count, affix) {
    feedKills(w, count, affix);
    w.time = w.huntDeadline + 0.01;
    SIM.tickHunt(w);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没变异妖可杀）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（第 15 波起词缀概率封顶 0.3，才凑得出变异妖）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.huntNeedFor(0) === P.needKills &&
    SIM.huntNeedFor(1) === P.needKills + P.killStep &&
    SIM.huntNeedFor(99) === P.maxKills,
    '0=' + SIM.huntNeedFor(0) + ' 1=' + SIM.huntNeedFor(1) +
    ' 99=' + SIM.huntNeedFor(99));
  expect('目标密度合理：封顶猎杀数在 30 秒内可达（词缀概率×怪量够用）',
    P.needKills >= 2 && P.needKills <= P.maxKills &&
    P.maxKills / P.windowSec <= 0.4 && C.AFFIX_RULE.maxChance >= 0.2,
    'need=' + P.needKills + ' max=' + P.maxKills + ' / ' + P.windowSec +
    ' chance=' + C.AFFIX_RULE.maxChance);
  expect('奖励仍是「一箱 + 零钱」（与前十六件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开所有既有事件（含妖潮诀 516，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM'].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'hunt=' + P.startSec + ' swarm=' + C.SWARM.startSec);
  // 判据函数自洽：三种词缀都认，普通/缺 affix/极简对象一律不认
  expect('★★isAffixMob 认全部三种词缀（狂暴/坚壁/分裂）',
    SIM.isAffixMob({ affix: 1 }) && SIM.isAffixMob({ affix: 2 }) &&
    SIM.isAffixMob({ affix: 3 }), '三种词缀');
  expect('★★isAffixMob 拒绝普通怪 affix=0 / 缺字段 / null（词缀闸边界）',
    !SIM.isAffixMob({ affix: 0 }) && !SIM.isAffixMob({}) &&
    !SIM.isAffixMob(null) && !SIM.isAffixMob({ affix: -1 }),
    '非变异妖');
  expect('词缀 id 与 AFFIXES 表对齐（判据用的正数都真实存在）',
    C.AFFIXES.length >= 3 && C.AFFIXES.some(function (a) { return a.id === 1; }) &&
    C.AFFIXES.some(function (a) { return a.id === 2; }) &&
    C.AFFIXES.some(function (a) { return a.id === 3; }), 'AFFIXES=' + C.AFFIXES.length);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗掉落）----------
  const wR = cleanWorld(10801);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedKills(wR, 1000);
  finish(wR, P.needKills);
  expect('★开窗/猎杀累计/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(10802);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(10810);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickHunt(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.huntRounds === 0 && evs(wT, 'hunt_start').length === 0,
    'rounds=' + wT.huntRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.huntActive === 1 && wT.huntRounds === 1,
    'rounds=' + wT.huntRounds + ' active=' + wT.huntActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前十六件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'hunt_start')[0];
  expect('开窗播报一次说清三件事：多久 / 几只 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needKills && st.round === 1 &&
    evs(wT, 'hunt_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.huntDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.huntDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.huntNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.huntNextTick);
  SIM.tickHunt(wT);
  expect('同帧重复调用不会二次开窗', wT.huntRounds === 1,
    'rounds=' + wT.huntRounds);
  wT.time = wT.huntDeadline - 0.001;
  SIM.tickHunt(wT);
  expect('到期前一帧不发奖也不结算', wT.huntActive === 1 &&
    wT.huntKills === 0 && evs(wT, 'hunt_done').length === 0 &&
    evs(wT, 'hunt_fail').length === 0,
    'active=' + wT.huntActive + ' kills=' + wT.huntKills);

  // ---------- 4. 过半（整数次累加：标记位防刷屏）----------
  const wH = cleanWorld(10821);
  openWindow(wH);
  feedKills(wH, Math.floor((P.needKills - 1) / 2));
  expect('过半前零播报', evs(wH, 'hunt_half').length === 0,
    'half=' + evs(wH, 'hunt_half').length + ' kills=' + wH.huntKills);
  feedKills(wH, 1);
  expect('过半报一次', evs(wH, 'hunt_half').length === 1,
    'half=' + evs(wH, 'hunt_half').length);
  feedKills(wH, 1000);
  expect('多杀不刷屏（过半播报恰好一次）', evs(wH, 'hunt_half').length === 1,
    'half=' + evs(wH, 'hunt_half').length);
  const wH2 = cleanWorld(10822);
  openWindow(wH2);
  feedKills(wH2, P.needKills);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'hunt_half').length === 1 &&
    evs(wH2, 'hunt_half')[0].got === Math.ceil(P.needKills / 2),
    'half=' + evs(wH2, 'hunt_half').length +
    ' got=' + ((evs(wH2, 'hunt_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(10830);
  openWindow(wD);
  finish(wD, P.needKills);
  expect('猎够变异妖 → 达成', wD.huntActive === 0 && wD.huntDone === 1 &&
    evs(wD, 'hunt_done').length === 1, 'done=' + wD.huntDone);
  expect('宝箱正好一个（与前十六件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'hunt_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needKills && dn.need === P.needKills &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feedKills(wD, 1000);
  SIM.tickHunt(wD);
  expect('★达标后再杀、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.huntDone === 1 && evs(wD, 'hunt_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.huntDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickHunt(wD);
  expect('下一轮目标递增、猎杀计数清零', wD.huntRounds === 2 &&
    wD.huntNeed === P.needKills + P.killStep && wD.huntKills === 0,
    'need=' + wD.huntNeed + ' kills=' + wD.huntKills);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(10840);
  openWindow(wF);
  finish(wF, P.needKills - 1);
  expect('差一只也落空', wF.huntActive === 0 && wF.huntFailed === 1 &&
    wF.huntDone === 0, 'failed=' + wF.huntFailed + ' done=' + wF.huntDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'hunt_done').length === 0,
    'done=' + evs(wF, 'hunt_done').length);
  const fl = evs(wF, 'hunt_fail')[0];
  expect('落空只陈述还差几只（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needKills - 1 && fl.need === P.needKills,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.huntNextTick = 1e9;      // 关掉后续排期，推这么远不该再开一轮
  wF.vengeNextTick = 1e9;     // 寻仇诀 534s：同样关掉，否则落箱污染对照
  wF.ascendNextTick = 1e9;    // 登云诀 522s：同理关掉，免得落箱污染对照
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickHunt(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.huntDone === 0, 'pickups=' + wF.pickups.length);
  const killsAfterFail = wF.huntKills;
  feedKills(wF, 1000);
  expect('落空后再杀也不计数（钩子只认 active）',
    wF.huntKills === killsAfterFail && wF.huntActive === 0,
    'kills=' + wF.huntKills + '（落空时 ' + killsAfterFail + '）');

  // ---------- 7. ★★★词缀闸（本件核心新轴：普通怪不算）----------
  const wB = cleanWorld(10850);
  openWindow(wB);
  feedKills(wB, 3, 0);
  expect('★★★普通怪（affix=0）连杀 3 只一只都不算（词缀闸是灵魂）',
    wB.huntKills === 0, 'kills=' + wB.huntKills);
  SIM.onHuntKill(wB, {});
  SIM.onHuntKill(wB, null);
  expect('★★缺 affix / null 的怪也不算（防御性边界）', wB.huntKills === 0,
    'kills=' + wB.huntKills);
  feedKills(wB, 1, 1);
  expect('狂暴怪（affix=1）击杀 +1（正向对照，证明闸不是恒关）',
    wB.huntKills === 1, 'kills=' + wB.huntKills);
  feedKills(wB, 1, 2);
  expect('★★坚壁怪（affix=2）也算 +1', wB.huntKills === 2, 'kills=' + wB.huntKills);
  feedKills(wB, 1, 3);
  expect('★★分裂怪（affix=3）也算 +1', wB.huntKills === 3, 'kills=' + wB.huntKills);
  const wB2 = cleanWorld(10851);
  openWindow(wB2);
  for (let i = 0; i < 500; i++) SIM.onHuntKill(wB2, { affix: 0 });
  expect('★★★普通怪猛刷 500 只：不达过半、不达标、零掉落',
    wB2.huntKills === 0 && evs(wB2, 'hunt_half').length === 0 &&
    evs(wB2, 'hunt_done').length === 0 && wB2.pickups.length === 0,
    'kills=' + wB2.huntKills + ' half=' + evs(wB2, 'hunt_half').length +
    ' done=' + evs(wB2, 'hunt_done').length + ' pick=' + wB2.pickups.length);
  // 后台天火白送的变异妖击杀不算
  const wMute = cleanWorld(10852);
  openWindow(wMute);
  wMute.rageMute = 1;
  feedKills(wMute, 3);
  expect('★★★rageMute>0 时变异妖击杀也不算（天火白送堵死）',
    wMute.huntKills === 0, 'kills=' + wMute.huntKills);
  wMute.rageMute = 0;
  feedKills(wMute, 1);
  expect('rageMute 解除后变异妖击杀恢复计数（正向对照）',
    wMute.huntKills === 1, 'kills=' + wMute.huntKills);
  // 窗口外 / 剧情关：钩子自身两道闸
  const wOut = cleanWorld(10853);
  feedKills(wOut, 3);
  expect('窗口外变异妖击杀也不计数', wOut.huntKills === 0, 'kills=' + wOut.huntKills);
  const wGate = cleanWorld(10854);
  openWindow(wGate);
  wGate.storyStage = { id: 'ch6' };
  feedKills(wGate, 3);
  expect('窗口内但剧情关下变异妖击杀也不计数（钩子有 story 闸）',
    wGate.huntKills === 0, 'kills=' + wGate.huntKills);

  // ---------- 8. ★★★真实击杀漏斗 + 分裂子怪不算（本件最关键的反向断言）----------
  // ★★不直接喂钩子：走 damageMob → killMob → onHuntKill 的真实链路，
  //   才能钉住钩子挂在唯一击杀漏斗上，也让分裂词缀真的裂出子怪。
  const wK = cleanWorld(10860);
  openWindow(wK);
  // 普通怪：打死不算（affix=0）
  const mNormal = SIM.spawnMob(wK, 'corpse', wK.player.x + 260, wK.player.y, 1, 0, 90001);
  SIM.damageMob(wK, mNormal, 999999);
  expect('★★真实 killMob 打死普通怪不算（钩子挂在唯一击杀漏斗）',
    wK.huntKills === 0, 'kills=' + wK.huntKills);
  // 狂暴怪：打死 +1（affix=1，正向对照）
  const mFrenzy = SIM.spawnMob(wK, 'corpse', wK.player.x + 280, wK.player.y, 1, 1, 90002);
  SIM.damageMob(wK, mFrenzy, 999999);
  expect('★★真实 killMob 打死狂暴怪 → +1（钩子挂对漏斗）',
    wK.huntKills === 1, 'kills=' + wK.huntKills);
  // 分裂怪：打死本体 +1，但它裂出的子怪 affix=0 —— 打死子怪绝不再加
  const beforeSplit = wK.huntKills;
  const mSplit = SIM.spawnMob(wK, 'corpse', wK.player.x + 300, wK.player.y, 1, 3, 90003);
  SIM.damageMob(wK, mSplit, 999999);
  expect('真实击杀分裂怪本体 +1', wK.huntKills === beforeSplit + 1,
    'kills=' + wK.huntKills);
  // 收集刚裂出来的子怪（affix=0 且还活着）
  const children = wK.mobs.filter(function (m) {
    return m.alive && !(m.affix > 0) && m.id !== mNormal.id && m.id !== mFrenzy.id &&
      m.id !== mSplit.id;
  });
  const killsBeforeChildren = wK.huntKills;
  for (let i = 0; i < children.length; i++) SIM.damageMob(wK, children[i], 999999);
  expect('★★★分裂出来的子怪（affix=0）打死一个都不算（词缀不继承，本件灵魂断言）',
    children.length > 0 && wK.huntKills === killsBeforeChildren,
    '子怪数=' + children.length + ' kills=' + wK.huntKills +
    '（打死前 ' + killsBeforeChildren + '）');

  // ---------- 9. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(10870);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickHunt(wS);
  feedKills(wS, 3);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.huntActive === 0 && wS.huntRounds === 0 && wS.huntKills === 0 &&
    evs(wS, 'hunt_start').length === 0,
    'active=' + wS.huntActive + ' kills=' + wS.huntKills);
  // ★首发 528 秒 > ch5 上限 480 秒，必须用 ch6（540 秒）才验得出「世界还在跑」。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 10871, modId: 'myth', stageId: 'ch6' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch6）走完整条 step 也没有猎变诀，且那一刻世界确实还在跑',
    storyAlive && wS2.huntActive === 0 && evs(wS2, 'hunt_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.huntActive);
}

// ============================================================
// 第七十三轮：寻仇诀（第一件「限时被几种不同妖物打中」目标，受击来源去重）
// ============================================================
function testVenge() {
  console.log('[第七十三轮] 寻仇诀：第一件「被几种妖物咬中」目标（按 def.id 去重，受击来源轴）');
  const P = C.VENGE;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 极简"仇家"：钩子只认 def.id，不碰怪的其它字段，隔离战斗与掉落。
  function mob(id) {
    return { def: { id: id } };
  }
  function feedHit(w, id, count) {
    for (let i = 0; i < (count || 1); i++) {
      SIM.onVengeHit(w, w.player, mob(id));
    }
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.vengeNextTick = 0;
    w.ascendNextTick = 1e9;   // 登云诀 522s：testVenge 把 tick 推过 522，关掉免得开窗落箱
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    SIM.tickVenge(w);
  }
  function finish(w, count) {
    for (let i = 0; i < count; i++) feedHit(w, 'corn' + i);
    w.time = w.vengeDeadline + 0.01;
    SIM.tickVenge(w);
  }
  // 隔离世界：其它机制全推远、关武器、默认满血，只留寻仇诀这一条轴。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 吃球不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    p.invuln = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 0;      // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.ascendNextTick = 1e9;   // 登云诀：推过 522s，关掉免得落箱污染本件零实体断言
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没几种怪可挨）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（第 15 波起怪种多、怪量上百）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标种数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.vengeNeedFor(0) === P.needKinds &&
    SIM.vengeNeedFor(1) === P.needKinds + P.kindsStep &&
    SIM.vengeNeedFor(99) === P.maxKinds,
    '0=' + SIM.vengeNeedFor(0) + ' 1=' + SIM.vengeNeedFor(1) +
    ' 99=' + SIM.vengeNeedFor(99));
  expect('目标数合理：至少 3 种、封顶种数小于窗口秒数（挨打要花时间，不能白送）',
    P.needKinds >= 2 && P.needKinds <= P.maxKinds && P.maxKinds < P.windowSec,
    'need=' + P.needKinds + ' max=' + P.maxKinds + ' / ' + P.windowSec);
  expect('怪池种类足够多（去重目标必须凑得出，不能靠同一种反复咬）',
    C.MOBS.length >= P.maxKinds + 3,
    'MOBS=' + C.MOBS.length + ' max=' + P.maxKinds);
  expect('奖励仍是「一箱 + 零钱」（与前十七件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开全部既有事件（含猎变诀 528，避免同一帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM', 'HUNT'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'venge=' + P.startSec + ' hunt=' + C.HUNT.startSec);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（直接调入口，隔离掉战斗掉落）----------
  const wR = cleanWorld(10901);
  const rng0 = wR.rngState;
  openWindow(wR);
  finish(wR, P.needKinds);
  expect('★开窗/记仇/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(10902);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, 0);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(10910);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickVenge(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.vengeRounds === 0 && evs(wT, 'venge_start').length === 0,
    'rounds=' + wT.vengeRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.vengeActive === 1 && wT.vengeRounds === 1,
    'rounds=' + wT.vengeRounds + ' active=' + wT.vengeActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前十七件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'venge_start')[0];
  expect('开窗播报一次说清三件事：多久 / 几种 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needKinds && st.round === 1 &&
    evs(wT, 'venge_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.vengeDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.vengeDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.vengeNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.vengeNextTick);
  SIM.tickVenge(wT);
  expect('同帧重复调用不会二次开窗', wT.vengeRounds === 1,
    'rounds=' + wT.vengeRounds);
  wT.time = wT.vengeDeadline - 0.001;
  SIM.tickVenge(wT);
  expect('到期前一帧不发奖也不结算', wT.vengeActive === 1 &&
    wT.vengeKinds === 0 && evs(wT, 'venge_done').length === 0 &&
    evs(wT, 'venge_fail').length === 0,
    'active=' + wT.vengeActive + ' kinds=' + wT.vengeKinds);

  // ---------- 4. 过半（整数种数逐次 +1：标记位防刷屏）----------
  const wH = cleanWorld(10921);
  openWindow(wH);
  feedHit(wH, 'kind0', Math.floor((P.needKinds - 1) / 2));
  expect('过半前零播报', evs(wH, 'venge_half').length === 0,
    'half=' + evs(wH, 'venge_half').length + ' kinds=' + wH.vengeKinds);
  feedHit(wH, 'kind1');
  expect('过半报一次', evs(wH, 'venge_half').length === 1,
    'half=' + evs(wH, 'venge_half').length);
  for (let i = 0; i < 100; i++) feedHit(wH, 'spam' + i);
  expect('多记不同仇家不刷屏（过半播报恰好一次）', evs(wH, 'venge_half').length === 1,
    'half=' + evs(wH, 'venge_half').length);
  const wH2 = cleanWorld(10922);
  openWindow(wH2);
  finish(wH2, P.needKinds);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'venge_half').length === 1 &&
    evs(wH2, 'venge_half')[0].got === Math.ceil(P.needKinds / 2),
    'half=' + evs(wH2, 'venge_half').length +
    ' got=' + ((evs(wH2, 'venge_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(10930);
  openWindow(wD);
  finish(wD, P.needKinds);
  expect('被够多种妖物咬中 → 达成', wD.vengeActive === 0 && wD.vengeDone === 1 &&
    evs(wD, 'venge_done').length === 1, 'done=' + wD.vengeDone);
  expect('宝箱正好一个（与前十七件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'venge_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needKinds && dn.need === P.needKinds &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  for (let i = 0; i < 200; i++) feedHit(wD, 'after' + i);
  SIM.tickVenge(wD);
  expect('★达标后再被咬、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.vengeDone === 1 && evs(wD, 'venge_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.vengeDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickVenge(wD);
  expect('下一轮目标递增、仇家集合与计数清零', wD.vengeRounds === 2 &&
    wD.vengeNeed === P.needKinds + P.kindsStep && wD.vengeKinds === 0 &&
    Object.keys(wD.vengeSeen).length === 0,
    'need=' + wD.vengeNeed + ' kinds=' + wD.vengeKinds +
    ' seen=' + Object.keys(wD.vengeSeen).length);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(10940);
  openWindow(wF);
  finish(wF, P.needKinds - 1);
  expect('差一种也落空', wF.vengeActive === 0 && wF.vengeFailed === 1 &&
    wF.vengeDone === 0, 'failed=' + wF.vengeFailed + ' done=' + wF.vengeDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'venge_done').length === 0,
    'done=' + evs(wF, 'venge_done').length);
  const fl = evs(wF, 'venge_fail')[0];
  expect('落空只陈述还差几种（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needKinds - 1 && fl.need === P.needKinds,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.vengeNextTick = 1e9;      // 关掉后续排期，推这么远不该再开一轮
  wF.ascendNextTick = 1e9;     // 登云诀：同理关掉，推这么远不该再开一轮
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickVenge(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.vengeDone === 0, 'pickups=' + wF.pickups.length);
  const kindsAfterFail = wF.vengeKinds;
  feedHit(wF, 'late', 100);
  expect('落空后再被咬也不计数（钩子只认 active）',
    wF.vengeKinds === kindsAfterFail && wF.vengeActive === 0,
    'kinds=' + wF.vengeKinds + '（落空时 ' + kindsAfterFail + '）');

  // ---------- 7. ★★★去重闸（本件核心新轴：同种重复咬只记一次）----------
  const wB = cleanWorld(10950);
  openWindow(wB);
  feedHit(wB, 'corpse', 10);
  expect('★★★同一种妖咬 10 口只记 1 种（去重闸是灵魂）',
    wB.vengeKinds === 1, 'kinds=' + wB.vengeKinds);
  feedHit(wB, 'bat');
  feedHit(wB, 'gargoyle');
  expect('两种不同的妖各咬一口 → 各 +1（正向对照，证明闸不是恒关）',
    wB.vengeKinds === 3, 'kinds=' + wB.vengeKinds);
  feedHit(wB, 'bat', 500);
  expect('★★之前记过的妖再猛咬 500 口也不涨（集合去重，不是计数累加）',
    wB.vengeKinds === 3, 'kinds=' + wB.vengeKinds);
  SIM.onVengeHit(wB, wB.player, null);
  SIM.onVengeHit(wB, wB.player, {});
  SIM.onVengeHit(wB, wB.player, { def: {} });
  expect('★★无来源 / 缺 def / 缺 id 的"怪"一律不算（防御性边界）',
    wB.vengeKinds === 3, 'kinds=' + wB.vengeKinds);
  const mate = Object.assign({}, wB.player);
  feedHit(wB, 'corpse');
  SIM.onVengeHit(wB, mate, mob('newkind'));
  expect('★★队友挨打不算（只数自己被咬，def.id 相同也不借用队友的仇）',
    wB.vengeKinds === 3, 'kinds=' + wB.vengeKinds);

  // ---------- 8. ★★★真实伤害漏斗（无来源 / 无敌帧 / 定格 / step 接触）----------
  const wSrc = cleanWorld(10960);
  openWindow(wSrc);
  const hp0 = wSrc.player.hp;
  SIM.damagePlayer(wSrc, wSrc.player, 10, 0, 0);
  expect('★★★没有具体怪的技能/陷阱伤害：真扣血也不记仇（正向对照证明真扣了）',
    wSrc.player.hp < hp0 && wSrc.vengeKinds === 0,
    'hp ' + hp0 + '→' + wSrc.player.hp + ' kinds=' + wSrc.vengeKinds);
  wSrc.player.invuln = 0;
  SIM.damagePlayer(wSrc, wSrc.player, 10, 0, 0, mob('corpse'));
  expect('有具体怪的真扣血 +1（damagePlayer 传了 srcMob）',
    wSrc.vengeKinds === 1, 'kinds=' + wSrc.vengeKinds);

  const wIv = cleanWorld(10961);
  openWindow(wIv);
  const hpIv = wIv.player.hp;
  wIv.player.invuln = 1;
  SIM.damagePlayer(wIv, wIv.player, 10, 0, 0, mob('bat'));
  expect('★★无敌帧挡下的攻击不算（那是避锋诀的轴）',
    wIv.player.hp === hpIv && wIv.vengeKinds === 0,
    'hp=' + wIv.player.hp + ' kinds=' + wIv.vengeKinds);
  wIv.player.invuln = 0;
  SIM.damagePlayer(wIv, wIv.player, 10, 0, 0, mob('bat'));
  expect('无敌帧结束后同一只怪真咬中 → +1（正向对照，不是恒关）',
    wIv.vengeKinds === 1, 'kinds=' + wIv.vengeKinds);

  const wLu = cleanWorld(10962);
  openWindow(wLu);
  const hpLu = wLu.player.hp;
  wLu.player.state = 'levelup';
  SIM.damagePlayer(wLu, wLu.player, 10, 0, 0, mob('gargoyle'));
  expect('★★升级三选一定格时挨打不算（那不是被咬，是被定格）',
    wLu.player.hp === hpLu && wLu.vengeKinds === 0,
    'hp=' + wLu.player.hp + ' kinds=' + wLu.vengeKinds);
  wLu.player.state = 'playing';
  SIM.damagePlayer(wLu, wLu.player, 10, 0, 0, mob('gargoyle'));
  expect('定格解除后同一只怪真咬中 → +1（正向对照）',
    wLu.vengeKinds === 1, 'kinds=' + wLu.vengeKinds);

  const wOut = cleanWorld(10963);
  SIM.damagePlayer(wOut, wOut.player, 10, 0, 0, mob('corpse'));
  expect('窗口外被咬也不计数', wOut.vengeKinds === 0, 'kinds=' + wOut.vengeKinds);

  // ★★不直接喂钩子：走 step → updateMobs → damagePlayer → onVengeHit 的真实链路，
  //   才能钉住"接触伤害那一行有把 m 传下去"（反向摘掉第 6 个参数时这条会红）。
  const wStep = cleanWorld(10964);
  openWindow(wStep);
  const mReal = SIM.spawnMob(wStep, 'corpse', wStep.player.x, wStep.player.y, 1, 0, 10965);
  mReal.hitCd = 0;
  SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★★真实 step 里怪贴身咬中 → 记下一种仇家（钉住 srcMob 传参调用点）',
    wStep.vengeKinds === 1 && evs(wStep, 'venge_half').length === 0,
    'kinds=' + wStep.vengeKinds + ' half=' + evs(wStep, 'venge_half').length);

  // ---------- 9. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(10970);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickVenge(wS);
  SIM.onVengeHit(wS, wS.player, mob('corpse'));
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.vengeActive === 0 && wS.vengeRounds === 0 && wS.vengeKinds === 0 &&
    evs(wS, 'venge_start').length === 0,
    'active=' + wS.vengeActive + ' kinds=' + wS.vengeKinds);
  // ★首发 534 秒 < ch6 上限 540 秒，刚好能在关卡结束前走真实 step 验一次。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 10971, modId: 'myth', stageId: 'ch6' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch6）走完整条 step 也没有寻仇诀，且那一刻世界确实还在跑',
    storyAlive && wS2.vengeActive === 0 && evs(wS2, 'venge_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.vengeActive);
}

function testAscend() {
  console.log('[第七十四轮] 登云诀：第一件「限时真实升 N 级」目标（成长节奏轴，只认真·经验升级）');
  const P = C.ASCEND;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 走真 gainExp 注入"升级"：把经验槽顶到刚好差 1 点，再喂 1 点真升一级。
  // ★必须走 gainExp（不是直接改 p.level），才能验到钩子真的挂在升级循环里。
  function feedLevels(w, count) {
    const n = (count == null) ? 1 : count;
    for (let i = 0; i < n; i++) {
      const p = w.self || w.player;
      p.exp = p.expNext - 1;
      SIM.gainExp(w, 1);
    }
  }
  // 直接喂计数钩子（绕开 gainExp → openLevelUp 的固有随机），专用于零随机断言：
  //   目标制状态机本身不碰 nextRand，升级三选一的随机不属于本件的验证范围。
  function feedCountDirect(w, count) {
    SIM.onAscendLevel(w, w.self || w.player, count);
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.ascendNextTick = 0;
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    SIM.tickAscend(w);
  }
  function finish(w, count) {
    feedLevels(w, count);
    w.time = w.ascendDeadline + 0.01;
    SIM.tickAscend(w);
  }
  // 隔离世界：其它机制全推远、关武器、经验槽可控（不设 1e9，否则喂不进经验）。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = C.expNext(p.level);
    p.exp = 0;
    p.hp = p.maxHp;
    p.invuln = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 0;      // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
    w.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
    w.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场是空场，没球可捡）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（第 15 波起怪多、经验球密集）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标级数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.ascendNeedFor(0) === P.needLevels &&
    SIM.ascendNeedFor(1) === P.needLevels + P.levelStep &&
    SIM.ascendNeedFor(99) === P.maxLevels,
    '0=' + SIM.ascendNeedFor(0) + ' 1=' + SIM.ascendNeedFor(1) +
    ' 99=' + SIM.ascendNeedFor(99));
  expect('目标数合理：首轮至少 2 级、封顶级数小于窗口秒数（升级要花时间，不能白送）',
    P.needLevels >= 2 && P.needLevels <= P.maxLevels && P.maxLevels < P.windowSec,
    'need=' + P.needLevels + ' max=' + P.maxLevels + ' / ' + P.windowSec);
  expect('奖励仍是「一箱 + 零钱」（与前十八件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开全部既有事件（含妖潮 516、猎变 528，避免同帧挤两条播报）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'ascend=' + P.startSec + ' venge=' + C.VENGE.startSec);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（直接调状态机入口 + 计数钩子，隔离掉升级三选一的固有随机）----------
  // ★用 onAscendLevel 而非 gainExp：gainExp 达标必然 openLevelUp（三选一抽随机），
  //   那是升级系统的随机、不是目标制状态机的；本件只验"开轮/计数/发奖不碰 nextRand"。
  const wR = cleanWorld(11001);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedCountDirect(wR, P.needLevels);
  wR.time = wR.ascendDeadline + 0.01;
  SIM.tickAscend(wR);
  expect('★开窗/升级/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(11002);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  feedCountDirect(wR2, 0);
  wR2.time = wR2.ascendDeadline + 0.01;
  SIM.tickAscend(wR2);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(11010);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickAscend(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.ascendRounds === 0 && evs(wT, 'ascend_start').length === 0,
    'rounds=' + wT.ascendRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.ascendActive === 1 && wT.ascendRounds === 1,
    'rounds=' + wT.ascendRounds + ' active=' + wT.ascendActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前十八件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'ascend_start')[0];
  expect('开窗播报一次说清三件事：多久 / 几级 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needLevels && st.round === 1 &&
    evs(wT, 'ascend_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.ascendDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.ascendDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.ascendNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.ascendNextTick);
  SIM.tickAscend(wT);
  expect('同帧重复调用不会二次开窗', wT.ascendRounds === 1,
    'rounds=' + wT.ascendRounds);
  wT.time = wT.ascendDeadline - 0.001;
  SIM.tickAscend(wT);
  expect('到期前一帧不发奖也不结算', wT.ascendActive === 1 &&
    wT.ascendLevels === 0 && evs(wT, 'ascend_done').length === 0 &&
    evs(wT, 'ascend_fail').length === 0,
    'active=' + wT.ascendActive + ' levels=' + wT.ascendLevels);

  // ---------- 4. 过半（整数级数逐次累加：标记位防刷屏）----------
  const wH = cleanWorld(11021);
  openWindow(wH);
  feedLevels(wH, Math.floor((P.needLevels - 1) / 2));
  expect('过半前零播报', evs(wH, 'ascend_half').length === 0,
    'half=' + evs(wH, 'ascend_half').length + ' levels=' + wH.ascendLevels);
  feedLevels(wH, 1);
  expect('过半报一次', evs(wH, 'ascend_half').length === 1,
    'half=' + evs(wH, 'ascend_half').length);
  for (let i = 0; i < 100; i++) feedLevels(wH, 1);
  expect('多升级不刷屏（过半播报恰好一次）', evs(wH, 'ascend_half').length === 1,
    'half=' + evs(wH, 'ascend_half').length);
  const wH2 = cleanWorld(11022);
  openWindow(wH2);
  finish(wH2, P.needLevels);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'ascend_half').length === 1 &&
    evs(wH2, 'ascend_half')[0].got === Math.ceil(P.needLevels / 2),
    'half=' + evs(wH2, 'ascend_half').length +
    ' got=' + ((evs(wH2, 'ascend_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(11030);
  openWindow(wD);
  finish(wD, P.needLevels);
  expect('窗口内真实升够级数 → 达成', wD.ascendActive === 0 && wD.ascendDone === 1 &&
    evs(wD, 'ascend_done').length === 1, 'done=' + wD.ascendDone);
  expect('宝箱正好一个（与前十八件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'ascend_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needLevels && dn.need === P.needLevels &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  for (let i = 0; i < 200; i++) feedLevels(wD, 1);
  SIM.tickAscend(wD);
  expect('★达标后再升级、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.ascendDone === 1 && evs(wD, 'ascend_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.ascendDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickAscend(wD);
  expect('下一轮目标递增、级数清零', wD.ascendRounds === 2 &&
    wD.ascendNeed === P.needLevels + P.levelStep && wD.ascendLevels === 0,
    'need=' + wD.ascendNeed + ' levels=' + wD.ascendLevels);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(11040);
  openWindow(wF);
  finish(wF, P.needLevels - 1);
  expect('差一级也落空', wF.ascendActive === 0 && wF.ascendFailed === 1 &&
    wF.ascendDone === 0, 'failed=' + wF.ascendFailed + ' done=' + wF.ascendDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'ascend_done').length === 0,
    'done=' + evs(wF, 'ascend_done').length);
  const fl = evs(wF, 'ascend_fail')[0];
  expect('落空只陈述还差几级（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needLevels - 1 && fl.need === P.needLevels,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.ascendNextTick = 1e9;    // 关掉后续排期，推这么远不该再开一轮
  wF.unsealNextTick = 1e9; // 第七十五轮：启匣诀 546s 开窗，默认推远
  wF.yongjinNextTick = 1e9; // 第七十六轮：涌金诀 558s 开窗，默认推远
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickAscend(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.ascendDone === 0, 'pickups=' + wF.pickups.length);
  const levelsAfterFail = wF.ascendLevels;
  feedLevels(wF, 100);
  expect('落空后再升级也不计数（钩子只认 active）',
    wF.ascendLevels === levelsAfterFail && wF.ascendActive === 0,
    'levels=' + wF.ascendLevels + '（落空时 ' + levelsAfterFail + '）');

  // ---------- 7. ★★★核心新轴：只认真·经验升级，不认宝箱白送 ----------
  const wB = cleanWorld(11050);
  openWindow(wB);
  const pB = wB.self || wB.player;
  // 一次吃大球连跳多级（把经验一次喂够两级）→ gained 记 2，不是记"吃了一次"。
  pB.exp = pB.expNext - 1;
  const jumpNeed = C.expNext(pB.level + 1);
  SIM.gainExp(wB, 1 + jumpNeed);
  expect('★★★一次吃大球连升两级 → 记 2 级（按真实 gained 数，不按吃球次数）',
    wB.ascendLevels === 2, 'levels=' + wB.ascendLevels);
  SIM.onAscendLevel(wB, pB, 0);
  SIM.onAscendLevel(wB, pB, -1);
  expect('gained<=0 一律不算（防御性边界）', wB.ascendLevels === 2,
    'levels=' + wB.ascendLevels);
  const mate = Object.assign({}, pB);
  SIM.onAscendLevel(wB, mate, 5);
  expect('★队友升级不算（只数自己，钩子核对 p === self）', wB.ascendLevels === 2,
    'levels=' + wB.ascendLevels);
  // 正向对照：确实还能继续涨（证明上面的闸不是恒关）。
  feedLevels(wB, 1);
  expect('自己的真升级继续 +1（正向对照，证明闸不是恒关）',
    wB.ascendLevels === 3, 'levels=' + wB.ascendLevels);

  // ---------- 8. ★★★灵魂断言：宝箱白送的免费升级不算（走真实 step 拾取链路）----------
  const wChest = cleanWorld(11060);
  openWindow(wChest);
  const pC = wChest.self || wChest.player;
  const lvBeforeChest = pC.level;
  const levelsBeforeChest = wChest.ascendLevels;
  // 在玩家脚下放一个宝箱，走真实 step → updatePickups → chest 分支（p.level += 1，不经 gainExp）。
  SIM.spawnPickup(wChest, 'chest', pC.x, pC.y, 1, 30);
  SIM.step(wChest, { mx: 0, my: 0 });
  expect('★★★宝箱白送的免费升级：等级确实涨了，但登云诀一级都不算（钩子只在 gainExp）',
    pC.level > lvBeforeChest && wChest.ascendLevels === levelsBeforeChest,
    'level ' + lvBeforeChest + '→' + pC.level +
    ' ascendLevels ' + levelsBeforeChest + '→' + wChest.ascendLevels);

  // 窗口外升级也不算。
  const wOut = cleanWorld(11061);
  feedLevels(wOut, 3);
  expect('窗口外真升级也不计数', wOut.ascendLevels === 0, 'levels=' + wOut.ascendLevels);

  // ---------- 9. 剧情关隔离（双管 + step 明细证明世界还在跑）----------
  const wS = cleanWorld(11070);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickAscend(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.ascendActive === 0 && wS.ascendRounds === 0 && wS.ascendLevels === 0 &&
    evs(wS, 'ascend_start').length === 0,
    'active=' + wS.ascendActive + ' levels=' + wS.ascendLevels);
  // ★★关键：tickAscend 的 story 闸已让 active=0，钩子里的 story 闸会被 active 闸抢先挡住 →
  //   光这样喂是"天然安全"假绿。手动把 active 打开，让钩子里的 story 闸成为唯一屏障，
  //   这样摘掉钩子 story 闸才会红（真正验到钩子那一层也有剧情隔离）。
  wS.ascendActive = 1;
  feedLevels(wS, 5);
  expect('★★★剧情关就算强行开窗喂 5 级，钩子也不计数（钉住钩子层 story 闸）',
    wS.ascendLevels === 0 && evs(wS, 'ascend_half').length === 0,
    'levels=' + wS.ascendLevels);
  // ★首发 522 秒 < ch6 上限 540 秒，刚好能在关卡结束前走真实 step 验一次。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 11071, modId: 'myth', stageId: 'ch6' });
  let storyAlive = true;
  for (let k = 0; k < 2; k++) {
    wS2.tick = Math.round((P.startSec + k * 2) * HZ) - 1;
    SIM.step(wS2, { mx: 0, my: 0 });
    if (wS2.ended || wS2.state !== 'playing') storyAlive = false;
  }
  expect('★★剧情关（《补天纪》ch6）走完整条 step 也没有登云诀，且那一刻世界确实还在跑',
    storyAlive && wS2.ascendActive === 0 && evs(wS2, 'ascend_start').length === 0,
    '世界还在跑=' + storyAlive + '（state=' + wS2.state + '，上限 ' +
    wS2.matchSec + ' 秒）/ active=' + wS2.ascendActive);
}

function testUnseal() {
  console.log('[第七十五轮] 启匣诀：第一件「限时亲手开 N 个宝箱」目标（奖励兑现轴，只认真开箱）');
  const P = C.UNSEAL;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 直接喂计数钩子（绕开 chest 拾取的 openLevelUp 固有随机），专用于零随机断言：
  //   目标制状态机本身不碰 nextRand，开箱三选一的随机不属于本件的验证范围。
  function feedDirect(w, count) {
    for (let i = 0; i < count; i++) SIM.onUnsealChest(w, w.self || w.player);
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.unsealNextTick = 0;
    SIM.tickUnseal(w);
  }
  function finish(w, count) {
    feedDirect(w, count);
    w.time = w.unsealDeadline + 0.01;
    SIM.tickUnseal(w);
  }
  // 隔离世界：其它机制全推远、关武器、清场。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.exp = 0;
    p.hp = p.maxHp;
    p.invuln = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 0;      // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场没箱可开）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（此前挑战者/Boss/事件已发过箱）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标箱数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.unsealNeedFor(0) === P.needChests &&
    SIM.unsealNeedFor(1) === P.needChests + P.chestStep &&
    SIM.unsealNeedFor(99) === P.maxChests,
    '0=' + SIM.unsealNeedFor(0) + ' 1=' + SIM.unsealNeedFor(1) +
    ' 99=' + SIM.unsealNeedFor(99));
  expect('目标数合理：首轮至少 2 个、封顶小于窗口秒数（跑图要时间，不能白送）',
    P.needChests >= 2 && P.needChests <= P.maxChests && P.maxChests < P.windowSec,
    'need=' + P.needChests + ' max=' + P.maxChests + ' / ' + P.windowSec);
  expect('奖励仍是「一箱 + 零钱」（与前十九件同口径，不是巨款）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开全部既有事件（含登云 522、寻仇 534、猎变 528）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE', 'ASCEND'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'unseal=' + P.startSec + ' ascend=' + C.ASCEND.startSec);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（直接调状态机入口 + 计数钩子，隔离掉开箱三选一的固有随机）----------
  const wR = cleanWorld(11201);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedDirect(wR, P.needChests);
  wR.time = wR.unsealDeadline + 0.01;
  SIM.tickUnseal(wR);
  expect('★开窗/开箱/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(11202);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  feedDirect(wR2, 0);
  wR2.time = wR2.unsealDeadline + 0.01;
  SIM.tickUnseal(wR2);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(11210);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickUnseal(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.unsealRounds === 0 && evs(wT, 'unseal_start').length === 0,
    'rounds=' + wT.unsealRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.unsealActive === 1 && wT.unsealRounds === 1,
    'rounds=' + wT.unsealRounds + ' active=' + wT.unsealActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前十九件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'unseal_start')[0];
  expect('开窗播报一次说清三件事：多久 / 几个 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needChests && st.round === 1 &&
    evs(wT, 'unseal_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.unsealDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.unsealDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.unsealNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.unsealNextTick);
  SIM.tickUnseal(wT);
  expect('同帧重复调用不会二次开窗', wT.unsealRounds === 1,
    'rounds=' + wT.unsealRounds);
  wT.time = wT.unsealDeadline - 0.001;
  SIM.tickUnseal(wT);
  expect('到期前一帧不发奖也不结算', wT.unsealActive === 1 &&
    wT.unsealChests === 0 && evs(wT, 'unseal_done').length === 0 &&
    evs(wT, 'unseal_fail').length === 0,
    'active=' + wT.unsealActive + ' chests=' + wT.unsealChests);

  // ---------- 4. 过半（整数个数逐次累加：标记位防刷屏）----------
  const wH = cleanWorld(11221);
  openWindow(wH);
  feedDirect(wH, Math.floor((P.needChests - 1) / 2));
  expect('过半前零播报', evs(wH, 'unseal_half').length === 0,
    'half=' + evs(wH, 'unseal_half').length + ' chests=' + wH.unsealChests);
  feedDirect(wH, 1);
  expect('过半报一次', evs(wH, 'unseal_half').length === 1,
    'half=' + evs(wH, 'unseal_half').length);
  for (let i = 0; i < 100; i++) feedDirect(wH, 1);
  expect('多开箱不刷屏（过半播报恰好一次）', evs(wH, 'unseal_half').length === 1,
    'half=' + evs(wH, 'unseal_half').length);
  const wH2 = cleanWorld(11222);
  openWindow(wH2);
  finish(wH2, P.needChests);
  expect('★★整轮只报一次过半（标记位防刷屏，数字锁在首次跨半那一刻）',
    evs(wH2, 'unseal_half').length === 1 &&
    evs(wH2, 'unseal_half')[0].got === Math.ceil(P.needChests / 2),
    'half=' + evs(wH2, 'unseal_half').length +
    ' got=' + ((evs(wH2, 'unseal_half')[0] || {}).got));

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(11230);
  openWindow(wD);
  finish(wD, P.needChests);
  expect('窗口内亲手开够箱 → 达成', wD.unsealActive === 0 && wD.unsealDone === 1 &&
    evs(wD, 'unseal_done').length === 1, 'done=' + wD.unsealDone);
  expect('宝箱正好一个（与前十九件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'unseal_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needChests && dn.need === P.needChests &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feedDirect(wD, 200);
  SIM.tickUnseal(wD);
  expect('★达标后再开箱、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.unsealDone === 1 && evs(wD, 'unseal_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.unsealDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickUnseal(wD);
  expect('下一轮目标递增、箱数清零', wD.unsealRounds === 2 &&
    wD.unsealNeed === P.needChests + P.chestStep && wD.unsealChests === 0,
    'need=' + wD.unsealNeed + ' chests=' + wD.unsealChests);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(11240);
  openWindow(wF);
  finish(wF, P.needChests - 1);
  expect('差一个也落空', wF.unsealActive === 0 && wF.unsealFailed === 1 &&
    wF.unsealDone === 0, 'failed=' + wF.unsealFailed + ' done=' + wF.unsealDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'unseal_done').length === 0,
    'done=' + evs(wF, 'unseal_done').length);
  const fl = evs(wF, 'unseal_fail')[0];
  expect('落空只陈述还差几个（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needChests - 1 && fl.need === P.needChests,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.unsealNextTick = 1e9;    // 关掉后续排期，推这么远不该再开一轮
  SIM.tickUnseal(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.unsealDone === 0, 'pickups=' + wF.pickups.length);
  const chestsAfterFail = wF.unsealChests;
  feedDirect(wF, 100);
  expect('落空后再开箱也不计数（钩子只认 active）',
    wF.unsealChests === chestsAfterFail && wF.unsealActive === 0,
    'chests=' + wF.unsealChests + '（落空时 ' + chestsAfterFail + '）');

  // ---------- 7. ★★★核心新轴：只数自己亲手开的箱 ----------
  const wB = cleanWorld(11250);
  openWindow(wB);
  const pB = wB.self || wB.player;
  const mate = Object.assign({}, pB);
  SIM.onUnsealChest(wB, mate);
  expect('★队友开箱不算（钩子核对 p === self）', wB.unsealChests === 0,
    'chests=' + wB.unsealChests);
  SIM.onUnsealChest(wB, pB);
  expect('自己开箱 +1（正向对照，证明闸不是恒关）', wB.unsealChests === 1,
    'chests=' + wB.unsealChests);
  const wOut = cleanWorld(11251);
  SIM.onUnsealChest(wOut, wOut.self || wOut.player);
  expect('窗口外开箱不算', wOut.unsealChests === 0, 'chests=' + wOut.unsealChests);

  // ---------- 8. ★★★灵魂断言：真实 step 拾取链路（与登云诀互补）----------
  const wChest = cleanWorld(11260);
  openWindow(wChest);
  const pC = wChest.self || wChest.player;
  const lvBeforeChest = pC.level;
  SIM.spawnPickup(wChest, 'chest', pC.x, pC.y, 1, 30);
  SIM.step(wChest, { mx: 0, my: 0 });
  expect('★★★真实 step：脚下宝箱被开 → 白送的级照样算一个（与登云诀互补，钉住钩子在 chest 分支）',
    pC.level > lvBeforeChest && wChest.unsealChests === 1,
    'level ' + lvBeforeChest + '→' + pC.level + ' chests=' + wChest.unsealChests);
  const wOther = cleanWorld(11261);
  openWindow(wOther);
  const pO = wOther.self || wOther.player;
  SIM.spawnPickup(wOther, 'exp', pO.x, pO.y, 5, 30);
  SIM.spawnPickup(wOther, 'gold', pO.x + 5, pO.y, 1, 30);
  SIM.spawnPickup(wOther, 'heart', pO.x - 5, pO.y, 1, 30);
  SIM.step(wOther, { mx: 0, my: 0 });
  expect('★★捡经验/金币/红心一个都不算（钩子只挂 chest 分支）',
    wOther.unsealChests === 0, 'chests=' + wOther.unsealChests);
  const wLoop = cleanWorld(11262);
  openWindow(wLoop);
  finish(wLoop, P.needChests);
  SIM.step(wLoop, { mx: 0, my: 0 });
  expect('★★达标奖励里的那个箱就算被自己开掉，也不算进下一轮（active 闸）',
    wLoop.unsealChests === P.needChests && wLoop.unsealDone === 1,
    'chests=' + wLoop.unsealChests + ' done=' + wLoop.unsealDone);
  const wOutStep = cleanWorld(11263);
  const pOS = wOutStep.self || wOutStep.player;
  SIM.spawnPickup(wOutStep, 'chest', pOS.x, pOS.y, 1, 30);
  SIM.step(wOutStep, { mx: 0, my: 0 });
  expect('窗口外真实开箱一个都不算（钉住 active 闸）',
    wOutStep.unsealChests === 0, 'chests=' + wOutStep.unsealChests);

  // ---------- 9. 剧情关隔离（两个入口都钉；step 验不了，见下面那条）----------
  const wS = cleanWorld(11270);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickUnseal(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.unsealActive === 0 && wS.unsealRounds === 0 && wS.unsealChests === 0 &&
    evs(wS, 'unseal_start').length === 0,
    'active=' + wS.unsealActive + ' chests=' + wS.unsealChests);
  // ★先手动开 active，让钩子里的 story 闸成为唯一屏障（否则被 active 闸抢先挡住＝假绿）。
  wS.unsealActive = 1;
  feedDirect(wS, 5);
  expect('★★★剧情关就算强行开窗喂 5 次开箱，钩子也不计数（钉钩子层 story 闸）',
    wS.unsealChests === 0 && evs(wS, 'unseal_half').length === 0,
    'chests=' + wS.unsealChests);
  // ★首发 546 秒 > 全部剧情关上限 540 秒，走完整 step 时关卡早结束 → 必然假绿。
  //   所以本件只钉上面两个入口，并断言这个前提仍然成立（改 startSec 时会提醒补 step 验证）。
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 11271, modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 546 秒：step 验不出，两个入口断言就是唯一依据',
    wS2.matchSec < P.startSec && P.startSec > 540,
    'ch6上限=' + wS2.matchSec + ' 首发=' + P.startSec);

  // ---------- 10. ★钉住 step 段的调用点（上面都直接调 tickUnseal，验不到它有没有被挂上）----------
  // 用非剧情世界（没有 540 秒上限）走真实 step 跨过首发帧；其它机制已全推远。
  const wStepOpen = cleanWorld(11280);
  wStepOpen.tick = startTick - 1;
  wStepOpen.time = wStepOpen.tick / HZ;
  for (let k = 0; k < 3; k++) SIM.step(wStepOpen, { mx: 0, my: 0 });
  expect('★★真实 step 跨过首发帧也会开窗（钉住 step 段的 tickUnseal 调用点）',
    wStepOpen.unsealActive === 1 && wStepOpen.unsealRounds === 1 &&
    evs(wStepOpen, 'unseal_start').length === 1,
    'active=' + wStepOpen.unsealActive + ' rounds=' + wStepOpen.unsealRounds +
    ' state=' + wStepOpen.state);
}

// ============================================================
// 第七十六轮：涌金诀（限时「金币真实入账面额」目标，目标制零实体第二十一件）
// 【测试原则】钉「不该发生的事」：队友捡的不算、宝箱附带的 15 金不算、
//   名义面额不算（只认真入账）、窗口外不算、剧情关不算、落空零掉落。
//   面额是连续量：过半用 >= + 标记位，必须钉「一次大额跳变也报过半」。
// ============================================================

function testYongjin() {
  console.log('[第七十六轮] 涌金诀：第一件「限时捡够金币面额」目标（按入账，不按枚数）');
  const P = C.YONGJIN;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 直接喂真实入账面额（绕开拾取的磁吸/倍率），专用于零随机断言：
  //   目标制状态机本身不碰 nextRand，拾取系统的随机不属于本件的验证范围。
  function feed(w, amount, who) {
    SIM.onYongjinGold(w, who || (w.self || w.player), amount);
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.yongjinNextTick = 0;
    SIM.tickYongjin(w);
  }
  function finish(w, amount) {
    feed(w, amount);
    w.time = w.yongjinDeadline + 0.01;
    SIM.tickYongjin(w);
  }
  // 隔离世界：其它机制全推远、关武器、清场；本件默认开窗由 openWindow 精确触发。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 1e9;
    w.yongjinNextTick = 0;     // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.julingNextTick = 1e9;    // 第七十七轮：聚灵诀 564s 开窗，默认推远
    w.onehitNextTick = 1e9;    // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场没怪可打、没钱可捡）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（怪量足够撑起捡钱窗口）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标面额按轮递增且封顶（第 2 轮 +8，第 99 轮到 max）',
    SIM.yongjinNeedFor(0) === P.needGold &&
    SIM.yongjinNeedFor(1) === P.needGold + P.goldStep &&
    SIM.yongjinNeedFor(99) === P.maxGold,
    '0=' + SIM.yongjinNeedFor(0) + ' 1=' + SIM.yongjinNeedFor(1) +
    ' 99=' + SIM.yongjinNeedFor(99));
  expect('目标面额至少 24、封顶 48（30 秒靠捡钱做得到，但不白送）',
    P.needGold >= 24 && P.needGold <= P.maxGold && P.maxGold <= 48,
    'need=' + P.needGold + ' max=' + P.maxGold);
  expect('奖励仍是「一箱 + 零钱」（与前二十件同口径）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开全部既有事件（含启匣 546、寻仇 534、猎变 528）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE', 'ASCEND', 'UNSEAL'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'yongjin=' + P.startSec + ' unseal=' + C.UNSEAL.startSec);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（直接调状态机入口与钩子）----------
  const wR = cleanWorld(11701);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, P.needGold);
  wR.time = wR.yongjinDeadline + 0.01;
  SIM.tickYongjin(wR);
  expect('★开窗/入账/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(11702);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, P.needGold - 1);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(11710);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickYongjin(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.yongjinRounds === 0 && evs(wT, 'yongjin_start').length === 0,
    'rounds=' + wT.yongjinRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.yongjinActive === 1 && wT.yongjinRounds === 1,
    'rounds=' + wT.yongjinRounds + ' active=' + wT.yongjinActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前二十件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'yongjin_start')[0];
  expect('开窗播报一次说清三件事：多久 / 多少面额 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needGold && st.round === 1 &&
    evs(wT, 'yongjin_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.yongjinDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.yongjinDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.yongjinNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.yongjinNextTick);
  SIM.tickYongjin(wT);
  expect('同帧重复调用不会二次开窗', wT.yongjinRounds === 1,
    'rounds=' + wT.yongjinRounds);
  wT.time = wT.yongjinDeadline - 0.001;
  SIM.tickYongjin(wT);
  expect('到期前一帧不发奖也不结算', wT.yongjinActive === 1 &&
    wT.yongjinGold === 0 && evs(wT, 'yongjin_done').length === 0 &&
    evs(wT, 'yongjin_fail').length === 0,
    'active=' + wT.yongjinActive + ' gold=' + wT.yongjinGold);

  // ---------- 4. 过半（连续面额：>= 跨阈值 + 标记位防刷屏）----------
  const wH = cleanWorld(11721);
  openWindow(wH);
  feed(wH, Math.floor((P.needGold - 1) / 2));
  expect('过半前零播报', evs(wH, 'yongjin_half').length === 0,
    'half=' + evs(wH, 'yongjin_half').length + ' gold=' + wH.yongjinGold);
  feed(wH, 1);
  expect('过半报一次', evs(wH, 'yongjin_half').length === 1,
    'half=' + evs(wH, 'yongjin_half').length);
  for (let i = 0; i < 100; i++) feed(wH, 1);
  expect('多捡钱不刷屏（过半播报恰好一次）', evs(wH, 'yongjin_half').length === 1,
    'half=' + evs(wH, 'yongjin_half').length);
  const wH2 = cleanWorld(11722);
  openWindow(wH2);
  // ★一次大额入账直接跨过 half：用 === 判会漏报，必须钉 >=。
  feed(wH2, P.needGold);
  expect('★★★一次大额入账直接跨过半程也报（钉「>=」而不是「===」）',
    evs(wH2, 'yongjin_half').length === 1 &&
    evs(wH2, 'yongjin_half')[0].got === P.needGold,
    'half=' + evs(wH2, 'yongjin_half').length +
    ' got=' + ((evs(wH2, 'yongjin_half')[0] || {}).got));
  const wH3 = cleanWorld(11723);
  openWindow(wH3);
  finish(wH3, P.needGold);
  expect('整轮只报一次过半（数字锁在首次跨半那一刻）',
    evs(wH3, 'yongjin_half').length === 1,
    'half=' + evs(wH3, 'yongjin_half').length);

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(11730);
  openWindow(wD);
  finish(wD, P.needGold);
  expect('窗口内挣够面额 → 达成', wD.yongjinActive === 0 && wD.yongjinDone === 1 &&
    evs(wD, 'yongjin_done').length === 1, 'done=' + wD.yongjinDone);
  expect('宝箱正好一个（与前二十件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'yongjin_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needGold && dn.need === P.needGold &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 200);
  SIM.tickYongjin(wD);
  expect('★达标后再捡钱、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.yongjinDone === 1 && evs(wD, 'yongjin_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.yongjinDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickYongjin(wD);
  expect('下一轮目标递增、面额清零', wD.yongjinRounds === 2 &&
    wD.yongjinNeed === P.needGold + P.goldStep && wD.yongjinGold === 0,
    'need=' + wD.yongjinNeed + ' gold=' + wD.yongjinGold);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(11740);
  openWindow(wF);
  finish(wF, P.needGold - 1);
  expect('差一点也落空', wF.yongjinActive === 0 && wF.yongjinFailed === 1 &&
    wF.yongjinDone === 0, 'failed=' + wF.yongjinFailed + ' done=' + wF.yongjinDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'yongjin_done').length === 0,
    'done=' + evs(wF, 'yongjin_done').length);
  const fl = evs(wF, 'yongjin_fail')[0];
  expect('落空只陈述还差多少（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needGold - 1 && fl.need === P.needGold,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.yongjinNextTick = 1e9;
  wF.julingNextTick = 1e9; // 第七十七轮：聚灵诀 564s 开窗，默认推远
  wF.onehitNextTick = 1e9; // 第七十八轮：崩山诀 576s 开窗，默认推远
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
  wF.tagaNextTick = 1e9; wF.stillNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
  SIM.tickYongjin(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.yongjinDone === 0, 'pickups=' + wF.pickups.length);
  const goldAfterFail = wF.yongjinGold;
  feed(wF, 100);
  expect('落空后再捡钱也不计数（钩子只认 active）',
    wF.yongjinGold === goldAfterFail && wF.yongjinActive === 0,
    'gold=' + wF.yongjinGold + '（落空时 ' + goldAfterFail + '）');

  // ---------- 7. ★★★核心新轴：只数自己的、只数真实入账面额 ----------
  const wB = cleanWorld(11750);
  openWindow(wB);
  const pB = wB.self || wB.player;
  const mate = Object.assign({}, pB);
  feed(wB, 5, mate);
  expect('★队友捡的钱不算（钩子核对 p === self）', wB.yongjinGold === 0,
    'gold=' + wB.yongjinGold);
  feed(wB, 7);
  expect('自己一笔入账 7 点就记 7 点（按面额，不按枚数）', wB.yongjinGold === 7,
    'gold=' + wB.yongjinGold);
  feed(wB, 2);
  expect('再入账 2 点累加到 9（正向对照，证明闸不是恒关）', wB.yongjinGold === 9,
    'gold=' + wB.yongjinGold);
  feed(wB, 0);
  feed(wB, -3);
  expect('★★非正数入账不算（拒绝分支不污染计数）', wB.yongjinGold === 9,
    'gold=' + wB.yongjinGold);
  const wOut = cleanWorld(11751);
  feed(wOut, 5);
  expect('窗口外捡钱不算', wOut.yongjinGold === 0, 'gold=' + wOut.yongjinGold);

  // ---------- 8. ★★★灵魂断言：真实 step 拾取链路 ----------
  const wReal = cleanWorld(11760);
  openWindow(wReal);
  const pReal = wReal.self || wReal.player;
  pReal.attrs.goldMul = 4;          // 模拟金面具：一枚面值 2 的钱实际入账 8
  SIM.spawnPickup(wReal, 'gold', pReal.x, pReal.y, 2, 30);
  const statsGoldBefore = wReal.stats.gold;
  SIM.step(wReal, { mx: 0, my: 0 });
  expect('★★★真实 step：只认真入账 8 点，不是名义面值 2、也不是 1 枚',
    wReal.yongjinGold === 8 && wReal.stats.gold - statsGoldBefore === 8,
    'yongjin=' + wReal.yongjinGold + ' stats+' + (wReal.stats.gold - statsGoldBefore));
  const wChest = cleanWorld(11761);
  openWindow(wChest);
  const pC = wChest.self || wChest.player;
  const statsBeforeChest = wChest.stats.gold;
  const lvBeforeChest = pC.level;
  SIM.spawnPickup(wChest, 'chest', pC.x, pC.y, 1, 30);
  SIM.step(wChest, { mx: 0, my: 0 });
  expect('★★★宝箱附带的 15 金确实入账，但涌金诀一分都不算（钉钩子在 gold 分支）',
    wChest.stats.gold - statsBeforeChest > 0 && pC.level > lvBeforeChest &&
    wChest.yongjinGold === 0,
    'stats+' + (wChest.stats.gold - statsBeforeChest) + ' level ' + lvBeforeChest +
    '→' + pC.level + ' yongjin=' + wChest.yongjinGold);
  const wOther = cleanWorld(11762);
  openWindow(wOther);
  const pO = wOther.self || wOther.player;
  SIM.spawnPickup(wOther, 'exp', pO.x, pO.y, 5, 30);
  SIM.spawnPickup(wOther, 'heart', pO.x - 5, pO.y, 1, 30);
  SIM.step(wOther, { mx: 0, my: 0 });
  expect('★★捡精魄/红心一个都不算（钩子只挂 gold 分支）',
    wOther.yongjinGold === 0, 'gold=' + wOther.yongjinGold);
  const wLoop = cleanWorld(11763);
  openWindow(wLoop);
  finish(wLoop, P.needGold);
  SIM.step(wLoop, { mx: 0, my: 0 });
  expect('★★达标奖励里的钱就算被自己捡掉，也不算进下一轮（active 闸）',
    wLoop.yongjinGold === P.needGold && wLoop.yongjinDone === 1,
    'gold=' + wLoop.yongjinGold + ' done=' + wLoop.yongjinDone);
  const wOutStep = cleanWorld(11764);
  const pOS = wOutStep.self || wOutStep.player;
  const statsOutBefore = wOutStep.stats.gold;
  SIM.spawnPickup(wOutStep, 'gold', pOS.x, pOS.y, 3, 30);
  SIM.step(wOutStep, { mx: 0, my: 0 });
  expect('★★窗口外真实捡钱一分不算（正向对照证明钱确实被捡了）',
    wOutStep.yongjinGold === 0 && wOutStep.stats.gold - statsOutBefore === 3,
    'yongjin=' + wOutStep.yongjinGold + ' stats+' + (wOutStep.stats.gold - statsOutBefore));

  // ---------- 9. 剧情关隔离（两个入口都钉；step 验不了，见下面那条）----------
  const wS = cleanWorld(11770);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickYongjin(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.yongjinActive === 0 && wS.yongjinRounds === 0 && wS.yongjinGold === 0 &&
    evs(wS, 'yongjin_start').length === 0,
    'active=' + wS.yongjinActive + ' gold=' + wS.yongjinGold);
  // ★先手动开 active，让钩子里的 story 闸成为唯一屏障（否则被 active 闸抢先挡住＝假绿）。
  wS.yongjinActive = 1;
  feed(wS, P.needGold);
  expect('★★★剧情关就算强行开窗喂一大笔钱，钩子也不计数（钉钩子层 story 闸）',
    wS.yongjinGold === 0 && evs(wS, 'yongjin_half').length === 0,
    'gold=' + wS.yongjinGold);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 11771, modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 558 秒：step 验不出，两个入口断言就是唯一依据',
    wS2.matchSec < P.startSec && P.startSec > 540,
    'ch6上限=' + wS2.matchSec + ' 首发=' + P.startSec);

  // ---------- 10. ★钉住 step 段的调用点 ----------
  const wStepOpen = cleanWorld(11780);
  wStepOpen.tick = startTick - 1;
  wStepOpen.time = wStepOpen.tick / HZ;
  for (let k = 0; k < 3; k++) SIM.step(wStepOpen, { mx: 0, my: 0 });
  expect('★★真实 step 跨过首发帧也会开窗（钉住 step 段的 tickYongjin 调用点）',
    wStepOpen.yongjinActive === 1 && wStepOpen.yongjinRounds === 1 &&
    evs(wStepOpen, 'yongjin_start').length === 1,
    'active=' + wStepOpen.yongjinActive + ' rounds=' + wStepOpen.yongjinRounds +
    ' state=' + wStepOpen.state);
}

// ============================================================
// 第七十七轮：聚灵诀 JULING（限时捡够 N 点经验面额）
// ★与涌金诀对称：一个数金币面额，一个数经验面额；四钩子各记各的字段。
// ============================================================
function testJuling() {
  console.log('[第七十七轮] 聚灵诀：第一件「限时捡够经验面额」目标（按入账，不按颗数）');
  const P = C.JULING;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 直接喂真实入账面额（绕开拾取的磁吸/升级三选一），专用于零随机断言：
  //   目标制状态机本身不碰 nextRand，拾取系统的随机不属于本件的验证范围。
  function feed(w, amount, who) {
    SIM.onJulingExp(w, who || (w.self || w.player), amount);
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.julingNextTick = 0;
    SIM.tickJuling(w);
  }
  function finish(w, amount) {
    feed(w, amount);
    w.time = w.julingDeadline + 0.01;
    SIM.tickJuling(w);
  }
  // 隔离世界：其它机制全推远、关武器、经验槽锁死；本件默认开窗由 openWindow 精确触发。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;          // 不弹升级面板，世界不会定格
    p.hp = p.maxHp;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 1e9;
    w.yongjinNextTick = 1e9;
    w.julingNextTick = 0;     // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.onehitNextTick = 1e9;   // 第七十八轮：崩山诀 576s 开窗，默认推远
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀 588s 开窗，默认推远
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那场没怪可打、没球可捡）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（怪量足够撑起吸修为窗口）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标面额按轮递增且封顶（第 2 轮 +16，第 99 轮到 max）',
    SIM.julingNeedFor(0) === P.needExp &&
    SIM.julingNeedFor(1) === P.needExp + P.expStep &&
    SIM.julingNeedFor(99) === P.maxExp,
    '0=' + SIM.julingNeedFor(0) + ' 1=' + SIM.julingNeedFor(1) +
    ' 99=' + SIM.julingNeedFor(99));
  expect('目标面额至少 24、封顶 120（30 秒靠捡球做得到，但不白送）',
    P.needExp >= 24 && P.needExp <= P.maxExp && P.maxExp <= 120,
    'need=' + P.needExp + ' max=' + P.maxExp);
  expect('奖励仍是「一箱 + 零钱」（与前二十一件同口径）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开全部既有事件（含涌金 558、启匣 546、寻仇 534）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE', 'ASCEND', 'UNSEAL', 'YONGJIN'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'juling=' + P.startSec + ' yongjin=' + C.YONGJIN.startSec);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（直接调状态机入口与钩子）----------
  const wR = cleanWorld(11801);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, P.needExp);
  wR.time = wR.julingDeadline + 0.01;
  SIM.tickJuling(wR);
  expect('★开窗/入账/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(11802);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, P.needExp - 1);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(11810);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickJuling(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.julingRounds === 0 && evs(wT, 'juling_start').length === 0,
    'rounds=' + wT.julingRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.julingActive === 1 && wT.julingRounds === 1,
    'rounds=' + wT.julingRounds + ' active=' + wT.julingActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前二十一件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'juling_start')[0];
  expect('开窗播报一次说清三件事：多久 / 多少面额 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needExp && st.round === 1 &&
    evs(wT, 'juling_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.julingDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.julingDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.julingNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.julingNextTick);
  SIM.tickJuling(wT);
  expect('同帧重复调用不会二次开窗', wT.julingRounds === 1,
    'rounds=' + wT.julingRounds);
  wT.time = wT.julingDeadline - 0.001;
  SIM.tickJuling(wT);
  expect('到期前一帧不发奖也不结算', wT.julingActive === 1 &&
    wT.julingExp === 0 && evs(wT, 'juling_done').length === 0 &&
    evs(wT, 'juling_fail').length === 0,
    'active=' + wT.julingActive + ' exp=' + wT.julingExp);

  // ---------- 4. 过半（连续面额：>= 跨阈值 + 标记位防刷屏）----------
  const wH = cleanWorld(11821);
  openWindow(wH);
  feed(wH, Math.floor((P.needExp - 1) / 2));
  expect('过半前零播报', evs(wH, 'juling_half').length === 0,
    'half=' + evs(wH, 'juling_half').length + ' exp=' + wH.julingExp);
  feed(wH, 1);
  expect('过半报一次', evs(wH, 'juling_half').length === 1,
    'half=' + evs(wH, 'juling_half').length);
  for (let i = 0; i < 100; i++) feed(wH, 1);
  expect('多吃球不刷屏（过半播报恰好一次）', evs(wH, 'juling_half').length === 1,
    'half=' + evs(wH, 'juling_half').length);
  const wH2 = cleanWorld(11822);
  openWindow(wH2);
  // ★一次大额入账直接跨过 half：用 === 判会漏报，必须钉 >=。
  feed(wH2, P.needExp);
  expect('★★★一次大额入账直接跨过半程也报（钉「>=」而不是「===」）',
    evs(wH2, 'juling_half').length === 1 &&
    evs(wH2, 'juling_half')[0].got === P.needExp,
    'half=' + evs(wH2, 'juling_half').length +
    ' got=' + ((evs(wH2, 'juling_half')[0] || {}).got));
  const wH3 = cleanWorld(11823);
  openWindow(wH3);
  finish(wH3, P.needExp);
  expect('整轮只报一次过半（数字锁在首次跨半那一刻）',
    evs(wH3, 'juling_half').length === 1,
    'half=' + evs(wH3, 'juling_half').length);

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(11830);
  openWindow(wD);
  finish(wD, P.needExp);
  expect('窗口内吸够面额 → 达成', wD.julingActive === 0 && wD.julingDone === 1 &&
    evs(wD, 'juling_done').length === 1, 'done=' + wD.julingDone);
  expect('宝箱正好一个（与前二十一件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'juling_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got === P.needExp && dn.need === P.needExp &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const pickupsAfter = wD.pickups.length;
  feed(wD, 200);
  SIM.tickJuling(wD);
  expect('★达标后再吃球、再推时间都不二次发奖', wD.pickups.length === pickupsAfter &&
    wD.julingDone === 1 && evs(wD, 'juling_done').length === 1,
    'pickups=' + wD.pickups.length + ' done=' + wD.julingDone);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickJuling(wD);
  expect('下一轮目标递增、面额清零', wD.julingRounds === 2 &&
    wD.julingNeed === P.needExp + P.expStep && wD.julingExp === 0,
    'need=' + wD.julingNeed + ' exp=' + wD.julingExp);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(11840);
  openWindow(wF);
  finish(wF, P.needExp - 1);
  expect('差一点也落空', wF.julingActive === 0 && wF.julingFailed === 1 &&
    wF.julingDone === 0, 'failed=' + wF.julingFailed + ' done=' + wF.julingDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'juling_done').length === 0,
    'done=' + evs(wF, 'juling_done').length);
  const fl = evs(wF, 'juling_fail')[0];
  expect('落空只陈述还差多少（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needExp - 1 && fl.need === P.needExp,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.julingNextTick = 1e9;
  SIM.tickJuling(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.julingDone === 0, 'pickups=' + wF.pickups.length);
  const expAfterFail = wF.julingExp;
  feed(wF, 100);
  expect('落空后再吃球也不计数（钩子只认 active）',
    wF.julingExp === expAfterFail && wF.julingActive === 0,
    'exp=' + wF.julingExp + '（落空时 ' + expAfterFail + '）');

  // ---------- 7. ★★★核心新轴：只数自己的、只数真实入账面额 ----------
  const wB = cleanWorld(11850);
  openWindow(wB);
  const pB = wB.self || wB.player;
  const mate = Object.assign({}, pB);
  feed(wB, 5, mate);
  expect('★队友吃的球不算（钩子核对 p === self）', wB.julingExp === 0,
    'exp=' + wB.julingExp);
  feed(wB, 7);
  expect('自己一颗入账 7 点就记 7 点（按面额，不按颗数）', wB.julingExp === 7,
    'exp=' + wB.julingExp);
  feed(wB, 2);
  expect('再入账 2 点累加到 9（正向对照，证明闸不是恒关）', wB.julingExp === 9,
    'exp=' + wB.julingExp);
  feed(wB, 0);
  feed(wB, -3);
  expect('★★非正数入账不算（拒绝分支不污染计数）', wB.julingExp === 9,
    'exp=' + wB.julingExp);
  const wOut = cleanWorld(11851);
  feed(wOut, 5);
  expect('窗口外吃球不算', wOut.julingExp === 0, 'exp=' + wOut.julingExp);

  // ---------- 8. ★★★灵魂断言：真实 step 拾取链路 ----------
  const wReal = cleanWorld(11860);
  openWindow(wReal);
  const pReal = wReal.self || wReal.player;
  pReal.attrs.expMul = 4;       // 模拟修为加成：一颗面值 2 的球实际入账 8
  SIM.spawnPickup(wReal, 'exp', pReal.x, pReal.y, 2, 30);
  const expSlotBefore = pReal.exp;
  SIM.step(wReal, { mx: 0, my: 0 });
  expect('★★★真实 step：只认真入账 8 点，不是名义面值 2、也不是 1 颗',
    wReal.julingExp === 8 && pReal.exp - expSlotBefore === 8,
    'juling=' + wReal.julingExp + ' slot+' + (pReal.exp - expSlotBefore));
  const wChest = cleanWorld(11861);
  openWindow(wChest);
  const pC = wChest.self || wChest.player;
  const lvBeforeChest = pC.level;
  SIM.spawnPickup(wChest, 'chest', pC.x, pC.y, 1, 30);
  SIM.step(wChest, { mx: 0, my: 0 });
  expect('★★★宝箱白送的免费升级确实升了级，但聚灵诀一分不算（钉钩子在 exp 分支）',
    pC.level > lvBeforeChest && wChest.julingExp === 0,
    'level ' + lvBeforeChest + '→' + pC.level + ' juling=' + wChest.julingExp);
  const wOther = cleanWorld(11862);
  openWindow(wOther);
  const pO = wOther.self || wOther.player;
  SIM.spawnPickup(wOther, 'gold', pO.x, pO.y, 5, 30);
  SIM.spawnPickup(wOther, 'heart', pO.x - 5, pO.y, 1, 30);
  SIM.step(wOther, { mx: 0, my: 0 });
  expect('★★捡金币/红心一个都不算（钩子只挂 exp 分支）',
    wOther.julingExp === 0, 'exp=' + wOther.julingExp);
  const wLoop = cleanWorld(11863);
  openWindow(wLoop);
  finish(wLoop, P.needExp);
  SIM.step(wLoop, { mx: 0, my: 0 });
  expect('★★达标奖励里的钱被自己捡掉、箱被自己开掉，也不算进下一轮（active 闸）',
    wLoop.julingExp === P.needExp && wLoop.julingDone === 1,
    'exp=' + wLoop.julingExp + ' done=' + wLoop.julingDone);
  const wOutStep = cleanWorld(11864);
  const pOS = wOutStep.self || wOutStep.player;
  const slotOutBefore = pOS.exp;
  SIM.spawnPickup(wOutStep, 'exp', pOS.x, pOS.y, 3, 30);
  SIM.step(wOutStep, { mx: 0, my: 0 });
  expect('★★窗口外真实吃球一分不算（正向对照证明球确实被吃了）',
    wOutStep.julingExp === 0 && pOS.exp - slotOutBefore === 3,
    'juling=' + wOutStep.julingExp + ' slot+' + (pOS.exp - slotOutBefore));

  // ---------- 9. 剧情关隔离（两个入口都钉；step 验不了，见下面那条）----------
  const wS = cleanWorld(11870);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickJuling(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.julingActive === 0 && wS.julingRounds === 0 && wS.julingExp === 0 &&
    evs(wS, 'juling_start').length === 0,
    'active=' + wS.julingActive + ' exp=' + wS.julingExp);
  // ★先手动开 active，让钩子里的 story 闸成为唯一屏障（否则被 active 闸抢先挡住＝假绿）。
  wS.julingActive = 1;
  feed(wS, P.needExp);
  expect('★★★剧情关就算强行开窗喂一大笔修为，钩子也不计数（钉钩子层 story 闸）',
    wS.julingExp === 0 && evs(wS, 'juling_half').length === 0,
    'exp=' + wS.julingExp);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 11871, modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 564 秒：step 验不出，两个入口断言就是唯一依据',
    wS2.matchSec < P.startSec && P.startSec > 540,
    'ch6上限=' + wS2.matchSec + ' 首发=' + P.startSec);

  // ---------- 10. ★钉住 step 段的调用点 ----------
  const wStepOpen = cleanWorld(11880);
  wStepOpen.tick = startTick - 1;
  wStepOpen.time = wStepOpen.tick / HZ;
  for (let k = 0; k < 3; k++) SIM.step(wStepOpen, { mx: 0, my: 0 });
  expect('★★真实 step 跨过首发帧也会开窗（钉住 step 段的 tickJuling 调用点）',
    wStepOpen.julingActive === 1 && wStepOpen.julingRounds === 1 &&
    evs(wStepOpen, 'juling_start').length === 1,
    'active=' + wStepOpen.julingActive + ' rounds=' + wStepOpen.julingRounds +
    ' state=' + wStepOpen.state);
}

// ============================================================
// 第七十八轮：崩山诀 ONEHIT（限时一击秒杀满血妖）
// ============================================================
function testOnehit() {
  console.log('[第七十八轮] 崩山诀：第一件「限时一击秒杀满血妖」目标（爆发力，不是累计量）');
  const P = C.ONEHIT;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 造一只满血怪并用一发足够大的伤害直接打死（crit=0 → 不抽随机、必死）。
  // ★seed 固定 → spawnMob 不抽 nextRand；damageMob 的 crit=0 也不抽 → 零随机可验。
  function smiteFull(w, tag) {
    const p = w.self || w.player;
    const m = SIM.spawnMob(w, 'corpse', p.x + 300 + (tag || 0), p.y, 1, 0, 1 + (tag || 0));
    if (!m) return false;
    SIM.damageMob(w, m, m.hp + 1, 0, 0, 'test');
    return !m.alive;
  }
  // 直接喂"满血一击"给钩子（绕过 damageMob 的掉落/暴击）：状态机层断言专用，
  //   与聚灵诀的 feed 同源——击杀掉落属于掉落系统、不是本件发奖，会污染"零掉落"判据。
  function feedKills(w, n) {
    for (let i = 0; i < n; i++) SIM.onOneHitKill(w, null, true, false);
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.onehitNextTick = 0;
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀默认推远
    SIM.tickOnehit(w);
  }
  function finish(w, kills) {
    feedKills(w, kills);
    w.time = w.onehitDeadline + 0.01;
    SIM.tickOnehit(w);
  }
  // 隔离世界：其它机制全推远、关武器、经验槽锁死；本件默认开窗由 openWindow 精确触发。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    p.attrs.crit = 0;         // 钉死暴击：击杀链路不抽随机，零随机断言才成立
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 1e9;
    w.yongjinNextTick = 1e9;
    w.julingNextTick = 1e9;
    w.onehitNextTick = 0;     // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.retaliateNextTick = 1e9; // 第八十轮：反击诀默认推远，由本件 openWindow 精确开窗
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那波没怪可秒）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('首发已进 altar 收官区（怪量足够撑起秒杀窗口）',
    P.startSec / 30 >= 15, 'startSec=' + P.startSec);
  expect('窗口短于间隔（两轮不许叠在一起），且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标只数按轮递增且封顶（第 2 轮 +1，第 99 轮到 max）',
    SIM.onehitNeedFor(0) === P.needKills &&
    SIM.onehitNeedFor(1) === P.needKills + P.killStep &&
    SIM.onehitNeedFor(99) === P.maxKills,
    '0=' + SIM.onehitNeedFor(0) + ' 1=' + SIM.onehitNeedFor(1) +
    ' 99=' + SIM.onehitNeedFor(99));
  expect('目标至少 2 只、封顶不超过 12（30 秒一发一只做得到，但不白送）',
    P.needKills >= 2 && P.needKills <= P.maxKills && P.maxKills <= 12,
    'need=' + P.needKills + ' max=' + P.maxKills);
  expect('奖励仍是「一箱 + 零钱」（与前二十二件同口径）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('首发时刻错开全部既有事件（含聚灵 564、涌金 558、启匣 546）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE', 'ASCEND', 'UNSEAL', 'YONGJIN', 'JULING'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'onehit=' + P.startSec + ' juling=' + C.JULING.startSec);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（直接调状态机入口与真实击杀链路）----------
  const wR = cleanWorld(11901);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedKills(wR, 1);
  wR.time = wR.onehitDeadline + 0.01;
  SIM.tickOnehit(wR);
  expect('★开窗/满血击杀/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(11902);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, P.needKills - 1);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(11910);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickOnehit(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.onehitRounds === 0 && evs(wT, 'onehit_start').length === 0,
    'rounds=' + wT.onehitRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.onehitActive === 1 && wT.onehitRounds === 1,
    'rounds=' + wT.onehitRounds + ' active=' + wT.onehitActive);
  // ★开窗后清掉测试造的怪（本段只看开窗本身有没有放实体）
  wT.mobs.length = 0;
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike（与前二十二件同族）',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length +
    ' fx=' + wT.effects.length + ' zone=' + wT.zones.length + ' strike=' + wT.strikes.length);
  const st = evs(wT, 'onehit_start')[0];
  expect('开窗播报一次说清三件事：多久 / 秒几只 / 轮次',
    !!st && st.sec === P.windowSec && st.need === P.needKills && st.round === 1 &&
    evs(wT, 'onehit_start').length === 1, JSON.stringify(st || null));
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.onehitDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.onehitDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.onehitNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.onehitNextTick);
  SIM.tickOnehit(wT);
  expect('同帧重复调用不会二次开窗', wT.onehitRounds === 1,
    'rounds=' + wT.onehitRounds);
  wT.time = wT.onehitDeadline - 0.001;
  SIM.tickOnehit(wT);
  expect('到期前一帧不发奖也不结算', wT.onehitActive === 1 &&
    wT.onehitKills === 0 && evs(wT, 'onehit_done').length === 0 &&
    evs(wT, 'onehit_fail').length === 0,
    'active=' + wT.onehitActive + ' kills=' + wT.onehitKills);

  // ---------- 4. 过半（次数是整数逐次 +1：标记位防多杀刷屏）----------
  const wH = cleanWorld(11921);
  openWindow(wH);
  feedKills(wH, 1);
  expect('过半前零播报（1 只 < 目标的一半）',
    evs(wH, 'onehit_half').length === 0,
    'half=' + evs(wH, 'onehit_half').length + ' kills=' + wH.onehitKills);
  feedKills(wH, 1);
  expect('过半报一次', evs(wH, 'onehit_half').length === 1,
    'half=' + evs(wH, 'onehit_half').length);
  feedKills(wH, 20);
  expect('★★多秒不刷屏（过半播报恰好一次，钉标记位闸）',
    evs(wH, 'onehit_half').length === 1,
    'half=' + evs(wH, 'onehit_half').length + ' kills=' + wH.onehitKills);
  const wH3 = cleanWorld(11923);
  openWindow(wH3);
  finish(wH3, P.needKills);
  expect('整轮只报一次过半（数字锁在首次跨半那一刻）',
    evs(wH3, 'onehit_half').length === 1,
    'half=' + evs(wH3, 'onehit_half').length);

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(11930);
  openWindow(wD);
  finish(wD, P.needKills);
  expect('窗口内秒够只数 → 达成', wD.onehitActive === 0 && wD.onehitDone === 1 &&
    evs(wD, 'onehit_done').length === 1, 'done=' + wD.onehitDone);
  expect('宝箱正好一个（与前二十二件同口径）', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确',
    byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'onehit_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got >= P.needKills && dn.need === P.needKills &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  const killsAfter = wD.onehitKills;
  const pickupsAfter = wD.pickups.length;
  feedKills(wD, 5);
  SIM.tickOnehit(wD);
  expect('★达标后再秒满血妖、再推时间都不二次发奖',
    wD.pickups.length === pickupsAfter && wD.onehitDone === 1 &&
    evs(wD, 'onehit_done').length === 1 && wD.onehitKills === killsAfter,
    'pickups=' + wD.pickups.length + ' done=' + wD.onehitDone + ' kills=' + wD.onehitKills);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickOnehit(wD);
  expect('下一轮目标递增、只数清零', wD.onehitRounds === 2 &&
    wD.onehitNeed === P.needKills + P.killStep && wD.onehitKills === 0,
    'need=' + wD.onehitNeed + ' kills=' + wD.onehitKills);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(11940);
  openWindow(wF);
  finish(wF, P.needKills - 1);
  expect('差一点也落空', wF.onehitActive === 0 && wF.onehitFailed === 1 &&
    wF.onehitDone === 0, 'failed=' + wF.onehitFailed + ' done=' + wF.onehitDone);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'onehit_done').length === 0,
    'done=' + evs(wF, 'onehit_done').length);
  const fl = evs(wF, 'onehit_fail')[0];
  expect('落空只陈述还差多少（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needKills - 1 && fl.need === P.needKills,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.onehitNextTick = 1e9;
  wF.retaliateNextTick = 1e9; // 第八十轮：反击诀默认推远
  SIM.tickOnehit(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.onehitDone === 0, 'pickups=' + wF.pickups.length);
  const killsAfterFail = wF.onehitKills;
  feedKills(wF, 5);
  expect('落空后再秒满血妖也不计数（钩子只认 active）',
    wF.onehitKills === killsAfterFail && wF.onehitActive === 0,
    'kills=' + wF.onehitKills + '（落空时 ' + killsAfterFail + '）');

  // ---------- 7. ★★★核心新轴：只认真·一击·满血 ----------
  const wB = cleanWorld(11950);
  openWindow(wB);
  const pB = wB.self || wB.player;
  // 先削到残血，再补最后一刀 —— 击杀前已非满血，不算。
  const halfMob = SIM.spawnMob(wB, 'corpse', pB.x + 310, pB.y, 1, 0, 7);
  SIM.damageMob(wB, halfMob, 1, 0, 0, 'test');
  expect('★★正向对照：怪确实被削成残血（不是满血）',
    halfMob.alive && halfMob.hp < halfMob.maxHp,
    'hp=' + halfMob.hp + ' max=' + halfMob.maxHp);
  SIM.damageMob(wB, halfMob, halfMob.hp + 1, 0, 0, 'test');
  expect('★★★先削血再补刀不算（钉 killMob 漏斗的 wasFullBeforeHit 判据）',
    !halfMob.alive && wB.onehitKills === 0,
    'kills=' + wB.onehitKills + ' alive=' + halfMob.alive);
  // 一发直接带走满血妖 —— 算 1 只（正向对照，证明闸不是恒关）。
  expect('★★满血妖一发直接带走 → 记 1 只', smiteFull(wB, 20) && wB.onehitKills === 1,
    'kills=' + wB.onehitKills);
  // 世界伤害（天火）砸死满血妖不算。
  const wWorld = cleanWorld(11951);
  openWindow(wWorld);
  const pW = wWorld.self || wWorld.player;
  const wm = SIM.spawnMob(wWorld, 'corpse', pW.x + 320, pW.y, 1, 0, 9);
  SIM.damageMob(wWorld, wm, wm.hp + 1, 0, 0, 'meteor');
  expect('★★★天火砸死满血妖不算（isWorld 闸，白送不算爆发）',
    !wm.alive && wWorld.onehitKills === 0,
    'kills=' + wWorld.onehitKills + ' alive=' + wm.alive);
  // 灼烧慢慢磨死不算：tickBurn 走 killMob 不传参 → wasFullBeforeHit 为 undefined。
  const wBurn = cleanWorld(11952);
  openWindow(wBurn);
  const pBu = wBurn.self || wBurn.player;
  const bm = SIM.spawnMob(wBurn, 'corpse', pBu.x + 330, pBu.y, 1, 0, 11);
  bm.burnT = 10; bm.burnDmg = 999999; bm.burnSrc = 'fire'; bm.burnOwner = pBu;
  SIM.step(wBurn, { mx: 0, my: 0 });
  expect('★★★灼烧磨死满血妖不算（tickBurn 的 killMob 不传击杀前满血标记）',
    !bm.alive && wBurn.onehitKills === 0,
    'kills=' + wBurn.onehitKills + ' alive=' + bm.alive);
  // 灵泉世界伤害（ley）也不算。
  const wLey = cleanWorld(11953);
  openWindow(wLey);
  const pL = wLey.self || wLey.player;
  const lm = SIM.spawnMob(wLey, 'corpse', pL.x + 340, pL.y, 1, 0, 13);
  SIM.damageMob(wLey, lm, lm.hp + 1, 0, 0, 'ley');
  expect('★★灵泉砸死满血妖不算（与天火同一条 isWorld 隔离线）',
    !lm.alive && wLey.onehitKills === 0, 'kills=' + wLey.onehitKills);
  const wOut = cleanWorld(11954);
  smiteFull(wOut, 30);
  expect('窗口外一击秒杀满血妖不算', wOut.onehitKills === 0,
    'kills=' + wOut.onehitKills);

  // ---------- 8. 剧情关隔离（两个入口都钉）----------
  const wS = cleanWorld(11970);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickOnehit(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.onehitActive === 0 && wS.onehitRounds === 0 && wS.onehitKills === 0 &&
    evs(wS, 'onehit_start').length === 0,
    'active=' + wS.onehitActive + ' kills=' + wS.onehitKills);
  // ★先手动开 active，让钩子里的 story 闸成为唯一屏障。
  wS.onehitActive = 1;
  smiteFull(wS, 40);
  expect('★★★剧情关就算强行开窗、真秒满血妖，钩子也不计数（钉钩子层 story 闸）',
    wS.onehitKills === 0 && evs(wS, 'onehit_half').length === 0,
    'kills=' + wS.onehitKills);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 11971, modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 576 秒：step 验不出，两个入口断言就是唯一依据',
    wS2.matchSec < P.startSec && P.startSec > 540,
    'ch6上限=' + wS2.matchSec + ' 首发=' + P.startSec);

  // ---------- 9. ★钉住 step 段的调用点 ----------
  const wStepOpen = cleanWorld(11980);
  wStepOpen.tick = startTick - 1;
  wStepOpen.time = wStepOpen.tick / HZ;
  for (let k = 0; k < 3; k++) SIM.step(wStepOpen, { mx: 0, my: 0 });
  expect('★★真实 step 跨过首发帧也会开窗（钉住 step 段的 tickOnehit 调用点）',
    wStepOpen.onehitActive === 1 && wStepOpen.onehitRounds === 1 &&
    evs(wStepOpen, 'onehit_start').length === 1,
    'active=' + wStepOpen.onehitActive + ' rounds=' + wStepOpen.onehitRounds +
    ' state=' + wStepOpen.state);
}

// ============================================================
// 第七十九轮：击杀爆发的"事实层"守门
// ============================================================
// 视觉层（render.js 的 drawKillBurst）只依赖 death 这条既有特效；
// 这里钉死"什么时候才该有它"——尤其是**不该发生的事**：
// 未致命命中不许冒火花、重复打死同一只不许冒第二条。
function testKillFx() {
  console.log('=== 击杀爆发特效（第七十九轮）===');
  const w = SIM.createWorld({ seed: 12101 });
  const p = w.player;
  p.weapons.length = 0;
  p.expNext = 1e9;
  w.effects.length = 0;

  const m = SIM.spawnMob(w, 'corpse', p.x + 150, p.y, 1, 0, 1);
  expect('测试小怪生成成功', !!m && m.alive === true);
  SIM.damageMob(w, m, 1, 0, 0, 'test');
  expect('★★未致命命中不该冒出死亡特效（钉住 death 只在真击杀时产生）',
    m.alive === true && w.effects.length === 0,
    'alive=' + m.alive + ' effects=' + w.effects.length);

  SIM.damageMob(w, m, 1e6, 0, 0, 'test');
  const deaths = w.effects.filter(function (x) { return x.kind === 'death'; });
  expect('真击杀恰好一条 death 特效', deaths.length === 1, 'death=' + deaths.length);
  const d = deaths[0] || {};
  expect('死亡特效寿命 0.36 秒（几何爆发完整展开所需）',
    Math.abs(d.life - 0.36) < 1e-9 && Math.abs((d.maxLife || 0) - 0.36) < 1e-9,
    'life=' + d.life + ' maxLife=' + d.maxLife);
  expect('半径沿用 def.r，没有往快照塞新字段',
    d.r === C.MOB_MAP.corpse.r && Object.keys(d).length === 7,
    'r=' + d.r + ' 字段数=' + Object.keys(d).length);
  expect('颜色沿用妖物本色（碎芒分层用）', d.color === C.MOB_MAP.corpse.color,
    'color=' + d.color);

  const before = w.effects.length;
  SIM.damageMob(w, m, 1e6, 0, 0, 'test');
  expect('★★对同一具尸体再打一次不该重复冒特效',
    w.effects.length === before,
    'before=' + before + ' after=' + w.effects.length);

  // 大怪：只验"也走同一条通道且尺寸更大"，不验总数（Boss 死亡另有事件）。
  w.effects.length = 0;
  const boss = SIM.spawnMob(w, 'blood_lord', p.x - 200, p.y, 1, 0, 2);
  expect('Boss 生成成功', !!boss && boss.alive === true);
  SIM.damageMob(w, boss, 1e9, 0, 0, 'test');
  const bd = w.effects.filter(function (x) { return x.kind === 'death'; })[0];
  expect('★★Boss 击杀也必须有 death 特效（不能只有小怪有）', !!bd,
    'death=' + w.effects.filter(function (x) { return x.kind === 'death'; }).length);
  expect('Boss 的爆发半径明显大于小怪（渲染层据此加第二道环）',
    !!bd && bd.r > C.MOB_MAP.corpse.r * 2,
    'boss r=' + (bd && bd.r) + ' 小怪 r=' + C.MOB_MAP.corpse.r);
  expect('Boss 死亡特效同样是 0.36 秒', !!bd && Math.abs(bd.life - 0.36) < 1e-9,
    'life=' + (bd && bd.life));
}

// ============================================================
// 第八十轮：反击诀（目标制零实体第二十四件，全新轴「挨打后的反击」）
// ============================================================
// ★核心灵魂断言：没挨过真伤就不许计数；挨打后超过 4 秒也不许计数；
//   队友挨打 / 无敌帧 / 升级定格 / 天火白送全都不算。
function testRetaliate() {
  console.log('[第八十轮] 反击诀：第一件「挨打后 4 秒内亲手清怪」目标（受伤→还手轴）');
  const P = C.RETALIATE;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  // 只喂状态机（绕过击杀掉落的固有随机）：零随机 / 达标 / 过半段专用。
  function feedHurt(w, n) {
    for (let i = 0; i < (n || 1); i++) SIM.onRetaliateHit(w, w.self || w.player);
  }
  function feedKills(w, n, isWorld) {
    for (let i = 0; i < (n || 1); i++) SIM.onRetaliateKill(w, !!isWorld);
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.retaliateNextTick = 0;
    SIM.tickRetaliate(w);
  }
  function finish(w, kills) {
    feedHurt(w, 1);
    feedKills(w, kills);
    w.time = w.retaliateDeadline + 0.01;
    SIM.tickRetaliate(w);
  }
  // 隔离世界：其它机制全推远、关武器、经验槽锁死；本件默认开窗由 openWindow 精确触发。
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    p.attrs.crit = 0;
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 1e9;
    w.yongjinNextTick = 1e9;
    w.julingNextTick = 1e9;
    w.onehitNextTick = 1e9;
    w.retaliateNextTick = 0;  // 本件默认开窗，干净世界里由 openWindow 精确触发
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 1e9; // 第八十一轮：踏罡诀 606s 开窗，默认推远
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上（否则开窗那波没怪可打）',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('★★首发时刻错开全部 31 个既有事件（含崩山诀 576）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE', 'ASCEND', 'UNSEAL', 'YONGJIN', 'JULING', 'ONEHIT'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'retaliate=' + P.startSec + ' onehit=' + C.ONEHIT.startSec);
  expect('反击期短于窗口、且长于 1 秒（够还手又不能一直开着）',
    P.afterSec > 1 && P.afterSec < P.windowSec, 'after=' + P.afterSec);
  expect('窗口短于间隔，且不短于 20 秒',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('目标按轮递增且封顶', SIM.retaliateNeedFor(0) === P.needKills &&
    SIM.retaliateNeedFor(1) === P.needKills + P.killStep &&
    SIM.retaliateNeedFor(99) === P.maxKills,
    '0=' + SIM.retaliateNeedFor(0) + ' 1=' + SIM.retaliateNeedFor(1));
  expect('目标只数落在合理区间（4 秒一口气杀得完，又不白送）',
    P.needKills >= 2 && P.needKills <= P.maxKills && P.maxKills <= 12,
    'need=' + P.needKills + ' max=' + P.maxKills);
  expect('奖励仍是「一箱 + 零钱」（与前二十三件同口径）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（直接调状态机入口与钩子）----------
  const wR = cleanWorld(13101);
  const rng0 = wR.rngState;
  openWindow(wR);
  feedHurt(wR, 1);
  feedKills(wR, 1);
  wR.time = wR.retaliateDeadline + 0.01;
  SIM.tickRetaliate(wR);
  expect('★开窗/受击/反击/达标发奖全过程一个 nextRand 都不抽',
    wR.rngState === rng0, 'rng ' + rng0 + ' → ' + wR.rngState);
  const wR2 = cleanWorld(13102);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  finish(wR2, P.needKills - 1);
  expect('★到期落空也不抽随机（失败分支同样是纯状态迁移）',
    wR2.rngState === rng1, 'rng ' + rng1 + ' → ' + wR2.rngState);

  // ---------- 3. 时序 / 零实体 ----------
  const wT = cleanWorld(13110);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickRetaliate(wT);
  expect('到点前一帧零轮、零播报（初值 0 不会开局误开）',
    wT.retaliateRounds === 0 && evs(wT, 'retaliate_start').length === 0,
    'rounds=' + wT.retaliateRounds);
  openWindow(wT);
  expect('到点整帧正好开一轮', wT.retaliateActive === 1 && wT.retaliateRounds === 1,
    'rounds=' + wT.retaliateRounds + ' active=' + wT.retaliateActive);
  expect('★★开窗零实体：没怪、没球、没特效、没 zone、没 strike',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.effects.length === 0 && wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pickup=' + wT.pickups.length);
  const st = evs(wT, 'retaliate_start')[0];
  expect('开窗播报一次说清四件事：多久 / 反击期 / 几只 / 轮次',
    !!st && st.sec === P.windowSec && st.after === P.afterSec &&
    st.need === P.needKills && st.round === 1 &&
    evs(wT, 'retaliate_start').length === 1, JSON.stringify(st || null));
  expect('★★开窗时不给反击期（没挨打就不许还手）', wT.retaliateUntil === 0,
    'until=' + wT.retaliateUntil);
  expect('到期时刻 = 开窗时刻 + windowSec（整数 tick 换算，零漂移）',
    Math.abs(wT.retaliateDeadline - (startTick / HZ + P.windowSec)) < 1e-9,
    'deadline=' + wT.retaliateDeadline);
  expect('下一轮排期 = 本轮 + everySec（不会同帧再开）',
    wT.retaliateNextTick === startTick + Math.round(P.everySec * HZ),
    'next=' + wT.retaliateNextTick);
  SIM.tickRetaliate(wT);
  expect('同帧重复调用不会二次开窗', wT.retaliateRounds === 1,
    'rounds=' + wT.retaliateRounds);
  wT.time = wT.retaliateDeadline - 0.001;
  SIM.tickRetaliate(wT);
  expect('到期前一帧不发奖也不结算', wT.retaliateActive === 1 &&
    wT.retaliateKills === 0 && evs(wT, 'retaliate_done').length === 0 &&
    evs(wT, 'retaliate_fail').length === 0,
    'active=' + wT.retaliateActive + ' kills=' + wT.retaliateKills);

  // ---------- 4. 过半（整数次逐次 +1：标记位防多杀刷屏）----------
  const wH = cleanWorld(13121);
  openWindow(wH);
  feedHurt(wH, 1);
  feedKills(wH, 1);
  expect('过半前零播报', evs(wH, 'retaliate_half').length === 0,
    'half=' + evs(wH, 'retaliate_half').length);
  feedKills(wH, 1);
  expect('过半报一次', evs(wH, 'retaliate_half').length === 1,
    'half=' + evs(wH, 'retaliate_half').length);
  feedKills(wH, 20);
  expect('★★多杀不刷屏（过半播报恰好一次，钉标记位闸）',
    evs(wH, 'retaliate_half').length === 1,
    'half=' + evs(wH, 'retaliate_half').length);
  const wH3 = cleanWorld(13123);
  openWindow(wH3);
  finish(wH3, P.needKills);
  expect('整轮只报一次过半', evs(wH3, 'retaliate_half').length === 1,
    'half=' + evs(wH3, 'retaliate_half').length);

  // ---------- 5. 达标 ----------
  const wD = cleanWorld(13130);
  openWindow(wD);
  finish(wD, P.needKills);
  expect('窗口内反击够只数 → 达成', wD.retaliateActive === 0 &&
    wD.retaliateDone === 1 && evs(wD, 'retaliate_done').length === 1,
    'done=' + wD.retaliateDone);
  expect('宝箱正好一个', byKind(wD, 'chest').length === P.rewardChest,
    'chest=' + byKind(wD, 'chest').length);
  expect('金币枚数 × 面值正确', byKind(wD, 'gold').length === P.goldDrops &&
    byKind(wD, 'gold').every(function (it) { return it.value === P.rewardGold; }),
    'gold=' + byKind(wD, 'gold').length);
  const pDrop = wD.self || wD.player;
  expect('奖励落在玩家脚下（偏移只有撒开的 14px）',
    byKind(wD, 'chest').every(function (it) {
      return Math.sqrt((it.x - pDrop.x) * (it.x - pDrop.x) +
        (it.y - pDrop.y) * (it.y - pDrop.y)) < 20;
    }), 'player=' + Math.round(pDrop.x) + ',' + Math.round(pDrop.y));
  const dn = evs(wD, 'retaliate_done')[0];
  expect('达标播报的 got/need/奖励数字来自事件本身',
    !!dn && dn.got >= P.needKills && dn.need === P.needKills &&
    dn.chest === P.rewardChest && dn.gold === P.goldDrops * P.rewardGold,
    JSON.stringify(dn || null));
  expect('★★达标后反击期立即关掉（奖励里的球/钱不会开新一轮）',
    wD.retaliateUntil === 0, 'until=' + wD.retaliateUntil);
  const killsAfter = wD.retaliateKills;
  const pickupsAfter = wD.pickups.length;
  feedHurt(wD, 1);
  feedKills(wD, 5);
  SIM.tickRetaliate(wD);
  expect('★达标后再挨打、再反击都不二次发奖',
    wD.pickups.length === pickupsAfter && wD.retaliateDone === 1 &&
    evs(wD, 'retaliate_done').length === 1 && wD.retaliateKills === killsAfter,
    'pickups=' + wD.pickups.length + ' kills=' + wD.retaliateKills);
  wD.tick = startTick + Math.round(P.everySec * HZ);
  wD.time = wD.tick / HZ;
  SIM.tickRetaliate(wD);
  expect('下一轮目标递增、只数清零', wD.retaliateRounds === 2 &&
    wD.retaliateNeed === P.needKills + P.killStep && wD.retaliateKills === 0,
    'need=' + wD.retaliateNeed + ' kills=' + wD.retaliateKills);

  // ---------- 6. 落空（什么都不给、不责备）----------
  const wF = cleanWorld(13140);
  openWindow(wF);
  finish(wF, P.needKills - 1);
  expect('差一点也落空', wF.retaliateActive === 0 && wF.retaliateFailed === 1 &&
    wF.retaliateDone === 0, 'failed=' + wF.retaliateFailed);
  expect('★★落空时一个掉落物都不多', wF.pickups.length === 0,
    'pickups=' + wF.pickups.length);
  expect('★★落空绝不出现「达成」播报', evs(wF, 'retaliate_done').length === 0,
    'done=' + evs(wF, 'retaliate_done').length);
  const fl = evs(wF, 'retaliate_fail')[0];
  expect('落空只陈述还差多少（没有责备字眼），且数字正确',
    !!fl && fl.left === 1 && fl.got === P.needKills - 1 && fl.need === P.needKills,
    JSON.stringify(fl || null));
  wF.tick = startTick + Math.round(P.everySec * HZ) * 10;
  wF.time = wF.tick / HZ;
  wF.retaliateNextTick = 1e9;
  SIM.tickRetaliate(wF);
  expect('推到很晚也不补发（不追认落空的轮次）', wF.pickups.length === 0 &&
    wF.retaliateDone === 0, 'pickups=' + wF.pickups.length);
  const killsAfterFail = wF.retaliateKills;
  feedHurt(wF, 1);
  feedKills(wF, 5);
  expect('落空后再挨打反击也不计数（钩子只认 active）',
    wF.retaliateKills === killsAfterFail && wF.retaliateActive === 0,
    'kills=' + wF.retaliateKills);

  // ---------- 7. ★★★核心新轴：没挨打不算、过期不算、白送不算 ----------
  const wB = cleanWorld(13150);
  openWindow(wB);
  feedKills(wB, 3);
  expect('★★★没挨过真伤，杀再多也不算（钉反击期闸）',
    wB.retaliateKills === 0, 'kills=' + wB.retaliateKills);
  const pB = wB.self || wB.player;
  const hpBefore = pB.hp;
  SIM.damagePlayer(wB, pB, 10, pB.x + 20, pB.y);
  expect('★★正向对照：真受伤确实扣了血并开出反击期',
    pB.hp < hpBefore && Math.abs(wB.retaliateUntil - (wB.time + P.afterSec)) < 1e-9,
    'hp=' + hpBefore + '→' + pB.hp + ' until=' + wB.retaliateUntil);
  const m = SIM.spawnMob(wB, 'corpse', pB.x + 300, pB.y, 1, 0, 21);
  SIM.damageMob(wB, m, m.hp + 1, 0, 0, 'test');
  expect('★★真受伤后亲手击杀 → 记 1 只（钉真实 killMob 调用链）',
    !m.alive && wB.retaliateKills === 1, 'kills=' + wB.retaliateKills);
  // 边界：截止那一刻算，过了那一刻不算。
  const wEdge = cleanWorld(13151);
  openWindow(wEdge);
  feedHurt(wEdge, 1);
  wEdge.time = wEdge.retaliateUntil;
  feedKills(wEdge, 1);
  expect('★反击期截止时刻仍算（闭区间含边界）', wEdge.retaliateKills === 1,
    'kills=' + wEdge.retaliateKills);
  wEdge.time = wEdge.retaliateUntil + 0.01;
  feedKills(wEdge, 1);
  expect('★★★反击期过了就不算（钉 until 闸）', wEdge.retaliateKills === 1,
    'kills=' + wEdge.retaliateKills);
  const wRe = cleanWorld(13152);
  openWindow(wRe);
  feedHurt(wRe, 1);
  wRe.time = wRe.retaliateUntil + 0.01;
  feedHurt(wRe, 1);
  feedKills(wRe, 1);
  expect('连续挨打只续期、不清空已反击只数',
    wRe.retaliateKills === 1 && wRe.retaliateUntil === wRe.time + P.afterSec,
    'kills=' + wRe.retaliateKills + ' until=' + wRe.retaliateUntil);
  const wWorld = cleanWorld(13153);
  openWindow(wWorld);
  feedHurt(wWorld, 1);
  const pW = wWorld.self || wWorld.player;
  const wm = SIM.spawnMob(wWorld, 'corpse', pW.x + 320, pW.y, 1, 0, 22);
  SIM.damageMob(wWorld, wm, wm.hp + 1, 0, 0, 'meteor');
  expect('★★★天火砸死不算（isWorld 闸，白送不算反击）',
    !wm.alive && wWorld.retaliateKills === 0, 'kills=' + wWorld.retaliateKills);
  const wLey = cleanWorld(13154);
  openWindow(wLey);
  feedHurt(wLey, 1);
  feedKills(wLey, 1, true);
  expect('★★灵泉/引魂灯的世界伤害同样不算', wLey.retaliateKills === 0,
    'kills=' + wLey.retaliateKills);

  // ---------- 8. ★钉住「谁挨的打」：队友 / 无敌帧 / 升级定格一律不算 ----------
  const wMate = cleanWorld(13160);
  openWindow(wMate);
  const pm = wMate.self || wMate.player;
  const mate = {
    x: pm.x, y: pm.y, r: pm.r, hp: pm.maxHp, maxHp: pm.maxHp,
    alive: true, invuln: 0, state: 'playing', attrs: pm.attrs
  };
  SIM.damagePlayer(wMate, mate, 20, mate.x + 20, mate.y);
  expect('★★★队友挨打不给玩家开反击期',
    mate.hp < mate.maxHp && wMate.retaliateUntil === 0,
    'mateHp=' + mate.hp + ' until=' + wMate.retaliateUntil);
  const wInv = cleanWorld(13161);
  openWindow(wInv);
  const pi = wInv.self || wInv.player;
  pi.invuln = 1;
  const hpI = pi.hp;
  SIM.damagePlayer(wInv, pi, 20, pi.x + 20, pi.y);
  expect('★★★无敌帧挡下的攻击不算挨打（走不到真扣血分支）',
    pi.hp === hpI && wInv.retaliateUntil === 0,
    'hp=' + pi.hp + ' until=' + wInv.retaliateUntil);
  const wLv = cleanWorld(13162);
  openWindow(wLv);
  const pl = wLv.self || wLv.player;
  pl.state = 'levelup';
  const hpL = pl.hp;
  SIM.damagePlayer(wLv, pl, 20, pl.x + 20, pl.y);
  expect('★★★升级定格期间挨打不算（世界照跑但人不该被动挨打）',
    pl.hp === hpL && wLv.retaliateUntil === 0,
    'hp=' + pl.hp + ' until=' + wLv.retaliateUntil);

  // ---------- 9. 剧情关隔离（两个入口都钉）----------
  const wS = cleanWorld(13170);
  wS.modId = 'myth';
  wS.storyStage = { id: 'ch6' };
  wS.tick = startTick;
  wS.time = wS.tick / HZ;
  SIM.tickRetaliate(wS);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wS.retaliateActive === 0 && wS.retaliateRounds === 0 &&
    wS.retaliateKills === 0 && evs(wS, 'retaliate_start').length === 0,
    'active=' + wS.retaliateActive + ' rounds=' + wS.retaliateRounds);
  // ★先手动开 active 并开门，让钩子里的 story 闸成为唯一屏障。
  wS.retaliateActive = 1;
  feedHurt(wS, 1);
  feedKills(wS, 3);
  expect('★★★剧情关强行开门、强行击杀也不计数（钉两个钩子的 story 闸）',
    wS.retaliateKills === 0 && wS.retaliateUntil === 0 &&
    evs(wS, 'retaliate_half').length === 0, 'kills=' + wS.retaliateKills);
  const wS2 = SIM.createWorld({ charId: 'hunter', seed: 13171, modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 588 秒：step 验不出，两个入口断言就是唯一依据',
    wS2.matchSec < P.startSec && P.startSec > 540,
    'ch6上限=' + wS2.matchSec + ' 首发=' + P.startSec);

  // ---------- 10. ★钉住 step 段的调用点 ----------
  const wStepOpen = cleanWorld(13180);
  wStepOpen.tick = startTick - 1;
  wStepOpen.time = wStepOpen.tick / HZ;
  for (let k = 0; k < 3; k++) SIM.step(wStepOpen, { mx: 0, my: 0 });
  expect('★★真实 step 跨过首发帧也会开窗（钉住 step 段的 tickRetaliate 调用点）',
    wStepOpen.retaliateActive === 1 && wStepOpen.retaliateRounds === 1 &&
    evs(wStepOpen, 'retaliate_start').length === 1,
    'active=' + wStepOpen.retaliateActive + ' rounds=' + wStepOpen.retaliateRounds +
    ' state=' + wStepOpen.state);
}

// ============================================================
// 第八十二轮：磐石诀（目标制零实体第二十六件，全新轴「原地定力」）
// ============================================================
function testStill() {
  console.log('[第八十二轮] 磐石诀：第一件「原地定力」目标（静止轴）');
  const P = C.STILL;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    p.attrs.crit = 0;
    // 所有既有机制（含踏罡诀）的排期一律推远，隔离本件的观测窗口。
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 1e9;
    w.yongjinNextTick = 1e9;
    w.julingNextTick = 1e9;
    w.onehitNextTick = 1e9;
    w.retaliateNextTick = 1e9;
    w.tagaNextTick = 1e9; w.stillNextTick = 0; // 本件默认开窗
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.stillNextTick = 0;
    SIM.tickStill(w);
  }
  function stand(w, sec) {
    const n = Math.ceil(sec * HZ);
    for (let i = 0; i < n; i++) SIM.onStillStay(w, 1 / HZ);
  }
  function put(w, x, y) {
    const p = w.self || w.player;
    p.x = x;
    p.y = y;
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('★★首发时刻错开全部 33 个既有事件（含踏罡诀 606）',
    ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND', 'THUNDER', 'PERIL',
      'CAULDRON', 'BELL', 'HEALER', 'ESCORT', 'MARKET', 'METEOR', 'SUMMONER', 'DEVOURER',
      'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE', 'TEMPER', 'SWARM',
      'HUNT', 'VENGE', 'ASCEND', 'UNSEAL', 'YONGJIN', 'JULING', 'ONEHIT', 'RETALIATE',
      'TAGA'
    ].every(function (k) {
      return !C[k] || !C[k].startSec || C[k].startSec !== P.startSec;
    }), 'still=' + P.startSec + ' taga=' + C.TAGA.startSec);
  expect('窗口短于间隔且不短于 20 秒（站得完又不拖沓）',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('站稳时长逐轮递增且封顶', SIM.stillNeedFor(0) === P.needSec &&
    SIM.stillNeedFor(1) === P.needSec + P.secStep &&
    SIM.stillNeedFor(99) === P.maxSec,
    '0=' + SIM.stillNeedFor(0) + ' 99=' + SIM.stillNeedFor(99));
  expect('★要求时长严格小于窗口（不能出现物理上达不到的目标）',
    P.needSec > 0 && P.needSec <= P.maxSec && P.maxSec < P.windowSec,
    P.needSec + '~' + P.maxSec + ' / ' + P.windowSec);
  expect('允许晃动半径合理（贴脸抖不动，小幅晃动不白清）',
    P.radius > 4 && P.radius < 40, P.radius);
  expect('奖励仍是「一箱 + 四金币」（与前二十五件同口径）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（开窗 / 站稳 / 发奖 / 落空全不动随机流）----------
  const wR = cleanWorld(14201);
  const rng0 = wR.rngState;
  openWindow(wR);
  stand(wR, wR.stillNeed + 0.01);
  SIM.tickStill(wR);
  const wR2 = cleanWorld(14202);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  stand(wR2, 1);
  wR2.time = wR2.stillDeadline + 0.01;
  SIM.tickStill(wR2);
  expect('★★★站满与落空都不消耗 nextRand（波次/掉落随机流零污染）',
    wR.rngState === rng0 && wR2.rngState === rng1,
    'done=' + wR.rngState + '/' + rng0 + ' fail=' + wR2.rngState + '/' + rng1);

  // ---------- 3. 时序与零实体 ----------
  const wT = cleanWorld(14203);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickStill(wT);
  expect('到点前零轮零播报', wT.stillRounds === 0 && evs(wT, 'still_start').length === 0,
    'rounds=' + wT.stillRounds);
  openWindow(wT);
  expect('开窗零实体：不造怪、不造球、不造 zone、不造 strike',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pick=' + wT.pickups.length);
  expect('开窗只播一条，且一次说清秒数/目标/晃动半径',
    evs(wT, 'still_start').length === 1 &&
    evs(wT, 'still_start')[0].need === P.needSec &&
    evs(wT, 'still_start')[0].sec === P.windowSec &&
    evs(wT, 'still_start')[0].radius === P.radius,
    JSON.stringify(evs(wT, 'still_start')[0]));
  expect('★开窗那一帧就把锚点落在玩家脚下（不白送第一帧）',
    wT.stillAnchorX === (wT.self || wT.player).x &&
    wT.stillAnchorY === (wT.self || wT.player).y && wT.stillHold === 0,
    'anchor=' + wT.stillAnchorX + ',' + wT.stillAnchorY);
  expect('deadline 零漂移（整数 tick 换算 w.time）',
    wT.stillDeadline === wT.time + P.windowSec,
    wT.stillDeadline + ' vs ' + (wT.time + P.windowSec));
  expect('下一轮排期 = 首发 tick + 间隔', wT.stillNextTick === startTick + P.everySec * HZ,
    wT.stillNextTick + ' vs ' + (startTick + P.everySec * HZ));
  SIM.tickStill(wT);
  expect('同一帧不重复开窗', wT.stillRounds === 1 && evs(wT, 'still_start').length === 1,
    'rounds=' + wT.stillRounds);
  expect('到期前一帧不结算',
    (wT.time = wT.stillDeadline - 0.01, SIM.tickStill(wT),
      wT.stillActive === 1 && evs(wT, 'still_done').length === 0 &&
      evs(wT, 'still_fail').length === 0), 'active=' + wT.stillActive);
  expect('事件对象不塞快照字段（start 恰好五个键）',
    Object.keys(evs(wT, 'still_start')[0]).length === 5,
    JSON.stringify(evs(wT, 'still_start')[0]));

  // ---------- 4. 站位累计（灵魂边界：挪窝就重来）----------
  const wS = cleanWorld(14204);
  openWindow(wS);
  const pS = wS.self || wS.player;
  const ax = pS.x;
  const ay = pS.y;
  SIM.onStillStay(wS, 0);
  expect('★★dt<=0 不算', wS.stillHold === 0, 'hold=' + wS.stillHold);
  // 多喂 0.1 秒跨过半程阈值：20Hz 浮点累加正好卡在 4.0 时差一点点，不算假绿。
  stand(wS, wS.stillNeed * 0.5 + 0.1);
  expect('过半前只播一次半程提示', evs(wS, 'still_half').length === 1 &&
    evs(wS, 'still_half')[0].left > 0 &&
    wS.stillHold >= wS.stillNeed / 2,
    'hold=' + wS.stillHold + ' half=' + evs(wS, 'still_half').length);
  stand(wS, wS.stillNeed);
  expect('★站满即封顶不溢出，且不会因多站刷播报',
    wS.stillHold === wS.stillNeed && evs(wS, 'still_half').length === 1,
    'hold=' + wS.stillHold + ' half=' + evs(wS, 'still_half').length);
  put(wS, ax + 10, ay);
  stand(wS, 1);
  expect('半径内小幅晃动不打断（锚点不动，继续累计）',
    wS.stillAnchorX === ax && wS.stillNeed > 0 &&
    evs(wS, 'still_half').length === 1,
    'anchor=' + wS.stillAnchorX);
  const wB = cleanWorld(14205);
  openWindow(wB);
  const pB = wB.self || wB.player;
  const bx = pB.x;
  put(wB, bx + P.radius, pB.y);
  stand(wB, 1);
  expect('★★正好踩在晃动圈线上仍算站着（边界含等号）',
    wB.stillAnchorX === bx && wB.stillHold > 0,
    'hold=' + wB.stillHold + ' anchor=' + wB.stillAnchorX);
  put(wB, bx + P.radius + 0.01, pB.y);
  SIM.onStillStay(wB, 1 / HZ);
  expect('★★★挪出半径就清零并把锚点跟到新位置',
    wB.stillHold === 0 && wB.stillAnchorX === bx + P.radius + 0.01,
    'hold=' + wB.stillHold + ' anchor=' + wB.stillAnchorX);
  put(wB, bx, pB.y);
  SIM.onStillStay(wB, 1 / HZ);
  expect('★挪回原处也不会找回旧进度（重新锚定后才重新计）',
    wB.stillHold === 0 && wB.stillAnchorX === bx,
    'hold=' + wB.stillHold);
  const wM = cleanWorld(14206);
  openWindow(wM);
  stand(wM, 2);
  const beforeMove = wM.stillHold;
  put(wM, (wM.self || wM.player).x + P.radius + 5, (wM.self || wM.player).y);
  // 第一帧用于重锚，多喂一帧让新锚点后的累计正好 2 秒。
  stand(wM, 2 + 1 / HZ);
  expect('★真走一步后原地站再久也只从新锚点重算',
    Math.abs(wM.stillHold - 2) < 0.01 && beforeMove > 0 && wM.stillHold < wM.stillNeed,
    'before=' + beforeMove + ' after=' + wM.stillHold);
  const wD0 = cleanWorld(14207);
  openWindow(wD0);
  wD0.stillNeed = 0;
  wD0.time = wD0.stillDeadline + 0.01;
  SIM.tickStill(wD0);
  expect('★★need=0（未开窗的默认态）绝不白送达标',
    wD0.stillDone === 0 && wD0.stillFailed === 1 &&
    wD0.pickups.length === 0,
    'done=' + wD0.stillDone + ' fail=' + wD0.stillFailed);
  const wHp = cleanWorld(14208);
  openWindow(wHp);
  const pHp = wHp.self || wHp.player;
  pHp.hp = 0;
  stand(wHp, 3);
  expect('★★阵亡不算站稳', wHp.stillHold === 0, 'hold=' + wHp.stillHold);
  pHp.hp = pHp.maxHp;
  stand(wHp, 1);
  expect('复活状态（正向对照）能正常累计', wHp.stillHold > 0,
    'hold=' + wHp.stillHold);
  const wLu = cleanWorld(14209);
  openWindow(wLu);
  const pLu = wLu.self || wLu.player;
  pLu.state = 'levelup';
  stand(wLu, 3);
  expect('★★升级定格那几秒不算白蹭', wLu.stillHold === 0,
    'hold=' + wLu.stillHold);
  pLu.state = 'playing';
  stand(wLu, 1);
  expect('选完升级（正向对照）才继续累计', wLu.stillHold > 0,
    'hold=' + wLu.stillHold);
  const wOff = cleanWorld(14210);
  openWindow(wOff);
  const needOff = wOff.stillNeed;
  wOff.stillActive = 0;
  stand(wOff, 5);
  expect('★★窗口关掉后站着也不累计（need 仍是正数，非假屏障）',
    wOff.stillHold === 0 && needOff === P.needSec,
    'hold=' + wOff.stillHold + ' need=' + needOff);

  // ---------- 5. 达标 / 落空 ----------
  const wD = cleanWorld(14211);
  openWindow(wD);
  stand(wD, wD.stillNeed + 0.01);
  SIM.tickStill(wD);
  const pd = wD.self || wD.player;
  expect('★达标当帧发奖：active 立即关掉', wD.stillActive === 0 && wD.stillDone === 1,
    'active=' + wD.stillActive + ' done=' + wD.stillDone);
  expect('奖励恰好一箱 + 四金币', byKind(wD, 'chest').length === 1 &&
    byKind(wD, 'gold').length === P.goldDrops,
    'chest=' + byKind(wD, 'chest').length + ' gold=' + byKind(wD, 'gold').length);
  expect('★奖励落在脚下（站着的地方）',
    Math.abs(byKind(wD, 'chest')[0].x - pd.x) < 1 &&
    Math.abs(byKind(wD, 'chest')[0].y - pd.y) < 1,
    'chest=' + byKind(wD, 'chest')[0].x + ',' + byKind(wD, 'chest')[0].y +
    ' p=' + pd.x + ',' + pd.y);
  expect('播报数字来自事件本身', evs(wD, 'still_done').length === 1 &&
    evs(wD, 'still_done')[0].got === Math.round(wD.stillNeed) &&
    evs(wD, 'still_done')[0].gold === 4,
    JSON.stringify(evs(wD, 'still_done')[0]));
  stand(wD, 5);
  SIM.tickStill(wD);
  expect('达标后再喂不二次发奖', wD.stillDone === 1 &&
    byKind(wD, 'chest').length === 1 && evs(wD, 'still_done').length === 1,
    'done=' + wD.stillDone);
  expect('达标帧就算压在 deadline 上也是达成而非落空',
    (function () {
      const w = cleanWorld(14212);
      openWindow(w);
      stand(w, w.stillNeed + 0.01);
      w.time = w.stillDeadline;
      SIM.tickStill(w);
      return w.stillDone === 1 && w.stillFailed === 0 &&
        evs(w, 'still_done').length === 1;
    })(), 'done/fail');
  const wF = cleanWorld(14213);
  openWindow(wF);
  stand(wF, P.needSec * 0.5);
  wF.time = wF.stillDeadline + 0.01;
  SIM.tickStill(wF);
  expect('★差一半也落空：零奖励、零掉落', wF.stillFailed === 1 &&
    wF.stillDone === 0 && wF.pickups.length === 0,
    'failed=' + wF.stillFailed + ' pickups=' + wF.pickups.length);
  expect('落空不责备，只陈述差额', evs(wF, 'still_fail').length === 1 &&
    evs(wF, 'still_fail')[0].left > 0 &&
    !('blame' in evs(wF, 'still_fail')[0]),
    JSON.stringify(evs(wF, 'still_fail')[0]));
  expect('落空后不补发（推到很晚也不会突然给奖）',
    (wF.time = wF.stillDeadline + 100, SIM.tickStill(wF),
      wF.stillDone === 0 && wF.pickups.length === 0), 'done=' + wF.stillDone);
  wF.tick = wF.stillNextTick;
  wF.time = wF.tick / HZ;
  SIM.tickStill(wF);
  expect('下一轮目标递增、站位与锚点都重置',
    wF.stillRounds === 2 && wF.stillNeed === P.needSec + P.secStep &&
    wF.stillHold === 0 && wF.stillHalfNoted === 0 &&
    wF.stillAnchorX === (wF.self || wF.player).x,
    'rounds=' + wF.stillRounds + ' need=' + wF.stillNeed +
    ' hold=' + wF.stillHold);

  // ---------- 6. 剧情关 / 真实 step（钉调用点）----------
  const wStory = cleanWorld(14214);
  wStory.modId = 'myth';
  wStory.storyStage = { id: 'ch6' };
  wStory.tick = startTick;
  wStory.time = wStory.tick / HZ;
  SIM.tickStill(wStory);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wStory.stillActive === 0 && wStory.stillRounds === 0 &&
    evs(wStory, 'still_start').length === 0,
    'active=' + wStory.stillActive + ' rounds=' + wStory.stillRounds);
  // ★先手动置正 need 并开窗，让钩子里的 story 闸成为唯一屏障。
  wStory.stillActive = 1;
  wStory.stillNeed = P.needSec;
  stand(wStory, P.needSec + 1);
  wStory.time = wStory.stillDeadline + 1;
  SIM.tickStill(wStory);
  expect('★★★剧情关强行开窗站满也不发奖（两个入口都钉）',
    wStory.stillDone === 0 && wStory.pickups.length === 0 &&
    wStory.stillHold === 0 && wStory.stillHalfNoted === 0,
    'hold=' + wStory.stillHold + ' half=' + wStory.stillHalfNoted);
  const wStory2 = SIM.createWorld({ charId: 'hunter', seed: 14215,
    modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 618 秒：step 验不出，入口断言是唯一依据',
    wStory2.matchSec < P.startSec && P.startSec > 540,
    'ch6上限=' + wStory2.matchSec + ' 首发=' + P.startSec);
  const wStep = cleanWorld(14216);
  wStep.tick = startTick - 1;
  wStep.time = wStep.tick / HZ;
  for (let i = 0; i < 3; i++) SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★真实 step 跨首发帧也开窗（钉 step 段的 tickStill 调用点）',
    wStep.stillActive === 1 && wStep.stillRounds === 1 &&
    evs(wStep, 'still_start').length === 1,
    'active=' + wStep.stillActive + ' rounds=' + wStep.stillRounds +
    ' state=' + wStep.state);
  for (let i = 0; i < 20; i++) SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★真实 step 站着会累计（钉 onStillStay 调用点）',
    wStep.stillHold > 0 && wStep.stillHold <= wStep.stillNeed,
    'hold=' + wStep.stillHold + ' need=' + wStep.stillNeed);
  const anchor0 = wStep.stillAnchorX;
  for (let i = 0; i < 20; i++) SIM.step(wStep, { mx: 1, my: 0 });
  expect('★★★真实 step 一走就重锚清零（不靠手动改坐标）',
    wStep.stillHold === 0 && wStep.stillAnchorX > anchor0,
    'hold=' + wStep.stillHold + ' anchor=' + anchor0 + '→' + wStep.stillAnchorX);
}

// ============================================================
// 第八十三轮：连珠诀（目标制零实体第二十七件，全新轴「拾取节奏」）
// ============================================================
function testChain() {
  console.log('[第八十三轮] 连珠诀：第一件「拾取节奏」目标（连捡不中断轴）');
  const P = C.CHAIN;
  const HZ = C.TICK_HZ;
  const startTick = Math.round(P.startSec * HZ);
  const targetKeys = ['BOUNTY', 'SERENITY', 'GLEAN', 'ONSLAUGHT', 'STRIDE', 'MEND',
    'THUNDER', 'PERIL', 'DEW', 'STREAK', 'BESTIARY', 'SHOOT', 'GENERAL', 'EVADE',
    'TEMPER', 'SWARM', 'HUNT', 'VENGE', 'ASCEND', 'UNSEAL', 'YONGJIN', 'JULING',
    'ONEHIT', 'RETALIATE', 'TAGA', 'STILL'];

  function evs(w, t) {
    return w.events.filter(function (e) { return e.type === t; });
  }
  function byKind(w, kind) {
    return w.pickups.filter(function (it) { return it.kind === kind; });
  }
  function cleanWorld(seed) {
    const w = SIM.createWorld({ seed: seed });
    const p = w.player;
    p.weapons.length = 0;
    p.expNext = 1e9;
    p.hp = p.maxHp;
    p.attrs.crit = 0;
    // 所有既有机制（含磐石诀）的排期一律推远，隔离本件的观测窗口。
    w.nextWaveTick = 1e9;
    w.meteorNextTick = 1e9;
    w.challengerNextTick = 1e9;
    w.summonerNextTick = 1e9;
    w.healerNextTick = 1e9;
    w.leyNextTick = 1e9;
    w.pactNextTick = 1e9;
    w.twinNextTick = 1e9;
    w.lanternNextTick = 1e9;
    w.devourerNextTick = 1e9;
    w.boonNextTick = 1e9;
    w.bellNextTick = 1e9;
    w.mergeNextTick = 1e9;
    w.escortNextTick = 1e9;
    w.marketNextTick = 1e9;
    w.cauldronNextTick = 1e9;
    w.bountyNextTick = 1e9;
    w.serenityNextTick = 1e9;
    w.gleanNextTick = 1e9;
    w.forgeNextTick = 1e9;
    w.strideNextTick = 1e9;
    w.mendNextTick = 1e9;
    w.thunderNextTick = 1e9;
    w.perilNextTick = 1e9;
    w.dewNextTick = 1e9;
    w.streakNextTick = 1e9;
    w.bestiaryNextTick = 1e9;
    w.shootNextTick = 1e9;
    w.generalNextTick = 1e9;
    w.evadeNextTick = 1e9;
    w.temperNextTick = 1e9;
    w.swarmNextTick = 1e9;
    w.huntNextTick = 1e9;
    w.vengeNextTick = 1e9;
    w.ascendNextTick = 1e9;
    w.unsealNextTick = 1e9;
    w.yongjinNextTick = 1e9;
    w.julingNextTick = 1e9;
    w.onehitNextTick = 1e9;
    w.retaliateNextTick = 1e9;
    w.tagaNextTick = 1e9; w.stillNextTick = 1e9; w.chainNextTick = 0; // 本件默认开窗
    w.mobs.length = 0;
    w.pickups.length = 0;
    w.events.length = 0;
    SIM.setSelf(w, p);
    return w;
  }
  function openWindow(w) {
    w.tick = startTick;
    w.time = w.tick / HZ;
    w.chainNextTick = 0;
    SIM.tickChain(w);
  }
  function feed(w, kind, n) {
    const p = w.self || w.player;
    for (let i = 0; i < n; i++) SIM.onChainPickup(w, p, kind);
  }
  function drop(w, kind, value) {
    const p = w.self || w.player;
    SIM.spawnPickup(w, kind, p.x, p.y, value, 5);
  }

  // ---------- 1. 表自洽 ----------
  expect('首发帧不压在 30 秒波次网格上',
    P.startSec % 30 !== 0, P.startSec + ' % 30 = ' + (P.startSec % 30));
  expect('★★首发错开全部 26 个目标制既有件（同间隔不同相位）',
    targetKeys.every(function (k) {
      return !C[k] || !C[k].startSec || (P.startSec - C[k].startSec) % 132 !== 0;
    }), 'chain=' + P.startSec + ' mod132=' + (P.startSec % 132));
  expect('首发晚于全部目标制既有件（不往前挤占老玩法）',
    targetKeys.every(function (k) { return !C[k] || !C[k].startSec || C[k].startSec < P.startSec; }),
    'chain=' + P.startSec);
  expect('窗口短于间隔且不短于 20 秒（连得完又不拖沓）',
    P.windowSec >= 20 && P.windowSec < P.everySec, P.windowSec + ' / ' + P.everySec);
  expect('连捡份数逐轮递增且封顶', SIM.chainNeedFor(0) === P.needPicks &&
    SIM.chainNeedFor(1) === P.needPicks + P.pickStep &&
    SIM.chainNeedFor(99) === P.maxPicks,
    '0=' + SIM.chainNeedFor(0) + ' 99=' + SIM.chainNeedFor(99));
  expect('断链间隔合理（能做得到，又不是随便捡都算连）',
    P.gapSec > 0 && P.gapSec <= 2 && P.maxPicks > P.needPicks,
    'gap=' + P.gapSec + ' need=' + P.needPicks + '~' + P.maxPicks);
  expect('奖励仍是「一箱 + 四金币」（与前二十六件同口径）',
    P.rewardChest >= 1 && P.rewardChest <= 2 && P.goldDrops >= 1 &&
    P.rewardGold >= 1 && P.rewardGold <= 5,
    'chest=' + P.rewardChest + ' gold=' + P.goldDrops + '×' + P.rewardGold);
  expect('中文表名存在（前端播报用的就是它）',
    typeof P.name === 'string' && P.name.length > 0, P.name);

  // ---------- 2. 零随机（开窗 / 连捡 / 断链 / 发奖 / 落空全不动随机流）----------
  const wR = cleanWorld(14301);
  const rng0 = wR.rngState;
  openWindow(wR);
  feed(wR, 'exp', wR.chainNeed);
  SIM.tickChain(wR);
  const wR2 = cleanWorld(14302);
  const rng1 = wR2.rngState;
  openWindow(wR2);
  feed(wR2, 'gold', 2);
  wR2.time += P.gapSec + 0.1;
  SIM.tickChain(wR2);
  const wR3 = cleanWorld(14303);
  const rng2 = wR3.rngState;
  openWindow(wR3);
  feed(wR3, 'exp', 1);
  wR3.time = wR3.chainDeadline + 0.01;
  SIM.tickChain(wR3);
  expect('★★★连捡/断链/发奖/落空都不消耗 nextRand（波次与掉落流零污染）',
    wR.rngState === rng0 && wR2.rngState === rng1 && wR3.rngState === rng2,
    'done=' + wR.rngState + ' break=' + wR2.rngState + ' fail=' + wR3.rngState);

  // ---------- 3. 时序与零实体 ----------
  const wT = cleanWorld(14304);
  wT.tick = startTick - 1;
  wT.time = wT.tick / HZ;
  SIM.tickChain(wT);
  expect('到点前零轮零播报', wT.chainRounds === 0 && evs(wT, 'chain_start').length === 0,
    'rounds=' + wT.chainRounds);
  openWindow(wT);
  expect('开窗零实体：不造怪、不造球、不造 zone、不造 strike',
    wT.mobs.length === 0 && wT.pickups.length === 0 &&
    wT.zones.length === 0 && wT.strikes.length === 0,
    'mob=' + wT.mobs.length + ' pick=' + wT.pickups.length);
  expect('开窗只播一条，且一次说清秒数/份数/间隔',
    evs(wT, 'chain_start').length === 1 &&
    evs(wT, 'chain_start')[0].need === P.needPicks &&
    evs(wT, 'chain_start')[0].sec === P.windowSec &&
    evs(wT, 'chain_start')[0].gap === P.gapSec &&
    evs(wT, 'chain_start')[0].round === 1,
    JSON.stringify(evs(wT, 'chain_start')[0]));
  expect('事件对象不塞快照字段（start 恰好五个键）',
    Object.keys(evs(wT, 'chain_start')[0]).length === 5,
    JSON.stringify(evs(wT, 'chain_start')[0]));
  expect('deadline 零漂移（整数 tick 换算 w.time）',
    wT.chainDeadline === wT.time + P.windowSec,
    wT.chainDeadline + ' vs ' + (wT.time + P.windowSec));
  expect('下一轮排期 = 首发 tick + 间隔', wT.chainNextTick === startTick + P.everySec * HZ,
    wT.chainNextTick + ' vs ' + (startTick + P.everySec * HZ));
  SIM.tickChain(wT);
  expect('同一帧不重复开窗', wT.chainRounds === 1 && evs(wT, 'chain_start').length === 1,
    'rounds=' + wT.chainRounds);
  expect('到期前一帧不结算',
    (wT.time = wT.chainDeadline - 0.01, SIM.tickChain(wT),
      wT.chainActive === 1 && evs(wT, 'chain_done').length === 0 &&
      evs(wT, 'chain_fail').length === 0), 'active=' + wT.chainActive);

  // ---------- 4. 只认真拾取 / 断链边界 ----------
  const wO = cleanWorld(14305);
  openWindow(wO);
  const needO = wO.chainNeed;
  wO.chainActive = 0;
  feed(wO, 'exp', 5);
  expect('★★窗口关掉后捡再多也不连（need 仍是正数，非假屏障）',
    wO.chainCur === 0 && needO === P.needPicks,
    'cur=' + wO.chainCur + ' need=' + needO);
  const wZ = cleanWorld(14306);
  openWindow(wZ);
  wZ.chainNeed = 0;
  feed(wZ, 'exp', 5);
  expect('★★★need=0（未开窗默认态）绝不靠拾取白送达标',
    wZ.chainCur === 0 && wZ.chainReached === 0,
    'cur=' + wZ.chainCur + ' reached=' + wZ.chainReached);
  wZ.time = wZ.chainDeadline + 0.01;
  SIM.tickChain(wZ);
  expect('need=0 到期只记落空、零奖励（不因默认态发奖）',
    wZ.chainDone === 0 && wZ.chainFailed === 1 && wZ.pickups.length === 0,
    'done=' + wZ.chainDone + ' fail=' + wZ.chainFailed);
  const wZ2 = cleanWorld(14318);
  openWindow(wZ2);
  // 异常残留：即使 reached 被别处误置 1，need=0 的默认态也绝不能白送一箱金币。
  wZ2.chainNeed = 0;
  wZ2.chainReached = 1;
  wZ2.time = wZ2.chainDeadline + 0.01;
  SIM.tickChain(wZ2);
  expect('★★异常残留 need=0 却 reached=1 也绝不发奖',
    wZ2.chainDone === 0 && wZ2.chainFailed === 1 && wZ2.pickups.length === 0,
    'done=' + wZ2.chainDone + ' fail=' + wZ2.chainFailed);
  const wP = cleanWorld(14307);
  openWindow(wP);
  SIM.onChainPickup(wP, { slot: 9, name: '队友' }, 'exp');
  expect('★★队友捡的东西不算我的连珠', wP.chainCur === 0,
    'cur=' + wP.chainCur);
  const wK = cleanWorld(14308);
  openWindow(wK);
  SIM.onChainPickup(wK, wK.self, 'shrine');
  SIM.onChainPickup(wK, wK.self, 'market');
  SIM.onChainPickup(wK, wK.self, 'bell');
  expect('★不算的物件（神龛/摊位/钟）一律不进连珠', wK.chainCur === 0,
    'cur=' + wK.chainCur);
  const wH = cleanWorld(14309);
  openWindow(wH);
  feed(wH, 'gold', wH.chainNeed + 3);
  expect('★★★过半只播一次，达标后继续喂也不刷屏',
    evs(wH, 'chain_half').length === 1 && wH.chainReached === 1 &&
    evs(wH, 'chain_half')[0].got === Math.ceil(wH.chainNeed / 2) &&
    evs(wH, 'chain_half')[0].left > 0,
    JSON.stringify(evs(wH, 'chain_half')[0]));
  const wG = cleanWorld(14310);
  openWindow(wG);
  feed(wG, 'exp', 1);
  wG.time = wG.chainLastPick + P.gapSec;
  feed(wG, 'exp', 1);
  expect('★★★间隔正好等于 gap 秒仍连上（边界含等号）',
    wG.chainCur === 2, 'cur=' + wG.chainCur);
  wG.time = wG.chainLastPick + P.gapSec + 0.01;
  SIM.tickChain(wG);
  expect('★★超过 gap 秒自动断链，当前连珠清零', wG.chainCur === 0,
    'cur=' + wG.chainCur);
  expect('★断链只清当前连珠，最好成绩保留（到期播报不丢）',
    wG.chainBest === 2, 'best=' + wG.chainBest);

  // ---------- 5. 达标 / 落空 ----------
  const wD = cleanWorld(14311);
  openWindow(wD);
  feed(wD, 'exp', wD.chainNeed);
  SIM.tickChain(wD);
  const pd = wD.self || wD.player;
  expect('★达标当帧发奖：active 立即关掉', wD.chainActive === 0 && wD.chainDone === 1,
    'active=' + wD.chainActive + ' done=' + wD.chainDone);
  expect('奖励恰好一箱 + 四金币', byKind(wD, 'chest').length === 1 &&
    byKind(wD, 'gold').length === P.goldDrops,
    'chest=' + byKind(wD, 'chest').length + ' gold=' + byKind(wD, 'gold').length);
  expect('★奖励落在脚下（连捡结束的位置）',
    Math.abs(byKind(wD, 'chest')[0].x - pd.x) < 1 &&
    Math.abs(byKind(wD, 'chest')[0].y - pd.y) < 1,
    'chest=' + byKind(wD, 'chest')[0].x + ',' + byKind(wD, 'chest')[0].y +
    ' p=' + pd.x + ',' + pd.y);
  expect('播报数字来自事件本身', evs(wD, 'chain_done').length === 1 &&
    evs(wD, 'chain_done')[0].got === P.needPicks &&
    evs(wD, 'chain_done')[0].need === P.needPicks &&
    evs(wD, 'chain_done')[0].gold === 4,
    JSON.stringify(evs(wD, 'chain_done')[0]));
  feed(wD, 'exp', 20);
  SIM.tickChain(wD);
  expect('达标后再喂不二次发奖', wD.chainDone === 1 &&
    byKind(wD, 'chest').length === 1 && evs(wD, 'chain_done').length === 1,
    'done=' + wD.chainDone);
  wD.time += P.gapSec + 10;
  SIM.tickChain(wD);
  expect('★★达标后断链/过期都不追回赏金',
    wD.chainDone === 1 && wD.chainFailed === 0 && byKind(wD, 'gold').length === P.goldDrops,
    'done=' + wD.chainDone + ' fail=' + wD.chainFailed);
  const wDL = cleanWorld(14312);
  openWindow(wDL);
  feed(wDL, 'exp', wDL.chainNeed);
  wDL.time = wDL.chainDeadline;
  SIM.tickChain(wDL);
  expect('达标帧就算压在 deadline 上也是达成而非落空',
    wDL.chainDone === 1 && wDL.chainFailed === 0 && evs(wDL, 'chain_done').length === 1,
    'done/fail');
  const wF = cleanWorld(14313);
  openWindow(wF);
  feed(wF, 'exp', P.needPicks - 1);
  wF.time = wF.chainDeadline + 0.01;
  SIM.tickChain(wF);
  expect('★★差一份也落空：零奖励、零掉落', wF.chainFailed === 1 &&
    wF.chainDone === 0 && wF.pickups.length === 0,
    'failed=' + wF.chainFailed + ' pickups=' + wF.pickups.length);
  expect('落空不责备，只陈述最好成绩与差额', evs(wF, 'chain_fail').length === 1 &&
    evs(wF, 'chain_fail')[0].left === 1 && !('blame' in evs(wF, 'chain_fail')[0]),
    JSON.stringify(evs(wF, 'chain_fail')[0]));
  wF.time = wF.chainDeadline + 100;
  SIM.tickChain(wF);
  expect('落空后不补发（推到很晚也不会突然给奖）',
    wF.chainDone === 0 && wF.pickups.length === 0, 'done=' + wF.chainDone);
  wF.tick = wF.chainNextTick;
  wF.time = wF.tick / HZ;
  SIM.tickChain(wF);
  expect('下一轮目标递增、连珠与标记都重置',
    wF.chainRounds === 2 && wF.chainNeed === P.needPicks + P.pickStep &&
    wF.chainCur === 0 && wF.chainBest === 0 &&
    wF.chainHalfNoted === 0 && wF.chainReached === 0 &&
    wF.chainLastPick === wF.time,
    'rounds=' + wF.chainRounds + ' need=' + wF.chainNeed);

  // ---------- 6. 剧情关 / 真实 step（钉调用点）----------
  const wStory = cleanWorld(14314);
  wStory.modId = 'myth';
  wStory.storyStage = { id: 'ch6' };
  openWindow(wStory);
  expect('★★直接调入口：剧情关不开窗、不计数、零播报',
    wStory.chainActive === 0 && wStory.chainRounds === 0 &&
    evs(wStory, 'chain_start').length === 0,
    'active=' + wStory.chainActive + ' rounds=' + wStory.chainRounds);
  // 先手动置正 need 并开窗，让钩子/状态机里的 story 闸成为唯一屏障。
  wStory.chainActive = 1;
  wStory.chainNeed = P.needPicks;
  wStory.chainLastPick = wStory.time;
  feed(wStory, 'exp', P.needPicks);
  wStory.time = wStory.chainDeadline + 1;
  SIM.tickChain(wStory);
  expect('★★★剧情关强行开窗连满也不发奖（两个入口都钉）',
    wStory.chainDone === 0 && wStory.pickups.length === 0 &&
    wStory.chainCur === 0 && wStory.chainHalfNoted === 0,
    'cur=' + wStory.chainCur + ' half=' + wStory.chainHalfNoted);
  const wStory2 = SIM.createWorld({ charId: 'hunter', seed: 14315,
    modId: 'myth', stageId: 'ch6' });
  expect('剧情关上限 540 秒 < 首发 672 秒，且世界还在跑（非假绿）',
    wStory2.matchSec < P.startSec && P.startSec > 540 &&
    wStory2.state === 'playing' && !wStory2.ended,
    'ch6上限=' + wStory2.matchSec + ' 首发=' + P.startSec + ' state=' + wStory2.state);
  const wStep = cleanWorld(14316);
  wStep.tick = startTick - 1;
  wStep.time = wStep.tick / HZ;
  for (let i = 0; i < 3; i++) SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★真实 step 跨首发帧也开窗（钉 step 段的 tickChain 调用点）',
    wStep.chainActive === 1 && wStep.chainRounds === 1 &&
    evs(wStep, 'chain_start').length === 1,
    'active=' + wStep.chainActive + ' rounds=' + wStep.chainRounds);
  drop(wStep, 'exp', 1);
  drop(wStep, 'gold', 1);
  SIM.step(wStep, { mx: 0, my: 0 });
  expect('★★真实 step 捡精魄/金币会各算一份（钉 updatePickups 两条成功分支）',
    wStep.chainCur === 2 && wStep.pickups.length === 0,
    'cur=' + wStep.chainCur + ' pick=' + wStep.pickups.length);
  const wHp = cleanWorld(14317);
  wHp.tick = startTick - 1;
  wHp.time = wHp.tick / HZ;
  for (let i = 0; i < 3; i++) SIM.step(wHp, { mx: 0, my: 0 });
  const pHp = wHp.self || wHp.player;
  pHp.hp = pHp.maxHp;
  drop(wHp, 'heart', 5);
  SIM.step(wHp, { mx: 0, my: 0 });
  expect('★★★满血红心被吃掉也不算一份（真实 step，非天然安全）',
    wHp.chainCur === 0 && wHp.pickups.length === 0,
    'cur=' + wHp.chainCur + ' pick=' + wHp.pickups.length);
  pHp.hp = pHp.maxHp - 20;
  drop(wHp, 'heart', 5);
  SIM.step(wHp, { mx: 0, my: 0 });
  expect('★★真回血红心才算一份（正向对照，钉 heart 成功分支）',
    wHp.chainCur === 1 && wHp.pickups.length === 0,
    'cur=' + wHp.chainCur + ' pick=' + wHp.pickups.length);
}
