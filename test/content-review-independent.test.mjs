import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { requireContentReview, reviewVersion, contentReviewInputs, contentReviewStatus, recordContentReview,
  reviewContentIndependently, rememberReviewMaterial, assertContentReviewed } from '../lib/content-review.mjs';
import { runAgent, makeTools, toolSchema, runIndependentContentReview } from '../lib/agent.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { ProviderRequestError } from '../lib/provider-pool.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-independent-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '方案.md'), '已经知道：图纸\n\n不知道 / 容易误解：\n- 原型\n\n作者自评：这份脚本一定通过。');
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：设备\n\n## S1 · 设备\n← 依赖：无\n1. 模型生成了外壳图纸。\n2. 原型是用来测试的样品。\n3. 厂商用了一个月制作原型。\n4. 这个设备已经完成全部安全验证。\n');
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  requireContentReview(dir);
  return dir;
}
const reply = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10 } });
function makeSafe(dir) {
  const file = path.join(dir, '脚本.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('这个设备已经完成全部安全验证。', '工程师接着对原型进行漏电和过热测试。'));
}
function reconstruction(input, missing = []) {
  return { scenes: input.narration.map(s => ({ scene: s.scene, understood: '模型出图并做了原型，但安全验证没有过程。', missing })) };
}
function judgment(input, edits = {}) {
  return { verdict: 'pass', question: '设备做到了哪一步？', answer: '模型出图并做成原型。', scope: '核对过程与安全结论，不是强行三步链。',
    scenes: input.narration.map(s => ({ scene: s.scene, quote: s.lines[0], takeaway: '设计和原型的进展。', bridge: '交代对象和步骤。' })),
    links: [], analogies: [], findings: input.findings.map(finding => ({ finding, reason: '已核对旁白。' })), issues: [],
    essentials: input.narration.map(s => ({ scene: s.scene, quotes: [s.lines[1]], reason: '观众须先知道原型是什么。' })), ...edits };
}
async function mocked(dir, { missing = [], edits = {}, inspect = () => {} } = {}) {
  let n = 0;
  return reviewContentIndependently(dir, { provider: 'fixture', model: 'fixture-model', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    inspect(payload, ++n, messages);
    const input = contentReviewInputs(dir);
    return reply(n === 1 ? reconstruction(input, missing) : judgment(input, edits));
  } });
}

test('新项目 v3 不接受作者通过声明、伪造独立来源或无请求器回退', async t => {
  const dir = fixture(t), input = contentReviewInputs(dir);
  assert.equal(reviewVersion(dir), 3);
  assert.throws(() => recordContentReview(dir, { ...judgment(input), signature: input.signature,
    reconstruction: reconstruction(input), independent: { kind: 'isolated-two-pass', provider: 'fake', model: 'fake' } }), /独立内容审稿/);
  await assert.rejects(() => reviewContentIndependently(dir), /请求器未配置/);
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  assert.deepEqual(toolSchema(tools).find(x => x.function.name === 'review_content').function.parameters.required, ['signature']);
  assert.match(await tools.review_content.run({ signature: input.signature, verdict: 'pass' }), /不能回退自审/);
  assert.equal(contentReviewStatus(dir).ok, false);
});

test('先盲听复原，后看完整资料；作者理由/标题不进入盲听；引文真实的错误链由独立意见拦住', async t => {
  const dir = fixture(t);
  rememberReviewMaterial(dir, 'task', { kind: 'user-task', text: '调研设备安全，不能只给结论。' });
  fs.mkdirSync(path.join(dir, 'research'));
  fs.writeFileSync(path.join(dir, 'research/原文.md'), '工程师须多轮修改图纸。原型完成后仍须做安全验证。');
  const issue = 'S1 第4句没有安全测试过程，图纸和原型不能推出完成全部安全验证。';
  const status = await mocked(dir, { missing: [issue], edits: { verdict: 'revise', issues: [issue] }, inspect: (p, n, messages) => {
    assert.equal(messages.length, 2);
    if (n === 1) {
      assert.deepEqual(Object.keys(p).sort(), ['audience', 'instruction', 'narration', 'phase']);
      assert.equal(JSON.stringify(p).includes('作者自评'), false);
      assert.equal(JSON.stringify(p).includes('工程师须多轮'), false);
      assert.deepEqual(p.audience.unknown, ['原型']);
    } else {
      assert.ok(p.input.context.materials.some(m => m.text.includes('工程师须多轮修改')));
      assert.ok(p.input.context.materials.some(m => m.text.includes('不能只给结论')));
    }
  } });
  assert.equal(status.state, 'revise');
  assert.throws(() => assertContentReviewed(dir), /安全测试过程/);
  assert.equal((await nextPipelineWork(dir, 'topic')).stage, 'review_content');
  assert.equal(fs.existsSync(path.join(dir, 'review.json')), false);
});

test('盲听有缺口时，第二阶段或作者不能用背景补台阶强判pass', async t => {
  const dir = fixture(t);
  const result = await mocked(dir, { missing: ['原型与安全验证之间缺少步骤'] });
  assert.equal(result.state, 'revise');
  assert.match(result.reason, /S1：原型与安全验证之间缺少步骤/);
  assert.equal(contentReviewStatus(dir).ok, false);
});

test('完整独立记录可放行；必要解释基线进入下次复核，来源改变自动失效', async t => {
  const dir = fixture(t);
  makeSafe(dir);
  rememberReviewMaterial(dir, 'task', { text: '完整原文' });
  const pass = await mocked(dir);
  assert.equal(pass.ok, true);
  assert.equal(pass.record.independent.kind, 'isolated-two-pass');
  assert.equal(pass.record.kind, 'declared-content-review', '不伪装为人工发布审阅');
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n');
  assert.equal(contentReviewStatus(dir).state, 'stale');
  await mocked(dir, { inspect: (p, n) => { if (n === 2) assert.deepEqual(p.previousEssentials, pass.record.essentials); } });
  await mocked(dir, { edits: { verdict: 'revise', issues: ['这一版删掉了必要说明'] } });
  await mocked(dir, { inspect: (p, n) => { if (n === 2) assert.deepEqual(p.previousEssentials, pass.record.essentials, '返修不能清掉上次通过稿的解释基线'); } });
  rememberReviewMaterial(dir, 'task', { text: '原文已改变' });
  assert.equal(contentReviewStatus(dir).state, 'stale');
});

test('审稿期间输入变化、截断、无效JSON、缺场和请求失败都不能落pass回执', async t => {
  for (const kind of ['changed', 'truncated', 'json', 'coverage', 'network']) {
    const dir = fixture(t);
    await assert.rejects(() => reviewContentIndependently(dir, { provider: 'fixture', model: 'fixture-model', chat: async () => {
      if (kind === 'changed') { fs.appendFileSync(path.join(dir, '脚本.md'), '\n'); return reply({}); }
      if (kind === 'truncated') return { choices: [{ finish_reason: 'length', message: { content: '{}' } }] };
      if (kind === 'json') return { choices: [{ finish_reason: 'stop', message: { content: 'not-json' } }] };
      if (kind === 'coverage') return reply({ ...judgment(contentReviewInputs(dir)), scenes: [] });
      throw new Error('network fixture');
    } }));
    assert.equal(contentReviewStatus(dir).ok, false, kind);
  }
});

test('独立资料读取拒绝符号链接/目录穿越/超预算，不静默截断', t => {
  const dir = fixture(t);
  fs.mkdirSync(path.join(dir, 'research'));
  const file = path.join(dir, 'research/source.md');
  fs.symlinkSync(path.join(dir, '方案.md'), file);
  assert.throws(() => contentReviewInputs(dir), /符号链接/);
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'x'.repeat(512 * 1024 + 1));
  assert.throws(() => contentReviewInputs(dir), /静默截断/);
  fs.writeFileSync(file, '实际原文');
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify([{ evidence: [{ path: '../other.md' }] }]));
  assert.throws(() => contentReviewInputs(dir), /项目内相对路径/);
});

test('真实Agent调用隔离审稿：同渠道同模型，独立用量计入总账，失败不能跳到分镜', async t => {
  const dir = fixture(t), providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }];
  makeSafe(dir);
  let author = 0, independent = 0;
  const request = async (provider, messages, schemas) => {
    assert.equal(provider.name, 'opendesign');
    if (!schemas.length) {
      independent++;
      assert.equal(messages.length, 2);
      assert.equal(messages.some(m => m.role === 'tool'), false);
      return reply(independent === 1 ? reconstruction(contentReviewInputs(dir)) : judgment(contentReviewInputs(dir)));
    }
    author++;
    if (author > 1) {
      assert.ok(schemas.some(s => s.function.name === 'write_scene'));
      throw new ProviderRequestError('quota');
    }
    return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ id: 'review', type: 'function', function: { name: 'review_content', arguments: JSON.stringify({ signature: contentReviewInputs(dir).signature, verdict: 'pass', reason: '作者说一定通过' }) } }] } }] };
  };
  await runAgent(dir, '只调研新进展，不把摘要当解释。', { mode: 'topic', instructionKind: 'material', providers, request, stepBudget: 3 });
  assert.equal(independent, 2);
  assert.equal(contentReviewStatus(dir).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-state.json'))).usage.requests, 2);
  const failed = fixture(t);
  await assert.rejects(() => runIndependentContentReview(failed, { providers, request: async () => { throw new ProviderRequestError('quota'); } }));
  assert.equal(contentReviewStatus(failed).ok, false);
});

test('抓取为独立核对保存完整正文，不只留给作者的截断片段；重复同文不改来源指纹，只读不存', async t => {
  const tail = '全文尾部的必要解释：工程师仍要多轮修改。';
  const server = http.createServer((_req, res) => res.end('背景资料'.repeat(7000) + tail));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}/article`;
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'topic' });
  const authorText = await tools.fetch_url.run({ url });
  assert.equal(authorText.includes(tail), false);
  const before = contentReviewInputs(dir);
  assert.ok(before.context.materials.some(m => m.text.includes(tail)));
  await tools.fetch_url.run({ url });
  assert.equal(contentReviewInputs(dir).signature, before.signature);
  const readOnly = fixture(t);
  await makeTools(readOnly, () => {}, { mode: 'topic', readOnly: true }).fetch_url.run({ url });
  assert.equal(contentReviewInputs(readOnly).context.materials.length, 0);
});

test('作者重复请求同稿返修结果不会反复调用模型收费', async t => {
  const dir = fixture(t), providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }];
  let isolated = 0;
  await runAgent(dir, '核对设备验证过程', { mode: 'topic', instructionKind: 'material', providers, stepBudget: 2,
    request: async (_p, _messages, schemas) => {
      if (!schemas.length) return reply(++isolated === 1 ? reconstruction(contentReviewInputs(dir), ['缺安全验证过程'])
        : judgment(contentReviewInputs(dir), { verdict: 'revise', issues: ['安全结论无依据'] }));
      return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'review-again', type: 'function', function: { name: 'review_content', arguments: JSON.stringify({ signature: contentReviewInputs(dir).signature }) } }] } }] };
    } });
  assert.equal(isolated, 2);
  assert.equal(contentReviewStatus(dir).state, 'revise');
});

test('真实审稿支持显式输出预算；截断不涨额，只在同额内降载，且尝试次数有界', async t => {
  const dir = fixture(t); makeSafe(dir);
  const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }];
  let calls = 0;
  await runIndependentContentReview(dir, { providers, maxOutputTokens: 24000, request: async (_p, _messages, _tools, options) => {
    assert.equal(options.maxOutputTokens, 24000);
    return reply(++calls === 1 ? reconstruction(contentReviewInputs(dir)) : judgment(contentReviewInputs(dir)));
  } });
  assert.equal(calls, 2);
  /* Old behaviour: one truncation aborted the entire review, so a 16-scene
   * script could never pass at any reasonable budget. New behaviour: the same
   * cap is kept and only the shard is split, with a hard depth limit. */
  let failed = 0;
  await assert.rejects(() => runIndependentContentReview(dir, { providers, maxOutputTokens: 6000, request: async (_p, _m, _t, options) => {
    failed++; assert.equal(options.maxOutputTokens, 6000, '额度不能被自动抬高');
    return { choices: [{ finish_reason: 'length', message: { content: null } }] };
  } }), /finish_reason=length/);
  assert.ok(failed >= 1 && failed <= 8, '降载重试必须有限次，不能无限重试：' + failed);
});

test('改稿后只复核改动场，未改的场沿用上轮结论，未改场的问题仍保留', async t => {
  const dir = fixture(t);
  makeSafe(dir);
  const first = await mocked(dir);
  assert.equal(first.ok, true);
  const input = contentReviewInputs(dir);
  // Rewrite one of two scenes: only that scene re-enters the blind pass.
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：设备\n\n## S1 · 设备\n← 依赖：无\n1. 模型生成了外壳图纸。\n2. 原型是用来测试的样品。\n3. 厂商用了一个月制作原型。\n4. 工程师接着对原型进行漏电和过热测试。\n\n## S2 · 结论\n← 依赖：S1\n1. 测试通过后才敢说这台设备可用。\n');
  const next = contentReviewInputs(dir);
  assert.notEqual(next.signature, input.signature);
  const seen = [];
  const status = await reviewContentIndependently(dir, { provider: 'fixture', model: 'fixture-model', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    seen.push(payload);
    const now = contentReviewInputs(dir);
    if (payload.phase === '仅听旁白复原') {
      assert.deepEqual(payload.narration.map(s => s.scene), [2], '只应盲听改动场');
      return reply({ scenes: payload.narration.map(s => ({ scene: s.scene, understood: '测试通过才敢说可用。', missing: [] })) });
    }
    assert.equal(payload.phaseScope.includes('S2'), true);
    return reply({ verdict: 'pass', question: '设备可用吗？', answer: '测试通过后可用。', scope: '只复核改动场。',
      scenes: payload.input.narration.map(scene => ({ scene: scene.scene, line: 1, takeaway: '本场结论。', bridge: '接上场。' })).filter(s => s.scene === 2),
      links: [], analogies: [], findings: [], issues: [],
      essentials: [{ scene: 2, lines: [1], reason: '先知道测试通过才可用。' }] });
  } });
  assert.equal(seen.length, 2);
  assert.equal(status.record.scenes.length, input.narration.length + 1, '整稿记录仍覆盖每一场');
  assert.equal(status.record.independent.scope, 'incremental');
  assert.deepEqual(status.record.independent.changedScenes, [2]);
});

test('整稿改动或没有改动退回完整复审，增量不降低门槛', async t => {
  const dir = fixture(t);
  makeSafe(dir);
  await mocked(dir);
  const hashOnly = fixture(t);
  makeSafe(hashOnly);
  await mocked(hashOnly);
  // Same narration, only a claims/plan edit: scenes do not change.
  fs.appendFileSync(path.join(hashOnly, '方案.md'), '\n补一句作者说明。\n');
  const phases = [];
  await reviewContentIndependently(hashOnly, { provider: 'fixture', model: 'fixture', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    phases.push(payload.phase);
    const now = contentReviewInputs(hashOnly);
    return reply(payload.phase === '仅听旁白复原'
      ? { scenes: now.narration.map(s => ({ scene: s.scene, understood: '模型出图并做原型。', missing: [] })) }
      : { verdict: 'pass', question: '哪一步？', answer: '出图到原型。', scope: '整稿。',
        scenes: now.narration.map(s => ({ scene: s.scene, line: 1, takeaway: '进展。', bridge: '承接。' })),
        links: [], analogies: [], findings: now.findings.map(f => ({ finding: f, reason: '已核对。' })), issues: [],
        essentials: now.narration.map(s => ({ scene: s.scene, lines: [], reason: '无额外必要解释。' })) });
  } });
  const fullProject = fixture(t);
  makeSafe(fullProject);
  const savedPhases = [];
  const full = await reviewContentIndependently(fullProject, { full: true, provider: 'fixture', model: 'fixture', chat: async messages => {
    const payload = JSON.parse(messages[1].content);
    if (payload.phase === '仅听旁白复原') savedPhases.push(...payload.narration.map(s => s.scene));
    return reply(payload.phase === '仅听旁白复原'
      ? { scenes: payload.narration.map(s => ({ scene: s.scene, understood: '整稿盲听。', missing: [] })) }
      : { verdict: 'pass', question: '哪一步？', answer: '出图到原型。', scope: '整稿。',
        scenes: payload.input.narration.map(s => ({ scene: s.scene, line: 1, takeaway: '进展。', bridge: '承接。' })),
        links: [], analogies: [], findings: (payload.input.findings || []).map(item => ({ i: item.i, reason: '已核对。' })), issues: [],
        essentials: payload.input.narration.map(s => ({ scene: s.scene, lines: [], reason: '无额外必要解释。' })) });
  } });
  // Sharded blind passes must together cover every scene, with no duplicates.
  const covered = [...new Set(savedPhases.filter(n => Number.isInteger(n)))].sort((a, b) => a - b);
  assert.deepEqual(covered, contentReviewInputs(fullProject).narration.map(s => s.scene), '--full 必须盲听全部场');
  assert.equal(full.record.independent.scope, 'full');
});

test('独立审稿以索引取真实旁白，不让改写/拼接引文误放行；越界保留候选但不放行', async t => {
  const dir = fixture(t); makeSafe(dir);
  const input = contentReviewInputs(dir);
  const indexed = judgment(input, {
    scenes: [{ scene: 1, line: 1, takeaway: '模型画出图纸。', bridge: '开场交代对象。' }],
    essentials: [{ scene: 1, lines: [2], reason: '解释原型。' }],
    links: [{ premise: { scene: 1, line: 1 }, middle: { scene: 1, line: 3 }, conclusion: { scene: 1, line: 4 } }],
  });
  const status = await mocked(dir, { edits: indexed });
  assert.equal(status.record.scenes[0].quote, input.narration[0].lines[0]);
  assert.equal(status.record.essentials[0].quotes[0], input.narration[0].lines[1]);
  const bad = fixture(t); let count = 0;
  await assert.rejects(() => reviewContentIndependently(bad, { provider: 'fixture', model: 'fixture', chat: async () => reply(++count === 1
    ? reconstruction(contentReviewInputs(bad)) : judgment(contentReviewInputs(bad), { scenes: [{ scene: 1, line: 999, takeaway: '错误索引', bridge: '错误索引' }] })) }), /索引越界/);
  assert.equal(contentReviewStatus(bad).ok, false);
  const files = fs.readdirSync(path.join(bad, 'out/.vh-content-review-attempts'));
  const candidate = JSON.parse(fs.readFileSync(path.join(bad, 'out/.vh-content-review-attempts', files[0])));
  assert.equal(candidate.kind, 'unvalidated-independent-candidate');
  assert.match(candidate.validationError, /索引越界/);
  const revision = fixture(t);
  const missingLink = { premise: { scene: 1, line: 1 }, middle: { missing: '图纸到安全验证之间缺步骤。' }, conclusion: { scene: 1, line: 4 } };
  const revised = await mocked(revision, { edits: { verdict: 'revise', issues: ['缺安全验证过程'], links: [structuredClone(missingLink)] } });
  assert.equal(revised.state, 'revise');
  assert.equal(revised.record.links[0].middle, '图纸到安全验证之间缺步骤。');
  const typedMissing = fixture(t);
  const typedResult = await mocked(typedMissing, { edits: { verdict: 'revise', issues: ['缺验证过程'], links: [{ ...structuredClone(missingLink), middle: { scene: 1, line: '缺失：没有验证过程' } }] } });
  assert.equal(typedResult.state, 'revise');
  assert.equal(typedResult.record.links[0].middle, '缺失：没有验证过程');
  const cannotPass = fixture(t);
  await assert.rejects(() => mocked(cannotPass, { edits: { links: [structuredClone(missingLink)] } }), /索引越界/);
  assert.equal(contentReviewStatus(cannotPass).ok, false, '缺失说明不是旁白引文，绝不能用于pass');
});
