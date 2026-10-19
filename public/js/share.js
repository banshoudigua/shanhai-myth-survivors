// public/js/share.js —— 邀请分享（二维码）
//
// 为什么要有这个东西：
//   以前邀请队友只能「把地址念一遍 + 报房间号」，手机用户基本没法操作
//   （要在手机上敲一长串 IP + 端口 + 房间号）。改成出二维码，扫一下就直接落在
//   大厅并自动进这桌。
//
// 依赖 public/vendor/qrcode.js（Kazuhiko Arase 的 qrcode-generator，MIT，
// 已 vendor 到本地，**不走 CDN** —— 项目硬约定：外部依赖一律落 public/vendor/）。
//
// 这个文件不依赖 Vue，也不依赖任何页面结构，两个页面（index.html / game.html）共用。
// 唯一的对外接口挂在 window.VS.SHARE 上。

(function () {
  'use strict';

  // 邀请链接：带上房间号。对方打开后大厅会自动进这桌（见 lobby.js 的 pendingUrlRoom）。
  // 用 location.origin 而不是写死域名 —— 局域网和线上各是一套地址，写死就废了一半。
  function inviteUrl(code) {
    const c = String(code || '').toUpperCase();
    return location.origin + '/' + (c ? '?room=' + encodeURIComponent(c) : '');
  }

  // 把一段文本画成二维码。
  //
  // 【为什么自己画而不是用库自带的渲染】库只提供模块矩阵（getModuleCount / isDark），
  // 自带的 DOM 渲染会往页面里塞一堆 table/img，配色也没法控。我们自己往 canvas 上画：
  // 尺寸可选、随 DPR 清晰、方便嵌进任何弹层。
  //
  // 配色注意：二维码**必须是深色码点 + 浅色底**。理论上反色（浅点深底）也能扫，
  // 但不少老扫描器认不出来，所以这里坚持标准配色（米白底 + 近黑点），
  // 只让外层的弹层保持项目的暗色主题。
  //
  // 返回 true 表示画成功；false 说明库没加载上或文本过长，调用方负责提示。
  function drawQr(canvas, text, size) {
    const QR = window.qrcode;
    if (!QR || !canvas || !text) return false;

    const px = size || 220;
    let qr = null;
    // 版本号传 0 = 让库自己按内容长度挑；容错等级 M 是体积与可扫性的平衡点
    //（L 太脆，一张反光就扫不出；Q/H 会让码点变大、同样尺寸下更密）
    qr = QR(0, 'M');
    qr.addData(text);
    qr.make();

    const n = qr.getModuleCount();
    const pad = 4;                       // 静默区：四周不留白，很多扫描器直接不认
    const total = n + pad * 2;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = Math.round(px * dpr);
    canvas.height = Math.round(px * dpr);
    canvas.style.width = px + 'px';
    canvas.style.height = px + 'px';

    const ctx = canvas.getContext('2d');
    if (!ctx) return false;

    const cell = (px * dpr) / total;
    ctx.fillStyle = '#f4f1e8';
    ctx.fillRect(0, 0, px * dpr, px * dpr);
    ctx.fillStyle = '#14161a';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.isDark(r, c)) continue;
        // 每格多画半个像素：浮点取整会在格与格之间留出发丝细缝，
        // 扫的时候偶尔会因为那一条缝整块读错
        ctx.fillRect((c + pad) * cell, (r + pad) * cell, cell + 0.5, cell + 0.5);
      }
    }
    return true;
  }

  window.VS = window.VS || {};
  window.VS.SHARE = {
    inviteUrl: inviteUrl,
    drawQr: drawQr,
    // 库没加载上时为 false，界面可以据此退化成「只显示链接」
    ready: function () { return !!window.qrcode; }
  };
})();
