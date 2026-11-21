/* Standard timing data is read without executing project JS. Unknown custom
 * schemas remain unknown; the production stage may validate them separately. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { subtitleData } from './subtitle-export.mjs';
import { voiceTimingCompatibility } from './voice-upgrade.mjs';

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function timingObservation(project, requested = {}) {
  const file = path.join(project, 'timing.json');
  if (!fs.existsSync(file)) return { state: 'missing', reason: '尚未实测旁白' };
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const groups = read(path.join(project, '脚本.md')).split(/^##\s+(?=S\d+)/m).slice(1)
      .map(b => b.split('\n').filter(l => /^\s*\d+\.\s+/.test(l)).map(l => l.replace(/^\s*\d+\.\s+/, '').trim()));
    const lines = groups.flat();
    if (data.schemaVersion !== 1) return { state: 'unknown', reason: '非标准 schema 1 时间轴，未执行项目自定义校验器' };
    if (!lines.length || data.textHash !== digest(lines) || data.groupsHash !== digest(groups)) throw new Error('时间轴不属于当前脚本文案/分组');
    if (typeof data.measurement?.voice !== 'string' || !data.measurement.voice.trim() || !Number.isFinite(data.measurement.speed) || data.measurement.speed <= 0) throw new Error('测量参数无效');
    if (requested.voice !== undefined && requested.voice !== data.measurement.voice || requested.speed !== undefined && Number(requested.speed) !== data.measurement.speed) throw new Error('请求的音色/语速与实测参数不同');
    if (!Array.isArray(data.scenes) || data.scenes.length !== groups.length || data.subs?.length !== lines.length) throw new Error('时间轴句数/场数不符');
    const subs = subtitleData('const SUBS = ' + JSON.stringify(data.subs) + ';');
    if (subs.some((s, i) => s.t !== lines[i])) throw new Error('字幕与脚本内容不同');
    let index = 0;
    for (const [i, range] of data.scenes.entries()) {
      if (!Array.isArray(range) || range.length !== 2) throw new Error('场景区间无效');
      const [a, b] = range;
      if (![a, b].every(Number.isFinite) || a < 0 || b <= a || i && a < data.scenes[i - 1][1]) throw new Error('场景区间无效');
      for (const _ of groups[i]) { const s = subs[index++]; if (s.s < a - 1e-6 || s.e > b + 1e-6) throw new Error('字幕超出所属场景'); }
    }
    if (!Number.isFinite(data.dur) || data.dur <= 0 || data.dur < data.scenes.at(-1)[1]) throw new Error('总时长无效');
    const voiceIdentity = voiceTimingCompatibility(project, data);
    if (!voiceIdentity.ok) throw new Error('配音缓存身份已失效：' + voiceIdentity.reason + '；先 vh measure 重测，不补签旧时间轴');
    return { state: 'valid', total: data.dur, measurement: data.measurement, voiceIdentity, reason: '标准时间轴与当前脚本匹配（非试听）' };
  } catch (error) { return { state: 'invalid', reason: error.message }; }
}

// Also used at delivery boundaries that support a legacy/custom timeline schema.
export function voiceTimingFromFile(project) {
  try { return voiceTimingCompatibility(project, JSON.parse(read(path.join(project, 'timing.json')) || '{}')); }
  catch { return { ok: false, required: true, reason: '配音时间轴无法读取，不能证明当前合成身份' }; }
}
export function assertVoiceTimingCurrent(project) {
  const status = voiceTimingFromFile(project);
  if (!status.ok) throw new Error('配音缓存身份已失效：' + status.reason + '；先 vh measure 重测，不补签旧时间轴');
  return status;
}
