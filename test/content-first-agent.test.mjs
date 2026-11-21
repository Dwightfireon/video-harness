import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { pendingSceneWork, SCENE_CAPABILITIES } from '../lib/scene-work.mjs';
import { nextAgentStep, currentAgentMessages, agentWorkflowPrompt, runAgent, makeTools } from '../lib/agent.mjs';
import { readCheckpoint, writeCheckpoint } from '../lib/checkpoint.mjs';
import { saveState } from '../lib/state.mjs';
import { currentArtifactInputs, createArtifactRecord } from '../lib/artifact-status.mjs';
import { productionQuality, productionQualityStatus } from '../lib/production-quality.mjs';
import { exportSubtitles } from '../lib/subtitle-export.mjs';
import { confirmPublishRevision, publishRevision } from '../lib/publish.mjs';

const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
function fixture(t, metadata = {}, authors = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-content-first-agent-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ deliveryTarget: 'video', ...metadata }));
  if (authors) {
    fs.writeFileSync(path.join(dir, '方案.md'), '方案：沿原文解释过程，出处 research/原文.md 第一段。');
    fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 过程\n1. 展示一个真实过程。\n');
  }
  return dir;
}

test('default and explicit content-first skip absent or partial claims, preserving source inputs', async t => {
  for (const metadata of [{}, { workflow: { profile: 'content-first' } }]) {
    const dir = fixture(t, metadata), original = fs.readFileSync(path.join(dir, '方案.md'));
    for (const claims of [null, '[{"id":"C1"', '[]']) {
      if (claims !== null) fs.writeFileSync(path.join(dir, 'claims.json'), claims);
      const work = await nextPipelineWork(dir, 'article');
      assert.equal(work.stage, 'draft_scenes');
      assert.equal(pendingSceneWork(dir, 'article').scene, 1);
      assert.doesNotMatch(nextAgentStep(dir, 'article'), /补齐.*claims\.json/);
    }
    assert.deepEqual(fs.readFileSync(path.join(dir, '方案.md')), original);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROJECT.json'))).contentReview, undefined);
  }
});

test('audited and historical required review keep claims readiness before scenes', async t => {
  for (const metadata of [{ workflow: { profile: 'audited' } },
    { contentReview: { required: true, version: 1 } },
    { workflow: { profile: 'content-first' }, contentReview: { required: true, version: 3 } }]) {
    const dir = fixture(t, metadata);
    for (const claims of [null, '[{"id":"C1"']) {
      if (claims !== null) fs.writeFileSync(path.join(dir, 'claims.json'), claims);
      const work = await nextPipelineWork(dir, 'topic');
      assert.equal(work.stage, 'draft_claims');
      assert.equal(pendingSceneWork(dir, 'topic'), null);
      assert.match(nextAgentStep(dir, 'topic'), /claims\.json/);
      assert.match(work.note, /不标 verified/);
    }
    fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
    assert.equal((await nextPipelineWork(dir, 'topic')).stage,
      metadata.contentReview?.required ? 'review_content' : 'draft_scenes');
    assert.match(agentWorkflowPrompt(dir), /claims\.json 仍是必需关口/);
  }
});

test('default authoring retains primary-source provenance without a verification-table detour', async t => {
  const dir = fixture(t, {}, false);
  const work = await nextPipelineWork(dir, 'article');
  assert.equal(work.stage, 'draft_plan');
  assert.match(work.note, /research\/原文\.md/);
  assert.match(work.note, /关键出处在方案\/脚本/);
  assert.match(work.note, /不编造 verified/);
  assert.match(agentWorkflowPrompt(dir), /不要求独立 claims\.json/);
});

test('current system projection overrides old workflow instructions without changing historical bytes', t => {
  const dir = fixture(t);
  const history = [{ role: 'system', content: '旧提示：必须写 claims.json，再 render --all。' },
    { role: 'user', content: '保留我的原文要求。' },
    { role: 'assistant', content: '历史判断' }];
  const before = JSON.stringify(history);
  const current = currentAgentMessages(dir, history);
  assert.equal(JSON.stringify(history), before);
  assert.equal(current[1], history[1]);
  assert.match(current[0].content, /当前政策优先于历史制作提示/);
  assert.ok(current[0].content.endsWith(agentWorkflowPrompt(dir)));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  assert.match(currentAgentMessages(dir, history)[0].content, /当前工作流 v1：audited/);
  assert.equal(JSON.stringify(history), before);
});

test('resumed read-only discussion can finish without production files, using current policy in system and tail', async t => {
  const dir = fixture(t, {}, false), taskId = 'resumed-policy';
  const history = [{ role: 'system', content: '旧系统：必须 claims.json；render --all。' },
    { role: 'user', content: '先讨论，不修改任何文件。' }];
  writeCheckpoint(dir, { schemaVersion: 1, taskId, mode: 'article', status: 'paused', messages: history,
    pending: [], mutationDeferred: true, task: '先讨论，不修改任何文件。' });
  let calls = 0;
  const result = await runAgent(dir, '先讨论，不修改任何文件。', { providers, mode: 'article', taskId,
    resume: true, stepBudget: 3, request: async (_provider, messages, schemas) => {
      calls++;
      assert.ok(messages[0].content.endsWith(agentWorkflowPrompt(dir)));
      assert.match(messages.at(-1).content, /当前工作流 v1：content-first/);
      assert.match(messages.at(-1).content, /本轮只读/);
      assert.doesNotMatch(messages.at(-1).content, /render --all|--force/);
      assert.ok(!schemas.some(schema => ['write_file', 'run_stage'].includes(schema.function.name)));
      return reply('可以先讨论；尚未制作、试听或审片。');
    } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, '可以先讨论；尚未制作、试听或审片。');
  assert.deepEqual(readCheckpoint(dir, taskId).messages.slice(0, 2), history);
  for (const file of ['方案.md', '脚本.md', 'claims.json', 'scenes.src.js'])
    assert.equal(fs.existsSync(path.join(dir, file)), false);
});

test('default prompts and technical scene API do not nudge full rerenders or fixed creative quotas', async t => {
  const dir = fixture(t, {}, false);
  const result = await runAgent(dir, '先讨论，不要写入。', { providers, mode: 'topic', taskId: 'fresh-policy',
    instruction: '先讨论，不要写入。', stepBudget: 2, request: async (_provider, messages) => {
      assert.match(messages[0].content, /当前工作流 v1：content-first/);
      assert.doesNotMatch(messages[0].content, /render --all|--force|至少一半|必须.*两版/);
      return reply('先讨论内容。');
    } });
  assert.equal(result.status, 'completed');
  assert.match(SCENE_CAPABILITIES, /VH_FILM\.sceneCue/);
  assert.match(SCENE_CAPABILITIES, /VH_LAYOUT\.flow/);
  assert.match(SCENE_CAPABILITIES, /用户范围|须服从用户/);
  assert.match(SCENE_CAPABILITIES, /倒播/);
  const tools = makeTools(dir, () => {}, { mode: 'edit', readOnly: true });
  assert.match(await tools.write_file.run({ path: '脚本.md', content: 'x' }), /拒绝/);
  assert.match(await tools.run_stage.run({ stage: 'render' }), /拒绝/);
});

test('read-only completion commit can recover without producing a film, but missing visual-review input cannot pass', async t => {
  const dir = fixture(t, {}, false), taskId = 'read-only-finalizing';
  writeCheckpoint(dir, { schemaVersion: 1, taskId, mode: 'article', status: 'finalizing',
    messages: [{ role: 'user', content: '先讨论。' }], pending: [], mutationDeferred: true, answer: '先讨论内容。' });
  const result = await runAgent(dir, '先讨论。', { providers, mode: 'article', taskId, resume: true,
    request: async () => { throw new Error('completed discussion must not request a model'); } });
  assert.equal(result.status, 'completed');
  assert.equal(result.answer, '先讨论内容。');
  const review = await runAgent(dir, '检查一下画面', { providers, mode: 'article', taskId: 'missing-review',
    instruction: '检查一下画面', stepBudget: 2,
    request: async () => { throw new Error('missing review input must not be claimed inspected'); } });
  assert.equal(review.status, 'paused');
  assert.match(review.paused, /scene\.html 缺失/);
  assert.equal(fs.existsSync(path.join(dir, 'scene.html')), false);
});

test('automated final check explicitly binds both production-quality calls to workflow quality profile', () => {
  const source = fs.readFileSync(new URL('../lib/agent.mjs', import.meta.url), 'utf8');
  assert.match(source, /const profile = workflowPolicy\(project\)\.qualityProfile/);
  assert.match(source, /productionQualityStatus\(project, \{ profile \}\)/);
  assert.match(source, /productionQuality\(project, \{ phase: 'final', profile, reuseRendered: true \}\)/);
  assert.doesNotMatch(source, /严格机器质量关口已通过|render --all|--force/);
});

test('automatic success reuses technical receipt and returns actual video, script and requested publish paths', async t => {
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const deliveryTarget of ['video', 'publish-package']) {
    const dir = fixture(t, { deliveryTarget }), file = name => path.join(dir, name);
    fs.mkdirSync(file('out'));
    const subs = [{ s: .1, e: .9, t: '一句话。' }];
    for (const [name, content] of Object.entries({
      '脚本.md': '## S1 · 测试\n1. 一句话。\n',
      'scenes.src.js': 'root => ({render(t){}})',
      'engine.tpl.html': "const ORIENT = 'landscape';",
      'timeline.mjs': 'export const scriptGroups = () => [["一句话。"]]; export const validateTiming = data => ({subs:data.subs,total:data.dur});',
      'scene.html': `<script>const ORIENT='landscape'; const DURATION=1; const SUBS=${JSON.stringify(subs)};
        const scenes=[]; function addScene(a,b,f){scenes.push([a,b,f]);} addScene(0,1,root=>({render(t){}}));</script>`,
      'timing.json': JSON.stringify({ schemaVersion: 1, textHash: digest(['一句话。']), groupsHash: digest([['一句话。']]),
        measurement: { voice: 'test', speed: 1 }, scenes: [[0, 1]], dur: 1, subs }),
    })) fs.writeFileSync(file(name), content);
    if (deliveryTarget === 'publish-package') {
      fs.writeFileSync(file('发布文案.md'), '## 标题\n一个过程\n## 简介\n解释一个过程。\n## 标签\n过程\n## 置顶评论\n欢迎讨论。\n## 封面文案\n主：一个过程\n');
      const pub = publishRevision(dir);
      confirmPublishRevision(dir, { sourceSignature: pub.sourceSignature, publishHash: pub.publishHash });
    }
    for (const target of ['out/video.mp4', 'out/video-voice.mp4']) {
      const media = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=10:d=1',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:d=1', '-shortest', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file(target)], { encoding: 'utf8', timeout: 15000 });
      assert.equal(media.status, 0, media.stderr);
    }
    exportSubtitles(dir);
    const inputs = currentArtifactInputs(dir);
    saveState(dir, { lastMeasure: { scriptHash: inputs.sourceHashes['脚本.md'] },
      genStamp: { scriptHash: inputs.sourceHashes['脚本.md'], scenesHash: inputs.sourceHashes['scenes.src.js'], sourceHashes: inputs.sourceHashes },
      render: { artifact: createArtifactRecord(dir, 'render') }, voice: { artifact: createArtifactRecord(dir, 'voice') } });
    // Trusted subtitle test seam only: media identity, decode, audio and all
    // structural/source checks run normally against the real synthetic files.
    const quality = await productionQuality(dir, { profile: 'technical', checkers: {
      subtitles: () => ({ ok: true, cues: 1, probes: 3, errors: [], failures: [] }),
    } });
    assert.equal(quality.ok, true, JSON.stringify(quality));
    assert.equal(productionQualityStatus(dir, { profile: 'technical' }).ok, true);
    assert.equal(productionQualityStatus(dir, { profile: 'strict' }).ok, false);
    const receipt = fs.readFileSync(file('out/.vh-production-quality.json'));
    const result = await runAgent(dir, '继续制作', { providers, mode: 'article', automation: true, taskId: 'success-paths',
      stepBudget: 3, request: async () => { throw new Error('valid final receipt must not need a model or fresh visual audit'); } });
    assert.equal(result.status, 'completed', result.paused || result.error);
    assert.ok(result.answer.includes(file('out/video-voice.mp4')));
    assert.ok(result.answer.includes(file('脚本.md')));
    assert.equal(result.answer.includes(file('发布文案.md')), deliveryTarget === 'publish-package');
    assert.match(result.answer, /未验证.*试听.*人工审片.*事实语义/);
    assert.doesNotMatch(result.answer, /严格.*通过/);
    assert.deepEqual(fs.readFileSync(file('out/.vh-production-quality.json')), receipt, 'reuse without rewriting quality evidence');
    assert.equal(fs.existsSync(file('claims.json')), false);
  }
});
