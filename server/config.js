// server/config.js —— 集中读取环境变量并导出配置对象
//
// 双模运行的关键：只靠环境变量区分「本地局域网」与「云端容器」两种形态，
// 业务代码里不出现任何 if (isCloud) 这类分支。

const path = require('node:path');

// 是否使用本地 pglite 驱动：默认本地模式，云端部署时注入 DB_DRIVER=pg 切换
const useLocalDb = process.env.DB_DRIVER !== 'pg';

const config = {
  // ---------- 监听配置 ----------
  // 必须绑 0.0.0.0，否则局域网其它设备与容器外部都访问不到
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',

  // ---------- 数据层 ----------
  useLocalDb,                                   // true=本地 pglite，false=云端 PostgreSQL
  databaseUrl: process.env.DATABASE_URL || '',  // 仅云端模式使用
  pgDataDir: path.resolve(process.env.PGDATA_DIR || './data/pgdata'),
  pgPoolMax: Number(process.env.PG_POOL_MAX || 8),

  // ---------- 会话 ----------
  // ★★会话 token 的签名密钥**必须跨重启、跨重新发布恒定**，否则每次部署全员掉线。
  //
  // 【为什么不能随机兜底】这里原来是 `|| crypto.randomBytes(32)`：进程一重启就换密钥。
  //   对「会话只活在内存里」的部署够用，但本项目线上跑在「发布为应用」沙箱里，而沙箱
  //   **数据不持久**（数据库落在容器内文件，重新部署会回滚到上传时快照）——
  //   于是「会话存在数据库里」这条路注定每次发布被清空，用户看到的就是「老是自动退出」。
  //   所以会话改成了**脱离数据库自证**（token 自带身份 + HMAC 签名，见 server/api/auth.js），
  //   而自证的密钥一旦随机，重启就等于把人全踢下线 —— 正是要修的那个病。
  //   这里给一个**写死在仓库里的兜底值**，让登录态在无持久化环境下也能活下来。
  //
  // 【安全权衡（如实记）】密钥随源码存在 → 拿到源码的人可以伪造任意用户的 token。
  //   本项目是自建账号的朋友局 / 局域网，源码原不对外，这个代价换「不再莫名掉线」是划算的。
  //
  // ★★第二十一轮：项目改成**公开仓库**了，上面那条权衡的前提不成立了 ——
  //   写死的密钥进了公开仓库 = 全世界都能伪造任意账号的登录态
  //   （而自证 token 服务端**无法吊销**，见 auth.js 的说明，所以只能靠密钥保密）。
  //   因此默认值换成一个**明显没配好**的占位串，并在启动时大声警告（见 index.js）。
  //   ★刻意**不用随机兜底**：随机仍然会在每次重启时把人全踢下线，那正是当初要修的病。
  //     占位串至少行为确定；配上 SESSION_SECRET 之后就彻底安全。
  //   ⚠️后果：线上如果没注入 SESSION_SECRET，切换成占位串那一刻旧 token 全部验签失败，
  //     会**全员掉线一次**（之后客户端自动重新登录，不影响功能）。
  sessionSecret: process.env.SESSION_SECRET || 'CHANGE-ME-set-SESSION_SECRET-env',
  // 「玩家有没有真的配过密钥」。★不能靠「上面的值非空」判断 —— 占位串本身也是非空的，
  //   那样写等于没检查。所以单独记一个布尔值，由 index.js 在启动时据此打警告。
  //   放在 config 里而不是让 index.js 直接读 process.env：配置只在一处读，别处不碰环境变量。
  sessionSecretIsSet: !!process.env.SESSION_SECRET,
  sessionTtlDays: Number(process.env.SESSION_TTL_DAYS || 30),

  // ---------- 静态资源 ----------
  publicDir: path.resolve(__dirname, '..', 'public'),
  // 前后端共用代码目录：shared/const.js 与 shared/sim.js
  // P1 由浏览器加载（/shared/xxx.js），P2 由 Node require，同一份文件两端通吃
  sharedDir: path.resolve(__dirname, '..', 'shared'),

  // ---------- 游戏参数 ----------
  maxMobs: Number(process.env.MAX_MOBS || 1200),   // 同屏怪物硬上限
  tickRate: Number(process.env.TICK_RATE || 20),   // 服务器权威循环频率

  // ---------- 房间 / 对局（P2-2 服务端权威循环使用） ----------
  maxPlayers: Number(process.env.MAX_PLAYERS || 8),        // 单房间人数上限
  // 单局观战人数上限。必须设：不设的话一个人开十个标签页就能把带宽吃光
  //（每份快照都是按视口裁剪过的完整战场包，几十 KB 一帧）。
  // 0 = 不限（只建议本地调试时用）。
  maxSpectators: Number(process.env.MAX_SPECTATORS || 4),
  roomCodeLen: Number(process.env.ROOM_CODE_LEN || 4),     // 房间号位数
  // 快照下发频率：越低越省带宽，但客户端插值越容易看出「延迟感」。
  // 20Hz（=逻辑帧率）在局域网最跟手；带宽吃紧时调低到 10。
  snapshotHz: Number(process.env.SNAPSHOT_HZ || 20),
  // HUD 下发频率：血条/经验/倒计时变化慢，不需要跟快照同频
  hudHz: Number(process.env.HUD_HZ || 5),
  // ---------- 视野裁剪（P2-5 调优） ----------
  // 正常对局**按人裁剪**：客户端在 room_join 时报自己视口的 CSS 像素尺寸，
  // 服务端算出「那人相机能看到的矩形」再下发（match.viewBoxFor）。
  //
  // 为什么用矩形而不是「以玩家为心的圆」：相机看到的就是矩形，而且贴着地图边界时
  // 相机被钳住、玩家会偏到屏幕边角。想用圆盖住那种情形，半径得放到
  // sqrt(viewW² + (viewH/2)²)（1280x860 时约 1350px），比矩形大一倍多 —— 等于白裁。
  // 旧的全局 VIEW_RADIUS=1400 之所以「看着能用」，正是因为它大到把这种情形一起盖住了。
  viewRadius: Number(process.env.VIEW_RADIUS || 900),   // 客户端没报视口时的兜底半径
  viewRadiusMin: Number(process.env.VIEW_RADIUS_MIN || 600),   // 上报半径的钳位下界
  viewRadiusMax: Number(process.env.VIEW_RADIUS_MAX || 2200),  // 上报半径的钳位上界
  // 视野框在相机矩形外再放宽多少像素。要覆盖三件事：
  //   ① 渲染层自己的 40px 视口余量（render.js computeBounds 的 pad）
  //   ② 相机平滑跟随的滞后（移动时约 12px）
  //   ③ 服务端算这一帧时玩家位置 与 客户端画那一帧时相机位置 之间的时差
  // 150 是很宽松的值，实测够用。
  viewPad: Number(process.env.VIEW_PAD || 150),
  // 上报视口尺寸的钳位（防 NaN / 0 / 荒唐值把人搞成「全黑」，只影响他自己的带宽）
  viewMinW: Number(process.env.VIEW_MIN_W || 480),
  viewMinH: Number(process.env.VIEW_MIN_H || 320),
  viewMaxW: Number(process.env.VIEW_MAX_W || 3840),
  viewMaxH: Number(process.env.VIEW_MAX_H || 2160),
  // 【P2-5】快照是否走二进制协议（shared/proto_bin.js）。
  // 设 0 退回 JSON —— 只用于对照压测与排障（二进制下客户端看不到可读包体，
  // 出问题时先用它确认「是协议的问题还是世界的问题」）。
  binSnap: process.env.BIN_SNAP !== '0',
  // 【P2-5】每多少帧插一个「关键帧」（px/py 一定显式带上，供客户端重整插值基线）。
  // 默认 0 = 不插：WebSocket 走 TCP，帧不会丢也不会乱序，客户端按 id 从上一帧
  // 重建 px/py 是可靠的；新加入/重连的人天然会拿到一帧关键帧（见 match 的 keyAt）。
  // 真机上如果出现「插值抖动」再把它设成 100（5 秒一帧）来买保险 —— 代价见文档。
  keyFrameEveryFrames: Number(process.env.KEYFRAME_EVERY || 0),
  // 升级面板超时兜底（秒）：卡在面板上超过这个时间就自动选第一项。
  // 联机里「升级中 = 无敌」，没有这个兜底就等于「发呆即无敌」，是必须堵的漏洞。
  // 设 0 表示关闭。
  upgradeTimeoutSec: Number(process.env.UPGRADE_TIMEOUT || 30),
  // 对局结束后在内存里多留多久（秒），供客户端拉结算页 / 重连查询
  matchKeepSec: Number(process.env.MATCH_KEEP || 60),
  // 候场室里最后一个人掉线后，房间还留多久（秒）。宽限期内他回来能接回原座位与房主身份；
  // 超时房间才销毁。大厅页 → game.html 的跳转在服务端看起来就是一次全员断线，
  // 所以这个值不能比一次页面跳转短太多，否则每次开局都会把房间拆了。
  roomKeepSec: Number(process.env.ROOM_KEEP || 90),
  // 服务端默认刷怪半径（客户端视口更小时以自己的为准，这里只作兜底）
  spawnRadiusDefault: Number(process.env.SPAWN_RADIUS || 1200),

  // ---------- 调试开关 ----------
  debugHud: process.env.DEBUG_HUD === '1',         // 游戏页性能浮层
  debugLagMs: Number(process.env.DEBUG_LAG || 0),  // 人为延迟发包，模拟弱网
  // 开发用优雅停机接口开关（默认关闭，线上不设这个环境变量就等于不存在）。
  // 为什么需要：本机 pglite 是单写入者，硬杀会留下锁甚至写坏 WAL；
  // 而 Windows 上后台进程收不到 Ctrl+C（taskkill 不带 /F 会直接报「只能强行终止」）。
  // 所以给本地开发留一个出口：启动时加 DEV_SHUTDOWN=1，之后
  // POST /api/shutdown 就能走 index.js 里那套优雅关闭流程。
  devShutdown: process.env.DEV_SHUTDOWN === '1',

  // ---------- 账号规则 ----------
  usernameMin: 3,
  usernameMax: 16,
  passwordMin: 6,
  nicknameMax: 12
};

module.exports = config;
