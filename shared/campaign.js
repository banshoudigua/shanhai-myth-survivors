// shared/campaign.js —— 剧情模组层（可切换的世界观）
//
// 这一层解决什么
// --------------
// 需求是「单人剧情模式 + 角色改名 + 以后能切到魔法世界」。
// 看起来像三件事，其实是**一件事**：把「玩家看到的名字」与「这一局怎么编排」
// 从底层抽出来，变成可以整包替换的数据。
//
// ★为什么名字与 id 必须分开
// id 出现在四个地方，任何一个改了都要同步：
//   ① 二进制串池 STR_POOL（漏加不报错，只是悄悄走长格式 → 带宽 +30%）
//   ② 快照协议（双端各查表）
//   ③ 存档（老记录存的是 id）
//   ④ 联机 emitRoom 的逐字段白名单
// 而「玩家看到的叫什么」只在一个地方用。
// 拆开之后，「换一套世界观的名字」就只是改一张表 —— 这正是
// 「魔法世界模组可切换」这个需求能被满足的根本原因。
//
// ★模组契约的边界（重要，别越界）
// 模组只能改两样东西：**显示名** 与 **关卡编排**。
// 不能改 id、不能改 kind、不能改数值、不能加新武器。
// 想要新武器 = 另一个需求（那要动 shared/const.js 与 sim 的行为分支）。
// 把这条写死在这里，是为了避免「顺手加个新怪」把成本翻十倍。
//
// ★本文件对局外是纯数据 + 纯函数，对局内只被调用两处：
//   ① 建世界时（开局解析一次名字表，见 buildNameTable）
//   ② 刷怪时（取本关的怪池与节奏）
// 渲染层每帧要用的名字**一律从 world.nameTable 取**，不要直接调 nameOf。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./const.js'), require('./maps.js'));
  } else {
    root.VS = root.VS || {};
    root.VS.CAMPAIGN = factory(root.VS.CONST, root.VS.MAPS);
  }
})(typeof self !== 'undefined' ? self : this, function (C, MAPS_MOD) {

  // ============================================================
  // 模组一：中国神话《补天纪》
  // ============================================================
  //
  // 故事线：千年前女娲炼五彩石补天，遗石分镇五方，天穹自此无隙。
  // 千年后石化被「无色之蚀」侵染，天穹裂开一道缝，妖物倾泻而下。
  // 玩家是女娲未散的一缕残念，走遍六处失地拾回散落的五彩石——
  // 最后面对的，是当年那位补天者自己。
  //
  // 【为什么最终 Boss 是女娲而不是魔王】
  // 「正邪对立」是所有游戏都在用的答案，观众不会意外。
  // 「反身成魔」解释了三个别的问题：为什么她是主神（因为她做了那个决定）、
  // 为什么她最强（补天者本该最接近天）、以及为什么必须由玩家来阻止她
  // （她是唯一能补的人，也是唯一成了蚀的人）。

  const myth = {
    id: 'myth',
    name: '神话·补天纪',
    tagline: '五彩石被蚀，天穹裂开一道缝。',

    // ---------- 显示名覆写表（只影响玩家看到的文字）----------
    // id 一个字都不改，只给名字。美术（accent / 三处配色）完全不动。
    //
    // ★第十八轮改名后的关系（本名已经是神话名，这张表干什么用）：
    //   以前 const.js 的本名是洋名（猎魔人 / 修女…），这张表负责在剧情模式下换成神话名。
    //   现在**本名直接就是神话名**了，所以这张表退化成「剧情专属的另一个说法」——
    //   同一个角色的自由模式叫「刑天」、剧情里叫「刑天·断首」这类更完整的称谓。
    //   ★它仍然必须**每个 id 都有**（campaigntest 盯着这条，缺一个就红）：
    //     因为「表里有但本名改了」是静默的，反过来「本名改了但表里漏了」会显示成别的东西。
    charNames: {
      hunter:     '刑天',     // 断首而不止，以战为命
      blacksmith: '火神祝融', // 掌锻造，火焰与铁
      witch:      '旱神魃',   // 弄火致旱，所过之处赤地千里
      scholar:    '文昌帝君', // 掌文运，一笔落下便是千军
      knight:     '北方玄武', // 龟甲负重，水属性之守
      thief:      '窃火者',   // 窃天火者，快而不稳
      nun:        '厚土后土', // 地母载万物，脚下即是依托
      monk:       '斗战胜者'  // 棒打一片，身法快根基浅
    },
    mobNames: {
      corpse:            '枯骨傀',
      bat:               '夜枭',
      skeleton_warrior:  '骨卒',
      plague_hound:      '烛龙犬',
      blood_spider:      '蛊蛛',
      gargoyle:          '镇墓俑',
      bone_knight:       '玄甲卫',
      witch_hunter:      '猎巫者',   // 原名「猎魔人」与角色 hunter 重名，这次顺带解决
      blood_priest:      '祭血巫',
      ghoul_matriarch:   '幽母',
      blood_lord:        '蚩尤',
      bone_tyrant:       '九婴',
      abyss_prelate:     '烛龙',
      moon_queen:        '女娲'
    },
    // 【为什么地图名要与章节名分开】两者是不同的东西：
    //   章节名回答「这一关发生什么」（落霞坳 / 焚天阙），
    //   地图名回答「这是什么地方」（荒坟坡 / 斜影石林）。
    //   第一版我把它们起得几乎一样，结果 HUD 上出现
    //   「焚天阙 · 第 1 波 · … · 焚天阙」——同一屏同一行里同一个词出现两次。
    //   地图名一律取**地形**，章节名一律取**故事节点**。
    mapNames: {
      graveyard: '荒坟坡',      // 散落墓碑
      corridor:  '石柱廊',      // 柱阵
      marsh:     '瘴沼',        // 孤岛群
      cathedral: '断垣台',      // 断墙
      spire:     '斜影石林',    // 45° 斜阵
      altar:     '无色环坛'     // 环形
    },

    // ---------- 六关 ----------
    // 【每关的地图/ 时长 / 怪池 / 初始角色 / Boss 全部不同】
    // 时长比自由模式短（4~7 分钟 vs 18~25 分钟）：剧情模式要的是
    // 「一关一个故事」，不是「熬到时间到」。
    stages: [
      {
        id: 'ch1', no: 1,
        name: '落霞坳',
        mapId: 'corridor',           // 柱阵：教学期需要可躲的掩体
        matchSec: 240,
        startChar: 'monk',           // 行者：贴身高频，死了也不冤（教学容错）
        // 教学关只放两种怪：一种慢（跟）、一种快（逼你动起来）
        pool: { corpse: 40, bat: 35, skeleton_warrior: 25 },
        // 出怪节奏比自由模式慢一点，让教学从容
        waves: { intervalSec: 26, bossEvery: 999, baseCount: 10, countPerWave: 4, hpGrowth: 0.09 },
        // ★没有首领 → 这一关的胜利条件是「撑满时长」。
        //   有首领的关卡则是「击败首领即通关」（见 sim 的 killMob）。
        boss: null,                  // 第一关不设 Boss：先教会走位
        epigraph: '天裂处无物，只余风声。',
        beats: [
          { at: 2,   text: '落霞坳。裂隙初现。' },
          { at: 95,  text: '冢里的东西开始叫门了。' },
          { at: 185, text: '它们不是在咬，是在敲。' }
        ],
        coda: '你拾起第一块五彩石，它比想象中冷。'
      },
      {
        id: 'ch2', no: 2,
        name: '毒泽',
        mapId: 'marsh',              // 孤岛群：没有连续墙可退，必须学会跑
        matchSec: 300,
        startChar: 'thief',          // 窃火：移速 +18% 拾取 +45%，孤岛图靠这个跑得动
        pool: { blood_spider: 32, plague_hound: 26, corpse: 20, bat: 22 },
        waves: { intervalSec: 24, bossEvery: 8, baseCount: 12, countPerWave: 5, hpGrowth: 0.10 },
        // 首领压轴：第 10 波 ≈ 第 240 秒（关卡 80% 处）。
        // ★击败首领即通关，所以它必须在**后段**——放在中间会让后半段无事可做。
        boss: { atWave: 10, id: 'bone_tyrant' },  // 九婴
        epigraph: '瘴自沼底升，无物自生。',
        beats: [
          { at: 2,   text: '毒泽。水面上浮着一层油亮的膜。' },
          { at: 110, text: '虫豸从膜下聚拢过来。' },
          { at: 215, text: '祖神是毒，不是旱——你认错了方向。' }
        ],
        coda: '九婴的第九个头散作青烟，毒泽的水面终于清了。'
      },
      {
        id: 'ch3', no: 3,
        name: '乱星岗',
        mapId: 'graveyard',          // 散落墓碑：视野开阔，适合远程收割
        matchSec: 360,
        startChar: 'scholar',        // 文昌：冷却 -12%，脆但输出高
        pool: { skeleton_warrior: 26, gargoyle: 18, witch_hunter: 14, blood_spider: 20 },
        waves: { intervalSec: 24, bossEvery: 8, baseCount: 13, countPerWave: 5, hpGrowth: 0.11 },
        boss: { atWave: 12, id: 'blood_lord' },   // 蚩尤（≈288s，80%）
        epigraph: '星落之处，草木俱焚。',
        beats: [
          { at: 2,   text: '乱星岗。落星之处，寸草不生。' },
          { at: 125, text: '星官尽殁，尸骨插在碑上。' },
          { at: 250, text: '铜头铁额的东西，从碑林里站起来了。' }
        ],
        coda: '蚩尤的铜柱折了七根。第八根在别人手里。'
      },
      {
        id: 'ch4', no: 4,
        name: '焚天阙',
        mapId: 'spire',              // 45° 斜阵：顺着斜墙跑能省一半路
        matchSec: 420,
        startChar: 'blacksmith',     // 祝融：伤害 +15%，本关是「爽关」
        pool: { blood_priest: 8, bone_knight: 20, gargoyle: 16, witch_hunter: 18, skeleton_warrior: 18 },
        waves: { intervalSec: 22, bossEvery: 8, baseCount: 15, countPerWave: 6, hpGrowth: 0.12 },
        boss: { atWave: 15, id: 'abyss_prelate' },  // 烛龙（≈330s，79%）
        epigraph: '火烧到天上去了。',
        beats: [
          { at: 2,   text: '焚天阙。火在往上烧，不是往下。' },
          { at: 150, text: '祝融归位了——他不是凶手，他是被点着的柴。' },
          { at: 280, text: '衔烛幽渊的东西睁开了眼。' }
        ],
        coda: '烛龙闭眼，天黑了半息。那半息里，你听见了缝在变大。'
      },
      {
        id: 'ch5', no: 5,
        name: '寒渊钟楼',
        mapId: 'cathedral',          // 断墙：4×4 分区，视线被切，适合打持久战
        matchSec: 480,
        startChar: 'knight',         // 玄武：血 +25% 护甲 1，本关要「扛住」而不是「打快」
        pool: { bone_knight: 22, ghoul_matriarch: 7, witch_hunter: 16, gargoyle: 18, blood_spider: 16 },
        waves: { intervalSec: 22, bossEvery: 8, baseCount: 16, countPerWave: 6, hpGrowth: 0.13 },
        // ★借用 moon_queen 的模型与数据，但显示名换成「空壳」——
        //   否则卷首页直接写出「首领 女娲」，把第六关的反转剧透光了。
        //   这就是「显示名可覆写」的用处：同一个怪，两关两个名字。
        boss: { atWave: 17, id: 'moon_queen', name: '空壳' },   // ≈374s
        epigraph: '钟声镇着一道缝。',
        beats: [
          { at: 2,   text: '寒渊钟楼。钟响一声，缝就窄一分。' },
          { at: 170, text: '守缝的不是人。' },
          { at: 320, text: '是一具空壳，穿着你认识的那身衣裳。' }
        ],
        coda: '假身碎处露出的不是血，是空。缝还在。'
      },
      {
        id: 'ch6', no: 6,
        name: '无色祭坛',
        mapId: 'altar',              // 环形：中央无遮蔽，最终战就该无处可躲
        matchSec: 540,
        startChar: 'nun',            // 后土：范围 +15%，终局靠清场速度
        // 全混编 + 双光环同场（祭血巫加攻速、幽母加血量）
        pool: {
          plague_hound: 16, blood_spider: 16, skeleton_warrior: 14,
          gargoyle: 14, bone_knight: 12, witch_hunter: 10,
          blood_priest: 6, ghoul_matriarch: 6
        },
        waves: { intervalSec: 20, bossEvery: 8, baseCount: 18, countPerWave: 7, hpGrowth: 0.14 },
        boss: { atWave: 21, id: 'moon_queen' },     // 女娲（真身·最终，≈420s）
        epigraph: '补天者 herself。',
        beats: [
          { at: 2,   text: '无色祭坛。这里没有颜色。' },
          { at: 190, text: '要打的不是妖。' },
          { at: 360, text: '是当年那个决定补天的人。' }
        ],
        coda: '天穹合上了。这次是你合的。'
      }
    ]
  };

  // ============================================================
  // 模组二：魔法世界（占位，验证可切换性用）
  // ============================================================
  //
  //【这一段是整个架构的验收标准】
  // 填上它 → 切模组 → 全站名字、关卡编排、入口全变，而战斗逻辑一行不改。
  // 如果填了它之后还需要改sim.js，说明架构没立对，要回去重做第一期。
  //
  // 契约限定：只能改名字与关卡编排。下面的 stage 复用现有 6 张图，
  // 说明「换一个世界观」真的只要改数据。
  const magic = {
    id: 'magic',
    name: '魔法·星陨纪',
    tagline: '陨星坠地，法术的余烬还没冷。',
    charNames: {
      hunter: '见习法师', nun: '白塔修女', scholar: '星象学者',
      blacksmith: '铁匠学徒', knight: '重甲战士', thief: '夜行盗贼',
      witch: '元素师', monk: '苦修士'
    },
    mobNames: {
      corpse: '腐化守卫', bat: '暗影翼', skeleton_warrior: '骸骨兵',
      plague_hound: '狂犬魔', blood_spider: '咒缚蛛', gargoyle: '石像守卫',
      bone_knight: '铁卫', witch_hunter: '猎魔骑士', blood_priest: '暗影祭司',
      ghoul_matriarch: '母巢', blood_lord: '堕落领主', bone_tyrant: '白骨暴君',
      abyss_prelate: '深渊主教', moon_queen: '陨星女王'
    },
    mapNames: {
      graveyard: '低语林地', corridor: '回响长廊', marsh: '雾沼',
      cathedral: '钟塔广场', spire: '斜塔废墟', altar: '陨星祭坛'
    },
    // 注：magic 的章节名取「节点」语义（林地入口），与地图名（低语林地）分开 ——
    // 与 myth 同一条规则。
    stages: [
      {
        id: 'mc1', no: 1, name: '林地入口', mapId: 'graveyard',
        matchSec: 240, startChar: 'scholar',
        pool: { corpse: 40, bat: 35, skeleton_warrior: 25 },
        waves: { intervalSec: 26, bossEvery: 999, baseCount: 10, countPerWave: 4, hpGrowth: 0.09 },
        boss: null,
        epigraph: '林子在低语。别停下。',
        beats: [{ at: 2, text: '低语林地。' }],
        coda: '第一块星陨铁落在手里，还烫。'
      }
    ]
  };

  // ============================================================
  // 模组三：自由模式（原样返回本名，不做任何覆写）
  // ============================================================
  //
  // ★为什么自由模式也要做成一个模组，而不是「特判null」：
  // 这样 sim 与界面层只有一条代码路径 —— 「查当前模组的表」。
  // 特判 null 意味着以后每处都要写 if (isCampaign) ... else ...，
  // 而那种分支迟早会漏一处（这项目已经踩过好几次）。
  const vanilla = {
    id: 'vanilla',
    name: '自由模式',
    tagline: '',
    charNames: {},
    mobNames: {},
    mapNames: {},
    // stages 为 null 表示「走 const.js 的 STAGES（原自由模式四段）」，
    // 也就是说**重构 spawnWave 时那195 条老断言一个都不用删**。
    stages: null
  };

  const MODS = { myth: myth, magic: magic, vanilla: vanilla };
  const MOD_IDS = ['vanilla', 'myth', 'magic'];

  // ============================================================
  // 取值函数（全部带非法值回落）
  // ============================================================
  // 为什么要回落：这个项目的所有取值函数（mapById / diffById / charById）
  // 都有回落，因为「id 来自 URL 参数与存档」——用户手改一下就会传进非法值。
  // 少一处回落就是「白屏 / 报错」，而不是「退回默认」。

  function modById(id) {
    return MODS[id] || vanilla;
  }

  // 角色显示名
  function charName(modId, charId) {
    const m = modById(modId);
    const n = m.charNames[charId];
    if (n) return n;
    const def = C.CHAR_MAP[charId];
    return def ? def.name : charId;
  }

  // 怪物显示名
  function mobName(modId, mobId) {
    const m = modById(modId);
    const n = m.mobNames[mobId];
    if (n) return n;
    const def = C.MOB_MAP[mobId];
    return def ? def.name : mobId;
  }

  // 地图显示名
  function mapName(modId, mapId) {
    const m = modById(modId);
    const n = m.mapNames[mapId];
    if (n) return n;
    // 地图本名在 maps.js 而不在 const.js —— 所以回落要走 MAPS_MOD，
    // 不能在 const 里查（那里没有 MAPS）。查不到再退回 id本身。
    const def = MAPS_MOD.mapById(mapId);
    return def ? def.name : mapId;
  }

  // 开局解析一次的名字表。
  // ★这是性能硬约束，不是优化建议：渲染层每帧要给每只怪取名字，
  // 如果每帧走 modById() + 对象查，14 种怪 × 上千只 × 20Hz 就是几万次/秒的
  // 无谓开销。违反它的表现是**掉帧**，而不是报错 —— 很难定位。
  // 所以：开局解析成扁平 Map，运行期只查 Map。
  function buildNameTable(modId) {
    const m = modById(modId);
    const char = {}, mob = {}, map = {};
    let i;
    for (i = 0; i < C.CHARACTERS.length; i++) {
      const id = C.CHARACTERS[i].id;
      char[id] = m.charNames[id] || C.CHARACTERS[i].name;
    }
    for (i = 0; i < C.MOBS.length; i++) {
      const id = C.MOBS[i].id;
      mob[id] = m.mobNames[id] || C.MOBS[i].name;
    }
    for (i = 0; i < MAPS_MOD.MAPS.length; i++) {
      const id = MAPS_MOD.MAPS[i].id;
      map[id] = m.mapNames[id] || MAPS_MOD.MAPS[i].name;
    }
    return { char: char, mob: mob, map: map };
  }

  // 本模组是不是剧情模式（剧情模式才有章节 / 节拍 / 卷首卷尾）
  function isCampaign(modId) {
    const m = modById(modId);
    return !!(m.stages && m.stages.length);
  }

  // 关卡列表（自由模式返回空数组）
  function stagesOf(modId) {
    const m = modById(modId);
    return m.stages || [];
  }

  // 按 id 查关卡。★回落到第一关而不是 null：
  // 「查不到关卡」如果抛错或返回 null，界面就会白屏；
  // 回到第一关最多是「进错关」，玩家一眼能看出来，而白屏看不出原因。
  function stageById(modId, stageId) {
    const list = stagesOf(modId);
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === stageId) return list[i];
    }
    return list[0];
  }

  // 下一关（最后一关返回 null）
  function nextStage(modId, stageId) {
    const list = stagesOf(modId);
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === stageId) return list[i + 1] || null;
    }
    return null;
  }

  // 本关第 wave 波该刷什么。
  // 返回 { pool, waves, stage, bossAt }
  // ★自由模式（stages 为 null）返回 null —— sim 见到 null 就走原来的
  //   C.stageForWave / C.WAVES / C.bossForWave，那条路径一个字都没改。
  function stagePlan(modId, stage) {
    if (!stage) return null;
    return {
      pool: stage.pool,
      waves: stage.waves || null,
      boss: stage.boss || null
    };
  }

  // 本关 Boss 的**显示名**。优先用关卡自带的覆写名（stage.boss.name），
  // 没有再走模组的名字表。
  // 【为什么需要它】第五关与第六关用的是同一个 Boss 数据（假身/真身），
  // 若都走全局名字表，第五关的卷首页就会写「首领 女娲」——
  // 把第六关的反转直接剧透掉。名字表是按 id 的，救不了这种情况。
  function bossDisplayName(modId, stage) {
    if (!stage || !stage.boss) return '';
    if (stage.boss.name) return stage.boss.name;
    return mobName(modId, stage.boss.id);
  }

  // 本关的 Boss id。
  // 剧情关可以在 stage.boss 里直接指定（不按 bossEvery 轮换）；
  // 没指定就回落到原来的四只轮换表。
  function bossOf(modId, stage, wave) {
    if (stage && stage.boss && stage.boss.id) return stage.boss.id;
    return C.bossForWave(wave);
  }

  // 本关的 Boss 是不是在第 wave 波来。
  // 没指定 boss 时沿用 WAVES.bossEvery（第一关把它设成 999 = 整关无Boss）。
  function isBossWave(modId, stage, wave) {
    if (stage && stage.boss && stage.boss.atWave) return wave === stage.boss.atWave;
    const w = (stage && stage.waves) ? stage.waves : C.WAVES;
    return wave > 0 && wave % w.bossEvery === 0;
  }

  // 本关的出怪数量与血量系数（剧情关用自己的 waves，否则用全局的）
  function waveCountOf(modId, stage, wave) {
    const w = (stage && stage.waves) ? stage.waves : C.WAVES;
    return Math.min(w.baseCount + (wave - 1) * w.countPerWave, C.MAX_MOBS);
  }

  function waveHpMulOf(modId, stage, wave) {
    const w = (stage && stage.waves) ? stage.waves : C.WAVES;
    return 1 + (wave - 1) * w.hpGrowth;
  }

  function waveIntervalOf(modId, stage) {
    const w = (stage && stage.waves) ? stage.waves : C.WAVES;
    return w.intervalSec;
  }

  // 剧情模式一共几关（大厅与关卡选择页显示「3 / 6」用）
  function stageCount(modId) {
    return stagesOf(modId).length;
  }

  // 这一关在本模组的第几关（1 起）。找不到返回 0。
  function stageNo(modId, stageId) {
    const list = stagesOf(modId);
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === stageId) return list[i].no || (i + 1);
    }
    return 0;
  }

  return {
    MODS: MODS,
    MOD_IDS: MOD_IDS,
    modById: modById,
    charName: charName,
    mobName: mobName,
    mapName: mapName,
    buildNameTable: buildNameTable,
    isCampaign: isCampaign,
    stagesOf: stagesOf,
    stageById: stageById,
    nextStage: nextStage,
    stagePlan: stagePlan,
    bossOf: bossOf,
    bossDisplayName: bossDisplayName,
    isBossWave: isBossWave,
    waveCountOf: waveCountOf,
    waveHpMulOf: waveHpMulOf,
    waveIntervalOf: waveIntervalOf,
    stageCount: stageCount,
    stageNo: stageNo
  };
});
