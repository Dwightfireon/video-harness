import { parseStageResult, serializeStageResult } from './stage-result.mjs';

const CONTENT_CATEGORIES = new Set(['inputs', 'assets', 'timing', 'structure', 'build', 'quality', 'subtitles', 'silence', 'clipping']);
const ENVIRONMENT_CATEGORIES = new Set(['checker', 'io']);
const STAGE_REASON = /^阶段 (build|measure|render|voice|validate)[：:]\s*/;
const FILESYSTEM_ERROR = /^(?:Error[：:]\s*)?(?:ENOSPC|EACCES|EPERM|ENOENT)(?:$|[：:,\s])/;

// Checkpoints predate stoppedKind/stoppedReason. Unwrap only the fixed ledger
// grammar, never search through arbitrary prose for a topic or a FAIL token.
// A budget/repeated-input stop alone does not prove a content failure: its
// underlying receipt still has to fail (not exit=0 with warnings).
function historicalFailure(reason) {
  reason = reason.replace(/^自动修复已达到 \d+ 轮上限；(?:保留现场，不降低质量门槛[：:]\s*)?\s*/, '');
  const stopped = /^阶段 (build|measure|render|voice|validate) (环境\/检查器失败|失败原因不明)，未盲目重试[：:]\s*/.exec(reason);
  if (stopped) return { reason: reason.slice(stopped[0].length), stage: stopped[1],
    kind: stopped[2] === '环境/检查器失败' ? 'environment' : 'unknown' };
  const repeated = /^阶段 (build|measure|render|voice|validate) 输入未变且同一问题再次失败，停止原样重跑[：:]\s*/.exec(reason);
  if (repeated) return { reason: reason.slice(repeated[0].length), stage: repeated[1] };
  const stage = STAGE_REASON.exec(reason);
  return stage ? { reason: reason.slice(stage[0].length), stage: stage[1] } : { reason };
}

// Only diagnostic heads are recognized. A quoted caption, file path or finding's
// free-text tail must not turn a layout failure into an auth/quota/timeout error.
function environmentDiagnostic(text) {
  const head = text.trim().replace(/^(?:✗|⛔)\s*/, '').replace(/^(?:Error|ProductionLockError|工具异常)[：:]\s*/, '');
  return FILESYSTEM_ERROR.test(head) ||
    /^(?:spawn\s+\S+\s+(?:ENOENT|EACCES)|启动阶段进程失败|检查执行失败[：:]|检查器(?:异常|不可用)(?:$|[：:，,\s])|没有 playwright|(?:playwright|ffmpeg|ffprobe|浏览器内核)\s*未安装|未安装\s*(?:playwright|ffmpeg|ffprobe)|找不到(?:浏览器)?(?:内核|程序)|浏览器(?:启动失败|不可用)(?:$|[：:，,\s])|(?:执行锁|制作锁)(?:仍|已|被|未能|冲突|不可用)|Production lock unavailable[：:]|(?:凭证|认证)(?:失败|无效|过期|缺失)(?:$|[：:，,\s])|额度(?:不足|耗尽)(?:$|[：:，,\s])|(?:TimeoutError|timeout|timed out)(?:$|[：:，,\s])|(?:检查|请求|执行|浏览器启动|媒体探针)超时(?:$|[：:，,\s]))/i.test(head);
}

function combined(kinds) {
  // A failed checker means the content diagnosis is incomplete; never repair
  // around it. An unrecognized failed check likewise cannot authorize edits.
  return kinds.includes('environment') ? 'environment' :
    kinds.length && kinds.every(kind => kind === 'content') ? 'content' : 'unknown';
}

function qualityFailure(quality) {
  const checks = Array.isArray(quality) ? quality : quality?.version === 1 &&
    ['pre-render', 'final'].includes(quality.phase) && quality.ok === false ? quality.checks : null;
  if (!Array.isArray(checks) || !checks.length) return 'unknown';
  const kinds = [];
  for (const check of checks) {
    if (!check || typeof check.id !== 'string' || !check.id || !Array.isArray(check.issues)) return 'unknown';
    if (['contrast', 'layout'].includes(check.id) && check.required === false && check.ok === null &&
      check.status === 'not-run' && !check.issues.length) continue;
    if (check.ok === true && check.status === 'passed' && !check.issues.length) continue;
    if (check.ok !== false || check.status !== 'failed' || !check.issues.length) return 'unknown';
    for (const issue of check.issues) {
      if (!issue || typeof issue.category !== 'string' || typeof issue.message !== 'string') return 'unknown';
      const category = issue.category;
      if (ENVIRONMENT_CATEGORIES.has(category)) kinds.push('environment');
      // Input readers currently report filesystem exceptions under their input
      // category. Preserve actual errno diagnostics, not words inside findings.
      else if (['inputs', 'assets', 'media'].includes(category) && FILESYSTEM_ERROR.test(issue.message)) kinds.push('environment');
      else kinds.push(CONTENT_CATEGORIES.has(category) ? 'content' : 'unknown');
    }
  }
  return combined(kinds);
}

function legacyFailure(text) {
  const lines = text.split('\n');
  if (/^exit=0(?:\s|$)/.test(lines[0])) return 'unknown';
  if (/^exit=SIG[A-Z0-9]+(?:\s|$)/.test(lines[0])) return 'environment';
  if (lines.some(environmentDiagnostic)) return 'environment';
  // These are the two existing CLI/automated-delivery quality output formats.
  // Parse the entire JSON payload; never regex-search its message/hint strings.
  const qualityLines = lines.map(line => /^\s*(?:✗\s*)?(?:自动质量闸门|制作技术检查)未通过[：:]\s*(.*)$/.exec(line)).filter(Boolean);
  if (qualityLines.length) {
    try { return combined(qualityLines.map(match => qualityFailure(JSON.parse(match[1])))); }
    catch { return 'unknown'; }
  }
  let content = false;
  for (let line of lines) {
    line = line.trim().replace(STAGE_REASON, '');
    if (environmentDiagnostic(line)) return 'environment';
    const diagnostic = line.replace(/^(?:✗|⛔)\s*/, '');
    if (/^FAIL\s+/.test(diagnostic)) {
      // FAIL's body is normally a content finding. Only explicit checker
      // diagnostics can override it, never auth/quota/timeout topic wording.
      if (/^FAIL\s+(?:检查执行失败[：:]|检查器(?:异常|不可用)[：:]|启动阶段进程失败(?:$|\s))/.test(diagnostic)) return 'environment';
      content = true;
    } else if (/^(?:【时长超限，禁止继续渲染】|版式(?:溢出|越界|重叠)|字幕(?:丢字|缺失|越界|溢出|重叠|不完整)|对比度(?:不足|过低|不达标)|时长(?:超限|超出)|时间轴(?:不一致|无效)|素材(?:缺失|不存在)|quality\s+(?:check\s+)?failed\b)/i.test(diagnostic)) content = true;
  }
  return content ? 'content' : 'unknown';
}

/** Classification only; this never verifies a persisted receipt against project
 * inputs. Pass only the current invocation's quality/stageResult, not a stale
 * quality file. Malformed explicit evidence cannot fall back to keyword repair. */
export function classifyProductionFailure(reason, { stage, stageResult, quality } = {}) {
  if (typeof reason !== 'string') return 'unknown';
  const historical = historicalFailure(reason);
  if (stage && historical.stage && stage !== historical.stage) return 'unknown';
  reason = historical.reason;
  stage ||= historical.stage;
  let receipt;
  try {
    receipt = parseStageResult(reason);
    if (stageResult !== undefined) {
      if (typeof stageResult === 'string') receipt = parseStageResult(stageResult);
      else if (stageResult?.version === 1 && stageResult.tool === 'run_stage' && Object.keys(stageResult).length === 6)
        receipt = parseStageResult(serializeStageResult(stageResult));
      else return 'unknown';
      if (!receipt) return 'unknown';
    }
  } catch { return 'unknown'; }
  if (receipt) {
    if (stage && stage !== receipt.stage || receipt.exitCode === 0) return 'unknown';
    if (typeof receipt.exitCode === 'string') return 'environment';
    if (receipt.output.split('\n').some(environmentDiagnostic)) return 'environment';
  }
  if (historical.kind) return historical.kind;
  if (quality !== undefined) return qualityFailure(quality);
  return legacyFailure(receipt ? receipt.output : reason);
}
