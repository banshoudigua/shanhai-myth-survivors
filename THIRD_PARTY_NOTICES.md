# 第三方组件与许可声明

本项目为浏览器端 Canvas 2D 游戏，所有第三方代码都放在 `public/vendor/` 下，
不通过 CDN 加载。以下许可文本随源码一同分发。

| 组件 | 版本 | 用途 | 许可 | 许可证文件 |
| --- | --- | --- | --- | --- |
| [patch-gg/pixelfx](https://github.com/patch-gg/pixelfx) | 0.3.0 | 像素技能特效、角色动作时序（act） | MIT | `public/vendor/pixelfx/LICENSE`、`NOTICE.md` |
| [goldfire/howler.js](https://github.com/goldfire/howler.js) | 2.2.4 | 音效播放与移动端音频解锁 | MIT | `public/vendor/audio/HOWLER-LICENSE.txt` |
| [grumdrig/jsfxr](https://github.com/grumdrig/jsfxr) | 源码快照 | 构建期生成 8-bit 音效参数 → WAV | Unlicense（公有领域） | `tools/vendor/JSFXR-UNLICENSE.txt` |
| [floating-ui/floating-ui](https://github.com/floating-ui/floating-ui) | @floating-ui/dom 1.8.0 | 技能说明卡浮层定位、翻转与视口避让 | MIT | `public/vendor/ui/FLOATING-UI-LICENSE.txt` |
| [juliangarnier/anime](https://github.com/juliangarnier/anime) | 4.5.0 | 面板与浮层补间（仅 transform / opacity） | MIT | `public/vendor/ui/ANIME-LICENSE.md` |
| [ondras/rot.js](https://github.com/ondras/rot.js) | 2.x | 寻路算法对照基准（仅测试期使用） | **BSD-3-Clause** | `tools/vendor/ROT-LICENSE.txt` |
| [y-lohse/inkjs](https://github.com/y-lohse/inkjs) | 2.4.0 | Ink 剧情运行时；编译器仅构建期使用 | MIT | `public/vendor/story/INKJS-LICENSE.md` |
| Vue 3 / qrcode 等既有 vendor | — | 既有功能 | 见各自文件 | `public/vendor/` |

## 特别说明

- **BSD-3-Clause（rot.js）** 比 MIT 多一条限制：不得使用作者 Ondrej Zara
  或其贡献者的名字为衍生产品背书。本项目仅把它作为测试期的算法标准答案，
  运行时热路径里不包含它的代码；该条限制在此一并遵守。
- **自写组件**：`tools/wav-compat.js`（WAV 编码器）与剧情节拍逐字显现
  （`public/js/ui-fx.js`）是本项目自己写的，不属于任何第三方库。
- **因许可原因没有引入的组件**：
  - `mattboldt/typed.js` 自 2026 年起改为 **GPL v3 + 商业双许可**
    （仓库内另有 LIMITED / UNLIMITED_COMMERCIAL_LICENSE），与公开仓库不兼容，
    打字机功能改为自写实现。
  - `grumdrig/jsfxr` 仓库内的 `riffwave.js` 为 **GPL v2**，未复制进本项目；
    生成音效时使用本项目自写的 `tools/wav-compat.js` 替代其接口。
- **程序化音效**：`public/audio/*.wav` 由 `tools/gen-sfx.js` 用上表 jsfxr 的参数
  合成，不含第三方音频素材，可逐字节复现。
- **剧情数据**：`public/story/butian.ink` 与 `.ink.json` 由 `tools/gen-ink.js`
  从 `shared/campaign.js` 生成，文案为本项目原创内容。

各库的版权声明保留在其原始构建文件的头部或上述许可证文件中。
