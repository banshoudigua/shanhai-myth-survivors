// 极简 WAV 编码器（本文件为本游戏自写，不属于任何第三方库）。
//
// ★为什么不用上游的 riffwave.js：grumdrig/jsfxr 仓库里那份 riffwave.js 是 GPL v2，
//   本项目是公开仓库，把 GPL 代码带进去会有传染风险。jsfxr 的合成器本体是
//   Unlicense（公有领域），只依赖一个名为 RIFFWAVE 的编码类；这里写一个接口兼容的
//   最小实现替换它，生成的音频是我们自己的程序化产物，不承担任何第三方许可义务。
//
// 接口（与 sfxr.js 的调用方式一致）：
//   var wave = new RIFFWAVE();
//   wave.header.sampleRate = 22050;
//   wave.header.bitsPerSample = 16;
//   wave.Make(byteArray);           // 8 位是 unsigned 0..255，16 位是 little-endian 有符号
//   wave.dataURI                    // data:audio/wav;base64,...

'use strict';

function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
function u32(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]; }

function RIFFWAVE(data) {
  this.data = [];
  this.wav = [];
  this.dataURI = '';
  this.header = {
    sampleRate: 22050,
    bitsPerSample: 16,
    numChannels: 1,
  };
  if (Array.isArray(data)) this.Make(data);
}

RIFFWAVE.prototype.Make = function (data) {
  // ★sfxr.js 跑在 vm 沙箱里，它造的数组属于另一个 realm：
  //   这里用 instanceof Array 会判成 false，结果只写出 44 字节的 WAV 头（静音文件）。
  //   Array.isArray 跨 realm 有效，别改回 instanceof。
  if (Array.isArray(data)) this.data = data;
  const h = this.header;
  const bytesPerSample = h.bitsPerSample >> 3;
  const blockAlign = h.numChannels * bytesPerSample;
  const byteRate = h.sampleRate * blockAlign;
  const dataLen = this.data.length;

  this.wav = [0x52, 0x49, 0x46, 0x46]           // "RIFF"
    .concat(u32(36 + dataLen))
    .concat([0x57, 0x41, 0x56, 0x45])           // "WAVE"
    .concat([0x66, 0x6D, 0x74, 0x20])           // "fmt "
    .concat(u32(16))
    .concat(u16(1))                              // PCM
    .concat(u16(h.numChannels))
    .concat(u32(h.sampleRate))
    .concat(u32(byteRate))
    .concat(u16(blockAlign))
    .concat(u16(h.bitsPerSample))
    .concat([0x64, 0x61, 0x74, 0x61])           // "data"
    .concat(u32(dataLen))
    .concat(this.data);

  this.dataURI = 'data:audio/wav;base64,' + Buffer.from(this.wav).toString('base64');
};

module.exports = { RIFFWAVE: RIFFWAVE };
