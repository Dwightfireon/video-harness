import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillDir } from '../lib/state.mjs';

test('edge patch: complete generated Python script handles cache, duplicates and partial failures offline', { timeout: 120000 }, t => {
  const python = path.join(process.env.VIDEO_TTS_HOME || path.join(os.homedir(), '.local/share/opencode/video-tts'), 'venv/bin/python');
  const assets = path.join(skillDir() || '', 'assets');
  if (!fs.existsSync(python) || !fs.existsSync(path.join(assets, 'voice-kokoro.py')))
    return t.skip('需要已安装的标准模板及现有 TTS Python；不安装依赖');
  const run = spawnSync(python, ['-B', path.resolve('test/voice-edge-loop.test.py')], {
    encoding: 'utf8', timeout: 110000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', VH_EDGE_TEST_ASSETS: assets },
  });
  assert.equal(run.status, 0, (run.error?.message || '') + run.stdout + run.stderr);
  assert.ok(Number(/Ran (\d+) tests/.exec(run.stderr)?.[1]) >= 12, run.stdout + run.stderr);
  assert.doesNotMatch(run.stderr, /skipped=/);
});
