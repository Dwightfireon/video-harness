/* Explicit unattended production policy. No model calls, human checkmarks or publishing. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { currentArtifactInputs } from './artifact-status.mjs';
import { isReviewRequest } from './review-request.mjs';
import { classifyProductionFailure } from './production-failure.mjs';
export { classifyProductionFailure } from './production-failure.mjs';

export function productionRepairObservation(project) {
  const current = currentArtifactInputs(project);
  const extra = ['方案.md', 'claims.json', '发布文案.md'].map(name => {
    try { return [name, createHash('sha256').update(fs.readFileSync(path.join(project, name))).digest('hex')]; }
    catch (error) { return [name, error.code || 'unreadable']; }
  });
  return { signature: createHash('sha256').update(JSON.stringify([current.sourceSignature, extra])).digest('hex'),
    inputs: { ...current.sourceHashes, ...Object.fromEntries(extra) } };
}
export function productionRepairSignature(project) { return productionRepairObservation(project).signature; }

export function automationPolicy(project, override) {
  let value = override;
  if (value === undefined) {
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { enabled: false, maxRepairs: 2 }; throw error; }
    value = metadata.automation;
  }
  if (value === undefined || value === false) return { enabled: false, maxRepairs: 2 };
  if (value === true) value = { enabled: true };
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new Error('automation.enabled 必须是布尔值');
  const maxRepairs = value.maxRepairs ?? 2;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 5) throw new Error('automation.maxRepairs 必须为 0–5 的整数');
  return { enabled: value.enabled, maxRepairs };
}

/* Web production is automatic without a prerequisite CLI switch. Keep explicit
 * project opt-outs and single-scope/read-only requests intact. Never change an
 * in-flight worker's policy when the browser refreshes or sends steering. */
export function webAutomationPolicy(project, mode, instruction = '') {
  // Requested-task CLI workers also call this function. Their exact persisted
  // active policy wins over future project defaults (including extensions).
  // Do not let an unrelated CLI/server process borrow another task's policy.
  const requested = process.argv.indexOf('--task-id'), attempt = process.argv.indexOf('--attempt-id');
  if (requested >= 0 && attempt >= 0) {
    let task;
    try { task = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8')); } catch {}
    if (task?.id === process.argv[requested + 1] && task.attemptId === process.argv[attempt + 1] &&
      ['starting', 'running'].includes(task.status) && task.mode === mode && task.automation?.enabled) {
      return automationPolicy(project, task.automation);
    }
  }
  if (!['article', 'topic', 'edit'].includes(mode) || mode === 'edit' && (isReviewRequest(instruction) || /先(?:讨论|检查资料|只读|分析)|不要(?:写|修改|执行)/.test(instruction))) return { enabled: false, maxRepairs: 2 };
  let metadata;
  try { metadata = JSON.parse(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; metadata = {}; }
  return automationPolicy(project, metadata.automation ?? true);
}

export function configureAutomation(project, policy) {
  const checked = automationPolicy(project, policy), file = path.join(project, 'PROJECT.json');
  const before = fs.readFileSync(file, 'utf8'), data = JSON.parse(before);
  const backups = path.join(project, 'out/.vh-automation-backups'); fs.mkdirSync(backups, { recursive: true });
  fs.writeFileSync(path.join(backups, randomUUID() + '.json'), before, { flag: 'wx', mode: 0o600 });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify({ ...data, automation: checked }, null, 2) + '\n', { flag: 'wx' });
    if (fs.readFileSync(file, 'utf8') !== before) throw new Error('保存自动制作设置期间项目配置已改变，未覆盖');
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return checked;
}

export function automationWriteRefusal(project, relative, next) {
  if (relative !== 'PROJECT.json') return null;
  try {
    const before = JSON.parse(fs.readFileSync(path.join(project, relative), 'utf8'));
    if (JSON.stringify(before.automation) !== JSON.stringify(JSON.parse(next).automation)) return '制作模型不能修改自动制作策略或提高修复预算；由用户通过 vh automation 配置';
  } catch { return '项目配置必须为合法 JSON，不得破坏自动制作策略'; }
  return null;
}

/* 时长超限是「连续逼近」型问题：每削一刀都会得到一个新的、更小的超限量。
 * 真实事故：一轮把 493.74s 削到 482.08s（省了 11.66 秒，方向完全正确），
 * 却因为「又出现一次超限」被记成第二次失败、耗尽 2 轮预算并被锁死 ——
 * 只差 2.08 秒。同一类问题在**确实变好**时不该再扣额度。 */
export function durationOvershoot(reason) {
  const lines = String(reason).split('\n');
  // Decode only the known duration-limit diagnostic head, never a quoted
  // caption, arbitrary prose, or a quality-check JSON message.
  const pattern = /^\s*(?:(?:✗|⛔|FAIL)\s+)?(?:【时长超限，禁止继续渲染】)?(时间轴|配音实测|配音时长|渲染时间轴|混流时间轴|静音成片|配音成片|实际成片|成片)\s+([\d.]+)\s*秒，超过当前上限\s*([\d.]+)\s*秒/;
  const matches = lines.map(line => pattern.exec(line)).filter(Boolean);
  if (matches.length !== 1 || lines.some(line => /^\s*FAIL\s+/.test(line) && !pattern.test(line))) return null;
  const [, basis, rawDuration, rawLimit] = matches[0], duration = Number(rawDuration), limit = Number(rawLimit);
  if (!Number.isFinite(duration) || !Number.isFinite(limit) || limit <= 0 || duration <= limit) return null;
  return { code: 'duration-limit', basis, duration, limit, over: duration - limit };
}

function validDurationIssue(issue) {
  return issue?.code === 'duration-limit' && typeof issue.basis === 'string' && !!issue.basis &&
    Number.isFinite(issue.duration) && Number.isFinite(issue.limit) && issue.limit > 0 && issue.duration > issue.limit &&
    Number.isFinite(issue.over) && Math.abs(issue.over - (issue.duration - issue.limit)) < 1e-8;
}

/* This ledger is checkpointed across resume; a successful patch cannot reset the budget. */
export function productionFailure(ledger = {}, { stage, reason, sourceSignature, maxRepairs = 2, stageResult, quality }) {
  const history = Array.isArray(ledger.history) ? ledger.history : [];
  const kind = classifyProductionFailure(reason, { stage, stageResult, quality });
  const key = createHash('sha256').update(stage + '\0' + sourceSignature + '\0' + reason).digest('hex');
  const stopped = { stoppedSignature: sourceSignature, stoppedKind: kind, stoppedStage: stage, stoppedReason: reason };
  if (kind !== 'content') return { ...ledger, ...stopped, history, stop: `阶段 ${stage} ${kind === 'environment' ? '环境/检查器失败' : '失败原因不明'}，未盲目重试：${reason}`, pending: null };
  if (history.some(item => item.key === key)) return { ...ledger, ...stopped, history, stop: `阶段 ${stage} 输入未变且同一问题再次失败，停止原样重跑：${reason}`, pending: null };
  /* 时长在缩短就不算「又失败一次」：历史里同阶段、同样是时长超限、且这次
   * 超得更少，说明上一轮修改真的生效了。额度留给真正卡住的情况。 */
  const overshoot = durationOvershoot(reason);
  // Old ledger entries lack structured durationIssue; parse their known
  // diagnostic at this compatibility boundary, not arbitrary topic text.
  let previousOvershoot = null;
  for (const item of [...history].reverse().filter(item => item.stage === stage)) {
    if (Object.hasOwn(item, 'durationIssue')) {
      previousOvershoot = validDurationIssue(item.durationIssue) ? item.durationIssue : null;
      break; // A damaged explicit observation must not fall back to older evidence.
    }
    previousOvershoot = durationOvershoot(item.reason);
    if (previousOvershoot) break;
  }
  const converging = validDurationIssue(overshoot) && validDurationIssue(previousOvershoot) &&
    overshoot.basis === previousOvershoot.basis && overshoot.limit === previousOvershoot.limit &&
    Number.isFinite(previousOvershoot.over) && overshoot.over < previousOvershoot.over;
  if (history.length >= maxRepairs && !converging) {
    return { ...ledger, ...stopped, history, stop: `自动修复已达到 ${maxRepairs} 轮上限；保留现场，不降低质量门槛：阶段 ${stage}：${reason}`, pending: null };
  }
  const pending = { key, stage, reason: reason.slice(0, 4000), sourceSignature, converging: !!converging,
    ...(overshoot ? { durationIssue: overshoot } : {}) };
  return { ...ledger, history: [...history, pending], pending, stop: null };
}

/* Stage identity is needed even for environment failures, where content repair
 * is not allowed. Old checkpoints only have it embedded in the stop text. */
export function stoppedFailureStage(ledger) {
  if (typeof ledger?.stop !== 'string' || !ledger.stop) return null;
  const stage = ledger.stoppedStage || ledger.stop.match(/阶段\s+(build|measure|render|voice|validate)\b/)?.[1];
  return ['build', 'measure', 'render', 'voice', 'validate'].includes(stage) ? stage : null;
}

/* Read the actual stopping failure, never the last repair's older failure.
 * Legacy run_stage receipts embed their stage in the stop text itself. */
export function stoppedProductionFailure(ledger) {
  if (typeof ledger?.stop !== 'string' || !ledger.stop) return null;
  const stage = ledger.stoppedStage || ledger.stop.match(/阶段\s+(build|measure|render|voice|validate)\b/)?.[1];
  const reason = ledger.stoppedReason || ledger.stop.replace(/^.*?不降低质量门槛[：:]\s*/, '');
  if (!['build', 'measure', 'render', 'voice', 'validate'].includes(stage) || !reason ||
    (ledger.stoppedKind || classifyProductionFailure(reason)) !== 'content') return null;
  return { stage, reason, sourceSignature: ledger.stoppedSignature };
}

export function productionRepairRecovery(ledger, policy) {
  const used = ledger?.history?.length, limit = policy?.maxRepairs;
  if (!policy?.enabled || !Number.isInteger(limit) || limit < 0 || limit > 5 || !Array.isArray(ledger?.history) ||
    used !== limit || used > 5 || ledger.history.some(item => !item || typeof item.key !== 'string' || !item.key ||
      typeof item.reason !== 'string' || !item.reason || !['build', 'measure', 'render', 'voice', 'validate'].includes(item.stage)) ||
    ledger.pending || !stoppedProductionFailure(ledger)) return null;
  const additionalRepairs = Math.min(2, 5 - Math.max(limit, used));
  return { blocked: true, canExtend: additionalRepairs > 0, additionalRepairs, used, limit, targetLimit: limit + additionalRepairs };
}

/* An authorization is persisted with the task, not in PROJECT.json. Replaying
 * recovery after a startup failure must not allocate the same repair twice. */
export function applyRepairExtensions(ledger, extensions = [], policy) {
  let next = ledger;
  for (const extension of extensions) {
    if (next?.appliedRepairExtensions?.includes(extension.id)) continue;
    const recovery = productionRepairRecovery(next, { enabled: policy.enabled, maxRepairs: extension.fromLimit });
    if (!recovery || !recovery.canExtend || ![1, 2].includes(extension.additionalRepairs) ||
      extension.toLimit !== extension.fromLimit + extension.additionalRepairs || extension.toLimit > policy.maxRepairs ||
      extension.toLimit > 5 || extension.toLimit <= recovery.used) continue;
    const failure = stoppedProductionFailure(next);
    const pending = { key: 'extension-' + extension.id, ...failure };
    next = { ...next, history: [...next.history, pending], pending, stop: null,
      appliedRepairExtensions: [...(next.appliedRepairExtensions || []), extension.id] };
  }
  return next;
}

/* Corrected author inputs may be checked again, but never buy more AI repairs.
 * An unchanged resume stays stopped; environment/unknown failures stay explicit. */
export function reconsiderProductionStop(ledger, sourceSignature) {
  if (!ledger?.stop || !ledger.stoppedSignature || ledger.stoppedSignature === sourceSignature ||
    (ledger.stoppedKind || classifyProductionFailure(ledger.stop)) !== 'content') return ledger;
  return { ...ledger, stop: null, pending: null };
}

/* The original signature identifies the failing input; workingSignature tracks
 * controlled edits in the same transaction. Other changes invalidate the old
 * diagnosis, but never count as a submitted repair or reset the budget. */
export function currentProductionRepair(ledger, sourceSignature) {
  const pending = ledger?.pending;
  if (!pending) return null;
  const expected = pending.workingSignature || pending.sourceSignature;
  if (expected && sourceSignature && expected !== sourceSignature) return null;
  return pending;
}

/* Only a successful authorized author tool changing its own target may advance
 * the transaction. Unrelated concurrent changes remain a conflict. */
export function recordProductionRepairEdit(ledger, before, after, target) {
  const pending = currentProductionRepair(ledger, before?.signature);
  if (!pending?.sourceSignature || typeof before?.signature !== 'string' || typeof after?.signature !== 'string' ||
    !before?.inputs || !after?.inputs || before.signature === after.signature ||
    !target || before.inputs[target] === after.inputs[target]) return ledger;
  const keys = new Set([...Object.keys(before.inputs), ...Object.keys(after.inputs)]);
  if ([...keys].some(key => key !== target && before.inputs[key] !== after.inputs[key])) return ledger;
  const updated = { ...pending, workingSignature: after.signature };
  return { ...ledger, pending: updated,
    history: (ledger.history || []).map(item => item.key === pending.key ? { ...item, workingSignature: after.signature } : item) };
}

export function submitProductionRepair(ledger, signature) {
  const pending = ledger?.pending;
  if (!pending) throw new Error('没有待提交的修复轮次');
  if (!pending.sourceSignature || !signature || !currentProductionRepair(ledger, signature))
    throw new Error('修复期间输入被外部修改或缺少基线；不能将未知变更提交为本轮修复');
  if (signature === pending.sourceSignature) throw new Error('作者输入尚未改变，不能把未修复的输入提交为完成；请先修正本轮问题');
  return { ...ledger, pending: null, history: (ledger.history || []).map(item => item.key === pending.key
    ? { ...item, submittedSignature: signature, submittedAt: new Date().toISOString() } : item) };
}

export function productionRepairWork(ledger) {
  const pending = ledger?.pending;
  if (!pending) return null;
  return { key: 'auto-repair:' + pending.key, stage: 'author_edit', tool: 'patch_text', required: null, auto: false,
    allowed: ['read_file', 'read_edit_file', 'read_scene', 'patch_text', 'replace_scene', 'append_file', 'list_files', 'finish_repair'],
    note: `【自动修复第 ${ledger.history.length} 轮】阶段 ${pending.stage} 的实际问题：\n${pending.reason}\n` +
      '只修报错对应的作者输入，使用短补丁并保留无关内容；版式/颜色只改画面或模板，不要为视觉错误删减旁白。字幕缺失由程序导出，不重做 TTS。' +
      '禁止改人工审阅勾选、自动制作设置或检查回执，禁止降低阈值/放宽时长/绕过质量关口。本轮可连续打多处短补丁；修完后调用 finish_repair 提交复检，执行器再判断上游并复测；不要只口头称已修好。' };
}
