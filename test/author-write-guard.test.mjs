import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTools } from '../lib/agent.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-author-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  for (const name of ['脚本.md', '发布文案.md']) fs.writeFileSync(path.join(dir, name), '原文');
  return dir;
}

test('解释器只读作者文件仍允许，不能被版本守卫误拦', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article' });
  for (const command of [
    `node -e "const s=require('fs').readFileSync('发布文案.md','utf8');console.log(s.length)"`,
    `node -e "const s=require('fs').readFileSync('脚本.md','utf8');console.log(s.slice(-200))"`,
    'grep -n 原文 脚本.md',
    'sed -n 1,3p 发布文案.md',
  ]) assert.doesNotMatch(await tools.run.run({ command }), /拒绝/, command);
});

test('绕过受控工具直接写作者文件会被拒，文件保持不变', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article' });
  const commands = [
    `node -e "const fs=require('fs');fs.writeFileSync('发布文案.md','改过')"`,
    `node -e "require('fs').appendFileSync('脚本.md','追加')"`,
    `python3 -c "from pathlib import Path; Path('发布文案.md').write_text('改过')"`,
    `sed -i '' 's/原文/改过/g' 发布文案.md`,
  ];
  for (const command of commands) {
    const result = await tools.run.run({ command });
    assert.match(result, /拒绝/, command);
    assert.match(fs.readFileSync(path.join(dir, '发布文案.md'), 'utf8'), /原文/);
    assert.match(fs.readFileSync(path.join(dir, '脚本.md'), 'utf8'), /原文/);
  }
});

test('生成媒体或写输出目录不因名字类似被误拦', async t => {
  const dir = fixture(t), tools = makeTools(dir, () => {}, { mode: 'article' });
  const result = await tools.run.run({ command: `node -e "const fs=require('fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/note.txt','ok')"` });
  assert.match(result, /^exit=0/);
});
