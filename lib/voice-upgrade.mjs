/* Exact-template migration. Unknown/custom code is never certified by a marker. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const VOICE_UPGRADE_MARK = 'vh:voice-cache-v2';
export const KNOWN_VOICE_SHA256 = '91ff35499c30991f67ed6de8bc6a2682c438c6eb003760ec5603dd7c8b1314c9';
export const VOICE_CACHE_PROBE = fileURLToPath(new URL('./voice-cache.py', import.meta.url));
const identitySource = fs.readFileSync(VOICE_CACHE_PROBE, 'utf8').split('# CLI boundary:')[0].trimEnd();
const sha = source => createHash('sha256').update(source).digest('hex');
const oldProbe = '        import kokoro  # noqa: F401\n        return True';
const newProbe = '        import importlib.util\n        return importlib.util.find_spec("kokoro") is not None';
const oldLoad = `# ---------- 加载模型 ----------
from entts import en_callable
from kokoro import KPipeline
pipe = KPipeline(lang_code="z", repo_id="hexgrad/Kokoro-82M-v1.1-zh", en_callable=en_callable)

SR = 24000
def synth(text, speed):`;
const lazyLoad = `# ---------- 加载模型（vh:lazy-kokoro-v1） ----------
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
    pipe = _get_pipeline()`;

const cacheLoad = lazyLoad.replace('vh:lazy-kokoro-v1', VOICE_UPGRADE_MARK)
  .replace('        from entts import en_callable', '        os.environ["HF_HUB_OFFLINE"] = "1"\n        os.environ["HF_DATASETS_OFFLINE"] = "1"\n        from entts import en_callable');
/* 模型文件的合法边界：旧模板用仓库目录；新版 huggingface 用 hub/blobs 跨仓库去重，
 * 快照里的软链真实路径在模型仓库目录之外、但仍在本机 hub 缓存内。
 * 这条不是模板升级，而是**身份探针缺陷修正**：只放宽边界（repo → hub），
 * 不改合成逻辑、不改签名输入。已有项目里嵌入的那一段单独迁移。 */
export const OLD_MODEL_BOUNDARY = '    model = {name: _vh_file(snapshot / name, repo) for name in';
export const NEW_MODEL_BOUNDARY = '    model = {name: _vh_file(snapshot / name, hub) for name in';

const edits = [
  [oldProbe, newProbe],
  [oldLoad, cacheLoad],
  ['os.chdir(HERE)', `os.chdir(HERE)\n\n# ${VOICE_UPGRADE_MARK}: stdlib-only local identity\n${identitySource}\n# ${VOICE_UPGRADE_MARK}: identity end`],
  ['"measurement": {"voice": args.voice, "speed": args.speed},', '"measurement": {"voice": args.voice, "speed": args.speed, "ttsIdentity": VOICE_CACHE_IDENTITY["signature"]},'],
  ['    news = {i: x["s"] for i, x in enumerate(data["subs"])}', '    _vh_check_timing(data, HERE, Path(__file__))\n    news = {i: x["s"] for i, x in enumerate(data["subs"])}'],
  ['if not args.measure and TIMING.exists():', 'VOICE_CACHE_IDENTITY = voice_cache_identity(HERE, Path(__file__), args.voice)\n\nif not args.measure and TIMING.exists():'],
  ['    validate_timing(cached_timing, current_groups, args.voice, args.speed)', '    validate_timing(cached_timing, current_groups, args.voice, args.speed)\n    _vh_check_timing(cached_timing, HERE, Path(__file__), VOICE_CACHE_IDENTITY)'],
  ['TMP.mkdir(parents=True, exist_ok=True)', 'for directory in (OUT, TMP):\n    if directory.is_symlink():\n        raise ValueError("TTS output directory must not be a symlink")\n    directory.mkdir(exist_ok=True)'],
  ['CACHE = TMP / "cache"; CACHE.mkdir(parents=True, exist_ok=True)', 'CACHE = TMP / "cache" / "v2" / VOICE_CACHE_IDENTITY["signature"]\nfor directory in (TMP / "cache", TMP / "cache" / "v2", CACHE):\n    if directory.is_symlink():\n        raise ValueError("TTS cache directory must not be a symlink")\n    directory.mkdir(exist_ok=True)'],
  ['    key = hashlib.sha1(f"{args.voice}|{speed:.5f}|{text}".encode("utf-8")).hexdigest()[:16]', '    key = hashlib.sha256(_vh_json([args.voice, float(speed).hex(), text]).encode("utf-8")).hexdigest()'],
  ['        return sf.read(str(f))[0]', '        if f.is_symlink() or not f.is_file():\n            raise ValueError("TTS cache must be a regular file")\n        cached, sample_rate = sf.read(str(f))\n        if sample_rate != SR or cached.ndim != 1 or not cached.size or not np.isfinite(cached).all():\n            raise ValueError("Invalid TTS cache audio")\n        return cached'],
  ['    if not args.no_cache and f.exists():', '    if f.is_symlink():\n        raise ValueError("TTS cache must not be a symlink")\n    if not args.no_cache and f.exists():'],
  ['# ---------- --measure：给"收紧后的时间轴"建议，不渲染 ----------', 'if voice_cache_identity(HERE, Path(__file__), args.voice)["signature"] != VOICE_CACHE_IDENTITY["signature"]:\n    sys.exit("TTS inputs changed during synthesis; no timing or mux recorded")\n\n# ---------- --measure：给"收紧后的时间轴"建议，不渲染 ----------'],
];

function replaceExact(source, from, to) {
  if (source.split(from).length !== 2) throw new Error('已知配音模板的替换锚点不唯一，未升级');
  return source.replace(from, to);
}

/** Full-byte recognition; a copied marker or a partial migration is not trusted.
 *
 * 探针里的模型路径边界有两种合法形态：`repo`（旧）与 `hub`（修正版）。
 * 识别身份时先把两者归一，再比哈希——否则改一次探针，
 * 所有已升级的工程都会被判成未知模板。 */
export function voiceTemplateKind(source) {
  if (sha(source) === KNOWN_VOICE_SHA256) return 'original';
  const lazyOriginal = source.replace(newProbe, oldProbe).replace(lazyLoad, oldLoad);
  if (source.includes(newProbe) && source.includes(lazyLoad) && sha(lazyOriginal) === KNOWN_VOICE_SHA256) return 'lazy-v1';
  /* 归一方向是 repo → hub：`edits` 里的 `to` 现在嵌入的是修正后的探针（hub），
   * 而老工程里嵌的仍是 repo。先把源归到 hub 形态，才能和 `to` 对上。 */
  const canonical = source.split(OLD_MODEL_BOUNDARY).length === 2
    ? source.replace(OLD_MODEL_BOUNDARY, NEW_MODEL_BOUNDARY) : source;
  let original = canonical;
  for (const [from, to] of [...edits].reverse()) {
    if (original.split(to).length !== 2) return 'unknown';
    original = original.replace(to, from);
  }
  return sha(original) === KNOWN_VOICE_SHA256 ? 'cache-v2' : 'unknown';
}

function plainDirectory(directory) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory);
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink())
    throw new Error('配音备份目录必须是普通目录，未升级');
}

export function upgradeVoice(project) {
  const file = path.join(project, 'voice-kokoro.py');
  let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { changed: false, reason: 'missing' }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('voice-kokoro.py 必须是普通文件，未升级');
  const before = fs.readFileSync(file, 'utf8');
  const kind = voiceTemplateKind(before);
  if (kind === 'cache-v2')
    return { changed: false, reason: 'already-upgraded' };
  if (kind === 'unknown') return { changed: false, reason: 'unknown-template' };
  const original = kind === 'lazy-v1' ? before.replace(newProbe, oldProbe).replace(lazyLoad, oldLoad) : before;
  const next = edits.reduce((source, [from, to]) => replaceExact(source, from, to), original);
  const backupDir = path.join(project, 'out/.vh-voice-backups');
  plainDirectory(path.join(project, 'out'));
  plainDirectory(backupDir);
  const backup = path.join(backupDir, `${Date.now()}-${randomUUID()}.py`);
  fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
  // O_NOFOLLOW protects a last-moment link swap too; use the same descriptor
  // for the final byte/inode comparison and the write, not a second path open.
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    if (current.ino !== stat.ino || current.dev !== stat.dev || fs.readFileSync(fd, 'utf8') !== before)
      throw new Error('配音脚本在升级期间改变，未覆盖');
    const bytes = Buffer.from(next);
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, written);
    fs.ftruncateSync(fd, bytes.length);
  } finally { fs.closeSync(fd); }
  return { changed: true, backup, cacheIdentityChanged: true, from: kind, to: 'cache-v2' };
}

/** 只修嵌入在项目脚本里的身份探针边界（repo → hub）。
 * 不碰合成逻辑、不动缓存键、不改 measurement 字段。
 * 返回 changed/reason，调用方据此决定要不要提示"需重测"。 */
export function repairVoiceIdentityProbe(project) {
  const file = path.join(project, 'voice-kokoro.py');
  let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { changed: false, reason: 'missing' }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('voice-kokoro.py 必须是普通文件，未修复');
  const before = fs.readFileSync(file, 'utf8');
  if (voiceTemplateKind(before) !== 'cache-v2') return { changed: false, reason: 'unknown-template' };
  // 已经在新边界上：无需再改。
  if (!before.includes(OLD_MODEL_BOUNDARY)) return { changed: false, reason: 'already-fixed' };
  if (before.split(OLD_MODEL_BOUNDARY).length !== 2) return { changed: false, reason: 'ambiguous-anchor' };
  const next = before.replace(OLD_MODEL_BOUNDARY, NEW_MODEL_BOUNDARY);
  const backupDir = path.join(project, 'out/.vh-voice-backups');
  plainDirectory(path.join(project, 'out'));
  plainDirectory(backupDir);
  const backup = path.join(backupDir, `${Date.now()}-${randomUUID()}.py`);
  fs.writeFileSync(backup, before, { flag: 'wx', mode: 0o600 });
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
  try {
    const current = fs.fstatSync(fd);
    if (current.ino !== stat.ino || current.dev !== stat.dev || fs.readFileSync(fd, 'utf8') !== before)
      throw new Error('配音脚本在修复期间改变，未覆盖');
    const bytes = Buffer.from(next);
    let written = 0;
    while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written, written);
    fs.ftruncateSync(fd, bytes.length);
  } finally { fs.closeSync(fd); }
  return { changed: true, backup, from: 'repo-boundary', to: 'hub-boundary' };
}

/** Read-only trusted probe. Defaults to the CLI's python3 and known bootstrap.
 * No project imports, model loading, network calls, or filesystem writes.
 */
export function voiceCacheIdentity(project, { voice = 'zf_001', python, env = process.env } = {}) {
  const interpreter = python || 'python3';
  const selection = python ? 'explicit' : 'path-python3';
  const runtime = {
    requestedPython: interpreter,
    selection,
    isolated: false,
    bytecodeDisabled: true,
    synthesisRuntimeVerified: false,
    note: '默认在项目 cwd 启动 PATH 的 python3，保留 PYTHONPATH/site；不导入 kokoro，按已知模板 find_spec/_VIDEO_TTS_REEXEC 规则决定是否切换 VIDEO_TTS_HOME/venv/bin/python。-B 只禁止字节码写入，不隔离包解析。显式 python 替换启动解释器，env 须与实际 TTS 一致；认证针对当前已知模板与本次环境，不涵盖之后的环境改动或任意自定义导入钩子。',
  };
  const unavailable = (reason, extra = {}) => ({ ok: false, reason, runtime, ...extra });
  try {
    const file = path.join(project, 'voice-kokoro.py');
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) return unavailable('unsafe-script');
    if (voiceTemplateKind(fs.readFileSync(file, 'utf8')) !== 'cache-v2') return unavailable('unversioned-template');
    const run = spawnSync(interpreter, ['-B', VOICE_CACHE_PROBE, selection, path.resolve(project), path.resolve(file), voice],
      { cwd: path.resolve(project), encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' } });
    if (run.error) return unavailable('identity-unavailable', { failure: run.error.code || 'probe-start-failed' });
    if (run.status !== 0) {
      let detail; try { detail = JSON.parse(run.stdout).error; } catch {}
      return unavailable('identity-unavailable', { failure: 'probe-failed', ...(typeof detail === 'string' ? { detail } : {}) });
    }
    const identity = JSON.parse(run.stdout);
    if (identity.version !== 2 || !/^[a-f0-9]{64}$/.test(identity.signature) || identity.probeRuntime?.synthesisRuntimeVerified !== true)
      return unavailable('identity-unavailable');
    return { ok: true, ...identity, runtime: { ...runtime, ...identity.probeRuntime } };
  } catch { return unavailable('identity-unavailable'); }
}

/** Additional guard, not a replacement for the existing text/groups/voice/speed
 * timing validator. Missing legacy identities must cause remeasurement.
 */
export function voiceCacheTimingStatus(project, timing, options = {}) {
  const identity = voiceCacheIdentity(project, { voice: timing?.measurement?.voice, ...options });
  if (!identity.ok) return identity;
  if (timing?.measurement?.ttsIdentity !== identity.signature) return { ok: false, reason: 'tts-inputs-changed', signature: identity.signature, runtime: identity.runtime };
  return { ok: true, signature: identity.signature, runtime: identity.runtime };
}

/** Read-only compatibility gate, additional to text/groups/voice/speed checks.
 * required:false/ok:true is legacy compatibility, NEVER identity certification.
 * An identity property (even malformed/null) cannot be removed implicitly by
 * changing/removing the script or replacing it with unknown/custom code.
 */
export function voiceTimingCompatibility(project, timing, options = {}) {
  const hasIdentity = timing?.measurement != null && Object.hasOwn(timing.measurement, 'ttsIdentity');
  let template = 'missing';
  try {
    const file = path.join(project, 'voice-kokoro.py');
    const stat = fs.lstatSync(file);
    template = stat.isFile() && !stat.isSymbolicLink() ? voiceTemplateKind(fs.readFileSync(file, 'utf8')) : 'unsafe';
  } catch (error) {
    if (error.code !== 'ENOENT') template = 'unreadable';
  }
  if (template === 'cache-v2' || hasIdentity) {
    const status = voiceCacheTimingStatus(project, timing, options);
    return { ...status, required: true, verified: status.ok, template,
      note: status.ok ? '按已知模板的实际解释器选择及包解析规则核验，当前 TTS 身份匹配；认证边界见 runtime。'
        : '无法认证当前 TTS 身份，不复用旧 timing；已知标准模板须安全升级并重新测量，自定义脚本须恢复可核验来源后重新测量。' };
  }
  if (template === 'original' || template === 'lazy-v1') return {
    required: true, ok: false, verified: false, template, reason: 'upgrade-and-remeasure-required',
    note: '已知标准模板缺少 TTS 缓存身份，须安全升级并重新测量；不得为旧 timing 补签身份。',
  };
  return { required: false, ok: true, verified: false, template, reason: 'legacy-unverified',
    note: '未识别完整标准模板且没有已登记的 TTS 身份；仅保持旧项目兼容，未核验身份，不修改或覆盖脚本。' };
}
