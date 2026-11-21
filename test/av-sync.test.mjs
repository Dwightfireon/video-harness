import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshot, saveState, probeDuration } from '../lib/state.mjs';
import { deliverableState } from '../lib/deliverable.mjs';
import { runAgent } from '../lib/agent.mjs';
import { currentArtifactInputs, createArtifactRecord } from '../lib/artifact-status.mjs';

const providers = [{ name: 'opendesign', key: 'fixture', base: 'http://fixture.invalid' }];
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] });

/* 生成一段指定时长、带音轨的测试视频（本地 ffmpeg，不联网）。 */
function makeVideo(file, seconds, { withAudio = true } = {}) {
  const args = ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=black:s=64x36:r=30:d=${seconds}`];
  if (withAudio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:d=${seconds}`, '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (withAudio) args.push('-c:a', 'aac');
  args.push(file);
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('测试视频生成失败：' + r.stderr);
}

function fixture(t, { timeline = 20, video = 10, voice = 10, segments } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-sync-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'out', 'seg'), { recursive: true });
  // 本组只验收视频；发布包由 publish.test.mjs 单独覆盖。
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{"deliveryTarget":"video"}');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 测试\n1. 一句话。\n');
  fs.writeFileSync(path.join(dir, '方案.md'), '# 方案\n受众基线：已经知道。\n');
  fs.writeFileSync(path.join(dir, 'claims.json'), '[]');
  fs.writeFileSync(path.join(dir, 'scenes.src.js'), '//---\nroot => ({render(){}})\n');
  fs.writeFileSync(path.join(dir, 'scene.html'),
    `<script>const DURATION = ${timeline};</script><script>const SUBS = [{"s":0.5,"e":5,"t":"一句话"}];</script>`);
  if (video) makeVideo(path.join(dir, 'out', 'video.mp4'), video, { withAudio: false });
  if (voice) makeVideo(path.join(dir, 'out', 'video-voice.mp4'), voice);
  if (segments != null) fs.writeFileSync(path.join(dir, 'out', 'seg', 'manifest.json'), JSON.stringify({ duration: segments }));
  if (video === timeline && voice === timeline) recordSuccessfulMedia(dir);
  return dir;
}

function recordSuccessfulMedia(dir) {
  const inputs = currentArtifactInputs(dir);
  saveState(dir, { genStamp: { scriptHash: inputs.sourceHashes['脚本.md'], scenesHash: inputs.sourceHashes['scenes.src.js'], sourceHashes: inputs.sourceHashes },
    render: { sceneHtmlHash: inputs.sceneHtmlHash, artifact: createArtifactRecord(dir, 'render') },
    voice: { artifact: createArtifactRecord(dir, 'voice') } });
}

test('probeDuration 读真实媒体时长，不读 scene.html', t => {
  const dir = fixture(t, { timeline: 20, video: 10, voice: 12 });
  assert.ok(Math.abs(probeDuration(path.join(dir, 'out/video.mp4')) - 10) < 0.2);
  assert.ok(Math.abs(probeDuration(path.join(dir, 'out/video-voice.mp4')) - 12) < 0.2);
  assert.equal(probeDuration(path.join(dir, 'out/missing.mp4')), null);
});

test('成片比时间轴短：判定过期并指出真实秒数（本次声画不同步的根因）', async t => {
  const dir = fixture(t, { timeline: 535.03, video: 512.7, voice: 512.15, segments: 512.7 });
  const s = await snapshot(dir);
  assert.match(s.stale.render, /512\.70s/);
  assert.match(s.stale.render, /535\.03s/);
  assert.match(s.stale.voice, /512\.15s|512\.70s/);
});

test('配音与成片同长但仍短于时间轴：两条都要报，不能因为它们相等就放过', async t => {
  const dir = fixture(t, { timeline: 100, video: 80, voice: 80 });
  const s = await snapshot(dir);
  assert.match(s.stale.render, /80\.00s/);
  assert.match(s.stale.voice, /80\.00s/);
});

test('分段总长与时间轴不符：明确指出含旧分段，需清缓存整片重渲', async t => {
  const dir = fixture(t, { timeline: 535.03, video: 535, voice: 535, segments: 512.7 });
  const s = await snapshot(dir);
  assert.match(s.stale.render, /分段总长 512\.70s/);
  assert.match(s.stale.render, /旧分段/);
});

test('全部一致时不误报', async t => {
  const dir = fixture(t, { timeline: 20, video: 20, voice: 20, segments: 20 });
  const s = await snapshot(dir);
  assert.equal(s.stale.render, undefined);
  assert.equal(s.stale.voice, undefined);
  assert.equal(deliverableState(dir).stale, false);
});

test('旧账本把 voice.dur 记成时间轴时，改用真实时长而不是相信记录', async t => {
  const dir = fixture(t, { timeline: 535.03, video: 512.7, voice: 512.15 });
  // 模拟旧版本写坏的记账：两边都等于时间轴，永远相等。
  saveState(dir, { render: { dur: 535.03 }, voice: { dur: 535.03 } });
  const s = await snapshot(dir);
  assert.ok(s.stale.render, '必须按真实媒体时长判定');
  assert.ok(s.stale.voice);
});

test('说完成但成片落后：Agent 被要求补完，不能直接结束', async t => {
  const dir = fixture(t, { timeline: 40, video: 10, voice: 10 });
  let calls = 0; const nudges = [];
  const result = await runAgent(dir, '做片子', { taskId: 'stale-nudge', mode: 'topic', providers, stepBudget: 10,
    log: line => { if (line.includes('成片落后')) nudges.push(line); },
    request: async (_p, messages) => {
      calls++;
      if (calls === 1) return reply('已完成，产物在 out/video-voice.mp4。');
      const nudge = messages.filter(m => m.role === 'user' && /你还不能结束/.test(m.content));
      assert.equal(nudge.length, 1);
      assert.match(nudge[0].content, /最少失效阶段/);
      assert.doesNotMatch(nudge[0].content, /render --all|--force|依次跑 measure/);
      return reply('好，我重新渲染并配音。');
    } });
  assert.equal(calls, 2, '必须给过一次纠正机会');
  assert.ok(nudges.length);
  assert.equal(result.status, 'paused');
  assert.equal(result.answer, '');
  assert.match(result.paused, /尚未交付/);
  // 模型没真的补完：保留可恢复暂停，不把一句回复当成已完成。
  assert.equal(result.deliverable.stale, true);
});

test('外部本地合成补完真实媒体：topic 提醒并暂停 → ffmpeg 与内容凭证 → 恢复校验完成', async t => {
  const dir = fixture(t, { timeline: 2, video: 1, voice: 1 });
  let calls = 0;
  const initial = await runAgent(dir, '补完片子', { taskId: 'actually-completed', mode: 'topic', providers, stepBudget: 5,
    request: async (_p, messages) => {
      if (++calls === 1) return reply('完成');
      assert.ok(messages.some(m => m.role === 'user' && /你还不能结束/.test(m.content)));
      return reply('等待本地制作完成');
    } });
  assert.equal(initial.status, 'paused');
  assert.equal(initial.deliverable.stale, true);
  assert.equal(calls, 2);

  // 独立可信的本地执行模拟用户从 CLI 补完，不把 shell 工具塞进 topic 作者阶段。
  makeVideo(path.join(dir, 'out/video.mp4'), 2, { withAudio: false });
  makeVideo(path.join(dir, 'out/video-voice.mp4'), 2);
  for (const file of ['out/video.mp4', 'out/video-voice.mp4']) {
    assert.ok(Math.abs(probeDuration(path.join(dir, file)) - 2) < 0.2);
  }
  assert.equal(deliverableState(dir).stale, true, '时长相等还不够，必须有当前输入的媒体内容凭证');
  recordSuccessfulMedia(dir);
  const result = await runAgent(dir, '补完片子', { taskId: 'actually-completed', mode: 'topic', providers, stepBudget: 5, resume: true,
    request: async () => {
      calls++;
      assert.equal(deliverableState(dir).stale, false, '接续时由真实媒体和当前内容凭证共同验收');
      return reply('已补做并核对成片');
    } });
  assert.equal(calls, 3);
  assert.equal(result.status, 'completed');
  assert.equal(result.deliverable.stale, false);
  assert.ok(Math.abs(probeDuration(path.join(dir, 'out/video-voice.mp4')) - 2) < 0.2);
});

test('成片是新的：不打断正常收尾', async t => {
  const dir = fixture(t, { timeline: 20, video: 20, voice: 20 });
  // 让源文件比成片旧
  const old = Date.now() - 200000;
  for (const f of ['脚本.md', 'scenes.src.js', '方案.md', 'claims.json']) {
    fs.utimesSync(path.join(dir, f), new Date(old), new Date(old));
  }
  let calls = 0;
  const result = await runAgent(dir, '做片子', { taskId: 'fresh', mode: 'topic', providers, stepBudget: 5,
    request: async () => { calls++; return reply('完成'); } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'completed');
  assert.equal(result.deliverable.stale, false);
});
