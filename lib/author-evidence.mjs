/* Evidence bindings inside 方案.md, observed by the real OpenCode runner.
 * This validates provenance and immutability, NOT natural-language entailment.
 * No model calls, new stage, claims document, or automatic semantic pass. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const MAX = 16;

export function parseEvidenceAnchors(plan) {
  const anchors = [], issues = [];
  for (const match of plan.matchAll(/^```evidence-anchors\s*\r?\n([\s\S]*?)^```\s*$/gm)) {
    let rows;
    try { rows = JSON.parse(match[1]); } catch { issues.push('事实锚 JSON 无法解析，未将其视为有效证据'); continue; }
    if (!Array.isArray(rows) || rows.length > MAX) { issues.push(`事实锚须为不超过 ${MAX} 项的数组，只登记核心高风险判断`); continue; }
    for (const row of rows) {
      if (!row || !/^[a-zA-Z0-9_-]{1,64}$/.test(row.id || '') ||
          typeof row.source?.path !== 'string' || !/^[a-f0-9]{64}$/.test(row.source?.sha256 || '') ||
          typeof row.source?.quote !== 'string' || !row.source.quote.trim() ||
          typeof row.supports !== 'string' || !row.supports.trim() ||
          !Array.isArray(row.conditions) || !row.conditions.every(v => typeof v === 'string') ||
          !Array.isArray(row.scenes) || !row.scenes.every(v => Number.isInteger(v) && v > 0)) {
        issues.push('事实锚缺少 id、原文 path/sha256/quote、可支持判断、条件或口播场号'); continue;
      }
      if (anchors.some(a => a.id === row.id)) { issues.push(`事实锚 ${row.id} 重复，未覆盖先前定义`); continue; }
      anchors.push({ id: row.id, source: { path: row.source.path, sha256: row.source.sha256, quote: row.source.quote },
        supports: row.supports, conditions: row.conditions, scenes: row.scenes });
    }
  }
  return { anchors, issues };
}

function sourceIssue(project, anchor) {
  try {
    const base = fs.realpathSync(project), target = fs.realpathSync(path.resolve(project, anchor.source.path));
    if (!target.startsWith(base + path.sep) || path.isAbsolute(anchor.source.path) || !fs.statSync(target).isFile()) return '原文路径越界或不是文件';
    if (fs.statSync(target).size > 8 * 1024 * 1024) return '原文过大，未读取或假定核对成功';
    const bytes = fs.readFileSync(target);
    if (hash(bytes) !== anchor.source.sha256) return '原文 SHA-256 不符，依据已变化';
    if (!bytes.toString('utf8').includes(anchor.source.quote)) return '引文不在已绑定原文内（逐字完整性，不是语义判定）';
    return null;
  } catch { return '原文缺失或不可读取'; }
}

const definition = a => JSON.stringify([a.source, a.supports, a.conditions]);

// Stored within the existing .vh-runner.json receipt. Capture each id once, from
// the plan and a local source; subsequent scripts/plans can never overwrite it.
export function captureAuthorEvidence(project, previous = null, { plan = read(path.join(project, '方案.md')) } = {}) {
  if (!plan.includes('```evidence-anchors')) return previous;
  const parsed = parseEvidenceAnchors(plan);
  const baseline = previous?.version === 1 ? previous : { version: 1, anchors: [], firstPlanSha256: hash(plan) };
  const next = [...baseline.anchors];
  for (const anchor of parsed.anchors) {
    if (next.some(a => a.id === anchor.id) || sourceIssue(project, anchor)) continue;
    next.push(anchor);
  }
  // Invalid markers are also observed, but never frozen as valid evidence.
  return { ...baseline, anchors: next };
}

function narration(script) {
  const scenes = [];
  let current = null;
  for (const line of script.split('\n')) {
    const heading = /^##\s+S(\d+)\b/.exec(line);
    if (heading) { current = { scene: Number(heading[1]), lines: [] }; scenes.push(current); continue; }
    if (/^##\s/.test(line)) { current = null; continue; }
    const numbered = /^\s*\d+[.、)]\s+(.+)$/.exec(line);
    if (current && numbered) current.lines.push(numbered[1]);
  }
  return scenes;
}

function extractNumericTokens(text) {
  return [...new Set((String(text || '').match(/\d+(?:,\d{3})*(?:\.\d+)?%?/g) || []).filter(token => token.length >= 2 || token.endsWith('%')))];
}

export function authorEvidenceStatus(project, { baseline, plan, script } = {}) {
  plan ??= read(path.join(project, '方案.md'));
  script ??= read(path.join(project, '脚本.md'));
  if (baseline === undefined) {
    try { baseline = JSON.parse(read(path.join(project, 'out/.vh-runner.json'))).authorEvidence; } catch {}
  }
  const parsed = parseEvidenceAnchors(plan);
  const frozen = baseline?.version === 1 ? baseline.anchors : [];
  if (!plan.includes('```evidence-anchors') && !frozen.length) return { status: 'not-configured', integrityIssues: [], pending: [], comparisons: [] };
  const integrityIssues = [...parsed.issues];
  const all = [...frozen, ...parsed.anchors.filter(a => !frozen.some(b => b.id === a.id))];
  const scenes = narration(script), opening = scenes.find(s => s.scene === 1) || scenes[0] || null, closing = scenes.at(-1) || null;
  const comparisons = [];
  for (const anchor of all) {
    const current = parsed.anchors.find(a => a.id === anchor.id);
    const bound = frozen.some(a => a.id === anchor.id);
    if (bound && (!current || definition(current) !== definition(anchor))) integrityIssues.push(`${anchor.id}：初始原文锚被删除或定义被改动；仍以首次绑定内容对照，不接受后续文稿反向覆盖`);
    const issue = sourceIssue(project, anchor);
    if (issue) integrityIssues.push(`${anchor.id}：${issue}`);
    const selected = current?.scenes || anchor.scenes;
    for (const n of selected) if (!scenes.some(s => s.scene === n)) integrityIssues.push(`${anchor.id}：对应口播 S${n} 不存在`);
    const matchedScenes = scenes.filter(s => selected.includes(s.scene));
    const spokenText = matchedScenes.flatMap(s => s.lines).join(' ');
    const quoteNumbers = extractNumericTokens(anchor.source.quote);
    const missingNumbers = quoteNumbers.filter(token => !spokenText.includes(token) && !spokenText.includes(token.replace(/,/g, '')));
    comparisons.push({ ...anchor, bound, sourceIntegrity: issue ? 'invalid' : 'matched',
      // These are actual opening, narration and closing lines, never just the source table.
      opening, narration: matchedScenes, closing, missingNumbers,
      semanticStatus: 'pending',
      questions: ['事件及否定、分母/样本/联合条件是否一致？合法互补概率是否改变了后续指代？',
        '变量、运算和前提是否一致？等价公式可以保留，不能将概率换成出错位置。',
        '相关性是否说成因果？开场承诺、研究范围、适用条件和结尾操作建议是否仍受原文支持？'] });
  }
  const pending = comparisons.map(a => `[原文事实锚待核] ${a.id}：对照原文、开场 S1、S${a.scenes.join('/S')} 编号旁白及结尾；引文/来源表匹配不等于语义成立。`);
  if (!all.length) pending.push('[原文事实锚待核] 未取得可绑定事实锚；不能将空锚或解析失败当语义通过。');
  return { status: 'pending', integrityIssues, pending, comparisons };
}

export function evidenceComparisonMarkdown(status) {
  if (status.status === 'not-configured') return '';
  const lines = ['## 原文事实锚对照（语义待核，不是自动审稿）',
    '程序只证明引文、路径、版本一致；supports 和 conditions 是作者解释，仍须写作 Agent 对照原文。不得只看来源表，必须读开场、正文与结尾。'];
  for (const issue of status.integrityIssues) lines.push('- 依据完整性问题：' + issue);
  for (const a of status.comparisons) {
    lines.push(`\n### ${a.id}`, `原文：${a.source.path} · sha256 ${a.source.sha256} · ${a.sourceIntegrity}`,
      a.bound ? '首次绑定：已登记，后续定义不可反向覆盖。' : '首次绑定：未登记；这里只是当前方案对照，不是历史不可变依据。',
      a.source.quote, '作者登记的可支持判断（非自动验证）：' + a.supports,
      '关键条件：' + a.conditions.join('；'),
      '开场 S1 编号口播（核对题头承诺与口径是否同步）：', a.opening ? a.opening.lines.join('\n') : '未找到开场',
      '对应编号口播：');
    for (const scene of a.narration) lines.push(`S${scene.scene}：\n` + scene.lines.join('\n'));
    if (a.missingNumbers?.length) {
      lines.push(`字面数值线索（仅提示，中文数字或互补写法可能合法）：原文引文中的 ${a.missingNumbers.join('、')} 未在对应场次字面出现，请确认是否已准确转述或故意取补集。`);
    }
    lines.push('结尾编号口播（须独立核对操作建议）：', a.closing ? a.closing.lines.join('\n') : '未找到结尾', ...a.questions.map(q => '- 待核：' + q));
  }
  return lines.join('\n') + '\n';
}
