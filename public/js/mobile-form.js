/*!
 * public/js/mobile-form.js —— 手机输入框聚焦时的「跳上跳下」修正（第二十九轮）
 *
 * 【症状】手机上点用户名/密码框，页面会先滚一下把框顶到可见处；键盘弹起后
 * 可视区变矮，浏览器发现框又被挡住了，于是**再滚一次**；切下一个框或失焦时
 * 还会往回滚 —— 玩家看到的就是页面在跳。
 *
 * 【为什么光靠 CSS 不够】已经做了两件 CSS 侧的事（见 theme.css）：
 *   ① 登录/注册屏把顶部横幅压到 72px，让整张表单基本进一屏，从根上减少滚动；
 *   ② `.input` 给了 scroll-margin-top/bottom，让浏览器第一次就滚到「键盘弹起后仍可见」的位置。
 * 但安卓 Chrome 与 iOS Safari 在键盘动画期间还会自己做一次「修正滚动」，
 * 两次修正叠在一起就是那一下明显跳动。所以这里再加一层**收尾**：
 * 键盘稳定之后（120ms 防抖）量一次「框是不是真的在可视区里」，
 * 不在就做**最小位移**的一次 scrollBy —— 不居中、不炫技，只补齐差值。
 *
 * 【三条克制】不这么写的话，这个脚本自己就会变成一个抖动源：
 *   ① 只在触摸设备上启用（pointer: coarse）；桌面滚轮场景完全不动。
 *   ② 只在「可视区比布局视口矮 80px 以上」时才认为键盘开着 —— 否则地址栏收起
 *      那种小变化也会触发修正，反而多滚一次。
 *   ③ 每次聚焦最多修 3 次，且框已经在可视区（留 14px 边）时一次都不做。
 */
(function (root) {
  'use strict';

  const doc = root.document;
  const vv = root.visualViewport;
  if (!doc || !vv) return;                     // 老浏览器：不支持就不动，保持原样
  if (!root.matchMedia || !root.matchMedia('(pointer: coarse)').matches) return;

  const KEYBOARD_MIN = 80;                     // 可视区矮这么多才算键盘挡着
  const EDGE = 14;                             // 框与可视区上下边至少留这么多
  const MAX_FIX = 3;                           // 每次聚焦最多修几次

  let focusGen = 0;
  let fixes = 0;
  let timer = 0;

  function isTextField(el) {
    if (!el) return false;
    const tag = String(el.tagName || '').toLowerCase();
    if (tag === 'textarea') return true;
    if (tag !== 'input') return false;
    const t = String(el.type || 'text').toLowerCase();
    return t === 'text' || t === 'password' || t === 'search' || t === 'tel' ||
      t === 'email' || t === 'number' || t === 'url';
  }

  // 键盘是否真的占走了空间
  function keyboardOpen() {
    return vv.height > 0 && (root.innerHeight - vv.height) > KEYBOARD_MIN;
  }

  function fixOnce() {
    const el = doc.activeElement;
    if (!isTextField(el)) return;
    if (!keyboardOpen()) return;
    if (fixes >= MAX_FIX) return;

    const r = el.getBoundingClientRect();
    // 可视区在「布局视口坐标系」里的上下边界（iOS 键盘弹出时 offsetTop 会变）
    const top = vv.offsetTop;
    const bottom = vv.offsetTop + vv.height;
    if (r.top >= top + EDGE && r.bottom <= bottom - EDGE) return;   // 已经看得见，别动

    let dy = 0;
    if (r.bottom > bottom - EDGE) dy = r.bottom - (bottom - EDGE);
    else if (r.top < top + EDGE) dy = r.top - (top + EDGE);
    if (!dy) return;

    fixes += 1;
    root.scrollBy(0, Math.round(dy));
  }

  function schedule(delay) {
    clearTimeout(timer);
    const gen = focusGen;
    timer = setTimeout(function () {
      if (gen !== focusGen) return;            // 这期间已经换过框了，丢掉这次
      fixOnce();
      // 键盘动画还没结束时高度还会变，再补一次量（仍然受 MAX_FIX 限制）
      timer = setTimeout(function () {
        if (gen !== focusGen) return;
        fixOnce();
      }, 160);
    }, delay);
  }

  doc.addEventListener('focusin', function (e) {
    if (!isTextField(e.target)) return;
    focusGen += 1;
    fixes = 0;
    schedule(220);                             // 键盘大约 250ms 弹完，220ms 后量
  }, true);

  vv.addEventListener('resize', function () {
    if (!isTextField(doc.activeElement)) return;
    schedule(120);
  });

  // 键盘弹出时 iOS 会把整个可视区上推，scroll 事件里也补一次（同样走防抖）
  vv.addEventListener('scroll', function () {
    if (!isTextField(doc.activeElement)) return;
    schedule(90);
  });

  // 调试口子：?debug=1 时能在控制台看到这套逻辑有没有在跑
  if (String(root.location && root.location.search).indexOf('debug=1') >= 0) {
    root.VS_MOBILE_FORM = {
      state: function () {
        return {
          active: doc.activeElement ? (doc.activeElement.className || doc.activeElement.tagName) : null,
          vvHeight: Math.round(vv.height),
          innerHeight: root.innerHeight,
          keyboard: keyboardOpen(),
          fixes: fixes
        };
      }
    };
    console.log('[mobile-form] 已启用（触摸设备）：聚焦输入框会做一次最小位移修正');
  }
})(typeof window !== 'undefined' ? window : this);
