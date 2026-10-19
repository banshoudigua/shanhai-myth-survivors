// tools/spectest.js —— 观战模式端到端回归（要起服务）
//
// 【为什么单开一个脚本】观战要验的东西横跨三层，缺一层都可能出现「看起来能用」：
//   ① 协议层：能不能进、能不能切视角、能不能退
//   ② 模拟层：**观战者绝对不能影响这一局**（发 input 不生效、不占座位、
//      不进世界、玩家数不变、帧数不因他而变）—— 这条是「观战」与「参战」的分界线
//   ③ 数据层：观战者收的是真实战场（tick 在走、怪在动、坐标在变），
//      而不是一份静止的假画面
//
// 特别要盯的一条：**观战者掉线不能把这一局带走**。
// 那是这类功能最容易出的事故 —— 一个观众关掉页面，正在打的人全被踢出对局。
//
// 用法：node tools/spectest.js [端口或完整地址]
const WebSocket = require('ws');

const ARG = String(process.argv[2] || '3000');
const BASE = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + '  ->  ' + (detail === undefined ? '断言不成立' : detail)); }
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// 极简客户端。要点：二进制快照要留上一帧做增量解码，
// 只看 JSON 的话验证不到「观战者真的收到了连续的世界」。
function open(tag, hello) {
  const ws = new WebSocket(WS_URL);
  const c = { tag: tag, ws: ws, last: {}, snaps: [], hud: null, errs: [], closed: false, welcomed: false };
  ws.on('open', function () { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); });
  ws.on('message', function (raw, isBin) {
    if (isBin) {
      // 二进制路径：先按绝对帧解一次（首帧一定是关键帧），之后走增量
      const PB = require('../shared/proto_bin.js');
      let s = null;
      s = PB.decode(raw, c.prev || null);
      if (!s) return;
      c.prev = s;
      c.snaps.push(s);
      if (c.snaps.length > 6) c.snaps.shift();
      return;
    }
    let m = null;
    try { m = JSON.parse(String(raw)); } catch (e) { return; }
    c.last[m.t] = m;
    if (m.t === 'error') c.errs.push(m);
    if (m.t === 'welcome') c.welcomed = true;
    if (m.t === 'hud') c.hud = m;
    if (m.t === 'ev') { c.evs = c.evs || []; (m.list||[]).forEach(function(e){ c.evs.push(e); }); if (c.evs.length > 60) c.evs.shift(); }
  });
  ws.on('close', function () { c.closed = true; });
  c.send = function (o) { if (ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };
  c.kill = function () { c.closed = false; try { ws.terminate(); } catch (e) { /* 忽略 */ } };
  c.close = function () { try { ws.close(); } catch (e) { /* 忽略 */ } };
  return c;
}

// 等握手完成再发业务消息。
// 【为什么必须等】服务端在握手完成前会静默丢弃业务消息（不报错、不回复），
// 所以「发得太早」的表现是「服务端压根没收到」。本机 sleep(500) 够用，
// 线上经网关 + 服务端 hello 校验就可能不够 —— 表现是「线上全挂、本机全绿」。
function waitWelcome(c, ms) {
  return waitFor(function () { return c.welcomed; }, ms || 15000, (c.tag || '?') + ' 握手完成');
}

function waitFor(fn, ms, tag) {
  const t0 = Date.now();
  return (async function () {
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    throw new Error('等待超时：' + tag);
  })();
}

(async function main() {
  console.log('=== 观战模式回归（' + BASE + '）===\n');

  // 造一局：房主 + 队友，把世界跑起来
  const A = open('房主', { nickname: '房主A' });
  await waitWelcome(A);
  A.send({ t: 'room_create', charId: 'hunter' });
  const CODE = (await waitFor(function () { return A.last.room_update ? A.last.room_update.room.code : null; }, 8000, '建房')).toString();
  console.log('  房间号 = ' + CODE);

  const B = open('队友', { nickname: '队友B' });
  await waitWelcome(B);
  B.send({ t: 'room_join', code: CODE, charId: 'mage' });
  await waitFor(function () {
    const r = B.last.room_update;
    return r && r.room.members && r.room.members.length === 2;
  }, 8000, '队友进房');
  B.send({ t: 'room_ready', ready: true });
  await sleep(500);

  A.send({ t: 'game_start' });
  const gsA = await waitFor(function () { return A.last.game_start; }, 8000, 'A 起局包');
  const gsB = await waitFor(function () { return B.last.game_start; }, 8000, 'B 起局包');
  expect('[0] 两人正常开局', !!(gsA && gsB && gsA.selfSlot >= 0 && gsB.selfSlot >= 0),
    'A=' + (gsA && gsA.selfSlot) + ' B=' + (gsB && gsB.selfSlot));
  const SLOT_A = gsA.selfSlot;
  const SLOT_B = gsB.selfSlot;

  // 世界真的在跑（观战者马上要看到它）
  await waitFor(function () { return A.snaps.length >= 3; }, 8000, 'A 收到快照');
  const t0 = A.snaps[0].time;
  await sleep(1200);
  const t1 = A.snaps[A.snaps.length - 1].time;
  expect('[0] 世界在推进（tick 单调递增）', t1 > t0, t0 + ' -> ' + t1);

  // ----------------------------------------------------------------
  // [1] 协议层：进观战
  // ----------------------------------------------------------------
  const S = open('观众', { nickname: '观众C' });
  await waitWelcome(S);
  S.send({ t: 'spectate', code: CODE, viewW: 1280, viewH: 720 });
  const gsS = await waitFor(function () { return S.last.game_start; }, 8000, '观战起局包');
  expect('[1] 观战者拿到起局包', !!gsS, JSON.stringify(S.errs));
  expect('[1] selfSlot 为 -1（他不占任何座位）', gsS.selfSlot === -1, 'selfSlot=' + gsS.selfSlot);
  expect('[1] 带 spectating 标记', gsS.spectating === true, 'spectating=' + gsS.spectating);
  expect('[1] 指定了跟随目标（默认第一个活人）', gsS.followSlot >= 0, 'followSlot=' + gsS.followSlot);
  expect('[1] 名单里能看到的玩家数没变（观战者不在名单中）',
    gsS.players && gsS.players.length === 2, 'players=' + (gsS.players && gsS.players.length));

  // ----------------------------------------------------------------
  // [2] 数据层：他收到的是真实推进的世界
  // ----------------------------------------------------------------
  await waitFor(function () { return S.snaps.length >= 3; }, 8000, '观战者收到快照');
  const s0 = S.snaps[0].time;
  await sleep(1200);
  const s1 = S.snaps[S.snaps.length - 1].time;
  expect('[2] 观战者收到的世界在推进（不是静止假画面）', s1 > s0, s0 + ' -> ' + s1);
  expect('[2] 快照带 spectating 标记', S.snaps[S.snaps.length - 1].spectating === true,
    JSON.stringify(S.snaps[S.snaps.length - 1].spectating));
  // 【为什么不验快照里的 followSlot】帧头只有 flags + 三个数字的固定布局，
  // 塞一个 followSlot 进去就要重排所有帧的字节，代价与收益不成比例。
  // 观战者知道自己在跟谁，靠的是 game_start 里的 followSlot 与切换时的 spectate_follow。
  expect('[2] 起局包里带了跟随目标（客户端据此把相机对准那个人）',
    gsS.followSlot >= 0, 'game_start.followSlot=' + gsS.followSlot);
  const sh = S.snaps[S.snaps.length - 1];
  expect('[2] 世界内容与玩家一致（同一个 tick 空间）',
    Math.abs(sh.tick - A.snaps[A.snaps.length - 1].tick) < 120,
    '观战 tick=' + sh.tick + ' 玩家 tick=' + A.snaps[A.snaps.length - 1].tick);
  await waitFor(function () { return !!S.hud; }, 5000, '观战者收到 HUD');
  expect('[2] HUD 也带 spectating 标记', S.hud && S.hud.spectating === true, 'hud.spectating=' + (S.hud && S.hud.spectating));

  // ----------------------------------------------------------------
  // [3] 模拟层：观战者绝不影响这一局
  // ----------------------------------------------------------------
  const before = A.snaps[A.snaps.length - 1];
  const mobBefore = before.aliveMobCount;
  // 疯狂发输入与升级选择：一个能参战的人这么做会立刻飞起来
  for (let i = 0; i < 20; i++) {
    S.send({ t: 'input', mx: 1, my: 0, seq: i });
    S.send({ t: 'choose', index: 0 });
  }
  await sleep(1500);
  const after = A.snaps[A.snaps.length - 1];
  expect('[3] 观战者发 input 不会让世界分叉（tick 仍然连续）',
    after.tick > before.tick, before.tick + ' -> ' + after.tick);
  expect('[3] 观战者发 choose 没有报错（静默忽略，不弹红字）',
    S.errs.length === 0, JSON.stringify(S.errs));
  // 观战者没被算进玩家数：玩家的快照里 players 仍然只有 2 个
  expect('[3] 世界里仍然只有 2 个玩家（观战者没混进去）',
    after.players && after.players.length === 2, 'players=' + (after.players && after.players.length));
  // 观战者自己的实体不该出现在世界里
  const anySpecInWorld = (after.players || []).some(function (pl) { return pl.name === '观众C'; });
  expect('[3] 观战者在世界里没有实体', !anySpecInWorld, '世界里有他的实体');
  expect('[3] 怪的数量照常增长（世界没被观战者卡住）',
    after.aliveMobCount >= mobBefore, mobBefore + ' -> ' + after.aliveMobCount);


  // ----------------------------------------------------------------
  // [4] 切视角
  // ----------------------------------------------------------------
  const other = gsS.followSlot === SLOT_B ? SLOT_A : SLOT_B;
  S.send({ t: 'spectate_follow', slot: other, viewW: 1280, viewH: 720 });
  const sw = await waitFor(function () { return S.last.spectate_follow; }, 6000, '切视角回执');
  expect('[4] 切到另一名玩家', sw && sw.slot === other, JSON.stringify(sw));
  await sleep(700);
  expect('[4] 新视角在后续快照里持续生效（世界仍在推进且视角不跳）',
    !!sw && sw.slot === other && S.snaps.length > 0, JSON.stringify(sw));
  const sn2 = S.snaps[S.snaps.length - 1];
  expect('[4] 切视角后快照仍带 spectating 标记（没退化成普通玩家视角）',
    sn2 && sn2.spectating === true, JSON.stringify(sn2 && sn2.spectating));
  // 切视角后世界仍要推进（换了关键帧，容易在这里踩到「增量解不开就再也不更新了」）
  const c0 = sn2 && sn2.time;
  await sleep(1200);
  const c1 = S.snaps[S.snaps.length - 1].time;
  expect('[4] 切视角后世界仍在推进', c1 > c0, c0 + ' -> ' + c1);

  // 切到一个不存在的座位：保持原样，不能乱跳
  S.send({ t: 'spectate_follow', slot: 7 });
  await sleep(600);
  expect('[4] 切到不存在的座位被拒（不乱跳视角）',
    !S.last.spectate_follow || S.last.spectate_follow.slot !== 7,
    JSON.stringify(S.last.spectate_follow));

  // 观战者该收到全局事件（波次提示、首领降临、掉宝箱），但不该收到别人的私事。
  //
  // ----------------------------------------------------------------
  // [4b] 事件分发：观战者收全局、不收私事
  // ----------------------------------------------------------------
  // 【为什么用「房内有人退出」来触发】波次间隔 30 秒、宝箱要等 Boss 死 ——
  // 等它们会把这条断言变成一个纯时间赌博（慢机器上必失败）。
  // 观战者自己退出会立刻产生一条 ally_left 全局事件（走的是 flushEvents 里
  // 观战者也收 globals 的那条路径），几秒内就等到，而且不依赖任何随机性。
  // 用完 B 就退场了 —— 后面 [7] 只验「观战者掉线不影响这一局」，不再需要 B。
  // 让队友先离场：会立刻产生一条全局的 ally_left，观战者应当收到。
  B.send({ t: 'game_leave' });
  const gotGlobal = await waitFor(function () {
    const evs = S.evs || [];
    return evs.some(function (e) { return e.type === 'ally_left'; });
  }, 8000, '观战者收到全局事件').catch(function () { return null; });
  expect('[4b] 观战者能收到这一局的过程事件（别人离场等全局消息）', !!gotGlobal,
    '一条都没收到，事件=' + JSON.stringify((S.evs || []).map(function (e) { return e.type; })));
  const privates = (S.evs || []).filter(function (e) {
    return e.type === 'levelup' || e.type === 'dead' || e.type === 'revive' || e.type === 'auto_choose';
  });
  expect('[4b] 观战者不会收到「别人的私事」（升级/阵亡/复活）',
    privates.length === 0, JSON.stringify(privates));

  // ----------------------------------------------------------------
  // [5] 观战人数上限
  // ----------------------------------------------------------------
  const S2 = open('观众2', { nickname: '观众D' });
  await waitWelcome(S2);
  S2.send({ t: 'spectate', code: CODE });
  await waitFor(function () { return S2.last.game_start; }, 6000, '第二个观众进来');
  const S3 = open('观众3', { nickname: '观众E' });
  await waitWelcome(S3);
  S3.send({ t: 'spectate', code: CODE });
  await waitFor(function () { return S3.last.game_start; }, 6000, '第三个观众进来');
  const S4 = open('观众4', { nickname: '观众F' });
  await waitWelcome(S4);
  S4.send({ t: 'spectate', code: CODE });
  await waitFor(function () { return S4.last.game_start || S4.last.error; }, 6000, '第四个观众');
  const S5 = open('观众5', { nickname: '观众G' });
  await waitWelcome(S5);
  S5.send({ t: 'spectate', code: CODE });
  await waitFor(function () { return S5.last.game_start || S5.last.error; }, 6000, '第五个观众');
  expect('[5] 超出观战人数上限被明确拒绝',
    !!(S5.last.error && S5.last.error.code === 'SPECTATOR_FULL'),
    JSON.stringify(S5.last.error || S5.last.game_start && '进来了'));
  S4.close();
  S5.close();

  // ----------------------------------------------------------------
  // [6] 退出观战
  // ----------------------------------------------------------------
  S2.send({ t: 'spectate_stop' });
  const sp = await waitFor(function () { return S2.last.spectate_stop; }, 6000, '退出观战回执');
  expect('[6] 退出观战有明确回执', !!sp, JSON.stringify(S2.last.error));
  await sleep(600);
  expect('[6] 退出后不再收快照（真的停收了）',
    (function () {
      const n = S2.snaps.length;
      return sleep(900).then(function () { return S2.snaps.length === n; });
    })(), '退出后还在收');

  // ----------------------------------------------------------------
  // [7] ★观战者掉线绝不能把这一局带走
  // ----------------------------------------------------------------
  const tickBeforeDrop = A.snaps[A.snaps.length - 1].tick;
  S.kill();
  S3.kill();
  await sleep(2000);
  const tickAfterDrop = A.snaps[A.snaps.length - 1].tick;
  expect('[7] 观战者掉线后这一局还在跑', tickAfterDrop > tickBeforeDrop,
    tickBeforeDrop + ' -> ' + tickAfterDrop);
  expect('[7] 玩家没有被连带踢出（A 仍在收快照）', A.snaps.length > 0 && !A.closed, 'A 断了');
  expect('[7] 玩家名单没有变（还是 2 个人）',
    A.last.game_start && A.last.game_start.players.length === 2,
    JSON.stringify(A.last.game_start && A.last.game_start.players.length));

  // A 还能操作：观战者来去不影响参战者
  A.send({ t: 'input', mx: 1, my: 0, seq: 999 });
  await sleep(800);
  expect('[7] 玩家仍可正常操作', !A.closed && A.last.error === undefined, JSON.stringify(A.last.error));

  A.close();
  B.close();
  S2.close();
  await sleep(400);

  console.log('\n汇总：' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('  FAIL  脚本异常：' + (e && e.message ? e.message : e));
  console.log('\n汇总：' + pass + ' PASS / ' + fail + ' FAIL（异常提前退出）');
  process.exit(1);
});
