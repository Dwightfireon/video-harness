import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readEditFile, patchText, readScene, replaceScene } from '../lib/author-edits.mjs';
import { parseChunks } from '../lib/state.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const scene = n => `// @layout 场${n}\nroot => { const n = ${n}; return { render(t) { void n; } }; }`;
function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-author-edits-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  fs.writeFileSync(path.join(project, '脚本.md'), '\ufeff# 脚本\r\n第一句。\r\n第二句。\r\n');
  fs.writeFileSync(path.join(project, 'scenes.src.js'), '// file header — keep me\n\n' + scene(1) + '\n \n//--- \t\r\n\r\n' + scene(2) + '\n\n//---\n\n' + scene(3) + '\n// final comment\n');
  return project;
}
const bytes = (project, name = '脚本.md') => fs.readFileSync(path.join(project, name));
const history = project => {
  const dir = path.join(project, 'out/.vh-edit-history');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test('paged reads have a full-file hash and retain BOM/CRLF without reading all 827 lines into the excerpt', t => {
  const project = fixture(t);
  const full = Array.from({ length: 827 }, (_, i) => `line ${i}\r\n`).join('');
  fs.writeFileSync(path.join(project, 'scenes.src.js'), full);
  const read = readEditFile(project, 'scenes.src.js');
  assert.equal(read.total_lines, 827);
  assert.equal(read.base_hash, hash(Buffer.from(full)));
  assert.equal(read.start_line, 0);
  assert.equal(read.content, full.split(/(?<=\n)/).slice(0, 80).join(''));
  const tail = readEditFile(project, 'scenes.src.js', { start_line: 825, max_lines: 2 });
  assert.equal(tail.content, 'line 825\r\nline 826\r\n');
  assert.equal(tail.base_hash, read.base_hash);
  assert.equal(readEditFile(project, 'scenes.src.js', { start_line: 900 }).content, '');
  assert.ok(readEditFile(project, '脚本.md').content.startsWith('\ufeff'));
  for (const options of [{ start_line: -1 }, { start_line: 1.5 }, { max_lines: 0 }, { max_lines: Infinity }, { max_lines: 1001 }]) assert.throws(() => readEditFile(project, '脚本.md', options));
  fs.writeFileSync(path.join(project, '审查.md'), '');
  assert.equal(readEditFile(project, '审查.md').total_lines, 0);
});

test('exact patch preserves unrelated bytes and mode, with an exact backup and metadata', t => {
  const project = fixture(t), file = path.join(project, '脚本.md');
  fs.chmodSync(file, 0o640);
  const original = bytes(project), read = readEditFile(project, '脚本.md');
  const result = patchText(project, '脚本.md', { base_hash: read.base_hash, find: '第一句。', replace: '修订$&第一句。' });
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.replacements, 1);
  assert.equal(result.previous_hash, read.base_hash);
  assert.equal(result.base_hash, hash(bytes(project)));
  assert.deepEqual(bytes(project), Buffer.from(original.toString().replace('第一句。', () => '修订$&第一句。')));
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.match(result.backup_path, /^out\/\.vh-edit-history\/[\da-f-]+\/脚本\.md$/);
  assert.deepEqual(fs.readFileSync(path.join(project, result.backup_path)), original);
  const metadata = JSON.parse(fs.readFileSync(path.join(project, path.dirname(result.backup_path), 'metadata.json')));
  assert.equal(metadata.path, '脚本.md');
  assert.equal(metadata.previous_hash, read.base_hash);
  assert.equal(metadata.base_hash, result.base_hash);
  assert.equal(metadata.original_mode, 0o640);
  assert.match(result.message, /backed up/);
});

test('external script changes make a prior excerpt stale; no fallback, history or source write', t => {
  const project = fixture(t), read = readEditFile(project, '脚本.md');
  fs.appendFileSync(path.join(project, '脚本.md'), 'External edit outside the excerpt\n');
  const original = bytes(project);
  assert.throws(() => patchText(project, '脚本.md', { base_hash: read.base_hash, find: '第一句。', replace: '新句。' }), e => e.code === 'STALE_BASE_HASH');
  assert.deepEqual(bytes(project), original);
  assert.deepEqual(history(project), []);
});

test('duplicate find rejects by default, explicit exact count permits multiple literal replacements', t => {
  const project = fixture(t);
  fs.writeFileSync(path.join(project, '方案.md'), 'same + same + same');
  const read = readEditFile(project, '方案.md');
  assert.throws(() => patchText(project, '方案.md', { base_hash: read.base_hash, find: 'same', replace: 'new' }), /期望精确 1 处，实际 3 处/);
  // The failure must be actionable: the actual line of each hit, not just a count.
  assert.throws(() => patchText(project, '方案.md', { base_hash: read.base_hash, find: 'same', replace: 'new' }),
    /实际命中 3 处：第 1 行（第 1、8、15 个字符处）/);
  for (const expected_count of [0, -1, 1.2, NaN, Infinity, 1001, '3', 2]) assert.throws(() => patchText(project, '方案.md', { base_hash: read.base_hash, find: 'same', replace: 'new', expected_count }));
  assert.deepEqual(history(project), []);
  const result = patchText(project, '方案.md', { base_hash: read.base_hash, find: 'same', replace: '$&', expected_count: 3 });
  assert.equal(result.replacements, 3);
  assert.equal(bytes(project, '方案.md').toString(), '$& + $& + $&');
});

test('unchanged patches never create backup or replace inode/mtime', t => {
  const project = fixture(t), file = path.join(project, '脚本.md');
  const before = fs.statSync(file), read = readEditFile(project, '脚本.md');
  const result = patchText(project, '脚本.md', { base_hash: read.base_hash, find: '第一句。', replace: '第一句。' });
  assert.equal(result.changed, false);
  assert.equal(result.backup_path, null);
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(history(project), []);
  for (const args of [{ find: '' }, { find: 'absent' }, { find: '第一句。', replace: null }, { find: '第一句。', replace: '\0' }]) {
    assert.throws(() => patchText(project, '脚本.md', { base_hash: read.base_hash, replace: 'new', ...args }));
  }
});

test('private files, absolute paths, traversal, binary content and symlink targets are rejected', t => {
  const project = fixture(t), other = fixture(t);
  for (const relative of ['../脚本.md', './脚本.md', 'out/脚本.md', 'nested/../脚本.md', 'PROJECT.json', '.env', 'state.json', 'vh.config.json', path.join(other, '脚本.md')]) {
    assert.throws(() => readEditFile(project, relative), e => e.code === 'INVALID_PATH');
    assert.throws(() => patchText(project, relative, { base_hash: 'a'.repeat(64), find: 'x', replace: 'y' }), e => e.code === 'INVALID_PATH');
  }
  fs.symlinkSync(path.join(other, '脚本.md'), path.join(project, '方案.md'));
  assert.throws(() => readEditFile(project, '方案.md'), e => e.code === 'INVALID_PATH');
  assert.throws(() => patchText(project, '方案.md', { base_hash: hash(bytes(other)), find: '第一句。', replace: 'x' }));
  fs.writeFileSync(path.join(project, 'claims.json'), Buffer.from([0xff, 0xfe]));
  assert.throws(() => readEditFile(project, 'claims.json'), e => e.code === 'NOT_TEXT');
  fs.writeFileSync(path.join(project, 'claims.json'), 'nul\0byte');
  assert.throws(() => readEditFile(project, 'claims.json'), e => e.code === 'NOT_TEXT');
  assert.deepEqual(history(project), []);
});

test('history symlinks cannot send backups outside project', t => {
  const project = fixture(t), other = fixture(t);
  fs.symlinkSync(other, path.join(project, 'out'));
  const original = bytes(project), read = readEditFile(project, '脚本.md');
  assert.throws(() => patchText(project, '脚本.md', { base_hash: read.base_hash, find: '第一句。', replace: 'x' }), e => e.code === 'INVALID_HISTORY');
  assert.deepEqual(bytes(project), original);
  assert.equal(fs.existsSync(path.join(other, '.vh-edit-history')), false);
});

test('interrupted backup preparation or replacement rename leaves original source intact', t => {
  const project = fixture(t), source = fs.realpathSync(path.join(project, '脚本.md'));
  const original = bytes(project), read = readEditFile(project, '脚本.md');
  const rename = fs.renameSync;
  for (const failure of ['metadata', 'source']) {
    const mock = t.mock.method(fs, 'renameSync', (from, to) => {
      if ((failure === 'metadata' && String(to).endsWith('metadata.json')) || (failure === 'source' && to === source)) throw new Error('simulated interrupted preparation');
      return rename(from, to);
    });
    assert.throws(() => patchText(project, '脚本.md', { base_hash: read.base_hash, find: '第一句。', replace: 'new' }), /simulated interrupted/);
    mock.mock.restore();
    assert.deepEqual(bytes(project), original);
    assert.equal(fs.readdirSync(project).some(name => name.endsWith('.tmp')), false);
  }
});

test('external changes during preparation are rechecked before rename', t => {
  const project = fixture(t), file = path.join(project, '脚本.md'), read = readEditFile(project, '脚本.md');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (String(to).endsWith('metadata.json')) fs.appendFileSync(file, 'external edit');
  });
  assert.throws(() => patchText(project, '脚本.md', { base_hash: read.base_hash, find: '第一句。', replace: 'new' }), e => e.code === 'STALE_BASE_HASH');
  assert.ok(bytes(project).toString().endsWith('external edit'));
});

test('single-scene replacement preserves every other byte, separators, header and parseChunks numbering', t => {
  const project = fixture(t), source = path.join(project, 'scenes.src.js');
  const before = bytes(project, 'scenes.src.js').toString(), chunks = parseChunks(source);
  const read = readScene(project, 2);
  assert.equal(read.scene, 2);
  assert.equal(read.total_scenes, 3);
  assert.equal(read.base_hash, hash(Buffer.from(before)));
  assert.equal(read.scene_hash, hash(read.content));
  assert.equal(read.content, scene(2));
  const replacement = scene(20);
  const result = replaceScene(project, 2, { base_hash: read.base_hash, content: replacement });
  assert.equal(result.changed, true);
  assert.equal(result.scene, 2);
  assert.equal(result.total_scenes, 3);
  assert.equal(bytes(project, 'scenes.src.js').toString(), before.replace(scene(2), replacement));
  const after = parseChunks(source);
  assert.equal(after.length, 3);
  assert.equal(after[0], chunks[0]);
  assert.equal(after[1], replacement);
  assert.equal(after[2], chunks[2]);
  assert.deepEqual(fs.readFileSync(path.join(project, result.backup_path)), Buffer.from(before));
  const first = readScene(project, 1);
  replaceScene(project, 1, { base_hash: first.base_hash, content: scene(10) });
  assert.ok(bytes(project, 'scenes.src.js').toString().startsWith('// file header — keep me\n\n'));
  const last = readScene(project, 3);
  replaceScene(project, 3, { base_hash: last.base_hash, content: scene(30) });
  assert.ok(bytes(project, 'scenes.src.js').toString().endsWith('\n// final comment\n'));
});

test('unchanged scene avoids write; stale full-file CAS rejects even if selected scene is unchanged', t => {
  const project = fixture(t), file = path.join(project, 'scenes.src.js');
  const read = readScene(project, 1), before = fs.statSync(file);
  const result = replaceScene(project, 1, { base_hash: read.base_hash, content: read.content });
  assert.equal(result.changed, false);
  assert.equal(fs.statSync(file).ino, before.ino);
  assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
  assert.deepEqual(history(project), []);
  fs.appendFileSync(file, '\n// unrelated external change\n');
  const original = bytes(project, 'scenes.src.js');
  assert.throws(() => replaceScene(project, 1, { base_hash: read.base_hash, content: scene(8) }), e => e.code === 'STALE_BASE_HASH');
  assert.deepEqual(bytes(project, 'scenes.src.js'), original);
});

test('invalid scene JS, multiple expressions, false render matches and separators never write', t => {
  const project = fixture(t), read = readScene(project, 1), original = bytes(project, 'scenes.src.js');
  const invalid = [
    '', 'root => {', 'root => {}', 'root => ({nested:{render(){}}})', 'function(root) { return {render:42}; }',
    'root => { return {render(){}}; }, root => { return {render(){}}; }',
    'root => { if(root) /{/.test(""); return {render(){}}; }, root => { if(root) /}/.test(""); return {render(){}}; }',
    'root => { return {render(){}}; }; globalThis.executed = true',
    'root => { const s = "return { render() {} }"; }',
    'root => { /* return { render() {} } */ }',
    'root => { return {nested: {render(){}}}; }',
    'root => { return {render: 42}; }',
    'root => { return\n{render(){}} }',
    scene(1) + '\n//---\n' + scene(2),
    '// ' + 'x'.repeat(50000) + '\n' + scene(1),
  ];
  for (const content of invalid) assert.throws(() => replaceScene(project, 1, { base_hash: read.base_hash, content }), `should reject ${content.slice(0, 90)}`);
  assert.deepEqual(bytes(project, 'scenes.src.js'), original);
  assert.deepEqual(history(project), []);
});

test('scene validation supports templates, regex, comments and arrow render without executing anything', t => {
  const project = fixture(t);
  const variants = [
    'root => ({render(){}})',
    'function(root) { return {render(){}}; }',
    '(root) => { globalThis.__vhAuthorEditExecuted = true; return {render(){ throw new Error("never execute"); }}; }',
    '// @layout nested template\nroot => { const s = `hello ${`${{x: "}"}.x}`} world`; const re = /[{}]/g; return {render(t){ void s; void re; }}; }',
    'root => { return { render: (t) => { void t; } }; }',
    'root => { return { render: function(t) { void t; } }; }',
    'root => { return { other: 4, render(t) { const x = 6 / 2; void x; } }; } // trailing comment',
  ];
  for (const content of variants) {
    const read = readScene(project, 2);
    assert.equal(replaceScene(project, 2, { base_hash: read.base_hash, content }).changed, true);
    assert.equal(parseChunks(path.join(project, 'scenes.src.js')).length, 3);
  }
  assert.equal(globalThis.__vhAuthorEditExecuted, undefined);
});

test('missing files, bad hashes and out-of-range scenes do not write', t => {
  const project = fixture(t), original = bytes(project, 'scenes.src.js');
  for (const n of [0, -1, 4, 1.5, Infinity, '1']) {
    assert.throws(() => readScene(project, n), e => e.code === 'INVALID_SCENE_NUMBER');
    assert.throws(() => replaceScene(project, n, { base_hash: hash(original), content: scene(5) }));
  }
  for (const base_hash of [undefined, '', 'x', 'a'.repeat(64)]) assert.throws(() => replaceScene(project, 1, { base_hash, content: scene(5) }));
  assert.throws(() => readEditFile(project, 'claims.json'), /ENOENT/);
  assert.throws(() => patchText(project, 'claims.json', { base_hash: 'a'.repeat(64), find: 'x', replace: 'y' }), /ENOENT/);
  assert.deepEqual(bytes(project, 'scenes.src.js'), original);
  assert.deepEqual(history(project), []);
  fs.unlinkSync(path.join(project, 'scenes.src.js'));
  assert.throws(() => readScene(project, 1), /ENOENT/);
  assert.throws(() => replaceScene(project, 1, { base_hash: hash(original), content: scene(5) }), /ENOENT/);
  assert.equal(fs.existsSync(path.join(project, 'scenes.src.js')), false);
});
