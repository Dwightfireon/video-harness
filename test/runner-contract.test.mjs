import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginTask, updateTask, resumeTask, readTask, taskStatus } from '../lib/task-status.mjs';
import { createTaskContract, taskScopeObservation } from '../lib/task-contract.mjs';
import { settleTaskResult, observeTaskCompletion } from '../lib/task-completion.mjs';
import { taskDeliveryState } from '../lib/deliverable.mjs';
import { pendingRunnerInstructions } from '../lib/runner-instructions.mjs';
import { createRunner, readSession } from '../lib/runners/opencode.mjs';
import { currentArtifactInputs } from '../lib/artifact-status.mjs';
import { createSnapshotService } from '../lib/snapshot-service.mjs';
import { writeSettings } from '../lib/provider-settings.mjs';
import * as publishModule from '../lib/publish.mjs';
globalThis.__publishModule = publishModule;

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const COPY = '## 标题\n一扇窗口\n\n## 简介\n观察窗口如何变化。\n\n## 置顶评论\n欢迎交流窗口的用法。\n\n## 标签\n- 窗口\n\n## 封面文案\n主：一扇窗口\n副：变化的过程\n\n## 发布前检查清单\n- [ ] 人工核对\n';
const SCRIPT = '## S1 · 窗口\n1. 窗口从这里打开。\n';
const ok = { ok: true, status: 'completed', answer: '已按本轮范围处理，尚未人工试听。' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-runner-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(project); fs.mkdirSync(home);
  fs.writeFileSync(path.join(project, 'PROJECT.json'), JSON.stringify({ runner: { name: 'opencode', model: 'fixture/model', service: 'private' }, deliveryTarget: 'video' }));
  const fake = path.join(root, 'fake-opencode'), capture = path.join(root, 'capture.json');
  fs.writeFileSync(fake, '#!' + process.execPath + '\n' + `
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture-version'); process.exit(0); }
fs.writeFileSync(process.env.CAPTURE, JSON.stringify(args));
if (process.env.CAPTURE_ENV) fs.writeFileSync(process.env.CAPTURE_ENV, JSON.stringify({
 config:process.env.OPENCODE_CONFIG_CONTENT, key:process.env.VH_EXECUTION_API_KEY, base:process.env.VH_EXECUTION_BASE_URL
}));
if (process.env.FIXTURE_ECHO_SECRET) {
 const key = process.env.VH_EXECUTION_API_KEY;
 process.stderr.write('x'.repeat(390) + key.slice(0,12));
 setTimeout(() => process.stderr.write(key.slice(12) + ' ' + process.env.VH_EXECUTION_BASE_URL + '\\n'), 40);
}
const event = (type, extra = {}) => console.log(JSON.stringify({type, sessionID:'fixture-session', ...extra}));
const tool = (name, status = 'completed') => event('tool_use', {part:{tool:name, state:{status, input:{command:'node vh.mjs status'}, output:'ok'}}});
if (process.env.FIXTURE_ACTION === 'error') { event('error', {error:{message:'fixture request rejected', status:402}}); process.exit(1); }
/* 中途连接中断，随后继续干活：错误事件之后有成功的工具和最终回答。 */
if (process.env.FIXTURE_ACTION === 'recover') {
  event('step_start', {part:{}}); tool('read');
  event('error', {error:{message:'ECONNRESET: The socket connection was closed unexpectedly.'}});
  tool('shell'); event('text', {part:{text: '中断后继续完成'}});
  process.exit(0);
}
/* 最后一刻才失败：错误之后没有任何成功动作。 */
if (process.env.FIXTURE_ACTION === 'recover-script') {
  event('step_start', {part:{}}); tool('read');
  event('error', {error:{message:'ECONNRESET: The socket connection was closed unexpectedly.'}});
  tool('shell');
  fs.writeFileSync('脚本.md', ${JSON.stringify(SCRIPT)});
  event('text', {part:{text: '中断后补完脚本'}});
  process.exit(0);
}
if (process.env.FIXTURE_ACTION === 'exit1-script') {
  event('step_start', {part:{}}); tool('shell');
  fs.writeFileSync('脚本.md', ${JSON.stringify(SCRIPT)});
  event('text', {part:{text: '交付完成，收尾时进程异常'}});
  process.exit(1);
}
if (process.env.FIXTURE_ACTION === 'fail-last') {
  event('step_start', {part:{}}); tool('read');
  event('error', {error:{message:'ECONNRESET: The socket connection was closed unexpectedly.'}});
  process.exit(1);
}
if (process.env.FIXTURE_ACTION === 'copy') fs.writeFileSync('发布文案.md', ${JSON.stringify(COPY)});
if (process.env.FIXTURE_ACTION === 'bad-copy') fs.writeFileSync('发布文案.md', ${JSON.stringify('## 标题\n\n还有占位：<带码链接>\n')});
if (process.env.FIXTURE_ACTION === 'script') fs.writeFileSync('脚本.md', ${JSON.stringify(SCRIPT)});
event('text', {part:{text: 'fixture 执行结束，实际交付由工作台核验'}});
`, { mode: 0o700 });
  const env = { ...process.env, HOME: home, VH_OPENCODE_BIN: fake, CAPTURE: capture, VH_RUNNER_MODEL: 'fixture/model' };
  for (const name of ['VH_RUNNER', 'VH_PRODUCTION_LOCK_TOKEN', 'VH_PRODUCTION_LOCK_PROJECT']) delete env[name];
  return { root, project, home, fake, capture, env };
}
function cli(f, args, action = '') {
  return spawnSync(process.execPath, [path.join(ROOT, 'vh.mjs'), 'ask', ...args, '--dir', f.project],
    { env: { ...f.env, FIXTURE_ACTION: action }, encoding: 'utf8', timeout: 20000 });
}

for (const mode of ['article', 'topic', 'edit', 'edit-copy', 'edit-script', 'edit-visual']) {
  test(`${mode}: OpenCode exit 0 with no work cannot complete a production/edit task`, t => {
    const f = fixture(t), job = beginTask(f.project, '落实这次制作要求', mode);
    const result = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const task = readTask(f.project), status = taskStatus(f.project);
    assert.equal(task.status, 'incomplete');
    assert.equal(task.executionStatus, 'completed');
    assert.equal(status.canResume, true);
    assert.equal(status.canContinueAfterDone, false);
    assert.ok(status.deliverableStale);
    assert.equal(task.mode, mode);
  });
}

test('CLI resume uses the persisted topic mode and delivers new requirements once per accepted session', t => {
  const f = fixture(t), job = beginTask(f.project, '调研并制作这个选题', 'topic');
  updateTask(f.project, job.id, { status: 'failed' }, job.attemptId);
  const instruction = '继续时只修第二场，绝不改原文';
  let result = cli(f, [instruction, '--resume']);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  let argv = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  assert.match(argv.at(-1), /给一个选题，自己调研成文再出片/);
  assert.ok(argv.at(-1).includes(instruction));
  assert.equal(readSession(f.project).includedInstructions.length, 1);
  assert.equal(taskStatus(f.project).resumeKind, 'session');
  result = cli(f, ['--resume']);
  argv = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  assert.equal(argv.includes('--session'), true);
  assert.equal(argv.at(-1).includes(instruction), false, 'accepted supplemental message must not be appended again');
  assert.equal(readTask(f.project).resumeInstructions[0].content, instruction);
});

test('rejected request does not consume a supplemental instruction', t => {
  const f = fixture(t), job = beginTask(f.project, '调研选题', 'topic');
  updateTask(f.project, job.id, { status: 'failed' }, job.attemptId);
  const rejected = cli(f, ['把解释补完整再继续', '--resume'], 'error');
  assert.equal(rejected.status, 1, rejected.stdout + rejected.stderr);
  assert.equal(readSession(f.project).includedInstructions.length, 0);
  cli(f, ['--resume']);
  assert.match(JSON.parse(fs.readFileSync(f.capture, 'utf8')).at(-1), /把解释补完整再继续/);
});

for (const [mode, action, kind] of [['edit-copy', 'copy', 'copy'], ['edit-script', 'script', 'script']]) {
  test(`${mode}: valid scoped output completes without rendering or measuring a video`, t => {
    const f = fixture(t), job = beginTask(f.project, '按范围补齐这次内容', mode);
    const result = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], action);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const task = readTask(f.project);
    assert.equal(task.status, 'completed'); assert.equal(task.completion.kind, kind);
    assert.equal(taskStatus(f.project).deliverableStale, null);
    assert.equal(fs.existsSync(path.join(f.project, 'out/video.mp4')), false);
    assert.equal(fs.existsSync(path.join(f.project, 'timing.json')), false);
  });
}

test('old valid copy does not fulfill a new copy edit; new content is required', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.project, '发布文案.md'), COPY);
  const contract = createTaskContract(f.project, { mode: 'edit-copy', message: '换一个标题' });
  assert.equal(taskDeliveryState(f.project, 'edit-copy').stale, false);
  const result = settleTaskResult(f.project, { mode: 'edit-copy', contract }, ok);
  assert.equal(result.status, 'incomplete'); assert.match(result.error, /本轮要求/);
});

test('protected author changes are rejected without reverting user files', t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.project, '脚本.md'), SCRIPT);
  const contract = createTaskContract(f.project, { mode: 'edit-copy', message: '只改发布文案' });
  fs.writeFileSync(path.join(f.project, '发布文案.md'), COPY);
  fs.appendFileSync(path.join(f.project, '脚本.md'), '2. 不允许的改动。\n');
  const result = settleTaskResult(f.project, { mode: 'edit-copy', contract }, ok);
  assert.equal(result.status, 'incomplete'); assert.match(result.error, /越出本轮范围.*脚本/);
  assert.match(fs.readFileSync(path.join(f.project, '脚本.md'), 'utf8'), /不允许的改动/);
});

test('read-only requests may answer without producing media, but cannot change authors', t => {
  const f = fixture(t), contract = createTaskContract(f.project, { mode: 'edit', message: '先讨论，只读，不要修改文件' });
  assert.equal(contract.readOnly, true);
  assert.equal(settleTaskResult(f.project, { mode: 'edit', contract }, ok).status, 'completed');
  assert.equal(settleTaskResult(f.project, { mode: 'edit', contract }, { ...ok, answer: '' }).status, 'incomplete');
  fs.writeFileSync(path.join(f.project, '脚本.md'), SCRIPT);
  assert.equal(settleTaskResult(f.project, { mode: 'edit', contract }, ok).status, 'incomplete');
});

test('pure continuation preserves the original change baseline', t => {
  const f = fixture(t), job = beginTask(f.project, '只补文案', 'edit-copy');
  updateTask(f.project, job.id, { status: 'failed' }, job.attemptId);
  const next = resumeTask(f.project, '继续');
  assert.deepEqual(next.contract, job.contract);
  assert.equal(next.contract.requireChange, true);
});

test('visual-only completion checks current build, not a voiced MP4', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, '脚本.md'), SCRIPT);
  fs.writeFileSync(path.join(f.project, 'engine.tpl.html'), "const ORIENT = 'landscape';");
  fs.writeFileSync(path.join(f.project, 'scenes.src.js'), 'root => ({render(){}})');
  const contract = createTaskContract(f.project, { mode: 'edit-visual', message: '修改画面颜色' });
  fs.appendFileSync(path.join(f.project, 'scenes.src.js'), '\n// new color');
  fs.writeFileSync(path.join(f.project, 'scene.html'), "const DURATION = 1; const ORIENT = 'landscape'; const scenes=[]; addScene(0,1,root=>({render(){}}));");
  fs.mkdirSync(path.join(f.project, 'out'), { recursive: true });
  const inputs = currentArtifactInputs(f.project);
  fs.writeFileSync(path.join(f.project, 'out/.vh-state.json'), JSON.stringify({ genStamp: {
    scriptHash: inputs.sourceHashes['脚本.md'], scenesHash: inputs.sourceHashes['scenes.src.js'], sourceHashes: inputs.sourceHashes } }));
  const result = settleTaskResult(f.project, { mode: 'edit-visual', contract }, ok);
  assert.equal(result.status, 'completed', result.error); assert.equal(result.deliverable.kind, 'preview');
});

test('task delivery worker and direct observation agree and observe subsequent edits', async t => {
  const f = fixture(t), job = beginTask(f.project, '只补发布文案', 'edit-copy');
  updateTask(f.project, job.id, { execution: { runner: 'opencode' } }, job.attemptId);
  fs.writeFileSync(path.join(f.project, '发布文案.md'), COPY);
  const service = createSnapshotService(); t.after(() => service.close());
  const before = await service.readDelivery(f.project, 'task');
  assert.equal(before.stale, false);
  assert.deepEqual(before, observeTaskCompletion(f.project, readTask(f.project)));
  fs.writeFileSync(path.join(f.project, '发布文案.md'), '## 标题\nTODO');
  assert.equal((await service.readDelivery(f.project, 'task')).stale, true);
});

test('instruction identities include content; corrupt instruction records fail explicitly', () => {
  const notes = [{ id: 'one', content: '只修第二场' }];
  const pending = pendingRunnerInstructions(notes);
  assert.equal(pendingRunnerInstructions(notes, [pending[0].key]).length, 0);
  assert.equal(pendingRunnerInstructions([{ id: 'one', content: '改修第三场' }], [pending[0].key]).length, 1);
  assert.throws(() => pendingRunnerInstructions([{ id: 'one' }]), /损坏/);
});

test('corrupt scope or session records do not silently allow a new execution', async t => {
  const f = fixture(t);
  assert.equal(taskScopeObservation(f.project, { version: 2 }).stale, true);
  fs.mkdirSync(path.join(f.project, 'out')); fs.writeFileSync(path.join(f.project, 'out/.vh-runner.json'), '{bad');
  await assert.rejects(createRunner(f.project, { model: 'fixture/model' }).run({ prompt: '继续', resume: true }), /会话记录损坏/);
});

test('real CLI uses selected provider/key/base via private runtime env and persists only a safe snapshot', t => {
  const f = fixture(t), captureEnv = path.join(f.root, 'runtime-env.json');
  fs.writeFileSync(path.join(f.project, 'PROJECT.json'), JSON.stringify({ runner: 'opencode', deliveryTarget: 'video' }));
  delete f.env.VH_RUNNER_MODEL;
  f.env.CAPTURE_ENV = captureEnv; f.env.FIXTURE_ECHO_SECRET = '1';
  const key = 'fixture-key-never-a-real-credential', base = 'https://user:private-pass@fixture.invalid/v1?token=private-query';
  writeSettings({ preferredProvider: 'commandcode', models: { commandcode: 'deepseek/coder' }, bases: { commandcode: base }, keys: { commandcode: key } }, f.home);
  const job = beginTask(f.project, '只补讲述', 'edit-script');
  const result = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], 'script');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const argv = JSON.parse(fs.readFileSync(f.capture, 'utf8'));
  assert.equal(argv[argv.indexOf('-m') + 1], 'commandcode/deepseek/coder');
  assert.equal(argv.includes('--standalone'), true);
  const passed = JSON.parse(fs.readFileSync(captureEnv, 'utf8'));
  assert.equal(passed.key, key); assert.equal(passed.base, base);
  assert.equal(JSON.parse(passed.config).providers.commandcode.settings.apiKey, '{env:VH_EXECUTION_API_KEY}');
  const task = readTask(f.project);
  assert.equal(task.execution.provider, 'commandcode');
  assert.equal(task.execution.modelSource, 'provider-settings');
  assert.equal(task.execution.endpoint, 'https://fixture.invalid');
  const persisted = fs.readFileSync(path.join(f.project, 'out/.vh-chat.log'), 'utf8') + JSON.stringify(task) + result.stdout + result.stderr;
  for (const secret of [key, base, 'private-pass', 'private-query']) assert.equal(persisted.includes(secret), false, 'secret escaped runtime boundary');
});

test('missing selected-provider credentials fail immediately without launching OpenCode', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, 'PROJECT.json'), JSON.stringify({ runner: 'opencode' }));
  delete f.env.VH_RUNNER_MODEL;
  writeSettings({ preferredProvider: 'commandcode', models: {}, bases: {}, keys: {} }, f.home);
  // Ensure no inherited provider env can satisfy this fixture's missing key.
  for (const name of Object.keys(f.env)) if (/COMMANDCODE|OPENCODE_CONFIG_CONTENT|OPENCODE_CONFIG$/.test(name)) delete f.env[name];
  const job = beginTask(f.project, '制作选题', 'topic');
  const result = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId]);
  assert.equal(result.status, 1);
  assert.equal(fs.existsSync(f.capture), false);
  assert.equal(readTask(f.project).status, 'failed');
  assert.equal(readTask(f.project).error.kind, 'credentials');
  assert.equal(taskStatus(f.project).running, false);
});

test('private-session live steering is explicitly unsupported, never sent to the shared service', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.project, 'out'));
  fs.writeFileSync(path.join(f.project, 'out/.vh-runner.json'), JSON.stringify({ sessionId: 'fixture-session', service: 'private' }));
  const result = await createRunner(f.project, { model: 'fixture/model', service: 'private' }).steer({ message: '只改第二场' });
  assert.equal(result.ok, false); assert.equal(result.reason, 'private-session');
  assert.equal(fs.existsSync(f.capture), false);
});

test('local scoped status and worker observations do not require an unrelated video', async t => {
  const f = fixture(t), job = beginTask(f.project, '只补文案', 'edit-copy');
  fs.writeFileSync(path.join(f.project, '发布文案.md'), COPY);
  updateTask(f.project, job.id, { status: 'completed', execution: { runner: 'local' } }, job.attemptId);
  assert.equal(taskStatus(f.project).deliverableStale, null);
  const service = createSnapshotService(); t.after(() => service.close());
  assert.equal((await service.readDelivery(f.project, 'edit-copy')).stale, false);
  fs.writeFileSync(path.join(f.project, '发布文案.md'), 'TODO');
  assert.ok(taskStatus(f.project).deliverableStale);
  assert.equal((await service.readDelivery(f.project, 'edit-copy')).stale, true);
});

/* 真实事故：opencode 中途断线（ECONNRESET），自动重连后把片子做完，
 * 但执行器把那条错误事件永久记成失败，工作台显示"制作失败"，用户不知道发生了什么。 */
test('中途报错后恢复并完成：不判失败，且把恢复过程作为警告报出', t => {
  const f = fixture(t), job = beginTask(f.project, '写一个脚本', 'edit-script');
  const result = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], 'recover');
  assert.equal(result.status, 1, '没有实际改脚本，仍应按未完成处理');
  const task = readTask(f.project);
  assert.notEqual(task.status, 'failed', '中途断线恢复后不应记为制作失败');
  assert.equal(task.error?.kind, 'requirements');
});

test('错误之后没有任何成功动作：仍按失败处理', t => {
  const f = fixture(t), job = beginTask(f.project, '写一个脚本', 'edit-script');
  const out = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], 'fail-last');
  assert.equal(out.status, 1);
  const task = readTask(f.project);
  assert.equal(task.status, 'failed');
  assert.match(task.error.message, /连接|网络/);
});

test('恢复后确实改到作者文件：算完成并保留一条恢复警告', t => {
  const f = fixture(t), job = beginTask(f.project, '按范围补齐这次内容', 'edit-script');
  const out = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], 'recover-script');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const task = readTask(f.project);
  assert.equal(task.status, 'completed');
  assert.equal(task.error, null);
  assert.ok(Array.isArray(task.warnings) && task.warnings.some(item => /恢复/.test(item)), JSON.stringify(task.warnings));
  assert.doesNotMatch(task.warnings.join(' '), /ECONNRESET/, '卡片警告不塞原始错误串');
  assert.equal(taskStatus(f.project).warnings.some(item => /恢复/.test(item)), true, '警告要能到界面上');
});

/* 用 opencode 补文案后一直显示「历史文案尚未关联脚本版本」：
 * 本地执行器在写入钩子里登记，opencode 走原生工具，没人登记。 */
test('OpenCode 写出完整发布文案后自动登记版本，且标记为 agent 而非人工', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, '脚本.md'), SCRIPT);
  const job = beginTask(f.project, '按当前脚本补齐发布文案', 'edit-copy');
  const out = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], 'copy');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const { publishRevision } = awaitImport();
  const revision = publishRevision(f.project);
  assert.equal(revision.state, 'current', '写完完整文案后应已关联当前稿');
  assert.equal(revision.confirmedBy, 'agent');
  assert.match(out.stdout, /已关联当前脚本与文案/);
});

test('文案不完整时不自动登记，也不冒充人工核对', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, '脚本.md'), SCRIPT);
  const job = beginTask(f.project, '按当前脚本补齐发布文案', 'edit-copy');
  const out = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], 'bad-copy');
  const revision = awaitImport().publishRevision(f.project);
  assert.notEqual(revision.state, 'current');
  assert.equal(revision.confirmedBy, null);
});

function awaitImport() {
  // 同步测试里只读一次模块导出，避免顶层 await 破坏 test() 的同步语义。
  return globalThis.__publishModule;
}

test('文案没变时不去"重新关联"，避免把用户手动确认冲掉', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project, '脚本.md'), SCRIPT);
  fs.writeFileSync(path.join(f.project, '发布文案.md'), COPY);
  const { publishRevision, confirmPublishRevision } = publishModule;
  const current = publishRevision(f.project);
  confirmPublishRevision(f.project, { sourceSignature: current.sourceSignature, publishHash: current.publishHash, by: 'user' });
  assert.equal(publishRevision(f.project).confirmedBy, 'user');
  const job = beginTask(f.project, '只讨论，不改文案，只读', 'edit-copy');
  cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId]);
  assert.equal(publishRevision(f.project).confirmedBy, 'user', '用户确认不该被自动流程改写');
  assert.equal(publishRevision(f.project).state, 'current');
});

test('收尾非零但交付齐全：记为完成并给出可读警告，不写成"制作失败"', t => {
  const f = fixture(t);
  // 不预置脚本：本轮必须由执行器写出，才满足"要求有对应改动"。
  const job = beginTask(f.project, '按范围补齐这次内容', 'edit-script');
  const out = cli(f, ['--task-id', job.id, '--attempt-id', job.attemptId], 'exit1-script');
  assert.equal(out.status, 0, out.stdout + out.stderr);
  const task = readTask(f.project);
  assert.equal(task.status, 'completed');
  assert.equal(task.error, null);
  assert.match(task.warnings.join(' '), /收尾时以非零状态结束/);
  assert.doesNotMatch(task.warnings.join(' '), /退出码/, '卡片不该出现裸退出码');
});
