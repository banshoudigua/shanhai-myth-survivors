// 界面呈现增强层（第二十五轮 · ②）
//
// 各段分工，互不越界：
//   Floating UI  —— 技能说明卡相对技能区定位，自动翻转 / 避让视口
//   anime.js v4  —— 面板与浮层的进出（只动 transform/opacity，不碰 width/top 触发重排）
//   自写打字机   —— 剧情节拍逐字显现（见下方许可说明）
//   inkjs        —— 剧情回顾（见 VS.Storylines，③）
//
// ★为什么不引 Typed.js：它在 2026 年把许可从 MIT 换成了
//   **GPL v3 + 商业双许可**（仓库里新增 LIMITED/UNLIMITED_COMMERCIAL_LICENSE）。
//   本项目是公开仓库，GPL 有传染风险，所以这个「逐字显现」用自写的 30 行实现，
//   反而更好控制：中文逐字、可随时中断、不插光标节点、不跟 Vue 抢 DOM。
//
// ★这个模块是**纯增强**：任何一个库没加载、或者 DOM 还没长出来，
//   都要退回原来的 CSS 表现，绝不抛异常、绝不改 Vue 的状态。
// ★不碰三条白屏级坑：不设 align-items、不把 flex 项改成可压缩、不写内联 max-width。

(function (root) {
  'use strict';

  const VS = root.VS = root.VS || {};
  const F = root.FloatingUIDOM;
  const anime = root.anime;
  const doc = root.document;

  let inited = false;
  let cleanupPos = null;          // Floating UI autoUpdate 的取消函数
  let typeTimer = 0;              // 打字机定时器
  let typing = false;
  let observed = false;
  const animated = new WeakSet();
  let panelCount = 0;

  function q(sel) { return doc ? doc.querySelector(sel) : null; }

  // ---------------------------------------------------------------
  // 1. 技能说明卡：贴着技能区，而不是永远钉在左下角
  // ---------------------------------------------------------------
  // 原来 .slot-card 是 `left:18px; bottom:96px`，屏幕上点右上角的格子，
  // 说明却在左下角弹出来，视线要横穿整个战场。改成相对整块技能区定位：
  // 空间够就放上方，不够自动翻到下方，窄屏再用 shift 顶回视口内。
  function layoutSlotCard() {
    if (!F || !F.computePosition) return false;
    const card = q('.slot-card');
    // 技能区的真实类名是 .hud-slots（整块就是点击目标，见 game.html 的 onSlotsClick）
    const anchor = q('.hud-slots') || q('.slot-row') || q('#hud');
    if (!card || !anchor) return false;

    // 上一次的 autoUpdate 必须先撤，否则每次开关卡片都会多挂一组滚动监听
    if (cleanupPos) { cleanupPos(); cleanupPos = null; }

    const update = function () {
      F.computePosition(anchor, card, {
        strategy: 'absolute',
        placement: 'top-start',
        middleware: [
          F.offset(8),
          F.flip({ padding: 10 }),
          F.shift({ padding: 10 }),
          F.size({
            padding: 10,
            apply: function (o) {
              // 只限高，不写内联 max-width（那条会把媒体查询压死）
              card.style.maxHeight = Math.max(120, Math.floor(o.availableHeight)) + 'px';
            }
          })
        ]
      }).then(function (r) {
        // 原 CSS 的 bottom 会把 top 抵消掉，切到 JS 定位时必须显式清掉
        card.style.bottom = 'auto';
        card.style.left = Math.round(r.x) + 'px';
        card.style.top = Math.round(r.y) + 'px';
      });
    };
    update();
    if (F.autoUpdate) cleanupPos = F.autoUpdate(anchor, card, update);
    popIn(card, { scale: 0.97, duration: 170 });
    return true;
  }

  function clearSlotCard() {
    if (cleanupPos) { cleanupPos(); cleanupPos = null; }
    const card = q('.slot-card');
    if (card) { card.removeAttribute('style'); }
  }

  // ---------------------------------------------------------------
  // 2. anime.js v4：只做 transform / opacity 的轻补间
  // ---------------------------------------------------------------
  function popIn(el, opt) {
    if (!anime || !anime.animate || !el) return false;
    opt = opt || {};
    anime.animate(el, {
      opacity: [0, 1],
      scale: [opt.scale || 0.97, 1],
      duration: opt.duration || 200
    });
    return true;
  }

  // 面板里的按钮交错浮现。用 WeakSet 钉住「一个元素只做一次」，
  // 否则 Vue 在 HUD 高频更新时每次重绘都会把入场动画重放一遍。
  function animatePanel(panel) {
    if (!panel || animated.has(panel)) return;
    animated.add(panel);
    panelCount++;
    popIn(panel, { scale: 0.985, duration: 220 });
    if (!anime || !anime.animate || !anime.stagger) return;
    const btns = panel.querySelectorAll('.panel-actions .btn, .panel .choice');
    if (!btns.length) return;
    anime.animate(btns, {
      opacity: [0, 1],
      translateY: [6, 0],
      delay: anime.stagger(28, { start: 60 }),
      duration: 180
    });
  }

  function watchDom() {
    if (observed || !root.MutationObserver || !doc) return;
    const host = doc.getElementById('hud');
    if (!host) return;
    const mo = new root.MutationObserver(function (records) {
      for (let i = 0; i < records.length; i++) {
        const added = records[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const n = added[j];
          if (n.nodeType !== 1) continue;
          if (n.classList && n.classList.contains('panel')) animatePanel(n);
          const inner = n.querySelectorAll ? n.querySelectorAll('.panel') : [];
          for (let k = 0; k < inner.length; k++) animatePanel(inner[k]);
          if (n.classList && n.classList.contains('toast')) popIn(n, { scale: 0.94, duration: 160 });
        }
      }
    });
    mo.observe(host, { childList: true, subtree: true });
    observed = true;
  }

  // ---------------------------------------------------------------
  // 3. 剧情节拍逐字显现（自写，不引 GPL 的 Typed.js）
  // ---------------------------------------------------------------
  // ★Vue 仍然把 ui.storyLine 渲染进 .sb-text：打字机被打断 / 元素不存在时，
  //   文案照常完整显示 —— 这是刻意保留的降级路径，绝不为了动画把文字弄丢。
  //   打字机只在本帧把那串文本清空重打，Vue 后续若覆盖回去也只是显示全文。
  const TYPE_SPEED = 46;          // 毫秒/字；中文一句 15~20 字约 0.8 秒，远小于 6 秒横条
  function clearStory() {
    if (typeTimer) { root.clearTimeout(typeTimer); typeTimer = 0; }
    typing = false;
  }

  function typeStory(line) {
    if (!line) return false;
    const el = q('.story-beat .sb-text');
    if (!el) return false;
    clearStory();                 // 新一句先掐掉上一句的定时器，别出现两个打字机抢同一个 span
    typing = true;
    el.textContent = '';
    let i = 0;
    const step = function () {
      i++;
      el.textContent = line.slice(0, i);
      if (i < line.length) typeTimer = root.setTimeout(step, TYPE_SPEED);
      else { typeTimer = 0; typing = false; }
    };
    typeTimer = root.setTimeout(step, 60);
    return true;
  }

  // ---------------------------------------------------------------
  // 4. 事件入口 + 初始化
  // ---------------------------------------------------------------
  function onEvent(e) {
    if (!e || !e.type) return;
    // ★剧情打字机不挂在这里：联机的 story 事件不经过 applyEvent，
    //   而是直接调 game.js 的 showStoryLine()。挂事件上会漏掉整条联机路径，
    //   所以统一由 showStoryLine 驱动（单机与联机都会走它）。
    if (e.type === 'levelup' || e.type === 'dead' || e.type === 'won' || e.type === 'timeout') {
      if (root.Vue && root.Vue.nextTick) root.Vue.nextTick(function () {
        const p = q('.overlay .panel');
        if (p) animatePanel(p);
      });
    }
  }

  function init() {
    if (inited) return stats();
    inited = true;
    watchDom();
    const p = q('.overlay .panel');
    if (p) animatePanel(p);
    return stats();
  }

  function stats() {
    return {
      ready: inited,
      floating: !!(F && F.computePosition),
      anime: !!(anime && anime.animate),
      typewriter: true,           // 自写实现，恒可用（不依赖外部库）
      ink: !!(VS.Storylines && VS.Storylines.ready),
      positioned: !!cleanupPos,
      panelAnimations: panelCount,
      typing: typing
    };
  }

  VS.UiFx = {
    init: init, onEvent: onEvent, typeStory: typeStory, clearStory: clearStory,
    layoutSlotCard: layoutSlotCard, clearSlotCard: clearSlotCard,
    animatePanel: animatePanel, stats: stats
  };
})(window);
