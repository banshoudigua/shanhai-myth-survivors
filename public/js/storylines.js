// 《补天纪》剧情运行时（第二十五轮 · ③）
//
// inkjs 只负责「把 Ink 数据按章逐句读出来」，不接管战斗里的 story 事件：
//   · 战斗节拍仍由服务端权威的 sim 按时间推（联机两端必须一致，不能让客户端自己编）
//   · 这里提供的是**剧情回顾**：卷首页面板里查看本章三句题记
// 因此它纯展示、纯本地、不进快照，也不改变一局的任何数值。
//
// ★为什么不把剧情改成真分支：那需要产品先定《补天纪》的分叉走向与解锁条件
//   （第十五轮已定「主线《补天纪》」），本轮按约定只把数据链路搭好、文案一句不改。

(function (root) {
  'use strict';

  const VS = root.VS = root.VS || {};
  const JSON_URL = '/story/butian.ink.json';
  let story = null;
  let loading = null;
  let failed = false;
  const cache = {};          // chapterNo -> [句子]

  function linesOf(chapterNo) {
    if (!story || !root.inkjs || !root.inkjs.Story) return [];
    if (cache[chapterNo]) return cache[chapterNo];
    const path = 'chapter_' + chapterNo;
    // ★inkjs 的 ChoosePathString 遇到不存在的 knot 会直接抛异常，
    //   项目约定不用 try/catch，所以调用前先在编译数据里查这个 knot 在不在。
    if (story.indexOf('"' + path + '"') < 0) return [];
    // 每次用新实例：Story 是有状态的指针，串着读会把上一章的 continue 状态带进来
    const one = new root.inkjs.Story(story);
    one.ChoosePathString(path);
    const out = [];
    let guard = 0;
    while (one.canContinue && guard++ < 40) {
      const line = one.Continue().trim();
      if (line) out.push(line);
    }
    cache[chapterNo] = out;
    return out;
  }

  function load() {
    if (story) return Promise.resolve(true);
    if (loading) return loading;
    if (!root.inkjs || !root.inkjs.Story || !root.fetch) {
      failed = true;
      return Promise.resolve(false);
    }
    loading = root.fetch(JSON_URL).then(function (r) {
      if (!r.ok) { failed = true; return false; }
      return r.json().then(function (j) {
        // 统一存字符串：inkjs.Story 的构造对字符串路径最稳，
        // 每次 linesOf 都是「全新 Story + ChoosePathString」，不会串章
        story = typeof j === 'string' ? j : JSON.stringify(j);
        return true;
      });
    }).catch(function () {
      failed = true;
      return false;
    });
    return loading;
  }

  function stats() {
    return {
      ready: !!story, failed: failed,
      chapters: Object.keys(cache).length,
      lines: Object.keys(cache).reduce(function (a, k) { return a + cache[k].length; }, 0)
    };
  }

  VS.Storylines = {
    load: load, linesOf: linesOf, stats: stats,
    get ready() { return !!story; }
  };
})(window);
