import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderCacheState, sharedFingerprint } from '../lib/render-cache.mjs';
import { saveState, parseSceneBodies, fnv1a } from '../lib/state.mjs';
import { inspectableHtml } from './helpers/inspectable-html.mjs';
import { makeTools } from '../lib/agent.mjs';
import { rendererIdentity } from '../lib/renderer-upgrade.mjs';
import { parseStageResult } from '../lib/stage-result.mjs';

function fixture(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = '// engine\nconst scenes = [];\naddScene(0.5, 1, root => {});\naddScene(1, 2, root => {});\nconst DURATION = 2;';
  fs.mkdirSync(path.join(dir, 'out/seg'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out/frames'), { recursive: true });
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, 'out/frames', String(i).padStart(5, '0') + '.jpg'), 'fixture-frame');
  fs.writeFileSync(path.join(dir, 'scene.html'), src);
  const manifest = { sig: '30|1920x1080|jpg|medium|18', shared: sharedFingerprint(src),
    cuts: [0, 15, 30, 60], duration: 2, files: ['seg-000.mp4', 'seg-001.mp4', 'seg-002.mp4'], ...opts };
  for (const f of manifest.files) fs.writeFileSync(path.join(dir, 'out/seg', f), 'fixture');
  const save = () => fs.writeFileSync(path.join(dir, 'out/seg/manifest.json'), JSON.stringify(manifest));
  save();
  return { dir, src, manifest, save };
}

test('分段与完整帧均存在时可安全增量；清帧后不能只凭 MP4 分段放行', t => {
  const { dir } = fixture(t);
  assert.equal(renderCacheState(dir).canIncrementSafely, true);
  fs.rmSync(path.join(dir, 'out/frames'), { recursive: true });
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
});
test('失败遗留少量帧 + 缺段，不再被目录非空误判为安全', t => {
  const { dir } = fixture(t);
  fs.mkdirSync(path.join(dir, 'out/frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/frames/00042.jpg'), 'partial');
  fs.unlinkSync(path.join(dir, 'out/seg/seg-001.mp4'));
  assert.match(renderCacheState(dir).reason, /分段缺失/);
});
test('空分段、目录冒充分段均不复用', t => {
  const { dir } = fixture(t);
  const f = path.join(dir, 'out/seg/seg-001.mp4');
  fs.writeFileSync(f, '');
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
  fs.unlinkSync(f); fs.mkdirSync(f);
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
});
test('只有部分清单即使所有已列出的文件都在也不能复用', t => {
  const { dir } = fixture(t, { files: ['seg-000.mp4'] });
  assert.match(renderCacheState(dir).reason, /清单不完整/);
});
test('损坏或缺失 manifest 拒绝增量，不能只数 mp4 文件', t => {
  const { dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'out/seg/manifest.json'), '{');
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
  fs.unlinkSync(path.join(dir, 'out/seg/manifest.json'));
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
});
test('编码参数变化，包括 FPS/CRF/preset/尺寸，均阻止旧段复用', t => {
  const { dir } = fixture(t);
  for (const opts of [{ fps: 24 }, { crf: '21' }, { preset: 'slow' }, { width: 1080, height: 1920 }])
    assert.equal(renderCacheState(dir, opts).canIncrementSafely, false);
});
test('共享指纹缺失或变化均不复用，单场改动不误伤', t => {
  const { dir, src, manifest, save } = fixture(t);
  fs.writeFileSync(path.join(dir, 'scene.html'), src.replace('root => {}', 'root => { const x = 1; }'));
  assert.equal(renderCacheState(dir).canIncrementSafely, true);
  manifest.shared = undefined; save();
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
});
test('旧切点或旧时长不能通过签名相同绕过检查', t => {
  const { dir, manifest, save } = fixture(t);
  manifest.cuts = [0, 15, 29, 60]; save();
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
  manifest.cuts = [0, 15, 30, 60]; manifest.duration = 3; save();
  assert.equal(renderCacheState(dir).canIncrementSafely, false);
});

function cliFixture(t) {
  const f = fixture(t);
  f.src = inspectableHtml(f.src);
  fs.writeFileSync(path.join(f.dir, 'scene.html'), f.src);
  f.manifest.shared = sharedFingerprint(f.src); f.save();
  fs.writeFileSync(path.join(f.dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(f.dir, 'out/video.mp4'), 'fixture-not-real-media');
  saveState(f.dir, { render: { params: 'render.mjs --fast', ranges: [[0.5, 1], [1, 2]], shared: sharedFingerprint(f.src),
    bodies: parseSceneBodies(f.src.replace('root => {}', 'root => { const old = 1; }')).map(fnv1a) } });
  // 刻意以非零退出：只验证 CLI 派发的实际 argv，不伪造成片、也不启动截图。
  fs.writeFileSync(path.join(f.dir, 'render.mjs'),
    "console.log('CAPTURE_ARGV=' + JSON.stringify(process.argv.slice(2))); process.exit(23);");
  f.run = (...args) => spawnSync(process.execPath,
    [path.resolve(import.meta.dirname, '../vh.mjs'), 'render', '--dir', f.dir, ...args],
    { encoding: 'utf8', timeout: 30000 });
  return f;
}
test('CLI：坏缓存派发整片，阻止截图后才报缺段', t => {
  const { dir, run } = cliFixture(t);
  fs.unlinkSync(path.join(dir, 'out/seg/seg-001.mp4'));
  fs.mkdirSync(path.join(dir, 'out/frames'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'out/frames/00042.jpg'), 'partial');
  const r = run();
  assert.equal(r.status, 23, r.stderr);
  assert.match(r.stdout, /增量缓存不可用/);
  const argv = JSON.parse(r.stdout.match(/CAPTURE_ARGV=(.*)/)[1]);
  assert.ok(argv.includes('--all'));
  assert.ok(!argv.includes('--scenes'));
  const events = fs.readFileSync(path.join(dir, 'out/.vh-performance.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(events.some(e => e.kind === 'step' && e.stage === '渲染器（截图与编码）' && e.ok === false));
});
test('CLI：分段和帧均完整时仍派发单场，保留增量效率', t => {
  const { run } = cliFixture(t);
  const r = run();
  assert.equal(r.status, 23, r.stderr);
  const argv = JSON.parse(r.stdout.match(/CAPTURE_ARGV=(.*)/)[1]);
  assert.equal(argv[argv.indexOf('--scenes') + 1], '1');
  assert.ok(!argv.includes('--all'));
});
test('Agent run_stage 沿用 CLI 的安全增量判定，不再无条件整片', async t => {
  const { dir } = cliFixture(t);
  const result = await makeTools(dir, () => {}, { mode: 'edit' }).run_stage.run({ stage: 'render' });
  const argv = JSON.parse(parseStageResult(result).output.match(/CAPTURE_ARGV=(.*)/)[1]);
  assert.equal(argv[argv.indexOf('--scenes') + 1], '1');
  assert.ok(!argv.includes('--all'), result);
});
test('旧 Chrome 启动修复后只接受新渲染器基线，失败重试也不混用旧帧', t => {
  const { dir, run } = cliFixture(t), renderer = path.join(dir, 'render.mjs');
  fs.appendFileSync(renderer, '\nconst launchArgs = [];\nif (false) chromium.launch({ ...launchArgs, executablePath: localBrowser });');
  for (let n = 0; n < 2; n++) {
    const r = run(); assert.equal(r.status, 23, r.stdout + r.stderr);
    const argv = JSON.parse(r.stdout.match(/CAPTURE_ARGV=(.*)/)[1]);
    assert.ok(argv.includes('--all')); assert.ok(!argv.includes('--scenes'));
  }
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-state.json'), 'utf8'));
  state.render.rendererHash = rendererIdentity(dir).sha256; saveState(dir, state);
  const r = run(); assert.equal(r.status, 23, r.stdout + r.stderr);
  const argv = JSON.parse(r.stdout.match(/CAPTURE_ARGV=(.*)/)[1]);
  assert.equal(argv[argv.indexOf('--scenes') + 1], '1'); assert.ok(!argv.includes('--all'));
});
test('CLI：清帧后只剩完整分段也整片回退，显式局部在截图前拒绝', t => {
  const { dir, run } = cliFixture(t);
  fs.rmSync(path.join(dir, 'out/frames'), { recursive: true });
  const r = run(); assert.equal(r.status, 23, r.stderr);
  const argv = JSON.parse(r.stdout.match(/CAPTURE_ARGV=(.*)/)[1]);
  assert.ok(argv.includes('--all')); assert.ok(!argv.includes('--scenes'));
  assert.match(r.stdout, /帧缓存已清除/);
  const manual = run('--scenes', '1');
  assert.equal(manual.status, 1); assert.doesNotMatch(manual.stdout, /CAPTURE_ARGV/);
});
test('缺任意相邻段所需帧、空帧或目录冒充帧时不放行', t => {
  const { dir } = fixture(t), frame = path.join(dir, 'out/frames/00000.jpg');
  fs.unlinkSync(frame); assert.equal(renderCacheState(dir).canIncrementSafely, false);
  fs.writeFileSync(frame, ''); assert.equal(renderCacheState(dir).canIncrementSafely, false);
  fs.unlinkSync(frame); fs.mkdirSync(frame); assert.equal(renderCacheState(dir).canIncrementSafely, false);
});
test('CLI：手动局部渲染遇缺段在派发前报明原因', t => {
  const { dir, run } = cliFixture(t);
  fs.unlinkSync(path.join(dir, 'out/seg/seg-001.mp4'));
  const r = run('--scenes', '1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /局部渲染缓存不可用/);
  assert.doesNotMatch(r.stdout, /CAPTURE_ARGV/);
});
test('CLI：长转场不使用旧 renderer 的短 padding，自动整片且拒绝手动局部', t => {
  const { dir, src, run } = cliFixture(t);
  fs.writeFileSync(path.join(dir, 'scene.html'), src + '\nwindow.__vhTrans = [{"k":"wipe","d":1.2}];');
  const r = run();
  assert.equal(r.status, 23, r.stderr);
  const argv = JSON.parse(r.stdout.match(/CAPTURE_ARGV=(.*)/)[1]);
  assert.ok(argv.includes('--all')); assert.ok(!argv.includes('--scenes'));
  for (const [args, reason] of [[['--scenes', '1'], /增量边界/], [['--from', '.6', '--to', '1'], /任意帧范围/], [['--all', '--scenes', '1'], /不能混用/]]) {
    const partial = run(...args);
    assert.equal(partial.status, 1); assert.match(partial.stderr, reason);
    assert.doesNotMatch(partial.stdout, /CAPTURE_ARGV/);
  }
});
test('CLI：手动局部不能遗漏其它已改动场，也不能混用all或认证未知来源帧', t => {
  const { run } = cliFixture(t);
  for (const [args, message] of [[['--scenes', '2'], /遗漏已改动/], [['--all', '--scenes', '1'], /不能混用/], [['--encode-only'], /帧没有逐帧来源凭证/]]) {
    const r = run(...args); assert.equal(r.status, 1); assert.match(r.stderr, message); assert.doesNotMatch(r.stdout, /CAPTURE_ARGV/);
  }
});
test('CLI：拒绝不支持参数/遗漏场次前不清旧缓存；go 也在构建前拒绝', t => {
  const { dir, manifest, save, run } = cliFixture(t);
  manifest.duration = 99; save();
  const before = fs.readFileSync(path.join(dir, 'out/seg/manifest.json'), 'utf8');
  for (const flags of [['--encode-only'], ['--from', '1'], ['--all', '--scenes', '1'], ['--scenes', '2']]) {
    const result = run(...flags); assert.equal(result.status, 1);
    assert.equal(fs.readFileSync(path.join(dir, 'out/seg/manifest.json'), 'utf8'), before);
    assert.equal(fs.readFileSync(path.join(dir, 'out/frames/00000.jpg'), 'utf8'), 'fixture-frame');
    assert.doesNotMatch(result.stdout, /CAPTURE_ARGV/);
  }
  const go = spawnSync(process.execPath, [path.resolve('vh.mjs'), 'go', '--dir', dir, '--encode-only'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(go.status, 1); assert.match(go.stderr, /逐帧来源凭证/);
  assert.equal(fs.readFileSync(path.join(dir, 'out/seg/manifest.json'), 'utf8'), before);
});
test('CLI：同场景但媒体损坏或显式改变编码参数，不得提前跳过render', t => {
  const { dir, src, run } = cliFixture(t);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-state.json'), 'utf8'));
  state.render.bodies = parseSceneBodies(src).map(fnv1a); saveState(dir, state);
  for (const flags of [[], ['--fps', '60'], ['--hq'], ['--jobs', '2']]) {
    const r = run(...flags); assert.equal(r.status, 23, r.stderr + r.stdout);
    const argv = JSON.parse(r.stdout.match(/CAPTURE_ARGV=(.*)/)[1]); assert.ok(argv.includes('--all'));
    assert.ok(Number(argv[argv.indexOf('--jobs') + 1]) >= 1 && Number(argv[argv.indexOf('--jobs') + 1]) <= 4);
  }
  const invalid = run('--jobs', '0'); assert.equal(invalid.status, 1); assert.doesNotMatch(invalid.stdout, /CAPTURE_ARGV/);
});
