import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assetInputs } from '../lib/asset-inputs.mjs';
import { publishInputs } from '../lib/publish.mjs';
import { coverStatus, render, parseCoverCopy } from '../lib/cover.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const image = color => `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="${color}"/></svg>`;
function fixture(t, files = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cover-assets-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const write = (name, bytes) => {
    const file = path.join(project, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  };
  for (const [name, bytes] of Object.entries({
    '脚本.md': '## S1\n1. 本地素材测试。',
    '发布文案.md': '## 封面文案\n主：本地素材',
    'scene.html': '<!doctype html><img src="images/chart.svg"><script>const DURATION=10; window.renderAt=()=>{};</script>',
    'images/chart.svg': image('#123456'),
    'out/.keep': '',
    ...files,
  })) write(name, bytes);
  return { base, project, write };
}

// Status-only fixtures exercise the receipt contract without browser/font dependencies.
function receipt(project, style = 'frame', { legacy = false } = {}) {
  // 封面身份只取封面主/副文案，与简介、标签的改动无关。
  const copy = parseCoverCopy(fs.readFileSync(path.join(project, '发布文案.md'), 'utf8'));
  const inputs = { ...publishInputs(project), coverCopyHash: sha(JSON.stringify(copy)) };
  if (style === 'frame') {
    inputs.sceneHash = sha(fs.readFileSync(path.join(project, 'scene.html')));
    const assets = assetInputs(project);
    if (!legacy && (assets.files.length || assets.issues.length)) inputs.assetSignature = assets.signature;
  }
  const dir = path.join(project, 'out/cover'); fs.mkdirSync(dir, { recursive: true });
  const files = ['16x9', '4x3', '3x4'].map(ratio => {
    const file = `cover-${ratio}.png`, bytes = Buffer.from('status fixture ' + ratio);
    fs.writeFileSync(path.join(dir, file), bytes);
    return { file, sha256: sha(bytes), size: bytes.length };
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ version: 1, style, inputs, files }));
}

test('frame render binds referenced image bytes; equal size/mtime changes invalidate with unchanged HTML', async t => {
  const { project } = fixture(t);
  const result = await render(project, { style: 'frame', at: 1 });
  assert.equal(result.ok, true, result.error);
  assert.equal(coverStatus(project).ok, true);
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'out/cover/manifest.json')));
  assert.equal(manifest.inputs.assetSignature, assetInputs(project).signature);
  const html = fs.readFileSync(path.join(project, 'scene.html'));
  const file = path.join(project, 'images/chart.svg'), stamp = fs.statSync(file);
  fs.writeFileSync(file, image('#654321')); fs.utimesSync(file, stamp.atime, stamp.mtime);
  assert.equal(fs.statSync(file).size, stamp.size);
  assert.deepEqual(fs.readFileSync(path.join(project, 'scene.html')), html);
  assert.equal(coverStatus(project).ok, false);
  fs.writeFileSync(file, image('#123456'));
  assert.equal(coverStatus(project).ok, true, 'identity depends on bytes, not mtimes');
});

test('referenced local font bytes outside assets/ invalidate frame covers, including non-UTF8 replacements', t => {
  const before = Buffer.from([0xff, 0xfe, 0, 1]), after = Buffer.from([0xfe, 0xff, 0, 1]);
  assert.equal(before.toString('utf8'), after.toString('utf8'));
  const { project, write } = fixture(t, {
    'scene.html': '<style>@font-face{font-family:local;src:url(fonts/local.woff2?v=1#face)}</style>',
    'fonts/local.woff2': before,
  });
  receipt(project); assert.equal(coverStatus(project).ok, true);
  write('fonts/local.woff2', after); assert.equal(coverStatus(project).ok, false);
  write('fonts/local.woff2', before); assert.equal(coverStatus(project).ok, true);
  fs.unlinkSync(path.join(project, 'fonts/local.woff2')); assert.equal(coverStatus(project).ok, false);
});

for (const change of ['replace', 'delete']) test(`frame dependencies are captured before the background screenshot; concurrent ${change} preserves previous covers`, async t => {
  const { project, write } = fixture(t);
  receipt(project);
  const manifest = path.join(project, 'out/cover/manifest.json');
  const before = fs.readFileSync(manifest), oldImage = fs.readFileSync(path.join(project, 'out/cover/cover-16x9.png'));
  const realRead = fs.readFileSync, scene = path.join(project, 'scene.html');
  let reads = 0;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    // The second direct scene read is grabFrameClean's duration lookup. The asset
    // scanner uses bounded readSync; it does not affect this deterministic hook.
    if (String(file) === scene && ++reads === 2) {
      if (change === 'replace') write('images/chart.svg', image('#654321'));
      else fs.unlinkSync(path.join(project, 'images/chart.svg'));
    }
    return realRead(file, ...args);
  });
  const result = await render(project, { style: 'frame', at: 1 });
  assert.equal(result.ok, false); assert.match(result.error, /生成期间.*本地素材依赖改变/);
  assert.ok(reads >= 2);
  assert.deepEqual(fs.readFileSync(manifest), before);
  assert.deepEqual(fs.readFileSync(path.join(project, 'out/cover/cover-16x9.png')), oldImage);
  assert.equal(fs.readdirSync(path.join(project, 'out/cover')).some(name => name.startsWith('.cover-')), false);
});

test('editorial render stays independent of local assets, scene HTML and unsafe body references', async t => {
  const { base, project, write } = fixture(t);
  const result = await render(project, { style: 'editorial' });
  assert.equal(result.ok, true, result.error);
  const manifest = JSON.parse(fs.readFileSync(path.join(project, 'out/cover/manifest.json')));
  assert.equal(Object.hasOwn(manifest.inputs, 'assetSignature'), false);
  assert.equal(Object.hasOwn(manifest.inputs, 'sceneHash'), false);
  write('images/chart.svg', image('#654321')); write('assets/unused.png', 'unused');
  write('scene.html', '<img src="../outside.png"><img src="images/link.png">');
  fs.writeFileSync(path.join(base, 'outside.png'), 'outside test fixture');
  fs.symlinkSync(path.join(base, 'outside.png'), path.join(project, 'images/link.png'));
  assert.equal(coverStatus(project).ok, true);
  fs.unlinkSync(path.join(project, 'scene.html'));
  assert.equal(coverStatus(project).ok, true);
  write('发布文案.md', '## 封面文案\n主：修改文案'); assert.equal(coverStatus(project).ok, false);
});

test('只改简介/标签/置顶评论不作废封面；改封面主副文案或图片字节才失效', async t => {
  const { project, write } = fixture(t);
  const result = await render(project, { style: 'editorial' });
  assert.equal(result.ok, true, result.error);
  assert.equal(coverStatus(project).ok, true);
  const coverSection = '## 封面文案\n主：本地素材\n副：' ;
  write('发布文案.md', coverSection + '\n\n## 简介\n\n补一段正文。\n\n## 标签\n\nAI\n');
  assert.equal(coverStatus(project).ok, true, '简介/标签改动不应让封面过期');
  write('发布文案.md', '## 封面文案\n主：改过的标题');
  assert.equal(coverStatus(project).ok, false);
  write('发布文案.md', coverSection + '\n');
  assert.equal(coverStatus(project).ok, true);
  const png = path.join(project, 'out/cover/cover-16x9.png');
  fs.writeFileSync(png, Buffer.concat([fs.readFileSync(png), Buffer.from('x')]));
  const tampered = coverStatus(project);
  assert.equal(tampered.ok, false); assert.equal(tampered.code, 'tampered');
});

test('legacy frame receipts with assets expire; asset-free legacy and editorial receipts remain valid', t => {
  const { project, write } = fixture(t);
  receipt(project, 'frame', { legacy: true }); assert.equal(coverStatus(project).ok, false);
  write('scene.html', '<script>const DURATION=10;</script>');
  receipt(project, 'frame', { legacy: true }); assert.equal(coverStatus(project).ok, true);
  receipt(project, 'editorial', { legacy: true }); assert.equal(coverStatus(project).ok, true);
});

test('unsafe/missing frame dependencies cannot be laundered by a matching signature or read outside the project', async t => {
  const { base, project, write } = fixture(t);
  const outside = path.join(base, 'outside.png'); fs.writeFileSync(outside, 'outside test fixture');
  fs.symlinkSync(outside, path.join(project, 'images/link.png'));
  const realOpen = fs.openSync, realRead = fs.readFileSync, forbiddenReads = [];
  const forbidden = new Set([outside, path.join(project, 'images/link.png')]);
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (forbidden.has(String(file))) { forbiddenReads.push(String(file)); throw new Error('outside read forbidden'); }
    return realOpen(file, ...args);
  });
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (forbidden.has(String(file))) { forbiddenReads.push(String(file)); throw new Error('outside read forbidden'); }
    return realRead(file, ...args);
  });
  for (const ref of ['../outside.png', '%2e%2e/outside.png', 'images/link.png', 'images/missing.png']) {
    write('scene.html', `<img src="${ref}"><script>const DURATION=10;</script>`);
    receipt(project);
    const before = fs.readFileSync(path.join(project, 'out/cover/manifest.json'));
    assert.equal(coverStatus(project).ok, false, ref);
    const result = await render(project, { style: 'frame', at: 1 });
    assert.equal(result.ok, false, ref); assert.match(result.error, /本地素材依赖无效/);
    assert.deepEqual(fs.readFileSync(path.join(project, 'out/cover/manifest.json')), before);
    assert.equal(fs.existsSync(path.join(project, 'out/cover-bg.jpg')), false, 'reject before browser capture');
  }
  const scene = path.join(project, 'scene.html');
  fs.unlinkSync(scene); fs.symlinkSync(outside, scene); forbidden.add(scene);
  assert.equal(coverStatus(project).ok, false);
  const result = await render(project, { style: 'frame', at: 1 });
  assert.equal(result.ok, false); assert.match(result.error, /symlink: scene.html/);
  assert.deepEqual(forbiddenReads, [], 'neither dependency checks nor direct scene hashing follow symlinks');
});
