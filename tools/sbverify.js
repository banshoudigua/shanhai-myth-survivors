// tools/sbverify.js —— 线上复验：技能图鉴在真实域名上能不能用
//
// 为什么静态资源 curl 通了还不够
// --------------------------------
// 200 + 体积对，只能证明「文件传上去了」。它证明不了：
//   ① 服务端跑的是不是新代码（沙箱有可能拿旧快照起进程）
//   ② 浏览器里 Vue 模板有没有真的渲染出来（v-cloak / 脚本顺序错都只表现为白屏）
//   ③ skillbook.js 依赖的 const.js 在**线上那份**里齐不齐
// 所以这里直接开无头浏览器打线上域名，点开图鉴，读 DOM。
//
// 用法：node tools/sbverify.js [线上地址]
// ★不写死自己的线上域名（公开仓库不该带部署信息）；也可用环境变量 VS_ONLINE 指定。
const { spawn } = require('node:child_process');

const BASE = String(process.argv[2] || process.env.VS_ONLINE || '');
if (!BASE) {
  console.log('[sbverify] 请给出要核验的线上地址：');
  console.log('  node tools/sbverify.js https://<你的域名>');
  console.log('  或  VS_ONLINE=https://<你的域名> node tools/sbverify.js');
  process.exit(1);
}
const CDP_PORT = 9347;
const { TMP, CHROME } = require('./env');
const PROFILE = TMP + '/vs_sbverify_profile';
const SHOT = TMP + '/vs_sbverify_live.png';

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

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
    const child = spawn(CHROME, [
      '--disable-gpu', '--no-sandbox', '--no-proxy-server', '--no-first-run',
      '--hide-scrollbars', '--user-data-dir=' + PROFILE,
      '--remote-debugging-port=' + CDP_PORT, '--remote-allow-origins=*',
      '--window-size=1600,1000', 'about:blank'
    ], { stdio: 'ignore' });
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
            const timer = setTimeout(function () { delete pending[msgId]; rej(new Error('CDP 超时：' + method)); }, 25000);
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

async function main() {
  console.log('=== 线上复验：' + BASE + ' ===');
  await killByPort(CDP_PORT);
  await sleep(400);
  const chrome = await launchChrome();
  const s = await connect();
  const send = s.send;
  const evalJS = async function (expr) {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return (r && r.result && r.result.value) || null;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  // ★必须开投屏：无头环境没有可见窗口，rAF 不会被调度 → Vue 的 nextTick 与
  //   主循环都不跑，断言会全是假的。用 --virtual-time-budget 更糟，它会在
  //   网络请求回来之前就退出。
  await send('Page.startScreencast', { format: 'jpeg', quality: 25, everyNthFrame: 4 });

  await send('Page.navigate', { url: BASE + '/game.html?debug=1&_t=' + Date.now() });
  await sleep(7000);

  // ① 页面活着吗
  const alive = await evalJS('(function(){ return { hook: !!window.VS_GAME, sb: !!window.VS.SKILLBOOK, cloak: (document.getElementById("hud")||{hasAttribute:function(){return false;}}).hasAttribute("v-cloak") }; })()');
  ok('线上 game.html 加载完成（调试句柄已挂）', !!(alive && alive.hook), JSON.stringify(alive));
  ok('★skillbook.js 在线上真的执行了', !!(alive && alive.sb), JSON.stringify(alive));
  ok('Vue 已渲染完成（v-cloak 已摘）', !!(alive && alive.cloak === false), JSON.stringify(alive));

  if (!(alive && alive.sb)) {
    console.log('  !! skillbook.js 没跑起来，后面的界面断言跳过（先看这个）');
  }

  // ② 图鉴数据在**线上那份 const.js** 上算得出来吗
  if (alive && alive.sb) {
    const data = await evalJS(`(function(){
      try {
        var SB = window.VS.SKILLBOOK;
        var g = SB.build();
        var m = {};
        for (var i=0;i<g.length;i++) m[g[i].key] = g[i].items.length;
        return { groups: g.length, counts: m,
                 total: g[0].items.length + g[1].items.length + g[2].items.length + g[3].items.length,
                 firstWeapon: g[0].items[0].name,
                 firstDesc: g[0].items[0].desc };
      } catch (e) { return { err: String(e && e.message || e) }; }
    })()`);
    ok('线上图鉴能算出四组条目', !!(data && data.groups === 4), JSON.stringify(data));
    ok('线上条目数= 17/14/10/13（合计 54）',
      !!(data && data.counts && data.counts.weapon === 17 && data.counts.passive === 14 &&
         data.counts.evo === 10 && data.counts.combo === 13 && data.total === 54),
      JSON.stringify(data && data.counts));
    ok('条目内容是中文（不是 id）', !!(data && data.firstWeapon === '铁鞭'), data && data.firstWeapon);
  }

  // ③ 界面：点开图鉴读 DOM
  await evalJS('(function(){ var g=window.VS_GAME; if(g) g.start(); return 1; })()');
  await sleep(1500);
  await evalJS('(function(){ var b=document.querySelector(".help-btn"); if(b) b.click(); return 1; })()');
  await sleep(900);

  const ui = await evalJS(`(async function(){
    await Vue.nextTick();
    await new Promise(function(r){ requestAnimationFrame(function(){ r(); }); });
    var box = document.querySelector(".skillbook");
    var panel = document.querySelector(".sb-panel");
    var r = { open: !!box };
    if (!box) return r;
    r.items = document.querySelectorAll(".sb-item").length;
    r.tabs = Array.prototype.slice.call(document.querySelectorAll(".sb-tab")).map(function(b){ return (b.innerText||"").replace(/\\s+/g,""); });
    r.pointer = getComputedStyle(box).pointerEvents;
    r.panelW = panel ? Math.round(panel.getBoundingClientRect().width) : 0;
    r.hasTpl = box.innerText.indexOf("{{") >= 0;
    r.first = (document.querySelector(".sb-item")||{innerText:""}).innerText.replace(/\\s+/g," ").trim().slice(0,90);
    return r;
  })()`);
  ok('点开 ? 按钮后抽屉渲染出来了', !!(ui && ui.open), JSON.stringify(ui));
  ok('★没有残留模板文字（说明 Vue 真渲染了）', !!(ui && ui.hasTpl === false), ui && ui.hasTpl);
  ok('四个页签都在', !!(ui && ui.tabs && ui.tabs.length === 4), JSON.stringify(ui && ui.tabs));
  ok('武器页 17 条', !!(ui && ui.items === 17), ui && String(ui.items));
  ok('整层不吃指针事件（线上也生效）', !!(ui && ui.pointer === 'none'), ui && ui.pointer);
  ok('抽屉是右侧一条，不是全屏', !!(ui && ui.panelW > 0 && ui.panelW < 800), ui && String(ui.panelW));
  ok('条目是中文技能名', !!(ui && ui.first && ui.first.indexOf('铁鞭') >= 0), ui && ui.first);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  require('node:fs').writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
  console.log('  截图：' + SHOT);

  const errs = s.errors.filter(function (e) { return e && e.indexOf('favicon') < 0; });
  ok('线上页面零 JS 异常', errs.length === 0, errs.slice(0, 3).join(' || '));

  await send('Page.stopScreencast');
  s.ws.close();
  chrome.kill();
  await killByPort(CDP_PORT);
  console.log('\n  PASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail > 0 ? 1 : 0);
}

setTimeout(function () { console.log('!! 总超时 150秒'); process.exit(2); }, 150000);
main().catch(function (e) { console.log('脚本出错：' + (e && e.stack || e)); process.exit(1); });
