// public/js/story-progress.js —— 剧情模式的进度与解锁规则
//
// 为什么单独一个文件、为什么放 public/ 而不是 shared/
// --------------------------------------------------
// 剧情是**单人体验**：进度只存在玩家自己的浏览器里（localStorage），
// 服务端完全不参与 —— 联机没有剧情，也就不需要落库。
// 所以它是纯前端模块，不进 shared/（那里放的是双端必须一致的东西）。
//
// ★为什么解锁规则要单独抽出来，而不是写在关卡选择页里
// 「哪些关已解锁」有**两个消费者**：
//   ① 大厅的关卡选择页（决定哪张卡能点）
//   ② 游戏页的进关校验（防止手输 URL 绕过选关页，直接跳进第六关）
// 如果规则写在①里，②就得复刻一遍 —— 而**同一份规则写在两处必然被忘**
// （这个项目已经踩过：`.panel-narrow` / `.panel-wide` 各写一份换行规则，
//   换类时「重开一局」当场又被裁）。所以规则只在这里定义一次。
//
// localStorage 结构：
//   vs_story_progress = {
//     myth:  { cleared: ['ch1','ch2'], best: { ch1: 218 } },
//     magic: { cleared: ['mc1'],       best: {} }
//   }
// cleared 是**通关过的关卡 id 列表**（不是最高关卡号）——
// 用列表而不是「进度数字」的理由：将来如果能跳关/重玩，
// 数字表达不了「第三关没过但第四关过了」。列表天然支持。

(function (root) {
  const KEY = 'vs_story_progress';

  // 读取全部进度。损坏/隐私模式一律返回空结构 ——
  // 让「读不到进度」表现为「从头开始」，而不是白屏。
  function loadAll() {
    let bag = null;
    try {
      bag = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch (e) {
      bag = null;   // 隐私模式下 getItem 本身会抛，统一当空处理
    }
    return bag && typeof bag === 'object' ? bag : {};
  }

  // 取某个模组的进度
  function loadMod(modId) {
    const all = loadAll();
    const one = all[modId];
    if (!one || typeof one !== 'object') return { cleared: [], best: {} };
    return {
      cleared: Array.isArray(one.cleared) ? one.cleared : [],
      best: (one.best && typeof one.best === 'object') ? one.best : {}
    };
  }

  // 写某个模组的进度（整块写回，避免两个模组互相覆盖）
  function saveMod(modId, one) {
    const all = loadAll();
    all[modId] = { cleared: one.cleared || [], best: one.best || {} };
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e) { /* 隐私模式下写不了，忽略 —— 进度丢失但不崩 */ }
  }

  // 记录通关。返回 true 表示「这次是新通关」（第一次过这一关）。
  // 【为什么要区分新旧】新通关才值得弹「下一关已解锁」的提示；
  // 重打一遍已过的关不该再提示一次（那是噪音）。
  function markCleared(modId, stageId, seconds) {
    const one = loadMod(modId);
    const isNew = one.cleared.indexOf(stageId) < 0;
    if (isNew) one.cleared.push(stageId);
    // 最佳用时只在更快时更新（0 或未记录视为「还没有」）
    if (seconds > 0) {
      const old = one.best[stageId];
      if (!old || seconds < old) one.best[stageId] = Math.round(seconds);
    }
    saveMod(modId, one);
    return isNew;
  }

  function isCleared(modId, stageId) {
    return loadMod(modId).cleared.indexOf(stageId) >= 0;
  }

  // ------------------------------------------------------------
  // 解锁规则：第 1 关永远解锁；第 N 关要求第 N-1 关已通关。
  // ------------------------------------------------------------
  // 【为什么是「前一关」而不是「任意一关」】线性推进是叙事体验的基础 ——
  // 剧情模式的价值在于「按顺序把故事讲完」，跳关会让节拍失去铺垫。
  // 这也是需求里「设解锁门槛」这一条的具体落法。
  //
  // ★第一关必须永远解锁：如果规则写成「要求前一关通关」而不特判首关，
  //   首关会永远解不开（它没有前一关）→ 整个模式进不去。
  //   这是这类规则最经典的 off-by-one。
  function isUnlocked(modId, campaign, stageId) {
    const list = (campaign && campaign.stagesOf) ? campaign.stagesOf(modId) : [];
    if (!list.length) return false;
    // 首关恒解锁
    if (list[0].id === stageId) return true;
    // 找到它的前一关
    for (let i = 1; i < list.length; i++) {
      if (list[i].id === stageId) {
        return isCleared(modId, list[i - 1].id);
      }
    }
    // 非法 stageId：交给调用方回落（这里不猜）
    return false;
  }

  // 本模组「当前该打哪一关」= 第一关未过的关。
  // 全部通过则返回最后一关（方便「再打一遍」）。
  function currentStageId(modId, campaign) {
    const list = (campaign && campaign.stagesOf) ? campaign.stagesOf(modId) : [];
    if (!list.length) return '';
    for (let i = 0; i < list.length; i++) {
      if (!isCleared(modId, list[i].id)) return list[i].id;
    }
    return list[list.length - 1].id;
  }

  // 通关数（大厅显示「3 / 6」用）
  function clearedCount(modId, campaign) {
    const list = (campaign && campaign.stagesOf) ? campaign.stagesOf(modId) : [];
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      if (isCleared(modId, list[i].id)) n++;
    }
    return n;
  }

  // 清空某个模组的进度（调试/测试用；大厅不给入口）
  function reset(modId) {
    const all = loadAll();
    delete all[modId];
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch (e) { /* 忽略 */ }
  }

  root.VS = root.VS || {};
  root.VS.STORY = {
    KEY: KEY,
    loadMod: loadMod,
    markCleared: markCleared,
    isCleared: isCleared,
    isUnlocked: isUnlocked,
    currentStageId: currentStageId,
    clearedCount: clearedCount,
    reset: reset
  };
})(typeof window !== 'undefined' ? window : this);
