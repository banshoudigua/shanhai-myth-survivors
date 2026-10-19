// tools/sessionui.js —— 浏览器端的「登录态不再自动退出」端到端回归
//
// 【为什么 HTTP 层验过了还要写这个】用户的原话是「登陆信息要**写入浏览器缓存**，
// 不要老是自动退出」—— 这件事的现场在浏览器里：
//   ① token 有没有真的落进 localStorage（而不是只活在内存/会话里）
//   ② 刷新页面会不会自动进大厅（而不是回到登录页）
//   ③ ★★ **服务端数据被清空 + 重启之后**，刷新还是不是登着的
// 前两条只有浏览器能验，第三条是用户报障的真正场景（发布沙箱会把数据库回滚）。
//
// 做法：整个脚本自带一个**临时服务实例**（临时端口 + 临时数据目录），
// 所以它可以放心地把库删掉再重启 —— 不碰项目里的 data/，也不碰 3000 端口那个常用实例。
//
// 用法：node tools/sessionui.js

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const APP_PORT = Number(process.env.SESSIONUI_PORT || 3568);
const BASE = 'http://127.0.0.1:' + APP_PORT;
const DATA_DIR = path.join(os.tmpdir(), 'vs_sessionui_pgdata');
const CDP_PORT = 9371;
const TMP = os.tmpdir().replace(/\\/g, '/');
const PROFILE = TMP + '/vs_sessionui_profile';
const { CHROME } = require('./env');

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0;
let fail = 0;
function ok(n, e) { pass += 1; console.log('  PASS  ' + n + (e ? '  (' + e + ')' : '')); }
function bad(n, d) { fail += 1; console.log('  FAIL  ' + n + '  ->  ' + d); }
function expect(n, c, d) { if (c) ok(n); else bad(n, d || '断言不成立'); }

const serverLog = [];

// ---------------- 临时服务实例 ----------------
function startServer(tag) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(APP_PORT),
        PGDATA_DIR: DATA_DIR,
        DEV_SHUTDOWN: '1',
        ROOM_KEEP: '12',
        NODE_OPTIONS: ''
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', function (b) {
      String(b).split('\n').forEach(function (l) { if (l.trim()) serverLog.push('[' + tag + '] ' + l.trim()); });
    });
    child.stderr.on('data', function (b) {
      String(b).split('\n').forEach(function (l) { if (l.trim()) serverLog.push('[' + tag + '] stderr: ' + l.trim()); });
    });

    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      fetch(BASE + '/api/health').then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok) { clearInterval(t); resolve(child); }
      }).catch(function () {
        if (tries > 60) { clearInterval(t); reject(new Error('临时服务起不来（' + tag + '）')); }
      });
    }, 500);
  });
}

async function stopServer(child) {
  if (!child) return;
  await fetch(BASE + '/api/shutdown', { method: 'POST' }).catch(function () { return null; });
  await new Promise(function (resolve) {
    const t = setTimeout(function () { resolve(); }, 6000);
    child.once('exit', function () { clearTimeout(t); resolve(); });
  });
  await sleep(400);
}

// ---------------- 无头浏览器 ----------------
function killByPort(port) {
  return new Promise(function (resolve) {
    const { execFile } = require('node:child_process');
    execFile('powershell', ['-NoProfile', '-Command',
      '$p = (Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue).OwningProcess; ' +
      'if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }'
    ], function () { resolve(); });
  });
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=1280,900', 'about:blank',
      '--no-proxy-server'                       // 测的是本地 127.0.0.1，绕开代理
    ];
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    child.on('error', reject);
    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume(); clearInterval(t); resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口没起来')); }
      });
    }, 400);
  });
}

function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        let id = 0;
        const pending = {};
        const errors = [];
        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () { delete pending[msgId]; rej(new Error('CDP 超时：' + method)); }, 20000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }
        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) { pending[msg.id](msg.result); delete pending[msg.id]; return; }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            errors.push('exception: ' + (d.text || ''));
          }
        });
        ws.addEventListener('open', function () {
          Promise.resolve().then(async function () {
            await send('Page.enable');
            await send('Runtime.enable');
            resolve({
              send: send,
              errors: errors,
              // ★本文件的量测**只能用同步表达式**（awaitPromise:false），
              //   写 async IIFE 会拿到一个 Promise 对象被序列化成 `{}`（静默空结果）。
              eval: async function (expr) {
                const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false });
                if (r && r.exceptionDetails) return null;
                return r && r.result ? r.result.value : null;
              }
            });
          });
        });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// 往输入框里填值 —— 必须派发 input 事件，否则 Vue 的 v-model 收不到
function fillJs(placeholder, value) {
  return '(function(){' +
    'var el = document.querySelector(\'input[placeholder="' + placeholder + '"]\');' +
    'if (!el) return "no-input";' +
    'el.value = ' + JSON.stringify(value) + ';' +
    'el.dispatchEvent(new Event("input", { bubbles: true }));' +
    'return "ok"; })()';
}

// 按文字点按钮
function clickJs(selector, text) {
  return '(function(){' +
    'var list = Array.prototype.slice.call(document.querySelectorAll("' + selector + '"));' +
    'var hit = list.filter(function(b){ return (b.innerText||"").replace(/\\s+/g,"").indexOf("' + text + '") >= 0; })[0];' +
    'if (!hit) return "no-btn:" + list.length;' +
    'hit.click(); return "ok"; })()';
}

// ============================================================

async function main() {
  console.log('=== 登录态端到端（浏览器）  临时实例 ' + BASE + ' ===');
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  let server = await startServer('A');
  console.log('  临时服务已启动（A，空库）');

  await killByPort(CDP_PORT);
  const chrome = await launchChrome();
  const A = await connect();
  const send = A.send;
  const evalJS = A.eval;

  await send('Page.startScreencast', { format: 'jpeg', quality: 30, everyNthFrame: 2 });
  await send('Page.navigate', { url: BASE + '/?debug=1&_t=' + Date.now() });
  await sleep(2600);

  // 清掉可能残留的本地登录态，从「没登录」开始（这才是新用户的现场）
  await evalJS('(function(){ try { localStorage.removeItem("vs_token"); localStorage.removeItem("vs_profile"); } catch(e){} return 1; })()');
  await send('Page.navigate', { url: BASE + '/?debug=1&_t=' + Date.now() });
  await sleep(2600);

  const boot = await evalJS('(function(){' +
    'return { view: window.VS_LOBBY ? window.VS_LOBBY.view : "(no handle)",' +
    '  token: (function(){ try { return localStorage.getItem("vs_token") || ""; } catch(e){ return "err"; } })() }; })()');
  console.log('  起始状态：' + JSON.stringify(boot));
  expect('干净浏览器进来停在登录页（前提成立）', boot && boot.view === 'auth', JSON.stringify(boot));

  // ---------- [1] 注册 → token 落进 localStorage ----------
  console.log('\n--- [1] 注册并写入浏览器缓存 ---');
  const uname = 'uitest' + Math.floor(Math.random() * 10000);
  await evalJS(clickJs('.tab', '注册'));
  await sleep(300);
  // ★placeholder 必须按**注册表单**的写：注册页的用户名输入框是「登录时使用」，
  //   「请输入用户名」是登录表单的 —— 第一版混用，用户名填了个空，提交被表单校验挡下，
  //   表现却是「点完没反应」，白查一轮。所以下面把每次填充的返回值也**断言**上。
  const fills = [
    await evalJS(fillJs('登录时使用', uname)),
    await evalJS(fillJs('队友看到的名字', '界面哥')),
    await evalJS(fillJs('请输入密码', 'test123456')),
    await evalJS(fillJs('再输一次', 'test123456'))
  ];
  await sleep(200);
  expect('注册表单四个输入框都填进去了（填不进去后面全是假红）',
    fills.every(function (x) { return x === 'ok'; }), JSON.stringify(fills));
  // ★提交按钮的文字是「注册并进入」，而**页签**上写的是「注册」—— 只按文字找会点到页签去
  //   （第一版就是这么白跑一轮的：点完什么也没发生）。所以选择器要带类名。
  const clickedReg = await evalJS(clickJs('.btn-block.btn-primary', '注册并进入'));
  console.log('  点注册：' + clickedReg);
  await sleep(1800);

  const afterReg = await evalJS('(function(){' +
    'var t = ""; try { t = localStorage.getItem("vs_token") || ""; } catch(e){ t = "err"; }' +
    'return { token: t, head: t.slice(0, 4), view: window.VS_LOBBY ? window.VS_LOBBY.view : "",' +
    '  nick: window.VS_LOBBY ? window.VS_LOBBY.nick : "",' +
    '  loggedIn: window.VS_LOBBY ? (!window.VS_LOBBY.isGuest && !!window.VS_LOBBY.userId) : false }; })()');
  console.log('  注册后：' + JSON.stringify({ head: afterReg && afterReg.head, view: afterReg && afterReg.view, nick: afterReg && afterReg.nick }));
  expect('★注册后 token 真的写进了 localStorage（浏览器缓存）',
    !!(afterReg && afterReg.token && afterReg.token.length > 40), JSON.stringify(afterReg && afterReg.head));
  expect('★写进去的是自证式 token（vs1. 前缀）',
    !!(afterReg && afterReg.head === 'vs1.'), JSON.stringify(afterReg && afterReg.head));
  expect('注册后进入大厅且是账号身份',
    !!(afterReg && afterReg.view === 'lobby' && afterReg.loggedIn), JSON.stringify(afterReg));

  // ---------- [2] 刷新页面：自动进大厅，不回登录页 ----------
  console.log('\n--- [2] 刷新页面（登录态要自己回来）---');
  await send('Page.navigate', { url: BASE + '/?debug=1&_t=' + Date.now() });
  await sleep(2800);
  const afterReload = await evalJS('(function(){' +
    'return { view: window.VS_LOBBY ? window.VS_LOBBY.view : "",' +
    '  nick: window.VS_LOBBY ? window.VS_LOBBY.nick : "",' +
    '  ws: window.VS_LOBBY ? window.VS_LOBBY.wsState : "" }; })()');
  console.log('  刷新后：' + JSON.stringify(afterReload));
  expect('★刷新后自动进大厅（没有停在登录页）',
    !!(afterReload && afterReload.view === 'lobby'), JSON.stringify(afterReload));
  expect('★而且昵称是对的（登录态接回来了，不是空的游客）',
    !!(afterReload && afterReload.nick === '界面哥'), JSON.stringify(afterReload));

  // ---------- [3] ★★ 清空服务端数据 + 重启 → 刷新仍然是登着的 ----------
  // 这就是用户报障的真实场景：我发布一次 = 线上数据库被回滚一次。
  console.log('\n--- [3] 清空服务端数据库并重启（模拟重新发布）---');
  await stopServer(server);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('  已删掉整个数据目录：' + DATA_DIR);
  server = await startServer('B');
  console.log('  临时服务已重启（B，空库）');

  await send('Page.navigate', { url: BASE + '/?debug=1&_t=' + Date.now() });
  await sleep(3200);
  const afterWipe = await evalJS('(function(){' +
    'return { view: window.VS_LOBBY ? window.VS_LOBBY.view : "",' +
    '  nick: window.VS_LOBBY ? window.VS_LOBBY.nick : "",' +
    '  uid: window.VS_LOBBY ? window.VS_LOBBY.userId : 0,' +
    '  notice: (document.querySelector(".msg")||{}).innerText || "",' +
    '  token: (function(){ try { return (localStorage.getItem("vs_token")||"").slice(0,4); } catch(e){ return "err"; } })() }; })()');
  console.log('  清库重启后：' + JSON.stringify(afterWipe));
  expect('★★服务端数据被清空并重启后，刷新**仍然是登着的**（用户要的就是这条）',
    !!(afterWipe && afterWipe.view === 'lobby'), JSON.stringify(afterWipe));
  expect('★身份也对（昵称没丢、userId 还在）',
    !!(afterWipe && afterWipe.nick === '界面哥' && afterWipe.uid), JSON.stringify(afterWipe));
  expect('★没有弹出「登录状态已失效」那种提示',
    !!(afterWipe && afterWipe.notice.indexOf('失效') < 0), JSON.stringify(afterWipe && afterWipe.notice));
  expect('账号确实是被服务端按 token 重建的（日志取证）',
    serverLog.some(function (l) { return l.indexOf('账号已按 token 自证重建') >= 0; }),
    serverLog.filter(function (l) { return l.indexOf('[auth]') >= 0; }).slice(-2).join(' | '));

  // ---------- [4] 设置新密码（重建之后必须还能设密码）----------
  console.log('\n--- [4] 设置新密码 ---');
  await sleep(600);
  const pwdBtn = await evalJS(clickJs('.pwd-block button', '设置新密码'));
  console.log('  点「设置新密码」：' + pwdBtn);
  await sleep(400);
  const pwdFormShown = await evalJS('(function(){ return !!document.querySelector(\'input[placeholder="新密码"]\'); })()');
  expect('★账号用户能看到「设置新密码」入口', pwdBtn === 'ok' && pwdFormShown === true,
    JSON.stringify({ btn: pwdBtn, form: pwdFormShown }));

  await evalJS(fillJs('新密码', 'brandnew777'));
  await evalJS(fillJs('再输一次', 'brandnew777'));
  await sleep(200);
  const saved = await evalJS(clickJs('.pwd-actions button', '保存'));
  await sleep(1500);
  const pwdMsg = await evalJS('(function(){ return (document.querySelector(".msg")||{}).innerText || ""; })()');
  console.log('  保存结果：' + JSON.stringify({ clicked: saved, msg: pwdMsg }));
  expect('★新密码保存成功并给出反馈', saved === 'ok' && pwdMsg.indexOf('生效') >= 0, JSON.stringify(pwdMsg));

  // ---------- [5] 退出后用新密码登录 ----------
  console.log('\n--- [5] 退出 → 用新密码重新登录 ---');
  await evalJS(clickJs('.btn.btn-sm', '退出'));
  await sleep(1200);
  const loggedOut = await evalJS('(function(){' +
    'var t = ""; try { t = localStorage.getItem("vs_token") || ""; } catch(e){}' +
    'return { view: window.VS_LOBBY ? window.VS_LOBBY.view : "", token: t }; })()');
  expect('★点「退出」会清掉本地 token 并回到登录页',
    !!(loggedOut && loggedOut.view === 'auth' && !loggedOut.token), JSON.stringify(loggedOut));

  await evalJS(fillJs('请输入用户名', uname));
  await evalJS(fillJs('请输入密码', 'brandnew777'));
  await sleep(200);
  const relogin = await evalJS(clickJs('.btn-block.btn-primary', '登录'));
  await sleep(1800);
  const backIn = await evalJS('(function(){' +
    'return { view: window.VS_LOBBY ? window.VS_LOBBY.view : "", nick: window.VS_LOBBY ? window.VS_LOBBY.nick : "" }; })()');
  console.log('  重新登录：' + JSON.stringify({ clicked: relogin, state: backIn }));
  expect('★★用重设后的新密码能登录成功（账号没被「重建」这件事锁死）',
    !!(backIn && backIn.view === 'lobby' && backIn.nick === '界面哥'), JSON.stringify(backIn));

  const errs = A.errors.filter(function (e) { return e && e.indexOf('favicon') < 0; });
  expect('页面零 JS 异常', errs.length === 0, errs.slice(0, 2).join(' || '));

  // 收尾
  try { await send('Page.stopScreencast'); } catch (e) { /* 收尾失败无所谓 */ }
  await stopServer(server);
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });
  try { chrome.kill(); } catch (e) { /* 收尾失败无所谓 */ }
  await killByPort(CDP_PORT);

  console.log('\n=== 汇总 ===');
  console.log('  PASS  ' + pass);
  console.log('  FAIL  ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack ? e.stack : e));
  console.log('--- 服务端日志（最后 15 行）---');
  console.log(serverLog.slice(-15).join('\n'));
  process.exit(2);
});
