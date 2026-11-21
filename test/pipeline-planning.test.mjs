import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { renderSettings, renderBudget, diskObservation, sameRenderSettings } from '../lib/render-budget.mjs';
import { subtitleData, subtitleStatus, exportSubtitles, srtText } from '../lib/subtitle-export.mjs';
import { pipelinePlan, timingObservation } from '../lib/pipeline-plan.mjs';
import { currentArtifactInputs, createArtifactRecord, mediaFingerprint } from '../lib/artifact-status.mjs';
import { saveState, parseSceneBodies, fnv1a, hashFile, skillDir } from '../lib/state.mjs';
import { voiceTemplateKind } from '../lib/voice-upgrade.mjs';
import { sharedFingerprint } from '../lib/render-cache.mjs';
import { inspectableHtml } from './helpers/inspectable-html.mjs';
import { voiceFixture } from './helpers/voice-fixture.mjs';

const MiB = 1024 ** 2, hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const vh = path.resolve('vh.mjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-plan-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const subs = [{ s: .2, e: 1.8, t: '只更新一份文件。' }], lines = subs.map(s => s.t);
  const files = { 'PROJECT.json': '{"deliveryTarget":"video"}', '脚本.md': '## S1 · 开场\n1. 只更新一份文件。\n',
    'scenes.src.js': 'root=>({render(t){}})', 'engine.tpl.html': "const ORIENT = 'landscape';",
    'scene.html': inspectableHtml(`const ORIENT = 'landscape'; const SUBS = ${JSON.stringify(subs)}; const scenes = []; addScene(0,2,root=>({})); const DURATION = 2;`),
    'timing.json': JSON.stringify({ schemaVersion: 1, textHash: hash(lines), groupsHash: hash([lines]), measurement: { voice: 'zf_001', speed: 1 }, dur: 2, scenes: [[0, 2]], subs }),
    'timeline.mjs': "throw new Error('read-only plan must not execute timeline');",
    'gen.mjs': "throw new Error('must not execute generator');", 'voice-kokoro.py': voiceFixture("raise RuntimeError('must not run TTS')") };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}
function cli(dir, ...args) { return spawnSync(process.execPath, [vh, ...args, '--dir', dir], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HOME: dir } }); }

test('资源预算：默认最多4路，显式并发仍受内存/CPU限制，非法参数早拒绝', () => {
  const machine = { cpus: 32, freeMemory: 32 * 1024 ** 3 };
  assert.equal(renderSettings({}, machine).jobs, 4);
  const low = renderSettings({ jobs: 16 }, { cpus: 8, freeMemory: 1024 ** 3 });
  assert.equal(low.jobs, 1); assert.ok(low.warnings.length);
  for (const options of [{ jobs: 0 }, { jobs: 1.5 }, { jobs: 33 }, { fps: 'x' }, { fps: 0 }, { fps: 29.97 }, { crf: 52 }, { preset: 'bogus' }]) assert.throws(() => renderSettings(options, machine));
  const defaultLow = renderSettings({}, { cpus: 10, freeMemory: 232 * MiB });
  assert.equal(defaultLow.jobs, 1); assert.match(defaultLow.warnings.join(''), /默认最多 4/);
  assert.equal(defaultLow.freeMemory, 232 * MiB);
  assert.ok(sameRenderSettings({ params: 'render.mjs --fast --fps 60' }, { ...renderSettings({}, machine), fps: 60 }));
  assert.equal(sameRenderSettings({ params: 'render.mjs --fast' }, { ...renderSettings({}, machine), fps: 60 }), false);
});
test('资源预算：空间不足硬拦；估算/未知不冒充实测保证，按目标卷探测', t => {
  const dir = fixture(t), settings = renderSettings({}, { cpus: 4, freeMemory: 4 * 1024 ** 3 });
  assert.equal(renderBudget({ duration: 120, settings, freeBytes: 100 * MiB }).ok, false);
  const unknown = renderBudget({ duration: 120, settings }); assert.equal(unknown.freeBytes, null); assert.ok(unknown.warnings.length);
  let target;
  const disk = diskObservation(dir, where => { target = where; return { bavail: 10, bsize: 1024 }; });
  assert.equal(target, dir); assert.equal(disk.freeBytes, 10240);
});
test('字幕导出：纯数据解析、转义/旧格式兼容；表达式与注释示例不执行', () => {
  const legacy = `const SUBS = [{s:0.1,e:1.2,t:'有一个 ] 和 \\'引号\\''}];`;
  assert.equal(subtitleData(legacy)[0].t, "有一个 ] 和 '引号'");
  assert.throws(() => subtitleData('/* const SUBS = [{s:0,e:1,t:"fake"}] */'), /没有/);
  assert.throws(() => subtitleData('const SUBS = [{s:0,e:1,t:(()=>{throw 1})()}];'), /不执行/);
  assert.throws(() => subtitleData('const SUBS = [{"s":1,"e":1,"t":"x"}];'), /区间无效/);
  assert.match(srtText([{ s: 59.9996, e: 61, t: '完整字幕' }]), /00:01:00,000 --> 00:01:01,000/);
});
test('字幕导出：幂等，旧稿备份，不触碰视频或启动Python', t => {
  const dir = fixture(t);
  assert.equal(subtitleStatus(dir).ok, false);
  const first = exportSubtitles(dir); assert.equal(first.changed, true); assert.equal(subtitleStatus(dir).ok, true);
  const mtime = fs.statSync(first.file).mtimeMs; assert.equal(exportSubtitles(dir).changed, false); assert.equal(fs.statSync(first.file).mtimeMs, mtime);
  fs.writeFileSync(first.file, 'user subtitle'); const replacement = exportSubtitles(dir);
  assert.equal(fs.readFileSync(replacement.backup, 'utf8'), 'user subtitle');
  assert.equal(fs.existsSync(path.join(dir, 'out/video.mp4')), false);
});
test('计划/时间轴：只读JSON契约，不执行项目 JS；缺失/换音色明确标记', t => {
  const dir = fixture(t), before = fs.readdirSync(dir);
  assert.equal(timingObservation(dir).state, 'valid'); assert.equal(timingObservation(dir, { voice: 'other' }).state, 'invalid');
  const plan = pipelinePlan(dir, { srt: true }, { machine: { cpus: 8, freeMemory: 4 * 1024 ** 3 } });
  assert.equal(plan.readOnly, true); assert.equal(plan.ok, true); assert.ok(plan.steps.find(s => s.id === 'render').status === 'run');
  assert.deepEqual(fs.readdirSync(dir), before); assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  fs.unlinkSync(path.join(dir, 'gen.mjs')); assert.equal(pipelinePlan(dir).ok, false);
});

test('标准TTS旧身份在计划与渲染前失效；measure在复用判断前升级，不补签旧时间轴', t => {
  const source = path.join(skillDir() || '', 'assets/voice-kokoro.py');
  if (!fs.existsSync(source)) return t.skip('需要标准本地TTS模板');
  const dir = fixture(t), file = path.join(dir, 'voice-kokoro.py');
  fs.copyFileSync(source, file);
  const originalTiming = fs.readFileSync(path.join(dir, 'timing.json'), 'utf8');
  assert.equal(voiceTemplateKind(fs.readFileSync(file, 'utf8')), 'original');
  assert.match(timingObservation(dir).reason, /缓存身份已失效/);
  assert.equal(pipelinePlan(dir).steps.find(step => step.id === 'measure').status, 'run');
  assert.equal(fs.readFileSync(file, 'utf8'), fs.readFileSync(source, 'utf8'), '计划不自动升级');
  const render = cli(dir, 'render', '--force');
  assert.notEqual(render.status, 0);
  assert.match(render.stderr, /缓存身份已失效/);
  assert.equal(fs.existsSync(path.join(dir, 'out/frames')), false);
  const measured = cli(dir, 'measure');
  assert.notEqual(measured.status, 0, 'fixture生成器显式报错，不执行真实TTS');
  assert.match(measured.stdout, /安全升级.*缓存身份/);
  assert.equal(voiceTemplateKind(fs.readFileSync(file, 'utf8')), 'cache-v2');
  assert.ok(fs.readdirSync(path.join(dir, 'out/.vh-voice-backups')).length);
  assert.equal(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'), originalTiming, '不为旧测量补签身份');
  assert.equal(fs.existsSync(path.join(dir, 'out/narration.m4a')), false);
});
test('计划复用同次产物观察的输入，不重复哈希素材；旧注入观察仍可回退', t => {
  const dir = fixture(t), current = currentArtifactInputs(dir);
  const machine = { cpus: 4, freeMemory: 8 * 1024 ** 3 };
  let fallback = 0;
  const dependencies = { artifactStatus: () => ({ stale: {}, current }), machine,
    currentArtifactInputs: () => { fallback++; return current; },
    diskObservation: () => ({ freeBytes: 1024 ** 4, volume: 'test' }) };
  const withCurrent = pipelinePlan(dir, {}, dependencies);
  assert.equal(fallback, 0);
  const withoutCurrent = pipelinePlan(dir, {}, { ...dependencies, artifactStatus: () => ({ stale: {} }) });
  assert.equal(fallback, 1);
  assert.deepEqual(withCurrent, withoutCurrent);
});
test('计划复用有效测量时报告超时阻断；重测时保留警告且不抢先阻止重测', t => {
  const dir = fixture(t), timingFile = path.join(dir, 'timing.json');
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), JSON.stringify({ deliveryTarget: 'video', durationLimit: { maxSeconds: 480, targetSeconds: 420 } }));
  const timing = JSON.parse(fs.readFileSync(timingFile));
  timing.dur = 482; timing.scenes = [[0, 482]];
  fs.writeFileSync(timingFile, JSON.stringify(timing));
  saveState(dir, { lastMeasure: { scriptHash: hashFile(path.join(dir, '脚本.md')) } });
  const dependencies = { artifactStatus: () => ({ stale: { render: '需要渲染' } }),
    diskObservation: () => ({ freeBytes: 1024 ** 4, volume: 'test' }), machine: { cpus: 4, freeMemory: 8 * 1024 ** 3 } };
  const plan = pipelinePlan(dir, {}, dependencies);
  assert.equal(plan.timing.state, 'valid'); assert.equal(plan.steps.find(s => s.id === 'measure').status, 'reuse');
  assert.equal(plan.ok, false); assert.match(plan.blockers.join('\n'), /482\.00 秒.*480 秒/);
  const remeasure = pipelinePlan(dir, { remeasure: true }, dependencies);
  assert.equal(remeasure.ok, true); assert.equal(remeasure.steps.find(s => s.id === 'measure').status, 'run');
  assert.match(remeasure.warnings.join('\n'), /482\.00 秒.*重测后须重新判断/);
  for (const args of [['plan', '--json'], ['go', '--dry-run', '--json']]) {
    const actual = cli(dir, ...args); assert.equal(actual.status, 1, actual.stdout + actual.stderr);
    assert.match(JSON.parse(actual.stdout).blockers.join('\n'), /482\.00 秒.*480 秒/);
  }
  timing.schemaVersion = 99; fs.writeFileSync(timingFile, JSON.stringify(timing));
  assert.equal(pipelinePlan(dir, {}, dependencies).timing.state, 'unknown');
});
test('真实 CLI：plan/go --dry-run 产出同计划，不写状态、运行项目脚本或模型', t => {
  const dir = fixture(t), before = fs.readdirSync(dir);
  for (const args of [['plan', '--srt', '--json'], ['go', '--srt', '--dry-run', '--json'], ['render', '--dry-run', '--json']]) {
    const result = cli(dir, ...args); assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).readOnly, true); assert.equal(fs.existsSync(path.join(dir, 'out')), false);
    assert.deepEqual(fs.readdirSync(dir), before);
  }
  const invalid = cli(dir, 'plan', '--jobs', '0', '--json');
  assert.equal(invalid.status, 1); assert.match(JSON.parse(invalid.stdout).blockers[0], /jobs/);
  for (const flags of [['--encode-only'], ['--from', '1'], ['--all', '--scenes', '1']]) {
    const rejected = cli(dir, 'go', '--dry-run', '--json', ...flags);
    assert.equal(rejected.status, 1); assert.equal(JSON.parse(rejected.stdout).ok, false);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  }
});
test('真实 go --srt：当前视频仅补字幕，重复执行不重新TTS/混流或改视频', t => {
  const dir = fixture(t); fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'timeline.mjs'), 'export const scriptGroups=()=>[]; export const validateTiming=d=>({subs:d.subs,total:d.dur});');
  const voice = path.join(dir, 'out/video-voice.mp4');
  const result = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=size=64x36:duration=2:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', voice], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
  fs.copyFileSync(voice, path.join(dir, 'out/video.mp4'));
  const input = currentArtifactInputs(dir);
  saveState(dir, { lastMeasure: { scriptHash: input.sourceHashes['脚本.md'] }, genStamp: { sourceHashes: input.sourceHashes, scriptHash: input.sourceHashes['脚本.md'], scenesHash: input.sourceHashes['scenes.src.js'] },
    render: { sceneHtmlHash: input.sceneHtmlHash, artifact: createArtifactRecord(dir, 'render') }, voice: { artifact: createArtifactRecord(dir, 'voice') } });
  const before = mediaFingerprint(voice);
  fs.mkdirSync(path.join(dir, 'out/frames'));
  const frame = path.join(dir, 'out/frames/00000.jpg'); fs.writeFileSync(frame, 'keep incremental frame');
  for (let n = 0; n < 2; n++) {
    const r = cli(dir, 'go', '--srt'); assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /跳过配音/); assert.doesNotMatch(r.stdout, /配音合成与混流/);
    assert.deepEqual(mediaFingerprint(voice), before); assert.equal(subtitleStatus(dir).ok, true);
    assert.equal(fs.readFileSync(frame, 'utf8'), 'keep incremental frame');
  }
  const cleaned = cli(dir, 'go', '--clean-frames'); assert.equal(cleaned.status, 0, cleaned.stdout + cleaned.stderr);
  assert.equal(fs.existsSync(frame), false); assert.deepEqual(mediaFingerprint(voice), before);
  // go 由 extra:['--all'] 请求修复旧分段时，不能被 render 的“内容没变”提前 return 吞掉。
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'out/.vh-state.json'), 'utf8'));
  const html = fs.readFileSync(path.join(dir, 'scene.html'), 'utf8');
  state.render = { ...state.render, params: 'render.mjs --fast', ranges: input.ranges, shared: sharedFingerprint(html), bodies: parseSceneBodies(html).map(fnv1a) };
  saveState(dir, state); fs.mkdirSync(path.join(dir, 'out/seg'));
  fs.writeFileSync(path.join(dir, 'out/seg/manifest.json'), '{"duration":99}');
  fs.writeFileSync(path.join(dir, 'render.mjs'), 'console.log("RENDER_ARGS="+JSON.stringify(process.argv.slice(2))); process.exit(23);');
  const repair = cli(dir, 'go'); assert.equal(repair.status, 23, repair.stderr + repair.stdout);
  assert.ok(JSON.parse(repair.stdout.match(/RENDER_ARGS=(.*)/)[1]).includes('--all'));
});

test('measure 只复用内容及生成器均匹配的估算稿；改 HTML 或生成器后仍重新同步', t => {
  for (const changed of ['none', 'html', 'generator']) {
    const dir = fixture(t);
    fs.writeFileSync(path.join(dir, 'timeline.mjs'), 'export const scriptGroups=()=>[]; export const validateTiming=d=>({subs:d.subs,total:d.dur});');
    fs.writeFileSync(path.join(dir, 'voice-kokoro.py'), voiceFixture('assert args.measure and args.apply\nprint("FAKE_MEASURE")'));
    fs.writeFileSync(path.join(dir, 'gen.mjs'), `import fs from 'node:fs'; fs.appendFileSync('gen-count.txt','gen\\n');`);
    saveState(dir, { genStamp: { estimate: true, sourceHashes: currentArtifactInputs(dir).sourceHashes, generatorHash: hashFile(path.join(dir, 'gen.mjs')) } });
    if (changed === 'html') {
      const file = path.join(dir, 'scene.html'), stat = fs.statSync(file);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Readable fixture', 'Readable changed'));
      fs.utimesSync(file, stat.atime, stat.mtime);
    }
    if (changed === 'generator') fs.appendFileSync(path.join(dir, 'gen.mjs'), '\n// changed');
    const r = cli(dir, 'measure', '--remeasure'); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /FAKE_MEASURE/);
    const calls = fs.readFileSync(path.join(dir, 'gen-count.txt'), 'utf8').trim().split('\n').length;
    assert.equal(calls, changed === 'none' ? 1 : 2, changed + ': ' + r.stdout);
  }
});
