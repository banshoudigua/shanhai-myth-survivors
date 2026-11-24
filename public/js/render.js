// public/js/render.js —— Canvas 2D 渲染层
//
// 职责边界：只读世界状态并画出来，绝不修改任何游戏数据。
// 唯一允许写在渲染器自己身上的东西：精灵缓存、浮字池、动画时钟 —— 都跟世界状态无关。
//
// 配色：全部落在 暗红 / 琥珀金 / 冷灰 三系（项目硬性要求，禁用紫色与紫蓝色）。
//
// ============================================================
// 性能设计（本次重构要点）
// ============================================================
// 1. 精灵缓存（最大一项）
//    怪物 / 玩家 / 掉落物的形状只在建缓存时用 Canvas 路径画一次，
//    之后每帧只做 drawImage。好处是「画质提高」与「帧耗时下降」同时成立 ——
//    以前多画一条肋骨就多一分每帧开销，现在只是建缓存时多几毫秒。
//    朝向会变的怪（血蝠 / 猎魔人）预烘焙 24 个旋转角，运行时只做一次取整查表。
//
// 2. 地面整张预渲染
//    地图 3200x2400 的地面（底色 + 噪点 + 血渍 + 裂纹 + 墓碑 + 网格 + 边框）
//    一次性画进离屏画布，每帧只做 1 次 drawImage 区域拷贝。
//    旧实现每帧要跑 2 次网格 stroke + 上百次 arc/fillRect，现在全省了。
//
// 3. 其余老规矩不变：视口裁剪、插值渲染（逻辑 20Hz / 渲染 60fps）、装饰后画。
//
// 自测：tools/renderbench.js 可量出「同屏 800 怪」时每帧的 CPU 耗时，改前改后直接对比。

(function (root) {
  'use strict';

  const C = root.VS.CONST;

  const TAU = Math.PI * 2;

  // 朝向会变的怪，烘焙多少个角度。24 挡 = 每 15 度一张，肉眼基本看不出台阶
  const ROT_STEPS = 24;
  // 这几只怪天生「朝右」——狗头在右、剑在右手、弩在右手。
  // 像素画不能任意角度旋转（一转格子就斜压在像素边界上，边缘被插值出一圈灰边，
  // 像素风当场毁掉），所以朝向改用**水平镜像**：只有这几只需要多烘一张镜像版，
  // 其余怪左右对称，一张就够（省一半显存）。
  const FACING_MOBS = { plague_hound: true, witch_hunter: true, skeleton_warrior: true };

  // ============================================================
  // 配色表
  // ============================================================

  const COLOR = {
    ground: '#12141a',
    border: '#5a1f1f',
    borderGlow: 'rgba(201,58,58,0.35)',

    // 玩家兜底色：只在 player-art.js 没加载成功时用得上（正常走 PLAYER_ART 的调色板）。
    // 取猎魔人的珊瑚粉，原因有两条：① 它是基准角色，兜底时配色至少不会突兀；
    // ② 万一真走到兜底，浅暖色在暗底战场上比原来那个米白好认。
    player: '#F09A93',
    playerCloak: '#A8554C',
    playerRing: '#c93a3a',
    playerFacing: '#f2c14e',

    // 经验球：原来用的 #9fc0d6 是偏饱和的天蓝，超出「冷灰」范畴，去饱和成冷灰青；
    // 明度再往上提了一档 —— 掉落物看不清会直接影响可玩性，宁可它亮一点
    expOrb: '#dae4ec',
    // 大经验球：琥珀金 —— 与小球（冷灰）拉开色相，在暗底上一眼挑得出来。
    // 【为什么不也用冷灰只是画大一圈】只放大不加色的话，满屏小球里那颗大的
    // 看起来像「画错了的一颗」，而不是「值得走过去捡的奖励」。
    expOrbBig: '#f2c14e',
    goldOrb: '#f2c14e',
    heartOrb: '#d94a4a',

    // 宝箱：琥珀金描边 + 血红锁扣。两个高对比色，因为它常常出现在 Boss 倒下的
    // 那个位置 —— 周围全是怪，低对比度的箱子在那种画面里等于不存在
    chestTrim: '#f2c14e',
    chestLock: '#c93a3a',

    // 燃烧区域：原 zoneFill 是 rgba(127,198,232) 的天蓝，属于违规配色，改成冷灰
    zoneFill: 'rgba(178,188,198,0.13)',
    zoneEdge: 'rgba(198,208,218,0.50)',
    zoneFillEvolved: 'rgba(255,209,102,0.16)',
    zoneEdgeEvolved: 'rgba(255,209,102,0.60)',

    enemyShot: '#b8404f',
    enemyShotCore: '#f0c0c0',

    warn: 'rgba(242,193,78,0.75)',
    boom: '#ff9f45',

    dmgText: '#f4e3b8',
    dmgTextBig: '#ffd166'
  };

  // ============================================================
  // 颜色小工具（只在建精灵缓存时用到，运行时零开销）
  // ============================================================

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // 把 hex 朝 target 混 t 比例。坑：target 也当 6 位 hex 解析，不能传 rgb() 串
  function mixHex(hex, target, t) {
    const a = hexToRgb(hex);
    const b = hexToRgb(target);
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * t) + ')';
  }
  function lighten(hex, t) { return mixHex(hex, '#ffffff', t); }
  function darken(hex, t) { return mixHex(hex, '#000000', t); }

  // hex -> 'rgba(r,g,b,a)'。渐变的 colorStop 必须带 alpha，
  // 而 mixHex 只能吐 'rgb()'，所以单独补一个带透明度的版本。
  function rgbaOf(hex, alpha) {
    const c = hexToRgb(hex);
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
  }

  // 既混色又带 alpha：'rgba()' 版 mixHex（渐变里既要提亮又要控制透明度时用）
  function mixRgba(hex, target, t, alpha) {
    const a = hexToRgb(hex);
    const b = hexToRgb(target);
    return 'rgba(' + Math.round(a[0] + (b[0] - a[0]) * t) + ',' +
      Math.round(a[1] + (b[1] - a[1]) * t) + ',' +
      Math.round(a[2] + (b[2] - a[2]) * t) + ',' + alpha + ')';
  }

  // 一个圆点。单独包一层是因为「beginPath + 多次 arc」会连成一条线，
  // 想画两个独立圆点必须各自 beginPath。
  function dot(g, x, y, r, color) {
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, r, 0, TAU);
    g.fill();
  }

  // 圆角矩形（不依赖 ctx.roundRect，老一点的浏览器没有）
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r);
    g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h);
    g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r);
    g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }

  // 身体用的径向渐变：左上偏亮、右下偏暗，做出球面感
  function bodyGrad(g, cx, cy, r, color) {
    const grd = g.createRadialGradient(cx - r * 0.35, cy - r * 0.42, r * 0.1, cx, cy, r * 1.08);
    grd.addColorStop(0, lighten(color, 0.45));
    grd.addColorStop(0.55, color);
    grd.addColorStop(1, darken(color, 0.45));
    return grd;
  }

  // 脚下软阴影：只在地面单位里烘焙进精灵，运行时零成本
  function bakeShadow(g, cx, cy, rx, ry, alpha) {
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, rx);
    grd.addColorStop(0, 'rgba(0,0,0,' + alpha + ')');
    grd.addColorStop(0.6, 'rgba(0,0,0,' + (alpha * 0.45) + ')');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.save();
    g.translate(cx, cy);
    g.scale(1, ry / rx);
    g.translate(-cx, -cy);
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, rx, 0, TAU);
    g.fill();
    g.restore();
  }

  // ============================================================
  // 离屏画布
  // ============================================================

  function newCanvas(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    return cv;
  }

  // 把一张精灵整体刷成白色，用于受击闪白。
  // 用 source-atop 保证只在原有像素上着色，轮廓自动跟着走，不用重画一遍形状。
  function makeFlashVariant(cv) {
    const c2 = newCanvas(cv.width, cv.height);
    const g = c2.getContext('2d');
    g.drawImage(cv, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = 'rgba(255,255,255,0.93)';
    g.fillRect(0, 0, c2.width, c2.height);
    return c2;
  }

  // ============================================================
  // 地面纹理：把整张地图一次性画进离屏画布
  // ============================================================
  // 说明：方案 2.7 原本要给地图加「挡路的墓碑 / 断墙」障碍。
  // P1 先不加实体障碍 —— 在没做寻路的情况下，怪物会被卡在障碍后面叠成一堆，
  // 反而毁掉体验。等 P2 做同步时一并加导航网格，这里先只保留地面装饰。

  function buildGroundTexture(map, seed) {
    const W = map.w;
    const H = map.h;
    const TH = map.theme;

    // 内存保护：地图再大也不至于一次吃爆。超了就退回逐帧程序化绘制。
    if (W * H > 16e6) return null;

    const cv = newCanvas(W, H);
    const g = cv.getContext('2d');

    // 伪随机：固定序列，保证同一颗种子每次画出来一模一样
    let s = (seed || 1) >>> 0;
    function rnd() {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    }

    // ---------- 1. 底色 + 中心辉光（配色来自地图主题） ----------
    g.fillStyle = TH.ground;
    g.fillRect(0, 0, W, H);

    const halo = g.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.62);
    halo.addColorStop(0, TH.glow);
    halo.addColorStop(0.5, 'rgba(0,0,0,0.05)');
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, W, H);

    // ---------- 2. 细噪点：让大片纯色不那么"塑料" ----------
    const speck = Math.round(1400 * (TH.speck || 1));
    for (let i = 0; i < speck; i++) {
      const a = 0.012 + rnd() * 0.026;
      g.fillStyle = rnd() < 0.5
        ? 'rgba(255,255,255,' + a + ')'
        : 'rgba(0,0,0,' + (a * 1.4) + ')';
      const rr = 0.8 + rnd() * 2.2;
      g.beginPath();
      g.arc(rnd() * W, rnd() * H, rr, 0, TAU);
      g.fill();
    }

    // ---------- 3. 血渍与裂纹 ----------
    for (let i = 0; i < 170; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const r = 26 + rnd() * 78;
      if (rnd() < 0.66) {
        // 血渍：外圈淡、内圈深，像渗进土里
        const a = 0.03 + rnd() * 0.05;
        const grd = g.createRadialGradient(x, y, r * 0.1, x, y, r);
        grd.addColorStop(0, TH.stain + (a * 1.3) + ')');
        grd.addColorStop(0.7, TH.stain + (a * 0.82) + ')');
        grd.addColorStop(1, TH.stain + '0)');
        g.fillStyle = grd;
        g.beginPath();
        g.arc(x, y, r, 0, TAU);
        g.fill();
      } else {
        // 地面裂纹：三段折线
        g.strokeStyle = 'rgba(255,255,255,' + (0.018 + rnd() * 0.028) + ')';
        g.lineWidth = 1.2;
        g.beginPath();
        g.moveTo(x - r * 0.6, y - r * 0.2);
        g.lineTo(x + r * 0.2, y + r * 0.1);
        g.lineTo(x + r * 0.7, y - r * 0.3);
        g.stroke();
      }
    }

    // ---------- 4. 地面装饰（按地图主题，四种画法） ----------
    //
    // ★装饰与障碍是**两回事**，刻意分开：
    //   装饰 = 画在这张地面纹理里的静态图案，可以成百上千个，零查询成本
    //   障碍 = w.obstacles（共享层 buildObstacles 生成），真正参与碰撞，
    //           必须控制在几十个以内 —— 每帧每只怪都要查它
    // 所以地面可以画满碎石与砖缝，而站在上面的怪不会被一块画出来的石头挡住。
    if (TH.deco === 'brick') {
      // 血色回廊：错缝石砖
      g.strokeStyle = 'rgba(0,0,0,0.22)';
      g.lineWidth = 1.4;
      g.beginPath();
      for (let y = 0, row = 0; y <= H; y += 34, row++) {
        g.moveTo(0, y); g.lineTo(W, y);
        const off = (row % 2) * 40;
        for (let x = off; x <= W; x += 80) { g.moveTo(x, y); g.lineTo(x, y + 34); }
      }
      g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.03)';
      g.lineWidth = 1;
      g.beginPath();
      for (let y = 1; y <= H; y += 34) { g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();

    } else if (TH.deco === 'flagstone') {
      // 钟楼广场：大块石板 +  occasional 裂纹
      g.lineWidth = 2;
      g.strokeStyle = 'rgba(0,0,0,0.2)';
      g.beginPath();
      for (let x = 0; x <= W; x += 128) { g.moveTo(x, 0); g.lineTo(x, H); }
      for (let y = 0; y <= H; y += 128) { g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
      // 每块石板里点一小块亮面，做出「铺得不太平」的质感
      for (let i = 0; i < 260; i++) {
        const cx2 = Math.floor(rnd() * (W / 128)) * 128;
        const cy2 = Math.floor(rnd() * (H / 128)) * 128;
        g.fillStyle = 'rgba(255,255,255,' + (0.012 + rnd() * 0.02) + ')';
        g.fillRect(cx2 + 6, cy2 + 6, 40 + rnd() * 60, 30 + rnd() * 50);
      }

    } else if (TH.deco === 'altar') {
      // 血月祭坛：同心圆 + 放射纹（中心是一块祭坛地面）
      const cx2 = W / 2;
      const cy2 = H / 2;
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      for (let r = 120; r < Math.max(W, H); r += 130) {
        g.lineWidth = 2;
        g.beginPath(); g.arc(cx2, cy2, r, 0, TAU); g.stroke();
      }
      g.strokeStyle = TH.glow;
      g.lineWidth = 3;
      g.beginPath(); g.arc(cx2, cy2, 300, 0, TAU); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.045)';
      g.lineWidth = 1;
      g.beginPath();
      for (let a = 0; a < 16; a++) {
        const ang = (Math.PI * 2 / 16) * a;
        g.moveTo(cx2 + Math.cos(ang) * 300, cy2 + Math.sin(ang) * 300);
        g.lineTo(cx2 + Math.cos(ang) * 1400, cy2 + Math.sin(ang) * 1400);
      }
      g.stroke();

    } else {
      // 荒村墓园：散落墓碑
      for (let i = 0; i < 74; i++) {
        const x = 80 + rnd() * (W - 160);
        const y = 80 + rnd() * (H - 160);
        const gw = 13 + rnd() * 11;
        const gh = 17 + rnd() * 14;
        const lean = (rnd() - 0.5) * 0.5;

        g.save();
        g.translate(x, y);
        g.rotate(lean);
        // 投影
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.beginPath();
        g.ellipse(2, 2, gw * 0.75, gw * 0.28, 0, 0, TAU);
        g.fill();
        // 碑体
        g.fillStyle = '#252a33';
        g.fillRect(-gw / 2, -gh, gw, gh);
        // 顶面高光
        g.fillStyle = '#343a45';
        g.fillRect(-gw / 2, -gh, gw, 4);
        // 右侧暗面
        g.fillStyle = 'rgba(0,0,0,0.3)';
        g.fillRect(gw / 2 - 3, -gh, 3, gh);
        // 刻痕十字
        g.strokeStyle = 'rgba(0,0,0,0.5)';
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(0, -gh + 5);
        g.lineTo(0, -gh + 13);
        g.moveTo(-4, -gh + 8);
        g.lineTo(4, -gh + 8);
        g.stroke();
        g.restore();
      }
    }

    // ---------- 5. 网格 ----------
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,0.035)';
    g.beginPath();
    for (let x = 0; x <= W; x += 160) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = 0; y <= H; y += 160) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();

    // 每 800px 一条更亮的线，便于判断跑了多远
    g.strokeStyle = 'rgba(255,255,255,0.062)';
    g.beginPath();
    for (let x = 0; x <= W; x += 800) { g.moveTo(x, 0); g.lineTo(x, H); }
    for (let y = 0; y <= H; y += 800) { g.moveTo(0, y); g.lineTo(W, y); }
    g.stroke();

    // ---------- 6. 地图边界 ----------
    g.strokeStyle = COLOR.border;
    g.lineWidth = 6;
    g.strokeRect(0, 0, W, H);
    g.strokeStyle = COLOR.borderGlow;
    g.lineWidth = 2;
    g.strokeRect(3, 3, W - 6, H - 6);

    return cv;
  }

  // ============================================================
  // 精灵：怪物本体
  // ============================================================
  // 约定：paint 里 (cx, cy) 是碰撞圆心，r 是碰撞半径。
  // 会旋转的种类把「前方」定在 +x 方向，烘焙时再转到各个角度。

  function paintCorpse(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.78, r * 1.05, r * 0.42, 0.4);

    // 两条下垂的臂（先画，被身体压住根部）
    g.strokeStyle = darken(color, 0.3);
    g.lineWidth = Math.max(2, r * 0.3);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx - r * 0.7, cy + r * 0.05);
    g.lineTo(cx - r * 1.18, cy + r * 0.72);
    g.moveTo(cx + r * 0.7, cy + r * 0.05);
    g.lineTo(cx + r * 1.18, cy + r * 0.72);
    g.stroke();

    // 躯干：略扁的椭圆
    g.fillStyle = bodyGrad(g, cx, cy, r * 1.1, color);
    g.beginPath();
    g.ellipse(cx, cy - r * 0.06, r * 0.9, r * 0.98, 0, 0, TAU);
    g.fill();

    // 深色外描边。腐尸是最常见的小怪（占一半以上），
    // 在暗红地面上没有描边就糊成一团，加一圈暗边立刻能看清轮廓。
    g.strokeStyle = darken(color, 0.62);
    g.lineWidth = Math.max(1.2, r * 0.11);
    g.stroke();

    // 顶部一道冷色反光，做出"潮湿/腐烂"的质感
    g.strokeStyle = 'rgba(226,222,204,0.28)';
    g.lineWidth = Math.max(1, r * 0.1);
    g.beginPath();
    g.arc(cx, cy - r * 0.06, r * 0.82, Math.PI * 1.15, Math.PI * 1.75);
    g.stroke();

    // 破损缺口：两处暗斑
    g.fillStyle = darken(color, 0.55);
    g.beginPath();
    g.arc(cx + r * 0.6, cy + r * 0.44, r * 0.26, 0, TAU);
    g.fill();
    g.beginPath();
    g.arc(cx - r * 0.68, cy - r * 0.28, r * 0.18, 0, TAU);
    g.fill();

    // 缝线：一条横向暗线，让身体不像一块饼
    g.strokeStyle = darken(color, 0.5);
    g.lineWidth = Math.max(1, r * 0.09);
    g.beginPath();
    g.moveTo(cx - r * 0.55, cy + r * 0.1);
    g.quadraticCurveTo(cx, cy + r * 0.28, cx + r * 0.55, cy + r * 0.06);
    g.stroke();

    // 双红眼：外发光 + 亮核，暗底上也一眼能找到
    dot(g, cx - r * 0.3, cy - r * 0.32, r * 0.24, 'rgba(224,85,85,0.28)');
    dot(g, cx + r * 0.3, cy - r * 0.32, r * 0.24, 'rgba(224,85,85,0.28)');
    dot(g, cx - r * 0.3, cy - r * 0.32, r * 0.16, '#e05555');
    dot(g, cx + r * 0.3, cy - r * 0.32, r * 0.16, '#e05555');
    dot(g, cx - r * 0.3, cy - r * 0.32, r * 0.07, '#ffe0e0');
    dot(g, cx + r * 0.3, cy - r * 0.32, r * 0.07, '#ffe0e0');
  }

  // 血蝠：飞行单位，不画脚下阴影（空中单位地上有影子反而假）
  function paintBat(g, cx, cy, r, color) {
    const wing = darken(color, 0.34);
    const bone = lighten(color, 0.3);

    // 上下两片翼膜。带一点弧度，比纯三角像翅膀
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      g.fillStyle = wing;
      g.beginPath();
      g.moveTo(cx + r * 0.45, cy);
      g.quadraticCurveTo(cx - r * 0.4, cy + sgn * r * 1.15,
        cx - r, cy + sgn * r * 1.62);
      g.lineTo(cx - r * 0.45, cy + sgn * r * 0.62);
      g.closePath();
      g.fill();
      // 暗色翼缘：血蝠本体颜色偏暗，不描边在暗底上只剩一团影子
      g.strokeStyle = darken(color, 0.6);
      g.lineWidth = Math.max(1, r * 0.12);
      g.stroke();
      // 翼骨
      g.strokeStyle = bone;
      g.lineWidth = Math.max(1, r * 0.1);
      g.beginPath();
      g.moveTo(cx + r * 0.4, cy);
      g.lineTo(cx - r * 0.95, cy + sgn * r * 1.5);
      g.stroke();
    }

    // 身体：菱形
    g.fillStyle = bodyGrad(g, cx, cy, r * 1.1, color);
    g.beginPath();
    g.moveTo(cx + r * 1.15, cy);
    g.lineTo(cx, cy - r * 0.66);
    g.lineTo(cx - r * 0.8, cy);
    g.lineTo(cx, cy + r * 0.66);
    g.closePath();
    g.fill();

    // 双耳
    g.fillStyle = darken(color, 0.2);
    g.beginPath();
    g.moveTo(cx + r * 0.35, cy - r * 0.42);
    g.lineTo(cx + r * 0.62, cy - r * 0.95);
    g.lineTo(cx + r * 0.7, cy - r * 0.3);
    g.closePath();
    g.moveTo(cx + r * 0.35, cy + r * 0.42);
    g.lineTo(cx + r * 0.62, cy + r * 0.95);
    g.lineTo(cx + r * 0.7, cy + r * 0.3);
    g.closePath();
    g.fill();

    // 双红眼
    dot(g, cx + r * 0.62, cy - r * 0.2, r * 0.13, '#ff7070');
    dot(g, cx + r * 0.62, cy + r * 0.2, r * 0.13, '#ff7070');
  }

  // 骸骨武士（原「骸骨弓手」）。
  // 怪物去掉远程攻击后，手里那把弓换成了剑 —— 外形必须和行为对得上：
  // 玩家看到的应该是「举着武器冲上来的骨架」，而不是一只拿着弓却从不放箭的怪。
  function paintSkeletonWarrior(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.9, r * 1.0, r * 0.36, 0.34);

    // 剑：以握把为原点旋转一根长条，比手算四个顶点直观，也省得改形状时到处改坐标
    g.save();
    g.translate(cx + r * 0.5, cy + r * 0.28);
    g.rotate(-0.72);
    g.fillStyle = '#b9b2a0';
    roundRect(g, 0, -r * 0.11, r * 1.25, r * 0.22, r * 0.11);
    g.fill();
    g.fillStyle = lighten(color, 0.45);          // 剑尖
    g.beginPath();
    g.moveTo(r * 1.25, -r * 0.11);
    g.lineTo(r * 1.55, 0);
    g.lineTo(r * 1.25, r * 0.11);
    g.closePath();
    g.fill();
    g.fillStyle = '#6d6455';                     // 护手
    g.fillRect(-r * 0.06, -r * 0.26, r * 0.16, r * 0.52);
    g.restore();

    // 躯干：方身
    g.fillStyle = bodyGrad(g, cx, cy, r * 1.2, color);
    roundRect(g, cx - r * 0.6, cy - r * 0.85, r * 1.2, r * 1.75, r * 0.26);
    g.fill();

    // 肋骨三条
    g.strokeStyle = darken(color, 0.36);
    g.lineWidth = Math.max(1, r * 0.13);
    g.beginPath();
    for (let i = 0; i < 3; i++) {
      const yy = cy - r * 0.22 + i * r * 0.36;
      g.moveTo(cx - r * 0.4, yy);
      g.lineTo(cx + r * 0.4, yy);
    }
    g.stroke();

    // 颅骨
    g.fillStyle = lighten(color, 0.32);
    g.beginPath();
    g.arc(cx, cy - r * 1.0, r * 0.5, 0, TAU);
    g.fill();
    // 下颌
    g.fillStyle = lighten(color, 0.18);
    g.fillRect(cx - r * 0.26, cy - r * 0.68, r * 0.52, r * 0.22);

    // 眼窝
    dot(g, cx - r * 0.19, cy - r * 1.04, r * 0.15, '#26282c');
    dot(g, cx + r * 0.19, cy - r * 1.04, r * 0.15, '#26282c');
    dot(g, cx - r * 0.19, cy - r * 1.04, r * 0.06, '#d94a4a');
    dot(g, cx + r * 0.19, cy - r * 1.04, r * 0.06, '#d94a4a');
  }

  function paintGargoyle(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.88, r * 1.2, r * 0.4, 0.4);

    // 两侧石翼：三齿尖角，左右镜像
    for (let sgn = -1; sgn <= 1; sgn += 2) {
      g.fillStyle = darken(color, 0.42);
      g.beginPath();
      g.moveTo(cx + sgn * r * 0.45, cy - r * 0.25);
      g.lineTo(cx + sgn * r * 1.85, cy - r * 1.1);
      g.lineTo(cx + sgn * r * 1.42, cy - r * 0.4);
      g.lineTo(cx + sgn * r * 1.78, cy + r * 0.06);
      g.lineTo(cx + sgn * r * 1.2, cy + r * 0.2);
      g.closePath();
      g.fill();
      g.strokeStyle = lighten(color, 0.18);
      g.lineWidth = Math.max(1, r * 0.07);
      g.stroke();
    }

    // 主体：六边形
    g.fillStyle = bodyGrad(g, cx, cy, r * 1.15, color);
    g.beginPath();
    for (let k = 0; k < 6; k++) {
      const a = (Math.PI / 3) * k - Math.PI / 2;
      const px = cx + Math.cos(a) * r;
      const py = cy + Math.sin(a) * r;
      if (k === 0) g.moveTo(px, py);
      else g.lineTo(px, py);
    }
    g.closePath();
    g.fill();

    // 石纹：内部一道折线
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.lineWidth = Math.max(1, r * 0.08);
    g.beginPath();
    g.moveTo(cx - r * 0.5, cy + r * 0.35);
    g.lineTo(cx - r * 0.05, cy - r * 0.1);
    g.lineTo(cx + r * 0.5, cy + r * 0.42);
    g.stroke();

    // 兽首凸起 + 琥珀金双眼
    g.fillStyle = darken(color, 0.28);
    g.beginPath();
    g.moveTo(cx, cy - r * 0.95);
    g.lineTo(cx + r * 0.42, cy - r * 0.4);
    g.lineTo(cx - r * 0.42, cy - r * 0.4);
    g.closePath();
    g.fill();
    dot(g, cx - r * 0.2, cy - r * 0.42, r * 0.13, '#f2c14e');
    dot(g, cx + r * 0.2, cy - r * 0.42, r * 0.13, '#f2c14e');
  }

  function paintBloodPriest(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 1.0, r * 1.25, r * 0.42, 0.4);

    // 长袍：上窄下宽
    g.fillStyle = bodyGrad(g, cx, cy - r * 0.2, r * 1.35, color);
    g.beginPath();
    g.moveTo(cx - r * 0.42, cy - r * 0.85);
    g.lineTo(cx + r * 0.42, cy - r * 0.85);
    g.lineTo(cx + r * 1.05, cy + r * 0.9);
    g.quadraticCurveTo(cx, cy + r * 1.4, cx - r * 1.05, cy + r * 0.9);
    g.closePath();
    g.fill();

    // 袍子中缝
    g.strokeStyle = darken(color, 0.5);
    g.lineWidth = Math.max(1, r * 0.08);
    g.beginPath();
    g.moveTo(cx, cy - r * 0.8);
    g.lineTo(cx, cy + r * 1.15);
    g.stroke();

    // 兜帽
    g.fillStyle = darken(color, 0.44);
    g.beginPath();
    g.moveTo(cx - r * 0.56, cy - r * 0.62);
    g.quadraticCurveTo(cx, cy - r * 2.0, cx + r * 0.56, cy - r * 0.62);
    g.closePath();
    g.fill();

    // 帽内阴影 + 双红眼
    g.fillStyle = '#1b0a0d';
    g.beginPath();
    g.ellipse(cx, cy - r * 0.82, r * 0.36, r * 0.3, 0, 0, TAU);
    g.fill();
    dot(g, cx - r * 0.15, cy - r * 0.84, r * 0.1, '#e05555');
    dot(g, cx + r * 0.15, cy - r * 0.84, r * 0.1, '#e05555');

    // 胸前血红符文（倒十字符）
    g.strokeStyle = 'rgba(226,96,96,0.9)';
    g.lineWidth = Math.max(1.2, r * 0.13);
    g.beginPath();
    g.moveTo(cx, cy + r * 0.05);
    g.lineTo(cx, cy + r * 0.72);
    g.moveTo(cx - r * 0.3, cy + r * 0.26);
    g.lineTo(cx + r * 0.3, cy + r * 0.26);
    g.stroke();
  }

  // 猎魔人：朝速度方向的三角冲锋手
  function paintWitchHunter(g, cx, cy, r, color) {
    // 披风主体
    g.fillStyle = bodyGrad(g, cx, cy, r * 1.2, color);
    g.beginPath();
    g.moveTo(cx + r * 1.28, cy);
    g.lineTo(cx - r * 0.98, cy - r * 0.92);
    g.lineTo(cx - r * 0.44, cy);
    g.lineTo(cx - r * 0.98, cy + r * 0.92);
    g.closePath();
    g.fill();

    // 亮色描边，让暗底上也能看清轮廓
    g.strokeStyle = lighten(color, 0.42);
    g.lineWidth = Math.max(1, r * 0.09);
    g.stroke();

    // 兜帽尖端
    g.fillStyle = darken(color, 0.38);
    g.beginPath();
    g.moveTo(cx + r * 1.0, cy);
    g.lineTo(cx + r * 0.05, cy - r * 0.5);
    g.lineTo(cx + r * 0.05, cy + r * 0.5);
    g.closePath();
    g.fill();

    // 枪口一点火星
    dot(g, cx + r * 0.95, cy, r * 0.14, '#ffb066');
  }

  // ============================================================
  // 新增怪物（本轮：关卡差异化用的四种）
  // ============================================================
  // 每个都从剪影开始设计：先问「小尺寸下它像什么」，
  // 再往上加细节。r=9~19 的敌人身上，超过三层的细节是看不见的。

  // 疫犬：四足兽，侧视轮廓（细长身体 + 前伸的吻 + 四条腿）
  // 场上唯一「横着长」的怪 —— 这一个特征就够把它和所有圆身怪区分开
  function paintPlagueHound(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.7, r * 1.25, r * 0.38, 0.4);
    // 四条腿
    g.strokeStyle = darken(color, 0.35);
    g.lineWidth = Math.max(1.5, r * 0.2);
    g.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const bx = cx + (k < 2 ? -r * 0.62 : r * 0.5);
      const sway = (k % 2 === 0) ? -r * 0.3 : r * 0.3;
      g.beginPath();
      g.moveTo(bx, cy + r * 0.25);
      g.lineTo(bx + sway, cy + r * 1.0);
      g.stroke();
    }
    // 躯干（横向椭圆）
    g.fillStyle = bodyGrad(g, cx, cy, r, color);
    g.beginPath();
    g.ellipse(cx, cy, r * 1.0, r * 0.72, 0, 0, TAU);
    g.fill();
    // 头（前伸，左右各一个 —— 俯视角度看两侧都是头，读起来像「正扑过来」）
    g.fillStyle = lighten(color, 0.12);
    g.beginPath();
    g.ellipse(cx - r * 0.85, cy - r * 0.1, r * 0.42, r * 0.34, 0, 0, TAU);
    g.fill();
    g.beginPath();
    g.ellipse(cx + r * 0.85, cy - r * 0.1, r * 0.42, r * 0.34, 0, 0, TAU);
    g.fill();
    // 两只发亮的眼（疫病感靠这一点颜色给）
    dot(g, cx - r * 0.95, cy - r * 0.16, r * 0.13, '#d9c46a');
    dot(g, cx + r * 0.95, cy - r * 0.16, r * 0.13, '#d9c46a');
    // 背脊的骨刺
    g.fillStyle = darken(color, 0.5);
    for (let k = -1; k <= 1; k++) {
      g.beginPath();
      g.moveTo(cx + k * r * 0.3 - r * 0.1, cy - r * 0.6);
      g.lineTo(cx + k * r * 0.3, cy - r * 1.05);
      g.lineTo(cx + k * r * 0.3 + r * 0.1, cy - r * 0.6);
      g.closePath();
      g.fill();
    }
  }

  // 血蜘蛛：圆腹 + 八条展开的腿（腿是它唯一的辨识点，必须画得比身体还显眼）
  function paintBloodSpider(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.7, r * 1.5, r * 0.4, 0.4);
    // 八条腿：两节折线，向外张开
    g.strokeStyle = darken(color, 0.45);
    g.lineWidth = Math.max(1.5, r * 0.16);
    g.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const a = (Math.PI / 3) * k + Math.PI * 0.18;
      for (let side = -1; side <= 1; side += 2) {
        const ang = a * side + Math.PI / 2;
        const kx = cx + Math.cos(ang) * r * 0.72;
        const ky = cy + Math.sin(ang) * r * 0.72;
        const mx = cx + Math.cos(ang) * r * 1.25;
        const my = cy + Math.sin(ang) * r * 1.25 - r * 0.28;
        g.beginPath();
        g.moveTo(kx, ky);
        g.lineTo(mx, my);
        g.lineTo(cx + Math.cos(ang) * r * 1.72, cy + Math.sin(ang) * r * 1.72);
        g.stroke();
      }
    }
    // 腹部
    g.fillStyle = bodyGrad(g, cx, cy, r, color);
    g.beginPath();
    g.arc(cx, cy + r * 0.1, r * 0.86, 0, TAU);
    g.fill();
    // 头胸（小一圈，压在腹部前上方）
    g.fillStyle = lighten(color, 0.14);
    g.beginPath();
    g.arc(cx, cy - r * 0.42, r * 0.46, 0, TAU);
    g.fill();
    // 复眼：一圈小点
    for (let k = 0; k < 6; k++) {
      const a = (TAU / 6) * k;
      dot(g, cx + Math.cos(a) * r * 0.26, cy - r * 0.46 + Math.sin(a) * r * 0.2,
        r * 0.1, '#ffd9a0');
    }
    // 腹部沙漏纹（红）
    g.fillStyle = 'rgba(201,58,58,0.75)';
    g.beginPath();
    g.moveTo(cx, cy - r * 0.1);
    g.lineTo(cx + r * 0.3, cy + r * 0.3);
    g.lineTo(cx, cy + r * 0.6);
    g.lineTo(cx - r * 0.3, cy + r * 0.3);
    g.closePath();
    g.fill();
  }

  // 骨甲卫：方盾 + 全盔 + 骨棒 —— 全身都是直线，是场上最「方」的怪
  function paintBoneKnight(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.8, r * 1.35, r * 0.42, 0.46);
    // 骨棒（右肩扛着，斜向）
    g.strokeStyle = '#9a8f76';
    g.lineWidth = Math.max(2.5, r * 0.26);
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(cx + r * 0.55, cy + r * 0.5);
    g.lineTo(cx + r * 1.2, cy - r * 0.75);
    g.stroke();
    // 骨棒顶端的球（骨头关节）
    dot(g, cx + r * 1.26, cy - r * 0.86, r * 0.3, '#c9c0aa');
    dot(g, cx + r * 1.0, cy - r * 1.02, r * 0.22, '#c9c0aa');
    // 躯干（方形，不是圆 —— 与所有圆形怪立刻区分）
    g.fillStyle = bodyGrad(g, cx, cy, r, color);
    g.beginPath();
    g.moveTo(cx - r * 0.78, cy - r * 0.5);
    g.lineTo(cx + r * 0.78, cy - r * 0.5);
    g.lineTo(cx + r * 0.68, cy + r * 0.86);
    g.lineTo(cx - r * 0.68, cy + r * 0.86);
    g.closePath();
    g.fill();
    // 肋骨纹（三道横线）
    g.strokeStyle = 'rgba(60,54,44,0.5)';
    g.lineWidth = Math.max(1, r * 0.08);
    for (let k = 0; k < 3; k++) {
      g.beginPath();
      g.moveTo(cx - r * 0.6 + k * r * 0.06, cy - r * 0.14 + k * r * 0.34);
      g.lineTo(cx + r * 0.6 - k * r * 0.06, cy - r * 0.14 + k * r * 0.34);
      g.stroke();
    }
    // 全盔
    g.fillStyle = '#cfc7b0';
    g.beginPath();
    g.arc(cx, cy - r * 0.72, r * 0.5, 0, TAU);
    g.fill();
    // 视察缝
    g.fillStyle = 'rgba(20,18,14,0.9)';
    g.fillRect(cx - r * 0.4, cy - r * 0.84, r * 0.8, r * 0.16);
    // 方盾（左侧）
    g.fillStyle = '#8a7f68';
    g.beginPath();
    g.moveTo(cx - r * 1.15, cy - r * 0.42);
    g.lineTo(cx - r * 0.52, cy - r * 0.42);
    g.lineTo(cx - r * 0.52, cy + r * 0.62);
    g.lineTo(cx - r * 0.84, cy + r * 0.92);
    g.lineTo(cx - r * 1.15, cy + r * 0.62);
    g.closePath();
    g.fill();
    g.strokeStyle = '#5e5644';
    g.lineWidth = Math.max(1, r * 0.08);
    g.stroke();
  }

  // 尸母：臃肿的躯体 + 多头 + 从腹部伸出的手（「母」体现在多出来的肢体上）
  function paintGhoulMatriarch(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.8, r * 1.5, r * 0.46, 0.44);
    // 从腹部伸出的四条小手
    g.strokeStyle = darken(color, 0.4);
    g.lineWidth = Math.max(1.5, r * 0.17);
    g.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      const a = Math.PI * 0.15 + (Math.PI * 0.7 / 3) * k;
      const bx = cx + Math.cos(a) * r * 0.7;
      const by = cy + Math.abs(Math.sin(a)) * r * 0.7;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(a) * r * 0.55, by + r * 0.5);
      g.stroke();
    }
    // 躯干（比同尺寸的怪更宽更扁 —— 臃肿感）
    g.fillStyle = bodyGrad(g, cx, cy, r, color);
    g.beginPath();
    g.ellipse(cx, cy + r * 0.12, r * 1.1, r * 0.92, 0, 0, TAU);
    g.fill();
    // 腹部裂口
    g.fillStyle = 'rgba(30,14,14,0.62)';
    g.beginPath();
    g.ellipse(cx, cy + r * 0.34, r * 0.5, r * 0.3, 0, 0, TAU);
    g.fill();
    // 三个小头（簇拥在上方）
    const heads = [[-0.55, -0.62, 0.34], [0, -0.86, 0.42], [0.55, -0.62, 0.34]];
    for (let k = 0; k < heads.length; k++) {
      const hx = cx + heads[k][0] * r;
      const hy = cy + heads[k][1] * r;
      g.fillStyle = lighten(color, k === 1 ? 0.18 : 0.06);
      g.beginPath();
      g.arc(hx, hy, heads[k][2] * r, 0, TAU);
      g.fill();
      dot(g, hx - r * 0.1, hy - r * 0.04, r * 0.07, '#2a1a18');
      dot(g, hx + r * 0.1, hy - r * 0.04, r * 0.07, '#2a1a18');
    }
  }

  // ============================================================
  // Boss：四只共用一套骨架，特征层按 bossStyle 换
  // ============================================================
  // 【为什么参数化而不是各写一遍】四只 Boss 的「体型」应该是同一族的
  // （同一类生物的不同阶段），换的是头饰、武器和符环 —— 各写一遍的话，
  // 以后调体型要在四个地方改。
  // 但特征层必须差得足够明显：玩家在第 10 波和第 40 波看到的东西如果不一眼不同，
  // 「多种 Boss」这件事在体感上就等于没做。
  function paintBossStyled(g, cx, cy, r, color, style) {
    bakeShadow(g, cx, cy + r * 0.78, r * 1.6, r * 0.5, 0.46);

    // ---------- 公共：外圈尖刺（数量与长度按风格微调） ----------
    const spikeN = style === 'prelate' ? 16 : (style === 'queen' ? 14 : (style === 'tyrant' ? 8 : 12));
    const spikeLen = style === 'tyrant' ? 1.5 : 1.62;
    g.fillStyle = darken(color, 0.5);
    g.beginPath();
    for (let k = 0; k < spikeN; k++) {
      const a = (TAU / spikeN) * k;
      g.moveTo(cx + Math.cos(a - 0.13) * r * 0.9, cy + Math.sin(a - 0.13) * r * 0.9);
      g.lineTo(cx + Math.cos(a) * r * spikeLen, cy + Math.sin(a) * r * spikeLen);
      g.lineTo(cx + Math.cos(a + 0.13) * r * 0.9, cy + Math.sin(a + 0.13) * r * 0.9);
      g.closePath();
    }
    g.fill();

    // ---------- 本体 ----------
    g.fillStyle = bodyGrad(g, cx, cy, r, color);
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fill();

    // ---------- 公共：内环（颜色按风格：暗红 vs 琥珀金） ----------
    const inner = (style === 'prelate') ? 'rgba(168,182,196,0.42)' : 'rgba(242,193,78,0.42)';
    g.strokeStyle = inner;
    g.lineWidth = Math.max(1.5, r * 0.09);
    g.beginPath();
    g.arc(cx, cy, r * 0.66, 0, TAU);
    g.stroke();

    // ---------- 特征层 ----------
    if (style === 'tyrant') {
      // 骸骨暴君：外露的肋骨 + 一对折断的角
      g.strokeStyle = 'rgba(240,234,214,0.62)';
      g.lineWidth = Math.max(1.5, r * 0.1);
      for (let k = 0; k < 5; k++) {
        const a = Math.PI * 0.16 + (Math.PI * 0.68 / 4) * k;
        g.beginPath();
        g.arc(cx, cy + r * 0.4, r * 0.62, a, a + 0.5);
        g.stroke();
      }
      // 断角
      g.fillStyle = '#d6cdb4';
      g.beginPath();
      g.moveTo(cx - r * 0.62, cy - r * 0.66);
      g.lineTo(cx - r * 0.28, cy - r * 0.24);
      g.lineTo(cx - r * 0.5, cy - r * 0.2);
      g.closePath();
      g.fill();
      g.beginPath();
      g.moveTo(cx + r * 0.62, cy - r * 0.66);
      g.lineTo(cx + r * 0.28, cy - r * 0.24);
      g.lineTo(cx + r * 0.5, cy - r * 0.2);
      g.closePath();
      g.fill();

    } else if (style === 'prelate') {
      // 深渊主教：高兜帽 + 胸口十字 + 环绕的祈祷符
      g.fillStyle = 'rgba(24,28,36,0.88)';
      g.beginPath();
      g.moveTo(cx - r * 0.72, cy + r * 0.16);
      g.quadraticCurveTo(cx, cy - r * 1.62, cx + r * 0.72, cy + r * 0.16);
      g.quadraticCurveTo(cx, cy + r * 0.5, cx - r * 0.72, cy + r * 0.16);
      g.closePath();
      g.fill();
      // 兜帽里的两点冷光
      dot(g, cx - r * 0.2, cy - r * 0.34, r * 0.11, '#cfe0ee');
      dot(g, cx + r * 0.2, cy - r * 0.34, r * 0.11, '#cfe0ee');
      // 胸口十字
      g.fillStyle = '#c9d4de';
      g.fillRect(cx - r * 0.08, cy + r * 0.06, r * 0.16, r * 0.5);
      g.fillRect(cx - r * 0.24, cy + r * 0.22, r * 0.48, r * 0.16);
      // 环绕符（虚线圆）
      g.strokeStyle = 'rgba(200,214,226,0.45)';
      g.lineWidth = Math.max(1, r * 0.06);
      g.beginPath();
      for (let k = 0; k < 12; k++) {
        const a = (TAU / 12) * k;
        g.moveTo(cx + Math.cos(a) * r * 0.9, cy + Math.sin(a) * r * 0.9);
        g.lineTo(cx + Math.cos(a + 0.22) * r * 0.9, cy + Math.sin(a + 0.22) * r * 0.9);
      }
      g.stroke();

    } else if (style === 'queen') {
      // 血月女王：三尖王冠 + 血月纹 + 双月牙
      g.fillStyle = '#f2c14e';
      g.beginPath();
      g.moveTo(cx - r * 0.7, cy - r * 0.62);
      g.lineTo(cx - r * 0.44, cy - r * 1.24);
      g.lineTo(cx - r * 0.18, cy - r * 0.74);
      g.lineTo(cx, cy - r * 1.46);
      g.lineTo(cx + r * 0.18, cy - r * 0.74);
      g.lineTo(cx + r * 0.44, cy - r * 1.24);
      g.lineTo(cx + r * 0.7, cy - r * 0.62);
      g.closePath();
      g.fill();
      // 王冠上的三颗血珠
      dot(g, cx - r * 0.44, cy - r * 1.34, r * 0.09, '#c93a3a');
      dot(g, cx, cy - r * 1.56, r * 0.11, '#c93a3a');
      dot(g, cx + r * 0.44, cy - r * 1.34, r * 0.09, '#c93a3a');
      // 血月纹（本体上的暗红月牙）
      g.strokeStyle = 'rgba(201,58,58,0.7)';
      g.lineWidth = Math.max(2, r * 0.14);
      g.beginPath();
      g.arc(cx, cy + r * 0.08, r * 0.5, Math.PI * 0.25, Math.PI * 1.35);
      g.stroke();
      // 两侧月牙
      g.strokeStyle = 'rgba(242,193,78,0.55)';
      g.lineWidth = Math.max(1, r * 0.07);
      g.beginPath();
      g.arc(cx - r * 0.95, cy, r * 0.3, Math.PI * 0.4, Math.PI * 1.6);
      g.stroke();
      g.beginPath();
      g.arc(cx + r * 0.95, cy, r * 0.3, Math.PI * 1.4, Math.PI * 0.6);
      g.stroke();

    } else {
      // lord（血月领主）：环绕的符文刻痕。
      // 它是第 10 波的第一只 Boss，保留原来的形象 —— 对打过它的玩家有识别意义，
      // 而且「第一只最朴素、后面三只越来越怪」的递进本身就传达了难度层级。
      g.strokeStyle = 'rgba(242,193,78,0.35)';
      g.lineWidth = Math.max(1, r * 0.06);
      g.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (TAU / 8) * k + 0.2;
        g.moveTo(cx + Math.cos(a) * r * 0.72, cy + Math.sin(a) * r * 0.72);
        g.lineTo(cx + Math.cos(a) * r * 0.86, cy + Math.sin(a) * r * 0.86);
      }
      g.stroke();
      // 血月内环（原有形象的一部分）
      g.strokeStyle = 'rgba(201,58,58,0.55)';
      g.lineWidth = Math.max(1, r * 0.05);
      g.beginPath();
      g.arc(cx, cy, r * 0.44, 0, TAU);
      g.stroke();
    }

    // ---------- 公共：双眼（所有 Boss 都有，颜色按风格区分） ----------
    const eye = (style === 'prelate') ? '#cfe0ee'
      : ((style === 'tyrant') ? '#e8dcc0' : '#ff6b6b');
    dot(g, cx - r * 0.3, cy - r * 0.12, r * 0.2, 'rgba(255,90,90,0.3)');
    dot(g, cx + r * 0.3, cy - r * 0.12, r * 0.2, 'rgba(255,90,90,0.3)');
    dot(g, cx - r * 0.3, cy - r * 0.12, r * 0.11, eye);
    dot(g, cx + r * 0.3, cy - r * 0.12, r * 0.11, eye);
  }

  // 玩家：兜帽 + 斗篷 + 金腰带。朝向箭头是动态画的，不烘焙进精灵。
  function paintPlayer(g, cx, cy, r, color) {
    bakeShadow(g, cx, cy + r * 0.85, r * 1.15, r * 0.4, 0.42);

    // 斗篷
    g.fillStyle = COLOR.playerCloak;
    g.beginPath();
    g.moveTo(cx, cy - r * 0.25);
    g.lineTo(cx + r * 1.18, cy + r * 1.02);
    g.quadraticCurveTo(cx, cy + r * 1.3, cx - r * 1.18, cy + r * 1.02);
    g.closePath();
    g.fill();
    g.strokeStyle = '#6f1616';
    g.lineWidth = Math.max(1, r * 0.09);
    g.stroke();

    // 身体
    g.fillStyle = bodyGrad(g, cx, cy, r, color);
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fill();

    // 兜帽
    g.fillStyle = lighten(color, 0.1);
    g.beginPath();
    g.arc(cx, cy - r * 0.28, r * 0.66, 0, TAU);
    g.fill();

    // 面部阴影（半圆，压在兜帽下部）
    g.fillStyle = 'rgba(22,20,18,0.72)';
    g.beginPath();
    g.ellipse(cx, cy - r * 0.12, r * 0.42, r * 0.34, 0, 0, TAU);
    g.fill();

    // 金腰带
    g.strokeStyle = COLOR.playerFacing;
    g.lineWidth = Math.max(1.5, r * 0.13);
    g.beginPath();
    g.moveTo(cx - r * 0.62, cy + r * 0.46);
    g.quadraticCurveTo(cx, cy + r * 0.66, cx + r * 0.62, cy + r * 0.46);
    g.stroke();

    // 外圈暗红描边
    g.strokeStyle = COLOR.playerRing;
    g.lineWidth = Math.max(2, r * 0.2);
    g.beginPath();
    g.arc(cx, cy, r + 1, 0, TAU);
    g.stroke();
  }

  // 掉落物精灵（只有金币和红心会走精灵，经验球太多、走批量路径）
  // ============================================================
  // 拾取物的像素精灵
  // ============================================================
  // 矩阵来自 pixel-sprites.js 的 PIXEL_PICKUPS。调色板按物品类型给：
  // 小经验球是冷灰白、大经验球与金币走琥珀金、红心血红、宝箱木色。
  // 【为什么 keepMain】这些颜色本来就是「亮色物品」，再按怪物那套提亮 10%
  // 会把小球的白冲成纯白，与背景的高光分不开。
  //
  // ★ 精灵工厂（makePixelSprite）不在这里 —— 它要用 makeSprite，
  //   而后者在下面的渲染闭包里。放在顶层会直接 ReferenceError。
  const PICKUP_PAL = {
    exp: '#dae4ec', exp_big: '#f2c14e', gold: '#f2c14e', heart: '#d94a4a', chest: '#8a6415',
    // 神龛是石头：冷灰偏暖一点，压在暗红地面上才不会糊成一块
    shrine: '#bdb6a4',
    // 血祭坛（第四十三轮）：**同一张石龛素材**、换一套暗红调色板。
    // ★为什么不另画一张素材：形状完全一样（一座石头台子），差别只在「这是什么」——
    //   再抄一份矩阵只会多一个「改了一处忘了另一处」的机会；
    //   而颜色是玩家第一眼分辨它们的依据，所以只在颜色上分开。
    // ★比表里的 #b03a3a 再亮一点（#c2463c）：石台本体在暗红地面上本来就暗一档，
    //   直接拿表里的值上色，截图里会糊成一坨深褐（实测第一版就是这样）。
    pact: '#c2463c',
    // 引魂灯（第四十六轮）：同一张石灯笼素材（原本是地图上的障碍物"石灯笼"），
    // 换成暖金色 —— 它是"一盏点着的灯"，与冷灰的神龛、暗红的祭坛一眼分开。
    lantern: '#c9a253'
  };

  function paintGoldOrb(g, cx, cy, r) {
    const grd = g.createRadialGradient(cx - r * 0.3, cy - r * 0.35, r * 0.1, cx, cy, r);
    grd.addColorStop(0, '#fff0c0');
    grd.addColorStop(0.5, COLOR.goldOrb);
    grd.addColorStop(1, '#8a6415');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(cx, cy, r, 0, TAU);
    g.fill();
    g.strokeStyle = 'rgba(255,240,190,0.75)';
    g.lineWidth = 1;
    g.stroke();
  }

  // 宝箱（Boss 掉落）。
  // 【为什么画得这么「重」】它是全地图唯一一个「必须走过去拿」的奖励，
  // 而玩家捡它的时候通常正站在 Boss 倒下的位置 —— 周围全是怪。
  // 低对比度的箱子在这种场景里等于不存在，所以给了琥珀金箱体 + 血红的锁扣
  // 两个高对比色，再加一圈会呼吸的光晕（呼吸在调用方按帧算）。
  function paintChest(g, cx, cy, r) {
    const w = r * 1.9;          // 箱体宽
    const h = r * 1.35;         // 箱体高
    const top = cy - h * 0.85;  // 箱盖顶

    // 底影：让箱子「落在地上」而不是浮着
    bakeShadow(g, cx, cy + h * 0.95, w * 1.05, h * 0.34, 0.4);

    // 箱盖（半圆拱）
    g.fillStyle = '#8a6415';
    g.beginPath();
    g.moveTo(cx - w, top + h * 0.9);
    g.quadraticCurveTo(cx, top - h * 0.45, cx + w, top + h * 0.9);
    g.closePath();
    g.fill();

    // 箱身
    g.fillStyle = '#5d4410';
    g.fillRect(cx - w, top + h * 0.85, w * 2, h);
    // 底边压深一层，给一点体积
    g.fillStyle = 'rgba(0,0,0,0.28)';
    g.fillRect(cx - w, top + h * 1.5, w * 2, h * 0.35);

    // 琥珀金描边：暗背景上全靠它把轮廓拎出来
    g.strokeStyle = COLOR.chestTrim;
    g.lineWidth = Math.max(1.4, r * 0.16);
    g.strokeRect(cx - w, top + h * 0.85, w * 2, h);

    // 锁扣
    g.fillStyle = COLOR.chestLock;
    g.fillRect(cx - r * 0.34, top + h * 0.62, r * 0.68, r * 0.62);

    // 高光：一点就够了，多了会变成塑料质感
    g.fillStyle = 'rgba(244,196,85,0.5)';
    g.fillRect(cx - w * 0.8, top + h * 1.0, w * 0.5, Math.max(1.5, h * 0.14));
  }

  function paintHeartOrb(g, cx, cy, r) {
    // 外发光
    const halo = g.createRadialGradient(cx, cy, 0, cx, cy, r * 1.9);
    halo.addColorStop(0, 'rgba(217,74,74,0.5)');
    halo.addColorStop(1, 'rgba(217,74,74,0)');
    g.fillStyle = halo;
    g.beginPath();
    g.arc(cx, cy, r * 1.9, 0, TAU);
    g.fill();

    g.fillStyle = COLOR.heartOrb;
    g.beginPath();
    g.arc(cx - r * 0.62, cy - r * 0.4, r * 0.68, 0, TAU);
    g.fill();
    g.beginPath();
    g.arc(cx + r * 0.62, cy - r * 0.4, r * 0.68, 0, TAU);
    g.fill();
    g.beginPath();
    g.moveTo(cx - r * 1.3, cy - r * 0.05);
    g.lineTo(cx + r * 1.3, cy - r * 0.05);
    g.lineTo(cx, cy + r * 1.5);
    g.closePath();
    g.fill();
    // 高光
    dot(g, cx - r * 0.6, cy - r * 0.55, r * 0.22, 'rgba(255,220,220,0.7)');
  }

  // ============================================================
  // 创建渲染器
  // ============================================================

  function createRenderer(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d', { alpha: false });

    const R = {
      ctx: ctx,
      canvas: canvas,
      cam: { x: 0, y: 0 },
      viewW: 0,
      viewH: 0,
      dpr: 1,
      alpha: 0,
      showDebug: !!opts.debug,
      // 统计给 HUD 用。drawMs 是 draw() 自身耗时的滑动平均（毫秒），
      // 没有它就没法判断「卡」到底是渲染还是逻辑造成的。
      // teammates：本帧真正画出来的队友数（联机用）。roomcheck 靠它断言
      // 「队友确实被绘制」，而不是只看截图靠肉眼 —— 这个 bug 就是这么漏掉的。
      stat: { drawn: 0, total: 0, drawMs: 0, teammates: 0, killBursts: 0 },
      groundTex: null,
      groundTexMap: null,   // 地面纹理是哪张地图的（换图要重建）
      // ★初始值不能是 null：resize（canvas 尺寸变化时触发）会读 curMap().w，
      //   而它先于 draw 的第一帧执行。这里先给一张默认图兜底，
      //   真正开局时 buildGround 会换成房间/URL 指定的那张。
      map: (typeof window !== 'undefined' && window.VS && window.VS.MAPS)
        ? window.VS.MAPS.mapById(null) : null,
      // 精灵缓存：按 dpr 与半径建一次，之后只查表
      artDpr: 0,
      art: null,
      // 玩家精灵**按角色分别缓存**（键 = 角色id@半径@dpr）。
      // 【为什么不再是单张】8 个角色在战场上长得不一样，是「分辨队友」的主要手段。
      // 一局最多 8 人，所以缓存最多 8×1×2 = 16 个条目，不会涨。
      playerArtCache: Object.create(null),
      _world: null,
      _fps: 0,
      _fpsAcc: 0,
      _fpsCount: 0,
      _lastFrame: 0,
      _drawMs: 0,
      // 渲染自己的动画时钟：不跟着 sim 的 20Hz 时间走，
      // 这样暂停时浮字、呼吸这类纯表现的东西也不会僵住
      _animT: 0,
      _animLast: 0,
      maxMobs: C.MAX_MOBS,
      bounds: { x0: 0, y0: 0, x1: 0, y1: 0 },
      debugInfo: null
    };

    // 当前地图 —— 所有读尺寸/主题的地方都必须走它，不能直接摸 R.map。
    //
    // ★为什么需要这层兜底：R.map 有两条建立路径（创建时的默认值、buildGround 时
    //   从 world 赋值），而 resize / updateCamera / drawGround 都可能**先于**
    //   buildGround 执行（canvas 尺寸变化、页面刚打开还没进第一帧）。
    //   实测在联机页上崩过一次：Cannot read properties of undefined (reading 'w')，
    //   整页白屏、loop 中断。走这层之后最坏只是「用默认图尺寸画几帧」。
    //
    // ★它必须定义在 createRenderer **内部**（R 是这里的局部常量）。
    //   第一版我把它放在工厂函数那一层，结果 R is not defined —— 又崩一次。
    function curMap() {
      if (R.map) return R.map;
      const M = (typeof window !== 'undefined' && window.VS && window.VS.MAPS) || null;
      if (M) {
        R.map = M.mapById(null);
      } else {
        // 连 maps.js 都没加载成功时的最后兜底：形状对就行。
        // 主题色只影响地面纹理，而那种情况下地面纹理本来就建不出来。
        R.map = {
          id: 'fallback', name: '—', w: 3200, h: 2400,
          theme: {
            ground: '#3a2428', glow: 'rgba(120,24,32,0.16)', speck: 1,
            stain: 'rgba(132,20,34,', deco: 'grave'
          },
          spawn: { radius: 700 }
        };
      }
      if (R.showDebug) {
        console.log('[render] curMap 兜底：R.map=' + R.map.id + '  VS.MAPS=' +
          (M ? (M.MAPS.length + ' 张') : '未加载'));
      }
      return R.map;
    }

    // ============================================================
    // 尺寸与相机
    // ============================================================

    R.resize = function () {
      // 用设备像素比渲染，避免高分屏发虚
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = canvas.clientWidth || window.innerWidth;
      const cssH = canvas.clientHeight || window.innerHeight;

      R.dpr = dpr;
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      R.viewW = cssW;
      R.viewH = cssH;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.imageSmoothingEnabled = false;

      // dpr 变了精灵缓存的像素密度就不对了，作废重建
      R.artDpr = 0;
      R.playerArtCache = Object.create(null);
      R.orbGold = null;
      R.orbHeart = null;
      R.orbSmall = null;
      R.orbBig = null;
      R.chest = null;

      // 玩家出生在地图中心，相机先摆正，避免第一帧跳一下。
      // ★这里有两处坑，都是本轮加地图时踩的：
      //   ① R.map 可能还是 null。resize 由 canvas 尺寸变化触发，**先于** draw 的
      //      第一帧执行，而 R.map 是 buildGround 里才赋值的。第一版没判空，
      //      结果首屏直接抛 "Cannot read properties of null (reading 'w')" —— 整页白屏。
      //   ② 判断条件不能写成「groundTex 还没建」。地面纹理是**按地图**缓存的，
      //      换地图时它非 null，用旧条件会导致新地图下相机不重新居中。
      // 所以改成：只要有地图就把相机摆到它的中心。
      const m = R.map;
      if (m) {
        R.cam.x = m.w / 2 - cssW / 2;
        R.cam.y = m.h / 2 - cssH / 2;
      }
    };

    // 相机跟随：平滑逼近目标位置，并夹在地图范围内
    function updateCamera(sx, sy) {
      let tx = sx - R.viewW / 2;
      let ty = sy - R.viewH / 2;

      // 地图比视口小时居中
      const maxX = curMap().w - R.viewW;
      const maxY = curMap().h - R.viewH;
      tx = maxX <= 0 ? maxX / 2 : Math.max(0, Math.min(tx, maxX));
      ty = maxY <= 0 ? maxY / 2 : Math.max(0, Math.min(ty, maxY));

      // 平滑：帧率无关的指数逼近
      const k = 0.22;
      R.cam.x += (tx - R.cam.x) * k;
      R.cam.y += (ty - R.cam.y) * k;

      R.cam.x = maxX <= 0 ? maxX / 2 : Math.max(0, Math.min(R.cam.x, maxX));
      R.cam.y = maxY <= 0 ? maxY / 2 : Math.max(0, Math.min(R.cam.y, maxY));
    }

    // 视口裁剪边界（多留 40px 余量，避免边缘实体突然弹出）
    function computeBounds() {
      const pad = 40;
      R.bounds.x0 = R.cam.x - pad;
      R.bounds.y0 = R.cam.y - pad;
      R.bounds.x1 = R.cam.x + R.viewW + pad;
      R.bounds.y1 = R.cam.y + R.viewH + pad;
    }

    function visible(x, y, r) {
      const b = R.bounds;
      return x + r >= b.x0 && x - r <= b.x1 && y + r >= b.y0 && y - r <= b.y1;
    }

    // 插值：逻辑位置在 px/py，当前在 x/y，按 alpha 混合
    function lerp(a, b, t) {
      return a + (b - a) * t;
    }

    // ============================================================
    // 精灵缓存：建一次，之后只查表
    // ============================================================

    // 建一张精灵。paint 收到的是 CSS 像素坐标，内部已经按 dpr 缩放好了。
    function makeSprite(key, cssW, cssH, paint) {
      const dpr = R.dpr;
      const cv = newCanvas(cssW * dpr, cssH * dpr);
      const g = cv.getContext('2d');
      g.scale(dpr, dpr);
      paint(g, cssW / 2, cssH / 2);
      return { cv: cv, hw: cssW / 2, hh: cssH / 2, key: key };
    }

    // 拾取物的像素精灵工厂。
    // 【为什么放在这个闭包里】它要用上面的 makeSprite —— 而 makeSprite 是闭包内的
    // 函数，顶层的绘制函数（paintGoldOrb 那些）根本看不见它。
    // 这一处踩过：把工厂写在顶层，页面加载即 ReferenceError（自动化会直接抓到
    // 「页面有未捕获异常」那一条，但如果不看那条，表现只是「掉落物全都不见了」）。
    function makePixelSprite(key, artKey, px) {
      const PXp = (typeof window !== 'undefined' && window.VS && window.VS.PIXEL) || null;
      const TABLE = (typeof window !== 'undefined' && window.VS && window.VS.PIXEL_PICKUPS) || null;
      const art = TABLE ? TABLE[artKey] : null;
      if (!PXp || !art) return null;
      const pal = PXp.paletteFor(PICKUP_PAL[artKey] || '#dae4ec', { keepMain: true });
      return makeSprite('pick_' + key, art[0].length * px, art.length * px, function (g, cx, cy) {
        PXp.drawCentered(g, art, cx, cy, px, pal);
      });
    }

    // 旋转图集：把同一形状转到 N 个角度各存一张
    function makeRotAtlas(prefix, cssSize, r, color, paintFn) {
      const arr = [];
      for (let i = 0; i < ROT_STEPS; i++) {
        const ang = (TAU / ROT_STEPS) * i;
        arr.push(makeSprite(prefix + '#' + i, cssSize, cssSize, function (g, cx, cy) {
          g.translate(cx, cy);
          g.rotate(ang);
          g.translate(-cx, -cy);
          paintFn(g, cx, cy, r, color);
        }));
      }
      return arr;
    }

    // 「像素椭圆」影子：3 个方块拼出来，中间宽、上下窄。
    // 【为什么不用 ctx.ellipse】椭圆是矢量边缘，和像素怪的锯齿边放一起会
    // 明显「两个世界」；方块拼的影子边缘同样对齐像素网格，风格才统一。
    function pixelShadow(g, x, y, rx, ry) {
      const h = Math.max(1, Math.round(ry * 2 / 3));
      const x0 = Math.round(x - rx);
      const w = Math.round(rx * 2);
      g.fillStyle = 'rgba(0,0,0,0.34)';
      g.fillRect(x0 + Math.round(w * 0.18), Math.round(y - h * 1.5), Math.round(w * 0.64), h);
      g.fillRect(x0, Math.round(y - h * 0.5), w, h);
      g.fillRect(x0 + Math.round(w * 0.18), Math.round(y + h * 0.5), Math.round(w * 0.64), h);
    }

    // ============================================================
    // 怪物精灵（像素画风，本轮重做）
    // ============================================================
    // 【为什么要重做】旧画法是「一个圆球 + 两只眼睛 + 一点装饰」（arc / ellipse 拼的），
    // 单只看还行，铺满一屏（后期几百只）就是**一片表情包**：所有怪都是圆脸加眼睛，
    // 远看只有颜色差别。像素点阵能画出骨架动作 —— 蝙蝠展开的翼、蜘蛛散开的八条腿、
    // 扛剑的骷髅、蹲着的带翼石兽 —— 这些在小尺寸下比任何细节都管用。
    //
    // 影子烘焙进精灵（像素风的影子本身也是方块拼的，见 pixelShadow）。
    // 旧画法里「旋转类怪的影子运行时批量画」那套只留给 legacy 兜底路径用。
    function buildMobArt(def) {
      const PX = (typeof window !== 'undefined' && window.VS && window.VS.PIXEL) || null;
      const TABLE = (typeof window !== 'undefined' && window.VS && window.VS.PIXEL_MOBS) || null;
      const art = TABLE ? TABLE[def.id] : null;

      // 素材没加载成功（旧版缓存页面 / 手改包）就退回旧的矢量画法，至少不裂图
      if (!PX || !art) return buildMobArtLegacy(def);

      const cols = art[0].length;
      const isBoss = def.tier === 'boss';
      const isBig = def.tier === 'elite' || def.tier === 'commander';
      // 视觉外扩系数：目标是让三档的**成品宽度**拉开（小怪约 48、精英约 80、Boss 约 160 CSS 像素），
      // 同时保住「越大的东西格子越粗」这条像素游戏惯例（小怪 3 设备像素/格、精英 4、Boss 8）。
      //
      // 【为什么要反复试这几个数，而不是拍一个好看的倍率】每格宽必须在**设备像素上取整**
      //（否则格子内部被劈到两个像素上，渲染器插值，整只怪发灰），
      // 于是尺寸是「量子化」的：spread 差 0.1 可能成品宽度整整差一档。
      // 这几个值是照着「像素 3 / 4 / 8」反推出来的，别当成随手调的魔法数。
      const spread = isBoss ? 4.0 : (isBig ? 4.4 : 3.0);
      // 每格宽在**设备像素**上取整（pxFor 里做）—— 否则 dpr=2 时一个格子内部
      // 会被分到两个设备像素上，渲染器插值，整只怪边缘发灰。
      const px = PX.pxFor(def.r, cols, spread, R.dpr);
      // 外部 MIT 素材带专属调色板（已从素材中位色提取并过滤紫色）。
      // 只覆盖素材里实际出现的槽位，其余仍走项目主色，保证描边/高光统一。
      const extPal = (typeof window !== 'undefined' && window.VS &&
        window.VS.PIXEL_MOB_PALS && window.VS.PIXEL_MOB_PALS[def.id]) || null;
      const pal = extPal ? Object.assign(PX.paletteFor(def.color), extPal) : PX.paletteFor(def.color);

      const size = Math.ceil(cols * px / 2 + 2) * 2;
      const pack = { rot: false, px: px, cols: cols };

      const paintAll = function (g, cx, cy) {
        pixelShadow(g, cx, cy + def.r * 0.82, def.r * 1.05, def.r * 0.42);
        PX.drawCentered(g, art, cx, cy, px, pal);
      };

      pack.body = makeSprite(def.id, size, size, paintAll);
      pack.flash = { cv: makeFlashVariant(pack.body.cv), hw: pack.body.hw, hh: pack.body.hh };

      if (FACING_MOBS[def.id]) {
        pack.bodyL = makeSprite(def.id + '#L', size, size, function (g, cx, cy) {
          g.translate(size, 0);
          g.scale(-1, 1);
          paintAll(g, cx, cy);
        });
        pack.flashL = { cv: makeFlashVariant(pack.bodyL.cv), hw: pack.bodyL.hw, hh: pack.bodyL.hh };
      }

      // 影子已经烘焙进精灵了，这三个字段只给 legacy 路径的批量影子用
      pack.shadowRx = def.r * 1.05;
      pack.shadowRy = def.r * 0.42;
      pack.shadowDy = def.r * 0.82;
      return pack;
    }

    // ---------- 旧的矢量画法（只作兜底，正常不会走到） ----------
    // 每个怪种的「美术包」：本体 + 闪白变体（+ 旋转图集）
    // 注意：飞行单位（血蝠）不烘焙影子 —— 空中单位地上有影子反而假，
    // 而且它也走旋转图集，影子会跟着一起转。
    function buildMobArtLegacy(def) {
      const r = def.r;
      const color = def.color;
      // 精灵包围盒按「每种形状真正的最大外扩」单独算，不能图省事统一放大：
      // 800 只怪时包围盒面积直接等于每帧要 blit 的像素量，
      // 早先统一多留 8px 余量，实测白 blit 了将近一倍面积（大片透明像素照样要走光栅）。
      const pad = 2;
      let half;
      let paintFn;
      let rot = false;

      if (def.id === 'corpse') {
        half = r * 1.4 + pad; paintFn = paintCorpse;          // 双臂 + 圆头线性端点
      } else if (def.id === 'bat') {
        half = r * 1.75 + pad; paintFn = paintBat; rot = true; // 翼尖在 ±1.62r
      } else if (def.id === 'skeleton_warrior') {
        half = r * 1.75 + 3; paintFn = paintSkeletonWarrior;   // 剑尖在 +1.67r
      } else if (def.id === 'gargoyle') {
        half = r * 1.95 + 3; paintFn = paintGargoyle;          // 石翼在 ±1.85r
      } else if (def.id === 'blood_priest') {
        half = r * 2.1 + 3; paintFn = paintBloodPriest;        // 兜帽顶到 -2.0r
      } else if (def.id === 'witch_hunter') {
        half = r * 1.45 + 3; paintFn = paintWitchHunter; rot = true;  // 枪尖 +1.28r
      } else if (def.id === 'blood_lord') {
        // 领主也走统一的 Boss 骨架（style='lord'）——
        // 四只 Boss 各写一套的话，以后调体型要改四个地方。
        half = r * 1.85 + 4;
        paintFn = function (g, cx, cy, rr, col) {
          paintBossStyled(g, cx, cy, rr, col, 'lord');
        };
      } else if (def.id === 'plague_hound') {
        half = r * 1.4 + pad; paintFn = paintPlagueHound;      // 吻部在 ±1.27r
      } else if (def.id === 'blood_spider') {
        half = r * 1.8 + 3; paintFn = paintBloodSpider;        // 腿尖 ±1.72r
      } else if (def.id === 'bone_knight') {
        half = r * 1.65 + 3; paintFn = paintBoneKnight;        // 锤头 +1.56r
      } else if (def.id === 'ghoul_matriarch') {
        half = r * 1.6 + 3; paintFn = paintGhoulMatriarch;     // 躯干 ±1.1r + 小手
      } else if (def.tier === 'boss') {
        // 四只 Boss 共用一套骨架，头饰 / 武器 / 符环按 bossStyle 换。
        // 包围盒按最高的那只留（女王的王冠到 -1.56r、血珠再到 -1.67r）。
        half = r * 1.85 + 4;
        // 闭包捕获 style：paintFn 的统一签名是 (g, cx, cy, r, color)
        const bossStyle = def.bossStyle || 'lord';
        paintFn = function (g, cx, cy, rr, col) {
          paintBossStyled(g, cx, cy, rr, col, bossStyle);
        };
      } else {
        half = r * 1.5 + pad; paintFn = paintCorpse;
      }

      const size = half * 2;
      // 半径与配色在这里就被 paint 闭包捕获，不依赖调用方传参，少一处出错机会
      const draw = function (g, cx, cy) { paintFn(g, cx, cy, r, color); };
      const pack = { rot: rot, half: half, noShadow: def.id === 'bat' };

      if (rot) {
        // 旋转类：影子不能烘焙进精灵（会跟着转），运行时统一批一次
        pack.atlas = makeRotAtlas(def.id, size, r, color, paintFn);
        pack.atlasFlash = pack.atlas.map(function (s) {
          return { cv: makeFlashVariant(s.cv), hw: s.hw, hh: s.hh };
        });
      } else {
        pack.body = makeSprite(def.id, size, size, draw);
        pack.flash = { cv: makeFlashVariant(pack.body.cv), hw: pack.body.hw, hh: pack.body.hh };
      }

      // 影子尺寸，给旋转类的批量阴影用。
      // 判 tier 而不是判 id：现在有四只 Boss，写死 blood_lord 的话
      // 另外三只的影子会按小怪的尺寸画（脚下一个小圈，看着像浮空）。
      const isBoss = def.tier === 'boss';
      pack.shadowRx = isBoss ? r * 1.6 : r * 1.05;
      pack.shadowRy = isBoss ? r * 0.5 : r * 0.4;
      pack.shadowDy = (def.id === 'blood_lord') ? r * 0.78 : r * 0.9;

      return pack;
    }

    function ensureArt() {
      if (R.art && R.artDpr === R.dpr) return;
      R.artDpr = R.dpr;
      const art = {};
      for (let i = 0; i < C.MOBS.length; i++) {
        const def = C.MOBS[i];
        art[def.id] = buildMobArt(def);
      }
      R.art = art;
      if (R.showDebug) {
        console.log('[render] 精灵缓存已建立 dpr=' + R.dpr + ' 怪种=' + C.MOBS.length +
          ' 旋转图集挡位=' + ROT_STEPS);
      }
    }

    // 取（必要时生成）某个角色的战场精灵。
    //
    // 【为什么按角色分别烘焙】玩家本体现在是按 charId 画不同形象的（见 player-art.js），
    // 如果继续共用一张精灵，多人局里四个人还是长得一模一样 —— 那正是要解决的问题。
    // 每个角色烘一张，绘制时按快照里的 charId 取，代价只有一次查表。
    //
    // 尺寸比原来放大了一点（2.0r → 2.3r）：骑士的圆盾伸到 1.42r、铁匠的锤头到 1.62r、
    // 巫女的尖帽到 1.62r —— 画布不够大的话这些特征会被裁掉半个，
    // 结果是「明明画了却看不出来」。
    function ensurePlayerArt(r, charId) {
      const id = charId || 'hunter';
      const rr = Math.round(r * 10) / 10;
      const key = id + '@' + rr + '@' + R.dpr;

      const hit = R.playerArtCache[key];
      if (hit) return hit;

      const half = rr * 2.3 + 10;
      const size = half * 2;

      // ★三帧动作全部在**烘焙阶段**画好，运行时只按序号 drawImage。
      //   16×16 里画不出手臂摆动，所以用整块精灵的「压扁 / 前冲」来读动作：
      //   小尺寸下轮廓变了，比多画两个像素更容易被眼睛捕捉。
      //   0 站姿 / 1 迈步与蓄力 / 2 挥出。★绝不每帧重画点阵（几百只怪同屏会崩）。
      // ★帧参数只有 player-art.js 一份；这里读它，不在渲染层复制数值。
      //   PLAYER_ART 没加载时只留一帧静止（不崩，但也不假装动起来了）。
      const VARIANTS = (window.VS.PLAYER_ART && window.VS.PLAYER_ART.frames) ||
        [{ sx: 1, sy: 1, dy: 0 }];
      const frames = [];
      for (let f = 0; f < VARIANTS.length; f++) {
        const V = VARIANTS[f];
        const sp = makeSprite('player_' + id + '#f' + f, size, size, function (g, cx, cy) {
          g.save();
          g.translate(cx, cy + V.dy);
          g.scale(V.sx, V.sy);
          g.translate(-cx, -cy);
          const PA = window.VS && window.VS.PLAYER_ART;
          // 兜底：PLAYER_ART 没加载成功时退回老画法，至少不裂图
          if (PA) PA.paint(g, id, cx, cy, rr);
          else paintPlayer(g, cx, cy, rr, COLOR.player);
          g.restore();
        });
        frames.push({
          cv: sp.cv, hw: sp.hw, hh: sp.hh,
          // 每帧各烘一张闪白：受击时姿态不该被强行拉回站姿
          flash: makeFlashVariant(sp.cv)
        });
      }

      const entry = {
        // 这三个字段保留给旧调用路径，等价于第 0 帧
        cv: frames[0].cv, hw: frames[0].hw, hh: frames[0].hh,
        flash: { cv: frames[0].flash, hw: frames[0].hw, hh: frames[0].hh },
        frames: frames
      };
      R.playerArtCache[key] = entry;
      return entry;
    }

    // ============================================================
    // 地面
    // ============================================================

    // 地面纹理用固定种子，不跟世界的随机种子走。两个好处：
    //   1. 建一次就够，"重开一局"不用再花上百毫秒重建；
    //   2. 每局地图长得一样，玩家能记住地形（竞技场类游戏都这么处理）。
    const GROUND_SEED = 0x51ab7c;

    // 预建地面纹理。开局前调一次，避免在游戏中第一帧卡一下。
    R.buildGround = function (w) {
      R._world = w || null;
      R.map = w ? w.map : null;
      // ★纹理是**按地图**缓存的：第一版「建过就复用」，换地图后会在新图上
      //   铺着旧图的地面纹理 —— 尺寸也不对（一张 3800 宽的纹理贴到 2600 的图上）。
      const mapId = R.map ? R.map.id : '';
      if (R.groundTex && R.groundTexMap === mapId) return R.groundTex;
      R.groundTexMap = mapId;
      R.groundTex = R.map ? buildGroundTexture(R.map, GROUND_SEED) : null;
      if (R.showDebug) {
        console.log('[render] 地面纹理 ' + (R.groundTex
          ? (R.groundTex.width + 'x' + R.groundTex.height + '（整张预渲染）')
          : '未生成，回退逐帧程序化绘制'));
      }
      return R.groundTex;
    };

    function drawGround() {
      const tex = R.groundTex;

      // 源矩形自己夹一次：相机虽然被夹在地图内，但视口比地图大时 cam 会是负数
      let sx = 0, sy = 0, ex = 0, ey = 0, cover = false;
      if (tex) {
        sx = Math.max(0, R.cam.x);
        sy = Math.max(0, R.cam.y);
        ex = Math.min(curMap().w, R.cam.x + R.viewW);
        ey = Math.min(curMap().h, R.cam.y + R.viewH);
        // 纹理铺满整个视口时就不必再铺一层底色 —— 那是一次全屏像素写入
        cover = ex > sx && ey > sy &&
          sx <= R.cam.x + 0.5 && sy <= R.cam.y + 0.5 &&
          ex >= R.cam.x + R.viewW - 0.5 && ey >= R.cam.y + R.viewH - 0.5;
      }

      if (!cover) {
        // 底色铺满：地图小于视口（或还没建好纹理）时不会露出空白
        ctx.fillStyle = COLOR.ground;
        ctx.fillRect(0, 0, R.viewW, R.viewH);
      }

      if (!tex) {
        // 兜底：整图纹理建失败时（地图过大 / 内存不足）只画网格与边框，
        // 保证场景还能跑，不至于露出一整块死黑
        ctx.save();
        ctx.translate(-R.cam.x, -R.cam.y);
        const step = 160;
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255,255,255,0.035)';
        ctx.beginPath();
        for (let x = Math.floor(R.cam.x / step) * step; x <= R.cam.x + R.viewW; x += step) {
          ctx.moveTo(x, R.cam.y); ctx.lineTo(x, R.cam.y + R.viewH);
        }
        for (let y = Math.floor(R.cam.y / step) * step; y <= R.cam.y + R.viewH; y += step) {
          ctx.moveTo(R.cam.x, y); ctx.lineTo(R.cam.x + R.viewW, y);
        }
        ctx.stroke();
        ctx.strokeStyle = COLOR.border;
        ctx.lineWidth = 6;
        ctx.strokeRect(0, 0, curMap().w, curMap().h);
        ctx.restore();
        return;
      }

      if (ex <= sx || ey <= sy) return;

      // 只把可见的那一块从整图里拷过来
      // 高 dpr 下纹理会被放大，开一次平滑，免得网格线与裂纹出现台阶
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tex, sx, sy, ex - sx, ey - sy,
        sx - R.cam.x, sy - R.cam.y, ex - sx, ey - sy);
      ctx.imageSmoothingEnabled = false;
    }

    // ============================================================
    // 实体
    // ============================================================

    // 障碍物：画在世界空间的最底层（怪之下）
    // ----------------------------------------------------------
    // 【为什么在怪之下】怪撞不过障碍（分轴滑动），它们永远待在障碍**外面**。
    // 画在怪之上等于告诉玩家「怪藏在墙后面」——那是假的。
    // 【为什么不在地面纹理里画】障碍是「和碰撞半径绑定的点阵」，
    //   要按 r 换算格宽；而地面纹理是固定尺寸的一次性大图，两者对不上。
    //   代价是每帧要遍历一次障碍列表（20~36 个，可见性剔除后更少），
    //   这个开销可以忽略。
    function drawObstacles(w) {
      const list = w.obstacles;
      if (!list || !list.length) return;
      const PXp = (typeof window !== 'undefined' && window.VS && window.VS.PIXEL) || null;
      const TABLE = (typeof window !== 'undefined' && window.VS && window.VS.PIXEL_OBSTACLES) || null;
      const KINDS = (typeof window !== 'undefined' && window.VS && window.VS.MAPS && window.VS.MAPS.OBSTACLE_KINDS) || null;
      if (!PXp || !TABLE || !KINDS) return;

      // 视野外的不画（列表很短，简单剔除就够，不必上网格）
      const pad = 90;
      const x0 = R.cam.x - pad;
      const y0 = R.cam.y - pad;
      const x1 = R.cam.x + R.viewW + pad;
      const y1 = R.cam.y + R.viewH + pad;

      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.x + o.r < x0 || o.x - o.r > x1 || o.y + o.r < y0 || o.y - o.r > y1) continue;
        const art = TABLE[o.kind] || TABLE.grave;
        const cols = art[0].length;
        // 格宽取整到 ≥2：像素画放大后每格必须落在整数设备像素上，
        // 否则点与点之间被插值，边缘立刻发糊（同 render 里怪物的做法）。
        const px = Math.max(2, Math.round(o.r * 2 / cols));
        const def = KINDS[o.kind] || KINDS.grave;
        // 影子：跟着一起放大，位置偏右下（默认光从左上来）
        pixelShadow(ctx, o.x, o.y + o.r * 0.34, o.r * 0.9, o.r * 0.4);
        // ★优先用「这张地图自己的障碍色」（maps.js 的 obTheme，生成时就写进每个障碍）。
        //   没有它才按 kind 取全局默认色 —— 那是同一种石头在四张不同底色的地图上
        //   硬套一个值，钟楼广场上墙和地只差 7 个色阶，等于看不见。
        // ★必须显式传 edge / hi：paletteFor 的默认描边是「带紫的深黑」、
        //   默认高光是暖白 —— 用在石头上会又紫又脏，违反项目禁紫的约定。
        PXp.drawCentered(ctx, art, o.x, o.y, px,
          PXp.paletteFor(o.color || def.solid, {
            keepMain: true,
            edge: o.edge || def.edge,
            hi: o.hi || def.hi
          }));
      }
    }

    // 地面持续区域（圣水 / 血雨 / 冰封 / 圣裁之地…）
    //
    // 【为什么改】原来是「实心圆 + 描边 + 一个内圈」三个同心圆，而且**静止不动** ——
    //   所有区域技长得一样（只差颜色），在一屏怪里还容易被当成地板贴图。
    // 现在加三样动效，全部**不引入新色**（禁紫的约定在 COLOR 里已经守住）：
    //   ① 外圈呼吸：半径随正弦轻微脉动 —— 读起来像「这片区域是活的」
    //   ② 旋转虚线环：靠 lineDashOffset 让边界滚动，静止圆环糊进地面时它还能看清
    //   ③ 中心亮斑：告诉玩家「力量的源头在这儿」
    function drawZones(w, alpha) {
      const list = w.zones;
      const t = w.time;
      for (let i = 0; i < list.length; i++) {
        const z = list[i];
        // 判定放宽 8px：外圈要呼吸，刚好贴边时不该整块消失
        if (!visible(z.x, z.y, z.r + 8)) continue;

        const evolved = z.color === '#ffd166';
        // ★星火（第四十轮）：陨星砸出来的燃烧区。
        //   它是全项目唯一一个「火」的区域，其余都是圣水 —— 如果照圣水那套画，
        //   玩家看到的是一片冷灰的水洼（截图当场发现），语义完全相反。
        //   所以这里按颜色分流：暖底 + 琥珀虚线环 + 不铺涟漪贴花。
        //   ★颜色仍然是数据（z.color），不是在这里写死一个隐形的 if (kind === ...)。
        const isFire = z.color === '#ff8c42';
        // ---------- 镇妖钟的钟声圈（第四十九轮）----------
        // 【为什么也按颜色分流】zones 的字段表里没有 kind（只有 color），
        //   所以「这是哪一种区域」只能从颜色读出来 —— 与上面星火那条完全同一条路子。
        // 【为什么必须单独一支】钟声圈是**声场**，不是水洼也不是火：
        //   走圣水那一套（涟漪贴花 + 三道同心圆 + 中心亮斑）会被读成
        //   「地上有一滩水，踩上去大概会掉血」—— 而这个圈恰恰是**安全**的
        //   （它只牵引妖物，对玩家一点伤害都没有）。语义反了比不好看严重得多。
        const isBellRing = !!(C && C.BELL && z.color === C.BELL.ringColor);
        const bellCol = (C && C.BELL && C.BELL.ringColor) || '#e8d9b8';
        // 剩余时间越少画得越淡，给玩家「快没了」的提示
        const fade = Math.min(1, z.life / Math.max(0.001, z.maxLife));
        const pulse = 1 + Math.sin(t * 4 + i * 1.7) * 0.035;

        // 贴花（第二十八轮）：把 pixelfx 的水面效果按区域颜色重上色铺在圈里。
        // ★用「涟漪」而不是「毒潭」：毒潭是**侧视的浅水洼**（库里内容宽度只有 42px，
        //   画出来是一条薄片），铺进俯视的圆形区域里只剩底边一道水痕 —— 截图当场发现。
        //   涟漪是俯视的水面环纹，正好盖住整个圆，语义也对（水做的区域）。
        // ★净瓶甘露 = 冷灰 → 偏青白的水面；进化后的甘露 = 琥珀金 → 发光金水。
        //   效果只是表现，区域的伤害/范围/寿命一概没变。
        //   库没加载或没就绪时这里返回 false，下面那套三同心圆照常画，等于自动降级。
        const PR = window.VS.PropLayer;
        if (!isFire && !isBellRing && PR && PR.drawDecal) {
          PR.drawDecal(ctx, {
            key: 'zone' + z.id,
            kind: 'ripples',
            pal: evolved ? 'gold' : 'water',
            x: z.x, y: z.y,
            radius: z.r * pulse,
            alpha: 0.34 + 0.42 * fade,
            dt: R._animDt
          });
        }

        ctx.globalAlpha = 0.42 + 0.5 * fade;
        if (isFire) {
          // 中心亮、边缘暗的暖光：看起来像「地上还在烧」，而不是一汪水
          const fg = ctx.createRadialGradient(z.x, z.y, z.r * 0.15, z.x, z.y, z.r * pulse);
          fg.addColorStop(0, 'rgba(255,190,110,0.55)');
          fg.addColorStop(0.55, 'rgba(214,88,42,0.30)');
          fg.addColorStop(1, 'rgba(120,32,18,0.05)');
          ctx.fillStyle = fg;
        } else if (isBellRing) {
          // 钟声：**中间几乎全透、只在外沿发亮** —— 它是一片"声场"，不是一摊东西。
          // 铺满的实心圆会把这一整片地面压暗，玩家会以为踩进去要掉血。
          const g2 = ctx.createRadialGradient(z.x, z.y, z.r * 0.55, z.x, z.y, z.r * pulse);
          g2.addColorStop(0, rgbaOf(bellCol, 0.02));
          g2.addColorStop(0.75, rgbaOf(bellCol, 0.10));
          g2.addColorStop(1, rgbaOf(bellCol, 0.03));
          ctx.fillStyle = g2;
        } else {
          ctx.fillStyle = evolved ? COLOR.zoneFillEvolved : COLOR.zoneFill;
        }
        ctx.beginPath();
        ctx.arc(z.x, z.y, z.r * pulse, 0, TAU);
        ctx.fill();

        // 旋转虚线环：save/restore 把 setLineDash 一起还原，避免漏出去影响后续描边
        ctx.strokeStyle = isFire ? '#ffcf5c'
          : (isBellRing ? bellCol : (evolved ? COLOR.zoneEdgeEvolved : COLOR.zoneEdge));
        ctx.lineWidth = 2;
        ctx.save();
        // 钟声的虚线走得慢一点（声波不像水在流）：钟声用 4/-10 的低速偏移
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = isBellRing ? -t * 8 : -t * 22;
        ctx.beginPath();
        ctx.arc(z.x, z.y, z.r * pulse, 0, TAU);
        ctx.stroke();
        ctx.restore();

        // ---------- 钟声：一圈一圈往外推的声波 ----------
        // ★这一支是「还在响」的唯一表现。只画一条边界环的话，
        //   "正在牵引"与"马上要消失"在画面上分不出来（双碑那轮也是靠单独一记特效解决的）。
        if (isBellRing) {
          for (let k = 0; k < 3; k++) {
            const ph = ((t * 0.55 + k / 3) % 1);
            const rr = z.r * (0.25 + ph * 0.72);
            ctx.globalAlpha = (1 - ph) * 0.34 * fade;
            ctx.strokeStyle = bellCol;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(z.x, z.y, rr, 0, TAU);
            ctx.stroke();
          }
          ctx.globalAlpha = 0.42 + 0.5 * fade;
        }

        // 内圈待机环：与外圈反相呼吸（一个涨一个缩），看起来像在「转」
        // ★钟声圈不画这一环：它自己已经有那三道外推的声波了，再叠一条反相呼吸的环
        //   会读成「水在打旋」（这一支本来就是圣水那套语言的残留）。
        if (!isBellRing) {
          ctx.globalAlpha = 0.3 * fade;
          ctx.beginPath();
          ctx.arc(z.x, z.y, z.r * 0.6 * (2 - pulse), 0, TAU);
          ctx.stroke();
        }

        // 中心亮斑
        // ★★钟声圈**不许画这个亮斑**：它的半径是 r×0.14，而钟声圈的 r 是 460 ——
        //   换算下来是一个半径 64px 的实心素白圆盘，正好把钟本身糊掉
        //   （截图里钟身、碑名全被那块浅色圆盘盖住，看着像"地上有一洼水"）。
        //   圣水那种 zone 的 r 只有 60~120，0.14 倍才是一个小亮点，这里不是同一个量级。
        if (!isBellRing) {
          ctx.globalAlpha = 0.5 * fade;
          ctx.fillStyle = isFire ? '#ffcf5c'
            : (evolved ? COLOR.zoneEdgeEvolved : COLOR.zoneEdge);
          ctx.beginPath();
          ctx.arc(z.x, z.y, Math.max(3, z.r * 0.14) * pulse, 0, TAU);
          ctx.fill();
        }

        ctx.globalAlpha = 1;
      }
    }

    // 经验球光晕的开关阈值：屏幕上的经验球多于这个数就关掉光晕。
    // 光晕能让掉落物在暗底上更醒目，但它是「第二趟全屏绘制」，
    // 后期地上一大片经验球时光晕会成为纯浪费 → 按数量自适应。
    const ORB_HALO_MAX = 140;

    function drawPickups(w, alpha) {
      const list = w.pickups;

      // 先数一遍：这一趟只做可见性判断和计数，不做任何绘制，开销可以忽略
      let nExp = 0;
      let nExpBig = 0;
      let nOther = 0;
      let nChest = 0;
      let nShrine = 0;
      let nPact = 0;
      let nLantern = 0;
      let nBoon = 0;
      let nBell = 0;
      let nEscort = 0;
      let nMarket = 0;
      let nCauldron = 0;
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!visible(it.x, it.y, 12)) continue;
        if (it.kind === 'exp') { if (it.big) nExpBig += 1; else nExp += 1; }
        else if (it.kind === 'chest') nChest += 1;
        else if (it.kind === 'shrine') nShrine += 1;
        else if (it.kind === 'pact') nPact += 1;
        // ★引魂灯必须单独计数：漏了它就会掉进下面的 nOther，
        //   而 nOther 那一支只画 gold / heart —— 于是三盏灯**一盏都画不出来**，
        //   玩家收到"引魂灯亮起"的提示却看不见地上有东西（静默级坑）。
        else if (it.kind === 'lantern') nLantern += 1;
        // ★歧路双碑同理（第四十八轮）：掉进 nOther 就一座碑都不画，
        //   而它恰恰是"你必须在两座之间选一座" —— 看不见等于这个机制不存在。
        else if (it.kind === 'boon') nBoon += 1;
        // ★镇妖钟同理（第四十九轮）：它是「走过去踩一下」的开关，
        //   掉进 nOther 就一口钟都不画 —— 玩家收到"镇妖钟立于此处"的提示，
        //   却看不见地上有东西，只能对着空地乱走（引魂灯那轮踩过的同一个坑）。
        else if (it.kind === 'bell') nBell += 1;
        // ★精卫（第五十一轮）同理：掉进 nOther 就一只都不画 ——
        //   而她是"你必须跟住的那个目标"，看不见就等于这个机制从不发生
        //   （引魂灯 / 双碑 / 钟都踩过这同一个坑）。
        else if (it.kind === 'escort') nEscort += 1;
        // ★大人之市（第五十二轮）同理：掉进 nOther 就一座摊子都不画 ——
        //   它是"你要走过去掏钱"的东西，看不见的话玩家只会收到一条
        //   "大人之市开市"的提示，然后在空地上走两圈（引魂灯/双碑/钟/精卫
        //   四个都已经踩过这同一个坑，这是第五次）。
        else if (it.kind === 'market') nMarket += 1;
        // ★炼魂鼎（第五十三轮）同理：掉进 nOther 就一座鼎都不画 ——
        //   它是"你要走过去拿修为换命"的东西，看不见就等于这个机制不存在
        //   （引魂灯/双碑/钟/精卫/大市都已经踩过这同一个坑，这是第六次）。
        else if (it.kind === 'cauldron') nCauldron += 1;
        else nOther += 1;
      }
      if (!nExp && !nExpBig && !nOther && !nChest && !nShrine && !nPact && !nLantern && !nBoon && !nBell && !nEscort && !nMarket && !nCauldron) return;

      // ---------- 血祭坛（第四十三轮）----------
      // 【为什么与神龛分开画】两者用的是同一张石台素材（见 pixel-sprites 的说明），
      //   唯一的差别必须靠**画法**做出来，否则玩家会把「要付账的」当成「白给的」踩上去：
      //     · 神龛：冷灰石台 + **向上**的金色光柱（有东西在往上冒）
      //     · 血祭坛：暗红石台 + **倒悬**的血柱（有东西在往地里渗）+ 脚下一圈血色符环
      //   方向相反是这里最省事也最好认的一条区分（一张图两个物件同时出现时，
      //   玩家一眼就能分出「哪个是给我的、哪个是跟我要东西的」）。
      // ★末尾 3 秒开始整体淡出：它是 18 秒就沉回去的临时点位，
      //   不给这个预告的话，玩家走过去时它刚好消失，会以为是自己点错了。
      if (nPact) {
        const PC = (C && C.BLOODPACT) || { color: '#b03a3a', lifeSec: 18 };
        const pulse = 0.5 + 0.5 * Math.sin((R._animT || 0) * 3.4);
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'pact') continue;
          if (!visible(it.x, it.y, 56)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          const col = PC.color || '#b03a3a';
          // 淡出：最后 3 秒线性收到 0.25（不给 0：完全消失会像「凭空没了」）
          // ★联机时快照里的掉落物**不带 life**（字段表里没有它，见 proto_bin 的 pickups），
          //   所以那时 fade 恒为 1 —— 宁可少了这个预告，也不为了它往协议里加一个字节：
          //   祭坛总共只活 18 秒，玩家心里有数。
          const fade = it.life === undefined ? 1 : Math.max(0.25, Math.min(1, it.life / 3));

          // ① 脚下血色符环：比神龛那圈更"抖"（快速呼吸），暗示它是活的、会走
          ctx.globalAlpha = (0.10 + pulse * 0.10) * fade;
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.ellipse(x, y + 6, 32 + pulse * 4, 13 + pulse * 1.6, 0, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = (0.55 + pulse * 0.3) * fade;
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.ellipse(x, y + 6, 32 + pulse * 4, 13 + pulse * 1.6, 0, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;

          // ② 倒悬血柱：从石台上方 20px 往下渗到地面（与神龛的上升光柱方向相反）。
          //    ★用 createLinearGradient 且每帧重建（同屏最多一座，代价可忽略）。
          //    ★透明度比神龛那道光柱高（0.42 vs 0.18）：它压在一块暗红地面上，
          //      按神龛那套强度画出来几乎看不见（第一版截图里就是一片糊）。
          const beamTop = y - 18;
          const beamH = 70;
          const g = ctx.createLinearGradient(x, beamTop, x, beamTop + beamH);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(0.55, col);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalAlpha = (0.42 + pulse * 0.22) * fade;
          ctx.fillStyle = g;
          ctx.fillRect(x - 9, beamTop, 18, beamH);
          ctx.globalAlpha = 1;

          // ③ 石台本体（暗红调色板那一张，见 PICKUP_PAL.pact）
          const sp = R.pactSprite || (R.pactSprite = makePixelSprite('pact', 'pact', 3));
          if (sp) {
            ctx.globalAlpha = fade;
            ctx.drawImage(sp.cv, Math.round(x - sp.hw), Math.round(y - sp.hh) + 4,
              sp.hw * 2, sp.hh * 2);
            ctx.globalAlpha = 1;
          }

          // ④ 顶上的菱形符文：与神龛同一个造型、同一个位置，**颜色不同**——
          //    「这是一类东西（可以走上去领的点位），但不是同一种」。
          const by = y - 52 + Math.sin((R._animT || 0) * 3.0) * 2;
          ctx.globalAlpha = 0.85 * fade;
          ctx.beginPath();
          ctx.moveTo(x, by - 7);
          ctx.lineTo(x + 6, by);
          ctx.lineTo(x, by + 7);
          ctx.lineTo(x - 6, by);
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(16,10,10,0.75)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // ⑤ 名字：血祭坛是**要付代价**的，光看颜色不够 —— 必须让它自己说出身份，
          //    否则玩家会以为又是一座白给的神龛，踩上去掉上限才发现不对。
          //    ★跟着 fade 一起淡出，但**不设「淡到一定程度就不画」的阈值**：
          //      第一版写了 `if (fade > 0.5)`，结果剩 1.5 秒时名字会「啪」一下消失
          //      （刚好跨过阈值那一帧），看着像渲染出错。渐隐才是它该有的样子。
          //    ★save/restore 必须成对：字体与对齐是画布全局状态，漏了 restore
          //      后面所有伤害飘字都会跟着歪（挑战者那一轮踩过同款）。
          ctx.save();
          ctx.globalAlpha = 0.9 * fade;
          ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillStyle = 'rgba(0,0,0,0.66)';
          ctx.fillText(PC.name || '血祭坛', x + 1, by - 12 + 1);
          ctx.fillStyle = col;
          ctx.fillText(PC.name || '血祭坛', x, by - 12);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }

      // ---------- 上古神龛（第三十五轮）----------
      // 【为什么和宝箱完全分开画】两者都是「走上去才生效」的地面物件，但语义不同：
      //   宝箱是「捡走的一件东西」，神龛是「站在那儿的一座石龛」。画得一样的话，
      //   玩家会以为神龛也能打开、或者以为宝箱领了就没了 —— 视觉必须能区分。
      // 三层：脚下符文圈（类型色）→ 上升光柱 → 石龛本体（复用障碍物那套 20×20 像素素材）。
      // 每张图只有 3 个，不做合批，逐个画。
      if (nShrine) {
        const pulse = 0.5 + 0.5 * Math.sin((R._animT || 0) * 2.6);
        const smap = (C && C.SHRINE_MAP) || null;
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'shrine') continue;
          if (!visible(it.x, it.y, 52)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          const def = smap ? smap[it.value] : null;
          const col = (def && def.color) || '#c9a96a';

          // ① 脚下符文圈：比宝箱光环更大更"稳"（宝箱是呼吸的光晕，神龛是刻在地上的圈）
          ctx.beginPath();
          ctx.ellipse(x, y + 6, 30 + pulse * 3, 12 + pulse * 1.2, 0, 0, TAU);
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.10 + pulse * 0.06;
          ctx.fill();
          ctx.globalAlpha = 0.55 + pulse * 0.25;
          ctx.strokeStyle = col;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;

          // ② 上升光柱：一条竖直渐变，表示「这里有东西在往上冒」。
          //    ★必须用 createLinearGradient 且每帧重建（只有 3 个，代价可忽略）；
          //      用固定纯色矩形会像一块贴上去的色块，不像光。
          const beamH = 84;
          const g = ctx.createLinearGradient(x, y - beamH, x, y + 4);
          g.addColorStop(0, 'rgba(0,0,0,0)');
          g.addColorStop(1, col);
          ctx.globalAlpha = 0.18 + pulse * 0.12;
          ctx.fillStyle = g;
          ctx.fillRect(x - 8, y - beamH, 16, beamH + 4);
          ctx.globalAlpha = 1;

          // ③ 石龛本体（像素素材）。★往下偏 4px：素材底下留了几行空白当"落地阴影"，
          //    直接按中心画会看着飘在地面上方。
          const sp = R.shrineSprite || (R.shrineSprite = makePixelSprite('shrine', 'shrine', 3));
          if (sp) {
            ctx.drawImage(sp.cv, Math.round(x - sp.hw), Math.round(y - sp.hh) + 4,
              sp.hw * 2, sp.hh * 2);
          }

          // ④ 顶上的菱形符文：类型色的唯一"标识物"——三座龛的石龛本体是同一张素材，
          //    只有这个菱形和光柱颜色不同，所以它必须清楚（描边 + 实心两层）。
          const by = y - 52 + Math.sin((R._animT || 0) * 2.2) * 3;
          ctx.beginPath();
          ctx.moveTo(x, by - 7);
          ctx.lineTo(x + 6, by);
          ctx.lineTo(x, by + 7);
          ctx.lineTo(x - 6, by);
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.globalAlpha = 0.85;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(16,10,10,0.75)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }

      // ---------- 引魂灯（第四十六轮）----------
      // 【为什么必须与神龛 / 血祭坛明显不同】三者在机制上是同一类（走上去才生效的地面物件），
      //   但引魂灯是**一组三盏、还要靠「地上还剩几盏」判断进度**的 ——
      //   它必须是一盏"单独站着、远远就能数出来"的灯，而不是又一座石台。
      //   所以：石灯笼本体（复用地图上那张石灯笼素材，塔形、细高）+ 灯心火苗 + 脚下金晕。
      // 三层：脚下金晕（半径**就是**点亮判定半径，让玩家知道走到哪里算数）
      //   → 石灯笼本体 → 灯心火苗（跳动，表示它是活的）。
      if (nLantern) {
        const LN = (C && C.LANTERN) || { color: '#ffcf5c', lightRadius: 34 };
        const LNc = LN.color || '#ffcf5c';
        const ring = LN.lightRadius || 34;
        const pulse = 0.5 + 0.5 * Math.sin((R._animT || 0) * 3.0);
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'lantern') continue;
          if (!visible(it.x, it.y, 60)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          // 最后 3 秒整体淡出（★联机快照里的掉落物不带 life → fade 恒为 1，
          //   与血祭坛同一条处理：宁可少这个预告，也不为了它往协议里加字段）
          const fade = it.life === undefined ? 1 : Math.max(0.2, Math.min(1, it.life / 3));

          // ① 脚下光环：**半径就等于点亮判定**。这是这一轮唯一需要"看得见的数值"——
          //   灯的判定半径是写死的 34（不吃磁石），不画出来的话玩家会按拾取半径去估，
          //   走到 60px 处以为点了、其实没点着。
          // ★★这一层必须是「从灯心往外衰减的一团光」，不能是一块平铺的低透明度椭圆：
          //   平铺出来只是"一块颜色不同的圆盘"，在暗红地面上一眼读成
          //   「灯下面挖了个坑」（第一版截图就是这样，越调越低反而越像阴影）。
          //   径向渐变 + lighter 才是"地面被照亮"。
          const prevOpFill = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          ctx.save();
          ctx.translate(x, y + 6);
          ctx.scale(1, 0.42);                 // 压扁成地面透视椭圆（不然是个正圆，像悬在空中）
          const grd = ctx.createRadialGradient(0, 0, 2, 0, 0, ring);
          grd.addColorStop(0, 'rgba(255,214,110,' + (0.30 * fade).toFixed(3) + ')');
          grd.addColorStop(0.6, 'rgba(255,190,70,' + (0.12 * fade).toFixed(3) + ')');
          grd.addColorStop(1, 'rgba(255,180,60,0)');
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(0, 0, ring, 0, TAU);
          ctx.fill();
          ctx.restore();
          ctx.globalCompositeOperation = prevOpFill;
          // 边界那一圈细环：渐变末端趋于 0，没有这条线就看不出"走进去才算"的具体位置
          ctx.globalAlpha = (0.42 + pulse * 0.25) * fade;
          ctx.strokeStyle = LNc;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.ellipse(x, y + 6, ring, ring * 0.42, 0, 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;

          // ② 石灯笼本体（像素素材，px=2 → 40px 高）。
          //   ★往下偏 8px：素材顶部是"灯顶盖"、底部留了空白当落地阴影，
          //     按中心画会看着飘在地面上方（神龛那张是同款处理，偏 4px）。
          const sp = R.lanternSprite || (R.lanternSprite = makePixelSprite('lantern', 'lantern', 2));
          if (sp) {
            ctx.globalAlpha = fade;
            ctx.drawImage(sp.cv, Math.round(x - sp.hw), Math.round(y - sp.hh) + 8,
              sp.hw * 2, sp.hh * 2);
            ctx.globalAlpha = 1;
          }

          // ③ 灯心火苗：画在**灯室里**，不是灯顶盖上。
          //   【第一版把火苗画在 y-6、光晕半径 13】截图里那团白光把整个灯头糊成一团，
          //   看着像「顶盖烧起来了」、也看不出是盏灯。
          //   素材 20 行、按 px=2 画成 40px、顶部在 y-12 —— 灯室（那几行 '+'）大约在
          //   y-6 ~ y+4，所以：光晕半径压到 7（只够照亮灯室）、火心放 y-4、
          //   火尖只探出 5px。**火要小，灯才看得见** —— 火画大了，灯就没了。
          //   ★加法混合：暗红地面上直接叠金色会被压灰，加法才是"发光"。
          const fy = y - 4 - pulse * 1.2;
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(x, fy, 0.5, x, fy, 7);
          g.addColorStop(0, 'rgba(255,248,214,' + (0.62 * fade).toFixed(3) + ')');
          g.addColorStop(0.5, 'rgba(255,207,92,' + (0.34 * fade).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(255,190,60,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(x, fy, 7, 0, TAU);
          ctx.fill();
          // 火苗尖：一个上窄下宽的小三角，跳动的幅度就是"活着"的暗示
          ctx.globalAlpha = (0.7 + pulse * 0.25) * fade;
          ctx.fillStyle = '#fff3c4';
          ctx.beginPath();
          ctx.moveTo(x, fy - 4 - pulse * 1.6);
          ctx.lineTo(x + 1.8, fy + 2);
          ctx.lineTo(x - 1.8, fy + 2);
          ctx.closePath();
          ctx.fill();
          ctx.globalCompositeOperation = prevOp;
          ctx.globalAlpha = 1;
        }
      }

      // ---------- 歧路双碑（第四十八轮）----------
      // 【为什么是两块**立着**的方碑，而不是又一座石台】
      //   神龛（石龛）/ 血祭坛（暗红石台）/ 引魂灯（石灯笼）已经把"地上的点位"
      //   占了三种造型。这一轮的核心是「两座并排、只能取一座」，
      //   所以造型必须能**并排站住**：两块瘦高的碑并排时，"旁边还有一块"
      //   一眼就能看到；两张石台并排则会读成一整块台子。
      //   ★两块的差别靠**符文形状**做（立刃 / 龟甲六边形），不靠颜色：
      //     颜色在暗红地面上会被压暗，形状不会（引魂灯那轮的经验）。
      if (nBoon) {
        const BN = (C && C.BOON) || null;
        const pulse = 0.5 + 0.5 * Math.sin((R._animT || 0) * 3.2);
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'boon') continue;
          if (!visible(it.x, it.y, 56)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          // ★哪一座由 value 决定（1 = 兵主碑 / 2 = 玄龟碑），服务端与这里同一份表
          const oi = it.value === 2 ? 1 : 0;
          const def = BN ? BN.options[oi] : null;
          const col = (def && def.color) || '#c9963a';
          // 最后 3 秒淡出（★联机快照里的掉落物不带 life → fade 恒为 1，
          //   与血祭坛 / 引魂灯同一条处理：宁可少这个预告，也不往协议里加字段）
          const fade = it.life === undefined ? 1 : Math.max(0.2, Math.min(1, it.life / 3));

          // ① 脚下光池：径向渐变 + 压扁成地面透视椭圆。
          //   ★不能是平铺的低透明度椭圆 —— 在暗红地面上会被读成"碑下面挖了个坑"
          //   （引魂灯第一版就是这么错的，越调越低反而越像阴影）。
          const prevOpFill = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          ctx.save();
          ctx.translate(x, y + 4);
          ctx.scale(1, 0.40);
          const grd = ctx.createRadialGradient(0, 0, 1, 0, 0, 34);
          grd.addColorStop(0, rgbaOf(col, 0.26 * fade));
          grd.addColorStop(0.65, rgbaOf(col, 0.10 * fade));
          grd.addColorStop(1, rgbaOf(col, 0));
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(0, 0, 34, 0, TAU);
          ctx.fill();
          ctx.restore();
          ctx.globalCompositeOperation = prevOpFill;
          ctx.globalAlpha = 1;

          // ② 落地阴影 + 碑体（上窄下宽的梯形，两块碑用同一副身子 ——
          //    区别只在符文，这样"它们是一类东西"这件事不用解释）
          const bw = 9;              // 半宽
          const bh = 30;             // 碑高
          ctx.beginPath();
          ctx.ellipse(x, y + 6, 13, 4.5, 0, 0, TAU);
          ctx.fillStyle = 'rgba(8,5,5,0.45)';
          ctx.fill();

          ctx.beginPath();
          ctx.moveTo(x - bw, y + 4);
          ctx.lineTo(x - bw + 1.5, y - bh + 6);
          ctx.lineTo(x - bw + 4, y - bh);        // 左肩切角
          ctx.lineTo(x + bw - 4, y - bh);        // 顶面
          ctx.lineTo(x + bw - 1.5, y - bh + 6);
          ctx.lineTo(x + bw, y + 4);
          ctx.closePath();
          ctx.fillStyle = '#2b2422';             // 暗石本体
          ctx.fill();                            // ★必须真的填一次：下面那段是"受光面"，
          //   只画受光面的话碑身是半透明的（渐变里有全透明的一档），叠在暗红地面上像块玻璃。
          // 受光面：左上打一道类型色的光，碑才不是一块纯剪影
          ctx.save();
          ctx.clip();
          const bg = ctx.createLinearGradient(x - bw, y - bh, x + bw, y + 4);
          bg.addColorStop(0, rgbaOf(col, 0.30 * fade));
          bg.addColorStop(0.55, 'rgba(0,0,0,0)');
          bg.addColorStop(1, 'rgba(0,0,0,0.26)');
          ctx.fillStyle = bg;
          ctx.fillRect(x - bw, y - bh, bw * 2, bh + 4);
          ctx.restore();
          // 描边：暗石叠在暗红地面上，不描边只剩一团黑（碑的形状就没了）
          ctx.globalAlpha = fade * 0.85;
          ctx.strokeStyle = rgbaOf(col, 0.62);
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.globalAlpha = fade;

          // ③ 符文：两块碑**唯一**的区别。用亮色描（混白 35%），
          //    不然类型色本身在暗石上几乎看不出笔迹。
          const cy = y - bh * 0.56;
          ctx.strokeStyle = mixRgba(col, '#ffffff', 0.35, 0.92 * fade);
          ctx.lineWidth = 2;
          ctx.lineJoin = 'miter';
          ctx.beginPath();
          if (oi === 0) {
            // 兵主碑：一柄立刃（中线 + 上端收成尖）
            ctx.moveTo(x, cy - 9);
            ctx.lineTo(x, cy + 8);
            ctx.moveTo(x - 5, cy - 3);
            ctx.lineTo(x, cy - 9);
            ctx.lineTo(x + 5, cy - 3);
          } else {
            // 玄龟碑：龟甲（六边形）
            for (let k = 0; k <= 6; k++) {
              const a2 = -Math.PI / 2 + (k * Math.PI) / 3;
              const rx = x + Math.cos(a2) * 6.5;
              const ry = cy + Math.sin(a2) * 6.5;
              if (k === 0) ctx.moveTo(rx, ry);
              else ctx.lineTo(rx, ry);
            }
          }
          ctx.stroke();

          // ④ 顶上的菱形符文（与神龛 / 血祭坛同一个造型语言：这是一类"能领"的点位）
          const by = y - bh - 12 + Math.sin((R._animT || 0) * 3.0) * 1.8;
          ctx.globalAlpha = 0.85 * fade;
          ctx.beginPath();
          ctx.moveTo(x, by - 6);
          ctx.lineTo(x + 5, by);
          ctx.lineTo(x, by + 6);
          ctx.lineTo(x - 5, by);
          ctx.closePath();
          ctx.fillStyle = col;
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(16,10,10,0.75)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // ⑤ 名字：**这一轮必须让碑自己说出身份**。
          //   两块碑的区别只有符文与名字，玩家在 40px 的实际尺寸下未必读得出符文；
          //   而"哪一块给伤害、哪一块给上限"正是他要做的那个决定本身。
          //   ★不写"淡到一定程度就不画"的阈值（血祭坛踩过：剩 1.5 秒时名字会啪一下消失）。
          ctx.save();
          ctx.globalAlpha = 0.9 * fade;
          ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = (def && def.name) || '石碑';
          ctx.fillStyle = 'rgba(0,0,0,0.66)';
          ctx.fillText(label, x + 1, by - 10 + 1);
          ctx.fillStyle = col;
          ctx.fillText(label, x, by - 10);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }

      // ---------- 镇妖钟（第四十九轮）----------
      // 【为什么必须与神龛/血祭坛/引魂灯/双碑都长得不一样】它们全是「走上去」的地面物件，
      //   但钟是唯一一个**踩一下会被敲响、响完就没了**的东西：
      //   造型上必须是「一口挂在架子上的铜钟」，而不是又一座石台或一盏灯 ——
      //   石台读成「领东西的」，钟才能读成「敲一下的」。
      // 五层：脚下光池（青铜）→ 挂架横梁 + 钟钮 → 钟身（上窄下宽）→ 钟口（压扁的空心口）
      //   → 在响时额外加「声波弧」（这是唯一能表达"它正在发声"的图形）。
      if (nBell) {
        const BL = (C && C.BELL) || { color: '#b0793a', name: '镇妖钟' };
        const col = BL.color || '#b0793a';
        const ivory = BL.ringColor || '#e8d9b8';
        const at = R._animT || 0;
        const pulse = 0.5 + 0.5 * Math.sin(at * 3.0);
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'bell') continue;
          if (!visible(it.x, it.y, 64)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          // 最后 3 秒淡出（★联机快照里的掉落物不带 life → fade 恒为 1，
          //   与血祭坛 / 引魂灯 / 双碑同一条处理：宁可少这个预告，也不往协议里加字段）
          const fade = it.life === undefined ? 1 : Math.max(0.2, Math.min(1, it.life / 3));
          // value 1 = 正在响（服务端敲响时写进去的，见 sim 的 tollBell）
          const ringing = it.value === 1;

          // ① 脚下光池：径向渐变 + 压扁成地面透视椭圆。
          //   ★不能是平铺的低透明度椭圆 —— 在暗红地面上会被读成"钟下面挖了个坑"
          //   （引魂灯第一版就是这么错的，越调越低反而越像阴影）。
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          ctx.save();
          ctx.translate(x, y + 4);
          ctx.scale(1, 0.40);
          const grd = ctx.createRadialGradient(0, 0, 1, 0, 0, 36);
          grd.addColorStop(0, rgbaOf(col, (ringing ? 0.34 : 0.22) * fade));
          grd.addColorStop(0.65, rgbaOf(col, 0.09 * fade));
          grd.addColorStop(1, rgbaOf(col, 0));
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(0, 0, 36, 0, TAU);
          ctx.fill();
          ctx.restore();
          ctx.globalCompositeOperation = prevOp;
          ctx.globalAlpha = 1;

          // ② 落地阴影
          ctx.beginPath();
          ctx.ellipse(x, y + 5, 12, 4, 0, 0, TAU);
          ctx.fillStyle = 'rgba(8,5,5,0.45)';
          ctx.fill();

          // ③ 挂架：一根横梁 + 钟钮。★有横梁它才读成「挂着的钟」，
          //   没有的话就是一个铜色的碗 —— 40px 的实际尺寸下这两个形状差得很远。
          //   ★★横梁第一版用了 rgba(58,44,30)（深木色），在暗红地面上**完全看不见**
          //   （3 倍截图里钟头上方一片平），等于白画。改成「深色描边 + 暖木高光」两层，
          //   才真的读得出来。
          const bh = 26;             // 钟高
          const bw = 10;             // 钟口半宽
          ctx.globalAlpha = fade;
          ctx.strokeStyle = '#20160f';
          ctx.lineWidth = 5;
          ctx.beginPath();
          ctx.moveTo(x - 14, y - bh - 8);
          ctx.lineTo(x + 14, y - bh - 8);
          ctx.stroke();
          ctx.strokeStyle = rgbaOf('#8a6a3e', 0.95);
          ctx.lineWidth = 2.4;
          ctx.beginPath();
          ctx.moveTo(x - 13, y - bh - 9);
          ctx.lineTo(x + 13, y - bh - 9);
          ctx.stroke();
          // 钟钮（顶上一个环）
          ctx.strokeStyle = rgbaOf(col, 0.9);
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y - bh - 4, 3.4, Math.PI * 0.15, Math.PI * 0.85 * 2.6);
          ctx.stroke();

          // ④ 钟身：上窄下宽（两侧外扩的弧线），这是"钟"与"鼎/钵"的唯一区别
          ctx.beginPath();
          ctx.moveTo(x - bw, y);
          ctx.quadraticCurveTo(x - bw + 1, y - bh * 0.52, x - 6.2, y - bh * 0.74);
          ctx.quadraticCurveTo(x - 3.6, y - bh, x, y - bh);
          ctx.quadraticCurveTo(x + 3.6, y - bh, x + 6.2, y - bh * 0.74);
          ctx.quadraticCurveTo(x + bw - 1, y - bh * 0.52, x + bw, y);
          ctx.closePath();
          // 本体先填一次暗铜：下面那段"受光面"的渐变里有全透明档，
          // 只画受光面的话钟身是半透明的（双碑那轮踩过同一个坑）。
          ctx.fillStyle = '#3d2c1c';
          ctx.fill();
          ctx.save();
          ctx.clip();
          const bg = ctx.createLinearGradient(x - bw, y - bh, x + bw, y);
          bg.addColorStop(0, rgbaOf(col, 0.55 * fade));
          bg.addColorStop(0.5, 'rgba(0,0,0,0)');
          bg.addColorStop(1, 'rgba(0,0,0,0.30)');
          ctx.fillStyle = bg;
          ctx.fillRect(x - bw, y - bh - 2, bw * 2, bh + 4);
          ctx.restore();
          // 描边：暗铜叠在暗红地面上，不描边就只剩一团黑（钟的形状会糊掉）
          ctx.globalAlpha = fade * 0.9;
          ctx.strokeStyle = rgbaOf(col, 0.75);
          ctx.lineWidth = 1.4;
          ctx.stroke();

          // ⑤ 钟口：压扁的空心椭圆 + 一圈亮唇线 —— 空口朝下，玩家才看得出"能敲"
          ctx.beginPath();
          ctx.ellipse(x, y, bw, 3.6, 0, 0, TAU);
          ctx.fillStyle = 'rgba(12,8,6,0.88)';
          ctx.fill();
          ctx.globalAlpha = fade;
          ctx.strokeStyle = mixRgba(col, '#ffffff', 0.45, 0.9 * fade);
          ctx.lineWidth = 1.6;
          ctx.stroke();

          // ⑥ 正在响：钟身泛暖白光 + 两道外扩的声波弧。
          //   ★声波是这一整轮唯一的"状态表达"：钟敲没敲，只有它能说清 ——
          //   只看钟身的话，"还没敲"和"正在响"长得一模一样。
          if (ringing) {
            const glow = 0.5 + 0.5 * Math.sin(at * 9.0);
            ctx.globalAlpha = (0.16 + glow * 0.14) * fade;
            ctx.fillStyle = ivory;
            ctx.beginPath();
            ctx.ellipse(x, y - bh * 0.45, bw * 1.25, bh * 0.55, 0, 0, TAU);
            ctx.fill();
            ctx.globalAlpha = 1;
            // 两圈声波：相位差半个周期，看起来是"一波接一波"而不是一次性扩散
            for (let k = 0; k < 2; k++) {
              const ph = ((at * 0.9 + k * 0.5) % 1);
              const rr = 15 + ph * 30;
              ctx.globalAlpha = (1 - ph) * 0.42 * fade;
              ctx.strokeStyle = ivory;
              ctx.lineWidth = 2;
              ctx.beginPath();
              // 只画上半圈：整圈的圆环会和地上那个 460 的钟声圈混成两层圈
              ctx.arc(x, y - 6, rr, Math.PI * 1.12, Math.PI * 1.88);
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }

          // ⑦ 名牌：不写字的话「这口钟是干什么的」只能靠提示条记，
          //   而玩家第一次见到它时提示条多半已经滚过去了。
          ctx.save();
          ctx.globalAlpha = 0.9 * fade;
          ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = (BL && BL.name) || '镇妖钟';
          ctx.fillStyle = 'rgba(0,0,0,0.66)';
          ctx.fillText(label, x + 1, y - bh - 17 + 1);
          ctx.fillStyle = col;
          ctx.fillText(label, x, y - bh - 17);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }

      // ---------- 精卫（第五十一轮）----------
      // 【为什么她必须有"航迹"这一层】她是全项目唯一**会自己离开你**的目标。
      //   没有航迹的话，玩家看到的只是"一只白鸟在飘" —— 而这一整段玩法的前提是
      //   「她要去那边，你得跟上」。航迹本身就是那句提示（提示条只滚一次，跟不上就忘了）。
      //   ★方向取「上一帧 → 这一帧」的位移（pickups 的 px/py 本来就是干这个的），
      //     不额外往协议里加字段：位移每帧约 3.4px，够定方向。
      // 【为什么血环画在脚下而不是头顶】她的头顶是"翅尖"，画上去会和翅膀糊在一起；
      //   脚下那圈是唯一稳定的空地（也正好是玩家看血量的习惯位置）。
      if (nEscort) {
        const ES = (C && C.ESCORT) || {
          name: '精卫', color: '#eaf2f8', hpColor: '#ffd166', trailColor: '#8fd3e8'
        };
        const at = R._animT || 0;
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'escort') continue;
          if (!visible(it.x, it.y, 70)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          const fade = 1;      // 她是"飞走"而不是"淡出"，所以不做寿命淡出

          // ① 航迹：沿飞行方向往前点 5 个渐隐的小点
          const pdx = (typeof it.px === 'number') ? (it.x - it.px) : 0;
          const pdy = (typeof it.py === 'number') ? (it.y - it.py) : 0;
          const plen = Math.sqrt(pdx * pdx + pdy * pdy);
          if (plen > 0.35) {
            const ux = pdx / plen;
            const uy = pdy / plen;
            // ★第一版是 5 个渐隐小点（alpha 0.34 / 半径 2.1）：3 倍特写里那几个点
            //   在暗红地面上是**灰色**的，读成"地上有几粒灰"而不是"她往那边飞"。
            //   改成一条虚线 + 加法混合（lighter）之后海青才会"发光"，
            //   而且虚线本身就带着方向感 —— 这是玩家唯一能读出"她要去哪"的东西。
            //   ★只画 110px：画整条 700px 会在屏幕上拉出一根横贯全场的线，
            //     反而盖住战场（提示要够读，不能变成新的干扰）。
            const prevOp2 = ctx.globalCompositeOperation;
            ctx.globalCompositeOperation = 'lighter';
            ctx.strokeStyle = ES.trailColor;
            ctx.globalAlpha = 0.5 * fade;
            ctx.lineWidth = 2.4;
            ctx.setLineDash([5, 9]);
            ctx.beginPath();
            ctx.moveTo(x + ux * 16, y + uy * 16 - 10);
            ctx.lineTo(x + ux * 110, y + uy * 110 - 10);
            ctx.stroke();
            ctx.setLineDash([]);
            // 航迹尽头一个亮点：它是"箭头"的替代品（虚线自己说不出往哪个方向）
            ctx.globalAlpha = 0.75 * fade;
            ctx.fillStyle = mixRgba(ES.trailColor, '#ffffff', 0.45, 1);
            ctx.beginPath();
            ctx.arc(x + ux * 114, y + uy * 114 - 10, 2.6, 0, TAU);
            ctx.fill();
            ctx.globalCompositeOperation = prevOp2;
            ctx.globalAlpha = 1;
          }

          // ② 脚下影子：她在飞，影子必须和她**分开**（不然读成"地上走的一只鸡"）
          const bob = Math.sin(at * 3.2) * 2.2;
          ctx.beginPath();
          ctx.ellipse(x, y + 11, 10, 3.4, 0, 0, TAU);
          ctx.fillStyle = 'rgba(8,5,5,0.42)';
          ctx.fill();

          // ③ 本体：**几何绘制**（不走 16×16 像素矩阵）
          //   【为什么这一只不做成像素素材】她只有 48px，而这一整段要表达的是"她在飞"。
          //     像素矩阵里翅膀只能是几格死像素 —— 前两版实测在 3 倍特写下被读成
          //     "两根触角的小虫"，看截图才发现的（断言全绿完全看不出这件事）。
          //     几何翅膀能跟着相位扇动，而"会扇"才是"鸟"这个身份的唯一证明。
          //     （镇妖钟也是几何绘制的：会动的、会响的东西不适合做成一格一格的静态图。）
          const flap = Math.sin(at * 7.5);          // -1 → 1：翅膀上下扇
          const bx = x;
          const by = y - 16 + bob;                  // 身体中心：比脚下高 16px = 在飞
          const bodyCol = ES.color || '#eaf2f8';

          // 尾羽（左后方三片，明暗各一档 —— 深浅是这里唯一能表达前后关系的手段）
          ctx.fillStyle = mixRgba(bodyCol, '#9fb4c6', 0.35, 1);
          ctx.beginPath();
          ctx.moveTo(bx - 9, by + 1);
          ctx.lineTo(bx - 21, by - 5);
          ctx.lineTo(bx - 20, by + 1);
          ctx.lineTo(bx - 10, by + 5);
          ctx.closePath();
          ctx.fill();

          // 远翅（在身体之后，压暗一档）
          ctx.fillStyle = mixRgba(bodyCol, '#8fa8bd', 0.6, 1);
          ctx.beginPath();
          ctx.moveTo(bx - 5, by - 1);
          ctx.quadraticCurveTo(bx - 14, by - 15 - flap * 5, bx - 3, by - 21 - flap * 7);
          ctx.quadraticCurveTo(bx + 1, by - 9, bx + 1, by - 1);
          ctx.closePath();
          ctx.fill();

          // 身体（略前倾的椭圆）
          ctx.fillStyle = bodyCol;
          ctx.beginPath();
          ctx.ellipse(bx, by, 11, 7.4, -0.12, 0, TAU);
          ctx.fill();

          // 近翅（在身体之前，最亮 —— 三层叠出"翅膀在身前扇"的层次）
          ctx.beginPath();
          ctx.moveTo(bx + 1, by - 1);
          ctx.quadraticCurveTo(bx + 5, by - 17 - flap * 6, bx + 16, by - 20 - flap * 8);
          ctx.quadraticCurveTo(bx + 12, by - 6, bx + 9, by + 1);
          ctx.closePath();
          ctx.fill();

          // 头 + 赤喙 + 眼（喙是唯一不是白的部分：白鸟靠它一眼认出是鸟而不是一团光）
          ctx.beginPath();
          ctx.arc(bx + 10, by - 5, 5.6, 0, TAU);
          ctx.fill();
          ctx.fillStyle = '#d94a4a';
          ctx.beginPath();
          ctx.moveTo(bx + 14, by - 7.2);
          ctx.lineTo(bx + 21.5, by - 4.6);
          ctx.lineTo(bx + 14, by - 2.4);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = '#241c18';
          ctx.beginPath();
          ctx.arc(bx + 12, by - 6, 1.5, 0, TAU);
          ctx.fill();

          // 爪下那块石头（她的身份：衔石填海）。
          // ★必须与身体之间留出缝隙 + 两根细腿：贴着身体的话，它就成了"鸟的肚子"。
          ctx.strokeStyle = 'rgba(20,14,12,0.6)';
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(bx - 3, by + 6);
          ctx.lineTo(bx - 3, by + 11);
          ctx.moveTo(bx + 4, by + 6);
          ctx.lineTo(bx + 4, by + 11);
          ctx.stroke();
          ctx.save();
          ctx.translate(bx + 1, by + 14);
          ctx.rotate(-0.18);
          ctx.fillStyle = ES.stoneColor || '#9aa7b3';
          ctx.fillRect(-5.5, -3.6, 11, 7.2);
          ctx.strokeStyle = 'rgba(20,14,12,0.55)';
          ctx.lineWidth = 1.2;
          ctx.strokeRect(-5.5, -3.6, 11, 7.2);
          ctx.restore();

          // ④ 血量：**压扁的地面环**（椭圆弧），画在影子的位置。
          //   ★为什么不用正圆环套在她身上（第一版就是那样）：3 倍特写里正圆会横穿她半个身子，
          //     把白鸟切成"金框里的一团"，玩家反而看不清精灵。压扁贴地之后，
          //     它与"脚下那一圈"是同一套语言（钟声圈 / 灵泉圈都贴地），不抢主体。
          //   ★底色环一定要画：只画进度弧的话，"满血"与"这个 kind 不认识 value"
          //     在画面上长得一模一样（看不出她到底是不是在掉血）。
          const pct = (typeof it.value === 'number' && it.value > 0) ? (it.value / 100) : 0;
          ctx.globalAlpha = 0.85 * fade;
          ctx.strokeStyle = 'rgba(10,6,6,0.72)';
          ctx.lineWidth = 4.2;
          ctx.beginPath();
          ctx.ellipse(x, y + 11, 16, 6.2, 0, 0, TAU);
          ctx.stroke();
          if (pct > 0) {
            ctx.strokeStyle = pct > 0.3 ? ES.hpColor : '#e0553c';
            ctx.lineWidth = 3;
            ctx.beginPath();
            // 从正上方开始顺时针：0 在 12 点方向，满血刚好绕回 12 点
            ctx.ellipse(x, y + 11, 16, 6.2, 0, -Math.PI / 2, -Math.PI / 2 + TAU * pct);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;

          // ⑤ 名牌：不写名字的话，玩家只能靠"白色"猜她是谁 ——
          //   而 40px 尺寸下一只白鸟和一团白色特效分不开。
          //   ★必须画在血环**下面**（第一版画在 y+28，正好压在环上：3 倍特写里
          //     「精卫」两个字被金环横穿，两个都读不清）。
          ctx.save();
          ctx.globalAlpha = 0.92 * fade;
          ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = ES.name || '精卫';
          ctx.fillStyle = 'rgba(0,0,0,0.66)';
          ctx.fillText(label, x + 1, y + 34 + 1);
          ctx.fillStyle = ES.color || '#eaf2f8';
          ctx.fillText(label, x, y + 34);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }

      // ---------- 大人之市（第五十二轮）----------
      // 【为什么它不是又一张「石台 + 光柱」】前面六件（神龛/血祭坛/双碑/引魂灯/镇妖钟）
      //   全是"地上一个点位"，靠颜色区分的空间已经用完了：玩家看到"发光的台子"
      //   只会想起"走上去领东西"，不会想起"走上去**付钱**"。
      //   所以这一件画成**一顶带布幡的摊子**：两根木杆 + 一顶梯形布篷 + 摊板上的货匣
      //   + 地上的钱堆。摊子这个形状自带"交易"这件事，不需要一个字的解释。
      // ★它必须有名字与价钱：摊上只摆一件货，玩家必须能在走过去之前就知道
      //   「这摊卖什么、多少钱」—— 否则"买还是不买"这个决定根本无从做起。
      if (nMarket) {
        const MK = (C && C.MARKET) || { color: '#ffd166', clothColor: '#e8d9b8', offers: [] };
        const gold = MK.color || '#ffd166';
        const cloth = MK.clothColor || '#e8d9b8';
        const wood = MK.woodColor || '#b0793a';
        const at = R._animT || 0;
        const wave = Math.sin(at * 2.4);
        const offers = (MK.offers && MK.offers.length) ? MK.offers : [];
        const shopItems = (C && C.SHOP && C.SHOP.items) || [];
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'market') continue;
          if (!visible(it.x, it.y, 72)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          // 最后 3 秒淡出（★联机快照里的掉落物不带 life → fade 恒为 1，
          //   与血祭坛/引魂灯/双碑/钟同一条处理：宁可少这个预告，也不往协议里加字段）
          const fade = it.life === undefined ? 1 : Math.max(0.2, Math.min(1, it.life / 3));

          // 卖的是哪件货：value 是 offers 的下标（服务端写进去的，见 sim 的 spawnMarket）
          const oi = Math.max(0, Math.min(offers.length - 1, Math.round(it.value || 0)));
          const oid = offers.length ? offers[oi] : '';
          let itemName = '山货';
          let itemPrice = 0;
          for (let k = 0; k < shopItems.length; k++) {
            if (shopItems[k].id === oid) {
              itemName = shopItems[k].name;
              itemPrice = Math.max(1, Math.round(shopItems[k].price * (MK.discount || 0.7)));
              break;
            }
          }

          // ① 地面上的光池：金 + 加法混合（低 alpha 的金在暗红地面上是"土黄"，
          //   必须走 lighter 才像"灯火照着的一块地"—— 精卫的航迹踩过这条）
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          ctx.save();
          ctx.translate(x, y + 4);
          ctx.scale(1, 0.40);
          const grd = ctx.createRadialGradient(0, 0, 2, 0, 0, 46);
          grd.addColorStop(0, 'rgba(255,209,102,0.34)');
          grd.addColorStop(0.55, 'rgba(255,209,102,0.12)');
          grd.addColorStop(1, 'rgba(255,209,102,0)');
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(0, 0, 46, 0, TAU);
          ctx.fill();
          ctx.restore();
          ctx.globalCompositeOperation = prevOp;

          ctx.globalAlpha = fade;

          // ② 两根木杆（摊子的"骨架"）
          ctx.fillStyle = wood;
          ctx.fillRect(x - 22, y - 38, 3.2, 40);
          ctx.fillRect(x + 19, y - 38, 3.2, 40);
          // 杆头各一枚金色的榫头（细看时才知道这不是两根木棍）
          ctx.fillStyle = gold;
          ctx.fillRect(x - 23, y - 40, 5.2, 3);
          ctx.fillRect(x + 17.8, y - 40, 5.2, 3);

          // ③ 布篷：前宽后窄的梯形（透视），素白布 + 金色滚边
          ctx.beginPath();
          ctx.moveTo(x - 30, y - 38);
          ctx.lineTo(x + 30, y - 38);
          ctx.lineTo(x + 21, y - 52);
          ctx.lineTo(x - 21, y - 52);
          ctx.closePath();
          ctx.fillStyle = cloth;
          ctx.fill();
          ctx.strokeStyle = gold;
          ctx.lineWidth = 1.6;
          ctx.stroke();

          // ④ 篷前沿的挂边：三道小三角（布篷才不像一块板）
          ctx.fillStyle = gold;
          for (let k = -1; k <= 1; k++) {
            ctx.beginPath();
            ctx.moveTo(x + k * 16 - 5, y - 38);
            ctx.lineTo(x + k * 16 + 5, y - 38);
            ctx.lineTo(x + k * 16, y - 33);
            ctx.closePath();
            ctx.fill();
          }

          // ⑤ 布幡：从布篷左前角垂下来，一直挂到摊板下方，随风摆。
          //   ★它是"开市"这件事唯一的动态 —— 静止的摊子会被读成"一间小屋"。
          //   第一版只从篷下垂 20px、颜色与篷同色，3 倍特写里读成"篷上的一块污渍"；
          //   改到篷外、挂到摊板以下（26px 高）+ 金色滚边 + 尖端一枚小坠子，才认得出是布幡。
          const bx = x - 29 + wave * 2.5;
          const byTop = y - 38;
          const byBot = y - 12 + Math.abs(wave) * 2;
          ctx.beginPath();
          ctx.moveTo(bx - 6, byTop);
          ctx.lineTo(bx + 1, byTop);
          ctx.quadraticCurveTo(bx + 5 + wave * 3, (byTop + byBot) / 2, bx + 1 + wave * 4, byBot);
          ctx.lineTo(bx - 6 + wave * 4, byBot - 3);
          ctx.quadraticCurveTo(bx - 3 + wave * 3, (byTop + byBot) / 2, bx - 6, byTop);
          ctx.closePath();
          ctx.globalAlpha = 0.92 * fade;
          ctx.fillStyle = cloth;
          ctx.fill();
          ctx.strokeStyle = gold;
          ctx.lineWidth = 1.4;
          ctx.stroke();
          ctx.globalAlpha = 1;

          // ⑥ 摊板 + 板上的货匣（这只匣子就是"要买的那件东西"）
          ctx.fillStyle = wood;
          ctx.fillRect(x - 24, y - 16, 48, 5);
          ctx.fillStyle = 'rgba(20,14,12,0.45)';
          ctx.fillRect(x - 24, y - 12, 48, 2);
          // 货匣：素白布包 + 一道金绳（不画具体货品：货品每次都不一样，
          //   画死一个形状反而会让玩家以为"这摊永远卖那个"）
          ctx.fillStyle = cloth;
          ctx.beginPath();
          ctx.moveTo(x - 8, y - 16);
          ctx.lineTo(x + 8, y - 16);
          ctx.lineTo(x + 6, y - 28);
          ctx.lineTo(x - 6, y - 28);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = gold;
          ctx.lineWidth = 1.8;
          ctx.beginPath();
          ctx.moveTo(x - 7.4, y - 22);
          ctx.lineTo(x + 7.4, y - 22);
          ctx.stroke();

          // ⑦ 地上的钱堆：三枚金币（"这摊收钱"这件事的第二重提示）
          ctx.fillStyle = gold;
          for (let k = 0; k < 3; k++) {
            const cx = x + 12 + (k % 2) * 6;
            const cy = y - 5 - k * 3.2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, 4.2, 2.6, 0, 0, TAU);
            ctx.fill();
          }
          ctx.strokeStyle = 'rgba(20,14,12,0.5)';
          ctx.lineWidth = 1;
          for (let k = 0; k < 3; k++) {
            const cx = x + 12 + (k % 2) * 6;
            const cy = y - 5 - k * 3.2;
            ctx.beginPath();
            ctx.ellipse(cx, cy, 4.2, 2.6, 0, 0, TAU);
            ctx.stroke();
          }

          // ⑧ 名牌：一行写清「摊名 · 卖什么 · 多少钱」
          //   ★不写"淡到某个阈值就不画"的阈值（血祭坛踩过：剩 1.5 秒名字会啪一下消失）
          ctx.save();
          ctx.globalAlpha = 0.94 * fade;
          ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = (MK.name || '大人之市') + ' · ' + itemName +
            (itemPrice ? ' ' + itemPrice + ' 金' : '');
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(label, x + 1, y - 55 + 1);
          ctx.fillStyle = gold;
          ctx.fillText(label, x, y - 55);
          ctx.restore();
          ctx.globalAlpha = 1;
        }
      }

      // ---------- 炼魂鼎（第五十三轮）----------
      // 【为什么几何绘制、不用像素矩阵】鼎口腾起的魂火要 `sin` 跳动、底火要呼吸 ——
      //   项目纪律：能动/会响的东西不做成一格一格的静态图（精卫/镇妖钟都踩过）。
      // 【配色】三色全部复用已有串池值：火橙 #ff8c42（底火）/ 地脉玉青 #5fe0b0（魂火）/
      //   琥珀金 #ffd166（成交光）。不用紫、不新增色值 —— 一个色都没往协议里加。
      if (nCauldron) {
        const CD = (C && C.CAULDRON) || { color: '#ff8c42', soulColor: '#5fe0b0', healColor: '#ffd166', name: '炼魂鼎' };
        const fire = CD.color || '#ff8c42';
        const soul = CD.soulColor || '#5fe0b0';
        const at = R._animT || 0;
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'cauldron') continue;
          if (!visible(it.x, it.y, 64)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);
          // 最后 3 秒淡出（联机快照不带 life → fade 恒 1，与其余点位同一条处理）
          const fade = it.life === undefined ? 1 : Math.max(0.2, Math.min(1, it.life / 3));
          const breath = 0.5 + 0.5 * Math.sin(at * 3.2);
          ctx.save();
          ctx.globalAlpha = fade;

          // ① 地面火光：火橙 + 加法混合（暗红地面上低 alpha 的橙会读成土黄，
          //    必须 lighter 才像"底下真有一炉火"—— 大市的金光池同一条）。
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          ctx.save();
          ctx.translate(x, y + 6);
          ctx.scale(1, 0.42);
          const grd = ctx.createRadialGradient(0, 0, 2, 0, 0, 40);
          grd.addColorStop(0, 'rgba(255,140,66,0.34)');
          grd.addColorStop(0.55, 'rgba(255,140,66,0.12)');
          grd.addColorStop(1, 'rgba(255,140,66,0)');
          ctx.fillStyle = grd;
          ctx.beginPath();
          ctx.arc(0, 0, 40, 0, TAU);
          ctx.fill();
          ctx.restore();
          ctx.globalCompositeOperation = prevOp;

          // ② 三足：两根前脚 + 一根后脚，外撇的梯形。
          //   ★第一版用暗铜 #b0793a、只露到 y+15，3 倍特写里三足完全沉进暗红地面，
          //     整座鼎被读成"一个橙色碗"（截图才发现，断言永远发现不了）。
          //     改成更亮的金铜 #c9963a（池里已有）+ 延长外撇到 y+19 + 一道高光边 ——
          //     三足是"鼎"与"碗"唯一的区别，必须一眼看得出。
          ctx.fillStyle = '#c9963a';
          ctx.strokeStyle = 'rgba(255,209,102,0.55)';
          ctx.lineWidth = 1;
          function leg(x0, x1, x2, x3) {
            ctx.beginPath();
            ctx.moveTo(x + x0, y + 2); ctx.lineTo(x + x1, y + 2);
            ctx.lineTo(x + x2, y + 19); ctx.lineTo(x + x3, y + 19); ctx.closePath();
            ctx.fill(); ctx.stroke();
          }
          leg(-16, -9, -6, -15);     // 左脚：向外撇
          leg(9, 16, 15, 6);         // 右脚：向外撇
          leg(-4, 4, 3, -3);         // 后脚：正中稍短视觉差

          // ③ 鼎腹：宽口收腰的梯形，火橙描边 + 深铜填充（深色在暗红地面上靠描边才看得出）
          ctx.fillStyle = 'rgba(60,42,26,0.95)';
          ctx.strokeStyle = fire;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x - 20, y - 10); ctx.lineTo(x + 20, y - 10);
          ctx.lineTo(x + 14, y + 6); ctx.lineTo(x - 14, y + 6); ctx.closePath();
          ctx.fill(); ctx.stroke();
          // 双耳
          ctx.beginPath();
          ctx.moveTo(x - 20, y - 10); ctx.lineTo(x - 24, y - 17); ctx.lineTo(x - 17, y - 15);
          ctx.moveTo(x + 20, y - 10); ctx.lineTo(x + 24, y - 17); ctx.lineTo(x + 17, y - 15);
          ctx.stroke();

          // ④ 鼎腹上的火纹：随呼吸明灭的一道横纹（告诉玩家"这炉子烧着呢"）
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = 'rgba(255,140,66,' + (0.30 + 0.35 * breath) + ')';
          ctx.fillRect(x - 12, y - 3, 24, 2);
          ctx.globalCompositeOperation = prevOp;

          // ⑤ 鼎口魂火：玉青的火苗从口里腾起、随 sin 摆动（这是"经验被炼化"的视觉）
          ctx.globalCompositeOperation = 'lighter';
          for (let k = 0; k < 3; k++) {
            const fx = x - 9 + k * 9;
            const fh = 10 + 7 * (0.5 + 0.5 * Math.sin(at * 4 + k * 1.7));
            ctx.fillStyle = 'rgba(95,224,176,' + (0.30 + 0.22 * breath) + ')';
            ctx.beginPath();
            ctx.moveTo(fx - 3, y - 11);
            ctx.quadraticCurveTo(fx + Math.sin(at * 3 + k) * 3, y - 11 - fh * 0.6, fx, y - 11 - fh);
            ctx.quadraticCurveTo(fx + 2, y - 11 - fh * 0.5, fx + 3, y - 11);
            ctx.closePath();
            ctx.fill();
          }
          ctx.globalCompositeOperation = prevOp;

          // ⑥ 三颗上浮的魂点：从鼎口升起又淡出，暗示"经验会变成血"
          ctx.fillStyle = soul;
          for (let k = 0; k < 3; k++) {
            const ph = (at * 0.7 + k / 3) % 1;
            const py = y - 14 - ph * 22;
            const pa = (1 - ph) * 0.7;
            ctx.globalAlpha = fade * pa;
            ctx.beginPath();
            ctx.arc(x - 8 + k * 8 + Math.sin(at * 2 + k) * 2, py, 1.6, 0, TAU);
            ctx.fill();
          }
          ctx.globalAlpha = fade;

          // ⑦ 名牌：鼎名 + "修为换血"（把这条玩法一句话写在它身上，不必读提示条）
          ctx.font = '11px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const label = (CD.name || '炼魂鼎') + ' · 修为换血';
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillText(label, x + 1, y - 42 + 1);
          ctx.fillStyle = soul;
          ctx.fillText(label, x, y - 42);
          ctx.restore();
        }
      }

      // 宝箱最先画（在最底层）：它是全场最该被看见的东西，
      // 压在别的掉落物下面也比被金币盖住强。光晕带呼吸节奏，静止的箱子在怪堆里认不出来。
      if (nChest) {
        const pulse = 0.5 + 0.5 * Math.sin((R._frame || 0) * 0.08);
        const sprite = R.chest || (R.chest = makePixelSprite('chest', 'chest', 7));
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'chest') continue;
          if (!visible(it.x, it.y, 40)) continue;
          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);

          // 光晕调得比较亮是有意的：宝箱不会被磁石吸走，玩家必须"看见它再走过去"，
          // 光晕太淡等于这个奖励不存在。呼吸幅度也放大一点，静态光圈在怪堆里会被淹没。
          ctx.beginPath();
          ctx.arc(x, y, 22 + pulse * 9, 0, TAU);
          ctx.fillStyle = 'rgba(244,196,85,' + (0.16 + pulse * 0.18).toFixed(3) + ')';
          ctx.fill();

          ctx.drawImage(sprite.cv, Math.round(x - sprite.hw), Math.round(y - sprite.hh), sprite.hw * 2, sprite.hh * 2);
        }
      }

      // ---------- 小经验球（像素精灵）----------
      // 【为什么放弃「一条批量路径一次 fill」】旧做法把几百个圆塞进一条 beginPath，
      // 靠一次 fill 省开销；像素画的球是一张位图，只能逐个 drawImage。
      // 但 drawImage 本身就比 arc+fill 便宜（省掉路径光栅化），球又只有 8×8，
      // 缓存极友好 —— 实测这一改没有变慢，还统一了画风。
      // 光晕留在批量路径里：它是一条纯色，合批才划算。
      const halo = nExp <= ORB_HALO_MAX;
      if (nExp) {
        const sprite = R.orbSmall || (R.orbSmall = makePixelSprite('exp', 'exp', 1));
        if (sprite) {
          if (halo) {
            ctx.beginPath();
            for (let i = 0; i < list.length; i++) {
              const it = list[i];
              if (it.kind !== 'exp' || it.big) continue;
              if (!visible(it.x, it.y, 12)) continue;
              const x = lerp(it.px, it.x, alpha);
              const y = lerp(it.py, it.y, alpha);
              ctx.moveTo(x + 6, y);
              ctx.arc(x, y, 6, 0, TAU);
            }
            // 光晕调亮过：原来 0.16 的冷灰几乎看不见，掉落物在暗底上"藏"起来会直接影响可玩性
            ctx.fillStyle = 'rgba(196,210,220,0.26)';
            ctx.fill();
          }
          for (let i = 0; i < list.length; i++) {
            const it = list[i];
            if (it.kind !== 'exp' || it.big) continue;
            if (!visible(it.x, it.y, 12)) continue;
            const x = lerp(it.px, it.x, alpha);
            const y = lerp(it.py, it.y, alpha);
            ctx.drawImage(sprite.cv, Math.round(x - sprite.hw), Math.round(y - sprite.hh),
              sprite.hw * 2, sprite.hh * 2);
          }
        }
      }

      // ---------- 大经验球 ----------
      // 【为什么颜色和大小都要不同】大球是「这一波清得不错」的即时反馈，
      // 但它必须能被人**看见**才有意义：
      //   · 半径 6.4（小球 3.2）—— 视觉面积是 4 倍；
      //   · 琥珀金 + 呼吸光晕（小球是冷灰）—— 在暗底上一眼就能挑出来；
      //   · 金色描边 —— 让它即使在怪堆里也能保持轮廓。
      // 数量远少于小球（小怪 18% 掉、精英 60%、Boss 一圈），所以这里逐个画，
      // 不做那套批量路径优化 —— 一趟最多几十个，省不了什么，代码却会难读得多。
      if (nExpBig) {
        const pulse = 0.5 + 0.5 * Math.sin((R._animT || 0) * 4.2);
        // 大球 8 格 × 3 像素 = 24px（小球是 8px）—— 面积差 9 倍，视觉上一眼能挑出来。
        // 「大球必须被看见」是它存在的全部意义（小怪 18% 掉、精英 60%、Boss 撒一圈）。
        const sprite = R.orbBig || (R.orbBig = makePixelSprite('exp_big', 'exp_big', 3));
        if (sprite) {
          for (let i = 0; i < list.length; i++) {
            const it = list[i];
            if (it.kind !== 'exp' || !it.big) continue;
            if (!visible(it.x, it.y, 24)) continue;
            const x = lerp(it.px, it.x, alpha);
            const y = lerp(it.py, it.y, alpha);

            // 呼吸光晕（像素图本身不闪，靠这圈柔和光晕告诉玩家「这个是特别的」）
            ctx.beginPath();
            ctx.arc(x, y, 13 + pulse * 3, 0, TAU);
            ctx.fillStyle = 'rgba(242,193,78,' + (0.14 + pulse * 0.16).toFixed(3) + ')';
            ctx.fill();

            ctx.drawImage(sprite.cv, Math.round(x - sprite.hw), Math.round(y - sprite.hh),
              sprite.hw * 2, sprite.hh * 2);
          }
        }
      }

      // 金币与红心数量少，走精灵。没有就直接跳过，别白跑一趟循环。
      if (nOther) {
        for (let i = 0; i < list.length; i++) {
          const it = list[i];
          if (it.kind !== 'gold' && it.kind !== 'heart') continue;
          if (!visible(it.x, it.y, 14)) continue;

          const x = lerp(it.px, it.x, alpha);
          const y = lerp(it.py, it.y, alpha);

          if (it.kind === 'gold') {
            const s = R.orbGold || (R.orbGold = makePixelSprite('gold', 'gold', 2));
            ctx.drawImage(s.cv, Math.round(x - s.hw), Math.round(y - s.hh), s.hw * 2, s.hh * 2);
          } else {
            const s = R.orbHeart || (R.orbHeart = makePixelSprite('heart', 'heart', 3));
            ctx.drawImage(s.cv, Math.round(x - s.hw), Math.round(y - s.hh), s.hw * 2, s.hh * 2);
          }
        }
      }
    }

    function drawEnemyShots(w, alpha) {
      if (!w.enemyShots) return;
      const list = w.enemyShots;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!visible(s.x, s.y, 14)) continue;
        const x = lerp(s.px, s.x, alpha);
        const y = lerp(s.py, s.y, alpha);

        // 外圈暗红拖影 + 内核
        ctx.fillStyle = 'rgba(184,64,79,0.45)';
        ctx.beginPath();
        ctx.arc(x, y, s.r * 1.7, 0, TAU);
        ctx.fill();
        ctx.fillStyle = COLOR.enemyShot;
        ctx.beginPath();
        ctx.arc(x, y, s.r, 0, TAU);
        ctx.fill();
        ctx.fillStyle = COLOR.enemyShotCore;
        ctx.beginPath();
        ctx.arc(x, y, s.r * 0.42, 0, TAU);
        ctx.fill();
      }
    }

    // ============================================================
    // 浮动伤害数字
    // ============================================================
    // 只在「精英及以上」出现。后期同屏上千只小怪，每只都飘字会糊成一片，
    // 反而看不出关键伤害。对象池固定 48 个，满了就丢，绝不扩容（宁可少显示也不掉帧）。

    const DMG_MAX = 48;
    const DMG_POOL = [];
    for (let i = 0; i < DMG_MAX; i++) {
      DMG_POOL.push({ active: false, x: 0, y: 0, vy: 0, life: 0, maxLife: 1, text: '', big: false });
    }
    let dmgCursor = 0;

    function spawnDamage(x, y, amount, ratio) {
      // 环形找空位：新字优先顶掉最老的，视觉上比直接丢弃自然
      let d = null;
      for (let i = 0; i < DMG_MAX; i++) {
        const idx = (dmgCursor + i) % DMG_MAX;
        if (!DMG_POOL[idx].active) { d = DMG_POOL[idx]; dmgCursor = (idx + 1) % DMG_MAX; break; }
      }
      if (!d) {
        d = DMG_POOL[dmgCursor];
        dmgCursor = (dmgCursor + 1) % DMG_MAX;
      }
      d.active = true;
      d.x = x + (Math.random() - 0.5) * 14;
      d.y = y - 4;
      d.vy = -32;
      d.life = 0.8;
      d.maxLife = 0.8;
      d.big = ratio >= 0.06;                 // 单次打掉 6% 以上血 → 放大字号
      d.text = amount >= 1000
        ? (amount / 1000).toFixed(1) + 'k'
        : String(Math.round(amount));
    }

    function updateDamage(dt) {
      for (let i = 0; i < DMG_MAX; i++) {
        const d = DMG_POOL[i];
        if (!d.active) continue;
        d.life -= dt;
        if (d.life <= 0) { d.active = false; continue; }
        d.y += d.vy * dt;
        d.vy += 46 * dt;                     // 轻微减速，像被抛起来又落下
      }
    }

    function drawDamage() {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      let lastFont = '';
      for (let i = 0; i < DMG_MAX; i++) {
        const d = DMG_POOL[i];
        if (!d.active) continue;
        const t = d.life / d.maxLife;        // 1 -> 0
        // 前 25% 时间做一次弹出，之后淡出
        const pop = t > 0.75 ? 1 + (1 - t) * 4 * 0.35 : 1;
        const font = (d.big ? 'bold 17px ' : 'bold 13px ') +
          '"Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
        if (font !== lastFont) { ctx.font = font; lastFont = font; }
        ctx.globalAlpha = t > 0.6 ? 1 : t / 0.6;
        if (pop !== 1) {
          ctx.save();
          ctx.translate(d.x, d.y);
          ctx.scale(pop, pop);
          ctx.fillStyle = d.big ? COLOR.dmgTextBig : COLOR.dmgText;
          ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.lineWidth = 3;
          ctx.strokeText(d.text, 0, 0);
          ctx.fillText(d.text, 0, 0);
          ctx.restore();
        } else {
          ctx.fillStyle = d.big ? COLOR.dmgTextBig : COLOR.dmgText;
          ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.lineWidth = 3;
          ctx.strokeText(d.text, d.x, d.y);
          ctx.fillText(d.text, d.x, d.y);
        }
      }
      ctx.globalAlpha = 1;
    }

    // ============================================================
    // 怪物
    // ============================================================

    const ROT_HALF = TAU / ROT_STEPS;

    function drawMobs(w, alpha) {
      const list = w.mobs;
      const art = R.art;
      R.stat.total += list.length;

      // ---------- 第一遍：旋转类怪的脚下阴影 ----------
      // 它们的精灵要跟着朝向转，影子不能烘焙进去，只能每帧画。
      // 但所有影子可以合成一条路径一次 fill，比逐只 beginPath/fill 便宜得多。
      let shadowStarted = false;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m.alive) continue;
        const pack = art[m.defId];
        if (!pack || !pack.rot) continue;
        if (!visible(m.x, m.y, m.def.r + 24)) continue;
        if (!shadowStarted) { ctx.beginPath(); shadowStarted = true; }
        const x = lerp(m.px, m.x, alpha);
        const y = lerp(m.py, m.y, alpha);
        ctx.moveTo(x + pack.shadowRx, y + pack.shadowDy);
        ctx.ellipse(x, y + pack.shadowDy, pack.shadowRx, pack.shadowRy, 0, 0, TAU);
      }
      if (shadowStarted) {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fill();
      }

      // ---------- 第一遍半：影傀之间的魂丝（第五十轮） ----------
      // 【为什么必须有这条线】这个机制的玩法是「趁现在点掉一只，还是放它们合体」，
      //   而这个决定的前提是**看得出它们正在靠拢、还差多远**。
      //   没有这根线，两只朝彼此走的怪和两只朝你走的怪在画面上完全一样 ——
      //   玩家根本不知道自己正在被给一个选择。
      // 【为什么用"亮度"表示进度】距离越近线越亮、越粗，最后接上时是一道实线；
      //   玩家不需要任何文字说明就能读出"快合上了"。
      // ★它画在怪身下（第一遍半），不能盖住精灵本体 —— 精灵是像素图，压一条线上去
      //   会让"谁是罔两、谁是影傀"变得难认（合体后那一对本来就会消失）。
      const mergeRule = (C && C.MERGE) || null;
      if (mergeRule && list.length) {
        // 先建一次 id → 怪的索引：一对影傀要互相找到对方，逐只线性找是 O(n²)，
        // 后期场上千只怪时这一遍会变成主循环里最贵的一段。
        let pairIdx = null;
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m.alive || !m.def || !m.def.mergeSoul) continue;
          if (!pairIdx) pairIdx = {};
          pairIdx[m.id] = m;
        }
        if (pairIdx) {
          const md = mergeRule.mergeDist || 52;
          for (let i = 0; i < list.length; i++) {
            const m = list[i];
            if (!m.alive || !m.def || !m.def.mergeSoul || !m.mateId) continue;
            const o = pairIdx[m.mateId];
            if (!o) continue;
            if (m.id > o.id) continue;          // 一对只画一次
            const ax = lerp(m.px, m.x, alpha);
            const ay = lerp(m.py, m.y, alpha);
            const bx = lerp(o.px, o.x, alpha);
            const by = lerp(o.py, o.y, alpha);
            const dx = bx - ax;
            const dy = by - ay;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            // 0 = 刚浮现（相距四百多像素）→ 1 = 已经贴住
            const near = Math.max(0, Math.min(1, 1 - (d - md) / 420));
            if (near <= 0.02) continue;         // 太远就不画，免得满屏都是淡线
            const pulse = 0.72 + 0.28 * Math.sin((R._frame || 0) * 0.22);
            ctx.save();
            ctx.strokeStyle = mergeRule.markColor || '#dfe6ef';
            // ★亮度从 (0.1 + 0.55n) 提到 (0.16 + 0.6n)：第一版在 220px 间距上只有
            //   0.37 的不透明度，3 倍截图中那条线被玩家自己挡住之后几乎读不出来。
            ctx.globalAlpha = (0.16 + 0.6 * near) * (0.65 + 0.35 * pulse);
            ctx.lineWidth = 1 + 1.6 * near;
            ctx.setLineDash([5, 7]);
            ctx.lineDashOffset = -((R._frame || 0) * 0.7) % 12;
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(bx, by);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.restore();
          }
        }
      }

      // ---------- 第二遍：词缀标记环（只给变异怪画） ----------
      // 【为什么用脚下的环，而不是给精灵染色】精灵是烘好的像素图，染色会糊掉细节；
      //   而且后期同屏几百只怪，整屏泛红等于没标记 —— 一个亮色环在暗红地面上最扎眼。
      // 带词缀的怪只占几个百分点，这一遍几乎不花时间，不做合批（合批反而要单独路径）。
      // ★颜色一律取 AFFIX_MAP 里的值，不在这里写死：数据层只允许暗红/琥珀/冷灰三系，
      //   写死一处颜色以后就会和表里的值慢慢漂移（同一个词缀两种颜色）。
      const affixMap = (C && C.AFFIX_MAP) || null;
      if (affixMap) {
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (!m.alive || !m.affix) continue;
          const af = affixMap[m.affix];
          if (!af) continue;
          const pack = art[m.defId];
          if (!pack) continue;
          if (!visible(m.x, m.y, m.def.r + 24)) continue;
          const ax = lerp(m.px, m.x, alpha);
          const ay = lerp(m.py, m.y, alpha);
          // ★半径取精灵实际半宽（pack.body.hw），不是逻辑半径 r ——
          //   换成像素画风之后视觉宽度不等于 2.4r，用 r 画会让环套在怪身上或飘在怪外面。
          //   ×1.15 是实测出来的：1.02 时环贴着脚边、混战里几乎看不见（截图复核过）。
          const rr = pack.body.hw * 1.15;
          // 先铺一层很淡的填充（地面上的"光晕"），再压一道细描边：
          // 只有描边的话在暗红地面上偏细，只有填充的话边界糊。两个一起才「一眼能认出是环」。
          ctx.beginPath();
          ctx.ellipse(ax, ay + pack.body.hh * 0.46, rr, rr * 0.4, 0, 0, TAU);
          ctx.fillStyle = af.color;
          ctx.globalAlpha = 0.12;
          ctx.fill();
          ctx.globalAlpha = 0.9;
          ctx.strokeStyle = af.color;
          ctx.lineWidth = 2;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }

      // ---------- 第二遍半：事件精英的标记环 + 名牌（挑战者 / 山魈） ----------
      // 【为什么要单独画】挑战者混在几百只怪里，靠血条区分是不够的：
      //   血条是「被打过之后」才明显的东西，而玩家需要在**看见它的第一帧**就知道
      //   「这只值一个宝箱，值得掉头」。所以给它三道标记：双环 + 呼吸的描边 + 名牌。
      // 第四十一轮把这一遍扩成「所有事件精英」：山魈同样需要在第一帧被认出来 ——
      // 玩家盯着屏幕中间打怪，不会注意到两百多像素外那只绕着走的。
      // ★两种标记的颜色写死在这里是**故意的**：词缀环的颜色来自 AFFIX_MAP（数据驱动），
      //   但事件精英的标记是「界面对世界的承诺」，不该被以后改词缀表的人顺手改掉。
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m.alive || !m.def) continue;
        // 挑战者 = 琥珀金「值得掉头去收的宝箱」；山魈 = 暗红偏橙「必须点掉的靶子」；
        // 双生妖（第四十五轮）= 冷青灰「这一对必须一起收」；
        // 饕餮（第四十七轮）= 墨绿「它正在把你的东西搬走」——
        //   四色必须两两拉得开，否则玩家会把「回头去收它」当成和别的精英一样的顺手事。
        // 第五十五轮：回春巫 = 冷灰青「先点掉这个奶妈」——
        //   ★与双生妖同为 #8fb6c8 是故意的：它们都是「你优先处理的目标」，
        //   而回春巫另有名牌 + 施法时的青光环区分，不会混。
        const mkColor = m.def.healer ? '#8fb6c8'
          : (m.def.challenger ? '#f2c14e'
          : (m.def.summoner ? '#e0673f'
          : (m.def.twins ? '#8fb6c8'
          : (m.def.devourer ? '#8f9d5f'
          // ★影傀与罔两**同色**：它们是同一族（罔两就是两只影傀叠出来的），
          //   用同一个冷白环，玩家一眼能把「那一对 + 它合出来的那只」归成一类。
          //   代价是「罔两值 2 个宝箱」这条信息读不出来 —— 那靠合体播报与名牌，
          //   不靠环色（环色只回答"它是不是事件怪"）。
          : ((m.def.mergeSoul || m.def.wangliang)
              ? ((mergeRule && mergeRule.markColor) || '#dfe6ef') : null)))));
        if (!mkColor) continue;
        const mkLabel = m.def.healer ? (m.def.name || '回春巫')
          : (m.def.challenger ? '挑战者'
          : (m.def.summoner ? (m.def.name || '山魈')
          : (m.def.twins ? '双生'
          : (m.def.devourer ? (m.def.name || '饕餮')
          : (m.def.mergeSoul ? (m.def.name || '影傀')
          : (m.def.wangliang ? (m.def.name || '罔两') : (m.def.name || '')))))));
        const pack = art[m.defId];
        if (!pack) continue;
        if (!visible(m.x, m.y, m.def.r + 40)) continue;
        const cx = lerp(m.px, m.x, alpha);
        const cy = lerp(m.py, m.y, alpha);
        const rr = pack.body.hw * 1.3;
        // 呼吸：0.75~1 之间缓慢起伏，让人一眼看出这是「活着的标记」而不是地形装饰
        const pulse = 0.75 + 0.25 * Math.sin(R._frame ? R._frame * 0.08 : 0);
        ctx.globalAlpha = 0.14 * pulse;
        ctx.fillStyle = mkColor;
        ctx.beginPath();
        ctx.ellipse(cx, cy + pack.body.hh * 0.46, rr, rr * 0.42, 0, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = mkColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.ellipse(cx, cy + pack.body.hh * 0.46, rr, rr * 0.42, 0, 0, TAU);
        ctx.stroke();
        // 外圈一道更细的虚线感（用低透明度的第二圈代替虚线，省 setLineDash 的状态切换）
        ctx.globalAlpha = 0.45;
        ctx.beginPath();
        ctx.ellipse(cx, cy + pack.body.hh * 0.46, rr + 5, (rr + 5) * 0.42, 0, 0, TAU);
        ctx.stroke();
        // 名牌：画在头顶（血条再往上 16px）。
        // ★这里必须 save/restore：字体、对齐方式、基线都是画布全局状态，
        //   漏了 restore 会让后面所有文字（伤害飘字）跟着改字体与对齐 ——
        //   表现是「一出现挑战者，全场伤害数字都歪了」，而且只在这一只活着时复现。
        ctx.save();
        const top = cy - pack.body.hh - 16;
        ctx.globalAlpha = 0.95;
        ctx.font = '11px "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(0,0,0,0.66)';
        ctx.fillText(mkLabel, cx + 1, top + 1);
        ctx.fillStyle = mkColor;
        ctx.fillText(mkLabel, cx, top);
        ctx.restore();
        ctx.globalAlpha = 1;
      }

      // ---------- 第三遍：本体 ----------
      const dm = R._dmgMap;
      const frame = R._frame;
      const AM = window.VS.ActorMotion;
      // ★整帧只问状态机一次起伏，再用 id 奇偶错开相位：
      //   几百只怪各调一次函数（还要读 clock、取模）会积成可见的每帧开销。
      const wob0 = AM ? AM.mobWobble(0) : 0;
      for (let i = 0; i < list.length; i++) {
        const m = list[i];
        if (!m.alive) continue;
        const pack = art[m.defId];
        if (!pack) continue;
        if (!visible(m.x, m.y, m.def.r + 24)) continue;

        const x = lerp(m.px, m.x, alpha);
        const y = lerp(m.py, m.y, alpha);
        R.stat.drawn += 1;

        const flash = m.flash > 0;

        // ★怪物的两帧起伏用**整数像素位移**，不是压扁：
        //   改目标尺寸会让 drawImage 走缩放采样（源/目标尺寸不等 + 小数宽高），
        //   几百只怪同屏实测多花 15ms、掉到 40fps；位移则始终是 1:1 快速 blit。
        //   像素风里形变本来就会破坏网格，整格挪动才是正统做法。
        //   命中定格时状态机 clock 不推进，整屏怪会一起定住一瞬。
        const wob = (wob0 + (m.id & 1)) & 1;
        const dx = wob ? 1 : 0;
        const dy = wob ? 2 : 0;

        if (pack.rot) {
          // 旋转：按速度方向查角度档位
          // 【`|| 0` 不是多余的】解码端已经保证 vx/vy 不会是 undefined（见 proto_bin.js
          // 里「可选字段必须补回 0」那段），这里是第二层保险：万一漏进来一个 undefined/NaN，
          // atan2 会算出 NaN，拿 NaN 去索引图集会取到 undefined，然后渲染循环每帧抛异常，
          // 表现为「画面卡住不动」。注意用 `|| 0` 而不是 `| 0` —— 后者会把 0.4 这种
          // 慢速值截断成 0，让慢速怪全部朝右。
          const vx = m.vx || 0;
          const vy = m.vy || 0;
          const ang = Math.atan2(vy, vx);
          let k = Math.round(ang / ROT_HALF);
          k = ((k % ROT_STEPS) + ROT_STEPS) % ROT_STEPS;
          const s = flash ? pack.atlasFlash[k] : pack.atlas[k];
          ctx.drawImage(s.cv, Math.round(x - s.hw + dx), Math.round(y - s.hh + dy), s.hw * 2, s.hh * 2);
        } else {
          // 朝左的怪取镜像版（像素画不能随便转，见 buildMobArt 的说明）。
          // 绘制坐标取整：矩阵左上角只要落在半像素上，格边就会被插值成灰边，
          // 整批怪一起「发糊」—— 这是像素风最容易忽略、也最致命的一处。
          const left = pack.bodyL && (m.vx || 0) < 0;
          const s = flash ? (left ? pack.flashL : pack.flash) : (left ? pack.bodyL : pack.body);
          ctx.drawImage(s.cv, Math.round(x - s.hw + dx), Math.round(y - s.hh + dy), s.hw * 2, s.hh * 2);
        }

        // ---------- 饕餮的肚子（第四十七轮） ----------
        // 【为什么画在这里、画在精灵之后】它吞了多少只能靠「肚子鼓起来 + 里面发亮」表达。
        //   服务端每吃一份会把 m.r 长 0.5（最多 +7），r 本来就在快照里 ——
        //   所以「几份」这个数字不用新开协议字段，用半径差就够读了（协议零改动）。
        // 【为什么是贴地的暗金光而不是描边】它说的是「肚子里的东西在发光」，
        //   画成轮廓线会和上面那道标记环抢眼睛，两圈叠在一起谁也读不清。
        if (m.def.devourer) {
          const grown = Math.max(0, m.r - m.def.r);
          if (grown > 0.4) {
            // ★上限从表里读（不写死 7）：它同时决定「吃满时长到多大」，
            //   写死的话以后调 growMax，画面的光了就永远停在旧比例上。
            const gmax = (C.DEVOURER && C.DEVOURER.growMax) || 12;
            const k = Math.min(1, grown / gmax);
            // ★尺寸跨度要够大（0.30 → 0.85 倍身宽）：第一版 0.42→0.76 在 3 倍截图里
            //   两只「吃了 7 份 / 13 份」的饕餮看起来一模一样 —— 那这个提示就等于没有。
            const br = pack.body.hw * (0.30 + 0.55 * k);
            const gy = y + pack.body.hh * 0.2;
            const prevOp2 = ctx.globalCompositeOperation;
            ctx.globalCompositeOperation = 'lighter';
            const gBelly = ctx.createRadialGradient(x, gy, br * 0.06, x, gy, br);
            gBelly.addColorStop(0, 'rgba(255,214,120,' + (0.5 * k).toFixed(3) + ')');
            gBelly.addColorStop(0.5, 'rgba(226,182,84,' + (0.3 * k).toFixed(3) + ')');
            gBelly.addColorStop(1, 'rgba(160,120,40,0)');
            ctx.fillStyle = gBelly;
            ctx.beginPath();
            ctx.arc(x, gy, br, 0, TAU);
            ctx.fill();
            ctx.globalCompositeOperation = prevOp2;
            // 再补一道很淡的**边界**：光晕本身没有轮廓，光靠亮度玩家分不清「肥了多少」
            // （与灵泉/引魂灯同一条：判定范围要靠一条环说清楚）
            ctx.globalAlpha = 0.35 * k;
            ctx.strokeStyle = '#ffe9b0';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(x, gy, br * 0.92, 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }

        // ---------- 血条 + 伤害采样（只对精英及以上做） ----------
        const tier = m.def.tier;
        if (tier === 'elite' || tier === 'commander' || tier === 'boss') {
          // 血条宽度跟着**精灵实际宽度**走：换成像素画风之后，怪的视觉宽度
          // 不再等于 2.4r（像素图是方的，留白与描边都不吃逻辑半径），
          // 继续写 r 会让条比怪窄一大截，看着像挂在空气上。
          const bw = Math.round(pack.body.hw * 1.25);
          const bh = tier === 'boss' ? 6 : 3;
          const top = y - pack.body.hh - 8;
          const ratio = Math.max(0, m.hp / m.maxHp);

          ctx.fillStyle = 'rgba(0,0,0,0.62)';
          ctx.fillRect(x - bw / 2 - 1, top - 1, bw + 2, bh + 2);
          ctx.fillStyle = tier === 'boss' ? '#c93a3a'
            : (tier === 'commander' ? '#d9642f'
            // 双生妖（第四十五轮）：血条跟着它自己的标记色走 ——
            // 冷蓝的环配琥珀金的血条会让人以为是两只不同的怪。
            // 饕餮（第四十七轮）同一口径：血条 = 标记色（墨绿），
            // 否则「绿色标记 + 橙色血条」的精英看起来像是两条不同的东西叠在一起。
            : (m.def.challenger ? '#f2c14e'
            : (m.def.twins ? '#8fb6c8'
            : (m.def.devourer ? '#8f9d5f' : '#e08a3a'))));
          ctx.fillRect(x - bw / 2, top, bw * ratio, bh);

          // 掉血了就飘一个数（渲染层自己比对上一帧血量，不改世界数据）
          const prev = dm.get(m.id);
          if (prev !== undefined && m.hp < prev - 0.5) {
            spawnDamage(x, top, prev - m.hp, m.maxHp ? (prev - m.hp) / m.maxHp : 0);
          }
          dm.set(m.id, m.hp);
        }
      }

      // 缓存别无限涨：每 10 秒（600 帧）清一次，代价只是丢一帧的飘字
      if (frame % 600 === 0) dm.clear();
    }

    // 投射物绘制（第十五轮美化）
    //
    // 【为什么按 kind 分化形状】改之前：除了「回旋刃」和「直线弹」，
    //   其余投射物（追踪法球、抛物线火球、骨刺…）画的是**同一套**
    //   「光晕 + 内核 + 小白点」—— 玩家分不清手里这件武器在干什么，
    //   也看不出「哪个是我打的、哪个是冲我来的」。这就是「效果单一」的来源。
    // 现在每种 kind 有自己的形状语言，一眼可辨：
    //   line      → 细长光刃（拉长本体 + 长拖尾 + 前缘亮点，方向感强）
    //   homing    → 脉动光球（半径呼吸 + 双层光晕 + 两颗绕行微粒）
    //   boomerang → 旋转刃 + 残影（让「转」看得见，而不是闪一下）
    //   parabola  → 拖尾火球（尾迹渐细 + 落点提示）
    // ★配色一律取武器自身的 color：禁紫的约定在数据层已经守住了，
    //   这里只改形状与动效，不引入新色。
    function drawProjectiles(w, alpha) {
      const list = w.projectiles;
      const t = w.time;
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        // 判定放宽到 44：拖尾画在身后，用 18 会让「刚出屏」的拖尾被整条切掉
        if (!visible(p.x, p.y, 44)) continue;
        const x = lerp(p.px, p.x, alpha);
        const y = lerp(p.py, p.y, alpha);

        // ★飞行类技能特效：直线弹 / 追踪球 / 回旋刃 / 抛物线各用一种像素特效，
        // 库不可用时继续走下面原来的矢量绘制。
        const skillFx = window.VS.PixelFx;
        if (skillFx && skillFx.ready) {
          const pick = skillFx.projectileFor(p, x, y);
          if (pick && skillFx.draw(ctx, pick.name, pick.key, pick.o)) continue;
        }

        if (p.kind === 'boomerang') {
          // 残影：先画两个更早的位置，再画本体 —— 高速旋转才看得出「在转」
          for (let k = 2; k >= 1; k--) {
            ctx.save();
            ctx.translate(x - p.vx * 0.012 * k, y - p.vy * 0.012 * k);
            ctx.rotate(t * 14 - k * 0.5);
            ctx.globalAlpha = 0.18 * ((3 - k) / 2);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.r, -p.r * 0.32, p.r * 2, p.r * 0.64);
            ctx.fillRect(-p.r * 0.32, -p.r, p.r * 0.64, p.r * 2);
            ctx.restore();
          }
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(t * 14);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.r, -p.r * 0.35, p.r * 2, p.r * 0.7);
          ctx.fillRect(-p.r * 0.35, -p.r, p.r * 0.7, p.r * 2);
          // 刃口高光：给「转」一个方向感
          ctx.fillStyle = 'rgba(255,240,220,0.85)';
          ctx.fillRect(p.r * 0.35, -p.r * 0.16, p.r * 0.5, p.r * 0.32);
          ctx.restore();
          ctx.globalAlpha = 1;
          continue;
        }

        if (p.kind === 'line') {
          // 细长光刃：整条朝飞行方向拉长，前缘更亮 —— 一眼看出朝哪飞
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(Math.atan2(p.vy, p.vx));
          ctx.globalAlpha = 0.28;
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.r * 4.4, -p.r * 0.5, p.r * 4.4, p.r);
          ctx.globalAlpha = 1;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.ellipse(0, 0, p.r * 1.7, p.r * 0.62, 0, 0, TAU);
          ctx.fill();
          ctx.fillStyle = 'rgba(255,246,230,0.9)';
          ctx.beginPath();
          ctx.ellipse(p.r * 0.72, 0, p.r * 0.5, p.r * 0.3, 0, 0, TAU);
          ctx.fill();
          ctx.restore();
          ctx.globalAlpha = 1;
          continue;
        }

        if (p.kind === 'homing') {
          // 脉动光球：半径随正弦呼吸，两层光晕 + 两颗绕行微粒
          //（微粒像「在锁定目标」，与直线弹的「直来直去」形成对比）
          const pulse = 1 + Math.sin(t * 9 + i) * 0.12;
          ctx.fillStyle = p.color;
          ctx.globalAlpha = 0.16;
          ctx.beginPath();
          ctx.arc(x, y, p.r * 2.6 * pulse, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 0.34;
          ctx.beginPath();
          ctx.arc(x, y, p.r * 1.6 * pulse, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, p.r * pulse, 0, TAU);
          ctx.fill();
          for (let k = 0; k < 2; k++) {
            const a = t * 7 + k * Math.PI;
            dot(ctx, x + Math.cos(a) * p.r * 1.9, y + Math.sin(a) * p.r * 1.9,
              p.r * 0.3, 'rgba(255,236,204,0.85)');
          }
          dot(ctx, x - p.r * 0.25, y - p.r * 0.25, p.r * 0.32, 'rgba(255,255,255,0.8)');
          continue;
        }

        if (p.kind === 'parabola') {
          // 抛物线火球：尾迹渐细 + 本体，落点由 strikes 那套预警圈负责
          const speed2 = Math.hypot(p.vx, p.vy) || 1;
          const bx = p.vx / speed2;
          const by = p.vy / speed2;
          ctx.fillStyle = p.color;
          ctx.globalAlpha = 0.22;
          for (let k = 1; k <= 3; k++) {
            ctx.beginPath();
            ctx.arc(x - bx * p.r * 1.7 * k, y - by * p.r * 1.7 * k,
              p.r * (1.25 - k * 0.3), 0, TAU);
            ctx.fill();
          }
          ctx.globalAlpha = 0.4;
          ctx.beginPath();
          ctx.arc(x, y, p.r * 1.8, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.beginPath();
          ctx.arc(x, y, p.r, 0, TAU);
          ctx.fill();
          dot(ctx, x - p.r * 0.3, y - p.r * 0.3, p.r * 0.35, 'rgba(255,248,226,0.9)');
          continue;
        }

        // 兜底（其余 kind，如骨刺）：保留原有的光晕 + 内核 + 高光
        ctx.fillStyle = p.color;
        ctx.globalAlpha = 0.3;
        ctx.beginPath();
        ctx.arc(x, y, p.r * 1.8, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, TAU);
        ctx.fill();
        dot(ctx, x - p.r * 0.28, y - p.r * 0.28, p.r * 0.34, 'rgba(255,255,255,0.7)');
      }
    }

    function drawOrbits(w, alpha) {
      const list = w.orbits;
      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.x === undefined) continue;
        if (!visible(o.x, o.y, o.size + 6)) continue;

        // 旋转的圣经：带光晕的竖条
        ctx.fillStyle = 'rgba(242,193,78,0.22)';
        ctx.beginPath();
        ctx.arc(o.x, o.y, o.size * 1.15, 0, TAU);
        ctx.fill();
        ctx.fillStyle = o.color;
        ctx.fillRect(o.x - o.size * 0.6, o.y - o.size, o.size * 1.2, o.size * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.fillRect(o.x - o.size * 0.6, o.y - o.size + 3, o.size * 1.2, 2);
      }
    }

    function drawStrikes(w, alpha) {
      const list = w.strikes;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (!visible(s.x, s.y, s.r + 30)) continue;

        const progress = 1 - Math.max(0, s.life) / Math.max(0.001, s.delay);

        // ---------- 陨星（第四十轮） ----------
        // 【要画清三件事】圈在哪、还有多久、砸下来的东西有多大。
        //   少任何一样，玩家都会得出「这东西是随机掉的」这个错误结论 ——
        //   而陨星的全部价值就在「1.8 秒内做出走位决定」。
        // ★配色守项目约定：琥珀金 #ffcf5c / 橙红 #ff8c42，不用紫。
        if (s.kind === 'meteor') {
          const t = progress;                 // 0 → 1（预警开始 → 落地）
          const fall = t * t;                 // 火球越接近终点越快（重力感）

          // ① 圈内淡色填充：一眼看出「这个范围会挨打」
          ctx.globalAlpha = 0.10 + 0.16 * t;
          ctx.fillStyle = '#ff8c42';
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, TAU);
          ctx.fill();

          // ② 收缩的警示环：从 1.9 倍收到正好等于 r，收满即落地。
          //    「环收到边缘」是所有玩家都认得的倒计时语言，不用写字。
          ctx.globalAlpha = 0.95;
          ctx.strokeStyle = '#ffcf5c';
          ctx.lineWidth = 2 + 1.5 * t;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * (1.9 - 0.9 * t), 0, TAU);
          ctx.stroke();

          // ③ 圈心十字：怪密的时候纯靠颜色分不出圆心在哪，十字给一个硬参照
          const arm = 10 + 6 * t;
          ctx.globalAlpha = 0.55;
          ctx.beginPath();
          ctx.moveTo(s.x - arm, s.y);
          ctx.lineTo(s.x + arm, s.y);
          ctx.moveTo(s.x, s.y - arm);
          ctx.lineTo(s.x, s.y + arm);
          ctx.stroke();

          // ④ 火球：从上方 380px 竖直落下。
          //   ★距离必须**小于屏幕半高**（1280×860 时半高 430）：第一版给了 560，
          //     结果前一半预警时间里火球在屏幕外，玩家只看到一个空圈 ——
          //     而「天上有个东西冲你砸下来」才是这条预警最有力的信息。
          //   ★必须竖直 —— 斜抛会让玩家按「落点 = 火球正下方」算错位置。
          const fy = s.y - 380 * (1 - fall);

          // 光晕：让它在暗红地面上「发亮」，而不是一颗扁平的橙点
          const glow = ctx.createRadialGradient(s.x, fy, 2, s.x, fy, 46);
          glow.addColorStop(0, 'rgba(255,243,176,0.55)');
          glow.addColorStop(0.45, 'rgba(255,140,66,0.28)');
          glow.addColorStop(1, 'rgba(255,140,66,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(s.x, fy, 46, 0, TAU);
          ctx.fill();

          // 尾焰：沿竖直方向回看 5 段，越远越淡越小
          for (let k = 5; k >= 1; k--) {
            ctx.globalAlpha = 0.34 / k;
            ctx.fillStyle = '#ff8c42';
            ctx.beginPath();
            ctx.arc(s.x, fy - k * 22, 14 - k * 1.8, 0, TAU);
            ctx.fill();
          }
          ctx.globalAlpha = 0.75;
          ctx.fillStyle = '#ff8c42';
          ctx.beginPath();
          ctx.arc(s.x, fy, 21, 0, TAU);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.fillStyle = '#fff3b0';
          ctx.beginPath();
          ctx.arc(s.x, fy, 11, 0, TAU);
          ctx.fill();
          continue;
        }

        // ---------- 地脉灵泉（第四十二轮） ----------
        // 【要画清三件事】圈在哪（站进去才有用）、充到几成（还差多少）、
        //   爆了会多大（300 的前景承诺）。少任何一样，它就是一个「路过会发光的地贴」。
        //
        // ★进度不靠自己积分：服务端把「还差几秒充满」写在 s.delay 里，
        //   两端算出来的进度必然一致（各自按玩家距离积分会飘）。
        // ★配色 = 玉青 #5fe0b0（跨层契约，与火橙 / 圣水冷灰 / 进化琥珀金都分得开）。
        //   项目禁紫禁紫蓝，这里用青绿表达「地脉灵气」，不碰紫。
        if (s.kind === 'ley') {
          const CH = (C.LEYLINE && C.LEYLINE.chargeSec) || 2;
          // delay 是可选字段：充满那一帧服务端写 0 会被协议省略 → undefined 当 0 处理
          const left = s.delay || 0;
          let ratio = 1 - left / CH;
          if (ratio < 0) ratio = 0;
          if (ratio > 1) ratio = 1;

          const t = R._animT || 0;

          // ① 地面底色：越充能越亮（站进去能立刻看到「有反应」）
          const glow = ctx.createRadialGradient(s.x, s.y, 2, s.x, s.y, s.r * 1.15);
          glow.addColorStop(0, 'rgba(95,224,176,' + (0.10 + 0.30 * ratio).toFixed(3) + ')');
          glow.addColorStop(0.6, 'rgba(95,224,176,' + (0.05 + 0.14 * ratio).toFixed(3) + ')');
          glow.addColorStop(1, 'rgba(95,224,176,0)');
          ctx.globalAlpha = 1;
          ctx.fillStyle = glow;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 1.15, 0, TAU);
          ctx.fill();

          // ② 站桩圈：虚线圈 + 呼吸（圈是「站进这里」的唯一硬参照，不能省）
          const pulse = 0.5 + 0.5 * Math.sin(t * 3.2);
          ctx.globalAlpha = 0.45 + 0.30 * pulse;
          ctx.strokeStyle = '#5fe0b0';
          ctx.lineWidth = 1.6;
          ctx.setLineDash([6, 6]);
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, TAU);
          ctx.stroke();
          ctx.setLineDash([]);

          // ③ 进度环：从 12 点方向顺时针填满（填满即爆发，不用写字）
          if (ratio > 0) {
            ctx.globalAlpha = 0.95;
            ctx.strokeStyle = '#b7ffe4';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r - 5, -Math.PI / 2, -Math.PI / 2 + TAU * ratio);
            ctx.stroke();
          }

          // ④ 圈心三根「地脉符」：绕圈慢转，让静止的圈看起来是活的
          ctx.globalAlpha = 0.55 + 0.35 * ratio;
          ctx.fillStyle = '#8ff3cf';
          for (let k = 0; k < 3; k++) {
            const a = t * 0.9 + (k * TAU) / 3;
            const rr = s.r * 0.52;
            const gx = s.x + Math.cos(a) * rr;
            const gy = s.y + Math.sin(a) * rr;
            ctx.fillRect(gx - 2, gy - 7, 4, 14);
          }

          // ⑤ 上升的灵光：4 颗光点在圈内往上飘（纯表现，不影响判定）
          for (let k = 0; k < 4; k++) {
            const ph = (t * 0.55 + k * 0.25) % 1;
            const a = (k * TAU) / 4 + t * 0.4;
            const rr = s.r * (0.25 + 0.55 * ((k + 1) % 3) / 2);
            ctx.globalAlpha = (1 - ph) * (0.35 + 0.45 * ratio);
            ctx.beginPath();
            ctx.arc(s.x + Math.cos(a) * rr, s.y + Math.sin(a) * rr - ph * 34, 2.2, 0, TAU);
            ctx.fill();
          }

          // ⑥ 快满了：外圈再加一道亮环，给「还有半秒」一个明确的倒计时感
          if (ratio > 0.75) {
            const k2 = (ratio - 0.75) / 0.25;
            ctx.globalAlpha = 0.25 + 0.55 * k2 * (0.5 + 0.5 * Math.sin(t * 18));
            ctx.strokeStyle = '#eafff8';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r + 6 * k2, 0, TAU);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
          continue;
        }

        if (s.kind === 'parabola') {
          // 审判之锤：沿抛物线飞过去
          const t = progress;
          const x = lerp(s.sx, s.x, t);
          const y = lerp(s.sy, s.y, t);
          const arc = Math.sin(t * Math.PI) * 90;   // 抛物高度

          // ★轨迹残影：沿同一条抛物线回看 3 个时刻，把「出手 → 划弧 → 落点」
          //   这条路径画清楚。用渐隐小锤影，不额外加载任何素材。
          for (let k = 3; k >= 1; k--) {
            const tk = t - k * 0.055;
            if (tk <= 0) continue;
            const kx = lerp(s.sx, s.x, tk);
            const ky = lerp(s.sy, s.y, tk) - Math.sin(tk * Math.PI) * 90;
            ctx.save();
            ctx.globalAlpha = 0.34 / k;
            ctx.translate(kx, ky);
            ctx.rotate(tk * 6);
            ctx.fillStyle = COLOR.warn;
            ctx.fillRect(-6, -9, 12, 11);
            ctx.restore();
          }

          // 落点预告环
          ctx.strokeStyle = COLOR.warn;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * (0.55 + 0.45 * t), 0, TAU);
          ctx.stroke();

          // 锤头 + 柄，飞行中带一点旋转
          ctx.save();
          ctx.translate(x, y - arc);
          ctx.rotate(t * 6);
          ctx.fillStyle = '#d9c7a0';
          ctx.fillRect(-9, -13, 18, 15);
          ctx.fillStyle = '#8a7b5c';
          ctx.fillRect(-2, -4, 4, 20);
          ctx.restore();
          continue;
        }

        // 落雷：预告环由大收小，收完就劈
        ctx.strokeStyle = COLOR.warn;
        ctx.lineWidth = 2 + 2 * (1 - progress);
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * (1.6 - 0.6 * progress), 0, TAU);
        ctx.stroke();

        // 最后 40% 时间画一道预兆竖线
        if (progress > 0.6) {
          ctx.globalAlpha = (progress - 0.6) / 0.4;
          const grd = ctx.createLinearGradient(0, s.y - 400, 0, s.y);
          grd.addColorStop(0, 'rgba(255,243,176,0)');
          grd.addColorStop(1, 'rgba(255,243,176,0.95)');
          ctx.fillStyle = grd;
          ctx.fillRect(s.x - 3, s.y - 400, 6, 400);
          ctx.globalAlpha = 1;
        }
      }
    }

    /**
     * 击杀爆发（第七十九轮）：在既有 death 特效上叠一层冲击环 + 碎芒 + 魂火。
     *
     * ★为什么画在这里而不是加新特效 kind：death 已经在协议串池、快照与 pixelfx 里跑通，
     *   新 kind 要动串池/带宽/老客户端兼容，代价远大于这一层纯渲染增强。
     *   本函数只读 e 上本来就有的 x/y/r/color/life/maxLife —— 单机与联机看到同一套效果。
     * ★形状用坐标哈希而不是 Math.random：同一只怪在同一位置每次炸开都得一样，
     *   也绝不碰世界随机流（nextRand），否则波次与掉落会被视觉副作用带偏。
     */
    function drawKillBurst(e, t) {
      const r = Math.max(8, e.r || 10);
      if (!visible(e.x, e.y, r * 3.2)) return;

      const k = 1 - t;                       // 0 → 1：从炸开到散尽
      const big = r >= 18;                   // 精英 / Boss：多一道环、多一倍的碎芒
      // 位置的整数哈希：同位置稳定、相邻位置又能错开，避免连杀时全屏一个模子。
      const h = ((Math.round(e.x) * 73856093) ^ (Math.round(e.y) * 19349663)) >>> 0;
      const prevOp = ctx.globalCompositeOperation;
      ctx.globalCompositeOperation = 'lighter';
      R.stat.killBursts += 1;

      // ① 外冲击环：从尸身往外推，越到后期越淡。加法混合压不住暗红地面。
      ctx.globalAlpha = t * 0.85;
      ctx.strokeStyle = mixRgba('#ffcf5c', '#ffffff', 0.45, 1);
      ctx.lineWidth = 1.5 + 3.5 * t;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r * (1.1 + 1.7 * k), 0, TAU);
      ctx.stroke();

      // ② 精英以上补一道内环：两道环错开走，才有"厚重"的分层感；小怪仍是一道，
      //    不然满屏小怪各画两圈，视觉噪音盖过真正的大场面。
      if (big) {
        ctx.globalAlpha = t * 0.45;
        ctx.strokeStyle = rgbaOf('#ff8c42', 1);
        ctx.lineWidth = 2 + 2 * t;
        ctx.beginPath();
        ctx.arc(e.x, e.y, r * (0.75 + 1.15 * k), 0, TAU);
        ctx.stroke();
      }

      // ③ 白热核心：径向渐变收口，比原来那个纯色小圆有"热"的层次。
      const coreR = r * (0.85 + 0.65 * t);
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, coreR);
      g.addColorStop(0, 'rgba(255,251,232,' + (0.9 * t).toFixed(3) + ')');
      g.addColorStop(0.42, 'rgba(255,180,60,' + (0.55 * t).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(255,120,40,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(e.x, e.y, coreR, 0, TAU);
      ctx.fill();

      // ④ 碎芒：朝外飞的小三角。颜色取妖物本色往琥珀金拉一半，
      //    既保留"这是什么妖"的辨识度，又不会在暗底上变成一块看不清的脏色。
      const n = big ? 9 : 6;
      ctx.fillStyle = mixRgba(e.color || '#ff8c42', '#ffcf5c', 0.5, t * 0.9);
      const phase = (h % 997) / 997 * TAU;
      for (let i = 0; i < n; i++) {
        const a = phase + i * TAU / n;
        const ca = Math.cos(a), sa = Math.sin(a);
        const d = r * (0.7 + 2.0 * k) + ((h >> (i % 12)) & 7) * 0.7;
        const fx = e.x + ca * d, fy = e.y + sa * d;
        const len = r * (0.35 + 0.7 * t);
        const wd = Math.max(1.2, r * 0.11 * t);
        ctx.beginPath();
        ctx.moveTo(fx + ca * len, fy + sa * len);
        ctx.lineTo(fx - sa * wd, fy + ca * wd);
        ctx.lineTo(fx + sa * wd, fy - ca * wd);
        ctx.closePath();
        ctx.fill();
      }

      // ⑤ 三点上飘的魂火：击杀是"往上走"的动作，光有横向冲击环会显得像砸地。
      ctx.fillStyle = 'rgba(255,243,176,' + (t * 0.85).toFixed(3) + ')';
      for (let i = 0; i < 3; i++) {
        const a = phase + i * TAU / 3 + 0.4;
        const d = r * (0.5 + 2.2 * k);
        dot(ctx, e.x + Math.cos(a) * d, e.y + Math.sin(a) * d - r * k,
          Math.max(1.5, r * 0.12 * t), 'rgba(255,243,176,' + (t * 0.85).toFixed(3) + ')');
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = prevOp;
    }

    function drawEffects(w, alpha) {
      const list = w.effects;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const t = Math.max(0, e.life) / Math.max(0.001, e.maxLife);   // 1 -> 0

        // ★第七十九轮：击杀爆发先画。它是纯几何层，即使 pixelfx 没就绪或本帧
        //   像素预算被大招吃满，这层反馈也一定在——击杀是核心循环，不能降级成没反馈。
        if (e.kind === 'death') drawKillBurst(e, t);

        // ★技能特效：挥砍 / 爆发 / 光环 / 命中先交给 pixelfx 画；
        // draw 返回 false 说明库没就绪或本帧像素预算用尽，下面的原绘制照常兜底。
        const skillFx = window.VS.PixelFx;
        if (skillFx && skillFx.ready) {
          const pick = skillFx.effectFor(e);
          if (pick && skillFx.draw(ctx, pick.name, pick.key, pick.o)) continue;
        }

        if (e.kind === 'arc') {
          // 铁鞭扇形（普通 #e8dcc0 奶油白 / 进化 #ff4d4d 血红，见 shared/sim.js）
          // 【观感修正】原来直接铺一层半透明纯色扇形，奶油色压到暗红地面上会变成一块死板的灰饼，
          // 看着像"贴上去的图形"。改成「径向渐变 + 加法混合 + 前缘亮弧」：
          // 轴心基本透明、越靠刀锋越亮越白、外缘柔收，再叠一道亮弧做出挥砍方向感。
          if (!visible(e.x, e.y, e.r)) continue;
          const half = (e.arcDeg * Math.PI / 180) / 2;
          const a0 = e.facing - half;
          const a1 = e.facing + half;
          const full = e.arcDeg >= 360;      // 进化后是整圈，没有"前缘"可言

          ctx.globalAlpha = t;
          // 关键：加法混合。奶油白直接 alpha 叠在暗红地面上会被"压灰"（算出来是中灰），
          // 换成 lighter 之后它是往上加亮度的，才显出刀光的暖白感。
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          const grad = ctx.createRadialGradient(e.x, e.y, e.r * 0.16, e.x, e.y, e.r);
          // 关键点：刀锋附近必须"接近白"。同样的奶油色平铺出来是中灰，
          // 越靠外越提亮到白钢色，对比一拉开才像刀光。
          grad.addColorStop(0, rgbaOf(e.color, 0.04));                    // 轴心几乎透明，别糊住玩家
          grad.addColorStop(0.5, rgbaOf(e.color, 0.22));
          grad.addColorStop(0.82, mixRgba(e.color, '#ffffff', 0.5, 0.6));
          grad.addColorStop(0.95, mixRgba(e.color, '#ffffff', 0.72, 0.9));  // 刀锋最亮
          grad.addColorStop(1, mixRgba(e.color, '#ffffff', 0.7, 0.05));     // 外缘柔和收掉，不留硬边
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(e.x, e.y);
          ctx.arc(e.x, e.y, e.r, a0, a1);
          ctx.closePath();
          ctx.fill();

          // 前缘亮弧：单边强化的白金色弧线，是"挥过去"的方向提示。
          // 画两遍（宽而淡 + 细而亮）伪造一层辉光，比单线更有力度。
          ctx.globalAlpha = t * 0.45;
          ctx.strokeStyle = mixRgba(e.color, '#ffffff', 0.75, 1);
          ctx.lineWidth = Math.max(5, e.r * 0.14);
          ctx.beginPath();
          if (full) {
            ctx.arc(e.x, e.y, e.r * 0.92, 0, TAU);
          } else {
            // 两端各缩进一点，弧线不会顶到扇形的直边上，收口更干净
            ctx.arc(e.x, e.y, e.r * 0.92, a0 + half * 0.3, a1 - half * 0.3);
          }
          ctx.stroke();

          ctx.globalAlpha = t * 0.95;
          ctx.lineWidth = Math.max(2, e.r * 0.05);
          ctx.stroke();
          ctx.globalCompositeOperation = prevOp;
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'ring') {
          if (!visible(e.x, e.y, e.r)) continue;
          ctx.globalAlpha = t * 0.8;
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (1.15 - 0.15 * t), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'leyring') {
          // 地脉冲击的**作用边界**（第四十二轮）。库里的符文阵只能铺到百来像素，
          // 而这一下真的会打到 300 —— 边界画不出来，玩家就没法理解
          // 「为什么站在边上没被扫到、往里半步就挨了」。
          // ★这个 kind 在 pixelfx 里没有对应特效，所以一定落到这一支（不会被库吃掉）。
          if (!visible(e.x, e.y, e.r)) continue;
          const k = 1 - t;                       // 0 → 1：环从内往外推开
          // ★亮度刻意比 e.color 更亮（#a8ffdd）：0.9 的 alpha 叠在暗红地面上，
          //   直接用 #5fe0b0 会被压成一条灰绿细线，「边界」就看不出来了。
          ctx.globalAlpha = t * 0.95;
          ctx.strokeStyle = '#a8ffdd';
          ctx.lineWidth = 3 + 6 * t;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.35 + 0.65 * k), 0, TAU);
          ctx.stroke();
          // 内圈再补一道细的：两道环一起走，扩散感比单环明显得多
          ctx.globalAlpha = t * 0.45;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.2 + 0.8 * k), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'healring') {
          // 回春巫施法（第五十五轮）：一圈冷灰青从外向内**收缩**——
          //   与地脉灵泉的「外扩冲击」方向相反，语义是「把散出去的血收回来」。
          // ★这个 kind 在 pixelfx 里没有对应特效，一定落到这一支（不会被库吃掉）。
          if (!visible(e.x, e.y, e.r)) continue;
          const k = 1 - t;                       // 0 → 1：环从外往里收
          ctx.globalAlpha = t * 0.85;
          ctx.strokeStyle = e.color || '#a8b6c4';
          ctx.lineWidth = 2 + 5 * t;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (1 - 0.55 * k), 0, TAU);
          ctx.stroke();
          // 内圈再补一道细环，收拢感更明显（单环在暗红地面上太单薄）
          ctx.globalAlpha = t * 0.4;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.7 - 0.5 * k), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'feathers') {
          // 精卫折翼（第五十一轮）。
          // 【为什么必须自绘】借 `boom` 会被 pixelfx 画成「天降金色雷击」——
          //   那是"打赢了"的形状，而这里要的是"她没了"（语义正好相反）。
          //   与 boonshatter / devour 是同一条判断：看不清的反馈不如不给。
          // 【为什么不做成"一大团"】散开的三片羽毛比一团白光更能表达"掉下来"：
          //   一团光会读成特效，三片会读成"有东西碎了"。
          if (!visible(e.x, e.y, e.r + 12)) continue;
          const kf = 1 - t;                       // 0 → 1：从生到灭
          // 羽毛：叶形 + 中脉，一边打着转一边往下飘（kf² 让它越落越快）
          // ★尺寸放大到 4.6×11（第一版 2.6×6.5 在 1 倍画面里只有 7px，像三粒灰）。
          //   它是"她没了"的唯一解释，必须够读。
          const fy = e.y - 5 * kf + 10 * kf * kf;
          const fs = 1 - 0.35 * kf;
          ctx.save();
          ctx.translate(e.x, fy);
          ctx.rotate(kf * 1.1);
          ctx.globalAlpha = t * 0.95;
          ctx.fillStyle = mixRgba(e.color || '#eaf2f8', '#ffffff', 0.35, 1);
          ctx.beginPath();
          ctx.ellipse(0, 0, 4.6 * fs, 11 * fs, 0, 0, TAU);
          ctx.fill();
          ctx.strokeStyle = 'rgba(30,24,20,0.55)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(0, -10 * fs);
          ctx.lineTo(0, 10 * fs);
          ctx.stroke();
          ctx.restore();
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'boonshatter') {
          // 歧路双碑：另一座当场碎裂（第四十八轮）。
          // 【为什么必须自绘】借 `boom` 会被 pixelfx 画成「雷部神锤的金色雷击」——
          //   那是"从天上打下来"的语义，而这里要的是"石头自己碎了"
          //   （引魂灯那轮在 boom / ring 上各撞了一堵墙）。
          // 【为什么要有这一下】它是这一整轮唯一的**代价**：没有碎裂的表现，
          //   「另一座自己跑掉了」和「另一座被系统吃掉了」在画面上分不出来，
          //   玩家下次就会以为这是个"走过去拿两份"的点位。
          // ★颜色取碎掉那一座自己的色，但统一往灰白压 —— 碎裂是"失去"，不是"奖励"。
          if (!visible(e.x, e.y, e.r)) continue;
          const ks = 1 - t;                          // 0 → 1：从碑心往外散
          // ① 贴地的半环：石头碎开时扬起来的尘
          ctx.globalAlpha = t * 0.8;
          ctx.strokeStyle = mixRgba(e.color, '#cfc7b8', 0.55, 1);
          ctx.lineWidth = 2 + 3 * t;
          ctx.beginPath();
          ctx.arc(e.x, e.y - 10, e.r * (0.25 + 0.9 * ks), 0.12 * Math.PI, 0.88 * Math.PI);
          ctx.stroke();
          // ② 四块碎片往外飞并翻倒（方向按角度等分，**不取随机数**：渲染层也不该抽签，
          //    否则联机时同一个特效在两个人屏幕上长得不一样）
          ctx.globalAlpha = t * 0.85;
          ctx.fillStyle = mixRgba(e.color, '#d8d2c4', 0.5, 1);
          for (let s = 0; s < 4; s++) {
            const a2 = (s / 4) * TAU + 0.5;
            const dr = e.r * (0.35 + 1.0 * ks);
            const sx = e.x + Math.cos(a2) * dr;
            const sy = e.y - 10 + Math.sin(a2) * dr * 0.5 - 8 * ks;
            const sz = 4 * (1 - 0.55 * ks);
            ctx.save();
            ctx.translate(sx, sy);
            ctx.rotate(a2 + ks * 1.4);
            ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
            ctx.restore();
          }
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'devour') {
          // 饕餮吞下一份精魄（第四十七轮）：一圈**向内收**的光。
          // 【为什么不借 lanterncore / ring】它们是「往外炸」的语义（灯火炸开 / 作用边界），
          //   而这里要的是「被吸进去」—— 方向反过来，玩家才能一眼读出因果
          //   （是那只怪在吃我的球，不是地上又炸了什么）。
          // ★这个 kind 在 pixelfx 里没有对应名字，effectFor 返回 null，所以一定落到这一支。
          if (!visible(e.x, e.y, e.r)) continue;
          const kd = 1 - t;                        // 0 → 1：半径从满收到很小
          ctx.globalAlpha = t * 0.9;
          // ★比 e.color（#55663c 墨绿）亮一档：暗绿叠在暗红地面上会被压成一条灰线，
          //   「在吸」这件事就看不出来了。
          ctx.strokeStyle = '#d8e08a';
          ctx.lineWidth = 2 + 3 * t;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (1 - 0.75 * kd), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = t * 0.5;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.75 - 0.55 * kd), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'lanterncore') {
          // 引魂灯的暖光爆闪（第四十六轮）。
          // 【为什么要自己画，不借 boom / ring】两者都试过，都被真浏览器截图推翻：
          //   · 琥珀金的 `boom` 在 pixelfx 里是「雷部神锤的金色雷击」→ 一道天降雷柱；
          //   · `ring` 是库里的贴地符文阵，r=240 换算成 scale 2.67 → 一圈巨大的
          //     **白色线框**铺满半个屏幕，战场直接看不见。
          //   自己画的好处是颜色、尺寸、衰减全在手里，也不会被库的调色板改写。
          // ★尺寸只到判定半径的 0.62：它是"灯火炸开"，不是"把 240 填满"——
          //   240 这件事由 lanternring 那条边界说清楚。
          if (!visible(e.x, e.y, e.r)) continue;
          const k = 1 - t;                        // 0 → 1：从中心往外推
          const rr = e.r * (0.28 + 0.34 * k);      // 0.28r → 0.62r
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';
          const g = ctx.createRadialGradient(e.x, e.y, rr * 0.05, e.x, e.y, rr);
          // 暖白核心 → 琥珀 → 透明：三级就够，级数多了会糊成一团
          g.addColorStop(0, 'rgba(255,251,232,' + (0.85 * t).toFixed(3) + ')');
          g.addColorStop(0.42, 'rgba(255,207,92,' + (0.55 * t).toFixed(3) + ')');
          g.addColorStop(1, 'rgba(255,180,60,0)');
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(e.x, e.y, rr, 0, TAU);
          ctx.fill();
          ctx.globalCompositeOperation = prevOp;
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'lanternring') {
          // 引魂灯「三盏齐了」那一下的**作用边界**（第四十六轮）。
          // 【为什么必须单独画一个 kind】与地脉灵泉同一条理由：pixelfx 库里
          //   贴地符文阵的缩放上限换算下来只铺到百来像素，而这一下真的打到 240 ——
          //   边界画不出来，玩家就不会理解「为什么站在 241px 处没被扫到」。
          // ★pixelfx 里没有这个 kind，effectFor 返回 null，所以一定落到这一支。
          if (!visible(e.x, e.y, e.r)) continue;
          const k = 1 - t;                       // 0 → 1：环从内往外推开
          ctx.globalAlpha = t * 0.9;
          // ★比 e.color 更亮（#fff0bb）：0.9 的 alpha 叠在暗红地面上，
          //   直接用 #ffcf5c 会被压成一条土黄细线，「边界」就看不出来了。
          ctx.strokeStyle = '#fff0bb';
          ctx.lineWidth = 3 + 5 * t;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.4 + 0.6 * k), 0, TAU);
          ctx.stroke();
          // 内圈一道细环跟着走：两道一起推，扩散感比单环明显得多（同 leyring）
          ctx.globalAlpha = t * 0.4;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(e.x, e.y, e.r * (0.25 + 0.75 * k), 0, TAU);
          ctx.stroke();
          ctx.globalAlpha = 1;
          continue;
        }

        if (e.kind === 'boom') {
          // 【观感修正】原来是两层纯色圆盘硬叠，边缘是刀切一样的圆，
          // 远看就是"地上放了个橙色的圈"。改成两段径向渐变：
          // 外层余烬从本体色淡出到全透明（自然消散），内层白热核心 -> 本体色，
          // 爆炸才有"热"的感觉。
          if (!visible(e.x, e.y, e.r)) continue;
          const rOut = e.r * (1.18 - 0.32 * (1 - t));
          const rIn = e.r * (0.95 - 0.35 * (1 - t));
          ctx.globalAlpha = t;
          // 同样走加法混合：火焰/爆炸本质是发光体，lighter 叠出来的才有热感
          const prevOp = ctx.globalCompositeOperation;
          ctx.globalCompositeOperation = 'lighter';

          // ★第四十二轮：地脉冲击走**玉青**这一支（与陨星的火橙分开）。
          //   【为什么必须分支而不是只换 e.color】这段原来是彻底写死的火色
          //   （rgba(255,120,40) + 白热核心），传进来的 e.color 只用在别处 ——
          //   灵泉直接用 boom 的话，画面上是一团**火**砸在地上，
          //   而语义是「地脉灵气涌出来」，两者完全相反（与天火那一轮「圣水被画成水洼」同款坑）。
          //   色值 #5fe0b0 是跨层契约，写在 const.js 的 LEYLINE.color 里。
          const jade = e.color === '#5fe0b0';
          const outer = jade ? 'rgba(95,224,176,0.42)' : 'rgba(255,120,40,0.42)';
          const outerMid = jade ? 'rgba(95,224,176,0.20)' : 'rgba(255,120,40,0.22)';
          const outerEnd = jade ? 'rgba(95,224,176,0)' : 'rgba(255,120,40,0)';

          const gOut = ctx.createRadialGradient(e.x, e.y, rIn * 0.7, e.x, e.y, rOut);
          gOut.addColorStop(0, outer);
          gOut.addColorStop(0.55, outerMid);
          gOut.addColorStop(1, outerEnd);
          ctx.fillStyle = gOut;
          ctx.beginPath();
          ctx.arc(e.x, e.y, rOut, 0, TAU);
          ctx.fill();

          const gIn = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rIn);
          gIn.addColorStop(0, jade ? 'rgba(226,255,246,0.95)' : 'rgba(255,244,214,0.95)');   // 白热核心
          gIn.addColorStop(0.45, jade ? 'rgba(95,224,176,0.80)' : rgbaOf(COLOR.boom, 0.85));
          gIn.addColorStop(1, jade ? 'rgba(95,224,176,0.10)' : rgbaOf(COLOR.boom, 0.1));    // 外沿化开
          ctx.fillStyle = gIn;
          ctx.beginPath();
          ctx.arc(e.x, e.y, rIn, 0, TAU);
          ctx.fill();

          // 地脉冲击额外加一道「边界环」：r=300 这一下必须让玩家看见自己站到了多远，
          // 只有一团中心光晕的话，「冲击半径 300」这件事在画面上没有边界。
          if (jade) {
            ctx.globalAlpha = t * 0.85;
            ctx.strokeStyle = '#b7ffe4';
            ctx.lineWidth = 2 + 3 * t;
            ctx.beginPath();
            ctx.arc(e.x, e.y, e.r * (0.55 + 0.45 * (1 - t)), 0, TAU);
            ctx.stroke();
          }

          ctx.globalCompositeOperation = prevOp;
          ctx.globalAlpha = 1;
          continue;
        }

        // death / hitplayer：小圆淡出
        if (!visible(e.x, e.y, e.r)) continue;
        ctx.globalAlpha = t * 0.7;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r * (0.6 + 0.6 * (1 - t)), 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // ============================================================
    // 队友（联机模式里的其他玩家）
    // ============================================================
    // 背景：联机时 world.players 里装着**全部玩家**（服务端不裁剪玩家列表，
    // 因为队友永远要可见），但渲染层一直只画了 w.player —— 也就是自己。
    // 于是出现「能看见队友的技能、看不见队友本人」：技能走 events/fx 通道，
    // 和角色本体是两套数据，所以特效照常显示。这里把缺的那一半补上。
    //
    // 单机零影响：单机的 world.players 只有自己一个，下面的 drawTeammates
    // 遍历时全部命中「跳过自己」，等于一次长度判断就返回。
    //
    // 外观策略：所有玩家的 r 都是 C.PLAYER.radius（sim.makePlayer 里写死），
    // 所以直接复用自己那张精灵（ensurePlayerArt 按半径缓存，命中缓存不重建、
    // 不额外占显存）。「谁是谁」靠脚下按 slot 的彩环 + 头顶名牌区分。
    // 配色沿用项目基调（暗红 / 琥珀金 / 冷灰），刻意避开紫色系。
    const TEAM_RING = ['#f2c14e', '#8fa3b8', '#c93a3a', '#e8dcc0'];

    // ---------- 血怒（第三十八轮）的两种表现 ----------
    // ① 攒连杀：脚下一段**琥珀金弧**，进度 = 连杀数 / 门槛（不画满就说明还差几口）。
    // ② 血怒中：脚下一层暗红地面光晕 + 两道脉动血环（内实外虚）。
    //
    // ★为什么用「脚下光环」而不是顶栏进度条：窄屏 390 的顶栏已经没有余量
    //   （hudalign 钉着 20 条布局断言），为一条临时状态去改顶栏是拿布局换功能。
    //   而光环正好长在玩家一直盯着的地方 —— 自己脚下。
    // ★为什么攒气的弧用琥珀金而不是红：低血量脉冲环已经是红的了（r+7 起），
    //   两者都红的话「血怒中」和「快死了」在混战里分不出来，那是会害死人的歧义。
    // ★队友也画（见 drawTeammate）：他们真的在爆发，伤害数字上也看得出来。
    // ★★局部变量千万别叫 R：本文件的模块对象就叫 R，而下面脉动要读 R._animT
    //   （动画时钟）。第一版写成 `const R = C.RAGE` 把模块对象遮住了 → R._animT 是
    //   undefined → 半径与颜色全变 NaN → **Canvas 对非法圆弧半径是静默忽略的**，
    //   一句错误都不报，画面就是"什么都没画"。这条只能靠放大截图看出来（已踩）。
    function drawRageMark(p, x, y) {
      if (!p || !p.alive) return;
      const RG = C.RAGE;
      const need = (RG && RG.needKills) || 12;

      if ((p.rage || 0) > 0) {
        // 地面光晕：先画，压在本体下面，看起来才像「从脚下烧起来」
        const g = ctx.createRadialGradient(x, y, p.r * 0.4, x, y, p.r * 2.2);
        g.addColorStop(0, 'rgba(201,58,58,0.30)');
        g.addColorStop(1, 'rgba(201,58,58,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, p.r * 2.2, 0, TAU);
        ctx.fill();

        const pulse = 0.5 + 0.5 * Math.sin(R._animT * 9);
        // ★半径必须离「低血量的贴身红环」（p.r+7 ~ p.r+10）足够远：
        //   两者都是红的，半径又近的话，「血怒中」和「快死了」在混战里就是同一个画面。
        //   现在：贴身的细红环 = 快死了；中圈粗红环 + 外圈金环 = 血怒中。两者同时出现也对。
        ctx.strokeStyle = 'rgba(201,58,58,' + (0.45 + 0.35 * pulse).toFixed(3) + ')';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(x, y, p.r + 15 + pulse * 3, 0, TAU);
        ctx.stroke();
        // 外圈琥珀金、反向呼吸：金色是项目的「奖励」色，正好对上「这 8 秒是赚到的」
        ctx.strokeStyle = 'rgba(242,193,78,' + (0.18 + 0.20 * (1 - pulse)).toFixed(3) + ')';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, p.r + 25 + pulse * 4, 0, TAU);
        ctx.stroke();
        return;
      }

      const streak = p.rageStreak || 0;
      if (streak <= 0) return;
      const k = Math.max(0, Math.min(1, streak / need));
      // 底圈：让玩家知道「这里会有一段弧」，否则单看一小段弧像 UI 画歪了
      ctx.strokeStyle = 'rgba(242,193,78,0.14)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, p.r + 18, 0, TAU);
      ctx.stroke();
      // 进度弧：从正上方顺时针
      ctx.strokeStyle = 'rgba(242,193,78,0.75)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, p.r + 18, -Math.PI / 2, -Math.PI / 2 + TAU * k);
      ctx.stroke();
    }

    function drawTeammate(p, alpha) {
      const x = lerp(p.px, p.x, alpha);
      const y = lerp(p.py, p.y, alpha);
      // 服务端发的玩家列表不裁剪，视野外的要自己跳过（不然跑到地图另一头也在白白绘制）
      if (!visible(x, y, p.r + 60)) return;

      // 队友用**他自己角色**的精灵 —— 这是多人局里分辨彼此的主要手段
      // （名牌会被怪、特效、伤害数字挡住，轮廓不会）。
      const sprite = ensurePlayerArt(p.r, p.charId);
      if (!sprite) return;

      const ring = TEAM_RING[(p.slot || 0) % TEAM_RING.length];
      const dead = !p.alive;

      ctx.globalAlpha = dead ? 0.35 : 1;

      // 脚下彩环：分辨「这是队友、那是自己」最省事的做法
      ctx.strokeStyle = ring;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(x, y + p.r * 0.9, p.r * 1.25, p.r * 0.5, 0, 0, TAU);
      ctx.stroke();

      // 血怒光环 / 连杀进度弧（第三十八轮）。队友身上也要有 ——
      // 不然「他在爆发、我这边看不出来」，配合起来会莫名其妙。
      if (!dead) drawRageMark(p, x, y);

      // 本体（死亡的不画受击闪白，直接压暗）
      // ★队友各用一条动画时钟（按 slot 分键），不会四个人整齐地一起迈步；
      //   移动判定读快照里本来就有 px/py，不加任何协议字段。
      const AM = window.VS.ActorMotion;
      const moved = Math.abs(p.x - (p.px || p.x)) + Math.abs(p.y - (p.py || p.y)) > 0.02;
      const pose = AM ? AM.poseOf('p' + (p.slot || 0), moved) : 0;
      const frame = (sprite.frames && sprite.frames[pose]) || sprite;
      ctx.drawImage(frame.cv, Math.round(x - frame.hw), Math.round(y - frame.hh), frame.hw * 2, frame.hh * 2);

      // 朝向：比自己的箭头短一截、用队友色，避免和自己的朝向指示混淆
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.facing || 0);
      ctx.fillStyle = ring;
      ctx.beginPath();
      ctx.moveTo(p.r + 12, 0);
      ctx.lineTo(p.r + 4, -5);
      ctx.lineTo(p.r + 4, 5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.globalAlpha = 1;

      // 头顶名牌 + 血条。
      // 名字来源：快照里刻意不带昵称（省带宽），由 game.js 的 applySnap 从开局
      // 名单按 slot 补到 p.name 上，所以这里读 p.name 是有值的。
      const label = p.name || ('队友 ' + ((p.slot || 0) + 1));
      const barW = 46;
      const barH = 5;
      const barY = y - p.r - 22;

      ctx.save();
      ctx.font = '12px system-ui, "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';

      // 名牌 = 头像 + 名字，整块居中。
      // 为什么值得画个头像：名字可能很长、也可能撞名，图形比文字好认得多 ——
      // 「哪个是自己队友」在乱战里是要靠一眼扫出来的。
      const AV = window.VS && window.VS.AVATARS;
      const AV_SIZE = 14;
      const hasAvatar = !!(AV && p.avatar);
      const textW = ctx.measureText(label).width;
      const blockW = (hasAvatar ? AV_SIZE + 4 : 0) + textW;
      const blockLeft = x - blockW / 2;
      const midY = barY - 10;

      if (hasAvatar) AV.paint(ctx, p.avatar, blockLeft + AV_SIZE / 2, midY, AV_SIZE);

      // 先描一圈黑边再填字：地面明暗不定，没有描边的话浅色地块上会看不出来
      ctx.textAlign = 'left';
      const textX = blockLeft + (hasAvatar ? AV_SIZE + 4 : 0);
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(label, textX, midY);
      ctx.fillStyle = dead ? '#8b9099' : '#f4f1e8';
      ctx.fillText(label, textX, midY);

      if (!dead) {
        const ratio = p.maxHp > 0 ? Math.max(0, Math.min(1, p.hp / p.maxHp)) : 0;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(x - barW / 2 - 1, barY - 1, barW + 2, barH + 2);
        // 残血转亮红，和低血量脉冲环一个语义
        ctx.fillStyle = ratio < 0.3 ? '#ff6b6b' : '#c93a3a';
        ctx.fillRect(x - barW / 2, barY, barW * ratio, barH);
      }
      ctx.restore();

      R.stat.drawn += 1;
      R.stat.teammates += 1;
    }

    function drawTeammates(w, alpha) {
      const list = w.players;
      if (!list || list.length < 2) return;   // 只有自己：没什么可画的
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        if (p === w.self) continue;           // 自己交给 drawPlayer
        drawTeammate(p, alpha);
      }
    }

    function drawPlayer(w, alpha) {
      const p = w.player;
      const x = lerp(p.px, p.x, alpha);
      const y = lerp(p.py, p.y, alpha);
      // 自己那张精灵也按自己的角色取 —— 单机时它就是选区界面里选的那个形象，
      // 多人时四个人各不相同
      const s = ensurePlayerArt(p.r, p.charId);
      const lowHp = p.maxHp > 0 && p.hp / p.maxHp < 0.3;

      // 拾取范围提示（很淡的琥珀金，让玩家知道磁石起作用了；原来用的偏蓝色已改掉）
      ctx.strokeStyle = 'rgba(242,193,78,0.09)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, p.attrs.pickupRadius, 0, TAU);
      ctx.stroke();

      // 低血量：脉冲红环，比只看血条更快反应过来
      if (lowHp && p.alive) {
        const pulse = 0.5 + 0.5 * Math.sin(R._animT * 7);
        ctx.strokeStyle = 'rgba(201,58,58,' + (0.25 + 0.4 * pulse) + ')';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(x, y, p.r + 7 + pulse * 3, 0, TAU);
        ctx.stroke();
      }

      // 血怒光环 / 连杀进度弧（第三十八轮）。画在本体之前 —— 它是地面层的东西，
      // 压在身上就会挡住角色轮廓（layertest 钉过「角色不许被特效盖住」）。
      if (p.alive) drawRageMark(p, x, y);

      // 受击无敌时闪烁，给玩家反馈
      const blink = p.invuln > 0 && Math.floor(R._animT * 20) % 2 === 0;
      ctx.globalAlpha = blink ? 0.5 : 1;

      // 走路上下轻浮：用「上一帧位置有没有变」判断在不在移动，
      // 比读输入状态可靠（键盘 / 摇杆 / 脚本注入都能覆盖），也仍然是纯表现。
      const moved = R._lastPx !== undefined &&
        (Math.abs(p.x - R._lastPx) + Math.abs(p.y - R._lastPy)) > 0.02;
      const bob = moved ? Math.sin(R._animT * 11) * 1.6 : 0;
      // ★按动作状态机选帧：站着呼吸 / 迈步 / 挥砍，都是预烘焙好的整张画布。
      //   受击时改用**同一帧**的闪白版，姿态不会被强行拉回站姿。
      const AM = window.VS.ActorMotion;
      const pose = AM ? AM.poseOf('self', moved) : 0;
      const frame = (s.frames && s.frames[pose]) || s;
      const hurt = p.invuln > 0 && p.invuln > 0.6;
      const cv = hurt ? (frame.flash || (s.flash && s.flash.cv) || frame.cv) : frame.cv;
      ctx.drawImage(cv, Math.round(x - frame.hw), Math.round(y - frame.hh + bob), frame.hw * 2, frame.hh * 2);

      // 面向指示：琥珀金箭头 + 一段淡金射线，朝哪打一目了然
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(p.facing);
      ctx.fillStyle = COLOR.playerFacing;
      ctx.beginPath();
      ctx.moveTo(p.r + 15, 0);
      ctx.lineTo(p.r + 5, -6);
      ctx.lineTo(p.r + 5, 6);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(242,193,78,0.28)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.r + 4, 0);
      ctx.lineTo(p.r + 30, 0);
      ctx.stroke();
      ctx.restore();

      ctx.globalAlpha = 1;

      // 死亡就画个墓碑，直观
      if (!p.alive) {
        ctx.fillStyle = 'rgba(0,0,0,0.4)';
        ctx.beginPath();
        ctx.ellipse(x, y + 10, 20, 6, 0, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#4a4f58';
        ctx.fillRect(x - 14, y - 26, 28, 34);
        ctx.fillStyle = '#5c626c';
        ctx.fillRect(x - 14, y - 26, 28, 5);
        ctx.fillStyle = '#2b2f36';
        ctx.fillRect(x - 8, y - 18, 16, 4);
        ctx.fillRect(x - 2, y - 24, 4, 16);
      }
    }

    // 升级时在玩家脚下爆一圈金环，视觉上把「变强了」说清楚
    function drawLevelPulse(w, alpha) {
      const p = w.player;
      const t = R._levelPulse;
      if (t <= 0) return;
      const x = lerp(p.px, p.x, alpha);
      const y = lerp(p.py, p.y, alpha);
      const k = 1 - t;                        // 0 -> 1
      ctx.globalAlpha = t * 0.85;
      ctx.strokeStyle = '#f4c455';
      ctx.lineWidth = 3.5 * t + 1;
      ctx.beginPath();
      ctx.arc(x, y, 22 + k * 78, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = t * 0.35;
      ctx.beginPath();
      ctx.arc(x, y, 10 + k * 52, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // ============================================================
    // 摇杆（屏幕空间，最后画）
    // ============================================================

    function drawJoystick(input) {
      if (!input || !input.joy.active) return;

      const j = input.joy;
      ctx.strokeStyle = 'rgba(242,193,78,0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(j.ox, j.oy, 60, 0, TAU);
      ctx.stroke();

      ctx.fillStyle = 'rgba(242,193,78,0.55)';
      ctx.beginPath();
      ctx.arc(j.cx, j.cy, 24, 0, TAU);
      ctx.fill();
    }

    // ============================================================
    // 主绘制
    // ============================================================

    // alpha: 0~1，逻辑帧之间的插值系数
    R.draw = function (w, alpha, input) {
      const t0 = performance.now();
      R.alpha = alpha;

      // 渲染层自己的动画时钟（跟 sim 解耦，暂停时纯表现的东西照样动）
      if (R._animLast) {
        let dt = (t0 - R._animLast) / 1000;
        if (dt > 0.25) dt = 0.25;            // 切标签页回来别一下跳过去
        R._animT += dt;
        R._animDt = dt;
        // 浮字用真实时间推进
        updateDamage(dt);
        if (R._levelPulse > 0) R._levelPulse -= dt * 1.1;
      } else {
        R._animDt = 0;
      }
      R._animLast = t0;

      // 技能特效层每帧开头刷新一次时间步与绘制预算（库没加载时是空实现）
      if (window.VS.PixelFx) window.VS.PixelFx.begin(R._animDt);
      // 场景物件层：按当前地图准备物件实例，并推进物件自己的动画时钟。
      // ★物件是纯表现，不参与碰撞、不进快照；库没加载时这里全是空实现。
      const PR = window.VS.PropLayer;
      if (PR) {
        PR.ensure(curMap().id);
        PR.begin(R._animDt, R);
      }

      // 角色动作：推进表现层动画时钟，并用「新的挥砍特效」当起手信号。
      // ★自动开火的游戏没有攻击键；只认以自己为圆心的那道弧，
      //   队友在远处挥砍不会让自己跟着摆姿势。read 的都是快照里已有的字段。
      const AM = window.VS.ActorMotion;
      if (AM) {
        AM.begin(R._animDt);
        // ★挥砍检测降到每 3 帧一次：逻辑 20Hz、一次挥砍活 0.18 秒，
        //   仍能采到 2~3 次，不必每帧遍历 effects（联机快照每帧重建这个数组）。
        if (R._frame % 3 === 0) {
          const own = w.player;
          const fxList = w.effects || [];
          let arcKey = '';
          let arcBlood = false;
          for (let i = 0; i < fxList.length; i++) {
            const e = fxList[i];
            if (e.kind !== 'arc') continue;
            if (Math.abs(e.x - own.x) > 30 || Math.abs(e.y - own.y) > 30) continue;
            arcKey = Math.round(e.x / 8) + '|' + Math.round(e.y / 8) + '|' + Math.round((e.maxLife || 0) * 100);
            arcBlood = e.color === '#ff4d4d';
            break;
          }
          // 一次挥砍只触发一次：effects 每帧会被联机快照重建，不能靠对象引用去重
          if (arcKey && arcKey !== R._arcSeen) {
            R._arcSeen = arcKey;
            AM.punch('self', arcBlood ? 'cleave' : 'slash');
            // 与 act 起手同帧发声：比按 hud 差分晚一帧更跟手
            if (window.VS.Sfx) window.VS.Sfx.punch(arcBlood ? 'cleave' : 'slash');
          }
        }
      }

      const p = w.player;
      const sx = lerp(p.px, p.x, alpha);
      const sy = lerp(p.py, p.y, alpha);
      updateCamera(sx, sy);
      computeBounds();

      R.stat.drawn = 0;
      R.stat.total = 0;
      R.stat.teammates = 0;
      R.stat.killBursts = 0;
      R._frame += 1;

      // 换了世界（重开一局）就重建地面纹理
      if (R._world !== w) {
        R.buildGround(w);
      }
      ensureArt();
      if (!R._dmgMap) R._dmgMap = new Map();
      // 升级那一下：等级涨了就放一圈金环
      if (R._lastLevel !== undefined && w.player.level > R._lastLevel) R._levelPulse = 1;
      R._lastLevel = w.player.level;
      // 记下本帧位置，下一帧据此判断玩家在不在移动（走路轻浮用）
      R._lastPx = p.x;
      R._lastPy = p.y;

      drawGround();

      ctx.save();
      ctx.translate(-R.cam.x, -R.cam.y);
      // 命中瞬间的镜头微抖：只作用在世界层；屏幕空间 HUD 在 restore 之后画，不受影响
      if (AM) {
        const sh = AM.shake();
        if (sh[0] || sh[1]) ctx.translate(sh[0], sh[1]);
      }

      // 绘制顺序（第二十九轮调整过）：
      //   贴地物件 -> 障碍 -> 立牌物件 -> 裂隙 -> 地面区域 -> 掉落 -> 落点 ->
      //   技能特效 -> 怪 -> 敌弹 -> 技能弹幕 -> 环绕物 -> 队友 -> 玩家 -> 飘字
      // ★障碍在最底：怪撞不过它，画在怪之上就成了「怪躲在墙后」（假的）
      // ★★角色（自己与队友）必须在**所有技能表现之上**：
      //   原来把「玩家弹幕 / 环绕物」画在玩家之后，回旋刃和能量盘从身上掠过时
      //   会把主角糊住 —— 玩家整局只盯一个人，那个人任何时候都不该被特效遮住。
      //   弹幕从角色身上出发时会被角色盖住一两帧，这是可接受的代价（割草游戏都这么做）。
      if (PR) PR.drawGround(ctx, w, R);
      drawObstacles(w);
      // 立牌物件（火盆/喷泉/瀑布…）画在障碍之上、怪之下：
      // 它们是「场景里的东西」，不该盖住怪和玩家
      if (PR) PR.draw(ctx, R);
      // 传送裂隙：坐标由 mapId 纯函数推出来（不占快照），画在物件之后、区域之前
      if (PR) PR.drawPortals(ctx, curMap().id, R);
      drawZones(w, alpha);
      drawPickups(w, alpha);
      drawStrikes(w, alpha);
      drawEffects(w, alpha);
      drawMobs(w, alpha);
      drawEnemyShots(w, alpha);
      // 技能弹幕与环绕物：也是「技能表现」，画在角色之下
      drawProjectiles(w, alpha);
      drawOrbits(w, alpha);
      // 队友与自己同一层级，队友先画（自己被压在最上面）
      drawTeammates(w, alpha);
      drawPlayer(w, alpha);
      // 升级金环是加法混合的发光，压在最上只是提亮，不构成遮挡
      drawLevelPulse(w, alpha);
      drawDamage();

      ctx.restore();

      // 屏幕空间覆盖层
      drawJoystick(input);

      // 自身耗时统计（20 帧滑动平均，够稳也不滞后）
      const cost = performance.now() - t0;
      R._drawMs = R._drawMs ? R._drawMs * 0.9 + cost * 0.1 : cost;
      R.stat.drawMs = Math.round(R._drawMs * 100) / 100;
    };

    // 每帧首调用，用于统计 FPS
    R.tickFps = function (now) {
      if (R._lastFrame) {
        const dt = now - R._lastFrame;
        if (dt > 0) {
          R._fpsAcc += 1000 / dt;
          R._fpsCount += 1;
          if (R._fpsCount >= 20) {
            R._fps = R._fpsAcc / R._fpsCount;
            R._fpsAcc = 0;
            R._fpsCount = 0;
          }
        }
      }
      R._lastFrame = now;
    };

    R.getFps = function () {
      return Math.round(R._fps);
    };

    return R;
  }

  root.VS = root.VS || {};
  root.VS.createRenderer = createRenderer;
})(window);
