import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../lib/server.mjs';
import { taskStatus } from '../lib/task-status.mjs';
import { beginTask, updateTask } from '../lib/task-status.mjs';

const HOME = process.env.HOME || '';

/* 真实事故：任务中断后点「继续任务」+ 切渠道，用户看不到任何变化，
 * 以为"两个都没起作用"。真实原因有两类，都必须能被看见：
 *   1. 渠道确实切了，但没有显示"这次用哪个渠道" → 看起来像没切；
 *   2. 界面把旧卡片留在 DOM 里，Map 与 DOM 脱节 → 重复卡片、按钮点不动。
 * 本文件测后端能提供"本次用的渠道"，以及任务状态能带出渠道。 */

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-chan-'));
  const proj = path.join(root, 'projects', 'demo');
  fs.mkdirSync(path.join(proj, 'out'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'PROJECT.json'), '{}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, proj, rel: 'projects/demo' };
}

test('任务状态带出"本次用的渠道"，界面上才看得出切换是否生效', async t => {
  const { proj } = project(t);
  const task = beginTask(proj, '做一支片', 'article');
  updateTask(proj, task.id, { status: 'failed', finishedAt: Date.now() }, task.attemptId);
  // agent 跑完后会把实际用的渠道写进 state
  fs.writeFileSync(path.join(proj, 'out', '.vh-state.json'), JSON.stringify({
    agent: { provider: 'opencode-go', model: 'minimax-m3.1-flash-free' },
  }));
  const status = taskStatus(proj);
  assert.equal(status.status, 'failed');
  assert.equal(status.provider, 'opencode-go / minimax-m3.1-flash-free');
  assert.equal(status.canResume, true, '失败且有检查点时应可继续');
});

test('agent-ready 接口同时给出当前选择与是否就绪', async t => {
  const { root, rel } = project(t);
  const server = startServer(root, 0, { root, home: path.join(root, 'home') });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const ready = await (await fetch(base + '/_api/agent-ready')).json();
  assert.ok('ready' in ready);
  assert.ok('current' in ready, '必须带当前渠道，前端才能显示"这次用哪个"');
  assert.equal(ready.current.provider, 'opendesign', '没设置过就用默认渠道');
});

test('切换渠道后读取到的就是新渠道（继续任务会用它）', async t => {
  const { root } = project(t);
  const home = path.join(root, 'home');
  const server = startServer(root, 0, { root, home });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const selected = await (await fetch(base + '/_api/provider/select', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'commandcode' }) })).json();
  assert.equal(selected.current.provider, 'commandcode');
  const listed = await (await fetch(base + '/_api/providers')).json();
  assert.equal(listed.current.provider, 'commandcode');
  assert.equal(listed.providers.find(p => p.name === 'commandcode').selected, true);
});

test('切换到没有凭证的渠道不会被静默换回别的渠道', async t => {
  const { root } = project(t);
  const home = path.join(root, 'home');
  const server = startServer(root, 0, { root, home });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  await (await fetch(base + '/_api/provider/select', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: '9router' }) }));
  // 用与 agent 相同的设置来源判断（显式注入 home 对应的设置）。
  const { readSettings } = await import('../lib/provider-settings.mjs');
  const { buildCandidates } = await import('../lib/agent.mjs');
  const settings = readSettings(home);
  assert.equal(settings.preferredProvider, '9router');
  const candidates = buildCandidates({ settings });
  assert.equal(candidates.length, 0, '缺凭证就该停下，不能悄悄用别的渠道');
});

/* 真实事故：额度不足（402）时请求直接失败，onSuccess 不触发，
 * state 里的渠道停在"上一次成功"的那个。用户切了渠道却看到旧渠道名，
 * 以为切换没生效。 */
test('执行一开始就记录所用渠道：请求失败也不会停在旧渠道', async t => {
  const { proj } = project(t);
  const { runAgent } = await import('../lib/agent.mjs');
  const { ProviderRequestError } = await import('../lib/provider-pool.mjs');
  const providers = [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture', model: 'deepseek-v4.1-flash' }];
  const result = await runAgent(proj, '做一支片', { taskId: 'ch', mode: 'article', providers,
    request: async () => { throw new ProviderRequestError('quota', { status: 402 }); } });
  assert.equal(result.status, 'failed');
  const st = JSON.parse(fs.readFileSync(path.join(proj, 'out', '.vh-state.json'), 'utf8'));
  assert.equal(st.agent.provider, 'opendesign', '失败也必须记下这次用的渠道');
  assert.ok(st.agent.model, '模型也要记下');
});

test('旧渠道与新渠道不同时，状态里明确标出"切了但还没重新执行"', async t => {
  const { proj } = project(t);
  const task = beginTask(proj, '做一支片', 'article');
  updateTask(proj, task.id, { status: 'failed', finishedAt: Date.now() }, task.attemptId);
  fs.writeFileSync(path.join(proj, 'out', '.vh-state.json'), JSON.stringify({
    agent: { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' },
  }));
  // 当前设置选的是 opencode-go（写进真实的 home 设置文件）
  const settingsPath = path.join(HOME, '.config', 'video-harness', 'providers.json');
  const backup = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : null;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify({ preferredProvider: 'opencode-go', models: {}, bases: {}, keys: {} }), { mode: 0o600 });
  t.after(() => {
    if (backup != null) fs.writeFileSync(settingsPath, backup, { mode: 0o600 });
    else fs.rmSync(settingsPath, { force: true });
  });
  const status = taskStatus(proj);
  assert.equal(status.usedProvider, 'commandcode');
  assert.equal(status.selectedProvider, 'opencode-go');
  assert.equal(status.channelMismatch, true, '必须提示：切了渠道但还没重新执行');
});
