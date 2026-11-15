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

  // ============================================================
  // 全局导航流场（第二十五轮 · ③）
  // ============================================================
  // 【为什么不是每只怪跑一次 A*】地图最大 3800×2800，40px 一格是 95×70=6650 格；
  //   同屏几百只怪各算一次寻路，一帧就是百万级操作，服务端 20Hz 直接塌。
  //   rot.js 的 Dijkstra 正好说明了这一点：它是「单目标 → 全图距离场」，
  //   算一次全怪共享，才是这个量级的正确解法（tools/pathfindtest.js 拿它做对照基准）。
  // 【为什么只在卡住时查】下面已有的切向绕行在单个圆形障碍上又快又稳；
  //   全局流场只在「成片障碍 / 夹缝把切向带进死胡同」时接管，
  //   这样绝大多数帧零额外开销，也不改变原有平衡（simtest 的位移断言会守）。
  // 【确定性】纯整数 BFS、不吃随机数、不读 wall-clock；两端同一份代码同一 tick
  //   必然得到同一个流场。字段只挂在 w.nav 上，是模拟层内部状态，
  //   ★不进二进制快照白名单，带宽与协议一个字节都不变。
  const NAV_CELL = 40;
  const NAV_REFRESH = 0.5;                 // 秒；玩家跑得再快，半秒重算一次也够了
  const NAV_DX = [1, 0, -1, 0];
  const NAV_DY = [0, 1, 0, -1];
  const NAV_REV = [2, 3, 0, 1];           // 从邻格指回当前格的方向索引
  const _navVec = { x: 0, y: 0 };         // 复用，别在热路径里 new 对象

  function ensureNavGrid(w) {
    const gw = Math.ceil(w.map.w / NAV_CELL);
    const gh = Math.ceil(w.map.h / NAV_CELL);
    let nav = w.nav;
    if (nav && nav.gw === gw && nav.gh === gh && nav.mapId === w.map.id) return nav;
    // 换图才重建：障碍是静态的，格子是否可走算一次就够
    const size = gw * gh;
    const blocked = new Uint8Array(size);
    const list = w.obstacles || [];
    for (let cy = 0; cy < gh; cy++) {
      for (let cx = 0; cx < gw; cx++) {
        const x = (cx + 0.5) * NAV_CELL;
        const y = (cy + 0.5) * NAV_CELL;
        for (let i = 0; i < list.length; i++) {
          const o = list[i];
          const dx = x - o.x, dy = y - o.y;
          const rr = o.r + 12;            // 12px 保守余量：怪不是质点
          if (dx * dx + dy * dy < rr * rr) { blocked[cy * gw + cx] = 1; break; }
        }
      }
    }
    nav = {
      mapId: w.map.id, gw: gw, gh: gh, blocked: blocked,
      dist: new Int32Array(size), dir: new Int8Array(size), queue: new Int32Array(size),
      at: -1, tx: -1, ty: -1, ready: false, builds: 0
    };
    w.nav = nav;
    return nav;
  }

  function updateNav(w) {
    if (!w.obstacles || !w.obstacles.length) return;
    const players = w.players || [];
    let target = null;
    for (let i = 0; i < players.length; i++) {
      if (players[i].alive) { target = players[i]; break; }
    }
    if (!target) return;
    const nav = ensureNavGrid(w);
    const tx = clamp(Math.floor(target.x / NAV_CELL), 0, nav.gw - 1);
    const ty = clamp(Math.floor(target.y / NAV_CELL), 0, nav.gh - 1);
    // 半个目标格的小移动不重算，跨格或超时才重算
    if (nav.ready && nav.at >= 0 && w.time - nav.at < NAV_REFRESH && nav.tx === tx && nav.ty === ty) return;
    nav.at = w.time;
    nav.tx = tx;
    nav.ty = ty;

    const gw = nav.gw, gh = nav.gh, blocked = nav.blocked;
    const dist = nav.dist, dir = nav.dir, q = nav.queue;
    dist.fill(-1);
    dir.fill(-1);
    let head = 0, tail = 0;
    let start = ty * gw + tx;
    // 玩家贴着障碍时目标格可能被标成不可走：就近找一个可走格当源点
    if (blocked[start]) {
      let best = -1, bestD = Infinity;
      for (let cy = Math.max(0, ty - 3); cy <= Math.min(gh - 1, ty + 3); cy++) {
        for (let cx = Math.max(0, tx - 3); cx <= Math.min(gw - 1, tx + 3); cx++) {
          const k = cy * gw + cx;
          if (blocked[k]) continue;
          const d = (cx - tx) * (cx - tx) + (cy - ty) * (cy - ty);
          if (d < bestD) { bestD = d; best = k; }
        }
      }
      if (best < 0) { nav.ready = false; return; }
      start = best;
    }
    dist[start] = 0;
    q[tail++] = start;
    while (head < tail) {
      const cur = q[head++];
      const cx = cur % gw;
      const cy = (cur - cx) / gw;
      const nd = dist[cur] + 1;
      for (let k = 0; k < 4; k++) {
        const nx = cx + NAV_DX[k], ny = cy + NAV_DY[k];
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const ni = ny * gw + nx;
        if (blocked[ni] || dist[ni] >= 0) continue;
        dist[ni] = nd;
        dir[ni] = NAV_REV[k];       // 从 ni 走回 cur，就是朝玩家的方向
        q[tail++] = ni;
      }
    }
    nav.ready = true;
    nav.builds++;
  }

  // 取「这一步该往哪走」；返回复用对象，调用方只读 x/y。
  function navDirAt(w, x, y) {
    const nav = w.nav;
    if (!nav || !nav.ready) return null;
    const cx = clamp(Math.floor(x / NAV_CELL), 0, nav.gw - 1);
    const cy = clamp(Math.floor(y / NAV_CELL), 0, nav.gh - 1);
    let i = cy * nav.gw + cx;
    // 怪正压在障碍边缘（格子被标 blocked）：先找旁边最近的可走格
    if (nav.dist[i] < 0) {
      let best = -1, bestD = Infinity;
      for (let k = 0; k < 4; k++) {
        const nx = cx + NAV_DX[k], ny = cy + NAV_DY[k];
        if (nx < 0 || ny < 0 || nx >= nav.gw || ny >= nav.gh) continue;
        const ni = ny * nav.gw + nx;
        if (nav.dist[ni] >= 0 && nav.dist[ni] < bestD) { bestD = nav.dist[ni]; best = ni; }
      }
      if (best < 0) return null;
      _navVec.x = (best % nav.gw) - cx;
      _navVec.y = Math.floor(best / nav.gw) - cy;
      return _navVec;
    }
    const k = nav.dir[i];
    if (k < 0) return null;
    _navVec.x = NAV_DX[k];
    _navVec.y = NAV_DY[k];
    return _navVec;
  }

  // 每 0.5 秒量一次「净位移」。
  // ★为什么不用逐帧判：怪贴着墙会**左右摆动** 1~2px，单帧位移不为 0，
  //   逐帧判会把计时不停清零，永远攒不到兜底阈值（实测那只怪摆了 20 秒，stuckSec 只到 0.65）。
  // 贴到玩家身边时清零（那是「到了」，不是撞墙），否则兜底会把正在输出的怪弹走。
  function sampleStuck(w, ent) {
    if (w.tick < (ent.stuckAt || 0)) return;
    const sx0 = ent.stuckX === undefined ? ent.x : ent.stuckX;
    const sy0 = ent.stuckY === undefined ? ent.y : ent.stuckY;
    const ndx = ent.x - sx0;
    const ndy = ent.y - sy0;
    const net = Math.sqrt(ndx * ndx + ndy * ndy);
    ent.stuckX = ent.x;
    ent.stuckY = ent.y;
    ent.stuckAt = w.tick + 10;

    const ps = w.players || [];
    for (let i = 0; i < ps.length; i++) {
      if (!ps[i].alive) continue;
      if (distance(ent.x, ent.y, ps[i].x, ps[i].y) <= ent.r + ps[i].r + 14) {
        ent.stuckSec = 0;
        return;
      }
    }
    if (net > 10) ent.stuckSec = 0;
    else ent.stuckSec = (ent.stuckSec || 0) + 0.5;
  }

  // 兜底：短距「挤出去」。
  // 走到这里说明转向那套（合向量切向 + 正反双向 + 流场）已经用尽 —— 一般是
  // 「针尖缝 / 三圆夹角」。做法是沿「远离障碍」的方向试探 20/32/44/60px，
  // 落到第一个不压障碍的点。这是**唯一**允许「无视碰撞走一步」的地方。
  // 三条约束（缺一不可）：
  //   ① 卡住 ≥1.8 秒才触发（正常贴墙滑行不该被打断）；
  //   ② 离最近玩家 < 260px 不触发（玩家会看到怪在眼前闪现，像瞬移贴脸）；
  //   ③ 冷却 80 tick（4 秒）—— 一次没挤出去就下一轮再来，不会连跳穿整张图。
  // ★不消耗随机数、只用整数 tick —— 双端同一 tick 必然做同样的决定。
  function tryPhaseOut(w, ent) {
    if (w.tick < (ent.phaseAt || 0)) return false;

    // 合向量法线（只在罕见时刻跑，写法直白即可）
    let nx = 0;
    let ny = 0;
    let nearest = Infinity;
    const list = w.obstacles;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const ox = ent.x - o.x;
      const oy = ent.y - o.y;
      const d = Math.sqrt(ox * ox + oy * oy) || 0.001;
      const gap = d - o.r - ent.r;
      if (gap < nearest) nearest = gap;
      if (gap > 34) continue;
      const wgt = 1 / (Math.max(0, gap) + 6);
      nx += (ox / d) * wgt;
      ny += (oy / d) * wgt;
    }
    if (nearest > ent.r + 40) return false;      // 附近根本没墙，不需要兜底

    const nl = Math.sqrt(nx * nx + ny * ny);
    if (nl < 0.0001) return false;
    // ★(nx,ny) 是「障碍中心 → 自身」，也就是**朝外**的方向；
    //   「远离障碍」就是它本身，不是它的反号（第一版写成 -n，把怪往墙里挤，
    //   9 个候选点全被判挡住，兜底等于没做）。
    const outx = nx / nl;
    const outy = ny / nl;
    const tx = -outy;
    const ty = outx;

    let pd = Infinity;
    const ps = w.players || [];
    for (let i = 0; i < ps.length; i++) {
      if (!ps[i].alive) continue;
      const d = distance(ent.x, ent.y, ps[i].x, ps[i].y);
      if (d < pd) pd = d;
    }
    if (pd < 260) return false;

    const dirs = [[outx, outy], [tx, ty], [-tx, -ty]];
    const steps = [20, 32, 44, 60];
    for (let s = 0; s < steps.length; s++) {
      const L = steps[s];
      for (let k = 0; k < dirs.length; k++) {
        const px = clamp(ent.x + dirs[k][0] * L, ent.r, w.map.w - ent.r);
        const py = clamp(ent.y + dirs[k][1] * L, ent.r, w.map.h - ent.r);
        const saveX = ent.x;
        const saveY = ent.y;
        ent.x = px;
        ent.y = py;
        if (!hitsObstacle(w, ent)) {
          ent.stuckSec = 0;
          ent.steerT = 0;
          ent.phaseAt = w.tick + 80;
          // 挤出来之后先按流场绕 1.2 秒，别再直线冲回同一堵墙（见 moveMobToward）
          ent.detourT = 1.2;
          return true;
        }
        ent.x = saveX;
        ent.y = saveY;
      }
    }
    return false;
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

    // ---------- 卡住采样 + 兜底（第三十八轮）----------
    // ★★这两件事必须放在**最前面**。下面有两条 return（绕行惯性分支、单帧在走），
    //   把兜底写在切向分支里的话，一只「左右摆着蹭墙」的怪永远走不到那段代码 ——
    //   实测它就卡在 x=2019~2023 之间摆了 20 秒，兜底一次都没触发（stuckSec 都涨到 14 了）。
    if (autoSteer) {
      sampleStuck(w, ent);
      if (ent.stuckSec >= 1.8) tryPhaseOut(w, ent);
    }

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

    // ---------- 顶住时的切向绕行（第十五轮；第三十八轮修正）----------
    // 【为什么需要】分轴滑动只在「斜着撞墙」时有用。正对着障碍中心走过去时，
    //   **x 轴和 y 轴会被同时判定为「被挡」**，两轴都回退 → 怪原地不动 ——
    //   玩家看到的就是「怪卡在石头上蹭、绕不过来」。
    // 【做法】看实际位移占期望位移多少，低于一半就认为顶住了；
    //   然后沿障碍的**切向**（把「障碍中心 → 自身」转 90°）推一步。
    // ★★更正（第三十八轮）：这里原来写着「圆形障碍是凸的，两两相切不产生凹角，
    //   永远不会形成死胡同」—— **这句话是错的**。单个圆确实是凸的，
    //   但**两个圆之间的缝是凹的**：两根石柱相距 40px 时，中间那条缝就是死胡同
    //   （实测 spire 图有蝙蝠在里面卡了 28 秒，位置一步不动）。
    //   所以现在的做法是：① 法线取「近处所有障碍的合向量」；② 正反两个切向都试；
    //   ③ 卡久了允许暂时背离玩家；④ 仍然出不去就短距「挤」出去（见下）。
    const movedX = ent.x - oldX;
    const movedY = ent.y - oldY;
    const movedLen = Math.sqrt(movedX * movedX + movedY * movedY);

    if (movedLen > wantLen * 0.5) return;   // 这一帧在走（stuckSec 由 sampleStuck 每 0.5 秒采一次）

    const ux = dx / wantLen;
    const uy = dy / wantLen;

    // ---------- 法线用「近处所有障碍的合向量」，而不是只取最近那一个 ----------
    // ★★这是本轮真正的修复：单个圆是凸的，但**两个圆之间的缝是凹的**。
    //   旧版只看最近的那个圆，切向会直接指进另一个圆里 → 每帧都被判「挡住」→
    //   位置一步不动（实测：spire 图两根石柱相距 40px，蝙蝠夹在缝里卡了 28 秒）。
    //   把贴身的几块法线加起来，切向就自动沿着「缝的中轴」滑出去。
    // 障碍只有 20~47 个，这条循环本来就在跑，累加几乎不增加成本。
    const list = w.obstacles;
    let nx = 0;
    let ny = 0;
    let nearest = Infinity;
    let nearOx = 0;
    let nearOy = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      const ox = ent.x - o.x;
      const oy = ent.y - o.y;
      const dist = Math.sqrt(ox * ox + oy * oy) || 0.001;
      const gap = dist - o.r - ent.r;
      if (gap < nearest) { nearest = gap; nearOx = ox; nearOy = oy; }
      if (gap > 34) continue;                 // 只让贴身的参与合向量
      const wgt = 1 / (Math.max(0, gap) + 6);
      nx += (ox / dist) * wgt;
      ny += (oy / dist) * wgt;
    }
    if (nearest > 0 && nearest > ent.r + 30) { ent.stuckSec = 0; return; }  // 最近的还离得远，不是它挡的

    // 合向量退化（正好落在几个圆的对称中心）时退回「最近那个圆」的法线
    if (nx * nx + ny * ny < 0.0001) { nx = nearOx; ny = nearOy; }
    const nl = Math.sqrt(nx * nx + ny * ny);
    if (nl < 0.0001) return;
    let tx = -ny / nl;
    let ty = nx / nl;
    // 先走与前进方向同侧的那一边（不往回绕，看起来不像犹豫）
    if (tx * ux + ty * uy < 0) { tx = -tx; ty = -ty; }

    // ---------- 候选方向依次试：正向切向 → 反向切向 → 流场 → 流场反向 ----------
    // 【为什么要「反向也试」】缝里唯一的出路常常是往回退半步再绕。
    //   旧版只试一个方向，那个方向一旦被挡就原地不动 —— 上面那 28 秒就是这么来的。
    const nd = navDirAt(w, ent.x, ent.y);
    const navOk = !!(nd && (nd.x || nd.y));
    const nvx = navOk ? nd.x : 0;
    const nvy = navOk ? nd.y : 0;
    // 卡得越久越允许「暂时背离玩家」：0.6 秒后不再要求与前进方向同侧
    const allowBack = ent.stuckSec > 0.6;

    let done = false;
    for (let c = 0; c < 4; c++) {
      let cx2 = 0;
      let cy2 = 0;
      if (c === 0) { cx2 = tx; cy2 = ty; }
      else if (c === 1) { cx2 = -tx; cy2 = -ty; }
      else if (c === 2) {
        if (!navOk) continue;
        if (!allowBack && nvx * ux + nvy * uy < -0.35) continue;
        cx2 = nvx; cy2 = nvy;
      } else {
        if (!navOk || !allowBack) continue;
        cx2 = -nvx; cy2 = -nvy;
      }
      ent.x += cx2 * wantLen;
      ent.y += cy2 * wantLen;
      if (!hitsObstacle(w, ent)) {
        // 记住这次的方向，接下来 0.45 秒沿它走 —— 见上面「绕行惯性」的说明
        ent.steerT = 0.45;
        ent.steerDx = cx2;
        ent.steerDy = cy2;
        done = true;
        break;
      }
      // 这一边被挡：退回原位再试下一边（不退回会累积成「斜着穿过障碍」）
      ent.x = oldX;
      ent.y = oldY;
    }
    if (done) return;

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
      // 传送门冷却（第二十八轮）：踩上去瞬移之后短暂失效，
      // 避免落在另一端门口时被立刻传回来变成「来回弹」。
      // ★只在本机世界对象上存在，**不进快照**（FIELDS.players 没这个字段），
      //   客户端也从不用它做任何判断 —— 传送判定永远只有服务端/单机模拟一处。
      portalCd: 0,
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
      stats: { kills: 0, dmgDealt: 0, gold: 0, healed: 0, killsBy: {}, dmgBy: {}, challengers: 0 },
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
      // 山海谱（局外天赋）折算好的加成：{ hp, dmgMul, speedMul, pickupMul, cdMul, gold }。
      // ★这里存的是**数值**不是等级 —— 等级表在 shared/codex.js，
      //   由前端折好再传进来，sim 不需要认识天赋系统（也就不会多一条加载顺序依赖）。
      // ★只有单机/剧情会传；联机时服务端不认客户端天赋（见 game.js 的开局参数）。
      meta: opts.meta || null,
      // 上古神龛的祝福层数（第三十五轮）：{ 神龛 id: 层数 }。
      // ★必须是**每个人一份**：队友跑过去领的是他自己的祝福，不该给全队加。
      //   所以存人身上、不进世界级字段，与 shopBuffDmg 同一套做法。
      shrines: {},
      // ---------- 血怒（第三十八轮：连杀奖励） ----------
      // 【为什么这四个数存在玩家身上而不是世界上】
      //   连杀是「你一个人清得怎么样」，队友的连杀不该给我加伤害。
      //   与 shrines / shopBuffDmg 同一套归属：每个人一份。
      // ★rage 只影响伤害与移速的**临时**乘区，绝不写进 attrs —— 见 damageMob / tickRage。
      rage: 0,            // 血怒剩余秒数（>0 表示正在爆发）
      rageStreak: 0,      // 当前连杀数（0 ~ needKills-1，触发时归零）
      rageGap: 0,         // 距上一次击杀过了多久（秒），超过 windowSec 断链
      rageCd: 0,          // 冷却剩余秒数
      rageCount: 0,       // 本局触发过几次（只用于结算/测试观察，不参与逻辑）
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
    // 山海谱「聚宝」的开局金币：直接给可花余额（shopGold），
    // 不给 stats.gold —— stats.gold 是「这一局赚了多少」的结算口径，
    // 把它当赠送入口会让结算页凭空多出一笔钱，也破坏「金币只能靠打怪赚」的直觉。
    if (player.meta && player.meta.gold > 0) player.shopGold = player.meta.gold;
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
      // ---------- 挑战者（第三十四轮）----------
      // 下一只挑战者的 tick 号。开局给 0 = 「还没排期」，
      // 第一次走到 startSec 时由 maybeSpawnChallenger 排上，之后每次顺延一个间隔。
      challengerNextTick: 0,
      // 本局一共刷过几只（只用于结算/测试观察，不参与任何逻辑）
      challengerSpawned: 0,
      // ---------- 山魈（第四十一轮：召唤型妖物） ----------
      // 下一只山魈的 tick 号。0 = 「还没排期」，第一次走到 startSec 时由
      // maybeSpawnSummoner 排上，之后每次顺延一个间隔。
      summonerNextTick: 0,
      // 本局一共刷过几只（只用于观察与测试，不参与任何逻辑）
      summonerSpawned: 0,
      // ---------- 赤月天象（第三十九轮）----------
      // 当前是否在赤月里（0/1）。存在世界对象上而不是每个玩家身上 ——
      // 它描述的是**这张图的天色**，不是某个人的状态，联机时所有人一起经历。
      moonOn: 0,
      // 本局第几次赤月（-1 = 还没到第一次）。只用于观察与测试。
      moonIdx: -1,
      // 剩余秒数（0 = 不在赤月里）。给 HUD 用，让界面不必自己算时间。
      moonLeft: 0,
      // ---------- 陨星（第四十轮）----------
      // 下一颗陨星的 tick 号。0 = 「还没排期」，第一次走到 startSec 时由
      // maybeSpawnMeteor 排上，之后每次顺延一个间隔。
      meteorNextTick: 0,
      // 本局一共落过几颗（只用于观察与测试，不参与任何逻辑）
      meteorSpawned: 0,
      // 血怒静音计数（第四十轮）：>0 时击杀**不计入连杀**。
      // 目前唯一的用法是「天火砸死的那一坨不算你连杀」——
      // 不静音的话每 95 秒白送一次血怒，那它会从「奖励手快」退化成「等天火」。
      rageMute: 0,
      // ---------- 地脉灵泉（第四十二轮）----------
      // 下一座灵泉的 tick 号。0 = 「还没排期」，第一次走到 startSec 时由
      // maybeSpawnLey 排上，之后每次顺延一个间隔。
      leyNextTick: 0,
      // 本局一共涌出过几座 / 一共被唤醒过几次（只用于观察与测试，不参与任何逻辑）
      leySpawned: 0,
      leyBursts: 0,
      // ---------- 血祭坛（第四十三轮）----------
      // 下一座血祭坛的 tick 号。0 = 「还没排期」，第一次走到 startSec 时由
      // maybeSpawnPact 排上，之后每次顺延一个间隔。
      pactNextTick: 0,
      // 本局一共浮现过几座 / 一共被踩掉过几层（只用于观察与测试，不参与任何逻辑）
      pactSpawned: 0,
      pactTaken: 0,
      // ---------- 双生妖（第四十五轮：同命相连的一对精英） ----------
      // 下一对的排期 tick（0 = 还没排期）
      twinNextTick: 0,
      // 本局一共刷过几对（只用于观察与测试）
      twinSpawned: 0,
      // 配对序号自增（每个 mob 身上记 m.twinPair = 这个号）
      twinSeq: 0,
      // 当前在场的配对记录：{ id, dead, reviveAt, resolved, spawnX, spawnY, maxHp, defId }
      // ★这是**服务端事实**，不进快照：配对规则完全在服务端结算，客户端只需要
      //   知道「这两只是双生妖」（defId 已在快照里），不必知道谁和谁配、还剩几秒。
      twinPairs: [],
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
    // 传送门（第二十八轮）：静态地形的一部分，双端各自用纯函数算，不进快照。
    // ★只在地图开局生成一次；玩家踩上去的判定在 tryPortal 里（movePlayer 的最后一步调用）。
    w.portals = MAPS_MOD.buildPortals ? MAPS_MOD.buildPortals(w.map) : [];

    // 地图宝箱（第二十八轮）：每张图固定点位放 3 个，开出的是「等级 + 一小笔金币」
    // —— 与 Boss 掉的那个宝箱走**同一条**拾取分支（sim 的 it.kind === 'chest'），
    // 所以「开箱给技能三选一」这件事不需要第二套实现。
    // ★寿命传 9999 秒：它是地图物件，不该像掉落物那样 60 秒后自己消失。
    //   这个数字纯属「一局打不到那么久」，不是精确值。
    const chestSpots = MAPS_MOD.buildChests ? MAPS_MOD.buildChests(w.map) : [];
    for (let i = 0; i < chestSpots.length; i++) {
      spawnPickup(w, 'chest', chestSpots[i].x, chestSpots[i].y, 1, 9999);
    }

    // 上古神龛（第三十五轮）：每张图三个，三种祝福各一处。
    // ★剧情关一律不放：主线每一关都是逐关手工配平的（有 Boss、有限时），
    //   凭添三条永久加成会让「打不过」变成「有没有绕过去领祝福」的问题。
    //   这条与挑战者同一条口径，simtest 钉了「剧情关一个神龛都没有」。
    // ★类型在开局算一次就定下来（value 带下去），运行期不再变：
    //   否则联机时「主机以为这是兵主之龛、队友看到的是风伯之龛」，
    //   而两人结论不同又都觉得自己没错 —— 这类不同步最难查。
    const shrineSpots = (!storyStage && MAPS_MOD.buildShrines) ? MAPS_MOD.buildShrines(w.map) : [];
    for (let i = 0; i < shrineSpots.length; i++) {
      spawnPickup(w, 'shrine', shrineSpots[i].x, shrineSpots[i].y,
        shrineTypeAt(w.map, i), C.SHRINE_RULE.life);
    }
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
        slot: one.slot === undefined ? i : one.slot,
        // 山海谱天赋（局外成长）：只由**本端单机/剧情**的开局参数带进来，
        // 联机建世界时服务端不会收到这个字段（详见 game.js 开局的注释）。
        // one.meta 优先，方便以后按座位传不同的加成。
        meta: one.meta || opts.meta
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

    // ---------- 上古神龛的祝福（第三十五轮） ----------
    // 与血契石同一个理由放在这里：这一处汇总完，升级、进化、买 buff、复活
    // 走的都是同一条路，祝福不会因为某条路径忘了重算而消失。
    // ★遍历的是 const.js 的表而不是 p.shrines 的键：表决定了「哪一项加到哪」，
    //   对象里存的是层数。表里没有的 id（老存档 / 手改）一律忽略，不会凭空加属性。
    // ★★位置必须在 `attrs.speed = C.PLAYER.speed * attrs.speedMul` **之前**：
    //   那一行是拿 speedMul 算绝对值，祝福加在它后面只会改乘区、步速一点不动
    //   （第一次写就踩了：断言里 speed 120 → 120，乘区明明已经变了）。
    let shrineHp = 0;
    if (p.shrines) {
      for (let i = 0; i < C.SHRINES.length; i++) {
        const sdef = C.SHRINES[i];
        const n = p.shrines[sdef.id] || 0;
        if (!n) continue;
        if (sdef.dmg) attrs.dmgMul += sdef.dmg * n;
        if (sdef.speed) attrs.speedMul += sdef.speed * n;
        if (sdef.pickup) attrs.pickupMul += sdef.pickup * n;
        // 血量走「绝对值」而不是倍率：+25 写在表里就是 +25，读起来和看到的一致
        if (sdef.hp) shrineHp += sdef.hp * n;
      }
    }

    // ---------- 山海谱（局外天赋，第三十六轮） ----------
    // 与神龛同一个理由汇总在这里：升级 / 进化 / 买 buff / 复活走的都是这一条，
    // 天赋不会因为某条路径忘了重算而消失。
    // ★位置同样必须在下面那行 `attrs.speed = ...` 之前（speedMul 晚了就不生效）。
    let metaHp = 0;
    if (p.meta) {
      if (p.meta.dmgMul) attrs.dmgMul += p.meta.dmgMul;
      if (p.meta.speedMul) attrs.speedMul += p.meta.speedMul;
      if (p.meta.pickupMul) attrs.pickupMul += p.meta.pickupMul;
      if (p.meta.cdMul) attrs.cdMul += p.meta.cdMul;
      if (p.meta.hp) metaHp = p.meta.hp;
      // 冷却下限 0.25 是全局不变式，天赋叠上来也不能破
      if (attrs.cdMul < 0.25) attrs.cdMul = 0.25;
    }

    attrs.speed = C.PLAYER.speed * attrs.speedMul;

    // ---------- 血祭坛（第四十三轮：用生命上限换伤害） ----------
    // 与神龛 / 山海谱同一个理由放在汇总点：升级、进化、买 buff、复活、掉线接回
    // 走的都是 recalcAttrs，契约不会因为某条路径忘了重算而失效（或被重复收一次费）。
    // ★伤害加进 dmgMul（与被动 / 神龛同一个乘区）：不新造一条乘区，
    //   否则「伤害构成」里要多一档，而它其实只是又一次伤害加成。
    // ★代价是**上限打折**，所以它只能落在下面那行 maxHp 上：
    //   写成「扣当前血量」的话，喝一瓶绷带就补回来了 —— 那不是代价，是一次延后结算。
    // ★0.5 的下限纯属防御：以后有人把 stackMax 调到 10，血量也不该变成 0 或负数。
    const pactN = p.pacts || 0;
    if (pactN > 0) attrs.dmgMul += C.BLOODPACT.dmg * pactN;
    const pactScale = pactN > 0
      ? Math.max(0.5, 1 - C.BLOODPACT.hpCostPct * pactN)
      : 1;

    // ---------- 升级加血 ----------
    // 血量上限 = (基础血量 + 等级加成) × 角色/被动倍率。
    // 【为什么先加等级加成、再乘倍率】倍率回答的是「这个角色本身血厚不厚」，
    // 等级加成回答的是「他练了多久」—— 两件独立的事。先加后乘才能让
    // 「血厚的角色练得久」得到正确结果。反过来（倍率也作用于每级成长）会让
    // 圣殿骑士在后期远远甩开其它角色，角色平衡直接失效。
    // 上限 C.PLAYER.hpPerLevelCap 是防「血量流叠到几千血彻底无敌」的兜底。
    // ★神龛的血量上限跟等级加成同一位置（乘倍率之前）：它也是「练出来的绝对值」。
    const lvHp = Math.min((p.level - 1) * C.PLAYER.hpPerLevel, C.PLAYER.hpPerLevelCap);
    attrs.maxHp = Math.round((C.PLAYER.hp + lvHp + shrineHp + metaHp) * attrs.hpMul * pactScale);
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

  function damageMob(w, m, dmg, knockX, knockY, src) {
    if (!m.alive) return 0;

    // 第十一轮新增的两个被动在**结算这一刻**判定（它们不是面板乘区）：
    //   crit 暴击（日轮烙印）  概率翻倍 —— 不稳定，但期望最高
    //   exec 斩杀（死神印记）  对残血怪加伤 —— 对满血怪毫无作用
    //
    // 用 w.player 而不是 w.self：damageMob 之前一定已经 setCtx 到了正确的归属人，
    // 用 self 会在多人局里把 A 的暴击算到 B 身上（而且这种错只在联机复现）。
    const A = w.player ? w.player.attrs : null;
    // ---------- 天火不是「你的攻击」（第四十轮）----------
    // 陨星的伤害对血怒 / 暴击 / 斩杀一律不参与结算。
    // 【为什么必须隔离】不隔离的话，同一个事件在不同 build 下清掉的怪数不一样：
    //   带暴击的玩家砸出 600，不带的砸出 300 —— 而玩家在屏幕上只看到「一次天火」，
    //   于是「陨星到底有多少伤害」这件事就没有答案了。结算里的伤害构成也会
    //   凭空多出一大块不属于任何装备的数字。
    // ★第四十二轮把地脉灵泉也算进这一类：它的数值同样写在表里（leyDmgAt），
    //   打它的人和被打的人的 build 都不该让同一个灵泉一会儿清一片、一会儿清半片。
    //   ★但它**不静音连杀**（见 updateLeys 的说明）：那是玩家站着不动换来的。
    const isWorld = src === 'meteor' || src === 'ley';
    // ---------- 血怒的临时乘区（第三十八轮） ----------
    // ★放在暴击/斩杀**之前**：血怒是「底子变强」，暴击是「这一下翻倍」。
    //   反过来（先翻倍再乘血怒）数学上一样、但意义不同 —— 这里选「血怒先进基数」，
    //   因为下面还要按词缀减伤打折，一条算式顺着「基数 → 倍率 → 减免」读下来最不容易改错。
    // ★读的是 w.player（当前归属人）而不是 w.self：联机时用 self 会把我的血怒算到别人头上。
    if (!isWorld && w.player && w.player.rage > 0) dmg = dmg * C.RAGE.dmgMul;
    if (A && !isWorld) {
      if (A.crit > 0 && nextRand(w) < A.crit) dmg = dmg * 2;
      if (A.exec > 0 && m.hp > 0 && m.maxHp > 0 && m.hp < m.maxHp * 0.25) {
        dmg = dmg * (1 + A.exec);
      }
    }

    // 词缀减伤（坚壁）：挂在**暴击/斩杀之后**。
    // 顺序有讲究：先算清「这一下本来是多少」，再按词缀打折；
    // 反过来（先打折再翻倍）会让减伤对暴击失效 —— 暴击那一下打坚壁怪像打普通怪，
    // 玩家就会得出「暴击能破甲」的错误结论。
    const af = m.affix ? (C.AFFIX_MAP && C.AFFIX_MAP[m.affix]) : null;
    if (af && af.dmgReduce) dmg = dmg * (1 - af.dmgReduce);

    m.hp -= dmg;
    w.stats.dmgDealt += dmg;

    // 伤害构成（第三十六轮）：按来源（武器 id / 'thorns' / 'other'）分别累计。
    // ★必须在「暴击、斩杀、词缀减伤」之后记 —— 玩家看到的是实际打出的数字，
    //   记录原始 dmg 会让结算页的总和对不上「造成伤害」那一格（两处数字打架最难解释）。
    // ★来源为空串时归到 'other'：宁可显示「其它」，也不要出现一行空白条目。
    const key = src || 'other';
    w.stats.dmgBy[key] = (w.stats.dmgBy[key] || 0) + dmg;

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

  // ============================================================
  // 血怒（第三十八轮：连杀奖励）
  // ============================================================
  // 一次击杀 → 记一笔连杀；够数就进入血怒。真正的判定全在下面两个函数里，
  // killMob 只负责喊一声（这样「谁算击杀」这件事只有一处，不用复制条件）。

  // 记录一次击杀。调用点只有 killMob 一处，且那时 w.player 已经是「打出这一下」的归属人。
  function bumpRage(w) {
    const p = w.player;
    if (!p || !p.alive) return;
    const R = C.RAGE;
    // 静音期不计数（第四十轮）：目前只有「天火砸死的那一坨」用它 ——
    // 否则每 95 秒白送一次血怒，血怒就不再是「你打得快」的奖励。
    if (w.rageMute > 0) return;
    // 血怒期间不计数：否则「爆发 8 秒里清掉的那一堆」会直接把下一次也攒满，
    // 变成两次爆发首尾相接 —— 那等于常驻加成，而常驻的东西没人会为它调整走位。
    if (p.rage > 0) return;
    // 冷却期间也不计数（连杀从 0 开始攒，见 tickRage 的说明）
    if (p.rageCd > 0) return;

    p.rageStreak += 1;
    p.rageGap = 0;
    if (p.rageStreak < R.needKills) return;

    // 够数 → 进入血怒。连杀清零，出冷却在结束时才开始算（见 tickRage）。
    p.rage = R.durationSec;
    p.rageStreak = 0;
    p.rageGap = 0;
    p.rageCount = (p.rageCount || 0) + 1;
    // ★带 slot：联机时这条只推给触发者本人。别人收到「你血怒了」会莫名其妙，
    //   而他们的伤害也确实没变（乘区是每人一份的）。
    w.events.push({ type: 'rage', slot: p.slot, name: p.name, sec: R.durationSec });
  }

  // 每帧推进血怒的三条计时（一步一帧，dt 是固定步长）。
  // ★单独一个函数 + 独立循环：不能让「阵亡 / 选升级」的 continue 把它跳过，
  //   否则一个正在选升级的人回来会带着一整套过期的血怒（时长白给）。
  function tickRage(w, p, dt) {
    const R = C.RAGE;

    // 阵亡一律清零（第三十八轮）：联机里倒下 5 秒后会原地复活，
    // 带着半截血怒站起来等于「死一次还白赚几秒爆发」。
    // 连杀也一起清 —— 不然复活后第一只怪就接上死亡前的链条，
    // 玩家看到的是「我明明死过，光环却还在攒」。
    if (!p.alive) {
      p.rage = 0;
      p.rageStreak = 0;
      p.rageGap = 0;
      return;
    }

    if (p.rage > 0) {
      p.rage -= dt;
      if (p.rage > 0) return;
      // 结束：清零 + 进冷却。★冷却在这里才开始算，而不是在触发那一刻 ——
      // 从触发就开始算的话，8 秒爆发的后半段就已经在冷却了，等于没有冷却。
      p.rage = 0;
      p.rageCd = R.cooldownSec;
      return;
    }

    if (p.rageCd > 0) {
      p.rageCd -= dt;
      if (p.rageCd < 0) p.rageCd = 0;
      return;
    }

    // 没在爆发也没在冷却：只有「连杀还挂着」时才需要判断链。
    if (p.rageStreak <= 0) return;
    p.rageGap += dt;
    if (p.rageGap > R.windowSec) {
      p.rageStreak = 0;
      p.rageGap = 0;
    }
  }

  function killMob(w, m) {
    if (!m.alive) return;
    m.alive = false;
    w.stats.kills += 1;
    // 血怒的连杀计数（第三十八轮）。放在这里而不是掉落逻辑里：
    // 「打死一只」是唯一的事实，掉落那些分支会随 tier 走不同路径，漏一条就少算。
    bumpRage(w);

    // 掉落经验球
    const def = m.def;

    // ---------- 图鉴 / 挑战者计数（第三十六轮） ----------
    // 图鉴按**怪种 id** 累计：结算时并进 vs_codex.mobs，图鉴页据此显示「已收录 / 击杀数」。
    // ★用 def.id 而不是显示名：名字会被剧情改名表替换（同一个 id 在不同章节叫法不同），
    //   按名字记会把同一只怪拆成两条图鉴。
    if (def && def.id) {
      w.stats.killsBy[def.id] = (w.stats.killsBy[def.id] || 0) + 1;
      if (def.challenger) w.stats.challengers = (w.stats.challengers || 0) + 1;
    }

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

    // ---------- 挑战者：必掉宝箱（第三十四轮） ----------
    // 【为什么给宝箱而不是再加一堆经验球】宝箱是「要专门走过去拿的一次免费升级」，
    // 也就是说它给的奖励**兑现之前还要再做一个决定**（现在掉头去捡，还是先跑）。
    // 这正是挑战者存在的理由：从「它来找你」到「你去拿它掉的东西」是一段完整的小事件，
    // 而不是「打完 +500 经验」这种一次性数字。
    // ★和 Boss 的宝箱走**同一条**拾取分支（spawnPickup 的 'chest' → 开箱给三选一），
    //   所以这里不需要第二套实现。
    if (def.challenger) {
      const rule = C.CHALLENGER || { chest: 1, goldDrops: 2 };
      for (let i = 0; i < (rule.chest || 0); i++) {
        spawnPickup(w, 'chest', m.x, m.y, 1, C.DROPS.chest.life);
      }
      // 金币按小环撒开：叠在一个点上只会被一次性吸走，看着像「只掉了一枚」
      for (let i = 0; i < (rule.goldDrops || 0); i++) {
        const ang = (Math.PI * 2 / (rule.goldDrops || 1)) * i + 0.4;
        spawnPickup(w, 'gold',
          m.x + Math.cos(ang) * 14, m.y + Math.sin(ang) * 14, C.DROPS.goldValue);
      }
      w.events.push({
        type: 'challenger_down', x: Math.round(m.x), y: Math.round(m.y), name: def.name
      });
    }

    // ---------- 山魈：击杀给一小笔金币（第四十一轮） ----------
    // 【为什么给金币而不是宝箱】宝箱是挑战者的身份标识（「打死它 = 一次免费升级」）——
    //   两种事件精英都给宝箱，玩家就没必要区分它们了。山魈给的是「你花时间追它的补偿」：
    //   金币在局内能直接换补给（绷带 / 血契石），是一份立刻能兑现的回报。
    // ★金币按小环撒开：叠在一个点上只会被一次性吸走，看着像「只掉了一枚」。
    if (def.summoner) {
      const rule = C.SUMMONER || { goldDrops: 3 };
      const n = rule.goldDrops || 0;
      for (let i = 0; i < n; i++) {
        const ang = (Math.PI * 2 / (n || 1)) * i + 0.4;
        spawnPickup(w, 'gold',
          m.x + Math.cos(ang) * 14, m.y + Math.sin(ang) * 14, C.DROPS.goldValue);
      }
      w.events.push({
        type: 'summoner_down', x: Math.round(m.x), y: Math.round(m.y),
        name: (w.nameTable && w.nameTable.mob[def.id]) || def.name
      });
    }

    // ---------- 双生妖：同命结算（第四十五轮） ----------
    // 【为什么挂在 killMob 而不是 damageMob】「死掉」这件事只有 killMob 知道全貌
    //   （damageMob 只负责把血打空）。而「先死的那只」正是同命机制的输入。
    // ★判定用的是 m.twinPair（配对号），不是 defId：复活出来的那只 defId 一样，
    //   但它的链接已断（twinPair=0），不会再次进入这个分支 —— 这就是「只复活一次」。
    if (m.twinPair) onTwinKilled(w, m);

    // 死亡特效，让打击感有反馈
    w.effects.push({ kind: 'death', x: m.x, y: m.y, r: def.r, life: 0.25, maxLife: 0.25, color: def.color });

    // ---------- 词缀「分裂」：死后原地裂成两只 ----------
    // 【三条必须守住的线】
    //   ① 子怪**绝不带词缀** —— 带的话就是「分裂的分裂的分裂…」，一次击杀能刷出
    //      指数级的怪，帧率与难度一起崩。这条由 affix 传 0 + 单测断言钉死。
    //   ② 子怪血量取**父怪当前上限**的比例，而不是 def.hp 的比例：
    //      父怪身上可能已经叠了波次成长与词缀血量，用基础值算会变成「越打越轻松」。
    //   ③ 受 MAX_MOBS 约束 —— 后期同屏已经上千只，分裂是唯一能**凭空加怪**的路径，
    //      不设闸门就会顶破上限（服务端单帧耗时直接爆）。
    const splitAf = m.affix ? (C.AFFIX_MAP && C.AFFIX_MAP[m.affix]) : null;
    if (splitAf && splitAf.splitCount && splitAf.splitHpRatio) {
      const n = splitAf.splitCount;
      for (let i = 0; i < n; i++) {
        if (w.mobs.length >= C.MAX_MOBS) break;
        const ang = (Math.PI * 2 / n) * i + 0.6;
        const cx = clamp(m.x + Math.cos(ang) * 18, 24, w.map.w - 24);
        const cy = clamp(m.y + Math.sin(ang) * 18, 24, w.map.h - 24);
        const childMul = (m.maxHp * splitAf.splitHpRatio) / (def.hp || 1);
        spawnMob(w, m.defId, cx, cy, childMul, 0);
      }
    }
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
        damageMob(w, m, p.attrs.thorns, 0, 0, 'thorns');
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

  // affix：词缀 id（0 / 不传 = 普通怪）。见 const.js 的 AFFIXES。
  // ★第六个参数是**追加**的，老的调用点（测试里手拼怪、宝箱召唤等）不用改。
  //
  // seed（第七个参数，可省）：给了的话就用它当相位，并且**不再从主随机流取数**。
  // 【为什么要这个口子】挑战者是在任意 tick 由事件刷进来的。它如果照常调
  //   nextRand（相位、冲锋冷却），就等于在「波次刷怪的中途」插走了几个随机数 ——
  //   后面每一波的落点都会整体错位。词缀那一轮已经为这个坑付过一次代价
  //   （见上面词缀那段的长注释），所以这里从接口上就把它堵死：
  //   事件类生成必须能「零随机」地造出一只怪。
  function spawnMob(w, mobId, x, y, hpMul, affix, seed) {
    const def = C.MOB_MAP[mobId];
    if (!def) return null;

    // 词缀：只影响「生成时的血量」与后面几处结算，形象还是同一套精灵。
    // ★查不到就当作没有（词缀表被删/改了 id 时不能把怪生成成 NaN 血）
    const af = (affix && C.AFFIX_MAP && C.AFFIX_MAP[affix]) || null;
    const hp = def.hp * hpMul * (af && af.hpMul ? af.hpMul : 1);
    const fixed = (typeof seed === 'number' && isFinite(seed));

    const m = {
      id: w.nextId++,
      defId: def.id,
      def: def,
      x: x, y: y, px: x, py: y,
      hp: hp,
      maxHp: hp,
      r: def.r,
      alive: true,
      vx: 0, vy: 0,
      kx: 0, ky: 0,          // 击退速度
      hitCd: 0,              // 接触伤害冷却
      flash: 0,              // 受击闪白剩余时间
      // fixed 时用固定值：seed 当相位，冷却取 def 的标称值（都是确定性的）
      shootCd: def.shootCd ? (fixed ? def.shootCd : randRange(w, 0.4, def.shootCd)) : 0,
      chargeCd: def.chargeCd ? (fixed ? def.chargeCd : randRange(w, 1.0, def.chargeCd)) : 0,
      charging: 0,
      stun: 0,
      phase: fixed ? seed : nextRand(w) * Math.PI * 2,   // 血蝠摆动等用
      buffMul: 1,
      affix: af ? af.id : 0               // 0 = 普通怪（协议里 0 不发送）
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

  // ============================================================
  // 词缀（变异怪）：抽签与判定
  // ============================================================
  //
  // ★★★这里的抽签**必须不消耗随机流**（nextRand）
  //   刷怪循环里的随机流是按顺序取的：落点角度 → 落点抖动 → 怪种权重 → 相位……
  //   在中间插一次 nextRand，后面每只怪的落点就整体偏移一格。
  //   后果是「只加了个词缀，怪的站位全变了」：既有那些钉地图/走位/分布形状的断言
  //   会莫名其妙变红，而且因果极难看出来（挨了整整一轮才定位到是呼吸帧，就是前车之鉴）。
  //   所以这里用一个便宜的整数散列当伪随机：波次 + 序号 + 怪种 id → 0..1。
  //   它照样是确定性的（同种子同一波结果完全一样），只是与主随机流互不干扰。
  function affixHash(a, b, str) {
    let h = Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663);
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;      // 0..1
  }

  // 给「这一波的第 idx 只、怪种为 mobId 的怪」抽一个词缀 id，没抽中返回 0。
  function rollAffix(wave, idx, mobId, chance) {
    if (!(chance > 0)) return 0;
    if (affixHash(wave, idx, mobId) >= chance) return 0;
    // 种类用同一散列的另一段（换一个 salt），不再消耗主随机流
    const t = affixHash(wave, idx + 7919, mobId);
    const list = C.AFFIXES;
    if (!list || !list.length) return 0;
    return list[Math.floor(t * list.length) % list.length].id;
  }

  // 这一只该不该挂词缀。返回 0 表示普通怪。
  function affixForSpawn(w, mobId) {
    const def = C.MOB_MAP[mobId];
    if (!def) return 0;
    // ★剧情关一律不挂：剧情关的怪量/血量是**逐关手工配平**的（还有限时），
    //   随机词缀会让同一关两把的难度差出一截，「打不过」变成运气问题。
    //   词缀是自由模式的随机调料，别往主线上撒。
    if (w.storyStage) return 0;
    // Boss 与光环单位（指挥）不挂：
    //   · Boss 自带光环与专属行为，再叠词缀就分不清「它强在哪」；
    //   · 指挥的定位是「给周围加速/加血」，它自己变成狂暴怪是另一个角色。
    if (def.tier === 'boss' || def.tier === 'commander' || def.kind === 'buffer') return 0;
    // ★挑战者同样不挂词缀：它本身就是「特意来堵你的一只强敌」，
    //   再叠狂暴/坚壁会让它的强度在一局之内差出一截（打不打得过变成抽签）。
    if (def.challenger) return 0;
    // ★山魈同理不挂：它本身是「会召唤的靶子」，再叠狂暴就是「追不上的靶子」，
    //   而叠坚壁是「追不死的靶子」—— 两种都会把「追还是拖」的选择题变成无解。
    if (def.summoner) return 0;
    // ★双生妖（第四十五轮）同样不挂：它的难度来自「同命窗口」这条规则本身。
    //   叠「坚壁」会让 6 秒内收掉一只变成不可能（直接判你失败），
    //   叠「狂暴」则让它跑得比玩家快、你又必须先磨血 —— 两条都把规则变成运气。
    if (def.twins) return 0;
    const chance = C.affixChance ? C.affixChance(w.wave) : 0;
    if (!(chance > 0)) return 0;
    return rollAffix(w.wave, w.affixIdx || 0, mobId, chance);
  }

  // 某只词缀怪第一次出现时播报一句（每种词缀每局一次，别刷屏）
  function noteAffixSeen(w, affixId) {
    const af = C.AFFIX_MAP && C.AFFIX_MAP[affixId];
    if (!af) return;
    if (!w.affixSeen) w.affixSeen = {};
    if (w.affixSeen[affixId]) return;
    w.affixSeen[affixId] = true;
    w.events.push({
      type: 'affix', affixId: affixId, name: af.name, hint: af.hint || '', wave: w.wave
    });
  }

  // ============================================================
  // 挑战者（第三十四轮：局内精英事件）
  // ============================================================
  //
  // ★★这一整段都**不许碰 nextRand**（和词缀抽签同一条纪律，理由见 spawnMob 的 seed 参数）。
  //   它是在任意 tick 插进来的，不是波次的一部分：一旦从这里取走随机数，
  //   之后所有波次的落点都会整体错位，而那些钉分布/走位的断言会莫名其妙变红。
  //   所以落点角度用散列、相位与冷却用固定值 —— 结果仍可复现，只是与主随机流隔离。

  // 场上还活着几只挑战者。只在走到「该刷了」的那一帧才调它，不做每帧扫描。
  function countAliveChallengers(w) {
    const id = C.CHALLENGER.mobId;
    let n = 0;
    for (let i = 0; i < w.mobs.length; i++) {
      const m = w.mobs[i];
      if (m.alive && m.defId === id) n += 1;
    }
    return n;
  }

  // 挑一个锚点玩家（挑战者围着谁出现）。
  // ★不用 pickSpawnAnchor：那个函数在多人局里会 nextRand 抽一个人。
  //   这里用散列取模，多人时同样是「轮流围着不同的人」，但不消耗随机流。
  // salt：散列用的盐。后者（第四十五轮的双生妖）复用同一套锚点规则，
  //   只是换一个盐，好让两件事在同一个 tick 里也选不到同一个人。
  function pickChallengerAnchor(w, salt) {
    const key = salt || 'challenger';
    const alive = [];
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].alive) alive.push(w.players[i]);
    }
    if (!alive.length) return null;
    if (alive.length === 1) return alive[0];
    const k = Math.floor(affixHash(w.tick, 31, key) * alive.length) % alive.length;
    return alive[k];
  }

  // 造一只挑战者。返回那只怪（额度不够 / 定义缺失时返回 null）。
  function spawnChallenger(w) {
    const rule = C.CHALLENGER;
    const def = C.MOB_MAP[rule.mobId];
    if (!def) return null;

    // 同屏硬上限同样要守：挑战者不是一个可以「超发」的实体类别，
    // 后期同屏上千只怪时再多塞一只就会顶破 MAX_MOBS（服务端单帧耗时直接爆）。
    if (w.mobs.length >= C.MAX_MOBS - 2) return null;

    const anchor = pickChallengerAnchor(w);
    const ax = anchor ? anchor.x : w.map.w / 2;
    const ay = anchor ? anchor.y : w.map.h / 2;

    // 落点：常规刷怪环外一点。角度与距离都用散列定，不用 nextRand。
    const ang = affixHash(w.tick, 17, 'challenger') * Math.PI * 2;
    const radius = w.spawnRadius + rule.spawnPad;
    const pad = 40;
    let x = 0;
    let y = 0;
    // 撞障碍就按 1/6 圈转着试（纯确定性），全都撞就直接用这个点 ——
    // 碰撞层会把它推出来，不会卡死（和 ringSpawnPos 同一套兜底思路）。
    for (let k = 0; k < 6; k++) {
      const a = ang + k * (Math.PI / 3);
      x = ax + Math.cos(a) * radius;
      y = ay + Math.sin(a) * radius;
      if (x < pad) x = pad;
      if (x > w.map.w - pad) x = w.map.w - pad;
      if (y < pad) y = pad;
      if (y > w.map.h - pad) y = w.map.h - pad;
      if (!pointBlocked(w, x, y, def.r + 4)) break;
    }

    // 血量跟着波次成长（与同期的普通怪用同一条曲线），否则后期它就是个纸糊的箱子。
    // 剧情关不会走到这里（见 maybeSpawnChallenger 的第一道闸），所以不用考虑 campaign 的曲线。
    const hpMul = C.waveHpMul(w.wave) * w.diff.hpMul;
    // ★第七参传相位：这次生成零随机（理由见 spawnMob 的 seed 说明）
    const m = spawnMob(w, rule.mobId, x, y, hpMul, 0, 1.7);
    if (!m) return null;

    w.challengerSpawned = (w.challengerSpawned || 0) + 1;
    w.events.push({
      type: 'challenger', name: def.name,
      x: Math.round(x), y: Math.round(y), hp: Math.round(m.maxHp)
    });
    return m;
  }

  // 每帧调一次（放在波次生成之后）。三道闸：剧情关 / 时间未到 / 场上已有。
  function maybeSpawnChallenger(w) {
    const rule = C.CHALLENGER;
    if (!rule || !rule.mobId) return;

    // ① 主线《补天纪》一律不刷：剧情关是逐关手工配平的（有 boss、有限时），
    //    随机强敌会让「打不过」变成运气问题。
    if (w.storyStage) return;

    // ② 还没到第一次出现的时刻（比较 tick 而不是 time，避免浮点比较）
    if (w.tick < Math.round(rule.startSec * C.TICK_HZ)) return;

    // ③ 还没到下一只的时点
    if (w.tick < w.challengerNextTick) return;

    // ④ 场上已经有活着的：把下一次往后顺延一个间隔，等它被解决。
    //    【为什么顺延而不是原地等待】原地等的话，玩家一打死它下一帧就立刻来新的，
    //    节奏变成「打完立刻接一只」，那就不是插曲了。
    if (countAliveChallengers(w) >= rule.maxAlive) {
      w.challengerNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
      return;
    }

    const m = spawnChallenger(w);
    // 生成失败（额度满）也照样顺延，不然每帧都会重试到满额为止。
    w.challengerNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
    return m;
  }

  // ============================================================
  // 山魈（第四十一轮：召唤型妖物）
  // ============================================================
  //
  // 【它是什么】唯一一只**不贴脸**的精英：绕着玩家转、始终吊在两百多像素外，
  //   每隔 5.5 秒把身边的妖群召出来，一生最多召 8 只。详见 const.js 的 SUMMONER 段。
  //
  // ★★与挑战者同一条纪律：整段**不许碰 nextRand**。
  //   它在任意 tick 插进来，一旦取走随机数，之后每一波的落点都会整体错位。
  //   落点角度、召唤相位全部用 affixHash 算 —— 可复现，但与主随机流隔离。
  //
  // 【为什么要单独一个 tickSummoner，而不是塞进 updateMobs 的 if 里】
  //   updateMobs 那一大段是「移动」的地盘，召唤是「生成」的事；
  //   混在一起以后想调节奏就得翻移动代码，而且它还要守 MAX_MOBS 与额度两道闸。
  //   单独一个函数，测试也能绕开整局直接造一只山魈来验。

  // 场上还活着几只山魈。只在走到「该刷了」的那一帧才调它，不做每帧扫描。
  function countAliveSummoners(w) {
    const id = C.SUMMONER.mobId;
    let n = 0;
    for (let i = 0; i < w.mobs.length; i++) {
      const m = w.mobs[i];
      if (m.alive && m.defId === id) n += 1;
    }
    return n;
  }

  // 挑一个锚点玩家（山魈围着谁出现）。
  // 与挑战者同口径：用散列取模，多人时轮流围着不同的人，但不消耗随机流。
  function pickSummonerAnchor(w) {
    const alive = [];
    for (let i = 0; i < w.players.length; i++) {
      if (w.players[i].alive) alive.push(w.players[i]);
    }
    if (!alive.length) return null;
    if (alive.length === 1) return alive[0];
    const k = Math.floor(affixHash(w.tick, 53, 'shanxiao') * alive.length) % alive.length;
    return alive[k];
  }

  // 造一只山魈（返回那只怪；额度不够 / 定义缺失时返回 null）
  function spawnSummoner(w) {
    const rule = C.SUMMONER;
    const def = C.MOB_MAP[rule.mobId];
    if (!def) return null;

    // 同屏硬上限：山魈本身是「加怪」的实体，别在后期上千只的时候再挤进去一只
    if (w.mobs.length >= C.MAX_MOBS - 2) return null;

    const anchor = pickSummonerAnchor(w);
    const ax = anchor ? anchor.x : w.map.w / 2;
    const ay = anchor ? anchor.y : w.map.h / 2;

    const ang = affixHash(w.tick, 23, 'shanxiao') * Math.PI * 2;
    const radius = w.spawnRadius + rule.spawnPad;
    const pad = 40;
    let x = 0;
    let y = 0;
    // 撞障碍就按 1/6 圈转着试（纯确定性），与挑战者同一套兜底
    for (let k = 0; k < 6; k++) {
      const a = ang + k * (Math.PI / 3);
      x = ax + Math.cos(a) * radius;
      y = ay + Math.sin(a) * radius;
      if (x < pad) x = pad;
      if (x > w.map.w - pad) x = w.map.w - pad;
      if (y < pad) y = pad;
      if (y > w.map.h - pad) y = w.map.h - pad;
      if (!pointBlocked(w, x, y, def.r + 4)) break;
    }

    // 血量走与同期普通怪同一条曲线；剧情关走不到这里（见 maybeSpawnSummoner 第一道闸）
    const hpMul = C.waveHpMul(w.wave) * w.diff.hpMul;
    // ★第七参传相位：这次生成零随机（理由同上）
    const m = spawnMob(w, rule.mobId, x, y, hpMul, 0, 2.3);
    if (!m) return null;

    // 召唤计时与额度挂在怪身上（而不是世界上）：
    // 联机时世界里的字段会被所有人共享，而「这一只召了几只」是它自己的事。
    m.summoned = 0;
    m.summonCd = rule.summonEverySec;

    w.summonerSpawned = (w.summonerSpawned || 0) + 1;
    w.events.push({
      type: 'summoner', name: (w.nameTable && w.nameTable.mob[def.id]) || def.name,
      x: Math.round(x), y: Math.round(y), hp: Math.round(m.maxHp)
    });
    return m;
  }

  // 每帧调一次（放在挑战者之后）。四道闸：剧情关 / 时间未到 / 未到下一次 / 场上已有。
  function maybeSpawnSummoner(w) {
    const rule = C.SUMMONER;
    if (!rule || !rule.mobId) return;

    // ① 主线《补天纪》一律不刷（与挑战者 / 神龛 / 赤月 / 陨星同一条总纪律）
    if (w.storyStage) return;

    // ② 还没到第一次出现的时刻（比较 tick 而不是 time，避免浮点比较）
    if (w.tick < Math.round(rule.startSec * C.TICK_HZ)) return;

    // ③ 还没到下一只的时点
    if (w.tick < w.summonerNextTick) return;

    // ④ 场上已经有活着的：把下一次往后顺延一个间隔，等它被解决
    if (countAliveSummoners(w) >= rule.maxAlive) {
      w.summonerNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
      return;
    }

    const m = spawnSummoner(w);
    // 生成失败（额度满）也照样顺延，不然每帧都会重试到满额为止
    w.summonerNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
    return m;
  }

  // 山魈自己的召唤计时（由 updateMobs 在它那一支里调）。
  // 【为什么被定住时不召唤】陨星落地会把圈内的怪定身 0.6 秒 ——
  //   那一下如果照常召唤，玩家会觉得「砸它没用」。定身就是定身，连嘴也一起定住。
  function tickSummoner(w, m, dt) {
    const rule = C.SUMMONER;
    if (!rule) return;
    if (!m.alive) return;
    if (m.stun > 0) return;
    // 额度用完就彻底安静：它退回一只普通的精英怪，不再表现出任何召唤行为
    if ((m.summoned || 0) >= rule.summonCap) return;

    m.summonCd = (m.summonCd === undefined ? rule.summonEverySec : m.summonCd) - dt;
    if (m.summonCd > 0) return;
    m.summonCd = rule.summonEverySec;

    // 血量倍率与它自己同一条曲线（召出来的不是「新手怪」，也不是「下一波的怪」）
    const hpMul = C.waveHpMul(w.wave) * w.diff.hpMul;
    let made = 0;
    for (let i = 0; i < rule.summonCount; i++) {
      // ★两道闸缺一不可：额度（它自己的一生上限）与全局实体上限（服务端单帧耗时）
      if ((m.summoned || 0) >= rule.summonCap) break;
      if (w.mobs.length >= C.MAX_MOBS) break;

      // 角度与半径都用散列定（零随机）：同一只山魈每次召出来的站位是固定的
      const seq = m.summoned || 0;
      const ang = affixHash(m.id, seq + 3, 'summon') * Math.PI * 2;
      const rr = rule.summonRing * (0.7 + 0.3 * affixHash(m.id, seq + 11, 'summon'));
      const cx = clamp(m.x + Math.cos(ang) * rr, 24, w.map.w - 24);
      const cy = clamp(m.y + Math.sin(ang) * rr, 24, w.map.h - 24);
      // ★词缀传 0：召出来的小怪绝不带词缀（否则就是「分裂的分裂」那类指数增长）
      const child = spawnMob(w, rule.summonMob, cx, cy, hpMul, 0,
        affixHash(m.id, seq, 'phase') * Math.PI * 2);
      if (child) {
        m.summoned = seq + 1;
        made += 1;
      }
    }

    // 召唤成功给一次视觉反馈（复用现成的 boom 特效，不新增 kind ——
    // 新增 kind 要进串池、要在渲染层加分支，为一次脉冲不值得）。
    // ★**刻意不推事件**：每 5.5 秒一条提示条会把真正重要的播报淹掉，
    //   这只怪的存在感靠标记环 + 脚下的爆发就够。
    if (made > 0) {
      w.effects.push({
        kind: 'boom', x: m.x, y: m.y, r: m.r * 2.2,
        life: 0.32, maxLife: 0.32, color: '#c9553a'
      });
    }
  }

  // ============================================================
  // 双生妖（第四十五轮：同命相连的一对精英）
  // ============================================================
  //
  // 【它是什么】一次来两只。打死其中一只，另一只必须在 6 秒内也倒下；
  //   否则先死的那只会原地站起来（按它自己的上限回 60% 血），链接从此断开。
  //   两只都在窗口内倒下 → 掉宝箱 + 金币。详见 const.js 的 TWINS 段。
  //
  // 【为什么是「打死一只才开始计时」，而不是「出生就开始」】
  //   出生就开始的话，这个机制会退化成「限时挑战」（赤月、剧情关限时都是这个东西），
  //   玩家面对的仍然是「尽快输出」。挂在「第一只倒下」这一刻，计时器才绑在**你的动作**上：
  //   是你开的这个 6 秒，也是你决定「现在要不要收掉它」。
  //
  // 【为什么记录放在 w.twinPairs 而不是挂在 mob 上】
  //   死的那个 mob 下一帧就会被 compactMobs 从数组里摘掉（见 step 第 8 步），
  //   复活要用的坐标/上限/defId 必须存在别处。而「谁和谁是一对」靠 m.twinPair 的配对号索引。
  //   ★复活走 spawnMob 重新造一只，**不是**把死的那只救活 —— 因为死的那只已经不在了。
  //     新造的那只 m.twinPair = 0（链接断开），这是「只复活一次」的唯一实现方式。
  //
  // ★★与挑战者 / 山魈 / 陨星同一条铁律：整段**不许碰 nextRand**。
  //   它在任意 tick 插进来，一旦取走随机数，后面每一波的落点都会整体错位。
  //   落点角度、两只的相位全部走 affixHash 散列。

  // 场上还活着几只双生妖（含已经被打断链接的那只）。
  // 只在「该刷了」的那一帧才调，不做每帧扫描 —— 和挑战者/山魈同一条省法。
  function countAliveTwins(w) {
    const id = C.TWINS.mobId;
    let n = 0;
    for (let i = 0; i < w.mobs.length; i++) {
      const m = w.mobs[i];
      if (m.alive && m.defId === id) n += 1;
    }
    return n;
  }

  // 造一对。返回造出来的数组（不足两只则作废并返回 null）。
  function spawnTwins(w) {
    const rule = C.TWINS;
    const def = C.MOB_MAP[rule.mobId];
    if (!def) return null;

    // 两只一起进场，必须能同时放下 —— 只放得下一只时宁可这一轮不刷，
    // 因为「只有一只的双生妖」既不成立（它没有同伴可同命）还会白占同屏闸。
    if (w.mobs.length >= C.MAX_MOBS - 2) return null;

    const anchor = pickChallengerAnchor(w, 'twins');
    const ax = anchor ? anchor.x : w.map.w / 2;
    const ay = anchor ? anchor.y : w.map.h / 2;

    // 基准方向与距离：散列定，不用 nextRand
    const ang = affixHash(w.tick, 47, 'twins') * Math.PI * 2;
    const radius = w.spawnRadius + rule.spawnPad;
    const hpMul = C.waveHpMul(w.wave) * w.diff.hpMul;
    const pad = 40;

    const pairId = (w.twinSeq || 0) + 1;
    w.twinSeq = pairId;

    const made = [];
    for (let k = 0; k < rule.count; k++) {
      // 两只以基准方向为轴对称张开：进场时是两个方向来的，追到玩家身边又汇到一处
      const base = ang + (k === 0 ? -rule.spread : rule.spread);
      let x = 0;
      let y = 0;
      // 撞障碍就按 1/6 圈转着试（纯确定性），全撞就直接用这个点（碰撞层会推出来）
      for (let t = 0; t < 6; t++) {
        const a = base + t * (Math.PI / 3);
        x = ax + Math.cos(a) * radius;
        y = ay + Math.sin(a) * radius;
        if (x < pad) x = pad;
        if (x > w.map.w - pad) x = w.map.w - pad;
        if (y < pad) y = pad;
        if (y > w.map.h - pad) y = w.map.h - pad;
        if (!pointBlocked(w, x, y, def.r + 4)) break;
      }
      // ★第七参传相位：这次生成零随机（理由见 spawnMob 的 seed 说明）
      const m = spawnMob(w, rule.mobId, x, y, hpMul, 0, 2.3 + k * 0.7);
      if (!m) continue;
      m.twinPair = pairId;
      made.push(m);
    }

    // 只造出一只 → 整对作废：把它原地抹掉（不走 killMob —— 那不是玩家打死的，
    // 不该给经验、不该计连杀、也不该进图鉴）。
    if (made.length < 2) {
      for (let i = 0; i < made.length; i++) {
        made[i].alive = false;
        made[i].twinPair = 0;
      }
      return null;
    }

    w.twinPairs.push({
      id: pairId,
      dead: 0,
      // 0 = 没有在跑的倒计时
      reviveAt: 0,
      // 已经结算完（全灭 or 已经复活过一次）。结算完的配对不再接受任何动作。
      resolved: false,
      spawnX: 0, spawnY: 0, maxHp: 0, defId: rule.mobId
    });

    w.twinSpawned = (w.twinSpawned || 0) + 1;
    w.events.push({
      type: 'twins', name: def.name,
      x: Math.round(made[0].x), y: Math.round(made[0].y),
      hp: Math.round(made[0].maxHp), delaySec: rule.delaySec
    });
    return made;
  }

  // 每帧调一次（放在挑战者/山魈之后）。四道闸：剧情关 / 时间未到 / 场上已有 / 排期。
  function maybeSpawnTwins(w) {
    const rule = C.TWINS;
    if (!rule || !rule.mobId) return;

    // ① 主线《补天纪》一律不刷：剧情关逐关手工配平，还有限时，
    //    随机塞一对「必须先磨血」的精英会让「打不过」变成运气问题。
    if (w.storyStage) return;

    // ② 还没到首次时点
    if (w.tick < Math.round(rule.startSec * C.TICK_HZ)) return;

    // ③ 还没到下一对的时点
    if (w.tick < w.twinNextTick) return;

    // ④ 场上已经有活着的：下一对往后顺延一个间隔，等这一对先被解决。
    //    顺延而不是原地等 —— 否则玩家刚打完，下一帧新的一对就站在脸上。
    if (countAliveTwins(w) >= rule.maxAlive) {
      w.twinNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
      return;
    }

    const made = spawnTwins(w);
    // 生成失败（实体额度满）也照样顺延，不然每帧都会重试到满额为止
    w.twinNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
    return made;
  }

  // 双生妖被打死时调（由 killMob 转进来）。
  // 【三个分支，顺序不能乱】
  //   ① 找不到配对 / 已结算 → 什么都不做（复活出来的那只走这里：链接已断）
  //   ② 两只都倒了 → 撤掉倒计时 + 发奖励（**必须先撤倒计时**，否则同帧内
  //      第一只排下的 timer 会在 6 秒后把「已经全灭的一对」又叫起来一只）
  //   ③ 只倒了一只 → 排下 6 秒倒计时，并把复活要用的坐标/上限记在配对上
  function onTwinKilled(w, m) {
    const pairs = w.twinPairs || [];
    let pair = null;
    for (let i = 0; i < pairs.length; i++) {
      if (pairs[i].id === m.twinPair) { pair = pairs[i]; break; }
    }
    if (!pair || pair.resolved) return;

    const rule = C.TWINS;
    pair.dead = (pair.dead || 0) + 1;

    if (pair.dead >= rule.count) {
      // ② 同命达成：撤掉倒计时，别再叫起来
      pair.resolved = true;
      pair.reviveAt = 0;

      for (let i = 0; i < (rule.chest || 0); i++) {
        spawnPickup(w, 'chest', m.x, m.y, 1, C.DROPS.chest.life);
      }
      // 金币按小环撒开：叠在一点只会被一次性吸走，看着像「只掉了一枚」
      const gn = rule.goldDrops || 0;
      for (let i = 0; i < gn; i++) {
        const a = (Math.PI * 2 / (gn || 1)) * i + 0.4;
        spawnPickup(w, 'gold',
          m.x + Math.cos(a) * 14, m.y + Math.sin(a) * 14, C.DROPS.goldValue);
      }
      w.events.push({
        type: 'twin_slain', x: Math.round(m.x), y: Math.round(m.y),
        name: (w.nameTable && w.nameTable.mob[m.defId]) || (m.def && m.def.name) || '双生妖',
        gold: gn
      });
      return;
    }

    // ③ 只倒了一只：排倒计时
    pair.reviveAt = w.tick + Math.round(rule.delaySec * C.TICK_HZ);
    pair.spawnX = m.x;
    pair.spawnY = m.y;
    pair.maxHp = m.maxHp;
    pair.defId = m.defId;
    w.events.push({
      type: 'twin_half', x: Math.round(m.x), y: Math.round(m.y),
      delaySec: rule.delaySec, left: rule.count - pair.dead
    });
  }

  // 同命倒计时推进（每帧一次，放在清理死怪之前）。
  // 【为什么到点要重新 spawnMob 而不是把尸体救活】尸体在 step 第 8 步就被压掉了。
  // 【为什么复活的那只 m.twinPair = 0】那是「只复活一次」的唯一实现：
  //   链接一断，它再死就只是打死一只普通精英。不这样做，一对双生妖就是一局无限复活。
  function updateTwins(w) {
    const pairs = w.twinPairs;
    if (!pairs || !pairs.length) return;
    const rule = C.TWINS;

    for (let i = pairs.length - 1; i >= 0; i--) {
      const pair = pairs[i];

      if (!pair.resolved && pair.reviveAt > 0 && w.tick >= pair.reviveAt) {
        // ★实体上限：复活也是「凭空加一只」，必须守同一条闸。
        //   这一支**不是死代码** —— 后期满屏时它恰恰是最常走的一条：
        //   怪都堆到上限了，先死的那只就只好等一个空位（每 2 秒问一次）。
        //   ★不能顺延整个间隔：那会让「它明明该站起来」变成「永远不站起来」。
        if (w.mobs.length >= C.MAX_MOBS) {
          pair.reviveAt = w.tick + Math.round(2 * C.TICK_HZ);
          continue;
        }
        const def = C.MOB_MAP[pair.defId] || C.MOB_MAP[rule.mobId];
        // 还原被打死那只的**生命上限**：spawnMob 的 hpMul 是相对 def.hp 的倍率，
        // 而它身上可能已经叠了波次成长与难度倍率 —— 用 pair.maxHp 反推才等价。
        const hpMul = def.hp > 0 ? (pair.maxHp / def.hp) : 1;
        const m = spawnMob(w, pair.defId, pair.spawnX, pair.spawnY, hpMul, 0, 3.1);
        if (m) {
          m.hp = Math.max(1, Math.round(m.maxHp * rule.reviveHpPct));
          // ★链接断开：这只再死不会触发第二次复活
          m.twinPair = 0;
          pair.resolved = true;
          pair.reviveAt = 0;
          w.effects.push({
            kind: 'boom', x: m.x, y: m.y, r: m.r * 2.4,
            life: 0.36, maxLife: 0.36, color: '#8fb6c8'
          });
          w.events.push({
            type: 'twin_revive', x: Math.round(m.x), y: Math.round(m.y),
            name: (w.nameTable && w.nameTable.mob[m.defId]) || def.name
          });
        } else {
          // 实体额度满了：短等 2 秒再试（与陨星落空同一条兜底口径），
          // 绝不顺延整个间隔 —— 那会让「它明明该站起来」变成「永远不站起来」。
          pair.reviveAt = w.tick + Math.round(2 * C.TICK_HZ);
        }
      }

      // 已结算且没有待办 → 摘掉，别让这个数组一局攒下几十条
      if (pair.resolved && pair.reviveAt <= 0) pairs.splice(i, 1);
    }
  }

  // ============================================================
  // 赤月天象（第三十九轮：局内全局事件）
  // ============================================================
  //
  // 【它是什么】每隔 100 秒，整张图进入 22 秒「赤月」：妖物移速 ×1.20、
  //   每波数量 ×1.3，但经验球价值 ×1.3。详见 const.js 的 BLOOD_MOON 段。
  //
  // 【★★为什么整段不碰 nextRand】
  //   与挑战者同一条纪律：它在任意 tick 切换状态，不属于「这一波」的一部分。
  //   一旦从这里抽随机数，之后所有波次的落点都会整体错位一格，
  //   而那些钉「同种子逐只位置一致」的断言会莫名其妙变红。
  //   排期完全由 tick 算（C.moonPhaseAt），零随机。
  //
  // 【为什么状态用「边沿」推事件，而不是每帧推】
  //   每帧推的话，20Hz × 22 秒 = 440 条事件，界面会连播 440 次提示条。
  //   这里只在 on/off 翻转的那一帧推一条。
  function tickMoon(w) {
    const rule = C.BLOOD_MOON;
    if (!rule) return;

    // ① 主线《补天纪》一律没有赤月。
    //    剧情关是逐关手工配平的（有 boss、有限时、还有剧情节拍），
    //    半路突然把全图怪的移速抬两成，会让「打不过」变成运气问题。
    //    ★这一条也是「剧情模式不引入随机压力」这条总纪律的一部分
    //      （挑战者、神龛都遵守同一条）。
    const ph = w.storyStage
      ? { on: false, index: -1, leftSec: 0 }
      : C.moonPhaseAt(w.tick);

    w.moonLeft = ph.leftSec;
    const on = ph.on ? 1 : 0;
    if (on === w.moonOn) return;   // 没有翻转就不推事件

    w.moonOn = on;
    if (on) w.moonIdx = ph.index;
    w.events.push({
      type: 'moon',
      on: on,
      // 结束事件不需要剩余时长；开始事件带上它，界面提示条才能说「约 N 秒」
      left: Math.round(ph.leftSec),
      // 名字从表里取，不写死 —— 以后改名（比如「妖月」）只改一处
      name: rule.name
    });
  }

  // ============================================================
  // 陨星（第四十轮：局内小事件）
  // ============================================================
  //
  // 【它是什么】每 95 秒从天而降一颗，落在「玩家附近**妖物最密**的那一格」：
  //   预警 1.8 秒 → 落地砸伤圈内妖物（并按血量上限 12% 伤玩家，但不致死）→
  //   原地留下 5 秒「星火」，只烧妖物。详见 const.js 的 METEOR 段。
  //
  // 【★★这一整段同样不碰 nextRand】
  //   与挑战者 / 赤月同一条纪律：它在任意 tick 触发，不属于「这一波」的一部分。
  //   落点完全由当前怪物位置算出来（纯确定性），因此**落点不需要同步**——
  //   服务端算一次，客户端只负责按快照里的那条 strike 画预警与火球。
  //
  // 【为什么落点用「网格 + 质心」而不是「取最近的一只怪」】
  //   最近的那只往往只是散兵；玩家真正在打的那一坨有十几只挤在一起。
  //   网格（110px）把「一坨」量化成一个数，再取该格内所有怪的质心 ——
  //   于是落点会落在怪堆**中间**，而不是堆边上那只最靠前的。
  function pickMeteorPoint(w) {
    const rule = C.METEOR;
    const players = w.players;
    const mobs = w.mobs;
    const cell = rule.cellSize;
    const r2 = rule.searchRadius * rule.searchRadius;

    // 格子累计表：键是「格坐标压成一个整数」，值是 {n, sx, sy}。
    // ★用整数键而不是 "cx,cy" 字符串：每颗陨星都要扫几百只怪，字符串拼接是白给的开销。
    const cells = Object.create(null);
    let best = null;
    let total = 0;

    for (let i = 0; i < mobs.length; i++) {
      const m = mobs[i];
      if (!m.alive) continue;

      // 只统计「离某个活着的玩家足够近」的怪：远处的怪砸了也没人看得见
      let near = false;
      for (let k = 0; k < players.length; k++) {
        const p = players[k];
        if (!p.alive) continue;
        const dx = m.x - p.x;
        const dy = m.y - p.y;
        if (dx * dx + dy * dy <= r2) { near = true; break; }
      }
      if (!near) continue;
      total += 1;

      // +1000 偏移只是让负坐标也能压成唯一整数（地图坐标本来非负，纯防御）
      const key = (Math.floor(m.y / cell) + 1000) * 100000 + (Math.floor(m.x / cell) + 1000);
      let c = cells[key];
      if (!c) { c = { n: 0, sx: 0, sy: 0 }; cells[key] = c; }
      c.n += 1;
      c.sx += m.x;
      c.sy += m.y;

      // 取最密的一格。★同密度时按格子序号比大小（确定性）：否则「谁先被遍历到」
      //   会决定落点，不同端算出来的位置就可能不一样（这类不同步最难查）。
      if (!best || c.n > best.n || (c.n === best.n && key < best.key)) {
        best = { n: c.n, sx: c.sx, sy: c.sy, key: key };
      }
    }

    // 太散 / 太少 → 这颗不落。砸空地既没画面也没意义。
    if (!best || total < rule.minMobs) return null;

    let x = best.sx / best.n;
    let y = best.sy / best.n;
    const pad = 40;

    // ① 撞障碍就往玩家方向挪几步：陨星落进石头里，星火就白铺了（怪根本进不去那个位置）
    for (let k = 0; k < 4 && pointBlocked(w, x, y, pad); k++) {
      const p = nearestPlayerAny(w, x, y);
      if (!p) break;
      const dx = p.x - x;
      const dy = p.y - y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      x += (dx / d) * 30;
      y += (dy / d) * 30;
    }

    // ② 离任何玩家都必须 ≥ minPlayerDist：不做「贴脸必吃」。
    //    ★对齐的是「离得最近的那个玩家」而不是锚点玩家 —— 联机里两个人挨着站时，
    //      只按一个人算会把圈铺到另一个人脚下。
    for (let k = 0; k < players.length; k++) {
      const p = players[k];
      if (!p.alive) continue;
      const dx = x - p.x;
      const dy = y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= rule.minPlayerDist) continue;
      // d 可能正好是 0（落点与玩家重合），给一个确定的角度兜底
      const ang = d > 0.001 ? Math.atan2(dy, dx) : Math.PI * 0.25;
      x = p.x + Math.cos(ang) * rule.minPlayerDist;
      y = p.y + Math.sin(ang) * rule.minPlayerDist;
    }

    // ③ 夹回地图内（贴边砸出去只会浪费这颗星）
    x = clamp(x, pad, w.map.w - pad);
    y = clamp(y, pad, w.map.h - pad);
    return { x: x, y: y, n: best.n, total: total };
  }

  // 造一颗陨星（返回那条 strike；落点不成立时返回 null）。
  function spawnMeteor(w) {
    const rule = C.METEOR;
    const pt = pickMeteorPoint(w);
    if (!pt) return null;

    // 归属：算「离落点最近的那个人」的。经验/金币必须有个归属，
    // 否则结算里会出现「无主的击杀」，图鉴也不记账。
    const owner = nearestPlayerAny(w, pt.x, pt.y);
    const strike = {
      // ★src 是结算「伤害构成」的来源键（不进快照）。天火单独一档，
      //   否则它会混进某件武器的名字里，玩家会以为「我的刀打出了 300」。
      src: 'meteor',
      id: w.nextId++,
      kind: 'meteor',
      owner: owner,
      x: pt.x,
      y: pt.y,
      r: rule.radius,
      dmg: C.meteorDmgAt(w.wave),
      // ★对玩家的伤害在**这颗生成时**就定下来（按当时的血量上限算比例），
      //   落地那一刻不再读配置 —— 之后有人调表也不会影响已经在空中的那颗。
      playerDmgPct: rule.playerHpPct,
      stunSec: rule.mobStunSec,
      delay: rule.warnSec,
      life: rule.warnSec,
      color: '#ffcf5c'
    };
    w.strikes.push(strike);
    w.meteorSpawned += 1;
    w.events.push({
      type: 'meteor',
      x: Math.round(pt.x), y: Math.round(pt.y),
      sec: rule.warnSec,
      // 圈里大概有几只：提示条可以说「砸向妖群」，不必编数字
      mobs: pt.n
    });
    return strike;
  }

  // 每帧调一次（放在挑战者之后）。三道闸：剧情关 / 时间未到 / 还没到下一颗的时点。
  function maybeSpawnMeteor(w) {
    const rule = C.METEOR;
    if (!rule) return null;

    // ① 主线《补天纪》一律没有陨星（与挑战者 / 神龛 / 赤月同一条纪律）：
    //    剧情关逐关手工配平，多一个「会伤到自己人的天火」会让难度变成运气。
    if (w.storyStage) return null;

    // ② 时间未到（比较 tick 而不是 time，避免浮点比较）
    if (w.tick < Math.round(rule.startSec * C.TICK_HZ)) return null;

    // ③ 还没到下一颗的时点
    if (w.tick < w.meteorNextTick) return null;

    const st = spawnMeteor(w);
    if (st) {
      // 正常：下一次按间隔顺延
      w.meteorNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
      return st;
    }

    // ★落点不成立（场上太散 / 一只怪都没有）：**2 秒后重试**，而不是顺延一整个间隔。
    //   【为什么不能顺延 95 秒】实测踩过：第一颗的时点正好压在波次那一帧上，
    //   而新一波的怪刷在 700px 外（搜索半径 520 之外）—— 于是「这一波刚刷完、
    //   场上还是空的」，第一颗被跳到了 305 秒。玩家在 4~5 分钟里根本见不到这个玩法，
    //   而代码一行错都没有。
    //   【为什么重试是安全的】纯确定性（不看随机数），而且成功之后立刻按 95 秒顺延，
    //   不会出现「一直重试一直落」—— 场上没怪的时候它只是安静地等着。
    w.meteorNextTick = w.tick + Math.round(2 * C.TICK_HZ);
    return null;
  }

  // ============================================================
  // 地脉灵泉（第四十二轮：站桩充能）
  // ============================================================
  //
  // 【它是什么】地上涌出一座灵泉（存在 16 秒），站进圈里**连续 2 秒**唤醒它：
  //   半径 300 内的妖物受 90×波次曲线的伤害并被定身 0.8 秒，唤醒者回复 15% 血量上限。
  //   详见 const.js 的 LEYLINE 段。
  //
  // 【★★它同样不碰 nextRand】
  //   与挑战者 / 山魈 / 陨星同一条纪律：它在任意 tick 触发，不属于「这一波」的一部分。
  //   泉眼角度由 affixHash 散列决定（确定性、不消费主随机流），
  //   位置本身随快照下发，所以不需要「两端算出同一个位置」这件事成立。
  //
  // 【★状态放在哪】
  //   灵泉实体本身就是一条 `strikes`（与陨星共用同一个列表、同一个快照字段），
  //   `kind === 'ley'`。它**不走** updateStrikes 的通用退场逻辑：
  //   那个逻辑是「life 归零 → 砸一下」，而灵泉的退场条件是「充能满」或「16 秒过去」，
  //   所以由 updateLeys 自己管生命周期（step 里排在 updateStrikes 之前）。
  //
  // 【★充能进度怎么同步】
  //   复用 strike 上那个可选浮点字段 `delay`（协议一个字节都不用加）：
  //   对灵泉它装的是「还差几秒充满」——语义正好也是「爆发前还剩多久」。
  //   客户端拿 1 - delay/chargeSec 画进度环，两端不可能算出不同的数
  //   （不像「各自按玩家距离积分」那样会飘）。

  // 场上还活着几座灵泉（同屏上限用）
  function countAliveLeys(w) {
    let n = 0;
    const list = w.strikes;
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'ley') n += 1;
    }
    return n;
  }

  // 选泉眼位置：锚在「主线玩家」周围 offset 处，散列定角度，撞障碍就换一个角度。
  // ★为什么锚在玩家身边而不是随机一点：它是**请你去**的一个点位。
  //   放到半张地图外，玩家只会看到提示条上写着「灵泉涌出」然后一辈子走不到。
  function pickLeyPoint(w) {
    const rule = C.LEYLINE;
    const anchor = w.self || w.players[0];
    if (!anchor) return null;
    const pad = 70;

    // 8 个角度依次试：第一个是散列给的，之后顺时针转 45°。
    // ★角度必须来自散列而不是 nextRand：否则后面的每一波落点会整体错位（老坑）。
    const baseA = affixHash(w.leySpawned + 3121, 17, 'ley') * Math.PI * 2;
    for (let i = 0; i < 8; i++) {
      const a = baseA + (i * Math.PI) / 4;
      let x = anchor.x + Math.cos(a) * rule.offset;
      let y = anchor.y + Math.sin(a) * rule.offset;
      // 夹回地图内：贴边涌出会被墙切掉半个圈
      x = clamp(x, pad, w.map.w - pad);
      y = clamp(y, pad, w.map.h - pad);
      // 不能落在石头里：站不进去的圈等于没涌出来
      if (pointBlocked(w, x, y, 26)) continue;
      return { x: x, y: y };
    }
    return null;
  }

  // 涌出一座灵泉（返回这条 strike；位置不成立时返回 null）
  function spawnLey(w) {
    const rule = C.LEYLINE;
    const pt = pickLeyPoint(w);
    if (!pt) return null;

    const st = {
      // ★src 是结算「伤害构成」的来源键：灵泉单独一档「地脉」。
      //   混进某件武器里的话，玩家会以为自己那把刀打出了三百。
      src: 'ley',
      id: w.nextId++,
      kind: 'ley',
      // ★owner 刻意留空：灵泉是**世界**的东西，不属于任何玩家。
      //   填了 w.self 的话，锚点玩家一阵亡就会被 removeOwnedBy 顺手删掉 ——
      //   而「我死了灵泉也没了」这件事没人能猜出来。
      owner: null,
      x: pt.x,
      y: pt.y,
      r: rule.standRadius,
      // 已充能秒数（服务端权威）。客户端不读它，只读下面的 delay。
      charge: 0,
      // 「还差几秒充满」= 爆发前还剩多久（客户端据此画进度环）
      delay: rule.chargeSec,
      // 伤害在**涌出的那一刻**就按当时的波次定下来：之后有人调表也不影响已经在地上的那座。
      dmg: C.leyDmgAt(w.wave),
      life: rule.lifeSec,
      color: rule.color
    };
    w.strikes.push(st);
    w.leySpawned += 1;
    w.events.push({
      type: 'ley',
      x: Math.round(pt.x), y: Math.round(pt.y),
      sec: rule.lifeSec,
      charge: rule.chargeSec
    });
    return st;
  }

  // 每帧调一次（放在陨星之后）。三道闸：剧情关 / 时间未到 / 还没到下一座的时点。
  function maybeSpawnLey(w) {
    const rule = C.LEYLINE;
    if (!rule) return null;

    // ① 主线《补天纪》一律没有（与挑战者 / 神龛 / 赤月 / 陨星 / 山魈同一条纪律）：
    //    剧情关逐关手工配平，凭空多一个「站 2 秒清一片」的点位会让配好的压力失效。
    if (w.storyStage) return null;

    // ② 时间未到
    if (w.tick < Math.round(rule.startSec * C.TICK_HZ)) return null;

    // ③ 还没到下一座的时点
    if (w.tick < w.leyNextTick) return null;

    // ④ 同屏最多一座：地上已经有一座（玩家还没去）时不再涌新的。
    //    ★这里只**短等 2 秒**，不顺延整个间隔 —— 否则玩家一直不去，
    //      后面的排期会被整体推到很久之后（陨星那一轮踩过的同款坑）。
    if (countAliveLeys(w) > 0) {
      w.leyNextTick = w.tick + Math.round(2 * C.TICK_HZ);
      return null;
    }

    const st = spawnLey(w);
    if (!st) {
      // 找不到空位（贴边 + 障碍）：短等重试，理由同上
      w.leyNextTick = w.tick + Math.round(2 * C.TICK_HZ);
      return null;
    }
    w.leyNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
    return st;
  }

  // 每帧推进所有灵泉：算充能、管退场、充能满就爆。排在 updateStrikes 之前。
  function updateLeys(w, dt) {
    const rule = C.LEYLINE;
    if (!rule) return;
    const list = w.strikes;
    let write = 0;

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      // 不是灵泉：原样留给后面的 updateStrikes
      if (s.kind !== 'ley') { list[write++] = s; continue; }

      s.life -= dt;

      // ---------- 谁站在圈里 ----------
      // 取「圈内离泉眼最近的那个活人」：多人同站时爆发归给站得最正的那个人，
      // 而不是「谁先来」—— 后者要靠额外状态记，而且两边算出来会不一样。
      let stander = null;
      let standD = rule.standRadius;
      for (let k = 0; k < w.players.length; k++) {
        const p = w.players[k];
        if (!p.alive) continue;
        const d = distance(p.x, p.y, s.x, s.y);
        if (d > rule.standRadius) continue;
        if (!stander || d < standD) { stander = p; standD = d; }
      }

      if (stander) {
        // ★每帧只加一份 dt（不是每个站进来的人加一份）：
        //   「两个人一起站更快」听起来合理，但它会让 chargeSec 这个数值
        //   在单机与联机里代表两件不同的事，调起来就没基准了。
        s.charge += dt;
      } else if (s.charge > 0) {
        // 离开就回落（2 倍速）：不许「站一半跑开、回头补一秒」把风险摊平。
        s.charge -= dt * rule.decayMul;
        if (s.charge < 0) s.charge = 0;
      }

      const full = s.charge >= rule.chargeSec;
      // 充能倒计时写回 delay（客户端据此画进度环）。
      s.delay = full ? 0 : Math.max(0, rule.chargeSec - s.charge);

      if (!full) {
        // 16 秒到还没充满：安静消失。★不惩罚、不播报 ——
        // 「奖励没拿到」本身就是代价（那 2 秒的暴露风险白担了）。
        if (s.life > 0) list[write++] = s;
        continue;
      }

      // ---------- 充能满：地脉冲击 ----------
      // 归属人切到站桩的那个人：伤害构成与击杀记账都要落在正确的人头上。
      setCtx(w, stander || w.self);
      const p = w.player;

      // ① 圈内妖物受伤 + 定身。
      //   ★这里**不设** rageMute：与天火相反 —— 天火是白送的，灵泉是站出来的。
      //     站 2 秒换来的这一片清场，本来就应该接得上血怒（「站桩 → 爆发」是连招）。
      damageInCircle(w, s.x, s.y, rule.burstRadius, s.dmg, 46, {
        stunSec: rule.stunSec, src: 'ley'
      });

      // ② 回血：只回站桩那个人（不是全体）——否则「一个人站、全队回」太便宜。
      if (p && p.alive) healPlayer(w, p.maxHp * rule.healPct);

      // ③ 表现与播报
      // ★两条特效分工，缺一不可：
      //   ① boom：符文阵式的爆发核心（pixelfx 的「玉青那一支」，见 pixelfx-layer）
      //   ② leyring：**冲击边界**。库里的符文阵最大只能铺到百来像素，
      //      而这一下真正的作用范围是 300 —— 画不出边界，玩家就不知道
      //      「站在 301px 处为什么没被扫到」。所以边界自己用 Canvas 画一圈（kind 库里没有，
      //      会自然落到几何兜底那一支）。
      // ★0.55 秒（比普通 boom 的 0.3 长）：太短的话只看到「闪了一下」，看不清到哪。
      w.effects.push({
        kind: 'boom', x: s.x, y: s.y, r: rule.burstRadius,
        life: 0.55, maxLife: 0.55, color: rule.color
      });
      w.effects.push({
        kind: 'leyring', x: s.x, y: s.y, r: rule.burstRadius,
        life: 0.5, maxLife: 0.5, color: rule.color
      });
      w.leyBursts += 1;
      w.events.push({
        type: 'ley_burst',
        slot: p ? p.slot : 0,
        x: Math.round(s.x), y: Math.round(s.y)
      });
      // 不写回数组 = 移除
    }

    list.length = write;
  }

  // ============================================================
  // 血祭坛（第四十三轮：用生命上限换伤害）
  // ============================================================
  //
  // 【它是什么】地上浮起一座血色石坛，18 秒后沉回去。踩上去 = 签一次契约：
  //   永久扣掉 14% 生命上限，永久换 +18% 伤害（最多两层）。血量不到 70% 时
  //   它**拒绝**你 —— 祭坛不消失，回血了还能回来。详见 const.js 的 BLOODPACT 段。
  //
  // 【为什么不给玩家一个「确认」面板】
  //   与神龛同一条硬约束：**联机时世界停不下来**（商店/自动补给/倍速都只做在单机）。
  //   在这里弹一个「确定要付出 14% 上限吗」的框，等于让人在怪堆里腾出一只手 ——
  //   那不是抉择，是惩罚。所以走位本身就是确认：踩上去 = 同意。
  //   代价的可见性交给「红线式的提示条 + 踩下去当场掉一截血上限」。
  //
  // 【为什么状态记在 p.pacts（一个数字）而不是 p.shrines 里的一条】
  //   神龛是按 id 分种类的祝福表（三种各不相同）；血祭只有一种，层数就是它的全部状态。
  //   混进 p.shrines 会让人以为它也是 SHRINE_MAP 的一员（踩上去走 applyShrine 那条路）。
  //
  // ★★与挑战者/陨星/山魈/灵泉同一条铁律：整段**不许碰 nextRand**。
  //   落点角度与偏移全部用 affixHash 散列 —— 可复现，且不扰动后面每一波的落点。

  // 场上还活着几座血祭坛（同屏上限用）
  function countAlivePacts(w) {
    let n = 0;
    const list = w.pickups;
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind === 'pact') n += 1;
    }
    return n;
  }

  // 选祭坛落点：锚在「自己」周围 offset 处，散列定角度，撞障碍就顺时针换角度。
  // ★为什么锚在身边而不是丢到半张图外：它是**请你过去**的一个点位。
  //   丢到屏幕外，玩家只会看到提示条上写着「血祭坛浮现」而永远找不到它。
  function pickPactPoint(w) {
    const rule = C.BLOODPACT;
    const anchor = w.self || w.players[0];
    if (!anchor) return null;
    const pad = 70;

    // ★角度必须来自散列而不是 nextRand（老坑：会整体错位后面每一波的落点）
    const baseA = affixHash(w.pactSpawned + 4721, 29, 'pact') * Math.PI * 2;
    for (let i = 0; i < 8; i++) {
      const a = baseA + (i * Math.PI) / 4;
      let x = anchor.x + Math.cos(a) * rule.offset;
      let y = anchor.y + Math.sin(a) * rule.offset;
      // 夹回地图内：贴边浮现的话，它与玩家之间的距离会被墙吃掉一半
      x = clamp(x, pad, w.map.w - pad);
      y = clamp(y, pad, w.map.h - pad);
      // 不能落在石头里：跑不进去的祭坛等于没有
      if (pointBlocked(w, x, y, 26)) continue;
      return { x: x, y: y };
    }
    return null;
  }

  // 浮现一座血祭坛（返回那颗 pickup；位置不成立时返回 null）
  function spawnPact(w) {
    const rule = C.BLOODPACT;
    const pt = pickPactPoint(w);
    if (!pt) return null;

    // ★复用现成的「走上去就生效」实体（pickups 的 kind）而不是新造一套：
    //   拾取、快照、渲染、磁石排除全都有现成分支，代价只是多一个 kind 字面量。
    //   value 固定为 1：祭坛没有种类，层数记在玩家身上（见 applyPact）。
    // ★spawnPickup 没有返回值（它是无脑 push），所以这里取数组末尾那一颗 ——
    //   写 `const it = spawnPickup(...)` 会永远拿到 undefined，
    //   表现是 maybeSpawnPact 以为「找不到空位」而每 2 秒重试一次，祭坛一座都不出现。
    spawnPickup(w, 'pact', pt.x, pt.y, 1, rule.lifeSec);
    const it = w.pickups[w.pickups.length - 1] || null;
    if (!it) return null;
    w.pactSpawned = (w.pactSpawned || 0) + 1;
    w.events.push({
      type: 'pact',
      x: Math.round(pt.x), y: Math.round(pt.y),
      sec: rule.lifeSec,
      costPct: rule.hpCostPct,
      dmg: rule.dmg
    });
    return it;
  }

  // 每帧调一次（放在灵泉之后）。四道闸：剧情关 / 时间未到 / 未到下一次 / 场上已有。
  function maybeSpawnPact(w) {
    const rule = C.BLOODPACT;
    if (!rule) return null;

    // ① 主线《补天纪》一律没有（与挑战者 / 神龛 / 赤月 / 陨星 / 山魈 / 灵泉同一条纪律）：
    //    剧情关是逐关手工配平的，凭空多一条「掉上限换伤害」只会破坏配好的血量曲线。
    if (w.storyStage) return null;

    // ② 时间未到（比较 tick 而不是 time，避免浮点比较）
    if (w.tick < Math.round(rule.startSec * C.TICK_HZ)) return null;

    // ③ 还没到下一座的时点
    if (w.tick < w.pactNextTick) return null;

    // ④ 同屏最多一座：地上已经有一座没被踩（或刚被拒绝）时不再浮现新的。
    //    ★只**短等 2 秒**，不顺延整个间隔 —— 否则玩家一直不去，
    //      后面的排期会被整体推到很久之后（陨星那一轮踩过的同款坑）。
    if (countAlivePacts(w) > 0) {
      w.pactNextTick = w.tick + Math.round(2 * C.TICK_HZ);
      return null;
    }

    const it = spawnPact(w);
    if (!it) {
      // 找不到空位（贴边 + 障碍）：短等重试，理由同上
      w.pactNextTick = w.tick + Math.round(2 * C.TICK_HZ);
      return null;
    }
    w.pactNextTick = w.tick + Math.round(rule.everySec * C.TICK_HZ);
    return it;
  }

  // 踩上一座血祭坛：付上限，换伤害。
  // 返回 true = 契约成立；false = 被拒绝（血不够 / 已满层），此时**祭坛不动**。
  //
  // ★★「拒绝」必须是**什么都不做**：不扣血、不给加成、不消耗祭坛。
  //   这一支最容易写错的地方是「先扣再判」—— 那样残血玩家路过就被扣成 1 点血，
  //   而界面上只会显示「血气不足」，没人能看出血去哪了。simtest 钉了这一条。
  //
  // ★第三个参数 it（那座祭坛）只用来**去掉重复播报**：拒绝之后祭坛还留在原地，
  //   玩家站在上面会每帧再踩一次 —— 不拦的话提示条会在一秒内刷六十条。
  //   不给 it 也能用（测试直接调时不需要节流）。
  function applyPact(w, p, it) {
    const rule = C.BLOODPACT;
    if (!rule || !p || !p.alive) return false;

    // 拒绝播报只发一次（见上面那段说明）
    function noteOnce(type, extra) {
      if (it && it.denied) return;
      if (it) it.denied = 1;
      w.events.push(Object.assign({ type: type, slot: p.slot, name: p.name }, extra || {}));
    }

    const cur = p.pacts || 0;
    // ① 满层：不再叠加（但要说清「是满了」，不是「白踩了」）
    if (cur >= rule.stackMax) {
      noteOnce('pact_full', { level: cur, stackMax: rule.stackMax });
      return false;
    }

    // ② 血气不足：按**当下的**生命上限算比例
    if (p.hp < p.maxHp * rule.minHpPct) {
      noteOnce('pact_deny', {
        hpPct: p.maxHp > 0 ? p.hp / p.maxHp : 0,
        needPct: rule.minHpPct
      });
      return false;
    }

    // ③ 成交：记层数 → 重算属性（上限打折 + 伤害加成都在 recalcAttrs 里）
    p.pacts = cur + 1;
    const hpBefore = p.hp;
    const maxBefore = p.maxHp;

    // ★重算走 w.player 上下文（与 applyShrine / applyLevelHp 同一套做法）：
    //   不切的话联机里会拿「自己」的属性去重算别人 —— 表现是「队友签了契约，我掉血」。
    const prevCtx = w.player;
    setCtx(w, p);
    recalcAttrs(w);
    if (prevCtx && prevCtx !== p) setCtx(w, prevCtx);

    w.pactTaken = (w.pactTaken || 0) + 1;

    // 兑现的反馈：脚下溅一圈血色（复用 boom，不新增特效 kind —— 新增要进串池、
    // 要在两条绘制管线各加一支，为一次脉冲不值得）。
    w.effects.push({
      kind: 'boom', x: p.x, y: p.y, r: 64,
      life: 0.4, maxLife: 0.4, color: rule.color
    });

    w.events.push({
      type: 'pact_taken', slot: p.slot, name: p.name,
      level: p.pacts, stackMax: rule.stackMax,
      maxBefore: Math.round(maxBefore), maxAfter: Math.round(p.maxHp),
      // 实际掉的血 = 比例校正掉的这部分（玩家要在提示条上看到「我刚才少了多少」）
      hpLost: Math.max(0, Math.round(hpBefore - p.hp))
    });
    return true;
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
    // ★赤月的 countMul 乘在难度之后：两者是**独立的两个维度**
    //   （难度 = 这局整体多难，赤月 = 这一波临时多密），替换掉任何一个都会让另一个失效。
    //   顶破 MAX_MOBS 时由下面的 room 裁剪兜住，不会超发。
    let count = Math.round((w.storyStage
      ? CP.waveCountOf(w.modId, w.storyStage, wave)
      : C.waveCount(wave)) * diff.countMul * (w.moonOn ? C.BLOOD_MOON.countMul : 1));
    if (count > room) count = room;
    if (count < 0) count = 0;

    // 本波词缀抽签的序号：只用来给散列当输入，不参与任何逻辑。
    // ★用「这一波的第几只」而不是全局 id：同种子同一波结果完全可复现，
    //   而且不依赖「之前发生过什么」，测试里单独构造一波也能算。
    w.affixIdx = 0;
    for (let i = 0; i < count; i++) {
      // pickWeighted 返回的是 key —— 现在 key 直接就是怪种 id
      const mobId = pickWeighted(w, pool);
      if (!mobId || !C.MOB_MAP[mobId]) continue;
      // 每只怪各自挑一个玩家当锚点：多人分开走位时两边都有压力
      const pos = ringSpawnPos(w, pickSpawnAnchor(w));
      const affix = affixForSpawn(w, mobId);
      w.affixIdx += 1;
      spawnMob(w, mobId, pos.x, pos.y, hpMul, affix);
      if (affix) noteAffixSeen(w, affix);
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
      damageMob(w, m, dmg, kx, ky, opts.src);
      hits++;

      if (opts.stunSec) m.stun = Math.max(m.stun, opts.stunSec);
    }
    return hits;
  }

  // 扇形范围伤害（铁鞭）
  function damageInArc(w, x, y, radius, facing, arcDeg, dmg, knock, src) {
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
      damageMob(w, m, dmg, (dx / d) * knock, (dy / d) * knock, src);
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
      damageInArc(w, p.x, p.y, range, ang, def.arcDeg, dmg, def.knock || 0, def.id);
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

      // 轨迹参数：让直线弹带一点「游动感」，幽冥锁链摆得最明显（像甩动的锁链），
      // 其余只给几像素，判定范围几乎不变。★这几个字段只在本层模拟时用，
      // 不进二进制快照（协议按白名单取字段），带宽与联机一致性都不受影响。
      const sway = def.id === 'spirit_chain' ? 9 : (def.id === 'thousand_blades' ? 5 : 2.5);

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
        const swayT = i * 0.8;

        w.projectiles.push({
          // 伤害归属（第三十六轮）：只在本机世界里有，不进快照（二进制协议按字段表编码，多余字段自动忽略）
          src: def.id,
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
          explodeDmg: def.explodeDmg ? def.explodeDmg * a.dmgMul : 0,
          sway: sway, swayHz: 9, swayT: swayT,
          swayOff: sway * Math.sin(swayT)
        });
      }
      return;
    }

    // ---------- 光环（蒜雾 / 灵魂吞噬）：每次冷却到点就打一圈 ----------
    if (kind === 'aura') {
      damageInCircle(w, p.x, p.y, range, dmg, def.knock || 0, { src: def.id });
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
        // 伤害归属（第三十六轮）：只在本机世界里有，不进快照（二进制协议按字段表编码，多余字段自动忽略）
        src: def.id,
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
          // 伤害归属（第三十六轮）：只在本机世界里有，不进快照（二进制协议按字段表编码，多余字段自动忽略）
          src: def.id,
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
        const swayT = i * 1.1;
        w.projectiles.push({
          // 伤害归属（第三十六轮）：只在本机世界里有，不进快照（二进制协议按字段表编码，多余字段自动忽略）
          src: def.id,
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
          color: def.evolved ? '#f2c14e' : '#e8d9b8',
          // 追踪弹一边拐弯一边轻微摆尾，走 S 形而不是死板的圆弧
          sway: 5, swayHz: 6, swayT: swayT, swayOff: 5 * Math.sin(swayT)
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
        // 去程的弧线角速度：正负交替，多把回旋刃不会叠成同一条线
        const curve = (i % 2 === 0 ? 1 : -1) * 1.25;
        w.projectiles.push({
          // 伤害归属（第三十六轮）：只在本机世界里有，不进快照（二进制协议按字段表编码，多余字段自动忽略）
          src: def.id,
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
          curve: curve,
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
          // 伤害归属（第三十六轮）：只在本机世界里有，不进快照（二进制协议按字段表编码，多余字段自动忽略）
          src: def.id,
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
        // 伤害归属（第三十六轮）：只在本机世界里有，不进快照（二进制协议按字段表编码，多余字段自动忽略）
        src: def.id,
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

    // 全局导航流场：整帧只算一次（内部还有 0.5 秒 / 跨格节流），所有怪共享。
    // ★放在怪循环之外，别挪进循环 —— 挪进去就变成每只怪一次 BFS。
    updateNav(w);

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

      // ---------- 山魈：绕着玩家转圈（第四十一轮） ----------
      // 【为什么不是「往反方向跑」】纯直线后退会被地形逼进死角，变成一块站着挨打的木头；
      //   目标点取「距玩家 keepDist、再偏一个切向位移」之后，它自然沿着弧线绕，
      //   既不贴脸也不跑远 —— 玩家必须自己把距离压上去。
      // 【为什么也走 moveMobToward】那里面有全套速度层（光环 / 词缀 / 赤月 / 定身），
      //   自己算一份就等于把「赤月加速」这类乘区复制一遍，迟早漏一个。
      else if (def.kind === 'summoner') {
        const SU = C.SUMMONER || { keepDist: 240, strafeMul: 0.55 };
        const dx = m.x - p.x;
        const dy = m.y - p.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const ux = dx / d;
        const uy = dy / d;
        // 切向右乘一个「绕行方向」：来自怪 id 的奇偶（确定性的，不取随机数），
        // 让同屏多只山魈不会绕着同一个方向转成一串糖葫芦。
        const side = (m.id & 1) ? 1 : -1;
        const kd = SU.keepDist;
        const tx = p.x + ux * kd + (-uy) * kd * SU.strafeMul * side;
        const ty = p.y + uy * kd + (ux) * kd * SU.strafeMul * side;
        moveMobToward(w, m, tx, ty, dt);
        // 召唤与移动分开算：定身时它不动也不召（见 tickSummoner 的说明）
        tickSummoner(w, m, dt);
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
    // 速度四层：怪自己的基础速度 × 光环加成 × 冲刺倍率 × 词缀（狂暴快 / 坚壁慢），
    // 再乘赤月（第三十九轮）。
    // ★词缀只乘在「移动」上，不改 def.speed —— def 是共享对象，改它等于改所有同种怪。
    // ★赤月同理：只在移动这一处乘，**绝不写进 def.speed 或 m.* 的持久字段** ——
    //   写进去就得在每个「赤月结束」的时刻改回来，漏一处就是永久加速
    //   （血怒踩过同一个坑，见 const.js 的 RAGE 说明）。
    const af = m.affix ? (C.AFFIX_MAP && C.AFFIX_MAP[m.affix]) : null;
    const moonMul = w.moonOn ? C.BLOOD_MOON.mobSpeedMul : 1;
    let sp = m.def.speed * (m.buffMul || 1) * (speedMul || 1) *
      (af && af.speedMul ? af.speedMul : 1) * moonMul;

    let vx = (dx / d) * sp;
    let vy = (dy / d) * sp;

    // ---------- 绕行模式（第三十八轮）----------
    // 从夹缝里被「挤」出来之后，不能让它立刻又朝着玩家直线冲回同一堵墙 ——
    // 实测那样会变成「挤出 20px → 撞回去 → 再卡 1.8 秒 → 再挤」的循环。
    // 这段时间改成按全局流场走，真的绕过这堵墙再恢复直追。
    // ★只读 w.nav（模拟层内部状态），不吃随机数，双端一致。
    if (m.detourT > 0) {
      m.detourT -= dt;
      const nd = navDirAt(w, m.x, m.y);
      if (nd && (nd.x || nd.y)) {
        vx = nd.x * sp;
        vy = nd.y * sp;
      }
    }

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

      // ---------- 回旋刃：甩出弧线 → 绕弧归巢 ----------
      if (pr.kind === 'boomerang') {
        const p = w.player;
        const curve = pr.curve || 1.25;
        if (pr.phase === 'out') {
          pr.traveled += pr.speed * dt;
          // ★去程不再是一条直线：速度方向连续小角度旋转，划出一道弧。
          //   角速度按「飞到 maxTravel 大约转 40 度」标定，不会绕圈飞不回来。
          const a = Math.atan2(pr.vy, pr.vx) + curve * dt;
          pr.vx = Math.cos(a) * pr.speed;
          pr.vy = Math.sin(a) * pr.speed;
          if (pr.traveled >= pr.maxTravel) {
            pr.phase = 'back';
            pr.hitIds = {};      // 折返后可以再次命中同一目标
          }
        } else {
          const dx = p.x - pr.x;
          const dy = p.y - pr.y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          // ★回程是「限速平滑转向主人」而不是瞬间 180° 掉头：留出一段绕行，
          //   看上去才像真的飞了一圈回来，而不是折线弹回。
          // ★但快到主人身边（120px）时必须直接对准：只靠限速转向会在玩家
          //   周围画出一圈圈轨道，回旋刃绕半天收不回来，手感全毁。
          if (d < 120) {
            pr.vx = (dx / d) * pr.speed;
            pr.vy = (dy / d) * pr.speed;
          } else {
            let diff = Math.atan2(dy, dx) - Math.atan2(pr.vy, pr.vx);
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;
            const maxTurn = 6 * dt;
            const a = Math.atan2(pr.vy, pr.vx) + clamp(diff, -maxTurn, maxTurn);
            pr.vx = Math.cos(a) * pr.speed;
            pr.vy = Math.sin(a) * pr.speed;
          }
          if (d < 22) {
            pr.tripsDone += 1;
            if (pr.tripsDone >= pr.trips) {
              continue;          // 往返次数用完，消失
            }
            pr.phase = 'out';
            pr.traveled = 0;
            pr.hitIds = {};
            // 速度方向保持当前朝向，第二次去程会顺着归巢的惯性再甩出去
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

      // ---------- 摆尾：所有飞行弹共用的垂直偏移 ----------
      // ★只改 x/y（伤害判定也用 x/y，画面与判定完全一致），不动 vx/vy，
      //   这样特效跟着速度方向画才不会「身子歪着飞」。
      // ★用「上一帧偏移的差值」做增量而不是直接加 sin 值：换帧率也不会让弹丸
      //   整条轨迹漂移，且第一帧 swayOff 已按初相位算好，出膛不会跳一下。
      if (pr.sway) {
        pr.swayT += dt * pr.swayHz;
        const off = pr.sway * Math.sin(pr.swayT);
        const delta = off - pr.swayOff;
        pr.swayOff = off;
        const sp = Math.hypot(pr.vx, pr.vy) || 1;
        pr.x += (-pr.vy / sp) * delta;
        pr.y += (pr.vx / sp) * delta;
      }

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
        damageMob(w, m, pr.dmg, (dx / d) * 14, (dy / d) * 14, pr.src);

        // 陨星：命中爆炸
        if (pr.explodeRadius > 0) {
          damageInCircle(w, pr.x, pr.y, pr.explodeRadius, pr.explodeDmg, 30, { src: pr.src });
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
        damageInCircle(w, z.x, z.y, z.r, z.dmg, 18, { hitKey: z.hitKey + '_' + z.hitKeySeed, src: z.src });
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

      // 地脉灵泉（第四十二轮）：它由 updateLeys 自己管生命周期。
      // ★必须在这里跳过：通用逻辑是「life 归零 → 按 s.r / s.dmg 砸一下」，
      //   而灵泉的 s.r 是**站桩半径 52**（伤害半径是 300），
      //   走通用逻辑会变成「16 秒后对着脚下砸一个 52 的小圈」——不报错，但完全是另一个玩法。
      if (s.kind === 'ley') { list[write++] = s; continue; }

      s.life -= dt;
      if (s.life > 0) {
        list[write++] = s;
        continue;
      }

      // 归属：落点砸下来之前的最后一步也要切上下文，否则伤害会算到别人头上
      setCtx(w, s.owner || w.self);

      // ---------- 陨星（第四十轮）：先伤玩家，再伤妖物，最后铺星火 ----------
      // 【★★顺序是刻意的】先把玩家那一份结算掉，再打怪。
      //   反过来（先清怪）会让「玩家被砸」发生在「一大批怪刚被清掉之后」——
      //   那时 w.player 上下文的战绩、连杀、伤害构成都已经变了，排查时会看错人。
      //
      // 【为什么玩家伤害要「不致死」】
      //   环境伤害把人打死是这类事件里最招骂的一种：玩家正在怪堆里残血清场，
      //   天上一颗石头下来直接结束整局，他记不住「我站位不好」，只记住「被砸死了」。
      //   所以这里按「血量上限 × 比例」算，再用「当前血量 - 1」夹一次 ——
      //   最多砸到剩 1 滴血，把「必须撤退」说清楚，但不替他结束这一局。
      if (s.kind === 'meteor') {
        const rule = C.METEOR;
        const pct = s.playerDmgPct || rule.playerHpPct;
        for (let k = 0; k < w.players.length; k++) {
          const p = w.players[k];
          if (!p.alive) continue;
          const dx = p.x - s.x;
          const dy = p.y - s.y;
          // 站在圈外一滴血都不掉（这条由 simtest 钉住）
          if (dx * dx + dy * dy > s.r * s.r) continue;
          const cap = p.hp - 1;
          if (cap <= 0) continue;
          const raw = p.maxHp * pct;
          damagePlayer(w, p, raw < cap ? raw : cap, s.x, s.y);
        }

        // 星火：只烧妖物，不烧玩家（见 const.js 的说明）。
        // ★owner 沿用这颗陨星的归属，这样星的持续伤害在结算里也落在同一档。
        w.zones.push({
          src: 'meteor',
          id: w.nextId++,
          kind: 'zone',
          owner: s.owner || w.self,
          x: s.x,
          y: s.y,
          r: rule.fireRadius,
          dmg: rule.fireDmg,
          tickSec: rule.fireTickSec,
          tickTimer: 0,
          life: rule.fireSec,
          maxLife: rule.fireSec,
          color: '#ff8c42',
          hitKey: 'mf' + w.nextId
        });
        w.events.push({ type: 'meteor_hit', x: Math.round(s.x), y: Math.round(s.y) });
      }

      // 到点：造成范围伤害
      // ★天火砸死的那一坨**不算连杀**（rageMute）：否则每 95 秒白送一次血怒，
      //   血怒就从「奖励敢在怪堆里站着」退化成「等天火」。
      if (s.kind === 'meteor') w.rageMute += 1;
      damageInCircle(w, s.x, s.y, s.r, s.dmg, 40, { stunSec: s.stunSec || 0, src: s.src });
      if (s.kind === 'meteor') w.rageMute -= 1;
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

      // ★三瓣花轨迹：半径随转角轻微呼吸，经卷 / 冥火不再绕一个死圆。
      //   幅度只有 6px，命中判定跟着 x/y 走，清怪效率不变；
      //   orbits 的快照只传 x/y，所以这个相位不需要同步给客户端。
      const r = o.r + Math.sin(o.angle * 3 + o.id) * 6;
      o.x = p.x + Math.cos(o.angle) * r;
      o.y = p.y + Math.sin(o.angle) * r;

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
        damageMob(w, m, o.dmg, (dx / d) * 10, (dy / d) * 10, o.src);
      }

      list[write++] = o;
    }
    list.length = write;
  }

  // ============================================================
  // 掉落物拾取
  // ============================================================

  // ============================================================
  // 上古神龛（第三十五轮）
  // ============================================================
  // 第 index 个神龛在这张图上是什么类型。
  // 用 affixHash（整数散列）而不是 nextRand：**开局生成也绝不能动主随机流** ——
  // 波次刷怪的落点、怪种权重全按顺序取数，这里插一次就等于把所有怪的站位整体挪一格。
  // ★一张图三个神龛、三种祝福：`(序号 + 地图偏移) % 3` 保证三种各一处，
  //   所以玩家在任何一个方向跑都能领到不同类型 —— 选择真的存在。
  function shrineTypeAt(map, index) {
    const list = C.SHRINES;
    if (!list || !list.length) return 0;
    const offset = Math.floor(affixHash(1, 1, map.id) * list.length) % list.length;
    return list[(index + offset) % list.length].id;
  }

  // 领一个神龛：把祝福记到**踩到它的那个人**身上，然后重算属性。
  // 返回 true = 生效（层数有涨），false = 已经到了上限（仍然会被吃掉）。
  function applyShrine(w, p, typeId) {
    const def = C.SHRINE_MAP[typeId];
    if (!def) return false;                 // 表里没有的 id：当成普通垃圾，什么都不加
    if (!p.shrines) p.shrines = {};

    const cur = p.shrines[def.id] || 0;
    const full = cur >= C.SHRINE_RULE.stackMax;
    if (!full) p.shrines[def.id] = cur + 1;

    // 踩之前的血量：补血要按**绝对量**算，见下面那段。
    const hpBefore = p.hp;

    // ★属性重算走 w.player 上下文（与 applyLevelHp / 商店买 buff 同一套做法）。
    //   不切的话，联机里会拿「自己」的属性去重算别人 —— 表现是「队友领了神龛，
    //   我的伤害变了」，这种只在联机复现的问题最难查。
    const prevCtx = w.player;
    setCtx(w, p);
    recalcAttrs(w);
    if (prevCtx && prevCtx !== p) setCtx(w, prevCtx);

    // 厚土之龛除了抬上限还要当场补血：只抬上限的话，残血玩家踩上去
    // 看到的「上限涨了、当前血没动」，会觉得这个祝福没用。
    // ★★补血用**绝对量**（踩之前的血量 + 25），不吃 recalcAttrs 的比例校正结果。
    //   recalcAttrs 里换被动/升级的语义是「上限变了，当前血按比例伸缩」；
    //   而「补 25 点」是绝对量。混着用会得到「说好补 25，实际补了 33」
    //   —— 和 applyLevelHp 当初必须绕开比例校正的原因完全一样。
    if (!full && def.hp && p.alive) {
      const target = Math.min(p.maxHp, hpBefore + def.hp);
      if (target > p.hp) {
        p.stats.healed += target - p.hp;
        p.hp = target;
      }
    }

    w.events.push({
      type: 'shrine', slot: p.slot, name: p.name,
      shrine: def.id, shrineName: def.name, hint: def.hint,
      // 满层时也播报一句，但要说清「没再加」—— 否则玩家会以为祝福丢了
      level: p.shrines[def.id] || cur, full: full ? 1 : 0
    });
    return !full;
  }

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
          // 赤月（第三十九轮）：经验球价值 ×expMul —— 这是「顶着怪潮清」的回报。
          // ★乘在「吃进去的那一刻」而不是「生成的那一刻」：
          //   赤月结束时地上还躺着一堆球，若按生成时算，玩家会看到
          //   「同一个球，赤月里吃 13 点、赤月后吃 10 点」——同一颗球两个价，最难解释。
          const moonExp = w.moonOn ? C.BLOOD_MOON.expMul : 1;
          gainExp(w, it.value * p.attrs.expMul * moonExp);
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
        } else if (it.kind === 'shrine') {
          // 上古神龛（第三十五轮）：踩上去就领，不弹面板（理由见 const.js 的 SHRINES 段）。
          // 祝福记在 p 身上、由 recalcAttrs 汇总，所以升级/进化/买buff 都不会把它弄丢。
          applyShrine(w, p, it.value);
        } else if (it.kind === 'pact') {
          // 血祭坛（第四十三轮）：踩上去签一次契约（掉生命上限换伤害）。
          // 【为什么被拒绝时要「写回数组」】拒绝不该有代价 —— 祭坛必须留在原地，
          //   让玩家回血后再回来（18 秒内）。成功则**不写回** = 它被吃掉了。
          if (!applyPact(w, p, it)) {
            list[write++] = it;
            continue;
          }
          continue;
        }
        continue;
      }

      // 【宝箱 / 神龛 / 血祭坛刻意不被磁石吸走】它们都是「要专门走过去」的地面物件，
      // 会被自动吸过来的话，那一刻就消失了 —— 而整局里正好需要这么几个
      // 「主动走过去」的瞬间。其余掉落物照旧吸附，别改。
      if (it.kind === 'chest' || it.kind === 'shrine' || it.kind === 'pact') {
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
  // ---------- 升级卡上的「范围变化」提示（第四十四轮） ----------
  // 【为什么要显示绝对值而不是百分比】武器的 range 是绝对值，量级从 6 到 680 都有：
  //   写「+8%」玩家根本换算不出来，写「88→95」他一眼就知道宽了多少。
  // 【为什么只给武器卡写】被动卡（千里镜）影响的是**全体**武器，
  //   在单张卡上写「你所有武器都变宽」会挤掉「配哪把武器能进化」的配方说明；
  //   而且它的效果在 HUD 的「范围倍率」那一行本来就能直接看到。
  // 【为什么必须乘 rangeMul】玩家手上可能已经有千里镜：只按底值算会显示「88→95」，
  //   而他实际感受到的是 176→190 —— 卡片上的数字和手感对不上，比不显示更糟。
  // 【为什么可能返回空串】射程几百的武器升一级也只宽几个像素，圆整后会相等；
  //   这时候与其显示「范围 460→460」，不如什么都不写。
  function rangeDeltaText(def, level, rangeMul) {
    const mul = rangeMul || 1;
    const now = Math.round(C.weaponStats(def, level).range * mul);
    const next = Math.round(C.weaponStats(def, level + 1).range * mul);
    if (next <= now) return '';
    return '　范围 ' + now + '→' + next;
  }

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
        desc: '等级 ' + own.level + ' → ' + (own.level + 1) + '　' + def.desc
          + rangeDeltaText(def, own.level, p.attrs.rangeMul),
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
    // 血怒计时先走一轮（第三十八轮）：它必须在移动/开火之前更新，
    // 这样这一帧的移速与伤害读到的是**刚刚好**的状态，不会出现
    // 「最后一帧还在爆发、血条已经按没爆发算」这种一帧的错位。
    for (let i = 0; i < players.length; i++) tickRage(w, players[i], dt);

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

    // ---------- 2.2 挑战者（局内精英事件） ----------
    // 【为什么放在波次后面】它要读 w.wave（血量按同一条曲线成长），
    //   也要让「这一帧刚刷完一波」之后再插它 —— 否则同一帧里两个入口都在 push 怪，
    //   排查「这只怪哪来的」时完全看不出先后。
    maybeSpawnChallenger(w);

    // ---------- 2.25 山魈（第四十一轮：召唤型妖物） ----------
    // 【为什么紧挨着挑战者】两者都是「事件型精英」，共用同一套闸门与顺延规则；
    //   放在一起，以后调「谁先出现」只看这两行。
    // 【为什么在陨星之前】陨星要按「场上妖物最密处」选点，山魈刚召出来的那几只
    //   也应该算进这一帧的密度里（差一帧无所谓，但顺序上先加怪再选点更自然）。
    maybeSpawnSummoner(w);

    // ---------- 2.27 双生妖（第四十五轮：同命相连的一对） ----------
    // 【为什么紧跟在两个事件精英之后】三者共用同一套闸门与顺延规则，
    //   摆在一起，以后调「谁先出现」只看这几行。
    // 【为什么排在陨星之前】陨星按「场上妖物最密处」选点，这一帧刚进场的那两只
    //   也该算进密度里（差一帧无所谓，但不能反过来让新怪不算数）。
    maybeSpawnTwins(w);

    // ---------- 2.3 陨星（第四十轮：局内小事件） ----------
    // 【为什么排在挑战者之后、updateMobs 之前】它要读「怪现在挤在哪」，
    //   而这一步用的是上一帧的位置 —— 相差一帧无所谓（1.8 秒预警里怪还在走）。
    //   放在 updateMobs 之后就变成「用这一帧的新位置」，除了让断言更难对齐没有好处。
    maybeSpawnMeteor(w);

    // ---------- 2.35 地脉灵泉（第四十二轮：站桩充能） ----------
    // 【为什么排在陨星之后】两者都是「往地上放一个点位」，灵泉是**请你去**、
    //   陨星是**请你走**。放在同一段里，一眼能看出今天这两个点位的关系。
    // 【为什么它不读怪的位置】泉眼锚在玩家身边，与场上密度无关 ——
    //   所以它不像陨星那样有「这一帧刚刷完、场上还空着」的落空问题。
    maybeSpawnLey(w);

    // ---------- 2.4 血祭坛（第四十三轮：用生命上限换伤害） ----------
    // 【为什么排在灵泉之后】两者都是「地上浮起一个点位请你过去」，但方向相反：
    //   灵泉是白给的（站 2 秒换清场），血祭坛要你先付账（永久掉上限）。
    //   摆在同一个位置，一眼能看出「今天这两个点位的关系」。
    // 【为什么不读场上怪的位置】祭坛锚在玩家身边，与密度无关 ——
    //   所以它没有陨星那种「这一帧刚刷完、场上是空的」落空问题。
    maybeSpawnPact(w);

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

    // ---------- 2.6 赤月天象（第三十九轮） ----------
    // 【为什么必须在 updateMobs 之前】它决定这一帧怪跑多快。
    //   放在怪物 AI 之后的话，「赤月开始的那一帧」怪还按旧速度走一步 ——
    //   一帧的错位没人看得见，但会让「正好 ×1.20」这类断言变成 ×1.19 的浮点争议。
    // 【为什么不放在 spawnWave 里面】它跟波次节奏无关（100 秒 vs 30 秒），
    //   而且冷却/持续是按帧推进的，塞进「只在波次到来时才跑」的函数里就永远不会结束。
    tickMoon(w);

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
    // ★灵泉排在 updateStrikes **之前**：它自己推进 life、自己判充能满、
    //   自己把爆掉的那座从数组里摘掉（updateStrikes 只负责「跳过 kind==='ley'」，
    //   两条路径互不重叠）。顺序定成这样是为了「同帧一致性」：
    //   这一帧爆掉的灵泉必须在打包快照**之前**就消失，否则客户端会收到
    //   一条「已经爆过、进度还是满的」灵泉，画面上就是地上一圈空环不散。
    updateLeys(w, dt);
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

    // ---------- 7.5 双生妖的同命倒计时（第四十五轮） ----------
    // 【为什么必须在 8 之前】复活要 spawnMob 一只新的，而 8 会压掉死怪；
    //   两个都是「整理 mobs 数组」的动作，先让复活把新怪放进去，再统一压缩。
    // 【为什么不在第 2 段】它不是「到点生成」，而是「上一只倒下才开始的计时」——
    //   排期段只负责「什么时候来一对新的」。
    updateTwins(w);

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
    // ★血怒的移速加成（第三十八轮）乘在这里，**不写回 attrs**：
    //   attrs.speed 是「面板上的那个数」，每级都在变、还要给暂停面板看；
    //   把临时状态写进去，就得在每个「可能结束的时刻」记得改回来（漏一处就是永久加速）。
    const spd = p.attrs.speed * (p.rage > 0 ? C.RAGE.speedMul : 1);
    moveWithObstacles(w, p, mx * spd * dt, my * spd * dt);

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

    // 传送门判定（第二十八轮）：放在移动的最后一步 ——
    // 位置已经过碰撞与边界裁剪，这时候再判「站在门上吗」最准
    tryPortal(w, p, dt);

    // 基础回血（当前为 0，预留）
    if (C.PLAYER.regenPerSec > 0) healPlayer(w, C.PLAYER.regenPerSec * dt);
  }

  // 传送门：踩上去瞬移到配对的那一端。
  //
  // 【为什么做成「踩上去就传」而不是「按 E 交互」】
  // 这是个自动战斗的割草游戏，没有交互键 —— 多一个按键就多一处要教玩家的事。
  // 站上去就传，规则一眼能懂，而且在被围住时它天然是一条逃生路线。
  //
  // 【为什么两端都要判】
  // 只判一端的话，从 B 门走进去就传不走（单向门），玩家会以为坏了。
  //
  // 【落点为什么偏 18px】
  // 正好落在对端圆心等于「一进去又被传回来」，两帧之内就能无限弹。
  // 偏移 + 冷却 1.4 秒，双保险。
  const PORTAL_TRIGGER_R = 30;
  const PORTAL_CD = 1.4;

  function portalBlocked(w, p, x, y) {
    const ox = p.x;
    const oy = p.y;
    p.x = x;
    p.y = y;
    const hit = hitsObstacle(w, p);
    p.x = ox;
    p.y = oy;
    return !!hit;
  }

  function tryPortal(w, p, dt) {
    if (p.portalCd > 0) {
      p.portalCd -= dt;
      return;
    }
    const list = w.portals;
    if (!list || !list.length) return;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      const dx = p.x - g.x;
      const dy = p.y - g.y;
      if (dx * dx + dy * dy > PORTAL_TRIGGER_R * PORTAL_TRIGGER_R) continue;
      const to = list[g.pair];
      if (!to || to === g) continue;
      // 落点：对端圆心往下偏 18px（避开圆心），撞墙就沿四个方向试，全撞就放弃这次传送
      const offsets = [[0, 18], [18, 0], [-18, 0], [0, -18]];
      let tx = to.x;
      let ty = to.y;
      let ok = false;
      for (let k = 0; k < offsets.length; k++) {
        const cx = clamp(to.x + offsets[k][0], p.r, w.map.w - p.r);
        const cy = clamp(to.y + offsets[k][1], p.r, w.map.h - p.r);
        if (portalBlocked(w, p, cx, cy)) continue;
        tx = cx;
        ty = cy;
        ok = true;
        break;
      }
      if (!ok) continue;
      p.x = tx;
      p.y = ty;
      p.portalCd = PORTAL_CD;
      // 表现：一圈冷灰扩散环，告诉玩家「这是传送，不是掉帧」
      w.effects.push({
        kind: 'ring', x: tx, y: ty, r: 46,
        life: 0.32, maxLife: 0.32, color: '#c8d2dc'
      });
      w.events.push({ type: 'portal', slot: p.slot, name: p.name, x: Math.round(tx), y: Math.round(ty) });
      return;
    }
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
  // 本局总结（第三十六轮）：结算页的「伤害构成」、图鉴与成就入账都读这份。
  //
  // 【为什么不塞进 getHud】HUD 是 20Hz 同步的，而这份数据一局只用一次；
  //   dmgBy / killsBy 加起来十几个键，跟着 HUD 每帧传纯属浪费带宽。
  //   单独一个函数，界面上「世界结束那一刻」取一次即可。
  //
  // 【字段说明】dmgList 已经按伤害降序排好 —— 模板里 v-for 直接画，
  //   不要把排序写进模板（Vue 模板里带参调用 computed 会白屏，项目踩过）。
  function runSummary(w, player) {
    const p = player || w.self || w.player;
    const weapons = [];
    let evolutions = 0;
    for (let i = 0; i < p.weapons.length; i++) {
      const def = C.WEAPON_MAP[p.weapons[i].id];
      const evolved = !!(def && def.evolved);
      if (evolved) evolutions += 1;
      weapons.push({ id: p.weapons[i].id, level: p.weapons[i].level, evolved: evolved });
    }

    const dmgBy = p.stats.dmgBy || {};
    const dmgList = [];
    const keys = Object.keys(dmgBy);
    for (let i = 0; i < keys.length; i++) {
      dmgList.push({ src: keys[i], dmg: Math.round(dmgBy[keys[i]]) });
    }
    dmgList.sort(function (a, b) { return b.dmg - a.dmg; });

    return {
      kills: p.stats.kills,
      gold: p.stats.gold,
      dmgDealt: Math.round(p.stats.dmgDealt),
      dmgList: dmgList,
      killsBy: p.stats.killsBy || {},
      challengers: p.stats.challengers || 0,
      level: p.level,
      wave: w.wave,
      time: Math.round(w.time),
      won: !!w.won,
      weapons: weapons,
      combos: (p.combos || []).length,
      evolutions: evolutions,
      shrineKinds: p.shrines ? Object.keys(p.shrines).length : 0,
      charId: p.charId,
      mapId: w.map ? w.map.id : '',
      campaign: !!w.storyStage,
      stageId: w.storyStage ? w.storyStage.id : ''
    };
  }

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

      // ---------- 赤月天象（第三十九轮）----------
      // ★放在世界级而不是个人级：天色是**所有人共同**的，联机时四个人同进同出。
      // on 用 0/1 而不是布尔：快照/存档里数字比布尔稳（两端真值语义一致）。
      // left 给界面显示「还剩 N 秒」——界面自己算要重新推一遍排期公式，
      // 两处公式迟早会不一致（地图名/关卡名就踩过「同一份内容两份副本」）。
      moon: w.moonOn ? 1 : 0,
      moonLeft: Math.max(0, Math.round((w.moonLeft || 0) * 10) / 10),

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
    // 本局总结：结算页的伤害构成 + 局外存档入账（见函数头注释）
    runSummary: runSummary,
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
    // ★导出词缀判定（第四十五轮）：要验「事件型精英一律不挂词缀」必须能直接问这一句，
    //   而不是「刷 100 只然后数有几只有词缀」（那是概率抽样，不是断言）。
    affixForSpawn: affixForSpawn,
    // ★导出「刷一波」：词缀（变异怪）是按波抽签的，测试要能直接推进到某一波、
    //   而不是「跑 120 秒等第 4 波自己来」—— 那种写法既慢又会因为中途升级/掉血
    //   引入无关变量。注意：它不推进时间，只负责按当前波次刷怪。
    spawnWave: spawnWave,
    // ★导出挑战者入口：测试要能「直接触发一次」而不必真的跑满 75 秒 ——
    //   跑满整段的写法在性能机上要几十秒，而且会顺带跑掉几十个波次，
    //   引入一堆与本条无关的变量（升级、掉血、额度顶满）。
    spawnChallenger: spawnChallenger,
    maybeSpawnChallenger: maybeSpawnChallenger,
    // ★导出赤月入口：测试要能在**精确的 tick** 上验「边沿只推一次事件」，
    //   靠 step 跑到 180 秒既慢（3600 帧）又会顺带跑掉一堆无关变量（升级、掉血、刷怪）。
    tickMoon: tickMoon,
    // ★导出陨星入口（第四十轮）：要验「落点必须挑最密处」「圈外玩家一滴血不掉」
    //   「天火不计连杀」，都得在精确的 tick 上手动触发一次 ——
    //   靠 step 跑到 210 秒既慢又会顺带跑掉一堆无关变量（升级、掉血、刷怪）。
    pickMeteorPoint: pickMeteorPoint,
    spawnMeteor: spawnMeteor,
    maybeSpawnMeteor: maybeSpawnMeteor,
    // ★导出山魈入口（第四十一轮）：要验「它不贴脸」「一生只召 8 只」「定身时不召唤」，
    //   靠 step 跑到 195 秒既慢又会顺带跑掉一堆无关变量（升级、掉血、刷怪）。
    //   tickSummoner 单独导出，是为了能构造「一只被定住的山魈」这种只存在于局部状态的场景。
    spawnSummoner: spawnSummoner,
    maybeSpawnSummoner: maybeSpawnSummoner,
    countAliveSummoners: countAliveSummoners,
    tickSummoner: tickSummoner,
    // ★导出地脉灵泉（第四十二轮）：要验「站不满 2 秒不爆」「离开就回落」
    //   「16 秒没充能就安静消失」「圈外一滴血都不掉」，都得在精确的帧上手动推进 ——
    //   靠 step 跑到 102 秒既慢又会顺带跑掉一堆无关变量（升级、掉血、刷怪）。
    pickLeyPoint: pickLeyPoint,
    spawnLey: spawnLey,
    maybeSpawnLey: maybeSpawnLey,
    updateLeys: updateLeys,
    countAliveLeys: countAliveLeys,
    // ---------- 血祭坛（第四十三轮）----------
    // 逐个导出：测试要能「只造一座祭坛」而不跑整局（跑整局会被波次、事件、
    // 自动升级面板一起搅进来，谁也说不清是哪一条让断言变红的）。
    maybeSpawnPact: maybeSpawnPact,
    spawnPact: spawnPact,
    applyPact: applyPact,
    // ---------- 双生妖（第四十五轮）----------
    // 逐个导出：要验「6 秒窗口差一帧不算」「同帧两只都倒必须撤掉倒计时」
    // 「复活的那只不许再复活」，都得在精确的 tick 上手动推进 ——
    // 靠 step 跑 228 秒既慢，又会顺带跑掉一堆无关变量（升级、掉血、刷怪）。
    maybeSpawnTwins: maybeSpawnTwins,
    spawnTwins: spawnTwins,
    onTwinKilled: onTwinKilled,
    updateTwins: updateTwins,
    countAliveTwins: countAliveTwins,
    countAlivePacts: countAlivePacts,
    // ★导出造掉落物：赤月的「经验 ×1.3」只能在「吃进去的那一刻」验，
    //   而靠打死怪掉球要连带跑武器/暴击/词缀，变量太多。直接造一颗指定价值的球最干净。
    spawnPickup: spawnPickup,
    // 局内商店（只在单机用，见 shopBuy 的注释）
    shopBuy: shopBuy,
    // ★导出范围文案拼装（第四十四轮）：要验「升级卡上真的写了范围变化」
    //   以及「卡片上的数字必须算上千里镜」，只能直接对这个函数断言 ——
    //   走「造经验球 → 升级 → 读 choices」这条路要连带跑拾取、加血、
    //   暂停世界三件事，变量多且慢，验的东西其实一样。
    rangeDeltaText: rangeDeltaText
  };
});
