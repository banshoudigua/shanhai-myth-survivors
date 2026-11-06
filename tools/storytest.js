// 剧情运行时回归（Ink 数据 + 浏览器侧 Storylines）。跑：node tools/storytest.js
// ★重点是「编译出来的句子与 campaign.js 原文逐字一致」和「加载失败不白屏」。

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CP = require('../shared/campaign.js');

let pass = 0, fail = 0;
function expect(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}

function makeEnv(opt) {
  opt = opt || {};
  const ctx = {
    console: console, Promise: Promise, JSON: JSON,
    inkjs: opt.noInk ? undefined : loadRuntime(),
    fetch: opt.noFetch ? undefined : function () {
      if (opt.fetchFail) return Promise.reject(new Error('offline'));
      return Promise.resolve({
        ok: !opt.httpFail,
        json: function () { return Promise.resolve(JSON.parse(fs.readFileSync(
          path.join(ROOT, 'public/story/butian.ink.json'), 'utf8'))); }
      });
    },
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/js/storylines.js'), 'utf8'),
    ctx, { filename: 'storylines.js', timeout: 5000 });
  return { ctx: ctx, S: ctx.VS.Storylines };
}

let _runtime = null;
function loadRuntime() {
  if (_runtime) return _runtime;
  const s = { console: console };
  s.window = s; s.self = s; s.globalThis = s;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'public/vendor/story/ink.js'), 'utf8'),
    s, { filename: 'ink.js', timeout: 5000 });
  _runtime = s.inkjs;
  return _runtime;
}

(async function () {
  console.log('=== 剧情运行时（inkjs） ===');

  const stages = CP.MODS.myth.stages || [];
  const want = stages.map(s => (s.beats || []).map(b => b.text.trim()));

  expect('产物 butian.ink 存在', fs.existsSync(path.join(ROOT, 'public/story/butian.ink')));
  expect('产物 butian.ink.json 存在', fs.existsSync(path.join(ROOT, 'public/story/butian.ink.json')));
  const inkSrc = fs.readFileSync(path.join(ROOT, 'public/story/butian.ink'), 'utf8');
  expect('Ink 源里有 6 个章节 knot', (inkSrc.match(/^=== chapter_\d+ ===$/gm) || []).length === 6);

  // 1. 加载失败 / 库缺失：必须安静降级
  {
    const a = makeEnv({ noInk: true });
    expect('inkjs 没加载时 load 返回 false', (await a.S.load()) === false);
    expect('降级时 linesOf 返回空数组', a.S.linesOf(1).length === 0);
    expect('降级状态如实报告', a.S.stats().failed === true && a.S.ready === false);
    const b = makeEnv({ fetchFail: true });
    expect('fetch 失败不抛异常', (await b.S.load()) === false);
    expect('fetch 失败后不假装就绪', b.S.ready === false);
    const c = makeEnv({ httpFail: true });
    expect('HTTP 非 200 也安静降级', (await c.S.load()) === false);
  }

  // 2. 正常加载：6 章 × 3 句，逐字对得上原文
  {
    const a = makeEnv();
    expect('load 成功', (await a.S.load()) === true);
    expect('ready 为真', a.S.ready === true);
    let allOk = true, detail = [];
    for (let i = 1; i <= 6; i++) {
      const got = a.S.linesOf(i);
      if (got.join('|') !== want[i - 1].join('|')) {
        allOk = false;
        detail.push('第' + i + '章 ' + JSON.stringify(got));
      }
    }
    expect('★6 章 18 句与 campaign.js 原文逐字一致', allOk && want.every(w => w.length === 3), detail.join(' ; '));
    expect('★句子真由 Ink 运行时逐句读出（不是直接抄数组）', a.S.stats().lines === 18,
      'lines=' + a.S.stats().lines);
    expect('章节结果有缓存，重复读不再新建实例', a.S.linesOf(1) === a.S.linesOf(1));
    expect('未知章节返回空而不是抛', a.S.linesOf(99).length === 0);
    expect('stats 报告 6 章', a.S.stats().chapters >= 6);
  }

  // 3. 不碰联机
  {
    const proto = fs.readFileSync(path.join(ROOT, 'shared/proto_bin.js'), 'utf8');
    const sim = fs.readFileSync(path.join(ROOT, 'shared/sim.js'), 'utf8');
    expect('二进制协议里没有 ink/storyline 字段', !/\b(inkjs|Storylines|butian|recapLines)\b/i.test(proto));
    expect('模拟层没有引用 Ink 运行时', !/\b(inkjs|Storylines)\b/.test(sim));
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail > 0) process.exit(1);
})();
