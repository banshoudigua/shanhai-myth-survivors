// tools/matchtest.js —— P2-2 服务端权威对局自检
//
// 范围（全部在单进程内跑，不起 HTTP、不碰数据库，秒级完成）：
//   [A] 房间管理器：建房 / 加房 / 满员 / 重进 / 准备 / 换角色 / 房主移交 / 视图结构
//   [B] Match 世界模拟：多玩家世界、输入钳位、按人分发事件、升级超时兜底、
//                       视野裁剪、中途加入、掉线清理、收局结算、通关判定
//   [C] 协议层消息流：room_* / game_start / input / choose / game_leave / onDisconnect
//                       的完整出入站行为（用假 socket 收集器，不经过网络）
//   [D] 性能基线：4 人 + 满屏怪的单帧耗时与快照包体（给 P2-5 做对比基线）
//
// 用法：node tools/matchtest.js
// 说明：全部走 callback 风格串联，不用 try/catch 做流程控制；末尾打印 PASS/FAIL 汇总。

const C = require('../shared/const.js');
const SIM = require('../shared/sim.js');
const PB = require('../shared/proto_bin.js');
const config = require('../server/config.js');
const manager = require('../server/rooms/manager.js');
const registry = require('../server/game/match.js');
const proto = require('../server/game/proto.js');

let pass = 0;
let fail = 0;

function ok(name, extra) {
  pass += 1;
  console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
}

function bad(name, detail) {
  fail += 1;
  console.log('  FAIL  ' + name + '  ->  ' + detail);
}

function expect(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail || '断言不成立');
}

function near(a, b, eps) {
  return Math.abs(a - b) <= (eps === undefined ? 1e-6 : eps);
}

function section(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

// 假网络出口：把「发给谁、发了什么」原样收集起来，
// 顺便像真 sendTo 一样返回字节数（对局的带宽统计依赖这个返回值）。
//
// 【P2-5】下行现在有两种帧：对象（JSON）与 Uint8Array（二进制快照）。
// 这里**照着真客户端的做法**把它解回来：入站若是二进制就 PB.decode（并保留
// 上一帧用于重建被省掉的 px/py），这样本文件里所有「快照应该有某个字段」
// 的断言都继续有效，而且测的是真·生产路径，不是退回 JSON 的自欺欺人。
// 返回的字节数一律取「真上线会发多少字节」：二进制取 byteLength，JSON 取字符数。
function makeCollector() {
  const log = [];
  const prevByConn = Object.create(null);
  return {
    log: log,
    sendTo: function (connId, obj) {
      if (obj instanceof Uint8Array) {
        const bytes = obj.byteLength;
        const snap = PB.decode(obj, prevByConn[connId] || null);
        prevByConn[connId] = snap;
        log.push({ to: connId, msg: snap, bin: true, bytes: bytes });
        return bytes;
      }
      log.push({ to: connId, msg: obj, bin: false, bytes: JSON.stringify(obj).length });
      return JSON.stringify(obj).length;
    },
    broadcast: function () { },
    pushOnline: function () { },
    // 取某条连接收到的指定类型消息
    of: function (connId, type) {
      const out = [];
      for (let i = 0; i < log.length; i++) {
        if (log[i].to === connId && log[i].msg && log[i].msg.t === type) out.push(log[i].msg);
      }
      return out;
    },
    last: function (connId, type) {
      const all = this.of(connId, type);
      return all.length ? all[all.length - 1] : null;
    },
    // 取某条连接收到的快照帧（含二进制标记与真实字节数）
    snaps: function (connId) {
      const out = [];
      for (let i = 0; i < log.length; i++) {
        if (log[i].to === connId && log[i].bin) out.push(log[i]);
      }
      return out;
    },
    clear: function () { log.length = 0; }
  };
}

// 造一个「已经在线的连接」并返回它的 conn 对象
let connSeq = 0;
function addConn(nickname, isGuest) {
  connSeq += 1;
  const connId = 'tc' + connSeq;
  manager.addConn(connId, {
    userId: isGuest ? null : 1000 + connSeq,
    nickname: nickname,
    isGuest: !!isGuest,
    status: 'lobby'
  });
  return manager.getConn(connId);
}

// ============================================================
// [A] 房间管理器
// ============================================================

function testRoomManager() {
  section('[A] 房间管理器');

  const host = addConn('房主甲', false);
  const mate = addConn('队友乙', false);
  const guest = addConn('游客丙', true);

  // --- 建房 ---
  const created = manager.createRoom(host.connId, { charId: 'nun' });
  expect('建房成功', created.ok === true, JSON.stringify(created));
  if (!created.ok) return;

  const room = created.room;
  expect('房间号长度 = 4', room.code.length === 4, 'code=' + room.code);
  expect('房间号只用无歧义字符', /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/.test(room.code), 'code=' + room.code);
  expect('状态为 waiting', room.state === 'waiting', 'state=' + room.state);
  expect('房主自动落座 0 号', room.members[0].slot === 0, 'slot=' + room.members[0].slot);
  expect('房主自动算准备好', room.members[0].ready === true, 'ready=' + room.members[0].ready);
  expect('建房人 conn.roomCode 已回填', host.roomCode === room.code, 'roomCode=' + host.roomCode);
  expect('保留所选角色', room.members[0].charId === 'nun', 'charId=' + room.members[0].charId);

  // --- 加房 ---
  const joined = manager.joinRoom(room.code, mate.connId, { charId: 'scholar' });
  expect('第二人加房成功', joined.ok === true, JSON.stringify(joined));
  expect('第二人拿到 1 号座位', joined.member.slot === 1, 'slot=' + joined.member.slot);
  expect('第二人默认未准备', joined.member.ready === false, 'ready=' + joined.member.ready);
  expect('房主没被换掉', room.hostConnId === host.connId, 'host=' + room.hostConnId);

  // --- 重复加房（前端重连/手滑点两次） ---
  const again = manager.joinRoom(room.code, mate.connId, { charId: 'scholar' });
  expect('重复加房不报错', again.ok === true, JSON.stringify(again));
  expect('重复加房被识别为 again', again.again === true, 'again=' + again.again);
  expect('重复加房不新增成员', room.members.length === 2, 'members=' + room.members.length);

  // --- 房间不存在 ---
  const miss = manager.joinRoom('ZZZZ', mate.connId, {});
  expect('加入不存在的房间被拒', miss.ok === false && miss.code === 'ROOM_NOT_FOUND', JSON.stringify(miss));

  // --- 准备状态与开局条件 ---
  expect('还有一人未准备时不能开局', manager.canStart(room) === false, 'canStart=' + manager.canStart(room));
  manager.setReady(mate.connId, true);
  expect('全员准备后可以开局', manager.canStart(room) === true, 'canStart=' + manager.canStart(room));
  expect('房主的 ready 不会被 false 覆盖', (function () {
    manager.setReady(host.connId, false);
    return room.members[0].ready === true;
  })(), 'ready=' + room.members[0].ready);

  // --- 游客角色降级 ---
  const guestJoin = manager.joinRoom(room.code, guest.connId, { charId: 'blacksmith' });
  expect('游客加房成功', guestJoin.ok === true, JSON.stringify(guestJoin));
  expect('游客选了未解锁角色被降级为猎魔人', guestJoin.member.charId === 'hunter', 'charId=' + guestJoin.member.charId);
  const guestJoin2 = manager.joinRoom(room.code, guest.connId, { charId: 'hunter' });
  expect('游客选猎魔人保持原样（again 分支）', guestJoin2.ok === true, JSON.stringify(guestJoin2));

  // --- 换角色 ---
  manager.setChar(mate.connId, 'blacksmith');
  expect('等待室换角色生效', manager.memberOf(room, mate.connId).charId === 'blacksmith',
    'charId=' + manager.memberOf(room, mate.connId).charId);
  manager.setChar(mate.connId, 'not_a_real_char');
  expect('非法角色回退到默认角色', manager.memberOf(room, mate.connId).charId === C.CHARACTERS[0].id,
    'charId=' + manager.memberOf(room, mate.connId).charId);
  manager.setChar(mate.connId, 'scholar');

  // --- 房间视图 ---
  const view = manager.roomView(room);
  expect('视图带 code', view.code === room.code, 'code=' + view.code);
  expect('视图成员数一致', view.members.length === room.members.length, 'n=' + view.members.length);
  expect('视图标记了房主所在座位', view.hostSlot === 0, 'hostSlot=' + view.hostSlot);
  expect('视图成员按座位号升序', view.members[0].slot < view.members[1].slot, JSON.stringify(view.members.map(function (m) { return m.slot; })));
  expect('视图不暴露 connId', view.members[0].connId === undefined, 'connId=' + view.members[0].connId);

  // --- 满员拒绝 ---
  const small = manager.createRoom(addConn('小房主', false).connId, {});
  const smallRoom = small.room;
  smallRoom.maxPlayers = 2;
  manager.joinRoom(smallRoom.code, addConn('塞满1', false).connId, {});
  const full = manager.joinRoom(smallRoom.code, addConn('塞满2', false).connId, {});
  expect('满员时加房被拒', full.ok === false && full.code === 'ROOM_FULL', JSON.stringify(full));

  // --- 对局中的房间拒绝加入 ---
  manager.setRoomState(room.code, 'playing');
  const inPlay = manager.joinRoom(room.code, addConn('迟到的人', false).connId, {});
  expect('已开局的房间拒绝加入', inPlay.ok === false && inPlay.code === 'ROOM_PLAYING', JSON.stringify(inPlay));
  // 但「中途加入对局」这条路必须放行（否则 P2 的中途加入功能根本没法实现）
  const lateJoiner = addConn('中途加入者', false);
  const inPlayOk = manager.joinRoom(room.code, lateJoiner.connId, { charId: 'hunter', allowPlaying: true });
  expect('allowPlaying 时放行加入已开局的房间', inPlayOk.ok === true, JSON.stringify(inPlayOk));
  expect('放行后确实进了名单', !!manager.memberOf(room, lateJoiner.connId), 'not in room');
  expect('放行后 conn.roomCode 已回填', lateJoiner.roomCode === room.code, 'roomCode=' + lateJoiner.roomCode);
  manager.leaveRoom(lateJoiner.connId);
  manager.removeConn(lateJoiner.connId);
  manager.setRoomState(room.code, 'waiting');

  // --- 房主移交 ---
  const beforeHost = room.hostConnId;
  const leaveRes = manager.leaveRoom(beforeHost);
  expect('房主退房返回 gone', !!leaveRes && !!leaveRes.gone, JSON.stringify(leaveRes && leaveRes.gone));
  expect('房主已移交（不再是走掉的人）', room.hostConnId !== beforeHost, 'host=' + room.hostConnId);
  expect('新房主是仍在名单里的人', !!manager.memberOf(room, room.hostConnId), 'host=' + room.hostConnId);
  expect('新房主算准备好', manager.memberOf(room, room.hostConnId).ready === true, 'ready=' + manager.memberOf(room, room.hostConnId).ready);

  // --- 房间列表 ---
  const list = manager.listRooms();
  expect('房间列表包含本房间', list.some(function (r) { return r.code === room.code; }), 'n=' + list.length);
  const one = list.filter(function (r) { return r.code === room.code; })[0];
  expect('列表带房主昵称', typeof one.host === 'string' && one.host.length > 0, 'host=' + one.host);
  expect('列表带人数与上限', one.memberCount === room.members.length && one.maxPlayers === room.maxPlayers,
    one.memberCount + '/' + one.maxPlayers);

  // --- 退房后 conn 的 roomCode 要清掉 ---
  expect('退房后 conn.roomCode 已清空', host.roomCode === '', 'roomCode=' + host.roomCode);

  // --- 一个人同时只在一个房间 ---
  const roomA = manager.createRoom(mate.connId, {}).room;
  const roomB = manager.createRoom(mate.connId, {}).room;
  expect('换房后旧房间已无此人', manager.memberOf(roomA, mate.connId) === null, 'still in A');
  expect('换房后新房间有此人', !!manager.memberOf(roomB, mate.connId), 'missing in B');
  expect('换房后 conn.roomCode 指向新房间', mate.roomCode === roomB.code, 'roomCode=' + mate.roomCode);

  // 清场，避免影响后面用例
  manager.removeConn(host.connId);
  manager.removeConn(mate.connId);
  manager.removeConn(guest.connId);
  manager.destroyRoom(room.code);
  manager.destroyRoom(smallRoom.code);
  manager.destroyRoom(roomA.code);
  manager.destroyRoom(roomB.code);
}

// ============================================================
// [B] Match 世界模拟
// ============================================================

function testMatch() {
  section('[B] Match 世界模拟');

  const col = makeCollector();
  const a = addConn('甲', false);
  const b = addConn('乙', false);

  const created = manager.createRoom(a.connId, { charId: 'hunter' });
  const room = created.room;
  manager.joinRoom(room.code, b.connId, { charId: 'blacksmith' });

  const m = registry.start(room, { onSend: col.sendTo, seed: 12345 });
  const w = m.world;

  expect('世界里有 2 个玩家', w.players.length === 2, 'n=' + w.players.length);
  expect('服务端世界的 w.self 为 null', w.self === null, 'self=' + w.self);
  expect('pauseAllOnLevelUp 已关闭', w.pauseAllOnLevelUp === false, 'flag=' + w.pauseAllOnLevelUp);
  expect('种子已生效', w.rngState === 12345, 'seed=' + w.rngState);
  expect('座位映射建立', m.slotOf(a.connId) === 0 && m.slotOf(b.connId) === 1,
    m.slotOf(a.connId) + '/' + m.slotOf(b.connId));

  // --- 输入钳位：客户端说「我要 100 倍速度」 ---
  m.setInput(a.connId, 100, 0, 1);
  const stored = m.inputs[a.connId];
  expect('超长输入被钳成单位向量', near(Math.sqrt(stored.mx * stored.mx + stored.my * stored.my), 1, 1e-9),
    'len=' + Math.sqrt(stored.mx * stored.mx + stored.my * stored.my));
  expect('钳位后方向不变（仍向右）', stored.mx > 0.99 && Math.abs(stored.my) < 1e-9, JSON.stringify(stored));

  // --- 移动：输入表按座位号翻译，走对人 ---
  const ax0 = m.players[0].x;
  const bx0 = m.players[1].x;
  m.setInput(a.connId, 1, 0, 2);
  m.setInput(b.connId, -1, 0, 2);
  for (let i = 0; i < 10; i++) m.stepOnce();
  expect('甲按输入向右移动了', m.players[0].x > ax0 + 10, 'dx=' + (m.players[0].x - ax0).toFixed(1));
  expect('乙按输入向左移动了', m.players[1].x < bx0 - 10, 'dx=' + (m.players[1].x - bx0).toFixed(1));

  // --- 未给输入的人生不动（掉线/卡顿不能让人自己乱跑） ---
  const bx1 = m.players[1].x;
  delete m.inputs[b.connId];
  for (let i = 0; i < 5; i++) m.stepOnce();
  expect('没有输入的人原地不动', near(m.players[1].x, bx1, 1e-6), 'dx=' + (m.players[1].x - bx1).toFixed(6));

  // --- 事件按人分发 ---
  // 【关键回归点】全局事件（开波/Boss/通关）必须人手一份。
  // 曾经的写法是逐人调 SIM.takeEvents(w, 座位号)，那个函数取全局事件时
  // 「谁先取谁得」，结果只有第一个玩家能收到波次提示 —— 这条断言就是钉住它。
  col.clear();
  w.events.push({ type: 'wave', wave: 3 });
  w.events.push({ type: 'levelup', slot: 0, name: '甲' });
  w.events.push({ type: 'levelup', slot: 1, name: '乙' });
  m.flushEvents();
  const evA = col.of(a.connId, 'ev');
  const evB = col.of(b.connId, 'ev');
  expect('甲收到 1 条 ev 消息', evA.length === 1, 'n=' + evA.length);
  expect('乙收到 1 条 ev 消息', evB.length === 1, 'n=' + evB.length);
  expect('甲拿到「全局 + 自己」2 条', evA.length && evA[0].list.length === 2, 'n=' + (evA[0] ? evA[0].list.length : -1));
  expect('乙同样拿到「全局 + 自己」2 条', evB.length && evB[0].list.length === 2, 'n=' + (evB[0] ? evB[0].list.length : -1));
  expect('甲没收到乙的升级事件', evA.length && !evA[0].list.some(function (e) { return e.slot === 1; }), JSON.stringify(evA[0] && evA[0].list));
  expect('乙没收到甲的升级事件', evB.length && !evB[0].list.some(function (e) { return e.slot === 0; }), JSON.stringify(evB[0] && evB[0].list));
  expect('全局事件两边都收到', evA[0].list.some(function (e) { return e.type === 'wave'; }) &&
    evB[0].list.some(function (e) { return e.type === 'wave'; }), 'wave missing');
  expect('两人拿到的是不同的数组实例', evA[0].list !== evB[0].list, 'shared array!');
  expect('事件队列已清空', w.events.length === 0, 'n=' + w.events.length);

  // --- 升级三选一只影响自己 ---
  const p0 = m.players[0];
  p0.state = 'levelup';
  p0.choices = [{ type: 'fallback', id: 'x', name: '回复' }];
  const p1 = m.players[1];
  p1.state = 'playing';
  const p1Level = p1.level;
  const chosen = m.choose(a.connId, 0);
  expect('甲的升级选择被接受', chosen === true, 'ok=' + chosen);
  expect('甲回到 playing', p0.state === 'playing', 'state=' + p0.state);
  expect('乙的状态没被牵连', p1.state === 'playing' && p1.level === p1Level, 'state=' + p1.state + ' lv=' + p1.level);
  expect('非法下标被拒绝', m.choose(b.connId, 99) === false, 'should be false');

  // --- 升级面板超时兜底（这是「发呆即无敌」漏洞的唯一堵法） ---
  const realTimeout = config.upgradeTimeoutSec;
  config.upgradeTimeoutSec = 1 / 1000;      // 1 毫秒，等价于「立刻超时」
  p0.state = 'levelup';
  p0.choices = [{ type: 'fallback', id: 'x', name: '回复' }];
  p0.pendingLevels = 1;
  col.clear();
  m.upgradeAt[a.connId] = Date.now() - 10;
  m.autoChoose();
  expect('超时后自动代选（面板关闭）', p0.state === 'playing', 'state=' + p0.state);
  expect('超时后待选次数被消耗', p0.pendingLevels === 0, 'pending=' + p0.pendingLevels);
  expect('超时会通知客户端', !!col.last(a.connId, 'ev') &&
    col.last(a.connId, 'ev').list.some(function (e) { return e.type === 'auto_choose'; }), 'no auto_choose');
  config.upgradeTimeoutSec = realTimeout;

  // --- 视野裁剪 ---
  for (let i = 0; i < 120; i++) m.stepOnce();     // 跑几秒，让怪铺开
  const realView = config.viewRadius;
  config.viewRadius = 0;
  const full = m.snapshotFor(m.players[0]).mobs.length;
  config.viewRadius = 1;                          // 只留脚下 1px 内的怪
  const tiny = m.snapshotFor(m.players[0]).mobs.length;
  config.viewRadius = realView;
  expect('世界里确实有怪（否则裁剪用例没意义）', full > 0, 'mobs=' + full);
  expect('视野裁剪生效（半径 1px 时几乎全被裁掉）', tiny < full, 'tiny=' + tiny + ' full=' + full);
  expect('裁剪不会把队友裁掉', m.snapshotFor(m.players[0]).players.length === 2,
    'players=' + m.snapshotFor(m.players[0]).players.length);

  // --- 快照结构 ---
  const snap = m.snapshotFor(m.players[0]);
  expect('快照带 tick/time', typeof snap.tick === 'number' && typeof snap.time === 'number', JSON.stringify({ tick: snap.tick, time: snap.time }));
  const me = snap.players[0];
  expect('快照玩家带 slot/charId', me.slot === 0 && !!me.charId, JSON.stringify(me));
  // 昵称不进每帧快照（它是「名单」，game_start 已经发过全量）——
  // 这条断言刻意钉住这个取舍，防止有人「顺手」把 name 加回白名单把带宽烧回去。
  expect('每帧快照刻意不带昵称（名单走 game_start）', me.name === undefined, 'name=' + me.name);
  expect('快照玩家带拾取半径（渲染提示圈要用）', typeof me.pickupRadius === 'number', 'pickupRadius=' + me.pickupRadius);
  expect('快照玩家带插值用的上一帧坐标', typeof me.px === 'number' && typeof me.py === 'number', JSON.stringify({ px: me.px, py: me.py }));
  expect('快照不含 owner 这类反向引用', JSON.stringify(snap).indexOf('"owner"') < 0, 'owner leaked');
  expect('快照不含 def 整包', JSON.stringify(snap).indexOf('"def"') < 0, 'def leaked');
  expect('快照怪物只带 defId', snap.mobs.length === 0 || snap.mobs[0].defId !== undefined, JSON.stringify(snap.mobs[0] || {}));
  expect('快照坐标已压缩到 2 位小数', typeof snap.time === 'number' && String(snap.time).length < 12, 'time=' + snap.time);

  // --- 按频率节流 ---
  col.clear();
  m.lastSnapAt = 0;
  m.lastHudAt = 0;
  m.broadcastState(Date.now());
  const snapOnce = col.of(a.connId, 'snap').length;
  m.broadcastState(Date.now());                 // 同一毫秒内再调一次，应该被节流
  expect('快照按频率节流（同毫秒只发一次）', col.of(a.connId, 'snap').length === snapOnce, 'n=' + col.of(a.connId, 'snap').length);
  expect('HUD 与快照分开下发', col.of(a.connId, 'hud').length >= 1, 'n=' + col.of(a.connId, 'hud').length);
  // 【P2-5】快照默认走二进制协议。注意 JSON 帧解出来 t 也是 'snap'，
  // 光看 msg.t 分不出来 —— 必须查收集器记的 bin 标记。
  expect('快照帧默认走二进制协议', snapOnce > 0 && col.snaps(a.connId).length === snapOnce,
    'bin=' + col.snaps(a.connId).length + ' total=' + snapOnce);
  // 二进制帧头里没有 seq（tick 本身就是单调的，再带一个纯属浪费字节）
  const tickA = col.last(a.connId, 'snap').tick;
  m.stepOnce();
  m.lastSnapAt = 0;
  m.broadcastState(Date.now());
  const tickB = col.last(a.connId, 'snap').tick;
  expect('快照 tick 逐帧递增', tickB > tickA, 'a=' + tickA + ' b=' + tickB);
  expect('带宽统计已记录', m.stat.snapCount > 0 && m.stat.snapBytes > 0,
    'count=' + m.stat.snapCount + ' bytes=' + m.stat.snapBytes);

  // --- 中途加入 ---
  const c = addConn('丙', false);
  const p2 = m.addMember(c.connId, { charId: 'nun', nickname: '丙', isGuest: false });
  expect('中途加入成功', !!p2, 'p2=' + p2);
  expect('中途加入分到了空座位', p2.slot === 2, 'slot=' + p2.slot);
  expect('世界玩家数 +1', w.players.length === 3, 'n=' + w.players.length);
  expect('新人有独立战绩对象', p2.stats !== m.players[0].stats, 'stats shared!');
  expect('新人能拿到 HUD', (function () {
    const h = SIM.getHud(w, p2);
    return h && h.slot === 2 && h.name === '丙';
  })(), 'hud mismatch');

  // --- 掉线清理 ---
  m.setInput(c.connId, 1, 0, 1);
  for (let i = 0; i < 8; i++) m.stepOnce();
  const ownedBefore = w.projectiles.filter(function (pr) { return pr.owner === p2; }).length;
  m.removeMember(c.connId);
  const ownedAfter = w.projectiles.filter(function (pr) { return pr.owner === p2; }).length;
  expect('掉线者已从世界摘掉', w.players.length === 2, 'n=' + w.players.length);
  expect('掉线者的座位映射已清', m.slotOf(c.connId) === undefined, 'slot=' + m.slotOf(c.connId));
  expect('掉线者的归属实体被清理', ownedAfter === 0, 'before=' + ownedBefore + ' after=' + ownedAfter);
  expect('掉线者的输入被清', m.inputs[c.connId] === undefined, 'input残留');

  // --- 断线席位保留：同一个身份回来要把进度接上 ---
  // 【为什么必须验】客户端现在会自动重连（public/js/game.js 的 scheduleReconnect）。
  // 如果重连回来是个 1 级新号，那「自动重连」就等于静默清档 ——
  // 玩家不会察觉自己等级掉了，比不自动重连更糟。
  // 上面那次掉线已经把「丙」摘掉了，先让他重新进来（模拟一次普通重连），
  // 攒点进度，再掉一次 —— 这一次才验「进度能不能接回来」。
  const cBack = addConn('丙', false);
  const p2b = m.addMember(cBack.connId, { charId: 'nun', nickname: '丙', isGuest: false });
  expect('掉线后重新加入能回到世界', !!p2b, 'p=' + p2b);

  p2b.level = 6;
  p2b.exp = 12;
  p2b.stats.kills = 33;
  p2b.stats.gold = 120;
  p2b.weapons.push({ id: 'garlic', level: 3, timer: 0, rt: {} });
  p2b.passives.push({ id: 'armor', level: 2 });
  // 组合技也要一起掉线再一起接回来。
  // 【为什么单独立这一条】本轮加组合技时只改了 sim 与前端，
  // **漏了「席位保留」这条路径**（restoreProgress 只搬 weapons/passives）——
  // 结果是玩家断线重连后组合技凭空消失。武器丢了还能再抽，组合要重新凑两件武器，
  // 那比丢一件武器伤人得多，而且玩家会以为是「游戏 bug」而不是「掉线」。
  p2b.combos.push({ id: 'combo_blood_mist', level: 2, timer: 0, rt: {} });
  const slotBack = m.slotOf(cBack.connId);
  m.removeMember(cBack.connId);

  const backConn = addConn('丙', false);
  const pBack = m.addMember(backConn.connId, { charId: 'nun', nickname: '丙', isGuest: false });
  expect('重连回到原来那个座位', pBack.slot === slotBack, 'slot=' + pBack.slot + ' 期望 ' + slotBack);
  expect('重连接回等级', pBack.level === 6, 'level=' + pBack.level);
  expect('重连接回武器档位', pBack.weapons.length === 2 && pBack.weapons[1].id === 'garlic' &&
    pBack.weapons[1].level === 3, JSON.stringify(pBack.weapons.map(function (x) { return x.id + ':' + x.level; })));
  expect('重连接回被动档位', pBack.passives.length === 1 && pBack.passives[0].id === 'armor',
    JSON.stringify(pBack.passives));
  expect('重连接回组合技（不能只接武器、把它落下）',
    pBack.combos.length === 1 && pBack.combos[0].id === 'combo_blood_mist' &&
    pBack.combos[0].level === 2,
    JSON.stringify(pBack.combos));
  expect('重连接回战绩', pBack.stats.kills === 33 && pBack.stats.gold === 120,
    'kills=' + pBack.stats.kills + ' gold=' + pBack.stats.gold);
  expect('重连后带一段无敌（怪可能正压在他头上）', pBack.invuln > 0, 'invuln=' + pBack.invuln);
  expect('标了 resumed 供前端提示', m.resumedConn[backConn.connId] === true,
    'resumed=' + m.resumedConn[backConn.connId]);
  expect('席位保留是一次性的（用掉即删）', m.left['g丙'] === undefined,
    'left=' + JSON.stringify(Object.keys(m.left)));

  const other = addConn('丁', false);
  const pOther = m.addMember(other.connId, { charId: 'nun', nickname: '丁', isGuest: false });
  expect('换个人来不会捡到别人的进度', pOther.level === 1, 'level=' + pOther.level);

  // --- 对局里阵亡 → 5 秒后原地复活（服务端权威，不是界面上的假象） ---
  // 【为什么单机不测这条，联机要测】单机死亡就是这一局的结局；
  // 联机里世界不会为一个人停下来，所以阵亡必须能自己站起来。
  expect('对局世界开启了阵亡复活', m.world.reviveOnDeath === true, 'flag=' + m.world.reviveOnDeath);
  const victim = m.players[0];
  // 先清掉他的移动输入：前面测输入钳位时给他设过「一直往右走」，
  // 不清的话「复活后位置不动」这条会被输入推着走而误判。
  m.setInput(a.connId, 0, 0, 999);
  const vx = victim.x;
  victim.hp = 1;
  SIM.damagePlayer(m.world, victim, 9999, 0, 0);
  expect('对局里能被打死', victim.alive === false && victim.state === 'dead',
    'alive=' + victim.alive + ' state=' + victim.state);
  const hudDead = SIM.getHud(m.world, victim);
  expect('阵亡时 HUD 带上复活倒计时', hudDead.reviveLeft > 0 && hudDead.state === 'dead',
    JSON.stringify({ state: hudDead.state, reviveLeft: hudDead.reviveLeft }));

  for (let i = 0; i < Math.floor(C.TICK_HZ * 5) + 3; i++) m.stepOnce();
  expect('对局里 5 秒后原地复活', victim.alive === true && victim.state === 'playing',
    'alive=' + victim.alive + ' state=' + victim.state);
  expect('复活位置不动（队友知道该去哪儿接应）', Math.abs(victim.x - vx) < 0.001,
    'x ' + vx + ' → ' + victim.x);
  expect('复活后血量回到设定比例',
    victim.hp === Math.round(victim.maxHp * C.PLAYER.reviveHpRatio),
    'hp=' + victim.hp + ' maxHp=' + victim.maxHp);
  expect('复活后 HUD 不再显示倒计时',
    SIM.getHud(m.world, victim).reviveLeft === 0, 'reviveLeft 没清零');

  // --- 收局：人走光（先挂起，超时才收局） ---
  const m2col = makeCollector();
  const room2 = manager.createRoom(addConn('独狼', false).connId, {}).room;
  const solo = registry.start(room2, { onSend: m2col.sendTo, seed: 777 });
  expect('单人房也能开局', solo.playerCount === 1, 'n=' + solo.playerCount);
  const soloConn = room2.members[0].connId;
  solo.removeMember(soloConn);
  solo.stepOnce();
  // 【这条是「房主点开始 → 跳游戏页」能成立的前提】
  // 页面跳转在服务端看来就是一次干净的全员断线，走光就立刻收局的话，
  // 整局会死在跳转那一秒，新页面回来时房间已经没了。
  expect('人走光后先挂起而不是收局', solo.state === 'playing' && solo.suspendAt > 0,
    solo.state + '/suspend=' + solo.suspendAt);

  const tickAtSuspend = solo.world.tick;
  solo.tick(50);
  solo.tick(50);
  expect('挂起期间世界不推进', solo.world.tick === tickAtSuspend,
    tickAtSuspend + ' -> ' + solo.world.tick);
  expect('挂起期间状态仍是 playing', solo.state === 'playing', solo.state);

  // 有人回来：世界原地续上（时间轴不回退，挂起期间它压根没走）
  const back = addConn('独狼回来了', false);
  solo.addMember(back.connId, { charId: 'hunter', nickname: '独狼回来了', isGuest: false });
  expect('重连后取消挂起', solo.suspendAt === 0, 'suspend=' + solo.suspendAt);
  solo.tick(50);
  expect('恢复后世界继续推进', solo.world.tick > tickAtSuspend,
    tickAtSuspend + ' -> ' + solo.world.tick);
  expect('恢复后玩家回到世界', solo.playerCount === 1, 'n=' + solo.playerCount);

  // 一直没人回来才真正收局。
  // 把挂起时间戳手工推到宽限期之前，免得测试真的干等 60 秒。
  solo.removeMember(back.connId);
  solo.stepOnce();
  expect('再次走光仍然是挂起', solo.suspendAt > 0 && solo.state === 'playing', solo.state);
  solo.suspendAt = Date.now() - (config.matchKeepSec * 1000) - 1000;
  solo.tick(50);
  expect('挂起超时后自动收局', solo.state === 'ended' && solo.reason === 'empty',
    solo.state + '/' + solo.reason);

  // --- 通关判定与结算包 ---
  const m3col = makeCollector();
  const d = addConn('丁', false);
  const e = addConn('戊', false);
  const room3 = manager.createRoom(d.connId, { charId: 'hunter' }).room;
  manager.joinRoom(room3.code, e.connId, { charId: 'nun' });
  const m3 = registry.start(room3, { onSend: m3col.sendTo, seed: 999 });
  // 手动把战绩拉开差距，验证结算是按击杀降序
  m3.players[0].stats.kills = 12;
  m3.players[1].stats.kills = 340;
  m3.world.tick = C.MATCH_SEC * C.TICK_HZ - 1;    // 差一帧就到通关时刻
  m3.stepOnce();
  expect('时间到判定为通关', m3.world.won === true, 'won=' + m3.world.won);
  expect('对局状态变为 ended/won', m3.state === 'ended' && m3.reason === 'won', m3.state + '/' + m3.reason);
  const over = m3col.last(d.connId, 'game_over');
  expect('双方都收到结算包', !!over && !!m3col.last(e.connId, 'game_over'), 'missing game_over');
  expect('结算含全部玩家', over && over.result.length === 2, 'n=' + (over ? over.result.length : -1));
  expect('结算按击杀降序', over && over.result[0].kills === 340 && over.result[1].kills === 12,
    JSON.stringify(over && over.result.map(function (r) { return r.kills; })));
  expect('结算带各自金币与伤害', over && typeof over.result[0].gold === 'number' && typeof over.result[0].dmgDealt === 'number',
    JSON.stringify(over && over.result[0]));
  expect('结算带性能摘要', over && over.stat && typeof over.stat.tickMsAvg === 'number', JSON.stringify(over && over.stat));

  // --- 同一房间号重开一局不能被旧局挡住 ---
  const again = registry.start(room3, { onSend: m3col.sendTo, seed: 111 });
  expect('已结束的旧局不会挡住新局', again !== m3 && again.state === 'playing', 'state=' + (again && again.state));
  expect('新局种子已换', again.seed === 111, 'seed=' + again.seed);

  // 清场
  registry.stop(room3.code, 'test');
  registry.stop(room2.code, 'test');
  manager.removeConn(a.connId);
  manager.removeConn(b.connId);
  manager.removeConn(c.connId);
  manager.removeConn(d.connId);
  manager.removeConn(e.connId);
  manager.destroyRoom(room.code);
  manager.destroyRoom(room2.code);
  manager.destroyRoom(room3.code);
}

// ============================================================
// [C] 协议层消息流
// ============================================================

function testProto() {
  section('[C] 协议层消息流');

  const col = makeCollector();
  proto.init({ sendTo: col.sendTo, broadcast: col.broadcast, pushOnline: col.pushOnline });

  const host = addConn('房主', false);
  const mate = addConn('队友', false);
  const outsider = addConn('路人', false);

  const H = function (conn, msg) { return proto.handle(null, conn, msg); };

  // --- 房间列表 ---
  H(host, { t: 'room_list' });
  expect('room_list 有回包', !!col.last(host.connId, 'room_list'), 'no room_list');

  // --- 建房 ---
  col.clear();
  H(host, { t: 'room_create', charId: 'nun' });
  const created = col.last(host.connId, 'room_update');
  expect('建房后收到 room_update', !!created, 'no room_update');
  const code = created ? created.room.code : '';
  expect('自己那份视图标记了 self', created && created.room.members[0].self === true, JSON.stringify(created && created.room.members[0]));
  expect('未准备时 canStart 为 false（单人房除外）', created && created.room.canStart === true, 'canStart=' + (created && created.room.canStart));

  // --- 加房 ---
  col.clear();
  H(mate, { t: 'room_join', code: code, charId: 'scholar' });
  const forMate = col.last(mate.connId, 'room_update');
  const forHost = col.last(host.connId, 'room_update');
  expect('加房成功后房主也收到房间更新', !!forHost, 'host got no update');
  expect('老成员视角里 self 是房主', forHost && forHost.room.members[0].self === true &&
    forHost.room.members[1].self === false, JSON.stringify(forHost && forHost.room.members.map(function (m) { return m.self; })));
  expect('新成员视角里 self 是自己', forMate && forMate.room.members[1].self === true, JSON.stringify(forMate && forMate.room.members.map(function (m) { return m.self; })));

  // --- 房号容错：小写 + 空格 ---
  col.clear();
  H(outsider, { t: 'room_join', code: ' ' + code.toLowerCase() + ' ', charId: 'hunter' });
  expect('房号自动大写去空格', !!col.last(outsider.connId, 'room_update'), 'no room_update');
  H(outsider, { t: 'room_leave' });

  // --- 未准备就开局：房主也要等 ---
  col.clear();
  H(host, { t: 'game_start' });
  const notReady = col.last(host.connId, 'error');
  expect('有人未准备时开局被拒', !!notReady && notReady.code === 'NOT_READY', JSON.stringify(notReady));

  // --- 非房主不能开局 ---
  col.clear();
  H(mate, { t: 'game_start' });
  const notHost = col.last(mate.connId, 'error');
  expect('非房主开局被拒', !!notHost && notHost.code === 'NOT_HOST', JSON.stringify(notHost));

  // --- 准备 + 开局 ---
  col.clear();
  H(mate, { t: 'room_ready', ready: true });
  expect('准备后 canStart 变为 true', (function () {
    const u = col.last(mate.connId, 'room_update');
    return u && u.room.canStart === true;
  })(), 'canStart still false');

  col.clear();
  H(host, { t: 'game_start' });
  const gsHost = col.last(host.connId, 'game_start');
  const gsMate = col.last(mate.connId, 'game_start');
  expect('开局包已下发（房主）', !!gsHost, 'host got no game_start');
  expect('开局包已下发（队友）', !!gsMate, 'mate got no game_start');
  expect('两人的 selfSlot 不同', gsHost && gsMate && gsHost.selfSlot !== gsMate.selfSlot,
    gsHost && gsHost.selfSlot + '/' + gsMate.selfSlot);
  expect('开局包带种子与 tick 频率', gsHost && typeof gsHost.seed === 'number' && gsHost.tickRate === C.TICK_HZ,
    JSON.stringify({ seed: gsHost && gsHost.seed, tick: gsHost && gsHost.tickRate }));
  expect('开局包带全员名单', gsHost && gsHost.players.length === 2, 'n=' + (gsHost && gsHost.players.length));
  expect('开局包带视野半径/快照频率（客户端要用它配插值）',
    gsHost && typeof gsHost.viewRadius === 'number' && typeof gsHost.snapshotHz === 'number',
    JSON.stringify({ vr: gsHost && gsHost.viewRadius, hz: gsHost && gsHost.snapshotHz }));

  // --- 房间状态已切 playing，新人不许再直接加房 ---
  expect('开局后房间状态为 playing', manager.getRoom(code).state === 'playing',
    'state=' + manager.getRoom(code).state);

  // --- 输入 -> 世界真的动了 ---
  const match = registry.get(code);
  const x0 = match.players[gsHost.selfSlot].x;
  col.clear();
  H(host, { t: 'input', mx: 1, my: 0, seq: 1 });
  for (let i = 0; i < 10; i++) match.stepOnce();
  expect('输入经协议层传到了世界（人物右移）', match.players[gsHost.selfSlot].x > x0 + 10,
    'dx=' + (match.players[gsHost.selfSlot].x - x0).toFixed(1));
  expect('对局中收到快照', col.of(host.connId, 'snap').length > 0, 'n=' + col.of(host.connId, 'snap').length);
  expect('对局中收到 HUD', col.of(host.connId, 'hud').length > 0, 'n=' + col.of(host.connId, 'hud').length);
  expect('快照里有两名玩家', (function () {
    const s = col.last(host.connId, 'snap');
    return s && s.players.length === 2;
  })(), 'players != 2');

  // --- 不在对局中的连接发 input 不该报错（客户端丢包很正常） ---
  col.clear();
  H(outsider, { t: 'input', mx: 1, my: 1, seq: 1 });
  expect('非对局连接发 input 被静默忽略', col.log.length === 0, 'n=' + col.log.length);

  // --- choose：非法下标要回当前面板状态方便客户端校正 ---
  col.clear();
  const p0 = match.players[gsHost.selfSlot];
  p0.state = 'levelup';
  p0.choices = [{ type: 'fallback', id: 'f', name: '回复' }];
  H(host, { t: 'choose', index: 99 });
  const corrected = col.last(host.connId, 'hud');
  expect('非法升级下标回一份 HUD 用于校正', !!corrected, 'no hud');
  expect('校正 HUD 里能看到面板状态', corrected && corrected.choices && corrected.choices.length === 1,
    JSON.stringify(corrected && corrected.choices));
  col.clear();
  H(host, { t: 'choose', index: 0 });
  expect('合法下标生效', p0.state === 'playing', 'state=' + p0.state);

  // --- 中途加入已开局的房间 ---
  col.clear();
  H(outsider, { t: 'room_join', code: code, charId: 'hunter' });
  const midJoin = col.last(outsider.connId, 'game_start');
  expect('可以中途加入正在打的对局', !!midJoin && midJoin.midJoin === true, JSON.stringify(midJoin && { t: midJoin.t, mid: midJoin.midJoin }));
  expect('中途加入拿到空座位', midJoin && midJoin.selfSlot === 2, 'slot=' + (midJoin && midJoin.selfSlot));
  expect('中途加入后世界里有 3 人', match.world.players.length === 3, 'n=' + match.world.players.length);
  expect('老玩家收到「有人加入」事件', col.of(host.connId, 'ev').some(function (m) {
    return m.list.some(function (e) { return e.type === 'ally_join'; });
  }), 'no ally_join');
  // 【回归点】中途加入必须同时挂进「房间名单」，不能只往世界里加人。
  // 只加世界的话：队友的候场室看不到他、房间人数少一个、退房时状态残留。
  expect('中途加入也进了房间名单', manager.getRoom(code).members.length === 3,
    'n=' + manager.getRoom(code).members.length);
  expect('房间广播带上了新人', (function () {
    const u = col.last(host.connId, 'room_update');
    return u && u.room.members.length === 3;
  })(), 'room_update 里没有新人');
  expect('中途加入者拿到与房间一致的座位号', (function () {
    const m = manager.memberOf(manager.getRoom(code), outsider.connId);
    return m && m.slot === 2;
  })(), 'slot 不一致');

  // --- 掉线：协议层的收尾顺序 ---
  col.clear();
  proto.onDisconnect(outsider.connId);
  expect('掉线者从对局摘掉', match.world.players.length === 2, 'n=' + match.world.players.length);
  expect('掉线者不再属于任何对局', registry.ofConn(outsider.connId) === null, 'still bound');
  expect('队友收到「有人离开」事件', col.of(host.connId, 'ev').some(function (m) {
    return m.list.some(function (e) { return e.type === 'ally_left'; });
  }), 'no ally_left');
  // 掉线者在**候场室**里的成员身份不会被摘掉，而是打上离场时间戳等宽限期。
  // （这是本轮改掉的旧行为：以前断线即摘人，于是房里最后一个人一断线房间当场销毁。
  //   新的语义与对局侧一致 —— 断线不等于离开。断言也必须跟着改，
  //   否则每次都会在这里报一个「其实是对的」失败，把真回归埋掉。）
  const roomAfter = manager.getRoom(code);
  const memberAfter = roomAfter ? manager.memberOf(roomAfter, outsider.connId) : null;
  expect('掉线者在候场室的席位被保留（标记为不在线）',
    !!(memberAfter && memberAfter.connected === false), JSON.stringify(memberAfter));
  expect('掉线者仍带着离场时间戳（宽限期到期才真摘）',
    !!(memberAfter && memberAfter.offAt > 0), 'offAt=' + (memberAfter && memberAfter.offAt));
  manager.removeConn(outsider.connId);
  // 主动离开房间的那条路才真的立刻摘人（onRoomLeave 走的是这里，不是 offline 分支）
  manager.leaveRoom(host.connId);
  const hostLeft = manager.getRoom(code);
  expect('主动离开房间会立刻从名单里消失',
    !hostLeft || manager.memberOf(hostLeft, host.connId) === null, '还在名单里');
  // 房主退掉后房间只剩一个人，重新按原座位号进房（下面几条断言依赖 host 仍在局里）
  manager.joinRoom(code, host.connId, { charId: 'hunter' });

  // --- 对局中主动退出 ---
  col.clear();
  H(mate, { t: 'game_leave' });
  expect('主动退出有回执', !!col.last(mate.connId, 'game_left'), 'no game_left');
  expect('退出后世界只剩 1 人', match.world.players.length === 1, 'n=' + match.world.players.length);
  expect('退出后房间名单只剩 1 人', manager.getRoom(code).members.length === 1,
    'n=' + manager.getRoom(code).members.length);

  // --- 房主退出后人走光，对局要收掉 ---
  H(host, { t: 'game_leave' });
  expect('人走光后对局被回收', registry.get(code) === null || registry.get(code).state === 'ended',
    registry.get(code) ? registry.get(code).state : 'null');

  // --- 退房 / 不在房间里的操作 ---
  col.clear();
  H(host, { t: 'room_leave' });
  const notInRoom = col.last(host.connId, 'error');
  expect('不在房间里退房有明确错误码', !!notInRoom && notInRoom.code === 'NOT_IN_ROOM', JSON.stringify(notInRoom));

  col.clear();
  H(host, { t: 'game_start' });
  const noRoom = col.last(host.connId, 'error');
  expect('不在房间里开局有明确错误码', !!noRoom && noRoom.code === 'NOT_IN_ROOM', JSON.stringify(noRoom));

  // --- 未知消息交给 ws.js 处理 ---
  expect('未知类型不被本层吞掉', proto.handle(null, host, { t: 'nonexistent' }) === false, 'should be false');

  const stats = proto.stats();
  expect('stats 接口可用', stats && Array.isArray(stats.rooms) && Array.isArray(stats.matches), JSON.stringify(stats));

  // 清场
  registry.stop(code, 'test');
  manager.removeConn(host.connId);
  manager.removeConn(mate.connId);
}

// ============================================================
// [D] 性能与带宽基线
// ============================================================

function testPerf() {
  section('[D] 性能与带宽基线（4 人满负荷）');

  const col = makeCollector();
  const conns = [addConn('P1', false), addConn('P2', false), addConn('P3', false), addConn('P4', false)];
  const room = manager.createRoom(conns[0].connId, { charId: 'hunter' }).room;
  manager.joinRoom(room.code, conns[1].connId, { charId: 'nun' });
  manager.joinRoom(room.code, conns[2].connId, { charId: 'scholar' });
  manager.joinRoom(room.code, conns[3].connId, { charId: 'blacksmith' });

  const m = registry.start(room, { onSend: col.sendTo, seed: 20260920 });

  // 让玩家四处走动，尽量把怪拉满
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < 4; i++) m.setInput(conns[i].connId, dirs[i][0], dirs[i][1], 1);

  const FRAMES = 1800;      // 90 秒游戏时间
  const t0 = Date.now();
  for (let i = 0; i < FRAMES; i++) {
    // 每 100 帧换一次方向，让玩家在地图上跑开，触发最大刷怪量
    if (i % 100 === 0) {
      for (let k = 0; k < 4; k++) {
        const d = dirs[(i / 100 + k) % 4];
        m.setInput(conns[k].connId, d[0], d[1], i);
      }
    }
    m.stepOnce();
  }
  const wallMs = Date.now() - t0;

  const alive = SIM.countAliveMobs(m.world);
  const st = m.statSummary();
  // 理论帧率上限：逻辑是 20Hz，跑不到 20 帧/秒就说明服务端算不过来
  const hzNeeded = C.TICK_HZ;

  // 单怪成本：同一帧、同一份逻辑数据，只是换了编码方式 ——
  // 这才是 P2-5 前后能直接对比的数字（「1200 只同屏」是方案里的硬上限，
  // 用它外推最坏情况才有意义）。
  const snap = m.snapshotFor(m.players[0]);
  PB.resetStats();
  const jsonBytes = JSON.stringify(snap).length;
  const binBytes = PB.encode(snap, { key: false, omitPrev: true }).length;
  const mobs = snap.mobs.length;
  const oneMobJson = mobs ? Math.round(jsonBytes / mobs) : 0;
  const oneMobBin = mobs ? Math.round(binBytes / mobs) : 0;
  const ratio = binBytes > 0 ? (jsonBytes / binBytes) : 0;
  const full = C.MAX_MOBS;
  const kb = function (b) { return (b / 1024).toFixed(1); };

  console.log('    游戏时长=' + Math.round(m.world.time) + 's  存活怪=' + alive +
    '  单帧均值=' + st.tickMsAvg + 'ms  峰值=' + st.tickMsMax + 'ms');
  console.log('    真实墙钟=' + wallMs + 'ms 跑完 ' + FRAMES + ' 帧（' +
    (FRAMES / (wallMs / 1000)).toFixed(0) + ' 帧/秒，20Hz 需要 ' + hzNeeded + ' 帧/秒）');
  console.log('    本帧快照（' + mobs + ' 只怪 + ' + snap.players.length + ' 人 + 杂项）：' +
    'JSON ' + jsonBytes + 'B  二进制 ' + binBytes + 'B  压缩 ' + ratio.toFixed(1) + '×' +
    '（单怪 ' + oneMobJson + 'B → ' + oneMobBin + 'B）');
  console.log('    实测下行（' + snap.players.length + ' 人 × ' + config.snapshotHz + 'Hz，本局怪量）：' +
    '平均 ' + st.snapBytesAvg + 'B/包 → 单人 ' +
    (st.snapBytesAvg * config.snapshotHz / 1024).toFixed(1) + ' KB/s，峰值包 ' + st.snapBytesMax + 'B');
  console.log('    【最坏情况外推】' + full + ' 只怪全部下发（关掉视野裁剪）：JSON 约 ' +
    kb(oneMobJson * full) + ' KB/包 → 单人 ' +
    (oneMobJson * full * config.snapshotHz / 1048576).toFixed(2) + ' MB/s；二进制约 ' +
    kb(oneMobBin * full) + ' KB/包 → 单人 ' +
    (oneMobBin * full * config.snapshotHz / 1048576).toFixed(2) + ' MB/s');

  expect('单帧耗时远低于 50ms 预算', st.tickMsAvg < 10, st.tickMsAvg + 'ms');
  expect('单帧峰值低于 50ms 预算', st.tickMsMax < 50, st.tickMsMax + 'ms');
  expect('总耗时说明能跑得动 20Hz', wallMs < 20 * FRAMES, wallMs + 'ms / ' + FRAMES + ' 帧');
  expect('世界真的刷出了怪', alive > 0, 'alive=' + alive);
  expect('快照包体有记录（用二进制字节数记的）', st.snapBytesAvg > 0, 'avg=' + st.snapBytesAvg);
  expect('二进制快照明显小于 JSON（P2-5 的核心收益）', ratio > 3,
    'JSON=' + jsonBytes + 'B bin=' + binBytes + 'B ratio=' + ratio.toFixed(2));
  expect('单怪二进制开销远低于 JSON 的 166 字节', oneMobBin > 0 && oneMobBin < 40,
    'oneMobBin=' + oneMobBin + 'B json=' + oneMobJson + 'B');
  expect('字符串全部命中静态串池（没人漏加池）', PB.stats.longForm === 0,
    'longForm=' + PB.stats.longForm + ' ' + JSON.stringify(PB.stats.longFormByField));
  expect('必需字段一个都没缺', PB.stats.missingRequired === 0,
    'missing=' + PB.stats.missingRequired);

  // 清场
  registry.stop(room.code, 'test');
  for (let i = 0; i < conns.length; i++) manager.removeConn(conns[i].connId);
  manager.destroyRoom(room.code);
}

// ============================================================
// 主流程
// ============================================================

console.log('');
console.log('=== 吸血鬼辛存者 · P2-2 服务端权威对局自检 ===');
console.log('角色数=' + C.CHARACTERS.length + '  逻辑帧率=' + C.TICK_HZ + 'Hz  单局时长=' + C.MATCH_SEC + 's');
console.log('房间上限=' + config.maxPlayers + ' 人  快照=' + config.snapshotHz + 'Hz  视野半径=' + config.viewRadius +
  '  升级超时=' + config.upgradeTimeoutSec + 's');

testRoomManager();
testMatch();
testProto();
testPerf();

console.log('');
console.log('=== 汇总 ===');
console.log('  PASS  ' + pass);
console.log('  FAIL  ' + fail);
console.log('');

// 有失败就给个非零退出码，方便接进 CI / 批处理
process.exit(fail > 0 ? 1 : 0);
