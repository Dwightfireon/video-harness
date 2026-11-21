/* 字幕导出是确定性文本步骤：不应为补 SRT 启动 TTS、重混 MP4 或执行作者 JS。 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { maskJS } from './js-mask.mjs';

export function subtitleData(html) {
  const code = maskJS(html), match = /\bconst\s+SUBS\s*=\s*\[/.exec(code);
  if (!match) throw new Error('没有可解析的纯数据 SUBS 字幕表，请先 vh build');
  const start = code.indexOf('[', match.index); let depth = 0, end = -1;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '[') depth++;
    if (code[i] === ']' && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) throw new Error('字幕表未闭合');
  const text = html.slice(start, end); let data;
  try { data = JSON.parse(text); } catch {
    const re = /\{\s*s\s*:\s*(\d+(?:\.\d+)?)\s*,\s*e\s*:\s*(\d+(?:\.\d+)?)\s*,\s*t\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\}/g;
    const string = literal => literal[0] === '"' ? JSON.parse(literal) : literal.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|x[\da-fA-F]{2}|['"\\/bfnrt])/g, (_, e) =>
      e[0] === 'u' || e[0] === 'x' ? String.fromCharCode(parseInt(e.slice(1), 16)) : ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' })[e] ?? e);
    data = [...text.matchAll(re)].map(m => ({ s: +m[1], e: +m[2], t: string(m[3]) }));
    if (text.slice(1, -1).replace(re, '').replace(/[\s,]/g, '')) throw new Error('SUBS 必须是 JSON 或纯数据旧版对象，不执行表达式');
  }
  if (!Array.isArray(data) || !data.length) throw new Error('字幕表为空');
  for (const [i, sub] of data.entries()) if (!sub || typeof sub.t !== 'string' || !sub.t.trim() || !Number.isFinite(sub.s) || !Number.isFinite(sub.e) ||
    sub.s < 0 || sub.e <= sub.s || i && sub.s < data[i - 1].e || Math.round(sub.e * 1000) <= Math.round(sub.s * 1000)) throw new Error('字幕文字/区间无效：' + (i + 1));
  return data;
}

export function srtText(subs) {
  const ts = seconds => {
    const ms = Math.round(seconds * 1000);
    return [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':') + ',' + String(ms % 1000).padStart(3, '0');
  };
  return subs.map((s, i) => `${i + 1}\n${ts(s.s)} --> ${ts(s.e)}\n${s.t.replace(/\r\n?/g, '\n')}\n`).join('\n');
}

export function subtitleStatus(project) {
  try {
    const expected = srtText(subtitleData(fs.readFileSync(path.join(project, 'scene.html'), 'utf8')));
    let current = ''; try { current = fs.readFileSync(path.join(project, 'out/subtitles.srt'), 'utf8'); } catch {}
    return { ok: current === expected, expected, reason: current === expected ? '字幕内容与当前时间轴一致' : '字幕缺失或与当前时间轴/文案不符' };
  } catch (error) { return { ok: false, error: error.message, reason: error.message }; }
}

export function exportSubtitles(project) {
  const source = fs.readFileSync(path.join(project, 'scene.html'), 'utf8');
  const text = srtText(subtitleData(source)), file = path.join(project, 'out/subtitles.srt');
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return { changed: false, file };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let backup = null;
  if (fs.existsSync(file)) {
    const dir = path.join(project, 'out/.vh-subtitle-backups'); fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, randomUUID() + '.srt'); fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, text, { flag: 'wx' });
    if (fs.readFileSync(path.join(project, 'scene.html'), 'utf8') !== source) throw new Error('导出期间字幕时间轴改变，未覆盖旧字幕');
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch {} }
  return { changed: true, file, backup };
}
