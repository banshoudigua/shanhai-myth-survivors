// server/api/router.js —— 极简 HTTP 路由 + 静态资源服务
//
// 设计取舍：
// 1. 不引入 Express/Koa，路由就是一个数组，按 method + path 顺序匹配；
// 2. 静态文件手写，避免额外依赖，同时精确控制目录穿越防护；
// 3. 所有处理函数统一 callback(result) 风格，不用 try/catch 做流程控制。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const queries = require('../db/queries');
const auth = require('./auth');
const manager = require('../rooms/manager');

const router = {};

// ============================================================
// 通用工具
// ============================================================

// 统一 JSON 响应
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

// 读取请求体（限制 64KB，防止超大请求打爆内存）
function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', function (chunk) {
    size += chunk.length;
    if (size > 65536) {
      req.destroy();
      return cb(new Error('BODY_TOO_LARGE'));
    }
    chunks.push(chunk);
  });
  req.on('end', function () {
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return cb(null, {});
    try {
      cb(null, JSON.parse(raw));
    } catch (e) {
      cb(new Error('BAD_JSON'));
    }
  });
  req.on('error', function (err) {
    cb(err);
  });
}

// 取客户端 IP（经过反代时优先取 X-Forwarded-For 第一段）
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

// ============================================================
// 业务处理函数
// ============================================================

// 注册
function handleRegister(req, res) {
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { ok: false, msg: '请求格式错误' });

    auth.register(body.username, body.nickname, body.password, clientIp(req), function (authErr, result) {
      if (authErr) {
        console.log('[api] 注册异常:', authErr.message);
        return sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
      }
      sendJson(res, result.ok ? 200 : 400, result);
    });
  });
}

// 登录
function handleLogin(req, res) {
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { ok: false, msg: '请求格式错误' });

    auth.login(body.username, body.password, clientIp(req), function (authErr, result) {
      if (authErr) {
        console.log('[api] 登录异常:', authErr.message);
        return sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
      }
      sendJson(res, result.ok ? 200 : 401, result);
    });
  });
}

// 注销
function handleLogout(req, res) {
  auth.logout(auth.extractToken(req), function () {
    sendJson(res, 200, { ok: true });
  });
}

// 凭 token 重设密码（不需要旧密码）。
// 【为什么需要】账号被「按 token 重建」时库里那个密码哈希是随机写的、谁都不知道，
//   没有这个出口的话重建就等于把账号锁死（详见 auth.setPassword 的注释）。
function handlePassword(req, res) {
  readBody(req, function (err, body) {
    if (err) return sendJson(res, 400, { ok: false, msg: '请求格式错误' });

    auth.setPassword(auth.extractToken(req), body.password, function (authErr, result) {
      if (authErr) {
        console.log('[api] 设置密码异常:', authErr.message);
        return sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
      }
      // 密码不合规 / token 失效都按 400 回，前端只认 ok 与 msg
      sendJson(res, result.ok ? 200 : 400, result);
    });
  });
}

// 当前用户信息 + 累计统计
function handleMe(req, res) {
  auth.verifyToken(auth.extractToken(req), function (err, user) {
    if (err) return sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
    if (!user) return sendJson(res, 401, { ok: false, msg: '未登录' });

    queries.getPlayerStats(user.id, function (statErr, stats) {
      // 统计行可能不存在（新用户还没打过对局），给出零值兜底
      sendJson(res, 200, {
        ok: true,
        user: user,
        stats: stats || {
          total_matches: 0,
          total_kills: 0,
          best_kills: 0,
          longest_survive: 0,
          total_play_sec: 0,
          max_level: 1
        }
      });
    });
  });
}

// 在线玩家列表（大厅展示，不要求登录）
function handlePlayers(req, res) {
  sendJson(res, 200, {
    ok: true,
    online: manager.listOnline(),
    rooms: manager.listRooms()
  });
}

// 某个玩家的公开数据（详情页）
function handlePlayerDetail(req, res, params) {
  const id = Number(params.id);
  if (!id || id <= 0) return sendJson(res, 400, { ok: false, msg: '玩家 ID 无效' });

  queries.findUserById(id, function (err, user) {
    if (err) return sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
    if (!user) return sendJson(res, 404, { ok: false, msg: '玩家不存在' });

    queries.getPlayerStats(id, function (statErr, stats) {
      sendJson(res, 200, {
        ok: true,
        player: {
          id: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
          created_at: user.created_at,
          last_login_at: user.last_login_at
        },
        stats: stats || {
          total_matches: 0,
          total_kills: 0,
          best_kills: 0,
          longest_survive: 0,
          total_play_sec: 0,
          max_level: 1
        }
      });
    });
  });
}

// 排行榜
function handleLeaderboard(req, res, params, query) {
  const type = query.get('type') || 'kills';
  let limit = Number(query.get('limit') || 20);
  if (!(limit > 0) || limit > 100) limit = 20;

  queries.getLeaderboard(type, limit, function (err, rows) {
    if (err) return sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
    sendJson(res, 200, { ok: true, type: type, list: rows || [] });
  });
}

// 游戏数值配置（前端初始化用，后台热更后会变）
function handleConfig(req, res) {
  queries.getGameConfig(function (err, conf) {
    if (err) return sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
    sendJson(res, 200, { ok: true, config: conf });
  });
}

// 健康检查（云托管探针与部署验证都用它）
function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    dbDriver: require('../db/driver').kind,
    online: manager.count(),
    uptimeSec: Math.floor(process.uptime())
  });
}

// 时钟一致性诊断（只读、无副作用）。
//
// 【为什么留这个接口】线上出现过「登录后立刻被判失效」：注册拿到 token 后紧接着取
// /api/me 就 401。这类问题只在特定环境复现（本地怎么测都是好的），靠读代码猜不出来 ——
// 必须把「数据库看到的当前时间」「应用传进去的时间参数」「两者比较的结果」「表里到底有几行」
// 一次性取出来对照。后续再遇到时间相关的怪现象，先打这个接口看一眼。
// 取某个依赖【实际安装】的版本号。
// 为什么写得这么绕：包的 exports 字段一般不允许 require('<pkg>/package.json')，
// 直接 require 会抛 ERR_PACKAGE_PATH_NOT_EXPORTED（写这个诊断时刚踩过）。
// 所以先解析它的主入口拿到文件路径，再沿目录往上找到它自己的 package.json。
function readPackageVersion(name) {
  let entry = '';
  try {
    entry = require.resolve(name);
  } catch (e) {
    return '未安装';
  }
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i++) {
    const pkgPath = path.join(dir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const json = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (json.name === name) return json.version;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return '未知';
}

// 返回的字段分三组：
//   ① 进程身份 —— pid / uptime / Node 版本。多次请求的 pid 不同，说明背后有多个进程，
//      那么「注册写进 A 的库、取个人信息读到 B 的库」就说得通了；
//   ② 时钟 —— 数据库的 now()、应用传进去的时间参数、两者比较的结果；
//   ③ 读写自检 —— 现场插一条探针会话再按 token 读回（读回后立刻删掉，不留垃圾）。
//      这一条最关键：写入与读取都在同一个请求里完成，能直接判定
//      「写进去了但按 token 查不到」到底是 SQL 的问题还是进程的问题。
function handleDiagClock(req, res) {
  const db = require('../db/driver');
  const probe = new Date(Date.now() + 30 * 24 * 3600 * 1000);   // 模拟一个 30 天后的会话过期时间
  const out = {
    pid: process.pid,
    ppid: process.ppid,
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    tzOffsetMin: new Date().getTimezoneOffset(),
    appNowIso: new Date().toISOString(),
    probeSentIso: probe.toISOString(),
    // 会话形态：自证式 token（vs1. 前缀，签名里带身份，不写 sessions 表）
    // 还是老式的「随机串 + sessions 表」。线上排查登录问题时先看这一行。
    tokenMode: 'vs1-signed（会话不落库：数据被回滚也能继续登录）'
  };

  // pglite 的实际安装版本（沙箱按 ^0.5.8 解析，装到的可能与本机 lock 固定的不是同一个）
  out.pgliteVersion = readPackageVersion('@electric-sql/pglite');
  out.wsVersion = readPackageVersion('ws');

  // 本次请求实际收到了什么凭证 —— 用来区分「token 压根没送到服务端」与「送到了但查不到」。
  // 实测结论：平台网关会用平台自己的 JWT 覆盖 Authorization 头（长度对不上就是它干的），
  // 所以这里把三类通道都回显出来，哪种能透传一目了然。
  const seenAuth = req.headers['authorization'] || '';
  const seenVS = req.headers['x-vs-token'] || '';
  const seenCookie = req.headers['cookie'] || '';
  out.authHeaderSeen = seenAuth ? String(seenAuth).slice(0, 20) + '…（长度 ' + String(seenAuth).length + '）' : '(未收到)';
  out.xVsTokenSeen = seenVS ? String(seenVS).slice(0, 20) + '…（长度 ' + String(seenVS).length + '）' : '(未收到)';
  out.cookieSeen = seenCookie ? String(seenCookie).slice(0, 20) + '…' : '(未收到)';
  out.queryTokenSeen = (req.searchParams && req.searchParams.get('token')) ? '有' : '无';
  out.headerNames = Object.keys(req.headers).sort().join(', ');
  // 【只回显长度，不回显内容】这是公开可达的诊断接口，回显 token 片段没有任何好处：
  // 排查「凭证到底送没送到」看的是长度与来源头（当初发现网关覆盖 Authorization 时，
  // 决定性证据就是长度 71 → 386），内容一个字符都用不上。
  out.tokenExtracted = auth.extractToken(req) ? '取到（长度 ' + auth.extractToken(req).length + '）' : '(空)';

  function finish() {
    sendJson(res, 200, { ok: true, diag: out });
  }

  db.query(
    'SELECT now() AS db_now, $1::timestamptz AS probe_date, ($1::timestamptz > now()) AS cmp_ok, ' +
    '(SELECT count(*)::int FROM sessions) AS session_rows, ' +
    '(SELECT count(*)::int FROM users) AS user_rows',
    [probe],
    function (err, rows) {
      out.clockErr = err ? String(err.message || err) : null;
      out.clock = (rows && rows[0]) || null;

      db.query('SELECT id FROM users LIMIT 1', [], function (e1, r1) {
        const uid = (r1 && r1[0]) ? r1[0].id : null;
        out.firstUserIdType = typeof uid;
        // BIGINT 读出来可能是 BigInt，而 JSON.stringify 遇到 BigInt 会直接抛 —— 转成字符串再返回
        out.firstUserId = typeof uid === 'bigint' ? uid.toString() + ' (bigint)' : uid;
        out.lookupErr = e1 ? String(e1.message || e1) : null;
        if (uid === null) return finish();

        // 自检 A：用与真实注册**完全相同**的形状插一条（64 位 hex token + 带 ip），
        // 然后走一遍 auth.verifyToken —— 那就是 /api/me 用的那条判断。
        const hexToken = crypto.randomBytes(32).toString('hex');
        db.query(
          'INSERT INTO sessions (token, user_id, expires_at, ip) VALUES ($1, $2, $3, $4)',
          [hexToken, uid, probe, '127.0.0.1'],
          function (e2) {
            out.selfTestInsertErr = e2 ? String(e2.message || e2) : null;

            auth.verifyToken(hexToken, function (e3, u3) {
              out.selfTestVerifyOk = !!u3;
              out.selfTestVerifyUser = u3 ? u3.username : null;
              out.selfTestVerifyErr = e3 ? String(e3.message || e3) : null;

              // 把自检行删掉，别在真实表里留垃圾
              db.query('DELETE FROM sessions WHERE token = $1', [hexToken], function () {
                // 自检 B：拿库里**真实存在**的最新一条会话去校验 ——
                // 客户端手里的 token 就是它，它能过就说明「查询」这一环没问题，
                // 那 401 就只能出在「凭证没送到」上。
                db.query('SELECT token FROM sessions ORDER BY created_at DESC LIMIT 1', [], function (e4, r4) {
                  out.latestQueryErr = e4 ? String(e4.message || e4) : null;
                  const realTok = (r4 && r4[0]) ? r4[0].token : null;
                  // 同理：这是**别人**的会话 token，绝不能回显片段。
                  // 只报长度，足够证明「表里有行、长度正常」。
                  out.latestSessionTokenLen = realTok ? String(realTok).length : 0;
                  if (!realTok) return finish();

                  auth.verifyToken(realTok, function (e5, u5) {
                    out.latestSessionVerifyOk = !!u5;
                    out.latestSessionVerifyUser = u5 ? u5.username : null;
                    out.latestSessionVerifyErr = e5 ? String(e5.message || e5) : null;
                    finish();
                  });
                });
              });
            });
          }
        );
      });
    }
  );
}

// 对局观测：房间列表 + 进行中的对局 + 单帧耗时 + 快照带宽。
// 这是联机调优的眼睛：不看这里的数字，就没法判断「卡」是服务端算得慢
// 还是下行包太大，也没法验证 P2-5 的压缩到底省了多少。
function handleGameStats(req, res) {
  const proto = require('../game/proto');
  sendJson(res, 200, { ok: true, stats: proto.stats() });
}

// 房间列表（大厅「加入房间」用，与 /api/players 里的 rooms 字段同一份数据）
function handleRooms(req, res) {
  sendJson(res, 200, { ok: true, list: manager.listRooms() });
}

// 开发用优雅停机。默认关闭（没设 DEV_SHUTDOWN=1 时与「接口不存在」完全一样）。
//
// 存在的理由：本机 pglite 是单写入者，硬杀服务端（Stop-Process -Force / taskkill /F）
// 会留下陈旧锁、甚至写坏 WAL —— 这个坑已经踩过一次。
// 而 Windows 上后台启动的进程收不到 Ctrl+C：taskkill 不带 /F 会直接报
// 「只能强行终止这个进程(带 /F 选项)」，所以没有任何正常的远程停机手段。
// 这里借 index.js 已有的 SIGINT 处理器，让它把该做的事（停对局循环、关连接、退进程）都做全。
function handleShutdown(req, res) {
  if (!config.devShutdown) return sendJson(res, 404, { ok: false, msg: '接口不存在' });

  sendJson(res, 200, { ok: true, msg: '正在优雅关闭' });
  // 等响应发完再触发，否则客户端只会看到「连接被重置」，分不清是成功还是崩了
  setTimeout(function () {
    console.log('[api] 收到 /api/shutdown，转入优雅关闭流程');
    process.kill(process.pid, 'SIGINT');
  }, 150);
}

// ============================================================
// 路由表
// ============================================================
// 说明：path 中出现 :xxx 的段为参数占位，按段匹配
const routes = [
  { method: 'POST', path: '/api/register',      handler: handleRegister },
  { method: 'POST', path: '/api/login',         handler: handleLogin },
  { method: 'POST', path: '/api/logout',        handler: handleLogout },
  { method: 'POST', path: '/api/password',      handler: handlePassword },
  { method: 'GET',  path: '/api/me',            handler: handleMe },
  { method: 'GET',  path: '/api/players',       handler: handlePlayers },
  { method: 'GET',  path: '/api/players/:id',   handler: handlePlayerDetail },
  { method: 'GET',  path: '/api/leaderboard',   handler: handleLeaderboard },
  { method: 'GET',  path: '/api/config',        handler: handleConfig },
  { method: 'GET',  path: '/api/health',        handler: handleHealth },
  { method: 'GET',  path: '/api/diag/clock',    handler: handleDiagClock },
  // P2-2 新增：房间列表与对局观测（联机调优的眼睛）
  { method: 'GET',  path: '/api/rooms',         handler: handleRooms },
  { method: 'GET',  path: '/api/gamestats',     handler: handleGameStats },
  // 开发用优雅停机（默认关闭，见 handleShutdown 的说明）
  { method: 'POST', path: '/api/shutdown',      handler: handleShutdown }
];

// 匹配路由：逐段比较，:xxx 段作为参数收集
function matchRoute(method, pathname) {
  const reqParts = pathname.split('/').filter(Boolean);
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    if (route.method !== method) continue;

    const routeParts = route.path.split('/').filter(Boolean);
    if (routeParts.length !== reqParts.length) continue;

    const params = {};
    let matched = true;
    for (let j = 0; j < routeParts.length; j++) {
      const rp = routeParts[j];
      if (rp.charAt(0) === ':') {
        params[rp.slice(1)] = decodeURIComponent(reqParts[j]);
      } else if (rp !== reqParts[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return { route: route, params: params };
  }
  return null;
}

// ============================================================
// 静态资源
// ============================================================

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  // 站点图标。webmanifest 缺这一项会被当成 application/octet-stream ——
  // Chrome 能容忍，但 Safari 解析 manifest 失败就会退回「没有图标」。
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  // 像素字体 VT323 用的是 ttf（库里只有 ttf 版本）。
  // 补齐 ttf/otf —— 缺了会被当成 application/octet-stream，
  // 浏览器对字体 MIME 有校验，可能直接拒收导致「字体不生效、回退系统字体」。
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.mp3':  'audio/mpeg',
  '.ogg':  'audio/ogg'
};

// ============================================================
// 站点外壳路由（History API 的服务端一半）
// ============================================================
//
// 【为什么要有这一段】前端要用 History API 把地址栏写成干净的 `/game?room=XXX`
// （而不是暴露 `game.html`），返回时用 history.back() 回到大厅。
// 但 History API 只改地址栏、不发请求 —— **刷新 /game 会真的打一个 HTTP 请求到服务器**，
// 而服务器上根本没有这个文件 → 404 白屏。所以服务端必须认识它。
//
// ★为什么是**白名单映射**而不是「未知路径一律回 index.html」
//   那种「catch-all 回落」在单页应用里是常规做法，但本项目是**两个独立页面**
//   （大厅 /game.html），一份 index.html 顶不上所有地址：
//   回落错了会得到「打对了字却打开了另一个页面」的鬼故事，比 404 难查得多。
//   白名单 = 加新路由必须显式登记，改错会立刻被 404 抓出来，而不是悄悄跑偏。
//
// ★为什么保留 `/game.html` 本身
//   19 个 tools/*.js 测试脚本直接拼 `/game.html?...` 访问（它们读的是真实磁盘路径，
//   与人用的地址栏无关）。删掉它等于一次性废掉整套回归，所以两条路都留着：
//   `/game.html` 继续能开（给脚本和收藏），`/game` 是给人用的干净地址。
const PAGE_ALIAS = {
  '/game': '/game.html',
  '/lobby': '/index.html'
};

function resolveAlias(pathname) {
  if (Object.prototype.hasOwnProperty.call(PAGE_ALIAS, pathname)) return PAGE_ALIAS[pathname];
  // 带尾斜杠的等价写法也认（手输地址时很容易多打一个斜杠）
  if (pathname.length > 1 && pathname.charAt(pathname.length - 1) === '/') {
    const trimmed = pathname.slice(0, -1);
    if (Object.prototype.hasOwnProperty.call(PAGE_ALIAS, trimmed)) return PAGE_ALIAS[trimmed];
  }
  return null;
}

function serveStatic(req, res, pathname, root) {
  // root 指定静态根目录：默认 public/；/shared/ 前缀会传 shared/
  const baseDir = root || config.publicDir;

  // 默认首页
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // History API 的干净路由 → 真实文件（见 PAGE_ALIAS 的说明）
  const alias = resolveAlias(pathname);
  if (alias) pathname = alias;

  // 解码路径：非法百分号转义（如 /%zz）会让 decodeURIComponent 抛 URIError，
  // 这里先兜住并直接按 400 返回，避免异常穿透出去把请求挂死
  let decoded = '';
  try {
    decoded = decodeURIComponent(pathname);
  } catch (e) {
    console.log('[static] 非法 URL 编码: ' + pathname);
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }

  // 目录穿越防护：先归一化，再要求最终路径严格落在 baseDir 内。
  // 注意不能只用 indexOf 前缀判断 —— 同级的 public-x 目录也会通过，
  // 因此必须比对目录分隔符，或与 baseDir 本身完全相等。
  const target = path.normalize(path.join(baseDir, decoded));
  const inBase = target === baseDir ||
    target.indexOf(baseDir + path.sep) === 0;

  if (!inBase) {
    console.log('[static] 拦截目录穿越请求: ' + pathname);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  fs.stat(target, function (err, stat) {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }

    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';

    // HTML / JS / CSS 走协商缓存：改完代码刷新就能拿到新的，
    // 没改则回 304，既不会吃到旧文件也不浪费带宽；
    // 图片音频这类大文件才用长缓存。
    // （踩过坑：给 JS 设 max-age 会导致改了代码刷新还是旧逻辑，极其难查）
    const revalidate = ext === '.html' || ext === '.js' || ext === '.css';
    const cache = revalidate ? 'no-cache' : 'public, max-age=3600';

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': cache
    });
    fs.createReadStream(target).pipe(res);
  });
}

// ============================================================
// 总入口
// ============================================================

// 前后端共用代码的 URL 前缀。切片时用 length-1 是为了保留开头的 '/'
const SHARED_PREFIX = '/shared/';

router.handle = function (req, res) {
  // URL 解析也要兜底：畸形请求行理论上能让 new URL 抛错
  let parsed = null;
  try {
    parsed = new URL(req.url, 'http://localhost');
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('400 Bad Request');
  }
  const pathname = parsed.pathname;
  // 把查询参数挂到 req 上：认证层要用它当兜底通道（原因见 auth.extractToken）
  req.searchParams = parsed.searchParams;

  // 统一异常兜底：处理函数内部不写 try/catch，异常在这里被捕获并记录，
  // 保证任何一条坏请求都不会让整个服务崩掉
  try {
    // API 优先
    if (pathname.indexOf('/api/') === 0) {
      const hit = matchRoute(req.method, pathname);
      if (!hit) {
        return sendJson(res, 404, { ok: false, msg: '接口不存在' });
      }
      return hit.route.handler(req, res, hit.params, parsed.searchParams);
    }

    // 前后端共用代码：/shared/const.js、/shared/sim.js
    // 浏览器按这个路径加载，Node 侧则直接 require，保证两端跑的是同一份实现
    if (pathname.indexOf(SHARED_PREFIX) === 0) {
      return serveStatic(req, res, pathname.slice(SHARED_PREFIX.length - 1), config.sharedDir);
    }

    // 其余走静态资源
    serveStatic(req, res, pathname);
  } catch (e) {
    console.log('[router] 未捕获异常 ' + req.method + ' ' + pathname + ': ' + (e && e.message));
    // 响应头可能已经发出去了，此时只能断开连接
    if (!res.headersSent) sendJson(res, 500, { ok: false, msg: '服务器内部错误' });
    else res.end();
  }
};

module.exports = router;
