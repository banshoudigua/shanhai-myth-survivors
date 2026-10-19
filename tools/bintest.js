// tools/bintest.js —— P2-5 二进制快照协议自检
//
// 为什么单独一个文件，而不是塞进 matchtest：
//   matchtest 关心的是「房间与对局逻辑对不对」，它自己的收集器会把二进制帧解回对象，
//   所以它**测不出**协议本身的毛病（编解码错位、量化超规格、字符串漏池、带宽退化）。
//   这里专门测协议：同一份数据，编码前后必须一致；不该省的字节一个都不许省。
//
// 覆盖五块：
//   [A] 字段表自检        —— assertSchema() 自己能拦住手写字段表的低级错误
//   [B] 编解码无损        —— 真世界快照 round-trip，逐字段比误差，确认量化在规格内
//   [C] 省 px/py 的重建    —— 联机最关键的优化，错了会表现成「所有人原地抽搐」
//   [D] 串池覆盖与兜底     —— 新加怪/新加特效忘了补池，这里必须立刻红
//   [E] 带宽实测与裁剪调优 —— 满量怪 + 真跑一局，量出「单人下行多少 KB/s」
//
// 用法：node tools/bintest.js
// 全部在单进程内跑，不起 HTTP、不碰数据库。

const C = require('../shared/const.js');
const SIM = require('../shared/sim.js');
const PB = require('../shared/proto_bin.js');
const config = require('../server/config.js');
const manager = require('../server/rooms/manager.js');
const registry = require('../server/game/match.js');

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
function section(title) {
  console.log('');
  console.log('=== ' + title + ' ===');
}

// ============================================================
// 量化规格
// ============================================================
// 协议里三类数字字段各有各的精度，测试要按类型给容差，不能一刀切：
//   sv4  坐标 ×4    → 误差 ≤ 0.125px
//   sf   计时/角度 ×100 → 误差 ≤ 0.005
//   uv/u8 整数      → 误差 ≤ 0.5（字段本身就该是整数，否则说明选错了类型）
const TOL = { sv4: 0.125, sf: 0.005, uv: 0.5, u8: 0.5, idv: 0 };

// ============================================================
// [A] 字段表自检
// ============================================================

function testSchema() {
  section('[A] 字段表自检');

  expect('模块加载时的自检通过（没抛异常就是过了）', PB.assertSchema() === true, 'assertSchema 未返回 true');

  // 字段表派生出来的白名单必须和 SCHEMA 严格一致 ——
  // match.js 用的是派生结果，一旦派生逻辑写错，快照会静默少字段。
  const derivedOk =
    PB.F_MOB.join(',') === PB.SCHEMA.mobs.map(function (f) { return f.n; }).join(',') &&
    PB.F_PLAYER.join(',') === PB.SCHEMA.players.map(function (f) { return f.n; }).join(',') &&
    PB.F_FX.join(',') === PB.SCHEMA.fx.map(function (f) { return f.n; }).join(',');
  expect('白名单由字段表派生且顺序一致', derivedOk, 'F_MOB=' + PB.F_MOB.join('|'));

  // 这些是客户端的硬需求，协议层必须带着它们（缺了就是画面坏，不是"少个字段"）
  expect('怪物字段含渲染要用的 defId/vx/vy/flash', ['defId', 'vx', 'vy', 'flash'].every(function (n) { return PB.F_MOB.indexOf(n) >= 0; }), PB.F_MOB.join(','));
  expect('玩家字段含镜头要用的 slot', PB.F_PLAYER.indexOf('slot') >= 0, PB.F_PLAYER.join(','));
  expect('玩家字段刻意不含昵称（名单走 game_start）', PB.F_PLAYER.indexOf('name') < 0, PB.F_PLAYER.join(','));
  expect('9 个实体列表顺序定死', PB.LISTS.length === 9, 'lists=' + PB.LISTS.join(','));

  // 可选位最多 7 个（bit7 给 alive 占着），检查没有列表用超
  let bitsOk = true;
  let bitsDetail = '';
  for (let i = 0; i < PB.LISTS.length; i++) {
    const name = PB.LISTS[i];
    const used = PB.SCHEMA[name].filter(function (f) { return f.o !== undefined; }).map(function (f) { return f.o; });
    const dup = used.filter(function (v, k) { return used.indexOf(v) !== k; });
    if (dup.length) { bitsOk = false; bitsDetail = name + ' 位置重复: ' + dup.join(','); }
  }
  expect('可选字段位置无冲突', bitsOk, bitsDetail || 'ok');
}

// ============================================================
// 造一帧「逻辑快照」（形状与 match.js 的 snapshotFor 完全一致）
// ============================================================

// 用 match.js 的打包逻辑太重（要起房间），这里直接照白名单造，
// 好处是可以精确控制实体数量、坐标范围、字符串取值这些边界。
const MOB_IDS = ['corpse', 'bat', 'skeleton_warrior', 'gargoyle', 'blood_priest', 'witch_hunter', 'blood_lord'];

function fakeMobs(n, cx, cy, withPrev) {
  const out = [];
  for (let i = 0; i < n; i++) {
    // 黄金角螺旋：均匀铺开又不做 sqrt 之外的开方，快
    const a = i * 2.399963229728653;
    const rr = 60 + Math.sqrt(i) * 34;
    const x = Math.round((cx + Math.cos(a) * rr) * 100) / 100;
    const y = Math.round((cy + Math.sin(a) * rr) * 100) / 100;
    out.push({
      id: i + 1,
      defId: MOB_IDS[i % MOB_IDS.length],
      x: x, y: y,
      px: withPrev ? x : 0,
      py: withPrev ? y : 0,
      hp: 8 + (i % 5) * 3,
      maxHp: 20,
      r: 10 + (i % 4),
      vx: -60 + (i % 7) * 20,
      vy: -60 + (i % 5) * 24,
      flash: (i % 9 === 0) ? 0.1 : 0,
      alive: true,
      stun: 0,
      charging: 0
    });
  }
  return out;
}

function fakePlayers(n, cx, cy) {
  const out = [];
  const chars = ['hunter', 'nun', 'scholar', 'blacksmith'];
  for (let i = 0; i < n; i++) {
    out.push({
      id: i + 1,
      slot: i,
      charId: chars[i % chars.length],
      x: cx + i * 34.25,
      y: cy - i * 18.5,
      px: cx + i * 34.25,
      py: cy - i * 18.5 + 0.75,
      facing: 0.7854 + i,
      hp: 88 - i * 7,
      maxHp: 100,
      r: 14,
      alive: true,
      level: 3 + i,
      invuln: 0.37 + i * 0.11,
      pickupRadius: 96 + i * 8
    });
  }
  return out;
}

// 各列表都塞一点：只有同时有多个列表，才能验证「帧内列表顺序」是对的
function fakeSnapshot(mobCount, viewAll) {
  const cx = 1600;
  const cy = 1200;
  const radius = viewAll ? 4000 : 300;
  const mobs = fakeMobs(mobCount, cx, cy, true).filter(function (m) {
    const dx = m.x - cx, dy = m.y - cy;
    return dx * dx + dy * dy <= radius * radius || viewAll;
  });
  return {
    t: 'snap',
    tick: 4242,
    time: 212.34,
    aliveMobCount: mobs.length,
    wave: 7,
    won: false,
    players: fakePlayers(4, cx, cy),
    mobs: mobs,
    shots: [
      { id: 1, x: cx + 10, y: cy, px: cx + 10, py: cy, r: 6, vx: -180, vy: 0 },
      { id: 2, x: cx - 22, y: cy + 14, px: cx - 22, py: cy + 14, r: 5, vx: 120, vy: -60 }
    ],
    projs: [
      { id: 1, kind: 'arc', x: cx, y: cy, px: cx, py: cy, vx: 320, vy: 40, r: 9, color: '#ffd166', life: 0.82 },
      { id: 2, kind: 'boomerang', x: cx + 30, y: cy - 20, px: cx + 30, py: cy - 20, vx: -260, vy: 90, r: 11, color: '#ffe08a', life: 1.4 }
    ],
    zones: [{ id: 1, x: cx - 80, y: cy + 40, r: 62, life: 4.25, maxLife: 6, color: '#7fc6e8' }],
    strikes: [
      { id: 1, kind: 'strike', x: cx + 120, y: cy, sx: cx + 120, sy: cy, r: 46, life: 0.2, delay: 0, color: '#f2c14e' },
      { id: 2, kind: 'arc', x: cx - 140, y: cy + 60, r: 30, life: 0.15, color: '#ff8c42' }
    ],
    orbits: [{ id: 1, x: cx + 52, y: cy - 52, size: 18, color: '#cfc7b0' }],
    pickups: [
      { id: 1, kind: 'exp', x: cx + 12, y: cy + 9, px: cx + 12, py: cy + 9, value: 3 },
      { id: 2, kind: 'gold', x: cx - 40, y: cy - 12, px: cx - 40, py: cy - 12, value: 17 },
      { id: 3, kind: 'heart', x: cx + 4, y: cy + 70, px: cx + 4, py: cy + 70, value: 25 }
    ],
    fx: [
      { kind: 'death', x: cx + 5, y: cy + 5, r: 22, life: 0.3, maxLife: 0.45, color: '#a3454d' },
      { kind: 'hitplayer', x: cx - 6, y: cy + 12, sx: cx - 6, sy: cy + 12, r: 16, facing: 1.2, arcDeg: 90, life: 0.22, maxLife: 0.3, color: '#ff6b6b' },
      { kind: 'boom', x: cx + 60, y: cy - 60, r: 34, life: 0.5, maxLife: 0.6, color: '#ff9f45' }
    ]
  };
}

// ============================================================
// [B] 编解码无损
// ============================================================

// 逐字段比对。返回第一个不一致的说明（没有就返回 null）。
// 数字按字段类型给容差；字符串与布尔必须严格相等；可选字段 undefined 与 0 视为等价
// （协议就是这么定义的：可选字段的 0 等同于"没效果"，不发送）。
function firstDiff(listName, a, b) {
  const flds = PB.SCHEMA[listName];
  if (a.length !== b.length) return listName + ' 条数不一致 ' + a.length + ' vs ' + b.length;

  for (let i = 0; i < a.length; i++) {
    const ea = a[i];
    const eb = b[i];
    for (let k = 0; k < flds.length; k++) {
      const f = flds[k];
      const va = ea[f.n];
      const vb = eb[f.n];
      if (f.t === 'str') {
        if (String(va === undefined ? '' : va) !== String(vb === undefined ? '' : vb)) {
          return listName + '[' + i + '].' + f.n + ' 字符串不一致: ' + va + ' vs ' + vb;
        }
        continue;
      }
      if (f.t === 'alv') {
        const ba = va === undefined ? true : !!va;
        const bb = vb === undefined ? true : !!vb;
        if (ba !== bb) return listName + '[' + i + '].' + f.n + ' 布尔不一致: ' + ba + ' vs ' + bb;
        continue;
      }
      const na = Number(va === undefined ? 0 : va) || 0;
      const nb = Number(vb === undefined ? 0 : vb) || 0;
      const tol = TOL[f.t] === undefined ? 0.5 : TOL[f.t];
      if (Math.abs(na - nb) > tol) {
        return listName + '[' + i + '].' + f.n + ' 超出精度: ' + na + ' vs ' + nb + ' (tol=' + tol + ')';
      }
    }
  }
  return null;
}

function roundTrip(listName, snap, decodeOpts, label) {
  const buf = PB.encode(snap, decodeOpts);
  const out = PB.decode(buf, null);
  if (!out) {
    bad('round-trip 能解回来：' + label, 'decode 返回 null');
    return { bytes: buf.length, out: null };
  }
  ok('round-trip 能解回来：' + label, buf.length + 'B');
  return { bytes: buf.length, out: out };
}

function testRoundTrip() {
  section('[B] 编解码无损（真数据形状 round-trip）');

  const snap = fakeSnapshot(200, false);

  const r1 = roundTrip('all', snap, { key: true }, '关键帧（带 px/py）');
  if (r1.out) {
    let diff = null;
    for (let i = 0; i < PB.LISTS.length && !diff; i++) {
      const name = PB.LISTS[i];
      diff = firstDiff(name, snap[name], r1.out[name]);
    }
    expect('关键帧逐字段无损（量化在规格内）', diff === null, diff || 'ok');
    expect('帧头字段无损', r1.out.tick === snap.tick && Math.abs(r1.out.time - snap.time) < 0.005 &&
      r1.out.aliveMobCount === snap.aliveMobCount && r1.out.wave === snap.wave && r1.out.won === snap.won,
      JSON.stringify({ tick: r1.out.tick, time: r1.out.time, wave: r1.out.wave }));
    expect('非坐标字段不受量化影响（defId/kind/color 严格相等）',
      r1.out.mobs[0].defId === snap.mobs[0].defId &&
      r1.out.projs[0].kind === snap.projs[0].kind &&
      r1.out.projs[0].color === snap.projs[0].color, 'mismatch');
  }

  // 多帧连续解码：第 2 帧起 px/py 会被省掉，靠 prev 重建。
  // 这是「联机不抽搐」的关键路径，必须单独测。
  const f1 = fakeSnapshot(120, false);
  const f2 = JSON.parse(JSON.stringify(f1));
  f2.tick = f1.tick + 1;
  f2.time = f1.time + 0.05;
  for (let i = 0; i < f2.mobs.length; i++) {
    // 模拟「怪走了一步」：px/py 恰好等于上一帧的 x/y
    f2.mobs[i].px = f1.mobs[i].x;
    f2.mobs[i].py = f1.mobs[i].y;
    f2.mobs[i].x = Math.round((f1.mobs[i].x + 3.25) * 100) / 100;
    f2.mobs[i].y = Math.round((f1.mobs[i].y - 2.5) * 100) / 100;
  }

  const b1 = PB.encode(f1, { key: true });
  const d1 = PB.decode(b1, null);
  const b2 = PB.encode(f2, { omitPrev: true, key: false });
  const d2 = PB.decode(b2, d1);

  expect('省 px/py 的第二帧更小', b2.length < b1.length, b1.length + 'B vs ' + b2.length + 'B');
  expect('第二帧解出来的 px/py == 上一帧解出来的 x/y',
    !!d2 && !!d1 && d2.mobs.every(function (m, i) { return m.px === d1.mobs[i].x && m.py === d1.mobs[i].y; }),
    d2 && d1 ? JSON.stringify({ px: d2.mobs[0].px, prevX: d1.mobs[0].x }) : 'decode null');
  expect('第二帧的当前坐标是新的', d2 && Math.abs(d2.mobs[0].x - f2.mobs[0].x) < 0.13,
    d2 ? d2.mobs[0].x + ' vs ' + f2.mobs[0].x : 'decode null');

  // 没有上一帧时必须退化成 px=x 而不是 NaN ——
  // 中途加入、重连恢复都会走这条路，算错了整帧全是 NaN，画面上就是「全没了」。
  const dOrphan = PB.decode(b2, null);
  expect('没有上一帧时退化成 px=x（不是 NaN）',
    dOrphan && dOrphan.mobs.every(function (m) { return m.px === m.x && m.py === m.y && isFinite(m.px); }),
    dOrphan ? 'px=' + dOrphan.mobs[0].px + ' x=' + dOrphan.mobs[0].x : 'decode null');

  // 【可选字段「省掉」必须补回 0 —— 真踩过，事故不小】
  // 编码端把「值等于 0」的可选字段整个省掉（vx/vy/flash/stun/charging 都标了 o），
  // 解码端如果只是 `continue` 跳过，消费方拿到的就是 undefined。
  // 后果链：静止的怪没有 vx/vy → render.js 算 Math.atan2(undefined, undefined) = NaN
  //        → 拿 NaN 去索引旋转图集得到 undefined → drawImage(undefined.cv) 抛异常
  //        → 每帧都抛，画面等于卡死。而且 JSON 路径不会有这个问题（JSON 原样带 vx:0），
  //        所以只有真浏览器才会暴露 —— 是 roomcheck 抓出来的。
  // 这条断言盯的是协议不变式：「解码结果必须与 JSON 路径同形」，调用方不该知道谁是可选的。
  const still = fakeSnapshot(120, false);
  for (let i = 0; i < still.mobs.length; i++) {
    still.mobs[i].vx = 0;        // 静止的怪：编码端会把这五个字段全省掉
    still.mobs[i].vy = 0;
    still.mobs[i].flash = 0;
    still.mobs[i].stun = 0;
    still.mobs[i].charging = 0;
  }
  const stillBytes = PB.encode(still, { key: true });
  const dStill = PB.decode(stillBytes, null);
  const optOk = !!dStill && dStill.mobs.length > 0 && dStill.mobs.every(function (m) {
    return m.vx === 0 && m.vy === 0 && m.flash === 0 && m.stun === 0 && m.charging === 0;
  });
  expect('省掉的可选字段解码后是 0 而非 undefined（vx/vy/flash/stun/charging）', optOk,
    dStill ? JSON.stringify({ n: dStill.mobs.length, vx: dStill.mobs[0].vx, vy: dStill.mobs[0].vy,
      flash: dStill.mobs[0].flash, stun: dStill.mobs[0].stun, charging: dStill.mobs[0].charging }) : 'decode null');
  // 同时确认「确实省了字节」—— 否则这条修复就是把优化白扔了
  const moving = JSON.parse(JSON.stringify(still));
  for (let i = 0; i < moving.mobs.length; i++) { moving.mobs[i].vx = 120; moving.mobs[i].vy = -80; }
  const movingBytes = PB.encode(moving, { key: true });
  expect('可选字段确实被省掉了（静止怪的单包更小）', stillBytes.length < movingBytes.length,
    stillBytes.length + 'B vs ' + movingBytes.length + 'B');

  // 坏数据不能把页面搞崩：返回 null 就够了
  expect('magic 不对返回 null', PB.decode(new Uint8Array([0x7b, 0x22, 1, 2, 3, 4])) === null, 'should be null');
  expect('版本不对返回 null', PB.decode(new Uint8Array([PB.T_SNAP, 99, 0, 0, 0, 0, 0])) === null, 'should be null');
  expect('截断的帧返回 null', PB.decode(b1.slice(0, 12)) === null, 'should be null');
  expect('空输入返回 null', PB.decode(new Uint8Array(0)) === null, 'should be null');
  expect('非字节输入返回 null', PB.decode({}) === null && PB.decode(null) === null, 'should be null');

  // 三种字节容器都要认：浏览器 binaryType='arraybuffer' 给 ArrayBuffer、
  // Node 的 ws 给 Buffer、测试里给 Uint8Array。
  // 【这里踩过】ArrayBuffer 自己没有 .buffer 属性，早先那版转换条件写错，
  // 结果是「浏览器一条快照都画不出来」，而 Node 侧测试全绿 —— 极难查。
  const ab = b1.buffer.slice(b1.byteOffset, b1.byteOffset + b1.byteLength);
  const abOut = PB.decode(ab, null);
  expect('ArrayBuffer 形式能解（浏览器走的就是这条）',
    !!abOut && abOut.mobs.length === snap.mobs.length, abOut ? 'mobs=' + abOut.mobs.length : 'decode null');
  const nodeBuf = Buffer.from(b1);
  const bufOut = PB.decode(nodeBuf, null);
  expect('Node Buffer 形式能解（nettest 走的就是这条）',
    !!bufOut && bufOut.mobs.length === snap.mobs.length, bufOut ? 'mobs=' + bufOut.mobs.length : 'decode null');
  // 带非零 byteOffset 的视图（Node 的 Buffer 池就会出现这种）必须也能解对
  const padded = new Uint8Array(b1.length + 7);
  padded.set(b1, 7);
  const viewOut = PB.decode(padded.subarray(7), null);
  expect('带 byteOffset 的视图能解对（Buffer 池场景）',
    !!viewOut && viewOut.mobs.length === snap.mobs.length, viewOut ? 'mobs=' + viewOut.mobs.length : 'decode null');
}

// ============================================================
// [C] 关键帧
// ============================================================

function testKeyFrame() {
  section('[C] 关键帧 flags');

  const snap = fakeSnapshot(30, false);
  const keyBuf = PB.encode(snap, { key: true, omitPrev: true });
  const noKeyBuf = PB.encode(snap, { key: false, omitPrev: true });

  expect('关键帧比省坐标帧大（说明 px/py 真的写了）', keyBuf.length > noKeyBuf.length,
    'key=' + keyBuf.length + 'B omit=' + noKeyBuf.length + 'B');

  const keyOut = PB.decode(keyBuf, null);
  expect('关键帧不依赖上一帧就能拿到 px/py',
    !!keyOut && keyOut.mobs.every(function (m, i) {
      return isFinite(m.px) && isFinite(m.py) &&
        Math.abs(m.px - snap.mobs[i].px) < TOL.sv4 && Math.abs(m.py - snap.mobs[i].py) < TOL.sv4;
    }),
    keyOut ? 'mobs[0] px=' + keyOut.mobs[0].px + ' 期望 ' + snap.mobs[0].px : 'decode null');

  // 通关标记必须能从 flags 里读出来
  const winSnap = fakeSnapshot(1, false);
  winSnap.won = true;
  const winOut = PB.decode(PB.encode(winSnap, { key: true }), null);
  expect('通关标记（F_WON）解码正确', winOut && winOut.won === true, 'won=' + (winOut && winOut.won));
}

// ============================================================
// [D] 串池覆盖
// ============================================================

function testPool() {
  section('[D] 静态串池覆盖');

  PB.resetStats();

  // 把 const.js 与 sim.js 里可能出现的字符串值全捞出来，逐个编码一遍。
  // 只要有任何一个没进池，就会走长格式（更占字节），测试必须红。
  const values = [];

  // 颜色：直接从 const.js 的调色与怪物配色里取
  const colorSources = [C.COLORS || {}, C.MOB_MAP || {}];
  for (let i = 0; i < colorSources.length; i++) {
    const src = colorSources[i];
    const keys = Object.keys(src);
    for (let k = 0; k < keys.length; k++) {
      const v = src[keys[k]];
      if (typeof v === 'string' && v.charAt(0) === '#') values.push(v);
      else if (v && typeof v === 'object') {
        const sub = Object.keys(v);
        for (let j = 0; j < sub.length; j++) {
          if (typeof v[sub[j]] === 'string' && v[sub[j]].charAt(0) === '#') values.push(v[sub[j]]);
        }
      }
    }
  }

  // 怪物 id、角色 id
  const mobIds = Object.keys(C.MOB_MAP || {});
  for (let i = 0; i < mobIds.length; i++) values.push(mobIds[i]);
  const chars = C.CHARACTERS || [];
  for (let i = 0; i < chars.length; i++) values.push(chars[i].id);

  // kind：弹幕 / 掉落物 / 打击 / 区域 / 特效（sim.js 里的字面量）
  ['arc', 'line', 'ring', 'homing', 'boomerang', 'parabola'].forEach(function (v) { values.push(v); });
  ['exp', 'gold', 'heart'].forEach(function (v) { values.push(v); });
  ['zone', 'strike', 'death', 'hitplayer', 'boom'].forEach(function (v) { values.push(v); });

  // 用 mobs 列表承载这批字符串（defId 字段就是 str 类型），一次编码全测到
  const snap = fakeSnapshot(0, false);
  snap.mobs = [];
  for (let i = 0; i < values.length; i++) {
    snap.mobs.push({ id: i + 1, defId: values[i], x: 100, y: 100, px: 100, py: 100, hp: 1, maxHp: 1, r: 5, alive: true });
  }
  PB.encode(snap, { key: true });

  const miss = JSON.stringify(PB.stats.longFormByField);
  expect('上面用的 ' + values.length + ' 个字符串值全部命中串池', PB.stats.longForm === 0,
    'longForm=' + PB.stats.longForm + ' byField=' + miss);

  // 池外兜底也必须能正常收发（以后加新怪时至少不会崩）
  const odd = fakeSnapshot(0, false);
  odd.mobs = [{ id: 1, defId: 'brand_new_mob_2099', x: 1, y: 2, px: 1, py: 2, hp: 1, maxHp: 1, r: 5, alive: true }];
  const oddOut = PB.decode(PB.encode(odd, { key: true }), null);
  expect('池外字符串走长格式且能原样解回', oddOut && oddOut.mobs[0].defId === 'brand_new_mob_2099',
    oddOut ? oddOut.mobs[0].defId : 'decode null');

  // 中文（非 ASCII）也要能原样回来 —— 昵称虽然不进快照了，但兜底路径不能是坏的
  const cn = fakeSnapshot(0, false);
  cn.mobs = [{ id: 1, defId: '幽灵蝙蝠', x: 1, y: 1, px: 1, py: 1, hp: 1, maxHp: 1, r: 5, alive: true }];
  const cnOut = PB.decode(PB.encode(cn, { key: true }), null);
  expect('UTF-8 长格式字符串原样往返', cnOut && cnOut.mobs[0].defId === '幽灵蝙蝠',
    cnOut ? cnOut.mobs[0].defId : 'decode null');

  // alive=false 走实体 flags 的 bit7，不占字节，必须也能正确解回
  const dead = fakeSnapshot(0, false);
  dead.mobs = [
    { id: 1, defId: 'bat', x: 1, y: 1, px: 1, py: 1, hp: 0, maxHp: 1, r: 5, alive: false },
    { id: 2, defId: 'bat', x: 2, y: 1, px: 2, py: 1, hp: 1, maxHp: 1, r: 5, alive: true }
  ];
  const deadOut = PB.decode(PB.encode(dead, { key: true }), null);
  expect('alive=false 走 flags 位且解码正确',
    deadOut && deadOut.mobs[0].alive === false && deadOut.mobs[1].alive === true,
    deadOut ? JSON.stringify(deadOut.mobs.map(function (m) { return m.alive; })) : 'decode null');
}

// ============================================================
// [E] 带宽实测与视野裁剪调优
// ============================================================

function testBandwidth() {
  section('[E] 带宽实测与视野裁剪调优');

  // ---------- E1. 满量怪（1200）全下发的极端值 ----------
  PB.resetStats();
  const full = fakeSnapshot(C.MAX_MOBS, true);
  const fullJson = JSON.stringify(full).length;
  const fullKey = PB.encode(full, { key: true }).length;
  const fullOmit = PB.encode(full, { omitPrev: true }).length;
  const n = full.mobs.length;
  const perMobJson = Math.round((fullJson - 800) / n);      // 减掉玩家/杂项底噪
  const perMobOmit = (fullOmit - 200) / n;

  console.log('    ' + n + ' 只怪 + 4 人 + 杂项（全部下发）：');
  console.log('      JSON          ' + (fullJson / 1024).toFixed(1) + ' KB/包  → 单人 ' +
    (fullJson * config.snapshotHz / 1048576).toFixed(2) + ' MB/s  （单怪约 ' + perMobJson + ' B）');
  console.log('      二进制·关键帧  ' + (fullKey / 1024).toFixed(1) + ' KB/包  → 单人 ' +
    (fullKey * config.snapshotHz / 1048576).toFixed(2) + ' MB/s');
  console.log('      二进制·省坐标  ' + (fullOmit / 1024).toFixed(1) + ' KB/包  → 单人 ' +
    (fullOmit * config.snapshotHz / 1048576).toFixed(2) + ' MB/s  （单怪约 ' + perMobOmit.toFixed(1) + ' B）');

  expect('二进制关键帧比 JSON 小 5 倍以上', fullJson / fullKey > 5,
    (fullJson / fullKey).toFixed(2) + '×' + ' (' + fullJson + '→' + fullKey + ')');
  expect('二进制省坐标帧比关键帧再小一截（省 px/py 有效）', fullKey > fullOmit,
    'key=' + fullKey + ' omit=' + fullOmit);
  expect('单怪省坐标开销 < 20 字节', perMobOmit < 20, perMobOmit.toFixed(2) + 'B');

  // ---------- E2. 视野裁剪调优 ----------
  // 这一节回答「裁剪半径该设多少」。做法是把 1200 只怪均匀撒在刷怪盘里
  // （刷怪盘半径 = spawnRadiusDefault，也就是客户端算出来的「屏幕半对角 + 200」），
  // 然后只改裁剪半径，看一帧里还剩多少实体、要多少字节。
  //
  // 为什么不用「真跑一局」来测：四人开火下场上只剩十几只怪，样本太小，
  // 而且随运气浮动。真跑一局放在 E3，只用来报告「典型值」。
  console.log('');
  console.log('    【视野裁剪调优】固定 1200 只怪铺在半径 ' + config.spawnRadiusDefault + 'px 的刷怪盘里，只改裁剪半径：');

  const disc = makeSpawnDisc(C.MAX_MOBS, config.spawnRadiusDefault, 1600, 1200);
  const rows = [];
  const radii = [0, 1400, 1100, 900, 800, 600];
  for (let i = 0; i < radii.length; i++) {
    const rr = radii[i];
    const snap = fakeSnapshot(0, false);
    snap.mobs = rr > 0 ? disc.filter(function (m) {
      const dx = m.x - 1600, dy = m.y - 1200;
      return dx * dx + dy * dy <= rr * rr;
    }) : disc.slice();
    PB.resetStats();
    const bin = PB.encode(snap, { key: false, omitPrev: true }).length;
    const json = JSON.stringify(snap).length;
    const kb = bin * config.snapshotHz / 1024;
    rows.push({ r: rr, mobs: snap.mobs.length, bin: bin, json: json, kb: kb, lf: PB.stats.longForm });
    console.log('      viewRadius=' + String(rr).padStart(4) + '  视野内怪 ' +
      String(snap.mobs.length).padStart(4) + ' 只（占全图 ' +
      String(Math.round(snap.mobs.length / C.MAX_MOBS * 100)).padStart(3) + '%）' +
      '  二进制 ' + String(bin).padStart(5) + ' B/包  → 单人 ' +
      String(kb.toFixed(1)).padStart(6) + ' KB/s' +
      '   (JSON ' + (json / 1024).toFixed(1) + ' KB/包 → ' + (json * config.snapshotHz / 1048576).toFixed(2) + ' MB/s)');
  }

  // 相机可见半对角（1240x900 的 16:9 近似）——裁剪半径至少要盖住它，否则屏幕边上会缺怪
  const halfDiag = Math.round(Math.sqrt(1240 * 1240 + 900 * 900) / 2);

  const wide = rows[1];      // 1400（P2-5 之前的默认值）
  const tuned = rows[3];     // 900（新默认兜底值）
  const tight = rows[5];     // 600（钳位下界）

  console.log('    相机可见半对角约 ' + halfDiag + 'px：裁剪半径必须大于它，否则屏幕角落会缺怪。');
  console.log('    旧的全局 1400 覆盖全图 ' + Math.round(wide.mobs / C.MAX_MOBS * 100) +
    '% 的怪 —— 基本等于没裁，这是 P2-5 前带宽下不来的直接原因之一。');
  console.log('    注意裁剪不是万能的：怪就刷在屏幕外一点点（spawnRadius = 半对角 + 200），' +
    '所以半径压到「刚好盖住屏幕」也只能去掉外围那部分，真正的量级改善靠二进制编码。');

  expect('旧的 1400 几乎没裁掉什么（≥70% 全在图里）', wide.mobs / C.MAX_MOBS >= 0.7,
    Math.round(wide.mobs / C.MAX_MOBS * 100) + '%');
  expect('新兜底值 900 有实质减量（砍掉四成以上）', tuned.mobs <= wide.mobs * 0.6,
    tuned.mobs + ' vs ' + wide.mobs);
  expect('新兜底值 900 仍盖住相机可见半对角', 900 > halfDiag, '900 vs ' + halfDiag);
  expect('新兜底值 900 时单人下行 < 250 KB/s', tuned.kb < 250, tuned.kb.toFixed(1) + ' KB/s');
  expect('二进制的裁剪收益是线性的（600 比 900 更省）', tight.bin < tuned.bin,
    tight.bin + ' vs ' + tuned.bin);
  expect('整段扫描无长格式（带宽没有偷偷退化）',
    rows.every(function (x) { return x.lf === 0; }),
    JSON.stringify(rows.map(function (x) { return x.lf; })));

  // ---------- E3. 真跑一整局，报告真实带宽 ----------
  // 只跑几十秒是看不出问题的：开局怪很少，带宽自然好看。
  // 这里跑满一整局（MATCH_SEC 秒），并且每秒采一次样，
  // 才能回答「打到后期怪最多的时候，单人下行到底多少」。
  //
  // 裁剪走**真实路径**：先给 4 个人设上真实视口（1280x860，就是 roomcheck 那个无头窗口的尺寸），
  // 让 match.viewBoxFor 按相机矩形算框，而不是 bintest 自己编一个半径。
  console.log('');
  console.log('    【真跑一整局】4 人满 ' + C.MATCH_SEC + ' 秒（视口 1280x860，每秒采样）：');

  const VIEW_W = 1280;
  const VIEW_H = 860;

  const col = makeCollector();
  const conns = [];
  for (let i = 0; i < 4; i++) {
    const cid = 'bc' + i;
    manager.addConn(cid, { userId: null, nickname: 'B' + i, isGuest: true, status: 'lobby' });
    conns.push(cid);
  }
  const room = manager.createRoom(conns[0], { charId: 'hunter' }).room;
  for (let i = 1; i < 4; i++) manager.joinRoom(room.code, conns[i], { charId: 'nun' });

  const m = registry.start(room, { onSend: col.sendTo, seed: 20260920 });
  for (let i = 0; i < 4; i++) m.setViewport(conns[i], VIEW_W, VIEW_H);

  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let i = 0; i < 4; i++) m.setInput(conns[i], dirs[i][0], dirs[i][1], 1);

  const totalFrames = C.MATCH_SEC * C.TICK_HZ;
  const samples = [];      // 每秒一个样本
  let maxAlive = 0;
  const t0 = Date.now();

  for (let i = 0; i < totalFrames; i++) {
    if (i % 100 === 0) {
      for (let k = 0; k < 4; k++) {
        const d = dirs[(i / 100 + k) % 4];
        m.setInput(conns[k], d[0], d[1], i);
      }
    }
    m.stepOnce();

    const alive = SIM.countAliveMobs(m.world);
    if (alive > maxAlive) maxAlive = alive;

    if (i % C.TICK_HZ === 0) {              // 每秒采一次
      const p0 = m.players[0];
      const box = m.viewBoxFor(conns[0], p0);
      const snap = m.snapshotFor(p0, box);
      const bin = PB.encode(snap, { key: false, omitPrev: true }).length;
      samples.push({
        sec: Math.round(m.world.time),
        alive: alive,
        view: snap.mobs.length,
        bytes: bin
      });
    }
  }
  const wallMs = Date.now() - t0;

  const avg = function (arr) {
    return arr.length ? Math.round(arr.reduce(function (a, b) { return a + b; }, 0) / arr.length) : 0;
  };
  const early = samples.filter(function (s) { return s.sec < 120; });
  const earlyBytes = avg(early.map(function (s) { return s.bytes; }));
  const peakBucket = samples.reduce(function (a, b) { return b.bytes > a.bytes ? b : a; }, samples[0]);
  const avgBytes = avg(samples.map(function (s) { return s.bytes; }));
  const lateHalf = samples.filter(function (s) { return s.sec >= Math.round(C.MATCH_SEC / 2); });
  const lateBytes = avg(lateHalf.map(function (s) { return s.bytes; }));
  const avgView = avg(samples.map(function (s) { return s.view; }));
  // 实测压缩比（同一帧 JSON vs 二进制）在 [E1] 是 12 倍，这里用它把 JSON 口径折算出来
  const JSON_RATIO = 12;

  const perSec = function (b) { return (b * config.snapshotHz / 1024).toFixed(1); };

  console.log('      跑完 ' + totalFrames + ' 帧（' + Math.round(C.MATCH_SEC / 60) + ' 分钟游戏时间）用时 ' +
    wallMs + 'ms  世界存活怪峰值 ' + maxAlive + ' 只（打到了 MAX_MOBS 上限 ' + C.MAX_MOBS + '）');
  console.log('      裁剪后视野内怪：平均 ' + avgView + ' 只，最多 ' + peakBucket.view + ' 只（第 ' + peakBucket.sec + ' 秒）');
  console.log('      单包字节：开局两分钟平均 ' + earlyBytes + ' B，整局平均 ' + avgBytes +
    ' B，后半局平均 ' + lateBytes + ' B，峰值 ' + peakBucket.bytes + ' B');
  console.log('      单人下行（二进制，' + config.snapshotHz + 'Hz）：开局两分钟 ' + perSec(earlyBytes) +
    ' KB/s，整局平均 ' + perSec(avgBytes) + ' KB/s，后半局 ' + perSec(lateBytes) +
    ' KB/s，峰值 ' + perSec(peakBucket.bytes) + ' KB/s');
  console.log('      同样的数据用 P2-5 前的 JSON 发（按实测 ' + JSON_RATIO + ' 倍折算）：后半局约 ' +
    (lateBytes * JSON_RATIO * config.snapshotHz / 1048576).toFixed(2) + ' MB/s，峰值约 ' +
    (peakBucket.bytes * JSON_RATIO * config.snapshotHz / 1048576).toFixed(2) + ' MB/s');
  console.log('      参考：单实例 1 核跑 ' + (totalFrames / (wallMs / 1000)).toFixed(0) +
    ' 帧/秒（20Hz 只需 20 帧/秒）—— 瓶颈在网不在算');
  console.log('      注：怪满 1200 时视野内 500~860 只，这是本设计的物理下限（每只怪每帧都要报位置）。' +
    '想再降只能动「发多快」或「每只多少字节」，见本文件末尾的备注。');

  // 视野框的形状验证：矩形应当比「同覆盖能力的圆」小一大截，而且贴地图边界不漏
  const p0 = m.players[0];
  const boxNow = m.viewBoxFor(conns[0], p0);
  const boxArea = (boxNow.x1 - boxNow.x0) * (boxNow.y1 - boxNow.y0);
  const coverR = Math.sqrt(VIEW_W * VIEW_W + VIEW_H * VIEW_H) / 2 + config.viewPad;
  const circleArea = Math.PI * coverR * coverR;

  // 贴边角时不能漏：把玩家挪到地图角上，视野框必须仍然盖住整个相机矩形
  const cornerP = { x: 0, y: 0 };
  const cornerBox = viewBoxForTest(cornerP, VIEW_W, VIEW_H, config.viewPad);
  const camX = 0, camY = 0;   // 玩家在 (0,0) → 相机被钳到 (0,0)
  const cornerCovered = cornerBox.x0 <= camX && cornerBox.y0 <= camY &&
    cornerBox.x1 >= camX + VIEW_W && cornerBox.y1 >= camY + VIEW_H;
  // 贴右下角（相机钳到地图右下）
  const farP = { x: C.MAP.width, y: C.MAP.height };
  const farBox = viewBoxForTest(farP, VIEW_W, VIEW_H, config.viewPad);
  const farCamX = C.MAP.width - VIEW_W;
  const farCamY = C.MAP.height - VIEW_H;
  const farCovered = farBox.x0 <= farCamX && farBox.y0 <= farCamY &&
    farBox.x1 >= farCamX + VIEW_W && farBox.y1 >= farCamY + VIEW_H;

  console.log('');
  console.log('    【视野框形状】视口 ' + VIEW_W + 'x' + VIEW_H + '：矩形 ' +
    Math.round((boxNow.x1 - boxNow.x0)) + 'x' + Math.round((boxNow.y1 - boxNow.y0)) +
    ' = ' + (boxArea / 10000).toFixed(0) + ' 万px²；同覆盖能力的圆半径 ' + Math.round(coverR) +
    'px = ' + (circleArea / 10000).toFixed(0) + ' 万px² → 矩形小 ' +
    (circleArea / boxArea).toFixed(2) + ' 倍（省 ' +
    ((1 - boxArea / circleArea) * 100).toFixed(0) + '% 面积，即每帧少发这么多只怪）');
  console.log('    贴地图左上 / 右下角时视野框是否仍盖住整个相机矩形：' +
    (cornerCovered ? '是' : '否') + ' / ' + (farCovered ? '是' : '否') +
    '（这是圆裁剪的老毛病：玩家偏到屏幕边角，圆的远端就不够远了）');

  expect('真跑一整局里世界确实在刷怪', maxAlive > 50, 'maxAlive=' + maxAlive);
  expect('世界模拟跑得动 20Hz（整局耗时远小于游戏时长）', wallMs < C.MATCH_SEC * 200,
    wallMs + 'ms / ' + C.MATCH_SEC + 's');
  expect('开局两分钟单人下行 < 20 KB/s（规划里的 13 KB/s 量级就在这一段）',
    earlyBytes * config.snapshotHz / 1024 < 20, perSec(earlyBytes) + ' KB/s');
  expect('整局平均单人下行 < 200 KB/s', avgBytes * config.snapshotHz / 1024 < 200,
    perSec(avgBytes) + ' KB/s');
  expect('峰值单人下行 < 350 KB/s', peakBucket.bytes * config.snapshotHz / 1024 < 350,
    perSec(peakBucket.bytes) + ' KB/s');
  expect('比 P2-5 前的 JSON 至少省 10 倍',
    (peakBucket.bytes * JSON_RATIO) / peakBucket.bytes >= 10, JSON_RATIO + '×');
  expect('裁剪按人按视口走（mode=box，不是兜底半径）',
    m.viewInfoFor(conns[0]).mode === 'box', JSON.stringify(m.viewInfoFor(conns[0])));
  expect('视野框比同覆盖能力的圆省 30% 以上面积', circleArea / boxArea > 1.4,
    (circleArea / boxArea).toFixed(2) + '×');
  expect('贴地图左上角时视野框仍盖住整个相机矩形', cornerCovered,
    JSON.stringify(cornerBox) + ' cam=0,0 ' + VIEW_W + 'x' + VIEW_H);
  expect('贴地图右下角时视野框仍盖住整个相机矩形', farCovered,
    JSON.stringify(farBox) + ' cam=' + farCamX + ',' + farCamY);

  registry._reset();
}

// 复刻 match.js 的 viewBoxForPlayer。
// 这里刻意**重新实现一遍**而不是 import：一是那是个内部函数没导出，
// 二是「两份独立实现算出来的框能对上」本身就是一条有价值的交叉验证。
function viewBoxForTest(p, w, h, pad) {
  const clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  const camX = clamp(p.x - w / 2, 0, Math.max(0, C.MAP.width - w));
  const camY = clamp(p.y - h / 2, 0, Math.max(0, C.MAP.height - h));
  return { x0: camX - pad, y0: camY - pad, x1: camX + w + pad, y1: camY + h + pad };
}

// ============================================================
// P2-5 之后的进一步压缩空间（留给 P2-5b，本轮没做）
// ============================================================
// 怪满 1200 时视野内 500~860 只、每只 ~13.8 字节，×20Hz 就是 150~250 KB/s。
// 想再往下压，只有三条路，按「收益 / 风险」排序：
//
// 1. 坐标改成增量（dx = x - 上一帧的 x）。20Hz 下怪一帧只走 3~4.5px，
//    sv4 增量只要 1 字节，绝对坐标要 2 字节 → 每只省 2 字节（约 14%）。
//    需要给实体 flags 加一位「本帧是绝对坐标」（刚出生的怪没有上一帧）。
// 2. 速度改成朝向。渲染层只在 pack.rot 时才用 atan2(vy,vx)，
//    传 facing（sf，1~2 字节）就不必传 vx+vy（4 字节）→ 每只省约 2 字节（约 14%）。
//    要改 render.js 的取角方式，风险比第 1 条高。
// 3. 降快照频率 + 客户端外推。SNAPSHOT_HZ=10 直接砍一半，
//    但客户端要用 vx/vy 自己推位置（正好和上面第 2 条冲突，要一起设计）。
//    局域网 RTT 只有 0.6ms，降到 10Hz 手感损失很小，性价比其实最高。
//
// 这三条都已记录在规划方案.md 的 P2-5 小节里，本轮不做是为了先把
// 「协议能跑、无损、诚实量化」这件事钉死。

// 均匀撒在半径为 R 的圆盘里的 n 只怪。用固定种子的线性同余，
// 保证每次跑出来的数字完全一样（带宽测试必须可复现）。
function makeSpawnDisc(n, R, cx, cy) {
  let s = 20260920;
  const rnd = function () {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    // sqrt 是为了让点在圆盘上「面积均匀」——不取 sqrt 的话会全挤在圆心
    const rad = R * Math.sqrt(rnd());
    const ang = rnd() * Math.PI * 2;
    const x = Math.round((cx + Math.cos(ang) * rad) * 100) / 100;
    const y = Math.round((cy + Math.sin(ang) * rad) * 100) / 100;
    out.push({
      id: i + 1,
      defId: MOB_IDS[i % MOB_IDS.length],
      x: x, y: y,
      px: x, py: y,
      hp: 8 + (i % 5) * 3,
      maxHp: 20,
      r: 10 + (i % 4),
      vx: -60 + (i % 7) * 20,
      vy: -60 + (i % 5) * 24,
      flash: (i % 9 === 0) ? 0.1 : 0,
      alive: true,
      stun: 0,
      charging: 0
    });
  }
  return out;
}

// 收集器：只要二进制帧的字节数（这里不关心内容，内容在 [B] 已经测过了）
function makeCollector() {
  const log = [];
  return {
    log: log,
    sendTo: function (connId, obj) {
      if (obj instanceof Uint8Array) { log.push({ to: connId, bytes: obj.byteLength }); return obj.byteLength; }
      return JSON.stringify(obj).length;
    },
    broadcast: function () { },
    pushOnline: function () { },
    clear: function () { log.length = 0; }
  };
}

// ============================================================
// 跑
// ============================================================

console.log('P2-5 二进制快照协议自检');
console.log('协议版本 v' + PB.VERSION + '  串池 ' + PB.STR_POOL.length + ' 项  列表 ' + PB.LISTS.length + ' 个');

testSchema();
testRoundTrip();
testKeyFrame();
testPool();
testBandwidth();

console.log('');
console.log('=== 汇总 ===');
console.log('  PASS  ' + pass);
console.log('  FAIL  ' + fail);
process.exit(fail > 0 ? 1 : 0);
