import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMemory, saveMemory } from '../lib/agent.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vh-mem-'));

test('memory：写入后能读回', () => {
  const d = tmp();
  saveMemory(d, { user: '改标题', summary: '写 scenes.src.js', mode: 'edit-visual' });
  const m = loadMemory(d);
  assert.equal(m.length, 1);
  assert.equal(m[0].user, '改标题');
});

test('memory：只保留最近 8 轮（不会无限膨胀）', () => {
  const d = tmp();
  for (let i = 0; i < 12; i++) saveMemory(d, { user: 'u' + i, summary: 's' + i });
  const m = loadMemory(d);
  assert.equal(m.length, 8);
  assert.equal(m[m.length - 1].user, 'u11');
  assert.equal(m[0].user, 'u4');
});

test('memory：文件损坏时返回空数组（不崩）', () => {
  const d = tmp();
  fs.mkdirSync(path.join(d, 'out'), { recursive: true });
  fs.writeFileSync(path.join(d, 'out', '.vh-chat-memory.json'), '{坏 JSON');
  assert.deepEqual(loadMemory(d), []);
});

test('memory：没有文件时返回空数组', () => {
  assert.deepEqual(loadMemory(tmp()), []);
});
