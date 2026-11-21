/* lib/voice-script.mjs —— 配音脚本与缓存目录的解析（单一真相）
 *
 * 背景：配音引擎换过几轮（离线权重 → 在线 edge-tts）。脚本**文件名**曾被写死在
 * vh.mjs / pipeline-plan / release-review / voice-samples / disk-hygiene 里，
 * 于是换了引擎仍然要叫旧名字，读代码的人会以为还在用旧引擎。
 *
 * 这里只做一件事：按**项目里实际存在、且满足配音契约的脚本**解析出路径，
 * 而不是在调用点硬编码某个文件名。调用方只问 selectVoiceScript(project)，
 * 不关心它叫 voice.py 还是别的。
 *
 * 契约（脚本必须支持）：
 *   python3 <script> --measure --apply --voice <v> --speed <s>   # 实测时长
 *   python3 <script>                                            # 合成与混流
 * 解析不看文件名，看脚本自身是否声明了 `TTS_ENGINE` 常量或 `--measure` 入口。
 */
import fs from 'node:fs';
import path from 'node:path';

/* 历史文件名，仅作为**兼容候选**，不是唯一答案。 */
const LEGACY_NAMES = ['voice-kokoro.py', 'voice.py', 'voice-edge.py', 'tts.py'];

/* 缓存目录前缀：脚本把逐句音频放在 out/.voice-<engine>/ 下。
 * 不再固定某一个名字，任何 out/.voice-* 都算配音缓存。 */
export const TTS_CACHE_PREFIX = 'out/.voice-';

function looksLikeVoiceScript(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  if (text.length > 400_000) return false;
  // 必须能接受 --measure --apply（配音契约），而不是任意 python 脚本。
  return /--measure/.test(text) && /--apply/.test(text) &&
    (/TTS_ENGINE\s*=/.test(text) || /argparse/.test(text) || /sys\.argv/.test(text));
}

function readEngineId(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/^\s*TTS_ENGINE\s*=\s*['"]([\w.-]+)['"]/m);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * 解析项目使用的配音脚本。
 * @returns {{name:string|null, path:string|null, engine:string|null, candidates:string[]}}
 */
export function selectVoiceScript(project) {
  const candidates = [];
  let entries = [];
  try { entries = fs.readdirSync(project, { withFileTypes: true }); }
  catch { return { name: null, path: null, engine: null, candidates }; }

  // 1) 历史名优先（保持既有项目零改动），但必须真的满足契约。
  for (const name of LEGACY_NAMES) {
    const file = path.join(project, name);
    if (fs.existsSync(file) && looksLikeVoiceScript(file)) {
      candidates.push(name);
      return { name, path: file, engine: readEngineId(file), candidates };
    }
  }
  // 2) 其它 .py 里挑满足契约的（按名字稳定排序，避免目录顺序影响结果）。
  const others = entries
    .filter(e => e.isFile() && e.name.endsWith('.py'))
    .map(e => e.name)
    .sort();
  for (const name of others) {
    const file = path.join(project, name);
    if (!looksLikeVoiceScript(file)) continue;
    candidates.push(name);
    return { name, path: file, engine: readEngineId(file), candidates };
  }
  return { name: null, path: null, engine: null, candidates };
}

/** 找不到配音脚本时的统一报错文案（调用方不必各写一份）。 */
export function requireVoiceScript(project) {
  const found = selectVoiceScript(project);
  if (!found.name) throw new Error('项目里没有可用的配音脚本（需支持 --measure --apply）；先用 vh new 或按 skill 脚手架补齐');
  return found;
}

/**
 * 判断项目配音脚本是否支持 `--tts-concurrency`。
 * 只看脚本自己的参数声明，不靠文件名或引擎名猜测：老项目的 Kokoro 脚本
 * 没有这个参数，硬塞会直接 argparse 报错退出。
 */
export function voiceScriptSupportsConcurrency(project, name = null) {
  const file = path.join(project, name || selectVoiceScript(project).name || '');
  if (!file || !fs.existsSync(file)) return false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    return /--tts-concurrency/.test(text) && /tts_concurrency/.test(text);
  } catch { return false; }
}

/**
 * 列出项目里实际存在的配音缓存目录（任意 out/.voice-*）。
 * @returns {string[]} 相对项目根的路径
 */
export function ttsCacheDirs(project) {
  try {
    return fs.readdirSync(path.join(project, 'out'), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('.voice-'))
      .map(e => 'out/' + e.name)
      .sort();
  } catch { return []; }
}
