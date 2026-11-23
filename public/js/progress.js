// public/js/progress.js —— 「山海榜」的本地存档：图鉴 / 成就 / 山海谱天赋
//
// 为什么放 public/ 而不是 shared/：
//   它是**纯前端**的局外成长（localStorage），服务端不参与。
//   shared/ 放的是「两端必须一致」的东西（const/maps/sim/codex），
//   这份存档只属于这台浏览器，放进 shared/ 会误导后来的人以为服务端也会读。
//
// 两个存储键：
//   vs_codex = 累计战绩 + 图鉴 + 武器精通 + 已解锁成就
//   vs_meta  = 灵玉余额 + 山海谱天赋等级
// 分成两个键而不是一个大对象：结算只改 codex，天赋面板只改 meta，
// 两者分开写，不会因为「面板里点一下」把结算数据覆盖掉。
//
// 【约定】判定规则一律在 shared/codex.js，这里只做「读写 + 入账」。
//   同一份规则写在两处必然被忘（项目里踩过换行规则两处写的事故）。

(function (root) {
  const KEY_CODEX = 'vs_codex';
  const KEY_META = 'vs_meta';
  const CODEX = root.VS && root.VS.CODEX ? root.VS.CODEX : null;

  // ★这里必须用 try/catch：Web Storage 的两个方法都是**同步抛异常**的，
  //   没有回调形式 —— 隐私模式下 getItem 直接抛 SecurityError，
  //   配额满了 setItem 抛 QuotaExceededError。不接住的话整页脚本会断在存档这一步。
  //   （项目其它地方的约定是「不用 try/catch，改用 callback」，这是唯一没法照办的 API。）
  function readJson(key) {
    if (!root.localStorage) return null;
    try {
      const raw = root.localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      return obj && typeof obj === 'object' ? obj : null;
    } catch (e) {
      return null;
    }
  }

  function writeJson(key, obj) {
    if (!root.localStorage) return false;
    try {
      root.localStorage.setItem(key, JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- 默认结构 ----------
  function emptyCodex() {
    return {
      v: 1,
      runs: 0, wins: 0, kills: 0, gold: 0, dmg: 0, challengers: 0,
      bestWave: 0, bestKills: 0,
      bestLevel: 0,   // 单局最高等级（生涯）
      playSec: 0,     // 累计游玩秒数（单人 + 联机）
      mobs: {},       // { 怪 id: 击杀数 }  —— 图鉴
      weapons: {},    // { 武器 id: { u: 使用局数, w: 通关局数, best: 单局最高等级 } }
      ach: {},        // { 成就 id: 1 }
      chars: {},      // { 角色 id: 使用局数 }
      maps: {},       // { 地图 id: 使用局数 }
      // 每局明细（第三十七轮 · 局志）：最近 RUN_KEEP 局，最新的在**前面**。
      // ★为什么存本机而不是服务器：这游戏的库每次发布都可能回滚（见 server 的
      //   「会话不依赖库」），单人局也根本不上报；本机存档才是「一定算得准」的那份。
      history: []
    };
  }

  // 局志最多留多少局。再多也没人看，而且 localStorage 有 5MB 上限 ——
  // 一条记录约 300~700 字节，60 局撑死 40KB，留够余量。
  const RUN_KEEP = 60;

  function emptyMeta() {
    return { v: 1, jade: 0, totalJade: 0, tal: {} };
  }

  // 老存档 / 手改存档一律补齐到当前结构（缺字段补默认值，脏值当没有）
  function normCodex(raw) {
    const out = emptyCodex();
    if (!raw) return out;
    const nums = ['runs', 'wins', 'kills', 'gold', 'dmg', 'challengers', 'bestWave', 'bestKills',
      'bestLevel', 'playSec'];
    for (let i = 0; i < nums.length; i++) {
      const k = nums[i];
      if (typeof raw[k] === 'number' && raw[k] >= 0) out[k] = Math.floor(raw[k]);
    }
    const bags = ['mobs', 'weapons', 'ach', 'chars', 'maps'];
    for (let i = 0; i < bags.length; i++) {
      const k = bags[i];
      if (raw[k] && typeof raw[k] === 'object') out[k] = raw[k];
    }
    // 局志：老存档没有这个字段 → 空数组（不伪造历史）。
    if (raw.history && raw.history.length) out.history = raw.history.slice(0, RUN_KEEP);
    return out;
  }

  function normMeta(raw) {
    const out = emptyMeta();
    if (!raw) return out;
    if (typeof raw.jade === 'number' && raw.jade >= 0) out.jade = Math.floor(raw.jade);
    if (typeof raw.totalJade === 'number' && raw.totalJade >= 0) out.totalJade = Math.floor(raw.totalJade);
    if (raw.tal && typeof raw.tal === 'object') out.tal = raw.tal;
    return out;
  }

  // ---------- 读写 ----------
  const codex = normCodex(readJson(KEY_CODEX));
  const meta = normMeta(readJson(KEY_META));

  function saveCodex() { return writeJson(KEY_CODEX, codex); }
  function saveMeta() { return writeJson(KEY_META, meta); }

  // ---------- 累计上下文（成就判定用） ----------
  // mastered = 精通及以上的武器件数（lv >= 3，见 codex.js 的 MASTERY_STEPS）
  function totals() {
    let mobKinds = 0;
    const mobKeys = Object.keys(codex.mobs);
    for (let i = 0; i < mobKeys.length; i++) {
      if (codex.mobs[mobKeys[i]] > 0) mobKinds += 1;
    }
    let mastered = 0;
    const wKeys = Object.keys(codex.weapons);
    for (let i = 0; i < wKeys.length; i++) {
      const rec = codex.weapons[wKeys[i]];
      if (CODEX && rec && CODEX.masteryOf(rec).lv >= 3) mastered += 1;
    }
    return {
      kills: codex.kills,
      wins: codex.wins,
      runs: codex.runs,
      gold: codex.gold,
      challengers: codex.challengers,
      bestWave: codex.bestWave,
      bestKills: codex.bestKills,
      mobKinds: mobKinds,
      mastered: mastered
    };
  }

  // 已经解锁了哪些成就（数组，按表顺序）
  function unlockedList() {
    const out = [];
    if (!CODEX) return out;
    for (let i = 0; i < CODEX.ACHIEVEMENTS.length; i++) {
      const a = CODEX.ACHIEVEMENTS[i];
      if (codex.ach[a.id]) out.push(a.id);
    }
    return out;
  }

  // ---------- 结算入账 ----------
  // summary 由 game.js 从 sim 的 runSummary() 拿到，字段：
  //   kills, gold, level, wave, won, time, dmgDealt, dmgBy, killsBy,
  //   weapons:[{id,level}], combos, evolutions, shrineKinds, challengers,
  //   charId, mapId, campaign
  //
  // 返回 { jade, newAch:[成就定义], codex, meta }。
  // ★先把「本局」并进累计，再用累计 + 本局去判定成就 —— 顺序反了会出现
  //   「这一局明明达标了，但成就要等下一局才亮」。
  //
  // ★opts.online：联机局。联机世界由服务端推进、结算包也在服务端，
  //   这里**只记局志、不给灵玉与成就**（灵玉是单机/剧情的成长线，
  //   让联机也发就等于「开黑刷灵玉」；排行榜是另一套，走服务器）。
  function settle(summary, opts) {
    const s = summary || {};
    const online = !!(opts && opts.online);
    const before = totals();

    codex.runs += 1;
    codex.kills += s.kills || 0;
    codex.gold += s.gold || 0;
    codex.dmg += s.dmgDealt || 0;
    codex.challengers += s.challengers || 0;
    if ((s.wave || 0) > codex.bestWave) codex.bestWave = s.wave || 0;
    if ((s.kills || 0) > codex.bestKills) codex.bestKills = s.kills || 0;
    if (s.won) codex.wins += 1;

    // 图鉴：按怪种累计击杀
    const killsBy = s.killsBy || {};
    const mobIds = Object.keys(killsBy);
    for (let i = 0; i < mobIds.length; i++) {
      const id = mobIds[i];
      codex.mobs[id] = (codex.mobs[id] || 0) + killsBy[id];
    }

    // 武器精通：只算「这一局带在身上的」；拿到了才 +1 使用局数
    const ws = s.weapons || [];
    for (let i = 0; i < ws.length; i++) {
      const id = ws[i].id;
      if (!id) continue;
      if (!codex.weapons[id]) codex.weapons[id] = { u: 0, w: 0, best: 0 };
      const rec = codex.weapons[id];
      rec.u = (rec.u || 0) + 1;
      if (s.won) rec.w = (rec.w || 0) + 1;
      if ((ws[i].level || 0) > (rec.best || 0)) rec.best = ws[i].level || 0;
    }

    if (s.charId) codex.chars[s.charId] = (codex.chars[s.charId] || 0) + 1;
    if (s.mapId) codex.maps[s.mapId] = (codex.maps[s.mapId] || 0) + 1;

    // 生涯汇总：最高等级 / 累计时长（我的档案要显示，不能只有「最高击杀」）
    if ((s.level || 0) > codex.bestLevel) codex.bestLevel = s.level || 0;
    codex.playSec += Math.max(0, Math.round(s.time || 0));

    // 灵玉（联机不发）
    let jade = 0;
    if (!online) {
      jade = CODEX ? CODEX.jadeOf(s) : 0;
      meta.jade += jade;
      meta.totalJade += jade;
    }

    // 成就：判定用「累计（已含本局）+ 本局」
    const after = totals();
    const ctx = { total: after, run: s };
    const newAch = [];
    if (CODEX) {
      for (let i = 0; i < CODEX.ACHIEVEMENTS.length; i++) {
        const a = CODEX.ACHIEVEMENTS[i];
        if (codex.ach[a.id]) continue;
        if (CODEX.achMet(a, ctx)) {
          codex.ach[a.id] = 1;
          newAch.push(a);
        }
      }
    }

    // ---------- 局志：这一局的全部最终数值 ----------
    // 只存**显示需要的东西**（名字而不是 id、伤害只留前 6 项、武器前 8 把）。
    // 一条 300~700 字节，60 局约 40KB —— 以后加字段别把 killsBy 全量塞进来。
    const names = CODEX ? CODEX : null;
    const dmgTop = [];
    const dl = s.dmgList || [];
    for (let i = 0; i < dl.length && i < 6; i++) {
      const id = dl[i].src || '';
      dmgTop.push([names ? names.srcLabel(id) : id, Math.round(dl[i].dmg || 0)]);
    }
    const wTop = [];
    const wl2 = s.weapons || [];
    for (let i = 0; i < wl2.length && i < 8; i++) {
      wTop.push([names ? names.srcLabel(wl2[i].id) : wl2[i].id, wl2[i].level || 0]);
    }
    const achNames = [];
    for (let i = 0; i < newAch.length; i++) achNames.push(newAch[i].name);

    let state = 'dead';
    if (s.won) state = 'won';
    else if (s.state) state = s.state;          // 'failed'（剧情时间到）/ 'dead'

    const entry = {
      t: Date.now(),
      mode: online ? 'online' : (s.campaign ? 'story' : 'solo'),
      won: s.won ? 1 : 0,
      state: state,
      char: s.charName || s.charId || '',
      map: s.mapName || s.mapId || '',
      diff: s.diffName || '',
      sec: Math.round(s.time || 0),
      wave: s.wave || 0,
      level: s.level || 0,
      kills: s.kills || 0,
      gold: s.gold || 0,
      dmg: Math.round(s.dmgDealt || 0),
      jade: jade,
      ach: achNames,
      dmgList: dmgTop,
      weapons: wTop,
      combos: s.combos || 0,
      evos: s.evolutions || 0,
      shrines: s.shrineKinds || 0,
      challengers: s.challengers || 0
    };
    codex.history.unshift(entry);                 // 最新的在最前面
    if (codex.history.length > RUN_KEEP) codex.history.length = RUN_KEEP;

    saveCodex();
    saveMeta();
    return { jade: jade, newAch: newAch, before: before, codex: codex, meta: meta };
  }

  // ---------- 山海谱：买一级 ----------
  // 返回 { ok, reason, cost }。reason 是给界面直接显示的整句中文 ——
  // 只回 false 的话，玩家看到按钮变灰却不知道差什么（商店那边踩过同样的坑）。
  function buyTalent(id) {
    const def = CODEX ? CODEX.TALENT_MAP[id] : null;
    if (!def) return { ok: false, reason: '没有这个天赋' };
    let lv = meta.tal[id] || 0;
    if (lv >= def.max) return { ok: false, reason: '已经点满了' };
    const cost = CODEX.talCost(def, lv);
    if (cost === null) return { ok: false, reason: '已经点满了' };
    if (meta.jade < cost) return { ok: false, reason: '还差 ' + (cost - meta.jade) + ' 点灵玉' };
    meta.jade -= cost;
    meta.tal[id] = lv + 1;
    saveMeta();
    return { ok: true, reason: '', cost: cost };
  }

  // 传给 sim 的天赋快照（只传等级，不传余额 —— 世界不需要知道钱包）
  function talentLevels() {
    const out = {};
    const ids = Object.keys(meta.tal);
    for (let i = 0; i < ids.length; i++) {
      const lv = meta.tal[ids[i]];
      if (lv > 0) out[ids[i]] = lv;
    }
    return out;
  }

  // ---------- 生涯汇总（我的档案用） ----------
  // 与 totals() 的区别：totals 是给成就判定用的「够不够」，这里是给玩家看的
  // 「打成什么样」—— 多了胜率、场均击杀、最高等级、累计时长、天赋级数。
  function career() {
    const t = totals();
    let talTotal = 0;
    if (CODEX) {
      for (let i = 0; i < CODEX.TALENTS.length; i++) {
        let lv = meta.tal[CODEX.TALENTS[i].id] || 0;
        if (lv > CODEX.TALENTS[i].max) lv = CODEX.TALENTS[i].max;
        talTotal += lv;
      }
    }
    return {
      runs: codex.runs,
      wins: codex.wins,
      kills: codex.kills,
      gold: codex.gold,
      dmg: codex.dmg,
      playSec: codex.playSec,
      bestWave: codex.bestWave,
      bestKills: codex.bestKills,
      bestLevel: codex.bestLevel,
      challengers: codex.challengers,
      mobKinds: t.mobKinds,
      mastered: t.mastered,
      // 分母也一起给：界面要写「3 / 15」，模板里算不了（别在模板里查表）
      mobTotal: CODEX ? CODEX.MOB_LIST.length : 0,
      jade: meta.jade,
      jadeTotal: meta.totalJade,
      talTotal: talTotal,
      // 胜率按「局数」算；0 局时给 0，别显示 NaN
      winRate: codex.runs ? Math.round(codex.wins / codex.runs * 100) : 0,
      avgKills: codex.runs ? Math.round(codex.kills / codex.runs) : 0
    };
  }

  // 局志（最新的在前）。返回的就是存档里的数组，界面只读不写。
  function history() {
    return codex.history || [];
  }

  root.VS_PROGRESS = {
    codex: codex,
    meta: meta,
    RUN_KEEP: RUN_KEEP,
    saveCodex: saveCodex,
    saveMeta: saveMeta,
    totals: totals,
    career: career,
    history: history,
    unlockedList: unlockedList,
    settle: settle,
    buyTalent: buyTalent,
    talentLevels: talentLevels,
    // 调试用：清档（?reset=1 时由 lobby 调用，方便复现新号体验）
    reset: function () {
      root.localStorage.removeItem(KEY_CODEX);
      root.localStorage.removeItem(KEY_META);
      const c = emptyCodex();
      const m = emptyMeta();
      Object.keys(c).forEach(function (k) { codex[k] = c[k]; });
      Object.keys(m).forEach(function (k) { meta[k] = m[k]; });
    }
  };
})(window);
