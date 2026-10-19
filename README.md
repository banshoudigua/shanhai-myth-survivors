# 山海神话传 · Shanhai Myth Survivors

一款以中国上古神话为题材的**多人合作生存**网页游戏（Vampire Survivors 类）。
同一局域网下开一个房间，最多 8 人一起在怪潮里活到最后。

上古天地失序，浊气漫过四海。你从山海之间醒来，手持干戚、符箓或雷法，
与同伴撑到最后一刻。

> 单机与联机共用同一套模拟逻辑：服务端权威 20Hz 推进，客户端本地预测渲染。
> 所有游戏数据（角色 / 武器 / 怪物 / 地图）集中在 `shared/const.js`，前后端各取一份，天然一致。

---

## 玩法

| | |
|---|---|
| **单机** | 独自或断网可玩，暂停、倍速（×1/×2/×4）、局内商店一应俱全 |
| **联机** | 同网段建房间，房主开局，队友中途加入；候场室可换角色 |
| **剧情** | 单人战役《补天纪》共 6 关，逐关解锁，带章节指引与评价 |
| **手机** | 竖屏可玩，虚拟摇杆；技能栏默认折叠成角标，把战场让出来 |

**8 位角色**：刑天 / 后土 / 文昌 / 祝融 / 玄武 / 窃火 / 魃 / 行者
**17 件武器 · 14 项被动 · 10 种进化 · 13 组合技 · 14 种怪物 · 6 张地图**

技能满 8 级可进化，特定两件凑齐触发组合技（组合技不占技能格）。
金币可在局内商店买补给、直接习得或置换技能。

---

## 快速开始

需要 **Node.js 22+**。

```bash
npm install          # 只装 2 个依赖：@electric-sql/pglite 与 ws
npm start            # 默认 3000 端口
```

浏览器打开 `http://localhost:3000`。

局域网联机：同一网段的其他设备访问 `http://<你的内网IP>:3000`。
启动日志会直接把可用的地址打出来。

```bash
# 常用环境变量
PORT=3000                   # 监听端口
SESSION_SECRET=<32位随机串>  # 会话签名密钥（见下方「安全」）
DATABASE_URL=postgres://...  # 不填则用内置 pglite（数据落在 ./data）
```

---

## 技术栈

- **服务端**：Node.js 单进程，HTTP + WebSocket 同端口；权威模拟 20Hz
- **前端**：Vue 3 + Canvas 2D，原生 WebSocket，无构建步骤（依赖放在 `public/vendor/`，**不引 CDN**）
- **数据**：SQL 直写（不用 ORM）；本地 pglite / 云端 PostgreSQL 双模
- **美术**：像素风，全部程序化绘制 + AI 生成立绘与场景图

### 几个设计上的取舍

- **会话不依赖数据库**：token 是自证的（`vs1.<b64(payload)>.<b64(hmac)>`），
  库里查不到就按 token 原样重建。这样即使部署环境数据不持久，也不会「老是自动退出」。
- **地形不进网络包**：地图障碍是纯函数算出来的，两端按 `mapId` 各算一次，完全一致。
- **怪物与判定全在服务端**：客户端只负责表现与输入，改不了血量与伤害。

---

## 目录结构

```
server/          服务端（HTTP 路由、WS、模拟、DB）
shared/          前后端共用：const.js（全部游戏数据）、sim.js、maps.js
public/          前端页面、样式、脚本、图片、vendor
tools/           40+ 个自检脚本（见下）
data/            本地数据库（已 gitignore）
```

## 自检脚本

项目不依赖测试框架，全部是能直接跑的 Node 脚本，覆盖模拟逻辑、网络协议、排版与像素级校验：

```bash
node tools/simtest.js        # 模拟逻辑（伤害/升级/进化/组合技…）
node tools/roomcheck.js <端口>   # 房间流程与 UI
node tools/hudsize.js   <端口>   # HUD 排版（多分辨率）
node tools/hudalign.js  <端口>   # 顶栏对齐 + 技能栏折叠
node tools/artshot.js   <端口>   # 出图核对（角色立绘/战场/配色）
```

<details>
<summary>全部脚本</summary>

`simtest` `mptest` `netcheck` `roomcheck` `campaigntest` `skillbooktest` `storycheck`
`storylist` `specui` `hudsize` `hudalign` `charoverflow` `panelbtn` `pausecheck`
`mobilecheck` `artshot` `maptest` `difftest` `hellotest` `seatkeeptest` `gamecheck`
`smoke` `navtest` `sessiontest` `bintest` `fuzzcheck` 等

</details>

---

## 安全

会话签名密钥默认是一个**占位串**，启动时会打印警告。
部署到公网前请务必设置：

```bash
SESSION_SECRET=$(openssl rand -hex 32)
```

否则任何拿到本仓库源码的人都能伪造他人的登录态
（自证 token 无法在服务端吊销，安全性完全依赖这个密钥保密）。

游客输个昵称即可开玩，不落库；自建账号走 scrypt。

---

## 许可

仅供学习与朋友间游玩。美术资源为 AI 生成 + 程序化绘制。
