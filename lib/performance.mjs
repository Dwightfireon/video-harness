/* Real stage wall times only. Never log shell arguments, prompts or credentials.
 * Command times include their steps; reports never add both as if disjoint. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const FILE = 'out/.vh-performance.jsonl';
const runId = randomUUID();
const failureCodes = new Set(['command-failed', 'step-failed', 'renderer-failed', 'inputs-changed', 'renderer-changed', 'interrupted', 'model-request-failed']);
const RENDER_STAGE_LABELS = new Map([['screenshot', '渲染截图'], ['encode', '渲染编码'], ['concat', '渲染拼接']]);
/* The renderer is a standalone child. It makes one machine-readable event per
 * attempted stage, tagged with this run's ID. Only stages actually started are
 * accepted; an interrupted stage can never turn into a success here. */
export function ingestRendererEvents(project, stdout, { runId: expected } = {}) {
  if (typeof expected !== 'string' || !/^[0-9a-f-]{36}$/.test(expected)) return 0;
  let count = 0;
  for (const raw of String(stdout || '').split('\n')) {
    if (!raw.startsWith('VH_RENDER_STAGE ')) continue;
    let event;
    try { event = JSON.parse(raw.slice('VH_RENDER_STAGE '.length)); } catch { continue; }
    const label = RENDER_STAGE_LABELS.get(event?.stage);
    if (event?.schemaVersion !== 1 || event?.kind !== 'renderer-stage' || event?.runId !== expected || !label) continue;
    if (!Number.isFinite(event.elapsedMs) || event.elapsedMs < 0 || typeof event.ok !== 'boolean') continue;
    const frames = event.stage === 'screenshot' && Number.isInteger(event.frames) && event.frames > 0 ? event.frames : null;
    if (recordPerformance(project, { kind: 'step', stage: label + (frames ? `（${frames} 帧）` : ''), elapsedMs: event.elapsedMs, ok: event.ok })) count++;
  }
  return count;
}
export function performanceRunId() { return runId; }
export function recordPerformance(project, { kind, stage, elapsedMs, ok, exitCode, failureCode }) {
  if (!['command', 'step', 'check', 'model'].includes(kind) || typeof stage !== 'string' || !stage.trim() || !Number.isFinite(elapsedMs) || elapsedMs < 0 || typeof ok !== 'boolean')
    return false;
  try {
    const file = path.join(project, FILE); fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && !fs.lstatSync(file).isFile()) return false;
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeSync(fd, JSON.stringify({ version: 1, runId, at: new Date().toISOString(), kind, stage: stage.slice(0, 100), elapsedMs: Math.round(elapsedMs), ok,
      ...(Number.isInteger(exitCode) ? { exitCode } : {}),
      ...(!ok && failureCodes.has(failureCode) ? { failureCode } : {}) }) + '\n'); }
    finally { fs.closeSync(fd); }
    return true;
  } catch { return false; } // Diagnostics cannot turn a successful stage into failure.
}

export function performanceSummary(project) {
  const file = path.join(project, FILE), groups = new Map();
  let rows = [], truncated = false;
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('不是普通日志');
    const limit = 1024 * 1024, start = Math.max(0, info.size - limit), bytes = Buffer.alloc(Math.min(info.size, limit));
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fs.readSync(fd, bytes, 0, bytes.length, start); } finally { fs.closeSync(fd); }
    truncated = start > 0;
    const lines = bytes.toString('utf8').split('\n'); if (truncated) lines.shift();
    rows = lines.flatMap(line => { try {
      const item = JSON.parse(line);
      return item.version === 1 && ['command', 'step', 'check', 'model'].includes(item.kind) && typeof item.stage === 'string' &&
        Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0 && typeof item.ok === 'boolean' ? [item] : [];
    } catch { return []; } });
  } catch {}
  for (const item of rows) {
    const key = item.kind + ':' + item.stage;
    if (!groups.has(key)) groups.set(key, { kind: item.kind, stage: item.stage, count: 0, failed: 0, totalMs: 0, lastMs: 0 });
    const group = groups.get(key); group.count++; group.failed += Number(!item.ok); group.totalMs += item.elapsedMs; group.lastMs = item.elapsedMs;
  }
  const failures = rows.filter(r => !r.ok).slice(-10).map(r => ({ at: r.at, kind: r.kind, stage: r.stage,
    ...(typeof r.runId === 'string' && /^[0-9a-f-]{36}$/.test(r.runId) ? { runId: r.runId } : {}),
    ...(Number.isInteger(r.exitCode) ? { exitCode: r.exitCode } : {}),
    failureCode: failureCodes.has(r.failureCode) ? r.failureCode : 'unknown' }));
  return { ok: rows.length > 0, events: rows.length, truncated, failures, groups: [...groups.values()].sort((a, b) => b.totalMs - a.totalMs),
    observations: performanceObservations([...groups.values()]),
    scope: '只含已登记的真实CLI阶段与模型请求/重试等待；command包含其step/check，ask也包含model，不能相加。旧记录没有的模型等待不回填；外部ASR、人工审阅与本会话外部模型未覆盖，不据此承诺整片制作耗时。' };
}

/* Observations are not proof of wasted work or permission to skip checks.
 * Keep inclusive renderer totals separate from its screenshot/encode children. */
function performanceObservations(groups) {
  const out = [];
  const renderer = groups.find(g => g.kind === 'step' && g.stage === '渲染器（截图与编码）');
  if (renderer) out.push(`渲染器启动 ${renderer.count} 次，累计 ${(renderer.totalMs / 1000).toFixed(2)}s（包含截图与编码，不再相加）。次数不证明重渲多余；返工前用 plan --srt 核对失效步骤，草稿用 stills/preview。`);
  const build = groups.find(g => g.kind === 'command' && g.stage === 'build');
  if (build?.failed) out.push(`build ${build.count} 次中失败 ${build.failed} 次；先定位错误、合并修正再构建，不原样重试。日志未记录具体输入，不能据此推算可节省时长。`);
  if (renderer?.count > 1) out.push('若返工来自“没听懂”，先检查纯旁白的依据、中间步骤和场间承接，再做画面；减少内容定稿后的重做，不以降低画质或关闭质检提速。');
  return out;
}

export function performanceReport(result) {
  return [result.ok ? '制作耗时（真实运行记录）' : '尚无阶段耗时记录；之后的制作命令会自动登记。',
    ...result.groups.map(g => `  [${g.kind}] ${g.stage}：${g.count} 次 / 失败 ${g.failed} 次 / 合计 ${(g.totalMs / 1000).toFixed(2)}s / 最近 ${(g.lastMs / 1000).toFixed(2)}s`),
    ...(result.failures || []).map(f => `  最近失败 ${f.at} [${f.kind}] ${f.stage}：${f.failureCode}${f.exitCode === undefined ? '' : '，exit=' + f.exitCode}${f.runId ? '，run=' + f.runId : ''}`),
    ...(result.observations || []).map(text => '  诊断：' + text),
    ...(result.truncated ? ['仅统计日志尾部1MiB，非完整历史。'] : []), result.scope].join('\n');
}
