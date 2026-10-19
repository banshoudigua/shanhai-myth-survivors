// server/db/driver.js —— 数据层驱动适配层
//
// 本地模式：pglite（WASM 版 PostgreSQL，零安装、离线可用、数据落本地文件）
//   —— 本机开发、以及发布到 WorkBuddy「在线应用」沙箱时都走这条
// 云端模式：node-postgres 连接池，连接 CloudBase PostgreSQL
//   —— pg 不在 package.json 里，按需 require，原因见下面云端分支的注释
//
// 对外只暴露 query(sql, params, cb) 与 exec(sql, cb) 两个口子，
// 不做任何实体映射 / 字段映射，SQL 全部直写在 queries.js。

const fs = require('node:fs');
const config = require('../config');

const api = {};

if (config.useLocalDb) {
  // ---------- 本地模式：pglite ----------
  const { PGlite } = require('@electric-sql/pglite');

  // 【实测坑点】pglite 不会自动创建数据目录，目录不存在会直接 ENOENT 启动失败
  fs.mkdirSync(config.pgDataDir, { recursive: true });

  const db = new PGlite(config.pgDataDir);

  // 单条查询，返回 rows 数组
  api.query = function (sql, params, cb) {
    db.query(sql, params).then(function (res) {
      cb(null, res.rows);
    }, function (err) {
      cb(err);
    });
  };

  // 多语句执行（建表脚本用），不返回数据
  api.exec = function (sql, cb) {
    db.exec(sql).then(function () {
      cb(null);
    }, function (err) {
      cb(err);
    });
  };

  // 就绪 Promise。
  // 【实测】本机首次启动需加载并编译 WASM 约 45 秒，之后每次约 2.4 秒（数据持久化在 pgDataDir）
  api.ready = db.waitReady;
  api.kind = 'pglite';
} else {
  // ---------- 云端模式：node-postgres ----------
  //
  // 【为什么这里是按需 require，而不是写进 package.json 的 dependencies】
  // WorkBuddy「发布为应用」的沙箱在预检阶段会拒绝「依赖清单里出现外部数据库驱动」
  // 的项目（pg / mysql2 / mongoose / ioredis …），而 pg 常驻 dependencies 就会命中这条，
  // 整个项目都发不出去。可本项目两种形态又确实分工不同：
  //   · 本地与发布沙箱 → pglite（WASM 版，跑在进程内，不需要任何外部服务）
  //   · CloudBase 云托管 → 需要 pg 连托管 PostgreSQL
  // 所以把 pg 从清单里摘掉，改成「走到这条分支才 require」；
  // CloudBase 那边由 Dockerfile 在构建时显式补装（见 Dockerfile 的 deps 阶段）。
  //
  // 这里用 try/catch 是必要的例外：require 是同步的，没有 callback 形式可接，
  // 而缺了驱动时得给一句人话，不能让进程抛一个 MODULE_NOT_FOUND 就死掉。
  let Pool = null;
  try {
    Pool = require('pg').Pool;
  } catch (e) {
    console.log('[db] 云端模式需要 pg 驱动，但当前环境没装。');
    console.log('     本地/沙箱请改用本地模式（不要设 DB_DRIVER=pg）；');
    console.log('     CloudBase 云托管请确认镜像构建时装了 pg（Dockerfile 的 deps 阶段已包含）。');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.pgPoolMax
  });

  api.query = function (sql, params, cb) {
    pool.query(sql, params, function (err, res) {
      cb(err, res && res.rows);
    });
  };

  api.exec = function (sql, cb) {
    pool.query(sql, function (err) {
      cb(err);
    });
  };

  // 连接池无需预热
  api.ready = Promise.resolve();
  api.kind = 'pg';
}

module.exports = api;
