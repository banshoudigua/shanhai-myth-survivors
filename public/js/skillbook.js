// public/js/skillbook.js —— 技能图鉴：把 const.js 的四张技能表整理成「能给人看」的条目
//
// 为什么要有这个文件
// ------------------
// 游戏里一共 17 武器 + 14 被动 + 10 进化 + 13 组合技 = 54 条说明，
// 全部写在 HTML 模板里意味着「改数值要记得改说明」——那是最容易漏的一处。
// 所以这里**从 const.js 现算**：新增一件武器，这个面板自动多一条，
// 不存在「说明与实现对不上」的可能。
//
// 【与 memory 里那条「串池完备性」是同一个思路】
// 数据只有一份、其余全由它派生。凡是需要「另一处同步维护」的清单，都是 bug 温床。
//
// 【为什么放 public/ 而不是 shared/】
// 它只服务界面，服务端不需要（图鉴是纯展示，没人查它）。
// 但仍写成 UMD：这样 tools/skillbooktest.js 能在 Node 里 require 同一份文件做回归，
// 不必起浏览器就能验「54 条齐全、配方名字解析得出来、每条都有数值」。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../../shared/const.js'));
  } else {
    root.VS = root.VS || {};
    root.VS.SKILLBOOK = factory(root.VS.CONST);
  }
})(typeof self !== 'undefined' ? self : this, function (C) {

  // ============================================================
  // 两张标签表：kind / effect → 中文
  // ============================================================
  //
  // 【为什么要单独维护这两张表】技能条目上要写「近战扇形」「冷却」这类词，
  // 而 const.js 里存的是给 sim 分派用的英文 key。直接把 key 印在界面上没人看得懂。
  // 这两张表是**唯一**需要人肉维护的地方，所以 tools/skillbooktest.js 有一条断言：
  // const.js 里出现过的每个 kind / effect 都必须在这里有对应标签，
  // 以后新增技能忘了加标签，测试会当场失败，而不是等玩家看到 'proj_line'。

  const KIND_LABEL = {
    melee_arc: '近战扇形',    // 朝最近的怪挥出扇形
    proj_line: '直线弹道',   // 飞行投射物，可穿透
    aura: '身周光环',        // 围着自己一圈持续伤害
    zone: '地面区域',        // 扔出去在地上烧一片
    strike: '落雷',          // 延迟落点、落点不可控
    homing: '追踪',          // 自动锁定
    boomerang: '回旋',       // 出去再飞回来
    orbit: '环绕',           // 绕着自身转
    parabola: '抛物'         // 抛起来落地砸范围
  };

  const EFFECT_LABEL = {
    dmg: '伤害',
    armor: '护甲',
    speed: '移速',
    cd: '冷却',
    range: '范围',
    pickup: '拾取',
    projectile: '投射物',
    exp: '经验',
    gold: '金币',
    thorns: '反伤',
    regen: '每秒回血',
    killHeal: '击杀回血',
    crit: '暴击',
    exec: '残血斩杀'
  };

  // ============================================================
  // 小工具
  // ============================================================

  // 数值一律保留 1 位小数，并把尾随的 .0 去掉（12 而不是 12.0）
  function n1(v) {
    const r = Math.round(v * 10) / 10;
    return String(r);
  }

  function pname(id) {
    const d = C.PASSIVE_MAP[id];
    return d ? d.name : id;
  }

  // 一件武器 / 进化 / 组合技的「1 级 → 满级」四项数值
  function statLines(def, maxLevel) {
    const a = C.weaponStats(def, 1);
    const b = C.weaponStats(def, maxLevel);
    const out = ['伤害 ' + n1(a.dmg) + ' → ' + n1(b.dmg)];
    out.push('冷却 ' + n1(a.cd) + '秒 → ' + n1(b.cd) + '秒');
    out.push('范围 ' + Math.round(a.range) + ' → ' + Math.round(b.range));
    if (a.projectiles !== b.projectiles) {
      out.push('投射物 ' + a.projectiles + ' → ' + b.projectiles);
    }
    return out;
  }

  // ============================================================
  // 四组条目
  // ============================================================

  // ---------- 武器 ----------
  function weaponItems() {
    // 起始武器反查：玩家在选人界面挑角色时最关心的就是「这个角色开局拿什么」
    const starters = {};
    for (let i = 0; i < C.CHARACTERS.length; i++) {
      const c = C.CHARACTERS[i];
      if (!starters[c.weapon]) starters[c.weapon] = [];
      starters[c.weapon].push(c.name);
    }

    // 组合技反查：让玩家知道「练这件武器还能顺带凑出哪个组合技」
    const comboOf = {};
    for (let i = 0; i < C.COMBOS.length; i++) {
      const cb = C.COMBOS[i];
      for (let j = 0; j < cb.need.length; j++) {
        if (!comboOf[cb.need[j]]) comboOf[cb.need[j]] = [];
        comboOf[cb.need[j]].push(cb.name);
      }
    }

    const out = [];
    for (let i = 0; i < C.WEAPONS.length; i++) {
      const w = C.WEAPONS[i];
      const evo = C.EVO_BY_WEAPON[w.id];
      out.push({
        id: w.id,
        cat: 'weapon',
        name: w.name,
        tag: KIND_LABEL[w.kind] || w.kind,
        desc: w.desc,
        maxLevel: C.GROWTH.maxLevel,
        nums: statLines(w, C.GROWTH.maxLevel),
        // 谁能拿到它 / 它能凑出什么 / 练满能进化成什么 —— 三条交叉信息
        starters: starters[w.id] || null,
        comboOf: comboOf[w.id] || null,
        evoName: evo ? evo.name : null,
        // ★evoId 必须单独带一份：evoName 是给人看的「血鞭」，
        //   而持有表 weapons 是按 id（'blood_whip'）建的。
        //   早先只留了 evoName，markOwned 拿它去查 ow → 永远查不到，
        //   于是「已进化」那行永远不显示（不会报错，只是静默不亮）。
        evoId: evo ? evo.id : null
      });
    }
    return out;
  }

  // ---------- 被动 ----------
  function passiveItems() {
    // 进化反查：被动是进化的「另一半配方」，不写出来玩家就不知道该先练哪个
    const evoOf = {};
    for (let i = 0; i < C.EVOLUTIONS.length; i++) {
      const e = C.EVOLUTIONS[i];
      if (!evoOf[e.need]) evoOf[e.need] = [];
      evoOf[e.need].push(e.name + '（' + (C.WEAPON_MAP[e.from] ? C.WEAPON_MAP[e.from].name : e.from) + ' 满级）');
    }

    const out = [];
    for (let i = 0; i < C.PASSIVES.length; i++) {
      const p = C.PASSIVES[i];
      const label = EFFECT_LABEL[p.effect] || p.effect;
      const nums = [];
      if (p.milestone) {
        nums.push(p.milestone.join(' / ') + ' 级各 +1 投射物');
      } else {
        // per 是个混合量纲的数：0.1 是 10%，1 是 1 点。
        // 判据是「绝对值小于 1 就按百分比读」—— const.js 里 dmg/speed/cd/range/exp/gold
        // 都写成 0.0x，armor/thorns/regen/killHeal 都是整数，两边不会跨界。
        const isPct = Math.abs(p.per) < 1;
        const unit = isPct ? '%' : ' 点';
        const per = isPct ? Math.round(p.per * 100) : p.per;
        nums.push('每级 ' + (per > 0 ? '+' : '') + per + unit + ' ' + label);
        const total = p.per * C.PASSIVE_MAX_LEVEL;
        const totalTxt = isPct ? Math.round(total * 100) : Math.round(total * 10) / 10;
        nums.push('满级累计 ' + (totalTxt > 0 ? '+' : '') + totalTxt + unit);
      }
      out.push({
        id: p.id,
        cat: 'passive',
        name: p.name,
        tag: label,
        desc: p.desc,
        maxLevel: C.PASSIVE_MAX_LEVEL,
        nums: nums,
        evoOf: evoOf[p.id] || null
      });
    }
    return out;
  }

  // ---------- 进化 ----------
  function evoItems() {
    const out = [];
    for (let i = 0; i < C.EVOLUTIONS.length; i++) {
      const e = C.EVOLUTIONS[i];
      out.push({
        id: e.id,
        cat: 'evo',
        name: e.name,
        tag: '进化',
        desc: e.desc,
        maxLevel: 1,
        // 进化形态不再成长，所以「1 级 → 满级」就是同一个数，
        // 这里只列一条，不写成 "44 → 44"（那看起来像出了 bug）
        nums: statLines(e, 1).map(function (s) { return s.replace(/ → .*$/, ''); }),
        recipe: (C.WEAPON_MAP[e.from] ? C.WEAPON_MAP[e.from].name : e.from) +
          ' 满级 ＋ ' + pname(e.need) + ' 满级'
      });
    }
    return out;
  }

  // ---------- 组合技 ----------
  function comboItems() {
    const out = [];
    for (let i = 0; i < C.COMBOS.length; i++) {
      const cb = C.COMBOS[i];
      const lv = cb.maxLevel || 3;
      const a = C.WEAPON_MAP[cb.need[0]];
      const b = C.WEAPON_MAP[cb.need[1]];
      out.push({
        id: cb.id,
        cat: 'combo',
        name: cb.name,
        tag: KIND_LABEL[cb.kind] || cb.kind,
        desc: cb.desc,
        flavor: cb.flavor || '',
        maxLevel: lv,
        nums: statLines(cb, lv),
        recipe: (a ? a.name : cb.need[0]) + ' Lv' + cb.needLevel + ' ＋ ' +
          (b ? b.name : cb.need[1]) + ' Lv' + cb.needLevel,
        // 配方齐不齐由 markOwned 在运行时算（它才知道玩家手上有什么）
        need: [cb.need[0], cb.need[1]],
        needLevel: cb.needLevel
      });
    }
    return out;
  }

  // ============================================================
  // 对外
  // ============================================================

  // 静态条目表。整局不变，build() 只在页面初始化时调一次。
  function build() {
    return [
      {
        key: 'weapon', name: '武器', hint: '最多同时带 ' + C.SLOTS.weapon + ' 件，满 ' + C.GROWTH.maxLevel + ' 级',
        items: weaponItems()
      },
      {
        key: 'passive', name: '被动', hint: '最多同时带 ' + C.SLOTS.passive + ' 件，满 ' + C.PASSIVE_MAX_LEVEL + ' 级',
        items: passiveItems()
      },
      {
        key: 'evo', name: '进化', hint: '满级武器 ＋ 满级被动，单件武器的终点',
        items: evoItems()
      },
      {
        key: 'combo', name: '组合技', hint: '两件武器各到指定等级解锁，不占武器槽',
        items: comboItems()
      }
    ];
  }

  // 把「玩家当前持有什么」标到条目上。
  //
  // 【为什么每帧都可能重算也不贵】这个函数只在 Vue 的 computed 里被调用，
  // 而 computed 依赖的是 hud.weapons/passives/combos 的**内容**，
  // 那三个数组只在_signature_ 变化时被替换（见 game.js 的 applyHud），
  // 也就是「升级 / 解锁 / 掉线接回进度」那几种时刻，不是每帧。
  //
  // 【为什么要返回新对象而不是就地改】build() 的结果是模块级共享的常量，
  // 就地改会污染它，下一次 owned 表变化时旧标记会残留。
  function markOwned(groups, owned) {
    const ow = (owned && owned.weapons) || {};
    const op = (owned && owned.passives) || {};
    const oc = (owned && owned.combos) || {};
    return groups.map(function (g) {
      return {
        key: g.key,
        name: g.name,
        hint: g.hint,
        items: g.items.map(function (it) {
          const o = Object.assign({}, it);
          if (g.key === 'weapon') o.ownedLv = ow[it.id] || 0;
          else if (g.key === 'passive') o.ownedLv = op[it.id] || 0;
          else if (g.key === 'combo') o.ownedLv = oc[it.id] || 0;
          // 进化形态会**替换**掉原武器（sim 的 chooseLevelUp 里 p.weapons[i] 直接换 id），
          // 所以「已拥有血鞭」时原武器那一格要显示成「已进化」，不能显示成「没拿到」——
          // 否则玩家会以为自己的铁鞭不见了。
          else o.ownedLv = 0;

          if (g.key === 'weapon' && o.ownedLv === 0 && it.evoId && ow[it.evoId]) {
            o.evolvedTo = ow[it.evoId];
          }
          if (g.key === 'combo' && it.need) {
            const la = ow[it.need[0]] || 0;
            const lb = ow[it.need[1]] || 0;
            o.needLv = [la, lb];
            o.recipeReady = la >= it.needLevel && lb >= it.needLevel;
            // 【为什么「一件都没拿到」时不写当前等级】
            // 开局玩家手上只有一把初始武器，图鉴里十几条组合技会齐刷刷显示
            // 「当前 0/0 级」—— 那是一句没有信息量的话（等级 0 本来就不存在），
            // 反而把「配方：铁鞭 Lv5 ＋ 蒜雾 Lv5」这条真正有用的信息挤到不显眼的地位。
            // 只在**至少拿到了一件**时补这句，那时它才是 actionable 的信息：
            // 「我有铁鞭 3 级，还差 2 级」。
            o.needLv = (la || lb) ? [la, lb] : null;
          }
          return o;
        })
      };
    });
  }

  return {
    KIND_LABEL: KIND_LABEL,
    EFFECT_LABEL: EFFECT_LABEL,
    build: build,
    markOwned: markOwned
  };
});
