import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dedupeFrames, framesDigest } from '../lib/frame-dedupe.mjs';

function fixture(t, groups) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-dedupe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let n = 0;
  for (const [bytes, count] of groups) {
    for (let i = 0; i < count; i++) fs.writeFileSync(path.join(dir, String(n++).padStart(5, '0') + '.jpg'), bytes);
  }
  return dir;
}
const distinctInodes = dir => new Set(fs.readdirSync(dir).map(n => fs.statSync(path.join(dir, n)).ino)).size;

test('相同帧换成硬链接：磁盘只剩一份，读到的字节完全不变', t => {
  const dir = fixture(t, [['A'.repeat(4096), 8], ['B'.repeat(2048), 4]]);
  const before = framesDigest(dir);
  assert.equal(distinctInodes(dir), 12);
  const result = dedupeFrames(dir);
  assert.equal(result.ok, true);
  assert.equal(result.count, 12);
  assert.equal(result.distinct, 2);
  assert.equal(result.linked, 10);
  assert.equal(distinctInodes(dir), 2, '同内容只剩 2 个 inode');
  const after = framesDigest(dir);
  assert.equal(after.sha256, before.sha256, '内容指纹必须一模一样');
  assert.equal(after.bytes, before.bytes, '逐帧读到的字节数不变');
  assert.ok(result.savedBytes > 0);
});

test('全是唯一帧时不动任何文件', t => {
  const dir = fixture(t, [['A'.repeat(100), 1], ['B'.repeat(200), 1], ['C'.repeat(300), 1]]);
  const inodes = fs.readdirSync(dir).map(n => fs.statSync(path.join(dir, n)).ino).sort();
  const result = dedupeFrames(dir);
  assert.equal(result.linked, 0);
  assert.equal(result.savedBytes, 0);
  assert.deepEqual(fs.readdirSync(dir).map(n => fs.statSync(path.join(dir, n)).ino).sort(), inodes, '不能改任何一帧');
});

test('dry-run 只报告不动盘；重复执行幂等', t => {
  const dir = fixture(t, [['A'.repeat(4096), 5]]);
  const before = fs.readdirSync(dir).map(n => fs.statSync(path.join(dir, n)).ino).sort();
  const preview = dedupeFrames(dir, { dryRun: true });
  assert.equal(preview.linked, 4);
  assert.deepEqual(fs.readdirSync(dir).map(n => fs.statSync(path.join(dir, n)).ino).sort(), before, '预览不能改盘');
  dedupeFrames(dir);
  const once = distinctInodes(dir);
  const again = dedupeFrames(dir);
  assert.equal(again.linked, 0, '已经是硬链接就不再动');
  assert.equal(distinctInodes(dir), once);
});

test('帧目录里的符号链接被拒绝，不会顺着链接去改别处', t => {
  const dir = fixture(t, [['A'.repeat(100), 2]]);
  const outside = path.join(os.tmpdir(), 'vh-dedupe-outside-' + process.pid + '.jpg');
  fs.writeFileSync(outside, 'OUTSIDE');
  t.after(() => fs.rmSync(outside, { force: true }));
  fs.symlinkSync(outside, path.join(dir, '00099.jpg'));
  assert.throws(() => dedupeFrames(dir), /不是普通文件/);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE', '目录外文件不能被碰');
});

import { frameIsComplete, resumableFrames } from '../lib/frame-dedupe.mjs';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1),
  Buffer.from([0, 0, 0, 0]), Buffer.from('IEND', 'latin1')]);

test('只有带完整结束标记的帧才算完成，截断/空文件必须重渲', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '00000.jpg'), JPEG);
  fs.writeFileSync(path.join(dir, '00001.jpg'), JPEG.subarray(0, 40));   // truncated
  fs.writeFileSync(path.join(dir, '00002.jpg'), '');
  fs.writeFileSync(path.join(dir, '00003.png'), PNG);
  assert.equal(frameIsComplete(path.join(dir, '00000.jpg')), true);
  assert.equal(frameIsComplete(path.join(dir, '00001.jpg')), false, '半截 JPEG 不能当完成');
  assert.equal(frameIsComplete(path.join(dir, '00002.jpg')), false);
  assert.equal(frameIsComplete(path.join(dir, '00003.png')), true);
  const resume = resumableFrames(dir);
  assert.deepEqual([...resume].sort(), ['00000', '00003']);
});

test('比 scene.html 更旧的帧不复用，避免跨构建混画面', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-resume-age-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = path.join(dir, '00000.jpg'), fresh = path.join(dir, '00001.jpg');
  fs.writeFileSync(old, JPEG); fs.writeFileSync(fresh, JPEG);
  const oldTime = Date.now() / 1000 - 3600;
  fs.utimesSync(old, oldTime, oldTime);
  const scene = path.join(dir, 'scene.html');
  fs.writeFileSync(scene, '<html>');
  const resume = resumableFrames(dir, { sceneMtimeMs: fs.statSync(scene).mtimeMs });
  assert.deepEqual([...resume], ['00001'], '只复用当前构建之后写出的帧');
});
