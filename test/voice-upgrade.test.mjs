import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillDir } from '../lib/state.mjs';
import { upgradeVoice, voiceTemplateKind, voiceCacheIdentity, voiceCacheTimingStatus, voiceTimingCompatibility, VOICE_UPGRADE_MARK, VOICE_CACHE_PROBE } from '../lib/voice-upgrade.mjs';

test('known voice upgrade: real Python cold/hit execution and output equivalence', t => {
  const assets = path.join(skillDir() || '', 'assets');
  const source = path.join(assets, 'voice-kokoro.py');
  if (!fs.existsSync(source)) return t.skip('需要已安装的标准 article-video 模板');
  const python = path.join(process.env.VIDEO_TTS_HOME || path.join(os.homedir(), '.local/share/opencode/video-tts'), 'venv/bin/python');
  if (!fs.existsSync(python)) return t.skip('需要共享 TTS Python 的 numpy/soundfile');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-upgrade-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['baseline', 'cache']) {
    const project = path.join(dir, name); fs.mkdirSync(project);
    fs.copyFileSync(source, path.join(project, 'voice-kokoro.py'));
    fs.copyFileSync(path.join(assets, 'timeline_utils.py'), path.join(project, 'timeline_utils.py'));
  }
  const project = path.join(dir, 'cache');
  const result = upgradeVoice(project);
  assert.equal(result.changed, true, JSON.stringify(result));
  assert.equal(result.cacheIdentityChanged, true);
  assert.equal(voiceTemplateKind(fs.readFileSync(path.join(project, 'voice-kokoro.py'), 'utf8')), 'cache-v2');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), fs.readFileSync(source, 'utf8'));
  assert.equal(upgradeVoice(project).reason, 'already-upgraded');
  const run = spawnSync(python, [path.resolve('test/fixtures/voice-upgrade-probe.py'), dir], { encoding: 'utf8', timeout: 30000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const env = { ...process.env, HF_HUB_CACHE: path.join(dir, 'hub'), VH_FORBID_MODEL_IMPORT: '1' };
  const identity = voiceCacheIdentity(project, { python, env });
  assert.equal(identity.ok, true, JSON.stringify(identity));
  assert.equal(identity.runtime.requestedPython, python);
  assert.equal(identity.runtime.selection, 'explicit');
  assert.equal(identity.runtime.isolated, false);
  assert.equal(identity.runtime.bytecodeDisabled, true);
  assert.equal(identity.runtime.synthesisRuntimeVerified, true);
  assert.equal(identity.runtime.executable, python);
  assert.match(identity.runtime.note, /find_spec/);
  const timing = JSON.parse(fs.readFileSync(path.join(project, 'timing.json'), 'utf8'));
  assert.equal(voiceCacheTimingStatus(project, timing, { python, env }).ok, true);
  const logs = fs.readFileSync(path.join(project, 'model.log'), 'utf8');
  const compatible = voiceTimingCompatibility(project, timing, { python, env });
  assert.equal(compatible.required, true);
  assert.equal(compatible.ok, true);
  assert.equal(compatible.verified, true);
  assert.equal(compatible.template, 'cache-v2');
  assert.equal(compatible.runtime.synthesisRuntimeVerified, true);
  assert.equal(fs.readFileSync(path.join(project, 'model.log'), 'utf8'), logs);
  const unavailable = voiceTimingCompatibility(project, timing, { python: path.join(dir, 'missing-python'), env });
  assert.equal(unavailable.required, true);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.verified, false);
  assert.equal(unavailable.runtime.isolated, false);
  assert.equal(unavailable.runtime.synthesisRuntimeVerified, false);
  const recorded = timing.measurement.ttsIdentity;
  delete timing.measurement.ttsIdentity;
  assert.equal(voiceCacheTimingStatus(project, timing, { python, env }).reason, 'tts-inputs-changed');
  assert.equal(voiceTimingCompatibility(project, timing, { python, env }).ok, false);
  timing.measurement.ttsIdentity = recorded;
  fs.appendFileSync(path.join(project, 'entts.py'), '# another byte change\n');
  assert.notEqual(voiceCacheIdentity(project, { python, env }).signature, identity.signature);
  assert.equal(voiceTimingCompatibility(project, timing, { python, env }).ok, false);
  fs.appendFileSync(path.join(project, 'voice-kokoro.py'), '# unknown customization\n');
  assert.equal(upgradeVoice(project).reason, 'unknown-template');
  assert.equal(voiceCacheIdentity(project, { python, env }).reason, 'unversioned-template');
  assert.equal(voiceTimingCompatibility(project, timing, { python, env }).required, true);
  assert.equal(voiceTimingCompatibility(project, timing, { python, env }).ok, false);
  delete timing.measurement.ttsIdentity;
  assert.equal(voiceTimingCompatibility(project, timing, { python, env }).required, false);
  assert.equal(voiceTimingCompatibility(project, timing, { python, env }).verified, false);
});

test('default python3 follows the exact template bootstrap across two runtimes and PYTHONPATH changes', t => {
  const assets = path.join(skillDir() || '', 'assets');
  const source = path.join(assets, 'voice-kokoro.py');
  if (!fs.existsSync(source)) return t.skip('需要已安装的标准 article-video 模板');
  const basePython = path.join(process.env.VIDEO_TTS_HOME || path.join(os.homedir(), '.local/share/opencode/video-tts'), 'venv/bin/python');
  if (!fs.existsSync(basePython)) return t.skip('需要本地 Python venv，不安装或下载依赖');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (python, args, options = {}) => {
    const result = spawnSync(python, args, { encoding: 'utf8', timeout: 30000, ...options });
    assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message || ''));
    return result.stdout.trim();
  };
  const launcher = path.join(dir, 'launcher'), home = path.join(dir, 'tts-home'), fallback = path.join(home, 'venv');
  for (const venv of [launcher, fallback]) run(basePython, ['-B', '-m', 'venv', '--without-pip', venv]);
  const pythonA = path.join(launcher, 'bin/python3'), pythonB = path.join(fallback, 'bin/python');
  const purelibB = run(pythonB, ['-B', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))']);
  const mockPackages = (directory, label) => {
    fs.mkdirSync(directory, { recursive: true });
    for (const name of ['kokoro', 'misaki']) fs.writeFileSync(path.join(directory, name + '.py'),
      `raise RuntimeError("${name} must not be imported by the identity probe: ${label}")\n`);
  };
  mockPackages(purelibB, 'runtime-b');
  const pathOne = path.join(dir, 'pythonpath-one'), pathTwo = path.join(dir, 'pythonpath-two');
  mockPackages(pathOne, 'pythonpath-one'); mockPackages(pathTwo, 'pythonpath-two');
  const project = path.join(dir, 'project'); fs.mkdirSync(project);
  for (const name of ['voice-kokoro.py', 'timeline_utils.py', 'entts.py']) fs.copyFileSync(path.join(assets, name), path.join(project, name));
  assert.equal(upgradeVoice(project).changed, true);
  const template = fs.readFileSync(path.join(project, 'voice-kokoro.py'), 'utf8');
  // Execute the exact known bootstrap, stopping before argparse/numpy/model
  // imports. Its real execv then re-enters this parity script in runtime B.
  const bootstrap = template.slice(0, template.indexOf('import argparse, re, subprocess, hashlib, json'));
  const functions = fs.readFileSync(VOICE_CACHE_PROBE, 'utf8').split('# CLI boundary:')[0];
  const parity = path.join(project, 'bootstrap-parity.py');
  fs.writeFileSync(parity, bootstrap + `
from pathlib import Path
HERE = Path(__file__).resolve().parent
os.chdir(HERE)
sys.path.insert(0, str(HERE))
exec(${JSON.stringify(functions)}, globals())
identity = voice_cache_identity(HERE, HERE / 'voice-kokoro.py', 'zf_001')
print(json.dumps({'signature': identity['signature'], 'executable': sys.executable, 'sysPath': sys.path,
                  'modelImported': any(name in sys.modules for name in ('kokoro', 'misaki', 'entts'))}))
`);
  const repo = path.join(dir, 'hub/models--hexgrad--Kokoro-82M-v1.1-zh');
  const snapshot = path.join(repo, 'snapshots', 'a'.repeat(40));
  fs.mkdirSync(path.join(repo, 'refs'), { recursive: true });
  fs.mkdirSync(path.join(snapshot, 'voices'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'refs/main'), 'a'.repeat(40));
  for (const name of ['config.json', 'kokoro-v1_1-zh.pth', 'voices/zf_001.pt']) fs.writeFileSync(path.join(snapshot, name), 'mock local model');
  const env = { ...process.env, PATH: path.join(launcher, 'bin') + path.delimiter + process.env.PATH,
    VIDEO_TTS_HOME: home, HF_HUB_CACHE: path.join(dir, 'hub'), PYTHONDONTWRITEBYTECODE: '1' };
  delete env.PYTHONPATH; delete env.PYTHONHOME; delete env._VIDEO_TTS_REEXEC; delete env.PYTHONSAFEPATH;
  const parityCheck = (environment, options = {}) => {
    const identity = voiceCacheIdentity(project, { env: environment, ...options });
    assert.equal(identity.ok, true, JSON.stringify(identity));
    const actual = JSON.parse(run(options.python || 'python3', ['-B', parity], { cwd: project, env: environment }));
    assert.equal(identity.signature, actual.signature);
    assert.equal(identity.runtime.executable, actual.executable);
    assert.deepEqual(identity.runtime.packageSearchPath, actual.sysPath);
    assert.equal(identity.runtime.synthesisRuntimeVerified, true);
    assert.equal(identity.runtime.isolated, false);
    assert.equal(actual.modelImported, false);
    return identity;
  };
  const reexec = parityCheck(env);
  assert.equal(reexec.runtime.selection, 'template-reexec');
  assert.equal(reexec.runtime.executable, pythonB);
  const first = parityCheck({ ...env, PYTHONPATH: pathOne });
  assert.equal(first.runtime.selection, 'path-python3');
  assert.equal(first.runtime.executable, pythonA);
  assert.notEqual(first.signature, reexec.signature);
  const second = parityCheck({ ...env, PYTHONPATH: pathTwo });
  assert.equal(second.runtime.executable, pythonA);
  assert.notEqual(second.signature, first.signature);
  const explicit = parityCheck({ ...env, PYTHONPATH: pathOne }, { python: pythonB });
  assert.equal(explicit.runtime.selection, 'explicit');
  assert.equal(explicit.runtime.executable, pythonB);
  parityCheck({ ...env, PYTHONPATH: pathOne, PYTHONSAFEPATH: '1' });
  assert.equal(voiceCacheIdentity(project, { env: { ...env, VIDEO_TTS_HOME: path.join(dir, 'missing-home') } }).ok, false);
  assert.equal(voiceCacheIdentity(project, { env: { ...env, _VIDEO_TTS_REEXEC: '1' } }).ok, false);
  for (const directory of [project, pathOne, pathTwo]) assert.equal(fs.existsSync(path.join(directory, '__pycache__')), false);
});

test('the exact known lazy-v1 template migrates with its own backup', t => {
  const assets = path.join(skillDir() || '', 'assets');
  const source = path.join(assets, 'voice-kokoro.py');
  if (!fs.existsSync(source)) return t.skip('需要已安装的标准 article-video 模板');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-lazy-migrate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = fs.readFileSync(source, 'utf8');
  const file = path.join(dir, 'voice-kokoro.py');
  fs.writeFileSync(file, original);
  const originalStatus = voiceTimingCompatibility(dir, {});
  assert.equal(originalStatus.template, 'original');
  assert.equal(originalStatus.required, true);
  assert.equal(originalStatus.ok, false);
  assert.equal(originalStatus.reason, 'upgrade-and-remeasure-required');
  assert.equal(voiceTimingCompatibility(dir, { measurement: { ttsIdentity: 'old' } }).ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  const lazy = original.replace('        import kokoro  # noqa: F401\n        return True', '        import importlib.util\n        return importlib.util.find_spec("kokoro") is not None')
    .replace(`# ---------- 加载模型 ----------
from entts import en_callable
from kokoro import KPipeline
pipe = KPipeline(lang_code="z", repo_id="hexgrad/Kokoro-82M-v1.1-zh", en_callable=en_callable)

SR = 24000
def synth(text, speed):`, `# ---------- 加载模型（vh:lazy-kokoro-v1） ----------
pipe = None

def _get_pipeline():
    global pipe
    if pipe is None:
        from entts import en_callable
        from kokoro import KPipeline
        pipe = KPipeline(lang_code="z", repo_id="hexgrad/Kokoro-82M-v1.1-zh", en_callable=en_callable)
    return pipe

SR = 24000
def synth(text, speed):
    pipe = _get_pipeline()`);
  assert.equal(voiceTemplateKind(lazy), 'lazy-v1');
  fs.writeFileSync(path.join(dir, 'voice-kokoro.py'), lazy);
  const lazyStatus = voiceTimingCompatibility(dir, {});
  assert.equal(lazyStatus.template, 'lazy-v1');
  assert.equal(lazyStatus.required, true);
  assert.equal(lazyStatus.ok, false);
  assert.equal(lazyStatus.reason, 'upgrade-and-remeasure-required');
  assert.equal(fs.readFileSync(file, 'utf8'), lazy);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  const result = upgradeVoice(dir);
  assert.equal(result.changed, true);
  assert.equal(result.from, 'lazy-v1');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), lazy);
  assert.equal(upgradeVoice(dir).reason, 'already-upgraded');
});

test('compatibility is not certification; unknown/missing/linked scripts cannot downgrade existing identities', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-compatibility-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'voice-kokoro.py');
  for (const variant of ['missing', 'custom', 'symlink', 'dangling-symlink', 'directory']) {
    if (variant === 'custom') fs.writeFileSync(file, '# ' + VOICE_UPGRADE_MARK + '\nraise RuntimeError("must not execute")\n');
    if (variant === 'symlink') { fs.renameSync(file, path.join(dir, 'custom.py')); fs.symlinkSync('custom.py', file); }
    if (variant === 'dangling-symlink') { fs.unlinkSync(file); fs.symlinkSync('does-not-exist.py', file); }
    if (variant === 'directory') { fs.unlinkSync(file); fs.mkdirSync(file); }
    const compatible = voiceTimingCompatibility(dir, {});
    assert.equal(compatible.required, false, variant);
    assert.equal(compatible.ok, true, variant);
    assert.equal(compatible.verified, false, variant);
    assert.equal(compatible.reason, 'legacy-unverified', variant);
    assert.match(compatible.note, /未核验/);
    for (const ttsIdentity of ['old', '', null, undefined]) {
      const guarded = voiceTimingCompatibility(dir, { measurement: { ttsIdentity } });
      assert.equal(guarded.required, true, variant);
      assert.equal(guarded.ok, false, variant);
      assert.equal(guarded.verified, false, variant);
    }
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  }
  assert.match(fs.readFileSync(path.join(dir, 'custom.py'), 'utf8'), /must not execute/);
});

test('unknown/custom and symlinked voice scripts are never overwritten', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-custom-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'voice-kokoro.py');
  const custom = '# vh:lazy-kokoro-v1\n# ' + VOICE_UPGRADE_MARK + '\nprint("custom")\n';
  fs.writeFileSync(file, custom);
  assert.equal(upgradeVoice(dir).reason, 'unknown-template');
  assert.equal(fs.readFileSync(file, 'utf8'), custom);
  assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  fs.renameSync(file, path.join(dir, 'custom.py'));
  fs.symlinkSync('custom.py', file);
  assert.throws(() => upgradeVoice(dir), /普通文件/);
  assert.equal(fs.readFileSync(file, 'utf8'), custom);
  fs.unlinkSync(file);
  fs.symlinkSync('missing.py', file);
  assert.throws(() => upgradeVoice(dir), /普通文件/);
});

test('known scripts never write through symlinked backup directories', t => {
  const source = path.join(skillDir() || '', 'assets/voice-kokoro.py');
  if (!fs.existsSync(source)) return t.skip('需要已安装的标准 article-video 模板');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-voice-backup-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'project'), outside = path.join(dir, 'outside');
  fs.mkdirSync(project); fs.mkdirSync(outside);
  fs.copyFileSync(source, path.join(project, 'voice-kokoro.py'));
  fs.symlinkSync(outside, path.join(project, 'out'));
  assert.throws(() => upgradeVoice(project), /普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(voiceTemplateKind(fs.readFileSync(path.join(project, 'voice-kokoro.py'), 'utf8')), 'original');
  fs.unlinkSync(path.join(project, 'out')); fs.mkdirSync(path.join(project, 'out'));
  fs.symlinkSync(outside, path.join(project, 'out/.vh-voice-backups'));
  assert.throws(() => upgradeVoice(project), /普通目录/);
  assert.deepEqual(fs.readdirSync(outside), []);
});
