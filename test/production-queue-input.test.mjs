import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { startServer } from '../lib/server.mjs';
import { acquireQueueDispatch } from '../lib/daily-build.mjs';
import { queuedProduction, readSchedule } from '../lib/schedule.mjs';

test('首页入队保存完整文章和设置，不开工；队列列表不回传正文、重复入队和并发开工被拦', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-enqueue-'));
  const server = startServer(null, 0, { root, home: root, publish: {} });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/_api/schedule`;
  const post = (sub, data) => fetch(base + sub, { method: 'POST', body: JSON.stringify(data) });
  const job = { name: '文章测试', mode: 'article', input: '完整文章\n'.repeat(25_000), aspectRatio: '9:16', deliveryTarget: 'video' };
  const response = await post('/enqueue', job);
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.equal((await post('/enqueue', job)).status, 409);
  assert.equal((await post('/enqueue', { ...job, input: ' ' })).status, 400);
  assert.equal(fs.existsSync(path.join(root, 'projects')), false);
  const queue = readSchedule(root);
  assert.equal(queue.items[0].id, id);
  assert.deepEqual(queuedProduction(root, queue.items[0]), job);
  const view = await (await fetch(base)).json();
  assert.equal(view.items[0].state, 'todo');
  assert.equal(view.items[0].productionInput, undefined);
  const lock = acquireQueueDispatch(root);
  try { assert.equal((await post('/start', { id })).status, 409); }
  finally { lock.release(); }
  assert.equal(fs.existsSync(path.join(root, 'projects')), false);
});
