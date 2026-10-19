// tools/avatartest.js —— 头像链路回归测试（要起服务）
//
// 头像要穿过四条链路，任何一条断了都会表现成「我选了头像、别人却看不见」：
//   ① 握手回带       —— 服务端最终采用的 id 要回给本人
//   ② 大厅在线列表   —— 别人在大厅就能看到我选的头像
//   ③ 候场室成员     —— 同房的人看得到（注意 emitRoom 是逐字段白名单复制，
//                        加字段时极易漏，这里就是专门盯它的）
//   ④ 对局名单       —— 游戏里队友头顶名牌读这份
// 另外两条边界：非法 id 必须被忽略；对局中换头像要广播新名单。
//
// 用法：先启动服务，再执行 node tools/avatartest.js [端口]
const WebSocket = require('ws');
const PB = require('../shared/proto_bin.js');

// 参数：端口（3000）或完整地址（https://xxx.app.workbuddy.host）。
// 与 fuzzcheck / statscheck / difftest / spectest 同一套约定。
// 原来这里只认端口，传完整 URL 时 Number() 得到 NaN，地址就成了
// ws://127.0.0.1:NaN/ws —— 报「Invalid URL」，看不出是自己没处理。
const ARG = String(process.argv[2] || 3007);
const URL = /^https?:\/\//.test(ARG)
  ? ARG.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws'
  : 'ws://127.0.0.1:' + (Number(ARG) || 3007) + '/ws';

let pass = 0;
let fail = 0;
function ok(n, e) { pass += 1; console.log('  PASS  ' + n + (e ? '  (' + e + ')' : '')); }
function bad(n, d) { fail += 1; console.log('  FAIL  ' + n + '  -> ' + d); }
function expect(n, c, d) { if (c) ok(n); else bad(n, d || '断言不成立'); }
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function waitFor(fn, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(120);
  }
  return false;
}

function client(tag) {
  const c = { tag: tag, ws: null, last: {}, prev: null };
  c.send = function (o) { c.ws.send(JSON.stringify(o)); };
  c.open = function (hello) {
    const ws = new WebSocket(URL);
    c.ws = ws;
    ws.on('open', function () { ws.send(JSON.stringify(hello)); });
    ws.on('message', function (raw) {
      const buf = Buffer.from(raw);
      if (buf[0] !== 0x7b) return;        // 不是 '{' 就是二进制快照，本测试不看
      const m = JSON.parse(buf.toString());
      c.last[m.t] = m;
    });
    ws.on('error', function (e) { c.err = e.message; });
  };
  return c;
}

async function main() {
  const A = client('甲');
  const B = client('乙');

  // ---- ① 握手回带 ----
  A.open({ t: 'hello', nickname: '头像甲', avatar: 'moon' });
  await waitFor(function () { return !!A.last.welcome; }, 5000);
  expect('甲 握手成功', !!A.last.welcome, A.err || '没收到 welcome');
  expect('甲 的头像是 hello 里带的 moon',
    !!(A.last.welcome && A.last.welcome.self.avatar === 'moon'),
    JSON.stringify(A.last.welcome && A.last.welcome.self));

  B.open({ t: 'hello', nickname: '头像乙', avatar: 'star' });
  await waitFor(function () { return !!B.last.welcome; }, 5000);
  expect('乙 的头像是 hello 里带的 star',
    !!(B.last.welcome && B.last.welcome.self.avatar === 'star'),
    JSON.stringify(B.last.welcome && B.last.welcome.self));

  // 没带头像的游客应当被摊一个默认值（而不是空）
  const C = client('丙');
  C.open({ t: 'hello', nickname: '头像丙' });
  await waitFor(function () { return !!C.last.welcome; }, 5000);
  expect('没带头像的游客被分到默认头像（非空）',
    !!(C.last.welcome && C.last.welcome.self.avatar && C.last.welcome.self.avatar.length > 0),
    JSON.stringify(C.last.welcome && C.last.welcome.self));

  // ---- ② 大厅在线列表 ----
  await sleep(700);
  const online = (A.last.online && A.last.online.list) || [];
  const meA = online.filter(function (p) { return p.nickname === '头像甲'; })[0];
  const meB = online.filter(function (p) { return p.nickname === '头像乙'; })[0];
  expect('在线列表带上了头像', !!meA && meA.avatar === 'moon' && !!meB && meB.avatar === 'star',
    JSON.stringify(online.map(function (p) { return p.nickname + ':' + p.avatar; })));

  // ---- ③ 候场室成员 ----
  A.send({ t: 'room_create', charId: 'hunter' });
  await waitFor(function () { return !!A.last.room_update; }, 5000);
  let room = A.last.room_update && A.last.room_update.room;
  expect('候场室成员带头像', !!room && room.members[0].avatar === 'moon',
    room ? JSON.stringify(room.members.map(function (m) { return m.nickname + ':' + m.avatar; })) : '没拿到房间');
  const code = room ? room.code : null;

  // 换头像：候场室应当立刻更新
  A.send({ t: 'set_avatar', avatar: 'crown' });
  await sleep(600);
  room = A.last.room_update && A.last.room_update.room;
  expect('换头像后候场室立即更新为 crown',
    !!room && room.members[0].avatar === 'crown',
    room ? JSON.stringify(room.members.map(function (m) { return m.nickname + ':' + m.avatar; })) : '-');

  // 非法 id 必须被忽略
  A.send({ t: 'set_avatar', avatar: '不存在的头像' });
  await sleep(500);
  room = A.last.room_update && A.last.room_update.room;
  expect('非法头像 id 被忽略（保持 crown）', !!room && room.members[0].avatar === 'crown',
    room ? room.members[0].avatar : '-');

  // ---- ④ 对局名单 ----
  B.send({ t: 'room_join', code: code, charId: 'hunter' });
  await sleep(700);
  B.send({ t: 'room_ready', ready: true });
  await sleep(700);
  A.send({ t: 'game_start' });
  await waitFor(function () { return !!A.last.game_start; }, 6000);

  const gs = A.last.game_start;
  const list = gs ? gs.players.slice().sort(function (x, y) { return x.slot - y.slot; }) : [];
  expect('开局名单带上了每个人的头像',
    !!gs && list.length === 2 && list[0].avatar === 'crown' && list[1].avatar === 'star',
    JSON.stringify(list.map(function (p) { return p.slot + ':' + p.name + ':' + p.avatar; })));

  // 对局中换头像：应当广播新名单（队友名牌靠它刷新）
  A.send({ t: 'set_avatar', avatar: 'bolt' });
  const got = await waitFor(function () {
    return !!(A.last.roster && A.last.roster.list.filter(function (p) { return p.avatar === 'bolt'; }).length === 1);
  }, 4000);
  expect('对局中换头像会广播新名单（队友名牌据此刷新）', got,
    A.last.roster ? JSON.stringify(A.last.roster.list.map(function (p) { return p.name + ':' + p.avatar; })) : '没收到 roster');

  console.log('');
  console.log('PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本异常: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
