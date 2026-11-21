import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { productionFailure, productionRepairRecovery, applyRepairExtensions, productionRepairWork, stoppedProductionFailure } from '../lib/automation.mjs';
import { beginTask, updateTask, readTask, resumeTask, taskStatus, validateRepairExtension } from '../lib/task-status.mjs';
import { writeCheckpoint, readCheckpoint, checkpointPath } from '../lib/checkpoint.mjs';
import { startServer } from '../lib/server.mjs';
import { readEditFile } from '../lib/author-edits.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-repair-extension-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'out')); fs.writeFileSync(path.join(root, 'PROJECT.json'), '{}');
  return root;
}
function exhausted(limit = 2, reason = 'FAIL 版式溢出：LAST-LAYOUT', stage = 'render') {
  let ledger = {};
  for (let i = 0; i < limit; i++) ledger = productionFailure(ledger, { stage: 'measure', reason: 'FAIL 结构：OLD-BODY', sourceSignature: 's' + i, maxRepairs: limit });
  return productionFailure(ledger, { stage, reason, sourceSignature: 'stopped-input', maxRepairs: limit });
}
function seed(project, { limit = 2, reason, stage } = {}) {
  const task = beginTask(project, '完成当前片子', 'article');
  updateTask(project, task.id, { automation: { enabled: true, maxRepairs: limit } }, task.attemptId);
  writeCheckpoint(project, { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId, mode: task.mode, status: 'paused',
    messages: [{ role: 'user', content: task.message }], pending: [], automation: { enabled: true, maxRepairs: limit },
    pipelineState: { productionRepairs: exhausted(limit, reason, stage) } });
  updateTask(project, task.id, { status: 'paused', pausedReason: '预算已用尽' }, task.attemptId);
  return task;
}
const extension = (task, additionalRepairs = 2) => ({ additionalRepairs, taskId: task.id, attemptId: task.attemptId });

test('追加只作用于当前任务，保留完整历史/作者文件，重放授权不重复计数；以最后实际错误修复', t => {
  const project = fixture(t), task = seed(project);
  fs.writeFileSync(path.join(project, '脚本.md'), '作者原稿');
  const before = readCheckpoint(project, task.id), old = before.pipelineState.productionRepairs;
  assert.deepEqual(taskStatus(project).repairRecovery, { blocked: true, canExtend: true, additionalRepairs: 2, used: 2, limit: 2, targetLimit: 4 });
  const next = resumeTask(project, '', extension(task));
  assert.equal(next.id, task.id); assert.notEqual(next.attemptId, task.attemptId);
  assert.equal(next.automation.maxRepairs, 4); assert.equal(next.repairExtensions.length, 1);
  assert.equal(next.repairExtensions[0].attemptId, task.attemptId);
  assert.deepEqual(readCheckpoint(project, task.id), before, '授权不重写检查点');
  const armed = applyRepairExtensions(old, next.repairExtensions, next.automation);
  assert.deepEqual(armed.history.slice(0, 2), old.history); assert.equal(armed.history.length, 3);
  assert.equal(armed.stop, null); assert.equal(armed.pending.stage, 'render');
  assert.match(productionRepairWork(armed).note, /LAST-LAYOUT/);
  assert.doesNotMatch(productionRepairWork(armed).note, /OLD-BODY/);
  assert.deepEqual(applyRepairExtensions(armed, next.repairExtensions, next.automation), armed);
  assert.equal(fs.readFileSync(path.join(project, '脚本.md'), 'utf8'), '作者原稿');
  assert.equal(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8'), '{}');
  assert.equal(taskStatus(project).repairRecovery, undefined, '运行时不暴露暂停追加动作');
});

test('旧停止记录从 stop 原文提取真实阶段，绝不回退到 history 旧主体错误', () => {
  const ledger = exhausted(); delete ledger.stoppedStage; delete ledger.stoppedReason;
  ledger.stop = '自动修复已达到 2 轮上限；保留现场，不降低质量门槛：exit=1\n阶段 render；完整日志 out/fake.log\nFAIL 版式溢出 LEGACY-LAST';
  assert.equal(stoppedProductionFailure(ledger).stage, 'render');
  assert.match(stoppedProductionFailure(ledger).reason, /LEGACY-LAST/);
  assert.doesNotMatch(stoppedProductionFailure(ledger).reason, /OLD-BODY/);
  const armed = applyRepairExtensions(ledger, [{ id: 'legacy-authorization', fromLimit: 2, toLimit: 4, additionalRepairs: 2 }], { enabled: true, maxRepairs: 4 });
  assert.match(productionRepairWork(armed).note, /LEGACY-LAST/);
  ledger.stop = '自动修复已达到 2 轮上限；保留现场，不降低质量门槛：FAIL 无实际阶段';
  assert.equal(stoppedProductionFailure(ledger), null);
});

test('非法追加、陈旧身份、非预算/环境/未知/坏检查点全部拒绝且任务/检查点不变', t => {
  const project = fixture(t), task = seed(project);
  const taskFile = path.join(project, 'out/.vh-task.json'), cpFile = checkpointPath(project, task.id);
  const assertRefusal = input => {
    const a = fs.readFileSync(taskFile, 'utf8'), b = fs.readFileSync(cpFile, 'utf8');
    assert.throws(() => resumeTask(project, '', input));
    assert.equal(fs.readFileSync(taskFile, 'utf8'), a); assert.equal(fs.readFileSync(cpFile, 'utf8'), b);
  };
  for (const additionalRepairs of [0, 3, 6, -1, 1.5, '2', null, true]) assertRefusal(extension(task, additionalRepairs));
  assertRefusal({ ...extension(task), extra: true });
  assertRefusal({ ...extension(task), taskId: 'stale' });
  assertRefusal({ ...extension(task), attemptId: 'stale' });
  assertRefusal({ additionalRepairs: 2 });
  const original = fs.readFileSync(cpFile, 'utf8');
  for (const reason of ['ENOSPC 空间不足', 'exit=23']) {
    const cp = JSON.parse(original); cp.pipelineState.productionRepairs = exhausted(2, reason);
    fs.writeFileSync(cpFile, JSON.stringify(cp)); assertRefusal(extension(task)); assert.equal(taskStatus(project).repairRecovery, undefined);
  }
  const cp = JSON.parse(original); cp.pipelineState.productionRepairs = productionFailure({}, { stage: 'render', reason: 'FAIL 溢出', sourceSignature: 'x', maxRepairs: 2 });
  fs.writeFileSync(cpFile, JSON.stringify(cp)); assertRefusal(extension(task));
  fs.writeFileSync(cpFile, '{broken'); assertRefusal(extension(task));
  fs.writeFileSync(cpFile, original);
  for (const mutate of [cp => { cp.attemptId = 'stale'; }, cp => { cp.status = 'completed'; },
    cp => { cp.uncertainCommands = ['unknown side effect']; }, cp => { cp.pipelineState.productionRepairs.history[0] = {}; }]) {
    const cp = JSON.parse(original); mutate(cp); fs.writeFileSync(cpFile, JSON.stringify(cp)); assertRefusal(extension(task));
  }
  fs.writeFileSync(cpFile, original);
  const marker = path.join(project, 'out/.vh-run.json');
  fs.writeFileSync(marker, JSON.stringify({ taskId: task.id, attemptId: task.attemptId, pid: 2147483647, childPid: process.pid }));
  assert.equal(taskStatus(project).orphanRunning, true);
  assertRefusal(extension(task)); fs.unlinkSync(marker);
  updateTask(project, task.id, { status: 'cancelling', cancellation: { taskId: task.id, attemptId: task.attemptId, pids: [], childPids: [] } });
  assertRefusal(extension(task));
  updateTask(project, task.id, { cancellation: null });
  for (const status of ['running', 'cancelling', 'cancelled', 'failed', 'completed']) {
    updateTask(project, task.id, { status, pid: status === 'running' ? process.pid : null });
    assertRefusal(extension(task));
  }
});

test('五轮硬上限、四轮只可追加一轮，普通继续不增加预算', t => {
  const project = fixture(t), task = seed(project, { limit: 4 });
  assert.deepEqual(taskStatus(project).repairRecovery, { blocked: true, canExtend: true, additionalRepairs: 1, used: 4, limit: 4, targetLimit: 5 });
  assert.throws(() => validateRepairExtension(project, extension(task, 2)), /5 轮/);
  assert.equal(validateRepairExtension(project, extension(task, 1)).automation.maxRepairs, 5);
  const before = readCheckpoint(project, task.id);
  const resumed = resumeTask(project);
  assert.equal(resumed.automation.maxRepairs, 4); assert.equal(resumed.repairExtensions, undefined);
  assert.deepEqual(readCheckpoint(project, task.id), before);
  const other = fixture(t); seed(other, { limit: 5 });
  assert.deepEqual(taskStatus(other).repairRecovery, { blocked: true, canExtend: false, additionalRepairs: 0, used: 5, limit: 5, targetLimit: 5 });
});

async function until(predicate, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (predicate()) return; await delay(25); }
  throw new Error('worker fixture timeout');
}

test('HTTP→真实 CLI worker 两轮耗尽→普通继续仍暂停→授权追加→先请求修最后版式错误而非重跑阶段', { timeout: 30000 }, async t => {
  const root = fixture(t), project = path.join(root, 'projects/work'), home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  const originalMetadata = '{"deliveryTarget":"video","automation":{"enabled":true,"maxRepairs":2}}';
  for (const [name, content] of Object.entries({ 'PROJECT.json': originalMetadata, '方案.md': '方案', 'claims.json': '[]',
    '脚本.md': '## S1 · 一\n1. 展示一个窗口。\n', 'scenes.src.js': 'root => { const label = 0; return {render(){}}; }',
    'engine.tpl.html': "const ORIENT = 'landscape';", 'scene.html': 'const DURATION = 2; const scenes = []; addScene(0,2,()=>{});',
    'gen.mjs': `import fs from 'node:fs';fs.appendFileSync('out/build-attempts.txt','x');const src=fs.readFileSync('scenes.src.js','utf8');const n=Number(src.match(/label = (\\d+)/)[1]);console.error(n<2?'FAIL 结构 OLD-BODY':'FAIL 版式溢出 LAST-LAYOUT');process.exit(7);`
  })) fs.writeFileSync(path.join(project, name), content);
  const requests = [], buildCounts = [], requestErrors = [];
  const model = http.createServer((req, res) => {
    let raw = ''; req.on('data', data => { raw += data; }); req.on('end', () => {
      try {
        if (!fs.existsSync(path.join(project, 'out/build-attempts.txt'))) {
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
            tool_calls: [{ id: 'initial-build', type: 'function', function: { name: 'run_stage', arguments: '{"stage":"build"}' } }]
          }, finish_reason: 'tool_calls' }] })); return;
        }
        const input = JSON.parse(raw);
        requests.push(input); buildCounts.push(fs.readFileSync(path.join(project, 'out/build-attempts.txt'), 'utf8').length);
        const current = readEditFile(project, 'scenes.src.js'), n = Number(current.content.match(/label = (\d+)/)[1]);
        const calls = [{ id: 'patch-' + requests.length, type: 'function', function: { name: 'patch_text', arguments: JSON.stringify({
          path: 'scenes.src.js', base_hash: current.base_hash, find: 'label = ' + n, replace: 'label = ' + (n + 1), expected_count: 1 }) } }];
        if (input.tools?.some(tool => tool.function?.name === 'finish_repair')) calls.push({ id: 'finish-' + requests.length, type: 'function', function: { name: 'finish_repair', arguments: '{}' } });
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
          tool_calls: calls
        }, finish_reason: 'tool_calls' }] }));
      } catch (error) { requestErrors.push(error); res.writeHead(500); res.end('{}'); }
    });
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), JSON.stringify({ provider: { opendesign: { options: { baseURL: 'http://127.0.0.1:' + model.address().port } } } }));
  const server = startServer(project, 0, { root, providerInfo: () => [{ provider: 'opendesign' }],
    agentEnv: { ...process.env, HOME: home, OPEN_DESIGN_API_KEY: 'fixture-only' } });
  await once(server, 'listening');
  t.after(async () => {
    const task = readTask(project); if (task?.pid && taskStatus(project).running) { try { process.kill(-task.pid, 'SIGKILL'); } catch {} }
    server.closeAllConnections(); model.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => model.close(r))]);
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (route, body) => fetch(base + route + '?p=projects%2Fwork', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const paused = () => readTask(project)?.status === 'paused' && taskStatus(project).canResume;
  const waitPaused = async () => {
    try { await until(paused); }
    catch (error) { throw new Error(error.message + '\n' + JSON.stringify(readTask(project)) + '\n' + fs.readFileSync(path.join(project, 'out/.vh-chat.log'), 'utf8')); }
  };
  assert.equal((await post('/_api/chat', { message: '完成当前视频', mode: 'article' })).status, 200);
  await waitPaused();
  const first = readTask(project), firstLedger = readCheckpoint(project, first.id).pipelineState.productionRepairs;
  assert.equal(requests.length, 2); assert.equal(firstLedger.history.length, 2); assert.equal(buildCounts.at(-1), 2);
  assert.match(firstLedger.stoppedReason, /LAST-LAYOUT/); assert.match(firstLedger.history.at(-1).reason, /OLD-BODY/);
  const ordinary = await post('/_api/chat/resume'); assert.equal(ordinary.status, 200, await ordinary.text());
  await waitPaused(); assert.equal(requests.length, 2);
  assert.equal(readTask(project).automation.maxRepairs, 2);
  const current = readTask(project), beforeReject = fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8');
  for (const body of ['{broken', 'null', '[]', { additionalRepairs: 3 }, { ...extension(current), attemptId: 'stale' }]) {
    assert.ok([400, 409].includes((await post('/_api/chat/resume', body)).status));
    assert.equal(fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8'), beforeReject);
  }
  const authorized = await post('/_api/chat/resume', extension(current)); assert.equal(authorized.status, 200, await authorized.text());
  await waitPaused();
  assert.deepEqual(requestErrors, []); assert.equal(requests.length, 4, JSON.stringify(readTask(project)) + '\n' + fs.readFileSync(path.join(project, 'out/.vh-chat.log'), 'utf8')); assert.equal(buildCounts[2], 3, '追加后先修复，不先重跑 build/measure');
  const repairTail = requests[2].messages.at(-1).content;
  assert.match(repairTail, /自动修复第 3 轮.*阶段 build 的实际问题：[\s\S]*LAST-LAYOUT/);
  const latest = readTask(project), ledger = readCheckpoint(project, latest.id).pipelineState.productionRepairs;
  assert.equal(latest.id, first.id); assert.equal(latest.automation.maxRepairs, 4); assert.equal(latest.repairExtensions.length, 1);
  assert.equal(ledger.history.length, 4); assert.deepEqual(ledger.history.slice(0, 2), firstLedger.history);
  assert.match(fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'), /label = 4/);
  assert.equal(fs.readFileSync(path.join(project, 'PROJECT.json'), 'utf8'), originalMetadata);
  assert.deepEqual(taskStatus(project).repairRecovery, { blocked: true, canExtend: true, additionalRepairs: 1, used: 4, limit: 4, targetLimit: 5 });
  const again = await post('/_api/chat/resume'); assert.equal(again.status, 200, await again.text());
  await waitPaused(); assert.equal(requests.length, 4); assert.equal(readTask(project).automation.maxRepairs, 4, '网页普通继续不能覆盖追加后的 active policy');
  const last = await post('/_api/chat/resume', extension(readTask(project), 1)); assert.equal(last.status, 200, await last.text());
  await waitPaused();
  assert.equal(requests.length, 5); assert.equal(readTask(project).repairExtensions.length, 2);
  assert.equal(readCheckpoint(project, first.id).pipelineState.productionRepairs.history.length, 5);
  assert.deepEqual(taskStatus(project).repairRecovery, { blocked: true, canExtend: false, additionalRepairs: 0, used: 5, limit: 5, targetLimit: 5 });
  const capped = fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8');
  assert.equal((await post('/_api/chat/resume', extension(readTask(project), 1))).status, 409);
  assert.equal(fs.readFileSync(path.join(project, 'out/.vh-task.json'), 'utf8'), capped);
});
