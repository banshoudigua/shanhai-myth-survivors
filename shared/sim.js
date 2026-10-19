// shared/sim.js —— 世界模拟核心（纯逻辑，无 DOM / 无 Node API）
//
// 为什么做成纯逻辑模块：
//   P1 单人局在浏览器里跑它，P2 联机时把同一个文件 require 进 Node（服务器权威），
//   逻辑一行不改。为此这里禁止出现 document / window / performance / fs，
//   随机数也用自己的种子生成器（两端同种子 = 同结果，方便复现 bug）。
//
// 对外只暴露这几样：
//   createWorld(opts)              建世界（opts.players 传 N 个玩家 = 多人局）
//   world.step(inputs)             推进一个固定步长（1/20 秒）
//   world.chooseLevelUp(index)     消费一次升级三选一
//   world.getHud()                 取一份给界面用的只读快照
//   addPlayer(w, opts)             联机：中途加入
//   removePlayer(w, connId)        联机：掉线 / 离开
//
// 【多人架构一句话】服务器权威：这份文件同时跑在浏览器（单机）和 Node（联机房间）里。
// 世界里 w.players 是全部玩家，w.self 是「自己」，w.player 是「当前处理上下文」。
//
// 数值全部来自 shared/const.js，本文件里不写死任何游戏数值。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./const.js'), require('./maps.js'), require('./campaign.js'));
  } else {
    root.VS = root.VS || {};
    root.VS.SIM = factory(root.VS.CONST, root.VS.MAPS, root.VS.CAMPAIGN);
  }
})(typeof self !== 'undefined' ? self : this, function (C, MAPS_MOD, CP) {

  // ============================================================
  // 随机数：自带种子生成器，保证两端同种子结果一致
  // ============================================================

  function nextRand(w) {
    // 线性同余，够用且极快
    w.rngState = (w.rngState * 1664525 + 1013904223) >>> 0;
    return w.rngState / 4294967296;
  }

  function randRange(w, min, max) {
    return min + nextRand(w) * (max - min);
  }

  function pickWeighted(w, weights) {
    let total = 0;
    const keys = Object.keys(weights);
    for (let i = 0; i < keys.length; i++) total += weights[keys[i]];
    let roll = nextRand(w) * total;
    for (let i = 0; i < keys.length; i++) {
      roll -= weights[keys[i]];
      if (roll <= 0) return keys[i];
    }
    return keys[0];
  }

  function distance(ax, ay, bx, by) {
    const dx = ax - bx;
    const dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ============================================================
  // 地形碰撞：分轴滑动（axis-separated sliding）
  // ============================================================
  // 为什么是「分轴」而不是「推出法线」：
  //   推出法线（把实体沿法线推出去）会让斜着撞墙的实体**卡在墙面正前方**，
  //   玩家会感觉「撞到了一堵看不见的墙」而不是「顺着墙滑过去了」。
  //   分轴的做法是先走 X、被挡就整体回退，再走 Y、被挡也回退 ——
  // 于是「朝墙斜走」自动变成「沿墙走」，这正是障碍物该给的手感。
  //
  // ★为什么不需要寻路网格：所有障碍都是**圆形**（见 shared/maps.js）。
  //   圆是凸的，两两相切不产生凹角，因此**永远不会形成死胡同**。
  //   const.js 里原先写着「没做寻路就不加障碍」——那个顾虑是对的，
  //   但解法是「不做寻路、只用圆」，而不是「不做障碍」。
  //
  // 性能：一次 hitsObstacle 是 O(障碍数)（20~36 次平方比较）。
  // 一帧里被查的次数 = 玩家 1 + 怪物数（约 200）× 2 轴 ≈ 400 次 → 约 1.4 万次/帧，
  // 20Hz 下 28 万次/秒，纯乘加可忽略。simtest 的性能断言会盯着这个数，
  // 真变慢了再上网格索引（现在不必）。

  // 碰撞查询用的临时数组：每次查询都 new 一个数组的话，
  // 一帧上千次分配会自己变成瓶颈（GC 压力比计算还大）。复用一个。
  const _obsNear = [];

  // 碰撞查询的搜索半径：障碍最大半径 36 + 实体半径（Boss 约 40），
  // 取 90 足够把「一圈可能相关的障碍」全圈进来。
  const OBS_QUERY_R = 90;

  // 实体圆是否与任意障碍重叠
  function hitsObstacle(w, ent) {
    const list = w.obstacles;
    if (!list.length) return null;
    const grid = w.obsGrid;
    if (!grid) {
      // 没有索引（手搓的 world 对象）：退回全遍历，功能不缺只是慢
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const dx = ent.x - o.x;
        const dy = ent.y - o.y;
        const min = o.r + ent.r;
        if (dx * dx + dy * dy < min * min) return o;
      }
      return null;
    }
    const n = MAPS_MOD.collectNear(grid, list, ent.x, ent.y, OBS_QUERY_R, _obsNear);
    for (let i = 0; i < n; i++) {
      const o = list[_obsNear[i]];
      const dx = ent.x - o.x;
      const dy = ent.y - o.y;
      const min = o.r + ent.r;
      if (dx * dx + dy * dy < min * min) return o;
    }
    return null;
  }

  // 起点就压在障碍上时的兜底：把实体从障碍里推出来。
  // ★没有这一步，一只刷在墙上的怪会被两个轴都判为「被挡」而永久卡死 ——
  //   这类 bug 表现为「地图某处的怪不动了」，极难定位。
  // 跑两轮是为了应付「同时压在两个障碍交叠处」的情况。
  function pushOutObstacles(w, ent) {
    const list = w.obstacles;
    if (!list.length) return;
    const grid = w.obsGrid;
    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      let n;
      if (grid) {
        n = MAPS_MOD.collectNear(grid, list, ent.x, ent.y, OBS_QUERY_R, _obsNear);
      } else {
        for (let i = 0; i < list.length; i++) _obsNear.push(i);
        n = _obsNear.length;
      }
      for (let i = 0; i < n; i++) {
        const o = list[_obsNear[i]];
        const dx = ent.x - o.x;
        const dy = ent.y - o.y;
        const min = o.r + ent.r;
        const d2 = dx * dx + dy * dy;
        if (d2 >= min * min) continue;
        // d 退化成 0（正好重叠在圆心）时随便给个方向，不然除零得 NaN
        let nx = 1;
        let ny = 0;
        if (d2 > 0.000001) {
          const d = Math.sqrt(d2);
          nx = dx / d;
          ny = dy / d;
        }
        ent.x = o.x + nx * min;
        ent.y = o.y + ny * min;
        moved = true;
      }
      if (!moved) return;
    }
  }

  // 带地形碰撞的位移：分轴滑动（+ 可选的地形绕行）
  //
  // autoSteer 只给**怪物**开：玩家是自己控制方向的，帮他自动绕障会让人觉得
  // 「按键不灵」（明明按了右，角色却自己往左上飘）。所以默认 false。
  function moveWithObstacles(w, ent, dx, dy, autoSteer) {
    if (!w.obstacles || !w.obstacles.length) {
      ent.x += dx;
      ent.y += dy;
      return;
    }
    pushOutObstacles(w, ent);
    const oldX = ent.x;
    const oldY = ent.y;
    ent.x += dx;
    if (hitsObstacle(w, ent)) ent.x = oldX;
    const oldY2 = ent.y;
    ent.y += dy;
    if (hitsObstacle(w, ent)) ent.y = oldY2;

    if (!autoSteer) return;

    // ★wantLen 必须在这里就声明：下面的「惯性分支」和「触发分支」都要用，
    //   写在触发分支那边会因为 const 的暂时性死区直接抛错（已踩）。
    const wantLen = Math.sqrt(dx * dx + dy * dy);
    if (wantLen < 0.0001) return;

    // ---------- 绕行惯性（第十五轮）----------
    // 【为什么需要惯性】只做「受阻才绕」会让怪在障碍边缘**来回摇摆**：
    //   自由时直冲（撞墙）→ 受阻时沿切向绕一点 → 绕出去又自由 → 又直冲撞墙……
    //   实测表现是「怪贴着障碍蹭、永远绕不到玩家身边」（距离卡在 72px 不动）。
    //   所以一旦决定绕，就沿那个切向**连续走 0.45 秒**（惯性），绕出去再重新朝向目标。
    //   ★只有怪有这一段（autoSteer）；玩家不会被代驾。
    if (ent.steerT > 0) {
      const sdx = ent.steerDx * wantLen * 0.9;   // 绕路稍微慢一点，别像直冲那么快
      const sdy = ent.steerDy * wantLen * 0.9;
      const bx = ent.x;
      const by = ent.y;
      ent.x += sdx;
      ent.y += sdy;
      if (hitsObstacle(w, ent)) {                 // 绕行方向也被挡 → 立刻结束惯性，交回常规逻辑
        ent.x = bx;
        ent.y = by;
        ent.steerT = 0;
      } else {
        ent.steerT -= 0.05;                       // 固定步长 = C.DT，与 tick 一致
      }
      return;
    }

    // ---------- 顶住时的切向绕行（第十五轮）----------
    // 【为什么需要】分轴滑动只在「斜着撞墙」时有用。正对着障碍中心走过去时，
    //   **x 轴和 y 轴会被同时判定为「被挡」**，两轴都回退 → 怪原地不动 ——
    //   玩家看到的就是「怪卡在石头上蹭、绕不过来」。
    // 【做法】看实际位移占期望位移多少，低于一半就认为顶住了；
    //   然后沿障碍的**切向**（把「障碍中心 → 自身」转 90°）推一步。
    //   圆形障碍是凸的，切线不会指向障碍内部，所以只要选对方向就不会穿墙。
    // 【为什么不寻路】凸障碍没有凹角、形不成死胡同，转向 + 滑动已经够用；
    //   A* 要维护格子图、还要保证双端逐帧一致，成本远大于收益。
    const movedX = ent.x - oldX;
    const movedY = ent.y - oldY;
    if (Math.sqrt(movedX * movedX + movedY * movedY) > wantLen * 0.5) return;

    const ux = dx / wantLen;
    const uy = dy / wantLen;
    // 找最近的那个障碍（它八成就是挡路的那块）。障碍总数只有 20~36 个，
    // 线性扫一遍比走空间网格再复用数组更简单，也和 hitsObstacle 的口径一致。
    // 用两个标量而不是对象：这里每帧都可能被多只怪走到，省掉临时对象。
    const list = w.obstacles;
    let bestOx = 0;
    let bestOy = 0;
    let bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const ox = ent.x - o.x;
      const oy = ent.y - o.y;
      const d = Math.sqrt(ox * ox + oy * oy) - o.r - ent.r;
      if (d < bestD) { bestD = d; bestOx = ox; bestOy = oy; }
    }
    if (bestD > 0 && bestD > ent.r + 30) return;   // 最近的还离得远，不是它挡的

    let tx = -bestOy;
    let ty = bestOx;
    const tl = Math.sqrt(tx * tx + ty * ty);
    if (tl < 0.0001) return;
    tx /= tl;
    ty /= tl;
    // 取与前进方向同侧的那一边：取反的话怪会往回绕，看起来像在原地犹豫
    if (tx * ux + ty * uy < 0) { tx = -tx; ty = -ty; }

    ent.x += tx * wantLen;
    ent.y += ty * wantLen;
    // 绕过去仍然撞（比如卡在两块障碍的夹缝里）→ 退回，绝不穿墙
    if (hitsObstacle(w, ent)) {
      ent.x = oldX;
      ent.y = oldY;
    } else {
      // 记住这次的方向，接下来 0.45 秒沿它走 —— 见上面「绕行惯性」的说明
      ent.steerT = 0.45;
      ent.steerDx = tx;
      ent.steerDy = ty;
    }
  }

  // 这个点是不是压在障碍上（刷怪时用来避让）
  function pointBlocked(w, x, y, r) {
    const list = w.obstacles;
    if (!list.length) return false;
    const grid = w.obsGrid;
    if (!grid) {
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        const dx = x - o.x;
        const dy = y - o.y;
        const min = o.r + r;
        if (dx * dx + dy * dy < min * min) return true;
      }
      return false;
    }
    const n = MAPS_MOD.collectNear(grid, list, x, y, r + 40, _obsNear);
    for (let i = 0; i < n; i++) {
      const o = list[_obsNear[i]];
      const dx = x - o.x;
      const dy = y - o.y;
      const min = o.r + r;
      if (dx * dx + dy * dy < min * min) return true;
    }
    return false;
  }

  // ============================================================
  // 建世界
  // ============================================================

  // opts:
  //   charId    角色 id（默认猎人）
  //   seed      随机种子（默认取时间）
  //   spawnRadius  怪物生成半径（由界面按视口大小传入）
  // ============================================================
  // 世界创建（P2：支持 N 名玩家共用同一个世界）
  // ============================================================
  //
  // 三个容易混的字段，先在这里一次说清（改代码前务必看懂，否则很容易写错归属）：
  //
  //   w.players  全部玩家的数组，**唯一的事实来源**。P1 单机时长度为 1。
  //   w.self     本端「自己」是哪一个玩家对象。
  //              · 客户端：我操作的那个玩家（镜头、HUD、升级面板都看它）
  //              · 服务端：没有「自己」的概念，指向 players[0] 只为兼容
  //              · 单机：players[0]，所以 P1 的全部代码行为不变
  //   w.player   「当前处理上下文」指针。step() 里逐玩家/逐归属实体临时切换，
  //              让内部函数里的 const p = w.player 自动指向正确的人 ——
  //              这是本次多人改造能只动少数函数的关键：
  //              伤害、金币、经验、回血、击杀回血的归属全都自动跟着上下文走。
  //              每帧 step() 结束时必须还原成 w.self，因为渲染层与 HUD 靠它取「自己」。
  //
  // 每个玩家对象上与他本人绑定的状态（不能放世界里，否则一个人升级会把全世界卡住）：
  //   state          playing / levelup / dead
  //   pendingLevels  攒着没选的升级次数
  //   choices        本次三选一的候选
  //   slot          座位号（客户端数组下标，网络协议里用它当玩家 id）
  //   connId        服务端连接 id（单机为空）

  // 造一个玩家对象并挂到世界上。opts: { charId, connId, name, isGuest, slot }
  function makePlayer(w, opts) {
    opts = opts || {};
    const charDef = C.CHAR_MAP[opts.charId] || C.CHARACTERS[0];
    const mods = charDef.mods || {};
    const baseWeapon = C.WEAPON_MAP[charDef.weapon];

    const player = {
      id: w.nextId++,          // 实体 id：整个世界唯一，网络快照用它标识
      slot: opts.slot || 0,    // 座位号
      connId: opts.connId || '',
      // 账号 id（游客为 null）。sim 本身不用它，是服务端做「断线重连后把进度接回来」
      // 时用来认人的 —— 认人不能只看昵称，游客以外的人昵称是可以重复的。
      userId: opts.userId || null,
      name: opts.name || charDef.name,
      isGuest: !!opts.isGuest,
      charId: charDef.id,
      isPlayer: true,

      // 出生点：地图中央附近按座位散开，避免多人开局叠在一起
      x: w.map.w / 2 + (opts.slot || 0) * 40,
      y: w.map.h / 2,
      px: w.map.w / 2 + (opts.slot || 0) * 40,   // 上一帧位置，供渲染插值
      py: w.map.h / 2,
      facing: 0,
      hp: C.PLAYER.hp,
      maxHp: C.PLAYER.hp,
      r: C.PLAYER.radius,
      invuln: 0,
      alive: true,
      swept: false,            // 阵亡遗留物是否已清理（见 step 第 6 步），防止重复扫

      // ---------- 与本人绑定的进度状态 ----------
      state: 'playing',        // playing / levelup / dead
      pendingLevels: 0,
      choices: [],

      // 阵亡倒计时（秒）。>0 表示「已倒下、正在等复活」，归零那一帧站起来。
      // 单机下恒为 0 —— 不启用复活时它就是个不参与判断的常量。
      reviveLeft: 0,
      deaths: 0,               // 这一局倒过几次（结算与界面提示用）

      level: 1,
      exp: 0,
      expNext: C.expNext(1),
      // 个人战绩：必须按人分开统计，结算界面每个人显示各自的击杀/伤害/金币。
      // w.stats 只是「当前上下文玩家的战绩」的一个别名（见 setCtx），
      // 所以下面战斗代码里的 w.stats.kills += 1 这类写法一个字都不用改。
      stats: { kills: 0, dmgDealt: 0, gold: 0, healed: 0 },
      // 武器与被动：都存 id + 等级，实际数值每次升级时重算进 attrs
      weapons: [{
        id: baseWeapon.id,
        level: 1,
        timer: 0,          // 冷却倒计时
        // 各武器自己的运行时状态（环绕角度等）
        rt: {}
      }],
      passives: [],
      // 组合技单独一张表，**不占武器槽**（武器槽只有 6 个，中期就满了；
      // 让组合技占槽等于「拿到奖励要先扔掉一件武器」，那是惩罚不是奖励）。
      // 形状与 weapons 一致：{ id, level, timer, rt } —— 开火逻辑可以共用。
      combos: [],
      // ---------- 局内商店（金币的唯一用途，见 const.js 的 SHOP）----------
      // shopGold 是**可花的余额**（与 stats.gold 区分开：
      // stats.gold 是「这一局一共赚了多少」，用于结算显示，不能花）。
      // 两个数字混用会让「我赚了 300 怎么只剩 50」变成一个说不清的问题。
      shopGold: 0,
      // 血契石叠加的伤害加成（每次 +12%，最多 3 层 → 最高 +36%）
      shopBuffDmg: 0,
      attrs: null
    };

    // recalcAttrs 走的是 w.player 上下文，这里临时对一下。
    // 用 setCtx 而不是直接赋值：万一以后 recalcAttrs 里间接动了 w.stats，
    // 直接赋值会留下一个指错人的战绩别名，这种问题极难查。
    // 注意 setCtx(w, null) 的语义是「保持当前不动」，所以还原要判一下空。
    w.players.push(player);
    const prevCtx = w.player;
    setCtx(w, player);
    recalcAttrs(w);
    player.hp = player.maxHp;
    if (prevCtx) setCtx(w, prevCtx);

    return player;
  }

  // 把「自己」切成某个玩家：镜头/HUD/升级面板都跟着它
  function setSelf(w, player) {
    w.self = player;
    w.charDef = player ? (C.CHAR_MAP[player.charId] || C.CHARACTERS[0]) : null;
    setCtx(w, player);
    return player;
  }

  // 切换「当前处理上下文」：把某个玩家设为 w.player，并把 w.stats 指到他的个人战绩上。
  //
  // 为什么要有这个函数：伤害/金币/经验/回血/击杀回血的归属，全都靠「当前是谁」来判断。
  // 只要在遍历时切一次上下文，内部那些 w.player.attrs / w.stats.kills += 1
  // 就自动记到正确的头上 —— 这是本次多人改造只动少数函数的关键。
  //
  // 【铁律】以后任何地方要写 w.player = xxx，一律改成 setCtx(w, xxx)。
  // 直接赋值不会同步 w.stats，会造成「A 打死的怪算到 B 头上」这种极难查的错误。
  function setCtx(w, player) {
    w.player = player || w.player;
    if (w.player) w.stats = w.player.stats;
    return w.player;
  }

  // 中途加入：服务端收到 join 时调用
  function addPlayer(w, opts) {
    opts = opts || {};
    if (opts.slot === undefined || opts.slot === null) {
      // 找最小的空座位，避免客户端数组下标与座位号错位
      let slot = 0;
      const used = {};
      for (let i = 0; i < w.players.length; i++) used[w.players[i].slot] = 1;
      while (used[slot]) slot += 1;
      opts.slot = slot;
    }
    return makePlayer(w, opts);
  }

  // 掉线/离开：从世界里摘掉。注意不重排座位号 ——
  // 座位号是网络协议里的玩家标识，重排会让客户端把 A 的实体会认成 B 的。
  function removePlayer(w, connId) {
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].connId !== connId) continue;
      const gone = w.players.splice(i, 1)[0];
      // 他留下的归属实体一并清掉，否则会变成没人认领的幽灵（伤害还照算）
      removeOwnedBy(w, gone);
      // 他专属的事件也要丢掉：座位号是会被复用的，留着的话
      // 下一个坐这个位置的人会收到上一个人的「你升级了 / 你阵亡了」，莫名其妙
      dropEvents(w, gone.slot);
      if (w.self === gone) setSelf(w, w.players[0] || gone);
      return gone;
    }
    return null;
  }

  // 丢掉某个座位专属的事件（没带 slot 的全局事件保留）
  function dropEvents(w, slot) {
    let write = 0;
    for (let i = 0; i < w.events.length; i++) {
      if (w.events[i].slot === slot) continue;
      w.events[write++] = w.events[i];
    }
    w.events.length = write;
  }

  // 清掉某个玩家名下的投射物/区域/落点/环绕物
  function removeOwnedBy(w, owner) {
    const lists = [w.projectiles, w.zones, w.strikes, w.orbits];
    for (let k = 0; k < lists.length; k++) {
      const list = lists[k];
      let write = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i].owner === owner) continue;
        list[write++] = list[i];
      }
      list.length = write;
    }
  }

  // 参数：seed 随机种子 / charId 角色 / spawnRadius 刷怪半径
  // 兼容 P1 单机写法：不传 players 就按 charId 造一个；传了就造 N 个
  function createWorld(opts) {
    opts = opts || {};

    // ---------- 剧情模式：解析本局属于哪个模组的哪一关 ----------
    // 【为什么先算再进对象字面量】matchSec / nameTable / storyStage 都要用到它，
    // 而这些都在 w 的初值里。
    // 非法 modId / stageId 一律由campaign.js 回落（→ vanilla / 第一关），
    // 这里不再重复判断 —— 回落规则只应该有一个地方。
    const modId = opts.modId || 'vanilla';
    const storyStage = CP.isCampaign(modId) ? CP.stageById(modId, opts.stageId) : null;

    const w = {
      rngState: (opts.seed || (Date.now() & 0x7fffffff)) >>> 0,
      tick: 0,
      time: 0,                 // 已运行秒数，由整数 tick 换算而来（不用浮点累加，避免漂移）

      // 世界级结局只有「时间到」一种。注意 w.state 不再是数据字段而是取值器（见下方兼容层），
      // 「谁死了 / 谁在选升级」都归玩家级状态，不该让整局跟着变。
      won: false,

      // 升级面板是否冻结整个世界：
      //   P1 单机 = true —— 弹出三选一就全世界停住，和改造前完全一致
      //   联机     = false —— 服务端建世界时显式关掉：一个人选升级不该把其他 7 个人冻住，
      //                       改成「他自己定格 + 无敌」，其余人照常打
      pauseAllOnLevelUp: opts.pauseAllOnLevelUp !== undefined ? !!opts.pauseAllOnLevelUp : true,

      // 阵亡后是否原地复活：
      //   联机 = true —— 一个人倒了不该让他在旁边干看着，5 秒后站起来接着打
      //   单机 = false（默认）—— 死亡就是这一局的结局，保持品类的基本规则
      reviveOnDeath: !!opts.reviveOnDeath,

      // 难度：一个「倍率对象」，由 const.js 的 DIFFICULTIES 表定义。
      // 【为什么把整个对象挂到世界而不是只存 id】模拟层每帧都要读它（波次血量、
      // 怪打人伤害），存 id 就要每帧查一次表；而倍率在整个世界里是只读的，
      // 挂对象既省查找，也顺手把「这一局到底按什么倍率跑的」写在了世界上，
      // 复盘 / 结算 / 测试都能直接读，不用再回去问谁传了什么参数。
      // 不传（单机、老工具脚本）默认「普通」，也就是全部倍率 = 1，行为与改造前一致。
      diff: C.diffById(opts.difficulty),
      // 本局时长（秒）。有了难度之后它不再是常量 —— 但通关判定、HUD 倒计时、
      // 结算都必须用同一个数，所以只留 world.matchSec 这一个真相。
      //
      // ★剧情模式每关时长不同（4~7 分钟），所以它能被 stageId 覆盖。
      // 覆盖只有一条优先级：opts.matchSec（测试用）> 本关定义 > 难度。
      // 「只有一个真相」这条不变式在这里体现为：不管这个数从哪来，
      // 存的都是 world.matchSec，下游一律读它，不回头去查难度表。
      matchSec: storyStage ? storyStage.matchSec
                : (opts.matchSec || C.diffById(opts.difficulty).matchSec),

      // ---------- 剧情模组（第十五轮）----------
      // 自由模式（不传 modId 或传 'vanilla'）时下面这些全是空/null，
      // **后续所有分支都会走原来的路径** —— 这是「重构不引入回归」的关键。
      modId: modId,
      // 本局的关卡定义对象（剧情模式才有）。存整个对象而不是只存 id：
      // 刷怪时每波都要读它的 pool / waves，存 id 就要每波查一次表。
      storyStage: storyStage,
      // 开局解析一次的名字表。渲染层每帧要给怪/地图取名字，
      // 每帧走 modById()+对象查是几万次/秒的无谓开销 → 必须缓存。
      // ★违反的表现是「掉帧」而不是报错，所以这条写成硬约束。
      nameTable: CP.buildNameTable(modId),
      // 已经播过的剧情节拍下标。用来保证同一条节拍只播一次
      // （step可能被暂停/复活/读档打断，不能靠时间比较来判断）。
      storyBeatDone: [],
      // 关卡序号（1 起）与本关总波数（剧情关用来算「第几波」）
      stageNo: storyStage ? (storyStage.no || 0) : 0,
      stageTotal: 0,

      // ---------- 整局收尾状态（剧情模式引入）----------
      // 【为什么需要它，而不是只看 w.won】
      // 原来自由模式只有一种结局：时间到 = 通关。剧情模式多了一种「失败」：
      // 该击败的首领没击败、时间却到了 —— 那既不是通关也不是阵亡。
      // 用一个 w.ended 标记「这一局已经收尾」，比把三种结局塞进 w.won 干净：
      // w.won 只回答「赢没赢」，w.ended 回答「结束了没」。
      ended: false,
      // 该关的首领是否已被击败（剧情关的胜利条件）
      bossDefeated: false,
      // 时间到但没打完首领（剧情关的失败条件之一）
      timeout: false,

      wave: 0,
      nextWaveTick: 1,         // 下一波的 tick 号：开局第 1 帧就来第一波
      // 当前所在关卡 id。开局为 null，第一波会立刻把「踏入荒村墓园」推成事件。
      // 存 id 而不是波次数字：调关卡区间时这里不用跟着改（见 spawnWave）。
      stageId: null,
      spawnRadius: opts.spawnRadius || 700,
      nextId: 1,

      // 实体容器
      mobs: [],
      // 敌人子弹（与玩家投射物分开，避免互相判定）。
      // **当前恒为空数组**：产品要求怪物一律不做远程攻击，场上已没有任何东西会
      // 调 spawnEnemyArrow。管线（更新/命中/快照/渲染）保留着，想恢复远程怪时
      // 不用重新打通全链路。
      enemyShots: [],
      projectiles: [],
      zones: [],               // 地面持续区域（圣水等）
      strikes: [],             // 延迟落点（落雷 / 审判之锤）
      orbits: [],              // 环绕物
      pickups: [],             // 掉落物
      effects: [],             // 纯视觉特效（不影响逻辑，界面可读）

      // 存活怪物数缓存：界面每帧要读，不能每次都遍历 1200 个实体
      aliveMobCount: 0,

      // 本帧事件，界面消费后清空
      events: [],

      // 玩家（见本段开头的字段说明）
      players: [],
      self: null,
      player: null,
      charDef: null,

      // ---------- 地图与地形 ----------
      // ★别和 STAGES 搞混 —— 两张表名字里都有「墓园」，但一个是时间轴一个是空间：
      //   STAGES（const.js）= 波次进程：打到第几波刷哪一批怪
      //   MAPS （maps.js）  = 战场本身：多大、什么地形、刷怪环多大
      // 同一个「荒村墓园」在两张表里指的是两件事（同一批怪、同一张图），改的时候别只改一处。
      // ★剧情关的地图由关卡定义（stage.mapId）决定，**优先于** opts.mapId。
      //   优先级：storyStage.mapId > opts.mapId > 默认图。
      //   为什么不用 opts：关卡与地图是绑死的（毒泽必然是 marsh），
      //   让调用方再传一遍 mapId 就会出现「传了 spire 的 ch4」这种自相矛盾的组合。
      map: MAPS_MOD.mapById(storyStage ? storyStage.mapId : opts.mapId),
      // 地形：紧接着下面用 buildObstacles 填。空数组是「还没有地图」时的兜底值。
      obstacles: [],

      // 当前上下文玩家的战绩别名（由 setCtx 维护）。这里的字面量只是「还没有玩家时」的兜底。
      stats: { kills: 0, dmgDealt: 0, gold: 0, healed: 0 }
    };

    // 地形在这里一次性算好。
    // buildObstacles 是「地图 id → 障碍表」的**纯函数**：同一个 id 在任何机器上
    // 算出来的结果逐字节相同。所以整局地形**不需要在网络里传任何坐标** ——
    // 联机时只传一个 mapId（几个字节），两端各自算。
    w.obstacles = MAPS_MOD.buildObstacles(w.map);
    // 障碍的空间索引：碰撞查询靠它把「每帧遍历 36 个障碍」降到「只看一两格」。
    // 建一次用一局 —— 障碍是静态的，不需要增量维护。
    w.obsGrid = MAPS_MOD.buildGrid(w.map, w.obstacles);
    // 刷怪环半径：客户端按视口算的值优先；没给就用这张图自己的设定
    // （大图的怪从 700 格外走过来要太久，小图用 700 又显得太挤）。
    w.spawnRadius = opts.spawnRadius || (w.map.spawn && w.map.spawn.radius) || 700;

    // ------------------------------------------------------------------
    // P1 兼容层：把三个「世界级字段」映射到「自己」身上
    // ------------------------------------------------------------------
    // 背景：P1 的界面（public/js/game.js）与三个工具脚本（simtest / balance / gameshot）
    // 一直在直接读写 w.state / w.choices / w.pendingLevels，把它们当成全局开关。
    // 多人改造后这三样都归属到玩家身上了（一个人升级不该影响别人的面板），
    // 这里用取值器把它们映射到 w.self，好处有两个：
    //   1. 老代码一行都不用改，P1 单机的回归风险几乎为零；
    //   2. 不会出现「镜像字段忘了同步」那类最难查的 bug —— 压根没有镜像，只有一份真相。
    // 需要看「别人」的状态时，直接用 getHud(w, 某个玩家) 或玩家对象本身，别绕这里。
    Object.defineProperty(w, 'state', {
      enumerable: true,
      configurable: true,
      get: function () {
        if (w.won) return 'won';
        return w.self ? w.self.state : 'playing';
      },
      set: function (v) {
        // 世界级通关只走 w.won，避免有人 w.state = 'won' 把整局状态写歪
        if (v === 'won') { w.won = true; return; }
        if (w.self) w.self.state = v;
      }
    });
    Object.defineProperty(w, 'choices', {
      enumerable: true,
      configurable: true,
      get: function () { return w.self ? w.self.choices : []; },
      set: function (v) { if (w.self) w.self.choices = v; }
    });
    Object.defineProperty(w, 'pendingLevels', {
      enumerable: true,
      configurable: true,
      get: function () { return w.self ? w.self.pendingLevels : 0; },
      set: function (v) { if (w.self) w.self.pendingLevels = v; }
    });

    // 建玩家：默认单个（P1 单机路径）
    //
    // ★剧情关的初始角色由关卡定义（stage.startChar）决定，优先于 opts.charId。
    //   优先级：storyStage.startChar > opts.charId > 'hunter'。
    //   同样不给调用方覆盖的余地：关卡与初始角色是绑的
    //   （焚天阙必然是祝融的高爆发输出），让外面再传一遍就会出现矛盾组合。
    //
    //   ★★优先级：opts.charId（玩家主动选的）> storyStage.startChar（关卡推荐）> 默认。
    //   这里**必须让 opts.charId 赢** —— 需求确认了「能进关前换角色」，
    //   如果关卡默认压过玩家选择，那个换角色 UI 就是摆设（点了没反应）。
    //   实测踩过一次：界面高亮换到了「文昌」，开局建出来的还是关卡的「行者」。
    const defCharId = opts.charId || (storyStage && storyStage.startChar);
    const list = opts.players && opts.players.length ? opts.players : [{ charId: defCharId }];
    for (let i = 0; i < list.length; i++) {
      const one = list[i];
      makePlayer(w, {
        charId: one.charId || defCharId,
        connId: one.connId || '',
        name: one.name,
        isGuest: one.isGuest,
        slot: one.slot === undefined ? i : one.slot
      });
    }

    // 自己的玩家：单机就是 0 号；联机由服务端/客户端显式指定
    const selfIndex = opts.selfSlot || 0;
    setSelf(w, w.players[selfIndex] || w.players[0]);

    return w;
  }

  // ============================================================
  // 属性重算：被动与角色偏移合成到 attrs
  // ============================================================
  // 约定：所有乘区在这里一次算完，战斗代码只读 attrs，不再回头看被动表，
  // 这样新增被动时只改这里，不会漏掉某个用到属性的地方。

  function recalcAttrs(w) {
    const p = w.player;
    // 【多人要点】角色偏移必须取「当前上下文玩家」自己的角色定义。
    // 不能用 w.charDef —— 那只是「自己（w.self）」的角色，
    // 拿它给别人重算属性会让别人的伤害/血量莫名其妙带上我的角色加成。
    const charDef = C.CHAR_MAP[p.charId] || w.charDef || C.CHARACTERS[0];
    const mods = charDef.mods || {};

    const attrs = {
      dmgMul: mods.dmg || 1,
      cdMul: mods.cd || 1,
      rangeMul: mods.range || 1,
      speedMul: mods.speed || 1,
      hpMul: mods.hp || 1,
      // 角色常驻护甲（圣殿骑士 1 点）。被动「铁壳」是在这个基础上叠加的，
      // 所以初值必须取角色的，不能写死 0。
      armor: charDef.armor || 0,
      pickupMul: 1,
      expMul: 1,
      goldMul: 1,
      extraProj: 0,
      speed: C.PLAYER.speed * (mods.speed || 1),
      killHeal: 0,           // 击杀回血：进化武器「灵魂吞噬」与被动「吸血獠牙」共用这一条
      thorns: 0,             // 反伤：被动「荆棘披风」，受伤时对身边的怪造成伤害
      regen: 0,              // 每秒回血：被动「苔藓护符」
      // 第十一轮新增的两个：结算时判定，不是面板乘区（见 damageMob）
      crit: 0,               // 暴击率：被动「日轮烙印」
      exec: 0                // 斩杀加成：被动「死神印记」，只对残血怪生效
    };

    // ---------- 角色自身的被动加成（不占被动槽） ----------
    // 盗贼的「拾取范围 +45%、经验 +10%」这类写在 CHARACTERS.mods 里，
    // 与被动走的是同一套乘区 —— 在这里一次性并进来，战斗代码不用区分来源。
    if (mods.pickup) attrs.pickupMul += (mods.pickup - 1);
    if (mods.exp) attrs.expMul += (mods.exp - 1);
    if (mods.gold) attrs.goldMul += (mods.gold - 1);

    for (let i = 0; i < p.passives.length; i++) {
      const own = p.passives[i];
      const def = C.PASSIVE_MAP[own.id];
      if (!def) continue;

      if (def.effect === 'armor') {
        attrs.armor += def.per * own.level;
        continue;
      }
      // ---- 本轮新增的三个被动 ----
      // 它们不改乘区，而是往属性上叠一个**绝对值**：
      //   thorns   受伤时反刺身边的怪（7 点 / 级）
      //   regen    每秒回血（0.5 点 / 级）
      //   killHeal 击杀回血（0.4 点 / 级）—— 与进化武器「灵魂吞噬」走同一条通路，
      //            所以战斗代码一行都不用改，只在汇总这里加一笔
      if (def.effect === 'thorns') { attrs.thorns += def.per * own.level; continue; }
      if (def.effect === 'regen') { attrs.regen += def.per * own.level; continue; }
      if (def.effect === 'killHeal') { attrs.killHeal += def.per * own.level; continue; }
      // ---- 第十一轮新增的两个：它们不改面板，只在**结算那一刻**判定 ----
      //   crit 暴击率（日轮烙印）：概率翻倍
      //   exec 斩杀加成（死神印记）：对残血怪加伤
      // 汇总处只负责把等级折成数值，真正的判定在 damageMob。
      if (def.effect === 'crit') { attrs.crit += def.per * own.level; continue; }
      if (def.effect === 'exec') { attrs.exec += def.per * own.level; continue; }

      if (def.effect === 'projectile') {
        // 分身符特殊：只在指定级数各 +1
        const ms = def.milestone || [];
        for (let m = 0; m < ms.length; m++) {
          if (own.level >= ms[m]) attrs.extraProj += 1;
        }
        continue;
      }
      // 其余都是乘算/加算的百分比
      if (def.effect === 'dmg') attrs.dmgMul += def.per * own.level;
      else if (def.effect === 'speed') attrs.speedMul += def.per * own.level;
      else if (def.effect === 'cd') attrs.cdMul += def.per * own.level;
      else if (def.effect === 'range') attrs.rangeMul += def.per * own.level;
      else if (def.effect === 'pickup') attrs.pickupMul += def.per * own.level;
      else if (def.effect === 'exp') attrs.expMul += def.per * own.level;
      else if (def.effect === 'gold') attrs.goldMul += def.per * own.level;
    }

    // 冷却乘区不能变成 0 或负数，给个下限
    if (attrs.cdMul < 0.25) attrs.cdMul = 0.25;

    // ---------- 商店增益「血契石」 ----------
    // 【为什么放在这里而不是战斗代码里临时加】recalcAttrs 是**属性唯一汇总点** ——
    // 被动、角色偏移、武器词条都在这一轮汇总，战斗代码只读 attrs。
    // 在这里并进来，血契石就和其它加成一样：升级、进化、买 buff、掉线接回进度
    // 只要走一次 recalcAttrs 就自动一致。写在战斗代码里就必然漏掉某条路径。
    if (p.shopBuffDmg) attrs.dmgMul += p.shopBuffDmg;

    // 武器侧的特殊词条（目前只有进化形态的击杀回血）也要在这里汇总，
    // 否则战斗代码读 attrs.killHeal 永远是 0。
    // 组合技一样走这里：它以后若加了 killHeal / 吸血之类的词条，
    // 漏掉这一轮就会变成「解锁了组合技但没有它的特效」—— 那种问题很难查。
    const wlists = [p.weapons, p.combos || []];
    for (let k = 0; k < wlists.length; k++) {
      const list = wlists[k];
      for (let i = 0; i < list.length; i++) {
        const wdef = C.WEAPON_MAP[list[i].id];
        if (wdef && wdef.killHeal) attrs.killHeal += wdef.killHeal;
      }
    }

    attrs.speed = C.PLAYER.speed * attrs.speedMul;

    // ---------- 升级加血 ----------
    // 血量上限 = (基础血量 + 等级加成) × 角色/被动倍率。
    // 【为什么先加等级加成、再乘倍率】倍率回答的是「这个角色本身血厚不厚」，
    // 等级加成回答的是「他练了多久」—— 两件独立的事。先加后乘才能让
    // 「血厚的角色练得久」得到正确结果。反过来（倍率也作用于每级成长）会让
    // 圣殿骑士在后期远远甩开其它角色，角色平衡直接失效。
    // 上限 C.PLAYER.hpPerLevelCap 是防「血量流叠到几千血彻底无敌」的兜底。
    const lvHp = Math.min((p.level - 1) * C.PLAYER.hpPerLevel, C.PLAYER.hpPerLevelCap);
    attrs.maxHp = Math.round((C.PLAYER.hp + lvHp) * attrs.hpMul);
    attrs.pickupRadius = C.PLAYER.pickupRadius * attrs.pickupMul;

    p.attrs = attrs;

    // 血量上限变化时按比例校正当前血量，避免换被动后血量超上限
    const ratio = p.maxHp > 0 ? p.hp / p.maxHp : 1;
    p.maxHp = attrs.maxHp;
    p.hp = Math.min(p.maxHp, Math.max(1, Math.round(p.maxHp * ratio)));

    return attrs;
  }

  // ============================================================
  // 伤害与死亡
  // ============================================================

  function damageMob(w, m, dmg, knockX, knockY) {
    if (!m.alive) return 0;

    // 第十一轮新增的两个被动在**结算这一刻**判定（它们不是面板乘区）：
    //   crit 暴击（日轮烙印）  概率翻倍 —— 不稳定，但期望最高
    //   exec 斩杀（死神印记）  对残血怪加伤 —— 对满血怪毫无作用
    //
    // 用 w.player 而不是 w.self：damageMob 之前一定已经 setCtx 到了正确的归属人，
    // 用 self 会在多人局里把 A 的暴击算到 B 身上（而且这种错只在联机复现）。
    const A = w.player ? w.player.attrs : null;
    if (A) {
      if (A.crit > 0 && nextRand(w) < A.crit) dmg = dmg * 2;
      if (A.exec > 0 && m.hp > 0 && m.maxHp > 0 && m.hp < m.maxHp * 0.25) {
        dmg = dmg * (1 + A.exec);
      }
    }

    m.hp -= dmg;
    w.stats.dmgDealt += dmg;

    // 受击闪白：纯视觉，给打击感一点反馈（渲染层读它）
    m.flash = 0.08;

    if (knockX || knockY) {
      // 击退：转成速度冲量，每帧衰减（石像鬼等有抗性）
      const resist = 1 - (m.knockResist || 0);
      m.kx = (m.kx || 0) + knockX * resist;
      m.ky = (m.ky || 0) + knockY * resist;
    }

    if (m.hp <= 0) {
      killMob(w, m);
    }
    return dmg;
  }

  function killMob(w, m) {
    if (!m.alive) return;
    m.alive = false;
    w.stats.kills += 1;

    // 掉落经验球
    const def = m.def;

    // ---------- 经验掉落：分三级 ----------
    // 小球（基础值）/ 大球（明显更大更亮，要专门走过去捡）/ Boss 的一圈巨量球。
    //
    // 【为什么要分级】原来所有怪掉的经验球长得一样、值也一样。打到后期升级变慢时，
    // 地上永远是同一堆小点 —— 玩家感觉不到「这一波我清得比上一波好」。
    // 大球的作用是**即时的正反馈**：它不只是数值更大，画面上就明显更大更亮。
    if (def.tier === 'boss') {
      // Boss：环状撒一圈巨量球。
      // 【为什么是一圈而不是一颗超大球】Boss 血厚、移动慢、常死在怪堆深处。
      // 掉一颗球 = 「要么冒险全拿，要么一点不拿」；掉一圈 = 「能拿多少看你能站多久」——
      // 后者才是这场战斗结束后该有的收尾动作，而且一圈球炸开本身就是它的句号。
      const n = C.DROPS.bossExpOrbs;
      for (let i = 0; i < n; i++) {
        const ang = (Math.PI * 2 / n) * i + nextRand(w) * 0.35;
        const rr = C.DROPS.bossExpRingR * (0.5 + nextRand(w) * 0.5);
        spawnPickup(w, 'exp',
          m.x + Math.cos(ang) * rr, m.y + Math.sin(ang) * rr,
          C.DROPS.bossExpOrbValue, 0, true);
      }
    } else if (def.tier === 'elite') {
      const big = nextRand(w) < C.DROPS.eliteBigChance;
      spawnPickup(w, 'exp', m.x, m.y,
        big ? C.DROPS.expValueEliteBig : C.DROPS.expValueElite, 0, big);
    } else if (def.tier === 'commander') {
      // 指挥官更少见（一波最多几只），直接给大球 —— 「打得费劲的，掉得像样」
      spawnPickup(w, 'exp', m.x, m.y, C.DROPS.expValueEliteBig, 0, true);
    } else {
      const big = nextRand(w) < C.DROPS.bigExpChance;
      spawnPickup(w, 'exp', m.x, m.y,
        big ? C.DROPS.expValueBig : C.DROPS.expValueSmall, 0, big);
    }

    if (nextRand(w) < C.DROPS.goldChance * w.player.attrs.goldMul) {
      spawnPickup(w, 'gold', m.x, m.y, C.DROPS.goldValue);
    }
    if (def.tier === 'elite' || def.tier === 'boss' || nextRand(w) < C.DROPS.heartChance) {
      spawnPickup(w, 'heart', m.x, m.y, C.DROPS.heartHeal);
    }

    // Boss 必掉宝箱：整局唯一的「阶段性大奖」。
    // 【为什么给宝箱而不是多撒一堆经验球】打掉一只 3200 血的领主，奖励如果只是
    // 地上一片经验球，玩家的感受是「就这」。宝箱把奖励做成一个要专门走过去捡的
    // 实体，拾取即一次免费升级 —— 一个明确的「你变强了」的时刻。
    // 事件带坐标，界面可以顺势弹一条提示（联机时别人也知道宝箱在哪）。
    if (def.tier === 'boss') {
      spawnPickup(w, 'chest', m.x, m.y, 1, C.DROPS.chest.life);
      w.events.push({
        type: 'chest_drop', x: Math.round(m.x), y: Math.round(m.y),
        // ★名字走 nameTable：剧情模式要显示「蚩尤」而不是「血月领主」
        name: (w.nameTable && w.nameTable.mob[def.id]) || def.name
      });

      // ---------- 剧情关：击败首领 = 通关 ----------
      // 【为什么在这里判定，而不是在 step 里扫场上有没有 boss】
      // 扫场会有两个坑：① 中途刷出第二只同种怪（比如光环单位带出的）
      // 会被当成「首领还在」；② 首领关如果设计成「先来一只假身、
      // 再来真身」（第五关就是），扫场根本分不清打掉的是哪一只。
      // 直接挂在「boss 级单位死亡」这个动作上，语义最准。
      //
      // ★只在「本关指定了 boss 且它就是要打的那只」时收尾 ——
      //   自由模式每 10 波来一只 boss，打死它绝不该结束整局。
      if (w.storyStage && w.storyStage.boss && w.storyStage.boss.id === def.id) {
        w.bossDefeated = true;
        w.ended = true;
        w.won = true;
        w.events.push({ type: 'won' });
      }
    }

    // 击杀回血（灵魂吞噬）
    const healPerKill = w.player.attrs.killHeal || 0;
    if (healPerKill > 0) healPlayer(w, healPerKill);

    // 死亡特效，让打击感有反馈
    w.effects.push({ kind: 'death', x: m.x, y: m.y, r: def.r, life: 0.25, maxLife: 0.25, color: def.color });
  }

  // 对「指定的那个玩家」造成伤害。
  // 多人改造要点：目标必须显式传入 —— 上下文指针在这里不好使，
  // 因为「谁挨打」和「谁在打」不是同一个人（怪打人时上下文可能是任何东西）。
  // 荆棘披风的反伤半径。
  // 【为什么是 44】贴着你打的怪，其碰撞半径多在 8~20 之间，身边挤两三只时
  // 它们都在 40 以内；再放大就变成「隔着一个身位也能反刺」，
  // 那和「贴身荆棘」的直觉不符。
  const THORNS_RANGE = 44;

  function damagePlayer(w, p, dmg, srcX, srcY) {
    if (!p || !p.alive || p.invuln > 0) return;

    // 正在选升级三选一的人不吃伤害：他这帧被定格了，动不了还能挨打就不公平。
    // 联机时世界照常跑（pauseAllOnLevelUp=false），这条就是唯一的保护。
    if (p.state === 'levelup') return;

    // 铁壳减伤，但至少扣 1 点，避免叠满后完全免伤。
    // 难度倍率在减伤【之前】乘：它是「怪有多凶」，而铁壳是「我有多硬」——
    // 顺序反过来的话，血量越高难度的影响就越被削平，噩梦档到后期会失去意义。
    let real = dmg * w.diff.dmgMul - p.attrs.armor;
    if (real < 1) real = 1;

    p.hp -= real;
    p.invuln = C.PLAYER.invulnSec;
    w.effects.push({ kind: 'hitplayer', x: p.x, y: p.y, r: p.r + 6, life: 0.2, maxLife: 0.2, color: '#ff6b6b' });

    // ---------- 荆棘披风：受伤时反刺身边的怪 ----------
    // 【为什么挂在「受伤那一刻」而不是做成持续光环】它的定位是**被动**，
    // 要的是「被围住时越打越亏」；做成持续光环就等于白送一把武器，
    // 而且是数值上更好的一把（不占武器槽、不需要瞄准）。
    //
    // 【为什么限定最多 6 只】后期被一百只怪围住时，每次挨打都反刺一圈
    // 会让它变成主输出 —— 那就颠倒了「被动」与「武器」的关系。
    // 6 只是一个上限，实际能扎到几只取决于身边挤了多少怪。
    if (p.attrs.thorns > 0 && typeof srcX === 'number' && typeof srcY === 'number') {
      const RANGE2 = THORNS_RANGE * THORNS_RANGE;
      let hitN = 0;
      for (let i = 0; i < w.mobs.length; i++) {
        const m = w.mobs[i];
        if (!m.alive) continue;
        const dx = m.x - srcX;
        const dy = m.y - srcY;
        if (dx * dx + dy * dy > RANGE2) continue;
        damageMob(w, m, p.attrs.thorns);
        hitN += 1;
        if (hitN >= 6) break;
      }
      if (hitN > 0) {
        // 反伤的视觉：一圈金色小爆点，位置在**打你的那只怪**那里，
        // 不是玩家身上 —— 玩家需要知道「是谁打的、我扎回去了」。
        w.effects.push({
          kind: 'boom', x: srcX, y: srcY, r: 30, life: 0.18, maxLife: 0.18, color: '#ffd166'
        });
      }
    }

    if (p.hp <= 0) {
      p.hp = 0;
      p.alive = false;
      // 只把「自己死了」记在自己身上：多人局里一个人阵亡不该让整局结束
      p.state = 'dead';
      p.deaths = (p.deaths || 0) + 1;
      // 开启复活的局（联机）：起一个倒计时，到点由 revivePlayer 站起来。
      // 事件里带上剩余秒数，界面不用自己记开始时间。
      p.reviveLeft = w.reviveOnDeath ? C.PLAYER.reviveSec : 0;
      w.events.push({
        type: 'dead', slot: p.slot, name: p.name,
        reviveIn: p.reviveLeft, deaths: p.deaths
      });
    }
  }

  // 复活：把倒下的玩家原样扶起来。
  // 设计取舍：
  //   · 位置**不动** —— 队友能确切知道该去哪儿接应，也省得再想一套「找个安全点」的规则；
  //   · 只回一半血 —— 满血复活等于死亡没有代价，那就变成「用命磨怪」了；
  //   · 给一段无敌 —— 站起来时怪往往就在身上，没有这个窗口会「复活即再死」，
  //     那 5 秒等待就白等了（这是这套机制最容易翻车的地方）。
  function revivePlayer(w, p) {
    p.alive = true;
    p.state = 'playing';
    p.hp = Math.max(1, Math.round(p.maxHp * C.PLAYER.reviveHpRatio));
    p.invuln = C.PLAYER.reviveInvulnSec;
    p.reviveLeft = 0;
    // 阵亡时清过一遍遗留物（见 step 第 6 步），复活后要重新接管：
    // 不重置的话，他复活后新放的圣水/落雷会被当成「已经扫过」而永远不再清理。
    p.swept = false;

    // 冷色金圈：和「受击红圈」「怪物死亡」都能一眼区分开
    w.effects.push({
      kind: 'revive', x: p.x, y: p.y, r: p.r + 28,
      life: 0.5, maxLife: 0.5, color: '#f2c14e'
    });
    w.events.push({ type: 'revive', slot: p.slot, name: p.name, deaths: p.deaths });
  }

  function healPlayer(w, amount) {
    const p = w.player;
    const before = p.hp;
    p.hp = Math.min(p.maxHp, p.hp + amount);
    w.stats.healed += p.hp - before;
  }

  // ============================================================
  // 生成：怪物与掉落
  // ============================================================

  function spawnMob(w, mobId, x, y, hpMul) {
    const def = C.MOB_MAP[mobId];
    if (!def) return null;

    const m = {
      id: w.nextId++,
      defId: def.id,
      def: def,
      x: x, y: y, px: x, py: y,
      hp: def.hp * hpMul,
      maxHp: def.hp * hpMul,
      r: def.r,
      alive: true,
      vx: 0, vy: 0,
      kx: 0, ky: 0,          // 击退速度
      hitCd: 0,              // 接触伤害冷却
      flash: 0,              // 受击闪白剩余时间
      shootCd: def.shootCd ? randRange(w, 0.4, def.shootCd) : 0,
      chargeCd: def.chargeCd ? randRange(w, 1.0, def.chargeCd) : 0,
      charging: 0,
      stun: 0,
      phase: nextRand(w) * Math.PI * 2,   // 血蝠摆动等用
      buffMul: 1
    };

    w.mobs.push(m);
    return m;
  }

  // 在指定玩家外侧环形生成，避免在视野内凭空出现
  function ringSpawnPos(w, p) {
    // 兜底：没传玩家（比如全员阵亡）就围着地图中央刷，别让流程炸掉
    const ax = p ? p.x : w.map.w / 2;
    const ay = p ? p.y : w.map.h / 2;
    const radius = w.spawnRadius + randRange(w, 0, 120);
    const pad = 40;

    // ★为什么刷怪也要避障碍：一只刷在墓碑里的怪，会被碰撞逻辑在第一帧
    // 就推出来 —— 玩家看到的是「怪凭空弹了一下」，很出戏。
    // 换角度重试几次；全都撞墙就直接用这个点（碰撞层会把它推出去，不会卡死）。
    const mobR = 18;
    let x = 0;
    let y = 0;
    for (let k = 0; k < 6; k++) {
      const angle = nextRand(w) * Math.PI * 2;
      x = ax + Math.cos(angle) * radius;
      y = ay + Math.sin(angle) * radius;

      // 贴到地图边界内（至少留出半径余量）
      if (x < pad) x = pad;
      if (x > w.map.w - pad) x = w.map.w - pad;
      if (y < pad) y = pad;
      if (y > w.map.h - pad) y = w.map.h - pad;

      if (!pointBlocked(w, x, y, mobR)) break;
    }

    return { x: x, y: y };
  }

  // 本波刷怪要围着谁：从活着的玩家里随机挑一个。
  // 为什么不是"围着所有人重心"：多人会分开走位，围着重心刷会让两边都刷不到怪，
  // 也不公平（谁离重心近谁挨打）。按人分摊才能维持每个人的压力。
  function pickSpawnAnchor(w) {
    const alive = [];
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].alive) alive.push(w.players[i]);
    }
    if (alive.length === 0) return null;
    if (alive.length === 1) return alive[0];
    return alive[Math.floor(nextRand(w) * alive.length) % alive.length];
  }

  function spawnWave(w) {
    w.wave += 1;
    const wave = w.wave;
    const diff = w.diff;
    // 难度倍率叠在波次曲线上：曲线负责「越往后越难」的形状，难度负责整体高低。
    // 两者相乘而不是替换 —— 换掉任一条都会让另一条调好的手感失效。
    // ★剧情关用本关自己的 hpGrowth（campaign.waveHpMulOf），
    //   自由模式走原来的 C.waveHpMul —— 一个字没改。
    const hpMul = (w.storyStage
      ? CP.waveHpMulOf(w.modId, w.storyStage, wave)
      : C.waveHpMul(wave)) * diff.hpMul;

    // ---------- 关卡：这一波该刷哪些怪 ----------
    // 权重表直接就是「怪种 → 权重」（不是 tier），少一层映射。
    // 【为什么要按关卡换怪种】原来 40 波从头到尾都是那 7 种怪，玩家在第 5 分钟
    // 和第 18 分钟看到的东西完全一样，唯一区别是数字。现在每关的怪种组合不同：
    // 开局只有腐尸和血蝠（教学段），血色回廊引入速度型，钟楼尖顶上精英，
    // 血月祭坛全部混编 + 双光环。"打得久"和"打到哪"从此是两件事。
    //
    // ★剧情模式：一整局就是「一个关卡」，所以池子固定取本关的 —— 
    //   自由模式的 stageForWave 是「按波次自动推进四段」，
    //   两者是不同的时间轴，别混在一起理解。
    const stage = w.storyStage
      ? w.storyStage
      : C.stageForWave(wave);
    // ★再乘上这张图的怪池偏好 —— 「不同地图不同怪物」就落在这一行
    const pool = applyMapBias(w.storyStage ? w.storyStage.pool : stage.pool, w.map);
    const bossWave = w.storyStage
      ? CP.isBossWave(w.modId, w.storyStage, wave)
      : C.isBossWave(wave);

    // 踏入新区域：发一条事件（界面显示区域名 + 播报一句）。
    // 用 stage.id 记而不是波次数字比：以后调关卡区间时这里不用跟着改。
    // 剧情模式：一整局只有一个 stage，所以只在第一次刷怪时推一次事件
    // （否则每波都推同一个 stageId，界面会反复播报同一个关卡名）。
    if (w.stageId !== stage.id) {
      w.stageId = stage.id;
      w.events.push({
        type: 'stage', stageId: stage.id, wave: wave,
        name: (w.nameTable && w.nameTable.map[stage.mapId]) || stage.name
      });
    }

    // 同屏硬上限保护：Boss 要占一个名额，必须先从额度里扣掉，
    // 否则「常规怪填满上限 + 额外一只 Boss」会突破 MAX_MOBS。
    const alive = countAliveMobs(w);
    const room = C.MAX_MOBS - alive - (bossWave ? 1 : 0);

    // 数量也按难度缩放（血月 ×1.7 会更快顶到 MAX_MOBS —— 那正是它该有的压力）
    let count = Math.round((w.storyStage
      ? CP.waveCountOf(w.modId, w.storyStage, wave)
      : C.waveCount(wave)) * diff.countMul);
    if (count > room) count = room;
    if (count < 0) count = 0;

    for (let i = 0; i < count; i++) {
      // pickWeighted 返回的是 key —— 现在 key 直接就是怪种 id
      const mobId = pickWeighted(w, pool);
      if (!mobId || !C.MOB_MAP[mobId]) continue;
      // 每只怪各自挑一个玩家当锚点：多人分开走位时两边都有压力
      const pos = ringSpawnPos(w, pickSpawnAnchor(w));
      spawnMob(w, mobId, pos.x, pos.y, hpMul);
    }

    // Boss 波：额外来一只，血量也跟波次成长（额度上面已经预留）
    if (bossWave && alive + count < C.MAX_MOBS) {
      // 【为什么 Boss 要轮换】原来第 10/20/30/40 波来的是同一只领主，只是血更厚。
      // 打到第二只时玩家已经知道怎么打了，剩下的就是重复劳动。
      // 现在四只各有形象与光环强度，最后一只是真正的最终试炼。
      // ★剧情关可以指定 Boss（不按四只轮换），自由模式继续走 BOSS_ROTATION
      const bossId = w.storyStage
        ? CP.bossOf(w.modId, w.storyStage, wave)
        : C.bossForWave(wave);
      const pos = ringSpawnPos(w, pickSpawnAnchor(w));
      const boss = spawnMob(w, bossId, pos.x, pos.y, hpMul);
      w.events.push({
        type: 'boss', wave: wave, bossId: bossId,
        // ★名字：剧情关优先用**关卡自带的覆写名**（第五关的「空壳」就是这么来的），
        //   其次走 nameTable（蚩尤/九婴…），最后才是数据表本名。
        // boss 可能因为额度不足而没生成成（boss 为 null），这时也要给个名字。
        name: (w.storyStage ? CP.bossDisplayName(w.modId, w.storyStage) : '') ||
              (w.nameTable && w.nameTable.mob[bossId]) ||
              (boss ? boss.def.name : '首领'),
        bossStyle: boss ? (boss.def.bossStyle || 'lord') : 'lord'
      });
    } else {
      w.events.push({ type: 'wave', wave: wave, stageName: stage.name });
    }
  }

  // 把地图的怪池偏好乘到波次权重上。
  // 【为什么是相乘而不是替换】
  //   STAGES 的权重负责「越往后越难」的曲线形状，地图的 mobBias 负责「这张图更常出什么」。
  //   替换掉任何一边都会让另一边调好的手感失效 —— 尤其替换 STAGES 会让
  //   「开局只有小怪」的教学段直接失效（换成开局就全是精英）。
  //   没在 mobBias 里列出的怪按 1 倍，也就是照常出。
  // ★必须返回**新对象**：pool 是 const.js 里 STAGES 的共享数据，
  //   就地改会污染后续所有世界（换了图还在用上一张图的权重）。
  function applyMapBias(pool, map) {
    if (!pool || !map || !map.mobBias) return pool;
    const out = {};
    for (const id in pool) {
      const bias = map.mobBias[id];
      out[id] = pool[id] * (bias === undefined ? 1 : bias);
    }

    // ★地图的「招牌怪」：被这张图偏爱、但当前波次池压根没排上的怪，要把它加进来。
    // 【为什么必须有这一步】光调倍数在前期完全体现不出差异 ——
    //   教学段 STAGES 只给了腐尸和血蝠两种，怎么乘都还是这两种，
    //   玩家换了图看到的东西一模一样，「不同地图不同怪物」就成了空话。
    // 【两条安全阀】
    //   ① 只加 small / swift（小怪与快怪），**不加精英与光环单位** ——
    //      否则前 2 分钟的教学段会突然冒出石像鬼，难度曲线直接崩。
    //   ② 只加「被偏爱的」（bias > 1），被抑制的怪保持不复现。
    //   基准权重取当前池均值的一半：它们是「常客」，不该盖过这一波的主角。
    let sum = 0;
    let n = 0;
    for (const id in pool) { sum += pool[id]; n += 1; }
    const base = n ? (sum / n) * 0.5 : 0;
    for (const id in map.mobBias) {
      if (out[id] !== undefined) continue;
      if (map.mobBias[id] <= 1) continue;
      const def = C.MOB_MAP[id];
      if (!def) continue;
      if (def.tier !== 'small' && def.tier !== 'swift') continue;
      out[id] = base * map.mobBias[id];
    }
    return out;
  }

  function countAliveMobs(w) {
    let n = 0;
    for (let i = 0; i < w.mobs.length; i++) {
      if (w.mobs[i].alive) n++;
    }
    return n;
  }

  // kind：exp / gold / heart / chest
  // lifeSec 可省 —— 传 0 或不传都表示用默认寿命（60 秒）；宝箱会传更长
  // （见 DROPS.chest.life 的说明）。
  // big：大经验球标记。它只影响渲染（画得更大更亮），不掉落逻辑不用管它 ——
  // 但必须进快照，否则联机时只有主机看得到大球、队友看到的还是小球。
  function spawnPickup(w, kind, x, y, value, lifeSec, big) {
    w.pickups.push({
      id: w.nextId++,
      kind: kind,
      x: x, y: y, px: x, py: y,
      value: value,
      // 存 0/1 而不是 true/false：这个字段要进二进制快照（走可选位），
      // 而 wire 上只认数字 —— 布尔值在 uv 编码里虽然能被隐式转成 1，
      // 但两端的「真值」语义不一致会让以后加字段的人踩坑。统一成数字。
      big: big ? 1 : 0,
      vx: 0, vy: 0,
      life: lifeSec > 0 ? lifeSec : 60      // 到点自然消失，避免长期堆积
    });
  }

  // ============================================================
  // 武器开火
  // ============================================================

  // 找一个最近的活着的玩家。怪物 AI、敌弹、掉落物吸引都用它选目标。
  // 单机时永远返回唯一那个玩家，行为与改造前完全一致。
  function nearestPlayer(w, x, y, maxDist) {
    let best = null;
    let bestD = maxDist || Infinity;
    const list = w.players;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) continue;
      const d = distance(x, y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // 找出离某点最近的那个玩家（含已阵亡的），用于掉落物吸引半径这类不挑死活的地方
  function nearestPlayerAny(w, x, y) {
    let best = null;
    let bestD = Infinity;
    const list = w.players;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const d = distance(x, y, p.x, p.y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  // 找一个最近的活着的怪，没有就返回 null
  function nearestMob(w, x, y, maxDist) {
    let best = null;
    let bestD = maxDist || Infinity;
    const list = w.mobs;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive) continue;
      const d = distance(x, y, m.x, m.y);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    }
    return best;
  }

  // 武器瞄准角：射程内优先指向最近的敌人，没有目标才回落到玩家面向。
  //
  // 为什么必须这样（这是一处实打实的可玩性缺陷）：
  // 玩家移动时 p.facing 跟着移动方向走，而生存又要求你背对怪物跑，
  // 于是「朝面向开火」= 永远朝没怪的空气挥，跑和打互相冲突。
  // 实测后果：会走位的玩家 278 秒 0 击杀、等级 1、身边堆着 216 只怪 —— 根本玩不下去。
  // 现在把「角色朝向」与「武器瞄准」解耦：朝向照旧跟着走（观感自然），
  // 瞄准单独按最近的敌人算，背身打怪才成立。
  function aimAngle(w, p, maxDist) {
    const t = nearestMob(w, p.x, p.y, maxDist || 520);
    if (!t) return p.facing;
    return Math.atan2(t.y - p.y, t.x - p.x);
  }

  // 对某个圆范围内所有怪造成伤害，返回命中数
  function damageInCircle(w, x, y, radius, dmg, knock, opts) {
    opts = opts || {};
    const list = w.mobs;
    let hits = 0;

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive) continue;

      const dx = m.x - x;
      const dy = m.y - y;
      // 圆与圆相交：把怪物半径算进去，大体型怪更容易被打到
      const rr = radius + m.r;
      if (dx * dx + dy * dy > rr * rr) continue;

      // 命中标记：给需要「每个目标每轮只打一次」的武器用
      if (opts.hitKey && m.hitKeys && m.hitKeys[opts.hitKey]) continue;
      if (opts.hitKey) {
        if (!m.hitKeys) m.hitKeys = {};
        m.hitKeys[opts.hitKey] = 1;
      }

      let kx = 0;
      let ky = 0;
      if (knock) {
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        kx = (dx / d) * knock;
        ky = (dy / d) * knock;
      }
      damageMob(w, m, dmg, kx, ky);
      hits++;

      if (opts.stunSec) m.stun = Math.max(m.stun, opts.stunSec);
    }
    return hits;
  }

  // 扇形范围伤害（铁鞭）
  function damageInArc(w, x, y, radius, facing, arcDeg, dmg, knock) {
    const half = (arcDeg * Math.PI / 180) / 2;
    const full = arcDeg >= 360;
    const list = w.mobs;
    let hits = 0;

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive) continue;

      const dx = m.x - x;
      const dy = m.y - y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > radius + m.r) continue;

      if (!full) {
        let ang = Math.atan2(dy, dx) - facing;
        // 归一到 -PI..PI
        while (ang > Math.PI) ang -= Math.PI * 2;
        while (ang < -Math.PI) ang += Math.PI * 2;
        if (Math.abs(ang) > half) continue;
      }

      const d = dist || 1;
      damageMob(w, m, dmg, (dx / d) * knock, (dy / d) * knock);
      hits++;
    }
    return hits;
  }

  // 开火：按武器 kind 分派
  function fireWeapon(w, slot) {
    const def = C.WEAPON_MAP[slot.id];
    if (!def) return;

    const p = w.player;
    const a = p.attrs;
    const st = C.weaponStats(def, slot.level);

    const dmg = st.dmg * a.dmgMul;
    const range = st.range * a.rangeMul;
    const count = st.projectiles + a.extraProj;

    const kind = def.kind;

    // ---------- 近战扇形（铁鞭 / 血鞭） ----------
    if (kind === 'melee_arc') {
      // 自动瞄准最近的怪；找不到才按面向挥（判定与特效用同一个角度，否则会「打到了却没画出来」）
      const ang = aimAngle(w, p, range * 2.4);
      w.effects.push({
        kind: 'arc', x: p.x, y: p.y,
        facing: ang, arcDeg: def.arcDeg, r: range,
        life: 0.18, maxLife: 0.18,
        color: def.evolved ? '#ff4d4d' : '#e8dcc0'
      });
      damageInArc(w, p.x, p.y, range, ang, def.arcDeg, dmg, def.knock || 0);
      return;
    }

    // ---------- 直线投射（银钉 / 千刃 / 重型火球 / 陨星） ----------
    if (kind === 'proj_line') {
      const radial = def.radial || 0;
      // 千刃那种「N 向齐发」的弹数由 radial 决定；
      // 普通直线武器才吃「投射物 +1」的加成
      const n = radial > 0 ? radial : count;
      // 直线弹也按最近的敌人瞄，弹道射程有多远就瞄多远
      const base = radial > 0 ? 0 : aimAngle(w, p, range);

      for (let i = 0; i < n; i++) {
        let ang;
        if (radial > 0) {
          // 均匀撒向四周
          ang = (Math.PI * 2 / radial) * i;
        } else {
          // 多投射物时以瞄准方向为中心做小角度扇形展开
          const spread = 0.16;
          ang = base + (i - (n - 1) / 2) * spread;
        }

        w.projectiles.push({
          id: w.nextId++,
          kind: 'line',
          owner: p,                     // 归属：命中算谁的伤害/金币/击杀回血（多人必备）
          x: p.x, y: p.y, px: p.x, py: p.y,
          vx: Math.cos(ang) * def.speed,
          vy: Math.sin(ang) * def.speed,
          r: def.id === 'heavy_ball' || def.id === 'meteor' ? 10 : 4,
          dmg: dmg,
          pierce: def.pierce || 1,
          life: range / def.speed,
          hitIds: {},
          color: def.id === 'heavy_ball' || def.id === 'meteor' ? '#ff8c42' : '#dfe6ef',
          explodeRadius: def.explodeRadius || 0,
          explodeDmg: def.explodeDmg ? def.explodeDmg * a.dmgMul : 0
        });
      }
      return;
    }

    // ---------- 光环（蒜雾 / 灵魂吞噬）：每次冷却到点就打一圈 ----------
    if (kind === 'aura') {
      damageInCircle(w, p.x, p.y, range, dmg, def.knock || 0);
      w.effects.push({
        kind: 'ring', x: p.x, y: p.y, r: range,
        life: 0.35, maxLife: 0.35,
        // 配色只能用暗红 / 琥珀金 / 冷灰：原值 #7ee08a / #9fd39f 是绿色，
        // 与追踪法球保持同一套处理——普通米黄、进化琥珀金
        color: def.evolved ? '#f2c14e' : '#e8d9b8'
      });
      return;
    }

    // ---------- 地面区域（圣水瓶 / 圣裁之地） ----------
    if (kind === 'zone') {
      // 朝最近的敌人扔；没敌人就按面向扔
      const ang = aimAngle(w, p, def.throwDist + 160);
      const tx = p.x + Math.cos(ang) * def.throwDist;
      const ty = p.y + Math.sin(ang) * def.throwDist;
      w.zones.push({
        id: w.nextId++,
        kind: 'zone',
        owner: p,                       // 归属：这口圣水是谁扔的，持续伤害就算谁的
        x: clamp(tx, 0, w.map.w),
        y: clamp(ty, 0, w.map.h),
        r: range,
        dmg: dmg,
        tickSec: def.tickSec,
        tickTimer: 0,
        life: def.zoneSec,
        maxLife: def.zoneSec,
        // 配色守暗红 / 琥珀金 / 冷灰三色：原值 #7fc6e8 是饱和天蓝（色相 199°），
        // 换成去饱和的冷灰
        color: def.evolved ? '#ffd166' : '#a8b6c4',
        hitKey: 'z' + w.nextId
      });
      return;
    }

    // ---------- 延迟落点（落雷 / 天罚） ----------
    if (kind === 'strike') {
      const times = def.strikes || 1;
      for (let i = 0; i < times; i++) {
        // 落点随机不可控，只在玩家附近取
        const ang = nextRand(w) * Math.PI * 2;
        const dist = randRange(w, 40, def.castDist);
        w.strikes.push({
          id: w.nextId++,
          kind: 'strike',
          owner: p,                     // 归属：这道雷是谁召的
          x: clamp(p.x + Math.cos(ang) * dist, 20, w.map.w - 20),
          y: clamp(p.y + Math.sin(ang) * dist, 20, w.map.h - 20),
          r: range,
          dmg: dmg,
          delay: def.fallDelay,
          life: def.fallDelay,
          color: '#fff3b0'
        });
      }
      return;
    }

    // ---------- 追踪（追踪法球 / 群星） ----------
    if (kind === 'homing') {
      // 追踪弹本身会拐弯，但初始方向也按最近的敌人给，出膛就少拐两下
      const base = aimAngle(w, p, 640);
      for (let i = 0; i < count; i++) {
        const ang = base + (i - (count - 1) / 2) * 0.5;
        w.projectiles.push({
          id: w.nextId++,
          kind: 'homing',
          owner: p,                     // 归属：追踪弹命中算谁的
          x: p.x, y: p.y, px: p.x, py: p.y,
          vx: Math.cos(ang) * def.speed,
          vy: Math.sin(ang) * def.speed,
          speed: def.speed,
          turnRate: def.turnRate,
          r: 6,
          dmg: dmg,
          pierce: 1,
          life: def.lifeSec,
          hitIds: {},
          targetId: 0,
          // 配色遵项目约定：只在暗红 / 琥珀金 / 冷灰范围内取，不用紫色
          color: def.evolved ? '#f2c14e' : '#e8d9b8'
        });
      }
      return;
    }

    // ---------- 投掷往返（回旋刃 / 血月轮） ----------
    if (kind === 'boomerang') {
      // 去程朝最近的敌人，回程本来就会飞回来
      const base = aimAngle(w, p, range);
      for (let i = 0; i < count; i++) {
        const ang = base + (i - (count - 1) / 2) * 0.45;
        w.projectiles.push({
          id: w.nextId++,
          kind: 'boomerang',
          owner: p,                     // 归属：也是「回程要飞回谁身边」的依据（见 updateProjectiles）
          x: p.x, y: p.y, px: p.x, py: p.y,
          vx: Math.cos(ang) * def.speed,
          vy: Math.sin(ang) * def.speed,
          speed: def.speed,
          r: 9,
          dmg: dmg,
          pierce: 9999,
          life: 6,
          hitIds: {},
          phase: 'out',
          traveled: 0,
          maxTravel: range,
          trips: def.trips || 1,
          tripsDone: 0,
          color: def.evolved ? '#ff5c7a' : '#d9dde3'
        });
      }
      return;
    }

    // ---------- 环绕（环绕经卷 / 圣经风暴） ----------
    if (kind === 'orbit') {
      const n = count;
      for (let i = 0; i < n; i++) {
        w.orbits.push({
          id: w.nextId++,
          owner: p,                     // 归属：环绕物跟着谁转（updateOrbits 按它算圆心）
          angle: (Math.PI * 2 / n) * i,
          r: range,
          speed: def.spinSpeed,
          dmg: dmg,
          life: def.orbitSec,
          maxLife: def.orbitSec,
          hitSec: def.hitSec,
          hitMap: {},
          size: 10,
          color: def.evolved ? '#ffe08a' : '#e6dcc6'
        });
      }
      return;
    }

    // ---------- 抛物线（审判之锤 / 末日审判） ----------
    if (kind === 'parabola') {
      // 优先砸向最近的怪，没有怪就砸向面向方向
      const target = nearestMob(w, p.x, p.y, def.throwDist * 1.6);
      const ang = target ? Math.atan2(target.y - p.y, target.x - p.x) : p.facing;
      const dist = target ? distance(p.x, p.y, target.x, target.y) : def.throwDist;

      w.strikes.push({
        id: w.nextId++,
        kind: 'parabola',
        owner: p,                       // 归属：这把锤子是谁砸的
        sx: p.x, sy: p.y,
        x: clamp(p.x + Math.cos(ang) * dist, 20, w.map.w - 20),
        y: clamp(p.y + Math.sin(ang) * dist, 20, w.map.h - 20),
        r: range,
        dmg: dmg,
        delay: def.flySec,
        life: def.flySec,
        stunSec: def.stunSec || 0,
        color: '#ffcf5c'
      });
      return;
    }
  }

  function clamp(v, min, max) {
    return v < min ? min : (v > max ? max : v);
  }

  // ============================================================
  // 怪物 AI
  // ============================================================

  function updateMobs(w, dt) {
    const list = w.mobs;

    // 先算一遍指挥光环（血祭司给周围加速），只对活着的执行
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      m.buffMul = 1;
    }
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive || !m.def.auraSpeedMul) continue;

      const ar = m.def.auraRadius;
      const ar2 = ar * ar;
      for (let j = 0; j < list.length; j++) {
        const o = list[j];
        if (!o.alive || o === m) continue;
        const dx = o.x - m.x;
        const dy = o.y - m.y;
        if (dx * dx + dy * dy <= ar2) {
          o.buffMul = Math.max(o.buffMul, m.def.auraSpeedMul);
        }
      }
    }

    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive) continue;

      // 多人要点：每只怪各自追「离自己最近的活玩家」，而不是全体追同一个人。
      // 单机时最近的那个永远就是唯一那个玩家，行为与改造前一致。
      const p = nearestPlayer(w, m.x, m.y);
      if (!p) continue;      // 全员阵亡：怪原地停住，别让它去找已经不存在的人

      // 计时器
      if (m.hitCd > 0) m.hitCd -= dt;
      if (m.stun > 0) m.stun -= dt;
      if (m.flash > 0) m.flash -= dt;

      // 击退速度衰减
      m.kx *= 0.86;
      m.ky *= 0.86;

      const def = m.def;

      // ---------- Boss 专属：贴身光环持续伤害 ----------
      // 原来这里还有一段放射弹幕，已按「怪物不做远程攻击」拆掉。
      if (def.kind === 'boss') {
        const dp = distance(m.x, m.y, p.x, p.y);
        if (dp <= def.auraRadius) {
          m.auraTick = (m.auraTick || 0) - dt;
          if (m.auraTick <= 0) {
            m.auraTick = def.auraTickSec;
            damagePlayer(w, p, def.auraDot, m.x, m.y);
          }
        }
      }

      // ---------- 移动：冲锋型周期加速直冲，其余直接追 ----------
      // 【这里必须是独立的 if，不能接到上面 Boss 那个 if 后面当 else if】
      // 删掉远程分支时踩过：`if (boss) … else if (charger) … else 追` 会让
      // Boss 落进第一个分支后就不再走到「追」那一支 —— 领主站着不动，
      // 是 simtest 的位移断言把它抓出来的。
      if (def.kind === 'charger') {
        if (m.charging > 0) {
          m.charging -= dt;
          const mul = def.chargeMul;
          moveMobToward(w, m, p.x, p.y, dt, mul);
        } else {
          m.chargeCd -= dt;
          moveMobToward(w, m, p.x, p.y, dt);
          if (m.chargeCd <= 0 && distance(m.x, m.y, p.x, p.y) > 60) {
            m.chargeCd = def.chargeCd;
            m.charging = def.chargeSec;
          }
        }
      }

      // ---------- 其余（小怪 / 精英 / 指挥 / Boss）：直接追 ----------
      else {
        moveMobToward(w, m, p.x, p.y, dt);
      }
      // 说明：Boss 既走上面的光环分支，也走这里的「直接追」—— 光环只是附加伤害，
      // 不代表它站着不动。

      // 位置整合：AI 速度 + 击退冲量（带地形碰撞，会沿障碍滑行而不是插进去）
      // 第五个参数 = 允许自动绕障（只有怪开；玩家自己控制方向，不需要代劳）
      moveWithObstacles(w, m, m.vx * dt + m.kx * dt, m.vy * dt + m.ky * dt, true);

      // 地图边界阻挡（留出自身半径）
      m.x = clamp(m.x, m.r, w.map.w - m.r);
      m.y = clamp(m.y, m.r, w.map.h - m.r);

      // 与玩家接触伤害（每个怪自己带冷却，避免一帧叠死）
      const contact = distance(m.x, m.y, p.x, p.y);
      if (contact <= m.r + p.r && m.hitCd <= 0 && p.alive) {
        m.hitCd = 0.6;
        damagePlayer(w, p, def.dmg, m.x, m.y);
      }
    }
  }

  // 让怪朝目标走：把速度写进 vx/vy（真正的位置整合在外层统一做）
  function moveMobToward(w, m, tx, ty, dt, speedMul) {
    if (m.stun > 0) {
      m.vx = 0;
      m.vy = 0;
      return;
    }
    const dx = tx - m.x;
    const dy = ty - m.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    let sp = m.def.speed * (m.buffMul || 1) * (speedMul || 1);

    let vx = (dx / d) * sp;
    let vy = (dy / d) * sp;

    // 血蝠带正弦摆动，走位不那么呆
    if (m.def.wobble) {
      const wob = Math.sin(w.time * m.def.wobble + m.phase) * 0.5;
      const nx = -dy / d;
      const ny = dx / d;
      vx += nx * sp * wob;
      vy += ny * sp * wob;
    }

    m.vx = vx;
    m.vy = vy;
  }

  // 敌人子弹：单独放一个数组里，和玩家投射物区分开，避免互相判定。
  //
  // 【当前没有任何调用方】—— 怪物按产品要求全部改成近战/冲锋了（见 const.js 的 MOBS）。
  // 函数与下面的 updateEnemyShots 一起保留：恢复远程怪只要给 def 加回
  // shootCd / arrowSpeed / arrowR 三个字段，并在 updateMobs 里调这里即可，
  // 快照（proto_bin 的 shots）、渲染（drawEnemyShots）都是通的，不用再动别处。
  function spawnEnemyArrow(w, from, ang, speed, r, dmg) {
    if (!w.enemyShots) w.enemyShots = [];
    w.enemyShots.push({
      id: w.nextId++,
      x: from.x, y: from.y, px: from.x, py: from.y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      r: r, dmg: dmg, life: 5
    });
  }

  // 敌弹命中了哪个玩家？没命中返回 null。
  // 多人局必须逐个玩家判定：一粒弹只能打中一个人，谁被撞上就扣谁的血。
  function hitAnyPlayer(w, s) {
    const list = w.players;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p.alive) continue;
      if (distance(s.x, s.y, p.x, p.y) <= s.r + p.r) return p;
    }
    return null;
  }

  function updateEnemyShots(w, dt) {
    if (!w.enemyShots) return;
    const list = w.enemyShots;
    let write = 0;

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      s.life -= dt;
      s.x += s.vx * dt;
      s.y += s.vy * dt;

      // 命中玩家
      const hit = s.life > 0 ? hitAnyPlayer(w, s) : null;
      if (hit) {
        damagePlayer(w, hit, s.dmg, s.x, s.y);
        continue;      // 命中即消失
      }
      // 出界或超时消失
      if (s.life <= 0 || s.x < 0 || s.y < 0 || s.x > w.map.w || s.y > w.map.h) continue;

      list[write++] = s;
    }
    list.length = write;
  }

  // ============================================================
  // 投射物 / 区域 / 落点 / 环绕
  // ============================================================

  function updateProjectiles(w, dt) {
    const list = w.projectiles;
    const mobs = w.mobs;
    let write = 0;

    for (let i = 0; i < list.length; i++) {
      const pr = list[i];
      pr.life -= dt;
      if (pr.life <= 0) continue;

      // 归属：把上下文切到这个投射物的主人。
      // 效果是「命中造成的伤害/金币/击杀回血」全都记到正确的人头上，
      // 下面回旋刃分支里的 const p = w.player 也自动指向主人（它是要飞回主人身边的）。
      setCtx(w, pr.owner || w.self);

      // ---------- 回旋刃：去程到点后折返 ----------
      if (pr.kind === 'boomerang') {
        const p = w.player;
        if (pr.phase === 'out') {
          pr.traveled += pr.speed * dt;
          if (pr.traveled >= pr.maxTravel) {
            pr.phase = 'back';
            pr.hitIds = {};      // 折返后可以再次命中同一目标
          }
        } else {
          // 回程：朝玩家飞
          const dx = p.x - pr.x;
          const dy = p.y - pr.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          pr.vx = (dx / d) * pr.speed;
          pr.vy = (dy / d) * pr.speed;
          if (d < 22) {
            pr.tripsDone += 1;
            if (pr.tripsDone >= pr.trips) {
              continue;          // 往返次数用完，消失
            }
            pr.phase = 'out';
            pr.traveled = 0;
            pr.hitIds = {};
            const ang = Math.atan2(pr.vy, pr.vx);
            pr.vx = Math.cos(ang) * pr.speed;
            pr.vy = Math.sin(ang) * pr.speed;
          }
        }
      }

      // ---------- 追踪：每帧校正朝向最近目标 ----------
      if (pr.kind === 'homing') {
        if (!pr.targetId || !findMobById(w, pr.targetId)) {
          const t = nearestMob(w, pr.x, pr.y, 900);
          pr.targetId = t ? t.id : 0;
        }
        const t = pr.targetId ? findMobById(w, pr.targetId) : null;
        if (t) {
          const wantAng = Math.atan2(t.y - pr.y, t.x - pr.x);
          const curAng = Math.atan2(pr.vy, pr.vx);
          let diff = wantAng - curAng;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          const maxTurn = pr.turnRate * dt;
          const turn = clamp(diff, -maxTurn, maxTurn);
          const ang = curAng + turn;
          pr.vx = Math.cos(ang) * pr.speed;
          pr.vy = Math.sin(ang) * pr.speed;
        }
      }

      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;

      // 出界即消失
      if (pr.x < -60 || pr.y < -60 || pr.x > w.map.w + 60 || pr.y > w.map.h + 60) continue;

      // 撞到障碍就消失 —— 这是「地形能挡视线」的价值来源：
      // 躲在墓碑后面真的打不到你，隔着断墙也打不到人。
      // ★回旋刃例外：它的任务是「出去一圈再飞回主人身边」，
      //   被墙挡在半路就永远回不来了。武器各有各的规则，这里不搞一刀切。
      if (w.obstacles && w.obstacles.length && pr.kind !== 'boomerang' &&
          pointBlocked(w, pr.x, pr.y, pr.r)) {
        // 留一小段撞墙特效，玩家才知道「是被墙挡了」而不是「子弹凭空消失」
        w.effects.push({
          kind: 'hit', x: pr.x, y: pr.y, r: pr.r * 2,
          life: 0.12, maxLife: 0.12, color: '#9ba3af'
        });
        continue;
      }

      // ---------- 与怪物碰撞 ----------
      let dead = false;
      for (let j = 0; j < mobs.length; j++) {
        const m = mobs[j];
        if (!m.alive) continue;
        if (pr.hitIds[m.id]) continue;

        const rr = pr.r + m.r;
        const dx = m.x - pr.x;
        const dy = m.y - pr.y;
        if (dx * dx + dy * dy > rr * rr) continue;

        pr.hitIds[m.id] = 1;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        damageMob(w, m, pr.dmg, (dx / d) * 14, (dy / d) * 14);

        // 陨星：命中爆炸
        if (pr.explodeRadius > 0) {
          damageInCircle(w, pr.x, pr.y, pr.explodeRadius, pr.explodeDmg, 30);
          w.effects.push({
            kind: 'ring', x: pr.x, y: pr.y, r: pr.explodeRadius,
            life: 0.2, maxLife: 0.2, color: '#ff9f45'
          });
        }

        if (pr.kind === 'boomerang') continue;   // 往返武器可重复穿

        pr.pierce -= 1;
        if (pr.pierce <= 0) {
          dead = true;
          break;
        }
      }

      if (dead) continue;
      list[write++] = pr;
    }
    list.length = write;
  }

  function findMobById(w, id) {
    const list = w.mobs;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id && list[i].alive) return list[i];
    }
    return null;
  }

  function updateZones(w, dt) {
    const list = w.zones;
    let write = 0;

    for (let i = 0; i < list.length; i++) {
      const z = list[i];
      z.life -= dt;
      if (z.life <= 0) continue;

      // 归属：这口地面区域是谁扔的，每跳的伤害就算谁的
      setCtx(w, z.owner || w.self);

      z.tickTimer -= dt;
      if (z.tickTimer <= 0) {
        z.tickTimer = z.tickSec;
        // 每跳打一次，用 hitKey 保证同一跳内不重复
        z.hitKeySeed = (z.hitKeySeed || 0) + 1;
        damageInCircle(w, z.x, z.y, z.r, z.dmg, 18, { hitKey: z.hitKey + '_' + z.hitKeySeed });
      }
      list[write++] = z;
    }
    list.length = write;
  }

  function updateStrikes(w, dt) {
    const list = w.strikes;
    let write = 0;

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      s.life -= dt;
      if (s.life > 0) {
        list[write++] = s;
        continue;
      }

      // 归属：落点砸下来之前的最后一步也要切上下文，否则伤害会算到别人头上
      setCtx(w, s.owner || w.self);

      // 到点：造成范围伤害
      damageInCircle(w, s.x, s.y, s.r, s.dmg, 40, { stunSec: s.stunSec || 0 });
      w.effects.push({
        kind: 'boom', x: s.x, y: s.y, r: s.r,
        life: 0.3, maxLife: 0.3, color: s.color
      });
      // 不写回数组 = 移除
    }
    list.length = write;
  }

  function updateOrbits(w, dt) {
    const list = w.orbits;
    let write = 0;

    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      o.life -= dt;
      if (o.life <= 0) continue;

      // 归属：环绕物的圆心是「它的主人」，不是「自己」。
      // 多人局里别人的经卷必须围着别人转，否则会看到他那边飞过来一圈东西。
      const p = setCtx(w, o.owner || w.self);

      o.angle += o.speed * dt;
      if (o.angle > Math.PI * 2) o.angle -= Math.PI * 2;

      o.x = p.x + Math.cos(o.angle) * o.r;
      o.y = p.y + Math.sin(o.angle) * o.r;

      // 命中冷却：每个怪对每本经卷有自己的冷却，避免一帧连打
      const mobs = w.mobs;
      for (let j = 0; j < mobs.length; j++) {
        const m = mobs[j];
        if (!m.alive) continue;
        const rr = o.size + m.r;
        const dx = m.x - o.x;
        const dy = m.y - o.y;
        if (dx * dx + dy * dy > rr * rr) continue;

        const key = o.id + '_' + m.id;
        const last = w.time - (o.hitMap[key] || -99);
        if (last < o.hitSec) continue;
        o.hitMap[key] = w.time;

        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        damageMob(w, m, o.dmg, (dx / d) * 10, (dy / d) * 10);
      }

      list[write++] = o;
    }
    list.length = write;
  }

  // ============================================================
  // 掉落物拾取
  // ============================================================

  function updatePickups(w, dt) {
    const list = w.pickups;
    let write = 0;

    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      it.life -= dt;
      if (it.life <= 0) continue;

      // 多人要点：每颗掉落物各归「离它最近的那个活人」——
      // 谁近就吸给谁、吃到算谁的经验/金币/回血。
      // 单机时最近的那个永远就是唯一玩家，行为与改造前完全一致。
      const p = nearestPlayer(w, it.x, it.y);
      if (!p) {
        // 全员阵亡：掉落物原地留着（等待观战/重连的人回来），别让它凭空消失
        list[write++] = it;
        continue;
      }
      setCtx(w, p);

      const pickupR = p.attrs.pickupRadius;
      const attractR = Math.max(pickupR, C.DROPS.magnetAttractDist);

      const dx = p.x - it.x;
      const dy = p.y - it.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;

      // 进入拾取半径直接吃；在吸引范围内则被吸过来
      if (d <= pickupR) {
        if (it.kind === 'exp') {
          gainExp(w, it.value * p.attrs.expMul);
        } else if (it.kind === 'gold') {
          // 难度金币倍率在这里乘，而不是结算时再乘：
          // 让 HUD 上跳的数字、结算面板里的数字、落库的数字永远是同一个 ——
          // 「面板显示 120，档案里写 360」这种不一致，玩家只会当成 bug。
          const got = Math.round(it.value * p.attrs.goldMul * w.diff.goldMul);
          w.stats.gold += got;
          // 可花余额：金币现在有实际用途了（暂停面板的商店，见 const.js 的 SHOP）
          p.shopGold += got;
        } else if (it.kind === 'heart') {
          healPlayer(w, it.value);
        } else if (it.kind === 'chest') {
          // 宝箱 = 一次免费升级。直接塞进 pendingLevels，复用现成的升级三选一流程：
          // 这样「开箱」走的是玩家最熟悉的那条路径，不需要为它发明新的界面。
          //
          // 【等级数字必须一起涨】只加 pendingLevels 会破掉「应得的选择次数 == 等级提升数」
          // 这个不变式：界面显示 5 级，却能白拿一次三选一，玩家会以为卡了 bug。
          // 所以这里走与 gainExp 完全相同的三步（等级、下一级所需经验、待选次数），
          // 并同样重算属性 —— 差别只在于「经验从哪来」：那边是吃球，这边是开箱。
          // 不走 gainExp 本身是因为它带王冠加成，而宝箱给的是次数不是经验。
          p.level += 1;
          p.expNext = C.expNext(p.level);
          p.pendingLevels += C.DROPS.chest.freeLevelUps;
          // 走与 gainExp 同一套「升级加血」逻辑：宝箱加的等级也该涨血量上限，
          // 否则会出现「吃了宝箱升了一级，但血量没动」这种前后不一致。
          applyLevelHp(w, p, C.DROPS.chest.freeLevelUps);
          w.stats.gold += Math.round(C.DROPS.chest.gold * p.attrs.goldMul * w.diff.goldMul);
          // 宝箱附带的金币同样进可花余额（否则「开了箱却没东西可买」会很莫名其妙）
          p.shopGold += Math.round(C.DROPS.chest.gold * p.attrs.goldMul * w.diff.goldMul);
          // 立刻开面板：玩家正踩在宝箱上，这时候弹三选一最顺。
          // 若他已经在选（openLevelUp 会直接返回），这次免费升级留在 pendingLevels 里，
          // 由 chooseLevelUp 选完自动接着开 —— 不会丢。
          openLevelUp(w);
          w.events.push({ type: 'chest_open', slot: p.slot, name: p.name });
        }
        continue;
      }

      // 【宝箱刻意不被磁石吸走】它是「要专门走过去拿的奖励」，
      // 会被自动吸过来的话，那一刻就消失了 —— 而整局里正好需要这么几个
      // 「主动去捡」的瞬间。其余掉落物照旧吸附，别改。
      if (it.kind === 'chest') {
        list[write++] = it;
        continue;
      }

      if (d <= attractR) {
        const sp = C.DROPS.magnetSpeed;
        it.x += (dx / d) * sp * dt;
        it.y += (dy / d) * sp * dt;
      }

      list[write++] = it;
    }
    list.length = write;
  }

  // 升级带来的血量增长：把「上限 +8、当前血也 +8」这件事做准。
  //
  // 【为什么不能只靠 recalcAttrs】recalcAttrs 在血量上限变化时是按**比例**校正当前血量
  // （换被动时需要这个语义：上限 +20% 就该按 +20% 缩放当前血）。
  // 但升级加血的语义是**绝对量**：残血时升级必须立刻补上这 8 点，
  // 按比例的话残血只能补 4 点 —— 那正是「升级那一刻感觉不到回报」的来源。
  // 所以这里先把升级前的血量记下来，重算之后再按绝对量写回去，覆盖掉比例校正的结果。
  function applyLevelHp(w, p, levels) {
    const bonus = C.PLAYER.hpPerLevel * levels;
    const hpBefore = p.hp;              // 升级前的当前血量（比例校正之前）

    // recalcAttrs 走 w.player 上下文，这里临时切过去（与 makePlayer 同一套做法）
    const prevCtx = w.player;
    setCtx(w, p);
    recalcAttrs(w);
    if (prevCtx) setCtx(w, prevCtx);

    // 阵亡中的人不吃这条：他的血量由复活流程接管（复活时按 reviveHpRatio 给血）。
    // 不加这个判断的话，一个倒在地上等人的玩家会因为队友吃球升了级而被"喂"回血。
    if (p.alive) p.hp = Math.min(p.maxHp, hpBefore + bonus);
  }

  // 加经验。操作的是「当前上下文玩家」w.player —— 经验永远是本人的，
  // 多人局里谁吃到球就加给谁，绝不能写到世界级字段上。
  function gainExp(w, amount) {
    const p = w.player;
    // 玩家已阵亡就不再结算经验，避免「死了还在升级」把状态从 dead 改回 levelup
    if (!p || !p.alive) return;

    p.exp += amount;
    let gained = 0;

    while (p.exp >= p.expNext) {
      p.exp -= p.expNext;
      p.level += 1;
      p.expNext = C.expNext(p.level);
      // 攒在「他」身上而不是世界上：别人不该被我的升级次数影响
      p.pendingLevels += 1;
      gained += 1;
    }

    if (gained > 0) {
      // 升级加血：等级已经涨过了，这里把上限与当前血量一起抬上去
      applyLevelHp(w, p, gained);
      openLevelUp(w);
    }
  }

  // ============================================================
  // 局内商店（花金币）
  // ============================================================
  // 【为什么只有单机能用】多人局世界由服务端推进，商店开在暂停面板里，
  //   而联机根本没有「暂停」这一屏（菜单不冻结世界）—— 所以它自然只在单机出现。
  //   绝不做「联机也能买」的半吊子：那等于花钱在一个不会停的世界里换东西，
  //   队友还在打你却被砍一刀，性质和升级面板遮住战场一样是破坏规则。
  //
  // 【为什么在 sim 而不是界面层做扣钱】钱与效果的结算必须**原子**：
  // 界面先扣钱再让 sim 加血，中途出错就变成「钱没了血没回」。
  // 所以这里一次判定、一次扣、一次生效，返回布尔告诉界面成没成。
  //
  // 【为什么返回 failReason 而不是只返回 false】界面要能告诉玩家
  // 「买不了是因为金币不够，还是因为血契石已满 3 层」——
  // 只给一个 false，界面只能把按钮一禁了之，玩家不知道下一步该干什么。
  // ============================================================
  // 局内商店（花金币）
  // ============================================================

  // 一件技能 id 属于哪一类 —— 商店的「买技能 / 换技能」全靠它分派。
  //   'weapon'  武器（注意 WEAPON_MAP 里**也含进化形态**，所以要单独挡住，见 shopBuy）
  //   'passive' 被动
  //   ''        不是玩家能持有的东西（组合技走 combos，不进商店）
  function skillKind(id) {
    if (C.WEAPON_MAP[id]) return 'weapon';
    if (C.PASSIVE_MAP[id]) return 'passive';
    return '';
  }

  function skillListOf(p, kind) {
    return kind === 'weapon' ? p.weapons : p.passives;
  }

  function skillCapOf(kind) {
    return kind === 'weapon' ? C.SLOTS.weapon : C.SLOTS.passive;
  }

  function kindLabel(kind) {
    return kind === 'weapon' ? '武器' : '被动';
  }

  function ownsSkill(p, kind, id) {
    const list = skillListOf(p, kind);
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return true;
    }
    return false;
  }

  // 花金币买东西。
  //   itemId  商品 id
  //   player  省略时按「自己」处理
  //   opt     两段式商品（`pick`）的第二段选择：
  //             { pick: 'whip' }                        血脉契约：要习得哪一件
  //             { drop: 'garlic', pick: 'holy_water' }  置换契约：遗忘哪件 + 换成哪件
  //
  // 【为什么第二段选择也塞进这个函数】钱与效果必须**一次判定、一次扣、一次生效**。
  //   如果让界面先扣钱、再调一个「加技能」的接口，中间任何一步失败就变成
  //   「钱没了技能也没到」——玩家会当成 bug，而且事后没法查（服务端没留下痕迹）。
  //   所以「选哪件」只是参数，判定与结算依然全在这一个函数里。
  //
  // 【为什么没带 opt 时一分钱不扣】点「血脉契约」只是「我要买这类东西」，
  //   还没说要哪一件。此时扣钱等于把风险丢给玩家。所以回 { needPick }，
  //   由界面去开选择器，选完再带着 opt 调一次。
  function shopBuy(w, itemId, player, opt) {
    const p = player || w.self;
    const list = C.SHOP.items;
    let item = null;
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === itemId) { item = list[i]; break; }
    }
    if (!item) return { ok: false, reason: '没有这一项' };
    if (!p) return { ok: false, reason: '找不到玩家' };

    // 血契石有层数上限：满层时要说清是「满了」而不是含糊的「买不了」
    let stacks = 0;
    if (item.cost && item.cost.dmgMul) stacks = Math.round(p.shopBuffDmg / item.cost.dmgMul);
    if (item.maxStacks && stacks >= item.maxStacks) {
      return { ok: false, reason: '已经叠到上限（' + item.maxStacks + ' 层）' };
    }

    // 两段式商品还没带选择 → 只告诉界面「该去开选择器了」，不扣钱
    if (item.pick && !opt) {
      return {
        ok: false,
        needPick: item.pick,
        reason: item.pick === 'swap' ? '请选择要遗忘和要换上的技能' : '请选择要习得的技能'
      };
    }

    // ---------- 技能类商品的全部合法性判定（一律在扣钱之前做完）----------
    // 【为什么必须先判完】下面扣钱那行之后就没有回头路了。让「钱扣了但技能没加上」
    //   成为不可能，靠的不是小心，而是把所有拒绝分支都摆在扣钱前面。
    let addKind = '';
    let addId = '';
    let dropKind = '';
    let dropId = '';

    if (item.pick === 'new') {
      const want = opt && opt.pick;
      const k = skillKind(want);
      if (!k) return { ok: false, reason: '没有这一项技能' };
      // 进化形态不能直接买：它是「满级武器 ＋ 满级被动」合成出来的终点，
      // 直接花金币买到等于把那条成长线整条跳过去（而且 10 组进化里有的比金币值钱得多）。
      const wdef = C.WEAPON_MAP[want];
      if (wdef && wdef.evolved) return { ok: false, reason: '进化形态要在升级里合成，不能直接买' };
      if (ownsSkill(p, k, want)) return { ok: false, reason: '已经学过了' };
      // 「原武器已进化」的情况：p.weapons 里存的 id 变成了进化形态，
      // 按 id 找原武器会找不到 —— 但这时**不能再买一把原武器**（那会出现「血鞭 ＋ 铁鞭」并存）。
      const evo = k === 'weapon' ? C.EVO_BY_WEAPON[want] : null;
      if (evo && ownsSkill(p, 'weapon', evo.id)) {
        return { ok: false, reason: '这件已经进化成「' + evo.name + '」了' };
      }
      const cap = skillCapOf(k);
      const used = skillListOf(p, k).length;
      if (used >= cap) {
        return {
          ok: false,
          reason: kindLabel(k) + '格已满（' + used + '/' + cap + '），先用置换契约腾一格'
        };
      }
      addKind = k;
      addId = want;
    } else if (item.pick === 'swap') {
      const want = opt && opt.pick;
      const drop = opt && opt.drop;
      if (!want || !drop) {
        return { ok: false, needPick: 'swap', reason: '请选择要遗忘和要换上的技能' };
      }
      if (drop === want) return { ok: false, reason: '不能换成同一件' };
      const dk = skillKind(drop);
      if (!dk) return { ok: false, reason: '要遗忘的不是可替换的技能' };
      if (!ownsSkill(p, dk, drop)) return { ok: false, reason: '要遗忘的那件还没学' };
      const ak = skillKind(want);
      if (!ak) return { ok: false, reason: '没有这一项技能' };
      const wdef2 = C.WEAPON_MAP[want];
      if (wdef2 && wdef2.evolved) return { ok: false, reason: '进化形态不能直接换成' };
      if (ownsSkill(p, ak, want)) return { ok: false, reason: '要换的那件已经学过了' };
      const evo2 = ak === 'weapon' ? C.EVO_BY_WEAPON[want] : null;
      if (evo2 && ownsSkill(p, 'weapon', evo2.id)) {
        return { ok: false, reason: '这件已经进化成「' + evo2.name + '」了' };
      }
      // 容量：遗忘一件同类就腾出一个位置，所以要看「换完之后」的数量。
      // 跨类置换（丢被动换武器）时武器那边不会腾位，满了就得挡住 —— 否则
      // 买完之后 weapons 会超上限，槽位行会画出一个「第 11 格」。
      const afterDrop = skillListOf(p, ak).length - (ak === dk ? 1 : 0);
      const cap2 = skillCapOf(ak);
      if (afterDrop >= cap2) {
        return {
          ok: false,
          reason: kindLabel(ak) + '格已满（' + afterDrop + '/' + cap2 + '），先遗忘一件' + kindLabel(ak)
        };
      }
      dropKind = dk;
      dropId = drop;
      addKind = ak;
      addId = want;
    }

    if (p.shopGold < item.price) {
      // 差多少直接说：玩家能据此判断「再打一波就买得起了」，
      // 只说「金币不够」的话他不知道还差 5 枚还是 500 枚。
      const lack = item.price - p.shopGold;
      return { ok: false, reason: '还差 ' + lack + ' 金币' };
    }

    p.shopGold -= item.price;

    if (item.cost && item.cost.hp) {
      healPlayer(w, item.cost.hp);
    }
    if (item.cost && item.cost.exp) {
      // 走 gainExp 而不是直接改exp：它会连带处理升级、升级加血与开升级面板。
      // 绕过它就意味着「买了笔记但等级没涨」—— 那玩家一定会当成 bug。
      setCtx(w, p);
      gainExp(w, item.cost.exp);
    }
    if (item.cost && item.cost.dmgMul) {
      p.shopBuffDmg += item.cost.dmgMul;
    }

    // ---------- 技能落地（先遗忘、再习得，顺序不能反）----------
    // 【为什么必须先遗忘】置换契约里「50 金买被动、被动格恰好已满」这种情况：
    //   先加会短暂超上限（而槽位行是按上限画的，多出来的那件会渲染到不存在的格子里）；
    //   先忘再补则全程合法。
    if (dropId) {
      const dl = skillListOf(p, dropKind);
      for (let i = 0; i < dl.length; i++) {
        if (dl[i].id === dropId) { dl.splice(i, 1); break; }
      }
    }
    if (addId) {
      if (addKind === 'weapon') {
        // timer / rt 两个字段不能省：fireWeapon 每帧读它们，缺了就是 NaN 冷却。
        p.weapons.push({ id: addId, level: 1, timer: 0, rt: {} });
      } else {
        p.passives.push({ id: addId, level: 1 });
      }
    }

    // 属性必须重算：否则新买的被动要等到下一次拿武器才生效 ——
    // 玩家花了 80 枚金币却感觉不到变强，那这笔钱就白花了。
    // 重算前必须把上下文切到他身上（recalcAttrs 读的是 w.player，见那边的注释）。
    if (addId || dropId || (item.cost && item.cost.dmgMul)) {
      const prevCtx = w.player;
      setCtx(w, p);
      recalcAttrs(w);
      if (prevCtx) setCtx(w, prevCtx);
    }

    return {
      ok: true,
      item: item,
      gold: p.shopGold,
      added: addId || null,
      addedKind: addKind || null,
      dropped: dropId || null
    };
  }

  // ============================================================
  // 升级三选一
  // ============================================================

  // 玩家手上有没有「这件武器」并且练到了指定等级 —— 组合技配方的判定。
  //
  // 【为什么要折算进化形态】铁鞭进化成血鞭之后 p.weapons 里存的 id 是 'blood_whip'，
  // 按 id 直接找 'whip' 会找不到，玩家就会看到「配方明明齐了却提示没凑齐」。
  // 所以这里把进化形态折算回它的原始武器（EVOLUTIONS 的 from 字段）。
  //
  // 【为什么进化形态直接算达标】它是原始武器练满之后才合成出来的 ——
  // 反过来要求「进化形态也到 Lv5」是荒谬的（它根本不是同一件武器，
  // 而且进化后等级被重置成 1）。
  function ownsWeapon(p, weaponId, needLevel) {
    for (let i = 0; i < p.weapons.length; i++) {
      const own = p.weapons[i];
      const def = C.WEAPON_MAP[own.id];
      const baseId = (def && def.from) ? def.from : own.id;
      if (baseId !== weaponId) continue;
      if (def && def.evolved) return true;
      return own.level >= needLevel;
    }
    return false;
  }

  // 给关联说明补上「配方里那另一件，玩家自己有没有、几级」。
  //
  // 【为什么必须补】候选卡上写「可凑组合技「血雾领域」（需要 5 级）」只是配方的一半 ——
  // 玩家真正要判断的是「我还差什么」。把另一件的持有状态一起给出来
  // （已有 Lv3 / 未持有 / 已达标），候选卡才从「一句提示」变成「一个可执行的下一步」。
  //
  // ★为什么放在 sim 而不是 const：const 是纯数据表，拿不到玩家状态；
  //   而「谁拥有什么」只在世界里。所以 const 只给「另一件是谁」（pairId/pairKind），
  //   由这里查玩家的持有表补上 pairLv / pairOwned / pairName。
  function attachLinkOwnership(p, links) {
    if (!links || !links.length) return links;
    for (let i = 0; i < links.length; i++) {
      const lk = links[i];
      if (!lk.pairId) continue;
      let lv = 0;
      let name = lk.pairId;
      if (lk.pairKind === 'passive') {
        const pd = C.PASSIVE_MAP[lk.pairId];
        name = pd ? pd.name : lk.pairId;
        for (let j = 0; j < p.passives.length; j++) {
          if (p.passives[j].id === lk.pairId) { lv = p.passives[j].level; break; }
        }
      } else {
        const wd = C.WEAPON_MAP[lk.pairId];
        name = wd ? wd.name : lk.pairId;
        for (let j = 0; j < p.weapons.length; j++) {
          const own = p.weapons[j];
          const def = C.WEAPON_MAP[own.id];
          // ★进化形态要折算回原始武器：持有的是「血鞭」时，配方里要认的就是「铁鞭」。
          //   不折算的话，玩家明明拿着进化版却被标成「未持有」。
          const baseId = (def && def.from) ? def.from : own.id;
          if (baseId === lk.pairId) { lv = own.level; break; }
        }
      }
      lk.pairName = name;
      lk.pairLv = lv;
      lk.pairOwned = lv > 0;
      // 「这一半也达标了」—— 只有两半都到 needLevel 才谈得上配方齐
      lk.pairReady = lv >= (lk.needLevel || 0);
    }
    return links;
  }

  // 武器 id 换成人看的名字（组合技提示里要写「铁鞭 Lv5 + 蒜雾 Lv5」）
  function weaponLabel(id) {
    const def = C.WEAPON_MAP[id];
    return def ? def.name : id;
  }

  // 组装候选池：新武器 / 武器升级 / 新被动 / 被动升级 / 进化 / 组合技
  function buildChoices(w) {
    const p = w.player;
    const pool = [];

    // 进化优先级最高：满级武器 + 对应满级被动
    for (let i = 0; i < p.weapons.length; i++) {
      const own = p.weapons[i];
      const evo = C.EVO_BY_WEAPON[own.id];
      if (!evo || own.level < C.GROWTH.maxLevel) continue;

      const need = p.passives.find(function (x) { return x.id === evo.need; });
      if (need && need.level >= C.PASSIVE_MAX_LEVEL) {
        pool.push({
          type: 'evolve',
          weaponId: own.id,
          id: evo.id,
          name: evo.name,
          desc: evo.desc,
          tag: '进化'
        });
      }
    }

    // 已有武器升级
    for (let i = 0; i < p.weapons.length; i++) {
      const own = p.weapons[i];
      const def = C.WEAPON_MAP[own.id];
      if (!def || def.evolved) continue;
      if (own.level >= C.GROWTH.maxLevel) continue;
      pool.push({
        type: 'weapon_up',
        id: own.id,
        name: def.name,
        desc: '等级 ' + own.level + ' → ' + (own.level + 1) + '　' + def.desc,
        tag: '武器升级',
        // ★关联说明：练这件武器能通往哪（组合技 / 进化）。
        // 玩家在候选卡上问的其实是「我为什么该选它」——
        // 只写「伤害 12→14」他不知道有更远的路，而「可凑组合技血雾领域」才是决策依据。
        // 传 own.level 是为了让说明能区分「已齐」与「还差几级」（见 const.weaponLinks）。
        links: attachLinkOwnership(p, C.weaponLinks(own.id, own.level + 1))
      });
    }

    // 已有被动升级
    for (let i = 0; i < p.passives.length; i++) {
      const own = p.passives[i];
      const def = C.PASSIVE_MAP[own.id];
      if (!def || own.level >= C.PASSIVE_MAX_LEVEL) continue;
      pool.push({
        type: 'passive_up',
        id: own.id,
        name: def.name,
        desc: '等级 ' + own.level + ' → ' + (own.level + 1) + '　' + def.desc,
        tag: '道具升级',
        // 被动是进化的「另一半配方」，所以它的关联说明是「配哪把武器能进化成什么」
        links: attachLinkOwnership(p, C.passiveLinks(own.id))
      });
    }

    // ---------- 组合技 ----------
    // 玩家同时把两件武器练到 needLevel，就解锁对应的组合技。
    //
    // 【为什么带 hint】玩家不可能记得「血雾领域需要铁鞭 5 级 + 蒜雾 5 级」——
    // 候选卡上必须把配方写出来，否则他看到的就是一个不知道从哪来的技能，
    // 既不会选，也不知道自己刚才是怎么凑出来的。
    //
    // 【为什么组合技可以「不选」】它是可选奖励而不是必经节点：选了就多一个持续输出源，
    // 不选可以继续升手上的武器。让玩家自己权衡「现在缺的是数量还是质量」，
    // 这比"凑齐了自动送"更有决策感 —— 这也是需求里明确要的「可以选择是否升级组合技」。
    const comboPool = [];
    for (let i = 0; i < C.COMBOS.length; i++) {
      const cb = C.COMBOS[i];
      const owned = p.combos.find(function (x) { return x.id === cb.id; });

      if (owned) {
        // 已解锁：还能继续升到 maxLevel
        if (owned.level < (cb.maxLevel || 3)) {
          comboPool.push({
            type: 'combo_up',
            id: cb.id,
            name: cb.name,
            desc: '等级 ' + owned.level + ' → ' + (owned.level + 1) + '　' + cb.desc,
            hint: cb.flavor || '',
            tag: '组合技'
          });
        }
        continue;
      }

      // 未解锁：检查配方。两件武器都要在手上、且都练到 needLevel。
      // 【为什么要考虑进化形态】铁鞭进化成血鞭之后，p.weapons 里存的 id 变成
      // 'blood_whip' —— 按 id 直接找 'whip' 会找不到，玩家会看到「配方明明齐了
      // 却提示没凑齐」。所以这里要把进化形态折算回它的原始武器（见 ownsWeapon）。
      if (!ownsWeapon(p, cb.need[0], cb.needLevel)) continue;
      if (!ownsWeapon(p, cb.need[1], cb.needLevel)) continue;

      comboPool.push({
        type: 'combo_new',
        id: cb.id,
        name: cb.name,
        desc: cb.desc,
        hint: '配方已齐：' + weaponLabel(cb.need[0]) + ' Lv' + cb.needLevel +
          ' ＋ ' + weaponLabel(cb.need[1]) + ' Lv' + cb.needLevel,
        tag: '组合技'
      });
    }

    // 新武器（有空格才给）
    if (p.weapons.length < C.SLOTS.weapon) {
      for (let i = 0; i < C.WEAPONS.length; i++) {
        const def = C.WEAPONS[i];
        if (p.weapons.find(function (x) { return x.id === def.id; })) continue;
        pool.push({
          type: 'weapon_new',
          id: def.id,
          name: def.name,
          desc: def.desc,
          tag: '新武器',
          // 新武器同样带关联说明，而且**这里比升级更需要**：
          // 拿一件新武器是一次长期投入，玩家最该知道的就是「它能通往哪」。
          // 传1 是因为拿到时它就是 1 级（links 里会显示「需要 5 级」）。
          links: attachLinkOwnership(p, C.weaponLinks(def.id, 1))
        });
      }
    }

    // 新被动（有空格才给）
    if (p.passives.length < C.SLOTS.passive) {
      for (let i = 0; i < C.PASSIVES.length; i++) {
        const def = C.PASSIVES[i];
        if (p.passives.find(function (x) { return x.id === def.id; })) continue;
        pool.push({
          type: 'passive_new',
          id: def.id,
          name: def.name,
          desc: def.desc,
          tag: '新道具',
          links: attachLinkOwnership(p, C.passiveLinks(def.id))
        });
      }
    }

    // 进化跟普通项混在一起随机抽 3 个，但保证进化必进候选（玩家攒满不容易，别让他抽不到）
    const evoItems = pool.filter(function (x) { return x.type === 'evolve'; });
    const normalItems = pool.filter(function (x) { return x.type !== 'evolve'; });

    // 洗牌（用世界自己的随机数，保证可复现）
    for (let i = normalItems.length - 1; i > 0; i--) {
      const j = Math.floor(nextRand(w) * (i + 1));
      const t = normalItems[i];
      normalItems[i] = normalItems[j];
      normalItems[j] = t;
    }

    const out = [];

    // 1) 进化优先（攒满不容易，不能让他抽不到）
    for (let i = 0; i < evoItems.length && out.length < 3; i++) out.push(evoItems[i]);

    // 2) 组合技保底进一个。
    // 【为什么保底而不是让它参与洗牌】参与洗牌的话，玩家把配方凑齐之后可能连续三四次
    // 升级都抽不到它 —— 他会以为这功能没做，或者以为配方没凑对。
    // 保底一个既保证「凑齐了就能看到」，又留了「这次先升武器、下次再拿」的余地。
    // 同时凑齐多组时随机出一组，不会永远只出第一组。
    if (comboPool.length && out.length < 3) {
      const idx = Math.floor(nextRand(w) * comboPool.length) % comboPool.length;
      out.push(comboPool[idx]);
    }

    // 3) 普通候选项填满剩下的位置
    for (let i = 0; i < normalItems.length && out.length < 3; i++) out.push(normalItems[i]);

    return out;
  }

  // 弹出升级三选一。
  // 【多人要点】操作的是「当前上下文玩家」w.player，不是 w.self ——
  // 联机局里很可能是别人升级了，面板只能弹给他，不能弹到我脸上。
  function openLevelUp(w) {
    const p = w.player;
    if (!p) return;

    // 已阵亡的、或者整局已经通关的，就不要再插队了
    if (!p.alive || w.won) return;
    // 已经在选升级了就别重复抽（会把已经抽好的候选冲掉）
    if (p.state === 'levelup') return;

    p.choices = buildChoices(w);

    // 没有可选项时（全满级）给个兜底，不让流程卡死
    if (p.choices.length === 0) {
      p.choices.push({
        type: 'fallback',
        id: 'heal',
        name: '补给',
        desc: '回复 30 点生命',
        tag: '补给'
      });
    }

    p.state = 'levelup';
    // 带上 slot / name：联机时靠它把这条事件只发给该玩家（见 takeEvents）
    w.events.push({ type: 'levelup', level: p.level, slot: p.slot, name: p.name });
  }

  // 消费一次升级选择。
  //   index  候选列表的下标，非法下标按「取消」处理（不消耗升级次数、不关面板）
  //   player 省略时按「自己」处理 —— P1 的全部调用点（界面 / 自检 / 平衡脚本）一行都不用改
  function chooseLevelUp(w, index, player) {
    const p = player || w.self;
    if (!p) return false;
    if (p.state !== 'levelup') return false;

    const pick = p.choices[index];
    if (!pick) return false;

    // 服务端可能是按连接分发进来的，调用时上下文未必是这个玩家，
    // 先切过去：下面的 healPlayer / recalcAttrs 都靠上下文定位人。
    setCtx(w, p);

    if (pick.type === 'evolve') {
      // 进化：替换原武器，等级重置为 1（进化形态不再成长）
      for (let i = 0; i < p.weapons.length; i++) {
        if (p.weapons[i].id === pick.weaponId) {
          p.weapons[i] = { id: pick.id, level: 1, timer: 0, rt: {} };
          break;
        }
      }
    } else if (pick.type === 'weapon_up') {
      const own = p.weapons.find(function (x) { return x.id === pick.id; });
      if (own) own.level += 1;
    } else if (pick.type === 'passive_up') {
      const own = p.passives.find(function (x) { return x.id === pick.id; });
      if (own) own.level += 1;
    } else if (pick.type === 'weapon_new') {
      p.weapons.push({ id: pick.id, level: 1, timer: 0, rt: {} });
    } else if (pick.type === 'passive_new') {
      p.passives.push({ id: pick.id, level: 1 });
    } else if (pick.type === 'combo_new') {
      // 组合技落地：进 combos 表（不占武器槽），timer 归 0 → 下一帧就能打
      p.combos.push({ id: pick.id, level: 1, timer: 0, rt: {} });
      // 解锁组合技是这一局的高光时刻之一，单独发一条事件让界面弹提示。
      // 【为什么要这条事件】组合技的攻击会立刻出现在画面上，但玩家未必知道
      // 「刚才那个东西是我选的组合技」—— 尤其多人局里场面混乱，一条明确提示
      // 是唯一能把「我选的东西」和「屏幕上多出来的攻击」对上号的东西。
      w.events.push({
        type: 'combo', slot: p.slot, name: p.name, comboName: pick.name
      });
    } else if (pick.type === 'combo_up') {
      const own = p.combos.find(function (x) { return x.id === pick.id; });
      if (own) own.level += 1;
    } else if (pick.type === 'fallback') {
      healPlayer(w, 30);
    }

    recalcAttrs(w);

    p.pendingLevels -= 1;
    p.choices = [];
    p.state = 'playing';

    if (p.pendingLevels > 0) {
      // 还有攒着的升级，重新抽一次
      openLevelUp(w);
    }

    // 还原上下文：调用方（尤其服务端）接下来的代码默认以为自己还在「自己」的上下文里
    setCtx(w, w.self);
    return true;
  }

  // ============================================================
  // 主推进
  // ============================================================

  // 取出某个玩家这一帧的输入。
  //   P1 写法：直接传 { mx, my }，只有「自己」用得上
  //   联机写法：传按座位号索引的表，如 [[0,1], null, [-1,0]] 或 { 0: { mx, my } }
  function pickInput(inputs, slot) {
    if (!inputs) return null;
    if (inputs.mx !== undefined || inputs.my !== undefined) return inputs;
    const one = inputs[slot];
    return one || null;
  }

  // 推进一个固定步长（1/20 秒）。
  // inputs: { mx, my }（单机）或 按座位号索引的输入表（联机）
  //
  // 【帧内顺序不能乱改】下面沿用原单机版的顺序。多人化只是把「玩家自己那部分」
  // 从一段拆成了两段循环（移动一段、开火一段），中间夹着的世界步骤位置分毫未动。
  // 顺序一改，随机数的消耗次序就变了，压测基线与对局回放全部作废。
  function step(w, inputs) {
    if (w.won) return w;

    // P1 单机：弹出升级面板就冻结整个世界（与改造前完全一致）。
    // 联机时服务端把 pauseAllOnLevelUp 设为 false：只有升级中的人定格，
    // 其他人照常打 —— 否则一个人去倒杯水就能把一屋子人全卡住。
    if (w.pauseAllOnLevelUp && w.self && w.self.state === 'levelup') return w;

    const dt = C.DT;
    w.tick += 1;
    // 时间由整数 tick 换算，别用 w.time += dt 累加 ——
    // 1/20 在二进制里是无限循环小数，累加 24000 次会得到 1199.9999...，
    // 导致「满 20 分钟通关」的判定永远差一点点点不响。
    w.time = w.tick / C.TICK_HZ;

    // 已收尾（通关或超时失败）就不再推进。
    // 【为什么这个判断必须存在】剧情关的胜利条件是「击败首领」——
    // 首领死在时间到之前，之后还有几十上百帧可能继续跑（渲染还在插值、
    // 界面还在收事件）。没有这道闸，收尾之后世界还会继续刷怪、继续掉东西，
    // 结算面板上显示的数字会一直变。
    if (w.ended) return w;

    // 时间到就以「通关」收尾，并且本帧立即结束。
    // 【必须放在帧首】如果放到帧尾，最后一帧恰好拾到经验球并弹出升级面板时，
    // 状态会变回 levelup 把通关覆盖掉，通关就永远判不出来（实测踩过）。
    // 用 w.matchSec 而不是常量：难度决定这一局多长（休闲 18 分 / 血月 25 分）。
    if (w.tick >= w.matchSec * C.TICK_HZ) {
      w.ended = true;
      // ★剧情关的首领关：时间到但首领还活着 = **未通过**。
      //   这不是苛刻，而是让「首领」这个词有意义 ——
      //   否则玩家可以全程绕圈跑满 9 分钟就算通关，那只首领等于不存在。
      //   没有首领的关（第一关教学）以及自由模式，仍按「撑满时长 = 通关」。
      if (w.storyStage && w.storyStage.boss && !w.bossDefeated) {
        w.won = false;
        w.timeout = true;
        w.events.push({ type: 'timeout' });
      } else {
        w.won = true;
        w.events.push({ type: 'won' });
      }
      return w;
    }

    const players = w.players;
    const mobs = w.mobs;

    // ---------- 0. 记录上一帧位置，供渲染插值 ----------
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;
      p.px = p.x;
      p.py = p.y;
    }
    for (let i = 0; i < mobs.length; i++) {
      if (!mobs[i].alive) continue;
      mobs[i].px = mobs[i].x;
      mobs[i].py = mobs[i].y;
    }

    // ---------- 1. 玩家移动（逐个玩家） ----------
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive) continue;              // 阵亡的人不动（留给观战 / 重连）
      if (p.state === 'levelup') continue; // 正在选升级的人定格，选中前不移动也不挨打
      setCtx(w, p);
      movePlayer(w, p, pickInput(inputs, p.slot), dt);

      // ---------- 每秒回血（被动「苔藓护符」）----------
      // 放在玩家更新里而不是单开一段：它只依赖 dt 与自己的 attrs，
      // 跟着玩家循环走最省事，也天然是「每个玩家各自回各自的」。
      // 回血上限是当前最大血量 —— 满级每秒 2.5 点看着不多，但它是**唯一**
      // 不依赖击杀的回血手段：被围住打不出击杀时，它才是那根救命绳。
      if (p.attrs.regen > 0 && p.hp < p.maxHp) {
        p.hp += p.attrs.regen * dt;
        if (p.hp > p.maxHp) p.hp = p.maxHp;
      }
    }

    // ---------- 2. 波次生成 ----------
    // 同样按 tick 号判断而不是累加秒数，保证 30 秒一波是精确的 600 帧
    if (w.tick >= w.nextWaveTick) {
      spawnWave(w);
      // ★剧情关用本关自己的出怪间隔（教学关 26 秒比自由模式的 30 秒更密，
      //   但它baseCount 小所以压力更小）。自由模式仍是 30 秒。
      const gapSec = w.storyStage
        ? CP.waveIntervalOf(w.modId, w.storyStage)
        : C.WAVES.intervalSec;
      w.nextWaveTick = w.tick + Math.round(gapSec * C.TICK_HZ);
    }

    // ---------- 2.5 剧情节拍 ----------
    // 【为什么不放在 spawnWave 里】节拍是「时间到了就说一句」，
    // 与波次无关；而 spawnWave 只在波次到来时跑，两者节奏不同。
    //
    // 【为什么用下标去重而不是比较时间】step 会被暂停/升级面板/复活打断，
    // 时间可能跨过节拍点。用 storyBeatDone 记住播过哪几条，
    // 保证「每条节拍恰好播一次」，与玩家中途暂停无关。
    if (w.storyStage && w.storyStage.beats) {
      const beats = w.storyStage.beats;
      for (let i = 0; i < beats.length; i++) {
        if (w.storyBeatDone[i]) continue;
        if (w.time < beats[i].at) continue;
        w.storyBeatDone[i] = 1;
        w.events.push({ type: 'story', line: beats[i].text, at: beats[i].at });
      }
    }

    // ---------- 3. 怪物 AI ----------
    updateMobs(w, dt);

    // ---------- 4. 武器开火（逐个玩家） ----------
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (!p.alive || p.state === 'levelup') continue;
      setCtx(w, p);
      firePlayerWeapons(w, p, dt);
    }

    // ---------- 5. 投射物 / 区域 / 落点 / 环绕 / 敌弹 ----------
    // 这几个是全局的：实体各自带 owner，函数内部自己切上下文
    updateProjectiles(w, dt);
    updateZones(w, dt);
    updateStrikes(w, dt);
    updateOrbits(w, dt);
    updateEnemyShots(w, dt);

    // ---------- 6. 阵亡玩家的遗留物清理 ----------
    // 不清的话，他留下的圣水 / 落雷会变成没人认领的幽灵持续造成伤害，
    // 还会把击杀记到一个死人头上（结算界面就会出现「已阵亡却还在涨击杀」）。
    // 放在这里统一处理、而不是在受伤函数里即时删，是为了避开
    // 「一边遍历 w.projectiles 一边增删它」造成的数组错位。
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.alive || p.swept) continue;
      p.swept = true;
      removeOwnedBy(w, p);
    }

    // ---------- 6.5 阵亡倒计时：到点原地复活（只有开启复活的局会走进来） ----------
    // 放在遗物清理之后：复活那一帧 swept 会被重置回 false，顺序反了会把刚扶起来的人
    // 又当成「待清理的阵亡者」扫一遍。
    if (w.reviveOnDeath) {
      for (let i = 0; i < players.length; i++) {
        const p = players[i];
        if (p.alive || p.reviveLeft <= 0) continue;
        p.reviveLeft -= dt;
        if (p.reviveLeft <= 0) revivePlayer(w, p);
      }
    }

    // ---------- 7. 掉落拾取 ----------
    updatePickups(w, dt);

    // ---------- 8. 清理死怪（每帧就地压缩，避免数组无限增长） ----------
    compactMobs(w);

    // ---------- 9. 特效寿命 ----------
    for (let i = w.effects.length - 1; i >= 0; i--) {
      w.effects[i].life -= dt;
      if (w.effects[i].life <= 0) w.effects.splice(i, 1);
    }

    // ---------- 10. 还原上下文 ----------
    // 渲染层与 HUD 都靠 w.player / w.stats 取「自己」，这一步漏了就会看到别人的血量。
    setCtx(w, w.self);

    // 通关判定已在帧首完成，这里不再重复判断
    return w;
  }

  // 单个玩家一帧的移动部分：位移、边界、朝向、无敌帧、基础回血
  function movePlayer(w, p, input, dt) {
    let mx = input && input.mx ? input.mx : 0;
    let my = input && input.my ? input.my : 0;
    const mag = Math.sqrt(mx * mx + my * my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
    }

    // 位移走「带地形碰撞」的版本：撞到障碍时自动沿墙滑行，
    // 而不是一头扎进墙里。地图上没有障碍时它退化成普通加法，开销可忽略。
    moveWithObstacles(w, p, mx * p.attrs.speed * dt, my * p.attrs.speed * dt);

    // 地图边界
    p.x = clamp(p.x, p.r, w.map.w - p.r);
    p.y = clamp(p.y, p.r, w.map.h - p.r);

    // 面向：移动时朝移动方向；站住不动时朝最近的怪，方便武器自动瞄准
    if (mx || my) {
      p.facing = Math.atan2(my, mx);
    } else {
      const t = nearestMob(w, p.x, p.y, 800);
      if (t) p.facing = Math.atan2(t.y - p.y, t.x - p.x);
    }

    // 无敌帧递减
    if (p.invuln > 0) p.invuln -= dt;

    // 基础回血（当前为 0，预留）
    if (C.PLAYER.regenPerSec > 0) healPlayer(w, C.PLAYER.regenPerSec * dt);
  }

  // 单个玩家一帧的开火部分：冷却递减到点就放一次
  // 一份「带冷却的武器列表」的推进（武器槽与组合技共用）。
  // slot 的形状两者完全一致：{ id, level, timer, rt } —— 所以这里不需要任何特判，
  // fireWeapon 也完全不关心自己是普通武器还是组合技（它只认 kind）。
  function advanceWeapons(w, p, list, dt) {
    for (let i = 0; i < list.length; i++) {
      const slot = list[i];
      const def = C.WEAPON_MAP[slot.id];
      if (!def) continue;

      slot.timer -= dt;
      if (slot.timer > 0) continue;

      const st = C.weaponStats(def, slot.level);
      slot.timer = st.cd * p.attrs.cdMul;
      fireWeapon(w, slot);
    }
  }

  function firePlayerWeapons(w, p, dt) {
    advanceWeapons(w, p, p.weapons, dt);
    // 组合技不占武器槽，所以不在 p.weapons 里 —— 必须单独推一遍。
    // 忘了这一行的话，组合技会「解锁了但永远不开火」，而且界面上还显示已解锁。
    if (p.combos && p.combos.length) advanceWeapons(w, p, p.combos, dt);
  }

  function compactMobs(w) {
    const list = w.mobs;
    let write = 0;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m.alive) continue;
      // 清掉本帧的命中标记，下一帧可以重新命中
      if (m.hitKeys) m.hitKeys = null;
      list[write++] = m;
    }
    list.length = write;
    w.aliveMobCount = write;
  }

  // ============================================================
  // 给界面用的只读快照
  // ============================================================

  // 取一份给界面用的只读快照。
  // player 省略时取「自己」—— P1 与现有界面的调用方式完全不变；
  // 联机时服务端要为每个玩家各生成一份，就把对应的那个玩家对象传进来。
  function getHud(w, player) {
    const p = player || w.self || w.player;
    const weapons = [];
    for (let i = 0; i < p.weapons.length; i++) {
      const def = C.WEAPON_MAP[p.weapons[i].id];
      weapons.push({
        id: p.weapons[i].id,
        name: def ? def.name : p.weapons[i].id,
        level: p.weapons[i].level,
        evolved: !!(def && def.evolved)
      });
    }
    const passives = [];
    for (let i = 0; i < p.passives.length; i++) {
      const def = C.PASSIVE_MAP[p.passives[i].id];
      passives.push({
        id: p.passives[i].id,
        name: def ? def.name : p.passives[i].id,
        level: p.passives[i].level
      });
    }

    // 组合技也进 HUD：界面上要显示「我现在有哪几个组合技」。
    // 它跟武器一样是持续输出源，玩家需要随时看到自己的输出构成 ——
    // 只显示武器的话，组合技会变成「看不见的伤害」，玩家不知道自己强在哪。
    const combos = [];
    for (let i = 0; i < (p.combos || []).length; i++) {
      const def = C.COMBO_MAP[p.combos[i].id];
      combos.push({
        id: p.combos[i].id,
        name: def ? def.name : p.combos[i].id,
        level: p.combos[i].level,
        maxLevel: def ? (def.maxLevel || 3) : 3
      });
    }

    // 场上 Boss 快照：给界面顶部的 Boss 血条用。
    // 同时存在多只时取血量最高的那只 —— 玩家真正在打的就是它。
    // 只在 HUD 同步时扫一遍（且调用方已做节流），不影响 20Hz 逻辑循环。
    let boss = null;
    for (let i = 0; i < w.mobs.length; i++) {
      const m = w.mobs[i];
      if (!m.alive || m.def.tier !== 'boss') continue;
      if (!boss || m.hp > boss.hp) {
        boss = {
          // ★剧情关的覆写名优先（「空壳」），否则走名字表（蚩尤/女娲），最后本名
          name: (w.storyStage && m.def.tier === 'boss'
                  ? CP.bossDisplayName(w.modId, w.storyStage) : '') ||
                (w.nameTable && w.nameTable.mob[m.def.id]) || m.def.name,
          hp: Math.max(0, Math.round(m.hp)),
          maxHp: m.maxHp
        };
      }
    }

    const charDef = C.CHAR_MAP[p.charId] || w.charDef || C.CHARACTERS[0];

    return {
      // ---------- 世界级 ----------
      // state 保留旧语义：整局通关报 won，否则报「自己」的进度（playing/levelup/dead）。
      // 联机界面要看别人，直接读 world.players 或各自的 getHud(w, 别人)。
      //
      // ★剧情模式多出第三种结局 'failed'（时间到但没打完首领）。
      //   它不能复用 'dead'（玩家没死）也不能算 'won'（没赢）——
      //   界面据它决定显示「通关 / 未通过 / 阵亡」三种标题。
      state: w.won ? 'won' : (w.ended ? 'failed' : p.state),
      won: w.won,
      // 整局是否已收尾（界面据此在结算前就不再接受操作）
      ended: !!w.ended,
      // 时间到但首领没打完（结算页要说清「差在哪」，而不是只说一句「未通过」）
      timeout: !!w.timeout,
      // 本关要打的首领是否已击败（剧情关的胜负标志）
      bossDefeated: !!w.bossDefeated,
      time: w.time,
      timeLeft: Math.max(0, w.matchSec - w.time),
      wave: w.wave,
      mobCount: w.aliveMobCount,
      boss: boss,

      // 当前关卡区域名。界面把它显示在波次旁边 ——
      // 「第 17 波」是个数字，「血月祭坛」才让玩家知道自己推进到哪了。
      //
      // ★剧情模式的「区域名」是**关卡名**（落霞坳 / 毒泽…），
      //   不是自由模式那四段stage 的名字 —— 剧情一整局就是一个关卡。
      //   而且要走 nameTable：地图 id 与显示名不是一回事（毒泽 / marsh）。
      // ★地图显示名也要走名字表 —— 剧情模式的地图名与数据表本名不是一回事
      //   （血霞回廊 / 焚天阙 vs 血色回廊 / 斜塔回廊）。
      //   【为什么原来没有这个字段】改造前是界面在 startMatch 里直接读
      //   `world.map.name` 赋一次；那等于绕过名字表，剧情模式会显示成西式本名。
      mapName: (w.nameTable && w.nameTable.map[w.map.id]) || w.map.name,
      stageId: w.stageId || '',
      stageName: w.storyStage
        ? (w.storyStage.name || w.stageId || '')
        : C.stageForWave(w.wave).name,

      // ---------- 剧情模式（第十五轮）----------
      // 全部是标量/短字符串，HUD 已节流，直接带上不心疼。
      // 界面据此显示章节条、卷尾结算、「下一关」按钮。
      modId: w.modId,
      campaign: !!w.storyStage,
      stageNo: w.storyStage ? (w.storyStage.no || 0) : 0,
      stageIdOfStage: w.storyStage ? w.storyStage.id : '',
      epigraph: w.storyStage ? (w.storyStage.epigraph || '') : '',
      coda: w.storyStage ? (w.storyStage.coda || '') : '',
      // 本关一共要打多少波（剧情关用来显示「第 N / M 波」；
      // 自由模式是 0，界面据此决定显不显示这个计数）
      stageWaveTotal: w.storyStage && w.storyStage.waves
        ? Math.ceil(w.matchSec / w.storyStage.waves.intervalSec)
        : 0,
      // 本关 Boss 叫什么（结算页要写「你击败了蚩尤」）；
      // 走 nameTable 拿剧情名，不是数据表本名。
      bossName: w.storyStage && w.storyStage.boss
        ? (CP.bossDisplayName(w.modId, w.storyStage) || '')
        : '',

      // 本局难度与时长：界面要显示「当前难度」，倒计时也要按本局实际时长算。
      // 每帧同步（HUD 本身已节流），数据量是几个标量，不值得再开一条通道。
      diffId: w.diff.id,
      diffName: w.diff.name,
      matchSec: w.matchSec,

      // ---------- 个人级 ----------
      slot: p.slot,
      name: p.name,
      // ★剧情模式显示剧情名（刑天/ 祝融 / …），走开局缓存的 nameTable。
      // 自由模式时 nameTable 里的值就是数据表本名，行为与改造前一致。
      charName: (w.nameTable && w.nameTable.char[p.charId]) || charDef.name,
      level: p.level,
      exp: p.exp,
      expNext: p.expNext,
      hp: Math.max(0, Math.round(p.hp)),
      maxHp: p.maxHp,
      alive: p.alive,
      // 阵亡后的复活倒计时（秒）。界面靠它显示「N 秒后复活」，
      // 活着时恒为 0 —— 界面判「要不要显示倒计时」只看它，不看 elapsed 时间差。
      reviveLeft: p.alive ? 0 : Math.max(0, Math.round((p.reviveLeft || 0) * 10) / 10),
      deaths: p.deaths || 0,
      // 战绩取自「这个人」而不是世界：联机结算要显示每个人各自的数字
      kills: p.stats.kills,
      gold: p.stats.gold,
      dmgDealt: Math.round(p.stats.dmgDealt),
      healed: Math.round(p.stats.healed),

      // ---------- 商店（可花余额）----------
      // ★与上面的 gold 严格区分：gold 是「这一局一共赚了多少」（结算用），
      //   shopGold 是「现在还能花多少」。混成一个数字会让玩家看着余额莫名减少。
      shopGold: p.shopGold || 0,
      // 血契石当前层数（界面要显示「已叠 2/3 层」）
      buffStacks: p.shopBuffDmg
        ? Math.round(p.shopBuffDmg / (C.SHOP.items[2] ? C.SHOP.items[2].cost.dmgMul : 0.12))
        : 0,

      // ---------- 角色详细数据（暂停面板显示，见 game.js 的 charDetail）----------
      // 为什么把这些「已在 p.attrs 上算好的乘区」原样给界面：
      // 玩家问的从来是「我现在到底有多少伤害」，而不是「我的mods.dmg 是几」——
      // 要让界面显示的就是**玩家眼中的那个数**。从p.attrs 直读，
      // 界面与战斗永远一致，不会出现「面板说伤害 120、实测打出来 90」。
      // maxHp 换算成「本局累计加上限」：血量上限会被升级一层层抬，
      // 这个玩家自己算不出来，必须给。
      detail: {
        // 有效生命 = 血量上限 + 护甲（护甲是减法，按当前平均承伤折算太主观，
        // 这里只给原值，让玩家自己判断「护甲 6 点值不值这 3 枚金币」）
        maxHp: Math.round(p.maxHp),
        armor: p.attrs ? Math.round(p.attrs.armor * 10) / 10 : 0,
        speed: Math.round(p.attrs ? p.attrs.speed : 0),
        dmgMul: Math.round((p.attrs ? p.attrs.dmgMul : 1) * 1000) / 10,
        cdMul: Math.round((p.attrs ? p.attrs.cdMul : 1) * 1000) / 10,
        rangeMul: Math.round((p.attrs ? p.attrs.rangeMul : 1) * 1000) / 10,
        pickupMul: Math.round((p.attrs ? p.attrs.pickupMul : 1) * 1000) / 10,
        expMul: Math.round((p.attrs ? p.attrs.expMul : 1) * 1000) / 10,
        goldMul: Math.round((p.attrs ? p.attrs.goldMul : 1) * 1000) / 10,
        crit: Math.round((p.attrs ? p.attrs.crit : 0) * 1000) / 10,
        exec: Math.round((p.attrs ? p.attrs.exec : 0) * 1000) / 10,
        regen: Math.round((p.attrs ? p.attrs.regen : 0) * 100) / 100,
        killHeal: Math.round((p.attrs ? p.attrs.killHeal : 0) * 100) / 100,
        thorns: Math.round((p.attrs ? p.attrs.thorns : 0) * 100) / 100
      },

      weapons: weapons,
      passives: passives,
      combos: combos,
      choices: p.choices
    };
  }

  // 取本帧事件。
  //   slot 省略  = 取全部并清空队列（P1 单机的老行为，界面那边不用改）
  //   传了座位号 = 只取「全局事件 + 该玩家本人的事件」，其余留在队列里给别人取。
  //               联机时每条连接各取自己那一份，所以「谁升级了」不会推给所有人。
  function takeEvents(w, slot) {
    if (slot === undefined || slot === null) {
      const e = w.events;
      w.events = [];
      return e;
    }

    const mine = [];
    const rest = [];
    for (let i = 0; i < w.events.length; i++) {
      const e = w.events[i];
      // 没带 slot 的是全局事件（开波、Boss 出现、通关），人人都该收到
      if (e.slot === undefined || e.slot === slot) mine.push(e);
      else rest.push(e);
    }
    w.events = rest;
    return mine;
  }

  return {
    createWorld: createWorld,
    step: step,
    chooseLevelUp: chooseLevelUp,
    getHud: getHud,
    takeEvents: takeEvents,
    // 联机专用：中途加入 / 掉线离开
    addPlayer: addPlayer,
    removePlayer: removePlayer,
    // 联机专用：「自己是谁」的切换。传 null 表示「本端没有自己」——
    // 服务端就是这样用的：它要同时为 8 个人算世界，谁是「自己」取决于当前在给谁打包，
    // 所以一律用 getHud(w, 某玩家) / chooseLevelUp(w, i, 某玩家) 显式指定，不靠 w.self。
    // 客户端接入服务端快照后也会用它来「看别人」（观战）。
    setSelf: setSelf,
    recalcAttrs: recalcAttrs,
    countAliveMobs: countAliveMobs,
    // 伤害入口（导出给测试）。理由：要验证「阵亡 → 复活」这条链路，
    // 得能精确制造一次致死伤害；靠「把玩家扔进怪堆等它被打死」既慢又不稳定，
    // 一旦哪天怪削了伤害，测试就会莫名其妙地不阵亡而失败。
    damagePlayer: damagePlayer,
    // 同理导出给测试：要验「Boss 掉宝箱」，得能一击打死一只 3200 血的领主；
    // 靠真打要跑几十秒且依赖武器配置，测试会变得又慢又脆。
    damageMob: damageMob,
    // 导出给压测脚本用
    _nextRand: nextRand,
    // ★导出造怪接口：测试需要「主动造一只怪」而不是「等它自己刷出来」。
    //   依赖「跑 N 帧后场上还有怪」的断言很脆 —— 多人局火力足，怪常被清光，
    //   于是整块断言被静默跳过（0 FAIL，但覆盖度悄悄掉了，实测踩过）。
    spawnMob: spawnMob,
    // 局内商店（只在单机用，见 shopBuy 的注释）
    shopBuy: shopBuy
  };
});
