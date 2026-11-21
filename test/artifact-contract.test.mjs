import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshot, saveState, loadState, fnv1a, hashFile } from '../lib/state.mjs';
import { deliverableState } from '../lib/deliverable.mjs';
import { artifactStatus, createArtifactRecord, currentArtifactInputs, metadataSignature,
  evaluateArtifactStatus, mediaFingerprint, probeMedia } from '../lib/artifact-status.mjs';

// Every generated file belongs to a disposable test fixture; never a user project.
function makeVideo(file, { audio = false, seconds = 1, size = '64x36', color = 'black' } = {}) {
  const args = ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=30:d=${seconds}`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:d=${seconds}`, '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac');
  args.push(file);
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
}
function fixture(t, { voiced = true, audio = true, baseline = true, seconds = 1 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-artifact-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const p = n => path.join(dir, n);
  fs.mkdirSync(p('out/seg'), { recursive: true });
  fs.writeFileSync(p('PROJECT.json'), '{}');
  fs.writeFileSync(p('脚本.md'), '## S1 · 测试\n1. 一句话。\n');
  fs.writeFileSync(p('scenes.src.js'), '//---\nroot => ({render(){}})\n');
  fs.writeFileSync(p('engine.tpl.html'), "const ORIENT = 'landscape'; /* engine v1 */");
  fs.writeFileSync(p('timing.json'), '{}');
  fs.writeFileSync(p('scene.html'), `const DURATION = ${seconds}; const ORIENT = 'landscape'; const scenes = []; addScene(0, ${seconds}, () => {});`);
  // Explicit ordering avoids filesystem timestamp granularity assumptions.
  const old = Date.now() - 20000;
  for (const n of ['脚本.md', 'scenes.src.js', 'timing.json', 'engine.tpl.html', 'scene.html']) fs.utimesSync(p(n), new Date(old), new Date(old));
  makeVideo(p('out/video.mp4'), { seconds });
  if (voiced) makeVideo(p('out/video-voice.mp4'), { seconds, audio });
  saveState(dir, { genStamp: { scriptHash: hashFile(p('脚本.md')), scenesHash: hashFile(p('scenes.src.js')) } });
  if (baseline) {
    saveState(dir, { render: { sceneHtmlHash: hashFile(p('scene.html')), artifact: createArtifactRecord(dir, 'render') } });
    if (voiced && audio) saveState(dir, { voice: { artifact: createArtifactRecord(dir, 'voice') } });
  }
  return { dir, p };
}
async function assertStaleTogether(dir, expected) {
  const status = artifactStatus(dir), snap = await snapshot(dir), delivered = deliverableState(dir);
  assert.equal(delivered.stale, true);
  assert.equal(delivered.video, fs.existsSync(path.join(dir, 'out/video-voice.mp4')) ? 'out/video-voice.mp4' : null);
  assert.equal(snap.stale.render, status.stale.render);
  assert.equal(snap.stale.voice, status.stale.voice);
  assert.equal(delivered.reason, status.deliverable.reason);
  if (expected) assert.match(delivered.reason, expected);
  return status;
}

test('fresh real voiced media plus valid source/media receipts is accepted, without writes', async t => {
  const { dir, p } = fixture(t);
  const before = fs.readFileSync(p('out/.vh-state.json'), 'utf8');
  const times = ['scene.html', 'out/.vh-state.json', 'out/video.mp4', 'out/video-voice.mp4'].map(n => fs.statSync(p(n)).mtimeMs);
  assert.deepEqual(deliverableState(dir), { stale: false, reason: null, video: 'out/video-voice.mp4' });
  const snap = await snapshot(dir);
  assert.equal(snap.stale.render, undefined);
  assert.equal(snap.stale.voice, undefined);
  assert.equal(fs.readFileSync(p('out/.vh-state.json'), 'utf8'), before);
  assert.deepEqual(['scene.html', 'out/.vh-state.json', 'out/video.mp4', 'out/video-voice.mp4'].map(n => fs.statSync(p(n)).mtimeMs), times);
});

test('equal duration with no render baseline remains stale, not fresh by duration', async t => {
  const { dir } = fixture(t, { baseline: false });
  await assertStaleTogether(dir, /没有渲染基线/);
});

test('same-duration engine change after measure clears render baseline stays stale', async t => {
  const { dir, p } = fixture(t);
  saveState(dir, { render: null, voice: null });
  fs.appendFileSync(p('engine.tpl.html'), '\n/* changed engine */');
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(p('engine.tpl.html'), future, future);
  const status = await assertStaleTogether(dir);
  assert.match(status.stale.scene, /引擎/);
  assert.ok(status.stale.render);
});

test('immutable receipt can survive cleared incremental baseline, but engine hash still invalidates it', async t => {
  const { dir, p } = fixture(t), state = loadState(dir);
  saveState(dir, { artifacts: { render: state.render.artifact, voice: state.voice.artifact }, render: null, voice: null });
  assert.equal(deliverableState(dir).stale, false);
  const old = fs.statSync(p('engine.tpl.html'));
  fs.appendFileSync(p('engine.tpl.html'), ' /* same-timestamp change */');
  fs.utimesSync(p('engine.tpl.html'), old.atime, old.mtime);
  await assertStaleTogether(dir, /源文件内容已改变/);
});

for (const name of ['脚本.md', 'scenes.src.js', 'engine.tpl.html', 'timing.json', 'scene.html']) {
  test(`source fingerprints catch same-timestamp edits to ${name}`, async t => {
    const { dir, p } = fixture(t), old = fs.statSync(p(name));
    fs.appendFileSync(p(name), '\n/* content changed without changing duration */');
    fs.utimesSync(p(name), old.atime, old.mtime);
    const status = await assertStaleTogether(dir, /源文件内容已改变/);
    assert.ok(status.stale.render);
  });
}

test('silent-only cannot complete, regardless of unrelated newer MP4s', async t => {
  const { dir, p } = fixture(t, { voiced: false });
  fs.copyFileSync(p('out/video.mp4'), p('out/newest-random.mp4'));
  const status = await assertStaleTogether(dir, /配音/);
  assert.equal(status.stale.render, undefined);
  assert.equal(status.deliverable.video, null);
});

test('file named video-voice with no audio stream cannot complete', async t => {
  const { dir } = fixture(t, { audio: false });
  const status = await assertStaleTogether(dir, /真实音轨/);
  assert.equal(status.stale.render, undefined);
  assert.throws(() => createArtifactRecord(dir, 'voice'), /无音轨/);
});

test('a changed silent render never wins over or launders an older voiced mux', async t => {
  const { dir, p } = fixture(t);
  makeVideo(p('out/video.mp4'), { color: 'red' });
  const later = new Date(fs.statSync(p('out/video-voice.mp4')).mtimeMs + 2000);
  fs.utimesSync(p('out/video.mp4'), later, later);
  const state = loadState(dir);
  saveState(dir, { render: { ...state.render, artifact: createArtifactRecord(dir, 'render') } });
  const status = await assertStaleTogether(dir, /配音所用的静音成片已改变/);
  assert.equal(status.stale.render, undefined);
});

test('legacy artifacts without content receipts still use source mtimes conservatively', async t => {
  const { dir, p } = fixture(t);
  saveState(dir, { render: { sceneHtmlHash: hashFile(p('scene.html')), dur: 1 }, voice: { dur: 1 } });
  const later = new Date(fs.statSync(p('out/video-voice.mp4')).mtimeMs + 2000);
  fs.utimesSync(p('脚本.md'), later, later);
  await assertStaleTogether(dir, /早于最新改动/);
});

test('rewriting identical scene bytes after build keeps matching content receipts fresh', async t => {
  const { dir, p } = fixture(t), source = fs.readFileSync(p('scene.html'));
  fs.writeFileSync(p('scene.html'), source);
  const later = new Date(fs.statSync(p('out/video-voice.mp4')).mtimeMs + 2000);
  fs.utimesSync(p('scene.html'), later, later);
  assert.equal(deliverableState(dir).stale, false);
  const snap = await snapshot(dir);
  assert.equal(snap.stale.render, undefined);
  assert.equal(snap.stale.voice, undefined);
});

test('timestamp-only engine and script touches do not invalidate matching content receipts', async t => {
  const { dir, p } = fixture(t);
  const later = new Date(fs.statSync(p('out/video-voice.mp4')).mtimeMs + 2000);
  for (const name of ['engine.tpl.html', '脚本.md']) fs.utimesSync(p(name), later, later);
  const status = artifactStatus(dir);
  assert.equal(status.stale.scene, undefined);
  assert.equal(status.deliverable.stale, false);
});

test('a locked-format timestamp-only template touch cannot invalidate exact content receipts', async t => {
  const { dir, p } = fixture(t, { baseline: false });
  fs.writeFileSync(p('PROJECT.json'), JSON.stringify({ videoFormat: { aspectRatio: '16:9' } }));
  makeVideo(p('out/video.mp4'), { size: '1920x1080' });
  makeVideo(p('out/video-voice.mp4'), { size: '1920x1080', audio: true });
  saveState(dir, { render: { sceneHtmlHash: hashFile(p('scene.html')), artifact: createArtifactRecord(dir, 'render') },
    voice: { artifact: createArtifactRecord(dir, 'voice') } });
  const later = new Date(fs.statSync(p('out/video-voice.mp4')).mtimeMs + 2000);
  fs.utimesSync(p('engine.tpl.html'), later, later);
  const status = artifactStatus(dir);
  assert.equal(status.videoFormat.pendingBuild, true, 'underlying format helper still observes the newer timestamp');
  assert.equal(status.stale.scene, undefined);
  assert.equal(status.deliverable.stale, false);
});

test('timestamp-only media changes preserve fresh content receipts and render-to-voice links', async t => {
  const { dir, p } = fixture(t);
  const oldVoiceTime = fs.statSync(p('out/video-voice.mp4')).mtimeMs;
  // Put voice before every source, and silent after voice. Both old mtime
  // comparisons would reject it, but all exact content links still match.
  const old = new Date(Date.now() - 60000), later = new Date(oldVoiceTime + 2000);
  fs.utimesSync(p('out/video-voice.mp4'), old, old);
  fs.utimesSync(p('out/video.mp4'), later, later);
  assert.equal(deliverableState(dir).stale, false);
  const snap = await snapshot(dir);
  assert.equal(snap.stale.render, undefined);
  assert.equal(snap.stale.voice, undefined);
});

test('a real voiced file without any voice receipt or legacy metadata cannot complete', async t => {
  const { dir } = fixture(t);
  saveState(dir, { voice: null });
  const status = await assertStaleTogether(dir, /缺少有效配音基线/);
  assert.equal(status.stale.render, undefined);
});

test('legacy voiced metadata must match real duration, not merely exist', async t => {
  const { dir } = fixture(t);
  saveState(dir, { voice: { dur: 9, timelineDur: 1 } });
  await assertStaleTogether(dir, /缺少有效配音基线/);
});

test('invalid voice receipts are never replaced by otherwise matching legacy metadata', async t => {
  const { dir } = fixture(t), state = loadState(dir);
  state.voice.artifact.media.sha256 = 'not-the-recorded-media';
  saveState(dir, { voice: { ...state.voice, dur: 1, timelineDur: 1 } });
  await assertStaleTogether(dir, /指纹不符/);
});

test('legacy voiced metadata still detects a silent artifact touched after its mux', async t => {
  const { dir, p } = fixture(t);
  saveState(dir, { voice: { dur: 1, timelineDur: 1 } });
  const later = new Date(fs.statSync(p('out/video-voice.mp4')).mtimeMs + 2000);
  fs.utimesSync(p('out/video.mp4'), later, later);
  await assertStaleTogether(dir, /配音比静音成片旧/);
});

test('real duration mismatch overrides an optimistic baseline', async t => {
  const { dir, p } = fixture(t);
  makeVideo(p('out/video.mp4'), { seconds: 2 });
  const status = await assertStaleTogether(dir, /实际 2\.00s.*时间轴 1\.00s/);
  assert.ok(status.stale.voice);
});

test('timeline tolerance is +/-0.5 seconds, not exact duration equality', async t => {
  const { dir, p } = fixture(t);
  fs.writeFileSync(p('scene.html'), "const DURATION = 1.4; const ORIENT = 'landscape'; const scenes = []; addScene(0, 1.4, () => {});");
  const old = new Date(Date.now() - 10000);
  fs.utimesSync(p('scene.html'), old, old);
  saveState(dir, { render: { artifact: createArtifactRecord(dir, 'render') }, voice: { artifact: createArtifactRecord(dir, 'voice') } });
  assert.equal(deliverableState(dir).stale, false);
});

test('container duration cannot hide an audio stream shorter than the timeline', async t => {
  const { dir, p } = fixture(t, { seconds: 2 });
  const result = spawnSync('ffmpeg', ['-y', '-v', 'error', '-i', p('out/video.mp4'),
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:d=0.3',
    '-c:v', 'copy', '-c:a', 'aac', p('out/video-voice.mp4')], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => createArtifactRecord(dir, 'voice'), /时长不符/);
  const status = await assertStaleTogether(dir, /音轨实际.*时间轴 2\.00s/);
  assert.equal(status.stale.render, undefined);
});

test('tampered timeline receipt is rejected even when source and video hashes still match', async t => {
  const { dir } = fixture(t), state = loadState(dir);
  state.render.artifact.timelineDur = 9;
  saveState(dir, { render: state.render });
  await assertStaleTogether(dir, /时间轴或画面与产物记录不符/);
});

test('a valid media replacement with preserved mtime is caught by binary SHA-256', async t => {
  const { dir, p } = fixture(t), old = fs.statSync(p('out/video.mp4'));
  const before = mediaFingerprint(p('out/video.mp4'));
  makeVideo(p('out/video.mp4'), { color: 'red' });
  fs.utimesSync(p('out/video.mp4'), old.atime, old.mtime);
  assert.notEqual(mediaFingerprint(p('out/video.mp4')).sha256, before.sha256);
  await assertStaleTogether(dir, /指纹不符/);
});

for (const name of ['out/video.mp4', 'out/video-voice.mp4']) {
  test(`corrupted ${name} fails closed rather than trusting recorded durations`, async t => {
    const { dir, p } = fixture(t);
    fs.writeFileSync(p(name), 'this is not media');
    assert.equal(probeMedia(p(name)), null);
    await assertStaleTogether(dir, /损坏|无法核验/);
  });
}

test('existing video-format dimension constraint applies to the voiced file too', async t => {
  const { dir, p } = fixture(t);
  fs.writeFileSync(p('PROJECT.json'), JSON.stringify({ videoFormat: { aspectRatio: '16:9' } }));
  const status = await assertStaleTogether(dir, /1920×1080/);
  assert.match(status.stale.voice, /1920×1080/);
});

test('legacy render baseline remains usable, but lack of it never gets duration amnesty', async t => {
  const { dir, p } = fixture(t);
  saveState(dir, { render: { sceneHtmlHash: hashFile(p('scene.html')), dur: 1 }, voice: { dur: 1 } });
  assert.equal(deliverableState(dir).stale, false);
  saveState(dir, { render: null });
  await assertStaleTogether(dir, /没有渲染基线/);
});

test('stable metadata signature and FNV exports are compatible; pure evaluator does not mutate', t => {
  const { dir } = fixture(t);
  assert.equal(metadataSignature({ b: 2, a: { d: 4, c: 3 } }), metadataSignature({ a: { c: 3, d: 4 }, b: 2 }));
  assert.equal(fnv1a('hello'), '4f9f2cab');
  const status = artifactStatus(dir), state = loadState(dir);
  const input = { current: currentArtifactInputs(dir), state, sources: {}, render: status.render,
    voice: status.voice, format: status.videoFormat, formatError: null, manifestDur: null };
  const before = JSON.stringify(input);
  function freeze(value) { if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value)) freeze(v); } }
  freeze(input);
  assert.equal(evaluateArtifactStatus(input).deliverable.stale, false);
  assert.equal(JSON.stringify(input), before);
});
