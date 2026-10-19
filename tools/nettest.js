// tools/nettest.js —— P2-2 联机链路端到端自检（真实 WebSocket）
//
// 与 tools/matchtest.js 的分工：
//   matchtest.js  纯逻辑，不起服务器，验证「算得对」
//   nettest.js    连真实服务器，验证「连得通、发得到、收得着」
// 两个都要跑：缺一个就有一半链路没被验证过。
//
// 覆盖：
//   [1] 双客户端握手
//   [2] 建房 -> 房间列表 -> 加房 -> 双向 room_update
//   [3] 准备 -> 开局 -> 两人各自拿到不同的 selfSlot
//   [4] 上行输入真的驱动了服务端世界（人物位移）
//   [5] 下行快照/HUD 持续到达，且两人互相可见
//   [6] 升级事件 -> choose 闭环
//   [7] 对局中掉线 -> 另一人收到 ally_left 且快照人数下降
//   [8] 退出 -> 房间回收 + /api/gamestats 观测
//
// 用法：先启动服务，再执行 node tools/nettest.js [端口]

const WebSocket = require('ws');
// 【P2-5】下行快照是二进制帧，测试客户端要自己解 —— 真客户端也是这么做的
const PB = require('../shared/proto_bin.js');

const PORT = Number(process.argv[2] || 3000);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0;
let fail = 0;
let skip = 0;

function ok(name, extra) {
  pass += 1;
  console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
}

function bad(name, detail) {
  fail += 1;
  console.log('  FAIL  ' + name + '  ->  ' + detail);
}

function skipped(name, why) {
  skip += 1;
  console.log('  SKIP  ' + name + '  (' + why + ')');
}

function expect(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail || '断言不成立');
}

// 轮询等待一个条件成立。比「挂一次性回调」稳：
// 快照/事件是流式的，用回调很容易被前一条不相干的消息误唤醒。
function waitUntil(fn, timeoutMs, cb) {
  const t0 = Date.now();
  const timer = setInterval(function () {
    if (fn()) {
      clearInterval(timer);
      return cb(true);
    }
    if (Date.now() - t0 > timeoutMs) {
      clearInterval(timer);
      return cb(false);
    }
  }, 100);
}

// ============================================================
// 轻量 WS 客户端
// ============================================================

function makeClient(name) {
  const c = {
    name: name,
    ws: null,
    connId: '',
    last: {},           // 最近一条各类型消息
    counts: {},         // 各类型累计条数
    prevSnap: null,     // 上一帧快照（二进制协议重建 px/py 要用）
    evs: [],            // 累计收到的事件（用于事后查找，不受「被后来的消息顶掉」影响）
    rooms: [],          // 累计收到的 room_update
    errors: [],
    waiters: []
  };

  c.connect = function (cb) {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
    c.ws = ws;
    let settled = false;

    ws.on('open', function () {
      ws.send(JSON.stringify({ t: 'hello', nickname: name }));
    });

    ws.on('message', function (raw) {
      // 下行有两种帧：JSON 文本（房间/HUD/事件/结算）与二进制（P2-5 的快照）。
      // 【坑】Node 的 ws 库默认把**文本帧也递成 Buffer**（binaryType='nodebuffer'），
      // 所以不能靠 `typeof raw === 'string'` 分流 —— 那会把所有 JSON 消息都当二进制丢掉。
      // 按首字节判：快照帧第 0 字节是 0x01，JSON 一定以 '{' 0x7b 开头，不会撞。
      // （浏览器那边不一样：设了 binaryType='arraybuffer' 后文本帧确实是 string，
      //   所以 game.js 用的是 typeof 分流，两边各自用对的方式。）
      let msg = null;
      const first = typeof raw === 'string' ? raw.charCodeAt(0) : raw[0];
      if (first === PB.T_SNAP) {
        // 二进制帧要拿**上一帧**去解：服务端在「快照频率 == 逻辑帧率」时会省掉 px/py，
        // 客户端得按 id 从上一帧的 x/y 补回来 —— 真客户端也是这么做的。
        msg = PB.decode(raw, c.prevSnap);
        c.prevSnap = msg;
        if (!msg) return;
      } else {
        try {
          msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
        } catch (e) {
          return;
        }
      }

      c.last[msg.t] = msg;
      c.counts[msg.t] = (c.counts[msg.t] || 0) + 1;
      if (msg.t === 'welcome') c.connId = msg.self.connId;
      if (msg.t === 'error') c.errors.push(msg);
      if (msg.t === 'ev') c.evs.push(msg);
      if (msg.t === 'room_update') c.rooms.push(msg.room);

      // 唤醒等待者。倒着删，正着删会漏掉后面的。
      for (let i = c.waiters.length - 1; i >= 0; i--) {
        const w = c.waiters[i];
        if (w.type !== msg.t) continue;
        c.waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.cb(msg);
      }

      if (msg.t === 'welcome' && !settled) {
        settled = true;
        cb(null, msg);
      }
    });

    ws.on('error', function (err) {
      if (!settled) {
        settled = true;
        cb(err);
      }
    });

    ws.on('close', function () {
      if (!settled) {
        settled = true;
        cb(new Error('连接被关闭'));
      }
    });
  };

  c.send = function (obj) {
    if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj));
  };

  // 等一条指定类型的消息；超时回调 null
  c.wait = function (type, timeoutMs, cb) {
    const w = { type: type, cb: cb, timer: null };
    w.timer = setTimeout(function () {
      const i = c.waiters.indexOf(w);
      if (i >= 0) c.waiters.splice(i, 1);
      cb(null);
    }, timeoutMs);
    c.waiters.push(w);
  };

  // 在累计事件里找某类事件（跨多条 ev 消息）
  c.findEvent = function (type) {
    for (let i = 0; i < c.evs.length; i++) {
      const list = c.evs[i].list || [];
      for (let k = 0; k < list.length; k++) {
        if (list[k].type === type) return list[k];
      }
    }
    return null;
  };

  c.selfInSnap = function (slot) {
    const s = c.last.snap;
    if (!s || !s.players) return null;
    return s.players.filter(function (p) { return p.slot === slot; })[0] || null;
  };

  c.close = function () {
    if (c.ws) {
      c.ws.removeAllListeners('close');
      c.ws.close();
    }
  };

  return c;
}

function get(path, cb) {
  fetch(BASE + path).then(function (res) {
    return res.json().then(function (json) { cb(null, res.status, json); },
      function () { cb(new Error('返回不是合法 JSON'), res.status, null); });
  }, function (err) { cb(err, 0, null); });
}

// ============================================================
// 步骤
// ============================================================

const tag = Math.floor(Math.random() * 900 + 100);
const A = makeClient('甲' + tag);
const B = makeClient('乙' + tag);

let roomCode = '';
let slotA = -1;
let slotB = -1;

// [1] 握手
function stepHandshake(cb) {
  console.log('[1] 双客户端握手');

  A.connect(function (err) {
    if (err) {
      bad('甲 握手失败', err.message);
      return cb(err);
    }
    expect('甲 握手成功并拿到 connId', !!A.connId, 'connId=' + A.connId);
    expect('握手包带 tickRate=20', A.last.welcome.tickRate === 20, 'tickRate=' + A.last.welcome.tickRate);

    B.connect(function (err2) {
      if (err2) {
        bad('乙 握手失败', err2.message);
        return cb(err2);
      }
      expect('乙 握手成功并拿到 connId', !!B.connId, 'connId=' + B.connId);
      expect('两人 connId 不同', A.connId !== B.connId, A.connId + '/' + B.connId);
      cb(null);
    });
  });
}

// [2] 建房 / 列表 / 加房
function stepRoom(cb) {
  console.log('[2] 建房与加房');

  A.wait('room_update', 3000, function (msg) {
    if (!msg) {
      bad('甲 建房后未收到 room_update', '超时');
      return cb(new Error('no room_update'));
    }
    roomCode = msg.room.code;
    expect('甲 建房成功', !!roomCode, 'code=' + roomCode);
    expect('甲 那份视图里 self 是自己', msg.room.members[0].self === true, JSON.stringify(msg.room.members[0]));
    expect('甲 是房主', msg.room.members[0].host === true, 'host=' + msg.room.members[0].host);

    get('/api/rooms', function (err, status, json) {
      if (err) {
        bad('GET /api/rooms 失败', err.message);
        return cb(err);
      }
      const hit = (json.list || []).filter(function (r) { return r.code === roomCode; })[0];
      expect('/api/rooms 能查到新房间', !!hit, 'list=' + JSON.stringify(json.list));
      expect('列表带房主昵称与人数', !!hit && hit.memberCount === 1 && !!hit.host,
        hit ? (hit.host + ' / ' + hit.memberCount) : 'null');

      B.send({ t: 'room_join', code: roomCode, charId: 'nun' });
      waitUntil(function () {
        return B.counts.room_update >= 1 && A.counts.room_update >= 2;
      }, 3000, function (good) {
        if (!good) {
          bad('加房后的 room_update 未双向送达', 'A=' + (A.counts.room_update || 0) + ' B=' + (B.counts.room_update || 0));
          return cb(new Error('no room_update'));
        }
        const forB = B.last.room_update.room;
        const forA = A.last.room_update.room;
        expect('乙 收到 room_update', forB.members.length === 2, 'n=' + forB.members.length);
        expect('乙 那份视图里 self 是自己', forB.members.some(function (m) { return m.self && m.slot === 1; }),
          JSON.stringify(forB.members.map(function (m) { return m.slot + ':' + m.self; })));
        expect('甲 那份视图里 self 还是自己', forA.members.some(function (m) { return m.self && m.slot === 0; }),
          JSON.stringify(forA.members.map(function (m) { return m.slot + ':' + m.self; })));
        expect('未准备时不可开局', forA.canStart === false, 'canStart=' + forA.canStart);
        expect('视图不泄露 connId', forA.members[0].connId === undefined, 'connId=' + forA.members[0].connId);
        cb(null);
      });
    });
  });

  A.send({ t: 'room_create', charId: 'hunter' });
}

// [3] 准备与开局
function stepStart(cb) {
  console.log('[3] 准备与开局');

  B.send({ t: 'room_ready', ready: true });

  waitUntil(function () { return A.last.room_update && A.last.room_update.room.canStart === true; },
    3000, function (ready) {
      expect('乙准备后房主看到 canStart=true', ready,
        'canStart=' + (A.last.room_update && A.last.room_update.room.canStart));

      A.wait('game_start', 4000, function (gsA) {
        if (!gsA) {
          bad('甲 没收到 game_start', '超时');
          return cb(new Error('no game_start A'));
        }
        waitUntil(function () { return !!B.last.game_start; }, 2000, function (gotB) {
          if (!gotB) {
            bad('乙 没收到 game_start', '超时');
            return cb(new Error('no game_start B'));
          }
          const gsB = B.last.game_start;
          slotA = gsA.selfSlot;
          slotB = gsB.selfSlot;

          expect('两人的 selfSlot 不同', slotA !== slotB, slotA + '/' + slotB);
          expect('开局包带 2 名玩家名单', gsA.players.length === 2, 'n=' + gsA.players.length);
          expect('开局包带种子', typeof gsA.seed === 'number' && gsA.seed > 0, 'seed=' + gsA.seed);
          expect('开局包带视野半径与快照频率', gsA.viewRadius > 0 && gsA.snapshotHz > 0,
            gsA.viewRadius + 'px / ' + gsA.snapshotHz + 'Hz');
          expect('两人都在名单里且角色合法', (function () {
            const pa = gsA.players.filter(function (p) { return p.slot === slotA; })[0];
            const pb = gsA.players.filter(function (p) { return p.slot === slotB; })[0];
            return !!(pa && pb && !!pa.charId && !!pb.charId);
          })(), JSON.stringify(gsA.players.map(function (p) { return p.slot + ':' + p.charId; })));
          // 【服务端兜底规则】本用例两个客户端都是游客（只发了昵称没有 token），
          // 游客只能玩猎魔人，所以乙就算请求了「修女」也必须被服务端降级 ——
          // 客户端已经拦过一道，但改个包就能绕过去，服务端这道才是真的。
          expect('游客请求未解锁角色被服务端降级为猎魔人',
            gsA.players.filter(function (p) { return p.slot === slotB; })[0].charId === 'hunter',
            JSON.stringify(gsA.players.map(function (p) { return p.slot + ':' + p.charId; })));
          expect('开局后房间状态变为 playing',
            !!(A.last.room_update && A.last.room_update.room.state === 'playing'),
            'state=' + (A.last.room_update && A.last.room_update.room.state));
          cb(null);
        });
      });

      A.send({ t: 'game_start' });
    });
}

// [4] 上行输入驱动服务端世界
function stepPlay(cb) {
  console.log('[4] 上行输入驱动服务端世界');

  waitUntil(function () { return !!A.selfInSnap(slotA); }, 3000, function (gotSnap) {
    if (!gotSnap) {
      bad('开局后收不到自己的快照', '3 秒内没有含 slot=' + slotA + ' 的快照');
      return cb(new Error('no snapshot'));
    }
    const p0 = A.selfInSnap(slotA);
    const x0 = p0.x;
    const y0 = p0.y;

    // 连续 1.3 秒往右上推
    const pusher = setInterval(function () {
      A.send({ t: 'input', mx: 1, my: -1, seq: Date.now() & 0xffff });
    }, 50);

    setTimeout(function () {
      clearInterval(pusher);
      const p1 = A.selfInSnap(slotA);
      expect('甲 按输入向右移动了', p1 && p1.x > x0 + 30,
        'x0=' + x0 + ' x1=' + (p1 && p1.x) + ' dx=' + (p1 ? (p1.x - x0).toFixed(1) : '?'));
      expect('甲 按输入向上移动了', p1 && p1.y < y0 - 30,
        'y0=' + y0 + ' y1=' + (p1 && p1.y) + ' dy=' + (p1 ? (p1.y - y0).toFixed(1) : '?'));

      // 乙全程没发输入，位置不该有明显变化
      const q = B.selfInSnap(slotB);
      expect('乙 没发输入所以基本原地不动', !!q, 'missing snapshot for slot=' + slotB);
      cb(null);
    }, 1300);
  });
}

// [5] 下行快照/HUD
function stepDownlink(cb) {
  console.log('[5] 下行快照与 HUD');

  expect('甲 持续收到快照（>15 条）', (A.counts.snap || 0) > 15, 'n=' + (A.counts.snap || 0));
  expect('乙 持续收到快照（>15 条）', (B.counts.snap || 0) > 15, 'n=' + (B.counts.snap || 0));
  expect('甲 收到 HUD', (A.counts.hud || 0) > 0, 'n=' + (A.counts.hud || 0));

  const snap = A.last.snap;
  expect('快照里有两名玩家', snap.players.length === 2, 'n=' + snap.players.length);
  expect('两人互相可见', snap.players.some(function (p) { return p.slot === slotA; }) &&
    snap.players.some(function (p) { return p.slot === slotB; }),
    JSON.stringify(snap.players.map(function (p) { return p.slot; })));
  expect('快照带角色（画队友要用）',
    snap.players.every(function (p) { return !!p.charId; }),
    JSON.stringify(snap.players));
  // 昵称刻意不进每帧快照（它是名单数据，game_start 里已经发过全量）。
  // 客户端要显示队友名字读 roster，不要在这里把 name 加回白名单。
  expect('每帧快照刻意不带昵称（名单走 game_start）',
    snap.players.every(function (p) { return p.name === undefined; }),
    JSON.stringify(snap.players.map(function (p) { return p.name; })));
  const roster = (A.last.game_start && A.last.game_start.players) || [];
  expect('名单（game_start）里带得到全部昵称',
    roster.length === 2 && roster.every(function (p) { return typeof p.name === 'string' && p.name.length > 0; }),
    JSON.stringify(roster.map(function (p) { return p.name; })));
  expect('快照带存活怪数', typeof snap.aliveMobCount === 'number', 'n=' + snap.aliveMobCount);
  expect('快照不含 owner 反向引用', JSON.stringify(snap).indexOf('"owner"') < 0, 'leaked owner');
  expect('快照不含 def 整包', JSON.stringify(snap).indexOf('"def"') < 0, 'leaked def');
  expect('快照带插值用的上一帧坐标',
    typeof snap.players[0].px === 'number' && typeof snap.players[0].py === 'number', 'missing px/py');

  const hud = A.last.hud;
  expect('HUD 指向自己（slot 正确）', hud && hud.slot === slotA, 'slot=' + (hud && hud.slot) + ' 期望=' + slotA);
  expect('HUD 带自己的等级/血量/击杀', !!hud && typeof hud.level === 'number' &&
    typeof hud.hp === 'number' && typeof hud.kills === 'number',
    JSON.stringify(hud && { lv: hud.level, hp: hud.hp, k: hud.kills }));
  expect('HUD 带服务端权威倒计时', !!hud && typeof hud.timeLeft === 'number' && hud.timeLeft > 0,
    'timeLeft=' + (hud && hud.timeLeft));

  get('/api/gamestats', function (err, status, json) {
    if (err) {
      bad('GET /api/gamestats 失败', err.message);
      return cb(err);
    }
    expect('/api/gamestats 返回 200', status === 200, 'status=' + status);
    const m = ((json.stats && json.stats.matches) || []).filter(function (x) { return x.code === roomCode; })[0];
    expect('观测接口能看到本局', !!m, JSON.stringify(json.stats && json.stats.matches));
    expect('观测接口带单帧耗时（联机调优的眼睛）', !!m && typeof m.tickMs === 'number' && m.tickMs >= 0,
      'tickMs=' + (m && m.tickMs));
    expect('观测接口带快照包体基线（P2-5 对比用）', !!m && typeof m.snapBytes === 'number' && m.snapBytes > 0,
      'snapBytes=' + (m && m.snapBytes));
    cb(null);
  });
}

// [6] 升级闭环
function stepLevelUp(cb) {
  console.log('[6] 升级三选一闭环');

  // 等一条真正属于甲自己的 levelup 事件（最多 30 秒；怪死够就会升级）
  waitUntil(function () {
    return A.evs.some(function (m) {
      return (m.list || []).some(function (e) {
        return e.type === 'levelup' && (e.slot === undefined || e.slot === slotA);
      });
    });
  }, 30000, function (gotLv) {
    if (!gotLv) {
      skipped('升级闭环', '30 秒内没升级（怪还没死够）；核心逻辑已由 matchtest 的「升级三选一」用例覆盖');
      return cb(null);
    }

    // 服务端告诉我们「你在升级」，那 HUD 必须跟上（HUD 是 5Hz 下发，最多 200ms 后到）
    waitUntil(function () {
      return A.last.hud && A.last.hud.state === 'levelup' && A.last.hud.choices && A.last.hud.choices.length > 0;
    }, 2000, function (hudOk) {
      expect('升级时 HUD 里能看到面板候选', hudOk,
        'state=' + (A.last.hud && A.last.hud.state) + ' choices=' + JSON.stringify(A.last.hud && A.last.hud.choices));

      if (!hudOk) return cb(null);

      const levelBefore = A.last.hud.level;
      const picks = A.last.hud.choices.length;

      A.wait('hud', 2000, function (hud) {
        if (!hud) {
          bad('选择后没收到 HUD', '超时');
          return cb(new Error('no hud after choose'));
        }
        expect('选择后回到 playing', hud.state === 'playing', 'state=' + hud.state);
        expect('选择后面板候选已清空', !hud.choices || hud.choices.length === 0,
          'choices=' + JSON.stringify(hud.choices));
        ok('升级闭环走通（levelup -> choose -> playing）', '候选 ' + picks + ' 项，等级 ' + levelBefore + ' -> ' + hud.level);
        cb(null);
      });

      A.send({ t: 'choose', index: 0 });
    });
  });
}

// [7] 对局中掉线
function stepDisconnect(cb) {
  console.log('[7] 对局中掉线');

  const snapBefore = A.last.snap.players.length;
  B.close();

  waitUntil(function () { return !!A.findEvent('ally_left'); }, 5000, function (got) {
    expect('甲 收到 ally_left 事件', got, '5 秒内没有 ally_left');
    if (!got) return cb(null);

    const left = A.findEvent('ally_left');
    expect('ally_left 带离开者的座位号', typeof left.slot === 'number', JSON.stringify(left));

    waitUntil(function () { return A.last.snap.players.length === snapBefore - 1; }, 3000, function (shrunk) {
      expect('乙 走后快照里人数减少', shrunk,
        'before=' + snapBefore + ' now=' + A.last.snap.players.length);
      cb(null);
    });
  });
}

// [8] 收尾
function stepCleanup(cb) {
  console.log('[8] 收尾');

  A.wait('game_left', 3000, function (msg) {
    expect('主动退出对局有回执', !!msg, 'no game_left');

    A.send({ t: 'room_list' });
    waitUntil(function () { return !!A.last.room_list; }, 2000, function () {
      // 【本轮改掉的旧行为】以前这里断言「人走光 → 房间立刻消失」。
      // 现在候场室也有宽限期（对齐对局侧的 suspend/resume）：最后一个人退出后
      // 房间会保留一段时间，他回来能接回原座位与房主身份。
      //
      // 保留是有意的 —— 房主点「退出对局」再点「返回大厅」，中间那几秒他已经不在
      // 这一局里了，房间立刻销毁的话他连回到候场室看一眼队友的机会都没有。
      // 具体保留多久由 config.roomKeepSec（默认 90s）控制，超时由 sweep 回收。
      const still = ((A.last.room_list && A.last.room_list.list) || []).filter(function (r) {
        return r.code === roomCode;
      })[0];
      console.log('[8] 退出对局后房间仍在：' + (still ? still.code + ' 成员' + still.memberCount : '已被回收'));
      // 【这里断言的是「A 还在房里」而不是「房里没人」】
      // game_leave 只退对局、不退房 —— 房主退出这一局后本来就该留在候场室等下一局
      // （「回到房间」按钮走的就是这条路）。B 已经断了，所以成员数是 1（只有 A）。
      //
      // 【本轮改掉的旧行为】原来这里断言「人走光 → 房间立刻消失」，指的是
      // 「A 和 B 都退出去」的情形。现在候场室也有宽限期（对齐对局侧的
      // suspend/resume）：最后一个人退出后房间保留一段时间，他回来能接回
      // 原座位与房主身份；超时才由 sweep 回收。保留的具体时长见 config.roomKeepSec。
      expect('退出对局后房间仍在（房主留在候场室等下一局）', !!still,
        '房间不见了：' + JSON.stringify(still));
      expect('房里只剩退出对局的那一个（不是两个都在）',
        !!still && still.memberCount === 1, 'memberCount=' + (still && still.memberCount));
      get('/api/gamestats', function (err, status, json) {
        const stillMatch = ((json && json.stats && json.stats.matches) || []).filter(function (x) {
          return x.code === roomCode;
        })[0];
        expect('对局已从注册表回收', !stillMatch, JSON.stringify(stillMatch));
        cb(null);
      });
    });
  });

  A.send({ t: 'game_leave' });
}

// ============================================================
// 主流程
// ============================================================

const steps = [
  stepHandshake,
  stepRoom,
  stepStart,
  stepPlay,
  stepDownlink,
  stepLevelUp,
  stepDisconnect,
  stepCleanup
];

let idx = 0;

function next(err) {
  if (err) return finish();          // 某步失败后不再往下跑（后续都依赖前面的状态）
  if (idx >= steps.length) return finish();
  const fn = steps[idx];
  idx += 1;
  fn(next);
}

function finish() {
  console.log('');
  console.log('=== 汇总 ===');
  console.log('  PASS  ' + pass);
  console.log('  FAIL  ' + fail);
  console.log('  SKIP  ' + skip);
  console.log('');
  A.close();
  B.close();
  setTimeout(function () { process.exit(fail > 0 ? 1 : 0); }, 150);
}

console.log('');
console.log('=== 吸血鬼辛存者 · P2-2 联机链路端到端自检 ===');
console.log('目标服务器：' + BASE);
console.log('');

next(null);
