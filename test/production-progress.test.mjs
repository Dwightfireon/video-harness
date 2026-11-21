import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../lib/server.mjs';
import { readEditFile } from '../lib/author-edits.mjs';
import { readTask, taskStatus } from '../lib/task-status.mjs';

test('真实网页提交→实际worker短补丁自修→HTTP轮次/失败点，无需浏览日志且不重置预算', { timeout: 30000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-web-progress-')), project = path.join(root, 'projects/a'), home = path.join(root, 'home');
  fs.mkdirSync(path.join(project, 'out'), { recursive: true });
  for (const [name, content] of Object.entries({ 'PROJECT.json': '{"deliveryTarget":"video","automation":{"enabled":true,"maxRepairs":1}}',
    '方案.md': '方案', 'claims.json': '[]', '脚本.md': '## S1 · 一\n1. 展示窗口。\n', 'scenes.src.js': 'root=>{const label = 0;return{render(){}}}',
    'engine.tpl.html': "const ORIENT = 'landscape';", 'scene.html': 'const DURATION = 1;const scenes = [];addScene(0,1,()=>{});',
    'gen.mjs': 'console.error("FAIL 版式溢出：窗口压住字幕");process.exit(7);' })) fs.writeFileSync(path.join(project, name), content);
  let requests = 0;
  const model = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      const snapshot = readEditFile(project, 'scenes.src.js'), old = Number(snapshot.content.match(/label = (\d+)/)[1]); requests++;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null,
        tool_calls: [{ id: 'patch-' + requests, type: 'function', function: { name: 'patch_text', arguments: JSON.stringify({ path: 'scenes.src.js',
          base_hash: snapshot.base_hash, find: 'label = ' + old, replace: 'label = ' + (old + 1), expected_count: 1 }) } },
          { id: 'finish-' + requests, type: 'function', function: { name: 'finish_repair', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }));
    });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), JSON.stringify({ provider: { opendesign: { options: { baseURL: 'http://127.0.0.1:' + model.address().port } } } }));
  const server = startServer(project, 0, { root, providerInfo: () => [{ provider: 'opendesign' }], agentEnv: { ...process.env, HOME: home, OPEN_DESIGN_API_KEY: 'fixture-only' } });
  await once(server, 'listening');
  t.after(async () => {
    const task = readTask(project); if (task?.pid && taskStatus(project).running) { try { process.kill(task.pid, 'SIGTERM'); } catch {} }
    server.closeAllConnections(); model.closeAllConnections(); await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => model.close(resolve))]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(base + '/_api/chat?p=projects%2Fa', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '完成当前视频', mode: 'article' }) });
  assert.equal(response.status, 200, await response.text());
  let view; const end = Date.now() + 10000;
  while (Date.now() < end) {
    view = await (await fetch(base + '/_api/production?p=projects%2Fa')).json();
    if (view.task.status === 'paused' && view.task.canResume) break;
    await delay(30);
  }
  assert.equal(view.task.status, 'paused', JSON.stringify(view)); assert.equal(view.automation.activePolicy.enabled, true);
  assert.equal(view.repair.used, 1); assert.equal(view.repair.limit, 1); assert.equal(view.repair.phase, 'stopped');
  assert.match(view.repair.lastIssue, /上限.*版式溢出/s); assert.match(view.task.pausedReason, /上限/);
  assert.ok(requests >= 1 && requests <= 3, String(requests)); assert.match(fs.readFileSync(path.join(project, 'scenes.src.js'), 'utf8'), /label = [1-9]/);
  assert.equal(taskStatus(project).automationSummary.repairUsed, 1);
});
