// tools/fuzzcheck.js —— 对抗性输入与滥用边界自检（裸 WS + 真实服务器）
//
// 为什么必须有这个脚本：
//   nettest 验的是「协议走得通」，simtest/matchtest 验的是「逻辑算得对」，
//   但**没人验「客户端乱发东西会怎样」**。而这个应用是公开链接：
//   任何拿到地址的人都能连上来，一句 JSON 就能打到服务端最里层。
//
// 它回答四类问题：
//   [1] 握手边界：垃圾昵称、重复 hello、未握手就发业务消息
//   [2] 消息边界：非 JSON / 缺字段 / 未知类型 / 二进制帧
//   [3] 输入边界：非有限数（`1e999` 是合法 JSON，parse 出来是 Infinity）、
//                 null / 对象 / 字符串 —— 玩家坐标绝不能被搞成 NaN
//   [4] 滥用边界：上行刷量、建房刷量、choose 带宽放大、握手超时占坑
//
// 用法：先启动服务，再执行 node tools/fuzzcheck.js [端口]

const WebSocket = require('ws');
const PB = require('../shared/proto_bin.js');

// 参数可以是端口（本机自测），也可以是完整地址（线上复验用）：
//   node tools/fuzzcheck.js 3000
//   node tools/fuzzcheck.js https://xxx.app.workbuddy.host
const ARG = process.argv[2] || '3000';
const HTTP_BASE = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : 'http://127.0.0.1:' + Number(ARG);
const WS_URL = HTTP_BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + '  ->  ' + (detail === undefined ? '断言不成立' : detail)); }
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

function get(path) {
  return fetch(HTTP_BASE + path).then(function (r) { return r.json(); });
}

// ------------------------------------------------------------
// 极简 WS 客户端：记录最后一条各类消息，并统计收到多少帧
// ------------------------------------------------------------
function open(tag) {
  const ws = new WebSocket(WS_URL);
  const c = {
    tag: tag, ws: ws, last: {}, order: [],
    hudCount: 0, snapCount: 0, closed: false, closeCode: 0, closeReason: '',
    snap: null, prevSnap: null, welcomed: false, jsonErrors: 0
  };
  ws.on('message', function (raw, isBin) {
    if (isBin) {
      const s = PB.decode(raw, c.prevSnap);
      if (!s) return;
      c.prevSnap = s;
      c.snap = s;
      c.snapCount += 1;
      return;
    }
    let m = null;
    try { m = JSON.parse(String(raw)); } catch (e) { c.jsonErrors += 1; return; }
    c.last[m.t] = m;
    c.order.push(m.t);
    if (m.t === 'hud') c.hudCount += 1;
    if (m.t === 'welcome') c.welcomed = true;
  });
  ws.on('close', function (code, reason) {
    c.closed = true;
    c.closeCode = code;
    c.closeReason = String(reason || '');
  });
  c.send = function (obj) {
    if (ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    return false;
  };
  // 【必须能发原始字符串】测 Infinity 时不能用 JSON.stringify ——
  // 它会把 Infinity 序列化成 null，那样就测不到真正想测的东西了。
  c.sendRaw = function (str) {
    if (ws.readyState === 1) { ws.send(str); return true; }
    return false;
  };
  c.alive = function () { return ws.readyState === 1; };
  c.hello = function (nickname) {
    return new Promise(function (resolve) {
      // 【必须处理「已经 open 了」】`ws.on('open')` 只在尚未触发时才有用；
      // 如果 socket 在我们调 hello 之前就连上了，监听器永远不响 ——
      // 表现是「客户端一个 hello 都没发」，服务端 10 秒后按握手超时把它踢掉，
      // 而测试只会看到「莫名其妙连不上」。
      if (ws.readyState === 1) {
        c.send({ t: 'hello', nickname: nickname });
        return resolve(true);
      }
      ws.on('open', function () {
        c.send({ t: 'hello', nickname: nickname });
        resolve(true);
      });
    });
  };
  return c;
}

function waitFor(fn, ms) {
  const t0 = Date.now();
  return new Promise(function (resolve) {
    (function poll() {
      if (fn()) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(poll, 100);
    })();
  });
}

// 取快照里某个座位的坐标
function slotPos(c, slot) {
  if (!c.snap || !c.snap.players) return null;
  for (let i = 0; i < c.snap.players.length; i++) {
    if (c.snap.players[i].slot === slot) return c.snap.players[i];
  }
  return null;
}

// ============================================================
// [1] 握手边界
// ============================================================
async function testHello() {
  console.log('\n[1] 握手边界');

  // 空昵称：必须被拒，且是 fatal（让他重连）
  const a = open('空昵称');
  await a.hello('   ');
  const gotErr = await waitFor(function () { return !!a.last.error; }, 3000);
  expect('空昵称被拒（NEED_NICKNAME）',
    !!(gotErr && a.last.error.code === 'NEED_NICKNAME' && a.last.error.fatal === true),
    JSON.stringify(a.last.error || null));

  // 超长昵称：截断到 nicknameMax（12）
  const b = open('超长昵称');
  await b.hello('这是一个特别特别特别长的昵称应该被截断');
  await waitFor(function () { return b.welcomed; }, 4000);
  expect('超长昵称被截断到 12 字',
    !!(b.welcomed && b.last.welcome.self.nickname.length <= 12),
    b.welcomed ? '长度 ' + b.last.welcome.self.nickname.length : '没握手成功');

  // 控制字符 / 换行必须被清掉（否则会污染日志与界面）
  const c = open('控制字符');
  await c.hello('甲\u0007\u001b[31m\n乙');
  await waitFor(function () { return c.welcomed; }, 4000);
  const nick = c.welcomed ? c.last.welcome.self.nickname : '';
  expect('控制字符与换行被清洗',
    c.welcomed && nick.indexOf('\n') < 0 && nick.indexOf('\u001b') < 0 && nick.indexOf('\u0007') < 0,
    JSON.stringify(nick));

  // 非字符串昵称：不能被当成合法昵称（不然玩家名会变成 "[object Object]"）
  const d = open('对象昵称');
  await d.hello({ evil: true });
  await sleep(500);
  expect('对象当昵称被当成「没填昵称」拒掉',
    !!(d.last.error && d.last.error.code === 'NEED_NICKNAME' && !d.welcomed),
    'welcomed=' + d.welcomed + ' err=' + JSON.stringify(d.last.error || null));
  expect('被标 fatal 的连接真的被断开了', d.closed, '还开着（说了 fatal 却没关）');

  // 握手后重发 hello：不能凭空多出一个连接（否则在线列表会被自己灌水）
  const before = (await get('/api/players')).online.length;
  c.send({ t: 'hello', nickname: '重复握手' });
  await sleep(600);
  const after = (await get('/api/players')).online.length;
  expect('握手后重发 hello 不会多出一个在线连接', after === before,
    before + ' -> ' + after);
  expect('握手后重发 hello 只回一句「未知类型」', !!c.last.error && c.last.error.code === 'UNKNOWN_TYPE',
    JSON.stringify(c.last.error || null));

  // 未握手就发业务消息：要被拒，但**不能把连接断掉**。
  //
  // 【这条断言原来要求 fatal=true 且连接被断开 —— 那正是被修掉的行为】
  // 账号用户的 hello 要异步查库校验 token，客户端在 onopen 里又是「发完 hello
  // 紧接着发 ping」，那条 ping 会赶在握手完成前到达。以前它会被判成
  // 「未握手就发消息」并把连接踢掉，实测线上复现率 75%（12 次里被踢 9 次）。
  // 现在：消息照回 NOT_READY（让人知道为什么没生效），但连接留着、也不标 fatal ——
  // 「连上却一直不说话」由 10 秒握手超时兜住，不该靠这条错误来管。
  const e = open('未握手');
  await new Promise(function (r) { e.ws.on('open', r); });
  e.send({ t: 'input', mx: 1, my: 0 });
  const notReady = await waitFor(function () { return !!e.last.error; }, 3000);
  expect('未握手就发业务消息被拒（NOT_READY，且带原因）',
    !!(notReady && e.last.error.code === 'NOT_READY' && e.last.error.msg),
    JSON.stringify(e.last.error || null));
  expect('未握手就发业务消息不会标成致命（不再因为早发的包把人踢掉）',
    !!(e.last.error && e.last.error.fatal !== true),
    JSON.stringify(e.last.error || null));
  await sleep(800);
  expect('未握手那条连接仍然活着（等它把 hello 补上）', !e.closed, '被关掉了');
  // 补上 hello，它应该能正常走下去 —— 这也顺带证明「拒绝」没有顺手把连接弄坏
  e.send({ t: 'hello', nickname: '补握手' });
  expect('补发 hello 后仍能正常握手（拒绝没有弄坏这条连接）',
    await waitFor(function () { return !!e.last.welcome; }, 4000),
    JSON.stringify(e.last.error || null));

  // 握手前发 ping：必须照回 pong（pong 是传输层的事，不需要身份）。
  // 这条直接对着那个 75% 的线上故障：客户端的第一条 ping 就是在握手前发出的。
  const f = open('握手前ping');
  await new Promise(function (r) { f.ws.on('open', r); });
  f.send({ t: 'ping', ts: 12345 });
  expect('握手前发的 ping 也会收到 pong',
    await waitFor(function () { return !!f.last.pong; }, 3000),
    JSON.stringify(f.last.error || null));
  expect('握手前的 ping 不会让连接被断', !f.closed, '被关掉了');

  [a, b, c, d, e, f].forEach(function (x) { try { x.ws.close(); } catch (err) { /* 收尾 */ } });
}

// ============================================================
// [2] 消息格式边界
// ============================================================
async function testMessageFormat() {
  console.log('\n[2] 消息格式边界');

  const a = open('格式');
  await a.hello('格式测试');
  await waitFor(function () { return a.welcomed; }, 4000);

  a.sendRaw('这不是 JSON');
  await sleep(200);
  expect('非 JSON 被拒（BAD_JSON）且不断线',
    !!a.last.error && a.last.error.code === 'BAD_JSON' && a.alive(),
    JSON.stringify(a.last.error || null));

  a.sendRaw('[]');
  await sleep(200);
  expect('JSON 数组被拒（缺字段 t）',
    !!a.last.error && (a.last.error.code === 'BAD_MSG' || a.last.error.code === 'UNKNOWN_TYPE'),
    JSON.stringify(a.last.error || null));

  a.sendRaw('{"t":123}');
  await sleep(200);
  expect('t 不是字符串被拒',
    !!a.last.error && a.last.error.code === 'BAD_MSG', JSON.stringify(a.last.error || null));

  a.sendRaw('null');
  await sleep(200);
  expect('裸 null 被拒且不断线', a.alive(), '连接断了');

  a.send({ t: '完全不存在的消息类型' });
  await sleep(200);
  expect('未知类型只回提示不断线',
    !!a.last.error && a.last.error.code === 'UNKNOWN_TYPE' && a.alive(),
    JSON.stringify(a.last.error || null));

  // 二进制帧：服务端只接受 JSON 文本，二进制应该走「解析失败」而不是崩
  a.ws.send(Buffer.from([0x01, 0x02, 0x03, 0xff]));
  await sleep(300);
  expect('二进制帧不会让服务端出错', a.alive(), '连接断了');

  try { a.ws.close(); } catch (e) { /* 收尾 */ }
}

// ============================================================
// [3] 输入边界（本轮的核心）
// ============================================================
async function testInput() {
  console.log('\n[3] 输入边界（坐标绝不能被搞成 NaN）');

  const A = open('甲');
  const B = open('乙');
  await A.hello('乱发包的甲');
  await B.hello('旁观乙');
  await waitFor(function () { return A.welcomed && B.welcomed; }, 5000);

  A.send({ t: 'room_create', charId: 'hunter' });
  await waitFor(function () { return A.last.room_update; }, 5000);
  const code = A.last.room_update && A.last.room_update.room ? A.last.room_update.room.code : '';
  B.send({ t: 'room_join', code: code, charId: 'nun' });
  await waitFor(function () {
    const r = B.last.room_update && B.last.room_update.room;
    return r && r.members && r.members.length === 2;
  }, 5000);
  B.send({ t: 'room_ready', ready: true });
  await sleep(400);
  A.send({ t: 'game_start' });
  const started = await waitFor(function () { return A.last.game_start && B.last.game_start; }, 8000);
  expect('两人成功开局（后续输入测试的载体）', !!started, '没收到 game_start');
  if (!started) return;

  // 等快照稳定，记下甲的初始位置
  await waitFor(function () { return B.snapCount > 10; }, 5000);
  const p0 = slotPos(B, 0);
  const x0 = p0 ? p0.x : 0;
  const y0 = p0 ? p0.y : 0;
  expect('能读到甲的初始坐标', Number.isFinite(x0) && Number.isFinite(y0), 'x=' + x0 + ' y=' + y0);

  // ---- 各种畸形输入 ----
  // 1e999 是**合法 JSON**，JSON.parse 出来是 Infinity；`Number(Infinity) || 0` 也是 Infinity，
  // 而 Infinity 参与归一化会得到 NaN。NaN 一旦进世界：clamp 拦不住、怪也跟着 NaN。
  A.sendRaw('{"t":"input","mx":1e999,"my":0}');
  A.sendRaw('{"t":"input","mx":-1e999,"my":1e999}');
  A.sendRaw('{"t":"input","mx":"1e999","my":"abc"}');
  A.sendRaw('{"t":"input","mx":null,"my":null}');
  A.sendRaw('{"t":"input","mx":{},"my":[]}');
  A.sendRaw('{"t":"input"}');
  A.sendRaw('{"t":"input","mx":true,"my":false}');
  await sleep(1200);

  const p1 = slotPos(B, 0);
  expect('畸形输入之后甲的坐标仍然是有限数（没被搞成 NaN）',
    !!(p1 && Number.isFinite(p1.x) && Number.isFinite(p1.y)),
    p1 ? ('x=' + p1.x + ' y=' + p1.y) : '快照里找不到甲');
  expect('畸形输入没有把甲挪走',
    !!(p1 && Math.abs(p1.x - x0) < 1 && Math.abs(p1.y - y0) < 1),
    'x ' + x0 + ' -> ' + (p1 && p1.x));

  // 全场怪也必须都是有限数（NaN 会顺着「怪追玩家」扩散）
  let badMob = null;
  if (B.snap && B.snap.mobs) {
    for (let i = 0; i < B.snap.mobs.length; i++) {
      const m = B.snap.mobs[i];
      if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) { badMob = m; break; }
    }
  }
  expect('场上所有怪的坐标都是有限数', !badMob, JSON.stringify(badMob));

  // ---- 正常输入必须照样生效（别把正常玩家也一起拦了）----
  const beforeX = p1 ? p1.x : x0;
  for (let i = 0; i < 12; i++) {
    A.send({ t: 'input', mx: 1, my: 0, seq: i + 1 });
    await sleep(50);
  }
  const p2 = slotPos(B, 0);
  expect('正常输入仍然能驱动位移（没被误伤）',
    !!(p2 && p2.x > beforeX + 5), 'x ' + beforeX + ' -> ' + (p2 && p2.x));

  // ---- 视口垃圾值：不能搞出「不裁剪」导致快照暴涨 ----
  B.send({ t: 'room_join', code: code, charId: 'nun', viewW: 1e999, viewH: -5 });
  await sleep(800);
  expect('视口报垃圾值不会让服务端出错（乙还在收快照）', B.snapCount > 0 && B.alive(),
    'snapCount=' + B.snapCount + ' alive=' + B.alive());

  // ---- choose 放大：不在升级面板时狂发 choose，不该每次都换回一份完整 HUD ----
  const hudBefore = A.hudCount;
  for (let i = 0; i < 60; i++) A.send({ t: 'choose', index: i });
  await sleep(1500);
  const gained = A.hudCount - hudBefore;
  expect('不在升级面板时狂发 choose 不会被当成放大入口（回包数远小于发送数）',
    gained < 25, '发了 60 条 choose，收回 ' + gained + ' 份 HUD');

  try { A.ws.close(); B.ws.close(); } catch (e) { /* 收尾 */ }
}

// ============================================================
// [4] 滥用边界
// ============================================================
async function testAbuse() {
  console.log('\n[4] 滥用边界');

  // --- 正常 20Hz 输入不能被速率限制误杀 ---
  const ok = open('正常节奏');
  await ok.hello('正常玩家');
  await waitFor(function () { return ok.welcomed; }, 4000);
  for (let i = 0; i < 100; i++) {
    ok.send({ t: 'input', mx: 1, my: 0, seq: i });   // 100 条 / 200ms，远快于真实 20Hz
    await sleep(20);
  }
  expect('正常量级的输入不会被速率限制断开', ok.alive(), '被断开了 code=' + ok.closeCode);

  // --- 刷量必须被断开 ---
  const spam = open('刷量');
  await spam.hello('刷量者');
  await waitFor(function () { return spam.welcomed; }, 4000);
  for (let i = 0; i < 900; i++) spam.send({ t: 'ping', ts: i });
  const dropped = await waitFor(function () { return spam.closed; }, 4000);
  expect('5 秒内狂发 900 条会被断开', !!dropped,
    '还开着（msgCount 限制没生效）');
  expect('断开用的是策略违规码 1008', spam.closeCode === 1008, 'code=' + spam.closeCode);

  // --- 建房刷量：一个连接反复建房不该把房间堆起来 ---
  const builder = open('建房刷');
  await builder.hello('建房刷子');
  await waitFor(function () { return builder.welcomed; }, 4000);
  const roomsBefore = (await get('/api/rooms')).list.length;
  for (let i = 0; i < 80; i++) builder.send({ t: 'room_create', charId: 'hunter' });
  await sleep(2500);
  const roomsAfter = (await get('/api/rooms')).list.length;
  expect('连发 80 次建房不会堆出 80 个房间（旧房会被退掉）',
    roomsAfter - roomsBefore <= 1, '房间数 ' + roomsBefore + ' -> ' + roomsAfter);
  expect('建房刷完之后连接还在（建房不是致命错误）', builder.alive(), '断了');

  // --- 房间与权限边界 ---
  const x = open('边界');
  await x.hello('边界测试');
  await waitFor(function () { return x.welcomed; }, 4000);
  x.send({ t: 'room_join', code: 'ZZZZ' });
  await waitFor(function () { return x.last.error; }, 3000);
  expect('加入不存在的房间回 ROOM_NOT_FOUND',
    !!x.last.error && x.last.error.code === 'ROOM_NOT_FOUND', JSON.stringify(x.last.error || null));

  // 非房主不能开局
  const host = open('真房主');
  await host.hello('真房主');
  await waitFor(function () { return host.welcomed; }, 4000);
  host.send({ t: 'room_create', charId: 'hunter' });
  await waitFor(function () { return host.last.room_update; }, 4000);
  const code2 = host.last.room_update.room.code;
  x.last.error = null;
  x.send({ t: 'room_join', code: code2, charId: 'hunter' });
  await waitFor(function () {
    const r = x.last.room_update && x.last.room_update.room;
    return r && r.members && r.members.length === 2;
  }, 4000);
  x.last.error = null;
  x.send({ t: 'game_start' });
  await waitFor(function () { return x.last.error; }, 3000);
  expect('非房主开局被拒（NOT_HOST）',
    !!x.last.error && x.last.error.code === 'NOT_HOST', JSON.stringify(x.last.error || null));
  const roomState = (await get('/api/rooms')).list.filter(function (r) { return r.code === code2; })[0];
  expect('被拒之后房间仍然是等待中（没被偷偷开局）',
    !!roomState && roomState.state === 'waiting', JSON.stringify(roomState || null));

  // 非法角色 id：降级成默认而不是报错
  x.send({ t: 'room_char', charId: '../../etc/passwd' });
  await sleep(500);
  const after = x.last.room_update && x.last.room_update.room;
  const me = after ? after.members.filter(function (m) { return m.self; })[0] : null;
  expect('非法角色 id 被降级成合法角色',
    !!(me && ['hunter', 'nun', 'blacksmith', 'alchemist'].indexOf(me.charId) >= 0),
    JSON.stringify(me || null));

  [ok, builder, x, host].forEach(function (c) { try { c.ws.close(); } catch (e) { /* 收尾 */ } });

  // --- 握手超时：连上不说话不能白占坑 ---
  const silent = open('沉默');
  await new Promise(function (r) { silent.ws.on('open', r); });
  const killed = await waitFor(function () { return silent.closed; }, 16000);
  expect('连上不发 hello 会被握手超时清掉', !!killed, '16 秒后还挂着');
}

// ============================================================

(async function () {
  console.log('');
  console.log('=== 对抗性输入与滥用边界自检（' + HTTP_BASE + '） ===');

  await testHello();
  await testMessageFormat();
  await testInput();
  await testAbuse();

  console.log('');
  console.log('=== 汇总 ===');
  console.log('  PASS  ' + pass);
  console.log('  FAIL  ' + fail);
  process.exit(fail > 0 ? 1 : 0);
})();
