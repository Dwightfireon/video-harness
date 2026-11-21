import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEFAULT_NARRATION, LEGACY_NARRATION, projectVoiceDefaults, voiceParameters } from '../lib/voice-defaults.mjs';
import { planVoiceSamples } from '../lib/voice-samples.mjs';
import { skillDir } from '../lib/state.mjs';

function fixture(t, snapshot) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-defaults-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'PROJECT.json'), '{}');
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 试听\n1. 同一段旁白。\n');
  fs.writeFileSync(path.join(dir, 'voice.py'), 'import argparse\n# --measure --apply\n' +
    (snapshot ? 'VH_NARRATION_DEFAULTS = ' + JSON.stringify(snapshot) + '\n' : '# older custom Edge script\n'));
  return dir;
}

test('chosen default is Xiaoxiao 1.25, with .35s extra sentence spacing', () => {
  assert.equal(DEFAULT_NARRATION.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(DEFAULT_NARRATION.speed, 1.25);
  assert.equal(DEFAULT_NARRATION.timing.tail + DEFAULT_NARRATION.timing.gap, .35);
  assert.equal(DEFAULT_NARRATION.timing.sceneBeat, LEGACY_NARRATION.timing.sceneBeat);
});

test('old projects without a snapshot retain legacy fallback without any writes', t => {
  const dir = fixture(t), before = fs.readFileSync(path.join(dir, 'voice.py'));
  assert.deepEqual(voiceParameters(dir), { voice: 'zh-CN-XiaoyiNeural', speed: 1 });
  assert.equal(projectVoiceDefaults(dir).preset, 'legacy');
  assert.deepEqual(fs.readFileSync(path.join(dir, 'voice.py')), before);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
});

test('new project snapshot drives samples and production; measurement and CLI override it', t => {
  const dir = fixture(t, DEFAULT_NARRATION);
  assert.deepEqual(voiceParameters(dir), { voice: 'zh-CN-XiaoxiaoNeural', speed: 1.25 });
  assert.equal(planVoiceSamples(dir).voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(planVoiceSamples(dir).speed, 1.25);
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out/.vh-state.json'), JSON.stringify({ measureParams: { voice: 'zh-CN-YunxiNeural', speed: 1.15 } }));
  assert.deepEqual(voiceParameters(dir), { voice: 'zh-CN-YunxiNeural', speed: 1.15 });
  fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ measurement: { voice: 'zh-CN-YunyangNeural', speed: 1.1 } }));
  assert.deepEqual(voiceParameters(dir), { voice: 'zh-CN-YunyangNeural', speed: 1.1 });
  assert.deepEqual(voiceParameters(dir, { voice: 'zh-CN-XiaoyiNeural', speed: '1.5' }), { voice: 'zh-CN-XiaoyiNeural', speed: 1.5 });
  assert.equal(planVoiceSamples(dir).voice, 'zh-CN-YunyangNeural');
});

test('project snapshots remain independent of later global defaults', t => {
  const chosen = { ...DEFAULT_NARRATION, voice: 'zh-CN-YunxiNeural', speed: 1.18 };
  const dir = fixture(t, chosen);
  assert.deepEqual(voiceParameters(dir), { voice: chosen.voice, speed: chosen.speed });
  assert.equal(projectVoiceDefaults(dir).timing.gap, chosen.timing.gap);
  fs.appendFileSync(path.join(dir, 'voice.py'), '# unrelated custom code retained\n');
  assert.equal(projectVoiceDefaults(dir).voice, chosen.voice);
});

test('invalid snapshot fails explicitly rather than silently switching voice', t => {
  const dir = fixture(t, { ...DEFAULT_NARRATION, speed: 0 });
  assert.throws(() => projectVoiceDefaults(dir), /配音默认配置无效/);
});

test('real vh new snapshots the selected preset and lists matching samples without synthesis', { timeout: 30000 }, t => {
  if (!skillDir()) return t.skip('需要已有脚手架；不下载');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-default-new-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dir = path.join(parent, 'project');
  const created = spawnSync(process.execPath, ['vh.mjs', 'new', dir], { encoding: 'utf8', timeout: 20000 });
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.deepEqual(projectVoiceDefaults(dir), DEFAULT_NARRATION);
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 小样\n1. 新片默认配置。\n');
  const listed = spawnSync(process.execPath, ['vh.mjs', 'voice-sample', '--list', '--dir', dir], { encoding: 'utf8', timeout: 5000 });
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  const plan = JSON.parse(listed.stdout);
  assert.equal(plan.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(plan.speed, 1.25);
  assert.equal(plan.engine, 'edge-tts');
  assert.equal(fs.existsSync(path.join(dir, 'timing.json')), false);
});
