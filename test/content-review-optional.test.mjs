import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initializeContentReview, contentReviewStatus, contentReviewInputs,
  assertContentReviewed, reviewContentIndependently } from '../lib/content-review.mjs';
import { finishAuthorDraft } from '../lib/author-readiness.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { pipelinePlan } from '../lib/pipeline-plan.mjs';
import { makeTools, runAgent } from '../lib/agent.mjs';
import { writeCheckpoint } from '../lib/checkpoint.mjs';
import { ProviderRequestError } from '../lib/provider-pool.mjs';
import { skillDir } from '../lib/state.mjs';
import { createPublicPackage } from '../lib/public-package.mjs';

const root = path.resolve(import.meta.dirname, '..');
function fixture(t, meta = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-optional-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = { 'PROJECT.json': JSON.stringify(meta), '方案.md': '已经知道：自行车\n不知道：转向\n',
    '脚本.md': '**主体**：自行车\n\n## S1 · 转向\n← 依赖：无\n1. 自行车向左倾斜。\n2. 轮子向左转到身体下面。\n', 'claims.json': '[]' };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
const meta = dir => JSON.parse(fs.readFileSync(path.join(dir, 'PROJECT.json'), 'utf8'));

test('真实 new CLI 默认关闭模型审稿，重复 new 不重开用户关闭标记', { skip: !skillDir() }, t => {
  const dir = path.join(fixture(t), 'new-project');
  for (let i = 0; i < 2; i++) {
    const result = spawnSync(process.execPath, ['vh.mjs', 'new', dir], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(meta(dir).contentReview, { required: false, version: 3 });
    assert.equal(fs.existsSync(path.join(dir, 'out/.vh-content-review-in-progress.json')), false);
  }
});

test('初始化、提交和改稿后再提交都不启用审稿；明确历史契约不静默覆盖', async t => {
  for (const prior of [undefined, { required: false, version: 3 }, { required: false, version: 2 }]) {
    const dir = fixture(t, prior ? { contentReview: prior } : {});
    initializeContentReview(dir);
    for (let i = 0; i < 2; i++) {
      fs.appendFileSync(path.join(dir, '脚本.md'), '\n');
      finishAuthorDraft(dir, '脚本.md', readEditFile(dir, '脚本.md').base_hash);
      assert.equal(contentReviewStatus(dir).required, false);
      assert.doesNotThrow(() => assertContentReviewed(dir));
      assert.equal((await nextPipelineWork(dir, 'topic')).stage, 'draft_scenes');
      assert.equal(pipelinePlan(dir).steps.some(s => s.id === 'content-review'), false);
      assert.equal(pipelinePlan(dir).blockers.some(s => s.includes('内容审稿')), false);
    }
    if (prior) assert.deepEqual(meta(dir).contentReview, prior);
  }
  const explicit = fixture(t, { contentReview: { required: true, version: 2 } });
  initializeContentReview(explicit);
  assert.equal(contentReviewStatus(explicit).required, true);
  assert.equal((await nextPipelineWork(explicit, 'article')).stage, 'review_content');
});

test('旧审稿回执不能把已关闭的审稿重新变成门槛，即使回执损坏或已过期', async t => {
  const dir = fixture(t, { contentReview: { required: false, version: 3 } });
  fs.mkdirSync(path.join(dir, 'out'));
  for (const record of ['{broken', JSON.stringify({ version: 3, verdict: 'pass', signature: 'old' }),
    JSON.stringify({ version: 2, verdict: 'revise', issues: ['旧问题'] })]) {
    fs.writeFileSync(path.join(dir, 'out/.vh-content-review.json'), record);
    assert.equal(contentReviewStatus(dir).required, false);
    assert.equal(contentReviewStatus(dir).ok, false, '不伪造可选审稿通过');
    assert.doesNotThrow(() => assertContentReviewed(dir));
    assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_scenes');
    assert.equal(pipelinePlan(dir).blockers.some(s => s.includes('内容审稿')), false);
  }
});

test('正式 measure/render/voice/go/pack 不再卡可选审稿，但缺少时间轴和媒体仍被技术检查拦住', t => {
  const dir = fixture(t, { contentReview: { required: false, version: 3 } });
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out/.vh-content-review.json'), '{broken');
  for (const command of ['measure', 'render', 'voice', 'go']) {
    const result = spawnSync(process.execPath, ['vh.mjs', command, '--dir', dir], { cwd: root, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(result.status, 0, command + ' 应拦住尚未制作的媒体');
    assert.doesNotMatch(result.stderr + result.stdout, /内容审稿未通过/, command);
    assert.equal(result.signal, null, command + ' 不应启动模型或等待 TTS');
  }
  assert.throws(() => createPublicPackage(dir, path.join(dir, 'dist'), { draft: true }), error => {
    assert.doesNotMatch(error.message, /内容审稿未通过/);
    assert.match(error.message, /配音|测量|时间轴|媒体|视频/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(dir, 'out/video-voice.mp4')), false);
});

test('主动运行可选审稿也不永久启用门槛；返修原样保存，不冒充 pass', async t => {
  const dir = fixture(t);
  let requests = 0;
  const status = await reviewContentIndependently(dir, { provider: 'fixture', model: 'fixture', chat: async () => {
    const input = contentReviewInputs(dir);
    const result = ++requests === 1
      ? { scenes: input.narration.map(s => ({ scene: s.scene, understood: '车倾斜后转向。', missing: [] })) }
      : { verdict: 'revise', question: '车如何转向？', answer: '还需解释结果。', scope: '简单过程，无跨领域类比。',
        scenes: input.narration.map(s => ({ scene: s.scene, line: 1, takeaway: '车向左倾斜。', bridge: '交代自行车。' })),
        links: [], analogies: [], findings: input.findings.map((_, i) => ({ i: i + 1, reason: '保留待核意见。' })),
        issues: ['可补充转向之后的结果。'], essentials: input.narration.map(s => ({ scene: s.scene, lines: [1], reason: '交代对象。' })) };
    return { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] };
  } });
  assert.equal(requests, 2);
  assert.equal(status.state, 'revise');
  assert.equal(status.required, false);
  assert.equal(meta(dir).contentReview.required, false);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_scenes');
});

test('默认制作工具不调用付费审稿；旧检查点续跑不会回到 review_content', async t => {
  const dir = fixture(t, { contentReview: { required: false, version: 3 } });
  let reviewRequests = 0;
  const tools = makeTools(dir, () => {}, { mode: 'article', reviewContent: async () => { reviewRequests++; } });
  assert.match(await tools.review_content.run({ signature: 'unused' }), /未要求模型内容审稿/);
  assert.equal(reviewRequests, 0);
  const taskId = 'resume-disabled-review';
  writeCheckpoint(dir, { schemaVersion: 1, taskId, task: '继续制作', mode: 'article', status: 'paused', pending: [],
    messages: [{ role: 'system', content: '旧提示：先审稿。' }, { role: 'user', content: '继续制作' }],
    pipelineState: { stage: 'review_content' }, changeContracts: [] });
  let requests = 0;
  await runAgent(dir, '', { resume: true, mode: 'article', taskId, stepBudget: 1,
    providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }],
    request: async (_provider, _messages, schemas) => {
      requests++;
      const names = schemas.map(s => s.function.name);
      assert.equal(names.includes('review_content'), false);
      assert.ok(names.includes('write_scene'));
      throw new ProviderRequestError('quota');
    } });
  assert.equal(requests, 1);
  assert.equal(meta(dir).contentReview.required, false);
});
