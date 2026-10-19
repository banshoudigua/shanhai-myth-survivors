// shared/avatars.js —— 玩家头像图标集（双端共用）
//
// 【为什么不给玩家传图片】头像是要跟着每条网络消息走的：大厅在线列表、候场室成员、
// 对局名单里都得带上。传图片 URL 或 base64 会让包体暴涨，还会引入图片存储与审核。
// 所以做法是「内置图标集 + 只传一个短 id（如 'shield'）」—— 一个头像只占几个字节，
// 两端用同一份定义各自渲染，天然一致。
//
// 【为什么要放在 shared/】服务端要校验玩家传来的 id 是否合法（白名单），
// 前端要用同一份数据渲染。放两份迟早会漂移。
//
// 每个图标都是 24x24 坐标系下的单段闭合路径，同时满足两种渲染方式：
//   · 网页里内联 <svg><path d="..." fill="..."/></svg>
//   · Canvas 里 fill(new Path2D(d))（队友头顶名牌是画在画布上的）
// 统一用 fill-rule="evenodd"，这样「钥匙」这类带内孔的图形能正确挖空。
// 配色沿用项目基调（暗红 / 琥珀金 / 冷灰），刻意避开紫色系。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VS = root.VS || {};
    root.VS.AVATARS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // id 用短英文单词（要进数据库、要走网络，别用中文）
  const LIST = [
    { id: 'shield', name: '铁盾', color: '#c93a3a', path: 'M12 2 L20 5.5 V12 C20 17.5 16.5 21 12 22 C7.5 21 4 17.5 4 12 V5.5 Z' },
    { id: 'sword',  name: '长剑', color: '#e8dcc0', path: 'M12 1 L14.2 11 L12 14.5 L9.8 11 Z M8.5 14.5 H15.5 V17 H8.5 Z M11 17 H13 V23 H11 Z' },
    { id: 'moon',   name: '残月', color: '#f2c14e', path: 'M15 2 A10 10 0 1 0 15 22 A7.5 7.5 0 1 1 15 2 Z' },
    { id: 'star',   name: '晨星', color: '#d9a441', path: 'M12 2.5 L14.7 9.2 L21.8 9.7 L16.4 14.4 L18.1 21.3 L12 17.5 L5.9 21.3 L7.6 14.4 L2.2 9.7 L9.3 9.2 Z' },
    { id: 'flame',  name: '火焰', color: '#d8763a', path: 'M12 2 C13.5 6.5 18 8.5 18 14 A6 6 0 0 1 6 14 C6 10 9 8 12 2 Z' },
    { id: 'leaf',   name: '枯叶', color: '#6b8fa3', path: 'M20.5 3.5 C11 3.5 4.5 8.5 4.5 16.5 C4.5 18.5 5.5 20.5 5.5 20.5 C8.5 13.5 13.5 9 20.5 3.5 Z' },
    { id: 'bolt',   name: '紫电', color: '#f4e4b8', path: 'M13.5 1.5 L5 13 H11 L10 22.5 L19 10.5 H12.5 Z' },
    { id: 'drop',   name: '血滴', color: '#8f2f2f', path: 'M12 2 C12 2 4.5 10 4.5 15 A7.5 7.5 0 0 0 19.5 15 C19.5 10 12 2 12 2 Z' },
    { id: 'crown',  name: '王冠', color: '#e0b64e', path: 'M2.5 19 L4.5 7 L9 11.5 L12 5 L15 11.5 L19.5 7 L21.5 19 Z' },
    { id: 'eye',    name: '夜瞳', color: '#8fa3b8', path: 'M12 6 C17.5 6 22 12 22 12 C22 12 17.5 18 12 18 C6.5 18 2 12 2 12 C2 12 6.5 6 12 6 Z M12 8.5 A3.5 3.5 0 1 1 12 15.5 A3.5 3.5 0 0 1 12 8.5 Z' },
    { id: 'key',    name: '旧钥', color: '#b4b2a9', path: 'M15.5 2 A6.5 6.5 0 1 0 15.5 15 A6.5 6.5 0 0 0 15.5 2 Z M15.5 6.5 A2.5 2.5 0 1 1 15.5 11.5 A2.5 2.5 0 0 1 15.5 6.5 Z M10.5 12 L2 20.5 V23 H4.5 V20.5 H7 V18 H9.5 Z' },
    { id: 'cross',  name: '圣痕', color: '#e05a5a', path: 'M9.5 2 H14.5 V9.5 H22 V14.5 H14.5 V22 H9.5 V14.5 H2 V9.5 H9.5 Z' }
  ];

  const BY_ID = Object.create(null);
  for (let i = 0; i < LIST.length; i++) BY_ID[LIST[i].id] = LIST[i];

  // 取头像定义。传了不认识/为空的 id 就回落到第一个，
  // 保证调用方永远拿得到能画的东西（少一处判空就少一处崩溃）。
  function get(id) {
    return BY_ID[id] || LIST[0];
  }

  function isValid(id) {
    return typeof id === 'string' && Object.prototype.hasOwnProperty.call(BY_ID, id);
  }

  // 按一个稳定的数字（座位号 / userId）分配默认头像，让同屏的人尽量不撞款。
  function pickFor(seed) {
    const n = Number(seed);
    const idx = Number.isFinite(n) ? Math.abs(Math.floor(n)) % LIST.length : 0;
    return LIST[idx].id;
  }

  // ---------- Canvas 渲染 ----------
  // Path2D 按 id 缓存：队友名牌每帧都要画，每帧 new 一个 Path2D 是白白烧 CPU。
  const pathCache = Object.create(null);

  function path2d(id) {
    if (typeof Path2D === 'undefined') return null;   // 非浏览器环境（服务端 require 本文件）直接跳过
    const key = get(id).id;
    if (!pathCache[key]) pathCache[key] = new Path2D(get(key).path);
    return pathCache[key];
  }

  // 在画布上画一个头像，中心 (x, y)，外接正方形边长 size
  function paint(ctx, id, x, y, size) {
    const p = path2d(id);
    if (!p) return false;
    const def = get(id);
    const s = size / 24;                 // 图标坐标系是 24x24
    ctx.save();
    ctx.translate(x - size / 2, y - size / 2);
    ctx.scale(s, s);
    ctx.fillStyle = def.color;
    ctx.fill(p, 'evenodd');
    ctx.restore();
    return true;
  }

  // ---------- HTML 渲染 ----------
  // 给 Vue 用：返回一段可以直接 v-html 的 svg 字符串。
  // 内容全部来自本文件的常量，不含任何用户输入，所以没有注入风险。
  function svg(id, size) {
    const a = get(id);
    const px = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + px + '" height="' + px +
      '" aria-hidden="true"><path d="' + a.path + '" fill="' + a.color +
      '" fill-rule="evenodd"/></svg>';
  }

  // ---------- 本地存储（浏览器端） ----------
  //
  // 【键必须放 sessionStorage，不能只放 localStorage】这是踩过两次的同一类坑。
  // localStorage 是**同一浏览器所有标签页共享**的，而同机开两个窗口对测多人
  // 是最常见的测法：第二个窗口选头像会把第一个的值覆盖掉，于是两人跳进对局时
  // 握手都上报同一个 id —— 表现就是「大家选了不同图标，游戏里图标却一模一样」。
  // 同类的昵称/角色早已改用 sessionStorage['vs_match']，这里跟上。
  //
  // 分工：
  //   sessionStorage —— 本窗口的身份（权威，握手就用它）
  //   localStorage   —— 「上次选过什么」的偏好，只用来给新开的窗口一个初值
  // 服务端 require 本文件时没有这两个对象，所以全部带环境判断。
  const STORE_KEY = 'vs_avatar';

  // 取一个可用的存储对象（sessionStorage / localStorage）。
  //
  // 【这里踩过一个很隐蔽的坑，务必照这个写法】第一版写的是外层 UMD 的那个 `root`
  // （`typeof self !== 'undefined' ? self : this`），以为它就是 window。**并不是**：
  // 那个 `root` 是外层 IIFE 的形参，而工厂函数是作为**调用实参**写在外层作用域里的，
  // 它的闭包链是「工厂 → 模块作用域 → 全局」，中间没有那个形参 —— 也就是说
  // **工厂里根本没有 `root` 这个名字**。于是 `root[name]` 抛 ReferenceError，
  // 又被这里的 try/catch 吞掉，表现成「save() 调用成功、什么都没写、也不报错」。
  // 症状：点头像选中态会变，可一刷新就回默认值，进对局后图标还可能与队友重复。
  //
  // 现在从 **globalThis** 现场取，并检查 API 形状（有 getItem/setItem 才认）。
  // Node 下 globalThis 没有 sessionStorage，自然返回 null，不需要额外环境判断。
  function storageOf(name) {
    try {
      if (typeof globalThis === 'undefined') return null;
      const s = globalThis[name];
      if (!s) return null;
      return (typeof s.getItem === 'function' && typeof s.setItem === 'function') ? s : null;
    } catch (e) {
      return null;   // 隐私模式 / 被策略禁用时会抛
    }
  }

  // 读本窗口该用的头像：优先本窗口选过的，其次上次的偏好
  function readSaved() {
    const ss = storageOf('sessionStorage');
    if (ss) {
      const v = ss.getItem(STORE_KEY);
      if (v) return v;
    }
    const ls = storageOf('localStorage');
    if (ls) {
      const v2 = ls.getItem(STORE_KEY);
      if (v2) return v2;
    }
    return '';
  }

  // 存头像：两处都写。写 sessionStorage 是「钉住本窗口的身份」，
  // 写 localStorage 是「下次新开窗口记得我上次选的」。
  function save(id) {
    const ss = storageOf('sessionStorage');
    if (ss) {
      try { ss.setItem(STORE_KEY, id); } catch (e) { /* 配额/隐私模式 */ }
    }
    const ls = storageOf('localStorage');
    if (ls) {
      try { ls.setItem(STORE_KEY, id); } catch (e) { /* 配额/隐私模式 */ }
    }
  }

  return {
    LIST: LIST,
    ids: LIST.map(function (a) { return a.id; }),
    DEFAULT_ID: LIST[0].id,
    get: get,
    isValid: isValid,
    pickFor: pickFor,
    paint: paint,
    svg: svg,
    STORE_KEY: STORE_KEY,
    readSaved: readSaved,
    save: save
  };
});
