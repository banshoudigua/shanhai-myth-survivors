// server/net/ws.js —— WebSocket 连接中枢
//
// 分层：本文件只负责「连接本身」——握手、心跳、在线列表、断线清理；
// 房间与对局的消息语义全部委托给 server/game/proto.js。
// 这样加对局协议时不用动这里的连接管理代码。
//
//   - 与 HTTP 共用同一端口（同一个 http.Server），容器只需暴露一个端口；
//   - 下行有**两种帧**：JSON 文本帧（房间列表 / HUD / 事件 / 结算，量都很小）
//     与二进制帧（P2-5 的对局快照，形态见 shared/proto_bin.js）。
//     上行一律 JSON —— 输入只有 mx/my/seq 三个数，压成二进制省不了什么。
//   - 所有业务回调走 callback 风格，不依赖 try/catch 做流程控制。
//
// 消息协议（JSON，字段 t 为类型）：
//   客户端 -> 服务端
//     { t:'hello',  token?, nickname? }   握手：带 token 走账号登录，否则用 nickname 当游客
//     { t:'ping',   ts }                  延迟探测
//     { t:'refresh' }                     主动拉取一次在线列表
//     { t:'status', status }              切换大厅/对局状态
//     —— 以下是房间与对局消息，见 server/game/proto.js 的完整清单
//     { t:'room_list' | 'room_create' | 'room_join' | 'room_leave' | 'room_ready' | 'room_char' }
//     { t:'game_start' | 'game_leave' | 'input' | 'choose' }
//   服务端 -> 客户端
//     { t:'welcome', self, online, serverTime, tickRate }  握手成功
//     { t:'online',  list, count }                          在线列表变化
//     { t:'pong',    ts, serverTime }                       延迟探测回包
//     { t:'error',   code, msg, fatal? }                    出错（fatal=true 表示会被断开）
//     { t:'room_list' | 'room_update' | 'game_start' | 'snap' | 'hud' | 'ev' | 'game_over' }

const WebSocket = require('ws');
const config = require('../config');
const auth = require('../api/auth');
const manager = require('../rooms/manager');
const proto = require('../game/proto');
const avatars = require('../../shared/avatars.js');   // 头像白名单与默认分配，双端共用一份

const hub = {};

// 在线 socket 集合：connId -> ws
const sockets = Object.create(null);

let wss = null;
let connSeq = 0;
let lastOnlineSig = '';    // 上次广播的在线状态签名，用于「变了才推」
let closed = false;

// ---- 拒绝服务的两道门（值都给得很宽松，正常客户端碰不到）----
const HELLO_TIMEOUT_MS = 10000;      // 连上后多久没发 hello 就断开
const MSG_WINDOW_MS = 5000;          // 速率统计窗口
const MSG_MAX_PER_WINDOW = 400;      // 窗口内最多几条（正常峰值约 125 条）

// 发一条「致命错误」并真的把连接关掉。
// 【为什么必须有它】这几处以前只发 `fatal: true` 的消息、却**不关连接**（说过 fatal 就完事）。
// 客户端看到 fatal 会自己重连，所以问题一直被掩盖着；但一个不守规矩的客户端
// 就能把「握手失败 / 未握手」的连接一直挂着占坑。既然叫 fatal，就得真的终止。
function failFatal(ws, code, msg) {
  send(ws, { t: 'error', code: code, msg: msg, fatal: true });
  hubDrop(ws, code);
}

// 以「策略违规」为由断开一条连接。
// 先发关闭帧（对端能收到原因、前端也会走 onclose 重连），2 秒后强杀 ——
// 不这么兜一手的话，对端不回关闭帧就会一直挂着，要等 30 秒心跳才被清掉。
function hubDrop(ws, why) {
  try {
    ws.close(1008, why);
  } catch (e) {
    // 连关都关不掉（连接已半死）就直接掐
    try { ws.terminate(); } catch (e2) { /* 已经断了 */ }
    return;
  }
  setTimeout(function () {
    try {
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    } catch (e) { /* 已经断了 */ }
  }, 2000).unref();
}

// ============================================================
// 工具
// ============================================================

// 生成连接 ID（进程内递增 + 随机后缀，便于日志追踪又不重复）
function nextConnId() {
  connSeq += 1;
  return 'c' + connSeq + '-' + Math.random().toString(36).slice(2, 8);
}

// 统一发消息（连接不是 OPEN 状态就静默丢弃，不抛错）
function send(ws, obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (config.debugLagMs > 0) {
    // 调试用：人为延迟发包，模拟弱网表现
    setTimeout(function () {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }, config.debugLagMs);
    return true;
  }
  ws.send(JSON.stringify(obj));
  return true;
}

// 组装在线列表对外结构
function onlinePayload() {
  const list = manager.listOnline();
  return {
    t: 'online',
    list: list,
    count: list.length
  };
}

// 按 connId 发消息，返回实际发出的字节数（0 表示没发出去）。
// 返回字节数是给对局模块做带宽观测用的（P2-5 就是拿它算出「压掉了多少」）。
//
// 支持两种载荷：
//   - 普通对象 → JSON 文本帧（房间列表、HUD、事件这些都很小，可读性比几个字节值钱）
//   - Uint8Array / ArrayBuffer → 二进制帧（P2-5 的对局快照，见 shared/proto_bin.js）
// 客户端靠 `typeof ev.data === 'string'` 分流，不需要额外的类型字段。
function sendToConn(connId, obj) {
  const ws = sockets[connId];
  if (!ws || ws.readyState !== WebSocket.OPEN) return 0;

  // ---- 二进制帧 ----
  if (obj instanceof Uint8Array || obj instanceof ArrayBuffer) {
    const bin = obj instanceof Uint8Array ? obj : new Uint8Array(obj);
    if (config.debugLagMs > 0) {
      setTimeout(function () {
        if (ws.readyState === WebSocket.OPEN) ws.send(bin);
      }, config.debugLagMs);
      return bin.byteLength;
    }
    ws.send(bin);
    return bin.byteLength;
  }

  // ---- JSON 文本帧 ----
  const text = JSON.stringify(obj);
  if (config.debugLagMs > 0) {
    setTimeout(function () {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }, config.debugLagMs);
    return text.length;
  }
  ws.send(text);
  return text.length;
}

// 计算在线状态签名：昵称/游客标记/状态/房间任一变化都要重推
function onlineSignature() {
  const list = manager.listOnline();
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    parts.push(c.nickname + '|' + (c.isGuest ? 'g' : 'u') + '|' + c.avatar + '|' + c.status + '|' + c.roomCode);
  }
  return parts.join(',');
}

// 广播给所有已握手的连接
function broadcast(obj) {
  const ids = Object.keys(sockets);
  for (let i = 0; i < ids.length; i++) {
    const ws = sockets[ids[i]];
    if (ws && ws.connId) send(ws, obj);
  }
}

// 在线列表变化时才广播（force=true 强制推，用于新连接加入与定期补发）
function pushOnline(force) {
  const sig = onlineSignature();
  if (!force && sig === lastOnlineSig) return;
  lastOnlineSig = sig;
  broadcast(onlinePayload());
}

// ============================================================
// 握手
// ============================================================

// 昵称清洗：只接受字符串，去掉首尾空白与不可见控制字符，限长。
// 【为什么不 String() 一把梭】那样 `{"nickname":{}}` 会变成 "[object Object]"
// 当上玩家名 —— 界面上是一串莫名其妙的东西，日志里也没法看。不是字符串就当没填。
function cleanNickname(raw) {
  if (typeof raw !== 'string') return '';
  let name = raw.trim();
  // 去掉换行与不可见控制字符，避免污染日志与界面
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  if (name.length > config.nicknameMax) name = name.slice(0, config.nicknameMax);
  return name;
}

// 握手：token 优先（注册用户），其次昵称（游客）
function handleHello(ws, msg) {
  const token = typeof msg.token === 'string' ? msg.token : '';

  if (token) {
    // 标记「hello 正在处理中」：这段窗口里到达的其它消息一律当早到的噪声忽略，
    // 绝不因为「还没握手」就把连接判死（见 handleMessage 里 NOT_READY 那段注释）
    ws.helloPending = true;
    return auth.verifyToken(token, function (err, user) {
      ws.helloPending = false;
      if (err) {
        console.log('[ws] 握手校验异常: ' + err.message);
        return failFatal(ws, 'SERVER_ERROR', '服务器内部错误');
      }
      if (!user) {
        // token 失效（过期/被删/重启导致密钥变化）——让前端退回登录页
        return failFatal(ws, 'BAD_TOKEN', '登录状态已失效，请重新登录');
      }
      finishHello(ws, {
        userId: user.id,
        nickname: cleanNickname(msg.nickname) || user.nickname || user.username,
        isGuest: false,
        // 账号用户：优先用他这次带过来的（刚在界面上选的），其次才是库里存着的
        avatar: msg.avatar || user.avatar
      });
    });
  }

  const nickname = cleanNickname(msg.nickname);
  if (!nickname) {
    return failFatal(ws, 'NEED_NICKNAME', '请填写昵称');
  }
  finishHello(ws, { userId: null, nickname: nickname, isGuest: true, avatar: msg.avatar });
}

// 握手收尾：登记连接、回 welcome、广播在线列表
function finishHello(ws, info) {
  const connId = nextConnId();
  ws.connId = connId;
  ws.helloPending = false;      // 握手已落地，后续消息正常走身份校验

  // 握手完成，撤掉握手超时
  if (ws.helloTimer) {
    clearTimeout(ws.helloTimer);
    ws.helloTimer = null;
  }

  // 头像：客户端可以在 hello 里带上它记住的那个，服务端只认白名单里的 id；
  // 没带或带了乱七八糟的值，就按当前在线人数摊一个默认的 ——
  // 用在线人数当种子，是为了让同屏的人默认就大概率不撞款。
  const avatar = avatars.isValid(info.avatar) ? info.avatar : avatars.pickFor(manager.count());

  manager.addConn(connId, {
    userId: info.userId,
    nickname: info.nickname,
    isGuest: info.isGuest,
    avatar: avatar,
    status: 'lobby'
  });
  sockets[connId] = ws;

  console.log('[ws] 接入 connId=' + connId + ' 昵称=' + info.nickname + (info.isGuest ? '（游客）' : '（账号 id=' + info.userId + '）') + ' 当前在线=' + manager.count());

  send(ws, {
    t: 'welcome',
    self: {
      connId: connId,
      userId: info.userId,
      nickname: info.nickname,
      isGuest: info.isGuest,
      // 回带服务端最终采用的头像（可能是客户端带的，也可能是服务端摊的默认值），
      // 客户端以这里为准，避免「我以为我选了 A、其实服务端给了我 B」这种不一致
      avatar: avatar
    },
    online: manager.listOnline(),
    serverTime: Date.now(),
    tickRate: config.tickRate
  });

  pushOnline(true);
}

// ============================================================
// 消息分发
// ============================================================

function handleMessage(ws, raw) {
  let msg = null;

  // 只接受 JSON 文本帧；解析失败直接提示，不断开连接
  if (typeof raw !== 'string') {
    return send(ws, { t: 'error', code: 'BAD_FORMAT', msg: '仅支持 JSON 文本消息' });
  }
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    return send(ws, { t: 'error', code: 'BAD_JSON', msg: '消息不是合法 JSON' });
  }
  if (!msg || typeof msg.t !== 'string') {
    return send(ws, { t: 'error', code: 'BAD_MSG', msg: '缺少消息类型字段 t' });
  }

  // 未握手前只允许 hello。
  //
  // 【这里原来是 `failFatal(ws, 'NOT_READY')`，而且 ping 也会被它拒掉】
  // 账号用户的 hello 是**异步**的（要查库校验 token），游客是同步的 —— 而客户端
  // 在 onopen 里是「发完 hello 紧接着发 ping」，两条帧几乎同时到达，ping 往往
  // 先被处理，此时 ws.connId 还是 null。实测线上复现率 **75%**（12 次里 9 次被踢）：
  // 账号登录后立刻被自己的心跳判死，界面表现为「已连接」的同时弹一条红的
  // 「请先发送 hello 握手」（游客 12/12 正常，所以一直没被发现）。
  //
  // 现在三层处理：
  //   ① ping 在握手前也照回 pong —— pong 是传输层的事，本来就不需要身份；
  //   ② hello 正在校验时到达的其它消息，静默忽略（是早到的噪声，不是攻击）；
  //   ③ 只有「压根没发过 hello」才报 NOT_READY，且**不再致命** ——
  //      真正的「连上从不说话」由 10 秒握手超时兜住，不该靠这条错误来管，
  //      更不该因为它把一个正常用户踢下线。
  if (!ws.connId) {
    if (msg.t === 'hello') return handleHello(ws, msg);
    if (msg.t === 'ping') return send(ws, { t: 'pong', ts: msg.ts, serverTime: Date.now() });
    if (ws.helloPending) return;
    return send(ws, { t: 'error', code: 'NOT_READY', msg: '请先发送 hello 握手' });
  }

  const conn = manager.getConn(ws.connId);
  if (!conn) {
    // 连接已被移除（理论上不会发生），视为需要重连
    return failFatal(ws, 'NO_CONN', '连接状态异常，请刷新页面');
  }

  if (msg.t === 'ping') {
    return send(ws, {
      t: 'pong',
      ts: typeof msg.ts === 'number' ? msg.ts : 0,
      serverTime: Date.now()
    });
  }

  if (msg.t === 'refresh') {
    return send(ws, onlinePayload());
  }

  if (msg.t === 'status') {
    // 前端切换（大厅/对局中）时同步状态
    const allowed = { lobby: 1, playing: 1, spectating: 1 };
    if (allowed[msg.status]) {
      manager.updateConn(ws.connId, { status: msg.status });
      pushOnline(true);
    }
    return;
  }

  // 房间与对局消息交给协议层（server/game/proto.js）。
  // 它是唯一知道房间/对局语义的地方，本文件只管连接。
  if (proto.handle(ws, conn, msg)) return;

  // 未知类型只回提示，不断连，方便后续阶段逐步加协议
  send(ws, { t: 'error', code: 'UNKNOWN_TYPE', msg: '未知消息类型: ' + msg.t });
}

// ============================================================
// 连接生命周期
// ============================================================

function handleClose(ws) {
  // 没握过手的连接也要撤掉握手超时定时器，否则它到点会对一条已经关掉的连接动作
  if (ws.helloTimer) {
    clearTimeout(ws.helloTimer);
    ws.helloTimer = null;
  }
  if (!ws.connId) return;
  const connId = ws.connId;

  // 【顺序很关键】先让协议层收尾（退房间 / 退出对局），
  // 再 manager.removeConn —— removeConn 会把 conn.roomCode 清空，
  // 到那时协议层就查不到他在哪个房间了，房间里的队友会看到「幽灵成员」。
  proto.onDisconnect(connId);

  const removed = manager.removeConn(connId);
  delete sockets[connId];

  // removeConn 现在返回 { conn, left }：left 是他在房间里的残留信息
  if (removed && removed.conn) {
    console.log('[ws] 断开 connId=' + connId + ' 昵称=' + removed.conn.nickname + ' 当前在线=' + manager.count());
  }
  ws.connId = null;
  pushOnline(true);
}

// ============================================================
// 对外接口
// ============================================================

hub.attach = function (httpServer) {
  // 把稳定的出口交给协议层。必须在收任何连接之前注入，
  // 否则对局模块拿到的 onSend 会是 null。
  proto.init({
    sendTo: sendToConn,
    broadcast: broadcast,
    pushOnline: pushOnline
  });

  wss = new WebSocket.Server({
    server: httpServer,
    path: '/ws',
    maxPayload: 64 * 1024,      // 客户端上行都是小消息，超限自动拒绝
    perMessageDeflate: false    // 关压缩：局域网带宽充足，省 CPU 与延迟
  });

  wss.on('connection', function (ws, req) {
    ws.connId = null;
    ws.isAlive = true;
    ws.msgCount = 0;
    ws.msgWindowAt = Date.now();

    // 记录来源 IP，方便排查是谁连不上
    ws.remoteIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      (req.socket && req.socket.remoteAddress) || '';

    // 握手超时兜底：连上却一直不发 hello 的连接要清掉。
    // 客户端那边有握手超时（8 秒），但**服务端也必须自己有一道** ——
    // 否则随便一个脚本开几千条「连上就不说话」的连接，就能白占 socket 与内存
    // （每条连接一个 ws 对象，还会被 30 秒一次的心跳巡检一遍）。这是最省事的拒绝服务入口。
    ws.helloTimer = setTimeout(function () {
      if (ws.connId) return;
      console.log('[ws] 握手超时，断开未握手的连接 ip=' + ws.remoteIp);
      hubDrop(ws, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    ws.on('pong', function () {
      ws.isAlive = true;
    });

    ws.on('message', function (raw) {
      // 上行速率限制。正常客户端只有 20Hz 的输入 + 5 秒一次的 ping（< 25 条/秒），
      // 而一个手写脚本能每秒灌几万条 JSON，让服务端在 JSON.parse 与业务分支上白烧 CPU。
      // 上限给得很宽松，只拦「明显不是人」的流量。
      const now = Date.now();
      if (now - ws.msgWindowAt > MSG_WINDOW_MS) {
        ws.msgWindowAt = now;
        ws.msgCount = 0;
      }
      ws.msgCount += 1;
      if (ws.msgCount > MSG_MAX_PER_WINDOW) {
        // 【只能断一次】判定超限之后必须打标记并停止处理后续消息 ——
        // 否则刷量的客户端每多发一条就再走一遍「记日志 + 关连接」，
        // 实测一次 900 条的刷量刷出了 486 行日志和 486 次 close 调用，
        // 限速本身反倒成了放大器（真踩过）。
        if (!ws.dropped) {
          ws.dropped = true;
          console.log('[ws] 上行过频，断开 connId=' + (ws.connId || '-') +
            '（' + Math.round(MSG_WINDOW_MS / 1000) + ' 秒内超过 ' + MSG_MAX_PER_WINDOW + ' 条）');
          hubDrop(ws, 'too many messages');
        }
        return;
      }
      handleMessage(ws, typeof raw === 'string' ? raw : String(raw));
    });

    ws.on('error', function (err) {
      // 客户端异常断开很常见（关页面、切网络），只记日志不额外处理
      console.log('[ws] 连接异常 connId=' + (ws.connId || '-') + ': ' + err.message);
    });

    ws.on('close', function () {
      handleClose(ws);
    });
  });

  // 心跳：清掉半死连接（拔网线/进程被杀时 close 事件不会触发）
  const heartbeat = setInterval(function () {
    const ids = Object.keys(sockets);
    for (let i = 0; i < ids.length; i++) {
      const ws = sockets[ids[i]];
      if (!ws) continue;
      if (ws.isAlive === false) {
        console.log('[ws] 心跳超时，强制断开 connId=' + ws.connId);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  // 定期补推在线列表：防止某次广播丢失导致客户端列表卡住不准
  const syncTimer = setInterval(function () {
    if (manager.count() > 0) pushOnline(false);
  }, 10000);
  syncTimer.unref();

  wss.on('close', function () {
    clearInterval(heartbeat);
    clearInterval(syncTimer);
  });

  console.log('[ws] WebSocket 已挂载在 /ws');
  return wss;
};

// 关服时主动断开所有连接，避免容器退出被长连接拖住
hub.closeAll = function () {
  if (closed) return;
  closed = true;

  const ids = Object.keys(sockets);
  for (let i = 0; i < ids.length; i++) {
    const ws = sockets[ids[i]];
    if (ws) {
      send(ws, { t: 'error', code: 'SERVER_CLOSING', msg: '服务器正在关闭', fatal: true });
      ws.close();
    }
  }
  if (wss) wss.close();
};

// 供后台管理页 / 调试使用
hub.count = function () {
  return Object.keys(sockets).length;
};

// 供 API 路由（/api/gamestats）与测试脚本复用
hub.sendTo = sendToConn;
hub.broadcastAll = broadcast;

module.exports = hub;
