/* 找选题的作业队列：一次只跑一个，界面不等结果。
 *
 * 为什么改成异步：一次检索要起 opencode 会话、联网搜、等模型整理成 JSON，
 * 实测 50 秒到 3 分钟。原来的同步接口让浏览器干等，15 秒就误报超时。
 *
 * 状态存在项目外的临时文件里（out/.vh-discovery.json），三态：
 *   running  子进程还活着
 *   done     搜到并保存为候选（手动选择后入队）
 *   failed   没搜到（超时、模型答非所问、opencode 退出非零）
 *
 * 判定「还在跑」以 pid 为准，不是只看文件里写的 state——
 * 进程被系统杀掉时文件来不及更新，只看 state 会永远显示"搜索中"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export const JOB_FILE = 'out/.vh-discovery.json';
/* 超时判定比子进程自己的 timeoutMs 再宽一点：
 * 子进程要在超时后杀 opencode 进程组、写结果，需要一点余量。 */
const LEASE_GRACE_MS = 120000;
/* 默认与 lib/discovery.mjs 保持一致：一轮含多次检索和原文读取，实测约 300 秒。 */
const DEFAULT_TIMEOUT_MS = 480000;

const jobPath = root => path.join(root, JOB_FILE);

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function writeJob(root, job) {
  const file = jobPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(job, null, 1), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return job;
}

/* 读作业状态。只做一次判定，不写盘：读接口不该有副作用。 */
export function readJob(root, now = Date.now()) {
  let job;
  try { job = JSON.parse(fs.readFileSync(jobPath(root), 'utf8')); } catch { return null; }
  if (!job || typeof job !== 'object' || typeof job.id !== 'string') return null;
  if (job.state !== 'running') return job;

  const timeoutAt = (job.startedAt || 0) + (job.timeoutMs || DEFAULT_TIMEOUT_MS) + LEASE_GRACE_MS;
  if (now > timeoutAt) {
    return { ...job, state: 'failed', reason: '检索超时（进程可能已退出但没写回结果）', finishedAt: now };
  }
  // 有 pid 就以进程为准；没有 pid（刚启动还没写）按时间租期判断。
  if (job.pid && !alive(job.pid)) {
    return { ...job, state: 'failed', reason: '检索进程已退出但没有写回结果', finishedAt: now };
  }
  return job;
}

/* 子进程写结果用。只接受同一作业 id，防止旧进程覆盖新作业。 */
export function finishJob(root, id, patch) {
  const current = readJob(root);
  if (!current || current.id !== id) return null;
  return writeJob(root, { ...current, ...patch, state: patch.state || 'done', finishedAt: Date.now() });
}

export function startJob(root, { query, count, model, agent, timeoutMs, mode, followupId, followup, operation = 'questions', topicId } = {}, { spawnImpl = spawn, executable = process.execPath, script } = {}) {
  const running = readJob(root);
  if (running?.state === 'running') return { busy: true, job: running };

  const job = {
    id: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    pid: null,
    query: query || null,
    operation,
    topicId: topicId || null,
    count: followupId ? 1 : count || null,
    model: model || null,
    agent: agent || null,
    timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS,
    mode: mode || 'focused',
    followupId: followupId || null,
    followup: followup || null,
    added: [],
  };
  writeJob(root, job);

  const runner = script || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'scripts', 'discover-topics.mjs');
  const child = spawnImpl(executable, [runner, '--root', root, '--job', job.id], { detached: true, stdio: 'ignore' });
  child.on?.('error', () => {});
  child.unref?.();
  if (child.pid) writeJob(root, { ...job, pid: child.pid });
  return { busy: false, job: { ...job, pid: child.pid || null } };
}

/* 给界面的一句话：说清"现在能不能再点"，不解释实现。 */
export function describeJob(job, now = Date.now()) {
  if (!job) return { state: 'idle', text: '还没有搜过' };
  if (job.operation === 'research') {
    if (job.state === 'running') return { state: 'running', elapsed: Math.max(0, Math.round((now - job.startedAt) / 1000)), text: '正在调查这条问题，检索并读取原文线索…' };
    if (job.state === 'done') return { state: 'done', suggested: 0, added: 0, text: '调查结果已保存到原问题；未替换问题或自动入队' };
    return { state: 'failed', text: job.reason || '调查执行失败，原问题和已有材料保留', hints: job.hints || [] };
  }
  const single = job.followupId && ['different', 'deeper'].includes(job.followup) && !(job.count > 1) && !(job.results?.length > 1);
  const label = job.followup === 'deeper' ? '深入子问题' : '不同切口';
  if (job.state === 'running') {
    const elapsed = Math.max(0, Math.round((now - (job.startedAt || now)) / 1000));
    /* 实测含多次检索 + 多篇原文：成功的两轮 221–257 秒，失败那轮 955 秒。
     * 写"3–5 分钟"会让用户在还正常的进度里以为卡死，也会掩盖真正的慢。 */
    return { state: 'running', elapsed, text: `${single ? `正在为这条选题寻找${label}` : '正在构思具体问题'}… 已用 ${elapsed} 秒（有执行时限，不会无限等）` };
  }
  if (job.state === 'done') {
    const suggested = job.results?.length || 0;
    /* 超时后才到的结果要如实说晚到了，不能混进"正常完成"的文案。 */
    const late = job.salvaged ? '（超出预算才完成，已请求停止执行器；完整问题已保存，尚未调查）' : '';
    return { state: 'done', added: job.added?.length || 0, ...(job.salvaged ? { salvaged: true } : {}),
      suggested, text: (single ? suggested ? `找到一个${label}建议，采用后成为候选；未自动替换或入队` : '这条选题暂未找到合适的新建议，原题与旧建议保持不变' : job.added?.length ? `新增 ${job.added.length} 个选题` : suggested ? `提出 ${suggested} 个问题，调查后可加入队列` : '这次没有合适的新问题，可以换个方向再找') + late };
  }
  return { state: 'failed', text: single ? `这条选题的${label}建议检索失败：${job.reason || '请稍后再试'}；原题与旧建议保持不变` : job.reason || '检索失败',
    hints: Array.isArray(job.hints) ? job.hints : [] };
}
