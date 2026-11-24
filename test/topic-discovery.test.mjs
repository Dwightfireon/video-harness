import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoveryPrompt, discoverTopics, filterCandidates } from '../lib/discovery.mjs';
import { topicState, updateTopicState, feedbackContext } from '../lib/topic-memory.mjs';
import { readSchedule, writeSchedule, addTopic, removeItem, removeItems, sourceURLs, topicBrief } from '../lib/schedule.mjs';
import { startJob, readJob, describeJob, JOB_FILE } from '../lib/discovery-job.mjs';
import { startServer } from '../lib/server.mjs';
import { discoveryFixtureEvents } from './helpers/discovery-fixture.mjs';

const runner = fileURLToPath(new URL('../scripts/discover-topics.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-topic-discovery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function candidate(topic = '离线翻译怎么处理生词', extra = {}) {
  return { topic, subject: '离线翻译', coreQuestion: '离线翻译如何处理没有见过的生词',
    why: '理解生词处理的边界', outline: '先看一次翻译过程，再对比词典与模型的处理。',
    difference: '关注生词而非速度', angle: '机制', sources: ['https://source.test/translation'], ...extra };
}

function record(id, extra = {}) {
  return { ...candidate(), id, batchId: 'seed-batch', at: 100, query: '翻译', mode: 'focused', status: 'candidate', ...extra };
}

function seed(root, patch = {}) {
  return writeSchedule(root, { ...readSchedule(root), ...patch });
}

async function until(read, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await sleep(10);
  }
  assert.fail(message);
}

/* No real model executable is ever used. Each child reads only files under its
 * supplied cwd, emits the actual opencode JSON event protocol, and has a finite
 * gate lease so failed assertions cannot leave an indefinitely waiting child. */
function fakeModel(t, root, candidates = [candidate()], { gate = false } = {}) {
  const executable = path.join(root, 'fake-opencode');
  fs.writeFileSync(path.join(root, 'fake-response.json'), JSON.stringify({ events: discoveryFixtureEvents(candidates), gate }));
  fs.writeFileSync(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const file = name => path.join(process.cwd(), name);
const response = JSON.parse(fs.readFileSync(file('fake-response.json'), 'utf8'));
const prompt = process.argv.at(-1);
const researching = prompt.includes('本轮唯一任务是调查现有问题');
const target = researching ? JSON.parse(prompt.split('本轮唯一任务是调查现有问题（不是产生候选）：')[1].split('\\n')[0]) : null;
fs.writeFileSync(file('fake-argv.json'), JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(file('fake-started'), 'ready');
const started = Date.now();
function finish() {
  if (response.gate && !fs.existsSync(file('fake-release'))) {
    if (Date.now() - started > 8000) process.exit(2);
    return setTimeout(finish, 10);
  }
  console.log(JSON.stringify({ type: 'step_start', part: {} }));
  for (const event of response.events) {
    if (event.type === 'text') {
      const candidates = JSON.parse(event.part.text);
      event.part.text = JSON.stringify(researching ? candidates.filter(item => item.topic === target.topic).slice(0, 1) : candidates.map(item => ({ ...item,
        question: { version: 1, audience: '使用这些工具的普通用户', value: '理解具体任务的机制和取舍', investigate: ['查清实际任务怎样发生', '比较不同条件下的结果与限制'], premises: [] }
      })));
    }
    console.log(JSON.stringify(event));
  }
  console.log(JSON.stringify({ type: 'step_finish', part: {} }));
}
finish();
`, { mode: 0o755 });
  const previous = process.env.VH_OPENCODE_BIN;
  process.env.VH_OPENCODE_BIN = executable;
  t.after(() => {
    if (previous === undefined) delete process.env.VH_OPENCODE_BIN;
    else process.env.VH_OPENCODE_BIN = previous;
  });
  return {
    executable,
    started: () => until(() => fs.existsSync(path.join(root, 'fake-started')), '假模型未启动'),
    release: () => fs.writeFileSync(path.join(root, 'fake-release'), 'continue'),
    prompt: () => JSON.parse(fs.readFileSync(path.join(root, 'fake-argv.json'), 'utf8')).at(-1),
  };
}

async function httpFixture(t, root) {
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  // There is deliberately no default project, PROJECT.json, or real HOME.
  const server = startServer(null, 0, { root, home, providerInfo: () => [] });
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (endpoint, input, { method = input === undefined ? 'GET' : 'POST', raw } = {}) => {
    const response = await fetch(base + '/_api/schedule/discover' + endpoint, {
      method, headers: { 'content-type': 'application/json' },
      ...(method === 'POST' ? { body: raw ?? JSON.stringify(input) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
}

test('提示词包含日期、两种模式、多种切口、允许少给、历史与显式反馈边界', () => {
  const args = { query: '翻译工具', count: 4, date: '2026-11-09', exclude: ['旧标题'],
    history: [record('history-one')], preferences: { notes: '多讲普通用户的任务',
      examples: [{ topic: '旧题', kind: 'not-interested', reason: '材料太少' }] },
    followup: { action: 'different', topic: '旧题', coreQuestion: '旧问题' } };
  const focused = discoveryPrompt({ ...args, mode: 'focused' });
  const explore = discoveryPrompt({ ...args, mode: 'explore' });
  assert.match(focused, /当前日期：2026-11-09/);
  assert.match(focused, /模式：贴近当前方向/);
  assert.match(explore, /模式：探索新方向/);
  assert.match(focused, /不调用 websearch\/webfetch/);
  assert.match(focused, /变化.*具体案例.*机制解释/);
  assert.match(focused, /最多 4 个候选.*少给.*\[\]/);
  assert.match(focused, /history-one/);
  assert.match(focused, /旧标题/);
  assert.match(focused, /多讲普通用户的任务/);
  assert.match(focused, /not-interested/);
  assert.match(focused, /不代表负反馈/);
  assert.match(focused, /非永久领域黑名单/);
  assert.match(focused, /不视作兴趣投票/);
  assert.match(focused, /updateOf\/newEvidence/);
  assert.match(discoveryPrompt({ query: '今日' }), new RegExp(new Date().toISOString().slice(0, 10)));
});

test('手动发现默认只持久化 results 和推荐历史，不入队、不自动制造反馈', async t => {
  const root = temporaryRoot(t);
  const model = fakeModel(t, root);
  const result = await discoverTopics(root, { query: '翻译工具', count: 3, mode: 'explore' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.added, []);
  assert.equal(result.results.length, 1, '允许不足请求数量');
  const queue = readSchedule(root), saved = queue.discoveryTopics[0];
  assert.deepEqual(queue.items, []);
  assert.deepEqual(saved, result.results[0]);
  assert.equal(saved.status, 'candidate');
  assert.equal(saved.query, '翻译工具');
  assert.equal(saved.mode, 'explore');
  assert.ok(saved.id && saved.batchId && saved.at > 0);
  assert.equal(saved.feedback, undefined);
  assert.equal(queue.discovery[0].suggested, 1);
  assert.equal(queue.discovery[0].added, 0);
  assert.match(model.prompt(), /模式：探索新方向/);
});

test('手动发现即使自动开关开启或请求 autoQueue 也不入队', async t => {
  const root = temporaryRoot(t);
  fakeModel(t, root);
  seed(root, { discoveryConfig: { enabled: true, autoQueue: true } });
  const result = await discoverTopics(root, { origin: 'manual', autoQueue: true });
  assert.deepEqual(result.added, []);
  assert.equal(readSchedule(root).items.length, 0);
});

test('accept 保留选题元数据和待核来源，重复接受幂等；移除后旧请求不能重新入队', t => {
  const root = temporaryRoot(t), original = record('pick-me');
  seed(root, { discoveryTopics: [original] });
  const accepted = updateTopicState(root, { action: 'accept', id: original.id });
  const again = updateTopicState(root, { action: 'accept', id: original.id });
  assert.equal(again.item.id, accepted.item.id);
  const queue = readSchedule(root), item = queue.items[0];
  assert.equal(queue.items.length, 1);
  assert.equal(item.discoveryId, original.id);
  for (const key of ['subject', 'coreQuestion', 'why', 'outline', 'difference', 'angle', 'sources']) {
    assert.deepEqual(item[key], original[key], key);
  }
  assert.equal(queue.discoveryTopics[0].queueId, item.id);
  assert.equal(queue.discoveryTopics[0].feedback.kind, 'interested');
  const brief = topicBrief(item);
  for (const text of [original.topic, original.coreQuestion, original.why, original.outline, original.difference, original.sources[0]]) {
    assert.ok(brief.includes(text), text);
  }
  assert.match(brief, /待阅读核对，不代表已核实/);
  removeItem(root, item.id);
  updateTopicState(root, { action: 'accept', id: original.id });
  assert.equal(readSchedule(root).items.length, 0);
  assert.equal(topicState(root).topics.length, 1);
  assert.notEqual(topicState(root).topics[0].feedback?.kind, 'not-interested');
});

test('手工项移除、批量移除和跳过仍保留记忆，不合成负反馈', t => {
  const root = temporaryRoot(t);
  const first = addTopic(root, '词典怎样收录新词', { sources: ['https://source.test/dictionary'] });
  const second = addTopic(root, '耳机为何漏音');
  const skipped = addTopic(root, '相机怎样防抖');
  removeItem(root, first.id);
  const result = removeItems(root, [second.id, skipped.id], { skip: item => item.id === skipped.id ? '正在制作' : null });
  assert.equal(result.removed, 1);
  assert.equal(result.skipped.length, 1);
  const state = topicState(root);
  assert.equal(state.total, 3);
  assert.equal(state.feedbackCount, 0);
  assert.deepEqual(feedbackContext(readSchedule(root)).examples, []);
  assert.deepEqual(readSchedule(root).items.map(item => item.id), [skipped.id]);
  assert.deepEqual(state.topics.find(item => item.topic === first.topic).sources, first.sources);
  assert.deepEqual(filterCandidates([candidate(first.topic)], readSchedule(root)), []);
});

test('同标题、同核心问题、旧 runs 与批内重复去重，同来源不同问题保留', t => {
  const root = temporaryRoot(t), old = record('old');
  const run = { id: 'old-run', topic: '录音笔怎样隔开旁人的说话声', coreQuestion: '录音笔如何分离不同说话者', subject: '录音笔' };
  seed(root, { discoveryTopics: [old], runs: [run] });
  const fresh = candidate('长文翻译如何记住前文', { coreQuestion: '长文翻译如何保持术语一致' });
  const output = filterCandidates([
    candidate(old.topic),
    candidate('生词进入离线翻译时发生什么'),
    candidate(run.topic, { subject: '录音笔', coreQuestion: run.coreQuestion }),
    fresh, { ...fresh, topic: '长文章怎样统一术语' },
  ], readSchedule(root));
  assert.deepEqual(output.map(item => item.topic), [fresh.topic]);
  assert.deepEqual(output[0].sources, old.sources, '同来源不构成重复');
});

test('实质更新例外必须同时提供 updateOf、新证据、新 URL，不能只换日期或标题', t => {
  const root = temporaryRoot(t), old = record('old');
  seed(root, { discoveryTopics: [old] });
  const update = candidate('离线翻译新增词表后生词如何处理', { updateOf: old.id,
    newEvidence: '新增可导入的术语表使原先无法识别的专名有了可验证的译法', sources: ['https://source.test/new-evidence'] });
  assert.deepEqual(filterCandidates([update], readSchedule(root)).map(item => item.topic), [update.topic]);
  for (const patch of [{ updateOf: undefined }, { updateOf: 'other' }, { newEvidence: '' },
    { newEvidence: '日期变了' }, { sources: old.sources }, { topic: old.topic }]) {
    assert.deepEqual(filterCandidates([{ ...update, ...patch }], readSchedule(root)), [], JSON.stringify(patch));
  }
});

test('问题构思不凭模型自报更新证据绕过旧问题去重，重复仍留历史', async t => {
  const root = temporaryRoot(t), old = record('old');
  seed(root, { discoveryTopics: [old] });
  const update = candidate('离线翻译新增词表后生词如何处理', { updateOf: old.id,
    newEvidence: '新增可导入的术语表使原先无法识别的专名有了可验证的译法', sources: ['https://source.test/new-evidence'] });
  fakeModel(t, root, [candidate('生词进入离线翻译时发生什么'), update]);
  const result = await discoverTopics(root);
  assert.equal(result.results.length, 0);
  assert.equal(readSchedule(root).items.length, 0);
  const duplicate = readSchedule(root).discoveryTopics.find(item => item.status === 'duplicate');
  assert.equal(duplicate.duplicateOf, old.id);
  assert.equal(duplicate.feedback, undefined);
  assert.throws(() => updateTopicState(root, { action: 'accept', id: duplicate.id }), { statusCode: 400 });
});

test('来源只允许无凭证 HTTP(S)，拒绝 javascript、坏 URL、其他协议并去重限量', () => {
  const invalid = ['javascript:alert(1)', 'https://', 'not a URL', '/relative', 'file:///etc/passwd',
    'ftp://source.test/file', 'https://user:secret@source.test/a', 'https://user@source.test/a',
    null, {}, 'https://source.test/' + 'a'.repeat(2048)];
  assert.deepEqual(sourceURLs(invalid), []);
  const valid = ['https://source.test/a', 'http://source.test/b', 'https://source.test/c', 'https://source.test/d'];
  assert.deepEqual(sourceURLs([...invalid, valid[0], valid[0], ...valid.slice(1), 'https://source.test/e']), valid);
  assert.deepEqual(filterCandidates([candidate('不安全出处', { sources: invalid })], { items: [] }), []);
  assert.ok(!topicBrief(candidate('安全简介', { sources: [...invalid, valid[0]] })).includes('javascript:'));
});

test('问题生成不依赖来源，也不采信模型夹带的安全或不安全来源', async t => {
  const root = temporaryRoot(t);
  const unsafe = ['javascript:alert(1)', 'https://', 'https://user:secret@source.test/a'];
  fakeModel(t, root, [candidate('不能采用的出处', { sources: unsafe }),
    candidate('能采用的出处', { coreQuestion: '词典怎样解释术语的意义', sources: [...unsafe, 'https://source.test/safe'] })]);
  const result = await discoverTopics(root);
  assert.deepEqual(result.results.map(item => item.topic), ['不能采用的出处', '能采用的出处']);
  assert.equal(readSchedule(root).discoveryTopics.length, 2);
  for (const record of readSchedule(root).discoveryTopics) {
    assert.deepEqual(record.sources, []);
    assert.equal(record.research, undefined);
    assert.equal(record.researchAssessment.status, 'unresearched');
  }
});

test('自动模式先构思再调查，同批相同问题只调查并入队一次', async t => {
  const root = temporaryRoot(t), old = record('old');
  seed(root, { discoveryTopics: [old], discoveryConfig: { enabled: true, autoQueue: true } });
  const update = candidate('离线模型如何统一长文术语', { coreQuestion: '长文翻译如何保持术语一致', sources: ['https://source.test/new-evidence'] });
  fakeModel(t, root, [update, { ...update, topic: '自带词表怎样改变离线翻译的生词处理', sources: ['https://source.test/another-report'] }]);
  const result = await discoverTopics(root, { origin: 'automatic' });
  assert.equal(result.results.length, 1);
  assert.equal(result.added.length, 1);
  assert.equal(readSchedule(root).items.length, 1);
  assert.equal(readSchedule(root).discoveryTopics.filter(item => item.status === 'duplicate').length, 1);
});

test('显式反馈可修改、单条撤销与全清；均不删推荐历史、旧 runs 或队列', t => {
  const root = temporaryRoot(t);
  seed(root, { discoveryTopics: [record('a'), record('b', { topic: '耳机为何漏音', coreQuestion: '耳机如何减少漏音' }),
    record('c', { topic: '未选择的题目', coreQuestion: '未选择的问题' })], runs: [{ id: 'run', topic: '已做过的题目' }] });
  updateTopicState(root, { action: 'accept', id: 'a' });
  const queued = readSchedule(root).items;
  updateTopicState(root, { action: 'feedback', id: 'a', kind: 'seen', reason: ' 已经了解 ', note: ' 暂时不做 ' });
  updateTopicState(root, { action: 'feedback', id: 'b', kind: 'not-interested', reason: '材料不足', note: '补案例后再看' });
  let state = topicState(root);
  assert.equal(state.topics.find(item => item.id === 'a').status, 'queued');
  assert.equal(state.topics.find(item => item.id === 'a').feedback.reason, '已经了解');
  assert.equal(state.topics.find(item => item.id === 'b').status, 'dismissed');
  assert.equal(state.topics.find(item => item.id === 'c').feedback, undefined, '不选择不是负反馈');
  updateTopicState(root, { action: 'feedback', id: 'b', kind: 'seen' });
  assert.equal(topicState(root).topics.find(item => item.id === 'b').feedback.kind, 'seen');
  updateTopicState(root, { action: 'clear-feedback', id: 'b' });
  assert.equal(topicState(root).topics.find(item => item.id === 'b').status, 'candidate');
  assert.equal(topicState(root).feedbackCount, 1);
  updateTopicState(root, { action: 'clear-feedback' });
  state = topicState(root);
  assert.equal(state.feedbackCount, 0);
  assert.equal(state.total, 4);
  assert.equal(state.topics.find(item => item.id === 'a').status, 'queued');
  assert.deepEqual(readSchedule(root).items, queued);
  assert.deepEqual(readSchedule(root).runs, [{ id: 'run', topic: '已做过的题目' }]);
  assert.deepEqual(feedbackContext(readSchedule(root)).examples, []);
});

test('发现实际注入历史、明确偏好与反馈，换一批不增加兴趣投票', async t => {
  const root = temporaryRoot(t);
  seed(root, { discoveryTopics: [record('base')] });
  updateTopicState(root, { action: 'preferences', notes: '偏好生活里的实际任务' });
  updateTopicState(root, { action: 'feedback', id: 'base', kind: 'not-interested', reason: '缺少过程' });
  const before = feedbackContext(readSchedule(root));
  const model = fakeModel(t, root, []);
  const result = await discoverTopics(root, { mode: 'explore', followupId: 'base', followup: 'different' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
  assert.match(model.prompt(), /偏好生活里的实际任务/);
  assert.match(model.prompt(), /缺少过程/);
  assert.match(model.prompt(), /"id":"base"/);
  assert.match(model.prompt(), /"action":"different"/);
  assert.deepEqual(feedbackContext(readSchedule(root)), before);
});

test('config 与 notes 严格校验；非法修改不落盘、不丢其他设置', t => {
  const root = temporaryRoot(t);
  seed(root, { discoveryConfig: { model: 'fake/model', agent: 'test-agent' }, discoveryTopics: [record('base')] });
  updateTopicState(root, { action: 'config', config: { enabled: true, autoQueue: false, query: ' 本地翻译 ', mode: 'explore', count: 10 } });
  updateTopicState(root, { action: 'preferences', notes: '  多讲真实经历  ' });
  const before = fs.readFileSync(path.join(root, 'schedule.json'), 'utf8');
  const invalidConfigs = [null, [], 'bad', { enabled: 1 }, { autoQueue: 'true' }, { query: '' },
    { query: ' ' }, { query: 1 }, { query: 'x'.repeat(1001) }, { mode: 'unknown' },
    { count: 0 }, { count: 11 }, { count: 1.5 }, { count: '3' }];
  for (const config of invalidConfigs) {
    assert.throws(() => updateTopicState(root, { action: 'config', config }), { statusCode: 400 });
  }
  for (const notes of [null, 1, {}, 'x'.repeat(4001)]) {
    assert.throws(() => updateTopicState(root, { action: 'preferences', notes }), { statusCode: 400 });
  }
  assert.throws(() => updateTopicState(root, { action: 'feedback', id: 'base', kind: 'skip' }), { statusCode: 400 });
  assert.throws(() => updateTopicState(root, { action: 'accept', id: 'missing' }), { statusCode: 404 });
  assert.throws(() => updateTopicState(root, { action: 'clear-feedback', id: 'missing' }), { statusCode: 404 });
  assert.equal(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'), before);
  assert.equal(topicState(root).config.model, 'fake/model');
  assert.equal(topicState(root).config.query, '本地翻译');
  assert.equal(topicState(root).preferences.notes, '多讲真实经历');
});

test('搜索中修改反馈、配置、队列和偏好，完成时合并最新状态并重新去重', async t => {
  const root = temporaryRoot(t);
  seed(root, { discoveryTopics: [record('base')] });
  const fresh = candidate('耳机为何漏音', { subject: '耳机', coreQuestion: '耳机如何减少漏音' });
  const model = fakeModel(t, root, [fresh], { gate: true });
  const pending = discoverTopics(root, { query: '原始查询' });
  try {
    await model.started();
    updateTopicState(root, { action: 'feedback', id: 'base', kind: 'seen', note: '搜索期间修改' });
    updateTopicState(root, { action: 'preferences', notes: '新偏好' });
    updateTopicState(root, { action: 'config', config: { query: '新查询', mode: 'explore' } });
    addTopic(root, fresh.topic, fresh);
  } finally { model.release(); }
  const result = await pending;
  assert.deepEqual(result.results, [], '并发添加的同题不应再推荐');
  const queue = readSchedule(root);
  assert.equal(queue.items.length, 1);
  assert.equal(queue.discoveryConfig.query, '新查询');
  assert.equal(queue.discoveryConfig.mode, 'explore');
  assert.equal(queue.discoveryPreferences.notes, '新偏好');
  assert.equal(queue.discoveryTopics.find(item => item.id === 'base').feedback.note, '搜索期间修改');
  assert.ok(queue.discoveryTopics.some(item => item.status === 'duplicate'));
});

test('自动入队只允许 automatic 且开始和完成时持久配置双开', async t => {
  const cases = [
    { name: '双开保持', before: { enabled: true, autoQueue: true }, after: {}, expected: 1 },
    { name: '默认关闭', before: {}, after: {}, expected: 0 },
    { name: '未开自动入队', before: { enabled: true, autoQueue: false }, after: {}, expected: 0 },
    { name: '完成时关闭发现', before: { enabled: true, autoQueue: true }, after: { enabled: false }, expected: 0 },
    { name: '完成时关闭入队', before: { enabled: true, autoQueue: true }, after: { autoQueue: false }, expected: 0 },
    { name: '开始时未开入队', before: { enabled: true, autoQueue: false }, after: { autoQueue: true }, expected: 0 },
    { name: '开始时未开发现', before: { enabled: false, autoQueue: true }, after: { enabled: true }, expected: 0 },
    { name: '选项不能代替持久入队开关', before: { enabled: true, autoQueue: false }, after: { autoQueue: true }, options: { autoQueue: true }, expected: 0 },
    { name: 'manual 永不入队', before: { enabled: true, autoQueue: true }, after: {}, options: { origin: 'manual' }, expected: 0 },
    { name: '省略 origin 永不入队', before: { enabled: true, autoQueue: true }, after: {}, options: { origin: undefined }, expected: 0 },
  ];
  for (const entry of cases) await t.test(entry.name, async t => {
    const root = temporaryRoot(t);
    seed(root, { discoveryConfig: entry.before });
    const model = fakeModel(t, root, [candidate()], { gate: true });
    const pending = discoverTopics(root, { origin: 'automatic', ...entry.options });
    try {
      await model.started();
      updateTopicState(root, { action: 'config', config: entry.after });
    } finally { model.release(); }
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 1);
    assert.equal(result.added.length, entry.expected);
    assert.equal(readSchedule(root).items.length, entry.expected);
  });
});

test('topics HTTP 无默认项目可用，GET 不写盘，POST 接受/反馈/设置，坏输入 400/404', async t => {
  const root = temporaryRoot(t);
  fakeModel(t, root, []);
  const request = await httpFixture(t, root);
  const empty = await request('/topics');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.total, 0);
  assert.equal(fs.existsSync(path.join(root, 'schedule.json')), false, 'GET 不能迁移或创建 schedule');
  seed(root, { discoveryTopics: [record('http-topic')] });
  const before = fs.readFileSync(path.join(root, 'schedule.json'), 'utf8');
  assert.equal((await request('/topics?limit=1')).body.topics.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'schedule.json'), 'utf8'), before);
  for (const input of [{ action: 'config', config: { count: 0 } }, { action: 'preferences', notes: 2 },
    { action: 'feedback', id: 'http-topic', kind: 'skip' }, { action: 'unknown' }]) {
    assert.equal((await request('/topics', input)).status, 400, JSON.stringify(input));
  }
  assert.equal((await request('/topics', {}, { raw: '{broken' })).status, 400);
  assert.equal((await request('/topics', { action: 'accept', id: 'missing' })).status, 404);
  assert.equal((await request('/topics', { action: 'clear-feedback', id: 'missing' })).status, 404);
  assert.equal((await request('/topics', { action: 'preferences', notes: '口语一点' })).status, 200);
  assert.equal((await request('/topics', { action: 'config', config: { mode: 'explore' } })).status, 200);
  const accepted = await request('/topics', { action: 'accept', id: 'http-topic' });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.item.discoveryId, 'http-topic');
  assert.equal((await request('/topics', { action: 'feedback', id: 'http-topic', kind: 'seen' })).status, 200);
  assert.equal((await request('/topics', { action: 'clear-feedback' })).body.feedbackCount, 0);
  assert.equal(readSchedule(root).items.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'fake-started')), false, '记忆接口不得启动模型');
});

test('discover HTTP 参数错误为 400/404，不启动后台任务', async t => {
  const root = temporaryRoot(t);
  fakeModel(t, root, []);
  seed(root, { discoveryTopics: [record('base')] });
  const request = await httpFixture(t, root);
  assert.equal((await request('')).status, 200);
  for (const input of [null, [], 'bad', { query: 3 }, { query: 'x'.repeat(1001) }, { mode: 'wrong' },
    { count: 0 }, { count: 11 }, { count: 1.5 }, { count: '2' },
    { followupId: 'missing', followup: 'deeper' }, { followupId: 'base', followup: 'wrong' }]) {
    const result = await request('', input);
    assert.ok([400, 404].includes(result.status), `${JSON.stringify(input).slice(0, 100)}: HTTP ${result.status}`);
  }
  assert.equal(readJob(root), null);
  assert.equal(fs.existsSync(path.join(root, 'fake-started')), false);
});

test('discover HTTP 非法 JSON 请求体返回 400，而不是服务器内部错误', async t => {
  const root = temporaryRoot(t);
  fakeModel(t, root, []);
  const request = await httpFixture(t, root);
  const result = await request('', {}, { raw: '{broken' });
  assert.equal(result.status, 400);
  assert.equal(readJob(root), null);
  assert.equal(fs.existsSync(path.join(root, 'fake-started')), false);
});

test('后台 runner 使用 job 的 mode/followup 等参数快照，完成结果包含 results 且手动不入队', t => {
  const root = temporaryRoot(t);
  const fresh = candidate('长文翻译如何记住前文', { coreQuestion: '长文翻译如何保持术语一致' });
  const model = fakeModel(t, root, [fresh]);
  seed(root, { discoveryTopics: [record('base')], discoveryConfig: { enabled: true, autoQueue: true, mode: 'focused' } });
  let captured;
  const started = startJob(root, { query: '快照查询', count: 2, mode: 'explore', followupId: 'base',
    followup: 'different', model: 'fake/model', agent: 'fake-agent', timeoutMs: 5000 }, {
    spawnImpl: (executable, args, options) => {
      captured = { executable, args, options };
      return { pid: process.pid, on() {}, unref() {} };
    },
  });
  assert.equal(started.busy, false);
  assert.equal(startJob(root, {}).busy, true);
  assert.deepEqual(captured.args, [runner, '--root', root, '--job', started.job.id]);
  assert.equal(captured.options.detached, true);
  seed(root, { ...readSchedule(root), discoveryConfig: { enabled: true, autoQueue: true, query: '后改查询', mode: 'focused', count: 1 } });
  const run = spawnSync(process.execPath, [runner, '--root', root, '--job', started.job.id], {
    cwd: root, env: { ...process.env, VH_OPENCODE_BIN: model.executable }, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  const job = readJob(root);
  assert.equal(job.state, 'done');
  assert.equal(job.mode, 'explore');
  assert.equal(job.followupId, 'base');
  assert.equal(job.followup, 'different');
  assert.equal(job.query, '快照查询');
  assert.equal(job.results.length, 1);
  assert.deepEqual(job.added, []);
  assert.equal(job.results[0].mode, 'explore');
  assert.equal(readSchedule(root).items.length, 0);
  assert.equal(describeJob(job).suggested, 1);
  assert.match(model.prompt(), /模式：探索新方向/);
  assert.match(model.prompt(), /"action":"different"/);
  assert.match(model.prompt(), /检索方向（用户资料）："翻译"/);
  assert.doesNotMatch(model.prompt(), /快照查询|后改查询/);
  const argv = JSON.parse(fs.readFileSync(path.join(root, 'fake-argv.json'), 'utf8'));
  assert.ok(argv.includes('fake/model'));
  assert.match(argv[argv.indexOf('--agent') + 1], /^vh-questions-/);
  const snapshot = fs.readFileSync(path.join(root, JOB_FILE), 'utf8');
  assert.equal(spawnSync(process.execPath, [runner, '--root', root, '--job', 'obsolete'], { cwd: root, env: process.env, timeout: 10000 }).status, 0);
  assert.equal(fs.readFileSync(path.join(root, JOB_FILE), 'utf8'), snapshot, '旧 job 不得覆盖新结果');
});

test('discover HTTP 无默认项目也能异步启动、拒绝重复任务、轮询得到 results', async t => {
  const root = temporaryRoot(t);
  const model = fakeModel(t, root, [candidate('长文翻译如何记住前文', { coreQuestion: '长文翻译如何保持术语一致' })], { gate: true });
  seed(root, { discoveryTopics: [record('base')], discoveryConfig: { enabled: true, autoQueue: true, count: 2 } });
  const request = await httpFixture(t, root);
  const started = await request('', { mode: 'explore', followupId: 'base', followup: 'deeper', query: '本轮查询' });
  try {
    assert.equal(started.status, 202);
    assert.equal(started.body.job.mode, 'explore');
    assert.equal(started.body.job.followupId, 'base');
    assert.equal(started.body.job.followup, 'deeper');
    await model.started();
    assert.equal((await request('', {})).status, 409);
    assert.equal((await request('')).body.job.state, 'running');
  } finally { model.release(); }
  await until(() => readJob(root)?.state !== 'running' && readJob(root), '后台作业未完成');
  const polled = await request('');
  assert.equal(polled.status, 200);
  assert.equal(polled.body.job.state, 'done');
  assert.equal(polled.body.job.results.length, 1);
  assert.equal(polled.body.view.suggested, 1);
  assert.deepEqual(polled.body.job.added, []);
  assert.equal(readSchedule(root).items.length, 0);
  assert.equal((await request('/topics')).body.total, 2);
  assert.match(model.prompt(), /"action":"deeper"/);
});

test('搜索锁：手动与自动不重复调用模型，正常完成后释放；只回收已退出进程的锁', async t => {
  const root = temporaryRoot(t), model = fakeModel(t, root, [candidate()], { gate: true });
  const pending = discoverTopics(root);
  try {
    await model.started();
    const duplicate = await discoverTopics(root, { origin: 'automatic' });
    assert.equal(duplicate.ok, false);
    assert.match(duplicate.reason, /已有选题检索/);
  } finally { model.release(); }
  assert.equal((await pending).ok, true);
  const file = path.join(root, 'out/.vh-topic-search.lock');
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'exited-fixture' }));
  assert.equal((await discoverTopics(root)).ok, true);
  assert.equal(fs.existsSync(file), false);
});

test('待选候选不因较新的历史挤出列表；无效清反馈 id 不意外清空全部反馈', t => {
  const root = temporaryRoot(t);
  seed(root, { discoveryTopics: [record('waiting', { at: 1 }), record('recent', { at: 10, status: 'dismissed', feedback: { kind: 'not-interested', at: 10 } })] });
  assert.equal(topicState(root, { limit: 1 }).topics[0].id, 'waiting');
  assert.throws(() => updateTopicState(root, { action: 'clear-feedback', id: null }), { statusCode: 400 });
  assert.equal(topicState(root).feedbackCount, 1);
});
