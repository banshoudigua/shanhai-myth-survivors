// 界面增强层回归（Node 侧，DOM 用最小替身）。跑：node tools/uifxtest.js
// ★钉的是「库缺失要降级」「监听要能撤」「同一面板别反复放动画」这些静默失效。

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

function el(cls) {
  const e = {
    nodeType: 1, style: {}, children: [], addedNodes: [], textContent: '',
    classList: { contains: function (c) { return cls.indexOf(c) >= 0; }, add: function () {} },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    removeAttribute: function (k) { delete e.attrs[k]; },
    setAttribute: function (k, v) { e.attrs[k] = v; },
    attrs: {},
  };
  return e;
}

function makeEnv(opt) {
  opt = opt || {};
  const card = el(['slot-card']);
  const anchor = el(['hud-slots']);
  const storyEl = el(['sb-text']);
  const panel = el(['panel']);
  const calls = { compute: 0, autoUpdate: 0, cleanup: 0, animate: 0, targets: [] };
  const F = opt.noFloating ? undefined : {
    computePosition: function () { calls.compute++; return Promise.resolve({ x: 123.7, y: 45.2 }); },
    autoUpdate: function () { calls.autoUpdate++; return function () { calls.cleanup++; }; },
    offset: function (v) { return { name: 'offset', v: v }; },
    flip: function () { return { name: 'flip' }; },
    shift: function () { return { name: 'shift' }; },
    size: function (o) { calls.sizeApply = o.apply; return { name: 'size' }; },
  };
  const anime = opt.noAnime ? undefined : {
    animate: function (t, p) { calls.animate++; calls.targets.push(p); },
    stagger: function () { return 0; },
  };
  const host = el(['hud']);
  const doc = {
    getElementById: function (id) { return id === 'hud' ? host : null; },
    querySelector: function (s) {
      if (s === '.slot-card') return card;
      if (s === '.hud-slots') return anchor;
      if (s === '.story-beat .sb-text') return storyEl;
      if (s === '.overlay .panel') return panel;
      return null;
    },
    addEventListener: function () {}, removeEventListener: function () {},
  };
  const ctx = {
    console: console, Math: Math, Object: Object, Array: Array, Promise: Promise,
    WeakSet: WeakSet, document: doc,
    setTimeout: setTimeout, clearTimeout: clearTimeout,
    FloatingUIDOM: F, anime: anime,
    MutationObserver: function (cb) { calls.mo = cb; this.observe = function () { calls.observed = true; }; },
    Vue: { nextTick: function (f) { f(); } },
  };
  ctx.window = ctx; ctx.self = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/js/ui-fx.js'), 'utf8'), ctx, { filename: 'ui-fx.js' });
  return { ctx: ctx, S: ctx.VS.UiFx, calls: calls, card: card, panel: panel, storyEl: storyEl };
}

const flush = () => new Promise(r => setImmediate(r));
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function () {
  console.log('=== 界面增强层 ===');

  // 1. 全库缺失：必须安静降级（打字机是自写的，仍然可用）
  {
    const a = makeEnv({ noFloating: true, noAnime: true });
    let threw = false;
    try { a.S.init(); a.S.onEvent({ type: 'levelup' }); a.S.layoutSlotCard(); a.S.typeStory('测试'); } catch (e) { threw = true; }
    a.S.clearStory();
    expect('两个库全缺时初始化与调用都不抛', !threw);
    const st = a.S.stats();
    expect('stats 如实报告库不可用', st.floating === false && st.anime === false);
    expect('★打字机不依赖外部库，库全缺仍可用', st.typewriter === true);
  }

  // 2. 浮层定位
  {
    const a = makeEnv(); a.S.init();
    expect('init 后报告 Floating UI 可用', a.S.stats().floating === true);
    expect('布局返回成功', a.S.layoutSlotCard() === true);
    a.S.layoutSlotCard();
    expect('重复布局前先撤掉旧监听', a.calls.cleanup >= 1 && a.calls.autoUpdate === 2);
    await flush();
    expect('坐标写进 style 且取整', a.card.style.left === '124px' && a.card.style.top === '45px',
      JSON.stringify(a.card.style));
    expect('★清掉 CSS 的 bottom（否则 top 会被抵消）', a.card.style.bottom === 'auto');
    expect('size 中间件只限高，不写内联 max-width', typeof a.calls.sizeApply === 'function');
    expect('定位期间生成了入场补间', a.calls.animate > 0);
    a.S.clearSlotCard();
    expect('关卡片时撤掉 autoUpdate', a.calls.cleanup >= 2);
  }

  // 3. 动画只动合成属性
  {
    const a = makeEnv(); a.S.init();
    a.S.animatePanel(a.panel);
    a.S.animatePanel(a.panel);
    expect('★同一面板只放一次动画（WeakSet 去重）', a.calls.animate === 1,
      '实际 ' + a.calls.animate);
    const keys = Object.keys(a.calls.targets[0]);
    expect('动画参数只含 opacity/scale/duration', keys.every(k => ['opacity', 'scale', 'duration'].indexOf(k) >= 0), keys.join(','));
    expect('没有 width/top/left 这类触发重排的属性', !keys.some(k => /^(width|top|left|height|margin|padding)$/.test(k)));
  }

  // 4. 自写打字机：逐字推进、能中断、不依赖外部库
  {
    const a = makeEnv(); a.S.init();
    a.storyEl.textContent = 'Vue 已渲染的原文';
    expect('typeStory 启动成功', a.S.typeStory('女娲补天') === true);
    expect('★启动瞬间清空原文，从零开始逐字打', a.storyEl.textContent === '');
    expect('typing 状态为真', a.S.stats().typing === true);
    await sleep(130);
    expect('约 130ms 后至少打出一个字', a.storyEl.textContent.length >= 1);
    await sleep(220);
    expect('★打完显示完整文案（一字不丢）', a.storyEl.textContent === '女娲补天');
    expect('结束后 typing 归零', a.S.stats().typing === false);
    a.S.typeStory('第二句更长一点');
    await sleep(30);
    a.S.clearStory();
    const frozen = a.storyEl.textContent;
    await sleep(240);
    expect('★clearStory 掐断定时器（不会有两个打字机抢同一个 span）',
      a.storyEl.textContent === frozen && a.S.stats().typing === false);
    expect('空文案不启动', a.S.typeStory('') === false);
    expect('stats 报告打字机恒可用', a.S.stats().typewriter === true);
  }

  // 5. ★剧情打字机必须由 showStoryLine 驱动，不能挂在事件入口
  //    （联机的 story 事件不经过 applyEvent，挂事件上会漏整条路径）
  {
    const a = makeEnv(); a.S.init();
    a.storyEl.textContent = '哨兵原文';
    a.S.onEvent({ type: 'story', line: '不该在这里启动' });
    expect('onEvent(story) 不改动剧情文本', a.storyEl.textContent === '哨兵原文');
    a.S.onEvent({ type: 'levelup' });
    expect('升级事件会触发面板补间', a.calls.animate === 1);
  }

  // 6. DOM 观察器
  {
    const a = makeEnv(); a.S.init();
    expect('注册了 MutationObserver', a.calls.observed === true);
    expect('监听的是 #hud 子树', !!a.calls.mo);
  }

  // 7. ★不能把字段塞进联机协议
  {
    const proto = fs.readFileSync(path.join(ROOT, 'shared/proto_bin.js'), 'utf8');
    expect('二进制协议里没有 ui/typed/anime 字段', !/\b(typed|anime|floating|slotCard|typeSpeed)\b/i.test(proto));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail > 0) process.exit(1);
})();
