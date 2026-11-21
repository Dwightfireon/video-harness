/* UI reads are bounded and cheap. Strong source/media hashing only happens on an
 * explicit read-only verify request, off the HTTP event loop. No model dispatch. */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { taskStatus, readTask } from './task-status.mjs';
import { webAutomationPolicy, configureAutomation } from './automation.mjs';
import { acquireProductionLock } from './production-lock.mjs';
import { workflowPolicy } from './workflow-policy.mjs';
import { declaredVisualMode } from './scene-sdf.mjs';

const LABELS = { inputs: '输入版本', assets: '本地素材', timing: '配音时间轴', structure: '场景结构', build: '构建基线',
  contrast: '文字可读性', layout: '文字溢出与越界', subtitles: '字幕实际显示', artifact: '当前带声成片', srt: '字幕文件',
  decode: '媒体完整解码', audio: '音轨基础检测', stable: '检查期间版本稳定', 'media-identity': '媒体指纹', receipt: '质量回执' };
const safe = value => String(value || '').replace(/\b(?:Bearer\s+|sk-)[\w.-]+/gi, '[已隐藏]')
  .replace(/((?:api[_-]?key|token|authorization|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
  .replace(/https?:\/\/[^\s/]+:[^\s@]+@/gi, 'https://[已隐藏]@').slice(0, 700);
const boundedJSON = file => {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
};
const receiptFile = project => path.join(project, 'out/.vh-production-quality.json');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const watchedInputs = ['', 'out', 'assets', 'PROJECT.json', '脚本.md', '方案.md', 'claims.json', 'scenes.src.js', 'engine.tpl.html', 'timing.json', 'scene.html',
  'out/.vh-state.json', 'out/.vh-production-quality.json', 'out/video.mp4', 'out/video-voice.mp4', 'out/subtitles.srt'];
const fileIdentity = file => {
  try { const stat = fs.lstatSync(file); return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(':'); }
  catch (error) { return error.code || 'unreadable'; }
};
const checksView = (receipt, profile) => (Array.isArray(receipt?.checks) ? receipt.checks : []).slice(0, 24)
  .filter(check => !(profile === 'technical' && ['contrast', 'layout'].includes(check.id) && ['not-run', 'skipped'].includes(check.status))).map(check => ({
  id: safe(check.id), label: LABELS[check.id] || '其它机器检查', state: check.ok === true && check.status === 'passed' ? 'passed' : check.ok === false && check.status === 'failed' ? 'failed' : 'unknown',
  issues: (Array.isArray(check.issues) ? check.issues : []).slice(0, 6).map(item => ({ message: safe(item?.message), hint: safe(item?.hint) })),
}));

function workerVerify(project, phase, qualityProfile, workers) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./production-view-worker.mjs', import.meta.url), { workerData: { project, phase, qualityProfile } });
    workers.add(worker); let settled = false;
    const finish = (value, error) => {
      if (settled) return; settled = true; clearTimeout(timer); workers.delete(worker); void worker.terminate();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(null, new Error('版本核验超时，未认定当前质量通过')), 30000);
    worker.once('message', value => finish(value)); worker.once('error', () => finish(null, new Error('版本核验进程失败，未认定通过')));
    worker.once('exit', code => { if (!settled) finish(null, new Error('版本核验未留下结果（' + code + '）')); });
  });
}

export function createProductionViewService({ verify, cacheMs = 60000 } = {}) {
  const workers = new Set(), pending = new Map(), verified = new Map();
  let closed = false;
  // Why no fs.watch: macOS may deliver a coalesced event from a write that
  // completed BEFORE the watch started. That falsely expired a just-verified
  // UI result. Lightweight stat identities are compared on each read instead;
  // they only decide whether to keep showing a convenience result. The actual
  // verification, and every packaging gate, still hashes bytes.
  const identities = project => watchedInputs.map(file => {
    const value = fileIdentity(path.join(project, file));
    return [file, value];
  });
  const forget = project => verified.delete(project);
  const unchanged = (project, snapshot) => snapshot && JSON.stringify(identities(project)) === snapshot;
  const makeView = project => {
    const status = taskStatus(project, { includeDeliverable: false }), task = readTask(project);
    const metadata = boundedJSON(path.join(project, 'PROJECT.json'));
    if (!metadata) throw Object.assign(new Error('项目配置无法读取，未使用默认策略掩盖错误'), { statusCode: 400 });
    const policy = webAutomationPolicy(project, 'article');
    const workflow = workflowPolicy(project);
    const progress = task?.automationProgress || {};
    const receipt = boundedJSON(receiptFile(project));
    const successful = receipt?.ok === true && ['pre-render', 'final'].includes(receipt.phase) && Array.isArray(receipt.checks) && receipt.checks.length > 0;
    const cache = verified.get(project);
    if (cache && (cache.receiptHash !== fingerprint(receipt) || Date.now() - cache.at > cacheMs ||
      status.running || status.orphanRunning || !unchanged(project, cache.identity))) forget(project);
    const valid = verified.get(project);
    const unreadable = !receipt && fs.existsSync(receiptFile(project));
    const profileLabel = workflow.qualityProfile === 'technical' ? '技术检查' : '严格检查（含视觉抽样）';
    const receiptChecks = Array.isArray(receipt?.checks) ? receipt.checks : [];
    const optionalChecks = ['contrast', 'layout'].map(id => {
      const check = receiptChecks.find(item => item?.id === id);
      return { id, label: LABELS[id], required: workflow.qualityProfile === 'strict',
        state: check?.status === 'passed' && check.ok === true ? 'passed' : check?.status === 'failed' && check.ok === false ? 'failed' : 'not-run' };
    });
    const quality = { state: !receipt ? unreadable ? 'failed' : 'not-checked' : !successful ? 'failed' : 'unverified', phase: receipt?.phase || null,
      profile: workflow.qualityProfile, profileLabel, receiptProfile: receipt ? receipt.profile || 'strict' : null, optionalChecks,
      checkedAt: typeof receipt?.at === 'string' ? receipt.at : null, verifiedAt: valid?.at ? new Date(valid.at).toISOString() : null,
      checks: checksView(receipt, workflow.qualityProfile), reason: !receipt ? unreadable ? '质量回执无法读取，不能认定检查通过' : '尚未生成机器质量回执' : successful ? '最近检查通过；尚未核验当前源文件与媒体是否仍为该版本' : '最近一次检查未通过或回执不完整',
      note: `${profileLabel}；${workflow.qualityProfile === 'technical' ? '视觉抽样检查可选，未运行不标通过、不阻塞普通交付。' : '视觉抽样检查为本策略必需。'}机器检查不等于事实、导演、审美或人工审片通过；不会自动发布。轮询不运行模型、制作或完整媒体哈希。` };
    if (status.taskRunning && status.stage === 'validate' && task?.automation?.enabled) { quality.state = 'checking'; quality.reason = '后台正在进行最终机器核验'; }
    else if (valid) { quality.state = valid.result.ok ? 'passed' : successful ? 'stale' : 'failed'; quality.reason = valid.result.ok ? '当前版本已在显示时间完成只读核验；有改动须重新核验' : safe(valid.result.reason); }
    quality.reason = `${profileLabel}：${quality.reason}`;
    const notRun = optionalChecks.filter(check => !check.required && check.state === 'not-run');
    if (notRun.length) quality.note += ` 可选未运行：${notRun.map(check => check.label).join('、')}。`;
    return { version: 1, readOnly: true, workflow, visualMode: declaredVisualMode(metadata),
      automation: { ...policy, source: metadata.automation === undefined ? 'web-default' : 'project', activePolicy: task?.automation ? {
        enabled: task.automation.enabled === true, maxRepairs: Number.isInteger(task.automation.maxRepairs) ? task.automation.maxRepairs : 2,
      } : null },
      task: { id: task?.id || null, attemptId: task?.attemptId || null, status: status.status, running: status.running, cancelling: status.cancelling,
        canResume: status.canResume, stage: status.stage || progress.stage || null, error: status.error ? { message: safe(status.error.message) } : null,
        pausedReason: safe(status.pausedReason || task?.pausedReason) || null, staleStopNotice: safe(status.staleStopNotice) || null, repairRecovery: status.repairRecovery,
        orphanRunning: status.orphanRunning, productionBusy: status.productionBusy, taskRunning: status.taskRunning },
      repair: { used: Number.isInteger(progress.used) ? Math.max(0, progress.used) : 0, limit: task?.automation?.maxRepairs ?? policy.maxRepairs,
        phase: ['repairing', 'stopped'].includes(progress.phase) ? progress.phase : 'idle', lastIssue: safe(progress.lastIssue) || null }, quality };
  };
  return {
    async read(project, { verify: shouldVerify = false } = {}) {
      if (closed) throw new Error('工作台已关闭');
      project = fs.realpathSync(project);
      const initial = makeView(project);
      if (!shouldVerify) return initial;
      if (initial.task.running || initial.task.orphanRunning) throw Object.assign(new Error('制作或取消尚未结束，不能核验正在变化的媒体；请等待后台完成'), { statusCode: 409 });
      if (!boundedJSON(receiptFile(project))) return initial;
      if (!pending.has(project)) {
        if (pending.size >= 2) throw Object.assign(new Error('已有两个版本核验在执行，请稍后手动重试'), { statusCode: 429 });
        const receipt = boundedJSON(receiptFile(project)), expected = fingerprint(receipt), before = identities(project);
        const request = Promise.resolve().then(() => verify ? verify(project, initial.quality.phase, initial.quality.profile) : workerVerify(project, initial.quality.phase, initial.quality.profile, workers))
          .then(result => {
            if (closed) throw new Error('工作台已关闭');
            const after = identities(project), receiptNow = boundedJSON(receiptFile(project));
            // The strong verifier itself hashes sources/assets/media and returns a
            // bound receipt. These stat identities only reject an obvious change
            // that happened AFTER the verifier's own boundary. A pre-existing
            // receipt write must not invalidate a successful bound verification.
            const stable = fingerprint(receiptNow) === expected && JSON.stringify(after) === JSON.stringify(before);
            const outcome = stable ? result : { ok: false, reason: '核验期间项目发生变化，请重新核验' };
            if (stable) verified.set(project, { at: Date.now(), receiptHash: expected, identity: JSON.stringify(after),
              result: { ok: outcome.ok === true, reason: safe(outcome.reason) } });
            else forget(project);
            return makeView(project);
          }).finally(() => pending.delete(project));
        pending.set(project, request);
      }
      return pending.get(project);
    },
    async save(project, policy) {
      const status = taskStatus(project, { includeDeliverable: false });
      if (status.running || status.orphanRunning) throw Object.assign(new Error('制作或取消中的策略不能中途更改；当前任务保持原策略'), { statusCode: 409 });
      let lock;
      try { lock = acquireProductionLock(project, { command: 'automation-settings' }); configureAutomation(project, policy); }
      catch (error) { if (error.code?.startsWith('PRODUCTION_LOCK')) error.statusCode = 409; throw error; }
      finally { lock?.release(); }
      forget(fs.realpathSync(project)); return makeView(project);
    },
    close() { closed = true; verified.clear(); for (const worker of workers) void worker.terminate(); },
  };
}
