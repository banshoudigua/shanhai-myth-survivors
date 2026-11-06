// tools/portaltest.js —— 传送门专项回归（第二十八轮）
//
// 【为什么要单独一个文件】传送门是「地图坐标 + 玩家位置瞬移」的耦合逻辑：
// 门是纯函数算出来的（不进快照），瞬移判定在 sim 里（服务端权威）。
// 两边任何一处算错，表现都是「走上去没反应」或者「人被扔进墙里」——
// 这两种都不会抛异常，只会静默地不对，所以必须专门钉住。
//
// 用法：node tools/portaltest.js
const SIM = require('../shared/sim.js');
const M = require('../shared/maps.js');
const C = require('../shared/const.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}
function dist(x1, y1, x2, y2) { return Math.hypot(x2 - x1, y2 - y1); }

function blockedAt(w, x, y) {
  // 用一个临时实体问「这个点会不会撞进障碍」
  const probe = { x: x, y: y, r: C.PLAYER.radius };
  const list = w.obstacles;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    const dx = x - o.x, dy = y - o.y;
    const min = o.r + probe.r;
    if (dx * dx + dy * dy < min * min) return true;
  }
  return false;
}

console.log('=== 1) 每张图的传送门都成对 ===');
M.MAPS.forEach(function (m) {
  const list = M.buildPortals(m);
  const paired = list.length > 0 && list.every(function (g) {
    const other = list[g.pair];
    return !!other && other.pair === list.indexOf(g);
  });
  ok('[' + m.id + '] 生成了 ' + list.length + ' 个门，且双向配对', paired, JSON.stringify(list));
});

console.log('\n=== 2) 踩上去真的会瞬移到对端 ===');
const w = SIM.createWorld({ charId: 'hunter', seed: 7, mapId: 'graveyard' });
SIM.setSelf(w, null);
const p = w.players[0];
ok('世界里有传送门', Array.isArray(w.portals) && w.portals.length >= 2, '数量=' + (w.portals || []).length);

const gate = w.portals[0];
const target = w.portals[gate.pair];
// 清场：别让怪干扰（这一步只测传送）
w.mobs.length = 0;
p.x = gate.x;
p.y = gate.y;
p.portalCd = 0;
SIM.step(w, { mx: 0, my: 0 });

ok('站到入口上人就被送走了', dist(p.x, p.y, gate.x, gate.y) > 100,
  '距入口 ' + dist(p.x, p.y, gate.x, gate.y).toFixed(0) + 'px');
ok('落点在对端附近（100px 内）', dist(p.x, p.y, target.x, target.y) < 100,
  '距对端 ' + dist(p.x, p.y, target.x, target.y).toFixed(0) + 'px');
ok('★落点不在障碍里（不会被扔进墙）', !blockedAt(w, p.x, p.y),
  '(' + p.x.toFixed(0) + ',' + p.y.toFixed(0) + ')');

console.log('\n=== 3) 冷却：不会来回弹 ===');
const posAfter = { x: p.x, y: p.y };
ok('传送后进入冷却', p.portalCd > 0, 'cd=' + (p.portalCd || 0).toFixed(2));
// 连跑 0.5 秒（20Hz 下 10 步）：冷却没走完，人不该再被传走
for (let i = 0; i < 10; i++) SIM.step(w, { mx: 0, my: 0 });
ok('冷却期间不会被传回起点', dist(p.x, p.y, posAfter.x, posAfter.y) < 40,
  '位移 ' + dist(p.x, p.y, posAfter.x, posAfter.y).toFixed(0) + 'px');

console.log('\n=== 4) 传送只挪位置，不动数值 ===');
const w2 = SIM.createWorld({ charId: 'hunter', seed: 9, mapId: 'graveyard' });
SIM.setSelf(w2, null);
const p2 = w2.players[0];
w2.mobs.length = 0;
const hp0 = p2.hp, lv0 = p2.level, gold0 = w2.stats.gold;
p2.x = w2.portals[0].x;
p2.y = w2.portals[0].y;
p2.portalCd = 0;
SIM.step(w2, { mx: 0, my: 0 });
ok('血量/等级/金币都没变', p2.hp === hp0 && p2.level === lv0 && w2.stats.gold === gold0,
  hp0 + '→' + p2.hp + ' / lv' + lv0 + '→' + p2.level + ' / gold' + gold0 + '→' + w2.stats.gold);
const evs = SIM.takeEvents(w2, 0).filter(function (e) { return e.type === 'portal'; });
ok('推了一条 portal 事件（界面/音效可以据此给反馈）', evs.length === 1, JSON.stringify(evs));

console.log('\n=== 5) 没有传送门的地图不该崩 ===');
const bare = SIM.createWorld({ charId: 'hunter', seed: 11 });
SIM.setSelf(bare, null);
bare.portals = [];
for (let i = 0; i < 5; i++) SIM.step(bare, { mx: 0, my: 0 });
ok('w.portals 为空时照常跑 5 步', true);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exitCode = fail ? 1 : 0;
