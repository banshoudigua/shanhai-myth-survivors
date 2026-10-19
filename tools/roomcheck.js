// tools/roomcheck.js —— P2-3 房间界面端到端实测（真实浏览器 + 真实 WebSocket）
//
// 为什么必须有这个脚本，而不是只靠 matchtest/nettest：
//   matchtest 是纯逻辑（不起服务器），nettest 是裸 WS 客户端（不渲染界面）。
//   它们都验证不了「Vue 模板字段名写错」这类问题 —— 而 Vue 模板里引用了
//   data 中不存在的字段时**不报错、只静默显示空白**，读代码根本看不出来。
//
// 覆盖链路：
//   游客进大厅 → 大厅看到「联机房间」卡片 → 甲建房 → 进入候场室（房间号/成员/角色）
//   → 乙在大厅列表里看到这桌 → 点「加入」→ 甲那边人数实时变 2
//   → 乙点「准备」→ 甲看到「已准备」→ 房主点「开始对局」→ 两人都跳到 game.html?room=XXX
//
// 用法：node tools/roomcheck.js [端口]
// 依赖：先启动 server/index.js；无头浏览器路径见 CHROME

const fs = require('node:fs');
const { spawn } = require('node:child_process');

const APP_PORT = Number(process.argv[2] || 3000);
const CDP_PORT = 9334;                  // 别用 9333（gamecheck 占了）、更别用 9222（WorkBuddy 自己的）
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_roomcheck_profile';
const SHOT = TMP + '/vs_roomcheck.png';
const LOBBY_SHOT = TMP + '/vs_roomcheck_lobby.png';   // 候场室那一屏
const MENU_SHOT = TMP + '/vs_roomcheck_menu.png';     // 联机菜单那一屏（不是「已暂停」）
const LEVELUP_SHOT = TMP + '/vs_roomcheck_levelup.png'; // 联机升级面板那一屏（不能盖住战场）
const LOG = TMP + '/vs_roomcheck.log';


// 日志同时落盘：脚本被超时杀掉时 stdout 缓冲会丢，只有写文件才看得到卡在哪一步
fs.writeFileSync(LOG, '');
function log() {
  const s = Array.prototype.map.call(arguments, function (a) {
    return typeof a === 'string' ? a : JSON.stringify(a);
  }).join(' ');
  fs.appendFileSync(LOG, s + '\n');
  console.log(s);
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

let pass = 0;
let fail = 0;
function expect(name, cond, detail) {
  if (cond) { pass += 1; log('  PASS  ' + name); }
  else { fail += 1; log('  FAIL  ' + name + '  ->  ' + (detail === undefined ? '断言不成立' : detail)); }
}

// ============================================================
// 无头浏览器
// ============================================================

function killByPort(port) {
  return new Promise(function (resolve) {
    require('node:child_process').execFile('powershell', ['-NoProfile', '-Command',
      '$p = (Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue).OwningProcess; ' +
      'if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }'
    ], function () { resolve(); });
  });
}

function launchChrome() {
  return new Promise(function (resolve, reject) {
    const args = [
      '--disable-gpu',
      '--no-sandbox',
      '--no-proxy-server',              // 本机常驻代理会污染本地请求
      '--no-first-run',
      '--hide-scrollbars',
      '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT,
      '--remote-allow-origins=*',       // 缺这个 CDP 的 WS 握手直接 403
      '--window-size=1280,860',
      'about:blank'
    ];
    const child = spawn(CHROME, args, { stdio: 'ignore' });
    child.on('error', reject);

    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume();
        clearInterval(t);
        resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口 ' + CDP_PORT + ' 20 秒内没起来')); }
      });
    }, 500);
  });
}

// ============================================================
// CDP 会话
// ============================================================

function connect(tag) {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) {
      if (!tab || !tab.webSocketDebuggerUrl) throw new Error('新建标签页失败：' + JSON.stringify(tab));
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        let id = 0;
        const pending = {};
        const pageErrors = [];
        const consoleLogs = [];

        function send(method, params) {
          return new Promise(function (res, rej) {
            const msgId = ++id;
            const timer = setTimeout(function () {
              delete pending[msgId];
              rej(new Error('CDP 命令超时：' + method));
            }, 10000);
            pending[msgId] = function (r) { clearTimeout(timer); res(r); };
            ws.send(JSON.stringify({ id: msgId, method: method, params: params || {} }));
          });
        }

        ws.addEventListener('message', function (ev) {
          const msg = JSON.parse(ev.data);
          if (msg.id && pending[msg.id]) {
            pending[msg.id](msg.result);
            delete pending[msg.id];
            return;
          }
          // alert/confirm 会阻塞主线程，让后续 evaluate 永挂，必须自动点掉
          if (msg.method === 'Page.javascriptDialogOpening') {
            log('！！页面弹了对话框：' + JSON.stringify(msg.params));
            send('Page.handleJavaScriptDialog', { accept: true });
            return;
          }
          // 页面控制台必须收：Vue 的模板渲染报错是 console.error 而不是未捕获异常，
          // 只看 exceptionThrown 会把「视图静默不更新」这类问题漏得干干净净
          if (msg.method === 'Runtime.consoleAPICalled') {
            const text = (msg.params.args || []).map(function (a) {
              return a.value !== undefined ? String(a.value) : (a.description || a.type);
            }).join(' ');
            consoleLogs.push(msg.params.type + ': ' + text);
            return;
          }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            pageErrors.push('exception: ' + (d.text || '') + ' ' +
              ((d.exception && d.exception.description) || ''));
            return;
          }
          if (msg.method === 'Log.entryAdded') {
            const e = msg.params.entry || {};
            if (e.level === 'error') pageErrors.push('log: ' + (e.text || '') + ' ' + (e.url || ''));
          }
        });

        ws.addEventListener('open', async function () {
          await send('Page.enable');
          await send('Runtime.enable');
          await send('Log.enable');
          resolve({
            tag: tag,
            send: send,
            pageErrors: pageErrors,
            consoleLogs: consoleLogs,
            // 执行页面内 JS 并把结果按值取回来
            eval: async function (expr) {
              const r = await send('Runtime.evaluate', {
                expression: expr,
                returnByValue: true,
                awaitPromise: false
              });
              if (r && r.exceptionDetails) {
                pageErrors.push('eval 异常: ' + JSON.stringify(r.exceptionDetails.text || ''));
                return null;
              }
              return r && r.result ? r.result.value : null;
            }
          });
        });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// ============================================================
// 页面内脚本片段
// ============================================================

// 点一个按文本精确匹配的按钮
function clickByText(text, exact) {
  return '(function(){' +
    'var list = Array.prototype.slice.call(document.querySelectorAll("button"));' +
    'var hit = list.filter(function(b){ var t=(b.innerText||"").trim();' +
    '  return ' + (exact ? 't === ' + JSON.stringify(text) : 't.indexOf(' + JSON.stringify(text) + ') === 0') + '; })[0];' +
    'if(!hit) return { ok:false, buttons: list.map(function(b){return (b.innerText||"").trim()}) };' +
    'hit.click();' +
    'return { ok:true };' +
    '})()';
}

// 抓取房间相关界面的当前状态（字段名必须与 index.html 里写的完全一致，
// 这里就是「渲染验证兜底」的关键：模板字段写错的话这些值会是空）
const STATE_EXPR = '(function(){' +
  'var R = {};' +
  'var app = document.getElementById("app");' +
  'R.cloak = app ? app.hasAttribute("v-cloak") : null;' +
  'R.rawTemplate = app ? app.innerText.indexOf("{{") >= 0 : null;' +
  'var titles = Array.prototype.slice.call(document.querySelectorAll(".card-title"));' +
  'R.hasRoomCard = titles.filter(function(h){ return (h.innerText||"").indexOf("联机房间") >= 0; }).length > 0;' +
  'R.hasCharCard = titles.filter(function(h){ return (h.innerText||"").indexOf("我的角色") >= 0; }).length > 0;' +
  // 大厅房间列表里的房间号
  'R.listCodes = Array.prototype.slice.call(document.querySelectorAll(".room-code")).map(function(e){ return (e.innerText||"").trim(); });' +
  // 候场室大号房间号
  'var big = document.querySelector(".room-code-big");' +
  'R.roomCode = big ? (big.innerText||"").trim() : null;' +
  // 候场成员行。用 .member-row 这个专属类名，不能图省事数 .row ——
  // 大厅的在线玩家列表也是 .row，会把那些人一起数进来，断言就全成了假的。
  'R.memberNames = Array.prototype.slice.call(document.querySelectorAll(".member-row")).map(function(e){ return (e.innerText||"").replace(/\\s+/g," ").trim(); });' +
  'R.memberRows = R.memberNames.length;' +
  // 连接状态文本（"已连接 3ms" / "连接中..." / "未连接"）
  'R.connText = (document.querySelector(".conn")||{}).innerText || "";' +
  'R.charBtns = Array.prototype.slice.call(document.querySelectorAll(".char-btn")).map(function(b){ return { name:(b.querySelector(".char-name")||{}).innerText, active:b.className.indexOf("active")>=0 }; });' +
  'R.buttons = Array.prototype.slice.call(document.querySelectorAll("button")).map(function(b){ return (b.innerText||"").trim(); });' +
  'R.disabledButtons = Array.prototype.slice.call(document.querySelectorAll("button:disabled")).map(function(b){ return (b.innerText||"").trim(); });' +
  'R.href = location.href;' +
  'R.notice = (document.querySelector(".msg")||{}).innerText || null;' +
  'return R;' +
  '})()';

async function state(cdp) { return await cdp.eval(STATE_EXPR); }

// 轮询等待一个条件成立
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  log('  （等待超时：' + label + '）');
  return null;
}

// 等 WebSocket 真的握手完成再动手。
// 【踩过，且被误诊过一次】`enterAsGuest` 之后「联机房间」卡片可能已经渲染出来，
// 但 WS 还在 connecting —— 此时点「创建房间」会被 lobby.js 的
// `if (this.wsState !== 'on') return this.notice$('err', ...)` 直接挡回去：
// **不报错、不打日志、只闪一条提示**，测试看到的现象是「点击成功了但房间没出现」。
// 本机 RTT 0.6ms 通常来得及，机器一忙就来不及 —— 于是表现为偶发失败。
// （此前两次失败都记成了「环境竞态、疑似无头浏览器没退干净」，其实根因就在这。）
async function waitConnected(cdp, label) {
  return await waitFor(async function () {
    const r = await state(cdp);
    return r && r.connText && r.connText.indexOf('已连接') >= 0 ? r : null;
  }, 10000, label + ' 的 WebSocket 握手完成');
}

// 进大厅：走游客通道（不依赖数据库里的账号，最省事）
async function enterAsGuest(cdp, nickname) {
  await cdp.eval('(function(){' +
    'var inp = document.querySelector("input[placeholder=\'给自己起个名字\']");' +
    'if (inp) { inp.value = ' + JSON.stringify(nickname) + '; inp.dispatchEvent(new Event("input", {bubbles:true})); }' +
    'return !!inp;' +
    '})()');
  await sleep(120);
  const r = await cdp.eval(clickByText('以游客身份进入', false));
  return r && r.ok;
}

// ============================================================
// 主流程
// ============================================================

async function main() {
  log('');
  log('=== P2-3 房间界面端到端实测（端口 ' + APP_PORT + '） ===');

  await killByPort(CDP_PORT);
  const chrome = await launchChrome();
  log('无头浏览器已就绪');

  const A = await connect('甲');
  const B = await connect('乙');

  // 带 debug=1：大厅跳游戏页时会把参数带上，那边才会挂 window.VS_GAME 调试句柄，
  // 我们才有办法从外面读到运行中的状态。
  const URL = 'http://127.0.0.1:' + APP_PORT + '/?debug=1';

  // ---------------- 甲：进大厅 ----------------
  //
  // 【为什么导航两次】大厅启动时会读 sessionStorage['vs_rejoin'] 并自动重进上一次的那间房，
  // 而这个脚本的浏览器 profile 是固定的、sessionStorage 跨运行留下。
  // 第一次导航是为了拿到正确的 origin（about:blank 上没有 sessionStorage），
  // 清掉残留后再导航一次，这次大厅就是干净的。
  //
  // 症状很像功能坏了：乙本该加入甲刚建的房，却被自动塞进**上一轮残留的那间**，
  // 于是「乙加入后进入同一间候场室」报两个不同的房间号，后面 11 条全跟着挂。
  // 为什么以前没暴露：本轮给候场室加了 90 秒宽限期（房主刷新页面房间不再当场销毁），
  // 残留房间比以前活得久，自动重进也就更容易撞上。
  // 凡是「跨运行留下 sessionStorage」的键，测试都要自己先清 —— 与 vs_diff 同一类问题。
  await A.send('Page.navigate', { url: URL });
  await sleep(600);
  await A.eval('(function(){ try { sessionStorage.removeItem("vs_rejoin"); sessionStorage.removeItem("vs_spec"); } catch(e){} return true; })()');
  await A.send('Page.navigate', { url: URL });

  const readyA = await waitFor(async function () {
    const r = await state(A);
    return r && r.cloak === false ? r : null;
  }, 12000, '甲页面渲染完成');
  if (!readyA) { expect('甲 页面渲染完成', false, '12 秒内没渲染出来'); }
  else { expect('甲 页面渲染完成（v-cloak 已摘）', true); }

  const okGuest = await enterAsGuest(A, '测试甲');
  expect('甲 能点「以游客身份进入」', okGuest, '按钮没找到');

  const lobbyA = await waitFor(async function () {
    const r = await state(A);
    return r && r.hasRoomCard ? r : null;
  }, 8000, '甲进入大厅');
  expect('甲 大厅出现「联机房间」卡片', !!lobbyA,
    lobbyA ? '' : JSON.stringify((await state(A)).buttons));
  if (lobbyA) {
    expect('甲 大厅无未渲染的 {{ }} 模板残留', lobbyA.rawTemplate === false, 'innerText 里还有 {{');
    expect('甲 空列表时房间数为 0', lobbyA.listCodes.length === 0, 'codes=' + JSON.stringify(lobbyA.listCodes));
  }

  // ---------------- 甲：建房 ----------------
  // 建房前必须确认 WS 已经 on，否则 this.wsState !== 'on' 会静默挡回（见 waitConnected 注释）
  const connA = await waitConnected(A, '甲');
  expect('甲 的 WebSocket 已握手完成（建房的前提）', !!connA,
    connA ? '' : 'connText=' + JSON.stringify((await state(A)).connText));

  // 再加一层重试：即使握了手，也可能碰上「点了但服务端没等到」这类抖动。
  // 每次重试前都重新看一眼有没有已经进候场室，避免真的建了两桌。
  let clickCreate = null;
  let roomA = null;
  for (let attempt = 1; attempt <= 3 && !roomA; attempt++) {
    clickCreate = await A.eval(clickByText('创建房间', false));
    roomA = await waitFor(async function () {
      const r = await state(A);
      return r && r.roomCode ? r : null;
    }, 4000, '甲进入候场室（第 ' + attempt + ' 次尝试）');
  }
  expect('甲 能点「创建房间」', clickCreate && clickCreate.ok, JSON.stringify(clickCreate));
  expect('甲 建房后进入候场室（显示房间号）', !!roomA,
    roomA ? '' : '3 次点击都没进候场室');

  // 失败了要把现场抓出来，不然只看到一句「没出现」根本没法查
  if (!roomA) {
    log('  [现场] 甲页面可见文本：' +
      (await A.eval('document.body.innerText.replace(/\\s+/g," ").slice(0,300)')));
    log('  [现场] 甲页面 console 最后 12 条：');
    A.consoleLogs.slice(-12).forEach(function (l) { log('         ' + l); });
  }

  let roomCode = '';
  if (roomA) {
    roomCode = roomA.roomCode;
    expect('房间号是 4 位无歧义字符', /^[A-HJ-NP-Z2-9]{4}$/.test(roomCode), 'code=' + roomCode);
    expect('候场室成员列表 1 行', roomA.memberRows === 1, 'rows=' + roomA.memberRows);
    expect('房主标记显示在甲身上', (roomA.memberNames[0] || '').indexOf('房主') >= 0,
      JSON.stringify(roomA.memberNames));
    expect('房主看到的是「开始对局」而不是「准备」',
      roomA.buttons.indexOf('开始对局') >= 0 && roomA.buttons.indexOf('准备') < 0,
      JSON.stringify(roomA.buttons));
    expect('单人房里「开始对局」可用（房主天然已准备）',
      roomA.disabledButtons.indexOf('开始对局') < 0,
      'disabled=' + JSON.stringify(roomA.disabledButtons));
    expect('候场室有「我的角色」区', roomA.hasCharCard === true, '没找到角色卡片');
    expect('游客只有 1 个可选角色', roomA.charBtns.length === 1, 'n=' + roomA.charBtns.length);
    // ★名字是**内容**（第十八轮把「猎魔人」改成了「刑天」）。这里不写死字串，
    //   改为**从页面里的真实数据表取** guestAllowed 角色的本名再比对 ——
    //   判的是「按钮文字 = 该显示的那位角色」，机制没变，判据也不会因改内容而假红。
    //   ★在页面里取而不是 require：这样顺带验证了 const.js 真的发到了浏览器。
    const guestCharName = await A.eval(`(function(){
      var cs = (window.VS && window.VS.CONST && window.VS.CONST.CHARACTERS) || [];
      for (var i = 0; i < cs.length; i++) { if (cs[i].guestAllowed) return cs[i].name; }
      return null;
    })()`);
    expect('默认角色是「游客可玩的那位」且已选中',
      roomA.charBtns.length === 1 && guestCharName &&
      roomA.charBtns[0].name === guestCharName && roomA.charBtns[0].active === true,
      JSON.stringify(roomA.charBtns) + ' vs 本名 ' + guestCharName);
  }

  // ---------------- 乙：进大厅，从列表里看到甲的房 ----------------
  // 同样要清两次导航（理由见甲那段）：乙的 profile 也是固定的，
  // 上一次跑完他可能停在上一轮那间房里。
  await B.send('Page.navigate', { url: URL });
  await sleep(600);
  await B.eval('(function(){ try { sessionStorage.removeItem("vs_rejoin"); sessionStorage.removeItem("vs_spec"); } catch(e){} return true; })()');
  await B.send('Page.navigate', { url: URL });
  await waitFor(async function () {
    const r = await state(B);
    return r && r.cloak === false ? r : null;
  }, 12000, '乙页面渲染完成');
  await enterAsGuest(B, '测试乙');
  // 同理：乙也要等握手完成，否则点「加入」同样会被静默挡回
  const connB = await waitConnected(B, '乙');
  expect('乙 的 WebSocket 已握手完成（加入的前提）', !!connB,
    connB ? '' : 'connText=' + JSON.stringify((await state(B)).connText));

  const lobbyB = await waitFor(async function () {
    const r = await state(B);
    return r && r.hasRoomCard && r.listCodes.length > 0 ? r : null;
  }, 9000, '乙在大厅看到甲的房');
  expect('乙 大厅房间列表能看到甲建的房', !!lobbyB && lobbyB.listCodes.indexOf(roomCode) >= 0,
    lobbyB ? JSON.stringify(lobbyB.listCodes) : '列表为空');

  // ---------------- 乙：点「加入」 ----------------
  // 【为什么必须按房号精确定位，而不是点第一个「加入」】大厅列表里可能有**别的桌子** ——
  // 同一台服务器上刚跑过 spectest / seatkeeptest 之类的脚本，它们建的房在宽限期内
  // 还挂在列表里（候场室保座是上一轮加的，房间比以前活得久得多）。
  // 点第一个「加入」就会进到别人那桌，于是「乙加入后进入同一间候场室」报出两个房号，
  // 后面 11 条断言全跟着挂 —— 看着像功能坏了，其实只是**点错了桌**。
  // 真人不会点错（他会看房号再点），所以这是脚本的健壮性问题，不是产品问题。
  function clickJoinByCode(code) {
    return '(function(){' +
      'var want = ' + JSON.stringify(code) + ';' +
      'var rows = Array.prototype.slice.call(document.querySelectorAll(".row"));' +
      'var seen = [];' +
      'for (var i = 0; i < rows.length; i++) {' +
      '  var el = rows[i].querySelector(".room-code");' +
      '  var c = el ? String(el.innerText || "").trim().toUpperCase() : "";' +
      '  if (c) seen.push(c);' +
      '  if (c !== want) continue;' +
      '  var btns = Array.prototype.slice.call(rows[i].querySelectorAll("button"));' +
      '  for (var k = 0; k < btns.length; k++) {' +
      '    if (String(btns[k].innerText || "").indexOf("加入") >= 0) {' +
      '      btns[k].click();' +
      '      return { ok: true, code: want };' +
      '    }' +
      '  }' +
      '  return { ok: false, why: "该行没有「加入」按钮", row: String(rows[i].innerText || "") };' +
      '}' +
      'return { ok: false, why: "列表里找不到 " + want, seen: seen };' +
      '})()';
  }

  // 与建房同样加一层重试（握了手也可能撞上抖动）
  let clickJoin = null;
  let roomB = null;
  for (let attempt = 1; attempt <= 3 && !roomB; attempt++) {
    if (lobbyB || attempt > 1) {
      clickJoin = await B.eval(clickJoinByCode(roomCode));
      if (!clickJoin || !clickJoin.ok) {
        console.log('   [诊断] 第 ' + attempt + ' 次点「加入」未成功：' +
          JSON.stringify(clickJoin) + '（乙当前房号 ' + (await state(B)).roomCode + '）');
      }
    }
    roomB = await waitFor(async function () {
      const r = await state(B);
      return r && r.roomCode ? r : null;
    }, 4000, '乙进入候场室（第 ' + attempt + ' 次尝试）');
  }
  expect('乙 能点列表里那间房的「加入」', clickJoin && clickJoin.ok, JSON.stringify(clickJoin));
  expect('乙 加入后进入同一间候场室', !!roomB && roomB.roomCode === roomCode,
    roomB ? roomB.roomCode + ' vs ' + roomCode : '没进候场室');

  // ---------------- 甲：实时看到乙（room_update 双向） ----------------
  const roomA2 = await waitFor(async function () {
    const r = await state(A);
    return r && r.memberRows === 2 ? r : null;
  }, 6000, '甲看到人数变 2');
  expect('甲 实时看到乙加入（人数 2）', !!roomA2,
    roomA2 ? '' : '甲那边还是 ' + (await state(A)).memberRows + ' 行');
  if (roomA2) {
    expect('甲的成员列表里有乙的昵称',
      roomA2.memberNames.join('|').indexOf('测试乙') >= 0,
      JSON.stringify(roomA2.memberNames));
    expect('甲 现在看到乙「未准备」',
      roomA2.memberNames.join('|').indexOf('未准备') >= 0,
      JSON.stringify(roomA2.memberNames));
    // 房主按钮的文案是跟着状态变的：能发车时叫「开始对局」，不能时叫「等待全员准备」，
    // 所以不能只查 disabled 列表，得先确认文案确实切到了「等待…」
    expect('有人没准备时房主按钮变成「等待全员准备」且禁用',
      roomA2.buttons.indexOf('等待全员准备') >= 0 && roomA2.disabledButtons.indexOf('等待全员准备') >= 0,
      'buttons=' + JSON.stringify(roomA2.buttons) + ' disabled=' + JSON.stringify(roomA2.disabledButtons));
  }

  // ---------------- 候场室里断线 → 自动重连并回到同一间房 ----------------
  // 【为什么这条必须在两人房里验】房主掉线且房里没人时，房间会按「房主离开」直接销毁
  // （manager.leaveRoom：房空了就 delete rooms[code]），那种情况根本无从「回到房间」。
  // 只有房里还有别人时，房间才活着、房主身份会移交，重连回来才有房可回。
  // 这条正是用户报的场景：候场室一掉线界面就写「未连接」，只能刷新页面。
  const dropB = await B.eval('(function(){ window.VS_LOBBY.drop(); return window.VS_LOBBY.wsState; })()');
  expect('乙 能主动掐断候场室的连接（模拟掉线）', dropB === 'retry' || dropB === 'off', 'wsState=' + dropB);

  const retryB = await waitFor(async function () {
    const r = await state(B);
    return r && r.connText.indexOf('正在自动重连') >= 0 ? r : null;
  }, 5000, '乙界面显示正在自动重连');
  expect('乙 断线后界面写「正在自动重连（第 N 次）」而不是「未连接」', !!retryB,
    'connText=' + (retryB && retryB.connText));

  const backB = await waitFor(async function () {
    const r = await B.eval('(function(){ return { ws: window.VS_LOBBY.wsState, retry: window.VS_LOBBY.retry, room: window.VS_LOBBY.roomCode }; })()');
    return r && r.ws === 'on' && r.retry === 0 ? r : null;
  }, 20000, '乙自动重连完成');
  expect('乙 自己接回来了（不需要刷新页面）', !!backB, JSON.stringify(backB));
  expect('乙 接回后仍在同一间房（自动重进房间生效）',
    !!(backB && backB.room === roomCode), 'room=' + (backB && backB.room) + ' 期望 ' + roomCode);

  const roomA3 = await waitFor(async function () {
    const r = await state(A);
    return r && r.memberRows === 2 && r.memberNames.join('|').indexOf('测试乙') >= 0 ? r : null;
  }, 8000, '甲那边仍能看到 2 个人');
  expect('甲 那边人数没掉（乙重连后名单自动补齐）', !!roomA3,
    JSON.stringify((await state(A)).memberNames));

  // ---------------- 乙：点准备 ----------------
  const clickReady = await B.eval(clickByText('准备', true));
  expect('乙 能点「准备」', clickReady && clickReady.ok, JSON.stringify(clickReady));

  const aSeesReady = await waitFor(async function () {
    const r = await state(A);
    if (!r) return null;
    const ready = r.memberNames.join('|').indexOf('已准备') >= 0;
    // 解禁的判据：按钮文案切回「开始对局」且它不在 disabled 列表里
    const canGo = r.buttons.indexOf('开始对局') >= 0 && r.disabledButtons.indexOf('开始对局') < 0;
    return (ready && canGo) ? r : null;
  }, 6000, '甲看到乙已准备且开始按钮解禁');
  expect('甲 看到乙「已准备」且开始按钮解禁', !!aSeesReady,
    aSeesReady ? '' : JSON.stringify((await state(A)).memberNames));

  const bReady = await state(B);
  expect('乙 自己那边显示「取消准备」', (bReady.buttons || []).indexOf('取消准备') >= 0,
    JSON.stringify(bReady.buttons));

  // 留一张候场室截图给人工看。
  // 【只能在这里截】房主一发车，甲这个标签页就跳去 game.html 了，候场室那一屏再也回不来。
  try {
    const lobbyShot = await A.send('Page.captureScreenshot', { format: 'png' });
    if (lobbyShot && lobbyShot.data) fs.writeFileSync(LOBBY_SHOT, Buffer.from(lobbyShot.data, 'base64'));
    log('候场室截图已存：' + LOBBY_SHOT);
  } catch (e) { log('候场室截图失败：' + e.message); }

  // ---------------- 房主发车 ----------------
  const clickStart = await A.eval(clickByText('开始对局', false));
  expect('甲 能点「开始对局」', clickStart && clickStart.ok, JSON.stringify(clickStart));

  // ★为什么判据要同时认 /game 与 /game.html
  //   第十七轮加了 History API 之后，玩家侧的地址变成了干净的 /game?room=XXXX
  //   （服务端 router.js 的 PAGE_ALIAS 映射到 game.html）。
  //   而 /game.html 本身**故意保留** —— 一堆测试脚本直接拼它。
  //   所以这里必须两个都认：只认新路径，老脚本一改就红；只认老路径，
  //   本次改动就会被报成「功能坏了」，而实际功能好得很。
  const GAME_PATH = /\/game(\.html)?(\?|$)/;

  const gotoA = await waitFor(async function () {
    const u = await A.eval('location.href');
    return u && GAME_PATH.test(u) ? u : null;
  }, 8000, '甲跳到游戏页');
  expect('甲 收到开局包后跳到游戏页', !!gotoA && gotoA.indexOf('room=' + roomCode) >= 0,
    'href=' + gotoA);

  const gotoB = await waitFor(async function () {
    const u = await B.eval('location.href');
    return u && GAME_PATH.test(u) ? u : null;
  }, 8000, '乙跳到游戏页');
  expect('乙 也跳到游戏页（同一个房间号）', !!gotoB && gotoB.indexOf('room=' + roomCode) >= 0,
    'href=' + gotoB);

  // 甲乙都跳走之后，服务端应该把这一局挂起而不是收掉
  await sleep(1200);
  const stats = await fetch('http://127.0.0.1:' + APP_PORT + '/api/gamestats')
    .then(function (r) { return r.json(); })
    .catch(function () { return null; });
  const live = stats && stats.stats && (stats.stats.matches || []).filter(function (m) {
    return m.code === roomCode;
  })[0];
  expect('跳转后服务端把对局挂起（不是收掉）', !!live,
    'gamestats 里找不到 ' + roomCode + '：' + JSON.stringify(stats && stats.stats && stats.stats.matches));

  // ---------------- 游戏页：联机模式真的接上了（P2-4 骨架） ----------------
  // 验证游戏页认出 ?room=、握手回房、收到服务端快照、开始按快照渲染世界。
  const GAME_EXPR = '(function(){' +
    'var g = window.VS_GAME;' +
    'if (!g) return { hook: false };' +
    'var w = g.world;' +
    'return {' +
    '  hook: true, online: g.ui.online, screen: g.ui.screen, room: g.ui.roomCode,' +
    '  slot: g.ui.netSlot, snaps: g.ui.netSnaps, kb: g.ui.netKb, err: g.ui.netErr,' +
    // 【snapLive 与 snaps 别混用】
    //   snaps    = ui.netSnaps，渲染循环里每帧刷一次的**缓存值**（给人看的显示值），
    //   snapLive = g.snapCount，直读 net.snapCount 的**实时值**。
    // 拿 binFrames（实时 getter）去比 snaps（缓存）会稳定差一帧，那是假失败。
    '  snapLive: g.snapCount,' +
    '  tick: w ? w.tick : -1,' +
    '  players: (w && w.players) ? w.players.length : -1,' +
    '  mobs: (w && w.mobs) ? w.mobs.length : -1,' +
    '  binFrames: g.binFrames, binFail: g.binFail, netBytes: g.netBytes' +
    '};' +
    '})()';

  const gameA = await waitFor(async function () {
    const r = await A.eval(GAME_EXPR);
    return r && r.hook && r.snaps > 3 ? r : null;
  }, 15000, '游戏页进入联机并收到快照');

  expect('游戏页进入联机模式且开始对局', !!gameA && gameA.online === true && gameA.screen === 'playing',
    gameA ? JSON.stringify(gameA) : '15 秒内没进联机（调试句柄没挂上或没收到快照）');
  if (gameA) {
    expect('游戏页收到服务端快照（>3 帧）', gameA.snaps > 3, 'snaps=' + gameA.snaps);
    expect('世界里有玩家（含自己）', gameA.players >= 1, 'players=' + gameA.players);
    // 【别读 gameA.mobs】gameA 是在「刚收到第 4 帧快照」那一刻抓下来的冻结值，
    // 此时世界才开局 0.2 秒左右，怪还没刷出来 —— 读它必然读到 0（这不是 bug，是采样太早）。
    // 改成和下面的 drawn 一样「等它出现过」：10 秒都不出现，才说明快照里真的没怪。
    const sawMobs = await waitFor(async function () {
      const r = await A.eval(GAME_EXPR);
      return (r && r.mobs > 0) ? r.mobs : null;
    }, 10000, '世界里出现怪物');
    expect('世界里有怪物在刷', !!sawMobs, '10 秒内 mobs 一直是 0（快照里根本没有怪）');
    expect('世界 tick 已经推进', gameA.tick > 0, 'tick=' + gameA.tick);
    // 「快照里有怪」不等于「怪被画到了画布上」。
    // 服务端视野框（按客户端上报视口算的矩形 + viewPad）比屏幕视野大一圈，
    // 刚进局时附近的怪有可能恰好都在屏幕外，那一瞬间 drawn=0 是正常的 —— 所以这里
    // 不要求某一刻 drawn>0，而是等它出现过一次。若 10 秒都没出现过，说明是
    // 「快照发了但渲染器画不出来」（字段形状不匹配之类），那是真 bug。
    const drewMobs = await waitFor(async function () {
      const d = await A.eval('(window.VS_GAME && window.VS_GAME.stat) ? (window.VS_GAME.stat.drawn|0) : 0');
      return d > 0 ? d : null;
    }, 10000, '联机下怪物被画出来');
    expect('联机下怪物被真正绘制到画布上', !!drewMobs, '10 秒内 drawn 一直是 0');

    // ---------------- 队友可视化（用户实测反馈的 bug） ----------------
    // 反馈原文：多人同房，能看见队友的技能特效，却看不见队友本人。
    // 根因：技能走 events/fx 通道（事件带坐标，自己就能画），而角色本体在渲染层
    // 压根没人画 —— R.draw 只调了 drawPlayer（画 w.player，也就是自己），
    // world.players 里的队友没有任何绘制入口。数据一直是全的，缺的是那一笔。
    // 所以这里必须分两条断言：数据到了（players>=2）不算数，得真落到画布上。
    expect('快照里带上了队友（players>=2）', gameA.players >= 2, 'players=' + gameA.players);
    const drewMate = await waitFor(async function () {
      const d = await A.eval('(window.VS_GAME && window.VS_GAME.stat) ? (window.VS_GAME.stat.teammates|0) : 0');
      return d > 0 ? d : null;
    }, 10000, '队友被画到画布上');
    expect('队友被真正绘制到画布上（不是只收到数据）', !!drewMate,
      '10 秒内 stat.teammates 一直是 0 —— 数据到了但渲染层没画');
    const mateNames = await A.eval('(window.VS_GAME && window.VS_GAME.teamNames) ? window.VS_GAME.teamNames : []');
    // 失败现场留全量证据：名单有没有到、快照里 name 补上没有、谁是 self
    const mateDump = await A.eval('(function(){' +
      'var g = window.VS_GAME; if (!g) return null;' +
      'var ro = g.roster || [], sp = g.snapPlayers || [];' +
      'return {' +
      '  selfSlot: g.ui.netSlot,' +
      '  rosterLen: ro.length,' +
      '  roster: ro.map(function(m){ return m.slot + ":" + m.name; }),' +
      '  snap: sp.map(function(p){ return p.slot + ":" + (p.name || "(空)") + (p === g.world.self ? "[我]" : ""); })' +
      '};' +
      '})()');
    log('  [队友] 头顶名牌读到的名字 = ' + JSON.stringify(mateNames));
    log('  [队友] 现场证据 = ' + JSON.stringify(mateDump));
    expect('队友昵称已从开局名单补到快照玩家上（头顶名牌要用）',
      Array.isArray(mateNames) && mateNames.length >= 1 && !!mateNames[0]
        && String(mateNames[0]).indexOf('{{') < 0,
      'teamNames=' + JSON.stringify(mateNames));

    expect('加入对局没有报错', !gameA.err, 'err=' + gameA.err);
    expect('拿到了服务端分配的座位号', gameA.slot >= 0, 'slot=' + gameA.slot);

    // ---- P2-5：浏览器端真的在解二进制快照 ----
    // 这三条是「二进制协议在真浏览器里跑通」的唯一证据。
    // 服务端侧的 matchtest/bintest 都在 Node 里跑，测不出「浏览器拿到 ArrayBuffer
    // 却因为 decode 不认识它而一条都画不出来」这种事故（真踩过，见 proto_bin.js 注释）。
    expect('浏览器收到的是二进制帧（不是退回 JSON）', gameA.binFrames > 3,
      'binFrames=' + gameA.binFrames + ' / snaps=' + gameA.snapLive);
    expect('全部快照帧都走二进制', gameA.binFrames === gameA.snapLive,
      'bin=' + gameA.binFrames + ' total=' + gameA.snapLive);
    expect('二进制解码失败 0 次', gameA.binFail === 0, 'binFail=' + gameA.binFail);
    expect('收到的字节数是二进制真实字节数（比 JSON 口径小一个数量级）',
      gameA.netBytes > 0 && gameA.netBytes < gameA.snapLive * 4096,
      'bytes=' + gameA.netBytes + ' snaps=' + gameA.snapLive);
  }

  // 再等两秒，确认快照是持续来的（不是只来了第一帧就卡住）
  const kb1 = gameA ? gameA.kb : 0;
  await sleep(2200);
  const kb2 = await A.eval('(window.VS_GAME && window.VS_GAME.ui.netKb) || 0');
  expect('快照在持续下发（收到的体积还在涨）', (kb2 || 0) > (kb1 || 0),
    kb1 + 'KB -> ' + kb2 + 'KB');

  // ---------------- 联机不可暂停（用户实测反馈的点） ----------------
  // 多人游戏没有「暂停」这回事：世界在服务端推进，你一个人停不下来。
  // 本地按 Esc 只应打开一个「菜单」，绝不能让 screen 变成 paused ——
  // 那会弹出一块写着「对局已停止推进」的面板，可怪还在动、队友照常打，
  // 界面自相矛盾。这里把这条语义钉死，以后改界面不许破坏它。
  async function pressEsc(page) {
    const base = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
    await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, base));
    await page.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base));
    await sleep(220);
  }

  await pressEsc(A);
  const afterEsc = await A.eval('(window.VS_GAME && window.VS_GAME.screen) || ""');
  expect('联机按 Esc 打开的是「菜单」而不是「已暂停」', afterEsc === 'menu',
    'screen=' + JSON.stringify(afterEsc));

  // 留一张图给人工看：它应该写着「多人游戏无法暂停」，而不是「对局已停止推进」
  try {
    const menuShot = await A.send('Page.captureScreenshot', { format: 'png' });
    if (menuShot && menuShot.data) fs.writeFileSync(MENU_SHOT, Buffer.from(menuShot.data, 'base64'));
    log('联机菜单截图已存：' + MENU_SHOT);
  } catch (e) { log('联机菜单截图失败：' + e.message); }

  // 菜单开着的时候世界必须照常推进 —— 这才是「不暂停」的实质证据
  const tk1 = await A.eval('(window.VS_GAME && window.VS_GAME.tick) || 0');
  await sleep(900);
  const tk2 = await A.eval('(window.VS_GAME && window.VS_GAME.tick) || 0');
  expect('菜单开着时世界仍在推进（真·不暂停）', tk2 > tk1, 'tick ' + tk1 + ' -> ' + tk2);

  // 再按一次 Esc 关掉菜单，回到对局（画面继续，不需要「恢复」这个动作）
  await pressEsc(A);
  const afterEsc2 = await A.eval('(window.VS_GAME && window.VS_GAME.screen) || ""');
  expect('再按 Esc 关闭菜单、直接回到对局', afterEsc2 === 'playing',
    'screen=' + JSON.stringify(afterEsc2));

  // ---------------- 联机升级面板不能挡住战场（用户实测反馈的点） ----------------
  // 和「不能暂停」是同一条根：世界在服务端一直跑，所以升级面板**不能盖住画面**，
  // 否则玩家就是在盲选 —— 怪从哪边来、自己血还剩多少，全看不见。
  //
  // 【怎么造出这个场景】联机升级由服务端决定，等它自然发生要几十秒且不确定。
  // 这里直接改页面里的响应式状态把面板「摆」出来（VS_GAME 已经把 ui/hud 暴露出来了）。
  // 这验证的是**界面契约**（DOM 结构 + 计算样式），不是服务端事件链路 ——
  // 事件链路由后面的 tick 推进断言和 matchtest 各自覆盖。
  const fakeOpen = await A.eval('(function(){' +
    'var g = window.VS_GAME;' +
    'if (!g) return false;' +
    'g.hud.level = 7;' +
    'g.hud.choices = [' +
    '  { tag: "武", name: "测试长矛", desc: "朝最近的敌人投掷，命中后穿透 2 个目标" },' +
    '  { tag: "被", name: "测试护腕", desc: "攻击间隔 -8%" },' +
    '  { tag: "进", name: "测试升华", desc: "把当前武器进化成终极形态", type: "evolve" }' +
    '];' +
    'g.ui.pendingLevels = 1;' +
    'g.ui.screen = "levelup";' +
    'return true;' +
    '})()');
  expect('能把联机升级面板摆出来（供布局断言使用）', fakeOpen === true, '调试句柄没挂上？');

  await sleep(350);   // 等 Vue 把 DOM 刷出来

  // 量它：面板占了多少高度、上半屏那个点事件落到谁身上、模糊开没开
  const dock = await A.eval('(function(){' +
    'var vh = window.innerHeight, vw = window.innerWidth;' +
    'var ov = document.querySelector(".overlay-dock");' +
    'var r = { vw: vw, vh: vh, dockFound: !!ov };' +
    // 面板本身（不管有没有 dock 类）也要量，好给出「露出来多少」的数字
    'var pn = document.querySelector(".overlay .panel") || document.querySelector(".panel");' +
    'if (!pn) return r;' +
    'var prect = pn.getBoundingClientRect();' +
    'r.panelTop = Math.round(prect.top);' +
    'r.panelHeight = Math.round(prect.height);' +
    'r.panelBottom = Math.round(prect.bottom);' +
    // 面板上沿之上那片「干净区域」占视口的比例：越大说明战场露得越多
    'r.freeRatio = Number((prect.top / vh).toFixed(3));' +
    'r.panelDock = pn.className.indexOf("panel-dock") >= 0;' +
    'r.choices = document.querySelectorAll(".panel-dock .choice").length;' +
    'r.panelPe = getComputedStyle(pn).pointerEvents;' +
    'if (!ov) return r;' +
    'var ocs = getComputedStyle(ov);' +
    'r.blur = ocs.backdropFilter || ocs.webkitBackdropFilter || "";' +
    'r.ovPe = ocs.pointerEvents;' +
    'var orect = ov.getBoundingClientRect();' +
    'r.ovTop = Math.round(orect.top);' +
    'r.ovHeight = Math.round(orect.height);' +
    // 战场中上部那个点：事件应该落在 canvas 上（说明遮罩真的不吃事件）
    'var el = document.elementFromPoint(Math.round(vw / 2), Math.round(vh * 0.3));' +
    'r.hitTag = el ? (el.tagName + (el.id ? "#" + el.id : "")) : null;' +
    'var slots = document.querySelector(".hud-slots");' +
    'r.slotsLift = slots ? slots.className.indexOf("lift") >= 0 : null;' +
    'return r;' +
    '})()');

  log('  [面板实测] ' + JSON.stringify(dock));

  expect('联机升级用的是贴底变体 .overlay-dock', !!dock && dock.dockFound === true,
    dock ? JSON.stringify(dock) : '取不到数据');
  expect('面板本体带 .panel-dock', !!dock && dock.panelDock === true,
    dock ? 'className 里没有 panel-dock' : '');
  expect('贴底变体没有开背景模糊（blur 会把战场糊掉）',
    !!dock && (dock.blur === 'none' || dock.blur === ''), 'blur=' + (dock && dock.blur));
  expect('遮罩层不吃事件（pointer-events:none，点击能穿透到画布）',
    !!dock && dock.ovPe === 'none', 'ovPe=' + (dock && dock.ovPe));
  expect('面板本体吃事件（点在面板空白处不会让角色走位）',
    !!dock && dock.panelPe === 'auto', 'panelPe=' + (dock && dock.panelPe));
  expect('战场中上部点击落到 canvas 上（没有被面板挡住）',
    !!dock && dock.hitTag === 'CANVAS#game-canvas', 'hit=' + (dock && dock.hitTag));
  expect('面板上沿在视口 60% 以下（上半屏整片露出战场）',
    !!dock && dock.freeRatio >= 0.4, 'freeRatio=' + (dock && dock.freeRatio));
  expect('面板高度不超过视口 60%',
    !!dock && dock.panelHeight <= dock.vh * 0.6, 
    (dock && dock.panelHeight) + ' / ' + (dock && dock.vh));
  expect('三张候选卡都渲染出来了', !!dock && dock.choices === 3, 'n=' + (dock && dock.choices));
  expect('武器槽被抬起避开面板', !!dock && dock.slotsLift === true,
    'slotsLift=' + (dock && dock.slotsLift));

  // 面板开着的时候世界必须照常推进 —— 「不遮战场」的意义就在这里：
  // 你边选边被怪追，所以必须看得见。
  const lk1 = await A.eval('(window.VS_GAME && window.VS_GAME.tick) || 0');
  await sleep(900);
  const lk2 = await A.eval('(window.VS_GAME && window.VS_GAME.tick) || 0');
  expect('升级面板开着时世界仍在推进', lk2 > lk1, 'tick ' + lk1 + ' -> ' + lk2);

  // 留一张图给人工看：面板应该贴在底部，上半屏是清楚的战场
  try {
    const lvShot = await A.send('Page.captureScreenshot', { format: 'png' });
    if (lvShot && lvShot.data) fs.writeFileSync(LEVELUP_SHOT, Buffer.from(lvShot.data, 'base64'));
    log('联机升级面板截图已存：' + LEVELUP_SHOT);
  } catch (e) { log('联机升级面板截图失败：' + e.message); }

  // 收尾：把面板关掉，回到对局（真实服务端那边我们并没有真的升级，所以不会自动开）
  await A.eval('window.VS_GAME.ui.screen = "playing"');
  await sleep(300);
  const closed = await A.eval('document.querySelectorAll(".overlay-dock").length');
  expect('关掉面板后贴底变体不再存在', closed === 0, '还剩 ' + closed + ' 个');
  const backToPlaying = await A.eval('(window.VS_GAME && window.VS_GAME.screen) || ""');
  expect('关掉面板后回到对局', backToPlaying === 'playing', 'screen=' + JSON.stringify(backToPlaying));

  // ---------------- 联机地形（障碍）必须挂到渲染世界上 ----------------
  //
  // ★这一组守的是「联机时撞到看不见的障碍物」那个 bug（2026-10-04 修）：
  //   联机渲染用的世界是 applySnap 拼出来的**壳对象** —— 快照只带动态实体
  //   （怪/弹/拾取/玩家），**地形从来不在快照里**：它是「按 mapId 两端各算一次」
  //   的纯函数结果，只发一个地图 id。
  //   壳里一旦漏挂 obstacles，drawObstacles 读到 undefined 会直接 return：
  //   **整张图的障碍一个都不画**，而服务端碰撞照用真障碍 → 玩家撞到看不见的东西。
  //   单机渲染传的是 world 本身（有 obstacles），所以只有联机暴露这个问题。
  //
  // ★期望值在页面里用**同一个纯函数**现算，不写死数字 ——
  //   写死的话，以后加一张地图或调一次障碍数量，这条断言就会假红。
  const terrainExpr = '(function(){' +
    'var M = window.VS.MAPS, G = window.VS_GAME;' +
    'var w = G && G.world;' +
    'if (!w) return { err: "no-world" };' +
    'var id = w.map ? w.map.id : null;' +
    'var exp = id ? M.buildObstacles(M.mapById(id)).length : -1;' +
    'var obs = w.obstacles;' +
    'var R = G.renderer;' +
    'return {' +
    '  mapId: id,' +
    '  n: obs ? obs.length : -1,' +
    '  exp: exp,' +
    '  first: (obs && obs.length) ? (Math.round(obs[0].x * 10) / 10 + "," + Math.round(obs[0].y * 10) / 10) : null,' +
    '  rMapId: (R && R.map) ? R.map.id : null,' +
    '  hasTex: !!(R && R.groundTex)' +
    '};' +
    '})()';

  const terrA = await A.eval(terrainExpr);
  expect('联机：渲染世界挂上了地形（map + obstacles）',
    !!(terrA && terrA.mapId && terrA.n > 0), JSON.stringify(terrA));
  expect('★★联机：障碍数与本图纯函数结果一致（漏挂的话这里是 -1）',
    !!(terrA && terrA.n > 0 && terrA.n === terrA.exp),
    '实际 ' + (terrA && terrA.n) + ' / 期望 ' + (terrA && terrA.exp) + '（图 ' + (terrA && terrA.mapId) + '）');
  expect('联机：地面与障碍来自同一张地图（渲染层 R.map 必须跟世界一致）',
    !!(terrA && terrA.rMapId === terrA.mapId),
    'renderer.map=' + (terrA && terrA.rMapId) + ' world.map=' + (terrA && terrA.mapId));
  expect('联机：地面预渲染纹理还在（壳对象缺 map 时会被 buildGround 清空）',
    !!(terrA && terrA.hasTex), 'groundTex=' + (terrA && terrA.hasTex));

  // ★倍速按钮在**联机下必须不存在**：联机的世界由服务端按 20Hz 推进，
  //   客户端「加速」既推不动世界，也会变成「我快别人不快」的不公平。
  //   这是产品约束，不是实现细节 —— 所以要有断言钉住，别哪天顺手加回联机。
  const spdBtns = await A.eval('document.querySelectorAll(".speed-btn").length');
  expect('★联机不显示倍速按钮（看不到 = 加不了速）', spdBtns === 0, '实际 ' + spdBtns + ' 个');
  const onlineFlag = await A.eval('!!window.VS_GAME.ui.online');
  expect('确认这一局确实是联机（上面的结论才有意义）', onlineFlag === true, 'online=' + onlineFlag);

  // 乙也测一条：两人走的是同一份代码，但「只有房主好」这种事以前真出现过
  const terrB = await B.eval(terrainExpr);
  expect('★联机：非房主（乙）那边障碍也挂上了',
    !!(terrB && terrB.n > 0 && terrB.n === terrB.exp),
    '乙 实际 ' + (terrB && terrB.n) + ' / 期望 ' + (terrB && terrB.exp));

  // ---------------- 页面异常 ----------------
  expect('甲 页面零未捕获异常', A.pageErrors.length === 0, JSON.stringify(A.pageErrors.slice(0, 3)));
  expect('乙 页面零未捕获异常', B.pageErrors.length === 0, JSON.stringify(B.pageErrors.slice(0, 3)));

  // 留一张截图给人工看（候场室那一屏在甲跳转后已经没了，这里截的是跳转后的游戏页）
  try {
    const shot = await A.send('Page.captureScreenshot', { format: 'png' });
    if (shot && shot.data) fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    log('截图已存：' + SHOT);
  } catch (e) { log('截图失败：' + e.message); }

  log('');
  log('=== 汇总 ===');
  log('  PASS  ' + pass);
  log('  FAIL  ' + fail);

  // 偶发失败时把本次日志单独留一份。
  // 为什么需要：LOG 是固定路径，下一次运行会直接覆盖它 —— 真碰上偶发失败
  // （出现过一次：候场室之后的断言整片崩，重跑即恢复 43/0）时现场早就没了，
  // 连崩在哪一步都查不到。多留一份成本极低，事后能翻。
  if (fail) {
    try {
      const keep = TMP + '/vs_roomcheck_FAIL_' + Date.now() + '.log';
      fs.copyFileSync(LOG, keep);
      log('★ 本次有失败，日志已留存：' + keep);
    } catch (e) { /* 留存失败不影响主流程 */ }
  }

  try { chrome.kill(); } catch (e) { /* 收尾失败无所谓 */ }
  await killByPort(CDP_PORT);
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  log('脚本异常：' + (e && e.stack ? e.stack : e));
  process.exit(2);
});
