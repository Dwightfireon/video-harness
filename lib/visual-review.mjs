/* 画面审阅的程序侧体检：只报机器能判的结构与像素疑点。
 * 不声称看过美术效果，也不把“没有疑点”当成画面对。
 *
 * ⚠ 真实事故：collect 收到的是检查**结果**，却被当成函数 `run()` 调用，
 * 四项检查全部报 `run is not a function`；报告却写“0 处疑点”，任务照样标完成。
 * 现在：明确区分「跑成功且无疑点」「有疑点」「检查失败/未执行」，失败不算通过。 */
import fs from 'node:fs';
import path from 'node:path';
import { collectVisualIntents, visualIntentSummary } from './scene-visual.mjs';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const pick = f => f?.msg || f?.message || (typeof f === 'string' ? f : JSON.stringify(f));

function collect(name, analyze) {
  try {
    if (typeof analyze !== 'function') throw new Error('检查器没有提供可调用的 analyze');
    const result = analyze();
    const findings = Array.isArray(result?.findings) ? result.findings : [];
    if (result?.error || (result?.ok === false && !findings.length)) {
      throw new Error(result.error || result.note || '检查未完成，不能报告无疑点');
    }
    return { name, status: findings.length ? 'findings' : 'clear', ok: findings.length === 0,
      count: findings.length, findings: findings.slice(0, 30).map(pick),
      ...(result?.note ? { note: result.note } : {}) };
  } catch (e) {
    return { name, status: 'failed', ok: false, count: 0, findings: [], error: e.message };
  }
}

export async function runVisualReview(project) {
  const checks = [];
  const add = async (name, file, method = 'analyze') => {
    try { const mod = await import(file); checks.push(collect(name, () => mod[method](project))); }
    catch (e) { checks.push({ name, status: 'failed', ok: false, count: 0, findings: [], error: '检查模块无法加载：' + e.message }); }
  };
  await add('版式', './layout-check.mjs');
  await add('图文对应', './screen-check.mjs');
  await add('版式分布', './variety.mjs');
  await add('文字对比度', './contrast.mjs');
  await add('动作时间点（静态线索）', './motion.mjs', 'scan');
  /* 实际像素检查需要浏览器与截图，会明显变慢；明确标为未执行，不伪装成通过。 */
  checks.push({ name: '静帧/像素密度', status: 'skipped', ok: false, count: 0, skipped: true,
    note: '本轮未执行像素级空屏检查（需浏览器截图）；要检查可运行 vh density' });
  checks.push({ name: '连续运动/视听审阅', status: 'skipped', ok: false, count: 0, skipped: true,
    note: '本轮未连续观看或试听；vh alive / vh pacing 可提供抽样线索，不能代替人工核对旁白与动作' });
  const failed = checks.filter(c => c.status === 'failed');
  const visualIntent = collectVisualIntents(project);
  const review = { at: new Date().toISOString(), checks, visualIntent,
    total: checks.reduce((n, c) => n + c.count, 0),
    failed: failed.length,
    /* 只有“全部跑成功且无疑点”才算机械通过；失败与未执行都不算。 */
    ok: !failed.length && checks.every(c => c.status === 'clear' || c.status === 'findings' ? c.count === 0 : false),
    note: '这些只覆盖排版越界/重叠、文字与字幕重复、对比度、版式分布、代码层对象及部分动作起点；不判断构图、色彩、审美、语音同步与实际渲染是否有错。' };
  const out = path.join(project, 'out');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, '.vh-visual-review.json'), JSON.stringify(review, null, 2) + '\n');
  return review;
}

export function reviewSummary(review) {
  const head = review.failed ? `画面机械体检：${review.failed} 项检查失败，结论无效`
    : `画面机械体检：${review.total} 处疑点（报告 out/.vh-visual-review.json）`;
  const lines = [head];
  for (const c of review.checks) {
    if (c.skipped) lines.push(`  – ${c.name}：${c.note || '本轮未运行'}`);
    else if (c.status === 'failed') lines.push(`  ✗ ${c.name}：检查失败 —— ${c.error}（不能当作画面正确）`);
    else if (c.count) lines.push(`  ⚠ ${c.name}：${c.count} 处 —— ` + c.findings.slice(0, 3).join('；'));
    else lines.push(`  ✓ ${c.name}：无机器可判疑点`);
  }
  lines.push('  ' + review.note);
  if (review.visualIntent) lines.push('', visualIntentSummary(review.visualIntent));
  return lines.join('\n');
}

export function latestReview(project) {
  try { return JSON.parse(read(path.join(project, 'out/.vh-visual-review.json'))); } catch { return null; }
}
