import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const vh = path.resolve('vh.mjs');
test('取配方默认只读：已有 demo 与当前项目不改写，不出现新项目', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-scene-readonly-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), '当前项目原稿');
  const before = fs.readdirSync(path.resolve('projects')).sort();
  for (const recipe of ['compare-bars', 'process-steps', 'one-take']) {
    const demo = path.resolve('projects', recipe + '-demo', 'scenes.src.js');
    const stat = fs.existsSync(demo) ? fs.statSync(demo).mtimeMs : null;
    const result = spawnSync(process.execPath, [vh, 'scene', recipe], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /root =>/);
    assert.doesNotMatch(result.stdout, /已生成配方项目/);
    if (stat !== null) assert.equal(fs.statSync(demo).mtimeMs, stat);
  }
  assert.deepEqual(fs.readdirSync(path.resolve('projects')).sort(), before);
  assert.equal(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), '当前项目原稿');
});

test('制作 Agent 即便显式传 --demo 也不能在 projects 创建示例', () => {
  const before = fs.readdirSync(path.resolve('projects')).sort();
  const result = spawnSync(process.execPath, [vh, 'scene', 'compare-bars', '--demo'],
    { encoding: 'utf8', env: { ...process.env, VH_AGENT_PROJECT: path.resolve('projects') } });
  assert.notEqual(result.status, 0); assert.match(result.stdout + result.stderr, /不得创建示例项目/);
  assert.deepEqual(fs.readdirSync(path.resolve('projects')).sort(), before);
});

test('--append 仍显式追加到指定项目，不创建 demo', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-scene-append-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}'); fs.writeFileSync(path.join(dir, 'scenes.src.js'), '原场景');
  const result = spawnSync(process.execPath, [vh, 'scene', 'compare-bars', '--append', '--dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(dir, 'scenes.src.js'), 'utf8'), /^原场景\n\n\/\/---[\s\S]*root =>/);
});
