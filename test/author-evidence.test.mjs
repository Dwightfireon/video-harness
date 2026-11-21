import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseEvidenceAnchors, captureAuthorEvidence, authorEvidenceStatus, evidenceComparisonMarkdown } from '../lib/author-evidence.mjs';
import { analyze, writeReport } from '../lib/clarity.mjs';
import { createRunner, readSession } from '../lib/runners/opencode.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-evidence-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'research'));
  const text = 'After the first mistake, 69.5% never recover, 38.5% never notice, and 72.6% keep acting. All three occur in 13.7%.\n'
    + 'If every step succeeds independently with probability r, H steps succeed with probability r^H.';
  fs.writeFileSync(path.join(dir, 'research/paper.txt'), text);
  const anchors = [{ id: 'joint-event', source: { path: 'research/paper.txt', sha256: sha(text), quote: text.split('\n')[0] },
    supports: '13.7% 为未恢复、未察觉、继续动作的联合事件；不是恢复事件的交集。', conditions: ['有首错的样本；保持三个事件的否定关系'], scenes: [1] },
  { id: 'formula', source: { path: 'research/paper.txt', sha256: sha(text), quote: text.split('\n')[1] },
    supports: 'P=r^H。变量 r 是单步正确概率，H 是依赖步数。', conditions: ['独立、固定可靠率；假设算例非实测'], scenes: [2] }];
  const plan = '# 方案\n\n## 数字与来源\n\n```evidence-anchors\n' + JSON.stringify(anchors, null, 2) + '\n```\n';
  fs.writeFileSync(path.join(dir, '方案.md'), plan);
  return { dir, text, anchors, plan };
}
const script = (a, b) => `## S1 · 统计\n1. ${a}\n← 依赖：无\n\n## S2 · 结尾\n1. ${b}\n← 依赖：S1\n\n## 数字与来源\n| 数字 | 定义 |\n|---|---|\n| 13.7% | 未恢复、未察觉、继续动作 |\n`;

test('原文锚绑定实际来源、冻结首次定义，后续方案不能反向覆盖', t => {
  const f = fixture(t), baseline = captureAuthorEvidence(f.dir);
  assert.equal(baseline.anchors.length, 2);
  f.anchors[0].supports = '13.7% 为恢复、未察觉、继续动作';
  fs.writeFileSync(path.join(f.dir, '方案.md'), '```evidence-anchors\n' + JSON.stringify(f.anchors) + '\n```');
  assert.deepEqual(captureAuthorEvidence(f.dir, baseline), baseline);
  const status = authorEvidenceStatus(f.dir, { baseline, script: script('30.5% 最终恢复。三件事同时出现13.7%。', '两个数一乘。') });
  assert.ok(status.integrityIssues.some(s => s.includes('定义被改动')));
  assert.ok(status.comparisons[0].supports.includes('未恢复'));
  assert.equal(status.status, 'pending');
});

test('文件哈希、逐字引文、缺失来源和越界可确定判定；不伪称语义成立', t => {
  const f = fixture(t), baseline = captureAuthorEvidence(f.dir);
  fs.appendFileSync(path.join(f.dir, 'research/paper.txt'), ' changed');
  assert.ok(authorEvidenceStatus(f.dir, { baseline }).integrityIssues.some(s => s.includes('SHA-256')));
  fs.writeFileSync(path.join(f.dir, 'research/paper.txt'), f.text);
  const rows = structuredClone(f.anchors); rows[0].source.quote = 'The agent recovered in 13.7%.';
  const plan = '```evidence-anchors\n' + JSON.stringify(rows) + '\n```';
  assert.ok(authorEvidenceStatus(f.dir, { plan }).integrityIssues.some(s => s.includes('引文不在')));
  rows[0].source.path = '../outside.txt';
  const escaped = authorEvidenceStatus(f.dir, { plan: '```evidence-anchors\n' + JSON.stringify(rows) + '\n```' });
  assert.ok(escaped.integrityIssues.length);
});

test('正反例均诚实待核：自然语言的同义/补集/等价公式不得被词面规则误判', t => {
  const f = fixture(t), baseline = captureAuthorEvidence(f.dir);
  const cases = [
    ['正确联合事件', '未恢复、未察觉、继续做同时出现13.7%。', '成功率是 r 的 H 次方。'],
    ['合法互补概率', '首错后30.5%最终恢复；另有13.7%未恢复、未察觉且继续动作。', '同一可靠率连乘H次。'],
    ['等价公式', '13.7%对应不恢复、不自知、继续执行的交集。', 'P = r ** H，r固定且各步独立。'],
    ['错误事件反转', '30.5%恢复、38.5%未察觉、72.6%继续，三件事同时出现13.7%。', 'P=r^H。'],
    ['错误算子', '13.7%为未恢复的联合事件。', '成功率 P = r×H。'],
    ['变量偷换', '13.7%为未恢复的联合事件。', '数任务多少步和首次出错的位置，两个数一乘。'],
  ];
  for (const [name, a, b] of cases) {
    const status = authorEvidenceStatus(f.dir, { baseline, script: script(a, b) });
    assert.deepEqual(status.integrityIssues, [], name + '：来源一致，不等于内容对');
    assert.equal(status.status, 'pending', name);
    assert.ok(status.comparisons.every(c => c.semanticStatus === 'pending'), name);
    assert.ok(status.comparisons[0].closing.lines.includes(b), '结尾必须进入对照，不靠来源表放行');
    assert.ok(evidenceComparisonMarkdown(status).includes(b));
  }
});

test('历史 B2 正确来源表不能覆盖错误口播；输出对应正文及结尾待核', t => {
  const f = fixture(t), baseline = captureAuthorEvidence(f.dir);
  const root = path.resolve(import.meta.dirname, '..');
  const file = path.join(root, 'diagnostics/writing-exp-round2-20261112/manuscripts/B2-脚本.md');
  if (!fs.existsSync(file)) return;
  f.anchors[0].scenes = [8]; f.anchors[1].scenes = [11];
  fs.writeFileSync(path.join(f.dir, '方案.md'), '```evidence-anchors\n' + JSON.stringify(f.anchors) + '\n```');
  const status = authorEvidenceStatus(f.dir, { baseline: captureAuthorEvidence(f.dir), script: fs.readFileSync(file, 'utf8') });
  const report = evidenceComparisonMarkdown(status);
  assert.match(report, /只有 30.5%/);
  assert.match(report, /三件事同时出现的，占 13.7%/);
  assert.match(report, /两个数一乘/);
  assert.equal(status.status, 'pending');
});

test('现有 clarity 直接展示对照；无锚旧稿行为不变，空/坏锚不能当通过', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.dir, '脚本.md'), script('30.5%恢复；三件事同时13.7%。', '两个数相乘。'));
  const res = analyze(f.dir);
  assert.ok(res.pending.some(p => p.includes('原文事实锚待核')));
  writeReport(f.dir, res);
  assert.match(fs.readFileSync(path.join(f.dir, '审查-解释.md'), 'utf8'), /结尾编号口播/);
  assert.equal(authorEvidenceStatus(f.dir, { plan: '# 无锚' }).status, 'not-configured');
  assert.equal(authorEvidenceStatus(f.dir, { plan: '```evidence-anchors\n{}\n```' }).status, 'pending');
  assert.ok(parseEvidenceAnchors('```evidence-anchors\n{bad}\n```').issues.length);
});

test('实际 OpenCode 事件路径在首次方案写入时绑定，后续错误稿不能覆盖（本地假执行器，无模型调用）', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.dir, 'out'));
  const changed = structuredClone(f.anchors); changed[0].supports = '恢复、未察觉、继续动作同时占13.7%';
  const fake = path.join(f.dir, 'fake-opencode.cjs');
  fs.writeFileSync(fake, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const emit = (type, part) => console.log(JSON.stringify({type,sessionID:'local-fixture',part}));
const written = (path, content) => emit('tool_use',{tool:'write',state:{status:'completed',input:{path,content},output:'written'}});
// Both tool events may reach the parent in one pipe chunk, after the file has
// already changed. The first input.content must still win, not the latest disk.
written('方案.md', ${JSON.stringify(f.plan)});
const proceed = () => {
 fs.writeFileSync('方案.md', ${JSON.stringify('```evidence-anchors\n' + JSON.stringify(changed) + '\n```')});
 written('方案.md', ${JSON.stringify('```evidence-anchors\n' + JSON.stringify(changed) + '\n```')});
 fs.writeFileSync('脚本.md', ${JSON.stringify(script('30.5%恢复，三件事同时13.7%。', '两个数一乘。'))});
 written('脚本.md'); emit('text',{text:'稿件已保存，语义未审。'});
};
proceed();
`, { mode: 0o700 });
  const logs = [];
  const runner = createRunner(f.dir, { model: 'fixture/not-paid', service: 'private', childEnv: { ...process.env, VH_OPENCODE_BIN: fake } });
  await runner.run({ prompt: 'local test only', mode: 'topic', log: line => logs.push(line) });
  const saved = readSession(f.dir).authorEvidence;
  assert.equal(saved.anchors[0].supports, f.anchors[0].supports);
  assert.ok(logs.some(l => l.includes('初始原文锚被删除或定义被改动')));
  assert.ok(logs.some(l => l.includes('语义待核')));
  assert.equal(authorEvidenceStatus(f.dir).status, 'pending');
});
