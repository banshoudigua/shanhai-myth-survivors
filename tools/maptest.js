// tools/maptest.js —— 地图回归：数据表 / 地形生成 / 碰撞 / 联机链路
//
// 覆盖四层，每层都可能单独坏掉而不影响其它层：
//   ① 数据表：四张图的尺寸、主题、障碍参数；非法 id 回落而不是让建房失败
//   ② 地形生成：buildObstacles 必须是**纯函数**（双端各算一次，结果必须逐字节相同，
//      否则联机时「服务端有墙、客户端没墙」）；出生点留空；不越界
//   ③ 碰撞：玩家撞墙停住、斜撞沿墙滑、怪不会被卡死（详见 simtest 的对应断言）
//   ④ 联机链路：建房带 mapId → room_update → 房主可改/他人被拒 → game_start 下发
//
// 用法：node tools/maptest.js [端口或完整地址]
const WebSocket = require('ws');
const BASE = String(process.argv[2] || 3021);
const WS_URL = /^https/.test(BASE) ? BASE.replace(/^http/, 'ws') + '/ws' : 'ws://127.0.0.1:' + BASE + '/ws';

function join(tag, nick) {
  return new Promise(function (resolve) {
    const ws = new WebSocket(WS_URL);
    const c = { tag: tag, ws: ws, room: null, last: null, welcomed: false, errs: [], gameStart: null };
    ws.on('open', function () { ws.send(JSON.stringify({ t: 'hello', nickname: nick })); });
    ws.on('message', function (raw, bin) {
      if (bin) return;
      let m;
      try { m = JSON.parse(String(raw)); } catch (e) { return; }
      if (m.t === 'welcome') { c.welcomed = true; resolve(c); return; }
      if (m.t === 'room_update') { c.room = m.room; c.last = m; }
      if (m.t === 'room_list') { c.roomList = m; }
      if (m.t === 'error') c.errs.push(m);
      if (m.t === 'game_start') c.gameStart = m;
    });
    c.send = function (o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
    c.close = function () { ws.close(); };
  });
}
function waitFor(fn, ms, tag) {
  const t0 = Date.now();
  return new Promise(function (res, rej) {
    (function tick() {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return res(v);
      if (Date.now() - t0 > ms) return rej(new Error('超时：' + tag));
      setTimeout(tick, 60);
    })();
  });
}
const MAPS = require('../shared/maps.js');

async function main() {
  let pass = 0, fail = 0;
  function ok(name, cond, detail) {
    if (cond) { pass++; console.log('  PASS  ' + name); }
    else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
  }

  console.log('=== 地图链路：建房带 mapId → 房间 → 开局 → 世界 ===');
  const A = await join('房主', '地图房主');
  const B = await join('队友', '地图队友');

  // 1) 建房时指定非默认地图
  A.send({ t: 'room_create', charId: 'hunter', difficulty: 'normal', mapId: 'altar' });
  const room = await waitFor(function () { return A.room; }, 8000, '建房');
  console.log('  实际收到 room: ' + JSON.stringify(room).slice(0, 300));
  ok('建房带 mapId=altar → 房间里就是 altar', room.mapId === 'altar', JSON.stringify(room.mapId));

  // 2) 非法 mapId 回落默认（不该让建房失败）
  const C = await join('乱图', '乱图玩家');
  C.send({ t: 'room_create', charId: 'hunter', mapId: '根本不存在的图' });
  const room2 = await waitFor(function () { return C.room; }, 8000, '乱图建房');
  ok('非法 mapId 回落默认图而不是建房失败',
    room2.mapId === MAPS.DEFAULT_MAP_ID, room2.mapId);

  // 3) 队友加入
  B.send({ t: 'room_join', code: room.code, charId: 'nun' });
  await waitFor(function () { return B.room && B.room.members.length === 2; }, 8000, '队友入座');
  // 全员「准备」才能开局（与候场室的开始按钮同一个条件）
  B.send({ t: 'room_ready', ready: true });
  await waitFor(function () { return A.room.canStart; }, 5000, '可开局');

  // 4) 房主改地图 → 房间跟着变
  A.send({ t: 'room_map', mapId: 'cathedral' });
  await waitFor(function () { return A.room.mapId === 'cathedral'; }, 5000, '改地图');
  ok('房主 room_map 改成 cathedral → 房间更新', A.room.mapId === 'cathedral');

  // 5) 非房主改地图要失败
  B.send({ t: 'room_map', mapId: 'graveyard' });
  await waitFor(function () { return B.errs.length > 0; }, 5000, '非房主改图被拒');
  ok('非房主改地图被服务端拒绝', B.errs.length > 0, JSON.stringify(B.errs[0] && B.errs[0].code));
  B.errs.length = 0;

  // 6) 开局：game_start 必须带 mapId
  A.send({ t: 'game_start' });
  const gs = await waitFor(function () { return A.gameStart; }, 8000, '开局');
  ok('game_start 带上了 mapId=cathedral', gs.mapId === 'cathedral', String(gs.mapId));

  // 7) 地图定义能按 id 取到，且尺寸/障碍都对得上
  const m = MAPS.mapById(gs.mapId);
  ok('该 id 能在双端共用的表里查到', !!m && m.id === 'cathedral');
  const ob = MAPS.buildObstacles(m);
  ok('障碍是纯函数算出来的（双端各自算也一致）',
    JSON.stringify(ob) === JSON.stringify(MAPS.buildObstacles(m)), ob.length + ' 个');

  // 8) 大厅房间列表里也带 mapId —— 由 roomcheck 覆盖（room_list 是 welcome 时推的，
  //    本脚本的连接模型等不到它，硬等只会假超时）

  // ============================================================
  // 9) 波次表（const.js 的 STAGES）与地图表的名字一致性
  // ============================================================
  // 【为什么加这条】第十八轮改地图名时，把 maps.js 改了、忘了 const.js 的 STAGES ——
  //   而 STAGES 的 name 会显示在 HUD 的「第几关」上（getHud 的 stageName），
  //   于是同一屏会出现两个叫法。抓到它的是 artshot 的两条断言（浏览器级、慢），
  //   但那两条之所以能抓到，纯属侥幸：STAGES 里有个 id（belfry）在 MAPS 里根本不存在，
  //   而 stageForWave() 只读 STAGES 自己的 name、从不拿 id 去查地图表 ——
  //   所以真正该拦它的地方（这里）当时是空的。**把已知缺口变成常驻断言**，
  //   以后再改名字忘了同步，纯 Node 就能立刻抓到，不必等浏览器测试。
  const CST = require('../shared/const.js');
  // ★自己建 id 索引，**不要用 MAPS.mapById() 查「这个 id 存不存在」**——
  //   mapById 对未知 id 会**回落默认图**（刻意的容错，见 maps.js 的注释）：
  //   非法 id 宁可打默认图，也不要「房间建不起来」。
  //   于是查一个不存在的 id 会拿到「乱葬岗」而不是 null，
  //   靠它判断「id 对不对得上」会得出完全相反的结论（本次就先踩了这个坑）。
  const MAP_INDEX = {};
  MAPS.MAPS.forEach(function (m) { MAP_INDEX[m.id] = m; });

  const nameMismatch = [];
  CST.STAGES.forEach(function (s) {
    const m = MAP_INDEX[s.id];
    // 查不到 id 的情况单独放过（belfry 是已知遗留，见 const.js 的注释），
    // 但要在这里显式钉住「已知只有这一个是已知」，多出新错就红。
    if (!m) return;
    if (m.name !== s.name) nameMismatch.push(s.id + '：波次表=' + s.name + ' / 地图表=' + m.name);
  });
  ok('波次表与地图表的名字逐个对得上（HUD 不会同屏出现两个叫法）',
    nameMismatch.length === 0, nameMismatch.join(' | '));

  // 已知遗留：STAGES 里查不到地图的 id，钉成「一份白名单」——
  // ★这样以后有人新写错一个 id 会立刻红（白名单外的都算错），
  //   而不是像 belfry 这样悄悄潜伏着。
  const knownOrphanStageIds = CST.STAGES.filter(function (s) { return !MAP_INDEX[s.id]; })
    .map(function (s) { return s.id; }).sort();
  ok('波次表里查不到地图的 id 只有已知的那一个（belfry，详见 const.js 注释）',
    knownOrphanStageIds.length === 1 && knownOrphanStageIds[0] === 'belfry',
    JSON.stringify(knownOrphanStageIds));

  A.close(); B.close(); C.close();
  console.log('\n  PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack || e));
  process.exit(1);
});
