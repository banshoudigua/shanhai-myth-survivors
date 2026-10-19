// server/index.js —— 服务入口
//
// 一个进程同时承担三件事：
//   1. HTTP 服务（API + 静态页面）
//   2. WebSocket 服务（与 HTTP 共用同一端口，避免容器要多开端口）
//   3. 启动时的数据层初始化（建表 / 灌数值 / 清过期会话）
//
// 刻意不拆多进程：游戏循环、在线状态、WebSocket 连接都在同一份内存里，
// 免掉跨进程通信与状态同步，这也是局域网小规模联机最省心的形态。

const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const driver = require('./db/driver');
const queries = require('./db/queries');
const router = require('./api/router');
const hub = require('./net/ws');
const matchRegistry = require('./game/match');
const manager = require('./rooms/manager');

const SCHEMA_FILE = path.join(__dirname, 'db', 'schema.sql');
const SEED_FILE = path.join(__dirname, 'db', 'seed.sql');

// ============================================================
// 启动初始化
// ============================================================

function readSqlFile(file, cb) {
  fs.readFile(file, 'utf8', function (err, text) {
    if (err) return cb(err);
    cb(null, text);
  });
}

// 建表 -> 灌基础数值 -> 清过期会话，全部用 callback 串联，不写 try/catch
function bootstrap(cb) {
  readSqlFile(SCHEMA_FILE, function (readErr, schemaSql) {
    if (readErr) return cb(new Error('读取 schema.sql 失败: ' + readErr.message));

    driver.exec(schemaSql, function (schemaErr) {
      if (schemaErr) return cb(new Error('建表失败: ' + schemaErr.message));
      console.log('[boot] 表结构就绪');

      readSqlFile(SEED_FILE, function (seedReadErr, seedSql) {
        if (seedReadErr) return cb(new Error('读取 seed.sql 失败: ' + seedReadErr.message));

        driver.exec(seedSql, function (seedErr) {
          if (seedErr) return cb(new Error('初始化数值失败: ' + seedErr.message));
          console.log('[boot] 基础数值与成就就绪');

          // 过期会话清理失败不影响启动，只记日志
          queries.cleanExpiredSessions(function (cleanErr) {
            if (cleanErr) console.log('[boot] 清理过期会话失败（忽略）: ' + cleanErr.message);
            else console.log('[boot] 过期会话已清理');
            cb(null);
          });
        });
      });
    });
  });
}

// ============================================================
// 访问地址打印
// ============================================================

// 常见虚拟网卡关键字：这些地址队友连不上，降级显示排在后面
const VIRTUAL_HINTS = ['vmware', 'virtualbox', 'hyper-v', 'vethernet', 'wsl', 'docker', 'loopback', 'tap', 'tun', 'zerotier', 'radmin'];

function isVirtualNic(name) {
  const lower = name.toLowerCase();
  for (let i = 0; i < VIRTUAL_HINTS.length; i++) {
    if (lower.indexOf(VIRTUAL_HINTS[i]) >= 0) return true;
  }
  return false;
}

function collectAddresses() {
  const real = [];
  const virtual = [];
  const ifaces = os.networkInterfaces();

  Object.keys(ifaces).forEach(function (name) {
    const list = ifaces[name] || [];
    list.forEach(function (info) {
      // 只要 IPv4 且非回环
      if (info.family !== 'IPv4' || info.internal) return;
      const item = { name: name, address: info.address };
      if (isVirtualNic(name)) virtual.push(item);
      else real.push(item);
    });
  });

  return real.concat(virtual);
}

function printAddresses() {
  const list = collectAddresses();

  console.log('');
  console.log('  ┌─────────────────────────────────────────────────────────┐');
  console.log('  │  服务已启动，把下面的地址发给队友即可一起玩              │');
  console.log('  └─────────────────────────────────────────────────────────┘');

  if (list.length === 0) {
    console.log('   未检测到局域网 IPv4 地址，请检查网络连接');
  } else {
    list.forEach(function (item, i) {
      const tag = i === 0 && !isVirtualNic(item.name) ? '  ← 推荐用这个' : '';
      console.log('   http://' + item.address + ':' + config.port + '   [' + item.name + ']' + tag);
    });
  }

  console.log('   本机自测:   http://127.0.0.1:' + config.port);
  console.log('   健康检查:   http://127.0.0.1:' + config.port + '/api/health');
  console.log('   数据驱动:   ' + driver.kind + (config.useLocalDb ? '（本地 pglite，数据在 ' + config.pgDataDir + '）' : '（云端 PostgreSQL）'));
  console.log('');
}

// ============================================================
// HTTP / WebSocket 服务
// ============================================================

const server = http.createServer(router.handle);

// WebSocket 与 HTTP 绑同一端口、同一条 listen，容器只需暴露一个端口
hub.attach(server);

// 启动失败（最常见是端口被占用）给出可操作的提示
server.on('error', function (err) {
  if (err.code === 'EADDRINUSE') {
    console.log('');
    console.log('[fatal] 端口 ' + config.port + ' 已被占用，服务无法启动。');
    console.log('        先查占用进程： netstat -ano | findstr :' + config.port);
    console.log('        再结束进程：   taskkill /PID <上面查到的PID> /F');
    console.log('        或换端口启动： set PORT=3001 && node server/index.js');
    console.log('');
  } else {
    console.log('[fatal] HTTP 服务启动失败: ' + (err.message || err));
  }
  process.exit(1);
});

// ============================================================
// 主流程
// ============================================================

console.log('');
console.log('=== 山海神话传 · 服务端启动中 ===');
console.log('[boot] 数据驱动: ' + driver.kind);

// pglite 首次启动要把 WASM 版 PostgreSQL 编译出来，本机实测约 45 秒；
// 之后每次约 2.4 秒。这里给出预期，避免误以为卡死。
if (config.useLocalDb) {
  console.log('[boot] 本地数据库加载中（首次启动约需 40-50 秒，之后约 2-3 秒）...');
}

driver.ready.then(function () {
  console.log('[boot] 数据层就绪');

  bootstrap(function (bootErr) {
    if (bootErr) {
      console.log('[fatal] 初始化失败: ' + bootErr.message);
      process.exit(1);
    }

    server.listen(config.port, config.host, function () {
      // 服务端权威对局循环：一个 20Hz 定时器驱动所有房间的对局。
      // 放在 listen 之后启动 —— 还没开始收连接就推进世界没有意义，
      // 而且万一端口被占（EADDRINUSE）流程会 process.exit，也不必白起一个定时器。
      matchRegistry.startLoop();

      printAddresses();
      // ★公开仓库后必须喊一嗓子：没有 SESSION_SECRET 时用的是**仓库里可见的占位串**，
      //   任何人拿到源码都能伪造任意账号的登录态（而自证 token 服务端无法吊销）。
      //   ★判断用「环境变量有没有设」而不是「值等不等于占位串」——
      //   后者会在别人改了个字面值稍有不同的时候漏报。
      //   ★只警告、**不退出**：这是朋友局/局域网工具，本地跑起来比强行拦住更重要；
      //   但输出要显眼（多次换行 + 明确后果），不能被日志淹没。
      if (!config.sessionSecretIsSet) {
        console.log('');
        console.log('  ⚠️  安全提醒：没有设置环境变量 SESSION_SECRET');
        console.log('     当前用的是**仓库里公开可见的占位密钥** —— 拿到源码的人可以伪造任意账号登录态。');
        console.log('     局域网自己玩无所谓；放到公网上请先设置：');
        console.log('       SESSION_SECRET=<32 位以上随机串>');
        console.log('');
      }
      console.log('[boot] 按 Ctrl+C 停止服务');
      console.log('');
    });
  });
}, function (readyErr) {
  console.log('[fatal] 数据层加载失败: ' + (readyErr && readyErr.message ? readyErr.message : readyErr));
  process.exit(1);
});

// 每小时清一次过期会话，避免 sessions 表长期膨胀
setInterval(function () {
  queries.cleanExpiredSessions(function (err) {
    if (err) console.log('[cron] 清理过期会话失败: ' + err.message);
  });
}, 3600 * 1000).unref();

// 候场室的「掉线席位超期回收」。每 5 秒扫一遍足够：宽限期以分钟计，
// 差几秒没有感知；而扫得太频繁只是白跑。
//
// 【为什么必须是定时器，不能靠「有人访问时顺便扫」】一间没人再碰的房间
// 大厅列表可能压根没人拉（页面都关了），那就永远清不掉 —— 既泄漏内存，
// 又会在下次有人拉列表时冒出一个点进去必然报「房间不存在」的僵尸房间。
setInterval(function () {
  manager.sweep();
}, 5000).unref();

// ============================================================
// 优雅退出
// ============================================================

let closing = false;

function shutdown(signal) {
  // 连续两次 Ctrl+C 直接强退，避免关不掉
  if (closing) {
    console.log('[exit] 强制退出');
    process.exit(0);
  }
  closing = true;
  console.log('');
  console.log('[exit] 收到 ' + signal + '，正在关闭...');

  // 先停对局循环，再断连接：反了的话最后几帧会因为 socket 已关而白算
  matchRegistry.stopLoop();
  hub.closeAll();
  server.close(function () {
    console.log('[exit] 已停止');
    process.exit(0);
  });

  // 兜底：3 秒内没关干净就硬退
  setTimeout(function () {
    console.log('[exit] 关闭超时，强制退出');
    process.exit(0);
  }, 3000).unref();
}

process.on('SIGINT', function () {
  shutdown('SIGINT');
});
process.on('SIGTERM', function () {
  shutdown('SIGTERM');
});

// 兜底：打印未捕获异常，避免进程静默死掉后查不到原因
process.on('uncaughtException', function (err) {
  console.log('[fatal] 未捕获异常: ' + (err && err.stack ? err.stack : err));
});
process.on('unhandledRejection', function (reason) {
  console.log('[fatal] 未处理的 Promise 拒绝: ' + (reason && reason.message ? reason.message : reason));
});
