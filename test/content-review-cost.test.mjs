import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requireContentReview, contentReviewInputs, contentReviewStatus, recordContentReview,
  reviewContentIndependently, reviewRequestSizes, asyncReviewStatus, asyncReviewStart, asyncReviewFinish,
  asyncReviewCommand } from '../lib/content-review.mjs';

const reply = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] });

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-review-cost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '方案.md'), '已经知道：图纸\n\n不知道 / 容易误解：\n- 原型\n');
  fs.writeFileSync(path.join(dir, '脚本.md'), [
    '**主体**：设备', '', '## S1 · 设备', '← 依赖：无',
    '1. 模型生成了外壳图纸。', '2. 原型是用来测试的样品。',
    '3. 厂商用了一个月制作原型。', '4. 因为图纸合格，所以设备就可以直接上市。', '',
    '## S2 · 结论', '← 依赖：S1',
    '1. 因为样机做出来了，所以用户可以放心购买。', '2. 测试通过后才敢说这台设备可用。', '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify([{ id: 'C1', statement: '外壳图纸由模型生成',
    kind: '作者记录', scope: '本机', status: 'unverified', sourceType: 'recommendation',
    evidence: [{ type: 'note', quote: '重复的证据正文，不应在每次请求里重复发送' }] }]));
  fs.mkdirSync(path.join(dir, 'research'));
  fs.writeFileSync(path.join(dir, 'research/底稿.md'), '工程师须多轮修改图纸。原型完成后仍须做安全验证。');
  requireContentReview(dir);
  return dir;
}
const pass = input => ({ verdict: 'pass', question: '做到哪一步？', answer: '出图并做原型，再做测试。', scope: '整稿。',
  scenes: input.narration.map(s => ({ scene: s.scene, line: 1, takeaway: '进展。', bridge: '承接。' })),
  links: [], analogies: [], issues: [],
  findings: input.findings.map((_, i) => ({ i: i + 1, reason: '已核对旁白。' })),
  essentials: input.narration.map(s => ({ scene: s.scene, lines: [], reason: '无额外必要解释。' })) });

test('请求里不重复复制证据原文，findings 只带编号；记录仍逐项回答', async t => {
  const dir = project(t);
  let judge = null;
  const status = await reviewContentIndependently(dir, { provider: 'p', model: 'm', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    if (payload.phase === '仅听旁白复原') {
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '出图、原型、测试。', missing: [] })) });
    }
    judge = payload;
    return reply(pass(contentReviewInputs(dir)));
  } });
  assert.ok(judge, '第二阶段必须发生');
  assert.equal(JSON.stringify(judge).includes('重复的证据正文'), false, '证据原文已在 materials，不能在 claims 里重复');
  assert.ok(judge.input.context.materials.some(m => m.text.includes('工程师须多轮修改')));
  const claimsInRequest = Array.isArray(judge.input.context.claims) ? judge.input.context.claims : judge.input.context.claims.claims;
  assert.ok(claimsInRequest[0].evidence.length, '仍要保留证据存在与出处');
  assert.ok(judge.input.findings.every(f => Number.isInteger(f.i)), 'findings 用编号');
  assert.equal(status.ok, true);
  const findings = status.record.findings;
  assert.equal(findings.length, contentReviewInputs(dir).findings.length, '记录仍逐项覆盖');
  assert.ok(findings.every(f => f.reason.trim()), '不能留空理由');
});

test('模型漏答某条编号时，该条明确记为未核对而不是悄悄放行', async t => {
  const dir = project(t);
  const status = await reviewContentIndependently(dir, { provider: 'p', model: 'm', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    if (payload.phase === '仅听旁白复原') {
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '出图。', missing: [] })) });
    }
    return reply({ ...pass(contentReviewInputs(dir)), findings: [{ i: 2, reason: '只答第二条' }] });
  } });
  assert.equal(status.ok, false, '漏答不能放行');
  assert.equal(status.state, 'revise');
  assert.match(status.reason, /第1条没有回答/);
  assert.match(status.record.findings[0].reason, /未回答/);
  assert.match(status.record.findings[1].reason, /只答第二条/);
});

test('引用原句只接受完全相等，不做相似度猜测', async t => {
  const dir = project(t);
  const input = contentReviewInputs(dir);
  const exact = await reviewContentIndependently(dir, { provider: 'p', model: 'm', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    if (payload.phase === '仅听旁白复原') {
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '出图。', missing: [] })) });
    }
    const quoted = { ...pass(contentReviewInputs(dir)) };
    quoted.scenes = quoted.scenes.map((s, i) => ({ ...s, line: undefined, text: input.narration[i].lines[0] }));
    return reply(quoted);
  } });
  assert.equal(exact.record.scenes[0].quote, input.narration[0].lines[0]);
  const other = project(t);
  await assert.rejects(() => reviewContentIndependently(other, { provider: 'p', model: 'm', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    if (payload.phase === '仅听旁白复原') {
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '出图。', missing: [] })) });
    }
    const near = { ...pass(contentReviewInputs(other)) };
    near.scenes = near.scenes.map(s => ({ ...s, line: undefined, text: '模型生成了外壳图纸' }));
    return reply(near);
  } }), /不完全一致/);
});

test('改一场只复审该场；未改场的旧问题继续挂着，不会被当成已修', async t => {
  const dir = project(t);
  await reviewContentIndependently(dir, { provider: 'p', model: 'm', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    if (payload.phase === '仅听旁白复原') {
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '出图。', missing: [] })) });
    }
    return reply({ ...pass(contentReviewInputs(dir)), verdict: 'revise', issues: ['S1 第4句安全测试过程不足'] });
  } });
  assert.equal(contentReviewStatus(dir).state, 'revise');
  fs.writeFileSync(path.join(dir, '脚本.md'), fs.readFileSync(path.join(dir, '脚本.md'), 'utf8')
    .replace('2. 测试通过后才敢说这台设备可用。', '2. 测试通过、记录留档后，才敢说这台设备可用。'));
  const seen = [];
  const status = await reviewContentIndependently(dir, { provider: 'p', model: 'm', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    seen.push(payload);
    if (payload.phase === '仅听旁白复原') {
      assert.deepEqual(payload.narration.map(s => s.scene), [2], '只盲听改动场');
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '记录留档后可用。', missing: [] })) });
    }
    return reply({ verdict: 'pass', question: 'q', answer: 'a', scope: '只复核改动场。',
      scenes: [{ scene: 2, line: 2, takeaway: '留档后可用。', bridge: '接上场。' }],
      links: [], analogies: [], findings: [], issues: [],
      essentials: [{ scene: 2, lines: [2], reason: '要先知道留档。' }] });
  } });
  assert.equal(seen.length, 2);
  assert.equal(status.record.independent.scope, 'incremental');
  assert.equal(status.state, 'revise', '未改场的问题仍在，不能判pass');
  assert.match(status.reason || '', /S1/);
});

test('整稿基线、请求体积可查；异步状态按签名失效', t => {
  const dir = project(t);
  const sizes = reviewRequestSizes(dir);
  assert.equal(sizes.mode, 'full');
  assert.ok(sizes.total > 0 && sizes.judge > 0);
  assert.equal(asyncReviewStatus(dir).state, 'idle');
  asyncReviewStart(dir, { signature: contentReviewInputs(dir).signature, pid: process.pid });
  assert.equal(asyncReviewStatus(dir).state, 'running');
  asyncReviewFinish(dir, { state: 'revise' });
  assert.equal(asyncReviewStatus(dir).state, 'revise');
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n');
  const stale = asyncReviewStatus(dir);
  assert.equal(stale.stale, true, '输入变了，旧后台结论不能冒充当前旁白');
  const command = asyncReviewCommand(dir, { full: true });
  assert.ok(command.args.includes('--async-run'));
  assert.ok(command.args.includes('--full'));
  assert.equal(command.args.includes('--async'), false, '子进程不能再次派生');
});

test('单片截断时自动二分，失败只浪费一小片而不是整轮', async t => {
  const dir = project(t);
  const calls = [];
  const status = await reviewContentIndependently(dir, { provider: 'p', model: 'm', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    if (payload.phase === '仅听旁白复原') {
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '出图。', missing: [] })) });
    }
    const scenes = payload.input.shard?.scenes || [];
    calls.push(scenes.join(','));
    // Refuse anything wider than one scene, exactly like a real truncation.
    if (scenes.length > 1) return { choices: [{ finish_reason: 'length', message: { content: null } }] };
    return reply({ verdict: 'pass', question: 'q', answer: 'a', scope: '单片。',
      scenes: scenes.map(n => ({ scene: n, line: 1, takeaway: '进展。', bridge: '承接。' })),
      links: [], analogies: [], issues: [],
      findings: (payload.input.findings || []).map(item => ({ i: item.i, reason: '已核对。' })),
      essentials: scenes.map(n => ({ scene: n, lines: [], reason: '无额外必要解释。' })) });
  } });
  assert.ok(calls.some(c => c.includes(',')), '先尝试合片');
  assert.ok(calls.filter(c => !c.includes(',')).length >= 2, '截断后拆成单场');
  assert.equal(status.ok, true, '二分后仍然完成，而不是整轮作废');
});
