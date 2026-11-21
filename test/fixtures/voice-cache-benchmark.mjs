/* Manual, read-only local-model probe. Never executes project/TTS code.
 * node test/fixtures/voice-cache-benchmark.mjs <existing-project>
 * Only a dedicated temporary copy may be upgraded; never copies model weights.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { upgradeVoice, voiceCacheIdentity, voiceTemplateKind } from '../../lib/voice-upgrade.mjs';

const source = path.resolve(process.argv[2] || 'projects/cthulhu-tacit');
const names = ['voice-kokoro.py', 'entts.py', 'timeline_utils.py'];
const fingerprint = () => Object.fromEntries(names.map(name => [name,
  createHash('sha256').update(fs.readFileSync(path.join(source, name))).digest('hex')]));
const before = fingerprint();
const kind = voiceTemplateKind(fs.readFileSync(path.join(source, names[0]), 'utf8'));
assert.notEqual(kind, 'unknown', 'benchmark requires a complete known standard template');
let temp;
try {
  let project = source;
  if (kind !== 'cache-v2') {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-identity-benchmark-'));
    project = temp;
    for (const name of names) fs.copyFileSync(path.join(source, name), path.join(temp, name));
    assert.equal(upgradeVoice(temp).changed, true);
  }
  let voice = 'zf_001';
  try { voice = JSON.parse(fs.readFileSync(path.join(source, 'timing.json'), 'utf8')).measurement?.voice || voice; } catch {}
  const start = performance.now();
  const result = voiceCacheIdentity(project, { voice });
  const elapsedMs = performance.now() - start;
  assert.deepEqual(fingerprint(), before, 'source input bytes changed during the benchmark');
  console.log(JSON.stringify({ source, sourceTemplate: kind, usedTemporaryTemplate: Boolean(temp), voice,
    runs: 1, elapsedMs: Math.round(elapsedMs * 100) / 100, ok: result.ok,
    signature: result.signature, reason: result.reason, failure: result.failure, detail: result.detail,
    runtime: result.runtime, model: result.inputs?.model,
    sourceInputBytesUnchanged: true, copiedModelWeights: false, loadedModel: false,
    scope: '单次当前 OS 文件缓存状态下的探针耗时，包含 Python 启动、包/模型字节读取与 SHA-256；不是磁盘冷缓存、配音或端到端制作基准。' }, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
}
