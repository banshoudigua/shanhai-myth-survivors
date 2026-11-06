// shared/maps.js —— 地图定义与地形生成
//
// 为什么单独一个文件、为什么放 shared/
// -----------------------------------
// 地图是**双端必须完全一致**的东西：服务端算碰撞、客户端画地面与障碍。
// 如果各写一份，出现的是「服务端以为那儿有堵墙、客户端看不见」这类
// 只在联机时冒出来的鬼问题。
//
// 更关键的是**同步策略**：地形不进快照。两端拿同一个 mapId，
// 用**同一个纯函数 + 同一个种子**各自算出完全相同的一份障碍物表。
// 一局游戏因此只需要在网络里传一个地图 id（几个字节），
// 而不是几十个障碍物坐标。
// ★所以 buildObstacles 必须是纯函数：不许读时钟、不许用 Math.random、
//   不许依赖调用顺序 —— 只要输入相同，输出必须逐字节相同。
//
// 关于「障碍物」这件事的历史
// ------------------------
// const.js 里原先写着：地图只保留地面装饰，P1 不加实体障碍，
// 因为「没做寻路时怪物会卡在障碍后面叠成一堆」。
// 这个判断是对的，但解法不是不做障碍，而是**不做寻路**：
//   · 障碍一律用**圆形** —— 圆形是凸的，没有凹角，不会形成死胡同
//   · 怪物撞墙时做「推出 + 沿切线滑动」，天然顺着墙走
//   · 再加一条兜底：卡住超过若干帧就临时允许穿墙（见 sim 的 stuck 处理）
// 这样既拿到了地形的战术价值（绕柱拉怪、隔墙打不到），又不会卡死。
//
// 写法约定：UMD 风格 —— 有 module 就导出，没有就挂到全局 VS。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VS = root.VS || {};
    root.VS.MAPS = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ============================================================
  // 障碍物的配色
  // ============================================================
  // kind 只是给渲染层看的「画法标签」，碰撞一律按圆处理 ——
  // 一份碰撞逻辑服务所有外观，不给每种障碍单独写一遍。
  //
  // ★每张地图各有一套（MAPS[].obTheme），不用这里的默认值 ——
  //   默认值只在「地图没配」时兜底。原因：第一版四张图共用一套障碍色，
  //   而钟楼广场的地面是 #2c2a2e、障碍是 #33383f —— 两者只差 7 个色阶，
  //   屏幕上**完全看不见墙在哪**。玩家看不见的墙等于没有墙，
  //   撞上去才会发现，那是设计事故。
  //   规则很简单：**障碍要比地面亮**（被照亮的顶面），玩家一眼能找到。
  const OBSTACLE_KINDS = {
    grave:  { label: '墓碑',  solid: '#55606b', edge: '#1a1e24', hi: '#7d8a97' },
    pillar: { label: '石柱',  solid: '#5a6068', edge: '#181b20', hi: '#828b96' },
    wall:   { label: '断墙',  solid: '#6b7078', edge: '#1e2024', hi: '#8f959e' },
    altar:  { label: '祭坛石', solid: '#6b4048', edge: '#1e1013', hi: '#8f5c65' },
    boulder:{ label: '巨石',  solid: '#5a6066', edge: '#1a1c20', hi: '#7f868f' },
    // 第二十八轮新增的四种建筑外观（点阵见 public/js/pixel-sprites.js）。
    // ★它们和上面五种一样**只是画法标签**，碰撞仍然一律按圆处理 ——
    //   加外观不等于加规则，这一点别在后续改动里破掉。
    lantern:{ label: '石灯笼', solid: '#5d646d', edge: '#1a1e23', hi: '#88919b' },
    tower:  { label: '残塔',  solid: '#5f6570', edge: '#181b21', hi: '#8a939f' },
    shrine: { label: '神龛',  solid: '#6a6055', edge: '#1d1913', hi: '#93887a' },
    cairn:  { label: '石冢',  solid: '#5b6159', edge: '#1a1e1a', hi: '#7f8579' }
  };

  // ============================================================
  // 地图表
  // ============================================================
  // 每张图的差异体现在四件事上（**不只是换个底色**）：
  //   ① 尺寸 —— 小图怪来得快、贴身；大图空旷、有发育时间
  //   ② 障碍布局 —— 散落 / 柱阵 / 断墙 / 环形，直接决定走位方式
  //   ③ 主题配色 —— 视觉辨识，一眼看出打的是哪张图
  //   ④ 刷怪参数 —— 半径与数量按图大小微调，否则小图会被挤爆、大图会太空
  //
  // ★尺寸下限：不能让地图比视口窄，否则相机会看到地图外的黑边。
  //   1080p 下视口约 1920，所以最小图取 2600×2000。
  const MAPS = [
    {
      id: 'graveyard',
      name: '乱葬岗',
      desc: '散落的墓碑，节奏均衡，新手图',
      w: 3200, h: 2400,
      theme: {
        ground: '#3a2428',      // 地面底色
        glow: 'rgba(120,24,32,0.16)',  // 中心辉光
        speck: 1.0,             // 噪点密度倍率
        stain: 'rgba(132,20,34,',      // 血渍基色（拼 alpha 用）
        deco: 'grave'           // 地面装饰画法
      },
      obTheme: { solid: '#55606b', edge: '#1a1e24', hi: '#7d8a97' },
      // kinds 是「外观池」：坟场以墓碑为主，掺石冢与半截断墙（见 buildObstacles 的 kindOf）
      obstaclePlan: { type: 'scatter', kind: 'grave', kinds: ['grave', 'grave', 'grave', 'cairn', 'wall'], count: 26, rMin: 26, rMax: 36, margin: 240, minGap: 130 },
      // 场景物件（第二十八轮）：坟场的火盆/蜡烛/鬼火 —— 有人来上过香
      props: [
        { kind: 'brazier', n: 2, scale: 0.62 },
        { kind: 'candle', n: 4, scale: 1.15 },
        { kind: 'spirit', n: 3, scale: 0.85 }
      ],
      chests: { n: 3 },
      portals: { n: 1 },
      spawn: { radius: 700, countMul: 1.0 },
      // 怪池偏好（第十五轮）：这张图的「性格」。
      // ★是**倍数**不是替换 —— 与 STAGES 按波次推进的权重相乘：
      //   STAGES 负责「越往后越难」的形状，这里负责「这张图更常出什么」。
      //   换成替换的话，换张图难度曲线就崩了（开局就全是精英）。
      //   没列出的怪按 1 倍，照常出。
      //   亡灵系主场：慢而硬的腐尸、成列的骸骨
      mobBias: {
        corpse: 2.4, skeleton_warrior: 1.7, bat: 1.2, blood_spider: 0.4
      }
    },
    {
      id: 'corridor',
      name: '轮回廊',
      desc: '狭长的石柱阵，贴身缠斗',
      w: 2600, h: 2000,
      theme: {
        ground: '#33272a',
        glow: 'rgba(110,20,28,0.14)',
        speck: 0.7,
        stain: 'rgba(120,18,30,',
        deco: 'brick'          // 石砖
      },
      // 规则柱阵：柱子的存在让「绕柱拉怪」成为主要走位手段，
      // 也让直线武器（剑气/骨刺）经常打在柱子上 —— 这是这张图的性格
      obTheme: { solid: '#5f6670', edge: '#181b20', hi: '#868f9a' },
      obstaclePlan: { type: 'grid', kind: 'pillar', kinds: ['pillar', 'pillar', 'pillar', 'lantern'], cols: 5, rows: 4, r: 30, margin: 320 },
      // 长廊两侧的壁炬 + 石灯笼，把「一条能跑的路」照出来
      props: [
        { kind: 'torch', n: 4, scale: 0.72 },
        { kind: 'brazier', n: 2, scale: 0.62 }
      ],
      chests: { n: 3 },
      portals: { n: 1 },
      spawn: { radius: 620, countMul: 0.85 },
      // 怪池偏好（第十五轮）：这张图的「性格」。
      // ★是**倍数**不是替换 —— 与 STAGES 按波次推进的权重相乘：
      //   STAGES 负责「越往后越难」的形状，这里负责「这张图更常出什么」。
      //   换成替换的话，换张图难度曲线就崩了（开局就全是精英）。
      //   没列出的怪按 1 倍，照常出。
      //   狭廊里的伏击：虫豸与猎犬成群扑上来
      mobBias: {
        blood_spider: 2.0, plague_hound: 1.6, corpse: 0.7, gargoyle: 0.8
      }
    },
    {
      id: 'cathedral',
      name: '祭天台',
      desc: '开阔的大广场，适合发育流',
      w: 3800, h: 2800,
      theme: {
        ground: '#413d44',
        glow: 'rgba(96,80,90,0.12)',
        speck: 0.85,
        stain: 'rgba(110,30,40,',
        deco: 'flagstone'      // 广场石板
      },
      // 断墙：由若干圆首尾相连拼成几段墙。
      // 墙比柱子更有「路线感」—— 玩家会自然沿着墙走，怪也会被墙分流
      obTheme: { solid: '#6b7078', edge: '#1e2024', hi: '#8f959e' },
      // cells 3x3 分区放置（中心格留空）—— 理由见 buildObstacles 的 walls 分支
      obstaclePlan: { type: 'walls', kind: 'wall', cells: 4, lenMin: 3, lenMax: 7, r: 26, margin: 300 },
      // 大广场：一座石砌喷泉 + 火盆/蜡烛围着它
      props: [
        { kind: 'fountain', n: 1, scale: 0.85, at: 'center' },
        { kind: 'brazier', n: 3, scale: 0.62 },
        { kind: 'candle', n: 2, scale: 1.1 }
      ],
      chests: { n: 3 },
      portals: { n: 1 },
      spawn: { radius: 820, countMul: 1.15 },
      // 怪池偏好（第十五轮）：这张图的「性格」。
      // ★是**倍数**不是替换 —— 与 STAGES 按波次推进的权重相乘：
      //   STAGES 负责「越往后越难」的形状，这里负责「这张图更常出什么」。
      //   换成替换的话，换张图难度曲线就崩了（开局就全是精英）。
      //   没列出的怪按 1 倍，照常出。
      //   钟楼广场：精英当道，重装与石像鬼封路
      mobBias: {
        bone_knight: 2.2, gargoyle: 1.8, witch_hunter: 1.3, bat: 0.5, corpse: 0.5
      }
    },
    {
      id: 'altar',
      name: '血月祭坛',
      desc: '中央环形石阵，可绕圈也可躲进去',
      w: 2800, h: 2800,
      theme: {
        ground: '#3d2328',
        glow: 'rgba(150,30,40,0.22)',
        speck: 1.15,
        stain: 'rgba(146,24,36,',
        deco: 'altar'
      },
      // 环形阵：中央围出一块空地，只留几个缺口。
      // 这是唯一一张「地形本身给你一个战术选择」的图 ——
      // 躲进去安全但要放弃机动，留在外面危险但随时能跑
      obTheme: { solid: '#6b4048', edge: '#1e1013', hi: '#8f5c65' },
      obstaclePlan: { type: 'ring', kind: 'altar', kinds: ['altar', 'altar', 'altar', 'tower', 'lantern'], count: 14, radius: 420, r: 34, gapEvery: 4, margin: 300 },
      // 血月祭坛：正中是空的，围着环形摆营火与鬼火；两侧再放传送裂隙
      props: [
        { kind: 'campfire', n: 2, scale: 0.72 },
        { kind: 'spirit', n: 2, scale: 0.85 },
        { kind: 'brazier', n: 2, scale: 0.62 }
      ],
      chests: { n: 3 },
      portals: { n: 1 },
      spawn: { radius: 700, countMul: 1.0 },
      // 怪池偏好（第十五轮）：这张图的「性格」。
      // ★是**倍数**不是替换 —— 与 STAGES 按波次推进的权重相乘：
      //   STAGES 负责「越往后越难」的形状，这里负责「这张图更常出什么」。
      //   换成替换的话，换张图难度曲线就崩了（开局就全是精英）。
      //   没列出的怪按 1 倍，照常出。
      //   祭坛：全部混编，光环单位同时在场
      mobBias: {
        blood_priest: 1.6, ghoul_matriarch: 1.6, bone_knight: 1.2, gargoyle: 1.2
      }
    },

    // ============================================================
    // 第十二轮新增的两张（斜向石阵 / 孤岛群）
    // ============================================================
    // 【为什么还要加图】四张图的地形都是「正交网格 + 圆形」的变体，
    // 玩家的走位体验其实是同一件事：找空隙、钻过去。
    // 加图的价值不是「换个背景」，而是**换一种走位处境**——
    // 下面两张各给一种原来没有的处境。
    {
      id: 'spire',
      name: '镇妖塔',
      desc: '45° 斜向石阵，顺着斜墙跑能省一半路',
      w: 3400, h: 2600,
      theme: {
        ground: '#38353a',      // 冷灰（**不用带紫的值**：#39333c 的色相偏紫，违反项目约定）
        glow: 'rgba(70,90,110,0.13)',
        speck: 0.9,
        stain: 'rgba(96,26,34,',
        deco: 'flagstone'
      },
      // 斜向石阵：障碍连线是 45°，玩家能顺着斜墙走 ——
      // 这是四张老图都给不了的「角度」，对直线武器尤其友好（斜着打能一次穿两排）
      obTheme: { solid: '#5f6874', edge: '#181b21', hi: '#8794a1' },
      obstaclePlan: {
        type: 'lattice', kind: 'pillar', kinds: ['pillar', 'pillar', 'lantern'], lines: 7,
        lenMin: 3, lenMax: 6, r: 27, margin: 300
      },
      // 镇妖塔：雷柱（特斯拉线圈）与灯球 —— 这张图的「镇的」到底是妖怪还是雷
      props: [
        { kind: 'coil', n: 2, scale: 0.8 },
        { kind: 'lamp', n: 3, scale: 0.65 }
      ],
      chests: { n: 3 },
      portals: { n: 1 },
      spawn: { radius: 760, countMul: 1.05 },
      // 怪池偏好（第十五轮）：这张图的「性格」。
      // ★是**倍数**不是替换 —— 与 STAGES 按波次推进的权重相乘：
      //   STAGES 负责「越往后越难」的形状，这里负责「这张图更常出什么」。
      //   换成替换的话，换张图难度曲线就崩了（开局就全是精英）。
      //   没列出的怪按 1 倍，照常出。
      //   斜塔回廊：全是快的东西，站着不动就被咬住
      mobBias: {
        plague_hound: 2.2, blood_spider: 1.8, bat: 1.6, corpse: 0.6, bone_knight: 0.7
      }
    },
    {
      id: 'marsh',
      name: '毒泽孤屿',
      desc: '成簇的孤岛，视野开阔，适合远程与穿透',
      w: 3000, h: 3000,
      theme: {
        ground: '#2f3630',      // 冷绿灰：与前四张的暗红/冷灰都能区分开，又不越界到紫
        glow: 'rgba(40,80,60,0.14)',
        speck: 1.2,
        stain: 'rgba(50,30,24,',   // 泥水偏褐
        deco: 'altar'
      },
      // 孤岛群：障碍成簇、簇间大片空地。
      // 这张图对武器是**反向**的：远程/穿透流能提前看到怪从哪来，
      // 贴身流则要面对「进得去出不来」。所以它不是所有人的好图 ——
      // 一张图有取舍，比六张图都平庸有价值。
      obTheme: { solid: '#55604f', edge: '#171c17', hi: '#77836d' },
      obstaclePlan: {
        type: 'islands', kind: 'boulder', kinds: ['boulder', 'cairn', 'cairn'], clusters: 9, r: 32, margin: 320
      },
      // 毒泽：瀑布（岩壁）+ 毒潭（贴地）+ 涟漪（贴地水面）
      // ★贴地件（puddle / ripples）走 ground 层，画在障碍之下，不参与 y 排序
      props: [
        { kind: 'waterfall', n: 1, scale: 0.75 },
        { kind: 'puddle', n: 3, scale: 0.85, layer: 'ground', pal: 'toxic' },
        { kind: 'ripples', n: 5, scale: 1.0, layer: 'ground', pal: 'water' }
      ],
      chests: { n: 3 },
      portals: { n: 1 },
      // 这张图怪偏少但更密（countMul 最低、radius 最大）——
      // 孤岛之间空旷，靠「更远但更多」制造被围的压迫感
      spawn: { radius: 900, countMul: 1.2 },
      // 怪池偏好（第十五轮）：这张图的「性格」。
      // ★是**倍数**不是替换 —— 与 STAGES 按波次推进的权重相乘：
      //   STAGES 负责「越往后越难」的形状，这里负责「这张图更常出什么」。
      //   换成替换的话，换张图难度曲线就崩了（开局就全是精英）。
      //   没列出的怪按 1 倍，照常出。
      //   沼泽孤岛：小怪成群，靠数量而不是靠强度
      mobBias: {
        bat: 2.0, blood_spider: 1.9, ghoul_matriarch: 1.5, skeleton_warrior: 0.7
      }
    }
  ];

  const DEFAULT_MAP_ID = 'graveyard';

  const MAP_MAP = {};
  for (let i = 0; i < MAPS.length; i++) MAP_MAP[MAPS[i].id] = MAPS[i];

  // 非法 id 一律回落到默认图：宁可打默认图，也不要「房间建不起来」
  function mapById(id) {
    return MAP_MAP[id] || MAP_MAP[DEFAULT_MAP_ID];
  }

  // ============================================================
  // 地形生成（纯函数 —— 见文件头的说明）
  // ============================================================
  // 用 LCG 而不是 Math.random：同一个 mapId 每次、每台机器算出的
  // 障碍物**完全一致**。这是「地形不进快照」这个策略成立的前提。
  function makeRnd(seed) {
    let s = (seed || 1) >>> 0;
    return function () {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  // 把地图 id 变成一个稳定的数字种子（不能用字符串哈希之外的东西，
  // 否则两端算出来不一样）
  function seedOf(id) {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  // 出生点附近要留空：玩家开局就在地图中心，
  // 障碍压在身上会被碰撞逻辑立刻推出去，看起来像「开局被弹了一下」
  const SPAWN_CLEAR = 170;

  function farFromSpawn(plan, x, y, cx, cy) {
    const dx = x - cx;
    const dy = y - cy;
    return Math.sqrt(dx * dx + dy * dy) > plan.margin * 0.55 + SPAWN_CLEAR;
  }

  function buildObstacles(map) {
    const m = map || MAP_MAP[DEFAULT_MAP_ID];
    const plan = m.obstaclePlan;
    const rnd = makeRnd(seedOf(m.id));
    const cx = m.w / 2;
    const cy = m.h / 2;
    const out = [];

    // 颜色跟着地图走：渲染层优先读 o.color，没有才回退到 kind 的默认色。
    // （服务端不画障碍，所以这一项纯属给客户端省一次查表，代价可忽略。）
    const ob = m.obTheme || null;
    // 【第二十八轮】一张图不再只有一种建筑。
    //   plan.kinds 是「外观池」——每放一个障碍就按 rnd 从池里抽一个画法标签。
    //   ★碰撞半径、位置、纯函数性质全部不变：变的只是**长什么样**。
    //   ★抽取用 rnd()（同一个 LCG）而不是 Math.random，两端算出来才一致。
    const kinds = plan.kinds && plan.kinds.length ? plan.kinds : null;
    // ★外观抽取用**独立的一条 LCG**，不能跟位置共用一条：
    //   共用的话每多抽一次「长什么样」，后面的坐标就整体偏移一格，
    //   六张图的地形会全部变样（第一次改就撞上了：孤岛图的开阔度断言当场变红）。
    //   分开之后，加外观对地形是零影响 —— 位置序列完全不变。
    const kindRnd = makeRnd(seedOf(m.id + '#kind'));
    function kindOf() {
      if (!kinds) return plan.kind;
      return kinds[Math.floor(kindRnd() * kinds.length) % kinds.length];
    }
    function push(x, y, r, forceKind) {
      out.push({
        x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, r: r,
        kind: forceKind || kindOf(),
        color: ob ? ob.solid : '', edge: ob ? ob.edge : '', hi: ob ? ob.hi : ''
      });
    }

    if (plan.type === 'scatter') {
      // 散布：带最小间距，避免几个墓碑挤成一坨形成凹角
      let guard = 0;
      while (out.length < plan.count && guard < plan.count * 60) {
        guard += 1;
        const x = plan.margin + rnd() * (m.w - plan.margin * 2);
        const y = plan.margin + rnd() * (m.h - plan.margin * 2);
        if (!farFromSpawn(plan, x, y, cx, cy)) continue;
        let ok = true;
        for (let i = 0; i < out.length; i++) {
          const dx = out[i].x - x;
          const dy = out[i].y - y;
          if (Math.sqrt(dx * dx + dy * dy) < plan.minGap) { ok = false; break; }
        }
        if (!ok) continue;
        push(x, y, plan.rMin + rnd() * (plan.rMax - plan.rMin));
      }

    } else if (plan.type === 'grid') {
      // 等距柱阵：刻意留出行列通道，玩家能沿通道跑
      const gx = (m.w - plan.margin * 2) / (plan.cols - 1);
      const gy = (m.h - plan.margin * 2) / (plan.rows - 1);
      for (let r = 0; r < plan.rows; r++) {
        for (let c = 0; c < plan.cols; c++) {
          const x = plan.margin + gx * c;
          const y = plan.margin + gy * r;
          if (!farFromSpawn(plan, x, y, cx, cy)) continue;
          push(x, y, plan.r);
        }
      }

    } else if (plan.type === 'walls') {
      // 断墙：**分区放置**，不是纯随机。
      //
      // ★为什么不用纯随机（实测踩过）：7 段墙撒在 3800×2800 的地图上，
      // 玩家在中心出生，往任一方向走 800px 都遇不到一面墙 ——
      // 「这张图有断墙」这个事实完全体现不出来，玩家会觉得地图选择是假的。
      // 分成 3×3，每格放一段（中心格跳过：出生点周围必须留空），
      // 于是往哪个方向走都能在 600px 内遇到墙。
      const cells = plan.cells || 3;
      const cw = (m.w - plan.margin * 2) / cells;
      const ch = (m.h - plan.margin * 2) / cells;
      for (let ry = 0; ry < cells; ry++) {
        for (let rx = 0; rx < cells; rx++) {
          // 只留**中心一格**。第一版按 cells 推算留中间 2×2，结果中心空出
          // 2270×1770 —— 实测「离出生点 700px 内的障碍 = 0 个」，
          // 整张图最大的那张反而最空。出生点干净就够了，不必清一大片。
          const mid = Math.floor(cells / 2);
          if (rx === mid && ry === mid) continue;
          if (rnd() < 0.15) continue;                   // 偶尔空一格，别太规整
          const bx = plan.margin + cw * (rx + 0.5) + (rnd() - 0.5) * cw * 0.5;
          const by = plan.margin + ch * (ry + 0.5) + (rnd() - 0.5) * ch * 0.5;
          // 以横墙/竖墙为主（带一点角度抖动）—— 纯随机角度会斜插到画面边缘，读起来乱
          const ang = (rnd() < 0.5 ? 0 : Math.PI / 2) + (rnd() - 0.5) * 0.4;
          const len = plan.lenMin + Math.floor(rnd() * (plan.lenMax - plan.lenMin + 1));
          const step = plan.r * 1.5;                    // 1.5 倍半径：相邻圆有重叠，墙身是连的
          for (let s = 0; s < len; s++) {
            const qx = bx + Math.cos(ang) * step * s;
            const qy = by + Math.sin(ang) * step * s;
            if (qx < plan.margin || qx > m.w - plan.margin) break;
            if (qy < plan.margin || qy > m.h - plan.margin) break;
            if (!farFromSpawn(plan, qx, qy, cx, cy)) continue;
            // ★墙段必须**整段同一种外观**：混进「神龛」这种中间镂空的画法，
            //   会出现「看着能穿过去、撞上去是墙」的隐形墙（碰撞是按圆算的）。
            //   所以只在**两端**换成实心的石灯笼当门柱，中段一律断墙 ——
            //   既不会变成隐形墙，又让一段墙看起来有「起头」和「收尾」。
            const endPost = (s === 0 || s === len - 1);
            push(qx, qy, plan.r, endPost ? 'lantern' : plan.kind);
          }
        }
      }

    } else if (plan.type === 'ring') {
      // 环形阵：留缺口（gapEvery）—— 有缺口才叫「可以躲进去」，
      // 全封闭就变成怪物进不来的无敌区了
      const n = plan.count;
      const offset = rnd() * Math.PI * 2;
      for (let i = 0; i < n; i++) {
        if (plan.gapEvery && i % plan.gapEvery === 0) continue;
        const a = offset + (Math.PI * 2 / n) * i;
        push(cx + Math.cos(a) * plan.radius, cy + Math.sin(a) * plan.radius, plan.r);
      }
      // 外圈再撒几块零散石头，避免外圈完全空旷
      for (let k = 0; k < 10; k++) {
        const a = rnd() * Math.PI * 2;
        const rr = plan.radius * (1.45 + rnd() * 0.75);
        const x = cx + Math.cos(a) * rr;
        const y = cy + Math.sin(a) * rr;
        if (x < plan.margin || x > m.w - plan.margin) continue;
        if (y < plan.margin || y > m.h - plan.margin) continue;
        push(x, y, plan.r * 0.7);
      }
    } else if (plan.type === 'lattice') {
      // 斜向石阵（第十二轮新增）
      //
      // 【为什么要有这个新类型】原来四种摆法（散布/柱阵/断墙/环阵）都是
      // 「正交网格 + 圆形」的变体，玩家的走位体验其实是同一件事：
      // 找空隙、钻过去。加一种**45° 斜排**后，视野里的障碍连线是斜的，
      // 「顺着斜墙跑」成为新的路线选择 —— 这是纯网格给不了的角度感。
      //
      // 实现很朴素：一组组沿 45° 方向排开的短柱。仍然只放圆、不做寻路，
      // 所以「圆是凸的、不会形成死胡同」这条前提依然成立。
      const dirs = [[1, 1], [1, -1]];          // 两组：↗ 与 ↘，交叉成网
      for (let d = 0; d < dirs.length; d++) {
        const vx = dirs[d][0], vy = dirs[d][1];
        // 每组沿法线方向平移若干条，每条是一串短柱
        const lines = plan.lines || 6;
        for (let l = 0; l < lines; l++) {
          // 起点沿法线方向错开，并把整条线往图内收一点，避免顶到边
          const ox = plan.margin + rnd() * (m.w - plan.margin * 2);
          const oy = plan.margin + (l + 0.5) * ((m.h - plan.margin * 2) / lines);
          const len = plan.lenMin + Math.floor(rnd() * (plan.lenMax - plan.lenMin + 1));
          for (let s = 0; s < len; s++) {
            const x = ox + vx * plan.r * 1.55 * s;
            const y = oy + vy * plan.r * 1.55 * s;
            if (x < plan.margin || x > m.w - plan.margin) break;
            if (y < plan.margin || y > m.h - plan.margin) break;
            if (!farFromSpawn(plan, x, y, cx, cy)) continue;
            // 留一个断点：整条线完全连死的话它就变成又一道墙了
            if (rnd() < 0.12) continue;
            push(x, y, plan.r);
          }
        }
      }

    } else if (plan.type === 'islands') {
      // 孤岛群（第十二轮新增）
      //
      // 性格与其它图都不同：障碍**成簇**，簇与簇之间是大片空地。
      // 玩家的选择变成「待在哪个岛附近打」而不是「怎么穿过障碍」——
      // 这对远程/穿透流是明显加成（视线开阔、能提前看到怪从哪来），
      // 对贴身流则是麻烦（进得去出不来）。
      // 也就是说：**同一张图对不同武器是不一样的好图**，这是新增图的核心价值。
      const clusters = plan.clusters || 7;
      for (let i = 0; i < clusters; i++) {
        // 簇心避开出生点，否则玩家一睁眼就被围住
        let bx = 0, by = 0, guard = 0;
        while (guard < 40) {
          guard += 1;
          bx = plan.margin + rnd() * (m.w - plan.margin * 2);
          by = plan.margin + rnd() * (m.h - plan.margin * 2);
          if (farFromSpawn(plan, bx, by, cx, cy)) break;
        }
        // 每簇 3~6 块，围一个不规则的圈（中间空出来 —— 那是「岛心」，可站人）
        const n = 3 + Math.floor(rnd() * 4);
        const rad = plan.r * (1.6 + rnd() * 1.1);
        const rot = rnd() * Math.PI * 2;
        for (let s = 0; s < n; s++) {
          const a = rot + (Math.PI * 2 / n) * s + (rnd() - 0.5) * 0.3;
          const x = bx + Math.cos(a) * rad;
          const y = by + Math.sin(a) * rad;
          if (x < plan.margin || x > m.w - plan.margin) continue;
          if (y < plan.margin || y > m.h - plan.margin) continue;
          if (!farFromSpawn(plan, x, y, cx, cy)) continue;
          push(x, y, plan.r * (0.78 + rnd() * 0.3));
        }
      }
    }

    return out;
  }

  // ============================================================
  // 场景物件 / 宝箱 / 传送门（第二十八轮）
  // ============================================================
  // 【三条硬约定】
  //   ① 全部是**纯函数**：同一个 mapId、同一台机器、两次调用结果逐字节相同。
  //      物件不进快照也不参与碰撞，但两端必须画出同一个世界，否则队友看到的地图不一样。
  //   ② 只用「地图 id 派生的 LCG」，不许读时钟、不许 Math.random。
  //   ③ 出生点周围必须留空 —— 物件虽然不挡路，但开局糊一屏火盆很吵。
  //
  // 物件（props）是**纯表现**：服务端不读它、不进快照、不参与碰撞。
  // 宝箱（chests）是玩法：服务端开局按这份坐标生成真正的掉落物。
  // 传送门（portals）是玩法：服务端按这份坐标做「踩上去瞬移」，客户端只负责画。
  const PROP_SPAWN_CLEAR = 210;
  const PROP_MARGIN = 150;

  function round1(v) { return Math.round(v * 10) / 10; }

  function buildProps(map) {
    const m = map || MAP_MAP[DEFAULT_MAP_ID];
    const specs = m.props || [];
    if (!specs.length) return [];
    const rnd = makeRnd(seedOf(m.id + ':props'));
    const obs = buildObstacles(m);
    const cx = m.w / 2;
    const cy = m.h / 2;
    const TAU = Math.PI * 2;
    const out = [];

    function freeAt(x, y) {
      if (x < PROP_MARGIN || y < PROP_MARGIN) return false;
      if (x > m.w - PROP_MARGIN || y > m.h - PROP_MARGIN) return false;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < PROP_SPAWN_CLEAR * PROP_SPAWN_CLEAR) return false;
      for (let i = 0; i < obs.length; i++) {
        const ox = obs[i].x - x, oy = obs[i].y - y;
        const rr = obs[i].r + 16;
        if (ox * ox + oy * oy < rr * rr) return false;
      }
      for (let i = 0; i < out.length; i++) {
        const px = out[i].x - x, py = out[i].y - y;
        if (px * px + py * py < 88 * 88) return false;
      }
      return true;
    }

    for (let s = 0; s < specs.length; s++) {
      const spec = specs[s];
      let placed = 0;
      let guard = 0;
      const cap = Math.max(40, spec.n * 160);
      while (placed < spec.n && guard < cap) {
        guard += 1;
        let x, y;
        if (spec.at === 'center') {
          // 「广场中心」不等于出生点：从中心往外错开一圈，别糊在玩家脸上
          const a = rnd() * TAU;
          const r = 430 + rnd() * 170;
          x = cx + Math.cos(a) * r;
          y = cy + Math.sin(a) * r;
        } else if (obs.length) {
          // 贴着某个障碍摆：物件要么靠墙、要么靠石头，凭空立在旷野上最难看
          const o = obs[Math.floor(rnd() * obs.length) % obs.length];
          const a = rnd() * TAU;
          const r = o.r + 26 + rnd() * 44;
          x = o.x + Math.cos(a) * r;
          y = o.y + Math.sin(a) * r;
        } else {
          x = PROP_MARGIN + rnd() * (m.w - PROP_MARGIN * 2);
          y = PROP_MARGIN + rnd() * (m.h - PROP_MARGIN * 2);
        }
        if (!freeAt(x, y)) continue;
        out.push({
          kind: spec.kind,
          x: round1(x),
          y: round1(y),
          scale: spec.scale || 0.6,
          layer: spec.layer || 'prop',
          pal: spec.pal || '',
          seed: 1 + Math.floor(rnd() * 999)
        });
        placed += 1;
      }
    }
    return out;
  }

  // 宝箱点位：绕中心一圈平均分布 + 抖动，避开障碍与出生点。
  // ★刻意不贴着出生点：宝箱是「要跑过去拿」的，开局就送到手上没有意义。
  function buildChests(map) {
    const m = map || MAP_MAP[DEFAULT_MAP_ID];
    const n = (m.chests && m.chests.n) || 0;
    if (!n) return [];
    const rnd = makeRnd(seedOf(m.id + ':chests'));
    const obs = buildObstacles(m);
    const cx = m.w / 2;
    const cy = m.h / 2;
    const base = Math.min(m.w, m.h) * 0.3;
    const out = [];

    function freeAt(x, y) {
      if (x < PROP_MARGIN + 60 || y < PROP_MARGIN + 60) return false;
      if (x > m.w - PROP_MARGIN - 60 || y > m.h - PROP_MARGIN - 60) return false;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < 520 * 520) return false;   // 离出生点至少 520
      for (let i = 0; i < obs.length; i++) {
        const ox = obs[i].x - x, oy = obs[i].y - y;
        const rr = obs[i].r + 30;
        if (ox * ox + oy * oy < rr * rr) return false;
      }
      for (let i = 0; i < out.length; i++) {
        const px = out[i].x - x, py = out[i].y - y;
        if (px * px + py * py < 460 * 460) return false;  // 宝箱之间拉开距离
      }
      return true;
    }

    for (let i = 0; i < n; i++) {
      let placed = false;
      let guard = 0;
      while (!placed && guard < 120) {
        guard += 1;
        const a = (Math.PI * 2 / n) * i + rnd() * 0.7;
        const r = base * (0.85 + rnd() * 0.5);
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (!freeAt(x, y)) continue;
        out.push({ x: round1(x), y: round1(y) });
        placed = true;
      }
    }
    return out;
  }

  // 传送门：按对生成。portal[i].pair 指向另一端在数组里的下标。
  // ★两端都参与「踩上去就传」的判定，所以必须成对；奇数个会有一个永远传不走。
  function buildPortals(map) {
    const m = map || MAP_MAP[DEFAULT_MAP_ID];
    const n = (m.portals && m.portals.n) || 0;
    if (!n) return [];
    const rnd = makeRnd(seedOf(m.id + ':portals'));
    const obs = buildObstacles(m);
    const cx = m.w / 2;
    const cy = m.h / 2;
    const out = [];

    function ok(x, y) {
      if (x < PROP_MARGIN + 40 || y < PROP_MARGIN + 40) return false;
      if (x > m.w - PROP_MARGIN - 40 || y > m.h - PROP_MARGIN - 40) return false;
      const dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy < 300 * 300) return false;   // 别堵在出生点
      for (let i = 0; i < obs.length; i++) {
        const ox = obs[i].x - x, oy = obs[i].y - y;
        const rr = obs[i].r + 46;
        if (ox * ox + oy * oy < rr * rr) return false;
      }
      for (let i = 0; i < out.length; i++) {
        const px = out[i].x - x, py = out[i].y - y;
        if (px * px + py * py < 300 * 300) return false;
      }
      return true;
    }

    for (let i = 0; i < n; i++) {
      // ★必须重试：只掷一次的话，只要落点碰到一块石头，这一对传送门就整个消失
      //   （第一版就是这样，乱葬岗 26 个障碍一挡，n=1 却一个都没生成出来）。
      let placed = false;
      let guard = 0;
      while (!placed && guard < 80) {
        guard += 1;
        const a = (Math.PI * 2 / (n * 2)) * (i * 2) + rnd() * 0.9;
        const r = Math.min(m.w, m.h) * (0.24 + rnd() * 0.1);
        const ax = cx + Math.cos(a) * r;
        const ay = cy + Math.sin(a) * r;
        // 另一端隔着中心对称放：走进去就被甩到地图另一边，这才是「传送」
        const bx = cx - Math.cos(a) * r * (1.05 + rnd() * 0.2);
        const by = cy - Math.sin(a) * r * (1.05 + rnd() * 0.2);
        if (!ok(ax, ay) || !ok(bx, by)) continue;
        const i0 = out.length;
        out.push({ x: round1(ax), y: round1(ay), pair: i0 + 1 });
        out.push({ x: round1(bx), y: round1(by), pair: i0 });
        placed = true;
      }
    }
    return out;
  }

  // ============================================================
  // 空间网格：查询「附近有哪些障碍」
  // ============================================================
  // 为什么必须有它（这是实测出来的，不是预防性设计）：
  // 满局 24000 帧 × 每帧约 400 次碰撞查询（200 只怪各查 2 个轴 + 玩家）
  // × 每次遍历全部 36 个障碍 ≈ **3.4 亿次**距离比较。
  // 加碰撞后 simtest 的耗时从 2.5 秒涨到 12.2 秒 —— 5 倍，
  // 而线上是 20Hz 跑整局、还要打包快照，这个开销付不起。
  //
  // 上了网格之后每次查询只看自己所在的那一两格（障碍半径最大 36，
  // 格宽 200 足够把「一圈」都圈进来），开销降一个数量级。
  //
  // ★确定性：桶里放的是**下标**且按 obstacles 顺序压入，
  //   两端遍历出来的顺序完全一致 —— 渲染的绘制顺序才不会在联机时抖动。
  const GRID_CELL = 200;

  function buildGrid(map, obstacles) {
    const cols = Math.max(1, Math.ceil(map.w / GRID_CELL));
    const rows = Math.max(1, Math.ceil(map.h / GRID_CELL));
    const buckets = new Array(cols * rows);
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      // 一个障碍可能跨格 —— 它覆盖到的每一格都登记它，
      // 否则查询站在格子边界上的实体时会漏掉半个身子在邻格的障碍
      let c0 = Math.floor((o.x - o.r) / GRID_CELL);
      let c1 = Math.floor((o.x + o.r) / GRID_CELL);
      let r0 = Math.floor((o.y - o.r) / GRID_CELL);
      let r1 = Math.floor((o.y + o.r) / GRID_CELL);
      if (c0 < 0) c0 = 0;
      if (r0 < 0) r0 = 0;
      if (c1 > cols - 1) c1 = cols - 1;
      if (r1 > rows - 1) r1 = rows - 1;
      for (let rr = r0; rr <= r1; rr++) {
        const base = rr * cols;
        for (let cc = c0; cc <= c1; cc++) {
          const k = base + cc;
          if (!buckets[k]) buckets[k] = [];
          buckets[k].push(i);
        }
      }
    }
    return { cell: GRID_CELL, cols: cols, rows: rows, buckets: buckets };
  }

  // 把「以 (x,y) 为中心、半径 range 内」的障碍**下标**写进 out，返回数量。
  // 调用方自己按精确距离过滤 —— 这里只负责把「可能相关的」挑出来。
  // 复用 out 数组是为了不在每帧分配：这一步每帧要跑上千次。
  function collectNear(grid, obstacles, x, y, range, out) {
    out.length = 0;
    const cell = grid.cell;
    let c0 = Math.floor((x - range) / cell);
    let c1 = Math.floor((x + range) / cell);
    let r0 = Math.floor((y - range) / cell);
    let r1 = Math.floor((y + range) / cell);
    if (c0 < 0) c0 = 0;
    if (r0 < 0) r0 = 0;
    if (c1 > grid.cols - 1) c1 = grid.cols - 1;
    if (r1 > grid.rows - 1) r1 = grid.rows - 1;
    for (let rr = r0; rr <= r1; rr++) {
      const base = rr * grid.cols;
      for (let cc = c0; cc <= c1; cc++) {
        const b = grid.buckets[base + cc];
        if (!b) continue;
        for (let i = 0; i < b.length; i++) out.push(b[i]);
      }
    }
    return out.length;
  }

  return {
    MAPS: MAPS,
    DEFAULT_MAP_ID: DEFAULT_MAP_ID,
    OBSTACLE_KINDS: OBSTACLE_KINDS,
    GRID_CELL: GRID_CELL,
    mapById: mapById,
    buildObstacles: buildObstacles,
    buildProps: buildProps,
    buildChests: buildChests,
    buildPortals: buildPortals,
    buildGrid: buildGrid,
    collectNear: collectNear,
    seedOf: seedOf
  };
});
