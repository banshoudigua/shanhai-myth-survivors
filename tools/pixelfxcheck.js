// 技能特效打包产物自检：不启浏览器，直接在 Node 里把 IIFE 跑起来，
// 逐个特效推进几帧，确认「能创建实例、能推进时间、能画出非空像素」。
//
// 为什么需要它：库源码是 ESM，游戏侧用的是打包后的全局脚本；
// 打包漏文件、某个特效依赖浏览器 API、调色板格式不对，这些都不会在浏览器里
// 报出好懂的错（表现往往是「特效整个不出现」）。这里先把底层链路钉死。
//
// 用法：node tools/pixelfxcheck.js
const path = require('path');

let fail = 0;
let pass = 0;
function expect(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log('  ok  ' + name);
  } else {
    fail += 1;
    console.log(' FAIL ' + name + (detail ? ' → ' + detail : ''));
  }
}

// 产物是 IIFE，靠 window.PixelFX 暴露；Node 里把 window 指到 global 就能直接 require
global.window = global;
const bundle = path.join(__dirname, '..', 'public', 'vendor', 'pixelfx', 'pixelfx.js');
require(bundle);

const lib = global.PixelFX;
expect('打包产物暴露 window.PixelFX', !!lib);
expect('核心 API 齐全', !!(lib && lib.createFrame && lib.clearFrame && lib.createFx && lib.composite));

if (!lib) {
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(1);
}

const names = Object.keys(lib.effects);
expect('技能特效数量=18', names.length === 18, '实际 ' + names.length);

// 项目配色：琥珀金由暗到亮，库会按各特效默认色阶长度自动重采样
const GOLD = ['#241206', '#4a2a0c', '#7d4a12', '#b37418', '#e0a327', '#ffc94a', '#ffe89a', '#fff8dc'];

for (let n = 0; n < names.length; n++) {
  const name = names[n];
  const mod = lib.effects[name];
  const meta = mod.meta;
  const size = meta.size;
  const origin = meta.origin;
  const okMeta = Array.isArray(size) && size.length === 2 &&
    Array.isArray(origin) && origin.length === 2 &&
    Number(meta.duration) > 0;
  expect(name + ' meta 可用', !!okMeta, JSON.stringify({ size: size, origin: origin, duration: meta.duration }));
  if (!okMeta) continue;

  const w = size[0], h = size[1];
  const frame = lib.createFrame(w, h, 0, 0);
  const out = new Uint8ClampedArray(w * h * 4);
  const fx = lib.createFx(mod, {
    x: origin[0], y: origin[1], seed: 7, palette: GOLD, light: 1, flip: false, angle: 0,
  });

  // 一次性特效只活 0.2~0.3 秒，前几帧必须就有东西；循环特效也要能持续出像素
  let best = 0;
  for (let step = 0; step < 8; step++) {
    fx.update(0.05);
    lib.clearFrame(frame);
    fx.draw(frame, 'back');
    fx.draw(frame, 'front');
    lib.composite(frame, out, null);
    let lit = 0;
    for (let i = 3; i < out.length; i += 4) if (out[i] > 0) lit += 1;
    if (lit > best) best = lit;
  }
  expect(name + ' 能画出非空像素', best > 0, '最大可见像素数 ' + best);
}

// ---------------- 角色动作时序（acting）----------------
// entry.js 必须把 act 数据与 actTiming 一起打进产物，否则渲染层会静默退回兜底节奏：
// 表现是「角色照样能走，但攻击没有起手和定格」，很容易被当成「效果本来就这样」。
expect('产物导出了 4 套 act 数据', !!lib.acts && Object.keys(lib.acts).length === 4,
  lib.acts ? Object.keys(lib.acts).join(',') : '无');
expect('产物导出了 actTiming API', typeof lib.actTiming === 'function');

if (lib.acts) {
  for (let a = 0; a < Object.keys(lib.acts).length; a++) {
    const key = Object.keys(lib.acts)[a];
    const t = lib.acts[key].timing;
    const data = lib.acts[key].data;
    expect(key + ' 时序完整（起手 / 命中定格 / 姿态轨）',
      !!t && t.windup > 0 && !!t.hits.length && t.hits[0].freeze > 0 && t.poses.length >= 3,
      JSON.stringify(t && { windup: t.windup, hits: t.hits, poses: t.poses.length }));
    expect(key + ' 原始 act 数据也在', !!data && Array.isArray(data.poses) && data.poses.length >= 3);
  }
  // 入口算好的时序必须和官方 API 现算的一致，防止两边键名配错（配错会静默拿到 null）
  const official = lib.actTiming(lib.effects.slash);
  expect('acts.slash.timing 与 actTiming(effects.slash) 一致',
    !!official && Math.abs(official.windup - lib.acts.slash.timing.windup) < 1e-6 &&
    Math.abs(official.hits[0].freeze - lib.acts.slash.timing.hits[0].freeze) < 1e-6);
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
if (fail > 0) process.exit(1);
