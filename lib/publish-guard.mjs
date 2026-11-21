/* 投稿防护：防止「手抖重复提交」与「被风控后继续重试」。
 *
 * 为什么单独一层：
 *   B 站的投稿接口有两类失败看起来一样，处置完全相反——
 *     - 未提交（申请上传线路被拒、分区失效）→ 可以改完再试
 *     - 已提交 / 结果未知（提交后断网）→ 再点一次就会出重复稿件
 *   只靠界面按钮禁用挡不住：刷新页面、换标签页、跑批量都会绕过。
 *
 * 这一层不依赖 Electron、网络；写入由共同事务在账号锁内调用：
 *   1. 把错误归成「可以重试 / 必须等待 / 结果未知」
 *   2. 记录每次投稿尝试（时间、视频指纹、结果），跨进程可读
 *   3. 判断现在能不能提交：冷却中、同一支已成功发过
 *
 * 新记录放在账号私有状态目录的 out/ 下，旧仓库 out/ 日志仍读取保护，权限 600。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const JOURNAL_FILE = 'out/.vh-publish-journal.json';
/* B 站没有公布风控窗口；这里用保守值，并在界面写明「保守等待」，
 * 不声称这是官方限制。 */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
// Kept for callers of the old API; safety history is no longer truncated.
export const MAX_ENTRIES = 200;

/* 错误归因。返回 kind 决定界面说什么、按钮能不能点。 */
export function classifyPublishError(error) {
  const message = String(error?.message || error || '');
  /* httpStatus 只在上传/请求层抛错时有；service.submit 把错误码放在 code 里。
   * 两处都要看，否则 406 风控会被归成 "other"，界面就会建议"直接重试"。 */
  const status = Number(error?.httpStatus || error?.status || 0) ||
    ([406, 412, 401, 403].includes(Number(error?.code)) ? Number(error.code) : 0);
  const code = error?.code;

  // 风控/频控：B 站常以 406 + 中文提示返回，也可能藏在 code 里。
  if (error?.outcome === 'unknown' || error?.outcome === 'submitting') {
    return { kind: 'unknown', retryable: false,
      advice: '提交结果未知，先到稿件管理人工核对；不能自动重发。' };
  }
  if (status === 406 && /过快|休息|频繁|too fast|frequent/i.test(message)) {
    return { kind: 'rate', retryable: true, waitMs: DEFAULT_COOLDOWN_MS,
      advice: 'B 站风控：短时间内提交太多次。没有稿件被创建，等一段时间再点提交即可。' };
  }
  // 406 但提示不是"过快"时，B 站也可能用它表示请求被拒；同样按风控处理，宁可按账号级冷却。
  if (status === 406) {
    return { kind: 'rate', retryable: true, waitMs: DEFAULT_COOLDOWN_MS,
      advice: '服务端返回 406（请求被拒）。先别连续重试；等一段时间，或到创作中心确认账号状态。' };
  }
  if (/过快|稍作休息|频繁/.test(message)) {
    return { kind: 'rate', retryable: true, waitMs: DEFAULT_COOLDOWN_MS,
      advice: '服务端要求放慢节奏。没有稿件被创建，等一段时间再试。' };
  }
  if (status === 412 || code === -412) {
    return { kind: 'risk', retryable: false, waitMs: 30 * 60 * 1000,
      advice: 'B 站风控拦截（-412）。通常是登录态或设备标识异常，先到创作中心确认账号状态。' };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', retryable: false, advice: '登录态无效或已过期，重新扫码登录后再试。' };
  }
  if (error?.outcome === 'rejected') {
    return { kind: 'rejected', retryable: true, advice: '服务端明确拒绝，没有生成稿件。按提示改内容后可以再试。' };
  }
  return { kind: 'other', retryable: true, advice: '' };
}

/* 身份不依赖标题；流式计算全部字节，不让相同首兆的不同成片混淆。 */
export function videoFingerprint(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    if (!fs.fstatSync(fd).isFile()) return null;
    const hash = crypto.createHash('sha256'), block = Buffer.alloc(1 << 20);
    let count;
    while ((count = fs.readSync(fd, block, 0, block.length, null))) hash.update(block.subarray(0, count));
    return hash.digest('hex');
  } catch { return null; }
  finally { try { fs.closeSync(fd); } catch {} }
}

/* 提交时的完整身份必须重新读取，但不能同步阻塞整个 HTTP 服务。 */
export async function videoFingerprintAsync(file) {
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const before = await handle.stat();
    if (!before.isFile()) return null;
    const hash = crypto.createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 });
    for await (const block of stream) hash.update(block);
    const after = await handle.stat();
    const current = await fs.promises.stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
        current.dev !== after.dev || current.ino !== after.ino || current.size !== after.size || current.mtimeMs !== after.mtimeMs) return null;
    return hash.digest('hex');
  } catch { return null; }
  finally { try { await handle?.close(); } catch {} }
}

// 仅用于兼容旧回执，绝不作为新尝试的媒体身份。
export function legacyVideoFingerprint(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd), head = Buffer.alloc(Math.min(1 << 20, stat.size));
    fs.readSync(fd, head, 0, head.length, 0);
    return crypto.createHash('sha256').update(String(stat.size)).update(head).digest('hex').slice(0, 16);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function journalPath(root) { return path.join(root, JOURNAL_FILE); }

export function readJournal(root) {
  let fd;
  try {
    fd = fs.openSync(journalPath(root), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('invalid journal');
    const data = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (data?.version !== 1 || !Array.isArray(data.entries) || data.entries.some(item =>
      !item || !Number.isFinite(item.at) || typeof item.project !== 'string' ||
      !['submitting', 'submitted', 'unknown', 'rejected', 'not-submitted'].includes(item.outcome) ||
      (item.fingerprint != null && typeof item.fingerprint !== 'string'))) throw new Error('invalid journal');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: [] };
    throw Object.assign(new Error('投稿日志损坏或不可读：已阻止提交，请保留日志并人工核对稿件，不能按空记录重发。'), { code: 'PUBLISH_JOURNAL_INVALID' });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeJournal(root, journal) {
  const file = journalPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  // 不裁掉未知或成功记录，否则时间久了会重新允许重复投稿。
  const trimmed = { version: 1, entries: journal.entries };
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(trimmed, null, 1)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return trimmed;
}

export function recordAttempt(root, { project, attemptId = crypto.randomUUID(), bvid = null, title = '', fingerprint = null, outcome, kind = null, message = '', declaration }) {
  const journal = readJournal(root);
  journal.entries.push({
    at: Date.now(), project, attemptId, bvid, title, fingerprint,
    outcome, kind, message: String(message).slice(0, 300),
    ...(declaration ? { declaration } : {}),
  });
  return writeJournal(root, journal);
}

// 调用方必须在同一账号锁内完成 read → write，不允许提交后吞掉写入错误。
export function finishAttempt(root, attemptId, { outcome, kind = null, bvid = null, declaration }) {
  const journal = readJournal(root);
  const entry = journal.entries.find(item => item.attemptId === attemptId);
  if (!entry || entry.outcome !== 'submitting') throw new Error('投稿尝试回执缺失：请人工核对，禁止重发');
  Object.assign(entry, { outcome, kind, bvid, finishedAt: Date.now() });
  if (declaration) entry.declaration = declaration;
  return writeJournal(root, journal);
}

/* 现在是能不能提交？只回答"能不能"和"为什么不能"，不替用户改任何东西。 */
export function checkBeforePublish(root, { project, fingerprint, fingerprints = [fingerprint], now = Date.now() }) {
  const journal = readJournal(root);
  const entries = journal.entries;

  const unknown = [...entries].reverse().find(item => ['unknown', 'submitting'].includes(item.outcome));
  if (unknown) return { ok: false, reason: 'unknown', at: unknown.at,
    message: '上次提交结果未知。先去 B 站「稿件管理」人工核对；等待不会自动解除，普通确认不能重发。BV 核对入口只查询，不自动解锁。' };

  /* 1) 冷却：最近一次 rate 类失败的后退时间未过。
   * 只看最近一次 rate，成功的提交不产生冷却。 */
  const lastRate = [...entries].reverse().find(item => item.kind === 'rate');
  if (lastRate) {
    const until = lastRate.at + DEFAULT_COOLDOWN_MS;
    if (now < until) {
      return { ok: false, reason: 'cooldown', until, waitMs: until - now,
        message: '上次提交被平台要求放慢节奏。保守等待到 ' + new Date(until).toLocaleTimeString('zh-CN') + ' 再试。' };
    }
  }

  /* 2) 没有单独的重复授权 UX，普通 confirmed 不能解除重复保护。 */
  if (fingerprints.some(Boolean)) {
    const posted = [...entries].reverse().find(item => fingerprints.includes(item.fingerprint) && item.fingerprint && item.outcome === 'submitted');
    if (posted) {
      return { ok: false, reason: 'duplicate', at: posted.at, bvid: posted.bvid,
        message: '同一支成片已经提交过（' + (posted.bvid ? 'BV ' + posted.bvid : '当时没拿到 BV 号') +
          '，' + new Date(posted.at).toLocaleString('zh-CN') + '）。当前没有单独的重复投稿授权入口，已阻止重发。' };
    }
  }

  return { ok: true };
}

/* 给界面用的摘要：不暴露正文，只说"发过几次、最后一支是什么"。 */
export function journalSummary(root, project, { limit = 5 } = {}) {
  const entries = readJournal(root).entries.filter(item => item.project === project).slice(-limit);
  return entries.map(item => ({
    at: item.at, bvid: item.bvid, outcome: item.outcome, kind: item.kind,
    title: String(item.title || '').slice(0, 40),
  }));
}
