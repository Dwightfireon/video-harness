import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createPublicPackage, createPublicPackageWriter } from '../lib/public-package.mjs';
import { createArtifactRecord, currentArtifactInputs, hashFile, mediaFingerprint } from '../lib/artifact-status.mjs';
import { confirmPublishRevision, publishRevision } from '../lib/publish.mjs';
import { exportSubtitles } from '../lib/subtitle-export.mjs';
import { initReviewSnapshot } from '../lib/release-review.mjs';
import { productionQuality } from '../lib/production-quality.mjs';

const secret = '内部敏感人名不可公开';
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-public-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'), out = path.join(root, 'package'), p = n => path.join(project, n);
  fs.mkdirSync(p('out/stills'), { recursive: true });
  fs.mkdirSync(p('references'));
  for (const [name, text] of Object.entries({
    'PROJECT.json': '{}', '脚本.md': '## S1 · 公开稿\n1. 受访者介绍窗口。\n',
    'scenes.src.js': '// public scene', 'engine.tpl.html': "const ORIENT = 'landscape';", 'timing.json': '{}',
    'scene.html': `const DURATION = 0.4; const ORIENT = 'landscape'; const SUBS = [{"s":0,"e":0.4,"t":"受访者介绍窗口。"}]; addScene(0, 0.4, () => {});`,
    '发布文案.md': '## 标题\n公开标题\n## 简介\n公开简介。\n## 置顶评论\n欢迎交流。\n## 标签\n测试\n## 封面文案\n主：公开窗口\n## 发布前检查清单\n- [ ] 人工看过并听过\n',
    '方案.md': secret, 'claims.json': JSON.stringify({ secret }), '审查-解释.md': secret, '审查.md': secret,
    '原文.md': secret, 'publish.md': secret, 'references/publish.md': secret, 'out/stills/unlisted.txt': secret,
    'out/cover.png': secret,
  })) fs.writeFileSync(p(name), text);
  for (const audio of [false, true]) {
    const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x36:r=30:d=0.4'];
    if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:d=0.4', '-shortest');
    args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
    if (audio) args.push('-c:a', 'aac');
    args.push(p(audio ? 'out/video-voice.mp4' : 'out/video.mp4'));
    const result = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
  }
  const state = { genStamp: { scriptHash: hashFile(p('脚本.md')), scenesHash: hashFile(p('scenes.src.js')) },
    render: { artifact: createArtifactRecord(project, 'render') }, voice: { artifact: createArtifactRecord(project, 'voice') } };
  const save = () => fs.writeFileSync(p('out/.vh-state.json'), JSON.stringify(state));
  save(); exportSubtitles(project);
  const revision = publishRevision(project);
  confirmPublishRevision(project, revision);
  return { root, project, out, p, state, save };
}
function assertClean(f) {
  assert.equal(fs.existsSync(f.out), false);
  assert.deepEqual(fs.readdirSync(f.root), ['project']);
}
function trackStills(f) {
  fs.writeFileSync(f.p('out/stills/s-01.jpg'), 'synthetic still fixture');
  const media = mediaFingerprint(f.p('out/stills/s-01.jpg'));
  f.state.lastStills = { sourceSignature: currentArtifactInputs(f.project).sourceSignature,
    files: [{ file: 's-01.jpg', sha256: media.sha256, size: media.size }] };
  f.save();
}

test('public allowlist excludes sensitive internal material; manifest hashes match all delivered files', t => {
  const f = fixture(t), result = createPublicPackage(f.project, f.out);
  assert.equal(result.outDir, f.out);
  assert.equal(result.deliveryReady, true); assert.equal(result.releaseReady, false); assert.equal(result.review.required, false);
  assert.deepEqual(result.copied.map(c => c.file).sort(), ['video-voice.mp4', 'video.mp4', '脚本.md', '发布文案.md', 'subtitles.srt'].sort());
  assert.match(result.warnings.join('\n'), /封面/);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.sourceSignature, currentArtifactInputs(f.project).sourceSignature);
  assert.equal(manifest.qualityGateOverride, false);
  assert.equal(manifest.humanReview, 'not-verified-by-packager');
  assert.equal(manifest.deliveryReady, true);
  assert.equal(manifest.releaseReady, false);
  assert.equal(manifest.status, 'draft', 'backward-compatible status is not an unfinished delivery');
  assert.equal(manifest.review.required, false);
  assert.equal(manifest.review.state, 'pending');
  assert.equal(manifest.workflow, 'content-first');
  assert.equal(manifest.qualityProfile, 'technical');
  assert.equal(fs.existsSync(f.p('review.json')), false);
  assert.doesNotMatch(result.warnings.join('\n'), /待审包/);
  assert.equal(manifest.files.length, result.copied.length + 1);
  assert.deepEqual(fs.readdirSync(f.out).sort(), [...manifest.files.map(e => e.file), 'manifest.json'].sort());
  for (const entry of manifest.files) {
    const file = path.join(f.out, entry.file);
    assert.equal(entry.sha256, sha(file)); assert.equal(entry.bytes, fs.statSync(file).size);
  }
  for (const name of fs.readdirSync(f.out)) assert.equal(fs.readFileSync(path.join(f.out, name)).includes(Buffer.from(secret)), false, name);
  assert.match(fs.readFileSync(path.join(f.out, '交付说明.md'), 'utf8'), /不声称人工看过、听过/);
  assert.match(fs.readFileSync(path.join(f.out, '交付说明.md'), 'utf8'), /已就绪（人工审阅可选/);
});

test('old subtitle is omitted with actionable warning; source is not rewritten', t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('out/subtitles.srt'), secret);
  const result = createPublicPackage(f.project, f.out);
  assert.equal(fs.existsSync(path.join(f.out, 'subtitles.srt')), false);
  assert.match(result.warnings.join('\n'), /vh subtitles/);
  assert.equal(fs.readFileSync(f.p('out/subtitles.srt'), 'utf8'), secret);
});

test('existing output (including empty directories) is refused and never cleaned', t => {
  const f = fixture(t); fs.mkdirSync(f.out);
  assert.throws(() => createPublicPackage(f.project, f.out), /输出目录已存在/);
  fs.writeFileSync(path.join(f.out, '发布文案.md'), '用户旧文案');
  assert.throws(() => createPublicPackage(f.project, f.out, { target: 'video', force: true }), /已有发布文案.md/);
  assert.equal(fs.readFileSync(path.join(f.out, '发布文案.md'), 'utf8'), '用户旧文案');
  assert.deepEqual(fs.readdirSync(f.out), ['发布文案.md']);
});

test('video target omits even invalid publish copy; force cannot make invalid copy a publish package', t => {
  const f = fixture(t); fs.writeFileSync(f.p('发布文案.md'), '## 标题\nTODO\n');
  assert.throws(() => createPublicPackage(f.project, f.out, { force: true }), /发布包不完整/);
  assertClean(f);
  const result = createPublicPackage(f.project, f.out, { target: 'video', force: true });
  assert.equal(fs.existsSync(path.join(f.out, '发布文案.md')), false);
  assert.match(result.warnings.join('\n'), /force.*原有质量门槛/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json'))).qualityGateOverride, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json'))).status, 'draft');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json'))).releaseReady, false);
  assert.match(fs.readFileSync(path.join(f.out, '交付说明.md'), 'utf8'), /待审（不是发布通过）/);
});

test('explicit release requires current complete review; force can only export a draft', t => {
  const f = fixture(t);
  assert.throws(() => createPublicPackage(f.project, f.out, { release: true }), /发布验收未通过/);
  assertClean(f);
  assert.throws(() => createPublicPackage(f.project, f.out, { release: true, force: true }), /不能与 force/);
  fs.writeFileSync(f.p('claims.json'), '[]');
  const doc = initReviewSnapshot(f.project);
  for (const category of ['content', 'visual', 'audio']) doc.reviews[category] = { status: 'pass', notes: 'synthetic test fixture, not a human review', evidence: ['审查.md'] };
  doc.reviews.audio.status = 'pending'; fs.writeFileSync(f.p('review.json'), JSON.stringify(doc));
  assert.throws(() => createPublicPackage(f.project, f.out, { release: true }), /audio/);
  doc.reviews.audio.status = 'pass'; fs.writeFileSync(f.p('review.json'), JSON.stringify(doc));
  createPublicPackage(f.project, f.out, { release: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.releaseReady, true); assert.equal(manifest.status, 'release-review-recorded');
  assert.equal(manifest.deliveryReady, true); assert.equal(manifest.review.required, true);
});

test('audited policy requires release review for plain library export; explicit draft preserves pending review', t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  assert.throws(() => createPublicPackage(f.project, f.out), /发布验收未通过/);
  assertClean(f);
  createPublicPackage(f.project, f.out, { draft: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.deliveryReady, true); assert.equal(manifest.releaseReady, false);
  assert.equal(manifest.review.required, true); assert.equal(manifest.review.state, 'pending');
  assert.equal(manifest.qualityProfile, 'strict'); assert.equal(manifest.humanReview, 'not-verified-by-packager');
});

test('audited ordinary library export accepts a bound review without release option', t => {
  const f = fixture(t);
  fs.writeFileSync(f.p('PROJECT.json'), JSON.stringify({ workflow: { profile: 'audited' } }));
  fs.writeFileSync(f.p('claims.json'), '[]');
  const doc = initReviewSnapshot(f.project);
  for (const category of ['content', 'visual', 'audio']) doc.reviews[category] = { status: 'pass', notes: 'synthetic test fixture, not a human review', evidence: ['审查.md'] };
  fs.writeFileSync(f.p('review.json'), JSON.stringify(doc));
  createPublicPackage(f.project, f.out);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.review.required, true); assert.equal(manifest.releaseReady, true);
  assert.equal(manifest.humanReview, 'not-verified-by-packager');
});

test('automatic content-first packaging validates a technical final receipt rather than requiring strict visual audit', async t => {
  const f = fixture(t), text = '受访者介绍窗口。';
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  fs.writeFileSync(f.p('PROJECT.json'), JSON.stringify({ automation: { enabled: true, maxRepairs: 2 } }));
  fs.writeFileSync(f.p('timing.json'), JSON.stringify({ schemaVersion: 1, textHash: digest([text]), groupsHash: digest([[text]]),
    measurement: { voice: 'test', speed: 1 }, dur: .4, scenes: [[0, .4]], subs: [{ s: 0, e: .4, t: text }] }));
  f.state.render.artifact = createArtifactRecord(f.project, 'render');
  f.state.voice.artifact = createArtifactRecord(f.project, 'voice'); f.save(); exportSubtitles(f.project);
  const quality = await productionQuality(f.project, { profile: 'technical', phase: 'final', checkers: {
    subtitles: () => ({ ok: true, cues: 1, probes: 3, errors: [], failures: [] }),
    contrast: () => { throw new Error('technical must not run visual audit'); },
    layout: () => { throw new Error('technical must not run visual audit'); },
  } });
  assert.equal(quality.ok, true, JSON.stringify(quality));
  createPublicPackage(f.project, f.out);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  assert.equal(manifest.deliveryReady, true); assert.equal(manifest.review.required, false);
  assert.equal(manifest.qualityProfile, 'technical'); assert.equal(manifest.releaseReady, false);
  fs.appendFileSync(f.p('out/video-voice.mp4'), 'media changed');
  assert.throws(() => createPublicPackage(f.project, path.join(f.root, 'changed')), /不能打包未完成|质量回执无效/);
});

test('release cannot survive changing a bound review evidence file during copying', t => {
  const f = fixture(t); fs.writeFileSync(f.p('claims.json'), '[]');
  const doc = initReviewSnapshot(f.project);
  for (const category of ['content', 'visual', 'audio']) doc.reviews[category] = { status: 'pass', notes: 'synthetic test fixture', evidence: ['审查.md'] };
  fs.writeFileSync(f.p('review.json'), JSON.stringify(doc));
  let changed = false;
  const writer = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
    fs.copyFileSync(source, dest, flags);
    if (!changed) { changed = true; fs.appendFileSync(f.p('审查.md'), 'new'); }
  } });
  assert.throws(() => writer(f.project, f.out, { release: true }), /变化|改变/); assertClean(f);
});

test('force never allows missing audio or corrupt media', t => {
  const f = fixture(t);
  fs.copyFileSync(f.p('out/video.mp4'), f.p('out/video-voice.mp4'));
  assert.throws(() => createPublicPackage(f.project, f.out, { force: true }), /不能打包未完成的视频/);
  assertClean(f);
  fs.writeFileSync(f.p('out/video-voice.mp4'), 'invalid');
  assert.throws(() => createPublicPackage(f.project, f.out, { force: true }), /不能打包未完成的视频/);
  assertClean(f);
});

test('force cannot bypass changed author inputs or a stale publish revision', t => {
  const f = fixture(t);
  fs.appendFileSync(f.p('scenes.src.js'), '\n// changed author input');
  assert.throws(() => createPublicPackage(f.project, f.out, { force: true }), /不能打包未完成的视频/);
  assertClean(f);
  fs.writeFileSync(f.p('scenes.src.js'), '// public scene');
  fs.writeFileSync(f.p('out/.vh-brief.json'), JSON.stringify({ must: ['新的明确要求'] }));
  assert.throws(() => createPublicPackage(f.project, f.out, { force: true }), /发布包不完整.*旧稿/);
  assertClean(f);
});

test('missing subtitles are optional and never trigger generation or remuxing', t => {
  const f = fixture(t), before = sha(f.p('out/video-voice.mp4'));
  fs.unlinkSync(f.p('out/subtitles.srt'));
  const result = createPublicPackage(f.project, f.out);
  assert.equal(fs.existsSync(f.p('out/subtitles.srt')), false);
  assert.equal(fs.existsSync(path.join(f.out, 'subtitles.srt')), false);
  assert.equal(sha(f.p('out/video-voice.mp4')), before);
  assert.match(result.warnings.join('\n'), /vh subtitles/);
});

test('explicit stills require a current, exact receipt and copy only listed files', t => {
  const f = fixture(t);
  assert.throws(() => createPublicPackage(f.project, f.out, { withStills: true }), /缺少当前输入签名/);
  trackStills(f);
  f.state.lastStills.sourceSignature = 'old'; f.save();
  assert.throws(() => createPublicPackage(f.project, f.out, { withStills: true }), /缺少当前输入签名/);
  f.state.lastStills.sourceSignature = currentArtifactInputs(f.project).sourceSignature; f.save();
  fs.appendFileSync(f.p('out/stills/s-01.jpg'), 'changed');
  assert.throws(() => createPublicPackage(f.project, f.out, { withStills: true }), /指纹不符/);
  assertClean(f);
  trackStills(f);
  fs.writeFileSync(f.p('out/stills/s-99.jpg'), secret);
  const result = createPublicPackage(f.project, f.out, { withStills: true });
  assert.deepEqual(fs.readdirSync(path.join(f.out, 'stills')), ['s-01.jpg']);
  assert.ok(result.copied.some(c => c.file === 'stills/s-01.jpg'));
  const manifest = JSON.parse(fs.readFileSync(path.join(f.out, 'manifest.json')));
  for (const entry of manifest.files) assert.equal(entry.sha256, sha(path.join(f.out, entry.file)));
});

test('unsafe still paths, duplicate entries, or absent file fingerprints are refused', t => {
  const f = fixture(t); trackStills(f);
  const good = f.state.lastStills.files[0];
  for (const files of [[{ ...good, file: '../脚本.md' }], [good, good], [{ file: good.file }], []]) {
    f.state.lastStills.files = files; f.save();
    assert.throws(() => createPublicPackage(f.project, f.out, { withStills: true }), /回执/);
    assertClean(f);
  }
});

for (const relative of ['脚本.md', 'scene.html', 'out/video-voice.mp4', '发布文案.md', 'out/.vh-state.json', 'out/.vh-brief.json']) {
  test(`source change during copying aborts and removes only staging: ${relative}`, t => {
    const f = fixture(t); let changed = false;
    const writer = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
      fs.copyFileSync(source, dest, flags);
      if (!changed) { changed = true; fs.appendFileSync(f.p(relative), '\nchanged'); }
    } });
    assert.throws(() => writer(f.project, f.out), /变化|改变|JSON|Unexpected/);
    assertClean(f);
  });
}

test('copy failure and corrupted destination leave no apparently completed package', t => {
  const f = fixture(t);
  const failed = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
    fs.copyFileSync(source, dest, flags); throw new Error('injected copy failure');
  } });
  assert.throws(() => failed(f.project, f.out), /injected copy failure/); assertClean(f);
  const corrupted = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
    fs.copyFileSync(source, dest, flags); fs.appendFileSync(dest, 'corruption');
  } });
  assert.throws(() => corrupted(f.project, f.out), /SHA/); assertClean(f);
});

test('freshly re-recording changed inputs during copying cannot certify the mixed package', t => {
  const f = fixture(t); let changed = false;
  const writer = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
    fs.copyFileSync(source, dest, flags);
    if (!changed) {
      changed = true;
      fs.appendFileSync(f.p('脚本.md'), '2. 新增旁白。\n');
      f.state.genStamp.scriptHash = hashFile(f.p('脚本.md'));
      f.state.render.artifact = createArtifactRecord(f.project, 'render');
      f.state.voice.artifact = createArtifactRecord(f.project, 'voice');
      f.save();
      confirmPublishRevision(f.project, publishRevision(f.project));
    }
  } });
  assert.throws(() => writer(f.project, f.out), /来源发生变化|输入签名.*变化/);
  assertClean(f);
});

test('late changes to already copied targets and still sources are rejected', t => {
  const f = fixture(t); trackStills(f); let firstDestination;
  const writer = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
    fs.copyFileSync(source, dest, flags);
    if (!firstDestination) firstDestination = dest;
    else fs.appendFileSync(firstDestination, 'late mutation');
  } });
  assert.throws(() => writer(f.project, f.out, { withStills: true }), /SHA/); assertClean(f);
  let changed = false;
  const stillWriter = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
    fs.copyFileSync(source, dest, flags);
    if (!changed) { changed = true; fs.appendFileSync(f.p('out/stills/s-01.jpg'), 'late mutation'); }
  } });
  assert.throws(() => stillWriter(f.project, f.out, { withStills: true }), /变化/); assertClean(f);
});

test('destination created during copying is preserved, not merged or removed', t => {
  const f = fixture(t); let created = false;
  const writer = createPublicPackageWriter({ copyFileSync(source, dest, flags) {
    fs.copyFileSync(source, dest, flags);
    if (!created) { created = true; fs.mkdirSync(f.out); fs.writeFileSync(path.join(f.out, 'user.txt'), 'keep me'); }
  } });
  assert.throws(() => writer(f.project, f.out), /输出目录已存在/);
  assert.equal(fs.readFileSync(path.join(f.out, 'user.txt'), 'utf8'), 'keep me');
  assert.deepEqual(fs.readdirSync(f.root).sort(), ['package', 'project']);
});

test('symlinked public files are refused and link targets are not altered', t => {
  const f = fixture(t), original = fs.readFileSync(f.p('脚本.md'));
  fs.writeFileSync(path.join(f.root, 'private.md'), original);
  fs.unlinkSync(f.p('脚本.md')); fs.symlinkSync(path.join(f.root, 'private.md'), f.p('脚本.md'));
  assert.throws(() => createPublicPackage(f.project, f.out), /符号链接/);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'private.md')), original);
  assert.equal(fs.existsSync(f.out), false);
});
