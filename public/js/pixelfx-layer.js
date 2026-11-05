/*!
 * 技能特效层：把 pixelfx 的低分辨率像素帧贴到游戏主 Canvas 上
 *
 * 上游 pixelfx 画的是「一整块像素缓冲区」（color + light 双缓冲），
 * 而本游戏是主 Canvas 直接按世界坐标画矢量图形。桥接办法是：
 *   每个特效模块共用一个离屏画布 → 每帧清空 → 让库把像素画进 frame →
 *   合成成带透明通道的 ImageData → putImageData → 再按世界坐标贴到主 Canvas。
 *
 * 为什么不用一整屏的 frame：游戏画面是 1920x1080 级别，每帧合成整屏像素太贵；
 * 特效自己的 meta.size 通常只有 100~300 像素，只合成那一小块就够了。
 *
 * 为什么要有 states（按实体缓存实例）：库里的一次性特效是「带粒子状态的模拟」，
 * 每帧新建实例就永远停在第一帧。而联机快照每帧都会重建 effect 对象，
 * 不能用 WeakMap 按对象缓存，所以用「稳定的实体键 + life 回升判新」来复用。
 *
 * 依赖：/vendor/pixelfx/pixelfx.js 必须排在本文件之前。
 */
(function (root) {
  'use strict';

  const lib = root.PixelFX;
  const VS = root.VS = root.VS || {};
  const PIX = VS.PixelFx = {};

  // 项目配色硬约定：暗红 / 琥珀金 / 冷灰，禁用紫与紫蓝。
  // 每条都是由暗到亮的色阶，库会自动重采样成各个特效默认调色板的长度。
  const PAL = {
    gold:  ['#241206', '#4a2a0c', '#7d4a12', '#b37418', '#e0a327', '#ffc94a', '#ffe89a', '#fff8dc'],
    steel: ['#10151a', '#232c34', '#3a4650', '#576672', '#7e8c98', '#aebbc6', '#dce6ee', '#ffffff'],
    ice:   ['#0a1720', '#123243', '#1c5370', '#2a7c9c', '#4aa6c4', '#84cfe2', '#c6edf6', '#ffffff'],
    fire:  ['#1f0b10', '#4a1118', '#8c1d1c', '#cc3a1a', '#f2701f', '#ffae35', '#ffe27a', '#fff8d6'],
    // 血红走纯暖橙红：只要掺一点蓝，在暗红地面 + lighter 叠加下就会泛出粉紫
    blood: ['#1a0806', '#3d0e08', '#6b130c', '#9c2412', '#cc3a18', '#f26a24', '#ffb04a', '#ffe6a0'],
  };
  PIX.PAL = PAL;

  // 库没加载好（或浏览器不支持 ImageData）时整体降级：draw 恒返回 false，
  // 调用方继续走原来那套轻量几何绘制，不会出现「特效没了」或白屏。
  PIX.ready = !!(lib && lib.effects && lib.createFrame && lib.createFx &&
    lib.clearFrame && lib.composite && root.document && root.ImageData);

  if (!PIX.ready) {
    PIX.begin = function () {};
    PIX.draw = function () { return false; };
    console.warn('[技能特效] pixelfx 未就绪，本次仍使用原有几何特效');
    return;
  }

  const surfaces = Object.create(null);  // 特效名 -> 离屏画布 / frame / ImageData
  const states = new Map();              // 实体键 -> 该次特效的动画实例
  let dt = 0.016;                        // 本帧真实时间步长（秒）
  let budget = 0;                        // 同屏像素特效数量上限，防止弹幕一多就掉帧
  let frameNo = 0;
  let redraw = true;                     // 本帧要不要重算像素（见下方隔帧合成）
  const MAX_PER_FRAME = 20;
  const debug = root.location && root.location.search.indexOf('debug=1') >= 0;
  let debugFrames = 0;
  let drawnLast = 0;

  // 由字符串生成一个稳定的小整数种子：同一种攻击每次形状一致，不同位置略有变化
  function seedOf(key) {
    let h = 7;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 9973;
    return h + 1;
  }

  // 每个特效模块只建一次离屏资源；尺寸和锚点都取库自己的 meta，不写死
  function surfaceOf(name) {
    if (surfaces[name]) return surfaces[name];
    const mod = lib.effects[name];
    if (!mod || !mod.meta) return null;
    const size = mod.meta.size || [136, 104];
    const origin = mod.meta.origin || [size[0] / 2, size[1] / 2];
    const w = Math.max(1, size[0] | 0), h = Math.max(1, size[1] | 0);
    const canvas = root.document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const c2 = canvas.getContext('2d');
    const s = {
      mod: mod,
      w: w, h: h,
      ox: origin[0], oy: origin[1],
      duration: Number(mod.meta.duration) > 0 ? Number(mod.meta.duration) : 1,
      frame: lib.createFrame(w, h, 0, 0),
      img: c2.createImageData(w, h),
      canvas: canvas,
      c2: c2,
    };
    surfaces[name] = s;
    return s;
  }

  // 每帧开头调一次：刷新时间步、重置绘制预算、清掉早就消失的特效状态
  PIX.begin = function (step) {
    dt = step > 0 ? Math.min(step, 0.05) : 0.016;
    budget = MAX_PER_FRAME;
    frameNo += 1;
    // 像素特效本来就是 30fps 的动画（库里 fps 全是 30），没必要每个渲染帧都重算一遍
    // 几十万像素：隔帧合成，中间帧直接复用离屏画布，只更新贴到主画布的位置与角度。
    redraw = frameNo % 2 === 1;
    const now = root.performance.now();
    for (const entry of states) {
      if (now - entry[1].touch > 1800) states.delete(entry[0]);
    }
    if (debug && ++debugFrames % 120 === 0) {
      console.log('[技能特效] 上一帧像素特效数=' + drawnLast + ' 活跃实例=' + states.size);
    }
    drawnLast = 0;
  };

  /**
   * 画一个技能特效；成功返回 true（调用方可以跳过原来的几何绘制），失败返回 false 走降级。
   * ctx      主 Canvas 的 2D 上下文（已处于「相机平移后」的世界坐标系）
   * name     库里的特效名，见 entry.js 的 effects
   * entityKey 稳定的实体键（同一发弹丸/同一次打击在整个生命周期里必须一致）
   * o        { x, y, angle, scale, alpha, life, maxLife, palette, light, flip, seed }
   */
  PIX.draw = function (ctx, name, entityKey, o) {
    if (budget <= 0) return false;
    const s = surfaceOf(name);
    if (!s) return false;

    const life = o.life || 0;
    const maxLife = Math.max(0.05, o.maxLife || life || 0.3);
    let rec = states.get(entityKey);
    let fresh = false;

    // life 是单调递减的；它突然回升就说明这是一次新的攻击，必须换一条时间轴
    if (!rec || rec.name !== name || life > rec.life + 0.002) {
      const initOpts = {
        x: s.ox,
        y: s.oy,
        seed: o.seed || seedOf(entityKey),
        palette: o.palette || PAL.gold,
        light: o.light === undefined ? 1 : o.light,
        flip: false,
        angle: 0,
      };
      // 有些效果自带第二组固定颜色（例如爆炸的石块 / 圣裁的碎石是紫灰），
      // 这里允许调用方覆盖成项目配色的暖灰，避免画面冒出紫蓝色。
      if (o.extra) Object.assign(initOpts, o.extra);
      rec = {
        name: name,
        life: life,
        touch: 0,
        fx: lib.createFx(s.mod, initOpts),
      };
      states.set(entityKey, rec);
      fresh = true;
      // 预热点：一次性特效往往先蓄力再爆发（落雷的粗闪电在 0.76s），
      // 游戏里一次打击只有 0.2~0.3s，不预跳就只能看到「乌云 + 余烬」。
      // 只在实例创建时执行一次，不增加每帧开销。
      if (o.warm > 0) rec.fx.update(o.warm);
    }
    rec.life = life;
    rec.touch = root.performance.now();

    const fx = rec.fx;
    fx.options.angle = o.angle || 0;
    fx.options.flip = !!o.flip;

    // 新实例必须立刻画一帧，否则隔帧复用的会是上一个特效留下的画面
    if (redraw || fresh) {
      // 库里的特效动辄 3~5 秒，游戏里一次打击只有 0.2~0.3 秒。
      // 把动画时长压进实体寿命里，才能在「闪一下」里看到起手、爆发和消散。
      // 上限压到 4：库内部按 120Hz 分步推进粒子，倍率越高每帧步数越多，
      // 弹幕一多就吃满 CPU。配合上面的预热点，4 倍已经能在「一瞬间」里
      // 走完爆发到消散，不必真的把 5 秒的库动画全放完。
      const rate = Math.min(4, Math.max(1, s.duration / maxLife));
      fx.update(dt * rate * (redraw ? 2 : 1));

      lib.clearFrame(s.frame);
      fx.draw(s.frame, 'back');
      fx.draw(s.frame, 'front');
      lib.composite(s.frame, s.img.data, null, o.light === undefined ? 1 : o.light);
      s.c2.putImageData(s.img, 0, 0);
    }

    const prevAlpha = ctx.globalAlpha;
    const sc = o.scale > 0 ? o.scale : 1;
    const fade = o.alpha === undefined ? Math.min(1, (life / maxLife) * 1.5) : o.alpha;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(sc, sc);
    // ★加法混合是这套战场的老规矩（原来画爆炸/刀光就用 lighter）：
    //   pixelfx 的 color 缓冲里有乌云、焦痕、烟这类不透明深色像素，
    //   直接 source-over 贴上去会在暗红地面上压出一坨黑饼；
    //   改成 lighter 后暗部几乎不显、只有发光轮廓被加上去，才像「技能」而不是贴纸。
    ctx.globalCompositeOperation = o.blend || 'lighter';
    ctx.globalAlpha = prevAlpha * Math.max(0, Math.min(1, fade));
    ctx.drawImage(s.canvas, -s.ox, -s.oy);
    ctx.restore();

    budget -= 1;
    drawnLast += 1;
    return true;
  };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // 稳定实体键：联机快照每帧都会重建 effect 对象，所以不能拿对象当键；
  // 位置量化到 8 像素，配上种类 / 半径 / 时长，足以区分同屏的不同打击。
  function effectKey(e) {
    return 'e|' + e.kind + '|' + Math.round((e.x || 0) / 8) + '|' +
      Math.round((e.y || 0) / 8) + '|' + Math.round(e.r || 0) + '|' + (e.maxLife || 0);
  }

  /**
   * 把一次打击（w.effects 里的一项）匹配成合适的技能特效。
   * 只认快照里确实会传过来的字段（kind / r / facing / color / life / maxLife），
   * ★不往协议里加字段，单机与联机看到的就是同一套效果。
   * 返回 null 表示该走原来的几何绘制。
   */
  PIX.effectFor = function (e) {
    const life = e.life || 0;
    const maxLife = e.maxLife || life || 0.3;
    const key = effectKey(e);
    const base = {
      x: e.x, y: e.y,
      life: life, maxLife: maxLife,
      alpha: Math.min(1, (life / maxLife) * 1.6),
      light: 1,
    };

    if (e.kind === 'arc') {
      // 刑天干戚 / 血鞭：普通是冷钢色刀光，进化成血红就是大开大合的重斩
      const blood = e.color === '#ff4d4d';
      return {
        name: blood ? 'cleave' : 'slash', key: key,
        o: {
          x: base.x, y: base.y, life: life, maxLife: maxLife, alpha: base.alpha,
          angle: e.facing || 0, scale: clamp((e.r || 60) / 58, 0.9, 2.1),
          palette: blood ? PAL.blood : PAL.steel, light: 1.15,
          warm: blood ? 0.3 : 0.06,
          extra: blood ? { stone: '#5a5148' } : null,
        },
      };
    }

    if (e.kind === 'boom') {
      // 雷部神锤 / 五雷正法落成的是金色雷击，陨星那种橙色才是爆炸，其余按圣裁光柱。
      // ★大画布的爆炸要把 scale 压小：原尺寸 300x240 会糊住半个战场，
      //   而且每帧合成 7 万像素，弹幕一多就掉帧。
      const gold = e.color === '#ffcf5c' || e.color === '#fff3b0' || e.color === '#ffd166';
      const orange = e.color === '#ff9f45' || e.color === '#ff8c42';
      const name = gold ? 'lightning' : orange ? 'boom' : 'smite';
      const scale = gold ? clamp((e.r || 60) / 110, 0.45, 1)
        : orange ? clamp((e.r || 60) / 170, 0.3, 0.65)
          : clamp((e.r || 60) / 140, 0.4, 0.85);
      return {
        name: name, key: key,
        o: {
          x: base.x, y: base.y, life: life, maxLife: maxLife, alpha: base.alpha,
          scale: scale,
          palette: orange ? PAL.fire : PAL.gold, light: 1.15,
          warm: gold ? 0.45 : orange ? 0.05 : 0.4,
          // 落雷自带 PLASMA 火花色阶（偏紫蓝），石块色也是紫灰，都换成项目暖色
          extra: { stone: '#5a5148', sparks: PAL.gold },
        },
      };
    }

    if (e.kind === 'ring') {
      // 光环一律用金色符文阵：透视圆盘贴地、尺寸克制，不会像霜新星那样
      // 横着铺出一个压住玩家的大椭圆。
      return {
        name: 'rune', key: key,
        o: {
          x: base.x, y: base.y, life: life, maxLife: maxLife, alpha: base.alpha,
          scale: clamp((e.r || 60) / 90, 0.65, 1.5),
          palette: PAL.gold, light: 1,
          warm: 0.2,
        },
      };
    }

    // 死亡与受击：短促的命中火花，别抢走主技能的戏
    if (e.kind === 'death' || e.kind === 'hitplayer') {
      return {
        name: 'spark', key: key,
        o: {
          x: base.x, y: base.y, life: life, maxLife: maxLife, alpha: base.alpha,
          scale: e.kind === 'death' ? 0.4 : 0.55,
          palette: PAL.blood, light: 0.95,
          warm: 0.02,
        },
      };
    }
    return null;
  };

  /**
   * 把一发弹丸匹配成飞行类技能特效。x/y 传插值后的位置，angle 按速度方向。
   * 弹丸是循环特效，maxLife 给一个固定值：它只用来把库的动画时长压到合适速度，
   * 不能拿 p.life（会一路递减，动画越跑越快）。
   */
  PIX.projectileFor = function (p, x, y) {
    const angle = Math.atan2(p.vy || 0, p.vx || 0);
    const key = 'p|' + (p.id !== undefined ? p.id : Math.round(x) + '_' + Math.round(y));
    const base = {
      x: x, y: y, angle: angle,
      life: p.life || 0.8, maxLife: 0.8, alpha: 1, light: 1.05,
    };

    if (p.kind === 'line') {
      // 陨星巨岩是橙红火球，其余直线弹（定海神钉 / 万剑诀 / 幽冥锁链）是冷钢冰枪
      const hot = p.color === '#ff8c42';
      return {
        name: hot ? 'fireball' : 'iceLance', key: key,
        o: {
          x: x, y: y, angle: angle, life: base.life, maxLife: 0.8, alpha: 1,
          scale: hot ? 0.75 : 0.8, palette: hot ? PAL.fire : PAL.ice, light: 1.25,
        },
      };
    }

    if (p.kind === 'homing') {
      // 引魂珠 / 北斗星陨：奥术球，用琥珀金替掉库里默认的紫
      return {
        name: 'orb', key: key,
        o: {
          x: x, y: y, angle: angle, life: base.life, maxLife: 0.8, alpha: 1,
          scale: 0.62, palette: PAL.gold, light: 1.2,
        },
      };
    }

    if (p.kind === 'boomerang') {
      return {
        name: 'disc', key: key,
        o: {
          x: x, y: y, angle: angle, life: base.life, maxLife: 0.8, alpha: 1,
          scale: 0.56, palette: PAL.gold, light: 1.2,
        },
      };
    }

    if (p.kind === 'parabola') {
      return {
        name: 'fireball', key: key,
        o: {
          x: x, y: y, angle: angle, life: base.life, maxLife: 0.8, alpha: 1,
          scale: 0.8, palette: PAL.fire, light: 1.2,
        },
      };
    }

    // 其余（骨刺等）：小小的奥术球，至少比纯色圆点像「技能」
    return {
      name: 'orb', key: key,
      o: {
        x: x, y: y, angle: angle, life: base.life, maxLife: 0.8, alpha: 1,
        scale: 0.42, palette: PAL.gold, light: 1.1,
      },
    };
  };

  PIX.stats = function () {
    return { maxPerFrame: MAX_PER_FRAME, activeInstances: states.size, drawnLastFrame: drawnLast };
  };
})(window);
