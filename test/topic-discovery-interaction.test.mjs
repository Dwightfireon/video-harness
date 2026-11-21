import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { discoverTopics } from '../lib/discovery.mjs';
import { topicState, updateTopicState } from '../lib/topic-memory.mjs';
import { readSchedule, writeSchedule } from '../lib/schedule.mjs';
import { startJob, readJob, describeJob, JOB_FILE } from '../lib/discovery-job.mjs';
import { startServer } from '../lib/server.mjs';
import { discoveryFixtureEvents } from './helpers/discovery-fixture.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-topic-interaction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const topic = (id, extra = {}) => ({ id, topic: `题目${id}`, subject: '离线翻译', coreQuestion: `问题${id}`,
  at: 100, query: '原始翻译方向', status: 'candidate', sources: ['https://example.test/source'], ...extra });
const suggestion = (id, parentId, extra = {}) => topic(id, { parentId, followup: 'different', status: 'suggestion', ...extra });
function seed(root, records, extra = {}) {
  writeSchedule(root, { ...readSchedule(root), discoveryTopics: records, ...extra });
}
function stored(root, id) { return readSchedule(root).discoveryTopics.find(record => record.id === id); }

// Never run the real model. All executable inputs, responses and leases stay in the test root.
function fakeModel(t, root, response, { fail = false, gate = false } = {}) {
  const candidates = JSON.parse(discoveryFixtureEvents(response).at(-1).part.text).map(item => ({ ...item,
    question: { version: 1, audience: '普通工具用户', value: '解释具体任务的过程和选择', investigate: ['调查任务过程', '比较条件差异'], premises: [] } }));
  fs.writeFileSync(path.join(root, 'response.json'), JSON.stringify({ events: [{ type: 'text', part: { text: JSON.stringify(candidates) } }], fail, gate }));
  const bin = path.join(root, 'fake-opencode');
  fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const data = JSON.parse(fs.readFileSync('response.json', 'utf8'));
fs.writeFileSync('prompt.txt', process.argv.at(-1));
fs.writeFileSync('started', 'yes');
const start = Date.now();
function run() {
  if (data.gate && !fs.existsSync('release')) {
    if (Date.now() - start > 5000) return process.exit(2);
    return setTimeout(run, 10);
  }
  if (data.fail) return process.exit(2);
  for (const event of data.events) console.log(JSON.stringify(event));
}
run();
`, { mode: 0o755 });
  const old = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = bin;
  t.after(() => { if (old === undefined) delete process.env.VH_OPENCODE_BIN; else process.env.VH_OPENCODE_BIN = old; });
  return {
    async started() {
      const start = Date.now();
      while (!fs.existsSync(path.join(root, 'started'))) {
        if (Date.now() - start > 5000) assert.fail('fake model did not start');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    release: () => fs.writeFileSync(path.join(root, 'release'), 'yes'),
    prompt: () => fs.readFileSync(path.join(root, 'prompt.txt'), 'utf8'),
  };
}

test('single followup forces one base-scoped suggestion, permits same object/core, never autoqueues', async t => {
  const root = fixture(t), base = topic('parent'), other = topic('other');
  seed(root, [base, other], { discoveryConfig: { enabled: true, autoQueue: true, mode: 'explore', query: '全局无关方向', count: 7 } });
  const model = fakeModel(t, root, [topic('new', { coreQuestion: base.coreQuestion }), topic('extra')]);
  const result = await discoverTopics(root, { query: '顶部无关方向', count: 9, followupId: base.id, followup: 'different', origin: 'automatic' });
  assert.equal(result.ok, true);
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.added, []);
  assert.deepEqual(readSchedule(root).items, []);
  const saved = result.results[0];
  assert.equal(saved.parentId, base.id);
  assert.equal(saved.followup, 'different');
  assert.equal(saved.status, 'suggestion');
  assert.equal(saved.mode, 'focused');
  assert.equal(saved.query, base.query);
  assert.deepEqual(stored(root, base.id), base);
  assert.deepEqual(stored(root, other.id), other);
  assert.match(model.prompt(), /最多 1 个候选/);
  assert.match(model.prompt(), /只围绕原题\/对象/);
  assert.match(model.prompt(), /实质改变讲述切口/);
  assert.doesNotMatch(model.prompt(), /顶部无关方向|全局无关方向/);
  assert.deepEqual(topicState(root).candidates.map(item => item.id), [base.id, other.id]);
  assert.equal(topicState(root).suggestions[0].id, saved.id);
  assert.equal(topicState(root).revision, 1);
});

test('followup query falls back to original subject and topic; exact original title remains rejected', async t => {
  for (const base of [topic('parent', { query: '' }), topic('parent', { query: '', subject: '' })]) {
    const root = fixture(t);
    seed(root, [base]);
    fakeModel(t, root, [topic('new')]);
    const result = await discoverTopics(root, { query: '污染方向', count: 8, followupId: base.id, followup: 'deeper' });
    assert.equal(result.results[0].query, base.subject || base.topic);
  }
  const root = fixture(t), base = topic('parent'), old = suggestion('old', base.id);
  seed(root, [base, old]);
  fakeModel(t, root, [{ ...base, difference: '只有相同标题' }]);
  const result = await discoverTopics(root, { followupId: base.id, followup: 'different' });
  assert.equal(result.results.length, 0);
  assert.equal(stored(root, old.id).status, 'suggestion');
});

test('successful new suggestion archives only same parent/type; failed/empty/duplicate outputs preserve pending suggestions', async t => {
  for (const [response, fail] of [[[], false], [[topic('other')], false], [[], true]]) {
    const root = fixture(t), base = topic('parent'), old = suggestion('old', base.id);
    seed(root, [base, old, topic('other')]);
    fakeModel(t, root, response, { fail });
    const result = await discoverTopics(root, { followupId: base.id, followup: 'different' });
    assert.equal(result.results?.length || 0, 0);
    assert.deepEqual(stored(root, old.id), old);
  }
  const root = fixture(t), base = topic('parent');
  const records = [base, topic('other'), suggestion('old', base.id), suggestion('deep', base.id, { followup: 'deeper' }), suggestion('foreign', 'other')];
  seed(root, records);
  fakeModel(t, root, [topic('new')]);
  const result = await discoverTopics(root, { followupId: base.id, followup: 'different' });
  assert.equal(result.results.length, 1);
  assert.equal(stored(root, 'old').status, 'archived');
  assert.equal(stored(root, 'old').archiveReason, 'new-suggestion');
  for (const id of ['parent', 'other', 'deep', 'foreign']) assert.deepEqual(stored(root, id), records.find(record => record.id === id));
});

test('adopt only changes target and original; adopted request is idempotent even after later actions', t => {
  const root = fixture(t), records = [topic('parent'), topic('other'), suggestion('pick', 'parent'), suggestion('stay', 'other')];
  seed(root, records);
  const adopted = updateTopicState(root, { action: 'adopt', id: 'pick', replace: true });
  assert.equal(adopted.updated.status, 'candidate');
  assert.equal(adopted.updated.parentId, 'parent');
  assert.equal(stored(root, 'parent').status, 'superseded');
  assert.equal(stored(root, 'parent').placement, 'history');
  assert.equal(stored(root, 'parent').replacedBy, 'pick');
  assert.deepEqual(stored(root, 'other'), records[1]);
  assert.deepEqual(stored(root, 'stay'), records[3]);
  assert.deepEqual(adopted.candidates.map(item => item.id), ['other', 'pick']);
  updateTopicState(root, { action: 'archive', id: 'pick' });
  const before = readSchedule(root).discoveryTopics;
  updateTopicState(root, { action: 'adopt', id: 'pick', replace: true });
  assert.deepEqual(readSchedule(root).discoveryTopics, before);
  updateTopicState(root, { action: 'restore', id: 'parent' });
  assert.equal(stored(root, 'parent').status, 'candidate');
  assert.equal(stored(root, 'pick').status, 'archived', 'restoring parent does not change adopted suggestion');
});

test('replace refuses changed parent, preserves suggestion; save separately and neutral dismissal do not mutate parent', t => {
  for (const patch of [{ status: 'queued', queueId: 'old-queue' }, { feedback: { kind: 'seen' } }, { status: 'superseded', placement: 'history' }]) {
    const root = fixture(t), parent = topic('parent', patch), proposed = suggestion('pick', parent.id);
    seed(root, [parent, proposed]);
    assert.throws(() => updateTopicState(root, { action: 'adopt', id: 'pick', replace: true }), { statusCode: 409 });
    assert.deepEqual(stored(root, 'pick'), proposed);
    updateTopicState(root, { action: 'adopt', id: 'pick', replace: false });
    assert.deepEqual(stored(root, 'parent'), parent);
    assert.equal(stored(root, 'pick').status, 'candidate');
  }
  const root = fixture(t), parent = topic('parent'), proposed = suggestion('pick', parent.id, { followup: 'deeper' });
  seed(root, [parent, proposed]);
  updateTopicState(root, { action: 'dismiss-suggestion', id: 'pick' });
  assert.equal(stored(root, 'pick').status, 'archived');
  assert.equal(stored(root, 'pick').feedback, undefined);
  assert.deepEqual(stored(root, 'parent'), parent);
  seed(root, [parent, suggestion('queued-link', parent.id)], { items: [{ id: 'current-queue', topic: parent.topic, discoveryId: parent.id }] });
  assert.throws(() => updateTopicState(root, { action: 'adopt', id: 'queued-link', replace: true }), { statusCode: 409 }, 'current discoveryId link also protects original');
});

test('search merges latest state, retains unknown queue properties, then concurrent parent changes block replace', async t => {
  const root = fixture(t), parent = topic('parent'), other = topic('other');
  seed(root, [parent, other]);
  const fake = fakeModel(t, root, [topic('new')], { gate: true });
  const task = discoverTopics(root, { followupId: parent.id, followup: 'different' });
  await fake.started();
  const accepted = updateTopicState(root, { action: 'accept', id: parent.id });
  const queue = readSchedule(root);
  queue.items[0].customUserTask = { keep: true };
  queue.publish.custom = 'retain';
  queue.discoveryConfig = { query: '用户刚改的方向' };
  writeSchedule(root, queue);
  fake.release();
  const result = await task;
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'));
  assert.equal(saved.items[0].id, accepted.item.id);
  assert.deepEqual(saved.items[0].customUserTask, { keep: true });
  assert.equal(saved.publish.custom, 'retain');
  assert.equal(saved.discoveryConfig.query, '用户刚改的方向');
  assert.equal(topicState(root).revision, 2);
  assert.throws(() => updateTopicState(root, { action: 'adopt', id: result.results[0].id, replace: true }), { statusCode: 409 });
  assert.equal(stored(root, result.results[0].id).status, 'suggestion');
  updateTopicState(root, { action: 'preferences', notes: '保持队列属性' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8')).items[0].customUserTask, { keep: true });
});

test('history pagination/search/counts are independent of candidate limit; GET never writes', t => {
  const root = fixture(t);
  const history = Array.from({ length: 27 }, (_, i) => topic(`history-${i}`, { at: i, status: 'archived', placement: 'history', coreQuestion: `检索词${i}` }));
  history[3].feedback = { kind: 'seen', reason: '独特原因', note: '独特备注' };
  seed(root, [topic('candidate-a'), topic('candidate-b'), suggestion('suggestion-a', 'history-0'), ...history], { discoveryRevision: 12 });
  const before = fs.readFileSync(path.join(root, 'schedule.json'), 'utf8');
  const first = topicState(root, { limit: 1 });
  assert.equal(first.topics.length, 1);
  assert.equal(first.candidates.length, 2);
  assert.equal(first.suggestions.length, 1);
  assert.equal(first.history.length, 20);
  assert.equal(first.historyTotal, 27);
  assert.equal(first.historyNextOffset, 20);
  assert.equal(topicState(root, { historyOffset: 999 }).historyOffset, 20, '超出末页时夹到最后有效页');
  assert.equal(first.total, 30);
  assert.equal(first.feedbackCount, 1);
  assert.equal(first.revision, 12);
  const tail = topicState(root, { historyOffset: 20, historyLimit: 10 });
  assert.equal(tail.history.length, 7);
  assert.equal(tail.historyNextOffset, null);
  assert.equal(tail.suggestions.length, 1, 'suggestions survive parent being outside current history page');
  for (const query of ['检索词3', '独特原因', '独特备注', '题目history-3']) {
    const result = topicState(root, { historyQuery: query });
    assert.equal(result.historyTotal, 1);
    assert.equal(result.history[0].id, 'history-3');
  }
  assert.equal(topicState(root, { historyFilter: 'seen' }).historyTotal, 1);
  assert.equal(topicState(root, { historyLimit: 200, historyOffset: -1 }).historyLimit, 100);
  assert.equal(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'), before);
  const response = updateTopicState(root, { action: 'archive', id: 'candidate-a', view: { historyOffset: 20, historyLimit: 5, historyFilter: 'archived', historyQuery: '题目' } });
  assert.equal(response.historyOffset, 20);
  assert.equal(response.historyLimit, 5);
  assert.equal(response.historyFilter, 'archived');
  assert.equal(response.historyQuery, '题目');
  assert.equal(response.updated.id, 'candidate-a');
});

test('removed queue records remain history; explicit requeue differs from stale accept and is idempotent', t => {
  const root = fixture(t);
  seed(root, [topic('pick'), topic('plain')], { runs: [{ id: 'legacy-run', topic: '旧制作记录' }] });
  const first = updateTopicState(root, { action: 'accept', id: 'pick' });
  assert.equal(first.updated.inQueue, true);
  assert.equal(first.updated.queueState, 'present');
  const queue = readSchedule(root); queue.items = []; writeSchedule(root, queue);
  const removed = topicState(root).history.find(item => item.id === 'pick');
  assert.equal(removed.inQueue, false);
  assert.equal(removed.queueState, 'removed');
  assert.equal(topicState(root).history.find(item => item.id === 'legacy-legacy-run').queueState, 'legacy');
  updateTopicState(root, { action: 'accept', id: 'pick' });
  assert.equal(readSchedule(root).items.length, 0);
  const again = updateTopicState(root, { action: 'requeue', id: 'pick' });
  assert.notEqual(again.item.id, first.item.id);
  assert.equal(again.updated.queueState, 'present');
  assert.equal(updateTopicState(root, { action: 'requeue', id: 'pick' }).item.id, again.item.id);
  assert.equal(readSchedule(root).items.length, 1);
  assert.throws(() => updateTopicState(root, { action: 'requeue', id: 'plain' }), { statusCode: 409 });
  assert.equal(topicState(root, { historyFilter: 'queued' }).historyTotal, 2);
});

test('feedback clearing never revives neutral/explicit history or queued records; legacy single clear may restore', t => {
  const root = fixture(t);
  seed(root, [topic('neutral'), topic('old-seen', { status: 'seen', feedback: { kind: 'seen' } }),
    topic('explicit', { status: 'dismissed', placement: 'history', feedback: { kind: 'not-interested' } }),
    topic('queued', { status: 'seen', queueId: 'removed', feedback: { kind: 'seen' } })]);
  updateTopicState(root, { action: 'archive', id: 'neutral' });
  updateTopicState(root, { action: 'clear-feedback' });
  assert.equal(stored(root, 'neutral').status, 'archived');
  assert.equal(stored(root, 'old-seen').status, 'seen', 'bulk clear must not revive old history');
  assert.equal(stored(root, 'explicit').status, 'dismissed');
  updateTopicState(root, { action: 'clear-feedback', id: 'old-seen' });
  assert.equal(stored(root, 'old-seen').status, 'candidate');
  updateTopicState(root, { action: 'clear-feedback', id: 'explicit' });
  assert.equal(stored(root, 'explicit').status, 'dismissed');
  const queued = updateTopicState(root, { action: 'clear-feedback', id: 'queued' });
  assert.equal(queued.updated.status, 'queued');
  assert.equal(queued.updated.queueState, 'removed');
  assert.equal(queued.feedbackCount, 0);
});

test('jobs retain single-operation parent fields and describe a suggestion, not a batch replacement', t => {
  const root = fixture(t);
  const started = startJob(root, { query: '原题', count: 8, followupId: 'parent', followup: 'different' }, { spawnImpl: () => ({ pid: process.pid, on() {}, unref() {} }) });
  assert.equal(started.job.count, 1);
  assert.equal(started.job.followupId, 'parent');
  assert.equal(started.job.followup, 'different');
  assert.match(describeJob(started.job).text, /这条选题.*不同切口/);
  assert.match(describeJob({ ...started.job, state: 'done', results: [topic('new')] }).text, /未自动替换或入队/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, JOB_FILE), 'utf8')).followupId, 'parent');
});

test('HTTP validates and forces base-scoped count/query/mode; supports history view and conflict status', async t => {
  const root = fixture(t), parent = topic('parent');
  seed(root, [parent, suggestion('suggestion', parent.id), topic('history', { status: 'archived', placement: 'history' })],
    { discoveryConfig: { query: '全局方向', mode: 'explore', count: 7 } });
  const fake = fakeModel(t, root, [topic('new'), topic('extra')], { gate: true });
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const server = startServer(null, 0, { root, home, providerInfo: () => [] });
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}/_api/schedule/discover`;
  const post = async (endpoint, input) => {
    const res = await fetch(base + endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await post('', { followupId: 'missing', followup: 'different', count: 8 })).status, 400);
  assert.equal((await post('', { followupId: 'parent', followup: 'invalid' })).status, 400);
  const started = await post('', { followupId: parent.id, followup: 'different', count: 8, query: '顶部无关方向' });
  assert.equal(started.status, 202);
  assert.equal(started.body.job.count, 1);
  assert.equal(started.body.job.query, parent.query);
  assert.equal(started.body.job.mode, 'focused');
  assert.equal(started.body.job.followupId, parent.id);
  await fake.started();
  const state = await (await fetch(base + '/topics?historyLimit=1&historyOffset=0&historyFilter=archived&historyQuery=history')).json();
  assert.equal(state.historyLimit, 1);
  assert.equal(state.historyTotal, 1);
  await post('/topics', { action: 'feedback', id: 'parent', kind: 'seen' });
  const conflict = await post('/topics', { action: 'adopt', id: 'suggestion', replace: true });
  assert.equal(conflict.status, 409);
  assert.equal(stored(root, 'suggestion').status, 'suggestion');
  fake.release();
  const deadline = Date.now() + 5000;
  while (readJob(root)?.state === 'running') {
    if (Date.now() > deadline) assert.fail('test-owned discovery job did not finish');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(readJob(root).state, 'done');
  assert.equal(readJob(root).results.length, 1);
  assert.equal(readJob(root).results[0].parentId, parent.id);
});
