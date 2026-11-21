import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetInputs } from '../lib/asset-inputs.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-asset-inputs-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  const write = (file, bytes) => {
    fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
    fs.writeFileSync(path.join(project, file), bytes);
  };
  return { base, project, write };
}

test('comments are documentation, not loaded assets; real string literals still count', t => {
  const { project, write } = fixture(t);
  write('assets/chart.svg', '<svg/>');
  write('scenes.src.js', '// 用法：videoEl(root, "assets/demo.mp4")\n/* 另一个示例 assets/other.mp4 */\n'
    + 'const real = "assets/chart.svg";\nconst remote = "https://example.invalid/a//b.png";\n'
    + 'const svg = `<svg><filter id="n"></filter><rect filter="url(#n)"/></svg>`;\n');
  write('engine.tpl.html', '<script>const usage = "assets/missing-in-script.mp4";</script>'
    + '<script>// 示例 assets/demo.mp4\nconst real = "assets/chart.svg";</script>');
  write('scene.html', '<img src="assets/chart.svg">\n<!-- <img src="assets/in-html-comment.png"> -->\n');
  const result = assetInputs(project);
  assert.ok(!result.issues.some(issue => /demo\.mp4|other\.mp4|in-html-comment/.test(issue)), JSON.stringify(result.issues));
  assert.ok(!result.issues.some(issue => issue === 'missing: assets/missing-in-script.mp4'), 'real script literal must still be checked');
  assert.deepEqual(result.files.map(f => f.file), ['assets/chart.svg']);
});

test('same name/size/mtime binary replacement changes content signature', t => {
  const { project, write } = fixture(t);
  const beforeBytes = Buffer.from([0xff, 0xfe, 0, 1]), afterBytes = Buffer.from([0xfe, 0xff, 0, 1]);
  // Both byte sequences become the same text if wrongly decoded as UTF-8.
  assert.equal(beforeBytes.toString('utf8'), afterBytes.toString('utf8'));
  write('assets/chart.svg', beforeBytes);
  const stamp = new Date('2020-01-01T00:00:00Z'), target = path.join(project, 'assets/chart.svg');
  fs.utimesSync(target, stamp, stamp);
  const before = assetInputs(project);
  fs.writeFileSync(target, afterBytes); fs.utimesSync(target, stamp, stamp);
  const after = assetInputs(project);
  assert.notEqual(after.signature, before.signature);
  assert.deepEqual(before.files, [{ file: 'assets/chart.svg', sha256: hash(beforeBytes), size: 4 }]);
  assert.equal(after.files[0].sha256, hash(afterBytes));
  assert.equal(fs.statSync(target).mtimeMs, stamp.getTime());
  assert.deepEqual(after.issues, []);
});

test('all unused, nested, hidden and non-media assets conservatively invalidate', t => {
  const { project, write } = fixture(t);
  write('assets/nested/unused.png', 'old');
  write('assets/.hidden', 'hidden');
  write('assets/data.csv', 'a,b');
  const before = assetInputs(project);
  assert.deepEqual(before.files.map(f => f.file), ['assets/.hidden', 'assets/data.csv', 'assets/nested/unused.png']);
  write('assets/nested/unused.png', 'new');
  assert.notEqual(assetInputs(project).signature, before.signature);
});

test('root sources cover fonts, CSS urls, HTML attributes and VH_UI media literals', t => {
  const { project, write } = fixture(t);
  write('engine.tpl.html', `<style>@font-face { src: url(fonts/local.woff2?v=1#font) }
    .hero { background: url("images/cover.png") }</style><img src=images/unquoted.jpg>`);
  write('scenes.src.js', `VH_UI.shotEl('images/shot.webp'); VH_UI.videoEl("clips/intro.mp4");
    const prose = "don't pair this apostrophe with a resource quote";
    const markup = \`<img src="images/template.gif">\`;`);
  write('scene.html', `<audio src="audio/voice.wav"></audio><img src="./images/cover.png#again">`);
  const resources = ['fonts/local.woff2', 'images/cover.png', 'images/unquoted.jpg', 'images/shot.webp',
    'clips/intro.mp4', 'images/template.gif', 'audio/voice.wav'];
  for (const file of resources) write(file, Buffer.from([0, 255, 7]));
  const before = assetInputs(project);
  assert.deepEqual(before.files.map(f => f.file), resources.sort());
  assert.deepEqual(before.issues, []);
  write('fonts/local.woff2', Buffer.from([0, 254, 7]));
  assert.notEqual(assetInputs(project).signature, before.signature);
});

test('external URLs, data/blob URLs and anchors never trigger network or filesystem access', t => {
  const { project, write } = fixture(t);
  write('scene.html', `<img src="https://example.invalid/image.png"><img src="//example.invalid/a.jpg">
    <audio src="HTTP://example.invalid/music.mp3"></audio><img src="data:image/svg+xml,icon.svg">
    <img src="blob:local/example.png"><img src="#symbol.svg"><img src="file:///outside/image.png">`);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('network forbidden'); });
  const realOpen = fs.openSync, opened = [];
  t.mock.method(fs, 'openSync', (file, ...args) => { opened.push(file); return realOpen(file, ...args); });
  const result = assetInputs(project);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.issues, []);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.deepEqual(opened.map(f => path.basename(f)), ['scene.html']);
});

test('deleted references produce signed missing issues, restoring bytes restores identity', t => {
  const { project, write } = fixture(t);
  write('scene.html', '<img src="assets/chart.svg"><img src="images/missing.png">');
  write('assets/chart.svg', '<svg/>'); write('images/missing.png', 'image');
  const before = assetInputs(project);
  fs.unlinkSync(path.join(project, 'assets/chart.svg'));
  fs.unlinkSync(path.join(project, 'images/missing.png'));
  const after = assetInputs(project);
  assert.notEqual(after.signature, before.signature);
  assert.deepEqual(after.files, []);
  assert.ok(after.issues.some(issue => issue.startsWith('missing: assets/chart.svg')));
  assert.ok(after.issues.some(issue => issue.startsWith('missing: images/missing.png')));
  write('assets/chart.svg', '<svg/>'); write('images/missing.png', 'image');
  assert.deepEqual(assetInputs(project), before);
});

test('symlink files/directories, sources and assets root are never followed', t => {
  const { base, project, write } = fixture(t);
  const external = path.join(base, 'outside');
  fs.mkdirSync(external); fs.writeFileSync(path.join(external, 'private.png'), 'fixture-only-not-a-secret');
  write('assets/real.png', 'real');
  fs.symlinkSync(path.join(external, 'private.png'), path.join(project, 'assets/link.png'));
  fs.symlinkSync(external, path.join(project, 'assets/directory'));
  fs.symlinkSync('real.png', path.join(project, 'assets/internal.png'));
  fs.symlinkSync(external, path.join(project, 'images'));
  fs.symlinkSync(path.join(external, 'private.png'), path.join(project, 'engine.tpl.html'));
  write('scene.html', '<img src="images/private.png">');
  const realOpen = fs.openSync, opened = [];
  t.mock.method(fs, 'openSync', (file, ...args) => { opened.push(file); return realOpen(file, ...args); });
  const before = assetInputs(project);
  assert.deepEqual(before.files.map(f => f.file), ['assets/real.png']);
  for (const file of ['assets/link.png', 'assets/directory', 'assets/internal.png', 'images', 'engine.tpl.html']) {
    assert.ok(before.issues.includes(`symlink: ${file}`), file);
  }
  assert.ok(opened.every(file => ['scene.html', 'real.png'].includes(path.basename(file))));
  fs.writeFileSync(path.join(external, 'private.png'), 'different external fixture');
  assert.deepEqual(assetInputs(project), before);

  const other = path.join(base, 'other'); fs.mkdirSync(other);
  fs.symlinkSync(external, path.join(other, 'assets'));
  assert.deepEqual(assetInputs(other).issues, ['symlink: assets']);
});

test('traversal and absolute external paths are signed issues without reading outside', t => {
  const { base, project, write } = fixture(t);
  const external = path.join(base, 'outside.png'); fs.writeFileSync(external, 'fixture');
  write('scene.html', `<img src="../outside.png"><img src="%2e%2e/outside.png"><img src="${external}">`);
  const realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    assert.notEqual(file, external); return realOpen(file, ...args);
  });
  const blocked = assetInputs(project);
  assert.deepEqual(blocked.files, []);
  assert.deepEqual(blocked.issues, ['outside-project: ../outside.png']);
  write('scene.html', '');
  assert.notEqual(assetInputs(project).signature, blocked.signature);
});

test('ordering and identity are independent of insertion order, project location and mtime', t => {
  const first = fixture(t), second = fixture(t);
  for (const file of ['assets/z.png', 'assets/A.svg', 'assets/nested/b.wav']) first.write(file, file);
  for (const file of ['assets/nested/b.wav', 'assets/A.svg', 'assets/z.png']) second.write(file, file);
  first.write('scene.html', '<img src="missing/z.png"><img src="missing/a.png">');
  second.write('scene.html', '<img src="missing/a.png"><img src="missing/z.png">');
  fs.utimesSync(path.join(first.project, 'assets/A.svg'), 1, 1);
  assert.deepEqual(assetInputs(first.project), assetInputs(second.project));
});

test('absent or empty assets produce a stable empty signature; no arbitrary directory scan', t => {
  const { project, write } = fixture(t);
  const before = assetInputs(project);
  fs.mkdirSync(path.join(project, 'assets'));
  write('images/not-referenced.png', 'untracked by design');
  write('scene.html', `const text = 'ordinary text ending in fake.png'; const config = 'private.json';
    const dynamic = 'images/' + name + '.png'; const template = \`images/\${name}.png\`;`);
  assert.deepEqual(assetInputs(project), before);
  assert.match(before.signature, /^[a-f\d]{64}$/);
});

test('read failures and non-regular references are explicit signed states', t => {
  const { project, write } = fixture(t);
  write('assets/denied.mp4', 'video');
  write('scene.html', '<img src="images/directory.png">');
  fs.mkdirSync(path.join(project, 'images/directory.png'), { recursive: true });
  const before = assetInputs(project), realOpen = fs.openSync;
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (file.endsWith('denied.mp4')) throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
    return realOpen(file, ...args);
  });
  const after = assetInputs(project);
  assert.notEqual(after.signature, before.signature);
  assert.ok(after.issues.includes('unreadable: assets/denied.mp4 (EACCES)'));
  assert.ok(after.issues.includes('not-file: images/directory.png'));
});

test('large binary and chunk-boundary source literals use bounded synchronous reads', t => {
  const { project, write } = fixture(t);
  const bytes = Buffer.alloc(1024 * 1024 + 17, 0xfe);
  write('assets/large.mp4', bytes); write('fonts/boundary.woff2', 'font');
  write('engine.tpl.html', ' '.repeat(64 * 1024 - 12) + '<style>url(fonts/boundary.woff2)</style>');
  write('scene.html', ' '.repeat(64 * 1024 - 5) + '"fonts/boundary.woff2"');
  const realRead = fs.readSync, sizes = [];
  t.mock.method(fs, 'readSync', (fd, buffer, offset, length, position) => {
    sizes.push(length); return realRead(fd, buffer, offset, length, position);
  });
  t.mock.method(fs, 'readFileSync', () => { throw new Error('whole-file reads forbidden'); });
  const result = assetInputs(project);
  assert.deepEqual(result.files, [
    { file: 'assets/large.mp4', sha256: hash(bytes), size: bytes.length },
    { file: 'fonts/boundary.woff2', sha256: hash('font'), size: 4 },
  ]);
  assert.deepEqual(result.issues, []);
  assert.ok(sizes.length > 16);
  assert.ok(sizes.every(size => size <= 64 * 1024));
});
