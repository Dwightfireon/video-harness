import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../lib/server.mjs';
import { createProductionViewService } from '../lib/production-view.mjs';
import { productionQuality } from '../lib/production-quality.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';
import { hashFile } from '../lib/artifact-status.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-production-view-')), project = path.join(root, 'projects/a');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true }); fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  let dispatches = 0;
  const server = startServer(project, 0, { root, providerInfo: () => { dispatches++; throw new Error('读取/设置不能请求派发'); } });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, project, url: 'http://127.0.0.1:' + server.address().port, dispatches: () => dispatches };
}
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function sourceFixture(project, profile = 'strict') {
  const subs = [{ s: .2, e: .8, t: '一句话。' }];
  const files = { '脚本.md': '## S1 · 一\n1. 一句话。\n', 'scenes.src.js': 'root=>({render(){}})', 'engine.tpl.html': "const ORIENT = 'landscape';",
    'scene.html': `const DURATION = 1;const SUBS = ${JSON.stringify(subs)};const scenes = []; addScene(0,1,()=>{});`,
    'timing.json': JSON.stringify({ schemaVersion: 1, textHash: digest(['一句话。']), groupsHash: digest([['一句话。']]), measurement: { voice: 'test', speed: 1 }, dur: 1, scenes: [[0, 1]], subs }),
    'timeline.mjs': 'throw new Error("只读核验不得执行作者JS")' };
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(project, name), content);
  fs.writeFileSync(path.join(project, 'out/.vh-state.json'), JSON.stringify({ genStamp: {
    scriptHash: hashFile(path.join(project, '脚本.md')), scenesHash: hashFile(path.join(project, 'scenes.src.js')),
  } }));
  return productionQuality(project, { profile, phase: 'pre-render', checkers: {
    contrast: () => ({ ok: true, sampled: 2, findings: [] }), layout: () => ({ ok: true, sampled: 2, findings: [] }),
    subtitles: () => ({ ok: true, cues: 1, probes: 3, errors: [], failures: [] }),
  } });
}

test('前后端合同：网页默认自动、GET不派发不改作者，设置可保存且不启动任务', async t => {
  const env = await fixture(t), endpoint = env.url + '/_api/production?p=projects%2Fa';
  const before = fs.readFileSync(path.join(env.project, 'PROJECT.json'), 'utf8');
  const response = await fetch(endpoint), view = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(view.automation.enabled, true); assert.equal(view.automation.source, 'web-default');
  assert.equal(view.quality.state, 'not-checked'); assert.equal(view.task.running, false); assert.equal(view.readOnly, true);
  assert.equal(view.workflow.profile, 'content-first'); assert.equal(view.workflow.releaseReviewRequired, false);
  assert.equal(view.quality.profile, 'technical'); assert.match(view.quality.reason, /技术检查/);
  assert.ok(view.quality.optionalChecks.every(check => !check.required && check.state === 'not-run'));
  assert.match(view.quality.note, /可选未运行/);
  assert.equal(fs.readFileSync(path.join(env.project, 'PROJECT.json'), 'utf8'), before);
  const saved = await post(env.url + '/_api/production/settings?p=projects%2Fa', { enabled: true, maxRepairs: 3 });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).automation.maxRepairs, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(env.project, 'PROJECT.json'))).automation, { enabled: true, maxRepairs: 3 });
  assert.equal(env.dispatches(), 0); assert.equal(fs.existsSync(path.join(env.project, 'out/.vh-task.json')), false);
});
test('运行/取消中拒绝改策略和核验；非法项目不能回退，非法参数不产生备份', async t => {
  const env = await fixture(t), settings = env.url + '/_api/production/settings?p=projects%2Fa';
  const original = fs.readFileSync(path.join(env.project, 'PROJECT.json'), 'utf8');
  for (const body of [{ enabled: true, maxRepairs: 6 }, { enabled: 'true', maxRepairs: 2 }, { enabled: true, maxRepairs: 2, run: true }]) {
    assert.equal((await post(settings, body)).status, 400);
  }
  assert.equal(fs.existsSync(path.join(env.project, 'out/.vh-automation-backups')), false);
  const task = beginTask(env.project, '现场', 'article'); updateTask(env.project, task.id, { status: 'running', pid: process.pid }, task.attemptId);
  assert.equal((await post(settings, { enabled: false, maxRepairs: 1 })).status, 409);
  assert.equal((await fetch(env.url + '/_api/production?p=projects%2Fa&verify=1')).status, 409);
  assert.equal((await post(env.url + '/_api/production/settings?p=missing', { enabled: true, maxRepairs: 2 })).status, 404);
  assert.equal(fs.readFileSync(path.join(env.project, 'PROJECT.json'), 'utf8'), original);
  updateTask(env.project, task.id, { status: 'failed', pid: null }, task.attemptId);
});
test('API提供真实修复轮次/失败点但不暴露日志、输入、token；历史通过不冒充实时通过', async t => {
  const env = await fixture(t), task = beginTask(env.project, '私密原文不应进入摘要', 'article');
  updateTask(env.project, task.id, { status: 'paused', automation: { enabled: true, maxRepairs: 2, secret: 'not-public' },
    automationProgress: { used: 2, phase: 'stopped', lastIssue: '版式溢出，Authorization=sk-test-secret', stage: 'render' } }, task.attemptId);
  fs.writeFileSync(path.join(env.project, 'out/.vh-production-quality.json'), JSON.stringify({ ok: true, phase: 'final', at: new Date().toISOString(), checks: [{ id: 'audio', ok: true, status: 'passed', issues: [] }] }));
  const view = await (await fetch(env.url + '/_api/production?p=projects%2Fa')).json();
  assert.equal(view.repair.used, 2); assert.equal(view.repair.phase, 'stopped'); assert.match(view.repair.lastIssue, /版式溢出/);
  assert.equal(view.quality.state, 'unverified');
  const text = JSON.stringify(view); assert.doesNotMatch(text, /私密原文|not-public|sk-test-secret/); assert.equal('tail' in view.task, false);
});
test('显式强核验在worker中只读执行；轮询不重算，修改后成功缓存失效', async t => {
  const env = await fixture(t); assert.equal((await sourceFixture(env.project)).ok, true);
  const endpoint = env.url + '/_api/production?p=projects%2Fa';
  const historical = JSON.parse(fs.readFileSync(path.join(env.project, 'out/.vh-production-quality.json'), 'utf8'));
  delete historical.profile;
  fs.writeFileSync(path.join(env.project, 'out/.vh-production-quality.json'), JSON.stringify(historical));
  const receipt = fs.readFileSync(path.join(env.project, 'out/.vh-production-quality.json'), 'utf8');
  assert.equal((await (await fetch(endpoint)).json()).quality.state, 'unverified');
  const verified = await (await fetch(endpoint + '&verify=1')).json();
  assert.equal(verified.quality.state, 'passed', JSON.stringify(verified)); assert.equal(verified.quality.phase, 'pre-render'); assert.ok(verified.quality.verifiedAt);
  assert.equal(fs.readFileSync(path.join(env.project, 'out/.vh-production-quality.json'), 'utf8'), receipt);
  fs.writeFileSync(path.join(env.project, '脚本.md'), '## S1 · 一\n1. 改过的内容。\n');
  let changed;
  for (let i = 0; i < 20; i++) { changed = await (await fetch(endpoint)).json(); if (changed.quality.state !== 'passed') break; await delay(10); }
  assert.notEqual(changed.quality.state, 'passed');
  assert.equal((await (await fetch(endpoint + '&verify=1')).json()).quality.state, 'stale');
  assert.equal(env.dispatches(), 0);
});

test('actual worker accepts technical receipts for content-first, never for audited strict verification', async t => {
  const env = await fixture(t); assert.equal((await sourceFixture(env.project, 'technical')).ok, true);
  const endpoint = env.url + '/_api/production?p=projects%2Fa&verify=1';
  const content = await (await fetch(endpoint)).json();
  assert.equal(content.quality.state, 'passed', JSON.stringify(content));
  assert.equal(content.quality.profile, 'technical');
  assert.equal(content.quality.optionalChecks.length, 2);
  assert.ok(content.quality.optionalChecks.every(check => check.state === 'not-run' && !check.required));
  assert.equal(content.quality.checks.find(check => check.id === 'subtitles').state, 'passed', 'subtitle visibility remains mandatory');
  fs.writeFileSync(path.join(env.project, 'PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  const audited = await (await fetch(endpoint)).json();
  assert.equal(audited.quality.profile, 'strict'); assert.equal(audited.quality.state, 'stale');
  assert.match(audited.quality.reason, /profile|technical/);
});

test('strong verification explicitly uses workflow quality profile; optional unrun checkers never look passed', async t => {
  const env = await fixture(t);
  fs.writeFileSync(path.join(env.project, 'out/.vh-production-quality.json'), JSON.stringify({ ok: true, profile: 'technical', phase: 'final',
    checks: [{ id: 'audio', ok: true, status: 'passed' }, { id: 'layout', ok: null, status: 'not-run' }] }));
  const calls = [];
  const service = createProductionViewService({ verify: (project, phase, profile) => { calls.push({ project, phase, profile }); return { ok: true }; } });
  t.after(() => service.close());
  const content = await service.read(env.project, { verify: true });
  assert.deepEqual(calls.map(call => [call.phase, call.profile]), [['final', 'technical']]);
  assert.equal(content.quality.state, 'passed'); assert.equal(content.quality.receiptProfile, 'technical');
  assert.equal(content.quality.optionalChecks.find(check => check.id === 'layout').state, 'not-run');
  assert.ok(!content.quality.checks.some(check => check.id === 'layout'));
  fs.writeFileSync(path.join(env.project, 'PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  const audited = await service.read(env.project, { verify: true });
  assert.equal(calls[1].profile, 'strict'); assert.equal(audited.workflow.releaseReviewRequired, true);
  assert.match(audited.quality.profileLabel, /严格/);
  assert.ok(audited.quality.optionalChecks.every(check => check.required));
});
test('并发强核验同项目合并、最多2个项目；输入中途变化不得变绿', async t => {
  const env = await fixture(t); await sourceFixture(env.project);
  const b = path.join(env.root, 'projects/b'), c = path.join(env.root, 'projects/c');
  fs.cpSync(env.project, b, { recursive: true }); fs.cpSync(env.project, c, { recursive: true });
  const gates = []; let calls = 0;
  const service = createProductionViewService({ verify: () => { calls++; return new Promise(resolve => gates.push(resolve)); } }); t.after(() => service.close());
  const first = service.read(env.project, { verify: true }), duplicate = service.read(env.project, { verify: true });
  const second = service.read(b, { verify: true });
  await assert.rejects(service.read(c, { verify: true }), error => error.statusCode === 429);
  await delay(20); assert.equal(calls, 2);
  fs.writeFileSync(path.join(env.project, 'out/.vh-production-quality.json'), '{}');
  gates.forEach(resolve => resolve({ ok: true }));
  const [one, again] = await Promise.all([first, duplicate, second]);
  assert.notEqual(one.quality.state, 'passed'); assert.deepEqual(one, again);
});
