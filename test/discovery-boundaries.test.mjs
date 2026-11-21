import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createDiscoveryAPI } from '../www/discovery-api.mjs';
import { createQueueChanges } from '../www/queue-changes.mjs';
import { prepareDiscoveryRequest, resolveDiscoveryScope } from '../lib/discovery-request.mjs';

test('请求规则独立于HTTP/存储/模型：单条范围一致，输入与历史不变', () => {
  const history = [{ id: 'a', topic: '本地模型能处理哪些文档？', query: '本地模型' }];
  const input = { followupId: 'a', followup: 'different', query: '无关方向', count: 10 };
  const before = JSON.stringify({ input, history });
  const fromHTTP = prepareDiscoveryRequest(input, { count: 5, mode: 'explore', model: 'fixture/model' }, history);
  const fromWorker = resolveDiscoveryScope(input, history);
  for (const value of [fromHTTP, fromWorker]) {
    assert.equal(value.query, '本地模型'); assert.equal(value.count, 1); assert.equal(value.mode, 'focused');
  }
  assert.equal(fromHTTP.model, 'fixture/model');
  assert.equal(JSON.stringify({ input, history }), before);
  assert.deepEqual(prepareDiscoveryRequest({ query: '离线翻译', mode: 'explore', count: 4 }), {
    operation: 'questions', topicId: undefined, query: '离线翻译', mode: 'explore', count: 4, model: null, agent: null, timeoutMs: null, followupId: undefined, followup: undefined,
  });
  for (const invalid of [[], null, { count: 0 }, { followup: 'different' }, { followupId: 'missing', followup: 'different' }]) {
    assert.throws(() => prepareDiscoveryRequest(invalid, {}, history), e => e.statusCode === 400);
  }
});

test('HTTP适配器可注入，无DOM或真实联网；精确保留命令与历史视图', async () => {
  const calls = [], response = { revision: 3 };
  const api = createDiscoveryAPI(async (...args) => { calls.push(args); return response; });
  const view = { historyOffset: 20, historyLimit: 20, historyFilter: 'seen', historyQuery: '具体问题 & 原因' };
  assert.equal(await api.topics(view), response);
  const url = new URL(calls[0][0], 'http://local.test');
  assert.equal(url.pathname, '/_api/schedule/discover/topics');
  assert.equal(url.searchParams.get('historyQuery'), view.historyQuery);
  assert.deepEqual(calls[0][1], { cache: 'no-store' });
  await api.update({ action: 'archive', id: 'a' }, view);
  assert.deepEqual(JSON.parse(calls[1][1].body), { action: 'archive', id: 'a', view });
  await api.search({ followupId: 'a', followup: 'different' });
  assert.deepEqual(JSON.parse(calls[2][1].body), { followupId: 'a', followup: 'different' });
  await api.job();
  assert.deepEqual(calls[3], ['/_api/schedule/discover', { cache: 'no-store' }]);
  const error = Error('adapter error');
  await assert.rejects(createDiscoveryAPI(async () => { throw error; }).search({}), e => e === error);
});

test('队列只通知成员关联变化：订阅可移除、实例隔离、重排和制作状态不误通知', () => {
  const changes = createQueueChanges(), another = createQueueChanges();
  let a = 0, b = 0, isolated = 0;
  const unsubscribe = changes.subscribe(() => a++);
  changes.subscribe(() => b++); another.subscribe(() => isolated++);
  const initial = [{ id: 'a', discoveryId: 'topic-a', state: 'todo' }, { id: 'b' }];
  changes.update(initial);
  changes.update([{ id: 'b' }, { ...initial[0], state: 'running' }]);
  assert.deepEqual([a, b, isolated], [0, 0, 0]);
  changes.update([{ id: 'a', discoveryId: 'topic-a' }]);
  assert.deepEqual([a, b, isolated], [1, 1, 0]);
  unsubscribe(); changes.update([{ id: 'a', discoveryId: 'another-topic' }]);
  assert.deepEqual([a, b, isolated], [1, 2, 0]);
});

test('边界守卫：UI不认识队列DOM/HTTP端点，纯规则不反向引用运行器', () => {
  const panel = fs.readFileSync(new URL('../www/discovery-panel.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(panel, /#queueList|\/_api\/|JSON\.stringify\(\{ \.\.\.body, view/);
  const rules = fs.readFileSync(new URL('../lib/discovery-request.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(rules, /import\s|readSchedule|writeSchedule|spawn\(|fetch\(/);
  const evidence = fs.readFileSync(new URL('../lib/discovery-evidence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(evidence, /readSchedule|writeSchedule|node:|spawn\(|fetch\(/, '材料规则保持纯函数，允许共享纯合同，不依赖运行器');
  const contract = fs.readFileSync(new URL('../lib/topic-contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(contract, /import\s|node:|spawn\(|fetch\(/);
  const schedule = fs.readFileSync(new URL('../lib/schedule.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(schedule, /from ['"].*discovery/);
  const memory = fs.readFileSync(new URL('../lib/topic-memory.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(memory, /node:fs|node:path|readFileSync/);
  const queueChanges = fs.readFileSync(new URL('../www/queue-changes.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(queueChanges, /import\s|attachDiscoveryPanel|querySelector|document\.|fetch\(/);
});
