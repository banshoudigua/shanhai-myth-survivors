# Dockerfile —— 云端（腾讯云开发 CloudBase 云托管）部署用
#
# 这段文件只有云端才用到，本地局域网直接 `node server/index.js` 即可，不需要 Docker。
#
# 云托管硬性要求（踩过的坑，别改）：
#   1. 容器必须监听 3000 端口，云托管默认按 3000 探活；
#   2. 必须监听 0.0.0.0，只监听 127.0.0.1 容器外访问不到；
#   3. 访问类型要选 WEB 才会有公网域名，并支持 WebSocket。
#
# 部署时需注入的环境变量：
#   DB_DRIVER=pg                     切到云端 PostgreSQL（不填就是本地 pglite，容器里没有持久盘会丢数据）
#   DATABASE_URL=postgres://...       CloudBase PostgreSQL 内网连接串
#   SESSION_SECRET=<32位以上随机串>    固定密钥，否则每次重启把所有人踢下线
#   PORT=3000  HOST=0.0.0.0           一般不用改，默认已是这个值

# ---------- 阶段一：装依赖 ----------
# 用 bun 装依赖（比 npm 快且与本地开发一致），产物 node_modules 直接搬给下一阶段
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# --frozen-lockfile 保证云端依赖版本与本地完全一致，避免"本地好使线上报错"
RUN bun install --production --frozen-lockfile
# pg 驱动【必须在这里单独补装】：它被刻意移出了 package.json 的 dependencies，
# 否则 WorkBuddy「发布为应用」沙箱的预检会以「依赖外部数据库」为由拒绝整个项目发布。
# 而云托管连 PostgreSQL 又非它不可 —— 所以本地/沙箱靠 pglite，镜像里补上 pg。
RUN bun add pg@^8.23.0

# ---------- 阶段二：运行 ----------
# 运行时用 node 而不是 bun：本地开发与实测都在 node 上完成，保持一致最稳
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

# 时区设成东八区，日志时间与本地对得上
RUN apk add --no-cache tzdata && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

EXPOSE 3000

# 健康检查：云托管探针与人工排障都用 /api/health
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
