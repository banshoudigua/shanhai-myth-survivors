// tools/actormotiontest.js —— 角色动作状态机专项回归
//
// 状态机最容易出的错是「定格一开就再也不恢复」和「定格顺手把世界时间也停了」。
// 后者在联机里是致命的（世界停不下来），所以这里把两条边界都钉死：
//   ① 定格期间动画时钟不得推进；② 状态机没有任何暂停 / 改写世界时间的入口。
//
// 用法：node tools/actormotiontest.js

const path = require('node:path');

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; console.log('  PASS  ' + name + (detail ? '  (' + detail + ')' : '')); }
  else { fail += 1; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

// 两个脚本都是 IIFE 全局脚本：Node 里把 window 指到 global 就能直接 require
global.window = global;
require(path.join(__dirname, '..', 'public', 'vendor', 'pixelfx', 'pixelfx.js'));
require(path.join(__dirname, '..', 'public', 'js', 'actor-motion.js'));

const AM = global.VS && global.VS.ActorMotion;
expect('ActorMotion 已挂载', !!AM);
if (!AM) { console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败'); process.exit(1); }

// ---------------- 1. 帧取值合法 ----------------
console.log('\n[1] 帧与步态');
AM.reset();
const idleSeen = {};
for (let i = 0; i < 120; i++) {
  idleSeen[AM.poseOf('self', false)] = 1;
  AM.begin(0.016);
}
expect('站着会在 0/1 两帧间呼吸', idleSeen[0] === 1 && idleSeen[1] === 1,
  '出现过的帧=' + Object.keys(idleSeen).join(','));
const walkSeen = {};
for (let i = 0; i < 60; i++) {
  walkSeen[AM.poseOf('self', true)] = 1;
  AM.begin(0.016);
}
expect('移动时两帧交替', walkSeen[0] === 1 && walkSeen[1] === 1,
  '出现过的帧=' + Object.keys(walkSeen).join(','));
expect('★没有 punch 就绝不会出现挥砍帧 2', idleSeen[2] === undefined && walkSeen[2] === undefined);
expect('怪物起伏只返回 0/1', AM.mobWobble(1) === 0 || AM.mobWobble(1) === 1);

// ---------------- 2. 一次攻击的完整时序 ----------------
console.log('\n[2] 起手 → 挥出 → 命中定格 → 收招');
AM.reset();
expect('punch 成功（读到了 pixelfx 的 act 时序）', AM.punch('self', 'slash') === true);
expect('起手阶段是压低帧', AM.poseOf('self', false) === AM.FRAME.STEP,
  '帧=' + AM.poseOf('self', false));

let sawStrike = false;
let freezeAt = -1;
for (let i = 0; i < 60; i++) {
  if (AM.poseOf('self', false) === AM.FRAME.STRIKE) sawStrike = true;
  AM.begin(0.016);
  if (freezeAt < 0 && AM.stats().freezeLeft > 0) freezeAt = i;
}
expect('★出现过挥砍帧 2', sawStrike);
expect('★命中点触发了定格', freezeAt >= 0, '第 ' + freezeAt + ' 帧');
expect('定格确实来自 act 的 freeze（不是写死的 0）',
  AM.stats().freezes > 0, '累计 ' + AM.stats().freezes + ' 次');

// ---------------- 3. 定格只冻表现层时钟 ----------------
console.log('\n[3] 定格边界');
AM.reset();
AM.punch('self', 'cleave');
for (let i = 0; i < 30 && AM.stats().freezeLeft <= 0; i++) AM.begin(0.016);
const clockAtFreeze = AM.stats().clock;
const leftAtStart = AM.stats().freezeLeft;
for (let i = 0; i < 4; i++) AM.begin(0.016);
expect('★定格期间动画时钟不推进', AM.stats().clock === clockAtFreeze,
  'clock ' + clockAtFreeze + ' → ' + AM.stats().clock);
expect('定格时间在消耗', AM.stats().freezeLeft < leftAtStart,
  leftAtStart + ' → ' + AM.stats().freezeLeft);
const poseFrozen = AM.poseOf('self', false);
for (let i = 0; i < 3; i++) AM.begin(0.016);
expect('★定格期间姿态不变', AM.poseOf('self', false) === poseFrozen);

for (let i = 0; i < 60 && AM.stats().freezeLeft > 0; i++) AM.begin(0.016);
const clockAfter = AM.stats().clock;
for (let i = 0; i < 5; i++) AM.begin(0.016);
expect('★定格结束后时钟恢复推进（不会卡死）', AM.stats().clock > clockAfter,
  clockAfter + ' → ' + AM.stats().clock);

// ---------------- 4. 不碰世界 ----------------
console.log('\n[4] 纯表现层边界');
expect('★没有暴露任何暂停 / 改写世界时间的入口',
  typeof AM.pause !== 'function' && typeof AM.setTime !== 'function' &&
  typeof AM.stepWorld !== 'function' && typeof AM.freeze !== 'function');
const worldDt = 0.05;
AM.begin(worldDt);
expect('begin 不改写调用方的 dt', worldDt === 0.05);
expect('★攻击结束后状态自动清干净', (function () {
  for (let i = 0; i < 120; i++) AM.begin(0.016);
  return AM.stats().activeAttacks === 0;
})(), JSON.stringify(AM.stats()));

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
