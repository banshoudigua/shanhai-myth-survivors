// tools/statscheck.js —— 结算落库端到端自检（真实服务器 + 真数据库）
//
// 为什么要有它：库里有三张表（matches / match_players / player_stats）、
// 界面上一整套「我的档案 + 排行榜」，但很长一段时间里**没有任何代码往里写** ——
// 排行榜永远是空的、档案永远是 0，而这是靠读代码看不出来的
//（SQL 都在，只是没人调；界面还写着「打完第一局就会出现在这里」）。
//
// 覆盖：
//   [1] 注册两个账号（落库只认账号，游客不写）
//   [2] 两人打完一局后**各自退出**（这是最常见的收场方式）→ 战绩必须记下来
//   [3] /api/me 的累计统计 +  /api/leaderboard 能看到人
//   [4] 再打一局 → 累计场次要 +1（不是覆盖）
//   [5] 纯游客局不写库（不污染排行榜）
//
// 用法：先启动服务，再执行 node tools/statscheck.js [端口]

const WebSocket = require('ws');

// 参数可以是端口（本机自测），也可以是完整地址（线上复验用）：
//   node tools/statscheck.js 3000
//   node tools/statscheck.js https://xxx.app.workbuddy.host
const ARG = process.argv[2] || '3000';
const BASE = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : 'http://127.0.0.1:' + Number(ARG);
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + '  ->  ' + (detail === undefined ? '断言不成立' : detail)); }
}
const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// 每个账号唯一，反复跑不会撞名
const SUFFIX = String(Date.now()).slice(-7);

function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-VS-Token'] = token;
  return fetch(BASE + path, { method: 'POST', headers: headers, body: JSON.stringify(body) })
    .then(function (r) { return r.json(); });
}
function get(path, token) {
  const headers = {};
  if (token) headers['X-VS-Token'] = token;
  return fetch(BASE + path, { headers: headers }).then(function (r) { return r.json(); });
}

function openWs(tag) {
  const ws = new WebSocket(WS_URL);
  const c = { tag: tag, ws: ws, last: {}, welcomed: false, closed: false };
  ws.on('message', function (raw, isBin) {
    if (isBin) return;
    let m = null;
    try { m = JSON.parse(String(raw)); } catch (e) { return; }
    c.last[m.t] = m;
    if (m.t === 'welcome') { c.welcomed = true; c.connId = m.self.connId; }
  });
  ws.on('close', function () { c.closed = true; });
  c.send = function (obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
  c.hello = function (token) {
    return new Promise(function (r) {
      // 已经连上的情况要单独处理，否则监听器不响 → 一个 hello 都发不出去，
      // 服务端 10 秒后按握手超时踢掉，测试会以「莫名其妙没进房间」告终（踩过）
      if (ws.readyState === 1) { c.send({ t: 'hello', token: token }); return r(true); }
      ws.on('open', function () { c.send({ t: 'hello', token: token }); r(true); });
    });
  };
  return c;
}

// 等连接打开。**必须判 readyState**：socket 可能在挂监听器之前就已经 open 了，
// 那时 `ws.on('open')` 永远不会触发，脚本会一直挂着（这类等待超时最耗排查时间）。
function waitOpen(c) {
  return new Promise(function (r) {
    if (c.ws.readyState === 1) return r(true);
    c.ws.on('open', function () { r(true); });
  });
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

// 打完一局并让两人各自退出 —— 结束方式是重点：
// 「大家各自关掉页面」是收局最常见的方式，退出的人不该从战绩里消失。
async function playOneMatch(tokens) {
  const A = openWs('甲');
  const B = openWs('乙');
  await A.hello(tokens[0]);
  await B.hello(tokens[1]);
  await waitFor(function () { return A.welcomed && B.welcomed; }, 6000);

  A.send({ t: 'room_create', charId: 'hunter' });
  await waitFor(function () { return A.last.room_update; }, 6000);
  const code = A.last.room_update && A.last.room_update.room ? A.last.room_update.room.code : '';
  B.send({ t: 'room_join', code: code, charId: 'nun' });
  await waitFor(function () {
    const r = B.last.room_update && B.last.room_update.room;
    return r && r.members && r.members.length === 2;
  }, 6000);
  B.send({ t: 'room_ready', ready: true });
  await sleep(400);
  A.send({ t: 'game_start' });
  const started = await waitFor(function () { return A.last.game_start && B.last.game_start; }, 8000);
  if (!started) return { ok: false, reason: '没开成局' };

  // 让世界真的跑一会儿，攒一点击杀/时长（击杀数可能是 0，那也是合法数据）
  await sleep(5000);

  // 两人各自退出：第一个退的时候对局还没结束，第二个退才收局。
  // 收局时两人都已经不在 this.players 里了 —— 正是要验的那条路径。
  A.send({ t: 'game_leave' });
  await sleep(300);
  B.send({ t: 'game_leave' });
  await sleep(1800);
  return { ok: true, code: code };
}

async function main() {
  console.log('');
  console.log('=== 结算落库端到端自检（' + BASE + '） ===');

  // ---------------- [1] 注册两个账号 ----------------
  console.log('\n[1] 注册测试账号');
  const u1 = 'sta' + SUFFIX + 'a';
  const u2 = 'sta' + SUFFIX + 'b';
  const r1 = await post('/api/register', { username: u1, nickname: '战绩甲' + SUFFIX.slice(-3), password: 'pw123456' });
  const r2 = await post('/api/register', { username: u2, nickname: '战绩乙' + SUFFIX.slice(-3), password: 'pw123456' });
  expect('账号甲注册成功', !!(r1 && r1.ok && r1.token), JSON.stringify(r1));
  expect('账号乙注册成功', !!(r2 && r2.ok && r2.token), JSON.stringify(r2));
  if (!r1.ok || !r2.ok) { console.log('注册失败，后续无法继续'); return; }
  const T1 = r1.token;
  const T2 = r2.token;

  // 新账号的统计应该是空的（或者全 0）
  const me0 = await get('/api/me', T1);
  expect('新账号的档案接口可用', !!(me0 && me0.ok), JSON.stringify(me0));
  const before = me0.stats || {};
  expect('新账号总场次为 0',
    !before.total_matches, JSON.stringify(before));

  const lb0 = await get('/api/leaderboard?type=kills&limit=50');
  const lbCount0 = (lb0.list || []).length;

  // ---------------- [2][3] 打一局 → 各自退出 → 战绩必须入库 ----------------
  console.log('\n[2] 两人打一局后各自退出（最常见的收场方式）');
  const m1 = await playOneMatch([T1, T2]);
  expect('第一局打完并收局', !!m1.ok, m1.reason || '');

  const me1 = await get('/api/me', T1);
  const s1 = (me1 && me1.stats) || {};
  expect('对局结束后「我的档案」里场次变成 1',
    s1.total_matches === 1, JSON.stringify(s1));
  expect('累计时长被记录（> 0 秒）', s1.total_play_sec > 0, 'total_play_sec=' + s1.total_play_sec);
  expect('最高等级至少 1 级', s1.max_level >= 1, 'max_level=' + s1.max_level);

  const me2 = await get('/api/me', T2);
  expect('队友那一侧也被记了一笔', !!(me2 && me2.stats && me2.stats.total_matches === 1),
    JSON.stringify(me2 && me2.stats));

  const lb1 = await get('/api/leaderboard?type=kills&limit=50');
  const list1 = lb1.list || [];
  const nick1 = r1.user.nickname;
  const nick2 = r2.user.nickname;
  expect('排行榜里能看到刚打完的账号甲',
    list1.some(function (x) { return x.nickname === nick1; }), JSON.stringify(list1.map(function (x) { return x.nickname; })));
  expect('排行榜里能看到刚打完的账号乙',
    list1.some(function (x) { return x.nickname === nick2; }), '同上');
  expect('排行榜条目数比开局前多了（真的写进去了）', list1.length > lbCount0,
    lbCount0 + ' -> ' + list1.length);

  // ---------------- [4] 再打一局：累计而不是覆盖 ----------------
  console.log('\n[3] 再打一局（累计，不是覆盖）');
  const m2 = await playOneMatch([T1, T2]);
  expect('第二局打完', !!m2.ok, m2.reason || '');
  const me3 = await get('/api/me', T1);
  const s3 = (me3 && me3.stats) || {};
  expect('总场次累计成 2（不是被覆盖成 1）', s3.total_matches === 2, JSON.stringify(s3));
  expect('累计时长继续累加', s3.total_play_sec > s1.total_play_sec,
    s1.total_play_sec + ' -> ' + s3.total_play_sec);

  // ---------------- [5] 纯游客局不写库 ----------------
  console.log('\n[4] 纯游客局不该污染战绩');
  const lbBefore = (await get('/api/leaderboard?type=kills&limit=50')).list.length;
  const G1 = openWs('游客甲');
  const G2 = openWs('游客乙');
  await waitOpen(G1);
  await waitOpen(G2);
  G1.send({ t: 'hello', nickname: '路过甲' });
  G2.send({ t: 'hello', nickname: '路过乙' });
  await waitFor(function () { return G1.welcomed && G2.welcomed; }, 6000);
  G1.send({ t: 'room_create', charId: 'hunter' });
  await waitFor(function () { return G1.last.room_update; }, 6000);
  const gcode = G1.last.room_update.room.code;
  G2.send({ t: 'room_join', code: gcode, charId: 'hunter' });
  await waitFor(function () {
    const r = G2.last.room_update && G2.last.room_update.room;
    return r && r.members && r.members.length === 2;
  }, 6000);
  G2.send({ t: 'room_ready', ready: true });
  await sleep(400);
  G1.send({ t: 'game_start' });
  await waitFor(function () { return G1.last.game_start && G2.last.game_start; }, 8000);
  await sleep(2500);
  G1.send({ t: 'game_leave' });
  await sleep(300);
  G2.send({ t: 'game_leave' });
  await sleep(1800);
  try { G1.ws.close(); G2.ws.close(); } catch (e) { /* 收尾 */ }

  const lbAfter = (await get('/api/leaderboard?type=kills&limit=50')).list.length;
  expect('纯游客局结束不会往排行榜里塞人', lbAfter === lbBefore,
    lbBefore + ' -> ' + lbAfter);

  console.log('');
  console.log('=== 汇总 ===');
  console.log('  PASS  ' + pass);
  console.log('  FAIL  ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack || e));
  process.exit(1);
});
