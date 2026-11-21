/* Small, versioned pronunciation probes. Generation is never a listening pass. */
import fs from 'node:fs';
import { selectVoiceScript, ttsCacheDirs } from './voice-script.mjs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseScript } from './state.mjs';
import { voiceParameters } from './voice-defaults.mjs';

export const VOICE_SAMPLE_SCRIPT = fileURLToPath(new URL('../scripts/voice-sample.py', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const textForTTS = text => text.replaceAll('·', '，').replace(/\s+/gu, '');

export function planVoiceSamples(project, { voice, speed, lines, limit = 6 } = {}) {
  ({ voice, speed } = voiceParameters(project, { voice, speed }));
  if (typeof voice !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(voice) || !Number.isFinite(speed) || speed <= 0 || speed > 3)
    throw new Error('音色须为有效标识；speed 必须大于 0 且不超过 3');
  if (!Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('小样数量须为 1–12');
  const script = fs.readFileSync(path.join(project, '脚本.md'), 'utf8');
  const candidates = parseScript(script).flatMap(scene => scene.lines.map(line => ({ scene: scene.n, line: line.n, text: line.t })))
    .map((item, index) => {
      const risks = [...new Set(item.text.match(/https?:\/\/[^\s，。]+|[A-Za-z][A-Za-z0-9_./-]*|\d+(?:\.\d+)?[%％]?/g) || [])];
      return { ...item, index: index + 1, spokenText: textForTTS(item.text), risks };
    });
  if (!candidates.length) throw new Error('脚本没有编号旁白，无法生成配音小样');
  let selected;
  if (lines != null) {
    if (!Array.isArray(lines) || !lines.length || lines.length > 12 || new Set(lines).size !== lines.length ||
      lines.some(n => !Number.isInteger(n) || n < 1 || n > candidates.length)) throw new Error('lines 须为有效、无重复的全片句序号（从 1 起，最多 12 句）');
    selected = lines.map(n => candidates[n - 1]);
  } else {
    selected = [candidates[0]];
    const covered = new Set(selected[0].risks.map(r => r.toLowerCase()));
    const remaining = candidates.slice(1).filter(c => c.spokenText.length <= 220);
    while (selected.length < limit) {
      const score = c => c.risks.filter(r => !covered.has(r.toLowerCase())).length;
      remaining.sort((a, b) => score(b) - score(a) || a.index - b.index);
      if (!remaining.length || score(remaining[0]) === 0) break;
      const next = remaining.shift(); selected.push(next); next.risks.forEach(r => covered.add(r.toLowerCase()));
    }
    selected.sort((a, b) => a.index - b.index);
  }
  if (selected.some(item => item.spokenText.length > 400)) throw new Error('小样单句超过 400 字符，请先拆句；不截断原文');
  const hashFile = name => { try { return sha(fs.readFileSync(path.join(project, name))); } catch { return null; } };
  // Neural voice identifiers belong to Edge, never feed them to Kokoro. This also
  // permits script-only auditions without a generated scene or model download.
  const engine = voice.endsWith('Neural') ? 'edge-tts' : 'kokoro';
  const voiceScript = selectVoiceScript(project).name;
  const inputs = { version: 2, engine, voice, speed, script: sha(script), entts: hashFile('entts.py'),
    voiceScript: voiceScript ? { name: voiceScript, sha256: hashFile(voiceScript) } : null,
    synthesizer: sha(fs.readFileSync(VOICE_SAMPLE_SCRIPT)), items: selected };
  return { ...inputs, signature: sha(JSON.stringify(inputs)), riskyLines: candidates.filter(c => c.risks.length).length,
    scope: '仅生成中英混读/数字等风险句的小样；未试听、未转写，不证明发音正确或听感通过。' };
}

function wavFingerprint(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('小样必须是普通 WAV 文件');
  const bytes = fs.readFileSync(file);
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('小样缺失有效 WAV 头或音频数据');
  let format = false, audio = false;
  for (let at = 12; at + 8 <= bytes.length;) {
    const tag = bytes.toString('ascii', at, at + 4), size = bytes.readUInt32LE(at + 4), start = at + 8;
    if (start + size > bytes.length) throw new Error('小样 WAV 数据块不完整');
    if (tag === 'fmt ' && size >= 16) format = [1, 3].includes(bytes.readUInt16LE(start)) && bytes.readUInt16LE(start + 2) > 0 && bytes.readUInt32LE(start + 4) > 0;
    if (tag === 'data' && size > 0) audio = true;
    at = start + size + size % 2;
  }
  if (!format || !audio) throw new Error('小样 WAV 缺少格式或非空音频块');
  return { size: bytes.length, sha256: sha(bytes) };
}

export function voiceSampleStatus(project, plan) {
  const directory = path.join(project, 'out/voice-samples', plan.signature);
  let candidates = [directory];
  try { candidates.push(...fs.readdirSync(path.dirname(directory)).filter(name => new RegExp('^' + plan.signature + '-[a-f0-9]{8}$').test(name)).map(name => path.join(path.dirname(directory), name))); } catch {}
  for (const candidate of candidates) try {
    const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'manifest.json'), 'utf8'));
    if (manifest.signature !== plan.signature || manifest.items.length !== plan.items.length) throw new Error('小样版本不符');
    for (const [i, item] of manifest.items.entries()) {
      if (item.index !== plan.items[i].index || item.text !== plan.items[i].text || item.file !== `line-${item.index}.wav`) throw new Error('小样句子不符');
      const actual = wavFingerprint(path.join(candidate, item.file));
      if (actual.sha256 !== item.sha256 || actual.size !== item.size) throw new Error('小样字节已改变');
    }
    return { ok: true, directory: candidate, manifest, reused: true };
  } catch {}
  return { ok: false, directory, reason: '小样不存在、输入已变或文件指纹不符' };
}

export async function createVoiceSamples(project, plan, { run, measured = false } = {}) {
  const cached = voiceSampleStatus(project, plan);
  if (cached.ok) return cached;
  const out = path.join(project, 'out'); fs.mkdirSync(out, { recursive: true });
  const parent = path.join(out, 'voice-samples'); fs.mkdirSync(parent, { recursive: true });
  const staging = fs.mkdtempSync(path.join(parent, '.sample-'));
  try {
    if (measured) {
      for (const item of plan.items) {
        const cacheDir = ttsCacheDirs(project)[0];
        if (!cacheDir) throw new Error('没有找到配音缓存目录（out/.voice-*）');
        const source = path.join(project, cacheDir, `${String(item.index - 1).padStart(2, '0')}.wav`);
        wavFingerprint(source);
        fs.copyFileSync(source, path.join(staging, `line-${item.index}.wav`));
      }
    } else {
      if (typeof run !== 'function') throw new Error('缺少本地 TTS 执行器');
      const request = path.join(staging, 'request.json');
      fs.writeFileSync(request, JSON.stringify({ project, engine: plan.engine, voice: plan.voice, speed: plan.speed,
        items: plan.items.map(item => ({ text: item.spokenText, file: path.join(staging, `line-${item.index}.wav`) })) }));
      const result = await run('python3', [VOICE_SAMPLE_SCRIPT, '--request', request], { cwd: project });
      if (result?.status !== 0) throw new Error(`${plan.engine} 配音小样生成失败；未登记成功。请检查 TTS 依赖${plan.engine === 'edge-tts' ? '与网络连接' : '与已缓存模型'}，不必安装 ASR。`);
      fs.unlinkSync(request);
    }
    // Reject edits made while synthesis was running; never certify old words as current.
    const current = planVoiceSamples(project, { voice: plan.voice, speed: plan.speed, lines: plan.items.map(item => item.index) });
    if (current.signature !== plan.signature) throw new Error('生成期间脚本或发音工具已改变，未登记旧版小样');
    const manifest = { version: 2, signature: plan.signature, engine: plan.engine, voice: plan.voice, speed: plan.speed,
      origin: measured ? 'measurement-clips' : plan.engine === 'edge-tts' ? 'edge-tts' : 'local-tts', listened: false, scope: plan.scope,
      createdAt: new Date().toISOString(), items: plan.items.map(item => ({ ...item,
        file: `line-${item.index}.wav`, ...wavFingerprint(path.join(staging, `line-${item.index}.wav`)) })) };
    fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    let destination = cached.directory;
    // Do not delete an existing, modified generation. Preserve it for diagnosis.
    if (fs.existsSync(destination)) destination += '-' + randomUUID().slice(0, 8);
    fs.renameSync(staging, destination);
    return { ok: true, directory: destination, manifest, reused: false };
  } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
}
