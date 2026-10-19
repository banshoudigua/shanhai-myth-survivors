// tools/campaigntest.js —— 剧情模组层回归（纯 Node，不需要服务端）
//
// 用法：node tools/campaigntest.js
//
// 【为什么这块必须有断言】
// 剧情模组层的问题是**清一色「不报错、只是不对」**：
//   · 名字表漏一个角色 → 那个角色在剧情模式下仍显示「猎魔人」，不报错
//   · 关卡地图 id 写错 → maps.js 静默回落默认图，六关全变成同一张图，不报错
//   · 怪池里写了不存在的怪 id → spawnWave 里 `continue` 跳过，
//     表现是「有些波一只怪都没有」，不报错
//   · 解锁规则写成「要求前一关通关」而漏了首关特判 → 首关永远解不开，
//     整个模式进不去（这类 off-by-one 最经典）
// 这些靠肉眼测是测不出来的，只能靠断言钉死。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const C = require(path.join(ROOT, 'shared/const.js'));
const M = require(path.join(ROOT, 'shared/maps.js'));
const CP = require(path.join(ROOT, 'shared/campaign.js'));
const SIM = require(path.join(ROOT, 'shared/sim.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}

// ============================================================
// 一、模组表
// ============================================================
console.log('=== 一、模组表 ===');

ok('模组表里有 vanilla（自由模式）', !!CP.MODS.vanilla);
ok('模组表里有 myth（神话）', !!CP.MODS.myth);
ok('★vanilla 的 stages 必须是 null（否则自由模式会走剧情路径）',
  CP.MODS.vanilla.stages === null, String(CP.MODS.vanilla.stages));
ok('vanilla 不覆写任何名字（自由模式必须与本名一致）',
  Object.keys(CP.MODS.vanilla.charNames).length === 0 &&
  Object.keys(CP.MODS.vanilla.mobNames).length === 0 &&
  Object.keys(CP.MODS.vanilla.mapNames).length === 0);
ok('非法 modId 回落到 vanilla', CP.modById('nope_xxx').id === 'vanilla');
ok('空 modId 回落到 vanilla', CP.modById('').id === 'vanilla');
ok('undefined 回落到 vanilla', CP.modById(undefined).id === 'vanilla');
ok('isCampaign(vanilla) = false', CP.isCampaign('vanilla') === false);
ok('isCampaign(myth) = true', CP.isCampaign('myth') === true);
ok('isCampaign(乱码) = false（回落到 vanilla）', CP.isCampaign('zzz') === false);

// ============================================================
// 二、名字表完备性
// ============================================================
console.log('');
console.log('=== 二、名字表完备性 ===');

// ★核心断言：每个模组的每个名字表都要覆盖**全部** id。
// 漏一个 → 那个东西在剧情模式下仍显示旧名，纯静默。
['myth', 'magic'].forEach(function (modId) {
  const mod = CP.MODS[modId];
  let missChar = [], missMob = [], missMap = [];
  for (let i = 0; i < C.CHARACTERS.length; i++) {
    if (!mod.charNames[C.CHARACTERS[i].id]) missChar.push(C.CHARACTERS[i].id);
  }
  for (let i = 0; i < C.MOBS.length; i++) {
    if (!mod.mobNames[C.MOBS[i].id]) missMob.push(C.MOBS[i].id);
  }
  for (let i = 0; i < M.MAPS.length; i++) {
    if (!mod.mapNames[M.MAPS[i].id]) missMap.push(M.MAPS[i].id);
  }
  ok('[' + modId + '] 8 个角色都有剧情名', missChar.length === 0, missChar.join(','));
  ok('[' + modId + '] 14 只怪物都有剧情名', missMob.length === 0, missMob.join(','));
  ok('[' + modId + '] 6 张地图都有剧情名', missMap.length === 0, missMap.join(','));

  // ★名字表里不能有**多出来的**键（指到不存在的 id）。
  // 这类错误最阴：改了 id 但忘了改名字表 → 表里留着旧键，
  // 新 id 查不到 → 静默回落本名，而旧键永远不会被用到。
  let ghostChar = [], ghostMob = [], ghostMap = [];
  Object.keys(mod.charNames).forEach(function (k) {
    if (!C.CHAR_MAP[k]) ghostChar.push(k);
  });
  Object.keys(mod.mobNames).forEach(function (k) {
    if (!C.MOB_MAP[k]) ghostMob.push(k);
  });
  Object.keys(mod.mapNames).forEach(function (k) {
    if (!M.mapById(k) || M.mapById(k).id !== k) ghostMap.push(k);
  });
  ok('[' + modId + '] 角色名表没有指向不存在 id 的残留键', ghostChar.length === 0, ghostChar.join(','));
  ok('[' + modId + '] 怪物名表没有指向不存在 id 的残留键', ghostMob.length === 0, ghostMob.join(','));
  ok('[' + modId + '] 地图名表没有指向不存在 id 的残留键', ghostMap.length === 0, ghostMap.join(','));

  // 剧情名不能与原数据表里的**另一个** id 的名字撞车
  // （撞车本身不致命，但「同一个名字指两个东西」会让玩家分不清）
  const nameSet = {};
  let dup = [];
  Object.keys(mod.charNames).forEach(function (k) {
    const n = mod.charNames[k];
    if (nameSet[n]) dup.push(n);
    nameSet[n] = 1;
  });
  ok('[' + modId + '] 角色剧情名互不重复', dup.length === 0, dup.join(','));
});

// vanilla 的名字表必须等于本名（自由模式行为与改造前一致）
const vt = CP.buildNameTable('vanilla');
let vanillaSame = true, badV = '';
for (let i = 0; i < C.CHARACTERS.length; i++) {
  const id = C.CHARACTERS[i].id;
  if (vt.char[id] !== C.CHARACTERS[i].name) { vanillaSame = false; badV += id + ' '; }
}
ok('★vanilla 名字表 = 数据表本名（自由模式显示不变）', vanillaSame, badV);
ok('vanilla 地图名 = 地图本名', vt.map.graveyard === M.mapById('graveyard').name,
  vt.map.graveyard + ' vs ' + M.mapById('graveyard').name);
ok('myth 名字表：猎魔人 → 刑天', CP.buildNameTable('myth').char.hunter === '刑天');
ok('myth 名字表：墓地那张图有剧情名（且不等于本名）',
  CP.buildNameTable('myth').map.graveyard !== M.mapById('graveyard').name &&
  !!CP.buildNameTable('myth').map.graveyard,
  CP.buildNameTable('myth').map.graveyard);
ok('名字表查不到时回落数据表本名', CP.charName('myth', 'no_such_char') === 'no_such_char',
  CP.charName('myth', 'no_such_char'));

// charName / mobName / mapName 直查
// ★不写死具体名字：名字是**内容**，改一次文案就得改断言的话，
//   下次真出问题时这条会因为「名字变了」而红，被人当成噪声（第十八轮改名踩过一次）。
//   判据改成「与改名表自身一致」+「与本名不同（剧情确实换了叫法）」。
const mythBlacksmith = CP.charName('myth', 'blacksmith');
ok('charName(myth, blacksmith) = myth 改名表里写的那个',
  mythBlacksmith === CP.MODS.myth.charNames.blacksmith, mythBlacksmith);
ok('myth 的角色名与本名不同（剧情确实换了叫法）',
  mythBlacksmith !== C.CHAR_MAP.blacksmith.name, mythBlacksmith);
ok('mobName(myth, blood_lord) = 蚩尤', CP.mobName('myth', 'blood_lord') === '蚩尤');
// ★不写死地图名：地图名是内容，改一次文案就要改断言的话，
//   下次真出问题时这条会因为「名字变了」而红，被人当成噪声。
ok('mapName(myth, spire) 与 mod.mapNames 一致（且不等于数据表本名）',
  CP.mapName('myth', 'spire') === CP.MODS.myth.mapNames.spire &&
  CP.mapName('myth', 'spire') !== M.mapById('spire').name,
  CP.mapName('myth', 'spire'));
ok('mobName(myth, 不存在的怪) 回落 id', CP.mobName('myth', 'ghost_mob') === 'ghost_mob');

// ============================================================
// 三、关卡编排合法性
// ============================================================
console.log('');
console.log('=== 三、关卡编排合法性 ===');

CP.MOD_IDS.forEach(function (modId) {
  const list = CP.stagesOf(modId);
  if (!list.length) return;   // vanilla

  ok('[' + modId + '] 关卡 id 互不重复',
    (function () {
      const s = {};
      for (let i = 0; i < list.length; i++) {
        if (s[list[i].id]) return false;
        s[list[i].id] = 1;
      }
      return true;
    })());
  ok('[' + modId + '] 关卡序号连续（1..N，无缺号）',
    list.every(function (st, i) { return (st.no || (i + 1)) === i + 1; }),
    list.map(function (st) { return st.no; }).join(','));

  let badMap = [], badChar = [], badBoss = [], badPool = [], badSec = [], badBeats = [];
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    // 地图必须存在（★写错的后果是 maps.js 静默回落默认图 → 六关全变同一张图）
    if (M.mapById(st.mapId).id !== st.mapId) badMap.push(st.id + ':' + st.mapId);
    // 初始角色必须存在
    if (!C.CHAR_MAP[st.startChar]) badChar.push(st.id + ':' + st.startChar);
    // Boss 必须存在且是 boss 级
    if (st.boss) {
      const md = C.MOB_MAP[st.boss.id];
      if (!md) badBoss.push(st.id + ':' + st.boss.id);
      else if (md.tier !== 'boss') badBoss.push(st.id + ':' + st.boss.id + '(tier=' + md.tier + ')');
      // atWave 必须是正数且不能超过本关总波数（否则这关永远见不到 Boss）
      if (!(st.boss.atWave > 0)) badBoss.push(st.id + ':atWave=' + st.boss.atWave);
      else {
        const totalWaves = Math.ceil(st.matchSec / (st.waves ? st.waves.intervalSec : C.WAVES.intervalSec));
        if (st.boss.atWave > totalWaves) {
          badBoss.push(st.id + ':atWave ' + st.boss.atWave + ' > 总波数 ' + totalWaves);
        }
      }
    }
    // 怪池：每个 key 都必须是真实怪种
    Object.keys(st.pool || {}).forEach(function (k) {
      if (!C.MOB_MAP[k]) badPool.push(st.id + ':' + k);
    });
    // 时长必须为正
    if (!(st.matchSec > 0)) badSec.push(st.id + ':' + st.matchSec);
    // 节拍时间必须落在关卡时长内（超出的节拍永远不会播 → 剧情缺一段，不报错）
    (st.beats || []).forEach(function (b, bi) {
      if (!(b.at >= 0) || b.at >= st.matchSec) {
        badBeats.push(st.id + '#' + bi + ':at=' + b.at + ' 时长=' + st.matchSec);
      }
      if (!b.text) badBeats.push(st.id + '#' + bi + ':空文本');
    });
  }
  ok('[' + modId + '] 每关地图 id 都能查到（写错会静默回落默认图）', badMap.length === 0, badMap.join(','));
  ok('[' + modId + '] 每关初始角色都存在', badChar.length === 0, badChar.join(','));
  ok('[' + modId + '] 每关 Boss 都存在且是 boss 级、atWave 合理', badBoss.length === 0, badBoss.join(','));
  ok('[' + modId + '] 每关怪池里的怪种都真实存在', badPool.length === 0, badPool.join(','));
  ok('[' + modId + '] 每关时长都为正数', badSec.length === 0, badSec.join(','));
  ok('★[' + modId + '] 剧情节拍都落在关卡时长内（超出的节拍永远不播）',
    badBeats.length === 0, badBeats.join(' | '));

  // 每关都必须有题记（卷首页要显示；空的话卷首页会缺一块）
  ok('[' + modId + '] 每关都有卷首题记',
    list.every(function (st) { return !!st.epigraph; }));
  // 每关都要有节拍（没有节拍的关在游戏里是哑的）
  ok('[' + modId + '] 每关都有至少一条节拍',
    list.every(function (st) { return st.beats && st.beats.length > 0; }));

  // 六关的「地图 / 初始角色 / 时长」都要有差异 ——
  // 需求明写「每关的地图、时长、怪物、初始角色都不一样」。
  // 这条不是形式主义：如果两关完全一样，那第二关就是白做。
  const maps = {}, chars = {}, secs = {}, pools = {};
  let dupMap = [], dupChar = [], dupSec = [], dupPool = [];
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (maps[st.mapId]) dupMap.push(st.id);
    maps[st.mapId] = 1;
    if (chars[st.startChar]) dupChar.push(st.id);
    chars[st.startChar] = 1;
    if (secs[st.matchSec]) dupSec.push(st.id);
    secs[st.matchSec] = 1;
    const pk = Object.keys(st.pool).sort().join('+');
    if (pools[pk]) dupPool.push(st.id);
    pools[pk] = 1;
  }
  ok('[' + modId + '] ★每关地图都不重复', dupMap.length === 0, dupMap.join(','));
  // ★章节名不能与地图名撞车 —— 否则 HUD 上同一行会出现两个同词
  //   （踩过：「焚天阙 · 第 1 波 … · 焚天阙」）。
  //   章节名=发生什么，地图名=什么地方，语义不同就该名字不同。
  let clash = [];
  for (let i = 0; i < list.length; i++) {
    const st = list[i];
    if (CP.mapName(modId, st.mapId) === st.name) clash.push(st.id + ':' + st.name);
  }
  ok('★[' + modId + '] 章节名不与地图名撞车（HUD 同词重复很刺眼）',
    clash.length === 0, clash.join(','));
  ok('[' + modId + '] 每关初始角色都不重复', dupChar.length === 0, dupChar.join(','));
  ok('[' + modId + '] 每关时长都不重复', dupSec.length === 0, dupSec.join(','));
  ok('[' + modId + '] ★每关怪池组合都不重复', dupPool.length === 0, dupPool.join(','));
});

// ============================================================
// 四、关卡派生函数
// ============================================================
console.log('');
console.log('=== 四、关卡派生函数 ===');

ok('stageById 能查到 ch3', CP.stageById('myth', 'ch3').id === 'ch3');
ok('★stageById 非法 id 回落第一关（不返回 null —— null 会让界面白屏）',
  CP.stageById('myth', 'nope').id === 'ch1');
ok('stageById 空 id 回落第一关', CP.stageById('myth', '').id === 'ch1');
ok('stageById(vanilla) 返回 null（自由模式没有关卡）',
  CP.stageById('vanilla', 'ch1') === null);
ok('nextStage(ch1) = ch2', CP.nextStage('myth', 'ch1').id === 'ch2');
ok('★nextStage(最后一关) = null（结算页据此换成「回到选关」）',
  CP.nextStage('myth', 'ch6') === null);
ok('stageCount(myth) = 6', CP.stageCount('myth') === 6);
ok('stageCount(vanilla) = 0', CP.stageCount('vanilla') === 0);
ok('stageNo(myth, ch4) = 4', CP.stageNo('myth', 'ch4') === 4);

// Boss 指定
// ★波次一律从关卡定义读，**不写死数字** ——
//   写死的话调一次平衡（8 波 → 12 波）就会误报成回归，
//   而那种失败会消耗排查时间（这个项目已经踩过「断言写死 4 张图」）。
const ch3 = CP.stageById('myth', 'ch3');
ok('bossOf 用剧情关指定的 Boss（ch3 → ' + CP.mobName('myth', ch3.boss.id) + '）',
  CP.bossOf('myth', ch3, ch3.boss.atWave) === ch3.boss.id);
ok('★isBossWave 只在本关指定那一波为真（ch3 @' + ch3.boss.atWave + '）',
  CP.isBossWave('myth', ch3, ch3.boss.atWave) === true);
ok('★isBossWave 在非指定波为假（ch3 第 ' + (ch3.boss.atWave + 1) + ' 波不该来 Boss）',
  CP.isBossWave('myth', ch3, ch3.boss.atWave + 1) === false);
ok('第一关 bossEvery=999 → 整关无 Boss（第 10 波也不是）',
  CP.isBossWave('myth', CP.stageById('myth', 'ch1'), 10) === false);
ok('★bossOf 在没指定时回落原轮换表（自由模式行为不变）',
  CP.bossOf('vanilla', null, 10) === C.bossForWave(10));

// 波次参数
const ch1 = CP.stageById('myth', 'ch1');
ok('waveIntervalOf 用本关的（ch1 = 26 秒）', CP.waveIntervalOf('myth', ch1) === 26);
ok('waveIntervalOf 自由模式回落 30 秒', CP.waveIntervalOf('vanilla', null) === C.WAVES.intervalSec);
ok('waveHpMulOf 用本关的 hpGrowth', CP.waveHpMulOf('myth', ch1, 11) > 1);
ok('waveCountOf 用本关的 baseCount', CP.waveCountOf('myth', ch1, 1) === 10);
ok('waveCountOf 自由模式回落全局公式', CP.waveCountOf('vanilla', null, 1) === C.waveCount(1));

// ============================================================
// 五、sim 接入：建世界
// ============================================================
console.log('');
console.log('=== 五、sim 接入 ===');

// 自由模式必须与改造前完全一致
const wFree = SIM.createWorld({ seed: 1 });
ok('★自由模式 matchSec 仍来自难度（1200）', wFree.matchSec === 1200, String(wFree.matchSec));
ok('★自由模式 storyStage 为 null', wFree.storyStage === null);
ok('★自由模式 nameTable 有值（供渲染层查，值是本名）', !!wFree.nameTable);
ok('自由模式地图仍走默认图', wFree.map.id === M.DEFAULT_MAP_ID, wFree.map.id);
// 自由模式显示的必须是**数据表本名**。同样不写死「猎魔人」这三个字 ——
// 本名在第十八轮改名成了神话名，写死会在每次改内容时假红。
ok('自由模式 charName = 数据表本名（vanilla 不覆写）',
  SIM.getHud(wFree).charName === C.CHAR_MAP.hunter.name,
  SIM.getHud(wFree).charName + ' vs 本名 ' + C.CHAR_MAP.hunter.name);
const hFree = SIM.getHud(wFree);
ok('自由模式 HUD.campaign = false', hFree.campaign === false);
ok('自由模式 HUD.campaign 字段存在（模板读它，缺失会白屏）', 'campaign' in hFree);
ok('自由模式 HUD.stageNo = 0', hFree.stageNo === 0);
// ★不写死地图名：地图名是**内容**，第十八轮改过一次。
//   判据是「自由模式显示的 = 数据表本名」—— 真正的机制在这里。
ok('自由模式 HUD 地图名 = 数据表本名（vanilla 不覆写）',
  hFree.mapName === M.mapById(wFree.map.id).name,
  hFree.mapName + ' vs 本名 ' + M.mapById(wFree.map.id).name);

// ★同名白名单陷阱：getHud 新增字段必须在 syncHud 里转发
const gameJsSrc = require('node:fs').readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
['mapName', 'campaign', 'stageNo', 'stageName', 'coda', 'bossName', 'ended', 'timeout'].forEach(function (f) {
  ok('★syncHud 转发了 hud.' + f + '（getHud 加了、syncHud 不转发 = 界面静默不显示）',
    new RegExp('hud\\.' + f + '\\s*=').test(gameJsSrc));
});

// 剧情模式：六关逐一验证
CP.stagesOf('myth').forEach(function (st) {
  const w = SIM.createWorld({ seed: 7, modId: 'myth', stageId: st.id });
  const h = SIM.getHud(w);
  const tag = 'ch' + st.no + ' ' + st.name;
  ok(tag + '：地图按关卡定（' + st.mapId + '）', w.map.id === st.mapId, w.map.id);
  ok(tag + '：时长按关卡定（' + st.matchSec + 's）', w.matchSec === st.matchSec, String(w.matchSec));
  ok(tag + '：初始角色按关卡定（' + st.startChar + '）', w.self.charId === st.startChar, w.self.charId);
  ok(tag + '：HUD 显示剧情名（' + CP.charName('myth', st.startChar) + '）',
    h.charName === CP.charName('myth', st.startChar), h.charName);
  ok(tag + '：HUD 章节号 = ' + st.no, h.stageNo === st.no, String(h.stageNo));
  // ★HUD 的地图名必须走名字表（剧情名），不能是数据表本名。
  //   踩过：getHud 原来**根本没有 mapName 字段**，界面在 startMatch 里直接读
  //   `world.map.name`（数据表本名）→ 剧情模式显示「血色回廊」而不是「血霞回廊」。
  ok(tag + '：HUD 地图名是剧情名（' + CP.mapName('myth', st.mapId) + '）',
    h.mapName === CP.mapName('myth', st.mapId), h.mapName + ' vs ' + CP.mapName('myth', st.mapId));
  ok(tag + '：HUD 关卡名 = ' + st.name, h.stageName === st.name, h.stageName);
  ok(tag + '：HUD 带出题记', h.epigraph === st.epigraph);
  ok(tag + '：HUD 带出卷尾', h.coda === st.coda);
  ok(tag + '：HUD.campaign = true', h.campaign === true);
  ok(tag + '：地图显示名是剧情名（' + CP.mapName('myth', st.mapId) + '）',
    w.nameTable.map[st.mapId] === CP.mapName('myth', st.mapId), w.nameTable.map[st.mapId]);
  // 波次总数要为正（HUD 显示「第 N / M 波」）
  ok(tag + '：HUD 带出本关总波数', h.stageWaveTotal > 0, String(h.stageWaveTotal));
});

// 非法 modId / stageId 的回落（不能崩）
const wBad = SIM.createWorld({ seed: 1, modId: 'zzz', stageId: 'zzz' });
ok('非法 modId 时按自由模式建世界', wBad.storyStage === null && wBad.matchSec === 1200);
const wBadStage = SIM.createWorld({ seed: 1, modId: 'myth', stageId: 'ch99' });
ok('★非法关卡 id 回落到第一关（不崩）',
  wBadStage.storyStage.id === 'ch1', wBadStage.storyStage && wBadStage.storyStage.id);

// ============================================================
// 六、剧情模式下的刷怪与事件
// ============================================================
console.log('');
console.log('=== 六、刷怪与事件 ===');

// 跑一关，验证怪池生效（只出本关的怪）+ 节拍事件按序播出
const w6 = SIM.createWorld({ seed: 20261004, modId: 'myth', stageId: 'ch2' });
const ch2 = CP.stageById('myth', 'ch2');
const allow = Object.keys(ch2.pool);
const seenMob = {};
const beats = [];
const stages = [];
let bossEvents = [];
// 跑满整关（300 秒 = 6000 帧）。step 的签名是 step(w, inputs)
for (let i = 0; i < 300 * C.TICK_HZ; i++) {
  SIM.step(w6, { mx: 0, my: 0 });
  const evs = SIM.takeEvents(w6);
  for (let k = 0; k < evs.length; k++) {
    const e = evs[k];
    if (e.type === 'story') beats.push(e.line);
    else if (e.type === 'stage') stages.push(e.name);
    else if (e.type === 'boss') bossEvents.push({ id: e.bossId, name: e.name });
    // 记下场上所有出现过的怪种
    if (e.type === 'wave' || e.type === 'boss') {
      for (let mi = 0; mi < w6.mobs.length; mi++) {
        if (w6.mobs[mi].alive) seenMob[w6.mobs[mi].def.id] = 1;
      }
    }
  }
  // 升级面板会冻结世界（单机默认），要消费掉才能继续推进
  if (w6.self && w6.self.state === 'levelup') {
    SIM.chooseLevelUp(w6, 0);
  }
}

const seenIds = Object.keys(seenMob);
// ★Boss 要排除在外：它是 spawnWave 里**单独注入**的，本来就不在 pool 里
//   （pool 是小怪权重表）。把它算成「越界」会让这条断言永远为红。
const allowSet = allow.slice();
if (ch2.boss) allowSet.push(ch2.boss.id);
const illegal = seenIds.filter(function (id) { return allowSet.indexOf(id) < 0; });
ok('★剧情关只出本关怪池里的怪 + 本关首领（没有别的怪串进来）', illegal.length === 0,
  '越界: ' + illegal.join(',') + ' | 实际出现: ' + seenIds.join(','));
ok('剧情关真的把本关首领刷出来了',
  !ch2.boss || seenIds.indexOf(ch2.boss.id) >= 0, seenIds.join(','));
ok('剧情关真的刷出了怪（不是空关）', seenIds.length > 0, seenIds.join(','));

ok('★节拍按序全部播出（' + ch2.beats.length + ' 条）', beats.length === ch2.beats.length,
  '实际 ' + beats.length + ' 条：' + beats.join(' / '));
ok('节拍内容与关卡定义一致',
  beats.length === ch2.beats.length && beats.every(function (t, i) { return t === ch2.beats[i].text; }),
  beats.join(' / '));
ok('★每条节拍只播一次（storyBeatDone 去重生效）',
  beats.length === (function () {
    const s = {};
    beats.forEach(function (t) { s[t] = 1; });
    return Object.keys(s).length;
  })(), beats.join(' / '));

ok('stage 事件只推一次（剧情一整局就一个关卡）', stages.length === 1,
  '实际 ' + stages.length + ' 次：' + stages.join(','));
ok('stage 事件带的是剧情地图名（' + CP.mapName('myth', ch2.mapId) + '）',
  stages[0] === CP.mapName('myth', ch2.mapId), stages[0]);

ok('★剧情关的 Boss 在指定波到来（' + ch2.boss.id + ' @' + ch2.boss.atWave + '）',
  bossEvents.length === 1 && bossEvents[0].id === ch2.boss.id,
  JSON.stringify(bossEvents));
ok('★Boss 事件带的是剧情名（' + CP.mobName('myth', ch2.boss.id) + '，不是「骸骨暴君」）',
  bossEvents.length === 1 && bossEvents[0].name === CP.mobName('myth', ch2.boss.id),
  bossEvents.length ? bossEvents[0].name : '(无 Boss 事件)');

// 自由模式：确认节拍事件不产生（vanilla 没有 storyStage）
const wFree2 = SIM.createWorld({ seed: 5 });
let freeBeats = 0;
for (let i = 0; i < 20 * C.TICK_HZ; i++) {
  SIM.step(wFree2, { mx: 0, my: 0 });
  const evs = SIM.takeEvents(wFree2);
  for (let k = 0; k < evs.length; k++) if (evs[k].type === 'story') freeBeats++;
  if (wFree2.self && wFree2.self.state === 'levelup') SIM.chooseLevelUp(wFree2, 0);
}
ok('★自由模式不产生任何 story 事件', freeBeats === 0, String(freeBeats));

// ============================================================
// 六·五、胜负条件（本轮最重要的游戏性改动）
// ============================================================
console.log('');
console.log('=== 六·五、胜负条件 ===');

// 跑一关，可选「在第 N 帧把首领打死」。
// 返回 { won, timeout, bossDefeated, ended, bossEvents }
function runStage(stageId, killBossAtFrame) {
  const w = SIM.createWorld({ seed: 4242, modId: 'myth', stageId: stageId });
  let bossEvents = 0;
  const maxFrames = (w.matchSec + 4) * C.TICK_HZ;
  for (let i = 0; i < maxFrames; i++) {
    SIM.step(w, { mx: 0, my: 0 });
    const evs = SIM.takeEvents(w);
    for (let k = 0; k < evs.length; k++) {
      if (evs[k].type === 'boss') bossEvents++;
    }
    // 指定帧：找到场上的首领并一击打死
    if (killBossAtFrame && i === killBossAtFrame) {
      for (let mi = 0; mi < w.mobs.length; mi++) {
        const m = w.mobs[mi];
        if (m.alive && m.def.tier === 'boss') {
          SIM.damageMob(w, m, 9999999, 0, 0);
        }
      }
    }
    if (w.self && w.self.state === 'levelup') SIM.chooseLevelUp(w, 0);
    if (w.ended) break;
  }
  return {
    won: w.won, timeout: w.timeout, bossDefeated: w.bossDefeated,
    ended: w.ended, bossEvents: bossEvents, wave: w.wave
  };
}

// ① 无首领的关（第一关）：撑满时长 = 通关
const r1 = runStage('ch1', 0);
ok('★无首领的关：撑满时长即通关', r1.won === true && r1.ended === true, JSON.stringify(r1));
ok('无首领的关不会超时失败', r1.timeout === false, JSON.stringify(r1));
ok('无首领的关全程没有 boss 事件', r1.bossEvents === 0, String(r1.bossEvents));

// ② 有首领的关：不打死首领 → 时间到 = 未通过
const r2 = runStage('ch2', 0);
ok('★有首领的关：时间到但首领活着 → 未通过（不是通关）',
  r2.ended === true && r2.won === false && r2.timeout === true, JSON.stringify(r2));
ok('未通过时 bossDefeated 为 false', r2.bossDefeated === false);
ok('有首领的关真的刷出了首领', r2.bossEvents === 1, String(r2.bossEvents));

// ③ 有首领的关：打死首领 → 立刻通关（不用等时间到）
//    首领在第 10 波（240s）来，所以 250s 那一帧去打它
const ch2b = CP.stageById('myth', 'ch2');
const bossFrame = ch2b.boss.atWave * ch2b.waves.intervalSec * C.TICK_HZ + 20;
const r3 = runStage('ch2', bossFrame);
ok('★有首领的关：击败首领即通关', r3.won === true && r3.ended === true, JSON.stringify(r3));
ok('★击败首领通关时不算超时失败', r3.timeout === false, JSON.stringify(r3));
ok('bossDefeated 被置为 true', r3.bossDefeated === true);
ok('★打死首领后世界立刻收尾，不再继续刷波（波数停在首领波附近）',
  r3.wave <= ch2b.boss.atWave + 1, 'wave=' + r3.wave + ' bossWave=' + ch2b.boss.atWave);

// ④ 自由模式：打死 boss 绝不该结束整局
const wFreeBoss = SIM.createWorld({ seed: 999 });
let freeEndedEarly = false;
for (let i = 0; i < 200 * C.TICK_HZ; i++) {
  SIM.step(wFreeBoss, { mx: 0, my: 0 });
  const evs = SIM.takeEvents(wFreeBoss);
  for (let k = 0; k < evs.length; k++) {
    if (evs[k].type === 'boss') {
      // 自由模式第 10 波也来 boss，把它打死 —— 整局绝不能就此结束
      for (let mi = 0; mi < wFreeBoss.mobs.length; mi++) {
        const m = wFreeBoss.mobs[mi];
        if (m.alive && m.def.tier === 'boss') SIM.damageMob(wFreeBoss, m, 9999999, 0, 0);
      }
    }
  }
  if (wFreeBoss.self && wFreeBoss.self.state === 'levelup') SIM.chooseLevelUp(wFreeBoss, 0);
  if (wFreeBoss.ended) { freeEndedEarly = true; break; }
}
ok('★自由模式打死 boss 不会结束整局（boss 只是每 10 波一次的中途挑战）',
  freeEndedEarly === false, 'ended at tick ' + wFreeBoss.tick);
ok('自由模式 HUD 不会出现 failed 状态', SIM.getHud(wFreeBoss).state !== 'failed');

// ⑤ 三态齐全
const h1 = SIM.getHud(SIM.createWorld({ seed: 1, modId: 'myth', stageId: 'ch1' }));
ok('HUD 带 ended / timeout / bossDefeated 三个字段（模板要读，缺一个会显示 undefined）',
  'ended' in h1 && 'timeout' in h1 && 'bossDefeated' in h1);

// ============================================================
// 七、解锁规则（与 public/js/story-progress.js 同一套逻辑）
// ============================================================
console.log('');
console.log('=== 七、解锁规则 ===');

// 这里用 Node 侧的等价实现验证**规则本身**（浏览器侧是 localStorage 版，
// 逻辑必须一致；这里验的是「规则对不对」而不是「存储读得对不对」）。
function unlockedFrom(clearedList, stageId) {
  const list = CP.stagesOf('myth');
  if (list[0].id === stageId) return true;       // 首关恒解锁
  for (let i = 1; i < list.length; i++) {
    if (list[i].id === stageId) return clearedList.indexOf(list[i - 1].id) >= 0;
  }
  return false;
}
ok('★首关永远解锁（漏了这条特判整个模式都进不去）', unlockedFrom([], 'ch1') === true);
ok('第二关在首关未通关时锁定', unlockedFrom([], 'ch2') === false);
ok('首关通关后第二关解锁', unlockedFrom(['ch1'], 'ch2') === true);
ok('第六关需要第五关通关（不是「任意通关一关」）',
  unlockedFrom(['ch1', 'ch2', 'ch3', 'ch4'], 'ch6') === false);
ok('第五关通关后第六关解锁', unlockedFrom(['ch1', 'ch2', 'ch3', 'ch4', 'ch5'], 'ch6') === true);
ok('已通关的关仍然解锁（可以重打）', unlockedFrom(['ch1', 'ch2'], 'ch1') === true);

// 检查浏览器侧实现与上面这套规则一致（源码级比对，防止两处规则漂移）
const fs = require('node:fs');
const spSrc = fs.readFileSync(path.join(ROOT, 'public/js/story-progress.js'), 'utf8');
ok('story-progress.js 有「首关恒解锁」的判断',
  /list\[0\]\.id === stageId/.test(spSrc), '找不到首关特判');
ok('story-progress.js 的解锁读的是 isCleared（不是复刻一遍 indexOf）',
  /isCleared\(modId, list\[i - 1\]\.id\)/.test(spSrc));
ok('game.js 进关时会再校验一次解锁（防手输 URL 绕过）',
  /STORY\.isUnlocked/.test(fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8')));
ok('game.js 通关时会记进度（markCleared）',
  /markCleared/.test(fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8')));

// ============================================================
// 八、界面接线（源码级，防漏）
// ============================================================
console.log('');
console.log('=== 八、界面接线 ===');

const gameHtml = fs.readFileSync(path.join(ROOT, 'public/game.html'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const lobbyJs = fs.readFileSync(path.join(ROOT, 'public/js/lobby.js'), 'utf8');
const gameJs = fs.readFileSync(path.join(ROOT, 'public/js/game.js'), 'utf8');
const cssStory = fs.readFileSync(path.join(ROOT, 'public/css/story-campaign.css'), 'utf8');

ok('game.html 引入了 campaign.js', /shared\/campaign\.js/.test(gameHtml));
ok('game.html 引入 story-progress.js', /js\/story-progress\.js/.test(gameHtml));
ok('game.html 引入了剧情样式', /story-campaign\.css/.test(gameHtml));
ok('index.html 引入了 campaign.js', /shared\/campaign\.js/.test(indexHtml));
ok('index.html 引入 story-progress.js', /js\/story-progress\.js/.test(indexHtml));
ok('index.html 引用了剧情样式', /story-campaign\.css/.test(indexHtml));

// ★脚本顺序：campaign.js 必须在 sim.js 之前（sim 的工厂要拿它）
const iCamp = gameHtml.indexOf('/shared/campaign.js');
const iSim = gameHtml.indexOf('/shared/sim.js');
ok('★game.html 里 campaign.js 排在 sim.js 之前（顺序错了 sim 拿到 undefined）',
  iCamp > 0 && iSim > 0 && iCamp < iSim, 'campaign@' + iCamp + ' sim@' + iSim);
const iStory = gameHtml.indexOf('/js/story-progress.js');
const iGameJs = gameHtml.indexOf('/js/game.js');
ok('★game.html 里 story-progress.js 排在 game.js 之前',
  iStory > 0 && iGameJs > 0 && iStory < iGameJs, 'story@' + iStory + ' game@' + iGameJs);
const iLobbyCamp = indexHtml.indexOf('/shared/campaign.js');
const iLobbyJs = indexHtml.indexOf('/js/lobby.js');
ok('★index.html 里 campaign.js 排在 lobby.js 之前',
  iLobbyCamp > 0 && iLobbyJs > 0 && iLobbyCamp < iLobbyJs, 'campaign@' + iLobbyCamp + ' lobby@' + iLobbyJs);

// 模板里的引用都要有对应定义（★少一个字段在 Vue 里是「静默不显示」，不是报错）
ok('game.html 卷首页引用了 pl-chars', /class="pl-chars"/.test(gameHtml));
ok('game.html 有节拍横条', /class="story-beat"/.test(gameHtml));
ok('game.html 有卷尾', /class="coda"/.test(gameHtml));
ok('game.html 有章节标', /chapter-tag/.test(gameHtml));
ok('index.html 有关卡选择弹层', /class="story-mask"/.test(indexHtml));
ok('index.html 有剧情入口按钮', /openStory/.test(indexHtml));

// computed / methods 定义齐不齐
[
  'isCampaign', 'campaignTotal', 'stageNo', 'stageNameOf', 'stageEpigraph',
  'mapNameOf', 'stageMinutes', 'charNameOf', 'charDescOf', 'stageBossName',
  'diffs', 'diffDescOf', 'hasNextStage', 'storyCharDefault', 'storyCharPicked',
  'storyChars', 'storyCharPickedName', 'storyCharPickedDesc'
].forEach(function (k) {
  ok('game.js 定义了 computed ' + k, new RegExp(k + '\\s*:\\s*function|' + k + '\\s*\\(\\s*\\)\\s*\\{').test(gameJs));
});
['nextStage', 'pickStoryChar', 'isStoryCharPicked'].forEach(function (k) {
  ok('game.js 定义了 method ' + k, new RegExp(k + '\\s*:\\s*function').test(gameJs));
});
// ★正则要允许带参数：switchStoryMod(id) / enterStoryStage(st) 都是带参的。
//   只匹配 `k() {` 会把它们判成「没定义」——那就是测试自己在骗自己。
['openStory', 'closeStory', 'switchStoryMod', 'enterStoryStage'].forEach(function (k) {
  ok('lobby.js 定义了 method ' + k, new RegExp(k + '\\s*\\([^)]*\\)\\s*\\{').test(lobbyJs));
});
[
  'storyMods', 'storyMod', 'storyModName', 'storyModTagline', 'storyStages', 'storyCleared'
].forEach(function (k) {
  ok('lobby.js 定义了 computed ' + k, new RegExp(k + '\\s*\\([^)]*\\)\\s*\\{').test(lobbyJs));
});

// ★★弹层居中：绝不能出现 align-items: center（项目踩过两次的坑）
const storyMaskRule = /\.story-mask\s*\{([^}]*)\}/.exec(cssStory);
ok('★.story-mask 不写 align-items: center（flex 居中溢出会裁掉第一关）',
  storyMaskRule && !/align-items\s*:\s*center/.test(storyMaskRule[1]),
  storyMaskRule ? storyMaskRule[1].replace(/\s+/g, ' ').slice(0, 90) : '找不到 .story-mask 规则');
ok('★.story-mask 用 margin:auto 做居中',
  /\.story-mask\s*>\s*\*\s*\{[^}]*margin\s*:\s*auto/.test(cssStory));

// 节拍横条要吃指针事件 + 避开 Boss 血条
const beatRule = /\.story-beat\s*\{([^}]*)\}/.exec(cssStory);
ok('★节拍横条不吃指针事件（否则挡住走位/摇杆）',
  beatRule && /pointer-events\s*:\s*none/.test(beatRule[1]));
ok('★节拍横条 top 避开了 Boss 血条（>126px）',
  beatRule && /top\s*:\s*(\d+)px/.test(beatRule[1]) &&
  Number(/top\s*:\s*(\d+)px/.exec(beatRule[1])[1]) > 126,
  beatRule ? (beatRule[1].match(/top\s*:\s*\d+px/) || [''])[0] : '');

// ★结算三态：不能用两态（通关/阵亡）糊过去
ok('game.html 结算标题区分「未通过」第三种状态',
  /未 通 过/.test(gameHtml) && /hud\.state === 'failed'/.test(gameHtml));
ok('game.html 未通过时说明了原因（首领未被击败）',
  /时间耗尽/.test(gameHtml) && /未被击败/.test(gameHtml));
ok('game.js 处理 timeout 事件（与 won 分开）',
  /e\.type === 'timeout'/.test(gameJs));

// ★★守一类会白屏的错误：模板里带参数调用 computed。
// Vue 3 的 computed 是 getter（不是函数），`xxx(c)` 会抛
// `xxx is not a function` —— 而那是**渲染中断**：整页白屏、VS_GAME 都挂不上。
// 实测踩过一次（storyCharName）。凡是「按参数取值」的需求，必须先在
// computed 里算成列表再遍历。
const tplExprs = (gameHtml.match(/\{\{[^}]*\}\}/g) || [])
  .concat(gameHtml.match(/v-if="[^"]*"/g) || [])
  .concat(gameHtml.match(/v-for="[^"]*"/g) || [])
  .concat(gameHtml.match(/:class="[^"]*"/g) || [])
  .concat(gameHtml.match(/@click="[^"]*"/g) || []);

// ★必须区分 computed 与 methods —— methods **本来就可以**带参调用
//   （pickStoryChar(c) 是完全合法的），只有 computed 不行。
//   不区分会把一堆正常写法误报成错误，那种断言比没有更糟。
//   做法：按源码行区间把两块切开，各自收集 8 空格缩进的函数名。
const jsLines = gameJs.split('\n');
function namesInBlock(startLine, endLine) {
  const out = [];
  for (let i = startLine; i < endLine && i < jsLines.length; i++) {
    const line = jsLines[i];
    // 两种写法都要认：
    //   ① `name: function ()`  —— 显式函数
    //   ② `name() {`          —— 简写（ES6 对象方法）
    // 只认①会漏掉一半（这个文件里两种混着用），漏掉的那些会被误判成
    // 「computed 带参调用」→ 假报警。假报警比不报警更糟：它会训练人忽略这条断言。
    const m1 = /^\s{8}([A-Za-z][A-Za-z0-9_]*)\s*:\s*function/.exec(line);
    const m2 = /^\s{8}([A-Za-z][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{/.exec(line);
    if (m1) out.push(m1[1]);
    else if (m2) out.push(m2[1]);
  }
  return out;
}
const iComputed = gameJs.indexOf('computed: {');
const iMethods = gameJs.indexOf('methods: {');
const lineOf = function (idx) { return gameJs.slice(0, idx).split('\n').length - 1; };
const computedNames = (iComputed >= 0 && iMethods > iComputed)
  ? namesInBlock(lineOf(iComputed), lineOf(iMethods))
  : namesInBlock(0, jsLines.length);
// ★method 的可调用性有两个来源，必须都收：
//   ① methods 块里的 `name: function` / `name() {`   —— 内联定义
//   ② 工厂作用域里的 `function name(`               —— 定义在外面、methods 里映射引用
//      （这个文件两者混用：`pickStoryChar: function (c)` 是①，
//        `closeShare: closeShare` 指向外层的 `function closeShare()` 是②）
// 少收②会把一半 method 误判成 computed 带参调用 → 假报警。
const methodNames = [];
const topFns = gameJs.match(/^  function ([A-Za-z][A-Za-z0-9_]*)\s*\(/gm) || [];
topFns.forEach(function (m) { methodNames.push(/function ([A-Za-z][A-Za-z0-9_]*)/.exec(m)[1]); });
if (iMethods >= 0) {
  namesInBlock(lineOf(iMethods), jsLines.length).forEach(function (n) {
    if (methodNames.indexOf(n) < 0) methodNames.push(n);
  });
}

const badCalls = [];
tplExprs.forEach(function (e) {
  const re = /([A-Za-z][A-Za-z0-9_]*)\s*\(/g;
  let m2;
  while ((m2 = re.exec(e))) {
    const fn = m2[1];
    if (['Math', 'Number', 'String', 'Boolean', 'Array', 'Object', 'JSON', 'parseInt', 'parseFloat'].indexOf(fn) >= 0) continue;
    if (methodNames.indexOf(fn) >= 0) continue;          // method 允许带参
    if (computedNames.indexOf(fn) >= 0) badCalls.push(fn + ' @ ' + e.slice(0, 50));
  }
});
ok('★模板里没有「带参调用 computed」（Vue3 computed 是 getter，这样会白屏）',
  badCalls.length === 0, badCalls.slice(0, 3).join(' | '));
ok('（自查）确实收集到了 computed 与 methods 两块（否则这条断言等于没跑）',
  computedNames.length >= 15 && methodNames.length >= 15,
  'computed=' + computedNames.length + ' methods=' + methodNames.length);

// ★卷首页的难度按钮不能复用大厅那个 `.diff-btn`（三列网格卡 + width:100%），
//   否则会变成四个竖排大块。这类「跨场景复用类名」的问题不报错、只是版面坏。
const prologueHtml = (gameHtml.match(/panel-prologue[\s\S]*?<\/div>\s*<\/div>/) || [''])[0];
ok('★卷首页难度用专用类 pl-diffbtn（不复用大厅的 .diff-btn）',
  /pl-diffbtn/.test(gameHtml) && !/class="btn btn-sm diff-btn"/.test(gameHtml),
  'diff-btn 出现次数=' + (gameHtml.match(/diff-btn/g) || []).length);
ok('story-campaign.css 定义了 .pl-diffbtn',
  /\.pl-diffbtn\s*\{/.test(fs.readFileSync(path.join(ROOT, 'public/css/story-campaign.css'), 'utf8')));

// 禁紫（项目硬约定）
const purpleHits = (cssStory.match(/#[0-9a-fA-F]{6}/g) || []).filter(function (hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  // 紫/紫蓝的判据：蓝与红都明显高于绿，且蓝不太低
  return b > g + 24 && r > g + 8;
});
ok('★剧情样式里没有紫色/紫蓝色（项目硬约定）', purpleHits.length === 0, purpleHits.join(','));

// ============================================================
console.log('');
console.log('========================================');
console.log('  PASS = ' + pass + '   FAIL = ' + fail);
console.log('========================================');
process.exit(fail ? 1 : 0);
