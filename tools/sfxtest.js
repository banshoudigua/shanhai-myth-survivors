// 音效层回归（Node 侧，不需要浏览器）。跑：node tools/sfxtest.js
// ★重点不是「play 会不会响」，而是「不该响的时候别响」「不会拖累世界」。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function makeEnv(opt) {
  opt = opt || {};
  const store = Object.assign({}, opt.store || {});
  const created = [];
  const plays = [];
  let now = 1000;
  function Howl(cfg) {
    created.push(cfg);
    this.play = function () { plays.push(cfg.src[0]); return plays.length; };
    this.rate = function () {};
  }
  const ctx = {
    console: console, Math: Math, Date: Date, Object: Object, Array: Array,
    performance: { now: function () { return now; } },
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); }
    },
    document: { addEventListener: function () {}, removeEventListener: function () {} },
    Howl: opt.noHowl ? undefined : Howl,
    Howler: opt.noHowl ? undefined : { mute: function (v) { ctx.__muted = v; }, volume: function () {}, ctx: { state: 'running' } },
  };
  ctx.window = ctx;
  if (!opt.broken) vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/js/sfx.js'), 'utf8'), ctx, { filename: 'sfx.js' });
  const S = ctx.VS && ctx.VS.Sfx;
  return {
    ctx: ctx, S: S, created: created, plays: plays, store: store,
    tick: function (ms) { now += ms; },
    get now() { return now; }
  };
}

console.log('=== 音效层 ===');

// 1. 偏好：默认开；显式关过要记住；脚本加载时就生效（不能等 init）
{
  const a = makeEnv();
  expect('默认开启', a.S.enabled === true);
  const b = makeEnv({ store: { vs_sfx: '0' } });
  expect('上次关过 → 脚本一加载就是关闭', b.S.enabled === false);
  b.S.init();
  expect('关闭状态下 init 后 Howler 是静音的', b.ctx.__muted === true);
  b.S.setEnabled(true);
  expect('打开后写回 localStorage', b.store.vs_sfx === '1');
  expect('打开后 Howler 取消静音', b.ctx.__muted === false);
}

// 2. 加载与降级
{
  const a = makeEnv();
  expect('init 前 play 不抛异常', a.S.play('slash') === false);
  expect('init 成功', a.S.init() === true);
  expect('15 个音效各建一个 Howl', a.created.length === 15, '实际 ' + a.created.length);
  expect('全部走 /audio/*.wav 本地路径', a.created.every(c => /^\/audio\/[a-z]+\.wav$/.test(c.src[0])));
  expect('全部标注 wav 格式（Howler 不会靠扩展名猜）', a.created.every(c => c.format[0] === 'wav'));
  expect('重复 init 不会重复建实例', (a.S.init(), a.created.length === 15));
  const b = makeEnv({ noHowl: true });
  expect('库没加载时 init 安静返回 false', b.S.init() === false);
  expect('库没加载时 play 不抛', b.S.play('boss') === false);
  expect('库没加载时 onEvent 不抛', (b.S.onEvent({ type: 'boss' }), true));
}

// 3. 限流：同名连打只能响一次，隔够时间才能再响
{
  const a = makeEnv(); a.S.init();
  expect('第一次挥砍发声', a.S.play('slash') === true);
  expect('同一帧的第二次挥砍被限流', a.S.play('slash') === false);
  a.tick(40);
  expect('间隔不足仍被限流', a.S.play('slash') === false);
  a.tick(50);
  expect('过了间隔可以再响', a.S.play('slash') === true);
  const n = a.plays.length;
  a.S.play('unknown_sound');
  expect('未知音效名静默忽略', a.plays.length === n);
  a.S.setEnabled(false);
  a.tick(2000);
  expect('静音后 play 完全不发声', a.S.play('hit') === false && a.plays.length === n);
  a.S.setEnabled(true);
  expect('取消静音后恢复', a.S.play('hit') === true);
}

// 4. 事件映射：只挑有节奏意义的，波次播报不能响
{
  const a = makeEnv(); a.S.init();
  a.S.onEvent({ type: 'wave', wave: 5 });
  expect('波次播报不发声（一局会来几十次）', a.plays.length === 0);
  a.tick(3000);
  a.S.onEvent({ type: 'boss', name: '蚩尤' });
  expect('首领降临 → boss', a.S.stats().lastPlayed === 'boss');
  a.tick(3000);
  a.S.onEvent({ type: 'dead' });
  expect('阵亡 → lose', a.S.stats().lastPlayed === 'lose');
  a.tick(3000);
  a.S.onEvent({ type: 'won' });
  expect('通关 → win', a.S.stats().lastPlayed === 'win');
  a.tick(3000);
  a.S.onEvent({ type: 'chest_open' });
  expect('开箱 → chest', a.S.stats().lastPlayed === 'chest');
}

// 5. 差分：第一帧只建基线；击杀/掉血/升级/捡钱各响一次；重开不误播
{
  const a = makeEnv(); a.S.init();
  const h = { kills: 3, hp: 100, level: 2, gold: 10 };
  a.S.onFrame(h, true);
  expect('第一帧只建基线，不把开局当成瞬间升级', a.plays.length === 0);
  a.S.onFrame({ kills: 3, hp: 100, level: 2, gold: 10 }, true);
  expect('数值没变就不发声（快照每帧重建也不该响）', a.plays.length === 0);
  a.tick(300);
  a.S.onFrame({ kills: 4, hp: 100, level: 2, gold: 10 }, true);
  expect('击杀 +1 → kill/boom', a.S.stats().lastPlayed === 'kill' || a.S.stats().lastPlayed === 'boom');
  a.tick(300);
  a.S.onFrame({ kills: 4, hp: 88, level: 2, gold: 10 }, true);
  expect('掉血 → hurt', a.S.stats().lastPlayed === 'hurt');
  a.tick(500);
  a.S.onFrame({ kills: 4, hp: 88, level: 3, gold: 25 }, true);
  expect('升级/捡钱同时发生也不抛', a.S.stats().played >= 3);
  a.S.onFrame(h, false);
  a.tick(3000);
  const before = a.plays.length;
  a.S.onFrame({ kills: 99, hp: 1, level: 30, gold: 999 }, true);
  expect('暂停/重开后第一帧仍只建基线', a.plays.length === before);
  a.tick(3000);
  a.S.onFrame({ kills: 140, hp: 1, level: 30, gold: 999 }, true);
  expect('一次群伤跳 41 杀不播「炸屏音」（上限保护）', a.S.stats().lastPlayed !== 'boom');
}

// 6. 与 act 起手对齐的 punch
{
  const a = makeEnv(); a.S.init();
  a.S.punch('cleave');
  expect('重斩 → slash', a.S.stats().lastPlayed === 'slash');
  a.tick(3000);
  a.S.punch('lightning');
  expect('雷击 → lightning', a.S.stats().lastPlayed === 'lightning');
}

// 7. ★铁律：音效一个字段都不能进联机协议/模拟层
{
  const proto = fs.readFileSync(path.join(ROOT, 'shared/proto_bin.js'), 'utf8');
  const sim = fs.readFileSync(path.join(ROOT, 'shared/sim.js'), 'utf8');
  expect('二进制协议里没有 sfx/audio 字段', !/\b(sfx|audio|sound|Howl)\b/i.test(proto));
  expect('模拟层里没有音效调用', !/\b(VS\.Sfx|Howl|new Audio)\b/.test(sim));
  const wavCount = fs.readdirSync(path.join(ROOT, 'public/audio')).filter(f => f.endsWith('.wav')).length;
  expect('15 个 wav 都在（漏一个线上就是静默 404）', wavCount === 15, '实际 ' + wavCount);
  const names = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/audio/sfx.json'), 'utf8'));
  const missing = names.filter(n => !fs.existsSync(path.join(ROOT, 'public/audio', n + '.wav')));
  expect('sfx.json 清单与实际文件一致', missing.length === 0, missing.join(','));
  expect('运行时清单与生成清单一致', names.join(',') === makeEnv().S.stats().names.join(','));
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
