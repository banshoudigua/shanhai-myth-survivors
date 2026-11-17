// 程序化 8-bit 音效层（第二十五轮 · ①）
//
// 【分工】goldfire/howler.js 只负责播放与音量；音色来自 grumdrig/jsfxr 的
//   合成参数（tools/gen-sfx.js 构建期生成 public/audio/*.wav）。
//   浏览器运行时不加载 jsfxr，也不做任何逐样本计算 —— 一次攻击只是 play()。
// 【为什么不是 WebAudio 直接播】Howler 已经把「移动端首次触摸解锁 AudioContext」、
//   「后台标签页自动暂停」、「同一音效多实例叠加」这些坑处理好了，
//   自己写要重踩一遍；而且它只有 36KB、零依赖、有全局脚本版。
// 【铁律】纯表现层：不进 shared/sim.js、不进二进制快照、不影响世界时间。
//   联机里每个客户端按自己看到的画面各播各的，服务端完全不知道有音效。

(function (root) {
  'use strict';

  const VS = root.VS = root.VS || {};
  const KEY = 'vs_sfx';
  const NAMES = [
    'slash', 'hit', 'kill', 'hurt', 'lightning', 'boom',
    'pickup', 'levelup', 'chest', 'buy', 'select', 'story',
    'boss', 'win', 'lose'
  ];

  // 同名音效的最小间隔（毫秒）。这游戏一秒能打出十几次命中，
  //   不限流会把几十个 Howl 实例叠成一片噪音，还会拖慢音频线程。
  const GAP = {
    slash: 70, hit: 55, kill: 90, hurt: 260, lightning: 130, boom: 140,
    pickup: 90, levelup: 420, chest: 200, buy: 90, select: 60, story: 500,
    boss: 1200, win: 1500, lose: 1500
  };

  const VOL = 0.44;            // 总音量：归一化后的 wav 峰值 -7dB，再压到不盖过 BGM 的位置
  let enabled = true;
  let sounds = {};
  let ready = false;
  let unlocked = false;
  const lastAt = {};
  let played = 0;              // 测试用：累计真正发出的播放次数
  let lastPlayed = '';

  // 状态差分：只记「上一帧看到的数」，不往世界对象里塞任何东西
  const prev = { kills: -1, hp: -1, level: -1, gold: -1, inited: false };

  function readFlag() {
    let raw = null;
    try { raw = root.localStorage.getItem(KEY); } catch (e) { raw = null; }
    return raw !== '0';       // 默认开；只有显式关过才静音
  }

  function writeFlag(on) {
    let saved = true;
    try { root.localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { saved = false; }
    return saved;
  }

  // ★脚本一加载就要读偏好：game.js 的 reactive ui 会用 SFX.enabled 做初值，
  //   等到 init() 再读就晚了 —— 表现是「上次关了静音，进游戏按钮显示已开启」。
  enabled = readFlag();

  // 首次真实交互时解锁音频上下文。浏览器禁止自动播放，
  //   光靠 Howler 的 autoUnlock 在部分 WebView 里不够，这里补一次显式 resume。
  function unlock() {
    if (unlocked || !root.Howler) return;
    unlocked = true;
    const ctx = root.Howler.ctx;
    if (ctx && ctx.state === 'suspended' && ctx.resume) ctx.resume();
    root.document.removeEventListener('pointerdown', unlock);
    root.document.removeEventListener('keydown', unlock);
    root.document.removeEventListener('touchstart', unlock);
  }

  function init() {
    if (ready) return ready;
    enabled = readFlag();
    const Howl = root.Howl;
    const Howler = root.Howler;
    if (!Howl || !Howler) return false;   // 库没加载：整个音效层安静降级，绝不白屏

    for (let i = 0; i < NAMES.length; i++) {
      const name = NAMES[i];
      sounds[name] = new Howl({
        src: ['/audio/' + name + '.wav'],
        format: ['wav'],
        volume: VOL,
        preload: true,
        html5: false
      });
    }
    Howler.mute(!enabled);
    Howler.volume(1);
    Howler.autoUnlock = true;

    if (root.document && root.document.addEventListener) {
      root.document.addEventListener('pointerdown', unlock);
      root.document.addEventListener('keydown', unlock);
      root.document.addEventListener('touchstart', unlock);
    }
    ready = true;
    return true;
  }

  // name 不存在、库没加载、静音、限流内，一律静默返回（不抛异常打断游戏）
  function play(name, opt) {
    if (!enabled || !ready || !sounds[name]) return false;
    const now = root.performance && root.performance.now ? root.performance.now() : Date.now();
    const gap = (opt && opt.gap !== undefined) ? opt.gap : (GAP[name] || 80);
    if (now - (lastAt[name] || -1e9) < gap) return false;
    lastAt[name] = now;

    const s = sounds[name];
    const id = s.play();
    // 轻微随机音高：同一种命中连打十几次也不像复读机
    if (id && opt && opt.vary !== false) s.rate(0.94 + Math.random() * 0.12, id);
    played++;
    lastPlayed = name;
    return true;
  }

  function setEnabled(on) {
    enabled = !!on;
    if (root.Howler) root.Howler.mute(!enabled);
    const saved = writeFlag(enabled);
    if (enabled && ready) play('select', { gap: 0, vary: false });
    return saved;
  }

  // 事件队列 → 音效。只挑「有节奏意义的节点」，波次播报这类高频事件不响。
  function onEvent(e) {
    if (!e || !e.type) return;
    const t = e.type;
    if (t === 'boss') play('boss');
    else if (t === 'chest_open') play('chest');
    // 领神龛与开箱同一个音：两者都是「拿到了一份奖励」，语气一致；
    // 不为它单独做一条音效（音效资源越少越不容易在手机上加载失败）。
    else if (t === 'shrine') play('chest');
    else if (t === 'chest_drop') play('story');
    else if (t === 'levelup') play('levelup');
    else if (t === 'dead' || t === 'timeout') play('lose');
    else if (t === 'won') play('win');
    else if (t === 'revive') play('levelup');
    else if (t === 'story') play('story');
    // 挑战者现身用同一段提示音：它是「注意，有东西来找你了」，
    // 和剧情节拍那种「读一句话」的语气不同，但都是**提醒玩家抬头看**的场景音，
    // 不值得为它单独做一条（音效资源越少越不容易在手机上加载失败）。
    else if (t === 'challenger') play('story');
    // 血怒（第三十八轮）：一次「爆发」，用 boom 的低频冲击感，不再单独做一条音效
    // （音效资源越少越不容易在手机上加载失败）。限流收紧一点：它可能连着触发。
    else if (t === 'rage') play('boom', { gap: 400, vary: false });
    // 赤月天象（第三十九轮）：开始用低频冲击（天色压下来），结束**刻意不出声**——
    // 「危险过去了」不需要再吓玩家一跳，提示条已经说清楚了。
    // 限流放宽到 900ms：它 100 秒才来一次，但开/关两条事件挨得很近时别叠成一记闷响。
    else if (t === 'moon') {
      if (e.on) play('boom', { gap: 900, vary: false });
    }
    // 陨星（第四十轮）：预警用提示音（和挑战者/剧情节拍同一段，都是「抬头注意」），
    // 落地用低频冲击。★落地单独一条事件（meteor_hit），因为预警与落地隔了 1.8 秒，
    // 挂在同一条事件上会让「石头砸下来」和「提示条弹出」同时响，听起来像一声空响。
    else if (t === 'meteor') play('story', { gap: 400 });
    else if (t === 'meteor_hit') play('boom', { gap: 600, vary: false });
    // 山魈（第四十一轮）：现身用提示音（与挑战者/剧情节拍同一段，都是「抬头注意」），
    // 击杀用开箱音（它掉的是金币与经验，是一份「拿到了」的语气）。
    // ★召唤动作**刻意不出声**：它每 5.5 秒召一次，出声就是一段持续的噪音。
    else if (t === 'summoner') play('story');
    else if (t === 'summoner_down') play('chest');
    // 地脉灵泉（第四十二轮）：涌出用提示音（「抬头看地上」），
    // 唤醒用开箱音 —— 它是这一局里少数几个「你赚到了」的时刻。
    else if (t === 'ley') play('story', { gap: 400 });
    else if (t === 'ley_burst') play('chest', { gap: 400 });
    // 血祭坛（第四十三轮）：浮现用提示音（「地上有东西，抬头看」）；
    // 成交用**低频冲击**（boom）—— 它是「你付出了一样不会再回来的东西」，
    // 拿开箱音那种「赚到了」的语气去配，会让人以为这是白拿的。
    // 拒绝**刻意不出声**：提示条已经说明白了，再响一下就成了「你失败了」的额外惩罚。
    else if (t === 'pact') play('story', { gap: 400 });
    else if (t === 'pact_taken') play('boom', { gap: 600, vary: false });
    // 歧路双碑（第四十八轮）：立起用提示音（「抬头，地上有两座，快选」）；
    // 取走用**低频冲击**（boom）—— 和血祭坛成交同一个语气：
    // 它不是"白拿了东西"，而是"我做了决定，另一样永远没了"。
    // ★碎裂那一下**刻意不出声**：它与"取走"是同一帧的两件事，
    //   两声叠在一起只会糊成一记闷响（双生妖的复生也是这个处理）。
    else if (t === 'boon') play('story', { gap: 400 });
    else if (t === 'boon_taken') play('boom', { gap: 600, vary: false });
    // 双生妖（第四十五轮）：现身用提示音（抬头注意）；
    // 倒下一只用**低频冲击**（「它倒下了」这件事发生了，但还没结束）；
    // 全灭用开箱音（这一对终于解决了）；
    // ★复生**刻意不出声**：它已经是失败分支，再给一记重音就变成「你被罚了两次」。
    //   而且它和「倒下一只」只隔 6 秒，两声连着响会糊成一段噪音。
    else if (t === 'twins') play('story', { gap: 400 });
    else if (t === 'twin_half') play('boom', { gap: 600, vary: false });
    else if (t === 'twin_slain') play('chest', { gap: 400 });
    // 引魂灯（第四十六轮）：亮起用提示音（「抬头看地上，有三个方向」）；
    // 点着一盏用**短促的一声**（buy：它只是一个"叮"，不是奖励 —— 26 秒里可能连响两次，
    //   用开箱音会把"还差两盏"听成"已经拿到了"）；
    // 点齐用开箱音（这才是真正拿到了东西的时刻）。
    // ★限流 300ms：三盏灯挨得近时，两次点亮可能只隔一两秒，别叠成一记闷响。
    else if (t === 'lantern') play('story', { gap: 400 });
    else if (t === 'lantern_lit') play('buy', { gap: 300 });
    else if (t === 'lantern_done') play('chest', { gap: 400 });
    // 饕餮（第四十七轮）：现身用提示音（「抬头看，有东西在动你的东西」）；
    // 击杀用开箱音（精魄吐回来了，是一份"拿回来了"的语气）；
    // 逃跑用**低频冲击**（boom）——它是这一轮唯一的失败分支，而且代价是实打实的损失，
    //   该有一记闷响让玩家记住「下次早点回头」。
    else if (t === 'devourer') play('story', { gap: 400 });
    else if (t === 'devourer_down') play('chest', { gap: 400 });
    else if (t === 'devourer_flee') play('boom', { gap: 600, vary: false });
    // 镇妖钟（第四十九轮）：立起用提示音（「地上有一口钟，抬头找」）；
    // 敲响用**低频冲击**（boom）—— 它就是一记钟声，而且这一下同时是
    //   「妖群开始转向」的起手式，该有实打实的重量感。
    // ★不新做音效：音效资源越少越不容易在手机上加载失败（历来的口径）。
    else if (t === 'bell') play('story', { gap: 400 });
    else if (t === 'bell_toll') play('boom', { gap: 700, vary: false });
    // 影傀浮现用 story（与镇妖钟"现世"同一个提示音：都是"场上有新东西了"），
    // 合体成功用 boom —— 那是「赌赢/赌输都已经落地」的一记重击。
    // ★不新做音效：音效资源越少越不容易在手机上加载失败（历来的口径）。
    else if (t === 'merge_pair') play('story', { gap: 400 });
    else if (t === 'wangliang') play('boom', { gap: 600, vary: false });
    else if (t === 'evolve' || t === 'combo_new' || t === 'combo') play('chest');
    else if (t === 'weapon_new' || t === 'passive_new' ||
             t === 'weapon_up' || t === 'passive_up' || t === 'fallback') play('buy');
  }

  // 每帧一次的差分检测：击杀 / 掉血 / 升级 / 捡钱。
  // ★只认「变化」，不认「当前值」：联机快照每帧重建对象，按值判断会每帧都播。
  function onFrame(hud, live) {
    if (!hud) return;
    if (!live) { prev.inited = false; return; }
    if (!prev.inited) {
      prev.kills = hud.kills || 0; prev.hp = hud.hp || 0;
      prev.level = hud.level || 1; prev.gold = hud.gold || 0;
      prev.inited = true;
      return;                  // 第一帧只建立基线，别把开局当成「瞬间升级」
    }
    const k = hud.kills || 0, hp = hud.hp || 0, lv = hud.level || 1, g = hud.gold || 0;
    if (k > prev.kills) {
      // 一次群伤能跳几十个击杀：只响一次，且不允许倒退（重开局）触发
      if (k - prev.kills <= 40) play(k - prev.kills >= 4 ? 'boom' : 'kill');
    }
    if (hp < prev.hp - 0.5) play('hurt');
    if (lv > prev.level) play('levelup');
    if (g > prev.gold) play('pickup');
    prev.kills = k; prev.hp = hp; prev.level = lv; prev.gold = g;
  }

  // 攻击起手 / 命中：由 render.js 里已有的挥砍检测点调用，与 act 时序同帧
  function punch(kind) {
    if (kind === 'cleave') play('slash', { gap: 55 });
    else if (kind === 'lightning') play('lightning');
    else if (kind === 'boom') play('boom');
    else play('slash');
  }

  function stats() {
    return {
      ready: ready, enabled: enabled, played: played, lastPlayed: lastPlayed,
      count: Object.keys(sounds).length, names: NAMES.slice()
    };
  }

  VS.Sfx = {
    init: init, play: play, punch: punch, onEvent: onEvent, onFrame: onFrame,
    setEnabled: setEnabled, stats: stats,
    get enabled() { return enabled; }
  };
})(window);
