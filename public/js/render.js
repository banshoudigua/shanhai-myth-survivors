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
    exp: '#dae4ec', exp_big: '#f2c14e', gold: '#f2c14e', heart: '#d94a4a', chest: '#8a6415'
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
      stat: { drawn: 0, total: 0, drawMs: 0, teammates: 0 },
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
      const pal = PX.paletteFor(def.color);

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
      const sp = makeSprite('player_' + id, size, size, function (g, cx, cy) {
        const PA = window.VS && window.VS.PLAYER_ART;
        // 兜底：PLAYER_ART 没加载成功时退回老画法，至少不裂图
        if (PA) PA.paint(g, id, cx, cy, rr);
        else paintPlayer(g, cx, cy, rr, COLOR.player);
      });

      const entry = {
        cv: sp.cv, hw: sp.hw, hh: sp.hh,
        // 受击闪白变体也按角色烘（共用一张的话，闪白会把角色特征抹平）
        flash: { cv: makeFlashVariant(sp.cv), hw: sp.hw, hh: sp.hh }
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
        // 剩余时间越少画得越淡，给玩家「快没了」的提示
        const fade = Math.min(1, z.life / Math.max(0.001, z.maxLife));
        const pulse = 1 + Math.sin(t * 4 + i * 1.7) * 0.035;

        ctx.globalAlpha = 0.42 + 0.5 * fade;
        ctx.fillStyle = evolved ? COLOR.zoneFillEvolved : COLOR.zoneFill;
        ctx.beginPath();
        ctx.arc(z.x, z.y, z.r * pulse, 0, TAU);
        ctx.fill();

        // 旋转虚线环：save/restore 把 setLineDash 一起还原，避免漏出去影响后续描边
        ctx.strokeStyle = evolved ? COLOR.zoneEdgeEvolved : COLOR.zoneEdge;
        ctx.lineWidth = 2;
        ctx.save();
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = -t * 22;
        ctx.beginPath();
        ctx.arc(z.x, z.y, z.r * pulse, 0, TAU);
        ctx.stroke();
        ctx.restore();

        // 内圈待机环：与外圈反相呼吸（一个涨一个缩），看起来像在「转」
        ctx.globalAlpha = 0.3 * fade;
        ctx.beginPath();
        ctx.arc(z.x, z.y, z.r * 0.6 * (2 - pulse), 0, TAU);
        ctx.stroke();

        // 中心亮斑
        ctx.globalAlpha = 0.5 * fade;
        ctx.fillStyle = evolved ? COLOR.zoneEdgeEvolved : COLOR.zoneEdge;
        ctx.beginPath();
        ctx.arc(z.x, z.y, Math.max(3, z.r * 0.14) * pulse, 0, TAU);
        ctx.fill();

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
      for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (!visible(it.x, it.y, 12)) continue;
        if (it.kind === 'exp') { if (it.big) nExpBig += 1; else nExp += 1; }
        else if (it.kind === 'chest') nChest += 1;
        else nOther += 1;
      }
      if (!nExp && !nExpBig && !nOther && !nChest) return;

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
          if (it.kind === 'exp') continue;
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

      // ---------- 第二遍：本体 ----------
      const dm = R._dmgMap;
      const frame = R._frame;
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
          ctx.drawImage(s.cv, Math.round(x - s.hw), Math.round(y - s.hh), s.hw * 2, s.hh * 2);
        } else {
          // 朝左的怪取镜像版（像素画不能随便转，见 buildMobArt 的说明）。
          // 绘制坐标取整：矩阵左上角只要落在半像素上，格边就会被插值成灰边，
          // 整批怪一起「发糊」—— 这是像素风最容易忽略、也最致命的一处。
          const left = pack.bodyL && (m.vx || 0) < 0;
          const s = flash ? (left ? pack.flashL : pack.flash) : (left ? pack.bodyL : pack.body);
          ctx.drawImage(s.cv, Math.round(x - s.hw), Math.round(y - s.hh), s.hw * 2, s.hh * 2);
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
          ctx.fillStyle = tier === 'boss' ? '#c93a3a' : (tier === 'commander' ? '#d9642f' : '#e08a3a');
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

        if (s.kind === 'parabola') {
          // 审判之锤：沿抛物线飞过去
          const t = progress;
          const x = lerp(s.sx, s.x, t);
          const y = lerp(s.sy, s.y, t);
          const arc = Math.sin(t * Math.PI) * 90;   // 抛物高度

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

    function drawEffects(w, alpha) {
      const list = w.effects;
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const t = Math.max(0, e.life) / Math.max(0.001, e.maxLife);   // 1 -> 0

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

          const gOut = ctx.createRadialGradient(e.x, e.y, rIn * 0.7, e.x, e.y, rOut);
          gOut.addColorStop(0, 'rgba(255,120,40,0.42)');
          gOut.addColorStop(0.55, 'rgba(255,120,40,0.22)');
          gOut.addColorStop(1, 'rgba(255,120,40,0)');
          ctx.fillStyle = gOut;
          ctx.beginPath();
          ctx.arc(e.x, e.y, rOut, 0, TAU);
          ctx.fill();

          const gIn = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, rIn);
          gIn.addColorStop(0, 'rgba(255,244,214,0.95)');   // 白热核心
          gIn.addColorStop(0.45, rgbaOf(COLOR.boom, 0.85));
          gIn.addColorStop(1, rgbaOf(COLOR.boom, 0.1));    // 外沿化开
          ctx.fillStyle = gIn;
          ctx.beginPath();
          ctx.arc(e.x, e.y, rIn, 0, TAU);
          ctx.fill();

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

      // 本体（死亡的不画受击闪白，直接压暗）
      ctx.drawImage(sprite.cv, Math.round(x - sprite.hw), Math.round(y - sprite.hh), sprite.hw * 2, sprite.hh * 2);

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

      // 受击无敌时闪烁，给玩家反馈
      const blink = p.invuln > 0 && Math.floor(R._animT * 20) % 2 === 0;
      ctx.globalAlpha = blink ? 0.5 : 1;

      // 走路上下轻浮：用「上一帧位置有没有变」判断在不在移动，
      // 比读输入状态可靠（键盘 / 摇杆 / 脚本注入都能覆盖），也仍然是纯表现。
      const moved = R._lastPx !== undefined &&
        (Math.abs(p.x - R._lastPx) + Math.abs(p.y - R._lastPy)) > 0.02;
      const bob = moved ? Math.sin(R._animT * 11) * 1.6 : 0;
      // 受击时用闪白变体（也是按角色烘的，不会把角色特征抹平）
      const hurt = p.invuln > 0 && p.invuln > 0.6;
      const sprite = hurt ? s.flash : s;
      ctx.drawImage(sprite.cv, Math.round(x - sprite.hw), Math.round(y - sprite.hh + bob), sprite.hw * 2, sprite.hh * 2);

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

      const p = w.player;
      const sx = lerp(p.px, p.x, alpha);
      const sy = lerp(p.py, p.y, alpha);
      updateCamera(sx, sy);
      computeBounds();

      R.stat.drawn = 0;
      R.stat.total = 0;
      R.stat.teammates = 0;
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

      // 绘制顺序：障碍 -> 地面物 -> 特效 -> 怪 -> 敌弹 -> 玩家 -> 玩家弹幕 -> 飘字
      // ★障碍在最底：怪撞不过它，画在怪之上就成了「怪躲在墙后」（假的）
      drawObstacles(w);
      drawZones(w, alpha);
      drawPickups(w, alpha);
      drawStrikes(w, alpha);
      drawEffects(w, alpha);
      drawMobs(w, alpha);
      drawEnemyShots(w, alpha);
      // 队友与自己同一层级（怪之上、弹幕之下），画在自己之前 —— 自己被压在最上层
      drawTeammates(w, alpha);
      drawPlayer(w, alpha);
      drawLevelPulse(w, alpha);
      drawProjectiles(w, alpha);
      drawOrbits(w, alpha);
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
