import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTestRoot, cleanupTestRoot, runTests } from '../scripts/test.mjs';

test('测试并发有界，非法配置在创建临时目录或启动子进程前拒绝', () => {
  for (const concurrency of [0, -1, 1.5, 17, NaN]) {
    let created = false;
    assert.throws(() => runTests({ files: [], concurrency, onRoot: () => { created = true; } }), /VH_TEST_CONCURRENCY/);
    assert.equal(created, false);
  }
});

test('临时根目录有本轮标记，只清理标记目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-runner-check-'));
  try {
    const root = createTestRoot(base), sibling = fs.mkdtempSync(path.join(base, 'user-data-'));
    fs.writeFileSync(path.join(sibling, 'keep.txt'), 'keep');
    assert.equal(cleanupTestRoot(root, base), true);
    assert.equal(fs.existsSync(root), false);
    assert.equal(fs.readFileSync(path.join(sibling, 'keep.txt'), 'utf8'), 'keep');
    assert.equal(cleanupTestRoot(sibling, base), false, '没有标记的目录不能被删除');
    assert.equal(fs.existsSync(sibling), true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('拒绝越界路径、符号链接与根目录', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-runner-guard-'));
  try {
    assert.equal(cleanupTestRoot(base, base), false);
    assert.equal(cleanupTestRoot(os.tmpdir(), os.tmpdir()), false);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-runner-outside-'));
    fs.writeFileSync(path.join(outside, '.vh-test-run.json'), '{"version":1}');
    const link = path.join(base, 'vh-test-run-link');
    fs.symlinkSync(outside, link);
    assert.equal(cleanupTestRoot(link, base), false);
    assert.equal(fs.existsSync(outside), true);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('测试失败也会清理本轮临时目录，且不改动外部文件', { timeout: 30000 }, async t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-runner-fixture-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const marker = path.join(fixtureRoot, 'created.txt');
  const fixture = path.join(fixtureRoot, 'failing.test.mjs');
  fs.writeFileSync(fixture, `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
test('故意失败并记录临时目录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-fixture-'));
  fs.writeFileSync(${JSON.stringify(marker)}, dir);
  throw new Error('intentional failure');
});`);
  let createdRoot = '';
  const result = await runTests({ files: [fixture], stdio: 'ignore', onRoot: root => { createdRoot = root; } });
  assert.equal(result.code, 1);
  assert.equal(result.cleaned, true);
  assert.equal(fs.existsSync(createdRoot), false);
  const dir = fs.readFileSync(marker, 'utf8');
  assert.equal(fs.existsSync(dir), false, '测试创建的临时项目也应随本轮根目录删除');
});
