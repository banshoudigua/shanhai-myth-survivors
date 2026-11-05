# 第三方代码说明：pixelfx

- 上游仓库：https://github.com/patch-gg/pixelfx
- 取用版本：0.3.0（2026-11-05 取 `main` 分支源码）
- 许可：MIT，允许商用；完整条款见同目录 `LICENSE`
- 版权：Copyright (c) 2026 Patch；部分效果改编自 Sprite Fusion 的开源特效，
  Copyright (c) 2026 Hugo Duprez。各源码文件顶部保留了原作者的声明，请勿删除。

## 本项目做了什么

1. `src/core/` 是上游核心模块的原样拷贝，`src/fx/` 只挑了游戏用得到的 18 个特效
   （连同它们各自目录下的 `_lib.js`），均未改动。
2. `entry.js` 是我们写的浏览器入口：把核心 API 与这 18 个特效导出为 `window.PixelFX`。
3. `pixelfx.js` 是 `entry.js` 经 `bun build --format=iife --minify` 生成的单文件产物，
   `public/game.html` 只引用它，不引用 `src/`；`src/` 保留是为了可追溯、可重新构建。
4. 上游 Gallery 使用的 Patch Pixel 字体**不在 MIT 授权内**，本项目没有引入任何字体文件。

## 重新构建

在能运行 bun 的机器上，于本目录执行（不写死任何本机路径）：

```bash
bun build entry.js --outfile pixelfx.js --format=iife --target=browser --minify
```

构建完把 `LICENSE` 里的版权与许可声明放在 `pixelfx.js` 文件头（当前产物已带）。

## 本项目侧的适配

`public/js/pixelfx-layer.js` 把库输出的低分辨率像素帧合成到离屏画布，
再按世界坐标贴到主 Canvas 上；调色板统一换成项目约定的暗红 / 琥珀金 / 冷灰，
不使用紫色与紫蓝色。特效只作用于渲染层，联机快照与二进制协议完全没动。
