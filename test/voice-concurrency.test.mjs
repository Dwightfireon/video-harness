import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { selectVoiceScript, requireVoiceScript, voiceScriptSupportsConcurrency } from '../lib/voice-script.mjs';

const script = (args) => `#!/usr/bin/env python3
import argparse
ap = argparse.ArgumentParser()
ap.add_argument("--measure", action="store_true")
ap.add_argument("--apply", action="store_true")
${args}
`;

function project(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-concurrency-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'voice-kokoro.py'), body);
  return dir;
}

test('只有声明了 --tts-concurrency 的配音脚本才被判定支持', t => {
  const withFlag = project(t, script('ap.add_argument("--tts-concurrency", dest="tts_concurrency")'));
  assert.equal(voiceScriptSupportsConcurrency(withFlag), true);
  assert.equal(voiceScriptSupportsConcurrency(withFlag, requireVoiceScript(withFlag).name), true);

  const without = project(t, script('ap.add_argument("--maxspeed")'));
  assert.equal(voiceScriptSupportsConcurrency(without), false);
  assert.equal(voiceScriptSupportsConcurrency(without, 'voice-kokoro.py'), false);
});

test('缺失或不可读的脚本不会被误判为支持并发', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-concurrency-empty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(voiceScriptSupportsConcurrency(dir), false);
  assert.equal(voiceScriptSupportsConcurrency(dir, 'nope.py'), false);
  assert.equal(selectVoiceScript(dir).name, null);
});

test('脚本内容只从参数声明判断，不看引擎名或文件名', t => {
  // Kokoro 风格脚本即使带注释提到并发，只要没有真正的参数声明就不支持。
  const misleading = project(t, script('# 并发合成见 --tts-concurrency（示例）\nap.add_argument("--speed")'));
  assert.equal(voiceScriptSupportsConcurrency(misleading), false);
});
