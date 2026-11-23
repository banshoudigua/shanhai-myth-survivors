// public/js/character-portraits.js —— 角色头像美化
//
// 为4个角色绘制独特的头像，用于选择界面展示。
// 每个头像都有独特的视觉特征，增强辨识度和美观度。

(function (root) {
  'use strict';

  const TAU = Math.PI * 2;

  // ============================================================
  // 配色与工具函数
  // ============================================================
  // 【key 必须与 shared/const.js 的 CHARACTERS.id 完全一致】
  // 这里原来写的是 'smith'，而 const.js 里叫 'blacksmith' —— 两边对不上，
  // 结果是铁匠的立绘一直拿到默认色（猎魔人的米白），谁也没发现
  //（立绘函数本身会画，只是颜色不对，看起来像"设计成这样"）。
  // 加角色时先对一遍 id。

  // ============================================================
  // 角色调色板（马卡龙色系）
  // ============================================================
  // 与 public/js/player-art.js 的 PALETTE **同名同结构**（main/dark/deep/soft），
  // 因为选择页的立绘与战场上的小人必须是同一个色系 —— 否则「选的时候是奶黄，
  // 打起来变成灰的」，玩家会以为选错了角色。
  //
  // ★ 色值在三个文件里各有一份（这里是选择页的、player-art.js 是战场上的、
  //   shared/const.js 的 accent 是主色源头）。改一个必须改三个，
  //   tools/artshot.js 有断言逐角色比对，漏改会被拦下。
  //
  // 换掉旧那套的原因：米白/象牙白、冷银灰/冷灰蓝、暗褐灰/土黄 两两几乎一样，
  // 8 个角色在选择界面里看着像 4 个。
  const CHARACTER_PALETTE = {
    // 暖区三档靠明度分开：亮粉 → 中暗棕 → 亮奶白
    hunter:     { main: '#F09A93', dark: '#A8554C', deep: '#7E3A34', soft: '#F8C4BD' },  // 蜜桃珊瑚
    blacksmith: { main: '#B8834F', dark: '#6E4A26', deep: '#4E3419', soft: '#D6AC80' },  // 焦糖拿铁
    nun:        { main: '#F5E4AC', dark: '#A3925A', deep: '#7C6E3F', soft: '#FCF3D6' },  // 香草奶油
    // 冷区是「深绿 / 浅青 / 深蓝」夹心，浅青两侧都压深才分得开
    scholar:    { main: '#7FBF7A', dark: '#3F7A44', deep: '#2C5A32', soft: '#A9DCA4' },  // 抹茶绿
    thief:      { main: '#86D6C3', dark: '#35706A', deep: '#24514C', soft: '#B0E8DA' },  // 薄荷青
    knight:     { main: '#6FA8DC', dark: '#35638F', deep: '#24476B', soft: '#A3CBEC' },  // 雾天蓝
    // 黄绿与莓果各自独占一段色相
    monk:       { main: '#B8CE6E', dark: '#6B7D34', deep: '#4C5A22', soft: '#D8E6A4' },  // 嫩芽黄绿
    witch:      { main: '#C2607E', dark: '#8A3A4C', deep: '#6B2F3F', soft: '#DC94AD' }   // 莓果红
  };

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mixHex(hex, target, t) {
    const a = hexToRgb(hex);
    const b = hexToRgb(target);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }

  function lighten(hex, t) { return mixHex(hex, '#ffffff', t); }
  function darken(hex, t) { return mixHex(hex, '#000000', t); }

  function dot(g, x, y, r, color) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  function bodyGrad(g, cx, cy, r, color) {
    const grd = g.createRadialGradient(cx - r * 0.35, cy - r * 0.42, r * 0.1, cx, cy, r * 1.08);
    grd.addColorStop(0, lighten(color, 0.45));
    grd.addColorStop(0.55, color);
    grd.addColorStop(1, darken(color, 0.45));
    return grd;
  }

  // ============================================================
  // 立绘（像素画，与战场形象共用同一批矩阵）
  // ============================================================
  // 【为什么立绘不再单独画一套】以前战场一套、选择页一套，两边各自硬编码颜色与
  // 形状 —— 改一次配色要同步三个文件、改一次形体要同步两套画法，而且很容易做成
  // 「选择页是奶黄、打起来是灰的」。现在两处都读 PLAYER_ART 的同一批 16×16 矩阵，
  // 立绘只是把格宽放大到 9~10 像素：形体与配色天然一致，也不再有漏改的可能。
  //
  // 放大之后像素格很大，这本身就是「像素风立绘」该有的样子 —— 千万别在这里
  // 开图像平滑，否则格子边缘会被插值成灰边，立刻退化成「模糊的小图」。
  //
  // 背景那圈柔和光晕是唯一**非像素**的元素，故意留着：暗底上主体容易被背景吞掉，
  // 一圈同色系的淡光能把头像托出来，而且它是纯色块、没有锐利边缘，
  // 不会和主体的像素边打架。

  const PORTRAIT_IDS = ['hunter', 'nun', 'scholar', 'blacksmith', 'knight', 'thief', 'witch', 'monk'];

  // 立绘主体。返回 true 表示画成功了（引擎或素材缺失时返回 false，调用方可兜底）。
  function paintPixelPortrait(g, charId, cx, cy, r) {
    const PA = root.VS && root.VS.PLAYER_ART;
    const PXm = root.VS && root.VS.PIXEL;
    if (!PA || !PA.paintScaled || !PXm) return false;

    // 背景光晕（主色，很淡）
    const main = (CHARACTER_PALETTE[charId] || CHARACTER_PALETTE.hunter).main;
    const c = hexToRgb(main);
    g.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0.16)';
    g.beginPath();
    g.arc(cx, cy, r * 1.42, 0, TAU);
    g.fill();

    // 主体：格宽取整。r*2 是画布可用直径，留 8% 边距免得帽子顶到框。
    const px = Math.max(4, Math.floor(r * 2 * 0.92 / 16));
    PA.paintScaled(g, charId, cx, cy, px);
    return true;
  }

  // 8 个立绘统一走像素画（矩阵与战场共用）。
  // 用循环生成而不是手写 8 个函数：以后再加角色只需要往 PORTRAIT_IDS 里补 id，
  // 不会再出现「加了角色忘了写立绘」那种漏。
  const PortraitPainters = {};
  for (let i = 0; i < PORTRAIT_IDS.length; i++) {
    (function (id) {
      PortraitPainters[id] = function (g, cx, cy, r) {
        paintPixelPortrait(g, id, cx, cy, r);
      };
    })(PORTRAIT_IDS[i]);
  }

  function createCharacterPortrait(charId, size = 200) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');

    const r = size * 0.35;
    const cx = size / 2;
    const cy = size / 2;
    const pal = CHARACTER_PALETTE[charId] || CHARACTER_PALETTE.hunter;

    // 背景
    g.fillStyle = 'transparent';
    g.fillRect(0, 0, size, size);

    // 绘制头像
    const painter = PortraitPainters[charId];
    if (painter) {
      painter(g, cx, cy, r, pal);
    }

    return canvas;
  }

  // 获取角色的头像数据URI（用于<img>或背景图）
  function getCharacterPortraitDataURI(charId, size = 200) {
    return createCharacterPortrait(charId, size).toDataURL('image/png');
  }

  // ============================================================
  // AI 生成的像素立绘（public/img/char/<角色id>.png）
  // ============================================================
  // 【为什么加这一层】原来 8 个角色的脸是**代码一笔一笔画**出来的（PortraitPainters），
  //   好处是零加载、配色可校验、离线可用；缺点是「怎么改都像简笔画」——
  //   而立绘是角色选择页上玩家第一眼看到的东西，值的更高。
  //   所以：**优先画真图，图没加载出来才回落代码版**。
  //
  // ★为什么保留代码版而不是删掉：
  //   ① 图片加载是异步的，Vue 挂载那一刻图多半还没到 —— 不兜底的话先白一下再出图；
  //   ② 图 404（发布漏文件 / CDN 抽风）时，兜底让它显示成程序化头像而不是空白方块；
  //   ③ tools/artshot.js 有断言在比对「本模块的调色板 / const.js 的 accent /
  //      战场画法」三处一致 —— 那条断言守的是**战场上的小人**（player-art.js），
  //      删掉这里的调色板就守不住了。本模块的立绘与战场小人的色系一致性由此保证。
  //
  // 【图片规格】320×320、65 色 PNG（约 40–55 KB/张），显示 160×160（2 倍余量，高分屏不糊）。
  //   容器是 160×160 的**圆形**（CSS border-radius + overflow:hidden），方图被裁成圆。
  const PORTRAIT_IMG = {
    hunter: '/img/char/hunter.png',
    blacksmith: '/img/char/blacksmith.png',
    nun: '/img/char/nun.png',
    scholar: '/img/char/scholar.png',
    knight: '/img/char/knight.png',
    thief: '/img/char/thief.png',
    witch: '/img/char/witch.png',
    monk: '/img/char/monk.png'
  };

  // 已加载的图片缓存：id → HTMLImageElement（load 已结束）
  const imgCache = Object.create(null);
  const inflight = Object.create(null);

  function loadPortraitImg(charId, onReady) {
    const src = PORTRAIT_IMG[charId];
    if (!src) return false;

    if (imgCache[charId]) { onReady(imgCache[charId]); return true; }

    // 已经在飞：挂进同一个队列，别重复发起（同一个角色可能被画十几次）
    if (inflight[charId]) { inflight[charId].push(onReady); return true; }
    inflight[charId] = [onReady];

    const im = new Image();
    im.onload = function () {
      imgCache[charId] = im;
      const list = inflight[charId];
      delete inflight[charId];
      list.forEach(function (fn) { fn(im); });
    };
    im.onerror = function () {
      // 失败只记一次日志：同一个角色会被回调十几次，
      // 每个都打一行会把控制板刷爆，反而把真正的错误淹掉。
      console.warn('[portrait] 立绘图加载失败，保持程序化头像：' + src);
      const list = inflight[charId];
      delete inflight[charId];
      list.forEach(function (fn) { fn(null); });
    };
    im.src = src;
    // ★返回 **false**：图片是刚**发起**加载、还没到。
    //   返回 true 会让调用方以为「已经画好了」而跳过兜底绘制 ——
    //   于是 canvas 先是空的，等图到了才被填上，而那中间的空白正好被截图抓到
    //   （artshot 截到 8 个空框，却因为 isLoaded 都为 true 而全绿）。
    return false;
  }

  // 直接在提供的 canvas 上绘制头像
  function renderPortrait(canvas, charId, size) {
    size = size || 160;
    if (!canvas || canvas.nodeName !== 'CANVAS') return;
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) return;

    // 清空背景（重画时不叠上一帧）
    g.clearRect(0, 0, size, size);

    // ★直接画战场原角色形象 —— 这是玩家真正在战场上操控的那张 16×16 像素小人。
    // 【为什么不再用 AI 图】选择页原来加载 /img/char/*.png（AI 生成的神话立绘），
    //   但那是另一套形象：选的时候是精雕细描的神明，进战场变成 Q 版点阵小人，
    //   玩家反馈「看不出这是同一个角色」。现在两条路共用 player-art.js 的
    //   CHAR_ART 矩阵 + 调色板 —— 所见即所得，选完进去就是这个人。
    // ★不用异步加载：矩阵是纯数据、paintScaled 同步画完，第一帧就有图，
    //   也没有「图挂了悄悄回落成兜底版」那条静默坑。
    const PA = root.VS && root.VS.PLAYER_ART;
    if (PA && PA.has(charId)) {
      // 16 格铺进 size：取整数格宽（像素风硬要求），size=160 → 每格 10px。
      const px = Math.max(1, Math.floor(size / 16));
      PA.paintScaled(g, charId, size / 2, size / 2, px);
      return;
    }

    // ---- 兜底：战场素材未加载时退回程序化头像（离线/旧缓存也不会白框） ----
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 * 0.9;
    const pal = CHARACTER_PALETTE[charId] || CHARACTER_PALETTE.hunter;
    const painter = PortraitPainters[charId];
    if (painter) painter(g, cx, cy, r, pal);
  }

  // 导出
  root.VS = root.VS || {};
  root.VS.createCharacterPortrait = createCharacterPortrait;
  root.VS.getCharacterPortraitDataURI = getCharacterPortraitDataURI;
  root.VS.PortraitPainters = PortraitPainters;
  root.VS.renderPortrait = renderPortrait;
  root.VS.CharacterPortraits = {
    // 调色板对外暴露是**为了自检**（artshot.js 拿它跟 const.js 的 accent、
    // 战场画法的 PALETTE 逐角色比对），不是为了运行期取色
    colors: CHARACTER_PALETTE,
    renderPortrait: renderPortrait,
    createCharacterPortrait: createCharacterPortrait,
    getCharacterPortraitDataURI: getCharacterPortraitDataURI,
    // 保留 AI 图地址表仅供调试追溯；选择页已不再加载这些图（见 renderPortrait）。
    images: PORTRAIT_IMG,
    // 语义改为「这张脸有战场素材可画」——不再是「AI 图下载完了」。
    // artshot 用它做截图前的前置断言，必须指向真正决定画面的那条路径。
    isLoaded: function (charId) {
      const PA = root.VS && root.VS.PLAYER_ART;
      return !!(PA && PA.has(charId));
    }
  };

})(typeof window !== 'undefined' ? window : global);
