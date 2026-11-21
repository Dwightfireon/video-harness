import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { authorDocumentState, plannedScenes, sceneAuthoringState } from '../lib/author-readiness.mjs';
import { makeTools, runAgent } from '../lib/agent.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { pendingSceneWork } from '../lib/scene-work.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { writeCheckpoint, readCheckpoint } from '../lib/checkpoint.mjs';
import { skillDir } from '../lib/state.mjs';
import { productionFailure, productionRepairSignature, reconsiderProductionStop } from '../lib/automation.mjs';
import { currentArtifactInputs, hashFile } from '../lib/artifact-status.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const line = n => (n === 1 ? '**主体**：测试窗口\n\n' : '') + `## S${n} · 场景${n}\n1. 测试窗口展示本场具体内容。\n← 依赖：${n === 1 ? '无' : 'S' + (n - 1)}\n`;
const scene = n => `// @layout 测试${n}\nroot => { const el = mk('div','','真实内容${n}'); root.appendChild(el); return { render(t) {} }; }`;
const plan = n => '# 方案\n\n| 场 | 内容 |\n|---|---|\n' + Array.from({ length: n }, (_, i) => `| S${i + 1} | 展示对象 |\n`).join('');
function fixture(t, count = 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-author-ready-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, content] of Object.entries({ 'PROJECT.json': '{}', '方案.md': plan(count), '脚本.md': line(1),
    'claims.json': '[]', 'scenes.src.js': scene(1) })) fs.writeFileSync(path.join(dir, file), content);
  return dir;
}

test('真实回归：八场方案只有三场脚本，数量碰巧匹配三块画面也不能 build', async t => {
  const dir = fixture(t, 8);
  fs.writeFileSync(path.join(dir, '脚本.md'), [1, 2, 3].map(line).join('\n'));
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), [1, 2, 3].map(scene).join('\n//---\n'));
  const work = await nextPipelineWork(dir, 'article');
  assert.equal(work.stage, 'draft_script');
  assert.match(work.note, /尚缺 S4、S5、S6、S7、S8/);
  assert.match(work.note, /保留已写内容/);
  assert.match(work.note, /finish_draft/);
  assert.equal(pendingSceneWork(dir, 'article'), null);
  assert.match(await makeTools(dir, () => {}, { mode: 'article' }).run_stage.run({ stage: 'render' }), /拒绝：作者输入尚未完成/);
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-tool-logs')), false, '拒绝前不启动制作工具');
});

test('分批方案与脚本明确提交后才能离开阶段，重建 tools 仍保留草稿状态', async t => {
  const dir = fixture(t, 2);
  fs.unlinkSync(path.join(dir, '方案.md')); fs.unlinkSync(path.join(dir, '脚本.md'));
  let tools = makeTools(dir, () => {}, { mode: 'article' });
  const first = JSON.parse(await tools.append_file.run({ path: '方案.md', content: '# 方案\n' }));
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_plan');
  assert.equal(authorDocumentState(dir, '方案.md').state, 'writing');
  tools = makeTools(dir, () => {}, { mode: 'article' });
  const second = JSON.parse(await tools.append_file.run({ path: '方案.md', base_hash: first.base_hash, content: plan(2) }));
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_plan');
  assert.match(await tools.finish_draft.run({ path: '方案.md', base_hash: first.base_hash }), /核验失败.*过期/);
  assert.equal(JSON.parse(await tools.finish_draft.run({ path: '方案.md', base_hash: second.base_hash })).ok, true);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_script');
  const s1 = JSON.parse(await tools.append_file.run({ path: '脚本.md', content: line(1) }));
  assert.match(await tools.finish_draft.run({ path: '脚本.md', base_hash: s1.base_hash }), /核验失败.*尚缺 S2/);
  const s2 = JSON.parse(await tools.append_file.run({ path: '脚本.md', base_hash: s1.base_hash, content: '\n' + line(2) }));
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_script');
  assert.equal(pendingSceneWork(dir, 'article'), null);
  assert.equal(JSON.parse(await tools.finish_draft.run({ path: '脚本.md', base_hash: s2.base_hash })).ok, true);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_scenes', '完整性提交后直接进入分镜，不自动启用模型审稿');
  assert.equal(pendingSceneWork(dir, 'article').scene, 1);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), line(1) + '\n' + line(2));
});

test('write_file 新建也需提交；失败写入、空场、跳号不能冒充整稿', async t => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, '脚本.md'));
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  assert.match(await tools.write_file.run({ path: '脚本.md', content: line(1) }), /base_hash=/);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_script');
  for (const text of [line(1) + '\n## S2 · 空场\n', line(1) + '\n' + line(3), '## S1 · 空场\n']) {
    fs.writeFileSync(path.join(dir, '脚本.md'), text);
    assert.match(await tools.finish_draft.run({ path: '脚本.md', base_hash: hash(text) }), /核验失败.*空场或半截场/);
  }
  assert.match(await tools.finish_draft.run({ path: 'claims.json', base_hash: hash('[]') }), /核验失败.*只支持/);
  assert.match(await makeTools(dir, () => {}, { mode: 'edit-copy' }).finish_draft.run({ path: '脚本.md', base_hash: hash('') }), /拒绝/);
  assert.match(await makeTools(dir, () => {}, { mode: 'article', review: { required: true } }).finish_draft.run({ path: '脚本.md', base_hash: hash('') }), /拒绝/);
});

test('旧完整工程不强制补提交，后续已提交脚本删场不被旧方案强行恢复', async t => {
  const dir = fixture(t);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'build');
  const before = fs.readdirSync(dir);
  assert.equal(authorDocumentState(dir, '脚本.md').ok, true);
  assert.deepEqual(fs.readdirSync(dir), before, '状态观察只读');
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  assert.equal(JSON.parse(await tools.finish_draft.run({ path: '脚本.md', base_hash: hash(line(1)) })).ok, true);
  fs.writeFileSync(path.join(dir, '方案.md'), plan(8));
  assert.equal(authorDocumentState(dir, '脚本.md').ok, true);
});

test('计划只读真正分场表；围栏示例不制造额外场次', () => {
  assert.deepEqual(plannedScenes(plan(2) + '\n```md\n| S99 | 示例 |\n```\n'), [1, 2]);
});

test('初始化场景的安装基线命中时，即使场数相同也进入真实场景写作', async t => {
  const dir = fixture(t), original = fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8');
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ installedFiles: { 'scenes.src.js': hash(original) } }));
  assert.equal(sceneAuthoringState(dir).needed, true);
  const work = await nextPipelineWork(dir, 'article');
  assert.equal(work.stage, 'draft_scenes'); assert.match(work.note, /初始化示例/);
  assert.equal(pendingSceneWork(dir, 'article').scene, 1);
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  assert.match(await tools.run_stage.run({ stage: 'build' }), /拒绝.*初始化示例/);
  assert.match(await tools.write_scene.run({ scene: 1, content: scene(2) }), /已保存/);
  assert.equal((await nextPipelineWork(dir, 'article')).tool, 'assemble_scenes');
  assert.match(await tools.assemble_scenes.run({}), /已组装/);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'build');
});

test('缺失 scenes.src.js 时逐场草稿仍能保存和组装，不要求先造占位文件', async t => {
  const dir = fixture(t);
  fs.unlinkSync(path.join(dir, 'scenes.src.js'));
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_scenes');
  assert.match(await tools.write_scene.run({ scene: 1, content: scene(1) }), /已保存/);
  assert.equal(fs.existsSync(path.join(dir, 'scenes.src.js')), false);
  assert.equal((await nextPipelineWork(dir, 'article')).tool, 'assemble_scenes');
  assert.match(await tools.assemble_scenes.run({}), /已组装/);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'build');
});

const skill = skillDir();
test('保留一块自带示例也不能被完整场数掩盖', { skip: !skill || !fs.existsSync(path.join(skill, 'assets/scenes.src.js')) }, async t => {
  const dir = fixture(t, 2), sample = fs.readFileSync(path.join(skill, 'assets/scenes.src.js'), 'utf8').split(/^\/\/---\s*$/m)[0];
  fs.writeFileSync(path.join(dir, '脚本.md'), line(1) + '\n' + line(2));
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), sample + '\n//---\n' + scene(2));
  assert.equal(sceneAuthoringState(dir).needed, true);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'draft_scenes');
});

test('纠正输入后可重新核验，但不重置修复额度；相同输入/环境故障不自动重试', () => {
  const failed = { stage: 'build', reason: 'FAIL 主体缺失', sourceSignature: 'a', maxRepairs: 0 };
  const stopped = productionFailure({}, failed);
  assert.equal(reconsiderProductionStop(stopped, 'a'), stopped);
  const ready = reconsiderProductionStop(stopped, 'b');
  assert.equal(ready.stop, null); assert.equal(ready.history.length, 0);
  assert.match(productionFailure(ready, { ...failed, sourceSignature: 'b' }).stop, /0 轮上限/);
  const environment = productionFailure({}, { ...failed, reason: 'ENOSPC' });
  assert.equal(reconsiderProductionStop(environment, 'b'), environment);
});

test('旧暂停检查点恢复时允许补完缺稿，但不调用重型阶段或增加修复预算', async t => {
  const dir = fixture(t, 2), taskId = 'legacy-half-script';
  const ledger = { history: [{ key: 'one' }, { key: 'two' }], pending: null,
    stop: '自动修复已达到 2 轮上限；FAIL 脚本缺主体' };
  writeCheckpoint(dir, { schemaVersion: 1, taskId, mode: 'article', task: '完成当前视频', status: 'paused', pending: [],
    messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '完成当前视频' }], changeContracts: [],
    automation: { enabled: true, maxRepairs: 2 }, pipelineState: { productionRepairs: ledger } });
  let requests = 0;
  const result = await runAgent(dir, '完成当前视频', { mode: 'article', taskId, resume: true, stepBudget: 1,
    providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }],
    request: async () => {
      requests++;
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'append-script', type: 'function', function: {
        name: 'append_file', arguments: JSON.stringify({ path: '脚本.md', base_hash: readEditFile(dir, '脚本.md').base_hash, content: '\n' + line(2) }),
      } }] }, finish_reason: 'tool_calls' }] };
    } });
  assert.equal(requests, 1); assert.equal(result.status, 'paused');
  assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /## S2/);
  assert.equal(authorDocumentState(dir, '脚本.md').state, 'writing', '续写旧半稿也要等 finish_draft，不能末场刚落盘就跳走');
  const saved = readCheckpoint(dir, taskId);
  assert.equal(saved.pipelineState.productionRepairs.history.length, 2);
  assert.equal(saved.pipelineState.productionRepairs.stoppedSignature.length, 64);
  assert.notEqual(saved.pipelineState.productionRepairs.stoppedSignature, productionRepairSignature(dir));
  assert.equal(fs.existsSync(path.join(dir, 'out/.vh-tool-logs')), false);
});

test('时长自动修复不能绕过预算；初次与恢复计账，但先讨论不扣账或被旧停止截断', async t => {
  for (const [limit, existingStop, discussion] of [[0, false], [0, true], [2, false], [0, true, true], [2, false, true]]) {
    const dir = fixture(t), taskId = 'duration-budget';
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ durationLimit: { maxSeconds: 2, targetSeconds: 1 } }));
    fs.writeFileSync(path.join(dir, 'engine.tpl.html'), "const ORIENT = 'landscape';");
    fs.writeFileSync(path.join(dir, 'scene.html'), 'const ORIENT = "landscape"; const scenes = []; addScene(0,3,()=>{}); const DURATION = 3;');
    fs.writeFileSync(path.join(dir, 'timeline.mjs'), 'export const scriptGroups=()=>[{}]; export const validateTiming=d=>({total:d.dur,subs:[]});');
    fs.writeFileSync(path.join(dir, 'timing.json'), '{"dur":3}');
    fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'out/.vh-state.json'), JSON.stringify({ genStamp: {
      scriptHash: hashFile(path.join(dir, '脚本.md')), scenesHash: hashFile(path.join(dir, 'scenes.src.js')),
      sourceHashes: currentArtifactInputs(dir).sourceHashes,
    } }));
    assert.match((await nextPipelineWork(dir, 'article')).key, /^duration:/);
    const ledger = existingStop ? productionFailure({}, { stage: 'measure', reason: 'FAIL 时长超限',
      sourceSignature: productionRepairSignature(dir), maxRepairs: limit }) : undefined;
    writeCheckpoint(dir, { schemaVersion: 1, taskId, mode: 'article', task: '完成视频', status: 'paused', pending: [],
      messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '完成视频' }], changeContracts: [],
      automation: { enabled: true, maxRepairs: limit }, pipelineState: { productionRepairs: ledger } });
    let requests = 0;
    const result = await runAgent(dir, '完成视频', { mode: 'article', taskId, resume: true, stepBudget: 1,
      instruction: discussion ? '先讨论，不要修改文件' : '',
      providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }],
      request: async () => {
        requests++;
        return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'read-draft', type: 'function',
          function: { name: 'read_file', arguments: '{"path":"脚本.md"}' } }] }, finish_reason: 'tool_calls' }] };
      } });
    assert.equal(result.status, 'paused');
    assert.equal(requests, discussion || limit > 0 ? 1 : 0);
    assert.equal(readCheckpoint(dir, taskId).pipelineState.productionRepairs?.history.length || 0, discussion || limit === 0 ? 0 : 1);
    if (limit === 0 && !discussion) assert.match(result.paused, /0 轮上限/);
    assert.equal(fs.existsSync(path.join(dir, 'out/.vh-tool-logs')), false);
  }
});

test('环境停止即使同时存在缺稿，也不能让模型靠改稿解锁', async t => {
  const dir = fixture(t, 2), taskId = 'environment-and-draft';
  const ledger = productionFailure({}, { stage: 'build', reason: 'ENOSPC', sourceSignature: productionRepairSignature(dir) });
  writeCheckpoint(dir, { schemaVersion: 1, taskId, mode: 'article', task: '完成视频', status: 'paused', pending: [],
    messages: [{ role: 'system', content: '规则' }, { role: 'user', content: '完成视频' }], changeContracts: [],
    automation: { enabled: true, maxRepairs: 2 }, pipelineState: { productionRepairs: ledger } });
  const result = await runAgent(dir, '完成视频', { mode: 'article', taskId, resume: true, stepBudget: 1,
    providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }],
    request: async () => { throw new Error('环境未解决，不应请求模型修改作者文档'); } });
  assert.equal(result.status, 'paused'); assert.match(result.paused, /环境.*检查器/);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), line(1));
});
