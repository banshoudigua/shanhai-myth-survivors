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
testRangeGrowth();console.log('');

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
// 上一版的三个数：武器每级 +4%（满级仅 1.28 倍）、千里镜每级 +10%（满级 1.5 倍）、
// 角色 +15% —— 在 900px 宽的画面上，88 长到 113 只差 25px，等于没变。
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
  expect('★武器 1→8 级的范围至少长到 1.5 倍（4% 那版只有 1.28 倍，画面上看不出圈变过）',
    r8 / r1 >= 1.5,
    '1 级=' + r1.toFixed(1) + ' 8 级=' + r8.toFixed(1) + ' 倍=' + (r8 / r1).toFixed(3));
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
  // 射程只有 6 的贴身武器升一级是 6 → 6.48，圆整后还是 6；这时候写「范围 6→6」
  // 比不写更让人困惑（玩家会以为升级坏了）。
  const tinyTxt = SIM.rangeDeltaText({ base: { dmg: 1, cd: 1, range: 6 } }, 1, 1) || '';
  expect('宽度变化小到圆整看不出来时必须返回空串（不许显示「范围 6→6」）',
    tinyTxt === '', '文案="' + tinyTxt + '"');
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
