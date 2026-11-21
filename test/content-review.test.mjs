import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { requireContentReview, contentReviewInputs, contentReviewStatus, recordContentReview, assertContentReviewed } from '../lib/content-review.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { stageContract, STAGE_TOOLS } from '../lib/pipeline-contract.mjs';
import { makeTools, toolSchema, runAgent } from '../lib/agent.mjs';
import { ProviderRequestError } from '../lib/provider-pool.mjs';
import { pipelinePlan } from '../lib/pipeline-plan.mjs';
import { finishAuthorDraft } from '../lib/author-readiness.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { createPublicPackage } from '../lib/public-package.mjs';

const root = path.resolve(import.meta.dirname, '..');
function fixture(t, required = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-content-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '方案.md'), '已经知道：自行车\n\n不知道：重心\n');
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：自行车\n\n## S1 · 起步\n1. 自行车为什么会倒？\n2. 车向左倒时，轮子要向左转。\n← 依赖：无\n\n## S2 · 接住\n1. 轮子移到身体下方，重新托住身体。\n2. 这样，人和车就不再继续向左倒。\n← 依赖：S1\n');
  // These fixtures exercise the retained v2 declaration contract. New-project
  // isolated review regressions live in content-review-independent.test.mjs.
  if (required) fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ contentReview: { required: true, version: 2 } }));
  return dir;
}
function review(dir, edits = {}) {
  const input = contentReviewInputs(dir);
  return { signature: input.signature, verdict: 'pass', question: '骑车怎样保持不倒？', answer: '转动车把，让轮子接住身体。',
    scope: '核对倒向与转向的关系；没有跨领域类比。', issues: [],
    scenes: input.narration.map(scene => ({ scene: scene.scene, quote: scene.lines[0], takeaway: '车轮要移到人下方。', bridge: scene.scene === 1 ? '交代自行车为什么倒。' : '接上倒车时转动车把后的变化。' })),
    links: [{ premise: '车向左倒时，轮子要向左转。', middle: '轮子移到身体下方，重新托住身体。', conclusion: '这样，人和车就不再继续向左倒。' }], analogies: [],
    findings: input.findings.map(finding => ({ finding, reason: '已对照旁白，具体动作在转动车把和托住身体两句交代。' })), ...edits };
}

test('显式启用审稿的历史契约仍保留：未审不能正式制作或强制打包', async t => {
  const dir = fixture(t);
  const work = await nextPipelineWork(dir, 'article');
  assert.equal(work.stage, 'review_content');
  assert.deepEqual(work.allowed, STAGE_TOOLS.review_content);
  assert.match(work.note, /不预设两个领域是同一结构/);
  assert.equal(pipelinePlan(dir).ok, false);
  assert.match(pipelinePlan(dir).blockers[0], /内容审稿/);
  for (const cmd of ['measure', 'render', 'voice', 'go']) {
    const run = spawnSync(process.execPath, ['vh.mjs', cmd, '--dir', dir], { cwd: root, encoding: 'utf8' });
    assert.notEqual(run.status, 0, cmd);
    assert.match(run.stderr, /内容审稿未通过/, cmd);
  }
  assert.throws(() => createPublicPackage(dir, path.join(dir, 'dist'), { force: true }), /内容审稿/);
  assert.equal(fs.existsSync(path.join(dir, 'scene.html')), false);
});

test('逐场和实际中间句通过后才能进入分镜；修改任一内容输入则失效，改视觉不失效', async t => {
  const dir = fixture(t);
  const status = recordContentReview(dir, review(dir));
  assert.equal(status.ok, true);
  assert.match(status.record.limitation, /不证明语义正确/);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_scenes');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), '// 改版式');
  assert.equal(contentReviewStatus(dir).ok, true);
  for (const file of ['方案.md', '脚本.md', 'claims.json']) {
    const before = fs.readFileSync(path.join(dir, file), 'utf8');
    fs.appendFileSync(path.join(dir, file), '\n');
    assert.equal(contentReviewStatus(dir).state, 'stale', file);
    assert.throws(() => assertContentReviewed(dir), /须重审/);
    fs.writeFileSync(path.join(dir, file), before);
  }
  assert.equal(contentReviewStatus(dir).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'review.json')), false, '不登记人工发布审阅');
});

test('标题/术语表和审稿人补写不能冒充旁白中间步骤；遗漏场次和陈旧签名也不通过', t => {
  const dir = fixture(t), good = review(dir);
  for (const middle of ['接住', '## S2 · 接住', '转向让接触点移到重心下方，这是我在审稿时补的']) {
    assert.throws(() => recordContentReview(dir, { ...good, links: [{ ...good.links[0], middle }] }), /编号旁白/);
  }
  assert.throws(() => recordContentReview(dir, { ...good, scenes: good.scenes.slice(0, 1) }), /所有场/);
  assert.throws(() => recordContentReview(dir, { ...good, signature: '0'.repeat(64) }), /过期/);
  assert.throws(() => recordContentReview(dir, { ...good, issues: ['缺推导'] }), /尚有内容问题/);
  assert.throws(() => recordContentReview(dir, { ...good, verdict: 'revise' }), /具体断点/);
});

test('新审稿契约要求每个关键选型结论都登记为旁白链条', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：自行车\n\n## S1 · 起步\n1. 车向左倒时，轮子要向左转。\n2. 转向会让轮子移到身体下方。\n3. 所以你应该优先选这个方案。\n← 依赖：无\n');
  const input = contentReviewInputs(dir);
  assert.equal(input.keyClaims.length, 1);
  const bad = review(dir, { scenes: input.narration.map(scene => ({ scene: scene.scene, quote: scene.lines[0], takeaway: '给出方向。', bridge: '开场提出问题。' })), links: [] });
  assert.throws(() => recordContentReview(dir, bad), /关键结论.*links/);
  const good = { ...bad, links: [{ premise: '车向左倒时，轮子要向左转。', middle: '转向会让轮子移到身体下方。', conclusion: '所以你应该优先选这个方案。' }] };
  assert.equal(recordContentReview(dir, good).ok, true);
});

test('机器待核必须逐条处理，不能省略；损坏pass回执不能放行', t => {
  const dir = fixture(t);
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n## S3 · 后果\n1. 因为身体倾斜，所以人就会摔倒在地上。\n← 依赖：S2\n');
  const good = review(dir);
  assert.ok(good.findings.length > 0);
  assert.throws(() => recordContentReview(dir, { ...good, findings: [] }), /逐项/);
  recordContentReview(dir, good);
  const file = path.join(dir, 'out/.vh-content-review.json');
  const data = JSON.parse(fs.readFileSync(file));
  delete data.scenes;
  fs.writeFileSync(file, JSON.stringify(data));
  assert.equal(contentReviewStatus(dir).state, 'invalid');
});

test('revise是有效提交但仍留在审稿阶段，不能为赶进度强制pass', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article' });
  const result = JSON.parse(await tools.review_content.run(review(dir, { verdict: 'revise', issues: ['缺少车轮何以接住人的解释'] })));
  assert.equal(result.ok, true);
  assert.equal(result.review.state, 'revise');
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'review_content');
  const schemas = toolSchema(tools);
  const contract = stageContract(await nextPipelineWork(dir, 'article'), { schemas, project: dir });
  const call = (name, args) => ({ function: { name, arguments: JSON.stringify(args) } });
  assert.match(contract.validate(call('run_stage', { stage: 'render' })), /不允许/);
  assert.match(contract.validate(call('patch_text', { path: 'scenes.src.js' })), /不能先改画面/);
  assert.match(await makeTools(dir, () => {}, { mode: 'article', readOnly: true }).review_content.run(review(dir)), /拒绝/);
  assert.equal(schemas.find(s => s.function.name === 'review_content').function.parameters.properties.scenes.type, 'array');
});

test('旧项目提交新脚本不自动加审稿门槛或恢复视频', t => {
  const dir = fixture(t, false);
  assert.equal(contentReviewStatus(dir).state, 'legacy-unreviewed');
  assert.equal(assertContentReviewed(dir).required, false);
  finishAuthorDraft(dir, '脚本.md', readEditFile(dir, '脚本.md').base_hash);
  assert.equal(contentReviewStatus(dir).required, false);
  assert.doesNotThrow(() => assertContentReviewed(dir));
});

test('内容审稿拒绝符号链接输入、回执及目录，不向外部写入', t => {
  const dir = fixture(t), outside = fixture(t, false);
  const original = fs.readFileSync(path.join(outside, '脚本.md'));
  fs.unlinkSync(path.join(dir, '脚本.md'));
  fs.symlinkSync(path.join(outside, '脚本.md'), path.join(dir, '脚本.md'));
  assert.equal(contentReviewStatus(dir).state, 'pending');
  assert.throws(() => contentReviewInputs(dir), /符号链接/);
  assert.deepEqual(fs.readFileSync(path.join(outside, '脚本.md')), original);
  fs.unlinkSync(path.join(dir, '脚本.md'));
  fs.writeFileSync(path.join(dir, '脚本.md'), original);
  fs.symlinkSync(outside, path.join(dir, 'out'));
  assert.throws(() => recordContentReview(dir, review(dir)), /符号链接/);
});

test('真实Agent执行契约：拦住抢写分镜→登记旁白审稿→进入分镜；恢复时改稿先重审', async t => {
  const dir = fixture(t), requested = [];
  const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
  const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  const reply = (...calls) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: calls } }] });
  await runAgent(dir, '制作这份已写好的材料', { mode: 'article', instructionKind: 'material', taskId: 'content-before-scenes', providers, stepBudget: 4,
    request: async (_provider, _messages, schemas) => {
      const names = schemas.map(s => s.function.name); requested.push(names);
      if (requested.length === 1) return reply(call('bad-mixed', 'write_scene', { scene: 1, layout: '正文', content: 'root => ({render(){}})' }), call('must-not-run', 'review_content', review(dir)));
      if (requested.length === 2) {
        assert.equal(contentReviewStatus(dir).ok, false, '违规混合批次不得执行其中的审稿');
        return reply(call('review-current', 'review_content', review(dir)));
      }
      assert.ok(names.includes('write_scene'));
      assert.equal(contentReviewStatus(dir).ok, true);
      throw new ProviderRequestError('quota');
    } });
  assert.equal(requested.length, 3);
  assert.ok(requested[0].includes('review_content'));
  assert.equal(requested[0].includes('write_scene'), false);
  assert.equal(fs.existsSync(path.join(dir, 'scenes.src.js')), false);
  fs.appendFileSync(path.join(dir, '脚本.md'), '\n');
  let resumed = 0;
  await runAgent(dir, '', { resume: true, mode: 'article', taskId: 'content-before-scenes', providers, stepBudget: 1,
    request: async (_provider, _messages, schemas) => {
      resumed++;
      assert.ok(schemas.some(s => s.function.name === 'review_content'));
      assert.equal(schemas.some(s => s.function.name === 'write_scene'), false);
      return reply(call('revise-current', 'review_content', review(dir, { verdict: 'revise', issues: ['须核对重心变化，不用审稿解释补旁白'] })));
    } });
  assert.equal(resumed, 1);
  assert.equal(contentReviewStatus(dir).state, 'revise');
  assert.equal(fs.existsSync(path.join(dir, 'review.json')), false);
});

test('事故反例：拼线索不自动等于默会知识，审稿补写的关联不能冒充已经讲出的中间句', t => {
  const dir = fixture(t);
  fs.writeFileSync(path.join(dir, '脚本.md'), '**主体**：克苏鲁与默会知识\n\n## S1 · 你刚才也做了\n1. 这时，再来谈默会知识，才有一个具体的入口。\n2. 可形象、咒语、日期合到一起，每张纸的意思都变了。\n3. 你开始从这些细节，看见同一个故事。\n4. 这不证明两件事相等，但可以借一个概念来理解。\n← 依赖：无\n\n## S2 · 那个动作有名字\n1. 我们知道的，可以比能说出来的更多。\n2. 他把这类东西叫默会知识。\n3. 你靠着对细节的觉察，去注意整体。\n← 依赖：S1\n');
  const input = review(dir), missing = '核对线索并没有展示哪种判断难以充分说出，无法从拼合记录推出默会知识。';
  input.links = [{ premise: '你开始从这些细节，看见同一个故事。', middle: missing, conclusion: '我们知道的，可以比能说出来的更多。' }];
  assert.throws(() => recordContentReview(dir, input), /中间推导.*编号旁白/);
  assert.equal(contentReviewStatus(dir).ok, false);
  const revised = recordContentReview(dir, { ...input, verdict: 'revise', issues: [missing] });
  assert.equal(revised.state, 'revise');
  assert.match(revised.reason, /无法从拼合记录推出/);
});
