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
};

window.PixelFX = {
  version: "0.3.0",
  createFrame,
  clearFrame,
  createFx,
  composite,
  resolveOptions,
  effects,
};
