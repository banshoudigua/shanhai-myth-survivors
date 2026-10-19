// tools/smoke.js —— P0 端到端自检
//
// 覆盖范围：
//   HTTP：健康检查 / 注册 / 重复注册 / 登录 / 错误密码 / 取当前用户 / 玩家列表 / 排行榜 / 数值配置
//   WS  ：账号握手 / 游客握手 / 在线列表推送 / 心跳 ping-pong / 失效 token 拒绝
//
// 用法：先启动服务，再执行 node tools/smoke.js [端口]
// 说明：全部走 callback 串联，不用 try/catch 做流程控制；最后打印 PASS/FAIL 汇总。

const WebSocket = require('ws');

const PORT = Number(process.argv[2] || 3000);
const BASE = 'http://127.0.0.1:' + PORT;

let pass = 0;
let fail = 0;

function ok(name, extra) {
  pass += 1;
  console.log('  PASS  ' + name + (extra ? '  (' + extra + ')' : ''));
}

function bad(name, detail) {
  fail += 1;
  console.log('  FAIL  ' + name + '  ->  ' + detail);
}

// 简易断言：条件成立记 PASS，否则记 FAIL
function expect(name, cond, detail) {
  if (cond) ok(name);
  else bad(name, detail || '断言不成立');
}

// 带超时的 HTTP 请求，返回 { status, json }
function call(method, path, body, token, cb) {
  const headers = {};
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (body) headers['Content-Type'] = 'application/json';

  const timer = setTimeout(function () {
    cb(new Error('请求超时 ' + method + ' ' + path));
  }, 8000);

  fetch(BASE + path, {
    method: method,
    headers: headers,
    body: body ? JSON.stringify(body) : undefined
  }).then(function (res) {
    return res.text().then(function (text) {
      clearTimeout(timer);
      let json = null;
      if (text) {
        try {
          json = JSON.parse(text);
        } catch (e) {
          json = null;
        }
      }
      // 带上 Cache-Control，用于校验 JS/CSS 是否走了协商缓存
      cb(null, {
        status: res.status,
        json: json,
        cache: res.headers.get('cache-control') || ''
      });
    });
  }, function (err) {
    clearTimeout(timer);
    cb(err);
  });
}

// ============================================================
// 步骤定义
// ============================================================

const suffix = Date.now().toString(36).slice(-6);
const username = 'smoke_' + suffix;
const password = 'test123456';

let token = '';

// 步骤 1：健康检查
function stepHealth(cb) {
  console.log('[1] 健康检查');
  call('GET', '/api/health', null, '', function (err, res) {
    if (err) {
      bad('GET /api/health', err.message);
      return cb(err);
    }
    expect('GET /api/health 返回 200', res.status === 200, 'status=' + res.status);
    expect('健康检查 ok=true', res.json && res.json.ok === true, JSON.stringify(res.json));
    expect('数据驱动为 pglite', res.json && res.json.dbDriver === 'pglite', 'driver=' + (res.json && res.json.dbDriver));
    cb(null);
  });
}

// 步骤 2：注册
function stepRegister(cb) {
  console.log('[2] 注册（用户名 ' + username + '）');
  call('POST', '/api/register', { username: username, nickname: '自检玩家', password: password }, '', function (err, res) {
    if (err) {
      bad('POST /api/register', err.message);
      return cb(err);
    }
    expect('注册返回 200', res.status === 200, 'status=' + res.status);
    expect('注册 ok=true', res.json && res.json.ok === true, JSON.stringify(res.json));
    expect('注册返回 token', !!(res.json && res.json.token), 'token 缺失');
    expect('注册返回不含密码字段', !(res.json && res.json.user && res.json.user.password_hash), '泄露了 password_hash');
    if (res.json && res.json.token) token = res.json.token;
    cb(res.json && res.json.ok ? null : new Error('注册失败，后续步骤无意义'));
  });
}

// 步骤 3：重复注册应被拒
function stepRegisterDuplicate(cb) {
  console.log('[3] 重复注册（应被拒绝）');
  call('POST', '/api/register', { username: username, password: password }, '', function (err, res) {
    if (err) {
      bad('重复注册', err.message);
      return cb(null);
    }
    expect('重复注册返回 400', res.status === 400, 'status=' + res.status);
    expect('重复注册 code=USERNAME_TAKEN', res.json && res.json.code === 'USERNAME_TAKEN', JSON.stringify(res.json));
    cb(null);
  });
}

// 步骤 4：非法用户名应被拒
function stepRegisterBadName(cb) {
  console.log('[4] 非法用户名（应被拒绝）');
  call('POST', '/api/register', { username: 'a', password: password }, '', function (err, res) {
    if (err) {
      bad('非法用户名', err.message);
      return cb(null);
    }
    expect('非法用户名返回 400', res.status === 400, 'status=' + res.status);
    expect('非法用户名 code=BAD_USERNAME', res.json && res.json.code === 'BAD_USERNAME', JSON.stringify(res.json));
    cb(null);
  });
}

// 步骤 5：登录
function stepLogin(cb) {
  console.log('[5] 登录');
  call('POST', '/api/login', { username: username, password: password }, '', function (err, res) {
    if (err) {
      bad('POST /api/login', err.message);
      return cb(null);
    }
    expect('登录返回 200', res.status === 200, 'status=' + res.status);
    expect('登录 ok=true', res.json && res.json.ok === true, JSON.stringify(res.json));
    expect('登录返回 token', !!(res.json && res.json.token), 'token 缺失');
    if (res.json && res.json.token) token = res.json.token;
    cb(null);
  });
}

// 步骤 6：错误密码应被拒
function stepLoginWrongPass(cb) {
  console.log('[6] 错误密码（应被拒绝）');
  call('POST', '/api/login', { username: username, password: 'wrong_password_xx' }, '', function (err, res) {
    if (err) {
      bad('错误密码', err.message);
      return cb(null);
    }
    expect('错误密码返回 401', res.status === 401, 'status=' + res.status);
    expect('错误密码 code=BAD_CREDENTIAL', res.json && res.json.code === 'BAD_CREDENTIAL', JSON.stringify(res.json));
    cb(null);
  });
}

// 步骤 7：取当前用户
function stepMe(cb) {
  console.log('[7] 取当前用户');
  call('GET', '/api/me', null, token, function (err, res) {
    if (err) {
      bad('GET /api/me', err.message);
      return cb(null);
    }
    expect('GET /api/me 返回 200', res.status === 200, 'status=' + res.status);
    expect('返回用户名一致', res.json && res.json.user && res.json.user.username === username, JSON.stringify(res.json && res.json.user));
    expect('返回统计字段', !!(res.json && res.json.stats), 'stats 缺失');
    cb(null);
  });
}

// 步骤 8：未带 token 访问应 401
function stepMeNoToken(cb) {
  console.log('[8] 未登录访问（应 401）');
  call('GET', '/api/me', null, '', function (err, res) {
    if (err) {
      bad('未登录访问', err.message);
      return cb(null);
    }
    expect('未登录返回 401', res.status === 401, 'status=' + res.status);
    cb(null);
  });
}

// 步骤 9：排行榜与数值配置
function stepDataApis(cb) {
  console.log('[9] 排行榜 / 数值配置 / 玩家列表');
  call('GET', '/api/leaderboard?type=kills&limit=10', null, '', function (err, res) {
    if (err) {
      bad('GET /api/leaderboard', err.message);
      return cb(null);
    }
    expect('排行榜返回 200', res.status === 200, 'status=' + res.status);
    expect('排行榜返回数组', Array.isArray(res.json && res.json.list), JSON.stringify(res.json));

    // 非法 type 应回落到击杀榜而不是报错
    call('GET', '/api/leaderboard?type=xxx_null', null, '', function (err2, res2) {
      expect('非法排行榜类型回落不报错', !err2 && res2.status === 200, err2 ? err2.message : 'status=' + res2.status);

      call('GET', '/api/config', null, '', function (err3, res3) {
        if (err3) {
          bad('GET /api/config', err3.message);
          return cb(null);
        }
        const conf = res3.json && res3.json.config;
        expect('数值配置返回 200', res3.status === 200, 'status=' + res3.status);
        expect('数值配置含 max_mobs', !!(conf && conf.max_mobs), JSON.stringify(conf));
        expect('数值配置含 tick_rate', !!(conf && conf.tick_rate), JSON.stringify(conf));

        call('GET', '/api/players', null, '', function (err4, res4) {
          expect('玩家列表返回 200', !err4 && res4.status === 200, err4 ? err4.message : 'status=' + res4.status);
          expect('玩家列表含 online 数组', Array.isArray(res4.json && res4.json.online), JSON.stringify(res4.json));
          cb(null);
        });
      });
    });
  });
}

// 步骤 10：404 与目录穿越防护
function stepSecurity(cb) {
  console.log('[10] 异常路径与目录穿越防护');
  call('GET', '/api/not_exist', null, '', function (err, res) {
    expect('未知接口返回 404', !err && res.status === 404, err ? err.message : 'status=' + res.status);

    // 目录穿越：期望被拦在 public 目录内（403 或 404 都算拦住了）
    const evil = '/../server/config.js';
    call('GET', evil, null, '', function (err2, res2) {
      const blocked = !err2 && (res2.status === 403 || res2.status === 404);
      expect('目录穿越被拦截', blocked, err2 ? err2.message : 'status=' + res2.status);

      // 畸形百分号转义：不能让异常穿透出去把请求挂死，必须回 400
      call('GET', '/%zz', null, '', function (errEvil, resEvil) {
        expect('畸形 URL 编码返回 400 而非挂死', !errEvil && resEvil.status === 400,
          errEvil ? errEvil.message : 'status=' + resEvil.status);

        // 同级目录绕过：/../public_x 这类前缀相同的兄弟目录必须被挡住
        call('GET', '/../public_x/secret.txt', null, '', function (errSib, resSib) {
          const blocked2 = !errSib && (resSib.status === 403 || resSib.status === 404);
          expect('同级目录前缀绕过被拦截', blocked2, errSib ? errSib.message : 'status=' + resSib.status);

          // 首页应能正常返回
          call('GET', '/', null, '', function (err3, res3) {
            expect('首页返回 200', !err3 && res3.status === 200, err3 ? err3.message : 'status=' + res3.status);
            // 静态资源同样要能取到（Vue 本地化文件）
            call('GET', '/vendor/vue.global.prod.js', null, '', function (err4, res4) {
              expect('本地 Vue 可访问', !err4 && res4.status === 200, err4 ? err4.message : 'status=' + res4.status);

              // 游戏页与共用代码目录（P1 新增）
              call('GET', '/game.html', null, '', function (err5, res5) {
                expect('游戏页返回 200', !err5 && res5.status === 200, err5 ? err5.message : 'status=' + res5.status);

                call('GET', '/shared/const.js', null, '', function (err6, res6) {
                  expect('/shared/const.js 可访问', !err6 && res6.status === 200, err6 ? err6.message : 'status=' + res6.status);

                  call('GET', '/shared/sim.js', null, '', function (err7, res7) {
                    expect('/shared/sim.js 可访问', !err7 && res7.status === 200, err7 ? err7.message : 'status=' + res7.status);

                    // shared 目录的穿越防护同样要生效
                    call('GET', '/shared/../server/config.js', null, '', function (err8, res8) {
                      const blocked3 = !err8 && (res8.status === 403 || res8.status === 404);
                      expect('shared 目录穿越被拦截', blocked3, err8 ? err8.message : 'status=' + res8.status);

                      // JS/CSS 必须是协商缓存，否则改完代码刷新还是旧逻辑
                      call('GET', '/shared/sim.js', null, '', function (err9, res9) {
                        expect('JS 走协商缓存（no-cache）',
                          !err9 && res9 && res9.cache === 'no-cache',
                          'cache=' + (res9 && res9.cache));
                        cb(null);
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  });
}

// ============================================================
// 步骤 11：WebSocket 全链路
// ============================================================

function stepWebSocket(cb) {
  console.log('[11] WebSocket 握手与在线推送');

  const url = 'ws://127.0.0.1:' + PORT + '/ws';
  const wsA = new WebSocket(url);
  let wsB = null;
  let connIdA = '';
  let onlineSeen2 = false;

  let watchdog = setTimeout(function () {
    bad('WebSocket 流程', '整体超时 12 秒未走完');
    if (wsA) wsA.terminate();
    if (wsB) wsB.terminate();
    cb(null);
  }, 12000);

  function done() {
    clearTimeout(watchdog);
    if (wsA && wsA.readyState === 1) wsA.close();
    if (wsB && wsB.readyState === 1) wsB.close();
    setTimeout(function () {
      cb(null);
    }, 300);
  }

  wsA.on('open', function () {
    ok('账号连接建立');
    // 带 token 握手
    wsA.send(JSON.stringify({ t: 'hello', token: token }));
  });

  wsA.on('message', function (raw) {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return bad('解析服务端消息', raw.toString().slice(0, 80));
    }

    if (msg.t === 'welcome') {
      connIdA = msg.self && msg.self.connId;
      expect('账号握手返回 welcome', true);
      expect('welcome 带回 connId', !!connIdA, JSON.stringify(msg.self));
      expect('账号身份 isGuest=false', msg.self.isGuest === false, JSON.stringify(msg.self));
      expect('welcome 带回在线列表', Array.isArray(msg.online), JSON.stringify(msg.online));

      // 连第二个：游客
      wsB = new WebSocket(url);
      wsB.on('open', function () {
        wsB.send(JSON.stringify({ t: 'hello', nickname: '游客自检' }));
      });
      wsB.on('message', function (raw2) {
        let m2 = null;
        try {
          m2 = JSON.parse(raw2.toString());
        } catch (e) {
          return;
        }
        if (m2.t === 'welcome') {
          expect('游客握手成功（无需账号）', true);
          expect('游客身份 isGuest=true', m2.self.isGuest === true, JSON.stringify(m2.self));
          expect('游客 userId 为空', m2.self.userId === null, JSON.stringify(m2.self));
        }
      });
      wsB.on('error', function (e) {
        bad('游客连接', e.message);
      });
      return;
    }

    if (msg.t === 'online') {
      // 两个连接都在线时应推送到 2 人
      if (msg.count >= 2 && !onlineSeen2) {
        onlineSeen2 = true;
        ok('在线列表推送到 2 人', 'count=' + msg.count);

        // 校验推送内容结构
        const first = msg.list[0];
        expect('在线条目含 nickname', !!(first && first.nickname), JSON.stringify(first));
        expect('在线条目含 isGuest 标记', !!(first && typeof first.isGuest === 'boolean'), JSON.stringify(first));

        // 顺手验证 HTTP 侧的在线人数与 WS 一致
        call('GET', '/api/players', null, '', function (err, res) {
          const httpCount = res && res.json && res.json.online ? res.json.online.length : -1;
          expect('HTTP 在线人数与 WS 一致', httpCount === msg.count, 'http=' + httpCount + ' ws=' + msg.count);
        });

        // 心跳
        wsA.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
      }
      return;
    }

    if (msg.t === 'pong') {
      expect('心跳 ping 收到 pong', true);
      expect('pong 带回服务器时间', typeof msg.serverTime === 'number', JSON.stringify(msg));
      done();
      return;
    }

    if (msg.t === 'error') {
      bad('WebSocket 服务端报错', msg.code + ' ' + msg.msg);
    }
  });

  wsA.on('error', function (e) {
    bad('账号连接', e.message);
    clearTimeout(watchdog);
    cb(null);
  });
}

// 步骤 12：失效 token 必须被拒
function stepBadToken(cb) {
  console.log('[12] 失效 token（应被拒绝）');
  const ws = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');

  const timer = setTimeout(function () {
    bad('失效 token 拒绝', '超时未收到回复');
    ws.terminate();
    cb(null);
  }, 6000);

  ws.on('open', function () {
    ws.send(JSON.stringify({ t: 'hello', token: 'f'.repeat(64) }));
  });

  ws.on('message', function (raw) {
    let msg = null;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }
    if (msg.t === 'error') {
      clearTimeout(timer);
      expect('失效 token 返回 BAD_TOKEN', msg.code === 'BAD_TOKEN', JSON.stringify(msg));
      expect('失效 token 标记 fatal', msg.fatal === true, JSON.stringify(msg));
      ws.terminate();
      cb(null);
    }
  });

  ws.on('error', function (e) {
    clearTimeout(timer);
    bad('失效 token 连接', e.message);
    cb(null);
  });
}

// ============================================================
// 驱动：按顺序执行
// ============================================================

const STEPS = [
  stepHealth,
  stepRegister,
  stepRegisterDuplicate,
  stepRegisterBadName,
  stepLogin,
  stepLoginWrongPass,
  stepMe,
  stepMeNoToken,
  stepDataApis,
  stepSecurity,
  stepWebSocket,
  stepBadToken
];

console.log('');
console.log('=== P0 自检开始  目标 ' + BASE + ' ===');
console.log('');

let i = 0;
function next() {
  if (i >= STEPS.length) {
    console.log('');
    console.log('=== 自检结束 ===');
    console.log('  PASS = ' + pass + '   FAIL = ' + fail);
    console.log('');
    process.exit(fail === 0 ? 0 : 1);
  }
  const step = STEPS[i++];
  // 每一步都串行，前一步的回调里再启动下一步
  step(function () {
    console.log('');
    next();
  });
}

next();
