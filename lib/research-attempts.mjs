/* Acquisition history, not a fact-verification receipt. Append-only events keep
 * retries across resumes; worklog deduplication and raw-file counts cannot.
 * Only hashes of URLs/assertions are stored (URLs can contain credentials).
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const ACQUISITION_FAILURE_LIMIT = 2;
export const researchAttemptFile = project => path.join(project, 'out/.vh-research-attempts.jsonl');
const hash = value => createHash('sha256').update(value).digest('hex');
const assertionKey = value => typeof value === 'string' && value.trim()
  ? hash(value.normalize('NFKC').replace(/\s+/gu, ' ').trim()) : null;
const urlKey = value => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('抓取只接受 HTTP/HTTPS URL');
  url.hash = '';
  return hash(url.href);
};

function readEvents(project) {
  const file = researchAttemptFile(project);
  let fd;
  try {
    const out = fs.lstatSync(path.join(project, 'out'));
    if (!out.isDirectory() || out.isSymbolicLink()) throw new Error('抓取记录目录必须是普通目录');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('抓取记录不是普通文件或过大');
    return fs.readFileSync(fd, 'utf8').split('\n').filter(Boolean).map(line => {
      const row = JSON.parse(line);
      if (row.version !== 1 || typeof row.id !== 'string' ||
        !['started', 'fetched', 'unavailable'].includes(row.outcome) ||
        !/^[a-f0-9]{64}$/.test(row.urlKey) ||
        !(row.assertionKey === null || /^[a-f0-9]{64}$/.test(row.assertionKey)))
        throw new Error('抓取记录格式损坏');
      return row;
    });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function append(project, event) {
  const out = path.join(project, 'out');
  fs.mkdirSync(out, { recursive: true });
  const stat = fs.lstatSync(out);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('抓取记录目录必须是普通目录');
  const fd = fs.openSync(researchAttemptFile(project), fs.constants.O_WRONLY | fs.constants.O_APPEND |
    fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('抓取记录必须是普通文件');
    fs.writeFileSync(fd, JSON.stringify({ version: 1, ...event, at: Date.now() }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

export function researchAttempts(project) {
  const settled = new Map();
  for (const event of readEvents(project)) {
    settled.delete(event.id);
    settled.set(event.id, event);
  }
  return [...settled.values()];
}

function stopped(rows) {
  let failures = 0, unknown = 0;
  for (const row of rows) {
    if (row.outcome === 'fetched') { failures = 0; unknown = 0; }
    else if (row.outcome === 'unavailable') failures++;
    else unknown++;
  }
  return { failures, unknown, blocked: failures + unknown >= ACQUISITION_FAILURE_LIMIT };
}

export function researchAttemptStatus(project, { url, assertion } = {}) {
  const rows = researchAttempts(project), source = urlKey(url), claim = assertionKey(assertion);
  const sourceState = stopped(rows.filter(row => row.urlKey === source));
  const claimState = claim ? stopped(rows.filter(row => row.assertionKey === claim)) : null;
  const scope = claimState?.blocked ? '同一断言' : '同一来源';
  const state = claimState?.blocked ? claimState : sourceState;
  return { ...state, scope, urlKey: source, assertionKey: claim };
}

export function beginResearchAttempt(project, args) {
  const status = researchAttemptStatus(project, args);
  if (status.blocked) return { blocked: true, message: `拒绝：${status.scope}已有 ${status.failures} 次连续抓取失败` +
    (status.unknown ? `、${status.unknown} 次结果未落盘或仍在执行` : '') +
    '；未再次联网。请使用已有原文，或把该细节标为待核/删去后继续写稿。新断言和其他可用来源仍可抓取。' };
  const ticket = { id: randomUUID(), urlKey: status.urlKey, assertionKey: status.assertionKey };
  append(project, { ...ticket, outcome: 'started' });
  return { blocked: false, ticket };
}

export function finishResearchAttempt(project, ticket, { ok, failureCode = 'network' }) {
  append(project, { ...ticket, outcome: ok ? 'fetched' : 'unavailable',
    failureCode: ok ? null : /^(http-\d{3}|timeout|short-body|network|cancelled)$/.test(failureCode) ? failureCode : 'network' });
}

export function verificationBudgetNote(project) {
  try {
    const rows = researchAttempts(project);
    const scopes = new Map();
    for (const row of rows) {
      for (const field of ['urlKey', 'assertionKey']) {
        if (!row[field]) continue;
        const key = field + ':' + row[field].slice(0, 10);
        const state = scopes.get(key) || { failures: 0, unknown: 0 };
        if (row.outcome === 'fetched') { state.failures = 0; state.unknown = 0; }
        else if (row.outcome === 'unavailable') state.failures++;
        else state.unknown++;
        scopes.set(key, state);
      }
    }
    const stoppedScopes = [...scopes].filter(([, state]) => state.failures + state.unknown >= ACQUISITION_FAILURE_LIMIT).map(([key]) => key);
    if (!stoppedScopes.length) return '';
    return '\n【抓取防循环】' + stoppedScopes.slice(0, 6).join('、') +
      ' 已连续失败或结果未知；执行端会拒绝这些范围的重复请求。改用已有资料，或标待核/删细节，继续写稿。' +
      '没有全项目次数上限；新问题仍可核证。抓取成功仅代表取得正文，不证明来源支持断言。';
  } catch {
    return '\n【抓取记录不可读】不能声称次数为零；重复抓取保护无法核对，先保留记录并继续整理已有资料。';
  }
}
