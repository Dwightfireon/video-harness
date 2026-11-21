import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../lib/server.mjs';
import { currentArtifactInputs, mediaFingerprint } from '../lib/artifact-status.mjs';
import { acquireProductionLock } from '../lib/production-lock.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-workbench-stills-'));
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  for (const [name, content] of Object.entries({ 'PROJECT.json': '{}', '脚本.md': '## S1 · 测试\n1. 旁白。\n',
    'scenes.src.js': 'root=>({})', 'scene.html': `<!doctype html><style>body{background:red}</style>
      <script>window.W=160;window.H=90;const DURATION=2;const scenes=[];
      function addScene(){} addScene(0,2,()=>{});window.renderAt=async t=>{};</script>` }))
    fs.writeFileSync(path.join(project, name), content);
  server = startServer(project, 0, { root }); await once(server, 'listening');
  return { project, url: 'http://127.0.0.1:' + server.address().port + '/_api/stills' };
}

async function finished(url) {
  for (let i = 0; i < 300; i++) {
    const status = await (await fetch(url)).json();
    if (status.state !== 'running') return status;
    await delay(100);
  }
  throw new Error('静帧命令未在测试期限内完成');
}

test('workbench uses vh stills, remains running until exit, and records the real receipt', { timeout: 45000 }, async t => {
  const { project, url } = await fixture(t);
  assert.equal((await (await fetch(url)).json()).state, 'idle');
  const response = await fetch(url, { method: 'POST' });
  assert.equal(response.status, 202); assert.equal((await response.json()).state, 'running');
  const duplicate = await (await fetch(url, { method: 'POST' })).json();
  assert.equal(duplicate.busy, true); assert.equal(duplicate.state, 'running');
  const result = await finished(url);
  assert.equal(result.state, 'completed', JSON.stringify(result));
  const state = JSON.parse(fs.readFileSync(path.join(project, 'out/.vh-state.json')));
  assert.equal(state.lastStills.kind, 'scenes');
  assert.equal(state.lastStills.sourceSignature, currentArtifactInputs(project).sourceSignature);
  assert.equal(state.lastStills.files[0].sha256, mediaFingerprint(path.join(project, 'out/stills/s-01.jpg')).sha256);
  const events = fs.readFileSync(path.join(project, 'out/.vh-performance.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(event => event.kind === 'command' && event.stage === 'stills' && event.ok));
});

test('a competing production lock is reported as failed, never as completed', { timeout: 45000 }, async t => {
  const { project, url } = await fixture(t), lock = acquireProductionLock(project, { command: 'go' });
  try {
    assert.equal((await (await fetch(url, { method: 'POST' })).json()).state, 'running');
    const result = await finished(url);
    assert.equal(result.state, 'failed', JSON.stringify(result));
    assert.match(result.message, /lock|锁/i);
    assert.equal(fs.existsSync(path.join(project, 'out/stills/s-01.jpg')), false);
  } finally { lock.release(); }
});
