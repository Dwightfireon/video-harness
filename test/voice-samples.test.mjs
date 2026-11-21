import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planVoiceSamples, createVoiceSamples, voiceSampleStatus, VOICE_SAMPLE_SCRIPT } from '../lib/voice-samples.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-samples-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, '脚本.md'), '## S1 · 试听\n1. 你好，API。\n2. 提高百分之三十。\n');
  return dir;
}

test('Neural auditions select Edge; Kokoro identifiers keep the offline engine', t => {
  const dir = fixture(t);
  assert.equal(planVoiceSamples(dir).engine, 'edge-tts');
  assert.equal(planVoiceSamples(dir, { voice: 'zh-CN-YunyangNeural' }).engine, 'edge-tts');
  assert.equal(planVoiceSamples(dir, { voice: 'zf_001' }).engine, 'kokoro');
  const initial = planVoiceSamples(dir);
  fs.writeFileSync(path.join(dir, 'voice.py'), 'import argparse\n# --measure --apply\nTTS_ENGINE = "edge-tts"\n');
  const withEngine = planVoiceSamples(dir);
  assert.notEqual(withEngine.signature, initial.signature);
  fs.appendFileSync(path.join(dir, 'voice.py'), '# changed synthesis\n');
  assert.notEqual(planVoiceSamples(dir).signature, withEngine.signature);
});

test('Edge sample failures do not register success or change video timing', async t => {
  const dir = fixture(t), plan = planVoiceSamples(dir);
  fs.writeFileSync(path.join(dir, 'timing.json'), 'unchanged timing');
  await assert.rejects(createVoiceSamples(dir, plan, { run: async (_command, argv) => {
    const request = JSON.parse(fs.readFileSync(argv.at(-1), 'utf8'));
    assert.equal(request.engine, 'edge-tts');
    assert.equal(request.voice, 'zh-CN-XiaoyiNeural');
    return { status: 1 };
  } }), /edge-tts.*未登记成功/);
  assert.equal(voiceSampleStatus(dir, plan).ok, false);
  assert.equal(fs.readFileSync(path.join(dir, 'timing.json'), 'utf8'), 'unchanged timing');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'out/voice-samples')), []);
});

// PCM fixture has leading/trailing silence, so the real ffmpeg/trim path is tested.
function audioFixture() {
  const n = 7200, bytes = Buffer.alloc(44 + n * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(n * 2, 40);
  for (let i = 2400; i < 4800; i++) bytes.writeInt16LE(Math.round(Math.sin(i * Math.PI / 24) * 12000), 44 + i * 2);
  return bytes;
}

test('Edge samples use native rate and real decoding without importing Kokoro or entts', { timeout: 30000 }, async t => {
  const python = path.join(process.env.VIDEO_TTS_HOME || path.join(os.homedir(), '.local/share/opencode/video-tts'), 'venv/bin/python');
  if (!fs.existsSync(python)) return t.skip('需要已有 TTS Python；不安装依赖');
  const ready = spawnSync(python, ['-c', 'import numpy,soundfile'], { encoding: 'utf8' });
  if (ready.status !== 0 || spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('需要已有 numpy/soundfile/ffmpeg；不安装依赖');
  const dir = fixture(t), trace = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(path.join(dir, 'input.wav'), audioFixture());
  fs.writeFileSync(path.join(dir, 'kokoro.py'), 'raise RuntimeError("Edge samples must not import Kokoro")\n');
  fs.writeFileSync(path.join(dir, 'entts.py'), 'raise RuntimeError("Edge samples must not import entts")\n');
  fs.writeFileSync(path.join(dir, 'edge_tts.py'), `import os,json
from pathlib import Path
class Communicate:
    def __init__(self, text, voice, rate):
        with open(os.environ['VH_SAMPLE_TRACE'], 'a') as f:
            f.write(json.dumps({'text':text, 'voice':voice, 'rate':rate})+'\\n')
    async def stream(self):
        yield {'type':'WordBoundary', 'text':'ignored'}
        yield {'type':'audio', 'data':Path(os.environ['VH_SAMPLE_AUDIO']).read_bytes()}
`);
  let calls = 0;
  const run = async (_command, argv) => {
    calls++;
    const result = spawnSync(python, ['-B', ...argv], { encoding: 'utf8', timeout: 15000,
      env: { ...process.env, PYTHONPATH: dir, VH_SAMPLE_TRACE: trace, VH_SAMPLE_AUDIO: path.join(dir, 'input.wav') } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result;
  };
  for (const speed of [1, 1.25, 1.5]) {
    const plan = planVoiceSamples(dir, { speed, lines: [1, 2] });
    const result = await createVoiceSamples(dir, plan, { run });
    assert.equal(result.manifest.engine, 'edge-tts');
    assert.equal(result.manifest.origin, 'edge-tts');
    assert.equal(result.manifest.listened, false);
    for (const item of result.manifest.items) {
      const bytes = fs.readFileSync(path.join(result.directory, item.file));
      assert.ok(bytes.length < audioFixture().length, 'boundary silence was removed');
      assert.ok(bytes.length > 44 + 2400 * 2, 'speech plus 25ms padding was retained');
    }
    assert.equal((await createVoiceSamples(dir, plan, { run })).reused, true);
  }
  assert.equal(calls, 3);
  const requests = fs.readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(requests.map(r => r.rate), ['+0%', '+0%', '+25%', '+25%', '+50%', '+50%']);
  assert.ok(requests.every(r => r.voice === 'zh-CN-XiaoyiNeural'));
  assert.equal(fs.existsSync(path.join(dir, 'timing.json')), false);
});

test('sample runner rejects unsupported engines and invalid speeds before synthesis', t => {
  const dir = fixture(t);
  for (const change of [{ engine: 'unknown' }, { speed: 0 }, { speed: 4 }, { items: [] }]) {
    const request = path.join(dir, 'request.json');
    fs.writeFileSync(request, JSON.stringify({ engine: 'edge-tts', voice: 'zh-CN-XiaoyiNeural', speed: 1,
      project: dir, items: [{ text: '测试', file: path.join(dir, 'must-not-exist.wav') }], ...change }));
    const result = spawnSync('python3', ['-B', VOICE_SAMPLE_SCRIPT, '--request', request], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(path.join(dir, 'must-not-exist.wav')), false);
  }
});
