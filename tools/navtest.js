// tools/navtest.js —— 站点图标 + History API 导航的实测（CDP + 真实浏览器）
//
// 为什么必须真浏览器
// -----------------
// 本次改的两件事**恰好都是纯 Node 测不出来的**：
//   ① History API 的返回行为 —— history.length / back() / bfcache 都是浏览器语义，
//      Node 里没有任何等价物。断言必须建立在「浏览器按返回键之后发生了什么」之上。
//   ② 图标能不能真被浏览器取到 —— 要看 <head> 里实际解析出的 link[rel=icon] 列表
//      与各文件是否 200，而不是「文件在磁盘上」。
//
// 测的是什么（对应本次需求的两条）
//   A. 图标：四个文件都 200、MIME 正确、两个页面都声明了、manifest 能解析
//   B. 导航：大厅→对局按 pushState 语义走 /game、返回**不新压历史项**、
//      刷新 /game 仍能开（服务端 fallback）、扫码直链仍可用
//
// 用法：node tools/navtest.js [端口]
//   传 online 则测线上： node tools/navtest.js online
const fs = require('node:fs');
const { spawn, execFile } = require('node:child_process');

const ONLINE = process.argv[2] === 'online';
// ★公开仓库里不能写死自己的线上地址 —— 那是部署信息，不该跟着源码发出去。
//   改从环境变量取，没配就明确报错（比静默测了个错误地址好）。
const ONLINE_BASE = process.env.VS_ONLINE || '';
if (ONLINE && !ONLINE_BASE) {
  console.log('[navtest] 要用 online 模式请先设置目标地址：');
  console.log('  VS_ONLINE=https://<你的域名> node tools/navtest.js online');
  process.exit(1);
}
const BASE = ONLINE ? ONLINE_BASE : ('http://127.0.0.1:' + Number(process.argv[2] || 3000));

// ★测线上域名时必须显式给 Chrome 传 --proxy-server。
//   Windows 版 Chrome **不读** http_proxy/https_proxy 环境变量（只认系统代理设置，
//   而本机系统代理是「直连」），不指定的话导航会落到 chrome-error://chromewebdata/
//   → 症状「VS.NAV 不存在 / 断言整片红」，**看起来像前端崩了，其实一行代码都没错**。
//   测本地 127.0.0.1 时反过来要 --no-proxy-server。
// （这个坑踩过一次，白查了一整轮。）
function proxyArgs() {
  const p = process.env.http_proxy || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.HTTPS_PROXY;
  return (ONLINE && p) ? ['--proxy-server=' + p] : ['--no-proxy-server'];
}
const CDP_PORT = 9357;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_navtest_profile';

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function killByPort(port) {
  return new Promise(function (resolve) {
    execFile('powershell', ['-NoProfile', '-Command',
      '$p = (Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction SilentlyContinue).OwningProcess; ' +
      'if ($p) { $p | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue } }'
    ], function () { resolve(); });
  });
}

function launchChrome(w, h) {
  return new Promise(function (resolve, reject) {
    const child = spawn(CHROME, [
      '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--hide-scrollbars', '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=' + w + ',' + h
    ].concat(proxyArgs()).concat(['about:blank']), { stdio: 'ignore' });
    child.on('error', reject);
    let tries = 0;
    const t = setInterval(function () {
      tries += 1;
      require('node:http').get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/version' }, function (res) {
        res.resume(); clearInterval(t); resolve(child);
      }).on('error', function () {
        if (tries > 40) { clearInterval(t); reject(new Error('调试端口没起来')); }
      });
    }, 500);
  });
}

function connect() {
  return fetch('http://127.0.0.1:' + CDP_PORT + '/json/new?about:blank', { method: 'PUT' })
    .then(function (r) { return r.json(); })
    .then(function (tab) { return tab.webSocketDebuggerUrl; })
    .then(function (wsUrl) {
      return new Promise(function (resolve, reject) {
        const ws = new WebSocket(wsUrl);
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
          if (msg.method === 'Page.screencastFrame') { send('Page.screencastFrameAck', { sessionId: msg.params.sessionId }); return; }
          if (msg.method === 'Runtime.exceptionThrown') {
            const d = msg.params.exceptionDetails || {};
            errors.push((d.text || '') + ' ' + ((d.exception && d.exception.description) || ''));
          }
          if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            errors.push(msg.params.entry.text || '');
          }
        });
        ws.addEventListener('open', function () { resolve({ send: send, ws: ws, errors: errors }); });
        ws.addEventListener('error', function (e) { reject(new Error('CDP WS 出错：' + e.message)); });
      });
    });
}

// 注意：Runtime.evaluate 默认 awaitPromise:true（与 hudsize.js 相反），
// 这里要读跨导航后的页面状态，异步是必须的。
async function evalJS(send, expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r && r.exceptionDetails) return { __err: String(r.exceptionDetails.text) };
  return (r && r.result && r.result.value) || null;
}

// 导航后要等**页面真的跑完脚本**再量。
//
// ★★为什么不能只 sleep 固定时长：这是本轮实测踩到的坑。
//   Page.navigate 返回只代表「开始导航了」。对局页要顺序加载 17 个脚本
//   （其中 game.js 13 万行、render.js 12 万行），实测 2 秒时 DOM 里
//   **只插到 shared/const.js**，后面十几个 script 标签还没进 DOM。
//   此时去读 window.VS 必然是 undefined —— 看起来像「代码没生效」，
//   实际只是量早了。**这种假阴性比真 bug 费时间得多。**
//
// 判据用「目标脚本自己挂的全局」：大厅等 VS.NAV，对局等 VS_GAME
// （它挂在 game.js 末尾，是整页最后一个跑完的）。
async function goto(send, url, waitKey) {
  await send('Page.navigate', { url: url });
  const deadline = Date.now() + 25000;
  for (;;) {
    await sleep(300);
    const st = await evalJS(send, `(function(){
      return {
        ready: document.readyState,
        done: !!(window.VS && window.VS.${waitKey || 'NAV'})
      };
    })()`);
    if (st && st.ready === 'complete' && st.done) return;
    if (Date.now() > deadline) return;      // 超时不死循环：让后面的断言去报「没到」
  }
}

// 等页面加载完。waitKey 传全局键名（大厅 'NAV' / 对局 'GAME'）。
//
// ★传了 waitKey 就等那个键；**不传就只等 readyState 完整** ——
//   返回大厅的场景不能等 VS_GAME（大厅根本没这个句柄），否则白等满超时。
async function waitGame(send, waitKey) {
  const deadline = Date.now() + (waitKey ? 25000 : 12000);
  for (;;) {
    const st = await evalJS(send, `(function(){
      return {
        ready: document.readyState,
        done: ${waitKey ? '!!window.VS_GAME' : 'true'},
        url: location.pathname
      };
    })()`);
    if (st && st.ready === 'complete' && st.done) return st;
    if (Date.now() > deadline) return st;   // 超时返回，让断言去报「没到」
    await sleep(300);
  }
}

// ============================================================
// A. 图标
// ============================================================
async function testIcons(send) {
  console.log('\n--- A. 站点图标 ---');

  // A1~A4：四个文件都要真取得到（不是「磁盘上有」）
  const files = [
    ['/favicon.ico', 'image/x-icon'],
    ['/favicon.svg', 'image/svg+xml'],
    ['/apple-touch-icon.png', 'image/png'],
    ['/icon-192.png', 'image/png'],
    ['/icon-512.png', 'image/png'],
    ['/site.webmanifest', 'application/manifest+json']
  ];
  for (const [p, mime] of files) {
    const r = await fetch(BASE + p);
    const buf = Buffer.from(await r.arrayBuffer());
    // PNG 签名要真的对：状态码 200 + MIME 正确也可能是个空壳
    const isPng = p.endsWith('.png') && buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a';
    ok('图标文件可取 ' + p,
      r.status === 200 && String(r.headers.get('content-type')).indexOf(mime) === 0 && buf.length > 100 && (!p.endsWith('.png') || isPng),
      'status=' + r.status + ' type=' + r.headers.get('content-type') + ' bytes=' + buf.length);
  }

  // A5/A6：两个页面各自声明图标（head 不共享，少写一个那页就没图标）
  for (const page of ['/', '/game.html']) {
    await goto(send, BASE + page, page.indexOf('game') >= 0 ? 'GAME' : 'NAV');
    const r = await evalJS(send, `(function(){
      var ls = Array.prototype.slice.call(document.querySelectorAll('link[rel~="icon"]'));
      var at = document.querySelector('link[rel="apple-touch-icon"]');
      var mf = document.querySelector('link[rel="manifest"]');
      return {
        icons: ls.map(function(l){ return l.getAttribute('href'); }),
        hasSvg: ls.some(function(l){ return /\\.svg$/.test(l.getAttribute('href')||''); }),
        hasIco: ls.some(function(l){ return /\\.ico$/.test(l.getAttribute('href')||''); }),
        apple: at ? at.getAttribute('href') : '',
        manifest: mf ? mf.getAttribute('href') : '',
        title: document.title
      };
    })()`);
    ok(page + ' 声明了 svg 图标', r && r.hasSvg, JSON.stringify(r));
    ok(page + ' 声明了 ico 兜底', r && r.hasIco, JSON.stringify(r));
    ok(page + ' 声明了 apple-touch-icon', r && !!r.apple, JSON.stringify(r));
    ok(page + ' 声明了 manifest', r && !!r.manifest, JSON.stringify(r));
  }

  // A7：manifest 内容能解析，且 start_url 是大厅（装完点开要落在大厅，不是对局页）
  const mf = await fetch(BASE + '/site.webmanifest').then(function (r) { return r.json(); });
  ok('manifest 可解析且有图标', Array.isArray(mf.icons) && mf.icons.length >= 2, JSON.stringify(mf).slice(0, 200));
  ok('manifest start_url 是大厅', mf.start_url === '/', 'start_url=' + mf.start_url);
  ok('manifest display=standalone（装完是独立窗口）', mf.display === 'standalone', 'display=' + mf.display);

  // A8：manifest 里声明的图标要真的存在（写错路径是常见且不报错的坑）
  for (const ic of mf.icons || []) {
    const r = await fetch(BASE + ic.src);
    ok('manifest 图标存在 ' + ic.src, r.status === 200, 'status=' + r.status);
  }
}

// ============================================================
// B. History API 导航
// ============================================================
async function testNav(send) {
  console.log('\n--- B. History API 导航 ---');

  // B0：nav.js 挂上了，且两边接口齐全
  await goto(send, BASE + "/?debug=1", 'NAV');
  const hasNav = await evalJS(send, `(function(){
    var n = window.VS && window.VS.NAV;
    return {
      nav: n ? { url: typeof n.gameUrl, enter: typeof n.enterGame, back: typeof n.backToLobby } : null,
      // 诊断用：把「为什么取不到」一次性摊开，别让人猜
      vsType: typeof window.VS,
      vsKeys: window.VS ? Object.keys(window.VS).join(',') : '(无)',
      appHtml: document.documentElement.innerHTML.indexOf('{{') >= 0,
      cloak: !!document.querySelector('#app[v-cloak]')
    };
  })()`);
  ok('大厅页 nav 接口齐全',
    hasNav && hasNav.nav && hasNav.nav.url === 'function' && hasNav.nav.enter === 'function' && hasNav.nav.back === 'function',
    JSON.stringify(hasNav));
  if (hasNav && !hasNav.nav) {
    console.log('  !! 诊断：VS 类型=' + hasNav.vsType + ' 已挂模块=[' + hasNav.vsKeys + ']');
  }

  // B1：gameUrl 组地址 —— 空参数必须被省掉（拼出 /game?debug= 这种空值很难看）
  const urls = await evalJS(send, `(function(){
    var N = window.VS.NAV;
    return {
      map: N.gameUrl({ map: 'grass' }),
      both: N.gameUrl({ mod: 'myth', stage: 'ch2' }),
      empty: N.gameUrl({ map: '', stage: null, debug: '' }),
      dbg: N.gameUrl({ room: 'AB12', debug: '1' })
    };
  })()`);
  ok('gameUrl 干净路由', urls.map === '/game?map=grass', urls.map);
  ok('gameUrl 多参数', urls.both === '/game?mod=myth&stage=ch2', urls.both);
  ok('gameUrl 省掉空值', urls.empty === '/game', urls.empty);
  ok('gameUrl 带调试参数', urls.dbg === '/game?room=AB12&debug=1', urls.dbg);

  // B2：★核心 —— 进对局后按返回，地址回大厅，且**没有多出一条历史项**
  //
  // 【关于判据的教训（这一段是本轮最花时间的地方，留下来别再踩）】
  //   一开始用「返回后 history.length 应等于**全程基准**」来判，结果稳定报红。
  //   但代码是对的 —— 真因在测量方式：CDP 的 Page.navigate 与浏览器自己的
  //   前进/后退共享同一条历史，而本测试在同一标签页里 goto 了二十多次，
  //   每次 goto 都在**加**历史项，于是「基准」本身一直在漂，量它只会得到噪声。
  //   ★改成「**相邻两跳之间的增量**」之后判据才稳定：那次同样是噪声的量法。
  //   B3 的反向验证就是钉这一点：旧写法（location.href='/'）在同一判据下
  //   增量是 +1，新写法是 0 —— 符号相反，绝不会混。
  //
  // 【另一个坑：量得太早】Page.navigate 返回只代表「开始导航」。
  //   对局页要顺序加载 17 个脚本（game.js 13 万行），实测 2 秒时 DOM 里
  //   **只插到 shared/const.js**，读 window.VS 必然是 undefined。
  //   看着像「代码没生效」，其实只是量早了。所以全程用 waitGame 等判据，不用固定 sleep。
  await goto(send, BASE + '/?debug=1', 'NAV');

  // 记下「进对局之前」的长度：相邻两跳之间的**增量**才是稳定判据
  // （全程基准会因反复 goto 而漂，理由见下面的注释）
  const lenBefore = await evalJS(send, `(function(){
    return { len: history.length, url: location.pathname + location.search };
  })()`);

  await evalJS(send, `(function(){ window.VS.NAV.enterGame({ map: 'grass' }); return true; })()`);
  await waitGame(send, 'GAME');

  const enterStep = await evalJS(send, `(function(){
    return {
      path: location.pathname,
      url: location.pathname + location.search,
      len: history.length,
      fromMark: sessionStorage.getItem('vs_nav_from_lobby')
    };
  })()`);
  ok('进对局落到 /game', enterStep && enterStep.path === '/game', enterStep ? enterStep.url : '没量到');
  ok('进对局确实压了一条历史（length+1）',
    enterStep && enterStep.len === lenBefore.len + 1,
    enterStep ? ('进对局前=' + lenBefore.len + ' 进对局后=' + enterStep.len) : '没量到');
  ok('进对局记下了来路标记', enterStep && enterStep.fromMark === '1',
    enterStep ? ('fromMark=' + enterStep.fromMark) : '没量到');

  // 步骤 3：按返回（等价于用户点「返回大厅」按钮 —— 它调的就是 backToLobby）
  //
  // ★这里必须先确认**对局页里那一份 nav** 存在且能读到标记 ——
  //   大厅与对局是两个文档，各有一份 window.VS.NAV。对局页那份要是没挂上
  //   （脚本顺序错了 / nav.js 没加载），backToLobby 就是个 undefined，
  //   调用会静默什么都不做 —— 症状正是「URL 停在 /game」。
  const onGame = await evalJS(send, `(function(){
    var n = window.VS && window.VS.NAV;
    return {
      hasNav: !!n,
      back: n ? typeof n.backToLobby : '(无)',
      mark: sessionStorage.getItem('vs_nav_from_lobby')
    };
  })()`);
  ok('对局页也挂上了 nav', onGame && onGame.hasNav && onGame.back === 'function', JSON.stringify(onGame));
  ok('对局页读得到来路标记', onGame && onGame.mark === '1',
    onGame ? ('mark=' + onGame.mark) : '没量到');

  const backCall = await evalJS(send, `(function(){
    try { window.VS.NAV.backToLobby('测试'); return { called: true }; }
    catch (e) { return { called: false, err: String(e && e.message || e) }; }
  })()`);
  ok('backToLobby 调用没抛错', backCall && backCall.called, JSON.stringify(backCall));
  await waitGame(send, 'NAV');

  const backStep = await evalJS(send, `(function(){
    return {
      path: location.pathname,
      url: location.pathname + location.search,
      len: history.length,
      // 标记必须已被消费掉（只生效一次），否则来回两圈之后就开始乱
      fromMark: sessionStorage.getItem('vs_nav_from_lobby'),
      mounted: !!(window.VS && window.VS.NAV)
    };
  })()`);
  ok('★返回后回到大厅', backStep && backStep.path === '/', backStep ? backStep.url : '没量到');

  // ★★★这就是本次需求的核心断言。
  //
  // 「返回」不应该在历史栈上**新增**一条 —— 新增了，玩家再按一次浏览器返回
  // 就被弹回那个已经结束的对局（这就是「返回会关闭整个站」的真正成因）。
  //
  // ★为什么判「相对进对局时的增量 == 0」而不是「回到全程基准」：
  //   本测试在同一标签页反复 goto，每次 goto 都往历史里加一条，
  //   「全程基准」一直在漂，量它只会得到噪声。而「进对局时 → 返回后」
  //   这两跳是相邻的，增量稳定：back 走掉一条 → 增量 -1；
  //   旧写法 href='/' 压一条 → 增量 +1。两者符号相反，绝不会混。
  ok('★返回没有新压历史项（这一跳长度为 0 净变化）',
    backStep && enterStep && backStep.len === enterStep.len,
    backStep && enterStep ? ('进对局后=' + enterStep.len + ' 返回后=' + backStep.len) : '没量到');

  ok('来路标记被消费掉（只生效一次）', backStep && !backStep.fromMark,
    backStep ? ('fromMark=' + backStep.fromMark) : '没量到');
  ok('返回后大厅页脚本完整可用', backStep && backStep.mounted, JSON.stringify(backStep));

  // B3：★反向验证 —— 旧写法（location.href='/'）必须让上面那条断言变红。
  // 不做这一步，就无法区分「断言写对了」与「断言根本测不出差别」。
  //
  // ★同样要分步（理由见 B2 的注释：导航会销毁执行上下文）。
  await goto(send, BASE + '/?debug=1', 'NAV');
  await evalJS(send, `(function(){
    sessionStorage.setItem('vs_test_legacy', String(history.length));
    location.assign('/game?map=grass');
    return true;
  })()`);
  await waitGame(send, 'GAME');
  // ★记下「进对局之后」的长度，作为旧写法那一跳的起点
  await evalJS(send, `(function(){
    sessionStorage.setItem('vs_test_legacy_mid', String(history.length));
    location.href = '/';            // ← 旧写法：在栈上再压一条
    return true;
  })()`);
  await waitGame(send, 'NAV');
  const legacy = await evalJS(send, `(function(){
    return {
      before: Number(sessionStorage.getItem('vs_test_legacy') || '0'),
      mid: Number(sessionStorage.getItem('vs_test_legacy_mid') || '0'),
      after: history.length,
      url: location.pathname + location.search
    };
  })()`);
  // 判据用「进对局那一跳之后」作基准，而不是全程基准 ——
  // 基准在反复 goto 下会漂（见 B2 的注释），但**相邻两跳之间的增量**是稳定的。
  ok('反向验证：旧写法确实会多压一条（所以本轮的修法有意义）',
    legacy && legacy.after === legacy.mid + 1,
    legacy ? ('进对局后=' + legacy.mid + ' 旧返回后=' + legacy.after + '（期望 +1：旧写法多压的那一条）') : '没量到');
  ok('反向验证：旧写法确实落在大厅（对照组有效）', legacy && legacy.url === '/',
    legacy ? legacy.url : '没量到');

  // B4：刷新 /game 仍能开 —— History API 只改地址栏，刷新是真的发请求，
  //    服务端 fallback 必须接住，否则白屏。
  await goto(send, BASE + '/game?map=grass&debug=1', 'GAME');
  const afterReload = await evalJS(send, `(function(){
    return {
      url: location.pathname,
      title: document.title,
      canvas: !!document.querySelector('#game-canvas'),
      // 调试句柄挂上 = 这一整页脚本正常跑完
      hasGame: !!window.VS_GAME,
      mapParam: /[?&]map=grass/.test(location.search)
    };
  })()`);
  ok('刷新 /game 正常打开', afterReload.url === '/game' && !!afterReload.canvas, JSON.stringify(afterReload));
  ok('/game 上游戏脚本跑完（VS_GAME 在）', !!afterReload.hasGame, JSON.stringify(afterReload));
  ok('/game 保留了 map 参数', afterReload.mapParam, afterReload.mapParam);

  // B5：★老路径必须继续可用（19 个 tools/*.js 回归脚本全靠它）
  await goto(send, BASE + '/game.html?debug=1', 'GAME');
  const legacyPath = await evalJS(send, `(function(){
    return { url: location.pathname, hasGame: !!window.VS_GAME, canvas: !!document.querySelector('#game-canvas') };
  })()`);
  ok('老路径 /game.html 仍可打开（测试脚本依赖）',
    legacyPath.url === '/game.html' && legacyPath.hasGame && legacyPath.canvas, JSON.stringify(legacyPath));

  // B6：/lobby 别名
  await goto(send, BASE + '/lobby', 'NAV');
  const lobbyAlias = await evalJS(send, `(function(){ return { url: location.pathname, brand: !!document.querySelector('.brand') }; })()`);
  ok('/lobby 别名落到大厅', lobbyAlias.brand, JSON.stringify(lobbyAlias));

  // B7：★扫码直链（?room=）必须仍然能用 —— 二维码里就是它，不能被路由改动牵连
  await goto(send, BASE + '/?room=AB12&debug=1', 'NAV');
  const scan = await evalJS(send, `(function(){
    return { url: location.pathname + location.search, roomShown: (document.body.innerText||'').indexOf('AB12') >= 0 };
  })()`);
  ok('扫码链接 /?room= 仍可用', scan.roomShown, JSON.stringify(scan));

  // B8：★未知路径仍 404（fallback 必须是白名单，不是「什么都回首页」）
  const nope = await fetch(BASE + '/definitely-not-a-page');
  ok('未知路径 404（没有 catch-all 回落）', nope.status === 404, 'status=' + nope.status);

  // B9：★真正的「只消费一次」验证 —— 走完整两圈（进→退→再进→再退）
  //
  // 只验一次「标记被清掉」是不够的：那只能说明 backToLobby 会 removeItem，
  // 不能说明**第二圈会不会又走错路**。而后者才是用户真正遇到的毛病
  // （来回两趟之后返回键开始乱弹）。
  //
  // ★判据：第二圈「进对局 → 再进对局」时栈仍然只增长 1（而不是 2）。
  //   如果标记没被消费，第二圈 back 就会退回到**第一圈那个对局**，
  //   栈的形状随之变形。
  // ★判据同样换成 URL（理由见 B2：history.length 的基准在反复 goto 下会漂）。
  //   「两圈走完还在大厅」= 每次返回都落在大厅，而不是被退回到第一圈那个对局。
  await goto(send, BASE + '/?debug=1', 'NAV');
  await evalJS(send, `(function(){
    sessionStorage.setItem('vs_test_url_r2', location.pathname + location.search);
    window.VS.NAV.enterGame({ map: 'grass' });
    return true;
  })()`);
  await waitGame(send, 'GAME');
  const r2a = await evalJS(send, `(function(){
    return { url: location.pathname + location.search };
  })()`);
  ok('第一圈在对局页', r2a && r2a.url === '/game?map=grass', r2a ? r2a.url : '没量到');

  await evalJS(send, `(function(){ window.VS.NAV.backToLobby('第一圈'); return true; })()`);
  await waitGame(send, 'NAV');
  const r2b = await evalJS(send, `(function(){
    return { url: location.pathname + location.search };
  })()`);
  ok('★第一圈返回落在大厅', r2b && r2b.url === '/?debug=1', r2b ? r2b.url : '没量到');

  await evalJS(send, `(function(){ window.VS.NAV.enterGame({ map: 'grass' }); return true; })()`);
  await waitGame(send, 'GAME');
  const second = await evalJS(send, `(function(){
    return {
      url: location.pathname + location.search,
      mark: sessionStorage.getItem('vs_nav_from_lobby')
    };
  })()`);
  ok('第二圈同样进到对局页（没被退回去）', second && second.url === '/game?map=grass',
    second ? second.url : '没量到');
  ok('第二圈重新种上了来路标记', second && second.mark === '1',
    second ? ('mark=' + second.mark) : '没量到');

  await evalJS(send, `(function(){ window.VS.NAV.backToLobby('第二圈'); return true; })()`);
  await waitGame(send, 'NAV');
  const round2End = await evalJS(send, `(function(){
    return {
      before: sessionStorage.getItem('vs_test_url_r2'),
      url: location.pathname + location.search
    };
  })()`);
  ok('★两圈走完回到最初的地址（标记没被累积）',
    round2End && round2End.url === round2End.before,
    round2End ? ('最初=' + round2End.before + ' 两圈后=' + round2End.url) : '没量到');

  // B10：★bfcache 恢复钩子真的接上了 —— 用「真按浏览器返回键」验，
  // 而不是只读一个标志位。
  //
  // 场景：从对局返回大厅时走的是 history.back()，大厅页可能**从 bfcache 复活**
  // （Vue 数据在、WebSocket 已被浏览器掐断）。这时必须补一次连接，
  // 否则玩家看到「回来了却显示未连接」。
  //
  // ★怎么量「钩子被调用过」：往 console 打一条专属标记，再从控制台日志里读。
  //   比直接调方法更接近真实路径 —— 它同时证明了 pageshow 真的触发了。
  // B10：★用**浏览器自己的返回键**（Page.goBack）验一遍，
  // 因为这是玩家真正按的那个键 —— 它走的是浏览器历史，不经过 backToLobby。
  //
  // 这一圈覆盖的是 bfcache 复活：从对局 back 回大厅时，大厅页可能从缓存里复活
  // （Vue 数据在、WebSocket 已被浏览器掐断），大厅的 reviveFromBfcache 必须补连。
  await goto(send, BASE + '/?debug=1', 'NAV');
  await evalJS(send, `(function(){
    window.VS.NAV.enterGame({ map: 'grass' });
    return true;
  })()`);
  await waitGame(send, 'GAME');
  const midLen = await evalJS(send, `(function(){ return { len: history.length }; })()`);

// ★★这一段踩过两个坑，症状都像「产品 bug」，其实都是测试自己的问题：
//
//  ① 用 waitGame(send,'NAV') 等「返回后到位」—— 它在对局页会**立刻通过**
//     （对局页也加载了 nav.js，VS.NAV 同样在），量到的还是对局页。故改成轮询 URL。
//  ② 改用 CDP 的 Page.goBack —— 它在这个「每步都手动 Page.navigate」的会话里
//     **完全无效**（轮询 8 秒地址纹丝不动）。
//     最后改成在页面里调 history.back()：这与用户按返回键走同一条路径
//     （浏览器历史后退），照样能覆盖 bfcache 复活，只是不经 DevTools 那层。
  await sleep(800);
  await evalJS(send, `(function(){ history.back(); return true; })()`);
  let backOk = false;
  const deadline = Date.now() + 8000;
  for (;;) {
    await sleep(300);
    const st = await evalJS(send, `(function(){
      return { path: location.pathname, ready: document.readyState };
    })()`);
    if (st && st.path === '/' && st.ready === 'complete') { backOk = true; break; }
    if (Date.now() > deadline) break;
  }
  ok('浏览器返回（history.back）真的退回了大厅', backOk,
    (await evalJS(send, 'location.pathname + location.search')) || '没量到');
  await sleep(600);

  const back2 = await evalJS(send, `(function(){
    return {
      url: location.pathname + location.search,
      len: history.length,
      navOk: !!(window.VS && window.VS.NAV),
      lobbyOk: !!document.querySelector('.brand')
    };
  })()`);
  ok('浏览器返回键回到大厅', back2 && back2.url === '/?debug=1', back2 ? back2.url : '没量到');
  // 同 B2：判「这一跳的净变化」而不是全程基准
  ok('浏览器返回键也没有多压历史项',
    back2 && midLen && back2.len === midLen.len,
    back2 && midLen ? ('进对局后=' + midLen.len + ' back后=' + back2.len) : '没量到');
  ok('返回后大厅界面完整（.brand 在）', back2 && back2.lobbyOk, JSON.stringify(back2));
  ok('返回后导航模块在（页面可用）', back2 && back2.navOk, JSON.stringify(back2));
}

async function main() {
  console.log('=== 图标 + History API 导航实测  目标 ' + BASE + ' ===');
  if (!fs.existsSync(CHROME)) { console.log('!! 找不到无头浏览器'); process.exit(1); }

  const alive = await fetch(BASE + '/api/health').then(function (r) { return r.status === 200; }).catch(function () { return false; });
  if (!alive) { console.log('!! 服务没起来：' + BASE + '/api/health 不通'); process.exit(1); }

  await killByPort(CDP_PORT);
  const child = await launchChrome(1280, 860);
  const cli = await connect();

  await cli.send('Page.enable');
  await cli.send('Runtime.enable');
  await cli.send('Log.enable');
  // ★必须开 screencast，否则后台标签页的 rAF 被节流，主循环只跑几帧
  await cli.send('Page.startScreencast', { format: 'jpeg', quality: 40, everyNthFrame: 1 });

  const before = cli.errors.length;
  await testIcons(cli.send);
  await testNav(cli.send);

  // ★控制台异常也算失败（图标 404、nav.js 没加载都会在这里露出来）
  const errs = cli.errors.slice(before).filter(function (e) {
    return !/favicon/i.test(e) || /404|Failed to load/i.test(e);
  });
  ok('全程无控制台错误', errs.length === 0, errs.slice(0, 3).join(' | '));

  try { cli.ws.close(); } catch (e) { /* 已关 */ }
  child.kill();
  await killByPort(CDP_PORT);

  console.log('\n=== 结果：' + pass + ' PASS / ' + fail + ' FAIL ===');
  process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
  console.error('测试脚本异常：', e);
  process.exit(1);
});