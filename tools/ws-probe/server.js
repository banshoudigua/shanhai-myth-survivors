// tools/ws-probe/server.js —— WorkBuddy「发布为应用」沙箱连通性探针
//
// 【为什么需要这个探针】
// 《吸血鬼辛存者》多人联机完全建立在 WebSocket 长连接上（上行输入 20Hz、下行快照
// 20Hz，同一个端口）。而「发布为应用」的沙箱对外只声明了「单端口 HTTP 服务」，
// WebSocket 并没有被写进支持列表 —— 这不是读文档能确定的，只能实测。
//
// 这一次发布要同时验证三件事，每一件都是多人在线的命门：
//   1. WebSocket 能不能建起来并保持（反代是否透传 Upgrade），页面上的状态会直说；
//   2. 同一个服务进程能不能同时服务多个连接 —— 也就是「单实例」。
//      若两个浏览器打开都显示 peers=2，说明它们连的是同一个进程、看见的是同一份内存，
//      游戏世界才可能共享；若各看各的 1，那沙箱是多实例，多人联机从架构上就不成立；
//   3. 服务端能否【主动持续】下行（每 500ms 推一帧，等价于游戏的快照下行）。
//      只支持请求-响应的环境里，这条会长时间不涨。
//
// 探针本身零依赖数据库、零持久化，只为把上面三件事问清楚。

const http = require('node:http');
const WS = require('ws');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

// 当前活着的连接。它是「单实例」的证据：两个浏览器看到同一个 size 就是同一进程。
const clients = new Set();
let nextId = 1;
let tick = 0;

const PAGE = [
  '<!doctype html>',
  '<html lang="zh-CN">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>发布沙箱连通性探针</title>',
  '<style>',
  '  * { box-sizing: border-box; }',
  '  body { margin:0; padding:28px 20px; background:#16181c; color:#f4f1e8;',
  '         font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }',
  '  .wrap { max-width:680px; margin:0 auto; }',
  '  h1 { font-size:19px; font-weight:500; margin:0 0 6px; }',
  '  .sub { font-size:13px; color:#8b9099; margin:0 0 22px; line-height:1.6; }',
  '  .card { background:#1e2127; border:1px solid #2b2f36; border-radius:12px;',
  '          padding:16px 18px; margin-bottom:12px; }',
  '  .row { display:flex; align-items:center; justify-content:space-between; gap:12px; }',
  '  .label { font-size:13px; color:#a8adb6; }',
  '  .val { font-size:15px; font-weight:500; font-variant-numeric:tabular-nums; }',
  '  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:13px; }',
  '  .ok { background:rgba(123,200,108,.15); color:#7bc86c; }',
  '  .bad { background:rgba(224,90,90,.15); color:#e05a5a; }',
  '  .wait { background:rgba(242,193,78,.15); color:#f2c14e; }',
  '  .hint { font-size:13px; line-height:1.7; color:#a8adb6; margin-top:6px; }',
  '  .verdict { border-left:3px solid #f2c14e; }',
  '  .url { font-size:12px; color:#6f757e; word-break:break-all; margin-top:8px; }',
  '  input, button { font:inherit; border-radius:8px; border:1px solid #2b2f36; }',
  '  input { flex:1; background:#16181c; color:#f4f1e8; padding:9px 12px; font-size:13px; }',
  '  button { background:#f2c14e; color:#1a1c20; border:none; padding:9px 16px;',
  '           font-size:13px; font-weight:500; cursor:pointer; }',
  '</style>',
  '</head>',
  '<body>',
  '<div class="wrap">',
  '  <h1>发布沙箱连通性探针</h1>',
  '  <p class="sub">验证 WebSocket 长连接、多连接共享同一进程、服务端持续下行。',
  '     这三条成立，多人在线才成立。</p>',

  '  <div class="card">',
  '    <div class="row"><span class="label">WebSocket 通道</span>',
  '      <span id="wsState" class="badge wait">连接中…</span></div>',
  '    <div id="wsUrl" class="url"></div>',
  '  </div>',

  '  <div class="card">',
  '    <div class="row"><span class="label">我的连接编号</span>',
  '      <span id="myId" class="val">-</span></div>',
  '    <div class="row" style="margin-top:10px">',
  '      <span class="label">同一进程内的连接数</span>',
  '      <span id="peers" class="val">-</span></div>',
  '    <div class="row" style="margin-top:10px">',
  '      <span class="label">已收到服务端主动推送</span>',
  '      <span id="frames" class="val">0 帧</span></div>',
  '  </div>',

  '  <div class="card verdict">',
  '    <div id="verdict" class="hint">等第一帧推送到达后给出结论…</div>',
  '  </div>',

  '  <div class="card">',
  '    <div class="row" style="margin-bottom:10px">',
  '      <span class="label">往返测试（发一条，服务端原样回）</span></div>',
  '    <div class="row"><input id="say" placeholder="随便输点什么，回车发送">',
  '      <button id="send">发送</button></div>',
  '    <div id="echo" class="hint" style="margin-top:10px">—</div>',
  '  </div>',
  '</div>',

  '<script>',
  'function $(id) { return document.getElementById(id); }',
  'function parse(raw) {',
  '  try { return JSON.parse(raw); } catch (e) { return null; }',
  '}',
  'var frames = 0, myId = "-", peers = 0, sock = null;',
  'var proto = location.protocol === "https:" ? "wss:" : "ws:";',
  'var url = proto + "//" + location.host + "/ws";',
  '$("wsUrl").textContent = url;',

  'function badge(text, cls) { $("wsState").textContent = text; $("wsState").className = "badge " + cls; }',

  'function connect() {',
  '  sock = new WebSocket(url);',
  '  sock.onopen = function () { badge("已连通", "ok"); };',
  '  sock.onmessage = function (ev) {',
  '    var m = parse(ev.data);',
  '    if (!m) return;',
  '    if (m.t === "hello") { myId = m.id; $("myId").textContent = "#" + m.id; }',
  '    if (m.t === "tick") {',
  '      frames += 1; peers = m.clients;',
  '      $("frames").textContent = frames + " 帧";',
  '      $("peers").textContent = peers + " 个";',
  '      refresh();',
  '    }',
  '    if (m.t === "echo") { $("echo").textContent = "服务端回了：" + m.text; }',
  '  };',
  '  sock.onclose = function () { badge("已断开，3 秒后重连", "bad"); setTimeout(connect, 3000); };',
  '  sock.onerror = function () { badge("连接出错", "bad"); };',
  '}',
  'connect();',

  'function refresh() {',
  '  if (peers >= 2) {',
  '    $("verdict").textContent = "同一进程内已看到 " + peers + " 个连接 —— 多连接共享同一份内存，"',
  '      + "多人同屏可行（单实例已确认）。";',
  '    return;',
  '  }',
  '  if (frames > 0) {',
  '    $("verdict").textContent = "服务端能主动持续下行（已收到 " + frames + " 帧），"',
  '      + "但当前只有 1 个连接。请用另一个浏览器或手机再打开本页，看这里的连接数会不会变成 2。";',
  '  }',
  '}',

  'function send() {',
  '  var v = $("say").value || "ping";',
  '  if (sock && sock.readyState === 1) sock.send(v);',
  '}',
  '$("send").onclick = send;',
  '$("say").onkeydown = function (e) { if (e.key === "Enter") send(); };',
  '</script>',
  '</body>',
  '</html>'
].join('\n');

const server = http.createServer(function (req, res) {
  // 健康检查：沙箱探活与人工排障都用它，顺便能看到当前连接数与帧号
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, tick: tick }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

// WS 与 HTTP 共用同一个端口 —— 和游戏服务完全一样的形态
const wss = new WS.WebSocketServer({ server: server, path: '/ws' });

wss.on('connection', function (ws) {
  const id = nextId;
  nextId += 1;
  clients.add(ws);
  console.log('[probe] 连接建立 #' + id + '，当前连接数 ' + clients.size);

  ws.send(JSON.stringify({ t: 'hello', id: id, clients: clients.size, tick: tick }));

  ws.on('message', function (raw) {
    ws.send(JSON.stringify({ t: 'echo', id: id, text: String(raw).slice(0, 120) }));
  });

  ws.on('close', function () {
    clients.delete(ws);
    console.log('[probe] 连接关闭 #' + id + '，当前连接数 ' + clients.size);
  });

  ws.on('error', function () { /* 单条连接出错不影响服务，关闭事件会兜底处理 */ });
});

// 每 500ms 主动推一帧给所有连接：这是「服务端能持续下行」的证据，
// 也是游戏里 20Hz 快照推送的等价物
setInterval(function () {
  tick += 1;
  const msg = JSON.stringify({ t: 'tick', n: tick, clients: clients.size });
  clients.forEach(function (c) {
    if (c.readyState === 1) c.send(msg);
  });
}, 500);

server.listen(PORT, HOST, function () {
  console.log('[probe] 已监听 http://' + HOST + ':' + PORT + '（WebSocket 同端口 /ws）');
});
