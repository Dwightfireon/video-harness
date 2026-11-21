import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cueInScene, sceneCue, browserSource, compileMotion } from '../lib/film.mjs';
import { planVoiceSamples, createVoiceSamples, voiceSampleStatus } from '../lib/voice-samples.mjs';
import { claimEvidenceStatus } from '../lib/claim-evidence.mjs';
import { analyze } from '../lib/claims.mjs';
import { initReviewSnapshot, releaseReviewStatus } from '../lib/release-review.mjs';
import { render, coverStatus, buildHtml } from '../lib/cover.mjs';

const sha = data => createHash('sha256').update(data).digest('hex');
function fixture(t, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-session-retro-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'PROJECT.json': '{}', ...files })) {
    const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
  }
  return dir;
}

test('scene-local cues follow remeasurement; duplicates in another scene do not interfere', () => {
  const subs = [{ s: 0, e: 2, t: '出现' }, { s: 10, e: 12, t: '出现' }, { s: 14, e: 16, t: '结果' }];
  assert.equal(cueInScene(subs, 10, 20, '出现'), 0);
  assert.equal(cueInScene(subs, 10, 20, 2, 'e', -.2), 5.8);
  assert.equal(cueInScene(subs.map(s => s.s >= 10 ? { ...s, s: s.s + 3, e: s.e + 3 } : s), 12, 23, 2), 5);
  for (const selector of [0, 3, 1.2, '缺句']) assert.throws(() => cueInScene(subs, 10, 20, selector));
  assert.throws(() => cueInScene([...subs, { s: 17, e: 18, t: '结果' }], 10, 20, '结果'), /必须唯一/);
  assert.throws(() => cueInScene(subs, 10, 20, 1, 's', -1), /越出/);
  const root = { getAttribute: key => key.endsWith('start') ? '10' : '20' };
  assert.equal(sceneCue(root, 2, { subs }), 4);
  const sandbox = { window: {} }; vm.runInNewContext('const SUBS=' + JSON.stringify(subs) + ';' + browserSource(), sandbox);
  assert.equal(sandbox.window.VH_FILM.sceneCue(root, '结果'), 4);
  const plan = compileMotion({ subs, start: 10, end: 20, targets: { a: { opacity: 0 } },
    beats: [{ id: 'a', target: 'a', cue: { line: 2 }, dur: .5, to: { opacity: 1 } }] });
  assert.equal(plan.beats[0].at, 4);
});

function wav() {
  const bytes = Buffer.alloc(100); bytes.write('RIFF'); bytes.writeUInt32LE(92, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(56, 40); return bytes;
}
test('script-only pronunciation samples have bounded selection and exact byte reuse', async t => {
  const dir = fixture(t, { '脚本.md': '## S1 · 小样\n1. 开始讲解。\n2. Endpoint 和 Base URL。\n3. ChatGPT 与 Excel。\n', 'entts.py': '# sample' });
  const plan = planVoiceSamples(dir); assert.equal(plan.items.length, 3); assert.equal(plan.items[0].index, 1);
  assert.equal(plan.items[1].spokenText, 'Endpoint和BaseURL。');
  let calls = 0;
  const run = async (_cmd, argv) => {
    calls++; const request = JSON.parse(fs.readFileSync(argv.at(-1)));
    for (const item of request.items) fs.writeFileSync(item.file, wav());
    return { status: 0 };
  };
  const result = await createVoiceSamples(dir, plan, { run });
  assert.equal(result.manifest.listened, false); assert.equal(calls, 1);
  assert.equal((await createVoiceSamples(dir, plan, { run })).reused, true); assert.equal(calls, 1);
  fs.appendFileSync(path.join(result.directory, result.manifest.items[0].file), 'changed');
  assert.equal(voiceSampleStatus(dir, plan).ok, false);
  const replacement = await createVoiceSamples(dir, plan, { run }); assert.notEqual(replacement.directory, result.directory);
  assert.equal((await createVoiceSamples(dir, plan, { run })).reused, true); assert.equal(calls, 2);
  fs.appendFileSync(path.join(dir, 'entts.py'), '# new pronunciation'); assert.notEqual(planVoiceSamples(dir).signature, plan.signature);
  assert.throws(() => planVoiceSamples(dir, { lines: [1, 1] }), /无重复/);
  assert.throws(() => planVoiceSamples(dir, { speed: Infinity }));
});

test('failed synthesis or edits during synthesis never register success; measured clips avoid a TTS call', async t => {
  const dir = fixture(t, { '脚本.md': '## S1\n1. Endpoint。\n', 'out/.voice-kokoro/00.wav': wav() });
  const plan = planVoiceSamples(dir);
  await assert.rejects(createVoiceSamples(dir, plan, { run: async () => ({ status: 1 }) }), /未登记/);
  assert.equal(voiceSampleStatus(dir, plan).ok, false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'out/voice-samples')), []);
  const result = await createVoiceSamples(dir, plan, { measured: true });
  assert.equal(result.manifest.origin, 'measurement-clips');
  const next = planVoiceSamples(dir, { speed: 1.1 });
  await assert.rejects(createVoiceSamples(dir, next, { run: async (_cmd, argv) => {
    const request = JSON.parse(fs.readFileSync(argv.at(-1))); fs.writeFileSync(request.items[0].file, wav());
    fs.appendFileSync(path.join(dir, '脚本.md'), '\n2. 新旁白。'); return { status: 0 };
  } }), /生成期间/);
});

function authorClaim(file, body) {
  return { id: 'C1', statement: '七天路线是作者建议。', kind: '作者建议', scope: '入门练习', sourceType: 'recommendation',
    evidence: [{ path: file, sha256: sha(body), locator: '第八节', quote: '先完成一个小任务。', type: '作者建议', checkedAt: '2026-10-27' }] };
}
test('author recommendations use real local evidence without inventing a URL; both schemas reconcile', t => {
  const body = '第八节\n先完成一个小任务。', dir = fixture(t, { 'research/原稿.md': body, '脚本.md': '## S1\n1. 七天路线是作者建议。' });
  fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify({ claims: [authorClaim('research/原稿.md', body)] }));
  assert.equal(claimEvidenceStatus(dir, { release: true }).ok, true);
  assert.equal(analyze(dir).ok, true);
  fs.appendFileSync(path.join(dir, 'research/原稿.md'), '\nchanged');
  assert.ok(claimEvidenceStatus(dir).findings.some(f => f.kind === 'claim-local-evidence'));
});

test('403/unread evidence cannot be verified; pending external facts stay visibly pending', t => {
  const dir = fixture(t);
  const claim = { id: 'C1', assertion: '能读写项目。', kind: '官方文档', scope: '本次', status: 'verified',
    evidence: [{ url: 'https://example.com', quote: '本次抓取 403，未直接核到原文。', type: '官方转述', checkedAt: '2026-10-27' }] };
  const save = () => fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify([claim])); save();
  assert.ok(claimEvidenceStatus(dir).findings.some(f => f.kind === 'claim-unread-verified'));
  claim.status = 'unverified'; save();
  assert.equal(claimEvidenceStatus(dir).ok, true); assert.equal(claimEvidenceStatus(dir).warnings.length, 1);
  assert.equal(claimEvidenceStatus(dir, { release: true }).ok, false);
  claim.sourceType = 'recommendation'; claim.kind = '作者建议'; claim.status = 'authored'; save();
  assert.equal(claimEvidenceStatus(dir).ok, false, 'unrelated external URL cannot stand in for local source');
});

test('本机实测必须绑定真实本地记录，外部标准或拼接说明不能代替', t => {
  const body = '第一次 300\n第二次 299\n', dir = fixture(t, { 'research/observations.txt': body });
  const claim = { id: 'M1', assertion: '本机测得 300 和 299。', kind: '本机实测', scope: '一次演示', status: 'verified',
    evidence: [{ url: 'https://example.com/standard', quote: '标准定义 TTL；本机实测 300、299。', type: '标准', checkedAt: '2026-10-28' }] };
  const save = () => fs.writeFileSync(path.join(dir, 'claims.json'), JSON.stringify([claim]));
  save();
  assert.ok(claimEvidenceStatus(dir, { release: true }).findings.some(f => f.kind === 'claim-measurement-evidence'));
  claim.sourceType = 'external'; save();
  assert.ok(claimEvidenceStatus(dir).findings.some(f => f.kind === 'claim-source-type'));
  claim.sourceType = 'measurement';
  claim.evidence.push({ path: 'research/observations.txt', sha256: sha(body), locator: '第 1–2 行',
    quote: '第一次 300\n第二次 299', type: '本机原始记录', checkedAt: '2026-10-28' });
  save(); assert.equal(claimEvidenceStatus(dir, { release: true }).ok, true);
  claim.status = 'pending'; save();
  assert.equal(claimEvidenceStatus(dir).warnings.length, 1);
  assert.equal(claimEvidenceStatus(dir, { release: true }).ok, false);
  delete claim.status; save();
  assert.equal(claimEvidenceStatus(dir, { release: true }).ok, false, '原始文件存在不等于实测已经核验');
  claim.status = 'verified'; save(); fs.appendFileSync(path.join(dir, 'research/observations.txt'), 'changed');
  assert.ok(claimEvidenceStatus(dir).findings.some(f => f.kind === 'claim-local-evidence'));
});

test('review snapshots are pending, cannot overwrite silently, and invalidate on current input/evidence changes', t => {
  const dir = fixture(t, Object.fromEntries(['scene.html', '脚本.md', 'scenes.src.js', 'engine.tpl.html', 'timing.json', 'out/video-voice.mp4', '审查.md'].map(n => [n, n])));
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  const doc = initReviewSnapshot(dir); assert.equal(releaseReviewStatus(dir).ok, false);
  assert.throws(() => initReviewSnapshot(dir), /未覆盖/);
  for (const category of ['content', 'visual', 'audio']) doc.reviews[category] = { status: 'pass', notes: 'test fixture only', evidence: ['审查.md'] };
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(doc)); assert.equal(releaseReviewStatus(dir).ok, true);
  fs.appendFileSync(path.join(dir, '审查.md'), 'new'); assert.equal(releaseReviewStatus(dir).ok, false);
  const fresh = initReviewSnapshot(dir, { refresh: true }); assert.equal(fresh.reviews.audio.status, 'pending');
  assert.equal(fs.readdirSync(path.join(dir, 'out/review-history')).length, 1);
});

test('editorial covers work without scene/video, render all ratios and thumbnails, and reject overflow', async t => {
  const dir = fixture(t, { '脚本.md': '## S1\n1. 不写代码，也能做工具。', '发布文案.md': '## 封面文案\n主：不写代码\n副：也能做出工具' });
  const result = await render(dir); assert.equal(result.ok, true, result.error);
  assert.equal(result.made.length, 3); assert.equal(coverStatus(dir).ok, true);
  assert.doesNotMatch(buildHtml({ ratio: '16x9', main: '测试' }), /VH · 视频|class="bg"/);
  for (const made of result.made) {
    assert.ok(made.fit.titlePixelsAt320 >= 20);
    const png = fs.readFileSync(made.thumbnail);
    assert.equal(png.readUInt32BE(16), 320);
  }
  const before = sha(fs.readFileSync(result.made[0].file));
  const invalid = await render(dir, { main: '这是一个长到无法排进封面的标题'.repeat(30) });
  assert.equal(invalid.ok, false); assert.match(invalid.error, /过长|越界/);
  assert.equal(sha(fs.readFileSync(result.made[0].file)), before);
  fs.appendFileSync(path.join(dir, '脚本.md'), 'changed'); assert.equal(coverStatus(dir).ok, false);
});

test('new CLI commands have side-effect-free help and script-only sample listing', t => {
  const dir = fixture(t, { '脚本.md': '## S1\n1. Endpoint。' });
  for (const command of ['voice-sample', 'review-status', 'review-init', 'cover', 'pack']) {
    const result = spawnSync(process.execPath, ['vh.mjs', command, '--help'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /用法/);
  }
  const list = spawnSync(process.execPath, ['vh.mjs', 'voice-sample', '--list', '--dir', dir], { encoding: 'utf8' });
  assert.equal(list.status, 0, list.stderr); assert.equal(JSON.parse(list.stdout).items.length, 1);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});
