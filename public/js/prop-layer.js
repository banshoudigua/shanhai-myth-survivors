/*!
 * public/js/prop-layer.js —— 地图场景物件层（第二十八轮）
 *
 * 【它解决什么】
 * 原来一张地图上只有一种障碍外观，走两小时看到的都是同一个东西在重复。
 * 这个模块把 pixelfx 里那批「原位常驻」的效果（火盆、营火、蜡烛、壁炬、鬼火、
 * 石砌喷泉、瀑布、水面涟漪、毒潭、传送裂隙、灯球、雷柱）当作**摆在格子上的物件**
 * 画出来 —— 不参与碰撞、不进快照、不影响任何数值。
 *
 * 【为什么不复用 pixelfx-layer.js 的 draw】
 * 那个函数是给「技能特效」写的，带着三个物件不能用的假设：
 *   ① 加法混合（lighter）—— 铁架、石池、木柴这些**不发光**的像素会被地面吃掉，
 *      只剩一团火苗悬在空中；
 *   ② 把库动画压进实体寿命（最高 4 倍速）—— 物件的火要按它自己的节奏烧；
 *   ③ 随寿命淡出 —— 物件是常驻的，alpha 恒为 1。
 * 所以这里另开一套：source-over + 1 倍速 + 恒定不透明，并且**每个实例独占一块离屏画布**
 * （pixelfx-layer 是每个特效名共用一块，因为技能特效同屏只有一两个；
 *   物件同屏可能有三四个火盆，共用一块就会互相覆盖）。
 *
 * 【性能】
 * 库动画是 30fps，而屏幕是 60fps —— 每个物件隔帧更新一次（≈15fps）完全看不出差别，
 * 开销直接减半。再加一个「每帧最多更新 N 个」的预算：超出的那一帧沿用上一帧的画布，
 * 只更新位置。地图上物件再多也不会把帧预算吃穿。
 *
 * 依赖：/vendor/pixelfx/pixelfx.js 必须先加载。
 */
(function (root) {
  'use strict';

  const lib = root.PixelFX;
  const VS = root.VS = root.VS || {};
  const PROPS = VS.PropLayer = {};

  // 项目配色：暗红 / 琥珀金 / 冷灰，禁紫与紫蓝。
  // 库里这几个物件的原始配色有紫（传送裂隙）与荧光青（鬼火），全部在这里换掉。
  const PAL = {
    fire: ['#2c1116', '#66211c', '#8c1d1c', '#cc3a1a', '#f2701f', '#ffae35', '#ffe27a', '#fff8d6'],
    gold: ['#35210d', '#604014', '#7d4a12', '#b37418', '#e0a327', '#ffc94a', '#ffe89a', '#fff8dc'],
    steel: ['#1e2730', '#33404b', '#3a4650', '#576672', '#7e8c98', '#aebbc6', '#dce6ee', '#ffffff'],
    // 水：冷灰蓝，比冰再压暗一档，免得在暗红地面上发亮
    water: ['#142430', '#22454f', '#235060', '#337a8a', '#4aa2ac', '#7fc9cc', '#c2eced', '#ffffff'],
    // 毒泽：黄绿泥沼。★不用荧光绿，暗红+琥珀金的主色调下荧光绿会跳出来
    toxic: ['#1e2712', '#36431c', '#3d4a12', '#5c6b18', '#7d8f22', '#a6b83a', '#cddb6a', '#f2f7b8'],
    // 鬼火：冷青白（青不算紫，守约定）
    cold: ['#132730', '#20404a', '#1d4650', '#2b6a72', '#479398', '#7cc0c1', '#bfe4e2', '#f2fffd']
  };
  PROPS.PAL = PAL;

  // 每种物件用哪套色。没写的走 gold。
  const KIND_PAL = {
    brazier: 'fire', campfire: 'fire', candle: 'gold', torch: 'fire',
    spirit: 'cold', fountain: 'water', waterfall: 'water', ripples: 'water',
    puddle: 'toxic', rift: 'gold', lamp: 'steel', coil: 'steel'
  };

  // 每种物件的缩放微调：库里的尺寸是按「112~224px 的横版场景」定的，
  // 我们的角色是 16×16、障碍直径 52~72 —— 直接 1:1 贴会大得像一头 Boss。
  const KIND_SCALE = {
    brazier: 0.5, campfire: 0.6, candle: 1.0, torch: 0.6, spirit: 0.6,
    fountain: 0.72, waterfall: 0.62, ripples: 0.55, puddle: 0.5, rift: 0.6,
    lamp: 0.55, coil: 0.5
  };

  PROPS.ready = !!(lib && lib.effects && lib.createFrame && lib.createFx &&
    lib.clearFrame && lib.composite && root.document && root.ImageData);
  if (!PROPS.ready) {
    PROPS.begin = function () {};
    PROPS.ensure = function () { return []; };
    PROPS.drawGround = function () {};
    PROPS.draw = function () {};
    console.warn('[场景物件] pixelfx 未就绪，本局不画地图物件（其余功能不受影响）');
    return;
  }

  // 每张地图只算一次（buildProps 是纯函数，同一张图每局位置都一样）
  // 总开关：低端机/排查性能时可以直接关掉整层（不影响玩法）
  PROPS.enabled = true;

  const byMap = Object.create(null);
  let insts = [];          // 当前地图的实例（带离屏资源）
  let curMapId = '';
  let updateCursor = 0;
  const MAX_UPDATE_PER_FRAME = 4;

  function makeInstance(def, idx) {
    const mod = lib.effects[def.kind];
    if (!mod || !mod.meta) return null;
    const size = mod.meta.size || [96, 96];
    const origin = mod.meta.origin || [size[0] / 2, size[1] / 2];
    const w = Math.max(1, size[0] | 0);
    const h = Math.max(1, size[1] | 0);
    const canvas = root.document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c2 = canvas.getContext('2d');
    const palName = def.pal || KIND_PAL[def.kind] || 'gold';
    const pal = PAL[palName] || PAL.gold;
    // ★缩放只取一次：地图配置里给了 scale 就用它，没给才用 KIND_SCALE 兜底。
    //   第一版写成了 `(def.scale || 1) * KIND_SCALE[kind]` —— 两个系数连乘，
    //   火盆最后只有 29px 宽（0.52 × 0.5），截图里就是地上一个小亮点。
    const sc = def.scale > 0 ? def.scale : (KIND_SCALE[def.kind] || 0.6);
    return {
      id: curMapId + '#' + idx,
      kind: def.kind,
      x: def.x, y: def.y,
      scale: sc,
      layer: def.layer === 'ground' ? 'ground' : 'prop',
      w: w, h: h,
      ox: origin[0], oy: origin[1],
      duration: Number(mod.meta.duration) > 0 ? Number(mod.meta.duration) : 1,
      canvas: canvas,
      c2: c2,
      frame: lib.createFrame(w, h, 0, 0),
      img: c2.createImageData(w, h),
      fx: lib.createFx(mod, {
        x: origin[0], y: origin[1],
        seed: def.seed || (idx + 1),
        palette: pal,
        light: 1,
        flip: false,
        angle: 0
      }),
      elapsed: 0,
      dirty: true
    };
  }

  // 切图时才建实例：一张图十几个物件，建一次就够整局用
  PROPS.ensure = function (mapId) {
    const id = mapId || '';
    if (id === curMapId && insts.length) return insts;
    curMapId = id;
    insts = [];
    const maps = VS.MAPS;
    if (!maps || !maps.buildProps || !maps.mapById) return insts;
    byMap[id] = byMap[id] || maps.buildProps(maps.mapById(id));
    const defs = byMap[id];
    for (let i = 0; i < defs.length; i++) {
      const inst = makeInstance(defs[i], i);
      if (inst) insts.push(inst);
    }
    // 立牌按 y 排序：靠下的后画，天然「站在前面」
    insts.sort(function (a, b) { return a.y - b.y; });
    return insts;
  };

  PROPS.begin = function (dt, view) {
    if (!PROPS.enabled) return;
    const step = dt > 0 ? Math.min(dt, 0.05) : 0.016;
    // 相机：只更新「看得见」的物件。
    // ★这一步是必需的，不是优化癖：地图上九~十几个物件，屏幕里通常只有三四个，
    //   不剔视野就等于每帧白算五六个 112×148 的画布合成 —— 实测 8ms 就是这么来的。
    //   视野先放宽一屏（相机移动时靠边界的物件不会「来不及更新」）。
    const camX = view && view.cam ? view.cam.x : -1e9;
    const camY = view && view.cam ? view.cam.y : -1e9;
    const vw = view && view.viewW ? view.viewW : 1e9;
    const vh = view && view.viewH ? view.viewH : 1e9;
    // 隔帧更新：库动画 30fps，屏幕 60fps，两帧算一次肉眼看不出差别，开销减半
    updateCursor += 1;
    let updated = 0;
    for (let i = 0; i < insts.length; i++) {
      const it = insts[i];
      it.dirty = false;
      const pad = 220;
      if (it.x + pad < camX || it.x - pad > camX + vw) continue;
      if (it.y + pad < camY || it.y - pad > camY + vh) continue;
      if (updated >= MAX_UPDATE_PER_FRAME) continue;
      if ((updateCursor + i) % 2 !== 0) continue;
      updated += 1;
      it.elapsed += step * 2;          // 两帧才推进一次，所以补回双倍时间
      if (it.elapsed > it.duration) {
        // 循环：整段放完就换一个新实例，避免粒子越积越多
        it.elapsed -= it.duration;
        const mod = lib.effects[it.kind];
        it.fx = lib.createFx(mod, {
          x: it.ox, y: it.oy, seed: (i + 1), palette: it.fx.options.palette, light: 1, flip: false, angle: 0
        });
      }
      it.fx.update(step * 2);
      lib.clearFrame(it.frame);
      it.fx.draw(it.frame, 'back');
      it.fx.draw(it.frame, 'front');
      lib.composite(it.frame, it.img.data, null, 1);
      it.c2.putImageData(it.img, 0, 0);
      it.dirty = true;
    }
  };

  // 贴地件（毒潭 / 涟漪）：不投影、不排序，只按世界坐标铺平
  PROPS.drawGround = function (ctx, world, view) {
    if (!PROPS.enabled || !insts.length) return 0;
    let n = 0;
    // 相机由渲染层传进来（不反向读渲染器内部状态：那层没有对外暴露 R）
    const camX = view && view.cam ? view.cam.x : 0;
    const camY = view && view.cam ? view.cam.y : 0;
    const vw = view && view.viewW ? view.viewW : 1920;
    const vh = view && view.viewH ? view.viewH : 1080;
    for (let i = 0; i < insts.length; i++) {
      const it = insts[i];
      if (it.layer !== 'ground') continue;
      const halfW = it.w * it.scale * 0.5;
      const halfH = it.h * it.scale * 0.5;
      if (it.x + halfW < camX || it.x - halfW > camX + vw) continue;
      if (it.y + halfH < camY || it.y - halfH > camY + vh) continue;
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.95;
      ctx.translate(it.x, it.y);
      ctx.scale(it.scale, it.scale);
      ctx.drawImage(it.canvas, -it.ox, -it.oy);
      ctx.restore();
      n += 1;
    }
    return n;
  };

  // 立牌物件：影子 + 本体，画在障碍之上、怪物之下
  PROPS.draw = function (ctx, view) {
    if (!PROPS.enabled || !insts.length) return 0;
    let n = 0;
    // 相机由渲染层传进来（不反向读渲染器内部状态：那层没有对外暴露 R）
    const camX = view && view.cam ? view.cam.x : 0;
    const camY = view && view.cam ? view.cam.y : 0;
    const vw = view && view.viewW ? view.viewW : 1920;
    const vh = view && view.viewH ? view.viewH : 1080;
    for (let i = 0; i < insts.length; i++) {
      const it = insts[i];
      if (it.layer === 'ground') continue;
      const halfW = it.w * it.scale * 0.6;
      const hgt = it.h * it.scale;
      if (it.x + halfW < camX || it.x - halfW > camX + vw) continue;
      if (it.y - hgt > camY + vh || it.y + 40 < camY) continue;

      // 影子：物件的 origin 在脚底，所以影子就画在 (x, y) 上，扁椭圆
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,0,0,0.34)';
      ctx.beginPath();
      ctx.ellipse(it.x, it.y - 2, Math.max(8, it.w * it.scale * 0.34), Math.max(3, it.w * it.scale * 0.13), 0, 0, Math.PI * 2);
      ctx.fill();

      ctx.translate(it.x, it.y);
      ctx.scale(it.scale, it.scale);
      ctx.globalAlpha = 1;
      ctx.drawImage(it.canvas, -it.ox, -it.oy);
      ctx.restore();
      n += 1;
    }
    return n;
  };

  // 调试用：当前地图物件清单
  PROPS.list = function () {
    return insts.map(function (it) {
      return { kind: it.kind, x: it.x, y: it.y, layer: it.layer, scale: Math.round(it.scale * 100) / 100 };
    });
  };

  // ============================================================
  // 贴花：给「技能留下的地面区域」用（第二十八轮）
  // ============================================================
  // 净瓶甘露/血雨/冰封这些区域技以前只画三个同心圆，静止不动，在一屏怪里
  // 很容易被当成地板贴图。这里把库里的「毒潭」效果换个颜色铺在圈里，
  // 泡泡、油膜、蒸汽全是流动的，一眼就能看出「这块地是技能留下的」。
  //
  // ★按 key 缓存实例（key 用 zone id），区域消失后靠 lastSeen 淘汰；
  //   数量上限很小（同屏最多三四个区域），不需要预算控制。
  const decals = new Map();
  const DECAL_MAX = 8;

  PROPS.drawDecal = function (ctx, o) {
    if (!PROPS.enabled || !o || !o.kind) return false;
    const key = String(o.key || o.kind);
    const now = root.performance ? root.performance.now() : 0;
    let rec = decals.get(key);
    if (!rec || rec.kind !== o.kind) {
      const mod = lib.effects[o.kind];
      if (!mod || !mod.meta) return false;
      const size = mod.meta.size || [96, 96];
      const origin = mod.meta.origin || [size[0] / 2, size[1] / 2];
      const w = Math.max(1, size[0] | 0);
      const h = Math.max(1, size[1] | 0);
      const canvas = root.document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const c2 = canvas.getContext('2d');
      rec = {
        kind: o.kind,
        w: w, h: h, ox: origin[0], oy: origin[1],
        duration: Number(mod.meta.duration) > 0 ? Number(mod.meta.duration) : 1,
        canvas: canvas, c2: c2,
        frame: lib.createFrame(w, h, 0, 0),
        img: c2.createImageData(w, h),
        fx: null,
        elapsed: 0,
        lastSeen: now,
        palName: ''
      };
      // 超上限先淘汰最久没出现的那个
      if (decals.size >= DECAL_MAX) {
        let oldestKey = '', oldest = Infinity;
        decals.forEach(function (v, k) { if (v.lastSeen < oldest) { oldest = v.lastSeen; oldestKey = k; } });
        if (oldestKey) decals.delete(oldestKey);
      }
      decals.set(key, rec);
    }
    rec.lastSeen = now;

    const step = o.dt > 0 ? Math.min(o.dt, 0.05) : 0.016;
    const palName = o.pal || 'water';
    const mod = lib.effects[o.kind];
    if (!rec.fx || rec.palName !== palName) {
      rec.palName = palName;
      rec.elapsed = 0;
      rec.fx = lib.createFx(mod, {
        x: rec.ox, y: rec.oy, seed: 3,
        palette: PAL[palName] || PAL.water, light: 1, flip: false, angle: 0
      });
    }
    rec.elapsed += step;
    if (rec.elapsed > rec.duration) {
      rec.elapsed -= rec.duration;
      rec.fx = lib.createFx(mod, {
        x: rec.ox, y: rec.oy, seed: 3,
        palette: PAL[palName] || PAL.water, light: 1, flip: false, angle: 0
      });
    }
    rec.fx.update(step);
    lib.clearFrame(rec.frame);
    rec.fx.draw(rec.frame, 'back');
    rec.fx.draw(rec.frame, 'front');
    lib.composite(rec.frame, rec.img.data, null, 0.85);
    rec.c2.putImageData(rec.img, 0, 0);

    // 让贴花大致覆盖直径 2r：库的原尺寸是 w，所以按半径反推缩放
    const sc = o.radius > 0 ? (o.radius * 2) / rec.w * 1.12 : (o.scale || 0.5);
    // 锚点：贴地件按「中心」对位，立着的物件按 meta.origin（脚底）对位
    const ax = o.anchor === 'feet' ? rec.ox : rec.w / 2;
    const ay = o.anchor === 'feet' ? rec.oy : rec.h / 2;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = o.alpha === undefined ? 0.75 : o.alpha;
    ctx.translate(o.x, o.y);
    ctx.scale(sc, sc);
    ctx.drawImage(rec.canvas, -ax, -ay);
    ctx.restore();
    return true;
  };

  PROPS.decalCount = function () { return decals.size; };

  // ============================================================
  // 传送门（第二十八轮）
  // ============================================================
  // 坐标来自 shared/maps.js 的 buildPortals（纯函数），**不需要服务端下发** ——
  // 联机时客户端只拿一个 mapId 就能算出同样的两扇门。
  // ★判定在 sim 里（服务端权威），这里只负责画。
  const portalCache = Object.create(null);
  let portalMapId = '';

  PROPS.portals = function (mapId) {
    const id = mapId || '';
    if (portalMapId === id) return portalCache[id] || [];
    portalMapId = id;
    const maps = VS.MAPS;
    if (!maps || !maps.buildPortals) { portalCache[id] = []; return portalCache[id]; }
    portalCache[id] = maps.buildPortals(maps.mapById(id));
    return portalCache[id];
  };

  PROPS.drawPortals = function (ctx, mapId, view) {
    if (!PROPS.enabled) return 0;
    const list = PROPS.portals(mapId);
    if (!list.length) return 0;
    // 相机由渲染层传进来（不反向读渲染器内部状态：那层没有对外暴露 R）
    const camX = view && view.cam ? view.cam.x : 0;
    const camY = view && view.cam ? view.cam.y : 0;
    const vw = view && view.viewW ? view.viewW : 1920;
    const vh = view && view.viewH ? view.viewH : 1080;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const g = list[i];
      if (g.x < camX - 140 || g.x > camX + vw + 140) continue;
      if (g.y < camY - 160 || g.y > camY + vh + 160) continue;
      // 影子
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.beginPath();
      ctx.ellipse(g.x, g.y - 2, 34, 11, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      PROPS.drawDecal(ctx, {
        key: 'portal' + i,
        kind: 'rift',
        pal: 'gold',
        x: g.x, y: g.y,
        scale: 0.62,
        anchor: 'feet',
        alpha: 0.92,
        dt: view && view._animDt ? view._animDt : 0.016
      });
      n += 1;
    }
    return n;
  };

})(typeof window !== 'undefined' ? window : this);
