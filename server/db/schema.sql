-- server/db/schema.sql
-- 建表语句（幂等：可重复执行）。PostgreSQL 方言，云端 CloudBase PG 与本地 pglite 共用。

-- ============ 用户表 ============
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,               -- 登录名，唯一
  nickname      TEXT NOT NULL,                      -- 游戏内显示名
  password_hash TEXT NOT NULL,                      -- scrypt 哈希，绝不存明文
  salt          TEXT NOT NULL,                      -- 每个用户独立盐值
  avatar        TEXT NOT NULL DEFAULT '',
  role          TEXT NOT NULL DEFAULT 'player',     -- player / admin
  status        SMALLINT NOT NULL DEFAULT 1,        -- 1 正常 / 0 封禁
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  -- 账号密钥：自证式会话 token 里带的就是它（见 server/api/auth.js）。
  -- 【为什么要单独一列】token 不能只写用户名 —— 用户名在数据被清空后**可以被别人抢注**，
  -- 那样一枚旧 token 就会落到别人账号上。密钥对每个账号唯一，重建后仍能对上号。
  auth_key      TEXT NOT NULL DEFAULT ''
);

-- ============ 登录会话 ============
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,                      -- 随机 token（客户端存 localStorage）
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  ip         TEXT
);

-- ============ 对局主表 ============
CREATE TABLE IF NOT EXISTS matches (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code    TEXT,                                -- 房间码
  map_seed     BIGINT NOT NULL,                     -- 地图随机种子，用于复盘
  mode         TEXT NOT NULL DEFAULT 'coop',
  player_count INTEGER NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ,
  duration_sec INTEGER NOT NULL DEFAULT 0,
  wave_reached INTEGER NOT NULL DEFAULT 0,
  is_cleared   BOOLEAN NOT NULL DEFAULT FALSE       -- 是否撑过全部波次
);

-- ============ 对局参战明细（每个玩家一行） ============
CREATE TABLE IF NOT EXISTS match_players (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  match_id     BIGINT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- 游客为 NULL
  guest_name   TEXT,                                -- 游客昵称（user_id 为空时使用）
  char_id      TEXT NOT NULL,                       -- 使用角色
  level        INTEGER NOT NULL DEFAULT 1,
  kills        INTEGER NOT NULL DEFAULT 0,
  damage_dealt BIGINT NOT NULL DEFAULT 0,
  gold         INTEGER NOT NULL DEFAULT 0,
  survived_sec INTEGER NOT NULL DEFAULT 0,
  died_at      TIMESTAMPTZ,
  is_mvp       BOOLEAN NOT NULL DEFAULT FALSE
);

-- ============ 玩家累计统计（冗余表，排行榜直接读，避免每次聚合扫全表） ============
CREATE TABLE IF NOT EXISTS player_stats (
  user_id         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  total_matches   INTEGER NOT NULL DEFAULT 0,
  total_kills     BIGINT NOT NULL DEFAULT 0,
  best_kills      INTEGER NOT NULL DEFAULT 0,
  longest_survive INTEGER NOT NULL DEFAULT 0,       -- 秒
  total_play_sec  BIGINT NOT NULL DEFAULT 0,
  max_level       INTEGER NOT NULL DEFAULT 1,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 成就 ============
CREATE TABLE IF NOT EXISTS achievements (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code  TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL,
  descr TEXT,
  icon  TEXT
);

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  achievement_id BIGINT NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  unlocked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, achievement_id)
);

-- ============ 数值配置（后台热更，改完不用重启） ============
CREATE TABLE IF NOT EXISTS game_config (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL,
  remark TEXT
);

-- ============ 索引 ============
CREATE INDEX IF NOT EXISTS idx_mp_user    ON match_players(user_id);
CREATE INDEX IF NOT EXISTS idx_mp_match   ON match_players(match_id);
CREATE INDEX IF NOT EXISTS idx_mp_kills   ON match_players(kills DESC);
CREATE INDEX IF NOT EXISTS idx_stats_kill ON player_stats(best_kills DESC);
CREATE INDEX IF NOT EXISTS idx_sess_exp   ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sess_user  ON sessions(user_id);

-- ============ 迁移（幂等，每次启动都会跑） ============
-- ★`CREATE TABLE IF NOT EXISTS` **不会给已存在的表补列** —— 所以新增列必须在这里
--   额外写一条 `ADD COLUMN IF NOT EXISTS`，否则老库（本地开发库就是这样）启动不报错、
--   但查那一列会直接失败。PostgreSQL 从 9.6 起支持这个语法，pglite 同样支持。
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_key TEXT NOT NULL DEFAULT '';
