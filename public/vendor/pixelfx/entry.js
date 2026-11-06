/*!
 * pixelfx — 244 code-drawn pixel art effects
 * https://github.com/patch-gg/pixelfx  (v0.3.0)
 * MIT License. Copyright (c) 2026 Patch; portions Copyright (c) 2026 Hugo Duprez.
 * 完整许可见同目录 LICENSE 与 NOTICE.md。
 *
 * 本项目是普通 <script> 全局脚本、不走打包器、也不走 CDN，
 * 所以这里只挑游戏用得到的特效，导出成一个挂在 window 上的对象，
 * 再由 bun build 打成单个 IIFE 文件（pixelfx.js）供 game.html 直接引用。
 * src/ 下的文件全部是上游原样拷贝，没有改动。
 */
import { createFrame, clearFrame, createFx, composite, resolveOptions } from "./src/core/fx.js";
// 角色动作时序：官方推荐「有自己的角色就读 act 这份纯数据」，见 README 的 acting 一节。
// ★只借时序，不用它的 24×38 灰色假人渲染（本项目是 16×16 Q 版点阵，尺寸与朝向都不兼容），
//   所以这里没有导出 createAct —— 免得把整套骨架渲染代码也打进产物。
import { actTiming, poseAt, lerpPose, STAND } from "./src/core/act.js";

import * as swordSlash from "./src/fx/melee/sword-slash.js";
import * as heavyCleave from "./src/fx/melee/heavy-cleave.js";
import * as fireball from "./src/fx/fire/fireball.js";
import * as meteor from "./src/fx/fire/meteor.js";
import * as iceLance from "./src/fx/ice/ice-lance.js";
import * as frostNova from "./src/fx/ice/frost-nova.js";
import * as lightningStrike from "./src/fx/lightning/lightning-strike.js";
import * as chainLightning from "./src/fx/lightning/chain-lightning.js";
import * as arcaneOrb from "./src/fx/arcane/arcane-orb.js";
import * as runeCircle from "./src/fx/arcane/rune-circle.js";
import * as hitSpark from "./src/fx/impacts/hit-spark.js";
import * as smallExplosion from "./src/fx/explosions/small-explosion.js";
import * as holySmite from "./src/fx/holy/smite.js";
import * as earthSpike from "./src/fx/nature/earth-spike.js";
import * as poisonCloud from "./src/fx/nature/poison-cloud.js";
import * as energyDisc from "./src/fx/projectiles/energy-disc.js";
import * as shadowFlames from "./src/fx/shadow/shadow-flames.js";
import * as waterOrb from "./src/fx/water/water-orb.js";

// —— 场景物件（第二十八轮）：这些是「原位常驻」的效果，形态本身就是摆在地图上的东西。
//    ★它们和技能特效的用法不同：不能用加法混合（铁架/石池/木柴不发光，会被吃掉）、
//      不能压时长、不能随寿命淡出 —— 见 public/js/pixelfx-layer.js 的 drawProp。
import * as brazier from "./src/fx/fire/brazier.js";
import * as campfire from "./src/fx/fire/campfire.js";
import * as candle from "./src/fx/fire/candle.js";
import * as torch from "./src/fx/fire/torch.js";
import * as spiritFlame from "./src/fx/fire/spirit-flame.js";
import * as fountain from "./src/fx/water/fountain.js";
import * as waterfall from "./src/fx/water/waterfall.js";
import * as ripples from "./src/fx/water/ripples.js";
import * as toxicPuddle from "./src/fx/nature/toxic-puddle.js";
import * as portal from "./src/fx/arcane/portal.js";
import * as plasmaBall from "./src/fx/lightning/plasma-ball.js";
import * as teslaCoil from "./src/fx/lightning/tesla-coil.js";

// 键名就是游戏侧引用的技能特效名，改动这里要同步改 public/js/pixelfx-layer.js 的调用
const effects = {
  slash: swordSlash,
  cleave: heavyCleave,
  fireball: fireball,
  meteor: meteor,
  iceLance: iceLance,
  frostNova: frostNova,
  lightning: lightningStrike,
  chain: chainLightning,
  orb: arcaneOrb,
  rune: runeCircle,
  spark: hitSpark,
  boom: smallExplosion,
  smite: holySmite,
  spike: earthSpike,
  poison: poisonCloud,
  disc: energyDisc,
  shadow: shadowFlames,
  water: waterOrb,
  // 场景物件（常驻 loop，见上方注释）
  brazier: brazier,
  campfire: campfire,
  candle: candle,
  torch: torch,
  spirit: spiritFlame,
  fountain: fountain,
  waterfall: waterfall,
  ripples: ripples,
  puddle: toxicPuddle,
  rift: portal,
  lamp: plasmaBall,
  coil: teslaCoil,
};

// 四种招式的动作数据与已算好的时序。★在入口就把 actTiming 算完挂上，
// 调用方直接拿 acts.slash.timing 用，不必自己把「效果名」和「动作名」配对
// （两边键名并不完全一致，配错了会静默拿到 null）。
const acts = {
  slash: { data: swordSlash.act, timing: actTiming(swordSlash) },
  cleave: { data: heavyCleave.act, timing: actTiming(heavyCleave) },
  lightning: { data: chainLightning.act, timing: actTiming(chainLightning) },
  frost: { data: frostNova.act, timing: actTiming(frostNova) },
};

window.PixelFX = {
  version: "0.3.0",
  createFrame,
  clearFrame,
  createFx,
  composite,
  resolveOptions,
  effects,
  // 官方读取动作时序的 API：actTiming(effects.slash) → { windup, recovery, hits:[{t,freeze,shake}], poses }
  actTiming,
  poseAt,
  lerpPose,
  STAND,
  acts,
};
