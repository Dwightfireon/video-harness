import { parseStageResult } from './stage-result.mjs';

const FAILURE_LINE = /^\s*(?:✗|⛔|Traceback \(|(?:Error|SyntaxError|TypeError|ReferenceError):)/;

function failDetails(lines) {
  /* 只取第一行是不够的：门禁的失败原因在输出末尾（"FAIL 前 3 句没有一句交代…"），
   * 模型只看到 exit=1 就不知道该改什么，于是反复读文件、最后被判"偏离阶段"暂停。
   * 真实事故：渲染被闸门拦住 3 次，模型完全不知道 FAIL 是"开场没交代主题"。
   * 所以要把 FAIL 原文一并带回去。 */
  const fails = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*FAIL\s+(.+)$/.exec(lines[i]);
    if (!m) continue;
    // FAIL 的续行通常是缩进的具体条目（如"百万（值 100）"），一并带上才有用。
    const detail = [m[1].trim()];
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      if (!/^\s{2,}\S/.test(lines[j]) || /^\s*(?:WARN|INFO|FAIL|待审|ok)\s/.test(lines[j])) break;
      detail.push(lines[j].trim());
    }
    fails.push(detail.join('；').slice(0, 400));
    if (fails.length >= 6) break;
  }
  return fails;
}

function stageOutcome(result) {
  const { stage, exitCode, logPath, output } = result;
  const lines = output.split('\n'), diagnostics = failDetails(lines);
  const messages = lines.filter(line => FAILURE_LINE.test(line) || /^\s*(?:WARN\s|⚠)/.test(line))
    .slice(0, 6).map(line => line.replace(/\s+/g, ' ').trim().slice(0, 300));
  const ok = exitCode === 0;
  const warnings = ok ? [...diagnostics, ...messages].slice(0, 6) : [];
  const fails = ok ? [] : diagnostics;
  const base = `exit=${exitCode} 阶段 ${stage}；完整日志 ${logPath}`;
  const detail = (lines.find(line => FAILURE_LINE.test(line)) || lines.find(line => line.trim()) || '')
    .replace(/\s+/g, ' ').trim().slice(0, 240);
  const summary = ok
    ? base + (warnings.length ? '\n非阻塞警告（阶段已成功）：\n' + warnings.map(w => '  · ' + w.slice(0, 300)).join('\n') : '')
    : base + (detail ? '\n' + detail : '') + (fails.length ? '\n必须修的问题：\n' + fails.map(f => '  · ' + f.slice(0, 300)).join('\n') : '');
  return { ok, unknown: false, exit: String(exitCode), stage, logPath, status: ok ? warnings.length ? 'warning' : 'success' : 'failure', summary, fails, warnings };
}

/* 固定阶段按 wrapper 的真实退出码判定；通用 run 仍保守识别复合命令的失败日志。 */
export function toolOutcome(content) {
  const text = String(content ?? '');
  try {
    const stage = parseStageResult(text);
    if (stage) return stageOutcome(stage);
  } catch (error) {
    return { ok: false, unknown: true, exit: /^exit=(\S+)/.exec(text)?.[1], status: 'failure',
      summary: '结构化阶段回执损坏，结果未知：' + error.message, fails: [], warnings: [] };
  }
  const lines = text.split('\n');
  const first = lines.find(line => line.trim()) || '';
  const exit = /^exit=(\S+)/.exec(first)?.[1];
  const failure = lines.find(line => FAILURE_LINE.test(line));
  const refused = /^(?:拒绝|工具异常|读失败|写入失败|核验失败|抓取失败|恢复时用户有新的补充要求)/.test(first);
  const unknown = /结果未知|拒绝自动重放/.test(text);
  const ok = !refused && !unknown && !failure && (exit == null || exit === '0');
  const fails = failDetails(lines);
  const detail = (failure || first).replace(/\s+/g, ' ').trim().slice(0, 240);
  const base = (exit != null ? 'exit=' + exit + ' ' : '') + detail.replace(/^exit=\S+\s*/, '');
  const withFails = fails.length ? base + '\n必须修的问题：\n' + fails.map(f => '  · ' + f.slice(0, 300)).join('\n') : base;
  return { ok, unknown, exit, summary: withFails, fails };
}

/* 仅识别实际执行入口；grep/sed/cat/Python open() 中的文件名不是执行。不是通用 shell 沙箱。 */
export function directPipelineScript(command) {
  const entry = /(?:^|[;|&\n])\s*(?:(?:exec|command)\s+)?(?:[\w/.+-]*\/)?(?:node|python3)\s+(?:(?:--[\w-]+|-[A-Za-z]+)\s+)*["']?(?:[^\s"';|&]*\/)?(gen\.mjs|render\.mjs|voice-kokoro\.py)(?=["'\s;|&]|$)/g;
  return entry.exec(String(command))?.[1] || null;
}
