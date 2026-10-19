// server/game/match.js —— 服务端权威对局（一个房间 = 一个 Match）
//
// 这是 P2 的心脏：**世界只在这一处推进**。
// 客户端以后只做两件事——上行「我想往哪走」，下行「把服务端算出来的世界画出来」。
// 之所以敢这么切，是因为 shared/sim.js 从头就是按「可以被服务端跑」写的：
// 纯固定步长、随机数走自带种子的 rngState、没有一丝 DOM 依赖。
//
// 与 sim.js 的对接面（只有这几个，别再自己发明）：
//   SIM.createWorld({ players, selfSlot, pauseAllOnLevelUp, reviveOnDeath, difficulty, seed, spawnRadius })
//   SIM.setSelf(w, null)           —— 服务端没有「自己」
//   SIM.step(w, inputsBySlot)      —— 推进 1/20 秒
//   SIM.getHud(w, 某玩家)          —— 取某个人的界面快照
//   SIM.takeEvents(w, 座位号)      —— 取「该玩家 + 全局」的事件，且不会误发给别人
//   SIM.chooseLevelUp(w, 下标, 玩家)
//   SIM.addPlayer / removePlayer   —— 中途加入 / 掉线离开
//
// 一个关键取舍：本文件**不认识网络**。
// 它只通过构造函数注入的 onSend(connId, obj) 往外发东西，
// 这样 tools/matchtest.js 可以完全不起服务器就把一整局跑完并断言结果。
//
// 【帧内顺序与单机版严格一致】sim.step 内部已经把顺序钉死了（见那边的注释），
// 服务端这边除了「每 50ms 调一次」之外不多做任何事，不额外遍历世界改状态，
// 否则压测基线与对局回放全部作废。

const SIM = require('../../shared/sim.js');
const C = require('../../shared/const.js');
const M = require('../../shared/maps.js');      // 地图表：本局打在哪张图上
// 【P2-5】二进制快照协议。它同时是「协议面」的唯一定义：
// 下面那批 F_* 白名单直接从它的字段表派生，两边不可能各写一份然后慢慢漂移。
const PB = require('../../shared/proto_bin.js');
const avatars = require('../../shared/avatars.js');   // 头像白名单：对局名单里要带上它
const config = require('../config');

// 一个逻辑步的毫秒数（20Hz -> 50ms）
const STEP_MS = 1000 / C.TICK_HZ;
// 单次驱动最多补几步。客户端那边是 5 步，服务端更保守取 3：
// 服务端一卡就是所有人的一卡，宁可丢掉欠账也不能让循环越补越久（补得越久卡得越狠）。
const MAX_CATCHUP_STEPS = 3;
// 单次 tick 允许的最大时间增量：定时器抖动 / 系统休眠会让它变成几秒，
// 不钳住的话一场对局会在一瞬间跑掉好几分钟，玩家看到的是「怪瞬移 + 突然通关」。
const MAX_DT_MS = 250;

// 「人走光后世界还留着」的宽限期（毫秒）。
// 取值要同时满足两件事：够本地页面跳转（实测 < 1 秒）与偶发重连，又不至于
// 让一堆 0 人的僵尸世界一直挂在内存里。config.matchKeepSec 默认 60 秒。
const KEEP_MS = Math.max(5, config.matchKeepSec) * 1000;

// 断线后「进度能续上」的时间窗（毫秒）。取挂起宽限期的 2 倍：
// 一次网络抖动、一次页面刷新、甚至手机切个后台回来，都该还能接着打；
// 再久就不留了 —— 留着的是别人的旧进度，白白占内存。
const KEEP_LEFT_MS = KEEP_MS * 2;

// ============================================================
// 数值压缩
// ============================================================

// 位置/角度保留 1 位小数就够：屏幕上 0.1px 的差别看不出来，
// 但 JSON 里 "1234.5678901234" 从 15 个字符降到 "1234.6" 6 个字符。
// 1200 只怪 × 4 个坐标字段，这一项就能省掉一半的包体。
function r1(v) {
  return typeof v === 'number' ? Math.round(v * 10) / 10 : v;
}
function r2(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : v;
}

// ============================================================
// 快照字段白名单
// ============================================================
// 为什么用白名单而不是直接把实体 JSON 化：
//   1. 实体上挂着 owner（指向玩家对象的反向引用）、def（怪物定义，十几个字段）、
//      hitIds（本弹已命中的怪 id 集合）这类东西。直接 JSON 化要么死循环，要么包体爆炸；
//   2. 白名单是「协议」的一部分 —— 它现在由 shared/proto_bin.js 的 SCHEMA **派生**：
//      加字段只改那一个文件，这里立刻跟上，二进制编解码器也同步认得它。
// 只发 defId 不发 def：客户端本来就有 shared/const.js，MOB_MAP[defId] 自己查得出来。

const F_MOB    = PB.F_MOB;
const F_PROJ   = PB.F_PROJ;
const F_ZONE   = PB.F_ZONE;
const F_STRIKE = PB.F_STRIKE;
const F_ORBIT  = PB.F_ORBIT;
const F_SHOT   = PB.F_SHOT;
const F_PICKUP = PB.F_PICKUP;
const F_FX     = PB.F_FX;

// ============================================================
// 视野裁剪
// ============================================================
// 两个概念别混：
//   **半径盒**：以玩家为心的正方形（半边长 = 半径）。只在「客户端还没上报视口」时兜底，
//              以及测试里直接指定半径时用。
//   **视野框**：按客户端视口算出来的相机矩形，再往外放宽 viewPad。
//              正常对局走这条 —— 形状和相机一致，贴地图边界也不会漏。
// box 为 null 表示不裁剪（config.viewRadius = 0 的调试开关）。

function clampNum(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// 把「客户端报上来的数」变成安全的有限数：只认真数字，其余一律当 0。
//
// 为什么 `Number(v) || 0` 不够（两个都是真踩过/推演过的坑）：
//   ① `Number(Infinity)` 是**真值**，会原样透过去；Infinity 在后续归一化
//      （x / 模长）时会变成 NaN。NaN 一旦流进世界，clamp 拦不住（clamp(NaN) === NaN），
//      位置会永久损坏，连追他的怪也一起变 NaN。
//   ② `Number(true)` === 1、`Number("1")` === 1 —— 布尔和数字串会**悄悄当作位移输入**。
//      输入向量是内部协议，客户端只会发数字；接受这些形状只会让「这包到底是谁发的、
//      想干什么」变得含糊。所以这里严格只收 number。
function finiteOrZero(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v : 0;
}

function radiusBox(p, r) {
  if (!(r > 0)) return null;
  return { x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r };
}

// 复刻客户端的相机取景（render.js 的 drawCamera）：
// 目标是「玩家居中」，然后钳到地图范围内。相机还有一段平滑滞后（k=0.22），
// 那部分误差由 config.viewPad 兜住，不在这里模拟。
function viewBoxForPlayer(p, w, h, pad) {
  const camX = clampNum(p.x - w / 2, 0, Math.max(0, C.MAP.width - w));
  const camY = clampNum(p.y - h / 2, 0, Math.max(0, C.MAP.height - h));
  return { x0: camX - pad, y0: camY - pad, x1: camX + w + pad, y1: camY + h + pad };
}

function inBox(box, e) {
  return e.x >= box.x0 && e.x <= box.x1 && e.y >= box.y0 && e.y <= box.y1;
}

// 按白名单把实体数组压成可传输的纯对象数组。
// box 为 null 或省略时不裁剪（整张地图的实体都发）。
function packList(list, fields, box) {
  const out = [];

  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (box && !inBox(box, e)) continue;

    const o = {};
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      const v = e[f];
      if (v === undefined) continue;
      // 数字统一压两位，其余（字符串 kind/color、布尔 alive）原样带。
      // 注意：二进制编码还会再量化一次（坐标 ×4、计时 ×100），
      // 这里压两位只是让 JSON 回退路径与日志好看，不是最终精度。
      o[f] = typeof v === 'number' ? r2(v) : v;
    }
    out.push(o);
  }
  return out;
}

// 玩家单独打包：字段比怪物多，而且要从 attrs 里拎一个值出来。
// 【刻意不发昵称】昵称属于「名单」而不是「每帧状态」：开局那包 game_start
// （proto.rosterPayload）已经带过全量名单了，客户端显示队友名字读那份即可。
// 每帧再发一遍的话，中文昵称只能走字符串长格式，4 人 20Hz 就是 0.6 KB/s 白烧。
function packPlayers(list) {
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    out.push({
      id: p.id,
      slot: p.slot,
      charId: p.charId,
      x: r1(p.x),
      y: r1(p.y),
      px: r1(p.px),
      py: r1(p.py),
      facing: r2(p.facing),
      hp: Math.round(p.hp),
      maxHp: p.maxHp,
      r: p.r,
      alive: p.alive,
      level: p.level,
      invuln: r2(p.invuln),
      // 渲染层要画拾取范围提示圈。attrs 整包太大不发，只拎出这一个值。
      pickupRadius: p.attrs ? Math.round(p.attrs.pickupRadius) : 0
    });
  }
  return out;
}

// ============================================================
// Match
// ============================================================

// room   ：server/rooms/manager.js 里的房间对象（只用来读出开局那批成员）
// opts   ：{ seed, spawnRadius, onSend }
function Match(room, opts) {
  opts = opts || {};

  this.code = room.code;
  this.hostConnId = room.hostConnId;
  this.seed = (opts.seed || (Date.now() & 0x7fffffff)) >>> 0;
  this.spawnRadius = opts.spawnRadius || config.spawnRadiusDefault;
  // 难度：以房间上的为准（房主选的）。这里再归一化一次是防御性的 ——
  // match 也允许被测试直接 new 出来（matchtest 就是这么用的），
  // 那时传进来的可能是任何东西，甚至没传。
  this.difficulty = C.normalizeDiffId(opts.difficulty || (room && room.difficulty));
  // 地图：与难度同一套来源规则 —— 优先 opts（测试可直接 new 出来），
  // 其次取房间上的（房主在候场室选的）。存 id，定义在 shared/maps.js。
  // 非法 id 由 mapById 回落默认图，不会让一局建不起来。
  this.mapId = M.mapById(opts.mapId || (room && room.mapId)).id;

  this.state = 'playing';              // playing / ended
  this.startedAt = Date.now();
  this.endedAt = 0;
  this.reason = '';                    // won（时间到通关） / empty（人走光了） / aborted

  // connId <-> slot 的双向映射。座位号是给 sim 用的（它按 slot 索引输入表），
  // connId 是给网络层用的。两边都要能互相查，所以维护两张表。
  this.slots = Object.create(null);      // connId -> slot
  this.connBySlot = Object.create(null); // slot -> connId
  this.players = Object.create(null);    // slot -> 玩家对象（sim 里那个）
  // connId -> 头像 id。为什么不挂在 sim 的玩家对象上：头像纯属「界面身份」，
  // sim 世界不需要认识它（世界里已经有 slot 区分实体了）。对局名单下发时从这里取。
  this.avatarByConn = Object.create(null);
  this.playerCount = 0;

  this.inputs = Object.create(null);     // connId -> { mx, my, seq }
  this.upgradeAt = Object.create(null);  // connId -> 进入升级面板的时间戳（超时兜底用）

  // 观战者：connId -> { followSlot, joinedAt }
  //
  // 【为什么不放进 slots】slots 是 sim 世界的索引表。观战者不是这一局的参与者：
  // 放进 slots 会被当成一个没有实体的玩家，快照/HUD 取他时拿到 undefined，
  // 而且人数统计、世界推进、结算都会把它算进去 —— 「看的人」变成「打的人」。
  // 所以单独一张表，只参与「发包」这一件事。
  this.spectators = Object.create(null);

  // 断线席位保留：身份键 -> { slot, at, prog }
  //
  // 【为什么必须有】客户端现在会自动重连（public/js/game.js）。而断线处理原本是
  // 「立刻把人从世界里摘掉」，重连回来就是一个 1 级新号 —— 那样「自动重连」反而
  // 变成了静默清档，比不重连更糟：玩家不会注意到自己等级掉了。
  // 所以断线时先把进度记在这里，同一个身份在一段时间内回来就原地续上。
  // 只在内存里、且只在**对局还活着**时有用（服务端重启后这一局本来也就没了）。
  this.left = Object.create(null);

  // slot -> userId（账号 id，游客为 null）。**只增不删**，`removeMember` 也不清它。
  // 为什么：结算时要给「中途退出的人」也记一笔战绩，而那时他的实体早就从
  // this.players 里删掉了 —— 只有这张表还记得那个座位坐的是谁。
  // 座位被新玩家复用时会被覆盖，这是可接受的（要求「有人退出的同时又有新人
  // 加到同一个座位」，且只影响那一行的归属）。
  this.userIdBySlot = Object.create(null);
  // connId -> true：本次重连是否命中席位保留（协议层据此在 game_start 里带上标记，
  // 前端弹一句「已恢复上次进度」，免得玩家以为系统给自己换了个号）
  this.resumedConn = Object.create(null);

  this.world = null;
  this.result = null;

  // 时间累加器：定时器不会精确地 50ms 一跳，攒够一步才走一步，
  // 这样长时间跑下来逻辑帧数与真实时间不会漂。
  this.carryMs = 0;

  this.lastSnapAt = 0;
  this.lastHudAt = 0;
  this.snapSeq = 0;

  // 【P2-5】二进制快照的关键帧记账。
  //   keyAt      ：哪些连接需要「下一帧必带 px/py」——新加入 / 重连的人手上还没有
  //                上一帧可以重建，给他一帧完整的，插值从第一帧就是准的。
  //   snapFrames ：已经下发过多少轮快照，用来实现「每 N 帧插一个关键帧」。
  this.keyAt = Object.create(null);
  this.snapFrames = 0;

  // 【P2-5】按人裁剪用的视口尺寸（见 setViewport 的注释）。
  this.viewByConn = Object.create(null);

  // 性能与带宽观测：P2-5 做二进制 + 差量时要有个基线来对比，现在就记上
  this.stat = {
    steps: 0,
    tickMsTotal: 0,
    tickMsMax: 0,
    snapBytes: 0,
    snapCount: 0,
    snapBytesMax: 0
  };

  // 网络出口（由协议层注入）。测试里替换成收集器即可。
  this.onSend = opts.onSend || function () { return 0; };
  // 结束回调（由注册表注入，用于把房间状态同步回去）
  this.onEnd = opts.onEnd || null;

  this.build(opts);
}

// 建世界：把房间成员一次性变成 sim 里的玩家
Match.prototype.build = function (opts) {
  const members = (opts.members || []).slice();
  members.sort(function (a, b) { return a.slot - b.slot; });

  const players = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    players.push({
      connId: m.connId,
      charId: m.charId,
      name: m.nickname,
      isGuest: m.isGuest,
      slot: m.slot,
      // 账号 id（游客为 null）。sim 本身不用它，是结算落库时用来认人的：
      // 「这一行战绩该记到哪个账号头上」只能靠它，昵称是会重复的。
      userId: m.userId
    });
    this.userIdBySlot[m.slot] = m.userId || null;
  }

  this.world = SIM.createWorld({
    players: players,
    // 服务端没有「自己」。这里传 0 只是为了让 createWorld 走完流程，
    // 紧接着就用 setSelf(w, null) 抹掉 —— 显式表达「本端无我」，
    // 免得以后有人在服务端代码里顺手读 w.self 读出一个客户端视角的值。
    selfSlot: 0,
    // 【必须显式关掉】单机是「弹出升级面板就冻结整个世界」，
    // 联机要是沿用这个，一个人去倒杯水就能把一屋子人全卡住。
    pauseAllOnLevelUp: false,
    // 【必须显式打开】阵亡 5 秒后原地复活。
    // 理由：多人局里一个人倒下之后，世界不会为他停下来，他也没有任何可操作的东西 ——
    // 只能干看着或者退出。复活让「阵亡」变成一次代价（掉一半血、丢 5 秒节奏），
    // 而不是把这个人从这一局里直接摘掉。
    // 单机不传这个开关（默认 false）：那边的死亡仍然是这一局的结局。
    reviveOnDeath: true,
    // 难度：本局时长、怪的血量/数量/伤害都从这里来（见 const.js 的 DIFFICULTIES）
    difficulty: this.difficulty,
    // 地图：本局战场（尺寸 + 地形 + 刷怪环），见 shared/maps.js。
    // 障碍由 sim 在建世界时按「mapId + 固定种子」算出来 —— 不进快照，
    // 客户端用同一个 mapId 各自算，两边必然一致。
    mapId: this.mapId,
    seed: this.seed,
    spawnRadius: this.spawnRadius
  });
  SIM.setSelf(this.world, null);

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const p = this.world.players[i];
    this.slots[m.connId] = m.slot;
    this.connBySlot[m.slot] = m.connId;
    this.players[m.slot] = p;
    this.avatarByConn[m.connId] = avatars.isValid(m.avatar) ? m.avatar : avatars.pickFor(m.slot);
    this.playerCount += 1;
    // 开局头一帧给他们关键帧：客户端此时手上没有上一帧，拿到完整坐标才能
    // 从第一帧就正确插值（否则那一帧所有 px=x，插值退化成「不插值」）。
    this.keyAt[m.connId] = true;
  }
};

// 开局时通知所有成员（由协议层调用，走 onSend）
//
// 【观战者也发】房里有人进出是**所有在场者**都该知道的事 ——
// 观战者看到「有人走了」才知道战况有变。漏掉的话他在观战室里会一直
// 看着一个已经不在的人的名单变来变去，却没有任何提示。
Match.prototype.broadcast = function (obj) {
  const ids = Object.keys(this.slots);
  for (let i = 0; i < ids.length; i++) this.onSend(ids[i], obj);
  // 观战者也发，但「有人开始/结束观战」这种给自己的通知就别回发了 ——
  // 自己刚进来就收到「观众C 加入了观战」，纯属浪费一帧。
  if (obj.noEchoToSpectators) return;
  const sids = Object.keys(this.spectators);
  for (let i = 0; i < sids.length; i++) {
    this.onSend(sids[i], { t: obj.t, list: obj.list, spectating: true });
  }
};

// ============================================================
// 观战
// ============================================================
//
// 观战者只看不动：不占座位、不进世界、不影响任何一帧模拟。
// 服务端只做一件事 —— 把「他跟随的那个玩家」的世界照常裁剪后发给他。
//
// 【为什么不给观战者单独的世界视野】他要看的就是战场本身。
// 以被跟随者为中心裁剪，跟他眼睛看到的一模一样，客户端零额外处理。
Match.prototype.addSpectator = function (connId, followSlot) {
  if (this.state !== 'playing') return null;
  if (this.slots[connId] !== undefined) return null;      // 已经在打，不该同时观战
  if (this.spectators[connId]) return this.spectators[connId];  // 重复加入

  // 跟随目标：优先玩家指定的座位，否则随便挑一个还活着的人
  let slot = Number(followSlot);
  if (!(this.players[slot] && this.players[slot].state !== 'dead')) {
    slot = this.anyLivingSlot();
  }
  if (slot < 0) return null;                              // 一屋子人都倒了，没什么可看

  this.spectators[connId] = { followSlot: slot, joinedAt: Date.now() };
  this.keyAt[connId] = true;                              // 第一帧给关键帧（理由同正式玩家）
  return this.spectators[connId];
};

// 找一个还活着的人的座位。观战者没指定、或指定的人已经倒了时的兜底。
Match.prototype.anyLivingSlot = function () {
  for (let i = 0; i < this.world.players.length; i++) {
    if (this.players[i] && this.players[i].state !== 'dead') return i;
  }
  return -1;
};

Match.prototype.removeSpectator = function (connId) {
  const s = this.spectators[connId];
  if (!s) return null;
  delete this.spectators[connId];
  delete this.keyAt[connId];
  return s;
};

// 切换跟随目标。指定的座位没人（或人倒了）就保持原来的，不乱跳 ——
// 观战者点一下没反应会以为界面卡住了。
Match.prototype.spectateFollow = function (connId, slot) {
  const s = this.spectators[connId];
  if (!s) return null;
  const n = Number(slot);
  if (!(this.players[n] && this.players[n].state !== 'dead')) return s;
  s.followSlot = n;
  return s;
};

Match.prototype.spectatorOf = function (connId) {
  return this.spectators[connId] || null;
};

Match.prototype.spectatorCount = function () {
  return Object.keys(this.spectators).length;
};

// 被跟随的人走了/倒了：观战者自动切到下一个还活着的人。
// 【为什么必须自动切】不切的话他会被钉在一具不动的尸体上，
// 画面完全静止、连时间都不走 —— 那不是观战，那是卡屏。
Match.prototype.reflowSpectators = function (deadSlot) {
  const ids = Object.keys(this.spectators);
  if (!ids.length) return;
  const fallback = this.anyLivingSlot();
  for (let i = 0; i < ids.length; i++) {
    const s = this.spectators[ids[i]];
    if (!s || s.followSlot !== deadSlot) continue;
    if (fallback >= 0 && fallback !== deadSlot) {
      s.followSlot = fallback;
      this.keyAt[ids[i]] = true;      // 换了视角，客户端手上那份增量作废，给个关键帧
    }
  }
};

// 开局通告：客户端拿到它才知道自己是哪个座位、有哪些队友、种子是多少
Match.prototype.rosterPayload = function () {
  const list = [];
  const ids = Object.keys(this.slots);
  for (let i = 0; i < ids.length; i++) {
    const connId = ids[i];
    const slot = this.slots[connId];
    const p = this.players[slot];
    if (!p) continue;
    list.push({
      slot: slot,
      name: p.name,
      avatar: this.avatarByConn[connId] || '',
      charId: p.charId,
      isGuest: p.isGuest,
      connId: connId
    });
  }
  list.sort(function (a, b) { return a.slot - b.slot; });
  return list;
};

// 名单变了就广播一份最新名单。
// 【为什么必须有它】客户端手里的队友名单只有两个来源：开局那包 game_start、
// 以及这条 roster 消息。而多人从大厅页跳进游戏页时，各人的重连有先后 ——
// 先回来的人收到的 game_start 里可能**只有他自己**（那时队友还没回连），
// 之后队友回来了，服务端却只广播了一条 ally_join 事件，名单再没更新过。
// 症状就是：队友人画出来了，头顶名牌却是空的（名字查不到）。
// 名单对所有人一致，所以直接群发 —— 不像 game_start 那样要逐人下发 selfSlot。
Match.prototype.broadcastRoster = function () {
  if (this.playerCount <= 0) return;      // 人走光了没必要发（对局也快收尾了）
  this.broadcast({ t: 'roster', list: this.rosterPayload() });
};

// ============================================================
// 成员进出
// ============================================================

// 中途加入：房间还在等待时是 manager 的事；这里处理的是「已经开局了才进来」。
// 注意不重排座位号 —— 座位号是网络协议里的玩家标识，重排会让客户端把 A 认成 B。
Match.prototype.addMember = function (connId, info) {
  // 【先设视口，再判重】——重发 room_join 时（比如窗口在窄屏与宽屏之间切换）
  // 人已经在局里了，直接 return 会把新的视口丢掉，于是裁剪范围永远停在第一次那个值。
  if (info) this.setViewport(connId, info.viewW, info.viewH);

  if (this.slots[connId] !== undefined) return this.players[this.slots[connId]];

  // 有人回来了（多半是页面跳转后的重连）：取消挂起，世界接着往下跑。
  // 注意世界时间轴是不回退的 —— 挂起期间它压根没走，所以续上就是「刚好接住」。
  if (this.suspendAt) this.resume();

  // 先看是不是「刚掉线的那个人回来了」：命中就把进度原地接上（见 this.left 的注释）
  const saved = this.takeSaved(info);

  // 座位优先用他原来那个：队友屏幕上那个实体的编号不变，客户端也不用重新认人。
  // 被占用了（他掉线这段时间座位给了别人）才退到空位。
  let slot = saved ? saved.slot : info.slot;
  if (slot === undefined || slot === null || this.connBySlot[slot] !== undefined) {
    slot = this.pickFreeSlot();
  }

  const p = SIM.addPlayer(this.world, {
    slot: slot,
    connId: connId,
    charId: info.charId,
    name: info.nickname,
    isGuest: info.isGuest,
    userId: info.userId
  });

  this.slots[connId] = slot;
  this.connBySlot[slot] = connId;
  this.players[slot] = p;
  this.userIdBySlot[slot] = info.userId || null;
  this.avatarByConn[connId] = avatars.isValid(info.avatar) ? info.avatar : avatars.pickFor(slot);
  this.playerCount += 1;
  // 中途加入的人手上没有上一帧，下一帧给他关键帧（见 broadcastState）
  this.keyAt[connId] = true;

  if (saved) {
    this.restoreProgress(p, saved);
    // 给协议层留个标记，好在 game_start 里告诉客户端「你的进度接回来了」
    this.resumedConn[connId] = true;
  }
  return p;
};

// 取走（并消费）某个身份留下的进度。
// 过期的一并删掉：留着一份半小时前的旧进度，等人家回来时突然变成那个等级，
// 比不恢复更让人困惑。
Match.prototype.takeSaved = function (info) {
  const key = identityKey(info);
  if (!key) return null;
  const saved = this.left[key];
  if (!saved) return null;
  delete this.left[key];
  if (Date.now() - saved.at > KEEP_LEFT_MS) return null;
  return saved;
};

// 把断线前那份进度写回新人身上。
Match.prototype.restoreProgress = function (p, saved) {
  const g = saved.prog;

  p.level = g.level;
  p.exp = g.exp;
  p.expNext = g.expNext;
  p.deaths = g.deaths || 0;
  p.stats.kills = g.stats.kills;
  p.stats.dmgDealt = g.stats.dmgDealt;
  p.stats.gold = g.stats.gold;
  p.stats.healed = g.stats.healed;
  // 武器 / 被动 / 组合技只搬「档位」（id + 等级）：冷却计时和运行时状态（rt）重新开始。
  // 这不亏 —— 他断线的这段时间武器本来也没在开火。
  p.weapons = g.weapons.map(function (x) { return { id: x.id, level: x.level, timer: 0, rt: {} }; });
  p.passives = g.passives.map(function (x) { return { id: x.id, level: x.level }; });
  // 组合技同样要接回来（老存档里没有这个字段，退回空数组）
  p.combos = (g.combos || []).map(function (x) {
    return { id: x.id, level: x.level, timer: 0, rt: {} };
  });

  // 重算属性前必须把上下文切到他身上：recalcAttrs 读的是 w.player（见那边的注释）。
  // 算完立刻切回 null —— 服务端没有「自己」，留着会让下一个读 w.player 的人拿到他的属性。
  SIM.setSelf(this.world, p);
  SIM.recalcAttrs(this.world);
  SIM.setSelf(this.world, null);

  p.alive = true;
  p.state = 'playing';
  if (g.alive === false) {
    // 掉线时人还躺着：按「复活」处理，而不是让他带着 0 血回来 ——
    // 反正 5 秒倒计时本来也会把他扶起来，这里直接给复活后的状态。
    p.hp = Math.max(1, Math.round(p.maxHp * C.PLAYER.reviveHpRatio));
  } else {
    p.hp = Math.max(1, Math.min(g.hp, p.maxHp));
  }
  // 回来的瞬间给一段无敌：世界在他掉线期间照常跑，怪可能正好压在他头上，
  // 不给这个窗口的话「重连成功」往往等于「一进来就被秒」。
  p.invuln = C.PLAYER.reviveInvulnSec;

  console.log('[match ' + this.code + '] 席位保留：接回 ' + g.name +
    '（' + g.level + ' 级 座位 ' + p.slot + ' 杀了 ' + g.stats.kills + '）');
};

// 对局中换头像。头像纯属界面身份（世界里已经用 slot 区分实体了），
// 所以改它不影响模拟，改完由协议层广播一次名单，所有人的队友名牌就刷新了。
// 非法 id 一律忽略，不做报错 —— 没必要为一个装饰属性打断玩家。
Match.prototype.setAvatar = function (connId, avatar) {
  if (this.slots[connId] === undefined) return false;
  if (!avatars.isValid(avatar)) return false;
  this.avatarByConn[connId] = avatar;
  return true;
};

Match.prototype.pickFreeSlot = function () {
  let slot = 0;
  while (this.connBySlot[slot] !== undefined) slot += 1;
  return slot;
};

// 离开：sim 那边会把他的归属实体一并清掉（不然他留下的圣水会变成没人认领的幽灵）
// 断线席位保留的身份键。
// 注册用户用 userId（唯一、不会撞）；游客没有 userId，只能用昵称。
// 游客同名确实会互相认成同一个人，但窗口只有两分钟、且用掉就删，
// 相对「所有游客都没法续上进度」来说这个取舍更划算。
function identityKey(info) {
  if (!info) return '';
  if (info.userId !== undefined && info.userId !== null && info.userId !== '') return 'u' + info.userId;
  const nick = String(info.nickname || '').trim();
  return nick ? 'g' + nick : '';
}

Match.prototype.removeMember = function (connId) {
  const slot = this.slots[connId];
  if (slot === undefined) return null;

  // 先把进度抄一份存起来（详见构造函数里 this.left 的注释）。
  // 【抄完必须把 left 里的旧记录清掉】否则同一个身份反复掉线会攒下一串快照，
  // 而且恢复时可能命中一条更老的 —— 只留最近这一次。
  const p = this.players[slot];
  if (p) {
    const key = identityKey({ userId: p.userId, nickname: p.name });
    if (key) {
      this.left[key] = {
        slot: slot,
        at: Date.now(),
        prog: {
          charId: p.charId,
          name: p.name,
          isGuest: p.isGuest,
          userId: p.userId,
          level: p.level,
          exp: p.exp,
          expNext: p.expNext,
          hp: p.hp,
          maxHp: p.maxHp,
          deaths: p.deaths || 0,
          alive: p.alive,
          state: p.state,
          stats: { kills: p.stats.kills, dmgDealt: p.stats.dmgDealt, gold: p.stats.gold, healed: p.stats.healed },
          // 武器/被动/组合技存深拷贝里的「档位」部分（id + 等级）：
          // 运行时状态（冷却计时 rt / timer）没必要留，重建时重新算即可。
          weapons: p.weapons.map(function (x) { return { id: x.id, level: x.level }; }),
          passives: p.passives.map(function (x) { return { id: x.id, level: x.level }; }),
          // 【组合技也必须存】它是玩家这一局自己凑出来的东西 ——
          // 断线重连后把它弄丢，比丢一件武器伤人得多（武器还能再抽，组合要重新凑两件）。
          // 这一条是本轮复查时才补上的：加组合技时只改了 sim 与前端，
          // 忘了「席位保留」这条路径也要带上它。
          combos: (p.combos || []).map(function (x) { return { id: x.id, level: x.level }; })
        }
      };
    }
  }

  delete this.slots[connId];
  delete this.connBySlot[slot];
  delete this.players[slot];
  delete this.avatarByConn[connId];
  delete this.inputs[connId];
  delete this.upgradeAt[connId];
  delete this.keyAt[connId];
  delete this.viewByConn[connId];
  delete this.resumedConn[connId];
  if (this.playerCount > 0) this.playerCount -= 1;

  // 正在看着他的人换个视角看（他走了/倒了）
  this.reflowSpectators(slot);

  return SIM.removePlayer(this.world, connId);
};

Match.prototype.slotOf = function (connId) {
  return this.slots[connId];
};

Match.prototype.playerOf = function (connId) {
  const slot = this.slots[connId];
  return slot === undefined ? null : (this.players[slot] || null);
};

Match.prototype.conns = function () {
  return Object.keys(this.slots);
};

// ============================================================
// 按人视野裁剪（P2-5 调优）
// ============================================================
// 裁剪范围决定「一帧里有多少实体」，也就直接决定带宽 —— 这是 P2-5 最有效的一个旋钮。
//
// 为什么改成按人设：裁剪范围本质上等于「我这块屏能画多大」，
// 而服务端不知道对面是 1366x768 还是 2560x1440。用一个全局值时，
// 要么小屏玩家白收一堆画不出来的实体，要么大屏玩家在屏幕角落里看到怪凭空出现。
// 所以由客户端在 room_join 时报自己的视口尺寸，服务端按人算视野框。
//
// 钳位的意义：这个值只影响「发给他多少」，改大改小都只坑他自己，
// 不构成作弊入口；但出现 NaN / 负数 / 荒唐值时还是得兜住，
// 否则范围变成 0 会让他「什么都看不见」，看起来像服务端坏了。
Match.prototype.setViewport = function (connId, w, h) {
  const nw = Number(w);
  const nh = Number(h);
  if (!isFinite(nw) || !isFinite(nh) || nw <= 0 || nh <= 0) return;   // 没报或报了垃圾值 → 保持兜底
  this.viewByConn[connId] = {
    w: clampNum(Math.round(nw), config.viewMinW, config.viewMaxW),
    h: clampNum(Math.round(nh), config.viewMinH, config.viewMaxH)
  };
};

// 某个连接这一次要用哪个视野框。p 是「他自己」——裁剪是以他为心算相机的。
Match.prototype.viewBoxFor = function (connId, p) {
  if (!(config.viewRadius > 0)) return null;          // 全局关裁剪（调试）
  const vp = this.viewByConn[connId];
  if (vp) return viewBoxForPlayer(p, vp.w, vp.h, config.viewPad);
  return radiusBox(p, config.viewRadius);             // 客户端还没上报时的兜底
};

// 服务端「实际会下发多大范围」的覆盖半径（px）。只用于 game_start 里报给客户端看，
// 以及测试断言 —— 取玩家到视野框最远角的距离上界。
Match.prototype.cullRadiusFor = function (connId) {
  if (!(config.viewRadius > 0)) return 0;
  const vp = this.viewByConn[connId];
  if (!vp) return config.viewRadius;
  return Math.round(Math.sqrt(vp.w * vp.w + vp.h * vp.h) / 2 + config.viewPad);
};

// 兼容旧名字（bintest 与 proto 早期版本用过）
Match.prototype.cullFor = function (connId) {
  return this.cullRadiusFor(connId);
};

// 视野范围的明细：让客户端/测试一眼看出「到底按视口算的框、还是兜底半径、还是关掉了」。
Match.prototype.viewInfoFor = function (connId) {
  if (!(config.viewRadius > 0)) return { mode: 'off' };
  const vp = this.viewByConn[connId];
  if (vp) return { mode: 'box', w: vp.w, h: vp.h, pad: config.viewPad };
  return { mode: 'radius', r: config.viewRadius };
};

// ============================================================
// 输入
// ============================================================

// 客户端上行：只记「最新意图」，不排队。
// 排队没意义 —— 移动是持续状态，玩家松手前一直在发，落后两帧的意图比最新意图更没用。
Match.prototype.setInput = function (connId, mx, my, seq) {
  if (this.slots[connId] === undefined) return false;

  // 方向向量钳到单位长度。客户端本来就归一化了，但服务端不能信客户端：
  // 不钳的话改个包就能跑出 100 倍速度，这是最典型的作弊入口。
  //
  // 【非有限数必须清零，不能只靠 `|| 0`】JSON 里没有 Infinity 字面量，但
  // `{"mx":1e999}` 是**合法 JSON**，JSON.parse 出来就是 Infinity。
  // 而 `Number(Infinity) || 0` === Infinity（真值），接着 `Infinity / Infinity`
  // 得到 NaN 存进输入表。NaN 目前**恰好**没造成破坏（下游 movePlayer 写的是
  // `input.mx ? input.mx : 0`，NaN 是 falsy 会被吃掉），但那是巧合不是设计：
  // 谁把它改成 `Number(input.mx) || 0` 那天，玩家坐标就会变 NaN ——
  // clamp(NaN) 还是 NaN → 人从世界里消失，追他的怪也一起变 NaN，
  // 而 NaN 去索引精灵图集会让**所有客户端每帧抛异常**。这一层现在就堵死。
  let x = finiteOrZero(mx);
  let y = finiteOrZero(my);
  const mag = Math.sqrt(x * x + y * y);
  if (mag > 1) {
    x /= mag;
    y /= mag;
  }

  this.inputs[connId] = { mx: x, my: y, seq: seq || 0 };
  return true;
};

// 把 connId 索引的输入表翻成 sim 要的「按座位号索引」
Match.prototype.buildInputTable = function () {
  const table = Object.create(null);
  const ids = Object.keys(this.inputs);
  for (let i = 0; i < ids.length; i++) {
    const connId = ids[i];
    const slot = this.slots[connId];
    if (slot === undefined) continue;   // 人已经走了，输入丢掉
    const v = this.inputs[connId];
    table[slot] = { mx: v.mx, my: v.my };
  }
  return table;
};

// 升级三选一。客户端传来的下标不可信，chooseLevelUp 内部会校验，
// 非法下标它自己返回 false（等于「取消」），这里原样把结果透出去。
Match.prototype.choose = function (connId, index) {
  const p = this.playerOf(connId);
  if (!p) return false;
  const ok = SIM.chooseLevelUp(this.world, Number(index) | 0, p);
  if (ok) delete this.upgradeAt[connId];
  return ok;
};

// ============================================================
// 推进
// ============================================================

// 由注册表的全局 20Hz 定时器驱动，dtMs 是「距上一次驱动过了多少毫秒」
Match.prototype.tick = function (dtMs) {
  if (this.state !== 'playing') return;

  // 挂起中：世界不推进。有人回来了就恢复；一直没人回来就超时收局，
  // 免得留下一个 0 人的僵尸世界永远挂在内存里空转。
  if (this.suspendAt) {
    if (this.playerCount > 0) {
      this.resume();
    } else if (Date.now() - this.suspendAt >= KEEP_MS) {
      this.finish('empty');
      return;
    } else {
      return;
    }
  }

  let dt = Number(dtMs) || 0;
  if (dt <= 0) dt = STEP_MS;
  if (dt > MAX_DT_MS) dt = MAX_DT_MS;

  this.carryMs += dt;

  let steps = 0;
  while (this.carryMs >= STEP_MS && steps < MAX_CATCHUP_STEPS) {
    this.stepOnce();
    this.carryMs -= STEP_MS;
    steps += 1;
    if (this.state !== 'playing') break;
  }
  // 补到上限说明这一轮严重滞后，欠账直接清掉：不追，追只会让卡顿滚雪球
  if (steps >= MAX_CATCHUP_STEPS) this.carryMs = 0;
};

// 精确推进一整帧。单独拆出来是为了：
//   1. 测试里可以不等定时器，直接连调 N 次验算结果；
//   2. 以后要做「定长回放」时，这就是唯一的帧入口。
Match.prototype.stepOnce = function () {
  const t0 = process.hrtime.bigint();

  SIM.step(this.world, this.buildInputTable());

  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  this.stat.steps += 1;
  this.stat.tickMsTotal += ms;
  if (ms > this.stat.tickMsMax) this.stat.tickMsMax = ms;

  // 升级超时兜底必须在事件推送之后再判：先让客户端有机会自己选，
  // 只有客户端一直不选才轮到这里代选。
  this.flushEvents();
  this.autoChoose();
  this.broadcastState();

  // 人走光了先挂起，不立刻收局。
  // 「房主点开始对局 → 全员从大厅页跳到游戏页」那一瞬间所有旧连接都会断，
  // 这里要是直接 finish，整局就死在跳转的半路上（真踩过）。
  if (this.playerCount <= 0) {
    this.suspend();
    return;
  }
  if (this.world.won) this.finish('won');
};

// ============================================================
// 挂起 / 恢复
// ============================================================

// 挂起：世界停止推进，但世界对象、座位映射、随机数状态全部原样留着，
// 有人回来就能原地续上。之所以不直接 finish，是因为 finish 之后 registry
// 会把这个 match 从表里摘掉，重连的人就再也找不回这一局了。
Match.prototype.suspend = function () {
  if (this.suspendAt) return;
  this.suspendAt = Date.now();
  console.log('[match] 挂起 code=' + this.code + ' 等待重连 ' + Math.round(KEEP_MS / 1000) + 's');
};

Match.prototype.resume = function () {
  if (!this.suspendAt) return;
  const sec = ((Date.now() - this.suspendAt) / 1000).toFixed(1);
  this.suspendAt = 0;
  // 挂起期间世界没推进（时间轴是连续的），但定时器那边的欠账必须清掉，
  // 否则恢复后的第一帧会一口气补好几步，玩家看到的是「怪物集体瞬移」。
  this.carryMs = 0;
  console.log('[match] 恢复 code=' + this.code + ' 挂起了 ' + sec + 's');
};

// 事件分发。
//
// 【这里有个坑，踩过】不能按人循环调用 SIM.takeEvents(w, 座位号)：
// 那个函数的语义是「取走全局事件 + 我的事件」，而全局事件取完就从队列里没了，
// 于是「第 5 波来袭」「血月领主降临」「通关」这些只推给了第一个来取的人，
// 其余玩家永远收不到 —— 表现就是「房主能看到波次提示，队友看不到」。
//
// 正确做法：一次性把队列取空，在服务端按座位分好，全局事件人手复制一份。
Match.prototype.flushEvents = function () {
  if (!this.world.events.length) return;

  const all = SIM.takeEvents(this.world);

  const globals = [];
  const bySlot = Object.create(null);
  for (let i = 0; i < all.length; i++) {
    const e = all[i];
    if (e.slot === undefined || e.slot === null) globals.push(e);
    else (bySlot[e.slot] || (bySlot[e.slot] = [])).push(e);
  }

  const ids = Object.keys(this.slots);
  for (let i = 0; i < ids.length; i++) {
    const connId = ids[i];
    const slot = this.slots[connId];
    const own = bySlot[slot];
    // concat 会生成新数组：绝不能把同一个数组对象交给多个收件人，
    // 万一以后有人在收件方就地改它，所有人会一起被改。
    const list = own ? globals.concat(own) : globals.concat();
    if (!list.length) continue;

    // 升级面板弹出时开始计时（用于超时兜底）
    for (let k = 0; k < list.length; k++) {
      if (list[k].type === 'levelup' && this.upgradeAt[connId] === undefined) {
        this.upgradeAt[connId] = Date.now();
      }
    }
    this.onSend(connId, { t: 'ev', list: list });
  }

  // 观战者也收全局事件：「第 5 波来袭」「血月领主降临」「掉了个宝箱」这些
  // 是这一局的过程，观战者看的正是这个过程。
  //
  // 【为什么只给 globals 不给他那个座位的】他的 selfSlot 是 -1，
  // 给他按座位分的事件等于把别人的「你升级了 / 你被打了」推到他脸上。
  // 而且观战者的 upgradeAt 不会被计时（autoChoose 只遍历 slots），所以他不会
  // 停在升级面板上，也就永远不会超时代选 —— 两边是自洽的。
  if (globals.length) {
    const specIds = Object.keys(this.spectators);
    for (let i = 0; i < specIds.length; i++) {
      // 每个观战者一份新的数组：绝不能把同一个数组对象交给多个收件人
      this.onSend(specIds[i], { t: 'ev', list: globals.concat(), spectating: true });
    }
  }

  // 落在「已经没有连接」的座位上的事件直接丢掉。
  // 不能留着 —— 座位号会被复用（见 pickFreeSlot），
  // 留着的话下一个坐这个位置的人会收到上一个人的「你升级了 / 你阵亡了」。
};

// 升级面板超时兜底。
// 为什么必须要：联机里「正在选升级的人 = 定格 + 无敌」（见 sim 的 damagePlayer）。
// 没有这个兜底，玩家只要停在面板上就永远不会死 —— 这已经不算漏洞，算外挂。
Match.prototype.autoChoose = function () {
  const limitSec = config.upgradeTimeoutSec;
  if (!(limitSec > 0)) return;

  const now = Date.now();
  const ids = Object.keys(this.slots);

  for (let i = 0; i < ids.length; i++) {
    const connId = ids[i];
    const p = this.players[this.slots[connId]];
    if (!p) continue;

    if (p.state !== 'levelup') {
      delete this.upgradeAt[connId];
      continue;
    }
    if (this.upgradeAt[connId] === undefined) {
      this.upgradeAt[connId] = now;
      continue;
    }
    if (now - this.upgradeAt[connId] < limitSec * 1000) continue;

    // 代选第一项。第一项是 sim 按权重抽出来的，代选它比「随便给一个」合理。
    SIM.chooseLevelUp(this.world, 0, p);
    delete this.upgradeAt[connId];
    console.log('[match ' + this.code + '] 升级面板超时，已代选：slot=' + p.slot + ' 昵称=' + p.name);
    this.onSend(connId, { t: 'ev', list: [{ type: 'auto_choose', slot: p.slot }] });
  }
};

// 按频率节流下发快照与 HUD。
// 快照是带宽大头，HUD 很便宜；两者分开限频，可以只降快照不降 HUD 的手感。
Match.prototype.broadcastState = function (now) {
  now = now || Date.now();

  const snapInterval = 1000 / Math.max(1, config.snapshotHz);
  const hudInterval = 1000 / Math.max(1, config.hudHz);

  const doSnap = now - this.lastSnapAt >= snapInterval;
  const doHud = now - this.lastHudAt >= hudInterval;
  if (!doSnap && !doHud) return;
  if (doSnap) this.lastSnapAt = now;
  if (doHud) this.lastHudAt = now;

  const binMode = config.binSnap !== false;
  // 省 px/py 的前提是「相邻两帧正好差一个 tick」，也就是快照频率 == 逻辑帧率。
  // 一旦有人把 snapshotHz 调低（省带宽的常规手段），这个前提就没了 ——
  // 那时必须自动退回「老实路径」带上绝对坐标，正确性优先于省那几个字节。
  const omitPrev = binMode && config.snapshotHz >= C.TICK_HZ;
  if (doSnap) this.snapFrames += 1;

  const ids = Object.keys(this.slots);
  for (let i = 0; i < ids.length; i++) {
    const connId = ids[i];
    const p = this.players[this.slots[connId]];
    if (!p) continue;

    if (doSnap) {
      const snap = this.snapshotFor(p, this.viewBoxFor(connId, p));
      snap.t = 'snap';
      // seq 只给 JSON 路径用（二进制帧里有 tick，本身就单调可判序，不必再占字节）
      snap.seq = ++this.snapSeq;

      let bytes = 0;
      if (binMode) {
        const every = config.keyFrameEveryFrames | 0;
        const needKey = this.keyAt[connId] === true || (every > 0 && this.snapFrames % every === 1);
        delete this.keyAt[connId];
        bytes = this.onSend(connId, PB.encode(snap, { key: needKey, omitPrev: omitPrev }));
      } else {
        bytes = this.onSend(connId, snap);
      }

      // 带宽观测：onSend 返回发出的字节数（二进制路径返回的是真实字节数）
      this.stat.snapBytes += bytes || 0;
      this.stat.snapCount += 1;
      if ((bytes || 0) > this.stat.snapBytesMax) this.stat.snapBytesMax = bytes || 0;
    }

    if (doHud) {
      const h = SIM.getHud(this.world, p);
      h.t = 'hud';
      this.onSend(connId, h);
    }
  }

  // 观战者：世界照跑，只是「相机」借给某个玩家。
  // 走的是同一套裁剪与编码，客户端那边几乎不用为观战写任何特例。
  this.sendToSpectators(binMode, omitPrev, doSnap, doHud);
};

// 观战者的快照 / HUD 下发。
// 单独一个函数而不是塞进上面那个循环：那里的 connId 一律对应 slots 里的座位，
// 观战者没有座位，混进去会让「取 p」这一步开始到处判空 ——
// 而判空一旦漏一处，就变成「观战者看到的世界突然不推进了」这种极难查的问题。
Match.prototype.sendToSpectators = function (binMode, omitPrev, doSnap, doHud) {
  const ids = Object.keys(this.spectators);
  if (!ids.length) return;

  for (let i = 0; i < ids.length; i++) {
    const connId = ids[i];
    const s = this.spectators[connId];
    if (!s) continue;
    const p = this.players[s.followSlot];
    if (!p) {
      // 跟随目标没了（理论上 reflowSpectators 已经处理过，这里是最后一道兜底）
      const fb = this.anyLivingSlot();
      if (fb < 0) continue;
      s.followSlot = fb;
      this.keyAt[connId] = true;
    }
    const cam = this.players[s.followSlot];
    if (!cam) continue;

    if (doSnap) {
      const snap = this.snapshotFor(cam, this.viewBoxFor(connId, cam));
      snap.t = 'snap';
      snap.seq = ++this.snapSeq;
      // spectating 标记让客户端知道「这一份是观战视角」：
      // 自己的血条/经验要隐藏，操作输入要彻底不发。
      // 【followSlot 不进这里】它只由 game_start 与 spectate_follow 单独通知 ——
      // 帧头是固定布局（flags + 三个数字），塞一个座位号就要重排所有帧的字节。
      // 而且视角切换是低频事件，没必要每帧都带（每帧 1 字节，一局就是好几 MB）。
      snap.spectating = true;

      if (binMode) {
        const needKey = this.keyAt[connId] === true;
        delete this.keyAt[connId];
        this.onSend(connId, PB.encode(snap, { key: needKey, omitPrev: omitPrev }));
      } else {
        this.onSend(connId, snap);
      }
    }

    if (doHud) {
      // HUD 借被跟随者的：倒计时、波次、血量都是这一局的，不是观战者自己的。
      // spectating=true 让前端把「血量」那一块换成「观战者没有血量」的说法。
      const h = SIM.getHud(this.world, cam);
      h.t = 'hud';
      h.spectating = true;
      this.onSend(connId, h);
    }
  }
};

// 给某个玩家打一份世界快照（视野裁剪以「他自己」为中心）。
// 注意 players 一律全发不带裁剪：队友就几个人，必须永远看得见
// （看不到队友的联机游戏不叫联机）。
//
// view 可以是三种：
//   不传      → 用全局兜底半径 config.viewRadius
//   数字 r    → 以玩家为心的正方形半径盒（测试里直接指定半径时用）
//   视野框对象 → 直接用（正常对局走这条，见 viewBoxFor）
// 传 null 表示不裁剪。
Match.prototype.snapshotFor = function (p, view) {
  const w = this.world;
  let box;
  if (view === undefined) box = radiusBox(p, config.viewRadius);
  else if (view === null) box = null;
  else if (typeof view === 'number') box = radiusBox(p, view);
  else box = view;

  return {
    tick: w.tick,
    time: r2(w.time),
    aliveMobCount: w.aliveMobCount,
    wave: w.wave,
    won: w.won,
    players: packPlayers(w.players),
    mobs: packList(w.mobs, F_MOB, box),
    shots: packList(w.enemyShots, F_SHOT, box),
    projs: packList(w.projectiles, F_PROJ, box),
    zones: packList(w.zones, F_ZONE, box),
    strikes: packList(w.strikes, F_STRIKE, box),
    // 环绕物 / 特效数量少，且都是围着玩家转的，裁剪收益有限，直接全发
    orbits: packList(w.orbits, F_ORBIT, null),
    pickups: packList(w.pickups, F_PICKUP, box),
    fx: packList(w.effects, F_FX, null)
  };
};

// ============================================================
// 收尾
// ============================================================

Match.prototype.finish = function (reason) {
  if (this.state === 'ended') return;

  this.state = 'ended';
  this.endedAt = Date.now();
  this.reason = reason || 'ended';

  // 先把「连接 -> 房间」的映射摘掉：对局一结束，这个人就不再属于任何对局了。
  // 不摘的话，他回大厅后点「开始游戏」会被当成「还在局里」而被拒之门外。
  const all = Object.keys(this.slots);
  for (let i = 0; i < all.length; i++) {
    if (matchByConn[all[i]] === this.code) delete matchByConn[all[i]];
  }

  // 结算：按击杀降序。每人各自的数字，不再是「整局一个总账」。
  const result = [];
  const ids = Object.keys(this.slots);
  for (let i = 0; i < ids.length; i++) {
    const slot = this.slots[ids[i]];
    const p = this.players[slot];
    if (!p) continue;
    result.push({
      slot: slot,
      name: p.name,
      charId: p.charId,
      isGuest: p.isGuest,
      alive: p.alive,
      level: p.level,
      kills: p.stats.kills,
      gold: p.stats.gold,
      dmgDealt: Math.round(p.stats.dmgDealt),
      healed: Math.round(p.stats.healed)
    });
  }
  // 中途退出的队友也要进结算。
  //
  // 【为什么】收局最常见的方式其实是「大家各自关掉页面」（一个人都不会留着），
  // 而每个断线的人都会在离场那一刻被 removeMember 摘掉 —— 只看在场者的话，
  // 这类对局的 result 永远是空的，结算落库也就什么都记不下来。
  // 离场者的进度本来就存在 this.left（席位保留）里，这里直接并进来。
  // 超期（> KEEP_LEFT_MS）的不算：那已经是「很久以前掉线的人」了。
  const leftKeys = Object.keys(this.left);
  for (let i = 0; i < leftKeys.length; i++) {
    const saved = this.left[leftKeys[i]];
    if (!saved || !saved.prog) continue;
    if (Date.now() - saved.at > KEEP_LEFT_MS) continue;
    const g = saved.prog;
    result.push({
      slot: saved.slot,
      name: g.name,
      charId: g.charId,
      isGuest: g.isGuest,
      alive: g.alive,
      left: true,                 // 标记「他已经退出了」，界面想区分时可以用
      level: g.level,
      kills: g.stats.kills,
      gold: g.stats.gold,
      dmgDealt: Math.round(g.stats.dmgDealt),
      healed: Math.round(g.stats.healed)
    });
  }

  result.sort(function (a, b) { return b.kills - a.kills; });
  this.result = result;

  const payload = {
    t: 'game_over',
    code: this.code,
    reason: this.reason,
    time: r1(this.world ? this.world.time : 0),
    // 难度跟着结算一起下发：结算面板要显示「你打的是哪一档」，
    // 而且这一档是玩家评价自己战绩的唯一参照（20 分钟通关在血月局和休闲局不是一回事）。
    difficulty: this.difficulty,
    diffName: C.diffById(this.difficulty).name,
    waveReached: this.world ? this.world.wave : 0,
    result: result,
    stat: this.statSummary()
  };
  for (let i = 0; i < ids.length; i++) this.onSend(ids[i], payload);

  // 观战者：同一份结算，但标上 spectating（客户端据此显示「观战结束」而不是「你输了」）
  const specPayload = Object.assign({}, payload, { spectating: true, watched: true });
  const sids = Object.keys(this.spectators);
  for (let i = 0; i < sids.length; i++) this.onSend(sids[i], specPayload);

  console.log('[match ' + this.code + '] 对局结束 reason=' + this.reason +
    ' 难度=' + this.difficulty +
    ' 时长=' + Math.round(this.world ? this.world.time : 0) + 's 人数=' + result.length +
    ' 平均单帧=' + this.avgTickMs().toFixed(3) + 'ms');

  if (this.onEnd) this.onEnd(this);
};

Match.prototype.avgTickMs = function () {
  return this.stat.steps > 0 ? this.stat.tickMsTotal / this.stat.steps : 0;
};

Match.prototype.avgSnapBytes = function () {
  return this.stat.snapCount > 0 ? Math.round(this.stat.snapBytes / this.stat.snapCount) : 0;
};

// 观测摘要：控制台与测试都用它
Match.prototype.statSummary = function () {
  return {
    steps: this.stat.steps,
    tickMsAvg: Number(this.avgTickMs().toFixed(3)),
    tickMsMax: Number(this.stat.tickMsMax.toFixed(3)),
    snapCount: this.stat.snapCount,
    snapBytesAvg: this.avgSnapBytes(),
    snapBytesMax: this.stat.snapBytesMax
  };
};

// ============================================================
// 注册表：房间号 -> Match，并负责驱动全局 20Hz 循环
// ============================================================

const matches = Object.create(null);
const matchByConn = Object.create(null);
const specByConn = Object.create(null);   // 观战者：connId -> 房间号（与 matchByConn 分开，见下）

const registry = {};

// 开一局。room 是 manager 的房间对象，opts.onSend 是网络出口。
registry.start = function (room, opts) {
  // 同一房间号可能还挂着上一局（结束后会在内存里留 matchKeepSec 秒供客户端拉结算）。
  // 那种「已经结束」的旧局必须先清掉，否则这里会把旧局原样返回，
  // 表现就是「第二局永远开不起来、还立刻收到上一局的结算」——查起来极费劲。
  const old = matches[room.code];
  if (old) {
    if (old.state === 'playing') return old;
    registry.stop(room.code, 'restart');
  }

  const m = new Match(room, {
    seed: opts.seed,
    spawnRadius: opts.spawnRadius,
    difficulty: opts.difficulty,
    onSend: opts.onSend,
    members: room.members,
    onEnd: function (ended) {
      // 先通知外部（协议层）。放在最前面是有意的：下面那几处 `return`
      // 会在「房间已经没了」时提前收尾，而结算记账（落库）不该被房间状态影响 ——
      // 对局确实打完了，数据就该记下来。
      if (opts.onEnd) opts.onEnd(ended);

      // 对局结束：把房间状态改回等待，并把成员准备好标记重置，
      // 这样一屋子人可以原地再来一局，不用重新建房。
      const mgr = require('../rooms/manager');
      const live = mgr.getRoom(ended.code);
      if (!live) return;

      // 人走光了就把房间收掉。不收的话会留下一个「0 人的 waiting 房间」
      // 一直挂在大厅列表里，点进去必然报「房间不存在」，很莫名其妙。
      if (!live.members.length) {
        mgr.destroyRoom(live.code);
        return;
      }

      mgr.setRoomState(live.code, 'waiting');
      for (let i = 0; i < live.members.length; i++) {
        live.members[i].ready = live.members[i].connId === live.hostConnId;
      }
      // 结束后的房间广播交给协议层（它才知道怎么发）
      if (opts.onRoomUpdate) opts.onRoomUpdate(live);
    }
  });

  matches[room.code] = m;
  const ids = m.conns();
  for (let i = 0; i < ids.length; i++) matchByConn[ids[i]] = room.code;

  console.log('[match] 开局 code=' + room.code + ' 人数=' + m.playerCount +
    ' 种子=' + m.seed + ' 刷怪半径=' + Math.round(m.spawnRadius) +
    ' 快照=' + config.snapshotHz + 'Hz 视野半径=' + config.viewRadius);

  return m;
};

// 中途加入已开局的房间
registry.join = function (connId, info) {
  const m = matches[info.code];
  if (!m || m.state !== 'playing') return null;
  const p = m.addMember(connId, info);
  matchByConn[connId] = info.code;
  return p;
};

registry.forget = function (connId) {
  delete matchByConn[connId];
};

registry.get = function (code) {
  return matches[code] || null;
};

registry.ofConn = function (connId) {
  const code = matchByConn[connId];
  return code ? matches[code] || null : null;
};

// 观战者进这一局。**不进 matchByConn** 是故意的 ——
// 那张表被 ofConn 用，而 ofConn 是「查我是不是在打这一局」的唯一入口。
// 把观战者放进去的话，onInput 会把他当成玩家处理（发起的操作真的生效）。
registry.spectate = function (connId, code, followSlot) {
  const m = matches[code];
  if (!m) return null;
  const s = m.addSpectator(connId, followSlot);
  if (!s) return null;
  specByConn[connId] = code;
  return s;
};

registry.stopSpectate = function (connId) {
  const code = specByConn[connId];
  if (!code) return null;
  const m = matches[code];
  delete specByConn[connId];
  return m ? m.removeSpectator(connId) : null;
};

registry.spectateOf = function (connId) {
  const code = specByConn[connId];
  if (!code) return null;
  const m = matches[code];
  return m ? m.spectatorOf(connId) : null;
};

// 观战者所在的对局。onDisconnect 用它来区分「该退观战」还是「该退玩家」。
registry.spectateMatchOf = function (connId) {
  const code = specByConn[connId];
  return code ? matches[code] || null : null;
};

// 结束并清理。reason 会记进日志。
registry.stop = function (code, reason) {
  const m = matches[code];
  if (!m) return null;

  if (m.state === 'playing') m.finish(reason || 'aborted');

  const ids = m.conns();
  for (let i = 0; i < ids.length; i++) {
    if (matchByConn[ids[i]] === code) delete matchByConn[ids[i]];
  }
  // 观战者也清一遍：漏掉的话 specByConn 会指向一个已经不存在的房间，
  // 而下一次 stopSpectate 会去 matches[code] 取到 undefined —— 那条路已经判了空，
  // 所以真正的问题是 specByConn 无限增长（一批观众会永久占着内存）。
  const sids = Object.keys(m.spectators);
  for (let i = 0; i < sids.length; i++) {
    if (specByConn[sids[i]] === code) delete specByConn[sids[i]];
  }
  delete matches[code];
  return m;
};

registry.count = function () {
  return Object.keys(matches).length;
};

registry.list = function () {
  const out = [];
  const codes = Object.keys(matches);
  for (let i = 0; i < codes.length; i++) {
    const m = matches[codes[i]];
    out.push({
      code: m.code,
      state: m.state,
      players: m.playerCount,
      tick: m.world ? m.world.tick : 0,
      time: m.world ? Math.round(m.world.time) : 0,
      tickMs: Number(m.avgTickMs().toFixed(3)),
      snapBytes: m.avgSnapBytes()
    });
  }
  return out;
};

// ============================================================
// 全局 20Hz 驱动
// ============================================================
// 全进程只有一个定时器，而不是「一局一个」：
// 定时器越多越容易被事件循环调度得七零八落，一个统一的节拍器最好控。

let loopTimer = null;
let lastTickAt = 0;

function tickAll() {
  const now = Date.now();
  // 第一次驱动没有上一拍，按一个标准步长算，避免首帧算出巨大的 dt
  let dt = lastTickAt ? now - lastTickAt : STEP_MS;
  lastTickAt = now;

  const codes = Object.keys(matches);
  for (let i = 0; i < codes.length; i++) {
    const m = matches[codes[i]];
    m.tick(dt);

    // 结束的对局在内存里多留一会儿（供客户端拉结算），到点才回收
    if (m.state === 'ended' && now - m.endedAt > config.matchKeepSec * 1000) {
      registry.stop(m.code, 'cleanup');
    }
  }
}

registry.startLoop = function () {
  if (loopTimer) return loopTimer;
  lastTickAt = 0;
  loopTimer = setInterval(tickAll, STEP_MS);
  // unref：这个定时器不该阻止进程正常退出（Ctrl+C 时能干净地关掉）
  if (loopTimer.unref) loopTimer.unref();
  console.log('[match] 服务端权威循环已启动：' + C.TICK_HZ + 'Hz（单定时器驱动全部对局）');
  return loopTimer;
};

registry.stopLoop = function () {
  if (!loopTimer) return;
  clearInterval(loopTimer);
  loopTimer = null;
  lastTickAt = 0;
};

// 仅供测试：把内部状态清干净，避免用例之间互相污染
registry._reset = function () {
  const codes = Object.keys(matches);
  for (let i = 0; i < codes.length; i++) delete matches[codes[i]];
  const ids = Object.keys(matchByConn);
  for (let i = 0; i < ids.length; i++) delete matchByConn[ids[i]];
  registry.stopLoop();
};

registry.Match = Match;
registry.STEP_MS = STEP_MS;

module.exports = registry;
