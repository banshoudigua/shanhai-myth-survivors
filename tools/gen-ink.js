// 把《补天纪》的剧情节拍编译成 Ink 运行时数据。跑：node tools/gen-ink.js
//
// ★为什么要有这一步（第二十五轮 · ③）
//   《补天纪》的 6 关 × 3 句节拍本来是 shared/campaign.js 里的数组，
//   sim 按时间把句子推成事件、界面整行淡入 —— 线性、没有分支能力。
//   把节拍交给 Ink 之后，剧情变成**纯数据**：以后要加分支 / 条件 / 变量，
//   改 .ink 重新编译即可，不用碰模拟层和快照协议。
//   本轮只搬数据、**不改一句文案、不加任何分支**，剧情内容与顺序保持原样。
//
// ★编译器与运行时必须同版本：tools/vendor/ink-full.js（含 Compiler）与
//   public/vendor/story/ink.js（运行时）都取自 inkjs 2.4.0，
//   否则 ToJson 的容器格式可能不被运行时识别。

'use strict';

const fs = require('fs');
const path = require('path');
const CP = require('../shared/campaign.js');
const InkFull = require('./vendor/ink-full.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'story');
const mod = CP.MODS.myth;
const stages = mod.stages || [];

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

// Ink 的控制字符：文案里出现这些会被引擎当成语法而不是文字，
//   宁可生成失败也不能静默丢字（剧情文案丢一个破折号很难在截图里发现）。
function inkUnsafe(s) {
  return /(^|\s)(\/\/|->|\*\+)|[{}[\]<>~]|^\s*[+*]/.test(s);
}

const lines = [];
lines.push('// 《补天纪》剧情节拍 —— 由 tools/gen-ink.js 从 shared/campaign.js 生成，请勿手改。');
lines.push('// 每章对应一关，每句对应一个原始 beat；当前全部保持线性，未加分支。');
lines.push('');
stages.forEach(function (st, i) {
  lines.push('=== chapter_' + (i + 1) + ' ===');
  (st.beats || []).forEach(function (b) { lines.push(b.text); });
  lines.push('-> END');
  lines.push('');
});
const ink = lines.join('\n');

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'butian.ink'), ink, 'utf8');

const bad = [];
stages.forEach(function (st) {
  (st.beats || []).forEach(function (b) { if (inkUnsafe(b.text)) bad.push(b.text); });
});
expect('文案里没有会被 Ink 误判的控制字符', bad.length === 0, bad.join(' | '));

const json = new InkFull.Compiler(ink).Compile().ToJson();
fs.writeFileSync(path.join(OUT, 'butian.ink.json'), json, 'utf8');

// ★编译完必须用**运行时**逐章逐句读回来比对，光「编译没报错」不能证明没丢字。
// ★每章用一个全新 Story：ChoosePathString 没有可靠的布尔返回值（实测是 undefined），
//   拿它判断「章节存不存在」会假失败；共用实例还会把上一章的指针状态带进来。
let chapters = 0, totalLines = 0, mismatch = [];
stages.forEach(function (st, i) {
  const name = 'chapter_' + (i + 1);
  const story = new InkFull.Story(json);
  story.ChoosePathString(name);
  const got = [];
  let guard = 0;
  while (story.canContinue && guard++ < 40) got.push(story.Continue().trim());
  const want = (st.beats || []).map(function (b) { return b.text.trim(); });
  totalLines += got.length;
  if (got.length) chapters++;
  if (got.join('|') !== want.join('|')) mismatch.push(name + ' 得到 ' + JSON.stringify(got) + ' 期望 ' + JSON.stringify(want));
});
expect('6 章都能被运行时定位', chapters === stages.length && stages.length === 6, chapters + '/' + stages.length);
expect('★18 句文案逐字一致（编译没丢字、没改序）', mismatch.length === 0 && totalLines === 18,
  mismatch.join(' ; ') + ' 共 ' + totalLines + ' 句');
expect('JSON 体积适合前端加载（minified 后 1KB 内）', json.length > 300 && json.length < 60000, json.length + ' B');

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败 → public/story/butian.ink + .ink.json');
if (fail > 0) process.exit(1);
