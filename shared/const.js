// shared/const.js —— 前后端共用数值表
//
// 为什么放在 shared/ 而不是 public/：
//   P1 阶段这套数值在浏览器里跑（单机），P2 阶段原样搬到 Node 服务端跑（服务器权威）。
//   同一个文件两端引用，才不会出现「改了客户端数值忘了改服务端」的经典分歧。
//   浏览器通过 /shared/const.js（server/api/router.js 已做静态映射）访问，
//   Node 通过 require('../../shared/const.js') 访问。
//
// 写法约定：UMD 风格 —— 有 module 就导出，没有就挂到全局 VS。
// 所有数值都是初值，最终由 game_config 表后台热调（P4）。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VS = root.VS || {};
    root.VS.CONST = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ============================================================
  // 通用
  // ============================================================

  const TICK_HZ = 20;                     // 逻辑固定步长频率（与服务器权威循环一致）
  const DT = 1 / TICK_HZ;                 // 单步时长（秒）

  const MAP = { width: 3200, height: 2400 };

  const PLAYER = {
    hp: 120,                // 原 100。浏览器实测：100 血只够挨 20 下（0.5 秒无敌 → 最多 2 下/秒），
                            // 在 30 只怪围上来的开局里根本撑不住，提到 120 给出反应余量
    speed: 120,             // px/s
    radius: 12,
    invulnSec: 0.7,         // 受击后的无敌时间（原 0.5，调高以削平「被围住瞬间掉一大截」
    pickupRadius: 60,       // 经验球拾取半径（磁石可放大）。原 40 太小：
                            // 经验只能靠走过去吃，玩家被迫往怪堆里钻，改成 60 后能在走位中顺手捡
    regenPerSec: 0,          // 基础无回血，靠掉落与进化

    // 多人局阵亡后原地复活。单机不启用（死亡直接结算，这是这个品类的基本规则），
    // 由 createWorld 的 reviveOnDeath 开关决定 —— 见 shared/sim.js 的 revivePlayer。
    reviveSec: 5,            // 阵亡后等多久复活
    reviveHpRatio: 0.5,      // 复活时恢复到最大血量的多少（不给满血：那等于没惩罚）
    reviveInvulnSec: 3,      // 复活后的无敌时间，给一个逃出怪堆的窗口

    // 升级加血：每升一级，最大血量 +这么多，当前血量同步 +这么多。
    //
    // 【为什么要做这件事】原来升级只给「选一次武器/被动」，血量是死的 120 ——
    // 而怪的血量每波 +10%、数量每波 +5，打到后期玩家的容错空间是**越来越小**的。
    // 结果是「越到后面越只能靠躲」，成长感全在武器上，人物本身没有任何变强。
    //
    // 【为什么当前血量也一起加、而且加的是同一个数】两种做法对比：
    //   · 只加 _maxHp_：血条上限涨了，但当前血不动 → 血条永远显示"少一截"，
    //     玩家以为自己在掉血；而且升级当下并没有「活过来」的感觉。
    //   · 两边都 +同一个绝对量（本做法）：升级立刻回这么多血，
    //     满血时就是「上限和当前一起涨」，残血时等于顺带补了一口 —— 这正是要的效果。
    // 不用「按比例回满」是因为那会让「残血时升级」变成回满血，等于白送一条命。
    hpPerLevel: 8,
    // 等级加成的**绝对上限**（不是倍数）：最多靠升级多拿这么多血，60 级封顶。
    // 120 + 480 = 600 血，后期（怪打人 40~60）能挨十下左右 —— 有成长感但不会无敌。
    // 【为什么必须留一个顶】满局能到 70 级以上，不封顶就是 120+560=680 还在涨，
    // 再叠骑士/铁壳之后「站着不动也不会死」，难度曲线会彻底失去意义。
    hpPerLevelCap: 480
  };

  // 升级经验：expNext(L) = base + (L-1) * step
  // step 从 8 降到 5：原曲线太陡，20 分钟满局（无敌测试）只到 8 级，
  // 而升级是玩家唯一的成长手段，成长跟不上就必然被打死 → 死亡螺旋
  const EXP = { base: 5, step: 5 };

  // 可学习的技能格上限（武器 / 被动各一列）。
  //
  // 【为什么从 6 提到 10】6 格是照着「单件武器闷头升满」的玩法定的，但本项目还有
  // 13 组组合技 —— 每组都要**两件武器各练到 needLevel**（多数是 5 级）。6 格里拿掉
  // 两件凑配方，剩下 4 件就是全部的手感，17 件武器里绝大多数玩家一整局都摸不到，
  // 组合技也几乎凑不出来。提到 10 之后「凑 2~3 组组合技 + 保留几件主力」才成立。
  //
  // ★**组合技不吃这个上限**（本轮的明确需求）。玩家凑齐配方就能解锁，与槽位是否
  //   满无关：组合技存在 `p.combos`（见 sim.js 的 makePlayer），既不占武器槽，
  //   也不受这里任何数字约束 —— 上限只作用于 `p.weapons` / `p.passives`。
  //   （所以界面上的组合技行**只画已解锁的**，不画空位：它本来就没有「还剩几格」。）
  //
  // ★改这个数字要连带看两处：① `tools/hudsize.js` 会按它断言格子数（现取，不写死）
  //   ② `public/css/game.css` 窄屏段里空槽宽度 —— 上限越大，一行越容易被撑到换行。
  const SLOTS = { weapon: 10, passive: 10 };

  // 单局时长（秒），到点通关。
  // 【保留常量本身】老代码（单机、压测基线、多个工具脚本）都直接读它当默认时长；
  // 有了难度之后真正的时长走 world.matchSec（见下面 DIFFICULTIES 与 sim.createWorld），
  // 这个常量退化成「普通难度的时长」与「没传难度时的兜底值」。
  const MATCH_SEC = 1200;

  // ============================================================
  // 难度（房主在候场室选择，开局前可改）
  // ============================================================
  // 为什么要做成「倍率」而不是另写几套数值：波次曲线、玩家成长、武器曲线
  // 是调了很久才对齐的三条线，另起一套等于把那个平衡重做一遍 —— 而且以后
  // 每改一次基础数值都要记得改四份。倍率只动四根旋钮：
  //   hpMul    怪的血量        countMul 每波怪数量
  //   dmgMul   怪打人的伤害    goldMul  结算金币倍率
  // 四档的意图：休闲给人第一次通关的成就感；噩梦/血月给已经玩透的人压力。
  // goldMul 是「难度即收益」的那一环 —— 没有它，高难度就只是自虐。
  const DIFFICULTIES = [
    {
      id: 'casual', name: '休闲', short: '休闲',
      desc: '怪少、血薄、打人不疼，18 分钟一局。第一次玩选它',
      matchSec: 1080,
      hpMul: 0.8, countMul: 0.75, dmgMul: 0.8, goldMul: 0.8
    },
    {
      id: 'normal', name: '普通', short: '普通',
      desc: '标准节奏，20 分钟撑到底。想认真玩选它',
      matchSec: 1200,
      hpMul: 1, countMul: 1, dmgMul: 1, goldMul: 1
    },
    {
      id: 'nightmare', name: '噩梦', short: '噩梦',
      desc: '怪更密更硬、打人更疼，22 分钟；通关者不多',
      matchSec: 1320,
      hpMul: 1.35, countMul: 1.3, dmgMul: 1.25, goldMul: 1.8
    },
    {
      id: 'bloodmoon', name: '血月', short: '血月',
      desc: '25 分钟极限试炼：怪血 ×2、密度 ×1.7。能撑到底的没几个',
      matchSec: 1500,
      hpMul: 2, countMul: 1.7, dmgMul: 1.5, goldMul: 3
    }
  ];

  // 武器成长曲线：每级 伤害 +16%、冷却 -3%、范围 +4%；4 级加 1 投射物；8 级质变（伤害再 ×1.25）
  // 伤害成长从 12% 提到 16%：满级武器原本只有底伤 2.3 倍，完全追不上怪物血量增长
  const GROWTH = { dmg: 0.16, cd: -0.03, range: 0.04, extraProjectileAt: 4, maxLevel: 8 };

  // 被动满级级数
  const PASSIVE_MAX_LEVEL = 5;

  // ============================================================
  // 主动武器（10 件）
  // ============================================================
  // kind 决定 sim 里的行为分支，其余字段是该行为的专属参数。
  // 每件武器基础投射物数默认 1，4 级时 +1（见 weaponStats）。

  const WEAPONS = [
    {
      id: 'whip', name: '刑天干戚', kind: 'melee_arc',
      desc: '自动朝最近的敌人挥出扇形，命中带击退',
      base: { dmg: 12, cd: 1.2, range: 88 },
      arcDeg: 90, knock: 60
    },
    {
      id: 'nail', name: '定海神钉', kind: 'proj_line',
      desc: '自动朝最近的敌人射出神钉，可穿透',
      base: { dmg: 9, cd: 0.8, range: 420 },
      speed: 430, pierce: 1
    },
    {
      id: 'garlic', name: '艾草熏烟', kind: 'aura',
      desc: '身周持续伤害光环，命中击退',
      base: { dmg: 6, cd: 0.5, range: 64 },
      knock: 26
    },
    {
      id: 'holy_water', name: '净瓶甘露', kind: 'zone',
      desc: '抛出甘露，落点形成灼烧区域',
      base: { dmg: 14, cd: 3.0, range: 72 },
      throwDist: 150, zoneSec: 4, tickSec: 0.4
    },
    {
      id: 'thunder', name: '五雷正法', kind: 'strike',
      desc: '在附近随机位置落下神雷，伤害很高但落点不可控',
      base: { dmg: 24, cd: 2.5, range: 40 },
      castDist: 260, fallDelay: 0.25
    },
    {
      id: 'homing_orb', name: '引魂珠', kind: 'homing',
      desc: '自动锁定最近敌人，必中但伤害偏低',
      base: { dmg: 10, cd: 1.5, range: 6 },
      speed: 260, turnRate: 7, lifeSec: 3.5
    },
    {
      id: 'boomerang', name: '回风刃', kind: 'boomerang',
      desc: '投掷后飞回，去程与回程各判定一次伤害',
      base: { dmg: 10, cd: 2.0, range: 220 },
      speed: 380, spinRadius: 90, trips: 1
    },
    {
      id: 'scripture', name: '道德真经', kind: 'orbit',
      desc: '经文绕身流转，持续 3 秒',
      base: { dmg: 11, cd: 3.0, range: 90 },
      orbitSec: 3, hitSec: 0.35, spinSpeed: 2.6
    },
    {
      id: 'heavy_ball', name: '陨星巨岩', kind: 'proj_line',
      desc: '飞行缓慢但无限穿透，适合密集怪群',
      base: { dmg: 16, cd: 2.0, range: 520 },
      speed: 190, pierce: 9999
    },
    {
      id: 'judge_hammer', name: '雷部神锤', kind: 'parabola',
      desc: '抛物线砸向目标位置，落地造成范围伤害',
      base: { dmg: 20, cd: 2.8, range: 56 },
      throwDist: 200, flySec: 0.5
    },

    // ============================================================
    // 本轮新增的四把武器
    // ============================================================
    // 全部复用已有的 kind —— 开火逻辑是个按 kind 分派的大 if，
    // 给新武器各写一套分支的话，每加一把都要动那段核心代码。
    // 靠 base 数值与这几个通用字段（speed / pierce / orbitSec …）就能做出
    // 手感完全不同的四把，没必要冒那个回归风险。
    {
      // 「覆盖流」的极端：范围是蒜雾的 1.7 倍，但伤害只有它的 83%、出手还慢 70%。
      // 它清不动精英，可它站着不动就能把身边一圈小怪磨死 —— 与蒜雾的区别就在这里。
      id: 'frost_nova', name: '太阴玄霜', kind: 'aura',
      desc: '超大范围寒气，伤害低、出手慢，靠覆盖磨小怪',
      base: { dmg: 5, cd: 0.85, range: 108 },
      knock: 18
    },
    {
      // 「穿透流」的极端：弹速最快、穿透 4 个，代价是单发伤害最低。
      // 它适合打成一排的怪，遇上分散的或单个精英就明显吃力。
      id: 'spirit_chain', name: '幽冥锁链', kind: 'proj_line',
      desc: '高速穿透多个敌人，单发伤害低，适合成排的怪',
      base: { dmg: 7, cd: 1.0, range: 560 },
      speed: 620, pierce: 4
    },
    {
      // 「炮击流」的极端：全游戏最高的单发伤害（34），但落点要等 0.42 秒、
      // 范围只有 34。打移动中的怪经常砸空 —— 这是它的代价，也是它的玩法。
      id: 'bone_spike', name: '白骨钉', kind: 'strike',
      desc: '最高单发伤害，但落点延迟长、范围小，容易砸空',
      base: { dmg: 34, cd: 3.2, range: 34 },
      castDist: 320, fallDelay: 0.42
    },
    {
      // 「持续输出流」：绕身时间最长（3.6 秒）、命中间隔最短（0.28 秒），
      // 但转速只有道德真经的 73%、单次伤害也低。它是「待在怪堆里输出」的角色专属。
      id: 'wisp_wheel', name: '幽冥火轮', kind: 'orbit',
      desc: '冥火绕身最久、命中频繁，但转速慢、单次伤害低',
      base: { dmg: 8, cd: 3.4, range: 104 },
      orbitSec: 3.6, hitSec: 0.28, spinSpeed: 1.9
    },
    // ---------- 第十一轮新增的三把（只复用已有 kind，不给开火逻辑加分支）----------
    {
      id: 'blood_rain', name: '血雨', kind: 'zone',
      desc: '在近处召下血雨，范围小但落得极密',
      base: { dmg: 5, cd: 1.6, range: 46 },
      throwDist: 90, zoneSec: 3.2, tickSec: 0.28
    },
    {
      id: 'soul_lantern', name: '引魂灯', kind: 'homing',
      desc: '锁定最近的敌人飞过去，转向极稳所以几乎不空放',
      base: { dmg: 16, cd: 1.9, range: 8 },
      speed: 200, turnRate: 9, lifeSec: 5
    },
    {
      id: 'gale_boomerang', name: '疾风回旋', kind: 'boomerang',
      desc: '出手快、飞得远，能连穿两个敌人；单发很弱',
      base: { dmg: 7, cd: 1.7, range: 300 },
      speed: 560, spinRadius: 110, trips: 2
    }
  ];

  // ============================================================
  // 被动道具（9 件，各 5 级）
  // ============================================================
  // effect 字段供 sim 读取后累加到玩家属性上。

  const PASSIVES = [
    { id: 'blood_crystal', name: '血玉髓', desc: '伤害 +10% / 级',  effect: 'dmg',        per: 0.10 },
    { id: 'iron_shell',    name: '玄铁甲', desc: '受到伤害 -1 / 级', effect: 'armor',      per: 1 },
    { id: 'wind_feather',  name: '风羽',   desc: '移速 +10% / 级',   effect: 'speed',      per: 0.10 },
    { id: 'codex',         name: '秘典',   desc: '冷却 -8% / 级',    effect: 'cd',         per: -0.08 },
    { id: 'wide_lens',     name: '千里镜', desc: '攻击范围 +10% / 级', effect: 'range',    per: 0.10 },
    { id: 'magnet',        name: '磁石',   desc: '拾取范围 +20% / 级', effect: 'pickup',   per: 0.20 },
    // 分身符特殊：只在 2 级与 4 级各 +1 投射物
    { id: 'clone_talisman', name: '分身符', desc: '2 / 4 级各 +1 投射物', effect: 'projectile', per: 0, milestone: [2, 4] },
    { id: 'crown',         name: '玉冕',   desc: '经验获取 +8% / 级', effect: 'exp',        per: 0.08 },
    { id: 'gold_mask',     name: '金面具', desc: '金币获取 +10% / 级', effect: 'gold',      per: 0.10 },

    // ============================================================
    // 本轮新增的三个被动
    // ============================================================
    {
      // 反伤：**受伤时**才对身边的怪造成伤害。它不提高输出（不受伤就完全没用），
      // 所以它不是「伤害流」的替代品，而是「贴着怪打」的角色的保险。
      id: 'thorn_cloak', name: '荆棘披风', desc: '受到伤害时，反刺身边敌人 7 点 / 级',
      effect: 'thorns', per: 7
    },
    {
      // 回血：每秒 0.5 点 / 级，满级每秒 2.5 点。看着很少，但它是**唯一**
      // 不依赖击杀的回血手段 —— 被围住打不出击杀时，它才是那根救命绳。
      id: 'moss_charm', name: '苔藓护符', desc: '每秒回复 0.5 点生命 / 级',
      effect: 'regen', per: 0.5
    },
    {
      // 击杀回血：走的是**已经有**的 killHeal 通路（原来只有进化武器「灵魂吞噬」用它），
      // 所以这次只往汇总里加一行，战斗代码一行不用动。
      id: 'vampire_fang', name: '吸血獠牙', desc: '每次击杀回复 0.4 点生命 / 级',
      effect: 'killHeal', per: 0.4
    },
    // ---------- 第十一轮新增的两个 ----------
    // ★这两个是**结算时判定**的被动（前面 12 种全是改面板数值），
    //   所以 sim 的 damageMob 里要各加一个分支 —— 见 shared/sim.js 的同名注释。
    {
      id: 'sun_brand', name: '日轮烙印',
      desc: '攻击有 8% 概率造成双倍伤害 / 级（不稳定，但期望最高）',
      effect: 'crit', per: 0.08
    },
    {
      id: 'reaper_mark', name: '死神印记',
      desc: '对残血（生命低于 25%）的敌人伤害 +30% / 级（对满血怪毫无作用）',
      effect: 'exec', per: 0.3
    }
  ];

  // ============================================================
  // 进化（满级武器 + 对应满级被动）
  // ============================================================
  // 进化形态是独立定义（不走 8 级成长曲线），参数已按方案给的倍率写死。

  const EVOLUTIONS = [
    {
      id: 'blood_whip', name: '刑天战戚', from: 'whip', need: 'iron_shell', kind: 'melee_arc',
      desc: '扇形展开为 360° 全周，伤害 ×2',
      base: { dmg: 44, cd: 0.95, range: 113 },
      arcDeg: 360, knock: 90, evolved: true
    },
    {
      id: 'thousand_blades', name: '万剑诀', from: 'nail', need: 'codex', kind: 'proj_line',
      desc: '8 向齐发，穿透 5',
      base: { dmg: 16, cd: 0.62, range: 460 },
      speed: 470, pierce: 5, radial: 8, evolved: true
    },
    {
      id: 'soul_devour', name: '幽冥吞噬', from: 'garlic', need: 'wide_lens', kind: 'aura',
      desc: '半径 ×2，击杀回血',
      base: { dmg: 11, cd: 0.5, range: 128 },
      knock: 40, killHeal: 1, evolved: true
    },
    {
      id: 'holy_ground', name: '净瓶天泽', from: 'holy_water', need: 'blood_crystal', kind: 'zone',
      desc: '灼烧区域扩大，持续 8 秒',
      base: { dmg: 26, cd: 3.0, range: 108 },
      throwDist: 150, zoneSec: 8, tickSec: 0.4, evolved: true
    },
    {
      id: 'divine_wrath', name: '天罚神雷', from: 'thunder', need: 'crown', kind: 'strike',
      desc: '同时 4 道神雷，范围 ×1.5',
      base: { dmg: 40, cd: 2.5, range: 60 },
      castDist: 300, fallDelay: 0.2, strikes: 4, evolved: true
    },
    {
      id: 'starlight', name: '北斗星陨', from: 'homing_orb', need: 'clone_talisman', kind: 'homing',
      desc: '6 个投射物全屏追踪',
      base: { dmg: 14, cd: 1.5, range: 6 },
      speed: 300, turnRate: 9, lifeSec: 5, projectiles: 6, evolved: true
    },
    {
      id: 'blood_moon', name: '血月轮', from: 'boomerang', need: 'wind_feather', kind: 'boomerang',
      desc: '往返 4 次，速度 ×1.5',
      base: { dmg: 18, cd: 2.0, range: 280 },
      speed: 570, spinRadius: 110, trips: 4, evolved: true
    },
    {
      id: 'bible_storm', name: '道德经轮', from: 'scripture', need: 'gold_mask', kind: 'orbit',
      desc: '经文数量 4，半径 ×1.5',
      base: { dmg: 18, cd: 3.0, range: 135 },
      orbitSec: 3.4, hitSec: 0.3, spinSpeed: 2.2, projectiles: 4, evolved: true
    },
    {
      id: 'meteor', name: '陨星', from: 'heavy_ball', need: 'magnet', kind: 'proj_line',
      desc: '命中爆炸，附加范围伤害',
      base: { dmg: 30, cd: 1.6, range: 560 },
      speed: 200, pierce: 9999, explodeRadius: 70, explodeDmg: 22, evolved: true
    },
    {
      id: 'doomsday', name: '雷霆惩戒', from: 'judge_hammer', need: 'iron_shell', kind: 'parabola',
      desc: '落点范围 ×2，眩晕 1 秒',
      base: { dmg: 42, cd: 2.4, range: 112 },
      throwDist: 240, flySec: 0.45, stunSec: 1, evolved: true
    }
  ];

  // ============================================================
  // 组合技（6 个）
  // ============================================================
  // 设计：把两件**已有一定等级**的武器合起来，解锁一个全新的攻击方式。
  //
  // 【为什么组合技不复用 EVOLUTIONS 那套】进化的条件是「满级武器 + 满级被动」，
  // 那是**单件武器**的终点，玩家只要闷头升一件就能拿到。组合技要的是**第二件武器**
  // 也投入资源 —— 这是完全不同的决策：中期你得决定「是把铁鞭升满，还是分一点给蒜雾」。
  // 两者能同时存在，玩家可以既进化又凑组合。
  //
  // 【为什么 kind 全部复用现有分支】开火逻辑（sim.js 的 fireWeapon）是一个
  // 按 kind 分派的大 if。组合技如果各写一套 kind，就要在那个函数里加六个分支，
  // 每加一次都是回归风险。复用 kind 意味着**组合技在 sim 眼里和普通武器没有区别**，
  // 只有「怎么解锁、怎么升级、怎么显示」是新的。
  // 组合技的差异化靠参数表达：更大的范围、更多的投射物、更短的冷却。
  //
  // 【为什么组合技不占武器槽】武器槽只有 6 个，中期就满了。如果组合技要占一个槽，
  // 玩家为了拿组合技必须先扔掉一件武器 —— 那不是奖励，是惩罚。
  // 所以组合技单独存在玩家的 combos 数组里（见 sim.js 的 makePlayer），不占槽。
  const COMBOS = [
    {
      id: 'combo_blood_mist', name: '血雾领域', kind: 'aura',
      need: ['whip', 'garlic'], needLevel: 5,
      desc: '刑天干戚 + 艾草熏烟：身周化作血雾，范围与伤害远超艾草',
      flavor: '「鞭上的血不擦，它自己会漫开」',
      base: { dmg: 20, cd: 0.42, range: 156 },
      knock: 54, combo: true, maxLevel: 3
    },
    {
      id: 'combo_holy_storm', name: '雷火交鸣', kind: 'zone',
      need: ['holy_water', 'thunder'], needLevel: 5,
      desc: '净瓶甘露 + 五雷正法：甘露落地即爆成雷光领域',
      flavor: '「甘露浇在雷上，地就烧起来了」',
      base: { dmg: 34, cd: 2.2, range: 124 },
      throwDist: 190, zoneSec: 7, tickSec: 0.35, combo: true, maxLevel: 3
    },
    {
      id: 'combo_blade_cyclone', name: '刃之旋风', kind: 'proj_line',
      need: ['nail', 'boomerang'], needLevel: 5,
      desc: '定海神钉 + 回风刃：十向齐发，穿透 4',
      flavor: '「钉子和刃飞成了同一圈」',
      base: { dmg: 15, cd: 1.15, range: 470 },
      speed: 450, pierce: 4, radial: 10, combo: true, maxLevel: 3
    },
    {
      id: 'combo_starfall', name: '陨星雨', kind: 'strike',
      need: ['homing_orb', 'judge_hammer'], needLevel: 5,
      desc: '引魂珠 + 雷部神锤：六道陨星连续砸向战场',
      flavor: '「天上开始落东西了」',
      base: { dmg: 42, cd: 2.6, range: 84 },
      castDist: 340, fallDelay: 0.3, strikes: 6, combo: true, maxLevel: 3
    },
    {
      id: 'combo_orbit_guard', name: '玄光护体', kind: 'orbit',
      need: ['scripture', 'heavy_ball'], needLevel: 5,
      desc: '道德真经 + 陨星巨岩：五枚炽热真言环绕自身',
      flavor: '「经文烧起来了，绕着人转」',
      base: { dmg: 26, cd: 3.0, range: 128 },
      orbitSec: 3.6, hitSec: 0.28, spinSpeed: 2.4, projectiles: 5, combo: true, maxLevel: 3
    },
    {
      id: 'combo_eclipse', name: '蚀月', kind: 'aura',
      need: ['garlic', 'heavy_ball'], needLevel: 6,
      desc: '艾草熏烟 + 陨星巨岩：光环化作蚀月之影，极慢但范围极大',
      flavor: '「月亮被吃掉的时候，它就在你脚边」',
      base: { dmg: 46, cd: 1.5, range: 232 },
      knock: 96, combo: true, maxLevel: 3
    },

    // ============================================================
    // 本轮新增的四组组合技（配方用到新武器）
    // ============================================================
    // kind 一律复用对应基础武器的分支，只换数值与范围形状。
    {
      id: 'combo_glacier', name: '冰封葬礼', kind: 'zone',
      need: ['frost_nova', 'holy_water'], needLevel: 5,
      desc: '太阴玄霜 + 净瓶甘露：脚下化作终年冰原，踏入者持续受创',
      flavor: '「冻土之下，谁都没有名字」',
      base: { dmg: 22, cd: 2.4, range: 96 },
      throwDist: 120, zoneSec: 5, tickSec: 0.35,
      combo: true, maxLevel: 3
    },
    {
      id: 'combo_soulchain', name: '幽冥回廊', kind: 'proj_line',
      need: ['spirit_chain', 'nail'], needLevel: 5,
      desc: '幽冥锁链 + 定海神钉：锁链贯穿整条走廊，越远越密',
      flavor: '「它认得路，因为它吃过太多人」',
      base: { dmg: 15, cd: 0.75, range: 680 },
      speed: 700, pierce: 12, combo: true, maxLevel: 3
    },
    {
      id: 'combo_bonefall', name: '白骨天降', kind: 'strike',
      need: ['bone_spike', 'thunder'], needLevel: 5,
      desc: '白骨钉 + 五雷正法：三根巨骨同时钉下，落点各自延迟',
      flavor: '「抬头的人，通常只来得及看一眼」',
      base: { dmg: 52, cd: 3.6, range: 56 },
      castDist: 300, fallDelay: 0.34, strikes: 3,
      combo: true, maxLevel: 3
    },
    {
      id: 'combo_wispfest', name: '冥火燎原', kind: 'orbit',
      need: ['wisp_wheel', 'scripture'], needLevel: 5,
      desc: '幽冥火轮 + 道德真经：六簇冥火绕身，转得慢但几乎不间断',
      flavor: '「它们不是灯，是等着分食的嘴」',
      base: { dmg: 17, cd: 2.8, range: 128 },
      orbitSec: 4.2, hitSec: 0.22, spinSpeed: 1.7, projectiles: 6,
      combo: true, maxLevel: 3
    },
    // ---------- 第十一轮新增的三组 ----------
    // 配方刻意挑的是「还没被组过」的武器对，且 kind 直接沿用其中一件 ——
    // 开火逻辑是按 kind 分派的大 if，组合技复用分支就等于零回归风险。
    {
      id: 'combo_bloodstorm', name: '血雨腥风', kind: 'zone',
      need: ['blood_rain', 'frost_nova'], needLevel: 5,
      desc: '血雨 + 太阴玄霜：暴雨夹霜，血落到哪儿哪儿就冻住',
      flavor: '「雨是红的，落地就结冰」',
      base: { dmg: 20, cd: 1.9, range: 78 },
      throwDist: 100, zoneSec: 4.5, tickSec: 0.26,
      combo: true, maxLevel: 3
    },
    {
      id: 'combo_soulcall', name: '唤魂', kind: 'homing',
      need: ['soul_lantern', 'homing_orb'], needLevel: 5,
      desc: '引魂灯 + 引魂珠：一次放出三盏灯，分头去追各自的猎物',
      flavor: '「它们只盯着还活着的东西」',
      base: { dmg: 22, cd: 2.2, range: 10 },
      speed: 300, turnRate: 11, lifeSec: 4.5, projectiles: 3,
      combo: true, maxLevel: 3
    },
    {
      id: 'combo_galeraid', name: '疾风劫', kind: 'boomerang',
      need: ['gale_boomerang', 'boomerang'], needLevel: 5,
      desc: '疾风回旋 + 回风刃：一记三段，去程回程都能割',
      flavor: '「风到的地方，刀也到」',
      base: { dmg: 16, cd: 1.8, range: 340 },
      speed: 620, spinRadius: 120, trips: 3,
      combo: true, maxLevel: 3
    }
  ];

  // ============================================================
  // 怪物（7 种）
  // ============================================================
  // kind: melee 贴身追 / charger 周期冲锋 / buffer 给周围加速 / boss
  // 【当前没有任何怪物使用远程攻击】—— 见下面「骸骨武士」与「血月领主」的说明。
  // sim.js 里处理敌弹的那套管线（spawnEnemyArrow / updateEnemyShots）保留着没删，
  // 想恢复远程怪时只要给 def 加上 shootCd 等字段并在 AI 里开火即可。
  // r 是碰撞半径，同时决定渲染大小

  const MOBS = [
    {
      id: 'corpse', name: '僵尸', tier: 'small', kind: 'melee',
      // 配色只能用暗红 / 琥珀金 / 冷灰三系（项目硬约定），
      // 原值 #6f8a5a 色相 94° 是橄榄绿，会破坏整体色调，改为土黄褐（色相 47°，落在琥珀金系）
      hp: 12, speed: 42, dmg: 5, r: 11, color: '#8a7b46'
    },
    {
      id: 'bat', name: '魆', tier: 'small', kind: 'melee',
      hp: 7, speed: 78, dmg: 3, r: 8, color: '#a3454d', wobble: 2.4   // 走位带正弦摆动
    },
    {
      // 原「骸骨弓手」是会放冷箭的远程单位。产品要求**怪物一律不做远程攻击**
      // （被屏幕外的箭打中没法躲，联机里尤其像掉帧），
      // 所以改成「快而脆的近战突击兵」：比僵尸快一倍、比魆耐打，压上来就得处理。
      id: 'skeleton_warrior', name: '骨魃', tier: 'swift', kind: 'melee',
      hp: 18, speed: 62, dmg: 8, r: 11, color: '#cfc7b0'
    },
    {
      id: 'gargoyle', name: '石魁', tier: 'elite', kind: 'melee',
      hp: 140, speed: 28, dmg: 15, r: 18, color: '#7d8590',
      knockResist: 0.8
    },
    {
      id: 'blood_priest', name: '巫傩', tier: 'commander', kind: 'buffer',
      // 原值 #8c2f4a 色相 342° 偏品红（带紫味），改为 357° 的纯正暗红
      hp: 320, speed: 24, dmg: 12, r: 17, color: '#8c3034',
      auraRadius: 180, auraSpeedMul: 1.3
    },
    {
      id: 'witch_hunter', name: '逐寇', tier: 'elite', kind: 'charger',
      hp: 240, speed: 50, dmg: 20, r: 16, color: '#b0793a',
      chargeCd: 3.2, chargeMul: 3.4, chargeSec: 0.55
    },
    {
      // 领主原来还会放射状弹幕。同样按「怪物不做远程」拆掉了，
      // 只留下贴身光环：压迫感靠「你不敢待在它旁边」来给，而不是靠躲屏幕外的弹。
      id: 'blood_lord', name: '罗睺', tier: 'boss', kind: 'boss',
      hp: 3200, speed: 34, dmg: 30, r: 40, color: '#7a1224',
      auraRadius: 240, auraDot: 6, auraTickSec: 0.5,
      bossStyle: 'lord'
    },

    // ---------------- 第 2 关「血色回廊」起登场 ----------------
    {
      id: 'plague_hound', name: '猊犬', tier: 'swift', kind: 'melee',
      // 全场最快的小怪：魆 78 已经算快，猊犬 96 就是「必须优先点掉」的存在。
      // 血量和伤害都压得很低 —— 它的威胁是「咬到你就跑不掉」，不是「一口咬死你」。
      hp: 11, speed: 96, dmg: 5, r: 9, color: '#7d6a3f',
      wobble: 1.6
    },
    {
      id: 'blood_spider', name: '蛊母', tier: 'swift', kind: 'melee',
      // 中速、成群。单只很弱，但一波能来十几只，逼玩家处理「数量」而不是「单点强度」
      hp: 14, speed: 70, dmg: 6, r: 9, color: '#8f2f3a',
      wobble: 3.2
    },

    // ---------------- 第 3 关「钟楼尖顶」起登场 ----------------
    {
      id: 'bone_knight', name: '甲骨卫', tier: 'elite', kind: 'melee',
      // 「墙」型精英：走得很慢、血很厚、抗击退。它不追人，它是**堵路**的 ——
      // 玩家被它和后面的小怪夹住时才会感觉到压力。伤害给得高，让「站着不动硬抗」不划算
      hp: 260, speed: 22, dmg: 18, r: 19, color: '#b8b3a2',
      knockResist: 0.9
    },
    {
      id: 'ghoul_matriarch', name: '魃母', tier: 'commander', kind: 'buffer',
      // 第二个光环单位，与巫傩区分开：巫傩加**速度**（让怪更凶），
      // 魃母加**血量上限**（让怪更难死）。两者一起出现时，玩家会明显感到清场变慢
      hp: 380, speed: 20, dmg: 14, r: 18, color: '#6f3a35',
      auraRadius: 200, auraHpMul: 1.4
    },

    // ---------------- Boss 变体（每 10 波一只，形象与强度递进） ----------------
    // 【为什么要多个 Boss】原来 40 波的局里，第 10/20/30/40 波出现的是**同一个领主**，
    // 只是血更厚。打到第二只时玩家已经知道怎么打了，剩下的就是重复劳动。
    // 现在四只各有形象与压迫方式，最后一只是真正的「最终试炼」。
    {
      id: 'bone_tyrant', name: '骨王', tier: 'boss', kind: 'boss',
      hp: 4200, speed: 30, dmg: 34, r: 42, color: '#a89f88',
      auraRadius: 250, auraDot: 7, auraTickSec: 0.5,
      bossStyle: 'tyrant'
    },
    {
      id: 'abyss_prelate', name: '冥君', tier: 'boss', kind: 'boss',
      hp: 5400, speed: 26, dmg: 38, r: 42, color: '#5c6270',
      auraRadius: 270, auraDot: 8, auraTickSec: 0.45,
      bossStyle: 'prelate'
    },
    {
      id: 'moon_queen', name: '望舒', tier: 'boss', kind: 'boss',
      hp: 7000, speed: 38, dmg: 44, r: 44, color: '#9c1f33',
      auraRadius: 300, auraDot: 10, auraTickSec: 0.4,
      bossStyle: 'queen'
    }
  ];

  // 每 10 波来的 Boss 顺序（波次 10/20/30/40）。
  // 写成数组而不是散在代码里：以后加第 5 只只要往这里补一项。
  const BOSS_ROTATION = ['blood_lord', 'bone_tyrant', 'abyss_prelate', 'moon_queen'];

  // ============================================================
  // 波次曲线
  // ============================================================

  const WAVES = {
    intervalSec: 30,
    // 开局第 1 波从 8 提到 12：8 只怪要花 20 多秒才从生成环走到玩家身边，
    // 前 2 分钟几乎是空的，玩家拿不到经验也就长不起来
    baseCount: 12,
    // 每波增量从 4 提到 5：让中期的怪量早点堆起来
    countPerWave: 5,
    countCap: 200,
    // 血量增长从 0.18 砍到 0.10：0.18 意味着 40 波后怪血涨 8 倍，
    // 而满级武器只有 2.3 倍伤害，后期必然打不动 → 改成 4.9 倍，与武器成长基本对齐
    hpGrowth: 0.10,
    bossEvery: 10
  };

  // ============================================================
  // 关卡（按波次推进的四个区域）
  // ============================================================
  // 【为什么需要它】原来全场只有一套 tier 权重（early/mid/late），而 tier 到怪种的
  // 映射是写死在 sim 里的（small → 僵尸/魆，elite → 石魁/逐寇…）。
  // 结果是「一局 40 波，从头到尾就是那 7 种怪，只是血越来越厚」——
  // 玩家在第 5 分钟和第 18 分钟看到的东西是一样的，中后期的唯一区别是数字。
  //
  // 现在改成：每关**直接给怪种权重**（而不是 tier 权重）。
  // 少一层映射换来的是「这一关刷哪些怪」这件事变得一眼可见、一处可改。
  //
  // 【为什么不按「关卡选择」而是按波次自动推进】联机局没法让 4 个人选不同的关卡；
  // 而「随着时间推移，地方越来越深」正好和波次曲线是同一件事，不用再造一套状态。
  // 区域名会显示在 HUD 上（见 getHud 的 stageName），玩家能感知到自己推进到了哪。
  const STAGES = [
    {
      // ★name 要与 maps.js 里同 id 的地图名**一致** —— 它显示在 HUD 的「第几关」上
      //   （getHud 的 stageName），而 artshot 正是拿 stageForWave(w).name 与
      //   stageForWave 读到的地图名互相比对。两边不同名 = 同一屏出现两个叫法。
      //   第十八轮改地图名时漏了这张表，artshot 的两条断言立刻抓出来了 ——
      //   这正是那两条断言存在的意义。
      id: 'graveyard', name: '乱葬岗', from: 1, to: 4,
      // 开局两分钟：只有最基础的两只。这里不是「简单」，是「教学」——
      // 玩家要在这段里学会走位和拾取，不该被速度型怪追着跑
      pool: { corpse: 70, bat: 30 }
    },
    {
      id: 'corridor', name: '轮回廊', from: 5, to: 9,
      // 第一个转折点：速度型怪登场（猊犬 96 速比玩家 120 只慢一点）。
      // 「跑得掉」的感觉从这里开始消失，玩家必须开始用武器清场而不是靠腿
      pool: { bat: 24, plague_hound: 26, blood_spider: 26, skeleton_warrior: 24 }
    },
    {
      // ⚠️id 是 'belfry'，而 maps.js 里那张图的 id 是 'cathedral' —— 两边对不上，
      //   是**改动地图 id 时漏改这里**留下的历史遗留（第十八轮改名时发现的）。
      //   为什么一直没坏：stageForWave() 只读本表的 name，从来不拿 id 去查地图表，
      //   而 STAGES 也不负责决定用哪张地图（那是 MAPS 按波次自己推进的）。
      //   ★所以**不要**为了「对齐」去改 id —— 改了要连带改地图选择器、存档、
      //   地图偏好（MAP_KEY）等多处，收益为零、风险很大。这里只保证 name 显示正确。
      id: 'belfry', name: '祭天台', from: 10, to: 14,
      // 精英登场：石魁（高血抗击退）与逐寇（冲锋）逼玩家处理**单体威胁**，
      // 而不再是「一堆小怪一起打」。甲骨卫在这里作为「墙」加入
      pool: {
        skeleton_warrior: 24, blood_spider: 20, plague_hound: 12,
        gargoyle: 16, witch_hunter: 12, bone_knight: 10, blood_priest: 6
      }
    },
    {
      id: 'altar', name: '血月祭坛', from: 15, to: 9999,
      // 收官区：全部怪种混编，且光环单位（巫傩加攻速、魃母加血量）同时在场 ——
      // 清场速度会明显变慢，这正是「最后一程」该有的压迫
      pool: {
        plague_hound: 16, blood_spider: 16, skeleton_warrior: 14,
        gargoyle: 14, bone_knight: 12, witch_hunter: 10,
        blood_priest: 5, ghoul_matriarch: 5
      }
    }
  ];

  // 同屏怪物硬上限（保护客户端帧率）
  const MAX_MOBS = 1200;

  // ============================================================
  // 初始角色（8 个）
  // ============================================================
  // mods 是对最终属性的乘算偏移，1 表示不变。
  //
  // accent 是角色在**战场上的主色**，也是选择界面立绘的主色。
  // 【为什么每个角色必须有自己的一眼可辨的颜色】多人局里四个人挤在一起打的时候，
  // 光看头顶名牌是不够的（名牌会被怪、特效、伤害数字挡住）。轮廓色是最快的那条线索。
  //
  // 配色用**马卡龙色系**：8 个角色各占一个色系，色相尽量均匀铺开（见下表）。
  // 原来那套（米白/象牙白/冷灰蓝/棕/银灰/暗褐灰/暗红/土黄）问题在于
  // **明度都压在中间偏低的一小段里、色相也挤在暖灰区** —— 米白与象牙白、
  // 冷银灰与冷灰蓝、暗褐灰与土黄，两两眼看着几乎一样，等于没有区分。
  //
  // 三条硬约束（改配色时必须一起守）：
  //   ① **不用紫 / 紫蓝**（项目约定）；
  //   ② **不碰「玩家公共元素」**：外圈暗红、琥珀金点缀是所有角色共用的
  //      —— 它们承担的是「这是玩家 / 这是奖励」的类别信息，一旦被角色色带跑就废了；
  //   ③ 深色（斗篷/帽袍）必须是**主色压暗**，不能各配各的灰 ——
  //      否则剪影会变成「亮脑袋 + 灰身子」，色系感全丢。
  //
  // ★ 色值在**三个文件**里各有一份（此处 / public/js/player-art.js /
  //   public/js/character-portraits.js），改一个必须改三个。
  //   tools/artshot.js 有一条断言逐角色比对这三处的主色 —— 漏改会被它拦下。
  //
  // 色相分布（0° 红 → 顺数）：猎魔人 5° 蜜桃珊瑚 / 铁匠 30° 焦糖拿铁 /
  // 修女 46° 香草奶油 / 苦行僧 74° 嫩芽黄绿 / 学者 116° 抹茶 /
  // 盗贼 168° 薄荷青 / 圣殿骑士 209° 雾天蓝 / 巫女 342° 莓果红。
  //
  // 【为什么要按「两两 RGB 距离」验一遍，而不是只看色相】色相铺得再开，
  // 只要明度接近，看着还是同一个颜色。第一版就栽在这：抹茶(166,214,162) 与
  // 薄荷(134,214,195) 色相差 53° 但 RGB 距离只有 46 —— 小人的轮廓里几乎一样。
  // 修法是**同时拉明度**：暖区做成「亮粉 → 中暗棕 → 亮奶白」三档，
  // 冷区做成「深绿 / 浅青 / 深蓝」夹心。改完最小距离 57，其余都 ≥59
  //（tools/artshot.js 有一条断言守着这个下限）。
  //
  // 新增角色的原则：**每一个都要有一个明确的取舍**，不能只是「另一个均衡型」。
  // 单纯数值更好的角色会让其它角色失去意义；每个角色都要有「什么时候选它」的答案。

  const CHARACTERS = [
    {
      // ★命名与 narrative 统一（第十八轮改名）：本名直接用神话人物。
      //   以前这里叫「猎魔人」，而剧情模式（campaign.js）另有一套神话改名表把它显示成「刑天」，
      //   于是同一个角色在自由模式/大厅是洋名、进剧情才变神话名 —— 玩家会觉得是两个角色。
      //   现在**本名就是神话名**，故事内外一致，id 仍然一个字没动（存档与协议都不受影响）。
      id: 'hunter', name: '刑天', weapon: 'whip',
      desc: '均衡属性，新手友好', mods: {}, guestAllowed: true,
      accent: '#F09A93'
    },
    {
      id: 'nun', name: '后土', weapon: 'garlic',
      desc: '范围 +15%，伤害 -10%，清小怪快', mods: { range: 1.15, dmg: 0.9 },
      accent: '#F5E4AC'
    },
    {
      id: 'scholar', name: '文昌', weapon: 'homing_orb',
      // 主色从紫灰 #d4c9e2 改成冷灰蓝：紫灰色违反项目「不用紫/紫蓝」的约定
      desc: '冷却 -12%，血量 -15%，高频输出', mods: { cd: 0.88, hp: 0.85 },
      accent: '#7FBF7A'
    },
    {
      id: 'blacksmith', name: '祝融', weapon: 'judge_hammer',
      desc: '伤害 +15%，移速 -10%，高爆发', mods: { dmg: 1.15, speed: 0.9 },
      accent: '#B8834F'
    },

    // ---------------- 新增四位 ----------------
    {
      id: 'knight', name: '玄武', weapon: 'boomerang',
      // 「扛得住」而不是「打得快」：血量 +25%、再给 1 点常驻护甲。
      // 代价是移速 -12% 且伤害 -8% —— 他清场慢，但很难被打死。
      // 多人局里这是「站前排拖住怪堆」的角色，不是输出核心。
      desc: '血量 +25%，常驻护甲 1，但移速与伤害各减，靠扛',
      mods: { hp: 1.25, speed: 0.88, dmg: 0.92 },
      armor: 1,
      accent: '#6FA8DC'
    },
    {
      id: 'thief', name: '窃火', weapon: 'nail',
      // 「跑得快、捡得多、很脆」：移速 +18%、拾取范围 +45%、经验 +10%。
      // 血量 -22% 是核心代价 —— 他靠走位和更快的成长曲线活着。
      // 拾取范围给这么多是有意的：角色的经济优势要体现在「不用绕远路捡球」上。
      desc: '移速 +18%，拾取范围 +45%，经验 +10%，但血量 -22%',
      mods: { speed: 1.18, pickup: 1.45, exp: 1.10, hp: 0.78 },
      accent: '#86D6C3'
    },
    {
      id: 'witch', name: '魃', weapon: 'holy_water',
      // 「大范围、低频率」：范围 +28%、冷却 +10%（更慢）。
      // 与后土（范围 +15%、伤害 -10%）的区别在于她是**更极端的范围特化**，
      // 代价也更大 —— 魃怕的是「贴脸的高速怪」，因为她出手慢。
      desc: '范围 +28%，但冷却 +10%，一出手就是一片',
      mods: { range: 1.28, cd: 1.10, hp: 0.95 },
      accent: '#C2607E'
    },
    {
      id: 'monk', name: '行者', weapon: 'scripture',
      // 「高频、低血」：冷却 -20%（比文昌的 -12% 更狠）、血量 -20%。
      // 与文昌的区别：文昌靠追踪法球（自动命中），行者靠环绕经卷（要贴脸）。
      // 所以他必须一直待在怪堆边缘 —— 血量低是真的危险，不是数字上的代价。
      desc: '冷却 -20%，血量 -20%，贴身高频，走位要求高',
      mods: { cd: 0.80, hp: 0.80 },
      accent: '#B8CE6E'
    }
  ];

  // ============================================================
  // 掉落与拾取
  // ============================================================

  const DROPS = {
    // 单只小怪经验从 1 提到 2：升级是唯一成长手段，
    // 配合 EXP.step 5→5，把「杀怪 → 变强」的循环拉回正反馈
    expValueSmall: 2,

    // ---------- 大经验球 ----------
    // 【为什么要分级】原来所有怪掉的经验球长得一模一样、值也一样（2 点）。
    // 打到后期升级越来越慢时，地上永远是同一堆小点，玩家完全感觉不到
    // 「这一波我清得比上一波好」。大球的作用是**即时的正反馈**：
    // 它不只是数值更大，它在画面上就明显更大、更亮、要专门走过去捡。
    //
    // 概率给 18%：平均每 5-6 只小怪掉一颗 —— 一波 30 只怪的场面里能见到 5 颗左右，
    // 足够「时不时来一下」，又不会让小球失去意义。
    expValueBig: 12,
    bigExpChance: 0.18,

    expValueElite: 6,
    // 精英掉的大球更值钱（精英本来就少，来了就该给得干脆）
    expValueEliteBig: 26,
    // 精英掉大球的概率远高于小怪 —— 「打得越费劲，掉得越像样」
    eliteBigChance: 0.6,

    // ---------- Boss 的巨量经验 ----------
    // 【为什么是一堆球而不是一颗超大球】Boss 血厚、移动慢、通常死在怪堆深处。
    // 掉一颗球意味着「要么冒险全拿，要么一点都不拿」；掉一圈球则是
    // 「能拿多少看你能站多久」—— 后者才是战斗结束后该有的收尾动作。
    // 而且一圈球炸开的画面本身就是这段战斗的句号（见 killMob 的环状撒落）。
    expValueBoss: 60,          // 保留：老逻辑/老脚本读它时仍有意义
    bossExpOrbs: 10,           // 爆几颗
    bossExpOrbValue: 48,       // 每颗多少（合计约 480，约等于 8~10 级）
    bossExpRingR: 92,          // 撒落半径

    // 金币掉落概率（金面具可放大）。
    // 从 0.18 提到 0.24：金币现在有了**实际用途**（暂停面板的商店），
    // 而「有用途但玩家没注意到」等于没有 —— 一波 30 只怪里出 7~8 枚，
    // 玩家才会开始为了捡它而调整走位，那才是掉落本该产生的决策。
    goldChance: 0.24,
    goldValue: 1,
    heartChance: 0.012,      // 红心掉落概率
    heartHeal: 20,
    // 经验球会被磁石吸过来，超过这个距离就直接吸附
    magnetAttractDist: 200,  // 原 130，配合拾取半径放宽，减少「为了捡球往怪堆里钻」
    magnetSpeed: 340,

    // 宝箱：Boss 死亡必掉一个（见 sim.js 的 killMob）。
    // 掉落物里唯一「不是资源而是奖励」的东西 —— 拾取后直接给一次免费升级，
    // 所以它的价值必须明显高于随便一堆经验球，否则玩家不会为它冒险走过去。
    chest: {
      life: 120,          // 比普通掉落存活更久（普通 60 秒）：Boss 常死在怪堆深处，
                          // 玩家往往要清完场才敢回去拿，60 秒经常来不及
      freeLevelUps: 1,    // 拾取即获得几次免费升级（走正常的升级三选一）
      gold: 15            // 附带一小笔金币，让「拿到手」这件事有即时反馈
    }
  };

  // ============================================================
  // 局内商店（用金币买）
  // ============================================================
  // 【为什么需要它】金币原来只做一件事：掉在地上、捡起来、在结算页显示一个数字。
  // 玩家全程看不到它有什么用，掉落也就成了「捡不捡无所谓」——
  // 而一个没有用途的资源，玩家不会为它改变路线（那正是它本该产生的决策）。
  //
  // 【为什么放在「暂停」里】单机暂停时世界真的冻结（game.js 的 screen='paused'
  // 会让 loop 不再 step），所以在那一屏购物是**安全的**。
  // 联机世界停不下来 → 商店只在单机可用，联机菜单里不出现这个入口
  // （详见 game.js 的 canShop）。绝不能出现「联机也能买但世界在跑」的半吊子设计。
  //
  // 【定价原则】金币产出速度：goldChance 0.18 × 一波 12~30 只 ≈ 每波 2~5 枚，
  // 加上宝箱 15 枚，一局 40 波大约能攒 120~200 枚。
  // 所以价格按「一件东西约等于十几秒的收成」来定 ——
  // 贵到需要取舍（不能每波都买），又便宜到买了立刻有感（不像是攒一辈子才买得起）。
  const SHOP = {
    // 出售中的三样东西。id 是程序内部用的键，界面读 name/desc/price/cost。
    items: [
      {
        id: 'heal',
        name: '急救绷带',
        desc: '立刻回复 60 点生命',
        price: 30,
        // cost 里写的是「效果参数」，具体怎么生效由 sim 的 shopBuy 决定。
        // 放在数据里而不是逻辑里，是为了让「加什么、多少钱」这一句话说得清。
        cost: { hp: 60 },
        // 买不了时界面要说出原因（否则玩家以为按钮坏了）
        noGold: '金币不够'
      },
      {
        id: 'exp',
        name: '亡者笔记',
        desc: '立刻获得 120 点经验',
        price: 45,
        cost: { exp: 120 },
        noGold: '金币不够'
      },
      {
        id: 'buff',
        name: '血契石',
        desc: '本局伤害 +12%（可叠加，最多 3 层）',
        price: 70,
        cost: { dmgMul: 0.12 },
        maxStacks: 3,
        noGold: '金币不够'
      },

      // ============================================================
      // 本轮新增：金币能买技能了（第十六轮补③）
      // ============================================================
      // 【为什么原来只有三样东西不够】绷带/笔记/血契石都只是「数值变大一点」——
      // 玩家的金币花不出一条**路线**。而这一局的乐趣全在「我练什么、凑哪组组合技」上，
      // 所以金币最该买到的就是**技能本身**：它把「打得多」直接换成「build 的选择权」。
      //
      // 【定价】一局 40 波大约攒 120~200 枚（见上面的定价原则），所以：
      //   血脉契约 120 —— 大约是一整局的收成，属于「这一局我要认真塑造一次 build」，
      //     贵到不能随手点，但中期认真攒是摸得到的。
      //   置换契约 80 —— 比买新的便宜：它是**拿一件换一件**，玩家并没有凭空多拿东西，
      //     只是把前期选错的那件救回来。这个价格要让「选错了」有救，
      //     否则一旦学错就整局废掉，那才是真正的惩罚。
      //
      // ★`pick` 类商品是**两段式**的：先点商品，再选具体哪一件技能（见 sim 的 shopBuy）。
      //   sim 在收到 pick 商品但**没带选择**时一分钱都不扣，只回 `needPick` 让界面去开选择器——
      //   钱与效果依然是一次判定、一次结算，不存在「先扣钱再选」的中间态。
      {
        id: 'contract_new',
        name: '血脉契约',
        desc: '从全部武器 / 被动里任选一件，立刻习得 1 级',
        price: 120,
        pick: 'new',
        noGold: '金币不够'
      },
      {
        id: 'contract_swap',
        name: '置换契约',
        desc: '遗忘一件已学技能，改学另一件（被遗忘的等级不保留）',
        price: 80,
        pick: 'swap',
        noGold: '金币不够'
      }
    ],
    // 金币掉落的视觉/手感参数（商店上线后金币变得重要，掉得稍微明显一点）
    // 从 0.18 提到 0.22：多掉一点不是为了通货膨胀，而是**让玩家注意到地上有金币**——
    // 一个玩家没注意到的东西，再有用途也等于没有。
    dropChanceBonus: 0
  };

  // ============================================================
  // 工具函数
  // ============================================================

  // 按 id 取难度定义
  const DIFF_MAP = {};
  for (let i = 0; i < DIFFICULTIES.length; i++) DIFF_MAP[DIFFICULTIES[i].id] = DIFFICULTIES[i];

  // 难度 id 归一化：认不出来的（旧客户端、手改包、拼错的）一律落到「普通」。
  // 与角色/头像的兜底策略一致 —— 这类字段不值得为它中断开局。
  function normalizeDiffId(id) {
    const d = DIFF_MAP[id];
    return d ? d.id : 'normal';
  }

  // 按 id 取难度，取不到给「普通」（注意返回的是对象本身，调用方别改它）
  function diffById(id) {
    return DIFF_MAP[id] || DIFF_MAP.normal;
  }

  // 按 id 取武器定义（含进化形态）
  const WEAPON_MAP = {};
  for (let i = 0; i < WEAPONS.length; i++) WEAPON_MAP[WEAPONS[i].id] = WEAPONS[i];
  for (let i = 0; i < EVOLUTIONS.length; i++) WEAPON_MAP[EVOLUTIONS[i].id] = EVOLUTIONS[i];

  // 按 id 取被动定义
  const PASSIVE_MAP = {};
  for (let i = 0; i < PASSIVES.length; i++) PASSIVE_MAP[PASSIVES[i].id] = PASSIVES[i];

  // 按 id 取怪物定义
  const MOB_MAP = {};
  for (let i = 0; i < MOBS.length; i++) MOB_MAP[MOBS[i].id] = MOBS[i];

  // 按 id 取角色定义
  const CHAR_MAP = {};
  for (let i = 0; i < CHARACTERS.length; i++) CHAR_MAP[CHARACTERS[i].id] = CHARACTERS[i];

  // 按 id 取组合技定义
  const COMBO_MAP = {};
  for (let i = 0; i < COMBOS.length; i++) COMBO_MAP[COMBOS[i].id] = COMBOS[i];

  // 进化查询：from(武器id) -> 进化定义
  const EVO_BY_WEAPON = {};
  for (let i = 0; i < EVOLUTIONS.length; i++) EVO_BY_WEAPON[EVOLUTIONS[i].from] = EVOLUTIONS[i];

  // 组合技查询：把 need 里两个 id 排序后拼成 key。
  // 【为什么要排序】need 写成 ['whip','garlic'] 还是 ['garlic','whip'] 是同一件事，
  // 玩家不可能记住定义里的书写顺序。排序后再查表，两种写法都能命中，
  // 而且「玩家当前凑齐了哪些组合」可以一次遍历算出来（见 COMBOS_BY_PAIR）。
  function comboKey(a, b) {
    return a < b ? (a + '|' + b) : (b + '|' + a);
  }
  const COMBOS_BY_PAIR = {};
  for (let i = 0; i < COMBOS.length; i++) {
    COMBOS_BY_PAIR[comboKey(COMBOS[i].need[0], COMBOS[i].need[1])] = COMBOS[i];
  }

  // 进化查询：from(武器id) -> 进化定义（COMBOS 之后一起挂上去）
  for (let i = 0; i < COMBOS.length; i++) WEAPON_MAP[COMBOS[i].id] = COMBOS[i];

  // 按等级算武器实际数值。进化形态不再成长，直接返回其 base。
  function weaponStats(def, level) {
    // 组合技的成长上限是 3 级（不是武器的 8 级）：它一解锁就已经很强，
    // 再加 8 级成长会让「凑组合」变成唯一解 —— 那样其它武器就没有存在意义了。
    const maxLv = def.combo ? (def.maxLevel || 3) : GROWTH.maxLevel;
    const L = def.evolved ? 0 : Math.max(0, Math.min(level, maxLv) - 1);

    let dmg = def.base.dmg * (1 + GROWTH.dmg * L);
    const cd = def.base.cd * (1 + GROWTH.cd * L);
    const range = def.base.range * (1 + GROWTH.range * L);

    // 4 级 +1 投射物（进化的数量写死在定义里）。
    // 组合技不吃这一条：它的上限只有 3 级，永远够不到 4 级，写了也是死代码。
    let projectiles = def.projectiles || 1;
    if (!def.evolved && !def.combo && level >= GROWTH.extraProjectileAt) projectiles += 1;

    // 满级质变：未进化的武器在满级享受一次全局增益（伤害 +25%）。
    // 组合技给 +20%（比普通武器略低，因为它起点本来就高）。
    // 真正的进化形态需要「满级武器 + 对应满级被动」合成，不在这里。
    const isMaxed = !def.evolved && level >= maxLv;
    if (isMaxed) dmg *= def.combo ? 1.2 : 1.25;

    return {
      dmg: dmg,
      cd: Math.max(0.15, cd),
      range: range,
      projectiles: projectiles,
      isMaxed: isMaxed
    };
  }

  // 升级所需经验
  function expNext(level) {
    return EXP.base + (level - 1) * EXP.step;
  }

  // 某一波属于哪一关。
  // 从前往后找第一个覆盖它的区间 —— 最后一关的 to 写成 9999，所以永远不会落空，
  // 不需要兜底分支（少一处判空就少一处「新手改完忘了兜底」的坑）。
  function stageForWave(wave) {
    for (let i = 0; i < STAGES.length; i++) {
      if (wave >= STAGES[i].from && wave <= STAGES[i].to) return STAGES[i];
    }
    return STAGES[STAGES.length - 1];
  }

  // 某一波该用哪张怪种权重表（直接喂给 pickWeighted）
  function stagePool(wave) {
    return stageForWave(wave).pool;
  }

  // 这一波来的 Boss 是哪一个。
  // 第 10 波 → 第 1 只，第 20 波 → 第 2 只……超过轮换表长度就取模循环。
  // 【为什么用取模而不是"到底了就用最强的那只"】取模让「打满一轮」的玩家第 5 次
  // 又见到第一只 —— 那时他的装备已经完全不同，重打一次不是重复而是对照。
  function bossForWave(wave) {
    const idx = Math.floor(wave / WAVES.bossEvery) - 1;
    if (idx < 0) return BOSS_ROTATION[0];
    return BOSS_ROTATION[idx % BOSS_ROTATION.length];
  }

  // 单波怪物数量
  function waveCount(wave) {
    return Math.min(WAVES.baseCount + (wave - 1) * WAVES.countPerWave, WAVES.countCap);
  }

  // 单波血量系数
  function waveHpMul(wave) {
    return 1 + (wave - 1) * WAVES.hpGrowth;
  }

  // 某波是否为 Boss 波
  function isBossWave(wave) {
    return wave > 0 && wave % WAVES.bossEvery === 0;
  }

  // ============================================================
  // 交叉信息反查（供「升级候选补关联说明」用）
  // ============================================================
  // 【为什么需要反查】升级三选一里，玩家看到「铁鞭 Lv3 → Lv4」时，
  // 他真正想知道的是「**练它有什么用**」——它能凑哪个组合技、能合成什么进化形态。
  // 而组合技的定义是「need: [两件武器]」这一个方向，从武器查不到。
  //
  // 【为什么不写成手写清单】手写的话，加一把新武器就必然漏掉在这里——
  // 而漏掉的表现是「说明里没提组合技」，玩家少知道一条路线，测试也看不出来。
  // 从 COMBOS / EVOLUTIONS **派生**才是唯一能保证一致的做法
  // （与 skillbook.js 的 KIND_LABEL 完备性断言同一个思路）。
  //
  // ★必须放在 COMBOS / EVOLUTIONS / EVO_BY_WEAPON 定义**之后**，
  //   否则启动就报「is not defined」（这里踩过一次）。
  const COMBOS_BY_WEAPON = {};
  for (let i = 0; i < COMBOS.length; i++) {
    const cb = COMBOS[i];
    for (let j = 0; j < cb.need.length; j++) {
      if (!COMBOS_BY_WEAPON[cb.need[j]]) COMBOS_BY_WEAPON[cb.need[j]] = [];
      // ★连「另一件是谁」一起存下来（other）。
      //   升级候选卡要把它拎出来高亮（显示玩家已有几级 / 未持有），
      //   而这里不存的话，消费方拿到的只有 id/name/needLevel，
      //   想知道另一半是谁就只能反查 COMBOS —— 那等于把同一件事记在两个地方。
      //   组合技固定是「两件武器」，所以另一件就是 need 里另一个下标。
      COMBOS_BY_WEAPON[cb.need[j]].push({
        id: cb.id,
        name: cb.name,
        needLevel: cb.needLevel,
        other: cb.need.length === 2 ? cb.need[1 - j] : null
      });
    }
  }

  // 被动 → 它能凑出哪些进化（进化的另一半配方）
  const EVOS_BY_PASSIVE = {};
  for (let i = 0; i < EVOLUTIONS.length; i++) {
    const e = EVOLUTIONS[i];
    if (!EVOS_BY_PASSIVE[e.need]) EVOS_BY_PASSIVE[e.need] = [];
    EVOS_BY_PASSIVE[e.need].push({
      id: e.id,
      name: e.name,
      from: e.from,
      fromName: (WEAPON_MAP[e.from] ? WEAPON_MAP[e.from].name : e.from)
    });
  }

  // 升级候选要显示的关联说明。返回空数组表示「这条技能没有关联」，界面就不显示那行。
  //
  // 【为什么算「还差几级」而不是只写「可凑XX」】只写「可凑血雾领域」的话，
  // 玩家已经 Lv7 了却还在提示「可凑」—— 那信息量是零。带上「已 7/5 级，配方已齐」，
  // 玩家立刻知道下一步该做什么。
  function weaponLinks(weaponId, ownLevel) {
    const out = [];
    const list = COMBOS_BY_WEAPON[weaponId];
    if (list) {
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        const lv = ownLevel || 0;
        out.push({
          kind: 'combo',
          name: c.name,
          // 齐了 / 还差几级 —— 两种说法给的都是「可执行的下一步」
          state: lv >= c.needLevel ? 'ready' : 'short',
          // ★结构化字段：配方里的**另一件**是谁。
          //   只给一句 text 是没法高亮的 —— 界面必须知道「该把哪一件拎出来标」。
          //   c.need 是两件武器的 id，去掉自己那件就是另一件。
          // other 在构建 COMBOS_BY_WEAPON 时就一起存好了（上面那段）
          pairId: c.other || null,
          pairKind: 'weapon',
          needLevel: c.needLevel,
          text: '可凑组合技「' + c.name + '」' +
            (lv >= c.needLevel ? '（另一件也到 ' + c.needLevel + ' 级即可）'
                               : '（需要 ' + c.needLevel + ' 级）')
        });
      }
    }
    const evo = EVO_BY_WEAPON[weaponId];
    if (evo) {
      out.push({
        kind: 'evo',
        name: evo.name,
        state: 'evo',
        // 进化需要的另一半是被动（EVOLUTIONS 的 need 字段）
        pairId: evo.need,
        pairKind: 'passive',
        needLevel: PASSIVE_MAX_LEVEL,
        text: '满级后配「' + (PASSIVE_MAP[evo.need] ? PASSIVE_MAP[evo.need].name : evo.need) +
          '」可进化为「' + evo.name + '」'
      });
    }
    return out;
  }

  // 被动的关联说明：它能凑出哪些进化（需要哪把武器满级）
  function passiveLinks(passiveId) {
    const out = [];
    const list = EVOS_BY_PASSIVE[passiveId];
    if (!list) return out;
    for (let i = 0; i < list.length; i++) {
      out.push({
        kind: 'evo',
        name: list[i].name,
        state: 'evo',
        // 这条是从「被动」侧看的：另一半是武器，且要满级
        pairId: list[i].from,
        pairKind: 'weapon',
        needLevel: GROWTH.maxLevel,
        text: '配满级「' + list[i].fromName + '」可进化为「' + list[i].name + '」'
      });
    }
    return out;
  }

  return {
    TICK_HZ, DT, MAP, PLAYER, EXP, SLOTS, MATCH_SEC, GROWTH, PASSIVE_MAX_LEVEL,
    DIFFICULTIES, DIFF_MAP, normalizeDiffId, diffById,
    WEAPONS, PASSIVES, EVOLUTIONS, COMBOS, MOBS, WAVES, STAGES, BOSS_ROTATION, MAX_MOBS,
    CHARACTERS, DROPS, SHOP,
    WEAPON_MAP, PASSIVE_MAP, MOB_MAP, CHAR_MAP, EVO_BY_WEAPON,
    COMBO_MAP, COMBOS_BY_PAIR, comboKey,
    COMBOS_BY_WEAPON, EVOS_BY_PASSIVE, weaponLinks, passiveLinks,
    weaponStats, expNext, waveCount, waveHpMul, isBossWave,
    stageForWave, stagePool, bossForWave
  };
});
