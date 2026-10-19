// server/rooms/manager.js —— 在线连接与房间管理
//
// 职责边界（很重要，别把对局逻辑塞进来）：
//   本文件只管「谁在线、谁在哪个房间、房间里谁准备好了」这类**大厅级状态**，
//   一行业务模拟代码都不放。真正的对局模拟在 server/game/match.js，
//   两边通过「房间号 code」这一个字符串对接：manager 管房间的成员名单，
//   match 管这个房间里的世界。谁也不用知道对方的内部结构。
//
// 说明：在线状态与房间都放在内存里，不入库——这是有意的设计，
// 它们的生命周期只有进程那么长，重启即失效，没有持久化价值。

const C = require('../../shared/const.js');
const M = require('../../shared/maps.js');
const config = require('../config');

const manager = {};

// 「候场室里人掉线后，房间还留着」宽限期（毫秒）。
// 理由与对局侧的 matchKeepSec 完全一样，只是作用对象从「世界」换成「房间」：
//   · 页面跳转（大厅 → game.html）在服务端看起来就是一次干净的全员断线，
//     宽限期太短会把每一次正常开局都误判成「人走了」；
//   · 房主刷新一下页面、队友手机切个后台回来，这些都该接得上；
//   · 又不能太长 —— 一堆 0 人的僵尸房间会永远挂在大厅列表里，
//     点进去必然报「房间不存在」，非常莫名其妙。
const ROOM_KEEP_MS = Math.max(5, config.roomKeepSec) * 1000;

// connId -> 连接信息 { connId, userId, nickname, isGuest, avatar, status, roomCode, joinedAt }
const conns = Object.create(null);

// roomCode -> 房间对象
// { code, hostConnId, createdAt, state, startedAt, seed, maxPlayers, members[] }
// members[] 每一项：
//   { connId, userId, nickname, isGuest, avatar, charId, ready, slot, connected, joinedAt,
//     offAt }
//
// 【offAt 是什么】断线时打的离场时刻（0 = 还在）。
// 断线**不等于离开**：直接把成员摘掉的话，房里最后一个人一断线房间就当场销毁，
// 房主刷新一下页面，昨晚发给队友的房间号立刻作废。所以这里只打时间戳，
// 真正的清理由 sweepExpiredRoom 在宽限期到了之后做。
const rooms = Object.create(null);

// ============================================================
// 小工具
// ============================================================

// 房间号字符表：去掉了 0/O/1/I/L 这些念出来会含糊的字符，
// 因为房间号是要靠嘴报给队友的（"房间 BBCD" 比 "房间 B0CD1L" 靠谱得多）
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET.charAt(Math.floor(Math.random() * CODE_ALPHABET.length));
  }
  return out;
}

// 生成一个当前没被占用的房间号（撞了就重试，房间数远小于字符空间时几乎一次就中）
function nextRoomCode() {
  const len = Math.max(3, Math.min(8, config.roomCodeLen));
  for (let i = 0; i < 50; i++) {
    const code = randomCode(len);
    if (!rooms[code]) return code;
  }
  // 极端情况下（房间号全被占）退化成 6 位，保证一定能创建出来
  return randomCode(6);
}

function indexOfMember(room, connId) {
  for (let i = 0; i < room.members.length; i++) {
    if (room.members[i].connId === connId) return i;
  }
  return -1;
}

// 掉线重连的「认人」键。
// 与对局侧 match.js 里的 identityKey 是同一套规则，两边必须一致 ——
// 不然会出现「对局里接回了进度、候场室里却被当成另一个人」。
//
// 账号用户用 userId（唯一、不会撞）；游客没有 userId，只能用昵称。
// 游客同名会互相认成同一个人，这是已知的取舍：窗口只有一分多钟、用掉即删，
// 相对「所有游客都没法回原位」更划算。
function identityKey(info) {
  if (!info) return '';
  if (info.userId !== undefined && info.userId !== null && info.userId !== '') return 'u' + info.userId;
  const nick = String(info.nickname || '').trim();
  return nick ? 'g' + nick : '';
}

// 在房里找「掉线了、还可以接回来」的那一份。
//
// 判定用三个条件一起，缺一不可：
//   ① 身份键相同 —— 认人才认得对
//   ② connected === false —— 他确实掉线了（在线的不用接，直接重进即可）
//   ③ 还在宽限期内 —— 超期的席位已经/即将被回收，接回来会和一个幽灵撞座
function findReclaimable(room, conn) {
  const key = identityKey(conn);
  if (!key) return null;
  const now = Date.now();
  for (let i = 0; i < room.members.length; i++) {
    const m = room.members[i];
    if (m.connected) continue;
    if (m.offAt && now - m.offAt > ROOM_KEEP_MS) continue;
    if (identityKey({ userId: m.userId, nickname: m.nickname }) !== key) continue;
    return m;
  }
  return null;
}

// 找最小空闲座位号。座位号是网络协议里的玩家标识（sim 里靠它索引输入），
// 必须稳定：同一个人整局都用这个号，别人走了也不重排，否则实体会被认错人。
function pickFreeSlot(room) {
  const used = Object.create(null);
  for (let i = 0; i < room.members.length; i++) used[room.members[i].slot] = 1;
  let slot = 0;
  while (used[slot]) slot += 1;
  return slot;
}

// 角色合法性校验。
// 非法的、以及游客选了未解锁的角色，一律降级成「游客能用的第一个角色」，
// 不报错——客户端已经拦过一道，服务端这里只是兜底，没必要为此中断流程。
manager.normalizeCharId = function (charId, isGuest) {
  const def = C.CHAR_MAP[charId];
  if (!def) return C.CHARACTERS[0].id;
  if (isGuest && !def.guestAllowed) {
    for (let i = 0; i < C.CHARACTERS.length; i++) {
      if (C.CHARACTERS[i].guestAllowed) return C.CHARACTERS[i].id;
    }
    return C.CHARACTERS[0].id;
  }
  return def.id;
};

// ============================================================
// 连接
// ============================================================

manager.addConn = function (connId, info) {
  conns[connId] = {
    connId: connId,
    userId: info.userId || null,        // 游客为 null
    nickname: info.nickname,
    isGuest: !!info.isGuest,
    // 头像只存一个短 id（见 shared/avatars.js）。没选过就用座位/连接序号摊一个，
    // 保证同屏的人默认也不撞款；合法性由 proto 的消息处理统一把关。
    avatar: info.avatar || '',
    status: info.status || 'lobby',     // lobby / playing / spectating
    roomCode: '',
    joinedAt: Date.now()
  };
  return conns[connId];
};

// 换头像：连接信息与房间成员两处都要改 —— 大厅在线列表读前者、候场室读后者。
// 返回改过的房间（调用方据此广播 room_update），不在房间里就返回 null。
manager.setAvatar = function (connId, avatar) {
  const conn = conns[connId];
  if (!conn) return null;
  conn.avatar = avatar;

  const room = manager.roomOfConn(connId);
  if (!room) return null;
  const idx = indexOfMember(room, connId);
  if (idx >= 0) room.members[idx].avatar = avatar;
  return room;
};

// 摘掉一个连接。会连带把他从房间里剔除（返回足够的信息让上层去广播）。
//
// 注意：这里的退房一律按「断线」处理（offline:true）——
// removeConn 只在连接真正关掉时被调用，无论是玩家点了「离开房间」
// 还是他刷新了页面，走的都是这一条。
// 「主动离开」那条路走的是 onRoomLeave（proto 里直接调 manager.leaveRoom 且不传 offline），
// 那里是玩家明确表达的意图，才需要立刻摘人。
manager.removeConn = function (connId) {
  const conn = conns[connId];
  if (!conn) return null;

  const left = manager.leaveRoom(connId, { offline: true });
  conn.roomCode = '';
  delete conns[connId];
  return { conn: conn, left: left };
};

manager.getConn = function (connId) {
  return conns[connId] || null;
};

manager.updateConn = function (connId, patch) {
  const conn = conns[connId];
  if (!conn) return null;
  Object.assign(conn, patch);
  return conn;
};

manager.count = function () {
  return Object.keys(conns).length;
};

// ============================================================
// 在线列表（大厅展示用）
// ============================================================

manager.listOnline = function () {
  const now = Date.now();
  const list = [];
  const ids = Object.keys(conns);
  for (let i = 0; i < ids.length; i++) {
    const c = conns[ids[i]];
    list.push({
      connId: c.connId,
      userId: c.userId,
      nickname: c.nickname,
      isGuest: c.isGuest,
      avatar: c.avatar,
      status: c.status,
      roomCode: c.roomCode,
      onlineSec: Math.floor((now - c.joinedAt) / 1000)
    });
  }
  // 注册用户在前，再按加入时间排序，列表稳定不跳动
  list.sort(function (a, b) {
    if (a.isGuest !== b.isGuest) return a.isGuest ? 1 : -1;
    return a.onlineSec < b.onlineSec ? 1 : -1;
  });
  return list;
};

// ============================================================
// 房间
// ============================================================

// 建房：建房人自动成为房主 + 座位 0，并且一个连接同时只待在一个房间里
manager.createRoom = function (connId, opts) {
  opts = opts || {};
  const conn = conns[connId];
  if (!conn) return { ok: false, code: 'NO_CONN', msg: '连接状态异常' };

  // 已经在别的房间就先退掉，避免一个人出现在两个房间的名单里
  if (conn.roomCode) manager.leaveRoom(connId);

  const room = {
    code: nextRoomCode(),
    hostConnId: connId,
    createdAt: Date.now(),
    state: 'waiting',                 // waiting / playing / ended
    startedAt: 0,
    seed: 0,
    maxPlayers: opts.maxPlayers || config.maxPlayers,
    // 难度：建房时定一个初值，开局前房主随时可改（见 setDifficulty）。
    // 存 id 而不是倍率对象 —— 它要发给客户端、还要落库，存 id 才能保证
    // 以后调数值时「同一间房」在不同版本间的含义不变。
    difficulty: C.normalizeDiffId(opts.difficulty),
    // 地图：与难度同一套生命周期（建房定初值 → 房主开局前可改 → 随房间进对局）。
    // 存 id 而不是整张地图对象：定义在 shared/maps.js，两端各读同一份表、靠 id 对齐；
    // 房间里存整份对象只会让 roomView 每次多发几百字节。
    mapId: M.mapById(opts.mapId).id,
    members: []
  };
  rooms[room.code] = room;

  const joined = manager.joinRoom(room.code, connId, opts);
  if (!joined.ok) {
    delete rooms[room.code];
    return joined;
  }
  return { ok: true, room: room };
};

// 加房：房间不存在 / 满员 / 已开局 都明确回错误码，让前端能给出准确提示
//
// opts.allowPlaying：中途加入正在进行的对局时置 true。
// 只放行「已开局」这一道闸，其余校验（人数上限、座位分配、conn.roomCode 回填）照走 ——
// 所以要它，而不是让调用方自己绕过 manager 去改 members 数组。
manager.joinRoom = function (code, connId, opts) {
  opts = opts || {};
  const room = rooms[code];
  if (!room) return { ok: false, code: 'ROOM_NOT_FOUND', msg: '房间不存在或已解散' };
  if (!opts.allowPlaying && (room.state === 'playing' || room.state === 'ended')) {
    return { ok: false, code: 'ROOM_PLAYING', msg: '该房间已经开局了' };
  }

  const conn = conns[connId];
  if (!conn) return { ok: false, code: 'NO_CONN', msg: '连接状态异常' };

  // 已经在里面：当成「重进」，直接回当前状态，不重复加入
  const exist = indexOfMember(room, connId);
  if (exist >= 0) return { ok: true, room: room, member: room.members[exist], again: true };

  // 【重连接回】先看有没有一份属于「我」的掉线席位。
  // 不做这一步的话，重连会被当成一个全新的人：拿到新座位、丢掉房主身份、
  // 准备状态被重置 —— 玩家刷新一下页面，回来就变成了另一个角色。
  // 顺带把满员检查也跳过了：他原来就占着那个位，不算超编。
  const back = findReclaimable(room, conn);
  if (back) {
    const wasHost = (room.hostConnId === back.connId);
    back.connId = connId;
    back.connected = true;
    back.offAt = 0;
    back.nickname = conn.nickname;          // 昵称可能刚改过，以连接上的为准
    back.avatar = conn.avatar || back.avatar;
    // 角色/准备状态一律保留：那是「他刚才选的」，不该被重置。
    if (wasHost) room.hostConnId = connId;  // 房主回来还是房主（hostConnId 存的是 connId）
    // 【别漏这一句】这个分支提前 return 了，走不到函数末尾那行 conn.roomCode = code。
    // 漏掉的后果不是「少回一个字段」，而是这条连接**根本不知道自己在这个房间里**：
    // 断线时 leaveRoom 查不到房间 → 席位永远打不上离场时间戳 → 宽限期回收形同虚设，
    // 房间会一直挂在大厅列表里。症状与「根本没做保座」一模一样，极难定位。
    conn.roomCode = room.code;
    conn.status = 'lobby';
    // 打一个「本次是接回来的」标记，由 roomView 读一次就清 ——
    // 客户端拿它弹一句「已回到房间」，否则玩家会以为房间被人重置了。
    back.resumedAt = Date.now();
    return { ok: true, room: room, member: back, resumed: true };
  }

  if (room.members.length >= room.maxPlayers) {
    return { ok: false, code: 'ROOM_FULL', msg: '房间已满（' + room.maxPlayers + ' 人）' };
  }

  // 从别的房间过来：先退旧的
  if (conn.roomCode && conn.roomCode !== code) manager.leaveRoom(connId);

  // 房主兜底（必须放在算 ready 之前）。
  // 两种情况下房主位会空着：房主自己走了没人接手、或者「全员从大厅页跳到游戏页」
  // 导致所有人一起断线（leaveRoom 移交房主时名单是空的了）。
  // 这时把房主交给下一个进来的人 —— 不兜底的话这个房间再也没人能点「开始对局」，
  // 一屋子人会卡在候场室里干瞪眼。
  const hostStillHere = room.hostConnId && indexOfMember(room, room.hostConnId) >= 0;
  if (!hostStillHere) room.hostConnId = connId;

  const member = {
    connId: connId,
    userId: conn.userId,
    nickname: conn.nickname,
    isGuest: conn.isGuest,
    avatar: conn.avatar || '',          // 跟随连接上的头像，进房时带进来
    charId: manager.normalizeCharId(opts.charId, conn.isGuest),
    // 只有房主默认就算准备好（他是按「开始对局」的人）
    ready: connId === room.hostConnId,
    slot: pickFreeSlot(room),
    connected: true,
    offAt: 0,                            // 0 = 还在（见文件头 members 结构的注释）
    joinedAt: Date.now()
  };
  room.members.push(member);
  // 按座位号排序，界面里成员顺序整局都不会跳
  room.members.sort(function (a, b) { return a.slot - b.slot; });
  conn.roomCode = code;
  conn.status = 'lobby';

  return { ok: true, room: room, member: member };
};

// 退房：返回被摘掉的那个成员，方便上层知道「谁走了」好播报。
// 房主走了要把房主交给下一个还在线的人，否则这个房间再也没人能点「开始」。
//
// 【断线 vs 主动离开】这是本文件最需要小心的一处分叉：
//   · 主动离开（点了「离开房间」）→ 立刻摘掉，房间空了就销毁。这是玩家明确表达的意图。
//   · 断线（关页面、切后台、网络抖）→ **只打离场时间戳，不摘**。宽限期内回来能接回原座位。
// 以前两种都走「立刻摘掉」，于是房里最后一个人一断线房间当场销毁 ——
// 房主刷新一下页面，昨晚发给队友的房间号就作废了；而两个人里掉线的那个
// （房间还活着）回来后 connId 已经是新的，会被当成新的人分到新座位、丢掉房主身份。
// 现在这层靠 opts.offline 区分。
manager.leaveRoom = function (connId, opts) {
  opts = opts || {};
  const conn = conns[connId];
  const code = conn ? conn.roomCode : '';
  if (!code) return null;

  const room = rooms[code];
  if (conn) conn.roomCode = '';

  if (!room) return null;

  const idx = indexOfMember(room, connId);
  if (idx < 0) return { room: room, gone: null };

  // 断线：只标记，不摘
  if (opts.offline) {
    room.members[idx].connected = false;
    room.members[idx].offAt = Date.now();
    // 【房主掉线不移交】他多半只是刷新了页面。移交给别人的话，
    // 他回来就得靠 identityKey 把房主位再抢回来 —— 而「谁是正房主」在
    // 队友眼里会闪现一次跳变。留着不动，代价只是「房主不在时没人能点开始」，
    // 那本来也该是他自己不在造成的。宽限期到了 sweep 会移交。
    return { room: room, gone: null, offline: true, member: room.members[idx] };
  }

  const gone = room.members.splice(idx, 1)[0];

  // 房主移交：优先给在线的人，其次给还在名单里的任何一个人
  if (room.hostConnId === connId) {
    let next = '';
    for (let i = 0; i < room.members.length; i++) {
      if (room.members[i].connected) { next = room.members[i].connId; break; }
    }
    if (!next && room.members.length) next = room.members[0].connId;
    room.hostConnId = next;
  }

  // 房空了就销毁；但对局进行中的房间要留着，等 match 那边收尾后再清
  if (room.members.length === 0 && room.state !== 'playing') {
    delete rooms[code];
    return { room: room, gone: gone, destroyed: true };
  }

  return { room: room, gone: gone };
};

// 宽限期到期的席位回收。由 index.js 的定时器周期调用（见 sweepExpiredRoom 的调用点）。
//
// 做两件事：
//   ① 把「掉线超过宽限期」的成员真摘掉（顺手在该交房主的时候移交）
//   ② 把因此变空的等待中房间销毁
//
// **必须由定时器驱动，不能靠「有人来访问时顺便扫」**：
// 一间没人再碰的房间，大厅列表可能压根没人拉（页面都关了），
// 那它就永远清不掉 —— 既泄漏内存，又会在下次有人拉列表时冒出来一个
// 点进去必然报「房间不存在」的僵尸房间。
manager.sweep = function () {
  const now = Date.now();
  const codes = Object.keys(rooms);
  for (let i = 0; i < codes.length; i++) {
    const room = rooms[codes[i]];
    if (!room) continue;

    let changed = false;
    // 从后往前摘：splice 改了数组长度，正着走会漏掉元素
    for (let k = room.members.length - 1; k >= 0; k--) {
      const m = room.members[k];
      if (m.connected || !m.offAt) continue;
      if (now - m.offAt <= ROOM_KEEP_MS) continue;

      room.members.splice(k, 1);
      changed = true;
      if (room.hostConnId === m.connId) {
        // 房主掉线超过宽限期了：移交给下一个还在线的人；一个都不剩就空着
        // （下面的「空了就销毁」会把这间房收掉）
        let next = '';
        for (let j = 0; j < room.members.length; j++) {
          if (room.members[j].connected) { next = room.members[j].connId; break; }
        }
        room.hostConnId = next;
      }
    }
    if (!changed) continue;

    // 对局中的房间交给 match 那边收尾，这里不碰（否则会打乱那一局的成员映射）
    if (!room.members.length && room.state !== 'playing') {
      delete rooms[codes[i]];
      continue;
    }
    // 名单变了要通知剩下的人：有人被判定「超时不回来了」，
    // 否则队友会一直看着一个永远不再出现的「已掉线」成员
    if (room.members.length && manager.onSwept) manager.onSwept(room);
  }
};

// sweep 发现成员被回收时的通知钩子。由协议层注入（emitRoom + 刷新大厅列表）。
// 留成可注入的函数而不是在 manager 里直接 require proto ——
// 那会立刻变成一个环（proto → manager → proto），node 会直接报循环依赖。
manager.onSwept = null;

manager.setReady = function (connId, ready) {
  const room = manager.roomOfConn(connId);
  if (!room) return null;
  const idx = indexOfMember(room, connId);
  if (idx < 0) return null;
  // 房主固定算准备好：他自己就是发起人，让他还得点一次「准备」纯属添堵
  room.members[idx].ready = room.members[idx].connId === room.hostConnId ? true : !!ready;
  return room;
};

manager.setChar = function (connId, charId) {
  const room = manager.roomOfConn(connId);
  if (!room) return null;
  const idx = indexOfMember(room, connId);
  if (idx < 0) return null;
  const m = room.members[idx];
  m.charId = manager.normalizeCharId(charId, m.isGuest);
  return room;
};

manager.getRoom = function (code) {
  return rooms[code] || null;
};

// 改难度：只有房主能改，而且只能在开局前改（开局后再改会让已经跑起来的世界
// 与房间显示不一致 —— 那一局用的是旧倍率）。
// 返回 { ok, room } 或 { ok:false, code, msg }，由调用方决定怎么回给客户端。
manager.setDifficulty = function (connId, diffId) {
  const room = manager.roomOfConn(connId);
  if (!room) return { ok: false, code: 'NOT_IN_ROOM', msg: '你还没有加入房间' };
  if (room.hostConnId !== connId) return { ok: false, code: 'NOT_HOST', msg: '只有房主能改难度' };
  if (room.state !== 'waiting') return { ok: false, code: 'ROOM_PLAYING', msg: '对局已经开始，改不了了' };

  room.difficulty = C.normalizeDiffId(diffId);
  return { ok: true, room: room };
};

// 房主改地图。与 setDifficulty 完全同构：只有房主能改、开局后锁定。
// 非法 id 回落默认图（mapById 内部处理），与建房时的行为一致 ——
// 「传了乱码」不该让建房失败，也不该让房间进到一个不存在的地图。
manager.setMap = function (connId, mapId) {
  const room = manager.roomOfConn(connId);
  if (!room) return { ok: false, code: 'NOT_IN_ROOM', msg: '你还没有加入房间' };
  if (room.hostConnId !== connId) return { ok: false, code: 'NOT_HOST', msg: '只有房主能换地图' };
  if (room.state !== 'waiting') return { ok: false, code: 'ROOM_PLAYING', msg: '对局已经开始，改不了了' };

  room.mapId = M.mapById(mapId).id;
  return { ok: true, room: room };
};

manager.roomOfConn = function (connId) {
  const conn = conns[connId];
  if (!conn || !conn.roomCode) return null;
  return rooms[conn.roomCode] || null;
};

manager.memberOf = function (room, connId) {
  if (!room) return null;
  const idx = indexOfMember(room, connId);
  return idx < 0 ? null : room.members[idx];
};

// 标记某人掉线（不立刻踢出名单，让队友能看见「他掉了」）
manager.setConnected = function (connId, connected) {
  const room = manager.roomOfConn(connId);
  if (!room) return null;
  const idx = indexOfMember(room, connId);
  if (idx < 0) return null;
  room.members[idx].connected = !!connected;
  return room;
};

manager.setRoomState = function (code, state) {
  const room = rooms[code];
  if (!room) return null;
  room.state = state;
  if (state === 'playing') room.startedAt = Date.now();
  return room;
};

manager.destroyRoom = function (code) {
  const room = rooms[code];
  if (!room) return null;
  for (let i = 0; i < room.members.length; i++) {
    const conn = conns[room.members[i].connId];
    if (conn && conn.roomCode === code) conn.roomCode = '';
  }
  delete rooms[code];
  return room;
};

// 全部成员都准备好（房主天然算准备好）+ 至少要有一个人
manager.canStart = function (room) {
  if (!room || room.state !== 'waiting') return false;
  if (!room.members.length) return false;
  for (let i = 0; i < room.members.length; i++) {
    if (!room.members[i].ready) return false;
  }
  return true;
};

// 房间列表（大厅「加入房间」用）：只暴露公开信息，不带 connId
//
// stateAt：外部（协议层）注入的「这一房间号当前对应的对局状态」查询函数。
// 【为什么需要它】房间自己的 state 在对局结束后要等 match 收尾才改回 waiting，
// 而 match 那边「人走光 → finish」的时机更早。那中间的空档里，房间仍以
// 「对局中」出现在列表里 —— 玩家点进去/点观战必然失败，表现成
// 「按钮在、点了就说结束了」。这个钩子让列表按**世界的真实状态**显示。
manager.stateAt = null;
manager.listRooms = function () {
  const out = [];
  const codes = Object.keys(rooms);
  for (let i = 0; i < codes.length; i++) {
    const r = rooms[codes[i]];
    const host = manager.memberOf(r, r.hostConnId);
    // 以对局的真实状态为准：房间说 playing、对局说 ended（人走光了）时，
    // 按 playing 显示就是在骗人。
    let state = r.state;
    if (r.state === 'playing' && manager.stateAt) {
      const live = manager.stateAt(r.code);
      if (live === 'ended' || live === null) state = 'ended';
    }
    out.push({
      code: r.code,
      state: state,
      memberCount: r.members.length,
      maxPlayers: r.maxPlayers,
      host: host ? host.nickname : '-',
      // 难度要出现在大厅的房间列表里：这是选桌的主要依据之一 ——
      // 「我想打噩梦」的人不该先进候场室才知道这桌是休闲
      difficulty: r.difficulty || 'normal',
      // 地图同理：选桌时就得知道这局打在哪张图上
      mapId: r.mapId || M.DEFAULT_MAP_ID,
      canJoin: (state === 'waiting' || state === 'ended') && r.members.length < r.maxPlayers
    });
  }
  // 等待中的房间排前面，其次按创建时间倒序（新房间更容易被看到）
  out.sort(function (a, b) {
    if ((a.state === 'waiting') !== (b.state === 'waiting')) {
      return a.state === 'waiting' ? -1 : 1;
    }
    return 0;
  });
  return out;
};

// 房间对外结构（给客户端渲染等待室）。
// 刻意不暴露 connId：那是服务端内部标识，客户端只需要 slot 就够定位玩家了。
manager.roomView = function (room) {
  if (!room) return null;
  const now = Date.now();
  const members = [];
  for (let i = 0; i < room.members.length; i++) {
    const m = room.members[i];
    const one = {
      slot: m.slot,
      nickname: m.nickname,
      isGuest: m.isGuest,
      avatar: m.avatar,
      charId: m.charId,
      ready: m.ready,
      connected: m.connected,
      host: m.connId === room.hostConnId,
      self: false            // 由调用方按自己的 connId 置 true
    };
    // 掉线的人还剩多久会被移出名单。候场室据此显示「他掉线了，30 秒后移出」，
    // 而不是让人对着一个永远不动的「已掉线」猜。宽限期内一律给秒数。
    if (!m.connected && m.offAt) {
      one.offlineLeftSec = Math.max(0, Math.ceil((ROOM_KEEP_MS - (now - m.offAt)) / 1000));
    }
    // 「这是接回断线前的席位」标记。只给本人看（调用方按 self 过滤）。
    // 读完就清：不能让它一直挂着，否则每次广播都弹一遍提示。
    if (m.resumedAt) {
      one.resumed = true;
      m.resumedAt = 0;
    }
    members.push(one);
  }
  return {
    code: room.code,
    state: room.state,
    maxPlayers: room.maxPlayers,
    // 难度：房主能改、其余人只读（界面据此决定选择器是否可点）
    difficulty: room.difficulty || 'normal',
    // 地图：同样是房主能改
    mapId: room.mapId || M.DEFAULT_MAP_ID,
    hostSlot: (function () {
      const h = manager.memberOf(room, room.hostConnId);
      return h ? h.slot : -1;
    })(),
    canStart: manager.canStart(room),
    members: members
  };
};

module.exports = manager;
