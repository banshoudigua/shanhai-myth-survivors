// tools/seatkeeptest.js —— 候场室「掉线保座 + 重连回原位」回归（要起服务）
//
// 【为什么单开一个脚本】候场室这条链路的 bug 有一个共同特征：
// **界面上完全看不出异常**。房间不见了、人回来了变成另一个身份、
// 座位被换掉 —— 这些都不会抛异常，只会被玩家当成「这游戏有 bug」。
// 现有的 matchtest（纯逻辑）/ nettest（裸 WS，不碰房间）都不覆盖它。
//
// 现有实现的两个真问题（脚本就是为了钉住这两条）：
//   ① 候场室里最后一个人断线 → leaveRoom 里 `members.length === 0` 直接
//      `delete rooms[code]`，房间**当场销毁**。房主刷新一下页面，
//      原来发给队友的房间号就作废了。多人房只是把房主移交给别人。
//   ② 重连回不来。joinRoom 只认 connId，而重连后 connId 是新的
//      —— 就算房间侥幸还在，重新 join 也会被当成「另一个人」：
//      分到新座位、丢掉房主身份、准备状态被重置。
//
// 修法（服务端）：候场室也引入「人走光后房间留着」的对局侧同款宽限期，
// 断线只标记 connected=false；同一身份回来时接回原座位与房主身份。
//
// 用法：node tools/seatkeeptest.js [端口或完整地址]
const WebSocket = require('ws');

const ARG = String(process.argv[2] || '3000');
const BASE = /^https?:\/\//.test(ARG) ? ARG.replace(/\/$/, '') : ('http://127.0.0.1:' + ARG);
const WS_URL = BASE.replace(/^http/, 'ws') + '/ws';

// 候场室宽限期。刻意比默认 60s 短，让这个脚本两分钟内能跑完；
// 生产值由 config.roomKeepSec 控制（见 server/config.js）。
// 宽限期：与服务端 config.roomKeepSec 对齐。
// 【为什么要能配】本机验证实例用 ROOM_KEEP=12 跑（两分钟能跑完），
// 线上是默认 90s —— 写死 12 的话线上那条「超期回收」永远等不到。
const GRACE = Number(process.env.ROOM_KEEP || 12);

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name); }
  else { fail += 1; console.log('  FAIL  ' + name + '  ->  ' + (detail === undefined ? '断言不成立' : detail)); }
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

// 极简客户端：能等某类消息、能主动断线
function join(tag, hello) {
  const ws = new WebSocket(WS_URL);
  const c = {
    tag: tag, ws: ws, hello: hello,
    room: null, closed: false, closeCode: 0, errs: []
  };
  ws.on('open', function () { ws.send(JSON.stringify(Object.assign({ t: 'hello' }, hello))); });
  ws.on('message', function (raw, isBin) {
    if (isBin) return;                       // 二进制是对局快照，候场室里用不上
    let m = null;
    try { m = JSON.parse(String(raw)); } catch (e) { return; }
    if (m.t === 'welcome') {
      c.welcomed = true;      // 握手完成：此前发业务消息会被服务端静默丢弃
    } else if (m.t === 'room_update') {
      // room_update 是逐人构造的，每条里只有自己那份 self=true
      c.room = m.room;
    } else if (m.t === 'error') {
      c.errs.push(m);
    } else if (m.t === 'room_list') {
      c.list = m;                             // 存整条消息（.list 才是数组）
    }
  });
  ws.on('close', function (code) { c.closed = true; c.closeCode = code; });
  c.welcomed = false;
  c.send = function (o) { if (ws.readyState === 1) { ws.send(JSON.stringify(o)); return true; } return false; };
  c.kill = function () { c.closed = false; try { ws.terminate(); } catch (e) { /* 忽略 */ } };
  c.close = function () { try { ws.close(); } catch (e) { /* 忽略 */ } };
  return c;
}

// 【为什么等待窗口统一 20 秒】本机 8 秒够用，但机器负载一高（刚起服务、
// pglite 首次初始化、旁边还有别的东西在跑）就会偶发超时 —— 表现为「同一个脚本
// 上一轮 19/0、这一轮 18/1」。多等不会让测试变慢：正常路径都是毫秒级返回。
function waitFor(fn, ms, tag) {
  const t0 = Date.now();
  return (async function () {
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(120);
    }
    throw new Error('等待超时：' + tag);
  })();
}

// 等握手完成再发业务消息。
// 【为什么必须等】服务端在握手完成前会静默丢弃业务消息（不报错、不回复），
// 所以「发得太早」的表现是「服务端压根没收到」—— 本机 sleep(400) 够用，线上不够。
function waitWelcome(c, ms) {
  return waitFor(function () { return c.welcomed; }, ms || 12000, (c.tag || '?') + ' 握手完成');
}

function selfOf(c) {
  if (!c.room || !c.room.members) return null;
  for (let i = 0; i < c.room.members.length; i++) {
    if (c.room.members[i].self) return c.room.members[i];
  }
  return null;
}

(async function main() {
  // 【为什么昵称要唯一】服务端对游客用昵称作为「掉线席位认人」的依据（identityKey）。
  // 昵称重名时，上一次运行残留的掉线席位会被这一次的同名连接接回 ——
  // 表现是「房主进了别人那间房」，而两边都觉得自己是新房主。
  var TAG = Math.random().toString(36).slice(2, 6);
  function who(n) { return n + '-' + TAG; }
  console.log('=== 候场室掉线保座回归（' + BASE + '，宽限期 ' + GRACE + 's）===\n');

  // ----------------------------------------------------------------
  // [1] 单人房：房主断线后房间要留着，而且他回来还是房主、还是原座位
  // ----------------------------------------------------------------
  const host = join('房主', { nickname: who("房主甲") });
  await waitWelcome(host);
  host.send({ t: 'room_create', charId: 'hunter' });
  const r1 = await waitFor(function () { return selfOf(host); }, 20000, '房主进候场室');
  const CODE1 = host.room.code;
  const slot1 = r1.slot;
  console.log('  房主建房 ' + CODE1 + ' 座位=' + slot1 + ' 房主=' + !!r1.host);

  host.kill();
  await sleep(900);

  // 另一个人用房间号来查：这房还在不在（等价于「队友刷新列表能不能看到」）
  const probe = join('路人', { nickname: who("路人丙") });
  await waitWelcome(probe);
  probe.send({ t: 'room_list' });
  const lst = await waitFor(function () { return probe.list; }, 20000, '拉到房间列表');
  const found1 = lst.list.filter(function (x) { return x.code === CODE1; })[0];
  expect('[1] 房主断线后房间仍然存在（不是当场销毁）', !!found1,
    '列表里没有 ' + CODE1 + '，现有：' + JSON.stringify(lst.list.map(function (x) { return x.code; })));
  if (found1) {
    expect('[1] 掉线的人还占着名单（队友看得到「他掉了」）', found1.memberCount === 1,
      'memberCount=' + found1.memberCount);
  }
  probe.close();

  // 房主回来
  const back = join('房主(回来)', { nickname: who("房主甲") });
  await waitWelcome(back);
  back.send({ t: 'room_join', code: CODE1, charId: 'hunter' });
  const r2 = await waitFor(function () { return selfOf(back); }, 20000, '房主回原房');
  const slot2 = r2.slot;
  console.log('  房主回来 座位=' + slot2 + ' 房主=' + !!r2.host + ' resumed=' + !!r2.resumed);

  expect('[1] 断线重连能回到原来那间房', back.room && back.room.code === CODE1,
    '落到了 ' + (back.room && back.room.code) + ' 报错=' + JSON.stringify(back.errs));
  expect('[1] 座位号沿用原来的（不是新分配一个）', slot2 === slot1, '原 ' + slot1 + ' -> 现 ' + slot2);
  expect('[1] 房主身份还在（没被系统顶掉）', r2.host === true, 'host=' + r2.host);
  expect('[1] 回来后状态是「已连接」', r2.connected === true, 'connected=' + r2.connected);
  expect('[1] 明确告诉客户端「这是重连回来的」（界面要能提示）', r2.resumed === true,
    'resumed=' + r2.resumed);
  expect('[1] 重连没有被判成「房间已满」（自己那一份还占着位）', back.errs.length === 0,
    JSON.stringify(back.errs));

  // ----------------------------------------------------------------
  // [2] 宽限期到了才真的把这份席位丢掉
  // ----------------------------------------------------------------
  back.kill();
  // 【为什么多等 15 秒而不是 4 秒】回收是「宽限期到点」+「每 5 秒一次的清扫」两步，
  // 最坏情况要 GRACE + 5 秒才真的摘掉席位。原来只多等 4 秒 —— 卡在边界上，
  // 本机（GRACE=12）跑得快侥幸能过，线上（GRACE=90）就翻车了。
  await sleep(GRACE * 1000 + 15000);
  const probe2 = join('路人2', { nickname: who("路人丁") });
  await waitWelcome(probe2);
  probe2.send({ t: 'room_list' });
  const lst2 = await waitFor(function () { return probe2.list; }, 20000, '再拉一次房间列表');
  const found2 = lst2.list.filter(function (x) { return x.code === CODE1; })[0];
  expect('[2] 超过宽限期的空房间会被回收（已等 ' + (GRACE + 15) + ' 秒）', !found2,
    CODE1 + ' 还在列表里：' + JSON.stringify(found2));
  probe2.close();

  // ----------------------------------------------------------------
  // [3] 多人房：房主掉线，房间活着；房主回来还是房主
  // ----------------------------------------------------------------
  const H = join('房主乙', { nickname: who("房主乙") });
  await waitWelcome(H);
  H.send({ t: 'room_create', charId: 'hunter' });
  const h1 = await waitFor(function () { return selfOf(H); }, 20000, '乙建房');
  const CODE2 = H.room.code;

  const G = join('队友', { nickname: who("队友戊") });
  await waitWelcome(G);
  G.send({ t: 'room_join', code: CODE2, charId: 'mage' });
  await waitFor(function () { return selfOf(G); }, 20000, '戊进房');
  // 【为什么要等】断言要读的是「房主那边收到的最新一份 room_update」。
  // 直接读会拿到进房之前的那一帧 —— 人数当然还是 1，于是假失败。
  // 这是本脚本第一版就踩的坑：把「消息还没到」当成了「服务端没广播」。
  // 【注意 selfOf 返回的是「我自己那一份成员」，不是整个房间】
  // 要看人数得读 H.room.members —— 拿成员去读 .members 永远是 undefined，
  // 于是 waitFor 一直等到超时，看着像「服务端没广播」，其实是自己读错了层级。
  const sawTwo = await waitFor(function () {
    return H.room && H.room.members && H.room.members.length === 2 ? H.room : null;
  }, 20000, '房主看到 2 人').catch(function () { return null; });
  if (false) {
    console.log('   [诊断] 房主侧 room = ' + JSON.stringify(H.room));
    console.log('   [诊断] 房主侧 errs = ' + JSON.stringify(H.errs));
    console.log('   [诊断] 队友侧 room = ' + JSON.stringify(G.room));
  }
  expect('[3] 队友进来后房主能看到 2 人', !!sawTwo, '诊断见上');
  await sleep(400);

  H.kill();
  await sleep(1200);
  expect('[3] 房主掉线后队友那边名单变成 2 人且他标记为不在线',
    !!(G.room && G.room.members && G.room.members.length === 2 &&
       G.room.members.some(function (m) { return m.connected === false; })),
    JSON.stringify(G.room && G.room.members));

  // 房主回来
  const H2 = join('房主乙(回来)', { nickname: who("房主乙") });
  await waitWelcome(H2);
  H2.send({ t: 'room_join', code: CODE2, charId: 'hunter' });
  const h3 = await waitFor(function () { return selfOf(H2); }, 20000, '乙回原房');
  const h3room = H2.room;
  expect('[3] 房主回来后房间仍是 2 人（没把自己加成第 3 个）',
    h3room && h3room.members && h3room.members.length === 2,
    JSON.stringify(h3room && h3room.members && h3room.members.length));
  expect('[3] 房主回来仍然是房主', h3.host === true, 'host=' + h3.host);
  expect('[3] 房主回来后自己重新变成在线', h3.connected === true, 'connected=' + h3.connected);

  // 队友那一侧也要看到「他回来了」
  await waitFor(function () {
    return G.room && G.room.members && G.room.members.length === 2 &&
      G.room.members.every(function (m) { return m.connected === true; });
  }, 20000, '队友看到房主回来').catch(function () {});
  expect('[3] 队友那边也同步成「两人都在线」',
    !!(G.room && G.room.members && G.room.members.every(function (m) { return m.connected === true; })),
    JSON.stringify(G.room && G.room.members));

  // ----------------------------------------------------------------
  // [5] 房主在的时候别人掉线 → 房主身份不会乱跳
  // ----------------------------------------------------------------
  G.kill();
  await sleep(1200);
  await waitFor(function () {
    return H2.room && H2.room.members && H2.room.members.length === 2 &&
      H2.room.members.some(function (m) { return m.connected === false; });
  }, 20000, '房主看到队友掉线').catch(function () {});
  const stillHost = selfOf(H2);
  expect('[5] 队友掉线不影响房主（房主位不跳变）',
    !!(stillHost && stillHost.host === true), JSON.stringify(stillHost));
  const h2room = H2.room;
  expect('[5] 队友掉线后还占着名单（宽限期内不算退房）',
    !!(h2room && h2room.members && h2room.members.length === 2),
    JSON.stringify(h2room && h2room.members && h2room.members.length));
  const offInfo = h2room && h2room.members
    ? h2room.members.filter(function (m) { return m.connected === false; })[0] : null;
  expect('[5] 掉线成员带「N 秒后移出」（队友知道还要等多久）',
    !!(offInfo && offInfo.offlineLeftSec > 0),
    JSON.stringify(offInfo));

  // ----------------------------------------------------------------
  // [4] 同名不同人不能互相冒名顶替
  // ----------------------------------------------------------------
  const X = join('同名A', { nickname: who("撞名丙") });
  await waitWelcome(X);
  X.send({ t: 'room_create', charId: 'hunter' });
  const x1 = await waitFor(function () { return selfOf(X); }, 20000, 'X 建房');
  const CODE3 = X.room.code;
  const Y = join('同名B', { nickname: who("撞名丙") });
  await waitWelcome(Y);
  Y.send({ t: 'room_join', code: CODE3, charId: 'mage' });
  const y1 = await waitFor(function () { return selfOf(Y); }, 20000, 'Y 进房');
  expect('[4] 同名的第二个人能正常入座（不该被当成同一人踢掉或合并）',
    !!(y1 && x1.slot !== y1.slot), '甲=' + x1.slot + ' 乙=' + (y1 && y1.slot));

  X.close();
  Y.close();
  await sleep(600);
  H2.close();
  await sleep(400);

  console.log('\n汇总：' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail ? 1 : 0);
})().catch(function (e) {
  console.log('  FAIL  脚本异常：' + (e && e.message ? e.message : e));
  console.log('\n汇总：' + pass + ' PASS / ' + fail + ' FAIL（异常提前退出）');
  process.exit(1);
});
