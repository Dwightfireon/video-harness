/* 只供固定 run_stage wrapper 使用；阶段身份与退出码不能从子进程日志推断。
 * 保留首行 exit= 兼容现有日志消费者；第二行是完整、单行 JSON，诊断只作为数据。
 * 不在任意 stdout 中搜索 envelope，也不接受 JSON 后追加的第二份回执。 */
const PREFIX = 'VH_STAGE_RESULT_V1 ';
const STAGES = new Set(['build', 'measure', 'render', 'voice', 'validate']);
const KEYS = ['version', 'tool', 'stage', 'exitCode', 'logPath', 'output'];

function validResult(result) {
  return result && typeof result === 'object' && !Array.isArray(result) &&
    Object.keys(result).length === KEYS.length && KEYS.every(key => Object.hasOwn(result, key)) &&
    result.version === 1 && result.tool === 'run_stage' && STAGES.has(result.stage) &&
    (Number.isInteger(result.exitCode) && result.exitCode >= 0 && result.exitCode <= 255 ||
      typeof result.exitCode === 'string' && /^SIG[A-Z0-9]+$/.test(result.exitCode)) &&
    typeof result.logPath === 'string' && result.logPath.trim().length > 0 && !/[\r\n]/.test(result.logPath) &&
    typeof result.output === 'string';
}

export function serializeStageResult({ stage, exitCode, logPath, output = '' }) {
  const result = { version: 1, tool: 'run_stage', stage, exitCode, logPath, output };
  if (!validResult(result)) throw new TypeError('无效的 run_stage 回执参数');
  return `exit=${exitCode}\n${PREFIX}${JSON.stringify(result)}`;
}

/* null 表示旧版/通用工具结果；有受控标记但内容损坏必须抛错，不能降级成成功。 */
export function parseStageResult(content) {
  const text = String(content ?? ''), lines = text.split('\n');
  if (!lines[0].startsWith('VH_STAGE_RESULT') && !lines[1]?.startsWith('VH_STAGE_RESULT')) return null;
  if (lines.length !== 2 || !lines[1].startsWith(PREFIX)) throw new Error('阶段回执格式不完整');
  const json = lines[1].slice(PREFIX.length);
  let result;
  try { result = JSON.parse(json); } catch { throw new Error('阶段回执 JSON 无效'); }
  // 固定 serializer 的规范形式也拒绝重复键、额外字段和拼接回执。
  if (!validResult(result) || JSON.stringify(result) !== json || lines[0] !== `exit=${result.exitCode}`) {
    throw new Error('阶段回执字段或退出码不一致');
  }
  return result;
}
