import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAgent } from '../lib/agent.mjs';
import { PUBLISH_TASK } from '../lib/publish.mjs';
import { analyze as analyzeHook, report as reportHook } from '../lib/hook.mjs';
import { analyze as analyzeArc, report as reportArc } from '../lib/arc.mjs';
import { analyze as analyzeLoop, report as reportLoop } from '../lib/loop.mjs';
import { analyze as analyzeDepth, report as reportDepth } from '../lib/depth.mjs';

const root = path.join(import.meta.dirname, '..');
const providers = [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-editorial-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  return dir;
}

test('新制作任务的实际系统提示包含原文主线、广告口径和已发布边界', async t => {
  const dir = fixture(t);
  let system = '';
  await runAgent(dir, '检查画面', { mode: 'edit-visual', taskId: 'editorial-prompt', providers,
    request: async (_provider, messages) => {
      system = messages[0].content;
      return { choices: [{ message: { role: 'assistant', content: '完成' } }] };
    } });
  assert.match(system, /原文主题、核心判断、论述顺序和视频段落映射/);
  assert.match(system, /开场先说清主题、为什么讲和要回答什么/);
  assert.match(system, /用户未要求的风险提示/);
  assert.match(system, /法律、平台要求与用户口径冲突/);
  assert.match(system, /本片已发布、只要求以后吸取教训时，不修改或重做/);
  assert.doesNotMatch(system, /前 3 句里要有设问或反常识断言|开场先抛误解/);
  assert.match(PUBLISH_TASK, /广告逐项对照用户口径/);
  assert.match(PUBLISH_TASK, /不擅自增加风险提示/);
});

test('新审查模板包含原文、开场与跨渠道广告核对，不覆盖已有审查', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 开场\n1. 先交代这期讲什么。\n← 依赖：无\n');
  const run = () => spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'review-init', '--dir', dir],
    { encoding: 'utf8', timeout: 30000 });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const file = path.join(dir, '审查.md');
  const review = fs.readFileSync(file, 'utf8');
  assert.match(review, /原文主线.*承接原文/);
  assert.match(review, /仅听开头能否知道讲什么、为什么讲/);
  assert.match(review, /口播、字幕、画面、简介、置顶评论逐项对照用户要求/);
  assert.match(review, /法律、平台要求与用户口径冲突/);
  assert.doesNotMatch(review, /^- \[x\]/m, '模板不能自动标记审阅通过');
  fs.appendFileSync(file, '\n用户已有的审查记录\n');
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /用户已有的审查记录/);
});

test('ProdClub 参考口播保留用户口径，不塞入额外价格或风险提示', () => {
  const md = fs.readFileSync(path.join(root, 'references/ad-prodclub.md'), 'utf8');
  const spoken = md.match(/## 参考口播[^\n]*\n\s*\n> ([^\n]+)/)?.[1] || '';
  assert.match(spoken, /这是广告/);
  assert.match(spoken, /第三方/);
  assert.match(spoken, /已有的账号，不发新号/);
  assert.match(spoken, /感兴趣的朋友可以自己去官网了解/);
  assert.doesNotMatch(spoken, /风险|代充|价格/);
});

test('直接交代主题的开场不会被诊断为观众必然离开，也不被要求硬加设问', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 主题\n1. 这期讲人工智能如何找到外部资料。\n2. 我们会比较几种寻找资料的方法。\n');
  const output = reportHook(analyzeHook(dir));
  assert.match(output, /直接交代主题也是有效讲法/);
  assert.match(output, /不必为数量添加设问/);
  assert.doesNotMatch(output, /观众大概率划走|没有理由看下去|每 2–3 场放一个真问题/);
  assert.match(output, /不能推成所有视频必须设问或制造反转/);
  const result = analyzeHook(dir);
  assert.equal(result.ok, true);
  assert.ok(result.findings.every(f => f.severity === 'info'));
  const cli = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'hook', '--strict', '--dir', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /不代表内容审阅通过/);
});

test('无设问的讲解不触发闭环失败；真实设问未匹配仍提示核对', t => {
  const dir = fixture(t);
  const script = path.join(dir, '脚本.md');
  fs.writeFileSync(script, '## S1 · 主题\n1. 这期讲人工智能如何寻找资料。\n## S2 · 方法\n1. 首先读取本地文件。\n');
  const result = analyzeLoop(dir);
  assert.equal(result.ok, true);
  assert.equal(result.questions.length, 0);
  assert.match(reportLoop(result), /无需为此添加设问/);
  const cli = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'loop', '--strict', '--dir', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  fs.writeFileSync(script, '## S1 · 提问\n1. 数据究竟存在哪里？\n## S2 · 其他\n1. 接着说天气。\n');
  const unanswered = analyzeLoop(dir);
  assert.ok(unanswered.findings.some(f => f.kind === 'unanswered'));
  assert.match(reportLoop(unanswered), /未匹配到回答/);
});

test('叙事弧与展开度只提供形式线索，不强迫原文套冲突或凑字数', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 主题\n1. 这期讲如何检索资料。\n## S2 · 方法\n1. 先看本地文件。\n');
  const arc = reportArc(analyzeArc(dir));
  assert.match(arc, /不适用于所有讲解/);
  assert.match(arc, /不要为套 ABT 编造冲突/);
  const depth = reportDepth(dir, analyzeDepth(dir));
  assert.match(depth, /形式线索/);
  assert.match(depth, /不必为指标凑内容/);
  const cli = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'depth', '--dir', dir], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /不为形式规则凑句子/);
  assert.doesNotMatch(cli.stdout, /把上面每条落实/);
});
