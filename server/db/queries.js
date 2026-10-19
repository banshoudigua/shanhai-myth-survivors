// server/db/queries.js —— 全部 SQL 集中直写
//
// 约定：
// 1. 不引入 ORM，不做实体映射，SQL 直接写在这里，上层只调函数拿 rows；
// 2. 错误一律通过 callback 的 err 参数回传（用 callback 而非 try/catch 做流程控制）；
// 3. 占位符统一用 $1 $2（pglite 与 node-postgres 都支持）。

const db = require('./driver');

const queries = {};

// ============================================================
// 用户
// ============================================================

queries.findUserByUsername = function (username, cb) {
  db.query(
    'SELECT id, username, nickname, password_hash, salt, avatar, role, status, auth_key, created_at, last_login_at ' +
    'FROM users WHERE username = $1',
    [username],
    function (err, rows) {
      cb(err, rows && rows[0]);
    }
  );
};

queries.findUserById = function (id, cb) {
  db.query(
    'SELECT id, username, nickname, avatar, role, status, created_at, last_login_at ' +
    'FROM users WHERE id = $1',
    [id],
    function (err, rows) {
      cb(err, rows && rows[0]);
    }
  );
};

// 建账号。authKey 是「账号密钥」，会写进自证式会话 token（见 server/api/auth.js）——
// 它让 token 在数据被清空、账号按 token 重建之后还能对上号。
queries.createUser = function (username, nickname, passwordHash, salt, authKey, cb) {
  db.query(
    'INSERT INTO users (username, nickname, password_hash, salt, auth_key) VALUES ($1, $2, $3, $4, $5) ' +
    'RETURNING id, username, nickname, auth_key, created_at',
    [username, nickname, passwordHash, salt, authKey || ''],
    function (err, rows) {
      cb(err, rows && rows[0]);
    }
  );
};

// 给已有账号补一个密钥（老账号 auth_key 为空时的兜底路径）
queries.setUserAuthKey = function (userId, authKey, cb) {
  db.query('UPDATE users SET auth_key = $2 WHERE id = $1', [userId, authKey], function (err) {
    cb(err);
  });
};

// 重设密码（凭 token 即可，见 auth.setPassword）。
// 【为什么允许不知道旧密码就改】账号被「按 token 重建」时写进去的是一个**没人知道**的
// 随机密码哈希（randomsalt 也没存），用户此后只能靠 token 玩。没有这个出口的话，
// 重建就等于把账号锁死了 —— 那比掉线更糟。
queries.setUserPassword = function (userId, passwordHash, salt, cb) {
  db.query('UPDATE users SET password_hash = $2, salt = $3 WHERE id = $1',
    [userId, passwordHash, salt], function (err) {
      cb(err);
    });
};

queries.updateLastLogin = function (userId, cb) {
  db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId], function (err) {
    cb(err);
  });
};

queries.listUsers = function (limit, offset, cb) {
  db.query(
    'SELECT id, username, nickname, role, status, created_at, last_login_at ' +
    'FROM users ORDER BY id DESC LIMIT $1 OFFSET $2',
    [limit, offset],
    cb
  );
};

queries.countUsers = function (cb) {
  db.query('SELECT count(*)::int AS total FROM users', [], function (err, rows) {
    cb(err, rows && rows[0] && rows[0].total);
  });
};

queries.setUserStatus = function (userId, status, cb) {
  db.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status], function (err) {
    cb(err);
  });
};

// ============================================================
// 会话
// ============================================================

queries.createSession = function (token, userId, expiresAt, ip, cb) {
  db.query(
    'INSERT INTO sessions (token, user_id, expires_at, ip) VALUES ($1, $2, $3, $4)',
    [token, userId, expiresAt, ip],
    function (err) {
      cb(err);
    }
  );
};

// 按 token 取会话及对应用户。
//
// 【为什么不在 SQL 里比时间】这里原先写的是 `AND s.expires_at > now()`，把「过期没有」
// 交给数据库判断。线上（WorkBuddy 发布沙箱）实测这个比较**恒为假**：注册刚拿到 token，
// 紧接着拿它取 /api/me 就 401「未登录」，而同一个账号重新登录又能成功 ——
// 说明 users 表读得到、写入也没报错，唯独这一个 JOIN 查不出结果。
// 把时间比较挪到应用层后，判断只依赖 JS 的 Date 语义，不再受数据库时区/类型解析的影响。
// 过期判断见 auth.verifyToken（那里对「解析不出时间」做了放行处理）。
queries.findSessionUser = function (token, cb) {
  db.query(
    'SELECT s.token, s.expires_at, u.id, u.username, u.nickname, u.avatar, u.role, u.status ' +
    'FROM sessions s JOIN users u ON u.id = s.user_id ' +
    'WHERE s.token = $1',
    [token],
    function (err, rows) {
      cb(err, rows && rows[0]);
    }
  );
};

queries.deleteSession = function (token, cb) {
  db.query('DELETE FROM sessions WHERE token = $1', [token], function (err) {
    cb(err);
  });
};

// 更新账号头像。头像只存一个短 id（见 shared/avatars.js），合法性由调用方先用白名单校验。
// 游客没有账号行，不落库；他们换头像只影响当前连接。
queries.setUserAvatar = function (userId, avatar, cb) {
  db.query('UPDATE users SET avatar = $2 WHERE id = $1', [userId, avatar], function (err) {
    cb(err);
  });
};

queries.deleteUserSessions = function (userId, cb) {
  db.query('DELETE FROM sessions WHERE user_id = $1', [userId], function (err) {
    cb(err);
  });
};

// 清理过期会话，服务启动时执行一次
queries.cleanExpiredSessions = function (cb) {
  db.query('DELETE FROM sessions WHERE expires_at <= now()', [], function (err) {
    cb(err);
  });
};

// ============================================================
// 玩家累计统计
// ============================================================

queries.getPlayerStats = function (userId, cb) {
  db.query(
    'SELECT user_id, total_matches, total_kills, best_kills, longest_survive, total_play_sec, max_level ' +
    'FROM player_stats WHERE user_id = $1',
    [userId],
    function (err, rows) {
      cb(err, rows && rows[0]);
    }
  );
};

// 对局结束后累计一次
//
// 【参数必须显式转型】`$2` 同时喂给 total_kills（BIGINT）和 best_kills（INTEGER），
// PG/pglite 无法为同一个占位符推出唯一类型，会直接报
// `inconsistent types deduced for parameter $2`。
// 这条 SQL 从写下来那天起就没被执行过（一直没有调用方），所以这个错一直藏着 ——
// 真正接上落库的那一刻才炸出来。以后加 SQL 记得：**同一个占位符喂不同类型的列时，
// 一定要写 ::bigint / ::int 这样的显式转型。**
queries.upsertPlayerStats = function (userId, kills, surviveSec, level, playSec, cb) {
  db.query(
    'INSERT INTO player_stats (user_id, total_matches, total_kills, best_kills, longest_survive, total_play_sec, max_level) ' +
    'VALUES ($1::bigint, 1, $2::bigint, $2::int, $3::int, $4::bigint, $5::int) ' +
    'ON CONFLICT (user_id) DO UPDATE SET ' +
    '  total_matches = player_stats.total_matches + 1, ' +
    '  total_kills = player_stats.total_kills + EXCLUDED.total_kills, ' +
    '  best_kills = GREATEST(player_stats.best_kills, EXCLUDED.best_kills), ' +
    '  longest_survive = GREATEST(player_stats.longest_survive, EXCLUDED.longest_survive), ' +
    '  total_play_sec = player_stats.total_play_sec + EXCLUDED.total_play_sec, ' +
    '  max_level = GREATEST(player_stats.max_level, EXCLUDED.max_level), ' +
    '  updated_at = now()',
    [userId, kills, surviveSec, playSec, level],
    function (err) {
      cb(err);
    }
  );
};

// 一场对局写一行（结算时调用），返回自增 id —— 参战明细要挂在它下面。
// 只记「有账号参与」的对局：纯游客局没人认领，写进去只会让表无限长大。
queries.insertMatch = function (info, cb) {
  db.query(
    'INSERT INTO matches (room_code, map_seed, mode, player_count, duration_sec, wave_reached, is_cleared, ended_at) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id',
    [info.roomCode, info.seed, info.mode || 'coop', info.playerCount, info.durationSec, info.wave, info.cleared],
    function (err, rows) {
      cb(err, rows && rows[0] ? rows[0].id : null);
    }
  );
};

// 参战明细：每人一行。is_mvp 由调用方按击杀最高者标一个。
queries.insertMatchPlayer = function (matchId, row, cb) {
  db.query(
    'INSERT INTO match_players (match_id, user_id, guest_name, char_id, level, kills, damage_dealt, gold, survived_sec, is_mvp) ' +
    'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)',
    [matchId, row.userId, row.guestName || null, row.charId, row.level, row.kills,
      row.damageDealt, row.gold, row.survivedSec, !!row.isMvp],
    function (err) {
      cb(err);
    }
  );
};

// 排行榜：排序字段不能用占位符，所以按类型选固定 SQL（白名单，防注入）
const LEADERBOARD_SQL = {
  kills:
    'SELECT u.id, u.nickname, u.avatar, s.best_kills AS score, s.total_matches, s.longest_survive ' +
    'FROM player_stats s JOIN users u ON u.id = s.user_id ' +
    'ORDER BY s.best_kills DESC, u.id ASC LIMIT $1',
  survive:
    'SELECT u.id, u.nickname, u.avatar, s.longest_survive AS score, s.total_matches, s.best_kills ' +
    'FROM player_stats s JOIN users u ON u.id = s.user_id ' +
    'ORDER BY s.longest_survive DESC, u.id ASC LIMIT $1',
  level:
    'SELECT u.id, u.nickname, u.avatar, s.max_level AS score, s.total_matches, s.best_kills ' +
    'FROM player_stats s JOIN users u ON u.id = s.user_id ' +
    'ORDER BY s.max_level DESC, u.id ASC LIMIT $1'
};

queries.getLeaderboard = function (type, limit, cb) {
  // 未知类型回落到击杀榜，保证调用方永远不会拿到空结果
  const sql = LEADERBOARD_SQL[type] || LEADERBOARD_SQL.kills;
  db.query(sql, [limit], cb);
};

// ============================================================
// 数值配置（可热更）
// ============================================================

queries.getGameConfig = function (cb) {
  db.query('SELECT key, value FROM game_config', [], function (err, rows) {
    // 把 key/value 行整理成一个对象，上层直接读字段
    const conf = {};
    if (rows) {
      for (let i = 0; i < rows.length; i++) {
        conf[rows[i].key] = rows[i].value;
      }
    }
    cb(err, conf);
  });
};

queries.setGameConfig = function (key, value, cb) {
  db.query(
    'INSERT INTO game_config (key, value) VALUES ($1, $2) ' +
    'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, String(value)],
    function (err) {
      cb(err);
    }
  );
};

module.exports = queries;
