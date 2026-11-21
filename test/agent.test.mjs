import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTools } from '../lib/agent.mjs';

const tmpProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-agent-'));

/* ---------- 1) 只改画面的模式：不许写 脚本.md ---------- */
test('edit-visual 模式：写 脚本.md 被拒', async () => {
  const dir = tmpProject();
  const logs = [];
  const tools = makeTools(dir, (m) => logs.push(String(m)), { mode: 'edit-visual' });
  const r = await tools.write_file.run({ path: '脚本.md', content: 'x' });
  assert.match(r, /拒绝/);
  assert.equal(fs.existsSync(path.join(dir, '脚本.md')), false);
});

test('edit-visual 模式：写 scenes.src.js 允许', async () => {
  const dir = tmpProject();
  const tools = makeTools(dir, () => {}, { mode: 'edit-visual' });
  const r = await tools.write_file.run({ path: 'scenes.src.js', content: 'root=>{}' });
  assert.match(r, /已写入/);
  assert.ok(fs.existsSync(path.join(dir, 'scenes.src.js')));
});

/* ---------- 2) 禁止直调底层脚本（绕过守卫） ---------- */
test('run：直接调 render.mjs 被拒，并给出 vh 命令', async () => {
  const dir = tmpProject();
  const tools = makeTools(dir, () => {}, { mode: 'edit' });
  const r = await tools.run.run({ command: 'node render.mjs --scenes 1' });
  assert.match(r, /拒绝/);
  assert.match(r, /vh render/);
});

test('run：直调 gen.mjs / voice-kokoro.py 也被拒', async () => {
  const dir = tmpProject();
  const tools = makeTools(dir, () => {}, { mode: 'edit' });
  assert.match(await tools.run.run({ command: 'node gen.mjs --estimate' }), /拒绝/);
  assert.match(await tools.run.run({ command: 'python3 voice-kokoro.py --srt' }), /拒绝/);
});

test('run：vh 命令允许执行', async () => {
  const dir = tmpProject();
  const tools = makeTools(dir, () => {}, { mode: 'edit' });
  const r = await tools.run.run({ command: 'node -e "console.log(1+1)"' });
  assert.match(r, /exit=0/);
  assert.match(r, /2/);
});

/* ---------- 3) 重复动作被拒（防死循环） ---------- */
test('run：同一条命令连跑两次 → 第二次被提示不要重复', async () => {
  const dir = tmpProject();
  const tools = makeTools(dir, () => {}, { mode: 'edit' });
  const cmd = 'node -e "console.log(42)"';
  await tools.run.run({ command: cmd });
  const second = await tools.run.run({ command: cmd });
  assert.match(second, /刚刚跑过同一条命令/);
});

/* ---------- 4) 越界路径被拒 ---------- */
test('write_file：写到项目外被拒', async () => {
  const dir = tmpProject();
  const tools = makeTools(dir, () => {}, { mode: 'article' });
  const r = await tools.write_file.run({ path: '../evil.txt', content: 'x' });
  assert.match(r, /拒绝/);
});
