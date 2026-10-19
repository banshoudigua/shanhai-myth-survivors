// public/js/pixel.js —— 像素点阵绘制引擎（纯前端，双端无关）
//
// 【为什么要有这个文件】整个游戏的画面在 2026-10-03 这一轮从「程序化矢量画」
// （一堆 arc / ellipse 拼出来的圆球加眼睛，远看像表情包）改成了**像素风**。
// 像素画的本质不是「画得糙」，而是**每个色块都落在同一个网格上** —— 只要有一处
// 按浮点坐标画，边缘就会糊成半透明的毛边，整个画面立刻「不像像素」。
// 所以这里把「对齐到格」这件事收成一个引擎，所有素材都走它。
//
// 素材长什么样：一组等长字符串，每个字符是一个调色板槽位。例如：
//     '..##..',
//     '.#++#.',
//     '.#oo#.',
// 读一眼就能看出图形 —— 这是选字符串矩阵而不是数字数组的原因：
// **改像素图是高频操作，可读性比紧凑更重要**（一个 16x16 的怪也就 16 行）。
//
// 三个必须守住的点（都是像素风成败的关键）：
//   ① 绘制坐标取整（`drawCentered` 里的 `Math.round`）—— 半像素 = 糊边；
//   ② 每格在**设备像素**上取整（`pxFor`）—— dpr=2 时 1.5 CSS 像素的格
//      正好落成 3 设备像素；若取 1.25，一块格子内部就有一半分到两个设备像素上，
//      渲染器会插值，边缘又是一圈灰；
//   ③ 主画布要关掉图像平滑（见 render.js 的 `imageSmoothingEnabled = false`），
//      否则 sprite 被缩放时照样插值。

(function (root) {
  'use strict';

  // ============================================================
  // 调色板槽位
  // ============================================================
  // 【为什么用符号而不是写死颜色】同一个形状要按「怪物配色 / 角色配色」重新上色
  //（腐尸是土黄褐、血蝠是暗红、骸骨是骨白，但骨架都是「一具身体」）。
  // 符号 → 颜色的映射在 paletteFor() 里按主色现算，素材表只描述形状。
  //
  // 槽位含义（写素材时只用这几个字符，别自创 —— 自创的字符会被当成透明）：
  //   .  透明      #  描边（最暗）    +  主色        =  主色提亮
  //   -  主色压暗  @  更深（阴影/底）  *  高光白      o  瞳孔
  //   x  血红      $  琥珀金          w  骨/牙白
  const SLOT = {
    '.': null,        // 透明
    '#': 'edge',
    '+': 'main',
    '=': 'light',
    '-': 'dark',
    '@': 'deep',
    '*': 'hi',
    'o': 'pupil',
    'x': 'blood',
    '$': 'gold',
    'w': 'bone'
  };

  // 与 render.js / player-art.js 里那套 lighten/darken 同义（这里自带一份，
  // 因为这个引擎要不依赖任何渲染文件就能被工具脚本单独加载）
  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function mix(hex, target, t) {
    const a = hexToRgb(hex), b = hexToRgb(target);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }
  function lighten(hex, t) { return mix(hex, '#ffffff', t); }
  function darken(hex, t) { return mix(hex, '#000000', t); }

  // 按主色生成一整套调色板。
  //
  // 【为什么 main 要提亮 10%】怪物/角色的配色是当「矢量填充色」调的，
  // 里面已经混过暗底（战场底色 #12141a 很暗）。同一批颜色直接拿来画像素块，
  // 实心面积比原来小（像素图形有留白、有描边），在暗底上会**整体偏暗一档**，
  // 远看就是「一坨看不清的东西」。提亮一点把亮度补回来，色相不变。
  //
  // 【为什么描边只压 50% 而不是 78%】描边是像素画的骨架线，压得太狠（原来的 0.78）
  // 对于本身就暗的配色（血月领主的深红、深渊主教的深灰蓝）会直接变成纯黑，
  // 在暗底战场上等于没画描边 —— 形状读不出来，怪就成了一团影子。
  function paletteFor(main, opts) {
    const o = opts || {};
    const body = o.keepMain ? main : lighten(main, 0.1);
    return {
      edge: o.edge || mix(darken(body, 0.5), '#1b1020', 0.35),
      main: body,
      light: lighten(body, o.light === undefined ? 0.42 : o.light),
      dark: darken(body, 0.28),
      deep: darken(body, 0.45),
      hi: o.hi || '#fdf8ec',
      pupil: o.pupil || '#1a1216',
      blood: o.blood || '#c93a3a',
      gold: o.gold || '#f2c14e',
      bone: o.bone || '#e8e0cc'
    };
  }

  // ============================================================
  // 绘制
  // ============================================================

  // 把矩阵按格画到 (x, y)（左上角），px = 每格边长（CSS 像素）
  // 同一行里连续同色的格子合并成一次 fillRect —— 一个 16x16 的素材
  // 大约 40~60 次调用，比逐格 256 次省一大截（精灵是一次性烘焙，但立绘
  // 与对照图会反复画，省下来的是实打实的）。
  function draw(g, art, x, y, px, pal) {
    const rows = art.length;
    for (let r = 0; r < rows; r++) {
      const row = art[r];
      let start = -1;
      let cur = null;
      for (let c = 0; c <= row.length; c++) {
        const key = c < row.length ? SLOT[row[c]] : undefined;
        const col = key ? (pal[key] || null) : null;
        if (col !== cur) {
          if (cur) g.fillStyle = cur;
          if (cur) g.fillRect(x + start * px, y + r * px, (c - start) * px, px);
          start = c;
          cur = col;
        }
      }
    }
  }

  // 以中心为锚点绘制（现有渲染层所有画法都是「给中心 + 半径」的签名，
  // 保持这个接口能让接入改动最小）。
  //
  // ★ Math.round 是整个像素风的关键：精灵最终会被 blit 到浮点坐标上，
  // 只要矩阵左上角不是整数像素，格边就会落在两个物理像素之间 → 渲染器插值
  // → 一圈半透明的灰边，整张图「发糊」。取整之后格边永远对齐物理像素。
  function drawCentered(g, art, cx, cy, px, pal) {
    const w = art[0].length, h = art.length;
    draw(g, art, Math.round(cx - w * px / 2), Math.round(cy - h * px / 2), px, pal);
  }

  // 每格边长：先用「希望占多宽」算出设备像素下的格宽，**取整**后再换算回 CSS。
  //   visualR —— 视觉半径相对碰撞半径的倍率（怪物画了手臂翅膀，视觉比碰撞体大）
  //   cols    —— 素材的格数（宽 = 高）
  // 例：r=11、16 格、dpr=2、visualR=2.6 → 希望宽 11*2.6*2=57 设备像素
  //     → 每格 57/16=3.57 → 取整 4 → 回到 CSS 是 2 → 成品宽 32 CSS 像素。
  function pxFor(r, cols, visualR, dpr) {
    const dev = Math.max(1, Math.round(r * (visualR || 2.6) * dpr / cols));
    return dev / dpr;
  }

  // ============================================================
  // 自检
  // ============================================================
  // 【为什么要自检】素材写错一列，画出来就是「怪物的头歪了一格」——
  // 不报错、不崩，只是难看，而且要盯着截图才能发现是哪一行错。
  // 这里在加载时就把「行列数不一致 / 用了未定义的字符 / 行首尾带空格」
  // 全部指出来，改起来是一眼的事。
  function validate(name, art) {
    const problems = [];
    if (!art || !art.length) return ['素材 ' + name + ' 是空的'];
    const w = art[0].length;
    for (let i = 0; i < art.length; i++) {
      const row = art[i];
      if (row.length !== w) {
        problems.push(name + ' 第 ' + i + ' 行长度 ' + row.length + '，应为 ' + w);
      }
      for (let c = 0; c < row.length; c++) {
        if (!(row[c] in SLOT)) {
          problems.push(name + ' 第 ' + i + ' 行第 ' + c + ' 列用了未知字符 "' + row[c] + '"');
        }
      }
    }
    // 四角留白：素材贴边会让描边被裁掉（像素画的描边也是画的一部分）
    const corners = [art[0][0], art[0][w - 1], art[art.length - 1][0], art[art.length - 1][w - 1]];
    for (let k = 0; k < corners.length; k++) {
      if (corners[k] !== '.') problems.push(name + ' 的四角必须留空（现在角上是 "' + corners[k] + '"）');
    }
    return problems;
  }

  function validateAll(table) {
    const problems = [];
    const names = Object.keys(table);
    for (let i = 0; i < names.length; i++) {
      problems.push.apply(problems, validate(names[i], table[names[i]]));
    }
    return problems;
  }

  root.VS = root.VS || {};
  root.VS.PIXEL = {
    SLOT: SLOT,
    paletteFor: paletteFor,
    draw: draw,
    drawCentered: drawCentered,
    pxFor: pxFor,
    lighten: lighten,
    darken: darken,
    mix: mix,
    validate: validate,
    validateAll: validateAll
  };

})(typeof window !== 'undefined' ? window : global);
