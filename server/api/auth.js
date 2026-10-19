// server/api/auth.js —— 账号体系：注册 / 登录 / 会话校验
//
// 认证完全自建，不依赖任何云服务，因此局域网断网时依然可以登录。
// 密码使用 node:crypto 的 scrypt 加盐哈希，数据库中绝不存明文。
// 错误处理统一走 callback(err, data)，不用 try/catch 做流程控制。

const crypto = require('node:crypto');
const config = require('../config');
const queries = require('../db/queries');

const auth = {};

// ============================================================
// 内部工具
// ============================================================

// 密码哈希：每个用户一个独立随机盐，异步 scrypt 避免阻塞事件循环
function hashPassword(password, salt, cb) {
  crypto.scrypt(password, salt, 64, function (err, derived) {
    if (err) return cb(err);
    cb(null, derived.toString('hex'));
  });
}

// 定长比较，避免时序侧信道
function digestEqual(hexA, hexB) {
  if (typeof hexA !== 'string' || typeof hexB !== 'string') return false;
  if (hexA.length !== hexB.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hexA, 'hex'), Buffer.from(hexB, 'hex'));
}

// ============================================================
// 自证式会话 token（不等数据库，本轮新增）
// ============================================================
//
// 格式：`vs1.<base64url(payload)>.<base64url(hmac-sha256)>
// payload = { u 用户名, k 账号密钥, n 昵称, a 头像, r 角色, e 过期毫秒 }
//
// 【为什么要把身份签进 token，而不是「随机串 + sessions 表」】
// 本项目线上跑在 WorkBuddy「发布为应用」沙箱里，而沙箱**数据不持久** ——
// 数据库落在容器内文件，每次重新部署都会回滚到上传时的快照。
// 也就是说「会话存在库里」这条路**注定每次发布被清空**：用户上一秒还在玩，
// 我发布一次他就被踢回登录页（提示「登录状态已失效」）。用户的原话是「老是自动退出」，
// 而他自己什么都没做错 —— 这是环境决定的，只有一个解法：
// **让浏览器里那枚 token 自己就能证明「我是谁」**（HMAC 签名），不再依赖服务端记得他。
//
// 于是：
//   · 签名对得上、没过期 → 认；
//   · 库里查不到这个账号 → 用 token 里的信息把账号**原样重建**（数据被回滚的典型场景）；
//   · 同名账号已存在但密钥对不上 → **拒绝**（绝不把别人的账号交出去）。
//
// 【代价，如实记下】签名式 token 无法在服务端吊销：退出登录只清浏览器本地。
// 有效期 30 天、朋友局规模，这个代价换「不再莫名掉线」是划算的。
// 要恢复吊销能力，就得回到「token 只是查库的钥匙」，而那条路在无持久化沙箱里必然掉线。

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(str) {
  return Buffer.from(String(str).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

// 签一枚 token。密钥见 config.sessionSecret（刻意用固定值，理由在那边的注释里）
function signToken(claims) {
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', config.sessionSecret).update(body).digest());
  return 'vs1.' + body + '.' + sig;
}

// 校验签名与有效期。返回 claims，任何一项不过都返回 null。
function parseToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'vs1') return null;

  const body = parts[1];
  const expect = b64url(crypto.createHmac('sha256', config.sessionSecret).update(body).digest());
  // 定长比较，避免时序侧信道（与密码比较同一个理由）
  if (expect.length !== parts[2].length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(parts[2]))) return null;

  // JSON.parse 对外部输入失败是常态，这里必须接住 ——
  // 不要用 try/catch 做**流程控制**，但「解析外部数据」这件事本身只能这么接。
  let claims = null;
  try {
    claims = JSON.parse(unb64url(body));
  } catch (e) {
    return null;
  }
  if (!claims || typeof claims.u !== 'string' || !claims.u) return null;
  if (!(typeof claims.e === 'number' && claims.e > Date.now())) return null;   // 过期
  return claims;
}

function newAuthKey() {
  return crypto.randomBytes(16).toString('hex');
}

// 生成会话 token。
//   row 完整的用户行（要有 username / nickname / avatar / role / auth_key）
// 老账号 auth_key 为空时**顺手补一个并落库** —— 否则它签出来的 token 重建后对不上号。
function buildSession(row, ip, cb) {
  const expMs = Date.now() + config.sessionTtlDays * 24 * 3600 * 1000;
  const claimsOf = function (key) {
    return {
      u: row.username,
      k: key,
      n: row.nickname,
      a: row.avatar || '',
      r: row.role || 'player',
      e: expMs
    };
  };

  if (row.auth_key) return cb(null, signToken(claimsOf(row.auth_key)));

  const key = newAuthKey();
  queries.setUserAuthKey(row.id, key, function (err) {
    if (err) return cb(err);
    cb(null, signToken(claimsOf(key)));
  });
}

// 按 token 里的身份把账号重建回来。
// 【为什么敢重建】token 有 HMAC 签名，里面的字段伪造不了；而且走到这里的前提是
//   **库里没有这个用户名**（同名已存在的情况在上层就返回了，绝不会覆盖别人）。
// 【密码怎么办】写一个没人知道的随机密码哈希：用户名被占住（别人抢不走），
//   用户继续靠 token 登录；想重新设密码走 auth.setPassword（同样凭 token）。
function restoreUser(claims, cb) {
  const salt = crypto.randomBytes(16).toString('hex');
  hashPassword(crypto.randomBytes(32).toString('hex'), salt, function (err, hash) {
    if (err) return cb(err);

    queries.createUser(claims.u, claims.n || claims.u, hash, salt, claims.k || newAuthKey(),
      function (createErr, row) {
        if (createErr) {
          // ★并发：同一枚 token 的两个请求会**同时**发现「库里没这个账号」而各自去重建 ——
          //   大厅页一进来就是这种并发（WS hello 与 /api/me 几乎同时发出），所以这不是罕见情况。
          //   输的那个会撞唯一索引（23505）。这里**不能一律拒绝**，必须回头读一次：
          //   密钥对得上 = 自己刚建好的那一个（正常）；对不上 = 名字被别人占了（才拒绝）。
          //   （第一版直接 return null，表现是「清库之后照样掉登录」—— 浏览器端脚本抓到的；
          //     逐个请求发的 HTTP 测试抓不到，因为它根本不并发。）
          if (createErr.code === '23505') {
            console.log('[auth] 重建撞上并发（同一 token 的另一路已建好），回头按密钥认一次 username=' + claims.u);
            return resolveClaims(claims, cb);
          }
          return cb(createErr);
        }
        console.log('[auth] ★账号已按 token 自证重建（多半是发布沙箱把数据回滚了）：' +
          'id=' + row.id + ' username=' + claims.u);
        // 头像/角色一并还原（token 里带着，且有签名可信任）。
        // 只在真的需要时才多打一次库：默认值就不用写了。
        const needAvatar = !!claims.a && claims.a !== (row.avatar || '');
        if (!needAvatar) return cb(null, publicUser(row));
        queries.setUserAvatar(row.id, claims.a, function () {
          row.avatar = claims.a;      // 写库失败也不影响这次登录，只是头像晚一轮才对
          cb(null, publicUser(row));
        });
      });
  });
}

// 拿到 claims 之后怎么认人。
function resolveClaims(claims, cb) {
  queries.findUserByUsername(claims.u, function (err, row) {
    if (err) return cb(err);

    if (row) {
      if (row.status !== 1) return cb(null, null);
      // ★账号密钥对不上 = 这枚 token 不属于当前这个同名账号（数据被清过、名字被别人注册了）
      if (String(row.auth_key || '') !== String(claims.k || '')) {
        console.log('[auth] token 的账号密钥与库里的不符，拒绝 username=' + claims.u);
        return cb(null, null);
      }
      return cb(null, publicUser(row));
    }

    restoreUser(claims, cb);
  });
}

// 对外返回的用户对象：永远是白名单字段，绝不带 password_hash / salt
function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    nickname: row.nickname,
    avatar: row.avatar || '',
    role: row.role || 'player'
  };
}

// 用户名规则：3-16 位，允许字母、数字、下划线、连字符与中文
const USERNAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]{3,16}$/;

// ============================================================
// 注册
// ============================================================
auth.register = function (username, nickname, password, ip, cb) {
  username = String(username || '').trim();
  nickname = String(nickname || '').trim() || username;
  password = String(password || '');

  if (!USERNAME_RE.test(username)) {
    return cb(null, { ok: false, code: 'BAD_USERNAME', msg: '用户名需 3-16 位字母、数字、下划线或中文' });
  }
  if (password.length < config.passwordMin) {
    return cb(null, { ok: false, code: 'BAD_PASSWORD', msg: '密码至少 ' + config.passwordMin + ' 位' });
  }
  if (nickname.length > config.nicknameMax) {
    return cb(null, { ok: false, code: 'BAD_NICKNAME', msg: '昵称最长 ' + config.nicknameMax + ' 个字符' });
  }

  queries.findUserByUsername(username, function (err, existing) {
    if (err) return cb(err);
    if (existing) {
      return cb(null, { ok: false, code: 'USERNAME_TAKEN', msg: '该用户名已被占用' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    // 账号密钥在建号时就一并生成并写入：之后签出来的 token 才能在被「按 token 重建」时对上号。
    const authKey = newAuthKey();
    hashPassword(password, salt, function (hashErr, hash) {
      if (hashErr) return cb(hashErr);

      queries.createUser(username, nickname, hash, salt, authKey, function (createErr, row) {
        if (createErr) {
          // 并发注册同一用户名时数据库唯一索引会报 23505
          if (createErr.code === '23505') {
            return cb(null, { ok: false, code: 'USERNAME_TAKEN', msg: '该用户名已被占用' });
          }
          return cb(createErr);
        }
        // row 里已经带 auth_key（见 createUser 的 RETURNING），buildSession 直接用它
        row.avatar = '';
        row.role = 'player';

        buildSession(row, ip, function (sessErr, token) {
          if (sessErr) return cb(sessErr);
          console.log('[auth] 新用户注册成功 id=' + row.id + ' username=' + username);
          cb(null, { ok: true, token: token, user: publicUser(row) });
        });
      });
    });
  });
};

// ============================================================
// 登录
// ============================================================
auth.login = function (username, password, ip, cb) {
  username = String(username || '').trim();
  password = String(password || '');

  if (!username || !password) {
    return cb(null, { ok: false, code: 'EMPTY', msg: '请输入用户名和密码' });
  }

  queries.findUserByUsername(username, function (err, row) {
    if (err) return cb(err);
    // 用户不存在与密码错误返回同一句提示，不泄露账号是否存在
    if (!row) {
      return cb(null, { ok: false, code: 'BAD_CREDENTIAL', msg: '用户名或密码错误' });
    }
    if (row.status !== 1) {
      return cb(null, { ok: false, code: 'BANNED', msg: '该账号已被封禁' });
    }

    hashPassword(password, row.salt, function (hashErr, hash) {
      if (hashErr) return cb(hashErr);
      if (!digestEqual(hash, row.password_hash)) {
        console.log('[auth] 登录失败（密码不匹配）username=' + username);
        return cb(null, { ok: false, code: 'BAD_CREDENTIAL', msg: '用户名或密码错误' });
      }

      buildSession(row, ip, function (sessErr, token) {
        if (sessErr) return cb(sessErr);
        queries.updateLastLogin(row.id, function () {
          console.log('[auth] 登录成功 id=' + row.id + ' username=' + username);
          cb(null, { ok: true, token: token, user: publicUser(row) });
        });
      });
    });
  });
};

// ============================================================
// 会话校验（HTTP 与 WebSocket 共用）
// ============================================================
auth.verifyToken = function (token, cb) {
  if (!token) return cb(null, null);

  // ---- ① 自证式 token（本轮新增，见文件上方那段注释）----
  const claims = parseToken(token);
  if (claims) return resolveClaims(claims, cb);
  // 形如 vs1. 但签名/有效期没过 → 直接不认，不要掉进下面的「查库」分支
  if (String(token).indexOf('vs1.') === 0) return cb(null, null);

  // ---- ② 老式随机 token（查 sessions 表；浏览器里可能还留着旧的）----
  queries.findSessionUser(token, function (err, row) {
    if (err) return cb(err);
    if (!row) return cb(null, null);
    if (row.status !== 1) return cb(null, null);

    // 过期判断在应用层做，原因见 queries.findSessionUser 的注释。
    //
    // 解析不出有效时间时**放行**，这是刻意的：会话有效期是 30 天这种量级，
    // 宁可让一个会话多活一会儿，也绝不能因为环境间的时间解析差异，
    // 把所有已登录的人一脚踢下线 —— 线上正是这么翻车的。
    const exp = row.expires_at;
    const expMs = exp instanceof Date ? exp.getTime() : Date.parse(exp);
    if (isFinite(expMs) && expMs <= Date.now()) return cb(null, null);
    if (!isFinite(expMs)) {
      console.log('[auth] 会话过期时间无法解析，按有效处理 token=' +
        String(token).slice(0, 8) + '… expires_at=' + JSON.stringify(exp));
    }

    cb(null, publicUser(row));
  });
};

// 凭 token 重设密码（不需要旧密码）。
//
// 【为什么必须有这个出口】账号被「按 token 重建」时，库里那个密码哈希是**随机写的、
// 谁都不知道**。用户能一直靠 token 玩，但一旦想「退出后用密码登录」就没门了 ——
// 重建就等于把账号锁死，那比掉线更糟。所以留这个口子：只要 token 有效，就能重设。
auth.setPassword = function (token, newPassword, cb) {
  newPassword = String(newPassword || '');
  if (newPassword.length < config.passwordMin) {
    return cb(null, { ok: false, code: 'BAD_PASSWORD', msg: '密码至少 ' + config.passwordMin + ' 位' });
  }

  auth.verifyToken(token, function (err, user) {
    if (err) return cb(err);
    if (!user) return cb(null, { ok: false, code: 'BAD_TOKEN', msg: '登录状态已失效，请重新登录' });

    const salt = crypto.randomBytes(16).toString('hex');
    hashPassword(newPassword, salt, function (hashErr, hash) {
      if (hashErr) return cb(hashErr);
      queries.setUserPassword(user.id, hash, salt, function (setErr) {
        if (setErr) return cb(setErr);
        console.log('[auth] 已凭 token 重设密码 id=' + user.id + ' username=' + user.username);
        cb(null, { ok: true, msg: '新密码已生效，下次可以用它登录' });
      });
    });
  });
};

auth.logout = function (token, cb) {
  if (!token) return cb(null, { ok: true });
  // 自证式 token 在库里没有行，删不掉也没关系 —— 客户端清掉本地那份就等于退出。
  // （老式随机 token 仍然照删，兼容浏览器里留着的旧凭证。）
  if (String(token).indexOf('vs1.') === 0) return cb(null, { ok: true });
  queries.deleteSession(token, function (err) {
    if (err) return cb(err);
    cb(null, { ok: true });
  });
};

// 从请求里取出 token。
//
// 【为什么首选自定义头 X-VS-Token，而不是标准的 Authorization】
// WorkBuddy「发布为应用」的沙箱前面有一层平台网关，实测它会**用平台自己的 JWT
// 覆盖掉 Authorization 头** —— 客户端发出去的是 71 字符的自有 token，服务端收到的
// 却是 386 字符的平台 JWT。于是服务端永远拿不到真正的会话 token，所有需要登录的
// 接口一律 401，「登录成功后立刻显示登录状态已失效」就是这么来的。
// 自定义头不在网关的处理范围内，能原样透传到应用。
//
// 查询参数 ?token= 作为第二道兜底（网关不会改写 query）；前端两个都带，
// 只要有一个能透传就能认证成功。Authorization / Cookie 保留在最后，
// 兼容本机直连与其它部署形态（那些环境里它才是标准做法）。
auth.extractToken = function (req) {
  const custom = req.headers['x-vs-token'];
  if (custom) return String(custom).trim();

  if (req.searchParams) {
    const q = req.searchParams.get('token');
    if (q) return String(q).trim();
  }

  const header = req.headers['authorization'] || '';
  if (header.indexOf('Bearer ') === 0) return header.slice(7).trim();
  const cookie = req.headers['cookie'] || '';
  const hit = cookie.match(/(?:^|;\s*)vs_token=([a-f0-9]{64})/);
  return hit ? hit[1] : '';
};

module.exports = auth;
