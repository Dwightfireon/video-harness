import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DEFAULT_DURATION_LIMIT, durationLimit, initializeDurationLimit, durationLimitError, durationPrompt, setDurationLimit } from '../lib/duration-limit.mjs';
import { makeTools, runAgent } from '../lib/agent.mjs';
import { artifactStatus } from '../lib/artifact-status.mjs';
import { nextPipelineWork } from '../lib/pipeline-work.mjs';
import { snapshot } from '../lib/state.mjs';
import { inspectableHtml } from './helpers/inspectable-html.mjs';
import { voiceFixture } from './helpers/voice-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'vh.mjs');
const EXPLICIT_LIMIT = { maxSeconds: 480, targetSeconds: 420 };
function fixture(t, { cap = true, duration = 210, measured = true, limit = EXPLICIT_LIMIT } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-duration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out'));
  const write = (file, text) => fs.writeFileSync(path.join(dir, file), text);
  write('PROJECT.json', JSON.stringify({ name: '时长测试', ...(cap ? { durationLimit: limit } : {}) }));
  write('脚本.md', '## S1 · 说明\n1. 这是当前脚本。\n');
  write('方案.md', '受众基线：写过代码。');
  write('claims.json', '[]');
  write('scenes.src.js', 'root => ({render(){}})');
  write('scene.html', inspectableHtml(`const ORIENT = 'landscape'; const SUBS=[{s:.1,e:${duration - .1},t:'这是当前脚本。'}]; const scenes = []; addScene(0, ${duration}, root => ({})); const DURATION = ${duration};`));
  write('engine.tpl.html', "const ORIENT = 'landscape';");
  const now = new Date(Date.now() + 100);
  fs.utimesSync(path.join(dir, 'scene.html'), now, now);
  // 本地假测量器，不请求 TTS/模型，不截图；验证 harness 控制流。
  write('timeline.mjs', `export const scriptGroups = () => [{}];
    export const validateTiming = d => ({ total: d.dur, subs: [] });`);
  if (measured) write('timing.json', JSON.stringify({ dur: duration }));
  write('render.mjs', "import fs from 'node:fs'; fs.writeFileSync('render-started', 'yes'); process.exit(7);");
  return { dir, write };
}
function run(dir, command, ...extra) {
  return spawnSync(process.execPath, [cli, command, '--dir', dir, ...extra], {
    cwd: dir, encoding: 'utf8', timeout: 30000,
  });
}

test('新建入口默认不限时长，不暗设目标；观察旧项目状态不变', t => {
  const { dir } = fixture(t, { cap: false, duration: 462 });
  const before = fs.readFileSync(path.join(dir, 'PROJECT.json'), 'utf8');
  assert.equal(durationLimit(dir), null);
  assert.match(durationPrompt(dir), /不设视频时长硬上限/);
  assert.equal(fs.readFileSync(path.join(dir, 'PROJECT.json'), 'utf8'), before);
  initializeDurationLimit(dir);
  assert.equal(DEFAULT_DURATION_LIMIT, null);
  assert.equal(durationLimit(dir), null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROJECT.json'))).name, '时长测试');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'PROJECT.json'))).durationLimit, null);
  assert.match(durationPrompt(dir), /不删推导/);
  assert.doesNotMatch(durationPrompt(dir), /480|420|6–8/);
});

test('边界放行；超 0.01 秒即拦；坏配置或未知时长不能放行', t => {
  const limit = { maxSeconds: 240, targetSeconds: 210 };
  assert.equal(durationLimitError(limit, 240), null);
  assert.match(durationLimitError(limit, 240.01), /超过当前上限 240 秒/);
  for (const seconds of [NaN, Infinity, undefined, 0, -1]) assert.match(durationLimitError(limit, seconds), /无法核验/);
  const { dir, write } = fixture(t);
  for (const invalid of [{}, { maxSeconds: '240', targetSeconds: 210 }, { maxSeconds: -1, targetSeconds: 210 }, { maxSeconds: 900, targetSeconds: 901 }]) {
    write('PROJECT.json', JSON.stringify({ durationLimit: invalid }));
    assert.throws(() => durationLimitError(durationLimit(dir), 100));
  }
});

test('超时在截图前拦截，--force/--all/--scenes 均不能跳过', t => {
  const { dir } = fixture(t, { duration: EXPLICIT_LIMIT.maxSeconds + 0.01 });
  for (const args of [[], ['--force'], ['--all'], ['--scenes', '1']]) {
    const result = run(dir, 'render', ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /超过当前上限/);
    assert.equal(fs.existsSync(path.join(dir, 'render-started')), false);
  }
});

test('估算时长也必须先实测；恰好达上限的有效测量可到达渲染器', async t => {
  const { dir } = fixture(t, { measured: false });
  const missing = run(dir, 'render', '--force');
  assert.match(missing.stdout + missing.stderr, /必须先 vh measure/);
  assert.equal(fs.existsSync(path.join(dir, 'render-started')), false);
  const valid = fixture(t, { duration: EXPLICIT_LIMIT.maxSeconds });
  assert.equal((await snapshot(valid.dir)).timing.total, EXPLICIT_LIMIT.maxSeconds);
  const result = run(valid.dir, 'render', '--force');
  assert.equal(result.status, 7); // 真正到了假渲染器，不是被时长守卫误拦。
  assert.equal(fs.readFileSync(path.join(valid.dir, 'render-started'), 'utf8'), 'yes');
});

test('旧长视频无新约束，不拦截、不自动剪短', t => {
  const { dir } = fixture(t, { cap: false, duration: 462, measured: false });
  const result = run(dir, 'render', '--force');
  assert.equal(result.status, 7);
  assert.equal(fs.existsSync(path.join(dir, 'render-started')), true);
});

test('超时不能混流、交付或force打包；管线先进入精简脚本而非重复渲染', async t => {
  const { dir, write } = fixture(t, { duration: 250, limit: { maxSeconds: 240, targetSeconds: 210 } });
  const status = artifactStatus(dir);
  assert.match(status.stale.duration, /超过当前上限/);
  assert.equal(status.deliverable.stale, true);
  for (const command of ['voice', 'pack']) {
    const result = run(dir, command, '--force');
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /超过当前上限/);
  }
  const { currentArtifactInputs, hashFile } = await import('../lib/artifact-status.mjs');
  write('out/.vh-state.json', JSON.stringify({ genStamp: {
    scriptHash: hashFile(path.join(dir, '脚本.md')), scenesHash: hashFile(path.join(dir, 'scenes.src.js')),
    sourceHashes: currentArtifactInputs(dir).sourceHashes,
  } }));
  const work = await nextPipelineWork(dir, 'topic');
  assert.equal(work.stage, 'author_edit');
  assert.equal(work.auto, false);
  assert.match(work.note, /删减|压缩|超限/);
});

test('制作工具不能移除/放宽约束，可以保持元数据里的原限制', async t => {
  const { dir } = fixture(t);
  const tools = makeTools(dir, () => {}, { mode: 'topic' });
  assert.match(await tools.write_file.run({ path: 'PROJECT.json', content: '{}' }), /拒绝.*时长限制/);
  const next = { name: 'new name', durationLimit: EXPLICIT_LIMIT };
  assert.match(await tools.write_file.run({ path: 'PROJECT.json', content: JSON.stringify(next) }), /已写入/);
  const base_hash = createHash('sha256').update(fs.readFileSync(path.join(dir, 'PROJECT.json'))).digest('hex');
  const result = await tools.patch_text.run({ path: 'PROJECT.json', base_hash, find: '480', replace: '900' });
  assert.match(result, /拒绝.*时长限制/);
  assert.deepEqual(durationLimit(dir), EXPLICIT_LIMIT);
});

test('配音实测超限：测量结果保留、退出非零；缓存复用也不放行', t => {
  const { dir, write } = fixture(t, { duration: 250, limit: { maxSeconds: 240, targetSeconds: 210 } });
  write('gen.mjs', '// 假生成器保持场景不变');
  write('voice-kokoro.py', voiceFixture('assert args.measure and args.apply\nprint("本地假测量完成")'));
  const result = run(dir, 'measure');
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /本地假测量完成/);
  assert.match(result.stdout + result.stderr, /配音实测 250.00 秒.*超过当前上限/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'timing.json'))).dur, 250);
  const cached = run(dir, 'measure');
  assert.match(cached.stdout + cached.stderr, /复用有效 timing.json/);
  assert.match(cached.stdout + cached.stderr, /超过当前上限/);
  assert.notEqual(cached.status, 0);
});

test('实际MP4超过上限，即使时间轴较短，也不能force打包或登记交付凭证', async t => {
  // 时间轴 240s 合规，但实际 MP4 是 241s —— 专测"只信实测媒体"这条。
  const { dir } = fixture(t, { duration: 240, limit: { maxSeconds: 245, targetSeconds: 210 } });
  const file = path.join(dir, 'out/video.mp4');
  const media = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1',
    '-t', '250', '-c:v', 'libx264', '-preset', 'ultrafast', file]);
  assert.equal(media.status, 0);
  assert.match(artifactStatus(dir).stale.duration, /静音成片 250.00 秒/);
  const { createArtifactRecord } = await import('../lib/artifact-status.mjs');
  assert.throws(() => createArtifactRecord(dir, 'render'), /超过当前上限/);
  const packed = run(dir, 'pack', '--force');
  assert.notEqual(packed.status, 0);
  assert.match(packed.stdout + packed.stderr, /video.mp4 250.00 秒/);
});

test('新建CLI项目默认不限时，恢复同目录旧项目不改已有策略', t => {
  const { dir } = fixture(t, { cap: false });
  const fresh = path.join(dir, 'new-project');
  const created = spawnSync(process.execPath, [cli, 'new', fresh], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(created.status, 0, created.stderr + created.stdout);
  assert.deepEqual(durationLimit(fresh), DEFAULT_DURATION_LIMIT);
  assert.match(created.stdout, /不设硬上限/);
  const old = spawnSync(process.execPath, [cli, 'new', dir], { cwd: root, encoding: 'utf8', timeout: 30000 });
  assert.equal(old.status, 0, old.stderr + old.stdout);
  assert.equal(durationLimit(dir), null);
});

test('用户可显式取消上限，再设置长于十五分钟的上限；不混用或自动补目标', t => {
  const { dir } = fixture(t);
  assert.equal(setDurationLimit(dir, { unlimited: true }), null);
  assert.equal(durationLimit(dir), null);
  assert.equal(durationLimitError(durationLimit(dir), 7200), null);
  assert.throws(() => setDurationLimit(dir, { unlimited: true, maxSeconds: 60 }), /不能与/);
  assert.throws(() => setDurationLimit(dir, { targetSeconds: 420 }), /显式指定/);
  assert.deepEqual(setDurationLimit(dir, { maxSeconds: 3600 }), { maxSeconds: 3600, targetSeconds: 3600 });
  const result = run(dir, 'duration', '--unlimited');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(durationLimit(dir), null);
  assert.match(result.stdout, /已取消时长硬上限/);
});

test('不限时长仍要求有效配音测量；制作工具也不能擅自添加限时策略', async t => {
  const { dir } = fixture(t, { limit: null, measured: false, duration: 1800 });
  const result = run(dir, 'render');
  assert.match(result.stdout + result.stderr, /必须先 vh measure/);
  assert.equal(fs.existsSync(path.join(dir, 'render-started')), false);
  const tools = makeTools(dir, () => {}, { mode: 'topic' });
  assert.match(await tools.write_file.run({ path: 'PROJECT.json', content: JSON.stringify({ durationLimit: EXPLICIT_LIMIT }) }), /拒绝.*时长限制/);
});

test('恢复检查点也注入最新四分钟约束，不改旧历史', async t => {
  const { dir } = fixture(t);
  const { writeCheckpoint, readCheckpoint } = await import('../lib/checkpoint.mjs');
  writeCheckpoint(dir, { schemaVersion: 1, taskId: 'duration-resume', mode: 'edit', status: 'cancelled',
    messages: [{ role: 'system', content: '旧提示：长视频' }, { role: 'user', content: '继续原任务' }], pending: [] });
  await runAgent(dir, '继续原任务', { taskId: 'duration-resume', mode: 'edit', resume: true,
    providers: [{ name: 'opendesign', base: 'http://fixture.invalid', key: 'fixture' }], request: async (_p, messages) => {
      assert.equal(messages[0].content, '旧提示：长视频');
      assert.match(messages.at(-1).content, /时长上限.*480 秒/);
      assert.match(messages.at(-1).content, /不要靠加速旁白/);
      return { choices: [{ message: { role: 'assistant', content: '尚待审阅' } }] };
    } });
  assert.equal(readCheckpoint(dir, 'duration-resume').messages[1].content, '继续原任务');
});
