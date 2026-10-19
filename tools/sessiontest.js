// tools/sessiontest.js —— 「登录态不再被服务端清库踢掉」回归测试
//
// 【为什么必须有这个脚本】用户报障是「登陆信息要写入浏览器缓存，不要老是自动退出」。
// 根因不在浏览器：线上跑在 WorkBuddy「发布为应用」沙箱里，而沙箱**数据不持久** ——
// 每次重新部署，data/ 都会回滚到上传时的快照，线上注册的账号与会话全没。
// 于是「会话存数据库」这条路的必然结果就是：我发布一次，用户被踢一次。
//
// 修法是让会话 token **脱离数据库自证**（见 server/api/auth.js 的自证式 token）。
// 而这条性质没法靠「看一眼代码」证明，必须**真把库清掉再重启**跑一遍：
//   · 库没了 → 同一枚 token 还要能登进来（这是用户要的「不再自动退出」）
//   · 库没了 → 账号要能按 token 原样重建，并且**占住用户名**（别人抢不走）
//   · 同名被别人先注册 → 旧 token 必须被**拒绝**（绝不能把别人的账号交出去）
//
// 做法：起一个**临时数据目录 + 临时端口**的服务实例，清库、重启，全程用 HTTP 验。
// 不碰项目里的 data/，也不碰 3000 端口那个常用实例。
//
// 用法：node tools/sessiontest.js        （自己拉起临时服务，用完自己关）

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.SESSIONTEST_PORT || 3567);
const BASE = 'http://127.0.0.1:' + PORT;
const DATA_DIR = path.join(os.tmpdir(), 'vs_sessiontest_pgdata');

// 与服务端同一份密钥配置：用来重签「过期 / 篡改」的 token 做反向验证
const config = require('../server/config.js');

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0;
let fail = 0;
function ok(n, e) { pass += 1; console.log('  PASS  ' + n + (e ? '  (' + e + ')' : '')); }
function bad(n, d) { fail += 1; console.log('  FAIL  ' + n + '  ->  ' + d); }
function expect(n, c, d) { if (c) ok(n); else bad(n, d || '断言不成立'); }

const serverLog = [];

function startServer(tag) {
  return new Promise(function (resolve, reject) {
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        PORT: String(PORT),
        PGDATA_DIR: DATA_DIR,
        DEV_SHUTDOWN: '1',        // 允许 /api/shutdown 优雅停机（pglite 不能被硬杀）
        ROOM_KEEP: '12',
        NODE_OPTIONS: ''          // 本机 NODE_OPTIONS 带 --use-system-ca，托管 Node 不认
      }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', function (b) {
      String(b).split('\n').forEach(function (line) { if (line.trim()) serverLog.push('[' + tag + '] ' + line.trim()); });
    });
    child.stderr.on('data', function (b) {
      String(b).split('\n').forEach(function (line) { if (line.trim()) serverLog.push('[' + tag + '] stderr: ' + line.trim()); });
    });

    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      fetch(BASE + '/api/health').then(function (r) { return r.json(); }).then(function (j) {
        if (j && j.ok) { clearInterval(t); resolve(child); }
      }).catch(function () {
        if (tries > 60) { clearInterval(t); reject(new Error('服务起不来（' + tag + '）')); }
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

async function post(pathname, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-VS-Token'] = token;
  const r = await fetch(BASE + pathname, { method: 'POST', headers: headers, body: JSON.stringify(body || {}) });
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json: json };
}

async function get(pathname, token) {
  const headers = {};
  if (token) headers['X-VS-Token'] = token;
  const r = await fetch(BASE + pathname, { headers: headers });
  let json = null;
  try { json = await r.json(); } catch (e) { json = null; }
  return { status: r.status, json: json };
}

// 解开 token 的 payload（客户端也能做这件事：token 是 base64 明文 + 签名，不是加密）
function payloadOf(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

// 用同一个密钥重签一枚 token（用于构造「过期」「篡改」两种坏凭证）
function resign(claims) {
  const crypto = require('node:crypto');
  const b64 = function (s) {
    return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const body = b64(JSON.stringify(claims));
  const sig = b64(crypto.createHmac('sha256', config.sessionSecret).update(body).digest());
  return 'vs1.' + body + '.' + sig;
}

// ============================================================

async function main() {
  console.log('=== 登录态持久性回归（自证式 token）  临时实例 ' + BASE + ' ===');
  console.log('  临时数据目录：' + DATA_DIR + '\n');

  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  let child = await startServer('A');
  console.log('  临时服务已启动（A）\n');

  // ---------- [1] 注册拿到的是自证式 token ----------
  console.log('--- [1] 注册与 token 形态 ---');
  const uname = 'sessionpg' + Math.floor(Math.random() * 1000);
  const reg = await post('/api/register', { username: uname, nickname: '持久哥', password: 'test123456' });
  expect('注册成功', !!(reg.json && reg.json.ok), JSON.stringify(reg.json));
  const tokenA = reg.json && reg.json.token;
  const claimsA = payloadOf(tokenA);
  expect('★token 是自证式（vs1. 前缀 + 三段）',
    typeof tokenA === 'string' && tokenA.split('.').length === 3 && tokenA.indexOf('vs1.') === 0,
    String(tokenA).slice(0, 24) + '…');
  expect('★token 里带着身份（用户名 / 账号密钥 / 过期时间）',
    !!(claimsA && claimsA.u === uname && claimsA.k && typeof claimsA.e === 'number'),
    JSON.stringify(claimsA && { u: claimsA.u, k: String(claimsA.k).slice(0, 6) + '…', e: claimsA.e }));

  const me1 = await get('/api/me', tokenA);
  expect('拿这枚 token 取个人数据通过', me1.status === 200 && me1.json && me1.json.ok,
    'status=' + me1.status + ' ' + JSON.stringify(me1.json && me1.json.msg));
  const idA = me1.json && me1.json.user && me1.json.user.id;

  // ---------- [2] 坏凭证必须被拒（反向验证的两条）----------
  console.log('\n--- [2] 坏凭证 ---');
  const expired = await get('/api/me', resign(Object.assign({}, claimsA, { e: Date.now() - 1000 })));
  expect('★过期的 token 被拒（401）', expired.status === 401, 'status=' + expired.status);

  const tampered = String(tokenA).slice(0, -3) + 'aaa';
  const bad2 = await get('/api/me', tampered);
  expect('★签名被篡改的 token 被拒（401）', bad2.status === 401, 'status=' + bad2.status);

  const forged = resign({ u: uname, k: 'deadbeef', n: '冒名者', e: Date.now() + 86400000 });
  const bad3 = await get('/api/me', forged);
  expect('★密钥对不上的 token 被拒（同名也不放过）', bad3.status === 401, 'status=' + bad3.status);

  // ---------- [3] ★★ 清库 + 重启：登录态必须活下来 ----------
  console.log('\n--- [3] 清空数据库并重启（模拟发布沙箱回滚）---');
  await stopServer(child);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log('  已删掉整个数据目录：' + DATA_DIR);
  child = await startServer('B');
  console.log('  临时服务已重启（B，空库）\n');

  const me2 = await get('/api/me', tokenA);
  expect('★★清库重启后，同一枚 token 仍然有效（这就是「不再自动退出」）',
    me2.status === 200 && !!(me2.json && me2.json.ok),
    'status=' + me2.status + ' ' + JSON.stringify(me2.json && me2.json.msg));
  expect('★而且身份是对的（用户名 / 昵称都没变）',
    !!(me2.json && me2.json.user && me2.json.user.username === uname && me2.json.user.nickname === '持久哥'),
    JSON.stringify(me2.json && me2.json.user));
  expect('★账号是按 token 重建的（服务端日志里能直接看到）',
    serverLog.some(function (l) { return l.indexOf('账号已按 token 自证重建') >= 0; }),
    serverLog.filter(function (l) { return l.indexOf('[auth]') >= 0; }).slice(-3).join(' | '));

  // 重建之后用户名必须被占住（否则别人能把它抢走，旧 token 就落到别人账号上了）
  const again = await post('/api/register', { username: uname, nickname: '抢注的', password: 'test123456' });
  expect('★重建之后同一个用户名已被占住（别人抢不走）',
    !!(again.json && !again.json.ok && again.json.code === 'USERNAME_TAKEN'),
    JSON.stringify(again.json));

  // ---------- [4] 重建后能重设密码，并用新密码登录 ----------
  console.log('\n--- [4] 重建之后的密码出口 ---');
  const setPwd = await post('/api/password', { password: 'newpass888' }, tokenA);
  expect('★凭 token 能设置新密码（不需要旧密码）',
    setPwd.status === 200 && !!(setPwd.json && setPwd.json.ok), JSON.stringify(setPwd.json));

  const login = await post('/api/login', { username: uname, password: 'newpass888' });
  expect('★★用新密码能正常登录（账号没被重建这件事锁死）',
    !!(login.json && login.json.ok), JSON.stringify(login.json));

  const oldPwd = await post('/api/login', { username: uname, password: 'test123456' });
  expect('重建前的旧密码不再有效（哈希是重建时随机写的，谁都不知道）',
    !!(oldPwd.json && !oldPwd.json.ok), JSON.stringify(oldPwd.json));

  // ---------- [5] ★ 同名被别人先注册时，旧 token 必须被拒 ----------
  // 这是「自证式 token 会不会交出别人的账号」这条安全底线。
  console.log('\n--- [5] 同名被别人先注册（安全底线）---');
  await stopServer(child);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  child = await startServer('C');

  const steal = await post('/api/register', { username: uname, nickname: '新主人', password: 'other99999' });
  expect('模拟场景：清库后另一个人用同一个用户名先注册成功',
    !!(steal.json && steal.json.ok), JSON.stringify(steal.json));

  const mine = await get('/api/me', tokenA);
  expect('★★旧 token 被拒绝（绝不把同名别人的账号交出来）',
    mine.status === 401, 'status=' + mine.status + ' ' + JSON.stringify(mine.json && mine.json.user));
  expect('★它自己的账号仍然正常（用新密码能登录）',
    !!(await post('/api/login', { username: uname, password: 'other99999' })).json.ok);

  // ---------- [6] 老式凭证仍能用（浏览器里可能还留着旧的）----------
  // /api/diag/clock 的自检会现场插一条 64 位 hex 的 sessions 行再走一遍 verifyToken，
  // 它通过就说明「查库」那条老路没被这轮改动弄坏。
  console.log('\n--- [6] 老式子 token 的兼容性 ---');
  const diag = await get('/api/diag/clock');
  // ★注意字段层级：这个接口回的是 `{ ok, diag: { ... } }`（第一版按顶层读，白报两条 FAIL）
  const dOut = diag.json && diag.json.diag;
  expect('老式「64 位随机串 + sessions 表」那条路仍然可用（不是一次性全废）',
    !!(dOut && dOut.selfTestVerifyOk === true),
    JSON.stringify(dOut && { mode: dOut.tokenMode, ok: dOut.selfTestVerifyOk, err: dOut.selfTestVerifyErr }));
  expect('诊断接口标出了当前会话形态（线上排查先看这一行）',
    !!(dOut && dOut.tokenMode), JSON.stringify(dOut && dOut.tokenMode));

  // ---------- [7] 如实钉住一个已知代价 ----------
  // 自证式 token 在服务端**无法吊销**：退出登录只清浏览器本地。
  // 这条不是 bug，是有意的取舍（要吊销就得回到「查库」，而那条路在无持久化沙箱里必然掉线），
  // 但必须写成断言 —— 免得以后有人以为「点了退出，服务端就收回了」。
  console.log('\n--- [7] 已知代价（写下来，不是 bug）---');
  const tA2 = (await post('/api/login', { username: uname, password: 'other99999' })).json.token;
  await post('/api/logout', {}, tA2);
  const afterLogout = await get('/api/me', tA2);
  expect('★（已知取舍）退出登录只清浏览器本地；服务端这枚 token 本身仍然有效',
    afterLogout.status === 200, 'status=' + afterLogout.status + '（要能吊销就得回到查库，而沙箱会清库）');

  await stopServer(child);
  if (fs.existsSync(DATA_DIR)) fs.rmSync(DATA_DIR, { recursive: true, force: true });

  console.log('\n=== 汇总 ===');
  console.log('  PASS  ' + pass);
  console.log('  FAIL  ' + fail);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.log('脚本异常：' + (e && e.stack ? e.stack : e));
  console.log('--- 服务端日志（最后 20 行）---');
  console.log(serverLog.slice(-20).join('\n'));
  process.exit(2);
});
