import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { analyzeSessionPerformance, sessionPerformanceReport, RESPONSE_INTERVAL_LABEL } from '../lib/session-performance.mjs';
import { parseArguments, offlineMessages, readSessionMessages, readApiJSON } from '../scripts/audit-opencode-session.mjs';

const user = (id, at) => ({ id: 'msg_' + id, type: 'user', time: { created: at }, text: 'PRIVATE USER TEXT' });
const tool = (id, name, ran, completed, extra = {}) => ({ type: 'tool', id, name,
  time: { created: ran, ran, completed }, state: { status: 'completed', input: { secret: 'PRIVATE TOOL INPUT' }, content: [{ text: 'PRIVATE TOOL OUTPUT' }] }, ...extra });
const assistant = (id, created, streamed, completed, content = [], extra = {}) => ({ id: 'msg_' + id, type: 'assistant',
  time: { created, streamed, completed }, model: { id: 'PRIVATE MODEL ID', providerID: 'PRIVATE PROVIDER' },
  finish: 'stop', content: [{ type: 'text', text: 'PRIVATE ASSISTANT TEXT' }, { type: 'reasoning', text: 'PRIVATE REASONING' }, ...content], ...extra });
const fixture = () => [user('u1', 0), assistant('a1', 1000, 6000, 11000, [tool('t1', 'shell', 4000, 10000), tool('t2', 'read', 5000, 9000)]),
  assistant('a2', 3000, 7000, 12000, [tool('t3', 'shell', 8000, 11000)]), user('u2', 20000), assistant('a3', 21000, 23000, 24000)];
const page = (data, next = null, previous = null) => ({ data, cursor: { next, previous } });
const errorCode = code => error => error.code === code;
const tempRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-session-performance-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('pure successful analysis unions concurrent and nested intervals, not durations', () => {
  const input = fixture(), snapshot = JSON.stringify(input);
  const result = analyzeSessionPerformance(input);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(result.boundary, { start: 0, end: 24000, endBasis: 'completed', wallSeconds: 24 });
  assert.equal(result.counts.assistantMessages, 3);
  assert.deepEqual(result.counts.tools, { shell: 2, read: 1 });
  assert.deepEqual(result.counts.models, { M1: 3 });
  assert.equal(result.intervals.assistantResponse.label, RESPONSE_INTERVAL_LABEL);
  assert.equal(result.intervals.assistantResponse.seconds, 8);
  assert.equal(result.intervals.toolExecution.seconds, 7);
  assert.equal(result.intervals.observedCoveredSeconds, 12);
  assert.equal(result.intervals.observedOverlapSeconds, 3);
  assert.equal(result.intervals.uncoveredSeconds, 12);
  assert.deepEqual(result.segments.map(s => [s.start, s.end, s.counts.assistantMessages]), [[0, 20000, 2], [20000, 24000, 1]]);
});

test('explicit inclusive IDs clip every interval including in-flight work from earlier records', () => {
  const result = analyzeSessionPerformance(fixture(), { from: 'msg_a2', to: 'msg_a2' });
  assert.equal(result.boundary.start, 3000);
  assert.equal(result.boundary.end, 12000);
  assert.equal(result.counts.assistantMessages, 1);
  assert.deepEqual(result.counts.tools, { shell: 1 });
  assert.equal(result.intervals.assistantResponse.seconds, 4);
  assert.equal(result.intervals.toolExecution.seconds, 7);
  assert.equal(result.intervals.observedCoveredSeconds, 8);
  assert.equal(result.intervals.observedOverlapSeconds, 3);
  assert.equal(result.intervals.uncoveredSeconds, 1);
  const untilUser = analyzeSessionPerformance(fixture(), { to: 'msg_u2' });
  assert.equal(untilUser.boundary.end, 20000);
  assert.equal(untilUser.boundary.endBasis, 'created');
  assert.equal(untilUser.counts.assistantMessages, 2);
});

test('steering user messages partition concurrent work without adding parent/child times', () => {
  const result = analyzeSessionPerformance([user('u1', 0), assistant('a1', 1000, 8000, 10000, [tool('t1', 'task', 3000, 10000)]),
    user('u2', 5000), assistant('a2', 6000, 9000, 11000)]);
  assert.deepEqual(result.segments.map(s => [s.wallSeconds, s.intervals.assistantResponse.seconds, s.intervals.toolExecution.seconds]), [[5, 4, 2], [6, 4, 5]]);
  assert.equal(result.intervals.toolExecution.seconds, 7);
  assert.equal(result.intervals.assistantResponse.seconds, 8);
  assert.match(result.scope, /不读取或相加子会话/);
});

test('user idle is uncovered clock time, never model or tool time', () => {
  const result = analyzeSessionPerformance([user('u1', 0), assistant('a1', 1000, 2000, 3000), user('u2', 100000), assistant('a2', 101000, 102000, 103000)]);
  assert.equal(result.intervals.assistantResponse.seconds, 2);
  assert.equal(result.intervals.toolExecution.seconds, 0);
  assert.equal(result.intervals.uncoveredSeconds, 101);
  assert.equal(result.segments[0].intervals.uncoveredSeconds, 99);
  assert.match(sessionPerformanceReport(result), /不能归因模型/);
});

test('missing optional timings are explicit null/partial, not invented zero', () => {
  const result = analyzeSessionPerformance([user('u', 1000), assistant('a', 2000, undefined, undefined,
    [tool('t1', 'read', undefined, undefined)], { finish: undefined, model: undefined })]);
  assert.equal(result.boundary.end, 2000);
  assert.equal(result.boundary.endBasis, 'created');
  assert.equal(result.intervals.assistantResponse.seconds, null);
  assert.equal(result.intervals.assistantResponse.missingIntervals, 1);
  assert.equal(result.intervals.toolExecution.seconds, null);
  assert.equal(result.intervals.toolExecution.missingIntervals, 1);
  assert.equal(result.counts.missing.assistantStreamed, 1);
  assert.equal(result.counts.missing.assistantCompleted, 1);
  assert.equal(result.counts.missing.toolRan, 1);
  assert.equal(result.counts.missing.model, 1);
  assert.equal(result.counts.finishMissing, 1);
  assert.equal(result.intervals.coveragePartial, true);
  assert.match(sessionPerformanceReport(result), /缺测/);
  const noContent = analyzeSessionPerformance([assistant('a', 0, 1000, 2000, [], { content: undefined })]);
  assert.equal(noContent.intervals.toolExecution.seconds, null);
  assert.equal(noContent.intervals.toolExecution.unknownToolCollections, 1);
  assert.equal(noContent.intervals.toolExecution.partial, true);
});

test('completed timing is not substituted for streamed; partial unions remain explicitly partial', () => {
  const result = analyzeSessionPerformance([assistant('a1', 0, 1000, 3000), assistant('a2', 1000, undefined, 4000)]);
  assert.equal(result.intervals.assistantResponse.seconds, 1);
  assert.equal(result.intervals.assistantResponse.partial, true);
  assert.equal(result.intervals.assistantResponse.missingIntervals, 1);
});

test('finish/error/retry metadata counts are safe categories, retry attempt is not summed', () => {
  const failure = { type: 'PRIVATE ERROR TYPE', message: 'PRIVATE ERROR RAW', status: 429, response: { body: 'PRIVATE ERROR RESPONSE' } };
  const input = [assistant('a1', 0, 1000, 2000, [tool('t', 'shell', 500, 1500, { state: { status: 'error', error: { ...failure, status: 500 } } })],
    { finish: 'error', error: failure, retry: { at: 1500, attempt: 2, error: failure } }),
  assistant('a2', 1000, 2000, 3000, [], { finish: 'PRIVATE FINISH', retry: { at: 2500, attempt: 3, error: { ...failure, status: 401 } }, model: { id: 'OTHER PRIVATE MODEL', providerID: 'PRIVATE PROVIDER' } })];
  const result = analyzeSessionPerformance(input);
  assert.equal(result.counts.finishErrors, 1);
  assert.deepEqual(result.counts.finishes, { error: 1, unknown: 1 });
  assert.equal(result.counts.retryRecords, 2);
  assert.equal(result.counts.retryAttemptMaximum, 3);
  assert.deepEqual(result.counts.assistantErrors, { 'rate-limit': 1 });
  assert.deepEqual(result.counts.retryErrors, { 'rate-limit': 1, authentication: 1 });
  assert.deepEqual(result.counts.toolErrors, { server: 1 });
  assert.deepEqual(result.counts.models, { M1: 1, M2: 1 });
  assert.doesNotMatch(JSON.stringify(result) + sessionPerformanceReport(result), /PRIVATE|OTHER PRIVATE/);
});

test('tool-name counters handle prototype keys without pollution or throwing', () => {
  const result = analyzeSessionPerformance([assistant('a', 0, 1, 2, [tool('a', '__proto__', 0, 1), tool('b', 'constructor', 0, 1), tool('c', 'bad\nPRIVATE', 0, 1)])]);
  assert.equal(Object.getPrototypeOf(result.counts.tools), Object.prototype);
  assert.equal(result.counts.tools.__proto__, 1);
  assert.equal(result.counts.tools.constructor, 1);
  assert.equal(result.counts.tools['(unknown)'], 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});

test('empty, unordered, duplicate and absent message boundaries fail closed', () => {
  assert.throws(() => analyzeSessionPerformance([]), errorCode('empty-or-invalid-messages'));
  assert.throws(() => analyzeSessionPerformance([user('b', 2000), user('a', 1000)]), errorCode('unordered-messages'));
  assert.throws(() => analyzeSessionPerformance([user('a', 1000), user('a', 2000)]), errorCode('duplicate-message'));
  assert.throws(() => analyzeSessionPerformance(fixture(), { from: 'msg_missing' }), errorCode('boundary-not-found'));
  assert.throws(() => analyzeSessionPerformance(fixture(), { to: 'msg_missing' }), errorCode('boundary-not-found'));
  assert.throws(() => analyzeSessionPerformance(fixture(), { from: 'msg_a3', to: 'msg_a1' }), errorCode('reversed-boundaries'));
  assert.throws(() => analyzeSessionPerformance([{ ...user('a', 1000), time: {} }]), errorCode('missing-message-created'));
});

test('reversed, nonfinite and overlapping-reversed endpoints are invalid, real concurrency is valid', () => {
  assert.throws(() => analyzeSessionPerformance([assistant('a', 2000, 1000, 3000)]), errorCode('reversed-interval'));
  assert.throws(() => analyzeSessionPerformance([assistant('a', 1000, 4000, 3000)]), errorCode('reversed-interval'));
  assert.throws(() => analyzeSessionPerformance([assistant('a', 1000, 2000, NaN)]), errorCode('invalid-timestamp'));
  assert.throws(() => analyzeSessionPerformance([assistant('a', 0, 1000, 2000, [tool('t', 'read', 1500, 1000)])]), errorCode('reversed-interval'));
  assert.throws(() => analyzeSessionPerformance([assistant('a', 0, 1000, 2000, [], { retry: { attempt: 0, at: 1000 } })]), errorCode('invalid-retry'));
  assert.equal(analyzeSessionPerformance(fixture()).ok, true);
});

test('equal timestamps and genuinely measured zero intervals are not missing data', () => {
  const result = analyzeSessionPerformance([user('u', 0), assistant('a', 0, 0, 0, [tool('t', 'read', 0, 0)])]);
  assert.equal(result.boundary.wallSeconds, 0);
  assert.equal(result.intervals.assistantResponse.seconds, 0);
  assert.equal(result.intervals.assistantResponse.measuredIntervals, 1);
  assert.equal(result.intervals.toolExecution.seconds, 0);
  assert.equal(result.intervals.coveragePartial, false);
});

test('CLI argument interface is strict and never treats user input as shell syntax', () => {
  assert.deepEqual(parseArguments(['ses_demo', '--from', 'msg_a', '--to', 'msg_b', '--json']), { sessionID: 'ses_demo', from: 'msg_a', to: 'msg_b', json: true });
  assert.deepEqual(parseArguments(['--input', 'local fixture.json']), { input: 'local fixture.json' });
  for (const args of [[], ['ses_x', '--input', 'f.json'], ['--input'], ['ses_x', '--from'], ['ses_x', '--wat'], ['ses_x', '--json', '--json'], ['ses_x;secret'], ['ses_x', '--to', 'bad']]) assert.throws(() => parseArguments(args));
});

test('opaque cursor pagination uses asc only on the first page and reads every page', async () => {
  const requests = [], data = fixture(), opaque = 'eyJ+/:=? &中文';
  const messages = await readSessionMessages('ses_demo', { fetchPage: async url => {
    requests.push(url);
    return requests.length === 1 ? page(data.slice(0, 2), opaque, 'first-page-anchor') : page(data.slice(2), null, 'back');
  } });
  assert.deepEqual(messages, data);
  assert.equal(requests[0], '/api/session/ses_demo/message?limit=200&order=asc');
  const query = new URL(requests[1], 'http://fixture.invalid').searchParams;
  assert.equal(query.get('cursor'), opaque);
  assert.equal(query.get('limit'), '200');
  assert.equal(query.has('order'), false);
  assert.equal(analyzeSessionPerformance(messages).counts.assistantMessages, 3);
});

test('pagination failure, invalid schema/cursor and loops never return partial success', async () => {
  let calls = 0;
  await assert.rejects(readSessionMessages('ses_demo', { fetchPage: async () => {
    if (++calls === 1) return page([user('u', 0)], 'next');
    throw new Error('PRIVATE API ERROR');
  } }), errorCode('pagination-failed'));
  for (const broken of [[], {}, { data: [], cursor: [] }, page([], 123), page([], ''), page([], 'bad\n'), page([], 'continue')]) {
    await assert.rejects(readSessionMessages('ses_demo', { fetchPage: async () => broken }));
  }
  await assert.rejects(readSessionMessages('ses_demo', { fetchPage: async () => page([user('u', 0)], 'loop') }), errorCode('repeated-cursor'));
  assert.deepEqual(await readSessionMessages('ses_demo', { fetchPage: async () => page([user('u', 0)], null, 'first-anchor') }), [user('u', 0)]);
  const duplicate = await readSessionMessages('ses_demo', { fetchPage: async url => page([user('u', 0)], url.includes('order=') ? 'next' : null) });
  assert.throws(() => analyzeSessionPerformance(duplicate), errorCode('duplicate-message'));
});

test('offline input accepts complete arrays or terminal API pages, rejects partial pages', () => {
  assert.deepEqual(offlineMessages(fixture()), fixture());
  assert.deepEqual(offlineMessages(page(fixture())), fixture());
  assert.deepEqual(offlineMessages({ data: fixture(), cursor: {} }), fixture());
  assert.throws(() => offlineMessages(page(fixture(), 'next')), errorCode('incomplete-offline-page'));
  assert.throws(() => offlineMessages(page(fixture(), null, 'previous')), errorCode('incomplete-offline-page'));
});

test('transport waits for close, uses private stdout FD, and cleans only its own directory', async t => {
  const root = tempRoot(t), sentinel = path.join(root, 'unrelated-user-file'); fs.writeFileSync(sentinel, 'keep');
  let closeSent = false;
  const value = await readApiJSON('/api/session/ses_demo/message?limit=200&order=asc', { tempBase: root, spawnImpl: (executable, args, options) => {
    assert.equal(executable, 'opencode');
    assert.deepEqual(args, ['api', 'get', '/api/session/ses_demo/message?limit=200&order=asc']);
    assert.equal(options.shell, false);
    assert.equal(options.stdio[0], 'ignore'); assert.equal(options.stdio[2], 'ignore');
    const fd = options.stdio[1];
    assert.equal(fs.fstatSync(fd).mode & 0o777, 0o600);
    const owned = fs.readdirSync(root).find(name => name.startsWith('vh-session-audit-'));
    assert.equal(fs.statSync(path.join(root, owned)).mode & 0o777, 0o700);
    const child = new EventEmitter();
    queueMicrotask(() => {
      fs.writeSync(fd, '{"data":'); child.emit('exit', 0, null);
      setImmediate(() => { fs.writeSync(fd, '[],"cursor":{}}'); closeSent = true; child.emit('close', 0, null); });
    });
    return child;
  } });
  assert.equal(closeSent, true);
  assert.deepEqual(value, { data: [], cursor: {} });
  assert.deepEqual(fs.readdirSync(root), ['unrelated-user-file']);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
});

test('real child-process stdout FD preserves a large JSON document without paid API access', async t => {
  const root = tempRoot(t), size = 2 * 1024 * 1024;
  const result = await readApiJSON('/unused', { tempBase: root, spawnImpl: (_exe, _args, options) =>
    spawn(process.execPath, ['-e', `process.stdout.write(JSON.stringify({padding:'x'.repeat(${size})})); process.exit(0)`], options) });
  assert.equal(result.padding.length, size);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('transport rejects truncated JSON, nonzero status and spawn errors without leaking output', async t => {
  const root = tempRoot(t);
  for (const [text, code, expected] of [['{"data":', 0, 'invalid-or-truncated-json'], ['PRIVATE RESPONSE', 1, 'opencode-api-failed']]) {
    await assert.rejects(readApiJSON('/unused', { tempBase: root, spawnImpl: (_exe, _args, options) => {
      const child = new EventEmitter();
      queueMicrotask(() => { fs.writeSync(options.stdio[1], text); child.emit('close', code, null); });
      return child;
    } }), errorCode(expected));
    assert.deepEqual(fs.readdirSync(root), []);
  }
  await assert.rejects(readApiJSON('/unused', { tempBase: root, spawnImpl: () => { throw new Error('PRIVATE CLI PATH'); } }), errorCode('opencode-cli-unavailable'));
  await assert.rejects(readApiJSON('/unused', { tempBase: root, spawnImpl: () => {
    const child = new EventEmitter(); queueMicrotask(() => { child.emit('error', new Error('PRIVATE ERROR')); child.emit('close', -2, null); }); return child;
  } }), errorCode('opencode-cli-unavailable'));
  assert.deepEqual(fs.readdirSync(root), []);
});

test('offline CLI success and failure outputs are sanitized and never modify inputs', t => {
  const root = tempRoot(t), file = path.join(root, 'input.json');
  const input = JSON.stringify(fixture()); fs.writeFileSync(file, input);
  const run = args => spawnSync(process.execPath, ['scripts/audit-opencode-session.mjs', ...args], { encoding: 'utf8' });
  const success = run(['--input', file, '--from', 'msg_u1', '--to', 'msg_a3', '--json']);
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).counts.assistantMessages, 3);
  assert.doesNotMatch(success.stdout + success.stderr, /PRIVATE/);
  const human = run(['--input', file]);
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /助手响应区间（含模型\/渠道\/网络\/客户端，不是纯推理或首字延迟）/);
  assert.equal(fs.readFileSync(file, 'utf8'), input);
  const missing = run(['--input', file, '--to', 'msg_unknown', '--json']);
  assert.equal(missing.status, 1);
  assert.deepEqual(JSON.parse(missing.stdout), { ok: false, error: 'boundary-not-found' });
  fs.writeFileSync(file, '{"PRIVATE TRUNCATED":');
  const broken = run(['--input', file, '--json']);
  assert.equal(broken.status, 1);
  assert.deepEqual(JSON.parse(broken.stdout), { ok: false, error: 'invalid-or-truncated-json' });
  assert.doesNotMatch(broken.stdout + broken.stderr, /PRIVATE/);
});

test('CLI paginated transport is fail-closed end to end with a local fake opencode, no server/model access', t => {
  const root = tempRoot(t), executable = path.join(root, 'opencode');
  fs.writeFileSync(executable, `#!${process.execPath}
const data = ${JSON.stringify(fixture())};
const args = process.argv.slice(2);
if (args[0] !== 'api' || args[1] !== 'get') process.exit(98);
const url = new URL(args[2], 'http://fixture.invalid');
if (url.pathname !== '/api/session/ses_fixture/message' || url.searchParams.get('limit') !== '200') process.exit(97);
const next = 'opaque+/= ?cursor';
if (!url.searchParams.has('cursor')) {
  if (url.searchParams.get('order') !== 'asc') process.exit(96);
  process.stdout.write(JSON.stringify({data:data.slice(0,2),cursor:{next,previous:'first-page-anchor'}}));
} else {
  if (url.searchParams.has('order') || url.searchParams.get('cursor') !== next) process.exit(95);
  const mode = process.env.AUDIT_FIXTURE_MODE;
  if (mode === 'failed') { process.stderr.write('PRIVATE API FAILURE'); process.exit(1); }
  if (mode === 'truncated') process.stdout.write('{"PRIVATE TRUNCATED":');
  else if (mode === 'invalidcursor') process.stdout.write(JSON.stringify({data:data.slice(2),cursor:{next:42}}));
  else process.stdout.write(JSON.stringify({data:mode === 'duplicate' ? data : data.slice(2),cursor:{next:null,previous:'back'}}));
}
process.exit(0);
`, { mode: 0o700 });
  for (const [mode, expected] of [['ok', null], ['failed', 'opencode-api-failed'], ['truncated', 'invalid-or-truncated-json'], ['invalidcursor', 'invalid-cursor'], ['duplicate', 'duplicate-message']]) {
    const result = spawnSync(process.execPath, ['scripts/audit-opencode-session.mjs', 'ses_fixture', '--json'], {
      encoding: 'utf8', env: { ...process.env, PATH: root + path.delimiter + process.env.PATH, AUDIT_FIXTURE_MODE: mode, TMPDIR: root },
    });
    const output = JSON.parse(result.stdout);
    assert.equal(result.status, expected ? 1 : 0, result.stderr);
    if (expected) assert.deepEqual(output, { ok: false, error: expected });
    else assert.equal(output.counts.assistantMessages, 3);
    assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE/);
    assert.deepEqual(fs.readdirSync(root), ['opencode'], 'all CLI-owned temporary directories cleaned');
  }
});
