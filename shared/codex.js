// shared/codex.js —— 「山海榜」的纯数据与判定：山海谱天赋 / 成就 / 图鉴 / 武器精通
//
// 为什么单独一个 shared 文件：
//   ① 天赋的加成必须**前后端同源**（单机在浏览器里算，以后若要联机放开也只改传参）；
//   ② 成就是「声明式条件」，能被 Node 里的回归脚本直接跑，不用开浏览器。
// 写法与 const.js / maps.js 一致：UMD，Node require 拿到对象，浏览器挂 VS.CODEX。
//
// 【约定】本文件不碰 DOM、不碰 localStorage —— 存档读写在 public/js/progress.js。
//   这样 tools/progresstest.js 才能在 Node 里直接验证判定逻辑。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./const.js'));
  } else {
    root.VS = root.VS || {};
    root.VS.CODEX = factory(root.VS.CONST);
  }
})(typeof self !== 'undefined' ? self : this, function (C) {

  // ============================================================
  // 一、山海谱（局外天赋树）
  // ============================================================
  //
  // 【设计原则】只给「舒适度」，不给「上限伤害」以外的暴击式成长：
  //   · 生命 / 移速 / 拾取 / 开局金币 → 让新手活下来，不改变打法；
  //   · 伤害 / 冷却 → 有感，但每级只有 5% / 4%，且**单机与剧情生效**，
  //     联机一律不传（服务端不认客户端天赋，见 game.js 的开局参数）。
  //
  // per 里的键和 sim 的 attrs 一一对应，加新节点前先确认 recalcAttrs 里读它：
  //   hp        生命上限（绝对值，和神龛的 hp 同一位置汇总）
  //   speedMul  移速倍率
  //   pickupMul 拾取倍率
  //   dmgMul    伤害倍率
  //   cdMul     冷却乘区（负数 = 更快）
  //   gold      开局金币（不是可花余额 shopGold 的直接来源，见 makePlayer）
  const TALENTS = [
    { id: 'vigor', name: '炼气', desc: '生命上限 +12', per: { hp: 12 }, max: 3, costs: [30, 60, 120] },
    { id: 'stride', name: '疾行', desc: '移速 +6%', per: { speedMul: 0.06 }, max: 3, costs: [30, 60, 120] },
    { id: 'hand', name: '引灵', desc: '拾取范围 +15%', per: { pickupMul: 0.15 }, max: 3, costs: [25, 50, 100] },
    { id: 'purse', name: '聚宝', desc: '开局金币 +20', per: { gold: 20 }, max: 3, costs: [25, 50, 100] },
    { id: 'blade', name: '利刃', desc: '伤害 +5%', per: { dmgMul: 0.05 }, max: 3, costs: [40, 80, 160] },
    { id: 'focus', name: '凝神', desc: '技能冷却 -4%', per: { cdMul: -0.04 }, max: 3, costs: [40, 80, 160] }
  ];

  const TALENT_MAP = {};
  for (let i = 0; i < TALENTS.length; i++) TALENT_MAP[TALENTS[i].id] = TALENTS[i];

  // 某一级的价钱（levels 是「已有几级」）。满级返回 null，界面据此禁用按钮。
  function talCost(def, level) {
    if (!def || level >= def.max) return null;
    const arr = def.costs || [];
    return arr[level] === undefined ? null : arr[level];
  }

  // 把「{id: 等级}」折成一份加成。表里没有的 id、超上限的等级一律夹掉 ——
  // 老存档或手改过的存储不能让玩家凭空多出属性。
  function talBonus(levels) {
    const out = { hp: 0, speedMul: 0, pickupMul: 0, dmgMul: 0, cdMul: 0, gold: 0, used: 0 };
    if (!levels) return out;
    for (let i = 0; i < TALENTS.length; i++) {
      const def = TALENTS[i];
      let lv = levels[def.id] || 0;
      if (lv < 0) lv = 0;
      if (lv > def.max) lv = def.max;
      if (!lv) continue;
      out.used += lv;
      const per = def.per || {};
      const keys = ['hp', 'speedMul', 'pickupMul', 'dmgMul', 'cdMul', 'gold'];
      for (let k = 0; k < keys.length; k++) {
        const key = keys[k];
        if (per[key]) out[key] += per[key] * lv;
      }
    }
    return out;
  }

  // 已花掉的灵玉（用于大厅显示「累计修行」）
  function talSpent(levels) {
    let sum = 0;
    for (let i = 0; i < TALENTS.length; i++) {
      const def = TALENTS[i];
      let lv = (levels && levels[def.id]) || 0;
      if (lv > def.max) lv = def.max;
      for (let j = 0; j < lv; j++) sum += (def.costs[j] || 0);
    }
    return sum;
  }

  // ============================================================
  // 二、成就（声明式条件，便于 Node 直接跑）
  // ============================================================
  //
  // 条件分两类：
  //   total  累计维度的下限（codes 里的累计统计）
  //   run    单局维度的下限（本局 summary）
  // 判定就是「每个键都达标」，不需要给每条成就写一个函数 —— 那样没法测。
  const ACHIEVEMENTS = [
    { id: 'first_blood', name: '初次猎杀', desc: '累计击杀 1 只怪', total: { kills: 1 } },
    { id: 'kill_500', name: '小有斩获', desc: '累计击杀 500 只怪', total: { kills: 500 } },
    { id: 'kill_5000', name: '尸山血海', desc: '累计击杀 5000 只怪', total: { kills: 5000 } },
    { id: 'wave_10', name: '站稳脚跟', desc: '单局撑到第 10 波', run: { wave: 10 } },
    { id: 'wave_20', name: '久战不倒', desc: '单局撑到第 20 波', run: { wave: 20 } },
    { id: 'gold_500', name: '满载而归', desc: '单局赚到 500 金币', run: { gold: 500 } },
    { id: 'level_30', name: '修行有成', desc: '单局升到 30 级', run: { level: 30 } },
    { id: 'combo_5', name: '万象归一', desc: '单局解锁 5 个组合技', run: { combos: 5 } },
    { id: 'evolve_1', name: '兵器进化', desc: '单局完成一次武器进化', run: { evolutions: 1 } },
    { id: 'shrine_3', name: '三祝齐临', desc: '单局领到三种神龛祝福', run: { shrineKinds: 3 } },
    { id: 'challenger_1', name: '逐日者', desc: '累计击败 1 名挑战者', total: { challengers: 1 } },
    { id: 'win_1', name: '初平裂隙', desc: '通关一次', total: { wins: 1 } },
    { id: 'win_5', name: '补天者', desc: '通关 5 次', total: { wins: 5 } },
    { id: 'mob_10', name: '见多识广', desc: '图鉴收录 10 种妖物', total: { mobKinds: 10 } },
    // ★阈值在下面 MOB_LIST 建好之后回填 —— 写死一个数字的话，
    //   一旦表里的怪少于这个数，这条成就永远解不开（且不会报错，只会静默失效）。
    { id: 'mob_all', name: '博物志', desc: '图鉴全收录', total: { mobKinds: 0 } },
    { id: 'master_1', name: '一器通神', desc: '把一件武器练到「精通」', total: { mastered: 1 } }
  ];

  const ACH_MAP = {};
  for (let i = 0; i < ACHIEVEMENTS.length; i++) ACH_MAP[ACHIEVEMENTS[i].id] = ACHIEVEMENTS[i];

  // 一条成就是否达标：ctx = { total: {...}, run: {...} }
  function achMet(ach, ctx) {
    if (!ach) return false;
    const bag = { total: (ctx && ctx.total) || {}, run: (ctx && ctx.run) || {} };
    const groups = ['total', 'run'];
    for (let g = 0; g < groups.length; g++) {
      const need = ach[groups[g]];
      if (!need) continue;
      const have = bag[groups[g]];
      const keys = Object.keys(need);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if ((have[k] || 0) < need[k]) return false;
      }
    }
    return true;
  }

  // ============================================================
  // 三、图鉴 / 武器精通
  // ============================================================
  //
  // 图鉴条目直接从 const.js 的 MOBS 派生，不手写清单 ——
  // 手写的清单会在「加了一只怪但忘了加图鉴」时静默漏掉（项目踩过同类问题）。
  const MOB_LIST = [];
  for (let i = 0; i < C.MOBS.length; i++) {
    const d = C.MOBS[i];
    MOB_LIST.push({
      id: d.id,
      name: d.name || d.id,
      // tier: normal / elite / boss —— 图鉴按这三档分组显示
      tier: d.tier || 'normal',
      challenger: !!d.challenger
    });
  }

  const TIER_LABEL = { normal: '寻常妖物', elite: '精怪', boss: '妖王' };

  // 「图鉴全收录」的阈值跟着 MOBS 表走（见 ACHIEVEMENTS 里 mob_all 的注释）
  for (let i = 0; i < ACHIEVEMENTS.length; i++) {
    if (ACHIEVEMENTS[i].id === 'mob_all') ACHIEVEMENTS[i].total.mobKinds = MOB_LIST.length;
  }

  // 武器精通等级：靠「使用次数 + 通关次数」两条腿走，纯看场次会让挂机也能刷满。
  //   Lv0 未识 → Lv1 初识(用过 1 次) → Lv2 熟稔(5 次) → Lv3 精通(15 次) → Lv4 大成(15 次 + 3 次通关)
  const MASTERY_STEPS = [
    { lv: 0, name: '未识', uses: 0, wins: 0 },
    { lv: 1, name: '初识', uses: 1, wins: 0 },
    { lv: 2, name: '熟稔', uses: 5, wins: 0 },
    { lv: 3, name: '精通', uses: 15, wins: 0 },
    { lv: 4, name: '大成', uses: 15, wins: 3 }
  ];

  // rec = { uses, wins, best }（best = 单局最高等级）
  function masteryOf(rec) {
    const uses = (rec && rec.uses) || 0;
    const wins = (rec && rec.wins) || 0;
    let hit = MASTERY_STEPS[0];
    for (let i = 0; i < MASTERY_STEPS.length; i++) {
      const s = MASTERY_STEPS[i];
      if (uses >= s.uses && wins >= s.wins) hit = s;
    }
    // 下一档要多少（界面显示「还差几次」）
    let next = null;
    for (let i = 0; i < MASTERY_STEPS.length; i++) {
      if (MASTERY_STEPS[i].lv === hit.lv + 1) { next = MASTERY_STEPS[i]; break; }
    }
    return {
      lv: hit.lv,
      name: hit.name,
      uses: uses,
      wins: wins,
      best: (rec && rec.best) || 0,
      nextUses: next ? Math.max(0, next.uses - uses) : 0,
      nextWins: next ? Math.max(0, next.wins - wins) : 0
    };
  }

  // 伤害来源的中文名（结算页的「伤害构成」用）。
  // 特殊来源（不属于任何武器）单独给名字，避免结算里出现一串英文 id。
  const SRC_LABEL = {
    thorns: '反伤',
    other: '其它',
    '': '其它',
    // 第四十轮：陨星是「世界造成」的伤害，不属于任何武器。
    // ★不写这一条的话，结算页的伤害构成里会出现一条叫 `meteor` 的英文
    //   （srcLabel 查不到武器表就原样返回 id），看起来像少了翻译。
    meteor: '陨星',
    // 第四十二轮：地脉灵泉。同一条理由 —— 不写这里，结算页会出现一条叫 `ley` 的英文。
    ley: '地脉'
  };

  function srcLabel(id) {
    if (SRC_LABEL[id] !== undefined) return SRC_LABEL[id];
    const w = C.WEAPON_MAP[id];
    return w ? (w.name || id) : (SRC_LABEL[id] || id);
  }

  // 一局该给多少灵玉。规则要一句话说得清，玩家才不会觉得在抽奖：
  //   击杀 / 8 + 波次 × 2 + 通关 40
  // 普通一局（20 波、300 击杀、没通关）≈ 37 + 40 = 77，够点一到两级天赋。
  function jadeOf(summary) {
    const s = summary || {};
    const kills = s.kills || 0;
    const wave = s.wave || 0;
    const win = s.won ? 40 : 0;
    return Math.max(1, Math.floor(kills / 8) + wave * 2 + win);
  }

  return {
    TALENTS, TALENT_MAP, talCost, talBonus, talSpent,
    ACHIEVEMENTS, ACH_MAP, achMet,
    MOB_LIST, TIER_LABEL,
    MASTERY_STEPS, masteryOf,
    srcLabel, jadeOf
  };
});
