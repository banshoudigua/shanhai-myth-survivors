// server/game/proto.js —— 房间与对局的 WebSocket 协议层
//
// 层次划分（这一层最容易写乱，先说清楚）：
//   server/net/ws.js      连接生命周期、握手、心跳、在线列表（不说话务）
//   server/game/proto.js  房间与对局的消息语义（← 本文件）
//   server/rooms/manager  房间成员名单（大厅级状态）
//   server/game/match     世界模拟（对局级状态）
//
// 本文件是唯一把「网络」与「房间/对局」粘起来的地方：
// 它把 manager 的成员变更翻译成 room_update 广播，
// 把 match 的 onSend 接到真实的 socket 上。
//
// 消息清单
//   客户端 -> 服务端
//     { t:'room_list' }                        拉房间列表
//     { t:'room_create', charId, difficulty }  建房（建房人自动成为房主）
//     { t:'room_join',   code, charId }        加房
//     { t:'room_leave' }                       退房
//     { t:'room_ready',  ready }               切换准备状态
//     { t:'room_char',   charId }              等待室里换角色
//     { t:'room_diff',   difficulty }          房主改难度（仅开局前）
//     { t:'room_map',    mapId }               房主换地图（仅开局前）
//     { t:'set_avatar',  avatar }              换头像（短 id，见 shared/avatars.js）
//     { t:'game_start' }                       房主开局
//     { t:'game_leave' }                       对局中主动退出回大厅
//     { t:'input',  mx, my, seq }              移动意图（20Hz 上行）
//     { t:'choose', index }                    升级三选一
//   服务端 -> 客户端
//     { t:'room_list',   list }
//     { t:'room_update', room }                房间/等待室状态
//     { t:'game_start',  code, seed, selfSlot, players, difficulty, matchSec, ... }
//     { t:'roster', list }                     最新成员名单（有人加入/离开时补发）
//     { t:'snap',  ... }                       世界快照
//     { t:'hud',   ... }                       个人界面数据
//     { t:'ev',    list }                      本帧事件（升级/阵亡/开波…）
//     { t:'game_over', reason, result, stat, difficulty }  结算

const manager = require('../rooms/manager');
const registry = require('./match');
const config = require('../config');
const C = require('../../shared/const.js');
const avatars = require('../../shared/avatars.js');   // 头像白名单（双端共用一份）
const queries = require('../db/queries');

const proto = {};

// 由 server/net/ws.js 在挂载时注入的三个稳定出口。
// 之所以用注入而不是 require('../net/ws')：ws.js 也 require 本文件，
// 互相 require 会绕成一个环，Node 里环状依赖的求值顺序非常难预测。
const d = {
  sendTo: null,        // (connId, obj) -> 发出的字节数
  broadcast: null,     // (obj)
  pushOnline: null     // (force)
};

proto.init = function (deps) {
  d.sendTo = deps.sendTo;
  d.broadcast = deps.broadcast;
  d.pushOnline = deps.pushOnline;
};

// ============================================================
// 出站工具
// ============================================================

function reply(conn, obj) {
  if (!d.sendTo) return 0;
  return d.sendTo(conn.connId, obj);
}

function fail(conn, code, msg) {
  reply(conn, { t: 'error', code: code, msg: msg });
}

// 把房间状态推给房间里每个人。
// 每个人的视图里都要标出「哪个是你自己」，所以不能一份 JSON 群发，
// 得逐人构造 —— 房间里最多 8 个人，这点开销可以忽略。
function emitRoom(room) {
  if (!room || !room.members) return;
  const base = manager.roomView(room);
  if (!base) return;

  for (let i = 0; i < room.members.length; i++) {
    const m = room.members[i];
    // 逐人复制一份 members，只改 self 标记，不共享数组
    const view = {
      code: base.code,
      state: base.state,
      maxPlayers: base.maxPlayers,
      // 难度也走这条白名单：漏了的话候场室的难度选择器永远是「普通」，
      // 而大厅房间列表却显示的是真实难度 —— 两处对不上，会看成 bug。
      difficulty: base.difficulty,
      // 地图同理。★这就是「逐字段白名单」的第三次踩坑（头像、难度、地图）——
      //   manager.roomView 明明返回了 mapId，但这里不转发，客户端就永远收不到。
      mapId: base.mapId,
      hostSlot: base.hostSlot,
      canStart: base.canStart,
      members: []
    };
    for (let k = 0; k < base.members.length; k++) {
      const one = base.members[k];
      view.members.push({
        slot: one.slot,
        nickname: one.nickname,
        isGuest: one.isGuest,
        // 【别漏字段】这里是逐人复制白名单，roomView 里加了新字段而这里没跟上的话，
        // 候场室就永远看不到它（头像就是这么漏过一次：undefined 还会被 JSON 直接丢掉）
        avatar: one.avatar,
        charId: one.charId,
        ready: one.ready,
        connected: one.connected,
        host: one.host,
        // 掉线宽限：候场室显示「N 秒后移出」。没有它的话队友只能对着一个
        // 永远不动的「已掉线」猜他还在不在。
        offlineLeftSec: one.offlineLeftSec,
        // 只在「本人这一份」上为真：roomView 里读一次就清了，
        // 所以这里必须原样带出去，客户端才能弹「已回到房间」而不是无声无息。
        resumed: !!one.resumed,
        self: one.slot === m.slot
      });
    }
    d.sendTo(m.connId, { t: 'room_update', room: view });
  }
}

// sweep（宽限期到了回收席位）的通知钩子。挂在 manager 上而不是让 manager
// 反向 require 本文件 —— 那会变成 proto ↔ manager 的循环依赖，node 直接报错。
manager.onSwept = function (room) {
  emitRoom(room);
  afterRoomChange(null);
};

// 房间列表给谁看：只回给请求的那条连接（这是 room_list 请求的应答）
function emitRoomList(conn) {
  reply(conn, { t: 'room_list', list: manager.listRooms() });
}

// 房间名单变了之后的收尾：刷新大厅房间列表 + 在线列表。
//
// 【为什么是广播而不是只回当事人】房间列表是给「还没进房的人」看的。
// 只回当事人，等于「甲建了房，乙在大厅永远看不见」，那个列表就成了摆设。
// 房间变更的触发频率是人手点按钮，远低于 online 那种心跳级更新，
// 所以这里不做签名比对，直接广播（一次也就几百字节）。
function afterRoomChange(conn) {
  const payload = { t: 'room_list', list: manager.listRooms() };
  if (d.broadcast) d.broadcast(payload);
  else if (conn) reply(conn, payload);
  // 【别写 afterRoomChange(conn)】这里曾经因为一次全局替换把自己也换掉，
  // 变成自己调自己，直接把服务端栈打爆（RangeError: Maximum call stack size exceeded）。
  if (d.pushOnline) d.pushOnline(false);
}

// ============================================================
// 房间消息
// ============================================================

function onRoomList(conn) {
  emitRoomList(conn);
}

function onRoomCreate(conn, msg) {
  // 建房时可以顺手把难度与地图定下来（界面上是「选难度/地图 → 建桌」一步做完），
  // 之后房主仍可在候场室改（room_diff / room_map）。非法 id 由 manager 归一化
  // （难度回落到「普通」，地图回落到默认图）。
  const res = manager.createRoom(conn.connId, {
    charId: msg.charId, difficulty: msg.difficulty, mapId: msg.mapId
  });
  if (!res.ok) return fail(conn, res.code, res.msg);

  console.log('[proto] 建房 code=' + res.room.code + ' 房主=' + conn.nickname +
    ' 难度=' + res.room.difficulty + ' 地图=' + res.room.mapId);
  emitRoom(res.room);
  emitRoomList(conn);
  afterRoomChange(conn);
}

function onRoomJoin(conn, msg) {
  const code = String(msg.code || '').trim().toUpperCase();
  if (!code) return fail(conn, 'BAD_CODE', '请输入房间号');

  // 已经开局但还在内存里的对局：允许中途加入（人会直接落到世界里）
  const live = registry.get(code);
  if (live && live.state === 'playing') {
    return joinRunningMatch(conn, live, msg);
  }

  const res = manager.joinRoom(code, conn.connId, { charId: msg.charId });
  if (!res.ok) return fail(conn, res.code, res.msg);

  if (!res.again) {
    console.log('[proto] 加房 code=' + code + ' 昵称=' + conn.nickname + ' 座位=' + res.member.slot);
  }
  emitRoom(res.room);
  emitRoomList(conn);
  afterRoomChange(conn);
}

// 中途加入正在进行的对局
function joinRunningMatch(conn, match, msg) {
  if (match.playerCount >= config.maxPlayers) {
    return fail(conn, 'ROOM_FULL', '对局人数已满');
  }

  // 【必须先把人挂进房间名单】不能只往世界里加人。
  // 只加世界的话，房间的成员表里没有他 → 队友的候场室界面看不到他、
  // 房间人数也少一个，而且他退房时 manager 找不到记录，状态会残留。
  // 这里用 allowPlaying 放行「已开局不许加入」那道闸，其余校验照走。
  const room = manager.getRoom(match.code);
  let member = room ? manager.memberOf(room, conn.connId) : null;

  if (room && !member) {
    const res = manager.joinRoom(room.code, conn.connId, { charId: msg.charId, allowPlaying: true });
    if (!res.ok) return fail(conn, res.code, res.msg);
    member = res.member;
  } else if (room && member) {
    // 已经在房间名单里（比如刷新页面后重连回来）：只按新选的角色更新一下
    manager.setChar(conn.connId, msg.charId);
    member = manager.memberOf(room, conn.connId);
  }

  const p = registry.join(conn.connId, {
    code: match.code,
    slot: member ? member.slot : null,
    charId: member ? member.charId : manager.normalizeCharId(msg.charId, conn.isGuest),
    nickname: conn.nickname,
    isGuest: conn.isGuest,
    // 认人用（游客为 null）。断线重连要把进度接回来，靠它认出「这是刚才那个人」——
    // 只靠昵称的话，两个昵称相同的账号会互相接到对方的进度上。
    userId: conn.userId,
    // 头像跟着人进对局：优先取房间成员上记着的（他在候场室选的），
    // 没有就取连接上的，再没有由 match 按座位摊一个默认值
    avatar: member ? member.avatar : conn.avatar,
    // 【P2-5】客户端把视口的 CSS 像素尺寸报上来，服务端按人算「他的相机能看到的矩形」再下发。
    // 为什么必须由客户端报：服务端不知道对方是 1366x768 的笔记本还是 2560x1440 的大屏，
    // 用全局值时小屏玩家会白收一堆根本画不出来的实体。
    // 这个值只影响「发多少」，不影响世界推进 —— 客户端虚报只会让自己掉帧，
    // 改不小别人的包，所以不需要当安全边界处理（match.js 里仍会钳到合理区间）。
    viewW: msg.viewW,
    viewH: msg.viewH
  });
  if (!p) return fail(conn, 'JOIN_FAILED', '加入对局失败');

  manager.updateConn(conn.connId, { status: 'playing' });
  // 广播一次：让房间里的人（以及大厅列表）看到人数变了
  if (room) emitRoom(room);

  // 先告诉新人这一局的底细。
  // resumed：本次回来有没有把断线前的进度接上（客户端据此弹「已恢复上次进度」）。
  reply(conn, gameStartPayload(match, conn.connId, p.slot, {
    midJoin: true,
    resumed: !!match.resumedConn[conn.connId]
  }));
  delete match.resumedConn[conn.connId];

  // 再告诉老玩家「来了个人」（前端可以弹一条提示）
  match.broadcast({ t: 'ev', list: [{ type: 'ally_join', slot: p.slot, name: p.name }] });

  // 名单变了，给所有人（包括刚回来的这位）补发一份完整名单。
  // 【不补会怎样】甲先重连回来时，服务端手上只有甲一个人，给他的 game_start
  // 里名单就只有甲；随后乙回来，甲那边只在 ally_join 事件里听到个名字，
  // 手里的名单永远停在 1 项 —— 队友画得出来，名牌却查不到名字。
  // 注意放在 reply(game_start) 之后：这样刚回来那位也是先拿 selfSlot 再拿名单。
  match.broadcastRoster();

  console.log('[proto] 中途加入 code=' + match.code + ' 昵称=' + conn.nickname + ' 座位=' + p.slot);
  afterRoomChange(conn);
}

function onRoomLeave(conn) {
  const room = manager.roomOfConn(conn.connId);
  if (!room) return fail(conn, 'NOT_IN_ROOM', '你还没有加入房间');

  const res = manager.leaveRoom(conn.connId);
  console.log('[proto] 退房 code=' + room.code + ' 昵称=' + conn.nickname);

  // 先把「确实退掉了」明确回给他本人。
  // 不能让他靠「收到了 room_list，那大概是退成功了吧」来猜着切界面 ——
  // 猜错的话人会卡在候场室里出不来。
  reply(conn, { t: 'room_left' });

  // 再通知还留在房间里的人（人少了一个 / 房主换人了）
  if (res && res.room && !res.destroyed) emitRoom(res.room);
  afterRoomChange(conn);
}

function onRoomReady(conn, msg) {
  const room = manager.setReady(conn.connId, msg.ready);
  if (!room) return fail(conn, 'NOT_IN_ROOM', '你还没有加入房间');
  emitRoom(room);
}

function onRoomChar(conn, msg) {
  const room = manager.setChar(conn.connId, msg.charId);
  if (!room) return fail(conn, 'NOT_IN_ROOM', '你还没有加入房间');
  emitRoom(room);
}

// 房主改难度。三条拒绝理由都是「明确告诉玩家为什么」，而不是静默忽略：
// 玩家点了没反应，只会以为界面坏了，然后反复点。
function onRoomDiff(conn, msg) {
  const res = manager.setDifficulty(conn.connId, msg.difficulty);
  if (!res.ok) return fail(conn, res.code, res.msg);

  console.log('[proto] 难度改为 ' + res.room.difficulty + ' code=' + res.room.code +
    ' 操作者=' + conn.nickname);
  emitRoom(res.room);
  // 大厅房间列表上也要跟着变（别人是照着这个挑桌的）
  afterRoomChange(conn);
}

// 房主换地图。与改难度完全同构：拒绝理由都明确告诉玩家为什么，
// 而不是静默忽略（点了没反应，玩家只会以为界面坏了然后反复点）。
function onRoomMap(conn, msg) {
  const res = manager.setMap(conn.connId, msg.mapId);
  if (!res.ok) return fail(conn, res.code, res.msg);

  console.log('[proto] 地图改为 ' + res.room.mapId + ' code=' + res.room.code +
    ' 操作者=' + conn.nickname);
  emitRoom(res.room);
  // 大厅房间列表上也要跟着变（别人是照着这个挑桌的）
  afterRoomChange(conn);
}

// 换头像。头像只是一个短 id（见 shared/avatars.js），服务端只认白名单里的值，
// 非法值直接忽略 —— 它是个纯界面属性，没必要为它给玩家弹一个错误。
//
// 【三处必须同时更新】少一处就会出现「候场室头像换了、游戏里队友名牌还是旧的」：
//   ① 连接信息 —— 大厅的在线玩家列表读它
//   ② 房间成员 —— 候场室成员列表读它
//   ③ 进行中这一局的名单 —— 队友头顶名牌读它
// 账号用户再落一次库，下次登录还是这个头像；游客不落库（他们本来就没有账号行）。
function onSetAvatar(conn, msg) {
  const id = String(msg.avatar || '');
  if (!avatars.isValid(id)) return;

  const room = manager.setAvatar(conn.connId, id);
  if (room) emitRoom(room);

  const match = registry.ofConn(conn.connId);
  if (match && match.setAvatar(conn.connId, id)) match.broadcastRoster();

  if (conn.userId) {
    queries.setUserAvatar(conn.userId, id, function (err) {
      if (err) console.log('[proto] 头像落库失败 userId=' + conn.userId + '：' + (err.message || err));
    });
  }
}

// ============================================================
// 对局消息
// ============================================================

// 起局包（正常开局 / 中途加入 / 断线归来共用一份）。
//
// 【为什么要抽成一个函数】这个包是逐字段列的白名单，原来在 onGameStart 与
// joinRunningMatch 里各写了一份。新增字段时只改一处，表现就是
// 「正常开局能看到难度，中途加入的人看不到」—— 而且不报错、只是少个字段，
// 是那种要盯很久才发现的漂移。抽出来之后这种可能就不存在了。
function gameStartPayload(match, connId, selfSlot, opts) {
  opts = opts || {};
  return {
    t: 'game_start',
    code: match.code,
    seed: match.seed,
    startAt: match.startedAt,
    tickRate: C.TICK_HZ,
    spawnRadius: match.spawnRadius,
    // 报「实际给他用的视野范围」而不是配置默认值：两者会因为客户端上报而不同
    viewRadius: match.cullRadiusFor(connId),
    view: match.viewInfoFor(connId),
    snapshotHz: config.snapshotHz,
    // 本局难度与本局时长。必须显式下发 —— 客户端不能再拿 const 里的常量当默认值，
    // 那样「难度决定时长」在界面上会表现成倒计时从 20 分钟开始倒数、而世界 18 分钟就结束了。
    difficulty: match.difficulty,
    // 本局地图。客户端要用它建「背景世界」（联机时本机不跑模拟，但地面与障碍
    // 仍要画出来 —— 它们来自 world.map）。不显式下发的话，客户端只能拿 URL 上的
    // 默认图去画，结果是「人站在墓地里、地面却是钟楼广场」。
    mapId: match.mapId,
    matchSec: match.world.matchSec,
    selfSlot: selfSlot,
    midJoin: !!opts.midJoin,
    // 观战标记。selfSlot=-1 与它是一对：前者说「我没座位」，后者说「所以别给我画血条」。
    // 两个都发是因为客户端有两种读法（有的地方看 selfSlot，有的地方看 spectating）。
    spectating: !!opts.spectating,
    followSlot: (opts.followSlot === undefined ? -1 : opts.followSlot),
    // 本次回来有没有把断线前的进度接上。客户端据此弹一句「已恢复上次进度」——
    // 不说的话，玩家只会看到等级没变，心里犯嘀咕是不是重连把自己重置了。
    resumed: !!opts.resumed,
    players: match.rosterPayload()
  };
}

function onGameStart(conn, msg) {
  const room = manager.roomOfConn(conn.connId);
  if (!room) return fail(conn, 'NOT_IN_ROOM', '你还没有加入房间');
  if (room.hostConnId !== conn.connId) return fail(conn, 'NOT_HOST', '只有房主可以开始对局');
  if (room.state !== 'waiting') return fail(conn, 'ROOM_PLAYING', '对局已经开始了');
  if (!manager.canStart(room)) return fail(conn, 'NOT_READY', '还有玩家没有准备');

  // 允许房主指定种子（调试与复现问题用）；不传就让服务端随机
  const seed = Number.isFinite(Number(msg.seed)) && Number(msg.seed) > 0 ? Number(msg.seed) : undefined;

  const match = registry.start(room, {
    seed: seed,
    // 难度以「房间」为准（房主在候场室选的），不读客户端在这条消息里塞的值 ——
    // 开局参数只能有一个来源，否则改个包就能偷偷把一屋子人塞进血月局。
    difficulty: room.difficulty,
    // 地图同样只认「房间」：房主在候场室选的这一张，
    // 客户端在这条消息里塞什么都不看（改包换地图不该有入口）。
    mapId: room.mapId,
    onSend: d.sendTo,
    onRoomUpdate: function (r) { emitRoom(r); },
    // 结算落库。放在这里而不是 match.js 里：那个文件的自我约定是「不认识网络、不碰 I/O」，
    // 而本文件是「网络 ↔ 房间」的唯一粘合层，本来就负责落库（头像就是这么写的）。
    onEnd: recordMatchResult
  });

  manager.setRoomState(room.code, 'playing');
  for (let i = 0; i < room.members.length; i++) {
    manager.setConnected(room.members[i].connId, true);
    manager.updateConn(room.members[i].connId, { status: 'playing' });
  }
  // 广播一次「房间进入对局中」。
  // 不广播的话，等待室界面会一直停在上一次的 waiting 状态；
  // 更要紧的是大厅的房间列表会一直显示「可加入」，点进去才被拒，体验很差。
  emitRoom(room);

  // 逐人下发起局包：selfSlot 对每个人都不一样，不能群发
  const ids = match.conns();
  for (let i = 0; i < ids.length; i++) {
    const connId = ids[i];
    d.sendTo(connId, gameStartPayload(match, connId, match.slotOf(connId), { midJoin: false }));
  }

  console.log('[proto] 开局 code=' + room.code + ' 人数=' + match.playerCount +
    ' 难度=' + match.difficulty);
  afterRoomChange(conn);
}

function onInput(conn, msg) {
  const match = registry.ofConn(conn.connId);
  // 不在对局里就静默忽略：客户端可能因为丢包还在发，
  // 这里回错误只会把日志和带宽都刷爆，没有任何好处。
  // 观战者也在这一档里被挡住了（他不在 matchByConn 里，见 registry.spectate 的注释）——
  // 这正是「观战者动不了」的第一道保证：改包发 input 也不会生效。
  if (!match) return;
  match.setInput(conn.connId, msg.mx, msg.my, msg.seq);
}

function onChoose(conn, msg) {
  const match = registry.ofConn(conn.connId);
  // 观战者静默忽略，别给他回错误。
  // 【为什么要单独判】他不在 matchByConn 里，ofConn 返回 null，正常会走到下一行回
  // NOT_IN_MATCH —— 于是观战界面上凭空弹一条红色的「你不在对局中」。
  // 观战者本来就不该发 choose（客户端不发），这条是给改包的人看的：
  // 他发了也什么都不会发生，且不会知道是自己没身份。
  if (registry.spectateMatchOf(conn.connId)) return;
  if (!match) return fail(conn, 'NOT_IN_MATCH', '你不在对局中');

  const ok = match.choose(conn.connId, msg.index);
  if (ok) return;

  // 没选成功。只在「他确实正站在升级面板前、但下标非法」时才回一份最新 HUD 校正 ——
  // 【为什么不无脑回】这是个带宽放大入口：客户端只要狂发 choose，服务端就每次都
  // 打包一份完整 HUD（武器/被动/候选全在里面）回去，一条几十字节的消息能换回几百字节。
  // 而「他根本不在升级面板前」这种情况，接下来 5Hz 的常规 HUD 本来就会把界面掰正
  //（客户端那边点了选择也会乐观地自己收起面板），根本不需要专门回一份。
  const p = match.playerOf(conn.connId);
  if (!p || p.state !== 'levelup') return;

  const h = require('../../shared/sim.js').getHud(match.world, p);
  h.t = 'hud';
  reply(conn, h);
}

function onGameLeave(conn) {
  // 观战者点「退出观战」：不该走下面那段（那段会认为他离开了对局）。
  // 少了这个分支，观战者会收到 game_left 并被当成「退出了这一局」——
  // 而他从头到尾就没在局里，服务端还顺手把房主位给移交了。
  if (registry.spectateMatchOf(conn.connId)) return onSpectateStop(conn);

  const match = registry.ofConn(conn.connId);
  if (match) {
    const p = match.playerOf(conn.connId);
    const slot = p ? p.slot : -1;
    const name = p ? p.name : conn.nickname;

    match.removeMember(conn.connId);
    registry.forget(conn.connId);
    match.broadcast({ t: 'ev', list: [{ type: 'ally_left', slot: slot, name: name }] });
    // 走了一个人也是名单变化：留下的人手上的名单要跟着更新，
    // 否则名牌会一直显示一个已经不在局里的队友。
    match.broadcastRoster();
    console.log('[proto] 中途退出对局 code=' + match.code + ' 昵称=' + conn.nickname);

    if (match.playerCount <= 0) registry.stop(match.code, 'empty');
  }

  manager.leaveRoom(conn.connId);
  manager.updateConn(conn.connId, { status: 'lobby' });

  reply(conn, { t: 'game_left' });
  emitRoomList(conn);
  afterRoomChange(conn);
}

// ============================================================
// 断线：由 ws.js 在 close 时调用
// ============================================================
// 注意调用顺序：必须在 manager.removeConn 之前调，
// 因为 removeConn 会把 conn.roomCode 清掉，那时就找不到房间了。
proto.onDisconnect = function (connId) {
  // 0) 观战中：只退观战，不碰这一局。
  //    【必须放在最前面】观战者不在 matchByConn 里，下面 1) 那步对他天然是空的，
  //    但如果顺序颠倒、以后有人给观战者也登记了座位，这里就会把他当玩家摘掉 ——
  //    一次误伤会直接改变这一局的实体数量。放在最前面最省心。
  const spec = registry.spectateMatchOf(connId);
  if (spec) {
    registry.stopSpectate(connId);
    console.log('[proto] 观战者断开 code=' + spec.code + ' 剩余观众=' + spec.spectatorCount());
  }

  // 1) 对局里：从世界里摘掉。
  //    【注意这里不 registry.stop】哪怕走光的是最后一个人也不停。
  //    因为「大厅页跳到游戏页」在服务端看起来就是一次干净的全员断线，
  //    真要在这里停局，「房主点开始 → 全员进游戏」必然崩在跳转那一秒。
  //    走光交给 match.suspend() 挂起，宽限期内有人回来就续上，超时才收局。
  const match = registry.ofConn(connId);
  if (match) {
    const p = match.playerOf(connId);
    const slot = p ? p.slot : -1;
    const name = p ? p.name : '';
    match.removeMember(connId);
    registry.forget(connId);
    if (match.playerCount > 0) {
      match.broadcast({ t: 'ev', list: [{ type: 'ally_left', slot: slot, name: name }] });
      // 掉线同样是名单变化。注意这里是「页面跳转导致的正常断线」的高频路径：
      // 两个人同时跳，甲掉线时乙可能已经回来了 —— 此时更要让乙手上的名单保持最新。
      match.broadcastRoster();
    }
  }

  // 2) 房间里：只标记掉线，不摘人（见 manager.leaveRoom 的 offline 分支）。
  //    宽限期内他回来能接回原座位与房主身份；超时才由 manager.sweep 收掉。
  //    这时候要广播一次，让队友看见「他掉了，N 秒后移出」而不是一个静默的变化。
  const res = manager.leaveRoom(connId, { offline: true });
  if (res && res.room && !res.destroyed) emitRoom(res.room);
  afterRoomChange(null);
};

// ============================================================
// 结算落库
// ============================================================

// 对局结束后把战绩写进库。三张表：
//   matches（一局一行）→ match_players（每人一行）→ player_stats（累计，排行榜读它）
//
// 【口径】只记账号用户。游客没有 userId，写进去没人认领、还会让表无限长大；
// 界面上也是这么承诺的（「游客对局不写入数据库」）。
// 所以一局里一个账号都没有 → 整局不落库。
//
// 【为什么 fire-and-forget】这是对局结束的收尾路径，落库失败不该影响任何人
// —— 玩家该看到的结算包早就发出去了。失败只留日志。
function recordMatchResult(match) {
  const result = match.result || [];
  const w = match.world;

  // userId 从 match.userIdBySlot 取，不从结算行里取 —— 结算包是要发给所有客户端的，
  // 不该把别人的账号 id 顺手广播出去；而且中途退出的人早就没有实体了，
  // 只有这张「座位 → userId」的表还记得他。
  const rows = [];
  let topKills = -1;
  for (let i = 0; i < result.length; i++) {
    const r = result[i];
    const userId = match.userIdBySlot[r.slot] || null;
    if (!userId) continue;              // 游客跳过
    if (r.kills > topKills) topKills = r.kills;
    rows.push({
      userId: userId,
      charId: r.charId,
      level: r.level,
      kills: r.kills,
      damageDealt: r.dmgDealt || 0,
      gold: r.gold || 0,
      isMvp: false
    });
  }

  if (!rows.length) {
    console.log('[proto] 对局 code=' + match.code + ' 无账号玩家，不落库');
    return;
  }

  const durationSec = Math.round(w ? w.time : 0);
  const wave = w ? w.wave : 0;
  // 通关 = 撑满全场（reason='won'）。其余（empty / aborted / restart）都算未通关。
  const cleared = match.reason === 'won';

  // 击杀并列最高时都算 MVP —— 不搞「只给一个人」，那纯属制造争吵
  for (let i = 0; i < rows.length; i++) {
    rows[i].isMvp = topKills > 0 && rows[i].kills === topKills;
    rows[i].survivedSec = durationSec;
  }

  queries.insertMatch({
    roomCode: match.code,
    seed: match.seed,
    // mode 列原本默认 'coop'，现在写真实难度 —— 它是「这局算不算硬」的唯一记录，
    // 以后要出「按难度分榜」也全靠它。
    mode: match.difficulty,
    playerCount: result.length,
    durationSec: durationSec,
    wave: wave,
    cleared: cleared
  }, function (err, matchId) {
    if (err || !matchId) {
      console.log('[proto] 对局入库失败 code=' + match.code + ': ' + (err && err.message));
      return;
    }
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      queries.insertMatchPlayer(matchId, row, function (e) {
        if (e) console.log('[proto] 参战明细入库失败 user=' + row.userId + ': ' + e.message);
      });
      // 累计统计：排行榜与「我的档案」读的就是它
      queries.upsertPlayerStats(row.userId, row.kills, durationSec, row.level, durationSec, function (e) {
        if (e) console.log('[proto] 累计统计入库失败 user=' + row.userId + ': ' + e.message);
      });
    }
    console.log('[proto] 对局入库 code=' + match.code + ' matchId=' + matchId +
      ' 账号玩家=' + rows.length + ' 时长=' + durationSec + 's 波次=' + wave +
      (cleared ? '（通关）' : ''));
  });
}

// ============================================================
// 观战
// ============================================================

// 观战：只看不打。不占座位、不进世界、不影响任何一帧模拟。
//
// 【为什么观战者不进房间成员表】进了的话他会占一个 maxPlayers 名额、
// 候场室会多出一个人、开始对局时还会被算进这一局 —— 「看的人」变成了「打的人」。
// 所以他只在 match 的 spectators 表里，房间那边完全不碰。
function onSpectate(conn, msg) {
  // 已经在打就别来观战：一个连接只能有一种身份，否则 input 会被两边同时处理
  if (registry.ofConn(conn.connId)) {
    return fail(conn, 'ALREADY_PLAYING', '你已经在这一局里了');
  }
  // 也别重复：已经在观战就当成切视角
  const already = registry.spectateOf(conn.connId);

  const code = String(msg.code || (conn.roomCode || '')).trim().toUpperCase();
  const live = registry.get(code);
  if (!live) return fail(conn, 'MATCH_NOT_FOUND', '这一局已经结束了');
  if (live.state !== 'playing') return fail(conn, 'MATCH_ENDED', '这一局已经结束了');

  // 一间房可以「还开着、但已经没人了」：最后一个人退出后这一局就 finish 了，
  // 而房间要留到对局收尾才改回 waiting。宽限期内它仍以「对局中」出现在大厅列表里 ——
  // 玩家看到「对局中」点观战，就会撞到这句。
  //
  // 【为什么这里必须显式判】房间列表按 room.state 显示，而那一局的状态
  // 在 people 全走光后就已经是 ended 了。两边不同步的那一刻，列表就在骗人。
  if (live.playerCount <= 0) {
    return fail(conn, 'MATCH_EMPTY', '这一局已经没人了，等房主重新开局');
  }

  // 一间房的观战人数上限：不设限的话一个人开十个标签页就能把带宽吃光
  if (!already && config.maxSpectators > 0 && live.spectatorCount() >= config.maxSpectators) {
    return fail(conn, 'SPECTATOR_FULL', '观战人数已满（' + config.maxSpectators + ' 人）');
  }

  const s = already ? live.spectateFollow(conn.connId, msg.slot) : registry.spectate(conn.connId, code, msg.slot);
  if (!s) return fail(conn, 'SPECTATE_FAILED', '无法开始观战（这一局可能已经没人了）');

  live.setViewport(conn.connId, msg.viewW, msg.viewH);
  manager.updateConn(conn.connId, { status: 'spectating', roomCode: code });

  // 起手包：selfSlot 给 -1 表示「我不是这一局的任何座位」，
  // 客户端据此把「我的血量/我的经验」那几块藏掉。seed 仍然要给 ——
  // 观战者要看到与所有人完全一致的世界（同一张地图、同样的怪）。
  reply(conn, gameStartPayload(live, conn.connId, -1, {
    midJoin: true,
    spectating: true,
    followSlot: s.followSlot
  }));

  console.log('[proto] 观战 code=' + code + ' 昵称=' + conn.nickname + ' 跟随座位=' + s.followSlot);
  // 让房内的人知道有人在看（观战者自己想被看见的话可以，
  // 但更重要的是「房里突然多了个人」这件事本身该让人知道）。
  // 【为什么用 broadcast 而不是只发自己】这跟 ally_join 是同一个道理：
  // 名单变化要通知**剩下的人**，不然他们的观战人数显示永远停在 0。
  live.broadcast({
    t: 'ev',
    list: [{ type: 'spectator_join', name: conn.nickname, count: live.spectatorCount() }],
    noEchoToSpectators: true      // 观战者不用知道「自己刚加入了」（见 match.broadcast）
  });
  afterRoomChange(conn);
}

function onSpectateFollow(conn, msg) {
  const live = registry.spectateMatchOf(conn.connId);
  if (!live) return fail(conn, 'NOT_SPECTATING', '你当前不在观战');
  const s = live.spectateFollow(conn.connId, msg.slot);
  if (!s) return fail(conn, 'SPECTATE_FAILED', '无法切换视角');
  live.setViewport(conn.connId, msg.viewW, msg.viewH);
  // 换视角后客户端手上那份增量坐标作废，明确告诉它「重新开始解码」
  live.keyAt[conn.connId] = true;
  reply(conn, { t: 'spectate_follow', slot: s.followSlot });
}

function onSpectateStop(conn) {
  const live = registry.spectateMatchOf(conn.connId);
  const s = registry.stopSpectate(conn.connId);
  if (!s) return fail(conn, 'NOT_SPECTATING', '你当前不在观战');
  const code = String(conn.roomCode || '');
  manager.updateConn(conn.connId, { status: 'lobby', roomCode: '' });
  reply(conn, { t: 'spectate_stop' });
  // 告诉房里的人「他走了」：观战人数变了，界面上该跟着变
  if (live && live.state === 'playing') {
    live.broadcast({
      t: 'ev',
      list: [{ type: 'spectator_left', name: conn.nickname, count: live.spectatorCount() }]
    });
  }
  console.log('[proto] 退出观战 code=' + code + ' 昵称=' + conn.nickname);
  if (code) afterRoomChange(conn);
}

// ============================================================
// 分发
// ============================================================

// 让房间列表能反映「这一局实际上还活着吗」。
// 房间自己的 state 在对局结束后要等 match 收尾才改回 waiting，而 match 那边
// 「人走光 → finish」更早 —— 那段空档里房间仍以「对局中」示人。
// 注入成函数（而不是让 manager 反向 require 本文件）是为了避免循环依赖。
manager.stateAt = function (code) {
  const m = registry.get(code);
  return m ? m.state : null;
};

const handlers = {
  room_list: onRoomList,
  room_create: onRoomCreate,
  room_join: onRoomJoin,
  room_leave: onRoomLeave,
  room_ready: onRoomReady,
  room_char: onRoomChar,
  room_diff: onRoomDiff,
  room_map: onRoomMap,
  set_avatar: onSetAvatar,
  game_start: onGameStart,
  game_leave: onGameLeave,
  input: onInput,
  choose: onChoose,
  spectate: onSpectate,
  spectate_follow: onSpectateFollow,
  spectate_stop: onSpectateStop
};

// 返回 true 表示这条消息已被本层处理，ws.js 不用再管
proto.handle = function (ws, conn, msg) {
  const fn = handlers[msg.t];
  if (!fn) return false;
  fn(conn, msg);
  return true;
};

// 供调试接口 / 测试查看
proto.stats = function () {
  return {
    rooms: manager.listRooms(),
    matches: registry.list(),
    maxPlayers: config.maxPlayers,
    snapshotHz: config.snapshotHz,
    viewRadius: config.viewRadius,
    upgradeTimeoutSec: config.upgradeTimeoutSec
  };
};

module.exports = proto;
