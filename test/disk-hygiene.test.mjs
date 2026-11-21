import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stripProjectCaches, cleanTrashCaches, cacheSummary, CACHE_DIRS } from '../lib/disk-hygiene.mjs';
import { acquireProductionLock, readProductionLock } from '../lib/production-lock.mjs';

const keepFiles = ['out/video.mp4', 'out/video-voice.mp4', 'out/narration.m4a', 'out/subtitles.srt', 'out/preview-8.png',
  'out/.voice-not-a-directory', 'out/voice-not-cache/a.wav', 'materials/原文.md', 'research/evidence.txt',
  'engine.tpl.html.bak-old', '脚本.md', '方案.md', 'claims.json'];

function project(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-disk-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ['out/frames/00001.jpg', 'out/frames/00002.jpg', 'out/seg/seg-1.mp4',
    'out/.voice-kokoro/a.wav', 'out/.voice-edge/a.wav', 'out/.voice-fixture/nested/a.wav', '__pycache__/x.pyc'])
    { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'x'.repeat(1000)); }
  for (const f of keepFiles)
    { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'keep'); }
  return dir;
}

test('清理只删可再生缓存，成片/字幕/文稿原样保留', t => {
  const dir = project(t);
  const result = stripProjectCaches(dir);
  // CACHE_DIRS.tts is a selector; removed reports the concrete directories it expanded to.
  assert.equal(CACHE_DIRS.tts, 'out/.voice-*');
  assert.deepEqual(result.removed.sort(), [CACHE_DIRS.frames, 'out/.voice-kokoro', 'out/.voice-edge',
    'out/.voice-fixture', CACHE_DIRS.pycache].sort());
  for (const f of keepFiles)
    assert.equal(fs.readFileSync(path.join(dir, f), 'utf8'), 'keep', f);
  for (const rel of result.removed) assert.equal(fs.existsSync(path.join(dir, rel)), false, rel);
  assert.equal(fs.existsSync(path.join(dir, 'out/seg/seg-1.mp4')), true, '默认保留分段缓存');
  assert.equal(result.freed, 6000);
  assert.deepEqual(stripProjectCaches(dir), { freed: 0, removed: [] }, '重复清理不再释放空间');
});

test('清理回收站：删帧/TTS/分段，保留成片', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectDir = path.join(root, '.vh-trash', '2026-01-01T00-00-00-000Z-demo');
  fs.mkdirSync(path.join(projectDir, 'out/frames'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(projectDir, 'out/frames/00001.jpg'), 'x'.repeat(5000));
  fs.writeFileSync(path.join(projectDir, 'out/video-voice.mp4'), 'keep');
  fs.writeFileSync(path.join(projectDir, '脚本.md'), 'keep');
  const result = cleanTrashCaches(root);
  assert.equal(result.projects.length, 1);
  assert.ok(result.freed >= 5000);
  assert.equal(fs.existsSync(path.join(projectDir, 'out/frames')), false);
  assert.equal(fs.readFileSync(path.join(projectDir, 'out/video-voice.mp4'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(projectDir, '脚本.md'), 'utf8'), 'keep');
  assert.equal(cleanTrashCaches(root).freed, 0, '重复清理应为 0');
});

test('回收站里旧版 render-*/frames 也会清理，其他目录不动', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trash-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.vh-trash', 'old-pilot');
  fs.mkdirSync(path.join(dir, 'out/render-paper/frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.mkdirSync(path.join(dir, 'out/render-signal/frames'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out/render-signal/seg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out/styleframes'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/render-paper/frames/00132.jpg'), 'x'.repeat(3000));
  fs.writeFileSync(path.join(dir, 'out/render-signal/frames/00132.jpg'), 'x'.repeat(3000));
  fs.writeFileSync(path.join(dir, 'out/styleframes/paper-14.png'), 'keep');
  fs.writeFileSync(path.join(dir, 'out/render-paper/encoded.png'), 'keep');
  fs.writeFileSync(path.join(dir, 'out/render-signal/seg/seg-1.mp4'), 'x'.repeat(2000));
  const result = cleanTrashCaches(root);
  assert.ok(result.freed >= 8000);
  assert.equal(fs.existsSync(path.join(dir, 'out/render-paper/frames')), false);
  assert.equal(fs.existsSync(path.join(dir, 'out/render-signal/frames')), false);
  assert.equal(fs.existsSync(path.join(dir, 'out/render-signal/seg')), false, '旧版分段缓存可重建');
  assert.equal(fs.readFileSync(path.join(dir, 'out/styleframes/paper-14.png'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(dir, 'out/render-paper/encoded.png'), 'utf8'), 'keep');
});

test('清理回收站缓存不碰隐藏或无法识别为项目的目录，也不把任意目录当旧渲染缓存', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trash-unknown-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['.hidden', 'unknown', 'project']) {
    const dir = path.join(root, '.vh-trash', name);
    fs.mkdirSync(path.join(dir, 'out/notes/frames'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'out/notes/frames/00001.jpg'), 'keep');
    if (name !== 'unknown') fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
    fs.mkdirSync(path.join(dir, 'out/frames'));
    fs.writeFileSync(path.join(dir, 'out/frames/00001.jpg'), 'frame');
  }
  cleanTrashCaches(root);
  for (const name of ['.hidden', 'unknown']) assert.ok(fs.existsSync(path.join(root, '.vh-trash', name, 'out/frames/00001.jpg')));
  assert.ok(fs.existsSync(path.join(root, '.vh-trash/project/out/notes/frames/00001.jpg')));
  assert.equal(fs.existsSync(path.join(root, '.vh-trash/project/out/frames')), false);
});

test('cacheSummary 区分缓存与项目内容', t => {
  const dir = project(t);
  const summary = cacheSummary(dir);
  assert.ok(summary.total >= 4000);
  assert.equal(summary.parts.frames, 2000);
  assert.equal(summary.parts.seg, 1000);
});

test('缓存路径穿过符号链接或不是目录时，先拒绝整个清理，外部文件不动', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cache-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'project'), external = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(dir, 'out/frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/frames/0001.jpg'), 'keep');
  fs.mkdirSync(path.join(external, 'seg'), { recursive: true });
  fs.writeFileSync(path.join(external, 'seg/file.mp4'), 'outside');
  fs.symlinkSync(path.join(external, 'seg'), path.join(dir, 'out/seg'), 'dir');
  assert.throws(() => stripProjectCaches(dir, { only: ['frames', 'seg'] }), /符号链接/);
  assert.equal(fs.readFileSync(path.join(dir, 'out/frames/0001.jpg'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(path.join(external, 'seg/file.mp4'), 'utf8'), 'outside');
});

test('CLI clean --all 只清帧和分段，保留过程图、TTS 与备份', t => {
  const dir = project(t);
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  const result = spawnSync(process.execPath, [path.resolve('vh.mjs'), 'clean', '--all', '--dir', dir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of keepFiles) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'keep', name);
  for (const name of ['out/.voice-kokoro/a.wav', 'out/.voice-edge/a.wav', 'out/.voice-fixture/nested/a.wav'])
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'x'.repeat(1000), name);
  for (const name of ['out/frames', 'out/seg']) assert.equal(fs.existsSync(path.join(dir, name)), false, name);
});

test('批量清理逐项目加锁，运行中的项目跳过且结果非零', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-prune-all-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.resolve('vh.mjs'), path.join(root, 'vh.mjs'));
  fs.symlinkSync(path.resolve('lib'), path.join(root, 'lib'), 'dir');
  const dirs = ['active', 'idle'].map(name => path.join(root, 'projects', name));
  for (const dir of dirs) {
    fs.mkdirSync(path.join(dir, 'out/frames'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
    fs.writeFileSync(path.join(dir, 'out/frames/00001.jpg'), 'cache');
    fs.writeFileSync(path.join(dir, 'materials/原文.md'), 'keep');
  }
  const lock = acquireProductionLock(dirs[0], { command: 'test', env: {} });
  try {
    const result = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'prune', '--all'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /跳过 1 个/);
    assert.equal(fs.existsSync(path.join(dirs[0], 'out/frames/00001.jpg')), true);
    assert.equal(fs.existsSync(path.join(dirs[1], 'out/frames/00001.jpg')), false);
    for (const dir of dirs) assert.equal(fs.readFileSync(path.join(dir, 'materials/原文.md'), 'utf8'), 'keep');
  } finally { lock.release(); }
});

test('CLI 移入回收站后改名恢复，旧锁停用后可继续制作', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-trash-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.copyFileSync(path.resolve('vh.mjs'), path.join(root, 'vh.mjs'));
  fs.symlinkSync(path.resolve('lib'), path.join(root, 'lib'), 'dir');
  const project = path.join(root, 'projects/demo');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(project, '脚本.md'), '原始文稿');
  const result = spawnSync(process.execPath, [path.join(root, 'vh.mjs'), 'rm', project], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entries = fs.readdirSync(path.join(root, '.vh-trash'));
  assert.equal(entries.length, 1);
  const restored = path.join(root, 'projects/restored');
  fs.renameSync(path.join(root, '.vh-trash', entries[0]), restored);
  assert.equal(fs.readFileSync(path.join(restored, '脚本.md'), 'utf8'), '原始文稿');
  assert.equal(readProductionLock(restored).busy, false);
  const lock = acquireProductionLock(restored, { command: 'test', env: {} });
  lock.release();
});
