// shared/proto_bin.js —— 对局快照的二进制协议（P2-5）
//
// 为什么要有这个文件
// ------------------
// 原来的快照是 JSON：单只怪约 166 字节，1200 只怪 → 单包约 195 KB →
// 20Hz 下单玩家下行约 3.9 MB/s。里面绝大部分是**字段名**和**小数点后十几位**
// 这种纯粹的开销（`"px":1234.5678901234,` 一共 21 个字节，实际只需要 2 个）。
//
// 二进制把它压到十几字节，同样的怪量下行直接掉一个数量级。
//
// 改这个文件之前先读这几条
// ------------------------
//   1. **本文件是协议的唯一权威**。字段表（SCHEMA）既拿来编解码，也**派生**出逻辑快照的
//      字段白名单（F_MOB 等）。match.js 从这里取白名单，客户端从这里取解码器 ——
//      两端不可能各写一份然后慢慢漂移。加字段只改 SCHEMA 一处。
//   2. **编解码是字段表驱动**的，不是给每种实体手写一遍编解码。加字段 = SCHEMA 加一行。
//      assertSchema() 在模块加载时自检（可选位重复、类型写错、必需字段缺失都会报错）。
//   3. **px/py 可以整帧省掉**（省 4 字节/怪）。前提是「相邻两帧正好差一个 tick」，
//      此时服务端的 px 恰好等于客户端上一帧拿到的 x，客户端按 id 从上一帧重建即可。
//      不满足这个前提（snapshotHz < TICK_HZ）时调用方必须传 omitPrev=false，
//      走「绝对坐标 + 显式 px/py」的老实路径 —— **正确性优先于省字节**。
//   4. 数字一律变长整数。坐标 0.25px 精度（够用：屏幕上 0.25px 看不出来），
//      各种计时器保持 2 位小数（和逻辑快照的 r2 一致，round-trip 无损）。
//   5. 字符串（颜色 / kind / defId / charId）走**静态串池**，1 字节一个。
//      池外的字符串走「长格式」兜底，能正常收发但更占字节 ——
//      matchtest 里有断言盯着「长格式出现 0 次」，一旦有人加了新怪/新特效
//      忘了补池，测试会立刻红，而不是带宽悄悄退化。
//   6. 帧是自描述的（头里有 flags），所以解码端不需要任何「服务端怎么发的」先验知识。
//
// 帧结构
// ------
//   u8    magic 0x01      —— 与 JSON 文本帧区分（JSON 以 '{' 0x7b 开头）
//   u8    version
//   u8    flags           bit0 关键帧 / bit1 通关 / bit2 省了 px/py
//   uvint tick
//   uvint time*100
//   uvint aliveMobCount
//   u8    wave
//   然后 9 个实体列表，每个：uvint count + count 个实体记录
//
// 实体记录
//   u8    flags           bit0..6 = 可选字段存在位；bit7 = alive 为 false
//   然后按 SCHEMA 顺序写字段：可选字段按位有无，px/py 在被省掉时不写

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.VS = root.VS || {};
    root.VS.PROTO_BIN = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // ============================================================
  // 1. 常量
  // ============================================================

  const VERSION = 1;
  const T_SNAP = 0x01;

  // 帧头 flags
  const F_KEY = 0x01;         // 关键帧：px/py 一定显式带上（客户端借此重整基线）
  const F_WON = 0x02;         // 本局已通关
  const F_PREV_OMIT = 0x04;   // px/py 被省掉了 → 客户端必须按 id 从上一帧重建
  // 观战标记位。为什么走 flags 而不是加进 SCHEMA：
  // SCHEMA 是**实体列表**的字段表（怪/掉落/特效…），帧级属性不在里面。
  // 而「这一份是观战视角」恰恰是帧级属性 —— 加进 SCHEMA 会让它变成
  // 「每个实体都带一个 spectating」，纯属浪费。
  // flags 只剩 bit3..7，其中 bit7 在帧头未被占用（E_ALIVE_FALSE 只用于实体 flags），
  // 取 bit3 足够，且给以后留了余量。
  const F_SPECTATING = 0x08;

  // 实体 flags
  const E_ALIVE_FALSE = 0x80; // 置位表示 alive=false（多数实体活着，省一个字节）
  const OPT_BITS = 7;         // 可选字段只能占 bit0..6

  // 串池：颜色 / kind / defId / charId。
  // 这些值的可能取值是**有限且编译期已知**的，所以可以静态固化，
  // 两端不需要任何握手就天然一致（这是敢用「索引」的前提）。
  // 来源：const.js 的 MOBS/CHARACTERS 配色与 id、sim.js 里各种 kind 字面量。
  //
  // 【本文件加载时会自检「const.js 里的怪 id / 角色 id / 配色是否都在这儿」，
  //   漏加会直接报错 —— 因为漏加的后果是「悄悄多出几十 KB/s 带宽」，
  //   不报错的话只有带宽断言能发现（本轮就是这么发现的，见 assertStrPool）。
  //   新增值请一律**追加在数组末尾**，理由见下面的说明。】
  const STR_POOL = [
    // 颜色
    '#6f8a5a', '#7a1224', '#7d8590', '#7ee08a', '#7fc6e8', '#8a7b46', '#8c2f4a',
    '#8c3034', '#9fd39f', '#a3454d', '#a8b6c4', '#b0793a', '#cfc7b0', '#d9dde3',
    '#dfe6ef', '#e6dcc6', '#e8d9b8', '#e8dcc0', '#f2c14e', '#ff4d4d', '#ff5c7a',
    '#ff6b6b', '#ff8c42', '#ff9f45', '#ffcf5c', '#ffd166', '#ffe08a', '#fff3b0',
    // 怪物 id
    'corpse', 'bat', 'skeleton_warrior', 'gargoyle', 'blood_priest', 'witch_hunter', 'blood_lord',
    // 角色 id
    'hunter', 'nun', 'scholar', 'blacksmith',
    // 掉落物 kind
    'exp', 'gold', 'heart',
    // 弹幕 kind
    'arc', 'line', 'ring', 'homing', 'boomerang', 'parabola',
    // 区域 / 打击 的 kind
    'zone', 'strike',
    // 特效 kind
    'death', 'hitplayer', 'boom',

    // ============================================================
    // 本轮新增（角色 4→8、怪物 7→14）
    // ============================================================
    // 【为什么全部追加在末尾，而不是插到上面各自的分组里】
    // 串池的**索引就是协议本身**：插到中间会让它后面所有值的索引整体后移，
    // 于是「浏览器里还缓存着旧 game.js 的玩家」会把索引解成完全不同的字符串
    //（他那边索引 30 是 A，我这边索引 30 是 B —— 解码端越界只会返回空串，
    // 更要命的是**没越界但错位**的情况，那是最难查的一类错）。
    // 追加在末尾则所有已有索引一个都不动，老客户端至少能把老内容解对，
    // 新内容顶多显示不出来。宁可少显示，也不能显示错。
    //
    // 新增怪物 id（4 普通 + 3 Boss）
    'plague_hound', 'blood_spider', 'bone_knight', 'ghoul_matriarch',
    'bone_tyrant', 'abyss_prelate', 'moon_queen',
    // 新增角色 id
    'knight', 'thief', 'witch', 'monk',
    // 新增配色（新怪 / 新 Boss）
    '#7d6a3f', '#8f2f3a', '#b8b3a2', '#6f3a35',
    '#a89f88', '#5c6270', '#9c1f33',
    // ============================================================
    // 第三十三轮补漏：sim 里一直在用、但**从没进过池**的两个特效 kind
    // ============================================================
    // 【怎么发现的】matchtest 那条「字符串全部命中静态串池」突然报了 longForm=2 {kind:2}。
    //   查下来不是新代码引进来的，而是这两个值一直都漏着：
    //     · 'hit'    —— 弹幕撞上障碍时的小特效（sim.js 里 pointBlocked 那一支）
    //     · 'revive' —— 联机阵亡后复活的冷色金圈（sim.js 的 revivePlayer）
    //   平时跑不到就一直是绿的：'hit' 要求子弹正好撞墙，'revive' 要求有人死过一次。
    //   一旦跑到，每个实体每帧都走长格式（1 字节标记 + 1 字节长度 + N 字节 UTF-8），
    //   而特效是每帧全量下发的 —— 这就是「不报错的带宽劣化」，只能靠这条断言抓。
    // 追加在末尾：已有索引一个都不动，老客户端解出来的老内容仍然是对的。
    'hit', 'revive',
    // ★第三十三轮第二个漏网：掉落物的 'chest'（Boss 宝箱 + 每张图 3 个固定宝箱）。
    //   上面「掉落物 kind」那段只列了 exp/gold/heart —— 宝箱是第二十八轮加地图宝箱时
    //   引进来的，当时没人回头看串池。它平时跑不到是因为宝箱点位大多在视野外，
    //   只有走到跟前的那一两帧才进快照（matchtest 抓到 longForm=2 就是这么来的）。
    'chest',
    // ★第三十四轮：挑战者（局外事件刷出的单只精英）。它的 defId 每帧都要进快照，
    //   漏进池子就会一直走长格式 —— 好在 assertStrPool 现在会自动扫 const.js 的怪表，
    //   漏了直接启动报错，不用等带宽断言。配色同理。
    'challenger', '#c9963a',
    // ★第三十五轮：上古神龛（掉落物 kind）。与 'chest' 同一类东西 ——
    //   平时在视野外、只有走到跟前那一两帧才进快照，漏进池子就是「偶尔一阵长格式」，
    //   只能在带宽断言里抓（bintest 现在直接扫 sim.js 源码，漏了必红）。
    'shrine',
    // ★第四十轮：陨星（打击 kind）。它是**每 95 秒才有一次**的实体，
    //   不进池也没太大带宽影响，但同一类值的处理必须一致 ——
    //   而且「偶尔一次长格式」恰恰是最难在带宽断言里看清的那种。
    'meteor',
    // ★第四十一轮：山魈（事件型召唤精英）。它的 defId 每帧都要进快照，
    //   配色走同一套 MOB_MAP 扫描 —— bintest 会在启动时逐项核对，漏了必红。
    'shanxiao', '#b25a33',
    // ★第四十二轮：地脉灵泉（打击 kind 'ley'）与它的玉青色。
    //   ★色值必须进池：strikes.color 是 str 字段，池外字符串每帧都走长格式，
    //     而灵泉在地上要活 16 秒（= 320 帧都在快照里），漏进池就是一段持续的带宽劣化。
    //   ★'leyring' 是爆发的**边界环**特效 kind（库里没有对应特效，走 Canvas 几何那一支）。
    'ley', '#5fe0b0', 'leyring',
    // ★第四十三轮：血祭坛（掉落物 kind 'pact'）。
    //   与 'chest' / 'shrine' 同一类东西：光看名字就知道它必须进池 ——
    //   bintest 现在直接扫 sim.js 源码里的 kind 字面量，漏了必红。
    //   ★配色不进池：pickups 的字段表里没有 color（快照只发 kind/value），
    //     祭坛的颜色由客户端查 C.BLOODPACT.color 得到。
    'pact',
    // ★第四十五轮：双生妖（事件型一对精英）。defId 每帧都要进快照，
    //   配色走同一套 MOB_MAP 扫描（assertStrPool 启动时逐项核对，漏了直接起不来）。
    //   ★它的色值还会出现在快照里：复活那一下的 boom 特效带 color，是 str 字段。
    'twins', '#8fb6c8',
    // ★第四十六轮：引魂灯（掉落物 kind 'lantern'）与收尾冲击的两条特效
    //   （kind 'lanterncore' = 暖光爆闪、'lanternring' = 240 判定边界环）。
    //   与 'chest'/'shrine'/'pact' 同一类东西 ——
    //   bintest 直接扫 sim.js 源码里的 `spawnPickup(w, '...')` / `kind: '...'`，漏了必红。
    //   ★'lanterncore' 与 'lanternring' 都是**自绘**的（pixelfx 里没有这两个名字，
    //     effectFor 返回 null，落到 render.js 的 drawEffects）：见那两处的说明，
    //     用 boom / ring 会分别被画成"天降雷柱"和"铺满半屏的白色符文线框"（都试过）。
    //   ★配色 #ffcf5c 本来就在池里（陨星预警环同色），不必重复追加：
    //     串池里出现两次同一个值会让「索引即协议」这条前提多一个坑。
    'lantern', 'lanternring', 'lanterncore',
    // ★第四十七轮：饕餮（事件型窃贼精英）。defId 每帧都要进快照，
    //   配色走同一套 MOB_MAP 扫描（assertStrPool 启动时逐项核对，漏了直接起不来）。
    //   ★'devour' 是它「吞下一份」的特效 kind（自绘：一圈往回收的光）。
    //     在 pixelfx 里没有这个名字 → effectFor 返回 null → 落到 render.js 的 drawEffects，
    //     这正是我们要的：借 boom / ring 会被画成雷击或符文阵，方向还反了（它们都是往外炸）。
    'taotie', '#55663c', 'devour',
    // ★第四十八轮：歧路双碑（掉落物 kind 'boon'）与「另一座当场碎裂」的特效
    //   （kind 'boonshatter'）。
    //   · 'boon' 与 'chest'/'shrine'/'pact'/'lantern' 同一类东西（走上去才生效的地面物件），
    //     bintest 直接扫 sim.js 源码里的 `spawnPickup(w, '...')` / `kind: '...'`，漏了必红。
    //   · ★两座碑**共用一个 kind**，靠 pickups.value（1 / 2）区分是哪一座 ——
    //     用 value 而不是两个 kind，是为了只往池里加一个字符串（能少一个就少一个坑）。
    //   · 'boonshatter' 在 pixelfx 里没有这个名字 → effectFor 返回 null → 落到
    //     render.js 的 drawEffects 自绘（灰白的碎裂尘环）。借 boom 会被画成
    //     「雷部神锤的金色雷击」（引魂灯那轮试错过），语义完全不同。
    'boon', 'boonshatter',
    // ★第四十九轮：镇妖钟（掉落物 kind 'bell'）。
    //   与 'chest'/'shrine'/'pact'/'lantern'/'boon' 同一类东西（走上去才生效的地面物件），
    //   bintest 直接扫 sim.js 源码里的 `spawnPickup(w, '...')` / `kind: '...'`，漏了必红。
    //   · 钟响时的圈走 **zones**（不是新 kind）：它的配色 #e8d9b8 本来就在池里
    //     （素白），所以这一轮**一个新色值都不用加**。
    //   · ★为什么钟声不做成特效 kind：圈画在哪儿、牵引就管到哪儿 —— 两者必须是
    //     同一个半径，而 zones 的 r 本来就是**判定半径**，特效的缩放则要经过
    //     pixelfx 的 effectFor 换算（那里夹了上限，改大判定半径画面上也不会长大）。
    'bell',
    // ★第五十轮：影傀 / 罔两（事件怪 + 它们的两套配色）。
    //   两只怪的 defId 与 def.color 都会进「每帧快照」，不进池就要走长格式
    //   （assertSchema 的自检直接把它们点出来了，不用等 bintest 发现带宽变胖）。
    //   · 影傀的标记环色 #dfe6ef 本来就在池里（冷白，第四十九轮之前就有）——
    //     所以标记环不用再加色值，只有这两个怪本体色是新的。
    //   · 合体爆点用的是 #ffd166（琥珀金），也在池里。
    'shadow_puppet', 'wangliang', '#9aa7b3', '#524842',
    // ★第五十一轮：精卫衔石。三样东西要进池 ——
    //   · 'escort' 是掉落物 kind（pickups.kind 是 str 字段，不进池就走长格式）；
    //   · '#eaf2f8'（羽绒白）与 '#8fd3e8'（海青航迹）是**新色值**：它们会跟着
    //     掉落物的特效一起过线（fx.color 是 str 字段）。
    //   · ★她的血量不进协议：走 pickups.value（0~100 的百分比）。
    //     与「灵泉复用 strikes.delay 当充能进度」同一条路子 —— 能借就不加字段。
    'escort', '#eaf2f8', '#8fd3e8',
    // ★同轮：'feathers' 是她折翼时的自绘特效（pixelfx 里没有这个名字 →
    //   effectFor 返回 null → 落到 render.js 的 drawEffects）。
    //   借 boom 会被画成一记金色雷击，语义正好相反（那是"打赢了"的形状）。
    'feathers',
    // ★第五十二轮：大人之市（掉落物 kind 'market'）。
    //   · 与 'chest'/'shrine'/'pact'/'lantern'/'boon'/'bell' 同一类东西
    //     （走上去才生效的地面物件），bintest 直接扫 sim.js 源码里的
    //     `spawnPickup(w, '...')` / `kind: '...'`，漏了必红。
    //   · ★卖的是哪件货不进协议：走 pickups.value（offers 的下标 0/1/2），
    //     客户端拿 C.MARKET.offers[value] 反查名字与价钱 —— 一个字段都不用加
    //     （与「血祭坛 value 固定 1」「精卫 value 当血量百分比」同一条路子）。
    //   · ★配色也一个都不用加：摊子的金/素白/青铜三色本来就都在池里
    //     （#ffd166 / #e8d9b8 / #b0793a），成交那一下走 boom 的金色。
    'market',
    // ★第五十三轮：炼魂鼎（掉落物 kind 'cauldron'）。
    //   与 'market'/'bell'/'boon' 同一类东西（走上去才生效的地面物件），
    //   bintest 直接扫 sim.js 源码里的 `spawnPickup(w, '...')`，漏了必红。
    //   ★代价/回报全按玩家当下状态现算（读 expNext / maxHp），不进协议；
    //     三色（#ff8c42 火橙 / #5fe0b0 玉青 / #ffd166 金）本来就在池里。
    'cauldron',
    // ★第五十五轮：回春巫（事件型支援怪）。defId 与它的本体色都会进每帧快照，
    //   不进池就走长格式（assertSchema 自检会点出来）。
    //   · 'healring' 是它施法时那圈冷灰青的自绘特效（pixelfx 里没有这个名字 →
    //     effectFor 返回 null → 落到 render.js 的 drawEffects）。
    //   · 标记环色 #8fb6c8（双生妖那轮就在池里）、回血光色 #a8b6c4（圣水色，一开始就在池里）
    //     都已有，一个都不用重复追加（重复会让「索引即协议」多一个坑）。
    'huichun', '#c9b980', 'healring'
    //
    // 【角色配色为什么不在这里】玩家与怪物的快照都**只发 id**（players.charId / mobs.defId），
    // 颜色由客户端查表（CHARACTERS / MOBS）得到 —— 一个会变的色值（本轮刚换成马卡龙色系）
    // 进池只会两难：留着旧的等于池里存着没用的死值，改掉又违反「已有一律不动」。
    // 所以角色配色**不进池**。真到哪天要发颜色了，再按「追加在末尾」的规矩加。
  ];
  const LONG_FORM = 255;      // 池外字符串的标记
  const POOL_IDX = Object.create(null);
  for (let i = 0; i < STR_POOL.length; i++) POOL_IDX[STR_POOL[i]] = i;

  // ============================================================
  // 2. 字段表（协议本体）
  // ============================================================
  // t 类型码：
  //   u8   0..255 的整数
  //   uv   无符号变长整数
  //   sv4  有符号变长整数，×4（坐标：0.25px 精度）
  //   sf   有符号变长整数，×100（计时器 / 角度：2 位小数，与 r2 一致）
  //   str  串池索引（池外走长格式）
  //   alv  布尔 alive，走实体 flags 的 bit7
  //   idv  id 增量（相对同一列表里上一个实体的 id，zigzag 变长）
  // o: n —— 可选字段，占实体 flags 的 bit-n（不置位就不写这个字段）
  // prev: 1 —— px/py 这类「上一帧位置」，在省 px/py 的帧里不写

  const SCHEMA = {
    players: [
      { n: 'id', t: 'uv' },
      { n: 'slot', t: 'u8' },
      // 刻意**不发昵称**：昵称是「名单」数据，开局那包 game_start 已经给过全量了，
      // 每帧再发一遍纯属浪费（而且中文昵称只能走长格式，一个人一帧就是十几个字节，
      // 4 人 20Hz 下来 0.6 KB/s —— 对 13 KB/s 的目标来说不是小数）。
      // 客户端要显示队友昵称就读 game_start 的名单，别在这里加回来。
      { n: 'charId', t: 'str' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      { n: 'px', t: 'sv4', prev: 1 },
      { n: 'py', t: 'sv4', prev: 1 },
      { n: 'facing', t: 'sf' },
      { n: 'hp', t: 'uv' },
      { n: 'maxHp', t: 'uv' },
      { n: 'r', t: 'uv' },
      { n: 'alive', t: 'alv' },
      { n: 'level', t: 'uv' },
      { n: 'invuln', t: 'sf' },
      { n: 'pickupRadius', t: 'uv' },
      // 血怒的剩余秒数（第三十八轮）。走可选位 bit6：没在爆发时值是 0，
      // **一个字节都不发** —— 一局里绝大多数帧都是 0，白占带宽没有意义。
      // 用整数秒而不是两位小数：它只用来决定「脚下光环画不画」，
      // 差 0.9 秒根本看不出来；而 sf 要 2 位小数，2 字节/人/帧 × 20Hz 就不划算了。
      { n: 'rage', t: 'u8', o: 6 },
      // 连杀进度（0..needKills-1）。**必发**：它是脚下进度环的唯一来源。
      // 不发的话只有主机看得到进度，队友的光环永远停在 0 ——
      // 「同一个机制在两个人屏幕上长得不一样」是这类不同步里最容易被当成错觉的一种。
      // 1 字节/人/帧，4 人 20Hz 合计 80 B/s，可以忽略。
      { n: 'rageStreak', t: 'u8' }
    ],
    mobs: [
      { n: 'id', t: 'idv' },
      { n: 'defId', t: 'str' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      { n: 'px', t: 'sv4', prev: 1 },
      { n: 'py', t: 'sv4', prev: 1 },
      { n: 'hp', t: 'uv' },
      { n: 'maxHp', t: 'uv' },
      { n: 'r', t: 'uv' },
      { n: 'vx', t: 'sv4', o: 0 },
      { n: 'vy', t: 'sv4', o: 1 },
      { n: 'flash', t: 'sf', o: 2 },
      { n: 'alive', t: 'alv' },
      { n: 'stun', t: 'sf', o: 3 },
      { n: 'charging', t: 'sf', o: 4 },
      // 词缀 id（0 = 普通怪）。走可选位 bit5：绝大多数怪没有词缀，
      // 值为 0 时**一个字节都不发**，所以六七百只怪同屏也只是多几个字节。
      // 用数字而不是字符串：串池一改就是协议事故，而词缀的全部信息
      // （名字/颜色/系数）都在客户端 const.js 的表里，不需要每帧发。
      { n: 'affix', t: 'u8', o: 5 }
    ],
    shots: [
      { n: 'id', t: 'idv' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      { n: 'px', t: 'sv4', prev: 1 },
      { n: 'py', t: 'sv4', prev: 1 },
      { n: 'r', t: 'uv' },
      { n: 'vx', t: 'sv4' },
      { n: 'vy', t: 'sv4' }
    ],
    projs: [
      { n: 'id', t: 'idv' },
      { n: 'kind', t: 'str' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      { n: 'px', t: 'sv4', prev: 1 },
      { n: 'py', t: 'sv4', prev: 1 },
      { n: 'vx', t: 'sv4' },
      { n: 'vy', t: 'sv4' },
      { n: 'r', t: 'uv' },
      { n: 'color', t: 'str' },
      { n: 'life', t: 'sf' }
    ],
    zones: [
      { n: 'id', t: 'idv' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      { n: 'r', t: 'uv' },
      { n: 'life', t: 'sf' },
      { n: 'maxLife', t: 'sf' },
      { n: 'color', t: 'str' }
    ],
    strikes: [
      { n: 'id', t: 'idv' },
      { n: 'kind', t: 'str' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      // sx/sy/delay 只有部分 kind 会设（'arc' 没有 delay 之类），标成可选
      { n: 'sx', t: 'sv4', o: 0 },
      { n: 'sy', t: 'sv4', o: 1 },
      { n: 'r', t: 'uv' },
      { n: 'life', t: 'sf' },
      { n: 'delay', t: 'sf', o: 2 },
      { n: 'color', t: 'str' }
    ],
    orbits: [
      { n: 'id', t: 'idv' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      { n: 'size', t: 'uv' },
      { n: 'color', t: 'str' }
    ],
    pickups: [
      { n: 'id', t: 'idv' },
      { n: 'kind', t: 'str' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      { n: 'px', t: 'sv4', prev: 1 },
      { n: 'py', t: 'sv4', prev: 1 },
      { n: 'value', t: 'uv' },
      // 大经验球标记（0/1）。只影响渲染（画得更大更亮），但**必须进快照** ——
      // 不进的话只有主机看得到大球，队友看到的还是小球：
      // 「同一个球在两个人屏幕上长得不一样」是这类不同步里最容易被当成错觉的一种。
      // 走可选位 bit0：绝大多数掉落物都是小球，值为 0 时不写，等于零开销。
      { n: 'big', t: 'uv', o: 0 }
    ],
    fx: [
      { n: 'kind', t: 'str' },
      { n: 'x', t: 'sv4' },
      { n: 'y', t: 'sv4' },
      // 只有弧线类特效才有 sx/sy/facing/arcDeg（见 sim.js 里死亡特效那几处）
      { n: 'sx', t: 'sv4', o: 0 },
      { n: 'sy', t: 'sv4', o: 1 },
      { n: 'r', t: 'uv' },
      { n: 'facing', t: 'sf', o: 2 },
      { n: 'arcDeg', t: 'sf', o: 3 },
      { n: 'life', t: 'sf' },
      { n: 'maxLife', t: 'sf' },
      { n: 'color', t: 'str' }
    ]
  };

  // 列表顺序即帧内顺序（两端必须一致，所以在这里定死）
  const LISTS = ['players', 'mobs', 'shots', 'projs', 'zones', 'strikes', 'orbits', 'pickups', 'fx'];

  // 从字段表派生白名单：一份数据两个用途（逻辑快照打包 + 二进制编码）
  const FIELDS = {};
  for (let i = 0; i < LISTS.length; i++) {
    FIELDS[LISTS[i]] = SCHEMA[LISTS[i]].map(function (f) { return f.n; });
  }

  // 每个列表的静态属性：有没有 alive、有没有 id、有没有 prev 字段、可选位用了几号
  const META = {};
  for (let i = 0; i < LISTS.length; i++) {
    const name = LISTS[i];
    const flds = SCHEMA[name];
    const m = { alive: null, id: null, prev: false, optBits: [] };
    for (let k = 0; k < flds.length; k++) {
      const f = flds[k];
      if (f.n === 'alive') m.alive = f;
      if (f.t === 'idv') m.id = f;
      if (f.prev) m.prev = true;
      if (f.o !== undefined) m.optBits.push(f.o);
    }
    META[name] = m;
  }

  // 需要「从上一帧重建 px/py」的列表（只有这些列表的 px/py 会被 render 读到）
  const PREV_LISTS = LISTS.filter(function (n) { return META[n].prev; });

  // ============================================================
  // 3. 自检
  // ============================================================
  // 字段表是手写的，写错了只会表现为「某个字段在联机下莫名缺失」——
  // 非常难查。所以这里在**模块加载时**就把结构性错误拦下来。
  function assertSchema() {
    const problems = [];

    for (let i = 0; i < LISTS.length; i++) {
      const name = LISTS[i];
      const flds = SCHEMA[name];
      const seen = Object.create(null);
      const bits = Object.create(null);

      for (let k = 0; k < flds.length; k++) {
        const f = flds[k];

        if (!f.n || typeof f.n !== 'string') problems.push(name + ': 第 ' + k + ' 个字段没有名字');
        if (seen[f.n]) problems.push(name + ': 字段 ' + f.n + ' 重复声明');
        seen[f.n] = true;

        if (['u8', 'uv', 'sv4', 'sf', 'str', 'alv', 'idv'].indexOf(f.t) < 0) {
          problems.push(name + '.' + f.n + ': 未知类型 ' + f.t);
        }
        if (f.o !== undefined) {
          if (!(f.o >= 0 && f.o < OPT_BITS)) problems.push(name + '.' + f.n + ': 可选位 ' + f.o + ' 越界（只能 0..' + (OPT_BITS - 1) + '）');
          if (bits[f.o] !== undefined) problems.push(name + '.' + f.n + ': 可选位 ' + f.o + ' 与 ' + bits[f.o] + ' 冲突');
          bits[f.o] = f.n;
        }
        // idv 只能用在 id 上，且必须排在最前（增量编码依赖「同一列表内顺序」）
        if (f.t === 'idv' && (f.n !== 'id' || k !== 0)) {
          problems.push(name + ': idv 只能用于列表第一个字段且必须叫 id');
        }
      }

      if (META[name].alive && seen['alive'] === false) problems.push(name + ': alive 字段没进字段表');
      if (META[name].prev) {
        if (!seen['px'] || !seen['py']) problems.push(name + ': 标了 prev 但缺 px/py');
      }
    }

    // ---------- 串池完备性 ----------
    // 与上面几项一起报，避免「报了字段表的问题、改了之后又冒出串池的问题」两轮返工。
    const poolProblems = assertStrPool();
    for (let i = 0; i < poolProblems.length; i++) problems.push(poolProblems[i]);

    if (problems.length) {
      throw new Error('[proto_bin] 字段表自检失败：\n  - ' + problems.join('\n  - '));
    }
    return true;
  }

  // 串池完备性自检：const.js 里出现的怪 id / 角色 id / 怪物配色，必须都在 STR_POOL 里。
  //
  // 【为什么要单独立这一条】漏加一个新值的后果**不是报错，而是悄悄变慢**：
  // 那个 defId 每帧都会走「池外长格式」（1 字节标记 + 1 字节长度 + N 字节 UTF-8），
  // 而不是 1 字节的池索引。单个值看着不多，但怪物每帧有几十上百个实体 ——
  // 本轮加了 7 种怪之后下行带宽从 ~190KB/s 涨到 245KB/s，
  // **是 bintest 的带宽断言抓出来的**，没有任何一处报错。
  // 这种「静默劣化」必须靠自检兜住，否则下次还是只能等带宽超标才发现。
  //
  // 拿不到 const.js（工具环境、或某个页面只引了 proto_bin）就跳过：
  // 这是增强检查，不该因为环境不同就硬失败。
  function assertStrPool() {
    const problems = [];

    let C = null;
    if (typeof module === 'object' && module.exports) {
      C = require('./const.js');
    } else {
      const g = typeof self !== 'undefined' ? self
        : (typeof global !== 'undefined' ? global : null);
      C = (g && g.VS && g.VS.CONST) || null;
    }
    if (!C || !C.MOBS || !C.CHARACTERS) return problems;

    const has = Object.create(null);
    for (let i = 0; i < STR_POOL.length; i++) has[STR_POOL[i]] = true;

    function need(v, why) {
      if (typeof v !== 'string' || !v) return;
      if (has[v]) return;
      problems.push('STR_POOL 缺少' + why + ' "' + v +
        '" —— 它会每帧走长格式，白白多占带宽（把它追加到 STR_POOL 末尾即可）');
    }

    for (let i = 0; i < C.MOBS.length; i++) {
      need(C.MOBS[i].id, '怪物 id');
      need(C.MOBS[i].color, '怪物配色');
    }
    for (let i = 0; i < C.CHARACTERS.length; i++) {
      need(C.CHARACTERS[i].id, '角色 id');
    }

    return problems;
  }

  // ============================================================
  // 4. 读写器
  // ============================================================

  function Writer() {
    this.buf = new Uint8Array(24 * 1024);
    this.len = 0;
  }

  Writer.prototype.need = function (n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.buf.subarray(0, this.len));
    this.buf = nb;
  };

  Writer.prototype.u8 = function (v) {
    this.need(1);
    this.buf[this.len++] = v & 255;
  };

  // 无符号变长整数：每字节 7 位，最高位表示「后面还有」。
  // 不用位运算 >> 是为了让超过 2^31 的值也能正确编码（坐标 ×4 之类）。
  Writer.prototype.uv = function (v) {
    let x = Math.round(v);
    if (!(x > 0)) x = 0;
    this.need(6);
    while (x >= 128) {
      this.buf[this.len++] = (x % 128) | 128;
      x = Math.floor(x / 128);
    }
    this.buf[this.len++] = x;
  };

  // zigzag：把负数折到正整数上（0,-1,1,-2,2... → 0,1,2,3,4...），
  // 这样「小负数」也只占 1 个字节。
  Writer.prototype.sv = function (v) {
    const n = Math.round(v);
    this.uv(n < 0 ? (-n * 2 - 1) : (n * 2));
  };

  Writer.prototype.bytes = function (arr) {
    this.need(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  };

  Writer.prototype.str = function (s, field) {
    const idx = POOL_IDX[s];
    if (idx !== undefined) { this.u8(idx); return; }

    // 池外兜底：长格式。这条路径**不该在正常对局里出现** ——
    // 出现就说明有新的颜色/kind/怪物没加进 STR_POOL，带宽会悄悄退化。
    // stats.longForm / longFormByField 就是给测试盯这个的（按字段名分开记，
    // 一眼能看出是哪一类值漏了池）。
    stats.longForm += 1;
    if (field) stats.longFormByField[field] = (stats.longFormByField[field] || 0) + 1;
    // 【别忘了这个标记字节】只写「长度 + 内容」而不写 255 的话，
    // 解码端会把长度字节当成串池下标，读到某个颜色字符串，然后整帧错位。
    // （这个 bug 真发生过，表现是「所有二进制快照都解不出来」。）
    this.u8(LONG_FORM);
    const t = (s === undefined || s === null) ? '' : String(s);
    const n = utf8Write(this, t);
    if (n > 250) stats.longFormTruncated += 1;
  };

  function Reader(buf) {
    this.b = buf;
    this.p = 0;
    // 越界不抛异常（网络来的数据不能把页面搞崩），置 bad 标记，
    // 由 decodeSnapshot 在最后统一判定 —— 这也是本项目「不用 try/catch 做流程控制」的写法。
    this.bad = false;
  }

  Reader.prototype.u8 = function () {
    if (this.p >= this.b.length) { this.bad = true; return 0; }
    return this.b[this.p++];
  };

  Reader.prototype.uv = function () {
    let out = 0;
    let mul = 1;
    for (let i = 0; i < 6; i++) {
      const byte = this.u8();
      out += (byte & 127) * mul;
      if (!(byte & 128)) return out;
      mul *= 128;
    }
    this.bad = true;
    return 0;
  };

  Reader.prototype.sv = function () {
    const z = this.uv();
    return (z % 2) ? -((z + 1) / 2) : (z / 2);
  };

  Reader.prototype.str = function () {
    const idx = this.u8();
    if (idx !== LONG_FORM) {
      const s = STR_POOL[idx];
      if (s === undefined) { this.bad = true; return ''; }
      return s;
    }
    const n = this.u8();
    if (this.p + n > this.b.length) { this.bad = true; return ''; }
    const s = utf8Read(this.b, this.p, n);
    this.p += n;
    return s;
  };

  // ---------- UTF-8（不依赖 TextEncoder，两端行为一致） ----------

  function utf8Write(wr, s) {
    let n = 0;
    const bytes = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);

      // 代理对：合并成一个码点
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const lo = s.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00); i += 1; }
      }

      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));

      if (bytes.length > 250) break;   // 长度字段是 1 字节，超长就截断（昵称不可能这么长）
    }
    wr.u8(bytes.length);
    for (let i = 0; i < bytes.length; i++) wr.u8(bytes[i]);
    return bytes.length;
  }

  function utf8Read(b, off, len) {
    let out = '';
    let i = 0;
    while (i < len) {
      const c = b[off + i];
      i += 1;
      let code;
      if (c < 0x80) code = c;
      else if (c < 0xe0) { code = ((c & 31) << 6) | (b[off + i] & 63); i += 1; }
      else if (c < 0xf0) {
        code = ((c & 15) << 12) | ((b[off + i] & 63) << 6) | (b[off + i + 1] & 63);
        i += 2;
      } else {
        code = ((c & 7) << 18) | ((b[off + i] & 63) << 12) | ((b[off + i + 1] & 63) << 6) | (b[off + i + 2] & 63);
        i += 3;
      }
      if (code > 0xffff) {
        code -= 0x10000;
        out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023));
      } else {
        out += String.fromCharCode(code);
      }
    }
    return out;
  }

  // ============================================================
  // 5. 统计（给测试与 /api/gamestats 看）
  // ============================================================

  const stats = {
    frames: 0,
    bytes: 0,
    entities: 0,
    longForm: 0,           // 池外字符串出现次数（正常应为 0）
    longFormByField: Object.create(null),  // 按字段名分开记：颜色 / kind / defId 哪个漏了池
    longFormTruncated: 0,
    missingRequired: 0     // 必需字段是 undefined 的次数（正常应为 0）
  };

  function resetStats() {
    stats.frames = 0;
    stats.bytes = 0;
    stats.entities = 0;
    stats.longForm = 0;
    stats.longFormByField = Object.create(null);
    stats.longFormTruncated = 0;
    stats.missingRequired = 0;
  }

  // ============================================================
  // 6. 字段级读写
  // ============================================================

  function writeField(wr, f, v) {
    if (v === undefined || v === null) {
      // 必需字段缺失：写个 0 顶上（不能让整帧崩），但记一笔给测试盯
      if (f.o === undefined) stats.missingRequired += 1;
      v = (f.t === 'str') ? '' : 0;
    }
    switch (f.t) {
      case 'u8': wr.u8(v); break;
      case 'uv': wr.uv(v); break;
      case 'sv4': wr.sv(Math.round(v * 4)); break;
      case 'sf': wr.sv(Math.round(v * 100)); break;
      case 'str': wr.str(v, f.n); break;
      case 'alv': break;                 // alive 走 flags 的 bit7，不占字节
      case 'idv': wr.sv(v - wr._lastId); wr._lastId = v; break;
      default: wr.uv(0); break;
    }
  }

  function readField(rd, f, ctx) {
    switch (f.t) {
      case 'u8': return rd.u8();
      case 'uv': return rd.uv();
      case 'sv4': return rd.sv() / 4;
      case 'sf': return rd.sv() / 100;
      case 'str': return rd.str();
      case 'alv': return true;           // 由调用方按 flags 覆盖
      case 'idv': {
        ctx.lastId += rd.sv();
        return ctx.lastId;
      }
      default: return 0;
    }
  }

  // ============================================================
  // 7. 编码
  // ============================================================

  // 复用一个 Writer：20Hz × N 人，每帧都新建一个 24KB 的 buffer 纯属浪费。
  // encodeSnapshot 是同步且不可重入的，所以单例安全。
  const _wr = new Writer();

  function encodeList(name, arr, omitPrev, isKey) {
    const wr = _wr;
    const flds = SCHEMA[name];
    const meta = META[name];
    const n = arr ? arr.length : 0;

    wr.uv(n);
    wr._lastId = 0;

    for (let i = 0; i < n; i++) {
      const e = arr[i];

      // ---- 先算实体 flags ----
      let fl = 0;
      if (meta.alive && e.alive === false) fl |= E_ALIVE_FALSE;
      for (let k = 0; k < flds.length; k++) {
        const f = flds[k];
        if (f.o === undefined) continue;
        const v = e[f.n];
        // 可选字段的语义都是「0 = 没效果」，所以 0 等同于不发送
        if (v !== undefined && v !== null && v !== 0 && v !== false) fl |= (1 << f.o);
      }
      wr.u8(fl);

      // ---- 再按字段表写 ----
      for (let k = 0; k < flds.length; k++) {
        const f = flds[k];
        if (f.o !== undefined && !(fl & (1 << f.o))) continue;
        // 省 px/py 的帧里不写 —— 客户端按 id 从上一帧重建
        if (f.prev && omitPrev && !isKey) continue;
        writeField(wr, f, e[f.n]);
      }

      stats.entities += 1;
    }
  }

  // opts.key      关键帧（px/py 一定带上）
  // opts.omitPrev 允许省 px/py（调用方负责保证 snapshotHz >= tickHz）
  function encodeSnapshot(snap, opts) {
    opts = opts || {};
    const isKey = !!opts.key;
    const omitPrev = !!opts.omitPrev;

    const wr = _wr;
    wr.len = 0;
    wr._lastId = 0;

    let fl = 0;
    if (isKey) fl |= F_KEY;
    if (snap.won) fl |= F_WON;
    if (omitPrev) fl |= F_PREV_OMIT;
    if (snap.spectating) fl |= F_SPECTATING;
    wr.u8(T_SNAP);
    wr.u8(VERSION);
    wr.u8(fl);
    wr.uv(snap.tick || 0);
    wr.uv(Math.round((snap.time || 0) * 100));
    wr.uv(snap.aliveMobCount || 0);
    wr.u8(snap.wave || 0);

    for (let i = 0; i < LISTS.length; i++) {
      const name = LISTS[i];
      encodeList(name, snap[name], omitPrev, isKey);
    }

    stats.frames += 1;
    stats.bytes += wr.len;

    // 必须 slice 出一份拷贝：ws.send 是异步的，直接把 Writer 的底层 buffer
    // 交出去的话，下一帧写入会把它改掉（典型的「数据看起来随机错位」事故）。
    return wr.buf.slice(0, wr.len);
  }

  // ============================================================
  // 8. 解码
  // ============================================================

  // 上一帧的实体按 id 建索引，用于重建被省掉的 px/py。
  // 索引缓存在数组上（不可枚举，不污染 JSON / 字段比较），下一帧直接复用。
  function prevIndexOf(name, arr) {
    if (!arr) return null;
    if (arr.__byId) return arr.__byId;
    const m = new Map();
    for (let i = 0; i < arr.length; i++) m.set(arr[i].id, arr[i]);
    Object.defineProperty(m, '__byId', { value: m, enumerable: false });
    Object.defineProperty(arr, '__byId', { value: m, enumerable: false, configurable: true });
    return m;
  }

  function decodeList(rd, name, omitPrev, isKey, prevSnap) {
    const flds = SCHEMA[name];
    const meta = META[name];
    const n = rd.uv();
    const out = new Array(n);
    const ctx = { lastId: 0 };

    for (let i = 0; i < n; i++) {
      const fl = rd.u8();
      const o = {};

      for (let k = 0; k < flds.length; k++) {
        const f = flds[k];

        // 【可选字段「没写」不等于「没有这个字段」—— 必须补回 0】
        // 编码端把「值等于 0 / false」的可选字段整个省掉（省字节，见 encodeList），
        // 所以解码端有义务把默认值补回去，否则消费方拿到的是 undefined。
        // 真踩过：mobs 的 vx/vy 在怪静止时被省掉 → render.js 算
        // Math.atan2(undefined, undefined) = NaN → 用 NaN 索引旋转图集取到
        // undefined → 整个渲染循环抛异常（画面看起来是「怪只画一半」）。
        // 补 0 之后「解码结果」与「JSON 路径的形状」完全一致，这是协议对外的
        // 不变式：调用方不需要知道哪个字段是可选传输的。
        if (f.o !== undefined && !(fl & (1 << f.o))) {
          o[f.n] = (f.t === 'str') ? '' : 0;
          continue;
        }
        if (f.prev && omitPrev && !isKey) continue;   // 稍后按 id 补
        if (f.t === 'alv') { o[f.n] = !(fl & E_ALIVE_FALSE); continue; }
        o[f.n] = readField(rd, f, ctx);
      }

      out[i] = o;
    }

    // ---- 重建被省掉的 px/py ----
    // 省 px/py 的前提是「上一帧的 x 就是这一帧的 px」，所以直接拿上一帧同 id 的 x/y。
    // 找不到上一帧（新出现的实体、中途加入、刚恢复挂起的对局）就退化成 px=x ——
    // 表现是这一帧不插值，肉眼完全看不出来，但绝不会算出 NaN。
    if (meta.prev && omitPrev && !isKey) {
      const prevArr = prevSnap ? prevSnap[name] : null;
      const idx = prevArr ? prevIndexOf(name, prevArr) : null;
      for (let i = 0; i < n; i++) {
        const o = out[i];
        if (o.px !== undefined) continue;
        const p = idx ? idx.get(o.id) : null;
        if (p) { o.px = p.x; o.py = p.y; }
        else { o.px = o.x; o.py = o.y; }
      }
    }

    return out;
  }

  // prev 传上一帧解码出来的快照（或 null）。
  // 解码失败返回 null —— 调用方直接忽略这一帧，不要抛异常。
  function decodeSnapshot(buf, prev) {
    // 【三种输入都要认】浏览器 binaryType='arraybuffer' 给的是 ArrayBuffer；
    // Node 的 ws 给的是 Buffer；测试里可能给 Uint8Array。
    // 注意 ArrayBuffer 自己**没有** .buffer 属性，早先那个「b.buffer 存在才转换」的写法
    // 会把 ArrayBuffer 原样留在手里，然后 b.length 是 undefined、
    // 越界判断集体失效、解码静默返回 null —— 现象是「浏览器里一条快照都画不出来」。
    let b = buf;
    if (b instanceof ArrayBuffer) b = new Uint8Array(b);
    else if (ArrayBuffer.isView(b)) b = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    else return null;
    if (b.length < 6) return null;

    const rd = new Reader(b);
    if (rd.u8() !== T_SNAP) return null;
    if (rd.u8() !== VERSION) return null;

    const fl = rd.u8();
    const isKey = !!(fl & F_KEY);
    const omitPrev = !!(fl & F_PREV_OMIT);

    const snap = {
      t: 'snap',
      tick: rd.uv(),
      time: rd.uv() / 100,
      aliveMobCount: rd.uv(),
      wave: rd.u8(),
      won: !!(fl & F_WON),
      spectating: !!(fl & F_SPECTATING)
    };

    for (let i = 0; i < LISTS.length; i++) {
      const name = LISTS[i];
      snap[name] = decodeList(rd, name, omitPrev, isKey, prev);
    }

    if (rd.bad || rd.p > b.length) return null;
    return snap;
  }

  // ============================================================
  // 9. 导出
  // ============================================================

  assertSchema();

  return {
    VERSION: VERSION,
    T_SNAP: T_SNAP,
    F_KEY: F_KEY,
    F_WON: F_WON,
    F_PREV_OMIT: F_PREV_OMIT,
    F_SPECTATING: F_SPECTATING,
    LISTS: LISTS,
    SCHEMA: SCHEMA,
    STR_POOL: STR_POOL,
    // 派生出来的字段白名单（match.js 打包逻辑快照用，也是「协议面」的书面定义）
    F_MOB: FIELDS.mobs,
    F_SHOT: FIELDS.shots,
    F_PROJ: FIELDS.projs,
    F_ZONE: FIELDS.zones,
    F_STRIKE: FIELDS.strikes,
    F_ORBIT: FIELDS.orbits,
    F_PICKUP: FIELDS.pickups,
    F_FX: FIELDS.fx,
    F_PLAYER: FIELDS.players,
    encode: encodeSnapshot,
    decode: decodeSnapshot,
    stats: stats,
    resetStats: resetStats,
    assertSchema: assertSchema
  };
});
