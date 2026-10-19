// public/js/lobby.js —— 登录 / 大厅前端逻辑（Vue 3 Options API）
//
// 设计约定：
// 1. 只做界面层：登录态、在线列表、排行榜、连接状态；
//    游戏渲染是 P1 的事，走独立页面与 Canvas，不放在这里。
// 2. 所有玩家昵称都用 {{ }} 文本插值渲染，绝不用 v-html —— 昵称是用户输入，
//    走文本插值由 Vue 自动转义，天然免疫 XSS。
// 3. WebSocket 用浏览器原生 API，不引任何 SDK，保证断网可用。
// 4. 关键分支都打 console 日志（DEBUG 开关），出问题可在控制台直接看到走到哪一步。

const { createApp } = Vue;

// 角色表等共用数值表：浏览器全局名是 VS.CONST，由 /shared/const.js 挂到 window 上
//（和 shared/sim.js 用的是同一份文件，前后端数值不会走偏）。
//
// 【为什么每次现取、不做脚本级 const 缓存】Vue 的模板渲染函数是运行时用
// new Function 编译出来的，它的作用域链只认 window 上的东西，读不到脚本顶层的
// const/let 绑定。曾经写成 const CONST = ... 再在 charName 里用，结果模板渲染时
// 直接 ReferenceError: CONST is not defined，界面静默不更新 —— 极难查。
function constTable() {
  return (window.VS && window.VS.CONST) || {};
}

// P0 阶段打开调试日志，联调完可关掉
const DEBUG = true;

function log() {
  if (!DEBUG) return;
  const args = Array.prototype.slice.call(arguments);
  args.unshift('[lobby]');
  console.log.apply(console, args);
}

// 本地存储键名
const TOKEN_KEY = 'vs_token';
// 头像单独存一个键（而不是塞进 vs_profile）：游戏页要独立读它去握手，
// 而 vs_profile 的写入时机与头像选择并不同步，混在一起容易出现一边新一边旧。
const AVATAR_KEY = 'vs_avatar';
// 上次选的难度。只用来给「创建房间」一个初值 —— 经常开血月局的人不必每建一桌
// 都重新点一遍。它是个偏好，不是房间状态（房间的难度以服务端下发的为准）。
const DIFF_KEY = 'vs_diff';
const MAP_KEY = 'vs_map';     // 地图偏好（建房初值，与难度同一套机制）

// 连接日志保留条数。60 条大约够覆盖「断线 → 重连几次 → 恢复」的完整过程，
// 再多就只是刷屏（面板本身可滚动，60 条也够看）。
const CONN_LOG_MAX = 60;

// 两道「连接看起来还在、其实已经死了」的检测阈值。
//
// 【为什么必须有】前端原本只在 ws.onclose 里重连。但服务端进程消失时（容器重启、
// 发布新版），TCP 连接未必会被正常关闭 —— 连接会进入「半开」状态：消息发得出去、
// 回不来，也永远不触发 onclose。于是重连逻辑压根不启动，界面就一直卡在「未连接」，
// 用户只能自己刷新页面（实测反馈过）。这两道检测把它兜住：
//   ① 握手超时：连上了但迟迟没有 welcome（服务端当时还没准备好），主动掐掉重来；
//   ② 心跳超时：连上之后 pong 断了（连接已死），主动掐掉重来。
const HANDSHAKE_TIMEOUT_MS = 8000;    // onopen 后多久没收到 welcome 就重来
const PING_TIMEOUT_MS = 12000;        // 多久没收到 pong 就判定连接已死
// 连接看门狗：每 4 秒检查一次，只要「该连却没连着」就补一次连接。
// 这是最后一道兜底 —— 上面两道自检覆盖的是「连上了但死了」，而看门狗覆盖的是
// 「重连排程本身出了岔子」（定时器被清掉、页面从 bfcache 恢复等），
// 两个加起来才敢说「不用刷新页面」。见 startWatchdog。
const WATCHDOG_MS = 4000;
const GUEST_KEY = 'vs_guest_nick';

// 扫码进来的房间号：邀请二维码里的地址形如 http://host/?room=AB12。
// 登录 / 游客进入并握手完成后自动加入这桌（见 handleWsMessage 的 welcome）。
const URL_ROOM = (function () {
  const m = /[?&]room=([A-Za-z0-9]+)/.exec(location.search);
  return m ? m[1].toUpperCase() : '';
})();

// 联调开关透传：大厅 URL 带 debug=1 时，跳对局页也要带上（游戏页的调试句柄
// window.VS_GAME 只在有它时才挂，自动化脚本全靠这个读状态）。
//
// 返回 '1' 或 ''，不是 true/false —— nav.gameUrl 只收**字符串**，
// 传 true 会被 encodeURIComponent 变成 "true"，游戏页的 /[?&]debug=1/ 匹配不上。
function dbgFlag() {
  return /[?&]debug=1/.test(location.search) ? '1' : '';
}

createApp({
  // ==========================================================
  // 状态
  // ==========================================================
  data() {
    return {
      // 页面视图：auth=登录注册页，lobby=大厅
      view: 'auth',
      authTab: 'login',

      // 表单
      loginForm: { username: '', password: '' },
      regForm: { username: '', nickname: '', password: '', password2: '' },
      guestNickname: '',

      // 按钮忙状态，防止重复提交
      busy: { login: false, register: false, guest: false, pwd: false },

      // 「设置新密码」小表单（账号用户可见）。
      // 【为什么需要】线上数据每次发布都会回滚，账号会按浏览器里的 token 自动重建，
      // 而重建时库里那个密码哈希是随机写的、谁都不知道 —— 没有这个入口就等于把账号锁死。
      pwdOpen: false,
      pwd1: '',
      pwd2: '',

      // 顶部提示条
      notice: { type: 'info', text: '' },

      // 登录态
      token: '',
      self: { connId: '', userId: null, nickname: '', isGuest: false },
      stats: {
        total_matches: 0, total_kills: 0, best_kills: 0,
        longest_survive: 0, total_play_sec: 0, max_level: 1
      },

      // 在线与排行
      online: [],
      leaderboard: [],
      lbType: 'kills',

      loading: { me: false, lb: false },

      // 连接状态：off=未连上，wait=连接中，on=已连上，retry=断开后正在自动重连
      wsState: 'off',
      ws: null,
      wsRetry: 0,
      pingMs: 0,
      avatar: '',             // 我的头像 id（见 shared/avatars.js）
      prefDiff: 'normal',     // 我上次选的难度（建房初值，见 DIFF_KEY）
      prefMap: '',            // 我上次选的地图（建房初值，见 MAP_KEY）

      // 连接日志：把「连接这条线」上发生的事按时间记下来，直接显示在界面上。
      // 【为什么不能只写 console】线上出问题时玩家看不到控制台，只能截图；
      // 而「未连接 / 连不上 / 刚连上又断」这类问题的全部线索都在这条时间线上。
      // 所以它始终记录（不再依赖 ?debug=1），最新的在最上面，只留最近 60 条。
      connLog: [],            // [{ id, at:'HH:MM:SS', level:'info'|'ok'|'warn'|'err', text }]
      connLogOpen: false,     // 面板是否展开
      connSeq: 0,             // 日志序号（只用来给 v-for 一个稳定 key）
      timeOffset: 0,
      pingTimer: null,        // 延迟探测定时器句柄
      handshakeTimer: null,   // 握手超时定时器（见 connectWs 里的说明）
      lastPongAt: 0,          // 最近一次收到 pong 的时刻（心跳存活检测用）
      watchdogTimer: null,    // 连接看门狗（最后一道兜底，见 startWatchdog）
      reconnectTimer: null,   // 退避重连的定时器（用它排程，避免堆出多条重连链）

      // 扫码进来的房间号（显示在登录页上，让人知道「登进去会自动进这桌」）
      urlRoom: URL_ROOM,

      // 邀请二维码弹层
      shareOpen: false,
      shareCode: '',
      shareUrl: '',
      shareQrFail: false,

      // ---------- 剧情模式（第十五轮）----------
      // 关卡选择弹层是否打开
      storyOpen: false,
      // 当前选中的模组 id。默认取「有进度的那个」，没有就按 MOD_IDS 顺序取第一个真剧情模组。
      // ★不能用 MOD_IDS[0]（那是 vanilla 自由模式，它没有 stages）——
      //   这样写会打开一个空列表，而且不报错，只是「弹层里什么都没有」。
      storyModId: '',

      // 房间容量（P2 由服务端配置下发，P0 先写死）
      maxPlayers: 8,
      tickRate: 20,

      // ---------------- 房间 / 候场室（P2-3） ----------------
      rooms: [],            // 大厅可见的房间列表（服务端广播 room_list）
      room: null,           // 我所在的房间（服务端 room_update 下发；null 表示不在任何房间）
      charId: 'hunter',     // 我在候场室选的角色，进对局时带过去
      roomBusy: false       // 建房 / 加入的防连点
    };
  },

  // ==========================================================
  // 计算属性
  // ==========================================================
  computed: {
    // ---------------- 剧情模式（第十五轮）-----------------
    // 所有派生数据都从 shared/campaign.js 与 js/story-progress.js 现算，
    // 不在这里写死任何关卡名/关卡数 —— 加一关、改个名字，这里自动跟着变。

    // 可选模组列表：只列出**有剧情关卡**的模组。
    // 【为什么排除 vanilla】它是自由模式（stages 为 null），
    // 把它列进来会多出一个点进去空无一物的选项。
    storyMods() {
      const CP = window.VS.CAMPAIGN;
      const out = [];
      for (let i = 0; i < CP.MOD_IDS.length; i++) {
        const m = CP.modById(CP.MOD_IDS[i]);
        if (m.stages && m.stages.length) out.push({ id: m.id, name: m.name });
      }
      return out;
    },
    storyMod() {
      const CP = window.VS.CAMPAIGN;
      return CP.modById(this.storyModId || this.storyMods[0] && this.storyMods[0].id);
    },
    storyModName() { return this.storyMod ? this.storyMod.name : ''; },
    storyModTagline() { return this.storyMod ? this.storyMod.tagline : ''; },
    // 关卡列表：每一关带上「解锁 / 已通关 / 展示用的名字与时长」。
    // ★地图名、角色名、Boss 名全部走 campaign 的名字表（剧情名），
    //   不能直接读 const 的本名 —— 那样会显示「血色回廊」而不是「血霞回廊」。
    storyStages() {
      const CP = window.VS.CAMPAIGN;
      const ST = window.VS.STORY;
      const modId = this.storyModId || (this.storyMods[0] && this.storyMods[0].id);
      if (!modId) return [];
      const list = CP.stagesOf(modId);
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const st = list[i];
        out.push({
          id: st.id,
          no: st.no || (i + 1),
          name: st.name,
          epigraph: st.epigraph || '',
          mapName: CP.mapName(modId, st.mapId),
          minutes: Math.round(st.matchSec / 60),
          startCharName: CP.charName(modId, st.startChar),
          // ★用 bossDisplayName：第五关的假身显示名是「空壳」而不是「女娲」
          bossName: CP.bossDisplayName(modId, st),
          // ★解锁与通关都要读 story-progress.js —— 那是唯一的规则来源。
          //   在这里复刻一遍判断（比如 cleared.indexOf(...) >= 0）就等于两份规则，
          //   迟早会不一致。
          unlocked: ST.isUnlocked(modId, CP, st.id),
          cleared: ST.isCleared(modId, st.id)
        });
      }
      return out;
    },
    storyCleared() {
      const CP = window.VS.CAMPAIGN;
      const ST = window.VS.STORY;
      const modId = this.storyModId || (this.storyMods[0] && this.storyMods[0].id);
      if (!modId) return 0;
      return ST.clearedCount(modId, CP);
    },

    // 连接指示灯样式
    connDotClass() {
      if (this.wsState === 'on') return 'on';
      // 连接中与重连中都是「正在进行」，用同一个黄灯；
      // 只有真的停下来了才是红灯，避免把「正在自愈」误报成故障
      if (this.wsState === 'wait' || this.wsState === 'retry') return 'wait';
      return 'off';
    },

    connText() {
      // 措辞统一走 connStateText()：界面顶栏和连接日志里对同一个状态
      // 必须是同一句话，否则会出现「顶栏说重连中、日志说未连接」这种自相矛盾
      if (this.wsState === 'on') return '已连接 ' + this.pingMs + 'ms';
      if (this.wsState === 'wait') return '连接中...';
      return this.connStateText();
    },

    lbTypeText() {
      if (this.lbType === 'kills') return '按单局最高击杀';
      if (this.lbType === 'survive') return '按单局最长存活';
      return '按单局最高等级';
    },

    // 当前访问用的主机名端口，方便队友照着输
    pageHost() {
      return location.host;
    },

    timeOffsetText() {
      const v = Math.round(this.timeOffset);
      return (v >= 0 ? '+' : '') + v + 'ms';
    },

    // ---------------- 候场室（P2-3） ----------------

    // 候场室里「我」那一条成员记录。
    // 服务端逐人构造 room_update 时打了 self 标记，这里据此找出来，
    // 不去比对昵称（昵称可以重名，slot 才是身份）。
    myMember() {
      if (!this.room || !this.room.members) return null;
      for (let i = 0; i < this.room.members.length; i++) {
        if (this.room.members[i].self) return this.room.members[i];
      }
      return null;
    },

    isHost() {
      return !!(this.myMember && this.myMember.host);
    },

    myReady() {
      return !!(this.myMember && this.myMember.ready);
    },

    // 可选角色。游客只能用 guestAllowed 的那几个（目前只有猎魔人）；
    // 服务端也会再兜一道底，前端先拦是为了别让玩家白点一次。
    charOptions() {
      const all = constTable().CHARACTERS || [];
      if (!this.self.isGuest) return all;
      return all.filter(function (c) { return c.guestAllowed; });
    },

    // 可选头像列表与当前头像名（都来自双端共用的那份定义）
    avatarList() {
      const A = window.VS && window.VS.AVATARS;
      return A ? A.LIST : [];
    },
    avatarName() {
      const A = window.VS && window.VS.AVATARS;
      return A ? A.get(this.avatar).name : '';
    },

    // 可选难度（来自双端共用的数值表，不在这里另抄一份）
    diffList() {
      return constTable().DIFFICULTIES || [];
    },

    // 可选地图（来自双端共用的 shared/maps.js，同样不在这里另抄一份 ——
    // 抄一份的话，改了地图表忘了改这里，界面就会少一张图而且不报错）
    mapList() {
      const m = (typeof window !== 'undefined' && window.VS && window.VS.MAPS) || null;
      return (m && m.MAPS) || [];
    },

    // 单人当前选中的地图：没选过就用第一张（默认图）。
    // 单独做成 computed 而不是在模板里写 `prefMap || mapList[0].id` ——
    // 地图表万一没加载上时，模板里取下标会抛错 → 整页白屏（这类白屏看不出原因）。
    soloMapId() {
      if (this.prefMap) return this.prefMap;
      const list = this.mapList;
      return list.length ? list[0].id : '';
    },

    // 连接日志按钮上的角标：只统计问题（warn/err），正常事件不打扰
    connBadCount() {
      let n = 0;
      for (let i = 0; i < this.connLog.length; i++) {
        if (this.connLog[i].level === 'err' || this.connLog[i].level === 'warn') n += 1;
      }
      return n;
    },

    // 面板收起时按钮上显示的一句话状态，让人不用展开就知道大概
    connBadgeText() {
      if (this.connLogOpen) return '收起连接日志';
      if (this.connBadCount > 0) return '连接日志 · ' + this.connBadCount + ' 条异常';
      return '连接日志';
    }
  },

  // ==========================================================
  // 生命周期
  // ==========================================================
  created() {
    log('页面初始化 host=' + location.host);

    // 恢复上次的游客昵称，省得每次重填
    this.guestNickname = localStorage.getItem(GUEST_KEY) || '';

    // 恢复头像：**优先 sessionStorage**（本窗口自己的），其次才是 localStorage 里
    // 「上次选过什么」的偏好。localStorage 是所有标签页共享的，同机双开对测时
    // 直接读它会让两个窗口用同一个头像 —— 详见 shared/avatars.js 里 readSaved 的说明。
    this.avatar = (window.VS && window.VS.AVATARS)
      ? window.VS.AVATARS.readSaved()
      : (localStorage.getItem(AVATAR_KEY) || '');
    // 顺便把它钉进本窗口：之后哪怕别的窗口改了偏好，也不影响这个窗口
    if (this.avatar && window.VS && window.VS.AVATARS) {
      try { sessionStorage.setItem(AVATAR_KEY, this.avatar); } catch (e) { /* 隐私模式忽略 */ }
    }

    // 恢复上次选的难度（只作为建房初值；房间里的难度以服务端下发的为准）
    this.prefDiff = localStorage.getItem(DIFF_KEY) || 'normal';
    this.prefMap = localStorage.getItem(MAP_KEY) || '';

    // 扫码进来的（地址上带 ?room=XXXX）：提示一下，进入后会自动进这桌
    if (this.urlRoom) {
      this.notice$('info', '你正在加入房间 ' + this.urlRoom + '，进入后会自动进这桌');
      log('检测到邀请链接，房间号 ' + this.urlRoom);
    }

    // 看门狗一开始就起：它会自己等页面需要连的时候再动手（登录页不连）
    this.startWatchdog();

    // bfcache 恢复钩子（详见 public/js/nav.js 的说明）。
    //
    // 【为什么这里必须补一次连接】大厅 → 对局是整页跳转，浏览器离开时会把本页
    // 冻结存进 bfcache。玩家从对局「返回大厅」时走的是「从缓存复活」这条路：
    // Vue 数据、滚动位置全在，但**WebSocket 已被浏览器掐断**。
    // 冻结期间定时器不跑，所以看门狗最多要等 WATCHDOG_MS 才补上 ——
    // 玩家看到的是「回来了却显示未连接，过几秒又好了」。这里立刻补一次，空窗就没了。
    //
    // ★为什么不能无条件重连：普通首次加载也会走到这里，而 mounted 里已经连过了，
    //   再连一次就成了「同一个人在线两次」（服务端在线列表会出现两条一样的）。
    //   所以先查「现在到底需不需要」：登录页不需要；已经连着的不动。
    const NAV = window.VS && window.VS.NAV;
    if (NAV && NAV.onBfcacheRestore) {
      NAV.onBfcacheRestore(() => this.reviveFromBfcache());
    }

    // 调试句柄：?debug=1 时挂到 window 上。
    // 对局页早就有 VS_GAME 了（因为它的状态全在闭包里，外面读不到），大厅这边
    // 一直缺一个同款 —— 结果是「大厅断线会不会自己接回来」这件事只能靠人肉盯着看。
    // 有了它，自动化脚本可以读连接状态、也可以故意掐断来验证重连。
    if (/[?&]debug=1/.test(location.search)) {
      const self = this;
      window.VS_LOBBY = {
        get wsState() { return self.wsState; },
        get view() { return self.view; },
        get retry() { return self.wsRetry; },
        get roomCode() { return self.room ? self.room.code : ''; },
        get urlRoom() { return self.urlRoom; },
        // 身份读出来给自动化用：验证「刷新/清库之后还登着」必须能读到昵称与 userId，
        // 否则只能靠扒 DOM 文本，界面一改文案断言就假红。
        get nick() { return self.self.nickname; },
        get userId() { return self.self.userId; },
        get isGuest() { return self.self.isGuest; },
        get hasToken() { return !!self.token; },
        get shareOpen() { return self.shareOpen; },
        get shareUrl() { return self.shareUrl; },
        // 连接日志（新的在前）。测试脚本据此断言「界面真的把事件记下来了」，
        // 也是排查线上问题时唯一能拿到的完整时间线。
        get connLog() { return self.connLog.slice(); },
        get connLogOpen() { return self.connLogOpen; },
        // 故意掐断（等价于拔网线）：走的是和真实断线同一条重连路径
        drop: function () {
          self.closeWs();
          self.scheduleReconnect('调试句柄主动断开');
        },
        // 真·拔网线：**不摘 onclose**，所以走的是和服务端主动断开/网络掉线
        // 完全相同的路径（onclose → 记日志 → 排程重连）。
        // drop() 会先 closeWs() 把 onclose 摘掉，那条路径里的日志测不到 ——
        // 而要验证的恰恰是「真实断线有没有被记下来」，所以这里必须另开一个。
        hardDrop: function () {
          if (self.ws) {
            try { self.ws.close(); } catch (e) { /* 关不掉也没关系 */ }
          }
        }
      };
      log('调试句柄已挂载：window.VS_LOBBY');
    }

    // 恢复登录态：有 token 就直接按大厅流程走，token 失效由服务端在握手里告知
    const saved = localStorage.getItem(TOKEN_KEY) || '';
    if (saved) {
      this.token = saved;
      log('检测到本地 token，尝试自动登录');
      this.enterLobby({ isGuest: false, nickname: '' });
    } else {
      log('无本地 token，停留在登录页');
    }
  },

  // ==========================================================
  // 方法
  // ==========================================================
  methods: {

    // ---------------- 通用请求封装 ----------------
    // 统一带上登录凭证；错误走 callback，不用 try/catch 做流程控制
    // token 走「自定义头 + 查询参数」双通道：线上沙箱的平台网关会用平台自己的 JWT
    // 覆盖标准 Authorization 头（详见服务端 auth.extractToken 的注释），
    // 只发 Authorization 会导致所有需要登录的接口 401。
    // Authorization 仍然照发，本机直连与其它部署形态靠它，三通道并存不冲突。
    api(path, method, body, cb) {
      const opts = {
        method: method || 'GET',
        headers: {}
      };

      let url = path;
      if (this.token) {
        opts.headers['X-VS-Token'] = this.token;
        opts.headers['Authorization'] = 'Bearer ' + this.token;
        url = path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(this.token);
      }
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }

      fetch(url, opts).then(function (res) {
        return res.json().then(function (json) {
          cb(null, res.status, json);
        }, function () {
          cb(new Error('返回内容不是合法 JSON'), res.status, null);
        });
      }, function (err) {
        cb(err, 0, null);
      });
    },

    notice$(type, text) {
      this.notice.type = type;
      this.notice.text = text;
    },

    // ---------------- 连接日志 ----------------
    // 每一条都带上本地时刻：排查「到底什么时候断的、断了多久才接回来」全靠它。
    // 用 unshift（新的在前）而不是 push：出问题时人想看的是最后发生了什么。
    logConn(level, text) {
      const d = new Date();
      const pad = function (n) { return (n < 10 ? '0' : '') + n; };
      this.connSeq += 1;
      this.connLog.unshift({
        id: this.connSeq,
        at: pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()),
        level: level,
        text: text
      });
      if (this.connLog.length > CONN_LOG_MAX) this.connLog.length = CONN_LOG_MAX;
    },

    toggleConnLog() {
      this.connLogOpen = !this.connLogOpen;
      // 展开时如果还没连上，顺手记一条当前状态 —— 玩家点进来第一眼就能看到
      // 「现在到底是什么状态」，而不用往上翻历史
      if (this.connLogOpen && !this.connLog.length) {
        this.logConn('info', '暂无记录（连接一有动静就会记在这里）');
      }
    },

    clearConnLog() {
      this.connLog.length = 0;
    },

    // 把日志复制出来（贴给别人排查用）。剪贴板拿不到时退回显示在提示条里。
    copyConnLog() {
      const self = this;
      if (!this.connLog.length) return this.notice$('info', '连接日志是空的');
      const lines = this.connLog.slice().reverse().map(function (l) {
        return '[' + l.at + '] ' + l.text;
      });
      const text = lines.join('\n');
      const done = function () { self.notice$('ok', '连接日志已复制（共 ' + lines.length + ' 条）'); };
      const fail = function () {
        // 非安全上下文（http 局域网）下 navigator.clipboard 可能不存在
        self.notice$('info', '复制不可用（非 https 环境），连接日志已打印到控制台');
        console.log('[lobby] 连接日志\n' + text);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fail);
      } else {
        fail();
      }
    },

    clearNotice() {
      this.notice.text = '';
    },

    // ---------------- 登录 / 注册 ----------------
    switchAuthTab(tab) {
      this.authTab = tab;
      this.clearNotice();
    },

    doLogin() {
      const self = this;
      if (!this.loginForm.username || !this.loginForm.password) {
        return this.notice$('err', '请输入用户名和密码');
      }

      this.busy.login = true;
      log('提交登录 username=' + this.loginForm.username);

      this.api('/api/login', 'POST', {
        username: this.loginForm.username,
        password: this.loginForm.password
      }, function (err, status, json) {
        self.busy.login = false;

        if (err || !json) {
          log('登录请求失败', err);
          return self.notice$('err', '无法连接服务器，请确认服务是否在运行');
        }
        if (!json.ok) {
          log('登录被拒绝 code=' + json.code + ' status=' + status);
          return self.notice$('err', json.msg || '登录失败');
        }

        log('登录成功，写入 token 并进入大厅');
        self.token = json.token;
        localStorage.setItem(TOKEN_KEY, json.token);
        self.loginForm.password = '';
        self.notice$('ok', '欢迎回来，' + json.user.nickname);
        self.enterLobby({ isGuest: false, nickname: json.user.nickname });
      });
    },

    doRegister() {
      const self = this;
      const f = this.regForm;

      if (!f.username || !f.password) {
        return this.notice$('err', '请填写用户名和密码');
      }
      if (f.password !== f.password2) {
        return this.notice$('err', '两次输入的密码不一致');
      }

      this.busy.register = true;
      log('提交注册 username=' + f.username);

      this.api('/api/register', 'POST', {
        username: f.username,
        nickname: f.nickname,
        password: f.password
      }, function (err, status, json) {
        self.busy.register = false;

        if (err || !json) {
          log('注册请求失败', err);
          return self.notice$('err', '无法连接服务器，请确认服务是否在运行');
        }
        if (!json.ok) {
          log('注册被拒绝 code=' + json.code + ' status=' + status);
          return self.notice$('err', json.msg || '注册失败');
        }

        log('注册成功，写入 token 并进入大厅');
        self.token = json.token;
        localStorage.setItem(TOKEN_KEY, json.token);
        self.regForm.password = '';
        self.regForm.password2 = '';
        self.notice$('ok', '注册成功，开始你的第一局吧');
        self.enterLobby({ isGuest: false, nickname: json.user.nickname });
      });
    },

    // ---------------- 设置新密码（凭登录态，不需要旧密码） ----------------
    //
    // 【为什么需要这个入口】线上跑在「重新发布就把数据回滚」的沙箱里，账号会按浏览器里的
    // token 自动重建（见 server/api/auth.js 的自证式 token）。重建时库里的密码哈希是
    // 随机写的、谁都不知道 —— 没有这个入口，重建就等于把账号**锁死**（能玩但再也设不了密码）。
    // 所以：只要还登录着，就允许重设密码；旧密码不需要提供。
    openPwd() {
      this.pwdOpen = true;
      this.pwd1 = '';
      this.pwd2 = '';
    },

    cancelPwd() {
      this.pwdOpen = false;
      this.pwd1 = '';
      this.pwd2 = '';
    },

    savePassword() {
      const self = this;
      if (this.busy.pwd) return;

      if (!this.pwd1 || this.pwd1.length < 6) {
        return this.notice$('err', '新密码至少 6 位');
      }
      if (this.pwd1 !== this.pwd2) {
        return this.notice$('err', '两次输入的密码不一致');
      }

      this.busy.pwd = true;
      log('提交新密码');

      this.api('/api/password', 'POST', { password: this.pwd1 }, function (err, status, json) {
        self.busy.pwd = false;

        if (err || !json) {
          log('设置密码请求失败', err);
          return self.notice$('err', '无法连接服务器，请稍后再试');
        }
        if (!json.ok) {
          log('设置密码被拒 code=' + json.code + ' status=' + status + ' msg=' + json.msg);
          // token 失效：与 loadMe 同一套处理，清本地态回登录页
          if (json.code === 'BAD_TOKEN') {
            self.notice$('err', '登录状态已失效，请重新登录');
            self.token = '';
            localStorage.removeItem(TOKEN_KEY);
            self.closeWs();
            self.view = 'auth';
            return;
          }
          return self.notice$('err', json.msg || '设置失败');
        }

        self.pwd1 = '';
        self.pwd2 = '';
        self.pwdOpen = false;
        self.notice$('ok', json.msg || '新密码已生效');
      });
    },

    // 游客：昵称留空时自动给一个，避免卡住用户
    enterAsGuest() {
      let nick = (this.guestNickname || '').trim();
      if (!nick) {
        nick = '幸存者' + Math.floor(1000 + Math.random() * 9000);
        this.guestNickname = nick;
        log('游客昵称为空，自动生成 ' + nick);
      }

      localStorage.setItem(GUEST_KEY, nick);
      this.notice$('info', '游客模式：战绩不会保存，注册后可查看统计数据');
      log('以游客身份进入 nick=' + nick);
      this.enterLobby({ isGuest: true, nickname: nick });
    },

    // 进入大厅并建立 WebSocket
    enterLobby(info) {
      this.self.isGuest = !!info.isGuest;
      this.self.nickname = info.nickname || '';
      this.view = 'lobby';
      this.wsRetry = 0;

      this.saveProfile();
      this.connectWs();

      // 注册用户才拉取战绩与排行榜；游客没有数据可拉
      if (!info.isGuest) {
        this.loadMe();
        this.loadLeaderboard();
      }
    },

    // 把玩家档案写到本地：游戏页（/game.html）启动时读它来决定昵称与角色权限
    saveProfile() {
      const p = {
        nickname: this.self.nickname || this.guestNickname || '玩家',
        isGuest: !!this.self.isGuest,
        userId: this.self.userId || null
      };
      try {
        localStorage.setItem('vs_profile', JSON.stringify(p));
      } catch (e) {
        log('写入本地档案失败（隐私模式？）', e);
      }
      log('本地档案已更新', p);
    },

    doLogout() {
      const self = this;
      log('退出登录');

      // 先通知服务端销毁会话（失败也无所谓，本地清掉即可）
      this.api('/api/logout', 'POST', null, function () {
        self.clearLocalState();
      });
    },

    clearLocalState() {
      this.token = '';
      localStorage.removeItem(TOKEN_KEY);
      this.closeWs();
      this.view = 'auth';
      this.authTab = 'login';
      this.online = [];
      this.leaderboard = [];
      this.rooms = [];
      this.room = null;
      this.self = { connId: '', userId: null, nickname: '', isGuest: false };
      this.notice$('info', '已退出登录');
    },

    // ---------------- 数据拉取 ----------------
    loadMe() {
      const self = this;
      this.loading.me = true;

      this.api('/api/me', 'GET', null, function (err, status, json) {
        self.loading.me = false;

        if (err || !json) {
          log('拉取个人数据失败', err);
          return;
        }
        if (!json.ok) {
          log('拉取个人数据被拒绝 status=' + status + ' msg=' + json.msg);
          // token 失效：清掉本地登录态，回到登录页
          if (status === 401) {
            self.notice$('err', '登录状态已失效，请重新登录');
            self.token = '';
            localStorage.removeItem(TOKEN_KEY);
            self.closeWs();
            self.view = 'auth';
          }
          return;
        }

        const u = json.user;
        self.self.userId = u.id;
        self.self.nickname = u.nickname;
        if (json.stats) self.stats = json.stats;
        self.saveProfile();
        log('个人数据就绪 id=' + u.id + ' nickname=' + u.nickname);
      });
    },

    loadLeaderboard() {
      const self = this;
      this.loading.lb = true;
      log('拉取排行榜 type=' + this.lbType);

      this.api('/api/leaderboard?type=' + this.lbType + '&limit=20', 'GET', null, function (err, status, json) {
        self.loading.lb = false;

        if (err || !json) {
          log('拉取排行榜失败', err);
          return;
        }
        if (!json.ok) {
          log('拉取排行榜被拒绝 status=' + status);
          return;
        }
        self.leaderboard = json.list || [];
        log('排行榜就绪 ' + self.leaderboard.length + ' 条');
      });
    },

    switchLbType(type) {
      if (this.lbType === type) return;
      this.lbType = type;
      this.leaderboard = [];
      this.loadLeaderboard();
    },

    // ---------------- 头像 ----------------
    // 给 v-html 用的 svg 片段。内容全部来自 shared/avatars.js 的常量，不含任何用户输入。
    avatarSvg(id, size) {
      const A = window.VS && window.VS.AVATARS;
      return A ? A.svg(id, size) : '';
    },

    pickAvatar(id) {
      const A = window.VS && window.VS.AVATARS;
      if (!A || !A.isValid(id)) return;

      // 【落盘不能因为「和当前一样」就跳过】
      // 服务端握手时会按座位/在线人数摊一个默认头像，那个默认值可能恰好就是
      // 玩家想选的那个。以前的写法在这里 `id === this.avatar` 直接 return，
      // 于是「选中的那个」从来没写进本地 —— 等到跳进对局时手上一个值都没有，
      // 服务端只好再摊一次默认值，玩家会看到「我明明选了这个，游戏里却变了」。
      // 所以：永远落盘；只有真的换了才多发一次 set_avatar（省一次往返）。
      const changed = id !== this.avatar;
      this.avatar = id;
      // 两处都写：sessionStorage 钉住本窗口的身份（握手/跳对局都用它），
      // localStorage 留作「上次选过什么」的偏好。只写 localStorage 会让
      // 同机双开的另一个窗口跟着变（正是「两人图标一样」的根因）。
      if (A.readSaved && A.save) {
        A.save(id);
      } else {
        try { localStorage.setItem(AVATAR_KEY, id); } catch (e) {
          log('头像存本地失败（隐私模式？），本次仍然有效', e);
        }
      }
      if (!changed) return;

      // 告诉服务端：它会同时更新连接信息（大厅列表）、房间成员（候场室）
      // 和进行中这一局的名单（队友头顶名牌）。
      // 没连上就先只存本地，握手时再带过去，不会丢。
      if (!this.sendWs({ t: 'set_avatar', avatar: id })) {
        log('头像已记到本地，当前未连接，重连后会以本地记录为准');
      }
    },

    // ---------------- WebSocket ----------------
    connectWs() {
      const self = this;

      this.closeWs();
      this.wsState = 'wait';

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = proto + '//' + location.host + '/ws';
      log('建立 WebSocket: ' + url);
      this.logConn('info', '正在连接 ' + url + (this.wsRetry ? '（第 ' + this.wsRetry + ' 次重试）' : ''));

      let ws = null;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        // 少数浏览器在混合内容下会直接抛错
        log('WebSocket 创建失败', e);
        this.logConn('err', '无法建立连接：' + (e && e.message ? e.message : e));
        this.wsState = 'off';
        return this.notice$('err', '无法建立实时连接，请确认访问地址正确');
      }

      this.ws = ws;

      ws.onopen = function () {
        self.logConn('info', '连接已建立，发送 hello 握手');
        log('WebSocket 已连接，发送 hello 握手');

        // 游客带昵称，注册用户带 token
        const hello = { t: 'hello' };
        if (self.token) hello.token = self.token;
        else hello.nickname = self.self.nickname || self.guestNickname;
        // 带上记住的头像，服务端会沿用（它只认白名单里的 id，非法值会换成默认的）
        if (self.avatar) hello.avatar = self.avatar;

        ws.send(JSON.stringify(hello));
        // 【这里原来紧接着起心跳（startPingLoop）】账号用户的 hello 要异步查库，
        // 那条 ping 会赶在握手完成前被处理 → 服务端判 NOT_READY → 把连接踢掉。
        // 心跳改到 welcome 里再起（见 handleWsMessage），这里只负责握手本身。

        // 握手超时自检：TCP 连上不等于握手成功。服务端正在重启时可能连得上、
        // 却没人处理这条 hello，而半开连接不会触发 onclose —— 没有这道自检，
        // 界面会一直停在「未连接」且永不重试（用户实测踩到过）。
        self.clearHandshakeTimer();
        self.handshakeTimer = setTimeout(function () {
          if (self.wsState === 'on') return;
          log('握手超时：' + HANDSHAKE_TIMEOUT_MS + 'ms 内没收到 welcome，主动断开重连');
          self.logConn('warn', '握手超时（' + Math.round(HANDSHAKE_TIMEOUT_MS / 1000) + ' 秒没收到服务端应答），主动断开重连');
          self.clearHandshakeTimer();
          if (self.ws) {
            try { self.ws.close(); } catch (e) { /* 关不掉也没关系，心跳那道会兜住 */ }
          }
        }, HANDSHAKE_TIMEOUT_MS);
      };

      ws.onmessage = function (ev) {
        let msg = null;
        try {
          msg = JSON.parse(ev.data);
        } catch (e) {
          log('收到无法解析的消息', ev.data);
          return;
        }
        self.handleWsMessage(msg);
      };

      ws.onerror = function () {
        // onerror 不提供细节，真正的原因看 onclose 与网络面板
        log('WebSocket 出错');
        self.logConn('warn', '连接出错（浏览器不给原因，看下面那条关闭记录）');
      };

      ws.onclose = function (ev) {
        log('WebSocket 关闭 code=' + ev.code + ' reason=' + (ev.reason || '-'));
        // 日志级别看「要不要重连」而不是看 close code：
        // 主动 close() 拿到的也是 1000，但那明明是一次故障（要重连）；
        // 反过来在登录页断开是预期内的，不该标红。
        const willRetry = self.view !== 'auth';
        self.logConn(willRetry ? 'warn' : 'info',
          '连接已关闭 · code=' + ev.code + (ev.reason ? ' · ' + ev.reason : '') +
          (willRetry ? '（即将自动重连）' : ''));
        self.stopPingLoop();
        self.ws = null;

        // 只有「已经在登录页」才不重连 —— 那个状态下本来就不需要连接。
        // 【这里以前是 `view !== 'lobby'`】于是人在候场室（view === 'room'）时
        // 一旦断线就彻底不重连，界面永远停在「未连接」，只能刷新页面。
        // 候场室恰恰是最不能掉线的地方（队友在等你点准备）。
        if (self.view === 'auth') {
          self.wsState = 'off';
          return;
        }

        self.scheduleReconnect('连接已关闭');
      };
    },

    // 把「等一会儿重连」收成一个入口：退避、去重、状态显示都在这里。
    // 【为什么要去重】onclose 与两道超时自检都会调它，不去重就会排出好几条
    // 重连链，退避次数被算两遍，重连节奏直接乱掉。
    scheduleReconnect(why) {
      const self = this;
      if (this.reconnectTimer) return;
      if (this.view === 'auth') return;

      this.wsState = 'retry';           // 界面显示「正在自动重连」，不是含糊的「未连接」
      this.clearHandshakeTimer();
      this.wsRetry += 1;
      const delay = Math.min(1000 * Math.pow(2, this.wsRetry - 1), 10000);
      log('断开（' + why + '），' + delay + 'ms 后重连（第 ' + this.wsRetry + ' 次）');
      this.logConn('warn', '将在 ' + (delay / 1000).toFixed(0) + ' 秒后重连（第 ' + this.wsRetry + ' 次）');

      this.reconnectTimer = setTimeout(function () {
        self.reconnectTimer = null;
        if (self.view === 'auth') return;
        self.connectWs();
      }, delay);
    },

    // 连接看门狗：最后一道兜底。
    // 【它兜的是什么】握手超时和心跳超时覆盖的是「连上了但已经死了」；
    // 而看门狗覆盖的是「该连却压根没连上，而且没有任何事件会来通知我们」——
    // 比如重连定时器被前一次 closeWs 顺手清掉、页面从 bfcache 恢复等等。
    // 判据只看「最终状态」：需要连接、却既没有活着的 socket、也没有在排程重连。
    startWatchdog() {
      const self = this;
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);

      this.watchdogTimer = setInterval(function () {
        if (self.view === 'auth') return;       // 登录页不需要连接
        if (self.wsState === 'on' && self.ws) return;
        // 手上这条连接还活着（正在连接或已打开）就再等等，别去打断它
        if (self.ws && (self.ws.readyState === 0 || self.ws.readyState === 1)) return;
        if (self.reconnectTimer) return;        // 已经排好重连了
        log('看门狗：检测到该连却没连着，补一次连接');
        self.logConn('warn', '看门狗：检测到该连却没连着，补一次连接');
        self.connectWs();
      }, WATCHDOG_MS);
    },

    closeWs() {
      this.stopPingLoop();
      this.clearHandshakeTimer();
      // 主动建新连接前，把还没到点的重连排程取消掉 —— 否则等它到点会再建一条，
      // 两条连接同时开着，服务端那边就成了「同一个人在线两次」。
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      if (this.ws) {
        // 先摘掉回调，避免主动关闭又触发重连
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.onopen = null;
        if (this.ws.readyState === 0 || this.ws.readyState === 1) this.ws.close();
        this.ws = null;
      }
      this.wsState = 'off';
    },

    // 从 bfcache 回来（或从后台切回前台）时把连接补上。
    //
    // ★三个「不动」的条件缺一不可：
    //   1) 登录页 —— 本来就不需要连，连了也只是白占一个在线名额；
    //   2) 连接还活着 —— 无条件重连会造出第二条连接（在线列表出现两个自己）；
    //   3) 已经在排程重连 —— 再排一条会排出两条重连链，退避次数被算两遍。
    // 剩下唯一要处理的是「连接已经死了但没人排程」：看门狗兜底，但等一个周期。
    // 这里直接补一次，把「回来了却显示未连接」的那几秒抹掉。
    reviveFromBfcache() {
      if (this.view === 'auth') return;                     // 条件 1
      if (this.wsState === 'on' && this.ws) return;         // 条件 2
      if (this.reconnectTimer) return;                      // 条件 3
      // 手上这条连接还在 CONNECTING（0）或 OPEN（1）：别去打断它，等它自己走完
      if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) return;

      log('页面恢复可见但连接已断，主动补连');
      this.logConn('warn', '页面从后台恢复，实时连接已断，正在重连…');
      // 走 connectWs 而不是 scheduleReconnect：这里是「已知断了」而不是
      // 「刚失败」，等退避是白等用户一秒。
      this.wsRetry = 0;   // 归零：重新算退避，别背着一长串失败次数慢慢爬
      this.connectWs();
    },

    // 发一条上行消息。
    // 【为什么要求 wsState === 'on' 而不只是 readyState === 1】
    // TCP 连上 ≠ 握手完成。账号用户的 hello 要异步查库，这中间的几十毫秒里
    // 如果玩家点了「创建房间」之类，消息会赶在握手前到达服务端 —— 以前那会被
    // 判成「未握手就发消息」并**踢掉连接**。现在服务端已经不这么干了（改成了
    // 静默忽略），但前端也不该发这种注定被丢的消息：直接不发、并记进连接日志，
    // 玩家点不动时至少能从日志里看到原因。
    sendWs(obj) {
      if (this.ws && this.ws.readyState === 1 && this.wsState === 'on') {
        this.ws.send(JSON.stringify(obj));
        return true;
      }
      log('发送失败：连接未就绪', obj.t);
      // ping 每 5 秒一条，记进日志会把面板刷满，所以它不记
      if (obj.t !== 'ping') {
        this.logConn('warn', '「' + obj.t + '」没能发出：连接还没就绪（' + this.connStateText() + '）');
      }
      return false;
    },

    // 连接状态的文字描述，日志与界面共用一份措辞
    connStateText() {
      if (this.wsState === 'on') return '已连接';
      if (this.wsState === 'retry') return '正在自动重连（第 ' + this.wsRetry + ' 次）';
      if (this.wsState === 'wait') return '连接中';
      return '未连接';
    },

    handleWsMessage(msg) {
      // 握手成功：以服务端返回为准，避免前端自说自话
      if (msg.t === 'welcome') {
        this.wsState = 'on';
        this.wsRetry = 0;
        this.clearHandshakeTimer();      // 握手成功，撤掉超时自检
        this.lastPongAt = Date.now();    // 给心跳检测一个干净的起点

        // 【心跳必须从这一刻才开始】原来是在 onopen 里立刻起——那时 hello 可能
        // 还没被服务端处理完（账号用户要异步查库校验 token），而服务端会把
        // 「握手前来的非 hello 消息」判为违规并断连。实测线上账号用户 12 次里
        // 被踢 9 次。握手前的存活检测交给上面的 8 秒握手超时，不需要心跳。
        this.startPingLoop();

        // 握手成功 = 之前那些连接类错误（断连、握手失败）已经不成立了。
        // 不清的话界面会同时显示「已连接」和一条红色的旧错误，看着像还在坏。
        // 只清 err，不动 info（比如「你正在加入房间 X」那种提示还有用）。
        if (this.notice.type === 'err') this.clearNotice();
        this.logConn('ok', '握手完成 · connId=' + msg.self.connId + ' · 在线 ' + (msg.online || []).length + ' 人');

        // 头像以服务端回的为准（它做过白名单校验，可能替我换了默认值），并存到本地。
        // 同样两处都写：本窗口的身份 + 跨会话的偏好。
        if (msg.self.avatar) {
          this.avatar = msg.self.avatar;
          const AV = window.VS && window.VS.AVATARS;
          if (AV && AV.save) AV.save(this.avatar);
          else {
            try { localStorage.setItem(AVATAR_KEY, this.avatar); } catch (e) {
              log('头像存本地失败（隐私模式？）', e);
            }
          }
        }
        this.self.connId = msg.self.connId;
        this.self.userId = msg.self.userId;
        this.self.nickname = msg.self.nickname;
        this.self.isGuest = msg.self.isGuest;
        this.online = msg.online || [];
        if (msg.tickRate) this.tickRate = msg.tickRate;
        this.syncServerTime(msg.serverTime);
        // 服务端返回的身份最权威，落一次本地档案给游戏页用
        this.saveProfile();
        log('握手完成 connId=' + msg.self.connId + ' 在线=' + this.online.length);

        // 扫码进来的（地址带 ?room=XXXX）：握手一完成就直接进这桌，
        // 不用他再在大厅列表里找一遍 —— 这正是二维码存在的意义。
        // 放在最前面：这是「本次进站的目的」，优先级高于其它自动行为。
        if (this.urlRoom) {
          const want = this.urlRoom;
          this.urlRoom = '';
          // 顺手把 ?room= 从地址栏摘掉：否则之后每次刷新都会重新进这桌，
          // 玩家自己点了「离开房间」再刷新，就会被莫名其妙地拽回去。
          // 【debug=1 要留着】onGameStart 跳游戏页时会看 location.search 里有没有它，
          // 一把抹干净的话，联调时游戏页的调试句柄就没了（踩过）。
          if (window.history && window.history.replaceState) {
            const keepDbg = /[?&]debug=1/.test(location.search) ? '?debug=1' : '';
            window.history.replaceState(null, '', location.pathname + keepDbg);
          }
          log('邀请链接：自动加入房间 ' + want);
          this.roomBusy = true;
          this.sendWs({ t: 'room_join', code: want, charId: this.charId });
          return;
        }

        // 断线重连回来后要自动回原来的房间：服务端那边我们已经被摘掉了，
        // 不主动重进的话，队友会看到一个「掉线」的幽灵成员，自己也卡在候场室。
        if (this.room && this.room.code) {
          log('重连成功，重新加入房间 ' + this.room.code);
          this.sendWs({ t: 'room_join', code: this.room.code, charId: this.charId });
        } else {
          // 从对局结算页点「回到房间」过来的：房间号存在 sessionStorage 里
          //（页面跳转会把内存里的 roomCode 丢掉），这里自动重进 ——
          // 既省得玩家自己去房间列表里再找一遍，也让他能直接看到房主再开一局
          let rejoin = '';
          try { rejoin = sessionStorage.getItem('vs_rejoin') || ''; } catch (e) { rejoin = ''; }
          if (rejoin) {
            try { sessionStorage.removeItem('vs_rejoin'); } catch (e) { /* 清不掉也无妨 */ }
            log('从对局回来，自动重进房间 ' + rejoin);
            this.sendWs({ t: 'room_join', code: rejoin, charId: this.charId });
            return;
          }
          // 刚进大厅：主动拉一次房间列表，别让玩家看到一个空列表
          this.sendWs({ t: 'room_list' });
        }
        return;
      }

      if (msg.t === 'online') {
        this.online = msg.list || [];
        log('在线列表更新，共 ' + this.online.length + ' 人');
        return;
      }

      // ---------------- 房间 / 候场室（P2-3） ----------------
      if (msg.t === 'room_list') {
        this.onRoomList(msg.list);
        return;
      }

      if (msg.t === 'room_update') {
        this.onRoomUpdate(msg.room);
        return;
      }

      // 服务端对 room_leave 的明确确认：收到它才切回大厅，
      // 不用「收到 room_list 了那大概是退成功了吧」这种猜法
      if (msg.t === 'room_left') {
        this.onRoomGone('已离开房间');
        return;
      }

      // 开局。服务端逐人下发的，里面的 selfSlot 对我一个人有效
      if (msg.t === 'game_start') {
        this.onGameStart(msg);
        return;
      }

      // 主动退出对局成功
      if (msg.t === 'game_left') {
        this.onRoomGone('已退出对局，回到大厅');
        return;
      }

      if (msg.t === 'pong') {
        this.lastPongAt = Date.now();    // 心跳存活：连接确实还活着
        if (msg.ts) this.pingMs = Math.max(0, Date.now() - msg.ts);
        this.syncServerTime(msg.serverTime);
        return;
      }

      if (msg.t === 'error') {
        log('服务端返回错误 code=' + msg.code + ' msg=' + msg.msg + ' fatal=' + !!msg.fatal);
        this.logConn(msg.fatal ? 'err' : 'warn',
          '服务端错误：' + (msg.msg || msg.code) + '（' + msg.code + '）');
        this.notice$('err', msg.msg || '连接出错');

        // 房间相关的错误：把玩家从卡住的候场室里放出来，回大厅重新来。
        // 典型场景：房主把房间解散了，而你还停在候场室界面上。
        if (this.view === 'room' && (msg.code === 'ROOM_NOT_FOUND' || msg.code === 'NOT_IN_ROOM')) {
          this.room = null;
          this.view = 'lobby';
          this.loadRoomList();
          return;
        }

        // 致命错误：token 失效最常见，清本地态回登录页
        if (msg.code === 'BAD_TOKEN') {
          this.token = '';
          localStorage.removeItem(TOKEN_KEY);
          this.closeWs();
          this.view = 'auth';
          return;
        }
        if (msg.fatal) this.closeWs();
        return;
      }

      log('收到未知类型消息', msg);
    },

    // 延迟探测：顺手校正与服务器的时钟差（用于后续对局倒计时）
    startPingLoop() {
      const self = this;
      this.stopPingLoop();
      this.lastPongAt = Date.now();
      this.sendWs({ t: 'ping', ts: Date.now() });

      this.pingTimer = setInterval(function () {
        self.sendWs({ t: 'ping', ts: Date.now() });

        // 心跳兜底：服务端进程消失时连接可能进入「半开」状态 —— 消息发得出去、
        // 回不来，也不触发 onclose，只靠 onclose 重连就会永远卡住。
        // 所以连续一个心跳周期没收到 pong 就判定连接已死，主动断开触发重连。
        if (self.wsState === 'on' && Date.now() - self.lastPongAt > PING_TIMEOUT_MS) {
          log('心跳超时：' + PING_TIMEOUT_MS + 'ms 没收到 pong，判定连接已死，主动断开重连');
          self.logConn('warn', '心跳超时（' + Math.round(PING_TIMEOUT_MS / 1000) + ' 秒没收到回应），主动断开重连');
          if (self.ws) {
            try { self.ws.close(); } catch (e) { /* 关不掉就交给 onclose 兜底 */ }
          }
        }
      }, 5000);
    },

    stopPingLoop() {
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
    },

    clearHandshakeTimer() {
      if (this.handshakeTimer) {
        clearTimeout(this.handshakeTimer);
        this.handshakeTimer = null;
      }
    },

    syncServerTime(serverTime) {
      if (!serverTime) return;
      // 忽略单程 RTT 的一半，P0 精度足够
      this.timeOffset = serverTime - (Date.now() - this.pingMs / 2);
    },

    // ---------------- 剧情模式（第十五轮）-----------------
    // 打开关卡选择弹层。
    // 【为什么默认模组要这么选】优先选「已有进度的模组」——玩家上次打到第三关，
    // 再打开时应该直接看到那个进度，而不是回到第一个模组。
    openStory() {
      const CP = window.VS.CAMPAIGN;
      const ST = window.VS.STORY;
      const mods = this.storyMods;
      if (!mods.length) {
        log('没有可用的剧情模组');
        return;
      }
      // 找一个有进度的；都没有就用第一个
      let pick = mods[0].id;
      for (let i = 0; i < mods.length; i++) {
        if (ST.clearedCount(mods[i].id, CP) > 0) { pick = mods[i].id; break; }
      }
      this.storyModId = pick;
      this.storyOpen = true;
      log('打开剧情模式：模组=' + pick + '，已通关 ' + ST.clearedCount(pick, CP) + ' 关');
    },

    closeStory() {
      this.storyOpen = false;
    },

    switchStoryMod(id) {
      this.storyModId = id;
      log('切换剧情模组 → ' + id);
    },

    // 进入某一关：跳转到游戏页并带上模组与关卡。
    // 【为什么要清 sessionStorage 的 vs_match】与 startGame 同一个理由：
    // 上一局联机留下的残留会让游戏页误判成联机模式 ——
    // 那样 modId 会被强制成 vanilla（剧情模式直接失效），而且玩家不会知道为什么。
    // （键名必须与 game.js 读的一致：vs_match）
    enterStoryStage(st) {
      if (!st || !st.unlocked) {
        log('这一关还没解锁');
        return;
      }
      this.saveProfile();
      try { sessionStorage.removeItem('vs_match'); } catch (e) { /* 隐私模式，忽略 */ }
      log('进入剧情关卡 ' + st.id + '「' + st.name + '」');
      // 走 nav.enterGame：地址用干净的 /game?…，并记下来路，
      // 这样对局页「返回大厅」能用 history.back() 而不是新压一条历史。
      window.VS.NAV.enterGame({ mod: this.storyModId, stage: st.id, debug: dbgFlag() });
    },

    // ---------------- 单机 ----------------
    // 单人游戏：直接进游戏页，跑本地 sim。角色选择、升级三选一都在游戏页里完成。
    startGame() {
      if (this.wsState !== 'on') {
        // 连接没就绪也能玩（单机逻辑全在本地），但提示一下更清楚
        log('WebSocket 尚未连上，仍进入游戏页（单机不需要服务端参与模拟）');
      }
      this.saveProfile();
      // 清掉上一局联机留下的残留，免得游戏页误判成联机模式。
      // 【键名必须与 game.js 读的一致：vs_match】这里原来写的是 vm_match（笔误），
      // 于是这句删除从来没生效过 —— 表现是「刚打完一局联机、回大厅再点单人游戏，
      // 结果又被送进那个已经结束的房间」。测试脚本 difftest/netcheck 都盯不到它，
      // 因为要「先联机、再点单机」才会露出来。
      try { sessionStorage.removeItem('vs_match'); } catch (e) { /* 隐私模式下会抛，忽略 */ }
      // 带上选中的地图：以前这里是硬编码的 /game.html，等于永远用默认图。
      // ★地图 id 走 URL 参数（游戏页的 ?map= 是既有的读取口），不另外走 localStorage ——
      //   同一台机器开两个标签页玩不同地图时不会互相覆盖。
      // prefMap 为空时 nav.gameUrl 会自动省掉这个参数，不用在这里拼 if。
      log('跳转单机游戏页（地图 ' + (this.prefMap || '默认') + '）');
      window.VS.NAV.enterGame({ map: this.prefMap, debug: dbgFlag() });
    },

    // ---------------- 房间 / 候场室（P2-3） ----------------

    // 手动刷新大厅房间列表（服务端在房间有变动时会主动广播，这个是兜底）
    loadRoomList() {
      this.sendWs({ t: 'room_list' });
    },

    createRoom() {
      if (this.wsState !== 'on') return this.notice$('err', '还没连上服务器，请稍候再试');
      this.roomBusy = true;
      log('请求建房，角色=' + this.charId + ' 难度=' + this.prefDiff + ' 地图=' + this.prefMap);
      this.sendWs({
        t: 'room_create', charId: this.charId,
        difficulty: this.prefDiff, mapId: this.prefMap
      });
    },

    joinRoom(code) {
      if (this.wsState !== 'on') return this.notice$('err', '还没连上服务器，请稍候再试');
      this.roomBusy = true;
      log('请求加入房间 code=' + code);
      this.sendWs({ t: 'room_join', code: code, charId: this.charId });
    },

    leaveRoom() {
      log('请求离开房间');
      this.sendWs({ t: 'room_leave' });
    },

    // 观战：不进房间，直接跳游戏页。
    //
    // 【为什么不在大厅做完再跳】观战者不需要选角色、也不需要准备 ——
    // 那些都是「参战者」的事。所以这里不 room_join，直接 spectate，
    // 服务端把他挂进这一局的观众名单，然后跳到 game.html。
    //
    // 身份靠 sessionStorage 传递（和联机一样的机制）：
    // **不能用 localStorage** —— 同机双开两个标签页会互相覆盖，
    // 一个人点观战、另一个页面的联机身份就被改成观战了。
    spectateRoom(code) {
      if (this.wsState !== 'on') return this.notice$('err', '还没连上服务器，请稍候再试');
      const c = String(code || '').trim().toUpperCase();
      if (!c) return this.notice$('err', '房间号为空');
      this.saveProfile();
      // 视口尺寸：服务端按它裁剪快照。小窗口发小包，别白收一堆画不出来的实体。
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 720;
      try {
        sessionStorage.setItem('vs_spec', JSON.stringify({ roomCode: c, viewW: vw, viewH: vh }));
      } catch (e) {
        this.notice$('err', '观战失败：浏览器存储不可用');
        return;
      }
      log('请求观战 code=' + c + ' 视口=' + vw + 'x' + vh);
      this.notice$('info', '正在进入观战…');
      // 【为什么要带上 debug=1 的转发】游戏页的调试句柄（window.VS_GAME）
      // 只在 URL 带 debug=1 时才挂 —— 而自动化脚本靠它读观战状态。
      // 大厅自己带 ?debug=1 的情况下把这个开关透传过去；
      // 正常玩家进来时大厅 URL 没有它，观战链接也就保持干净。
      window.VS.NAV.enterGame({ spec: c, debug: dbgFlag() });
    },

    // 准备 / 取消准备。房主不显示这个按钮 —— 他天然算准备好（见 manager.setReady）
    toggleReady() {
      const next = !this.myReady;
      log('切换准备状态 ready=' + next);
      this.sendWs({ t: 'room_ready', ready: next });
    },

    // 换角色。本地先切一下让界面立刻响应，服务端确认后会通过 room_update 纠正
    //（游客选了未解锁角色时，服务端会把他降级成猎魔人）
    pickChar(id) {
      if (this.charId === id) return;
      this.charId = id;
      log('换角色 charId=' + id);
      this.sendWs({ t: 'room_char', charId: id });
    },

    startMatch() {
      log('房主请求开始对局');
      this.sendWs({ t: 'game_start' });
    },

    // ---------------- 房间消息处理 ----------------

    onRoomList(list) {
      this.rooms = list || [];
      log('房间列表更新，共 ' + this.rooms.length + ' 桌');
    },

    // 服务端推来的房间状态（逐人构造，带 self 标记）
    onRoomUpdate(room) {
      if (!room) return;
      const entering = !this.room;
      this.room = room;
      this.roomBusy = false;

      // 收到房间状态就说明自己在房里，从大厅切到候场室
      if (this.view !== 'room') {
        this.view = 'room';
        log('进入候场室 code=' + room.code + ' 人数=' + room.members.length);
      }

      // 以服务端为准同步我选的角色（他那边会做游客降级）
      const me = this.myMember;
      if (me && me.charId !== this.charId) {
        log('服务端把我的角色定为 ' + me.charId);
        this.charId = me.charId;
      }

      if (entering) {
        // 「重连接回原席位」与「第一次进房」要分开说。
        // 玩家刷新页面回来时房间号、座位、角色、房主身份全都还在 ——
        // 不说的话他会以为房间被人重置了，白担心一场。
        const meResumed = this.myMember && this.myMember.resumed;
        if (meResumed) {
          this.notice$('ok', '已回到房间 ' + room.code + '（座位、角色与准备状态都还在）');
        } else {
          this.notice$('ok', '已进入房间 ' + room.code + '，把房间号念给队友吧');
        }
      }
    },

    // 离开房间 / 退出对局后回大厅
    onRoomGone(text) {
      if (this.room) log('退出房间 ' + this.room.code + '，回大厅');
      this.room = null;
      this.view = 'lobby';
      this.roomBusy = false;
      if (text) this.notice$('info', text);
      this.loadRoomList();
    },

    // 开局：把这一局的底细交给游戏页，然后跳过去。
    // 注意服务端这时也收到了我们的连接断开 —— 它不会收局，只会把世界挂起等我们回来
    //（挂起机制见 server/game/match.js 的 suspend/resume）。
    onGameStart(msg) {
      log('对局开始 code=' + msg.code + ' 我的座位=' + msg.selfSlot +
        ' 参战=' + (msg.players ? msg.players.length : 0) + ' 人' +
        (msg.midJoin ? '（中途加入）' : ''));

      const info = {
        code: msg.code,
        selfSlot: msg.selfSlot,
        seed: msg.seed,
        tickRate: msg.tickRate || 20,
        viewRadius: msg.viewRadius || 0,
        snapshotHz: msg.snapshotHz || 20,
        midJoin: !!msg.midJoin,
        players: msg.players || [],
        // 带上我在候场室选的角色：游戏页重连回对局时要报同一个角色，
        // 不带的话服务端会按默认值（猎魔人）把我覆盖掉。
        charId: this.charId,
        nickname: this.self.nickname,
        isGuest: !!this.self.isGuest
      };

      // 用 sessionStorage 而不是 localStorage：这是「这一次对局」的临时信息，
      // 关掉标签页就该消失；同浏览器开两个窗口各玩各的也不会互相覆盖。
      try {
        sessionStorage.setItem('vs_match', JSON.stringify(info));
      } catch (e) {
        log('写入对局信息失败（隐私模式？）', e);
      }

      // 跳转前主动断开：浏览器卸载页面时也会断，但主动断能让服务端更早
      // 进入挂起计时，新页面回来时更稳。
      //
      // ★关于「返回时大厅页会从 bfcache 复活、连接已被掐断」：
      //   这正是 mounted 里挂 reviveFromBfcache 的原因 ——
      //   它会在恢复后立刻补一次连接，玩家不会看到「回来了却未连接」。
      this.closeWs();
      // 把调试参数带过去：联调时游戏页也要能开调试浮层（?debug=1）
      window.VS.NAV.enterGame({ room: msg.code, debug: dbgFlag() });
    },

    // ---------------- 邀请队友（扫码进房） ----------------
    // 出二维码而不是让人念 IP + 房间号：手机上敲一长串地址基本敲不对。
    // 二维码里编码的是 http://host/?room=XXXX，对方扫完落在登录页并自动进这桌。
    openShare() {
      const SHARE = window.VS && window.VS.SHARE;
      const code = this.room ? this.room.code : '';
      if (!code) return this.notice$('err', '还没有房间号，先进一个房间');

      this.shareCode = code;
      this.shareUrl = SHARE ? SHARE.inviteUrl(code) : (location.origin + '/?room=' + code);
      this.shareQrFail = false;
      this.shareOpen = true;

      const self = this;
      // 弹层是 v-if 控制的，canvas 要等下一帧才在 DOM 里
      this.$nextTick(function () {
        const cv = document.getElementById('share-qr');
        if (!cv) return;
        const ok = SHARE ? SHARE.drawQr(cv, self.shareUrl, 216) : false;
        self.shareQrFail = !ok;
        if (!ok) log('二维码画不出来（vendor/qrcode.js 没加载上？），退化成显示链接');
      });
    },

    closeShare() {
      this.shareOpen = false;
    },

    copyShareLink() {
      const text = '山海神话传联机：房间号 ' + this.shareCode + '，地址 ' + this.shareUrl;
      const self = this;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          self.notice$('ok', '邀请信息已复制');
        }, function () {
          self.notice$('info', text);
        });
        return;
      }
      this.notice$('info', text);
    },

    // 复制邀请信息。局域网多是 http，部分浏览器在非安全上下文下拿不到剪贴板 API，
    // 所以拿不到时直接把内容显示在提示条里让人手动复制。
    copyInvite() {
      const code = this.room ? this.room.code : '';
      // 用带房间号的链接：对方点开就直接进桌，不用再报一遍房间号
      const SHARE = window.VS && window.VS.SHARE;
      const link = SHARE ? SHARE.inviteUrl(code) : ('http://' + location.host);
      const text = '山海神话传联机：房间号 ' + code + '，打开 ' + link + ' 直接进桌';
      const self = this;

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          self.notice$('ok', '邀请信息已复制：' + text);
        }, function () {
          self.notice$('info', text);
        });
        return;
      }
      this.notice$('info', text);
    },

    // 角色 id -> 中文名（成员列表显示用）
    charName(id) {
      const map = constTable().CHAR_MAP || {};
      const def = map[id];
      return def ? def.name : (id || '-');
    },

    // 难度名（房间列表与候场室都用它）。认不出来就显示「普通」——
    // 老服务端不带这个字段时，界面不该出现空白或 undefined。
    diffName(id) {
      const map = constTable().DIFF_MAP || {};
      const def = map[id];
      return def ? def.name : '普通';
    },

    // 房主改难度。乐观更新留给服务端的 room_update 回包来做 ——
    // 本地先改的话，服务端拒绝（比如已经开局）时界面就会停在错误的档位上。
    pickDiff(id) {
      if (!this.isHost) return;
      if (this.room && this.room.state !== 'waiting') return;
      // 记为偏好（下次建房直接用它）。只认表里存在的 id，脏值不落盘。
      const map = constTable().DIFF_MAP || {};
      if (map[id]) {
        this.prefDiff = id;
        localStorage.setItem(DIFF_KEY, id);
      }
      this.sendWs({ t: 'room_diff', difficulty: id });
    },

    // 房主换地图。与 pickDiff 完全同构：同样的三道前置检查、同样的偏好落盘、
    // 同样的「只认表里存在的 id」。非法 id 照发不误 —— 服务端会回落到默认图，
    // 前端不提前拦，是为了让玩家改完立刻在 room_update 里看到权威结果。
    // 单人地图：只记偏好，**不发 WS**。
    // ★不能直接复用 pickMap() —— 那个里有 sendWs({ t: 'room_map' })，
    //   而单人根本没连房间：这条消息要么被服务端忽略，要么误改到某个残留房间的地图。
    //   「单人点一下就把联机房间的图改了」是最难查的那类 bug。
    pickSoloMap(id) {
      this.prefMap = id;
      try {
        localStorage.setItem(MAP_KEY, id);
      } catch (e) { /* 隐私模式下写不了，忽略 */ }
    },

    pickMap(id) {
      if (!this.isHost) return;
      if (this.room && this.room.state !== 'waiting') return;
      // 记为偏好（下次建房直接用它）。只认表里存在的 id，脏值不落盘。
      const list = this.mapList;
      if (list.some(function (m) { return m.id === id; })) {
        this.prefMap = id;
        localStorage.setItem(MAP_KEY, id);
      }
      this.sendWs({ t: 'room_map', mapId: id });
    },

    // ---------------- 展示工具 ----------------
    // 秒数转人话：45秒 / 3分20秒 / 1时05分
    formatSec(sec) {
      const n = Math.max(0, Math.floor(Number(sec) || 0));
      if (n < 60) return n + '秒';
      if (n < 3600) {
        const m = Math.floor(n / 60);
        const s = n % 60;
        return m + '分' + (s < 10 ? '0' + s : s) + '秒';
      }
      const h = Math.floor(n / 3600);
      const m = Math.floor((n % 3600) / 60);
      return h + '时' + (m < 10 ? '0' + m : m) + '分';
    }
  }
}).mount('#app');

log('Vue 应用已挂载');
