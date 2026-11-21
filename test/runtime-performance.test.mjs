import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readResponseText } from '../lib/provider-response.mjs';
import { beginTask, updateTask, taskStatus } from '../lib/task-status.mjs';
import { checkpointPath, writeCheckpoint } from '../lib/checkpoint.mjs';

test('paused status reads/validates a checkpoint once per observation, never across polls', t => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-status-runtime-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const task = beginTask(project, 'Fixture', 'article');
  const file = checkpointPath(project, task.id);
  writeCheckpoint(project, { schemaVersion: 1, taskId: task.id, attemptId: task.attemptId,
    mode: task.mode, status: 'paused', messages: [{ role: 'user', content: 'Fixture' }], pending: [] });
  updateTask(project, task.id, { status: 'paused' });
  const original = fs.readFileSync;
  let reads = 0;
  t.mock.method(fs, 'readFileSync', function(name, ...args) {
    if (name === file) reads++;
    return original.call(this, name, ...args);
  });
  const observe = expected => {
    reads = 0;
    const status = taskStatus(project, { includeDeliverable: false });
    assert.equal(reads, expected);
    return status;
  };
  assert.equal(observe(1).status, 'paused');
  // A malformed or replaced checkpoint must not inherit any old observation.
  fs.writeFileSync(file, '{broken');
  assert.equal(observe(1).repairRecovery, undefined);
  fs.unlinkSync(file);
  assert.equal(observe(0).resumeKind, 'paused');
  updateTask(project, task.id, { status: 'failed' });
  assert.equal(observe(0).status, 'failed');
});

const done = /(?:^|\n)data:\s*\[DONE\]\r?\n(?:\r?\n|$)/;
async function compareChunks(chunks) {
  const decoder = new TextDecoder();
  let expected = '', expectedReads = 0, expectedCancel = false;
  for (const bytes of chunks) {
    expectedReads++;
    expected += decoder.decode(bytes, { stream: true });
    if (done.test(expected)) { expectedCancel = true; break; }
  }
  expected += decoder.decode();
  let reads = 0, cancelled = false, released = false;
  const response = { headers: new Headers({ 'content-type': 'text/event-stream' }), body: { getReader: () => ({
    async read() { return reads < chunks.length ? { value: chunks[reads++], done: false } : { done: true }; },
    async cancel() { cancelled = true; }, releaseLock() { released = true; },
  }) } };
  assert.equal(await readResponseText(response), expected);
  assert.equal(reads, expectedReads);
  assert.equal(cancelled, expectedCancel);
  assert.equal(released, true);
}

test('incremental DONE detection matches the original matcher at every byte boundary', async () => {
  const fixtures = [
    'data: [DONE]\n\n', 'data:[DONE]\r\n\r\n', ': heartbeat\n\ndata: [DONE]\n',
    'data: \t\r\n\u00a0[DONE]\n\n', 'data:\ndata: [DONE]\n\n',
    'data: [DONE]\nnot-an-empty-line\ndata: [DONE]\n\n',
    'data: [DONE]\n\rX\ndata: [DONE]\r\n\r\n',
    'data: [DONEX]\n\n', 'data: [DONE]', 'data: [DONE]\r',
    'data: [DONE]\ntrailer', 'xdata: [DONE]\n\n', ' data: [DONE]\n\n',
    'data: {"content":"中文 [DONE]"}\n\ndata: [DONE]\n\n',
    'data: [DONE]\n\nignored-tail',
  ];
  for (const text of fixtures) {
    const bytes = Buffer.from(text);
    for (let cut = 1; cut < bytes.length; cut++) await compareChunks([bytes.subarray(0, cut), bytes.subarray(cut)]);
    await compareChunks([...bytes].map(byte => Uint8Array.of(byte)));
  }
  // No unbounded carry or rescanning when one whitespace prefix spans chunks.
  await compareChunks([Buffer.from('data:'), ...Array.from({ length: 100 }, () => Buffer.from(' '.repeat(1024))), Buffer.from('[DONE]\n\n')]);
});

test('response limits, cancellation and non-SSE bodies retain their boundaries', async () => {
  const json = 'data: [DONE]\n\ntrailing JSON bytes';
  assert.equal(await readResponseText(new Response(json)), json);
  await assert.rejects(readResponseText(new Response('12345'), { limit: 4 }), { code: 'VH_RESPONSE_TOO_LARGE' });
  const abort = new AbortController();
  let cancelled = false, released = false;
  const response = { headers: new Headers(), body: { getReader: () => ({
    read: () => new Promise(() => {}), cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; },
  }) } };
  const promise = readResponseText(response, { signal: abort.signal });
  abort.abort(new Error('fixture abort'));
  await assert.rejects(promise, /fixture abort/);
  assert.equal(cancelled, true); assert.equal(released, true);
});
