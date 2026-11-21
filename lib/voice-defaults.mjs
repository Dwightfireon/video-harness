/* New projects snapshot the chosen defaults into their generated voice script.
 * Existing scripts without that snapshot retain the old fallback; reading this
 * module never rewrites projects, measurements or audio caches. */
import fs from 'node:fs';
import path from 'node:path';
import { selectVoiceScript } from './voice-script.mjs';

function validate(value) {
  if (!value || typeof value.voice !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.voice) ||
      !Number.isFinite(value.speed) || value.speed <= 0 || value.speed > 3 ||
      !value.timing || ['tail', 'gap', 'sceneBeat'].some(key => !Number.isFinite(value.timing[key]) || value.timing[key] < 0 || value.timing[key] > 5))
    throw new Error('配音默认配置无效，请检查音色、语速与停顿参数');
  return Object.freeze({ ...value, timing: Object.freeze({ ...value.timing }) });
}

export const DEFAULT_NARRATION = validate(JSON.parse(fs.readFileSync(new URL('../assets/voice-defaults.json', import.meta.url), 'utf8')));
export const LEGACY_NARRATION = validate({ preset: 'legacy', voice: 'zh-CN-XiaoyiNeural', speed: 1,
  timing: { tail: .35, gap: .55, sceneBeat: .35 } });

export function projectVoiceDefaults(project) {
  const script = selectVoiceScript(project);
  if (!script.path) return LEGACY_NARRATION;
  const source = fs.readFileSync(script.path, 'utf8');
  const snapshot = source.match(/^VH_NARRATION_DEFAULTS = (.+)$/m);
  if (!snapshot) return LEGACY_NARRATION;
  return validate(JSON.parse(snapshot[1]));
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

// Explicit CLI > existing measurement > saved measure parameters > project
// snapshot. Central default changes must never silently revoice an old project.
export function voiceParameters(project, { voice, speed } = {}) {
  const defaults = projectVoiceDefaults(project);
  const measured = readJSON(path.join(project, 'timing.json')).measurement || {};
  const saved = readJSON(path.join(project, 'out/.vh-state.json')).measureParams || {};
  return { voice: voice ?? (measured.voice || saved.voice || defaults.voice),
    speed: Number(speed ?? measured.speed ?? saved.speed ?? defaults.speed) };
}
