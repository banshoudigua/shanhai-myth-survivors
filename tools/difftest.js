// tools/difftest.js —— 难度链路回归测试（要起服务）
//
// 难度这个功能有个特点：**表写对了不等于接线接对了**。
// 「const.js 里有 DIFFICULTIES」和「这一局真的按血月的倍率在跑」是两件事，
// 中间要穿过：房间 → 开局包 → 世界 → HUD → 结算 → 落库 六段。
// 任何一段断了，玩家的感受都是「我选了血月，怎么还是普通」。
// 所以这个脚本逐段断言，每段都验「值真的传到了」，而不是「字段存在」。
//
// 六段：
//   ① 建房带难度      —— room_create 时就可以指定
//   ② 房主可改        —— room_diff 生效并广播给同房所有人
//   ③ 只有房主能改    —— 乙改会被拒（NOT_HOST），且难度不变
//   ④ 大厅房间列表    —— 难度要出现在列表上（别人靠它选桌）
//   ⑤ 开局包与 HUD    —— difficulty + matchSec 都要到客户端，且 HUD 显示的是中文名
//   ⑥ 开局后锁死      —— 开局后再改会被拒（否则房间显示与世界倍率会对不上）
// 另外两条边界：非法难度 id 归一化成普通；/api/health 不应因此挂掉。
//
// 用法：node tools/difftest.js [端口或完整地址]
//   例：node tools/difftest.js 3000
//       node tools/difftest.js https://xxx.app.workbuddy.host
const WebSocket = require('ws');

// 与 fuzzcheck / statscheck 保持同一套参数约定：端口或完整 URL 都收。
// （线上复跑同一份脚本，是「加固/功能在真公网也成立」的唯一证据。）
const ARG = String(process.argv[2] || '3000');
const BASE = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0;
let fail = 0;
function ok(n, e) { pass += 1; console.log('  PASS  ' + n + (e ? '  (' + e + ')' : '')); }
function bad(n, d) { fail += 1; console.log('  FAIL  ' + n + '  ->  ' + d); }
function expect(n, c, d) { if (c) ok(n); else bad(n, d || '断言不成立'); }
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

async function waitFor(fn, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (fn()) return true;
    await sleep(100);
  }
  return false;
}

function client(tag) {
  const c = { tag: tag, ws: null, last: {}, err: '' };
  c.send = function (o) { c.ws.send(JSON.stringify(o)); };
  c.open = function (hello) {
    const ws = new WebSocket(WS_URL);
    c.ws = ws;
    ws.on('open', function () { ws.send(JSON.stringify(hello)); });
    ws.on('message', function (raw) {
      const buf = Buffer.from(raw);
      // 下行按首字节分流：只有 '{' 开头的才是 JSON（二进制快照不是）
      if (buf[0] !== 0x7b) return;
      const m = JSON.parse(buf.toString());
      c.last[m.t] = m;
    });
    ws.on('error', function (e) { c.err = e.message; });
  };
  c.room = function () { return c.last.room_update ? c.last.room_update.room : null; };
  c.close = function () { try { c.ws.close(); } catch (e) { /* 忽略 */ } };
  return c;
}

// 等一次「房间难度变成期望值」——room_update 是每次变更都推，等它比等固定时长稳。
async function waitRoomDiff(c, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 4000)) {
    const r = c.room();
    if (r && r.difficulty === want) return r;
    await sleep(100);
  }
  return null;
}

async function main() {
  console.log('=== 难度链路回归（' + BASE + '） ===');

  const A = client('甲');
  const B = client('乙');

  A.open({ t: 'hello', nickname: '难度甲' });
  await waitFor(function () { return !!A.last.welcome; }, 6000);
  expect('甲 握手成功', !!A.last.welcome, A.err || '没收到 welcome');

  // ---------------- ① 建房时就指定难度 ----------------
  A.send({ t: 'room_create', charId: 'hunter', difficulty: 'nightmare' });
  const r1 = await waitRoomDiff(A, 'nightmare', 5000);
  expect('① 建房时指定的难度生效（nightmare）', !!r1,
    'room.difficulty=' + (A.room() && A.room().difficulty));
  const CODE = r1 ? r1.code : '';
  expect('① 房间号正常返回', !!CODE, 'code=' + CODE);

  // ---------------- ② 房主改难度，同房所有人都要收到 ----------------
  A.send({ t: 'room_diff', difficulty: 'bloodmoon' });
  const r2 = await waitRoomDiff(A, 'bloodmoon', 4000);
  expect('② 房主改难度生效（bloodmoon）', !!r2,
    'room.difficulty=' + (A.room() && A.room().difficulty));

  // 乙进来看得到这个难度（房间状态是共享的，不该每人一份）
  B.open({ t: 'hello', nickname: '难度乙' });
  await waitFor(function () { return !!B.last.welcome; }, 6000);
  B.send({ t: 'room_join', code: CODE, charId: 'nun' });
  const rB = await waitRoomDiff(B, 'bloodmoon', 4000);
  expect('② 后进来的人看到的也是 bloodmoon（房间状态共享）', !!rB,
    'B 看到的=' + (B.room() && B.room().difficulty));

  // ---------------- ③ 只有房主能改 ----------------
  B.send({ t: 'room_diff', difficulty: 'casual' });
  await sleep(600);
  const errB = B.last.error;
  expect('③ 非房主改难度被拒（NOT_HOST）',
    !!(errB && errB.code === 'NOT_HOST'), JSON.stringify(errB || null));
  expect('③ 被拒之后难度没有被改掉',
    A.room() && A.room().difficulty === 'bloodmoon',
    'A 看到的=' + (A.room() && A.room().difficulty));

  // ---------------- ④ 大厅房间列表要带上难度 ----------------
  // 用一个第三方连接（没进房的大厅玩家）拉列表 —— 这才是列表的真实使用者。
  const C = client('丙');
  C.open({ t: 'hello', nickname: '难度丙' });
  await waitFor(function () { return !!C.last.welcome; }, 6000);
  C.send({ t: 'room_list' });
  await waitFor(function () { return !!C.last.room_list; }, 4000);
  const listed = C.last.room_list
    ? (C.last.room_list.list || []).filter(function (x) { return x.code === CODE; })[0]
    : null;
  expect('④ 大厅房间列表带上了难度（血月）',
    !!(listed && listed.difficulty === 'bloodmoon'),
    JSON.stringify(listed || null));

  // ---------------- ⑤ 开局包与 HUD ----------------
  B.send({ t: 'room_ready', ready: true });
  await sleep(600);
  A.send({ t: 'game_start' });
  const started = await waitFor(function () { return !!A.last.game_start; }, 6000);
  expect('⑤ 房主能开局', !!started, '没收到 game_start');

  const gsA = A.last.game_start;
  expect('⑤ 开局包带难度 id',
    !!(gsA && gsA.difficulty === 'bloodmoon'), 'difficulty=' + (gsA && gsA.difficulty));
  expect('⑤ 开局包带本局时长（1500 秒 = 血月 25 分钟）',
    !!(gsA && gsA.matchSec === 1500), 'matchSec=' + (gsA && gsA.matchSec));

  // 乙（非房主）也要拿到同一份难度 —— 这是「房间是唯一真相」的验证
  await waitFor(function () { return !!B.last.game_start; }, 6000);
  expect('⑤ 非房主收到的开局包难度一致',
    !!(B.last.game_start && B.last.game_start.difficulty === 'bloodmoon'),
    '乙 difficulty=' + (B.last.game_start && B.last.game_start.difficulty));

  // HUD：界面直接读这三个字段显示难度与倒计时
  const gotHud = await waitFor(function () { return !!A.last.hud; }, 8000);
  expect('⑤ 收到 HUD', !!gotHud, '没收到 hud');
  const hudA = A.last.hud || {};
  expect('⑤ HUD 带难度 id / 中文名 / 时长',
    hudA.diffId === 'bloodmoon' && hudA.diffName === '血月' && hudA.matchSec === 1500,
    JSON.stringify({ id: hudA.diffId, name: hudA.diffName, sec: hudA.matchSec }));
  expect('⑤ HUD 倒计时按本局时长算（timeLeft ≤ 1500 且 > 1400）',
    hudA.timeLeft <= 1500 && hudA.timeLeft > 1400, 'timeLeft=' + hudA.timeLeft);

  // ---------------- ⑥ 开局后不能再改 ----------------
  A.send({ t: 'room_diff', difficulty: 'casual' });
  await sleep(700);
  const errA = A.last.error;
  expect('⑥ 开局后改难度被拒（ROOM_PLAYING）',
    !!(errA && errA.code === 'ROOM_PLAYING'), JSON.stringify(errA || null));
  const hudLater = A.last.hud || {};
  expect('⑥ 被拒后世界仍在按血月的时长跑（没被偷偷改小）',
    hudLater.matchSec === 1500, 'matchSec=' + hudLater.matchSec);

  // ---------------- 边界：非法难度归一化 ----------------
  const D = client('丁');
  D.open({ t: 'hello', nickname: '难度丁' });
  await waitFor(function () { return !!D.last.welcome; }, 6000);
  D.send({ t: 'room_create', charId: 'hunter', difficulty: '这不是一个难度' });
  const rD = await waitRoomDiff(D, 'normal', 5000);
  expect('边界：非法难度 id 归一化成「普通」', !!rD,
    'D 的房间难度=' + (D.room() && D.room().difficulty));

  // 空值也不能把房间打歪
  D.send({ t: 'room_diff', difficulty: '' });
  const rD2 = await waitRoomDiff(D, 'normal', 3000);
  expect('边界：空难度值同样落到「普通」', !!rD2,
    'D 的房间难度=' + (D.room() && D.room().difficulty));

  // ---------------- 服务还活着（难度改动不该碰坏任何东西） ----------------
  const alive = await fetch(BASE + '/api/health').then(function (r) { return r.json(); })
    .catch(function (e) { return { err: String(e && e.message) }; });
  expect('服务健康检查正常', !!(alive && alive.ok === true), JSON.stringify(alive));

  A.close(); B.close(); C.close(); D.close();

  console.log('');
  console.log('PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本异常: ' + (e && e.message ? e.message : e));
  process.exit(1);
});
