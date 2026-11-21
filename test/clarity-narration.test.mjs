import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyze, writeReport } from '../lib/clarity.mjs';
import { compute } from '../lib/score.mjs';

function project(t, speech, { known = '', unknown = '', terms = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-clarity-narration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '方案.md'), `已经知道：${known}\n\n不知道：${unknown}\n`);
  fs.writeFileSync(path.join(dir, '脚本.md'), `## S1 · 故事\n${speech.map((l, i) => `${i + 1}. ${l}`).join('\n')}\n← 依赖：无\n\n## 术语\n${terms}\n`);
  return dir;
}

test('受众表格与加粗行标记均识别中文未知术语；不存在的依赖不能通过', t => {
  const dir = project(t, ['默会知识影响了他的判断。']);
  fs.writeFileSync(path.join(dir, '方案.md'), '| **观众已经知道** | **观众不知道** |\n| :--- | ---: |\n| 骑车 | 默会知识 |\n');
  let res = analyze(dir);
  assert.deepEqual(res.known, ['骑车']);
  assert.deepEqual(res.unknown, ['默会知识']);
  assert.ok(res.fail.some(x => x.includes('默会知识')));
  fs.writeFileSync(path.join(dir, '方案.md'), '**已经知道**：骑车\n\n**观众不知道**：默会知识\n');
  assert.deepEqual(analyze(dir).unknown, ['默会知识']);
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n## S2 · 后续\n1. 他拿出了下一份材料。\n← 依赖：S0\n');
  res = analyze(dir);
  assert.ok(res.fail.some(x => x.includes('不存在的 S0')));
});

test('待核提示计入评分展示，不再显示0警告；不是自动内容通过', t => {
  const dir = project(t, ['默会知识让这个故事有了另一种读法。'], { terms: '- 默会知识：会做但不容易完整说出的知识。' });
  const clarity = compute(dir).dims.clarity;
  assert.ok(clarity.pending > 0);
  assert.ok(clarity.warnings >= clarity.pending);
  assert.match(clarity.label, /非内容审稿/);
  assert.match(clarity.detail, /待核.*不代表讲通/);
});

test('开场无依赖可带括号注释，但注释中的不存在/前向依赖不能被无字掩盖', t => {
  const dir = project(t, ['他把纸放在桌上。']);
  const file = path.join(dir, '脚本.md'), original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replace('依赖：无', '依赖：无（开场）'));
  assert.equal(analyze(dir).fail.length, 0);
  fs.writeFileSync(file, original.replace('依赖：无', '依赖：无（但接 S0）'));
  assert.ok(analyze(dir).fail.some(x => x.includes('不存在的 S0')));
  fs.writeFileSync(file, original.replace('依赖：无', '依赖：并非无依赖'));
  assert.ok(analyze(dir).fail.some(x => x.includes('是开场')));
});

test('术语表不替代旁白解释：没有硬失败也保留待核提示', t => {
  const dir = project(t, ['默会知识让这个故事有了另一种读法。'], { terms: '- 默会知识：会做但不容易完整说出的知识。' });
  const res = analyze(dir);
  assert.deepEqual(res.fail, []);
  assert.ok(res.pending.some(x => x.includes('[口播解释待核]') && x.includes('默会知识')));
  const report = fs.readFileSync(writeReport(dir, res), 'utf8');
  assert.match(report, /先只读编号旁白/);
  assert.match(report, /不证明观众听懂/);
});

test('口播当场解释或受众已知，不新增术语表待核', t => {
  for (const [speech, known] of [['默会知识指的是会做却很难完整说出的知识。', ''], ['默会知识让这个故事有了另一种读法。', '默会知识']]) {
    const res = analyze(project(t, [speech], { known, terms: '- 默会知识：会做但难以完整说出的知识。' }));
    assert.equal(res.pending.some(x => x.includes('[口播解释待核]')), false);
  }
});

test('受众未知项已在口播解释时不再误报缺定义', t => {
  const res = analyze(project(t, ['默会知识指的是会做却很难完整说出的知识。'], { unknown: '默会知识' }));
  assert.deepEqual(res.fail, []);
});

test('强类比包含上下文且仅待核，否定或引用不自动判错', t => {
  const res = analyze(project(t, ['先看两个故事各发生了什么。', '不能因此说它们是同一个结构。', '它们的相似之处很有限。']));
  assert.deepEqual(res.fail, []);
  const items = res.pending.filter(x => x.includes('[类比跨步待核]'));
  assert.equal(items.length, 1);
  assert.match(items[0], /先看两个故事/);
  assert.match(items[0], /相似之处很有限/);
  assert.match(items[0], /否定或引用/);
});

test('术语和依赖都通过时，跳到选型建议仍提示结论链待核', t => {
  const dir = project(t, [
    '表格识别分数是 90 分。',
    '所以你应该优先选它。',
  ]);
  const res = analyze(dir);
  assert.deepEqual(res.fail, []);
  assert.equal(res.keyClaims.length, 1);
  assert.equal(res.keyClaims[0].hasNearbyBridge, false);
  assert.ok(res.pending.some(item => item.includes('[结论链待核]') && item.includes('优先选它')));
});

test('先说能力怎样改变结果，再给条件化建议，不误报附近结论链断裂', t => {
  const dir = project(t, [
    '它先识别表格的行列关系，再把单元格写回对应位置。',
    '这样表格不会散成一行；如果你需要保留表格结构，就可以优先试它。',
  ]);
  const res = analyze(dir);
  assert.equal(res.keyClaims.length, 1);
  assert.equal(res.keyClaims[0].hasNearbyBridge, true);
  assert.equal(res.pending.some(item => item.includes('[结论链待核]')), false);
});

test('未知标题斜线和自然语言未知项不会静默丢失；所有格不是定义', t => {
  const dir = project(t, ['先公布权重的指纹，然后附上证明。']);
  fs.writeFileSync(path.join(dir, '方案.md'), '已经知道：聊天\n\n不知道 / 容易误解：\n- 不知道权重是什么意思\n');
  assert.deepEqual(analyze(dir).unknown, ['不知道权重是什么意思']);
  assert.ok(analyze(dir).fail.some(s => s.includes('权重')));
  assert.equal(analyze(dir, { legacy: true }).unknown.length, 0, '旧契约维持原解析，不追溯改片');
});

test('别的主语含“是”不解释术语；长受众前提保留并转语义待核', t => {
  const dir = project(t, ['这是谁的权重指纹？'], { unknown: '权重' });
  assert.ok(analyze(dir).fail.some(s => s.includes('权重')));
  fs.writeFileSync(path.join(dir, '方案.md'), '不知道：不知道模型服务可能被中间商换成更便宜的模型而观众以为选了哪个模型每次回答就来自哪个模型\n');
  assert.ok(analyze(dir).unknown[0].length > 40);
  assert.ok(analyze(dir).pending.some(s => s.includes('受众前提待核')));
});

test('新闻解说的能力/份额/法律边界也属于候选判断，空关键词不表示审稿通过', t => {
  const res = analyze(project(t, ['它没证明模型能独立量产。', '请求量比较不等于市场份额。', '顾问意见不等于判决。']));
  assert.equal(res.keyClaims.length, 3);
});
