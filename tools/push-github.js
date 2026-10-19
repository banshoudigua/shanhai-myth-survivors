// tools/push-github.js —— 网络受限时的推送通道（git push 走不通时用它）
//
// 【为什么需要它】本机 git 走不了 github：
//   · 走代理 → `CONNECT tunnel failed, response 502`
//   · 绕过代理直连 → `Could not connect to server (443)`
//   而 `gh api` 是通的（gh 有自己的网络通道）。所以改走 GitHub 的 **Git Data API**：
//   blob → tree → commit → ref，四步把整棵树推上去，效果等同一次 git push。
//
// 【前置条件】仓库不能是**完全空的** —— GitHub 对没有任何 ref 的仓库
//   直接回 `Git Repository is empty. (HTTP 409)`（连 git 对象库都还没建）。
//   先放一个种子文件建出 main，再跑本脚本（脚本会读 main 的 commit 当父节点）。
//
// 【代价（如实记）】
//   ① 逐文件请求，121 个文件约 5 分钟（比 git 打包传输慢得多）；
//   ② tree 与内容**逐字节一致**，但 commit SHA 与本地那次不同 →
//      本地与远端没有共同历史。以后网络恢复能正常 git push 时，
//      先 `git fetch origin && git reset --hard origin/main`，否则会被拒（历史不相干）。
//
// 用法：node tools/push-github.js <owner/repo> [分支]

const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = process.argv[2];
const BRANCH = process.argv[3] || 'main';
const ROOT = path.join(__dirname, '..');

if (!REPO) {
  console.error('用法：node tools/_push-github.js <owner/repo> [分支]');
  process.exit(1);
}

// 调 gh api，body 走 stdin（大文件 base64 放不进命令行参数 —— Windows 上限 32K）
function ghApi(method, endpoint, body) {
  return new Promise(function (resolve, reject) {
    const args = ['api', '--method', method, endpoint];
    if (body) args.push('--input', '-');
    const p = spawn('gh', args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', function (d) { out += d; });
    p.stderr.on('data', function (d) { err += d; });
    p.on('error', reject);
    p.on('close', function (code) {
      if (code !== 0) {
        // 把 GitHub 返回的错误体带出来，否则只知道「失败了」不知道原因
        reject(new Error(method + ' ' + endpoint + ' 失败(' + code + ')：' + (err || out).slice(0, 500)));
        return;
      }
      let parsed = null;
      try { parsed = JSON.parse(out); } catch (e) { parsed = { raw: out }; }
      resolve(parsed);
    });
    if (body) p.stdin.end(JSON.stringify(body));
    else p.stdin.end();
  });
}

function listFiles() {
  // -z：用 \0 分隔。中文文件名若按行读会被 git 加引号转义（"规划方案.md"），
  // 那种路径拿去调 API 会直接 404。
  const raw = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return raw.toString('utf8').split('\0').filter(function (f) { return f; });
}

const files = listFiles();
console.log('[push] 待上传 ' + files.length + ' 个文件 → ' + REPO + ' (' + BRANCH + ')');

// ---- 1) 逐个建 blob ----
const entries = [];
let done = 0;
let idx = 0;

function nextBlob() {
  if (idx >= files.length) return Promise.resolve();
  const rel = files[idx++];
  const abs = path.join(ROOT, rel);
  const buf = fs.readFileSync(abs);

  return ghApi('POST', '/repos/' + REPO + '/git/blobs', {
    content: buf.toString('base64'),
    encoding: 'base64'
  }).then(function (res) {
    if (!res || !res.sha) throw new Error('blob 无 sha：' + rel + ' → ' + JSON.stringify(res).slice(0, 200));
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: res.sha });
    done++;
    if (done % 20 === 0 || done === files.length) {
      console.log('  blob ' + done + '/' + files.length + '  (' + rel + ')');
    }
    return nextBlob();
  });
}

// ---- 2) tree → 3) commit → 4) ref ----
let commitSha = null;
let parentSha = null;

// ★★空仓库不能用 Git Data API：GitHub 对「没有任何 ref 的仓库」直接回
//   `Git Repository is empty. (HTTP 409)` —— 因为它连 git 对象库都还没建。
//   所以必须先用 Contents API 放一个种子文件（本脚本外部做过），让 main 分支存在，
//   再把它的 commit 当作父节点。这一步漏了的话，第一次建 blob 就 409。
ghApi('GET', '/repos/' + REPO + '/git/ref/heads/' + BRANCH)
  .then(function (ref) {
    parentSha = ref && ref.object && ref.object.sha;
    if (!parentSha) throw new Error('取不到 ' + BRANCH + ' 的当前 commit');
    console.log('[push] 父提交 = ' + parentSha);
    return nextBlob();
  })
  .then(function () {
    console.log('[push] 建 tree（' + entries.length + ' 项）…');
    return ghApi('POST', '/repos/' + REPO + '/git/trees', { tree: entries });
  })
  .then(function (tree) {
    if (!tree || !tree.sha) throw new Error('tree 无 sha：' + JSON.stringify(tree).slice(0, 300));
    console.log('[push] tree = ' + tree.sha);

    // commit message 与本地那次提交保持一致
    let msg = '山海神话传：多人合作生存网页游戏（初始开源提交）';
    try {
      msg = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: ROOT }).toString('utf8').trim();
    } catch (e) {
      // 取不到就用上面的默认文案 —— 提交信息不该成为阻塞项
    }

    return ghApi('POST', '/repos/' + REPO + '/git/commits', {
      message: msg,
      tree: tree.sha,
      // ★父节点必须是已有的 commit，否则是「孤儿提交」，
      //   推上去之后 ref 会指向它，但 GitHub 会把它当作与历史无关的另一棵树。
      parents: [parentSha]
    });
  })
  .then(function (commit) {
    if (!commit || !commit.sha) throw new Error('commit 无 sha：' + JSON.stringify(commit).slice(0, 300));
    commitSha = commit.sha;
    console.log('[push] commit = ' + commitSha);
    // ★更新已有分支用 PATCH；用 POST /git/refs 会因为 main 已存在而报 422
    return ghApi('PATCH', '/repos/' + REPO + '/git/refs/heads/' + BRANCH, {
      sha: commitSha,
      force: false
    });
  })
  .then(function () {
    console.log('');
    console.log('[push] ✅ 完成');
    console.log('      仓库： https://github.com/' + REPO);
    console.log('      提交： ' + commitSha);
    console.log('');
    console.log('⚠️ 本地 git 与远端没有共同历史（内容一致、SHA 不同）。');
    console.log('   以后网络恢复正常能做 git push 时，先执行：');
    console.log('     git fetch origin && git reset --hard origin/' + BRANCH);
  })
  .catch(function (e) {
    console.error('[push] ❌ ' + (e && e.message ? e.message : e));
    process.exit(1);
  });