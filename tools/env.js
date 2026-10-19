// tools/env.js —— 自检脚本共用的本机环境（临时目录 / 无头浏览器路径）
//
// 【为什么要有这个文件】
//   原来 20 多个脚本各自写着：
//     const TMP = 'C:/Users/<本机用户名>/AppData/Local/Temp';
//     const CHROME = 'C:/Users/<本机用户名>/AppData/Local/ms-playwright/....exe';
//   两个问题：
//   ① **公开仓库会暴露 Windows 用户名**（这台机器是谁的）；
//   ② 换台机器 / 换个 Windows 账号，路径全不对，20 个脚本一起失效。
//   集中到这里：一处脱敏、一处适配，脚本里只写 `require('./env')`。
//
// 【优先级】环境变量 > 自动探测 > 空值（由调用方报错）
//   环境变量：VS_TMP（临时目录）、VS_CHROME（浏览器可执行文件）
//
// 【为什么不用 try/catch】项目约定：改用「先判断存在、再读取」的写法。

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// ---------------- 临时目录 ----------------
// 用系统的临时目录，而不是写死某个用户的 AppData 路径
const TMP = process.env.VS_TMP || os.tmpdir();

// ---------------- 无头浏览器 ----------------
// Playwright 把浏览器放在 <用户目录>/AppData/Local/ms-playwright/（Windows）
//   或 ~/.cache/ms-playwright/（Linux / macOS）。
// ★目录名带版本号（chromium_headless_shell-1234），版本一升级就变 ——
//   所以这里**扫目录找**，不写死版本号（写死的话每升一次 Playwright 就得改 20 个文件）。
const CHROME_EXE = 'chrome-headless-shell' + (process.platform === 'win32' ? '.exe' : '');

function playwrightRoot() {
  if (process.platform === 'win32') {
    // WIN_APPDATA 也允许覆盖 —— 有些机器把 AppData 放到别的盘
    const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(appData, 'ms-playwright');
  }
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

// 在 ms-playwright 下逐个目录找 chrome-headless-shell 可执行文件。
// 找到第一个**真实存在**的就返回；都没有则返回空串（让调用方给出可读的报错）。
function findChrome() {
  if (process.env.VS_CHROME && fs.existsSync(process.env.VS_CHROME)) {
    return process.env.VS_CHROME;
  }

  const root = playwrightRoot();
  if (!fs.existsSync(root)) return '';

  const dirs = fs.readdirSync(root).filter(function (d) {
    return d.indexOf('chromium') >= 0;      // chromium-1234 / chromium_headless_shell-1234
  });

  // 版本号越大越优先（数字后缀），避免拿到旧版本
  dirs.sort(function (a, b) {
    const na = parseInt((a.match(/(\d+)$/) || [0, 0])[1], 10);
    const nb = parseInt((b.match(/(\d+)$/) || [0, 0])[1], 10);
    return nb - na;
  });

  for (let i = 0; i < dirs.length; i++) {
    const base = path.join(root, dirs[i]);
    // 两种布局都试：<dir>/chrome-headless-shell-win64/xxx.exe 与 <dir>/chrome-win/xxx.exe
    const sub = fs.readdirSync(base).filter(function (s) {
      return s.indexOf('chrome') >= 0 && fs.statSync(path.join(base, s)).isDirectory();
    });
    for (let j = 0; j < sub.length; j++) {
      const exe = path.join(base, sub[j], CHROME_EXE);
      if (fs.existsSync(exe)) return exe;
    }
  }
  return '';
}

const CHROME = findChrome();

// 浏览器找不到时给一句能直接照做的提示（这比 "ENOENT" 有用得多）
if (!CHROME) {
  console.warn('[env] 未找到无头浏览器 chrome-headless-shell。');
  console.warn('[env]   安装：npx playwright install chromium-headless-shell');
  console.warn('[env]   或指定：VS_CHROME=<可执行文件绝对路径>');
}

module.exports = { TMP: TMP, CHROME: CHROME };