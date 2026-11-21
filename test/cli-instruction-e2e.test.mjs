import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beginTask } from '../lib/task-status.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VH = path.join(ROOT, 'vh.mjs');
const INSTRUCTION = '在片尾加一段简短广告 贴链接：https://prodclub.xyz/r/S9JE6G，再贴个优惠码：S9JE6G\n介绍是个gpt代充网站 但不要提「代充」这两个字，不要介绍太多。';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cli-instruction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project'), home = path.join(root, 'home');
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
  for (const [name, text] of Object.entries({
    'PROJECT.json': '{"deliveryTarget":"video"}', '方案.md': '受众基线：知道广告。',
    '脚本.md': '## S1 · 开场\n1. 介绍一个产品。\n', 'claims.json': '[]',
    'scenes.src.js': 'root => ({ render() {} })',
    'scene.html': 'const DURATION = 1; const scenes = []; addScene(0,1,root=>({}));',
  })) fs.writeFileSync(path.join(dir, name), text);
  return { root, dir, home };
}

test('真实 CLI + 任务ID 启动新任务时，第一段用户指令必须进入模型请求', { timeout: 30000 }, async t => {
  const { dir, home } = project(t), requests = [];
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', b => { raw += b; }); req.on('end', () => {
      try { requests.push(JSON.parse(raw)); } catch {}
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到要求。' }, finish_reason: 'stop' }] }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(r => server.close(r)));
  fs.writeFileSync(path.join(home, '.config/opencode/opencode.jsonc'), JSON.stringify({
    provider: { opendesign: { options: { baseURL: 'http://127.0.0.1:' + server.address().port }, models: { 'deepseek-v4.1-flash': {} } } },
  }));
  const task = beginTask(dir, INSTRUCTION, 'article');
  const child = spawn(process.execPath, [VH, 'ask', '--task-id', task.id, '--attempt-id', task.attemptId, '--mode', 'article', '--dir', dir], {
    env: { ...process.env, HOME: home, OPEN_DESIGN_API_KEY: 'fixture-only', VH_AGENT_STEPS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; child.stdout.on('data', b => { out += b; }); child.stderr.on('data', b => { out += b; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.ok(requests.length > 0, '没有发出模型请求：' + out);
  const first = requests[0].messages.map(m => m.content || '').join('\n');
  assert.match(first, /在片尾加一段简短广告/, '新任务指令没有进入请求：' + out);
  assert.match(first, /S9JE6G/);
  assert.notEqual(code, 1, out);
});
