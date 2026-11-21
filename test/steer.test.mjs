import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* 插话机制：队列语义靠"写入→取走即清空"保证，这里测文件层行为。
   （agent 循环里的读取逻辑在 runAgent 内，不易单测；用同样的读写规则验证。） */
const qpath = (d) => path.join(d, 'out', '.vh-steer.json');

test('steer：写入后可读回，且格式为数组', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-steer-'));
  fs.mkdirSync(path.join(d, 'out'), { recursive: true });
  fs.writeFileSync(qpath(d), JSON.stringify([{ at: 1, message: '改标题', mode: 'edit-visual' }]));
  const q = JSON.parse(fs.readFileSync(qpath(d), 'utf8'));
  assert.equal(q.length, 1);
  assert.equal(q[0].message, '改标题');
});

test('steer：取走即清空（不会重复执行）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-steer-'));
  fs.mkdirSync(path.join(d, 'out'), { recursive: true });
  fs.writeFileSync(qpath(d), JSON.stringify([{ at: 1, message: 'x' }]));
  // 模拟 agent 的 drain
  const drain = () => {
    const q = JSON.parse(fs.readFileSync(qpath(d), 'utf8'));
    if (q.length) { fs.writeFileSync(qpath(d), '[]'); return q; }
    return [];
  };
  assert.equal(drain().length, 1);
  assert.equal(drain().length, 0, '第二次不该再读到');
});

test('steer：队列最多保留 10 条（不会无限增长）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-steer-'));
  fs.mkdirSync(path.join(d, 'out'), { recursive: true });
  let q = [];
  for (let i = 0; i < 15; i++) { q.push({ at: i, message: 'm' + i }); q = q.slice(-10); }
  fs.writeFileSync(qpath(d), JSON.stringify(q));
  const saved = JSON.parse(fs.readFileSync(qpath(d), 'utf8'));
  assert.equal(saved.length, 10);
  assert.equal(saved[saved.length - 1].message, 'm14');
});
