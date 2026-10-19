// tools/fetch-vendor.js —— 下载前端第三方依赖到 public/vendor
//
// 为什么需要这个脚本：
// 本项目要求「局域网断网也能玩」，因此前端绝不能用 CDN 引 Vue，
// 必须把 vue.global.prod.js 落到本地 public/vendor 目录随服务一起分发。
//
// 用法：node tools/fetch-vendor.js
// 说明：Bash 的 coreutils 在本机不可用，所以目录创建与下载统一用 node 实现。

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

// 需要落地的依赖清单：本地文件名 -> 远程地址
const VENDORS = [
  {
    file: 'vue.global.prod.js',
    url: 'https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.global.prod.js'
  }
];

const outDir = path.resolve(__dirname, '..', 'public', 'vendor');

// 跟随重定向下载（jsdelivr 会 302 到实际 CDN 节点）
function download(url, dest, redirectLeft, cb) {
  https.get(url, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectLeft > 0) {
      res.resume();
      return download(res.headers.location, dest, redirectLeft - 1, cb);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return cb(new Error('HTTP ' + res.statusCode + ' for ' + url));
    }

    const sizeHeader = Number(res.headers['content-length'] || 0);
    const tmp = dest + '.part';
    const ws = fs.createWriteStream(tmp);

    ws.on('error', function (err) {
      cb(err);
    });
    ws.on('finish', function () {
      // 先落 .part 再改名，避免下载中断留下半个文件被当成可用依赖
      fs.rename(tmp, dest, function (renameErr) {
        if (renameErr) return cb(renameErr);
        cb(null, fs.statSync(dest).size, sizeHeader);
      });
    });

    res.pipe(ws);
  }).on('error', function (err) {
    cb(err);
  });
}

fs.mkdirSync(outDir, { recursive: true });
console.log('[vendor] 输出目录: ' + outDir);

let idx = 0;
function next() {
  if (idx >= VENDORS.length) {
    console.log('[vendor] 全部完成');
    return;
  }
  const item = VENDORS[idx++];
  const dest = path.join(outDir, item.file);

  console.log('[vendor] 下载 ' + item.file + ' ...');
  download(item.url, dest, 5, function (err, size, expect) {
    if (err) {
      console.log('[vendor] 失败 ' + item.file + ': ' + err.message);
      return next();
    }
    // 大小对不上视为下载不完整，提示但保留（后续可用 --force 重下）
    const flag = expect && expect !== size ? ' (警告: 期望 ' + expect + ' 字节)' : '';
    console.log('[vendor] 完成 ' + item.file + ' = ' + size + ' 字节' + flag);
    next();
  });
}

next();
