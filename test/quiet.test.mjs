import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { makeTools } from '../lib/agent.mjs';

test('安静制作：agent 不能弹应用或 preview --open', async () => {
  const tools = makeTools(process.cwd(), () => {});
  for (const command of ['open http://localhost:8144', '/usr/bin/open /x',
    'echo hi; open http://localhost', 'node /x/vh.mjs preview --open', 'node "/x/vh.mjs" preview --open']) {
    assert.match(await tools.run.run({ command }), /拒绝.*不自动打开/);
  }
});

test('preview：复用服务时默认只返回地址，不执行系统 open', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-quiet-'));
  const server = http.createServer((req, res) => res.end('{}'));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const marker = path.join(temp, 'opened');
  fs.writeFileSync(path.join(temp, 'open'), '#!/bin/sh\ntouch "' + marker + '"\n', { mode: 0o755 });
  try {
    const result = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['vh.mjs', 'preview', '--port', String(server.address().port)], {
        cwd: process.cwd(), env: { ...process.env, PATH: temp + ':' + process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe']
      });
      let text = '';
      p.stdout.on('data', b => { text += b; });
      p.stderr.on('data', b => { text += b; });
      p.on('error', reject); p.on('close', code => resolve({ code, text }));
    });
    assert.equal(result.code, 0, result.text);
    assert.match(result.text, /不重复启动/);
    assert.equal(fs.existsSync(marker), false, '默认不能打开用户浏览器');
  } finally {
    await new Promise(r => server.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
