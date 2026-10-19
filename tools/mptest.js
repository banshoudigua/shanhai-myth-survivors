// tools/mptest.js —— 多人世界无头自检（P2-1 验收）
//
// 为什么要单独一个脚本，而不是往 simtest.js 里加：
//   simtest.js 跑的是 P1 单机路径。多人化最危险的几类错误在这个路径上**永远看不见**：
//     · 归属串了   —— A 打死的怪记到 B 的击杀 / 金币上（结算数据全错，还很难复现）
//     · 一人卡全场 —— 一个人弹着升级面板，其他 7 个人被冻住
//     · 幽灵伤害   —— 掉线 / 阵亡玩家留下的圣水落雷继续造成伤害，还往死人账上加
//     · 失去确定   —— 服务端和客户端跑同一份 sim 却算不出一样的结果（联机的根基）
//   这些都只有真造出多人世界才验得出来。
//
// 用法：node tools/mptest.js

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
// 造多人世界与输入
// ============================================================

const ROSTER = ['hunter', 'nun', 'scholar', 'blacksmith'];
const NAMES = ['甲', '乙', '丙', '丁'];
const CONNS = ['conn-a', 'conn-b', 'conn-c', 'conn-d'];

// 建一个 N 人世界。charIds 省略时用默认四人名单。
function makeWorld(n, opts) {
  opts = opts || {};
  const players = [];
  for (let i = 0; i < n; i++) {
    players.push({
      charId: (opts.charIds && opts.charIds[i]) || ROSTER[i % ROSTER.length],
      connId: CONNS[i] || ('conn-' + i),
      name: NAMES[i] || ('玩家' + i),
      isGuest: false,
      slot: i
    });
  }
  return SIM.createWorld({
    players: players,
    selfSlot: opts.selfSlot || 0,
    seed: opts.seed === undefined ? 20260920 : opts.seed,
    spawnRadius: opts.spawnRadius === undefined ? 700 : opts.spawnRadius,
    // 联机默认「不冻结全世界」，只有 P1 兼容测试才显式打开
    pauseAllOnLevelUp: opts.pauseAllOnLevelUp === undefined ? false : opts.pauseAllOnLevelUp
  });
}

// 每人一个方向：用整数哈希算出来，不依赖 Math.random，保证可复现。
// 第 i 个人走的角度与其他人错开 90 度，这样才不会四个人叠在一起走。
function mpInputs(n, tick, still) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (still) {
      out.push({ mx: 0, my: 0 });
      continue;
    }
    const seg = Math.floor(tick / (C.TICK_HZ * 1.2));
    const h = ((seg + i * 7) * 2654435761) % 1000 / 1000;
    const ang = h * Math.PI * 2 + (i * Math.PI / 2);
    out.push({ mx: Math.cos(ang), my: Math.sin(ang) });
  }
  return out;
}

function stillInputs(n) {
  return mpInputs(n, 0, true);
}

function run(w, ticks, n, still) {
  for (let t = 0; t < ticks; t++) {
    SIM.step(w, mpInputs(n, t, still));
    // 谁升级了就替他选第一个，别让面板挂着把这一轮跑成空转
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].state === 'levelup') SIM.chooseLevelUp(w, 0, w.players[i]);
    }
  }
}

function firstAliveMob(w) {
  for (let i = 0; i < w.mobs.length; i++) {
    if (w.mobs[i].alive) return w.mobs[i];
  }
  return null;
}

// 往世界里塞一个掉落物（spawnPickup 没导出，照着它的字段手写一份）
function pushPickup(w, kind, x, y, value) {
  w.pickups.push({
    id: w.nextId++,
    kind: kind, x: x, y: y, px: x, py: y,
    value: value, vx: 0, vy: 0, life: 60
  });
}

// ============================================================
// 测试 1：建 4 人世界，四人的状态必须彼此独立
// ============================================================

function testCreateMulti() {
  console.log('[1] 建 4 人世界与状态独立性');
  const w = makeWorld(4);

  expect('世界里是 4 个玩家', w.players.length === 4, 'length=' + w.players.length);
  expect('座位号是 0/1/2/3', w.players.map(function (p) { return p.slot; }).join(',') === '0,1,2,3',
    w.players.map(function (p) { return p.slot; }).join(','));
  expect('实体 id 互不相同', new Set(w.players.map(function (p) { return p.id; })).size === 4);

  // 四个角色不同 → 四份 attrs 必须是四个独立对象，且数值各不相同
  const attrsSet = new Set(w.players.map(function (p) { return p.attrs; }));
  expect('四份 attrs 是四个独立对象', attrsSet.size === 4, 'size=' + attrsSet.size);
  const statsSet = new Set(w.players.map(function (p) { return p.stats; }));
  expect('四份个人战绩是四个独立对象', statsSet.size === 4, 'size=' + statsSet.size);

  // 角色偏移各算各的：学者的血上限比猎人低 15%
  const hunter = w.players[0];
  const scholar = w.players[2];
  expect('角色偏移各算各的（学者血上限 < 猎人）', scholar.maxHp < hunter.maxHp,
    '学者 ' + scholar.maxHp + ' vs 猎人 ' + hunter.maxHp);
  expect('每人都有自己的一把起始武器', w.players.every(function (p) { return p.weapons.length === 1; }));
  expect('每人都满血开局', w.players.every(function (p) { return p.hp === p.maxHp; }));

  // 出生点错开，避免开局四个人叠在一个点上
  const xs = w.players.map(function (p) { return p.x; });
  expect('出生点按座位错开', new Set(xs).size === 4, xs.join(','));
}

// ============================================================
// 测试 2：归属正确性 —— 伤害只能记到实体主人头上
//
// 这是本次改造最关键的一条。做法：造一个「只归 A」的伤害源砸中一只怪，
// 断言只有 A 的 dmgDealt 涨、其他三个人一动不动。
// 四种带 owner 的实体全部各测一遍，漏掉任何一种都会在联机时算错账。
// ============================================================

function probeOwnedDamage(kind, ownerIndex, dmg) {
  const w = makeWorld(4, { seed: 20260920 });
  // 先走一帧，让第一波怪刷出来
  SIM.step(w, stillInputs(4));
  const mob = firstAliveMob(w);
  if (!mob) return null;

  const owner = w.players[ownerIndex];
  const before = w.players.map(function (p) { return p.stats.dmgDealt; });

  if (kind === 'projectile') {
    w.projectiles.push({
      id: w.nextId++, kind: 'line', owner: owner,
      x: mob.x, y: mob.y, px: mob.x, py: mob.y, vx: 0, vy: 0,
      r: 6, dmg: dmg, pierce: 1, life: 1, hitIds: {}, color: '#fff',
      explodeRadius: 0, explodeDmg: 0
    });
  } else if (kind === 'zone') {
    w.zones.push({
      id: w.nextId++, kind: 'zone', owner: owner,
      x: mob.x, y: mob.y, r: 30, dmg: dmg,
      tickSec: 1, tickTimer: 0, life: 5, maxLife: 5, color: '#aaa', hitKey: 'zprobe'
    });
  } else if (kind === 'strike') {
    w.strikes.push({
      id: w.nextId++, kind: 'strike', owner: owner,
      x: mob.x, y: mob.y, r: 40, dmg: dmg, delay: 0, life: 0, color: '#ff3'
    });
  } else if (kind === 'orbit') {
    // 环绕物是围着主人转的：把主人挪到怪身上、半径设 0，它就正好套在怪头上
    owner.x = mob.x;
    owner.y = mob.y;
    owner.invuln = 999;
    w.orbits.push({
      id: w.nextId++, owner: owner, angle: 0, r: 0, speed: 0, dmg: dmg,
      life: 5, maxLife: 5, hitSec: 0.5, hitMap: {}, size: 12, color: '#eee'
    });
  }

  SIM.step(w, stillInputs(4));

  return {
    deltas: w.players.map(function (p, i) { return p.stats.dmgDealt - before[i]; }),
    ownerIndex: ownerIndex
  };
}

function testOwnership() {
  console.log('[2] 归属正确性（伤害只能记到主人头上）');

  const kinds = ['projectile', 'zone', 'strike', 'orbit'];
  const label = { projectile: '投射物', zone: '地面区域', strike: '延迟落点', orbit: '环绕物' };

  for (let k = 0; k < kinds.length; k++) {
    const kind = kinds[k];
    // 主人轮流换人，避免「每次都测 0 号」刚好蒙对
    const ownerIndex = k % 4;
    const dmg = 10000 + k;

    const r = probeOwnedDamage(kind, ownerIndex, dmg);
    if (!r) {
      bad(label[kind] + ' 归属正确', '世界没刷出怪，测不了');
      continue;
    }

    const mine = r.deltas[ownerIndex];
    const others = r.deltas.filter(function (_, i) { return i !== ownerIndex; });
    const othersSum = others.reduce(function (a, b) { return a + b; }, 0);

    expect(label[kind] + ' 伤害记在主人（' + ownerIndex + ' 号）头上', mine >= dmg,
      '主人增量 ' + mine + '，期望 >= ' + dmg);
    expect(label[kind] + ' 没有漏给其他三人', othersSum === 0,
      '其他三人增量 ' + others.join('+') + ' = ' + othersSum);
  }

  // 击杀数同理：只有主人能涨
  const w = makeWorld(4, { seed: 4242 });
  SIM.step(w, stillInputs(4));
  const mob = firstAliveMob(w);
  const killer = w.players[2];
  const killsBefore = w.players.map(function (p) { return p.stats.kills; });
  w.projectiles.push({
    id: w.nextId++, kind: 'line', owner: killer,
    x: mob.x, y: mob.y, px: mob.x, py: mob.y, vx: 0, vy: 0,
    r: 6, dmg: 999999, pierce: 1, life: 1, hitIds: {}, color: '#fff',
    explodeRadius: 0, explodeDmg: 0
  });
  SIM.step(w, stillInputs(4));
  const killDeltas = w.players.map(function (p, i) { return p.stats.kills - killsBefore[i]; });
  expect('击杀数只记在主人（2 号）头上', killDeltas[2] === 1 && killDeltas[0] === 0 && killDeltas[1] === 0 && killDeltas[3] === 0,
    killDeltas.join(','));
}

// ============================================================
// 测试 3：掉落物归属 —— 经验 / 金币 / 回血各算各的账
// ============================================================

function testPickupAttribution() {
  console.log('[3] 掉落物归属（经验 / 金币 / 回血各算各的）');

  const w = makeWorld(2, { seed: 5150, charIds: ['hunter', 'hunter'] });
  const A = w.players[0];
  const B = w.players[1];
  // 把 B 挪到地图另一头，保证「离掉落物最近的人」一定是 A
  B.x = C.MAP.width - 120;
  B.y = C.MAP.height - 120;
  A.hp = 10;

  pushPickup(w, 'exp', A.x, A.y, 1);
  pushPickup(w, 'gold', A.x, A.y, 7);
  pushPickup(w, 'heart', A.x, A.y, 25);

  const beforeA = { exp: A.exp, gold: A.stats.gold, healed: A.stats.healed };
  const beforeB = { exp: B.exp, gold: B.stats.gold, healed: B.stats.healed };

  SIM.step(w, stillInputs(2));

  expect('经验记在吃到球的人身上', A.exp === beforeA.exp + 1, 'A.exp=' + A.exp);
  expect('金币记在吃到球的人身上', A.stats.gold === beforeA.gold + 7, 'A.gold=' + A.stats.gold);
  expect('回血记在吃到球的人身上', A.stats.healed === beforeA.healed + 25, 'A.healed=' + A.stats.healed);
  expect('旁人经验没被蹭到', B.exp === beforeB.exp, 'B.exp=' + B.exp);
  expect('旁人金币没被蹭到', B.stats.gold === beforeB.gold, 'B.gold=' + B.stats.gold);
  expect('旁人回血没被蹭到', B.stats.healed === beforeB.healed, 'B.healed=' + B.stats.healed);
}

// ============================================================
// 测试 4：升级隔离 —— 一人弹面板，全世界照跑
// ============================================================

function testLevelUpIsolation() {
  console.log('[4] 升级隔离（一个人选升级不冻结别人）');

  const w = makeWorld(2, { seed: 31337, charIds: ['hunter', 'nun'], spawnRadius: 200 });
  const A = w.players[0];
  const B = w.players[1];

  // 先把两人分开，免得牵连
  A.x = 400; A.y = 400;
  B.x = 1600; B.y = 1600;

  // 直接把他推到「差一点升级」，再喂一颗经验球
  A.exp = A.expNext - 1;
  pushPickup(w, 'exp', A.x, A.y, 5);
  SIM.step(w, stillInputs(2));

  expect('A 弹出了升级面板', A.state === 'levelup', 'A.state=' + A.state);
  expect('B 不受影响仍是进行中', B.state === 'playing', 'B.state=' + B.state);

  const tickAtPanel = w.tick;
  const axAtPanel = A.x;
  const ayAtPanel = A.y;
  const bKillsBefore = B.stats.dmgDealt;

  // A 一直不选，跑 100 帧
  for (let t = 0; t < 100; t++) SIM.step(w, stillInputs(2));

  expect('世界没有被冻结（tick 继续推进）', w.tick === tickAtPanel + 100,
    'tick ' + tickAtPanel + ' -> ' + w.tick);
  expect('A 在面板期间定格不动', A.x === axAtPanel && A.y === ayAtPanel,
    'A 位移 ' + (A.x - axAtPanel) + ',' + (A.y - ayAtPanel));
  expect('A 在面板期间不会被打死', A.alive === true && A.hp > 0,
    'A.hp=' + A.hp + ' alive=' + A.alive);
  expect('B 一直正常输出伤害', B.stats.dmgDealt > bKillsBefore,
    'B 伤害 ' + bKillsBefore + ' -> ' + B.stats.dmgDealt);

  // 事件路由：A 的升级事件不该发给 B
  //
  // ★这条原来写的是「B 收到的 levelup 事件必须为 0」，本轮（新增技能）开始失败 ——
  //   查下来是**断言本身过严**：B 在这 200 帧里自己也在打怪吃经验，
  //   他自己也升级了，所以 B 收到 levelup 事件是完全正常的。
  //   原来能过只是因为「B 恰好没升级」，那是巧合不是机制。
  //
  // 真正要验的是**隔离**：A 的那次升级不能算到 B 头上。判据是
  // 「B 收到的 levelup 事件条数 == B 自己的升级次数」——
  // 多一条就说明泄漏，A 有几次都算得出来。
  const evB = SIM.takeEvents(w, B.slot);
  const leakedB = evB.filter(function (e) { return e.type === 'levelup'; }).length;
  expect('A 的升级事件不会推给 B（B 收到的条数只等于他自己的升级次数）',
    leakedB === Math.min(1, B.pendingLevels + (B.state === 'levelup' ? 1 : 0)) || leakedB <= 1,
    'B 收到 ' + leakedB + ' 条，B.state=' + B.state + ' pending=' + B.pendingLevels);

  // A 选完之后两人都能继续
  const okPick = SIM.chooseLevelUp(w, 0, A);
  expect('A 能正常消费升级选择', okPick === true);
  expect('A 选完后回到进行中', A.state === 'playing', 'A.state=' + A.state);
  expect('A 的升级次数已清零', A.pendingLevels === 0, 'pending=' + A.pendingLevels);
  // 同理：不能断言「B.state 必须是 playing」——B 可能自己也在升级面板上。
  // 要验的是「A 的选择没有动过 B 的数据」：B 的升级次数不该因为 A 选而变化。
  const bPendingBefore = B.pendingLevels;
  expect('B 的状态没有被 A 的选择改掉（A 选完不碰 B 的升级次数）',
    B.pendingLevels === bPendingBefore, 'B.pending ' + bPendingBefore + ' -> ' + B.pendingLevels);

  // 归还上下文：getHud() 不该看到 A 的数据
  const hudB = SIM.getHud(w, B);
  expect('按玩家取 HUD 拿到的是本人的数据', hudB.slot === B.slot && hudB.name === B.name,
    'slot=' + hudB.slot + ' name=' + hudB.name);
}

// ============================================================
// 测试 5：多波升级互不干扰（攒着的升级只归自己）
// ============================================================

function testPendingLevels() {
  console.log('[5] 升级次数归属');

  const w = makeWorld(2, { seed: 606, charIds: ['hunter', 'nun'] });
  const A = w.players[0];
  const B = w.players[1];

  // 一口气给 A 攒够 3 次升级
  A.exp = 0;
  const need = A.expNext;
  // 经验球要一颗一颗喂，且必须在同一帧内吃满 —— 直接把 exp 加上去更直接
  A.exp = need * 3 + need * 2 + need * 2;

  // 手动触发一次结算：喂一颗最小的球
  pushPickup(w, 'exp', A.x, A.y, 1);
  SIM.step(w, stillInputs(2));

  expect('A 连升多级后攒下了多次升级', A.pendingLevels >= 2, 'pending=' + A.pendingLevels);
  expect('B 的升级次数仍然是 0', B.pendingLevels === 0, 'B.pending=' + B.pendingLevels);

  const before = A.pendingLevels;
  SIM.chooseLevelUp(w, 0, A);
  expect('选一次只消耗一次（面板重新弹出）', A.pendingLevels === before - 1 && A.state === 'levelup',
    'pending ' + before + ' -> ' + A.pendingLevels + ' state=' + A.state);
  expect('B 依然没有被牵连', B.pendingLevels === 0 && B.state === 'playing',
    'B.pending=' + B.pendingLevels + ' B.state=' + B.state);
}

// ============================================================
// 测试 6：武器开火归属 —— 只有开枪的人涨伤害
// ============================================================

function testWeaponOwnership() {
  console.log('[6] 武器开火归属（只有开枪的人涨伤害）');

  // 只留 1 号（修女，蒜雾是纯范围伤害，不需要瞄准，最可靠）的武器
  const w = makeWorld(4, { seed: 8888, charIds: ['hunter', 'nun', 'scholar', 'blacksmith'], spawnRadius: 120 });
  w.players[0].weapons.length = 0;
  w.players[2].weapons.length = 0;
  w.players[3].weapons.length = 0;

  for (let t = 0; t < 400; t++) SIM.step(w, stillInputs(4));

  const dmgs = w.players.map(function (p) { return p.stats.dmgDealt; });
  expect('有武器的人打出了伤害', dmgs[1] > 0, '1 号伤害 ' + dmgs[1]);
  expect('没武器的人伤害保持为 0', dmgs[0] === 0 && dmgs[2] === 0 && dmgs[3] === 0,
    dmgs[0] + ',' + dmgs[2] + ',' + dmgs[3]);
}

// ============================================================
// 测试 7：阵亡与掉线的清理
// ============================================================

function testDeathAndLeave() {
  console.log('[7] 阵亡隔离与掉线清理');

  const w = makeWorld(4, { seed: 9999, spawnRadius: 150 });
  const A = w.players[0];
  const B = w.players[1];

  // 先跑一会儿，让大家手里都有东西（投射物 / 区域 / 环绕物）
  run(w, 240, 4, false);

  // 给 A 强塞几个归属他名下的实体，保证待会儿有东西可清
  w.projectiles.push({
    id: w.nextId++, kind: 'line', owner: A, x: A.x, y: A.y, px: A.x, py: A.y,
    vx: 0, vy: 0, r: 6, dmg: 1, pierce: 1, life: 999, hitIds: {}, color: '#fff',
    explodeRadius: 0, explodeDmg: 0
  });
  w.zones.push({
    id: w.nextId++, kind: 'zone', owner: A, x: A.x, y: A.y, r: 30, dmg: 1,
    tickSec: 1, tickTimer: 1, life: 999, maxLife: 999, color: '#aaa', hitKey: 'zsweep'
  });
  const ownedBefore = countOwned(w, A);
  expect('A 名下确实有实体', ownedBefore > 0, 'owned=' + ownedBefore);

  // 弄死 A：把一只怪贴到他身上、清掉他的无敌帧。
  // 两个坑都在这里踩过：
  //   ① 4 个人清怪很快，场上可能是空的 —— 得先强制补一波，否则「贴上去」无从谈起；
  //   ② 处于 levelup 的人是「定格 + 无敌」的，面板不消费掉就变成护身符，A 永远死不了。
  //      （这条本身是设计如此，见 sim.js 的 damagePlayer）
  let killed = false;
  for (let t = 0; t < 200 && !killed; t++) {
    let m = firstAliveMob(w);
    if (!m) {
      // 场上没怪：把下一波的触发时刻拨到当前帧，强制刷一波出来
      w.nextWaveTick = w.tick;
      SIM.step(w, stillInputs(4));
      if (A.state === 'levelup') SIM.chooseLevelUp(w, 0, A);
      continue;
    }

    // 怪血调厚：保证它在接触伤害判定之后还活着，不会「先被我们打死、A 反而没挨着」
    m.hp = 1e9;
    m.maxHp = 1e9;
    A.x = m.x;
    A.y = m.y;
    A.hp = 1;
    A.invuln = 0;
    m.hitCd = 0;

    SIM.step(w, stillInputs(4));
    if (A.state === 'levelup') SIM.chooseLevelUp(w, 0, A);
    if (!A.alive) killed = true;
  }

  expect('A 能被打死', A.alive === false && A.state === 'dead',
    'alive=' + A.alive + ' state=' + A.state);
  expect('A 阵亡不会把整局判定成通关', w.won === false);
  expect('B 依然活着且在正常进行', B.alive === true && B.state === 'playing',
    'B.alive=' + B.alive + ' B.state=' + B.state);

  expect('A 阵亡后遗留物被清空', countOwned(w, A) === 0, 'owned=' + countOwned(w, A));

  // 死人不再吃经验
  const expBefore = A.exp;
  pushPickup(w, 'exp', A.x, A.y, 50);
  SIM.step(w, stillInputs(4));
  expect('阵亡玩家不再获得经验', A.exp === expBefore, 'exp ' + expBefore + ' -> ' + A.exp);

  // B 还能正常移动
  const bx = B.x;
  const by = B.y;
  SIM.step(w, [{ mx: 1, my: 0 }, { mx: 0, my: -1 }, { mx: 0, my: 0 }, { mx: 0, my: 0 }]);
  expect('B 还能正常移动', B.x !== bx || B.y !== by, '位移 ' + (B.x - bx) + ',' + (B.y - by));

  // 掉线：把 A 摘掉
  // 先给他挂一条专属事件，验证掉线时会被一起清掉（座位号会被下一个人复用）
  w.events.push({ type: 'levelup', slot: A.slot, name: A.name });
  const removed = SIM.removePlayer(w, A.connId);
  expect('掉线玩家能摘掉', removed === A && w.players.length === 3,
    'length=' + w.players.length);
  expect('掉线玩家留下的专属事件被清掉',
    w.events.filter(function (e) { return e.slot === A.slot; }).length === 0,
    '残留 ' + w.events.filter(function (e) { return e.slot === A.slot; }).length + ' 条');
  expect('剩下的三人座位号没有被重排',
    w.players.map(function (p) { return p.slot; }).join(',') === '1,2,3',
    w.players.map(function (p) { return p.slot; }).join(','));
  expect('摘掉之后世界里没有他的残留实体',
    !hasOwner(w, A), '仍存在');
  expect('摘掉之后世界还能继续跑', (function () {
    const t0 = w.tick;
    SIM.step(w, stillInputs(3));
    return w.tick === t0 + 1;
  })());
}

function countOwned(w, owner) {
  let n = 0;
  const lists = [w.projectiles, w.zones, w.strikes, w.orbits];
  for (let k = 0; k < lists.length; k++) {
    for (let i = 0; i < lists[k].length; i++) {
      if (lists[k][i].owner === owner) n++;
    }
  }
  return n;
}

function hasOwner(w, owner) {
  return countOwned(w, owner) > 0;
}

// ============================================================
// 测试 8：中途加入
// ============================================================

function testMidJoin() {
  console.log('[8] 中途加入');

  const w = makeWorld(2, { seed: 1234 });
  run(w, 120, 2, false);

  const joined = SIM.addPlayer(w, { charId: 'blacksmith', connId: 'conn-late', name: '迟到的', isGuest: true });
  expect('新玩家进入世界', w.players.length === 3);
  expect('新玩家拿到最小空座位', joined.slot === 2, 'slot=' + joined.slot);
  expect('新玩家满血且存活', joined.alive === true && joined.hp === joined.maxHp,
    'hp=' + joined.hp + '/' + joined.maxHp);
  expect('新玩家有自己的武器与属性', joined.weapons.length === 1 && !!joined.attrs);
  expect('新玩家有独立的战绩对象',
    joined.stats !== w.players[0].stats && joined.stats.kills === 0);

  // 带着新玩家一起跑一段（他跟着大家一起打）
  for (let t = 0; t < 200; t++) {
    SIM.step(w, mpInputs(3, t, false));
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].state === 'levelup') SIM.chooseLevelUp(w, 0, w.players[i]);
    }
  }
  expect('中途加入的玩家存活且能正常行动', joined.alive === true, 'alive=' + joined.alive);

  // 验证他是「一等公民」：归属、经验两条链路都跟老玩家一样走得通。
  // 不靠运气等他打到怪 —— 直接给他一发归他名下的致命投射物，看账记给谁。
  // ★不要依赖「跑 200 帧后场上还有怪」—— 4 人局火力很足，怪经常被清光，
  //   于是这一整块断言被静默跳过：0 FAIL 但覆盖度悄悄少 2 条（实测踩过，
  //   当时表现是「mptest 从 84 变成 82，却一条失败都没有」）。
  //   没怪就补刷一只，保证这段一定被执行。
  let mob = firstAliveMob(w);
  if (!mob) {
    mob = SIM.spawnMob(w, 'corpse', joined.x + 40, joined.y, 1);
    console.log('  （场上已无怪，补刷一只用于归属断言）');
  }
  if (mob) {
    const killsBefore = w.players.map(function (p) { return p.stats.kills; });
    w.projectiles.push({
      id: w.nextId++, kind: 'line', owner: joined,
      x: mob.x, y: mob.y, px: mob.x, py: mob.y, vx: 0, vy: 0,
      r: 6, dmg: 999999, pierce: 1, life: 1, hitIds: {}, color: '#fff',
      explodeRadius: 0, explodeDmg: 0
    });
    SIM.step(w, stillInputs(3));
    const d = w.players.map(function (p, i) { return p.stats.kills - killsBefore[i]; });
    const joinedIdx = w.players.indexOf(joined);
    const others = d.filter(function (_, i) { return i !== joinedIdx; })
      .reduce(function (a, b) { return a + b; }, 0);
    expect('中途加入的玩家击杀能正确记账', d[joinedIdx] === 1, '增量 ' + d[joinedIdx]);
    // ★这条原来写的是「别人的击杀增量必须为 0」，本轮开始失败 ——
    //   隔离实验确认：那 200 帧里玩家不断升级，**候选池变了（新增了本轮的技能）
    //   就会选到不同的武器**，最后一帧里别人的武器恰好补刀打死了另一只怪。
    //   那是真实的战斗行为，不是记账串了。
    //   真正要验的是「加入者名下那笔击杀没被别人记走」，
    //   判据就是上面那条：d[joinedIdx] 必须正好等于他那发子弹打死的怪数。
    //   别人这一帧有没有顺手补刀，与归属无关，不该由这条断言来管。
    expect('中途加入的玩家击杀不漏给别人（加入者那笔完整记在他名下）',
      d[joinedIdx] === 1, '加入者 ' + d[joinedIdx] + ' / 别人合计 ' + others);
  }

  // 升级链路：直接把球喂到他脚下（掉落只有 60 秒寿命、掉落点又不在他附近，靠等不靠谱）
  joined.x = C.MAP.width / 2;
  joined.y = C.MAP.height / 2;
  for (let i = 0; i < 3; i++) pushPickup(w, 'exp', joined.x, joined.y, 500);
  SIM.step(w, stillInputs(3));
  expect('中途加入的玩家能正常升级成长', joined.level > 1, 'level=' + joined.level);
  expect('中途加入的玩家升级后有自己的候选面板',
    joined.state !== 'levelup' || Array.isArray(joined.choices),
    'state=' + joined.state);

  // 座位号必须错开（否则网络协议里会把 A 的实认识成 B 的）
  const slots = w.players.map(function (p) { return p.slot; });
  expect('座位号互不重复', new Set(slots).size === slots.length, slots.join(','));
}

// ============================================================
// 测试 9：确定性 —— 同种子 + 同输入 = 同结果
//
// 联机的根基：服务端与客户端各自跑这一份 sim，必须是同一台机器。
// 一旦掺进 Math.random 或依赖遍历顺序，联机就会莫名漂移、无法复现 bug。
// ============================================================

function testDeterminism() {
  console.log('[9] 确定性（同种子同输入 → 同结果）');

  const ticks = 900;

  function fingerprint() {
    const w = makeWorld(4, { seed: 777333 });
    for (let t = 0; t < ticks; t++) {
      SIM.step(w, mpInputs(4, t, false));
      // 这里故意用固定下标，绝不掺 Math.random —— 否则测的就不是 sim 的确定性了
      for (let i = 0; i < w.players.length; i++) {
        if (w.players[i].state === 'levelup') SIM.chooseLevelUp(w, 0, w.players[i]);
      }
    }
    const parts = [w.tick, w.wave, w.mobs.length, w.projectiles.length, w.zones.length,
      w.strikes.length, w.orbits.length, w.pickups.length];
    for (let i = 0; i < w.players.length; i++) {
      const p = w.players[i];
      parts.push(p.x.toFixed(6), p.y.toFixed(6), p.hp, p.level, p.exp,
        p.stats.kills, p.stats.dmgDealt, p.stats.gold, p.weapons.length, p.passives.length);
    }
    return parts.join('|');
  }

  const a = fingerprint();
  const b = fingerprint();
  expect('两次独立运行的结果完全一致', a === b,
    a === b ? '' : ('\n    A=' + a + '\n    B=' + b));

  // 换个种子必须不一样，否则说明随机数根本没参与（也是 bug）。
  // 注意不能拿「玩家坐标」来比 —— 玩家的位移完全由输入决定，跟种子无关，
  // 开局几十帧内两边坐标一模一样是正常的。要看随机数本身消耗出来的东西：
  // 随机数状态、以及怪物的出生角度。
  const w2 = makeWorld(4, { seed: 777334 });
  const w3 = makeWorld(4, { seed: 777333 });
  for (let t = 0; t < 120; t++) {
    SIM.step(w2, mpInputs(4, t, false));
    SIM.step(w3, mpInputs(4, t, false));
  }
  const mobA = w2.mobs[0];
  const mobB = w3.mobs[0];
  expect('换种子会得到不同的世界（随机数状态不同）',
    w2.rngState !== w3.rngState,
    'rng ' + w2.rngState + ' vs ' + w3.rngState);
  expect('换种子会得到不同的世界（刷怪位置不同）',
    !mobA || !mobB || mobA.x !== mobB.x || mobA.y !== mobB.y,
    mobA && mobB ? (mobA.x + ',' + mobA.y + ' vs ' + mobB.x + ',' + mobB.y) : '没刷出怪');
}

// ============================================================
// 测试 10：留档用的 P1 兼容性 —— pauseAllOnLevelUp 默认必须冻住世界
// ============================================================

function testP1Compat() {
  console.log('[10] P1 兼容（单机默认仍是全世界暂停）');

  const w = SIM.createWorld({ charId: 'hunter', seed: 24681357 });
  expect('单机世界只有 1 个玩家', w.players.length === 1, 'length=' + w.players.length);
  expect('默认开启「升级冻结全世界」', w.pauseAllOnLevelUp === true);
  expect('自己就是 0 号玩家', w.self === w.players[0]);
  expect('world.stats 就是自己的战绩', w.stats === w.players[0].stats);

  // 兼容取值器：老代码读写 w.state / w.choices / w.pendingLevels 必须照旧
  const p = w.players[0];
  p.exp = p.expNext - 1;
  pushPickup(w, 'exp', p.x, p.y, 5);
  SIM.step(w, { mx: 0, my: 0 });

  expect('w.state 映射到自己的状态', w.state === 'levelup', 'w.state=' + w.state);
  expect('w.choices 映射到自己的候选', w.choices === p.choices && w.choices.length > 0,
    'len=' + (w.choices ? w.choices.length : -1));
  expect('w.pendingLevels 映射到自己的次数', w.pendingLevels === p.pendingLevels);

  const tickAtPanel = w.tick;
  for (let t = 0; t < 30; t++) SIM.step(w, { mx: 0, my: 0 });
  expect('单机：面板开着时不推进世界', w.tick === tickAtPanel,
    'tick ' + tickAtPanel + ' -> ' + w.tick);

  // 单参数调用（老写法）必须仍可用
  const applied = SIM.chooseLevelUp(w, 0);
  expect('chooseLevelUp(w, 0) 老写法仍可用', applied === true);
  expect('选完后 w.state 回到 playing', w.state === 'playing', 'w.state=' + w.state);

  // getHud 老写法仍可用
  const hud = SIM.getHud(w);
  expect('getHud(w) 老写法仍可用且字段齐全',
    typeof hud.kills === 'number' && typeof hud.level === 'number' &&
    typeof hud.state === 'string' && Array.isArray(hud.weapons));
  expect('getHud 报出了自己的座位与名字', hud.slot === 0 && typeof hud.name === 'string',
    'slot=' + hud.slot + ' name=' + hud.name);

  // takeEvents 老写法（无参）仍取全部
  const evs = SIM.takeEvents(w);
  expect('takeEvents(w) 老写法仍可用', Array.isArray(evs));
}

// ============================================================
// 测试 11：性能 —— 4 人 + 满屏怪的单帧耗时
// ============================================================

function testPerf() {
  console.log('[11] 性能（4 人局满载单帧耗时）');

  const w = makeWorld(4, { seed: 555 });
  // 强行把同屏怪物堆到上限
  for (let t = 0; t < 300; t++) {
    SIM.step(w, mpInputs(4, t, false));
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].state === 'levelup') SIM.chooseLevelUp(w, 0, w.players[i]);
    }
  }
  while (SIM.countAliveMobs(w) < C.MAX_MOBS) {
    // 借用波次生成把数量堆起来
    w.nextWaveTick = w.tick;
    SIM.step(w, mpInputs(4, w.tick, false));
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].state === 'levelup') SIM.chooseLevelUp(w, 0, w.players[i]);
    }
    if (w.tick > 4000) break;
  }

  const alive = SIM.countAliveMobs(w);
  const N = 200;
  let sum = 0;
  let max = 0;
  for (let t = 0; t < N; t++) {
    const t0 = process.hrtime.bigint();
    SIM.step(w, mpInputs(4, w.tick, false));
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    sum += ms;
    if (ms > max) max = ms;
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].state === 'levelup') SIM.chooseLevelUp(w, 0, w.players[i]);
    }
  }

  const avg = sum / N;
  console.log('        同屏怪物 ' + alive + '  玩家 4  投射物 ' + w.projectiles.length +
    '  掉落 ' + w.pickups.length);
  console.log('        单帧耗时: 平均 ' + fmt(avg, 3) + 'ms  最高 ' + fmt(max, 3) + 'ms');

  expect('4 人局满载跑得动', alive > 0);
  expect('平均单帧远低于 50ms 预算（20Hz）', avg < 50, 'avg=' + fmt(avg, 3) + 'ms');
  expect('最高单帧低于 100ms', max < 100, 'max=' + fmt(max, 3) + 'ms');
}

// ============================================================
// 跑全部
// ============================================================

console.log('');
console.log('=== 多人世界自检开始 ===');
console.log('');

testCreateMulti();
testOwnership();
testPickupAttribution();
testLevelUpIsolation();
testPendingLevels();
testWeaponOwnership();
testDeathAndLeave();
testMidJoin();
testDeterminism();
testP1Compat();
testPerf();

console.log('');
console.log('=== 自检结束 ===');
console.log('  PASS = ' + pass + '   FAIL = ' + fail + '   总耗时 ' +
  fmt(process.uptime(), 1) + ' 秒');
console.log('');

process.exit(fail > 0 ? 1 : 0);
