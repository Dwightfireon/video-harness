import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { checkPublish, publishStatus, parsePublish, deliveryTarget, setDeliveryTarget, reviewStatus } from '../lib/publish.mjs';
import { runAgent, makeTools } from '../lib/agent.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { deliverableState, projectDeliveryState } from '../lib/deliverable.mjs';
import { createArtifactRecord, currentArtifactInputs } from '../lib/artifact-status.mjs';
import { saveState, hashFile } from '../lib/state.mjs';
import { beginTask, updateTask, readTask } from '../lib/task-status.mjs';
import { readCheckpoint, taskDir } from '../lib/checkpoint.mjs';
import { ProviderRequestError } from '../lib/provider-pool.mjs';
import { startServer } from '../lib/server.mjs';
import { chromium } from 'playwright';
import { launchBrowser } from '../lib/browser.mjs';

const copy = '## 标题\n我手动选的标题\n\n## 简介\n介绍测试窗口如何变化。\n\n## 置顶评论\n欢迎交流窗口的使用方法。\n\n## 标签\n- 测试窗口\n\n## 封面文案\n主：测试窗口\n副：变化的过程\n\n## 发布前检查清单\n- [ ] 人工核对成片与发布口径\n';
const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture-only' }];
const reply = () => ({ choices: [{ message: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }] });
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-publish-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  for (const [file, text] of Object.entries({
    'PROJECT.json': '{"name":"发布测试","custom":"保留用户字段"}',
    '脚本.md': '## S1 · 窗口\n1. 观察一个窗口的变化。\n', '方案.md': '受众基线：知道窗口。', 'claims.json': '[]',
    'scenes.src.js': 'root => ({render(){}})', 'engine.tpl.html': "const ORIENT = 'landscape';",
    'scene.html': 'const DURATION = 1; const scenes = []; addScene(0,1,root=>({}));',
    'timing.json': '{}', 'timeline.mjs': 'export const scriptGroups=()=>[];export const validateTiming=()=>({subs:[],total:1});',
  })) fs.writeFileSync(path.join(dir, file), text);
  saveState(dir, { lastMeasure: { scriptHash: hashFile(path.join(dir, '脚本.md')) } });
  return dir;
}
function media(dir) {
  for (const [name, audio] of [['video.mp4', false], ['video-voice.mp4', true]]) {
    const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=64x36:rate=10:duration=1'];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-shortest');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast'); if (audio) args.push('-c:a', 'aac');
    args.push(path.join(dir, 'out', name)); assert.equal(spawnSync('ffmpeg', args).status, 0);
  }
  const inputs = currentArtifactInputs(dir);
  saveState(dir, { genStamp: { scriptHash: inputs.sourceHashes['脚本.md'], scenesHash: inputs.sourceHashes['scenes.src.js'], sourceHashes: inputs.sourceHashes },
    render: { artifact: createArtifactRecord(dir, 'render') }, voice: { artifact: createArtifactRecord(dir, 'voice') } });
}
async function serve(t, dir, options = {}) {
  const server = startServer(dir, 0, { root: path.dirname(dir), providerInfo: () => [], ...options });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const post = (url, data = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

test('发布校验：缺失、必填空白、占位链接均不通过，输出具体字段', () => {
  assert.equal(checkPublish('').state, 'missing');
  const empty = checkPublish('## 标题\n\n## 简介\n\n## 封面文案\n主：\n副：仅副标题');
  assert.equal(empty.ok, false); assert.ok(empty.errors.some(e => e.field === 'main')); assert.ok(empty.errors.some(e => e.field === 'cover'));
  for (const placeholder of ['<带码链接>', '[待填链接]', '【待补优惠码】', 'TODO', 'TBD']) {
    const result = checkPublish(copy.replace('欢迎交流窗口的使用方法。', placeholder));
    assert.ok(result.errors.some(e => e.code === 'placeholder' && e.field === 'comment'), placeholder);
  }
});

test('检查只扫描公开字段，不把内部来源备注和未勾选人工清单当必填错误', () => {
  const md = copy + '\n## 素材与数字\nTODO 内部来源补核\n';
  const result = checkPublish(md);
  assert.equal(result.ok, true); assert.equal(result.unchecked, 1);
  assert.ok(result.warnings.some(e => e.code === 'review'));
  assert.equal(parsePublish('## 标题\n> 模板说明\n真正标题').main, '真正标题');
  const noTags = checkPublish(copy.replace('## 标签\n- 测试窗口\n', ''));
  assert.equal(noTags.ok, false, '发布包缺标签不能当作完整交付');
  assert.ok(noTags.errors.some(e => e.field === 'tags'));
  for (const placeholder of ['、，', '待补', '暂无']) {
    assert.equal(checkPublish(copy.replace('- 测试窗口', placeholder)).ok, false, placeholder);
  }
  assert.deepEqual(parsePublish(copy.replace('- 测试窗口', 'DNS、#域名解析，计算机网络')).tags, ['DNS', '域名解析', '计算机网络']);
});

test('交付目标可选且保留其他项目字段，非法值拒绝', t => {
  const dir = fixture(t); assert.equal(deliveryTarget(dir), 'publish-package');
  setDeliveryTarget(dir, 'video'); assert.equal(publishStatus(dir).required, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROJECT.json'))).custom, '保留用户字段');
  assert.throws(() => setDeliveryTarget(dir, 'skip-everything'), /交付目标/);
});

test('视频齐备但文案缺失时进入 publish，文案通过后才进入 validate', async t => {
  const dir = fixture(t); media(dir);
  assert.equal(deliverableState(dir).stale, false, '视频凭证本身仍然有效');
  assert.equal(projectDeliveryState(dir).stale, true);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'publish');
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy.replace('## 标签\n- 测试窗口\n', ''));
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'publish', '文案存在但缺标签仍需补齐');
  assert.match(projectDeliveryState(dir).reason, /标签/);
  for (const invalid of [
    copy.replace('- 测试窗口', Array.from({ length: 12 }, (_, i) => '- 标签' + i).join('\n')),
    copy.replace('- 测试窗口', '- ' + '标'.repeat(21)),
    copy.replace('我手动选的标题', '题'.repeat(81)),
    copy.replace('介绍测试窗口如何变化。', '介'.repeat(2001)),
  ]) {
    fs.writeFileSync(path.join(dir, '发布文案.md'), invalid);
    assert.equal((await nextPipelineWork(dir, 'article')).stage, 'publish', '投稿台会拦截的长度/数量不能在制作阶段通过');
    assert.equal(projectDeliveryState(dir).publish.ok, false);
    assert.equal(deliverableState(dir).stale, false, '仅文案超限不使视频过期');
  }
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy);
  assert.equal((await nextPipelineWork(dir, 'article')).stage, 'validate');
  assert.equal(projectDeliveryState(dir).stale, false);
  assert.equal(reviewStatus(dir).state, 'pending');
});

test('全流程真实成片完成后必须实际补写文案，不能只说完成', async t => {
  const dir = fixture(t); media(dir); let n = 0;
  const result = await runAgent(dir, '生成视频和发布包', { mode: 'article', providers, stepBudget: 5, request: async () => {
    if (++n === 1) return reply();
    return call('write_file', { path: '发布文案.md', content: copy });
  } });
  assert.equal(result.status, 'completed'); assert.equal(result.deliverable.publish.ok, true); assert.equal(n, 2);
  assert.equal(reviewStatus(dir).state, 'pending', '机械通过不能自动完成审稿');
});

test('仅视频交付不因缺发布文案被阻塞', async t => {
  const dir = fixture(t); media(dir); setDeliveryTarget(dir, 'video');
  assert.equal((await nextPipelineWork(dir, 'topic')).stage, 'validate');
  const result = await runAgent(dir, '仅视频', { mode: 'topic', providers, request: async () => { throw Error('不应请求模型'); } });
  assert.equal(result.status, 'completed'); assert.equal(fs.existsSync(path.join(dir, '发布文案.md')), false);
});

test('单独文案任务可恢复渠道失败，且不修改媒体或脚本', async t => {
  const dir = fixture(t), taskId = 'copy-retry';
  const files = ['脚本.md', 'scenes.src.js', 'out/video.mp4', 'out/video-voice.mp4'];
  fs.writeFileSync(path.join(dir, 'out/video.mp4'), 'silent-original'); fs.writeFileSync(path.join(dir, 'out/video-voice.mp4'), 'voice-original');
  const before = files.map(file => fs.readFileSync(path.join(dir, file), 'utf8'));
  const failed = await runAgent(dir, '只生成文案', { taskId, mode: 'edit-copy', providers, request: async () => { throw new ProviderRequestError('quota'); } });
  assert.equal(failed.status, 'failed');
  let n = 0;
  const done = await runAgent(dir, '只生成文案', { taskId, mode: 'edit-copy', providers, resume: true, request: async () => ++n === 1
    ? call('write_file', { path: '发布文案.md', content: copy }) : reply() });
  assert.equal(done.status, 'completed'); assert.deepEqual(files.map(file => fs.readFileSync(path.join(dir, file), 'utf8')), before);
});

test('已有文案使用短补丁、保留手动标题并备份；仍含占位符不能完成', async t => {
  const dir = fixture(t), original = copy.replace('欢迎交流窗口的使用方法。', '<带码链接>');
  fs.writeFileSync(path.join(dir, '发布文案.md'), original);
  const tools = makeTools(dir, () => {}, { mode: 'edit-copy' });
  assert.match(await tools.write_file.run({ path: '发布文案.md', content: copy }), /不能整份覆盖/);
  const blocked = await runAgent(dir, '补文案', { mode: 'edit-copy', providers, request: async () => reply() });
  assert.equal(blocked.status, 'paused'); assert.match(blocked.paused, /占位/);
  let n = 0;
  const done = await runAgent(dir, '修复已有文案', { mode: 'edit-copy', providers, request: async () => ++n === 1
    ? call('patch_text', { path: '发布文案.md', base_hash: readEditFile(dir, '发布文案.md').base_hash, find: '<带码链接>', replace: '欢迎交流窗口的使用方法。' }) : reply() });
  assert.equal(done.status, 'completed', JSON.stringify({ paused: done.paused, error: done.error, actions: done.actions })); assert.equal(parsePublish(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8')).main, '我手动选的标题');
  assert.equal(fs.readdirSync(path.join(dir, 'out/.vh-edit-history')).length, 1);
});

test('文案阶段禁止媒体制作与其他文件写入，包括全流程中的 publish 阶段', async t => {
  const dir = fixture(t), original = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  for (const opts of [{ mode: 'edit-copy' }, { mode: 'article', publishOnly: true }]) {
    const tools = makeTools(dir, () => {}, opts);
    assert.match(await tools.write_file.run({ path: '脚本.md', content: 'unsafe' }), /拒绝/);
    assert.match(await tools.run_stage.run({ stage: 'render' }), /拒绝/);
    assert.match(await tools.write_scene.run({ scene: 1, content: 'root => ({render(){}})' }), /拒绝/);
    assert.match(await tools.run.run({ command: 'node -e "require(\"fs\").writeFileSync(\"脚本.md\",\"unsafe\")"' }), /拒绝/);
  }
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), original);
});

test('受控文案工具不能替用户勾选人工审查，已有手动登记可以保留', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'edit-copy' });
  assert.match(await tools.write_file.run({ path: '发布文案.md', content: copy.replace('[ ]', '[x]') }), /人工审阅勾选/);
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy);
  assert.match(await tools.patch_text.run({ path: '发布文案.md', base_hash: readEditFile(dir, '发布文案.md').base_hash, find: '[ ]', replace: '[x]' }), /人工审阅勾选/);
  assert.match(await tools.append_file.run({ path: '发布文案.md', base_hash: readEditFile(dir, '发布文案.md').base_hash, content: '* [x] 已审阅\n' }), /人工审阅勾选/);
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy.replace('[ ]', '[x]'));
  assert.match(await tools.patch_text.run({ path: '发布文案.md', base_hash: readEditFile(dir, '发布文案.md').base_hash, find: '介绍测试窗口如何变化。', replace: '介绍窗口变化的过程。' }), /"ok":true/);
});

test('仅文案替换的核验不扩展到同名脚本内容，也不会令视频显示过期', async t => {
  const dir = fixture(t), message = '只在发布文案中把“张三”替换为“受访者”';
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy.replace('我手动选的标题', '张三介绍窗口'));
  fs.appendFileSync(path.join(dir, '脚本.md'), '2. 张三展示另一个窗口。\n');
  media(dir);
  const originalScript = fs.readFileSync(path.join(dir, '脚本.md'), 'utf8');
  const task = beginTask(dir, message, 'edit-copy'); updateTask(dir, task.id, { status: 'running', pid: process.pid });
  let n = 0;
  const result = await runAgent(dir, message, { taskId: task.id, attemptId: task.attemptId, mode: 'edit-copy', providers, request: async () => {
    assert.equal(deliverableState(dir).stale, false, '文案待核验不能让视频显示过期');
    if (++n === 1) return call('patch_text', { path: '发布文案.md', base_hash: readEditFile(dir, '发布文案.md').base_hash, find: '张三', replace: '受访者' });
    return reply();
  } });
  assert.equal(result.status, 'completed', result.paused); assert.equal(result.deliverable.stale, false);
  assert.equal(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), originalScript);
  assert.equal(readCheckpoint(dir, task.id).changeContracts[0].scope, 'publish');
});

test('CLI：检查只读且失败非零；force 不能打包占位文案，video-only 不携带文案', t => {
  const dir = fixture(t), cli = path.resolve('vh.mjs');
  media(dir);
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy.replace('欢迎交流窗口的使用方法。', '<带码链接>'));
  const before = fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8');
  const check = spawnSync(process.execPath, [cli, 'publish-check', '--dir', dir, '--json'], { encoding: 'utf8' });
  assert.equal(check.status, 1); assert.match(check.stdout, /placeholder/);
  assert.equal(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8'), before);
  const out = path.join(dir, 'export');
  const pack = spawnSync(process.execPath, [cli, 'pack', '--dir', dir, '--force', '--out', out], { encoding: 'utf8' });
  assert.equal(pack.status, 1); assert.match(pack.stderr, /占位/); assert.equal(fs.existsSync(out), false);
  const tooManyTags = copy.replace('- 测试窗口', Array.from({ length: 12 }, (_, i) => '- 标签' + i).join('\n'));
  fs.writeFileSync(path.join(dir, '发布文案.md'), tooManyTags);
  const limits = spawnSync(process.execPath, [cli, 'pack', '--dir', dir, '--force', '--out', out], { encoding: 'utf8' });
  assert.equal(limits.status, 1); assert.match(limits.stderr, /标签 12 个，超过 10 个上限/);
  assert.equal(fs.existsSync(out), false);
  assert.equal(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8'), tooManyTags);
  const video = spawnSync(process.execPath, [cli, 'pack', '--dir', dir, '--force', '--video-only', '--out', out], { encoding: 'utf8' });
  assert.equal(video.status, 0, video.stderr); assert.equal(fs.existsSync(path.join(out, '发布文案.md')), false);
  fs.writeFileSync(path.join(out, '发布文案.md'), '用户之前的文案');
  const collision = spawnSync(process.execPath, [cli, 'pack', '--dir', dir, '--force', '--video-only', '--out', out], { encoding: 'utf8' });
  assert.equal(collision.status, 1); assert.equal(fs.readFileSync(path.join(out, '发布文案.md'), 'utf8'), '用户之前的文案');
});

test('CLI：prune 只清缓存，保留原始材料、作者备份和可能作为审阅依据的过程图', t => {
  const dir = fixture(t), cli = path.resolve('vh.mjs');
  for (const [name, value] of Object.entries({ 'materials/原文.md': '不可重建的原文',
    'research/依据.txt': '真实证据', 'engine.tpl.html.bak-old': '原版', 'out/preview-8.png': '审阅过程图',
    'out/frames/00001.jpg': '缓存', 'out/.voice-kokoro/01.wav': '缓存', 'out/seg/seg-1.mp4': '缓存' })) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), value);
  }
  const result = spawnSync(process.execPath, [cli, 'prune', '--dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['materials/原文.md', 'research/依据.txt', 'engine.tpl.html.bak-old', 'out/preview-8.png'])
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  for (const name of ['out/frames', 'out/.voice-kokoro', 'out/seg']) assert.equal(fs.existsSync(path.join(dir, name)), false, name);
});

test('CLI：显式发布验收失败不清缓存，默认交付不需审核签字且不删除源码', t => {
  const dir = fixture(t), cli = path.resolve('vh.mjs');
  fs.writeFileSync(path.join(dir, '发布文案.md'), copy);
  fs.mkdirSync(path.join(dir, 'materials')); fs.writeFileSync(path.join(dir, 'materials/原文.md'), '用户原文');
  fs.mkdirSync(path.join(dir, 'research')); fs.writeFileSync(path.join(dir, 'research/证据.txt'), '证据');
  fs.mkdirSync(path.join(dir, 'out/frames')); fs.writeFileSync(path.join(dir, 'out/frames/00001.jpg'), '缓存');
  fs.writeFileSync(path.join(dir, 'out/preview-8.png'), '过程图'); media(dir);
  const rejected = spawnSync(process.execPath, [cli, 'publish-done', '--dir', dir, '--reviewed', '--out', path.join(dir, 'export-rejected')], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.ok(fs.existsSync(path.join(dir, 'out/frames/00001.jpg')), '打包失败不清缓存');
  assert.ok(fs.existsSync(path.join(dir, 'materials/原文.md')));
  const out = path.join(dir, 'export-default');
  const result = spawnSync(process.execPath, [cli, 'publish-done', '--dir', dir, '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /交付包已导出/); assert.ok(result.stdout.includes(out));
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'))).releaseReady, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'))).deliveryReady, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'))).review.required, false);
  assert.equal(fs.existsSync(path.join(dir, 'out/frames')), false);
  for (const name of ['脚本.md', 'scenes.src.js', 'materials/原文.md', 'research/证据.txt', 'out/preview-8.png'])
    assert.ok(fs.existsSync(path.join(dir, name)), name);
  assert.equal(fs.existsSync(path.join(out, 'research/证据.txt')), false, '公开包不冒充完整工程备份');
});

test('CLI：永久删除项目须显式确认，未确认时不先清缓存', t => {
  const dir = fixture(t), cli = path.resolve('vh.mjs');
  fs.mkdirSync(path.join(dir, 'out/frames')); fs.writeFileSync(path.join(dir, 'out/frames/00001.jpg'), '保留');
  const denied = spawnSync(process.execPath, [cli, 'rm', dir, '--purge'], { encoding: 'utf8' });
  assert.equal(denied.status, 1); assert.match(denied.stderr, /--purge --yes/);
  assert.equal(fs.readFileSync(path.join(dir, 'out/frames/00001.jpg'), 'utf8'), '保留');
  const confirmed = spawnSync(process.execPath, [cli, 'rm', dir, '--purge', '--yes'], { encoding: 'utf8' });
  assert.equal(confirmed.status, 0, confirmed.stderr); assert.equal(fs.existsSync(dir), false);
});

test('API：分项状态可见，保存目标不调用模型；错误项目与运行中写入拒绝', async t => {
  const dir = fixture(t), url = await serve(t, dir);
  const state = await (await fetch(url + '/_api/state')).json();
  assert.equal(state.delivery.publish.state, 'missing'); assert.equal(state.delivery.review.state, 'pending');
  assert.equal((await post(url + '/_api/publish/target', { target: 'video' })).status, 200);
  assert.equal(deliveryTarget(dir), 'video'); assert.equal(readTask(dir), null);
  assert.equal((await post(url + '/_api/publish/target', { target: 'invalid' })).status, 400);
  assert.equal((await post(url + '/_api/publish/generate?p=missing')).status, 404);
  const task = beginTask(dir, '正在做视频', 'article'); updateTask(dir, task.id, { status: 'running', pid: process.pid });
  assert.equal((await post(url + '/_api/publish/generate')).status, 409);
  assert.equal((await post(url + '/_api/publish/target', { target: 'publish-package' })).status, 409);
  assert.equal(deliveryTarget(dir), 'video');
});

test('API：缺凭证不归档原任务；另开文案任务须确认，原检查点保留', async t => {
  const dir = fixture(t), task = beginTask(dir, '制作失败', 'article');
  updateTask(dir, task.id, { status: 'failed' });
  const url = await serve(t, dir);
  const ask = await post(url + '/_api/publish/generate'); assert.equal(ask.status, 409); assert.equal((await ask.json()).requiresConfirmation, true);
  assert.equal((await post(url + '/_api/publish/generate', { confirmNew: true })).status, 503);
  assert.equal(readTask(dir).id, task.id);
  const local = await serve(t, dir, { providerInfo: () => [{ provider: 'fixture' }], agentExecutable: '/usr/bin/true' });
  const started = await post(local + '/_api/publish/generate', { confirmNew: true });
  assert.equal(started.status, 200); assert.equal((await started.json()).task.mode, 'edit-copy');
  assert.ok(fs.existsSync(path.join(taskDir(dir, task.id), 'task.json')));
});

test('API：文案重试保持任务 ID 和 edit-copy 模式，不恢复原视频制作', async t => {
  const dir = fixture(t), task = beginTask(dir, '只补文案', 'edit-copy'); updateTask(dir, task.id, { status: 'failed' });
  const url = await serve(t, dir, { providerInfo: () => [{ provider: 'fixture' }], agentExecutable: '/usr/bin/true' });
  const response = await post(url + '/_api/publish/generate'), body = await response.json();
  assert.equal(body.resumed, true); assert.equal(body.task.taskId, task.id); assert.equal(body.task.mode, 'edit-copy');
});

test('UI：发布页显示分项状态，桌面与手机可保存仅视频目标，提交失败可再试', { timeout: 30000 }, async t => {
  const dir = fixture(t), url = await serve(t, dir);
  const browser = await launchBrowser(chromium); t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.setDefaultTimeout(7000);
    page.on('pageerror', error => console.error('发布页错误：', error.message));
    await page.goto(url + '/?p=' + path.basename(dir) + '&tab=publish');
    await page.waitForSelector('#publishStatus');
    await page.screenshot({ path: path.resolve(`diagnostics/publish-ui-${width}.png`), fullPage: true });
    assert.match(await page.locator('#publishStatus').textContent(), /发布文案：尚未生成/);
    await page.selectOption('#deliveryTarget', 'video');
    if (!(await page.locator('#saveDeliveryTarget').isDisabled())) await page.click('#saveDeliveryTarget');
    await page.waitForFunction(() => document.querySelector('#deliveryTarget')?.value === 'video' && document.querySelector('#saveDeliveryTarget')?.disabled);
    assert.equal(deliveryTarget(dir), 'video');
    page.on('dialog', d => d.accept());
    await page.click('#generatePublish');
    await page.waitForFunction(() => document.querySelector('#publishNotice')?.textContent.includes('提交失败'));
    assert.equal(await page.locator('#generatePublish').isDisabled(), false);
    assert.equal(readTask(dir), null, '无凭证时不启动任务');
    assert.equal(await page.locator('#publish').evaluate(el => el.scrollWidth <= el.clientWidth + 1), true, '发布区不横向溢出');
    await page.close();
  }
});

/* 真实事故：文案把标题写成「1. 2. 3.」编号、标签用「·」分隔。
 * 解析器只取第一行当标题（带着 "1. "），中点被拆成碎片标签，但检查器全绿。
 * 这两类错误必须被提示，否则用户不知道发布台上看到的标题为什么带着编号。 */
const wrap = (title, tags) => `# 发布文案
## 标题

${title}

## 简介

简介正文

## 标签

${tags}

## 置顶评论

评论

## 封面文案

主：甲
副：乙
`;

test('标题写成编号列表时给出可修正的提示，而不是静默通过', () => {
  const r = checkPublish(wrap('1. 第一条\n2. 第二条', '甲'));
  assert.equal(r.ok, true, '不是硬错误，不该阻断');
  assert.ok(r.warnings.some(w => w.code === 'title-numbered'), '应提示编号标题');
});

test('标签用中点分隔时提示分隔符碎片', () => {
  const r = checkPublish(wrap('正常标题', 'LLM · 开源模型 · 资源清单'));
  assert.ok(r.warnings.some(w => w.code === 'tags-separator'), '应提示标签分隔符问题');
});

test('正常写法不产生这两类提示', () => {
  const r = checkPublish(wrap('正常标题\n\n- 备选一\n- 备选二', 'LLM\n开源模型\n资源清单'));
  assert.equal(r.warnings.some(w => ['title-numbered', 'tags-separator'].includes(w.code)), false);
});
