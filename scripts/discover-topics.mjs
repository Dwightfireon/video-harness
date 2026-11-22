#!/usr/bin/env node
/* 后台跑一次找选题，把结果写回作业文件。
 *
 * 单独一个进程的原因：检索要 1–3 分钟，不能让 HTTP 请求等。
 * 这个进程由 lib/discovery-job.mjs 派发，detached，工作台重启也不受影响。
 *
 * 参数：--root <仓库根> --job <作业 id>
 * 退出码只表示"这一轮结束"，结果看作业文件。
 */
import path from 'node:path';
import { readSchedule } from '../lib/schedule.mjs';
import { discoverTopics, DEFAULT_DISCOVERY } from '../lib/discovery.mjs';
import { finishJob, readJob } from '../lib/discovery-job.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = path.resolve(arg('root', process.cwd()));
const jobId = arg('job', '');

/* 进程自己查 SMTP 没意义；这里只做一件事，失败也写回作业文件。
 * 包装成 async IIFE：顶层 await 在 detached 子进程里没问题，但保持显式更清楚。 */
async function main() {
  const job = readJob(root);
  if (!job || job.id !== jobId) {
    // 作业已被替换：不写结果，避免旧任务覆盖新任务的状态。
    return 0;
  }
  const config = {
    ...DEFAULT_DISCOVERY,
    ...(readSchedule(root).discoveryConfig || {}),
  };
  if (job.query) config.query = job.query;
  if (job.count) config.count = job.count;
  if (job.model) config.model = job.model;
  if (job.agent) config.agent = job.agent;
  if (job.mode) config.mode = job.mode;
  if (job.timeoutMs) config.timeoutMs = job.timeoutMs;
  config.followupId = job.followupId;
  config.followup = job.followup;
  config.operation = job.operation || 'questions';
  config.topicId = job.topicId;
  if (job.followupId) { config.count = 1; config.mode = job.mode || 'focused'; }
  config.origin = 'manual';

  try {
    const result = await discoverTopics(root, config);
    finishJob(root, jobId, result.ok
      ? { state: 'done', added: result.added || [], results: result.results || [], updated: result.updated, candidates: result.candidates || 0, skipped: result.skipped || 0, materialRejected: result.materialRejected || 0, searchCount: result.searchCount || 0, recordPath: result.recordPath, warnings: result.warnings || [], ...(result.salvaged ? { salvaged: true } : {}) }
      : { state: 'failed', reason: result.reason || '检索失败', raw: result.raw || null, hints: result.hints || [], searchFailures: result.searchFailures || [] });
    return result.ok ? 0 : 1;
  } catch (error) {
    finishJob(root, jobId, { state: 'failed', reason: error.message || '检索异常' });
    return 1;
  }
}

main().then(code => process.exit(code)).catch(error => {
  try { finishJob(root, jobId, { state: 'failed', reason: error.message }); } catch {}
  process.exit(1);
});
