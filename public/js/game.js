// public/js/game.js —— 游戏页主逻辑：固定步长循环 + 60fps 渲染
//
// 分工：
//   shared/sim.js   20Hz 逻辑（P2 会原样搬到服务端）
//   js/input.js     输入 → 方向向量
//   js/render.js    Canvas 绘制
//   本文件          把三者接起来、驱动循环、把状态喂给 Vue HUD
//
// 循环结构（标准固定步长 + 插值渲染）：
//   逻辑固定 20Hz 步进，render 每帧用 alpha 在上一帧与当前帧位置之间插值，
//   这样逻辑频率与显示刷新率解耦，既省算力又没有 20Hz 的卡顿感。

(function () {
  'use strict';

  const C = window.VS.CONST;
  const SIM = window.VS.SIM;
  // 二进制快照协议（P2-5）。单机模式完全不会用到它 —— 只有联机收快照时才会走。
  const PB = window.VS.PROTO_BIN;
  const createInput = window.VS.createInput;
  const createRenderer = window.VS.createRenderer;
  // 技能图鉴（public/js/skillbook.js）：把 const.js 的技能表整理成可展示条目。
  // 【为什么可以在这里直接取】skillbook.js 排在 game.js 之前，且只依赖 const.js。
  const SKILLBOOK = window.VS.SKILLBOOK;

  // 调试浮层开关：URL 加 ?debug=1 打开，或本地存过就保持
  const DEBUG = /[?&]debug=1/.test(location.search);

  const STEP_MS = 1000 / C.TICK_HZ;
  // 单帧最多补几步：卡顿（切标签页回来）后不追赶，避免瞬间跑掉一大段时间
  const MAX_CATCHUP_STEPS = 5;

  // ============================================================
  // 玩家档案：由大厅写入 localStorage
  // ============================================================

  function loadProfile() {
    let raw = null;
    try {
      raw = JSON.parse(localStorage.getItem('vs_profile') || 'null');
    } catch (e) {
      raw = null;
    }
    if (!raw || typeof raw !== 'object') raw = {};
    return {
      nickname: raw.nickname || '玩家',
      isGuest: raw.isGuest !== false,
      userId: raw.userId || null,
      charId: raw.charId || 'hunter'
    };
  }

  const profile = loadProfile();
  // nickname / isGuest 的最终取值放在下面「savedMatch 覆盖」之后 —— 联机时要以
  // 大厅写进 sessionStorage 的那一份为准，这里先不急着定。

  // ============================================================
  // 单机 / 联机分流
  // ============================================================
  // 进入方式：大厅候场室里房主点「开始对局」，前端会带着 ?room=XXXX 跳过来。
  // 不带这个参数就是单机（P1 的老路径，一行没改）。
  //
  // 两者的根本区别：**联机模式下本机不推进世界**。
  // 本机只做两件事：上行「我想往哪走」，下行把服务端算出来的世界画出来。
  // 所以联机模式这一页永远不调用 SIM.step()。

  const ONLINE_ROOM = /[?&]room=([A-Za-z0-9]+)/.exec(location.search);
  let roomCode = ONLINE_ROOM ? ONLINE_ROOM[1].toUpperCase() : '';

  // 观战模式：?spec=房间号。与「参战」共用同一套服务端世界与渲染，
  // 区别只在三件事：不占座位、不发操作、不画自己的 HUD。
  //
  // 【为什么用独立参数而不是复用 ?room=】两者走的是不同的上行消息
  // （room_join vs spectate）。共用一个参数就得靠 sessionStorage 里有没有
  // vs_match 去猜当前是哪种 —— 那正是「残留导致进错模式」那类 bug 的来源
  // （之前 vs_match 键名笔误踩过一次）。URL 显式写明，猜的余地就没有了。
  //
  // 【为什么观战时 roomCode 也有值】下面所有用它的地方（分享链接、返回候场室、
  // 写进 sessionStorage）逻辑都一样，不该为观战各写一份。真正的分叉只发生在
  // 「上行发哪条消息」那一步，用 SPECTATING 判就够。
  const SPEC_ROOM = /[?&]spec=([A-Za-z0-9]+)/.exec(location.search);
  const SPECTATING = !!SPEC_ROOM;

  // 联机判定（决定「本机推不推进世界」）。观战也算联机 —— 世界由服务端推进，
  // 本机一行 SIM.step() 都不该调。
  const ONLINE = !!roomCode || SPECTATING;
  // 观战时对外一律用这个房间号
  if (SPECTATING) { roomCode = SPEC_ROOM[1].toUpperCase(); }

  // 地图：?map=地图id。单机直接用；联机由**房间**决定（服务端权威），
  // URL 上的只在联机时当「本地默认值」，game_start 回来后会被覆盖。
  //
  // 【为什么不在这里校验地图是否存在】非法 id 交给 shared/maps.js 的
  // mapById 回落（它会回默认图）—— 「传了乱码」不该让页面开天窗。
  const MAP_PARAM = /[?&]map=([A-Za-z0-9_]+)/.exec(location.search);
  let mapId = MAP_PARAM ? MAP_PARAM[1] : '';

  // ---------- 剧情模式（第十五轮）----------
  // ?mod=模组id&stage=关卡id，单机专用。
  // 【为什么联机时忽略这两个参数】剧情是单人体验：关卡与初始角色是绑死的，
  // 而联机的初始角色由「房间里每个人自己选」决定 —— 两套规则同时生效会
  // 出现「服务器按你的选择建人、世界却按关卡的startChar 走」的分歧。
  // 所以联机一律走 vanilla（=不传 modId 时的默认），不进剧情。
  //
  // 【为什么不在这里校验】非法 id 交给 shared/campaign.js 的
  // modById / stageById 回落（→ vanilla / 第一关），理由与 mapId 相同：
  // 「传了乱码」不该让页面开天窗。
  const MOD_PARAM = /[?&]mod=([A-Za-z0-9_]+)/.exec(location.search);
  const STAGE_PARAM = /[?&]stage=([A-Za-z0-9_]+)/.exec(location.search);
  const CAMPAIGN = window.VS.CAMPAIGN;
  const STORY = window.VS.STORY;
  // 联机强制 vanilla（理由见上）
  const modId = ONLINE ? 'vanilla' : (MOD_PARAM ? MOD_PARAM[1] : 'vanilla');
  const stageId = STAGE_PARAM ? STAGE_PARAM[1] : '';
  const isCampaign = !ONLINE && CAMPAIGN.isCampaign(modId);
  // 本关定义（自由模式为 null）。开局就要拿到它：卷首题记、章节总数、
  // 下一关是哪一关，都在进关之前就要显示。
  let storyStage = isCampaign ? CAMPAIGN.stageById(modId, stageId) : null;
  const campaignTotal = isCampaign ? CAMPAIGN.stageCount(modId) : 0;

  // ---------- 解锁校验（★不能只在大厅的选关页做）----------
  // 选关页只管「哪张卡能点」，而玩家可以直接手输
  // /game.html?mod=myth&stage=ch6 跳进最后一关 —— 那样解锁门槛形同虚设。
  // 所以进关时必须**再校验一次**，规则来自 story-progress.js（同一份，不重复写）。
  //
  // 【为什么是「降级到当前该打的那一关」而不是「拒绝进入」】
  // 拒绝 = 白屏或者弹窗，玩家不知道发生了什么；
  // 降级 = 直接把他送进该打的那一关，界面上题记/章节号都是对的，
  // 他能立刻开始玩，也不会以为游戏坏了。
  if (storyStage && STORY) {
    if (!STORY.isUnlocked(modId, CAMPAIGN, storyStage.id)) {
      const fallbackId = STORY.currentStageId(modId, CAMPAIGN);
      console.log('[story] 关卡 ' + storyStage.id + ' 尚未解锁，降级到 ' + fallbackId);
      storyStage = CAMPAIGN.stageById(modId, fallbackId);
    }
  }
  // 校验之后才能定下「本局实际打的是哪一关」——
  // 后面 buildWorld / 卷首页 / 通关记分全部读它。
  const realStageId = storyStage ? storyStage.id : '';

  // 大厅跳转前写进 sessionStorage 的这一局底细（昵称、座位、角色、快照频率…）。
  // 拿不到也不致命，后面 room_join 时服务端会再回一份权威的。
  const savedMatch = (function () {
    try {
      return JSON.parse(sessionStorage.getItem('vs_match') || 'null') || {};
    } catch (e) {
      return {};
    }
  })();

  // 联机时「这一局我是谁」一律以大厅写进 sessionStorage 的 vs_match 为准：
  // 角色、昵称、游客标记都算。
  //
  // 【昵称为什么也必须走 sessionStorage】profile 来自 localStorage，而 localStorage
  // 是**同一个浏览器所有标签页共享**的。同一台机器开两个窗口对测时，后进大厅的那个
  // 会把 vs_profile 整个覆盖掉，于是两个页面对服务端自报同一个昵称 ——
  // 服务端日志里能直接看到相邻两条一模一样的 "昵称=X"，表现就是
  // 「两个人看起来是同一个人、头顶名牌全一样」，排查时根本分不清谁是谁。
  // sessionStorage 是每个标签页独立的，两个窗口天然互不干扰。
  if (ONLINE && savedMatch.charId) profile.charId = savedMatch.charId;
  if (ONLINE && savedMatch.nickname) profile.nickname = savedMatch.nickname;
  if (ONLINE && savedMatch.isGuest !== undefined) profile.isGuest = !!savedMatch.isGuest;

  const nickname = profile.nickname;
  const isGuest = profile.isGuest;

  // 剧情模式：读出这一关上次选的难度（每关独立，见 startMatch 的说明）
  let savedStoryDiff = '';
  if (isCampaign) {
    try {
      const bag = JSON.parse(localStorage.getItem('vs_story_diff') || '{}');
      savedStoryDiff = bag[modId + '/' + realStageId] || '';
    } catch (e) { /* 隐私模式，忽略 */ }
  }

  // ============================================================
  // 与 Vue HUD 共享的状态
  // ============================================================

  const { createApp, reactive } = Vue;

  // 「技能全学满之后自动领补给」这个开关的初值。
  // 【为什么进 localStorage 而不是世界对象】它是**本机玩家的偏好**，不是世界状态：
  //   重开一局、换个角色、甚至换房间都该记住。放世界对象里重开就丢。
  // 【为什么声明在这里（而不是跟商店代码放一起）】ui 的初始化里要用它，
  //   而 `const` 是**暂时性死区**的 —— 声明写在 ui 后面会直接抛
  //   `Cannot access 'autoSupplyOn' before initialization`，整页白屏。
  //   （踩过：第一版就放在 SHOP_ITEMS 旁边，全局崩。）
  const AUTO_SUPPLY_KEY = 'vs_autosupply';
  const autoSupplyOn = (function () {
    let raw = null;
    try {
      raw = localStorage.getItem(AUTO_SUPPLY_KEY);
    } catch (e) {
      raw = null;   // 隐私模式下读写会抛，当作没开
    }
    return raw === '1';
  })();

  // ============================================================
  // 手机上技能区默认折叠（第二十轮）
  // ============================================================
  // 【为什么】手机竖屏下技能区（10 武器 + 10 被动 + 组合技，20~23 格）实测占屏 28%、
  //   满配时更多，可视战场被压掉一大块 —— 而这个游戏是要**边跑边躲**的，
  //   战场可视面积是命门。折叠成一个角标，点一下才展开。
  //
  // ★只对触摸设备默认折叠（`pointer: coarse`）：
  //   PC 上技能区旁边就是鼠标，点哪看哪，折叠反而多一次点击。
  //   判据用 matchMedia 而不是 UA —— UA 会漏（桌面触屏、远程桌面），
  //   matchMedia 是「本机真的有触摸指针」的唯一可靠来源。
  const SLOTS_FOLD_KEY = 'vs_slotsfold';
  const slotsFoldedOn = (function () {
    // 先问「玩家自己有没有设过」——设过就照他的意思来，不跟设备默认值打架
    let raw = null;
    try {
      raw = localStorage.getItem(SLOTS_FOLD_KEY);
    } catch (e) {
      raw = null;
    }
    if (raw === '1') return true;
    if (raw === '0') return false;
    // 没设过 → 按设备：触摸设备默认折叠，鼠标设备默认展开
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    return coarse;
  })();

  // hud：从 sim 的 getHud() 同步过来的只读视图片段
  const hud = reactive({
    state: 'playing',
    time: 0,
    timeLeft: C.MATCH_SEC,
    // 本局时长（秒）。默认取常量（= 普通难度），开局包/HUD 会把它改成真实值。
    matchSec: C.MATCH_SEC,
    wave: 0,
    level: 1,
    exp: 0,
    expNext: C.expNext(1),
    hp: 100,
    maxHp: 100,
    kills: 0,
    gold: 0,
    dmgDealt: 0,
    mobCount: 0,
    weapons: [],
    passives: [],
    // 组合技。必须在这里给默认空数组：模板上写的是 hud.combos.length，
    // 少这个初始值会在第一帧 HUD 到达之前抛「Cannot read properties of undefined」，
    // 而那时 v-cloak 已经摘掉，症状是「界面闪一下就白屏」，很难联想到是缺字段。
    combos: [],
    choices: [],
    charName: '',
    // 关卡区域名（「荒村墓园」等）。同样是模板要读的字段，必须给默认值。
    stageName: '',
    // 地图名（「钟楼广场」等）。整局不变，只在建好世界时写一次。
    mapName: '',
    // 阵亡后的复活倒计时（秒）与本次已倒下次数。
    // 只由服务端 HUD 提供（联机）；单机恒为 0，界面不会显示倒计时层。
    reviveLeft: 0,
    deaths: 0,
    boss: null,
    // 本局难度（id 用于配色、名称用于显示）。单机路径下由本地世界的 getHud 提供，
    // 那就是「普通」—— 单机没有难度选择。
    diffId: '',
    diffName: '',
    // ---------- 剧情模式（第十五轮）----------
    // ★这些默认值必须存在：模板直接读 hud.campaign 等字段，
    //   缺字段不会报错，只是「那一块不显示/显示空」—— 很难定位。
    campaign: false,
    stageNo: 0,
    stageName: '',
    epigraph: '',
    coda: '',
    bossName: '',
    stageWaveTotal: 0,
    ended: false,
    timeout: false,

    // ---------- 金币商店（可花余额）----------
    // ★与 hud.gold 严格区分：gold 是「这一局一共赚了多少」（结算用），
    //   shopGold 是「现在还能花多少」。混成一个数字会让玩家看着余额莫名减少。
    shopGold: 0,
    buffStacks: 0,
    // 角色详细数据。默认给一份全 0 的 —— 少这个初始值会在第一帧 HUD 到达之前
    // 抛「Cannot read properties of undefined」，症状是界面闪一下就白屏。
    detail: {
      maxHp: 0, armor: 0, speed: 0, dmgMul: 1, cdMul: 1, rangeMul: 1,
      pickupMul: 1, expMul: 1, goldMul: 1, crit: 0, exec: 0,
      regen: 0, killHeal: 0, thorns: 0
    }
  });

  // ui：界面自身状态
  const ui = reactive({
    // 联机模式下跳过角色选择（角色在候场室里就定好了），直接停在「连接中」
    screen: ONLINE ? 'connecting' : 'select',
    // 观战状态放在这里（ui 是 reactive 的），理由见 net 处的注释
    spectating: false,
    followSlot: -1,
    // ★剧情模式**不预选角色**：默认走关卡推荐的那个（stage.startChar）。
    // 【为什么不能沿用 profile.charId】它是「上次单人游戏选的角色」，跨模式共享。
    //   留着它会出现两个问题：
    //   ① 卷首页一进来就高亮「刑天」并写「已换用」，而玩家根本没选过 —— 撒谎
    //   ② 开局建出来的是刑天，而关卡推荐是行者（第一关教学靠贴身高频）
    //   所以剧情模式下这个字段只表示「玩家**主动**换成了谁」，空 = 用关卡默认。
    charId: isCampaign ? '' : profile.charId,
    tick: 0,
    fps: 0,
    drawn: 0,
    total: 0,
    pendingLevels: 0,
    toasts: [],
    surviveText: '0秒',

    // ---------------- 联机状态（P2-4） ----------------
    online: ONLINE,
    roomCode: roomCode,
    netSlot: -1,            // 服务端分配的座位号
    netPlayers: [],         // 这一局的名单（含自己）
    netSnaps: 0,            // 收到的快照帧数
    netKb: 0,               // 收到的快照累计体积（KB），肉眼判断链路有没有在跑
    netPing: 0,             // 上行序号回显延迟（服务端目前不回，留作占位）
    netErr: '',             // 加入失败的原因
    // 正在自动重连（顶栏浮一条提示，别让玩家对着一动不动的画面猜发生了什么）
    netReconnecting: false,
    netRetry: 0,
    // 扫码邀请弹层
    shareOpen: false,
    shareUrl: '',
    shareCode: '',
    shareQrFail: false,
    // 技能图鉴抽屉。helpTab 是当前看的分类（weapon/passive/evo/combo）。
    // 【为什么图鉴不占用 screen】screen 那一套（playing/paused/menu/levelup/result）
    // 决定的是「世界推不推进」与「用哪种面板」；图鉴两者都不该管 ——
    // 尤其联机下它必须与「世界仍在推进」并存，所以只能做成正交的一个布尔开关。
    helpOpen: false,
    helpTab: 'weapon',
    // 剧情：顶部节拍横条当前显示的那一句（空 = 不显示）。
    // ★用 ui 而不是 hud：它与玩家状态无关，纯粹是界面层的一次性提示，
    // 放 hud 里会被 HUD 的签名去抖逻辑当成「每帧在变」而反复重渲染。
    storyLine: '',
    // 游戏倍速（只在单机生效）：1 / 2 / 4。
    // 【为什么放 ui】它是**玩家的选择**（输入），不是世界状态；而且它要进模板
    // （按钮显示 ×2 / ×4），放 ui 才是响应式的正确位置。
    // 联机恒为 1：世界由服务端推进，客户端加速既没意义也不公平。
    speed: 1,
    // 本局难度（剧情卷首页可改）。空 = 交给 sim 回落「普通」。
    // 【为什么是 ui 而不是 hud】hud.diffId 是**服务端/世界告诉我们的结果**
    // （联机时由房间决定），而这个是**玩家的选择**（输入）。
    // 两者混在一个字段里就会出现「选了难度、HUD 又把它覆盖回去」的死循环。
    diffId: savedStoryDiff || '',
    // 商店买不了时的原因（「还差 25 金币」/「已叠到上限」）。
    // 界面要能说出原因，否则玩家只看到按钮变灰，不知道下一步该干什么。
    shopMsg: '',
    // 两段式商品（血脉契约 / 置换契约）的选择器状态。
    //   open    选择器开着没有
    //   itemId  正在买哪件商品（价格、模式都从它查）
    //   mode    'new'（买一件新的）| 'swap'（遗忘一件 + 换上一件）
    //   drop    置换：要遗忘的那件 id
    //   pick    要习得/换上的那件 id
    // 【为什么是 ui 而不是散落的几个字段】它们必须一起变（开/关时整体重置），
    //   拆成四个布尔/字符串很容易出现「选择器关了但上次选的还在」的残留。
    pick: { open: false, itemId: '', mode: '', drop: '', pick: '' },
    // 技能说明卡：slotInfo = 正在看的那一件（对象，null = 没在看）；
    // mySkillsOpen = 「我的技能」列表开着没有（触屏点整块技能区时走这条）。
    // 【为什么不在模板里按下标/带参取】Vue 3 模板里带参调用 computed 会直接抛
    //   「xxx is not a function」→ 渲染中断、整页白屏（项目踩过）。所以点的那一刻
    //   就算好一个对象塞进 ui，模板只做取值。
    slotInfo: null,
    mySkillsOpen: false,
    // 技能全学满后，升级自动领补给（面板不再弹）。
    autoSupply: autoSupplyOn,
    // 手机上技能区是否折叠（第二十轮）。折叠时只留一个角标，
    // 点角标展开；PC 默认 false（不折叠）。
    slotsFolded: slotsFoldedOn,
    // 结算里的全队战绩（服务端 game_over 带上来的每个人各自的数字）
    resultList: []
  });

  // 商店条目表：整局不变，从 const.js 现算（不手写清单 —— 与技能图鉴同一个原则）
  const SHOP_ITEMS = (window.VS.CONST.SHOP && window.VS.CONST.SHOP.items) || [];

  // 按 id 取商品（选择器要用它的价格与名字）。
  function itemOf(id) {
    for (let i = 0; i < SHOP_ITEMS.length; i++) {
      if (SHOP_ITEMS[i].id === id) return SHOP_ITEMS[i];
    }
    return null;
  }

  // 契约选择器的清单。
  //   owned = true  → 只列**已拥有**的（置换契约里「要遗忘的那件」）
  //   owned = false → 只列**未拥有**的（要习得 / 要换上的那件）
  // 【数据全部来自 const.js 的武器/被动表】新增一件武器，选择器自动多一项，
  //   不存在「加了技能但忘了加进商店清单」这种只能靠人记的同步。
  function buildPickList(owned) {
    const out = [];
    const push = function (def, kind) {
      const lv = lvOf(def.id);
      if ((lv > 0) !== owned) return;
      // 原武器已经进化掉的那些：p.weapons 里存的是进化形态的 id，
      // 原武器按 id 查不到 —— 但它也**不能再买一次**（会出现「血鞭 ＋ 铁鞭」并存）。
      // 直接不列出来，免得给玩家一个点了必然被拒的选项。
      const evo = kind === 'weapon' ? C.EVO_BY_WEAPON[def.id] : null;
      if (!owned && evo && lvOf(evo.id)) return;
      out.push({
        id: def.id,
        name: def.name,
        lv: lv,
        cat: kind,
        catName: kind === 'weapon' ? '武器' : '被动'
      });
    };
    for (let i = 0; i < C.WEAPONS.length; i++) push(C.WEAPONS[i], 'weapon');
    for (let i = 0; i < C.PASSIVES.length; i++) push(C.PASSIVES[i], 'passive');
    return out;
  }

  // 图鉴的静态条目表：整局不变，页面初始化时算一次。
  // 【为什么放外面而不是 computed】它是常量，没有任何响应式依赖；
  // 放进 computed 只会让人误以为它会随对局变化（它不会）。
  // markOwned 才是每次「持有情况变了」要重算的那一步，放在 computed 里。
  const helpBase = SKILLBOOK ? SKILLBOOK.build() : [];

  // 说明卡的查找表：id → skillbook 条目。
  // 【为什么不自己维护一份】54 条说明全部由 skillbook.js 从 const.js 现算，
  // 这里只建一张索引。新增一件武器，说明卡与图鉴同时多一条，不存在两边不一致。
  // ★构建必须放在 `helpBase` 之后：`const` 有暂时性死区，写前面会抛
  //   `Cannot access 'helpBase' before initialization`（踩过，整页白屏）。
  const helpById = {};
  for (let i = 0; i < helpBase.length; i++) {
    const grp = helpBase[i];
    for (let j = 0; j < grp.items.length; j++) helpById[grp.items[j].id] = grp.items[j];
  }
  const CAT_LABEL = { weapon: '武器', passive: '被动', evo: '进化', combo: '组合技' };

  // ============================================================
  // 联机：网络与「快照 → 世界」的搬运
  // ============================================================
  //
  // 为什么能不跑 sim 就把画面画出来：服务端快照的字段白名单
  // （server/game/match.js 的 F_MOB / F_PROJ / F_ZONE …）就是照着 sim 实体的
  // 字段名定的，而 render.js 读的正是这些名字 —— 所以快照可以直接拼成一个
  // 「世界形状」的对象喂给渲染器，两边不需要任何翻译层。
  //
  // 已知不足（留给 P2-4 的后续）：只做快照插值，没有本地预测回滚，
  // 高延迟下自己会有轻微「橡皮筋」感。局域网 RTT 只有 0.6ms，先不折腾。

  const net = {
    ws: null,
    selfSlot: -1,
    players: [],
    snap: null,           // 最近一帧世界快照（二进制帧解码后的普通对象）
    prevSnap: null,       // 上一帧快照：二进制协议靠它重建被省掉的 px/py
    snapAt: 0,            // 收到它的本地时刻（插值用）
    snapInterval: 1000 / (savedMatch.snapshotHz || 20),
    lastSendAt: 0,
    seq: 0,
    snapBytes: 0,
    snapCount: 0,         // 累计收到多少帧快照（HUD 显示 + 自动化断言都读它）
    binFrames: 0,         // 其中二进制帧的帧数
    binFail: 0,           // 解码失败的帧数（正常恒为 0；非 0 说明两端协议版本不一致）
    state: 'connecting',  // connecting / playing / ended / failed
    error: '',

    // ---------------- 重连（P2-7） ----------------
    // 这些字段的存在本身就说明了一件事：**对局页原来完全没有重连**。
    // 大厅页有（lobby.js），对局页没有 —— 于是服务一重启（比如发布新版），
    // 正在打的人只会看到一句「与服务器的连接断开了」，然后永远卡在那里，
    // 必须手动刷新。现在补齐，重连成功后自动申请回到原来这一局。
    retry: 0,             // 已重试次数（界面显示「第 N 次」）
    reconnecting: false,  // 正在自动重连中（界面据此浮出提示条）
    welcomed: false,      // 本次连接是否已完成 hello 握手
    lastPongAt: 0,        // 最近一次收到 pong 的时刻（心跳自检用）
    pingMs: 0,            // 上行往返延迟
    handshakeTimer: null,
    pingTimer: null,
    reconnectTimer: null
  };
  // 【这个对象不是 reactive，所以里面不能放任何要进模板的东西】
  // Vue 只对 reactive 对象做依赖收集；computed 读这里面的字段会**缓存住第一次的值**、
  // 永远不重算，模板也不会重渲染 —— 表现是「调试句柄里读得到正确值，界面却纹丝不动」。
  // 本轮做观战时就踩了这一脚（spectating / followSlot 一开始在 net 里，
  // 数据层全对、界面一点不变）。凡是要显示的，一律放 ui / hud。

  // 联机世界对象**只建一次**（对象本身复用），之后每帧原地改字段；
  // 地形字段（map/obstacles）随 world 走，见下面 ensureOnlineWorld。
  // 【千万不能每帧新建】render.js 用 `R._world !== w` 判断要不要重建地面纹理，
  // 而重建一次要几十到上百毫秒 —— 每帧新建等于每帧重建，画面直接卡死。
  // ★注意：联机下 `R._world` 是 world，而每帧传进去的 `w` 是这个壳，
  //   所以那个判断**在联机下每帧都成立** —— 真正兜住性能的是 buildGround
  //   内部按 mapId 的缓存（见 render.js）。也正因为如此，壳里**必须挂 map**：
  //   否则 mapId 变空 → 缓存判不中 → 真的重建 → 而 R.map 是 null → 地面纹理被清成 null。
  let onlineWorld = null;
  // 上一版 onlineWorld 挂的「地形来源」是哪个 world。
  // 用它当版本号：收到 game_start 时 world 会按房间地图重建，地形必须跟着换。
  let onlineWorldSrc = null;
  const EMPTY_LIST = [];
  // 上一帧的参战人数，只用于「人数变化时打印一次调试信息」，不参与任何逻辑
  let lastPlayersLen = -1;
  // 补 def 用的兜底：MOB_MAP 里查不到 defId 时（正常不会发生）至少别崩。
  const EMPTY_MOB_DEFS = {};
  const FALLBACK_MOB_DEF = { r: 12, tier: 1 };

  // 把「已学的槽位列表」补成**定长列表**，空位用 null 占位。
  //
  // 【为什么要补】武器与被动各有固定格数上限（const.js 的 SLOTS，现为 10 + 10），
  //   但界面原来只画已学的 ——
  //   玩家想知道「还能学几个」只能自己数，也看不出上限到底是多少。
  //   补成定长之后，空位能画成淡色空槽，一眼看到还剩几个位置。
  // ★必须返回**列表**给模板 v-for，不能在模板里写 `hud.weapons[i-1]` 这种按下标取值 ——
  //   项目踩过「模板里做复杂取值 → 渲染中断、整页白屏」的坑（连调试句柄都挂不上）。
  // ★返回新数组是有意的：它是 computed 的结果，靠 hud.weapons 的**引用变化**触发重算；
  //   而 hud.weapons 本身是在 applyHud 里按签名去抖后才赋值的，所以不会每帧重算。
  function padSlots(list, max) {
    const out = [];
    const src = list || EMPTY_LIST;
    for (let i = 0; i < max; i++) out.push(src[i] || null);
    return out;
  }

  function ensureOnlineWorld() {
    // ★★这里曾经漏挂地形（obstacles），是「联机时撞到看不见的障碍物」的真凶。
    //
    // 【为什么单机没有、只有联机有】
    //   单机渲染直接传的是 world 本身，它有 obstacles；
    //   联机渲染传的是本函数拼出来的这个「壳」——快照只带动态实体
    //   （怪/弹/拾取/玩家），**地形从来不在快照里**：它是「按 mapId 两端各算一次」
    //   的纯函数结果，只发一个地图 id。
    //   壳里没有 obstacles → drawObstacles 读到 undefined 直接 return
    //   → **整张图的障碍一个都不画**，而服务端碰撞照用真障碍
    //   → 玩家撞到「看不见的东西」。
    //
    // 【为什么用 world 的引用当版本号，而不是「建过就一直复用」】
    //   收到 game_start 时 world 会按房间地图重建（换图），那时障碍必须跟着换；
    //   写死「只建一次」的话，换图后会把旧图的障碍继续画在新图上 ——
    //   与 buildGround 的纹理缓存是同一个坑（那边已经用 mapId 做版本号了）。
    const src = world;
    if (onlineWorld && onlineWorldSrc === src) return onlineWorld;
    if (!onlineWorld) {
      onlineWorld = {
        // 渲染层会读、但快照里不带（或这一版用不到）的字段，给安全默认值
        state: 'playing',
        pauseAllOnLevelUp: false,
        spawnRadius: 1200,
        events: EMPTY_LIST,
        stats: null,
        player: null,
        self: null
      };
    }
    onlineWorldSrc = src;
    // 地形：map 是这局的战场定义，obstacles 是真正要画（也是服务端真正碰撞）的障碍。
    // 两者都从 world 借引用，不复制 —— 渲染层只读，且这样换图后自动跟着变。
    onlineWorld.map = src ? src.map : null;
    onlineWorld.obstacles = (src && src.obstacles) || EMPTY_LIST;
    // 只在地形真的换过时打一行（不是每帧）：联机排查「看不见的障碍」时，
    // 有这行就能立刻分清是「数据没挂上」还是「挂了没画出来」。
    console.log('[net] 联机地形已挂上：地图=' + (onlineWorld.map ? onlineWorld.map.id : '无') +
      ' 障碍=' + onlineWorld.obstacles.length + ' 个');
    return onlineWorld;
  }

  // 把一帧快照搬进复用的世界对象
  function applySnap(snap) {
    const w = ensureOnlineWorld();
    const list = snap.players || EMPTY_LIST;

    // 镜头跟的是「我自己」。players 是全发不裁剪的（队友永远看得见），一定找得到。
    // 顺带把渲染器要的 attrs 补上：快照为了省包体，把 attrs 整包拍平成顶层一个
    // pickupRadius（见 match.js 的 packPlayers 注释），而 render.js 画拾取范围圈
    // 时读的是 p.attrs.pickupRadius。这里还原成渲染器认的形状，顺便把队友也补上
    // —— 以后要画队友就不用再改这里了。
    // 队友昵称：快照里**刻意不带**（见 server/game/match.js 的 packPlayers —— 中文
    // 昵称每帧发一遍，4 人 20Hz 就是 0.6 KB/s 白烧带宽），名单只在开局那包
    // game_start 全量给过一次，存在 net.players。这里按 slot 关联回快照对象，
    // 渲染层画队友头顶名牌时直接读 p.name。
    // 用双层小循环而不是建 slot->name 映射表：一局最多 4 人、最多 16 次比较，
    // 换来「每帧零对象分配」，比建表划算。
    const roster = net.players || EMPTY_LIST;
    let me = null;
    for (let i = 0; i < list.length; i++) {
      const pl = list[i];
      pl.attrs = { pickupRadius: pl.pickupRadius || 0 };
      pl.name = '';
      pl.avatar = '';
      for (let j = 0; j < roster.length; j++) {
        if (roster[j].slot === pl.slot) {
          pl.name = roster[j].name || '';
          pl.avatar = roster[j].avatar || '';   // 队友头顶名牌要画它
          break;
        }
      }
      if (pl.slot === net.selfSlot) me = pl;
    }
    // 观战者：selfSlot 是 -1（他不占座位），所以「我自己」不存在 ——
    // 这时要找的是「我在跟的那个人」。
    // 【为什么不能靠上面的兜底】list[0] 是座位 0，通常也是房主。观战者切到别人
    // 视角后镜头还钉在房主身上，那这个功能等于没做。所以这里按 followSlot 找。
    if (ui.spectating) {
      me = null;
      const fs = ui.followSlot;
      for (let i = 0; i < list.length; i++) {
        if (list[i].slot === fs) { me = list[i]; break; }
      }
      if (!me) me = list[0] || null;   // 跟随目标不在（刚倒下/刚走）→ 先退回第一个
    }
    if (!me) me = list[0] || null;

    // 调试：参战人数有变化时喊一声。排查「看不到队友」时，靠这行先分清是
    // 「服务端根本没发够人（数据问题）」还是「发了但没画出来（渲染问题）」。
    if (list.length !== lastPlayersLen) {
      lastPlayersLen = list.length;
      const brief = [];
      for (let i = 0; i < list.length; i++) {
        brief.push('#' + list[i].slot + (list[i].name ? '(' + list[i].name + ')' : ''));
      }
      console.log('[net] 本帧玩家 ' + list.length + ' 人: ' + brief.join(' ') +
        '｜我是 #' + net.selfSlot);
    }

    w.tick = snap.tick;
    w.time = snap.time;
    w.wave = snap.wave;
    w.won = !!snap.won;
    w.aliveMobCount = snap.aliveMobCount;
    w.players = list;
    w.player = me;                // render.js 用它当镜头中心
    w.self = me;
    w.mobs = snap.mobs || EMPTY_LIST;
    w.projectiles = snap.projs || EMPTY_LIST;
    w.zones = snap.zones || EMPTY_LIST;
    w.strikes = snap.strikes || EMPTY_LIST;
    w.orbits = snap.orbits || EMPTY_LIST;
    w.pickups = snap.pickups || EMPTY_LIST;
    w.effects = snap.fx || EMPTY_LIST;
    w.enemyShots = snap.shots || EMPTY_LIST;

    // 【快照 → 世界形状】的唯一一处「翻译」：怪。
    // 服务端快照里的怪是**扁平字段**（server/game/match.js 的 F_MOB 白名单：
    // id/defId/x/y/px/py/hp/r/alive…），而 render.js 画怪时读的是 m.def.r
    // 与 m.def.tier（它一直跑的是单机那套 sim 实体形状，实体身上挂着 def 引用）。
    // 所以这里按 defId 从 CONST.MOB_MAP 把 def 引用补回去。
    // 注意两点：① MOB_MAP 里是共享对象，原地挂引用、零分配；
    //          ② 是「原地挂在快照对象上」，不是新建对象 —— 快照对象本来就每帧
    //             是新的（JSON 解析出来的），render.js 只对「世界对象」做引用比较。
    const mobs = w.mobs;
    const mobDefs = (C && C.MOB_MAP) || EMPTY_MOB_DEFS;
    for (let i = 0; i < mobs.length; i++) {
      const m = mobs[i];
      if (!m.def) m.def = mobDefs[m.defId] || FALLBACK_MOB_DEF;
    }
    return w;
  }

  function sendNet(obj) {
    if (net.ws && net.ws.readyState === 1) {
      net.ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  // ============================================================
  // 联机：连接与自动重连
  // ============================================================
  //
  // 【为什么光有 onclose 不够】这是踩过的坑，三道防线缺一就会出现
  // 「明明断了却永远不重连，只能手动刷新」：
  //   ① 容器重启（例如发布新版）时 TCP 常常进入「半开」——
  //      消息发得出去、收不回来，而 **onclose 根本不会触发**；
  //   ② 连上了但服务端正在重启，没人处理 hello，握手永远不完成；
  //   ③ 中间设备把连接丢了，客户端却还以为是好的。
  // 所以除了 onclose，另加了「握手超时」与「心跳超时」两道自检：
  // 任何一道超时都主动掐断，汇进同一条重连路径。
  // 重连成功后走的是既有的 welcome → room_join 流程，
  // 服务端那边的 match 还挂起等着（suspend/resume），世界原地续上。
  const RECONNECT_MAX_MS = 10000;
  const HANDSHAKE_TIMEOUT_MS = 8000;
  const PING_TIMEOUT_MS = 12000;

  function clearNetTimers() {
    if (net.handshakeTimer) { clearTimeout(net.handshakeTimer); net.handshakeTimer = null; }
    if (net.pingTimer) { clearInterval(net.pingTimer); net.pingTimer = null; }
  }

  function startPingLoop() {
    if (net.pingTimer) clearInterval(net.pingTimer);
    net.lastPongAt = Date.now();
    net.pingTimer = setInterval(function () {
      if (!sendNet({ t: 'ping', ts: Date.now() })) return;
      if (net.welcomed && Date.now() - net.lastPongAt > PING_TIMEOUT_MS) {
        console.log('[net] 心跳超时：' + PING_TIMEOUT_MS + 'ms 没收到 pong，主动断开重连');
        dropAndReconnect('心跳超时');
      }
    }, 5000);
  }

  // 主动掐断并走统一的「等一会儿重连」路径。
  // 先摘掉 onclose 再 close：否则「掐断」本身又触发一次 onclose 重连，
  // 两条重连链互相叠加，退避会翻倍乱套。
  function dropAndReconnect(why) {
    console.log('[net] 断开重连，原因：' + why);
    const ws = net.ws;
    net.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try { ws.close(); } catch (e) { /* 关不掉也没关系，新连接会顶替它 */ }
    }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (net.reconnectTimer) return;      // 已经排好了，别重复排
    if (net.state === 'ended') return;   // 对局已经结束，这条连接不再需要
    // failed = 服务端明确说了「这连接没救了」（token 失效、房间没了）。
    // 这时候还重连就是一个永不停止的循环：连上 → 又被拒 → 再连 …
    if (net.state === 'failed') return;
    net.reconnecting = true;
    net.retry += 1;
    const delay = Math.min(1000 * Math.pow(2, net.retry - 1), RECONNECT_MAX_MS);
    console.log('[net] ' + delay + 'ms 后重连（第 ' + net.retry + ' 次）');
    net.reconnectTimer = setTimeout(function () {
      net.reconnectTimer = null;
      connectOnline();
    }, delay);
  }

  function connectOnline() {
    clearNetTimers();
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(proto + '//' + location.host + '/ws');
    net.ws = ws;
    net.welcomed = false;

    // 【必须设】浏览器的 WebSocket 默认把二进制帧递成 Blob，那样就拿不到
    // 字节视图，只能异步 FileReader —— 白白多一次异步、还不好调试。
    // 设成 arraybuffer 后 ev.data 直接是 ArrayBuffer。
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      console.log('[net] 已连接，发送 hello 握手');
      // 用大厅那一套握手势：有 token 用 token（账号），否则报昵称（游客）。
      // 必须让服务端认出「我就是刚才在大厅里的那个人」—— 对局是按房间成员
      // 名单 + 座位号认人的，认错了就会多出一个幽灵玩家。
      const hello = { t: 'hello' };
      const token = localStorage.getItem('vs_token');
      if (token) hello.token = token;
      else hello.nickname = nickname;
      // 带上在大厅选的头像：对局名单里的头像就是从这里来的，
      // 队友头顶名牌靠它区分人。
      // 【必须走 AVATARS.readSaved()（sessionStorage 优先）】以前这里直接读
      // localStorage，而它是同浏览器所有标签页共享的 —— 同机双开对测时，
      // 后选头像的窗口会把前一个覆盖掉，两人握手都上报同一个 id，
      // 游戏里图标就长得一模一样。键的读写统一收在 shared/avatars.js 里，别在页面里自己拼。
      const AV = window.VS && window.VS.AVATARS;
      const savedAvatar = AV ? AV.readSaved() : '';
      if (savedAvatar) hello.avatar = savedAvatar;
      ws.send(JSON.stringify(hello));
      // 这里可以紧接着起心跳：它内部是 setInterval，第一条 ping 在 5 秒后才发，
      // 那时握手早已完成。大厅不一样 —— 那边是「发完 hello 立刻手动发一条 ping」，
      // 会赶在异步握手之前到达，所以那边必须等 welcome 之后再起（见 lobby.js）。
      // 服务端现在对「握手前来的 ping」也只回 pong、不断连，两边都不会再踩到。
      startPingLoop();

      // 握手超时自检：TCP 连上不等于握手成功（见本段开头的说明）
      net.handshakeTimer = setTimeout(function () {
        if (net.welcomed) return;
        dropAndReconnect('握手超时：' + HANDSHAKE_TIMEOUT_MS + 'ms 没收到 welcome');
      }, HANDSHAKE_TIMEOUT_MS);
    };

    ws.onmessage = function (ev) {
      // 下行有两种帧：JSON 文本（房间/HUD/事件/结算）与二进制（P2-5 的世界快照）。
      // 靠 ev.data 的类型分流，协议里不需要额外的类型字段。
      if (typeof ev.data !== 'string') {
        handleBinSnap(ev.data);
        return;
      }
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      handleNet(msg);
    };

    ws.onclose = function () {
      console.log('[net] 连接已关闭');
      // 只清理这条连接自己的定时器；重连定时器不能动（它就是下一步）
      if (net.pingTimer) { clearInterval(net.pingTimer); net.pingTimer = null; }
      if (net.handshakeTimer) { clearTimeout(net.handshakeTimer); net.handshakeTimer = null; }
      if (net.ws === ws) net.ws = null;
      if (net.state === 'ended') return;
      // 不再把 state 标成 failed：那会让界面显示成「加入失败」的死路，
      // 而实际上它马上就会自己接回来。失败态只留给服务端明确报的错。
      scheduleReconnect();
    };

    ws.onerror = function () { console.log('[net] 连接出错'); };
  }

  // 二进制快照帧 → 世界快照。
  // 解码要带上上一帧：服务端在「快照频率 == 逻辑帧率」时会省掉 px/py，
  // 客户端按 id 从上一帧的 x/y 把 px/py 补回来（见 shared/proto_bin.js 的注释）。
  // 解码失败返回 null —— 丢掉这一帧就好，绝不能让它把页面搞崩。
  function handleBinSnap(buf) {
    const snap = PB.decode(buf, net.prevSnap);
    if (!snap) {
      net.binFail += 1;
      // 只在第一次失败时喊一声，避免坏帧持续输出刷爆控制台
      if (net.binFail === 1) console.log('[net] 二进制快照解码失败（两端协议版本可能不一致），已丢弃该帧');
      return;
    }
    net.prevSnap = snap;
    net.snap = snap;
    net.snapAt = performance.now();
    net.snapBytes += buf.byteLength || 0;
    net.snapCount += 1;
    net.binFrames += 1;
  }

  function handleNet(msg) {
    // 握手完成：立刻申请回到这一局。
    // 服务端那边我们刚才处于断线状态（大厅页跳过来时连接断了），
    // 对局已被挂起等着我们回来（server/game/match.js 的 suspend/resume）。
    if (msg.t === 'welcome') {
      // 握手成功 = 连接确实活了：撤掉握手超时自检、清掉重连计数与提示。
      // 这几行是「重连后界面自动恢复正常」的关键 —— 少了它，提示条会一直挂着。
      net.welcomed = true;
      if (net.handshakeTimer) { clearTimeout(net.handshakeTimer); net.handshakeTimer = null; }
      net.retry = 0;
      net.reconnecting = false;
      ui.netErr = '';
      console.log('[net] 握手完成，申请回到对局 ' + roomCode);
      // 顺手把视口尺寸（CSS 像素）报上去，服务端按人算「我这块屏能看到的矩形」再下发。
      // 为什么不由服务端拍一个全局值：它不知道对面是笔记本还是大屏 ——
      // 全局值要么小屏玩家白收一堆画不出来的实体，要么大屏玩家在屏幕角落看到怪凭空出现。
      // 服务端还会在相机矩形外放宽 config.viewPad，覆盖渲染余量 + 相机平滑滞后。
      //
      // 观战发的是 spectate 而不是 room_join —— 这一条是「观战只看不打」的分界线。
      // 房间成员表里从此没有他：不占 maxPlayers、不出现在候场室、不进这一局的结算。
      if (SPECTATING) {
        sendNet({
          t: 'spectate',
          code: roomCode,
          viewW: window.innerWidth,
          viewH: window.innerHeight
        });
        return;
      }
      sendNet({
        t: 'room_join',
        code: roomCode,
        charId: ui.charId,
        viewW: window.innerWidth,
        viewH: window.innerHeight
      });
      return;
    }

    if (msg.t === 'game_start') {
      net.selfSlot = msg.selfSlot;
      net.players = msg.players || [];
      if (msg.snapshotHz) net.snapInterval = 1000 / msg.snapshotHz;
      net.state = 'playing';
      ui.netSlot = msg.selfSlot;
      ui.netPlayers = net.players;
      ui.screen = 'playing';        // 联机不走角色选择界面

      // 联机：地图以**服务端**为准，本机重建一次「背景世界」。
      // 为什么联机也要建：本地世界不跑模拟（tick 永远是 0），但地面纹理与障碍
      // 正是从它画出来的。不按服务端的图重建，就会出现「人站在钟楼广场、
      // 地面却铺着 URL 上那张默认墓园」—— 服务端说什么就是什么。
      if (ONLINE && msg.mapId) {
        mapId = msg.mapId;
        world = buildWorld();
        renderer.buildGround(world);
        const mm = world.map;
        hud.mapName = mm.name;
        console.log('[map] 联机地图=' + mm.id + ' ' + mm.name +
          ' 尺寸=' + mm.w + 'x' + mm.h + ' 障碍=' + world.obstacles.length);
      }

      // 观战者记下自己在跟谁。selfSlot=-1 意味着「我不画自己的 HUD」；
      // followSlot 意味着「我的相机对准这个人」。
      if (msg.spectating) {
        ui.spectating = true;
        ui.followSlot = (msg.followSlot === undefined ? -1 : msg.followSlot);
        console.log('[spec] 进入观战 房间=' + roomCode + ' 跟随座位=' + ui.followSlot +
          ' 被观战=' + net.players.length + ' 人');
        pushToast('正在观战 · 战斗中不能操作', false);
      }
      // 难度与时长：开局面板要立刻显示，不能等第一次 HUD（约 100ms 后）才出现 ——
      // 那一下会看到标题栏里空一块再补上
      if (msg.matchSec) hud.matchSec = msg.matchSec;
      const d = msg.difficulty && C.DIFF_MAP ? C.DIFF_MAP[msg.difficulty] : null;
      if (d) { hud.diffId = d.id; hud.diffName = d.name; }
      console.log('[net] 进入对局 座位=' + msg.selfSlot + ' 参战=' + net.players.length + ' 人' +
        ' 快照=' + (msg.snapshotHz || 20) + 'Hz' + (msg.midJoin ? '（中途加入）' : '') +
        (d ? ' 难度=' + d.name : '') +
        (msg.resumed ? '（已接回断线前进度）' : ''));
      if (msg.resumed) pushToast('重连成功，已恢复上次进度', false);
      return;
    }

    // 名单更新：有人中途加入 / 重连回来 / 离开时服务端补发。
    // 【为什么不能只靠 game_start】多人从大厅页跳进对局时各人重连有先后，
    // 先回来的那位收到的 game_start 里可能只有他自己（队友还没回连），
    // 之后队友回来只会触发一条 ally_join 事件 —— 名单就永久停在 1 项了，
    // 表现是「队友画出来了、头顶名牌却是空的」。这条消息把这个缺口补上。
    if (msg.t === 'roster') {
      net.players = msg.list || [];
      ui.netPlayers = net.players;
      console.log('[net] 名单已更新：' + net.players.length + ' 人（' +
        net.players.map(function (m) { return '#' + m.slot + (m.name ? '(' + m.name + ')' : ''); }).join(' ') + '）');
      return;
    }

    // JSON 快照：只在服务端关掉二进制协议时（BIN_SNAP=0）才会走到。
    // 留着它有两个用处：① 二进制出问题时能一键退回对照；② 老版本客户端连新服务端
    // 时至少还有条路。正常对局里这个分支一次都不该进。
    if (msg.t === 'snap') {
      net.snap = msg;
      net.prevSnap = msg;
      net.snapAt = performance.now();
      net.snapBytes += JSON.stringify(msg).length;
      net.snapCount += 1;
      return;
    }

    if (msg.t === 'hud') {
      applyHud(msg);
      return;
    }

    // 切换跟随视角（观战）。服务端只回这一个 seat 号 —— followSlot 不进快照帧，
    // 因为帧头是固定布局，每帧多带一个数字一局就是好几 MB，而切视角是低频事件。
    if (msg.t === 'spectate_follow') {
      ui.followSlot = msg.slot;
      const p = (net.players || []).filter(function (x) { return x.slot === msg.slot; })[0];
      pushToast('已切换到 ' + (p && p.name ? p.name : '座位 ' + msg.slot), false);
      console.log('[spec] 跟随座位=' + msg.slot);
      return;
    }

    if (msg.t === 'spectate_stop') {
      console.log('[spec] 服务端已结束观战，回大厅');
      try { sessionStorage.removeItem('vs_spec'); } catch (e) { /* 隐私模式忽略 */ }
      goLobby('服务端结束观战');
      return;
    }

    // 心跳回包：证明这条连接真的活着（心跳超时自检读它，见 startPingLoop）
    if (msg.t === 'pong') {
      net.lastPongAt = Date.now();
      if (msg.ts) net.pingMs = Math.max(0, Date.now() - msg.ts);
      return;
    }

    if (msg.t === 'ev') {
      const list = msg.list || [];
      for (let i = 0; i < list.length; i++) applyEvent(list[i]);
      return;
    }

    if (msg.t === 'game_over') {
      net.state = 'ended';
      ui.screen = 'result';
      // 全队战绩：结算包里本来就有（按击杀降序），以前前端只读了自己那一份 hud。
      // 中途退出的人也在里面（带 left 标记）—— 那一局他们确实参战了。
      ui.resultList = msg.result || [];
      // 观战者：这一局他没参与，结算面板不该写「你打到了第几波 / 你被谁杀了」。
      // 只播一句「观战结束」。
      if (msg.spectating || ui.spectating) {
        console.log('[spec] 观战结束：这一局打完了（观战者不是参战者）');
        return;
      }
      console.log('[net] 对局结束 reason=' + msg.reason +
        ' 参战=' + ui.resultList.length + ' 人（已记入战绩的是账号玩家）');
      return;
    }

    if (msg.t === 'error') {
      console.log('[net] 服务端错误 code=' + msg.code + ' msg=' + msg.msg);

      // 登录态失效：清掉本地 token 并**停止重连**。
      // 【不加这条会怎样】服务端会回 BAD_TOKEN 并关掉连接 → onclose → 自动重连 →
      // 新的 hello 又是坏 token → 再被拒 …… 变成一个永远转圈的「正在自动重连」，
      // 玩家看着像网络问题，其实是账号状态问题，怎么等都等不回来。
      if (msg.code === 'BAD_TOKEN') {
        net.state = 'failed';
        net.error = '登录状态已失效，请重新登录';
        ui.netErr = net.error;
        ui.screen = 'connecting';
        ui.netReconnecting = false;
        net.reconnecting = false;
        net.retry = 0;
        if (net.reconnectTimer) { clearTimeout(net.reconnectTimer); net.reconnectTimer = null; }
        try { localStorage.removeItem('vs_token'); } catch (e) { /* 隐私模式忽略 */ }
        return;
      }

      // 房间解散 / 不在对局里：明确告诉玩家，别再傻等
      if (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'NOT_IN_ROOM' ||
        msg.code === 'JOIN_FAILED' || msg.code === 'ROOM_FULL') {
        net.state = 'failed';
        net.error = msg.msg || '加入对局失败';
        ui.netErr = net.error;
        ui.screen = 'connecting';
      }
      return;
    }
  }

  // 上行移动意图。20Hz 就够（服务端也是按 20Hz 消费的），发太快纯属浪费带宽。
  function sendInput(now) {
    // 观战者不发操作。
    // 【为什么客户端就要挡】服务端也拦了（观战者不在 matchByConn 里，onInput 查不到他），
    // 但那属于「服务端兜底」。客户端这层是为了省带宽与避免误操作：
    // 观战时按 WASD/方向键本该是切视角，不该有人物自己跑起来。
    if (ui.spectating) return;
    if (now - net.lastSendAt < STEP_MS) return;
    net.lastSendAt = now;
    const d = input.update();
    net.seq += 1;
    sendNet({ t: 'input', mx: d.mx, my: d.my, seq: net.seq });
  }

  // ============================================================
  // 运行时对象
  // ============================================================

  let world = null;
  let renderer = null;
  let input = null;
  let acc = 0;
  let lastNow = 0;
  let rafId = 0;
  let toastSeq = 0;
  // HUD 数组同步用的签名缓存，避免每帧重建响应式数组
  let lastSlotSig = '';
  let lastChoices = null;
  // 倒计时按「整秒变化」才写响应式：timeLeft 是浮点数，
  // 每帧都写会让 Vue 每秒重渲染 60 次，而屏幕上那行字每秒才变 1 次
  let lastSec = -1;
  // 剧情字段的签名（见 syncHud 里的说明）
  let lastStorySig = '';
  let lastBossSig = '';
  // 角色详细数据的签名缓存。同上：属性每次升级都变，但不该每帧重建那个对象 ——
  // 暂停面板里要显示它，重建代价是整块面板重渲染。
  let lastDetailSig = '';

  // 按视口大小算怪物生成半径：屏幕外 200px 的环
  function computeSpawnRadius() {
    const half = Math.sqrt(window.innerWidth * window.innerWidth +
      window.innerHeight * window.innerHeight) / 2;
    return half + 200;
  }

  // ============================================================
  // 起一局 / 重开
  // ============================================================

  // 统一的建世界入口：boot 时先建一个用来铺背景，真正开局时再重建一个干净的
  function buildWorld() {
    return SIM.createWorld({
      // ★剧情关：player 在卷首页换过角色就用他选的，没换就传 null
      //   （null → sim 按关卡的 startChar 建人）。
      //   「能换角色」这一条就是靠这里实现的 —— sim 侧的优先级是
      //   storyStage.startChar > opts.charId，但那是「关卡默认」；
      //   而玩家主动选的角色必须能盖过它，所以这里不能传 null。
      charId: storyStage ? (ui.charId || null) : ui.charId,
      // 种子随机取，但会打进日志，便于复现问题
      seed: (Date.now() & 0x7fffffff),
      mapId: mapId,          // 单机来自 ?map=；联机由房间决定，这里只是本地默认值
      modId: modId,          // 剧情模组（自由模式恒为 'vanilla'）
      // ★用 realStageId（校验后的）而不是 URL 里的 stageId：
      //   手输一个未解锁的关卡会被静默降级，世界必须按降级后的关卡来建。
      stageId: realStageId,  // 剧情关卡（自由模式为空）
      // 难度：卷首页选了哪一档。自由模式传空 → sim 回落「普通」，
      // 与改造前完全一致（原来 createWorld 根本不传这个参数）。
      difficulty: ui.diffId || undefined,
      spawnRadius: computeSpawnRadius()
    });
  }

  function startMatch() {
    world = buildWorld();
    // 地面纹理是整张预渲染的，建一次要几十到上百毫秒。
    // 放在这里（开局瞬间）做掉，别留到第一帧渲染时卡一下。
    renderer.buildGround(world);
    // 地图名写进 HUD（联机时由 game_start 覆盖成服务端那张）。
    // ★优先走开局缓存的 nameTable：剧情模式的地图名与数据表本名不同。
    //   这一句只是「首帧就有名字」的即时赋值，之后由 syncHud 持续校正。
    hud.mapName = (world.nameTable && world.nameTable.map[world.map.id]) || world.map.name;

    acc = 0;
    lastNow = 0;
    ui.toasts = [];
    ui.pendingLevels = 0;
    ui.surviveText = '0秒';
    ui.screen = 'playing';

    // 把玩家选择记到本地，下次进来默认还是这个角色。
    // ★剧情模式不写：那里的 ui.charId 表示「主动换成了谁」，空值是常态，
    //   写进去会把自由模式的角色偏好清掉（'' → 下次单人游戏退回猎魔人）。
    if (!isCampaign) profile.charId = ui.charId;
    try {
      localStorage.setItem('vs_profile', JSON.stringify(profile));
      // 剧情难度按「模组 / 关卡」分别记 ——
      // 第五关想用噩梦难度、第一关想用休闲，这两个选择互不干扰。
      if (storyStage && ui.diffId) {
        const bag = JSON.parse(localStorage.getItem('vs_story_diff') || '{}');
        bag[modId + '/' + realStageId] = ui.diffId;
        localStorage.setItem('vs_story_diff', JSON.stringify(bag));
      }
    } catch (e) { /* 隐私模式下写不了，忽略 */ }

    console.log('[game] 开局 charId=' + ui.charId + ' 种子=' + world.rngState +
      ' 生成半径=' + Math.round(world.spawnRadius));
  }

  // ============================================================
  // 界面动作
  // ============================================================

  function pickChar(c) {
    ui.charId = c.id;
  }

  // 暂停 / 联机菜单
  // 单机：真暂停（世界就在本地，说了算）。
  // 联机：**没有「暂停」这回事** —— 世界在服务端推进，你一个人停不下来。
  //   Esc 打开的是一个「不冻结世界的菜单」，只提供 继续 / 返回大厅。
  //   【联机绝不能进 'paused'】那样会弹出一个「对局已停止推进」的面板，
  //   可怪其实还在动、队友照常打 —— 界面自相矛盾（用户实测反馈过）。
  // 当前游戏倍速。只回 1 / 2 / 4，脏值一律当 1 —— 这个数会被乘进「时间入口」，
  // 一旦是 NaN 或负数，整个主循环会立刻停摆（比加速失效严重得多）。
  function gameSpeed() {
    if (ONLINE) return 1;                 // 联机不加速：世界不在本机推进
    return (ui.speed === 2 || ui.speed === 4) ? ui.speed : 1;
  }

  // 切换倍速：1 → 2 → 4 → 1 循环。
  // 【为什么不做成三档并排的按钮】顶栏右侧那一行在手机上只有 ~180px，
  //   已经放了「暂停」和「?」，再塞三个档位必然挤爆。一个循环按钮只占一格。
  function cycleSpeed() {
    const next = ui.speed === 1 ? 2 : (ui.speed === 2 ? 4 : 1);
    ui.speed = next;
    // ★重置时间基准：切换那一帧的 dt 是「按旧倍速攒到现在」的间隔，
    //   直接按新倍速算会让画面跳一下。置 0 后下一帧从 0 开始算。
    lastNow = 0;
    pushToast(next > 1 ? ('游戏速度 ×' + next) : '恢复正常速度', false);
    console.log('[game] 游戏倍速 = ×' + next + (ONLINE ? '（联机不生效）' : ''));
  }

  function togglePause() {
    if (ONLINE) {
      if (ui.screen === 'playing') {
        ui.screen = 'menu';
        console.log('[net] 打开联机菜单（世界仍由服务端推进，不暂停）');
      } else if (ui.screen === 'menu') {
        ui.screen = 'playing';
      }
      return;
    }

    if (ui.screen === 'playing') {
      ui.screen = 'paused';
      console.log('[game] 已暂停（世界冻结，暂停面板应已显示）');
    } else if (ui.screen === 'paused') {
      ui.screen = 'playing';
      // 恢复时把时间基准清掉，否则会把暂停的这一段当成卡顿补步
      lastNow = 0;
      acc = 0;
      console.log('[game] 已继续（世界恢复推进）');
    }
  }

  function restart() {
    startMatch();
  }

  // 【为什么所有回大厅的地方都走这一个函数】
// 旧代码是五处各自 `window.location.href = '/'` —— 那是在历史栈上**再压一条**。
// 于是「大厅 → 对局 → 返回大厅」之后栈是 [大厅][对局][大厅]，
// 玩家再按返回就被弹回那个已经结束的对局（这正是「返回会关闭整个站」的由来）。
// goLobby 统一改走 history.back()，栈不增长；没有来路时（扫码/收藏直接进来的）
// 退化成 location.replace，同样不会留下「回去又回到对局」的死结。
// 全部逻辑在 public/js/nav.js（与大厅页共用同一份，避免两边行为不一致）。
function goLobby(why) {
  const NAV = window.VS && window.VS.NAV;
  if (!NAV || !NAV.backToLobby) {
    // nav.js 没加载上（理论上不会，它是无依赖的小文件）：退回最朴素的做法。
    // ★用 replace 而不是 href —— 后者会再压一条历史，正是本次要消灭的问题。
    console.warn('[game] nav 不可用，退回 location.replace（' + why + '）');
    window.location.replace('/');
    return;
  }
  NAV.backToLobby(why);
}

  function backToLobby() {
    // 观战：退观战，不是「离开对局」—— 发错消息的话服务端会以为他退出了这一局，
    // 连带把房主位给移交了（onGameLeave 里那段逻辑）。
    if (ui.spectating) {
      sendNet({ t: 'spectate_stop' });
      try { sessionStorage.removeItem('vs_spec'); } catch (e) { /* 隐私模式忽略 */ }
      goLobby('观战者返回大厅');
      return;
    }
    // 联机时先跟服务端打声招呼再走：不打招呼的话，队友要等到心跳超时
    // 才会看到「他掉线了」，这一局也会白白挂起一段时间。
    if (ONLINE) sendNet({ t: 'game_leave' });
    goLobby('退出对局');
  }

  // 对局结束后回候场室，等下一局（房主在这里点「开始对局」就能原地再来一局）。
  //
  // 【为什么不发 game_leave】对局已经结束了，服务端那边房间还开着、状态也回到了 waiting
  // （match 收尾时会把大家留在房间里，并把房主置为已准备），就是等着「原地再来一局」。
  // 这时候发 game_leave 等于主动退房 —— 房主就再也没法原地开局了。真想走人要点「返回大厅」。
  //
  // 房间号必须存进 sessionStorage：回到大厅是一个新页面，内存里的 roomCode 会丢，
  // lobby.js 启动时读它自动重进（否则玩家得自己去房间列表里再找一遍）。
  function backToRoom() {
    try {
      sessionStorage.setItem('vs_rejoin', roomCode);
    } catch (e) {
      console.log('[game] 房间号存本地失败（隐私模式？），回大厅后需要手动重进房间');
    }
    goLobby('回到候场室');
  }

  // ---------------- 观战控制 ----------------
  // 切到下一个玩家。观战者最常用的操作就是「看看别人打得怎么样」，
  // 给一排按钮不如一个循环切换：人少时一个按钮够用，也不占地方。
  //
  // 【为什么按名单顺序而不是「下一个活着的」】服务端已经处理了「跟随目标倒了
  // 自动换人」，这里只管玩家主动切 —— 主动切时就是要切到某个**具体的人**，
  // 不该被「他还活着没有」这种隐式判断改掉。
  function cycleFollow() {
    if (!ui.spectating) return;
    const list = net.players || [];
    if (list.length < 2) return;
    let idx = -1;
    for (let i = 0; i < list.length; i++) {
      if (list[i].slot === ui.followSlot) { idx = i; break; }
    }
    const next = list[(idx + 1) % list.length];
    if (!next) return;
    // 视口尺寸一起报：切视角换了窗口大小的话（观战者中途拖窗口），
    // 顺带更新一下裁剪范围，免得白白收窄或收宽。
    sendNet({
      t: 'spectate_follow',
      slot: next.slot,
      viewW: window.innerWidth,
      viewH: window.innerHeight
    });
    // 本地先改：等服务端回执才切会有一次可感知的延迟
    ui.followSlot = next.slot;
  }

  function stopSpectate() {
    // 先跟服务端说一声：不说的话，服务端那边的观众表要等心跳超时才清。
    sendNet({ t: 'spectate_stop' });
    try { sessionStorage.removeItem('vs_spec'); } catch (e) { /* 隐私模式忽略 */ }
    goLobby('退出观战');
  }

  // ---------------- 技能图鉴 ----------------
  //
  // 【为什么图鉴不切 screen、也不碰世界】
  // 联机世界里推进权在服务端，本机无论如何都停不下来。所以图鉴做成正交于
  // screen 的一个布尔开关：开它不影响升级、暂停、结算的任何一条既有分支
  // （那几条分支的判断条件里都没有 helpOpen，也没有它们去判断 helpOpen）。
  //
  // 【为什么不复用 .overlay】.overlay 是全屏遮罩 + blur，用它就等于「战场看不见了」。
  // 而查图鉴时玩家往往正在被怪追 —— 遮住战场等于让他一边读文字一边被打。
  // 抽屉只占右侧一条，左边战场与摇杆全程可用。
  function openHelp(tab) {
    if (tab) ui.helpTab = tab;
    ui.helpOpen = true;
  }

  function closeHelp() {
    ui.helpOpen = false;
  }

  function toggleHelp() {
    if (ui.helpOpen) closeHelp();
    else openHelp();
  }

  function chooseHelp(tab) {
    ui.helpTab = tab;
  }

  // ---------------- 局内商店（花金币）----------------
  //
  // 【为什么钱与效果的结算放在 sim 里】界面先扣钱再让 sim 加血，中途出错就变成
  // 「钱没了血没回」。所以 sim 的 shopBuy 一次判定、一次扣、一次生效，
  // 返回 { ok, reason }；这里只负责把结果翻译成界面状态。
  //
  // 【为什么联机没有商店】联机世界由服务端推进，停不下来。
  // 绝不做「联机也能买」的半吊子：那等于花钱在一个不会停的世界里换东西，
  // 队友还在打你却被砍一刀。canShop 直接返回 false。
  function buy(itemId) {
    if (!world) return;
    // ★两段式商品（血脉契约 / 置换契约）：它们不知道玩家要哪一件技能，
    //   所以点商品**只开选择器**，真正扣钱发生在 confirmPick（带着选择再调一次 sim.shopBuy）。
    //   这样「钱与效果一次结算」这条不变式没被破坏 —— 只是把「选哪件」挪到了界面层。
    const it = itemOf(itemId);
    if (it && it.pick) {
      openPick(itemId);
      return;
    }
    const r = SIM.shopBuy(world, itemId);
    if (!r.ok) {
      ui.shopMsg = r.reason || '买不了';
      return;
    }
    ui.shopMsg = r.item.name + ' 已生效';
    afterShopChange();
  }

  // 买完之后的共同收尾。
  function afterShopChange() {
    // 立刻把 HUD 拉齐：买完血/经验/伤害/技能变了，顶栏、槽位与角色数据要马上反映出来，
    // 否则玩家会盯着没变的数字以为没生效（世界是暂停的，不会靠下一帧自动刷）
    syncHud();
    // 「亡者笔记」会触发升级三选一（它走的是 gainExp），而当前 screen 是 'paused' ——
    // 不切的话升级面板不会弹出来，玩家会觉得「买了没反应」。
    // 只在真的升了级时才切（gainExp 挂了 pendingLevels）。
    if (world && world.self && world.self.pendingLevels > 0) {
      ui.screen = 'levelup';
    }
  }

  // ---------------- 两段式商店：买技能 / 换技能 ----------------

  function openPick(itemId) {
    const it = itemOf(itemId);
    if (!it || !it.pick) return;
    ui.pick.open = true;
    ui.pick.itemId = itemId;
    ui.pick.mode = it.pick;      // 'new' | 'swap'
    ui.pick.drop = '';
    ui.pick.pick = '';
    ui.shopMsg = '';
    console.log('[shop] 打开选择器：' + it.name + '（模式 ' + it.pick + '）');
  }

  // 关掉选择器时把选择一并清掉 —— 否则下次打开会带着上次的选择
  // （玩家会以为「已经选好了」，然后点确认花掉一笔不是他要的钱）。
  function closePick() {
    ui.pick.open = false;
    ui.pick.itemId = '';
    ui.pick.mode = '';
    ui.pick.drop = '';
    ui.pick.pick = '';
  }

  // 点清单里的某一项。
  // 置换模式下按「已拥有 / 未拥有」自动分流：已拥有的那件一定是**要遗忘的**，
  // 未拥有的是**要换上的** —— 玩家不必先想「我现在在第几步」，点错的代价也只是再点一下。
  function pickChoose(id) {
    if (ui.pick.mode === 'swap') {
      if (lvOf(id) > 0) ui.pick.drop = (ui.pick.drop === id) ? '' : id;
      else ui.pick.pick = (ui.pick.pick === id) ? '' : id;
      return;
    }
    ui.pick.pick = (ui.pick.pick === id) ? '' : id;
  }

  function confirmPick() {
    if (!world || !ui.pick.open) return;
    const opt = (ui.pick.mode === 'swap')
      ? { drop: ui.pick.drop, pick: ui.pick.pick }
      : { pick: ui.pick.pick };
    const r = SIM.shopBuy(world, ui.pick.itemId, null, opt);
    if (!r.ok) {
      // 被拒时**不关选择器**：玩家要能就地改一下再点确认，
      // 关掉的话他得重新点商品、重新找那件技能（选择器里可有三十来项）。
      ui.shopMsg = r.reason || '买不了';
      return;
    }
    let msg = r.item.name + ' 已生效';
    if (r.added) msg += '：习得 ' + skillName(r.added);
    if (r.dropped) msg += '，遗忘 ' + skillName(r.dropped);
    ui.shopMsg = msg;
    closePick();
    afterShopChange();
  }

  // 这件商品现在买不买得了。禁用按钮必须同时给出原因，
  // 所以「买不了」和「为什么」是两个函数。
  function canBuy(item) {
    if (isMaxed(item)) return false;
    return hud.shopGold >= item.price;
  }

  function isMaxed(item) {
    if (!item.maxStacks) return false;
    return hud.buffStacks >= item.maxStacks;
  }

  // ---------------- 技能说明卡（点左下角技能格）----------------
  //
  // 【要解决的问题】战斗里最常冒出来的疑问是「我身上这件到底干嘛的、能不能凑出组合技」，
  //   而答案原来只写在技能图鉴里 —— 要另开抽屉、再翻到对应分类。
  //   技能格本来就摆在屏幕上，点一下直接给答案，比「记得去翻图鉴」自然得多。
  //
  // 【说明内容一个字都不手写】全部来自 skillbook.js（它从 const.js 现算）。
  //   这里只补「玩家自己有没有、几级、是不是已经进化过了」。

  function lvInList(list, id) {
    for (let i = 0; i < (list || []).length; i++) {
      if (list[i].id === id) return list[i].level;
    }
    return 0;
  }

  // 这件技能玩家现在几级（武器 / 被动 / 组合技三张表一起找；0 = 没有）
  function lvOf(id) {
    if (!id) return 0;
    let lv = lvInList(hud.weapons, id);
    if (lv) return lv;
    lv = lvInList(hud.passives, id);
    if (lv) return lv;
    return lvInList(hud.combos, id);
  }

  function skillName(id) {
    const b = helpById[id];
    return b ? b.name : id;
  }

  // 组装「说明卡」要显示的那一份数据。
  // 【为什么要拼一份、而不是把 skillbook 条目直接塞进 ui】skillbook 是**静态表**
  //   （整局不变），而「我几级 / 是否已进化」每局都在变。拼一份自包含的对象之后，
  //   模板只做取值，不掺任何计算 —— 也就不会踩「模板里带参调用」那个白屏坑。
  function skillDetail(id) {
    const base = helpById[id];
    if (!base) return null;
    const out = {
      id: base.id,
      cat: base.cat,
      catName: CAT_LABEL[base.cat] || '',
      name: base.name,
      tag: base.tag,
      desc: base.desc,
      nums: base.nums || [],
      maxLevel: base.maxLevel || 0,
      recipe: base.recipe || '',
      flavor: base.flavor || '',
      comboOf: base.comboOf || null,
      evoName: base.evoName || null,
      evoOf: base.evoOf || null,
      starters: base.starters || null,
      lv: lvOf(id),
      evolvedTo: ''
    };
    // 「原武器已经进化掉了」：持有表里找不到原武器（它被替换成进化形态了），
    // 这时不该显示成「没拿到」—— 玩家会以为自己的铁鞭不见了（图鉴那边踩过同一个坑）。
    const evo = C.EVO_BY_WEAPON[id];
    if (out.cat === 'weapon' && evo && lvOf(evo.id)) {
      out.evolvedTo = evo.name;
      out.lv = lvOf(evo.id);
    }
    return out;
  }

  function showSkillInfo(id) {
    const d = skillDetail(id);
    if (!d) return;
    ui.slotInfo = d;
    ui.mySkillsOpen = false;
  }

  // 再点同一件 = 收起（省得玩家为了关它去戳那个小 ×）
  function toggleSkillInfo(id) {
    if (ui.slotInfo && ui.slotInfo.id === id) {
      closeSlotCard();
      return;
    }
    showSkillInfo(id);
  }

  function openMySkills() {
    ui.slotInfo = null;
    ui.mySkillsOpen = true;
  }

  function closeSlotCard() {
    ui.slotInfo = null;
    ui.mySkillsOpen = false;
  }

  // 说明卡里「在图鉴里看全部」：先收卡片再开抽屉，否则两张面板叠在一起。
  function openHelpFor(cat) {
    closeSlotCard();
    openHelp(cat || 'weapon');
  }

  // 左下角技能区的点击入口。
  //
  // 【为什么不是每个格子各自一个按钮】技能格只有 20~28px 高，而项目约定触摸目标 ≥44px
  //   （pixel-ui.css 的 `button { min-height: 44px }` 兜底 + mobilecheck 都在守）。
  //   把格子做成 <button>，触屏下会被强行拉到 44px —— 10 格的槽位行立刻变成一堵高墙
  //   （底部 HUD 从 52px 涨到 140px，盖掉小半个战场）。
  //   所以让**整块技能区**当点击目标（它 ≥52px 高、几百 px 宽，天然达标）：
  //     · 鼠标（精细指针）能精确点到某一格 → 直接看那一件的说明
  //     · 触屏（粗指针）手指点不准 16px 宽的空槽 → 一律打开「我的技能」列表
  //   「我的技能」列表每行 44px、可点可滚 —— 比让玩家去戳 10 个 16px 的空槽靠谱得多，
  //   而且两边都不违反触摸目标约定（没有偷偷把 28px 的格子当按钮用）。
  function onSlotsClick(e) {
    const coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
    if (!coarse && e && e.target && e.target.closest) {
      const chip = e.target.closest('[data-skill]');
      const id = chip ? chip.getAttribute('data-skill') : '';
      if (id && helpById[id]) {
        toggleSkillInfo(id);
        return;
      }
    }
    openMySkills();
  }

  // ============================================================
  // 技能区折叠开关（第二十轮）
  // ============================================================
  // 【为什么折叠时点角标「展开」而不是「开我的技能列表」】
  // 折叠态下屏幕上根本没有技能格，玩家想看装备时点角标就是**想看装备**，
  // 不是想看说明。说明有另一条路：展开后点具体格子（鼠标）或
  // 再点整块（触屏）——「先展开、再说明」比「一步跳到说明」更符合预期。
  function toggleSlotsFold() {
    ui.slotsFolded = !ui.slotsFolded;
    let saved = true;
    try {
      localStorage.setItem(SLOTS_FOLD_KEY, ui.slotsFolded ? '1' : '0');
    } catch (e) {
      saved = false;   // 隐私模式：开关当次仍然生效，只是记不住
    }
    // ★顺手把「我的技能」列表关掉：折叠是为了腾出战场空间，
    //   如果底下还压着一个列表，折叠等于没做（而且玩家会以为点角标没反应）。
    if (ui.slotsFolded) ui.mySkillsOpen = false;
    console.log('[game] 技能区 ' + (ui.slotsFolded ? '已折叠（角标）' : '已展开')
      + (saved ? '' : '（本机存不下，仅本次有效）'));
  }

  // ---------------- 技能全满后「升级自动领补给」----------------
  //
  // 【场景】全部技能练满之后，三选一里只剩「补给」这一个兜底项。每升一级都要点一下、
  //   还要等面板弹出来再点 —— 纯打断。
  //
  // 【为什么只在单机】联机世界停不下来，本机不该替服务端做决定；而且联机本来就有
  //   30 秒超时代选兜底（防「卡面板 = 永久无敌」那招）。
  function toggleAutoSupply() {
    ui.autoSupply = !ui.autoSupply;
    let saved = true;
    try {
      localStorage.setItem(AUTO_SUPPLY_KEY, ui.autoSupply ? '1' : '0');
    } catch (e) {
      saved = false;   // 隐私模式：开关当次仍然生效，只是记不住
    }
    console.log('[game] 升级自动领补给 = ' + ui.autoSupply + (saved ? '' : '（本机存不下，仅本次有效）'));
    pushToast(ui.autoSupply ? '已开启：升级自动领补给' : '已关闭：升级自动领补给', false);
  }

  // 已经自动领过的那个「候选数组」。
  // 【为什么记数组引用就够了】单机的候选数组是 sim 每次 openLevelUp 现建的
  //   （buildChoices 的返回值），换一次面板就是新对象 —— 正好当「这一次面板」的记号。
  //   不用额外计数器，也不会出现「同一个面板连领两次」。
  let autoSupplyArmed = null;

  function maybeAutoSupply() {
    if (!ui.autoSupply || ONLINE) return;
    if (ui.screen !== 'levelup') { autoSupplyArmed = null; return; }
    const ch = hud.choices;
    // 「只剩补给」= 技能全练满了（sim 只在什么都给不出来时才塞这个兜底项）
    if (!ch || ch.length !== 1 || ch[0].type !== 'fallback') { autoSupplyArmed = null; return; }
    if (autoSupplyArmed === ch) return;
    autoSupplyArmed = ch;
    choose(0);
    pushToast('技能已全满，自动回复 30 点生命', false);
  }

  // 邀请队友（扫码进这一局）
  // 把进入这一局所需的信息浓缩成一个二维码：扫完直接落到大厅并自动进这一桌，
  // 不用手敲 IP、端口和房间号（手机用户基本敲不对）。
  // 队友连进来后是「中途加入」—— 服务端本来就支持，会直接把他放进世界。
  function openShare() {
    const SHARE = window.VS && window.VS.SHARE;
    ui.shareCode = roomCode;
    ui.shareUrl = SHARE ? SHARE.inviteUrl(roomCode) : (location.origin + '/');
    ui.shareOpen = true;
    ui.shareQrFail = false;

    // 弹层是 v-if 控制的，DOM 要等下一帧才存在 —— 这里不能立刻取元素
    Vue.nextTick(function () {
      const cv = document.getElementById('share-qr');
      if (!cv) return;
      const ok = SHARE ? SHARE.drawQr(cv, ui.shareUrl, 216) : false;
      ui.shareQrFail = !ok;
      if (!ok) console.log('[game] 二维码没画出来（vendor 的 qrcode.js 没加载上？），退化成显示链接');
    });
  }

  function closeShare() {
    ui.shareOpen = false;
  }

  // 复制邀请文案。局域网多是 http，非安全上下文拿不到剪贴板 API，
  // 拿不到就把内容显示在提示条里让人手动复制（与大厅页的做法保持一致）。
  function copyShareLink() {
    const text = '山海神话传联机：房间号 ' + roomCode + '，地址 ' + ui.shareUrl;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        pushToast('邀请信息已复制', false);
      }, function () {
        pushToast(text, false);
      });
      return;
    }
    pushToast(text, false);
  }

  function choose(index) {
    // 联机：裁决权在服务端（世界在它那边），本机只上报下标。
    // 界面先乐观地收起面板，服务端随后推来的 hud 会纠正 ——
    // 非法下标它会回一份最新 hud 让我们校正。
    if (ONLINE) {
      if (!sendNet({ t: 'choose', index: index })) {
        console.log('[game] 上行通道还没就绪，这次选择没发出去');
        return;
      }
      ui.screen = 'playing';
      lastNow = 0;
      acc = 0;
      return;
    }

    if (!world || world.state !== 'levelup') return;
    const ok = SIM.chooseLevelUp(world, index);
    if (!ok) {
      console.log('[game] 升级选择被拒绝，下标=' + index);
      return;
    }
    ui.pendingLevels = world.pendingLevels;
    // 还有攒着的升级次数时 sim 会再开一次面板，这里跟着切
    ui.screen = world.state === 'levelup' ? 'levelup' : 'playing';
    if (ui.screen === 'playing') {
      lastNow = 0;
      acc = 0;
    }
  }

  function isLocked(c) {
    // 游客只能玩猎魔人（方案 2.7）；账号用户全解锁
    if (isGuest) return !c.guestAllowed;
    return false;
  }

  // 角色卡片上的三个数值：全部**从角色定义现算**，不写死。
  //
  // 【为什么不写死】原来选择界面上是 100 / 120 / 200 三个常量，8 个角色长得一模一样，
  // 而且和实际数值都对不上（真血量是 120）。选角色的页面如果不显示真实差异，
  // 那「8 个角色各有取舍」这件事在玩家眼里就等于不存在 —— 他只能靠 desc 那一行字猜。
  //
  // 输出指数 = 伤害倍率 ÷ 冷却倍率：冷却越小出手越快，所以是「除以」不是「乘」。
  // 它是个指数不是真实 DPS（真实 DPS 还要算武器基础值、投射物数、命中率），
  // 用在卡片上只是为了横向比较谁打得更凶。
  function charStats(c) {
    const C = window.VS && window.VS.CONST;
    const P = (C && C.PLAYER) || { hp: 120, speed: 120 };
    const m = (c && c.mods) || {};
    return {
      hp: Math.round(P.hp * (m.hp || 1)),
      speed: Math.round(P.speed * (m.speed || 1)),
      dps: Math.round(((m.dmg || 1) / (m.cd || 1)) * 100)
    };
  }

  function weaponName(id) {
    const def = C.WEAPON_MAP[id];
    return def ? def.name : id;
  }

  // ============================================================
  // 悬浮提示
  // ============================================================

  function pushToast(text, isBoss) {
    const item = { id: ++toastSeq, text: text, boss: !!isBoss };
    ui.toasts.push(item);
    // 2.4 秒后自动消失
    setTimeout(function () {
      const idx = ui.toasts.indexOf(item);
      if (idx >= 0) ui.toasts.splice(idx, 1);
    }, 2400);
  }

  // ============================================================
  // 剧情节拍横条
  // ============================================================
  //
  // 【为什么用 setTimeout 定时隐藏，而不是「按时间差算剩余显示时长」】
  // 后者的问题是玩家一暂停，界面时间就停在那儿不动（或者反过来，
  // 靠 Date.now() 算的话定时器照走，回来时早没了）。
  // 定时器方案的表现是「暂停多久，回来还能再读 4 秒」——
  // 剧情文本是给人读的，不该被玩家按暂停的时间吃掉。
  let storyLineTimer = 0;
  // 节拍横条停留时长。给 6 秒而不是 3~4 秒 ——
  // 这是一句要读的叙事文本，不是「怪来了」那种即时提示，
  // 读不完就消失等于没播（而它一条只播一次）。
  const STORY_LINE_MS = 6000;

  function showStoryLine(line) {
    if (!line) return;
    ui.storyLine = line;
    if (storyLineTimer) clearTimeout(storyLineTimer);
    storyLineTimer = setTimeout(function () {
      ui.storyLine = '';
      storyLineTimer = 0;
    }, STORY_LINE_MS);
  }

  // ============================================================
  // 事件消费：把 sim 产生的事件翻译成界面动作
  // ============================================================

  // 单机：从 sim 的事件队列取；联机：服务端按座位分好推过来。
  // 两条路的处理逻辑合成 applyEvent()。
  function consumeEvents() {
    const events = SIM.takeEvents(world);
    for (let i = 0; i < events.length; i++) applyEvent(events[i]);
  }

  function applyEvent(e) {
    if (e.type === 'wave') {
      // 每 5 波报一次，免得刷屏
      if (e.wave % 5 === 0) pushToast('第 ' + e.wave + ' 波来袭', false);
    } else if (e.type === 'boss') {
      // ★用事件里带来的名字，不再写死「血月领主」——
      //   剧情模式的 Boss 叫蚩尤/九婴/烛龙/女娲，写死会全部显示成「血月领主」。
      //   （这个事件里sim 已经走过 nameTable，见 spawnWave。）
      pushToast((e.name || '首领') + '降临！', true);
    } else if (e.type === 'story') {
      // 剧情节拍：顶部横条淡入，4 秒后自动淡出。
      // ★用 setTimeout 而不是「按时间差隐藏」—— 暂停时计时器照跑，
      //   玩家暂停 10 秒回来发现节拍早没了，那才是真问题。
      //   这里换成「重新触发时先清掉上一个定时器」，暂停不影响它的可见时长。
      showStoryLine(e.line);
    } else if (e.type === 'chest_drop') {
      // 宝箱是「要专门走过去拿」的（不被磁石吸），所以必须明确告诉玩家它掉了、
      // 而且是谁掉的 —— 否则很容易走开之后才发现漏了一个免费升级。
      pushToast((e.name || '首领') + '掉落了宝箱，走过去拾取', true);
    } else if (e.type === 'chest_open') {
      pushToast('开箱！免费升级一次', true);
    } else if (e.type === 'levelup') {
      ui.screen = 'levelup';
      ui.pendingLevels = (e.pendingLevels !== undefined) ? e.pendingLevels
        : (ONLINE ? 1 : world.pendingLevels);
    } else if (e.type === 'dead') {
      // 单机：阵亡就是这一局的结局，切结算界面。
      // 联机：世界照常跑，倒计时结束会自动复活 —— 界面不切屏，
      //       只靠 hud.reviveLeft 浮出一层「N 秒后复活」，别把战场挡住。
      if (!ONLINE) ui.screen = 'result';
      console.log('[game] 玩家阵亡，等级=' + hud.level + ' 击杀=' + hud.kills +
        (ONLINE ? '（' + (e.reviveIn || 0) + ' 秒后复活）' : ''));
    } else if (e.type === 'revive') {
      pushToast('你已复活，注意走位', false);
      console.log('[game] 复活，本局已倒下 ' + (e.deaths || 0) + ' 次');
    } else if (e.type === 'timeout') {
      // ★剧情关专属：时间到但首领还没打完。
      //   这个事件必须与 'won' 分开 —— 复用 'won' 会让玩家看到「通 关」两个字，
      //   可他明明没打倒首领。它是这一关唯一的失败条件，得说清楚。
      if (!ONLINE) ui.screen = 'result';
      console.log('[story] 时间到，首领「' + (hud.bossName || '首领') + '」未被击败 → 未通过');
    } else if (e.type === 'won') {
      if (!ONLINE) ui.screen = 'result';
      // ★剧情模式：通关要**先记进度再切结算屏**。
      //   顺序反了的话结算屏上的「下一关」按钮会因为「进度还没写」而判成未解锁。
      //   记进度只在单机（联机没有剧情：modId 恒为 vanilla，storyStage 为 null）。
      if (storyStage && STORY) {
        const isNew = STORY.markCleared(modId, realStageId, e.time || world.time);
        console.log('[story] 第 ' + storyStage.no + ' 关「' + storyStage.name + '」通关' +
          (isNew ? '（首次）' : '（重打）'));
      }
      console.log('[game] 通关，等级=' + hud.level + ' 击杀=' + hud.kills);
    } else if (e.type === 'ally_join') {
      pushToast((e.name || '队友') + ' 加入了战斗', false);
    } else if (e.type === 'ally_left') {
      pushToast((e.name || '队友') + ' 离开了战斗', false);
    } else if (e.type === 'auto_choose') {
      // 升级面板放太久被服务端代选了（防「卡面板 = 永久无敌」那招）。
      // 【必须顺手把面板收掉】不清的话服务端已经代选完了、面板却还挂在屏幕上，
      // 玩家再点一下才发现「点了没用」（服务端那边他早就不在升级态了）。
      // 如果还有待选的等级，服务端随后会再推一个 levelup 事件，面板会重新弹出来。
      if (ui.screen === 'levelup') ui.screen = 'playing';
      pushToast('超时未选，系统已替你选', false);
    }
  }

  // ============================================================
  // HUD 同步
  // ============================================================

  // 单机：HUD 自己算；联机：服务端下发。两条路最终都汇进 applyHud()，
  // 界面逻辑只维护一份 —— 这也是「服务端用同一份 getHud」带来的便宜。
  function syncHud() {
    applyHud(SIM.getHud(world));
  }

  // 调试用的「界面预览」窗口：在这之前 HUD 用脚本塞进去的那份数据，
  // 忽略服务端下发。存在的理由很实际 —— 想看一眼「阵亡倒计时」这种界面，
  // 只能站着等怪把自己打死；而如果只是塞一份假 HUD，服务端 10Hz 的真 HUD
  // 下一拍就把它覆盖回去了，界面根本来不及显示（自动化会偶发失败）。
  // 只有 ?debug=1 下的 VS_GAME.fakeHud 能设置它，而且到点自动失效。
  let hudPreviewUntil = 0;

  function applyHud(h) {
    if (Date.now() < hudPreviewUntil) return;
    hud.state = h.state;
    hud.wave = h.wave;
    hud.level = h.level;
    hud.exp = h.exp;
    hud.expNext = h.expNext;
    hud.hp = h.hp;
    hud.maxHp = h.maxHp;
    hud.kills = h.kills;
    hud.gold = h.gold;
    hud.dmgDealt = h.dmgDealt;
    hud.mobCount = h.mobCount;
    hud.charName = h.charName;

    // 难度：整局不变，只在变了的时候写响应式（每帧写一遍会让 HUD 白重渲染）
    const did = h.diffId || '';
    if (did !== hud.diffId) hud.diffId = did;
    const dnm = h.diffName || '';
    if (dnm !== hud.diffName) hud.diffName = dnm;
    const msec = h.matchSec || 0;
    if (msec && msec !== hud.matchSec) hud.matchSec = msec;

    // 阵亡倒计时：活着时恒为 0，只有真在数秒时才写响应式 ——
    // 不然每帧往上写一遍，复活倒计时那层会被无谓地重渲染。
    const rv = h.reviveLeft || 0;
    if (rv !== hud.reviveLeft) hud.reviveLeft = rv;
    const dt2 = h.deaths || 0;
    if (dt2 !== hud.deaths) hud.deaths = dt2;

    // 金币余额与商店状态。**同样按「变了才写」**——
    // shopGold 在单机里每帧都会从 getHud 回来，无脑写会让整个暂停面板每帧重渲染，
    // 而暂停面板里恰好还放着商店与角色数据两块（重渲染代价不小）。
    const sg = h.shopGold || 0;
    if (sg !== hud.shopGold) hud.shopGold = sg;
    const bs = h.buffStacks || 0;
    if (bs !== hud.buffStacks) hud.buffStacks = bs;
    // 角色详细数据：按签名比对（属性变动很频繁——每次升级都变，
    // 但也不该每帧重建对象）
    const d = h.detail;
    if (d) {
      const dsig = [d.maxHp, d.armor, d.speed, d.dmgMul, d.cdMul, d.rangeMul,
        d.pickupMul, d.expMul, d.goldMul, d.crit, d.exec, d.regen, d.killHeal, d.thorns].join(',');
      if (dsig !== lastDetailSig) {
        lastDetailSig = dsig;
        hud.detail = d;
      }
    }

    // ---------- 剧情字段（第十五轮）----------
    // ★★这里是一个**逐字段白名单**，而白名单的坑是「加了字段忘了加进来」——
    //   表现是模板里读到 undefined：章节标不显示、卷尾是空的，而**不报错**。
    //   （同一个坑在这个项目里出现过三次：emitRoom 的头像 / 难度 / 地图。）
    //   所以凡是 getHud 新增的剧情字段，必须同时在这里补一行。
    //   这些值在一关之内是常量，用签名比对写一次就够，不必每帧赋。
    const campSig = (h.modId || '') + '|' + (h.campaign ? 1 : 0) + '|' + (h.stageNo || 0) + '|' +
      (h.stageName || '') + '|' + (h.mapName || '') + '|' + (h.coda || '') + '|' +
      (h.bossName || '') + '|' + (h.stageWaveTotal || 0) + '|' +
      (h.ended ? 1 : 0) + '|' + (h.timeout ? 1 : 0);
    if (campSig !== lastStorySig) {
      lastStorySig = campSig;
      hud.modId = h.modId || 'vanilla';
      // ★地图名走服务端/世界给的（已经过名字表），**不要**再用 world.map.name ——
      //   那是数据表本名，剧情模式下会显示成「血色回廊」而不是「血霞回廊」。
      hud.mapName = h.mapName || hud.mapName || '';
      hud.campaign = !!h.campaign;
      hud.stageNo = h.stageNo || 0;
      hud.stageName = h.stageName || '';
      hud.epigraph = h.epigraph || '';
      hud.coda = h.coda || '';
      hud.bossName = h.bossName || '';
      hud.stageWaveTotal = h.stageWaveTotal || 0;
      // ★这两个必须在这里赋 —— 它们的值进了上面的签名，如果只进签名不赋值，
      //   以后有人读 hud.ended 会永远拿到初始的 false（**不报错**，只是恒假）。
      //   收尾那一刻它俩会跟着 state 一起变，所以写在这里就够。
      hud.ended = !!h.ended;
      hud.timeout = !!h.timeout;
    }

    // 倒计时只在整秒变化时才写响应式（见上面 lastSec 的说明）
    const secNow = Math.floor(h.time);
    if (secNow !== lastSec) {
      lastSec = secNow;
      hud.time = h.time;
      hud.timeLeft = h.timeLeft;
    }

    // 数组类型按签名比对后再赋值：每帧无脑替换会让 Vue 一直重渲染槽位列表
    const sig = h.weapons.map(function (x) { return x.id + x.level; }).join(',') + '|' +
      h.passives.map(function (x) { return x.id + x.level; }).join(',') + '|' +
      // 组合技也进签名：它和武器一样是持续输出源，解锁/升级时要刷新槽位列表
      (h.combos || []).map(function (x) { return x.id + x.level; }).join(',');
    if (sig !== lastSlotSig) {
      lastSlotSig = sig;
      hud.weapons = h.weapons;
      hud.passives = h.passives;
      hud.combos = h.combos || [];
    }

    // 关卡名：整关不变，变了才写响应式（与难度同一个处理）
    const sn = h.stageName || '';
    if (sn !== hud.stageName) hud.stageName = sn;

    // 升级候选只在面板出现时才需要同步
    if (h.state === 'levelup' && h.choices !== lastChoices) {
      lastChoices = h.choices;
      hud.choices = h.choices;
    }

    // Boss 血条：血量每帧都在动，但只有「名字 + 血量」真变了才值得写响应式
    const b = h.boss;
    const bSig = b ? (b.name + '#' + b.hp + '/' + b.maxHp) : '';
    if (bSig !== lastBossSig) {
      lastBossSig = bSig;
      hud.boss = b;
    }

    // 调试浮层只在 ?debug=1 时存在；非调试下这四个响应式赋值纯属浪费，
    // 它们每帧都变，会把整块调试面板跟着重渲染一次。
    if (DEBUG) {
      ui.tick = world.tick;
      ui.fps = renderer.getFps();
      ui.drawn = renderer.stat.drawn;
      ui.total = renderer.stat.total;
      ui.drawMs = renderer.stat.drawMs;
    }
    // 自己该升级了：把面板推出来。
    // 单机的待选次数挂在世界对象上；联机时 world 是快照拼出来的、没有这个字段，
    // 就先按 1 次算 —— 选完服务端会把新的 hud 再推过来，面板会跟着续上。
    if (h.state === 'levelup') {
      ui.pendingLevels = (h.pendingLevels !== undefined) ? h.pendingLevels
        : (ONLINE ? 1 : world.pendingLevels);
    }
  }

  // ============================================================
  // 主循环
  // ============================================================

  function loop(now) {
    rafId = requestAnimationFrame(loop);
    if (!world) return;

    renderer.tickFps(now);

    // ---------------- 联机：世界不在这里推进 ----------------
    // 本机只做两件事：上行方向、把最近一帧快照画出来。逻辑全在服务端。
    if (ONLINE) {
      if (net.state === 'playing') sendInput(now);

      if (net.snap && net.snap.players && net.snap.players.length) {
        const w = applySnap(net.snap);
        // 插值：快照里的 px/py 就是上一 tick 的位置，按「距收到这一帧过了多久 ÷
        // 期望间隔」在两者之间插。快照 20Hz、渲染 60fps，不插值会有明显的 20Hz 抖动。
        const alpha = Math.min(1, (now - net.snapAt) / net.snapInterval);
        renderer.draw(w, alpha, input);
      } else {
        // 还没收到第一帧快照：刷新一下输入免得按键状态卡住，画面留黑即可
        input.update();
      }

      ui.netSnaps = net.snapCount;
      ui.netKb = Math.round(net.snapBytes / 1024);
      // 重连提示：只在状态真的变了才写响应式（每帧写会把顶栏重渲染 60 次）
      if (ui.netReconnecting !== net.reconnecting) ui.netReconnecting = net.reconnecting;
      if (ui.netRetry !== net.retry) ui.netRetry = net.retry;
      if (DEBUG) {
        ui.tick = net.snap ? net.snap.tick : 0;
        ui.fps = renderer.getFps();
        ui.drawn = renderer.stat.drawn;
        ui.total = renderer.stat.total;
        ui.drawMs = renderer.stat.drawMs;
      }
      return;   // 联机不走下面那套固定步长逻辑
    }

    // 只有「进行中」才推进逻辑；暂停 / 升级面板 / 结算都冻结世界
    const running = ui.screen === 'playing' && world.state === 'playing';

    if (running) {
      if (lastNow === 0) lastNow = now;
      let dt = now - lastNow;
      lastNow = now;

      // 切标签页回来时 dt 可能是几秒，直接钳住
      if (dt > 250) dt = 250;

      // ★★倍速就改在这一行：把「这一帧经过的真实时间」乘上倍速再累加。
      //   世界时间因此走得更快 —— 倒计时、波次、升级节奏、怪的行动全都跟着快，
      //   也就是「整体速度加快、时间也变快」。
      //
      //   【为什么乘在这里，而不是改 STEP_MS】STEP_MS 是逻辑的**固定步长**（1/20 秒），
      //   动它等于把每一步的物理量都改掉（移动距离、攻击间隔、击退距离全乱）。
      //   乘在「时间入口」上，逻辑层一步没变，只是单位真实时间内跑的步数变多。
      //   这也保证了「加速后手感一致、只是快」——而不是变成另一个游戏。
      const speed = gameSpeed();
      acc += dt * speed;
      let steps = 0;
      // ★补帧上限只按倍速**小幅放宽**（+speed），不要乘倍数放大：
      //   60fps 下 ×4 每帧也只需要 4×16.7/50 ≈ 1.33 步，+speed 完全够；
      //   若写成 MAX_CATCHUP_STEPS * speed（×4 = 20 步），一帧最多能跑
      //   1 秒游戏时间，卡顿时的峰值反而更危险。掉帧追不上时就让游戏时间落后一点，
      //   这是合理的降级（感觉是「加速没那么明显」），而不是卡死。
      const maxSteps = MAX_CATCHUP_STEPS + speed;
      while (acc >= STEP_MS && steps < maxSteps) {
        SIM.step(world, input.update());
        acc -= STEP_MS;
        steps += 1;
        // 中途弹出升级面板就停，本帧不再继续推进
        if (world.state !== 'playing') break;
      }
      // 补步到上限说明严重掉帧，把欠账清掉
      if (steps >= maxSteps) acc = 0;
    } else {
      // 非运行态仍要刷新输入，否则松手后键盘状态会卡住
      input.update();
      lastNow = 0;
    }

    consumeEvents();

    // ---------- 状态收敛保险（单机）----------
    // 【为什么必须有这一层】
    // 「世界要不要推进」用的是 running = (screen==='playing' && world.state==='playing')，
    // 而「该显示哪个面板」用的是各面板自己的 screen 值。
    // 这是**两套判断**：只要上游某条路径改了 world.state 却漏了同步 screen
    // （或反过来），玩家看到的就是「游戏停住了，但屏幕上没有任何界面」——
    // 除了刷新页面没有别的出路。用户报障的「按暂停会暂停、但没有弹出暂停面板」
    // 正是这个症状。
    //
    // 这里做一次兜底：**世界不推进时，必须有一个可见面板**。
    // 一旦发现世界停了而界面还停在 playing，立刻补上正确的面板，
    // 并往 console 留一条取证日志（这样下次真出问题，能直接看出是哪条路径漏了同步，
    // 而不是只能靠用户描述猜）。★排查类日志用 console.warn 而不是 error：
    // 它是「自愈了但值得关注」，不是崩溃。
    if (world.state !== 'playing' && ui.screen === 'playing') {
      const want = world.state === 'levelup' ? 'levelup' : 'result';
      console.warn('[game] 世界已停（world.state=' + world.state +
        '）但界面停在 playing —— 已自动纠正为「' + want + '」。' +
        '若反复出现，请检查是哪条路径改了 world.state 却漏同步 ui.screen。');
      ui.screen = want;
      lastNow = 0;
      acc = 0;
    }

    // 插值系数：acc 在一步内的进度。暂停/结束时直接用 1 显示最终位置
    const alpha = running ? Math.max(0, Math.min(1, acc / STEP_MS)) : 1;
    renderer.draw(world, alpha, input);

    syncHud();

    // 技能全练满后自动领补给。
    // ★必须放在 syncHud() **之后**：它读的是刚同步过来的 hud.choices，
    //   放前面会永远慢一帧 —— 表现是「面板先闪一下再消失」，看起来像 bug。
    maybeAutoSupply();
  }

  // ============================================================
  // 启动
  // ============================================================

  function boot() {
    const canvas = document.getElementById('game-canvas');

    renderer = createRenderer(canvas, { debug: DEBUG });
    renderer.resize();

    input = createInput(canvas);
    input.attach();
    input.onPause = function () {
      // 【图鉴优先】开着图鉴时 Esc 只收图鉴，不去动 screen。
      // 少了这一句，玩家连按两下 Esc 会发现「图鉴关了、菜单又开了」——
      // 一次按键干了两件事，手感上像是界面自己在乱动。
      if (ui.helpOpen) {
        closeHelp();
        return;
      }
      // 联机：Esc 只开/关那个「不冻结世界的菜单」，不能走暂停
      if (ONLINE) {
        if (ui.screen === 'playing' || ui.screen === 'menu') togglePause();
        return;
      }
      // 单机：升级面板与结算时不响应暂停，避免状态互相覆盖。
      //
      // ★★但必须**给反馈**，不能静默忽略 —— 这是用户报障的真正来源：
      //   「按暂停，会暂停，但没有弹出暂停面板」。
      //   实测复现：玩家在**升级三选一**打开时按 Esc（手机上则是点暂停按钮，
      //   但那时候按钮本来就不显示）——
      //     ① 世界早就被升级面板冻住了 → 玩家感到「确实暂停了」
      //     ② 屏幕上显示的是升级面板，不是暂停面板 → 「没有弹出暂停面板」
      //     ③ 而 onPause 直接 return，连个提示都没有 → 「按了没反应，是坏了吗」
      //   三件事叠起来就是那条报障。修法不是「让两个面板叠在一起」
      //   （项目踩过「叠成两层 UI」的坑），而是**明确告诉玩家为什么**。
      if (ui.screen === 'playing' || ui.screen === 'paused') {
        togglePause();
        return;
      }
      if (ui.screen === 'levelup') {
        pushToast('正在选择升级，选完就能暂停', false);
        console.log('[game] 暂停被忽略：当前在升级面板（世界已冻结，无需再暂停）');
      } else if (ui.screen === 'result') {
        pushToast('这一局已经结束了', false);
        console.log('[game] 暂停被忽略：当前在结算界面');
      }
    };
    input.onRestart = function () {
      if (ui.screen !== 'result' && ui.screen !== 'paused') return;
      // 联机不能「本地重开」：世界在服务端，本地重开等于自己单开一个新世界。
      // 正确姿势是回大厅重新进房。
      if (ONLINE) backToLobby();
      else restart();
    };

    // 调试句柄：加了 ?debug=1 才挂到 window 上，供人工在 console 里查状态，
    // 也供自动化脚本读取运行时数据。
    // 之所以必须自己暴露：Vue 的打包版里 app._instance 恒为 null，
    // 从 #hud.__vue_app__ 根本拿不到组件实例（typeof null === 'object'，很容易误判）。
    if (DEBUG) {
      window.VS_GAME = {
        ui: ui,
        hud: hud,
        // 联机时对外暴露的是「从快照拼出来的那个世界」，
        // 本地那个 world 在联机下只负责铺背景，tick 永远不动。
        get world() { return ONLINE ? onlineWorld : world; },
        // 渲染器也放出来：tools/renderbench.js 要直接批量调 draw() 量耗时
        get renderer() { return renderer; },
        // 节拍横条的调试入口：供自动化脚本（tools/storycheck.js）验证
        // 「节拍与 Boss 血条不重叠」。不暴露的话没法在断言里控制它出现的时间点 ——
        // 它只播一次、6 秒后消失，靠 sleep 去撞那个窗口是「看运气」的测试。
        // 与 fakeHud 同一个理由：测试要能主动制造状态，而不是等状态自己来。
        storyLine: function (line) { showStoryLine(line); },
        // tick 要看「真正在推进的那个世界」：联机在服务端推进，值在快照里，
        // 而本地那个 world.tick 永远是 0 —— 早先直接读 world.tick，导致联机下
        // 自动化断言看到 tick=0，误判成「世界没动」。
        get tick() { return ONLINE ? (onlineWorld ? onlineWorld.tick : 0) : (world ? world.tick : 0); },
        // ---- 联机调试字段（tools/roomcheck.js 等自动化脚本读这几个）----
        get online() { return ONLINE; },
        // ---- 观战调试字段（tools/netcheck.js 的 [13] 节读这几个）----
        get spectating() { return !!ui.spectating; },
        get followSlot() { return ui.followSlot; },
        get selfSlot() { return net.selfSlot; },
        // 最近这一帧快照自己带的 spectating 位。理论上应与上面 spectating 永远一致 ——
        // 不一致就说明二进制编码/解码的 flags 处理有问题。
        get snapSpectating() { return !!(net.snap && net.snap.spectating); },
        get players() { return (net.snap && net.snap.players) ? net.snap.players.length : 0; },
        // 开局名单（game_start 那一包的全量成员，含 name/slot/charId）。
        // 队友头顶名牌的昵称就是从它按 slot 关联到快照玩家上的，排查时先看这个。
        get roster() { return net.players || EMPTY_LIST; },
        // 快照里的玩家（含 applySnap 补上的 name），排查「昵称丢了」看这里
        get snapPlayers() { return (onlineWorld && onlineWorld.players) || EMPTY_LIST; },
        // 本帧队友（不含自己）的昵称列表。昵称不在每帧快照里，是 applySnap 从
        // 开局名单按 slot 补上的 —— 自动化断言靠它确认这一步真的做成了。
        get teamNames() {
          const list = (onlineWorld && onlineWorld.players) || EMPTY_LIST;
          const out = [];
          for (let i = 0; i < list.length; i++) {
            if (onlineWorld && list[i] === onlineWorld.self) continue;
            out.push(list[i].name || '');
          }
          return out;
        },
        get mobs() { return (net.snap && net.snap.mobs) ? net.snap.mobs.length : 0; },
        get snapCount() { return net.snapCount; },
        // ---- P2-5 二进制快照的观测字段（roomcheck/bintest 靠它们确认真的走了二进制）----
        get netBytes() { return net.snapBytes; },   // 累计收到的快照字节数
        get binFrames() { return net.binFrames; },  // 其中二进制帧数（=== snapCount 才算全走二进制）
        get binFail() { return net.binFail; },      // 解码失败帧数（必须恒为 0）
        get fps() { return renderer ? renderer.getFps() : 0; },
        get stat() { return renderer ? renderer.stat : { drawn: 0, total: 0 }; },
        get screen() { return ui.screen; },
        // ---- 重连观测（自动化断言靠它们确认「断了自己接回来」）----
        get netState() { return net.state; },
        get netRetry() { return net.retry; },
        get netReconnecting() { return net.reconnecting; },
        get netWelcomed() { return net.welcomed; },
        // 直接驱动界面动作，便于脚本化验证
        start: startMatch,
        choose: choose,
        pause: togglePause,
        restart: restart,
        backToRoom: backToRoom,
        openShare: openShare,
        // 故意掐断连接，供自动化脚本验证重连（不这样做就得去杀服务进程）
        dropNet: function () { dropAndReconnect('调试句柄主动断开'); },
        // 把一份假的 HUD 打进来，用来预览「只有真死一次才会出现」的界面
        //（阵亡倒计时那一层）。没有它的话，自动化要验证那个界面就只能
        // 站着不动等怪把自己打死 —— 又慢又不稳。
        // ms 是预览窗口（默认 4 秒）：这段时间内忽略服务端 HUD，否则界面还没画出来
        // 就被真实 HUD 覆盖回去了。传 0 立刻恢复。
        fakeHud: function (patch, ms) {
          // 先把上一次的预览窗口放开再应用 —— 否则这次会被它自己挡回去
          // （踩过：第二次调用想恢复界面时，applyHud 被上一次的窗口拦掉，界面卡在预览态）
          hudPreviewUntil = 0;
          applyHud(Object.assign({}, hud, patch || {}));
          hudPreviewUntil = Date.now() + (ms === undefined ? 4000 : Number(ms) || 0);
        }
      };
      console.log('[game] 调试句柄已挂载：window.VS_GAME（可读 world/ui/hud，可调 start/choose/pause/restart）');
    }

    window.addEventListener('resize', function () {
      renderer.resize();
      // 视口变了，后续生成的怪要按新半径算
      if (world) world.spawnRadius = computeSpawnRadius();
    });

    // 切走标签页自动暂停，回来不会因为补帧瞬移
    document.addEventListener('visibilitychange', function () {
      // 联机不自动暂停：世界在服务端，切走再回来只是「已经打了一会儿」，
      // 本地弹个暂停面板纯属误导（而且那段进度也追不回来）。
      if (!ONLINE && document.hidden && ui.screen === 'playing') ui.screen = 'paused';
    });

    // 挂 Vue HUD
    createApp({
      data: function () {
        return {
          hud: hud,
          ui: ui,
          chars: C.CHARACTERS,
          nickname: nickname,
          isGuest: isGuest,
          showDebug: DEBUG
        };
      },
      computed: {
        // 血量百分比（至少要留 0.5% 让条形还看得见）
        hpPct: function () {
          if (!hud.maxHp) return '0%';
          const p = Math.max(0, Math.min(1, hud.hp / hud.maxHp));
          return (p * 100).toFixed(2) + '%';
        },
        expPct: function () {
          if (!hud.expNext) return '0%';
          const p = Math.max(0, Math.min(1, hud.exp / hud.expNext));
          return (p * 100).toFixed(2) + '%';
        },
        // 血量低于 30% 时界面转成「告急」配色（血条脉冲 + 屏幕四边泛红）
        // 观战者不看这一条：HUD 借的是被跟随那个人的血，被跟随的人快死了
        // 屏幕泛红会让人以为「我快死了」。那是别人的命，不是自己的。
        lowHp: function () {
          if (ui.spectating) return false;
          return hud.maxHp > 0 && hud.hp / hud.maxHp < 0.3;
        },
        // 最后一分钟把倒计时染红，给「快撑到了」的压迫感
        urgent: function () {
          return hud.timeLeft <= 60 && hud.state === 'playing';
        },
        // Boss 血条宽度
        bossPct: function () {
          const b = hud.boss;
          if (!b || !b.maxHp) return '0%';
          return (Math.max(0, Math.min(1, b.hp / b.maxHp)) * 100).toFixed(2) + '%';
        },
        // 倒计时 mm:ss，比正计时更符合「活到最后」的压迫感
        timeText: function () {
          const t = Math.max(0, Math.ceil(hud.timeLeft));
          const m = Math.floor(t / 60);
          const s = t % 60;
          return m + ':' + (s < 10 ? '0' + s : s);
        },
        // 界面状态暴露给模板用
        screen: function () { return ui.screen; },
        // 联机升级面板要不要「贴底悬浮」。
        // 单机：升级会冻结世界，全屏遮罩（带模糊）没问题，还能把注意力吸到面板上。
        // 联机：世界在服务端照跑，全屏遮罩会把战场盖死 —— 玩家只能盲选，
        //       怪从哪边来、自己还剩多少血都看不见（用户实测反馈的点）。
        //       所以联机时换成「底部半透明贴片 + 战场全程可见」。
        dockLevelUp: function () {
          return ui.online === true && ui.screen === 'levelup';
        },
        // 世界是否仍在推进。低血警示（屏幕泛红）与 Boss 血条属于「战场信息」，
        // 只有世界真的在动时才该显示 —— 单机暂停 / 结算时显示它们是误导。
        // 联机下升级面板开着世界也没停（这也是为什么联机升级面板不能盖住画面）。
        worldLive: function () {
          if (ui.online) {
            return ui.screen === 'playing' || ui.screen === 'menu' || ui.screen === 'levelup';
          }
          return ui.screen === 'playing';
        },
        // 联机阵亡中的等待态：这时候世界还在跑，界面只浮一层倒计时，不能盖住战场。
        // 观战者不显示：HUD 借的是被跟随者的状态，那人的「等待复活」不是观战者在等。
        deadWaiting: function () {
          return ui.online === true && hud.state === 'dead' && !ui.spectating;
        },
        // 复活倒计时（向上取整成整秒，读起来才像倒计时）
        reviveSecText: function () {
          return Math.max(0, Math.ceil(hud.reviveLeft || 0));
        },
        charId: function () { return ui.charId; },
        toasts: function () { return ui.toasts; },
        tick: function () { return ui.tick; },
        fps: function () { return ui.fps; },
        drawn: function () { return ui.drawn; },
        total: function () { return ui.total; },
        drawMs: function () { return ui.drawMs; },
        pendingLevels: function () { return ui.pendingLevels; },
        // 结算里的存活时长
        result: function () {
          const sec = Math.floor(hud.time);
          return { surviveText: formatSec(sec) };
        },
        // 结算里的全队战绩（联机才有内容；单机为空数组 → 那一块不显示）
        resultList: function () { return ui.resultList; },
        // 「撑满了 N 分钟」里的 N。难度决定时长（18/20/22/25 分钟），
        // 不能再写死 20 —— 休闲局通关写成「撑满了 20 分钟」是明显的错。
        matchMinutes: function () {
          const sec = hud.matchSec || C.MATCH_SEC;
          return Math.round(sec / 60);
        },
        // 我是观众吗。模板据此把血条/经验/武器栏换成「观战中」。
        spectating: function () { return !!ui.spectating; },
        // ---------------- 技能图鉴 ----------------
        //
        // 【为什么持有情况能自动刷新】hud.weapons/passives/combos 三 个数组是响应式的，
        // 而 applyHud 只在 signature 变化时**替换**它们（不是每帧 mutate）。
        // 所以这里读它们的 .length 与内容，依赖关系成立，图鉴只在
        // 「升级 / 解锁 / 掉线接回进度」这几刻重算一次，不是每帧 54 条。
        helpGroups: function () {
          if (!SKILLBOOK) return [];
          const owned = { weapons: {}, passives: {}, combos: {} };
          const put = function (bag, list) {
            for (let i = 0; i < (list || []).length; i++) bag[list[i].id] = list[i].level;
          };
          put(owned.weapons, hud.weapons);
          put(owned.passives, hud.passives);
          put(owned.combos, hud.combos);
          return SKILLBOOK.markOwned(helpBase, owned);
        },
        // 当前分类。模板里 v-for 直接写 (helpGroup ? helpGroup.items : [])，
        // 就是为了在 helpGroups 为空（skillbook.js 没加载上）时不抛
        // 「Cannot read properties of undefined」——那会让整页白屏。
        helpGroup: function () {
          for (let i = 0; i < this.helpGroups.length; i++) {
            if (this.helpGroups[i].key === ui.helpTab) return this.helpGroups[i];
          }
          return this.helpGroups[0] || null;
        },
        // 图鉴按钮在哪些界面该出现。
        // 结算与「联机接入中」不出现：那两个界面玩家没在打，正看不到图鉴，
        // 顶上多一个按钮只会跟「返回大厅」抢注意力。
        canHelp: function () {
          return this.screen !== 'result' && this.screen !== 'connecting';
        },

        // ---------------- 槽位：已占用 + 空位一起画 ----------------
        // 【要解决的问题】武器/被动各有 6 格上限，界面原来只画「已经学了的」——
        //   玩家看到 3 个槽，不知道总共 6 格，也不知道还剩 3 格能学。
        //   补成定长列表后，空位会渲染成淡色空槽，「还有几个位置」一眼可见。
        // ★上限从 const 现取，不在模板里写死 6：以后调 SLOTS 界面自动跟着变。
        weaponSlots: function () {
          return padSlots(hud.weapons, window.VS.CONST.SLOTS.weapon);
        },
        passiveSlots: function () {
          return padSlots(hud.passives, window.VS.CONST.SLOTS.passive);
        },

        // ---------------- 剧情模式（第十五轮）-----------------
        // 全部从 shared/campaign.js 的关卡定义现算，改数据界面自动跟着变。
        // ★不用 Map 缓存：卷首页只在进关前渲染一次，
        //   每帧反复求值才会成为性能问题（名字表在 sim 侧已缓存，见 createWorld）。
        isCampaign: function () { return isCampaign; },
        campaignTotal: function () { return campaignTotal; },
        stageNo: function () { return storyStage ? (storyStage.no || 0) : 0; },
        stageNameOf: function () { return storyStage ? storyStage.name : ''; },
        stageEpigraph: function () { return storyStage ? (storyStage.epigraph || '') : ''; },
        // 地图名走开局解析的名字表（剧情名，不是「血色回廊」而是「血霞回廊」）
        mapNameOf: function () {
          if (!storyStage) return '';
          const w = world;
          if (w && w.nameTable) return w.nameTable.map[storyStage.mapId] || storyStage.mapId;
          return CAMPAIGN.mapName(modId, storyStage.mapId);
        },
        // 时长取整到分钟（4 分钟而不是 240 秒 —— 卷首页要的是「这关打多久」）
        stageMinutes: function () {
          return storyStage ? Math.round(storyStage.matchSec / 60) : 0;
        },
        charNameOf: function () {
          if (!storyStage) return '';
          return CAMPAIGN.charName(modId, storyStage.startChar);
        },
        charDescOf: function () {
          if (!storyStage) return '';
          const def = window.VS.CONST.CHAR_MAP[storyStage.startChar];
          return def ? def.desc : '';
        },
        stageBossName: function () {
          if (!storyStage || !storyStage.boss) return '';
          // ★走 bossDisplayName 而不是 mobName：第五关的假身显示名是「空壳」，
          //   按 id 查会拿到「女娲」，把第六关的反转剧透掉。
          return CAMPAIGN.bossDisplayName(modId, storyStage);
        },
        // 难度按钮组（卷首页用）
        diffs: function () { return window.VS.CONST.DIFFICULTIES; },
        diffDescOf: function () {
          const d = window.VS.CONST.diffById(ui.diffId);
          return d ? d.desc : '';
        },
        // 结算页的「下一关」：最后一关时为 false（那时该显示的是「回到选关」）
        hasNextStage: function () {
          if (!storyStage) return false;
          return !!CAMPAIGN.nextStage(modId, realStageId);
        },

        // ---------------- 卷首页：换角色 ----------------
        // 关卡推荐角色（startChar）的 id —— 模板用它给那颗方块加「默认」标记
        storyCharDefault: function () {
          return storyStage ? storyStage.startChar : '';
        },
        // 玩家已主动换的角色（空 = 用默认）
        storyCharPicked: function () { return ui.charId || ''; },
        // 可选角色列表（带剧情名），供卷首页遍历。
        // ★★这里必须返回「已经算好名字的列表」，不能暴露一个 storyCharName(c)
        //   给模板调用 —— Vue 3 的 computed 是 getter，模板里带参数调用会直接抛
        //   `xxx is not a function`，而那是**渲染中断**：整页白屏、连 VS_GAME 都挂不上。
        //   实测踩过。凡是「按参数取值」的需求，一律先算成列表再遍历。
        storyChars: function () {
          const out = [];
          for (let i = 0; i < C.CHARACTERS.length; i++) {
            const c = C.CHARACTERS[i];
            out.push({
              id: c.id,
              name: CAMPAIGN.charName(modId, c.id),
              desc: c.desc
            });
          }
          return out;
        },
        storyCharPickedName: function () {
          if (!ui.charId) return '';
          return CAMPAIGN.charName(modId, ui.charId);
        },
        storyCharPickedDesc: function () {
          if (!ui.charId) return '';
          const def = window.VS.CONST.CHAR_MAP[ui.charId];
          return def ? def.desc : '';
        },
        // ---------------- 商店与角色数据 ----------------
        // 商店只在单机出现：联机世界停不下来，在暂停面板里购物是危险的半吊子
        canShop: function () { return !ui.online; },
        shopItems: function () { return SHOP_ITEMS; },

        // ---------------- 两段式商店：选择器的清单与状态 ----------------
        // ★这几条必须返回**算好的列表**，不能让模板调用 buildPickList(true) 这种带参形式 ——
        //   Vue 3 里 computed 是 getter，模板带参调用会直接抛 `xxx is not a function`，
        //   后果是渲染中断、整页白屏（项目踩过，campaigntest 有断言守）。
        pickOwnedList: function () { return buildPickList(true); },
        pickUnownedList: function () { return buildPickList(false); },
        // 选择器的标题与按钮文案：跟着模式与价格变，模板只做取值。
        pickTitle: function () {
          return ui.pick.mode === 'swap'
            ? '置换契约：先点要遗忘的，再点要换上的'
            : '血脉契约：点一件要习得的技能';
        },
        pickReady: function () {
          if (!ui.pick.open) return false;
          if (ui.pick.mode === 'swap') return !!(ui.pick.drop && ui.pick.pick);
          return !!ui.pick.pick;
        },
        pickBtnText: function () {
          const it = itemOf(ui.pick.itemId);
          const price = it ? it.price : 0;
          return (ui.pick.mode === 'swap' ? '确认置换' : '确认习得') + '（' + price + ' 金）';
        },
        // 底部的状态行：把「还差多少金币 / 下一步该点哪」「换的是什么」说清楚，
        // 否则玩家只看到一个灰掉的确认按钮，不知道该干什么。
        pickNote: function () {
          const it = itemOf(ui.pick.itemId);
          if (!it) return '';
          if (hud.shopGold < it.price) return '金币不够：还差 ' + (it.price - hud.shopGold) + ' 枚';
          if (ui.pick.mode === 'swap') {
            if (!ui.pick.drop) return '① 先点一件要遗忘的技能';
            if (!ui.pick.pick) return '② 再点一件要换上的技能';
            return '遗忘「' + skillName(ui.pick.drop) + '」→ 习得「' + skillName(ui.pick.pick) + '」';
          }
          if (!ui.pick.pick) return '点一件要习得的技能';
          return '将习得「' + skillName(ui.pick.pick) + '」（1 级）';
        },
        // 说明卡开没开（模板用它控制整块卡片的 v-if）
        slotCardOpen: function () { return !!ui.slotInfo || ui.mySkillsOpen; },
        // 「我的技能」列表：已拥有的武器（含进化形态）/ 被动 / 组合技。
        // 顺序固定为 武器 → 被动 → 组合技，和左下角槽位行的顺序一致。
        mySkills: function () {
          const out = [];
          const put = function (list, tagText) {
            for (let i = 0; i < (list || []).length; i++) {
              out.push({
                id: list[i].id,
                name: skillName(list[i].id),
                lv: list[i].level,
                tagText: tagText
              });
            }
          };
          put(hud.weapons, '武器');
          put(hud.passives, '被动');
          put(hud.combos, '组合技');
          return out;
        },
        // 三选一里只剩「补给」这一个兜底项 = 技能全练满了（sim 只在什么都给不出来时塞它）
        supplyOnly: function () {
          const ch = hud.choices;
          return !!(ch && ch.length === 1 && ch[0] && ch[0].type === 'fallback');
        },
        // 角色详细数据：把乘区换算成玩家看得懂的单位。
        // ★只显示**存在且非默认值**的项 —— 满屏「暴击 0% / 斩杀 0% / 反刺 0」是噪音，
        //   而玩家真正关心的是「我这次升级把什么点起来了」。
        //   up 标记表示它 > 1（或 > 0），界面据此高亮，让「变强了」这件事看得见。
        charDetail: function () {
          const d = hud.detail;
          if (!d) return [];
          const out = [];
          // 固定几项：它们是所有角色都有的，是这一屏的「基准线」
          out.push({ k: '血量上限', v: d.maxHp });
          out.push({ k: '护甲', v: d.armor });
          out.push({ k: '移速', v: d.speed });
          out.push({ k: '伤害倍率', v: '×' + d.dmgMul, up: d.dmgMul > 1 });
          out.push({ k: '冷却倍率', v: '×' + d.cdMul, up: d.cdMul < 1 });
          out.push({ k: '范围倍率', v: '×' + d.rangeMul, up: d.rangeMul > 1 });
          out.push({ k: '拾取范围', v: '×' + d.pickupMul, up: d.pickupMul > 1 });
          out.push({ k: '经验获取', v: '×' + d.expMul, up: d.expMul > 1 });
          out.push({ k: '金币获取', v: '×' + d.goldMul, up: d.goldMul > 1 });
          // 条件属性：只有真的点了才显示
          if (d.crit > 0) out.push({ k: '暴击率', v: d.crit + '%', up: true });
          if (d.exec > 0) out.push({ k: '残血斩杀', v: '+' + d.exec + '%', up: true });
          if (d.regen > 0) out.push({ k: '每秒回血', v: d.regen, up: true });
          if (d.killHeal > 0) out.push({ k: '击杀回血', v: d.killHeal, up: true });
          if (d.thorns > 0) out.push({ k: '反伤', v: d.thorns, up: true });
          return out;
        },
        // 我在跟谁的名字。观战界面上没有名字的话，玩家会不知道自己在看谁。
        followName: function () {
          const list = ui.netPlayers || [];
          for (let i = 0; i < list.length; i++) {
            if (list[i].slot === ui.followSlot) return list[i].name || ('座位 ' + ui.followSlot);
          }
          return '—';
        }
      },
      // 生命周期钩子：角色选择界面（单机入口）的立绘要按当前选择重画。
      // 【注意这个选项对象里曾经出现过两个 methods】后一个会整个覆盖前一个，
      // 于是「复制链接 / 邀请队友」那几个方法全部失效（点一下报「不是函数」）。
      // 现在全项目只有下面这一份 methods。
      mounted: function() {
        this.renderCharacterPortraits();
      },
      updated: function() {
        if (this.screen === 'select') {
          this.$nextTick(() => {
            this.renderCharacterPortraits();
          });
        }
      },
      methods: {
        renderCharacterPortraits: function() {
          const CP = window.VS && window.VS.CharacterPortraits;
          if (!CP || this.screen !== 'select') return;

          // Render portrait for each character
          this.chars.forEach(c => {
            const refName = 'portrait_' + c.id;
            const canvasArray = this.$refs[refName];
            if (canvasArray && canvasArray[0]) {
              const canvas = canvasArray[0];
              CP.renderPortrait(canvas, c.id, 160);
            }
          });
        },
        pickChar: pickChar,
        isLocked: isLocked,
        charStats: charStats,
        weaponName: weaponName,
        startMatch: startMatch,
        togglePause: togglePause,
        // ★这个必须挂：模板上的 @click="cycleSpeed" 只能访问 setup 返回的东西，
        //   忘了挂的表现是「按钮点了没反应，也不报错」—— 属于最难查的那类静默失效。
        cycleSpeed: cycleSpeed,
        restart: restart,
        backToLobby: backToLobby,
        backToRoom: backToRoom,
        choose: choose,
        openShare: openShare,
        closeShare: closeShare,
        copyShareLink: copyShareLink,
        cycleFollow: cycleFollow,
        // ---------------- 剧情模式（第十五轮）-----------------
        // 「下一关」：把本关进度已记、直接跳到下一关的 URL。
        // 【为什么用整页跳转而不是「就地重建世界」】
        // 每一关的地图、怪池、初始角色、时长全都不同 —— 就地重建要
        // 把 ui / hud / renderer / 音效 / 计时器全部重置一遍，
        // 任何一处漏掉就是「上一关的残留」。整页跳转是**唯一不会漏**的做法：
        // 换关本来就是「换一个世界」，重新加载是最贴切的语义。
        // 代价是几十毫秒的白屏，但玩家刚看完卷尾文字，感知不到。
        //
        // ★这里为什么用 replace 而不是 assign / nav.enterGame：
        //   逐关推进不该在历史栈里堆一串「第1关→第2关→第3关」。
        //   否则玩家通关后按返回键，会一路倒着重玩刚才打过的关卡 ——
        //   与「返回不关站」同一个毛病（历史栈乱长）。replace 把这一条换成新的，
        //   于是通关后按返回 = 回大厅（此时栈是 [大厅][当前关]）。
        nextStage: function () {
          if (!storyStage) return;
          const nx = CAMPAIGN.nextStage(modId, realStageId);
          if (!nx) {
            console.log('[story] 已是最后一关，没有下一关');
            return;
          }
          const NAV = window.VS && window.VS.NAV;
          const url = NAV ? NAV.gameUrl({ mod: modId, stage: nx.id, debug: DEBUG ? '1' : '' })
                          : '/game?mod=' + encodeURIComponent(modId) + '&stage=' + encodeURIComponent(nx.id);
          console.log('[story] 进入下一关 ' + nx.id + '「' + nx.name + '」 → ' + url);
          window.location.replace(url);
        },
        // 卷首页换角色：点一下切换，再点同一个等于取消（回到关卡默认）
        pickStoryChar: function (c) {
          ui.charId = (ui.charId === c.id) ? '' : c.id;
          console.log('[story] 换角色 → ' + (ui.charId || '（关卡默认）'));
        },
        // 这个角色是不是玩家主动选的（模板据此标高亮）
        isStoryCharPicked: function (c) {
          return ui.charId === c.id;
        },
        stopSpectate: stopSpectate,
        toggleHelp: toggleHelp,
        openHelp: openHelp,
        closeHelp: closeHelp,
        chooseHelp: chooseHelp,
        buy: buy,
        canBuy: canBuy,
        isMaxed: isMaxed,
        // 两段式商店
        openPick: openPick,
        closePick: closePick,
        pickChoose: pickChoose,
        confirmPick: confirmPick,
        // 技能说明卡
        onSlotsClick: onSlotsClick,
        toggleSlotsFold: toggleSlotsFold,
        showSkillInfo: showSkillInfo,
        openMySkills: openMySkills,
        closeSlotCard: closeSlotCard,
        openHelpFor: openHelpFor,
        // 升级自动领补给
        toggleAutoSupply: toggleAutoSupply
      }
    }).mount('#hud');

    // 起渲染循环。先在角色选择阶段建一个世界铺背景，
    // 因为此时 screen 不是 playing，sim 不会推进，画面是静止的地图预览。
    // 联机模式下这个本地世界只用来铺背景，真正的画面来自服务端快照。
    world = buildWorld();
    rafId = requestAnimationFrame(loop);

    // 联机：循环起好就连服务器，握手后申请回到这一局
    if (ONLINE) {
      ui.netSlot = savedMatch.selfSlot !== undefined ? savedMatch.selfSlot : -1;
      connectOnline();
    }

    console.log('[game] 页面就绪 昵称=' + nickname + (isGuest ? '（游客）' : '（账号）') +
      (ONLINE ? ' 模式=联机 房间=' + roomCode : ' 模式=单机'));
  }

  // 秒数转人话
  function formatSec(sec) {
    const n = Math.max(0, Math.floor(sec));
    if (n < 60) return n + '秒';
    const m = Math.floor(n / 60);
    const s = n % 60;
    return m + '分' + (s < 10 ? '0' + s : s) + '秒';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
