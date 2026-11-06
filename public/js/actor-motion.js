/*!
 * 角色动作状态机 —— 让 16×16 点阵小人与怪物「会动」
 *
 * 数据来源：pixelfx 的 act 时序（window.PixelFX.acts.*.timing，官方 actTiming 的结果）。
 * 上游那套是给 24×38 假人写完整招式的（起手 0.42~0.55 秒、命中定格 0.14~0.2 秒），
 * 本游戏是自动开火、一次打击只有 0.18~0.3 秒，照搬会变成「举着武器不动」，
 * 所以这里只借它的**节奏形状**（起手 / 命中 / 收招的比例与 freeze、shake），
 * 数值按下面的 K 压缩到本游戏的节拍里。
 *
 * ★★三条不能破的边界：
 *   ① 纯表现层：只由 render.js 的动画帧调用，绝不改 sim 的 dt、不暂停世界。
 *      联机时「世界停不下来」，真·全局 hit-stop 会让两端对不上，是项目明令禁止的。
 *      这里的「定格」= 冻结**角色动画时钟**，世界照常跑。
 *   ② 不进快照：姿态由渲染层按本地时钟推导，一个字段都不往协议里加。
 *   ③ 每帧仍然只 drawImage：帧是预烘焙好的离屏画布，这里只返回一个 0/1/2 的序号。
 *
 * 依赖：/vendor/pixelfx/pixelfx.js 先加载；库缺失时自动退回内置的兜底节奏，不会白屏。
 */
(function (root) {
  'use strict';

  const VS = root.VS = root.VS || {};
  const AM = VS.ActorMotion = {};

  // 三帧：0 站姿 / 1 迈步或蓄力（压低） / 2 挥出（前冲压扁）
  const FRAME = { IDLE: 0, STEP: 1, STRIKE: 2 };
  AM.FRAME = FRAME;

  // 上游时序 → 本游戏节拍的压缩系数
  const K = { windup: 0.22, freeze: 0.55, strike: 0.09, recovery: 0.16 };
  // 库没加载好时的兜底节奏（数值仍按「一瞬间」标定）
  const FALLBACK = { windup: 0.1, recovery: 0.16, hits: [{ freeze: 0.11, shake: 0.12, amp: 1.5 }] };

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function hash(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
    return h / 97;
  }

  function timingOf(kind) {
    const lib = root.PixelFX;
    if (!lib || !lib.acts) return FALLBACK;
    const entry = lib.acts[kind] || lib.acts.slash;
    return (entry && entry.timing) || FALLBACK;
  }

  let clock = 0;             // 角色动画时钟（定格时不推进）
  let freezeLeft = 0;        // 命中定格剩余秒数
  let shakeLeft = 0;         // 镜头微抖剩余秒数
  let shakeAmp = 0;
  const attacks = new Map(); // 角色键 -> 一次攻击的播放状态
  let punches = 0;
  let freezes = 0;

  /** 每帧开头调一次。dt 是渲染帧的真实间隔；定格期间只消耗定格时间，不推进 clock。 */
  AM.begin = function (dt) {
    const step = dt > 0 ? Math.min(dt, 0.05) : 0;
    if (freezeLeft > 0) {
      freezeLeft = Math.max(0, freezeLeft - step);
      shakeLeft = Math.max(0, shakeLeft - step);
      return;
    }
    clock += step;
    shakeLeft = Math.max(0, shakeLeft - step);
    // 绝大多数帧没有任何攻击在播，别每帧都去创建一次 Map 迭代器
    if (attacks.size === 0) return;
    for (const entry of attacks) {
      const a = entry[1];
      a.t += step;
      if (!a.fired && a.t >= a.hitAt) {
        a.fired = true;
        freezeLeft = Math.max(freezeLeft, a.freeze);
        shakeLeft = Math.max(shakeLeft, a.shake);
        shakeAmp = Math.max(shakeAmp, a.amp);
        freezes += 1;
      }
      if (a.t >= a.windup + a.strike + a.recovery) attacks.delete(entry[0]);
    }
  };

  /** 一次攻击开始：kind 对应 PixelFX.acts 的键（slash / cleave / lightning / frost）。 */
  AM.punch = function (key, kind) {
    const t = timingOf(kind);
    const hit = (t.hits && t.hits[0]) || {};
    const windup = clamp((t.windup || 0.1) * K.windup, 0.06, 0.14);
    const freeze = clamp((hit.freeze || 0.1) * K.freeze, 0.035, 0.09);
    const recovery = clamp((t.recovery || 0) + K.recovery, 0.12, 0.24);
    attacks.set(key, {
      t: 0,
      windup: windup,
      strike: K.strike,
      recovery: recovery,
      hitAt: windup + K.strike * 0.5,
      freeze: freeze,
      shake: clamp(hit.shake || 0, 0, 0.18),
      amp: clamp(hit.amp || 0, 0, 2.5),
      fired: false,
    });
    punches += 1;
    return true;
  };

  /** 当前该画第几帧。moving 由渲染层按「位置有没有变」传入，仍然不读输入状态。 */
  AM.poseOf = function (key, moving) {
    const a = attacks.get(key);
    if (a) {
      if (a.t < a.windup) return FRAME.STEP;                       // 起手：压低蓄力
      if (a.t < a.windup + a.strike) return FRAME.STRIKE;          // 挥出
      return FRAME.STEP;                                           // 收招
    }
    const ph = clock * (moving ? 9 : 2.4) + hash(key);
    if (moving) return Math.floor(ph) % 2 ? FRAME.STEP : FRAME.IDLE;
    return Math.sin(ph) > 0.55 ? FRAME.STEP : FRAME.IDLE;          // 站着偶尔呼吸一下
  };

  /** 怪物的两帧起伏：按 id 错开相位，避免一屏怪整齐地一起呼吸。定格时 clock 不动，自然定住。 */
  AM.mobWobble = function (id) {
    return Math.floor(clock * 6 + (Number(id) || 0) % 7 * 0.41) % 2;
  };

  /** 命中瞬间的镜头微抖（像素为单位），用真实时间驱动，定格期间照样衰减。 */
  AM.shake = function () {
    if (shakeLeft <= 0 || shakeAmp <= 0) return [0, 0];
    const now = root.performance ? root.performance.now() : Date.now();
    const k = clamp(shakeLeft / 0.18, 0, 1);
    // ★取整到整像素：小数 translate 会让整个世界层落在半像素上，
    //   几百只怪的 drawImage 全部退化成缩放采样，实测多花 10ms 以上。
    return [
      Math.round(Math.sin(now * 0.09) * shakeAmp * k),
      Math.round(Math.cos(now * 0.11) * shakeAmp * k * 0.6),
    ];
  };

  AM.stats = function () {
    return {
      clock: Math.round(clock * 1000) / 1000,
      freezeLeft: Math.round(freezeLeft * 1000) / 1000,
      shakeLeft: Math.round(shakeLeft * 1000) / 1000,
      activeAttacks: attacks.size,
      punches: punches,
      freezes: freezes,
    };
  };

  // 测试用：把状态清零，不碰任何外部世界
  AM.reset = function () {
    clock = 0; freezeLeft = 0; shakeLeft = 0; shakeAmp = 0;
    attacks.clear(); punches = 0; freezes = 0;
  };
})(window);
