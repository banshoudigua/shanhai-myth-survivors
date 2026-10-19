// public/js/nav.js —— 站点导航（History API 的前端那一半）
//
// ============================================================
// 这一整个文件只解决一件事：**返回大厅时不要把整个站「顶掉」**
// ============================================================
//
// 【原来的做法有什么问题】
// 旧代码回大厅一律 `window.location.href = '/'` —— 那是**在历史栈上再压一条**。
// 于是「大厅 → 对局 → 返回大厅」之后历史栈是：
//     [大厅] [对局] [大厅]
// 玩家再按一次返回/左箭头，浏览器就把他送回**那个已经结束的对局**；
// 想真正退出站点，得连按好几次，越按越乱。这就是「返回会关闭整个站」的由来
// —— 不是关，是弹。
//
// 【History API 怎么解】
// 大厅 → 对局：真的换文档（两个页面是独立的 HTML + 各自的 Vue 实例，没法合并），
//           这条用 `location.assign`，正常压栈。
// 对局 → 大厅：改用 `history.back()` —— 退回**来时那一条**，不新增历史项。
//           栈保持 [大厅] [对局] → back 之后剩 [大厅]，再按返回才真的离开站点。
//
// ★为什么不用「pushState 把地址栏改成 /game」
//   History API 里的 pushState/replaceState **只改地址栏、不发请求**。
//   它适合「同一个文档内的视图切换」，而这里是两个文档（大厅 / 对局页各有独立的
//   script 与 Vue 实例，game.js 有 13 万行，塞进同一个文档会与大厅的全局变量打架）。
//   所以这里只用 History API 的**语义**（back 而不是新压一条），
//   地址也仍然是真实导航。**pushState 那部分留给真正的视图切换再用。**
//
// 【为什么路由叫 /game 而不是 /game.html】
//   地址栏里露着实现文件名很业余（截图分享出去就现原形）。
//   服务端 router.js 的 PAGE_ALIAS 把 /game 映射到 game.html，
//   ★而 /game.html 本身继续保留 —— 19 个 tools/*.js 回归脚本直接拼这个路径
//   访问真实磁盘文件，改掉等于一次废掉整套测试。

(function () {
  'use strict';

  // 标记「本标签页是从大厅进来的」。用 sessionStorage 而不是 history.state：
  //   两者都不跨文档传递不了的话，sessionStorage 至少在**同一标签页**里可靠，
  //   而「是不是同一个标签页」正是这里要判断的东西（见 backToLobby 的注释）。
  const FROM_KEY = 'vs_nav_from_lobby';

  // ============================================================
  // 组地址
  // ============================================================

  // 把 { map:'grass', room:'AB12' } 组成 '/game?map=grass&room=AB12'
  // 空值直接丢掉 —— 这样调用方不必到处写 if。
  function gameUrl(params) {
    const q = [];
    Object.keys(params || {}).forEach(function (k) {
      const v = params[k];
      if (v === undefined || v === null || v === '') return;
      q.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    });
    return '/game' + (q.length ? '?' + q.join('&') : '');
  }

  // ============================================================
  // 大厅 → 对局
  // ============================================================

  // 这里**必须**是真正的整页跳转（location.assign），不是 pushState：
  // 对局页有自己的一整套脚本与 Vue 实例，跟大厅页不是同一个文档。
  // 顺手记下来路，给 backToLobby 判断能不能 back。
  function enterGame(params) {
    markFromLobby();
    const url = gameUrl(params);
    console.log('[nav] 进入对局 ' + url);
    window.location.assign(url);
  }

  // ============================================================
  // 对局 → 大厅（核心）
  // ============================================================

  // 返回大厅。返回 true 表示走了 history.back()，false 表示走了整页替换。
  function backToLobby(why) {
    const fromLobby = clearFromLobby();

    // ★两条路都要能走通，分支条件是「有没有来路可退」：
    //   有（正常的大厅→对局）→ history.back()，栈不增长，浏览器返回键立刻干净；
    //   没有（扫码、收藏、手输 /game 直接进来的）→ replace 到大厅。
    //     这里**必须用 replace 而不是 assign**：用 assign 的话，
    //     玩家按返回又会回到这个已经结束的对局 —— 正是本次要消灭的那个毛病。
    if (fromLobby && window.history && window.history.length > 1) {
      console.log('[nav] 返回大厅（history.back，' + (why || '按钮') + '）');
      window.history.back();
      return true;
    }

    console.log('[nav] 返回大厅（replace，本页无来路：' + (why || '按钮') + '）');
    window.location.replace('/');
    return false;
  }

  // ============================================================
  // 来路标记
  // ============================================================

  function markFromLobby() {
    try { sessionStorage.setItem(FROM_KEY, '1'); } catch (e) { /* 隐私模式，忽略 */ }
  }

  // 读出来并**立刻清掉**：
  // 标记只能被消费一次。否则「大厅→对局→back→对局→back」第二圈就会因为
  // 标记还在而一直走 back，一旦中途在游戏页按了刷新，这个标记还在，
  // 返回就会退到刷新前的那个对局页 —— 越绕越深。
  function clearFromLobby() {
    try {
      const v = sessionStorage.getItem(FROM_KEY) === '1';
      sessionStorage.removeItem(FROM_KEY);
      return v;
    } catch (e) {
      return false;
    }
  }

  // ============================================================
  // 页面生命周期
  // ============================================================
  //
  // 【为什么这里不做 bfcache 恢复，而要交给大厅页自己处理】
  // 只有大厅页需要（对局页回来时世界已经在服务端推进完了，恢复它反而有害）。
  // 而这个文件是被两个页面共用的 —— 在这里写「重连大厅」就得反过来依赖
  // lobby.js 的调试句柄（那个句柄还只在 ?debug=1 时才挂），
  // 于是「导航模块反过来依赖页面内部实现」。所以这里只暴露一个注册口，
  // 由大厅页自己决定恢复时做什么。依赖方向单向，才不会以后互相绊住。

  // 注册「页面从 bfcache 回来」的回调（只会被调用一次，在首次加载时不会触发）。
  function onBfcacheRestore(fn) {
    if (typeof window.addEventListener !== 'function') return;

    window.addEventListener('pageshow', function (ev) {
      // ★必须判 persisted：普通首次 load 时 persisted 是 false，
      // 而那一刻 mounted 已经连过一次了，再连就成了「同一个人在线两次」。
      if (!ev.persisted) return;
      console.log('[nav] 从 bfcache 恢复');
      // 放到下一帧再调：bfcache 恢复的 pageshow 与页面脚本的执行顺序不保证，
      // 立刻调用可能撞上还没初始化完的状态。
      window.setTimeout(function () { fn(); }, 0);
    });

    // 兜底：手机上把 App 切走再切回来（后台驻留）有时不走 pageshow，
    // 只走 visibilitychange。两个事件都接上，恢复逻辑只写一份。
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      fn();
    });
  }

  window.VS = window.VS || {};
  window.VS.NAV = {
    gameUrl: gameUrl,
    enterGame: enterGame,
    backToLobby: backToLobby,
    onBfcacheRestore: onBfcacheRestore
  };
})();