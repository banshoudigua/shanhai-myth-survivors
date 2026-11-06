// 用 jsfxr（Unlicense）程序化生成全套 8-bit 音效，产物落在 public/audio/*.wav。
// 运行：node tools/gen-sfx.js
//
// ★这些音色是「参数」，不是素材文件：没有外部版权、没有素材网站、没有配音，
//   改一个数字就能重新生成，公开仓库里也只有这份可复现的参数表。
//   上游 sfxr.js 里的 RIFFWAVE 编码器是 GPL v2，不进本仓库，改用 tools/wav-compat.js。
// ★音效参数刻意固定，不用上游 preset 里的随机数 —— 每次生成的 wav 必须逐字节一致，
//   否则发布前后 MD5 对不上，也没法判断线上是不是同一版。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { RIFFWAVE } = require('./wav-compat.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'audio');
const SRC = path.join(ROOT, 'tools', 'vendor', 'sfxr.js');

// sfxr.js 是老式全局脚本：给它一个干净的沙箱，把顶层 var 变成可取回的全局。
// ★噪声类音效内部用 Math.random 填噪声缓冲；不固定种子的话，每次重新生成
//   wav 内容都不一样，发布前后 MD5 就失去意义。这里塞一个确定性 LCG。
let rngState = 20261106;
const seededMath = Object.create(Math);
seededMath.random = function () {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 4294967296;
};
const sandbox = {
  Math: seededMath, Array: Array, RIFFWAVE: RIFFWAVE,
  console: console, masterVolume: 1,
};
vm.runInNewContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: 'sfxr.js' });
const Knobs = sandbox.Knobs;
const SoundEffect = sandbox.SoundEffect;
const SQUARE = sandbox.SQUARE, SAWTOOTH = sandbox.SAWTOOTH,
  SINE = sandbox.SINE, NOISE = sandbox.NOISE;

const BASE = { sampleRate: 22050, sampleSize: 16, gain: -18, lowPassSweep: 1 };

// 每项：形状 / 起音 / 频率走向 / 音量。name 同时是运行时 VS.Sfx.play(name) 的名字。
const SFX = {
  // —— 战斗：短、脆、不抢戏（同一秒可能触发十几次，必须能叠加而不糊） ——
  slash:     { shape: SAWTOOTH, frequency: 900, frequencySlide: -2600, sustain: 0.012, decay: 0.075, punch: 0.4, highPassFrequency: 300, gain: -20 },
  hit:       { shape: NOISE, frequency: 1200, frequencySlide: -900, sustain: 0.015, decay: 0.06, gain: -22 },
  kill:      { shape: SQUARE, frequency: 320, frequencySlide: -1500, sustain: 0.03, decay: 0.12, gain: -20 },
  hurt:      { shape: SAWTOOTH, frequency: 240, frequencySlide: -700, sustain: 0.05, decay: 0.20, lowPassFrequency: 1800, gain: -15 },
  lightning: { shape: NOISE, frequency: 2600, frequencySlide: -1800, sustain: 0.04, decay: 0.20, highPassFrequency: 600, gain: -21 },
  boom:      { shape: NOISE, frequency: 320, frequencySlide: -700, sustain: 0.08, decay: 0.28, lowPassFrequency: 2400, gain: -18 },

  // —— 反馈：拾取/升级/开箱/买东西，走明亮上行的方波 ——
  pickup:    { shape: SQUARE, frequency: 760, arpeggioFactor: 0.62, arpeggioDelay: 0.055, sustain: 0.02, decay: 0.09, gain: -22 },
  levelup:   { shape: SQUARE, frequency: 520, arpeggioFactor: 0.79, arpeggioDelay: 0.075, sustain: 0.06, decay: 0.28, gain: -19 },
  chest:     { shape: SQUARE, frequency: 660, arpeggioFactor: 0.75, arpeggioDelay: 0.09, sustain: 0.06, decay: 0.22, gain: -19 },
  buy:       { shape: SQUARE, frequency: 1180, arpeggioFactor: 0.80, arpeggioDelay: 0.045, sustain: 0.015, decay: 0.09, gain: -22 },
  select:    { shape: SQUARE, frequency: 620, sustain: 0.008, decay: 0.035, gain: -26 },
  story:     { shape: SINE, frequency: 880, sustain: 0.02, decay: 0.12, gain: -26 },

  // —— 局势：低频、长一点，让人抬头看屏幕 ——
  boss:      { shape: SAWTOOTH, frequency: 130, frequencySlide: 240, attack: 0.05, sustain: 0.28, decay: 0.35, vibratoDepth: 0.15, vibratoRate: 6, lowPassFrequency: 1200, gain: -15 },
  win:       { shape: SQUARE, frequency: 392, arpeggioFactor: 0.75, arpeggioDelay: 0.11, sustain: 0.12, decay: 0.36, gain: -18 },
  lose:      { shape: SAWTOOTH, frequency: 380, frequencySlide: -900, attack: 0.02, sustain: 0.16, decay: 0.34, gain: -18 },
};

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0, bytes = 0;
for (const name of Object.keys(SFX)) {
  const knobs = new Knobs(Object.assign({}, BASE, SFX[name]));
  const wave = new SoundEffect(knobs).generate();
  if (!wave || !wave.dataURI || wave.dataURI.indexOf('base64,') < 0) {
    console.log('  ✗ ' + name + ' 生成失败');
    fail++;
    continue;
  }
  const buf = Buffer.from(wave.dataURI.slice(wave.dataURI.indexOf('base64,') + 7), 'base64');
  const sec = (buf.length - 44) / (BASE.sampleRate * 2);
  // 峰值归一化：sfxr 的 gain 单位是 dB，但各波形的实际幅度差好几倍，
  //   不归一的话「挥砍」震耳朵、「选择」听不见。统一到 -7dB 左右，
  //   运行时就只需要一个总音量开关。
  let rawPeak = 0, nonzero = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const a = Math.abs(buf.readInt16LE(i));
    if (a > 0) nonzero++;
    if (a > rawPeak) rawPeak = a;
  }
  const scale = rawPeak > 0 ? 14000 / rawPeak : 1;
  let peak = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * scale)));
    buf.writeInt16LE(v, i);
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const ok = buf.length > 128 && sec > 0.02 && sec < 1.2 && nonzero > 40 && peak > 10000 && peak <= 16000;
  if (ok) pass++; else fail++;
  fs.writeFileSync(path.join(OUT, name + '.wav'), buf);
  bytes += buf.length;
  console.log('  ' + (ok ? '✓' : '✗') + ' ' + name.padEnd(10) +
    ' ' + String(buf.length).padStart(6) + ' B  ' + sec.toFixed(3) + 's' +
    '  peak=' + peak + '  削波=' + (wave.clipping || 0));
}

// 清单给运行时用：漏一个音效文件，浏览器里就是一次静默的 404
fs.writeFileSync(path.join(OUT, 'sfx.json'), JSON.stringify(Object.keys(SFX), null, 2) + '\n');

console.log('\n生成 ' + pass + ' 个 / 失败 ' + fail + ' 个，合计 ' + (bytes / 1024).toFixed(1) + ' KB → public/audio/');
if (fail > 0) process.exit(1);
